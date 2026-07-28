import { AuthOrchestrationReadScope, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { requiredScopeForRpcMethod } from "./ws.ts";

describe("WebSocket RPC authorization", () => {
  it("allows read-authorized sessions to query Codex usage", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetCodexUsage)).toBe(
      AuthOrchestrationReadScope,
    );
  });
});
