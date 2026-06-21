# Data Licensing & Compliance — the `commercialOk` gate

> The legal half of the Finance vertical: WHY every free-tier series ships with
> `commercialOk:false`, what it would actually cost (and which license) to flip each one true, and
> the transformative-synthesis rule that keeps the AI news surfaces clean. Read this before adding a
> provider, before a public launch, or whenever you touch a `Provenance`. Pair with
> `market-data-providers.md` (what each provider *can do*) and `lumina-finance-architecture.md`
> (where the provenance flows).

The governing rule, in one sentence: **a free API tier is permission to fetch, not permission to
display.** Use rights, display rights, and redistribution rights are three different grants that
vendors deliberately conflate in their pricing pages. Lumina encodes the verdict as one boolean on
every payload so it can never get lost.

---

## 1. The `Provenance` type — the hard gate at ingest

Every fetcher in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) returns
data **plus** a `Provenance`. The type (top of the file) is the whole compliance system:

```ts
export type Provenance = {
  source: string;          // who published it — rendered in the UI
  commercialOk: boolean;   // the hard gate: false = NOT cleared for public display
  attribution: string;     // the verbatim credit line
  unit?: "USD" | "mana";   // prediction-market volume unit
};
```

`commercialOk` is not advisory. It is the single field an auditor (or you, pre-launch) greps to
answer "is anything on this page un-cleared?" The file header says it plainly: *"a `false` series is
fine to build and demo with, but must be treated as not-cleared-for-public-display."* Provenance and
data land on the **same** return value — there is no code path that produces a number without its
license verdict attached. That co-location is the moat: retrofitting lineage onto thousands of
already-rendered numbers is effectively impossible, so it is written at the source or not at all.

### Every `commercialOk:false` default in the codebase (and why)

| Provenance helper / site | `source` | `commercialOk` | Why it's false | Flip-true condition |
|---|---|---|---|---|
| `cgProvenance()` | CoinGecko | **false** | Demo tier = personal use only | CoinGecko **Basic ~$35/mo** + set `COINGECKO_API_KEY` |
| `tdProvenance()` | Twelve Data | **false** | Free tier, no display grant | Paid display tier from Twelve Data |
| `fetchIndices` / `fetchSectors` / `fetchStocks(in)` | Yahoo Finance | **false** | Unofficial/undocumented endpoint, no license at all | Never (no license to buy) — replace with a licensed feed for display |
| `fetchPredictions` (primary) | Polymarket | **false** | Public Gamma API, display ToS unconfirmed | Written commercial-display confirmation from Polymarket |
| `fetchPredictions` (fallback) | Manifold Markets | **false** | Same — confirm display terms | Written confirmation from Manifold |
| `fetchMarketSummary` | "Tavily + AI" | **false** | See §6 — own prose is clean, but be conservative until reviewed | Legal sign-off on the synthesis surface |
| `fetchDiscover(us)` | Finnhub | **false** | Free `/news` = personal/non-commercial | Written display clearance or paid plan from Finnhub |
| `fetchDiscoverIndiaNewsData` | NewsData.io | **false** | Free tier, no commercial display grant | Paid NewsData.io plan |
| `fetchDiscoverIndiaTavily` | Tavily (India news) | **false** | Tavily grants no rights in returned content | (discovery tool — keep link-out only) |

There is **no `commercialOk:true` anywhere in the Finance vertical today.** That is correct: every
current Finance source is a free tier or an unlicensed endpoint. (The only `commercialOk:true` in the
whole repo is OpenAlex in the *Academic Discover* vertical — `backend/discover/academic.ts` — because
OpenAlex data is CC0; that is a different vertical, not Finance.) The day one flips to true must be the day a real
license is in hand — and the flip should be the *only* change, because the gate already threads to
the UI.

---

## 2. The free-tier display trap (the trap this whole doc exists to prevent)

A vendor's "free" tier is engineered to get you building. The moment you put that data on a public
page you have crossed from *use* into *display* — a separately-priced right the free tier never
granted. The failure mode is invisible in a demo and a cease-and-desist at scale.

**CoinGecko is the canonical example, and it's documented inline** in `sources.ts` (`cgProvenance`
and the file header): the free **Demo** endpoint is **PERSONAL USE only**. To display CoinGecko data
publicly you need **Basic (~$35/mo)**. The header spells out the exact remediation:

> Buy CoinGecko Basic (~$35/mo) and set `COINGECKO_API_KEY` to display publicly; then flip
> `commercialOk=true`.

