import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { applyThreadDetailEvent } from "./threadReducer.ts";
import { resolveThreadRecoveryRetrySource, threadRecoveryEvidence } from "./threadRecovery.ts";

const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");
const SOURCE_MESSAGE_ID = MessageId.make("message-source");
const DETECTED_AT = "2026-07-26T02:00:00.000Z";
const encodeThreadSnapshot = Schema.encodeSync(OrchestrationThreadDetailSnapshot);
const decodeThreadSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);

const baseThread: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Recovery test",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: {
    turnId: TURN_ID,
    state: "running",
    requestedAt: "2026-07-26T01:00:00.000Z",
    startedAt: "2026-07-26T01:00:01.000Z",
    completedAt: null,
    assistantMessageId: MessageId.make("message-assistant"),
  },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T01:30:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    {
      id: SOURCE_MESSAGE_ID,
      role: "user",
      text: "Original prompt",
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "context.png",
          mimeType: "image/png",
          sizeBytes: 123,
        },
      ],
      turnId: TURN_ID,
      streaming: false,
      createdAt: "2026-07-26T01:00:00.000Z",
      updatedAt: "2026-07-26T01:00:00.000Z",
    },
    {
      id: MessageId.make("message-assistant"),
      role: "assistant",
      text: "Partial work that must remain visible",
      turnId: TURN_ID,
      streaming: true,
      createdAt: "2026-07-26T01:00:02.000Z",
      updatedAt: "2026-07-26T01:30:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: THREAD_ID,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TURN_ID,
    lastError: null,
    updatedAt: "2026-07-26T01:30:00.000Z",
  },
};

function recoveryEvent(): Extract<
  OrchestrationEvent,
  { readonly type: "thread.session-interrupted" }
> {
  return {
    sequence: 42,
    eventId: EventId.make("event-recovery"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: DETECTED_AT,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-interrupted",
    payload: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      interruptionCode: "server_restart",
      reason: "server-restarted",
      detectedAt: DETECTED_AT,
      executionLastObservedAt: "2026-07-26T01:59:58.000Z",
      timestampFallback: false,
      retrySourceMessageId: SOURCE_MESSAGE_ID,
      serverBootId: "boot-2",
    },
  };
}

function updated(result: ReturnType<typeof applyThreadDetailEvent>): OrchestrationThread {
  expect(result.kind).toBe("updated");
  if (result.kind !== "updated") {
    throw new Error("Expected an updated thread.");
  }
  return result.thread;
}

