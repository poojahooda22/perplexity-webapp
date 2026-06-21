---
name: finance-markets
description: >
  Build and extend Lumina's Finance vertical — the live market-data stack and the finance chat
  agent. Covers market-data providers (Twelve Data, Yahoo chart API, CoinGecko, Finnhub,
  Polymarket/Manifold, FMP), the free-tier-vs-commercial-display licensing gate (commercialOk),
  the cache + per-minute rate-budget layer, the Vercel AI SDK finance tool loop (getQuote/
  getCrypto/getIndices/financeWebSearch + loadSkill), live WebSocket prices (the worker +
  Supabase Realtime), US/India markets, LLM-generated market summaries & research notes,
  charts/heatmaps, and the finance frontend. Use whenever the task touches stock/index/crypto
  quotes, watchlists, sectors, market summary or research, the /finance/* routes, the finance
  chat vertical, prices going live, or licensing/attribution of market data.
metadata:
  priority: 60
  sessionStart: false
  pathPatterns:
    - 'backend/finance/**'
    - 'backend/lib/cache.ts'
    - 'backend/lib/ratelimit.ts'
    - 'worker/**'
    - 'frontend/src/components/finance/**'
    - 'frontend/src/hooks/use-finance.ts'
    - 'frontend/src/hooks/use-live-prices.ts'
    - 'frontend/src/lib/finance-api.ts'
  bashPatterns:
    - 'finance'
    - 'twelvedata'
    - 'coingecko'
    - 'finnhub'
  promptSignals:
    phrases:
      - 'finance tab'
      - 'stock quote'
      - 'stock price'
      - 'market data'
      - 'watchlist'
      - 'indices'
      - 'S&P 500'
      - 'NIFTY'
      - 'sector'
      - 'crypto price'
      - 'market summary'
      - 'finance research'
      - 'prediction market'
      - 'live prices'
      - 'heatmap'
      - 'Twelve Data'
      - 'Yahoo finance'
      - 'CoinGecko'
      - 'Finnhub'
      - 'commercialOk'
      - 'market data license'
      - 'US India markets'
    minScore: 3
---

# Finance Markets — Lumina's Finance Vertical

> Build the Finance tab and the finance chat agent the way the live code already does it:
> backend-proxied free-tier providers behind a cache + rate-budget, a hard `commercialOk`
> licensing gate at ingest, an AI-SDK tool loop that **never invents a number**, and a
> WebSocket worker that lives off Vercel. This skill is the map from any finance task to the
> exact reference + the exact file in [`backend/finance/`](../../../backend/finance/).

This is the **gold-standard skill** in this library — match its structure when building the
others.

---

## Domain Identity

**This skill OWNS:**
- The market-data fetchers in [`backend/finance/sources.ts`](../../../backend/finance/sources.ts)
  (stocks, indices, sectors, crypto, predictions; US + India).
- The cache + rate-budget layer it depends on
  ([`backend/lib/cache.ts`](../../../backend/lib/cache.ts),
  [`backend/finance/hooks.ts`](../../../backend/finance/hooks.ts),
  [`backend/lib/ratelimit.ts`](../../../backend/lib/ratelimit.ts)).
- The public read routes + cron warmer
  ([`backend/finance/routes.ts`](../../../backend/finance/routes.ts)).
- The finance **chat agent**: tools ([`backend/finance/tools.ts`](../../../backend/finance/tools.ts)),
  persona + runtime-skills manifest ([`backend/finance/skills.ts`](../../../backend/finance/skills.ts),
  `FINANCE_PERSONA` in [`backend/prompt.ts`](../../../backend/prompt.ts)), and the
  `vertical:"finance"` branch in [`backend/index.ts`](../../../backend/index.ts).
- LLM-generated narratives: [`backend/finance/summary.ts`](../../../backend/finance/summary.ts)
  and [`backend/finance/research.ts`](../../../backend/finance/research.ts),
  news in [`backend/finance/news.ts`](../../../backend/finance/news.ts).
- Live prices: the [`worker/`](../../../worker/) service + Supabase Realtime +
  [`frontend/src/hooks/use-live-prices.ts`](../../../frontend/src/hooks/use-live-prices.ts).
- The finance frontend: [`frontend/src/components/finance/finance-view.tsx`](../../../frontend/src/components/finance/finance-view.tsx)
  + finance hooks/api.
- Data **licensing & attribution** for everything above.

**This skill does NOT own (route elsewhere):**
- The generic AI-SDK mechanics (how `streamText`/tools/hooks/`loadSkill` work in the abstract)
  → **ai-sdk-agent**. This skill shows the *finance-specific* tool belt; that skill owns the engine.
- The semantic-cache/pgvector/RAG internals → **rag-retrieval**.
- Generic web-search + citation protocol → **research-agent**.
- Pure charting-library mechanics beyond finance widgets → **trading-systems** (deep TA) /
  **lumina-frontend** (UI shell).
- Crypto domain depth (on-chain, DeFi) → **crypto-defi** (this skill owns the CoinGecko *data plumbing*).

---

## Decision Tree

```
Finance task arrives
|
+-- "How is the Finance vertical wired? Where does X live?" ----> lumina-finance-architecture.md
+-- "Which provider for stocks/indices/crypto? limits? a 429?" -> market-data-providers.md
+-- "Can we DISPLAY this data? attribution? exchange fees?" ----> data-licensing-and-compliance.md
+-- "Add a cached route / tune TTL / a vendor budget / cron" --> caching-and-rate-budgets.md
+-- "Add/change a finance chat tool; the agent invents data" --> ai-sdk-finance-agent.md
+-- "Make a price go live / the worker / Supabase Realtime" ---> realtime-prices-websocket.md
+-- "Add India (or another market); symbol maps; currency" ----> us-india-markets.md
+-- "Analyze a single stock / equity write-up / no-advice" ----> equity-analysis-playbook.md
+-- "Crypto data / prediction markets / probabilities / units"-> crypto-and-prediction-markets.md
+-- "Generate a market summary / research note with the LLM" --> llm-market-narratives.md
+-- "Will this survive 100x/10000x? screener, movers, search" -> finance-at-scale-rscale.md
+-- "Charts / sparklines / S&P heatmap / TradingView widget" --> charting-and-visualization.md
+-- "Build the FinanceView UI / sub-tabs / composer / hooks" --> finance-frontend-and-ui.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Never invent a price, level, or statistic.** The agent must call a tool first; if the tool returns `unavailable`/`needsKey`, say so plainly. | `FINANCE_PERSONA` in `prompt.ts`; tools return typed `{unavailable}` not fake data. Fabricated finance numbers are the worst possible failure. |
| 2 | **Every displayed series carries `commercialOk`.** A free API tier is **not** a commercial-display license. Treat `commercialOk:false` as build-and-demo-only, never cleared for public launch. | `Provenance` type + `cgProvenance()`/`tdProvenance()` in `sources.ts`. See `data-licensing-and-compliance.md`. |
| 3 | **All provider calls are backend-proxied; keys never reach the client.** The browser holds only the Supabase anon key. | Keys read from `process.env` server-side only; `frontend/src/lib/config.ts` holds no vendor keys. |
| 4 | **Every upstream fetch goes through `getOrRefresh` (cache) and a per-minute budget on the MISS path.** Free tiers die in minutes otherwise (Twelve Data = 8 credits/min, **1 credit per symbol**). | `cache.ts` + `withinBudget()` enforced *inside* the fetcher (so a cache HIT can't be charged). |
| 5 | **State the as-of time for every quoted number** (the tool's `fetchedAt`), and surface `stale:true` honestly. Never silently serve a stale number as live. | Tools return `fetchedAt`+`stale`; cache serves stale-on-error rather than 500. |
| 6 | **Informational only — not financial advice.** Never tell a user to buy/sell/hold or give personalized allocation/suitability. End finance answers with a short "Not financial advice." | `FINANCE_PERSONA`; `withGuard` even staples `_disclaimer` onto every tool result. |
| 7 | **Indices come from Yahoo's keyless chart API, not Twelve Data.** TD's free tier 404s on raw indices (`^GSPC`). Yahoo gives real index VALUES + sparkline, no key, no credit limit, reachable from India. | `fetchIndices` / `fetchYahooQuote` in `sources.ts`. |
| 8 | **Time-sensitive finance queries must NEVER be served from the semantic cache.** Prices/news/"today" are excluded by `isTimeSensitive`. | `index.ts` `TIME_SENSITIVE` regex; the finance vertical skips the semantic cache entirely anyway. |
| 9 | **Vercel can't hold sockets or timers.** Long-lived pollers/WebSockets live in `worker/` (Fly.io); scheduled refresh is an external cron (`cron-job.org`) → `POST /finance/cron/refresh`. | `routes.ts` cron warmer; `worker/` Finnhub WS. |
| 10 | **New backend files need a full dev-server restart** — Bun `--hot` does not pick them up. Relative imports need explicit `.js` extensions or Vercel's ESM resolver fails the build. | Recurring gotcha; see `lumina-finance-architecture.md`. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Letting the model answer a price question from memory. | Force a tool call; the persona forbids guessing and tools return `unavailable` on failure. |
| Reading-then-writing a counter/budget in app code. | Use the sliding-window `withinBudget` and the cache's in-flight de-dupe; never two-step a shared counter. |
| Calling Twelve Data per symbol per user request. | Batch + cache; remember batching does NOT save credits (1/symbol) — keep the watchlist small and the TTL long. |
| Flipping `commercialOk:true` because "the API worked." | It gates *legal display*, not technical access. Only a paid commercial/display license flips it. See licensing ref. |
| Adding a sparkline via Twelve Data `time_series`. | That's 1 credit each and blows the 8/min budget. Use Yahoo's `indicators.quote[0].close` array, or skip the sparkline. |
| Putting a long-lived WebSocket/poller in a Vercel route. | Serverless freezes between requests. Use the `worker/` + Supabase Realtime path. |
| Caching a finance answer or serving a stale price as fresh. | Exclude time-sensitive queries from cache; always pass through `stale`/`fetchedAt`. |
| Hardcoding `^GSPC` into Twelve Data. | Indices = Yahoo; TD free tier excludes them. |
| Republishing a provider's news text. | Transformative multi-source synthesis (own prose) + link-out citations only. See `llm-market-narratives.md`. |
| Treating India like the US path. | India stocks/indices/sectors all ride keyless Yahoo (TD free excludes NSE/BSE); currency=INR; sectors are index points, not ETF $. |

---

## Output Contract (what "done" looks like)

A finance change is done when:
1. **Data path:** every new series has a `Provenance` ({source, commercialOk, attribution}) and
   flows through `getOrRefresh` with a sensible TTL; the MISS path is budgeted.
2. **Agent path:** any new tool returns typed results (`items`/`unavailable`/`error`/`needsKey`)
   with `fetchedAt`+`stale`, is wrapped in `withGuard`, and is described so the model knows
   exactly when to call it and what it does NOT cover.
3. **Licensing:** you can state, in one sentence, whether the series is cleared for public display
   and what attribution string renders.
4. **Resilience:** upstream failure degrades to stale-served (never a 500 on a read we've served
   before); a missing key returns `needsKey`, not a crash.
5. **Honesty:** as-of time shown; `stale` surfaced; "Not financial advice." present on agent prose;
   no fabricated numbers anywhere.
6. **Scale:** for any list/search/movers feature, you've answered the relevant **finance-at-scale**
   questions (what breaks at 100x/10000x) — see that reference.
7. **Verified:** routes return 200 with live data; if it's the chat agent, the tool actually fires
   (`[finance-hook]` logs the call). New files → full restart done.

---

## Bundled References (13 files)

Read the one or two the task needs — never the whole folder.

### Architecture & infrastructure
| File | Load when |
|------|-----------|
| `lumina-finance-architecture.md` | You need the full wiring map — every file in the finance vertical, how a request flows, the deploy topology, and the recurring gotchas. Start here when lost. |
| `market-data-providers.md` | Choosing/debugging a provider: Twelve Data, Yahoo chart API, CoinGecko, Finnhub, Polymarket/Manifold, FMP — capabilities, exact free-tier limits, credit math, error shapes, and a selection matrix. |
| `data-licensing-and-compliance.md` | Anything about whether data can be *displayed*: the `commercialOk` gate, the free-tier-display trap, exchange (NSE/BSE/NASDAQ) licensing, FMP ToS, delayed-vs-realtime, attribution strings, transformative-synthesis rule. |
| `caching-and-rate-budgets.md` | Adding/tuning a cached route, TTLs, the per-minute vendor budget, in-flight de-dupe, Upstash-vs-memory, stale-on-error, the cron warmer, and the R-SCALE read-spike pattern. |

### The finance chat agent
| File | Load when |
|------|-----------|
| `ai-sdk-finance-agent.md` | Adding/changing a finance tool, the tool loop, `stopWhen`, `onStepFinish`/`withGuard` hooks, the runtime `loadSkill` progressive-disclosure skills, disclaimer injection, the `[n]` citation wire format, abort-on-disconnect. |
| `equity-analysis-playbook.md` | The DOMAIN of analyzing a single stock neutrally: what to fetch, how to frame valuation/catalysts/risks, and the strict no-advice contract. |
| `crypto-and-prediction-markets.md` | Crypto data semantics (coin ids, market cap, 24h), and prediction markets (Polymarket→Manifold fallback, outcome probabilities, USD-vs-mana units, India geo-block). |
| `llm-market-narratives.md` | Generating market summaries / research notes with the LLM: `generateObject` + Zod, Tavily news sourcing, the legally-clean synthesis pattern, long TTLs + cron warming. |

### Markets, scale & frontend
| File | Load when |
|------|-----------|
| `realtime-prices-websocket.md` | Making a price go live: the `worker/` Finnhub WS, tick coalescing, Supabase Realtime, `use-live-prices` cache merge, why it's off Vercel, Fly deploy, market-open/closed caveats. |
| `us-india-markets.md` | Adding a market or symbol set: the `Market` switch, India symbol maps (`.NS`/`.BO`, `^NSEI`…), keyless-Yahoo-for-India, currency/unit handling, sector indices vs SPDR ETFs, separate cache keys. |
| `finance-at-scale-rscale.md` | Any list/search/ranking surface (watchlist, screener, movers, ticker search): the R-SCALE battery applied to finance, which tier the current impl survives, and what breaks next. |
| `charting-and-visualization.md` | Charts and dataviz: TradingView widgets vs Lightweight Charts vs custom D3, the S&P-500 sector heatmap/treemap, sparklines, freshness badges, TanStack Query cadence alignment. |
| `finance-frontend-and-ui.md` | Building the `FinanceView` UI: sub-tabs, the docked composer→`handleAsk` flow, watchlist favicon logos, Radix accordion, `use-finance`/`finance-api`, and how answers render via the shared chat view. |

---

## Cross-repo prior art

- **fintech-webapp** `e:\Development\Portfolio-phase2\fintech-webapp\.claude` —
  `research-data-sourcing` (`market-data-apis.md` vendor ranking, `licensing-tiers.md`
  GREEN/YELLOW/RED, `macro-official-filings.md`) is the deepest prior art for providers + licensing.
  Translate its Next.js/Drizzle code → our Express/Prisma stack.
- Project memory: `finance-tab-build`, `heatmap-implementation-kb`, `india-markets-kb`,
  `discover-news-licensing` capture decisions made while building this. Verify against live code
  before relying on any `file:line`.
