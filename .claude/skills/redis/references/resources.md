# Redis — Resources and Further Reading

> A pointer doc: where to find the authoritative docs, the Redis command reference, the
> `@upstash/ratelimit` API, the Upstash console, and the prior-art cluster skill (and why most of it
> does not apply to serverless Upstash). Read this when you need to go beyond what the other
> references in this skill cover.

---

## 1. `@upstash/redis` — the REST client

### Package and install

```
npm i @upstash/redis        # also: bun add @upstash/redis
```

Repository: <https://github.com/upstash/upstash-redis>  
npm: <https://www.npmjs.com/package/@upstash/redis>

### Official docs

| Page | What it covers |
|---|---|
| [Quickstart](https://upstash.com/docs/redis/sdks/ts/quickstart) | Constructor, env vars, first `get`/`set` |
| [Commands](https://upstash.com/docs/redis/sdks/ts/commands/overview) | Full list of typed wrappers (`get`, `set`, `hset`, `zadd`, `scan`, …) |
| [Pipeline](https://upstash.com/docs/redis/sdks/ts/pipeline) | `redis.pipeline()` — batches N commands into one HTTP round-trip |
| [Multi/Transaction](https://upstash.com/docs/redis/sdks/ts/multi) | `redis.multi()` — atomic block; serverless limitation with `WATCH` noted |
| [Auto-serialisation](https://upstash.com/docs/redis/sdks/ts/auto-pipeline) | JSON encode/decode: no manual `JSON.stringify`/`JSON.parse` |
| [Lua scripting](https://upstash.com/docs/redis/sdks/ts/commands/scripting/eval) | `redis.eval(script, keys, args)` — for atomic conditional operations |
| [Cloudflare Workers variant](https://upstash.com/docs/redis/sdks/ts/cloudflare-workers) | `@upstash/redis/cloudflare` import, `waitUntil` — NOT needed on Vercel/Bun |

### Key env vars (exact names the SDK reads by convention)

```
UPSTASH_REDIS_REST_URL=https://<region>-<name>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<read-write-token>
```

Both are set under **Upstash console → database → REST API**.  
Lumina reads them with the null-when-unset guard at `backend/lib/cache.ts:28-34` and
`backend/lib/ratelimit.ts:20-26`.

### What the REST client **cannot** do (vs. `ioredis`/`node-redis`)

These require a persistent TCP connection and are unavailable over the REST interface:

| Command | Reason unavailable | Lumina alternative |
|---|---|---|
| `SUBSCRIBE` / `PSUBSCRIBE` | Needs a long-lived push channel | Supabase Realtime + `worker/` (Fly.io) |
| `BLPOP` / `BRPOP` / `XREAD BLOCK` | Blocking — holds connection open | Poll with `LPOP`/`XREAD` or a dedicated queue |
| `WATCH` + interactive `MULTI`/`EXEC` | Requires same connection across two requests | Lua script (`redis.eval`) for atomic conditional writes |
| `MONITOR` / `DEBUG` | Server introspection commands | Upstash console log viewer |

---

## 2. `@upstash/ratelimit`

### Package and install

```
npm i @upstash/ratelimit    # also: bun add @upstash/ratelimit
```

Repository: <https://github.com/upstash/ratelimit-js>  
npm: <https://www.npmjs.com/package/@upstash/ratelimit>

### Docs

| Page | What it covers |
|---|---|
| [Overview + algorithms](https://upstash.com/docs/redis/sdks/ratelimit/overview) | Fixed window, sliding window, token bucket — when to use each |
| [Algorithm comparison](https://upstash.com/docs/redis/sdks/ratelimit/algorithms) | Burst behaviour and fairness trade-offs |
| [Response fields](https://upstash.com/docs/redis/sdks/ratelimit/methods) | `success`, `limit`, `remaining`, `reset`, `pending` |
| [Multi-region / analytics](https://upstash.com/docs/redis/sdks/ratelimit/multiregion) | Global databases, ephemeris analytics — advanced only |
| [Next.js / Vercel examples](https://upstash.com/docs/redis/sdks/ratelimit/examples) | Edge middleware examples; the Express pattern is the same but in a middleware function |

### Lumina usage

`backend/lib/ratelimit.ts:28-34` — `Ratelimit.slidingWindow(60, "60 s")` with prefix `"rl:finance"`.

The three algorithm factories:

```ts
import { Ratelimit } from "@upstash/ratelimit";

// Prefer this: smooth rolling window, no boundary burst
Ratelimit.slidingWindow(N, "60 s")

// Simple but vulnerable to burst at the window boundary
Ratelimit.fixedWindow(N, "60 s")

// Allows short bursts up to bucket capacity, then drains
Ratelimit.tokenBucket(N, "1 s", burstCapacity)
```

Key response fields you can forward as response headers:

```ts
const { success, limit, remaining, reset } = await limiter.limit(ip);
res.setHeader("X-RateLimit-Limit", limit);
res.setHeader("X-RateLimit-Remaining", remaining);
res.setHeader("X-RateLimit-Reset", reset); // Unix ms — tells clients when to retry
if (!success) return res.status(429).json({ error: "Too many requests — slow down." });
```

---

## 3. The Upstash REST API (raw HTTP, no SDK)

If you ever need to call Upstash from an environment without Node.js/Bun (a shell script, a cron
health-check, a Lua script inside a pipeline), the REST API is a plain HTTPS endpoint:

```
# GET a key
curl https://<endpoint>.upstash.io/get/<key> \
  -H "Authorization: Bearer <token>"

# SET a key with EX
curl -X POST https://<endpoint>.upstash.io \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '["SET","mykey","myvalue","EX","300"]'

# Pipeline (array of commands)
curl -X POST https://<endpoint>.upstash.io/pipeline \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '[["GET","key1"],["GET","key2"],["SET","key3","val","EX","60"]]'
```

Full REST API reference: <https://upstash.com/docs/redis/features/restapi>

The `@upstash/redis` SDK wraps exactly these endpoints — reading the raw API docs helps when
debugging unexpected responses or building integrations outside TypeScript.

---

## 4. The Upstash console

<https://console.upstash.com>

Key pages:

| Console section | Use it to |
|---|---|
| **Data Browser** | Inspect live keys, their TTLs, and values (useful for verifying `cache.ts` writes during dev) |
| **CLI** | Run Redis commands interactively against the real database — paste in `GET finance:quote:AAPL` |
| **Metrics** | Command counts per day/hour, p99 latency, storage usage — confirm you are in the free tier |
| **REST API tab** | Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for `.env.local` |
| **Logs** | Recent commands log; useful for diagnosing `SUBSCRIBE`-not-supported errors |

Tip: after a `bun dev` session with real Upstash vars, open Data Browser and filter by prefix
(`finance:*`, `rl:finance:*`) to confirm the cache and rate-limit keys are being written with
the expected TTLs.

---

## 5. The Redis command reference

Authoritative source for every Redis command: <https://redis.io/commands>

### Most-used commands in this codebase

| Command | Upstash SDK call | Notes |
|---|---|---|
| `GET` | `redis.get<T>(key)` | Auto-parsed from JSON |
| `SET key value EX n` | `redis.set(key, val, { ex: n })` | Always pass `ex`/`px` — no naked sets |
| `DEL` | `redis.del(key)` | Also accepts multiple keys |
| `EXISTS` | `redis.exists(key)` | Returns count of existing keys (0 or 1 per key) |
| `TTL` | `redis.ttl(key)` | -2 if key absent, -1 if no expiry |
| `EXPIRE` | `redis.expire(key, seconds)` | Reset TTL without overwriting value |
| `INCR` | `redis.incr(key)` | Atomic increment — for counters, never read-then-write |
| `INCRBY` | `redis.incrby(key, n)` | Atomic add-N |
| `MGET` | `redis.mget<[A,B]>(k1, k2)` | Multi-get in one round-trip |
| `HSET` | `redis.hset(key, { field: val })` | Hash field set |
| `HGETALL` | `redis.hgetall<Record<string,T>>(key)` | Full hash as object |
| `ZADD` | `redis.zadd(key, { score, member })` | Sorted set; leaderboards, time windows |
| `ZRANGE` | `redis.zrange<T>(key, 0, -1, { rev: true })` | Sorted-set range |
| `XADD` | `redis.xadd(key, "*", fields)` | Append to stream |
| `XRANGE` | `redis.xrange<T>(key, "-", "+")` | Read stream range |
| `SCAN` | `redis.scan(cursor, { match, count })` | Safe key enumeration — never `KEYS *` in prod |

### Data-type documentation pages

| Type | Redis docs link |
|---|---|
| Strings | <https://redis.io/docs/data-types/strings/> |
| Hashes | <https://redis.io/docs/data-types/hashes/> |
| Lists | <https://redis.io/docs/data-types/lists/> |
| Sets | <https://redis.io/docs/data-types/sets/> |
| Sorted Sets | <https://redis.io/docs/data-types/sorted-sets/> |
| Bitmaps | <https://redis.io/docs/data-types/bitmaps/> |
| HyperLogLog | <https://redis.io/docs/data-types/hyperloglogs/> |
| Streams | <https://redis.io/docs/data-types/streams/> |
| Geospatial | <https://redis.io/docs/data-types/geospatial/> |

---

## 6. Prior art: the `redis-cluster` skill

Location: `E:\Development\Portfolio-phase2\react\.claude\skills\redis-cluster\`

This is the source skill that the redis references in this library were adapted from. It documents
operating a **self-hosted Redis cluster** (multi-node, hash slots, failover, `ioredis` cluster
routing, resharding ops).

**Most of it does NOT apply to Lumina on Upstash.** Upstash presents a single logical endpoint
over REST; there are no cluster mechanics exposed to the application layer.

### What transfers (reusable theory, fully adopted here)

| Concept | Where it lives in this skill |
|---|---|
| Cache-aside / SWR / TTL + jitter / stampede protection | `patterns-caching-strategies.md` |
| Redis data types and when to use each | `theory-redis-data-model.md` |
| Locks (`SET NX PX`), atomic counters, idempotency keys | `patterns-locks-and-rate-limiting.md` |
| Streams, Pub/Sub, fan-out patterns | `patterns-streams-and-pubsub.md` |
| Key naming, TTL policy, eviction posture | `patterns-keys-ttl-and-eviction.md` |

### What does NOT transfer (cluster-only, deliberately dropped)

| Cluster mechanic | Why dropped |
|---|---|
| Hash slots (16384 slots, `{key}` tags to co-locate) | Upstash manages sharding internally; no slot visibility |
| `ioredis` cluster routing (`ClusterOptions`, `natMap`) | `@upstash/redis` REST client; no ioredis at all on Vercel |
| `CLUSTER INFO` / `CLUSTER NODES` introspection | Not exposed by Upstash REST |
| Resharding operations (`redis-cli --cluster reshard`) | Upstash auto-scales; no manual resharding |
| Sentinel / failover runbooks | Upstash is a managed service; HA is handled by Upstash |
| Replica promotion and split-brain recovery | Same — managed service SLA |
| Redis Cluster bus (port 16379 gossip) | Internal to Upstash; inaccessible |

If Lumina ever migrates to a **self-hosted cluster** (e.g. a Fly.io Redis sidecar, ElastiCache,
or Render Redis), open the `redis-cluster` skill directly and use `ioredis` with its cluster
adapter. For the current Vercel + Upstash architecture, everything you need is in this skill.

---

## 7. Eviction and persistence reference

### Eviction policies

Upstash databases are configured with an eviction policy that applies when the database reaches its
storage limit. The Redis docs cover the full set; the two most relevant:

| Policy | Behaviour | When to choose |
|---|---|---|
| `allkeys-lru` | Evict least-recently-used across ALL keys when memory is full | General cache with mixed TTLs |
| `volatile-lru` | Evict LRU only among keys WITH an expiry set | When you store both durable and ephemeral keys in the same database (avoid this design) |
| `allkeys-lfu` | Evict least-frequently-used (Redis 4+) | Better than LRU for highly-skewed access (a few very-hot keys) |
| `noeviction` | Return error on new writes when full | Appropriate only for durable stores, NOT a cache |

Redis eviction policy docs: <https://redis.io/docs/reference/eviction/>

**Lumina's posture:** every key carries a TTL (`HARD_TTL_MULTIPLIER` ensures the Redis expiry is set;
the in-memory fallback is bounded by `MEM_MAX_ENTRIES`). The database should be configured
`allkeys-lru` (or `allkeys-lfu`). Never `noeviction` on a cache database. Configure this in the
Upstash console under **Database → Config → Eviction Policy**.

### Persistence

Upstash Redis databases persist data to disk with AOF (append-only file). This is a managed
concern — you cannot tune AOF sync frequency via the REST API. What this means practically:

- A cache entry written with `redis.set(key, val, { ex: 300 })` survives an Upstash backend
  restart (within the TTL). You do NOT get a cold cache on Upstash restarts, unlike in-process
  memory.
- The in-process `mem` Map fallback (local dev) is cold on every process restart. The `forceRefresh`
  warmer call in `backend/index.ts` at startup addresses this.
- Redis persistence docs (background reading): <https://redis.io/docs/management/persistence/>

---

## 8. Quick-link index

| Resource | URL |
|---|---|
| Upstash console | <https://console.upstash.com> |
| `@upstash/redis` docs | <https://upstash.com/docs/redis/sdks/ts/quickstart> |
| `@upstash/ratelimit` docs | <https://upstash.com/docs/redis/sdks/ratelimit/overview> |
| Upstash REST API reference | <https://upstash.com/docs/redis/features/restapi> |
| Redis command reference | <https://redis.io/commands> |
| Redis data-type overview | <https://redis.io/docs/data-types/> |
| Redis eviction policy docs | <https://redis.io/docs/reference/eviction/> |
| Redis persistence docs | <https://redis.io/docs/management/persistence/> |
| Lua scripting in Redis | <https://redis.io/docs/manual/programmability/eval-intro/> |
| Redis Streams intro | <https://redis.io/docs/data-types/streams-tutorial/> |
| Prior art cluster skill | `E:\Development\Portfolio-phase2\react\.claude\skills\redis-cluster\` |

---

## See also

**Same skill (redis):**
- `SKILL.md` — decision tree routing to the right reference
- `lumina-upstash-cache.md` — the full `getOrRefresh`/`forceRefresh`/SWR/`inflight` wiring with
  file-cited line numbers; start here for any change to `backend/lib/cache.ts`
- `patterns-upstash-rest-client.md` — REST client deep dive: why REST on Vercel, env wiring, JSON
  auto-parse, pipelining, the thundering-herd guard, key conventions
- `theory-redis-data-model.md` — choosing a data type: Strings/Hashes/Lists/Sets/ZSets/Streams
- `patterns-caching-strategies.md` — cache-aside, TTL + jitter, stampede protection, invalidation, SWR
- `patterns-locks-and-rate-limiting.md` — `SET NX PX` locks, Lua atomic ops, idempotency keys,
  `@upstash/ratelimit` algorithm trade-offs
- `patterns-streams-and-pubsub.md` — Streams, Pub/Sub, and why live fan-out goes through Supabase
  Realtime + the Fly.io worker instead of REST `SUBSCRIBE`
- `patterns-keys-ttl-and-eviction.md` — key naming, TTL policy, eviction posture, unbounded keyspace

**Other skills:**
- `finance-markets` — TTL choices per market-data series, the cron warmer, vendor quota budgets
- `rag-retrieval` — semantic cache on pgvector (`CachedQuery` model); a Postgres cache, not Redis
- `connectors-oauth` — OAuth token vault; short-lived session state that may use Redis for caching
- `backend-testing` — how to mock `@upstash/redis` in `bun:test` without hitting a real database
- `supabase` — Supabase Realtime as the live fan-out transport (what Redis Pub/Sub is NOT used for)
