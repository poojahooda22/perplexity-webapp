// ─────────────────────────────────────────────────────────────────────────
// Market Insights — GREEN (public-domain) data sources for the Pulse surfaces.
//
// Everything here is `commercialOk: true` by LAW (the license attaches to the FETCH
// PATH, not the concept — see docs/market-insights-blueprint.md):
//   • US Treasury daily par-yield curve  — public domain (17 USC §105)
//   • BLS U-3 unemployment (LNS14000000)  — public domain → the Sahm Rule
//   • GDELT DOC 2.0 news tone/volume      — "unlimited and unrestricted... commercial
//                                            use" WITH a mandatory verbatim citation+link
//   • Estrella–Mishkin (1998) recession probit — a published, non-copyrightable method
//
// All three fetchers return frontend-ready payloads + Provenance and THROW on failure so
// the cache (getOrRefresh) can serve stale / the route can 502 honestly — never a fake number.
// GDELT throttles aggressively (≥1 request / 5 s per IP); callers MUST go through the cache
// (server-side + in-flight de-dupe protects the shared upstream).
// ─────────────────────────────────────────────────────────────────────────

import { getOrRefresh } from "../lib/cache.js";
import type { Market, Provenance } from "./sources.js";

const UA = "Lumina/1.0 (market-insights; contact: admin@lumina.app)";

// Sub-keys shared with the dedicated routes so Market Mood reuses their cache + in-flight
// de-dupe instead of double-hitting the upstreams. (TTLs duplicated here to avoid a
// routes.ts ↔ sentiment-sources.ts circular import.)
const REC_TTL = 21_600; // 6h — yield curve + monthly jobs data move slowly
const GDELT_TTL = 3_600; // 1h — be polite to GDELT's throttle

/* ── math: standard-normal CDF (for the recession probit) ─────────────── */

// Abramowitz–Stegun 7.1.26 erf approximation; Φ(x) = ½(1 + erf(x/√2)).
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/* ── Recession panel: Treasury yield curve + Sahm Rule + probit ───────── */

export type RecessionPayload = {
  probability: number; // 0..1 Estrella–Mishkin probit P(recession within 12m)
  probabilityPct: number; // rounded percent for display
  spread10y3m: number; // percentage points (10y minus 3-month)
  spread10y2y: number;
  yields: { m3: number; y2: number; y10: number };
  curveInverted: boolean; // spread10y3m < 0
  sahm: {
    value: number; // 3-mo MA(U-3) minus trailing-12-mo low
    triggered: boolean; // ≥ 0.50pp = recession-onset signal
    latestUnemployment: number;
    asOf: string; // e.g. "May 2026"
  } | null;
  asOf: string; // Treasury curve date (ISO)
  methodology: string;
  caveat: string;
  provenance: Provenance;
};

// Parse the Treasury OData/Atom XML → the latest dated row's key legs. Entries are
// oldest-first; we scan every <entry> and keep the one with the max NEW_DATE.
function parseTreasuryLatest(xml: string): { date: string; m3: number; y2: number; y10: number } | null {
  const entries = xml.split("<entry>").slice(1);
  let best: { date: string; m3: number; y2: number; y10: number } | null = null;
  const grab = (block: string, field: string): number | null => {
    const m = block.match(new RegExp(`<d:${field}[^>]*>([^<]+)</d:${field}>`));
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  for (const block of entries) {
    const dm = block.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/);
    if (!dm) continue;
    const date = dm[1]!;
    const m3 = grab(block, "BC_3MONTH");
    const y2 = grab(block, "BC_2YEAR");
    const y10 = grab(block, "BC_10YEAR");
    if (m3 == null || y2 == null || y10 == null) continue;
    if (!best || date > best.date) best = { date, m3, y2, y10 };
  }
  return best;
}

