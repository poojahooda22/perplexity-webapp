# Charting & Visualization — finance dataviz on Lumina

> How the Finance tab draws things: index strips, sparklines, the crypto/prediction cards, and the
> S&P-500 sector heatmap — which render path to pick, where the data comes from, how freshness/stale
> is surfaced, and why the poll cadence is tied to the cache TTL. `lumina-` ref = THIS codebase; cite
> the live file before changing it (line numbers drift). Adjacent: `market-data-providers.md` (where
> the numbers come from + free-tier limits), `data-licensing-and-compliance.md` (whether you may
> *display* them), `finance-frontend-and-ui.md` (the surrounding UI shell), `caching-and-rate-budgets.md`
> (the TTLs this aligns to).

Files this ref is grounded in:
[`frontend/src/components/finance/finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx),
[`frontend/src/hooks/use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts),
[`frontend/src/lib/finance-api.ts`](../../../../frontend/src/lib/finance-api.ts).

---

## 0. The one rule that decides everything

**Charting in finance is a licensing decision before it is a rendering decision.** The render lib is
cheap; the right to *display* ~500 live equity quotes is not (per-user NASDAQ/NYSE exchange fees). So
the decision tree forks on **who owns the data on screen**, not on which library is prettiest:

- **Their data, their license** → embed a vendor widget (TradingView). Zero data sourcing, zero
  `commercialOk` burden — it never touches our backend/cache/licensing gate. This is how the S&P
  heatmap ships today.
- **Our data, our license** → draw it ourselves (inline SVG / Lightweight Charts / d3). Now every
  series carries a `Provenance` with the correct `commercialOk` and flows through `getOrRefresh`. This
  is how the index strip, sparklines, and the card grids work.

Never blur the two: do not "borrow" a TradingView number to drive our own chart, and do not put our
free-tier-only (`commercialOk:false`) data inside a public-facing surface that implies it's licensed.

---

## 1. Render-path decision table

| Surface | What it shows | Render path **today** | Why / data source |
|---|---|---|---|
| **Index strip** ("Top Assets") | S&P/NASDAQ/DJI/VIX (or NIFTY/SENSEX) value, day Δ, mini sparkline | Inline custom **SVG** (`IndexCard` + `Sparkline`) | Our data via keyless Yahoo `v8/finance/chart`; 4 cards, trivial to draw; no lib needed. |
| **Sparkline** (index + crypto cards) | ~30-point line, green up / red down | Inline custom **SVG** `<path>` (`Sparkline`) | Data is a plain `number[]` already in the payload; a polyline is ~15 lines. |
| **Crypto card grid** | price, 24h Δ, sparkline, mkt cap | Inline SVG card (`CryptoCard`) | CoinGecko `sparkline` array; same `Sparkline` component. |
| **Prediction card** | outcome probability bars | Inline divs + width-% bars (`PredictionCard`) | Polymarket/Manifold probabilities; no chart lib — a styled progress bar. |
| **S&P-500 sector heatmap** | ~500 names, grouped by sector, sized by mkt cap, colored by day % | **TradingView embeddable widget** (`Sp500Heatmap`) | ~500 live US-equity quotes = exchange-display licensing we don't hold. The widget's license covers it. |
| **Standout single-asset chart** (future) | candlesticks / OHLC for one ticker | **Lightweight Charts** (planned) | Apache-2.0, our own Yahoo OHLC; financial-native; tiny. |
| **Branded heatmap** (Tier-2, future) | same as above, our styling + hover instrumentation | **custom d3-hierarchy treemap** (planned) | Owns data + ranking signals; needs FMP display + GICS license first. |

### When to reach for which (decision framework)

