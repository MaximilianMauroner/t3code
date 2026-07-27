// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";

import { activeTurns } from "../observability/Metrics.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const DEFAULT_FILE_PATH = "/run/t3code-watchdog/active-turn-count";
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const MAX_ACTIVE_TURN_COUNT = 1_000_000;

export interface ActiveTurnCountPublisherOptions {
  readonly filePath?: string;
  readonly sampleIntervalMs?: number;
  readonly readActiveTurnCount: Effect.Effect<number, unknown>;
  readonly writeCount?: (count: number) => Effect.Effect<void, unknown>;
}

function boundedCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.min(MAX_ACTIVE_TURN_COUNT, Math.max(0, Math.floor(count)));
}

function canPublishTo(filePath: string): boolean {
  try {
    const directory = NodeFS.lstatSync(NodePath.dirname(filePath));
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    if (!NodeFS.existsSync(filePath)) return true;
    const target = NodeFS.lstatSync(filePath);
    return target.isFile() && !target.isSymbolicLink() && target.nlink === 1;
  } catch {
    return false;
  }
}

export function writeActiveTurnCountAtomically(
  filePath: string,
  count: number,
): Effect.Effect<void, unknown> {
  return Effect.try({
    try: () => {
      const directory = NodePath.dirname(filePath);
      const temporaryPath = NodePath.join(
        directory,
        `.${NodePath.basename(filePath)}.${String(process.pid)}.${NodeCrypto.randomUUID()}.tmp`,
      );
      try {
        const directoryStat = NodeFS.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new Error("Active-turn telemetry directory is unsafe.");
        }
        if (NodeFS.existsSync(filePath)) {
          const targetStat = NodeFS.lstatSync(filePath);
          if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
            throw new Error("Active-turn telemetry target is unsafe.");
          }
        }
        NodeFS.writeFileSync(temporaryPath, `${String(boundedCount(count))}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o640,
        });
        NodeFS.renameSync(temporaryPath, filePath);
      } finally {
        NodeFS.rmSync(temporaryPath, { force: true });
      }
    },
    catch: (cause) => cause,
  });
}

export const make = Effect.fn("ActiveTurnCountPublisher.make")(function* (
  options: ActiveTurnCountPublisherOptions,
) {
  const filePath = options.filePath ?? DEFAULT_FILE_PATH;
  const sampleIntervalMs = Math.max(
    100,
    Math.round(options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS),
  );
  const readActiveTurnCount = options.readActiveTurnCount;
  const writeCount =
    options.writeCount ?? ((count: number) => writeActiveTurnCountAtomically(filePath, count));

  if (options.writeCount === undefined && !canPublishTo(filePath)) {
    yield* Effect.logDebug("Active-turn watchdog telemetry is unavailable", { filePath });
    return;
  }

  const publish = readActiveTurnCount.pipe(
    Effect.map(boundedCount),
    Effect.tap((count) => Metric.update(activeTurns, count)),
    Effect.flatMap(writeCount),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to publish active-turn watchdog telemetry", {
        cause,
        filePath,
      }),
    ),
  );

  yield* Effect.addFinalizer(() =>
    writeCount(0).pipe(
      Effect.tap(() => Metric.update(activeTurns, 0)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to clear active-turn watchdog telemetry", {
          cause,
          filePath,
        }),
      ),
    ),
  );
  yield* publish;
  yield* Effect.sleep(sampleIntervalMs).pipe(
    Effect.andThen(publish),
    Effect.forever,
    Effect.forkScoped,
  );
});

const makeLive = Effect.fn("ActiveTurnCountPublisher.makeLive")(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  yield* make({
    readActiveTurnCount:
      snapshotQuery.getActiveTurnCount?.().pipe(Effect.map((row) => row.activeTurnCount)) ??
      snapshotQuery
        .getShellSnapshot()
        .pipe(
          Effect.map(
            (snapshot) =>
              snapshot.threads.filter((thread) => thread.session?.activeTurnId != null).length,
          ),
        ),
  });
});

export const layer = Layer.effectDiscard(makeLive());
