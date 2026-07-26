import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationReactorDeliveryKind,
  OrchestrationReactorDeliveryReplayPolicy,
  OrchestrationReactorDeliveryStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const OrchestrationReactorDelivery = Schema.Struct({
  deliveryId: Schema.String,
  sourceSequence: NonNegativeInt,
  sourceEventId: EventId,
  threadId: ThreadId,
  reactor: Schema.String,
  deliveryKind: OrchestrationReactorDeliveryKind,
  replayPolicy: OrchestrationReactorDeliveryReplayPolicy,
  sourceBootId: Schema.String,
  payload: Schema.Unknown,
  commandId: Schema.NullOr(CommandId),
  status: OrchestrationReactorDeliveryStatus,
  attempts: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  claimedAt: Schema.NullOr(IsoDateTime),
  deliveredAt: Schema.NullOr(IsoDateTime),
  cancelledAt: Schema.NullOr(IsoDateTime),
  deadLetteredAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationReactorDelivery = typeof OrchestrationReactorDelivery.Type;

export const NewOrchestrationReactorDelivery = OrchestrationReactorDelivery.mapFields(
  Struct.assign({
    status: Schema.optionalKey(OrchestrationReactorDeliveryStatus),
    attempts: Schema.optionalKey(NonNegativeInt),
    lastError: Schema.optionalKey(Schema.NullOr(Schema.String)),
    claimedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    deliveredAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    cancelledAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    deadLetteredAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  }),
);
export type NewOrchestrationReactorDelivery = typeof NewOrchestrationReactorDelivery.Type;

export interface OrchestrationReactorDeliveriesShape {
  readonly insert: (
    delivery: NewOrchestrationReactorDelivery,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    deliveryId: string,
  ) => Effect.Effect<Option.Option<OrchestrationReactorDelivery>, ProjectionRepositoryError>;
  readonly listPendingOrdered: () => Effect.Effect<
    ReadonlyArray<OrchestrationReactorDelivery>,
    ProjectionRepositoryError
  >;
  readonly claimNext: (
    claimedAt: string,
  ) => Effect.Effect<Option.Option<OrchestrationReactorDelivery>, ProjectionRepositoryError>;
  readonly markDelivered: (
    deliveryId: string,
    deliveredAt: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markCancelled: (
    deliveryId: string,
    cancelledAt: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markDeadLetter: (
    deliveryId: string,
    deadLetteredAt: string,
    lastError: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class OrchestrationReactorDeliveries extends Context.Service<
  OrchestrationReactorDeliveries,
  OrchestrationReactorDeliveriesShape
>()("t3/persistence/Services/OrchestrationReactorDeliveries") {}
