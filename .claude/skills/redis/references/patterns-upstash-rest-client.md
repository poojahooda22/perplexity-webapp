# Upstash Redis REST Client — Patterns and Constraints

> Generic reference for `@upstash/redis` on Vercel serverless (and any stateless edge runtime). Covers the REST model, env wiring, command API, pipeline batching, rate-limiting with `@upstash/ratelimit`, billing mechanics, and the hard constraints that distinguish this client from `ioredis`/`node-redis`. Lumina's live usage in `backend/lib/cache.ts` and `backend/lib/ratelimit.ts` is used as the worked example throughout.

---

## 1. The REST model — why HTTPS, not TCP

Every Redis client library that connects over a raw TCP socket (`ioredis`, `node-redis`) keeps a **persistent connection** open: it authenticates once, then multiplexes commands over the same socket with near-zero per-command overhead. That design is incompatible with serverless functions because:

- A Vercel function instance boots cold on every scale-out event and is frozen (or destroyed) between requests. There is no process alive long enough to hold a socket open across requests.
- Vercel's network sandbox blocks outbound long-lived TCP connections on the functions runtime. There is nowhere for the connection to land.

`@upstash/redis` solves this by re-implementing every Redis command as an **HTTPS fetch** against Upstash's REST gateway:

```
POST https://<your-endpoint>.upstash.io/get/<key>
Authorization: Bearer <token>
```

Each command is a single HTTPS round-trip. The function boots, fires one (or a few pipelined) HTTPS requests, gets a response, and dies. No persistent socket is involved. This is the **only** Redis integration that works on Vercel serverless functions without hacks.

The trade-offs relative to a TCP client:

| Property | `ioredis` / `node-redis` (TCP) | `@upstash/redis` (REST) |
|---|---|---|
| Works on Vercel serverless | No | Yes |
| Per-command latency | ~0.1–0.5 ms (local network) | ~5–30 ms (HTTPS round-trip) |
| Persistent SUBSCRIBE | Yes | No |
| Blocking ops (BLPOP, BRPOP) | Yes | No |
| WATCH / interactive MULTI | Yes | No (pipeline only) |
| Pipelining | Yes (native TCP) | Yes (batched HTTPS) |
| Auth per request | No (once at connect) | Yes (Bearer header) |
| Works in Cloudflare Workers / Deno Deploy | No | Yes |

For Lumina on Vercel the trade-offs are entirely in favour of Upstash: the 10–25 ms HTTPS overhead is invisible on a cache HIT compared with a 100–3000 ms LLM or market-data upstream call.

---

## 2. Env wiring and the null-when-unset fallback

```ts
// backend/lib/cache.ts:28-34
import { Redis } from "@upstash/redis";

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;
```

Two environment variables are required:

| Variable | Where to get it |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash console → database → REST API → Endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash console → database → REST API → Read/Write Token |

**The `null` fallback is intentional and important.** Both `cache.ts` (line 28–34) and `ratelimit.ts` (lines 20–26) use the same conditional: if either variable is absent, `redis` is `null` and the module degrades to an in-process fallback (a bounded `Map` for cache; a per-instance sliding-window array for rate-limiting). This means:

- `bun dev` works with zero infrastructure. No Redis, no Docker, no setup.
- A bad env var cannot crash the server on boot — the `Redis` constructor is never called.
- The in-memory fallback is **instance-local**. On Vercel, each serverless instance has its own copy; different instances do not share state. This is fine for local dev but means the cache and rate-limiter are not shared across instances in production. Always set the `UPSTASH_*` vars before deploying.

The module exports a discriminant so callers can log or alert:

```ts
// backend/lib/cache.ts:36
export const cacheBackend: "upstash" | "memory" = redis ? "upstash" : "memory";
```

### Local dev vs production env vars

```
# .env.local (gitignored)
UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...
```

For Vercel production, set these in the Vercel dashboard under **Project → Settings → Environment Variables**. The `@upstash/redis` SDK also auto-reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` by convention — matching the exact names means no custom config is needed.

---

## 3. get / set with JSON auto-parse; TTL options

The `@upstash/redis` client automatically serialises outgoing values to JSON and deserialises incoming values from JSON. You do not call `JSON.stringify` / `JSON.parse` yourself.

```ts
// Write a typed entry with a TTL
type Entry<T> = { data: T; fetchedAt: number };

