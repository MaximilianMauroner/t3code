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

  it("uses the generic bucket when dedicated model buckets do not match", () => {
    expect(
      resolve("gpt-5.3", { rateLimitsByLimitId: { codex: bucket("codex", 25) } })?.windows[0]
        ?.remainingPercent,
    ).toBe(75);
    const payload = {
      rateLimitsByLimitId: {
        codex: bucket("codex", 25),
        codex_bengalfox: {
          ...bucket("codex_bengalfox", 10),
          limitName: "GPT-5.3-Codex-Spark",
        },
      },
    };
    expect(resolve("gpt-5.6-sol", payload)?.windows[0]?.remainingPercent).toBe(75);
    expect(resolve("gpt-5.3-codex-spark", payload)?.windows[0]?.remainingPercent).toBe(90);
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

  it("rejects prefix and suffix collisions", () => {
    expect(
      resolve("gpt-5.3", {
        rateLimitsByLimitId: {
          "gpt-5.3-mini": bucket("gpt-5.3-mini", 20),
        },
      }),
    ).toBeNull();
    expect(
      resolve("gpt-5.3-codex", {
        rateLimitsByLimitId: {
          "preview-gpt-5.3-codex": bucket("preview-gpt-5.3-codex", 20),
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

  it("requires an explicit legacy identity and honors an exact limit name", () => {
    expect(
      resolve("gpt-5.3-codex", {
        rateLimits: { primary: { usedPercent: 20 } },
      }),
    ).toBeNull();
    expect(
      resolve("gpt-5.3-codex", {
        rateLimits: {
          limitName: "gpt-5.3-codex",
          primary: { usedPercent: 20 },
        },
      })?.limitId,
    ).toBe("gpt-5.3-codex");
    expect(
      resolve("gpt-5.3-codex", {
        rateLimits: {
          limitName: "gpt-5.3-codex-preview",
          primary: { usedPercent: 20 },
        },
      }),
    ).toBeNull();
  });

  it("preserves an authoritative observed timestamp", () => {
    expect(
      resolveCodexUsageSnapshot({
        providerInstanceId,
        model: "gpt-5.3-codex",
        payload: { rateLimitsByLimitId: { "gpt-5.3-codex": bucket("gpt-5.3-codex", 20) } },
        source: "cache",
        checkedAt: "2026-01-01T00:00:00.000Z",
        now: new Date("2027-01-01T00:00:00.000Z"),
      })?.checkedAt,
    ).toBe("2026-01-01T00:00:00.000Z");
  });
});
