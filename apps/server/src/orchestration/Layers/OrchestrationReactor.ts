import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const auxiliaryScope = yield* Scope.fork(yield* Effect.scope, "sequential");

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerCommandReactor.start().pipe(Scope.provide(auxiliaryScope));
    yield* checkpointReactor.start().pipe(Scope.provide(auxiliaryScope));
    yield* threadDeletionReactor.start().pipe(Scope.provide(auxiliaryScope));
    yield* agentAwarenessRelay.start().pipe(Scope.provide(auxiliaryScope));
  });

  const quiesceAndDrain = Scope.close(auxiliaryScope, Exit.void).pipe(
    Effect.andThen(providerCommandReactor.quiesceAndDrain),
    Effect.andThen(checkpointReactor.drain),
    Effect.andThen(threadDeletionReactor.drain),
    Effect.andThen(agentAwarenessRelay.quiesceAndDrain),
  );

  return {
    start,
    quiesceAndDrain,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
