import {
  resolveThreadRecoveryRetrySource,
  threadRecoveryEvidence,
} from "@t3tools/client-runtime/state/threads";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationThread,
} from "@t3tools/contracts";

export type ThreadRecoveryPresentation = {
  readonly title: string;
  readonly message: string;
  readonly detectedAt: string | null;
  readonly executionLastObservedAt: string | null;
  readonly timestampFallback: boolean;
};

export type ThreadRecoveryRetry =
  | {
      readonly kind: "available";
      readonly sourceMessageId: MessageId;
      readonly text: string;
      readonly attachments: ReadonlyArray<{
        readonly attachment: ChatAttachment;
        readonly url: string;
      }>;
      readonly sourceProposedPlan: OrchestrationLatestTurn["sourceProposedPlan"];
    }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "not-interrupted"
        | "missing-source-id"
        | "source-message-missing"
        | "attachment-unavailable";
    };

const interruptionMessages: Readonly<Record<string, string>> = {
  server_restart: "The server restarted while this turn was running.",
  provider_exit: "The provider stopped unexpectedly while this turn was running.",
  provider_state_mismatch: "The provider no longer reported this turn as active.",
  server_shutdown: "The server shut down before this turn finished.",
};

function hasHealthyActiveTurn(thread: OrchestrationThread): boolean {
  return (
    thread.session?.activeTurnId !== null &&
    thread.session?.activeTurnId !== undefined &&
    (thread.session.status === "running" || thread.session.status === "ready")
  );
}

export function buildThreadRecoveryPresentation(
  thread: OrchestrationThread,
): ThreadRecoveryPresentation | null {
  const evidence = threadRecoveryEvidence(thread);
  if (evidence?.kind === "start-interrupted") {
    return {
      title: "Turn start interrupted",
      message: "The turn could not finish starting. No work is still running.",
      detectedAt: evidence.detectedAt,
      executionLastObservedAt: null,
      timestampFallback: true,
    };
  }

  if (evidence?.kind === "turn-interrupted") {
    const detectedAt = evidence.turn.interruptionDetectedAt ?? null;
    const executionLastObservedAt = evidence.turn.executionLastObservedAt ?? null;
    return {
      title: "Turn interrupted",
      message:
        interruptionMessages[evidence.turn.interruptionCode ?? ""] ??
        "This turn was interrupted before it finished.",
      detectedAt,
      executionLastObservedAt,
      timestampFallback:
        evidence.turn.interruptionTimestampFallback === true ||
        executionLastObservedAt === null ||
        (detectedAt !== null && executionLastObservedAt === detectedAt),
    };
  }

  if (hasHealthyActiveTurn(thread)) {
    return null;
  }

  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted") {
    return {
      title: "Turn interrupted",
      message: "This turn was interrupted before it finished.",
      detectedAt: thread.latestTurn?.interruptionDetectedAt ?? null,
      executionLastObservedAt: thread.latestTurn?.executionLastObservedAt ?? null,
      timestampFallback: thread.latestTurn?.interruptionTimestampFallback === true,
    };
  }

  return null;
}

export function resolveThreadRecoveryRetry(
  thread: OrchestrationThread,
  attachmentUrlById: ReadonlyMap<string, string>,
): ThreadRecoveryRetry {
  const source = resolveThreadRecoveryRetrySource(thread);
  if (source.kind === "unavailable") {
    return source;
  }

  const attachments: Array<{ readonly attachment: ChatAttachment; readonly url: string }> = [];
  for (const attachment of source.attachments) {
    const url = attachmentUrlById.get(attachment.id);
    if (url === undefined) {
      return { kind: "unavailable", reason: "attachment-unavailable" };
    }
    attachments.push({ attachment, url });
  }

  return {
    kind: "available",
    sourceMessageId: source.sourceMessageId,
    text: source.text,
    attachments,
    sourceProposedPlan: source.sourceProposedPlan,
  };
}

export function recoveryRetryUnavailableMessage(
  reason: Extract<ThreadRecoveryRetry, { readonly kind: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "missing-source-id":
      return "Retry is unavailable because the original prompt was not recorded.";
    case "source-message-missing":
      return "Retry is unavailable because the original prompt is no longer in this thread.";
    case "attachment-unavailable":
      return "Retry is unavailable until every original attachment can be loaded.";
    case "not-interrupted":
      return "Retry is unavailable because this interruption has no exact retry evidence.";
  }
}
