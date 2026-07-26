import {
  type OrchestrationExpectedSession,
  OrchestrationEvent,
  type OrchestrationRecoveryTarget,
  type OrchestrationThread,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { OrchestrationReactorDeliveries } from "../../persistence/Services/OrchestrationReactorDeliveries.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderLivenessSample } from "../../provider/Services/ProviderAdapter.ts";
import { ServerBootIdentity } from "../../serverBootId.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrphanTurnReconciler,
  type OrphanTurnReconcilerShape,
} from "../Services/OrphanTurnReconciler.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { recoveryCommandId } from "../recoveryCommandId.ts";

const PROBE_TIMEOUT = Duration.seconds(3);
const MISMATCH_GRACE_MS = 120_000;
const SWEEP_INTERVAL = Duration.seconds(30);
const isOrchestrationEvent = Schema.is(OrchestrationEvent);

export interface RecoveryCandidate {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly target: OrchestrationRecoveryTarget;
  readonly equalityKey: string;
}

interface MismatchObservation {
  readonly equalityKey: string;
  readonly firstObservedAtMs: number;
  readonly reason: "server-restarted" | "provider-state-mismatch";
}

function expectedSession(thread: OrchestrationThread): OrchestrationExpectedSession {
  const session = thread.session;
  return session === null
    ? { kind: "absent" }
    : {
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

function equalityKey(target: OrchestrationRecoveryTarget): string {
  const expected = target.expectedSession;
  const sessionKey =
    expected.kind === "absent"
      ? "absent"
      : [
          expected.status,
          expected.activeTurnId ?? "none",
          expected.updatedAt,
          expected.providerName ?? "none",
          expected.providerInstanceId ?? "none",
        ].join(":");
  return target.kind === "turn"
    ? `turn:${target.turnId}:${sessionKey}`
    : `pending:${target.pendingMessageId}:${target.deliveryId}:${target.sourceEventId}:${sessionKey}`;
}

function concreteCandidate(thread: OrchestrationThread): RecoveryCandidate | undefined {
  if (
    thread.latestTurn?.state !== "running" ||
    thread.session === null ||
    thread.session.activeTurnId !== thread.latestTurn.turnId
  ) {
    return undefined;
  }
  const target: OrchestrationRecoveryTarget = {
    kind: "turn",
    turnId: thread.latestTurn.turnId,
    retrySourceMessageId: thread.latestTurn.retrySourceMessageId ?? null,
    expectedSession: expectedSession(thread),
  };
  return {
    threadId: thread.id,
    providerInstanceId: providerInstanceFor(thread),
    target,
    equalityKey: equalityKey(target),
  };
}

export function isRecoveryCandidateMatch(
  candidate: RecoveryCandidate,
  sample: ProviderLivenessSample,
): boolean {
  if (sample.state === "absent") return false;
  if (sample.session.providerInstanceId !== candidate.providerInstanceId) return false;
  const activeTurnId = sample.session.activeTurnId ?? null;
  if (candidate.target.kind === "turn") {
    return (
      activeTurnId === candidate.target.turnId &&
      (sample.session.status === "connecting" ||
        sample.session.status === "ready" ||
        sample.session.status === "running")
    );
  }
  return (
    activeTurnId === null &&
    (sample.session.status === "connecting" || sample.session.status === "ready")
  );
}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const deliveries = yield* OrchestrationReactorDeliveries;
  const engine = yield* OrchestrationEngineService;
  const serverBootId = (yield* ServerBootIdentity).id;
  const observations = yield* Ref.make(new Map<ThreadId, MismatchObservation>());
  const running = yield* Ref.make(false);

  const collectCandidates = Effect.fn("OrphanTurnReconciler.collectCandidates")(function* () {
    const [readModel, pendingDeliveries] = yield* Effect.all([
      snapshots.getCommandReadModel(),
      deliveries.listPendingOrdered(),
    ]);
    const byThread = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
    const candidates = new Map<ThreadId, RecoveryCandidate>();
    for (const thread of readModel.threads) {
      const candidate = concreteCandidate(thread);
      if (candidate !== undefined) candidates.set(thread.id, candidate);
    }
    for (const delivery of pendingDeliveries) {
      if (delivery.deliveryKind !== "turn-start" || !isOrchestrationEvent(delivery.payload)) {
        continue;
      }
      const event = delivery.payload;
      if (event.type !== "thread.turn-start-requested" || candidates.has(delivery.threadId)) {
        continue;
      }
      const thread = byThread.get(delivery.threadId);
      if (thread === undefined) continue;
      const target: OrchestrationRecoveryTarget = {
        kind: "pendingStart",
        pendingMessageId: event.payload.messageId,
        deliveryId: delivery.deliveryId,
        sourceEventId: delivery.sourceEventId,
        expectedSession: expectedSession(thread),
      };
      candidates.set(delivery.threadId, {
        threadId: delivery.threadId,
        providerInstanceId: providerInstanceFor(thread),
        target,
        equalityKey: equalityKey(target),
      });
    }
    return [...candidates.values()];
  });

  const dispatchRecovery = Effect.fn("OrphanTurnReconciler.dispatchRecovery")(function* (
    candidate: RecoveryCandidate,
    reason: "server-restarted" | "provider-state-mismatch" | "shutdown",
    executionLastObservedAt?: string,
  ) {
    const detectedAt = DateTime.formatIso(yield* DateTime.now);
    const interruptionCode =
      reason === "server-restarted"
        ? "server_restart"
        : reason === "shutdown"
          ? "server_shutdown"
          : "provider_state_mismatch";
    yield* engine
      .dispatchInternal({
        type: "thread.session.interrupt-if-active",
        commandId: recoveryCommandId({
          threadId: candidate.threadId,
          target: candidate.target,
          serverBootId,
          reason,
        }),
        threadId: candidate.threadId,
        target: candidate.target,
        reason,
        interruptionCode,
        serverBootId,
        detectedAt,
        ...(executionLastObservedAt !== undefined ? { executionLastObservedAt } : {}),
        createdAt: detectedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("orphan recovery target changed before conditional interrupt", {
            threadId: candidate.threadId,
            cause,
          }),
        ),
      );
  });

  const observe = Effect.fn("OrphanTurnReconciler.observe")(function* (
    candidate: RecoveryCandidate,
    reason: "server-restarted" | "provider-state-mismatch",
  ) {
    const inspectTarget = providerService.inspectTarget;
    const sample = yield* inspectTarget === undefined
      ? Effect.succeed({ state: "unknown" as const })
      : inspectTarget({
          providerInstanceId: candidate.providerInstanceId,
          threadId: candidate.threadId,
        }).pipe(
          Effect.timeout(PROBE_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider liveness probe returned unknown", {
              threadId: candidate.threadId,
              providerInstanceId: candidate.providerInstanceId,
              cause,
            }).pipe(Effect.as({ state: "unknown" as const })),
          ),
        );
    if (sample.state === "unknown" || isRecoveryCandidateMatch(candidate, sample)) {
      yield* Ref.update(observations, (current) => {
        const next = new Map(current);
        next.delete(candidate.threadId);
        return next;
      });
      return;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const current = (yield* Ref.get(observations)).get(candidate.threadId);
    if (current === undefined || current.equalityKey !== candidate.equalityKey) {
      yield* Ref.update(observations, (all) => {
        const next = new Map(all);
        next.set(candidate.threadId, {
          equalityKey: candidate.equalityKey,
          firstObservedAtMs: nowMs,
          reason,
        });
        return next;
      });
      return;
    }
    if (nowMs - current.firstObservedAtMs < MISMATCH_GRACE_MS) return;
    yield* dispatchRecovery(
      candidate,
      current.reason,
      sample.state === "present" ? sample.session.updatedAt : undefined,
    );
    yield* Ref.update(observations, (all) => {
      const next = new Map(all);
      next.delete(candidate.threadId);
      return next;
    });
  });

  const runSweep = Effect.fn("OrphanTurnReconciler.runSweep")(function* (
    reason: "server-restarted" | "provider-state-mismatch",
  ) {
    const acquired = yield* Ref.modify(running, (isRunning) =>
      isRunning ? ([false, true] as const) : ([true, true] as const),
    );
    if (!acquired) return;
    yield* Effect.gen(function* () {
      const candidates = yield* collectCandidates();
      const liveIds = new Set(candidates.map((candidate) => candidate.threadId));
      yield* Ref.update(
        observations,
        (current) => new Map([...current].filter(([threadId]) => liveIds.has(threadId))),
      );
      yield* Effect.forEach(candidates, (candidate) => observe(candidate, reason), {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orphan turn reconciliation sweep failed", { cause }),
      ),
      Effect.ensuring(Ref.set(running, false)),
    );
  });

  const sweep: OrphanTurnReconcilerShape["sweep"] = (reason = "provider-state-mismatch") =>
    runSweep(reason);
  const startPeriodic: OrphanTurnReconcilerShape["startPeriodic"] = () =>
    runSweep("provider-state-mismatch").pipe(
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.asVoid,
      Effect.forkScoped,
      Effect.asVoid,
    );
  const snapshotAndInterrupt: OrphanTurnReconcilerShape["snapshotAndInterrupt"] = () =>
    collectCandidates().pipe(
      Effect.flatMap((candidates) =>
        Effect.forEach(candidates, (candidate) => dispatchRecovery(candidate, "shutdown"), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to snapshot and interrupt active provider targets", { cause }),
      ),
    );

  return {
    sweep,
    reconcileStartup: runSweep("server-restarted"),
    snapshotAndInterrupt,
    startPeriodic,
  } satisfies OrphanTurnReconcilerShape;
});

export const OrphanTurnReconcilerLive = Layer.effect(OrphanTurnReconciler, make);
