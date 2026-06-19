// ─────────────────────────────────────────────────────────────────────────
// Finance tab routes. Public READS (rate-limited, served from cache) + a cron WARMER.
// Mounted at /finance in index.ts → full paths /finance/crypto, /finance/indices, etc.
// ─────────────────────────────────────────────────────────────────────────

import { Router, type RequestHandler } from "express";
import { getOrRefresh } from "../lib/cache";
import { financeRateLimit } from "../lib/ratelimit";
import { fetchCrypto, fetchPredictions, fetchIndices, fetchStocks } from "./sources";
import { fetchMarketSummary } from "./summary";
import { fetchAllResearch } from "./research";
import { fetchDiscover } from "./news";

export const financeRouter = Router();

// Cache TTLs (seconds). Crypto/predictions move fast; stocks/indices we refresh gently to
// stay well under Twelve Data's free 800-calls/day + 8/min limits.
const TTL = { crypto: 30, predictions: 120, indices: 300, stocks: 300, summary: 900, research: 21_600, discover: 600 };
const CACHE_KEYS = {
  crypto: "finance:crypto",
  predictions: "finance:predictions",
  indices: "finance:indices",
  stocks: "finance:stocks",
  summary: "finance:summary",
  research: "finance:research",
  discover: "finance:discover",
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

financeRouter.get("/crypto", financeRateLimit, readRoute(CACHE_KEYS.crypto, TTL.crypto, fetchCrypto));
financeRouter.get("/predictions", financeRateLimit, readRoute(CACHE_KEYS.predictions, TTL.predictions, fetchPredictions));
financeRouter.get("/indices", financeRateLimit, readRoute(CACHE_KEYS.indices, TTL.indices, fetchIndices));
financeRouter.get("/stocks", financeRateLimit, readRoute(CACHE_KEYS.stocks, TTL.stocks, fetchStocks));
// Market Summary is LLM-backed → long TTL so it generates only ~once per window.
financeRouter.get("/summary", financeRateLimit, readRoute(CACHE_KEYS.summary, TTL.summary, fetchMarketSummary));
// Global Research is LLM-backed + multi-category → 6h TTL (analytical content changes slowly).
financeRouter.get("/research", financeRateLimit, readRoute(CACHE_KEYS.research, TTL.research, fetchAllResearch));
// Discover financial-news carousel (Finnhub /news, headline+link+image only).
financeRouter.get("/discover", financeRateLimit, readRoute(CACHE_KEYS.discover, TTL.discover, fetchDiscover));

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

// Cron warmer. Forces a refresh of every series so reads stay hot. Wire a free scheduler
// (cron-job.org) to POST here with the CRON_SECRET; the guard is skipped if it's unset.
financeRouter.post("/cron/refresh", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : undefined;
    const provided = bearer || (req.headers["x-cron-secret"] as string | undefined);
    if (provided !== secret) return res.status(401).json({ error: "unauthorised" });
  }
  const jobs: [string, () => Promise<unknown>][] = [
    ["indices", fetchIndices],
    ["stocks", fetchStocks],
    ["crypto", fetchCrypto],
    ["predictions", fetchPredictions],
  ];
  const results = await Promise.allSettled(jobs.map(([key, fn]) => getOrRefresh(`finance:${key}`, 0, fn)));
  res.json({ refreshed: jobs.map(([key], i) => ({ key, ok: results[i]!.status === "fulfilled" })) });
});
