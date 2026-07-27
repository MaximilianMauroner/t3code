// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ForkUpdate from "./forkUpdate.ts";

const unusedSnapshotQuery = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
  getCommandReadModel: () => Effect.die("unused"),
  getSnapshot: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.die("unused"),
  getArchivedShellSnapshot: () => Effect.die("unused"),
  getSnapshotSequence: () => Effect.die("unused"),
  getCounts: () => Effect.die("unused"),
  getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
  getProjectShellById: () => Effect.die("unused"),
  getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
  getThreadCheckpointContext: () => Effect.die("unused"),
  getFullThreadDiffContext: () => Effect.die("unused"),
  getThreadShellById: () => Effect.die("unused"),
  getThreadDetailById: () => Effect.die("unused"),
  getThreadDetailSnapshot: () => Effect.die("unused"),
});

it("only enables fork updates when both host-fixed repository values are present", () => {
  assert.isNull(
    ForkUpdate.resolveForkUpdateConfiguration({}, "/state", (...parts) => parts.join("/")),
  );
  const resolved = ForkUpdate.resolveForkUpdateConfiguration(
    {
      T3_FORK_UPDATE_REPOSITORY_PATH: "/srv/t3code",
      T3_FORK_UPDATE_REPOSITORY: "owner/t3code",
    },
    "/state",
    (...parts) => parts.join("/"),
  );
  assert.deepEqual(resolved, {
    repositoryPath: "/srv/t3code",
    repository: "owner/t3code",
    upstreamRepository: "pingdotgg/t3code",
    branch: "main",
    upstreamBranch: "nightly",
    forkRemote: "origin",
    upstreamRemote: "upstream",
    releasesDir: "/state/fork-releases",
    currentLink: "/state/fork-current",
    serviceName: "t3code.service",
  });
});

it("normalizes only exact GitHub repository remotes", () => {
  assert.equal(
    ForkUpdate.normalizeGitHubRepository("git@github.com:Owner/Repository.git"),
    "owner/repository",
  );
  assert.equal(
    ForkUpdate.normalizeGitHubRepository("https://github.com/Owner/Repository"),
    "owner/repository",
  );
  assert.isNull(ForkUpdate.normalizeGitHubRepository("https://example.com/Owner/Repository.git"));
  assert.isNull(
    ForkUpdate.normalizeGitHubRepository("https://github.com/Owner/Repository/extra.git"),
  );
});

