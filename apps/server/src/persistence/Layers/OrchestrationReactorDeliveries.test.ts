import { EventId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { OrchestrationReactorDeliveriesLive } from "./OrchestrationReactorDeliveries.ts";
import { OrchestrationReactorDeliveries } from "../Services/OrchestrationReactorDeliveries.ts";

const testLayer = OrchestrationReactorDeliveriesLive.pipe(Layer.provide(SqlitePersistenceMemory));

it.layer(testLayer)("OrchestrationReactorDeliveries", (it) => {
  it.effect("orders, claims, and terminally settles durable deliveries idempotently", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationReactorDeliveries;
      const makeDelivery = (deliveryId: string, sourceSequence: number) => ({
        deliveryId,
        sourceSequence,
        sourceEventId: EventId.make(`event-${deliveryId}`),
        threadId: ThreadId.make("thread-1"),
        reactor: "provider-command",
        deliveryKind: "turn-start" as const,
        replayPolicy: "cancel-with-recovery" as const,
        sourceBootId: "boot-1",
        payload: { deliveryId },
        commandId: null,
        createdAt: "2026-07-26T00:00:00.000Z",
      });
      yield* repository.insert(makeDelivery("later", 2));
      yield* repository.insert(makeDelivery("earlier", 1));
      yield* repository.insert(makeDelivery("earlier", 1));

      expect((yield* repository.listPendingOrdered()).map((row) => row.deliveryId)).toEqual([
        "earlier",
        "later",
      ]);
      const claimed = yield* repository.claimNext("2026-07-26T00:00:01.000Z");
      expect(Option.getOrThrow(claimed).deliveryId).toBe("earlier");
      expect(Option.getOrThrow(claimed).attempts).toBe(1);
      yield* repository.markCancelled("earlier", "2026-07-26T00:00:02.000Z");
      expect(Option.getOrThrow(yield* repository.getById("earlier")).status).toBe("cancelled");
      expect((yield* repository.listPendingOrdered()).map((row) => row.deliveryId)).toEqual([
        "later",
      ]);
    }),
  );
});
