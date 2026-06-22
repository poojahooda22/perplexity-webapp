---
title: Market-data providers + the commercialOk gate
kind: entity
owning_skill: finance-markets
cites:
  - backend/finance/sources.ts
  - backend/finance/news.ts
  - backend/finance/summary.ts
  - backend/finance/research.ts
fresh: 2026-06-22
---

# Market-data providers + the `commercialOk` gate

Every displayed data series carries a `Provenance` (`source`, `commercialOk`, `attribution`, optional
`unit`) — type at `backend/finance/sources.ts:15`. **A free API tier is not a commercial-display license**,
so today **every provider is set `commercialOk: false`**. See [rules/commercial-ok-gate](../rules/commercial-ok-gate.md).

| Provider | Called by | Used for | `commercialOk` set at |
|---|---|---|---|
| **CoinGecko** (`/coins/markets`) | `fetchCrypto` (`sources.ts:64`), `fetchCryptoMarkets` (`sources.ts:78`) | crypto home + agent `getCrypto` | `cgProvenance()` `sources.ts:56` → `false` (Demo tier = personal) |
| **Polymarket** (Gamma API) | `fetchPolymarket` (`sources.ts:143`), primary in `fetchPredictions` | prediction markets | inline `sources.ts:208` → `false`, `unit:"USD"` |
| **Manifold** | `fetchManifold` (`sources.ts:170`), fallback when Polymarket geo-blocked | prediction-market fallback | inline `sources.ts:219` → `false`, `unit:"mana"` |
| **Yahoo chart API** (`fetchYahooQuote` `sources.ts:282`) | `fetchIndices` (317), `fetchSectors` (367), India path of `fetchStocks` (415) | indices, sectors, **India** stocks | inline `sources.ts:324,373,421` → `false` |
| **Twelve Data** (`/quote`) | US `fetchStocks` (`sources.ts:411`), `fetchQuotes` (`sources.ts:453`, agent `getQuote`) | US watchlist + agent quotes | `tdProvenance()` `sources.ts:394` → `false` |
| **Finnhub** (`/news`) | `fetchDiscover` US (`news.ts:254`) | Discover news (US) | inline `news.ts:256` → `false` |
| **NewsData.io** (`/latest`) | `fetchDiscoverIndiaNewsData` (`news.ts:110`) | India Discover (real images) | inline `news.ts:111` → `false` |
| **Tavily** (`@tavily/core`) | India news fallback (`news.ts:185`), `fetchMarketSummary` (`summary.ts:48`), `fetchResearchNote` (`research.ts:49`), agent `financeWebSearch` (`tools.ts:147`) | news fallback, LLM summary/research, agent search | `news.ts:186`, `summary.ts:73` → `false` |

## Licensing patterns baked into the code
- **News = headline + source + link + image only.** Publisher `summary`/body text is **deliberately
  dropped** (`backend/finance/news.ts:289`; rationale `news.ts:1-12`). See
  [decisions/0003-news-headline-linkout-only](../decisions/0003-news-headline-linkout-only.md).
- **Research = transformative multi-source synthesis** (≥3 sources, original note, cite + link out) —
  `backend/finance/research.ts:1-9`.
- **India rides Yahoo** because Twelve Data's free tier excludes NSE/BSE (`sources.ts:271,412`). See
  [decisions/0004-us-india-no-new-providers](../decisions/0004-us-india-no-new-providers.md).

Key env vars: `COINGECKO_API_KEY`, `TWELVE_DATA_API_KEY` (`"demo"` = no key), `FINNHUB_API_KEY`,
`NEWSDATA_API_KEY`, `TAVILY_API_KEY`. Missing key → fetchers return `{ items:[], needsKey:true }`, never
fabricated data — see [rules/never-invent-finance-numbers](../rules/never-invent-finance-numbers.md).
