# theory · The `commercialOk` gate — why the license attaches to the FETCH PATH, not the data concept

> **Scope.** This is the foundational reference for the `data-provenance-licensing` dev-skill of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina.** Every other doc in this skill
> (the source-classification recipe, the provenance-stamp design, the ledger, the contamination rule for
> composites, the `/sources-lint`-style CI lint) assumes the one idea developed here in full. If you read
> exactly one file in this skill before designing the ingest/normalization/store/serve pipeline, read this
> one.
>
> **The product line, in one sentence.** We are re-engineering JPMorgan's internal data products
> (DataQuery / Fusion class) into our own **free-license, prosumer** financial-data-analytics platform on a
> **new Python/FastAPI/data-engineering stack** (separate from Lumina's Bun + Express + Prisma + Supabase +
> Upstash). The platform **owns the bytes**: it ingests N upstream provider feeds, normalizes them onto one
> standard model, **persists** them in a time-series warehouse, and serves them at spike scale. The moment
> you persist and redistribute a number you fetched from someone else, **licensing stops being a footnote
> and becomes a ship-blocker.** This doc is the licensing kernel of that pipeline.
>
> **The on-ramp (plain language).** A price is just a number — `4521.37`. You cannot tell, by *looking at
> the number*, whether you are allowed to show it on a public commercial product. The legal right travels
> with **where you got it from**, not with **what it is**. The exact same S&P 500 level is free-and-clear
> from one door and a lawsuit from another. The `commercialOk` boolean on every series is the machine-readable
> answer to "may we display this commercially?", and its default is **`false`** — closed until a human proves
> a specific fetch path is open. The whole rest of this skill is the discipline of computing that one boolean
> correctly and never letting a `false` series leak onto a public surface.

---

## 0. The thirty-second answer (read this first)

1. **The license attaches to the FETCH PATH, not the concept.** The US-Treasury 10-year yield fetched from
   `home.treasury.gov` is public-domain GREEN; the *identical number* fetched from Yahoo's chart API is RED.
   You **cannot** reason about a series' license from its *data type* — only from *where you fetched it*.
   ([`.claude/rules/commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md); JPM theory primitive #5,
   [`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md).)

2. **`commercialOk: true` is legal only when the fetch path is one of exactly four GREEN paths:**
   (a) **US-government public-domain** — 17 U.S.C. §105 makes federal works ineligible for copyright; (b)
   **CC0 / ODC-PDDL** — an explicit public-domain dedication / waiver; (c) **CC-BY / ODC-BY** — open with a
   *rendered* attribution; or (d) a **purchased** commercial display/redistribution tier. **Everything else
   is RED.**

3. **A free API tier is NOT a commercial-display license.** Free tiers are almost universally scoped to
   *personal / internal / non-commercial* use. "It's free" answers *access*, never *display rights*.

4. **"A competitor displays it" is NOT a license either** — it's the same fallacy as "free tier ⇒ display".
   The competitor either bought a tier you didn't, or is themselves exposed; their risk posture is not your
   license.

5. **Silent or ambiguous ToS ⇒ RED (the conservative default).** When a terms-of-service is *silent* on
   commercial redistribution/display, you do **not** get to read silence as permission. The verdict is RED.

6. **ACCESS ≠ DISPLAY/REDISTRIBUTION.** Being able to *fetch* a number (the wire returns 200 OK) says
   nothing about your right to *show it commercially*. A RED source can still be **built against** for an
   *informational, attributed* feature — you simply keep `commercialOk:false`, render the attribution, and
   never persist/redistribute it as if it were yours.

7. **License-provenance and numeric-grounding are orthogonal.** A GREEN source can still hand you a *wrong*
   number (e.g. SEC EDGAR XBRL frames returning duplicate/non-comparable facts). GREEN-but-wrong still
   violates "never invent a finance number" — the licensing gate clears *display rights*, it does **not**
   clear *correctness*. Two independent gates, both must pass.

If that's all you needed, stop here. The rest proves each point against primary law and ToS text, gives the
runnable Python/Pydantic model for the new stack, and supplies the decision tables a reviewer will demand.

---

## 1. The core claim — same number, two paths, two verdicts

### 1.1 The claim, stated as precisely as it can be

> **A financial datum carries no intrinsic license. The right to display or redistribute it commercially is
> a property of the *fetch path* — the specific source, endpoint, account tier, and governing
> terms-of-service/statute through which you obtained it — and of nothing else.**

