import {
  CommandId,
  EventId,
  type OrchestrationExpectedSession,
  type OrchestrationRecoveryTarget,
  type OrchestrationSession,
  type OrchestrationThread,
  OrchestrationEvent,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Metric from "effect/Metric";
import {
  metricAttributes,
  orchestrationDeliveryAttemptsTotal,
} from "../../observability/Metrics.ts";

import { OrchestrationReactorDeliveries } from "../../persistence/Services/OrchestrationReactorDeliveries.ts";
import type { OrchestrationReactorDelivery } from "../../persistence/Services/OrchestrationReactorDeliveries.ts";
import type { ProviderLivenessSample } from "../../provider/Services/ProviderAdapter.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerBootIdentity } from "../../serverBootId.ts";
import { recoveryCommandId } from "../recoveryCommandId.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  OrchestrationDeliveryRuntime,
  type OrchestrationDeliveryRuntimeShape,
} from "../Services/OrchestrationDeliveryRuntime.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";

const MAX_DELIVERY_ATTEMPTS = 3;
const CLAIM_LEASE_MINUTES = 5;
const RETRY_BACKOFF_MILLIS = [1_000, 5_000, 30_000] as const;
const STARTUP_RECOVERY_BUDGET_MILLIS = 40_000;
const SAME_BOOT_RECOVERY_RECLASSIFY_LIMIT = 3;
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

function expectedSessionFrom(session: OrchestrationSession): OrchestrationExpectedSession {
  return {
    kind: "present",
    status: session.status,
    activeTurnId: session.activeTurnId,
    updatedAt: session.updatedAt,
    providerName: session.providerName,
    ...(session.providerInstanceId !== undefined
      ? { providerInstanceId: session.providerInstanceId }
      : {}),
  };
}

function providerInstanceFor(thread: OrchestrationThread): ProviderInstanceId {
  return thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
}

function hasMatchingLiveTurn(
  sample: ProviderLivenessSample,
  providerInstanceId: ProviderInstanceId,
  turnId: string,
): boolean {
  return (
    sample.state === "present" &&
    sample.session.providerInstanceId === providerInstanceId &&
    sample.session.activeTurnId === turnId &&
    (sample.session.status === "connecting" ||
      sample.session.status === "ready" ||
      sample.session.status === "running")
  );
}