await redis.set("finance:quote:AAPL", { data: quoteObject, fetchedAt: Date.now() }, { ex: 300 });
// ex: 300 → expires in 300 seconds (5 minutes)

// Read it back — automatically deserialised to Entry<QuoteData>
const entry = await redis.get<Entry<QuoteData>>("finance:quote:AAPL");
// entry is null if key absent, or Entry<QuoteData> if present
```

This is exactly what Lumina does in `backend/lib/cache.ts`:

```ts
// cache.ts:61
async function readEntry<T>(key: string): Promise<Entry<T> | null> {
  if (redis) return (await redis.get<Entry<T>>(key)) ?? null; // Upstash auto-parses JSON
  return (mem.get(key) as Entry<T> | undefined) ?? null;
}

// cache.ts:66-68
async function writeEntry<T>(key: string, entry: Entry<T>, ttlSeconds: number): Promise<void> {
  if (redis) {
    await redis.set(key, entry, { ex: Math.max(1, Math.floor(ttlSeconds * HARD_TTL_MULTIPLIER)) });
  }
  // ...
}
```

### TTL option reference

| Option | Unit | Example |
|---|---|---|
| `ex` | seconds | `{ ex: 300 }` — 5 minutes |
| `px` | milliseconds | `{ px: 300_000 }` — 5 minutes |
| `exat` | Unix timestamp (seconds) | `{ exat: Math.floor(Date.now()/1000) + 300 }` |
| `keepttl` | boolean | `{ keepttl: true }` — preserve existing TTL on update |
| _(none)_ | — | Key never expires |

Always set a TTL on cached values. Keys without TTLs accumulate forever and eventually fill the Upstash database.

### The HARD_TTL_MULTIPLIER pattern

Lumina stores entries with a **hard TTL** that is a multiple of the **soft TTL** the application logic checks:

```ts
// cache.ts:54
const HARD_TTL_MULTIPLIER = 12;

// cache.ts:67
await redis.set(key, entry, { ex: Math.max(1, Math.floor(ttlSeconds * HARD_TTL_MULTIPLIER)) });
```

If the soft TTL is 5 minutes (`ttlSeconds = 300`), the hard Redis TTL is set to 60 minutes (`300 × 12 = 3600`). The application layer checks `fetchedAt` age against the soft TTL; the Redis layer only evicts the entry after the much-longer hard TTL. This means a stale-but-present value can be **served as a fallback** during upstream outages — Redis still has it, even though it is past the soft freshness deadline. Without this pattern, a Redis eviction during an upstream outage produces a cold miss and propagates the error to the caller.

### Common commands available over the REST interface

The full `@upstash/redis` command surface covers nearly all non-blocking Redis commands:

```ts
// Strings
await redis.get<T>(key)
await redis.set(key, value, { ex })
await redis.del(key)
await redis.exists(key)
await redis.incr(key)
await redis.incrby(key, n)
await redis.expire(key, seconds)
await redis.ttl(key)
await redis.mget<[A, B]>(keyA, keyB)

// Hashes
await redis.hset(key, { field: value })
await redis.hget<T>(key, field)
await redis.hgetall<Record<string,T>>(key)
await redis.hdel(key, field)

// Lists
await redis.lpush(key, value)
await redis.rpush(key, value)
await redis.lrange<T>(key, start, stop)
await redis.llen(key)

// Sets
await redis.sadd(key, member)
await redis.sismember(key, member)
await redis.smembers<T>(key)

// Sorted sets
await redis.zadd(key, { score, member })
await redis.zrange<T>(key, start, stop, { rev: true, byscore: true })
await redis.zscore(key, member)

// Scan (for key enumeration — use sparingly in production)
await redis.scan(cursor, { match: "rl:finance:*", count: 100 })
```

Commands **not available** over the REST interface: `SUBSCRIBE`, `PSUBSCRIBE`, `BLPOP`, `BRPOP`, `WAIT`, `MONITOR`, `DEBUG`. These require persistent connections (see section 7).

---

## 4. pipeline() and multi() over REST — batching to reduce round-trips

### pipeline()

A pipeline sends multiple commands in a single HTTPS request and receives all responses in one body. This is the primary way to reduce round-trip overhead when you need several commands together.

```ts
const pipe = redis.pipeline();
pipe.get("finance:quote:AAPL");
pipe.get("finance:quote:MSFT");
pipe.get("finance:quote:GOOGL");