This is counter-intuitive on first contact, because we *think* about data by its concept ("the 10-year
yield", "the S&P 500 level", "Apple's last trade") and concepts feel like they should have stable
properties. They don't, for licensing. The number `4.27` is a fact. **Facts are not copyrightable** in the
US — `Feist Publications, Inc. v. Rural Telephone Service Co., 499 U.S. 340 (1991)` held that facts and the
"sweat of the brow" of compiling them are not protected; only original *selection/arrangement* is. So the
restriction you hit is almost never "the number is copyrighted" — it's a **contract**: the terms-of-service
you accepted to obtain that number through that door. Contract scope is defined by the *door*, not the
*number*.

This is exactly how the data-licensing literature describes it. Per Thomson Reuters' practitioner guidance,
a data license is a **consent instrument that defines and limits permitted uses**, not a transfer of the
data: *"Where the customer-licensor finds the vendor-licensee's ancillary use of data to be acceptable, it
should specify in the agreement the scope of customer information the vendor may use [and] the permitted
uses of that information."* The license grants *limited* rights while the licensor *retains* the broader
exploitation rights — including the right to charge more for expanded usage or to license the same data to
others. ([Thomson Reuters, "Data Licensing: Taking into Account Data Ownership"](https://legal.thomsonreuters.com/en/insights/articles/data-licensing-taking-into-account-data-ownership),
fetched 2026-06-24.) The agreement's *language* — i.e. the path's ToS — *"directly defines which uses are
authorized and which remain prohibited."* The *same datum* obtained under *two different agreements* has
*two different permitted-use sets*. That is the whole claim.

### 1.2 The worked example — treasury.gov GREEN vs Yahoo RED

Take one number: the US Treasury constant-maturity **10-year yield** for a given date, say `4.27%`.

| | Path A — `home.treasury.gov` | Path B — Yahoo chart API (`^TNX`) |
|---|---|---|
| **What you fetch** | The daily Treasury Par Yield Curve XML | `query1.finance.yahoo.com/v8/finance/chart/^TNX` |
| **The number** | `4.27` | `4.27` (identical) |
| **Who authored it** | A US Treasury officer/employee as part of official duties | Aggregated/redistributed by Yahoo |
| **Governing instrument** | 17 U.S.C. §105 — *"Copyright protection under this title is not available for any work of the United States Government"* ([law.cornell.edu/uscode/text/17/105](https://www.law.cornell.edu/uscode/text/17/105)) | Yahoo's Terms of Service — no commercial-display grant; redistribution forbidden |
| **`commercialOk`** | **`true`** (public-domain GREEN) | **`false`** (RED — no display license) |

The number is byte-for-byte identical. The **verdict is opposite.** Path A's authoring entity is a federal
employee acting in official duties, so 17 U.S.C. §105 places the work in the public domain — *"intended to
place all works of the United States Government, published or unpublished, in the public domain"*
([ARL, "Copyright Status of Government Works"](https://www.arl.org/wp-content/uploads/2015/06/copyright-status-of-government-works.pdf)).
Path B is the same fact re-served by a private aggregator under a ToS that grants you *access for personal
use* and grants you *no display/redistribution right at all*. The fact isn't the issue; the **path's
contract** is. (This exact worked example is the canonical statement in
[`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) and the sources-ledger header, and the JPM
theory's primitive #5.)

**The operational consequence for our pipeline.** Our platform *ingests, persists, and redistributes*. If we
warm a series into the warehouse from Path B and then serve it on a public commercial endpoint, we are
**redistributing Yahoo's data as our own** — the single thing every consumer-finance ToS forbids. If we warm
the *same number* from Path A, we are redistributing a public-domain fact — entirely legal. **The store does
not know or care that the numbers are equal. The provenance stamp is what carries the difference**, and the
ingest worker must stamp the path it actually used — never the path that *would have been* greener.

### 1.3 Why "by concept" reasoning is a trap — three more illustrations

The treasury example is the headline, but the trap generalizes. Reasoning "this *kind* of data is usually
free" is wrong every time:

- **CBOE VIX via FRED.** FRED (the St. Louis Fed's database) *hosts* the `VIXCLS` series. FRED hosting feels
  governmental, so "VIX from FRED" feels GREEN. It is **RED**: the VIX is CBOE's copyrighted index; FRED is
  merely a redistribution host, and FRED's *hosting* does not launder CBOE's copyright into public domain.
  Only **Fed-authored** FRED series are public-domain GREEN. (Sources-ledger "Hard RED traps" row; this is
  the single most common by-concept mistake.)

- **Congressional trading disclosures.** The raw House Clerk PTR / Senate eFD filings *are* US-government
  works, so the by-concept reflex says "17 U.S.C. §105 ⇒ GREEN". **Wrong** — a *different statute* gates the
  *use*: the Ethics in Government Act (5 U.S.C. §13107(c)(1)) makes it unlawful to *"use a report … for any
  commercial purpose, other than by news and communications media for dissemination to the general public"*,
  civil penalty up to $10k. Public domain on *copyright* does not cure a *statutory use restriction*. Verdict:
  **RED by statute.** (Sources-ledger.) The concept ("government data") gave the wrong answer; the *path's
  full legal context* gave the right one.

- **Equity sector data.** "Sector performance" sounds generic and free. But if you fetch it as the SPDR
  sector ETF prices from Yahoo, you've fetched *Yahoo-pathed quote data* — RED — even though the *concept*
  (sector performance) could in principle be computed from GREEN inputs. The concept didn't decide; the path
  did. (Lumina's `fetchSectors` correctly stamps `commercialOk:false` for exactly this reason —
  [`backend/finance/sources.ts:538`](../../../../backend/finance/sources.ts).)

**The rule that falls out:** *never* classify a series by what it represents. Classify it by the tuple
`(host, endpoint, account-tier, governing ToS/statute)` — and re-classify whenever any element of that tuple
changes. A source that's GREEN on its public-domain bulk endpoint can be RED on its "enriched" tier of the
same site.

---

## 2. The four GREEN fetch paths (and everything else is RED)

`commercialOk: true` is legal **only** when the fetch path is one of exactly four kinds. This is a
*closed* list — if a path isn't demonstrably one of these four, it is RED. Memorize the four; treat the
boundary as a wall.

### 2.1 GREEN path #1 — US-government public domain (17 U.S.C. §105)

**The rule.** Works *prepared by an officer or employee of the US Government as part of that person's
official duties* are ineligible for copyright and are in the public domain.

**Primary text.** 17 U.S.C. §105(a): *"Copyright protection under this title is not available for any work
of the United States Government."* ([law.cornell.edu/uscode/text/17/105](https://www.law.cornell.edu/uscode/text/17/105),
fetched 2026-06-24.) The definition of the covered class (17 U.S.C. §101): a *"work of the United States
Government"* is *"a work prepared by an officer or employee of the United States Government as part of that
person's official duties."* The legislative intent, per the House Report and the ARL summary, was *"to place
all works of the United States Government, published or unpublished, in the public domain."*
([ARL summary](https://www.arl.org/wp-content/uploads/2015/06/copyright-status-of-government-works.pdf).)

**The two carve-outs you must respect** (both from the same statute / its notes — these are where a
by-concept "gov data = free" reflex over-reaches):

1. **Contractor/grantee works are NOT automatically covered.** §105 covers works by *government
   employees in their official duties*. A dataset a federal agency *publishes* but that was *prepared by a
   contractor or grantee* may carry the contractor's copyright. *"Publication of an otherwise protected work
   by the U.S. government does not put that work in the public domain … government publications may include
   works copyrighted by a contractor or grantee."* ([Cornell LII / 17 USC 105 notes](https://www.law.cornell.edu/uscode/text/17/105);
   corroborated by [GPO "copyright and use policies of GovInfo content"](https://ask.gpo.gov/s/article/What-are-the-copyright-and-use-policies-of-govinfo-content).)
   → *The FRED-hosting trap (§1.3) is exactly this: a government host re-serving a third party's copyrighted
   series.*

2. **§105 is US-FEDERAL only.** It does **not** cover (a) **state/municipal** government works (many states
   *do* claim copyright; some are PD by their own law — verify per state), (b) **foreign** government works
   (UK Crown Copyright, EU statistical agencies' terms, etc. are governed by *their* law, frequently *not*
   public domain), or (c) intergovernmental bodies (IMF, World Bank, OECD each have their *own* terms — World
   Bank open data is **CC-BY**, not §105 PD; IMF's terms vary by product and the IMF *Blog* prose is
   explicitly RED). Treat "is this entity a US *federal* author?" as a hard precondition, not a vibe.

**The clean US-federal GREEN spine for this product line** (each a verified row in the sources-ledger):

| Source | Authoring federal entity | Fetch path |
|---|---|---|
| SEC EDGAR (XBRL companyfacts/concept/frames, submissions) | SEC | `data.sec.gov` |
| US Treasury daily par yield curve | Treasury | `home.treasury.gov` XML |
| BLS (CPI, unemployment, etc.) | Bureau of Labor Statistics | `api.bls.gov` |
| BEA (GDP, PCE) | Bureau of Economic Analysis | `apps.bea.gov/api` |
| CFTC Commitments of Traders | CFTC | Socrata API |
| Fed-authored FRED series (and *only* those) | Federal Reserve | `fred.stlouisfed.org` (Fed-owned series only) |

**The §105 fair-access condition (operational, not licensing).** Public domain ≠ "hammer the server".
Federal endpoints impose a *fair-access* operational policy that is separate from the *license* but is
non-negotiable for our ingest worker. SEC EDGAR: *"The current maximum request rate is 10 requests per
second … applies to each user regardless of the number of machines"*, and the SEC *"requires automated tools
to declare a descriptive User-Agent string"* and reserves the right to block IPs that exceed it.
([SEC "Accessing EDGAR Data"](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data);
[SEC "new rate control limits"](https://www.sec.gov/filergroup/announcements-old/new-rate-control-limits).)
So a GREEN path still imposes: **descriptive `User-Agent`, ≤10 req/s, download-only-what-you-need.** These go
in the ingest worker's rate budget, not the license verdict — but skipping them gets your IP blocked, which
is its own outage.

### 2.2 GREEN path #2 — CC0 / ODC-PDDL (explicit public-domain dedication)

**The rule.** A rights-holder can *voluntarily* waive all rights and dedicate a work to the public domain.
Two instruments do this for data:

- **CC0 1.0** — Creative Commons' public-domain *dedication*. *"CC0 removes all rights and places the work
  in the public domain, giving users complete freedom to use, adapt, or distribute the work without any
  limitations or requirements such as attribution. CC0 is not a license; it is a public domain dedication."*
  ([CC0 FAQ](https://wiki.creativecommons.org/wiki/CC0_FAQ); summary via search 2026-06-24.)
- **ODC-PDDL** (Open Data Commons Public Domain Dedication and License) — the data-specific equivalent. Open
  Data Commons offers three tools: *"the Public Domain Dedication and License (PDDL), the Attribution License
  (ODC-By), and the Open Database License (ODbL)."* PDDL imposes **no conditions on use**.
  ([resources.data.gov/open-licenses](https://resources.data.gov/open-licenses/).)

**Why CC0 ≠ CC-BY matters for the stamp.** CC0/PDDL ⇒ `commercialOk:true` with **no attribution obligation**.
CC-BY/ODC-BY ⇒ `commercialOk:true` **only if attribution is rendered** (§2.3). The difference is one field on
the provenance stamp (`attributionRequired: false` vs `true`) and one rendering obligation on the surface. Do
not collapse them — a CC-BY source displayed *without* its required attribution is **out of compliance**, i.e.
effectively unlicensed for that display.

**Real example in scope.** OpenAlex (scholarly graph) is CC0 — used in Lumina's academic vertical precisely
because CC0 clears commercial display with zero attribution strings attached. For *this* finance product line,
CC0 datasets are rarer but real (some exchange reference data, some open economic datasets); treat each on its
*actual published* dedication, verified at the source.

### 2.3 GREEN path #3 — CC-BY / ODC-BY (open WITH rendered attribution)

**The rule.** The work is open for commercial use **on the condition** that you render the required
attribution on every surface that displays it.

- **CC-BY 4.0** — *"requires attribution to the original creator."* ([CC FAQ](https://creativecommons.org/faq/).)
- **ODC-By** — *"the equivalent of a Creative Commons Attribution license (CC BY). However, ODC-By license
  applies to works not protected by copyright (such as factual data)."*
  ([resources.data.gov/open-licenses](https://resources.data.gov/open-licenses/).) ODC-By is the
  *data-native* attribution license — important because financial series are **facts**, which copyright
  doesn't reach, so the attribution obligation rides on the *database/contract*, not on copyright.

**The condition is load-bearing.** `commercialOk:true` for a CC-BY/ODC-BY source is **conditional on the
attribution actually rendering** on the displayed surface. The attribution string sitting in the JSON payload
is **not** compliance — it must reach the pixels the user sees. This is the single most common compliance
miss: the engineer stamps the attribution into `provenance.attribution`, the frontend never renders it, and
the legal condition is silently unmet.

**Worked example in scope — World Bank & GDELT.**

- **World Bank Open Data** is **CC-BY 4.0**. → `commercialOk:true`, attribution *"Source: World Bank"* must
  render. (Sources-ledger.)
- **GDELT DOC 2.0** grants *"unlimited and unrestricted … commercial use"* **but** with a *mandatory verbatim
  citation + link*: *"Source: The GDELT Project (gdeltproject.org)"*. The ledger flags it 🟢 **GREEN
  (conditioned)** precisely because *"the condition must render on every surface that displays it, not just
  sit in the payload."* And a narrower trap: *only the numeric tone is GREEN — the underlying article
  headlines are third-party.* (Sources-ledger.) → a CC-BY-class path can be GREEN on one field and RED on an
  adjacent field of the *same response*. Stamp at field granularity when paths diverge inside one payload.

### 2.4 GREEN path #4 — a purchased commercial display/redistribution tier

**The rule.** You *bought* the right. A vendor's **paid display/redistribution SKU** grants commercial
display when, and only when, the *purchased tier's contract* says so.

**Two things this is NOT** (the traps that mint a fake GREEN):

1. **A free tier of a paid vendor is not the paid tier.** CoinGecko *Demo* ≠ CoinGecko *Analyst*; Twelve Data
   *Basic* ≠ a Pro display tier. You inherit the *free tier's* (personal-use) terms, not the paid tier's.

2. **A *published price* is not a *display license*.** This is the Tiingo trap, verified verbatim in the
   ledger: Tiingo's published "$250/mo" tier reads *"Data via the API is for internal consumption only …
   Redistribution only upon special request + ADDITIONAL FEES — contact sales."* So even the **paid** tier is
   **internal-use only**, not a display SKU. Paying money does not by itself buy display rights — the *tier's
   contract* must specifically grant *commercial display / redistribution*. Read the SKU's grant clause; do
   not infer it from the invoice. (Sources-ledger "Market data" → Tiingo row.)

**The CME example — display vs non-display are SEPARATELY priced even within a paid relationship.** This is
the sharpest real-world proof that "I'm a paying customer" ≠ "I can display". CME's market-data policy defines
**Non-Display Use** as *"non-viewable use of Information, internally within a Licensee's Group, by/in any
system, process, program, machine or calculation other than in order to display"* — P&L, risk, valuation,
algo trading — and states plainly that *"all other activities will require separate licenses"*, with
**display** in subscriber devices being its own, separately-fee'd category.
([CME "Data Licensing Policy Guidelines / Non-Display"](https://www.cmegroup.com/market-data/distributor/files/cme-group-data-licensing-policy-guidelines-and-non-display-licensing-faq.pdf),
via search 2026-06-24.) The lesson for the stamp: a *purchased* path is GREEN only for the *specific use the
SKU grants* — and "display" is frequently carved out and priced separately from "use". When in doubt about
which CME-class category your product falls in, it's RED until the contract names your use. CME-derived data
(FedWatch, options-implied moves) is correspondingly 🟡 YELLOW in our ledger — *needs a Derived-Data
License*.

### 2.5 …and everything else is RED

If a fetch path is **not** demonstrably one of the four above, its verdict is **RED**, full stop. There is no
fifth GREEN category. "It's probably fine", "everyone uses it", "the docs don't say I *can't*" — none of these
are a GREEN path. The next two sections kill the three specific fallacies that try to smuggle in a fifth.

---

## 3. Free tier ≠ display license; competitor-displays-it ≠ license; silence ⇒ RED

These are three distinct fallacies that all try to manufacture a GREEN verdict the path never granted. Each is
disproved by primary text.

### 3.1 "It's a free API tier, so I can display it" — FALSE

A free tier answers **access** ("you may call this endpoint at this rate"); it almost never grants **display
/ redistribution**. Free tiers are overwhelmingly scoped to *personal / internal / non-commercial* use:

- **The market broadly.** Developer-survey writing on free financial APIs is blunt: *"Finnhub's free tier is
  for personal or non-commercial use"*; *"News API explicitly restricts its free tier to developer use, not
  commercial applications"*; *"CoinMarketCap's free Basic plan is licensed for personal use rather than
  commercial product use"*; and the standing warning that *"many free APIs scrape data … which can violate
  terms of service, copyright laws, and exchange licensing agreements … leading to legal consequences if used
  in commercial products."* ([Intrinio "Free Financial Data APIs"](https://intrinio.com/blog/free-financial-data-apis-weighing-the-pros-cons);
  developer comparisons via search 2026-06-24.)

- **Our actual ledger, verified verbatim.** Every free vendor tier we touch is RED *for display*:
  Twelve Data Basic = *"personal/internal use; no third-party display/redistribution"*; Yahoo chart API =
  *"no commercial-display grant; ToS forbids redistribution"*; CoinGecko Demo = *"scoped to personal use;
  'Powered by CoinGecko' required; redistributing data as your own = prohibited"*; Finnhub free =
  *"personal-use only; not for public display/redistribution"*; FMP free = *"non-commercial"*. (Sources-ledger
  "Market data" table; mirrored in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)'s
  per-fetcher comments — e.g. `cgProvenance()` at line 62 hard-codes `commercialOk:false` with the comment
  *"Demo tier = personal use; flip true on a paid commercial plan."*)

**Why the fallacy is seductive and why it's wrong.** "Free" and "open" feel synonymous. They aren't. *Free*
is a **price** on *access*; *open* is a **grant** on *use*. The treasury XML is free *and* open. CoinGecko
Demo is free *and closed*. The price you paid (zero) tells you nothing about the use you were granted. Our
pipeline *persists and redistributes* — the most license-sensitive use there is — so a free *access* tier is
the *least* likely thing to clear us.

### 3.2 "A competitor displays it, so it must be licensable" — FALSE (the same fallacy)

`commercial-ok-gate.md` names this directly: *"Neither is 'a competitor displays it' — that's the same
fallacy."* Three reasons it's worthless as evidence:

1. **They may have bought a tier you didn't.** A paid display/redistribution SKU is invisible from the
   outside. Their lawful display is *their license*, not a property of the source.
2. **They may be out of compliance themselves.** Plenty of products display data they have no right to. Their
   risk is not your permission. (And selective enforcement means "they haven't been sued yet" ≠ "it's
   allowed".)
3. **Their fetch path may differ from yours.** They might pull the *same concept* from a GREEN path (§1) while
   you're eyeing a RED one. You can't infer their door from their pixels.

The only thing that licenses *you* is *your* path's terms. A competitor's surface is not a primary source.

### 3.3 Silent / ambiguous ToS ⇒ RED (the conservative default)

When a ToS is **silent or ambiguous** about commercial redistribution/display, the verdict is **RED, not
GREEN.** ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md); sources-ledger header: *"When a
ToS is silent/ambiguous on commercial redistribution or display, the verdict is RED, not GREEN."*)

**Why silence is RED, not permission.** Two converging reasons:

- **Default copyright/contract posture.** Absent an *affirmative grant*, the rights-holder retains all rights
  not expressly given. Data-licensing practice is explicit that the license *grants limited rights while the
  licensor retains control* and *"directly defines which uses are authorized and which remain prohibited"*
  ([Thomson Reuters](https://legal.thomsonreuters.com/en/insights/articles/data-licensing-taking-into-account-data-ownership)).
  No express grant of commercial display ⇒ no commercial display right. Silence is *retention*, not *release*.
  (Polymarket's Gamma ToS is the textbook case in our ledger: *"Any rights not expressly granted … are
  reserved by PMUS"* — the reservation clause that makes silence equal denial.)

- **The cost asymmetry is the whole reason for a conservative default.** Treating an ambiguous source as GREEN
  and shipping it risks a takedown, a back-bill, or a statutory penalty (the Congress-trading §13107(c) civil
  penalty is up to $10k *per misuse*). Treating it as RED costs you a feature you build *attributed and
  ungated* instead. The downside of false-GREEN is catastrophic and external; the downside of false-RED is a
  smaller feature. A correct default minimizes the *catastrophic* error. This is the same logic the JPM theory
  pre-mortem flags as a top-3 failure mode: *"someone … stored a RED vendor series to 'look complete'. A
  commercial-agreement bill or a takedown lands."*
  ([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md).)

**The discipline:** *ambiguity is not a coin flip you may call GREEN.* If, after reading the actual ToS text,
you cannot point to an **express** commercial-display/redistribution grant (or a public-domain/CC0/CC-BY
basis), the answer is RED. "I couldn't find a prohibition" is *not* a grant.

---

## 4. ACCESS vs DISPLAY/REDISTRIBUTION — the rights split that the whole gate turns on

The single most important conceptual move in this skill: **separate the two questions** that engineers
collapse into one.

| Question | What it asks | Answered by |
|---|---|---|
| **Can I FETCH it?** (access) | Does the endpoint return data to my client at all? | The wire (200 OK), my API key/rate budget, geo-availability |
| **Can I DISPLAY/REDISTRIBUTE it commercially?** (display rights) | May I show this on a public commercial product, or persist+re-serve it as part of my data plane? | The path's **ToS/statute** — i.e. `commercialOk` |

These are **orthogonal**. The matrix has four cells, and all four occur in our codebase:

| | **Display allowed** (`commercialOk:true`) | **Display NOT allowed** (`commercialOk:false`) |
|---|---|---|
| **Access works** | treasury.gov, World Bank, GDELT tone, SEC EDGAR | Yahoo quotes, CoinGecko Demo, Twelve Data free, Polymarket |
| **Access fails** | (a GREEN source that's down → return typed `unavailable`, never backfill) | (a RED source that's also unreachable — e.g. Polymarket geo-blocked from India) |

### 4.1 A RED source can still be BUILT AGAINST — the key liberation

The crucial, frequently-missed corollary: **RED gates the *display license*, not *access*.** You may
absolutely build a real, useful, *informational* feature on a RED source — you just keep the gate `false`,
render the source's attribution, and never persist/redistribute the data as if it were your own series.

This is exactly Lumina's Polymarket pattern, and it's the template:

- `commercial-ok-gate.md`: *"A RED source can still be **built against** for an informational, attributed
  feature (e.g. Polymarket predictions) — you just keep the gate `false` and show attribution. RED gates the
  *display license*, not *access*."*
- The code does precisely this — [`fetchPredictions()` in `sources.ts:368`](../../../../backend/finance/sources.ts)
  fetches Polymarket, stamps `commercialOk:false`, sets `attribution: "Prediction market data from
  Polymarket"`, and the comment at the Polymarket provenance literally reads *"confirm commercial-display ToS
  before flipping true"*.

**What "built against but gated false" permits vs forbids** (the operational boundary for our product line):

| Permitted on a RED source | Forbidden on a RED source |
|---|---|
| Fetch it live, render it *with attribution* as an informational card | Persist it into our warehouse as a redistributable series |
| Link out to the source ("Powered by X") | Re-serve it on our public commercial data API as if it were ours |
| Use it transiently to *inform* a model's reasoning | Mix it into a `commercialOk:true` composite (the contamination rule, §6.3) |
| Show "Source: X (informational)" framing | Strip the attribution / present it as Lumina/our-platform data |

For *this product line specifically* — whose core promise is **owning and redistributing the bytes** — the
RED/“built against” path is narrower than in Lumina. The data plane *persists*. So a RED source is generally
**fetch-through-only** (rendered live with attribution, never warmed into the store), per the JPM theory:
*"Free vendor tiers (CoinGecko Demo, Twelve Data, Yahoo, Polygon/Tiingo free) are RED for redistribution and
may only be fetch-through-only (not stored/redistributed) unless a commercial tier is purchased."*
([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md).)
**The store is a redistribution surface.** Treat "may I write this series into the warehouse?" as a *display*
question, not an *access* question — the same gate decides it.

### 4.2 Why the split is hard-wired into market-data law, not just our convention

This isn't a Lumina/JPM-product invention — the *display vs non-display* split is the organizing principle of
real exchange licensing. CME prices *non-display use* (internal calculation, risk, algo trading) and *display
use* (showing numbers to humans) as **separate license categories with separate fees**, and states *"all other
activities will require separate licenses"*
([CME](https://www.cmegroup.com/market-data/distributor/files/cme-group-data-licensing-policy-guidelines-and-non-display-licensing-faq.pdf)).
TRG (a market-data compliance vendor) builds an entire product around *"Digital Rights Management … take
control of data usage"* precisely because firms routinely have *access* to feeds they are not *licensed to
display or redistribute*. Our `commercialOk` boolean is the consumer-grade, free-tier-focused projection of
the exact same industry split — and getting it wrong is the same compliance failure the whole market-data
licensing industry exists to prevent.

---

## 5. License-provenance vs numeric-grounding — two orthogonal gates, both must pass

A second orthogonality, just as load-bearing, and just as easy to conflate: **the licensing gate and the
correctness gate are independent.**

| Gate | Question | Failure mode | Guard |
|---|---|---|---|
| **License-provenance** (`commercialOk`) | May we *display* this number commercially? | Mis-licensed series on a public surface → takedown / bill / penalty | the sources-ledger + `/sources-lint` + the PreToolUse nudge |
| **Numeric-grounding** ("never invent a number") | Is this number *real* — fetched by a tool and grounded, not fabricated or mis-derived? | A *wrong* or *invented* number shown to a user | "never invent a finance number"; failed fetches return typed `unavailable`/`needsKey` |

### 5.1 GREEN-but-wrong still violates "never invent a number"

A GREEN license clears *display rights*. It does **not** clear *correctness*. The canonical example is in the
ledger and the JPM theory both: **SEC EDGAR is GREEN (public domain)** — and its XBRL `frames` endpoint
*"returns duplicate/non-comparable facts"*, so *"a GREEN-but-wrong number still violates 'never invent a
finance number'; needs a dedup/restatement gate."* (Sources-ledger SEC EDGAR row.)

The point: you can hold a *perfectly licensed* number that is *factually wrong* (a duplicate XBRL fact, a
non-comparable restatement, a units mismatch, a stale value presented as live). The license gate waves it
through; the correctness gate must independently catch it. **Two gates, in series. Both must pass before a
number reaches a user.**

### 5.2 The other corner — never fabricate, never RED-backfill

Symmetrically, the correctness gate forbids the inverse cheat: when a fetch *fails* or runs over budget, you
return a **typed `unavailable`/`needsKey`** — *never* a fabricated value, and *never* a RED-tier backfill to
"look complete". This is where the two gates intersect: *"Failed/over-budget fetches return typed
`unavailable`/`needsKey` — never a fabricated value, never a RED-tier backfill to 'look complete.'"*
([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md).) Backfilling a missing GREEN series from a
RED source to avoid a gap **violates both gates at once** — it invents a path-laundered number *and*
mis-licenses it. The JPM theory's `QuotesPayload`/`needsKey` shape in `sources.ts` is the in-repo precedent:
on a missing key, `fetchStocks` returns `{ items: [], needsKey: true }` rather than inventing quotes
([`sources.ts:595`](../../../../backend/finance/sources.ts)).

### 5.3 Why keeping them separate matters for the pipeline

If you fuse the two gates, you get two characteristic bugs:

- **Fusing toward licensing** → you trust any GREEN number as correct and ship EDGAR `frames` duplicates as
  fact. (License-clean, factually wrong.)
- **Fusing toward correctness** → you reason "this number is obviously right, so surely we can show it" and
  display a RED Yahoo quote because it *matches* the GREEN one. (Factually right, license-dirty — and §3.2's
  fallacy in disguise.)

Keep them as two independent boolean predicates on every series. A series ships **only if `commercialOk &&
grounded`.** Neither implies the other.

---

## 6. Mapping to the repo's `Provenance{commercialOk}` type — and the new-stack model

### 6.1 The in-repo TypeScript precedent (Lumina — the pattern we inherit)

The whole discipline is already crystallized in Lumina's `Provenance` type and the `cgProvenance` default —
the *exact shape* the new Python stack reproduces. Verbatim from
[`backend/finance/sources.ts:17`](../../../../backend/finance/sources.ts):

```ts
export type Provenance = {
  source: string;          // human-readable source name, e.g. "CoinGecko"
  commercialOk: boolean;   // THE GATE. default false.
  attribution: string;     // the string that must RENDER on any surface that shows the data
  unit?: "USD" | "mana";   // a domain caveat (Polymarket=USD vs Manifold play-money=mana)
};
```

…and the default-`false` factory, which is the gate's *home* — note the comment encodes the §2.4 rule
(*flip true only on a paid commercial plan*):

```ts
function cgProvenance(): Provenance {
  return {
    source: "CoinGecko",
    commercialOk: false, // Demo tier = personal use; flip true on a paid commercial plan.
    attribution: "Data provided by CoinGecko",
  };
}
```

Three design choices to carry forward verbatim:

1. **`commercialOk` defaults to `false`** at every construction site. There is no path where a freshly
   constructed provenance is GREEN-by-default. GREEN is always an *explicit, justified* override.
2. **`attribution` is a first-class field, always populated** — even for RED sources — because the §4.1
   "built against, gated false" pattern *requires* attribution to render.
3. **A `unit`/caveat field** carries the domain footgun (USD vs mana) alongside the license — because a
   number can be *licensed* and *correct* and still *misread* if its unit is wrong. (This foreshadows the
   numeric-grounding gate, §5.)

The composite-briefing default is the same discipline at the aggregate level. Lumina's `briefing.ts` market
summary is assembled from multiple series; its provenance defaults `commercialOk:false` and only the GREEN
inputs (e.g. GDELT tone) are eligible to lift it — which is the **contamination rule** below.

### 6.2 The new-stack model — Pydantic v2 `Provenance` for the Python data plane

The JPM-Markets re-engineering line runs on Python/FastAPI/Pydantic v2 (separate stack). Here is the faithful
port of the type plus the *enforcement* the new stack should bake in. This is runnable against
`pydantic>=2.11`.

```python
# provenance.py — the licensing stamp for the data plane (Python/Pydantic v2 port of the
# Lumina Provenance{commercialOk} type). Every persisted/served series carries one of these.
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class LicenseBasis(str, Enum):
    """The FOUR (and only four) GREEN fetch-path bases — plus RED for everything else.

    `commercialOk == True` is permitted ONLY when basis is one of the four GREEN values.
    The license attaches to the FETCH PATH, not the data concept (see §1).
    """
    US_GOV_PUBLIC_DOMAIN = "us_gov_public_domain"   # 17 USC §105 — federal author, official duties
    CC0_PDDL = "cc0_pddl"                            # explicit public-domain dedication, no attribution
    CC_BY_ODC_BY = "cc_by_odc_by"                    # open WITH rendered attribution
    PURCHASED_DISPLAY_TIER = "purchased_display_tier"  # a paid SKU that GRANTS commercial display
    RED = "red"                                      # default — no display/redistribution grant


# The closed set of bases that may carry commercialOk=True. There is NO fifth GREEN category.
_GREEN_BASES = frozenset({
    LicenseBasis.US_GOV_PUBLIC_DOMAIN,
    LicenseBasis.CC0_PDDL,
    LicenseBasis.CC_BY_ODC_BY,
    LicenseBasis.PURCHASED_DISPLAY_TIER,
})

# Bases that REQUIRE an attribution string to render on the displayed surface (§2.3).
_ATTRIBUTION_REQUIRED_BASES = frozenset({LicenseBasis.CC_BY_ODC_BY})


class Provenance(BaseModel):
    """The licensing + lineage stamp attached to every series the data plane persists or serves.

    Invariants (enforced below, fail-closed):
      • commercialOk=True  ⇒  basis ∈ _GREEN_BASES                          (no fake GREEN)
      • basis=RED          ⇒  commercialOk=False                            (RED is never displayable)
      • basis ∈ attribution-required  ⇒  attribution is non-empty          (CC-BY needs a string)
      • silent/unknown basis defaults to RED + commercialOk=False          (conservative default, §3.3)
    """
    model_config = {"frozen": True}  # a stamp is immutable once written; re-fetch => new stamp

    source: str = Field(..., min_length=1, description='e.g. "US Treasury", "CoinGecko Demo"')
    fetch_path: str = Field(..., min_length=1,
                            description='The exact door: host+endpoint+tier, e.g. "home.treasury.gov/yield-xml"')
    basis: LicenseBasis = Field(default=LicenseBasis.RED, description="The GREEN basis, or RED.")
    commercial_ok: bool = Field(default=False, description="THE GATE. default False. True only if basis is GREEN.")
    attribution: str = Field(default="", description="Must RENDER on any surface showing the data (esp. CC-BY).")
    ledger_row: Optional[str] = Field(default=None,
                                      description="Anchor to the sources-ledger row that cleared this path.")
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    unit: Optional[str] = None   # domain caveat, e.g. "USD" vs "mana" — foreshadows the grounding gate

    @field_validator("fetched_at")
    @classmethod
    def _ensure_utc(cls, v: datetime) -> datetime:
        # provenance timestamps are always UTC, so two paths' as-of are comparable
        return v.astimezone(timezone.utc) if v.tzinfo else v.replace(tzinfo=timezone.utc)

    @model_validator(mode="after")
    def _enforce_gate(self) -> "Provenance":
        # 1. commercialOk=True is legal ONLY on a GREEN basis (§2).
        if self.commercial_ok and self.basis not in _GREEN_BASES:
            raise ValueError(
                f"commercial_ok=True is illegal for basis={self.basis.value!r}: "
                f"only {[b.value for b in _GREEN_BASES]} may display commercially "
                f"(fetch_path={self.fetch_path!r})."
            )
        # 2. RED basis can never be displayable (defense-in-depth against a stray True).
        if self.basis is LicenseBasis.RED and self.commercial_ok:
            raise ValueError("RED basis cannot have commercial_ok=True.")
        # 3. CC-BY/ODC-BY requires a non-empty attribution string to be RENDERED (§2.3).
        if self.basis in _ATTRIBUTION_REQUIRED_BASES and not self.attribution.strip():
            raise ValueError(
                f"basis={self.basis.value!r} requires a non-empty attribution string "
                "(it MUST render on the displayed surface, not just sit in the payload)."
            )
        # 4. A GREEN gate with no ledger anchor is a smell — a human must have cleared the path.
        if self.commercial_ok and not self.ledger_row:
            raise ValueError(
                "commercial_ok=True without a ledger_row: a GREEN verdict must anchor to a "
                "verified sources-ledger row (§3.3 — if it isn't in the ledger, it isn't cleared)."
            )
        return self


# ── The only sanctioned constructors. Default path = RED. GREEN requires a named basis + ledger row. ──

def red(source: str, fetch_path: str, attribution: str = "") -> Provenance:
    """The default. Access works; display does NOT. Build against it, gated false (§4.1)."""
    return Provenance(source=source, fetch_path=fetch_path, basis=LicenseBasis.RED,
                      commercial_ok=False, attribution=attribution)


def green(source: str, fetch_path: str, basis: LicenseBasis, ledger_row: str,
          attribution: str = "") -> Provenance:
    """A GREEN stamp. Caller MUST name which of the four bases and the ledger row that cleared it."""
    if basis not in _GREEN_BASES:
        raise ValueError(f"{basis} is not a GREEN basis; use red() instead.")
    return Provenance(source=source, fetch_path=fetch_path, basis=basis,
                      commercial_ok=True, attribution=attribution, ledger_row=ledger_row)
```

Usage — the four GREEN paths and the RED default, each constructed at the *fetcher* (the only place that knows
the real path):

```python
# US-gov public domain (§2.1) — Treasury par yield curve
treasury_prov = green(
    source="US Treasury",
    fetch_path="home.treasury.gov/resource-center/data-chart-center/.../daily-treasury-rates.xml",
    basis=LicenseBasis.US_GOV_PUBLIC_DOMAIN,
    ledger_row="treasury-par-yield-2026-06-23",
    attribution="Source: U.S. Department of the Treasury",  # courtesy, not legally required for §105
)

# CC-BY (§2.3) — World Bank. Attribution is LEGALLY REQUIRED and must render.
worldbank_prov = green(
    source="World Bank Open Data",
    fetch_path="api.worldbank.org/v2/...",
    basis=LicenseBasis.CC_BY_ODC_BY,
    ledger_row="worldbank-cc-by-2026-06-23",
    attribution="Source: World Bank (CC BY 4.0)",   # MUST appear on the surface, or out of compliance
)

# RED default (§3.1) — CoinGecko Demo. Access works; display does not. Fetch-through-only.
coingecko_prov = red(
    source="CoinGecko Demo",
    fetch_path="api.coingecko.com/api/v3/coins/markets (demo key)",
    attribution="Data provided by CoinGecko",  # still rendered for the 'built against' pattern (§4.1)
)

# The validator makes the illegal state UNREPRESENTABLE — this raises at construction:
try:
    Provenance(source="Yahoo", fetch_path="query1.finance.yahoo.com/...",
               basis=LicenseBasis.RED, commercial_ok=True)
except ValueError as e:
    print("blocked:", e)   # blocked: RED basis cannot have commercial_ok=True.
```

**Why model_validator (fail-closed) over a separate lint.** The Lumina precedent enforces the gate via the
`/sources-lint` command + a PreToolUse hook nudge — a *post-hoc* audit. On the new Python stack we move
enforcement *into the type*: a `commercial_ok=True` with a non-GREEN basis (or no ledger row) **cannot be
constructed**. The lint still runs in CI as defense-in-depth (it catches the path that *claims* GREEN with a
ledger row that no longer exists), but the *type* makes the most dangerous illegal states unrepresentable at
the source. This is the "make illegal states unrepresentable" discipline applied to licensing.

### 6.3 The composite default and the contamination rule (`briefing.ts` → the new stack)

A composite series (a market summary, a "daily briefing", a derived index, a blended sentiment score) is
**only as GREEN as its *reddest* input.** This is the **contamination rule**, and it's the single rule most
likely to be violated by a clean-looking aggregate.

- **Lumina's precedent.** The `briefing.ts` / market-summary composite defaults `commercialOk:false`. Only if
  *every* contributing series is GREEN can the composite be GREEN. A composite that mixes GDELT tone (GREEN)
  with a Yahoo-pathed quote (RED) is **RED** — the RED input contaminates the whole.
- **The JPM red-team framing** names this as proof-target **F2**: prove *"a composite that inherits a RED
  input yet claims GREEN (the contamination rule)."*
  ([`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md).)

The new-stack helper, derived directly from the model above:

```python
def compose(parts: list[Provenance], source: str, fetch_path: str) -> Provenance:
    """A composite is GREEN only if ALL inputs are GREEN. The reddest input wins (contamination rule).

    Attribution accumulates: every contributing GREEN source that REQUIRES attribution must still render.
    """
    all_green = all(p.commercial_ok for p in parts)
    if not all_green:
        # one RED input ⇒ the whole composite is RED. No exceptions, no "it's mostly green".
        attributions = "; ".join(sorted({p.attribution for p in parts if p.attribution}))
        return red(source=source, fetch_path=fetch_path, attribution=attributions)

    # all GREEN: the composite inherits the UNION of attribution obligations + the strictest basis.
    # (If any input is CC-BY, the composite must render that input's attribution.)
    needs_attr = any(p.basis in _ATTRIBUTION_REQUIRED_BASES for p in parts)
    basis = LicenseBasis.CC_BY_ODC_BY if needs_attr else LicenseBasis.US_GOV_PUBLIC_DOMAIN
    attributions = "; ".join(sorted({p.attribution for p in parts if p.attribution}))
    ledger = "+".join(sorted({p.ledger_row for p in parts if p.ledger_row}))
    return green(source=source, fetch_path=fetch_path, basis=basis,
                 ledger_row=ledger or "composite", attribution=attributions)
```

```python
# A composite of two GREEN inputs → GREEN, attribution accumulated:
gdelt = green("GDELT", "api.gdeltproject.org/doc", LicenseBasis.CC_BY_ODC_BY,
              "gdelt-doc-2026-06-23", "Source: The GDELT Project (gdeltproject.org)")
treasury = treasury_prov
daily = compose([gdelt, treasury], "Daily Macro Briefing", "internal:briefing/daily")
assert daily.commercial_ok is True
assert "GDELT" in daily.attribution  # GDELT's required citation still renders on the composite

# Add ONE red input → the whole composite goes RED (contamination):
yahoo_quote = red("Yahoo Finance", "query1.finance.yahoo.com/v8/...")
daily2 = compose([gdelt, treasury, yahoo_quote], "Daily Briefing v2", "internal:briefing/daily")
assert daily2.commercial_ok is False   # one RED input contaminated the aggregate
```

**Why the reddest input wins, mechanically.** Displaying the composite *is* displaying every input that
materially shaped it. If one input is RED, the composite's display redistributes that RED input's value
(possibly obfuscated by aggregation, which is *not* a license-laundering operation — derivation doesn't erase
the upstream contract). So the composite cannot be more permissive than its least-permissive input. This is
why the default for *any* aggregate is `false`, and GREEN is earned only by an all-GREEN input set.

---

## 7. The end-to-end discipline for the ingest pipeline (where this lands in the build)

This product line **persists and redistributes**, so the gate isn't a display-time afterthought — it's an
**ingest-time** decision that travels with the bytes forever. The order of operations:

1. **At the fetcher (the only place that knows the real path).** Construct the `Provenance` stamp from the
   *actual* `(host, endpoint, tier, ToS/statute)` tuple — not the concept, not the intended path, the path
   you *used*. Default `red()`. Promote to `green()` only with a named basis **and** a verified ledger row.

2. **Persist the stamp alongside the series** (one provenance row per series/version) in the warehouse.
   Model it on **W3C PROV-O** for transferable lineage: the series is a `prov:Entity`, the fetch is a
   `prov:Activity`, the source is a `prov:Agent`; `prov:wasGeneratedBy` links the series to the fetch,
   `prov:wasAttributedTo` links it to the source, `prov:wasDerivedFrom` carries composite lineage.
   ([w3.org/TR/prov-o](https://www.w3.org/TR/prov-o/): `prov:Entity` = *"a physical, digital, conceptual …
   thing"*; `prov:Activity` = *"something that occurs over a period of time and acts upon or with entities"*;
   `prov:Agent` = *"something that bears … responsibility"*.) The `commercialOk` boolean is the
   *machine-actionable projection* of that fuller lineage — keep both: PROV for the audit trail, the boolean
   for the hot gate.

3. **The serve path reads the gate, never re-derives it.** A public endpoint serving a series checks the
   *persisted* `commercial_ok`. A `false` series is **never** emitted on a public commercial surface — it is
   either withheld or served only on an *informational, attributed* surface that the product explicitly marks
   as such (§4.1).

4. **Composites are gated by the contamination rule** (§6.3) at *compute* time, with the union of attribution
   obligations carried onto the output.

5. **CI lint as defense-in-depth.** A `/sources-lint`-class check audits the codebase/ledger for any
   `commercial_ok=True` whose `ledger_row` is missing or stale, mirroring the Lumina enforcement. The type's
   fail-closed validator catches *construction*; the lint catches *drift* (a ledger row deleted after the code
   shipped).

6. **The two gates run in series** (§5): a series ships only if `commercial_ok and grounded`. The grounding
   gate (dedup/restatement for EDGAR, units/timezone normalization, `unavailable`-on-failure) is the subject
   of the sibling `data-normalization` skill; this skill owns only the licensing gate. They are independent and
   both mandatory.

---

## 8. Pre-mortem — how this gate fails in production, and the defense baked in

Per the cto-rules pre-mortem discipline, "six months out, this failed — why?":

| Failure | Mechanism | Defense in this design |
|---|---|---|
| **A RED series got persisted and re-served as ours.** | A fetcher stamped the *intended* GREEN path but actually fetched a RED door (key fell back to Demo; the GREEN endpoint 404'd and code silently used a RED mirror). | Stamp the path *actually used*; `red()` is the default; a failed GREEN fetch returns typed `unavailable`, **never** a RED backfill (§5.2). |
| **A CC-BY source displayed without attribution.** | Attribution sat in the payload, frontend never rendered it. | `_enforce_gate` requires non-empty `attribution` for CC-BY bases; a *render test* on the surface is the second half (frontend obligation). |
| **A composite claimed GREEN over a RED input.** | Aggregation "felt like" it laundered the input. | `compose()` enforces reddest-input-wins; the JPM F2 red-team target hunts exactly this. |
| **Free-tier → GREEN false promotion.** | "It returns data and it's free, ship it." | §3.1 + the closed `_GREEN_BASES` set + the ledger-row requirement: a free tier has no GREEN basis and no ledger row, so the type *blocks* `commercial_ok=True`. |
| **Silence read as permission.** | ToS didn't *forbid* display, so someone called it GREEN. | §3.3: silence ⇒ RED; the basis stays `RED` (the default) because no *express grant* exists to name. |
| **GREEN-but-wrong number shipped as fact.** | Licensing gate passed; correctness gate didn't exist. | §5: the two gates are independent and both mandatory; EDGAR-class sources carry a dedup/restatement obligation. |

---

## 9. Confidence levels and open questions

| Claim | Confidence | Basis |
|---|---|---|
| License attaches to fetch path, not concept | **High** | Repo's own canonical rule + JPM theory #5; grounded in data-licensing practice (Thomson Reuters) and the facts-not-copyrightable doctrine (Feist). |
| 17 U.S.C. §105 places US-federal-employee works in public domain | **High** | Primary statute text (Cornell LII), fetched verbatim 2026-06-24; ARL/GPO corroboration. |
| §105 carve-outs (contractor works; federal-only) | **High** | Statute notes + GPO guidance, fetched 2026-06-24. |
| Free tier ≠ display license | **High** | Verbatim ledger ToS rows + broad developer-survey corroboration; CME display/non-display split as the industry analogue. |
| Silent ToS ⇒ RED (conservative default) | **High** | Repo rule + Thomson Reuters "license grants limited rights, licensor retains the rest" + cost-asymmetry argument. |
| CC0 ≠ CC-BY (attribution obligation) | **High** | Creative Commons + Open Data Commons primary docs. |
| Composite contamination (reddest input wins) | **High** | `briefing.ts` precedent + JPM F2 red-team target; logically entailed by "displaying the composite displays each input". |
| Display/non-display is a real industry licensing split | **High** | CME policy text (verbatim) + TRG market-data-DRM framing. |

**Open questions (carry into the patterns docs / the ledger):**

1. **State, foreign, and intergovernmental sources** need their *own* classification rules — §105 does not
   reach them. The patterns recipe must extend the basis enum and the ledger to cover Crown Copyright,
   Eurostat/ECB terms, IMF/OECD per-product terms, and state-by-state public-records law.
2. **Derived-data licenses (CME-class 🟡 YELLOW).** A "Derived-Data License" is a distinct middle category our
   four-basis enum currently folds into RED. Decide whether to add a `DERIVED_DATA_LICENSED` GREEN-conditional
   basis once such a license is actually purchased.
3. **Static `commercialOk` vs full PROV/OpenLineage lineage** — the JPM theory's open question #4: is a
   per-series static stamp enough for v1, or is transform-lineage a hard requirement? This skill assumes the
   static boolean + a PROV-shaped record is sufficient for v1; the patterns docs revisit it.
4. **License-verdict automation at scale** (JPM open question #6): 20+ sources × hundreds of datasets needs a
   maintained ledger + CI lint. Manual-per-fetch-path is the v1 stance; classify the appetite to automate.

---

## 10. The one-paragraph summary every other doc in this skill assumes

A financial number carries no license; the **right to display or redistribute it commercially is a property
of the fetch path** — the specific `(source, endpoint, account-tier, governing ToS/statute)` — and of nothing
else. `commercialOk` is the machine-readable answer, **default `false`**, set `true` **only** on one of four
GREEN paths (US-gov public-domain per 17 U.S.C. §105; CC0/PDDL; CC-BY/ODC-BY *with rendered attribution*; or a
*purchased display tier*) and never on a free tier, never because "a competitor shows it", and never on a
silent/ambiguous ToS (silence ⇒ RED). **Access ≠ display:** a RED source may be *built against* for an
informational, attributed feature with the gate kept `false`, but — because this product line *persists and
redistributes* — writing a series into the warehouse is itself a *display* decision the same gate governs.
The licensing gate is **orthogonal** to the numeric-grounding gate: GREEN-but-wrong still violates "never
invent a number", so a series ships only if `commercialOk && grounded`. On the new Python stack this is a
fail-closed Pydantic `Provenance` type whose validator makes a fake-GREEN state unrepresentable, a
`compose()` that enforces reddest-input-wins (the contamination rule), and a PROV-O-shaped lineage record
behind the hot boolean.
