import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  NewOrchestrationReactorDelivery,
  OrchestrationReactorDeliveries,
  OrchestrationReactorDelivery,
  type OrchestrationReactorDeliveriesShape,
  type OrchestrationReactorDeliveryBlocker,
} from "../Services/OrchestrationReactorDeliveries.ts";

const DeliveryDbRow = OrchestrationReactorDelivery.mapFields(
  Struct.assign({ payload: Schema.fromJsonString(Schema.Unknown) }),
);
const NewDeliveryDbRow = NewOrchestrationReactorDelivery.mapFields(
  Struct.assign({ payload: Schema.fromJsonString(Schema.Unknown) }),
);
const DeliveryIdInput = Schema.Struct({ deliveryId: Schema.String });
const UpdatedDelivery = Schema.Struct({ deliveryId: Schema.String });
const ClaimInput = Schema.Struct({
  deliveryId: Schema.String,
  claimToken: TrimmedNonEmptyString,
  currentBootId: TrimmedNonEmptyString,
  claimedAt: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
  reactor: Schema.NullOr(Schema.String),
});
const ClaimedTerminalInput = Schema.Struct({
  deliveryId: Schema.String,
  expectedClaimToken: TrimmedNonEmptyString,
  at: IsoDateTime,
});
const PendingTerminalInput = Schema.Struct({
  deliveryId: Schema.String,
  at: IsoDateTime,
});
const FailureInput = Schema.Struct({
  deliveryId: Schema.String,
  expectedClaimToken: TrimmedNonEmptyString,
  failedAt: IsoDateTime,
  lastError: Schema.String,
  maxAttempts: PositiveInt,
  nextAttemptAt: IsoDateTime,
});
const FailureResult = Schema.Struct({
  status: Schema.Literals(["pending", "dead-letter"]),
});

const selectFields = `
  delivery_id AS "deliveryId", source_sequence AS "sourceSequence",
  source_event_id AS "sourceEventId", thread_id AS "threadId", reactor,
  delivery_kind AS "deliveryKind", replay_policy AS "replayPolicy",
  source_boot_id AS "sourceBootId", payload_json AS "payload",
  command_id AS "commandId", status, attempts, last_error AS "lastError",
  last_failed_at AS "lastFailedAt", created_at AS "createdAt",
  next_attempt_at AS "nextAttemptAt",
  claim_token AS "claimToken", claimed_at AS "claimedAt",
  lease_expires_at AS "leaseExpiresAt", delivered_at AS "deliveredAt",
  cancelled_at AS "cancelledAt", dead_lettered_at AS "deadLetteredAt"
`;
const globalOrder = `
  source_sequence, source_event_id, reactor, delivery_kind, row_id
`;

function mapError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

