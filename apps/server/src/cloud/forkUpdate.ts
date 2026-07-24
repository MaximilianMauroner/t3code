// @effect-diagnostics nodeBuiltinImport:off
import {
  ServerForkUpdateError,
  ServerForkUpdateStatus,
  type ServerForkUpdateResult,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import * as ProcessRunner from "../processRunner.ts";

const UPDATE_TIMEOUT = Duration.minutes(20);
const RESTART_DELAY_MS = 2_000;
const MAX_ERROR_LENGTH = 2_000;

const terminalStages = new Set<ServerForkUpdateStatus["stage"]>([
  "idle",
  "succeeded",
  "no-change",
  "failed",
]);
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(ServerForkUpdateStatus));
const ForkUpdateVerification = Schema.Struct({
  previousTarget: Schema.NullOr(Schema.String),
  targetCommit: Schema.String,
  notBeforeEpochSeconds: Schema.Number,
  deadlineEpochSeconds: Schema.Number,
});
const encodeVerification = Schema.encodeSync(Schema.fromJsonString(ForkUpdateVerification));
const isForkUpdateError = Schema.is(ServerForkUpdateError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface ForkUpdateConfiguration {
  readonly repositoryPath: string;
  readonly repository: string;
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
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
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
            Effect.flatMap((raw) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(ServerForkUpdateStatus))(raw),
            ),
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
          status.stage === "restarting" &&
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
      return yield* statusError(`${command} failed with exit code ${String(result.code)}.`);
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

  const start: ForkUpdate["Service"]["start"] = Effect.gen(function* () {
    if (configuration === null) {
      return yield* statusError("Fork updates are not configured on this environment.");
    }
    const alreadyRunning = yield* Ref.getAndSet(inFlight, true);
    if (alreadyRunning) {
      return yield* statusError("A fork update is already in progress.");
    }

    const startedAt = yield* nowIso;
    let status: ServerForkUpdateStatus = {
      ...idleStatus(),
      stage: "checking",
      message: "Checking the configured fork checkout.",
      startedAt,
    };
    yield* writeStatus(status).pipe(Effect.onError(() => Ref.set(inFlight, false)));
    let originalCommit: string | null = null;
    let pushed = false;

    return yield* Effect.gen(function* () {
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
      if (!forkUrl.includes(configuration.repository) || forkUrl === upstreamUrl) {
        return yield* statusError("The configured fork and upstream remotes are not safe to use.");
      }
      originalCommit = yield* run("git", ["rev-parse", "HEAD"], repo);
      status = yield* updateStage(status, "fetching", "Fetching the latest upstream changes.", {
        currentCommit: originalCommit,
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
      if (ancestry.code === 0) {
        const completedAt = yield* nowIso;
        status = yield* updateStage(
          status,
          "no-change",
          "The fork already contains the latest upstream changes.",
          { completedAt, targetCommit: originalCommit },
        );
        return { status };
      }
      if (ancestry.code !== 1) {
        return yield* statusError("Could not determine whether upstream contains new changes.");
      }

      status = yield* updateStage(status, "merging", "Merging upstream into the fork.");
      yield* run("git", ["merge", "--no-edit", upstreamRef], repo);
      const targetCommit = yield* run("git", ["rev-parse", "HEAD"], repo);
      status = yield* updateStage(status, "validating", "Validating affected packages.", {
        targetCommit,
      });
      yield* run(
        "pnpm",
        [
          "exec",
          "vp",
          "test",
          "run",
          "packages/contracts/src/server.test.ts",
          "apps/server/src/cloud/forkUpdate.test.ts",
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
      const stagingDir = path.join(configuration.releasesDir, `.staging-${targetCommit}`);
      yield* fs
        .remove(stagingDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not prepare release staging: ${String(cause)}`),
          ),
        );
      yield* fs
        .makeDirectory(stagingDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not create release staging: ${String(cause)}`),
          ),
        );
      yield* run("pnpm", ["--filter", "t3", "pack", "--pack-destination", stagingDir], repo);
      const packed = yield* fs
        .readDirectory(stagingDir)
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not inspect release package: ${String(cause)}`),
          ),
        );
      const tarball = packed.find((name) => name.endsWith(".tgz"));
      if (tarball === undefined) {
        return yield* statusError("Packaging did not produce a t3 tarball.");
      }
      const releaseDir = path.join(configuration.releasesDir, targetCommit);
      const entryPath = path.join(releaseDir, "node_modules", "t3", "dist", "bin.mjs");
      const releaseExists = yield* fs
        .exists(releaseDir)
        .pipe(
          Effect.mapError((cause) => statusError(`Could not inspect releases: ${String(cause)}`)),
        );
      const releaseReady =
        releaseExists &&
        (yield* fs
          .exists(entryPath)
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not inspect the existing release: ${String(cause)}`),
            ),
          ));
      if (!releaseReady) {
        if (releaseExists) {
          yield* fs
            .remove(releaseDir, { recursive: true, force: true })
            .pipe(
              Effect.mapError((cause) =>
                statusError(`Could not clear the incomplete release: ${String(cause)}`),
              ),
            );
        }
        yield* fs
          .makeDirectory(releaseDir, { recursive: true })
          .pipe(
            Effect.mapError((cause) => statusError(`Could not create release: ${String(cause)}`)),
          );
        yield* fs
          .writeFileString(path.join(releaseDir, "package.json"), '{ "private": true }\n')
          .pipe(
            Effect.mapError((cause) =>
              statusError(`Could not initialize release package: ${String(cause)}`),
            ),
          );
        yield* run(
          "pnpm",
          [
            "--ignore-workspace",
            "--dir",
            releaseDir,
            "add",
            "--prod",
            path.join(stagingDir, tarball),
          ],
          repo,
        );
      }
      const entryExists = yield* fs
        .exists(entryPath)
        .pipe(
          Effect.mapError((cause) => statusError(`Could not verify release: ${String(cause)}`)),
        );
      if (!entryExists) {
        return yield* statusError("The packaged release is missing its server entry point.");
      }

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
      yield* ensureNoActiveTurns;

      status = yield* updateStage(status, "deploying", "Switching to the immutable release.");
      yield* fs
        .makeDirectory(configuration.releasesDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) => statusError(`Could not prepare releases: ${String(cause)}`)),
        );
      const nextLink = `${configuration.currentLink}.next-${targetCommit}`;
      const currentExists = yield* fs
        .exists(configuration.currentLink)
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not inspect current release: ${String(cause)}`),
          ),
        );
      const previousTarget = currentExists
        ? yield* fs
            .readLink(configuration.currentLink)
            .pipe(
              Effect.mapError((cause) =>
                statusError(`Could not read the current release link: ${String(cause)}`),
              ),
            )
        : null;
      yield* fs.remove(nextLink, { force: true }).pipe(Effect.ignore);
      yield* fs
        .symlink(releaseDir, nextLink)
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not create release link: ${String(cause)}`),
          ),
        );
      yield* writeFileStringAtomically({
        filePath: verificationPath,
        contents: yield* Clock.currentTimeMillis.pipe(
          Effect.map((currentTimeMillis) =>
            encodeVerification({
              previousTarget,
              targetCommit,
              notBeforeEpochSeconds: Math.floor(currentTimeMillis / 1_000) + 30,
              deadlineEpochSeconds: Math.floor(currentTimeMillis / 1_000) + 120,
            }),
          ),
          Effect.map((encoded) => `${encoded}\n`),
        ),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) =>
          statusError(`Could not prepare release verification: ${String(cause)}`),
        ),
      );
      yield* fs
        .rename(nextLink, configuration.currentLink)
        .pipe(
          Effect.mapError((cause) =>
            statusError(`Could not switch release link: ${String(cause)}`),
          ),
        );
      status = yield* updateStage(
        status,
        "restarting",
        "Release installed. The server is restarting and will verify the new release.",
      );
      host.restartService(configuration.serviceName);
      return { status };
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (configuration !== null && originalCommit !== null && !pushed) {
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
          const reason = isForkUpdateError(error) ? error.reason : truncate(String(error));
          const completedAt = yield* nowIso;
          status = {
            ...status,
            stage: "failed",
            message: "The fork update failed; the current running release was kept.",
            completedAt,
            error: reason,
          };
          yield* writeStatus(status);
          return yield* statusError(reason);
        }),
      ),
      Effect.ensuring(Ref.set(inFlight, false)),
    );
  });

  return ForkUpdate.of({
    configuration,
    getStatus: readStatus.pipe(Effect.map((status) => ({ status }))),
    start,
  });
});

export const layer = Layer.effect(ForkUpdate, make()).pipe(Layer.provide(ProcessRunner.layer));
