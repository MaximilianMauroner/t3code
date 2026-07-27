import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const addColumnIfMissing = Effect.fn("OrchestrationReactorDeliveryLeases.addColumnIfMissing")(
  function* (name: string, definition: string) {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(orchestration_reactor_deliveries)
    `;
    if (!columns.some((column) => column.name === name)) {
      yield* sql.unsafe(
        `ALTER TABLE orchestration_reactor_deliveries ADD COLUMN ${name} ${definition}`,
      );
    }
  },
);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* addColumnIfMissing("claim_token", "TEXT");
  yield* addColumnIfMissing("lease_expires_at", "TEXT");
  yield* addColumnIfMissing("last_failed_at", "TEXT");

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_reactor_deliveries_global_order
    ON orchestration_reactor_deliveries(
      source_sequence,
      source_event_id,
      reactor,
      delivery_kind,
      row_id,
      status
    )
  `;
});
