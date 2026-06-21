# Crypto News & Sentiment — sourcing, signals, and the republish line

> How to source crypto news, read sentiment and on-chain signals, and present them **legally** and
> **neutrally** — without republishing a provider's text or dressing a vibe up as a fact. This is a
> **generic-domain** ref (reusable knowledge); it cites our code only where Lumina already does the
> thing. For the *plumbing* of the search tool that fetches this news read finance
> `data-licensing-and-compliance.md` (the licensing gate) and `market-data-providers.md` (Tavily +
> the vendors); for sibling crypto refs see `crypto-volatility-and-risk.md` (how risk is framed) and
> `crypto-safety-and-disclaimers.md` (the never-advice / scam framing this ref leans on).

Grounded in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts) (`financeWebSearch`)
and `FINANCE_PERSONA` in [`backend/prompt.ts`](../../../../backend/prompt.ts).

---

## 1. The three signal families (don't conflate them)

Crypto "what's happening" splits into three kinds of evidence with **different reliability, latency,
and licensing**. A good answer names which kind it is using; a bad one blends a tweet, a price tick,
and a wallet flow into one confident sentence.

| Family | What it is | Latency | How hard / scarce | Trust caveat |
|--------|-----------|---------|-------------------|--------------|
| **News** | Editorial/reported events (exchange listing, hack, ETF approval, regulation, protocol upgrade) | minutes–hours | Easy via web search; **licensed** | Can be wrong, PR-spun, or paid placement |
| **Sentiment** | Crowd mood — social volume, fear/greed, funding-rate skew, options put/call | seconds–minutes | Mixed; many indices are gated | Reflexive & manipulable; a *lagging crowd*, not a forecast |
| **On-chain** | Settled blockchain facts — flows, balances, contract events, TVL | seconds (and **final**) | Free to read, hard to *interpret* | Facts are real; the *narrative* you attach is the risky part |

**The hierarchy of certainty:** on-chain facts > reported news > sentiment. On-chain says *what
provably happened*; news says *what someone reports happened*; sentiment says *how people feel about
it*. When they disagree, say so — "social is euphoric but exchange inflows are rising (often a
distribution signal)" is a far better answer than picking one and asserting it.

---

## 2. Sourcing crypto news — the Lumina path

Lumina does **not** ingest a crypto news API. It searches the web with Tavily and the model
**synthesizes** in its own prose with `[n]` link-out citations. The agent tool is `financeWebSearch`
in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts):

```ts
// financeWebSearch — the ONLY crypto-news ingest path for the finance/crypto agent.
const resp = await tvly.search(query, {
  searchDepth: "basic",
  topic: "news",   // ← news-domain bias: editorial sources, recency-ranked
  days: 7,          // ← recency window; crypto news decays fast — keep it tight
  maxResults: 6,
});
// each result → { title, url, content: content.slice(0, 800) }  // SNIPPET only, never full text
// pushed to the shared sources[] and handed back as GLOBAL [n] so inline cites match <SOURCES>
```

Why this shape matters for crypto specifically:

| Knob | Value | Crypto reason |
|------|-------|---------------|
| `topic: "news"` | news-domain bias | Pulls reported events, not SEO/affiliate "best coins to buy" spam |
| `days: 7` | 1-week window | Crypto narratives rotate weekly; a 30-day window dilutes a fast-moving query. Tighten to `days:1`/`2` for "today"/"this week" questions |
| `content.slice(0, 800)` | snippet cap | You ingest a **snippet for grounding**, not the article — the licensing safety valve (see §4) |
| `maxResults: 6` | small fan-out | Enough to triangulate across outlets; cheap on the Tavily budget |
| budget `10/min` | per-call (uncached) | Every search spends a real Tavily credit, so it is **not** cached and the budget is checked per call — unlike price tools |

**Crypto-news query craft.** The model writes the query; nudge it (via persona / runtime skill) to:
- Include the **coin id or full name AND ticker** ("Solana SOL outage", not "SOL") — tickers collide
  and SEO spam games bare tickers.
