# Caching Strategies for Redis (Upstash)

> Generic reference for cache-aside, read-through, write-through, write-behind, TTL/jitter discipline,
> eviction policies, stampede protection (request coalescing + stale-while-revalidate), and
> invalidation patterns — with Lumina's `backend/lib/cache.ts` as the primary worked example.

---

## 1. Mental Model: Redis Is a Derived Store

In this architecture **Supabase Postgres is the system of record** and Upstash Redis is a *derived*,
*rebuildable* store. Every cached value is a projection of something authoritative that can be
reconstructed by re-querying Postgres or re-fetching a third-party API. This single premise drives
every decision in this document.

- **Every cache miss must be survivable.** Code paths never assume a key exists. A cold Upstash
  instance, a quota reset, or the in-process memory fallback must degrade to "fetch from origin,"
  not "return an error."
- **TTLs are mandatory, not optional.** An entry without a TTL is a memory leak waiting to become an
  unplanned eviction or an infinite-staleness bug. Every cache write sets an explicit TTL.
- **Consistency is bounded staleness, not transactional consistency.** You choose the staleness
  budget per data class. You do not get free read-after-write across the cache/store boundary without
  deliberate write-through or explicit invalidation.
- **Upstash Redis is an HTTP API.** Unlike socket-based Redis clients, Upstash uses REST — this
  means each command is an HTTPS round-trip. Batch aggressively; do not call Redis in a per-item
  loop inside a request handler.
- **Vercel instances are ephemeral and multi-instance.** An in-process cache (`Map`) is per-instance
  and lost on cold start; Upstash is the only real shared cache across serverless instances. The
  in-process `mem` Map in `cache.ts` exists *only* as a local-dev fallback when Upstash is not
  configured. Do not rely on it in production.

> **Rule of thumb:** if losing a Redis value would cause a *correctness* bug rather than a *latency*
> bug, it does not belong in a cache — it belongs in Postgres. Sessions (server-side) are the nuanced
> middle case: they are rebuildable from a re-login, so losing them is a UX cost, not a data-loss bug.

---

## 2. Cache-Aside (Lazy Loading) — The Default

**Cache-aside** (a.k.a. lazy loading) puts the *application* in charge: on a read, look in the cache
first; on a miss, load from the origin, populate the cache, and return. It is the default for
read-heavy workloads because it only caches data that is actually requested and tolerates a cold cache
gracefully.

### 2.1 The canonical flow

```
READ  path:
  v = cache.get(key)
  if v != null:                     # HIT
      return v
  data = origin.load(id)            # MISS → go to system of record / third-party API
  if data == null:
      cache.setNegative(key, shortTtl)   # optional: negative caching (§8)
      return null
  cache.set(key, data, ttlWithJitter)    # §3
  return data

WRITE path (cache-aside pairs with invalidation, not write-through):
  store.update(id, patch)
  cache.del(key)                    # invalidate, do not update — see §9.2 why
```

### 2.2 Typed cache-aside on Upstash

```ts
// backend/lib/marketData.ts  (hypothetical direct cache-aside — prefer getOrRefresh below)
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const TTL_QUOTE = 30; // seconds
const NEG = "__MISS__";

async function getQuote(symbol: string): Promise<Quote | null> {
  const key = `finance:quote:v1:${symbol}`;
  const cached = await redis.get<Quote | typeof NEG>(key);

  if (cached === NEG) return null;           // negative hit (§8)
  if (cached !== null) return cached;        // hit: Upstash auto-parses JSON

  const data = await fetchQuoteFromProvider(symbol);
  if (data === null) {
    await redis.set(key, NEG, { ex: 5, nx: true }); // short negative TTL
    return null;
  }
  await redis.set(key, data, { ex: jitter(TTL_QUOTE) }); // §3
  return data;
}
```

Upstash's `redis.get<T>()` deserializes JSON automatically so you rarely need to manually
`JSON.parse`. Always use `redis.set(key, value, { ex: N })` — never `set` without `ex`.

### 2.3 Why cache-aside pairs with *delete-on-write*, not *update-on-write*

When you mutate the store, the safest companion is to **delete** the cache key (let the next read
repopulate), not to rewrite it. Rewriting reintroduces a race: two concurrent writers can interleave
`store.update` and `cache.set` so the cache ends up with the older value. Deleting is idempotent and
race-tolerant. See §9 for the precise interleaving and the delayed-double-delete refinement.

### 2.4 Strengths and weaknesses

| Property | Cache-aside |
|---|---|
| Only caches requested data | ✅ memory-efficient |
| Tolerates cold cache | ✅ trivially |
| First read after miss is slow | ❌ "cache penalty" on cold keys |
| Susceptible to stampede on hot-key expiry | ❌ — must add §6 protection |
| Read-after-write consistency | ⚠️ delete-on-write + short TTL; not transactional |
| Cache logic is scattered at call sites | ⚠️ — mitigate with read-through (§2.5) |

