import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { projectEvent } from "./projector.ts";

const STARTED = "2026-07-26T00:00:00.000Z";
const DETECTED = "2026-07-26T00:00:03.000Z";

function model(): OrchestrationReadModel {
  return {
    snapshotSequence: 10,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Recovery",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: STARTED,
          startedAt: STARTED,
          completedAt: null,
          assistantMessageId: null,
        },
        createdAt: STARTED,
        updatedAt: STARTED,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "user",
            text: "keep me",
            turnId: null,
            streaming: false,
            createdAt: STARTED,
            updatedAt: STARTED,
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: STARTED,
        },
      },
    ],
    updatedAt: STARTED,
  };
}

function event(type: OrchestrationEvent["type"], payload: unknown): OrchestrationEvent {
  return {
    sequence: 11,
    eventId: EventId.make("recovery-event"),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: DETECTED,
    commandId: CommandId.make("recovery-command"),
    causationEventId: null,
    correlationId: CommandId.make("recovery-command"),
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

it.effect("projects concrete interruption evidence onto exactly the active turn", () =>
  Effect.gen(function* () {
    const next = yield* projectEvent(
      model(),
      event("thread.session-interrupted", {
        threadId: "thread-1",
        turnId: "turn-1",
        interruptionCode: "server_restart",
        reason: "server-restarted",
        detectedAt: DETECTED,
        timestampFallback: true,
        retrySourceMessageId: "message-1",
        serverBootId: "boot-2",
      }),
    );
    expect(next.threads[0]?.latestTurn).toMatchObject({
      state: "interrupted",
      completedAt: DETECTED,
      interruptionCode: "server_restart",
      interruptionDetectedAt: DETECTED,
      interruptionTimestampFallback: true,
      retrySourceMessageId: "message-1",
    });
    expect(next.threads[0]?.session?.status).toBe("interrupted");
  }),
);

it.effect(
  "projects pending-start evidence without deleting its user message or creating a turn",
  () =>
    Effect.gen(function* () {
      const base = model();
      const thread = base.threads[0]!;
      const pending: OrchestrationReadModel = {
        ...base,
        threads: [{ ...thread, latestTurn: null, session: null }],
      };
      const next = yield* projectEvent(
        pending,
        event("thread.session-start-interrupted", {
          threadId: "thread-1",
          pendingMessageId: "message-1",
          deliveryId: "delivery-1",
          sourceEventId: "source-event-1",
          interruptionCode: "server_restart",
          reason: "server-restarted",
          detectedAt: DETECTED,
          serverBootId: "boot-2",
        }),
      );
      expect(next.threads[0]?.messages.map((message) => message.id)).toEqual(["message-1"]);
      expect(next.threads[0]?.latestTurn).toBeNull();
      expect(next.threads[0]?.session).toBeNull();
      expect(next.threads[0]?.activities[0]?.kind).toBe("session.start.interrupted");
    }),
);
