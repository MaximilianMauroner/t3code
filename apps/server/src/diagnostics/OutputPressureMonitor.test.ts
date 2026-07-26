import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import * as OutputPressureMonitor from "./OutputPressureMonitor.ts";

describe("OutputPressureMonitor", () => {
  it.effect("can be disabled without starting event-loop sampling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* OutputPressureMonitor.make({ enabled: false });
        assert.deepEqual(yield* monitor.snapshot, {
          enabled: false,
          eventLoop: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
        });
      }),
    ),
  );

  it.effect("records worker depth and oldest age as signals only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* OutputPressureMonitor.make({ enabled: false });
        yield* monitor.recordWorkerPressure("provider-runtime", {
          depth: 7,
          oldestAgeMs: 6_500,
        });

        const snapshots = yield* Metric.snapshot;
        const depth = snapshots.find(
          (sample) =>
            sample.id === "t3_ingestion_worker_depth" &&
            sample.attributes?.worker === "provider-runtime",
        );
        const age = snapshots.find(
          (sample) =>
            sample.id === "t3_ingestion_worker_oldest_age_ms" &&
            sample.attributes?.worker === "provider-runtime",
        );
        assert.deepEqual(depth?.state, { value: 7 });
        assert.deepEqual(age?.state, { value: 6_500 });
      }),
    ),
  );
});
