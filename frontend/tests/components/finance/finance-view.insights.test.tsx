// FinanceView → "Insights" tab (Market Insights / "Pulse"). Renders the real FinanceView, switches
// to the Insights tab, and asserts the five cards (Briefing / Mood / Recession / Buzz / Scorecard)
// render their mocked payloads — plus a per-card error state. (Archetype: component integration.)
import { describe, expect, test } from "bun:test";

import { mockFetch, renderWithProviders, screen, fireEvent } from "@tests/helpers/utils";
import { FinanceView } from "@/components/finance/finance-view";

const green = { source: "Lumina (Treasury/BLS/GDELT)", commercialOk: true, attribution: "Public-domain" };
const empty = { provenance: { source: "x", commercialOk: false, attribution: "x" } };

function insightsRoutes(overrides: Record<string, unknown> = {}) {
  return {
    // Insights surfaces under test.
    "/finance/recession": {
      json: {
        probability: 0.19,
        probabilityPct: 19,
        spread10y3m: 0.5,
        spread10y2y: 0.8,
        yields: { m3: 4.5, y2: 4.2, y10: 5 },
        curveInverted: false,
        sahm: null,
        asOf: "2026-06-20T00:00:00",
        methodology: "probit",
        caveat: "Informational only.",
        provenance: green,
      },
    },
    "/finance/mood": {
      json: {
        market: "us",
        score: 55,
        label: "Greed",
        components: [
          { name: "Recession risk", score: 81, note: "low" },
          { name: "Yield curve", score: 50, note: "+0.5pp" },
        ],
        asOf: "2026-06-20T00:00:00",
        caveat: "Macro composite.",
        provenance: green,
      },
    },
    "/finance/gdelt": {
      json: {
        market: "us",
        score: 80,
        label: "Bullish",
        toneLatest: 10,
        toneSeries: [{ t: 1, v: 1 }, { t: 2, v: 3 }],
        buzz: 60,
        buzzSeries: [],
        caveat: "Media sentiment, not price.",
        provenance: green,
      },
    },
    "/finance/briefing": {
      json: {
        market: "us",
        columnist: "The Lumina Tape",
        generatedAt: "2026-06-20T12:00:00.000Z",
        marketTake: { mood: "mixed", headline: "Markets steady into the close", body: "A quiet session." },
        bottomLine: "Range-bound.",
        whatMoved: [],
        sentimentRead: "Neutral.",
        catalysts: [],
        onInvestorsMinds: [],
        followUps: [],
        levels: [],
        mood: null,
        recession: null,
        sentiment: null,
        sources: [],
        provenance: { source: "Lumina (AI)", commercialOk: false, attribution: "The Lumina Tape" },
      },
    },
    "/finance/scorecard": {
      json: {
        signalKey: "market_mood.us",
        summary: { total: 3, resolved: 3, correct: 2, hitRate: 67, open: 0 },
        calls: [],
        moodHistory: [],
      },
    },
    // Right-rail asides + the Markets tab (mounted before the click) — kept empty/quiet.
    "/finance/indices": { json: { items: [], ...empty } },
    "/finance/summary": { json: { items: [], sources: [], updatedAt: "2026-06-20T12:00:00.000Z", ...empty } },
    "/finance/discover": { json: { articles: [], ...empty } },
    "/finance/stocks": { json: { items: [], currency: "USD", ...empty } },
    "/finance/sectors": { json: { items: [], ...empty } },
    "/finance/crypto": { json: { coins: [], ...empty } },
    "/finance/predictions": { json: { markets: [], ...empty } },
    ...overrides,
  };
}

describe("FinanceView — Insights tab", () => {
  test("switching to Insights renders all five Pulse cards with their data", async () => {
    mockFetch(insightsRoutes());
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Insights" }));

    // The five card headings.
    expect(await screen.findByRole("heading", { name: "The Lumina Tape — Daily Briefing" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Lumina Market Mood" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Recession Risk" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Bull / Bear Buzz" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Track Record" })).toBeInTheDocument();

    // Live data rendered from the payloads.
    expect(await screen.findByText("Markets steady into the close")).toBeInTheDocument(); // briefing headline
    expect(await screen.findByText("19%")).toBeInTheDocument(); // recession probability
    expect(await screen.findByText("67%")).toBeInTheDocument(); // scorecard hit rate
    expect(await screen.findByText("/100")).toBeInTheDocument(); // GDELT buzz gauge (unique to BuzzCard)
  });

  test("a failing recession endpoint shows that card's error state", async () => {
    mockFetch(insightsRoutes({ "/finance/recession": { status: 502 } }));
    renderWithProviders(<FinanceView onAsk={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Insights" }));

    // The other cards still render; the recession panel degrades to the error message.
    expect(await screen.findByRole("heading", { name: "Lumina Market Mood" })).toBeInTheDocument();
    expect(await screen.findByText(/Couldn.t load/)).toBeInTheDocument();
  });
});