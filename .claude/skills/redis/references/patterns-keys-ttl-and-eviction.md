# Redis Patterns: Keys, TTL, and Eviction

> Generic reference — key naming, TTL policy, eviction posture, unbounded-keyspace risk, big-key
> avoidance, and safe production operations. Lumina's `backend/lib/cache.ts` and
> `backend/lib/ratelimit.ts` are the worked examples throughout.

---

## 1. Key naming conventions

### Colon-separated namespacing

Every key must carry a **namespace prefix** that encodes (a) the domain, (b) the entity type, and
(c) the discriminating value. The conventional separator is a colon. This is not a Redis protocol
requirement — it is a human and tooling convention — but it is universal enough that
`redis-cli`, RedisInsight, and every admin tool use `:` as the namespace boundary for tree views.

```
<domain>:<entity>:<discriminator>

finance:quote:AAPL
finance:quote:AAPL,MSFT,GOOG        ← comma-joined symbol set
finance:sector:technology
finance:market-summary:US
rl:finance:<ip>                      ← rate-limit counters (different domain)
session:<userId>
rag:embed:<sha256-of-query>
connector:gmail:token:<userId>
```

Lumina's actual prefixes from the codebase:

| Prefix | File | Purpose |
|---|---|---|
| `finance:quote:<symbols>` | `backend/lib/cache.ts` | Market-data cache entries |
| `rl:finance` | `backend/lib/ratelimit.ts:28-34` | Upstash Ratelimit prefix (it appends `:<key>` internally) |

The rate-limiter prefix is set when constructing the `Ratelimit` instance:

```ts
// backend/lib/ratelimit.ts:28-34 (upstashLimiter construction)
const upstashLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(LIMIT, `${WINDOW_SEC} s`),
      prefix: "rl:finance",          // ← every counter stored as rl:finance:<ip>
    })
  : null;
```

### Versioning keys

When you change the serialization format of a cached value (add fields, change types, rename
properties), old readers will deserialize stale data into the wrong shape. The two safe strategies:

**Option A — version in the prefix:**

```
v1:finance:quote:AAPL   →  (old shape)
v2:finance:quote:AAPL   →  (new shape, added `currency` field)
```

After deploying code that reads `v2:*`, the `v1:*` entries simply expire naturally. No migration
step, no code that tries to "upgrade" live entries. Keep the version segment close to the root so a
`SCAN v2:finance:*` sees only current data.

**Option B — schema hash in the key:**

```
finance:quote:v3a8b:AAPL    ← v3a8b = short hash of the schema definition
```

Useful when the shape is generated from a Prisma/Zod schema and changes frequently; the hash is
derived at build time and baked into the constant.

For Lumina's current `Entry<T> = { data: T; fetchedAt: number }` shape (cache.ts:25), a version
prefix is sufficient: `v2:finance:quote:<symbols>` if the envelope ever changes.

### Avoiding collisions

Three classes of collisions to prevent:

1. **Cross-service collision**: different services writing to the same Redis instance must use
   non-overlapping top-level namespaces. Lumina isolates finance data (`finance:*`), rate-limit
   counters (`rl:*`), and future RAG embeddings (`rag:*`) at the first colon segment.

2. **Discriminator collision**: if the discriminator is user-supplied (a symbol ticker, a query
   string, a user ID), enforce a canonical form before using it as a key. For symbol sets:
   uppercase + sort + join:

   ```ts
   function symbolKey(symbols: string[]): string {
     return `finance:quote:${[...symbols].sort().join(",").toUpperCase()}`;
   }
   // ["msft","aapl"] → finance:quote:AAPL,MSFT
   // ["AAPL","msft"] → finance:quote:AAPL,MSFT  ← same key
   ```

3. **Embedding collision**: for semantic / embedding cache keys that hash query text, always
   include a model-version prefix so a new embedding model does not serve vectors computed by the
   old one:

   ```ts
   `rag:embed:${modelVersion}:${sha256hex(queryText)}`
   ```

---

## 2. TTL policy and jitter

### Soft TTL vs. hard TTL

Lumina's cache layer maintains a two-level TTL concept (cache.ts:53-67):

- **Soft TTL** (`ttlSeconds` parameter): the freshness window. A value older than this is
  considered stale and triggers a background refresh.
