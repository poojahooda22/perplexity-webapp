# Crypto Volatility & Risk — reading the numbers, framing them neutrally

> The domain knowledge behind *risk* in a crypto answer: what volatility / drawdown / correlation /
> liquidity actually mean for a digital asset, how to compute them from the sparkline + 24h fields
> our CoinGecko layer already returns, and — the part Lumina lives or dies on — how to **present**
> that risk as a mechanism, never as a verdict or a trade. Read this when a task asks "how risky is
> X", "why did X crash", "is X correlated to BTC", or "how do I word the risk section." This is a
> **generic** ref (reusable knowledge); the CoinGecko *plumbing* lives in `lumina-coingecko-data.md`,
> the asset *fundamentals* (FDV / supply / float) in `crypto-asset-fundamentals.md`, DeFi-specific
> risk (IL, smart-contract, depeg) in `defi-concepts.md`, and the **disclaimer + scam framing** in
> `crypto-safety-and-disclaimers.md`. The data/cache/licensing layer is **finance-markets**.

---

## 1. The five risks, and which we can actually measure

Crypto risk is not one number. Separate it into distinct, nameable mechanisms — a good risk section
names each and states whether we can quantify it from the data we have.

| Risk | What it is | Measurable from our data? | Source field |
|------|-----------|---------------------------|--------------|
| **Volatility** | Dispersion of returns — how violently price swings | **Yes** — from `sparkline_in_7d` (168 hourly points) or 24h change | `sparkline_in_7d.price[]`, `price_change_percentage_24h` |
| **Drawdown** | Drop from a prior peak to a trough (peak-to-valley) | Partial — only over the 7d window we hold; true max-drawdown needs longer history | `sparkline_in_7d.price[]` |
| **Correlation to majors** | How much the asset moves *with* BTC/ETH | Partial — needs aligned series for both; rough from same-window sparklines | two coins' `sparkline_in_7d.price[]` |
| **Liquidity risk** | Can you exit at the quoted price, or does your order move it? | **Proxy only** — volume / market-cap ratio, not true order-book depth | `total_volume`, `market_cap` |
| **Tail / structural risk** | Rug, depeg, exploit, unlock cliff, exchange failure | **No** — qualitative; describe the mechanism | n/a (see safety ref) |

> **The honesty rule:** if we can't measure it, say so. "I can compute 7-day volatility but not a
> long-run max-drawdown from the data I have" is correct and trustworthy. Inventing a Sharpe ratio
> or a "risk score" out of a 168-point sparkline is the amateur move.

---

## 2. Volatility — definitions you must not blur

"Volatility" colloquially means "swings a lot." Quantitatively it has a precise meaning, and three
common framings get conflated:

| Term | Meaning | Note |
|------|---------|------|
| **Realized (historical) volatility** | Stdev of past returns, usually annualized | What you can compute from a sparkline |
| **Implied volatility** | The market's *expected* future vol, backed out of option prices | We have **no** options data — never claim IV |
| **Return vs. price stdev** | Always compute vol on **returns** (`pₜ/pₜ₋₁ − 1`), not raw prices | Stdev of raw prices is meaningless across price levels |
| **Annualization** | `σ_annual = σ_period × √(periods/year)` | Hourly→annual = ×√8760; daily→annual = ×√365 (crypto trades 24/7, so 365 not 252) |

**Crypto vs. equities, for calibration (typical, not a promise):** large-cap equity annualized vol
~15–25%; BTC/ETH often 50–80%; small-cap alts can exceed 100–150%. A single 24h move of ±10% is
routine for an alt and would be a once-a-decade event for a blue-chip stock. State magnitudes in
context so a reader who only knows stocks isn't misled.

### Computing 7-day realized volatility from the sparkline

```ts
// sparkline_in_7d.price is ~168 hourly closes (newest last). Returns, not prices.
function realizedVol(prices: number[]): { hourly: number; annualized: number } | null {
  if (!prices || prices.length < 24) return null;            // too few points → don't fake it
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) rets.push(prices[i] / prices[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1); // sample, n−1
  const hourly = Math.sqrt(variance);
  return { hourly, annualized: hourly * Math.sqrt(24 * 365) }; // 24/7 market → 8760 hours/yr
}
```