- Append the **event type** ("ETF", "hack", "depeg", "unlock", "upgrade", "SEC") to bias toward the
  reported event over price-chatter pages.
- For breaking incidents, prefer **primary sources** in the synthesis — the protocol's own status
  page / post-mortem, the exchange announcement, the regulator's filing — over aggregators.

---

## 3. Sentiment & on-chain signals — what they mean (and what they don't)

### 3a. Sentiment signals — the crowd is a contrarian indicator more often than a leading one

| Signal | Reads as | Free? | Trap |
|--------|----------|-------|------|
| **Fear & Greed Index** (alternative.me) | 0–100 composite (volatility, momentum, social, dominance) | Yes, free API | A *summary of the past*, not a forecast; extremes mean-revert |
| **Funding rate** (perp futures) | Positive = longs pay shorts = bullish leverage skew | Per-exchange APIs | High positive funding = crowded longs = squeeze risk, not "going up" |
| **Open interest** | Total leveraged positions outstanding | Exchange APIs | Rising OI + flat price = building tension, direction unknown |
| **Social volume / dominance** | Mentions, trend share | Mostly gated (LunarCrush etc.) | Bots & shills inflate it; volume ≠ conviction |
| **Long/short ratio** | Crowd positioning | Exchange APIs | The crowd is usually wrong at extremes |

**The reflexivity rule:** sentiment is *priced in the moment it is measured*. "Greed is high" does
not predict up; historically extreme greed precedes pullbacks and extreme fear precedes bounces — but
"often mean-reverts" is the honest claim, never "so it will fall." Present sentiment as **a
mechanism and a state**, never as a directional call (that would be advice — see §6).

### 3b. On-chain signals — settled facts, contested narratives

On-chain data is the one family that is **free to read and provably true**. Anyone can query a block
explorer; the facts are final once confirmed. What is *not* free is correct interpretation.

| Signal | Provably means | Free source | Don't over-read |
|--------|----------------|-------------|------------------|
| **Exchange inflows** | Coins moved *to* exchange wallets | Explorers / DefiLlama / Nansen (gated for labels) | Often distribution (selling) — but could be liquidity provisioning |
| **Exchange outflows** | Coins moved *off* exchanges | same | Often accumulation/self-custody — but could be a new cold wallet |
| **Whale transfers** | A large address moved funds | Explorer + address labels | A transfer ≠ a sale; could be internal, OTC, or custody migration |
| **Active addresses** | Distinct addresses transacting | Explorer aggregates | One user = many addresses; bots inflate it |
| **TVL** (DeFi) | $ locked in a protocol's contracts | **DefiLlama (free)** | TVL ↑ from token-price ↑ ≠ real new deposits; double-counting across chains |
| **Token unlocks** | Scheduled vesting hits circulating supply | Vesting schedules / unlock trackers | A known supply overhang — a *neutral risk to flag*, not a prediction |
| **Stablecoin supply** | Mint/burn = capital entering/leaving crypto | Issuer APIs / explorers | Mints can be for OTC, not spot buying |

**Free on-chain reality (cross-ref `onchain-and-wallets.md`):** raw chain reads (a block explorer, a
public RPC, DefiLlama for TVL) are free. *Labeled* analytics — "this is Binance's hot wallet,"
whale-watching dashboards, entity attribution (Nansen, Glassnode tiers, Arkham) — are the paid layer,
and **their derived datasets carry their own license** exactly like a news article does (§4).

