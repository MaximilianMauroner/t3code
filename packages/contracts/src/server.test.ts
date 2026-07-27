import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig, ServerForkUpdateStatus, ServerProvider } from "./server.ts";
import { OrchestrationThreadActivity } from "./orchestration.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const encodeThreadActivity = Schema.encodeUnknownSync(OrchestrationThreadActivity);
const decodeThreadActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);
const decodeForkUpdateStatus = Schema.decodeUnknownSync(ServerForkUpdateStatus);

it("round-trips omitted persisted activity payload markers", () => {
  const activity = {
    id: "activity-omitted",
    tone: "tool",
    kind: "tool.completed",
    summary: "Large tool output",
    payload: { itemType: "command_execution", detail: "preview" },
    payloadOmitted: true,
    turnId: null,
    sequence: 42,
    createdAt: "2026-07-24T00:00:00.000Z",
  } as const;
  const encoded = encodeThreadActivity(activity);
  expect(decodeThreadActivity(encoded)).toEqual(activity);
});

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});

describe("ServerForkUpdateStatus", () => {
  it("decodes persisted terminal status", () => {
    const decoded = decodeForkUpdateStatus({
      stage: "failed",
      message: "The current release was kept.",
      startedAt: "2026-07-24T10:00:00.000Z",
      completedAt: "2026-07-24T10:01:00.000Z",
      currentCommit: "abc123",
      targetCommit: "def456",
      error: "Validation failed.",
    });
    expect(decoded.stage).toBe("failed");
    expect(decoded.error).toBe("Validation failed.");
  });

  it("rejects unknown workflow stages", () => {
    expect(() =>
      decodeForkUpdateStatus({
        stage: "running-arbitrary-command",
        message: "Unsafe",
        startedAt: null,
        completedAt: null,
        currentCommit: null,
        targetCommit: null,
        error: null,
      }),
    ).toThrow();
  });
});

it("keeps recovery capability advertisement optional for historical configs", () => {
  const fields = ServerConfig.fields;
  expect(fields.threadRecoveryEventsV1).toBeDefined();
});
