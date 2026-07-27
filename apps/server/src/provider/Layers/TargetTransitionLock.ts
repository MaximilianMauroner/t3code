import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * Per-target transition lock used only around short state-mutation + event
 * enqueue boundaries. Callers must not acquire it recursively or hold it
 * while waiting for a model/provider response.
 */
export interface TargetTransitionLock {
  readonly withTarget: <A, E, R>(
    target: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export const makeTargetTransitionLock = Effect.fn("makeTargetTransitionLock")(function* () {
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const get = (target: string) =>
    SynchronizedRef.modifyEffect(locks, (current) =>
      Option.match(Option.fromNullishOr(current.get(target)), {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(target, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      }),
    );
  return {
    withTarget: (target, effect) =>
      Effect.flatMap(get(target), (semaphore) => semaphore.withPermit(effect)),
  } satisfies TargetTransitionLock;
});