**The address-labeling caveat that trips everyone up:** "a whale moved 10,000 BTC to Binance" is two
claims — the *transfer* (an on-chain fact) and the *label* "Binance" (an attribution that can be
wrong or stale). State the fact with certainty; attribute the label with hedging ("an address
labeled as a Binance deposit wallet").

---

## 4. The licensing line — transformative synthesis, not republication

This is the **same rule** as Lumina's finance news licensing — read finance
`data-licensing-and-compliance.md` for the full treatment; this is the crypto-specific application.

**The rule:** you may **read** licensed news (via the snippet your search returns) to *inform* an
answer, and you may **link out** to it. You may **not** reproduce the article's text, paraphrase it
sentence-by-sentence, or present a single source's reporting as your own feed. A free Tavily result
is **access for grounding**, not a **redistribution license** — the same trap as a free market-data
tier being build-and-demo-only (`commercialOk:false`).

| Test | Republication (❌ illegal/risky) | Transformative synthesis (✅) |
|------|----------------------------------|------------------------------|
| Whose words? | The provider's, copied/lightly reworded | **Your own prose** |
| How many sources? | One, reproduced | **Multiple, triangulated** |
| What's the value-add? | None — you're a mirror | Comparison, context, what changed, why it matters |
| Where does the reader go for the original? | Nowhere — you replaced it | **Link-out `[n]` citation to the source** |
| Could you publish it commercially? | No | Yes — it's new editorial work |

Lumina's design enforces this structurally: `financeWebSearch` only ever holds an **800-char
snippet** (not the article), the model is instructed to write its own synthesis, and every claim
carries a numbered link-out so the original publisher gets the click. **Do not** widen the snippet to
swallow whole articles, **do not** cache article bodies, and **do not** build a "crypto news feed"
that lists provider headlines+blurbs verbatim — that's republication wearing a UI.

**On-chain & TVL licensing:** raw chain facts are not copyrightable (they're facts), so on-chain
*numbers* are safe to display **with attribution to where you read them** ("TVL via DefiLlama"). But
a vendor's *derived/labeled dataset* (Nansen Smart-Money flows, Glassnode metrics) is licensed IP —
treat it like news: cite/link, don't redistribute the dataset.

---

## 5. Decision framework — which signal answers the question?

```
Crypto "what's going on / why did X move" query
|
+-- Needs a price/level/mcap? ---------------------> getCrypto tool (NOT news). State source + as-of.
|
+-- "Why did it move / what happened?" ------------> financeWebSearch (topic:news, days:7),
|     (an event, an announcement, a hack)            synthesize in own prose, [n] link-outs.
|
+-- "Is the crowd bullish/bearish?" ---------------> SENTIMENT: name the index (Fear&Greed/funding),
|                                                     present as a STATE + mean-reversion mechanism,
|                                                     never as a directional call.
|
+-- "Are whales/holders buying/selling?" ----------> ON-CHAIN: flows/whale transfers, but separate
|                                                     the FACT (transfer) from the LABEL/intent.
|
+-- "How much money is in this DeFi protocol?" ----> ON-CHAIN TVL via DefiLlama (free), attributed.
|     (see defi-concepts.md)
|
+-- "What's the narrative this week?" -------------> SYNTHESIS across news + sentiment + on-chain,
      (a soft, multi-signal question)                explicitly labeling each family and conflicts.
```

**Multi-signal answers are the high bar.** The best crypto answer triangulates: *"BTC is down 6%
[getCrypto, as-of …]. Reporting attributes it to a hawkish CPI print [1][2]. On-chain, exchange
inflows rose this week (often a distribution signal), while social sentiment stays in 'greed' —
those diverge, which historically resolves toward the on-chain signal but is not a guarantee."* —
names every family, cites the news, hedges the inference.

---

## 6. Neutrality & honesty contract (the crypto twist on the persona)

The finance persona already forbids advice and fabrication; news/sentiment add **three failure modes
specific to soft signals**:

1. **Sentiment ≠ prediction.** "Fear is extreme" is a measurement of *now*. Never chain it to "so
   it will bounce." State the historical tendency + that it's not a guarantee. A directional call
   from sentiment is **advice** — banned.
2. **Headline ≠ confirmed.** Crypto news is full of unconfirmed reports, PR, and outright fakes
   (fake ETF approvals, fake partnerships have moved markets). Attribute (`"according to [n]"`),
   hedge ("reportedly", "unconfirmed"), and prefer primary sources. Never state a rumor as fact.
3. **On-chain fact ≠ intent.** A transfer is a fact; "whale dumping" is an inference. Keep them
   separate. "Listed on CoinGecko / has news coverage" is **not** legitimacy — coverage ≠ safety
   (see `crypto-safety-and-disclaimers.md`).

All of this is enforced downstream too: every object tool result gets `_disclaimer: "Informational
only — not financial advice."` stapled on by `withGuard` in
[`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts), and finance prose ends with "Not
financial advice." Surface `stale`/`fetchedAt` on anything time-sensitive — crypto sentiment and
prices both decay in seconds, and the finance vertical deliberately **skips the semantic cache** for
time-sensitive queries.

---

## 7. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Building a crypto "news feed" that lists provider headlines + blurbs verbatim. | Synthesize across sources in your own prose + `[n]` link-outs. A verbatim feed is republication (§4). |
| Widening the `financeWebSearch` snippet (or caching article bodies) to capture full articles. | Keep the 800-char snippet for grounding only; the article stays at the publisher. |
| "Fear & Greed is at 15, so it'll bounce." | "Sentiment is in extreme fear; historically that mean-reverts, but it's a state of the crowd, not a forecast." |
| Treating a tweet / unconfirmed headline as a fact. | Attribute + hedge ("reportedly", "unconfirmed [n]"); prefer the primary source (status page, filing, exchange notice). |
| "A whale dumped 10k BTC on Binance" (fact + label + intent fused). | Split it: the transfer is on-chain fact; "Binance" is an address *label*; "dump" is an *inference* — hedge the last two. |
| Reading TVL ↑ as "real money flowing in." | TVL can rise purely from the locked token's price rising; distinguish price-driven from deposit-driven, attribute to DefiLlama. |
| Quoting a paid analytics vendor's labeled dataset (Nansen/Glassnode) as free public fact. | That's licensed derived IP — cite/link, don't redistribute the dataset; raw chain facts are the free layer. |
| Mixing news, sentiment, and on-chain into one confident sentence. | Label each family; when they conflict, say so and weight on-chain facts > news > sentiment. |
| Using a bare ticker in the search query ("SOL"). | Use full name + ticker + event type ("Solana SOL outage"); bare tickers pull SEO/affiliate spam and collide. |
| Caching a sentiment reading or serving a stale one as live. | Time-sensitive → skip the semantic cache; pass through `stale`/`fetchedAt` honestly. |

---

## 8. Free signal sources cheat-sheet

For when you need a *named* free source (the non-negotiable: never fabricate a number — source it).

| Need | Free source | Note |
|------|-------------|------|
| Crypto news (events) | **Tavily `topic:news`** (already wired as `financeWebSearch`) | Snippet + link-out only |
| Fear & Greed | **alternative.me** API | Free, no key; a *composite of past data* |
| TVL (DeFi) | **DefiLlama** | Free, no key; the standard for TVL — attribute it |
| Raw on-chain facts | **Block explorers / public RPC** | Free reads; you interpret. See `onchain-and-wallets.md` |
| Funding / OI / long-short | **Exchange public APIs** (Binance, Bybit, etc.) | Per-exchange; rate-limited |
| Stablecoin supply | Issuer transparency pages / explorer | Mint/burn = capital flow proxy |

Anything beyond this — labeled whale flows, smart-money tags, social-volume indices — is the **paid
analytics tier**, with its own license. Treat its derived data like news: cite and link, never
redistribute.

---

## 9. Quick reference — done when

A crypto news/sentiment answer is **done** when:
1. Each claim is tagged to its **family** (news / sentiment / on-chain) and the families' reliability
   ordering is respected when they conflict.
2. News is **synthesized** in your own prose with `[n]` link-out citations — no verbatim article text,
   no single-source feed, no cached article bodies (§4).
3. Sentiment is presented as a **state + mechanism**, never a directional call.
4. On-chain claims separate the **fact** (transfer/flow) from the **label/intent** (inference).
5. Every number is **sourced** (a tool or a named free API) with source + **as-of time**; `stale`
   surfaced; nothing fabricated.
6. Paid/derived datasets are cited, not redistributed; free chain facts are attributed (e.g. "TVL via
   DefiLlama").
7. The not-advice disclaimer is present (the agent path staples it via `withGuard`).
