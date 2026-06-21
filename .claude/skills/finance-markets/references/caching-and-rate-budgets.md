# Caching & Rate Budgets — keeping free tiers alive

> The cache + budget layer every Finance read and every agent tool flows through. This is the
> machinery that turns "8 credits/min, 1 per symbol" into a product that survives a traffic spike.
> Read this when adding a cached route, tuning a TTL, setting a vendor budget, wiring the cron
> warmer, or debugging a spurious rate-limit veto. Pair with `market-data-providers.md` (the limits
> that set the budgets) and `data-licensing-and-compliance.md` (whether the cached series may even
> be displayed).

Files: [`backend/lib/cache.ts`](../../../../backend/lib/cache.ts),
[`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts),
[`backend/finance/routes.ts`](../../../../backend/finance/routes.ts),
[`backend/finance/tools.ts`](../../../../backend/finance/tools.ts),
[`backend/lib/ratelimit.ts`](../../../../backend/lib/ratelimit.ts).

---

## 1. The one idea: compute the flyer once, hand out copies

Live market data comes from rate-limited free APIs (Twelve Data = 8 credits/min, **1 per symbol**).
Hitting them once per user request is both slow and fatal to the quota. So Lumina fetches **once**,
caches the result, and serves that copy to every subsequent reader until it goes stale. This is the
R-SCALE **§C read-spike** pattern in one sentence: the deals page is computed once and copied to
lakhs of users — print the flyer, don't hand-write each one.

The layer has three jobs, three pieces:

| Concern | Mechanism | File |
|---------|-----------|------|
| Don't re-fetch what's fresh | `getOrRefresh` soft-TTL cache | `lib/cache.ts` |
| Don't blow the vendor's per-minute cap on a MISS | `withinBudget` sliding window | `finance/hooks.ts` |
| Don't let an abusive client hammer **our** endpoint | `financeRateLimit` (per-IP) | `lib/ratelimit.ts` |

The cache shields the **vendor** from normal traffic. The IP rate-limit (§7) is the seatbelt for a
buggy/abusive client that defeats the cache. They are different layers — don't conflate them.

---

## 2. `getOrRefresh` — the heart of it

`getOrRefresh<T>(key, ttlSeconds, fetcher)` in [`backend/lib/cache.ts`](../../../../backend/lib/cache.ts)
returns `{ data, fetchedAt, stale, hit }`. Four outcomes:

| Situation | Outcome |
|-----------|---------|
| Fresh (`age < ttl`) | return cached, `hit:true stale:false` — fetcher never runs |
| Missing / stale | run fetcher, write, return `hit:false stale:false` |
| Fetcher throws **but** an old value exists | return it `hit:true stale:true` — never 500 a read we've served before |
| Fetcher throws, **nothing** cached | rethrow (caller decides: route → 502, tool → typed `unavailable`) |

### Soft TTL vs hard TTL (= soft × 12)

There are **two** TTLs. The `ttlSeconds` you pass is the **soft** TTL — how long a value counts as
*fresh*. The value is physically retained much longer so the stale-on-error fallback has something
to serve. On Redis the hard TTL is `ttlSeconds * HARD_TTL_MULTIPLIER` (`= 12`) via `redis.set(key,
entry, { ex })` in `writeEntry`. On the in-memory backend there is no expiry at all — entries live
until LRU-evicted (§3). Freshness is decided in `getOrRefresh` by comparing `now - fetchedAt`
against the soft TTL, **not** by whether the key still exists. So: soft TTL = "serve fresh", hard
TTL = "keep as a lifeboat for ~12× longer."

### In-flight de-dupe (thundering-herd guard)

When a cache entry expires under load, N concurrent callers would each fire the fetcher — N vendor
credits for one refresh. The `inflight` Map keys an in-progress fetch promise by cache key; the
first MISS stores the promise, every concurrent caller `await`s the *same* promise, and it's deleted
on settle (both fulfil and reject). One refresh, one credit, regardless of how many readers race it.
This is the single most important free-tier protection on the MISS path — without it a TTL lapse
during a spike is a credit storm.

```ts
let p = inflight.get(key) as Promise<T> | undefined;
if (!p) {
  p = fetcher();
  inflight.set(key, p);
  void Promise.resolve(p).then(() => inflight.delete(key), () => inflight.delete(key));
}
const data = await p;
```

### Stale-on-error — never 500 a previously-served read

The `catch` block is the resilience contract from the SKILL's Output Contract: an upstream failure
on a key we've served before degrades to `stale:true` (logged via `[cache] refresh failed …
serving stale`), it does **not** propagate. Only a failure with *no* prior value rethrows. This is
why `stale` must be threaded all the way to the UI and the agent's prose — a stale price served as
live is a worse failure than an honest "as of 5 min ago."

---

## 3. Two backends: Upstash Redis, else a capped Map

```ts
const redis = (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) ? new Redis({…}) : null;
export const cacheBackend = redis ? "upstash" : "memory";
```

| Backend | When | Properties |
|---------|------|------------|
| **Upstash Redis** | both `UPSTASH_*` env vars set | HTTP key-value store, sub-ms reads, **shared across all serverless instances** — the only kind that works on Vercel. JSON auto-parsed on `get`. Hard-TTL via `{ ex }`. |
| **In-process Map** | no Upstash config (local `bun --hot`) | Zero setup to start building. **Per-instance** and **cold-start-wiped** on serverless — useless across instances. |

The fallback is for *local dev only*. Shipping to Vercel without `UPSTASH_*` means every serverless
instance has its own cold cache → the vendor budget gets multiplied by the instance count and the
"hand out copies" property is lost. Set the two env vars before any real deploy.

### The capped, LRU-ish Map

Agent tools key on **model-chosen** symbol sets (`finance:quote:<symbols>`, `finance:cryptomkt:<ids>`),
so the keyspace is **unbounded** — a creative model could mint thousands of distinct keys. The Map is
therefore capped at `MEM_MAX_ENTRIES = 500` and evicts oldest-**inserted** first. `memSet` does a
`delete`-then-`set` so a re-written key moves to the end (Map preserves insertion order = recency-of-
write), then trims from the front while over cap. It's LRU-by-write, not strict LRU-by-read, but it's
enough to stop unbounded growth in a single process. Redis doesn't need this — `{ ex }` expiry handles
it.

---

## 4. `withinBudget` — the per-minute vendor budget (process-global on purpose)

[`withinBudget(name, perMinute)`](../../../../backend/finance/hooks.ts) is a sliding-window counter:
a `Map<toolName, number[]>` of recent call timestamps, filtered to the last 60 s; returns `false`
(and does **not** record) if `recent.length >= perMinute`, else records `now` and returns `true`.

**Why process-global, not per-user?** The vendor API key is **one key shared by ALL users**. Twelve
Data's 8 credits/min is a cap on *our* key, not on each visitor. A per-user budget would let 100
users each fire 6 calls and instantly 429 the shared key. The budget must therefore be a single
process-wide counter — exactly as the comment in `hooks.ts` states ("one API key for ALL users, so
the budget is correctly process-global").

The budgets, set **under** each provider's documented free-tier cap (from `tools.ts`):

| Tool | Budget (`perMinute`) | Vendor cap it sits under |
|------|----------------------|--------------------------|
| `getQuote` | 6 | Twelve Data 8 credits/min (1/symbol) |
| `getCrypto` | 20 | CoinGecko Demo ≈ 30/min |
| `getIndices` | 12 | Yahoo chart (no key, no documented cap — soft self-limit) |
| `financeWebSearch` | 10 | Tavily credits |

### `RateBudgetError`

When the budget is exhausted **inside a cache fetcher**, the fetcher throws `RateBudgetError(name)`.
`getOrRefresh` then does its normal thing: serve a stale value if one exists, otherwise rethrow.
`cachedToolFetch` catches the rethrown `RateBudgetError` and converts it to `{ ok: false }`, which the
tool relays as a typed `{ unavailable: "… rate-limited right now — try again shortly." }` — never a
raw error string masquerading as data. (The model relays this honestly; it does not invent a price.)

---

## 5. `cachedToolFetch` — budget enforced INSIDE the fetcher (a real bug fixed)

This is the subtlety that bites everyone. The budget check lives **inside** the function passed to
`getOrRefresh`, in [`cachedToolFetch`](../../../../backend/finance/tools.ts):

```ts
const r = await getOrRefresh(key, ttlSec, () => {
  if (!withinBudget(name, perMinute)) throw new RateBudgetError(name);
  return fetcher();
});
```

`getOrRefresh` only runs the fetcher on a **MISS**. So putting `withinBudget` inside the fetcher means
**a cache HIT is never charged** — only a real upstream call counts against the per-minute budget.
That is correct: a HIT spends zero vendor credits, so it must spend zero budget.

> **The bug this fixed:** `withGuard` originally checked `withinBudget` **pre-call**, before the cache
> was consulted. That charged the budget on cache HITs too — so under steady traffic the window
> filled up with hits and the tool started returning false "rate-limited" vetoes while the vendor
> quota sat almost entirely unused. The `hooks.ts` comment records this: "Previously withGuard
> checked it pre-call, which charged the budget on cache HITs too and caused false rate-limit
> vetoes." The fix: move the check inside the fetcher; `withGuard` now only logs + staples the
> disclaimer.

**Exception — uncached calls are budgeted per-call.** `financeWebSearch` is *not* cached (every query
is a fresh Tavily call), so it calls `withinBudget("financeWebSearch", 10)` directly at the top of
`execute`. That's correct precisely because each call really does spend a credit — there is no HIT to
exempt.

> **Don't thread the AbortSignal into a cached fetcher.** The fetcher is **shared** across concurrent
> callers via in-flight de-dupe; one caller disconnecting must not abort the fetch the others are
> awaiting. Client-disconnect cancellation is handled at the `streamText` level, not in the fetcher.
> See the note in `tools.ts`.

---

## 6. TTLs — the table and how to choose

From `TTL` in [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts):

| Series | TTL | Reasoning |
|--------|-----|-----------|
| `crypto` | 30 s | Moves fast; CoinGecko budget is generous. |
| `predictions` | 120 s | Probabilities drift slowly; Polymarket/Manifold not credit-tight. |
| `indices` | 300 s | Yahoo is keyless but be polite; index level is fine at 5 min. |
| `stocks` | 300 s | **Twelve Data budget-defining.** 6-symbol watchlist × (1/300s) keeps us under 8/min + 800/day. |
| `sectors` | 300 s | 11 SPDR ETFs (US) / NSE sectoral indices (IN); same provider economics. |
| `summary` | 900 s (15 m) | LLM-backed → generation is expensive; regenerate ~once per window. |
| `research` | 21 600 s (6 h) | LLM + multi-category; analytical content changes slowly. |
| `discover` | 600 s | News carousel; Finnhub (US) / Tavily (IN). |

**Choosing a TTL — the decision:**

1. **How fast does the number actually change for the user's purpose?** A crypto price wants 30 s; a
   6-hour research note does not.
2. **How tight is the vendor budget?** Tighter cap ⇒ longer TTL. The TTL is the lever that keeps a
   small watchlist under a small per-minute cap (`stocks` at 300 s is *driven* by Twelve Data's cap,
   not by how fast prices move).
3. **Is the MISS expensive (LLM/Tavily) rather than just rate-limited?** Then go long (`summary`
   15 m, `research` 6 h) and **warm it with cron** (§8) so no user pays the cold generation cost.

### Cache keys & market-awareness

`readRoute(key, ttl, fetcher)` is a plain cached read (502 only when there's nothing). `marketReadRoute`
serves India from a **separate key** — `finance:in:<name>` for `?market=in`, `finance:<name>` for US —
so the two markets never collide in one cache slot. When you add a market or a series, give it its own
key; never reuse a key across `Market` values. The `/home` aggregate fans out four `getOrRefresh`
calls with `Promise.allSettled` so one cold/failed series degrades to `null` instead of failing the
whole landing payload.

---

## 7. The IP rate-limiter (a different layer)

[`financeRateLimit`](../../../../backend/lib/ratelimit.ts) is Express middleware on every public
`/finance/*` read: **60 requests / 60 s per client IP**. Upstash `Ratelimit.slidingWindow` (shared
across instances) when `UPSTASH_*` is set, else an in-memory per-instance window. Two design choices:

- **Fail OPEN.** If the limiter check throws (Upstash outage), it logs and calls `next()` — a limiter
  outage must not take down reads. (Contrast the *cache*, which fails toward stale-served data.)
- **It guards OUR endpoint, not the vendor.** The cache already shields vendors from normal traffic;
  this stops a scraper/buggy client from burning Upstash command quota, Vercel invocations, and
  AI-backed-panel LLM spend.

`withinBudget` (vendor cap, process-global, on the MISS path) and `financeRateLimit` (our endpoint,
per-IP, on every request) are independent. Don't replace one with the other.

---

## 8. The cron warmer — because Vercel can't run timers

Serverless functions are frozen between requests; there is no place to hang a `setInterval`. So
scheduled refresh is **external**: a free scheduler (cron-job.org) POSTs to
`POST /finance/cron/refresh`, which forces a refresh of every series (passing TTL `0` so the fetcher
always runs) so the cache stays hot.

- **Auth:** guarded by `CRON_SECRET` (Bearer header or `x-cron-secret`); if the env var is unset the
  guard is **skipped** (open in local dev). Set it in production.
- **What it warms:** US `indices/stocks/sectors/crypto/predictions/summary` **and** the India
  `in:indices/in:stocks/in:sectors/in:summary` keys (matching `marketReadRoute`'s `finance:in:*`
  scheme). The LLM-backed `summary` is explicitly warmed so the first user after a TTL lapse doesn't
  eat the cold generation cost — those are otherwise never pre-warmed.
- **Resilience:** `Promise.allSettled` over the jobs; the response reports `{ key, ok }` per job so a
  single upstream failure doesn't abort the warm.

**When you add a long-TTL or LLM-backed series, add it to the cron job list** — otherwise its first
post-expiry reader pays the full cold cost. Cheap, fast series (30 s crypto) don't need warming; they
refresh naturally under traffic.

---

## 9. R-SCALE: the read-spike posture (§C) and listing (§A)

Reads are the easy scale surface *if* you cache them. Mapping this layer to the R-SCALE battery:

| R-SCALE question (§C/§A) | This layer's answer |
|--------------------------|---------------------|
| §C-11 What is cached and where? | Every series via `getOrRefresh`; Upstash (shared) in prod, Map in dev. |
| §C-12 Can read capacity scale without touching writes? | Yes — readers all hit the cached copy; the single refresh is the only "write" to the upstream. |
| §C-13 What degrades gracefully under overload? | Stale-on-error serves the last good copy; `/home` `allSettled` serves partial data; the IP limiter sheds abuse with 429, not a crash. |
| §A-1 How many items in client memory? | Reads are small fixed payloads (watchlist ≤ a few symbols), not 1M-row lists — this layer is about *freshness under load*, not pagination. |

For genuine list/search/movers/screener surfaces (where §A pagination, indexing, and §H ranking
matter), this layer is necessary but not sufficient — route to `finance-at-scale-rscale.md`.

---

## 10. Multi-instance: move the counters to Redis

The cache and the IP limiter already use Upstash when configured — they are correct across instances.
**The vendor budget (`withinBudget`) and the in-memory cache fallback are NOT.** `callLog` is a
process-local Map. On a single Fly worker or one serverless instance this is fine. The moment Vercel
runs the finance agent on **N concurrent instances**, each has its own counter → the effective vendor
budget is `perMinute × N`, which will 429 the shared vendor key.

**The fix** (when finance chat runs multi-instance): back `withinBudget` with the same Upstash
sliding-window primitive `lib/ratelimit.ts` already uses (`Ratelimit.slidingWindow`, distinct
`prefix` per tool), so the per-minute window is shared. The `hooks.ts` comment flags exactly this:
"For a multi-instance deploy, back the window with Redis (see lib/ratelimit.ts)." Until then, keep the
finance agent on a single instance or accept that budgets are per-instance.

---

## Anti-patterns

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Checking the budget **before** the cache (pre-call). | Check inside the fetcher (`cachedToolFetch`) so a cache HIT isn't charged — this was the false-veto bug. |
| Per-user vendor budget. | Process-global `withinBudget` — the API key is shared, so the cap is shared. |
| Read-then-write a shared counter in app code. | Sliding-window `withinBudget` + in-flight de-dupe; never two-step a contested counter. |
| Deploying to Vercel without `UPSTASH_*`. | Set both env vars — else every instance has a cold per-instance cache and the budget multiplies. |
| Threading the request's AbortSignal into a cached fetcher. | Never — the fetcher is shared across callers; cancel at the `streamText` level. |
| Serving a stale value as if it were live. | Thread `stale`/`fetchedAt` to the UI and agent prose; honest "as of …". |
| 500-ing a read when upstream fails. | Stale-on-error: serve the last good copy; 502 only when nothing was ever cached. |
| `setInterval` / timer in a Vercel route to refresh. | External cron → `POST /finance/cron/refresh` with `CRON_SECRET`. |
| Adding a long-TTL/LLM series without cron-warming it. | Add it to the cron job list so the first post-expiry reader doesn't pay the cold cost. |
| Reusing one cache key across US and India. | Separate keys (`finance:in:<name>` vs `finance:<name>`) per `Market`. |
| Making `financeRateLimit` fail closed. | Fail OPEN — a limiter outage must not take down reads. |
| Conflating the IP limiter with the vendor budget. | They're different layers: per-IP endpoint guard vs process-global vendor cap. |
