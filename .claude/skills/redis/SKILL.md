---
name: redis
description: >
  Build and reason about Lumina's hot-cache + rate-limit layer on Upstash Redis (serverless REST,
  NOT a self-hosted cluster). Covers the `@upstash/redis` REST client (why REST is the only kind
  that works on Vercel — no persistent sockets), the cache in `backend/lib/cache.ts`
  (getOrRefresh/forceRefresh, stale-while-revalidate, the hard-TTL multiplier, in-flight de-dupe to
  beat thundering herds, the bounded in-memory fallback), the sliding-window limiter in
  `backend/lib/ratelimit.ts` (`@upstash/ratelimit`, fail-open), Redis data structures and when to
  use each, caching strategies (cache-aside, TTL+jitter, eviction, stampede protection), distributed
  locks + idempotency + atomic counters for contested writes, Streams/Pub-Sub (and why live fan-out
  goes through Supabase Realtime/the worker instead of REST SUBSCRIBE), and key/TTL/eviction
  discipline. Use whenever the task touches the cache, Upstash, rate limiting, TTLs, a lock, or
  read-spike scale.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/lib/cache.ts'
    - 'backend/lib/ratelimit.ts'
    - 'backend/finance/hooks.ts'
    - 'worker/**'
  bashPatterns:
    - 'redis'
    - 'upstash'
    - 'UPSTASH'
    - 'ratelimit'
    - 'cache'
  promptSignals:
    phrases:
      - 'redis'
      - 'upstash'
      - 'cache'
      - 'caching'
      - 'TTL'
      - 'stale-while-revalidate'
      - 'rate limit'
      - 'rate-limiting'
      - 'sliding window'
      - 'thundering herd'
      - 'stampede'
      - 'distributed lock'
      - 'idempotency'
      - 'getOrRefresh'
      - 'cache key'
      - 'read spike'
    minScore: 3
---

# Redis — Lumina's Upstash Hot-Cache & Rate-Limit Layer

