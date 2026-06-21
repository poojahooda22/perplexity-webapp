---
name: crypto-defi
description: >
  Build crypto & on-chain features for Lumina: CoinGecko data depth (coins/markets,
  ids, sparkline, 24h change, market cap/supply), crypto asset fundamentals (coins vs
  tokens, FDV vs circulating/total/max supply, stablecoins), on-chain & wallet concepts
  (EVM vs Solana, explorers, gas, free on-chain data), DeFi (DEX/AMM/liquidity pools,
  impermanent loss, lending, staking, yield, TVL via DefiLlama), prediction markets
  (Polymarket→Manifold, implied probability, USD-vs-mana units), crypto volatility/risk,
  crypto news & sentiment, and crypto safety/disclaimers. Use whenever the task touches
  crypto asset meaning, on-chain/DeFi concepts, prediction-market probabilities, or how
  to present crypto risk neutrally. Routes the *data plumbing* (cache/tools/providers/
  licensing) to finance-markets and the *engine* to ai-sdk-agent.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/finance/sources.ts'
    - 'backend/finance/tools.ts'
    - 'backend/finance/skills/crypto-research.md'
    - 'frontend/src/components/finance/**'
  promptSignals:
    phrases:
      - 'crypto'
      - 'bitcoin'
      - 'ethereum'
      - 'coingecko'
      - 'token'
      - 'market cap'
      - 'defi'
      - 'on-chain'
      - 'wallet'
      - 'staking'
      - 'TVL'
      - 'prediction market'
      - 'stablecoin'
      - 'impermanent loss'
      - 'circulating supply'
    minScore: 3
---

# crypto-defi — Lumina's Crypto / DeFi domain depth

> Make Lumina's crypto answers *correct about crypto*: read what CoinGecko returns through
> the right field semantics, frame on-chain / DeFi / prediction-market mechanics accurately,
> present volatility and scam/rug risk **neutrally**, and never give advice. This skill owns
> the **domain knowledge**; the data *plumbing* (cache, tools, providers, licensing) lives in
> **finance-markets** and the *engine* in **ai-sdk-agent**.

---

## Domain Identity

**This skill OWNS:**
- **Crypto/DeFi domain depth** — coins vs tokens, supply/market-cap/FDV/dominance, stablecoin
  types & pegs; on-chain & wallet concepts (EVM vs Solana, explorers, gas, custody); DeFi
  (DEX/AMM/liquidity pools/impermanent loss, lending, staking, yield, TVL); volatility/risk;
  crypto news & sentiment; and the high-risk-asset safety + disclaimer framing.
- **The CoinGecko data *semantics* from a crypto angle** — what
  [`fetchCrypto`/`fetchCryptoMarkets`](../../../backend/finance/sources.ts) and the
  [`getCrypto`](../../../backend/finance/tools.ts) tool actually return (ids vs tickers,
  `price_change_percentage_24h`, `market_cap`, `sparkline_in_7d`) and how to *interpret* it.
- **Prediction-market mechanics in our code** — how `fetchPredictions` turns Gamma's
  JSON-string `outcomePrices` into implied probabilities, USD-vs-mana units, the India
  geo-block + Manifold fallback.

**This skill does NOT own (route elsewhere):**
- The finance data *plumbing* — the cache + rate-budget, the tool/`withGuard` wiring, provider
  selection, the `commercialOk` licensing gate → **finance-markets**
  (`market-data-providers.md`, `caching-and-rate-budgets.md`,
  `data-licensing-and-compliance.md`, `crypto-and-prediction-markets.md`).
- The agent *engine* (how `streamText`/tools/`stopWhen`/hooks/`loadSkill` work in the
  abstract, model routing, compaction) → **ai-sdk-agent**.
- The finance UI shell → **finance-markets** (`finance-frontend-and-ui.md`).

> **NOTE — do not mis-cite:** [`backend/connectors/crypto.ts`](../../../backend/connectors/crypto.ts)
> is **cryptography** (AES-GCM encryption for OAuth tokens), **not cryptocurrency**. It has nothing
> to do with this skill. The crypto-asset code lives in `backend/finance/sources.ts` + `tools.ts`.

---

## Decision Tree

