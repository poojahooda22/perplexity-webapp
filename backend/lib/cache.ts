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

export async function getOrRefresh<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<CacheResult<T>> {
  const now = Date.now();
  const existing = await readEntry<T>(key);
  if (existing && now - existing.fetchedAt < ttlSeconds * 1000) {
    return { data: existing.data, fetchedAt: existing.fetchedAt, stale: false, hit: true };
  }
  try {
    // Share one in-flight fetch across concurrent callers for the same key.
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fetcher();
      inflight.set(key, p);
      void Promise.resolve(p).then(
        () => inflight.delete(key),
        () => inflight.delete(key),
      );
    }
    const data = await p;
    await writeEntry(key, { data, fetchedAt: now }, ttlSeconds);
    return { data, fetchedAt: now, stale: false, hit: false };
  } catch (err) {
    if (existing) {
      // Upstream failed but we have a prior value — serve it stale rather than fail the read.
      console.warn(
        `[cache] refresh failed for "${key}", serving stale:`,
        err instanceof Error ? err.message : err,
      );
      return { data: existing.data, fetchedAt: existing.fetchedAt, stale: true, hit: true };
    }
    throw err;
  }
}
