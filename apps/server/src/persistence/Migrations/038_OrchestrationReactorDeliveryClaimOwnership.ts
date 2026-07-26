import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_reactor_deliveries)
  `;
  if (!columns.some((column) => column.name === "claim_boot_id")) {
    yield* sql`
      ALTER TABLE orchestration_reactor_deliveries
      ADD COLUMN claim_boot_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "execution_started_at")) {
    yield* sql`
      ALTER TABLE orchestration_reactor_deliveries
      ADD COLUMN execution_started_at TEXT
    `;
  }
});
