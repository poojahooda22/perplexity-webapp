# Insights — R70 Negation Loop + Competitive Research Findings

> Produced 2026-06-23 by the `insights-negation-and-research` workflow (9 research agents + 3 independent
> R70 negators + adversarial licensing-verify), synthesized by the lead. The negation **verdict: all 3
> negators returned `PROVED_JUNIOR`** — the Insights feature did not survive a full R70 round. Companion to
> [`market-insights-blueprint.md`](market-insights-blueprint.md) and the rule
> [`.claude/rules/red-team-negation-loop.md`](../.claude/rules/red-team-negation-loop.md).

## Verdict in one line

The Insights tab is **5 dials, 3 of which are the same Treasury-spread number in different costumes**, fronted
by a briefing that **publicly renders RED Yahoo data under a banner claiming "built only from public-domain
data"** while the **"never invent a number" and "no-advice" runtime guards are dead code**. The one surface
that survived is **Recession Risk**. The fix is a pivot from *opinion dials* to *primary-source event
intelligence* (SEC EDGAR filings — IPOs, insider trades, 8-Ks, earnings — + the economic calendar), every
number tappable to its gov source.

## Part 1 — Per-surface verdict (KEEP / FIX / CUT)

| Surface | Verdict | The biggest finding against it (file-cited) |
|---|---|---|
| **Recession Risk** | **KEEP** (3/3) | Estrella–Mishkin coeffs (−0.5333/−0.6629) verified correct; Treasury+BLS GREEN; honest false-positive caveat. *The one surface with genuine decision value + clean licensing.* Minor: Sahm `low12` window includes the current bar (`sentiment-sources.ts:136-141`) → biases the trigger; fix to "prior 12 months excluding current" per FRED SAHMREALTIME. |
| **Daily Briefing** | **FIX** | Strong shell, but (a) renders Yahoo (RED) cross-asset levels with no `commercialOk` gate (`briefing.ts:110-123`, `finance-view.tsx:1592-1602`); (b) the no-advice + numeric guards are `console.warn`, not enforcement (`briefing.ts:240-244`); (c) catalyst **dates** are LLM-recalled, not from a GREEN calendar = a never-invent-a-number leak. |
| **Market Mood** | **FIX / RENAME** | 2 of 3 equal-weight legs (recession probit + yield curve) are deterministic transforms of the **same 10y-3m spread** (`sentiment-sources.ts:316-329`) → ~⅔ weight on one slow macro number; shares **zero** of CNN Fear&Greed's 7 inputs yet wears that dial; denominator silently shifts 3→2 legs when GDELT times out (`:307-337`). |
| **Bull/Bear Buzz** | **FIX** | `score = z*40` and label cutoffs ±15/±50 are undocumented magic numbers (`:245-246`, `:231-237`); z is computed over a *smoothed, current-bar-inclusive* window so the label saturates on routine wiggles (blueprint says exclude current bar; code doesn't). The separate "Buzz /100" dial has no stated decision value. Also: **"Bull/Bear Buzz" is literally J.P. Morgan's institutional product name** → rename. |
| **Track Record** (Scorecard) | **FIX / CUT** (2 FIX, 1 CUT) | The "moat" is a coin-flip dressed as skill: it grades a near-constant bullish lean (curve-dominated mood) against **7-day S&P direction** where the index rises ~54% of weeks → prints a ~54% "hit rate" that measures **market drift, not skill** (`scorecard.ts:51-104`); 7-day calls emitted daily **overlap ~6/7** → autocorrelated samples shown as independent trials; term-spread skill is at quarter-to-year horizons, **not 1 week**; the promised "2022–24 inversion = a shown MISS" backfill **does not exist in code**; grades against **Yahoo-RED** S&P levels. |

## Part 2 — The CRITICAL live defects (compliance/correctness, not just product)

These three were landed by ≥2 independent negators with `file:line` evidence. They are **production** defects, not demo.

1. **`F1` — "never invent a number" is unenforced.** `verifyFinancePresentation` / `ungroundedNumbers` /
   `allowedNumberSet` have **zero callers** (grep). The briefing's only check, `validateBriefing`, merely
   `console.warn`s and ships the answer (`briefing.ts:193-209,240-244`). The blueprint (C3) advertises this as
   the runtime enforcement of non-negotiable #1; **it does not run.**
2. **`F3` — the no-advice guard is unwired on the briefing.** `checkNoAdvice` is called but its result is only
   logged, never blocks/redacts (`briefing.ts:240-244`); the route just caches (`routes.ts:112,58-72`). And the
   lexicon only catches **second-person** imperatives — a third-person directional call ("AAPL to $260 before
   earnings") passes. Model-written prose ships with no enforced gate.
3. **`F2` — RED Yahoo data displayed publicly under a "public-domain only" banner.** The Briefing's levels grid
   and the Scorecard's S&P `refValue`/notes render Yahoo index point levels (`commercialOk:false`, ledger row
   14 = RED-permanent), and the frontend **never gates on `commercialOk`** (the `ProvenanceLine` is a passive
   amber dot, `finance-view.tsx:1292-1297`). The tab header literally says *"built only from public-domain
   data"* (`finance-view.tsx:1789`) — false while the hero numeric grid is RED.

Plus MINOR: cron `cronOk()` **fails open** when `CRON_SECRET` is unset (`routes.ts:195-202`) → world-writable
scorecard mutation on a fresh deploy.

## Part 3 — What to BUILD (the research answer)

**The unifying thesis (all 9 angles + blueprint):** every retail tool ships the same ~12 cards; the moat is the
licensed feed underneath, RED on every free path. **Lumina's win is the GREEN fetch path, not the card.** Ship
the public-domain-data cards; demo-gate / defer the price-fed ones to the Phase-2 paid spine.

### The single highest-leverage build: SEC EDGAR full-text search (`efts.sec.gov`) as a filing-event engine
One descriptive-UA + shared ≤10 rps fetcher → **five** GREEN insight surfaces (all `commercialOk:true`, 17 USC §105):

| New surface | What it shows | Investor decision | GREEN path |
|---|---|---|---|
| **IPO pipeline** | S-1/F-1/424B4 registrations + priced deals; terms/price-range/shares/use-of-proceeds parsed from the prospectus | "what's coming to market / did it price" | `efts.sec.gov ...forms=S-1,F-1,424B4` → `www.sec.gov/Archives/...` |
| **"What might be wrong here" feed** *(the operator's "which shares will drop", reframed)* | 8-K distress events: 4.02 restatement · 2.06 impairment · 3.01 delisting · 5.02 officer exit · 2.04 debt acceleration | "do I dig into this name?" — **a filed fact, not a prediction, no advice line** | `efts.sec.gov ...forms=8-K` filtered by item code |
| **Insider trades** | Form 4 transactions; cluster **buys** = the cleaner signal (sells are ambiguous — label it) | "are insiders accumulating?" | `efts.sec.gov ...forms=4` → ownership XML |
| **Institutional 13F moves** | quarterly holdings deltas (lagged 45d — **label as a lagged proxy**) | "what did big managers add/cut last quarter" | `www.sec.gov/files/structureddata/.../form13f.zip` |
| **Earnings results radar** | who just reported (8-K item 2.02) + as-filed revenue/EPS from XBRL (the consensus "beat/miss" is RED — omit) | "what did they actually print" | `efts.sec.gov ...forms=8-K` + `data.sec.gov/api/xbrl/companyconcept/...` |

> **The "which shares are going to drop" answer.** The literal ask (analyst downgrades + price-target cuts +
> 52-week-high breakdowns) is **RED** (ratings are proprietary; 52w-high needs RED prices) **and** the highest
> no-advice risk (a named security + a near-term directional call is the blocked pattern). The defensible GREEN
> substitute is the same user intent re-expressed as **primary SEC events the company itself filed** + insider
> selling + negative GDELT tone spikes — framed "is something wrong here?", never "this will drop."

### Other GREEN-now adds
- **Economic calendar** (BLS/BEA/Census/Fed/Treasury release schedules — clean GREEN). Also fills the Briefing's
  missing **"Week ahead"** (replacing the LLM-recalled catalyst dates).
- **"Trending on Lumina"** — first-party `CardEvent` + GDELT article-volume; no upstream license.
- **EDGAR-XBRL fundamentals screener / "health score"** — GREEN inputs only (drop estimate/price legs).
- **"Top of Mind" single-debate card** (Goldman format) — bull block + bear block + "what would change our
  mind"; charter-perfect (it *is* the allowed scenario framing), runs on the existing Tavily loop.
- **"Lumina Late-Cycle Gauge"** (Goldman Bull/Bear Indicator) — 5 of 6 factors GREEN (yield curve, core CPI,
  U-3, private-sector balance, PMI-proxy); only Shiller P/E is non-gov. A genuinely **independent multi-signal**
  gauge that can *replace* the double-counted Mood.
- **Cross-firm consensus RANGE** (YELLOW) — attributed, firm-name-only, link-out; the legal substitute for
  analyst targets (Feist + Barclays v. Theflyonthewall + Lowe v. SEC).

### RED / defer to the paid spine (`commercialOk:false`, flip on the FMP commercial Data-Display license)
Indices strip · heatmap · gainers/losers · most-active · sector performance/rotation · technical screener ·
futures/implied-open · FX/commodities · watchlist **live quotes**. Unusual **options** = effectively REJECT for
v1 (OPRA ~$1,500/mo + Cboe Derived-Data License + real-time worker infra). The Nasdaq IPO/earnings calendar API
is a **REJECT trap** (undocumented, personal-use terms) even though the same IPOs are GREEN from EDGAR.

## Part 4 — The recommended v-next composition

**Reframe:** *Lumina Market Insights = the market's primary-source events — IPOs, insider trades, 8-K filings,
earnings, the economic calendar — every number tappable to its SEC/gov source, plus honest macro gauges,
written up by The Lumina Tape.* Pivot from opinion dials to **primary-source event intelligence** — the GREEN
axis no incumbent gives retail for free with per-datum provenance (Perplexity Finance ships none of the gauges
and asserts its numbers with no license trail).

**Ordering:** The Lumina Tape (with a real GREEN "Week ahead") → **What's filing now** (IPO / 8-K / insider /
earnings event feed) → Economic calendar → Recession Risk (KEEP) → a *de-correlated* macro gauge (renamed) →
News Buzz → Track Record (rebuilt or held back until honest).

## Part 5 — Open decisions for the operator

1. **Scorecard:** rebuild honestly (call on bucket-cross only · grade recession-onset at 12m vs NBER/Sahm, not
   7-day S&P · show base-rate + Brier · GREEN grading reference) **or CUT until it can be honest**? (2 negators FIX, 1 CUT.)
2. **Paid spine (FMP commercial Data-Display license):** yes/no — it's the gate on the entire price-fed half
   (indices, heatmap, sector, live watchlist quotes).
3. **Market Mood:** rename to "Macro Stress" + collapse to one Treasury leg, **or** add independent GREEN legs
   (CFTC COT, GDELT volume z, Sahm momentum) to earn the "composite" label?
4. **Build order:** fix the 3 CRITICAL compliance defects first (small, urgent), then the EDGAR event engine
   (the biggest new value), then the gauge cleanups?
