import { expect, it } from "vite-plus/test";

import { externalCommandEffects } from "./externalCommandClassification.ts";

it("classifies cleanup and provider-affecting commands as hot", () => {
  expect(externalCommandEffects["thread.archive"]).toBe("hot");
  expect(externalCommandEffects["thread.checkpoint.revert"]).toBe("hot");
  expect(externalCommandEffects["thread.delete"]).toBe("hot");
  expect(externalCommandEffects["thread.turn.start"]).toBe("hot");
  expect(externalCommandEffects["thread.runtime-mode.set"]).toBe("hot");
});
