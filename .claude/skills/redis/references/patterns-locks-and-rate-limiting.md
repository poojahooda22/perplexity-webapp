# Distributed Coordination: Locks, Idempotency, and Rate Limiting

> Correct distributed locks, fencing tokens, idempotency keys, and atomic rate-limit counters on
> Upstash Redis — what actually works, what only appears to, and how to reason about failure on a
> Vercel + Bun + Express 5 stack.

---

## Table of Contents

1. [Mental Model: What Redis Coordination Can and Cannot Promise](#1-mental-model)
2. [Single-Instance Lock: `SET key token NX PX`](#2-single-instance-lock)
3. [Safe Release: Compare-and-Delete via Lua](#3-safe-release)
4. [A Production Lock Helper for Upstash REST](#4-a-production-lock-helper-for-upstash-rest)
5. [Lock Extension (Watchdog / Lease Renewal)](#5-lock-extension)
6. [Fencing Tokens: Guarding Against Lost Locks](#6-fencing-tokens)
7. [Redlock and Why a Single Upstash Endpoint Changes the Calculus](#7-redlock-and-upstash)
8. [Idempotency Keys for Safe Retries](#8-idempotency-keys)
9. [Atomic Counters: INCR/INCRBY and Why Read-then-Write Is Wrong](#9-atomic-counters)
10. [Rate-Limit Algorithms: Fixed Window, Sliding Window, Token Bucket, Leaky Bucket](#10-rate-limit-algorithms)
11. [`@upstash/ratelimit` — Our Sliding Window in Practice](#11-upstash-ratelimit)
12. [Fail-Open vs Fail-Closed — Our Deliberate Choice](#12-fail-open-vs-fail-closed)
13. [Mapping to R-SCALE §D (Contested Writes) and §E (Fairness)](#13-r-scale-mapping)
14. [TTL Hygiene and Clock Skew](#14-ttl-hygiene-and-clock-skew)
15. [Decision Tables](#15-decision-tables)
16. [Anti-Patterns](#16-anti-patterns)
17. [See Also](#17-see-also)

---

## 1. Mental Model

Before a single line of lock code, internalize the guarantee boundary. **Upstash Redis is a
single-primary, fully-managed store accessed over HTTPS REST** — not a Redis Cluster, not an
ioredis connection pool. Every command is one HTTPS round-trip to one endpoint. That shapes
everything below.

There are two purposes for a "lock," with radically different correctness requirements:

| Purpose | Goal | Consequence of failure | Redis suitability |
|---|---|---|---|
| **Efficiency lock** | Avoid doing the same *idempotent* work twice (regenerate cache, skip duplicate cron run) | Wasted work — annoying, not catastrophic | Single-instance `SET NX PX` is fine |
| **Correctness lock** | Guarantee strict mutual exclusion over a *non-idempotent* mutation (debit, one-time send) | Data corruption, double charge | **No pure Redis lock is sufficient.** Need fencing tokens or the invariant in an atomic DB write |

This distinction is the single most important idea here. Martin Kleppmann's critique of distributed
locks reduces to: *if you need a lock for correctness, the lock service alone cannot give it to you;
you also need the protected resource to reject stale holders (fencing).* Memorize that.

**Why pure Redis locks are not correctness locks:**

1. **TTL + process pauses.** A Vercel function can be suspended (or a Fly.io worker can GC-pause)
   for longer than the lock TTL. The lock expires, another worker acquires it, and two workers
   believe they hold it simultaneously. Heartbeats narrow this window but cannot close it.
2. **Single primary, no replication guarantee.** Upstash offers persistence and HA, but there is no
   multi-master quorum on a standard plan. A crash or failover between `SET NX OK` and the
   underlying flush loses the lock silently.

**The stance this doc takes:**

- Use `SET NX PX` locks for **efficiency** and **soft mutual exclusion** of idempotent work.
- For **correctness**, make the operation idempotent and use an **idempotency key** (§8), or push
  the invariant into a Supabase Postgres transaction where the DB row is the true mutex.

---

## 2. Single-Instance Lock

The canonical Redis lock is one atomic command:

```
SET lock:resource <random-token> NX PX 30000
```

- `NX` — set **only if Not eXists**. Redis executes commands one at a time; exactly one caller wins.
- `PX 30000` — expire in **30 000 ms**. Safety net: if the holder dies, the lock self-heals. **A
  lock without a TTL is a deadlock waiting to happen.**
- `<random-token>` — a unique, unguessable value per acquisition. Required for safe release (§3).
  Never use a constant like `"1"` or `"locked"`.

`SET key value NX PX ms` is atomic. Do **not** use `SETNX` + separate `EXPIRE` — a crash between
them leaves a never-expiring lock.

```typescript
// backend/lib/lock.ts
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Returns the token if acquired, null if the lock is already held.
export async function tryAcquire(key: string, ttlMs = 30_000): Promise<string | null> {
  const token = randomUUID();
  // @upstash/redis: set(key, value, { nx: true, px: ms }) -> "OK" | null
  const ok = await redis.set(key, token, { nx: true, px: ttlMs });
  return ok === "OK" ? token : null;
}
```

**Why the random token matters:**

```
T0  Worker A: SET lock tokenA NX PX 30000  -> OK
T1  Worker A pauses (Vercel cold-start, GC) for 40 s
T2  Lock auto-expires at T0 + 30 s
T3  Worker B: SET lock tokenB NX PX 30000  -> OK   (B now holds it)
T4  Worker A wakes, thinks it still holds the lock
T5  Worker A: DEL lock                      -> deletes B's lock!   BUG
T6  Worker C acquires; now B and C both run.  CORRUPTION.
```

The fix: release only your own token via an atomic compare-and-delete (§3).

---

## 3. Safe Release: Compare-and-Delete via Lua

Release must be atomic: read the value, compare to your token, delete only if equal. A `GET` then
`DEL` from the application is a check-then-act race — the lock can expire and be re-acquired between
the two round-trips. The solution is a server-side Lua script, run atomically:

```lua
-- release.lua  KEYS[1]=lock key  ARGV[1]=our token
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

Returns `1` if we released our own lock, `0` if the lock was already gone or held by someone else
(a signal worth logging — means we held a stale lock).

**Upstash REST Lua syntax.** Upstash's `@upstash/redis` client exposes `eval`:

```typescript
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

export async function release(key: string, token: string): Promise<boolean> {
  // eval<number>(script, keys, args)
  const released = await redis.eval<number>(RELEASE_SCRIPT, [key], [token]);
  if (released === 0) {
    console.warn(`[lock] already lost ${key} — stale-lock race; check for correctness impact`);
  }
  return released === 1;
}
```

**No `EVALSHA` needed with Upstash REST.** Upstash uses HTTP, not a persistent connection, so
EVALSHA's SHA cache doesn't help here — the REST layer handles the script. Pass the script body
every time; it's fine.

---

## 4. A Production Lock Helper for Upstash REST

A small helper encapsulates unique token generation, bounded acquire-with-retry, and atomic release.
This is an **efficiency lock** — appropriate for guarding idempotent work (cache warm, cron
de-dupe), not for correctness-critical mutual exclusion.

```typescript
// backend/lib/lock.ts
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const RELEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

export interface AcquireOptions {
  /** Lock lease in ms. Must exceed the worst-case critical-section time, with margin. */
  ttlMs?: number;
  /** Total time to spend retrying before giving up. 0 = single try. */
  acquireTimeoutMs?: number;
  /** Base retry delay; jittered to avoid thundering herds. */
  retryDelayMs?: number;
}

export interface Lock {
  key: string;
  token: string;
  /** Release iff still ours. Returns true if released, false if already lost. */
  release(): Promise<boolean>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function acquireLock(key: string, opts: AcquireOptions = {}): Promise<Lock | null> {
  const ttlMs = opts.ttlMs ?? 30_000;
  const deadline = Date.now() + (opts.acquireTimeoutMs ?? 0);
  const base = opts.retryDelayMs ?? 80;
  const token = randomUUID();

  for (;;) {
    const ok = await redis.set(key, token, { nx: true, px: ttlMs });
    if (ok === "OK") {
      return {
        key,
        token,
        release: async () => {
          const r = await redis.eval<number>(RELEASE, [key], [token]);
          return r === 1;
        },
      };
    }
    if (Date.now() >= deadline) return null; // out of time
    // full-jitter backoff — de-synchronizes contenders
    await sleep(Math.floor(Math.random() * base));
  }
}

/** Run fn while holding the lock; always release. Returns null if lock not acquired. */
export async function withLock<T>(
  key: string,
  opts: AcquireOptions,
  fn: (lock: Lock) => Promise<T>,
): Promise<T | null> {
  const lock = await acquireLock(key, opts);
  if (!lock) return null;
  try {
    return await fn(lock);
  } finally {
    await lock.release().catch(() => {/* expired; nothing to undo */});
  }
}
```

Usage — cron route that must not double-fire on concurrent Vercel invocations:

```typescript
// backend/routes/cron.ts
import { withLock } from "../lib/lock.js";

app.post("/cron/warm-cache", async (req, res) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).end();
  }
  const ran = await withLock(
    "lock:cron:warm-cache",
    { ttlMs: 55_000, acquireTimeoutMs: 0 }, // single attempt — another instance is already running
    async () => {
      await warmFinanceCache();
      return true;
    },
  );
  res.json({ ran: ran !== null, deduped: ran === null });
});
```

**Vercel serverless note.** Vercel functions can't hold long-lived in-process timers, so "watchdog"
lock renewal (§5 concept) is impractical here — every invocation is ephemeral. Size your TTL to
span the worst-case operation, plus a margin. If the work can exceed that, move it to `worker/`
(Fly.io) where processes are long-lived.

---

## 5. Lock Extension (Watchdog / Lease Renewal)

On `worker/` (Fly.io), where processes are long-lived, you can renew a short-TTL lock with an
extend script. The pattern is the same compare-then-act:

```lua
-- extend.lua  KEYS[1]=lock  ARGV[1]=token  ARGV[2]=new ttl ms
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0   -- we no longer hold it; stop
end
```

```typescript
const EXTEND = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`;

function startWatchdog(key: string, token: string, ttlMs: number): () => void {
  const intervalMs = Math.floor(ttlMs / 3);
  const timer = setInterval(async () => {
    const ok = await redis.eval<number>(EXTEND, [key], [token, String(ttlMs)]);
    if (ok === 0) {
      // Lost the lock. Worker-only: abort the critical section.
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
```

**Honest caveat.** A watchdog narrows the lost-lock window but cannot close it. Between "extend
failed" and "your code notices," another worker may already hold the lock. Extension is for
*efficiency only* — never for money movement or exactly-once guarantees.

---

## 6. Fencing Tokens: Guarding Against Lost Locks

A **fencing token** is a strictly monotonically increasing number issued at lock acquisition. Every
write to the protected resource carries its token; the resource records the highest token it has
seen and **rejects any write with a lower token.** A paused-then-resumed stale holder presents an
old token and is rejected.

```
T0  A acquires lock, gets token = 33
T1  A pauses (Vercel cold-start overlap)
T2  A's lock expires; B acquires, gets token = 34
T3  B writes to Supabase with token 34 -> DB records max_fence=34
T4  A wakes, writes with token 33 -> 33 < 34 -> REJECTED by DB.  Safe.
```

**Generating fencing tokens.** `INCR` on a per-resource counter gives a monotonically increasing
value because Redis processes one command at a time — no two callers get the same value.

```typescript
// Atomic: acquire lock AND get a fencing token in one round-trip.
// Requires Lua script; both keys must be passed.
const ACQUIRE_WITH_FENCE = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return redis.call("INCR", KEYS[2])
else
  return -1
end`;

async function acquireWithFence(resourceId: string, ttlMs: number) {
  const token = randomUUID();
  const lockKey = `lock:resource:${resourceId}`;
  const fenceKey = `fence:resource:${resourceId}:seq`;
  // Upstash: both keys are passed; the script touches them in order
  const fence = await redis.eval<number>(ACQUIRE_WITH_FENCE, [lockKey, fenceKey], [token, String(ttlMs)]);
  if (fence === -1) return null;
  return { token, fence, lockKey };
}
```

**Enforcing the fence at Supabase Postgres.** The token only protects you if the *resource*
enforces monotonicity. In Postgres:

```sql
-- Only update if our fence token is strictly greater than the last recorded one.
UPDATE conversations
SET title = $1, last_fence = $2
WHERE id = $3 AND last_fence < $2
RETURNING id;
```

If `0 rows updated`, a newer holder already wrote — abort, do not overwrite.

```typescript
const result = await prisma.$executeRaw`
  UPDATE conversations
  SET title = ${newTitle}, last_fence = ${fence}
  WHERE id = ${convId} AND last_fence < ${fence}
`;
if (result === 0) throw new Error(`StaleLock: conversation ${convId}, fence ${fence}`);
```

The schema needs a `last_fence BigInt @default(0)` column — add it in `prisma/schema.prisma` and
migrate. **The lock service alone cannot make you safe; the resource must do the fencing check.**

---

## 7. Redlock and Why a Single Upstash Endpoint Changes the Calculus

**Redlock** is an algorithm for locking across N independent Redis primaries to remove the
single-point-of-failure of one primary going down. It requires the N instances to be
**independent** — no replication relationship, no shared failure domain.

**Upstash on a standard plan is one endpoint backed by one logical primary.** Running Redlock
against multiple Upstash regions or replicas of the *same* database violates the independence
assumption: they share the same dataset and fail together. You get Redlock's cost (5× the round
trips, quorum math, clock-drift allowance) with none of its safety — and you've added complexity
for nothing.

For Lumina's use cases the decision table is simple:

| Situation | Recommendation |
|---|---|
| Efficiency lock (de-dupe idempotent work) | **Single `SET NX PX`** (§2–§4) |
| Correctness: money / exactly-once mutation | **Do not rely on any Redis lock.** Use idempotency keys (§8) + an atomic Postgres transaction. Add fencing (§6) if needed. |
| You genuinely need cross-region distributed locking | Use Upstash Global (which replicates synchronously) or a consensus system, not vanilla Redlock |

Kleppmann's core critique applies regardless: even a perfect lock service cannot prevent a
*paused-then-resumed* client from acting on stale ownership. Fencing (§6) or idempotency (§8) is
always required alongside locks for correctness.

---

## 8. Idempotency Keys for Safe Retries

Locks try to prevent concurrency; **idempotency keys** make duplicate execution *harmless* — usually
the better goal. The client generates a UUID per logical operation, sends it with the request, and
the server guarantees that **the same key produces the same effect and the same response, no matter
how many times it's submitted.**

State machine:

```
absent ──(reserve)──► in-progress ──(success)──► completed (store response)
                            │
                            └──(failure/timeout)──► absent again (TTL)
```

The atomic "reserve" is `SET idem:<key> "in-progress" NX EX <ttl>`. Only the first request wins;
concurrent duplicates see the existing key.

```typescript
// backend/lib/idempotency.ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const IDEM_TTL_SEC = 86_400; // 24h — long enough to outlive client retry windows

interface StoredResponse { status: number; body: unknown }
type IdemState =
  | { status: "new" }
  | { status: "in-progress" }
  | { status: "completed"; response: StoredResponse };

export async function reserveIdempotency(key: string): Promise<IdemState> {
  const k = `idem:${key}`;
  const reserved = await redis.set(k, JSON.stringify({ s: "in-progress" }), {
    nx: true,
    ex: IDEM_TTL_SEC,
  });
  if (reserved === "OK") return { status: "new" };

  const raw = await redis.get<string>(k);
  if (!raw) return { status: "new" }; // expired between SET and GET — rare
  const parsed = JSON.parse(raw);
  if (parsed.s === "completed") return { status: "completed", response: parsed.response };
  return { status: "in-progress" };
}

export async function completeIdempotency(key: string, response: StoredResponse): Promise<void> {
  await redis.set(`idem:${key}`, JSON.stringify({ s: "completed", response }), {
    ex: IDEM_TTL_SEC,
  });
}
```

**Using it in an Express 5 mutation handler:**

```typescript
// backend/routes/connectors.ts
app.post("/connectors/gmail/send", async (req, res) => {
  const idemKey = req.header("Idempotency-Key");
  if (!idemKey) return res.status(400).json({ error: "Idempotency-Key header required" });

  const state = await reserveIdempotency(idemKey);

  if (state.status === "completed") {
    // Replay the original response verbatim
    return res.status(state.response.status).json(state.response.body);
  }
  if (state.status === "in-progress") {
    return res.status(409).json({ error: "duplicate send in progress, retry shortly" });
  }

  // "new": we own this send
  const result = await sendGmailMessage(req.userId, req.body);
  const response = { status: 200, body: result };
  await completeIdempotency(idemKey, response);
  return res.status(200).json(result);
});
```

**The dangerous gap.** If the process crashes between "do the work" and "store completed," the key
stays `in-progress` until TTL. Mitigation: **make the underlying operation idempotent** so a retry
is harmless even if the marker is lost. For Gmail send this means storing a `sent_message_id` in
Supabase before completing — a retry can check whether the row exists.

**Idempotency vs locks:**

| | Distributed lock | Idempotency key |
|---|---|---|
| Prevents | Concurrent execution | Duplicate *effect* of retried requests |
| Guarantee strength | Advisory, best-effort | Strong when the underlying write is idempotent |
| Natural for | Background jobs, cron de-dupe | HTTP mutations, webhooks, scheduled sends |
| Failure on crash | Self-heals at TTL | Marker sticks `in-progress`; pair with idempotent write |

For user-facing mutations in Lumina (connector sends, scheduled messages), **prefer idempotency
keys backed by a Supabase unique constraint** over locks.

---

## 9. Atomic Counters: INCR/INCRBY and Why Read-then-Write Is Wrong

Rate limiting reduces to **counting events in a time window**. Redis's `INCR`/`INCRBY` are the
atomic building blocks. Because Redis is single-threaded, `INCR` is a true read-modify-write with
no lost updates — no transactions needed.

```
INCR ratelimit:user:42   -> 1   (key created at 0, incremented, returns new value)
INCR ratelimit:user:42   -> 2
```

**The atomicity trap: `INCR` + `EXPIRE` as two commands.** If the process (or Vercel function)
crashes between them, you get a counter with **no TTL** — it lives forever, the window never
resets, and the subject is throttled forever (or never reaches the limit again). Catastrophic for
any public endpoint.

The correct pattern is a single Lua script that sets the TTL only on the first `INCR`:

```lua
-- incr-with-ttl.lua  KEYS[1]=counter  ARGV[1]=window seconds  ARGV[2]=limit
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])  -- only on the first hit of this window
end
if current > tonumber(ARGV[2]) then
  return {current, 0}  -- over limit: {count, allowed=0}
end
return {current, 1}    -- under limit: {count, allowed=1}
```

```typescript
const INCR_TTL = `
local c = redis.call("INCR", KEYS[1])
if c == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
if c > tonumber(ARGV[2]) then return {c, 0} end
return {c, 1}`;

async function fixedWindowHit(key: string, windowSec: number, limit: number) {
  const result = await redis.eval<[number, number]>(INCR_TTL, [key], [String(windowSec), String(limit)]);
  const [count, allowed] = result;
  return { count, allowed: allowed === 1, remaining: Math.max(0, limit - count) };
}
```

**Why read-then-write from application code is always wrong:**

```typescript
// WRONG — two separate commands, not atomic:
const count = await redis.get("rl:user:42");
if (Number(count) < 60) {
  await redis.incr("rl:user:42"); // another request can win between get and incr
}
// Under concurrency, 70 requests can all read "59" and all increment past 60.
```

Two concurrent requests read the same value, both decide they're under the limit, both increment.
This is a classic TOCTOU (time-of-check-time-of-use) bug — unacceptable for security-sensitive
limits. Use the Lua approach above (or `@upstash/ratelimit` which handles all of this for you, §11).

---

## 10. Rate-Limit Algorithms

### 10.1 Fixed Window

Divide time into fixed intervals (e.g. each calendar minute). One counter key per interval per
subject. Cheap (one key, one atomic script), simple, and fine for most general API throttling.

```typescript
function fixedWindowKey(subject: string, windowSec: number): string {
  const windowId = Math.floor(Date.now() / 1000 / windowSec);
  return `rl:fw:${subject}:${windowId}`;
}

async function fixedWindow(subject: string, limit: number, windowSec: number) {
  const key = fixedWindowKey(subject, windowSec);
  const { count, allowed, remaining } = await fixedWindowHit(key, windowSec, limit);
  return {
    allowed,
    remaining,
    resetSec: (Math.floor(Date.now() / 1000 / windowSec) + 1) * windowSec,
  };
}
```

**The boundary burst flaw.** Because the counter resets sharply at the boundary, a caller can send
`limit` requests at second 59.9 and another `limit` at second 60.1 — 2× limit in 0.2 s, straddling
the boundary. For abuse-sensitive endpoints (login, OTP, connector OAuth), use sliding window. For
ordinary API throttling it is usually fine.

### 10.2 Sliding Window (Log Variant — Exact)

Store each request timestamp in a **sorted set** (scored by time); trim entries older than the
window; count what remains. Exact — no boundary burst — but O(log N) per request and uses more
memory (one ZSet entry per request, bounded by `limit`).

```lua
-- sliding-window-log.lua
-- KEYS[1]=zset  ARGV[1]=now(ms)  ARGV[2]=window(ms)  ARGV[3]=limit  ARGV[4]=unique member
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
redis.call("ZREMRANGEBYSCORE", KEYS[1], 0, now - window)
local count = redis.call("ZCARD", KEYS[1])
if count < limit then
  redis.call("ZADD", KEYS[1], now, ARGV[4])
  redis.call("PEXPIRE", KEYS[1], window)
  return {count + 1, 1}
end
return {count, 0}
```

```typescript
const SLIDING_LOG = `
local now=tonumber(ARGV[1]) local window=tonumber(ARGV[2]) local limit=tonumber(ARGV[3])
redis.call("ZREMRANGEBYSCORE",KEYS[1],0,now-window)
local count=redis.call("ZCARD",KEYS[1])
if count<limit then redis.call("ZADD",KEYS[1],now,ARGV[4]) redis.call("PEXPIRE",KEYS[1],window) return{count+1,1} end
return{count,0}`;

async function slidingWindowLog(subject: string, limit: number, windowMs: number) {
  const now = Date.now();
  const member = `${now}-${randomUUID()}`;
  const [count, allowed] = await redis.eval<[number, number]>(
    SLIDING_LOG, [`rl:swl:${subject}`], [String(now), String(windowMs), String(limit), member],
  );
  return { allowed: allowed === 1, remaining: Math.max(0, limit - count) };
}
```

Use for **login attempts, OTP requests, connector OAuth** — anywhere accuracy and brute-force
resistance matter more than memory.

### 10.3 Sliding Window (Counter Variant — Approximate)

Cheaper approximation: keep the *current* and *previous* fixed-window counters, weight the previous
by how far into the current window you are. Two keys per subject; both must be passed to one Lua
script:

```lua
-- sliding-window-counter.lua
-- KEYS[1]=current bucket  KEYS[2]=previous bucket
-- ARGV[1]=window seconds  ARGV[2]=limit  ARGV[3]=elapsed fraction [0,1)
local limit    = tonumber(ARGV[2])
local fraction = tonumber(ARGV[3])
local prev = tonumber(redis.call("GET", KEYS[2]) or "0")
local curr = tonumber(redis.call("GET", KEYS[1]) or "0")
local estimated = prev * (1 - fraction) + curr
if estimated >= limit then
  return {math.floor(estimated), 0}
end
redis.call("INCR", KEYS[1])
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]) * 2)
return {math.floor(estimated) + 1, 1}
```

With Upstash you pass both key names in the keys array:

```typescript
async function slidingWindowCounter(subject: string, limit: number, windowSec: number) {
  const nowSec = Date.now() / 1000;
  const windowId = Math.floor(nowSec / windowSec);
  const fraction = (nowSec % windowSec) / windowSec;
  const currKey = `rl:swc:${subject}:${windowId}`;
  const prevKey = `rl:swc:${subject}:${windowId - 1}`;
  const [count, allowed] = await redis.eval<[number, number]>(
    SLIDING_COUNTER, [currKey, prevKey],
    [String(windowSec), String(limit), String(fraction)],
  );
  return { allowed: allowed === 1, remaining: Math.max(0, limit - count) };
}
```

**Note:** Upstash's `@upstash/ratelimit` sliding window (`Ratelimit.slidingWindow`) uses this
counter variant under the hood (§11). Prefer that library for production; the raw Lua is here for
understanding.

### 10.4 Token Bucket

A bucket holds up to `capacity` tokens, refilling at `rate` tokens/sec. Each request costs one
token; if empty, the request is denied. Allows short bursts while bounding the sustained rate.
Ideal for user-facing API quotas.

Store state as a Redis Hash (`tokens` + `ts`) — one key, atomic Lua:

```lua
-- token-bucket.lua  (lazy refill, single Hash key)
-- KEYS[1]=bucket hash  ARGV[1]=capacity  ARGV[2]=rate(tokens/s)  ARGV[3]=now(ms)  ARGV[4]=cost  ARGV[5]=ttl(s)
local capacity,rate,now,want,ttl =
  tonumber(ARGV[1]),tonumber(ARGV[2]),tonumber(ARGV[3]),tonumber(ARGV[4]),tonumber(ARGV[5])
local d = redis.call("HMGET",KEYS[1],"tokens","ts")
local tokens,ts = tonumber(d[1]),tonumber(d[2])
if tokens==nil then tokens,ts=capacity,now end
local elapsed = math.max(0,now-ts)/1000.0
tokens = math.min(capacity, tokens + elapsed*rate)
ts = now
local allowed,retryMs = 0,0
if tokens>=want then tokens=tokens-want; allowed=1 end
redis.call("HSET",KEYS[1],"tokens",tokens,"ts",ts)
redis.call("EXPIRE",KEYS[1],ttl)
if allowed==0 then retryMs=math.ceil(((want-tokens)/rate)*1000) end
return {allowed,math.floor(tokens),retryMs}
```

```typescript
async function tokenBucket(subject: string, capacity: number, ratePerSec: number, cost = 1) {
  const key = `rl:tb:${subject}`;
  const ttl = Math.ceil((capacity / ratePerSec) * 2);
  const [allowed, remaining, retryMs] = await redis.eval<[number, number, number]>(
    TOKEN_BUCKET, [key],
    [String(capacity), String(ratePerSec), String(Date.now()), String(cost), String(ttl)],
  );
  return { allowed: allowed === 1, remaining, retryAfterMs: retryMs };
}
```

**Always pass `Date.now()` from the server — never trust a client-supplied timestamp in refill
math.** A client with a fast clock can claim a lot of elapsed time and mint unlimited tokens.

### 10.5 Leaky Bucket / GCRA

Leaky bucket (Generic Cell Rate Algorithm) enforces a *smooth, constant output rate*. Unlike token
bucket it does not allow bursts — it paces traffic. Useful when protecting a fragile downstream API
(e.g. a rate-limited finance vendor like Twelve Data or Finnhub) from bursts you'd allow at the
user level.

GCRA tracks a single **Theoretical Arrival Time (TAT)** — the earliest time the next request
*should* arrive. One key per subject.

```lua
-- gcra.lua  KEYS[1]=TAT string  ARGV[1]=emission interval ms  ARGV[2]=burst tolerance ms
--            ARGV[3]=now(ms)  ARGV[4]=cost  ARGV[5]=ttl(s)
local interval,burst,now,cost,ttl =
  tonumber(ARGV[1]),tonumber(ARGV[2]),tonumber(ARGV[3]),tonumber(ARGV[4]),tonumber(ARGV[5])
local tat = tonumber(redis.call("GET",KEYS[1]) or now)
if tat<now then tat=now end
local newTat = tat + interval*cost
local allowAt = newTat - (burst+interval)
local allowed,retryMs = 0,0
if now>=allowAt then
  allowed=1
  redis.call("SET",KEYS[1],newTat,"PX",math.ceil((newTat-now)+burst+ttl*1000))
else
  retryMs=math.ceil(allowAt-now)
end
return{allowed,retryMs}
```

**Token bucket vs leaky bucket:**

| | Token bucket | Leaky bucket / GCRA |
|---|---|---|
| Burst | Allows bursts up to `capacity` | Smooths output; `burst` tolerance only |
| State | 2 fields (Hash) | 1 value (String) |
| Memory | Small | Minimal |
| Best for | User quotas, API SDKs | Pacing calls to fragile 3rd-party APIs |

---

## 11. `@upstash/ratelimit` — Our Sliding Window in Practice

Rather than hand-rolling Lua for the production rate limiter, Lumina uses `@upstash/ratelimit`,
which implements a sliding-window counter (the two-bucket approximation from §10.3) and handles
the Lua scripting, key naming, and error surface automatically.

**`backend/lib/ratelimit.ts`** (full file):

```typescript
// backend/lib/ratelimit.ts  (cited: backend/lib/ratelimit.ts:1-70)
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import type { Request, Response, NextFunction } from "express";

const LIMIT = 60;       // requests…
const WINDOW_SEC = 60;  // …per minute, per client IP

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

// In-memory fallback (per-instance, not shared across Vercel invocations).
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

**Key design decisions visible in the file** (`backend/lib/ratelimit.ts:1`):

| Decision | Location | Rationale |
|---|---|---|
| `Ratelimit.slidingWindow(60, "60 s")` | `:29-32` | Two-bucket sliding window via `@upstash/ratelimit`; no boundary burst |
| `prefix: "rl:finance"` | `:33` | Namespaces keys under `rl:finance:*`; avoids collision with other rate limiters |
| `null` redis when env vars absent | `:20-26` | Local dev / CI without Upstash falls back to in-memory |
| In-memory fallback is **per-instance** | `:37-44` | Each Vercel function instance has its own map — correct for dev; on Vercel, Upstash is the shared source |
| Fail-open in `financeRateLimit` | `:61-68` | A Upstash outage must not take down finance reads; logged loudly so it's detectable |

**Per-endpoint rate limits.** The exported `allowRequest(key)` can be called with any string key,
so you can create per-route limiters without duplicating the Redis construction:

```typescript
// Per-AI-ask limit — tighter (10 req/min per userId) because each triggers LLM spend
import { allowRequest } from "../lib/ratelimit.js";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const askLimiter = redis
  ? new Ratelimit({
      redis: new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }),
      limiter: Ratelimit.slidingWindow(10, "60 s"),
      prefix: "rl:ask",
    })
  : null;

// in the /ask handler:
if (askLimiter) {
  const { success } = await askLimiter.limit(`user:${req.userId}`);
  if (!success) return res.status(429).json({ error: "Too many asks — try again in a minute." });
}
```

**`@upstash/ratelimit` algorithm options:**

```typescript
Ratelimit.fixedWindow(60, "60 s")    // simple, cheap; 2× burst at boundary
Ratelimit.slidingWindow(60, "60 s")  // two-bucket approx; our choice
Ratelimit.tokenBucket(10, "10 s", 5) // capacity=10, refill 10 every 10 s, max=5 per call
```

---

## 12. Fail-Open vs Fail-Closed — Our Deliberate Choice

When the Upstash REST call itself throws (network error, 5xx, timeout), you must choose:

- **Fail-open:** log the error, allow the request. Traffic keeps flowing; the limiter is temporarily
  neutered.
- **Fail-closed:** deny the request (503 or 429). No traffic during the outage.

Lumina's `financeRateLimit` **fails open** (`backend/lib/ratelimit.ts:65-67`):

```typescript
} catch (e) {
  console.warn("[ratelimit] check failed, allowing:", ...);
}
next(); // <-- allow
```

**The reasoning:** Finance reads are informational. If Upstash is down for 30 seconds, it's better
to serve users (even without throttling) than to black-hole the finance tab. The risk — a burst of
unchecked traffic hitting Upstash command quota or Vercel invocation limits — is logged and
detectable.

**Where fail-closed is the right choice:**

| Endpoint type | Choice | Reason |
|---|---|---|
| Finance / Discover reads | **Fail-open** | Availability > brief over-service |
| Login / auth / OTP | **Fail-closed** | Open brute-force floodgates is far worse than a brief block |
| Gmail connector send | **Fail-closed** | Rate-limit bypass could trigger vendor abuse suspension |
| LLM `/ask` endpoint | **Fail-closed recommended** | Each request burns real money; a limiter outage could cost significantly |

Write the decision explicitly in code with a comment — do not let it be an accident of a missing
`try/catch`.

```typescript
// /ask route — fail-closed for LLM spend protection
try {
  const { success } = await askLimiter.limit(`user:${req.userId}`);
  if (!success) return res.status(429).json({ error: "rate limited" });
} catch (e) {
  // Fail-CLOSED: if we can't check, we don't allow — LLM calls are too expensive.
  console.error("[ratelimit:ask] limiter error, denying request:", e);
  return res.status(503).json({ error: "rate limiter unavailable" });
}
```

---

## 13. R-SCALE Mapping

> The R-SCALE battery (see `C:\Users\Redsparrow\.claude\rules\product-scale-architecture.md`) defines product-at-scale questions.
> This section maps §D (contested writes) and §E (fairness) to the Redis primitives above.

### §D — Contested Writes

**D14. When is a resource actually claimed?**
Redis locks guard *when* to claim, but the claim itself must be an **atomic conditional write** in
Postgres, not the Redis lock alone. For Lumina's connector send (sending a Gmail at a scheduled
time, exactly once):

```
1. User schedules a send → row inserted with status='pending'
2. Cron fires → acquireLock("lock:send:${id}", {ttlMs:30_000})
3. If lock acquired: UPDATE scheduled_sends SET status='sending' WHERE id=? AND status='pending'
   (atomic guard — exactly one worker proceeds)
4. Send; then UPDATE status='sent'
5. releaseLock()
```

The `status='pending'` guard in step 3 is the real invariant — the Redis lock prevents the
thundering-herd of concurrent attempts, but the Postgres condition ensures exactly-once even if
the lock fails.

**D15. Is the decrement atomic and guarded?**
Any counter (quota used, sends remaining, items in a finite pool) must use:

```sql
UPDATE quotas SET used = used + 1 WHERE user_id = $1 AND used < limit RETURNING used;
```

Never `SELECT used; if used < limit: UPDATE used = ${used+1}` from application code — that is a
read-then-write TOCTOU bug. In Redis: always `INCR` (atomic), never `GET` then `INCR`.

**D16. Reservation TTL.**
Lock TTL (§2) IS the reservation window. If the holder crashes without completing, the lock
self-heals and another worker can proceed. Size the TTL to exceed the worst-case operation duration.

**D17. Idempotency.**
A retried request must not double-send, double-charge, or double-decrement. Use idempotency keys
(§8). The key should be sent by the client per logical operation, not per HTTP attempt.

### §E — Fairness and Ordering

**E18–E19. "First come first served" is defined by server arrival order, never client timestamps.**
If multiple workers race for the same lock:

- The one whose `SET NX PX` wins (atomic, single Redis thread) proceeds first.
- Others retry with jittered backoff (§4) — not a strict FIFO queue, but a fair approximation for
  de-duplication use cases.

For strict FIFO ordering (e.g. a scheduler that must process jobs in submission order), a Redis
**List** (`RPUSH` / `BLPOP`) or a Postgres `SELECT ... FOR UPDATE SKIP LOCKED` queue is the right
tool — not a lock.

**Upstash Lists as a simple job queue:**

```typescript
// Enqueue a scheduled Gmail send
await redis.rpush("queue:scheduled-sends", JSON.stringify({ sendId, userId, scheduledAt }));

// Worker (in worker/ on Fly.io — long-lived process, not Vercel):
const job = await redis.blpop("queue:scheduled-sends", 0); // blocks until a job arrives
```

`BLPOP` is not available over Upstash REST (it requires a persistent connection). Use Upstash's
QStash product for durable, HTTP-based queuing, or implement polling (`LPOP` on an interval in the
Fly.io worker).

---

## 14. TTL Hygiene and Clock Skew

### TTL Discipline

1. **Every coordination key must have a TTL.** Locks without TTL → deadlock. Counters without TTL
   → windows never reset. Idempotency markers without TTL → memory leak. No exceptions.

2. **Set TTL atomically with creation.** Use `SET ... NX PX` (one round-trip) or a Lua script that
   calls `EXPIRE` only on the first `INCR`. Two-command patterns have a crash window.

3. **Size lock TTLs correctly.** Too short → the lock expires mid-work and two workers race.
   Too long → a crashed Vercel function blocks everyone for the full TTL. Measure the worst-case
   operation time and add 50% margin.

4. **Rate-limit counter TTL = window duration.** For fixed windows, the key should expire exactly
   when the window does — so the counter and the limit reset together. The Lua script in §9 sets
   `EXPIRE key windowSec` on the first increment.

5. **Avoid `allkeys-lru` on control data.** Upstash's default eviction policy is `noeviction` on
   its standard plan (it returns an error if memory is full). If you configure a cache plan with
   eviction, ensure rate-limit counters and idempotency markers are not casually evicted — they are
   not cache; they are control data. Either use a separate Upstash database for control data or
   choose `volatile-lru` (evicts only keys *with* a TTL, which they all have).

### Clock Skew

- **Single-instance locks don't depend on cross-node clocks.** The TTL is enforced by Upstash's
  single primary using its own timer. No cross-node skew concern.

- **Token/leaky-bucket refill depends on `now`.** Always pass `Date.now()` from the *server*, not
  the client. A client with a manipulated clock can claim unlimited tokens if you accept their
  timestamp. Clamp elapsed time to `≥ 0` to survive NTP backward steps:

  ```lua
  local elapsed = math.max(0, now - ts) / 1000.0
  ```

- **Idempotency key TTL is wall-clock-based** (24h). This is fine — it just needs to outlive the
  client's retry window. Even a 10-second NTP jump doesn't matter here.

---

## 15. Decision Tables

### Which coordination primitive?

| You want to… | Use | Why |
|---|---|---|
| De-dupe an idempotent background job | `SET NX PX` lock (§2–§4) | Cheap, self-healing; correctness not at stake |
| Make a mutation safe against client retries | Idempotency key + idempotent write (§8) | Survives crashes, no lock contention |
| Strict mutual exclusion for non-idempotent mutation | Fencing token enforced at Supabase (§6) | Locks alone can't guarantee exclusion across pauses |
| Throttle general API traffic | Fixed window or `@upstash/ratelimit` sliding window (§10.1, §11) | Simple, cheap |
| Throttle abuse-sensitive endpoint (login, OTP) | Sliding-window log/ZSet (§10.2) or `slidingWindow` via `@upstash/ratelimit` | No boundary burst |
| Allow bursts, bound sustained rate (user quota) | Token bucket (§10.4) | Forgiving, well-understood |
| Pace calls to a fragile downstream (vendor API) | Leaky bucket / GCRA (§10.5) | Smooth output, minimal state |

### Rate-limit algorithm comparison

| Algorithm | Memory | Burst handling | Accuracy | Complexity | Best for |
|---|---|---|---|---|---|
| Fixed window | 1 int | 2× at boundary | Coarse | Trivial | General throttling |
| Sliding log (ZSet) | O(limit) entries | None | Exact | Medium | Login, OTP |
| Sliding counter (2-bucket) | 2 ints | Minimal | Approx (±5%) | Medium | High-volume APIs (`@upstash/ratelimit` default) |
| Token bucket | 2 fields (Hash) | Up to `capacity` | Exact-ish | Medium | User quotas |
| Leaky / GCRA | 1 int | None (paced) | Exact-ish | Medium | Downstream protection |

### `SET` flag cheat sheet for locks

| Command | Effect | Use for lock acquire? |
|---|---|---|
| `SET k v NX PX ms` | Set if absent, expire in ms | **Yes** — the only correct acquire |
| `SET k v XX PX ms` | Set only if present | No (re-assert only, not acquire) |
| `SETNX k v` + `EXPIRE` | Set if absent; TTL is a second command | **No** — has a crash window (legacy) |
| `DEL k` | Delete unconditionally | **No** for release — use Lua compare-and-delete |

---

## 16. Anti-Patterns

**1. Releasing a lock with bare `DEL` instead of token compare.**
Your `DEL` deletes another worker's lock if yours already expired and was re-acquired. Use the Lua
compare-and-delete script (§3). Treat a release returning `0` as "I lost the lock" and log it.

**2. `SETNX` + `EXPIRE` as two commands.**
A crash between them leaves a lock with no TTL — a permanent deadlock. Always use
`SET key token NX PX ms` (one atomic command).

**3. `INCR` then `EXPIRE` as two commands for a rate-limit counter.**
A crash between them gives a counter with no TTL — the window never resets. Use the Lua script in
§9 that sets `EXPIRE` only on the first `INCR`.

**4. Using a constant lock value like `"1"` or `"locked"`.**
Without a unique token you can't distinguish your lock from anyone else's. Safe release
(token compare) is impossible — you're back to bare `DEL`. Use `crypto.randomUUID()`.

**5. Treating a Redis lock as a correctness guarantee for money/inventory.**
Process pauses and async-replication can hand the same lock to two holders. Use idempotency keys
(§8) and/or fencing tokens (§6) at the Postgres layer for any correctness-critical mutation.

**6. No TTL on idempotency markers.**
Markers leak memory and, on eviction, may lose in-flight operations. Always TTL them (24h is
common), and back them with an idempotent Supabase write so losing the marker is survivable.

**7. `allkeys-*` eviction on a database that holds control data.**
Under memory pressure, Upstash with `allkeys-lru` can silently evict a live lock or in-flight
idempotency key. Use `noeviction` (the standard Upstash plan default) or a separate database for
control data vs cache data.

**8. Implicit fail-open/fail-closed via missing `try/catch`.**
An unhandled rejection can 500 the request (accidental fail-closed) or a swallowed error can skip
the limiter (accidental fail-open). Write the choice explicitly per endpoint (§12).

**9. Trusting a client-supplied timestamp in token/leaky-bucket refill math.**
A client with a fast clock mints unlimited tokens. Always pass `Date.now()` from the server. Clamp
`elapsed` to `≥ 0` to survive backward NTP steps.

**10. In-memory `hits` map on Vercel as a shared rate limiter.**
Each Vercel function instance has its own memory. If 10 instances handle the same IP, each sees at
most 10% of the traffic — the in-memory fallback allows 10× the limit across the fleet.
`backend/lib/ratelimit.ts:37-44` uses this only as a **local dev fallback**. In production, Upstash
is mandatory for correct, shared rate limiting.

**11. Running rate-limit counters from a read replica.**
Replica reads can be stale — you under-count and over-allow. Keep all rate-limit and lock
operations on the primary (Upstash REST always routes to primary by default).

---

## 17. See Also

**Sibling references in this skill (redis/):**

- `cache-patterns.md` — `getOrRefresh`, stale-while-revalidate, stampede lock, TTL strategy, the
  `inflight` de-dupe map in `backend/lib/cache.ts`
- `upstash-client-setup.md` — REST client construction, `@upstash/redis` options, env vars,
  local dev without Upstash, `cacheBackend` flag

**Other skills:**

- **prisma** — Supabase Postgres schema, `$executeRaw`, conditional updates for fencing tokens,
  idempotent upserts
- **supabase** — Auth, RLS, Postgres transactions as an alternative mutex for contested writes
- **rag-retrieval** — semantic cache (`CachedQuery` table, `$queryRaw`, pgvector) that sits *above*
  the Redis hot-cache layer
- **finance-markets** — where `financeRateLimit` middleware is mounted; vendor quota constraints
  that motivate the rate limiter
- **connectors-oauth** — Gmail scheduled sends, idempotency requirements for connector actions
- **backend-testing** — how to mock `@upstash/redis` and `@upstash/ratelimit` in Bun tests
- **lumina-frontend** — TanStack Query retry behavior; the client-side experience of 429 responses
  (retry-after headers, error boundaries)
