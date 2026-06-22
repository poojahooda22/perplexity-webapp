// Integration tests for the Finance surface through <FinanceView/>. The sub-sections (TopAssets,
// MarketSummary, Heatmap, DiscoverCarousel, Crypto, Research, Predictions, Watchlist, EquitySectors,
// PopularCrypto, PredictionsMini) are internal, so we drive them via the real fetch router and
// override ONE endpoint per test to reach each feature's edge branch (needsKey / error / empty).
import { describe, expect, test } from "bun:test";

import { mockFetch, renderWithProviders, screen, fireEvent, waitFor, type Routes } from "@tests/helpers/utils";
import { FinanceView } from "@/components/finance/finance-view";

const prov = { source: "Yahoo", commercialOk: false, attribution: "Live · Yahoo" };
const PAST = "2026-06-22T00:00:00Z";

// Full happy-path router for every endpoint FinanceView touches. Spread overrides on top.
function financeRoutes(overrides: Routes = {}): Routes {
  return {
    "/finance/indices": { json: { items: [{ symbol: "SPX", name: "S&P 500", price: 5000, change: 10, changePercent: 0.2, sparkline: [1, 2, 3] }], provenance: prov } },
    "/finance/summary": { json: { items: [{ headline: "Markets rise", body: "Stocks climbed today." }], sources: [{ title: "Reuters", url: "https://reuters.com/x", content: "ctx" }], updatedAt: PAST, provenance: prov } },
    "/finance/sectors": { json: { items: [{ symbol: "XLK", name: "Technology", price: 200, change: 1, changePercent: 0.5 }], provenance: prov } },
    "/finance/stocks": { json: { items: [{ symbol: "AAPL", name: "Apple", price: 180, change: 1, changePercent: 0.6, sparkline: [1, 2] }], provenance: prov, currency: "USD" } },
    "/finance/crypto": { json: { coins: [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", image: "https://img/btc.png", price: 60000, change24h: 1.2, marketCap: 1e12, sparkline: [1, 2, 3] }], provenance: prov } },
    "/finance/predictions": { json: { markets: [{ id: "m1", question: "Will X happen?", url: "https://poly/x", image: null, volume: 1000, endDate: null, outcomes: [{ label: "Yes", probability: 0.6 }, { label: "No", probability: 0.4 }] }], provenance: { ...prov, unit: "USD" } } },
    "/finance/discover": { json: { articles: [{ id: "a1", title: "Big market news", source: "Reuters", url: "https://reuters.com/a", image: null, publishedAt: PAST, category: "markets" }], provenance: prov } },
    "/finance/research": { json: { notes: [{ category: "macro", label: "Macro", title: "Outlook", summary: "A note.", keyPoints: ["point"], body: ["para"], sources: [{ title: "S", url: "https://s.com" }], updatedAt: PAST }] } },
    ...(overrides as Record<string, unknown>),
  } as Routes;
}

describe("FinanceView", () => {
  test("Markets tab renders Top Assets + the right-rail asides", async () => {
    mockFetch(financeRoutes());
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Top Assets" })).toBeInTheDocument();
    expect(await screen.findByText("AAPL")).toBeInTheDocument(); // Watchlist
    expect(await screen.findByText("Technology")).toBeInTheDocument(); // Equity Sectors
    expect(await screen.findByText("Bitcoin")).toBeInTheDocument(); // Popular Cryptocurrencies
    expect(screen.getByRole("heading", { name: "Watchlist" })).toBeInTheDocument();
  });

  test("switching to the Crypto tab shows the crypto grid", async () => {
    mockFetch(financeRoutes());
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Crypto" }));
    expect(await screen.findByRole("heading", { name: "Crypto" })).toBeInTheDocument();
  });

  test("Top Assets shows the NeedsKey prompt when the API reports needsKey", async () => {
    mockFetch(financeRoutes({ "/finance/indices": { json: { items: [], needsKey: true, provenance: prov } } }));
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByText(/Twelve Data/)).toBeInTheDocument();
  });

  test("Top Assets shows the error state when indices fail", async () => {
    mockFetch(financeRoutes({ "/finance/indices": { status: 500 } }));
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByText(/Couldn.t load/)).toBeInTheDocument();
  });

  test("switching to India Markets re-fetches indices with ?market=in", async () => {
    const { calls } = mockFetch(financeRoutes());
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /US Markets/ }));
    fireEvent.click(await screen.findByText("India Markets"));

    await waitFor(() =>
      expect(calls.some((c) => c.pathname === "/finance/indices" && c.url.search === "?market=in")).toBe(true),
    );
  });

  test("the docked composer forwards the typed query to onAsk", async () => {
    mockFetch(financeRoutes());
    const onAsk = (() => {
      const fn = (q: string) => calls.push(q);
      const calls: string[] = [];
      (fn as unknown as { calls: string[] }).calls = calls;
      return fn as ((q: string, a: unknown[]) => void) & { calls: string[] };
    })();

    renderWithProviders(<FinanceView onAsk={onAsk} />);
    const box = await screen.findByPlaceholderText("Ask about finance...");
    fireEvent.change(box, { target: { value: "What moved markets?" } });
    fireEvent.submit(box.closest("form")!);

    expect(onAsk.calls).toContain("What moved markets?");
  });
});
