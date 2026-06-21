# Market Microstructure Basics — bid/ask, order types, liquidity, sessions, halts, "real-time"

> The mechanics of how a price actually exists: the two-sided quote, the spread, the order book and
> depth, the order types that interact with it, when the market is open, what a halt is, and why the
> word "real-time" is a *licensing* word, not a technical one. Read this before you put a "price",
> "bid", "ask", "spread", "volume", or "live" label on the screen, or before the agent explains how
> an order or a quote works. **Generic-domain** knowledge — the formulas/concepts transfer to any
> stack; project hooks are cited only where Lumina's data layer already touches them.
>
> Adjacent refs: bar/series sourcing (`interval`/`range`, the Yahoo close array) →
> [`candlestick-and-ohlc.md`](./candlestick-and-ohlc.md); the never-fabricate + as-of-time +
> disclaimer contract → [`trading-safety-and-disclaimers.md`](./trading-safety-and-disclaimers.md);
> the *DATA* side — providers, free-tier limits, the `commercialOk` gate, exchange fees → **finance-markets**
> `market-data-providers.md` + `data-licensing-and-compliance.md`.

---

## 0. Why a "price" is not one number

A retail UI shows one number ("AAPL 213.40") and that hides the entire machine. A tradeable price is
a **two-sided quote** sitting on top of an **order book**, valid for a **fixed quantity**, **during a
session**, **licensed at a freshness tier**. Every microstructure concept below is one of those five
qualifiers. If you only ever render the single last-trade number, you are showing Tier-1 truth and
calling it the market.

| The displayed "price" hides | The real concept | Section |
|---|---|---|
| There are *two* prices, and you trade at the worse one | Bid / Ask / Spread | §1 |
| The price is only good for *so many shares* | Liquidity / depth / book | §2 |
| There are ways to ask for a price | Order types | §3 |
| The number is from *some moment* | Sessions, after-hours, as-of time | §4–5 |
| Trading can *stop* | Halts, circuit breakers, LULD | §6 |
| "Live" is a thing you *pay for* | Real-time vs delayed licensing | §7 |

---

## 1. Bid, ask, spread — the two-sided quote

- **Bid** — the highest price a buyer is currently willing to *pay*. You **sell** into the bid.
- **Ask** (a.k.a. **offer**) — the lowest price a seller is willing to *accept*. You **buy** at the ask.
- **Spread** = ask − bid. Always ≥ 0 on a normal book. It is the instantaneous round-trip cost: buy at
  the ask, sell immediately at the bid, you lose the spread before anything moves.
- **Last** — the price of the most recent *trade*. It is historical (it already happened). Bid/ask are
  what you can do *now*; last is what someone already did.
- **Mid** = (bid + ask) / 2 — a fair-value proxy with no executable meaning; useful for charts/marks,
  never a fill you can promise.

```
        bid 213.38   |   ask 213.41        spread = 0.03  (~1.4 bps of price)
   you SELL here  ◄──┘         └──►  you BUY here
                    mid 213.395            last 213.40 (a prior trade)
```

**Spread in basis points** (1 bp = 0.01%) normalizes across price levels:
`spreadBps = (ask − bid) / mid × 10_000`. A $0.03 spread on a $213 stock (~1.4 bps) is tight; the same
$0.03 on a $2 micro-cap (~150 bps) is enormous. Always compare *bps*, never raw cents.

### Quote quality decision

| Symptom | Likely meaning | Implication |
|---|---|---|
| Spread a few bps, stable | Deep, liquid name (mega-cap, major ETF) | Mid ≈ executable; safe to display |
| Spread tens–hundreds of bps | Thin name / small-cap / illiquid ETF | Mid is fiction for size; warn, don't promise a fill |
| Spread blown out *temporarily* | News, open/close auction, halt re-open | Transient; don't anchor a chart axis to it |
| Bid = 0 or ask missing | One-sided / no quotes | Untradeable right now; render "no quote", not "$0" |

> **Lumina note.** The keyless Yahoo chart endpoint we use returns `meta.regularMarketPrice` (a *last*,
> not a live bid/ask) — see `fetchYahooQuote` in
> [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts). We do **not** currently
> surface live bid/ask/spread. If you add it, source bid/ask from a quote provider that licenses Level
> 1 (e.g. Finnhub/Twelve Data quote), carry it through the same `Provenance`+`stale`+`fetchedAt`
> contract, and never derive a "spread" by guessing around a single last-trade number.

---

