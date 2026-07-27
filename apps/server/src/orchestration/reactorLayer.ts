import * as Layer from "effect/Layer";

import { AgentAwarenessRelay } from "../relay/AgentAwarenessRelay.ts";
import { OrchestrationDeliveryRuntime } from "./Services/OrchestrationDeliveryRuntime.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "./Services/OrchestrationReactor.ts";
import { OrphanTurnReconciler } from "./Services/OrphanTurnReconciler.ts";
import { ProviderCommandReactor } from "./Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "./Services/ProviderRuntimeIngestion.ts";
import { CheckpointReactor } from "./Services/CheckpointReactor.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import { withShutdownCoordinator } from "./Layers/ShutdownCoordinator.ts";

type ReactorLeafServices =
  | AgentAwarenessRelay
  | CheckpointReactor
  | OrphanTurnReconciler
  | ProviderCommandReactor
  | ProviderRuntimeIngestionService
  | ThreadDeletionReactor;

type DeliveryDependencies = CheckpointReactor | ProviderCommandReactor | ThreadDeletionReactor;

export const composeReactorLayer = <A, LE, LR, CE, CR, DE, DR>(
  leafServices: Layer.Layer<A | ReactorLeafServices, LE, LR>,
  coordination: Layer.Layer<OrchestrationReactor, CE, CR | ReactorLeafServices>,
  deliveryRuntime: Layer.Layer<OrchestrationDeliveryRuntime, DE, DR | DeliveryDependencies>,
) =>
  withShutdownCoordinator(
    deliveryRuntime.pipe(
      Layer.provideMerge(coordination.pipe(Layer.provideMerge(leafServices))),
      Layer.provideMerge(Layer.effect(OrchestrationEngineService, OrchestrationEngineService)),
    ),
  );
