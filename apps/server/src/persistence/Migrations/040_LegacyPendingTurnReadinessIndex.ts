import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_legacy_pending_readiness
    ON projection_turns(row_id, thread_id, pending_message_id, requested_at)
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND pending_message_id IS NOT NULL
      AND checkpoint_turn_count IS NULL
      AND (pending_delivery_id IS NULL OR pending_event_id IS NULL)
  `;
});
