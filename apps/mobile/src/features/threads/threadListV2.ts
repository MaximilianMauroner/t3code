import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
 *
 * Four visual states, three colors: color is reserved for "act now"
 * (approval), "in motion" (working), and "broken" (failed). Ready is the
 * unlabeled resting state.
 */
export type ThreadListV2Status = "approval" | "input" | "working" | "failed" | "ready";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more. Shared by the compact Home list and
// the iPad sidebar so both page identically.
export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

export function resolveThreadListV2Status(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "session">,
): ThreadListV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** First VALID timestamp wins: a present-yet-malformed string falls through
    to the next candidate rather than sinking the row to the epoch. */
function firstValidTimestampMs(...candidates: ReadonlyArray<string | null | undefined>): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function resolveThreadListV2SettledTimestamp(
  thread: Pick<
    EnvironmentThreadShell,
    "settledAt" | "latestUserMessageAt" | "latestTurn" | "updatedAt"
  >,
): string | null {
  if (thread.settledAt !== null && !Number.isNaN(Date.parse(thread.settledAt))) {
    return thread.settledAt;
  }
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  if (latest !== null) return latest;
  return !Number.isNaN(Date.parse(thread.updatedAt)) ? thread.updatedAt : null;
}

/**
 * v2 sort: static creation order, newest thread on top. Activity NEVER
 * reorders the list — a row holds its position from open until settled, so
 * the screen only moves at lifecycle transitions. Mirrors web's
 * sortThreadsForSidebarV2.
 */
export function sortThreadsForListV2<T extends { readonly id: string; readonly createdAt: string }>(
  threads: readonly T[],
): T[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export interface ThreadListV2RowItem {
  readonly type: "thread";
  readonly thread: EnvironmentThreadShell;
  readonly lifecycle: "active" | "snoozed" | "settled";
  readonly variant: "card" | "slim";
  /** First settled row after the card block draws the SETTLED divider. */
  readonly showSettledDivider: boolean;
  readonly isLast: boolean;
}

export interface ThreadListV2SectionItem {
  readonly type: "section";
  readonly lifecycle: "snoozed" | "settled";
  readonly count: number;
}

export type ThreadListV2Item = ThreadListV2RowItem | ThreadListV2SectionItem;

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  readonly activeCount: number;
  readonly snoozedCount: number;
  readonly settledCount: number;
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  /** Soonest wake time among hidden snoozed threads, or null. Callers arm
      a timeout at this boundary so the list re-partitions the moment a
      snooze expires instead of on the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
}

/**
 * Partitions visible threads into the active card block (creation order) and
 * the settled recency tail, matching the web v2 list. `autoSettleAfterDays`
 * mirrors the web default of 3 — mobile has no client-settings sync yet, so
 * the default is fixed here rather than user-configurable.
 */
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  /** Per-row PR state reported up by visible rows ("env:threadId" keys). */
  readonly changeRequestStateByKey?: ReadonlyMap<string, "open" | "closed" | "merged">;
  /** Environments whose server supports thread.settle/unsettle. Threads on
      other environments never classify as settled — the user could neither
      un-settle nor pin them. Absent = no gating (tests). */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Environments whose server supports thread.snooze/unsnooze. Same
      contract as settlementEnvironmentIds. */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly autoSettleAfterDays?: number;
  /** Max settled rows to render; the rest are counted, not built. */
  readonly settledLimit?: number;
  /** Injectable for tests; defaults to now. */
  readonly now?: string;
  /** Second-precise clock for snooze classification. Callers pass a
      minute-quantized `now` for memoization; snooze wake times are
      second-precise, so classifying with the floored minute would hold a
      woken thread hidden for up to a minute. Defaults to `now`. */
  readonly snoozeNow?: string;
}): ThreadListV2Layout {
  const now = input.now ?? new Date().toISOString();
  const snoozeNow = input.snoozeNow ?? now;
  const autoSettleAfterDays = input.autoSettleAfterDays ?? 3;
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const active: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  for (const thread of input.threads) {
    // Callers pass live (unarchived) shells; settled threads are among them
    // and partition into the tail via effectiveSettled.
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) continue;
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      continue;
    }
    if (query.length > 0 && !thread.title.toLocaleLowerCase().includes(query)) continue;
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    const changeRequestState =
      input.changeRequestStateByKey?.get(`${thread.environmentId}:${thread.id}`) ?? null;
    // Snoozed threads move to their shelf until they wake (or raise a hand —
    // effectiveSnoozed refuses blocked/failed work). Snooze outranks settled.
    const mobileWorking =
      thread.session?.status === "starting" || thread.session?.status === "running";
    if (supportsSnooze && !mobileWorking && effectiveSnoozed(thread, { now: snoozeNow })) {
      snoozed.push(thread);
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    if (
      supportsSettlement &&
      effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })
    ) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  const orderedActive = sortThreadsForListV2(active);
  const orderedSnoozed = [...snoozed].sort(
    (left, right) =>
      firstValidTimestampMs(left.snoozedUntil) - firstValidTimestampMs(right.snoozedUntil) ||
      left.id.localeCompare(right.id),
  );
  const orderedSettled = [...settled].sort((left, right) => {
    const leftTimestamp = resolveThreadListV2SettledTimestamp(left);
    const rightTimestamp = resolveThreadListV2SettledTimestamp(right);
    return (
      firstValidTimestampMs(rightTimestamp) - firstValidTimestampMs(leftTimestamp) ||
      left.id.localeCompare(right.id)
    );
  });
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const visibleSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;

  const items: ThreadListV2Item[] = [];
  for (const thread of orderedActive) {
    items.push({
      type: "thread",
      thread,
      lifecycle: "active",
      variant: "card",
      showSettledDivider: false,
      isLast: false,
    });
  }
  if (orderedSnoozed.length > 0) {
    items.push({ type: "section", lifecycle: "snoozed", count: orderedSnoozed.length });
  }
  for (const thread of orderedSnoozed) {
    items.push({
      type: "thread",
      thread,
      lifecycle: "snoozed",
      variant: "slim",
      showSettledDivider: false,
      isLast: false,
    });
  }
  if (orderedSettled.length > 0) {
    items.push({ type: "section", lifecycle: "settled", count: orderedSettled.length });
  }
  for (const [index, thread] of visibleSettled.entries()) {
    items.push({
      type: "thread",
      thread,
      lifecycle: "settled",
      variant: "slim",
      showSettledDivider: index === 0,
      isLast: false,
    });
  }
  let lastRowIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === "thread") {
      lastRowIndex = index;
      break;
    }
  }
  const last = items[lastRowIndex];
  if (last?.type === "thread") {
    items[lastRowIndex] = { ...last, isLast: true };
  }
  return {
    items,
    activeCount: orderedActive.length,
    snoozedCount: orderedSnoozed.length,
    settledCount: orderedSettled.length,
    hiddenSettledCount: orderedSettled.length - visibleSettled.length,
    nextSnoozeWakeAt,
  };
}
