// @effect-diagnostics nodeBuiltinImport:off
import type { OrchestrationCommand } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export interface UpdateDispatchAcceptance {
  readonly generation: number;
}

export interface UpdateLockOwner {
  readonly pid: number;
  readonly token: string;
}

export interface UpdateMaintenanceGateService {
  readonly acquire: Effect.Effect<UpdateLockOwner, UpdateMaintenanceGateError>;
  readonly release: Effect.Effect<void>;
  readonly isHeld: Effect.Effect<boolean>;
  readonly ensureDispatchAllowed: (
    command: OrchestrationCommand,
  ) => Effect.Effect<UpdateDispatchAcceptance, OrchestrationCommandInvariantError>;
  readonly withDispatchAllowed: <A, E, R>(
    command: OrchestrationCommand,
    acceptance: UpdateDispatchAcceptance,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OrchestrationCommandInvariantError, R>;
}

export class UpdateMaintenanceGateError extends Schema.TaggedErrorClass<UpdateMaintenanceGateError>()(
  "UpdateMaintenanceGateError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const isUpdateMaintenanceGateError = Schema.is(UpdateMaintenanceGateError);

const allowAll: UpdateMaintenanceGateService = {
  acquire: Effect.succeed({ pid: process.pid, token: "00000000-0000-4000-8000-000000000000" }),
  release: Effect.void,
  isHeld: Effect.succeed(false),
  ensureDispatchAllowed: () => Effect.succeed({ generation: 0 }),
  withDispatchAllowed: (_command, _acceptance, effect) => effect,
};

export const UpdateMaintenanceGate = Context.Reference<UpdateMaintenanceGateService>(
  "t3/orchestration/UpdateMaintenanceGate",
  { defaultValue: () => allowAll },
);

type ProcessState = "alive" | "dead" | "uncertain";

const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function processState(pid: number): ProcessState {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "uncertain";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (cause) {
    const nodeError: NodeJS.ErrnoException | null = cause instanceof Error ? cause : null;
    if (nodeError?.code === "ESRCH") return "dead";
    return "uncertain";
  }
}

function lstat(path: string): NodeFS.Stats | null {
  try {
    return NodeFS.lstatSync(path);
  } catch (cause) {
    const nodeError: NodeJS.ErrnoException | null = cause instanceof Error ? cause : null;
    if (nodeError?.code === "ENOENT") return null;
    return null;
  }
}

function pathIsPresent(path: string): boolean {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch (cause) {
    const nodeError: NodeJS.ErrnoException | null = cause instanceof Error ? cause : null;
    return nodeError?.code !== "ENOENT";
  }
}

function readOwner(
  lockPath: string,
  ownerPath: string,
  tokenPath: string,
): { readonly pid: number; readonly token: string } | null {
  const lockStat = lstat(lockPath);
  const ownerStat = lstat(ownerPath);
  const tokenStat = lstat(tokenPath);
  if (
    lockStat === null ||
    !lockStat.isDirectory() ||
    lockStat.isSymbolicLink() ||
    (lockStat.mode & 0o777) !== 0o700 ||
    ownerStat === null ||
    !ownerStat.isFile() ||
    ownerStat.isSymbolicLink() ||
    (ownerStat.mode & 0o777) !== 0o600 ||
    tokenStat === null ||
    !tokenStat.isFile() ||
    tokenStat.isSymbolicLink() ||
    (tokenStat.mode & 0o777) !== 0o600
  ) {
    return null;
  }
  let entries: ReadonlyArray<string>;
  let pidText: string;
  let token: string;
  try {
    entries = NodeFS.readdirSync(lockPath).toSorted();
    pidText = NodeFS.readFileSync(ownerPath, "utf8").trim();
    token = NodeFS.readFileSync(tokenPath, "utf8").trim();
  } catch {
    return null;
  }
  if (
    entries.length !== 2 ||
    entries[0] !== "pid" ||
    entries[1] !== "token" ||
    !/^[1-9][0-9]*$/.test(pidText) ||
    !tokenPattern.test(token)
  ) {
    return null;
  }
  const pid = Number.parseInt(pidText, 10);
  return Number.isSafeInteger(pid) ? { pid, token } : null;
}

function removeExactOwner(
  lockPath: string,
  ownerPath: string,
  tokenPath: string,
  expected: { readonly pid: number; readonly token: string },
): boolean {
  const owner = readOwner(lockPath, ownerPath, tokenPath);
  if (owner?.pid !== expected.pid || owner.token !== expected.token) return false;
  try {
    NodeFS.unlinkSync(ownerPath);
    NodeFS.unlinkSync(tokenPath);
    NodeFS.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const semaphore = yield* Semaphore.make(1);
  const generation = yield* Ref.make(0);
  const ownedToken = yield* Ref.make<string | null>(null);
  const lockPath = path.join(config.stateDir, "fork-update.lock");
  const ownerPath = path.join(lockPath, "pid");
  const tokenPath = path.join(lockPath, "token");
  const verificationPath = path.join(config.stateDir, "fork-update-verification.json");

  const verificationExists = () => pathIsPresent(verificationPath);
  const recoverStaleLock = Effect.sync(() => {
    if (verificationExists() || !pathIsPresent(lockPath)) return;
    const owner = readOwner(lockPath, ownerPath, tokenPath);
    if (owner === null || processState(owner.pid) !== "dead") return;
    if (verificationExists()) return;
    removeExactOwner(lockPath, ownerPath, tokenPath, owner);
  });
  yield* recoverStaleLock;

  const isHeld = Effect.sync(() => pathIsPresent(lockPath) || verificationExists());
  const dispatchError = (command: OrchestrationCommand) =>
    new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "A server update is in progress; new turns are temporarily paused.",
    });
  const ensureDispatchAllowed = (command: OrchestrationCommand) =>
    command.type !== "thread.turn.start"
      ? Ref.get(generation).pipe(Effect.map((current) => ({ generation: current })))
      : Effect.gen(function* () {
          if (yield* isHeld) return yield* dispatchError(command);
          return { generation: yield* Ref.get(generation) };
        });
  const withDispatchAllowed: UpdateMaintenanceGateService["withDispatchAllowed"] = (
    command,
    acceptance,
    effect,
  ) =>
    command.type !== "thread.turn.start"
      ? effect
      : semaphore.withPermit(
          Effect.gen(function* () {
            const currentGeneration = yield* Ref.get(generation);
            if (acceptance.generation !== currentGeneration || (yield* isHeld)) {
              return yield* dispatchError(command);
            }
            return yield* effect;
          }),
        );

  const acquire = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* restore(semaphore.take(1));
      const token = NodeCrypto.randomUUID();
      const acquired = yield* Effect.try({
        try: () => {
          if (verificationExists()) {
            throw new UpdateMaintenanceGateError({
              reason: "The deployed release is still being verified.",
            });
          }
          if (pathIsPresent(lockPath)) {
            const owner = readOwner(lockPath, ownerPath, tokenPath);
            if (owner !== null && processState(owner.pid) === "dead") {
              if (verificationExists()) {
                throw new UpdateMaintenanceGateError({
                  reason: "The deployed release is still being verified.",
                });
              }
              removeExactOwner(lockPath, ownerPath, tokenPath, owner);
            }
          }
          try {
            NodeFS.mkdirSync(lockPath, { mode: 0o700 });
          } catch (cause) {
            const nodeError: NodeJS.ErrnoException | null = cause instanceof Error ? cause : null;
            if (nodeError?.code !== "EEXIST") throw cause;
            throw new UpdateMaintenanceGateError({
              reason: "Another fork update is already in progress.",
            });
          }
          try {
            NodeFS.writeFileSync(tokenPath, `${token}\n`, {
              flag: "wx",
              mode: 0o600,
            });
            NodeFS.writeFileSync(ownerPath, `${String(process.pid)}\n`, {
              flag: "wx",
              mode: 0o600,
            });
          } catch (cause) {
            try {
              NodeFS.unlinkSync(ownerPath);
            } catch {}
            try {
              NodeFS.unlinkSync(tokenPath);
            } catch {}
            try {
              NodeFS.rmdirSync(lockPath);
            } catch {}
            throw cause;
          }
          return token;
        },
        catch: (cause) =>
          isUpdateMaintenanceGateError(cause)
            ? cause
            : new UpdateMaintenanceGateError({ reason: "Could not acquire update gate." }),
      }).pipe(Effect.exit);
      if (acquired._tag === "Failure") {
        yield* semaphore.release(1);
        return yield* Effect.failCause(acquired.cause);
      }
      yield* Ref.set(ownedToken, acquired.value);
      yield* Ref.update(generation, (current) => current + 1);
      return { pid: process.pid, token: acquired.value };
    }),
  );
  const release = Effect.gen(function* () {
    const token = yield* Ref.getAndSet(ownedToken, null);
    if (token === null) return;
    yield* Effect.sync(() => {
      removeExactOwner(lockPath, ownerPath, tokenPath, {
        pid: process.pid,
        token,
      });
    });
    yield* semaphore.release(1);
  }).pipe(Effect.uninterruptible, Effect.ignore);

  return {
    acquire,
    release,
    isHeld,
    ensureDispatchAllowed,
    withDispatchAllowed,
  };
});

export const layer = Layer.effect(UpdateMaintenanceGate, make);
