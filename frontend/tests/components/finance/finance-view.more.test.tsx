// Deeper integration coverage for the Finance surface through <FinanceView/>, complementing
// finance-view.test.tsx. We reuse that file's local default fetch router and override ONE endpoint
// per test to reach a feature's branch (accordion expand, sources drawer, carousel pagination,
// needsKey, research loading/error, predictions percentages, right-rail asides). All asserted
// values come from THESE mocks — no fabricated real-world finance numbers.
import { describe, expect, test } from "bun:test";

import { mockFetch, renderWithProviders, screen, fireEvent, waitFor, within, type Routes } from "@tests/helpers/utils";
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

/* ── helpers to build N discover articles (for carousel pagination) ────────── */
function articles(n: number) {
  return Array.from({ length: n }).map((_, i) => ({
    id: `a${i}`,
    title: `Headline number ${i}`,
    source: "Reuters",
    url: `https://reuters.com/a${i}`,
    image: null,
    publishedAt: PAST,
    category: "markets",
  }));
}

describe("FinanceView — MarketSummary", () => {
  test("the default-open headline shows its body; a second headline expands on click", async () => {
    mockFetch(
      financeRoutes({
        "/finance/summary": {
          json: {
            items: [
              { headline: "Stocks rallied broadly", body: "Body for the first summary item." },
              { headline: "Bond yields eased", body: "Body for the second summary item." },
            ],
            sources: [{ title: "Reuters", url: "https://reuters.com/x", content: "ctx" }],
            updatedAt: PAST,
            provenance: prov,
          },
        },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    // First item is open by default (defaultValue="item-0") → its body is visible.
    expect(await screen.findByText("Body for the first summary item.")).toBeInTheDocument();

    // Click the second headline (accordion trigger) → its body becomes visible.
    fireEvent.click(await screen.findByRole("button", { name: "Bond yields eased" }));
    expect(await screen.findByText("Body for the second summary item.")).toBeInTheDocument();
  });

  test("the sources button opens the sources drawer listing the sources", async () => {
    mockFetch(
      financeRoutes({
        "/finance/summary": {
          json: {
            items: [{ headline: "Markets rise", body: "Stocks climbed today." }],
            sources: [
              { title: "Reuters market wrap", url: "https://reuters.com/x", content: "ctx" },
              { title: "Bloomberg recap", url: "https://bloomberg.com/y", content: "ctx2" },
            ],
            updatedAt: PAST,
            provenance: prov,
          },
        },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    // The summary card carries a "2 sources" button (span text, not a heading).
    const trigger = await screen.findByRole("button", { name: /2 sources/ });
    fireEvent.click(trigger);

    // The drawer mounts a heading "2 sources" + the source titles.
    expect(await screen.findByRole("heading", { name: "2 sources" })).toBeInTheDocument();
    expect(screen.getByText("Reuters market wrap")).toBeInTheDocument();
    expect(screen.getByText("Bloomberg recap")).toBeInTheDocument();

    // It can be closed via the labelled close button.
    fireEvent.click(screen.getByRole("button", { name: "Close sources" }));
  });
});

describe("FinanceView — DiscoverCarousel", () => {
  test("paginates with Next/Previous and page dots when there are >3 articles", async () => {
    mockFetch(
      financeRoutes({
        "/finance/discover": { json: { articles: articles(7), provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    // Page 1 of 3 (7 articles / 3 per page = ceil → 3 pages). First three headlines show.
    expect(await screen.findByText("Headline number 0")).toBeInTheDocument();
    expect(screen.getByText("Headline number 2")).toBeInTheDocument();
    expect(screen.queryByText("Headline number 3")).not.toBeInTheDocument();

    // Page dots: 3 pages → 3 "Page N" buttons.
    expect(screen.getByRole("button", { name: "Page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 3" })).toBeInTheDocument();

    // Previous is disabled on the first page.
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    // Next → page 2 reveals articles 3..5.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Headline number 3")).toBeInTheDocument();
    expect(screen.queryByText("Headline number 0")).not.toBeInTheDocument();

    // Jump to the last page via its dot → article 6 (the remainder) shows; Next is disabled.
    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(await screen.findByText("Headline number 6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    // Previous works going back.
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Headline number 3")).toBeInTheDocument();
  });

  test("does NOT render pagination controls with 3 or fewer articles", async () => {
    mockFetch(
      financeRoutes({
        "/finance/discover": { json: { articles: articles(2), provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByText("Headline number 0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Page 1" })).not.toBeInTheDocument();
  });

  test("shows the FINNHUB_API_KEY needsKey prompt for US markets", async () => {
    mockFetch(
      financeRoutes({
        "/finance/discover": { json: { articles: [], needsKey: true, provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByText("FINNHUB_API_KEY")).toBeInTheDocument();
  });

  test("shows the NEWSDATA_API_KEY needsKey prompt for India markets", async () => {
    mockFetch(
      financeRoutes({
        // Both US and IN discover report needsKey so the prompt is shown after the market switch.
        "/finance/discover": { json: { articles: [], needsKey: true, provenance: prov } },
        "/finance/discover?market=in": { json: { articles: [], needsKey: true, provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    // Switch to India Markets via the market dropdown.
    fireEvent.click(await screen.findByRole("button", { name: /US Markets/ }));
    fireEvent.click(await screen.findByText("India Markets"));

    expect(await screen.findByText("NEWSDATA_API_KEY")).toBeInTheDocument();
  });

  test("shows the empty state when there is no news", async () => {
    mockFetch(
      financeRoutes({
        "/finance/discover": { json: { articles: [], provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByText("No news right now.")).toBeInTheDocument();
  });
});

describe("FinanceView — Research tab", () => {
  test("renders a research note after loading", async () => {
    mockFetch(
      financeRoutes({
        "/finance/research": {
          json: {
            notes: [
              {
                category: "macro",
                label: "Macro",
                title: "Soft-landing odds improve",
                summary: "A concise macro read.",
                keyPoints: ["Disinflation continues"],
                body: ["Full paragraph of analysis."],
                sources: [{ title: "Source", url: "https://s.com" }],
                updatedAt: PAST,
              },
            ],
          },
        },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Research" }));

    // Section heading mounts immediately…
    expect(await screen.findByRole("heading", { name: "Global Research" })).toBeInTheDocument();
    // …then the note renders.
    expect(await screen.findByText("Soft-landing odds improve")).toBeInTheDocument();
    expect(screen.getByText("A concise macro read.")).toBeInTheDocument();
  });

  test("shows the loading note while research is in flight", async () => {
    // Delay the research response so the loading branch is observable.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mockFetch(
      financeRoutes({
        "/finance/research": async () => {
          await gate;
          return { json: { notes: [{ category: "macro", label: "Macro", title: "Outlook", summary: "x", keyPoints: [], body: [], sources: [], updatedAt: PAST }] } };
        },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Research" }));
    expect(await screen.findByText(/Generating research notes/)).toBeInTheDocument();

    // Let it resolve so we don't leave a dangling promise.
    release();
    expect(await screen.findByText("Outlook")).toBeInTheDocument();
  });

  test("shows the error state when research has no notes", async () => {
    mockFetch(
      financeRoutes({
        "/finance/research": { json: { notes: [] } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Research" }));
    expect(await screen.findByText(/Couldn.t load/)).toBeInTheDocument();
  });

  test("shows the error state when the research endpoint fails", async () => {
    mockFetch(financeRoutes({ "/finance/research": { status: 500 } }));
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Research" }));
    expect(await screen.findByText(/Couldn.t load/)).toBeInTheDocument();
  });
});

describe("FinanceView — Predictions tab", () => {
  test("renders a prediction market with Yes/No percentages", async () => {
    mockFetch(
      financeRoutes({
        "/finance/predictions": {
          json: {
            markets: [
              {
                id: "m1",
                question: "Will the index close green today?",
                url: "https://poly/x",
                image: null,
                volume: 12000,
                endDate: null,
                outcomes: [
                  { label: "Yes", probability: 0.62 },
                  { label: "No", probability: 0.38 },
                ],
              },
            ],
            provenance: { ...prov, unit: "USD" },
          },
        },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Predictions" }));

    // The question also appears in the right-rail PredictionsMiniAside, so scope to the main
    // column's PredictionCard (the <a> that holds the percentage bars).
    const main = await screen.findByRole("main");
    const question = await within(main).findByText("Will the index close green today?");
    const card = question.closest("a")!;
    // Outcome labels + rounded percentages (0.62 → 62%, 0.38 → 38%) come straight from the mock.
    // The percent value is rendered as two text nodes ("62" + "%"), so match on the span's
    // normalized textContent rather than a single text node.
    expect(within(card).getByText("Yes")).toBeInTheDocument();
    expect(within(card).getByText("No")).toBeInTheDocument();
    const pctText = (s: string) => (_: string, el: Element | null) =>
      el?.tagName === "SPAN" && el.textContent?.replace(/\s+/g, "") === s;
    expect(within(card).getByText(pctText("62%"))).toBeInTheDocument();
    expect(within(card).getByText(pctText("38%"))).toBeInTheDocument();
  });
});

describe("FinanceView — right-rail asides", () => {
  test("WatchlistAside shows the TWELVE_DATA_API_KEY prompt when stocks need a key", async () => {
    mockFetch(
      financeRoutes({
        "/finance/stocks": { json: { items: [], needsKey: true, provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Watchlist" })).toBeInTheDocument();
    expect(await screen.findByText("TWELVE_DATA_API_KEY")).toBeInTheDocument();
  });

  test("WatchlistAside shows the empty state when there are no quotes", async () => {
    mockFetch(
      financeRoutes({
        "/finance/stocks": { json: { items: [], provenance: prov, currency: "USD" } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByText("No quotes available.")).toBeInTheDocument();
  });

  test("EquitySectorsAside shows the empty state when there is no sector data", async () => {
    mockFetch(
      financeRoutes({
        "/finance/sectors": { json: { items: [], provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Equity Sectors" })).toBeInTheDocument();
    expect(await screen.findByText("No sector data available.")).toBeInTheDocument();
  });

  test("PopularCryptoAside filters out stablecoins and caps the list at 5", async () => {
    // 6 non-stablecoins + USDT. The aside should drop USDT and show only the first 5 non-stables.
    const coins = [
      { id: "bitcoin", symbol: "BTC", name: "Bitcoin", image: "https://img/btc.png", price: 60000, change24h: 1, marketCap: 1e12, sparkline: [1, 2] },
      { id: "tether", symbol: "USDT", name: "Tether", image: "https://img/usdt.png", price: 1, change24h: 0, marketCap: 9e11, sparkline: [1, 1] },
      { id: "ethereum", symbol: "ETH", name: "Ethereum", image: "https://img/eth.png", price: 3000, change24h: 2, marketCap: 4e11, sparkline: [1, 2] },
      { id: "solana", symbol: "SOL", name: "Solana", image: "https://img/sol.png", price: 150, change24h: 3, marketCap: 7e10, sparkline: [1, 2] },
      { id: "ripple", symbol: "XRP", name: "Ripple", image: "https://img/xrp.png", price: 0.5, change24h: -1, marketCap: 3e10, sparkline: [1, 2] },
      { id: "cardano", symbol: "ADA", name: "Cardano", image: "https://img/ada.png", price: 0.4, change24h: 1, marketCap: 1e10, sparkline: [1, 2] },
      { id: "dogecoin", symbol: "DOGE", name: "Dogecoin", image: "https://img/doge.png", price: 0.1, change24h: 5, marketCap: 9e9, sparkline: [1, 2] },
    ];
    mockFetch(
      financeRoutes({
        "/finance/crypto": { json: { coins, provenance: prov } },
      }),
    );
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    const heading = await screen.findByRole("heading", { name: "Popular Cryptocurrencies" });
    const aside = heading.closest("div")!;

    // USDT is a stablecoin → excluded everywhere it would appear in this aside.
    await waitFor(() => expect(within(aside).getByText("Bitcoin")).toBeInTheDocument());
    expect(within(aside).queryByText("Tether")).not.toBeInTheDocument();

    // Capped at 5 non-stables: BTC, ETH, SOL, XRP, ADA shown; the 6th (DOGE) dropped.
    expect(within(aside).getByText("Ethereum")).toBeInTheDocument();
    expect(within(aside).getByText("Cardano")).toBeInTheDocument();
    expect(within(aside).queryByText("Dogecoin")).not.toBeInTheDocument();
  });
});