describe("thread recovery events", () => {
  it("settles the exact turn, clears its active session, and preserves partial output", () => {
    const recovered = updated(applyThreadDetailEvent(baseThread, recoveryEvent()));

    expect(recovered.session).toMatchObject({ status: "interrupted", activeTurnId: null });
    expect(recovered.latestTurn).toMatchObject({
      turnId: TURN_ID,
      state: "interrupted",
      completedAt: "2026-07-26T01:59:58.000Z",
      interruptionCode: "server_restart",
      interruptionDetectedAt: DETECTED_AT,
      executionLastObservedAt: "2026-07-26T01:59:58.000Z",
      interruptionTimestampFallback: false,
      retrySourceMessageId: SOURCE_MESSAGE_ID,
    });
    expect(recovered.messages).toEqual(baseThread.messages);
    expect(recovered.updatedAt).toBe(baseThread.updatedAt);
    expect(updated(applyThreadDetailEvent(recovered, recoveryEvent()))).toEqual(recovered);
  });

  it("does not let an old-turn recovery event mutate a newer active turn", () => {
    const newer = {
      ...baseThread,
      latestTurn: { ...baseThread.latestTurn!, turnId: TurnId.make("turn-2") },
      session: { ...baseThread.session!, activeTurnId: TurnId.make("turn-2") },
    };
    expect(applyThreadDetailEvent(newer, recoveryEvent())).toEqual({ kind: "unchanged" });
  });

  it("copies fallback interruption evidence without changing ordinary recency", () => {
    const event = recoveryEvent();
    const recovered = updated(
      applyThreadDetailEvent(baseThread, {
        ...event,
        payload: {
          ...event.payload,
          executionLastObservedAt: undefined,
          timestampFallback: true,
        },
      }),
    );
    expect(recovered.latestTurn).toMatchObject({
      completedAt: DETECTED_AT,
      executionLastObservedAt: null,
      interruptionTimestampFallback: true,
    });
    expect(recovered.updatedAt).toBe(baseThread.updatedAt);
  });

  it("clears only a matching pending start and records evidence without fabricating a turn", () => {
    const pendingMessageId = MessageId.make("pending-message");
    const pendingThread: OrchestrationThread = {
      ...baseThread,
      latestTurn: null,
      messages: [
        {
          id: pendingMessageId,
          role: "user",
          text: "Pending prompt",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-26T01:59:00.000Z",
          updatedAt: "2026-07-26T01:59:00.000Z",
        },
      ],
      session: { ...baseThread.session!, status: "starting", activeTurnId: null },
    };
    const event: OrchestrationEvent = {
      ...recoveryEvent(),
      eventId: EventId.make("event-pending-recovery"),
      type: "thread.session-start-interrupted",
      payload: {
        threadId: THREAD_ID,
        pendingMessageId,
        deliveryId: "delivery-1",
        sourceEventId: EventId.make("event-start-requested"),
        interruptionCode: "server_restart",
        reason: "server-restarted",
        detectedAt: DETECTED_AT,
        expectedSession: {
          kind: "present",
          status: "starting",
          activeTurnId: null,
          updatedAt: baseThread.session!.updatedAt,
          providerName: "codex",
        },
        serverBootId: "boot-2",
      },
    };

    const recovered = updated(applyThreadDetailEvent(pendingThread, event));
    expect(recovered.session).toMatchObject({ status: "interrupted", activeTurnId: null });
    expect(recovered.latestTurn).toBeNull();
    expect(recovered.messages).toEqual(pendingThread.messages);
    expect(recovered.activities).toHaveLength(1);
    expect(recovered.updatedAt).toBe(pendingThread.updatedAt);
    expect(updated(applyThreadDetailEvent(recovered, event))).toEqual(recovered);

    const nonMatching = updated(
      applyThreadDetailEvent(
        { ...pendingThread, messages: [] },
        { ...event, eventId: EventId.make("event-non-matching") },
      ),
    );
    expect(nonMatching.session?.status).toBe("starting");
    expect(nonMatching.latestTurn).toBeNull();
  });

  it("handles a legacy downconverted interruption without leaving the spinner active", () => {
    const legacy: OrchestrationEvent = {
      ...recoveryEvent(),
      type: "thread.turn-interrupt-requested",
      payload: { threadId: THREAD_ID, turnId: TURN_ID, createdAt: DETECTED_AT },
    };
    const recovered = updated(applyThreadDetailEvent(baseThread, legacy));
    expect(recovered.session).toMatchObject({ status: "interrupted", activeTurnId: null });
    expect(recovered.latestTurn?.state).toBe("interrupted");
  });

  it("clears the exact pending start from a legacy downconverted activity", () => {
    const pendingMessageId = MessageId.make("pending-message");
    const pendingThread: OrchestrationThread = {
      ...baseThread,
      latestTurn: null,
      messages: [
        {
          id: pendingMessageId,
          role: "user",
          text: "Pending prompt",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-26T01:59:00.000Z",
          updatedAt: "2026-07-26T01:59:00.000Z",
        },
      ],
      session: { ...baseThread.session!, status: "starting", activeTurnId: null },
    };
    const legacy: OrchestrationEvent = {
      ...recoveryEvent(),
      type: "thread.activity-appended",
      payload: {
        threadId: THREAD_ID,
        activity: {
          id: EventId.make("event-pending-recovery"),
          tone: "error",
          kind: "session.start.interrupted",
          summary: "Turn start was interrupted before a provider session was established.",
          payload: { pendingMessageId },
          turnId: null,
          sequence: 42,
          createdAt: DETECTED_AT,
        },
      },
    };

    const recovered = updated(applyThreadDetailEvent(pendingThread, legacy));
    expect(recovered.session).toMatchObject({ status: "interrupted", activeTurnId: null });
    expect(recovered.messages).toEqual(pendingThread.messages);
    expect(recovered.latestTurn).toBeNull();
  });
});

