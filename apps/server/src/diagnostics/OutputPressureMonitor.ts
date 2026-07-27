// @effect-diagnostics nodeBuiltinImport:off
import * as NodePerfHooks from "node:perf_hooks";

import type { DrainableWorkerPressure } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";

import {
  eventLoopDelay,
  eventLoopHealthy,
  ingestionWorkerDepth,
  ingestionWorkerOldestAge,
  metricAttributes,
} from "../observability/Metrics.ts";

const DEFAULT_RESOLUTION_MS = 20;
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export const OUTPUT_PRESSURE_SIGNAL_THRESHOLDS = {
  healthP99Ms: 2_000,
  eventLoopP99Ms: 250,
  eventLoopSustainedMs: 30_000,
  ingestionOldestAgeMs: 5_000,
} as const;

export interface EventLoopDelayPercentiles {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface OutputPressureSnapshot {
  readonly enabled: boolean;
  readonly sampledAtMs: number | null;
  readonly health: "healthy" | "degraded";
  readonly eventLoop: EventLoopDelayPercentiles;
}

export interface EventLoopDelayHistogram {
  readonly enable: () => boolean;
  readonly disable: () => boolean;
  readonly percentile: (percentile: number) => number;
  readonly reset: () => void;
}

export interface OutputPressureMonitorOptions {
  readonly enabled?: boolean;
  readonly resolutionMs?: number;
  readonly sampleIntervalMs?: number;
  readonly histogram?: EventLoopDelayHistogram;
}

export type OutputPressureWorkerSource =
  | "provider-runtime-ingestion"
  | "provider-command"
  | "checkpoint"
  | "orchestration-delivery";

export class OutputPressureMonitor extends Context.Service<
  OutputPressureMonitor,
  {
    readonly snapshot: Effect.Effect<OutputPressureSnapshot>;
    readonly recordWorkerPressure: (
      worker: OutputPressureWorkerSource,
      pressure: DrainableWorkerPressure,
    ) => Effect.Effect<void>;
  }
>()("t3/diagnostics/OutputPressureMonitor") {}

function percentileMs(histogram: EventLoopDelayHistogram, percentile: number): number {
  const value = histogram.percentile(percentile);
  return Number.isFinite(value) ? value / NANOSECONDS_PER_MILLISECOND : 0;
}

export const make = Effect.fn("OutputPressureMonitor.make")(function* (
  options: OutputPressureMonitorOptions = {},
) {
  const enabled = options.enabled ?? true;
  const resolution = Math.max(10, Math.round(options.resolutionMs ?? DEFAULT_RESOLUTION_MS));
  const sampleIntervalMs = Math.max(
    10,
    Math.round(options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS),
  );
  const histogram = options.histogram ?? NodePerfHooks.monitorEventLoopDelay({ resolution });
  const initialSnapshot: OutputPressureSnapshot = {
    enabled,
    sampledAtMs: null,
    health: "healthy",
    eventLoop: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
  };
  const latest = yield* Ref.make(initialSnapshot);
  const eventLoopPressureSinceMs = yield* Ref.make<number | null>(null);

  if (enabled) {
    yield* Effect.acquireRelease(
      Effect.sync(() => histogram.enable()),
      () => Effect.sync(() => histogram.disable()),
    );
  }

  const sampleOnce = Effect.fn("OutputPressureMonitor.sampleOnce")(function* () {
    const sampledAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const eventLoop = {
      p50Ms: percentileMs(histogram, 50),
      p95Ms: percentileMs(histogram, 95),
      p99Ms: percentileMs(histogram, 99),
    };
    histogram.reset();
    const previousPressureSinceMs = yield* Ref.get(eventLoopPressureSinceMs);
    const pressureSinceMs =
      eventLoop.p99Ms >= OUTPUT_PRESSURE_SIGNAL_THRESHOLDS.eventLoopP99Ms
        ? (previousPressureSinceMs ?? sampledAtMs)
        : null;
    yield* Ref.set(eventLoopPressureSinceMs, pressureSinceMs);
    const health =
      pressureSinceMs !== null &&
      sampledAtMs - pressureSinceMs >= OUTPUT_PRESSURE_SIGNAL_THRESHOLDS.eventLoopSustainedMs
        ? "degraded"
        : "healthy";
    const sample: OutputPressureSnapshot = {
      enabled: true,
      sampledAtMs,
      health,
      eventLoop,
    };
    yield* Ref.set(latest, sample);
    yield* Effect.all(
      [
        Metric.update(
          Metric.withAttributes(eventLoopDelay, [["quantile", "p50"]]),
          sample.eventLoop.p50Ms,
        ),
        Metric.update(
          Metric.withAttributes(eventLoopDelay, [["quantile", "p95"]]),
          sample.eventLoop.p95Ms,
        ),
        Metric.update(
          Metric.withAttributes(eventLoopDelay, [["quantile", "p99"]]),
          sample.eventLoop.p99Ms,
        ),
        Metric.update(eventLoopHealthy, sample.health === "healthy" ? 1 : 0),
      ],
      { discard: true },
    );
  });

  if (enabled) {
    yield* Effect.sleep(sampleIntervalMs).pipe(
      Effect.andThen(sampleOnce()),
      Effect.forever,
      Effect.forkScoped,
    );
  }

  const snapshot = Ref.get(latest);

  const recordWorkerPressure = (
    worker: OutputPressureWorkerSource,
    pressure: DrainableWorkerPressure,
  ): Effect.Effect<void> => {
    const attributes = metricAttributes({ worker });
    return Effect.all(
      [
        Metric.update(Metric.withAttributes(ingestionWorkerDepth, attributes), pressure.depth),
        Metric.update(
          Metric.withAttributes(ingestionWorkerOldestAge, attributes),
          pressure.oldestAgeMs,
        ),
      ],
      { discard: true },
    );
  };

  return OutputPressureMonitor.of({ snapshot, recordWorkerPressure });
});

export const layerWithOptions = (options: OutputPressureMonitorOptions = {}) =>
  Layer.effect(OutputPressureMonitor, make(options));

export const layer = layerWithOptions();

export const disabledLayer = Layer.succeed(
  OutputPressureMonitor,
  OutputPressureMonitor.of({
    snapshot: Effect.succeed({
      enabled: false,
      sampledAtMs: null,
      health: "healthy",
      eventLoop: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
    }),
    recordWorkerPressure: () => Effect.void,
  }),
);
