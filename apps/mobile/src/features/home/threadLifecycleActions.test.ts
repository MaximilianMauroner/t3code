import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { snoozePayload, validateMobileSnooze, wakePayload } from "./threadLifecycleActions";

function shell(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make("thread"),
    projectId: ProjectId.make("project"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("mobile lifecycle actions", () => {
  it("normalizes a valid snooze and builds exact command payloads", () => {
    const thread = shell();
    const result = validateMobileSnooze(thread, "2026-06-02T01:00:00Z", "2026-06-02T00:00:00.000Z");
    expect(result).toEqual({ ok: true, snoozedUntil: "2026-06-02T01:00:00.000Z" });
    expect(snoozePayload(thread, "2026-06-02T01:00:00.000Z")).toEqual({
      threadId: thread.id,
      snoozedUntil: "2026-06-02T01:00:00.000Z",
    });
    expect(wakePayload(thread)).toEqual({ threadId: thread.id, reason: "user" });
  });

  it("blocks working, attention-bound, malformed, and past snoozes", () => {
    expect(
      validateMobileSnooze(
        shell({
          session: {
            threadId: ThreadId.make("thread"),
            status: "running",
            providerName: "Codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        }),
        "2026-06-02T01:00:00.000Z",
        "2026-06-02T00:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "working" });
    expect(
      validateMobileSnooze(
        shell({ hasPendingApprovals: true }),
        "2026-06-02T01:00:00.000Z",
        "2026-06-02T00:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "attention" });
    expect(validateMobileSnooze(shell(), "bad", "2026-06-02T00:00:00.000Z")).toEqual({
      ok: false,
      reason: "invalid-wake",
    });
    expect(
      validateMobileSnooze(shell(), "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z"),
    ).toEqual({ ok: false, reason: "invalid-wake" });
  });
});
