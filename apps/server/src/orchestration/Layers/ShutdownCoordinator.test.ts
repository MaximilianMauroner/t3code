import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { runShutdownSequence, runShutdownWithBudget } from "./ShutdownCoordinator.ts";
import {
  hasSafeEffectiveTimeoutStop,
  MINIMUM_EFFECTIVE_TIMEOUT_STOP_SECONDS,
} from "../Services/ShutdownCoordinator.ts";

it.effect("records the graceful shutdown linearization order", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const step = (name: string) => Ref.update(order, (current) => [...current, name]);
    yield* runShutdownSequence({
      closeExternalAdmission: step("admission"),
      engineBarrier: step("barrier"),
      drainDeliveries: step("deliveries"),
      closeProviderIngress: step("ingress-close"),
      drainProviderIngestion: step("ingestion-drain"),
      drainRemainingReactors: step("reactors-drain"),
      internalEngineBarrier: step("internal-barrier"),
      interruptActiveTargets: step("interrupt"),
      sealAndStopEngine: step("seal"),
      closeReactorScope: step("reactors-close"),
    });
    assert.deepStrictEqual(yield* Ref.get(order), [
      "admission",
      "barrier",
      "deliveries",
      "ingress-close",
      "ingestion-drain",
      "interrupt",
      "internal-barrier",
      "deliveries",
      "reactors-drain",
      "internal-barrier",
      "seal",
      "reactors-close",
    ]);
  }),
);

it("requires enough systemd stop headroom for the coordinator", () => {
  assert.equal(hasSafeEffectiveTimeoutStop(MINIMUM_EFFECTIVE_TIMEOUT_STOP_SECONDS), true);
  assert.equal(hasSafeEffectiveTimeoutStop(MINIMUM_EFFECTIVE_TIMEOUT_STOP_SECONDS - 1), false);
});

it.effect("forces engine sealing and reactor closure when the graceful barrier times out", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const step = (name: string) => Ref.update(order, (current) => [...current, name]);
    const fiber = yield* runShutdownWithBudget({
      actions: {
        closeExternalAdmission: step("admission"),
        engineBarrier: step("barrier").pipe(Effect.andThen(Effect.never)),
        drainDeliveries: step("deliveries"),
        closeProviderIngress: step("ingress-close"),
        drainProviderIngestion: step("ingestion-drain"),
        drainRemainingReactors: step("reactors-drain"),
        internalEngineBarrier: step("internal-barrier"),
        interruptActiveTargets: step("interrupt"),
        sealAndStopEngine: step("graceful-seal"),
        closeReactorScope: step("graceful-close"),
      },
      forced: step("forced-seal").pipe(Effect.andThen(step("forced-close"))),
      budgetMs: 4_000,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("4 seconds");
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(yield* Ref.get(order), [
      "admission",
      "barrier",
      "forced-seal",
      "forced-close",
    ]);
  }),
);

it.effect("awaits forced worker termination before awaiting reactor finalizers", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const workerStopped = yield* Deferred.make<void>();
    const scopeClosed = yield* Deferred.make<void>();
    const step = (name: string) => Ref.update(order, (current) => [...current, name]);
    const fiber = yield* runShutdownWithBudget({
      actions: {
        closeExternalAdmission: step("admission"),
        engineBarrier: Effect.never,
        drainDeliveries: Effect.void,
        closeProviderIngress: Effect.void,
        drainProviderIngestion: Effect.void,
        drainRemainingReactors: Effect.void,
        internalEngineBarrier: Effect.void,
        interruptActiveTargets: Effect.void,
        sealAndStopEngine: Effect.void,
        closeReactorScope: Effect.void,
      },
      forced: step("forced-seal").pipe(
        Effect.andThen(step("worker-await")),
        Effect.andThen(Deferred.await(workerStopped)),
        Effect.andThen(step("worker-stopped")),
        Effect.andThen(step("scope-await")),
        Effect.andThen(Deferred.await(scopeClosed)),
        Effect.andThen(step("scope-closed")),
      ),
      budgetMs: 4_000,
      forcedBudgetMs: 2_000,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("4 seconds");
    yield* Effect.yieldNow;
    assert.deepStrictEqual(yield* Ref.get(order), ["admission", "forced-seal", "worker-await"]);
    assert.equal(fiber.pollUnsafe(), undefined);

    yield* Deferred.succeed(workerStopped, undefined);
    yield* Effect.yieldNow;
    assert.deepStrictEqual(yield* Ref.get(order), [
      "admission",
      "forced-seal",
      "worker-await",
      "worker-stopped",
      "scope-await",
    ]);
    assert.equal(fiber.pollUnsafe(), undefined);

    yield* Deferred.succeed(scopeClosed, undefined);
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(yield* Ref.get(order), [
      "admission",
      "forced-seal",
      "worker-await",
      "worker-stopped",
      "scope-await",
      "scope-closed",
    ]);
  }),
);

it.effect("returns at the secondary budget when forced worker termination never completes", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const step = (name: string) => Ref.update(order, (current) => [...current, name]);
    const fiber = yield* runShutdownWithBudget({
      actions: {
        closeExternalAdmission: step("admission"),
        engineBarrier: Effect.never,
        drainDeliveries: Effect.void,
        closeProviderIngress: Effect.void,
        drainProviderIngestion: Effect.void,
        drainRemainingReactors: Effect.void,
        internalEngineBarrier: Effect.void,
        interruptActiveTargets: Effect.void,
        sealAndStopEngine: Effect.void,
        closeReactorScope: Effect.void,
      },
      forced: step("forced-seal").pipe(Effect.andThen(Effect.never)),
      onForcedTimeout: step("systemd-fallback"),
      budgetMs: 4_000,
      forcedBudgetMs: 2_000,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("4 seconds");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(yield* Ref.get(order), ["admission", "forced-seal", "systemd-fallback"]);
  }),
);

it.effect("returns at the secondary budget when reactor finalizers never complete", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const step = (name: string) => Ref.update(order, (current) => [...current, name]);
    const scope = yield* Scope.make("sequential");
    yield* Scope.addFinalizer(scope, step("finalizer-entered").pipe(Effect.andThen(Effect.never)));
    const fiber = yield* runShutdownWithBudget({
      actions: {
        closeExternalAdmission: step("admission"),
        engineBarrier: Effect.never,
        drainDeliveries: Effect.void,
        closeProviderIngress: Effect.void,
        drainProviderIngestion: Effect.void,
        drainRemainingReactors: Effect.void,
        internalEngineBarrier: Effect.void,
        interruptActiveTargets: Effect.void,
        sealAndStopEngine: Effect.void,
        closeReactorScope: Effect.void,
      },
      forced: step("forced-seal").pipe(
        Effect.andThen(step("worker-stopped")),
        Effect.andThen(Scope.close(scope, Exit.void)),
      ),
      onForcedTimeout: step("systemd-fallback"),
      budgetMs: 4_000,
      forcedBudgetMs: 2_000,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("4 seconds");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
    assert.equal(scope.state._tag, "Closed");
    assert.deepStrictEqual(yield* Ref.get(order), [
      "admission",
      "forced-seal",
      "worker-stopped",
      "finalizer-entered",
      "systemd-fallback",
    ]);
  }),
);
