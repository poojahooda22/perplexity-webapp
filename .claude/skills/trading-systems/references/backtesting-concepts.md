# Backtesting Concepts — signal → position → returns, bias, and metrics

> The reusable mental model for backtesting a trading rule: how a signal becomes a position becomes a
> return stream, the biases that make every naive backtest lie (look-ahead, survivorship, slippage,
> fees), the validation discipline (walk-forward, out-of-sample, overfitting), and the metrics that
> summarize a curve (CAGR, Sharpe, max drawdown). **Informational/educational only — never a strategy
> recommendation, never advice.** This is generic-domain knowledge; it cites our files only to show
> where bars come from and how the no-advice contract is enforced.
> Read this when a task asks to backtest/evaluate a rule, explain bias, or define a performance
> metric. Adjacent siblings: `technical-indicators.md` (the signals you backtest), `candlestick-and-ohlc.md`
> (the bars you backtest over + how we source them), `portfolio-and-watchlist-ux.md` (paper-trading
> state & the contested cash balance), `trading-safety-and-disclaimers.md` (the framing contract this
> doc inherits).

---

## 0. The one-line contract

A backtest in Lumina is **illustrative arithmetic over historical bars**, presented neutrally, never
phrased as "this works / you should run this." The same not-advice gate that wraps every finance tool
result applies: `withGuard` staples `_disclaimer: "Informational only — not financial advice."` onto
object results (`DISCLAIMER` in [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts) line 16),
and `FINANCE_PERSONA` (in [`backend/prompt.ts`](../../../../backend/prompt.ts)) forbids buy/sell/hold.
A backtest that omits fees/slippage or uses future data is not "optimistic" — it is **fiction**, and
presenting fiction as a result is the failure mode this whole doc exists to prevent.

---

## 1. The pipeline: signal → position → returns

Every backtest is the same four stages over a time-indexed bar series. Keep them as separate arrays so
each can be inspected and so the **timing offset** (the heart of look-ahead safety) is explicit.

| Stage | What it is | Shape | The trap |
|-------|-----------|-------|----------|
| **Bars** | OHLCV per period, oldest→newest, in **one** timezone/session convention | `{t, o, h, l, c, v}[]` | Mixed sessions, gaps, splits not adjusted → garbage downstream. |
| **Signal** | A rule evaluated **at bar `t` using only data ≤ `t`** → a desired exposure | `signal[t] ∈ {-1,0,+1}` (or a weight) | Computing it from `c[t]` then trading at `o[t]`/`c[t]` = look-ahead. |
| **Position** | The signal **lagged by ≥1 bar** to model "decide now, act next bar" | `pos[t] = signal[t-1]` | Acting on the same bar you decided on. |
| **Returns** | Bar return × held position − costs | `ret[t] = pos[t] * barRet[t] - cost[t]` | Forgetting to subtract `cost`; compounding wrong. |

```ts
// Illustrative ONLY — educational arithmetic, not a strategy. Bars come from the finance data layer
// (Yahoo close array via fetchYahooQuote), never fabricated. See candlestick-and-ohlc.md.
function backtestLongFlat(closes: number[], signal: (i: number) => 0 | 1, feeBps = 0, slipBps = 0) {
  const ret: number[] = [];
  let prevPos = 0;
  for (let i = 1; i < closes.length; i++) {
    const pos = signal(i - 1);                 // LAG: decide on bar i-1, hold over i  ← no look-ahead
    const barRet = closes[i] / closes[i - 1] - 1;
    const turnover = Math.abs(pos - prevPos);  // 0 or 1 here; 0..2 for long/short flips
    const cost = turnover * (feeBps + slipBps) / 10_000; // bps → fraction, charged on the change
    ret.push(pos * barRet - cost);
    prevPos = pos;
  }
  return ret; // per-bar net return stream → feed §5 metrics
}
```