```
Need a chart?
|
+-- Does it require DISPLAYING data we don't have a commercial license for
|   (mass US equities, exchange-fee-bearing)? ── YES ─► embed a vendor WIDGET (TradingView).
|                                                       Don't fetch the data at all.
|   NO (our own commercialOk-cleared series) │
|                                            ▼
+-- Is it a handful of points (sparkline, 4-card strip, % bars)? ── YES ─► inline SVG / divs.
|                                                                          No library. (current code)
|                                            NO │
|                                               ▼
+-- Is it financial-native (candles, OHLC, time axis, crosshair, one symbol)? ── YES ─►
|        Lightweight Charts (Apache-2.0, ~45KB, TradingView's own OSS lib, our data).
|                                               NO │
|                                                  ▼
+-- Bespoke layout (treemap, sankey, custom diverging legend, hover→rank signals)? ─► visx / d3
         (d3-hierarchy for the treemap). Only when a lib can't express the layout.
```

**Library shortlist (when inline SVG isn't enough):**

| Lib | License | Use it for | Avoid for |
|---|---|---|---|
| **Lightweight Charts** | Apache-2.0 | candlesticks/OHLC/area for a single asset, our data | dashboards of many tiny charts (heavier than inline SVG) |
| **d3-hierarchy** (+ d3-scale) | ISC | the branded treemap/heatmap (Tier-2) | simple lines — overkill |
| **visx** | MIT | bespoke React-native primitives when you want React control of every node | when a finished chart lib already fits |
| **TradingView embed widget** | free w/ mandatory attribution | mass-equity surfaces whose data we can't license (heatmap) | anything you need to style to shadcn or instrument for clicks |
| ❌ Highcharts / ApexCharts | proprietary / revenue-gated | — | never (paid/dual-license traps) |

---

## 2. Sparklines — sourced from Yahoo close arrays, never Twelve Data `time_series`

The `Sparkline` component (in `finance-view.tsx`) takes a `points: number[]` and renders an inline SVG
polyline scaled to a 120×40 viewBox, colored emerald (up) / rose (down):

```tsx
// finance-view.tsx — Sparkline
const min = Math.min(...points), max = Math.max(...points);
const span = max - min || 1;                       // avoid /0 on a flat line
const d = points.map((p, i) => {
  const x = (i / (points.length - 1)) * w;
  const y = h - ((p - min) / span) * h;            // SVG y is inverted
  return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
}).join(" ");
// <2 points → render an empty spacer (don't draw a degenerate line)
```

**Where the points come from is a budget decision, not a viz one:**

| Series | Sparkline source | Cost |
|---|---|---|
| Indices / India (`Quote.sparkline`) | Yahoo `v8/finance/chart` → `indicators.quote[0].close` array (already fetched for the index value) | **0 extra** — it rides the same call that returns the level. |
| Crypto (`CryptoCoin.sparkline`) | CoinGecko `coins/markets?sparkline=true` (one array per coin in the same response) | **0 extra** — part of the markets call. |
| US watchlist stocks (`Quote.sparkline?`) | **none** — Twelve Data `/quote` returns no series | A `time_series` call is **1 credit each** and blows the 8/min budget. |

> **Anti-pattern that marks an amateur:** adding a watchlist sparkline via Twelve Data `time_series`.
> 6 watchlist symbols × 1 credit = 6 credits *just for the sparklines*, on an 8-credit/min cap. The
> watchlist ships **without** sparklines on purpose; `Quote.sparkline` is optional and `IndexCard`
> guards `q.sparkline ?? []` (so an absent array degrades to a clean empty spacer, not a crash).

If you ever need a US-stock sparkline, get it from Yahoo's close array (the same source the indices
already use), not from a per-symbol TD time-series.

---

## 3. The day-change pitfall (color + arrow correctness)

Every up/down color and arrow on this page reads off `changePercent` / `change`. Those are computed
**in the backend fetcher**, and the trap is which "previous close" you subtract:

