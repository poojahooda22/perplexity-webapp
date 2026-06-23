# Redis Data Model — Types, Expiry, Eviction, Encodings, and Access Patterns

> Generic reference. Core teaching transfers to any project; Lumina (Upstash Redis over REST, Bun + Express 5 + TypeScript ESM) is used as the worked example throughout.

---

## Table of Contents

1. [Mental Model: Redis as a Typed Key–Value Store](#1-mental-model-redis-as-a-typed-key-value-store)
2. [Strings](#2-strings)
3. [Hashes](#3-hashes)
4. [Lists](#4-lists)
5. [Sets](#5-sets)
6. [Sorted Sets](#6-sorted-sets)
7. [Bitmaps](#7-bitmaps)
8. [HyperLogLog](#8-hyperloglog)
9. [Geo](#9-geo)
10. [Streams](#10-streams)
11. [Key Expiration — EXPIRE, TTL, PERSIST](#11-key-expiration--expire-ttl-persist)
12. [Eviction Policies and maxmemory](#12-eviction-policies-and-maxmemory)
13. [Internal Encodings — listpack, intset, and Memory Intuition](#13-internal-encodings--listpack-intset-and-memory-intuition)
14. [SCAN-Family Iteration vs the Dangerous KEYS](#14-scan-family-iteration-vs-the-dangerous-keys)
15. [Choosing a Type by Access Pattern + Atomicity + Memory](#15-choosing-a-type-by-access-pattern--atomicity--memory)
16. [Upstash-Specific Notes for Lumina](#16-upstash-specific-notes-for-lumina)
17. [See also](#17-see-also)

---

## 1. Mental Model: Redis as a Typed Key–Value Store

Redis is not a generic key–value store where every value is an opaque blob. Every key maps to a **typed value**, and the type determines which commands apply. The type is intrinsic — `LPUSH` on a String key returns a `WRONGTYPE` error. The type system exists so Redis can run operations that are only meaningful on a specific structure (atomic rank lookups on a Sorted Set, cardinality estimation on a HyperLogLog) entirely server-side, without the client fetching raw bytes, deserializing, mutating, and rewriting.

This matters in practice for three reasons:

1. **Atomicity**: operations on a single key are atomic. `ZINCRBY leaderboard 1 userId` reads, increments, and writes back as one step — no read-modify-write race from application code. You get serialization within a key for free.
2. **Efficiency**: a Hash stored with `HSET` is more memory-efficient than serializing a JS object to JSON and storing it as a String, especially for small objects (the `listpack` encoding, §13).
3. **Command ergonomics**: you operate on the structure, not on a serialized bag of bytes. `LRANGE queue 0 9` returns the first 10 elements; there is no `JSON.parse`, no iteration, no round-trip overhead beyond the one command.

For Lumina, Redis is a **derived, rebuildable hot cache** and a **shared rate-limit counter store**. It is not the system of record; Supabase Postgres + Prisma is. Every value Redis holds can be reconstructed from the database. That premise drives every TTL, eviction, and data-type choice below.

The Lumina Redis client is from `@upstash/redis`, which communicates over HTTP/REST and auto-parses JSON responses. All examples use the Upstash SDK unless a section explicitly notes raw Redis CLI commands for conceptual illustration.

```ts
// backend/lib/cache.ts:28–34 — the singleton
import { Redis } from "@upstash/redis";

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;
```

When `redis` is `null` Lumina falls back to an in-process bounded `Map` (500-entry LRU) for local dev.

---

## 2. Strings

### What it is

The most fundamental type. A key maps to a single value that Redis treats as a sequence of bytes — up to **512 MB**. Despite the name, the value can hold:

- Plain text (JSON, HTML snippets)
- Binary data (images, serialized protobufs)
- Integers (stored as their decimal ASCII representation; `INCR` parses and re-serializes atomically)
- Floating-point numbers (via `INCRBYFLOAT`, stored as a string representation)

### Key commands

| Command | Effect |
|---|---|
| `SET key value [EX sec] [NX\|XX]` | Write; `EX` sets TTL; `NX` = only-if-absent; `XX` = only-if-present |
| `GET key` | Read (null if absent) |
| `GETEX key [EX sec]` | Read and atomically reset TTL |
| `MGET k1 k2 …` | Multi-read in one round-trip |
| `INCR key` | Atomic +1 on an integer string; creates at 0 first |
| `INCRBY key n` | Atomic + n |
| `INCRBYFLOAT key f` | Atomic float add |
| `APPEND key value` | Append bytes; creates key if absent |
| `STRLEN key` | Byte length |
| `SETNX key value` | Legacy alias for `SET … NX`; avoid — no TTL in one command |

### Lumina usage

Lumina's `getOrRefresh` in `backend/lib/cache.ts` stores every cached market-data payload as a JSON String:

```ts
// backend/lib/cache.ts:65–71
async function writeEntry<T>(key: string, entry: Entry<T>, ttlSeconds: number): Promise<void> {
  if (redis) {
    await redis.set(key, entry, { ex: Math.max(1, Math.floor(ttlSeconds * HARD_TTL_MULTIPLIER)) });
  } else {
    memSet(key, entry as Entry<unknown>);
  }
}
```

The Upstash SDK serializes `entry` as JSON automatically. The hard TTL is `ttlSeconds × 12` so a stale value survives long past its soft TTL as a graceful-degradation fallback — if the upstream fails, the old value is still there.

Rate-limit counters (§7 Bitmaps, and the sliding-window implementation in `backend/lib/ratelimit.ts`) also use String/integer commands under the hood in `@upstash/ratelimit`.

### When to use Strings

- Any opaque payload you serialize yourself (JSON market data, academic paper cards, cached HTML).
- Atomic counters: rate-limit windows, view counts, sequence generators.
- Simple flags and configuration values.

### Anti-pattern

Do **not** store structured objects as JSON Strings when you need to read or update individual fields frequently. Fetching a 10-field JSON blob to change one field burns bandwidth and requires a read-modify-write cycle. Use a Hash instead.

---

## 3. Hashes

### What it is

A Hash maps a key to a **flat dictionary of field → value pairs** (both field names and values are strings). Think of it as a Redis row: one key holds multiple named columns. All field operations are O(1) for single-field access, O(N) for full scans.

### Key commands

| Command | Effect |
|---|---|
| `HSET key f1 v1 [f2 v2 …]` | Set one or more fields |
| `HGET key field` | Read one field |
| `HMGET key f1 f2 …` | Read multiple fields in one round-trip |
| `HGETALL key` | Read all fields + values (O(N) — avoid on large hashes) |
| `HINCRBY key field n` | Atomic integer increment on a field |
| `HINCRBYFLOAT key field f` | Atomic float increment |
| `HDEL key f1 f2 …` | Delete fields |
| `HEXISTS key field` | Boolean field presence check |
| `HLEN key` | Number of fields |
| `HSCAN key cursor [MATCH pat] [COUNT n]` | Safe partial iteration (see §14) |

### Memory advantage: listpack encoding

For small hashes (≤ 128 fields, each value ≤ 64 bytes by default), Redis uses a compact **listpack** encoding (§13) instead of a real hash table. A listpack-encoded hash with 10 fields uses roughly **one-tenth** the memory of 10 separate String keys containing the same values. This is the primary reason to prefer Hashes for objects with many fields.

### When to use Hashes

- **Per-user or per-entity data** where you want to read/update fields independently: `user:profile:42`, `connector:gmail:userId`, `session:sid`.
- **Token-bucket state** for rate limiting: `rl:tb:userId` → `{ tokens, ts }`. One Hash key, two fields, single-slot atomic update via Lua.
- **Partial cache invalidation**: update one field without touching others.

### Lumina example — Gmail connector metadata

The `GmailConnection` model in Prisma holds per-user Gmail state. When this data needs a Redis hot path (e.g. checking if a user has an active connector before routing an AI tool call), storing it as a Hash rather than a JSON String lets the backend read only `googleEmail` or check `scopes` without deserializing the full record:

```ts
// Conceptual — the gmail connector hot-path check
await redis.hset(`connector:gmail:${userId}`, {
  googleEmail: conn.googleEmail,
  scopes: conn.scopes,
  validUntil: String(Date.now() + 55 * 60_000), // proactive refresh window
});
await redis.expire(`connector:gmail:${userId}`, 3600);

// Later, read only what's needed
const googleEmail = await redis.hget(`connector:gmail:${userId}`, "googleEmail");
```

---

## 4. Lists

### What it is

An ordered sequence of String values, implemented as a doubly linked list (for large sizes) or a listpack (for small ones). Supports O(1) push/pop from either end and O(N) random access by index. The canonical data structure for queues, stacks, and bounded log buffers.

### Key commands

| Command | Effect |
|---|---|
| `LPUSH key v1 [v2 …]` | Prepend (left push); returns new length |
| `RPUSH key v1 [v2 …]` | Append (right push) |
| `LPOP key [count]` | Pop from left (head) |
| `RPOP key [count]` | Pop from right (tail) |
| `LRANGE key start stop` | Slice (0-indexed; `-1` = last element) |
| `LLEN key` | Length |
| `LINDEX key idx` | Element at index (O(N)) |
| `LINSERT key BEFORE\|AFTER pivot value` | Insert relative to pivot (O(N)) |
| `LTRIM key start stop` | Keep only the slice (O(N)); discard the rest |
| `LPOS key element [RANK r] [COUNT c]` | Find positions of element |

### Queue pattern

A queue is RPUSH (enqueue) + LPOP (dequeue). For a durable work queue backed by Redis, prefer Streams (§10) which add consumer groups and at-least-once delivery. Use a plain List only for best-effort, single-consumer queues or for bounded buffers.

```ts
// Bounded recent-query log: keep last 100 queries per user
await redis.lpush(`history:${userId}`, JSON.stringify(queryEntry));
await redis.ltrim(`history:${userId}`, 0, 99);  // keep newest 100
await redis.expire(`history:${userId}`, 7 * 24 * 3600); // 1 week TTL
```

### Lumina usage

A List is the right shape for a per-user **recent search history** or **conversation breadcrumb** that needs to display the last N items. `LPUSH` + `LTRIM` + `LRANGE` gives you an O(1) insertion into a bounded recency list without ever scanning the full list.

### Anti-pattern

Do **not** use `LINDEX` or `LINSERT` in a hot path — they are O(N) on a linked list. If you need random access by index frequently, you probably want a Sorted Set (§6) scored by insertion order.

---

## 5. Sets

### What it is

An unordered collection of unique String members. Membership tests and add/remove are O(1). Supports server-side set algebra: union, intersection, difference.

### Key commands

| Command | Effect |
|---|---|
| `SADD key m1 [m2 …]` | Add members; ignores duplicates; returns count added |
| `SREM key m1 [m2 …]` | Remove members |
| `SISMEMBER key member` | O(1) membership test |
| `SMISMEMBER key m1 m2 …` | Batch membership test |
| `SMEMBERS key` | All members (O(N) — avoid on large sets) |
| `SCARD key` | Cardinality |
| `SRANDMEMBER key [count]` | Random member(s) without removal |
| `SPOP key [count]` | Random member(s) with removal |
| `SUNION k1 k2 …` | Union (returns result) |
| `SINTER k1 k2 …` | Intersection |
| `SDIFF k1 k2 …` | Difference |
| `SUNIONSTORE dest k1 k2` | Union + store result as a new Set |
| `SSCAN key cursor …` | Safe iteration (§14) |

### Memory: intset encoding

For small integer-only sets (up to 512 members by default, all values fitting in 64-bit signed int), Redis uses a compact **intset** array (§13). A set of 200 user IDs stored as integers is tiny. Once a non-integer member is added or the count exceeds 512, Redis promotes to a hash table — opaque to you, but worth knowing when sizing.

### When to use Sets

- **Tags, roles, permissions**: `tags:article:123`, `roles:user:42`.
- **"Already seen" deduplication**: `notified:userId` holds IDs of items already shown.
- **Dependency tracking for cache invalidation**: `deps:marketData:AAPL` holds all cache keys that depend on AAPL data. On update, `SMEMBERS deps:marketData:AAPL` → delete each key.
- **Online presence**: set of currently-connected user IDs (TTL on the key, or per-member EXPIRE via a Sorted Set scored by heartbeat time — see §6).

### Lumina example — connector dependency tracking

```ts
// When caching a response that includes Gmail data, record which cache keys
// depend on this user's Gmail connection, so they can be invalidated on token revoke.
await redis.sadd(`deps:gmail:${userId}`, `cache:ask:${conversationId}`);
await redis.expire(`deps:gmail:${userId}`, 86400);

// On connector revoke:
const dependentKeys = await redis.smembers(`deps:gmail:${userId}`);
if (dependentKeys.length > 0) {
  // Pipeline individual DELs (single-key each, routes automatically)
  await Promise.all(dependentKeys.map((k) => redis.del(k)));
}
await redis.del(`deps:gmail:${userId}`);
```

---

## 6. Sorted Sets

### What it is

An ordered set where every member is unique and carries a **floating-point score**. Members are always kept sorted by score (ascending). Because the ordering is maintained by a skip list + hash table internally, most operations are O(log N). This is the most powerful general-purpose data structure in Redis.

### Key commands

| Command | Effect |
|---|---|
| `ZADD key [NX\|XX] [GT\|LT] [CH] [INCR] score member` | Add or update; `NX` = only new; `GT`/`LT` = only if greater/less-than current |
| `ZREM key member [member …]` | Remove |
| `ZSCORE key member` | Score of member (O(1)) |
| `ZINCRBY key delta member` | Atomic score increment |
| `ZRANK key member [WITHSCORE]` | 0-based rank (ascending); O(log N) |
| `ZREVRANK key member` | Rank descending |
| `ZRANGE key start stop [BYSCORE\|BYLEX] [REV] [LIMIT off cnt] [WITHSCORES]` | Unified range query (Redis 6.2+) |
| `ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT off cnt]` | Range by score |
| `ZRANGEBYLEX key min max` | Range by lex order (all scores equal) |
| `ZCARD key` | Count of members |
| `ZCOUNT key min max` | Count in score range |
| `ZPOPMIN key [count]` / `ZPOPMAX key [count]` | Pop lowest/highest scored |
| `ZMSCORE key m1 m2 …` | Batch score lookup |
| `ZSCAN key cursor …` | Safe iteration (§14) |

### The score as a multipurpose slot

The float score can encode multiple semantics:

- **Timestamp** (Unix ms): use the set as a sliding-window log or an expiry-aware "last seen" registry.
- **Rank**: leaderboard where score = total points.
- **Priority**: task queue where lower score = higher urgency.
- **Version/sequence**: monotone counter.

### Lumina usage

**Rate-limit sliding-window log**: the `@upstash/ratelimit` library Lumina uses (`backend/lib/ratelimit.ts`) implements the sliding window as a Sorted Set keyed by user/IP. Each request adds a member scored by `Date.now()` ms; entries older than the window are pruned with `ZREMRANGEBYSCORE key 0 (now - windowMs)`. `ZCARD` returns the current count. All three ops happen in one Lua script — single-key, fully atomic.

**Leaderboard / analytics ranking**: if Lumina adds a "top searches" or "trending finance symbols" feature, a Sorted Set is the natural store:

```ts
// Record that a symbol was searched; increment its score.
await redis.zincrby("trending:finance:symbols", 1, "AAPL");

// Fetch top 10 by score (descending).
const top10 = await redis.zrange("trending:finance:symbols", 0, 9, { rev: true, withScores: true });
// top10 = [{ member: "AAPL", score: 342 }, ...]
```

**Per-user connector heartbeat / online presence**: store users with score = `Date.now()`. To prune stale users, `ZREMRANGEBYSCORE key 0 (now - timeoutMs)`.

### The `GT`/`LT` flags (Redis 3.0.2+)

`ZADD key GT score member` updates the score **only if** `score > currentScore`. This is atomic "take the maximum" — essential for last-write-wins semantic counters or for ensuring a cache TTL never shortens when extended:

```ts
// Extend a sliding session's expiry only if the new one is further in the future
await redis.zadd("sessions:active", { gt: true }, Date.now() + 30 * 60_000, sessionId);
```

---

## 7. Bitmaps

### What it is

Bitmaps are not a distinct type — they are a **String value treated as a bit array** via dedicated commands (`SETBIT`, `GETBIT`, `BITCOUNT`, `BITOP`, `BITPOS`). Each byte of the string provides 8 addressable bits. A bitmap of N bits occupies ⌈N/8⌉ bytes, making it extremely memory-efficient for dense boolean flags over a large integer domain.

### Key commands

| Command | Effect |
|---|---|
| `SETBIT key offset 0\|1` | Set bit at offset |
| `GETBIT key offset` | Read bit at offset |
| `BITCOUNT key [start end [BYTE\|BIT]]` | Count of set bits (optionally in a byte/bit range) |
| `BITPOS key bit [start [end [BYTE\|BIT]]]` | Position of first 0 or 1 bit |
| `BITOP AND\|OR\|XOR\|NOT destkey k1 [k2 …]` | Bitwise op; result stored in `destkey` |

### When to use Bitmaps

- **Daily/weekly activity tracking per user**: `active:users:2025-01-15` is a bitmap where bit `userId` is 1 if the user was active on that day. `BITCOUNT` gives DAU. `BITOP AND dest active:users:2025-01-14 active:users:2025-01-15` gives users active on both days — all with sub-millisecond O(N/8) operations.
- **Feature flags over millions of users**: one bit per user, one key per flag.
- **Visited/unvisited states**: `seen:quiz:${quizId}` — bit per question ID.

### Memory math

Tracking 10 million users' daily activity requires 10,000,000 / 8 = **1.25 MB per day**. 30 days of activity data fits in 37.5 MB — far cheaper than a Set of active user IDs (which would be O(N) strings).

### Lumina relevance

Lumina does not yet use bitmaps, but a "daily active users" metric or "which users have seen the finance tutorial" feature would be naturally expressed as a bitmap. The key insight: when the domain is an integer (user ID, article ID) and the value is boolean, prefer a bitmap over a Set.

---

## 8. HyperLogLog

### What it is

A probabilistic data structure for **cardinality estimation** — counting the number of distinct elements added to it — using a fixed ~12 KB of memory regardless of input size, with a standard error of **≈ 0.81%**. It uses the HLL++ algorithm. You can add elements and query the count, but you cannot retrieve the elements themselves (it is not a set).

### Key commands

| Command | Effect |
|---|---|
| `PFADD key element [element …]` | Add one or more elements |
| `PFCOUNT key [key …]` | Estimated distinct count (can span multiple HLL keys) |
| `PFMERGE destkey k1 [k2 …]` | Merge multiple HLLs into one |

### When to use HyperLogLog

Use it when you need **approximate distinct counts over large streams and memory is constrained**:

- Unique search queries per day: `PFADD unique:searches:2025-01-15 "AAPL stock price"` / `PFCOUNT unique:searches:2025-01-15`.
- Distinct Lumina users who ran a finance query this week.
- Distinct article DOIs fetched via the Academic vertical.

Use a plain Set instead when you need exact counts, need to enumerate the members, or the domain is small enough that a Set's memory cost is acceptable.

### Example

```ts
// Log a unique user ID to today's HLL; increment nothing if already counted
await redis.pfadd(`hll:unique:finance:${todayStr}`, userId);

// Query — approximately how many distinct users used finance today?
const approxCount = await redis.pfcount(`hll:unique:finance:${todayStr}`);
```

This costs at most ~12 KB no matter how many users Lumina has. A plain Set would cost O(number of distinct users × average key size).

---

## 9. Geo

### What it is

Geo commands provide **geospatial indexing** on top of a Sorted Set. Latitude/longitude pairs are encoded into a 52-bit integer (a Geohash variant) and stored as the ZSet score. This gives you proximity searches and distance calculations without any external spatial index.

### Key commands

| Command | Effect |
|---|---|
| `GEOADD key [NX\|XX\|CH] lng lat member [lng lat member …]` | Add or update points |
| `GEODIST key m1 m2 [m\|km\|mi\|ft]` | Distance between two members |
| `GEOPOS key member [member …]` | Longitude/latitude of members |
| `GEOSEARCH key FROMMEMBER member\|FROMLONLAT lng lat BYRADIUS r unit\|BYBOX w h unit ASC\|DESC [COUNT n] [WITHCOORD] [WITHDIST]` | Proximity search (Redis 6.2+; replaces `GEORADIUS`) |
| `GEOSEARCHSTORE dest key …` | Proximity search + store result as a ZSet |
| `GEOHASH key member [member …]` | Standard 11-char Geohash for each member |

### Precision

The encoding has a precision of about **0.6 mm** at the equator. More than sufficient for any practical "nearby" feature. Because it is stored as a ZSet, `GEOSEARCH` is O(N + log M) where N is the number of results and M is the total set size — fast for reasonable result counts.

### Lumina relevance

Lumina's current verticals are information-based and do not require spatial queries. Geo becomes relevant if a Health vertical gains "nearby clinics" search, a Finance vertical gains "nearest ATM" or branch locator, or a news feed gains geofenced content. The pattern is straightforward:

```ts
// Populate (one-time or via cron)
await redis.geoadd("clinics:nyc",
  -73.985130, 40.758896, "clinic:mount-sinai",
  -73.990143, 40.750580, "clinic:nyu-langone",
);

// Query: clinics within 5 km of a user
const nearby = await redis.geosearch("clinics:nyc",
  { fromlonlat: { longitude: userLng, latitude: userLat } },
  { byRadius: { radius: 5, unit: "km" } },
  { asc: true, count: 10, withCoord: true, withDist: true },
);
```

---

## 10. Streams

### What it is

A Stream is a **persistent, append-only log of entries**, where each entry is an auto-ID'd (or explicit-ID'd) dictionary of field → value pairs. Redis Streams are the closest Redis comes to Kafka: they support **consumer groups** with at-least-once delivery, message acknowledgement (`XACK`), and dead-letter recovery (`XAUTOCLAIM`). Unlike Lists, messages are never deleted by a read — consumers explicitly acknowledge them.

### Key commands

| Command | Effect |
|---|---|
| `XADD key [MAXLEN [~] N] * field value [field value …]` | Append entry; `*` = auto-ID; `MAXLEN ~` caps stream length approximately |
| `XLEN key` | Entry count |
| `XRANGE key - + [COUNT n]` | Read entries between IDs (`-` = first, `+` = last) |
| `XREVRANGE key + - [COUNT n]` | Reverse read |
| `XREAD [COUNT n] [BLOCK ms] STREAMS key [key …] id [id …]` | Read new entries (simple consumer, no group) |
| `XGROUP CREATE key group id [MKSTREAM]` | Create a consumer group |
| `XREADGROUP GROUP group consumer [COUNT n] [BLOCK ms] STREAMS key >` | Read pending entries for group (`>` = undelivered) |
| `XACK key group id [id …]` | Acknowledge processing |
| `XAUTOCLAIM key group consumer min-idle-ms start-id [COUNT n]` | Reclaim idle PEL entries for dead consumers |
| `XPENDING key group [IDLE ms] [start end count]` | Inspect unacknowledged entries |
| `XTRIM key MAXLEN [~] N` | Trim to max entries |

### When to use Streams

- **Durable async pipelines**: write-behind persistence (update Redis, enqueue the Postgres write to a Stream, a worker drains it). Unlike a List queue, a crash before `XACK` leaves the message in the pending-entry list — the worker reclaims it.
- **Event log / audit trail**: immutable record of user actions.
- **Fan-out to multiple consumers**: each consumer group independently tracks its own read position.

### Lumina usage

Lumina's current write path is synchronous (stream AI response → persist conversation + messages via Prisma before `res.end()`). A Stream is the right upgrade path if the persist step becomes a bottleneck: the backend writes to Postgres synchronously for the happy path, but offloads heavy async work (email notifications, analytics events, Gmail scheduling confirmations) to a Stream consumed by the `worker/` on Fly.io (which is exempt from Vercel's socket/timer restrictions).

```ts
// Enqueue a Gmail send scheduled by the AI tool for async execution in worker/
await redis.xadd(
  "jobs:gmail:send",
  { MAXLEN: ["~", 10_000] },
  "*",
  "userId", userId,
  "to", to,
  "subject", subject,
  "bodyB64", Buffer.from(body).toString("base64"),
  "scheduledAt", String(scheduledAt),
);
```

The `worker/` process runs `XREADGROUP GROUP gmailSender consumer1 BLOCK 5000 STREAMS jobs:gmail:send >`, executes the Gmail API call, and `XACK`s on success. `XAUTOCLAIM` rescues messages that a dead consumer left unacknowledged.

---

## 11. Key Expiration — EXPIRE, TTL, PERSIST

### The two expiration mechanisms

Redis expires keys via two complementary mechanisms:

1. **Lazy expiration**: when a key is accessed, Redis checks its expiry time and deletes it if past. Zero background cost; trades off accuracy (a truly cold expired key stays in memory until accessed).
2. **Active expiration**: a background task runs ~10 times per second, sampling random volatile keys and deleting expired ones. This bounds memory leakage from cold keys.

Together they approximate "keys disappear shortly after their TTL elapses," with an accuracy of roughly within seconds for hot keys and up to minutes for cold keys.

### Commands

| Command | Effect |
|---|---|
| `EXPIRE key seconds` | Set TTL in seconds from now |
| `PEXPIRE key ms` | Set TTL in milliseconds |
| `EXPIREAT key unixTimestamp` | Set absolute expiry (Unix seconds) |
| `PEXPIREAT key unixMs` | Set absolute expiry (Unix ms) |
| `TTL key` | Remaining TTL in seconds; `-1` = no expiry; `-2` = absent |
| `PTTL key` | Remaining TTL in ms |
| `EXPIRETIME key` | Absolute expiry as Unix seconds (Redis 7.0+) |
| `PEXPIRETIME key` | Absolute expiry as Unix ms (Redis 7.0+) |
| `PERSIST key` | Remove TTL (make key permanent) |

### Flags on EXPIRE (Redis 7.0+)

`EXPIRE key seconds [NX|XX|GT|LT]`

- `NX` — set TTL only if key has **no** TTL yet.
- `XX` — set TTL only if key **already has** a TTL.
- `GT` — set TTL only if the new TTL is **greater** than the current (never shorten).
- `LT` — set TTL only if the new TTL is **less** than the current (never extend).

`GT` is the key one for sliding sessions: `EXPIRE session:sid 1800 GT` extends the session without ever accidentally shortening it if a slow request fires late.

### How TTL drives Lumina's cache

`backend/lib/cache.ts` uses two TTL values for every entry:

| TTL name | Value | Purpose |
|---|---|---|
| **Soft TTL** | Caller-supplied `ttlSeconds` | Staleness decision in `getOrRefresh` |
| **Hard TTL** | `ttlSeconds × 12` | Redis `EX` that actually expires the key |

The soft TTL controls when `getOrRefresh` triggers a background refresh (stale-while-revalidate). The hard TTL is 12× longer so the stale value survives in Redis as a graceful-degradation fallback: if the upstream API is down, Lumina serves a stale finance quote rather than returning a 500. The hard TTL is only the backstop; it is not the freshness window.

```ts
// backend/lib/cache.ts:93–117 — soft vs hard TTL in action
if (existing && now - existing.fetchedAt < ttlSeconds * 1000) {
  return { data: existing.data, fetchedAt: existing.fetchedAt, stale: false, hit: true };
}
if (existing) {
  // Serve stale instantly; background refresh doesn't block this response.
  void doRefresh(key, ttlSeconds, fetcher).catch(/* warn */);
  return { data: existing.data, fetchedAt: existing.fetchedAt, stale: true, hit: true };
}
// Cold cache — block once on the fetch.
const data = await doRefresh(key, ttlSeconds, fetcher);
return { data, fetchedAt: now, stale: false, hit: false };
```

### TTL jitter

If many cache keys are populated at the same moment (e.g., a cron warming N finance symbols), giving them identical TTLs causes a **synchronized expiry stampede**: all N miss at once and hammer the upstream. Add ±10% random jitter:

```ts
function withJitter(ttlSeconds: number, ratio = 0.1): number {
  const delta = ttlSeconds * ratio;
  return Math.max(1, Math.round(ttlSeconds + (Math.random() * 2 - 1) * delta));
}
```

A ±10% jitter on a 60-second TTL spreads expiries over a 12-second window — sufficient to smooth the load curve.

---

## 12. Eviction Policies and maxmemory

### Why eviction exists

TTLs are the plan; **eviction is the safety net**. When Redis's memory usage reaches `maxmemory`, it must evict keys before accepting new writes. The policy determines which keys to sacrifice.

Upstash Free / Pay-as-you-go instances have a fixed storage ceiling. Lumina's Upstash instance should be configured with an appropriate policy so it degrades gracefully (discards cache) rather than hard-failing writes.

### Policies

| Policy | Eligible pool | Algorithm | Use for |
|---|---|---|---|
| `noeviction` | — | Reject writes with OOM | **Never** for a pure cache; only if Redis is a system of record |
| `allkeys-lru` | All keys | Approximate LRU (least recently used) | **Default for caches** — evict cold keys |
| `allkeys-lfu` | All keys | Approximate LFU (least frequently used) | Caches with skewed popularity — a few hot keys dominate |
| `allkeys-random` | All keys | Random | Rarely; when no temporal or frequency locality |
| `volatile-lru` | Keys with TTL | LRU among expiring | Mixed cache + permanent keys in one instance |
| `volatile-lfu` | Keys with TTL | LFU among expiring | Same, with frequency skew |
| `volatile-ttl` | Keys with TTL | Shortest TTL first | When TTL encodes priority |
| `volatile-random` | Keys with TTL | Random among expiring | Rarely |

### LRU vs LFU — the decision

**LRU** evicts what was used least *recently*. Ideal when "recently used = likely to be needed again" (temporal locality). Weakness: a burst of one-time reads (e.g. loading the full academic paper list for one export) can evict genuinely hot keys.

**LFU** evicts what was used least *frequently* over time. It uses a logarithmic access counter with time-based decay. LFU resists scan pollution and retains truly hot keys (the top 10 finance symbols, the homepage feed). Prefer **`allkeys-lfu`** if Lumina's keyspace has clear popularity skew — which it does: a handful of symbols (`AAPL`, `TSLA`, `BTC-USD`) receive the majority of requests.

```ini
# redis.conf (relevant for self-managed Redis; on Upstash, configure via the dashboard)
maxmemory 512mb
maxmemory-policy allkeys-lfu
lfu-log-factor 10       # higher = slower saturation, better distinction between hot keys
lfu-decay-time 1        # minutes of inactivity before counter decays one step
```

### The `volatile-*` trap

If you choose a `volatile-*` policy, **every cache key must have a TTL**. A cache key without a TTL is invisible to the eviction pool. If enough no-TTL keys accumulate, the eligible pool shrinks to nothing and Redis returns OOM errors as if `noeviction`. Rule of thumb: if you use `volatile-*`, lint every `SET` call to confirm it includes `EX`/`PX`. For a pure cache with no permanent keys, **`allkeys-lru`** or **`allkeys-lfu`** is safer — eviction can always make progress.

### Observing eviction

On Upstash, check the **Metrics** tab in the dashboard. On self-managed Redis:

```bash
redis-cli INFO stats | grep evicted_keys
redis-cli INFO memory | grep -E 'used_memory:|maxmemory:|mem_fragmentation_ratio'
```

A non-zero and growing `evicted_keys` paired with a high miss rate signals the cache is undersized. Options: increase `maxmemory`, shorten TTLs, or reduce the cached key count.

---

## 13. Internal Encodings — listpack, intset, and Memory Intuition

Redis stores the same logical type in different internal binary formats depending on the size and content of the value. You do not choose the encoding; Redis promotes automatically based on configurable thresholds. Understanding encodings helps you reason about memory and avoid accidental promotions.

### listpack (formerly ziplist)

A **listpack** is a contiguous byte array that stores entries sequentially with no pointers. It is cache-friendly, compact (no per-entry overhead beyond the entry size), and O(N) to scan. Redis uses it for:

- **Hashes** with ≤ 128 fields where each value is ≤ 64 bytes: `hash-max-listpack-entries 128`, `hash-max-listpack-value 64`.
- **Sorted Sets** with ≤ 128 members where each member string is ≤ 64 bytes: `zset-max-listpack-entries 128`, `zset-max-listpack-value 64`.
- **Lists** with ≤ 128 elements where each element is ≤ 64 bytes: `list-max-listpack-size 128`.

A listpack-encoded Hash with 10 small fields uses roughly **1/5 the memory** of a hash-table Hash, because there is no hash-table overhead (pointers, load-factor slack, etc.). Once either threshold is exceeded, Redis promotes to the "real" structure (hash table for Hashes, skip list + hash table for Sorted Sets, doubly linked list for Lists). **Promotion is one-way and irreversible** during the key's lifetime — removing elements does not demote back.

**Design implication**: keep per-key data small and use many keys rather than one giant key. A single Hash with 10,000 fields will promote and consume far more memory than 100 Hashes with 100 fields each.

### intset

An **intset** is a sorted integer array used for **Sets whose members are all integers** and the count is ≤ 512 (default). Membership test is a binary search — O(log N), still fast for small sets. Storing 200 user IDs as an intset uses roughly 200 × 8 = 1.6 KB. The moment a non-integer member is added or the count exceeds 512, Redis promotes to a hash table.

### skiplist (Sorted Sets)

The full Sorted Set encoding is a **skip list** (for ordered range scans, O(log N)) combined with a **hash table** (for O(1) score lookup by member). The dual structure is why both `ZSCORE` (O(1)) and `ZRANGE` (O(log N + M)) are fast.

### Checking the current encoding

```bash
redis-cli OBJECT ENCODING mykey
# Returns: "listpack", "hashtable", "intset", "skiplist", "embstr", "raw", etc.
```

`embstr` is a String ≤ 44 bytes stored inline with the Redis key object; `raw` is a separate SDS (Simple Dynamic String) allocation for longer strings. This matters only if you are micro-optimizing per-key memory.

### Upstash encoding behavior

Upstash Redis is Redis-compatible and respects the same encoding thresholds. You cannot set `redis.conf` parameters on Upstash's managed instances; the thresholds are fixed at the Redis defaults. Design your key shapes to stay within listpack/intset bounds for the hot portion of your keyspace.

---

## 14. SCAN-Family Iteration vs the Dangerous KEYS

### Why `KEYS` is dangerous

`KEYS pattern` returns all matching keys. It is O(N) over the entire keyspace and **blocks Redis's single thread for the full scan duration**. On a 10M-key instance a `KEYS *` can block for seconds, stalling every other command. Never run `KEYS` in production. Never call it from application code. The only acceptable use is administrative inspection on a non-production instance.

The same reasoning applies to `SMEMBERS` on a large set, `HGETALL` on a large hash, `LRANGE key 0 -1` on a long list — any O(N) full-scan command on an unbounded collection.

### SCAN — the safe alternative

`SCAN cursor [MATCH pattern] [COUNT hint] [TYPE type]` iterates the keyspace **incrementally** using a cursor. It is O(1) per call, never blocks for long, and is designed to be called in a loop:

```ts
async function scanAll(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: pattern, count: 100 });
    keys.push(...batch);
    cursor = Number(nextCursor);
  } while (cursor !== 0);
  return keys;
}
```

**SCAN guarantees**:
- **Full coverage**: a complete cursor cycle (from 0 back to 0) returns every key that existed throughout the scan.
- **No missed keys**: a key that existed from the start of the scan to the end will appear.
- **Possible duplicates**: a key may appear more than once (concurrent rehashing). Deduplicate with a Set if needed.
- **Not a snapshot**: keys written or deleted during the scan may or may not appear.

`COUNT hint` is advisory — Redis may return fewer or more per call. Do not rely on it for exact batch sizing.

### SCAN family

| Command | Iterates | Match / Count support |
|---|---|---|
| `SCAN` | Global keyspace | Yes |
| `HSCAN key cursor` | Fields of a Hash | Yes |
| `SSCAN key cursor` | Members of a Set | Yes |
| `ZSCAN key cursor` | Member + score pairs of a Sorted Set | Yes |

All four share the same cursor mechanics and guarantees.

### Lumina's in-memory fallback and KEYS

Lumina's in-memory `Map` fallback (`backend/lib/cache.ts:43–52`) has a 500-entry LRU cap and is iterated safely via `map.keys()` during `memSet` eviction. This is safe because a 500-entry Map is trivially small. The Redis keyspace has no such bound — never iterate it with `KEYS`.

---

## 15. Choosing a Type by Access Pattern + Atomicity + Memory

This section is the practical decision table. Pick the type that matches how you **read and write**, not how you think of the data logically.

| You need to… | Type | Key command |
|---|---|---|
| Cache an opaque serialized payload (JSON, binary) | **String** | `SET … EX` / `GET` |
| Atomic counter (rate-limit window, view count) | **String** | `INCR` / `INCRBY` |
| Store a structured object and update/read individual fields | **Hash** | `HSET` / `HGET` / `HINCRBY` |
| Keep the N most recent items (bounded queue/log) | **List** | `LPUSH` + `LTRIM` + `LRANGE` |
| Work queue (at-most-once, no durability needed) | **List** | `RPUSH` / `LPOP` |
| Durable async pipeline (at-least-once, survives crash) | **Stream** | `XADD` / `XREADGROUP` / `XACK` |
| Membership test, dedup, tag/permission set | **Set** | `SADD` / `SISMEMBER` |
| Union / intersection over multiple groups | **Set** | `SUNION` / `SINTER` |
| Small integer-set membership (user IDs) | **Set** | `SADD` (intset encoding auto-applied) |
| Ordered leaderboard / ranking | **Sorted Set** | `ZADD` / `ZRANGE … REV` / `ZINCRBY` |
| Rate-limit sliding-window log | **Sorted Set** | `ZADD` + `ZREMRANGEBYSCORE` + `ZCARD` |
| Priority queue | **Sorted Set** | `ZADD` + `ZPOPMIN` |
| Time-series approximation / recency window | **Sorted Set** | Timestamp as score |
| Dense boolean flags over large integer domain | **Bitmap** | `SETBIT` / `BITCOUNT` |
| Approximate distinct count (analytics) | **HyperLogLog** | `PFADD` / `PFCOUNT` |
| Proximity/geospatial search | **Geo** | `GEOADD` / `GEOSEARCH` |

### Atomicity dimension

Every command on a **single key** is atomic — no exceptions. The single-threaded execution model means `HINCRBY`, `ZINCRBY`, `LPUSH`, `SADD` are all read-modify-write in one step with no interleaving. This eliminates entire classes of race conditions for within-key operations.

For **multi-key** atomicity you have two options:
- **Lua scripts** (`EVAL`/`EVALSHA`): executed atomically on the server, but all keys must be in the same slot. The compare-and-delete lock release in `backend/lib/ratelimit.ts` is exactly this pattern.
- **Transactions** (`MULTI`/`EXEC` + optional `WATCH`): queues commands and executes them without interleaving; optimistic with `WATCH`. Less common in modern code; Lua is usually simpler.

### Memory dimension

Memory cost order (approximate, for equivalent logical data):

```
Bitmap < intset Set < listpack Hash/ZSet/List < String (JSON) < hash-table Hash/ZSet/List
```

For a hot, high-cardinality keyspace: keep objects within listpack/intset bounds, use TTLs on everything, and choose `allkeys-lfu` eviction.

### The Lumina cache decision

Lumina's finance/discover cache stores **opaque JSON payloads** (entire API responses, AI-generated summaries). The right type is a **String**: the value is always fetched in full, never partially updated, and the Upstash SDK handles JSON serialization automatically. A Hash would be the better choice only if Lumina needed to update individual fields (e.g., update just the price in a cached quote while keeping the rest). Since the whole response is rewritten on each cache refresh, String wins on simplicity.

---

## 16. Upstash-Specific Notes for Lumina

Upstash Redis is a **fully managed, serverless Redis** accessed via HTTP/REST. It is the only viable Redis for Vercel serverless because standard Redis clients hold persistent TCP connections, which do not survive Vercel's function isolation. Upstash's REST transport means each command is an independent HTTP request — connection overhead is amortized by Upstash's infrastructure, not the Lumina process.

### SDK behavior

```ts
import { Redis } from "@upstash/redis";
const redis = new Redis({ url: "...", token: "..." });

// Upstash auto-serializes JS values to JSON on write and parses on read.
await redis.set("key", { a: 1, b: "hello" }, { ex: 60 });
const val = await redis.get<{ a: number; b: string }>("key");
// val.a === 1 — no manual JSON.parse needed

// For atomic multi-command ops, use redis.pipeline() (batched HTTP) or redis.multi() (MULTI/EXEC):
const pipe = redis.pipeline();
pipe.incr("counter");
pipe.expire("counter", 60);
const results = await pipe.exec(); // single HTTP round-trip for both commands
```

### What Upstash does not support

- **CONFIG SET**: you cannot change `maxmemory-policy` or encoding thresholds via commands. Configure via the Upstash dashboard.
- **WAIT / OBJECT FREQ / DEBUG**: administrative commands are restricted.
- **Persistent connections / pub-sub SUBSCRIBE**: `SUBSCRIBE`/`PSUBSCRIBE` require a persistent connection; use Upstash's QStash or a Fly.io worker instead (already the architecture for WebSockets in `worker/`).
- **Lua scripts with side effects in transactions** (minor edge case): `EVALSHA` is supported; ensure scripts are deterministic.

### Rate limiting is already abstracted

`@upstash/ratelimit` (used in `backend/lib/ratelimit.ts`) provides a sliding-window rate limiter that uses the same Upstash REST client. Under the hood it uses a Sorted Set + Lua, but you interact with it purely at the `Ratelimit.slidingWindow(60, "60 s")` level. Lumina does not need to implement rate-limit commands manually.

### Key naming in Lumina

Follow a consistent pattern:

```
<vertical>:<entity>:<id>[:<subresource>]
```

Examples from the codebase (inferred from cache.ts and ratelimit.ts):

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `finance:quote:<symbols>` | String (JSON) | soft 30s, hard 360s | Cached market quote |
| `finance:summary:<symbol>` | String (JSON) | soft 300s, hard 3600s | AI-generated stock summary |
| `rl:finance:<ip>` | (managed by Upstash ratelimit) | 60s window | Finance rate-limit counter |
| `cache:discover:academic:<query>` | String (JSON) | soft 600s, hard 7200s | Academic search results |

Never store user credentials, tokens, or PII directly in Redis keys or values without encryption. Gmail refresh tokens are stored encrypted in Postgres (`GmailConnection.refreshTokenEnc`), not in Redis.

---

## 17. See also

**Within the redis skill (sibling references):**
- `patterns-cache-strategies.md` — stale-while-revalidate, write-through, stampede cures, TTL jitter (maps to `backend/lib/cache.ts`)
- `patterns-rate-limiting.md` — sliding window, token bucket, GCRA; how `@upstash/ratelimit` is wired in Lumina (`backend/lib/ratelimit.ts`)

**Other skills:**
- [`rag-retrieval`](.claude/skills/rag-retrieval/SKILL.md) — the semantic cache that sits in front of Postgres/pgvector uses Redis as the hot-path layer; understand `CachedQuery` and the `$queryRaw` pattern for the `vector(1536)` column
- [`finance-markets`](.claude/skills/finance-markets/SKILL.md) — the primary consumer of `getOrRefresh`; TTL policy per data source (Twelve Data, Yahoo, CoinGecko)
- [`connectors-oauth`](.claude/skills/connectors-oauth/SKILL.md) — OAuth token caching and connector hot-path checks use Hash keys; Gmail dependency tracking uses Sets
- [`backend-testing`](.claude/skills/backend-testing/SKILL.md) — how to mock the Redis client in unit tests; `backend/tests/helpers/` pattern
- [`lumina-frontend`](.claude/skills/lumina-frontend/SKILL.md) — the frontend never touches Redis directly; all cache interactions are backend-mediated
- [`ai-sdk-agent`](.claude/skills/ai-sdk-agent/SKILL.md) — tool calls go through the streaming pipeline; Redis is used for deduplication and rate-limiting those calls