### 2.5 Read-through — cache-aside behind one abstraction

**Read-through** is cache-aside with the load-on-miss logic moved behind a single `getOrLoad(key,
loader, opts)` helper so call sites never see the cache directly. In Lumina, `getOrRefresh` in
`backend/lib/cache.ts` is exactly this: callers pass a `fetcher` closure and the cache handles the
read/populate cycle (plus coalescing and SWR). See §6 for the full walkthrough.

---

## 3. TTL Discipline + Jitter

TTL is the most important configuration knob you control. Too long → stale data and wasted quota; too
short → low hit ratio and origin overload.

### 3.1 Pick TTL per data class

| Data class | Volatility | Staleness budget | Suggested TTL |
|---|---|---|---|
| Live quote (Finance) | very high | seconds | 15–30 s |
| Market summary / sector | medium | minutes | 60–120 s |
| News feed | medium | minutes | 120–300 s |
| Watchlist (user-specific) | low–medium | minutes | 60 s |
| Discover/search results | medium | minutes | 120–300 s |
| Academic paper metadata | very low | hours | 3600–7200 s |
| Health article feed | low | minutes | 300–600 s |
| Finance chat agent answer | low | hours | 3600 s |
| Negative sentinel (`__MISS__`) | n/a | seconds | 5–30 s |

These are starting points — tune against real API quota consumption and user freshness expectations.

### 3.2 Jitter is non-negotiable for bulk-populated keyspaces

If 500 quote keys are populated during a startup warm and all get a flat 30 s TTL, they all expire
at the same second → a synchronized miss storm hammers Twelve Data / Yahoo simultaneously. Add random
jitter to spread expirations:

```ts
// backend/lib/cache.ts (the pattern; adapt for any TTL you assign)
function jitter(baseSec: number, ratio = 0.15): number {
  const delta = baseSec * ratio;
  return Math.max(1, Math.round(baseSec + (Math.random() * 2 - 1) * delta));
}

// Usage:
await redis.set(key, data, { ex: jitter(30) }); // ±15% → expiry spreads over 9 s window
```

A ±15% jitter on a 30 s TTL spreads 500 keys across a 9 s window instead of a 0 s window — enough
to smooth the miss burst without meaningfully changing freshness.

### 3.3 The `HARD_TTL_MULTIPLIER` pattern in `cache.ts`

Lumina's cache writes with a hard TTL that is `HARD_TTL_MULTIPLIER` (12×) times the soft TTL:

```ts
// backend/lib/cache.ts:54,67
const HARD_TTL_MULTIPLIER = 12;

async function writeEntry<T>(key: string, entry: Entry<T>, ttlSeconds: number): Promise<void> {
  if (redis) {
    await redis.set(key, entry, { ex: Math.max(1, Math.floor(ttlSeconds * HARD_TTL_MULTIPLIER)) });
  } else {
    memSet(key, entry as Entry<unknown>);
  }
}
```

`ttlSeconds` is the **soft TTL** (the freshness window checked by `getOrRefresh`). The Redis key lives
for `12×` longer so a stale value remains available for the stale-while-revalidate and
serve-stale-on-error fallbacks even if the background refresh fails repeatedly. At 30 s soft TTL the
key survives 360 s (6 min) in Redis — enough to ride out a transient API outage without serving
errors.

---

## 4. Write Strategies

### 4.1 Write-through — synchronous cache + store update

**Write-through** updates the cache *and* the store as part of the same write, before returning
success. It gives read-after-write consistency at the cost of higher write latency (two round trips).

**Ordering always store-first, then cache:**

| Order | Failure window | Verdict |
|---|---|---|
| **Store first, then cache** | Cache write fails → store is correct; next read repopulates. Safe. | ✅ Preferred |
| Cache first, then store | Store write fails → cache holds data the store never accepted. | ❌ Avoid |

```ts
// backend/routes/watchlist.ts (illustrative write-through)
export async function updateWatchlist(userId: string, symbols: string[]): Promise<void> {
  // 1) Persist to Postgres (system of record first).
  await prisma.user.update({ where: { id: userId }, data: { watchlist: symbols } });

  // 2) Update the cache; on failure, invalidate so the next read self-heals.
  const key = `watchlist:v1:${userId}`;
  try {
    await redis.set(key, symbols, { ex: jitter(60) });
  } catch {
    await redis.del(key).catch(() => void 0); // best-effort invalidation
  }
}
```

### 4.2 Write-behind (write-back) — deferred persistence

