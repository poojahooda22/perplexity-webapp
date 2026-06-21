---
name: trading-systems
description: >
  Build trading/markets analytics + UX for Lumina (informational only, never advice): technical
  indicators (SMA/EMA/RSI/MACD/Bollinger/VWAP), candlestick/OHLC data and patterns, charting
  libraries at depth (Lightweight Charts, TradingView Advanced widget, custom D3/visx),
  backtesting concepts (look-ahead/survivorship bias, slippage, fees, walk-forward, Sharpe/
  drawdown), screeners/scans, portfolio & watchlist UX, market microstructure basics (bid/ask/
  spread, order types, sessions, halts, real-time-vs-delayed licensing), and the trading-context
  safety/disclaimer contract. Use whenever the task touches technical analysis, candlesticks,
  indicators, charting at depth, backtests, screeners/scans, or portfolio/watchlist UX — and route
  market-DATA plumbing to finance-markets, crypto specifics to crypto-defi, generic chart shells to
  lumina-frontend, and the agent engine to ai-sdk-agent.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/finance/sources.ts'
    - 'frontend/src/components/finance/**'
    - 'frontend/src/hooks/use-finance.ts'
    - 'frontend/src/hooks/use-live-prices.ts'
    - 'frontend/src/lib/finance-api.ts'
  promptSignals:
    phrases:
      - 'candlestick'
      - 'ohlc'
      - 'indicator'
      - 'RSI'
      - 'MACD'
      - 'moving average'
      - 'backtest'
      - 'TradingView'
      - 'lightweight charts'
      - 'screener'
      - 'technical analysis'
    minScore: 3
---

# trading-systems

> Trading-domain depth for Lumina — indicators, candlesticks, charting, backtesting, screeners, and
> TA UX — built **informational-only, never advice**, always sourced from the finance data layer
> (never fabricated OHLC), and always ending on the not-advice disclaimer. This skill is the map from
> any TA/trading task to the exact reference; the market-DATA plumbing it stands on belongs to
> **finance-markets**.

---

## Domain Identity

**This skill OWNS:**
- **Technical indicators** — SMA/EMA, RSI, MACD, Bollinger Bands, VWAP, volume: formulas, how to
  compute from a close/OHLC array, windowing, warmup, repainting pitfalls (`technical-indicators.md`).
- **Candlestick / OHLC** — bar anatomy, patterns, timeframes/intervals, gaps & sessions, and *where
  the bars come from* on this stack: Yahoo's `v8/finance/chart` `interval`/`range` params, used by
  `fetchYahooQuote` in [`backend/finance/sources.ts`](../../../backend/finance/sources.ts)
  (`candlestick-and-ohlc.md`).
- **Charting at depth** — Lightweight Charts vs TradingView Advanced widget vs custom D3/visx as a
  decision, plus performance with thousands of points and SSR/lazy-load (`charting-libraries-deep.md`).
- **Backtesting concepts** — signal→position→returns, bias/slippage/fees, metrics; informational
  framing only (`backtesting-concepts.md`).
- **Screeners/scans** on this stack, and **portfolio/watchlist UX** including the contested-write
  reality of a cash balance (`screeners-and-scans.md`, `portfolio-and-watchlist-ux.md`).
- **Market microstructure basics** and the **trading-safety contract** (`market-microstructure-basics.md`,
  `trading-safety-and-disclaimers.md`).

**This skill does NOT own (route elsewhere):**
- Market-**DATA** plumbing — providers, free-tier limits, the cache + per-minute budget,
  `commercialOk`, the cron warmer → **finance-markets**. (This skill *consumes* that layer; it never
  fetches raw upstream.)
- Crypto specifics (coin ids, on-chain, DeFi) → **crypto-defi**.
- Generic chart *components* / the UI shell (Section cards, layout, TanStack cadence) →
  **lumina-frontend**; finance-card charting cross-refs **finance-markets** `charting-and-visualization.md`.
- The AI-SDK **engine** (`streamText`/tools/hooks/`loadSkill`, model gateway) → **ai-sdk-agent**;
  the finance tool belt → **finance-markets** `ai-sdk-finance-agent.md`.

---

## Decision Tree

