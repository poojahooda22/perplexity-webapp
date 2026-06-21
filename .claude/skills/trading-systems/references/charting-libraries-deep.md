# Charting Libraries, Deep — Lightweight Charts vs TradingView widget vs custom D3/visx

> Generic-domain reference for choosing and wiring a price-chart engine for a trading UI: when to
> hand-roll SVG, when to ship TradingView Lightweight Charts (Apache-2.0, *our* data), when to embed
> the TradingView Advanced/widget (licensed embed, delayed data, *their* license), and when to drop to
> custom D3/visx. Covers the decision framework, performance with thousands of points, and SSR/lazy
> mounting. Read this when a task says "add a candlestick chart", "the sparkline is slow", "render OHLC
> with indicators", or "embed a TradingView chart". **Adjacent refs:** `candlestick-and-ohlc.md` (where
> the bars come from + their shape), `technical-indicators.md` (computing the overlay series this doc
> plots); for the finance-card render mechanics + the S&P heatmap decision, cross-ref finance
> `charting-and-visualization.md`. The market-DATA plumbing under all of these belongs to
> **finance-markets**.

This is GENERIC knowledge; Lumina files appear only to illustrate. The one chart engine actually in the
repo today is a hand-rolled SVG `Sparkline` and an embedded TradingView heatmap — see
[`frontend/src/components/finance/finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx).

---

## 1. The four tiers (what each one IS)

| Tier | Engine | Data origin | License | Use it for |
|---|---|---|---|---|
| 0 | **Hand-rolled SVG** (`<path>`) | Ours (close array) | none | Sparklines, tiny trend lines, no axes/crosshair. Already shipped. |
| 1 | **TradingView Lightweight Charts** (npm `lightweight-charts`) | **Ours** (we feed every bar) | **Apache-2.0** (FOSS) | Real candle/area/line/histogram charts with axes, crosshair, time scale, indicator overlays — drawn over data WE source + license. |
| 2 | **TradingView Advanced / embeddable widget** (`<script>`/iframe) | **TradingView's** (they fetch it) | Licensed embed; **delayed**; attribution mandatory | A full pro chart for free, *because the exchange-display license is their burden*. You cannot touch the data. |
| 3 | **Custom D3 / visx** | Ours | none (libs are MIT/BSD) | Bespoke visuals no off-the-shelf engine does: sector treemaps, correlation matrices, custom-styled candles, animated transitions. Most expensive to build + maintain. |

The single most consequential axis is **whose data and whose license**:

```
Need a price chart
|
+-- Trivial trend, no axes/crosshair? ............... Tier 0  hand-rolled SVG (already in repo)
|
+-- Real interactive chart, OUR data, must be ours? . Tier 1  Lightweight Charts (Apache-2.0)
|     (we already pay/clear the data via sources.ts; we want full control + theming)
|
+-- Want a pro chart for free + avoid exchange
|   display fees + OK with delayed + their brand? ... Tier 2  TradingView widget (licensed embed)
|
+-- A visual no charting lib does (treemap, custom)?  Tier 3  D3 / visx (build it)
```

---

## 2. Decision framework — pick by the constraint that actually binds

Walk these in order; the first "yes" decides it.

| Question | If yes → |
|---|---|
| Is it just a trend glyph (≤200 pts, no axes, no interaction)? | **Tier 0** SVG. Don't pull a library for a sparkline. |
| Must the chart show data **we** sourced (so indicators/overlays we compute line up, and we control theme/branding/interaction)? | **Tier 1** Lightweight Charts. |
| Do we want a full chart **without** paying per-user exchange-display fees, and is **delayed** data + TradingView branding acceptable? | **Tier 2** widget. The display license rides with TradingView, not us. |
| Is the visual something no chart engine ships (treemap, heat-grid, radial)? | **Tier 3** D3/visx — or a Tier-2 widget if TradingView already has it (e.g. the heatmap). |
| Are we early/demo and just need *something* on screen fast? | **Tier 2** widget (zero data wiring) or **Tier 0** SVG. |

**The licensing fork is the whole game.** A custom Tier-1/Tier-3 candle chart of, say, 500 US equities
means *we* are displaying exchange data — which triggers NASDAQ/NYSE/NSE per-user display fees and
needs a `commercialOk` clearance (see finance `data-licensing-and-compliance.md`). The Tier-2 widget
sidesteps that entirely because TradingView holds the license — which is *exactly* why the repo's
S&P/Nifty heatmap is a TradingView embed, not a custom d3 treemap. The code says so verbatim:

```ts
// Sp500Heatmap() in finance-view.tsx
// Why: it ships the exact … look … AND the market-data display license is TradingView's
// burden — so showing ~500 US equity quotes here does NOT trigger the per-user
// NASDAQ/NYSE exchange-display fees a custom build would. … Branded d3-hierarchy
// treemap is the planned Tier-2.
```

So the decision already made in this repo: **Tier-0 SVG for sparklines, Tier-2 widget for the
heatmap, Tier-1 Lightweight Charts is the path when a real candle chart is needed over our own bars.**

---

## 3. Tier 0 — the hand-rolled SVG sparkline (what's already shipped)

The repo's `Sparkline` is a single normalized `<path>` — no library, no axes, ~25 lines. This is the
correct floor: for a thumbnail trend it beats every library on bundle size and render cost.

```tsx
// finance-view.tsx — the entire sparkline engine
function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return <div className="h-10 w-full" />;     // guard: need ≥2 pts
  const w = 120, h = 40;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;                                        // avoid /0 on a flat line
  const d = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / span) * h;                            // invert: SVG y grows down
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" strokeWidth={1.75}
        className={up ? "stroke-emerald-500" : "stroke-rose-500"}
        vectorEffect="non-scaling-stroke" />     {/* keeps stroke 1.75px despite non-uniform scale */}
    </svg>
  );
}
```

Where the `points` come from: Yahoo's `indicators.quote[0].close` array (keyless, credit-free) —
NEVER Twelve Data `time_series` (1 credit each). See `candlestick-and-ohlc.md` + Non-Negotiable #3 in
the SKILL.

**Stay at Tier 0 until you need an axis, a crosshair, a tooltip, or candles.** The moment you do,
jump to Tier 1 — do not grow the SVG into a half-baked chart library.

---

## 4. Tier 1 — TradingView Lightweight Charts (the real-chart default)

`lightweight-charts` (Apache-2.0, ~45 KB gzip, canvas-rendered) is the right engine when you want a
genuine interactive chart over **our** bars: candlesticks, line/area, volume histogram, plus
overlay/indicator series (SMA/EMA/Bollinger as extra line series; RSI/MACD in a separate pane).

**Core shape** (v4 `addCandlestickSeries`; v5 renamed to `addSeries(CandlestickSeries, …)` — check the
installed version):

```tsx
import { createChart, ColorType } from "lightweight-charts";

