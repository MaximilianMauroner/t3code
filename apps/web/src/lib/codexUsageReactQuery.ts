import type { ProviderInstanceId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureLocalApi } from "../localApi";

const CODEX_USAGE_CACHE_MS = 5 * 60_000;

export const codexUsageQueryKeys = {
  all: ["codexUsage"] as const,
  byInstance: (instanceId: ProviderInstanceId | null) => ["codexUsage", instanceId] as const,
};

export function codexUsageQueryOptions(input: {
  instanceId: ProviderInstanceId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: codexUsageQueryKeys.byInstance(input.instanceId),
    queryFn: async () => {
      if (!input.instanceId) {
        return null;
      }
      return ensureLocalApi().server.getCodexUsage({ instanceId: input.instanceId });
    },
    enabled: (input.enabled ?? true) && input.instanceId !== null,
    staleTime: CODEX_USAGE_CACHE_MS,
    gcTime: 15 * 60_000,
    refetchInterval: CODEX_USAGE_CACHE_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
