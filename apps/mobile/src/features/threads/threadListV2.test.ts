import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildThreadListV2Items,
  resolveThreadListV2SettledTimestamp,
  resolveThreadListV2Status,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
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

function rows(layout: ReturnType<typeof buildThreadListV2Items>) {
  return layout.items.flatMap((item) => (item.type === "thread" ? [item] : []));
}

describe("thread list v2 lifecycle model", () => {
  it("applies snooze precedence and orders the shelf by valid wake time", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("later"),
          title: "Later",
          snoozedUntil: "2026-06-04T00:00:00.000Z",
          snoozedAt: NOW,
          settledOverride: "settled",
        }),
        makeThread({
          id: ThreadId.make("sooner"),
          title: "Sooner",
          snoozedUntil: "2026-06-03T00:00:00.000Z",
          snoozedAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("malformed"),
          title: "Malformed",
          snoozedUntil: "bad",
          snoozedAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(rows(layout).map(({ thread, lifecycle }) => [thread.id, lifecycle])).toEqual([
      ["malformed", "active"],
      ["sooner", "snoozed"],
      ["later", "snoozed"],
    ]);
    expect(layout.snoozedCount).toBe(2);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-03T00:00:00.000Z");
  });

  it("keeps mobile working, queued, approval, input, and newly failed work active", () => {
    const baseSession = {
      threadId: ThreadId.make("working"),
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-06-02T00:00:00.000Z",
    };
    const threads = [
      makeThread({
        id: ThreadId.make("working"),
        title: "Working",
        snoozedUntil: "2026-06-03T00:00:00.000Z",
        snoozedAt: "2026-06-01T00:00:00.000Z",
        session: { ...baseSession, status: "running" },
      }),
      makeThread({
        id: ThreadId.make("approval"),
        title: "Approval",
        snoozedUntil: "2026-06-03T00:00:00.000Z",
        snoozedAt: NOW,
        hasPendingApprovals: true,
      }),
      makeThread({
        id: ThreadId.make("input"),
        title: "Input",
        settledOverride: "settled",
        hasPendingUserInput: true,
      }),
      makeThread({
        id: ThreadId.make("failed"),
        title: "Failed",
        snoozedUntil: "2026-06-03T00:00:00.000Z",
        snoozedAt: "2026-06-01T00:00:00.000Z",
        session: {
          ...baseSession,
          threadId: ThreadId.make("failed"),
          status: "error",
          lastError: "boom",
        },
      }),
      makeThread({
        id: ThreadId.make("queued"),
        title: "Queued",
        settledOverride: "settled",
        latestUserMessageAt: "2026-06-01T23:59:30.000Z",
      }),
    ];
    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    expect(rows(layout).every((item) => item.lifecycle === "active")).toBe(true);
  });

  it("gates lifecycle classification by capabilities and scopes counts after filtering", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("match"),
          title: "Fix login",
          snoozedUntil: "2026-06-03T00:00:00.000Z",
          snoozedAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("miss"),
          title: "Other",
          snoozedUntil: "2026-06-03T00:00:00.000Z",
          snoozedAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "login",
      snoozeEnvironmentIds: new Set([environmentId]),
      now: NOW,
    });
    expect(layout.snoozedCount).toBe(1);
    expect(layout.items).toContainEqual({ type: "section", lifecycle: "snoozed", count: 1 });
    const fallback = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("old"), title: "Old", settledOverride: "settled" })],
      environmentId: null,
      searchQuery: "",
      settlementEnvironmentIds: new Set(),
      now: NOW,
    });
    expect(rows(fallback)[0]?.lifecycle).toBe("active");
  });

  it("pages settled threads newest-first with accurate totals", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older"),
          title: "Older",
          settledOverride: "settled",
          updatedAt: "2026-05-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("newer"),
          title: "Newer",
          settledOverride: "settled",
          updatedAt: "2026-05-02T00:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      settledLimit: 1,
      now: NOW,
    });
    expect(rows(layout).map(({ thread }) => thread.id)).toEqual(["newer"]);
    expect(layout.settledCount).toBe(2);
    expect(layout.hiddenSettledCount).toBe(1);
  });

  it("reclassifies the same shell reference when the clock crosses a lifecycle boundary", () => {
    const unchanged = makeThread({
      id: ThreadId.make("same"),
      title: "Same shell",
      snoozedAt: "2026-06-01T00:00:00.000Z",
      snoozedUntil: "2026-06-02T00:00:30.000Z",
    });
    const before = buildThreadListV2Items({
      threads: [unchanged],
      environmentId: null,
      searchQuery: "",
      now: "2026-06-02T00:00:00.000Z",
    });
    const after = buildThreadListV2Items({
      threads: [unchanged],
      environmentId: null,
      searchQuery: "",
      now: "2026-06-02T00:00:31.000Z",
    });
    expect(rows(before)[0]?.lifecycle).toBe("snoozed");
    expect(rows(after)[0]?.lifecycle).toBe("active");
    expect(rows(before)[0]?.thread).toBe(rows(after)[0]?.thread);
  });

  it("uses explicit settle time, then latest turn activity, for ordering and labels", () => {
    const explicit = makeThread({
      id: ThreadId.make("explicit"),
      title: "Explicit",
      settledAt: "2026-06-02T02:00:00.000Z",
      settledOverride: "settled",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const automatic = makeThread({
      id: ThreadId.make("automatic"),
      title: "Automatic",
      settledOverride: "settled",
      latestTurn: {
        turnId: TurnId.make("turn"),
        state: "completed",
        requestedAt: "2026-06-02T00:00:00.000Z",
        startedAt: "2026-06-02T00:10:00.000Z",
        completedAt: "2026-06-02T01:00:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(resolveThreadListV2SettledTimestamp(explicit)).toBe(explicit.settledAt);
    expect(resolveThreadListV2SettledTimestamp(automatic)).toBe(automatic.latestTurn?.completedAt);
    const layout = buildThreadListV2Items({
      threads: [automatic, explicit],
      environmentId: null,
      searchQuery: "",
      now: "2026-06-03T00:00:00.000Z",
    });
    expect(rows(layout).map(({ thread }) => thread.id)).toEqual(["explicit", "automatic"]);
  });
});

describe("resolveThreadListV2Status", () => {
  it("prioritizes a raised hand", () => {
    expect(
      resolveThreadListV2Status(
        makeThread({ id: ThreadId.make("a"), title: "a", hasPendingApprovals: true }),
      ),
    ).toBe("approval");
  });
});