function CandleChart({ bars }: { bars: OHLCBar[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#9ca3af" },
      autoSize: true,                         // resizes with container (else wire a ResizeObserver)
      timeScale: { timeVisible: true },
    });
    const candles = chart.addCandlestickSeries({
      upColor: "#10b981", downColor: "#f43f5e", borderVisible: false,
      wickUpColor: "#10b981", wickDownColor: "#f43f5e",
    });
    candles.setData(bars);                    // [{ time, open, high, low, close }, …] sorted ↑ by time
    // overlay an SMA-20 we computed ourselves (see technical-indicators.md):
    const sma = chart.addLineSeries({ color: "#60a5fa", lineWidth: 1 });
    sma.setData(sma20);                        // [{ time, value }] — null/skipped during warmup
    chart.timeScale().fitContent();
    return () => chart.remove();              // ALWAYS dispose on unmount (canvas + listeners leak otherwise)
  }, [bars]);
  return <div ref={ref} className="h-[440px] w-full" />;
}
```

**Non-negotiables for Tier 1:**
- **`time` must be ascending and unique** — UNIX seconds (number) or `'YYYY-MM-DD'`. Out-of-order or
  duplicate timestamps throw or silently corrupt the series.
- **Indicator overlays plot the series WE compute** over the close array — they warm up (leading bars
  omitted/`null`), and closed bars never repaint. (SKILL Non-Negotiables #5/#6; math in
  `technical-indicators.md`.)
- **Dispose on unmount** (`chart.remove()`); update via `series.update(lastBar)` for a live tick rather
  than re-`setData` the whole array.
- **It's our data → our license:** every series carries the `commercialOk`/`stale`/`fetchedAt` story.
  A Tier-1 chart of exchange data we haven't licensed for display is a compliance bug, not a UI win.

**Why not Chart.js / Recharts / ECharts for price charts?** They're general charting libs; candlestick,
crosshair-snapped OHLC tooltips, log-price scales, and a proper financial time axis (session gaps, no
weekend dead-space) are first-class in Lightweight Charts and bolt-ons everywhere else. Use Recharts
for a dashboard bar chart; use Lightweight Charts for a price chart.

---

## 5. Tier 2 — the TradingView embeddable / Advanced widget (licensed embed)

A `<script>`-injected widget (Advanced Chart, Symbol Overview, Heatmap, Screener…) that renders a full
TradingView chart of **their** data. You configure it with a JSON blob; you cannot read or transform a
single value.

**The contract:**

| Concern | Reality |
|---|---|
| Data | TradingView's feed, typically **delayed** (15-min) on the free embed. Never relabel it "live" or "ours". |
| License | Display license is TradingView's — that's the value. Frees you from exchange per-user display fees. |
| Attribution | The copyright/"Track all markets on TradingView" link is **mandatory** by ToS — keep it. |
| Control | None over data; limited theming via the config JSON (`colorTheme`, `locale`, sizing). |

**The repo's heatmap is the canonical Tier-2 wiring** — and it teaches two real gotchas:

```ts
// Sp500Heatmap() — config drives the widget
const config = JSON.stringify({
  dataSource: isIndia ? "NIFTY500" : "SPX500",
  blockSize: "market_cap_basic",   // cells sized by market cap
  blockColor: "change",            // colored by daily % change
  grouping: "sector",              // grouped by GICS sector
  colorTheme: "dark", width: "100%", height: "100%",
});
```

1. **Mount it via `<iframe srcDoc>`, not directly in the page.** TradingView's embed script runs
   cross-origin and emits a benign `"Script error."`. A bare mount lets your global `onerror` / dev
   overlay surface that as a FATAL runtime error. Nesting it inside your own iframe confines the error
   to that iframe's window — the widget still renders (it creates its own inner iframe). Verbatim from
   the code comment.
2. **`key` the iframe so a config change forces a full remount.** Mutating `srcDoc` on a live iframe
   does NOT reliably reload it once the embed script has run, so without a changing `key` the widget
   stays on the first config (e.g. stays on US after switching to India): `key={isIndia ? "heatmap-in" : "heatmap-us"}`.
3. **`loading="lazy"`** on the iframe defers the third-party script until it scrolls near the viewport.

**Use Tier 2 when:** you want a pro chart/heatmap for free, delayed data is fine, and you're happy to
show TradingView branding. **Avoid it when:** you need the data values themselves, real-time, custom
branding, or it must look like a first-party Lumina chart.

---

## 6. Tier 3 — custom D3 / visx (only when nothing else fits)

D3 (imperative, SVG/canvas) and visx (D3 scales/shapes as React primitives, MIT) are for visuals no
charting engine ships: a **sector treemap** (`d3-hierarchy` `treemap()`), correlation heat-grids,
radial gauges, bespoke candle styling with animated transitions. Cost: you own layout, axes,
interaction, accessibility, and performance yourself.

- **visx over raw D3 in a React app** — visx gives you `@visx/scale`, `@visx/shape`, `@visx/axis` as
  components, so React owns the DOM and you don't fight D3's `enter/update/exit` against the virtual
  DOM. Reserve raw D3 for the math (`d3-scale`, `d3-hierarchy`, `d3-shape` `line()`/`area()`) and let
  React render.
- The repo names the branded **d3-hierarchy treemap as the planned upgrade** from the Tier-2 heatmap —
  i.e. you only pay the Tier-3 cost once the Tier-2 embed's branding/data-control limits actually bite,
  AND once the exchange-display license question is answered.
- For tens of thousands of points, **render to canvas, not SVG** (one `<path>` per series is fine; tens
  of thousands of DOM nodes are not — see §7).

---

## 7. Performance with thousands of points

The failure mode is the **DOM-node count and per-frame work**, not the data size itself.

| Symptom | Cause | Fix |
|---|---|---|
| Sluggish/janky chart | One SVG element per point (×N series) | Canvas renderer (Lightweight Charts is canvas; D3→canvas for big N) or ONE `<path>` for the whole line. |
| Slow even with one path | Plotting 50k raw points onto 600 px | **Downsample** before render — LTTB (Largest-Triangle-Three-Buckets) keeps visual shape; or aggregate to the bar interval the viewport shows. |
| Re-render storm on live ticks | Re-`setData` the full array per tick | `series.update(lastBar)` mutates only the forming bar; closed bars are immutable (no repaint). |
| Frozen tab on initial load | Parsing/transform on the main thread | Memoize the transform; for very large sets, transform off the hot path / in chunks. |
| React re-mounts the chart each render | Chart created in render body / deps churn | Create once in `useEffect`; update via series API; stable deps; dispose on unmount. |

Rules of thumb: **Tier 0 SVG** ≈ fine to a few hundred points; **Lightweight Charts (canvas)** handles
tens of thousands smoothly; **SVG-based D3/visx** degrades past a few thousand DOM nodes → go canvas or
downsample. For sparklines, cap the input array upstream (you only have ~1 day of closes anyway).

```ts
// Cheap viewport downsample: never draw more points than pixels.
const step = Math.max(1, Math.ceil(points.length / chartWidthPx));
const drawn = points.filter((_, i) => i % step === 0);
// For shape-preserving downsample of OHLC/line series, use LTTB instead of stride sampling.
```

---

## 8. SSR / lazy-load / hydration

Lumina's frontend is Vite SPA (client-rendered), so true SSR hydration mismatch isn't the daily
concern it is in Next.js — but the *lazy-load* discipline still applies, and the gotchas transfer if a
chart ever lands in an SSR shell.

| Concern | Why | Do |
|---|---|---|
| Charting libs touch `window`/`document`/`canvas` at import | Crashes on a server render; bloats the initial bundle | **Lazy-import**: `const Chart = lazy(() => import("./CandleChart"))` behind `<Suspense>`; only loads when the chart route/tab mounts. |
| Third-party embed scripts (Tier 2) | Cross-origin, heavy, may error | `<iframe srcDoc loading="lazy">` (the repo pattern) — defers + sandboxes the script. |
| Hydration mismatch (if SSR) | Server can't render a canvas chart | Render a skeleton/placeholder on the server, mount the chart client-only (`useEffect` + a mounted flag, or a dynamic import with `ssr:false`). |
| Resize before layout | Chart sizes to 0 height pre-layout | Use `autoSize` (Lightweight Charts) or a `ResizeObserver`; give the container an explicit height class (`h-[440px]`) as the repo does. |
| Heavy chart on first paint | Hurts LCP/TTI | Code-split it out of the main bundle; the heatmap's `loading="lazy"` is the floor. |

**Lazy + suspense skeleton pattern** (mirrors the repo's `PanelState` loading style):

```tsx
const CandleChart = lazy(() => import("./CandleChart"));
// …
<Suspense fallback={<div className="flex h-[440px] items-center gap-2 …"><Loader2 className="animate-spin"/> Loading chart…</div>}>
  <CandleChart bars={bars} />
