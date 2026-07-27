/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;

  /** A cheap, side-effect-free pressure sample. Depth includes active work. */
  readonly pressure: Effect.Effect<DrainableWorkerPressure>;
}

export interface DrainableWorkerPressure {
  readonly depth: number;
  readonly oldestAgeMs: number;
}

interface QueuedItem<A> {
  readonly id: number;
  readonly item: A;
  readonly enqueuedAtMs: number;
}

interface WorkerState {
  readonly nextId: number;
  readonly pending: ReadonlyArray<{
    readonly id: number;
    readonly enqueuedAtMs: number;
  }>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      TxQueue.unbounded<QueuedItem<A>>(),
      TxQueue.shutdown,
    );
    const state = yield* TxRef.make<WorkerState>({ nextId: 0, pending: [] });

    yield* TxQueue.take(queue).pipe(
      Effect.tap((queued) =>
        Effect.ensuring(
          process(queued.item),
          TxRef.update(state, (current) => ({
            ...current,
            pending: current.pending.filter((pending) => pending.id !== queued.id),
          })),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(state).pipe(
      Effect.tap((current) => (current.pending.length > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = Effect.fn("DrainableWorker.enqueue")(function* (element: A) {
      const enqueuedAtMs = yield* Clock.currentTimeMillis;
      yield* TxRef.modify(state, (current) => {
        const queued = { id: current.nextId, item: element, enqueuedAtMs } satisfies QueuedItem<A>;
        return [
          queued,
          {
            nextId: current.nextId + 1,
            pending: [...current.pending, { id: queued.id, enqueuedAtMs }],
          },
        ] as const;
      }).pipe(
        Effect.flatMap((queued) => TxQueue.offer(queue, queued)),
        Effect.tx,
      );
    });

    const pressure = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const current = yield* TxRef.get(state).pipe(Effect.tx);
      const oldest = current.pending[0];
      return {
        depth: current.pending.length,
        oldestAgeMs: oldest === undefined ? 0 : Math.max(0, now - oldest.enqueuedAtMs),
      } satisfies DrainableWorkerPressure;
    });

    return { enqueue, drain, pressure } satisfies DrainableWorker<A>;
  });
