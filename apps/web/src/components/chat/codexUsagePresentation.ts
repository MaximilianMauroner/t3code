import type { CodexUsageSnapshot } from "@t3tools/contracts";

const resetFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function codexUsagePresentation(snapshot: CodexUsageSnapshot): {
  readonly summary: string;
  readonly details: string;
} {
  const summary = snapshot.windows
    .map((window) => `${window.label} ${window.remainingPercent}% left`)
    .join(" · ");
  const details = snapshot.windows.map((window) => {
    const reset = window.resetsAt ? resetFormatter.format(new Date(window.resetsAt)) : null;
    return `${window.label}: ${window.remainingPercent}% left${reset ? `, resets ${reset}` : ""}`;
  });
  details.push(
    snapshot.source === "cache"
      ? "Showing the last successful reading."
      : `Checked ${resetFormatter.format(new Date(snapshot.checkedAt))}`,
  );
  return { summary, details: details.join("\n") };
}