**Write-behind** writes to the cache immediately and persists to the store asynchronously. It gives
the lowest write latency and can coalesce many writes into fewer store writes. The cost is a
**durability window**: data written to the cache but not yet flushed to Postgres is lost if the
Vercel instance is killed before the async flush.

**On Vercel serverless this pattern is dangerous.** Vercel instances can be killed between the cache
write and the async flush with no warning. Use write-behind only for data where bounded loss is
acceptable (e.g. page-view counters), and back it with a durable queue (a Postgres queue table or
worker queue in `worker/`) rather than an in-process `setTimeout`. An in-process timer is
incompatible with Vercel's serverless lifecycle.

### 4.3 Write-around (skip the cache on write)

**Write-around** writes only to the store and does not populate the cache; the cache fills lazily on
the next read (plain cache-aside). Use it when written data is rarely read immediately after writing
(e.g. bulk import of academic papers that may not be viewed for hours). It keeps the cache lean and
avoids polluting it with cold entries.

### 4.4 Strategy decision matrix

| Question | Pattern |
|---|---|
| Read-heavy, sparse access, miss survivable? | **Cache-aside / read-through** |
| Need read-after-write freshness, write latency tolerable? | **Write-through (store-first)** |
| Very high write rate, bounded loss acceptable, no Vercel timer? | **Write-behind via queue in `worker/`** |
| Written data rarely read soon after? | **Write-around** |
| Small set of always-hot keys? | **Refresh-ahead (cron warmer + `forceRefresh`)** |

A real service mixes these: Finance quotes use read-through + coalescing; the featured discover feed
may use refresh-ahead (cron warmer); user profile writes use write-through. Choose **per data class**,
not globally.

---

## 5. Eviction Policies as a Safety Net

TTLs are the *plan*; eviction is the *safety net* for when memory fills despite the plan.

### 5.1 Upstash eviction configuration

Upstash Redis is a managed service; you configure eviction via the Upstash dashboard or plan settings,
not a local `redis.conf`. The relevant policies:

| Policy | Eligible keys | Algorithm | Use for |
|---|---|---|---|
| `noeviction` | — | Reject writes with OOM error | **Source-of-truth stores only** — never a pure cache |
| `allkeys-lru` | all | Approximate LRU | **Default for caches** — evict least-recently-used |
| `allkeys-lfu` | all | Approximate LFU | Caches with strong popularity skew (a few hot symbols) |
| `volatile-lru` | keys with TTL | LRU among expiring keys | Mixed cache + persistent keys |
| `volatile-ttl` | keys with TTL | Shortest remaining TTL first | When TTL encodes priority |

**Recommendation for Lumina's Upstash instance:** use `allkeys-lru` (the Upstash default). Finance
quote keys have an inherent popularity skew (S&P 500 top-20 vs long-tail), but LRU is simpler to
reason about and Upstash's memory limits are a guard rail, not a primary lever.

### 5.2 The in-process memory fallback and its cap

`cache.ts` uses a bounded `Map` as the local-dev fallback with `MEM_MAX_ENTRIES = 500`:

```ts
// backend/lib/cache.ts:42-51
const MEM_MAX_ENTRIES = 500;
const mem = new Map<string, Entry<unknown>>();
function memSet(key: string, entry: Entry<unknown>): void {
  mem.delete(key); // re-insert at the end (Map preserves insertion order)
  mem.set(key, entry);
  while (mem.size > MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}
```

This implements insertion-order LRU eviction by deleting the oldest-inserted key once the cap is
reached. The comment in `cache.ts:39` explains why a cap is needed: Finance agent tools key on
model-chosen symbol sets, making the keyspace unbounded without a cap.

---

## 6. Cache-Stampede Protection

A **cache stampede** (a.k.a. *dogpile*, *thundering herd*) happens when a popular key expires and N
concurrent requests all miss simultaneously, all hit the origin, and all recompute the same value. For
a Finance quote key serving 200 req/s with a 500 ms upstream call, a single expiry can fire ~100
redundant provider calls in the recompute window — enough to exhaust a free API quota in seconds.

Three defences compose:

1. **TTL jitter (§3.2):** prevents *synchronized* mass expiry of many keys. Always on.
2. **In-process request coalescing (single-flight):** within one serverless instance, concurrent
   callers share one in-flight promise. Zero extra round-trips. §6.1.
3. **Stale-while-revalidate (SWR):** serve stale instantly and refresh in the background. The served
   request never waits for the origin. §7.

| Defence | Extra latency for callers | Cross-instance? | Best when |
|---|---|---|---|
| TTL jitter | none (preventive) | yes | always — bulk-populated keyspaces |
| Coalescing (§6.1) | none (shared promise) | no (per-instance) | high concurrency per instance |
| SWR (§7) | none (stale served instantly) | yes (shared cache) | hot keys after soft-TTL lapse |

