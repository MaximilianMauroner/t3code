import type {
  DispatchableClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand, OrchestrationNotReadyError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationReactorDeliveries } from "../../persistence/Services/OrchestrationReactorDeliveries.ts";
import { OrchestrationReactorDeliveriesLive } from "../../persistence/Layers/OrchestrationReactorDeliveries.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationHotAdmissionReservation,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  UpdateMaintenanceGate,
  type UpdateDispatchAcceptance,
  type UpdateDispatchReservation,
} from "../UpdateMaintenanceGate.ts";
import { planReactorDelivery } from "../reactorDeliveries.ts";
import { classifyExternalCommand } from "../externalCommandClassification.ts";
import { ServerBootIdentity } from "../../serverBootId.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  readonly _tag: "command";
  command: OrchestrationCommand;
  maintenanceAcceptance: UpdateDispatchAcceptance;
  maintenanceReservation: UpdateDispatchReservation | null;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

interface BarrierEnvelope {
  readonly _tag: "barrier";
  readonly result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
}
interface StopEnvelope {
  readonly _tag: "stop";
  readonly completed: Deferred.Deferred<void>;
}

type EngineEnvelope = CommandEnvelope | BarrierEnvelope | StopEnvelope;

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const maintenanceGate = yield* UpdateMaintenanceGate;
  const reactorDeliveries = yield* OrchestrationReactorDeliveries;
  const projectionTurns = yield* ProjectionTurnRepository;
  const serverBootId = (yield* ServerBootIdentity).id;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<EngineEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const admissionLock = yield* Semaphore.make(1);
  let sealed = false;
  let externalAdmissionClosed = true;
  let nextReservationId = 0;
  const activeReservationIds = new Set<number>();
  let reservationsDrained = yield* Deferred.make<void>();
  yield* Deferred.succeed(reservationsDrained, undefined);
  const activeBootstrapMaintenanceReservations = new Set<UpdateDispatchReservation>();
  const pendingCommands = new Set<CommandEnvelope>();
  const pendingBarriers = new Set<BarrierEnvelope>();
  const pendingStops = new Set<StopEnvelope>();

  const withMaintenanceAdmission = <A, E, R>(
    envelope: CommandEnvelope,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | OrchestrationCommandInvariantError, R> =>
    envelope.maintenanceReservation === null
      ? maintenanceGate.withDispatchAllowed(
          envelope.command,
          envelope.maintenanceAcceptance,
          effect,
        )
      : envelope.maintenanceReservation.withDispatchAllowed(envelope.command, effect);

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        if (!sealed) yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const committedCommand = yield* withMaintenanceAdmission(
          envelope,
          Effect.gen(function* () {
            const committed = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const pendingTurnStart =
                    envelope.command.type === "thread.session.interrupt-if-active" &&
                    envelope.command.target.kind === "pendingStart"
                      ? yield* projectionTurns
                          .getPendingTurnStartByThreadId({
                            threadId: envelope.command.threadId,
                          })
                          .pipe(
                            Effect.map(
                              Option.match({
                                onNone: () => null,
                                onSome: (pending) => {
                                  const deliveryId = pending.pendingDeliveryId;
                                  const sourceEventId = pending.pendingEventId;
                                  return {
                                    messageId: pending.messageId,
                                    ...(deliveryId !== undefined && deliveryId !== null
                                      ? { deliveryId }
                                      : {}),
                                    ...(sourceEventId !== undefined && sourceEventId !== null
                                      ? { sourceEventId }
                                      : {}),
                                  };
                                },
                              }),
                            ),
                          )
                      : undefined;
                  const eventBase = yield* decideOrchestrationCommand({
                    command: envelope.command,
                    readModel: commandReadModel,
                    ...(pendingTurnStart !== undefined ? { pendingTurnStart } : {}),
                  }).pipe(
                    Effect.provideService(Crypto.Crypto, crypto),
                    Effect.mapError((cause) =>
                      isOrchestrationCommandInvariantError(cause)
                        ? cause
                        : new OrchestrationCommandInvariantError({
                            commandType: envelope.command.type,
                            detail: "Failed to generate an event identifier.",
                            cause,
                          }),
                    ),
                  );
                  const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
                  const committedEvents: OrchestrationEvent[] = [];
                  let nextCommandReadModel = commandReadModel;

                  for (const nextEvent of eventBases) {
                    if (
                      envelope.command.type === "thread.session.interrupt-if-active" &&
                      envelope.command.target.kind === "pendingStart"
                    ) {
                      const delivery = yield* reactorDeliveries.getById(
                        envelope.command.target.deliveryId,
                      );
                      if (
                        Option.isNone(delivery) ||
                        delivery.value.sourceEventId !== envelope.command.target.sourceEventId ||
                        delivery.value.threadId !== envelope.command.threadId ||
                        (delivery.value.status !== "pending" &&
                          delivery.value.status !== "delivering")
                      ) {
                        return yield* new OrchestrationCommandInvariantError({
                          commandType: envelope.command.type,
                          detail:
                            "Recovery start delivery no longer matches pending durable state.",
                        });
                      }
                    }
                    const savedEvent = yield* eventStore.append(nextEvent);
                    nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                    yield* projectionPipeline.projectEvent(savedEvent);
                    const plannedDelivery = planReactorDelivery(savedEvent, serverBootId);
                    if (plannedDelivery !== null) {
                      yield* reactorDeliveries.insert(plannedDelivery);
                    }
                    committedEvents.push(savedEvent);
                  }

                  const lastSavedEvent = committedEvents.at(-1) ?? null;
                  if (lastSavedEvent === null) {
                    return yield* new OrchestrationCommandInvariantError({
                      commandType: envelope.command.type,
                      detail: "Command produced no events.",
                    });
                  }

                  yield* commandReceiptRepository.upsert({
                    commandId: envelope.command.commandId,
                    aggregateKind: lastSavedEvent.aggregateKind,
                    aggregateId: lastSavedEvent.aggregateId,
                    acceptedAt: lastSavedEvent.occurredAt,
                    resultSequence: lastSavedEvent.sequence,
                    status: "accepted",
                    error: null,
                  });

                  return {
                    committedEvents,
                    lastSequence: lastSavedEvent.sequence,
                    nextCommandReadModel,
                  } as const;
                }),
              )
              .pipe(
                Effect.catchTag("SqlError", (sqlError) =>
                  Effect.fail(
                    toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(
                      sqlError,
                    ),
                  ),
                ),
              );
            commandReadModel = committed.nextCommandReadModel;
            return committed;
          }),
        );

        for (const [index, event] of committedCommand.committedEvents.entries()) {
          if (!sealed) yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (
              isOrchestrationCommandInvariantError(error) &&
              envelope.command.type !== "thread.session.interrupt-if-active"
            ) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          pendingCommands.delete(envelope);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) =>
        envelope._tag === "command"
          ? processEnvelope(envelope)
          : envelope._tag === "barrier"
            ? Deferred.succeed(envelope.result, {
                sequence: commandReadModel.snapshotSequence,
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    pendingBarriers.delete(envelope);
                  }),
                ),
              )
            : Deferred.succeed(envelope.completed, undefined).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    pendingStops.delete(envelope);
                  }),
                ),
                Effect.andThen(Effect.interrupt),
              ),
      ),
    ),
  );
  const workerFiber = yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const enqueueCommand = (command: OrchestrationCommand, externalEffect: "hot" | "pure" | null) =>
    Effect.gen(function* () {
      const result = yield* admissionLock.withPermits(1)(
        Effect.gen(function* () {
          if (sealed) {
            return yield* new OrchestrationNotReadyError({
              message: "Orchestration engine is sealed.",
              retryable: false,
              retryAfterMs: 0,
              phase: "sealed",
            });
          }
          if (externalEffect !== null && externalAdmissionClosed && externalEffect === "hot") {
            return yield* new OrchestrationNotReadyError({
              message: "Orchestration is quiescing.",
              retryable: true,
              retryAfterMs: 1_000,
              phase: "quiescing",
            });
          }
          const maintenanceAcceptance = yield* maintenanceGate.ensureDispatchAllowed(command);
          const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
          const envelope = {
            _tag: "command",
            command,
            maintenanceAcceptance,
            maintenanceReservation: null,
            result,
            startedAtMs: yield* Clock.currentTimeMillis,
          } satisfies CommandEnvelope;
          pendingCommands.add(envelope);
          yield* Queue.offer(commandQueue, envelope);
          return result;
        }),
      );
      return yield* Deferred.await(result);
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => enqueueCommand(command, null);
  const dispatchExternal: OrchestrationEngineShape["dispatchExternal"] = (
    command: DispatchableClientOrchestrationCommand,
  ) => enqueueCommand(command, classifyExternalCommand(command));
  const dispatchInternal: OrchestrationEngineShape["dispatchInternal"] = (command) =>
    enqueueCommand(command, null);

  const releaseReservation = (reservationId: number) =>
    Effect.gen(function* () {
      if (!activeReservationIds.delete(reservationId)) return;
      if (activeReservationIds.size === 0) {
        yield* Deferred.succeed(reservationsDrained, undefined);
      }
    });

  const reserveExternalHotAdmission: OrchestrationEngineShape["reserveExternalHotAdmission"] = (
    reservedCommand,
  ) =>
    Effect.gen(function* () {
      if (classifyExternalCommand(reservedCommand) !== "hot") {
        return yield* new OrchestrationNotReadyError({
          message: "Bootstrap reservation only accepts hot commands.",
          retryable: false,
          retryAfterMs: 0,
          phase: "quiescing",
        });
      }
      const reservationId = yield* admissionLock.withPermits(1)(
        Effect.gen(function* () {
          if (sealed || externalAdmissionClosed) {
            return yield* new OrchestrationNotReadyError({
              message: sealed ? "Orchestration engine is sealed." : "Orchestration is quiescing.",
              retryable: !sealed,
              retryAfterMs: sealed ? 0 : 1_000,
              phase: sealed ? "sealed" : "quiescing",
            });
          }
          if (activeReservationIds.size === 0) {
            reservationsDrained = yield* Deferred.make<void>();
          }
          const reservationId = nextReservationId++;
          activeReservationIds.add(reservationId);
          return reservationId;
        }),
      );

      const maintenanceReservation = yield* maintenanceGate
        .reserveDispatchAllowed(reservedCommand)
        .pipe(
          Effect.tapError(() => admissionLock.withPermits(1)(releaseReservation(reservationId))),
        );
      activeBootstrapMaintenanceReservations.add(maintenanceReservation);

      const cancel = admissionLock
        .withPermits(1)(releaseReservation(reservationId))
        .pipe(
          Effect.andThen(
            Effect.sync(() => {
              activeBootstrapMaintenanceReservations.delete(maintenanceReservation);
            }),
          ),
          Effect.andThen(maintenanceReservation.cancel),
        );
      if (sealed || !activeReservationIds.has(reservationId)) {
        yield* cancel;
        return yield* new OrchestrationNotReadyError({
          message: "Bootstrap admission reservation is no longer active.",
          retryable: false,
          retryAfterMs: 0,
          phase: "sealed",
        });
      }

      const dispatch: OrchestrationHotAdmissionReservation["dispatch"] = (command) =>
        Effect.gen(function* () {
          const result = yield* admissionLock.withPermits(1)(
            Effect.gen(function* () {
              if (!activeReservationIds.has(reservationId)) {
                return yield* new OrchestrationNotReadyError({
                  message: "Bootstrap admission reservation is no longer active.",
                  retryable: false,
                  retryAfterMs: 0,
                  phase: sealed ? "sealed" : "quiescing",
                });
              }
              if (sealed) {
                yield* releaseReservation(reservationId);
                return yield* new OrchestrationNotReadyError({
                  message: "Orchestration engine is sealed.",
                  retryable: false,
                  retryAfterMs: 0,
                  phase: "sealed",
                });
              }
              if (classifyExternalCommand(command) !== "hot") {
                yield* releaseReservation(reservationId);
                return yield* new OrchestrationNotReadyError({
                  message: "Bootstrap reservation only accepts hot commands.",
                  retryable: false,
                  retryAfterMs: 0,
                  phase: "quiescing",
                });
              }
              const deferred = yield* Deferred.make<
                { sequence: number },
                OrchestrationDispatchError
              >();
              const envelope = {
                _tag: "command",
                command,
                maintenanceAcceptance: { generation: 0 },
                maintenanceReservation,
                result: deferred,
                startedAtMs: yield* Clock.currentTimeMillis,
              } satisfies CommandEnvelope;
              pendingCommands.add(envelope);
              activeBootstrapMaintenanceReservations.delete(maintenanceReservation);
              yield* Queue.offer(commandQueue, envelope);
              yield* releaseReservation(reservationId);
              return deferred;
            }),
          );
          return yield* Deferred.await(result);
        });
      return { dispatch, cancel } satisfies OrchestrationHotAdmissionReservation;
    });
  const closeExternalAdmission: OrchestrationEngineShape["closeExternalAdmission"] =
    admissionLock.withPermits(1)(
      Effect.sync(() => {
        externalAdmissionClosed = true;
      }),
    );
  const openExternalAdmission: OrchestrationEngineShape["openExternalAdmission"] =
    admissionLock.withPermits(1)(
      Effect.sync(() => {
        if (!sealed) externalAdmissionClosed = false;
      }),
    );
  const barrier: OrchestrationEngineShape["barrier"] = Effect.gen(function* () {
    const pendingReservations = yield* admissionLock.withPermits(1)(
      Effect.succeed(reservationsDrained),
    );
    yield* Deferred.await(pendingReservations);
    const result = yield* admissionLock.withPermits(1)(
      Effect.gen(function* () {
        if (sealed) {
          return yield* new OrchestrationNotReadyError({
            message: "Orchestration engine is sealed.",
            retryable: false,
            retryAfterMs: 0,
            phase: "sealed",
          });
        }
        const deferred = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
        const envelope = { _tag: "barrier", result: deferred } satisfies BarrierEnvelope;
        pendingBarriers.add(envelope);
        yield* Queue.offer(commandQueue, envelope);
        return deferred;
      }),
    );
    return yield* Deferred.await(result);
  });
  const sealAndStop: OrchestrationEngineShape["sealAndStop"] = Effect.gen(function* () {
    const completed = yield* admissionLock.withPermits(1)(
      Effect.gen(function* () {
        if (sealed) return null;
        sealed = true;
        externalAdmissionClosed = true;
        const deferred = yield* Deferred.make<void>();
        const envelope = { _tag: "stop", completed: deferred } satisfies StopEnvelope;
        pendingStops.add(envelope);
        yield* Queue.offer(commandQueue, envelope);
        return deferred;
      }),
    );
    if (completed === null) return;
    yield* Deferred.await(completed);
    yield* Fiber.interrupt(workerFiber).pipe(Effect.ignore);
    yield* Queue.shutdown(commandQueue);
    yield* PubSub.shutdown(eventPubSub);
  });
  const forceStop: OrchestrationEngineShape["forceStop"] = Effect.gen(function* () {
    const snapshot = yield* Effect.sync(() => {
      sealed = true;
      externalAdmissionClosed = true;
      activeReservationIds.clear();
      const pending = {
        commands: [...pendingCommands],
        barriers: [...pendingBarriers],
        stops: [...pendingStops],
        maintenanceReservations: new Set([
          ...activeBootstrapMaintenanceReservations,
          ...[...pendingCommands].flatMap((envelope) =>
            envelope.maintenanceReservation === null ? [] : [envelope.maintenanceReservation],
          ),
        ]),
      };
      workerFiber.interruptUnsafe();
      return pending;
    });
    yield* Deferred.succeed(reservationsDrained, undefined);
    const forceError = new OrchestrationNotReadyError({
      message: "Orchestration engine was force-stopped.",
      retryable: false,
      retryAfterMs: 0,
      phase: "sealed",
    });
    yield* Effect.forEach(snapshot.commands, (envelope) =>
      Deferred.fail(envelope.result, forceError),
    );
    yield* Effect.forEach(snapshot.barriers, (envelope) =>
      Deferred.fail(envelope.result, forceError),
    );
    yield* Effect.forEach(snapshot.stops, (envelope) =>
      Deferred.succeed(envelope.completed, undefined),
    );
    yield* Effect.forEach(snapshot.maintenanceReservations, (reservation) => reservation.cancel);
    yield* Queue.shutdown(commandQueue);
    yield* PubSub.shutdown(eventPubSub);
  }).pipe(Effect.uninterruptible);

  return {
    readEvents,
    dispatch,
    dispatchExternal,
    dispatchInternal,
    reserveExternalHotAdmission,
    closeExternalAdmission,
    openExternalAdmission,
    barrier,
    sealAndStop,
    forceStop,
    isSealed: Effect.sync(() => sealed),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineCoreLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(
  Layer.provide(OrchestrationReactorDeliveriesLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);

export const OrchestrationEngineLive = OrchestrationEngineCoreLive.pipe(
  Layer.provide(ServerBootIdentity.layer),
);