## 2. Liquidity, depth, and the order book

The **order book** is the live list of resting limit orders on each side, sorted best-price-first.
Each row is a **price level** with aggregate size.

```
            ASKS (sellers)                         BIDS (buyers)
   px 213.43  size  900                   px 213.38  size 1,200
   px 213.42  size  400                   px 213.37  size   600
   px 213.41  size  300  ◄ best ask       px 213.36  size 2,000
                                  best bid ►  (213.38)
```

- **Level 1** — only the *best* bid/ask + their sizes (the "top of book"). What most free feeds give.
- **Level 2 / depth-of-market** — multiple levels each side. Licensed, heavier, often realtime-only.
- **Liquidity** — how much size you can trade *without moving the price much*. Deep book = liquid.
- **Market impact / slippage** — a market order eats the book level by level; a buy bigger than the
  best ask "walks the book" up to worse prices. The fill is the **size-weighted** average of the
  levels consumed, not the top-of-book number. This is exactly the slippage a backtest must model
  (cross-ref [`backtesting-concepts.md`](./backtesting-concepts.md)).

**Practical rule:** the price you *see* (best bid/ask, or last) is only valid for the size *at that
level*. For anything bigger, the executable price is worse. Never quote a single number as the price
"for any quantity".

---

## 3. Order types (concept only — Lumina does not place orders)

