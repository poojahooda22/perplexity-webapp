# lumina-upstash-cache — Cache & Rate-Limit Layer Deep Dive

> **Start here** for any task touching `backend/lib/cache.ts` or `backend/lib/ratelimit.ts`. This
> document traces every code path with exact `file:line` citations: the Upstash-vs-memory backend
> switch, stale-while-revalidate, the hard-TTL multiplier, the bounded in-memory fallback, the
> inflight de-dupe guard, the sliding-window rate limiter, how the finance routes consume all of it,
> the cron/startup warmer, and the R-SCALE read-spike mapping.

---

## 1. The Mental Model

The cache exists for one reason: live market data arrives from rate-limited, sometimes-paid third-party
APIs. Fetching them on every user request would (a) be slow, (b) blow free-tier quotas in minutes,
and (c) rack up LLM spend for AI-backed panels like Market Summary. The solution is the
**"print the flyer once, hand out copies"** pattern from R-SCALE §C:

1. A background job (the warmer) fetches fresh data and writes it to cache.
2. Every user request reads from cache — fast (~ms), no upstream call.
3. When the cache value ages past its soft TTL, the next request is served the stale copy
   *immediately* while a background refresh runs concurrently.
4. Only a truly-cold key (never populated, or evicted) blocks on the upstream fetch — and the warmer
   is designed to keep that from happening.

Upstash Redis is the shared cache across all Vercel serverless instances. The in-memory fallback is
per-instance and cold-start-wiped — acceptable for local `bun --hot` dev, not for production.

---

## 2. `cache.ts` Deep Dive

Full file: `backend/lib/cache.ts`

### 2.1 Types

```typescript
// backend/lib/cache.ts:25-26
type Entry<T> = { data: T; fetchedAt: number };
export type CacheResult<T> = { data: T; fetchedAt: number; stale: boolean; hit: boolean };
```

`Entry<T>` is the raw stored shape. `CacheResult<T>` is the public return type with diagnostics:

| Field | Meaning |
|-------|---------|
| `data` | The cached payload. |
| `fetchedAt` | Unix ms timestamp when the upstream fetch completed. Pass to the HTTP response so clients can display data age. |
| `stale` | `true` when the value was served past its soft TTL (background refresh triggered). |
| `hit` | `true` when any cached value existed (fresh or stale). `false` only on the cold path. |

Routes surface `fetchedAt` and `stale` directly to the frontend JSON so UI components can badge stale
data. See `backend/finance/routes.ts:34`.

### 2.2 Backend Switch: Upstash vs. Memory

```typescript
// backend/lib/cache.ts:28-36
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

export const cacheBackend: "upstash" | "memory" = redis ? "upstash" : "memory";
```

`backend/lib/cache.ts:28-34` — The `Redis` instance is created only when **both** env vars are
present. If either is absent, `redis` is `null` and the entire system falls back to the in-memory
`Map`. The `cacheBackend` export lets callers (health checks, tests) observe which backend is active
without re-checking env vars.

**Why REST and not TCP?** Vercel serverless functions are stateless — each invocation may land on a
fresh process. A TCP connection (ioredis, node-redis) established during a cold start is discarded
when the function freezes after response. `@upstash/redis` issues one HTTP request per command:
no persistent socket, no connection-state, works fine under Vercel's serverless model.

Set before deployment:

```
UPSTASH_REDIS_REST_URL=https://<id>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<token>
```

Without these, the cache works locally but is **per-instance, per-process, and cold-start-wiped** —
functionally correct for development, wrong for production (each Vercel replica has its own cold Map).

### 2.3 Bounded In-Memory Fallback + `memSet`

```typescript
// backend/lib/cache.ts:42-52
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
```

`backend/lib/cache.ts:42-52`

Finance routes build cache keys from user-chosen symbol sets (e.g., `finance:quote:<symbols>`), so
the keyspace is effectively unbounded at runtime. Without a cap, the Map grows until the process OOMs
on a long-lived dev server or a warm Vercel instance.

`memSet` implements **LRU-by-insertion-order** using Map's insertion-order iteration guarantee:

