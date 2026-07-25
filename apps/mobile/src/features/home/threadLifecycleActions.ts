import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";

export type MobileSnoozeValidation =
  | { readonly ok: true; readonly snoozedUntil: string }
  | { readonly ok: false; readonly reason: "attention" | "working" | "invalid-wake" };

export function validateMobileSnooze(
  thread: EnvironmentThreadShell,
  snoozedUntil: string,
  now: string,
): MobileSnoozeValidation {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return { ok: false, reason: "working" };
  }
  if (!canSnooze(thread, { now })) return { ok: false, reason: "attention" };
  const wakeAt = Date.parse(snoozedUntil);
  if (Number.isNaN(wakeAt) || wakeAt <= Date.parse(now)) {
    return { ok: false, reason: "invalid-wake" };
  }
  return { ok: true, snoozedUntil: new Date(wakeAt).toISOString() };
}

export function snoozePayload(thread: EnvironmentThreadShell, snoozedUntil: string) {
  return { threadId: thread.id, snoozedUntil } as const;
}

export function wakePayload(thread: EnvironmentThreadShell) {
  return { threadId: thread.id, reason: "user" as const };
}