- Correct daily change = `price - closes[len-2]` (yesterday's close).
- **Wrong:** `meta.chartPreviousClose` — that's the close *before the whole 1-month range*, so the card
  would render the **monthly** move dressed up as today's. See `fetchIndices`/`fetchYahooQuote` in
  `sources.ts` and `market-data-providers.md`.

On the client, `ChangePct` and `IndexCard` simply trust the sign: `up = (changePercent ?? 0) >= 0`
→ emerald + `TrendingUp`, else rose + `TrendingDown`. Garbage-in here paints the whole strip the wrong
color, so the fix lives upstream — never "correct" it in the component.

---

## 4. The S&P-500 sector heatmap — embed, don't build (Tier-1)

`Sp500Heatmap` in `finance-view.tsx` is the canonical example of "their data, their license." It is a
TradingView **Stock Heatmap** widget, configured to match Lumina's look exactly:

```ts
// finance-view.tsx — Sp500Heatmap config (passed as the widget's JSON body)
dataSource: isIndia ? "NIFTY500" : "SPX500",   // ~500 names per market
blockSize:  "market_cap_basic",                 // rectangle AREA = market cap
blockColor: "change",                           // rectangle COLOR = daily % change (diverging red→green)
grouping:   "sector",                           // GICS sectors, with header strips
colorTheme: "dark",
hasSymbolTooltip: true,
isZoomEnabled: true,
```

The three knobs that define a treemap heatmap: **`blockSize` = size encoding (market cap)**,
**`blockColor` = color encoding (daily % change, a diverging scale centered at 0)**,
**`grouping` = the partition (sector)**. Memorize that triple — it's the same mental model you'll
re-implement in d3 for Tier-2.

### Why a widget and not our own d3 treemap (the licensing math)

| Concern | TradingView widget (Tier-1, shipped) | Custom d3 treemap (Tier-2, planned) |
|---|---|---|
| Data sourcing | none — TradingView fetches it | ONE bulk call (constituents+cap from iShares IVV holdings CSV; %change from FMP `batch-quote`/Polygon grouped-daily), cached |
| Exchange-display license | **TradingView's burden** (their license covers CBOE/15-min-delayed) | **ours** — public real-time US-equity display = per-user NASDAQ/NYSE fees → must be 15-min-delayed/EOD, `commercialOk:false` until FMP display + GICS licenses signed |
| Styling | opaque iframe, can't match shadcn/Tailwind | full shadcn control |
| Instrumentation | none (no hover/click → no R-SCALE §H ranking signals) | can capture clicks/hover |
| Attribution | **mandatory, non-removable** TradingView link (ToS — stripping it = ban + legal) | our own |
| Ship cost | ~one component | data join + cron + `getOrRefresh` + d3 render |

> **GICS itself is licensed IP** (S&P DJI + MSCI). The widget sidesteps this too; a custom build needs
> a GICS license to display sector groupings regardless of where the constituents come from. This is
> the decisive reason Tier-1 is the widget. Full Path-B plan: `caching-and-rate-budgets.md` +
> `finance-at-scale-rscale.md`; render-lib detail below.

### Two embed gotchas baked into the live code (do not "simplify" these away)

1. **It's mounted via `<iframe srcDoc>` on purpose.** TradingView's embed script runs cross-origin
   and emits a benign `"Script error."`. The parent window's dev error overlay (Bun runtime / global
   `onerror`) would surface that as a **fatal Runtime Error**. Nesting the widget in our own iframe
   confines the error to that iframe's window. The widget still renders (it creates *its own* inner
   iframe). Don't refactor it to a bare `<script>` injector in the React tree — the overlay will fire.
2. **The iframe needs a `key` that changes with the market.** Mutating `srcDoc` on a live iframe does
   **not** reliably reload it after the embed script has run, so `key={isIndia ? "heatmap-in" :
   "heatmap-us"}` forces a full remount on the US⇄India switch. Without it the widget stays stuck on
   the first market's heatmap.

### When to graduate to the custom d3 treemap (Tier-2 cheat sheet)

Reach for Path B only when branded styling, data ownership, or ranking instrumentation actually
matter — and only after the licenses are signed. Then:

- **Layout:** `d3.treemap().tile(treemapSquarify)` (use `treemapResquarify` for stable
  resize/refresh), `.paddingTop` for the "Technology +3.04%" sector header strip, `.paddingInner(2)`
  for gutters; `.sum(d => d.marketCap)` rolls cap up so sector rects size correctly.
