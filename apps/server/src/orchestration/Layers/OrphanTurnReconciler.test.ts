import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isPriorBootRecoveryCandidate,
  isRecoveryCandidateMatch,
  latestEligibleRecoveryObservation,
  recoveryCandidateForThread,
  startupReconciliationResult,
  type RecoveryCandidate,
} from "./OrphanTurnReconciler.ts";

const threadId = ThreadId.make("thread-recovery");
const instanceId = ProviderInstanceId.make("cursor");
const turnId = TurnId.make("turn-recovery");

function session(input: {
  readonly status: ProviderSession["status"];
  readonly activeTurnId?: TurnId;
}): ProviderSession {
  return {
    provider: ProviderDriverKind.make("cursor"),
    providerInstanceId: instanceId,
    threadId,
    runtimeMode: "full-access",
    status: input.status,
    ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:01.000Z",
  };
}

function runningThread(
  overrides: Partial<
    Pick<OrchestrationThread, "session" | "archivedAt" | "snoozedAt" | "snoozedUntil" | "deletedAt">
  > = {},
): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-recovery"),
    title: "Recovery",
    modelSelection: { instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: "2026-07-26T00:00:00.000Z",
      startedAt: "2026-07-26T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:02.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "running",
      providerName: "cursor",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: "2026-07-26T00:00:02.000Z",
    },
    ...overrides,
  };
}

describe("OrphanTurnReconciler liveness matching", () => {
  it("treats Cursor ready with the exact active turn as healthy", () => {
    const candidate: RecoveryCandidate = {
      threadId,
      providerInstanceId: instanceId,
      equalityKey: "concrete",
      bindingServerBootId: "boot-current",
      turnStartedAt: "2026-07-26T00:00:00.000Z",
      target: {
        kind: "turn",
        turnId,
        retrySourceMessageId: null,
        expectedSession: {
          kind: "present",
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-07-26T00:00:00.000Z",
          providerName: "cursor",
          providerInstanceId: instanceId,
        },
      },
    };
    expect(
      isRecoveryCandidateMatch(candidate, {
        state: "present",
        threadId,
        session: session({ status: "ready", activeTurnId: turnId }),
      }),
    ).toBe(true);
    expect(
      isRecoveryCandidateMatch(candidate, {
        state: "present",
        threadId,
        session: session({ status: "ready", activeTurnId: TurnId.make("new-turn") }),
      }),
    ).toBe(false);
  });

  it("immediately classifies missing and different boot bindings without excluding hidden or null-session threads", () => {
    for (const thread of [
      runningThread({ archivedAt: "2026-07-26T00:00:03.000Z" }),
      runningThread({
        snoozedAt: "2026-07-26T00:00:03.000Z",
        snoozedUntil: "2026-07-27T00:00:00.000Z",
      }),
      runningThread({ deletedAt: "2026-07-26T00:00:03.000Z" }),
      runningThread({ session: null }),
    ]) {
      const missingBoot = recoveryCandidateForThread(thread);
      expect(missingBoot).toBeDefined();
      if (missingBoot === undefined) continue;
      expect(isPriorBootRecoveryCandidate(missingBoot, "boot-current")).toBe(true);
      expect(
        isPriorBootRecoveryCandidate(
          { ...missingBoot, bindingServerBootId: "boot-previous" },
          "boot-current",
        ),
      ).toBe(true);
      expect(
        isPriorBootRecoveryCandidate(
          { ...missingBoot, bindingServerBootId: "boot-current" },
          "boot-current",
        ),
      ).toBe(false);
    }
  });

  it("selects the latest persisted target activity inside the start/detection bounds", () => {
    const candidate = recoveryCandidateForThread(runningThread(), "boot-current");
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(
      latestEligibleRecoveryObservation(
        candidate,
        [
          "2026-07-26T00:00:00.500Z",
          "2026-07-26T00:00:01.500Z",
          "2026-07-26T00:00:02.500Z",
          "2026-07-26T00:00:04.000Z",
        ],
        "2026-07-26T00:00:03.000Z",
      ),
    ).toBe("2026-07-26T00:00:02.500Z");
  });

  it("reports unresolved startup candidates explicitly", () => {
    expect(startupReconciliationResult(0)).toEqual({ status: "settled" });
    expect(startupReconciliationResult(3)).toEqual({
      status: "unresolved",
      candidateCount: 3,
    });
  });

  it("matches a pending start only to connecting or ready with no active turn", () => {
    const candidate: RecoveryCandidate = {
      threadId,
      providerInstanceId: instanceId,
      equalityKey: "pending",
      bindingServerBootId: "boot-current",
      turnStartedAt: null,
      target: {
        kind: "pendingStart",
        pendingMessageId: MessageId.make("message-pending"),
        deliveryId: "delivery-pending",
        sourceEventId: EventId.make("event-pending"),
        expectedSession: { kind: "absent" },
      },
    };
    expect(
      isRecoveryCandidateMatch(candidate, {
        state: "present",
        threadId,
        session: session({ status: "connecting" }),
      }),
    ).toBe(true);
    expect(
      isRecoveryCandidateMatch(candidate, {
        state: "present",
        threadId,
        session: session({ status: "running", activeTurnId: turnId }),
      }),
    ).toBe(false);
    expect(isRecoveryCandidateMatch(candidate, { state: "absent", threadId })).toBe(false);
  });
});