describe("thread recovery helpers", () => {
  const startInterruptionActivity = {
    id: EventId.make("start-interruption"),
    tone: "error" as const,
    kind: "session.start.interrupted",
    summary: "Turn start was interrupted.",
    payload: { pendingMessageId: "message-pending" },
    turnId: null,
    sequence: 43,
    createdAt: DETECTED_AT,
  };

  it("surfaces only an unresolved latest start interruption", () => {
    const interrupted = {
      ...baseThread,
      latestTurn: null,
      session: { ...baseThread.session!, status: "interrupted" as const, activeTurnId: null },
      activities: [startInterruptionActivity],
    };
    expect(threadRecoveryEvidence(interrupted)).toEqual({
      kind: "start-interrupted",
      detectedAt: DETECTED_AT,
    });

    expect(
      threadRecoveryEvidence({
        ...interrupted,
        latestTurn: {
          ...baseThread.latestTurn!,
          requestedAt: "2026-07-26T02:01:00.000Z",
        },
      }),
    ).toBeNull();
    expect(
      threadRecoveryEvidence({
        ...interrupted,
        messages: [
          ...interrupted.messages,
          {
            ...interrupted.messages[0]!,
            id: MessageId.make("retry-pending"),
            turnId: null,
            createdAt: "2026-07-26T02:01:00.000Z",
          },
        ],
      }),
    ).toBeNull();
  });

  it("keeps a newer pending-start interruption after an older completed turn", () => {
    expect(
      threadRecoveryEvidence({
        ...baseThread,
        latestTurn: {
          ...baseThread.latestTurn!,
          state: "completed",
          requestedAt: "2026-07-26T01:00:00.000Z",
          completedAt: "2026-07-26T01:30:00.000Z",
        },
        session: { ...baseThread.session!, status: "interrupted", activeTurnId: null },
        activities: [startInterruptionActivity],
      }),
    ).toEqual({ kind: "start-interrupted", detectedAt: DETECTED_AT });
  });

  it("keeps a newer pending-start interruption after older turn recovery evidence", () => {
    expect(
      threadRecoveryEvidence({
        ...baseThread,
        latestTurn: {
          ...baseThread.latestTurn!,
          interruptionDetectedAt: "2026-07-26T01:30:00.000Z",
          completedAt: "2026-07-26T01:29:00.000Z",
        },
        session: { ...baseThread.session!, status: "interrupted", activeTurnId: null },
        activities: [startInterruptionActivity],
      }),
    ).toEqual({ kind: "start-interrupted", detectedAt: DETECTED_AT });
  });

  it.each(["ready", "idle", "stopped"] as const)(
    "suppresses historical start interruption after a newer %s session lifecycle",
    (status) => {
      expect(
        threadRecoveryEvidence({
          ...baseThread,
          latestTurn: null,
          session: {
            ...baseThread.session!,
            status,
            activeTurnId: null,
            updatedAt: "2026-07-26T02:01:00.000Z",
          },
          activities: [startInterruptionActivity],
        }),
      ).toBeNull();
    },
  );

  it("uses deterministic conservative ordering for equal-timestamp successor state", () => {
    const interrupted = {
      ...baseThread,
      latestTurn: null,
      session: { ...baseThread.session!, status: "interrupted" as const, activeTurnId: null },
      messages: [
        {
          ...baseThread.messages[0]!,
          id: MessageId.make("message-pending"),
          turnId: null,
          createdAt: DETECTED_AT,
        },
      ],
      activities: [startInterruptionActivity],
    };
    expect(threadRecoveryEvidence(interrupted)).toEqual({
      kind: "start-interrupted",
      detectedAt: DETECTED_AT,
    });

    expect(
      threadRecoveryEvidence({
        ...interrupted,
        messages: [
          ...interrupted.messages,
          {
            ...interrupted.messages[0]!,
            id: MessageId.make("same-time-retry"),
            createdAt: DETECTED_AT,
          },
        ],
      }),
    ).toBeNull();
    expect(
      threadRecoveryEvidence({
        ...interrupted,
        latestTurn: {
          ...baseThread.latestTurn!,
          state: "completed",
          requestedAt: DETECTED_AT,
          startedAt: DETECTED_AT,
          completedAt: DETECTED_AT,
        },
      }),
    ).toBeNull();
    expect(
      threadRecoveryEvidence({
        ...interrupted,
        session: {
          ...interrupted.session!,
          status: "ready",
          updatedAt: DETECTED_AT,
        },
      }),
    ).toBeNull();
  });

  it("resolves the exact older retry source with attachments", () => {
    const newerMessage = {
      ...baseThread.messages[0]!,
      id: MessageId.make("message-newer"),
      text: "Newer prompt",
    };
    const recovered = updated(applyThreadDetailEvent(baseThread, recoveryEvent()));
    const result = resolveThreadRecoveryRetrySource({
      ...recovered,
      messages: [...recovered.messages, newerMessage],
    });

    expect(result).toEqual({
      kind: "available",
      sourceMessageId: SOURCE_MESSAGE_ID,
      text: "Original prompt",
      attachments: baseThread.messages[0]?.attachments,
      sourceProposedPlan: undefined,
    });
  });

  it("returns a typed unavailable result instead of choosing another prompt", () => {
    const recovered = updated(applyThreadDetailEvent(baseThread, recoveryEvent()));
    expect(resolveThreadRecoveryRetrySource({ ...recovered, messages: [] })).toEqual({
      kind: "unavailable",
      reason: "source-message-missing",
    });
  });

  it("round-trips recovery evidence and accepts historic snapshots without it", () => {
    const recovered = updated(applyThreadDetailEvent(baseThread, recoveryEvent()));
    const roundTrip = decodeThreadSnapshot(
      JSON.parse(
        JSON.stringify(
          encodeThreadSnapshot({
            snapshotSequence: 42,
            thread: recovered,
          }),
        ),
      ),
    );
    expect(roundTrip.thread.latestTurn).toMatchObject({
      interruptionCode: "server_restart",
      interruptionDetectedAt: DETECTED_AT,
      retrySourceMessageId: SOURCE_MESSAGE_ID,
    });
    expect(roundTrip.thread.updatedAt).toBe(baseThread.updatedAt);

    const historic = decodeThreadSnapshot({
      snapshotSequence: 1,
      thread: baseThread,
    });
    expect(historic.thread.latestTurn?.interruptionCode).toBeUndefined();
  });

  it("does not infer interruption from a healthy Cursor-ready active turn", () => {
    const cursorReady: OrchestrationThread = {
      ...baseThread,
      session: { ...baseThread.session!, status: "ready", activeTurnId: TURN_ID },
    };
    expect(threadRecoveryEvidence(cursorReady)).toBeNull();
  });
});
