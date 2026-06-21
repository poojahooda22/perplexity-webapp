# Candlestick & OHLC — the bar, where it comes from, and how not to lie with it

> The structure of a price bar (Open/High/Low/Close + volume), candlestick anatomy and the
> handful of patterns worth recognizing, how timeframes/intervals compose, where bars are
> **sourced on this stack** (Yahoo's `v8/finance/chart` `interval`/`range` params, used by
> `fetchYahooQuote` in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)),
> and the gaps/sessions reality that breaks naïve charting. Read this before building a candle
> chart, computing a daily change, or wiring an interval picker. Adjacent: **`technical-indicators.md`**
> computes SMA/RSI/MACD over the close array this doc explains; **`charting-libraries-deep.md`**
> renders these bars (Lightweight Charts wants exactly this shape); the DATA plumbing (cache,
> budget, provider limits) is owned by **finance-markets** (`market-data-providers.md`). This is a
> generic-domain doc: the mechanics are universal; our files appear only to show the live mapping.

---

## 1. What an OHLC bar is

A **bar** aggregates every trade inside one time interval into four prices plus volume:

| Field | Meaning | Notes |
|-------|---------|-------|
| **Open** | First trade price of the interval | At session start = the opening auction print, not yesterday's close. |
| **High** | Max trade price in the interval | |
| **Low** | Min trade price in the interval | |
| **Close** | Last trade price of the interval | The **most important** number — indicators are computed over the close array. |
| **Volume** | Shares/contracts traded in the interval | Often a separate sub-pane; confirms or refutes a price move. |

Invariants that must always hold (assert them when ingesting third-party data):

```
Low ≤ Open ≤ High     Low ≤ Close ≤ High     Low ≤ High     Volume ≥ 0
```

A bar where `High < Low` or `Close > High` is corrupt data — drop it, don't plot it. Bars are
**indexed by the open time of the interval** (a 1d bar dated 2026-06-19 covers all of that
trading day). Off-by-one here is the classic chart bug: labeling a bar with its *close* time
shifts every candle one slot.

**On this stack** we mostly carry the **close array only** — Yahoo's chart response gives
`result.indicators.quote[0].{open,high,low,close,volume}` (parallel arrays aligned to
`result.timestamp`), but `fetchYahooQuote` reads just `close` for the sparkline + daily-change
math. To draw real candles you read all four arrays; see §6.

---

## 2. Candlestick anatomy

A candlestick encodes the same OHLC visually:

```
        ┃   ← upper wick (shadow): High
      ┏━┻━┓
      ┃   ┃  ← real body: Open↔Close
      ┃   ┃     up bar   → Close > Open (hollow / green)
      ┗━┳━┛     down bar → Close < Open (filled / red)
        ┃   ← lower wick (shadow): Low
```

| Part | Is | Reads as |
|------|-----|----------|
| **Real body** | distance Open↔Close | conviction of the session; long body = decisive |
| **Color/fill** | sign of Close−Open | up vs down; **not** vs the prior close (a green bar can still gap down) |
| **Upper wick** | High − max(O,C) | rejected higher prices (sellers stepped in) |
| **Lower wick** | min(O,C) − Low | rejected lower prices (buyers stepped in) |
| **Range** | High − Low | total volatility of the bar (basis for ATR / true range) |

The **wick-to-body ratio** carries most of the signal: a tiny body with long wicks = indecision;
a long body with no wicks = one side dominated start to finish.

---

## 3. Common patterns (recognize, never act on)

Patterns are **prior context** for a neutral description, not signals to trade. In Lumina they
appear only in informational prose, always ending on the not-advice disclaimer (Non-Negotiable #1
in [`SKILL.md`](../SKILL.md)). Single- and two-bar patterns are the only ones worth coding
detection for — multi-bar patterns are subjective and noisy.