The same shape applies to Twelve Data, Finnhub, NewsData.io — every free tier in the table above.
"It works without paying" is the bait; the personal-use clause in the ToS is the hook.

> **Anti-pattern → do instead** (the core lesson):

| Anti-pattern | Why it bites | Do instead |
|---|---|---|
| "The free key works, ship it" | Free = personal use; public display is a paid right | Build on free, gate display behind `commercialOk`, buy the license before launch |
| Hardcode `commercialOk:true` to silence a badge | The gate is now lying; an audit can't trust any row | Leave it `false` until the license exists; fix the UI to handle `false` gracefully |
| Assume one paid plan covers all rights | Use ≠ display ≠ redistribute ≠ AI-train | Confirm the *specific* right (public display) is in the tier you bought |
| Scrape an unofficial endpoint and call it "free" | No license exists to grant *any* display right (Yahoo) | Treat as demo-only forever; swap to a licensed feed for production display |

---

## 3. Exchange licensing reality (why "real-time" is a six-figure word)

Prices originate at exchanges, and exchanges charge for redistribution and for **public display** —
often per displaying user. This is upstream of every quote vendor.

- **India (NSE/BSE):** real-time public display of NSE/BSE data is a **six-figure-INR/yr exchange
  license**, and NSE is litigious about redistribution. This is exactly why
  [`fetchStocks(in)`](../../../../backend/finance/sources.ts) and `fetchIndices(in)` ride the keyless
  Yahoo path with attribution strings that say **"(delayed)"** — e.g. `"India index data via Yahoo
  Finance (delayed)"` — and stay `commercialOk:false`. India watchlist symbols use `.NS`/`.BO` Yahoo
  tickers precisely because Twelve Data's free tier excludes NSE/BSE; there is no cheap real-time
  India path.
- **US (NASDAQ/NYSE/CBOE):** these exchanges levy **per-user fees** for real-time displayed data.
  This is why the production spine (FMP, §5) defaults to **15-minute delayed** — delayed data bounds
  or eliminates the per-user exchange fee. Real-time displayed US equities is a deliberate, costed
  upgrade, never a default.

**Default to 15-minute delayed.** Delayed data is dramatically cheaper to license for display and is
the standard for a consumer markets surface. Reserve real-time for the live-tick lane (Finnhub
WebSocket in `worker/`, which streams crypto 24/7 plus the US watchlist stocks during market hours —
see `lumina-finance-architecture.md`), and
label everything honestly: the India attribution strings already do this.

---

## 4. Yahoo — the unlicensed endpoint (a special, permanent `false`)

Yahoo's `v8/finance/chart` is the workhorse for indices, India, and sparklines, but it is
**unofficial and undocumented** — there is no terms-of-service path to a commercial display license
for it. Every Yahoo-backed payload (`fetchIndices`, `fetchSectors`, `fetchStocks(in)`,
`fetchYahooQuote`) hardcodes `commercialOk:false`, and unlike CoinGecko there is **no "flip true"
condition** — you cannot buy what isn't sold. For a real public launch the Yahoo lane must be
*replaced* by a licensed feed (FMP commercial display for US; a licensed delayed India feed for IN),
not upgraded in place. Treat Yahoo as demo/dev-grade ground truth, never as the production source of
displayed numbers.

---

## 5. FMP — self-serve tiers FORBID public display (the Tier-2 wall)

FMP (Financial Modeling Prep) is the eventual commercial-display spine — the planned licensed
source for core equities/index/sector data once Lumina launches publicly. It is **not wired into the
codebase today** (no FMP fetcher exists in `backend/finance/`). But there is a sharp trap:

- FMP's **self-serve tiers ($0–$99)** explicitly **FORBID public display** under their ToS
  (**§2.2.1 / §2.2.2**). Buying the $99 self-serve plan does **not** buy you the right to render FMP
  numbers on a public page.
- Public US-equity display requires FMP's **separately sales-quoted commercial Data Display
  license** — a different contract, negotiated with their sales team, that prices in the downstream
  exchange per-user fees (which is why you default to 15-min delayed to bound them).

So FMP is **Tier-2** — deferred until there is budget and a sales conversation. Until then the US
watchlist stays on Twelve Data (free, `commercialOk:false`) and indices on Yahoo. Do **not** wire FMP
self-serve into a display surface thinking the paid tier clears it; the ToS sections above say
otherwise. This is the single most expensive misread on this whole list.

---

## 6. Macro & fundamentals — public-domain primaries only (FRED is the trap)

For macro/fundamentals (rates, CPI, GDP, fiscal, filings — a future surface), the rule inverts: pull
displayable data from **public-domain primary sources**, never from convenient aggregators that
redistribute proprietary series.

