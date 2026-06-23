// Market Insights ("Pulse") — backend tests for the GREEN public-domain surfaces:
//   • fetchRecessionGauge  (US Treasury curve + BLS Sahm + Estrella–Mishkin probit)
//   • fetchNewsSentiment   (GDELT "Bull/Bear Buzz" tone/volume)
//   • fetchMarketMood      (GREEN-only macro-sentiment composite)
//   • getScorecard         (the public falsifiable track record, Prisma-backed)
//   • validateBriefing     (the "no stray numbers in prose" guard for The Lumina Tape)
//
// All upstreams are mocked at the fetch seam (mockFetch) or Prisma seam (prismaFake). The LLM
// (generateObject) is NOT exercised — we test the briefing's pure validation guard instead, per
// the "module mocks live in the preload only" convention.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  fetchRecessionGauge,
  fetchNewsSentiment,
  fetchMarketMood,
} from "../../finance/sentiment-sources";
import { getScorecard } from "../../finance/scorecard";
import { validateBriefing } from "../../finance/briefing";
import { mockFetch, type FetchMock } from "../helpers/fetch-mock";
import { prismaFake, resetPrisma } from "../helpers/prisma-fake";

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

/* ── fixtures ─────────────────────────────────────────────────────────── */

// Two dated rows; the parser keeps the max-date one → m3 4.50, y2 4.20, y10 5.00.
// ⇒ spread10y3m +0.50 (not inverted), spread10y2y +0.80.
const TREASURY_XML = `<?xml version="1.0" encoding="utf-8"?><feed>
<entry><content type="application/xml"><m:properties>
<d:NEW_DATE>2026-06-19T00:00:00</d:NEW_DATE>
<d:BC_3MONTH>4.30</d:BC_3MONTH><d:BC_2YEAR>4.00</d:BC_2YEAR><d:BC_10YEAR>4.10</d:BC_10YEAR>
</m:properties></content></entry>
<entry><content type="application/xml"><m:properties>
<d:NEW_DATE>2026-06-20T00:00:00</d:NEW_DATE>
<d:BC_3MONTH>4.50</d:BC_3MONTH><d:BC_2YEAR>4.20</d:BC_2YEAR><d:BC_10YEAR>5.00</d:BC_10YEAR>
</m:properties></content></entry>
</feed>`;

// 18 identical monthly U-3 readings (newest-first) → Sahm value 0.0, not triggered, U-3 4.0%.
const BLS_OK = {
  Results: {
    series: [
      {
        data: Array.from({ length: 18 }, () => ({
          year: "2026",
          period: "M05",
          periodName: "May",
          value: "4.0",
        })),
      },
    ],
  },
};

// GDELT timeline points: dates ascending, the LAST value is "latest".
const gdeltSeries = (values: number[]) =>
  values.map((v, i) => ({ date: `2026061${i}T000000Z`, value: v }));

// Route GDELT by ?mode= (tone vs volume) so a single key serves both sequential calls.
function gdeltRoutes(tone: number[], vol: number[] | "fail") {
  return (url: URL) => {
    const mode = url.searchParams.get("mode");
    if (mode === "timelinetone") return { json: { timeline: [{ data: gdeltSeries(tone) }] } };
    if (vol === "fail") return { status: 500 };
    return { json: { timeline: [{ data: gdeltSeries(vol) }] } };
  };
}

/* ── Recession gauge ──────────────────────────────────────────────────── */

describe("fetchRecessionGauge (Treasury + BLS + probit)", () => {
  test("parses the latest curve, computes the probit, and gates commercialOk=true", async () => {
    fm = mockFetch({
      "home.treasury.gov": { text: TREASURY_XML },
      "api.bls.gov": { json: BLS_OK },
    });
    const r = await fetchRecessionGauge();

    expect(r.yields).toEqual({ m3: 4.5, y2: 4.2, y10: 5 });
    expect(r.spread10y3m).toBe(0.5);
    expect(r.spread10y2y).toBe(0.8);
    expect(r.curveInverted).toBe(false);
    expect(r.asOf).toBe("2026-06-20T00:00:00");
    // Estrella–Mishkin probit on a +0.5pp spread → a low single/double-digit probability.
    expect(r.probability).toBeGreaterThan(0);
    expect(r.probability).toBeLessThan(1);
    expect(r.probabilityPct).toBe(Math.round(r.probability * 100));
    expect(r.provenance.commercialOk).toBe(true);
    expect(r.provenance.source).toMatch(/Treasury/);
  });

  test("includes the Sahm reading when BLS returns enough history", async () => {
    fm = mockFetch({
      "home.treasury.gov": { text: TREASURY_XML },
      "api.bls.gov": { json: BLS_OK },
    });
    const r = await fetchRecessionGauge();
    expect(r.sahm).not.toBeNull();
    expect(r.sahm!.value).toBe(0);
    expect(r.sahm!.triggered).toBe(false);
    expect(r.sahm!.latestUnemployment).toBe(4);
    expect(r.sahm!.asOf).toBe("May 2026");
  });

  test("degrades to sahm=null when BLS is down (curve still required)", async () => {
    fm = mockFetch({
      "home.treasury.gov": { text: TREASURY_XML },
      "api.bls.gov": { status: 500 },
    });
    const r = await fetchRecessionGauge();
    expect(r.sahm).toBeNull();
    expect(r.spread10y3m).toBe(0.5); // gauge still computed from the curve
  });

  test("throws when the Treasury curve is unavailable (so the cache 502s honestly)", async () => {
    fm = mockFetch({ "home.treasury.gov": { status: 500 } });
    await expect(fetchRecessionGauge()).rejects.toThrow(/Treasury 500/);
  });
});

