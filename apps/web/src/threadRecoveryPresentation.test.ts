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
  buildThreadRecoveryPresentation,
  resolveThreadRecoveryRetry,
} from "./threadRecoveryPresentation";

const THREAD_ID = ThreadId.make("thread-web-recovery");
const TURN_ID = TurnId.make("turn-web-recovery");
const SOURCE_MESSAGE_ID = MessageId.make("message-original");
const DETECTED_AT = "2026-07-26T02:00:00.000Z";
const LAST_OBSERVED_AT = "2026-07-26T01:59:58.000Z";

const baseThread: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-web-recovery"),
  title: "Web recovery",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: {
    turnId: TURN_ID,
    state: "interrupted",
    requestedAt: "2026-07-26T01:00:00.000Z",
    startedAt: "2026-07-26T01:00:01.000Z",
    completedAt: LAST_OBSERVED_AT,
    assistantMessageId: MessageId.make("message-assistant"),
    interruptionCode: "server_restart",
    interruptionDetectedAt: DETECTED_AT,
    executionLastObservedAt: LAST_OBSERVED_AT,
    interruptionTimestampFallback: false,
    retrySourceMessageId: SOURCE_MESSAGE_ID,
  },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: DETECTED_AT,
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
          id: "attachment-original",
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
      text: "Partial output",
      turnId: TURN_ID,
      streaming: false,
      createdAt: "2026-07-26T01:00:02.000Z",
      updatedAt: LAST_OBSERVED_AT,
    },
    {
      id: MessageId.make("message-newer"),
      role: "user",
      text: "A newer prompt that must not be retried",
      turnId: null,
      streaming: false,
      createdAt: "2026-07-26T01:59:59.000Z",
      updatedAt: "2026-07-26T01:59:59.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: THREAD_ID,
    status: "interrupted",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: DETECTED_AT,
  },
};

describe("thread recovery presentation", () => {
  it.each([
    ["server_restart", "server restarted"],
    ["provider_exit", "provider stopped unexpectedly"],
    ["provider_state_mismatch", "no longer reported this turn as active"],
    ["server_shutdown", "server shut down"],
  ])("uses concise reason-specific copy for %s", (interruptionCode, expectedCopy) => {
    const presentation = buildThreadRecoveryPresentation({
      ...baseThread,
      latestTurn: { ...baseThread.latestTurn!, interruptionCode },
    });
    expect(presentation?.message.toLowerCase()).toContain(expectedCopy);
    expect(presentation).toMatchObject({
      detectedAt: DETECTED_AT,
      executionLastObservedAt: LAST_OBSERVED_AT,
      timestampFallback: false,
    });
  });

  it("explicitly marks a detection-time fallback and keeps legacy copy generic", () => {
    expect(
      buildThreadRecoveryPresentation({
        ...baseThread,
        latestTurn: {
          ...baseThread.latestTurn!,
          interruptionCode: "recovery_invariant_cancelled",
          executionLastObservedAt: DETECTED_AT,
          interruptionTimestampFallback: true,
        },
      }),
    ).toMatchObject({
      message: "This turn was interrupted before it finished.",
      timestampFallback: true,
    });

    expect(
      buildThreadRecoveryPresentation({
        ...baseThread,
        latestTurn: {
          ...baseThread.latestTurn!,
          interruptionCode: undefined,
          interruptionDetectedAt: undefined,
          executionLastObservedAt: undefined,
          retrySourceMessageId: undefined,
        },
      }),
    ).toMatchObject({
      message: "This turn was interrupted before it finished.",
      detectedAt: null,
    });
  });

  it("suppresses the banner for a healthy Cursor-ready active turn", () => {
    expect(
      buildThreadRecoveryPresentation({
        ...baseThread,
        session: { ...baseThread.session!, status: "ready", activeTurnId: TURN_ID },
      }),
    ).toBeNull();
  });

  it("matches mobile pending-start visibility and stale-evidence suppression", () => {
    const activity = {
      id: EventId.make("event-web-start-interrupted"),
      tone: "error" as const,
      kind: "session.start.interrupted",
      summary: "Turn start was interrupted.",
      payload: { pendingMessageId: SOURCE_MESSAGE_ID },
      turnId: null,
      createdAt: DETECTED_AT,
    };
    const current = {
      ...baseThread,
      latestTurn: null,
      messages: [
        {
          ...baseThread.messages[0]!,
          turnId: null,
        },
      ],
      activities: [activity],
      session: { ...baseThread.session!, status: "interrupted" as const, activeTurnId: null },
    };

    expect(buildThreadRecoveryPresentation(current)).toMatchObject({
      title: "Turn start interrupted",
      detectedAt: DETECTED_AT,
      executionLastObservedAt: null,
    });
    expect(
      buildThreadRecoveryPresentation({
        ...current,
        messages: [
          ...current.messages,
          {
            ...current.messages[0]!,
            id: MessageId.make("message-web-newer"),
            createdAt: "2026-07-26T02:01:00.000Z",
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("thread recovery retry", () => {
  it("selects the exact source prompt and every original attachment URL", () => {
    expect(
      resolveThreadRecoveryRetry(
        baseThread,
        new Map([["attachment-original", "https://assets.test/original"]]),
      ),
    ).toEqual({
      kind: "available",
      sourceMessageId: SOURCE_MESSAGE_ID,
      text: "Original prompt",
      attachments: [
        {
          attachment: baseThread.messages[0]?.attachments?.[0],
          url: "https://assets.test/original",
        },
      ],
      sourceProposedPlan: undefined,
    });
  });

  it("never substitutes a newer prompt when source evidence or attachments are missing", () => {
    expect(resolveThreadRecoveryRetry({ ...baseThread, messages: [] }, new Map())).toEqual({
      kind: "unavailable",
      reason: "source-message-missing",
    });
    expect(resolveThreadRecoveryRetry(baseThread, new Map())).toEqual({
      kind: "unavailable",
      reason: "attachment-unavailable",
    });
  });
});
