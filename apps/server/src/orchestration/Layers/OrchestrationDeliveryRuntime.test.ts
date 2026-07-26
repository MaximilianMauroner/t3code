import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OrchestrationEvent,
  OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

import { OrchestrationReactorDeliveriesLive } from "../../persistence/Layers/OrchestrationReactorDeliveries.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NewOrchestrationReactorDelivery,
  OrchestrationReactorDeliveries,
} from "../../persistence/Services/OrchestrationReactorDeliveries.ts";
import { ServerBootIdentity } from "../../serverBootId.ts";
import { planReactorDelivery } from "../reactorDeliveries.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { OrchestrationDeliveryRuntime } from "../Services/OrchestrationDeliveryRuntime.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { OrchestrationDeliveryRuntimeLive } from "./OrchestrationDeliveryRuntime.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const decodeNewDelivery = Schema.decodeUnknownSync(NewOrchestrationReactorDelivery);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

function eventBase(sequence: number, eventId: string) {
  return {
    sequence,
    eventId: EventId.make(eventId),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.make(`command-${eventId}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function sessionStopEvent(sequence: number, eventId: string) {
  return decodeEvent({
    ...eventBase(sequence, eventId),
    type: "thread.session-stop-requested",
    payload: { threadId, createdAt: now },
  });
}

function checkpointEvent(sequence: number, eventId: string) {
  return decodeEvent({
    ...eventBase(sequence, eventId),
    type: "thread.checkpoint-revert-requested",
    payload: { threadId, turnCount: 0, createdAt: now },
  });
}

function turnStartEvent(sequence: number, eventId: string) {
  return decodeEvent({
    ...eventBase(sequence, eventId),
    type: "thread.turn-start-requested",
    payload: {
      threadId,
      messageId: MessageId.make("message-1"),
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    },
  });
}

function turnInterruptEvent(sequence: number, eventId: string) {
  return decodeEvent({
    ...eventBase(sequence, eventId),
    type: "thread.turn-interrupt-requested",
    payload: { threadId, turnId: TurnId.make("turn-1"), createdAt: now },
  });
}

function deliveryFor(event: OrchestrationEvent, sourceBootId: string) {
  const planned = planReactorDelivery(event, sourceBootId);
  if (planned === null) throw new Error(`event ${event.type} has no durable delivery`);
  return decodeNewDelivery(planned);
}

function absentSessionThread() {
  return decodeThread({
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  });
}

function activeSessionThread() {
  return decodeThread({
    ...absentSessionThread(),
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
      retrySourceMessageId: MessageId.make("message-1"),
    },
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-1"),
      lastError: null,
      updatedAt: now,
    },
  });
}

describe("OrchestrationDeliveryRuntime", () => {
  function createLayer(input: {
    readonly providerDeliver: ProviderCommandReactor["Service"]["deliver"];
    readonly checkpointDeliver?: CheckpointReactor["Service"]["deliver"];
    readonly dispatchInternal?: OrchestrationEngineService["Service"]["dispatchInternal"];
    readonly thread?: ReturnType<typeof absentSessionThread>;
  }) {
    const repositoryLayer = OrchestrationReactorDeliveriesLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = OrchestrationDeliveryRuntimeLive.pipe(
      Layer.provideMerge(repositoryLayer),
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          dispatchInternal: input.dispatchInternal ?? (() => Effect.succeed({ sequence: 1 })),
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => Effect.succeed(Option.fromUndefinedOr(input.thread)),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderCommandReactor, {
          start: () => Effect.void,
          drain: Effect.void,
          deliver: input.providerDeliver,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(CheckpointReactor, {
          start: () => Effect.void,
          drain: Effect.void,
          deliver: input.checkpointDeliver ?? (() => Effect.succeed("delivered" as const)),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ThreadDeletionReactor, {
          start: () => Effect.void,
          drain: Effect.void,
          deliver: () => Effect.succeed("delivered" as const),
        }),
      ),
      Layer.provideMerge(Layer.succeed(ServerBootIdentity, { id: "current-boot" })),
      Layer.provideMerge(NodeServices.layer),
    );
    return layer;
  }

  effectIt.effect("replays desired-state work in global source order and is duplicate-safe", () =>
    Effect.gen(function* () {
      const observed: string[] = [];
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>((delivery) =>
        Effect.sync(() => observed.push(delivery.deliveryKind)).pipe(
          Effect.as("delivered" as const),
        ),
      );
      const checkpointDeliver = vi.fn<CheckpointReactor["Service"]["deliver"]>((delivery) =>
        Effect.sync(() => observed.push(delivery.deliveryKind)).pipe(
          Effect.as("delivered" as const),
        ),
      );
      const first = deliveryFor(checkpointEvent(1, "event-1"), "prior-boot");
      const second = deliveryFor(sessionStopEvent(2, "event-2"), "prior-boot");
      const readiness = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const deliveryRuntime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(second);
        yield* repository.insert(first);
        yield* deliveryRuntime.drain;
        yield* deliveryRuntime.drain;
        return yield* deliveryRuntime.inspectReadiness;
      }).pipe(Effect.provide(createLayer({ providerDeliver, checkpointDeliver })));

      expect(observed).toEqual(["checkpoint-revert", "session-stop"]);
      expect(providerDeliver).toHaveBeenCalledTimes(1);
      expect(checkpointDeliver).toHaveBeenCalledTimes(1);
      expect(readiness.counts.total).toBe(0);
    }),
  );

  effectIt.effect(
    "retains a failed predecessor, dead-letters at the bound, and keeps readiness closed",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.fail("poison"),
        );
        const poison = deliveryFor(sessionStopEvent(1, "event-poison"), "prior-boot");
        const follower = deliveryFor(sessionStopEvent(2, "event-follower"), "prior-boot");
        const { readiness, followerStatus } = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const deliveryRuntime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(poison);
          yield* repository.insert(follower);
          yield* deliveryRuntime.drain;
          return {
            readiness: yield* deliveryRuntime.inspectReadiness,
            followerStatus: Option.getOrThrow(yield* repository.getById(follower.deliveryId))
              .status,
          };
        }).pipe(Effect.provide(createLayer({ providerDeliver })));
        expect(providerDeliver).toHaveBeenCalledTimes(3);
        expect(readiness.counts.deadLetter).toBe(1);
        expect(readiness.counts.pending).toBe(1);
        expect(followerStatus).toBe("pending");
      }),
  );

  effectIt.effect("cancels a prior-boot absent-session start with the exact pending target", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.succeed("delivered" as const),
      );
      const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
        () => Effect.succeed({ sequence: 2 }),
      );
      const delivery = deliveryFor(turnStartEvent(1, "event-start"), "prior-boot");
      const status = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const deliveryRuntime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        yield* deliveryRuntime.drain;
        return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
      }).pipe(
        Effect.provide(
          createLayer({
            providerDeliver,
            dispatchInternal,
            thread: absentSessionThread(),
          }),
        ),
      );

      expect(providerDeliver).not.toHaveBeenCalled();
      expect(dispatchInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.session.interrupt-if-active",
          target: expect.objectContaining({
            kind: "pendingStart",
            pendingMessageId: MessageId.make("message-1"),
            deliveryId: delivery.deliveryId,
            sourceEventId: delivery.sourceEventId,
            expectedSession: { kind: "absent" },
          }),
        }),
      );
      expect(status).toBe("cancelled");
    }),
  );

  effectIt.effect(
    "cancels partially delivered prior-boot execution against the exact active session",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.succeed("delivered" as const),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        const delivery = deliveryFor(turnInterruptEvent(1, "event-interrupt"), "prior-boot");
        const status = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const deliveryRuntime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* deliveryRuntime.drain;
          return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              dispatchInternal,
              thread: activeSessionThread(),
            }),
          ),
        );

        expect(providerDeliver).not.toHaveBeenCalled();
        expect(dispatchInternal).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.session.interrupt-if-active",
            target: expect.objectContaining({
              kind: "turn",
              turnId: TurnId.make("turn-1"),
              retrySourceMessageId: MessageId.make("message-1"),
              expectedSession: expect.objectContaining({
                kind: "present",
                status: "running",
                activeTurnId: TurnId.make("turn-1"),
                updatedAt: now,
              }),
            }),
          }),
        );
        expect(status).toBe("cancelled");
      }),
  );
});
