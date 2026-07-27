import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createProviderUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    codex: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider-usage:codex",
      tag: WS_METHODS.serverGetCodexUsage,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
    }),
  };
}