- **Hard TTL** (`ttlSeconds × HARD_TTL_MULTIPLIER`): the actual Redis `EX` value. The entry
  remains readable as stale-fallback material long after freshness expires.

```ts
// backend/lib/cache.ts:54
const HARD_TTL_MULTIPLIER = 12;

// backend/lib/cache.ts:65-71
async function writeEntry<T>(key: string, entry: Entry<T>, ttlSeconds: number): Promise<void> {
  if (redis) {
    await redis.set(key, entry, { ex: Math.max(1, Math.floor(ttlSeconds * HARD_TTL_MULTIPLIER)) });
  } else {
    memSet(key, entry as Entry<unknown>);
  }
}
```

A 5-minute soft TTL therefore keeps the entry in Redis for 60 minutes. During that 60-minute
window the stale-while-revalidate path can serve the stale value instantly while a background
refresh runs. If the upstream is down for an hour, readers still get the last-good data instead
of a 500.

Practical soft TTL guidance for different data classes:

| Data type | Soft TTL | Rationale |
|---|---|---|
| Live equity quotes | 60–120 s | Markets move every second; 2-minute staleness acceptable |
| Sector summaries | 300 s | Aggregated, changes slowly |
| Index snapshots (S&P 500) | 300 s | Same |
| News headlines | 600 s | Freshness matters less; rate-limit the news API |
| Crypto prices | 30–60 s | More volatile; shorter acceptable window |
| Academic paper metadata | 86400 s | Almost never changes |
| Rate-limit counters | Managed by sliding window | Do NOT set a manual TTL; the library does it |

### TTL jitter

When many cache entries share the same soft TTL (e.g., a cron that warms 50 tickers every 5
minutes), all entries expire simultaneously and the thundering herd hits your upstream at once.
Prevent this by adding a random jitter to each TTL at write time:

```ts
function jitteredTtl(baseSec: number, jitterFrac = 0.15): number {
  // ±15% around the base value
  const spread = baseSec * jitterFrac;
  return Math.round(baseSec + (Math.random() * 2 - 1) * spread);
}

// Usage: pass jitteredTtl(300) instead of 300 to getOrRefresh
await getOrRefresh(`finance:sector:${sector}`, jitteredTtl(300), fetcher);
```

The jitter must be applied to the **soft** TTL so the freshness boundary is spread out. The hard
TTL (multiplied by `HARD_TTL_MULTIPLIER`) inherits the same spread automatically.

### Per-entry expiry vs. global expiry

Redis does not have a concept of "namespace TTL". Every key carries its own `EX`. This is correct
behavior: different entries in the same namespace have different upstream latencies and volatility.

Never manage expiry by deleting a whole namespace. If you need to invalidate a class of keys,
either (a) change the version prefix (rolling invalidation via key migration), or (b) write a
`SCAN`-based batch deleter as a one-off admin tool (never in hot-path code — see §6).

---

## 3. Eviction policy and maxmemory posture

### Use Redis as a pure cache

When Redis is used exclusively for caching (not as a source-of-truth store for queues, pub/sub
state, or rate-limit counters you cannot afford to lose), configure maxmemory and the eviction
policy so Redis self-manages under memory pressure.

Recommended `redis.conf` (or Upstash equivalent):

```
maxmemory 256mb              # set a hard ceiling; tune per plan
maxmemory-policy allkeys-lru # evict least-recently-used key from the entire keyspace
```

`allkeys-lru` is correct when **every** key is cache-like (has an expiry or can be re-fetched).
It lets Redis evict any key — not just those with an `EX` — when memory fills up.

Alternative policies and when to pick them:

| Policy | Use when |
|---|---|
| `allkeys-lru` | All keys are re-fetchable cache entries. Most common cache posture. |
| `volatile-lru` | Some keys MUST NOT be evicted (e.g., rate-limit counters without Upstash). |
| `allkeys-lfu` | Hot-set is small; frequency matters more than recency (e.g., popular tickers). |
| `noeviction` | Redis is authoritative (job queues, ledger); let writes fail loudly instead. |

**Upstash note**: Upstash manages memory per database on its own infrastructure. The free tier
has a maximum database size and will evict based on its own LRU policy. On paid plans you can
configure the eviction policy in the dashboard. The Lumina stack treats Upstash as a pure cache so
`allkeys-lru` is appropriate — the `HARD_TTL_MULTIPLIER` already bounds key lifetime to 12× the
soft TTL, so most keys expire naturally before memory pressure triggers forced eviction.

