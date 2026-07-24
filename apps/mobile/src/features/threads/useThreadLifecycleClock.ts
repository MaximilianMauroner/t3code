import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { lifecycleDeadlineDelay } from "./threadLifecycleClock";

/** Minute presentation clock plus an exact lifecycle deadline and foreground refresh. */
export function useThreadLifecycleClock(deadline: string | null): string {
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    const refresh = () => setNow(new Date().toISOString());
    const interval = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const delay = lifecycleDeadlineDelay(deadline, Date.now());
    if (delay === null) return;
    const timeout = setTimeout(() => setNow(new Date().toISOString()), delay);
    return () => clearTimeout(timeout);
  }, [deadline, now]);

  return now;
}
