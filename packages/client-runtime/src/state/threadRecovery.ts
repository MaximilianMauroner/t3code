import type {
  ChatAttachment,
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationThread,
} from "@t3tools/contracts";

export type ThreadRecoveryEvidence =
  | {
      readonly kind: "turn-interrupted";
      readonly turn: OrchestrationLatestTurn;
    }
  | {
      readonly kind: "start-interrupted";
      readonly detectedAt: string;
    };

export type ThreadRecoveryRetrySource =
  | {
      readonly kind: "available";
      readonly sourceMessageId: MessageId;
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      readonly sourceProposedPlan: OrchestrationLatestTurn["sourceProposedPlan"];
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "not-interrupted" | "missing-source-id" | "source-message-missing";
    };

function latestTurnActivityAt(turn: OrchestrationLatestTurn): string {
  return [
    turn.requestedAt,
    turn.startedAt,
    turn.completedAt,
    turn.interruptionDetectedAt,
    turn.executionLastObservedAt,
  ].reduce<string>(
    (latest, timestamp) =>
      timestamp !== null && timestamp !== undefined && timestamp > latest ? timestamp : latest,
    turn.requestedAt,
  );
}

function pendingMessageId(activity: OrchestrationThread["activities"][number]): string | null {
  const payload = activity.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("pendingMessageId" in payload) ||
    typeof payload.pendingMessageId !== "string"
  ) {
    return null;
  }
  return payload.pendingMessageId;
}

/**
 * Returns only server-projected recovery evidence. Runtime status alone is not
 * enough to classify a turn as interrupted (notably, Cursor can be ready while
 * it still owns an active turn).
 */
export function threadRecoveryEvidence(thread: OrchestrationThread): ThreadRecoveryEvidence | null {
  const hasHealthyActiveTurn =
    thread.session?.activeTurnId !== null &&
    thread.session?.activeTurnId !== undefined &&
    (thread.session.status === "running" || thread.session.status === "ready");
  if (hasHealthyActiveTurn) {
    return null;
  }

  const latestTurn = thread.latestTurn;
  const interruptedTurn =
    latestTurn?.state === "interrupted" &&
    latestTurn.interruptionCode !== undefined &&
    latestTurn.interruptionCode !== null
      ? latestTurn
      : null;

  const startInterruption = thread.activities.findLast(
    (activity) => activity.kind === "session.start.interrupted" && activity.turnId === null,
  );
  if (startInterruption === undefined) {
    return interruptedTurn === null ? null : { kind: "turn-interrupted", turn: interruptedTurn };
  }

  const sourceMessageId = pendingMessageId(startInterruption);
  const supersededByTurn =
    latestTurn !== null && latestTurnActivityAt(latestTurn) >= startInterruption.createdAt;
  const supersededByPendingRetry = thread.messages.some(
    (message) =>
      message.role === "user" &&
      message.turnId === null &&
      message.id !== sourceMessageId &&
      message.createdAt >= startInterruption.createdAt,
  );
  const supersededBySession =
    thread.session !== null &&
    thread.session.activeTurnId === null &&
    (thread.session.updatedAt > startInterruption.createdAt ||
      (thread.session.updatedAt === startInterruption.createdAt &&
        thread.session.status !== "interrupted"));
  const startIsCurrent = !supersededByTurn && !supersededByPendingRetry && !supersededBySession;

  if (
    interruptedTurn !== null &&
    (!startIsCurrent || latestTurnActivityAt(interruptedTurn) >= startInterruption.createdAt)
  ) {
    return { kind: "turn-interrupted", turn: interruptedTurn };
  }
  if (!startIsCurrent) return null;

  return { kind: "start-interrupted", detectedAt: startInterruption.createdAt };
}

/**
 * Resolves the exact original prompt selected by the server recovery event.
 * It never falls back to a newer user message. Attachment descriptors are
 * retained so a client surface can hydrate their bytes using its existing
 * attachment pipeline before dispatching the retry.
 */
export function resolveThreadRecoveryRetrySource(
  thread: OrchestrationThread,
): ThreadRecoveryRetrySource {
  if (thread.latestTurn?.state !== "interrupted") {
    return { kind: "unavailable", reason: "not-interrupted" };
  }
  const sourceMessageId = thread.latestTurn.retrySourceMessageId;
  if (sourceMessageId === undefined || sourceMessageId === null) {
    return { kind: "unavailable", reason: "missing-source-id" };
  }
  const source = findUserMessage(thread.messages, sourceMessageId);
  if (source === undefined) {
    return { kind: "unavailable", reason: "source-message-missing" };
  }

  return {
    kind: "available",
    sourceMessageId,
    text: source.text,
    attachments: [...(source.attachments ?? [])],
    sourceProposedPlan: thread.latestTurn.sourceProposedPlan,
  };
}

function findUserMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  return messages.find((message) => message.id === messageId && message.role === "user");
}
