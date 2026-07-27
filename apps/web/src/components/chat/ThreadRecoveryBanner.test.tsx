import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadRecoveryBanner } from "./ThreadRecoveryBanner";

describe("ThreadRecoveryBanner", () => {
  it("renders terminal status, distinct timestamps, preserved-output copy, and an exact retry action", () => {
    const html = renderToStaticMarkup(
      <ThreadRecoveryBanner
        presentation={{
          title: "Turn interrupted",
          message: "The server restarted while this turn was running.",
          detectedAt: "2026-07-26T02:00:00.000Z",
          executionLastObservedAt: "2026-07-26T01:59:58.000Z",
          timestampFallback: false,
        }}
        retry={{
          kind: "available",
          sourceMessageId: MessageId.make("message-original"),
          text: "Original prompt",
          attachments: [],
          sourceProposedPlan: undefined,
        }}
        retrying={false}
        timestampFormat="24-hour"
        onRetry={vi.fn()}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-label="Interrupted turn status"');
    expect(html).toContain("Partial output is preserved below.");
    expect(html).toContain("Last execution observed");
    expect(html).toContain("Interruption detected");
    expect(html).toContain(
      'aria-label="Retry interrupted turn with original prompt and attachments"',
    );
    expect(html).not.toContain(' disabled=""');
  });

  it("explains timestamp fallback and disables retry when the exact source is unavailable", () => {
    const html = renderToStaticMarkup(
      <ThreadRecoveryBanner
        presentation={{
          title: "Turn interrupted",
          message: "This turn was interrupted before it finished.",
          detectedAt: "2026-07-26T02:00:00.000Z",
          executionLastObservedAt: "2026-07-26T02:00:00.000Z",
          timestampFallback: true,
        }}
        retry={{ kind: "unavailable", reason: "missing-source-id" }}
        retrying={false}
        timestampFormat="24-hour"
        onRetry={vi.fn()}
      />,
    );

    expect(html).toContain("Unavailable — using interruption detection time");
    expect(html).toContain("original prompt was not recorded");
    expect(html).toContain("disabled");
  });
});