const [aapl, msft, googl] = await pipe.exec<[Entry<Quote>|null, Entry<Quote>|null, Entry<Quote>|null]>();
```

Pipeline commands are executed **sequentially on the server** but sent and received in one HTTP call. They are **not atomic** — a server error on command 2 does not roll back command 1. If one command fails, the others still execute and you receive a mix of results and errors.

### multi() (atomic block)

`multi()` wraps commands in a Redis `MULTI`/`EXEC` transaction: all commands execute atomically, or none do (on syntax error). The interface is the same as pipeline but the semantics differ.

```ts
const tx = redis.multi();
tx.decrby("stock:seats:42", 1);
tx.set("booking:xyz", { userId: "u1", seatId: 42 }, { ex: 300 });

const [newQty, setResult] = await tx.exec<[number, string]>();
```

**Limitation on serverless:** The Redis `WATCH`/`MULTI`/`EXEC` optimistic concurrency pattern (check-and-set) requires holding a connection between `WATCH` and `EXEC`. Over REST, each request is independent — you cannot hold a `WATCH` across HTTP calls. If you need optimistic concurrency, use a Lua script (`redis.eval`) which executes atomically on the server in one round-trip.

### When to pipeline vs separate calls

| Scenario | Use |
|---|---|
| Fetch 3 independent cache keys | `pipeline()` |
| Atomic decrement + conditional set | `multi()` |
| Fire-and-forget writes | Separate `await` or `pipeline()` |
| Conditional set depending on a fetched value | Lua script via `redis.eval()` |

---

## 5. @upstash/ratelimit — sliding-window rate limiting on serverless

`@upstash/ratelimit` is a companion library built on `@upstash/redis`. It implements sliding-window, fixed-window, and token-bucket algorithms using Upstash as shared state, making rate-limiting **cross-instance** on serverless — something that an in-memory solution cannot do.

Lumina's `backend/lib/ratelimit.ts` gates the public Finance read endpoints:

```ts
// ratelimit.ts:28-34
import { Ratelimit } from "@upstash/ratelimit";

const upstashLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(LIMIT, `${WINDOW_SEC} s`),
      prefix: "rl:finance",
    })
  : null;
```

- `LIMIT = 60`, `WINDOW_SEC = 60` (lines 17–18): 60 requests per minute per client IP.
- `prefix: "rl:finance"` namespaces the rate-limit keys so they do not collide with cache keys or other rate-limit domains. The Upstash console will show keys like `rl:finance:<ip>`.
- The result has a `success` boolean (and `remaining`, `reset` fields you can forward as response headers if desired).

Usage in the Express middleware:

```ts
// ratelimit.ts:46-51
export async function allowRequest(key: string): Promise<boolean> {
  if (upstashLimiter) {
    const { success } = await upstashLimiter.limit(key);
    return success;
  }
  return memAllow(key);  // in-memory fallback
}
```

The middleware (lines 61–70) applies it per client IP and **fails open** on limiter error — a Redis/network outage must not block legitimate reads:

```ts
// ratelimit.ts:61-70
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

### Sliding window vs fixed window

| Algorithm | `Ratelimit.*` factory | Behaviour |
|---|---|---|
| Fixed window | `fixedWindow(N, "60 s")` | Resets quota at wall-clock boundary; vulnerable to burst at boundary |
| Sliding window | `slidingWindow(N, "60 s")` | Rolling window from each request's timestamp; smooths bursts — preferred |
| Token bucket | `tokenBucket(N, "1 s", burst)` | Allows short bursts up to bucket size; for bursty but throttled flows |

For most API gateway use cases, `slidingWindow` is the right default.

### Additional rate-limit metadata

```ts
const { success, limit, remaining, reset, pending } = await upstashLimiter.limit(ip);
res.setHeader("X-RateLimit-Limit", limit);
res.setHeader("X-RateLimit-Remaining", remaining);
res.setHeader("X-RateLimit-Reset", reset); // Unix ms
```

`pending` is a `Promise` that must be awaited in environments (e.g. Cloudflare Workers) where the runtime kills the context on response — await it before returning if you use analytics tracking.

---

## 6. Command-quota billing — the cost model

Upstash charges per **REST command**, not per connection or per data volume. Every call to `redis.get()`, `redis.set()`, `redis.incr()`, etc. is one billed command. Pipeline commands within a single HTTP request are still billed individually (3 commands in a pipeline = 3 commands billed). The free tier (as of 2025) includes 10,000 commands/day.

