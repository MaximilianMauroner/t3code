import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_OrchestrationReactorDeliveryLeases", (it) => {
  it.effect("adds idempotent lease ownership and failure evidence columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`ALTER TABLE orchestration_reactor_deliveries ADD COLUMN claim_token TEXT`;
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_reactor_deliveries)
      `;
      for (const name of ["claim_token", "lease_expires_at", "last_failed_at"]) {
        assert.ok(
          columns.some((column) => column.name === name),
          name,
        );
      }

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(orchestration_reactor_deliveries)
      `;
      assert.ok(
        indexes.some((index) => index.name === "idx_orchestration_reactor_deliveries_global_order"),
      );
    }),
  );
});