```
Trading / TA task arrives
|
+-- "Compute SMA/EMA/RSI/MACD/Bollinger/VWAP from a series" ---> technical-indicators.md
+-- "OHLC shape / candle patterns / which interval+range" -----> candlestick-and-ohlc.md
+-- "Which charting lib? Lightweight vs TradingView vs D3" ----> charting-libraries-deep.md
+-- "Backtest a signal; bias/slippage/fees; Sharpe/drawdown" --> backtesting-concepts.md
+-- "Build a stock screener / scan over many equities" -------> screeners-and-scans.md
+-- "Watchlist data model / portfolio / paper-trading / cash" -> portfolio-and-watchlist-ux.md
+-- "Bid/ask/spread, order types, sessions, halts, delayed?" --> market-microstructure-basics.md
+-- "Disclaimer / no-advice framing / where it's injected" ---> trading-safety-and-disclaimers.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Informational ONLY — never buy/sell/hold, never personalized advice.** No allocation/suitability calls. End every trading answer with the not-advice disclaimer, reusing the finance pattern. | `FINANCE_PERSONA` in [`backend/prompt.ts`](../../../backend/prompt.ts); `withGuard` staples `_disclaimer: "Informational only — not financial advice."` onto object results (`DISCLAIMER` in [`backend/finance/hooks.ts`](../../../backend/finance/hooks.ts)). |
| 2 | **Source all prices/OHLC via the finance data layer — never fabricate.** Indicators and candles are computed *over real bars* that come through `sources.ts` + the cache; if the data is `unavailable`/`stale`, say so. An invented OHLC bar is the worst trading failure. | Bars from `fetchYahooQuote`/`fetchIndices` in [`backend/finance/sources.ts`](../../../backend/finance/sources.ts); cache/budget rules owned by **finance-markets**. |
| 3 | **Sparklines/series come from Yahoo close arrays, NOT Twelve Data `time_series`.** TD charges 1 credit per series call and blows the 8/min budget; Yahoo's `indicators.quote[0].close` is keyless and credit-free. Compute indicators over that close array. | `fetchYahooQuote` reads `result.indicators.quote[0].close`; see `candlestick-and-ohlc.md` + finance `market-data-providers.md`. |
| 4 | **Backtests must avoid look-ahead bias and state slippage/fees assumptions; present as illustrative, never a strategy recommendation.** Signal at bar *t* may only use data ≤ *t*; results without fees/slippage are fiction. | `backtesting-concepts.md`; framing enforced by Non-Negotiable #1. |
| 5 | **Indicators warm up — emit `null` until the window is full; never repaint.** A 14-period RSI has no value before bar 14; a value that changes after the bar closes is a bug that misleads. | `technical-indicators.md` (warmup + repainting). |
| 6 | **State the as-of time and `stale` flag for any series you chart.** "Real-time" quotes are licensed/delayed — never label a delayed/`commercialOk:false` series as live. | Quotes carry `fetchedAt`+`stale` (finance tools); `Provenance.commercialOk` in `sources.ts`; `market-microstructure-basics.md`. |
| 7 | **A screener cannot ride the per-request live-fetch path.** Scanning thousands of symbols by fanning out N Yahoo/TD calls per request dies instantly. Screeners need a server-side filter over an indexed equity table + pagination. | `screeners-and-scans.md`, cross-ref finance `finance-at-scale-rscale.md`. |
| 8 | **If a cash balance / paper-trade ledger is ever added, every mutation is an atomic guarded UPDATE + idempotency** — never read-then-write a balance in app code. | `portfolio-and-watchlist-ux.md`, cross-ref finance R-SCALE §D. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Letting the model emit an RSI/MACD value from "knowledge." | Compute the indicator over a real close array fetched through the finance data layer; if no series, say it's unavailable. |
| Pulling a chart series via Twelve Data `time_series`. | Use Yahoo's `indicators.quote[0].close` (keyless, credit-free) per `fetchYahooQuote`; TD `time_series` is 1 credit each. |
| Plotting an indicator from bar 0. | Warm up: emit `null` until the window fills (RSI-14 → first 13 bars are `null`), then plot. |
| Recomputing the last value after each tick so the candle "repaints." | Lock closed bars; only the forming (current) bar updates. State which bars are final. |
| Backtesting on the same data you tuned parameters on. | Walk-forward / out-of-sample; report no-fee AND with-fee/slippage results; label illustrative. |
| Using future bars (close of *t* to decide a trade entered at open of *t*) in a backtest. | Signal at *t* uses data ≤ *t* only; enter on the next bar. Look-ahead inflates every metric. |
| Building a screener that fans out a live fetch per symbol per request. | Server-side query over an indexed equity snapshot table with pagination; cross-ref finance R-SCALE. |
| `UPDATE balance SET amount = $computed` after reading it (paper-trade cash). | `UPDATE … SET amount = amount - ? WHERE id = ? AND amount >= ?` (atomic guard) + idempotency key. |
| Embedding the TradingView Advanced widget and calling its data "ours" / real-time. | The widget is a licensed embed showing delayed data; keep the required attribution; don't relabel it. |
| Telling the user "this is a buy" / "you should trim here." | Describe the setup neutrally (what the indicator shows, what bulls/bears would note); end with "Not financial advice." |

---

## Output Contract (what "done" looks like)

A trading/TA change is done when:
1. **Sourced:** every chart/indicator runs over real bars fetched through `sources.ts` + the cache —
   no fabricated OHLC, and Yahoo close arrays (not TD `time_series`) feed sparklines/series.
2. **Correct math:** indicators warm up (leading `null`s), use the standard settings unless the user
   overrides, and do not repaint closed bars.
3. **Honest:** as-of time + `stale` shown; delayed/`commercialOk:false` series never labeled live;
   required attribution (e.g. TradingView) rendered.
4. **Backtests (if any):** look-ahead-free, fees/slippage stated, walk-forward where claimed,
   metrics (CAGR, Sharpe, max drawdown) defined — and framed as illustrative, not a recommendation.
5. **Scale-checked:** any screener/scan/list surface answers the relevant finance R-SCALE questions
   (what breaks at 100x/10000x) instead of riding the per-request live-fetch path.
6. **Safe:** no buy/sell/hold or personalized advice anywhere; "Not financial advice." present on
   trading prose, the `_disclaimer` intact on tool object results.
7. **Verified:** the chart renders the expected series; for the agent, the data tool actually fired
   (`[finance-hook]` log). New backend files → full dev-server restart.

---

## Bundled References (8 files)

Read the one or two the task needs — never the whole folder.

### Indicators, candles & charts (generic-domain)
| File | Load when |
|------|-----------|
| `technical-indicators.md` | Computing SMA/EMA, RSI, MACD, Bollinger Bands, VWAP, volume — formulas + how to derive them from a close/OHLC array, windowing, common default settings, and the pitfalls (repainting, warmup, off-by-one on the lookback). |
| `candlestick-and-ohlc.md` | The OHLC structure, candlestick anatomy + common patterns, timeframes/intervals, gaps & sessions, and **where to source bars on this stack** (Yahoo chart `interval`/`range`, the close array `fetchYahooQuote` already reads). |
| `charting-libraries-deep.md` | Choosing a chart engine: Lightweight Charts (Apache-2.0, our own data, candles + indicator series), TradingView Advanced widget (licensed embed, delayed), custom D3/visx — a decision table, performance with thousands of points, SSR/lazy-load. Cross-ref finance `charting-and-visualization.md`. |

### Strategy & scans (generic + project-grounded)
| File | Load when |
|------|-----------|
| `backtesting-concepts.md` | Backtest basics: signal → position → returns; look-ahead/survivorship bias, slippage, fees, walk-forward, overfitting; metrics (CAGR, Sharpe, max drawdown). Informational framing only. |
| `screeners-and-scans.md` | Building a screener on THIS stack: server-side filter over an indexed equity table, pagination, virtualization — and why the current per-request live-fetch path (`sources.ts` fan-out) can't feed one. Tightly cross-ref finance `finance-at-scale-rscale.md`. |
| `portfolio-and-watchlist-ux.md` | Watchlist data-model evolution (hardcoded → per-user DB), portfolio/paper-trading concepts (informational), and the contested-write reality if a cash balance is added (atomic guarded UPDATE + idempotency). Cross-ref finance R-SCALE §D. |

### Microstructure & safety
| File | Load when |
|------|-----------|
| `market-microstructure-basics.md` | Bid/ask/spread, order types (concept), liquidity/depth, market hours & sessions, halts, after-hours; why "real-time" is licensed/delayed. Cross-ref finance `data-licensing-and-compliance.md`. |
| `trading-safety-and-disclaimers.md` | The informational-only contract for trading content: reuse `FINANCE_PERSONA` + the `withGuard` `_disclaimer`, risk framing, never advice, and exactly where the disclaimer is injected. |

---

## Cross-repo prior art / cross-skill routing

- **finance-markets** (sibling) — owns everything DATA: providers, the cache + per-minute budget,
  `commercialOk` licensing, the finance chat tool belt, charting-card mechanics, and the R-SCALE
  battery (`finance-at-scale-rscale.md`). This skill stands on that layer; route any "where does the
  price come from / can we display it" question there.
- **crypto-defi** — crypto coin ids, on-chain/DeFi depth (finance-markets owns the CoinGecko data
  plumbing).
- **lumina-frontend** — the generic UI shell / Section cards / TanStack cadence; this skill owns the
  TA-specific chart content inside them.
- **ai-sdk-agent** — the engine (`streamText`/tools/hooks/`loadSkill`, model gateway). The product's
  OWN runtime trading playbooks live at [`backend/finance/skills/*.md`](../../../backend/finance/skills/)
  (e.g. `equity-analysis.md`), loaded by `loadSkill` — describe that system, don't write one here.
- **Cross-repo:** `fintech-webapp` `e:\Development\Portfolio-phase2\fintech-webapp\.claude`
  (`research-data-sourcing`: vendor ranking + GREEN/YELLOW/RED licensing tiers) is the deepest prior
  art for provider/licensing decisions a TA chart depends on; rareLab finance KB for indicator/chart
  patterns. Translate any Next.js/Drizzle code → our Express/Prisma + Bun stack, and verify every
  `file:line` against live code before relying on it (line numbers drift).
