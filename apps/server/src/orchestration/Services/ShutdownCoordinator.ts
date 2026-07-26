import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export const SHUTDOWN_COORDINATOR_BUDGET_MS = 4_000;
export const MINIMUM_EFFECTIVE_TIMEOUT_STOP_SECONDS = 12;

export function hasSafeEffectiveTimeoutStop(timeoutStopSeconds: number): boolean {
  return timeoutStopSeconds >= MINIMUM_EFFECTIVE_TIMEOUT_STOP_SECONDS;
}

export interface ShutdownCoordinatorShape {
  readonly shutdown: (input: {
    readonly reactorScope: Scope.Scope;
    readonly closeExternalAdmission: Effect.Effect<void>;
  }) => Effect.Effect<void>;
}

export class ShutdownCoordinator extends Context.Service<
  ShutdownCoordinator,
  ShutdownCoordinatorShape
>()("t3/orchestration/Services/ShutdownCoordinator") {}
