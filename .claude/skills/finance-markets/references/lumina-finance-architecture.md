# Lumina Finance Architecture — the wiring map

> The whole Finance vertical, file by file, with the request flow, the deploy topology, and the
> gotchas that have actually bitten. `lumina-` ref = THIS codebase; cite the live file before you
> change it (line numbers drift).

---

## 1. The two faces of "Finance"

The Finance vertical is **two subsystems** that share the cache + provider layer:

1. **Public market-data reads** — cached card feeds for the Finance dashboard (`/finance/*`).
   No auth, no LLM on the hot path. Compute-once-serve-many.
2. **The finance chat agent** — `vertical:"finance"` on `/perplexity_ask`. A Vercel AI SDK
   tool loop that fetches its own live data and answers grounded in it.

Both pull from the same fetchers (`sources.ts`) through the same cache (`lib/cache.ts`), so a
dashboard read and an agent tool call for the same data share one upstream hit.

```
                         ┌─────────────────────────────────────────┐
  Browser (Finance tab)  │  Backend (Bun + Express, on Vercel)      │   Free-tier providers
  ───────────────────►   │                                          │   ─────────────────
  GET /finance/home      │  routes.ts ─► getOrRefresh ─► sources.ts ─┼─► Yahoo chart API (indices/IN)
  GET /finance/crypto    │   (cache)     (cache.ts)                  │   Twelve Data (US stocks)
  GET /finance/summary   │                                          │   CoinGecko (crypto)
                         │                                          │   Polymarket→Manifold (predict)
  POST /perplexity_ask   │  index.ts ─► streamFinanceAnswer         │
   {vertical:"finance"}  │   ─► streamText + buildFinanceTools() ───┼─► Twelve Data / CoinGecko /
  ◄─── SSE stream ───────│       (tools.ts → sources.ts via cache)  │   Yahoo / Tavily (web search)
                         │                                          │
  Supabase Realtime ◄────┼──────────  worker/ (Fly.io, OFF Vercel) ─┼─► Finnhub WebSocket
   (live ticks)          │            holds the WS, broadcasts ticks│
                         └─────────────────────────────────────────┘
  cron-job.org ──► POST /finance/cron/refresh (CRON_SECRET) ──► warms every cache key
```

---

## 2. File-by-file

### Data layer
- [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) — **the fetchers.** Each
  returns frontend-ready data + a `Provenance` ({source, commercialOk, attribution, unit?}).
  - `fetchCrypto()` / `fetchCryptoMarkets(ids)` — CoinGecko `coins/markets` (top-12 for the card;
    arbitrary ids for the agent).
  - `fetchIndices(market)` / `fetchYahooQuote(symbol,name)` — Yahoo `v8/finance/chart` (needs a
    `User-Agent` header). Real index VALUES + sparkline from `indicators.quote[0].close`. Daily
    change = `price - closes[len-2]` (NOT `chartPreviousClose`, which is the *range* previous close).
  - `fetchStocks(market)` / `fetchQuotes(symbols)` — Twelve Data `/quote` batched (US); India rides
    Yahoo. `parseTdQuote` drops error rows; a 429 top-level error throws so the cache serves stale.
  - `fetchSectors(market)` — US = 11 SPDR Select Sector ETFs (XLK…XLV) via Yahoo; India = NSE
    sectoral indices.
  - `fetchPredictions()` — Polymarket primary (4.5s `AbortController` timeout) → Manifold fallback
    (geo-block resilience; `provenance.unit` = "USD" vs "mana").
- [`backend/lib/cache.ts`](../../../../backend/lib/cache.ts) — `getOrRefresh(key, ttl, fetcher)`.
  Upstash Redis when configured, in-process Map otherwise (capped 500 entries, LRU-ish). Soft TTL
  for freshness; hard TTL = soft×12 so a stale value survives as a fallback. **In-flight de-dupe**
  (one shared fetch per key) and **stale-on-error** (never 500 a read served before).
- [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts) — `withinBudget(name, perMinute)`
  (sliding-window, process-global because vendor keys are shared) + `withGuard` (logs + staples the
  not-advice `_disclaimer` onto object results) + `RateBudgetError`.
