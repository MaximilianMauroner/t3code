import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { OrchestrationReactorDeliveryReadiness } from "../../persistence/Services/OrchestrationReactorDeliveries.ts";

export interface OrchestrationDeliveryRuntimeShape {
  /** Starts the durable consumer. The domain event stream is only a wakeup hint. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Processes ordered durable work until the first unresolved blocker or completion. */
  readonly drain: Effect.Effect<void>;
  /** Exposes unresolved and poison rows to the startup readiness gate. */
  readonly inspectReadiness: Effect.Effect<OrchestrationReactorDeliveryReadiness, unknown>;
}

export class OrchestrationDeliveryRuntime extends Context.Service<
  OrchestrationDeliveryRuntime,
  OrchestrationDeliveryRuntimeShape
>()("t3/orchestration/Services/OrchestrationDeliveryRuntime") {}
