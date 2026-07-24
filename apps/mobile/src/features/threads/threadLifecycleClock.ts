const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ThreadLifecycleClockSnapshot {
  readonly identity: string | null;
  readonly deadline: string | null;
  readonly now: string;
}

export function refreshLifecycleClockSelection(
  current: ThreadLifecycleClockSnapshot,
  selection: Pick<ThreadLifecycleClockSnapshot, "identity" | "deadline">,
  now: string,
): ThreadLifecycleClockSnapshot {
  if (current.identity === selection.identity && current.deadline === selection.deadline) {
    return current;
  }
  return { ...selection, now };
}

export function lifecycleDeadlineDelay(deadline: string | null, nowMs: number): number | null {
  if (deadline === null) return null;
  const deadlineMs = Date.parse(deadline);
  if (Number.isNaN(deadlineMs) || deadlineMs <= nowMs) return null;
  return Math.min(deadlineMs - nowMs + 50, MAX_TIMEOUT_MS);
}
