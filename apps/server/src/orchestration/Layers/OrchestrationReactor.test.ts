import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts and drains command-producing auxiliary reactors separately from ingestion", async () => {
    const started: string[] = [];
    const drained: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => {
              started.push("provider-command-reactor");
              return Effect.void;
            },
            drain: Effect.sync(() => drained.push("provider-command-reactor")),
            deliver: () => Effect.succeed("delivered" as const),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => {
              started.push("checkpoint-reactor");
              return Effect.void;
            },
            drain: Effect.sync(() => drained.push("checkpoint-reactor")),
            deliver: () => Effect.succeed("delivered" as const),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drain: Effect.sync(() => drained.push("thread-deletion-reactor")),
            deliver: () => Effect.succeed("delivered" as const),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
            publishThread: () => Effect.void,
            drain: Effect.sync(() => drained.push("agent-awareness-relay")),
            start: () => {
              started.push("agent-awareness-relay");
              return Effect.void;
            },
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "agent-awareness-relay",
    ]);

    await runtime!.runPromise(reactor.quiesceAndDrain);
    expect(drained).toEqual([
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "agent-awareness-relay",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
