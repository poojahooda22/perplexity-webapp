# Equity Analysis Playbook — analyzing one stock, neutrally, without advice

> The DOMAIN of writing a single-stock answer that is grounded, neutral, and never advice. This is
> dev guidance that mirrors and deepens the **runtime** playbook the agent loads at
> [`backend/finance/skills/equity-analysis.md`](../../../../backend/finance/skills/equity-analysis.md)
> — same shape, more "why". When you change that runtime `.md`, change it to match the contract here.
> For the engine that runs the tools (loop, hooks, `loadSkill`, citations) read
> `ai-sdk-finance-agent.md`; for "how are the markets today" (the index-level cousin) read the
> runtime [`market-overview.md`](../../../../backend/finance/skills/market-overview.md).

The hard constraint that shapes everything below: **the agent can only assert what our tools can
source.** Two tools do the work — `getQuote` (price/change/%) and `financeWebSearch` (catalysts,
context) — both defined in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts). If a
claim can't come from one of those, it does not go in the answer.

---

## 1. What we can actually source (and what we can't)

| Want to say | Sourceable? | From | Notes |
|-------------|-------------|------|-------|
| Current price, daily change, % change | ✅ | `getQuote` | US stocks/ETFs only; max 8 symbols/call. |
| "Why it moved today" / catalysts | ✅ | `financeWebSearch` | Tavily `topic:"news"`, last 7 days, 6 results — cite `[n]`. |
| Analyst actions, guidance, earnings dates | ✅ (as reported) | `financeWebSearch` | Attribute to the source via `[n]`; don't restate as fact-from-us. |
| Sector / peer context | ◐ partial | `financeWebSearch` + general knowledge | Frame in plain English; no fabricated peer multiples. |
| Market cap, P/E, fundamentals | ⚠️ NOT from `getQuote` | `financeWebSearch` only | `getQuote` returns price/change, **not** mcap or P/E. If you need a number, it must come from a cited search result — otherwise speak qualitatively. |
| Crypto / index level / non-US listing | ❌ via `getQuote` | wrong tool | `getCrypto` / `getIndices`; `getQuote`'s own description says it does NOT cover these. |
| Price target / fair value | ❌ | nothing we own | We have no valuation model and no analyst-consensus feed. Never print a target you can't cite to `[n]`. |
| "Good investment for you" | ❌ FORBIDDEN | — | Advice. See §6. |

**The key trap:** `getQuote` returns `items` with price/change/percent and a `provenance` — it does
**not** return P/E, market cap, revenue, or margins (see its `execute` in
[`backend/finance/tools.ts`](../../../../backend/finance/tools.ts), which returns
`{ items, provenance, fetchedAt, stale }`). Any fundamental figure therefore has exactly one legal
origin: a `financeWebSearch` result you cite. No source → no number.

---

## 2. The fetch plan (in order)

```
User: "analyze NVDA" / "break down Tesla" / "what's your view on AAPL"
  1. getQuote({ symbols:[TICKER] })           → price, change, %change, fetchedAt, stale
  2. IF user asks WHY / wants catalysts/context:
       financeWebSearch({ query:"<COMPANY> stock <recent driver: earnings|guidance|...>" })
                                               → numbered [n] sources, pushed to sources[]
  3. (optional) financeWebSearch a 2nd focused query if the first misses the catalyst
  → assemble the answer (§3), state as-of time, end "Not financial advice."
```

Rules that come straight from the tool contract:
- **Always `getQuote` first.** A single-stock answer with no price is incomplete. If the user only
  wants context, you still anchor with the current price + as-of time.
- **Only `financeWebSearch` when the question needs news/explanation.** A bare "what's AAPL trading
  at" is a one-tool answer — don't spend a Tavily credit you don't need (budget is 10/min, per-call,
  uncached — every call is a real credit; see `ai-sdk-finance-agent.md` §2).
