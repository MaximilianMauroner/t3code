/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  DispatchableClientOrchestrationCommand,
  OrchestrationCommand,
  OrchestrationEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationHotAdmissionReservation {
  /** Consumes the reservation by enqueueing its one hot command. */
  readonly dispatch: (
    command: DispatchableClientOrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;
  /** Releases an unused reservation after bootstrap cleanup has finished. */
  readonly cancel: Effect.Effect<void, never, never>;
}

export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to read. Defaults to the event
   *   store's page-bounded default; pass a higher value when the caller must
   *   read every event after the cursor (e.g. per-thread catch-up that filters
   *   a small subset out of a potentially larger global range).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  readonly dispatchExternal: (
    command: DispatchableClientOrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  readonly dispatchInternal: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /** Linearizably rejects new external commands while preserving internal recovery dispatch. */
  readonly closeExternalAdmission: Effect.Effect<void, never, never>;

  /** Opens hot external command admission after startup recovery is fully settled. */
  readonly openExternalAdmission: Effect.Effect<void, never, never>;

  /** Reserves one hot enqueue before a bootstrap performs side effects. */
  readonly reserveExternalHotAdmission: (
    command: DispatchableClientOrchestrationCommand,
  ) => Effect.Effect<OrchestrationHotAdmissionReservation, OrchestrationDispatchError, never>;

  /** Resolves after all earlier envelopes have committed and planned deliveries are durable. */
  readonly barrier: Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /** Idempotently reject new work, stop the queue worker, and prohibit later publication. */
  readonly sealAndStop: Effect.Effect<void, never, never>;

  /** Immediately seals admission and tears down worker transports without an in-band queue stop. */
  readonly forceStop: Effect.Effect<void, never, never>;

  readonly isSealed: Effect.Effect<boolean, never, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * The latest sequence reflected in the engine's authoritative command read
   * model (0 if none). Used to gauge how far behind a resuming client is before
   * choosing between an incremental replay and a fresh projected snapshot.
   */
  readonly latestSequence: Effect.Effect<number, never, never>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
