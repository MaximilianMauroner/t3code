import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
    branch: "main",
    forkRemote: "origin",
    upstreamRemote: "upstream",
    releasesDir: "/state/fork-releases",
    currentLink: "/state/fork-current",
    serviceName: "t3code.service",
  });
});

it.layer(NodeServices.layer)("ForkUpdate", (it) => {
  const makeService = Effect.fn("test.makeForkUpdate")(function* (input: {
    readonly active: boolean;
    readonly commands: Array<string>;
    readonly output?: (
      command: string,
      args: ReadonlyArray<string>,
    ) => {
      readonly stdout?: string;
      readonly code?: number;
    };
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-update-test-" });
    const repo = path.join(root, "repo");
    const releasesDir = path.join(root, "releases");
    const currentLink = path.join(root, "current");
    yield* fs.makeDirectory(repo, { recursive: true });
    const runner = ProcessRunner.ProcessRunner.of({
      run: (request) =>
        Effect.gen(function* () {
          input.commands.push([request.command, ...request.args].join(" "));
          const response = input.output?.(request.command, request.args) ?? {};
          if (request.command === "pnpm" && request.args.includes("pack")) {
            const destination = request.args.at(-1);
            if (destination !== undefined) {
              yield* fs.makeDirectory(destination, { recursive: true });
              yield* fs.writeFileString(path.join(destination, "t3-test.tgz"), "test");
            }
          }
          if (request.command === "pnpm" && request.args.includes("add")) {
            const dirIndex = request.args.indexOf("--dir");
            const releaseDir = request.args[dirIndex + 1];
            if (releaseDir !== undefined) {
              const entry = path.join(releaseDir, "node_modules", "t3", "dist", "bin.mjs");
              yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
              yield* fs.writeFileString(entry, "export {};\n");
            }
          }
          return {
            stdout: response.stdout ?? "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(response.code ?? 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }).pipe(Effect.orDie),
    });
    let restarts = 0;
    const service = yield* ForkUpdate.make({
      configuration: {
        repositoryPath: repo,
        repository: "owner/t3code",
        branch: "main",
        forkRemote: "origin",
        upstreamRemote: "upstream",
        releasesDir,
        currentLink,
        serviceName: "t3code.service",
      },
      host: {
        hasActiveTurns: Effect.succeed(input.active),
        restartService: () => {
          restarts += 1;
        },
      },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(root, path.join(root, "state")),
          Layer.succeed(ProcessRunner.ProcessRunner, runner),
          Layer.succeed(HostProcessEnvironment, {}),
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, unusedSnapshotQuery),
        ),
      ),
    );
    return { service, currentLink, restartCount: () => restarts };
  });

  it.effect("rejects active turns before invoking git", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const context = yield* makeService({ active: true, commands });
      const error = yield* context.service.start.pipe(Effect.flip);
      assert.include(error.reason, "active turns");
      assert.lengthOf(commands, 0);
      assert.equal(context.restartCount(), 0);
    }),
  );

  it.effect("pushes the exact merged commit before switching the release link", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      let revisionReads = 0;
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
            return { stdout: "https://github.com/upstream/t3code.git\n" };
          }
          if (invocation === "git rev-parse HEAD") {
            revisionReads += 1;
            return { stdout: revisionReads === 1 ? "old-commit\n" : "new-commit\n" };
          }
          if (invocation.includes("merge-base --is-ancestor")) return { code: 1 };
          return {};
        },
      });
      const result = yield* context.service.start;
      assert.equal(result.status.stage, "restarting");
      assert.equal(context.restartCount(), 1);
      const pushIndex = commands.findIndex((command) =>
        command.includes("git push origin HEAD:refs/heads/main"),
      );
      const packageIndex = commands.findIndex((command) =>
        command.includes("pnpm --filter t3 pack"),
      );
      assert.isAtLeast(pushIndex, 0);
      assert.isAbove(pushIndex, packageIndex);
      assert.equal(
        yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readLink(context.currentLink))),
        context.currentLink.replace("current", "releases/new-commit"),
      );
    }),
  );
});
