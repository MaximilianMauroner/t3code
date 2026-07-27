import { EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { recoveryCommandId } from "./recoveryCommandId.ts";

it("derives recovery ids from target equality, boot, and reason rather than observer", () => {
  const base = {
    threadId: ThreadId.make("thread-1"),
    target: {
      kind: "pendingStart" as const,
      pendingMessageId: MessageId.make("message-1"),
      deliveryId: "delivery-1",
      sourceEventId: EventId.make("event-1"),
      expectedSession: { kind: "absent" as const },
      expectedDeliveryOwnership: { status: "pending" as const },
    },
    serverBootId: "boot-2",
    reason: "server-restarted" as const,
  };
  expect(recoveryCommandId(base)).toBe(recoveryCommandId({ ...base }));
  expect(recoveryCommandId(base)).not.toBe(recoveryCommandId({ ...base, serverBootId: "boot-3" }));
  expect(recoveryCommandId(base)).not.toBe(
    recoveryCommandId({
      ...base,
      target: { ...base.target, deliveryId: "delivery-2" },
    }),
  );
});
