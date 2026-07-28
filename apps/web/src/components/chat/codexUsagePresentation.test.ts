import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CodexUsageSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { canShowCodexUsage, codexUsagePresentation } from "./codexUsagePresentation";

const snapshot = {
  providerInstanceId: ProviderInstanceId.make("codex"),
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
    {
      label: "1w",
      usedPercent: 60,
      remainingPercent: 40,
      resetsAt: "2026-07-28T00:00:00.000Z",
      windowDurationMins: 10_080,
    },
  ],
  rateLimitReachedType: null,
  source: "read",
} satisfies CodexUsageSnapshot;

describe("codexUsagePresentation", () => {
  it("shows every applicable window as remaining usage with reset details", () => {
    const presentation = codexUsagePresentation(snapshot);
    expect(presentation.summary).toBe("5h 80% left · 1w 40% left");
    expect(presentation.details).toContain("1w: 40% left, resets");
  });

  it("clearly marks retained data as cached", () => {
    expect(codexUsagePresentation({ ...snapshot, source: "cache" }).details).toContain(
      "last successful reading",
    );
  });
});

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt" },
  checkedAt: "2026-07-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

describe("canShowCodexUsage", () => {
  it("allows only authenticated ChatGPT subscription accounts", () => {
    expect(canShowCodexUsage(provider)).toBe(true);
    expect(
      canShowCodexUsage({ ...provider, auth: { status: "authenticated", type: "apiKey" } }),
    ).toBe(false);
    expect(canShowCodexUsage({ ...provider, auth: { status: "unknown" } })).toBe(false);
    expect(canShowCodexUsage({ ...provider, auth: { status: "unauthenticated" } })).toBe(false);
  });
});
