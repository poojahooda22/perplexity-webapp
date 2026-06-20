// ─────────────────────────────────────────────────────────────────────────
// Discover routes (health / academic) — the generalized version of the finance Discover feed.
// Public, rate-limited, served from the SAME getOrRefresh cache + a cron warmer. Mounted at
// /discover in index.ts → GET /discover/academic?market=us|in (health to follow).
// ─────────────────────────────────────────────────────────────────────────

import { Router, type RequestHandler } from "express";
import { getOrRefresh } from "../lib/cache.js";
import { financeRateLimit } from "../lib/ratelimit.js";
import { fetchAcademicDiscover } from "./academic.js";
import type { Market } from "./shared.js";

export const discoverRouter = Router();

// Academic content changes slowly → a long-ish TTL; the cron warmer keeps it hot regardless.
const TTL = { academic: 1800 };

// Market-aware cached read: ?market=in serves the India series from a SEPARATE cache key
// (discover:in:<topic>); default/US uses discover:<topic>. Mirrors finance's marketReadRoute.
function discoverRoute(
  topic: string,
  ttl: number,
  fetcher: (m: Market) => Promise<unknown>,
): RequestHandler {
  return async (req, res) => {
    const market: Market = req.query.market === "in" ? "in" : "us";
    const key = market === "in" ? `discover:in:${topic}` : `discover:${topic}`;
    try {
      const r = await getOrRefresh(key, ttl, () => fetcher(market));
      res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
    } catch (e) {
      console.error(`[discover] ${key} failed:`, e instanceof Error ? e.message : e);
      res.status(502).json({ error: `${key} upstream failed` });
    }
  };
}

discoverRouter.get("/academic", financeRateLimit, discoverRoute("academic", TTL.academic, fetchAcademicDiscover));

// Cron warmer — force-refresh every series so reads stay hot (wire cron-job.org to POST here
// with CRON_SECRET; the guard is skipped if it's unset). Mirrors finance's /cron/refresh.
discoverRouter.post("/cron/refresh", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : undefined;
    const provided = bearer || (req.headers["x-cron-secret"] as string | undefined);
    if (provided !== secret) return res.status(401).json({ error: "unauthorised" });
  }
  const jobs: [string, () => Promise<unknown>][] = [
    ["academic", () => fetchAcademicDiscover("us")],
    ["in:academic", () => fetchAcademicDiscover("in")],
  ];
  const results = await Promise.allSettled(jobs.map(([key, fn]) => getOrRefresh(`discover:${key}`, 0, fn)));
  res.json({ refreshed: jobs.map(([key], i) => ({ key, ok: results[i]!.status === "fulfilled" })) });
});
