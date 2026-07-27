import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeTargetTransitionLock } from "./TargetTransitionLock.ts";

const adapters = ["codex", "claude", "cursor", "grok", "opencode"] as const;
const terminalEvents = ["turn.completed", "runtime.error", "session.exited"] as const;

describe("TargetTransitionLock", () => {
  for (const adapter of adapters) {
    for (const terminalEvent of terminalEvents) {
      it.effect(`${adapter} marker cannot overtake a paused ${terminalEvent} transition`, () =>
        Effect.gen(function* () {
          const transitions = yield* makeTargetTransitionLock();
          const state = yield* Ref.make("running");
          const observed = yield* Ref.make<ReadonlyArray<string>>([]);
          const mutationCompleted = yield* Deferred.make<void>();
          const allowEnqueue = yield* Deferred.make<void>();

          const transitionFiber = yield* transitions
            .withTarget(
              `${adapter}-thread`,
              Effect.gen(function* () {
                yield* Ref.set(state, "terminal");
                yield* Deferred.succeed(mutationCompleted, undefined);
                yield* Deferred.await(allowEnqueue);
                yield* Ref.update(observed, (events) => [...events, terminalEvent]);
              }),
            )
            .pipe(Effect.forkChild);

          yield* Deferred.await(mutationCompleted);
          const markerFiber = yield* transitions
            .withTarget(
              `${adapter}-thread`,
              Effect.gen(function* () {
                const sample = yield* Ref.get(state);
                yield* Ref.update(observed, (events) => [...events, `marker:${sample}`]);
              }),
            )
            .pipe(Effect.forkChild);

          yield* Effect.yieldNow;
          assert.isUndefined(markerFiber.pollUnsafe());
          assert.deepEqual(yield* Ref.get(observed), []);

          yield* Deferred.succeed(allowEnqueue, undefined);
          yield* Fiber.join(transitionFiber);
          yield* Fiber.join(markerFiber);

          assert.deepEqual(yield* Ref.get(observed), [terminalEvent, "marker:terminal"]);
        }),
      );
    }
  }
});
