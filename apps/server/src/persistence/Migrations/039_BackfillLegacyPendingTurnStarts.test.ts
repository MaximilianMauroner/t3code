import { OrchestrationEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0039 from "./039_BackfillLegacyPendingTurnStarts.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const decodePersistedEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationEvent));

layer("039_BackfillLegacyPendingTurnStarts", (it) => {
  it.effect("backfills only exact unambiguous legacy pending starts idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });

      const insertEvent = (input: {
        readonly sequence: number;
        readonly eventId: string;
        readonly threadId: string;
        readonly messageId: string;
        readonly createdAt: string;
      }) =>
        sql`
          INSERT INTO orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
            payload_json, metadata_json
          ) VALUES (
            ${input.sequence}, ${input.eventId}, 'thread', ${input.threadId}, ${input.sequence},
            'thread.turn-start-requested', ${input.createdAt}, ${`command-${input.eventId}`},
            NULL, NULL, 'system',
            ${JSON.stringify({
              threadId: input.threadId,
              messageId: input.messageId,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: input.createdAt,
            })},
            '{}'
          )
        `;
      const insertPending = (input: {
        readonly threadId: string;
        readonly messageId: string;
        readonly requestedAt: string;
      }) =>
        sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          ) VALUES (
            ${input.threadId}, NULL, ${input.messageId}, NULL, 'pending',
            ${input.requestedAt}, NULL, NULL, NULL, NULL, NULL, '[]'
          )
        `;

      yield* insertPending({
        threadId: "thread-exact",
        messageId: "message-exact",
        requestedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* insertEvent({
        sequence: 1,
        eventId: "event-exact",
        threadId: "thread-exact",
        messageId: "message-exact",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* insertPending({
        threadId: "thread-ambiguous",
        messageId: "message-ambiguous",
        requestedAt: "2026-01-02T00:00:00.000Z",
      });
      yield* insertEvent({
        sequence: 2,
        eventId: "event-ambiguous-a",
        threadId: "thread-ambiguous",
        messageId: "message-ambiguous",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      yield* insertEvent({
        sequence: 3,
        eventId: "event-ambiguous-b",
        threadId: "thread-ambiguous",
        messageId: "message-ambiguous",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      yield* insertPending({
        threadId: "thread-unmatched",
        messageId: "message-unmatched",
        requestedAt: "2026-01-03T00:00:00.000Z",
      });

      yield* runMigrations();
      yield* Migration0039;

      const turns = yield* sql<{
        readonly threadId: string;
        readonly pendingDeliveryId: string | null;
        readonly pendingEventId: string | null;
      }>`
        SELECT thread_id AS "threadId", pending_delivery_id AS "pendingDeliveryId",
          pending_event_id AS "pendingEventId"
        FROM projection_turns
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(turns, [
        {
          threadId: "thread-ambiguous",
          pendingDeliveryId: null,
          pendingEventId: null,
        },
        {
          threadId: "thread-exact",
          pendingDeliveryId: "orchestration:event-exact:turn-start",
          pendingEventId: "event-exact",
        },
        {
          threadId: "thread-unmatched",
          pendingDeliveryId: null,
          pendingEventId: null,
        },
      ]);

      const deliveries = yield* sql<{
        readonly payload: string;
        readonly sourceBootId: string;
      }>`
        SELECT payload_json AS payload, source_boot_id AS "sourceBootId"
        FROM orchestration_reactor_deliveries
      `;
      assert.lengthOf(deliveries, 1);
      assert.equal(deliveries[0]?.sourceBootId, "legacy-pre-035");
      const event = yield* decodePersistedEvent(deliveries[0]!.payload);
      assert.equal(event.eventId, "event-exact");
    }),
  );
});
