import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveCodexUsageSnapshot, type CodexUsageRawPayload } from "./codexUsage.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const bucket = (limitId: string, usedPercent: number) => ({
  limitId,
  primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: usedPercent + 10, windowDurationMins: 10_080 },
});
const resolve = (model: string, payload: CodexUsageRawPayload) =>
  resolveCodexUsageSnapshot({ providerInstanceId, model, payload, source: "read" });

describe("resolveCodexUsageSnapshot", () => {
  it("selects exact model buckets and echoes the model", () => {
    const payload = {
      rateLimitsByLimitId: {
        "gpt-5.2": bucket("gpt-5.2", 20),
        "gpt-5.3": bucket("gpt-5.3", 70),
      },
    };
    expect(resolve("gpt-5.3", payload)).toMatchObject({
      model: "gpt-5.3",
      limitId: "gpt-5.3",
      windows: [
        { label: "5h", remainingPercent: 30 },
        { label: "1w", remainingPercent: 20 },
      ],
    });
  });

  it("uses a generic bucket only when it is the sole bucket", () => {
    expect(
      resolve("gpt-5.3", { rateLimitsByLimitId: { codex: bucket("codex", 25) } })?.windows[0]
        ?.remainingPercent,
    ).toBe(75);
    expect(
      resolve("gpt-5.3", {
        rateLimitsByLimitId: { codex: bucket("codex", 25), other: bucket("other", 10) },
      }),
    ).toBeNull();
  });

  it("never falls back to the first unmatched model bucket", () => {
    expect(
      resolve("gpt-5.3", {
        rateLimitsByLimitId: {
          "gpt-5.2": bucket("gpt-5.2", 20),
          unknown: bucket("unknown", 30),
        },
      }),
    ).toBeNull();
  });

  it("clamps values and tolerates missing reset data", () => {
    expect(
      resolve("gpt-5.3", {
        rateLimits: { limitId: "codex", primary: { usedPercent: 120 } },
      })?.windows[0],
    ).toMatchObject({ usedPercent: 100, remainingPercent: 0, resetsAt: null });
  });

  it("returns unavailable for empty or malformed windows", () => {
    expect(resolve("gpt-5.3", {})).toBeNull();
    expect(
      resolve("gpt-5.3", {
        rateLimits: { limitId: "codex", primary: { usedPercent: Number.NaN } },
      }),
    ).toBeNull();
  });
});
