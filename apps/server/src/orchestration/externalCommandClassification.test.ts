import { expect, it } from "vite-plus/test";

import { externalCommandEffects } from "./externalCommandClassification.ts";
import { hotCommandDeliveryKinds } from "./reactorDeliveries.ts";

it("classifies cleanup and provider-affecting commands as hot", () => {
  expect(externalCommandEffects["thread.archive"]).toBe("hot");
  expect(externalCommandEffects["thread.checkpoint.revert"]).toBe("hot");
  expect(externalCommandEffects["thread.delete"]).toBe("hot");
  expect(externalCommandEffects["thread.turn.start"]).toBe("hot");
  expect(externalCommandEffects["thread.runtime-mode.set"]).toBe("hot");
});

it("maps every representative lifecycle command to its durable delivery kind", () => {
  expect(hotCommandDeliveryKinds["thread.runtime-mode.set"]).toBe("runtime-mode-change");
  expect(hotCommandDeliveryKinds["thread.archive"]).toBe("archive-cleanup");
  expect(hotCommandDeliveryKinds["thread.checkpoint.revert"]).toBe("checkpoint-revert");
  expect(hotCommandDeliveryKinds["thread.delete"]).toBe("thread-delete");
});
