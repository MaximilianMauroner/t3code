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
} from "../Services/OrchestrationReactorDeliveries.ts";

const DeliveryDbRow = OrchestrationReactorDelivery.mapFields(
  Struct.assign({ payload: Schema.fromJsonString(Schema.Unknown) }),
);
const NewDeliveryDbRow = NewOrchestrationReactorDelivery.mapFields(
  Struct.assign({ payload: Schema.fromJsonString(Schema.Unknown) }),
);
const DeliveryIdInput = Schema.Struct({ deliveryId: Schema.String });
const TerminalInput = Schema.Struct({ deliveryId: Schema.String, at: Schema.String });
const DeadLetterInput = Schema.Struct({
  deliveryId: Schema.String,
  at: Schema.String,
  lastError: Schema.String,
});

const selectFields = `
  delivery_id AS "deliveryId", source_sequence AS "sourceSequence",
  source_event_id AS "sourceEventId", thread_id AS "threadId", reactor,
  delivery_kind AS "deliveryKind", replay_policy AS "replayPolicy",
  source_boot_id AS "sourceBootId", payload_json AS "payload",
  command_id AS "commandId", status, attempts, last_error AS "lastError",
  created_at AS "createdAt", claimed_at AS "claimedAt",
  delivered_at AS "deliveredAt", cancelled_at AS "cancelledAt",
  dead_lettered_at AS "deadLetteredAt"
`;

function mapError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insertRow = SqlSchema.void({
    Request: NewDeliveryDbRow,
    execute: (row) => sql`
      INSERT INTO orchestration_reactor_deliveries (
        delivery_id, source_sequence, source_event_id, thread_id, reactor,
        delivery_kind, replay_policy, source_boot_id, payload_json, command_id,
        status, attempts, last_error, created_at, claimed_at, delivered_at,
        cancelled_at, dead_lettered_at
      ) VALUES (
        ${row.deliveryId}, ${row.sourceSequence}, ${row.sourceEventId}, ${row.threadId},
        ${row.reactor}, ${row.deliveryKind}, ${row.replayPolicy}, ${row.sourceBootId},
        ${row.payload}, ${row.commandId}, ${row.status ?? "pending"}, ${row.attempts ?? 0},
        ${row.lastError ?? null}, ${row.createdAt}, ${row.claimedAt ?? null},
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
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DeliveryDbRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${selectFields} FROM orchestration_reactor_deliveries WHERE status = 'pending' ORDER BY source_sequence, row_id`,
      ),
  });
  const updateDelivered = SqlSchema.void({
    Request: TerminalInput,
    execute: ({ deliveryId, at }) => sql`
      UPDATE orchestration_reactor_deliveries
      SET status = 'delivered', delivered_at = ${at}, last_error = NULL
      WHERE delivery_id = ${deliveryId} AND status IN ('pending', 'delivering')
    `,
  });
  const updateCancelled = SqlSchema.void({
    Request: TerminalInput,
    execute: ({ deliveryId, at }) => sql`
      UPDATE orchestration_reactor_deliveries
      SET status = 'cancelled', cancelled_at = ${at}
      WHERE delivery_id = ${deliveryId} AND status IN ('pending', 'delivering')
    `,
  });
  const updateDeadLetter = SqlSchema.void({
    Request: DeadLetterInput,
    execute: ({ deliveryId, at, lastError }) => sql`
      UPDATE orchestration_reactor_deliveries
      SET status = 'dead-letter', dead_lettered_at = ${at}, last_error = ${lastError}
      WHERE delivery_id = ${deliveryId} AND status IN ('pending', 'delivering')
    `,
  });

  const insert: OrchestrationReactorDeliveriesShape["insert"] = (delivery) =>
    insertRow(delivery).pipe(Effect.mapError(mapError("OrchestrationReactorDeliveries.insert")));
  const getById: OrchestrationReactorDeliveriesShape["getById"] = (deliveryId) =>
    getRow({ deliveryId }).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.getById")),
    );
  const listPendingOrdered: OrchestrationReactorDeliveriesShape["listPendingOrdered"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.listPendingOrdered")),
    );
  const claimNext: OrchestrationReactorDeliveriesShape["claimNext"] = (claimedAt) =>
    sql
      .withTransaction(
        listRows(undefined).pipe(
          Effect.flatMap((rows) => {
            const next = rows.at(0);
            if (next === undefined) return Effect.succeed(Option.none());
            return sql`
            UPDATE orchestration_reactor_deliveries
            SET status = 'delivering', claimed_at = ${claimedAt}, attempts = attempts + 1
            WHERE delivery_id = ${next.deliveryId} AND status = 'pending'
          `.pipe(Effect.flatMap(() => getRow({ deliveryId: next.deliveryId })));
          }),
        ),
      )
      .pipe(Effect.mapError(mapError("OrchestrationReactorDeliveries.claimNext")));
  const markDelivered: OrchestrationReactorDeliveriesShape["markDelivered"] = (
    deliveryId,
    deliveredAt,
  ) =>
    updateDelivered({ deliveryId, at: deliveredAt }).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.markDelivered")),
    );
  const markCancelled: OrchestrationReactorDeliveriesShape["markCancelled"] = (
    deliveryId,
    cancelledAt,
  ) =>
    updateCancelled({ deliveryId, at: cancelledAt }).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.markCancelled")),
    );
  const markDeadLetter: OrchestrationReactorDeliveriesShape["markDeadLetter"] = (
    deliveryId,
    deadLetteredAt,
    lastError,
  ) =>
    updateDeadLetter({ deliveryId, at: deadLetteredAt, lastError }).pipe(
      Effect.mapError(mapError("OrchestrationReactorDeliveries.markDeadLetter")),
    );

  return {
    insert,
    getById,
    listPendingOrdered,
    claimNext,
    markDelivered,
    markCancelled,
    markDeadLetter,
  } satisfies OrchestrationReactorDeliveriesShape;
});

export const OrchestrationReactorDeliveriesLive = Layer.effect(
  OrchestrationReactorDeliveries,
  make,
);
