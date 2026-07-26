import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
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
      "reactors-drain",
      "internal-barrier",
      "interrupt",
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