- **Batch the symbol if comparing two names** — `getQuote` takes up to 8 symbols in one call, which
  is one cache key, not N. But analyzing *one* stock is one symbol.
- **Tickers are uppercased + de-duped** by the tool (`[...new Set(symbols.map(toUpperCase))].sort()`),
  so "nvda"/"NVDA" both resolve. Don't pre-normalize in prose; pass what the user said.

### Handling the tool's typed states (never fabricate around a failure)

| Tool returns | Meaning | What the answer does |
|--------------|---------|----------------------|
| `{ items:[…], fetchedAt, stale:false }` | live quote | Use it; state the as-of time. |
| `{ items:[…], stale:true }` | served from cache after an upstream error | Use it but **say it's as-of `fetchedAt` and may be slightly delayed** — never present stale as live. |
| `{ unavailable: "…rate-limited…" }` | over budget / upstream 429 | Tell the user live quotes are momentarily rate-limited; do NOT guess a price. |
| `{ error: "…TWELVE_DATA_API_KEY…" }` (`needsKey`) | key missing | Say the quote feed isn't configured; don't invent. |
| `items:[]` (empty) | likely a bad/unknown ticker | Ask the user to confirm the symbol; offer the company name. |

The single worst failure in finance is a confident fabricated number. Every branch above has a
truthful answer that is **not** a made-up price.

---

## 3. The answer structure (mirror the runtime playbook exactly)

The runtime [`equity-analysis.md`](../../../../backend/finance/skills/equity-analysis.md) defines a
four-part shape. Use it verbatim so output is consistent whether the model loaded the skill or not:

```
<one-line summary>   price, today's move (± and %), headline reason if known — as of <time>

What's happening     2–4 bullets of the key drivers, each citing [n] from financeWebSearch

Context              valuation/sector framing in PLAIN ENGLISH (§4) — no price targets you can't source

Risks to watch       neutral, factual; the things a reader should monitor — not a recommendation

Not financial advice.
```

- **One-line summary** is the lede: "NVDA is at $X, up Y% today, after [reason] [n]. (as of HH:MM ET)."
  If you don't know the reason, say "the move is broad/market-wide" rather than inventing a catalyst.
- **What's happening** bullets are *reported facts with citations* — earnings beat, guidance cut,
  upgrade — each tied to `[n]`. If `financeWebSearch` returned nothing relevant, say so and keep this
  short; don't pad with generic company description.
- **Context** is the plain-English valuation/sector paragraph (§4). This is where amateurs leak
  advice ("looks cheap") — keep it descriptive, not prescriptive.
- **Risks to watch** are observable, neutral items (upcoming earnings date, sector cyclicality,
  regulatory overhang named in a source) — phrased as "watch for", never "this is why you should sell".

The whole answer is still wrapped by the route in `<ANSWER>…</ANSWER>` + a `<FOLLOW_UPS>` block
(the shared chat protocol — see `ai-sdk-finance-agent.md` §5); you write the body, the route frames it.

---

## 4. Framing valuation & the basics in plain English

You can explain *what the concepts mean* from general knowledge; you can only state *the specific
numbers* if a source gives them. Teach the reader the lens; quote the figure only when cited.

| Concept | Plain-English framing you can always use | The number — only if sourced |
|---------|------------------------------------------|------------------------------|
| **Market cap** | "Total value of all shares — roughly what the whole company is worth at today's price (price × shares)." Bucket it: mega-cap (>$200B), large (>$10B), mid, small. | Exact cap → `financeWebSearch` `[n]`, or derive qualitatively from the bucket. |
| **P/E ratio** | "How many dollars investors pay per dollar of annual earnings — a high P/E means the market expects strong growth (or the stock is expensive); a low P/E means modest expectations (or it's cheap/troubled). Only comparable **within a sector**." | The figure → cited source only; never from `getQuote`. |
| **Today's % change** | "How far the price moved vs. yesterday's close." | ✅ direct from `getQuote` (`percent`/`change`). |
| **Sector** | Name it and what drives it ("semiconductors — cyclical, tied to data-center/AI capex and inventory cycles"). | Peer multiples → cited only. |
| **Valuation, generally** | Describe the *tension* neutrally: "trades at a premium to the sector, which the market justifies by [growth/moat per source]; the risk is that premium compresses if growth slows." | Any multiple → cited. |

