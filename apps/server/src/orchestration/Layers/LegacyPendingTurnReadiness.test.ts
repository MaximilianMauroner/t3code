import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  LEGACY_PENDING_TURN_DIAGNOSTIC_LIMIT,
  OrchestrationProjectionSnapshotQueryLive,
} from "./ProjectionSnapshotQuery.ts";

const liveLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const insertPending = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly requestedAt: string;
    readonly pendingDeliveryId?: string;
    readonly pendingEventId?: string;
  },
) =>
  sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, assistant_message_id, state,
      requested_at, started_at, completed_at, checkpoint_turn_count,
      checkpoint_ref, checkpoint_status, checkpoint_files_json,
      pending_delivery_id, pending_event_id
    ) VALUES (
      ${input.threadId}, NULL, ${input.messageId}, NULL, 'pending',
      ${input.requestedAt}, NULL, NULL, NULL, NULL, NULL, '[]',
      ${input.pendingDeliveryId ?? null}, ${input.pendingEventId ?? null}
    )
  `;

it.effect("keeps exact backfills ready and diagnoses absent/starting legacy placeholders", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const snapshots = yield* ProjectionSnapshotQuery;

    yield* insertPending(sql, {
      threadId: "thread-exact",
      messageId: "message-exact",
      requestedAt: "2026-01-01T00:00:00.000Z",
      pendingDeliveryId: "orchestration:event-exact:turn-start",
      pendingEventId: "event-exact",
    });
    yield* insertPending(sql, {
      threadId: "thread-absent",
      messageId: "message-absent",
      requestedAt: "2026-01-02T00:00:00.000Z",
    });
    yield* insertPending(sql, {
      threadId: "thread-starting",
      messageId: "message-starting",
      requestedAt: "2026-01-03T00:00:00.000Z",
    });
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, runtime_mode,
        active_turn_id, last_error, updated_at
      ) VALUES (
        'thread-starting', 'starting', 'codex', 'codex', 'full-access',
        NULL, NULL, '2026-01-03T00:00:01.000Z'
      )
    `;

    const read = snapshots.getLegacyPendingTurnReadiness;
    assert.isDefined(read);
    const blocked = yield* read!();
    assert.equal(blocked.count, 2);
    assert.isFalse(blocked.truncated);
    assert.deepStrictEqual(
      blocked.issues.map((issue) => ({
        threadId: issue.threadId,
        messageId: issue.messageId,
        sessionStatus: issue.sessionStatus,
      })),
      [
        {
          threadId: "thread-absent",
          messageId: "message-absent",
          sessionStatus: null,
        },
        {
          threadId: "thread-starting",
          messageId: "message-starting",
          sessionStatus: "starting",
        },
      ],
    );

    yield* sql`
      DELETE FROM projection_turns
      WHERE thread_id IN ('thread-absent', 'thread-starting')
    `;
    assert.deepStrictEqual(yield* read!(), {
      count: 0,
      issues: [],
      truncated: false,
    });
  }).pipe(Effect.provide(liveLayer)),
);

it.effect("bounds diagnostic identities while preserving the authoritative count", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const snapshots = yield* ProjectionSnapshotQuery;

    yield* Effect.forEach(
      Array.from({ length: LEGACY_PENDING_TURN_DIAGNOSTIC_LIMIT + 5 }, (_, index) => index),
      (index) =>
        insertPending(sql, {
          threadId: `thread-${index.toString().padStart(3, "0")}`,
          messageId: `message-${index}`,
          requestedAt: "2026-02-01T00:00:00.000Z",
        }),
      { discard: true },
    );

    const read = snapshots.getLegacyPendingTurnReadiness;
    assert.isDefined(read);
    const readiness = yield* read!();
    assert.equal(readiness.count, LEGACY_PENDING_TURN_DIAGNOSTIC_LIMIT + 5);
    assert.lengthOf(readiness.issues, LEGACY_PENDING_TURN_DIAGNOSTIC_LIMIT);
    assert.isTrue(readiness.truncated);
  }).pipe(Effect.provide(liveLayer)),
);

it.effect("fails closed when the bounded readiness query cannot execute", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const snapshots = yield* ProjectionSnapshotQuery;
    yield* sql`DROP TABLE projection_turns`;

    const read = snapshots.getLegacyPendingTurnReadiness;
    assert.isDefined(read);
    const error = yield* Effect.flip(read!());
    assert.equal(error._tag, "PersistenceSqlError");
    assert.equal(error.operation, "ProjectionSnapshotQuery.getLegacyPendingTurnReadiness:query");
  }).pipe(Effect.provide(liveLayer)),
);
