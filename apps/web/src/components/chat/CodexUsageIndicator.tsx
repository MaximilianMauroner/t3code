import type { CodexUsageSnapshot, CodexUsageWindow, ProviderInstanceId } from "@t3tools/contracts";
import type { CodexUsageIndicatorMode } from "@t3tools/contracts/settings";
import { sortCodexUsageWindowsForDisplay } from "@t3tools/shared/codexUsage";
import { useQuery } from "@tanstack/react-query";
import { GaugeIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { codexUsageQueryOptions } from "../../lib/codexUsageReactQuery";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const sameDayResetFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const laterResetFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function labelForWindow(kind: CodexUsageWindow["kind"]): string {
  return kind === "five-hour" ? "5h" : "Weekly";
}

function selectedWindows(
  snapshot: CodexUsageSnapshot | null | undefined,
  mode: CodexUsageIndicatorMode,
): CodexUsageWindow[] {
  if (!snapshot || mode === "off") {
    return [];
  }
  if (mode === "both") {
    return sortCodexUsageWindowsForDisplay(
      snapshot.windows.filter((window) => window.kind === "five-hour" || window.kind === "weekly"),
    );
  }
  return snapshot.windows.filter((window) => window.kind === "five-hour");
}

function unavailableLabel(mode: CodexUsageIndicatorMode): string {
  if (mode === "both") {
    return "Usage 5h -- | Weekly --";
  }
  return "Usage 5h --";
}

function labelForDisplayWindow(window: CodexUsageWindow): string {
  return `${labelForWindow(window.kind)} ${window.remainingPercent}% left`;
}

function formatUsageTimestamp(isoDate: string, capturedAt: Date = new Date()): string | null {
  const date = new Date(isoDate);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const isSameDay =
    date.getFullYear() === capturedAt.getFullYear() &&
    date.getMonth() === capturedAt.getMonth() &&
    date.getDate() === capturedAt.getDate();
  return isSameDay ? sameDayResetFormatter.format(date) : laterResetFormatter.format(date);
}

function tooltipForSnapshot(snapshot: CodexUsageSnapshot, windows: readonly CodexUsageWindow[]) {
  const lines = windows.map((window) => {
    const resetAt = window.resetsAt ? formatUsageTimestamp(window.resetsAt) : null;
    const resetLabel = resetAt ? `resets ${resetAt}` : "";
    return `${labelForWindow(window.kind)}: ${window.remainingPercent}% left${resetLabel ? `, ${resetLabel}` : ""}`;
  });
  const checkedAt = formatUsageTimestamp(snapshot.checkedAt);
  if (checkedAt) {
    lines.push(`Checked ${checkedAt}`);
  }
  if (snapshot.rateLimitReachedType) {
    lines.push(`Limit state: ${snapshot.rateLimitReachedType}`);
  }
  return lines.join("\n");
}

export const CodexUsageIndicator = memo(function CodexUsageIndicator({
  instanceId,
  mode,
}: {
  readonly instanceId: ProviderInstanceId;
  readonly mode: CodexUsageIndicatorMode;
}) {
  const usageQuery = useQuery(
    codexUsageQueryOptions({
      instanceId,
      enabled: mode !== "off",
    }),
  );
  const { data: usageData, isFetching, refetch } = usageQuery;
  const windows = useMemo(() => selectedWindows(usageData, mode), [mode, usageData]);
  const refreshUsage = useCallback(() => {
    if (isFetching) {
      return;
    }
    void refetch();
  }, [isFetching, refetch]);

  if (mode === "off") {
    return null;
  }

  const isUnavailable = !usageData || windows.length === 0;
  const hasReachedLimit = Boolean(usageData?.rateLimitReachedType);
  const snapshot = usageData;
  const label = isUnavailable
    ? unavailableLabel(mode)
    : `Usage ${windows.map((window) => labelForDisplayWindow(window)).join(" | ")}`;
  const tooltip =
    isUnavailable || !snapshot
      ? "Codex usage is unavailable for this account or session. The selected Codex account did not return displayable 5h or weekly limits.\nClick to refresh."
      : `${tooltipForSnapshot(snapshot, windows)}\nClick to refresh.`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-busy={isFetching}
            aria-label="Refresh Codex usage"
            onClick={refreshUsage}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-sm font-medium tabular-nums sm:text-xs",
              "text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground/80",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              hasReachedLimit && "text-amber-600 hover:text-amber-600",
            )}
          >
            <GaugeIcon className={cn("size-3.5 shrink-0", isFetching && "animate-spin")} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        }
      />
      <TooltipPopup side="top" className="whitespace-pre-line">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
});