**Hard rule on price targets / fair value:** we own no valuation model and no consensus feed. If a
reputable source publishes an analyst target, you may report it *as that source's view* with `[n]`
("Analysts at [X] set a $N target [n]") — you may NEVER state a target as Lumina's own number or
synthesize one. "No price targets you can't source" is the literal line in the runtime playbook.

---

## 5. Common catalysts (what to search for, and how to phrase)

When the user asks *why*, these are the recurring movers. Use them to craft a focused
`financeWebSearch` query and to structure "What's happening".

| Catalyst | Search query shape | Neutral phrasing |
|----------|--------------------|--------------------|
| **Earnings** | `"<company> Q? earnings <year> beat miss revenue EPS"` | "Reported EPS of $X vs. $Y expected [n]; revenue [up/down] Z% [n]." |
| **Guidance** | `"<company> guidance outlook forecast raised cut"` | "Raised/cut next-quarter guidance, which the market read as [reaction] [n]." |
| **Analyst actions** | `"<company> analyst upgrade downgrade price target"` | "[Firm] upgraded/downgraded to [rating] [n]" — always attributed, never our view. |
| **Sector / macro move** | `"<sector> stocks today <rates|oil|AI|tariffs>"` | "Moving with the sector on [driver] [n] rather than company-specific news." |
| **Product / company event** | `"<company> launch lawsuit recall partnership acquisition"` | State the event + the market's reaction, cited. |
| **Index inclusion / splits / buybacks** | `"<company> S&P 500 inclusion stock split buyback"` | Factual, cited; explain the mechanical effect plainly. |

If the move is small or there's no clear catalyst, say "no single company-specific catalyst stands
out; the move tracks the broader market/sector" — that is a *complete, honest* answer, not a gap.

---

## 6. The strict no-advice contract (non-negotiable)

This is the hardest line in the persona (`FINANCE_PERSONA` in
[`backend/prompt.ts`](../../../../backend/prompt.ts)) and the runtime playbook. The agent is
**informational only**.

| ❌ Never | ✅ Instead |
|---------|-----------|
| "You should buy/sell/hold NVDA." | Describe the facts and let the reader decide; state drivers + risks neutrally. |
| "This is a good investment." / "It's a buy at this level." | "It trades at [described valuation]; bulls point to [sourced], bears to [sourced]." |
| "Given your portfolio / risk tolerance, you should…" | Decline personalized suitability: "I can't give personalized advice; here's the neutral picture." |
| "It will go to $X." (our own target) | Only report a *sourced* analyst target with `[n]`, framed as their view. |
| Omitting the disclaimer. | End EVERY equity answer with **"Not financial advice."** |
| Presenting a stale or guessed price as live. | State the as-of time; surface `stale`; say "rate-limited" on `unavailable`. |

Three behavioral guards back this up so it's hard to violate by accident:
1. The persona forbids buy/sell/hold and personalized suitability and mandates the closing line.
2. `withGuard` staples `_disclaimer: "Informational only — not financial advice."` onto every object
   tool result (see `ai-sdk-finance-agent.md` §3) — a belt-and-suspenders reminder in the model's
   context on every tool call.
3. The model's own closing "Not financial advice." is the user-visible contract.

Even **comparisons are descriptive, not directive**: "Compare AAPL and MSFT" → present both side by
side (price/move from `getQuote`, context from search) and let the facts stand; never conclude "MSFT
is the better buy."

---

## 7. Always state the as-of time (and surface staleness)

Every quoted number is a snapshot. The tool hands you `fetchedAt` (ISO) and `stale` — use both.