- **Color:** `scaleDiverging([-3, 0, +3]).clamp(true)` red→neutral-gray→green. **Center MUST be 0**
  and the domain is **fixed (clamped), not data-driven** — a relative scale lies about magnitude.
  Add a colorblind-safe (lightness-varying) ramp behind a toggle + a gradient legend.
- **Render tech:** SVG/divs at ~500 nodes is **correct** — do not reach for canvas. Switch to Canvas
  only at ~3000+ nodes or sub-second repaint (then WebGL/PixiJS). Cull a cell's label below ~3ch.
- **Mobile:** a shadcn **Accordion** sector list (already imported in `finance-view.tsx`), **never** a
  shrunk treemap. Expand = a shadcn Dialog reusing the same component at full size.
- **Lib fallbacks:** @nivo/treemap (MIT, real Canvas variant) or ECharts (Apache-2.0). **Reject**
  Highcharts (proprietary) and react-apexcharts (revenue-gated dual license).

---

## 5. Freshness & stale badges — drive them off the payload, never the clock

Every finance payload carries the freshness signals; the UI must reflect them honestly (Non-Negotiable
#5: never serve a stale number as live).

- **`Provenance.attribution`** → rendered verbatim as the section's right-aligned label (the
  `Section` component's `attribution` prop). This is also the legal attribution string — it is not
  decoration; for the heatmap the TradingView link is **mandatory**.
- **`fetchedAt` (epoch ms) + `stale` (boolean)** are on `CryptoPayload`/`PredictionsPayload`/
  `QuotesPayload` (`SummaryPayload`/`ResearchPayload` carry only `stale`) (`finance-api.ts`). The cache serves **stale-on-error** rather
  than 500, and flags it via `stale:true` — surface that, don't hide it.
- **`updatedAt` (ISO)** on summary/research → `MarketSummary` renders `Updated ${timeAgo(updatedAt)}`
  ("just now" / "12 min ago" / "3h ago" via the `timeAgo` helper).
- **`needsKey`** → render the `NeedsKey` / Discover key-prompt panel (tells the user which env var to
  set), not a spinner-forever or a crash.
- **Live-tick badge** (`LiveBadge`, fed by `useLivePrices`): `live` (emerald, pulsing) / `idle`
  (amber — connected but no ticks, e.g. market closed) / `—` (not connected). This is the *WebSocket*
  freshness, separate from the cache `stale` flag (see `realtime-prices-websocket.md`).

**Pattern to copy for a new card:** read `provenance.attribution` into `<Section attribution=…>`; if
`needsKey` → key panel; else `isLoading || isError` → `PanelState`; else if there's a `fetchedAt`
that's older than expected, render a small "stale" chip from `payload.stale` (don't recompute
staleness from `Date.now()` — trust the backend's flag, which knows the soft/hard TTL).

> **Anti-pattern:** computing "is this stale?" on the client from `Date.now() - fetchedAt`. The cache
> already encodes soft-TTL (freshness) vs hard-TTL (survives-as-fallback) semantics; the client can't
> see those thresholds. Render `payload.stale`, full stop.

---

## 6. Poll cadence — align `refetchInterval` to the cron/TTL, never faster

`use-finance.ts` is the textbook of this rule: **the client must not poll faster than the data can
change.** Each TanStack Query `refetchInterval` is set at or above the backend cache TTL, so most
polls are cache HITs (free) and only a fraction trigger a budgeted upstream MISS.

| Hook | `refetchInterval` | Backend TTL (see `routes.ts`) | Note |
|---|---|---|---|
| `useCrypto` | 30s | crypto 30s | The fastest card; matched 1:1. |
| `useIndices` / `useStocks` | 60s | 300s | Polls more often than the TTL refreshes — fine (HITs), and lets live WS ticks land between cache cycles. |
| `usePredictions` | 120s | predictions 120s | Matched. |
| `useSectors` | 300s | sectors 300s | Matched. |
| `useMarketSummary` | 600s (10m) | summary 900s (15m) | Intentionally **slower** poll than even the TTL — LLM narrative barely moves. |
| `useResearch` | 1,800s (30m) | research 21,600s (6h) | Very slow — 6h-cached LLM notes; 30m poll is generous. |
| `useDiscover` | 300s (5m) | discover 600s (10m) | Poll < TTL; news refreshes on the cron. |

**Why this matters at scale:** the real refresh is the **cron warmer** (`cron-job.org` →
`POST /finance/cron/refresh`) which recomputes every cache key on the TTL cadence — compute-once,
serve-many. Lakhs of readers then hit the warm cache; client polls are just "has the warm blob
changed?". Polling faster than the TTL buys nothing (you re-read the same cached value) and, on a
cache MISS storm (cold start), can stampede the per-minute vendor budget. The in-flight de-dupe in
`getOrRefresh` protects the upstream, but the client cadence is your first line of defense.

> **Anti-pattern:** `refetchInterval: 5_000` on a stock card "to feel live." The data is on a 300s
> TTL — you'd render the identical number 60 times and waste cache reads. Want truly live? That's the
> **WebSocket** path (`use-live-prices.ts` merges ticks into the `["finance","stocks"]` /
> `["finance","crypto"]` caches), not a tighter poll. See `realtime-prices-websocket.md`.

---

## 7. Number & currency formatting (consistency = trust)

The formatters at the top of `finance-view.tsx` are the house style — reuse them, don't reinvent:

| Helper | Renders | Use for |
|---|---|---|
| `num(n)` | `1,234.56` (en-US grouping, ≤2 dp) | index levels, India prices |
| `usd(n)` | `$1,234.56`; `$0.123` for sub-$1 (`toPrecision(3)`) | USD crypto/stock prices |
| `money(n, "USD"\|"INR")` | currency-aware — `en-IN` gives ₹ + lakh/crore grouping | watchlist (reads `payload.currency`) |
| `compact(n)` | `1.2B` / `34.5M` | market caps, volumes |
| `pct(n)` | `+1.23%` / `-0.45%` (signed) | every % change chip |
| `signed(n)` | `+12.34` / `-5.00` | absolute day change |

Use `tabular-nums` on any column of changing numbers (prices, levels) so digits don't jitter on
refresh — the cards already do (`IndexCard`, `WatchlistAside`). For India, switch the price formatter
to `num`/`money(…, "INR")` off the payload's `currency` field, **not** a hardcoded `$` (the watchlist
already does `money(q.price, data?.currency)`; `EquitySectorsAside` branches `market === "in" ? num :
usd`). Sectors in India are **index points, not ETF dollars** — don't prefix them with a currency
symbol at all.

