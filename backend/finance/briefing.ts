// ─────────────────────────────────────────────────────────────────────────
// The Daily Briefing — "The Lumina Tape". A free, AI-written, fully-cited daily
// market read (the wedge from docs/market-insights-blueprint.md).
//
// Design (the "deterministic gather" variant of the blueprint's 2-phase pipeline):
//   1. GATHER — collect an EVIDENCE set from already-cached sources: indices (Yahoo),
//      the GREEN recession/mood/sentiment gauges, and fresh Tavily news. NUMBERS come
//      ONLY from these fetches (never the model).
//   2. WRITE — ONE generateObject over a fixed 7-section schema, grounded on the evidence.
//      The model writes PROSE qualitatively (no raw numbers) + cites news as [n]; the
//      actual figures (the cross-asset levels table, the gauges) are rendered from the
//      live data, so a fabricated number is structurally impossible on the numeric surface.
//   3. VALIDATE — a light check that flags any stray number the model slipped into prose.
//
// Cached upstream (routes.ts TTL) + cron-warmed so the LLM + Tavily run ~once per window.
// ─────────────────────────────────────────────────────────────────────────

import { tavily } from "@tavily/core";
import { generateObject } from "ai";
import { z } from "zod";

import { getOrRefresh } from "../lib/cache.js";
import { fetchIndices, type Market, type Provenance, type Quote } from "./sources.js";
import { fetchRecessionGauge, fetchNewsSentiment, fetchMarketMood } from "./sentiment-sources.js";
import { checkNoAdvice } from "./guards/no-advice.js";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

/* ── public payload ───────────────────────────────────────────────────── */

export type BriefingLevel = { asset: string; level: number; change: number | null; changePct: number | null };
export type BriefingSource = { n: number; title: string; url: string };
export type BriefingPayload = {
  market: Market;
  columnist: string;
  generatedAt: string;
  marketTake: { mood: string; headline: string; body: string };
  bottomLine: string;
  whatMoved: { driver: string; why: string }[];
  sentimentRead: string;
  catalysts: { event: string; note: string }[];
  onInvestorsMinds: { question: string; take: string }[];
  followUps: string[];
  // Numeric anchors — rendered from LIVE DATA, never the model:
  levels: BriefingLevel[];
  mood: { score: number; label: string } | null;
  recession: { probabilityPct: number; spread10y3m: number } | null;
  sentiment: { label: string; score: number } | null;
  sources: BriefingSource[];
  provenance: Provenance;
};

/* ── the 7-section schema the model fills (PROSE only, no raw numbers) ──── */

const BriefingSchema = z.object({
  marketTake: z.object({
    mood: z.enum(["risk-on", "risk-off", "mixed", "cautious", "euphoric"]),
    headline: z.string().describe("a punchy one-line headline for today's market"),
    body: z.string().describe("2-3 sentences setting up the day; QUALITATIVE — no specific numbers"),
  }),
  bottomLine: z.string().describe("one-sentence 'so what' takeaway, qualitative"),
  whatMoved: z
    .array(
      z.object({
        driver: z.string().describe("short label, e.g. 'Tech sell-off', 'Oil drop'"),
        why: z.string().describe("1-2 sentences grounded in the NEWS snippets; cite as [n]"),
      }),
    )
    .min(2)
    .max(5),
  sentimentRead: z.string().describe("2-3 sentences reading the mood + news sentiment, qualitatively"),
  catalysts: z
    .array(z.object({ event: z.string(), note: z.string().describe("why it matters, from the snippets") }))
    .min(1)
    .max(5),
  onInvestorsMinds: z
    .array(
      z.object({
        question: z.string().describe("a question retail is asking this week"),
        take: z.string().describe("a balanced, NO-ADVICE answer grounded in the evidence; cite [n]"),
      }),
    )
    .min(2)
    .max(4),
  followUps: z.array(z.string()).length(5).describe("5 short tappable follow-up questions"),
});

/* ── GATHER ───────────────────────────────────────────────────────────── */

function moveWord(pct: number | null): string {
  if (pct == null) return "little changed";
  const mag = Math.abs(pct) >= 1.5 ? "sharply " : "";
  return pct > 0.1 ? `${mag}higher` : pct < -0.1 ? `${mag}lower` : "little changed";
}

