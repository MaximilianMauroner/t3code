import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationReactorDeliveriesLive } from "../persistence/Layers/OrchestrationReactorDeliveries.ts";
import { OrchestrationEngineCoreLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as UpdateMaintenanceGate from "./UpdateMaintenanceGate.ts";
import { ServerBootIdentity } from "../serverBootId.ts";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  OrchestrationReactorDeliveriesLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  UpdateMaintenanceGate.layer,
  ServerBootIdentity.layer,
  OrchestrationEngineCoreLive.pipe(
    Layer.provide(OrchestrationInfrastructureLayerLive),
    Layer.provide(UpdateMaintenanceGate.layer),
    Layer.provide(ServerBootIdentity.layer),
  ),
);
