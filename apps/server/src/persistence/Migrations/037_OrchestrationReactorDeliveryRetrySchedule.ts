import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_reactor_deliveries)
  `;
  if (!columns.some((column) => column.name === "next_attempt_at")) {
    yield* sql`
      ALTER TABLE orchestration_reactor_deliveries
      ADD COLUMN next_attempt_at TEXT
    `;
  }
});