- [`backend/lib/ratelimit.ts`](../../../../backend/lib/ratelimit.ts) — `financeRateLimit` middleware
  on the public read routes.

### Read routes
- [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts) — `financeRouter`, mounted at
  `/finance` in `index.ts` **before auth** (public). `readRoute` (plain cached read) and
  `marketReadRoute` (`?market=in` → separate `finance:in:*` cache key). Endpoints: `/crypto`,
  `/predictions`, `/indices`, `/stocks`, `/sectors`, `/summary`, `/research`, `/discover`, `/home`
  (aggregate landing payload via `Promise.allSettled`), and `POST /cron/refresh` (the warmer).
- TTLs (seconds): crypto 30, predictions 120, indices/stocks/sectors 300, summary 900, research
  21 600 (6h), discover 600.

### The chat agent
- [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts) — `buildFinanceTools()` returns a
  FRESH tool set per request + a `sources[]` accumulator. Tools: `getQuote`, `getCrypto`,
  `getIndices`, `financeWebSearch` (each `withGuard`-wrapped), plus `loadSkill`. Budget is enforced
  *inside* the cache fetcher via `cachedToolFetch` so a cache HIT isn't charged.
- [`backend/finance/skills.ts`](../../../../backend/finance/skills.ts) — the **runtime** skill system
  (separate from these dev skills): reads `./skills/*.md`, puts name+description in the system
  prompt (`skillsManifest`), and `loadSkill` returns the full body on demand. `buildFinanceSystem()`
  = `FINANCE_PERSONA` + manifest.
- [`backend/finance/skills/*.md`](../../../../backend/finance/skills/) — the runtime playbooks
  (`equity-analysis`, `crypto-research`, `market-overview`). Frontmatter `name` + `description`
  required or the loader skips them.
- [`backend/prompt.ts`](../../../../backend/prompt.ts) — `FINANCE_PERSONA` (finance-only scope, tool
  rules, no-advice, `<ANSWER>`/`<FOLLOW_UPS>` output protocol).
- [`backend/index.ts`](../../../../backend/index.ts) — `streamFinanceAnswer()` and the
  `if (req.body.vertical === "finance")` branches in `/perplexity_ask` + `/perplexity_ask/follow_up`.
  `stopWhen: stepCountIs(6)`; `onStepFinish` logs `[finance-hook] step tools=[…]`; aborts on client
  disconnect; emits the `<SOURCES>` tail from the accumulator.

### LLM narratives + news
- [`backend/finance/summary.ts`](../../../../backend/finance/summary.ts) — Market Summary: Tavily news
  → `generateObject` (Haiku, Zod schema) → headline+body items. Cached 900s.
- [`backend/finance/research.ts`](../../../../backend/finance/research.ts) — Global Research: per
  category (Rates/Credit/Equities/Economics/Market Structure/Digital Assets) Tavily → `generateObject`
  (Sonnet) → {title, summary, keyPoints[], body[]} + sources. Cached 6h; `fetchAllResearch` =
  `Promise.allSettled` across categories.
- [`backend/finance/news.ts`](../../../../backend/finance/news.ts) — Discover carousel (US Finnhub
  `/news`; India Tavily publisher search).

### Live prices
- [`worker/`](../../../../worker/) — a **separate** service (Fly.io) that holds ONE Finnhub WebSocket,
  coalesces ticks to 1/sec, and broadcasts to Supabase Realtime channel `prices:top`. Runs OFF
  Vercel (serverless can't hold sockets). Env key is `FINNHUB_API_KEY || FINHUB_API_KEY` (user's key
  has one N).
- [`frontend/src/hooks/use-live-prices.ts`](../../../../frontend/src/hooks/use-live-prices.ts) —
  subscribes with the Supabase anon key and merges ticks into the `["finance","stocks"]` +
  `["finance","crypto"]` TanStack caches.

### Frontend
- [`frontend/src/components/finance/finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx)
  — `FinanceView`: animated sub-tabs (US Markets / Crypto / Earnings / Predictions), right sidebar
  (watchlist + predictions mini), docked composer that submits via Dashboard `handleAsk`.
- [`frontend/src/hooks/use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts) +
  [`frontend/src/lib/finance-api.ts`](../../../../frontend/src/lib/finance-api.ts) — TanStack Query
  hooks aligned to the cron cadence; freshness/stale badges.

