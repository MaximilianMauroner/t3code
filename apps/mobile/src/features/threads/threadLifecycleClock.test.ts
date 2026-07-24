import { describe, expect, it } from "vite-plus/test";
import { lifecycleDeadlineDelay } from "./threadLifecycleClock";

describe("lifecycleDeadlineDelay", () => {
  it("refreshes just after a future deadline", () => {
    expect(
      lifecycleDeadlineDelay("2026-06-02T00:00:01.000Z", Date.parse("2026-06-02T00:00:00.000Z")),
    ).toBe(1_050);
  });

  it("ignores elapsed and malformed deadlines", () => {
    const now = Date.parse("2026-06-02T00:00:00.000Z");
    expect(lifecycleDeadlineDelay("2026-06-01T00:00:00.000Z", now)).toBeNull();
    expect(lifecycleDeadlineDelay("bad", now)).toBeNull();
    expect(lifecycleDeadlineDelay(null, now)).toBeNull();
  });
});
