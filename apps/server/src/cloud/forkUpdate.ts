// @effect-diagnostics nodeBuiltinImport:off
import {
  ServerForkUpdateError,
  ServerForkUpdateStatus,
  type ServerForkUpdateResult,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as UpdateMaintenanceGate from "../orchestration/UpdateMaintenanceGate.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import * as ProcessRunner from "../processRunner.ts";

const UPDATE_TIMEOUT = Duration.minutes(20);
const RESTART_DELAY_MS = 2_000;
const MAX_ERROR_LENGTH = 2_000;
const RELEASE_SENTINEL = ".t3-fork-release-complete";
const EXPECTED_UPSTREAM_REPOSITORY = "pingdotgg/t3code";

const terminalStages = new Set<ServerForkUpdateStatus["stage"]>([
  "idle",
  "succeeded",
  "no-change",
  "failed",
]);
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(ServerForkUpdateStatus));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerForkUpdateStatus));
const ForkUpdateVerification = Schema.Struct({
  previousTarget: Schema.NullOr(Schema.String),
  targetCommit: Schema.String,
  startupDeadlineEpochSeconds: Schema.Number,
});
const encodeVerification = Schema.encodeSync(Schema.fromJsonString(ForkUpdateVerification));
const isForkUpdateError = Schema.is(ServerForkUpdateError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface ForkUpdateConfiguration {
  readonly repositoryPath: string;
  readonly repository: string;
  readonly upstreamRepository: string;
  readonly branch: string;
  readonly forkRemote: string;
  readonly upstreamRemote: string;
  readonly releasesDir: string;
  readonly currentLink: string;
  readonly serviceName: string;
}

export function resolveForkUpdateConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  stateDir: string,
  join: (...parts: ReadonlyArray<string>) => string,
): ForkUpdateConfiguration | null {
  const repositoryPath = env.T3_FORK_UPDATE_REPOSITORY_PATH?.trim();
  const repository = env.T3_FORK_UPDATE_REPOSITORY?.trim();
  if (
    repositoryPath === undefined ||
    repositoryPath === "" ||
    repository === undefined ||
    repository === ""
  ) {
    return null;
  }
  return {
    repositoryPath,
    repository,
    upstreamRepository:
      env.T3_FORK_UPDATE_UPSTREAM_REPOSITORY?.trim() || EXPECTED_UPSTREAM_REPOSITORY,
    branch: env.T3_FORK_UPDATE_BRANCH?.trim() || "main",
    forkRemote: env.T3_FORK_UPDATE_FORK_REMOTE?.trim() || "origin",
    upstreamRemote: env.T3_FORK_UPDATE_UPSTREAM_REMOTE?.trim() || "upstream",
    releasesDir: env.T3_FORK_UPDATE_RELEASES_DIR?.trim() || join(stateDir, "fork-releases"),
    currentLink: env.T3_FORK_UPDATE_CURRENT_LINK?.trim() || join(stateDir, "fork-current"),
    serviceName: env.T3_FORK_UPDATE_SERVICE?.trim() || "t3code.service",
  };
}

const idleStatus = (): ServerForkUpdateStatus => ({
  stage: "idle",
  message: "Ready to fetch the latest fork changes.",
  startedAt: null,
  completedAt: null,
  currentCommit: null,
  targetCommit: null,
  error: null,
});

const truncate = (value: string): string =>
  value.length <= MAX_ERROR_LENGTH ? value : `${value.slice(0, MAX_ERROR_LENGTH - 1)}…`;

const statusError = (reason: string) => new ServerForkUpdateError({ reason: truncate(reason) });

const outputTail = (stdout: string, stderr: string): string => {
  const combined = `${stdout}\n${stderr}`
    .replaceAll(/\p{Cc}/gu, " ")
    .replaceAll(
      /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|npm_[A-Za-z0-9_]+)\b/g,
      "[redacted-token]",
    )
    .replaceAll(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1[redacted]")
    .trim();
  if (combined === "") return "";
  const tail = combined.slice(-1_200);
  return ` Output: ${tail}`;
};

export function normalizeGitHubRepository(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+)$/i.exec(
      trimmed,
    );
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

interface ForkUpdateHost {
  readonly hasActiveTurns: Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly restartService: (serviceName: string) => void;
}

export class ForkUpdate extends Context.Service<
  ForkUpdate,
  {
    readonly configuration: ForkUpdateConfiguration | null;
    readonly getStatus: Effect.Effect<ServerForkUpdateResult, ServerForkUpdateError>;
    readonly start: Effect.Effect<ServerForkUpdateResult, ServerForkUpdateError>;
  }
