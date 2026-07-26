import { EventId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { OrchestrationReactorDeliveriesLive } from "./OrchestrationReactorDeliveries.ts";
import { OrchestrationReactorDeliveries } from "../Services/OrchestrationReactorDeliveries.ts";

const testLayer = OrchestrationReactorDeliveriesLive.pipe(Layer.provide(SqlitePersistenceMemory));

const makeDelivery = (
  deliveryId: string,
  sourceSequence: number,
  reactor = "provider-command",
  sourceEventId = `event-${deliveryId}`,
) => ({
  deliveryId,
  sourceSequence,
  sourceEventId: EventId.make(sourceEventId),
  threadId: ThreadId.make("thread-1"),
  reactor,
  deliveryKind: "turn-start" as const,
  replayPolicy: "cancel-with-recovery" as const,
  sourceBootId: "boot-1",
  payload: { deliveryId },
  commandId: null,
  createdAt: "2026-07-26T00:00:00.000Z",
});

it.layer(testLayer)("OrchestrationReactorDeliveries", (it) => {
  it.effect("leases, retries, and blocks globally ordered durable delivery work", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationReactorDeliveries;
      yield* repository.insert(makeDelivery("later", 2));
      yield* repository.insert(makeDelivery("earlier", 1));
      yield* repository.insert(makeDelivery("earlier", 1));

      expect((yield* repository.listPendingOrdered()).map((row) => row.deliveryId)).toEqual([
        "earlier",
        "later",
      ]);

      const firstClaim = Option.getOrThrow(
        yield* repository.claimNext({
          claimToken: "claim-earlier-1",
          claimedAt: "2026-07-26T00:00:01.000Z",
          leaseExpiresAt: "2026-07-26T00:00:10.000Z",
        }),
      );
      expect(firstClaim).toMatchObject({
        deliveryId: "earlier",
        claimToken: "claim-earlier-1",
        attempts: 1,
      });

      const duplicateClaim = Option.getOrThrow(
        yield* repository.claimNext({
          claimToken: "claim-earlier-1",
          claimedAt: "2026-07-26T00:00:05.000Z",
          leaseExpiresAt: "2026-07-26T00:00:15.000Z",
        }),
      );
      expect(duplicateClaim.attempts).toBe(1);
      expect(
        Option.isNone(
          yield* repository.claimNext({
            claimToken: "claim-earlier-other-worker",
            claimedAt: "2026-07-26T00:00:05.000Z",
            leaseExpiresAt: "2026-07-26T00:00:15.000Z",
          }),
        ),
      ).toBe(true);

      const activeReadiness = yield* repository.inspectReadiness("2026-07-26T00:00:05.000Z");
      expect(activeReadiness.counts).toEqual({
        total: 2,
        pending: 1,
        delivering: 1,
        staleDelivering: 0,
        deadLetter: 0,
      });
      expect(Option.getOrThrow(activeReadiness.oldest).kind).toBe("delivering");

      const staleReadiness = yield* repository.inspectReadiness("2026-07-26T00:00:11.000Z");
      expect(staleReadiness.counts.staleDelivering).toBe(1);
      expect(Option.getOrThrow(staleReadiness.oldest).kind).toBe("stale-delivering");

      const reclaimed = Option.getOrThrow(
        yield* repository.claimNext({
          claimToken: "claim-earlier-2",
          claimedAt: "2026-07-26T00:00:11.000Z",
          leaseExpiresAt: "2026-07-26T00:00:20.000Z",
        }),
      );
      expect(reclaimed).toMatchObject({ claimToken: "claim-earlier-2", attempts: 2 });
      expect(
        yield* repository.markDelivered("earlier", "claim-earlier-1", "2026-07-26T00:00:12.000Z"),
      ).toBe(false);
      expect(
        yield* repository.markDelivered("earlier", "claim-earlier-2", "2026-07-26T00:00:12.000Z"),
      ).toBe(true);

      const laterClaim = Option.getOrThrow(
        yield* repository.claimNext({
          claimToken: "claim-later",
          claimedAt: "2026-07-26T00:00:13.000Z",
          leaseExpiresAt: "2026-07-26T00:00:20.000Z",
        }),
      );
      expect(laterClaim.deliveryId).toBe("later");
      expect(
        yield* repository.markDelivered("later", "claim-later", "2026-07-26T00:00:14.000Z"),
      ).toBe(true);

      yield* repository.insert(makeDelivery("reactor-alpha", 10, "alpha", "event-reactors"));
      yield* repository.insert(makeDelivery("reactor-beta", 10, "beta", "event-reactors"));
      expect(
        Option.isNone(
          yield* repository.claimNext({
            claimToken: "claim-beta-too-early",
            claimedAt: "2026-07-26T00:00:15.000Z",
            leaseExpiresAt: "2026-07-26T00:00:20.000Z",
            reactor: "beta",
          }),
        ),
      ).toBe(true);

      const alphaClaim = Option.getOrThrow(
        yield* repository.claimNext({
          claimToken: "claim-alpha",
          claimedAt: "2026-07-26T00:00:15.000Z",
          leaseExpiresAt: "2026-07-26T00:00:20.000Z",
          reactor: "alpha",
        }),
      );
      expect(alphaClaim.deliveryId).toBe("reactor-alpha");
      expect(
        yield* repository.markCancelled("reactor-alpha", "2026-07-26T00:00:16.000Z", "wrong-claim"),
      ).toBe(false);
      expect(
        yield* repository.markCancelled("reactor-alpha", "2026-07-26T00:00:16.000Z", "claim-alpha"),
      ).toBe(true);

      const betaClaim = Option.getOrThrow(
        yield* repository.claimNext({
          claimToken: "claim-beta",
          claimedAt: "2026-07-26T00:00:16.000Z",
          leaseExpiresAt: "2026-07-26T00:00:20.000Z",
          reactor: "beta",
        }),
      );
      expect(betaClaim.deliveryId).toBe("reactor-beta");
      expect(
        yield* repository.markDelivered("reactor-beta", "claim-beta", "2026-07-26T00:00:17.000Z"),
      ).toBe(true);

      yield* repository.insert(makeDelivery("cancel-pending", 12));
      expect(yield* repository.markCancelled("cancel-pending", "2026-07-26T00:00:18.000Z")).toBe(
        true,
      );
      expect(yield* repository.markCancelled("cancel-pending", "2026-07-26T00:00:18.000Z")).toBe(
        false,
      );

      yield* repository.insert(makeDelivery("poison", 20));
      yield* repository.insert(makeDelivery("behind-poison", 21));
      yield* repository.claimNext({
        claimToken: "claim-poison-1",
        claimedAt: "2026-07-26T00:00:20.000Z",
        leaseExpiresAt: "2026-07-26T00:00:21.000Z",
      });
      expect(
        yield* repository.recordFailure(
          "poison",
          "claim-poison-1",
          "2026-07-26T00:00:20.500Z",
          "first failure",
          2,
          "2026-07-26T00:00:21.500Z",
        ),
      ).toEqual(Option.some("pending"));
      expect(Option.getOrThrow(yield* repository.getById("poison"))).toMatchObject({
        status: "pending",
        attempts: 1,
        lastError: "first failure",
        lastFailedAt: "2026-07-26T00:00:20.500Z",
        nextAttemptAt: "2026-07-26T00:00:21.500Z",
      });

      expect(
        Option.isNone(
          yield* repository.claimNext({
            claimToken: "claim-poison-too-soon",
            claimedAt: "2026-07-26T00:00:21.000Z",
            leaseExpiresAt: "2026-07-26T00:00:22.000Z",
          }),
        ),
      ).toBe(true);

      yield* repository.claimNext({
        claimToken: "claim-poison-2",
        claimedAt: "2026-07-26T00:00:21.500Z",
        leaseExpiresAt: "2026-07-26T00:00:22.000Z",
      });
      expect(
        yield* repository.recordFailure(
          "poison",
          "claim-poison-2",
          "2026-07-26T00:00:21.500Z",
          "second failure",
          2,
          "2026-07-26T00:00:26.500Z",
        ),
      ).toEqual(Option.some("dead-letter"));
      expect(Option.getOrThrow(yield* repository.getById("poison"))).toMatchObject({
        status: "dead-letter",
        attempts: 2,
        lastError: "second failure",
        lastFailedAt: "2026-07-26T00:00:21.500Z",
        deadLetteredAt: "2026-07-26T00:00:21.500Z",
      });
      expect(
        Option.isNone(
          yield* repository.claimNext({
            claimToken: "claim-behind-poison",
            claimedAt: "2026-07-26T00:00:23.000Z",
            leaseExpiresAt: "2026-07-26T00:00:30.000Z",
          }),
        ),
      ).toBe(true);

      expect((yield* repository.listUnresolvedOrdered()).map((row) => row.deliveryId)).toEqual([
        "poison",
        "behind-poison",
      ]);
      const blockedReadiness = yield* repository.inspectReadiness("2026-07-26T00:00:23.000Z");
      expect(blockedReadiness.counts).toEqual({
        total: 2,
        pending: 1,
        delivering: 0,
        staleDelivering: 0,
        deadLetter: 1,
      });
      expect(Option.getOrThrow(blockedReadiness.oldest)).toMatchObject({
        kind: "dead-letter",
        delivery: { deliveryId: "poison" },
      });
    }),
  );
});
