import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationProposedPlanId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildQueuedThreadTurnStartInput } from "./thread-outbox-delivery";
import type { QueuedThreadMessage } from "./thread-outbox-model";

describe("buildQueuedThreadTurnStartInput", () => {
  it("preserves exact prompt, each upload once, and proposed-plan context", () => {
    const planThreadId = ThreadId.make("plan-thread");
    const queuedMessage: QueuedThreadMessage = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("retry-message"),
      commandId: CommandId.make("retry-command"),
      text: "  exact original prompt  ",
      attachments: [
        {
          id: "draft-image-1",
          type: "image",
          name: "one.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,YWJj",
          previewUri: "data:image/png;base64,YWJj",
        },
      ],
      sourceProposedPlan: {
        threadId: planThreadId,
        planId: OrchestrationProposedPlanId.make("plan-1"),
      },
      createdAt: "2026-07-26T10:10:00.000Z",
    };
    const input = buildQueuedThreadTurnStartInput(queuedMessage, {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      },
      runtimeMode: "full-access",
      interactionMode: "plan",
    });

    expect(input).toMatchObject({
      message: {
        text: "  exact original prompt  ",
        attachments: [
          {
            type: "image",
            name: "one.png",
            dataUrl: "data:image/png;base64,YWJj",
          },
        ],
      },
      sourceProposedPlan: {
        threadId: planThreadId,
        planId: "plan-1",
      },
    });
    expect(input.message.attachments).toHaveLength(1);
  });
});
