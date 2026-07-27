import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { environmentRpcKey } from "./runtime";

describe("Codex provider usage query identity", () => {
  it("includes the environment, provider instance, and selected model", () => {
    const environmentId = EnvironmentId.make("local");
    const base = {
      environmentId,
      input: {
        providerInstanceId: ProviderInstanceId.make("codex-personal"),
        model: "gpt-5.2-codex",
      },
    };
    const first = environmentRpcKey(base);
    expect(
      environmentRpcKey({
        ...base,
        input: { ...base.input, model: "gpt-5.3-codex" },
      }),
    ).not.toBe(first);
    expect(
      environmentRpcKey({
        ...base,
        input: {
          ...base.input,
          providerInstanceId: ProviderInstanceId.make("codex-work"),
        },
      }),
    ).not.toBe(first);
  });
});