---

## 4. The unbounded-keyspace problem

### Why it matters

A human-facing browse UI produces a bounded keyspace: there are at most N category pages, M
tickers, or P report types. But when an AI agent decides what to cache, the discriminator is
**model-chosen**. The agent might request:

```
finance:quote:AAPL
finance:quote:AAPL,MSFT
finance:quote:AAPL,MSFT,GOOG
finance:quote:AAPL,MSFT,GOOG,TSLA
finance:quote:AAPL,MSFT,GOOG,TSLA,AMZN
...
finance:quote:AAPL,NVDA,COIN,DOGE,META,TSLA   ← new unique key every session
```

Every unique symbol combination is a new cache key. With thousands of sessions, the keyspace
grows without bound. On Upstash the hard TTL is the safety valve — every key expires within
`12 × ttlSeconds` regardless. On the in-memory fallback there is no TTL-based expiry, so an
explicit capacity cap is essential.

### How Lumina handles it

`backend/lib/cache.ts:42-52`:

```ts
const MEM_MAX_ENTRIES = 500;
const mem = new Map<string, Entry<unknown>>();

function memSet(key: string, entry: Entry<unknown>): void {
  mem.delete(key); // re-insert at end so recently-written keys are evicted last
  mem.set(key, entry);
  while (mem.size > MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value;   // Map preserves insertion order
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}
```

The in-memory fallback is a **bounded LRU-insert** Map: it caps at 500 entries and evicts the
oldest-inserted key when the cap is reached. `mem.delete(key)` before `mem.set(key, ...)` moves
a re-written key to the "recently inserted" tail, so it survives the next eviction round.

The upstream (Upstash Redis) is protected by the hard TTL: each entry carries
`EX = ttlSeconds * 12`, so even if the agent explores an enormous symbol space, every key
evicts itself within `12 × ttlSeconds` seconds. At a 5-minute soft TTL that is 60 minutes per
entry — the keyspace is bounded in time even if unbounded in cardinality.

### Mitigations beyond the cache layer

The cache cap and TTL are the last line of defense. Add earlier guards:

1. **Canonicalize and cap discriminators before keying**: sort symbols, uppercase them, and
   limit the list length (e.g., max 10 symbols per cache key). The agent should never be able to
   force a cache key with 50 unique symbols.

   ```ts
   const MAX_SYMBOLS = 10;
   function safeSymbolKey(raw: string[]): string {
     const canonical = [...new Set(raw.map(s => s.toUpperCase()))].sort().slice(0, MAX_SYMBOLS);
     return `finance:quote:${canonical.join(",")}`;
   }
   ```

2. **Cache popular subsets explicitly** (pre-warm): a cron warms the top 20 tickers and the
   index constituents. Those keys are almost always hot; the long tail of agent-composed sets
   hits the cache or misses gracefully.

3. **Monitor keyspace size**: in production, alert when `DBSIZE` exceeds a threshold or when
   the Upstash dashboard shows fast key-count growth. An unbounded keyspace is often the symptom
   of a missing canonicalization step.

---

## 5. Big-key avoidance and per-type memory modeling

### What is a big key

Redis is single-threaded on the command path. A single command that reads or writes a large
value blocks all other commands for its duration. "Large" is relative but the practical
thresholds are:

| Type | Concern threshold |
|---|---|
| String (raw bytes) | > 1 MB |
| Hash / List / Set / ZSet | > 1,000 members, or total serialized size > 512 KB |
| JSON blob (Redis Stack / Upstash) | > 512 KB |

Lumina stores market-data cache entries as serialized JSON blobs in plain Redis String keys.
The `Entry<T> = { data: T; fetchedAt: number }` envelope is compact for typical payloads:

- Single quote: ~200–500 bytes (ticker, price, change, volume, timestamp). Fine.
- 10-ticker watchlist: ~2–5 KB. Fine.
- Sector heatmap (500 S&P 500 constituents with OHLCV): potentially 200–400 KB. Borderline.

### Per-type memory estimates

Before storing a new data class, estimate the serialized size:

```ts
const entry: Entry<SectorHeatmap> = { data: heatmapData, fetchedAt: Date.now() };
const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
console.log(`[cache] key size: ${bytes} bytes`);
```

