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
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderLivenessSample } from "../../provider/Services/ProviderAdapter.ts";
import { ServerBootIdentity } from "../../serverBootId.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrphanTurnReconciler,
  type OrphanTurnStartupResult,
  type OrphanTurnReconcilerShape,
} from "../Services/OrphanTurnReconciler.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import type { LegacyPendingTurnReadiness } from "../Services/ProjectionSnapshotQuery.ts";
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
  readonly bindingServerBootId: string | null;
  readonly turnStartedAt: string | null;
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

export function recoveryCandidateForThread(
  thread: OrchestrationThread,
  bindingServerBootId: string | null = null,
): RecoveryCandidate | undefined {
  if (thread.latestTurn?.state !== "running") {
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
    bindingServerBootId,
    turnStartedAt: thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt,
  };
}

export function isPriorBootRecoveryCandidate(
  candidate: RecoveryCandidate,
  serverBootId: string,
): boolean {
  return candidate.bindingServerBootId !== serverBootId;
}

export function latestEligibleRecoveryObservation(
  candidate: RecoveryCandidate,
  observedAt: ReadonlyArray<string>,
  detectedAt: string,
): string | undefined {
  const startedAtMs =
    candidate.turnStartedAt === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(candidate.turnStartedAt);
  const detectedAtMs = Date.parse(detectedAt);
  return observedAt
    .filter((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && timestamp >= startedAtMs && timestamp <= detectedAtMs;
    })
    .toSorted((left, right) => right.localeCompare(left))[0];
}

const noLegacyPending: LegacyPendingTurnReadiness = {
  count: 0,
  issues: [],
  truncated: false,
};

export function startupReconciliationResult(
  candidateCount: number,
  legacyPending: LegacyPendingTurnReadiness = noLegacyPending,
): OrphanTurnStartupResult {
  return candidateCount === 0 && legacyPending.count === 0
    ? { status: "settled" }
    : { status: "unresolved", candidateCount, legacyPending };
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
  const sessionDirectory = yield* ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery;
  const deliveries = yield* OrchestrationReactorDeliveries;
  const engine = yield* OrchestrationEngineService;
  const serverBootId = (yield* ServerBootIdentity).id;
  const observations = yield* Ref.make(new Map<ThreadId, MismatchObservation>());
  const running = yield* Ref.make(false);

  const collectCandidates = Effect.fn("OrphanTurnReconciler.collectCandidates")(function* () {
    const [readModel, pendingDeliveries, bindings] = yield* Effect.all([
      snapshots.getCommandReadModel(),
      deliveries.listPendingOrdered(),
      sessionDirectory.listBindings(),
    ]);
    const bindingBootIdByThread = new Map(
      bindings.map((binding) => [binding.threadId, binding.serverBootId ?? null] as const),
    );
    const byThread = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
    const candidates = new Map<ThreadId, RecoveryCandidate>();
    for (const thread of readModel.threads) {
      const candidate = recoveryCandidateForThread(
        thread,
        bindingBootIdByThread.get(thread.id) ?? null,
      );
      if (candidate !== undefined) {
        candidates.set(thread.id, candidate);
      }
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
        bindingServerBootId: bindingBootIdByThread.get(delivery.threadId) ?? null,
        turnStartedAt: null,
      });
    }
    return [...candidates.values()];
  });

  const dispatchRecovery = Effect.fn("OrphanTurnReconciler.dispatchRecovery")(function* (
    candidate: RecoveryCandidate,
    reason: "server-restarted" | "provider-state-mismatch" | "shutdown",
  ) {
    const detectedAt = DateTime.formatIso(yield* DateTime.now);
    const readRecoveryEvidence = snapshots.getTurnRecoveryEvidence;
    const executionLastObservedAt =
      candidate.target.kind === "turn" && readRecoveryEvidence !== undefined
        ? yield* readRecoveryEvidence(candidate.threadId, candidate.target.turnId).pipe(
            Effect.map(({ observedAt }) =>
              latestEligibleRecoveryObservation(candidate, observedAt, detectedAt),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to read persisted recovery evidence", {
                threadId: candidate.threadId,
                turnId: candidate.target.kind === "turn" ? candidate.target.turnId : undefined,
                cause,
              }).pipe(Effect.as(undefined)),
            ),
          )
        : undefined;
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
    yield* dispatchRecovery(candidate, current.reason);
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
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          reason === "server-restarted" && isPriorBootRecoveryCandidate(candidate, serverBootId)
            ? dispatchRecovery(candidate, reason)
            : observe(candidate, reason),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
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
  const readLegacyPendingReadiness = Effect.fn("OrphanTurnReconciler.readLegacyPendingReadiness")(
    function* () {
      const read = snapshots.getLegacyPendingTurnReadiness;
      if (read === undefined) {
        return yield* Effect.die(
          "legacy pending-turn readiness query is unavailable; refusing command readiness",
        );
      }
      return yield* read();
    },
  );
  const reconcileStartup: OrphanTurnReconcilerShape["reconcileStartup"] = Effect.gen(function* () {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) yield* Effect.sleep(SWEEP_INTERVAL);
      const beforeSweep = yield* readLegacyPendingReadiness();
      if (beforeSweep.count > 0) {
        return startupReconciliationResult((yield* collectCandidates()).length, beforeSweep);
      }
      yield* runSweep("server-restarted");
      const result = startupReconciliationResult(
        (yield* collectCandidates()).length,
        yield* readLegacyPendingReadiness(),
      );
      if (result.status === "settled") return result;
    }
    return startupReconciliationResult(
      (yield* collectCandidates()).length,
      yield* readLegacyPendingReadiness(),
    );
  });
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
    reconcileStartup,
    snapshotAndInterrupt,
    startPeriodic,
  } satisfies OrphanTurnReconcilerShape;
});

export const OrphanTurnReconcilerLive = Layer.effect(OrphanTurnReconciler, make);