>()("t3/cloud/forkUpdate") {}

export const make = Effect.fn("cloud.fork_update.make")(function* (options?: {
  readonly configuration?: ForkUpdateConfiguration | null;
  readonly host?: Partial<ForkUpdateHost>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = yield* HostProcessEnvironment;
  const nodeExecutable = yield* HostProcessExecutablePath;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const maintenanceGate = yield* UpdateMaintenanceGate.UpdateMaintenanceGate;
  const configuration =
    options !== undefined && Object.hasOwn(options, "configuration")
      ? (options.configuration ?? null)
      : resolveForkUpdateConfiguration(env, config.stateDir, (...parts) => path.join(...parts));
  const statusPath = path.join(config.stateDir, "fork-update.json");
  const verificationPath = path.join(config.stateDir, "fork-update-verification.json");
  const inFlight = yield* Ref.make(false);

  const host: ForkUpdateHost = {
    hasActiveTurns:
      options?.host?.hasActiveTurns ??
      snapshotQuery
        .getSnapshot()
        .pipe(
          Effect.map((snapshot) =>
            snapshot.threads.some((thread) => thread.session?.activeTurnId != null),
          ),
        ),
    restartService:
      options?.host?.restartService ??
      ((_serviceName) => {
        // The production unit has Restart=always. Asking this process to
        // terminate avoids granting the unprivileged server account systemd
        // control privileges; systemd immediately starts the stable link.
        const child = NodeChildProcess.spawn(
          "/bin/sh",
          [
            "-c",
            'sleep "$1"; kill -TERM "$2"',
            "t3-fork-update",
            String(RESTART_DELAY_MS / 1_000),
            String(process.pid),
          ],
          {
            detached: true,
            stdio: "ignore",
          },
        );
        child.on("error", () => undefined);
        child.unref();
      }),
  };

  const writeStatus = (status: ServerForkUpdateStatus) =>
    writeFileStringAtomically({
      filePath: statusPath,
      contents: `${encodeStatus(status)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => statusError(`Could not persist update status: ${String(cause)}`)),
    );

  const readStatus = fs.exists(statusPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(statusPath).pipe(
            Effect.flatMap((raw) => decodeStatus(raw)),
            Effect.orElseSucceed(idleStatus),
          )
        : Effect.succeed(idleStatus()),
    ),
    Effect.mapError((cause) => statusError(`Could not read update status: ${String(cause)}`)),
    Effect.flatMap((status) =>
      Effect.gen(function* () {
        if (terminalStages.has(status.stage)) {
          return status;
        }
        const runningHere = yield* Ref.get(inFlight);
        const awaitingHealthcheck =
          (status.stage === "restarting" || status.stage === "verifying") &&
          (yield* fs.exists(verificationPath).pipe(Effect.orElseSucceed(() => false)));
        if (runningHere || awaitingHealthcheck) {
          return status;
        }
        const completedAt = yield* nowIso;
        const recovered: ServerForkUpdateStatus = {
          ...status,
          stage: "failed",
          message: "The previous update was interrupted before it completed.",
          completedAt,
          error: "The server stopped while the update was in progress.",
        };
        yield* writeStatus(recovered);
        return recovered;
      }),
    ),
  );

  const run = Effect.fn("cloud.fork_update.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) {
    const result = yield* runner
      .run({
        command,
        args,
        cwd,
        timeout: UPDATE_TIMEOUT,
        maxOutputBytes: 32 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.mapError((cause) => statusError(`Could not run ${command}: ${cause.message}`)));
    if (result.code !== 0) {
      return yield* statusError(
        `${command} failed with exit code ${String(result.code)}.${outputTail(result.stdout, result.stderr)}`,
      );
    }
    return result.stdout.trim();
  });

  const updateStage = (
    previous: ServerForkUpdateStatus,
    stage: ServerForkUpdateStatus["stage"],
    message: string,
    patch: Partial<ServerForkUpdateStatus> = {},
  ) => {
    const next = { ...previous, ...patch, stage, message };
    return writeStatus(next).pipe(Effect.as(next));
  };

  const ensureNoActiveTurns = host.hasActiveTurns.pipe(
    Effect.mapError(() => statusError("Could not determine whether a turn is active.")),
    Effect.flatMap((active) =>
      active
        ? Effect.fail(
            statusError("Finish or interrupt active turns before fetching and deploying updates."),
          )
        : Effect.void,
    ),
  );

  const releaseLock = maintenanceGate.release;
  const acquireLock = maintenanceGate.acquire.pipe(
    Effect.mapError((cause) => statusError(cause.message)),
  );

  const start: ForkUpdate["Service"]["start"] = Effect.gen(function* () {
    if (configuration === null) {
      return yield* statusError("Fork updates are not configured on this environment.");
    }
    if (yield* fs.exists(verificationPath).pipe(Effect.orElseSucceed(() => false))) {
      return yield* statusError("The deployed release is still being verified.");
    }
    const alreadyRunning = yield* Ref.getAndSet(inFlight, true);
    if (alreadyRunning) {
      return yield* statusError("A fork update is already in progress.");
    }
    yield* acquireLock.pipe(Effect.onError(() => Ref.set(inFlight, false)));

    const startedAt = yield* nowIso;
    let status: ServerForkUpdateStatus = {
      ...idleStatus(),
      stage: "checking",
      message: "Checking the configured fork checkout.",
      startedAt,
    };
    yield* writeStatus(status).pipe(
      Effect.onError(() => Effect.all([Ref.set(inFlight, false), releaseLock])),
    );
    let originalCommit: string | null = null;
    let pushed = false;
    let activated = false;
    let nextLink: string | null = null;

    const transaction = Effect.gen(function* () {
      yield* ensureNoActiveTurns;
      const repo = configuration.repositoryPath;
      const dirty = yield* run("git", ["status", "--porcelain"], repo);
      if (dirty !== "") {
        return yield* statusError("The configured fork checkout has uncommitted changes.");
      }
      const branch = yield* run("git", ["branch", "--show-current"], repo);
      if (branch !== configuration.branch) {
        return yield* statusError(
          `The configured fork checkout must be on branch '${configuration.branch}'.`,
        );
      }
      const forkUrl = yield* run("git", ["remote", "get-url", configuration.forkRemote], repo);
      const upstreamUrl = yield* run(
        "git",
        ["remote", "get-url", configuration.upstreamRemote],
        repo,
      );
      if (
        normalizeGitHubRepository(forkUrl) !== configuration.repository.toLowerCase() ||
        normalizeGitHubRepository(upstreamUrl) !== configuration.upstreamRepository.toLowerCase()
      ) {
        return yield* statusError(
          "The configured fork or upstream remote does not match its exact GitHub repository.",
        );
      }
      status = yield* updateStage(status, "fetching", "Reconciling the fork's main branch.");
      yield* run(
        "git",
        [
          "fetch",
          "--prune",
          configuration.forkRemote,
          `refs/heads/${configuration.branch}:refs/remotes/${configuration.forkRemote}/${configuration.branch}`,
        ],
        repo,
      );
      const forkRef = `${configuration.forkRemote}/${configuration.branch}`;
      const localBehindFork = yield* runner
        .run({
          command: "git",
          args: ["merge-base", "--is-ancestor", "HEAD", forkRef],
          cwd: repo,
          timeout: Duration.seconds(30),
        })
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not compare fork commits: ${cause.message}`),
          ),
        );
      if (localBehindFork.code === 0) {
        yield* run("git", ["merge", "--ff-only", forkRef], repo);
      } else if (localBehindFork.code === 1) {
        const forkBehindLocal = yield* runner
          .run({
            command: "git",
            args: ["merge-base", "--is-ancestor", forkRef, "HEAD"],
            cwd: repo,
            timeout: Duration.seconds(30),
          })
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not compare local and fork commits: ${cause.message}`),
            ),
          );
        if (forkBehindLocal.code !== 0) {
          return yield* statusError(
            "The local main branch and fork main have diverged; reconcile them manually.",
          );
        }
        return yield* statusError(
          "The local main branch is ahead of fork main; publish or remove the local-only commits before updating.",
        );
      } else {
        return yield* statusError("Could not determine the fork main ancestry.");
      }
      originalCommit = yield* run("git", ["rev-parse", "HEAD"], repo);
      const currentExists = yield* fs
        .exists(configuration.currentLink)
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not inspect the deployed release: ${String(cause)}`),
          ),
        );
      const deployedTarget = currentExists
        ? yield* fs
            .readLink(configuration.currentLink)
            .pipe(
              Effect.mapError((cause) =>
                statusError(`Could not read the deployed release: ${String(cause)}`),
              ),
            )
        : null;
      const deployedCommit = deployedTarget === null ? null : path.basename(deployedTarget);

      status = yield* updateStage(status, "fetching", "Fetching the latest upstream changes.", {
        currentCommit: deployedCommit,
      });
      yield* run(
        "git",
        [
          "fetch",
          "--prune",
          configuration.upstreamRemote,
          `refs/heads/${configuration.branch}:refs/remotes/${configuration.upstreamRemote}/${configuration.branch}`,
        ],
        repo,
      );
      const upstreamRef = `${configuration.upstreamRemote}/${configuration.branch}`;
      const ancestry = yield* runner
        .run({
          command: "git",
          args: ["merge-base", "--is-ancestor", upstreamRef, "HEAD"],
          cwd: repo,
          timeout: Duration.seconds(30),
        })
        .pipe(
          Effect.mapError((cause) => statusError(`Could not compare commits: ${cause.message}`)),
        );
      if (ancestry.code !== 0 && ancestry.code !== 1) {
        return yield* statusError("Could not determine whether upstream contains new changes.");
      }
      if (ancestry.code === 1) {
        status = yield* updateStage(status, "merging", "Merging upstream into the fork.");
        yield* run("git", ["merge", "--no-edit", upstreamRef], repo);
      }
      const targetCommit = yield* run("git", ["rev-parse", "HEAD"], repo);
      if (ancestry.code === 0 && deployedCommit === targetCommit) {
        const completedAt = yield* nowIso;
        status = yield* updateStage(
          status,
          "no-change",
          "The deployed release already contains the latest upstream changes.",
          { completedAt, currentCommit: targetCommit, targetCommit },
        );
        return;
      }

      status = yield* updateStage(status, "validating", "Installing and validating dependencies.", {
        targetCommit,
      });
      yield* run("pnpm", ["install", "--frozen-lockfile"], repo);
      yield* run(
        "pnpm",
        [
          "exec",
          "vp",
          "test",
          "run",
          "packages/contracts/src/server.test.ts",
          "apps/server/src/cloud/forkUpdate.test.ts",
          "apps/server/src/cloud/forkHealthcheck.test.ts",
          "apps/server/src/cloud/forkInstaller.test.ts",
          "apps/web/src/components/ForkUpdateAction.test.tsx",
          "apps/web/src/components/settings/ConnectionsSettings.logic.test.ts",
        ],
        repo,
      );
      yield* run(
        "pnpm",
        [
          "exec",
          "vp",
          "run",
          "--filter",
          "@t3tools/contracts",
          "--filter",
          "@t3tools/web",
          "--filter",
          "t3",
          "typecheck",
        ],
        repo,
      );
      status = yield* updateStage(status, "building", "Building the web client and server.");
      yield* run("pnpm", ["exec", "vp", "run", "--filter", "@t3tools/web", "build"], repo);
      yield* run("pnpm", ["exec", "vp", "run", "--filter", "t3", "build"], repo);

      status = yield* updateStage(status, "packaging", "Packaging an immutable server release.");
      yield* fs
        .makeDirectory(configuration.releasesDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) => statusError(`Could not prepare releases: ${String(cause)}`)),
        );
      const releaseDir = path.join(configuration.releasesDir, targetCommit);
      const stagedRelease = path.join(configuration.releasesDir, `.release-${targetCommit}`);
      const packDir = path.join(configuration.releasesDir, `.pack-${targetCommit}`);
      const entryRelative = path.join("node_modules", "t3", "dist", "bin.mjs");
      const entryPath = path.join(releaseDir, entryRelative);
      const sentinelPath = path.join(releaseDir, RELEASE_SENTINEL);
      const existingSentinel = yield* fs.readFileString(sentinelPath).pipe(
        Effect.map((value) => value.trim()),
        Effect.orElseSucceed(() => ""),
      );
      const existingReady =
        existingSentinel === targetCommit &&
        (yield* fs.exists(entryPath).pipe(Effect.orElseSucceed(() => false)));
      if (!existingReady) {
        yield* fs.remove(stagedRelease, { recursive: true, force: true }).pipe(Effect.ignore);
        yield* fs.remove(packDir, { recursive: true, force: true }).pipe(Effect.ignore);
        yield* fs
          .makeDirectory(stagedRelease, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not create staged release: ${String(cause)}`),
            ),
          );
        yield* fs
          .makeDirectory(packDir, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not create pack staging: ${String(cause)}`),
            ),
          );
        yield* run("pnpm", ["--filter", "t3", "pack", "--pack-destination", packDir], repo);
        const packed = yield* fs
          .readDirectory(packDir)
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not inspect release package: ${String(cause)}`),
            ),
          );
        const tarball = packed.find((name) => name.endsWith(".tgz"));
        if (tarball === undefined) {
          return yield* statusError("Packaging did not produce a t3 tarball.");
        }
        yield* fs
          .writeFileString(path.join(stagedRelease, "package.json"), '{ "private": true }\n')
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not initialize staged release: ${String(cause)}`),
            ),
          );
        yield* run(
          "pnpm",
          [
            "--ignore-workspace",
            "--dir",
            stagedRelease,
            "add",
            "--prod",
            path.join(packDir, tarball),
          ],
          repo,
        );
        const stagedEntry = path.join(stagedRelease, entryRelative);
        const preflight = yield* run(nodeExecutable, [stagedEntry, "--version"], repo);
        if (preflight === "") {
          return yield* statusError("The packaged server entry point returned no version.");
        }
        yield* fs
          .writeFileString(path.join(stagedRelease, RELEASE_SENTINEL), `${targetCommit}\n`)
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not complete staged release: ${String(cause)}`),
            ),
          );
        yield* fs
          .remove(releaseDir, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not replace an incomplete release: ${String(cause)}`),
            ),
          );
        yield* fs
          .rename(stagedRelease, releaseDir)
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not publish the staged release: ${String(cause)}`),
            ),
          );
        yield* fs.remove(packDir, { recursive: true, force: true }).pipe(Effect.ignore);
      }

      // Deliberately check immediately before push. A turn can still start in
      // the tiny interval between this check and the push; the second check
      // immediately before link activation prevents disrupting that turn.
      yield* ensureNoActiveTurns;
      status = yield* updateStage(
        status,
        "pushing",
        "Pushing the exact release commit to the fork.",
      );
      yield* run(
        "git",
        ["push", configuration.forkRemote, `HEAD:refs/heads/${configuration.branch}`],
        repo,
      );
      pushed = true;

      status = yield* updateStage(status, "deploying", "Switching to the immutable release.");
      const previousTarget = deployedTarget;
      nextLink = `${configuration.currentLink}.next-${targetCommit}`;
      yield* fs.remove(nextLink, { force: true }).pipe(Effect.ignore);
      yield* fs
        .symlink(releaseDir, nextLink)
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not create release link: ${String(cause)}`),
          ),
        );
      const currentTimeMillis = yield* Clock.currentTimeMillis;
      yield* writeFileStringAtomically({
        filePath: verificationPath,
        contents: `${encodeVerification({
          previousTarget,
          targetCommit,
          startupDeadlineEpochSeconds: Math.floor(currentTimeMillis / 1_000) + 120,
        })}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) =>
          statusError(`Could not prepare release verification: ${String(cause)}`),
        ),
      );
      yield* ensureNoActiveTurns;
      yield* fs
        .rename(nextLink, configuration.currentLink)
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not switch release link: ${String(cause)}`),
          ),
        );
      activated = true;
      status = yield* updateStage(
        status,
        "restarting",
        "Release installed. The server is restarting and will verify the new release.",
      );
      host.restartService(configuration.serviceName);
    });

    const persistTerminalFailure = (cause: Cause.Cause<ServerForkUpdateError>) =>
      Effect.gen(function* () {
        if (originalCommit !== null && !pushed) {
          yield* runner
            .run({
              command: "git",
              args: ["merge", "--abort"],
              cwd: configuration.repositoryPath,
              timeout: Duration.seconds(30),
            })
            .pipe(Effect.ignore);
          yield* runner
            .run({
              command: "git",
              args: ["reset", "--hard", originalCommit],
              cwd: configuration.repositoryPath,
              timeout: Duration.seconds(30),
            })
            .pipe(Effect.ignore);
        }
        if (!activated) {
          yield* fs.remove(verificationPath, { force: true }).pipe(Effect.ignore);
          if (nextLink !== null) {
            yield* fs.remove(nextLink, { force: true }).pipe(Effect.ignore);
          }
        }
        const failure = Cause.findErrorOption(cause);
        const reason =
          Option.isSome(failure) && isForkUpdateError(failure.value)
            ? failure.value.reason
            : truncate(Cause.pretty(cause));
        const completedAt = yield* nowIso;
        status = {
          ...status,
          stage: "failed",
          message: "The fork update failed; the current running release was kept.",
          completedAt,
          error: reason,
        };
        yield* writeStatus(status);
      });

    yield* transaction.pipe(
      Effect.interruptible,
      Effect.catchCause(persistTerminalFailure),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Ref.set(inFlight, false);
          if (!activated) yield* releaseLock;
        }),
      ),
      Effect.forkDetach({ startImmediately: true }),
    );
    return { status };
  }).pipe(Effect.uninterruptible);

  return ForkUpdate.of({
    configuration,
    getStatus: readStatus.pipe(Effect.map((status) => ({ status }))),
    start,
  });
});

export const layer = Layer.effect(ForkUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(UpdateMaintenanceGate.layer),
);
