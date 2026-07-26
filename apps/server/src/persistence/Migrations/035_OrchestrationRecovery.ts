import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const addColumnIfMissing = Effect.fn("OrchestrationRecovery.addColumnIfMissing")(function* (
  table: "provider_session_runtime" | "projection_turns",
  name: string,
  definition: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
  if (!columns.some((column) => column.name === name)) {
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* addColumnIfMissing("provider_session_runtime", "server_boot_id", "TEXT");
  yield* addColumnIfMissing("projection_turns", "pending_delivery_id", "TEXT");
  yield* addColumnIfMissing("projection_turns", "pending_event_id", "TEXT");
  yield* addColumnIfMissing("projection_turns", "interruption_code", "TEXT");
  yield* addColumnIfMissing("projection_turns", "interruption_detected_at", "TEXT");
  yield* addColumnIfMissing("projection_turns", "execution_last_observed_at", "TEXT");
  yield* addColumnIfMissing(
    "projection_turns",
    "interruption_timestamp_fallback",
    "INTEGER NOT NULL DEFAULT 0",
  );
  yield* addColumnIfMissing("projection_turns", "retry_source_message_id", "TEXT");

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_reactor_deliveries (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      source_sequence INTEGER NOT NULL,
      source_event_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      reactor TEXT NOT NULL,
      delivery_kind TEXT NOT NULL,
      replay_policy TEXT NOT NULL,
      source_boot_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      command_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      delivered_at TEXT,
      cancelled_at TEXT,
      dead_lettered_at TEXT,
      CHECK (status IN ('pending', 'delivering', 'delivered', 'cancelled', 'dead-letter')),
      UNIQUE (source_event_id, reactor, delivery_kind)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_reactor_deliveries_pending
    ON orchestration_reactor_deliveries(status, source_sequence, row_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_reactor_deliveries_thread
    ON orchestration_reactor_deliveries(thread_id, status, source_sequence)
  `;
});