1. `mem.delete(key)` — remove the key from its current position (if present) before re-inserting.
2. `mem.set(key, entry)` — re-insert at the tail (most-recently-used end).
3. Trim loop — while `mem.size > 500`, pop the head (oldest-inserted, `mem.keys().next()`).

The eviction is oldest-inserted — which approximates LRU when each write also deletes first. Entries
are **never evicted for staleness** from the mem fallback; TTL freshness is checked at read time in
`getOrRefresh`. Stale entries remain in the Map past their soft TTL as intentional fallback material
(same philosophy as the Upstash hard-TTL).

### 2.4 `HARD_TTL_MULTIPLIER = 12`

```typescript
// backend/lib/cache.ts:54
const HARD_TTL_MULTIPLIER = 12;
```

```typescript
// backend/lib/cache.ts:66-68
if (redis) {
  await redis.set(key, entry, { ex: Math.max(1, Math.floor(ttlSeconds * HARD_TTL_MULTIPLIER)) });
}
```

`backend/lib/cache.ts:54` and `backend/lib/cache.ts:65-71`

The **soft TTL** (`ttlSeconds`) is the freshness window: after it lapses, `getOrRefresh` considers
the value stale and triggers a background refresh. The **hard TTL** (`ttlSeconds × 12`) is the Redis
key expiry: after it lapses, Redis deletes the key entirely.

The gap exists for **graceful degradation**:

| Scenario | Upstash behavior |
|----------|-----------------|
| Upstream API returns fresh data before hard-TTL | Normal; key refreshed in Upstash, hard-TTL clock resets on each write. |
| Upstream API goes down for up to ~11 × soft-TTL | Key still exists in Upstash; stale-while-revalidate serves it while refresh retries fail (with a `console.warn`). No 500. |
| Upstream down for longer than hard-TTL | Key deleted; next request cold-misses; `getOrRefresh` rethrows because nothing is cached. The warmer would also fail during this window. |

For `crypto` (soft TTL = 30 s) the hard TTL is 360 s (6 min). For `summary` (soft TTL = 900 s) the
hard TTL is 10 800 s (3 h). `Math.max(1, ...)` ensures the TTL is never zero, which would cause Redis
to treat the key as persistent.

### 2.5 `readEntry` and `writeEntry`

```typescript
// backend/lib/cache.ts:60-71
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
```

`backend/lib/cache.ts:60-71`

`readEntry` is the single read seam. `@upstash/redis` automatically JSON-parses the stored string into
the typed `Entry<T>` — no manual `JSON.parse`. The `?? null` normalises a Redis miss (returns
`undefined`) and a Map miss to `null`, keeping the calling code branch-free.

`writeEntry` is the single write seam. The Upstash path stores the object as JSON with `{ ex }` for
the hard-TTL expiry. The memory path calls `memSet` (which enforces the cap and LRU order).

Neither function is exported — they are implementation details of `doRefresh`.

### 2.6 The Inflight De-Dupe Map (Thundering-Herd Guard)

```typescript
// backend/lib/cache.ts:58
const inflight = new Map<string, Promise<unknown>>();
```

```typescript
// backend/lib/cache.ts:75-91
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
```

`backend/lib/cache.ts:58` and `backend/lib/cache.ts:75-91`

**The problem without de-dupe:** Imagine a 30-second TTL on `finance:crypto`. At second 30, the value
goes stale. The next 50 concurrent requests all find a stale value, all trigger a background refresh,
and 50 calls hit CoinGecko simultaneously — which either blows the rate limit or returns the same
data 50 times.

**How `inflight` fixes it:** `doRefresh` checks whether a Promise for `key` already exists in
`inflight`. If yes, return the *same* Promise — all 50 callers wait on (or ignore, in the SWR path)
the single upstream call. If no, create a new Promise, store it, and schedule cleanup (`inflight.delete`)
on both resolution and rejection so the map never leaks.

`fetchedAt = startedAt` (not end time) is intentional: it marks when the upstream call began, so a
slow fetch that takes 5 seconds still records the timestamp from when work started, keeping TTL
accounting consistent.

`doRefresh` is private. It is called in two contexts:
1. **Stale-while-revalidate path** in `getOrRefresh` — call is fired-and-forgotten (`void`).
2. **Cold path** in `getOrRefresh` — call is awaited.
3. **`forceRefresh`** — call is awaited by the cron warmer.

