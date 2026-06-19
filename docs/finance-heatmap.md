# S&P 500 Heatmap — Implementation Guide

_How the Finance tab's sector heatmap is built (Tier-1), what changed, and how it all connects._

---

## TL;DR — the one thing to understand first

**This heatmap has ZERO backend code.** No route, no API key, no database, no cache, no
data fetching on our side. It is a single **frontend-only embed** of TradingView's free
**Stock Heatmap widget**. We changed exactly **one file** to add it:

- [`frontend/src/components/finance/finance-view.tsx`](../frontend/src/components/finance/finance-view.tsx)

That is the entire feature. The rest of this doc explains _why_ it's built that way, the exact
changes, how the data flows, and what the future "custom" version (Tier-2) would add.

---

## Why no backend? (the licensing reason)

The treemap you see on Perplexity needs ~500 stocks, each with a **GICS sector** (grouping),
a **market cap** (rectangle size), and a **daily % change** (color). If _we_ sourced that data
ourselves and displayed it publicly, two legal walls appear:

1. **Exchange display fees.** Showing real-time US equity quotes to the public triggers
   **per-user fees** from the exchanges (NYSE ~$16–78 / user / month, NASDAQ tiered). That scales
   with your audience and is a six-figure problem at launch.
2. **GICS is proprietary.** The sector classification itself is owned by S&P Dow Jones Indices +
   MSCI; redistributing it publicly needs a license.

TradingView's free widget sidesteps **both**: the data is displayed _by TradingView, under
TradingView's own market-data license_, inside their iframe. We display none of our own series,
so none of those obligations land on us. That makes it the correct **Tier-1** ("ship now, free,
legal") choice. The trade-off is loss of control (TradingView branding, no shadcn styling, no
click/hover analytics) — addressed by the **Tier-2** custom build described at the end.

> This decision and the full research (data sources, render libraries, licensing) is recorded in
> the project memory `heatmap-implementation-kb`.

---

## How the data actually flows

There is **no request from our backend** in this picture. The browser talks straight to
TradingView:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser — our React app (localhost:3000 / perplexity-frontend…app)    │
│                                                                       │
│   <FinanceView>  ...  <Sp500Heatmap>                                  │
│      │                                                                │
│      └── renders an <iframe srcDoc="…">   ← OUR sandbox iframe        │
│             │                                                         │
│             │  (inside that iframe's HTML document:)                  │
│             └── <script src="…tradingview.com/embed-widget-…js">      │
│                    │                                                   │
│                    └── TradingView's script creates ITS OWN iframe ───┼──► TradingView
│                          (the actual heatmap UI + live data)          │     data servers
└─────────────────────────────────────────────────────────────────────┘
        ▲                                                                     (CBOE BZX
        │  our Express backend (Vercel) is NOT involved at all                 real-time +
        └─────────────────  no /finance/heatmap, no key, no cache  ────────── 15-min delayed)
```

- **Our backend** ([`backend/`](../backend/)) serves the _other_ finance panels (Top Assets,
  Market Summary, Discover, etc.) — but it never touches the heatmap.
- **The heatmap data** (prices, % change, market caps, sector grouping) is fetched _inside_
  TradingView's iframe, from TradingView's servers. Free tier = CBOE BZX real-time for liquid
  names + 15-min delayed for the rest; it refreshes about once a minute.

---

## The exact change — one component

All of the following lives in
[`frontend/src/components/finance/finance-view.tsx`](../frontend/src/components/finance/finance-view.tsx).

### 1. The component — `Sp500Heatmap` (around line 198)

```tsx
function Sp500Heatmap() {
  // The widget's configuration — these keys map 1:1 to the TradingView widget.
  const config = JSON.stringify({
    dataSource: "SPX500",            // which index → the S&P 500
    blockSize: "market_cap_basic",   // rectangle SIZE = market cap
    blockColor: "change",            // rectangle COLOR = daily % change (red→green)
    grouping: "sector",              // group cells by GICS sector, with header labels
    locale: "en",
    symbolUrl: "",
    colorTheme: "dark",              // match our dark UI
    exchanges: [],
    hasTopBar: false,                // hide TradingView's metric-switcher toolbar
    isDataSetEnabled: false,
    isZoomEnabled: true,             // allow zoom/expand inside the widget
    hasSymbolTooltip: true,          // hover a cell → tooltip
    isMonoSize: false,
    width: "100%",
    height: "100%",
  });

  // A self-contained HTML document we feed to the iframe via srcDoc. It contains the
  // standard TradingView embed snippet: a container, the required attribution link,
  // and the embed <script> whose text content is the JSON config above.
  const srcDoc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<style>html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}</style></head>" +
    '<body><div class="tradingview-widget-container" style="height:100%;width:100%">' +
    '<div class="tradingview-widget-container__widget" style="height:calc(100% - 24px);width:100%"></div>' +
    '<div class="tradingview-widget-copyright" …>' +
    '<a href="https://www.tradingview.com/" …>Track all markets on TradingView</a></div>' +
    '<script … src="https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js" async>' +
    config +
    "</scr" + "ipt></div></body></html>";

  return (
    <Section title="S&P 500 Heatmap" attribution="Live · via TradingView">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <iframe
          title="S&P 500 Heatmap"
          srcDoc={srcDoc}
          loading="lazy"
          className="h-[440px] w-full border-0 sm:h-[540px]"
        />
      </div>
    </Section>
  );
}
```

**Why an `<iframe srcDoc>` and not just injecting the script directly into the page?**
TradingView's embed script runs **cross-origin**. When a cross-origin script throws, the browser
hides the details and reports a generic `"Script error."`. Our dev runtime (Bun) hooks the page's
global `window.onerror` and escalated that into a **fatal Runtime Error overlay** — which is the
red error you saw. By nesting the widget inside **our own iframe** (`srcDoc`), the embed script
runs in _that iframe's_ window, so its error is confined there and never reaches our app's error
handler. The widget still renders perfectly (it just creates its own nested iframe for the UI).

**`"</scr" + "ipt>"`** is split on purpose — a literal `</script>` inside a bundled string can
confuse HTML/JS parsers; splitting it avoids that classic gotcha.

### 2. It renders inside the "US Markets" sub-tab (around line 1001)

```tsx
{tab === "US Markets" && (
  <>
    <TopAssets />
    <MarketSummary />
    <Sp500Heatmap />     {/* ← the heatmap, between Market Summary and Discover */}
    <DiscoverCarousel />
  </>
)}
```

This matches the Perplexity layout order: top assets → market summary → heatmap → discover news.

### 3. (Cleanup) the React import

An earlier draft used `useEffect`/`useRef` to inject the script imperatively; the `srcDoc` rewrite
made those unnecessary, so the import is back to just:

```tsx
import { useState } from "react";
```

### `<Section>` wrapper

`Sp500Heatmap` reuses the existing `Section` helper (same file) that every finance panel uses — it
renders the title (`"S&P 500 Heatmap"`) and a small right-aligned attribution (`"Live · via
TradingView"`). The `"Track all markets on TradingView"` link inside the widget is **required by
TradingView's Terms of Service and must not be removed.**

