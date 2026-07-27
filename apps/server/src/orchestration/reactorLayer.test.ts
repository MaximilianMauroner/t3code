import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentAwarenessRelay } from "../relay/AgentAwarenessRelay.ts";
import { composeReactorLayer } from "./reactorLayer.ts";
import { CheckpointReactor } from "./Services/CheckpointReactor.ts";
import { OrchestrationDeliveryRuntime } from "./Services/OrchestrationDeliveryRuntime.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "./Services/OrchestrationReactor.ts";
import { OrphanTurnReconciler } from "./Services/OrphanTurnReconciler.ts";
import { ProviderCommandReactor } from "./Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "./Services/ProviderRuntimeIngestion.ts";
import { ShutdownCoordinator } from "./Services/ShutdownCoordinator.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";

it.effect("builds the complete production reactor dependency topology", () =>
  Effect.gen(function* () {
    const leafServices = Layer.mergeAll(
      Layer.mock(AgentAwarenessRelay)({}),
      Layer.mock(CheckpointReactor)({}),
      Layer.mock(OrphanTurnReconciler)({
        snapshotAndInterrupt: () => Effect.void,
      }),
      Layer.mock(ProviderCommandReactor)({}),
      Layer.mock(ProviderRuntimeIngestionService)({
        drain: Effect.void,
        closeProviderIngress: Effect.void,
      }),
      Layer.mock(ThreadDeletionReactor)({}),
    );
    const coordination = Layer.effect(
      OrchestrationReactor,
      Effect.gen(function* () {
        yield* AgentAwarenessRelay;
        yield* CheckpointReactor;
        yield* ProviderCommandReactor;
        yield* ThreadDeletionReactor;
        return OrchestrationReactor.of({
          start: () => Effect.void,
          quiesceAndDrain: Effect.void,
        });
      }),
    );
    const deliveryRuntime = Layer.effect(
      OrchestrationDeliveryRuntime,
      Effect.gen(function* () {
        yield* CheckpointReactor;
        yield* ProviderCommandReactor;
        yield* ThreadDeletionReactor;
        return OrchestrationDeliveryRuntime.of({
          start: () => Effect.void,
          drain: Effect.void,
          recoverStartup: Effect.void,
          inspectReadiness: Effect.die("unused"),
        });
      }),
    );
    const engine = Layer.mock(OrchestrationEngineService)({
      closeExternalAdmission: Effect.void,
      barrier: Effect.succeed({ sequence: 17 }),
      sealAndStop: Effect.void,
      forceStop: Effect.void,
      awaitStopped: Effect.void,
    });
    const layer = composeReactorLayer(leafServices, coordination, deliveryRuntime).pipe(
      Layer.provide(engine),
    );
    const services = yield* Effect.all({
      coordinator: ShutdownCoordinator,
      deliveryRuntime: OrchestrationDeliveryRuntime,
      engine: OrchestrationEngineService,
      providerCommandReactor: ProviderCommandReactor,
    }).pipe(Effect.provide(layer));

    assert.equal(typeof services.coordinator.shutdown, "function");
    assert.ok(services.deliveryRuntime);
    assert.deepStrictEqual(yield* services.engine.barrier, { sequence: 17 });
    assert.ok(services.providerCommandReactor);
  }),
);
