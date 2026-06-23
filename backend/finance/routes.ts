// ─────────────────────────────────────────────────────────────────────────
// Finance tab routes. Public READS (rate-limited, served from cache) + a cron WARMER.
// Mounted at /finance in index.ts → full paths /finance/crypto, /finance/indices, etc.
// ─────────────────────────────────────────────────────────────────────────

import { Router, type RequestHandler } from "express";
import { getOrRefresh, forceRefresh, warmIfStale, type RefreshOpts } from "../lib/cache.js";
import { financeRateLimit } from "../lib/ratelimit.js";
import {
  fetchCrypto,
  fetchCryptoLeaderboard,
  fetchLuminaCrypto50,
  fetchPredictions,
  fetchIndices,
  fetchStocks,
  fetchSectors,
  type Market,
  type CryptoIndexRange,
} from "./sources.js";
import { fetchMarketSummary } from "./summary.js";
import { fetchAllResearch } from "./research.js";
import { fetchDiscover } from "./news.js";
import { fetchRecessionGauge, fetchNewsSentiment, fetchMarketMood } from "./sentiment-sources.js";
import { generateBriefing } from "./briefing.js";
import { emitDailyCalls, resolveDueCalls, getScorecard } from "./scorecard.js";

export const financeRouter = Router();

// Cache TTLs (seconds). Crypto/predictions move fast; stocks/indices we refresh gently to
// stay well under Twelve Data's free 800-calls/day + 8/min limits.
const TTL = { crypto: 30, predictions: 120, indices: 300, stocks: 300, sectors: 300, summary: 900, research: 21_600, discover: 600, cryptoLeaderboard: 60, crypto50: 900, recession: 21_600, gdelt: 3_600, mood: 3_600, briefing: 1_800 };
// Only keys read by readRoute (crypto/predictions/research) or /home (indices/stocks). The
// market-aware routes (sectors/summary/discover) build their keys inline in marketReadRoute.
const CACHE_KEYS = {
  crypto: "finance:crypto",
  cryptoLeaderboard: "finance:crypto:leaderboard",
  predictions: "finance:predictions",
  indices: "finance:indices",
  stocks: "finance:stocks",
  research: "finance:research",
};

// A cached read handler: serve fresh-or-stale from cache, 502 only if there's nothing.
// `opts.llm` marks a cost-bearing LLM surface (honors the FINANCE_LLM_FROZEN dev switch).
function readRoute(key: string, ttl: number, fetcher: () => Promise<unknown>, opts?: RefreshOpts): RequestHandler {
  return async (_req, res) => {
    try {
      const r = await getOrRefresh(key, ttl, fetcher, opts);
      res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
    } catch (e) {
      console.error(`[finance] ${key} failed:`, e instanceof Error ? e.message : e);
      res.status(502).json({ error: `${key} upstream failed` });
    }
  };
}

// Market-aware cached read: ?market=in serves the India series from a SEPARATE cache key
// (finance:in:<name>); default/US keeps the existing finance:<name> key untouched.
function marketReadRoute(
  name: string,
  ttl: number,
  fetcher: (m: Market) => Promise<unknown>,
  opts?: RefreshOpts,
): RequestHandler {
  return async (req, res) => {
    const market: Market = req.query.market === "in" ? "in" : "us";
    const key = market === "in" ? `finance:in:${name}` : `finance:${name}`;
    try {
      const r = await getOrRefresh(key, ttl, () => fetcher(market), opts);
      res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
    } catch (e) {
      console.error(`[finance] ${key} failed:`, e instanceof Error ? e.message : e);
      res.status(502).json({ error: `${key} upstream failed` });
    }
  };
}