If a key exceeds 100 KB, consider:

**Splitting the value**: instead of one `finance:heatmap:US` key with 500 stocks, store per-sector
keys (`finance:heatmap:sector:technology`, `finance:heatmap:sector:energy`, ...) and fetch only
the sector the user is viewing. Redis pipeline or `MGET` collects them in one round-trip.

```ts
// Fetch multiple sector slices in parallel — Upstash supports Promise.all over HTTP
const sectors = ["technology", "energy", "healthcare"];
const entries = await Promise.all(
  sectors.map(s => getOrRefresh(`finance:heatmap:sector:${s}`, 300, () => fetchSector(s)))
);
```

**Projecting fields**: if the downstream consumer only needs `{ symbol, price, changePercent }`,
do not cache the full upstream response. Project to the minimum shape before caching:

```ts
const slim = raw.map(({ symbol, price, changePercent }) => ({ symbol, price, changePercent }));
await getOrRefresh(key, ttl, async () => slim);
```

**Compression**: for large blobs that cannot be split, serialize with a compact format (MessagePack
via `@msgpack/msgpack`) and store the compressed bytes as a base64 String. Only worthwhile above
~50 KB where the compression ratio justifies the CPU cost on the hot path.

### Aggregated responses

Never cache an entire API response that includes metadata, rate-limit headers, or envelope fields
you do not serve. Cache the extracted, application-shaped payload only.

---

## 6. SCAN over KEYS in production

### Why KEYS is dangerous

`KEYS <pattern>` is a synchronous, O(N) command that iterates the full keyspace while holding
the command lock. On a database with 100,000 keys it will block every other command for tens of
milliseconds. In production this causes latency spikes across all callers that share the Redis
instance.

**Never use `KEYS` in production hot-path code.**

The only safe production equivalent is `SCAN` (or `HSCAN`, `SSCAN`, `ZSCAN` for nested types),
which is:

- Cursor-based and non-blocking: each call returns a batch and a cursor; the server processes
  other commands between batches.
- O(N/count) per call rather than O(N) for the whole scan.
- Guaranteed to visit every key exactly once across a full cursor cycle (from cursor 0 back to 0).

### Using SCAN safely

Upstash exposes `SCAN` via its REST API and the `@upstash/redis` client:

```ts
import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });

async function scanPattern(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: pattern, count: 100 });
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== 0);
  return keys;
}

// Example: find all stale finance quote keys for a monitoring script
const quoteKeys = await scanPattern("finance:quote:*");
```

Notes:

- `count: 100` is a hint, not a guarantee — Redis may return fewer or more per call.
- `SCAN` is **not strongly consistent** during concurrent writes. It may return a key added after
  the scan started, or miss a key that was deleted mid-scan. For cache-inspection purposes (logging,
  admin tooling) this is acceptable. For authoritative counts it is not.
- Use `SCAN` only in background admin scripts, cron jobs, and monitoring — never on the hot
  request path. If your design needs to enumerate live keys to answer a user request, the design
  is wrong: use a secondary index (a Redis Set or a Postgres table) to track the known keyspace.

### Pattern alternatives to SCAN

If you find yourself scanning to answer a question, model the membership as a first-class data
structure instead:

| Question | Bad: SCAN | Good: dedicated index |
|---|---|---|
| "Which tickers are cached?" | `SCAN finance:quote:*` | A Redis Set `finance:cached-tickers` updated on write |
| "How many users are rate-limited?" | `SCAN rl:finance:*` | Upstash Ratelimit dashboard metric or a counter key |
| "Which sessions are active?" | `SCAN session:*` | A sorted set scored by `expiresAt`, pruned by cron |

---

## 7. Rate-limit key design (Upstash Ratelimit)

The `@upstash/ratelimit` library manages its own key schema internally under the `prefix` you
provide. In Lumina the prefix is `"rl:finance"` (ratelimit.ts:30). The library creates keys like:

```
rl:finance:<identifier>            ← sliding-window counter for one identifier
```

Where `<identifier>` is whatever you pass to `.limit(key)` — in Lumina that is the client IP
(ratelimit.ts:54-58):

```ts
function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}
```

Upstash Ratelimit uses a Lua script for the sliding-window increment + expiry in a single atomic
operation. You do not manage the TTL — the library sets it to the window duration automatically.

