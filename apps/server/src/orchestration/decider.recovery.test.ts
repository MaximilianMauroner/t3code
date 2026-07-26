import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSessionInterruptedPayload,
  ThreadSessionStartInterruptedPayload,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand, type PendingTurnStartCommandState } from "./decider.ts";

const STARTED = "2026-07-26T00:00:00.000Z";
const UPDATED = "2026-07-26T00:00:01.000Z";
const OBSERVED = "2026-07-26T00:00:02.000Z";
const DETECTED = "2026-07-26T00:00:03.000Z";
const decodeInterruptedPayload = Schema.decodeUnknownEffect(ThreadSessionInterruptedPayload);
const decodeStartInterruptedPayload = Schema.decodeUnknownEffect(
  ThreadSessionStartInterruptedPayload,
);

function readModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 4,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Recovery",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: STARTED,
          startedAt: STARTED,
          completedAt: null,
          assistantMessageId: null,
        },
        createdAt: STARTED,
        updatedAt: UPDATED,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: UPDATED,
        },
      },
    ],
    updatedAt: UPDATED,
  };
}

it.layer(NodeServices.layer)("recovery decider", (it) => {
  it.effect("conditionally interrupts exactly the matching concrete turn", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "thread.session.interrupt-if-active",
          commandId: CommandId.make("recovery-1"),
          threadId: ThreadId.make("thread-1"),
          target: {
            kind: "turn",
            turnId: TurnId.make("turn-1"),
            retrySourceMessageId: MessageId.make("message-1"),
            expectedSession: {
              kind: "present",
              status: "running",
              activeTurnId: TurnId.make("turn-1"),
              updatedAt: UPDATED,
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          },
          reason: "server-restarted",
          interruptionCode: "server_restart",
          serverBootId: "boot-2",
          detectedAt: DETECTED,
          executionLastObservedAt: OBSERVED,
          createdAt: DETECTED,
        },
      });
      expect("type" in event).toBe(true);
      if ("type" in event && event.type === "thread.session-interrupted") {
        const payload = yield* decodeInterruptedPayload(event.payload);
        expect(payload.turnId).toBe("turn-1");
        expect(payload.executionLastObservedAt).toBe(OBSERVED);
        expect(payload.timestampFallback).toBe(false);
        expect(payload.retrySourceMessageId).toBe("message-1");
      }
    }),
  );

  it.effect("marks recovery time as a fallback when persisted evidence is unavailable", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "thread.session.interrupt-if-active",
          commandId: CommandId.make("recovery-no-evidence"),
          threadId: ThreadId.make("thread-1"),
          target: {
            kind: "turn",
            turnId: TurnId.make("turn-1"),
            retrySourceMessageId: null,
            expectedSession: {
              kind: "present",
              status: "running",
              activeTurnId: TurnId.make("turn-1"),
              updatedAt: UPDATED,
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          },
          reason: "provider-exited",
          interruptionCode: "provider_exit",
          serverBootId: "boot-2",
          detectedAt: DETECTED,
          createdAt: DETECTED,
        },
      });
      if ("type" in event && event.type === "thread.session-interrupted" && "payload" in event) {
        const payload = yield* decodeInterruptedPayload(event.payload);
        expect(payload.executionLastObservedAt).toBeUndefined();
        expect(payload.timestampFallback).toBe(true);
      }
    }),
  );

  it.effect("rejects changed session equality predicates without an event", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "thread.session.interrupt-if-active",
          commandId: CommandId.make("recovery-stale"),
          threadId: ThreadId.make("thread-1"),
          target: {
            kind: "turn",
            turnId: TurnId.make("turn-1"),
            retrySourceMessageId: null,
            expectedSession: {
              kind: "present",
              status: "running",
              activeTurnId: TurnId.make("turn-1"),
              updatedAt: "2026-07-26T00:00:09.000Z",
              providerName: "codex",
            },
          },
          reason: "provider-exited",
          interruptionCode: "provider_exit",
          serverBootId: "boot-2",
          detectedAt: DETECTED,
          createdAt: DETECTED,
        },
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("matches an absent-session pending start without fabricating a turn", () =>
    Effect.gen(function* () {
      const model = readModel();
      const thread = model.threads[0]!;
      const pendingModel: OrchestrationReadModel = {
        ...model,
        threads: [{ ...thread, session: null, latestTurn: null }],
      };
      const event = yield* decideOrchestrationCommand({
        readModel: pendingModel,
        pendingTurnStart: {
          messageId: "message-1",
          deliveryId: "delivery-1",
          sourceEventId: "event-1",
        },
        command: {
          type: "thread.session.interrupt-if-active",
          commandId: CommandId.make("recovery-pending"),
          threadId: ThreadId.make("thread-1"),
          target: {
            kind: "pendingStart",
            pendingMessageId: MessageId.make("message-1"),
            deliveryId: "delivery-1",
            sourceEventId: EventId.make("event-1"),
            expectedSession: { kind: "absent" },
          },
          reason: "server-restarted",
          interruptionCode: "server_restart",
          serverBootId: "boot-2",
          detectedAt: DETECTED,
          createdAt: DETECTED,
        },
      });
      expect("type" in event).toBe(true);
      if ("type" in event) {
        expect(event.type).toBe("thread.session-start-interrupted");
        if (event.type === "thread.session-start-interrupted" && "payload" in event) {
          const payload = yield* decodeStartInterruptedPayload(event.payload);
          expect(payload.expectedSession).toEqual({ kind: "absent" });
        }
      }
    }),
  );

  it.effect("matches a pending start against an exact present session", () =>
    Effect.gen(function* () {
      const model = readModel();
      const thread = model.threads[0]!;
      const pendingModel: OrchestrationReadModel = {
        ...model,
        threads: [{ ...thread, latestTurn: null }],
      };
      const event = yield* decideOrchestrationCommand({
        readModel: pendingModel,
        pendingTurnStart: {
          messageId: "message-1",
          deliveryId: "delivery-1",
          sourceEventId: "event-1",
        },
        command: {
          type: "thread.session.interrupt-if-active",
          commandId: CommandId.make("recovery-pending-present"),
          threadId: ThreadId.make("thread-1"),
          target: {
            kind: "pendingStart",
            pendingMessageId: MessageId.make("message-1"),
            deliveryId: "delivery-1",
            sourceEventId: EventId.make("event-1"),
            expectedSession: {
              kind: "present",
              status: "running",
              activeTurnId: TurnId.make("turn-1"),
              updatedAt: UPDATED,
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          },
          reason: "server-restarted",
          interruptionCode: "server_restart",
          serverBootId: "boot-2",
          detectedAt: DETECTED,
          createdAt: DETECTED,
        },
      });
      expect("type" in event && event.type).toBe("thread.session-start-interrupted");
      if (
        "type" in event &&
        event.type === "thread.session-start-interrupted" &&
        "payload" in event
      ) {
        const payload = yield* decodeStartInterruptedPayload(event.payload);
        expect(payload.expectedSession).toEqual({
          kind: "present",
          status: "running",
          activeTurnId: "turn-1",
          updatedAt: UPDATED,
          providerName: "codex",
          providerInstanceId: "codex",
        });
      }
    }),
  );

  it.effect("rejects a replaced or historically incomplete durable pending start", () =>
    Effect.gen(function* () {
      const model = readModel();
      const thread = model.threads[0]!;
      const pendingModel: OrchestrationReadModel = {
        ...model,
        threads: [{ ...thread, session: null, latestTurn: null }],
      };
      const command = {
        type: "thread.session.interrupt-if-active" as const,
        commandId: CommandId.make("recovery-pending-stale"),
        threadId: ThreadId.make("thread-1"),
        target: {
          kind: "pendingStart" as const,
          pendingMessageId: MessageId.make("message-1"),
          deliveryId: "delivery-1",
          sourceEventId: EventId.make("event-1"),
          expectedSession: { kind: "absent" as const },
        },
        reason: "server-restarted" as const,
        interruptionCode: "server_restart" as const,
        serverBootId: "boot-2",
        detectedAt: DETECTED,
        createdAt: DETECTED,
      };
      const staleStates = [
        null,
        { messageId: "message-2", deliveryId: "delivery-1", sourceEventId: "event-1" },
        { messageId: "message-1", deliveryId: "delivery-2", sourceEventId: "event-1" },
        { messageId: "message-1", deliveryId: "delivery-1", sourceEventId: "event-2" },
        { messageId: "message-1" },
      ] satisfies ReadonlyArray<PendingTurnStartCommandState | null>;

      for (const pendingTurnStart of staleStates) {
        const error = yield* decideOrchestrationCommand({
          readModel: pendingModel,
          pendingTurnStart,
          command,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          detail: "Recovery target no longer matches the durable pending turn start.",
        });
      }

      const missingLookupError = yield* decideOrchestrationCommand({
        readModel: pendingModel,
        command,
      }).pipe(Effect.flip);
      expect(missingLookupError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
