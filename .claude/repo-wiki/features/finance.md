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
  - backend/index.ts
  - frontend/src/components/finance/finance-view.tsx
  - worker/index.ts
fresh: 2026-06-22
---

# Finance vertical

Two halves: **public cached READ routes** powering the Finance home, and an **agentic finance chat** running
inside `/perplexity_ask`.

## Backend modules — `backend/finance/`
| File | Role | Key exports |
|---|---|---|
| `routes.ts` | router: cached reads + cron warmer | `financeRouter` (`:14`), `readRoute` (`:30`), `marketReadRoute` (`:44`) |
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