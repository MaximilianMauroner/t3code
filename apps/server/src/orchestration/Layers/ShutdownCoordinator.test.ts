import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  makeReactorScopeCloser,
  runShutdownSequence,
  runShutdownWithBudget,
  withShutdownCoordinator,
} from "./ShutdownCoordinator.ts";
import {
  hasSafeEffectiveTimeoutStop,
  MINIMUM_EFFECTIVE_TIMEOUT_STOP_SECONDS,
  ShutdownCoordinator,
} from "../Services/ShutdownCoordinator.ts";
import { OrchestrationDeliveryRuntime } from "../Services/OrchestrationDeliveryRuntime.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { OrphanTurnReconciler } from "../Services/OrphanTurnReconciler.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";

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

it.effect("provides shared reactor services to the production shutdown layer", () =>
  Effect.gen(function* () {
    const deliveryRuntime = OrchestrationDeliveryRuntime.of({
      start: () => Effect.void,
      drain: Effect.void,
      recoverStartup: Effect.void,
      inspectReadiness: Effect.die("unused"),
    });
    const dependencies = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        closeExternalAdmission: Effect.void,
        barrier: Effect.succeed({ sequence: 0 }),
        sealAndStop: Effect.void,
        forceStop: Effect.void,
        awaitStopped: Effect.void,
      }),
      Layer.succeed(OrchestrationDeliveryRuntime, deliveryRuntime),
      Layer.mock(ProviderRuntimeIngestionService)({
        start: () => Effect.void,
        drain: Effect.void,
        closeProviderIngress: Effect.void,
      }),
      Layer.mock(OrphanTurnReconciler)({
        snapshotAndInterrupt: () => Effect.void,
      }),
      Layer.mock(OrchestrationReactor)({
        start: () => Effect.void,
        quiesceAndDrain: Effect.void,
      }),
    );
    const services = yield* Effect.all({
      coordinator: ShutdownCoordinator,
      deliveryRuntime: OrchestrationDeliveryRuntime,
    }).pipe(Effect.provide(withShutdownCoordinator(dependencies)));

    assert.strictEqual(services.deliveryRuntime, deliveryRuntime);
    assert.equal(typeof services.coordinator.shutdown, "function");
  }),
);

it.effect("shares one reactor scope close fiber across interrupted callers", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const finalizerStarted = yield* Deferred.make<void>();
    const allowFinalizer = yield* Deferred.make<void>();
    const starts = yield* Ref.make(0);
    yield* Scope.addFinalizer(
      scope,
      Ref.update(starts, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(finalizerStarted, undefined)),
        Effect.andThen(Deferred.await(allowFinalizer)),
      ),
    );
    const { close } = yield* makeReactorScopeCloser(scope);
    const first = yield* close.pipe(Effect.forkChild);
    yield* Deferred.await(finalizerStarted);
    first.interruptUnsafe();
    const second = yield* close.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(second.pollUnsafe(), undefined);
    assert.equal(yield* Ref.get(starts), 1);
    yield* Deferred.succeed(allowFinalizer, undefined);
    yield* Fiber.join(second);
    assert.equal(yield* Ref.get(starts), 1);
  }),
);

it.effect("reuses a graceful reactor close fiber across the forced handoff", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const enterFinalizer = yield* Deferred.make<void>();
    const finalizerStarted = yield* Deferred.make<void>();
    const allowFinalizer = yield* Deferred.make<void>();
    const forcedStarted = yield* Deferred.make<void>();
    const starts = yield* Ref.make(0);
    yield* Scope.addFinalizer(
      scope,
      Ref.update(starts, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(finalizerStarted, undefined)),
        Effect.andThen(Deferred.await(allowFinalizer)),
      ),
    );
    const { close } = yield* makeReactorScopeCloser(scope);
    const fiber = yield* runShutdownWithBudget({
      actions: {
        closeExternalAdmission: Effect.void,
        engineBarrier: Effect.void,
        drainDeliveries: Effect.void,
        closeProviderIngress: Effect.void,
        drainProviderIngestion: Effect.void,
        drainRemainingReactors: Effect.void,
        internalEngineBarrier: Effect.void,
        interruptActiveTargets: Effect.void,
        sealAndStopEngine: Deferred.await(enterFinalizer),
        closeReactorScope: close,
      },
      forced: Deferred.succeed(forcedStarted, undefined).pipe(Effect.andThen(close)),
      budgetMs: 4_000,
      forcedBudgetMs: 2_000,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("3999 millis");
    assert.equal(yield* Deferred.isDone(finalizerStarted), false);
    yield* Deferred.succeed(enterFinalizer, undefined);
    yield* Deferred.await(finalizerStarted);
    yield* TestClock.adjust("1 millis");
    yield* Deferred.await(forcedStarted);
    assert.equal(yield* Ref.get(starts), 1);
    assert.equal(fiber.pollUnsafe(), undefined);

    yield* Deferred.succeed(allowFinalizer, undefined);
    yield* Fiber.join(fiber);
    assert.equal(yield* Ref.get(starts), 1);
  }),
);

it.effect("bounds a forced handoff waiting on the graceful reactor close fiber", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const enterFinalizer = yield* Deferred.make<void>();
    const finalizerStarted = yield* Deferred.make<void>();
    const allowFinalizer = yield* Deferred.make<void>();
    const forcedStarted = yield* Deferred.make<void>();
    const forcedTimedOut = yield* Deferred.make<void>();
    const starts = yield* Ref.make(0);
    yield* Scope.addFinalizer(
      scope,
      Ref.update(starts, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(finalizerStarted, undefined)),
        Effect.andThen(Deferred.await(allowFinalizer)),
      ),
    );
    const { close } = yield* makeReactorScopeCloser(scope);
    const fiber = yield* runShutdownWithBudget({
      actions: {
        closeExternalAdmission: Effect.void,
        engineBarrier: Effect.void,
        drainDeliveries: Effect.void,
        closeProviderIngress: Effect.void,
        drainProviderIngestion: Effect.void,
        drainRemainingReactors: Effect.void,
        internalEngineBarrier: Effect.void,
        interruptActiveTargets: Effect.void,
        sealAndStopEngine: Deferred.await(enterFinalizer),
        closeReactorScope: close,
      },
      forced: Deferred.succeed(forcedStarted, undefined).pipe(Effect.andThen(close)),
      onForcedTimeout: Deferred.succeed(forcedTimedOut, undefined),
      budgetMs: 4_000,
      forcedBudgetMs: 2_000,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("3999 millis");
    assert.equal(yield* Deferred.isDone(finalizerStarted), false);
    yield* Deferred.succeed(enterFinalizer, undefined);
    yield* Deferred.await(finalizerStarted);
    yield* TestClock.adjust("1 millis");
    yield* Deferred.await(forcedStarted);
    yield* TestClock.adjust("2 seconds");
    yield* Deferred.await(forcedTimedOut);
    yield* Fiber.join(fiber);
    assert.equal(yield* Ref.get(starts), 1);

    yield* Deferred.succeed(allowFinalizer, undefined);
    yield* close;
    assert.equal(yield* Ref.get(starts), 1);
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