financeRouter.get("/crypto", financeRateLimit, readRoute(CACHE_KEYS.crypto, TTL.crypto, fetchCrypto));
// All-Exchanges crypto leaderboard: top coins by 24h volume (100M+ mcap), CoinGecko aggregate.
financeRouter.get("/crypto/leaderboard", financeRateLimit, readRoute(CACHE_KEYS.cryptoLeaderboard, TTL.cryptoLeaderboard, fetchCryptoLeaderboard));
// Lumina Crypto 50 — our OWN cap-weighted index (NOT the licensed Coinbase 50). Range-keyed cache.
financeRouter.get("/crypto/index", financeRateLimit, async (req, res) => {
  const allowed: CryptoIndexRange[] = ["1d", "5d", "1m", "3m", "6m", "1y"];
  const range = allowed.includes(req.query.range as CryptoIndexRange) ? (req.query.range as CryptoIndexRange) : "6m";
  try {
    const r = await getOrRefresh(`finance:crypto50:${range}`, TTL.crypto50, () => fetchLuminaCrypto50(range));
    res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
  } catch (e) {
    console.error(`[finance] crypto50:${range} failed:`, e instanceof Error ? e.message : e);
    res.status(502).json({ error: "crypto index upstream failed" });
  }
});
financeRouter.get("/predictions", financeRateLimit, readRoute(CACHE_KEYS.predictions, TTL.predictions, fetchPredictions));
// Indices + stocks are market-aware (US default, ?market=in for India).
financeRouter.get("/indices", financeRateLimit, marketReadRoute("indices", TTL.indices, fetchIndices));
financeRouter.get("/stocks", financeRateLimit, marketReadRoute("stocks", TTL.stocks, fetchStocks));
// Equity sectors — US: 11 SPDR Select Sector ETFs; India (?market=in): NSE sectoral indices.
financeRouter.get("/sectors", financeRateLimit, marketReadRoute("sectors", TTL.sectors, fetchSectors));
// Market Summary is LLM-backed → long TTL so it generates only ~once per window. llm:true so the
// FINANCE_LLM_FROZEN dev switch serves it from cache without re-generating (no Gateway credits).
financeRouter.get("/summary", financeRateLimit, marketReadRoute("summary", TTL.summary, fetchMarketSummary, { llm: true }));
// Global Research is LLM-backed + multi-category → 6h TTL (analytical content changes slowly).
financeRouter.get("/research", financeRateLimit, readRoute(CACHE_KEYS.research, TTL.research, fetchAllResearch, { llm: true }));
// Discover news carousel — US: Finnhub /news; India (?market=in): Tavily India-publisher search.
financeRouter.get("/discover", financeRateLimit, marketReadRoute("discover", TTL.discover, fetchDiscover));

// ── Market Insights ("Pulse") — GREEN public-domain surfaces (commercialOk:true). ──
// Recession panel = US Treasury curve + BLS Sahm + Estrella–Mishkin probit (US-only macro).
financeRouter.get("/recession", financeRateLimit, readRoute("finance:recession", TTL.recession, fetchRecessionGauge));
// News sentiment ("Bull/Bear Buzz") — GDELT tone/volume; market-aware (US default, ?market=in).
financeRouter.get("/gdelt", financeRateLimit, marketReadRoute("gdelt", TTL.gdelt, fetchNewsSentiment));
// Lumina Market Mood — GREEN-only macro-sentiment composite; market-aware.
financeRouter.get("/mood", financeRateLimit, marketReadRoute("mood", TTL.mood, fetchMarketMood));
// The Daily Briefing ("The Lumina Tape") — LLM-backed, grounded on the GREEN gauges + cited news.
financeRouter.get("/briefing", financeRateLimit, marketReadRoute("briefing", TTL.briefing, generateBriefing, { llm: true }));
// The public track-record scorecard (cheap, indexed DB read → always fresh, no cache so an
// emit/resolve is reflected immediately).
financeRouter.get("/scorecard", financeRateLimit, async (_req, res) => {
  try {
    res.json({ ...(await getScorecard()), fetchedAt: Date.now(), stale: false });
  } catch (e) {
    console.error("[finance] scorecard failed:", e instanceof Error ? e.message : e);
    res.status(502).json({ error: "scorecard failed" });
  }
});

// Aggregate landing payload — one request powers the whole Finance home.
financeRouter.get("/home", financeRateLimit, async (_req, res) => {
  const [indices, stocks, crypto, predictions] = await Promise.allSettled([
    getOrRefresh(CACHE_KEYS.indices, TTL.indices, fetchIndices),
    getOrRefresh(CACHE_KEYS.stocks, TTL.stocks, fetchStocks),
    getOrRefresh(CACHE_KEYS.crypto, TTL.crypto, fetchCrypto),
    getOrRefresh(CACHE_KEYS.predictions, TTL.predictions, fetchPredictions),
  ]);
  const val = (r: PromiseSettledResult<{ data: unknown; stale: boolean }>) =>
    r.status === "fulfilled" ? { ...(r.value.data as object), stale: r.value.stale } : null;
  res.json({
    indices: val(indices),
    stocks: val(stocks),
    crypto: val(crypto),
    predictions: val(predictions),
  });
});

