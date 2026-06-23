// ─────────────────────────────────────────────────────────────────────────
// Cache layer for the Finance tab's market data.
//
// WHY: live market data comes from rate-limited free APIs. Hitting them once per
// user request would (a) be slow and (b) blow the free quota in minutes. Instead we
// fetch ONCE, cache the result, and serve that copy to everyone until it goes stale.
// ("Compute the flyer once, hand out copies" — the R-SCALE read-spike pattern.)
//
// WHERE: Upstash Redis when configured (an in-memory key→value store reachable over
// HTTP — sub-millisecond reads, shared across all serverless instances, the only kind
// that works on Vercel). Falls back to an in-process Map for local `bun --hot` dev so
// nothing has to be set up to start building. Set the two UPSTASH_* env vars before
// deploying for real, or the cache is per-instance and cold-start-wiped on serverless.
//
// getOrRefresh(key, ttl, fetcher):
//   • fresh (age < ttl)              → return cached      (HIT)
//   • missing / stale                → run fetcher, cache  (MISS)
//   • fetcher throws but we have old  → return it flagged stale (graceful degradation —
//                                       never 500 a read we've served before)
//   • fetcher throws, nothing cached  → rethrow
// ─────────────────────────────────────────────────────────────────────────

import { Redis } from "@upstash/redis";

type Entry<T> = { data: T; fetchedAt: number };
export type CacheResult<T> = { data: T; fetchedAt: number; stale: boolean; hit: boolean };

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

export const cacheBackend: "upstash" | "memory" = redis ? "upstash" : "memory";

// Dev-only credit saver: FREEZE the LLM-backed finance surfaces (market summary, global research,
// daily briefing). When FINANCE_LLM_FROZEN=1, any frozen-key read that already has a cached value is
// served from cache and NEVER regenerated — so browsing the UI on localhost burns ZERO Vercel AI
// Gateway credits. With a durable cache (Upstash) the cached copy survives restarts → $0 across
// restarts; on the in-memory fallback the value is rebuilt once per cold boot, then frozen. No effect
// on the free-API surfaces (crypto/indices/…), which never cost LLM credits. To force fresh data
// while frozen: POST /finance/cron/refresh?force=1 (bypasses the freeze).
export const llmFrozen = process.env.FINANCE_LLM_FROZEN === "1";

// Per-call options. `llm:true` marks a cost-bearing LLM surface so the freeze switch and the
// conditional warmer (warmIfStale) treat it specially.
export type RefreshOpts = { llm?: boolean };

// In-memory fallback (local dev / any instance without Upstash). Keep entries past their TTL
// so the stale-on-error fallback has something to serve. Agent tools key on model-chosen
// symbol sets (e.g. finance:quote:<symbols>), so the keyspace is UNbounded — cap the Map and
// evict oldest-inserted entries (Map preserves insertion order) to prevent unbounded growth.
const MEM_MAX_ENTRIES = 500;
const mem = new Map<string, Entry<unknown>>();
function memSet(key: string, entry: Entry<unknown>): void {
  mem.delete(key); // re-insert at the end so recently-written keys are evicted last
  mem.set(key, entry);
  while (mem.size > MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}
// Redis hard-TTL = soft TTL × this, so a stale value survives long enough to be a fallback.
const HARD_TTL_MULTIPLIER = 12;

// In-flight refreshes keyed by cache key — de-dupes concurrent refreshes of the same key
// (thundering-herd guard; protects rate-limited upstreams like Twelve Data).
const inflight = new Map<string, Promise<unknown>>();

async function readEntry<T>(key: string): Promise<Entry<T> | null> {
  if (redis) return (await redis.get<Entry<T>>(key)) ?? null; // Upstash auto-parses JSON
  return (mem.get(key) as Entry<T> | undefined) ?? null;
}

async function writeEntry<T>(key: string, entry: Entry<T>, ttlSeconds: number): Promise<void> {
  if (redis) {
    await redis.set(key, entry, { ex: Math.max(1, Math.floor(ttlSeconds * HARD_TTL_MULTIPLIER)) });
  } else {
    memSet(key, entry as Entry<unknown>);
  }
}

// Fetch fresh + write the cache, de-duped via `inflight` so concurrent callers AND the
// stale-while-revalidate trigger below share ONE upstream call. Resolves with the fresh data.
function doRefresh<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    const startedAt = Date.now();
    p = (async () => {
      const data = await fetcher();
      await writeEntry(key, { data, fetchedAt: startedAt }, ttlSeconds);
      return data;
    })();
    inflight.set(key, p);
    void p.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
  }
  return p;
}