---

## 8. Common tasks → where

| Task | Do |
|---|---|
| Add a sparkline to a new card | Pass a `number[]` to `<Sparkline>`. Source it from Yahoo's close array or CoinGecko's `sparkline` — **never** a per-symbol TD `time_series`. |
| Add a "standout" single-asset OHLC chart | Lightweight Charts (Apache-2.0), fed our Yahoo OHLC; one symbol, financial-native axis/crosshair. |
| Make the heatmap branded / styled | That's the Tier-2 d3-hierarchy treemap — and it needs FMP display + GICS licenses first. §4 cheat sheet + `caching-and-rate-budgets.md`. |
| Heatmap shows the wrong market after switching | Confirm the iframe `key` changes with `market` (the remount trick). |
| Card colored wrong (red when up) | Bug is upstream: day-change uses `closes[len-2]`, not `chartPreviousClose`. §3. |
| "Make it feel live" | Use the WebSocket merge (`use-live-prices.ts`), not a faster `refetchInterval`. §6. |
| New card flickers/spins forever | Wire the `needsKey` → key panel and `isLoading||isError` → `PanelState` branches like every existing `Section`. |
| Show a stale indicator | Render `payload.stale` (and `timeAgo(updatedAt)`); don't recompute from `Date.now()`. §5. |
| New poll interval | Set `refetchInterval` ≥ the route's backend TTL (`routes.ts`); never below it. §6. |