// Every cache entry the warmer keeps hot. Tuple = [cacheKey, ttlSeconds, fetcher, isLLM?]. The warmer
// uses warmIfStale: it refreshes a key ONLY if it's missing or stale, so a restart never needlessly
// regenerates a still-fresh surface — this is what stops repeated dev restarts from re-burning Vercel
// AI Gateway credits on the LLM surfaces (summary/research/briefing, flagged isLLM=true, which are
// also skipped entirely under FINANCE_LLM_FROZEN). Keys mirror the routes (finance:<name> US,
// finance:in:<name> India). The cron route's ?force=1 bypasses both checks for a manual full refresh.
const WARM_JOBS: [string, number, () => Promise<unknown>, boolean?][] = [
  ["finance:indices", TTL.indices, () => fetchIndices("us")],
  ["finance:stocks", TTL.stocks, () => fetchStocks("us")],
  ["finance:sectors", TTL.sectors, () => fetchSectors("us")],
  ["finance:crypto", TTL.crypto, fetchCrypto],
  ["finance:crypto:leaderboard", TTL.cryptoLeaderboard, fetchCryptoLeaderboard],
  ["finance:crypto50:6m", TTL.crypto50, () => fetchLuminaCrypto50("6m")],
  ["finance:crypto50:1d", TTL.crypto50, () => fetchLuminaCrypto50("1d")],
  ["finance:crypto50:5d", TTL.crypto50, () => fetchLuminaCrypto50("5d")],
  ["finance:predictions", TTL.predictions, fetchPredictions],
  ["finance:summary", TTL.summary, () => fetchMarketSummary("us"), true],
  ["finance:research", TTL.research, fetchAllResearch, true],
  ["finance:discover", TTL.discover, () => fetchDiscover("us")],
  // Market Insights (US). Mood reuses the recession+gdelt caches via in-flight de-dupe, so
  // warming all three hits each upstream ~once even though they run concurrently here.
  ["finance:recession", TTL.recession, fetchRecessionGauge],
  ["finance:gdelt", TTL.gdelt, () => fetchNewsSentiment("us")],
  ["finance:mood", TTL.mood, () => fetchMarketMood("us")],
  ["finance:briefing", TTL.briefing, () => generateBriefing("us"), true],
  ["finance:in:indices", TTL.indices, () => fetchIndices("in")],
  ["finance:in:stocks", TTL.stocks, () => fetchStocks("in")],
  ["finance:in:sectors", TTL.sectors, () => fetchSectors("in")],
  ["finance:in:summary", TTL.summary, () => fetchMarketSummary("in"), true],
  ["finance:in:discover", TTL.discover, () => fetchDiscover("in")],
];

// Warm every finance cache entry. Called on server startup (index.ts) and by the cron route. By
// default (force=false) it uses warmIfStale → only missing/stale keys are fetched, and the FROZEN
// LLM surfaces are left untouched, so the FIRST user after a restart is served from cache without
// re-paying the cold upstream/LLM cost. force=true (cron ?force=1) regenerates everything regardless.
export async function warmFinanceCache(force = false): Promise<{ key: string; ok: boolean }[]> {
  const results = await Promise.allSettled(
    WARM_JOBS.map(([key, ttl, fn, llm]) =>
      force ? forceRefresh(key, ttl, fn) : warmIfStale(key, ttl, fn, { llm: Boolean(llm) }),
    ),
  );
  return WARM_JOBS.map(([key], i) => ({ key, ok: results[i]!.status === "fulfilled" }));
}

// Cron warmer endpoint. Wire a free scheduler (cron-job.org) to POST here with the CRON_SECRET
// (guard skipped if unset) on an interval ≤ the shortest TTL so the cache stays hot in prod.
financeRouter.post("/cron/refresh", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : undefined;
    const provided = bearer || (req.headers["x-cron-secret"] as string | undefined);
    if (provided !== secret) return res.status(401).json({ error: "unauthorised" });
  }
  // ?force=1 regenerates every surface even if fresh or FROZEN — the manual "refresh now" button.
  const force = req.query.force === "1" || req.query.force === "true";
  res.json({ refreshed: await warmFinanceCache(force) });
});

// Scorecard crons — emit a daily falsifiable call from the mood, and resolve calls past their horizon.
// Same CRON_SECRET guard as the warmer (skipped if unset = open in local dev).
function cronOk(req: Parameters<RequestHandler>[0]): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers["authorization"];
  const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : undefined;
  const provided = bearer || (req.headers["x-cron-secret"] as string | undefined);
  return provided === secret;
}
financeRouter.post("/cron/emit-calls", async (req, res) => {
  if (!cronOk(req)) return res.status(401).json({ error: "unauthorised" });
  try {
    res.json(await emitDailyCalls());
  } catch (e) {
    console.error("[finance] emit-calls failed:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "emit failed" });
  }
});
financeRouter.post("/cron/resolve-calls", async (req, res) => {
  if (!cronOk(req)) return res.status(401).json({ error: "unauthorised" });
  try {
    res.json(await resolveDueCalls());
  } catch (e) {
    console.error("[finance] resolve-calls failed:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "resolve failed" });
  }
});