| Use for display (GREEN) | Why | Do NOT display from |
|---|---|---|
| **US Treasury Fiscal Data** | US public domain | — |
| **BLS** (CPI, jobs) | US public domain | — |
| **BEA** (GDP) | US public domain | — |
| **World Bank** | CC BY 4.0 (attribute) | — |
| **SEC EDGAR** (filings) | US public domain; needs descriptive `User-Agent`, ~10 req/s | — |
| **FRED** | **discovery only** | **FRED *content*** — 2024 terms ban redistribution |

**The FRED trap:** FRED is wonderful for *finding* a series ID, but its 2024 terms forbid
redistributing the data, and many FRED series are proprietary (S&P, VIX/CBOE, ICE). Use FRED to
discover the series ID, then pull the same series from its **primary** source (BLS, BEA, Treasury,
ECB, Fed) and display that. Never redistribute S&P/VIX/ICE series through FRED. The macro research
surface (`research.ts`) sidesteps this entirely by synthesizing prose rather than republishing data
series — see next section.

---

## 7. The transformative multi-source synthesis rule (news & research)

Lumina has three AI/news surfaces — Discover, Market Summary, Global Research — and they are
**legally clean by construction**, not by license. The principle:

> **Synthesize across ≥3 independent sources into your OWN original prose, then link out to the
> sources. Never republish any single source's text, lede, or body.**

