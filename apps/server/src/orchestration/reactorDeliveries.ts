import {
  type OrchestrationEvent,
  OrchestrationReactorDeliveryKind,
  OrchestrationReactorDeliveryReplayPolicy,
  ThreadId,
} from "@t3tools/contracts";
import type { NewOrchestrationReactorDelivery } from "../persistence/Services/OrchestrationReactorDeliveries.ts";

export function deliveryIdForEvent(
  event: Pick<OrchestrationEvent, "eventId">,
  kind: OrchestrationReactorDeliveryKind,
): string {
  return `orchestration:${event.eventId}:${kind}`;
}

function deliveryDescriptor(event: OrchestrationEvent): {
  readonly reactor: string;
  readonly kind: OrchestrationReactorDeliveryKind;
  readonly replayPolicy: OrchestrationReactorDeliveryReplayPolicy;
} | null {
  switch (event.type) {
    case "thread.turn-start-requested":
      return {
        reactor: "provider-command",
        kind: "turn-start",
        replayPolicy: "cancel-with-recovery",
      };
    case "thread.turn-interrupt-requested":
      return {
        reactor: "provider-command",
        kind: "turn-interrupt",
        replayPolicy: "cancel-with-recovery",
      };
    case "thread.approval-response-requested":
      return {
        reactor: "provider-command",
        kind: "approval-response",
        replayPolicy: "cancel-with-recovery",
      };
    case "thread.user-input-response-requested":
      return {
        reactor: "provider-command",
        kind: "user-input-response",
        replayPolicy: "cancel-with-recovery",
      };
    case "thread.checkpoint-revert-requested":
      return {
        reactor: "checkpoint",
        kind: "checkpoint-revert",
        replayPolicy: "replay-idempotent",
      };
    case "thread.session-stop-requested":
      return {
        reactor: "provider-command",
        kind: "session-stop",
        replayPolicy: "replay-idempotent",
      };
    case "thread.archived":
      return {
        reactor: "archive-cleanup",
        kind: "archive-cleanup",
        replayPolicy: "replay-idempotent",
      };
    case "thread.deleted":
      return {
        reactor: "thread-deletion",
        kind: "thread-delete",
        replayPolicy: "replay-idempotent",
      };
    default:
      return null;
  }
}

export function planReactorDelivery(
  event: OrchestrationEvent,
  sourceBootId: string,
): NewOrchestrationReactorDelivery | null {
  const descriptor = deliveryDescriptor(event);
  if (descriptor === null || event.aggregateKind !== "thread") return null;
  return {
    deliveryId: deliveryIdForEvent(event, descriptor.kind),
    sourceSequence: event.sequence,
    sourceEventId: event.eventId,
    threadId: ThreadId.make(event.aggregateId),
    reactor: descriptor.reactor,
    deliveryKind: descriptor.kind,
    replayPolicy: descriptor.replayPolicy,
    sourceBootId,
    payload: event,
    commandId: event.commandId,
    createdAt: event.occurredAt,
  };
}
