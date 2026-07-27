import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OrchestrationEvent,
  OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

import { OrchestrationReactorDeliveriesLive } from "../../persistence/Layers/OrchestrationReactorDeliveries.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NewOrchestrationReactorDelivery,
  OrchestrationReactorDeliveries,
  type OrchestrationReactorDeliveriesShape,
} from "../../persistence/Services/OrchestrationReactorDeliveries.ts";
import { ServerBootIdentity } from "../../serverBootId.ts";
import type { ProviderLivenessSample } from "../../provider/Services/ProviderAdapter.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { planReactorDelivery } from "../reactorDeliveries.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { OrchestrationDeliveryRuntime } from "../Services/OrchestrationDeliveryRuntime.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { OrchestrationDeliveryRuntimeLive } from "./OrchestrationDeliveryRuntime.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";

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

function runtimeModeEvent(sequence: number, eventId: string) {
  return decodeEvent({
    ...eventBase(sequence, eventId),
    type: "thread.runtime-mode-set",
    payload: { threadId, runtimeMode: "approval-required", updatedAt: now },
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

function activeProviderSample(): ProviderLivenessSample {
  return {
    state: "present",
    threadId,
    session: {
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "full-access",
      threadId,
      activeTurnId: TurnId.make("turn-1"),
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe("OrchestrationDeliveryRuntime", () => {
  function createLayer(input: {
    readonly providerDeliver: ProviderCommandReactor["Service"]["deliver"];
    readonly checkpointDeliver?: CheckpointReactor["Service"]["deliver"];
    readonly dispatchInternal?: OrchestrationEngineService["Service"]["dispatchInternal"];
    readonly closeExternalAdmission?: OrchestrationEngineService["Service"]["closeExternalAdmission"];
    readonly blockExternalHotAdmission?: OrchestrationEngineService["Service"]["blockExternalHotAdmission"];
    readonly releaseExternalHotAdmissionBlocker?: OrchestrationEngineService["Service"]["releaseExternalHotAdmissionBlocker"];
    readonly thread?: ReturnType<typeof absentSessionThread>;
    readonly getThread?: () => OrchestrationThread | undefined;
    readonly inspectTarget?: NonNullable<ProviderService["Service"]["inspectTarget"]>;
    readonly transformRepository?: (
      repository: OrchestrationReactorDeliveriesShape,
    ) => OrchestrationReactorDeliveriesShape;
  }) {
    const baseRepositoryLayer = OrchestrationReactorDeliveriesLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const repositoryLayer = input.transformRepository
      ? Layer.effect(
          OrchestrationReactorDeliveries,
          Effect.map(OrchestrationReactorDeliveries, input.transformRepository),
        ).pipe(Layer.provide(baseRepositoryLayer))
      : baseRepositoryLayer;
    const engineLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.map(OrchestrationReactorDeliveries, (repository) => {
        const dispatchInternal: OrchestrationEngineShape["dispatchInternal"] = (command) => {
          const pendingStartRecovery =
            command.type === "thread.session.interrupt-if-active" &&
            command.target.kind === "pendingStart"
              ? {
                  target: command.target,
                  detectedAt: command.detectedAt,
                }
              : null;
          return (input.dispatchInternal ?? (() => Effect.succeed({ sequence: 1 })))(command).pipe(
            Effect.tap(() =>
              pendingStartRecovery === null
                ? Effect.void
                : repository
                    .markCancelled(
                      pendingStartRecovery.target.deliveryId,
                      pendingStartRecovery.detectedAt,
                      pendingStartRecovery.target.expectedDeliveryOwnership.status === "delivering"
                        ? pendingStartRecovery.target.expectedDeliveryOwnership.claimToken
                        : undefined,
                    )
                    .pipe(Effect.orDie),
            ),
          );
        };
        return {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.die("unused"),
          dispatchExternal: () => Effect.die("unused"),
          dispatchInternal,
          closeExternalAdmission: input.closeExternalAdmission ?? Effect.void,
          openExternalAdmission: Effect.void,
          blockExternalHotAdmission: input.blockExternalHotAdmission ?? (() => Effect.void),
          releaseExternalHotAdmissionBlocker:
            input.releaseExternalHotAdmissionBlocker ?? (() => Effect.void),
          reserveExternalHotAdmission: () => Effect.die("unused"),
          barrier: Effect.die("unused"),
          sealAndStop: Effect.void,
          forceStop: Effect.void,
          awaitStopped: Effect.void,
          isSealed: Effect.succeed(false),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngineShape;
      }),
    ).pipe(Layer.provide(repositoryLayer));
    const layer = OrchestrationDeliveryRuntimeLive.pipe(
      Layer.provideMerge(repositoryLayer),
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () =>
            Effect.succeed(Option.fromUndefinedOr(input.getThread?.() ?? input.thread)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProviderService)({
          inspectTarget:
            input.inspectTarget ??
            (() =>
              Effect.succeed({
                state: "absent",
                threadId,
              } satisfies ProviderLivenessSample)),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderCommandReactor, {
          start: () => Effect.void,
          drain: Effect.void,
          quiesceAndDrain: Effect.void,
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
      const first = deliveryFor(checkpointEvent(1, "event-1"), "current-boot");
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

  effectIt.effect("replays a committed runtime-mode delivery exactly once", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.succeed("delivered" as const),
      );
      const delivery = deliveryFor(runtimeModeEvent(1, "runtime-mode"), "current-boot");
      const status = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        yield* repository.insert(delivery);
        yield* runtime.drain;
        yield* runtime.drain;
        return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
      }).pipe(Effect.provide(createLayer({ providerDeliver })));

      expect(delivery.deliveryKind).toBe("runtime-mode-change");
      expect(providerDeliver).toHaveBeenCalledTimes(1);
      expect(status).toBe("delivered");
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
          yield* deliveryRuntime.drain;
          expect(providerDeliver).toHaveBeenCalledTimes(1);
          yield* TestClock.adjust("1 second");
          yield* deliveryRuntime.drain;
          expect(providerDeliver).toHaveBeenCalledTimes(2);
          yield* TestClock.adjust("5 seconds");
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

  effectIt.effect("waits through bounded startup retries without overtaking a predecessor", () =>
    Effect.gen(function* () {
      const observed: string[] = [];
      let poisonAttempts = 0;
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>((delivery) =>
        Effect.sync(() => {
          observed.push(delivery.deliveryId);
          if (delivery.sourceSequence === 1 && poisonAttempts++ < 2) {
            throw new Error("transient startup failure");
          }
          return "delivered" as const;
        }),
      );
      const predecessor = deliveryFor(sessionStopEvent(1, "startup-retry"), "prior-boot");
      const follower = deliveryFor(sessionStopEvent(2, "startup-follower"), "prior-boot");

      const readiness = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(predecessor);
        yield* repository.insert(follower);
        const recovery = yield* runtime.recoverStartup.pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(recovery);
        return yield* runtime.inspectReadiness;
      }).pipe(Effect.provide(createLayer({ providerDeliver })));

      expect(observed).toEqual([
        predecessor.deliveryId,
        predecessor.deliveryId,
        predecessor.deliveryId,
        follower.deliveryId,
      ]);
      expect(readiness.counts.total).toBe(0);
    }),
  );

  effectIt.effect("keeps startup closed when a poison delivery exhausts its retry budget", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.fail("poison"),
      );
      const delivery = deliveryFor(sessionStopEvent(1, "startup-poison"), "prior-boot");
      const exit = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        const recovery = yield* runtime.recoverStartup.pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("5 seconds");
        return yield* Effect.exit(Fiber.join(recovery));
      }).pipe(Effect.provide(createLayer({ providerDeliver })));

      expect(exit._tag).toBe("Failure");
      expect(providerDeliver).toHaveBeenCalledTimes(3);
    }),
  );

  effectIt.effect("fails closed when the next retry exceeds the startup time budget", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.succeed("delivered" as const),
      );
      const base = deliveryFor(sessionStopEvent(1, "startup-budget"), "prior-boot");
      const currentTime = yield* DateTime.now;
      const delayed = decodeNewDelivery({
        ...base,
        nextAttemptAt: DateTime.formatIso(DateTime.add(currentTime, { minutes: 1 })),
      });
      const exit = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delayed);
        return yield* Effect.exit(runtime.recoverStartup);
      }).pipe(Effect.provide(createLayer({ providerDeliver })));

      expect(exit._tag).toBe("Failure");
      expect(providerDeliver).not.toHaveBeenCalled();
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
            expectedDeliveryOwnership: {
              status: "delivering",
              claimToken: expect.any(String),
            },
          }),
        }),
      );
      expect(status).toBe("cancelled");
    }),
  );

  effectIt.effect(
    "never replays an uncertain checkpoint rollback after restart and persists evidence",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.succeed("delivered" as const),
        );
        const checkpointDeliver = vi.fn<CheckpointReactor["Service"]["deliver"]>(() =>
          Effect.succeed("delivered" as const),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        const delivery = deliveryFor(checkpointEvent(1, "checkpoint-crash"), "prior-boot");
        const status = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* runtime.drain;
          yield* runtime.drain;
          return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
        }).pipe(
          Effect.provide(createLayer({ providerDeliver, checkpointDeliver, dispatchInternal })),
        );

        expect(checkpointDeliver).not.toHaveBeenCalled();
        expect(dispatchInternal).toHaveBeenCalledTimes(1);
        expect(dispatchInternal).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.activity.append",
            commandId: CommandId.make(`delivery:${delivery.deliveryId}:recovery-evidence`),
          }),
        );
        expect(status).toBe("cancelled");
      }),
  );

  effectIt.effect("does not retry checkpoint rollback after an uncertain same-boot failure", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.succeed("delivered" as const),
      );
      const checkpointDeliver = vi.fn<CheckpointReactor["Service"]["deliver"]>(() =>
        Effect.fail("crashed after provider rollback"),
      );
      const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
        () => Effect.succeed({ sequence: 2 }),
      );
      const delivery = deliveryFor(checkpointEvent(1, "checkpoint-uncertain"), "current-boot");
      const status = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        yield* runtime.drain;
        yield* TestClock.adjust("1 hour");
        yield* runtime.drain;
        return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
      }).pipe(
        Effect.provide(createLayer({ providerDeliver, checkpointDeliver, dispatchInternal })),
      );

      expect(checkpointDeliver).toHaveBeenCalledTimes(1);
      expect(status).toBe("cancelled");
    }),
  );

  effectIt.effect(
    "cancels a current-boot uncertain turn start against its exact pending target",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.succeed("delivered" as const),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        const delivery = decodeNewDelivery({
          ...deliveryFor(turnStartEvent(1, "current-boot-uncertain"), "current-boot"),
          executionStartedAt: now,
        });
        const status = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* runtime.drain;
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
            reason: "provider-state-mismatch",
            interruptionCode: "provider_state_mismatch",
            target: expect.objectContaining({
              kind: "pendingStart",
              pendingMessageId: MessageId.make("message-1"),
              deliveryId: delivery.deliveryId,
              sourceEventId: delivery.sourceEventId,
              expectedSession: { kind: "absent" },
              expectedDeliveryOwnership: {
                status: "delivering",
                claimToken: expect.any(String),
              },
            }),
          }),
        );
        expect(status).toBe("cancelled");
      }),
  );

  effectIt.effect(
    "retains an uncertain turn start while successful provider execution is ahead of ingestion",
    () =>
      Effect.gen(function* () {
        const barrier = yield* Deferred.make<ProviderLivenessSample>();
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.succeed("delivered" as const),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        let thread: OrchestrationThread = absentSessionThread();
        let failTerminalUpdate = true;
        const delivery = deliveryFor(turnStartEvent(1, "ingestion-lags"), "current-boot");

        const result = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          const drainFiber = yield* runtime.drain.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const whileLagging = Option.getOrThrow(
            yield* repository.getById(delivery.deliveryId),
          ).status;
          thread = activeSessionThread();
          yield* Deferred.succeed(barrier, activeProviderSample());
          yield* Fiber.join(drainFiber);
          return {
            whileLagging,
            final: Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status,
          };
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              dispatchInternal,
              getThread: () => thread,
              inspectTarget: () => Deferred.await(barrier),
              transformRepository: (repository) => ({
                ...repository,
                markDelivered: (...args) => {
                  if (failTerminalUpdate) {
                    failTerminalUpdate = false;
                    return Effect.die("injected terminal update failure");
                  }
                  return repository.markDelivered(...args);
                },
              }),
            }),
          ),
        );

        expect(result.whileLagging).toBe("delivering");
        expect(result.final).toBe("delivered");
        expect(dispatchInternal).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect("reclassifies a stale pending CAS as the exact concrete active turn", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.fail("provider completion became uncertain"),
      );
      let thread: OrchestrationThread = absentSessionThread();
      let probes = 0;
      const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
        () =>
          Effect.sync(() => {
            thread = activeSessionThread();
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: "thread.session.interrupt-if-active",
                  detail: "Recovery target no longer matches the projected session.",
                }),
              ),
            ),
          ),
      );
      const delivery = deliveryFor(turnStartEvent(1, "stale-pending-cas"), "current-boot");
      const status = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        yield* runtime.drain;
        return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
      }).pipe(
        Effect.provide(
          createLayer({
            providerDeliver,
            dispatchInternal,
            getThread: () => thread,
            inspectTarget: () =>
              Effect.sync(() => {
                probes += 1;
                return probes === 1
                  ? ({ state: "absent", threadId } satisfies ProviderLivenessSample)
                  : activeProviderSample();
              }),
          }),
        ),
      );

      expect(dispatchInternal).toHaveBeenCalledTimes(1);
      expect(probes).toBe(2);
      expect(status).toBe("delivered");
    }),
  );

  effectIt.effect(
    "settles a barrier-proven missing provider against the exact concrete active turn",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.succeed("delivered" as const),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        const delivery = decodeNewDelivery({
          ...deliveryFor(turnStartEvent(1, "concrete-provider-missing"), "current-boot"),
          executionStartedAt: now,
        });
        const status = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* runtime.drain;
          return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              dispatchInternal,
              thread: activeSessionThread(),
              inspectTarget: () => Effect.succeed({ state: "absent", threadId }),
            }),
          ),
        );

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
              }),
            }),
          }),
        );
        expect(status).toBe("cancelled");
      }),
  );

  effectIt.effect("keeps an uncertain turn start non-terminal when liveness is unavailable", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.fail("provider completion became uncertain"),
      );
      const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
        () => Effect.succeed({ sequence: 2 }),
      );
      const delivery = deliveryFor(turnStartEvent(1, "liveness-unavailable"), "current-boot");
      const result = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        yield* runtime.drain;
        return {
          row: Option.getOrThrow(yield* repository.getById(delivery.deliveryId)),
          readiness: yield* runtime.inspectReadiness,
        };
      }).pipe(
        Effect.provide(
          createLayer({
            providerDeliver,
            dispatchInternal,
            thread: absentSessionThread(),
            inspectTarget: () =>
              Effect.succeed({ state: "unknown", reason: "unavailable" } as const),
          }),
        ),
      );

      expect(result.row).toMatchObject({
        status: "pending",
        executionStartedAt: expect.any(String),
        nextAttemptAt: expect.any(String),
      });
      expect(result.readiness.counts.pending).toBe(1);
      expect(dispatchInternal).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    "keeps an uncertain turn start non-terminal when its ingestion barrier times out",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.fail("provider completion became uncertain"),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        const delivery = deliveryFor(turnStartEvent(1, "liveness-timeout"), "current-boot");
        const status = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          const drainFiber = yield* runtime.drain.pipe(Effect.forkChild);
          yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(drainFiber);
          return Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status;
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              dispatchInternal,
              thread: absentSessionThread(),
              inspectTarget: () => Effect.never,
            }),
          ),
        );

        expect(status).toBe("pending");
        expect(dispatchInternal).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect(
    "keeps repeated unknown execution blocking until barrier-confirmed atomic settlement",
    () =>
      Effect.gen(function* () {
        const blockExternalHotAdmission = vi.fn((_: string) => Effect.void);
        const releaseExternalHotAdmissionBlocker = vi.fn((_: string) => Effect.void);
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.fail("provider completion became uncertain"),
        );
        let sampleCount = 0;
        const delivery = deliveryFor(turnStartEvent(1, "repeated-unknown"), "current-boot");
        const row = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* runtime.drain;
          yield* TestClock.adjust("1 second");
          yield* runtime.drain;
          yield* TestClock.adjust("1 second");
          yield* runtime.drain;
          return Option.getOrThrow(yield* repository.getById(delivery.deliveryId));
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              thread: absentSessionThread(),
              blockExternalHotAdmission,
              releaseExternalHotAdmissionBlocker,
              inspectTarget: () =>
                Effect.sync(() => {
                  sampleCount += 1;
                  return sampleCount < 3
                    ? ({ state: "unknown", reason: "unavailable" } as const)
                    : ({ state: "absent", threadId } as const);
                }),
            }),
          ),
        );

        expect(row.status).toBe("cancelled");
        expect(blockExternalHotAdmission).toHaveBeenCalledTimes(2);
        expect(blockExternalHotAdmission).toHaveBeenNthCalledWith(1, delivery.deliveryId);
        expect(blockExternalHotAdmission).toHaveBeenNthCalledWith(2, delivery.deliveryId);
        expect(releaseExternalHotAdmissionBlocker).toHaveBeenCalledOnce();
        expect(releaseExternalHotAdmissionBlocker).toHaveBeenCalledWith(delivery.deliveryId);
      }),
  );

  effectIt.effect("reopens admission when another atomic path terminalizes a blocker", () =>
    Effect.gen(function* () {
      const releaseExternalHotAdmissionBlocker = vi.fn((_: string) => Effect.void);
      const delivery = deliveryFor(turnStartEvent(1, "external-settlement"), "current-boot");
      const result = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        yield* runtime.drain;
        const deferred = Option.getOrThrow(yield* repository.getById(delivery.deliveryId));
        yield* repository.markCancelled(delivery.deliveryId, "2026-01-01T00:00:02.000Z");
        yield* runtime.drain;
        return deferred;
      }).pipe(
        Effect.provide(
          createLayer({
            providerDeliver: () => Effect.fail("provider completion became uncertain"),
            thread: absentSessionThread(),
            inspectTarget: () =>
              Effect.succeed({ state: "unknown", reason: "unavailable" } as const),
            releaseExternalHotAdmissionBlocker,
          }),
        ),
      );

      expect(result.status).toBe("pending");
      expect(result.executionStartedAt).toEqual(expect.any(String));
      expect(releaseExternalHotAdmissionBlocker).toHaveBeenCalledOnce();
      expect(releaseExternalHotAdmissionBlocker).toHaveBeenCalledWith(delivery.deliveryId);
    }),
  );

  effectIt.effect(
    "does not terminalize an exact pending start until its conditional recovery commits",
    () =>
      Effect.gen(function* () {
        const recoveryCommitted = yield* Deferred.make<void>();
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.fail("provider completion became uncertain"),
        );
        const delivery = deliveryFor(turnStartEvent(1, "pending-commit-barrier"), "current-boot");
        const result = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          const drainFiber = yield* runtime.drain.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const beforeCommit = Option.getOrThrow(
            yield* repository.getById(delivery.deliveryId),
          ).status;
          yield* Deferred.succeed(recoveryCommitted, undefined);
          yield* Fiber.join(drainFiber);
          return {
            beforeCommit,
            afterCommit: Option.getOrThrow(yield* repository.getById(delivery.deliveryId)).status,
          };
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              thread: absentSessionThread(),
              inspectTarget: () => Effect.succeed({ state: "absent", threadId }),
              dispatchInternal: () =>
                Deferred.await(recoveryCommitted).pipe(Effect.as({ sequence: 2 })),
            }),
          ),
        );

        expect(result.beforeCommit).toBe("delivering");
        expect(result.afterCommit).toBe("cancelled");
      }),
  );

  effectIt.effect(
    "does not depend on a second terminal update after atomic pending recovery commits",
    () =>
      Effect.gen(function* () {
        let terminalUpdates = 0;
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.fail("provider completion became uncertain"),
        );
        const delivery = deliveryFor(turnStartEvent(1, "atomic-recovery"), "current-boot");
        const row = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* runtime.drain;
          return Option.getOrThrow(yield* repository.getById(delivery.deliveryId));
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              thread: absentSessionThread(),
              inspectTarget: () => Effect.succeed({ state: "absent", threadId }),
              transformRepository: (repository) => ({
                ...repository,
                markCancelled: (...args) => {
                  terminalUpdates += 1;
                  return terminalUpdates === 1
                    ? repository.markCancelled(...args)
                    : Effect.die(
                        "injected failure after recovery commit before obsolete outer update",
                      );
                },
              }),
            }),
          ),
        );

        expect(row.status).toBe("cancelled");
        expect(terminalUpdates).toBe(1);
      }),
  );

  effectIt.effect(
    "suppresses replay when an external effect succeeds but its terminal row update fails",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.succeed("delivered" as const),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        let failTerminalUpdate = true;
        const delivery = deliveryFor(turnStartEvent(1, "terminal-update-failure"), "current-boot");
        const result = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* runtime.recoverStartup;
          return {
            row: Option.getOrThrow(yield* repository.getById(delivery.deliveryId)),
            readiness: yield* runtime.inspectReadiness,
          };
        }).pipe(
          Effect.provide(
            createLayer({
              providerDeliver,
              dispatchInternal,
              thread: absentSessionThread(),
              transformRepository: (repository) => ({
                ...repository,
                markDelivered: (...args) => {
                  if (failTerminalUpdate) {
                    failTerminalUpdate = false;
                    return Effect.die("injected terminal update failure");
                  }
                  return repository.markDelivered(...args);
                },
              }),
            }),
          ),
        );

        expect(providerDeliver).toHaveBeenCalledTimes(1);
        expect(dispatchInternal).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.session.interrupt-if-active",
            reason: "provider-state-mismatch",
            target: expect.objectContaining({
              kind: "pendingStart",
              deliveryId: delivery.deliveryId,
              sourceEventId: delivery.sourceEventId,
            }),
          }),
        );
        expect(result.row).toMatchObject({
          status: "cancelled",
          executionStartedAt: expect.any(String),
        });
        expect(result.readiness.counts.total).toBe(0);
      }),
  );

  effectIt.effect(
    "recovers an exact pending start when provider delivery fails after marking",
    () =>
      Effect.gen(function* () {
        const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
          Effect.fail("provider failed after execution marker"),
        );
        const dispatchInternal = vi.fn<OrchestrationEngineService["Service"]["dispatchInternal"]>(
          () => Effect.succeed({ sequence: 2 }),
        );
        const delivery = deliveryFor(
          turnStartEvent(1, "provider-failure-after-marker"),
          "current-boot",
        );
        const status = yield* Effect.gen(function* () {
          const repository = yield* OrchestrationReactorDeliveries;
          const runtime = yield* OrchestrationDeliveryRuntime;
          yield* repository.insert(delivery);
          yield* runtime.drain;
          yield* runtime.drain;
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

        expect(providerDeliver).toHaveBeenCalledTimes(1);
        expect(dispatchInternal).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.session.interrupt-if-active",
            reason: "provider-state-mismatch",
            interruptionCode: "provider_state_mismatch",
            target: expect.objectContaining({
              kind: "pendingStart",
              pendingMessageId: MessageId.make("message-1"),
              deliveryId: delivery.deliveryId,
              sourceEventId: delivery.sourceEventId,
              expectedSession: { kind: "absent" },
              expectedDeliveryOwnership: {
                status: "delivering",
                claimToken: expect.any(String),
              },
            }),
          }),
        );
        expect(status).toBe("cancelled");
      }),
  );

  effectIt.effect("retries a provably pre-execution marker failure during startup", () =>
    Effect.gen(function* () {
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.succeed("delivered" as const),
      );
      let failMarker = true;
      const delivery = deliveryFor(turnStartEvent(1, "pre-execution-failure"), "current-boot");
      const readiness = yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        const recovery = yield* runtime.recoverStartup.pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(recovery);
        return yield* runtime.inspectReadiness;
      }).pipe(
        Effect.provide(
          createLayer({
            providerDeliver,
            transformRepository: (repository) => ({
              ...repository,
              markExecutionStarted: (...args) => {
                if (failMarker) {
                  failMarker = false;
                  return Effect.die("injected pre-execution marker failure");
                }
                return repository.markExecutionStarted(...args);
              },
            }),
          }),
        ),
      );

      expect(providerDeliver).toHaveBeenCalledTimes(1);
      expect(readiness.counts.total).toBe(0);
    }),
  );

  effectIt.effect("closes hot admission immediately when same-boot work dead-letters", () =>
    Effect.gen(function* () {
      let closed = 0;
      const providerDeliver = vi.fn<ProviderCommandReactor["Service"]["deliver"]>(() =>
        Effect.fail("poison"),
      );
      const delivery = deliveryFor(sessionStopEvent(1, "same-boot-poison"), "current-boot");
      yield* Effect.gen(function* () {
        const repository = yield* OrchestrationReactorDeliveries;
        const runtime = yield* OrchestrationDeliveryRuntime;
        yield* repository.insert(delivery);
        yield* runtime.drain;
        yield* TestClock.adjust("1 second");
        yield* runtime.drain;
        yield* TestClock.adjust("5 seconds");
        yield* runtime.drain;
      }).pipe(
        Effect.provide(
          createLayer({
            providerDeliver,
            closeExternalAdmission: Effect.sync(() => {
              closed += 1;
            }),
          }),
        ),
      );
      expect(closed).toBe(1);
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