</Suspense>
```

---

## 9. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Growing the hand-rolled SVG into a fake chart lib (adding axes, crosshair, tooltips by hand). | At the first axis/crosshair/candle, adopt **Lightweight Charts**. Keep SVG for sparklines only. |
| Building a custom candle chart of exchange data with no display license. | Either license the data (`commercialOk`) for a Tier-1 chart, OR use the **Tier-2 widget** so the license is TradingView's. |
| Embedding the TradingView widget and calling its data "ours" / "real-time". | It's a **licensed, delayed** embed. Keep the mandatory attribution link; never relabel the data. |
| Mounting the TradingView script directly in the page. | `<iframe srcDoc>` to confine its cross-origin `"Script error."` from your global error overlay. |
| Mutating `srcDoc`/config on a live widget iframe and expecting a reload. | Change the iframe `key` to force a full remount (the US→India heatmap fix). |
| Plotting an indicator from bar 0 / re-`setData` per tick (repaint). | Warm up (leading `null`s) and `series.update(lastBar)` only; closed bars are immutable. |
| Pulling the chart series via Twelve Data `time_series`. | Yahoo `indicators.quote[0].close` (keyless, credit-free); TD `time_series` is 1 credit each. |
| Rendering 50k points as SVG nodes. | Canvas renderer or downsample (LTTB/stride) to ~the pixel width. |
| `import "lightweight-charts"` eagerly into the main bundle / an SSR path. | `lazy()` + `<Suspense>`; client-only mount; explicit container height. |
| Reaching for D3 first "for control". | D3/visx only when no chart engine does the visual (treemap, heat-grid). For price charts, Lightweight Charts wins on time-cost. |

---

## 10. Done / verification checklist

A charting change is done when:
1. **Right tier:** sparkline→SVG, real chart→Lightweight Charts, free-pro/heatmap→TV widget,
   bespoke-only→D3/visx — and you can name *why* in one sentence (usually the license fork).
2. **Data + license honest:** every plotted series is real bars sourced through the finance layer
   (not fabricated, not TD `time_series` for sparklines), carries `stale`/`fetchedAt`, and either has
   `commercialOk` clearance (Tier 1/3) or rides TradingView's license with attribution intact (Tier 2).
3. **Indicators correct:** overlays warm up (leading nulls), closed bars don't repaint, live updates go
   through `series.update`.
4. **Perf:** big series are canvas-rendered or downsampled; the chart is created once and disposed on
   unmount.
5. **Lazy:** the chart lib/embed is code-split (`lazy`/`<iframe loading="lazy">`), container has an
   explicit height, and the widget iframe is `srcDoc`-confined + `key`-remounted on config change.
6. **Verified:** the chart renders the expected series and animates the right values when the
   market/symbol switches; no `"Script error."` overlay; no canvas/listener leak across mounts.

---

## Cross-references

- `candlestick-and-ohlc.md` — the OHLC shape + **where bars come from** on this stack (Yahoo chart
  `interval`/`range`, the close array `fetchYahooQuote` reads). The data this doc plots.
- `technical-indicators.md` — computing the SMA/EMA/RSI/MACD/Bollinger overlay series rendered here
  (warmup, no repaint).
- finance `charting-and-visualization.md` — finance-card render mechanics, the S&P heatmap/treemap
  decision, freshness badges, TanStack cadence alignment. The DATA + licensing layer all four tiers
  stand on is **finance-markets** (`market-data-providers.md`, `data-licensing-and-compliance.md`).
- **lumina-frontend** — the generic UI shell / `Section` cards these charts live inside.