---

## 3. `getOrRefresh` — The Three Paths

```typescript
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

  // STALE-WHILE-REVALIDATE
  if (existing) {
    void doRefresh(key, ttlSeconds, fetcher).catch((err) =>
      console.warn(
        `[cache] background refresh failed for "${key}", keeping stale:`,
        err instanceof Error ? err.message : err,
      ),
    );
    return { data: existing.data, fetchedAt: existing.fetchedAt, stale: true, hit: true };
  }

  // Cold → block once.
  const data = await doRefresh(key, ttlSeconds, fetcher);
  return { data, fetchedAt: now, stale: false, hit: false };
}
```

`backend/lib/cache.ts:93-124`

### Path 1 — Fresh HIT (`stale: false, hit: true`)

```
age = now - existing.fetchedAt < ttlSeconds * 1000
```

The stored value is younger than the soft TTL. Return it directly; zero upstream calls. The fast path
for the vast majority of requests when the warmer is running.

### Path 2 — Stale-While-Revalidate (`stale: true, hit: true`)

```
existing exists, but age ≥ ttlSeconds * 1000
```

The stale value is returned **immediately** (latency: one `readEntry` call ≈ ms for Upstash REST, sub-
ms for Map). Then `doRefresh` is fired as a fire-and-forget background task (`void`). The catch
handler logs the failure without propagating it — the caller already has a response.

This is the **key latency win**. Without SWR, the first request after a TTL lapse would block on a
slow upstream (CoinGecko REST, Twelve Data, or an LLM call). With SWR:
- Request N (stale): served in ms from cache.
- Background: single upstream call via `doRefresh` (de-duped by `inflight`).
- Request N+1 (after refresh): served fresh.

The only user who pays the wait is the one who requested the *very first population*, and the warmer
is designed to prevent that from being a real user.

Failure handling: if `doRefresh` rejects (upstream down), the `.catch` logs a warning and the stale
value remains in cache until the hard-TTL expires. Any subsequent call will again try a background
refresh, but the stale value continues to be served. This is the intended **graceful degradation**
posture — never 500 a read you've served before.

### Path 3 — Cold Miss (`stale: false, hit: false`)

```
existing is null
```

`doRefresh` is awaited. The caller blocks until the upstream fetch completes and the result is written
to cache. This is the only path with upstream-fetch latency in the hot user path.

The warmer (`forceRefresh` on startup + cron) exists precisely to avoid this path for production users.
In practice, a real user hits path 3 only on:
- First-ever server boot before the warmer completes.
- A cache key that the warmer does not cover (e.g., a user-specific key).
- A Upstash eviction under memory pressure.

---

## 4. `forceRefresh` — The Cron / Startup Warmer

```typescript
// backend/lib/cache.ts:128-134
export async function forceRefresh<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  return doRefresh(key, ttlSeconds, fetcher);
}
```

`backend/lib/cache.ts:128-134`

`forceRefresh` bypasses the freshness check and **awaits** `doRefresh` directly. It is the public API
for the startup warmer and cron job — they need to *actually populate* the cache, not just read
whatever is there.

`getOrRefresh` uses `doRefresh` internally too, but only the cold path awaits it (path 3 above). The
SWR path fires it without awaiting. `forceRefresh` makes the await explicit and the intent clear.

### The Warmer in `backend/finance/routes.ts`

