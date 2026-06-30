# Pattern: Per-Key Rate Limiting, Quotas & Graceful-Degradation Headers Across Delivery Channels

> **Layer:** `patterns-*` (concrete build recipe — the runnable mechanism, not the survey).
> **Product line:** JPM-Markets re-engineering **data-analytics** product line — the
> DataQuery/Fusion-class market-data delivery platform we are building to beat the incumbents.
> **NOT Lumina.** Lumina (this repo, Bun + Express + Prisma + Upstash) is only the filesystem home for
> this research; do not wire any of this into Lumina's app code. The reference *reads* Lumina's
> `backend/lib/ratelimit.ts` as a worked example of the gateway algorithm, then builds the
> data-analytics service's limiter on its own Python/FastAPI stack.
>
> **Stack assumption (the new line).** Python 3.12 + FastAPI for the request path, Redis (self-hosted
> or Upstash) as the shared counter store, an external worker/cron for heavy ingest. The *gateway*
> limiter pattern (sliding window, fail-open) is language-agnostic; the recipes give both the TS
> reference (Lumina's actual code) and the Python implementation for the new service.
>
> **What this doc answers.** A data API that does not meter every caller is two failures waiting to
> happen: a **DoS vector** (one buggy or hostile client saturates the service for everyone) and a
> **cost balloon** (every un-throttled request is an upstream-vendor call, a serverless invocation, a
> Redis command, or — for AI-backed panels — real LLM spend). This is the seatbelt: which algorithm,
> the exact 429 response contract, per-key tiers/quotas, the circuit breaker, and the client guidance
> that makes a throttled client back off instead of hammering harder.

---

## 0. The on-ramp (plain language, then the rest is dense)

You are putting a turnstile in front of a data API. Three things must be true and they pull against
each other:

1. **It must never let the building flood.** If one client (or 10,000 of them on a spike day) can send
   unlimited requests, they exhaust the upstream vendor quota, the database connections, the Redis
   command budget, and — on the AI panels — the model spend. The turnstile caps each *key* (API key /
   user / IP) to N requests per window.
2. **It must be fair and smooth, not lumpy.** A naive turnstile that resets on the minute lets a client
   fire a double-rate burst across the boundary (the last second of minute 1 + the first second of
   minute 2). The production default — a **sliding-window counter** — smooths that out by weighting the
   previous window's count by how far you are into the current one.
3. **It must fail in the safe direction.** If the counter store (Redis) is unreachable, the limiter
   must **fail open** (allow the request) — a limiter outage must never take down reads. The cost of a
   brief over-allow is a few extra upstream calls; the cost of fail-closed is a self-inflicted outage.

When a request is denied, you don't drop the connection or lie with a 200. You return **HTTP 429 Too
Many Requests**, a **`Retry-After`** telling the client exactly how long to wait, and the
**`RateLimit-*`** budget headers so a well-behaved client can self-pace *before* it ever gets a 429.
The client side mirrors this: honor `Retry-After`, otherwise exponential backoff **with jitter**, cap
the retries at 3–5, never retry forever.

The rest of this doc is the exact algorithm choice, the runnable limiter (TS + Python), the byte-exact
header contract, the circuit breaker, the quota tiers, and the atomic-counter rule that the whole thing
rests on.

---

## 1. Algorithm choice: the five candidates, and why the production default is the sliding-window counter

There are five algorithms in common production use. They differ in **burst tolerance**, **smoothness**,
**memory cost**, and **boundary correctness**. Pick by what the channel downstream can absorb — not by
habit.

| Algorithm | State per key | Burst behavior | Boundary bug? | Memory | Use when |
|---|---|---|---|---|---|
| **Fixed window counter** | 1 counter + window id | Allows ~2× at the window edge | **Yes** (the classic flaw) | Minimal | Never for an external edge; only crude internal caps |
| **Sliding window log** | a timestamp per request | Exact, no burst | No | **High** (grows with volume) | Low-volume, audit-grade precision |
| **Sliding window counter** | 2 counters (prev + current) | Controlled, smoothed | No | Moderate | **The production default** for a public data API |
| **Token bucket** | token count + last-refill ts | **Controlled bursts** up to capacity | No | Minimal | When the channel *can* absorb short spikes (Stripe/AWS/JPM) |
| **Leaky bucket** | queue + leak rate | None — fully smoothed, shapes traffic | No | Moderate | Rate *shaping* (constant output), not a hard request cap |

### 1.1 Fixed window — and the boundary flaw that disqualifies it at the edge

"Divides time into fixed intervals (e.g., 60 seconds), maintains a per-client counter, and resets at
window boundaries." Its fatal weakness, stated plainly: it "Can lead to 'bursty' traffic at the
beginning of a new window. … a client could make 100 requests in the last second of one window plus 100
in the first second of the next, effectively doubling the rate to 200 requests within two seconds."
([api7.ai — Rate Limiting Guide: Algorithms & Best Practices](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices)).
Upstash's docs say the same of `fixedWindow`: "High bursts at window boundaries can slip through; causes
request stampedes when many users access simultaneously at window starts."
([Upstash — Ratelimiting Algorithms](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms)).

Verdict: **fixed window is fine only as a cheap internal cap where a 2× edge burst is harmless.** It is
disqualified as the external gateway algorithm for a data API.

### 1.2 Sliding window log — correct but memory-unbounded

"Maintains a timestamp log for each request. Upon arrival, the system counts requests within the past N
seconds and blocks if the count exceeds the limit." It is "More accurate and avoids the 'bursty' issue
of the fixed window" but "Requires storing a potentially large number of timestamps per client, which
can be memory-intensive, especially for high-volume APIs."
([api7.ai, ibid.](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices)). The Redis
implementation is a sorted set per key (score = timestamp), pruned with `ZREMRANGEBYSCORE` and counted
with `ZCARD` ([Redis — Build 5 Rate Limiters](https://redis.io/tutorials/howtos/ratelimiting/)).

Verdict: **exact, but the per-key memory grows with traffic** — a 1M-rps spike day means a million-entry
sorted set per hot key. Use only where audit-grade exactness matters more than memory.

### 1.3 Sliding window counter — the production default

This is the one to reach for. It "Combines fixed windows with historical weighting. Maintains
current-window and previous-window counters." When a request arrives mid-window it computes a
**weighted extrapolation**:

> "if you have a 60-second window and a request arrives 30 seconds into the current window, the
> algorithm might consider 50% of the previous window's count and 50% of the current window's count."
> ([api7.ai, ibid.](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices))

Upstash gives the exact formula and a worked number:

> `rate = (old_window_requests × time_decay_ratio) + current_window_requests`. "For instance, with 4
> requests in the prior minute and 5 in the current 15 seconds: `4 × ((60-15)/60) + 5 = 8`."
> ([Upstash — Ratelimiting Algorithms](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms))

Its trade-off is honest: it "Offers a good balance between accuracy (avoiding the burst problem) and
memory efficiency" — two counters per key — but the count is an **approximation** ("assumes uniform
request distribution") ([api7.ai, ibid.](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices);
Upstash: "provides only approximations (assumes uniform request distribution)").

**Why it is the default for our gateway:** it has the boundary correctness of the sliding-window log at
the memory cost of fixed window (two integers, not a per-request log), it is cheap to compute on every
request, and it is **fair across keys** — exactly what a multi-tenant data API needs when thousands of
keys hit the same edge. This is precisely the algorithm Lumina's gateway already runs (§3).

### 1.4 Token bucket — controlled bursts, and what the incumbents ship

"A bucket containing tokens refills at a constant rate. Each request consumes one token; requests fail
without available tokens." Its distinguishing strength: it "Allows for bursts of traffic (up to the
bucket capacity) while still enforcing a long-term average rate. Efficient as it only needs to store the
current token count and last refill timestamp."
([api7.ai, ibid.](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices)). The burst is
configurable independently of the steady rate: set max capacity **above** the refill rate and you allow
a spike of that size before throttling kicks in (Upstash: "allows configurable burst capacity by setting
max tokens above refill rate").

**This is what the industry leaders actually ship — verify it, don't recall it:**

- **Stripe:** "This algorithm has a centralized bucket host where you take tokens on each request, and
  slowly drip more tokens into the bucket. If the bucket is empty, reject the request." They added burst
  deliberately after traffic analysis: "we added the ability to briefly burst above the cap for sudden
  spikes in usage during real-time events (e.g. a flash sale.)" Implemented on Redis.
  ([Stripe — Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters)).
- **AWS API Gateway:** "API Gateway throttles requests to your API using the token bucket algorithm,
  where a token counts for a request. … You can specify a *throttling rate*, which is the rate, in
  requests per second, that tokens are added to the token bucket. You can also specify a *throttling
  burst*, which is the capacity of the token bucket." Default account limits: **10,000 RPS steady-state,
  5,000 burst** per Region. The burst is "the target maximum number of concurrent request submissions
  that API Gateway will fulfill before returning `429 Too Many Requests` error responses."
  ([AWS — Throttle requests to your REST APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)).
- **JPMorgan DataQuery SDK** (the incumbent we are re-engineering): ships **token-bucket** rate
  limiting client-side — "Token-bucket rate limiting, retries, and a circuit breaker are built in." Its
  defaults: **300 requests/minute** (`DATAQUERY_REQUESTS_PER_MINUTE=300`) and a **burst capacity of 5**
  (`DATAQUERY_BURST_CAPACITY=5`, i.e. 5 tps).
  ([jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk)).

Verdict: **token bucket is the right algorithm when the channel downstream can absorb a short controlled
spike** — and it is the consensus choice of Stripe, AWS, and JPM. Use it for the *per-key SDK/client*
limiter and for endpoints where a burst (e.g. a dashboard loading 12 panels at once) is legitimate. Note
the **mirror-the-incumbent move**: our SDK should expose the *same* token-bucket knobs JPM's does
(rpm + burst capacity), so a team migrating off DataQuery finds a familiar config surface.

### 1.5 Leaky bucket — traffic shaping, not a request cap

"Requests enter a fixed-capacity bucket; a constant leak rate simulates processing. Overflow requests
are discarded." It "Smooths out bursty traffic, ensuring a constant output rate" but "It doesn't
directly limit the number of requests but rather their processing rate."
([api7.ai, ibid.](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices)). Use it only when
you must feed a downstream at a **constant** rate (e.g. a fixed-throughput ingest into a vendor that
itself throttles). It is the wrong tool for "cap each key to N requests/window."

### 1.6 The decision rule (memorize this)

```
Gateway / edge, multi-tenant, fairness matters, two-integer cost?  ─▶ SLIDING WINDOW COUNTER  (§3)
Per-key SDK/client limiter, short bursts legitimate, mirror JPM?   ─▶ TOKEN BUCKET            (§5)
Must feed a downstream at a constant rate (shaping)?               ─▶ LEAKY BUCKET            (rare)
Audit-grade exact count, low volume, memory not a concern?         ─▶ SLIDING WINDOW LOG
Crude internal cap, a 2× edge burst is harmless?                   ─▶ FIXED WINDOW
```

The whole system uses **both** of the top two: a **sliding-window counter at the gateway** (fair
multi-tenant edge cap) and a **token bucket inside the SDK/client** (so a well-behaved client paces
itself and rarely reaches the gateway's 429 at all). They compose — the SDK keeps you under the line,
the gateway enforces the line.

---

## 2. The TOCTOU race — why the counter MUST be atomic (the rule the whole pattern rests on)

Every rate-limit algorithm is the same three-step shape: **read state → decide → write state.** If
those three run as separate round-trips from app code, two concurrent requests both read "95 of 100,"
both decide "room for one more," both write — and you allowed 101. Under load this is not theoretical:

> "Consider 100 concurrent requests arriving simultaneously at different instances. Each instance reads
> the current count (say, 95 out of 100 allowed). Each checks if incrementing would exceed the limit.
> Each concludes there is room for one more request. Each increments the counter. The result: 195
> requests allowed instead of 100."
> ([ByteByteGo / oneuptime — distributed rate limiting](https://oneuptime.com/blog/post/2026-01-25-redis-sliding-window-rate-limiting/view))

This is a **TOCTOU (time-of-check-time-of-use)** race, "and it matters most under exactly the
high-concurrency conditions where rate limiting is critical." The fix is non-negotiable:

> **Never read-then-write the counter from application code. The check-and-increment MUST be a single
> atomic operation in the store.**

Two correct mechanisms:

- **A Redis Lua script** that "wraps the prune-count-add sequence into a single atomic EVAL call." Redis
  "executes Lua scripts atomically on the server with no other command running between the script's
  reads and writes," so "The entire check-and-increment operation happens as a single atomic unit. This
  guarantee holds regardless of how many clients connect to Redis or how many instances run your
  application." ([oneuptime — single Lua script](https://oneuptime.com/blog/post/2026-03-31-redis-how-to-implement-rate-limiting-in-a-single-redis-lua-script/view);
  Upstash uses exactly this — `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `EXPIRE` in one EVAL for the
  sorted-set variant).
- **A single atomic counter command** for the cheap case: `INCR` returns the new value and is itself
  atomic, so a fixed-window limiter can be `INCR key` + (on first hit) `EXPIRE key ttl`. (`@upstash/ratelimit`'s
  fixed/sliding window use server-side scripts so even the multi-step variants are atomic.)

This is the same atomic-guarded-write discipline the R-SCALE rule mandates for any contested counter
(`UPDATE … WHERE … AND qty > 0` for stock; the same shape here for "tokens remaining"). The library
does it for you — **do not hand-roll a `GET`-then-`SET` limiter.**

---

## 3. The gateway recipe: sliding-window counter, fail-open — exactly as Lumina ships it

Lumina's `backend/lib/ratelimit.ts` is a clean, production reference for the **gateway** algorithm. Read
it as the canonical pattern, then port it to the data-analytics service.

### 3.1 The reference implementation (TypeScript / Express — Lumina's actual code)

```ts
// backend/lib/ratelimit.ts (Lumina — the worked example)
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import type { Request, Response, NextFunction } from "express";

const LIMIT = 60;        // requests…
const WINDOW_SEC = 60;   // …per minute, per client IP

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

const upstashLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(LIMIT, `${WINDOW_SEC} s`), // ← the production default
      prefix: "rl:finance",
    })
  : null;

export async function allowRequest(key: string): Promise<boolean> {
  if (upstashLimiter) {
    const { success } = await upstashLimiter.limit(key);
    return success;
  }
  return memAllow(key); // per-instance in-memory fallback for local dev
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

Four properties to copy, each load-bearing:

1. **`Ratelimit.slidingWindow(LIMIT, "60 s")`** — the sliding-window counter from §1.3, the fair
   multi-tenant default. The signature is `Ratelimit.slidingWindow(tokens, window)`
   ([Upstash — Algorithms](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms)).
2. **Shared store across all instances.** Upstash Redis over REST is reachable from every serverless
   instance, so the counter is global — not per-instance (which would multiply the real limit by the
   instance count). The `@upstash/ratelimit` check is atomic server-side (§2), so no TOCTOU race.
3. **Fail-open in the `catch`.** If the Redis call throws, the middleware logs and calls `next()` —
   the request is **allowed**. "A limiter outage must not take down reads." This is the single most
   important operational decision in the file: the limiter is a cost/abuse seatbelt, not a correctness
   gate, so its failure mode is *allow*, never *deny-all*. (`@upstash/ratelimit` also offers a built-in
   `timeout` option: "If the Redis call of the ratelimit is not resolved in some timeframe, allow the
   request by default" — same fail-open semantics, enforced by a deadline
   ([Upstash — Getting Started](https://upstash.com/docs/redis/sdks/ratelimit-ts/gettingstarted)).)
4. **In-memory fallback for local dev** (`memAllow`) so nothing has to be provisioned to start
   building; it is per-instance and therefore only correct for a single dev process.

> **The WHY in the file header is the product argument, verbatim:** "the cache already shields the
> upstream vendors from normal traffic, but a buggy client, a scraper, or an abusive user can still
> hammer OUR endpoint — burning Upstash command quota, Vercel function invocations, free vendor quotas,
> and (for AI-backed panels) real LLM spend. This is the seatbelt." That is exactly the DoS-vector +
> cost-balloon thesis this doc opened with, already stated in shipped code.

### 3.2 The Python/FastAPI port (the data-analytics service's gateway)

The new line runs FastAPI, not Express. Same algorithm, same fail-open, same atomic store. Two ways to
get the sliding-window counter:

**(a) A FastAPI dependency over a Redis Lua script** (full control, no extra lib):

```python
# app/ratelimit.py  (JPM-Markets data-analytics service — NOT Lumina)
import time
from dataclasses import dataclass
from redis.asyncio import Redis  # redis-py >= 5, async client

# Atomic sliding-window-counter in one EVAL. Returns {allowed, remaining, reset_ms}.
# KEYS[1] = bucket key ; ARGV = now_ms, window_ms, limit
_SLIDING_WINDOW_LUA = """
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])

local cur_id   = math.floor(now / window)
local prev_id  = cur_id - 1
local cur_key  = key .. ':' .. cur_id
local prev_key = key .. ':' .. prev_id

local cur  = tonumber(redis.call('GET', cur_key)  or '0')
local prev = tonumber(redis.call('GET', prev_key) or '0')

-- weight of the previous window = fraction of the current window NOT yet elapsed
local elapsed = now - (cur_id * window)
local weight  = (window - elapsed) / window
local count   = prev * weight + cur                 -- the §1.3 extrapolation

if count >= limit then
  local reset_ms = (cur_id + 1) * window - now
  return {0, 0, reset_ms}                            -- denied
end

redis.call('INCR', cur_key)
redis.call('PEXPIRE', cur_key, window * 2)          -- keep prev window alive for the weighting
local remaining = math.floor(limit - count - 1)
local reset_ms  = (cur_id + 1) * window - now
return {1, remaining, reset_ms}
"""

@dataclass
class RateLimitResult:
    allowed: bool
    limit: int
    remaining: int
    reset_ms: int           # ms until the window rolls

class SlidingWindowLimiter:
    def __init__(self, redis: Redis, limit: int, window_seconds: int, prefix: str = "rl"):
        self.redis = redis
        self.limit = limit
        self.window_ms = window_seconds * 1000
        self.prefix = prefix
        self._script = redis.register_script(_SLIDING_WINDOW_LUA)  # cached SHA, runs via EVALSHA

    async def check(self, identity: str) -> RateLimitResult:
        now_ms = int(time.time() * 1000)
        key = f"{self.prefix}:{identity}"
        try:
            allowed, remaining, reset_ms = await self._script(
                keys=[key], args=[now_ms, self.window_ms, self.limit]
            )
        except Exception as exc:  # noqa: BLE001 — fail OPEN, exactly like ratelimit.ts
            import logging
            logging.getLogger("ratelimit").warning("limiter store down, allowing: %s", exc)
            return RateLimitResult(True, self.limit, self.limit, self.window_ms)
        return RateLimitResult(bool(allowed), self.limit, int(remaining), int(reset_ms))
```

Wire it as middleware that **always** sets the budget headers and emits the full 429 contract (§4):

```python
# app/middleware.py
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse
from math import ceil

def install_rate_limit(app: FastAPI, limiter: SlidingWindowLimiter) -> None:
    @app.middleware("http")
    async def rate_limit(request: Request, call_next):
        identity = api_key_or_ip(request)          # per-KEY first, IP only as fallback (§6)
        result = await limiter.check(identity)
        reset_s = ceil(result.reset_ms / 1000)

        if not result.allowed:
            # 429 ONLY — never 200, never 503. Retry-After + the budget headers on the SAME response.
            return JSONResponse(
                status_code=429,
                content={"type": "about:blank", "title": "Too Many Requests",
                         "status": 429, "detail": "Rate limit exceeded — slow down."},
                headers={
                    "Retry-After": str(reset_s),
                    "RateLimit-Limit": str(result.limit),
                    "RateLimit-Remaining": "0",
                    "RateLimit-Reset": str(reset_s),
                },
                media_type="application/problem+json",  # RFC 9457
            )

        response = await call_next(request)
        # Budget headers on EVERY successful response too, so a good client self-paces BEFORE a 429.
        response.headers["RateLimit-Limit"] = str(result.limit)
        response.headers["RateLimit-Remaining"] = str(result.remaining)
        response.headers["RateLimit-Reset"] = str(reset_s)
        return response
```

> **`register_script` (EVALSHA), not `EVAL` per call.** `redis.register_script` caches the script SHA
> and runs `EVALSHA`, so you ship the script body once and every check is a hash reference — the atomic
> guarantee of §2 with no per-request script transfer.

### 3.3 The R-SCALE statement (write this in the design doc — the rule requires it)

| Tier | Load | Does the gateway limiter survive? | What breaks at the next tier |
|---|---|---|---|
| **1× (demo)** | 1 key, hundreds of req | Yes — even the in-memory fallback | nothing |
| **100× (traction)** | thousands of keys, 10k req/min | Yes — single shared Redis, sliding window is O(1) per check | a single Redis node's command throughput becomes the ceiling (~100k+ ops/s); analytics writes add load |
| **10,000× (product / spike day)** | lakhs of keys, 1M+ req/min, sale-day burst | **Only with:** Redis cluster / sharded by key-hash, the limiter's `timeout` fail-open armed, and the **circuit breaker (§7)** in front of upstreams | a single Redis hot key (one whale key) saturates one shard → shard that key, or move it to token-bucket-per-key in the SDK so it never reaches the edge at volume |

State this tier explicitly. Shipping the Tier-1 fallback while believing it is Tier-3 is the exact
failure R-SCALE exists to prevent: the in-memory map is per-instance, so on a 50-instance serverless
fleet the *effective* limit is 50× the configured one — invisible until the spike.

---

## 4. The response contract: 429 ONLY, with `Retry-After` and `RateLimit-*` on every response

A throttled request has exactly one correct status code and a fixed set of headers. Get this wrong and
clients cannot back off intelligently — they retry blind and amplify the overload.

### 4.1 The status code: **429 Too Many Requests** — never 200, never 503

- **Never 200.** A 200 with an error body is a lie the client's HTTP layer cannot see; its retry/cache
  logic treats it as success. The whole point of a status code is machine-readability.
- **Never 503** for a per-key rate limit. 503 means *the server* is unavailable (overloaded /
  maintenance) — it invites infrastructure-level retries and alerting, and tells the client "this is our
  fault, come back soon" rather than "you exceeded your quota, slow your own rate." Stripe explicitly
  distinguishes the two and reserves 503-class load-shedding for fleet/worker overload, not per-key rate
  limits ([Stripe — rate limiters](https://stripe.com/blog/rate-limiters): a request-rate limiter vs a
  fleet-usage load shedder are different mechanisms). 429 is the dedicated, semantically correct code:
  "the API returns an HTTP 429 Too Many Requests error" when "a client exceeds the limit"
  ([getknit.dev — Rate Limiting Best Practices](https://www.getknit.dev/blog/10-best-practices-for-api-rate-limiting-and-throttling)).
  AWS API Gateway returns "`429 Too Many Requests` error responses" specifically on token-bucket
  exhaustion ([AWS, ibid.](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)).

> **The one nuance:** a *graceful-degradation load shedder* (shedding non-critical traffic to protect
> the fleet during an incident) MAY return 503, because that genuinely is "server temporarily
> unavailable for this class of request." Keep the two mechanisms separate: **per-key quota → 429;
> fleet-protection shedding → 503.** Do not blur them.

### 4.2 `Retry-After` — tell the client exactly how long to wait

On every 429, emit `Retry-After`. Two legal forms (RFC 7231): **delay-seconds** (`Retry-After: 5`) or an
**HTTP-date** (`Retry-After: Mon, 05 Aug 2019 09:27:05 GMT`). Prefer **delay-seconds** — it is immune to
client clock skew. Set it to the seconds until the window rolls (`ceil(reset_ms / 1000)` from §3.2).

This is "the standard pattern": "catch 429 responses, read the Retry-After header for the exact wait
time" ([getknit.dev, ibid.](https://www.getknit.dev/blog/10-best-practices-for-api-rate-limiting-and-throttling)).
And on the client: "If the API sends a Retry-After header, use it — it's more precise than anything
you'd calculate yourself" (ibid.).

### 4.3 The `RateLimit-*` budget headers — on **every** response, not just the 429

The most important upgrade over a bare 429: emit the budget headers on **successful** responses too, so
a well-behaved client sees `RateLimit-Remaining` shrinking and self-paces *before* it ever hits the
wall. The IETF draft is explicit that this is allowed: "A server MAY return RateLimit header fields
independently of the response status code. This includes throttled responses."
([draft-ietf-httpapi-ratelimit-headers](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers)).

**Two header conventions exist — know both, pick one, be consistent:**

**(A) The legacy `X-RateLimit-*` / `RateLimit-*` triple** (what GitHub, Twitter, and most APIs ship,
and what api7.ai recommends):

| Header | Meaning |
|---|---|
| `RateLimit-Limit` | max requests allowed in the window |
| `RateLimit-Remaining` | requests left in the current window |
| `RateLimit-Reset` | seconds until reset (or a unix timestamp) |
| `Retry-After` | (on 429) seconds to wait |

api7.ai "mandates these headers for all rate limit responses" and notes they "are vital for API
connectivity, allowing clients to implement intelligent retry mechanisms and avoid repeatedly hitting
the rate limit exceeded error" ([api7.ai, ibid.](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices)).
This is the form used in §3.2's code and is the **pragmatic recommendation** for our service — broad
client familiarity, trivial to emit.

**(B) The IETF structured-fields form** (the standards-track direction). The draft moved from three
separate headers to a single **`RateLimit`** field (current service limit) paired with a
**`RateLimit-Policy`** field (the quota policies), using RFC 8941 Structured Fields:

```
RateLimit-Policy: "burst";q=100;w=60, "daily";q=1000;w=86400
RateLimit: "default";r=50;t=30
```

- `RateLimit-Policy` items: **`q`** (required) = quota in units; **`qu`** (optional) = quota unit,
  default `requests`, also `content-bytes` / `concurrent-requests`; **`w`** (optional) = window in
  seconds; **`pk`** (optional) = partition key.
- `RateLimit` items: **`r`** (required) = remaining quota; **`t`** (optional) = seconds to reset;
  **`pk`** (optional) = partition key.

A 429 in this form:

```
HTTP/1.1 429 Too Many Requests
RateLimit: "default";r=0;t=5
Retry-After: 5
```

And the precedence rule when both appear: "If a response contains both the RateLimit and Retry-After
fields, the **Retry-After field MUST take precedence** and the reset parameter MAY be ignored"; further,
"the reset parameter value SHOULD reference the same point in time as the Retry-After field value"
([draft-ietf-httpapi-ratelimit-headers, ibid.](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers)).

> **`[unverified — flagged]`: the draft's RFC status.** As of the searches run for this doc, the IETF
> RateLimit-headers draft (draft-ietf-httpapi-ratelimit-headers) was still a **draft and had not been
> published as an RFC** (an earlier search noted a version "expired without publication"; later drafts
> -09/-11 continued the single-`RateLimit` + `RateLimit-Policy` direction). Treat the structured-fields
> form as the *intended* standard, not a ratified one. **Recommendation for our build:** emit form (A)
> (`RateLimit-Limit/Remaining/Reset`) for maximum client compatibility today, and optionally **also**
> emit form (B) (`RateLimit` + `RateLimit-Policy`) for forward-compatibility — they do not conflict.
> Verify the current draft/RFC number before quoting a header name as "the standard."

### 4.4 The full contract, in one place

On a **denied** request:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 5
RateLimit-Limit: 60
RateLimit-Remaining: 0
RateLimit-Reset: 5

{ "type":"about:blank", "title":"Too Many Requests", "status":429,
  "detail":"Rate limit exceeded — slow down." }
```

On an **allowed** request:

```
HTTP/1.1 200 OK
RateLimit-Limit: 60
RateLimit-Remaining: 41
RateLimit-Reset: 28
```

(Body uses RFC 9457 `application/problem+json` for the error, matching the data-service's standard error
contract — see the `error-handling-and-problem-details` reference in the sibling `python-fastapi-data-service`
skill.)

---

## 5. The token-bucket SDK limiter: mirror JPM's knobs (and the per-key client recipe)

The gateway (§3) is the *server's* fair edge cap. The **client SDK** we ship to data consumers should
carry its **own** token-bucket limiter so a well-behaved client paces itself and rarely hits the
gateway's 429 — and so a migrating DataQuery user finds a familiar config surface.

### 5.1 The JPM knobs, verbatim — our SDK should expose the same shape

From `jpmorganchase/dataquery-sdk` ([GitHub](https://github.com/jpmorganchase/dataquery-sdk)):

| Knob | Default | Env var |
|---|---|---|
| Requests per minute (steady rate) | **300** | `DATAQUERY_REQUESTS_PER_MINUTE` |
| Burst capacity | **5** (tps) | `DATAQUERY_BURST_CAPACITY` |
| Max retries | **3** | `DATAQUERY_MAX_RETRIES` |
| Retry delay (base) | **1.0 s** | `DATAQUERY_RETRY_DELAY` |
| Circuit-breaker threshold | **5** failures | `DATAQUERY_CIRCUIT_BREAKER_THRESHOLD` |
| Request timeout | **600.0 s** | `DATAQUERY_TIMEOUT` |
| Pool connections / maxsize | **10 / 20** | `DATAQUERY_POOL_CONNECTIONS` / `DATAQUERY_POOL_MAXSIZE` |

The SDK's own guidance: "Tune throughput via `DATAQUERY_REQUESTS_PER_MINUTE` and
`DATAQUERY_BURST_CAPACITY`" rather than per-call concurrency flags. **Mirror this exact pair of knobs**
in our SDK (call them e.g. `requests_per_minute` + `burst_capacity`), so the migration story is "same
two dials." This is the Q4 discipline (don't invent a variation of a proven pattern) applied to the
config surface.

> **`[unverified — flagged]`: JPM's SERVER-side enforced quota is unknown.** The 300 rpm / 5 burst above
> are the **SDK's client-side defaults** — what the SDK self-throttles to, not necessarily what
> JPM's gateway enforces. JPM does not publish its server-side rate limit. **Design our server-side
> limits independently** from our own capacity math (upstream-vendor budgets, Redis throughput, DB
> connections), not by copying the SDK default. The SDK number tells you JPM thinks ~5 req/s/client is a
> reasonable *client* pace — it is a hint, not our limit.

### 5.2 A runnable token-bucket limiter (Python — the SDK client side)

```python
# sdk/_limiter.py  (the data-consumer SDK — self-throttles BEFORE the gateway sees it)
import asyncio
import time

class AsyncTokenBucket:
    """Steady refill at `rate` tokens/sec, bursts up to `capacity`.
    await acquire() blocks (paces) instead of erroring — the client self-throttles."""
    def __init__(self, rate_per_sec: float, capacity: int):
        self.rate = rate_per_sec
        self.capacity = capacity
        self.tokens = float(capacity)
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, cost: int = 1) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                # refill: tokens added = elapsed * rate, capped at capacity
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= cost:
                    self.tokens -= cost
                    return
                deficit = cost - self.tokens
                await asyncio.sleep(deficit / self.rate)  # wait just long enough to earn the token

# Mirror JPM: 300 rpm steady, burst 5.
bucket = AsyncTokenBucket(rate_per_sec=300 / 60, capacity=5)
```

`acquire()` **paces** (sleeps until a token is available) rather than rejecting — correct for a client
SDK, where the goal is to stay under the line, not to surface a 429 to your own caller. The gateway
(§3) *rejects*; the SDK *paces*. This composition is the production shape: Stripe describes the client
side as "a client-side token bucket rate-limiting algorithm" precisely so the client never floods the
server ([Stripe — rate limiters](https://stripe.com/blog/rate-limiters)).

### 5.3 The expression-per-request cap (JPM's `batch_size=20`) — a quota dimension, not a rate

A second quota axis the incumbent enforces: **how many logical items (expressions) a single request may
ask for.** Macrosynergy's DataQuery client caps this at **20**: the `DataQueryInterface` `batch_size`
"number of expressions to send in a single request" must be "a number between 1 and 20 (both included)"
([macrosynergy.download.dataquery](https://docs.macrosynergy.com/latest/macrosynergy.download.dataquery.html)).

Enforce the equivalent server-side: reject (or 400) a request whose expression/symbol list exceeds the
cap. This is a different lever from requests-per-window — it bounds the **work per request** so one
request cannot fan out into 10,000 upstream fetches. Both caps are needed: rate (requests/window) **and**
fan-out (items/request).

---

## 6. Per-key tiers & quotas: identity, daily caps, burst capacity, fan-out cap

### 6.1 Key on the **API key / user**, fall back to IP

The limiter identity is, in priority order: **authenticated API key → user id → client IP**. Keying on
IP alone is wrong for a data API — many users behind one NAT share an IP (collateral throttling), and
one user can rotate IPs. Use IP **only** as the unauthenticated fallback. Lumina's gateway keys on IP
because its finance reads are public/anonymous; the data-analytics service is key-authenticated, so it
keys on the **key**.

```python
def api_key_or_ip(request) -> str:
    key = request.headers.get("x-api-key") or getattr(request.state, "api_key", None)
    if key:
        return f"key:{key}"
    fwd = request.headers.get("x-forwarded-for", "")
    ip = fwd.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    return f"ip:{ip}"
```

### 6.2 Tiered limits — differentiate anonymous / free / paid

Production APIs tier the limit by plan. api7.ai: "differentiate by endpoint and user tier (anonymous,
free, paid tiers cited)." Slack's tiered model is the canonical example: `chat.postMessage` is Tier 3
(~50 req/min/channel), `conversations.list` Tier 2 (~20 req/min), `users.lookupByEmail` Tier 4 (~100
req/min) ([getknit.dev, ibid.](https://www.getknit.dev/blog/10-best-practices-for-api-rate-limiting-and-throttling)).
GitHub gives authenticated REST users 5,000 req/hour (ibid.).

```python
TIERS = {
    "anonymous": dict(rpm=30,    burst=5,   daily=2_000),
    "free":      dict(rpm=120,   burst=20,  daily=20_000),
    "pro":       dict(rpm=600,   burst=60,  daily=500_000),
    "enterprise":dict(rpm=6_000, burst=300, daily=None),     # None = uncapped daily
}
```

Resolve the tier from the key's plan, then construct (or look up) a limiter with that tier's `rpm` +
`burst`. Three quota dimensions per tier:

- **`rpm` (steady rate)** — the sliding-window or token-bucket refill rate.
- **`burst`** — the token-bucket capacity above the steady rate (the controlled spike a dashboard load
  is allowed); set capacity > refill to permit it (§1.4).
- **`daily` cap** — a coarse second window (`window=86400`) on top of the per-minute window, so a client
  that stays just under the minute limit all day still can't drain the whole upstream-vendor monthly
  quota. The IETF `RateLimit-Policy` form expresses both at once:
  `RateLimit-Policy: "burst";q=600;w=60, "daily";q=500000;w=86400`.

### 6.3 The fan-out cap (from §5.3) is the fourth dimension

Per tier, also cap **expressions/symbols per request** (JPM's 20). A free tier might allow 20/request, an
enterprise tier 200 — a tier knob orthogonal to rate.

---

## 7. The circuit breaker: stop hammering a dead upstream (JPM threshold = 5)

Rate limiting protects *you* from *clients*. The **circuit breaker** protects *you* from a *failing
upstream*. They are complementary and both belong in the data-plane.

The JPM SDK ships one: circuit-breaker **threshold = 5**
(`DATAQUERY_CIRCUIT_BREAKER_THRESHOLD`) — after 5 consecutive upstream failures, the breaker "opens" and
short-circuits further calls instead of waiting on (and hammering) a dead vendor
([jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk)).

The three states:

- **CLOSED** (normal): calls pass through; count consecutive failures.
- **OPEN** (tripped): at `threshold` consecutive failures, stop calling the upstream — fail fast (return
  a typed `unavailable`, serve stale cache) for a cooldown. This prevents a slow/dead vendor from (a)
  exhausting your connection pool with hanging requests and (b) turning *your* retries into a
  retry-storm DDoS on the recovering vendor.
- **HALF-OPEN** (probing): after the cooldown, allow a single trial request; success → CLOSED, failure →
  OPEN again.

```python
# app/circuit_breaker.py
import time
from enum import Enum

class State(Enum):
    CLOSED = "closed"; OPEN = "open"; HALF_OPEN = "half_open"

class CircuitBreaker:
    def __init__(self, threshold: int = 5, cooldown_s: float = 30.0):
        self.threshold = threshold      # mirror JPM's default of 5
        self.cooldown_s = cooldown_s
        self.failures = 0
        self.state = State.CLOSED
        self.opened_at = 0.0

    def _allow(self) -> bool:
        if self.state is State.OPEN:
            if time.monotonic() - self.opened_at >= self.cooldown_s:
                self.state = State.HALF_OPEN   # let ONE probe through
                return True
            return False
        return True                            # CLOSED or HALF_OPEN

    async def call(self, coro_fn):
        if not self._allow():
            raise UpstreamUnavailable("circuit open")      # → typed `unavailable`, NOT a fabricated value
        try:
            result = await coro_fn()
        except Exception:
            self.failures += 1
            if self.failures >= self.threshold:
                self.state, self.opened_at = State.OPEN, time.monotonic()
            raise
        else:
            self.failures = 0
            self.state = State.CLOSED
            return result
```

> **The breaker honors the no-fabrication rule.** When it is OPEN, the call raises
> `UpstreamUnavailable` → the endpoint returns a typed `unavailable` / serves stale cache with a
> staleness flag → it **never** backfills a fabricated number to "look complete." (Same discipline as
> Lumina non-negotiable #1; the data-service mirrors it.) One breaker **per upstream provider**, not one
> global breaker — a dead Twelve Data must not open the breaker on a healthy CoinGecko.

---

## 8. Client guidance: backoff + jitter, honor `Retry-After`, cap the retries

What you tell consumers of the API (and bake into the SDK). A throttled client that retries blind
amplifies the overload it just caused; a disciplined one decays gracefully.

### 8.1 The four rules

1. **On 429, honor `Retry-After` if present.** "If the API sends a Retry-After header, use it — it's
   more precise than anything you'd calculate yourself"
   ([getknit.dev, ibid.](https://www.getknit.dev/blog/10-best-practices-for-api-rate-limiting-and-throttling)).
2. **Otherwise, exponential backoff WITH jitter.** "each retry waits longer than the last, with a random
   component to desynchronize concurrent workers. Without randomness, multiple clients retry at the same
   time causing synchronized bursts that may generate more 429s and destabilize the system" (ibid.).
   **The jitter is the load-bearing part** — exponential backoff *without* jitter just moves the
   thundering herd to a later, synchronized instant.
3. **Cap the backoff and cap the retry count (3–5).** Ayrshare's reference: delays of "1s, 2s, 4s, 8s …
   with a 30-second ceiling" via `Math.min(1000 * Math.pow(2, attempt), 30000)`, and a configurable
   `maxRetries = 3`, "throwing after exhaustion"
   ([Ayrshare — Handling Rate Limits](https://www.ayrshare.com/complete-guide-to-handling-rate-limits-prevent-429-errors/)).
   JPM's SDK default is the same: **max retries = 3**, base retry delay **1.0 s**.
4. **Queue non-urgent work instead of retrying immediately.** "queue non-urgent requests rather than
   retrying immediately" ([getknit.dev, ibid.](https://www.getknit.dev/blog/10-best-practices-for-api-rate-limiting-and-throttling)).

### 8.2 The reference 429 handler (the exact Ayrshare shape, ported to Python)

```python
# sdk/_retry.py
import asyncio, random

async def request_with_backoff(send, *, max_retries: int = 3, base: float = 1.0, cap: float = 30.0):
    """`send()` -> an httpx.Response. Honors Retry-After; else exp backoff WITH jitter; caps retries."""
    attempt = 0
    while True:
        resp = await send()
        if resp.status_code != 429:
            return resp
        if attempt >= max_retries:
            resp.raise_for_status()                 # give up — surface the 429, do not loop forever
        # 1) honor Retry-After if the server told us exactly how long
        retry_after = resp.headers.get("Retry-After")
        if retry_after and retry_after.isdigit():
            delay = float(retry_after)
        else:
            # 2) exponential backoff, capped …
            delay = min(base * (2 ** attempt), cap)
            # 3) …WITH full jitter (decorrelate concurrent workers — the part that actually matters)
            delay = random.uniform(0, delay)
        await asyncio.sleep(delay)
        attempt += 1
```

The JS original it ports, verbatim
([Ayrshare, ibid.](https://www.ayrshare.com/complete-guide-to-handling-rate-limits-prevent-429-errors/)):

```javascript
if (response.status === 429) {
  const retryAfter = response.headers.get('Retry-After');
  const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : this.getBackoffDelay(attempt);
}
getBackoffDelay(attempt) { return Math.min(1000 * Math.pow(2, attempt), 30000); } // cap 30s
```

> **Full jitter vs the Ayrshare snippet.** Ayrshare's `getBackoffDelay` returns the *capped* delay with
> no randomness — the AWS-blessed improvement (and what getknit.dev mandates) is to then pick a random
> value in `[0, delay]` ("full jitter"), so two workers that both got 429 at the same instant do not
> retry at the same instant. The Python port above adds the jitter the JS snippet omits. This is a
> documented improvement, not a divergence — name it as such.

### 8.3 Macrosynergy's client-side self-throttle (flag it as CLIENT-side, not a server limit)

The Macrosynergy DataQuery client self-paces with `delay_param` (default **0.25 s** between requests)
and a `retry_counter`; it batches up to `batch_size=20` expressions and pre-checks a `check_connection`
heartbeat ([macrosynergy.download.dataquery](https://docs.macrosynergy.com/latest/macrosynergy.download.dataquery.html)).

> **`[unverified — flagged]` / scope tag:** these are **client-side** self-throttle constants (a
> consumer pacing *itself*), **not** a server-enforced rate limit. They tell you how a careful consumer
> paces against DataQuery (~4 req/s via the 0.25 s delay), which informs the *default pace* we bake into
> our SDK — but they say nothing about what our *server* should enforce. Do not copy a client delay into
> a server limit. (The doc excerpt "does not explicitly specify handling for HTTP 429 responses or
> maximum retry counts" at the server level — confirmed gap, surfaced rather than papered over.)

---

## 9. Anti-patterns (mistake → fix), each tied to a cited source

| Anti-pattern | Why it breaks | Fix |
|---|---|---|
| **Read-then-write the counter from app code** (`GET` then `SET`/`INCR` in two round-trips) | TOCTOU race: 100 concurrent requests each read "95/100" and each increment → 195 allowed ([oneuptime](https://oneuptime.com/blog/post/2026-01-25-redis-sliding-window-rate-limiting/view)) | One atomic op: a Redis **Lua/EVALSHA** script or `INCR`; never two trips (§2) |
| **Fail-closed limiter** (deny all if Redis is down) | A limiter outage becomes a total outage — self-inflicted DoS | **Fail OPEN** in the `catch`; arm the lib `timeout` ([ratelimit.ts](#); [Upstash gettingstarted](https://upstash.com/docs/redis/sdks/ratelimit-ts/gettingstarted)) (§3.1) |
| **Per-instance in-memory limiter believed to be global** | On a 50-instance fleet the real limit is 50× configured — invisible until spike (R-SCALE Tier-1-as-Tier-3) | Shared store (Redis) across instances; in-memory only as the dev fallback (§3.3) |
| **Fixed window at the public edge** | 2× burst across the boundary ([api7.ai](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices)) | Sliding-window counter at the gateway (§1.3) |
| **Return 200 with an error body on throttle** | Client HTTP layer treats it as success; no retry/backoff | **429 only**, machine-readable (§4.1) |
| **Return 503 for a per-key rate limit** | Invites infra-level retries + alerting; says "our fault" not "your quota" — Stripe separates the two | 429 for per-key quota; reserve 503 for fleet-protection shedding ([Stripe](https://stripe.com/blog/rate-limiters)) (§4.1) |
| **429 with no `Retry-After`** | Client can't time its retry → retries blind, amplifies overload | Always emit `Retry-After: <reset_seconds>` (§4.2) |
| **Budget headers only on the 429** | Client learns the limit only after hitting it | Emit `RateLimit-*` on **every** response so good clients self-pace ([IETF draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers)) (§4.3) |
| **Exponential backoff WITHOUT jitter** | Synchronized retries → a fresh thundering herd at each backoff step | Add full jitter `random.uniform(0, delay)` ([getknit.dev](https://www.getknit.dev/blog/10-best-practices-for-api-rate-limiting-and-throttling)) (§8.1) |
| **Unbounded retries** | A client stuck on 429 loops forever, hammering | Cap at 3–5 (JPM default 3); then surface the error (§8.1) |
| **No fan-out cap** (unlimited expressions/symbols per request) | One request → 10,000 upstream fetches; rate cap doesn't help | Cap items/request (JPM `batch_size` ≤ 20) ([macrosynergy](https://docs.macrosynergy.com/latest/macrosynergy.download.dataquery.html)) (§5.3) |
| **No circuit breaker on the upstream** | A slow/dead vendor hangs your pool; your retries DDoS its recovery | Per-provider breaker, threshold 5, fail to typed `unavailable` ([JPM SDK](https://github.com/jpmorganchase/dataquery-sdk)) (§7) |
| **Copying the JPM SDK's 300 rpm as our SERVER limit** | That's a *client* self-throttle default, not JPM's enforced server quota (unknown) | Size server limits from our own capacity math; treat the SDK number as a hint (§5.1, §8.3) |
| **One global circuit breaker for all upstreams** | A dead Twelve Data opens the breaker on a healthy CoinGecko | One breaker **per upstream provider** (§7) |
| **Backfilling a fabricated number when the breaker is open** | Violates no-fabrication; ships a made-up price as if real | Return typed `unavailable` / stale-flagged cache (§7) |

---

## 10. The build checklist (grading rubric)

A rate-limiting/quota implementation for a delivery channel is **done** only when all of these hold:

- [ ] **Algorithm named and justified.** Gateway = sliding-window counter (fair, two-integer, boundary-correct);
      per-key SDK = token bucket (controlled bursts, mirrors JPM/Stripe/AWS). Not a default reached for by habit.
- [ ] **The counter is atomic** — a single Lua/EVALSHA script or `INCR`, never `GET`-then-`SET` from app code (§2).
- [ ] **The limiter fails OPEN** — a store outage allows the request; the lib `timeout` is armed (§3.1).
- [ ] **The store is shared across instances** (Redis), not per-instance — the configured limit is the *real* limit (§3.3).
- [ ] **429 ONLY on throttle** — never 200, never 503 (503 reserved for fleet-protection shedding) (§4.1).
- [ ] **`Retry-After` on every 429**, delay-seconds form, = seconds to window reset (§4.2).
- [ ] **`RateLimit-Limit/Remaining/Reset` on EVERY response** (success too), so good clients self-pace (§4.3).
      Optionally also the IETF `RateLimit` + `RateLimit-Policy` structured form (flagged: draft, not RFC).
- [ ] **Per-key identity** (API key/user first, IP only as the anonymous fallback) (§6.1).
- [ ] **Tiers** (anonymous/free/pro/enterprise) with three dimensions: rpm (rate), burst (capacity), daily cap (§6.2).
- [ ] **Fan-out cap** — items/expressions per request bounded (JPM `batch_size` ≤ 20) (§5.3, §6.3).
- [ ] **Circuit breaker per upstream**, threshold ~5, OPEN → typed `unavailable`, never a fabricated value (§7).
- [ ] **Client guidance shipped in the SDK** — honor `Retry-After`; else exp backoff **with jitter**; cap retries 3–5;
      queue non-urgent work (§8).
- [ ] **R-SCALE tier stated in writing** — which tier the limiter survives (1×/100×/10,000×) and what breaks next (§3.3).
- [ ] **`[unverified]` flags carried** — JPM's *enforced server* quota is unknown; the 300 rpm/5 burst are SDK
      *client* defaults; size our server limits independently (§5.1, §8.3).
- [ ] **Every concrete number cited** — no rpm, burst, threshold, or header name asserted without a primary source.

---

## 11. Sources (primary first)

**Incumbent / production code & docs (read at the source level):**
- [jpmorganchase/dataquery-sdk (GitHub)](https://github.com/jpmorganchase/dataquery-sdk) — token-bucket
  rate limiting, retries, circuit breaker built in; defaults: 300 rpm
  (`DATAQUERY_REQUESTS_PER_MINUTE`), burst 5 (`DATAQUERY_BURST_CAPACITY`), max retries 3
  (`DATAQUERY_MAX_RETRIES`), retry delay 1.0 s, circuit-breaker threshold 5
  (`DATAQUERY_CIRCUIT_BREAKER_THRESHOLD`), timeout 600 s, pool 10/20.
- [Stripe — Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters) — central
  token bucket on Redis, deliberate burst-above-cap, the four limiter types, 429-vs-503.
- [AWS — Throttle requests to your REST APIs in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html) —
  token-bucket throttling (rate = tokens/sec added, burst = bucket capacity), order of limit
  evaluation, default 10,000 RPS / 5,000 burst, 429 on burst exhaustion.
- [macrosynergy.download.dataquery (docs)](https://docs.macrosynergy.com/latest/macrosynergy.download.dataquery.html) —
  client-side self-throttle: `delay_param` 0.25 s, `batch_size` 1–20 (expressions/request),
  `retry_counter`, `check_connection` heartbeat. **Client-side, not a server limit.**

**Standards / specs:**
- [IETF draft-ietf-httpapi-ratelimit-headers (RateLimit Header Fields for HTTP)](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers) —
  the `RateLimit` + `RateLimit-Policy` structured fields (`q`/`qu`/`w`/`pk`; `r`/`t`/`pk`), "MAY return
  … independently of the response status code," Retry-After-takes-precedence. **Draft, not yet an RFC —
  flagged.**

**Library / engineering writing:**
- [Upstash — Ratelimiting Algorithms](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms) —
  fixedWindow/slidingWindow/tokenBucket signatures, the sliding-window weighted-extrapolation formula
  with the `4 × ((60-15)/60) + 5 = 8` worked example, pros/cons, multi-region cost.
- [Upstash — Ratelimit Getting Started](https://upstash.com/docs/redis/sdks/ratelimit-ts/gettingstarted) —
  `limit()` returns `{success, limit, remaining, reset, pending}`; `reset` = unix ms; `pending` via
  `waitUntil`; the `timeout` fail-open option.
- [api7.ai — Rate Limiting Guide: Algorithms & Best Practices](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices) —
  the five algorithms' mechanics/pros/cons, the fixed-window boundary burst, the mandated 429 headers.
- [getknit.dev — API Rate Limiting Best Practices](https://www.getknit.dev/blog/10-best-practices-for-api-rate-limiting-and-throttling) —
  honor Retry-After, exp backoff with jitter, tiers (Slack/GitHub examples), queue non-urgent work.
- [Ayrshare — Complete Guide to Handling Rate Limits](https://www.ayrshare.com/complete-guide-to-handling-rate-limits-prevent-429-errors/) —
  the reference 429 handler: Retry-After honoring + `Math.min(1000*2**attempt, 30000)` capped backoff,
  `maxRetries = 3`.
- [oneuptime — Sliding Window Rate Limiting with Redis](https://oneuptime.com/blog/post/2026-01-25-redis-sliding-window-rate-limiting/view)
  / [single Lua script](https://oneuptime.com/blog/post/2026-03-31-redis-how-to-implement-rate-limiting-in-a-single-redis-lua-script/view) —
  the TOCTOU race (195-instead-of-100) and the Lua-atomicity fix.
- [Redis — Build 5 Rate Limiters](https://redis.io/tutorials/howtos/ratelimiting/) — sorted-set
  sliding-window log (`ZREMRANGEBYSCORE`/`ZCARD`/`ZADD`) and algorithm comparison.

**In-repo worked example (the gateway algorithm, already shipped):**
- `backend/lib/ratelimit.ts` (Lumina) — `Ratelimit.slidingWindow(60, "60 s")` on Upstash, shared across
  instances, **fail-open** in the middleware `catch`, in-memory dev fallback. The canonical reference for
  §3; the Python port in §3.2 reproduces its semantics on FastAPI.