async function fetchTreasuryCurve(): Promise<{ date: string; m3: number; y2: number; y10: number }> {
  const year = new Date().getUTCFullYear();
  const url =
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml" +
    `?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
  if (!res.ok) throw new Error(`Treasury ${res.status}`);
  const xml = await res.text();
  let latest = parseTreasuryLatest(xml);
  // Early-January edge: the new year's feed may be empty — fall back to last year.
  if (!latest) {
    const prev = await fetch(url.replace(String(year), String(year - 1)), {
      headers: { "User-Agent": UA, Accept: "application/xml" },
    });
    if (prev.ok) latest = parseTreasuryLatest(await prev.text());
  }
  if (!latest) throw new Error("Treasury: no parseable yield-curve rows");
  return latest;
}

// BLS U-3 unemployment → the Sahm Rule. v1 is keyless (25 req/day, fine behind our cache);
// set BLS_API_KEY for v2 (500/day). Values of "-" (e.g. the 2025 shutdown gap) are dropped.
async function fetchSahm(): Promise<RecessionPayload["sahm"]> {
  const key = process.env.BLS_API_KEY;
  const now = new Date().getUTCFullYear();
  const body: Record<string, unknown> = {
    seriesid: ["LNS14000000"],
    startyear: String(now - 2),
    endyear: String(now),
  };
  if (key) body.registrationkey = key;
  const res = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BLS ${res.status}`);
  const json = (await res.json()) as any;
  const raw: Array<{ year: string; period: string; periodName: string; value: string }> =
    json?.Results?.series?.[0]?.data ?? [];
  // Newest-first; keep monthly obs with a real value.
  const pts = raw
    .filter((d) => d.period?.startsWith("M") && d.period !== "M13" && d.value !== "-")
    .map((d) => ({ label: `${d.periodName} ${d.year}`, value: Number(d.value) }))
    .filter((d) => Number.isFinite(d.value));
  if (pts.length < 15) return null; // not enough history for a trailing-12-mo Sahm
  const sma3 = (i: number) => (pts[i]!.value + pts[i + 1]!.value + pts[i + 2]!.value) / 3;
  const current = sma3(0);
  let low12 = Infinity;
  for (let i = 0; i <= 11; i++) low12 = Math.min(low12, sma3(i));
  const value = +(current - low12).toFixed(2);
  return { value, triggered: value >= 0.5, latestUnemployment: pts[0]!.value, asOf: pts[0]!.label };
}

export async function fetchRecessionGauge(): Promise<RecessionPayload> {
  // Curve is required; Sahm is best-effort (degrade rather than fail the whole panel).
  const curve = await fetchTreasuryCurve();
  const sahm = await fetchSahm().catch(() => null);

  const spread10y3m = +(curve.y10 - curve.m3).toFixed(2);
  const spread10y2y = +(curve.y10 - curve.y2).toFixed(2);
  // Estrella–Mishkin (1998) probit on the 10y–3m spread (percentage points).
  const probability = +normCdf(-0.5333 - 0.6629 * spread10y3m).toFixed(4);

  return {
    probability,
    probabilityPct: Math.round(probability * 100),
    spread10y3m,
    spread10y2y,
    yields: { m3: curve.m3, y2: curve.y2, y10: curve.y10 },
    curveInverted: spread10y3m < 0,
    sahm,
    asOf: curve.date,
    methodology:
      "Estrella–Mishkin (1998) probit on the 10-year minus 3-month Treasury spread, the methodology applied by the Federal Reserve Bank of New York. Sahm Rule from BLS U-3 unemployment.",
    caveat:
      "Statistical indicator with historical false signals (the 2022–24 inversion did not precede a recession) and variable 6–24 month lead times. Informational only, not a forecast and not financial advice.",
    provenance: {
      source: "U.S. Treasury + BLS (Lumina-computed probit)",
      commercialOk: true,
      attribution: "Source: U.S. Department of the Treasury & U.S. Bureau of Labor Statistics; recession probability computed by Lumina (Estrella–Mishkin).",
    },
  };
}

