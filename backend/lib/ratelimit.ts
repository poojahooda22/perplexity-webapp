// ─────────────────────────────────────────────────────────────────────────
// Rate limiting for the public Finance read endpoints.
//
// WHY (not just LLM tokens): the cache already shields the upstream vendors from
// normal traffic, but a buggy client, a scraper, or an abusive user can still hammer
// OUR endpoint — burning Upstash command quota, Vercel function invocations, free
// vendor quotas, and (for AI-backed panels) real LLM spend. This is the seatbelt.
//
// Upstash Ratelimit (sliding window, shared across serverless instances) when the
// UPSTASH_* env vars are set; otherwise an in-memory per-instance window for local dev.
// ─────────────────────────────────────────────────────────────────────────

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import type { Request, Response, NextFunction } from "express";

const LIMIT = 60; // requests…
const WINDOW_SEC = 60; // …per minute, per client IP

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

const upstashLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(LIMIT, `${WINDOW_SEC} s`),
      prefix: "rl:finance",
    })
  : null;

// In-memory fallback (per-instance sliding window).
const hits = new Map<string, number[]>();
function memAllow(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_SEC * 1000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length <= LIMIT;
}

export async function allowRequest(key: string): Promise<boolean> {
  if (upstashLimiter) {
    const { success } = await upstashLimiter.limit(key);
    return success;
  }
  return memAllow(key);
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}

// Express middleware: rate-limit public finance reads by client IP.
export async function financeRateLimit(req: Request, res: Response, next: NextFunction) {
  try {
    const ok = await allowRequest(clientIp(req));
    if (!ok) return res.status(429).json({ error: "Too many requests — slow down." });
  } catch (e) {
    // Fail OPEN: a limiter outage must not take down reads.
    console.warn("[ratelimit] check failed, allowing:", e instanceof Error ? e.message : e);
  }
  next();
}