type Evidence = {
  market: Market;
  levels: BriefingLevel[];
  mood: { score: number; label: string } | null;
  recession: { probabilityPct: number; spread10y3m: number; curveInverted: boolean } | null;
  sentiment: { label: string; score: number } | null;
  sources: BriefingSource[];
  liveFacts: string; // the qualitative fact block fed to the model
  newsContext: string; // the dated [n] snippets fed to the model
};

async function gatherEvidence(market: Market): Promise<Evidence> {
  const indicesKey = market === "in" ? "finance:in:indices" : "finance:indices";
  // All best-effort: a missing leg degrades the briefing, never fails it.
  const [indicesR, recessionR, moodR, sentimentR] = await Promise.allSettled([
    getOrRefresh(indicesKey, 300, () => fetchIndices(market)),
    getOrRefresh("finance:recession", 21_600, fetchRecessionGauge),
    getOrRefresh(market === "in" ? "finance:in:mood" : "finance:mood", 3_600, () => fetchMarketMood(market)),
    getOrRefresh(market === "in" ? "finance:in:gdelt" : "finance:gdelt", 3_600, () => fetchNewsSentiment(market)),
  ]);

  const indices = indicesR.status === "fulfilled" ? ((indicesR.value.data as { items: Quote[] }).items ?? []) : [];
  const levels: BriefingLevel[] = indices.map((q) => ({
    asset: q.name,
    level: q.price,
    change: q.change,
    changePct: q.changePercent,
  }));
  const mood = moodR.status === "fulfilled" ? (() => {
    const d = moodR.value.data as { score: number; label: string };
    return { score: d.score, label: d.label };
  })() : null;
  const recession = recessionR.status === "fulfilled" ? (() => {
    const d = recessionR.value.data as { probabilityPct: number; spread10y3m: number; curveInverted: boolean };
    return { probabilityPct: d.probabilityPct, spread10y3m: d.spread10y3m, curveInverted: d.curveInverted };
  })() : null;
  const sentiment = sentimentR.status === "fulfilled" ? (() => {
    const d = sentimentR.value.data as { label: string; score: number };
    return { label: d.label, score: d.score };
  })() : null;

  // Tavily news (same pattern as summary.ts) — the [n] sources.
  const query =
    market === "in"
      ? "Indian stock market today: NIFTY 50, Sensex, RBI, rupee, top NSE/BSE movers — top market-moving news"
      : "US stock market today: S&P 500, Nasdaq, Dow, Treasury yields, the Fed, oil, crypto — top market-moving news";
  let results: { title: string; url: string; content?: string }[] = [];
  try {
    const search = await tvly.search(query, { searchDepth: "basic", topic: "news", days: 2, maxResults: 8 });
    results = search.results ?? [];
  } catch (e) {
    console.warn("[briefing] Tavily failed:", e instanceof Error ? e.message : e);
  }
  const sources: BriefingSource[] = results.map((r, i) => ({ n: i + 1, title: r.title, url: r.url }));
  const newsContext = results.map((r, i) => `[${i + 1}] ${r.title}\n${(r.content ?? "").slice(0, 320)}`).join("\n\n");

  // The QUALITATIVE fact block — directions, not raw numbers the model could mis-copy.
  const factLines: string[] = [];
  if (levels.length) {
    factLines.push(
      "Indices today: " + levels.map((l) => `${l.asset} ${moveWord(l.changePct)}`).join(", ") + ".",
    );
  }
  if (mood) factLines.push(`Lumina Market Mood: ${mood.label} (${mood.score}/100).`);
  if (recession) {
    factLines.push(
      `Recession signal: ~${recession.probabilityPct}% 12-month probability; the 10y-3m curve is ${recession.curveInverted ? "INVERTED (a recession warning)" : "positively sloped (no inversion)"}.`,
    );
  }
  if (sentiment) factLines.push(`News-flow sentiment (GDELT): ${sentiment.label}.`);

  return {
    market,
    levels,
    mood,
    recession,
    sentiment,
    sources,
    liveFacts: factLines.join("\n"),
    newsContext,
  };
}

/* ── VALIDATE (light) — flag stray numbers the model slipped into prose ── */

