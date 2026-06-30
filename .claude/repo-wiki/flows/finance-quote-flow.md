---
title: Finance quote flow (home card + agent tool)
kind: flow
owning_skill: finance-markets
cites:
  - backend/finance/routes.ts
  - backend/finance/sources.ts
  - backend/finance/tools.ts
  - backend/lib/cache.ts
  - backend/index.ts
  - frontend/src/hooks/use-finance.ts
  - frontend/src/lib/finance-api.ts
fresh: 2026-06-24
---

# Finance quote flow — two distinct paths

## A) Home watchlist card (US stocks)
`finance-view.tsx` `useStocks("us")` (`use-finance.ts:62`) → `fetchStocks("us")` (`finance-api.ts:76`) →
`GET /finance/stocks` → `marketReadRoute("stocks", TTL.stocks, fetchStocks)` (`routes.ts:96`) →
`getOrRefresh("finance:stocks", 300, fetchStocks)` (`backend/lib/cache.ts:106` — returns cached if <300s,
else fetches; in-flight de-dupe + serve-stale-on-error at `cache.ts:133`) → `fetchStocks("us")`
(`sources.ts:411`) reads `TWELVE_DATA_API_KEY` (`twelveKey()` `:428`), calls Twelve Data `/quote` (`:430`),
parses via `parseTdQuote` (`:398`) → `{ items, provenance: tdProvenance() (commercialOk:false),
currency:"USD" }`. No key → `{ items:[], needsKey:true }` (`:429`). Route appends `fetchedAt`/`stale`
(`routes.ts:68`) → rendered as cards.

## B) Agent quote (user asks the chat "price of MSFT")
`/perplexity_ask` with `vertical:"finance"` → `streamFinanceAnswer` (`backend/index.ts:152`) →
`streamText` + `getQuote` tool → model calls `getQuote({symbols:["MSFT"]})` → `execute` (`tools.ts:71`)
normalizes + keys `finance:quote:MSFT` → `cachedToolFetch("getQuote", 6, key, 60, () => fetchQuotes(["MSFT"]))`
(`tools.ts:74`) → `getOrRefresh` runs `withinBudget("getQuote", 6)` **only on a cache miss** (`tools.ts:37`);
over budget → `RateBudgetError` → `{ ok:false }` → tool returns `{ unavailable }` (`tools.ts:75`). On
success `fetchQuotes` (`sources.ts:453`) hits Twelve Data `/quote` (caps 8 symbols, 8s timeout +
AbortSignal). `withGuard` staples `_disclaimer` (`hooks.ts:69`). The model **grounds its prose in the tool
result and never invents numbers** (`FINANCE_PERSONA`, `prompt.ts:160` — see
[rules/never-invent-finance-numbers](../rules/never-invent-finance-numbers.md)), streams text, writes the
`<SOURCES>` tail (`index.ts:185`), and persists before `res.end()` (`index.ts:509-510`).

The finance chat **bypasses the semantic cache and pre-search** (`index.ts:498-499`). Live in-card price
updates come separately from [useLivePrices via Supabase Realtime](../entities/frontend-hooks.md), fed by
`worker/index.ts`. See [finance](../features/finance.md) and [providers](../entities/market-data-providers.md).

**Cost note (LLM reads).** The credit-bearing reads (summary/research/briefing) ride the same
`getOrRefresh` but are flagged `{ llm: true }`, so `FINANCE_LLM_FROZEN` can serve them from cache without
regenerating (`cache.ts:118`) and the warmer skips them when frozen/fresh (`warmIfStale`, `cache.ts:163`).
See [features/finance § cost control](../features/finance.md) and
[ADR 0006](../decisions/0006-freeze-llm-surfaces-no-new-cache-table.md).
