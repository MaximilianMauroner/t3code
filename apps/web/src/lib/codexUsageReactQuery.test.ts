import { type LocalApi, ProviderInstanceId } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureLocalApi } from "../localApi";
import { codexUsageQueryOptions } from "./codexUsageReactQuery";

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(),
}));

const codexInstanceId = ProviderInstanceId.make("codex");
const mockEnsureLocalApi = vi.mocked(ensureLocalApi);

function mockLocalApi(input: { getCodexUsage: ReturnType<typeof vi.fn> }) {
  mockEnsureLocalApi.mockReturnValue({
    server: {
      getCodexUsage: input.getCodexUsage,
    },
  } as unknown as LocalApi);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("codexUsageQueryOptions", () => {
  it("loads usage for the selected Codex instance", async () => {
    const getCodexUsage = vi.fn().mockResolvedValue({
      providerInstanceId: codexInstanceId,
      checkedAt: "2026-05-04T00:00:00.000Z",
      windows: [],
      rateLimitReachedType: null,
      source: "read",
    });
    mockLocalApi({ getCodexUsage });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(codexUsageQueryOptions({ instanceId: codexInstanceId }));

    expect(getCodexUsage).toHaveBeenCalledWith({ instanceId: codexInstanceId });
    queryClient.clear();
  });

  it("disables the query when no instance is selected", () => {
    expect(codexUsageQueryOptions({ instanceId: codexInstanceId, enabled: false }).enabled).toBe(
      false,
    );
    expect(codexUsageQueryOptions({ instanceId: null }).enabled).toBe(false);
  });

  it("uses a warm cache instead of refetching usage on focus and mount", () => {
    const options = codexUsageQueryOptions({ instanceId: codexInstanceId });

    expect(options.staleTime).toBe(5 * 60_000);
    expect(options.refetchInterval).toBe(5 * 60_000);
    expect(options.refetchOnMount).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options.retry).toBe(false);
  });
});
