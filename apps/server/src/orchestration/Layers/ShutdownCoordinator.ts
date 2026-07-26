import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { OrchestrationDeliveryRuntime } from "../Services/OrchestrationDeliveryRuntime.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { OrphanTurnReconciler } from "../Services/OrphanTurnReconciler.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import {
  SHUTDOWN_COORDINATOR_BUDGET_MS,
  ShutdownCoordinator,
  type ShutdownCoordinatorShape,
} from "../Services/ShutdownCoordinator.ts";

export interface ShutdownSequenceActions {
  readonly closeExternalAdmission: Effect.Effect<void, unknown>;
  readonly engineBarrier: Effect.Effect<unknown, unknown>;
  readonly drainDeliveries: Effect.Effect<void, unknown>;
  readonly closeProviderIngress: Effect.Effect<void, unknown>;
  readonly drainProviderIngestion: Effect.Effect<void, unknown>;
  readonly drainRemainingReactors: Effect.Effect<void, unknown>;
  readonly internalEngineBarrier: Effect.Effect<unknown, unknown>;
  readonly interruptActiveTargets: Effect.Effect<void, unknown>;
  readonly sealAndStopEngine: Effect.Effect<void, unknown>;
  readonly closeReactorScope: Effect.Effect<void, unknown>;
}

export const runShutdownSequence = Effect.fn("ShutdownCoordinator.runShutdownSequence")(function* (
  actions: ShutdownSequenceActions,
) {
  yield* actions.closeExternalAdmission;
  yield* actions.engineBarrier;
  yield* actions.drainDeliveries;
  yield* actions.closeProviderIngress;
  yield* actions.drainProviderIngestion;
  yield* actions.interruptActiveTargets;
  yield* actions.internalEngineBarrier;
  yield* actions.drainDeliveries;
  yield* actions.drainRemainingReactors;
  yield* actions.internalEngineBarrier;
  yield* actions.sealAndStopEngine;
  yield* actions.closeReactorScope;
});

export const runShutdownWithBudget = Effect.fn("ShutdownCoordinator.runShutdownWithBudget")(
  function* (input: {
    readonly actions: ShutdownSequenceActions;
    readonly forced: Effect.Effect<void, never>;
    readonly budgetMs?: number;
  }) {
    yield* runShutdownSequence(input.actions).pipe(
      Effect.timeout(`${input.budgetMs ?? SHUTDOWN_COORDINATOR_BUDGET_MS} millis`),
      Effect.catchCause(() => input.forced),
    );
  },
);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const deliveries = yield* OrchestrationDeliveryRuntime;
  const ingestion = yield* ProviderRuntimeIngestionService;
  const reconciler = yield* OrphanTurnReconciler;
  const reactors = yield* OrchestrationReactor;

  const shutdown: ShutdownCoordinatorShape["shutdown"] = Effect.fn("ShutdownCoordinator.shutdown")(
    function* ({ reactorScope, closeExternalAdmission }) {
      const closeReactorScope = Scope.close(reactorScope, Exit.void);
      const forceCloseReactorScope = Effect.sync(() =>
        Scope.closeUnsafe(reactorScope, Exit.void),
      ).pipe(
        Effect.flatMap((finalizers) =>
          finalizers === undefined
            ? Effect.void
            : finalizers.pipe(Effect.forkDetach({ startImmediately: true }), Effect.asVoid),
        ),
      );
      yield* runShutdownWithBudget({
        actions: {
          closeExternalAdmission: closeExternalAdmission.pipe(
            Effect.andThen(engine.closeExternalAdmission),
          ),
          engineBarrier: engine.barrier,
          drainDeliveries: deliveries.drain,
          closeProviderIngress: ingestion.closeProviderIngress ?? Effect.void,
          drainProviderIngestion: ingestion.drain,
          drainRemainingReactors: reactors.quiesceAndDrain,
          internalEngineBarrier: engine.barrier,
          interruptActiveTargets: reconciler.snapshotAndInterrupt("shutdown"),
          sealAndStopEngine: engine.sealAndStop,
          closeReactorScope,
        },
        forced: Effect.logError("orchestration shutdown coordinator exceeded its budget", {
          unresolvedDeliveries: "unknown",
        }).pipe(Effect.andThen(engine.forceStop), Effect.andThen(forceCloseReactorScope)),
      });
    },
  );

  return ShutdownCoordinator.of({ shutdown });
});

export const ShutdownCoordinatorLive = Layer.effect(ShutdownCoordinator, make);