export async function getOrRefresh<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  opts: RefreshOpts = {},
): Promise<CacheResult<T>> {
  const now = Date.now();
  const existing = await readEntry<T>(key);

  // FROZEN dev mode (LLM surfaces only): serve the cached copy and NEVER regenerate — no Gateway
  // credits while testing. Staleness is still reported honestly (non-negotiable #5); we just don't
  // refresh. A still-empty key (no cached value yet) falls through and is populated ONCE below.
  if (opts.llm && llmFrozen && existing) {
    const stale = now - existing.fetchedAt >= ttlSeconds * 1000;
    return { data: existing.data, fetchedAt: existing.fetchedAt, stale, hit: true };
  }

  // Fresh (age < ttl) → serve as-is.
  if (existing && now - existing.fetchedAt < ttlSeconds * 1000) {
    return { data: existing.data, fetchedAt: existing.fetchedAt, stale: false, hit: true };
  }

  // STALE-WHILE-REVALIDATE: a stale-but-present value is served INSTANTLY while a refresh runs in
  // the background. The key latency win — the first user after a TTL lapse no longer blocks on the
  // slow upstream (LLM / 3rd-party); they get the recent cached copy in ~ms and the next read sees
  // the refreshed value. Survives because the hard-TTL keeps stale entries around (see writeEntry).
  if (existing) {
    void doRefresh(key, ttlSeconds, fetcher).catch((err) =>
      console.warn(
        `[cache] background refresh failed for "${key}", keeping stale:`,
        err instanceof Error ? err.message : err,
      ),
    );
    return { data: existing.data, fetchedAt: existing.fetchedAt, stale: true, hit: true };
  }

  // Empty cache (first-ever / truly cold) → block once on the fetch. The ONLY path that waits; the
  // warmer (forceRefresh on startup + cron) pre-populates so real users hit this rarely or never.
  const data = await doRefresh(key, ttlSeconds, fetcher);
  return { data, fetchedAt: now, stale: false, hit: false };
}

// Force a fresh fetch + cache write and AWAIT it (de-duped via `inflight`). For the cron/startup
// WARMER, which must actually populate the cache (not serve stale) so warmed reads are instant.
export async function forceRefresh<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  return doRefresh(key, ttlSeconds, fetcher);
}

// Conditional warmer used at startup/cron: refresh a key ONLY if it's missing or stale, so a server
// restart never needlessly regenerates a surface that's still fresh in a durable cache — this is what
// stops repeated dev restarts from re-burning Gateway credits on the LLM surfaces. When the LLM
// surfaces are FROZEN, an LLM key that already has ANY cached value is skipped entirely (a
// still-empty one is populated once so the UI isn't blank). Returns whether a refresh actually ran.
export async function warmIfStale<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  opts: RefreshOpts = {},
): Promise<{ warmed: boolean }> {
  // Frozen LLM surface: the warmer never (re)generates it — even an empty key is left for the first
  // actual page visit to populate ONCE (so a dev only testing, say, the crypto tab pays $0 for the
  // briefing/summary/research they never open).
  if (opts.llm && llmFrozen) return { warmed: false };
  const existing = await readEntry<T>(key);
  if (existing && Date.now() - existing.fetchedAt < ttlSeconds * 1000) return { warmed: false }; // still fresh
  await forceRefresh(key, ttlSeconds, fetcher);
  return { warmed: true };
}
