import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationReactorDeliveryKind,
  OrchestrationReactorDeliveryReplayPolicy,
  OrchestrationReactorDeliveryStatus,
  ThreadId,
  TrimmedNonEmptyString,
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
  lastFailedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  claimToken: Schema.NullOr(TrimmedNonEmptyString),
  claimedAt: Schema.NullOr(IsoDateTime),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
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
    lastFailedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    claimToken: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
    claimedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    leaseExpiresAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    deliveredAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    cancelledAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
    deadLetteredAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  }),
);
export type NewOrchestrationReactorDelivery = typeof NewOrchestrationReactorDelivery.Type;

export interface OrchestrationReactorDeliveryClaimInput {
  readonly claimToken: string;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  readonly reactor?: string | undefined;
}

export type OrchestrationReactorDeliveryBlockerKind =
  | "pending"
  | "delivering"
  | "stale-delivering"
  | "dead-letter";

export interface OrchestrationReactorDeliveryBlocker {
  readonly kind: OrchestrationReactorDeliveryBlockerKind;
  readonly delivery: OrchestrationReactorDelivery;
}

export interface OrchestrationReactorDeliveryBlockerCounts {
  readonly total: number;
  readonly pending: number;
  readonly delivering: number;
  readonly staleDelivering: number;
  readonly deadLetter: number;
}

export interface OrchestrationReactorDeliveryReadiness {
  readonly blockers: ReadonlyArray<OrchestrationReactorDeliveryBlocker>;
  readonly counts: OrchestrationReactorDeliveryBlockerCounts;
  readonly oldest: Option.Option<OrchestrationReactorDeliveryBlocker>;
}

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
  readonly listUnresolvedOrdered: () => Effect.Effect<
    ReadonlyArray<OrchestrationReactorDelivery>,
    ProjectionRepositoryError
  >;
  readonly inspectReadiness: (
    observedAt: string,
  ) => Effect.Effect<OrchestrationReactorDeliveryReadiness, ProjectionRepositoryError>;
  readonly claimNext: (
    input: OrchestrationReactorDeliveryClaimInput,
  ) => Effect.Effect<Option.Option<OrchestrationReactorDelivery>, ProjectionRepositoryError>;
  readonly markDelivered: (
    deliveryId: string,
    expectedClaimToken: string,
    deliveredAt: string,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markCancelled: (
    deliveryId: string,
    cancelledAt: string,
    expectedClaimToken?: string | undefined,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly recordFailure: (
    deliveryId: string,
    expectedClaimToken: string,
    failedAt: string,
    lastError: string,
    maxAttempts: number,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class OrchestrationReactorDeliveries extends Context.Service<
  OrchestrationReactorDeliveries,
  OrchestrationReactorDeliveriesShape
>()("t3/persistence/Services/OrchestrationReactorDeliveries") {}
