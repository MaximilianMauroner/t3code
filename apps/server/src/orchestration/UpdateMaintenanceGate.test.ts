// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import * as UpdateMaintenanceGate from "./UpdateMaintenanceGate.ts";

const turnCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-gate-test"),
  threadId: ThreadId.make("thread-gate-test"),
  message: {
    messageId: MessageId.make("message-gate-test"),
    role: "user",
    text: "test",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const validDeadPid = 999_999;
const validToken = "123e4567-e89b-42d3-a456-426614174000";

interface Fixture {
  readonly stateDir: string;
  readonly gate: UpdateMaintenanceGate.UpdateMaintenanceGateService;
}

function withFixture<A, E, R>(
  use: (fixture: Fixture) => Effect.Effect<A, E, R>,
  setup?: (stateDir: string) => void,
): Effect.Effect<A, E | PlatformError.PlatformError, R> {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-update-gate-test-"));
      const baseDir = NodePath.join(root, "base");
      const stateDir = NodePath.join(baseDir, "userdata");
      NodeFS.mkdirSync(stateDir, { recursive: true });
      setup?.(stateDir);
      const gate = yield* UpdateMaintenanceGate.make.pipe(
        Effect.provide(
          ServerConfig.layerTest(root, baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      );
      return { root, stateDir, gate };
    }),
    use,
    ({ root }) =>
      Effect.sync(() => {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }),
  );
}

