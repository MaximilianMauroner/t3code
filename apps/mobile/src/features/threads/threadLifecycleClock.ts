const MAX_TIMEOUT_MS = 2_147_483_647;

export function lifecycleDeadlineDelay(deadline: string | null, nowMs: number): number | null {
  if (deadline === null) return null;
  const deadlineMs = Date.parse(deadline);
  if (Number.isNaN(deadlineMs) || deadlineMs <= nowMs) return null;
  return Math.min(deadlineMs - nowMs + 50, MAX_TIMEOUT_MS);
}
