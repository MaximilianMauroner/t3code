import {
  resolveThreadRecoveryRetrySource,
  threadRecoveryEvidence,
  type ThreadRecoveryRetrySource,
} from "@t3tools/client-runtime/state/threads";
import type { OrchestrationThread } from "@t3tools/contracts";

export interface ThreadRecoveryPresentation {
  readonly kind: "turn-interrupted" | "start-interrupted" | "stale-runtime";
  readonly title: string;
  readonly detail: string;
  readonly executionLastObservedAt: string | null;
  readonly detectedAt: string;
  readonly retry: ThreadRecoveryRetrySource;
}

function hasHealthyActiveTurn(thread: OrchestrationThread): boolean {
  return (
    thread.session?.activeTurnId !== null &&
    thread.session?.activeTurnId !== undefined &&
    (thread.session.status === "running" || thread.session.status === "ready")
  );
}

function interruptionDetail(code: string | null | undefined): string {
  switch (code) {
    case "server_restart":
      return "The server restarted before this turn finished.";
    case "provider_exit":
      return "The provider exited before this turn finished.";
    case "provider_state_mismatch":
      return "The provider no longer reports this turn as active.";
    case "server_shutdown":
      return "The server shut down before this turn finished.";
    default: {
      const normalized = code?.toLowerCase() ?? "";
      if (normalized.includes("cancel")) {
        return "This turn was cancelled while it was being recovered.";
      }
      if (normalized.includes("recover")) {
        return "Recovery stopped this turn before it finished.";
      }
      return "This turn stopped before it produced a final response.";
    }
  }
}

export function resolveThreadRecoveryPresentation(
  thread: OrchestrationThread,
): ThreadRecoveryPresentation | null {
  if (hasHealthyActiveTurn(thread)) {
    return null;
  }

  const evidence = threadRecoveryEvidence(thread);
  if (evidence?.kind === "turn-interrupted") {
    const detectedAt =
      evidence.turn.interruptionDetectedAt ?? evidence.turn.completedAt ?? thread.updatedAt;
    return {
      kind: "turn-interrupted",
      title: "Turn interrupted",
      detail: interruptionDetail(evidence.turn.interruptionCode),
      executionLastObservedAt: evidence.turn.executionLastObservedAt ?? null,
      detectedAt,
      retry: resolveThreadRecoveryRetrySource(thread),
    };
  }
  if (evidence?.kind === "start-interrupted") {
    return {
      kind: "start-interrupted",
      title: "Turn start interrupted",
      detail: "The turn could not start, but your original message is still in the conversation.",
      executionLastObservedAt: null,
      detectedAt: evidence.detectedAt,
      retry: { kind: "unavailable", reason: "not-interrupted" },
    };
  }

  // Legacy servers down-convert a recovered turn to the older interrupt
  // event, which intentionally carries no reason or retry-source fields.
  if (thread.latestTurn?.state === "interrupted") {
    return {
      kind: "turn-interrupted",
      title: "Turn interrupted",
      detail: interruptionDetail(null),
      executionLastObservedAt: thread.latestTurn.executionLastObservedAt ?? null,
      detectedAt: thread.latestTurn.completedAt ?? thread.updatedAt,
      retry: resolveThreadRecoveryRetrySource(thread),
    };
  }

  const latestTurn = thread.latestTurn;
  const session = thread.session;
  const terminalOrDetachedSession =
    session !== null &&
    (session.status === "idle" ||
      session.status === "interrupted" ||
      session.status === "stopped" ||
      session.status === "error" ||
      (session.status === "ready" && session.activeTurnId === null) ||
      (session.activeTurnId !== null && session.activeTurnId !== latestTurn?.turnId));
  if (latestTurn?.state === "running" && session !== null && terminalOrDetachedSession) {
    return {
      kind: "stale-runtime",
      title: "Turn status is catching up",
      detail:
        "The thread still reports work in progress, but its provider session is no longer attached to this turn.",
      executionLastObservedAt: latestTurn.completedAt,
      detectedAt: session.updatedAt,
      retry: { kind: "unavailable", reason: "not-interrupted" },
    };
  }

  return null;
}

export function recoveryRetryUnavailableDetail(
  reason: Extract<ThreadRecoveryRetrySource, { readonly kind: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "missing-source-id":
      return "Retry is unavailable because this interruption did not record its original message.";
    case "source-message-missing":
      return "Retry is unavailable because the original message is no longer in this thread.";
    case "not-interrupted":
      return "Retry is unavailable for this interruption.";
  }
}
