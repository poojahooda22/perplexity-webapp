---
title: Finance vertical
kind: feature
owning_skill: finance-markets
cites:
  - backend/finance/routes.ts
  - backend/finance/sources.ts
  - backend/finance/tools.ts
  - backend/finance/summary.ts
  - backend/finance/research.ts
  - backend/finance/news.ts
  - backend/lib/cache.ts
  - backend/index.ts
  - frontend/src/components/finance/finance-view.tsx
  - worker/index.ts
fresh: 2026-06-24
---

# Finance vertical

Two halves: **public cached READ routes** powering the Finance home, and an **agentic finance chat** running
inside `/perplexity_ask`.

## Backend modules — `backend/finance/`
| File | Role | Key exports |
|---|---|---|
| `routes.ts` | router: cached reads + freeze-aware cron warmer | `financeRouter` (`:27`), `readRoute` (`:45`), `marketReadRoute` (`:59`), `warmFinanceCache(force)` (`:181`) |
| `sources.ts` | free-tier fetchers + `Provenance`/`commercialOk` | `fetchCrypto`(64), `fetchPredictions`(202), `fetchIndices`(317), `fetchSectors`(367), `fetchStocks`(411), `fetchQuotes`(453) |
| `tools.ts` | AI-SDK finance tool belt | `buildFinanceTools` (`:54`) |
| `hooks.ts` | per-tool budget + disclaimer wrapper | `withGuard`(59), `withinBudget`(26), `RateBudgetError`(43) |
| `skills.ts` | progressive-disclosure finance playbooks | `loadSkill`(67), `buildFinanceSystem`(61), `SKILLS`(51) |
| `summary.ts` | LLM cited Market Summary (Tavily→`generateObject`) | `fetchMarketSummary` (`:37`) |
| `research.ts` | LLM multi-source research notes | `fetchAllResearch` (`:97`) |
| `news.ts` | Discover news cards (headline+link only) | `fetchDiscover` (`:254`) |

Routes + auth + TTLs: [entities/routes.md](../entities/routes.md). Providers + licensing:
[entities/market-data-providers.md](../entities/market-data-providers.md). Tools:
[entities/ai-tools-registry.md](../entities/ai-tools-registry.md).

## Cost control — the LLM surfaces & the freeze switch
The three Vercel-AI-Gateway-credit-bearing reads — Market **Summary** (`routes.ts:101`), global
**Research** (`:103`), and the daily **Briefing** (`:115`) — are flagged `{ llm: true }` so the cache
layer can throttle their regeneration (the free-API reads never cost credits). Two levers:
- **Conditional warmer.** `warmFinanceCache` (`routes.ts:181`) uses `warmIfStale`
  (`backend/lib/cache.ts:163`) — it refreshes a key only when **missing or stale**, so a server restart
  (or cron tick) no longer needlessly regenerates still-fresh content. `?force=1` on the cron route
  (`routes.ts:201`) bypasses this for a manual full refresh.
- **`FINANCE_LLM_FROZEN=1` (dev only, never on Vercel).** `getOrRefresh` (`cache.ts:118`) serves the
  three LLM surfaces from cache and **never** regenerates them — the warmer skips them entirely
  (`cache.ts:172`), and the first page visit populates a surface once, then it's frozen. The boot log
  prints `[cache] backend=upstash|memory` (`backend/index.ts:756`): `upstash` ⇒ frozen surfaces survive
  restarts ($0 across restarts); `memory` ⇒ rebuilt once per cold boot.

Why a freeze flag + the existing Redis cache instead of a new Postgres/pgvector cache table:
[decisions/0006-freeze-llm-surfaces](../decisions/0006-freeze-llm-surfaces-no-new-cache-table.md).

## Agent chat
`vertical:"finance"` on `/perplexity_ask` → `streamFinanceAnswer` (`backend/index.ts:152`) → `streamText`
with the finance tools, `stopWhen: stepCountIs(6)`. **Bypasses the semantic cache + pre-search**
(`index.ts:498-499`). System prompt = `buildFinanceSystem()` (`FINANCE_PERSONA` + skills manifest). Full
trace: [finance-quote-flow](../flows/finance-quote-flow.md).

## Live prices
`worker/index.ts` (Fly.io, always-on): ONE Finnhub WebSocket → coalesced per-symbol map → Supabase Realtime
broadcast (`prices:top`) on a 1s timer. Frontend `useLivePrices` (`use-live-prices.ts:24`) merges ticks into
the cached stocks/crypto queries. Vercel can't hold the socket — see
[decisions/0002-worker-on-fly](../decisions/0002-worker-on-fly-for-websockets.md).

## Frontend
- `finance-view.tsx` — the single Finance home (indices/stocks/sectors/crypto/predictions + LLM
  Summary/Research + Discover carousel + US/India switcher). Imports all 8 `use-finance` hooks.
- API client `frontend/src/lib/finance-api.ts`; hooks `frontend/src/hooks/use-finance.ts`.

## Cross-cutting rules that bite here
[never-invent-finance-numbers](../rules/never-invent-finance-numbers.md) ·
[commercial-ok-gate](../rules/commercial-ok-gate.md). Background:
[decisions/0001-answer-cache-not-rag](../decisions/0001-answer-cache-not-rag.md),
[decisions/0004-us-india-no-new-providers](../decisions/0004-us-india-no-new-providers.md). Skill:
[finance-markets](../../skills/finance-markets/SKILL.md).