This is the Google-News / Perplexity-Discover model. The two failure modes it avoids are named in
the code: **AP v. Meltwater** (copying a publisher's lede = infringement) and **News Corp v.
Perplexity** (full-text reproduction is the wrong; the card *format* is fine).

### How each surface enforces it

- **Discover** ([`backend/finance/news.ts`](../../../../backend/finance/news.ts)) — the file header is
  the policy: expose **ONLY** headline + source + outbound link + (hotlinked) image + timestamp. The
  publisher's `summary`/body text is **deliberately dropped and never displayed** — see the explicit
  `// NOTE: a.summary (publisher text) intentionally NOT included` in `fetchDiscover` and the matching
  comment in `fetchDiscoverIndiaTavily`. Images are **hotlinked, never re-hosted** (`fetchOgImage`
  pulls the publisher's own `og:image`). Cards link OUT to the canonical publisher URL.
- **Market Summary** ([`backend/finance/summary.ts`](../../../../backend/finance/summary.ts)) — Tavily
  gathers fresh stories → `generateObject` (Haiku) writes **new** headline+body items grounded in the
  snippets. The prompt enforces *"Do NOT invent anything not supported by the snippets"* and the
  payload keeps a short ≤240-char snippet **only for the sources drawer**, not as displayed body.
- **Global Research** ([`backend/finance/research.ts`](../../../../backend/finance/research.ts)) — the
  flagship of the pattern. The file header names it: *"transformative multi-source synthesis."* Tavily
  pulls ≥3 sources per category → `generateObject` (Sonnet) writes an ORIGINAL note. The prompt is the
  legal guardrail, verbatim: *"do NOT reproduce any single source's wording and do NOT summarize just
  one article — synthesize across multiple sources."* Sources are attached and linked out.

> **Anti-pattern → do instead** (news/synthesis):

| Anti-pattern | Why it bites | Do instead |
|---|---|---|
| Display the publisher's summary/lede on the card | AP v. Meltwater — copying the lede infringes | Headline + link only; drop `summary` (Discover already does) |
| Re-host the article image on your CDN | Reproduction of a copyrighted asset | Hotlink the publisher's `og:image`; placeholder if blocked |
| LLM summarizes ONE article | A close paraphrase is a derivative work | Synthesize ≥3 sources into original analysis + cite all |
| In-app iframe of the article | Effectively republishing the body | Open the canonical URL in a new tab |
| Treat Tavily results as licensed content | Tavily grants no rights in returned text/images | Discovery + link-out only |

---

## 8. Attribution strings — the visible half of the gate

`commercialOk` is the gate; `attribution` is the credit line rendered under the data. Even a
`false`/demo series carries one — it's how you stay honest while building. Live examples from the
code:

| Source | `attribution` string |
|---|---|
| CoinGecko | `"Data provided by CoinGecko"` |
| Twelve Data | `"Stock quotes by Twelve Data"` |
| Yahoo (US) | `"Index data via Yahoo Finance"` |
| Yahoo (India) | `"India index data via Yahoo Finance (delayed)"` |
| Polymarket | `"Prediction market data from Polymarket"` (unit `"USD"`) |
| Manifold | `"Prediction market data from Manifold Markets"` (unit `"mana"`) |
| Finnhub news | `"News via Finnhub — headlines link to publishers"` |
| Tavily/AI summary | `"AI summary of web sources"` |

Rules: render the string **verbatim** under every chart/card; for India sources keep the **(delayed)**
qualifier (it is the truthful exchange-license disclosure from §3); for CC BY sources (World Bank,
macro) the attribution is **mandatory** — omitting it is a license breach, not a stylistic choice.

---

## 9. The GREEN / YELLOW / RED decision table

Classify every source before it enters the pipeline. When unsure, treat as RED — the cost of
over-classifying is a citation; the cost of under-classifying is a lawsuit.

| Tier | Meaning | Rights | Lumina sources |
|---|---|---|---|
| 🟢 **GREEN** | Public domain / CC0 / CC BY | Use + display + (usually) redistribute; attribute if CC BY | SEC EDGAR, US Treasury, BLS, BEA, World Bank (macro, future) |
| 🟡 **YELLOW** | Free-with-conditions, or a **paid** display tier you bought | Display **only** within the purchased tier/seat scope | CoinGecko **Basic**, FMP **commercial Data Display license**, a licensed delayed exchange feed (all future/Tier-2) |
| 🔴 **RED** | Free API tiers, unlicensed endpoints, news publishers, FRED content | **Link + cite only.** Never display the data/text | **Everything shipping today:** CoinGecko Demo, Twelve Data free, Yahoo, Finnhub free, NewsData free, Polymarket/Manifold (unconfirmed), all news bodies, FRED content |

The mapping is mechanical: **`commercialOk:true` ⇔ GREEN or a purchased YELLOW tier. Everything else
is RED and ships with `commercialOk:false`.** Today the entire Finance vertical is RED-for-display
(the lone repo-wide GREEN exception, OpenAlex/CC0, lives in the separate Academic Discover vertical)
and GREEN-for-demo — which is the honest state of a product built on free tiers, correctly encoded.

---

## 10. Before public launch — the checklist

Run this before flipping ANY `commercialOk` to true or putting the Finance tab in front of the
public. Each row is a contract to acquire or a code change to make.

- [ ] **Crypto:** buy CoinGecko **Basic (~$35/mo)**, set `COINGECKO_API_KEY`, flip `cgProvenance()`
      to `commercialOk:true`. Until then, crypto is demo-only.
- [ ] **US equities:** negotiate FMP's **commercial Data Display license** (NOT a self-serve tier —
      §2.2.1/2.2.2 forbid display), migrate the US watchlist off Twelve Data, default to **15-min
      delayed** to bound NASDAQ/NYSE/CBOE per-user fees, then flip.
- [ ] **Indices / sectors / India / sparklines (Yahoo):** Yahoo has **no buyable license** — replace
      it with a licensed delayed feed before display. This is a swap, not a flip.
- [ ] **India real-time:** do **not** attempt real-time NSE/BSE display (six-figure ₹/yr, NSE
      litigious). Keep the **(delayed)** Yahoo lane labeled honestly, or license a delayed India feed.
- [ ] **News (Discover):** email Finnhub for **written display clearance** (or buy a paid plan); for
      India, a NewsData.io paid plan. Confirm the card stays headline+link+hotlinked-image only.
- [ ] **Predictions:** obtain written confirmation of commercial-display terms from Polymarket and
      Manifold; until then keep `commercialOk:false`.
- [ ] **Macro (when built):** wire only public-domain primaries (Treasury/BLS/BEA/World Bank/EDGAR);
      use FRED for series-ID discovery **only**; never redistribute S&P/VIX/ICE via FRED.
- [ ] **Synthesis surfaces:** confirm Discover drops `summary`, Research/Summary prompts still forbid
      single-source reproduction, images are hotlinked not re-hosted, links open the canonical URL.
- [ ] **Attribution:** every displayed series renders its `attribution` verbatim; CC BY strings
      present; India strings keep **(delayed)**.
- [ ] **Audit:** grep for `commercialOk: true` and confirm a license exists for **each** one. A
      `true` without a contract is the bug this whole doc prevents.

---

> **Cross-repo prior art:** the canonical GREEN/YELLOW/RED list and the provenance-at-ingest moat
> live in fintech-webapp's `research-data-sourcing/references/licensing-tiers.md`. Lumina's
> `Provenance` type is the Express/Prisma translation of that repo's four-field
> (`source`/`license`/`attribution_string`/`commercial_ok`) provenance record — same gate, same
> discipline: the license verdict and the data land on one write, or neither does.