> Build the cache the way the live code does it: **Upstash Redis over REST** (the only Redis that
> works on Vercel's stateless functions — no persistent sockets), a `getOrRefresh` cache that
> **serves stale instantly while revalidating in the background**, an **in-flight de-dupe** so a
> thundering herd collapses to one upstream call, a **hard-TTL multiplier** so stale survives long
> enough to be a fallback, and an Upstash **sliding-window** rate limiter that **fails open**. This
> is the R-SCALE read-spike pattern in code: *compute the flyer once, hand out copies.* This skill
> maps any cache/limit/lock task to the exact reference + the exact file.

Generic Redis knowledge is adapted from the react repo's `redis-cluster` skill, **reframed for a
single logical serverless instance** — cluster-only mechanics (hash slots, the cluster bus,
resharding, failover ops, ioredis cluster routing) are deliberately out of scope because Upstash
presents one logical endpoint over REST.

---

## Domain Identity

**This skill OWNS:**
- The cache layer in [`backend/lib/cache.ts`](../../../backend/lib/cache.ts): `getOrRefresh`,
  `forceRefresh`, `CacheResult`, stale-while-revalidate, `HARD_TTL_MULTIPLIER`, the `inflight`
  de-dupe map, the bounded `mem` fallback (`MEM_MAX_ENTRIES`), `cacheBackend`.
- The rate limiter in [`backend/lib/ratelimit.ts`](../../../backend/lib/ratelimit.ts):
  `@upstash/ratelimit` sliding window, `financeRateLimit`, the fail-open posture, the in-memory
  fallback.
- The `@upstash/redis` REST client wiring (`UPSTASH_REDIS_REST_URL`/`_TOKEN`) and the
  memory-fallback contract for local `bun --hot` dev.
- Cache-key design, TTL discipline, eviction posture, and the read-spike R-SCALE pattern for any new
  cached route or panel.
- Generic Redis knowledge (data structures, locks, streams, pub/sub) as reusable theory, always
  annotated with what Upstash REST does and does NOT support.

**This skill does NOT own (route elsewhere):**
- **What gets cached in finance** (TTL choices per series, the cron warmer, the per-minute *vendor*
  budget) → **finance-markets**. This skill owns the *cache mechanism*; that skill owns the *finance
  data + budgets*.
- The **durable source of truth** (Postgres) → **prisma**. Redis here is an ephemeral derived store;
  never the system of record.
- The **semantic-answer cache** (pgvector, embeddings, cosine `<=>`) → **rag-retrieval**. That is a
  *Postgres* cache, not Redis — different store, different skill.
- **Live price fan-out transport** (the worker → Supabase Realtime → `use-live-prices`) →
  **supabase** / **finance-markets**. Upstash REST cannot hold a `SUBSCRIBE`; real-time push uses
  Supabase Realtime, not Redis Pub/Sub.
- **Wiring an Upstash mock into a test** → **backend-testing**.

---

## Decision Tree

```
Cache / limit / lock task arrives
|
+-- "How is the cache wired here? getOrRefresh/stale/in-flight/warmer" -> lumina-upstash-cache.md
+-- "The @upstash/redis REST client; why REST on Vercel; commands" ----> patterns-upstash-rest-client.md
+-- "Which Redis data structure? String/Hash/List/Set/ZSet/Stream" ----> theory-redis-data-model.md
+-- "Caching strategy: cache-aside, TTL+jitter, stampede, invalidation" -> patterns-caching-strategies.md
+-- "A lock / idempotency key / atomic counter / contested write" -----> patterns-locks-and-rate-limiting.md
+-- "Streams / queues / pub-sub fan-out (and the REST SUBSCRIBE limit)" -> patterns-streams-and-pubsub.md
+-- "Key naming / TTL policy / eviction / unbounded keyspace / memory" -> patterns-keys-ttl-and-eviction.md
+-- "Upstash docs / @upstash/ratelimit / Redis command ref / reading" -> resources.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Use Upstash over REST (`@upstash/redis`) — never a TCP/socket client on Vercel.** Serverless functions are stateless and freeze between requests; only an HTTP-per-command client survives. | `cache.ts`/`ratelimit.ts` `new Redis({ url, token })`. |
| 2 | **Every cache write has a TTL.** No unbounded keys. The Redis hard-TTL is the soft TTL × `HARD_TTL_MULTIPLIER` so a stale value survives long enough to be a fallback; the in-memory fallback is capped (`MEM_MAX_ENTRIES`) and evicts oldest-inserted. | `cache.ts` `writeEntry`, `memSet`. |
| 3 | **Serve stale instantly, revalidate in the background.** A stale-but-present value returns in ~ms while one background refresh runs; only a truly-cold key blocks on the fetch. Never make the first user after a TTL lapse wait on a slow upstream. | `cache.ts` `getOrRefresh` SWR branch. |
| 4 | **Collapse concurrent refreshes of the same key to ONE upstream call.** The `inflight` map de-dupes — the thundering-herd / cache-stampede guard that protects rate-limited upstreams. | `cache.ts` `doRefresh` + `inflight`. |
| 5 | **Degrade gracefully: serve stale on fetch error, never 500 a read you've served before.** Rethrow only when there is nothing cached at all. | `cache.ts` SWR catch; R-SCALE §C. |
| 6 | **Rate limiting fails OPEN.** A limiter outage must not take down reads — log and allow. Limits protect against abuse, not correctness. | `ratelimit.ts` `financeRateLimit` catch. |
| 7 | **Redis is a derived/ephemeral store, never the source of truth.** Code must tolerate a cold cache, an eviction, and a cold-start-wiped memory fallback. Durable data lives in Postgres (Prisma). | `cache.ts` header; routes elsewhere. |
| 8 | **Contested writes use an atomic operation, not read-then-write.** A lock is `SET key token NX PX <ttl>`, released by a Lua compare-and-delete; counters use atomic `INCR`. Never read a counter then write it back from app code. | `patterns-locks-and-rate-limiting.md`; R-SCALE §D. |
| 9 | **No persistent `SUBSCRIBE` over REST — live fan-out goes through Supabase Realtime / the worker, not Redis Pub/Sub.** Upstash REST is request/response; long-lived subscriptions aren't its model. | `patterns-streams-and-pubsub.md`; **supabase**. |
| 10 | **Mind the command-quota cost model.** Each Upstash command is a billed HTTP request; a cache HIT must cost zero upstream calls, and hot paths should not fan out into many small commands. | `patterns-upstash-rest-client.md`. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| `new Redis(host)` (ioredis/node-redis TCP) on Vercel | `@upstash/redis` REST client — survives stateless functions. |
| Caching with no TTL ("we'll invalidate manually") | TTL on every entry (+ jitter); hard-TTL keeps a stale fallback; explicit invalidation is an optimization on top. |
| Blocking the first post-TTL request on the slow upstream | Stale-while-revalidate: serve the stale copy now, refresh in the background. |
| N concurrent requests each firing the same upstream fetch | In-flight de-dupe (`inflight` map) so they share one call. |
| 500-ing a read because the upstream errored | Serve the last good value flagged `stale`; rethrow only when nothing is cached. |
| Rate limiter that fails closed (blocks on outage) | Fail open — log and allow; the limiter is a seatbelt, not a gate. |
| Treating Redis as the system of record | Postgres (Prisma) is durable truth; Redis is a derived cache. |
| `read counter → ++ → write` for stock/limits | Atomic `INCR`/guarded write; lock via `SET NX PX` + Lua compare-and-delete release. |
| Reaching for Redis Pub/Sub to push live ticks to the browser | Supabase Realtime (Broadcast) via the `worker/`; REST can't hold a subscription. |
| `KEYS pattern` / unbounded keyspace with no cap | `SCAN`; bound the keyspace and cap the in-memory fallback (`MEM_MAX_ENTRIES`). |

---

## Output Contract (what "done" looks like)

A cache/limit change is done when:
1. **Client:** Upstash REST when `UPSTASH_*` is set, with a working in-memory fallback for local dev;
   no socket client; the cache HIT path makes zero upstream calls.
2. **TTL + eviction:** every write has a soft TTL; the hard-TTL fallback window is intentional; the
   in-memory fallback is bounded; eviction posture is stated.
3. **Resilience:** stale-while-revalidate on reads, in-flight de-dupe on refresh, stale-served on
   error, limiter fails open.
4. **Contested writes:** any lock/counter/idempotency path is atomic (no read-then-write), with a TTL
   and a safe release.
5. **Scale:** for any new cached route you've answered the R-SCALE read-spike questions (what is
   cached, where, what degrades) — see `lumina-upstash-cache.md` / `patterns-caching-strategies.md`.
6. **Verified:** a cache HIT logs/serves without an upstream call; a cold MISS populates; the limiter
   429s past the window and allows on outage (or the mocked test passes — see **backend-testing**).

---

## Bundled References (8 files)

Read the one or two the task needs — never the whole folder.

### Lumina-specific (cite `file:line` in this repo)
| File | Load when |
|------|-----------|
| `lumina-upstash-cache.md` | The full cache + limiter wiring: `cache.ts` (`getOrRefresh`/`forceRefresh`/SWR/`HARD_TTL_MULTIPLIER`/`inflight`/bounded `mem`/`cacheBackend`) and `ratelimit.ts` (`@upstash/ratelimit` sliding window, fail-open), the cron/startup warmer, and the read-spike R-SCALE mapping. Start here. |

### Upstash + generic Redis (adapted, reframed for serverless)
| File | Load when |
|------|-----------|
| `patterns-upstash-rest-client.md` | The `@upstash/redis` REST client: why REST works on Vercel, env wiring, JSON auto-parse, pipelining/`MULTI` over REST, `@upstash/ratelimit`, the command-quota cost model, and what differs from ioredis/node-redis. |
| `theory-redis-data-model.md` | Choosing a data type: Strings/Hashes/Lists/Sets/Sorted Sets/Bitmaps/HyperLogLog/Geo/Streams, expiration, eviction, encodings, `SCAN`-family iteration — reframed for a single logical Upstash instance. |
| `patterns-caching-strategies.md` | Building a cache: cache-aside/read-through/write-through/write-behind, TTL + jitter, eviction policies, cache-stampede protection (request coalescing — exactly our `inflight`), invalidation, and stale-while-revalidate. |
| `patterns-locks-and-rate-limiting.md` | Coordination + contested writes: `SET NX PX` locks, safe Lua compare-and-delete release, fencing tokens, idempotency keys, atomic counters, and sliding/token/leaky-window rate limits (`@upstash/ratelimit`) — mapped to R-SCALE §D. |
| `patterns-streams-and-pubsub.md` | Durable queues + messaging: Streams (`XADD`/`XREADGROUP`/`XACK`/`XAUTOCLAIM`, capped streams, DLQ), classic Pub/Sub, and **why live browser fan-out uses Supabase Realtime instead of REST `SUBSCRIBE`**. |
| `patterns-keys-ttl-and-eviction.md` | Key naming schemes, TTL policy + jitter, eviction policy choice, the unbounded-keyspace problem (and the `MEM_MAX_ENTRIES` bound), and per-type memory modeling. |
| `resources.md` | Upstash docs (`@upstash/redis`, `@upstash/ratelimit`), the Redis command reference, the `redis-cluster` source skill as cluster prior art, and further reading. |

---

## Cross-repo prior art

- **react repo** `E:\Development\Portfolio-phase2\react\.claude\skills\redis-cluster` — the source
  skill these generic references are adapted from (cluster mechanics dropped; data-model, caching,
  locks, streams, pub/sub reframed for serverless Upstash).
- Project memory: `finance-tab-build` (the cache + rate-budget layer was built for the Finance tab).
  Verify against live code before relying on any `file:line`.
