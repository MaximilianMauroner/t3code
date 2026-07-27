import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const exactLegacyCandidates = `
  SELECT
    turns.row_id AS turn_row_id,
    events.sequence,
    events.event_id,
    events.stream_id,
    events.occurred_at,
    events.command_id,
    events.causation_event_id,
    events.correlation_id,
    events.payload_json,
    events.metadata_json
  FROM projection_turns AS turns
  JOIN orchestration_events AS events
    ON events.aggregate_kind = 'thread'
   AND events.stream_id = turns.thread_id
   AND events.event_type = 'thread.turn-start-requested'
   AND json_extract(events.payload_json, '$.threadId') = turns.thread_id
   AND json_extract(events.payload_json, '$.messageId') = turns.pending_message_id
   AND json_extract(events.payload_json, '$.createdAt') = turns.requested_at
  WHERE turns.turn_id IS NULL
    AND turns.pending_message_id IS NOT NULL
    AND turns.pending_delivery_id IS NULL
    AND turns.pending_event_id IS NULL
    AND (
      SELECT COUNT(*)
      FROM orchestration_events AS matching
      WHERE matching.aggregate_kind = 'thread'
        AND matching.stream_id = turns.thread_id
        AND matching.event_type = 'thread.turn-start-requested'
        AND json_extract(matching.payload_json, '$.threadId') = turns.thread_id
        AND json_extract(matching.payload_json, '$.messageId') = turns.pending_message_id
        AND json_extract(matching.payload_json, '$.createdAt') = turns.requested_at
    ) = 1
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    INSERT INTO orchestration_reactor_deliveries (
      delivery_id, source_sequence, source_event_id, thread_id, reactor,
      delivery_kind, replay_policy, source_boot_id, payload_json, command_id,
      status, attempts, created_at
    )
    SELECT
      'orchestration:' || event_id || ':turn-start',
      sequence,
      event_id,
      stream_id,
      'provider-command',
      'turn-start',
      'cancel-with-recovery',
      'legacy-pre-035',
      json_object(
        'sequence', sequence,
        'eventId', event_id,
        'aggregateKind', 'thread',
        'aggregateId', stream_id,
        'occurredAt', occurred_at,
        'commandId', command_id,
        'causationEventId', causation_event_id,
        'correlationId', correlation_id,
        'metadata', json(metadata_json),
        'type', 'thread.turn-start-requested',
        'payload', json(payload_json)
      ),
      command_id,
      'pending',
      0,
      occurred_at
    FROM (${exactLegacyCandidates})
    WHERE true
    ON CONFLICT(delivery_id) DO NOTHING
  `);

  yield* sql.unsafe(`
    UPDATE projection_turns
    SET
      pending_event_id = (
        SELECT event_id
        FROM (${exactLegacyCandidates})
        WHERE turn_row_id = projection_turns.row_id
      ),
      pending_delivery_id = (
        SELECT 'orchestration:' || event_id || ':turn-start'
        FROM (${exactLegacyCandidates})
        WHERE turn_row_id = projection_turns.row_id
      )
    WHERE row_id IN (SELECT turn_row_id FROM (${exactLegacyCandidates}))
  `);
});