/* ── News sentiment: GDELT DOC 2.0 "Bull/Bear Buzz" ───────────────────── */

export type SentimentPayload = {
  market: Market;
  score: number; // -100 (bearish) .. +100 (bullish), z-scored tone
  label: "Bearish" | "Leaning Bearish" | "Neutral" | "Leaning Bullish" | "Bullish";
  toneLatest: number; // raw GDELT average tone (~ -10..+10)
  toneSeries: { t: number; v: number }[];
  buzz: number; // 0..100 — coverage-volume percentile (shown SEPARATELY from tone)
  buzzSeries: { t: number; v: number }[];
  caveat: string;
  provenance: Provenance;
};

const GDELT_QUERY: Record<Market, string> = {
  us: "(stock market OR economy OR inflation OR federal reserve) sourcecountry:US",
  in: "(stock market OR economy OR sensex OR nifty OR reserve bank of india) sourcecountry:IN",
};

// GDELT timestamps are "YYYYMMDDThhmmssZ" — reshape to an ISO string Date can parse.
function gdeltDate(s: string): number {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return Date.parse(s) || 0;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

async function gdeltTimeline(query: string, mode: "timelinetone" | "timelinevol"): Promise<{ t: number; v: number }[]> {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(query) +
    `&mode=${mode}&format=json&timespan=3m&timelinesmooth=5`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const text = await res.text();
  // GDELT returns a plaintext throttle notice (HTTP 200) instead of JSON when rate-limited.
  if (!res.ok || text.trimStart().startsWith("Please limit")) throw new Error("GDELT throttled/unavailable");
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("GDELT: non-JSON response");
  }
  const data: any[] = json?.timeline?.[0]?.data ?? [];
  return data
    .map((d) => ({ t: gdeltDate(String(d.date)), v: Number(d.value) }))
    .filter((p) => p.t > 0 && Number.isFinite(p.v));
}

function zscoreLatest(series: { t: number; v: number }[]): number {
  if (series.length < 5) return 0;
  const vals = series.map((p) => p.v);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const sd = Math.sqrt(variance) || 1;
  return (vals[vals.length - 1]! - mean) / sd;
}

function sentimentLabel(score: number): SentimentPayload["label"] {
  if (score <= -50) return "Bearish";
  if (score <= -15) return "Leaning Bearish";
  if (score < 15) return "Neutral";
  if (score < 50) return "Leaning Bullish";
  return "Bullish";
}

export async function fetchNewsSentiment(market: Market = "us"): Promise<SentimentPayload> {
  const query = GDELT_QUERY[market];
  // Sequential (NOT parallel) — GDELT throttles concurrent hits from one IP.
  const toneSeries = await gdeltTimeline(query, "timelinetone");
  const buzzSeries = await gdeltTimeline(query, "timelinevol").catch(() => [] as { t: number; v: number }[]);

  const z = zscoreLatest(toneSeries);
  const score = Math.max(-100, Math.min(100, Math.round(z * 40)));
  const toneLatest = toneSeries.length ? +toneSeries[toneSeries.length - 1]!.v.toFixed(2) : 0;
  // Buzz = where the latest coverage volume sits in its own 90-day distribution (percentile).
  let buzz = 50;
  if (buzzSeries.length >= 5) {
    const latest = buzzSeries[buzzSeries.length - 1]!.v;
    const below = buzzSeries.filter((p) => p.v <= latest).length;
    buzz = Math.round((below / buzzSeries.length) * 100);
  }

  return {
    market,
    score,
    label: sentimentLabel(score),
    toneLatest,
    toneSeries,
    buzz,
    buzzSeries,
    caveat:
      "Measures media sentiment, not price. News tone can move with the VOLUME of coverage as much as its direction — read the buzz gauge alongside. Informational only.",
    provenance: {
      source: "The GDELT Project",
      commercialOk: true,
      attribution: "Source: The GDELT Project (gdeltproject.org)",
    },
  };
}

