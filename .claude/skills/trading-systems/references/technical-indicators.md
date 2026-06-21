# Technical Indicators — formulas, windowing, and the pitfalls

> Compute SMA/EMA, RSI, MACD, Bollinger Bands, VWAP, and volume overlays **from a real
> close/OHLC array** — the math, the default settings, the windowing rules, and the three failure
> modes that mark an amateur (repainting, warmup, off-by-one lookback). This is a **generic-domain**
> ref: the formulas are universal; the Lumina hooks are only there to show *where the input array
> comes from* on this stack. For *where bars are sourced* (Yahoo `interval`/`range`, the close array)
> read **`candlestick-and-ohlc.md`**; for *plotting* the indicator series read
> **`charting-libraries-deep.md`**; for the no-advice framing read **`trading-safety-and-disclaimers.md`**.

The input is always an array of numbers (or OHLCV rows). On this stack that array already exists:
`fetchYahooQuote` in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) returns
`sparkline: closes` read from `result.indicators.quote[0].close` (interval=1d, range=1mo — see the
`fetchYahooQuote` fn), and CoinGecko coins carry `sparkline: sparkline_in_7d.price` (see
`mapCoinGeckoRow`). **Compute every indicator over one of those real arrays — never let the model
emit an indicator value from "knowledge."** (Non-Negotiable #2 in the SKILL.)

---

## 0. Vocabulary (so the rest is unambiguous)

| Term | Meaning |
|------|---------|
| **Period / lookback / window (`N`)** | How many bars the indicator averages over. RSI-14 → N=14. |
| **Warmup** | The leading bars where the window isn't full yet → the indicator is **undefined**. Emit `null`, not 0. |
| **Closed bar** | A finished candle; its OHLC never changes again. Indicators on closed bars are **final**. |
| **Forming bar** | The current, still-updating candle. Its indicator value moves with every tick — the ONLY value allowed to change. |
| **Repainting** | An indicator value on a **closed** bar changing after the fact. Always a bug or a deceptive indicator. |
| **OHLCV** | Open, High, Low, Close, Volume — one row per bar. Most indicators use Close; VWAP and Bollinger-on-typical use H/L too; volume tools need V. |

---

## 1. Decision framework — which indicator answers which question

| You want to show… | Indicator | Inputs | Default settings |
|-------------------|-----------|--------|------------------|
| Trend direction, smoothed price | **SMA / EMA** | close[] | 20 / 50 / 200 (SMA); 12 / 26 (EMA) |
| Overbought / oversold momentum | **RSI** | close[] | 14, bands at 70 / 30 |
| Trend + momentum crossover | **MACD** | close[] | 12, 26, 9 |
| Volatility envelope around price | **Bollinger Bands** | close[] (or typical price) | 20, 2σ |
| Intraday fair-value benchmark | **VWAP** | H, L, C, V | session-anchored, intraday only |
| Conviction behind a move | **Volume** (+ avg) | volume[] | 20-bar avg overlay |

Rule of thumb: **trend → MA/MACD**, **momentum/exhaustion → RSI**, **volatility → Bollinger**,
**intraday execution context → VWAP**, **conviction → volume**. Don't stack five oscillators that all
say the same thing; pick the one that answers the user's actual question.

---

## 2. SMA & EMA (moving averages)

**SMA (Simple Moving Average)** — the arithmetic mean of the last `N` closes. Every bar weighted
equally; the value at bar `i` only exists once `i >= N-1`.

```
SMA[i] = (close[i-N+1] + … + close[i]) / N
```

**EMA (Exponential Moving Average)** — weights recent bars more, so it reacts faster and never fully
"forgets" old data. Multiplier `k = 2 / (N+1)`. **Seed** the first EMA value with the SMA of the
first `N` closes (the standard convention), then recurse:

```
k        = 2 / (N + 1)
EMA[N-1] = SMA of close[0..N-1]          // the seed
EMA[i]   = close[i] * k + EMA[i-1] * (1 - k)   // for i >= N
```

```ts
// SMA — leading nulls for warmup, then a trailing average.
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;   // slide the window
    out.push(i >= period - 1 ? sum / period : null); // null until window is full
  }
  return out;
}

// EMA — seed with the SMA of the first `period` values, then recurse.
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
```

| Choose | When |
|--------|------|
| **SMA** | Smooth, less twitchy; classic 50/200-day "golden/death cross" support-resistance reads. |
| **EMA** | You want faster reaction to recent price; feeds MACD (12/26 EMA). |

**Pitfall:** the seed matters. Seeding EMA from `close[0]` alone (a common shortcut) makes the first
~3N values diverge from any reference platform. Seed from the SMA and emit `null` for the warmup.

---

## 3. RSI (Relative Strength Index)

Momentum oscillator on `[0,100]`. Splits each bar's price change into gain vs loss, then compares
**average gain** to **average loss** over `N` bars (default 14).

```
change[i]  = close[i] - close[i-1]
gain[i]    = max(change, 0);   loss[i] = max(-change, 0)
avgGain    = Wilder-smoothed average of gain over N
avgLoss    = Wilder-smoothed average of loss over N
RS         = avgGain / avgLoss
RSI        = 100 - 100 / (1 + RS)
```

**Wilder smoothing** (the correct, standard variant) seeds the first average as a simple mean of the
first `N` gains/losses, then smooths:
`avg[i] = (avg[i-1] * (N-1) + current) / N`. Using a *simple* moving average of gains instead
(a frequent mistake) gives noticeably different, "wrong" RSI vs every charting platform.

```ts
export function rsi(close: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(close.length).fill(null);
  if (close.length <= period) return out;       // need N changes → N+1 closes
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {           // seed: simple mean of first N changes
    const d = close[i]! - close[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i]! - close[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;   // Wilder smoothing
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
```

- **Warmup:** first value is at index `period` (you need `N` *changes* = `N+1` closes). Indices
  `0..period-1` are `null`.
- **Bands:** >70 conventionally "overbought", <30 "oversold" — describe neutrally, never as a
  buy/sell trigger (Non-Negotiable #1, no advice).
- **Edge case:** `avgLoss == 0` → RS is infinite → RSI = 100. Guard the divide.

---

## 4. MACD (Moving Average Convergence Divergence)

Three series from two EMAs (defaults 12, 26, 9):

```
macdLine   = EMA12(close) - EMA26(close)
signalLine = EMA9(macdLine)         // EMA of the MACD line itself
histogram  = macdLine - signalLine
```

```ts
export function macd(close: number[], fast = 12, slow = 26, sig = 9) {
  const eFast = ema(close, fast);
  const eSlow = ema(close, slow);
  const macdLine = close.map((_, i) =>
    eFast[i] != null && eSlow[i] != null ? eFast[i]! - eSlow[i]! : null);
  // Signal EMA must run over ONLY the defined MACD values, then be re-aligned.
  const defined = macdLine.filter((v): v is number => v != null);
  const sigVals = ema(defined, sig);
  const offset = macdLine.findIndex((v) => v != null);
  const signal = macdLine.map((v, i) =>
    v != null && sigVals[i - offset] != null ? sigVals[i - offset]! : null);
  const hist = macdLine.map((v, i) =>
    v != null && signal[i] != null ? v! - signal[i]! : null);
  return { macdLine, signal, hist };
}
```

- **Warmup compounds:** the MACD line warms up at `slow-1` (26), and the signal EMA needs another
  `sig-1` (9) *defined* MACD values on top — so the histogram only starts around bar ~34. **You must
  run the signal EMA over the compacted (non-null) MACD values, then re-offset back**, or the signal
  is misaligned by the warmup gap. This re-alignment is the single most common MACD bug.
- **Reads:** line crossing signal = momentum shift; histogram = the gap (its sign-flip is the
  crossover). Zero-line crossings = the two EMAs crossing.

---

## 5. Bollinger Bands

A moving average with a volatility envelope. Default: 20-period SMA ± 2 **population** standard
deviations of the same 20 closes.

```
mid   = SMA(close, 20)
sd    = populationStdDev(close[i-19..i])   // divide by N, NOT N-1
upper = mid + 2*sd
lower = mid - 2*sd
%B    = (close - lower) / (upper - lower)   // where price sits in the band [0..1]
width = (upper - lower) / mid               // the "squeeze" metric
```

```ts
export function bollinger(close: number[], period = 20, mult = 2) {
  const mid = sma(close, period);
  const upper: (number | null)[] = [], lower: (number | null)[] = [];
  for (let i = 0; i < close.length; i++) {
    if (i < period - 1 || mid[i] == null) { upper.push(null); lower.push(null); continue; }
    const win = close.slice(i - period + 1, i + 1);
    const m = mid[i]!;
    const variance = win.reduce((a, c) => a + (c - m) ** 2, 0) / period; // population: /period
    const sd = Math.sqrt(variance);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  }
  return { mid, upper, lower };
}
```

- **Population vs sample SD:** Bollinger's definition divides by `N`, not `N-1`. Using the sample SD
  (the `N-1` your stats library defaults to) makes the bands slightly too wide vs every chart.
- **Reads:** narrowing bands = low volatility ("squeeze", often precedes a move); a close outside a
  band is a *volatility* event, not a signal. Describe; do not call a trade.

---

## 6. VWAP (Volume-Weighted Average Price)

The average price **weighted by volume**, accumulated from a session anchor. It is the benchmark
institutions measure fills against — "above VWAP" = buyers in control intraday.

```
typical[i] = (high[i] + low[i] + close[i]) / 3
VWAP[i]    = Σ(typical[k] * volume[k]) / Σ(volume[k])   for k from session start..i
```

```ts
// Anchored VWAP — reset cumulative sums at each session start. Needs OHLCV rows, not closes.
export function vwap(bars: { high: number; low: number; close: number; volume: number }[]) {
  let cumPV = 0, cumV = 0;
  return bars.map((b) => {
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * b.volume;
    cumV  += b.volume;
    return cumV > 0 ? cumPV / cumV : null;
  });
}
```

- **Intraday only, anchored.** VWAP is a *cumulative* statistic — it MUST reset at each session
  open. Running it across multiple days without re-anchoring is meaningless. Daily/weekly bars don't
  have a VWAP in the usual sense.
- **Needs OHLCV.** Yahoo's `indicators.quote[0]` carries `volume` alongside `close` at intraday
  intervals — but the keyless `fetchYahooQuote` here uses `interval=1d`, which has **no usable
  intraday volume profile for VWAP**. To ship VWAP you'd fetch an intraday `interval` (e.g. `5m`,
  `range=1d`) — route that data question to **`candlestick-and-ohlc.md`** + **finance-markets**.

---

## 7. Volume (overlay, not an oscillator)

Raw `volume[]` is plotted as bars, usually with a moving average to judge "above/below average".

```
avgVol = SMA(volume, 20)
relVol = volume[i] / avgVol[i]   // >1 = unusually active bar
```

Reads: a price move on **above-average** volume has conviction; a breakout on light volume is
suspect. On this stack volume comes from `indicators.quote[0].volume` at intraday intervals; the
daily keyless path does carry daily volume. Color bars up/down by `close >= open`.

---

## 8. Windowing — the universal pattern

Every rolling indicator is a sliding window. Two correct implementations:

| Style | How | Use when |
|-------|-----|----------|
| **Incremental** (running sum / Wilder / EMA recurrence) | Add the new bar, subtract the one leaving (SMA) or recurse (EMA/RSI). O(1) per bar. | Long series, streaming updates. The skeletons above use this. |
| **Slice-per-bar** | `values.slice(i-N+1, i+1)` then reduce. O(N) per bar. | Bollinger SD, small arrays, clarity over speed. |

**Off-by-one is the silent killer.** A length-`N` window ending at index `i` spans
`[i-N+1 .. i]` inclusive — that's `N` elements, and the first valid output is at `i = N-1`
(or `i = N` for RSI, which consumes one bar to make the first *change*). Write a unit test that
checks the index of the first non-null value equals the documented warmup, or you will be off by one
forever.

---

## 9. The three pitfalls (and the fix)

### A. Warmup — emit `null`, never `0`

An indicator has no value before its window fills. A 14-period RSI is undefined for the first 13
bars; a 20/2 Bollinger has no bands for 19 bars; MACD's histogram is undefined for ~34. **Emit
`null`** for those leading bars (charting libs render a gap). Emitting `0` (or back-filling with the
first real value) draws a false flat line and corrupts any downstream cross-detection.

### B. Repainting — lock closed bars

A closed bar's indicator value is **final** and must never change. The forming (current) bar's value
moves with every tick — that's expected — but recomputing *closed* bars after each tick so the line
"repaints" is deceptive: a backtest or eyeball read sees signals that never actually existed in real
time. **Compute closed bars once; only the last (forming) bar updates.** State which bars are final.
(Same rule appears as Non-Negotiable #5 in the SKILL.)

### C. Real input only

Indicators are only as honest as the array under them. The close array must come from the finance
data layer ([`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)); **if the series
is `unavailable`/`stale`, say so and don't draw a confident indicator over guessed bars.** Yahoo's
close array can contain `null`s on no-trade bars — `fetchYahooQuote` already filters to numeric
values (see the `closes` filter in that fn), but if you fetch raw OHLC elsewhere, decide explicitly:
forward-fill, drop, or interpolate gaps **before** computing — never let a `null` silently become
`NaN` mid-window and poison every subsequent value.

---

## 10. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Letting the model state an RSI/MACD number from "knowledge". | Compute it over a real close array from `sources.ts`; if no series, say it's unavailable. |
| Pulling the series via Twelve Data `time_series` to feed the indicator. | Use Yahoo's `indicators.quote[0].close` (keyless, credit-free) per `fetchYahooQuote`; TD `time_series` is 1 credit each and blows the 8/min budget. |
| Plotting an indicator from bar 0. | Warm up: leading `null`s until the window fills (RSI-14 → first 13 `null`; Bollinger-20 → first 19). |
| Recomputing closed bars after each tick so the line repaints. | Lock closed bars; only the forming bar updates. State which bars are final. |
| Seeding EMA from `close[0]`. | Seed from the SMA of the first `N` closes, then recurse — matches reference platforms. |
| RSI with a *simple* average of gains/losses. | Wilder smoothing: `avg = (prev*(N-1)+cur)/N`, seeded from the simple mean of the first N. |
| Bollinger SD with the `N-1` sample formula. | Population SD (divide by `N`) — Bollinger's definition. |
| Running the MACD signal EMA over the null-padded array. | Run it over compacted (defined) MACD values, then re-offset back to align. |
| Computing VWAP across multiple days without re-anchoring. | Reset the cumulative sums at each session open; VWAP is intraday-only. |
| Back-filling warmup with `0`. | `null` (a real gap), so cross-detection and the chart aren't corrupted. |
| Treating `null` bars in the OHLC as `0`/`NaN`. | Decide a gap policy (drop/forward-fill/interpolate) before computing; `fetchYahooQuote` already filters non-numeric closes. |
| Calling an RSI<30 / MA-cross a "buy". | Describe what the indicator shows (what bulls/bears would note); end with "Not financial advice." |

---

## 11. Where this connects

- **Input bars / which `interval`+`range` / OHLC shape** → `candlestick-and-ohlc.md` (and the
  data-sourcing rules in **finance-markets** `market-data-providers.md`).
- **Plotting the series (Lightweight Charts indicator panes, performance with thousands of points)**
  → `charting-libraries-deep.md`.
- **Using indicators as a backtest signal (look-ahead-free, fees/slippage)** →
  `backtesting-concepts.md`.
- **Scanning many symbols by an indicator value** → `screeners-and-scans.md` (you cannot fan out a
  per-symbol live fetch — server-side over an indexed snapshot).
- **The no-advice framing wrapped around any indicator read** → `trading-safety-and-disclaimers.md`;
  enforced by `FINANCE_PERSONA` in [`backend/prompt.ts`](../../../../backend/prompt.ts) and the
  `_disclaimer` stapled by `withGuard` in [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts).
