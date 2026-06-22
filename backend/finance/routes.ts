// ─────────────────────────────────────────────────────────────────────────
// Finance tab routes. Public READS (rate-limited, served from cache) + a cron WARMER.
// Mounted at /finance in index.ts → full paths /finance/crypto, /finance/indices, etc.
// ─────────────────────────────────────────────────────────────────────────

import { Router, type RequestHandler } from "express";
import { getOrRefresh, forceRefresh } from "../lib/cache.js";
import { financeRateLimit } from "../lib/ratelimit.js";
import { fetchCrypto, fetchPredictions, fetchIndices, fetchStocks, fetchSectors, type Market } from "./sources.js";
import { fetchMarketSummary } from "./summary.js";
import { fetchAllResearch } from "./research.js";
import { fetchDiscover } from "./news.js";

export const financeRouter = Router();

// Cache TTLs (seconds). Crypto/predictions move fast; stocks/indices we refresh gently to
// stay well under Twelve Data's free 800-calls/day + 8/min limits.
const TTL = { crypto: 30, predictions: 120, indices: 300, stocks: 300, sectors: 300, summary: 900, research: 21_600, discover: 600 };
// Only keys read by readRoute (crypto/predictions/research) or /home (indices/stocks). The
// market-aware routes (sectors/summary/discover) build their keys inline in marketReadRoute.
const CACHE_KEYS = {
  crypto: "finance:crypto",
  predictions: "finance:predictions",
  indices: "finance:indices",
  stocks: "finance:stocks",
  research: "finance:research",
};

// A cached read handler: serve fresh-or-stale from cache, 502 only if there's nothing.
function readRoute(key: string, ttl: number, fetcher: () => Promise<unknown>): RequestHandler {
  return async (_req, res) => {
    try {
      const r = await getOrRefresh(key, ttl, fetcher);
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
): RequestHandler {
  return async (req, res) => {
    const market: Market = req.query.market === "in" ? "in" : "us";
    const key = market === "in" ? `finance:in:${name}` : `finance:${name}`;
    try {
      const r = await getOrRefresh(key, ttl, () => fetcher(market));
      res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
    } catch (e) {
      console.error(`[finance] ${key} failed:`, e instanceof Error ? e.message : e);
      res.status(502).json({ error: `${key} upstream failed` });
    }
  };
}

financeRouter.get("/crypto", financeRateLimit, readRoute(CACHE_KEYS.crypto, TTL.crypto, fetchCrypto));
financeRouter.get("/predictions", financeRateLimit, readRoute(CACHE_KEYS.predictions, TTL.predictions, fetchPredictions));
// Indices + stocks are market-aware (US default, ?market=in for India).
financeRouter.get("/indices", financeRateLimit, marketReadRoute("indices", TTL.indices, fetchIndices));
financeRouter.get("/stocks", financeRateLimit, marketReadRoute("stocks", TTL.stocks, fetchStocks));
// Equity sectors — US: 11 SPDR Select Sector ETFs; India (?market=in): NSE sectoral indices.
financeRouter.get("/sectors", financeRateLimit, marketReadRoute("sectors", TTL.sectors, fetchSectors));
// Market Summary is LLM-backed → long TTL so it generates only ~once per window.
financeRouter.get("/summary", financeRateLimit, marketReadRoute("summary", TTL.summary, fetchMarketSummary));
// Global Research is LLM-backed + multi-category → 6h TTL (analytical content changes slowly).
financeRouter.get("/research", financeRateLimit, readRoute(CACHE_KEYS.research, TTL.research, fetchAllResearch));
// Discover news carousel — US: Finnhub /news; India (?market=in): Tavily India-publisher search.
financeRouter.get("/discover", financeRateLimit, marketReadRoute("discover", TTL.discover, fetchDiscover));

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

// Every cache entry the warmer keeps hot. Tuple = [cacheKey, ttlSeconds, fetcher]. We use
// forceRefresh (not getOrRefresh) so the warmer actually FETCHES + populates the cache; reads then
// serve it instantly (fresh, or stale-while-revalidate once the TTL lapses). Keys mirror the ones
// the routes build (finance:<name> for US, finance:in:<name> for India). Covers discover + research
// too (previously unwarmed → they used to go cold for the first user after a TTL lapse).
const WARM_JOBS: [string, number, () => Promise<unknown>][] = [
  ["finance:indices", TTL.indices, () => fetchIndices("us")],
  ["finance:stocks", TTL.stocks, () => fetchStocks("us")],
  ["finance:sectors", TTL.sectors, () => fetchSectors("us")],
  ["finance:crypto", TTL.crypto, fetchCrypto],
  ["finance:predictions", TTL.predictions, fetchPredictions],
  ["finance:summary", TTL.summary, () => fetchMarketSummary("us")],
  ["finance:research", TTL.research, fetchAllResearch],
  ["finance:discover", TTL.discover, () => fetchDiscover("us")],
  ["finance:in:indices", TTL.indices, () => fetchIndices("in")],
  ["finance:in:stocks", TTL.stocks, () => fetchStocks("in")],
  ["finance:in:sectors", TTL.sectors, () => fetchSectors("in")],
  ["finance:in:summary", TTL.summary, () => fetchMarketSummary("in")],
  ["finance:in:discover", TTL.discover, () => fetchDiscover("in")],
];

// Warm every finance cache entry. Called on server startup (index.ts) and by the cron route, so the
// FIRST user after a restart / TTL lapse is served from cache and never pays the cold upstream cost.
export async function warmFinanceCache(): Promise<{ key: string; ok: boolean }[]> {
  const results = await Promise.allSettled(WARM_JOBS.map(([key, ttl, fn]) => forceRefresh(key, ttl, fn)));
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
  res.json({ refreshed: await warmFinanceCache() });
});