```typescript
// backend/finance/routes.ts:99-113
const WARM_JOBS: [string, number, () => Promise<unknown>][] = [
  ["finance:indices",    TTL.indices,    () => fetchIndices("us")],
  ["finance:stocks",     TTL.stocks,     () => fetchStocks("us")],
  ["finance:sectors",    TTL.sectors,    () => fetchSectors("us")],
  ["finance:crypto",     TTL.crypto,     fetchCrypto],
  ["finance:predictions",TTL.predictions,fetchPredictions],
  ["finance:summary",    TTL.summary,    () => fetchMarketSummary("us")],
  ["finance:research",   TTL.research,   fetchAllResearch],
  ["finance:discover",   TTL.discover,   () => fetchDiscover("us")],
  ["finance:in:indices", TTL.indices,    () => fetchIndices("in")],
  ["finance:in:stocks",  TTL.stocks,     () => fetchStocks("in")],
  ["finance:in:sectors", TTL.sectors,    () => fetchSectors("in")],
  ["finance:in:summary", TTL.summary,    () => fetchMarketSummary("in")],
  ["finance:in:discover",TTL.discover,   () => fetchDiscover("in")],
];

export async function warmFinanceCache() {
  const results = await Promise.allSettled(
    WARM_JOBS.map(([key, ttl, fn]) => forceRefresh(key, ttl, fn))
  );
  return WARM_JOBS.map(([key], i) => ({ key, ok: results[i]!.status === "fulfilled" }));
}
```

`backend/finance/routes.ts:99-119`

`warmFinanceCache` runs 13 `forceRefresh` calls in parallel via `Promise.allSettled`. `allSettled`
(not `Promise.all`) ensures one failing upstream does not abort the rest of the warm jobs. The return
value is an array of `{ key, ok }` — surfaced by the cron route for observability.

The cron endpoint (`POST /finance/cron/refresh`, `backend/finance/routes.ts:124-133`) is guarded by
`CRON_SECRET`. It must be wired to an external scheduler (e.g., cron-job.org) at an interval no
longer than the shortest TTL in `WARM_JOBS` — currently 30 s for `finance:crypto`. A practical cron
cadence is 25 s for crypto; the other keys with longer TTLs will simply be refreshed more often than
needed (harmless, and costs only the API call).

**Without the warmer**, the first user after a TTL lapse hits path 3 (cold block). With the warmer,
that user never arrives: the warmer repopulates before the soft TTL expires.

---

## 5. `ratelimit.ts` Deep Dive

Full file: `backend/lib/ratelimit.ts`

### 5.1 Why Rate Limit When We Already Cache?

The cache shields **upstream vendors** from normal user traffic. The rate limiter shields **our own
endpoints and Upstash quota** from:
- Buggy frontend clients hitting `/finance/*` in a loop.
- Scrapers or automated crawlers.
- Abusive users burning Vercel function invocations and Upstash command quota.
- AI-backed panels (Summary, Research) where a non-cached call means LLM spend.

Both layers are necessary. They operate at different scopes: cache = per-data-series, limiter = per
client-IP.

### 5.2 The Upstash Sliding-Window Limiter

```typescript
// backend/lib/ratelimit.ts:17-34
const LIMIT = 60;       // requests…
const WINDOW_SEC = 60;  // …per minute, per client IP

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: ..., token: ... })
    : null;

const upstashLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(LIMIT, `${WINDOW_SEC} s`),
      prefix: "rl:finance",
    })
  : null;
```

`backend/lib/ratelimit.ts:17-34`

- **60 requests per 60-second window, per IP.** Generous enough for a legitimately fast user; strict
  enough to catch loops and scrapers.
- **`Ratelimit.slidingWindow`** — unlike a fixed window (which can allow 2× the limit across a
  boundary), a sliding window counts requests in the trailing 60 seconds at any point in time. More
  accurate.
- **`prefix: "rl:finance"`** — all limiter keys in Upstash are namespaced under `rl:finance:*`,
  keeping them separate from the cache keys (`finance:*`).
- The `Redis` instance is the same env-var check as `cache.ts` — both modules independently decide
  whether Upstash is configured.

### 5.3 In-Memory Fallback

```typescript
// backend/lib/ratelimit.ts:37-44
const hits = new Map<string, number[]>();
function memAllow(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_SEC * 1000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length <= LIMIT;
}
```

`backend/lib/ratelimit.ts:37-44`

Per-IP sliding window implemented as an array of timestamps, filtered on each check to only the
trailing 60 seconds. This is per-instance — on Vercel, each serverless replica has its own counter.
A distributed scraper can spread across instances and evade the per-instance limit. Upstash solves
this (all instances share one Redis); the memory fallback is acceptable for local dev.

The `hits` Map is unbounded. Unlike `cache.ts` (where the keyspace is open-ended symbol sets), the
limiter keyspace is just IPs — bounded in practice and recycled by filter-on-read. Low risk, but add
a cap if the memory fallback ever runs in a long-lived production process.