/* ── Market Mood: a GREEN-only macro-sentiment composite (0..100) ─────── */
//
// NOTE: the richer 7-signal CNN-Fear&Greed-rhyme (momentum/breadth/put-call/VIX) leans on
// equity prices that today come from Yahoo (commercialOk:false) → that dial is a Phase-2,
// paid-spine build. THIS launch dial is composed ONLY of GREEN inputs (Treasury + GDELT),
// so the whole composite is `commercialOk:true`. It is clearly a MACRO-sentiment read.

export type MoodComponent = { name: string; score: number; note: string };
export type MoodPayload = {
  market: Market;
  score: number; // 0..100
  label: "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed";
  components: MoodComponent[];
  asOf: string;
  caveat: string;
  provenance: Provenance;
};

function moodLabel(score: number): MoodPayload["label"] {
  if (score < 25) return "Extreme Fear";
  if (score < 45) return "Fear";
  if (score <= 55) return "Neutral";
  if (score < 75) return "Greed";
  return "Extreme Greed";
}

export async function fetchMarketMood(market: Market = "us"): Promise<MoodPayload> {
  // Reuse the dedicated sub-caches (shared key + in-flight de-dupe ⇒ no extra upstream hits).
  const recession = await getOrRefresh("finance:recession", REC_TTL, fetchRecessionGauge);
  const gdeltKey = market === "in" ? "finance:in:gdelt" : "finance:gdelt";
  // Mood must never block on a COLD GDELT fetch (GDELT throttles ⇒ ~20-30s). Race the cached
  // read against a short timeout: if GDELT isn't already warm, drop the news leg (the background
  // fetch still populates the cache + the /finance/gdelt route serves it). Mood always returns fast.
  const sentiment = await Promise.race([
    getOrRefresh(gdeltKey, GDELT_TTL, () => fetchNewsSentiment(market)).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500)),
  ]);

  const rec = recession.data;
  const components: MoodComponent[] = [];

  // 1. Recession risk → greed when low (invert the probit probability).
  const recScore = Math.round((1 - rec.probability) * 100);
  components.push({
    name: "Recession risk",
    score: recScore,
    note: `${rec.probabilityPct}% 12-month recession probability (lower = greedier)`,
  });

  // 2. Yield-curve shape → steeper = risk-on/greed; inverted = fear. Map [-1pp..+2pp]→[0..100].
  const curveScore = Math.max(0, Math.min(100, Math.round(((rec.spread10y3m + 1) / 3) * 100)));
  components.push({
    name: "Yield curve",
    score: curveScore,
    note: `10y–3m spread ${rec.spread10y3m > 0 ? "+" : ""}${rec.spread10y3m}pp`,
  });

  // 3. News tone (GDELT) → greed when bullish. Map [-100..+100]→[0..100]. Optional (GDELT may throttle).
  if (sentiment?.data) {
    const newsScore = Math.round((sentiment.data.score + 100) / 2);
    components.push({ name: "News sentiment", score: newsScore, note: `${sentiment.data.label} (GDELT tone)` });
  }

  const score = Math.round(components.reduce((a, c) => a + c.score, 0) / components.length);

  return {
    market,
    score,
    label: moodLabel(score),
    components,
    asOf: rec.asOf,
    caveat:
      "Lumina Market Mood is a MACRO-sentiment composite of public-domain inputs (Treasury yield curve, recession probit" +
      (sentiment?.data ? ", GDELT news tone" : "") +
      "). It is not the CNN Fear & Greed Index and does not yet include equity-market breadth/volatility. Informational only.",
    provenance: {
      source: "Lumina (composite: U.S. Treasury, BLS, GDELT)",
      commercialOk: true,
      attribution: "Lumina Market Mood — composite of U.S. Treasury, BLS and GDELT (gdeltproject.org) public data.",
    },
  };
}