### 6.1 Request coalescing — the `inflight` Map

`cache.ts` implements in-process coalescing via an `inflight` Map. When `doRefresh` is called for a
key already being fetched, it returns the *same promise* rather than starting a new fetch:

```ts
// backend/lib/cache.ts:58-91
const inflight = new Map<string, Promise<unknown>>();

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
  return p;  // all concurrent callers await the same promise
}
```

**What this achieves:** if 50 requests arrive in the same millisecond for an expired Finance quote
key, `doRefresh` creates one fetch to Twelve Data and stores the promise. The other 49 callers
receive `await`s on the same promise — one upstream call, not 50. The map entry clears on settle so
the *next* expiry starts a fresh fetch.

**What this does not do:** it does not deduplicate across Vercel instances. If 10 instances each
receive concurrent traffic for the same expired key, each instance coalesces internally (10→1 call
per instance) but up to 10 calls can reach the provider concurrently. Under normal Vercel traffic
patterns this is acceptable; the SWR pattern (§7) further reduces this because most instances serve
stale while only one background refresh is needed.

**Failure propagation:** all coalesced callers receive the same rejection if the fetcher throws. This
is correct — the underlying cause is shared — but means one transient provider error fails all
in-flight callers for that key. They fall through to the stale-on-error path in `getOrRefresh` if a
stale value exists (§7.2).

### 6.2 Per-key distributed lock (for especially expensive recomputes)

For a key whose recompute is very expensive (e.g. an LLM-generated finance summary taking 3+ s),
coalescing within one instance may not be enough — multiple instances can all trigger a refresh
simultaneously. Add a distributed lock using Upstash's `SET key token NX EX N` pattern:

```ts
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

const LOCK_TTL_S = 10; // must exceed worst-case recompute time

async function withUpstashLock<T>(
  redis: Redis,
  lockKey: string,
  work: () => Promise<T>,
  fallback: () => Promise<T>, // serve stale or skip if we lose the lock
): Promise<T> {
  const token = randomUUID();
  const acquired = await redis.set(lockKey, token, { ex: LOCK_TTL_S, nx: true });
  if (acquired === null) {
    // Another instance holds the lock; serve stale immediately (§7).
    return fallback();
  }
  try {
    return await work();
  } finally {
    // Compare-and-delete: never release someone else's lock.
    const held = await redis.get(lockKey);
    if (held === token) await redis.del(lockKey);
  }
}
```

Use the lock key at a predictable derivation of the cache key (e.g. `lock:finance:summary:v1`) so it
is easy to inspect. Always fail-open: if the lock is unavailable, the caller serves stale — never
blocks or errors.

### 6.3 Probabilistic early recomputation (XFetch)

For hot keys where you want to avoid any miss at all, the XFetch algorithm probabilistically
recomputes a value *before* it expires. The probability of recomputing rises as expiry approaches,
scaled by how expensive the recompute is (so cheap keys barely recompute early; expensive keys get
a longer head start). No locks, no waiting.

```ts
interface Envelope<T> { v: T; d: number; x: number; } // value, delta_ms, absolute_expiry_ms

async function xfetch<T>(
  redis: Redis,
  key: string,
  recompute: () => Promise<T>,
  ttlSeconds: number,
  beta = 1.0,
): Promise<T> {
  const raw = await redis.get<Envelope<T>>(key);
  if (raw !== null) {
    const now = Date.now();
    const lead = raw.d * beta * -Math.log(Math.random()); // grows as expiry nears
    if (now - lead < raw.x) return raw.v; // still "fresh enough" — serve from cache
  }

  const start = Date.now();
  const value = await recompute();
  const delta = Date.now() - start;
  const envelope: Envelope<T> = { v: value, d: delta, x: Date.now() + ttlSeconds * 1_000 };
  // Hard backstop: set real TTL slightly beyond logical expiry so nobody ever hard-misses.
  await redis.set(key, envelope, { px: ttlSeconds * 1_000 + delta * 2 });
  return value;
}
```

XFetch is the best fit for **read-heavy hot keys where the recompute is fast enough to run
occasionally from any caller** (Finance quote → ~100 ms provider call). Use a distributed lock (§6.2)
instead when the recompute is so expensive that even rare double-computes are unacceptable.

---

## 7. Stale-While-Revalidate + Serve-Stale-on-Error

### 7.1 The `getOrRefresh` SWR branch

Lumina's `getOrRefresh` implements stale-while-revalidate (SWR) as the primary freshness strategy.
When a key has a stale-but-present value, the caller receives that value *instantly* while a
background refresh runs asynchronously:

```ts
// backend/lib/cache.ts:93-124
export async function getOrRefresh<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<CacheResult<T>> {
  const now = Date.now();
  const existing = await readEntry<T>(key);

  // Fresh (age < ttl) → serve as-is.
  if (existing && now - existing.fetchedAt < ttlSeconds * 1000) {
    return { data: existing.data, fetchedAt: existing.fetchedAt, stale: false, hit: true };
  }

  // STALE-WHILE-REVALIDATE: a stale-but-present value is served INSTANTLY while a
  // refresh runs in the background. The key latency win — the first user after a TTL
  // lapse no longer blocks on the slow upstream (LLM / 3rd-party API); they get the
  // recent cached copy in ~ms and the next read sees the refreshed value.
  if (existing) {
    void doRefresh(key, ttlSeconds, fetcher).catch((err) =>
      console.warn(`[cache] background refresh failed for "${key}", keeping stale:`, err),
    );
    return { data: existing.data, fetchedAt: existing.fetchedAt, stale: true, hit: true };
  }

  // Cold cache (first-ever / truly cold) → block once on the fetch.
  const data = await doRefresh(key, ttlSeconds, fetcher);
  return { data, fetchedAt: now, stale: false, hit: false };
}
```

The SWR branch relies on the `HARD_TTL_MULTIPLIER` (§3.3): the Redis key lives for `12×` the soft
TTL so the stale value is available for a long window even if background refreshes are failing.

**Why `void` the background refresh:** the caller has already received a response. Awaiting the
refresh would add latency to the response for no benefit. Errors in the background refresh are logged
but do not propagate.

**The `stale` flag in `CacheResult`:** callers can inspect `result.stale` and attach a header or
augment the response payload so clients know the data may not be current:

```ts
// backend/finance/routes.ts (illustrative)
const result = await getOrRefresh(`finance:quote:v1:${symbol}`, 30, () => fetchQuote(symbol));
if (result.stale) {
  res.setHeader("X-Cache-Stale", "1");
  res.setHeader("X-Cache-Age", String(Math.round((Date.now() - result.fetchedAt) / 1000)));
}
res.json(result.data);
```

### 7.2 Serve-stale-on-error

Lumina's cache silently keeps stale entries around (hard TTL 12× the soft TTL) specifically for the
**serve-stale-on-error** case. If the background refresh `doRefresh` throws (provider down, rate
limit), the catch handler logs a warning and the stale value continues to be served to the next
callers. This converts a provider outage from a `500` error cascade into "data may be a few minutes
old."

The comment in `cache.ts:18-19` documents this explicitly:

```
// • fetcher throws but we have old  → return it flagged stale (graceful degradation —
//                                      never 500 a read we've served before)
// • fetcher throws, nothing cached  → rethrow
```

Callers that receive a cold-miss rethrow must handle the exception:

```ts
try {
  const result = await getOrRefresh(key, ttl, fetcher);
  return result.data;
} catch (err) {
  // Origin is down AND nothing was ever cached — genuinely unavailable.
  return res.status(503).json({ error: "unavailable", message: "market data temporarily unavailable" });
}
```