### 5.4 `clientIp`

```typescript
// backend/lib/ratelimit.ts:54-58
function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}
```

`backend/lib/ratelimit.ts:54-58`

Behind Vercel's proxy, `req.socket.remoteAddress` is always the proxy IP. The real client IP is in
`x-forwarded-for`. The header may be a comma-separated list (proxy chain) — take the first value.

### 5.5 The Fail-Open Posture

```typescript
// backend/lib/ratelimit.ts:61-70
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
```

`backend/lib/ratelimit.ts:61-70`

The `try/catch` around `allowRequest` is critical. If Upstash is temporarily unreachable (network
blip, Upstash maintenance), the limiter check throws. The catch **logs and allows** — `next()` is
called and the request proceeds.

This is the correct posture because the limiter is a **seatbelt, not a correctness gate**. A limiter
outage that silently allows all traffic is far better than one that silently blocks all traffic and
takes down reads. If the Upstash REST call fails, users get service (albeit unthrottled briefly);
the site stays up; the warning appears in logs for investigation.

The 429 response (`{ error: "Too many requests — slow down." }`) is the only case where the middleware
terminates the request — a Vercel-serialisable JSON response, no body streaming needed.

---

## 6. How Finance Routes Consume the Cache

`backend/finance/routes.ts` is the primary consumer of the cache and limiter.

### 6.1 TTLs Per Series

```typescript
// backend/finance/routes.ts:18
const TTL = {
  crypto: 30,
  predictions: 120,
  indices: 300,
  stocks: 300,
  sectors: 300,
  summary: 900,
  research: 21_600,
  discover: 600,
};
```

`backend/finance/routes.ts:18`

TTL choices reflect both data velocity and vendor budget:
- `crypto: 30 s` — crypto prices move fast; users expect near-real-time.
- `indices/stocks/sectors: 300 s` — equity snapshots; 5-minute refresh stays well under Twelve Data's
  free 800-calls/day limit. See the **finance-markets** skill for full vendor-budget accounting.
- `summary: 900 s` — LLM-backed; generating once per 15 minutes costs ~one API call instead of one
  per user.
- `research: 21 600 s` — multi-category LLM output; 6-hour refresh is enough for analytical content.
- `discover: 600 s` — news carousel; 10 minutes balances freshness against Finnhub/Tavily quotas.

### 6.2 `readRoute` and `marketReadRoute`

```typescript
// backend/finance/routes.ts:30-60
function readRoute(key, ttl, fetcher): RequestHandler {
  return async (_req, res) => {
    try {
      const r = await getOrRefresh(key, ttl, fetcher);
      res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
    } catch (e) {
      res.status(502).json({ error: `${key} upstream failed` });
    }
  };
}

function marketReadRoute(name, ttl, fetcher): RequestHandler {
  return async (req, res) => {
    const market: Market = req.query.market === "in" ? "in" : "us";
    const key = market === "in" ? `finance:in:${name}` : `finance:${name}`;
    try {
      const r = await getOrRefresh(key, ttl, () => fetcher(market));
      res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
    } catch (e) {
      res.status(502).json({ error: `${key} upstream failed` });
    }
  };
}
```

`backend/finance/routes.ts:30-60`

Pattern: every route passes through `financeRateLimit` first, then calls `getOrRefresh`. The
`CacheResult` fields `fetchedAt` and `stale` are spread into the response so the React frontend can
display them.

`marketReadRoute` dynamically constructs the cache key from the `?market` query parameter —
`finance:indices` for US, `finance:in:indices` for India. The same warmer covers both keys.

The `502` on `getOrRefresh` throw means there was nothing in cache AND the upstream failed — the
"nothing to serve" scenario. This is the only path that returns an error; stale hits always succeed.

### 6.3 `/finance/home` — Parallel Multi-Key Fetch