---

## 3. Request flow — the finance chat turn

1. `POST /perplexity_ask` with `{query, vertical:"finance", model?}` →
   [`index.ts`](../../../../backend/index.ts).
2. Auth middleware → `req.userId`; rate-limit (20/min/user stopgap).
3. Resolve/create the conversation; persist the user turn (non-blocking).
4. `vertical:"finance"` branch → `writeStreamHeaders` → `streamFinanceAnswer({model, system:
   buildFinanceSystem(), messages})`.
5. `streamText` runs the tool loop: model may call `getQuote`/`getCrypto`/`getIndices`/
   `financeWebSearch`/`loadSkill`; each data tool → `cachedToolFetch` → `getOrRefresh` →
   (MISS) `withinBudget` check → `sources.ts` fetcher.
6. Text streams to the client as it generates; `financeWebSearch` pushes to `sources[]`.
7. After the stream: append the `<SOURCES>` wire tail, persist the assistant turn **before**
   `res.end()` (Vercel can freeze on close), close.

Follow-ups (`/perplexity_ask/follow_up`) add compaction: keep last 6 turns verbatim, summarize
older ones into the system prompt (Haiku), then run the same finance loop.

---

## 4. Deploy topology & the landmines (all hit + fixed)

| Concern | Reality | Fix in this repo |
|---------|---------|------------------|
| Long-lived sockets/timers | Vercel functions are per-request; freeze between calls. | WebSockets → `worker/` on Fly (`auto_stop_machines=false`); cron → cron-job.org → `/finance/cron/refresh`. |
| `middleware.ts` at root | Vercel auto-deploys it as **Edge Middleware** (V8, no Node) → Prisma/pg break the build. | Auth file is named `auth.ts`, NOT `middleware.ts`. |
| ESM resolver | Backend is `"type":"module"`; Vercel runs strict Node ESM. | Every relative import needs an explicit `.js` extension (Bun is lenient locally; only breaks on Vercel). |
| Prisma 7 client | `prisma-client` generator emits `./enums.ts`-style imports. | `importFileExtension = "js"` in `schema.prisma`. |
| Top-level env crash | A client built at module load crashes the whole function if an env var is missing. | Lazy-init Supabase/Prisma (`auth.ts`); public `/finance/*` imports none of auth/db so it stays up. |
| In-memory cache on serverless | Per-instance + cold-start-wiped. | Set `UPSTASH_*` for a shared hot cache before deploying for real. |
| Frontend→backend URL | `BUN_PUBLIC_BACKEND_URL` is inlined at BUILD time and must be a full `https://…` URL. | Redeploy frontend after changing it; a scheme-less value is treated as a relative path → 404s. |

**Dev gotchas:** new backend files need a **full restart** (`bun --hot` misses them). Run the worker
locally with `bun --env-file=backend/.env.local worker/index.ts`. Prisma `db push` hangs on the
Supabase *transaction* pooler (6543) — use the *session* pooler (5432); invoke via `bun --bun run
prisma` (the CLI doesn't read `.env.local`).

---

## 5. Where to add things (cheat sheet)

- **New market-data card** → fetcher in `sources.ts` (+ `Provenance`) → route in `routes.ts`
  (`readRoute`/`marketReadRoute`) → add to cron warmer → TanStack hook in `use-finance.ts`.
- **New finance chat tool** → define in `tools.ts` (typed result, `withGuard`, budget inside
  `cachedToolFetch`) → register in the returned `tools` object → describe it in `FINANCE_PERSONA`
  if behavior is non-obvious. See `ai-sdk-finance-agent.md`.
- **New runtime skill (product playbook)** → drop a `name`+`description` `.md` in
  `backend/finance/skills/`; the manifest picks it up. See `ai-sdk-finance-agent.md`.
- **New market (e.g. EU)** → extend `Market` + symbol maps in `sources.ts`; route is already
  `?market=` aware via `marketReadRoute`; separate `finance:<market>:*` cache keys. See
  `us-india-markets.md`.