/* ── GDELT news sentiment ─────────────────────────────────────────────── */

describe("fetchNewsSentiment (GDELT Bull/Bear Buzz)", () => {
  test("z-scores a strongly-positive tone series → Bullish, +score", async () => {
    fm = mockFetch({ "gdeltproject.org": gdeltRoutes([0, 0, 0, 0, 10], [10, 20, 30, 40, 25]) });
    const r = await fetchNewsSentiment("us");
    expect(r.score).toBe(80); // z=2, score=round(2*40)
    expect(r.label).toBe("Bullish");
    expect(r.toneLatest).toBe(10);
    expect(r.buzz).toBe(60); // latest 25 sits at the 60th percentile of [10,20,30,40,25]
    expect(r.provenance.commercialOk).toBe(true);
    expect(r.provenance.source).toBe("The GDELT Project");
  });

  test("z-scores a strongly-negative tone series → Bearish, -score", async () => {
    fm = mockFetch({ "gdeltproject.org": gdeltRoutes([0, 0, 0, 0, -10], [5, 5, 5, 5, 5]) });
    const r = await fetchNewsSentiment("us");
    expect(r.score).toBe(-80);
    expect(r.label).toBe("Bearish");
  });

  test("a flat tone series → Neutral (score 0)", async () => {
    fm = mockFetch({ "gdeltproject.org": gdeltRoutes([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]) });
    const r = await fetchNewsSentiment("us");
    expect(r.score).toBe(0);
    expect(r.label).toBe("Neutral");
  });

  test("buzz degrades to the 50 default when the volume timeline fails (tone still wins)", async () => {
    fm = mockFetch({ "gdeltproject.org": gdeltRoutes([0, 0, 0, 0, 10], "fail") });
    const r = await fetchNewsSentiment("us");
    expect(r.buzz).toBe(50);
    expect(r.buzzSeries).toEqual([]);
    expect(r.label).toBe("Bullish"); // tone leg unaffected
  });

  test("throws when GDELT returns its plaintext throttle notice", async () => {
    fm = mockFetch({ "gdeltproject.org": { text: "Please limit your use of this service." } });
    await expect(fetchNewsSentiment("us")).rejects.toThrow(/throttled|unavailable/i);
  });

  test("the India market keys the GDELT query by sourcecountry:IN", async () => {
    fm = mockFetch({ "gdeltproject.org": gdeltRoutes([0, 0, 0, 0, 5], [1, 2, 3, 4, 5]) });
    const r = await fetchNewsSentiment("in");
    expect(r.market).toBe("in");
    expect(decodeURIComponent(fm.calls[0]!.url.search)).toContain("sourcecountry:IN");
  });
});

/* ── Market Mood composite ────────────────────────────────────────────── */

describe("fetchMarketMood (GREEN-only macro composite)", () => {
  test("US: composes 3 components (recession + curve + GDELT news), score = mean", async () => {
    fm = mockFetch({
      "home.treasury.gov": { text: TREASURY_XML },
      "api.bls.gov": { json: BLS_OK },
      "gdeltproject.org": gdeltRoutes([0, 0, 0, 0, 10], [10, 20, 30, 40, 25]),
    });
    const m = await fetchMarketMood("us");
    expect(m.market).toBe("us");
    expect(m.components.map((c) => c.name)).toEqual([
      "Recession risk",
      "Yield curve",
      "News sentiment",
    ]);
    // Composite score is the rounded mean of its component scores.
    const mean = Math.round(m.components.reduce((a, c) => a + c.score, 0) / m.components.length);
    expect(m.score).toBe(mean);
    expect(["Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"]).toContain(m.label);
    expect(m.provenance.commercialOk).toBe(true);
  });

  test("drops the news leg to 2 components when GDELT is unavailable", async () => {
    fm = mockFetch({
      "home.treasury.gov": { text: TREASURY_XML },
      "api.bls.gov": { json: BLS_OK },
      "gdeltproject.org": { status: 500 }, // GDELT down → news leg dropped
    });
    const m = await fetchMarketMood("in");
    expect(m.market).toBe("in");
    expect(m.components.map((c) => c.name)).toEqual(["Recession risk", "Yield curve"]);
    expect(m.provenance.commercialOk).toBe(true);
  });
});

