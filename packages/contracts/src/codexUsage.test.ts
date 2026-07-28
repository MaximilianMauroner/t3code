import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CodexUsageSnapshot } from "./providerRuntime.ts";

const decodeCodexUsageSnapshot = Schema.decodeUnknownSync(CodexUsageSnapshot);

describe("CodexUsageSnapshot", () => {
  it("round trips a model-bound usage snapshot", () => {
    const value = {
      providerInstanceId: "codex",
      model: "gpt-5.3-codex",
      limitId: "gpt-5.3-codex",
      checkedAt: "2026-07-27T00:00:00.000Z",
      windows: [
        {
          label: "5h",
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: null,
          windowDurationMins: 300,
        },
      ],
      rateLimitReachedType: null,
      source: "read",
    };
    expect(decodeCodexUsageSnapshot(value)).toEqual(value);
  });
});
