import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";

import {
  isLoopbackHostname,
  resolveDevRedirectUrl,
  withEnvironmentDescriptorHealthMetrics,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("environment descriptor health metrics", () => {
  effectIt.effect("records the watchdog endpoint with a bounded label", () =>
    Effect.gen(function* () {
      const duration = Duration.millis(25);
      const fiber = yield* Effect.sleep(duration).pipe(
        withEnvironmentDescriptorHealthMetrics,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(duration);
      yield* Fiber.join(fiber);

      const snapshots = yield* Metric.snapshot;
      const sample = snapshots.find(
        (entry) =>
          entry.type === "Histogram" &&
          entry.id === "t3_health_probe_duration" &&
          entry.attributes?.probe === "environment-descriptor",
      );
      expect(sample?.type).toBe("Histogram");
      if (sample?.type !== "Histogram") return;
      expect(sample.state.count).toBe(1);
      expect(sample.state.sum).toBe(25);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
