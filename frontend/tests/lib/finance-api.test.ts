// Unit tests for the finance data layer — the fetch boundary itself: correct URL + query params,
// JSON parsing, and error throwing on non-2xx. (Archetype: API module.)
import { describe, expect, test } from "bun:test";

import { mockFetch } from "@tests/helpers/utils";
import {
  fetchCrypto,
  fetchIndices,
  fetchMarketSummary,
  fetchStocks,
} from "@/lib/finance-api";

const prov = { source: "CoinGecko", commercialOk: false, attribution: "Data: CoinGecko" };

describe("finance-api", () => {
  test("fetchCrypto parses coins on 200", async () => {
    mockFetch({
      "/finance/crypto": {
        json: {
          coins: [
            { id: "bitcoin", symbol: "BTC", name: "Bitcoin", image: "", price: 60000, change24h: 1.2, marketCap: 1e12, sparkline: [1, 2, 3] },
          ],
          provenance: prov,
        },
      },
    });
    const data = await fetchCrypto();
    expect(data.coins).toHaveLength(1);
    expect(data.coins[0]?.symbol).toBe("BTC");
  });

  test("throws with path + status on non-2xx", async () => {
    mockFetch({ "/finance/crypto": { status: 503 } });
    await expect(fetchCrypto()).rejects.toThrow("/finance/crypto → 503");
  });

  test("fetchIndices appends ?market=in for India", async () => {
    const { calls } = mockFetch({ "/finance/indices": { json: { items: [], provenance: prov } } });
    await fetchIndices("in");
    expect(calls[0]?.url.search).toBe("?market=in");
  });

  test("fetchIndices US (default) sends no market query", async () => {
    const { calls } = mockFetch({ "/finance/indices": { json: { items: [], provenance: prov } } });
    await fetchIndices();
    expect(calls[0]?.url.search).toBe("");
    expect(calls[0]?.pathname).toBe("/finance/indices");
  });

  test("fetchStocks + fetchMarketSummary hit their endpoints", async () => {
    const { calls } = mockFetch({
      "/finance/stocks": { json: { items: [], provenance: prov } },
      "/finance/summary": { json: { items: [], sources: [], updatedAt: "2026-01-01T00:00:00Z", provenance: prov } },
    });
    await fetchStocks("us");
    await fetchMarketSummary("us");
    expect(calls.map((c) => c.pathname)).toEqual(["/finance/stocks", "/finance/summary"]);
  });
});
