// @effect-diagnostics nodeBuiltinImport:off
import * as NodePerfHooks from "node:perf_hooks";

import type { DrainableWorkerPressure } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";

import {
  eventLoopDelay,
  ingestionWorkerDepth,
  ingestionWorkerOldestAge,
  metricAttributes,
} from "../observability/Metrics.ts";

const DEFAULT_RESOLUTION_MS = 20;
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
  readonly eventLoop: EventLoopDelayPercentiles;
}

export interface OutputPressureMonitorOptions {
  readonly enabled?: boolean;
  readonly resolutionMs?: number;
}

export class OutputPressureMonitor extends Context.Service<
  OutputPressureMonitor,
  {
    readonly snapshot: Effect.Effect<OutputPressureSnapshot>;
    readonly recordWorkerPressure: (
      worker: string,
      pressure: DrainableWorkerPressure,
    ) => Effect.Effect<void>;
  }
>()("t3/diagnostics/OutputPressureMonitor") {}

function percentileMs(histogram: NodePerfHooks.IntervalHistogram, percentile: number): number {
  const value = histogram.percentile(percentile);
  return Number.isFinite(value) ? value / NANOSECONDS_PER_MILLISECOND : 0;
}

export const make = Effect.fn("OutputPressureMonitor.make")(function* (
  options: OutputPressureMonitorOptions = {},
) {
  const enabled = options.enabled ?? true;
  const resolution = Math.max(10, Math.round(options.resolutionMs ?? DEFAULT_RESOLUTION_MS));
  const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution });

  if (enabled) {
    yield* Effect.acquireRelease(
      Effect.sync(() => histogram.enable()),
      () => Effect.sync(() => histogram.disable()),
    );
  }

  const snapshot = Effect.sync((): OutputPressureSnapshot => {
    if (!enabled) {
      return {
        enabled: false,
        eventLoop: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
      };
    }
    const eventLoop = {
      p50Ms: percentileMs(histogram, 50),
      p95Ms: percentileMs(histogram, 95),
      p99Ms: percentileMs(histogram, 99),
    };
    histogram.reset();
    return { enabled: true, eventLoop };
  }).pipe(
    Effect.tap((sample) =>
      enabled
        ? Effect.all(
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
            ],
            { discard: true },
          )
        : Effect.void,
    ),
  );

  const recordWorkerPressure = (
    worker: string,
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

export const layer = Layer.effect(OutputPressureMonitor, make());

export const disabledLayer = Layer.succeed(
  OutputPressureMonitor,
  OutputPressureMonitor.of({
    snapshot: Effect.succeed({
      enabled: false,
      eventLoop: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
    }),
    recordWorkerPressure: () => Effect.void,
  }),
);