This billing model has direct architectural implications.

### A cache HIT must cost zero upstream Redis calls

If a cache entry is already in the application layer (the in-memory inflight deduplication map, or a request-scoped variable), serving it should not generate another `redis.get()`. In Lumina's `getOrRefresh`, a single `redis.get()` at the top of the function covers all three exit paths (fresh, stale-while-revalidate, cold miss):

```ts
// cache.ts:99-103
const existing = await readEntry<T>(key);  // ONE get() — billed once

if (existing && now - existing.fetchedAt < ttlSeconds * 1000) {
  return { data: existing.data, fetchedAt: existing.fetchedAt, stale: false, hit: true };
  // HIT: no further Redis call
}
```

The stale-while-revalidate path fires a background `doRefresh` (one `redis.set()`) but returns immediately from the single `redis.get()` already executed. Total commands for a stale hit: 1 get + 1 set (background) = 2. For a fresh hit: 1 get. For a cold miss: 1 get + 1 set = 2.

### Avoid fanning a hot path into many small commands

Bad pattern — N commands for N items on every request:

```ts
// WRONG: each symbol is a separate get() — 50 symbols = 50 billed commands per request
const quotes = await Promise.all(symbols.map(s => redis.get(`quote:${s}`)));
```

Better — one pipeline call = N commands sent in one HTTP request, billed as N but with only one round-trip latency:

```ts
const pipe = redis.pipeline();
symbols.forEach(s => pipe.get(`quote:${s}`));
const quotes = await pipe.exec<(Entry<Quote>|null)[]>();
```

Best — if all symbols are fetched together anyway, store them under one composite key:

```ts
// One get, one set; cache key encodes the full symbol list
const key = `finance:quotes:${symbols.sort().join(",")}`;
await redis.get<Entry<QuoteMap>>(key);
// ... fetch all at once from the vendor ...
await redis.set(key, { data: quoteMap, fetchedAt: Date.now() }, { ex: 60 });
```

This is what Lumina does: agent-chosen symbol sets are cached under a single composite key, so a finance panel requesting AAPL+MSFT+GOOGL costs exactly 1 get and (on miss) 1 set — not 3 gets and 3 sets.

### Rate-limit command cost

