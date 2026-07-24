import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@t3tools/client-runtime/state/thread-settled";

export function resolveOpenThreadLifecycleState(
  thread: EnvironmentThreadShell,
  options: {
    readonly now: string;
    readonly supportsSnooze: boolean;
    readonly supportsSettlement: boolean;
    readonly changeRequestState: ChangeRequestStateLike | null;
  },
): "snoozed" | "settled" | null {
  const working = thread.session?.status === "starting" || thread.session?.status === "running";
  if (options.supportsSnooze && !working && effectiveSnoozed(thread, { now: options.now })) {
    return "snoozed";
  }
  if (
    options.supportsSettlement &&
    effectiveSettled(thread, {
      now: options.now,
      autoSettleAfterDays: 3,
      changeRequestState: options.changeRequestState,
    })
  ) {
    return "settled";
  }
  return null;
}
