// @effect-diagnostics globalDate:off - Pure presentation helpers intentionally use the platform local calendar and locale.
export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
  ];
  const evening = atHour(now, 18);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }
  const tomorrow = atHour(addDays(now, 1), 9);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), 9);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeLabel(nextWeek)}`,
    snoozedUntil: nextWeek.toISOString(),
  });
  return presets;
}

export function snoozeWakeLabel(snoozedUntil: string, now: Date): string {
  const wake = parseDate(snoozedUntil);
  if (wake === null) return "now";
  const remainingMs = wake.getTime() - now.getTime();
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

export function snoozeWakeDescription(snoozedUntil: string, now: Date): string {
  const wake = parseDate(snoozedUntil);
  if (wake === null || wake.getTime() <= now.getTime()) return "";
  const time = timeLabel(wake);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const wakeDay = new Date(wake);
  wakeDay.setHours(0, 0, 0, 0);
  const dayDelta = Math.round((wakeDay.getTime() - today.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  if (dayDelta > 1 && dayDelta < 7) {
    return `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${wake.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