This runs on the `sparkline` array CoinGecko returns via `fetchCrypto` (the dashboard fetch, which
requests `sparkline=true`; see `lumina-coingecko-data.md`). Note the agent-tool path
`fetchCryptoMarkets` / `getCrypto` requests `sparkline=false`, so to compute vol there you must
add the sparkline to that fetch first. Always return `null` (and say so) when the window is too
short rather than emit a vol from 5 points.

---

## 3. Drawdown — peak-to-trough, the loss a holder actually feels

Volatility is symmetric; **drawdown** is the downside number people care about ("how much could I
have been down"). Max drawdown = the largest peak-to-trough decline over a window.

```ts
function maxDrawdown(prices: number[]): number | null {        // returns a negative fraction, e.g. -0.32
  if (!prices || prices.length < 2) return null;
  let peak = prices[0], worst = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = p / peak - 1;          // ≤ 0
    if (dd < worst) worst = dd;
  }
  return worst;                        // e.g. -0.32  ⇒  "fell 32% from its 7-day peak"
}
```

**Framing caveats (state them):**
- Our drawdown is **window-bounded** — only over the 7d sparkline. Don't call it "the max drawdown";
  call it "the largest drop within the last 7 days."
- A drawdown is **recovery-blind**: a coin can be −80% from its all-time high yet flat this week.
  All-time-high context (if you have it from a named source) is more informative than a 7d trough.
- Drawdown ≠ realized loss. It's the worst paper position over the window; phrase as price behavior,
  not "you would have lost X."

---

## 4. Correlation to majors (BTC / ETH) — the "is it actually diversified" question

Most alts are not independent bets — they ride BTC/ETH. Correlation tells you how much an asset's
moves are explained by the majors. Range −1 (opposite) … 0 (unrelated) … +1 (lockstep).

| ρ (vs BTC) | Read it as |
|-----------|------------|
| ~ +0.9 | A leveraged proxy for BTC — "diversifying" into it adds almost no independence |
| ~ +0.5–0.8 | Moves with the majors but has idiosyncratic drift (most large alts) |
| < +0.3 | Genuinely decoupled this window (rare; verify it's not just a thin/illiquid series) |

```ts
// Pearson ρ on ALIGNED return series. Both arrays must be the same window & cadence.
function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 24) return null;
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < n; i++) { ra.push(a[i] / a[i-1] - 1); rb.push(b[i] / b[i-1] - 1); }
  const m = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = m(ra), mb = m(rb);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i]-ma)*(rb[i]-mb); va += (ra[i]-ma)**2; vb += (rb[i]-mb)**2;
  }
  return cov / Math.sqrt(va * vb);
}
```

**Pitfalls (all real):**
- **Correlation is not causation, and it's not stability.** ρ over 7d can flip in the next 7d —
  crypto correlations spike toward +1 in crashes ("everything sells off together"), which is exactly
  when diversification was supposed to help and doesn't. Say it's a *recent-window* estimate.
- **Align the series.** Compute on the same window/cadence for both coins; mismatched timestamps give
  a garbage ρ that *looks* authoritative.
- **Stablecoins** should read ~0 vol and ~0 correlation to BTC by design — if one doesn't, that's a
  depeg signal worth flagging neutrally, not a "low-risk" badge.

---

## 5. Liquidity risk — the one number people skip and the market punishes

Volatility is about price *moving*; liquidity is about whether *you can transact at that price*. A
coin can look calm and still be a trap: thin books mean your own order moves the price (slippage),
and in a panic there's no bid. We have **no order-book depth** from CoinGecko, so use a documented
**proxy** and label it as such.

| Proxy | Formula | Rough read |
|-------|---------|-----------|
| **Volume / Market-cap (turnover)** | `total_volume / market_cap` | < ~0.02 → thin; 0.05–0.30 → liquid; **> ~1.0** → suspicious (wash-trading or a micro-float pump) |
| **Absolute 24h volume** | `total_volume` (USD) | Sub-\$1M daily volume = you likely can't exit a real position without moving it |
| **Market-cap vs FDV gap** | from supply fields (see fundamentals ref) | Big locked supply → future unlock = liquidity overhang |

```ts
function liquidityProxy(volume24h: number, marketCap: number) {
  if (!marketCap) return null;
  const turnover = volume24h / marketCap;
  return {
    turnover,
    note: turnover > 1     ? "Volume exceeds market cap — verify the venue; can indicate wash trading."
        : turnover < 0.02  ? "Low turnover — thin liquidity; large orders may move the price."
        :                    "Turnover in a typical liquid range (proxy only — no order-book depth).",
  };
}
```

**Data caveat:** the current mapper (`mapCoinGeckoRow` in `backend/finance/sources.ts`) does **not**
carry `total_volume` through — it maps only `price`, `change24h`, `marketCap`, `sparkline`. To use
this proxy you must first add `volume: c.total_volume` to that mapper. Don't assume the field is
already on the payload.

**Always disclaim the proxy:** "This is a volume/market-cap proxy from CoinGecko, not order-book
depth — real slippage depends on the venue." Liquidity risk is also *concentration* risk (one
exchange, one whale, one LP) — name those mechanisms when relevant; we can't measure them.

---

## 6. Presenting risk neutrally — the core skill of this skill

Lumina is **informational only**. The persona forbids advice and
[`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts) already staples
`_disclaimer: "Informational only — not financial advice."` onto every object tool result (the
`withGuard` wrapper, see the `DISCLAIMER` constant). Your job is to make the *prose* match that
contract: describe mechanisms and numbers, let the reader draw the conclusion.

**The neutral-framing pattern: STATE → MECHANISM → CONTEXT → (no verdict).**

| Layer | Do | Example |
|-------|----|---------|
| **State** the number | Report what's measurable with as-of time + source | "Over the last 7 days, X's annualized realized volatility was ~95% (CoinGecko, as of 14:02 UTC)." |
| **Explain** the mechanism | Why that number arises / what it implies structurally | "High vol means daily ±10% moves are routine; combined with sub-\$1M daily volume, exits can incur meaningful slippage." |
| **Contextualize** | Compare to a reference class, label the window | "For comparison, BTC's same-window vol was ~55%; this is a 7-day estimate and can change quickly." |
| **Stop** — no verdict | Do NOT say buy/sell/hold/avoid/safe/good entry/allocate | ✗ "so it's too risky to buy" ✗ "a good time to enter" |

> **The litmus test:** could a reader who *wants* to act on it AND a reader who *doesn't* both find
> your sentence accurate and non-leading? If your sentence only makes sense as encouragement or
> discouragement, rewrite it as a mechanism. End the answer with "Not financial advice."

---

## 7. Risk-word translation table (advice-laden → neutral-mechanism)

| ❌ Advice-laden / loaded wording | ✅ Neutral mechanism |
|----------------------------------|----------------------|
| "X is **safe** / **low-risk**." | "X's 7-day volatility was ~12%, lower than most alts this window — past behavior, not a guarantee." |
| "X is **too risky to hold**." | "X showed a 7-day max drawdown of −40% and thin turnover; both are risk mechanisms to be aware of." |
| "Now is a **good entry**." / "**Buy the dip**." | "X is −30% from its 7-day peak; price level alone doesn't indicate future direction." |
| "X will **moon** / **recover**." | "I can't forecast price. Here is the recent realized volatility and drawdown." |
| "It **can't go lower**." | "There is no price floor; the asset can decline further. Recent drawdown was −X%." |
| "**Diversify** into low-correlation alts." | "X's recent correlation to BTC was +0.4; note correlations often rise toward +1 in market-wide sell-offs." |
| "X has a **risk score of 8/10**." | "I won't invent a composite score from a 7-day window; here are the individual measures." |
| "**Stablecoin**, so **zero risk**." | "It targets a \$1 peg; pegs can break (depeg) — state the collateral type and any recent deviation." |

---

## 8. Decision framework — "how risky is X?" arrives

```
Risk question on a crypto asset
|
+-- Need a NUMBER (vol / drawdown / correlation / liquidity)?
|     |
|     +-- Do we have the series? (sparkline_in_7d present, ≥24 points) ──── no ─► say what's missing;
|     |                                                                          offer the 24h field only
|     +-- yes ─► compute on RETURNS, sample stdev, annualize 24/7 (√8760)
|              ─► label window ("7-day"), source (CoinGecko), as-of (fetchedAt), stale honestly
|
+-- "Why did X crash / pump?" ───► it's a news/causation question, not a stats one:
|       route to crypto-news-and-sentiment.md (Tavily topic:news, synthesized, cited) — never
|       assert a cause you can't source
|
+-- Liquidity / "can I get out?" ─► turnover proxy + absolute volume + DISCLAIM (no depth data)
|
+-- DeFi-specific (IL, depeg, smart-contract, liquidation) ─► defi-concepts.md
|
+-- Scam / rug / unlock-cliff / "is it legit?" ─► crypto-safety-and-disclaimers.md (mechanisms, not verdicts)
|
+-- ALWAYS: numbers sourced + as-of shown + neutral framing + "Not financial advice." tail
```

---

## 9. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Computing volatility on **raw prices**. | Compute on returns (`pₜ/pₜ₋₁−1`); raw-price stdev is meaningless across price levels. |
| Annualizing crypto vol with **√252** (the equity trading-day count). | Crypto trades 24/7 → use √365 (daily) or √8760 (hourly). |
| Quoting a vol/Sharpe/risk-score from **5 points** of sparkline. | Require a minimum window (≥24 pts); else return `null` and say the history is too short. |
| Calling a 7-day trough "**the max drawdown**." | Scope it: "largest drop within the last 7 days"; true max-DD needs long history. |
| Reporting **implied volatility**. | We have no options data — only realized/historical vol. Never claim IV. |
| Presenting **correlation as stability/diversification**. | ρ is a recent-window estimate that spikes toward +1 in crashes; say so. |
| Treating **volume/mcap turnover as true liquidity**. | It's a proxy; no order-book depth from CoinGecko — disclaim slippage/venue dependence. |
| Calling a stablecoin "**zero risk**." | Pegs break; name collateral type + flag any depeg neutrally. |
| Inventing a **cause** for a move ("X crashed because of the Fed"). | Causation = a news task; route to crypto-news-and-sentiment, synthesize + cite, or say it's unclear. |
| Any **buy/sell/hold/safe/good-entry/too-risky** phrasing. | STATE→MECHANISM→CONTEXT, no verdict; rely on the §7 translation table; end "Not financial advice." |
| Serving a vol number from a **stale/cached** price as if live. | Pass through the tool's `fetchedAt`/`stale`; crypto skips the semantic cache (see finance refs). |
| Fabricating a number when the **tool returns `{unavailable}`**. | Say live data is momentarily rate-limited; never fill the gap with a guess. |

---

## 10. Output contract for a risk section

A crypto risk answer is done when:
1. **Each risk named** as a distinct mechanism (vol, drawdown, correlation, liquidity, structural) —
   and you stated which you could and could **not** measure from the data on hand.
2. **Numbers computed correctly** — on returns, sample stdev, 24/7 annualization, minimum-window
   guarded; window labeled, source (CoinGecko) + `fetchedAt` shown, `stale` surfaced.
3. **Liquidity disclaimed** as a turnover proxy, not order-book depth.
4. **Framing neutral** — STATE→MECHANISM→CONTEXT, no verdict; passes the §6 litmus test; no banned
   words from the §7 table.
5. **Causation routed** — "why did it move" went through news synthesis with citations, or was
   declined, never asserted unsourced.
6. **Disclaimer present** — "Not financial advice." on the prose (the agent path already staples
   `_disclaimer` via `withGuard`).
7. **No fabrication** — a missing series → say so; an `{unavailable}` tool → say rate-limited; never
   a guessed figure.

---

## 11. Cross-references

- `lumina-coingecko-data.md` *(project-grounded)* — where `sparkline_in_7d`, `price_change_
  percentage_24h`, `total_volume`, `market_cap` come from (`fetchCrypto`/`fetchCryptoMarkets`,
  `getCrypto`), the Demo-key + budget caps. **The numbers you compute here come from there.**
- `crypto-asset-fundamentals.md` *(generic)* — supply/float/FDV math behind unlock-overhang and the
  market-cap-vs-FDV liquidity gap.
- `defi-concepts.md` *(generic)* — DeFi-native risks (impermanent loss, depeg, smart-contract,
  liquidation) that don't show up in price stats.
- `crypto-safety-and-disclaimers.md` *(project-grounded)* — the disclaimer + scam/rug framing and the
  `FINANCE_PERSONA` + `withGuard` `_disclaimer` pattern this ref leans on.
- **finance-markets** (sibling skill) — the cache/budget/licensing plumbing; `crypto-and-prediction-
  markets.md` for the existing crypto tool semantics, `data-licensing-and-compliance.md` for display
  rights on any number you render.
- **ai-sdk-agent** (sibling skill) — the engine (tool loop, `stopWhen`, hooks) if you're wiring a new
  risk tool rather than framing an answer.