/* ── Scorecard (Prisma) ───────────────────────────────────────────────── */

describe("getScorecard (public track record)", () => {
  beforeEach(() => resetPrisma());

  const call = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    claim: "Mood lean",
    direction: "bullish",
    status: "open",
    correct: null,
    madeAt: new Date("2026-06-01T00:00:00Z"),
    resolveAt: new Date("2026-06-08T00:00:00Z"),
    resolvedAt: null,
    notes: null,
    ...over,
  });

  test("'establishing track record': hitRate is null while no call has resolved", async () => {
    prismaFake.houseViewCall.findMany.mockResolvedValue([call({ id: "a" }), call({ id: "b" })]);
    prismaFake.marketMoodReading.findMany.mockResolvedValue([]);
    const r = await getScorecard();
    expect(r.summary).toMatchObject({ total: 2, resolved: 0, correct: 0, hitRate: null, open: 2 });
    expect(r.moodHistory).toEqual([]);
    expect(r.signalKey).toBe("market_mood.us");
  });

  test("computes the hit rate from resolved calls (hits AND misses)", async () => {
    prismaFake.houseViewCall.findMany.mockResolvedValue([
      call({ id: "r1", status: "resolved", correct: true, resolvedAt: new Date("2026-06-08T00:00:00Z"), notes: "S&P up" }),
      call({ id: "r2", status: "resolved", correct: false, resolvedAt: new Date("2026-06-08T00:00:00Z") }),
      call({ id: "o1", status: "open" }),
    ]);
    prismaFake.marketMoodReading.findMany.mockResolvedValue([]);
    const r = await getScorecard();
    expect(r.summary).toMatchObject({ total: 3, resolved: 2, correct: 1, hitRate: 50, open: 1 });
    // Dates are serialised to ISO; the resolved hit carries its grading note.
    const hit = r.calls.find((c) => c.id === "r1")!;
    expect(hit.madeAt).toBe("2026-06-01T00:00:00.000Z");
    expect(hit.correct).toBe(true);
    expect(hit.notes).toBe("S&P up");
  });

  test("moodHistory is sliced to YYYY-MM-DD and reversed to oldest-first", async () => {
    prismaFake.houseViewCall.findMany.mockResolvedValue([]);
    // Prisma returns newest-first (orderBy date desc); the payload reverses to oldest-first.
    prismaFake.marketMoodReading.findMany.mockResolvedValue([
      { date: new Date("2026-06-03T00:00:00Z"), score: 60, label: "Greed" },
      { date: new Date("2026-06-02T00:00:00Z"), score: 50, label: "Neutral" },
      { date: new Date("2026-06-01T00:00:00Z"), score: 40, label: "Fear" },
    ]);
    const r = await getScorecard();
    expect(r.moodHistory).toEqual([
      { date: "2026-06-01", score: 40, label: "Fear" },
      { date: "2026-06-02", score: 50, label: "Neutral" },
      { date: "2026-06-03", score: 60, label: "Greed" },
    ]);
  });
});

/* ── Briefing prose guard ─────────────────────────────────────────────── */

describe("validateBriefing (no stray numbers in prose)", () => {
  const obj = (over: Record<string, unknown> = {}) => ({
    marketTake: { mood: "mixed", headline: "Stocks steady as traders wait", body: "Markets drifted sideways." },
    bottomLine: "A quiet, range-bound session.",
    whatMoved: [{ driver: "Tech", why: "Megacaps were little changed [1]." }],
    sentimentRead: "Sentiment was broadly neutral [2].",
    catalysts: [{ event: "Jobs data", note: "Due later this week [1]." }],
    onInvestorsMinds: [{ question: "Is the rally over?", take: "Both sides have a case [2]." }],
    followUps: ["a", "b", "c", "d", "e"],
    ...over,
  });

  test("clean qualitative prose with [n] citations → no violations", () => {
    // @ts-expect-error — minimal shape; validateBriefing only reads the prose fields.
    expect(validateBriefing(obj())).toEqual([]);
  });

  test("flags a stray percentage the model slipped into prose", () => {
    const dirty = obj({ bottomLine: "The S&P rose 2.5% on the day." });
    // @ts-expect-error — minimal shape.
    const violations = validateBriefing(dirty);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("2.5"))).toBe(true);
  });

  test("allows a 4-digit year (not flagged as a stray number)", () => {
    const withYear = obj({ sentimentRead: "Since 2024 the trend has held." });
    // @ts-expect-error — minimal shape.
    expect(validateBriefing(withYear)).toEqual([]);
  });
});