it.layer(NodeServices.layer)("ForkUpdate", (it) => {
  const makeService = Effect.fn("test.makeForkUpdate")(function* (input: {
    readonly active: boolean | (() => boolean);
    readonly commands: Array<string>;
    readonly deployedCommit?: string;
    readonly partialReleaseCommit?: string;
    readonly authorityMode?: "regular" | "symlink";
    readonly interruptWhen?: (command: string, args: ReadonlyArray<string>) => boolean;
    readonly output?: (
      command: string,
      args: ReadonlyArray<string>,
    ) => {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
    };
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-update-test-" });
    const repo = path.join(root, "repo");
    const releasesDir = path.join(root, "releases");
    const currentLink = path.join(root, "current");
    const authorityPath = path.join(root, "watchdog-authority.lock");
    yield* fs.makeDirectory(repo, { recursive: true });
    if (input.authorityMode === "regular") {
      yield* fs.writeFileString(authorityPath, "");
    } else if (input.authorityMode === "symlink") {
      const foreignPath = path.join(root, "foreign-authority");
      yield* fs.writeFileString(foreignPath, "foreign-bytes");
      yield* fs.symlink(foreignPath, authorityPath);
    }
    if (input.deployedCommit !== undefined) {
      const deployed = path.join(releasesDir, input.deployedCommit);
      yield* fs.makeDirectory(deployed, { recursive: true });
      yield* fs.symlink(deployed, currentLink);
    }
    if (input.partialReleaseCommit !== undefined) {
      const partialEntry = path.join(
        releasesDir,
        input.partialReleaseCommit,
        "node_modules",
        "t3",
        "dist",
        "bin.mjs",
      );
      yield* fs.makeDirectory(path.dirname(partialEntry), { recursive: true });
      yield* fs.writeFileString(partialEntry, "export {};\n");
    }
    const runner = ProcessRunner.ProcessRunner.of({
      run: (request) =>
        Effect.gen(function* () {
          input.commands.push([request.command, ...request.args].join(" "));
          if (input.interruptWhen?.(request.command, request.args) === true) {
            return yield* Effect.interrupt;
          }
          const response = input.output?.(request.command, request.args) ?? {};
          if (request.command === "pnpm" && request.args.includes("deploy")) {
            const stagedPackage = request.args.at(-1);
            if (stagedPackage !== undefined) {
              const entry = path.join(stagedPackage, "dist", "bin.mjs");
              yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
              yield* fs.writeFileString(entry, "export {};\n");
            }
          }
          return {
            stdout: response.stdout ?? (request.args.includes("--version") ? "t3 v0.0.28\n" : ""),
            stderr: response.stderr ?? "",
            code: ChildProcessSpawner.ExitCode(response.code ?? 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }).pipe(Effect.orDie),
    });
    let restarts = 0;
    const makeOne = ForkUpdate.make({
      configuration: {
        repositoryPath: repo,
        repository: "owner/t3code",
        upstreamRepository: "upstream/t3code",
        branch: "main",
        upstreamBranch: "nightly",
        forkRemote: "origin",
        upstreamRemote: "upstream",
        releasesDir,
        currentLink,
        serviceName: "t3code.service",
      },
      host: {
        hasActiveTurns: Effect.sync(() =>
          typeof input.active === "function" ? input.active() : input.active,
        ),
        restartService: () => {
          restarts += 1;
        },
      },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(root, path.join(root, "state")),
          Layer.succeed(ProcessRunner.ProcessRunner, runner),
          Layer.succeed(
            HostProcessEnvironment,
            input.authorityMode === undefined
              ? {}
              : { T3_FORK_UPDATE_AUTHORITY_LOCK: authorityPath },
          ),
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, unusedSnapshotQuery),
        ),
      ),
    );
    const service = yield* makeOne;
    return {
      service,
      currentLink,
      releasesDir,
      stateDir: path.join(root, "state", "userdata"),
      remake: () => makeOne,
      restartCount: () => restarts,
      authorityPath,
    };
  });

  const awaitStatus = Effect.fn("test.awaitForkUpdateStatus")(function* (
    service: ForkUpdate.ForkUpdate["Service"],
    stages: ReadonlySet<string>,
  ) {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const result = yield* service.getStatus;
      if (stages.has(result.status.stage)) return result.status;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("fork update did not reach the expected stage");
  });

  const updatingOutput = (ancestryCode: 0 | 1 = 1) => {
    let revisionReads = 0;
    return (command: string, args: ReadonlyArray<string>) => {
      const invocation = [command, ...args].join(" ");
      if (invocation === "git branch --show-current") return { stdout: "main\n" };
      if (invocation === "git remote get-url origin") {
        return { stdout: "https://github.com/owner/t3code.git\n" };
      }
      if (invocation === "git remote get-url upstream") {
        return { stdout: "git@github.com:upstream/t3code.git\n" };
      }
      if (invocation === "git rev-parse HEAD") {
        if (ancestryCode === 0) return { stdout: "new-commit\n" };
        revisionReads += 1;
        return { stdout: revisionReads === 1 ? "old-commit\n" : "new-commit\n" };
      }
      if (
        invocation.includes("merge-base --is-ancestor") &&
        invocation.includes("upstream/nightly")
      ) {
        return { code: ancestryCode };
      }
      if (invocation.includes("merge-base --is-ancestor") && invocation.includes("origin/main")) {
        return { code: 0 };
      }
      return {};
    };
  };

  it.effect("persists active-turn rejection after returning from the RPC", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({ active: true, commands });
      const accepted = yield* context.service.start;
      assert.equal(accepted.status.stage, "checking");
      const failed = yield* awaitStatus(context.service, new Set(["failed"]));
      assert.include(failed.error ?? "", "active turns");
      assert.deepEqual(commands, [
        "git ls-remote --tags --refs --sort=-version:refname upstream refs/tags/v*-nightly.*",
      ]);
      assert.equal(context.restartCount(), 0);
    }),
  );

  it.effect(
    "reports installed and latest released nightly versions without changing checkout",
    () =>
      Effect.gen(function* () {
        const commands: Array<string> = [];
        const installedVersion = "v0.0.29-nightly.20260724.896";
        const latestVersion = "v0.0.29-nightly.20260725.899";
        const context = yield* makeService({
          active: false,
          commands,
          deployedCommit: "installed-commit",
          output: (command, args) => {
            const invocation = [command, ...args].join(" ");
            if (
              invocation === "git describe --tags --match v*-nightly.* --abbrev=0 installed-commit"
            ) {
              return { stdout: `${installedVersion}\n` };
            }
            if (
              invocation ===
              "git ls-remote --tags --refs --sort=-version:refname upstream refs/tags/v*-nightly.*"
            ) {
              return {
                stdout: `latest-commit\trefs/tags/${latestVersion}\nolder\trefs/tags/${installedVersion}\n`,
              };
            }
            return {};
          },
        });

        const result = yield* context.service.getStatus;

        assert.equal(result.installedNightlyVersion, installedVersion);
        assert.equal(result.latestNightlyVersion, latestVersion);
        assert.deepEqual(commands, [
          "git describe --tags --match v*-nightly.* --abbrev=0 installed-commit",
          "git ls-remote --tags --refs --sort=-version:refname upstream refs/tags/v*-nightly.*",
        ]);
      }),
  );

  it.effect("pushes the exact merged commit before switching the release link", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        output: updatingOutput(),
      });
      const accepted = yield* context.service.start;
      assert.equal(accepted.status.stage, "checking");
      const result = yield* awaitStatus(context.service, new Set(["restarting", "failed"]));
      assert.equal(result.stage, "restarting");
      for (let attempt = 0; attempt < 1_000 && context.restartCount() === 0; attempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal(context.restartCount(), 1);
      const pushIndex = commands.findIndex((command) =>
        command.includes("git push origin HEAD:refs/heads/main"),
      );
      const buildIndex = commands.findIndex((command) =>
        command.includes("pnpm exec vp run --filter t3 build"),
      );
      const deployCommand = `pnpm --filter t3 deploy --prod --legacy --offline ${context.releasesDir}/.release-new-commit/node_modules/t3`;
      const deployIndex = commands.indexOf(deployCommand);
      const stagedPreflightIndex = commands.findIndex((command) =>
        command.endsWith(
          ` ${context.releasesDir}/.release-new-commit/node_modules/t3/dist/bin.mjs --version`,
        ),
      );
      const focusedTests = commands.find((command) => command.includes("vp test run")) ?? "";
      assert.isAtLeast(pushIndex, 0);
      assert.isAbove(deployIndex, buildIndex);
      assert.isAbove(stagedPreflightIndex, deployIndex);
      assert.isAbove(pushIndex, stagedPreflightIndex);
      assert.lengthOf(
        commands.filter((command) => command.includes(" deploy ")),
        1,
      );
      assert.isFalse(commands.some((command) => command.includes(" pack ")));
      assert.isFalse(commands.some((command) => command.includes(" add ")));
      assert.include(focusedTests, "apps/web/src/components/ForkUpdateAction.test.tsx");
      assert.include(
        focusedTests,
        "apps/web/src/components/settings/ConnectionsSettings.logic.test.ts",
      );
      assert.equal(
        yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readLink(context.currentLink))),
        context.currentLink.replace("current", "releases/new-commit"),
      );
      const fs = yield* FileSystem.FileSystem;
      const verificationPath = `${context.stateDir}/fork-update-verification.json`;
      const verification = yield* fs.readFileString(verificationPath);
      const token = /"lockOwnerToken":"([^"]+)"/.exec(verification)?.[1] ?? "";
      assert.match(token, /^[0-9a-f-]{36}$/i);
      const verificationInfo = yield* fs.stat(verificationPath);
      assert.equal(verificationInfo.mode & 0o777, 0o600);
      const status = yield* fs.readFileString(`${context.stateDir}/fork-update.json`);
      assert.notInclude(status, token);
    }),
  );

  it.effect("holds and releases the shared watchdog authority for an update", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        authorityMode: "regular",
        output: updatingOutput(),
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["restarting", "failed"]));
      assert.equal(result.stage, "restarting");

      const probe = NodeChildProcess.spawnSync("/usr/bin/flock", [
        "-n",
        context.authorityPath,
        "/bin/true",
      ]);
      assert.equal(probe.status, 0);
    }),
  );

  it.effect("times out and cleans up when the watchdog authority is already held", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        authorityMode: "regular",
      });
      const acquireHolder = Effect.callback<NodeChildProcess.ChildProcessWithoutNullStreams>(
        (resume) => {
          const child = NodeChildProcess.spawn(
            "/usr/bin/flock",
            ["-x", context.authorityPath, "/bin/sh", "-c", 'printf "locked\\n"; cat >/dev/null'],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          let output = "";
          const fail = (cause: unknown) => resume(Effect.die(cause));
          child.once("error", fail);
          child.once("exit", (code) => {
            fail(new Error(`watchdog authority holder exited before acquisition (${code})`));
          });
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            output += chunk;
            if (output.includes("locked\n")) {
              resume(Effect.succeed(child));
            }
          });
          return Effect.sync(() => child.kill("SIGKILL"));
        },
      );
      const releaseHolder = (child: NodeChildProcess.ChildProcessWithoutNullStreams) =>
        Effect.callback<void>((resume) => {
          child.once("exit", () => resume(Effect.void));
          child.stdin.end();
          return Effect.sync(() => child.kill("SIGKILL"));
        });

      const failure = yield* Effect.acquireUseRelease(
        acquireHolder,
        () => context.service.start.pipe(Effect.flip),
        releaseHolder,
      );

      assert.include(failure.reason, "Timed out acquiring watchdog restart authority");
      assert.deepEqual(commands, []);
      const probe = NodeChildProcess.spawnSync("/usr/bin/flock", [
        "-n",
        context.authorityPath,
        "/bin/true",
      ]);
      assert.equal(probe.status, 0);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects a symlinked watchdog authority before update commands", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        authorityMode: "symlink",
      });
      const result = yield* Effect.exit(context.service.start);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(commands, []);
    }),
  );

  it.effect("continues the detached transaction after the request scope ends", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        output: updatingOutput(),
      });
      yield* Effect.scoped(context.service.start);
      const result = yield* awaitStatus(context.service, new Set(["restarting", "failed"]));
      assert.equal(result.stage, "restarting");
      assert.equal(context.restartCount(), 1);
    }),
  );

  it.effect("persists a terminal failure when the detached transaction is interrupted", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        output: updatingOutput(),
        interruptWhen: (command, args) => [command, ...args].join(" ").startsWith("git fetch "),
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["failed"]));
      assert.equal(result.stage, "failed");
      assert.include(result.error ?? "", "interrupted");
    }),
  );

  it.effect("resumes a pushed source commit that is not the deployed commit", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        deployedCommit: "old-deployed",
        output: updatingOutput(0),
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["restarting", "failed"]));
      assert.equal(result.stage, "restarting");
      assert.isTrue(commands.some((command) => command === "pnpm install --frozen-lockfile"));
      assert.isTrue(commands.some((command) => command.includes("git push origin")));
    }),
  );

  it.effect("fast-forwards local main when fork main is ahead before fetching upstream", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        deployedCommit: "old-deployed",
        output: (command, args) => {
          const invocation = [command, ...args].join(" ");
          if (invocation === "git branch --show-current") return { stdout: "main\n" };
          if (invocation === "git remote get-url origin") {
            return { stdout: "https://github.com/owner/t3code.git\n" };
          }
          if (invocation === "git remote get-url upstream") {
            return { stdout: "git@github.com:upstream/t3code.git\n" };
          }
          if (invocation.includes("merge-base --is-ancestor HEAD origin/main")) {
            return { code: 0 };
          }
          if (invocation.includes("merge-base --is-ancestor upstream/nightly HEAD")) {
            return { code: 0 };
          }
          if (invocation === "git rev-parse HEAD") return { stdout: "fork-new\n" };
          return {};
        },
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["restarting", "failed"]));
      assert.equal(result.stage, "restarting");
      const fastForwardIndex = commands.indexOf("git merge --ff-only origin/main");
      const upstreamFetchIndex = commands.findIndex((command) =>
        command.startsWith("git fetch --prune upstream "),
      );
      assert.isAtLeast(fastForwardIndex, 0);
      assert.isAbove(upstreamFetchIndex, fastForwardIndex);
    }),
  );

  it.effect("fails clearly when local main and fork main have diverged", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        output: (command, args) => {
          const invocation = [command, ...args].join(" ");
          if (invocation === "git branch --show-current") return { stdout: "main\n" };
          if (invocation === "git remote get-url origin") {
            return { stdout: "https://github.com/owner/t3code.git\n" };
          }
          if (invocation === "git remote get-url upstream") {
            return { stdout: "git@github.com:upstream/t3code.git\n" };
          }
          if (
            invocation.includes("merge-base --is-ancestor") &&
            invocation.includes("origin/main")
          ) {
            return { code: 1 };
          }
          return {};
        },
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["failed"]));
      assert.include(result.error ?? "", "diverged");
      assert.isFalse(commands.some((command) => command.startsWith("git fetch --prune upstream ")));
    }),
  );

  it.effect("fails clearly when local main is ahead of fork main", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        output: (command, args) => {
          const invocation = [command, ...args].join(" ");
          if (invocation === "git branch --show-current") return { stdout: "main\n" };
          if (invocation === "git remote get-url origin") {
            return { stdout: "https://github.com/owner/t3code.git\n" };
          }
          if (invocation === "git remote get-url upstream") {
            return { stdout: "git@github.com:upstream/t3code.git\n" };
          }
          if (invocation === "git merge-base --is-ancestor HEAD origin/main") return { code: 1 };
          if (invocation === "git merge-base --is-ancestor origin/main HEAD") return { code: 0 };
          return {};
        },
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["failed"]));
      assert.include(result.error ?? "", "ahead of fork main");
      assert.isFalse(commands.some((command) => command.startsWith("git fetch --prune upstream ")));
      assert.isFalse(commands.some((command) => command.startsWith("git push origin ")));
    }),
  );

  it.effect("rejects a new service instance while the deployed release is verifying", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        output: updatingOutput(),
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["restarting", "failed"]));
      assert.equal(result.stage, "restarting");
      const restartedService = yield* context.remake();
      const duplicate = yield* restartedService.start.pipe(Effect.flip);
      assert.include(duplicate.reason, "still being verified");
    }),
  );

  it.effect("does not push when a turn becomes active at the pre-push gate", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      let activeChecks = 0;
      const context = yield* makeService({
        active: () => {
          activeChecks += 1;
          return activeChecks >= 2;
        },
        commands,
        output: updatingOutput(),
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["failed"]));
      assert.include(result.error ?? "", "active turns");
      assert.isFalse(commands.some((command) => command.includes("git push")));
    }),
  );

  it.effect("does not activate when a turn starts in the narrow post-push race", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      let activeChecks = 0;
      const context = yield* makeService({
        active: () => {
          activeChecks += 1;
          return activeChecks >= 3;
        },
        commands,
        deployedCommit: "old-deployed",
        output: updatingOutput(),
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["failed"]));
      assert.include(result.error ?? "", "active turns");
      assert.isTrue(commands.some((command) => command.includes("git push")));
      assert.equal(
        yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readLink(context.currentLink))),
        `${context.releasesDir}/old-deployed`,
      );
    }),
  );

  it.effect("rebuilds a partial release instead of trusting its entry file", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({
        active: false,
        commands,
        partialReleaseCommit: "new-commit",
        output: updatingOutput(),
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["restarting", "failed"]));
      assert.equal(result.stage, "restarting");
      assert.isTrue(
        commands.some(
          (command) =>
            command ===
            `pnpm --filter t3 deploy --prod --legacy --offline ${context.releasesDir}/.release-new-commit/node_modules/t3`,
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      assert.equal(
        (yield* fs.readFileString(
          `${context.releasesDir}/new-commit/.t3-fork-release-complete`,
        )).trim(),
        "new-commit",
      );
    }),
  );

  it.effect("persists a safely bounded command output tail", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const normal = updatingOutput();
      const context = yield* makeService({
        active: false,
        commands,
        output: (command, args) => {
          if ([command, ...args].join(" ").startsWith("git fetch ")) {
            return { code: 1, stderr: `${"x".repeat(2_000)}useful-tail` };
          }
          return normal(command, args);
        },
      });
      yield* context.service.start;
      const result = yield* awaitStatus(context.service, new Set(["failed"]));
      assert.include(result.error ?? "", "useful-tail");
      assert.isAtMost((result.error ?? "").length, 2_000);
    }),
  );
});
