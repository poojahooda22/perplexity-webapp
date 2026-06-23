// Market Insights ("Pulse") data hooks — TanStack Query wiring for the Finance > Insights tab.
// (Archetype: data hook.) Drives loading → success / error via the fetch mock, and proves the
// market-aware hooks key their request by ?market=.
import { describe, expect, test } from "bun:test";

import { mockFetch, renderHookWithProviders, waitFor } from "@tests/helpers/utils";
import {
  useBriefing,
  useGdelt,
  useMood,
  useRecession,
  useScorecard,
} from "@/hooks/use-finance";

const green = { source: "Lumina (Treasury/BLS/GDELT)", commercialOk: true, attribution: "Public-domain" };

const recession = {
  probability: 0.19,
  probabilityPct: 19,
  spread10y3m: 0.5,
  spread10y2y: 0.8,
  yields: { m3: 4.5, y2: 4.2, y10: 5 },
  curveInverted: false,
  sahm: null,
  asOf: "2026-06-20T00:00:00",
  methodology: "Estrella–Mishkin probit",
  caveat: "Informational only.",
  provenance: green,
};
const sentiment = {
  market: "us",
  score: 80,
  label: "Bullish",
  toneLatest: 10,
  toneSeries: [{ t: 1, v: 1 }, { t: 2, v: 2 }],
  buzz: 60,
  buzzSeries: [],
  caveat: "Media sentiment, not price.",
  provenance: green,
};
const mood = {
  market: "us",
  score: 55,
  label: "Greed",
  components: [{ name: "Recession risk", score: 81, note: "low" }],
  asOf: "2026-06-20T00:00:00",
  caveat: "Macro composite.",
  provenance: green,
};
const briefing = {
  market: "us",
  columnist: "The Lumina Tape",
  generatedAt: "2026-06-20T12:00:00.000Z",
  marketTake: { mood: "mixed", headline: "Markets steady", body: "Quiet session." },
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
};
const scorecard = {
  signalKey: "market_mood.us",
  summary: { total: 0, resolved: 0, correct: 0, hitRate: null, open: 0 },
  calls: [],
  moodHistory: [],
};

describe("use-finance insights hooks", () => {
  test("useRecession resolves to the payload", async () => {
    mockFetch({ "/finance/recession": { json: recession } });
    const { result } = renderHookWithProviders(() => useRecession());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.probabilityPct).toBe(19);
    expect(result.current.data?.provenance.commercialOk).toBe(true);
  });

  test("useRecession surfaces isError on 502", async () => {
    mockFetch({ "/finance/recession": { status: 502 } });
    const { result } = renderHookWithProviders(() => useRecession());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  test("useGdelt keys the request by market", async () => {
    const { calls } = mockFetch({ "/finance/gdelt": { json: { ...sentiment, market: "in" } } });
    const { result } = renderHookWithProviders(() => useGdelt("in"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.some((c) => c.pathname === "/finance/gdelt" && c.url.search === "?market=in")).toBe(true);
  });

  test("useMood keys the request by market and resolves components", async () => {
    const { calls } = mockFetch({ "/finance/mood": { json: { ...mood, market: "in" } } });
    const { result } = renderHookWithProviders(() => useMood("in"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.components[0]?.name).toBe("Recession risk");
    expect(calls.some((c) => c.pathname === "/finance/mood" && c.url.search === "?market=in")).toBe(true);
  });

  test("useBriefing keys the request by market and resolves the columnist", async () => {
    const { calls } = mockFetch({ "/finance/briefing": { json: briefing } });
    const { result } = renderHookWithProviders(() => useBriefing("us"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.columnist).toBe("The Lumina Tape");
    // US is the default → no ?market= query string.
    expect(calls.some((c) => c.pathname === "/finance/briefing" && c.url.search === "")).toBe(true);
  });

  test("useScorecard resolves the track-record payload (no market param)", async () => {
    mockFetch({ "/finance/scorecard": { json: scorecard } });
    const { result } = renderHookWithProviders(() => useScorecard());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.signalKey).toBe("market_mood.us");
    expect(result.current.data?.summary.hitRate).toBeNull();
  });
});
