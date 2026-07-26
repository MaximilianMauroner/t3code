import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isRecoveryCandidateMatch, type RecoveryCandidate } from "./OrphanTurnReconciler.ts";

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

describe("OrphanTurnReconciler liveness matching", () => {
  it("treats Cursor ready with the exact active turn as healthy", () => {
    const candidate: RecoveryCandidate = {
      threadId,
      providerInstanceId: instanceId,
      equalityKey: "concrete",
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

  it("matches a pending start only to connecting or ready with no active turn", () => {
    const candidate: RecoveryCandidate = {
      threadId,
      providerInstanceId: instanceId,
      equalityKey: "pending",
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
