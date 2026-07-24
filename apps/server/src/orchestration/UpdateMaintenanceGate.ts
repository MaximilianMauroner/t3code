// @effect-diagnostics nodeBuiltinImport:off
import type { OrchestrationCommand } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export interface UpdateMaintenanceGateService {
  readonly acquire: Effect.Effect<void, UpdateMaintenanceGateError>;
  readonly release: Effect.Effect<void>;
  readonly isHeld: Effect.Effect<boolean>;
  readonly ensureDispatchAllowed: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
}

export class UpdateMaintenanceGateError extends Schema.TaggedErrorClass<UpdateMaintenanceGateError>()(
  "UpdateMaintenanceGateError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const allowAll: UpdateMaintenanceGateService = {
  acquire: Effect.void,
  release: Effect.void,
  isHeld: Effect.succeed(false),
  ensureDispatchAllowed: () => Effect.void,
};

export const UpdateMaintenanceGate = Context.Reference<UpdateMaintenanceGateService>(
  "t3/orchestration/UpdateMaintenanceGate",
  { defaultValue: () => allowAll },
);

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const nodeError: NodeJS.ErrnoException | null = cause instanceof Error ? cause : null;
    return nodeError?.code === "EPERM";
  }
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const lockPath = path.join(config.stateDir, "fork-update.lock");
  const ownerPath = path.join(lockPath, "pid");
  const verificationPath = path.join(config.stateDir, "fork-update-verification.json");

  const recoverStaleLock = Effect.sync(() => {
    if (!NodeFS.existsSync(lockPath) || NodeFS.existsSync(verificationPath)) return;
    let owner = Number.NaN;
    try {
      owner = Number.parseInt(NodeFS.readFileSync(ownerPath, "utf8").trim(), 10);
    } catch {
      owner = Number.NaN;
    }
    if (!processIsAlive(owner)) {
      NodeFS.rmSync(lockPath, { recursive: true, force: true });
    }
  });
  yield* recoverStaleLock;

  const isHeld = Effect.sync(
    () => NodeFS.existsSync(lockPath) || NodeFS.existsSync(verificationPath),
  );
  const acquire = Effect.suspend(() => {
    let acquired = false;
    return Effect.try({
      try: () => {
        if (NodeFS.existsSync(verificationPath)) {
          throw new UpdateMaintenanceGateError({
            reason: "The deployed release is still being verified.",
          });
        }
        try {
          NodeFS.mkdirSync(lockPath);
          acquired = true;
        } catch (cause) {
          const nodeError: NodeJS.ErrnoException | null = cause instanceof Error ? cause : null;
          if (nodeError?.code !== "EEXIST") throw cause;
          throw new UpdateMaintenanceGateError({
            reason: "Another fork update is already in progress.",
          });
        }
        NodeFS.writeFileSync(ownerPath, `${String(process.pid)}\n`, { mode: 0o600 });
      },
      catch: (cause) => {
        if (acquired) NodeFS.rmSync(lockPath, { recursive: true, force: true });
        return cause instanceof UpdateMaintenanceGateError
          ? cause
          : new UpdateMaintenanceGateError({ reason: "Could not acquire update gate." });
      },
    });
  });
  const release = Effect.sync(() => {
    NodeFS.rmSync(lockPath, { recursive: true, force: true });
  }).pipe(Effect.ignore);
  const ensureDispatchAllowed = (command: OrchestrationCommand) =>
    command.type !== "thread.turn.start"
      ? Effect.void
      : isHeld.pipe(
          Effect.flatMap((held) =>
            held
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "A server update is in progress; new turns are temporarily paused.",
                  }),
                )
              : Effect.void,
          ),
        );

  return { acquire, release, isHeld, ensureDispatchAllowed };
});

export const layer = Layer.effect(UpdateMaintenanceGate, make);