---

## What is NOT involved (and why that's the point)

For this heatmap, none of the following — which power the _other_ finance features — are touched:

| Backend piece (used by other panels) | Heatmap? |
|---|---|
| [`backend/finance/routes.ts`](../backend/finance/routes.ts) (`/finance/*` routes) | ❌ no `/finance/heatmap` route |
| [`backend/finance/sources.ts`](../backend/finance/sources.ts) (Yahoo / Twelve Data / CoinGecko) | ❌ |
| [`backend/lib/cache.ts`](../backend/lib/cache.ts) (`getOrRefresh` Upstash cache) | ❌ |
| [`backend/lib/ratelimit.ts`](../backend/lib/ratelimit.ts) | ❌ |
| Env vars / API keys (`FINHUB_API_KEY`, `TWELVE_DATA_API_KEY`, …) | ❌ none needed |
| `BUN_PUBLIC_BACKEND_URL` (frontend → backend URL) | ❌ heatmap ignores it |

Because the widget is self-contained, **it renders even when the backend is down or the
`BUN_PUBLIC_BACKEND_URL` is misconfigured** — unlike Top Assets / Market Summary / Discover, which
fetch from our backend via [`frontend/src/lib/finance-api.ts`](../frontend/src/lib/finance-api.ts)
and the `use-finance.ts` hooks.

---

## Limitations of the Tier-1 widget

- **TradingView branding** is visible and cannot be removed (ToS).
- **No styling control** beyond the documented config — it won't perfectly match our shadcn/Tailwind
  tokens, fonts, or a custom ±3% color clamp.
- **Opaque iframe** — we can't capture hover/click/sector events for analytics or ranking, and can't
  cross-link a cell to our own ticker pages or feed it into our AI summaries.
- **Mixed freshness** — real-time only for liquid (CBOE BZX) names; others are 15-min delayed.

---

## Tier-2 upgrade path (the custom, branded version — NOT built yet)

When branded styling + data ownership + analytics matter, we'd replace the widget with our own
treemap. _This_ version would use the backend heavily:

1. **New backend route** `GET /finance/heatmap` in
   [`backend/finance/routes.ts`](../backend/finance/routes.ts), wrapped in `getOrRefresh`
   (Upstash cache) and warmed by the existing `cron-job.org → /finance/cron/refresh` job.
2. **Data join** in `sources.ts`: constituents + GICS sector + market cap from the **iShares IVV
   daily holdings CSV** (one file, no key) + daily % change from a **bulk** quote source
   (Polygon "Grouped Daily" or FMP batch-quote — never per-symbol, which would blow rate limits).
   Tagged `commercialOk: false` and served **15-min delayed** to avoid exchange fees until a paid
   display license is signed.
3. **One cached JSON document**: `{ items: [{ sector, ticker, name, marketCap, changePct }], … }`.
4. **Frontend render** with `d3-hierarchy` (squarified treemap, sector header bands), our own
   diverging red→green color scale (±3% clamp + a colorblind-safe toggle), shadcn tooltip, and a
   mobile fallback (sector accordion list, not a shrunk treemap). New `fetchHeatmap()` +
   `useHeatmap()` mirroring the existing finance hooks.

Full details (sources, libraries, the data shape, R-SCALE notes) live in the `heatmap-implementation-kb`
project memory.

---

## File reference

| File | Role for the heatmap |
|---|---|
| [`frontend/src/components/finance/finance-view.tsx`](../frontend/src/components/finance/finance-view.tsx) | **The entire feature**: `Sp500Heatmap` component (~line 198) + render in the US Markets tab (~line 1001) |
| `docs/finance-heatmap.md` | This document |

_Commits: `feat(finance): add S&P 500 sector heatmap` (37a8037) → `fix(finance): sandbox TradingView heatmap in an iframe srcDoc` (79e2c88)._
