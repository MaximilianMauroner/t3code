import type { CodexUsageSnapshot, CodexUsageSnapshotSource } from "@t3tools/contracts";

export interface CodexUsageRawWindow {
  readonly usedPercent?: number | null;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexUsageRawBucket {
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly primary?: CodexUsageRawWindow | null;
  readonly secondary?: CodexUsageRawWindow | null;
  readonly rateLimitReachedType?: string | null;
}

export interface CodexUsageRawPayload {
  readonly rateLimits?: CodexUsageRawBucket | null;
  readonly rateLimitsByLimitId?: Readonly<Record<string, CodexUsageRawBucket>> | null;
}

const normalizeIdentifier = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

function bucketIdentifiers(key: string, bucket: CodexUsageRawBucket): ReadonlySet<string> {
  return new Set(
    [key, bucket.limitId, bucket.limitName]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map(normalizeIdentifier),
  );
}

function matchesModel(model: string, key: string, bucket: CodexUsageRawBucket): boolean {
  const normalizedModel = normalizeIdentifier(model);
  return (
    normalizedModel.length > 0 &&
    [...bucketIdentifiers(key, bucket)].some((identifier) => identifier === normalizedModel)
  );
}

const clampPercent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)));

function windowLabel(window: CodexUsageRawWindow, index: number): string {
  const minutes = window.windowDurationMins;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return index === 0 ? "Session" : "Weekly";
}

function normalizeReset(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function resolveCodexUsageSnapshot(input: {
  readonly providerInstanceId: CodexUsageSnapshot["providerInstanceId"];
  readonly model: string;
  readonly payload: CodexUsageRawPayload;
  readonly source: CodexUsageSnapshotSource;
  readonly now?: Date;
  readonly checkedAt?: string;
}): CodexUsageSnapshot | null {
  const model = input.model.trim();
  if (model.length === 0) return null;
  const entries = Object.entries(input.payload.rateLimitsByLimitId ?? {});
  const exact = entries.filter(([key, bucket]) => matchesModel(model, key, bucket));
  let selected: readonly [string, CodexUsageRawBucket] | null =
    exact.length === 1 ? exact[0]! : null;

  if (!selected && exact.length === 0) {
    const generic = entries.filter(([key, bucket]) => bucketIdentifiers(key, bucket).has("codex"));
    const competing = entries.filter(
      ([key, bucket]) => !bucketIdentifiers(key, bucket).has("codex"),
    );
    if (generic.length === 1 && competing.length === 0) selected = generic[0]!;
    if (entries.length === 0 && input.payload.rateLimits) {
      const legacy = input.payload.rateLimits;
      const legacyKey = legacy.limitId?.trim() ?? "";
      const identities = bucketIdentifiers(legacyKey, legacy);
      if (identities.has("codex") || matchesModel(model, legacyKey, legacy)) {
        selected = [legacyKey || legacy.limitName?.trim() || model, legacy];
      }
    }
  }
  if (!selected) return null;

  const windows = [selected[1].primary, selected[1].secondary]
    .filter((window): window is CodexUsageRawWindow => window !== null && window !== undefined)
    .flatMap((window, index) => {
      if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return [];
      const usedPercent = clampPercent(window.usedPercent);
      return [
        {
          label: windowLabel(window, index),
          usedPercent,
          remainingPercent: 100 - usedPercent,
          resetsAt: normalizeReset(window.resetsAt),
          windowDurationMins:
            typeof window.windowDurationMins === "number" &&
            Number.isFinite(window.windowDurationMins)
              ? window.windowDurationMins
              : null,
        },
      ];
    });
  if (windows.length === 0) return null;
  return {
    providerInstanceId: input.providerInstanceId,
    model,
    limitId: selected[1].limitId?.trim() || selected[0],
    checkedAt: input.checkedAt ?? (input.now ?? new Date()).toISOString(),
    windows,
    rateLimitReachedType: selected[1].rateLimitReachedType ?? null,
    source: input.source,
  };
}
