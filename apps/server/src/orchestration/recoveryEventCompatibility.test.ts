import { CommandId, EventId, ThreadId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { downconvertRecoveryEventForLegacyClient } from "./recoveryEventCompatibility.ts";

it("downconverts recovery events without changing envelope identity or ordering", () => {
  const recovery: OrchestrationEvent = {
    sequence: 42,
    eventId: EventId.make("event-42"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-07-26T00:00:03.000Z",
    commandId: CommandId.make("command-42"),
    causationEventId: EventId.make("event-41"),
    correlationId: CommandId.make("command-root"),
    metadata: {},
    type: "thread.session-interrupted",
    payload: {
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      interruptionCode: "server_restart",
      reason: "server-restarted",
      detectedAt: "2026-07-26T00:00:03.000Z",
      timestampFallback: true,
      retrySourceMessageId: null,
      serverBootId: "boot-2",
    },
  };
  const legacy = downconvertRecoveryEventForLegacyClient(recovery);
  expect(legacy.type).toBe("thread.turn-interrupt-requested");
  expect({
    sequence: legacy.sequence,
    eventId: legacy.eventId,
    commandId: legacy.commandId,
    occurredAt: legacy.occurredAt,
    causationEventId: legacy.causationEventId,
    correlationId: legacy.correlationId,
  }).toEqual({
    sequence: recovery.sequence,
    eventId: recovery.eventId,
    commandId: recovery.commandId,
    occurredAt: recovery.occurredAt,
    causationEventId: recovery.causationEventId,
    correlationId: recovery.correlationId,
  });
});