Each call to `upstashLimiter.limit(key)` internally executes a Lua script against Redis — billed as **2 commands** (the script counts as 2 in Upstash's model). At 60 req/min per user across many users, rate-limit checks can dominate command usage on high-traffic endpoints. Mitigations:

1. Apply rate-limiting middleware only to endpoints that need it (Lumina gates `/finance/*`, not `/health/*` or `/ask`).
2. Cache a short-lived allow token in a request-scoped store to skip the Upstash call for burst patterns (advanced; not currently needed).
3. Consider a coarser limit on the CDN/Vercel firewall layer for truly abusive traffic so the rate-limiter is only exercised by borderline cases.

---

## 7. What differs from ioredis / node-redis

This section is about what you **cannot** do with `@upstash/redis` that you might expect from a traditional Redis client. These are not bugs — they are structural consequences of the REST model.

### No SUBSCRIBE / PSUBSCRIBE

Pub/sub requires a long-lived connection the broker can push messages into. Over REST there is no such channel. If you need real-time message fanout:

- **Lumina's solution:** the `worker/` service on Fly.io runs a traditional `ioredis` client (with persistent TCP) and handles WebSocket connections. Vercel functions publish to a Redis key or channel; the Fly worker subscribes and pushes to connected clients.
- **Alternative:** use Upstash's Kafka product (HTTP streaming), or a dedicated queue/pub-sub service (e.g. Ably, Pusher).

### No blocking operations (BLPOP, BRPOP, XREAD with BLOCK)

These commands tell the Redis server to hold the connection open until an item arrives. That is impossible over a single HTTPS round-trip. Workaround: poll with LPOP/RPOP on a short interval, or use a dedicated queue service.

### No interactive WATCH / MULTI across requests

The `WATCH key` + `MULTI` + `EXEC` optimistic concurrency pattern requires the same connection from WATCH to EXEC. Each Vercel function invocation is a separate HTTPS request — there is no way to hold a watch across calls. Use Lua scripts for atomic conditional operations:

```ts
// Atomic check-and-decrement: only decrement if stock > 0
const script = `
  local qty = tonumber(redis.call("GET", KEYS[1]))
  if qty and qty > 0 then
    return redis.call("DECRBY", KEYS[1], ARGV[1])
  else
    return -1
  end
`;
const result = await redis.eval(script, ["stock:item:42"], ["1"]);
// result >= 0 → decremented; -1 → out of stock
```

### Edge vs Node usage

`@upstash/redis` works in both environments because it uses `fetch` (available in both). The import path is the same:

```ts
import { Redis } from "@upstash/redis";          // Node.js / Bun
import { Redis } from "@upstash/redis/cloudflare"; // Cloudflare Workers (if needed)
```

On Vercel's Node.js runtime (which Lumina uses), the plain import is correct. The `@upstash/redis/cloudflare` variant uses `waitUntil` for background tasks in the Workers model — not needed on Vercel.

### Latency budget

A TCP Redis call on a co-located server: ~0.2–1 ms. An Upstash REST call from a Vercel US-East function to an Upstash US-East endpoint: typically 8–25 ms. This is invisible when:

- The result replaces a 300 ms LLM call (cache HIT).
- The result replaces a 500 ms market data API call (cache HIT).

It becomes visible if you chain multiple sequential Redis calls in a hot path. Prefer pipeline for multi-key reads. Prefer composite keys to eliminate multiple individual gets.

---

## 8. Thundering-herd guard — the inflight deduplication pattern

When a key is cold (cache empty) or stale, multiple concurrent requests can all observe the miss simultaneously and all attempt to fetch the upstream resource in parallel. For a rate-limited API like Twelve Data or an expensive LLM call, this is wasteful and potentially quota-breaking.

Lumina's `cache.ts` solves this with an in-process `inflight` map:

```ts
// cache.ts:58-91
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
  return p;
}
```

The first concurrent caller creates the promise and stores it in `inflight`. Every subsequent caller for the same key within the same serverless instance returns the **same promise** — they all await the same upstream fetch. The result is written to Redis once. When the promise settles (success or failure), it is evicted from `inflight` so the next cold-miss creates a fresh attempt.

**Cross-instance thundering herd** (multiple Vercel instances all cold at once) is not solved by the in-process map — it requires a distributed lock (e.g. `SET NX PX` pattern). Lumina's warmer (`forceRefresh` called at server startup and by the cron job) pre-populates the cache before real traffic arrives, which is the practical mitigation: instances come up warm, not cold.

```ts
// Distributed lock pattern (not currently in Lumina — for reference)
const lockKey = `lock:${key}`;
const acquired = await redis.set(lockKey, "1", { nx: true, ex: 30 }); // NX = only if not exists
if (acquired) {
  try {
    const data = await fetcher();
    await redis.set(key, { data, fetchedAt: Date.now() }, { ex: ttl * HARD_TTL_MULTIPLIER });
  } finally {
    await redis.del(lockKey);
  }
} else {
  // Another instance is fetching; poll or short-sleep and retry read
}
```

---

## 9. Stale-while-revalidate — implementation and rationale

SWR is the single most important cache pattern for a read-heavy app with periodic data. The rule is:

> If we have a value, serve it immediately. Kick off a background refresh. Never make the caller wait for the upstream fetch unless there is nothing to serve at all.

```
Timeline:
  t=0: First request, cache empty   → block on fetch → respond → store in Redis
  t=5m: Cache soft-TTL expires
  t=5m+1ms: Second request arrives   → serve STALE from Redis instantly (< 5 ms)
                                     → background fetch starts
  t=5m+300ms: Background fetch done → update Redis
  t=5m+1s: Third request arrives    → serve FRESH from Redis
```

The caller at `t=5m+1ms` saw data that was 5 minutes old. That is acceptable for stock quotes, news summaries, or academic paper metadata. It is not acceptable for "did this order succeed" or "is this seat still available" — those flows must skip the cache entirely and read from the source of truth.

In `cache.ts` lines 110–118:

```ts
if (existing) {
  // Fire background refresh — errors are caught and logged, not propagated
  void doRefresh(key, ttlSeconds, fetcher).catch((err) =>
    console.warn(
      `[cache] background refresh failed for "${key}", keeping stale:`,
      err instanceof Error ? err.message : err,
    ),
  );
  return { data: existing.data, fetchedAt: existing.fetchedAt, stale: true, hit: true };
}
```

Key details:

- The background promise is `void`-ed intentionally. The calling request path does not wait for it and does not care if it throws.
- Errors are swallowed with a warning. A failed refresh means the stale value remains until the next caller triggers another background attempt. The entry is NOT evicted on refresh failure — the hard-TTL keeps it in Redis as a fallback.
- The `stale: true` flag in `CacheResult` lets calling code log or add a response header (`X-Cache: STALE`) for observability without changing user-visible behaviour.

---

## 10. In-memory fallback — bounded Map for local dev

When Redis is not configured (`redis === null`), Lumina uses an in-process `Map` as a drop-in replacement. The important detail is that it is **bounded**:

```ts
// cache.ts:42-52
const MEM_MAX_ENTRIES = 500;
const mem = new Map<string, Entry<unknown>>();

function memSet(key: string, entry: Entry<unknown>): void {
  mem.delete(key); // re-insert at tail so recently-written keys evict last
  mem.set(key, entry);
  while (mem.size > MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}
```

JavaScript's `Map` preserves insertion order. By deleting and re-inserting on write, recently written keys move to the tail. When the map exceeds 500 entries, the oldest (head) is evicted. This is LRU approximation via insertion-order eviction — O(1) per operation, no extra data structures.

Why this matters: agent-driven finance panels build cache keys from model-chosen symbol sets (`finance:quotes:AAPL,MSFT,GOOGL,...`). The keyspace is technically unbounded (any combination of symbols a user could ask about). Without a size cap the map would grow without limit on a long-lived `bun dev` session.

---

## 11. Key naming conventions

Consistent key naming matters for:
- Avoiding accidental collisions between features.
- Making the Upstash console's key browser readable.
- Enabling `SCAN` with pattern filters for cache inspection or invalidation scripts.

Suggested convention for Lumina (extend as needed):

```
finance:quote:<symbols-sorted-comma-joined>        # market data
finance:summary:<market-or-sector>                  # LLM-generated market summary
finance:news:<topic>                                # news feed
rl:finance:<client-ip>                              # rate-limit counters (from ratelimit.ts)
semantic:<embedding-model>:<query-hash>             # semantic cache (rag-retrieval)
connector:gmail:token:<userId>                      # OAuth token cache (connectors-oauth)
```

Do NOT use colons inside the variable parts (symbol list, query hash) — use a different separator (comma, dash, or URL-encode) to keep the `:` as a pure namespace separator that you can `SCAN` with `finance:*`.

---

## 12. Quick-reference cheat sheet

```ts
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// Initialize (null-when-unset pattern)
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

// get / set
await redis?.get<T>(key);
await redis?.set(key, value, { ex: 300 });
await redis?.del(key);

// Pipeline (N commands, 1 round-trip)
const pipe = redis.pipeline();
pipe.get("key1"); pipe.get("key2");
const [v1, v2] = await pipe.exec<[T|null, T|null]>();

// Atomic multi
const tx = redis.multi();
tx.incr("counter"); tx.expire("counter", 60);
await tx.exec();

// Sliding-window rate limit
const limiter = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, "60 s"), prefix: "rl:api" });
const { success } = await limiter.limit(clientIp);

// Lua atomic script (no WATCH needed)
await redis.eval(`return redis.call("INCR", KEYS[1])`, ["my:counter"], []);

// What NOT to do on serverless
// ❌ redis.subscribe("channel", handler)  // requires persistent connection
// ❌ BLPOP / BRPOP                         // blocking — no persistent connection
// ❌ WATCH + MULTI across two requests     // each request is independent
```

---

## See also

**Same skill (redis):**
- `SKILL.md` — decision tree for when to use Redis vs Postgres vs in-memory

**Other skills:**
- `rag-retrieval` — semantic cache layer built on Upstash Redis + pgvector (`CachedQuery` model, embedding search, cache invalidation strategy)
- `finance-markets` — how the market-data cache (`getOrRefresh`) integrates with Twelve Data / Yahoo / Finnhub rate limits and the `commercialOk` licensing gate
- `connectors-oauth` — OAuth token vault and scheduling, which also uses Redis for short-lived session state
- `backend-testing` — how to mock `@upstash/redis` in `bun:test` without hitting a real Redis instance (the `supabase-fake.ts` seam pattern extended to Redis)
- `ai-sdk-agent` — the agent runtime's `getOrRefresh` usage for LLM response caching and the `forceRefresh` warmer pattern
- `lumina-frontend` — TanStack Query cache on the frontend; understanding where each cache layer lives (Redis → Express route → TanStack in-memory) helps reason about total staleness budget