function blockerKind(
  delivery: OrchestrationReactorDelivery,
  observedAt: string,
): OrchestrationReactorDeliveryBlocker["kind"] {
  switch (delivery.status) {
    case "pending":
    case "dead-letter":
      return delivery.status;
    case "delivering":
      return delivery.leaseExpiresAt === null || delivery.leaseExpiresAt <= observedAt
        ? "stale-delivering"
        : "delivering";
    case "delivered":
    case "cancelled":
      throw new Error(`terminal delivery ${delivery.deliveryId} was listed as unresolved`);
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insertRow = SqlSchema.void({
    Request: NewDeliveryDbRow,
    execute: (row) => sql`
      INSERT INTO orchestration_reactor_deliveries (
        delivery_id, source_sequence, source_event_id, thread_id, reactor,
        delivery_kind, replay_policy, source_boot_id, payload_json, command_id,
        status, attempts, last_error, last_failed_at, next_attempt_at, created_at, claim_token,
        claimed_at, lease_expires_at, delivered_at, cancelled_at, dead_lettered_at
      ) VALUES (
        ${row.deliveryId}, ${row.sourceSequence}, ${row.sourceEventId}, ${row.threadId},
        ${row.reactor}, ${row.deliveryKind}, ${row.replayPolicy}, ${row.sourceBootId},
        ${row.payload}, ${row.commandId}, ${row.status ?? "pending"}, ${row.attempts ?? 0},
        ${row.lastError ?? null}, ${row.lastFailedAt ?? null}, ${row.nextAttemptAt ?? null}, ${row.createdAt},
        ${row.claimToken ?? null}, ${row.claimedAt ?? null}, ${row.leaseExpiresAt ?? null},
        ${row.deliveredAt ?? null}, ${row.cancelledAt ?? null}, ${row.deadLetteredAt ?? null}
      ) ON CONFLICT(delivery_id) DO NOTHING
    `,
  });
  const getRow = SqlSchema.findOneOption({
    Request: DeliveryIdInput,
    Result: DeliveryDbRow,
    execute: ({ deliveryId }) =>
      sql.unsafe(
        `SELECT ${selectFields} FROM orchestration_reactor_deliveries WHERE delivery_id = ? LIMIT 1`,
        [deliveryId],
      ),
  });
  const listPendingRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DeliveryDbRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${selectFields} FROM orchestration_reactor_deliveries WHERE status = 'pending' ORDER BY ${globalOrder}`,
      ),
  });
  const listUnresolvedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DeliveryDbRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${selectFields} FROM orchestration_reactor_deliveries WHERE status IN ('pending', 'delivering', 'dead-letter') ORDER BY ${globalOrder}`,
      ),
  });
  const firstUnresolvedRow = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: DeliveryDbRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${selectFields} FROM orchestration_reactor_deliveries WHERE status IN ('pending', 'delivering', 'dead-letter') ORDER BY ${globalOrder} LIMIT 1`,
      ),
  });
  const claimRow = SqlSchema.findOneOption({
    Request: ClaimInput,
    Result: DeliveryDbRow,
    execute: ({ deliveryId, claimToken, currentBootId, claimedAt, leaseExpiresAt, reactor }) =>
      sql.unsafe(
        `UPDATE orchestration_reactor_deliveries
         SET status = 'delivering', claim_token = ?, claimed_at = ?, lease_expires_at = ?,
             attempts = attempts + 1, next_attempt_at = NULL
         WHERE delivery_id = ?
           AND reactor = COALESCE(?, reactor)
           AND delivery_id = (
             SELECT delivery_id FROM orchestration_reactor_deliveries
             WHERE status IN ('pending', 'delivering', 'dead-letter')
             ORDER BY ${globalOrder} LIMIT 1
           )
           AND (
             (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (status = 'delivering' AND (
               source_boot_id <> ? OR lease_expires_at IS NULL OR lease_expires_at <= ?
             ))
           )
         RETURNING ${selectFields}`,
        [
          claimToken,
          claimedAt,
          leaseExpiresAt,
          deliveryId,
          reactor,
          claimedAt,
          currentBootId,
          claimedAt,
        ],
      ),
  });
  const updateDelivered = SqlSchema.findOneOption({
    Request: ClaimedTerminalInput,
    Result: UpdatedDelivery,
    execute: ({ deliveryId, expectedClaimToken, at }) => sql`
      UPDATE orchestration_reactor_deliveries
      SET status = 'delivered', delivered_at = ${at}, claim_token = NULL,
          claimed_at = NULL, lease_expires_at = NULL
      WHERE delivery_id = ${deliveryId} AND status = 'delivering'
        AND claim_token = ${expectedClaimToken}
      RETURNING delivery_id AS "deliveryId"
    `,
  });
  const updatePendingCancelled = SqlSchema.findOneOption({
    Request: PendingTerminalInput,
    Result: UpdatedDelivery,
    execute: ({ deliveryId, at }) => sql`
      UPDATE orchestration_reactor_deliveries
      SET status = 'cancelled', cancelled_at = ${at}
      WHERE delivery_id = ${deliveryId} AND status = 'pending'
      RETURNING delivery_id AS "deliveryId"
    `,
  });
  const updateClaimedCancelled = SqlSchema.findOneOption({
    Request: ClaimedTerminalInput,
    Result: UpdatedDelivery,
    execute: ({ deliveryId, expectedClaimToken, at }) => sql`
      UPDATE orchestration_reactor_deliveries
      SET status = 'cancelled', cancelled_at = ${at}, claim_token = NULL,
          claimed_at = NULL, lease_expires_at = NULL
      WHERE delivery_id = ${deliveryId} AND status = 'delivering'
        AND claim_token = ${expectedClaimToken}
      RETURNING delivery_id AS "deliveryId"
    `,
  });
  const updateFailure = SqlSchema.findOneOption({
    Request: FailureInput,
    Result: FailureResult,
    execute: ({
      deliveryId,
      expectedClaimToken,
      failedAt,
      lastError,
      maxAttempts,
      nextAttemptAt,
    }) => sql`
      UPDATE orchestration_reactor_deliveries
      SET status = CASE WHEN attempts >= ${maxAttempts} THEN 'dead-letter' ELSE 'pending' END,
          last_error = ${lastError}, last_failed_at = ${failedAt},
          dead_lettered_at = CASE WHEN attempts >= ${maxAttempts} THEN ${failedAt} ELSE NULL END,
          next_attempt_at = CASE WHEN attempts >= ${maxAttempts} THEN NULL ELSE ${nextAttemptAt} END,
          claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL
      WHERE delivery_id = ${deliveryId} AND status = 'delivering'
        AND claim_token = ${expectedClaimToken}
      RETURNING status
    `,
  });

  const insert: OrchestrationReactorDeliveriesShape["insert"] = (delivery) =>
    insertRow(delivery).pipe(Effect.mapError(mapError("OrchestrationReactorDeliveries.insert")));
  const getById: OrchestrationReactorDeliveriesShape["getById"] = (deliveryId) =>
    getRow({ deliveryId }).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.getById")),
    );
  const listPendingOrdered: OrchestrationReactorDeliveriesShape["listPendingOrdered"] = () =>
    listPendingRows(undefined).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.listPendingOrdered")),
    );
  const listUnresolvedOrdered: OrchestrationReactorDeliveriesShape["listUnresolvedOrdered"] = () =>
    listUnresolvedRows(undefined).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.listUnresolvedOrdered")),
    );
  const inspectReadiness: OrchestrationReactorDeliveriesShape["inspectReadiness"] = (observedAt) =>
    listUnresolvedOrdered().pipe(
      Effect.map((deliveries) => {
        const blockers = deliveries.map((delivery) => ({
          kind: blockerKind(delivery, observedAt),
          delivery,
        }));
        return {
          blockers,
          counts: {
            total: blockers.length,
            pending: blockers.filter((blocker) => blocker.kind === "pending").length,
            delivering: blockers.filter((blocker) => blocker.kind === "delivering").length,
            staleDelivering: blockers.filter((blocker) => blocker.kind === "stale-delivering")
              .length,
            deadLetter: blockers.filter((blocker) => blocker.kind === "dead-letter").length,
          },
          oldest: Option.fromUndefinedOr(blockers.at(0)),
        };
      }),
    );
  const claimNext: OrchestrationReactorDeliveriesShape["claimNext"] = (input) =>
    sql
      .withTransaction(
        firstUnresolvedRow(undefined).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (next) => {
                if (input.reactor !== undefined && next.reactor !== input.reactor) {
                  return Effect.succeed(Option.none());
                }
                if (next.status === "dead-letter") return Effect.succeed(Option.none());
                if (
                  next.status === "delivering" &&
                  next.sourceBootId === input.currentBootId &&
                  next.leaseExpiresAt !== null &&
                  next.leaseExpiresAt > input.claimedAt
                ) {
                  return Effect.succeed(
                    next.claimToken === input.claimToken ? Option.some(next) : Option.none(),
                  );
                }
                return claimRow({
                  ...input,
                  deliveryId: next.deliveryId,
                  reactor: input.reactor ?? null,
                });
              },
            }),
          ),
        ),
      )
      .pipe(Effect.mapError(mapError("OrchestrationReactorDeliveries.claimNext")));
  const markDelivered: OrchestrationReactorDeliveriesShape["markDelivered"] = (
    deliveryId,
    expectedClaimToken,
    deliveredAt,
  ) =>
    updateDelivered({ deliveryId, expectedClaimToken, at: deliveredAt }).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(mapError("OrchestrationReactorDeliveries.markDelivered")),
    );
  const markCancelled: OrchestrationReactorDeliveriesShape["markCancelled"] = (
    deliveryId,
    cancelledAt,
    expectedClaimToken,
  ) =>
    (expectedClaimToken === undefined
      ? updatePendingCancelled({ deliveryId, at: cancelledAt })
      : updateClaimedCancelled({ deliveryId, expectedClaimToken, at: cancelledAt })
    ).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(mapError("OrchestrationReactorDeliveries.markCancelled")),
    );
  const recordFailure: OrchestrationReactorDeliveriesShape["recordFailure"] = (
    deliveryId,
    expectedClaimToken,
    failedAt,
    lastError,
    maxAttempts,
    nextAttemptAt,
  ) =>
    updateFailure({
      deliveryId,
      expectedClaimToken,
      failedAt,
      lastError,
      maxAttempts,
      nextAttemptAt: nextAttemptAt ?? failedAt,
    }).pipe(
      Effect.map(Option.map((result) => result.status)),
      Effect.mapError(mapError("OrchestrationReactorDeliveries.recordFailure")),
    );

  return {
    insert,
    getById,
    listPendingOrdered,
    listUnresolvedOrdered,
    inspectReadiness,
    claimNext,
    markDelivered,
    markCancelled,
    recordFailure,
  } satisfies OrchestrationReactorDeliveriesShape;
});

export const OrchestrationReactorDeliveriesLive = Layer.effect(
  OrchestrationReactorDeliveries,
  make,
);