function writeOwner(
  stateDir: string,
  owner: { readonly pid: number; readonly token: string },
): string {
  const lockPath = NodePath.join(stateDir, "fork-update.lock");
  NodeFS.mkdirSync(lockPath, { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(lockPath, "pid"), `${String(owner.pid)}\n`, {
    mode: 0o600,
  });
  NodeFS.writeFileSync(NodePath.join(lockPath, "token"), `${owner.token}\n`, {
    mode: 0o600,
  });
  return lockPath;
}

describe("UpdateMaintenanceGate", () => {
  it.effect("holds a bootstrap reservation through its durable commit", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const reservation = yield* fixture.gate.reserveDispatchAllowed(turnCommand);
        const commitEntered = yield* Deferred.make<void>();
        const allowCommit = yield* Deferred.make<void>();
        const commitFiber = yield* reservation
          .withDispatchAllowed(
            turnCommand,
            Deferred.succeed(commitEntered, undefined).pipe(
              Effect.andThen(Deferred.await(allowCommit)),
              Effect.as("committed"),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(commitEntered);

        const updateFiber = yield* fixture.gate.acquire.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(updateFiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(allowCommit, undefined);
        expect(yield* Fiber.join(commitFiber)).toBe("committed");
        yield* Fiber.join(updateFiber);
        yield* fixture.gate.release;
      }),
    ),
  );

  it.effect("rejects bootstrap reservation before side effects when maintenance already won", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.gate.acquire;
        const error = yield* fixture.gate.reserveDispatchAllowed(turnCommand).pipe(Effect.flip);
        expect(error.message).toContain("server update is in progress");
        yield* fixture.gate.release;
      }),
    ),
  );

  it.effect("lets a turn finish its durable section before update acquisition completes", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const acceptance = yield* fixture.gate.ensureDispatchAllowed(turnCommand);
        const entered = yield* Deferred.make<void>();
        const persisted = yield* Deferred.make<void>();
        const turnFiber = yield* fixture.gate
          .withDispatchAllowed(
            turnCommand,
            acceptance,
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(persisted);
              return "committed";
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const updateFiber = yield* fixture.gate.acquire.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(updateFiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(persisted, undefined);
        const turnResult = yield* Fiber.join(turnFiber);
        expect(turnResult).toBe("committed");
        yield* Fiber.join(updateFiber);
        expect(yield* fixture.gate.isHeld).toBe(true);
        yield* fixture.gate.release;
      }),
    ),
  );

  it.effect("rejects immediately when the update wins", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.gate.acquire;
        const error = yield* fixture.gate.ensureDispatchAllowed(turnCommand).pipe(Effect.flip);
        expect(error.message).toContain("server update is in progress");
        yield* fixture.gate.release;
      }),
    ),
  );

  it.effect("gates archive, checkpoint revert, and delete as hot external commands", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.gate.acquire;
        const hotCommands: ReadonlyArray<OrchestrationCommand> = [
          {
            type: "thread.archive",
            commandId: CommandId.make("cmd-hot-archive"),
            threadId: ThreadId.make("thread-hot"),
          },
          {
            type: "thread.checkpoint.revert",
            commandId: CommandId.make("cmd-hot-checkpoint"),
            threadId: ThreadId.make("thread-hot"),
            turnCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            type: "thread.delete",
            commandId: CommandId.make("cmd-hot-delete"),
            threadId: ThreadId.make("thread-hot"),
          },
        ];
        for (const command of hotCommands) {
          const error = yield* fixture.gate.ensureDispatchAllowed(command).pipe(Effect.flip);
          expect(error.message).toContain("server update is in progress");
        }
        yield* fixture.gate.release;
      }),
    ),
  );

  it.effect("rejects an early-accepted queued turn when the update wins the permit", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const acceptance = yield* fixture.gate.ensureDispatchAllowed(turnCommand);
        yield* fixture.gate.acquire;
        const turnFiber = yield* fixture.gate
          .withDispatchAllowed(
            turnCommand,
            acceptance,
            Effect.die("stale queued turn must not run"),
          )
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        expect(turnFiber.pollUnsafe()).toBeUndefined();
        yield* fixture.gate.release;
        const error = yield* Fiber.join(turnFiber);
        expect(error.message).toContain("server update is in progress");
      }),
    ),
  );

  it.effect("releases only the exact PID and token owner", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.gate.acquire;
        const lockPath = NodePath.join(fixture.stateDir, "fork-update.lock");
        const tokenPath = NodePath.join(lockPath, "token");
        NodeFS.writeFileSync(tokenPath, `${validToken}\n`);
        yield* fixture.gate.release;
        expect(NodeFS.readFileSync(tokenPath, "utf8")).toBe(`${validToken}\n`);
        expect(NodeFS.existsSync(lockPath)).toBe(true);
      }),
    ),
  );

  it.effect("removes its exact owner lock on release", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.gate.acquire;
        const lockPath = NodePath.join(fixture.stateDir, "fork-update.lock");
        expect(NodeFS.statSync(lockPath).mode & 0o777).toBe(0o700);
        expect(NodeFS.statSync(NodePath.join(lockPath, "pid")).mode & 0o777).toBe(0o600);
        expect(NodeFS.statSync(NodePath.join(lockPath, "token")).mode & 0o777).toBe(0o600);
        expect(NodeFS.readFileSync(NodePath.join(lockPath, "pid"), "utf8").trim()).toBe(
          String(process.pid),
        );
        expect(NodeFS.readFileSync(NodePath.join(lockPath, "token"), "utf8").trim()).toMatch(
          /^[0-9a-f-]{36}$/i,
        );
        yield* fixture.gate.release;
        expect(NodeFS.existsSync(lockPath)).toBe(false);
      }),
    ),
  );

  it.effect("recovers only a well-formed owner with a conclusively dead PID", () => {
    let lockPath = "";
    return withFixture(
      () =>
        Effect.sync(() => {
          expect(NodeFS.existsSync(lockPath)).toBe(false);
        }),
      (stateDir) => {
        lockPath = writeOwner(stateDir, { pid: validDeadPid, token: validToken });
      },
    );
  });

  it.effect("preserves malformed and verification-protected locks byte-for-byte", () =>
    withFixture(
      (malformed) =>
        Effect.gen(function* () {
          const malformedPath = NodePath.join(malformed.stateDir, "fork-update.lock");
          expect(NodeFS.readFileSync(NodePath.join(malformedPath, "pid"), "utf8")).toBe(
            "malformed\n",
          );
          expect(NodeFS.readFileSync(NodePath.join(malformedPath, "token"), "utf8")).toBe(
            "foreign-token\n",
          );
          yield* withFixture(
            (verification) =>
              Effect.sync(() => {
                const protectedPath = NodePath.join(verification.stateDir, "fork-update.lock");
                expect(NodeFS.readFileSync(NodePath.join(protectedPath, "pid"), "utf8")).toBe(
                  `${String(validDeadPid)}\n`,
                );
                expect(NodeFS.readFileSync(NodePath.join(protectedPath, "token"), "utf8")).toBe(
                  `${validToken}\n`,
                );
              }),
            (stateDir) => {
              writeOwner(stateDir, { pid: validDeadPid, token: validToken });
              NodeFS.writeFileSync(
                NodePath.join(stateDir, "fork-update-verification.json"),
                "verification-bytes",
              );
            },
          );
        }),
      (stateDir) => {
        const malformedPath = NodePath.join(stateDir, "fork-update.lock");
        NodeFS.mkdirSync(malformedPath);
        NodeFS.writeFileSync(NodePath.join(malformedPath, "pid"), "malformed\n");
        NodeFS.writeFileSync(NodePath.join(malformedPath, "token"), "foreign-token\n");
      },
    ),
  );

  it.effect("treats a symlinked lock as held and never follows it", () => {
    let foreignPath = "";
    return withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const held = yield* fixture.gate.isHeld;
          expect(held).toBe(true);
          const error = yield* fixture.gate.acquire.pipe(Effect.flip);
          expect(error.message).toContain("already in progress");
          expect(NodeFS.readFileSync(NodePath.join(foreignPath, "token"), "utf8")).toBe(
            `${validToken}\n`,
          );
        }),
      (stateDir) => {
        foreignPath = NodePath.join(NodePath.dirname(stateDir), "foreign-lock");
        NodeFS.mkdirSync(foreignPath);
        NodeFS.writeFileSync(NodePath.join(foreignPath, "pid"), `${String(validDeadPid)}\n`);
        NodeFS.writeFileSync(NodePath.join(foreignPath, "token"), `${validToken}\n`);
        NodeFS.symlinkSync(foreignPath, NodePath.join(stateDir, "fork-update.lock"));
      },
    );
  });
});