Lumina is **informational only**; it never routes an order. But the agent must explain these correctly,
and paper-trading/portfolio features (see [`portfolio-and-watchlist-ux.md`](./portfolio-and-watchlist-ux.md))
simulate them. Describe behavior; never tell a user *which* to use on a specific trade (that's advice).

| Order type | What it asks for | Guarantees | Risk |
|---|---|---|---|
| **Market** | Fill *now*, at whatever price | Execution (in liquid name) | Price — walks the book; bad in thin/fast markets |
| **Limit** | Fill only at price X or better | Price | Execution — may never fill |
| **Stop (stop-loss)** | Become a *market* order once price crosses the stop | Triggers | Slippage at trigger; gaps blow through it |
| **Stop-limit** | Become a *limit* order at the stop | Price after trigger | May not fill if price gaps past the limit |
| **Marketable limit** | Limit set across the spread (buy ≥ ask) | Near-immediate + a price cap | Tiny residual non-fill risk |

**Time-in-force** qualifies how long an order lives:

| TIF | Meaning |
|---|---|
| **DAY** | Cancels at session close if unfilled |
| **GTC** | Good-til-canceled (broker caps, e.g. 90 days) |
| **IOC** | Immediate-or-cancel — fill what you can now, kill the rest |
| **FOK** | Fill-or-kill — all at once or nothing |

**Maker vs taker:** a resting limit order *adds* liquidity (maker); a market/marketable order *removes*
it (taker). Exchanges price these differently (maker rebate / taker fee). It only matters for cost
modeling, not for an informational explanation — mention it when discussing fees in a backtest.

---

## 4. Market hours & sessions

A quote is meaningless without "as of which session." Sessions differ by exchange and instrument.

| Session (US equities, ET) | Window | Character |
|---|---|---|
| **Pre-market** | 04:00 – 09:30 | Thin, wide spreads, gappy |
| **Opening auction** | 09:30 | Single crossing price; spreads abnormal right around it |
| **Regular trading hours (RTH)** | 09:30 – 16:00 | Deepest liquidity; the "official" tape |
| **Closing auction** | 16:00 | Sets the official close (used for marks/indices) |
| **After-hours** | 16:00 – 20:00 | Thin, wide, gappy |

**Asset-class differences that bite:**

| Asset class | Hours reality |
|---|---|
| **US equities/ETFs** | RTH + extended; closed weekends + ~9 market holidays/yr; half-days |
| **Indices** (^GSPC, ^NSEI) | Computed from constituents → only "move" during the cash session |
| **FX** | ~24×5 (Sun evening ET → Fri evening ET) |
| **Crypto** | 24/7/365 — *no* close, no session, no halt; "daily change" is a rolling 24h, not a session |
| **India equities (NSE/BSE)** | 09:15 – 15:30 IST; different holiday calendar; pre-open auction 09:00–09:15 |

> **Lumina implications.** (1) Crypto's 24/7 nature is why `fetchCrypto` uses a rolling 24h change and a
> short 30s TTL, while indices/stocks use longer TTLs and are stale-but-fine when closed (TTLs in
> [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts)). (2) India is a *separate session
> and holiday calendar*; `Market = "us" | "in"` in
> [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) routes IN symbols to keyless
> Yahoo and uses a distinct `finance:in:*` cache key — never assume the US calendar for IN (cross-ref
> finance-markets `us-india-markets.md`). (3) The Yahoo chart payload's `meta` carries a `marketState`
field (`PRE`/`REGULAR`/
> `POST`/`CLOSED`) is the honest source for an open/closed badge — derive the badge from it, don't infer
> "open" from "we got a number."

### Closed-market display: the as-of-time rule

When the market is closed, the *last* price is yesterday's close — perfectly fine to show, but it must
read as **"as of <session close>"**, not as a live tick. This is the same `fetchedAt` + `stale`
discipline the trading-systems Non-Negotiables demand: the freshness label is part of correctness.
A weekend quote with a green pulsing "LIVE" dot is a lie.

---

## 5. Gaps, opening prints, and "why did it jump overnight"

- A **gap** is when the next session opens away from the prior close (earnings, news after-hours). The
  bar's open ≠ prior bar's close. This is normal and is *why a stop-loss can fill far below the stop* —
  it gaps through the trigger.
- The **opening/closing print** comes from an auction (single crossing price), not continuous trading;
  spreads and the first/last few prints are not representative of intraday conditions. Don't compute an
  indicator's "first real value" off the opening auction tick as if it were a normal bar.
- For charting/indicators: closed bars are **final**; only the forming (current-session) bar updates.
  Recomputing closed bars as new ticks arrive is *repainting* — a bug (see
  [`technical-indicators.md`](./technical-indicators.md) and `candlestick-and-ohlc.md`).

---

## 6. Halts & circuit breakers

Trading can be *stopped*. The agent must explain these; the UI must not render a frozen last price as a
live one during a halt.

| Mechanism | Trigger | Effect |
|---|---|---|
| **Single-stock halt — news pending (T1/T2)** | Pending material news | Trading paused until disseminated + a resume auction |
| **LULD (Limit Up–Limit Down)** | Price exits a dynamic band for 15s | Brief pause (typically 5 min) to curb runaway moves |
| **Volatility / regulatory halt** | Order imbalance, regulatory action | Paused; resume via auction |
| **Market-wide circuit breakers (MWCB)** | S&P 500 drops 7% (L1), 13% (L2), 20% (L3) intraday | L1/L2 = 15-min market-wide halt; L3 = halt for the day |
| **Crypto** | (No exchange-wide halts by design) | Some venues do maintenance/"stale-feed" pauses, not regulated halts |

**During a halt:** there are no executable quotes; the last trade is frozen and *stale by definition*.
Display: show the last price labeled stale + "Halted" if you can detect it (some feeds expose a halt
flag / `marketState`); never animate it as live. The re-open print can gap hard — treat it like §5.

---

## 7. "Real-time" is a licensing word, not a technical one

This is the single most important thing in this doc and the reason it cross-references finance licensing.

**Exchanges own the price data.** NASDAQ, NYSE, NSE, BSE generate the quotes/trades and *sell* access
to them under tiered display licenses. "Real-time" is one of those tiers, with per-user fees and ToS.

| Tier | What it is | Who can show it | Typical cost |
|---|---|---|---|
| **Real-time (licensed)** | Sub-second exchange feed | Paid display license + per-user reporting | $$$ (exchange fees + vendor) |
| **Delayed (15-min)** | The same feed, time-delayed ~15 min | Often free/cheap to *display* | Free–$ |
| **End-of-day / close** | Official close only | Usually freest | Free |
| **Free API "real-time"** | A vendor's near-real-time number, **personal-use** tier | **Build/demo only — NOT cleared for public display** | "Free" (the trap) |

**The free-tier-display trap (restated for trading):** a free API key returning a fresh-looking number
is *technical access*, not a *display license*. Showing it on a public product can violate both the
vendor ToS and the underlying exchange license. In Lumina this is the hard `commercialOk` gate on every
`Provenance` — every series we fetch on free/personal tiers is `commercialOk: false` (see the header
comment + the `Provenance` type and `fetchYahooQuote`/`fetchStocks` provenance in
[`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)). **A trading feature inherits
that gate**: if the bars/quotes feeding your indicator or chart are `commercialOk:false`, the whole
surface is build-and-demo-only. The full provider/license matrix lives in finance-markets
`data-licensing-and-compliance.md` — route there for "can we display this."

**Delay you cannot see is delay you must disclose.** A 15-min-delayed quote looks identical to a live
one. The only honest signal is the label. Always render the as-of time (`fetchedAt`) and the tier
("delayed"/"end of day"), and never paint a delayed/`commercialOk:false` series as "LIVE."

### What is the true live path on this stack

Real-time *display* on Lumina is the WebSocket worker path, not a per-request fetch: a single Finnhub
WS lives in [`worker/`](../../../../worker/) (off Vercel — serverless can't hold a socket), coalesces
ticks, and broadcasts via Supabase Realtime to
[`frontend/src/hooks/use-live-prices.ts`](../../../../frontend/src/hooks/use-live-prices.ts). Even that
is "live during the session, last-known when closed" — and the *licensing* tier of those ticks still
governs whether they can ship publicly. Mechanics → finance-markets `realtime-prices-websocket.md`.

---

## 8. Decision framework — "what freshness/quote do I actually need?"

```
Need a number on screen?
|
+-- Just a reference price / chart point? ------> last + as-of time is fine (most of Lumina today)
|       └─ closed market? label "as of <close>", stale:true, no LIVE dot
|
+-- Need to show what the user could trade at? -> need bid/ask (Level 1) from a quote provider
|       └─ for size? need depth (Level 2) — licensed, realtime-only; rarely worth it for info UX
|
+-- Need sub-second updating ticks? ------------> the worker/Supabase Realtime path, NOT per-request
|       └─ and confirm the tier is licensed for public display before launch (commercialOk)
|
+-- Crypto? -----------------------------------> 24/7, no session/halt; rolling 24h change, short TTL
|
+-- Indices / India? --------------------------> session + holiday calendar differ; separate cache key;
                                                 indices move only during the cash session
```

---

## 9. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Treating the single "price" as what you can trade any size at. | It's valid only for the size at that level; bigger orders walk the book. Quote bid/ask + note depth limits. |
| Showing `last` and calling it "the current price / live." | `last` is a prior trade; bid/ask are "now." Label `last` with its as-of time; only call ticks "live" on the WS path. |
| Quoting a raw-cent spread as "tight." | Normalize to bps (`(ask−bid)/mid×1e4`); $0.03 is tight on $213, huge on $2. |
| Rendering a weekend/holiday/halted quote with a pulsing LIVE dot. | Derive open/closed from `meta.marketState`; show `stale:true` + "as of <close>"/"Halted." |
| Assuming the US calendar/hours for India. | IN has its own session (09:15–15:30 IST) + holidays; route via `Market="in"` + `finance:in:*` key. |
| Treating crypto like equities (session, daily-close change, halts). | Crypto is 24/7: rolling 24h change, short TTL, no halts/sessions. |
| Flipping a series to "real-time/launch-ready" because the free API returned a fresh number. | Technical access ≠ display license. Keep `commercialOk:false` until a paid display/exchange license; see finance-markets licensing. |
| Computing the day's first indicator value off the opening-auction print. | The auction print isn't a normal bar; spreads/prints are abnormal at the open/close. |
| Recomputing closed candles/indicators as new ticks arrive. | Lock closed bars; only the forming bar updates (no repainting). |
| Telling the user "use a market order here" / "set your stop at X." | Explain order-type *mechanics* neutrally; choosing one for a trade is advice. End with "Not financial advice." |
| Deriving a "spread" by inventing a bid/ask around a single last price. | Don't fabricate. If you only have `last`, say there's no live bid/ask; source Level 1 if you need it. |

---

## 10. Quick reference — formulas & invariants

```ts
// Spread in basis points (the only comparable spread metric).
const mid = (bid + ask) / 2;
const spreadBps = ((ask - bid) / mid) * 10_000;

// Invariants to assert before you display a quote:
//   bid <= ask                         (crossed book ⇒ bad/stale data; don't show)
//   bid > 0 && ask > 0                 (a 0 side ⇒ one-sided/no quote, render "no quote")
//   marketState === "REGULAR"          (else label stale / closed / pre / post)
//   commercialOk === true              (else build/demo-only — gate public display)

// Size-weighted fill for a marketable order walking N book levels (slippage model):
//   fill = Σ(price_i * size_i) / Σ(size_i)   over the levels consumed
```

**The five qualifiers, one line each:** a price is *two-sided* (bid/ask), *size-bounded* (depth),
*session-scoped* (hours), *interruptible* (halts), and *license-tiered* (real-time vs delayed). Render
none of them silently.
