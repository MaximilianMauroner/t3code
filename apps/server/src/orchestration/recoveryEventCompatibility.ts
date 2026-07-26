import type { OrchestrationEvent } from "@t3tools/contracts";

/**
 * Converts recovery-only event variants for clients that did not opt in.
 * Event envelope identity and ordering metadata are deliberately unchanged.
 */
export function downconvertRecoveryEventForLegacyClient(
  event: OrchestrationEvent,
): OrchestrationEvent {
  switch (event.type) {
    case "thread.session-interrupted":
      return {
        ...event,
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          createdAt: event.payload.detectedAt,
        },
      };
    case "thread.session-start-interrupted":
      return {
        ...event,
        type: "thread.activity-appended",
        payload: {
          threadId: event.payload.threadId,
          activity: {
            id: event.eventId,
            tone: "error",
            kind: "session.start.interrupted",
            summary: "Turn start was interrupted before a provider session was established.",
            payload: event.payload,
            turnId: null,
            sequence: event.sequence,
            createdAt: event.payload.detectedAt,
          },
        },
      };
    default:
      return event;
  }
}