The single most important line is `signal(i - 1)`: **the position over bar `i` is decided from
information available at bar `i-1`.** Drop the lag and every metric below inflates.

---

## 2. The four biases (each one silently inflates results)

| Bias | What happens | Concrete tell | How to avoid |
|------|--------------|---------------|--------------|
| **Look-ahead** | The rule uses data it could not have had at decision time. | Entry at the **same** bar's close that produced the signal; using a full-series mean/normalization; using a not-yet-released earnings/restated value. | Lag the position ≥1 bar; compute any rolling stat over a trailing window only; use point-in-time data. |
| **Survivorship** | The universe contains only names that exist **today** — delisted/bankrupt/acquired ones were dropped. | Backtesting "S&P 500 members" using the *current* member list across 10 years. | Use a point-in-time constituent set; for single tickers, remember the chart you fetched is itself a survivor. |
| **Slippage** | Fills assumed at the printed close/mid; real fills are worse, especially in size or thin names. | "0 cost" curve; trading at exact close. | Model slippage in bps (wider for illiquid/volatile/large orders); charge it on every position change. |
| **Fees / financing** | Commissions, spread, borrow cost (shorts), funding (perps) omitted. | Backtest never subtracts anything per trade. | Per-trade fee in bps on turnover; borrow/funding per holding period for shorts/leverage. |

**Look-ahead is the silent killer** because it produces a *beautiful* curve that is purely impossible.
Two extra sneaky forms:

- **Normalization leakage** — scaling features by the whole dataset's mean/σ (which includes the
  future). Fit scalers on the in-sample window only.
- **Repainting indicators** — an indicator whose past values change as new bars arrive (see
  `technical-indicators.md` warmup/repaint). A backtest over a repainting signal is meaningless. Lock
  closed bars; only the forming bar may move.

> Survivorship + look-ahead together explain most "amazing" amateur backtests. If a result looks too
> good, assume one of these before assuming alpha.

---

## 3. Cost modeling (the line between illustrative and fiction)

Costs are charged **on turnover** — the change in position — not on every bar held.

```
cost[t] = |pos[t] - pos[t-1]| * (feeBps + halfSpreadBps + slipBps) / 10_000
```

| Component | Typical framing | Notes |
|-----------|-----------------|-------|
| Commission | 0–5 bps (equities), often ~0 retail US; perps have maker/taker | Per side; round-trip ≈ 2×. |
| Spread (half) | ½ the bid/ask; widens for thin names / off-hours | If you fill at mid you owe ~half-spread of slippage. See `market-microstructure-basics.md`. |
| Slippage | extra bps for impact; grows with order size vs ADV and with volatility | Conservative > optimistic; a backtest should survive a *pessimistic* cost assumption. |
| Borrow / funding | shorts pay borrow; leverage/perps pay funding per period | Easy to forget; flips many short strategies negative. |

**Rule:** always report the curve **both** without costs (to show the raw signal) **and** with a
realistic, slightly pessimistic cost stack. If the edge only survives at zero cost, there is no edge.

---

## 4. Validation: in-sample, out-of-sample, walk-forward, overfitting

The danger isn't a bad backtest — it's a backtest **tuned on the data it's evaluated on**. Tuning N
parameters against one history will find a curve that fit *noise*; it will not repeat.

```
Full history ──────────────────────────────────────────────────────────────►
[  TRAIN (tune params)  ][  TEST (evaluate, never tuned)  ]           ← simple holdout

Walk-forward (rolling): tune on a window, test on the next, roll, repeat — concat the TEST pieces:
[ train ][test]
        [ train ][test]
                [ train ][test]            → out-of-sample equity = the joined test segments only
```

