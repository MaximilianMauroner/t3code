import { OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import type { OrchestrationReactorDelivery } from "../../persistence/Services/OrchestrationReactorDeliveries.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const deliver: ThreadDeletionReactorShape["deliver"] = Effect.fn("deliver")(function* (
    delivery: OrchestrationReactorDelivery,
  ) {
    if (delivery.deliveryKind !== "thread-delete") {
      return yield* Effect.die(`thread deletion reactor cannot handle ${delivery.deliveryKind}`);
    }
    const event = yield* decodeOrchestrationEvent(delivery.payload);
    if (event.type !== "thread.deleted") {
      return yield* Effect.die(`thread-delete delivery contains ${event.type}`);
    }
    yield* providerService.stopSession({ threadId: event.payload.threadId });
    yield* terminalManager.close({ threadId: event.payload.threadId, deleteHistory: true });
    return "delivered" as const;
  });

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.void;
  });

  return {
    start,
    drain: Effect.void,
    deliver,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
