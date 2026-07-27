import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  RECOVERY_PARTIAL_OUTPUT_NOTICE,
  resolveThreadRecoveryPresentation,
} from "./threadRecoveryPresentation";

const TURN_ID = TurnId.make("turn-1");
const SOURCE_ID = MessageId.make("source-message");
const DETECTED_AT = "2026-07-26T10:05:00.000Z";
const LAST_OBSERVED_AT = "2026-07-26T10:04:30.000Z";

function thread(input: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Recovery",
    modelSelection: {
      instanceId: ProviderInstanceId.make("cursor"),
      model: "composer-1",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TURN_ID,
      state: "interrupted",
      requestedAt: "2026-07-26T10:00:00.000Z",
      startedAt: "2026-07-26T10:00:01.000Z",
      completedAt: LAST_OBSERVED_AT,
      assistantMessageId: null,
      interruptionCode: "server_restart",
      interruptionDetectedAt: DETECTED_AT,
      executionLastObservedAt: LAST_OBSERVED_AT,
      retrySourceMessageId: SOURCE_ID,
    },
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: DETECTED_AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [
      {
        id: SOURCE_ID,
        role: "user",
        text: "Original prompt",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        turnId: TURN_ID,
        streaming: false,
        createdAt: "2026-07-26T10:00:00.000Z",
        updatedAt: "2026-07-26T10:00:00.000Z",
      },
      {
        id: MessageId.make("later-message"),
        role: "user",
        text: "Do not retry this",
        turnId: null,
        streaming: false,
        createdAt: "2026-07-26T10:06:00.000Z",
        updatedAt: "2026-07-26T10:06:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: ThreadId.make("thread-1"),
      providerName: "Cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      runtimeMode: "full-access",
      status: "interrupted",
      activeTurnId: null,
      lastError: "unrelated generic error",
      updatedAt: DETECTED_AT,
    },
    ...input,
  };
}

describe("resolveThreadRecoveryPresentation", () => {
  it("provides explicit preserved-output copy for the accessible recovery notice", () => {
    expect(RECOVERY_PARTIAL_OUTPUT_NOTICE).toBe(
      "Partial output is preserved in the conversation below.",
    );
  });

  it("uses turn-owned reason and distinct execution/detection evidence", () => {
    expect(resolveThreadRecoveryPresentation(thread())).toMatchObject({
      kind: "turn-interrupted",
      title: "Turn interrupted",
      detail: "The server restarted before this turn finished.",
      executionLastObservedAt: LAST_OBSERVED_AT,
      detectedAt: DETECTED_AT,
      retry: {
        kind: "available",
        sourceMessageId: SOURCE_ID,
        text: "Original prompt",
        attachments: [{ id: "attachment-1" }],
      },
    });
  });

  it("maps provider, mismatch, shutdown, cancellation, and generic codes", () => {
    const detailFor = (code: string | null | undefined) =>
      resolveThreadRecoveryPresentation(
        thread({ latestTurn: { ...thread().latestTurn!, interruptionCode: code } }),
      )?.detail;

    expect(detailFor("provider_exit")).toBe("The provider exited before this turn finished.");
    expect(detailFor("provider_state_mismatch")).toBe(
      "The provider no longer reports this turn as active.",
    );
    expect(detailFor("server_shutdown")).toBe("The server shut down before this turn finished.");
    expect(detailFor("recovery_cancelled")).toBe(
      "This turn was cancelled while it was being recovered.",
    );
    expect(detailFor("future_code")).toBe("This turn stopped before it produced a final response.");
  });

  it("supports a generic legacy interruption and disables exact retry", () => {
    const legacy = thread({
      latestTurn: {
        ...thread().latestTurn!,
        interruptionCode: undefined,
        interruptionDetectedAt: undefined,
        executionLastObservedAt: undefined,
        retrySourceMessageId: undefined,
      },
    });
    expect(resolveThreadRecoveryPresentation(legacy)).toMatchObject({
      kind: "turn-interrupted",
      detail: "This turn stopped before it produced a final response.",
      retry: { kind: "unavailable", reason: "missing-source-id" },
    });
  });

  it("presents a pending-start interruption without inventing a turn", () => {
    const pending = thread({
      latestTurn: null,
      messages: [
        {
          ...thread().messages[0]!,
          turnId: null,
        },
      ],
      session: { ...thread().session!, status: "interrupted", activeTurnId: null },
      activities: [
        {
          id: EventId.make("event-start-interrupted"),
          tone: "error",
          kind: "session.start.interrupted",
          summary: "Turn start was interrupted.",
          payload: { pendingMessageId: SOURCE_ID },
          turnId: null,
          createdAt: DETECTED_AT,
        },
      ],
    });
    expect(resolveThreadRecoveryPresentation(pending)).toMatchObject({
      kind: "start-interrupted",
      executionLastObservedAt: null,
      detectedAt: DETECTED_AT,
      retry: { kind: "unavailable" },
    });
    expect(pending.messages[0]?.text).toBe("Original prompt");
    expect(pending.latestTurn).toBeNull();
  });

  it("suppresses stale pending-start recovery after a newer user message", () => {
    const pending = thread({
      latestTurn: null,
      messages: [
        {
          ...thread().messages[0]!,
          turnId: null,
        },
        {
          ...thread().messages[1]!,
          turnId: null,
        },
      ],
      session: { ...thread().session!, status: "interrupted", activeTurnId: null },
      activities: [
        {
          id: EventId.make("event-stale-start-interrupted"),
          tone: "error",
          kind: "session.start.interrupted",
          summary: "Turn start was interrupted.",
          payload: { pendingMessageId: SOURCE_ID },
          turnId: null,
          createdAt: DETECTED_AT,
        },
      ],
    });

    expect(resolveThreadRecoveryPresentation(pending)).toBeNull();
    expect(pending.latestTurn).toBeNull();
  });

  it("never flags a healthy Cursor ready session with the active turn", () => {
    const healthyCursor = thread({
      session: { ...thread().session!, status: "ready", activeTurnId: TURN_ID },
    });
    expect(resolveThreadRecoveryPresentation(healthyCursor)).toBeNull();
  });

  it("shows a defensive stale indicator only for a detached running turn", () => {
    const stale = thread({
      latestTurn: {
        ...thread().latestTurn!,
        state: "running",
        completedAt: null,
        interruptionCode: undefined,
        interruptionDetectedAt: undefined,
        executionLastObservedAt: undefined,
      },
      session: { ...thread().session!, status: "ready", activeTurnId: null },
    });
    expect(resolveThreadRecoveryPresentation(stale)).toMatchObject({
      kind: "stale-runtime",
      title: "Turn status is catching up",
      retry: { kind: "unavailable" },
    });
  });
});