| Concept | Definition | Why it matters |
|---------|-----------|----------------|
| **In-sample (IS)** | Data used to choose parameters. | IS results are optimistic by construction — never report IS as "the result." |
| **Out-of-sample (OOS)** | Data the parameters never saw. | The only honest performance estimate. |
| **Walk-forward** | Repeated tune→test rolling forward; report the stitched OOS. | Closest to live trading; exposes regime sensitivity. |
| **Overfitting** | Edge that exists only on the tuned data. | More params + more tries + small data = guaranteed overfit. |
| **Multiple-testing / p-hacking** | Trying 500 variants and reporting the best. | The best of 500 random rules looks great by luck. Track how many you tried; haircut accordingly. |

**Decision framework — is this backtest trustworthy enough to *describe* (never recommend)?**

```
Did the position use only data ≤ decision bar (lagged ≥1)? ── no ──► look-ahead. Discard; fix timing.
        │ yes
Were fees + slippage charged on turnover? ──────────────── no ──► fiction. Add costs, rerun.
        │ yes
Is the universe point-in-time (no survivorship)? ───────── no ──► caveat heavily / single-ticker only.
        │ yes
Were params tuned on a DIFFERENT window than evaluated? ── no ──► in-sample only → label optimistic.
        │ yes
How many variants were tried before this one? ── many ──► multiple-testing risk → haircut, widen OOS.
        │ few
→ Trustworthy enough to PRESENT as illustrative, with costs/period/assumptions stated. Still: not advice.
```

---

## 5. Metrics (define every one you show)

Compute these off the **per-bar net return stream** from §1. Let `r` = returns, `P` = periods/year
(252 trading days, 52 weeks, 12 months, 365 for 24/7 crypto), `n` = number of bars.

| Metric | Formula (per-bar returns `r`) | Reads as | Pitfall |
|--------|-------------------------------|----------|---------|
| **Total / cumulative return** | `∏(1+r) − 1` | Growth of \$1 over the window. | Sensitive to start/end dates. |
| **CAGR** | `(equity_end/equity_start)^(P/n) − 1` | Annualized geometric growth. | Meaningless on <~1yr; don't annualize a 3-month fluke. |
| **Volatility (annualized)** | `std(r) * √P` | Spread of returns. | Use population/sample consistently; non-normal tails hide here. |
| **Sharpe** | `(mean(r) − rf_per_bar) / std(r) * √P` | Return per unit of total risk. | Annualize with `√P`; subtract a risk-free; high Sharpe on few trades = noise. |
| **Sortino** | like Sharpe but `std` of **downside** returns only | Penalizes downside, not upside vol. | Define the MAR (often 0). |
| **Max drawdown (MDD)** | `min_t( equity_t / runningMax_t − 1 )` | Worst peak-to-trough loss. | The number that actually gets people to quit; always report it. |
| **Calmar** | `CAGR / |MDD|` | Return per unit of worst pain. | Window-length sensitive. |
| **Win rate / payoff** | `% winners`, `avg win / |avg loss|` | Shape of the edge. | High win rate + tiny wins/huge losses can still lose. |
| **Exposure / turnover** | `% bars in market`, `Σ|Δpos|` | How often capital is deployed / traded. | High turnover × real costs erases paper edge (§3). |

```ts
// Illustrative metric helpers over a per-bar net return stream (educational only).
const equityCurve = (r: number[]) => r.reduce<number[]>(
  (eq, x) => (eq.push((eq.at(-1) ?? 1) * (1 + x)), eq), [1]);

function maxDrawdown(r: number[]) {
  let peak = -Infinity, mdd = 0;
  for (const e of equityCurve(r)) { peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1); }
  return mdd; // negative, e.g. -0.32 = a 32% peak-to-trough loss
}

function sharpe(r: number[], periodsPerYear = 252, rfPerBar = 0) {
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : ((mean - rfPerBar) / sd) * Math.sqrt(periodsPerYear);
}
```

**Sharpe annualization is `× √P`, not `× P`** — variance scales linearly with time, std with its root.
A daily Sharpe annualized with `√252`. Getting this wrong inflates Sharpe ~16×.

---