- **As-of:** "$X, up Y% (as of HH:MM ET)." A price without a timestamp implies it's live *now*,
  which it may not be (cache TTL on `getQuote` is 60s; markets may also be closed).
- **Stale:** if `stale:true`, say so — "as-of `fetchedAt`, may be slightly delayed (live feed was
  momentarily unavailable)". The cache serves stale-on-error rather than 500; honesty about it is the
  whole point of the field existing.
- **Market hours:** outside US trading hours the "price" is the last close. If the user implies
  intraday and it's after hours, note that the figure is the prior close.

---

## 8. Worked skeleton (what a grounded answer looks like)

```
User: "analyze NVDA — why is it up?"

[tool] getQuote({ symbols:["NVDA"] }) → { items:[{symbol:"NVDA", price:..., percent:+3.1, ...}],
                                          fetchedAt:"2026-06-21T14:32:00Z", stale:false }
[tool] financeWebSearch({ query:"NVIDIA stock today earnings guidance analyst" })
       → sources[1..3]

NVDA is at $XXX, up 3.1% today, after [headline reason] [1]. (as of 10:32 ET)

What's happening
- [driver 1] [1]
- [driver 2] [2]
- [sector tailwind] [3]

Context
NVIDIA is a mega-cap semiconductor name; the stock trades at a premium the market ties to
data-center/AI demand [2]. P/E and targets vary by source — [report only what [n] gives].

Risks to watch
- Next earnings on [date per source] — guidance is the swing factor.
- Semiconductor cyclicality and customer concentration.
- Premium valuation compresses if AI-capex growth slows.

Not financial advice.
```

Every number above traces to either `getQuote` (price/%, with as-of) or a `[n]` source. Nothing is
asserted that a tool didn't return — which is the entire job.

---

## 9. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Printing a P/E or market cap from "memory". | `getQuote` doesn't return it — source it via `financeWebSearch` `[n]` or speak qualitatively. |
| Inventing/synthesizing a price target. | Report only a *cited* analyst target as their view; never our own. |
| Any buy/sell/hold or "good investment for you". | Neutral facts + risks; decline personalized suitability; end "Not financial advice." |
| A price with no as-of time. | Always state `fetchedAt`; surface `stale`. |
| Guessing a price when the tool returns `unavailable`/`needsKey`. | Say it's rate-limited / not configured; never fabricate. |
| Using `getQuote` for a crypto/index/non-US name. | Wrong tool — `getCrypto`/`getIndices`; `getQuote`'s description scopes it to US equities/ETFs. |
| Spending a `financeWebSearch` credit on a bare price question. | One-tool answer; search only when the question needs news/context. |
| Padding "What's happening" when search found nothing. | Say "no single catalyst; tracks the sector/market" — a complete honest answer. |
| Concluding "X is the better buy" in a comparison. | Present both neutrally; let the facts stand. |
| Republishing a news article's text as the answer. | Transformative synthesis in your own prose + `[n]` link-outs (see `llm-market-narratives.md`). |

---

## 10. Definition of done

An equity-analysis answer is correct when:
1. It opens with a one-line summary anchored by a **real, sourced price + as-of time**.
2. "What's happening" bullets each cite `[n]` from `financeWebSearch` (or the answer honestly states
   no catalyst was found).
3. "Context" frames valuation/sector in plain English with **no uncited numbers and no price target**
   we can't source.
4. "Risks to watch" are neutral and factual — observation, not recommendation.
5. There is **zero** buy/sell/hold language and **zero** personalized suitability.
6. `stale`/`unavailable`/`needsKey` were handled truthfully — no fabricated number anywhere.
7. It ends with **"Not financial advice."**

If you changed the runtime playbook, the four-part shape and the no-advice line in
[`backend/finance/skills/equity-analysis.md`](../../../../backend/finance/skills/equity-analysis.md)
still match this contract.
