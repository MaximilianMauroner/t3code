import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { AppState } from "react-native";

import { lifecycleDeadlineDelay, refreshLifecycleClockSelection } from "./threadLifecycleClock";

/** Minute presentation clock plus an exact lifecycle deadline and foreground refresh. */
export function useThreadLifecycleClock(identity: string | null, deadline: string | null): string {
  const [clock, setClock] = useState(() => ({
    identity,
    deadline,
    now: new Date().toISOString(),
  }));
  const refresh = useCallback(() => {
    setClock((current) => ({ ...current, now: new Date().toISOString() }));
  }, []);

  // A split-view route can retain this hook while its selected thread
  // changes. Refresh before paint so classification never uses the previous
  // selection's minute-old presentation time.
  useLayoutEffect(() => {
    setClock((current) =>
      refreshLifecycleClockSelection(current, { identity, deadline }, new Date().toISOString()),
    );
  }, [deadline, identity]);

  useEffect(() => {
    const interval = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [refresh]);

  useEffect(() => {
    const delay = lifecycleDeadlineDelay(deadline, Date.now());
    if (delay === null) return;
    const timeout = setTimeout(refresh, delay);
    return () => clearTimeout(timeout);
  }, [clock.now, deadline, refresh]);

  return clock.now;
}
