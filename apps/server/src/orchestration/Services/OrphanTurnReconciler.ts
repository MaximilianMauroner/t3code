import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface OrphanTurnReconcilerShape {
  /** One non-overlapping sweep using barrier-confirmed provider evidence. */
  readonly sweep: (reason?: "server-restarted" | "provider-state-mismatch") => Effect.Effect<void>;
  /** Startup sweep; includes archived, snoozed, and deleted projected rows. */
  readonly reconcileStartup: Effect.Effect<void>;
  /** Snapshot exact CAS targets and interrupt without killing provider processes. */
  readonly snapshotAndInterrupt: (reason: "shutdown") => Effect.Effect<void>;
  /** Starts the 30-second, completion-spaced background sweep. */
  readonly startPeriodic: () => Effect.Effect<void, never, Scope.Scope>;
}

export class OrphanTurnReconciler extends Context.Service<
  OrphanTurnReconciler,
  OrphanTurnReconcilerShape
>()("t3/orchestration/Services/OrphanTurnReconciler") {}
