import {
  CommandId,
  EventId,
  type OrchestrationExpectedSession,
  type OrchestrationRecoveryTarget,
  type OrchestrationSession,
  OrchestrationEvent,
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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const deliveries = yield* OrchestrationReactorDeliveries;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providerReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const deletionReactor = yield* ThreadDeletionReactor;
  const bootId = (yield* ServerBootIdentity).id;
  const drainLock = yield* Semaphore.make(1);
  const liveSourceEventIds = new Set<string>();

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

  const cancelPriorBootExecution = Effect.fn("cancelPriorBootExecution")(function* (
    delivery: OrchestrationReactorDelivery,
  ) {
    const event = yield* decodeOrchestrationEvent(delivery.payload);
    if (delivery.deliveryKind === "checkpoint-revert") {
      const detectedAt = DateTime.formatIso(yield* DateTime.now);
      yield* appendNonReplayCancellationEvidence(
        delivery,
        "The server restarted while checkpoint rollback completion was uncertain; replay was suppressed to prevent duplicate provider rollback.",
        detectedAt,
      );
      return "cancelled" as const;
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
      yield* appendNonReplayCancellationEvidence(
        delivery,
        "The server restarted before this external action reached a durable terminal result; replay was suppressed.",
        detectedAt,
      );
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
          reason: "server-restarted",
        }),
        threadId: delivery.threadId,
        target,
        reason: "server-restarted",
        interruptionCode: "server_restart",
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
    return "cancelled" as const;
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
    let resolution: "delivered" | "cancelled";
    if (shouldCancelPriorExecution) {
      resolution = yield* cancelPriorBootExecution(delivery);
    } else if (hasUncertainExecution) {
      noteExecutionMayHaveStarted();
      const detectedAt = DateTime.formatIso(yield* DateTime.now);
      yield* appendNonReplayCancellationEvidence(
        delivery,
        "A previous claim reached the external-execution boundary but did not persist a terminal result; replay was suppressed.",
        detectedAt,
      );
      resolution = "cancelled";
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
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    const transitioned =
      resolution === "delivered"
        ? yield* deliveries.markDelivered(delivery.deliveryId, claimToken, completedAt)
        : yield* deliveries.markCancelled(delivery.deliveryId, completedAt, claimToken);
    if (!transitioned) {
      return yield* Effect.die(`delivery claim was lost before terminal transition`);
    }
    liveSourceEventIds.delete(delivery.sourceEventId);
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
      Effect.as(true),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.gen(function* () {
          const failedAtValue = yield* DateTime.now;
          const failedAt = DateTime.formatIso(failedAtValue);
          if (claimed.value.replayPolicy === "cancel-with-recovery" && executionMayHaveStarted) {
            yield* appendNonReplayCancellationEvidence(
              claimed.value,
              `External execution may have succeeded before durable completion failed; replay was suppressed. ${Cause.pretty(cause)}`,
              failedAt,
            );
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
            return false;
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
