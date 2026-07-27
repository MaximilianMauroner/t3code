import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { make, writeActiveTurnCountAtomically } from "./ActiveTurnCountPublisher.ts";

describe("ActiveTurnCountPublisher", () => {
  it.effect(
    "publishes bounded samples without touching command queues and clears on shutdown",
    () =>
      Effect.gen(function* () {
        const count = yield* Ref.make(3);
        const writes: Array<number> = [];

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* make({
              sampleIntervalMs: 1_000,
              readActiveTurnCount: Ref.get(count),
              writeCount: (value) =>
                Effect.sync(() => {
                  writes.push(value);
                }),
            });
            assert.deepEqual(writes, [3]);

            yield* Ref.set(count, -4);
            yield* TestClock.adjust("1 second");
            yield* Effect.yieldNow;
            assert.deepEqual(writes, [3, 0]);

            yield* Ref.set(count, Number.POSITIVE_INFINITY);
            yield* TestClock.adjust("1 second");
            yield* Effect.yieldNow;
            assert.deepEqual(writes, [3, 0, 0]);

            const metrics = yield* Metric.snapshot;
            const activeTurns = metrics.find((sample) => sample.id === "t3_active_turns");
            assert.deepEqual(activeTurns?.state, { value: 0 });
          }),
        );

        assert.deepEqual(writes, [3, 0, 0, 0]);
      }),
  );

  it.effect("atomically replaces only a regular telemetry file", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-active-turns-"))),
      (directory) =>
        Effect.gen(function* () {
          const filePath = NodePath.join(directory, "active-turn-count");
          NodeFS.writeFileSync(filePath, "99\n", { mode: 0o640 });

          yield* writeActiveTurnCountAtomically(filePath, 7);
          assert.equal(NodeFS.readFileSync(filePath, "utf8"), "7\n");

          const foreignPath = NodePath.join(directory, "foreign");
          const symlinkPath = NodePath.join(directory, "active-turn-count-link");
          NodeFS.writeFileSync(foreignPath, "foreign\n");
          NodeFS.symlinkSync(foreignPath, symlinkPath);
          const exit = yield* Effect.exit(writeActiveTurnCountAtomically(symlinkPath, 4));
          assert.equal(exit._tag, "Failure");
          assert.equal(NodeFS.readFileSync(foreignPath, "utf8"), "foreign\n");
        }),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    ),
  );
});
