// Hook tests — TanStack Query states (loading → success / error) driven by the fetch mock.
// (Archetype: data hook.) Proves renderHookWithProviders + query wiring end to end.
import { describe, expect, test } from "bun:test";

import { mockFetch, renderHookWithProviders, waitFor } from "@tests/helpers/utils";
import { useCrypto, useIndices } from "@/hooks/use-finance";

const prov = { source: "CoinGecko", commercialOk: false, attribution: "Data: CoinGecko" };

describe("use-finance", () => {
  test("useCrypto resolves to the payload", async () => {
    mockFetch({
      "/finance/crypto": {
        json: {
          coins: [{ id: "eth", symbol: "ETH", name: "Ethereum", image: "", price: 3000, change24h: -2, marketCap: 4e11, sparkline: [1, 2] }],
          provenance: prov,
        },
      },
    });
    const { result } = renderHookWithProviders(() => useCrypto());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.coins[0]?.symbol).toBe("ETH");
  });

  test("useCrypto surfaces isError on 500", async () => {
    mockFetch({ "/finance/crypto": { status: 500 } });
    const { result } = renderHookWithProviders(() => useCrypto());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  test("useIndices keys the request by market", async () => {
    const { calls } = mockFetch({ "/finance/indices": { json: { items: [], provenance: prov } } });
    const { result } = renderHookWithProviders(() => useIndices("in"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.some((c) => c.pathname === "/finance/indices" && c.url.search === "?market=in")).toBe(true);
  });
});
