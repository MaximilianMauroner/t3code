import { assert, it } from "@effect/vitest";

import {
  EnvironmentInternalError,
  EnvironmentOrchestrationNotReadyError,
} from "@t3tools/contracts";

import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  ProjectOrchestrationNotReadyError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves orchestration readiness metadata for CLI retries", () => {
  const cause = new EnvironmentOrchestrationNotReadyError({
    code: "orchestration_not_ready",
    retryable: true,
    retryAfterMs: 1_000,
    phase: "reconciling",
    traceId: "trace-ready",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectOrchestrationNotReadyError);
  assert.strictEqual(error.code, "orchestration_not_ready");
  assert.strictEqual(error.retryable, true);
  assert.strictEqual(error.retryAfterMs, 1_000);
  assert.strictEqual(error.phase, "reconciling");
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});
