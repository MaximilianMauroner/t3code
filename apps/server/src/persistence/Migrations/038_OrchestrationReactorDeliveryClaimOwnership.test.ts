import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_OrchestrationReactorDeliveryClaimOwnership", (it) => {
  it.effect("adds durable claim ownership and execution-boundary columns idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* runMigrations();
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_reactor_deliveries)
      `;
      for (const name of ["claim_boot_id", "execution_started_at"]) {
        assert.ok(
          columns.some((column) => column.name === name),
          name,
        );
      }
    }),
  );
});