**What to namespace separately**: if you add a second rate limiter (e.g., one for the
`/perplexity_ask` route, one for file upload), give each a distinct prefix:

```ts
const askLimiter   = new Ratelimit({ redis, limiter: slidingWindow(20, "60 s"), prefix: "rl:ask" });
const uploadLimiter = new Ratelimit({ redis, limiter: slidingWindow(5, "60 s"), prefix: "rl:upload" });
```

Never share a prefix between logically separate rate-limit domains — the counters will collide.

---

## 8. Thundering-herd guard (inflight deduplication)

When a cache key is cold or stale, multiple concurrent requests may all find no fresh entry and
simultaneously kick off an upstream fetch. For an expensive upstream (LLM call, third-party market
API with a free-tier quota), this "thundering herd" wastes quota and adds latency.

Lumina guards this with an in-process `inflight` Map (cache.ts:58-91):

```ts
// backend/lib/cache.ts:58
const inflight = new Map<string, Promise<unknown>>();

function doRefresh<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    // Only the FIRST caller for this key starts the fetch.
    const startedAt = Date.now();
    p = (async () => {
      const data = await fetcher();
      await writeEntry(key, { data, fetchedAt: startedAt }, ttlSeconds);
      return data;
    })();
    inflight.set(key, p);
    void p.then(() => inflight.delete(key), () => inflight.delete(key));
  }
  return p; // all callers share the same Promise
}
```

The `inflight` Map is process-local — it only deduplicates within one Vercel function instance.
On a multi-instance deployment (scale-out), two separate instances may each kick off one refresh
for the same key. For most market-data cache use cases this is acceptable (two upstream calls
instead of one is not catastrophic). If strict single-writer semantics are required, use a Redis
`SET NX EX` distributed lock:

```ts
async function acquireRefreshLock(key: string, ttlSec: number): Promise<boolean> {
  // SET lock:<key> 1 NX EX <ttl>  — succeeds only for the first caller
  const result = await redis.set(`lock:${key}`, "1", { nx: true, ex: ttlSec });
  return result === "OK";
}
```

Only the instance that wins the `NX` set runs the fetch; all others serve stale while waiting.
Release the lock in the `finally` block of the fetch. This pattern trades some code complexity for
strict quota protection.

---

## 9. Quick-reference checklist

Before adding a new Redis key to the codebase, verify:

- [ ] Key follows `<domain>:<entity>:<canonical-discriminator>` naming.
- [ ] Discriminator is canonicalized (sorted, uppercased, length-capped) if user- or model-supplied.
- [ ] A version segment (`v1:`, `v2:`) is present if the serialized shape may change.
- [ ] A soft TTL is chosen based on data volatility; jitter applied if many keys share the same base TTL.
- [ ] Hard TTL (= soft × 12 or similar) set as the Redis `EX` so stale entries survive for fallback.
- [ ] Value size estimated; big values (>100 KB) are split or projected before caching.
- [ ] Any admin/monitoring code that iterates keys uses `SCAN` not `KEYS`.
- [ ] The key is within a bounded cardinality or has a TTL that bounds keyspace growth.
- [ ] Rate-limit domains each have a unique `prefix` — no prefix sharing across domains.

---

## See also

**Within the redis skill:**
- `upstash-rest-client.md` — connecting `@upstash/redis` in Vercel serverless, REST-over-HTTP specifics, connection reuse, error handling
- `stale-while-revalidate.md` — the `getOrRefresh` / `forceRefresh` API, cron warmers, graceful degradation on upstream failure

**Other skills:**
- `rag-retrieval` — pgvector semantic cache (embedding-keyed cache that sits alongside this Redis layer)
- `finance-markets` — the market-data fetchers that supply the `fetcher` callbacks passed to `getOrRefresh`
- `connectors-oauth` — OAuth token vault (different Redis use-case: encrypted refresh-token storage, not a cache)
- `backend-testing` — `prisma-fake.ts` and `supabase-fake.ts` test seams; for Redis, mock `@upstash/redis` by replacing the `redis` instance in `cache.ts` with a test double
- `lumina-frontend` — TanStack Query on the client side mirrors stale-while-revalidate semantics; understanding both layers prevents double-caching the same data
- `prisma` — Prisma `$queryRaw` for `cached_query` (pgvector table), which is the persistent semantic cache layer that complements short-lived Redis entries