Never fabricate finance numbers when the origin is unavailable (CLAUDE.md non-negotiable #1).

### 7.3 `forceRefresh` — the cron warmer

`forceRefresh` bypasses the soft-TTL check and always runs `doRefresh`, awaiting the result:

```ts
// backend/lib/cache.ts:128-134
export async function forceRefresh<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  return doRefresh(key, ttlSeconds, fetcher);
}
```

Use this in the startup warmer and the cron route to pre-populate the cache before users request it:

```ts
// backend/finance/routes.ts  (cron endpoint, guarded by CRON_SECRET)
router.get("/finance/warm", async (req, res) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  await Promise.all(
    HOT_SYMBOLS.map((sym) =>
      forceRefresh(`finance:quote:v1:${sym}`, 30, () => fetchQuote(sym))
    )
  );
  res.json({ warmed: HOT_SYMBOLS.length });
});
```

The cron is configured via cron-job.org (not a Vercel cron) to call this endpoint on a schedule
shorter than the soft TTL, so hot keys are always pre-warmed. `doRefresh` is de-duped via the
`inflight` Map, so even if the cron fires while a user is triggering a refresh for the same key,
only one upstream call fires.

---

## 8. Negative Caching

If a search for a non-existent symbol or entity is called repeatedly (scrapers, broken links,
enumeration), every call is a guaranteed cache miss that hits the provider. **Negative caching**
stores a sentinel for "this does not exist" with a *short* TTL, converting those misses into cheap
cache hits.

```ts
const NEG_SENTINEL = "__MISS__";
const NEG_TTL_S = 15; // short: a newly-created resource must become visible quickly

async function lookupSymbol(symbol: string): Promise<SymbolInfo | null> {
  const key = `finance:symbol:v1:${symbol.toUpperCase()}`;

  const cached = await redis.get<SymbolInfo | typeof NEG_SENTINEL>(key);
  if (cached === NEG_SENTINEL) return null; // negative hit — avoid the provider round-trip
  if (cached !== null) return cached;

  const info = await providerLookup(symbol);
  if (info === null) {
    // Cache the miss — NX so we do not clobber a race-created positive entry.
    await redis.set(key, NEG_SENTINEL, { ex: NEG_TTL_S, nx: true });
    return null;
  }
  await redis.set(key, info, { ex: jitter(3600) });
  return info;
}
```

### Rules

- **Short TTL** (seconds, not minutes). A negative entry that outlives entity creation makes a
  just-created resource appear missing. 5–30 s is appropriate for most Lumina data classes.
- **Invalidate on create.** When you create the entity, `DEL` the negative key (or write-through the
  positive value). Otherwise a create followed immediately by a read returns "not found" until the
  negative TTL lapses.
- **Use a distinguishable sentinel.** `"__MISS__"` cannot collide with a valid JSON object. Never use
  empty string or JavaScript `null` — they are ambiguous against legitimately-empty values or absent
  keys.
- **Security benefit:** negative caching caps the damage of ID-enumeration scans by serving them from
  Redis instead of hitting the provider on every attempt.

---

## 9. Invalidation Strategies

> "There are only two hard things in Computer Science: cache invalidation and naming things." — Phil
> Karlton

### 9.1 The four invalidation triggers

| Trigger | Mechanism | Pros | Cons |
|---|---|---|---|
| **TTL expiry** | Passive — key lapses | Zero coordination | Bounded staleness window |
| **Explicit delete on write** | `redis.del(key)` after store write | Fresh after write | Must cover every write path |
| **Version bump** | Change key namespace → old keys orphaned | Instant bulk invalidation, O(1) | Orphaned keys rely on TTL/eviction |
| **Event-driven** | Queue/webhook fan-out on change | Decoupled, multi-consumer | Requires infra + at-least-once handling |

In practice: **TTL (always) + explicit delete-on-write (for low-staleness data) + version bump (for
schema/format changes or bulk invalidation).**

### 9.2 Delete-on-write and the race that motivates "double delete"

Consider cache-aside with delete-on-write under concurrency:

```
T1 (write):  store.update(price=125)
T2 (read):   cache miss → provider call returns 124 (stale, just before T1 committed)
T1 (write):  cache.del(key)         # deletes nothing; cache was empty
T2 (read):   cache.set(key, 124)    # ⚠️ writes the stale value 124 after the delete
result: cache holds 124, store holds 125 — stale until TTL
```

This is rare for market data (providers are the source of truth; Postgres is secondary) but critical
for user-owned data (watchlists, connector tokens). Mitigations in increasing strength:

1. **Short TTL** caps the staleness window regardless (the cheap, always-on defense).
2. **Delayed double-delete:** after the store write, `DEL` immediately, then schedule a second `DEL`
   after a small delay (e.g., 500 ms–1 s) to remove any stale value written by an in-flight reader.
   On Vercel, implement the delay via a Postgres queue row drained by the `worker/` (not
   `setTimeout`, which dies with the instance).
3. **Write-through (§4.1):** set the fresh value instead of deleting — but requires careful ordering.

### 9.3 Version bump for bulk invalidation

Encode a version segment in every cache key:

```
<domain>:<entity>:v<schemaVersion>:<id>
```

Examples: `finance:quote:v1:AAPL`, `discover:feed:v2:technology`, `academic:paper:v1:<doi>`. When you
change the serialized shape of a cached value (add a field, change a type), bump the version: old
`v1` keys are never read again and expire via TTL/eviction. No flush needed, no mixed-format reads.

For *runtime* bulk invalidation without a code deploy, use an indirection counter:

```ts
// Bump to orphan all current cached results for a given feed category:
async function bumpFeedVersion(category: string): Promise<void> {
  await redis.incr(`ver:discover:feed:${category}`);
}

async function feedCacheKey(category: string): Promise<string> {
  const ver = (await redis.get<number>(`ver:discover:feed:${category}`)) ?? 1;
  return `discover:feed:v${ver}:${category}`;
}
```

After `bumpFeedVersion("technology")`, all reads use the new version key and miss (refilling from
origin); orphaned old-version keys cost nothing until they expire. This is O(1) bulk invalidation vs
O(N) deletes.

### 9.4 Invalidating related keys

A Finance quote update may invalidate `finance:quote:v1:AAPL`, `finance:watchlist:v1:<userId>`, and
`finance:summary:v1:technology`. Three approaches:

- **Enumerate explicitly** — simple; brittle as the dependency set grows.
- **Tag set:** maintain a Redis Set of keys that depend on an entity; on change, read the set and
  issue per-key `DEL`s. Issue them individually (Upstash pipelines) — Upstash does not support
  multi-key `DEL` with cross-slot concerns the way cluster Redis does, but the `Pipeline` abstraction
  still batches the HTTPS round-trips.
- **Version bump (§9.3):** cleanest for bulk invalidation by category.

---

## 10. Anti-Patterns

Each item: the mistake, why it is wrong, and the fix.

1. **Caching without a TTL.**
   *Why wrong:* stale data persists until eviction (which may be indefinitely on Upstash paid plans
   with sufficient RAM); a missed invalidation path serves wrong data forever.
   *Fix:* set `{ ex: N }` on **every** `redis.set`; treat explicit invalidation (§9) as an
   optimization layered on top.

2. **Flat un-jittered TTLs on a bulk-populated keyspace.**
   *Why wrong:* all keys created in the same warm cycle expire in the same second → synchronized miss
   storm hits providers simultaneously (§3.2).
   *Fix:* add ±10–25% random jitter to every TTL.

3. **Omitting the `HARD_TTL_MULTIPLIER` when implementing stale-while-revalidate.**
   *Why wrong:* if the hard Redis TTL equals the soft TTL, the stale value is evicted before the SWR
   background refresh completes → the fallback has nothing to serve → forced cold miss under load.
   *Fix:* set the hard Redis TTL at a generous multiple (12× or similar) of the soft TTL so stale
   values survive provider outages.

4. **Not de-duping concurrent refreshes of the same key (no coalescing).**
   *Why wrong:* on a Vercel instance receiving 50 req/s for an expired quote, all 50 fire provider
   calls simultaneously → quota exhausted in seconds.
   *Fix:* use the `inflight` Map pattern from `doRefresh` (§6.1) to coalesce concurrent fetchers onto
   one in-flight promise.

5. **Returning a fabricated/hardcoded finance number when the cache misses and the provider is down.**
   *Why wrong:* incorrect price data causes real financial harm; CLAUDE.md non-negotiable #1 is
   absolute here.
   *Fix:* return a typed `unavailable` response or re-throw; never invent a number.

6. **Using write-behind with an in-process `setTimeout` on Vercel.**
   *Why wrong:* Vercel instances are killed without notice; the timer never fires; writes are silently
   lost.
   *Fix:* back write-behind with a Postgres queue + `worker/` consumer, or use write-through.

7. **Storing secrets / tokens as plain-text cache values.**
   *Why wrong:* Redis is not an encrypted store; a key dump or a log line would expose the secret.
   *Fix:* store encrypted blobs (as Lumina does for Gmail `refreshTokenEnc` in Postgres — never
   in Redis); cache only non-sensitive derived data.

8. **Using the in-process `mem` Map as if it were a shared cache in production.**
   *Why wrong:* each Vercel instance has its own `Map`; cold starts wipe it; it is never shared.
   *Fix:* set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` before deploying. The `mem`
   Map exists *only* for local dev without Upstash configured (`cacheBackend === "memory"`).

9. **Issuing per-item Redis calls in a request handler loop.**
   *Why wrong:* Upstash is an HTTP API; 50 individual `redis.get` calls in a loop = 50 sequential
   HTTPS round-trips → hundreds of milliseconds of latency.
   *Fix:* use `redis.mget([...keys])` for bulk reads, or restructure to one Redis call per request.

10. **No negative caching on hot "not found" paths.**
    *Why wrong:* scrapers or broken links repeatedly request non-existent symbols; every call hits the
    provider API; quota drains on misses.
    *Fix:* cache a short-TTL sentinel for misses (§8); invalidate on create.

11. **Cache failures crashing the request.**
    *Why wrong:* a transient Upstash outage should degrade to "slower (fetch from origin)," not "500
    error." The cache is a performance optimization, not a correctness dependency.
    *Fix:* wrap cache reads to fail open to the fetcher on Redis errors; see the `getOrRefresh` design
    where a cold miss falls through to `doRefresh`.

12. **Reading the `stale` flag and silently discarding it.**
    *Why wrong:* callers that need to surface data freshness to the frontend or to the LLM context
    need to know when they are working from stale data.
    *Fix:* inspect `CacheResult.stale`; propagate via response headers or the SSE stream metadata
    where appropriate (e.g., a Finance agent answer derived from a stale quote should say so).

---

## 11. Key Naming Conventions

Consistent key naming makes the keyspace inspectable, prevents collisions, and enables safe version
bumps.

```
<domain>:<entity>:v<schemaVersion>:<identifier>[:<subresource>]
```

| Domain | Examples |
|---|---|
| `finance` | `finance:quote:v1:AAPL`, `finance:summary:v1:technology`, `finance:watchlist:v1:<userId>` |
| `discover` | `discover:feed:v2:technology`, `discover:search:v1:<queryHash>` |
| `academic` | `academic:paper:v1:<doiEncoded>`, `academic:search:v1:<queryHash>` |
| `health` | `health:feed:v1:cardiology`, `health:search:v1:<queryHash>` |
| `rl` | `rl:finance:<ip>` (rate-limit sliding window — see `backend/lib/ratelimit.ts`) |
| `lock` | `lock:finance:summary:v1:technology` (distributed fill lock — §6.2) |
| `ver` | `ver:discover:feed:technology` (version indirection counter — §9.3) |

Rules:
- Never use `:*` glob patterns to find and delete keys — scan a dependency set or bump a version
  instead (no `SCAN` equivalent of `KEYS` is safe to call from an Upstash serverless context for
  large keyspaces).
- Include the schema version in every key. When the value shape changes, bump the version — never
  migrate in place.
- Hash or encode query strings before using them as key segments to avoid length limits and
  illegal characters.

---

## 12. Worked Example: `getOrRefresh` end-to-end

Tracing a Finance quote request through the full cache lifecycle:

```ts
// backend/finance/routes.ts (simplified)
import { getOrRefresh } from "../lib/cache.js";
import { fetchQuote } from "./providers/index.js";

router.get("/finance/quote/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const KEY = `finance:quote:v1:${symbol.toUpperCase()}`;
  const TTL = 30; // soft TTL seconds

  let result;
  try {
    result = await getOrRefresh(KEY, TTL, () => fetchQuote(symbol));
  } catch (err) {
    // Cold miss AND provider threw — nothing cached, nothing to serve.
    return res.status(503).json({ error: "unavailable" });
  }

  // Propagate staleness to the client so the UI can show a "delayed data" badge.
  if (result.stale) {
    res.setHeader("X-Cache-Stale", "1");
    res.setHeader("X-Cache-Age-Seconds", String(Math.round((Date.now() - result.fetchedAt) / 1000)));
  }

  res.json({
    symbol: symbol.toUpperCase(),
    quote: result.data,
    cached: result.hit,
    stale: result.stale,
  });
});
```

**Request 1 (cold):** `readEntry` returns `null` → `doRefresh` calls `fetchQuote`, writes to Redis
with hard TTL 360 s (30 × 12), returns data. Response: `hit: false, stale: false`.

**Requests 2–N within 30 s:** `readEntry` returns fresh entry; age check passes → early return.
Response: `hit: true, stale: false`. Zero calls to Twelve Data.

**Request N+1 at t=31 s (soft-TTL lapse):** `readEntry` returns entry; age check fails (stale). SWR
branch fires: caller gets the stale entry immediately (~2 ms); `doRefresh` runs in the background via
`inflight` de-dup. Response: `hit: true, stale: true`. One upstream call eventually.

**If background refresh throws:** the `console.warn` fires; `inflight` entry is deleted. The *next*
caller at t=32 s sees the same stale SWR branch again, tries another background refresh. The stale
value remains available in Redis until t = 30 × 12 = 360 s from last successful write.

**At t=361 s (hard-TTL expiry, provider down for 5+ min):** `readEntry` returns `null`. Cold path
blocks on `doRefresh`. If `fetchQuote` throws, `getOrRefresh` rethrows → route returns 503.

---

## See also

**Within the redis skill:**
- `lumina-redis-setup.md` — Upstash client setup, environment variables, REST vs socket, local-dev
  fallback
- `lumina-rate-limiting.md` — `@upstash/ratelimit`, sliding window, fail-open policy in
  `backend/lib/ratelimit.ts`

**Other skills:**
- `finance-markets` SKILL.md — TTL policy decisions for live quote vs summary vs agent data classes
- `ai-sdk-agent` SKILL.md — how the Finance chat agent calls `getOrRefresh` for semantic cache
  lookups (answer cache, not RAG)
- `rag-retrieval` SKILL.md — pgvector semantic cache using `$queryRaw` on `CachedQuery`; why the
  answer-cache design does not use Redis for the vector store
- `backend-testing` SKILL.md — mocking `getOrRefresh` / `forceRefresh` in unit tests; the
  `backend/tests/helpers/` seams
- `connectors-oauth` SKILL.md — Gmail token vault stored in Postgres (never Redis); why secrets stay
  out of the cache layer
