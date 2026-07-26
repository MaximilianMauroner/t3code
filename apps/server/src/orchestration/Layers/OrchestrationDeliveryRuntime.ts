import {
  type OrchestrationExpectedSession,
  type OrchestrationRecoveryTarget,
  type OrchestrationSession,
  OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
    if (target === null) return "cancelled" as const;

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
  ) {
    const claimToken = delivery.claimToken;
    if (claimToken === null) {
      return yield* Effect.die(`claimed delivery ${delivery.deliveryId} has no claim token`);
    }
    const resolution =
      delivery.replayPolicy === "cancel-with-recovery" &&
      delivery.sourceBootId !== bootId &&
      !liveSourceEventIds.has(delivery.sourceEventId)
        ? yield* cancelPriorBootExecution(delivery)
        : yield* dispatchClaimed(delivery);
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
      claimedAt,
      leaseExpiresAt: DateTime.formatIso(
        DateTime.add(claimedAtValue, { minutes: CLAIM_LEASE_MINUTES }),
      ),
    });
    if (Option.isNone(claimed)) return false;

    const succeeded = yield* processClaimed(claimed.value).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.gen(function* () {
          const failedAtValue = yield* DateTime.now;
          const failedAt = DateTime.formatIso(failedAtValue);
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

  return OrchestrationDeliveryRuntime.of({ start, drain, inspectReadiness });
});

export const OrchestrationDeliveryRuntimeLive = Layer.effect(OrchestrationDeliveryRuntime, make);