| Pattern | Bars | Shape rule (approx) | Conventionally noted as |
|---------|------|---------------------|--------------------------|
| **Doji** | 1 | `|Close−Open| ≤ ε·(High−Low)` (tiny body) | indecision; needs context |
| **Hammer** | 1 | small body up top, lower wick ≥ 2× body, little upper wick | rejection of lows |
| **Shooting star** | 1 | small body at bottom, upper wick ≥ 2× body | rejection of highs |
| **Marubozu** | 1 | body ≈ full range, ~no wicks | one-sided session |
| **Bullish engulfing** | 2 | down bar then up bar whose body covers the prior body | momentum flip up |
| **Bearish engulfing** | 2 | up bar then down bar engulfing it | momentum flip down |
| **Morning/Evening star** | 3 | big bar → small-body gap → big opposite bar | reversal (subjective) |

Detection-rule cautions (the off-by-one and threshold traps):
- "Engulfing" compares **bodies**, not full ranges — `max(O,C)` and `min(O,C)`, not High/Low.
- Define `ε` for a doji relative to **that bar's range** or recent ATR, never an absolute price
  delta (a $1 body is a doji on BRK.A, a marubozu on a penny stock).
- A "gap" inside star patterns barely exists in 24/7 crypto and is rare intraday in liquid
  equities — see §5.

> Do not name a pattern and then imply an outcome ("hammer → it'll bounce"). Describe what the bar
> shows (where price was rejected) and stop. **Pattern ≠ prediction.**

---

## 4. Timeframes & intervals

The **interval** is the duration of one bar; the **range/lookback** is how many bars you fetch.
They are independent axes and the source caps both (Yahoo won't give 1-minute bars for a 5-year
range).

| Interval | Typical use | Bars per US equity day (RTH) |
|----------|-------------|------------------------------|
| 1m / 5m | intraday scalping view, today's shape | 390 / 78 |
| 15m / 1h | intraday swing, multi-day | 26 / ~7 |
| **1d** | the default for cards/sparklines here | 1 |
| 1wk / 1mo | long-horizon trend | — |

**Aggregation rule** — a higher-timeframe bar is built from its constituent lower bars:

```
HTF.open  = first lower-bar open
HTF.high  = max of lower-bar highs
HTF.low   = min of lower-bar lows
HTF.close = last lower-bar close
HTF.vol   = sum of lower-bar volumes
```

Resample server-side from the densest interval you legitimately hold; don't ask the user's
browser to roll up thousands of 1m bars. Indicator periods are **in bars, not wall-clock**: a
"20-period MA" is 20 days on a 1d chart and 20 minutes on a 1m chart — match the period to the
chart's interval, never assume days (see `technical-indicators.md`).

---

## 5. Gaps & sessions (where naïve charts break)

A **gap** is when a bar opens away from the prior bar's close — overnight news, earnings,
dividends. It is real, not a glitch. But two session realities trip up every first chart:

| Reality | Consequence | Handle it by |
|---------|-------------|--------------|
| **Markets close** (US equities ~09:30–16:00 ET, Mon–Fri; holidays) | Time axis has holes nights/weekends. Plotting on a *continuous* time axis draws long flat gaps. | Use a **category/business-time axis** that omits non-session slots (Lightweight Charts does this by default — feed bars, not timestamps-on-a-clock). |
| **Pre/post-market** | Yahoo's `regularMarketPrice` is RTH; extended-hours prints differ. | Decide RTH-only vs include extended; label which. Don't mix silently. |
| **Crypto is 24/7** | No gaps, no sessions, no opening auction. | A continuous axis is correct *for crypto*; the equity gap-omission logic would create false bars. Branch by asset class. |
| **Holidays / half-days** | A "daily change vs yesterday" assumes yesterday traded. | Derive "previous" from the **actual prior bar in the series**, not calendar arithmetic. |
| **Splits / dividends** | Raw prices jump; adjusted prices don't. | Decide raw vs adjusted-close and be consistent across the whole series (mixing them fabricates gaps). |

**The daily-change trap (live in our code).** The previous close for a *daily* change is
**yesterday's close = the second-to-last bar in the series**, not the range's first close.
`fetchYahooQuote` gets this right:

```ts
// backend/finance/sources.ts — fetchYahooQuote, interval=1d&range=1mo
const closes: number[] = (result?.indicators?.quote?.[0]?.close ?? [])
  .filter((n: unknown): n is number => typeof n === "number");
// yesterday = second-to-last close (today is the last). NOT meta.chartPreviousClose,
// which is the close before the ENTIRE 1mo range → that gives the monthly move.
const prev = closes.length >= 2 ? closes[closes.length - 2]! : (meta.chartPreviousClose ?? null);
change       = prev != null ? price - prev : null;
changePercent = prev ? ((price - prev) / prev) * 100 : null;
```

Using `meta.chartPreviousClose` here would silently report the **monthly** move as the daily
change — a wrong number that *looks* plausible. This is the OHLC equivalent of the worst trading
failure: a confidently displayed false statistic.

---

## 6. Where bars come from on this stack

Bars come through the finance DATA layer — **never fabricated, never from model "knowledge"**
(Non-Negotiable #2). The keyless, credit-free path is Yahoo's chart API.

**Yahoo chart endpoint** (`fetchYahooQuote` / `fetchIndices` / `fetchSectors` in
[`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)):

```
GET https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?interval=1d&range=1mo
Header: User-Agent: Mozilla/5.0          ← required, or Yahoo 4xx's
```

Response shape (what you parse):

```
chart.result[0].timestamp            → number[]  (epoch seconds, one per bar)
chart.result[0].indicators.quote[0]  → { open[], high[], low[], close[], volume[] }  (parallel arrays)
chart.result[0].indicators.adjclose[0].adjclose → number[]  (split/div-adjusted close)
chart.result[0].meta.regularMarketPrice          → the live/last RTH price
chart.result[0].meta.chartPreviousClose          → close BEFORE the range (NOT yesterday)
```

We currently read only `close` (for the sparkline) + `meta.regularMarketPrice`. To draw **real
candles**, zip the four parallel arrays with `timestamp`, filtering index-aligned nulls:

```ts
const r  = data.chart.result[0];
const q  = r.indicators.quote[0];
const ts = r.timestamp ?? [];
const bars = ts.map((t: number, i: number) => ({
  time:  t,                       // epoch seconds → Lightweight Charts UTCTimestamp
  open:  q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
})).filter((b: any) =>            // Yahoo emits nulls for halted/no-trade slots — drop them
  [b.open, b.high, b.low, b.close].every((n) => typeof n === "number"));
```

**`interval` / `range` selection matrix** (Yahoo caps the combination — fine intervals need short
ranges):

| Want | `interval` | `range` | Note |
|------|-----------|---------|------|
| Sparkline / 1-month line | `1d` | `1mo` | what we ship today |
| Daily candles, ~6 months | `1d` | `6mo` | indicator warmup needs the extra bars |
| Daily candles, max history | `1d` | `5y` / `max` | adjusted close matters over this span |
| Intraday today | `5m` | `1d` | Yahoo rejects `1m` over long ranges |
| Intraday week | `15m` / `1h` | `5d` | |
| Weekly long-horizon | `1wk` | `5y` | |

`range` accepts `1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max`; `interval` accepts
`1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk,1mo,3mo` (1m capped to ~7 days, intraday to ~60 days).

**Why Yahoo, not Twelve Data, for series:** TD's `time_series` charges **1 credit per call** and
the free cap is 8 credits/min — a couple of charts exhausts it (Non-Negotiable #3). Yahoo's chart
arrays are keyless and uncharged. TD is reserved for *single-quote* watchlist refreshes
(`fetchStocks`/`fetchQuotes`). For India, indices/stocks/sectors all ride the same keyless Yahoo
path (`.NS`/`.BO`, `^NSEI`…) — TD's free tier excludes NSE/BSE; see **finance-markets**
`us-india-markets.md`.

**Licensing carries with the bar:** every series returns a `Provenance` with `commercialOk:false`
(Yahoo/TD free tiers are not display licenses) and an `attribution` string. State the as-of time
and `stale` flag; never relabel a delayed series as live (SKILL.md Non-Negotiable #6).

---

## 7. The forming bar (real-time) vs closed bars

The newest bar is **still forming** until its interval ends — its Close (and possibly High/Low)
keeps moving. This is the single biggest live-chart correctness issue:

- **Closed bars are immutable.** Once a 1d bar's day ends, never rewrite it. Recomputing it on
  each tick is **repainting** — a bug that misleads (SKILL.md anti-patterns, and
  `technical-indicators.md`).
- **Only the current bar updates** as ticks arrive. Lightweight Charts'
  `series.update(latestBar)` mutates the last bar in place — feed live ticks there; use `setData`
  only for the historical backfill.
- On this stack, live ticks come from the `worker/` Finnhub WebSocket → Supabase Realtime →
  `use-live-prices`, which merges the latest *price* into the quote cache (it does not roll a full
  OHLC bar). Owned by **finance-markets** `realtime-prices-websocket.md`.

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Emitting an OHLC bar from model knowledge / "around $X". | Fetch real bars through `sources.ts` (Yahoo chart arrays); if unavailable/stale, say so. Never fabricate a bar. |
| Daily change = `price − meta.chartPreviousClose` on a `1mo` range. | `price − closes[len−2]` (yesterday's close). `chartPreviousClose` is the pre-*range* close = the monthly move. |
| Pulling a candle series from Twelve Data `time_series`. | Yahoo `indicators.quote[0]` arrays (keyless, credit-free). TD `time_series` = 1 credit each, blows the 8/min cap. |
| Plotting bars on a continuous wall-clock axis (long flat nights/weekends for equities). | Business-time/category axis that omits non-session slots; keep continuous *only* for 24/7 crypto. |
| Coloring a candle red because Close < prior close. | Color by **Close vs that bar's own Open**. Up/down is intra-bar; a green bar can still gap down vs yesterday. |
| Repainting the last bar on every tick (and its indicators). | Lock closed bars; only the forming bar updates (`series.update`); state which bars are final. |
| Labeling a bar by its close time. | Index by the interval's **open** time; off-by-one shifts the whole chart. |
| Detecting "engulfing" via High/Low. | Compare **bodies** (`max(O,C)`/`min(O,C)`); engulfing is a body relationship. |
| Absolute price threshold for a doji body. | Threshold relative to that bar's range or ATR (scale-invariant). |
| Asking the browser to roll up thousands of 1m bars to weekly. | Resample server-side from the densest held interval; ship the user only what renders. |
| Naming a pattern and implying an outcome. | Neutral description (where price was rejected) + "Not financial advice." Pattern ≠ prediction. |
| Mixing raw and adjusted closes in one series. | Pick raw OR adjusted for the whole series; mixing fabricates split/dividend "gaps". |
| Treating a `null` in Yahoo's `quote[0]` arrays as a real 0. | Filter index-aligned nulls (halts/no-trade slots) before plotting; don't coerce to 0. |

---

## 9. Quick reference — done checklist for a candle/OHLC feature

1. **Sourced:** bars come from `sources.ts` (Yahoo chart arrays), not fabricated; TD reserved for
   single quotes, not series.
2. **Correct invariants:** `Low ≤ {O,C} ≤ High` asserted; nulls filtered; bars indexed by open time.
3. **Correct change math:** daily change uses yesterday's close (second-to-last bar), not
   `chartPreviousClose`.
4. **Sessions handled:** business-time axis for equities, continuous for crypto; RTH-vs-extended
   labeled; raw/adjusted consistent.
5. **Live honesty:** forming bar updates, closed bars immutable (no repaint); as-of time + `stale`
   shown; delayed/`commercialOk:false` never labeled live.
6. **Interval/range valid:** within Yahoo's caps; indicator periods match the chosen interval.
7. **Safe:** any pattern mention is neutral + ends on "Not financial advice."
