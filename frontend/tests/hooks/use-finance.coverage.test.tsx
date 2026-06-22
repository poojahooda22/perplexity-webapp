// Coverage for the remaining finance data hooks — TanStack Query success/error states and the
// market-aware ?market=in query param, driven by the fetch mock. (Archetype: data hook.)
// Complements use-finance.test.tsx (which already covers useCrypto + useIndices).
import { describe, expect, test } from "bun:test";

import { mockFetch, renderHookWithProviders, waitFor } from "@tests/helpers/utils";
import {
  useDiscover,
  useMarketSummary,
  usePredictions,
  useResearch,
  useSectors,
  useStocks,
} from "@/hooks/use-finance";

const prov = { source: "TestProvider", commercialOk: false, attribution: "Data: TestProvider" };

// True when at least one call hit `path` carrying exactly ?market=in.
const hitWithMarketIn = (
  calls: { pathname: string; url: URL }[],
  path: string,
) => calls.some((c) => c.pathname === path && c.url.search === "?market=in");

describe("useStocks", () => {
  test("resolves to the quotes payload on 200", async () => {
    mockFetch({
      "/finance/stocks": {
        json: {
          items: [
            { symbol: "AAPL", name: "Apple", price: 200, change: 1.5, changePercent: 0.75, sparkline: [1, 2] },
          ],
          provenance: prov,
        },
      },
    });
    const { result } = renderHookWithProviders(() => useStocks());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.symbol).toBe("AAPL");
  });

  test("surfaces isError on 500", async () => {
    mockFetch({ "/finance/stocks": { status: 500 } });
    const { result } = renderHookWithProviders(() => useStocks());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  test("keys the request by market (?market=in)", async () => {
    const { calls } = mockFetch({ "/finance/stocks": { json: { items: [], provenance: prov } } });
    const { result } = renderHookWithProviders(() => useStocks("in"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(hitWithMarketIn(calls, "/finance/stocks")).toBe(true);
  });
});

describe("useSectors", () => {
  test("resolves to the sectors payload on 200", async () => {
    mockFetch({
      "/finance/sectors": {
        json: {
          items: [
            { symbol: "XLK", name: "Technology", price: 250, change: 2, changePercent: 0.8 },
          ],
          provenance: prov,
        },
      },
    });
    const { result } = renderHookWithProviders(() => useSectors());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.name).toBe("Technology");
  });

  test("surfaces isError on 500", async () => {
    mockFetch({ "/finance/sectors": { status: 500 } });
    const { result } = renderHookWithProviders(() => useSectors());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  test("keys the request by market (?market=in)", async () => {
    const { calls } = mockFetch({ "/finance/sectors": { json: { items: [], provenance: prov } } });
    const { result } = renderHookWithProviders(() => useSectors("in"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(hitWithMarketIn(calls, "/finance/sectors")).toBe(true);
  });
});

describe("useMarketSummary", () => {
  test("resolves to the summary payload on 200", async () => {
    mockFetch({
      "/finance/summary": {
        json: {
          items: [{ headline: "Markets steady", body: "Indices little changed." }],
          sources: [{ title: "Wire", url: "https://example.com", content: "..." }],
          updatedAt: "2026-06-22T00:00:00Z",
          provenance: prov,
        },
      },
    });
    const { result } = renderHookWithProviders(() => useMarketSummary());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.headline).toBe("Markets steady");
  });

  test("surfaces isError on 500", async () => {
    mockFetch({ "/finance/summary": { status: 500 } });
    const { result } = renderHookWithProviders(() => useMarketSummary());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  test("keys the request by market (?market=in)", async () => {
    const { calls } = mockFetch({
      "/finance/summary": {
        json: { items: [], sources: [], updatedAt: "2026-06-22T00:00:00Z", provenance: prov },
      },
    });
    const { result } = renderHookWithProviders(() => useMarketSummary("in"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(hitWithMarketIn(calls, "/finance/summary")).toBe(true);
  });
});

describe("useResearch", () => {
  test("resolves to the research notes payload on 200", async () => {
    mockFetch({
      "/finance/research": {
        json: {
          notes: [
            {
              category: "macro",
              label: "Macro",
              title: "Rates outlook",
              summary: "Summary text",
              keyPoints: ["point one"],
              body: ["paragraph one"],
              sources: [{ title: "Source", url: "https://example.com" }],
              updatedAt: "2026-06-22T00:00:00Z",
            },
          ],
        },
      },
    });
    const { result } = renderHookWithProviders(() => useResearch());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.notes[0]?.title).toBe("Rates outlook");
  });

  test("surfaces isError on 500", async () => {
    mockFetch({ "/finance/research": { status: 500 } });
    const { result } = renderHookWithProviders(() => useResearch());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("usePredictions", () => {
  test("resolves to the prediction markets payload on 200", async () => {
    mockFetch({
      "/finance/predictions": {
        json: {
          markets: [
            {
              id: "mkt-1",
              question: "Will it rain tomorrow?",
              url: "https://example.com",
              image: null,
              volume: 1000,
              endDate: "2026-12-31T00:00:00Z",
              outcomes: [
                { label: "Yes", probability: 0.6 },
                { label: "No", probability: 0.4 },
              ],
            },
          ],
          provenance: prov,
        },
      },
    });
    const { result } = renderHookWithProviders(() => usePredictions());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.markets[0]?.question).toBe("Will it rain tomorrow?");
    expect(result.current.data?.markets[0]?.outcomes).toHaveLength(2);
  });

  test("surfaces isError on 500", async () => {
    mockFetch({ "/finance/predictions": { status: 500 } });
    const { result } = renderHookWithProviders(() => usePredictions());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useDiscover", () => {
  test("resolves to the discover articles payload on 200", async () => {
    mockFetch({
      "/finance/discover": {
        json: {
          articles: [
            {
              id: "art-1",
              title: "Markets recap",
              source: "Wire",
              url: "https://example.com",
              image: null,
              publishedAt: "2026-06-22T00:00:00Z",
              category: "markets",
            },
          ],
          provenance: prov,
        },
      },
    });
    const { result } = renderHookWithProviders(() => useDiscover());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.articles[0]?.title).toBe("Markets recap");
  });

  test("surfaces isError on 500", async () => {
    mockFetch({ "/finance/discover": { status: 500 } });
    const { result } = renderHookWithProviders(() => useDiscover());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  test("keys the request by market (?market=in)", async () => {
    const { calls } = mockFetch({ "/finance/discover": { json: { articles: [], provenance: prov } } });
    const { result } = renderHookWithProviders(() => useDiscover("in"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(hitWithMarketIn(calls, "/finance/discover")).toBe(true);
  });
});
