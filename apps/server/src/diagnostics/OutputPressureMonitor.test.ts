import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";

import * as OutputPressureMonitor from "./OutputPressureMonitor.ts";

describe("OutputPressureMonitor", () => {
  it.effect("can be disabled without starting event-loop sampling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* OutputPressureMonitor.make({ enabled: false });
        assert.deepEqual(yield* monitor.snapshot, {
          enabled: false,
          sampledAtMs: null,
          health: "healthy",
          eventLoop: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
        });
      }),
    ),
  );

  it.effect("records worker depth and oldest age as signals only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* OutputPressureMonitor.make({ enabled: false });
        yield* monitor.recordWorkerPressure("provider-runtime-ingestion", {
          depth: 7,
          oldestAgeMs: 6_500,
        });

        const snapshots = yield* Metric.snapshot;
        const depth = snapshots.find(
          (sample) =>
            sample.id === "t3_ingestion_worker_depth" &&
            sample.attributes?.worker === "provider-runtime-ingestion",
        );
        const age = snapshots.find(
          (sample) =>
            sample.id === "t3_ingestion_worker_oldest_age_ms" &&
            sample.attributes?.worker === "provider-runtime-ingestion",
        );
        assert.deepEqual(depth?.state, { value: 7 });
        assert.deepEqual(age?.state, { value: 6_500 });
      }),
    ),
  );

  it.effect("requires event-loop p99 pressure to persist for 30 seconds", () => {
    let enabled = 0;
    let disabled = 0;
    let resets = 0;
    const percentiles = new Map<number, number>([
      [50, 25 * 1_000_000],
      [95, 500 * 1_000_000],
      [99, 250 * 1_000_000],
    ]);

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const monitor = yield* OutputPressureMonitor.OutputPressureMonitor;
        assert.equal(enabled, 1);
        assert.equal(resets, 0);

        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;

        const initialPressure = yield* monitor.snapshot;
        assert.equal(initialPressure.health, "healthy");
        assert.deepEqual(initialPressure.eventLoop, { p50Ms: 25, p95Ms: 500, p99Ms: 250 });
        assert.equal(resets, 1);

        yield* TestClock.adjust("25 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* monitor.snapshot).health, "healthy");

        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* monitor.snapshot).health, "degraded");

        const metrics = yield* Metric.snapshot;
        const health = metrics.find((sample) => sample.id === "t3_event_loop_healthy");
        assert.deepEqual(health?.state, { value: 0 });
      }).pipe(
        Effect.provide(
          OutputPressureMonitor.layerWithOptions({
            sampleIntervalMs: 5_000,
            histogram: {
              enable: () => {
                enabled += 1;
                return true;
              },
              disable: () => {
                disabled += 1;
                return true;
              },
              percentile: (percentile) => percentiles.get(percentile) ?? 0,
              reset: () => {
                resets += 1;
              },
            },
          }),
        ),
      );
      assert.equal(disabled, 1);
    });
  });

  it.effect("resets the sustained window after a healthy sample", () => {
    let p99Ms = 251;

    return Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* OutputPressureMonitor.OutputPressureMonitor;

        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("25 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* monitor.snapshot).health, "healthy");

        p99Ms = 249;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* monitor.snapshot).health, "healthy");

        p99Ms = 251;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("25 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* monitor.snapshot).health, "healthy");

        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* monitor.snapshot).health, "degraded");
      }).pipe(
        Effect.provide(
          OutputPressureMonitor.layerWithOptions({
            sampleIntervalMs: 5_000,
            histogram: {
              enable: () => true,
              disable: () => true,
              percentile: (percentile) =>
                (percentile === 99 ? p99Ms : percentile === 95 ? 100 : 25) * 1_000_000,
              reset: () => undefined,
            },
          }),
        ),
      ),
    );
  });
});
