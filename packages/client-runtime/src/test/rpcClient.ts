import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReplayEventsInput,
  type OrchestrationReplayEventsResult,
  type OrchestrationSubscribeThreadInput,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

export function makeReplayEventsTestRpcClient(
  handler: (
    input: OrchestrationReplayEventsInput,
  ) => Effect.Effect<OrchestrationReplayEventsResult>,
): WsRpcProtocolClient {
  return Object.assign(Object.create(null), {
    [ORCHESTRATION_WS_METHODS.replayEvents]: handler,
  });
}

export function makeSubscribeThreadTestRpcClient(
  handler: (
    input: OrchestrationSubscribeThreadInput,
  ) => Stream.Stream<OrchestrationThreadStreamItem, Error>,
): WsRpcProtocolClient {
  return Object.assign(Object.create(null), {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: handler,
  });
}