```typescript
// backend/finance/routes.ts:77-92
financeRouter.get("/home", financeRateLimit, async (_req, res) => {
  const [indices, stocks, crypto, predictions] = await Promise.allSettled([
    getOrRefresh(CACHE_KEYS.indices, TTL.indices, fetchIndices),
    getOrRefresh(CACHE_KEYS.stocks, TTL.stocks, fetchStocks),
    getOrRefresh(CACHE_KEYS.crypto, TTL.crypto, fetchCrypto),
    getOrRefresh(CACHE_KEYS.predictions, TTL.predictions, fetchPredictions),
  ]);
  // ...
});
```

`backend/finance/routes.ts:77-92`

The landing page aggregates four series in one request. `Promise.allSettled` (not `.all`) ensures one
failing series does not blank the whole page. Each `getOrRefresh` call is independent — if each key
is warm, this is four parallel Upstash REST GETs ≈ sub-10ms total. If any key is stale, four
background refreshes are fired concurrently (collapsed by `inflight` if they share the same key, which
they don't here). If any key is cold, it blocks.

---

## 7. The R-SCALE Read-Spike Mapping

This section maps the cache and rate-limit design against R-SCALE §C (read-spike resilience).

### §C-11: What Is Cached and Where?

| Layer | What | Where | Cost per read |
|-------|------|-------|---------------|
| Upstash Redis | All finance series (crypto, stocks, indices, sectors, summary, research, discover) per-market | Shared across all Vercel instances | One HTTP GET per `getOrRefresh` — ~2–5ms |
| In-memory Map | Same, per-instance fallback | Per-process, cold-start-wiped | Sub-ms |
| Upstream APIs | Source of truth | Third-party (Twelve Data, CoinGecko, Finnhub, Tavily, LLM) | 100ms–5s, rate-limited, sometimes paid |

A warmed Upstash key: every user gets data from Redis, zero upstream calls. A Vercel cold-start evicts
no Redis keys (they're in Upstash, not process memory) — cold-start latency is the Upstash GET only.

### §C-12: Can Read Capacity Scale Without Touching Write Capacity?

Yes. Adding Vercel replicas adds read capacity (more function invocations) without adding Upstash
write commands — each replica reads from the same Upstash instance, but only one background `doRefresh`
per key writes at a time (de-duped by `inflight` within a process; multiple processes may each
attempt a refresh, but they write the same data). Upstash scales horizontally on their end.

### §C-13: What Degrades Gracefully Under Overload?

| Component | Overload scenario | Degradation |
|-----------|------------------|-------------|
| Upstream API throttles | Rate limit hit at Twelve Data / CoinGecko | `doRefresh` rejects → stale value kept → `[cache] background refresh failed` warning; users see last-good data. |
| Upstash unreachable | Network blip | Cache `readEntry` returns `null` → cold path → upstream called directly. Rate limiter fails open (see §5.5). |
| Vercel function saturated (spike) | Too many concurrent requests | `inflight` collapses concurrent refreshes of the same key to one upstream call. Rate limiter 429s at 60 req/min/IP to slow abusive clients. |
| LLM quota exhausted (summary/research) | OpenAI / gateway limit | `doRefresh` rejects → stale copy served for up to `soft_TTL × 11` extra seconds (the hard-TTL window). |

What does **not** degrade gracefully: if a key is both cold (never populated by warmer) AND the
upstream is down, `getOrRefresh` rethrows and the route returns 502. This is the correct failure for
an empty cache — there is no data to show. The warmer running before users arrive prevents this.

### Tier Assessment

| Tier | Users | Behavior |
|------|-------|----------|
| 1× | Demo / dev (1–100 users) | In-memory Map fallback acceptable. Stale-while-revalidate and inflight de-dupe still active. |
| 100× | Thousands of concurrent users | Upstash required. All reads served from shared Redis; one background refresh per key per TTL window regardless of concurrent requests. Rate limiter (shared across replicas via Upstash) prevents abuse. |
| 10 000× | Lakhs of concurrent users, spike traffic | Add a CDN layer (Vercel Edge Cache or Cloudflare) in front of `/finance/*` for fully public endpoints. The Upstash read path is fast but still one HTTP round-trip per request; a CDN serves from an edge POP with zero origin calls for the freshness window. Jitter the cron schedule to avoid thundering-herd at TTL boundaries. Separate the LLM-backed keys (summary, research) behind a longer CDN TTL or a dedicated edge route. |

---

## 8. Key Naming Convention

All production finance cache keys follow a two-segment pattern:

```
finance:<series>           # US default
finance:in:<series>        # India market
```

Examples from `backend/finance/routes.ts:21-27`:
```
finance:crypto
finance:predictions
finance:indices
finance:stocks
finance:research
finance:in:indices
finance:in:summary
```

Rate-limit keys follow a separate namespace (set by `prefix: "rl:finance"` in `ratelimit.ts:32`):
```
rl:finance:<ip>
```

This namespacing means `SCAN finance:*` returns cache keys only; `SCAN rl:finance:*` returns limiter
keys only. They never collide.

When adding a new cached series:
1. Define the key string in `CACHE_KEYS` or construct it inline in the route handler.
2. Choose a TTL that fits the data velocity and the upstream vendor's call budget.
3. Add the key to `WARM_JOBS` in `routes.ts` so the warmer covers it.
4. Set the hard-TTL fallback window in mind: `ttlSeconds × 12` determines how long a stale value
   survives an upstream outage.

---

## 9. Adding a New Cached Route (Checklist)

```typescript
// 1. Add to TTL map in routes.ts
const TTL = { ..., myPanel: 120 };

// 2. Add a cache key
const CACHE_KEYS = { ..., myPanel: "finance:my-panel" };

// 3. Wire the route with financeRateLimit + readRoute (or marketReadRoute)
financeRouter.get(
  "/my-panel",
  financeRateLimit,
  readRoute(CACHE_KEYS.myPanel, TTL.myPanel, fetchMyPanel),
);

// 4. Add to WARM_JOBS
const WARM_JOBS: [...] = [
  // ... existing jobs ...
  ["finance:my-panel", TTL.myPanel, fetchMyPanel],
];
```

Checklist:
- [ ] TTL reflects data velocity and upstream vendor budget (cross-check with **finance-markets** skill).
- [ ] `HARD_TTL_MULTIPLIER × TTL` gives a stale-fallback window you are comfortable with.
- [ ] Key added to `WARM_JOBS` — no user should hit path 3 in production.
- [ ] Route uses `financeRateLimit` middleware.
- [ ] Route spreads `fetchedAt` and `stale` into the response for frontend display.
- [ ] Response returns 502 (not 500) on upstream failure with a descriptive message.
- [ ] If the series is market-aware (US/India), use `marketReadRoute` and add both `finance:<name>`
  and `finance:in:<name>` entries to `WARM_JOBS`.

---

## See Also

| Reference | When to open it |
|-----------|----------------|
| `patterns-upstash-rest-client.md` (this skill) | `@upstash/redis` REST client details, pipelining, command-quota model. |
| `patterns-caching-strategies.md` (this skill) | Cache-aside, TTL+jitter, stampede protection, invalidation theory. |
| `patterns-locks-and-rate-limiting.md` (this skill) | Atomic counters, `SET NX PX` locks, idempotency keys, R-SCALE §D. |
| `patterns-streams-and-pubsub.md` (this skill) | Streams, Pub/Sub, and why live ticks go through Supabase Realtime. |
| `patterns-keys-ttl-and-eviction.md` (this skill) | Key naming discipline, TTL jitter, unbounded keyspace + `MEM_MAX_ENTRIES`. |
| **finance-markets** skill | Vendor budget per series, TTL budget rationale, the per-minute API limits that drive TTL choices. |
| **backend-testing** skill | How to mock Upstash (`prisma-fake.ts` / `supabase-fake.ts` patterns for Redis), test the cache paths. |
| **prisma** skill | Supabase Postgres as the durable source of truth; Redis is ephemeral derived. |
| **supabase** skill | Supabase Realtime for live price fan-out — the path that does NOT go through Redis Pub/Sub. |
| **rag-retrieval** skill | The semantic cache (pgvector, cosine `<=>`) — a different cache layer entirely in Postgres. |
| **lumina-frontend** skill | Frontend consumption of `fetchedAt` and `stale` to badge stale data in the UI. |
| **connectors-oauth** skill | OAuth token vault — stored in Postgres, not Redis (different durability requirement). |
