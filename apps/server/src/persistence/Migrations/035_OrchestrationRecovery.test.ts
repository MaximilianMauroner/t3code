import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_OrchestrationRecovery", (it) => {
  it.effect("adds nullable recovery evidence and the durable ordered delivery outbox", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`ALTER TABLE provider_session_runtime ADD COLUMN server_boot_id TEXT`;
      yield* sql`ALTER TABLE projection_turns ADD COLUMN pending_delivery_id TEXT`;
      yield* runMigrations();

      const turnColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_turns)`;
      for (const name of [
        "pending_delivery_id",
        "pending_event_id",
        "interruption_code",
        "interruption_detected_at",
        "execution_last_observed_at",
        "interruption_timestamp_fallback",
        "retry_source_message_id",
      ]) {
        assert.ok(
          turnColumns.some((column) => column.name === name),
          name,
        );
      }
      const runtimeColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      assert.ok(runtimeColumns.some((column) => column.name === "server_boot_id"));

      const deliveryColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_reactor_deliveries)
      `;
      assert.ok(deliveryColumns.some((column) => column.name === "source_sequence"));
      assert.ok(deliveryColumns.some((column) => column.name === "replay_policy"));
      assert.ok(deliveryColumns.some((column) => column.name === "source_boot_id"));
    }),
  );
});
