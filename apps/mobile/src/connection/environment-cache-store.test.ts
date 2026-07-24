import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadDetailSnapshot,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type ClientCacheKind, MobileDatabase } from "../persistence/mobile-database";
import { make } from "./environment-cache-store";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_SNAPSHOT: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 7,
  thread: {
    id: ThreadId.make("thread-v3"),
    projectId: ProjectId.make("project-1"),
    title: "Cached thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  },
};
const REFS: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
};

function cacheId(environmentId: EnvironmentId, kind: ClientCacheKind, cacheKey: string) {
  return `${environmentId}:${kind}:${cacheKey}`;
}

function makeDatabase() {
  const values = new Map<string, string>();
  const removed: Array<string> = [];
  const database = MobileDatabase.of({
    loadCache: (environmentId, kind, cacheKey) =>
      Effect.succeed(Option.fromUndefinedOr(values.get(cacheId(environmentId, kind, cacheKey)))),
    saveCache: (environmentId, kind, cacheKey, _schemaVersion, payload) =>
      Effect.sync(() => {
        values.set(cacheId(environmentId, kind, cacheKey), payload);
      }),
    removeCache: (environmentId, kind, cacheKey) =>
      Effect.sync(() => {
        const id = cacheId(environmentId, kind, cacheKey);
        removed.push(id);
        values.delete(id);
      }),
    clearEnvironmentCache: (environmentId) =>
      Effect.sync(() => {
        for (const key of values.keys()) {
          if (key.startsWith(`${environmentId}:`)) values.delete(key);
        }
      }),
    clearAllCaches: Effect.sync(() => values.clear()),
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.succeed(Option.none()),
    savePreferencesJson: () => Effect.void,
  });
  return { database, removed, values };
}

describe("mobile SQLite environment cache store", () => {
  it.effect("removes a v2 thread snapshot and treats it as a cold cache", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const threadId = ThreadId.make("thread-v2");
      const id = cacheId(ENVIRONMENT_ID, "thread", threadId);
      memory.values.set(
        id,
        JSON.stringify({
          schemaVersion: 2,
          environmentId: ENVIRONMENT_ID,
          threadId,
          snapshot: {},
        }),
      );

      expect(yield* store.loadThread(ENVIRONMENT_ID, threadId)).toEqual(Option.none());
      expect(memory.removed).toEqual([id]);
    }),
  );

  it.effect("round-trips a v3 thread snapshot", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));

      yield* store.saveThread(ENVIRONMENT_ID, THREAD_SNAPSHOT);

      expect(yield* store.loadThread(ENVIRONMENT_ID, THREAD_SNAPSHOT.thread.id)).toEqual(
        Option.some(THREAD_SNAPSHOT),
      );
    }),
  );

  it.effect("round-trips schema-validated VCS refs", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));

      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.some(REFS));
    }),
  );

  it.effect("deletes a corrupt cache record and treats it as a miss", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const id = cacheId(ENVIRONMENT_ID, "vcs-refs", "/repo");
      memory.values.set(id, "{not-json");

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(memory.removed).toEqual([id]);
    }),
  );

  it.effect("clears one environment without touching another", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, memory.database));
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);
      yield* store.saveVcsRefs(otherEnvironmentId, "/repo", REFS);

      yield* store.clear(ENVIRONMENT_ID);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(otherEnvironmentId, "/repo")).toEqual(Option.some(REFS));
    }),
  );
});
