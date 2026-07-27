import { ThreadId } from "@t3tools/contracts";
import { ProviderSessionNotFoundError, ProviderUnsupportedError } from "../../provider/Errors.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import {
  logCleanupCauseUnlessInterrupted,
  tolerateMissingProviderSession,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("tolerateMissingProviderSession", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  effectIt.effect("continues only when the provider session is already absent", () =>
    tolerateMissingProviderSession({
      effect: Effect.fail(new ProviderSessionNotFoundError({ threadId })),
      threadId,
    }),
  );

  effectIt.effect("propagates other provider failures", () =>
    Effect.gen(function* () {
      const error = new ProviderUnsupportedError({
        provider: "test",
      });
      const exit = yield* Effect.exit(
        tolerateMissingProviderSession({
          effect: Effect.fail(error),
          threadId,
        }),
      );
      expect(exit).toEqual(Exit.fail(error));
    }),
  );
});
