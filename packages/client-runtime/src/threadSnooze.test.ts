// @effect-diagnostics globalDate:off - Tests exercise local-calendar presentation behavior.
import { describe, expect, it } from "vite-plus/test";
import { resolveSnoozePresets, snoozeWakeDescription, snoozeWakeLabel } from "./threadSnooze.js";

function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("thread snooze presentation", () => {
  it("resolves local calendar presets", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
    expect(presets.map(({ id }) => id)).toEqual(["hour", "evening", "tomorrow", "next-week"]);
    expect(new Date(presets[2]!.snoozedUntil).getHours()).toBe(9);
    expect(new Date(presets[3]!.snoozedUntil).getDay()).toBe(1);
  });

  it("drops evening when near or past", () => {
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 17, 30)).map(({ id }) => id)).toEqual([
      "hour",
      "tomorrow",
      "next-week",
    ]);
  });

  it("formats countdowns and rejects malformed or past values", () => {
    const now = localDate(2026, 4, 8, 10);
    expect(snoozeWakeLabel(new Date(now.getTime() + 90 * 60_000).toISOString(), now)).toBe("2h");
    expect(snoozeWakeLabel("bad", now)).toBe("now");
    expect(snoozeWakeDescription("bad", now)).toBe("");
    expect(snoozeWakeDescription(new Date(now.getTime() - 1).toISOString(), now)).toBe("");
  });

  it("describes local calendar days", () => {
    const now = localDate(2026, 4, 8, 10);
    expect(snoozeWakeDescription(localDate(2026, 4, 9, 9).toISOString(), now)).toContain(
      "tomorrow",
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 13, 9).toISOString(), now)).toMatch(/Mon/);
  });

  it("resolves fresh presets and countdowns from the supplied presentation clock", () => {
    const firstNow = localDate(2026, 4, 8, 10);
    const laterNow = localDate(2026, 4, 8, 10, 30);
    const firstHour = resolveSnoozePresets(firstNow)[0]!;
    const laterHour = resolveSnoozePresets(laterNow)[0]!;
    expect(laterHour.snoozedUntil).not.toBe(firstHour.snoozedUntil);
    expect(snoozeWakeLabel(firstHour.snoozedUntil, firstNow)).toBe("1h");
    expect(snoozeWakeLabel(firstHour.snoozedUntil, laterNow)).toBe("30m");
  });
});
