import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type { QueuedThreadMessage, ThreadSettingsSnapshot } from "./thread-outbox-model";

export function buildQueuedThreadTurnStartInput(
  queuedMessage: QueuedThreadMessage,
  settings: ThreadSettingsSnapshot,
): StartThreadTurnInput {
  return {
    commandId: queuedMessage.commandId,
    threadId: queuedMessage.threadId,
    message: {
      messageId: queuedMessage.messageId,
      role: "user",
      text: queuedMessage.text,
      attachments: queuedMessage.attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: attachment.dataUrl,
      })),
    },
    modelSelection: settings.modelSelection,
    runtimeMode: settings.runtimeMode,
    interactionMode: settings.interactionMode,
    ...(queuedMessage.sourceProposedPlan === undefined
      ? {}
      : { sourceProposedPlan: queuedMessage.sourceProposedPlan }),
    createdAt: queuedMessage.createdAt,
  };
}