```
Crypto / on-chain / DeFi task arrives
|
+-- "What does CoinGecko return here? ids? sparkline? 24h? our fetchers/tool?" -> lumina-coingecko-data.md
+-- "Coin vs token? market cap vs FDV? circulating/total/max supply? stablecoin?" -> crypto-asset-fundamentals.md
+-- "Addresses / EVM vs Solana / explorer / gas / wallet / free on-chain data?" ---> onchain-and-wallets.md
+-- "DEX / AMM / liquidity pool / impermanent loss / staking / yield / TVL?" ------> defi-concepts.md
+-- "Prediction market probability / outcomes / USD vs mana / Polymarket geo?" ----> prediction-markets-deep.md
+-- "Volatility / drawdown / correlation / liquidity risk; how to present risk?" --> crypto-volatility-and-risk.md
+-- "Sourcing crypto news / sentiment / on-chain signals; can we republish it?" ---> crypto-news-and-sentiment.md
+-- "Disclaimers / scam-rug-phishing framing / never-advice persona pattern?" -----> crypto-safety-and-disclaimers.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Informational ONLY — crypto is a high-risk asset class.** Never tell a user to buy/sell/hold/allocate. Surface scam/rug/phishing/liquidity risk **neutrally** (state the mechanism, not a verdict). End every crypto answer with the not-advice disclaimer. | Mirrors `FINANCE_PERSONA` in [`backend/prompt.ts`](../../../backend/prompt.ts); `withGuard` in [`backend/finance/hooks.ts`](../../../backend/finance/hooks.ts) already staples `_disclaimer: "Informational only — not financial advice."` onto object tool results. |
| 2 | **Use CoinGecko coin *ids*, not tickers.** The API + `getCrypto` tool take lowercase ids (`bitcoin`, `ethereum`, `solana`) — NOT `BTC`/`ETH`. Map a user's ticker → id before calling. Many tickers collide across chains; an id is unambiguous. | `getCrypto.inputSchema` describes `"CoinGecko coin ids (lowercase), e.g. ['bitcoin','ethereum']"`; `fetchCryptoMarkets` lowercases + dedupes ids before the `?ids=` query in [`sources.ts`](../../../backend/finance/sources.ts). |
| 3 | **CoinGecko's Demo tier is PERSONAL-USE — `commercialOk:false`.** A working free key is **not** a public-display license. Treat crypto prices/mcap as build-and-demo-only until a paid plan flips it; Basic (~$35/mo) is the cheapest commercial-display tier. | `cgProvenance()` hardcodes `commercialOk: false` in [`sources.ts`](../../../backend/finance/sources.ts); the header is the Demo header `x-cg-demo-api-key`. See finance `data-licensing-and-compliance.md`. |
| 4 | **Never fabricate a price, market cap, supply, TVL, or probability.** Source every number via the finance data layer (`getCrypto`/`fetchPredictions` through the cache + budget) or a *named* free API (DefiLlama for TVL, a block explorer for on-chain) — then state the source + as-of time. | Fabricated crypto figures are the worst failure; the tool returns `{unavailable}` on rate-limit, never fake data (`getCrypto` in [`tools.ts`](../../../backend/finance/tools.ts)). |
| 5 | **Crypto is time-sensitive — never serve it from the semantic cache, and surface `stale`.** Prices move in seconds; always pass through the tool's `fetchedAt`/`stale`. | Finance vertical skips the semantic cache; tools return `fetchedAt`+`stale`. See finance `crypto-and-prediction-markets.md`. |
| 6 | **Prediction-market outcomes are *implied probabilities*, not predictions, and units differ.** Polymarket `outcomePrices` (0–1) read as probability; volume is **USD**. Manifold (the fallback) is **mana** (play money) — say so. | `fetchPredictions` sets `provenance.unit` = `"USD"` (Polymarket) vs `"mana"` (Manifold) in [`sources.ts`](../../../backend/finance/sources.ts). |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Calling the crypto tool with `BTC`/`ETH` tickers. | Map ticker → CoinGecko id (`bitcoin`/`ethereum`); the tool/fetcher expect lowercase ids and a wrong/colliding ticker silently returns the wrong (or no) coin. |
| Answering a crypto price/mcap/TVL from the model's memory. | Force a tool call (`getCrypto`) or a named free API; state source + `fetchedAt`; if `{unavailable}`, say live data is momentarily rate-limited. |
| Quoting Manifold volume/probability as if it were real money. | Check `provenance.unit`: Manifold is **mana** (play money). Label the source and that it's play-money community odds. |
| Reading a prediction-market probability as a forecast/fact. | Frame it as the market's *implied* probability from current prices — a crowd estimate that moves, not a guarantee. |
| Confusing **market cap** with **fully-diluted valuation (FDV)** or with 24h **volume**. | Market cap = circulating supply × price; FDV uses max/total supply; volume is turnover. State which you mean; low float + high FDV is a risk to flag neutrally. |
| Saying a coin "can't be a scam, it's on CoinGecko / has a high price." | Listing ≠ legitimacy and price ≠ safety. Describe rug/honeypot/unlocked-supply/low-liquidity mechanisms neutrally; never endorse. |
| Republishing a crypto news provider's article text. | Transformative multi-source synthesis in your own prose + link-out citations only (Tavily `topic:news`). See `crypto-news-and-sentiment.md` + finance licensing. |
| Flipping `commercialOk:true` on CoinGecko because "the key works." | It gates *legal public display*, not technical access. Only a paid CoinGecko commercial plan flips it. |
| Mistaking `backend/connectors/crypto.ts` for cryptocurrency code. | That file is AES-GCM token encryption (cryptography). The crypto-asset path is `backend/finance/sources.ts` + `tools.ts`. |

---

## Output Contract (what "done" looks like)

A crypto/DeFi change is done when:
1. **Identifiers:** every coin is referenced by its CoinGecko **id** (mapped from any user ticker),
   lowercased + deduped before the fetch.
2. **Numbers sourced:** every price/mcap/supply/TVL/probability comes from a tool or a *named*
   free API, with source + `fetchedAt` shown and `stale` surfaced honestly — nothing fabricated.
3. **Field semantics correct:** market cap vs FDV vs volume, circulating vs total vs max supply,
   USD vs mana, probability-not-prediction — each used with the right meaning.
4. **Licensing stated:** you can say in one sentence whether the series is cleared for public
   display (`commercialOk`) and what attribution renders ("Data provided by CoinGecko").
5. **Risk neutral:** volatility, drawdown, liquidity, scam/rug mechanisms are described as
   mechanisms, not verdicts; no buy/sell/hold/allocation language.
6. **Disclaimer present:** the not-advice line is on the answer (the agent path already staples it
   via `withGuard`).
7. **Resilience:** prediction markets fall back Polymarket → Manifold (geo-block/timeout); a rate
   limit returns `{unavailable}`, not a crash or a fake number.

---

## Bundled References (8 files)

Read the one or two the task needs — never the whole folder.

| File | Load when |
|------|-----------|
| `lumina-coingecko-data.md` *(project-grounded)* | You're touching the actual CoinGecko code: `fetchCrypto`/`fetchCryptoMarkets` (coins/markets, lowercase ids, `sparkline_in_7d`, `price_change_percentage_24h`), the `getCrypto` tool, the Demo-key header (`x-cg-demo-api-key`), and the budgets/caps (CoinGecko demo ~100/min → `getCrypto` budget 20). Cross-ref finance `market-data-providers.md`. |
| `crypto-asset-fundamentals.md` *(generic)* | You need the concepts behind the fields: coins vs tokens, market cap vs FDV vs circulating/total/max supply, 24h volume, dominance, stablecoin types & peg mechanisms — and how to read what CoinGecko returns. |
| `onchain-and-wallets.md` *(generic)* | Addresses, EVM vs Solana, block explorers, free on-chain data sources, wallet/custody concepts, gas/fees — and what is vs isn't free to query on-chain. |
| `defi-concepts.md` *(generic)* | DEXs, AMMs + liquidity pools + impermanent loss, lending, staking, yield, TVL; free data sources (e.g. DefiLlama for TVL); how to frame DeFi risk neutrally. |
| `prediction-markets-deep.md` *(project-grounded)* | Polymarket/Manifold mechanics in our code: `fetchPredictions`, JSON-string outcomes via `parseJsonArray`, implied probability from `outcomePrices`, USD-vs-mana units, the India geo-block + fast-timeout Manifold fallback. Cross-ref finance `crypto-and-prediction-markets.md`. |
| `crypto-volatility-and-risk.md` *(generic)* | Volatility, drawdowns, correlation to BTC/ETH majors, liquidity risk; presenting risk neutrally; strictly informational framing. |
| `crypto-news-and-sentiment.md` *(generic)* | Sourcing crypto news (Tavily `topic:news`), sentiment signals, on-chain signals; the transformative-synthesis licensing rule (cross-ref finance `data-licensing-and-compliance.md`). |
| `crypto-safety-and-disclaimers.md` *(project-grounded)* | High-risk-asset disclaimers, scam/rug/phishing awareness framing, never-advice — reusing the `FINANCE_PERSONA` + `withGuard` `_disclaimer` pattern. |

---

## Cross-repo prior art / cross-skill routing

- **finance-markets** (sibling skill) — owns the crypto/prediction-market *plumbing*: providers
  (`market-data-providers.md`), the cache + budget (`caching-and-rate-budgets.md`), the licensing
  gate (`data-licensing-and-compliance.md`), and the existing crypto/prediction tool semantics
  (`crypto-and-prediction-markets.md`). This skill is the *domain* layer above it.
- **ai-sdk-agent** (sibling skill) — the engine: tool loop, `stopWhen`, hooks, `loadSkill`,
  model routing. Go there for "how the agent calls tools," not "what the crypto numbers mean."
- **Runtime playbook** — the product's own `crypto-research` skill at
  [`backend/finance/skills/`](../../../backend/finance/skills/) is loaded at runtime via the
  `loadSkill` tool (see finance `skills.ts`). DESCRIBE it; this dev skill does not author it.
- **fintech-webapp** `e:\Development\Portfolio-phase2\fintech-webapp\.claude` — `research-data-sourcing`
  (`market-data-apis.md`, `licensing-tiers.md` GREEN/YELLOW/RED) is the deepest prior art for crypto
  provider ranking + display licensing; translate its Next.js/Drizzle code → our Express/Prisma stack.
- Project memory: `finance-tab-build`, `india-markets-kb`, `discover-news-licensing` capture
  decisions made while building the crypto + prediction surfaces. Verify against live code before
  relying on any `file:line`.
