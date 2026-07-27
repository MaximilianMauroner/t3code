import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";

const testLayer = ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory));

it.layer(testLayer)("ProjectionTurnRepository recovery evidence", (it) => {
  it.effect("round-trips pending identity and exact turn interruption evidence", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTurnRepository;
      const threadId = ThreadId.make("thread-recovery");
      const messageId = MessageId.make("message-source");
      yield* repository.replacePendingTurnStart({
        threadId,
        messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: "2026-07-26T00:00:00.000Z",
        pendingDeliveryId: "delivery-start",
        pendingEventId: "event-start",
      });
      expect(
        Option.getOrThrow(yield* repository.getPendingTurnStartByThreadId({ threadId })),
      ).toMatchObject({
        messageId: "message-source",
        pendingDeliveryId: "delivery-start",
        pendingEventId: "event-start",
      });

      yield* repository.replacePendingTurnStart({
        threadId,
        messageId: MessageId.make("message-replacement"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: "2026-07-26T00:00:01.000Z",
        pendingDeliveryId: "delivery-replacement",
        pendingEventId: "event-replacement",
      });
      expect(
        Option.getOrThrow(yield* repository.getPendingTurnStartByThreadId({ threadId })),
      ).toMatchObject({
        messageId: "message-replacement",
        pendingDeliveryId: "delivery-replacement",
        pendingEventId: "event-replacement",
      });

      yield* repository.replacePendingTurnStart({
        threadId,
        messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: "2026-07-26T00:00:02.000Z",
      });
      expect(
        Option.getOrThrow(yield* repository.getPendingTurnStartByThreadId({ threadId })),
      ).toMatchObject({
        messageId: "message-source",
        pendingDeliveryId: null,
        pendingEventId: null,
      });

      const turnId = TurnId.make("turn-1");
      yield* repository.upsertByTurnId({
        threadId,
        turnId,
        pendingMessageId: messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "interrupted",
        requestedAt: "2026-07-26T00:00:00.000Z",
        startedAt: "2026-07-26T00:00:01.000Z",
        completedAt: "2026-07-26T00:00:02.000Z",
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
        interruptionCode: "server_restart",
        interruptionDetectedAt: "2026-07-26T00:00:03.000Z",
        executionLastObservedAt: "2026-07-26T00:00:02.000Z",
        interruptionTimestampFallback: false,
        retrySourceMessageId: messageId,
      });
      const recovered = Option.getOrThrow(yield* repository.getByTurnId({ threadId, turnId }));
      expect(recovered).toMatchObject({
        state: "interrupted",
        interruptionCode: "server_restart",
        interruptionDetectedAt: "2026-07-26T00:00:03.000Z",
        executionLastObservedAt: "2026-07-26T00:00:02.000Z",
        interruptionTimestampFallback: false,
        retrySourceMessageId: "message-source",
      });
    }),
  );
});
