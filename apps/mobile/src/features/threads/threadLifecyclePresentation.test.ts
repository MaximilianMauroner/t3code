import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveOpenThreadLifecycleState } from "./threadLifecyclePresentation";

function thread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
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
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: "2026-06-01T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const options = {
  now: "2026-06-02T02:00:00.000Z",
  supportsSnooze: true,
  supportsSettlement: true,
} as const;

describe("resolveOpenThreadLifecycleState", () => {
  it("shows a settled notice for an idle merged PR", () => {
    expect(
      resolveOpenThreadLifecycleState(thread(), {
        ...options,
        changeRequestState: "merged",
      }),
    ).toBe("settled");
  });

  it("matches snooze deadlines and capability gates", () => {
    const snoozed = thread({
      snoozedAt: "2026-06-02T00:00:00.000Z",
      snoozedUntil: "2026-06-02T03:00:00.000Z",
    });
    expect(
      resolveOpenThreadLifecycleState(snoozed, {
        ...options,
        changeRequestState: null,
      }),
    ).toBe("snoozed");
    expect(
      resolveOpenThreadLifecycleState(snoozed, {
        ...options,
        supportsSnooze: false,
        changeRequestState: null,
      }),
    ).toBeNull();
    expect(
      resolveOpenThreadLifecycleState(snoozed, {
        ...options,
        now: "2026-06-02T03:00:00.100Z",
        changeRequestState: null,
      }),
    ).toBeNull();
  });
});
