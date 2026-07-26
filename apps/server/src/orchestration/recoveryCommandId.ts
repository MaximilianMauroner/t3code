import {
  CommandId,
  type OrchestrationRecoveryReason,
  type OrchestrationRecoveryTarget,
  type ThreadId,
} from "@t3tools/contracts";

function expectedSessionToken(target: OrchestrationRecoveryTarget): string {
  const expected = target.expectedSession;
  if (expected.kind === "absent") return "session:absent";
  return [
    "session:present",
    expected.status,
    expected.activeTurnId ?? "none",
    expected.updatedAt,
    expected.providerName ?? "none",
    expected.providerInstanceId ?? "none",
  ].join(":");
}

/** Stable across observers, distinct across boot and equality-token changes. */
export function recoveryCommandId(input: {
  readonly threadId: ThreadId;
  readonly target: OrchestrationRecoveryTarget;
  readonly serverBootId: string;
  readonly reason: OrchestrationRecoveryReason;
}): CommandId {
  const targetToken =
    input.target.kind === "turn"
      ? `turn:${input.target.turnId}`
      : `pending:${input.target.pendingMessageId}:${input.target.deliveryId}:${input.target.sourceEventId}`;
  return CommandId.make(
    [
      "recovery-v1",
      input.threadId,
      targetToken,
      expectedSessionToken(input.target),
      input.serverBootId,
      input.reason,
    ].join("|"),
  );
}