## 6. Where the bars come from (the only project-specific part)

A backtest is only as honest as its inputs. On this stack you do **not** fabricate or fetch raw
upstream — you reuse the finance data layer:

- **Bars / closes** come from Yahoo's keyless chart API via `fetchYahooQuote` in
  [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts), reading
  `indicators.quote[0].close` (a credit-free close array — **not** Twelve Data `time_series`, which is
  1 credit per call and blows the 8/min budget). See `candlestick-and-ohlc.md` for `interval`/`range`.
- The daily-change reference in `sources.ts` (~line 300) deliberately uses `closes[len-2]` (yesterday's
  close), **not** `meta.chartPreviousClose` (the *range* previous close) — the same care a backtest
  needs when defining "the previous bar."
- If the series is `stale`/`unavailable`, the backtest **says so** rather than silently running over a
  stale or partial array — same honesty rule as every finance tool result.
- A daily Yahoo close array is fine for an **illustrative** daily backtest. It is **not** survivorship-
  adjusted, has no intraday fills, and is delayed/`commercialOk`-gated — never present such a backtest
  as a tradable, real-time, or universe-wide result.

> Lumina ships **no** backtesting engine today. This doc is the knowledge to build/explain one
> correctly *if asked*, and to frame any ad-hoc "what if I had bought" computation safely. If a real
> engine is ever built, it belongs server-side over the cached bar series, with the §4 validation and
> §3 costs baked in — not a client-side toy over the in-memory watchlist.

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Position uses the same bar's close that generated the signal. | Lag ≥1 bar: `pos[t] = signal[t-1]`; enter on the next bar's open/close. |
| Backtest with zero fees/slippage and a glowing curve. | Charge fee+spread+slippage in bps on turnover; report no-cost AND realistic-cost curves. |
| Backtesting today's index members across 10 years. | Point-in-time constituents; for single tickers, flag that the chart itself is a survivor. |
| Tuning parameters and reporting on the **same** history. | Out-of-sample / walk-forward; the reported curve is the stitched OOS segments. |
| Trying 200 rules, presenting the best as "the strategy." | Disclose the search; haircut for multiple testing; widen OOS; prefer fewer params. |
| Annualizing a 2-month backtest's return into a CAGR headline. | State the window; don't annualize short samples; show absolute period return too. |
| `Sharpe = mean/std * 252`. | `* √252` — variance scales with time, std with its root. |
| Reporting return with no drawdown. | Always pair return with max drawdown (and ideally Calmar). |
| Normalizing features over the whole dataset (incl. future). | Fit scalers/rolling stats on trailing data only — no leakage. |
| Backtesting a repainting indicator. | Lock closed bars; only the forming bar updates (see `technical-indicators.md`). |
| Fabricating OHLC or pulling a series via TD `time_series`. | Real bars via Yahoo `indicators.quote[0].close` through `sources.ts` + cache. |
| "This strategy returns 40%/yr — you should run it." | Describe neutrally: period, assumptions, drawdown, costs; end with "Not financial advice." |

---

## 8. "Done" for any backtest content

A backtest answer/feature is done when:
1. **Timing is look-ahead-free** — position lagged ≥1 bar; rolling stats trailing-only.
2. **Costs are stated** — fee+slippage on turnover; no-cost and realistic-cost both shown.
3. **Validation is honest** — IS vs OOS distinguished; walk-forward where "robust" is claimed;
   multiple-testing acknowledged.
4. **Universe caveated** — survivorship noted; single-ticker scope stated.
5. **Metrics defined** — CAGR, Sharpe (annualized with √P), max drawdown at minimum, each defined.
6. **Sourced** — bars from `sources.ts` (Yahoo close array), never fabricated; `stale`/`unavailable`
   surfaced.
7. **Framed** — explicitly illustrative/educational, never a recommendation; "Not financial advice."
   present and the `_disclaimer` intact on object results.
