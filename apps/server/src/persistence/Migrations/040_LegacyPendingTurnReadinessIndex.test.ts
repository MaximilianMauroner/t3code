import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_LegacyPendingTurnReadinessIndex", (it) => {
  it.effect("adds the partial readiness index after the conservative legacy backfill", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_turns_legacy_pending_readiness'
      `;
      assert.lengthOf(before, 0);

      yield* runMigrations();

      const after = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_turns_legacy_pending_readiness'
      `;
      assert.lengthOf(after, 1);
      assert.include(after[0]!.sql, "pending_delivery_id IS NULL OR pending_event_id IS NULL");
    }),
  );
});