function hasConflictingLiveTurn(
  sample: ProviderLivenessSample,
  providerInstanceId: ProviderInstanceId,
  turnId: string | null,
): boolean {
  return (
    sample.state === "present" &&
    (sample.session.providerInstanceId !== providerInstanceId ||
      (sample.session.activeTurnId !== undefined &&
        sample.session.activeTurnId !== turnId &&
        (sample.session.status === "connecting" ||
          sample.session.status === "ready" ||
          sample.session.status === "running")))
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const deliveries = yield* OrchestrationReactorDeliveries;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providerReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const deletionReactor = yield* ThreadDeletionReactor;
  const providerService = yield* ProviderService;
  const bootId = (yield* ServerBootIdentity).id;
  const drainLock = yield* Semaphore.make(1);
  const liveSourceEventIds = new Set<string>();
  const uncertainBlockerIds = new Set<string>();

  const blockUncertainDelivery = Effect.fn("blockUncertainDelivery")(function* (
    deliveryId: string,
  ) {
    uncertainBlockerIds.add(deliveryId);
    yield* engine.blockExternalHotAdmission(deliveryId);
  });

  const releaseUncertainDelivery = Effect.fn("releaseUncertainDelivery")(function* (
    deliveryId: string,
  ) {
    uncertainBlockerIds.delete(deliveryId);
    yield* engine.releaseExternalHotAdmissionBlocker(deliveryId);
  });

  const reconcileUncertainBlockers = Effect.fn("reconcileUncertainBlockers")(function* () {
    for (const deliveryId of uncertainBlockerIds) {
      const delivery = yield* deliveries.getById(deliveryId);
      if (
        Option.isNone(delivery) ||
        delivery.value.status === "delivered" ||
        delivery.value.status === "cancelled"
      ) {
        yield* releaseUncertainDelivery(deliveryId);
      }
    }
  });

  const appendNonReplayCancellationEvidence = Effect.fn("appendNonReplayCancellationEvidence")(
    function* (delivery: OrchestrationReactorDelivery, detail: string, createdAt: string) {
      yield* engine.dispatchInternal({
        type: "thread.activity.append",
        commandId: CommandId.make(`delivery:${delivery.deliveryId}:recovery-evidence`),
        threadId: delivery.threadId,
        activity: {
          id: EventId.make(`delivery:${delivery.deliveryId}:recovery-evidence`),
          tone: "error",
          kind: "orchestration.delivery.execution-uncertain",
          summary: "External action replay suppressed",
          payload: {
            deliveryId: delivery.deliveryId,
            deliveryKind: delivery.deliveryKind,
            detail,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    },
  );

  const validateClaimed = Effect.fn("validateClaimed")(function* (
    delivery: OrchestrationReactorDelivery,
  ) {
    const event = yield* decodeOrchestrationEvent(delivery.payload);
    const valid =
      (delivery.deliveryKind === "runtime-mode-change" &&
        delivery.reactor === "provider-command" &&
        event.type === "thread.runtime-mode-set") ||
      (delivery.deliveryKind === "turn-start" &&
        delivery.reactor === "provider-command" &&
        event.type === "thread.turn-start-requested") ||
      (delivery.deliveryKind === "turn-interrupt" &&
        delivery.reactor === "provider-command" &&
        event.type === "thread.turn-interrupt-requested") ||
      (delivery.deliveryKind === "approval-response" &&
        delivery.reactor === "provider-command" &&
        event.type === "thread.approval-response-requested") ||
      (delivery.deliveryKind === "user-input-response" &&
        delivery.reactor === "provider-command" &&
        event.type === "thread.user-input-response-requested") ||
      (delivery.deliveryKind === "session-stop" &&
        delivery.reactor === "provider-command" &&
        event.type === "thread.session-stop-requested") ||
      (delivery.deliveryKind === "archive-cleanup" &&
        delivery.reactor === "archive-cleanup" &&
        event.type === "thread.archived") ||
      (delivery.deliveryKind === "checkpoint-revert" &&
        delivery.reactor === "checkpoint" &&
        event.type === "thread.checkpoint-revert-requested") ||
      (delivery.deliveryKind === "thread-delete" &&
        delivery.reactor === "thread-deletion" &&
        event.type === "thread.deleted");
    if (!valid) {
      return yield* Effect.die(
        `delivery ${delivery.deliveryId} payload/target does not match ${delivery.deliveryKind}`,
      );
    }
  });

  const dispatchClaimed = Effect.fn("dispatchClaimed")(function* (
    delivery: OrchestrationReactorDelivery,
  ) {
    switch (delivery.deliveryKind) {
      case "runtime-mode-change":
      case "turn-start":
      case "turn-interrupt":
      case "approval-response":
      case "user-input-response":
      case "session-stop":
        if (delivery.reactor !== "provider-command") {
          return yield* Effect.die(
            `${delivery.deliveryKind} delivery targets unexpected reactor ${delivery.reactor}`,
          );
        }
        return yield* providerReactor.deliver(delivery);
      case "archive-cleanup":
        if (delivery.reactor !== "archive-cleanup") {
          return yield* Effect.die(
            `archive-cleanup delivery targets unexpected reactor ${delivery.reactor}`,
          );
        }
        return yield* providerReactor.deliver(delivery);
      case "checkpoint-revert":
        if (delivery.reactor !== "checkpoint") {
          return yield* Effect.die(
            `checkpoint-revert delivery targets unexpected reactor ${delivery.reactor}`,
          );
        }
        return yield* checkpointReactor.deliver(delivery);
      case "thread-delete":
        if (delivery.reactor !== "thread-deletion") {
          return yield* Effect.die(
            `thread-delete delivery targets unexpected reactor ${delivery.reactor}`,
          );
        }
        return yield* deletionReactor.deliver(delivery);
    }
  });

  const deferUncertainDelivery = Effect.fn("deferUncertainDelivery")(function* (
    delivery: OrchestrationReactorDelivery,
    claimToken: string,
  ) {
    yield* blockUncertainDelivery(delivery.deliveryId);
    const deferredAtValue = yield* DateTime.now;
    const deferredAt = DateTime.formatIso(deferredAtValue);
    const deferred = yield* deliveries.deferUncertain(
      delivery.deliveryId,
      claimToken,
      deferredAt,
      DateTime.formatIso(DateTime.add(deferredAtValue, { seconds: 1 })),
      "Provider liveness or projected target was not safe to settle; awaiting another barrier-confirmed classification.",
    );
    if (!deferred) {
      return yield* Effect.die(
        `uncertain delivery claim was lost before it could be retained for reconciliation`,
      );
    }
    yield* Effect.logWarning("retained uncertain delivery for barrier-confirmed reconciliation", {
      deliveryId: delivery.deliveryId,
      threadId: delivery.threadId,
    });
    return false;
  });

  const cancelUncertainExecution = Effect.fn("cancelUncertainExecution")(function* (
    delivery: OrchestrationReactorDelivery,
    recovery: {
      readonly reason: "server-restarted" | "provider-state-mismatch";
      readonly interruptionCode: "server_restart" | "provider_state_mismatch";
      readonly checkpointDetail: string;
      readonly genericDetail: string;
    },
  ) {
    const recoveryClaimToken = delivery.claimToken;
    if (recoveryClaimToken === null) {
      return yield* Effect.die(
        `recovery delivery ${delivery.deliveryId} has no current claim ownership`,
      );
    }
    const event = yield* decodeOrchestrationEvent(delivery.payload);
    if (delivery.deliveryKind === "checkpoint-revert") {
      const detectedAt = DateTime.formatIso(yield* DateTime.now);
      yield* appendNonReplayCancellationEvidence(delivery, recovery.checkpointDetail, detectedAt);
      return "cancelled" as const;
    }

    if (
      delivery.deliveryKind === "turn-start" &&
      delivery.sourceBootId === bootId &&
      event.type === "thread.turn-start-requested"
    ) {
      const inspectTarget = providerService.inspectTarget;
      if (inspectTarget === undefined) {
        yield* Effect.logWarning("retaining uncertain turn-start delivery without liveness probe", {
          deliveryId: delivery.deliveryId,
          threadId: delivery.threadId,
        });
        return "retained" as const;
      }

      for (let attempt = 0; attempt < SAME_BOOT_RECOVERY_RECLASSIFY_LIMIT; attempt += 1) {
        const beforeBarrier = yield* snapshots
          .getThreadDetailById(delivery.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (beforeBarrier === undefined) {
          yield* Effect.logWarning("retaining uncertain turn-start delivery without thread state", {
            deliveryId: delivery.deliveryId,
            threadId: delivery.threadId,
          });
          return "retained" as const;
        }
        const inspectedProviderInstanceId = providerInstanceFor(beforeBarrier);
        const sample = yield* inspectTarget({
          providerInstanceId: inspectedProviderInstanceId,
          threadId: delivery.threadId,
        }).pipe(
          Effect.timeout("3 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("retaining uncertain turn-start delivery without liveness barrier", {
              deliveryId: delivery.deliveryId,
              threadId: delivery.threadId,
              providerInstanceId: inspectedProviderInstanceId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ state: "unknown", reason: "unavailable" } as const)),
          ),
        );
        if (sample.state === "unknown") {
          return "retained" as const;
        }

        const thread = yield* snapshots
          .getThreadDetailById(delivery.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread === undefined) return "retained" as const;

        const providerInstanceId = providerInstanceFor(thread);
        if (providerInstanceId !== inspectedProviderInstanceId) {
          continue;
        }

        const latestTurn = thread.latestTurn;
        if (
          latestTurn !== null &&
          latestTurn.state !== "running" &&
          latestTurn.retrySourceMessageId === event.payload.messageId
        ) {
          return "delivered" as const;
        }
        const exactRunningTurn =
          latestTurn?.state === "running" &&
          latestTurn.retrySourceMessageId === event.payload.messageId &&
          thread.session !== null &&
          thread.session.activeTurnId === latestTurn.turnId;
        if (
          exactRunningTurn &&
          hasMatchingLiveTurn(sample, providerInstanceId, latestTurn.turnId)
        ) {
          return "delivered" as const;
        }

        let target: OrchestrationRecoveryTarget;
        if (exactRunningTurn) {
          if (hasConflictingLiveTurn(sample, providerInstanceId, latestTurn.turnId)) {
            return "retained" as const;
          }
          target = {
            kind: "turn",
            turnId: latestTurn.turnId,
            retrySourceMessageId: latestTurn.retrySourceMessageId ?? null,
            expectedSession: expectedSessionFrom(thread.session),
          };
        } else {
          const sampleActiveTurnId =
            sample.state === "present" ? (sample.session.activeTurnId ?? null) : null;
          if (
            latestTurn?.state === "running" ||
            (sample.state === "present" &&
              sample.session.providerInstanceId !== providerInstanceId) ||
            sampleActiveTurnId !== null
          ) {
            return "retained" as const;
          }
          target = {
            kind: "pendingStart",
            pendingMessageId: event.payload.messageId,
            deliveryId: delivery.deliveryId,
            sourceEventId: delivery.sourceEventId,
            expectedSession:
              thread.session === null ? { kind: "absent" } : expectedSessionFrom(thread.session),
            expectedDeliveryOwnership: {
              status: "delivering",
              claimToken: recoveryClaimToken,
            },
          };
        }

        const detectedAt = DateTime.formatIso(yield* DateTime.now);
        const settled = yield* engine
          .dispatchInternal({
            type: "thread.session.interrupt-if-active",
            commandId: recoveryCommandId({
              threadId: delivery.threadId,
              target,
              serverBootId: bootId,
              reason: recovery.reason,
            }),
            threadId: delivery.threadId,
            target,
            reason: recovery.reason,
            interruptionCode: recovery.interruptionCode,
            serverBootId: bootId,
            detectedAt,
            createdAt: detectedAt,
          })
          .pipe(
            Effect.as(true),
            Effect.catchTag(
              ["OrchestrationCommandInvariantError", "OrchestrationCommandPreviouslyRejectedError"],
              () => Effect.succeed(false),
            ),
          );
        if (settled) {
          return target.kind === "pendingStart"
            ? ("cancelled-atomically" as const)
            : ("cancelled" as const);
        }
      }

      yield* Effect.logWarning(
        "retaining uncertain turn-start delivery after state kept changing",
        {
          deliveryId: delivery.deliveryId,
          threadId: delivery.threadId,
        },
      );
      return "retained" as const;
    }

    const thread = yield* snapshots
      .getThreadDetailById(delivery.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (thread === undefined) return "cancelled" as const;

    const expectedSession: OrchestrationExpectedSession =
      thread.session === null ? { kind: "absent" } : expectedSessionFrom(thread.session);
    let target: OrchestrationRecoveryTarget | null = null;
    if (delivery.deliveryKind === "turn-start") {
      if (event.type !== "thread.turn-start-requested") {
        return yield* Effect.die(`turn-start delivery contains ${event.type}`);
      }
      target = {
        kind: "pendingStart",
        pendingMessageId: event.payload.messageId,
        deliveryId: delivery.deliveryId,
        sourceEventId: delivery.sourceEventId,
        expectedSession,
        expectedDeliveryOwnership: {
          status: "delivering",
          claimToken: recoveryClaimToken,
        },
      };
    } else if (
      delivery.deliveryKind !== "runtime-mode-change" &&
      expectedSession.kind === "present" &&
      expectedSession.activeTurnId !== null &&
      thread.latestTurn?.state === "running" &&
      thread.latestTurn.turnId === expectedSession.activeTurnId
    ) {
      target = {
        kind: "turn",
        turnId: expectedSession.activeTurnId,
        retrySourceMessageId: thread.latestTurn.retrySourceMessageId ?? null,
        expectedSession,
      };
    }
    if (target === null) {
      const detectedAt = DateTime.formatIso(yield* DateTime.now);
      yield* appendNonReplayCancellationEvidence(delivery, recovery.genericDetail, detectedAt);
      return "cancelled" as const;
    }

    const detectedAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatchInternal({
        type: "thread.session.interrupt-if-active",
        commandId: recoveryCommandId({
          threadId: delivery.threadId,
          target,
          serverBootId: bootId,
          reason: recovery.reason,
        }),
        threadId: delivery.threadId,
        target,
        reason: recovery.reason,
        interruptionCode: recovery.interruptionCode,
        serverBootId: bootId,
        detectedAt,
        createdAt: detectedAt,
      })
      .pipe(
        Effect.catchTag(
          ["OrchestrationCommandInvariantError", "OrchestrationCommandPreviouslyRejectedError"],
          () => Effect.void,
        ),
      );
    return target.kind === "pendingStart"
      ? ("cancelled-atomically" as const)
      : ("cancelled" as const);
  });

  const processClaimed = Effect.fn("processClaimed")(function* (
    delivery: OrchestrationReactorDelivery,
    noteExecutionMayHaveStarted: () => void,
  ) {
    const claimToken = delivery.claimToken;
    if (claimToken === null) {
      return yield* Effect.die(`claimed delivery ${delivery.deliveryId} has no claim token`);
    }
    const shouldCancelPriorExecution =
      delivery.replayPolicy === "cancel-with-recovery" &&
      delivery.sourceBootId !== bootId &&
      !liveSourceEventIds.has(delivery.sourceEventId);
    const hasUncertainExecution =
      delivery.replayPolicy === "cancel-with-recovery" && delivery.executionStartedAt !== null;
    let resolution: "delivered" | "cancelled" | "cancelled-atomically" | "retained";
    if (shouldCancelPriorExecution) {
      resolution = yield* cancelUncertainExecution(delivery, {
        reason: "server-restarted",
        interruptionCode: "server_restart",
        checkpointDetail:
          "The server restarted while checkpoint rollback completion was uncertain; replay was suppressed to prevent duplicate provider rollback.",
        genericDetail:
          "The server restarted before this external action reached a durable terminal result; replay was suppressed.",
      });
    } else if (hasUncertainExecution) {
      noteExecutionMayHaveStarted();
      resolution = yield* cancelUncertainExecution(delivery, {
        reason: "provider-state-mismatch",
        interruptionCode: "provider_state_mismatch",
        checkpointDetail:
          "A checkpoint rollback reached the external-execution boundary without a durable terminal result; replay was suppressed.",
        genericDetail:
          "A previous claim reached the external-execution boundary but did not persist a terminal result; replay was suppressed.",
      });
    } else {
      yield* validateClaimed(delivery);
      if (delivery.replayPolicy === "cancel-with-recovery") {
        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const marked = yield* deliveries.markExecutionStarted(
          delivery.deliveryId,
          claimToken,
          startedAt,
        );
        if (!marked) {
          return yield* Effect.die(
            `delivery claim was lost before execution could be durably marked`,
          );
        }
        noteExecutionMayHaveStarted();
      }
      resolution = yield* dispatchClaimed(delivery);
    }
    if (resolution === "retained") {
      return yield* deferUncertainDelivery(delivery, claimToken);
    }
    if (resolution === "cancelled-atomically") {
      liveSourceEventIds.delete(delivery.sourceEventId);
      yield* releaseUncertainDelivery(delivery.deliveryId);
      return true;
    }
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    const transitioned =
      resolution === "delivered"
        ? yield* deliveries.markDelivered(delivery.deliveryId, claimToken, completedAt)
        : yield* deliveries.markCancelled(delivery.deliveryId, completedAt, claimToken);
    if (!transitioned) {
      return yield* Effect.die(`delivery claim was lost before terminal transition`);
    }
    liveSourceEventIds.delete(delivery.sourceEventId);
    yield* releaseUncertainDelivery(delivery.deliveryId);
    return true;
  });

  const processNext: Effect.Effect<boolean, unknown> = Effect.gen(function* () {
    const claimedAtValue = yield* DateTime.now;
    const claimedAt = DateTime.formatIso(claimedAtValue);
    const claimToken = yield* crypto.randomUUIDv4;
    const claimed = yield* deliveries.claimNext({
      claimToken,
      currentBootId: bootId,
      claimedAt,
      leaseExpiresAt: DateTime.formatIso(
        DateTime.add(claimedAtValue, { minutes: CLAIM_LEASE_MINUTES }),
      ),
    });
    if (Option.isNone(claimed)) return false;

    let executionMayHaveStarted = claimed.value.executionStartedAt !== null;
    const succeeded = yield* processClaimed(claimed.value, () => {
      executionMayHaveStarted = true;
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.gen(function* () {
          const failedAtValue = yield* DateTime.now;
          const failedAt = DateTime.formatIso(failedAtValue);
          if (claimed.value.replayPolicy === "cancel-with-recovery" && executionMayHaveStarted) {
            const resolution = yield* cancelUncertainExecution(claimed.value, {
              reason: "provider-state-mismatch",
              interruptionCode: "provider_state_mismatch",
              checkpointDetail: `Checkpoint rollback execution may have succeeded before durable completion failed; replay was suppressed. ${Cause.pretty(cause)}`,
              genericDetail: `External execution may have succeeded before durable completion failed; replay was suppressed. ${Cause.pretty(cause)}`,
            });
            if (resolution === "retained") {
              return yield* deferUncertainDelivery(claimed.value, claimToken);
            }
            if (resolution === "cancelled-atomically") {
              yield* releaseUncertainDelivery(claimed.value.deliveryId);
              return true;
            }
            if (resolution === "delivered") {
              const delivered = yield* deliveries.markDelivered(
                claimed.value.deliveryId,
                claimToken,
                failedAt,
              );
              if (!delivered) {
                return yield* Effect.die(
                  `non-replay delivery claim was lost before completion could be retained`,
                );
              }
              yield* releaseUncertainDelivery(claimed.value.deliveryId);
              return true;
            }
            const cancelled = yield* deliveries.markCancelled(
              claimed.value.deliveryId,
              failedAt,
              claimToken,
            );
            if (!cancelled) {
              return yield* Effect.die(
                `non-replay delivery claim was lost before cancellation could be retained`,
              );
            }
            yield* releaseUncertainDelivery(claimed.value.deliveryId);
            return true;
          }
          const backoffMs =
            RETRY_BACKOFF_MILLIS[
              Math.min(claimed.value.attempts - 1, RETRY_BACKOFF_MILLIS.length - 1)
            ] ?? 30_000;
          const retained = yield* deliveries.recordFailure(
            claimed.value.deliveryId,
            claimToken,
            failedAt,
            Cause.pretty(cause),
            MAX_DELIVERY_ATTEMPTS,
            DateTime.formatIso(DateTime.add(failedAtValue, { milliseconds: backoffMs })),
          );
          if (Option.isNone(retained)) {
            return yield* Effect.die(`delivery claim was lost before failure could be retained`);
          }
          const outcome = retained.value === "dead-letter" ? "dead-letter" : "retry-scheduled";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationDeliveryAttemptsTotal,
              metricAttributes({ deliveryKind: claimed.value.deliveryKind, outcome }),
            ),
            1,
          );
          yield* Effect.logWarning("durable orchestration delivery failed", {
            deliveryId: claimed.value.deliveryId,
            deliveryKind: claimed.value.deliveryKind,
            attempt: claimed.value.attempts,
            outcome,
            nextAttemptAt:
              retained.value === "dead-letter"
                ? null
                : DateTime.formatIso(DateTime.add(failedAtValue, { milliseconds: backoffMs })),
            cause: Cause.pretty(cause),
          });
          if (retained.value === "dead-letter" && claimed.value.sourceBootId === bootId) {
            yield* engine.closeExternalAdmission;
          }
          return false;
        });
      }),
    );
    return succeeded;
  });

  const drainUnlocked: Effect.Effect<void, unknown> = Effect.gen(function* () {
    while (yield* processNext) {
      // claimNext enforces the single global predecessor, including poison rows.
    }
    yield* reconcileUncertainBlockers();
  });

  const drain = drainLock
    .withPermits(1)(drainUnlocked)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable orchestration delivery drain failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: OrchestrationDeliveryRuntimeShape["start"] = Effect.fn("start")(function* () {
    yield* Stream.runForEach(engine.streamDomainEvents, (event) => {
      liveSourceEventIds.add(event.eventId);
      return drain;
    }).pipe(Effect.forkScoped);
    yield* Effect.sleep("100 millis").pipe(
      Effect.flatMap(() => drain),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* drain;
  });

  const inspectReadiness = DateTime.now.pipe(
    Effect.flatMap((observedAt) => deliveries.inspectReadiness(DateTime.formatIso(observedAt))),
  );

  const recoverStartup: OrchestrationDeliveryRuntimeShape["recoverStartup"] = Effect.gen(
    function* () {
      const deadline = (yield* Clock.currentTimeMillis) + STARTUP_RECOVERY_BUDGET_MILLIS;
      while (true) {
        yield* drain;
        const readiness = yield* inspectReadiness;
        if (readiness.counts.total === 0) return;
        if (readiness.counts.deadLetter > 0) {
          return yield* Effect.die(
            `orchestration delivery recovery encountered ${readiness.counts.deadLetter} poison row(s)`,
          );
        }

        const oldest = Option.getOrUndefined(readiness.oldest);
        const nextAttemptAt = oldest?.delivery.nextAttemptAt ?? null;
        const now = yield* Clock.currentTimeMillis;
        const retryAt = nextAttemptAt === null ? now + 100 : Date.parse(nextAttemptAt);
        const waitMillis = Math.max(1, Number.isFinite(retryAt) ? retryAt - now : 100);
        if (now + waitMillis > deadline) {
          return yield* Effect.die(
            `orchestration delivery recovery exceeded ${STARTUP_RECOVERY_BUDGET_MILLIS}ms budget`,
          );
        }
        yield* Effect.sleep(`${waitMillis} millis`);
      }
    },
  );

  return OrchestrationDeliveryRuntime.of({ start, drain, recoverStartup, inspectReadiness });
});

export const OrchestrationDeliveryRuntimeLive = Layer.effect(OrchestrationDeliveryRuntime, make);