const NUMBER_RE = /(?<!\[)\b\d[\d,]*\.?\d*\s?%?/g;
function proseStrings(o: z.infer<typeof BriefingSchema>): string[] {
  return [
    o.marketTake.headline,
    o.marketTake.body,
    o.bottomLine,
    o.sentimentRead,
    ...o.whatMoved.flatMap((w) => [w.driver, w.why]),
    ...o.catalysts.flatMap((c) => [c.event, c.note]),
    ...o.onInvestorsMinds.flatMap((q) => [q.question, q.take]),
  ];
}
export function validateBriefing(o: z.infer<typeof BriefingSchema>): string[] {
  const violations: string[] = [];
  for (const s of proseStrings(o)) {
    const m = s.match(NUMBER_RE) ?? [];
    for (const tok of m) {
      const t = tok.trim();
      // Allow years and bare citation-like single digits handled by the lookbehind.
      if (/^(19|20)\d{2}$/.test(t)) continue;
      if (t.length <= 1) continue;
      violations.push(t);
    }
  }
  if (violations.length) {
    console.warn(`[briefing] prose contains ${violations.length} stray number(s) (model should describe qualitatively):`, violations.slice(0, 8));
  }
  return violations;
}

/* ── WRITE + assemble ─────────────────────────────────────────────────── */

const PROVENANCE: Provenance = {
  source: "Lumina (AI over public-domain data + cited news)",
  commercialOk: false, // prose synthesis over Tavily snippets + Yahoo index levels (commercialOk:false legs)
  attribution: "The Lumina Tape — AI briefing grounded in U.S. Treasury/BLS/GDELT data and cited news sources.",
};

export async function generateBriefing(market: Market = "us"): Promise<BriefingPayload> {
  const ev = await gatherEvidence(market);
  const today = new Date().toISOString().slice(0, 10);
  const region = market === "in" ? "Indian" : "U.S.";

  const { object } = await generateObject({
    model: "anthropic/claude-sonnet-4.6",
    schema: BriefingSchema,
    prompt:
      `You are "The Lumina Tape", a sharp, neutral markets columnist writing a FREE daily briefing for ${region} retail investors. ` +
      `Write today's (${today}) briefing using ONLY the EVIDENCE below.\n\n` +
      `HARD RULES:\n` +
      `- NEVER write specific price levels, index values, or percentages in your prose — those are shown separately from live data. Describe moves QUALITATIVELY (rose, slipped, sold off, steady, sharply).\n` +
      `- Ground every factual claim in the dated NEWS snippets and cite them inline as [n] (matching the numbers below). Use square brackets ONLY for numeric news citations like [3] — NEVER write a bracketed placeholder such as "[recession signal evidence]". Refer to the live gauges (mood, recession probability, sentiment) in plain words, uncited.\n` +
      `- Be specific about WHAT happened and WHY; neutral, no hype.\n` +
      `- NEVER give buy/sell/hold advice or personalized recommendations. Where a view is directional, present both the bull and the bear side.\n` +
      `- "On investors' minds" = the questions retail is actually asking this week, answered factually.\n\n` +
      `EVIDENCE — live market read (${today}):\n${ev.liveFacts || "(market data temporarily unavailable)"}\n\n` +
      `EVIDENCE — dated news snippets:\n${ev.newsContext || "(no fresh news available)"}`,
  });

  validateBriefing(object);
  // Defense-in-depth: the prompt already forbids advice, but run the deterministic no-advice
  // guard over the assembled prose so a directive slipping through is caught (and logged).
  const advice = checkNoAdvice(proseStrings(object).join("  "));
  if (advice.severity !== "ok") console.warn(`[briefing] no-advice guard ${advice.severity}:`, advice.findings);

  return {
    market,
    columnist: "The Lumina Tape",
    generatedAt: new Date().toISOString(),
    marketTake: object.marketTake,
    bottomLine: object.bottomLine,
    whatMoved: object.whatMoved,
    sentimentRead: object.sentimentRead,
    catalysts: object.catalysts,
    onInvestorsMinds: object.onInvestorsMinds,
    followUps: object.followUps,
    levels: ev.levels,
    mood: ev.mood,
    recession: ev.recession ? { probabilityPct: ev.recession.probabilityPct, spread10y3m: ev.recession.spread10y3m } : null,
    sentiment: ev.sentiment,
    sources: ev.sources,
    provenance: PROVENANCE,
  };
}
