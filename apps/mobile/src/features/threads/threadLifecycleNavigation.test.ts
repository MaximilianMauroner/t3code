import { describe, expect, it } from "vite-plus/test";
import { resolveParkingNavigation } from "./threadLifecycleNavigation";

const selected = {
  parkedKey: "env:parked",
  selectedKeyBefore: "env:parked",
  selectedKeyAfter: "env:parked",
  succeeded: true,
} as const;

describe("resolveParkingNavigation", () => {
  it("does nothing after failure, background parking, or a selection change during await", () => {
    expect(
      resolveParkingNavigation({ ...selected, succeeded: false, destination: "next" }),
    ).toEqual({
      type: "none",
    });
    expect(
      resolveParkingNavigation({
        ...selected,
        selectedKeyBefore: "env:background",
        destination: "next",
      }),
    ).toEqual({ type: "none" });
    expect(
      resolveParkingNavigation({
        ...selected,
        selectedKeyAfter: "env:new-selection",
        destination: "next",
      }),
    ).toEqual({ type: "none" });
  });

  it("selects the planned destination only after selected-row success", () => {
    expect(resolveParkingNavigation({ ...selected, destination: "next" })).toEqual({
      type: "select",
      destination: "next",
    });
  });

  it("clears Home after selected-row success with no destination", () => {
    expect(resolveParkingNavigation({ ...selected, destination: null })).toEqual({ type: "clear" });
  });
});
