# patterns · The license-classification workflow — from a new source to a ledger row + verdict

> **Product line.** This reference belongs to the **`data-provenance-licensing` dev-skill** of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina**. That line is a *separate*
> product (the DataQuery / Fusion re-engineering, "Project 3"), built on a **new
> Python / FastAPI / data-engineering stack** — not Lumina's Bun + Express + Prisma + Supabase + Upstash
> stack. Nothing here is wired into Lumina's runtime; the two repos only share a filesystem home for the
> research ([`cto-rules.md`](../../../rules/cto-rules.md) §"Scope note").
>
> **What this doc is.** The **step-by-step recipe a builder runs** to classify a *new* data source and
> produce its two outputs: a **`commercialOk` verdict** and a **sources-ledger row** that records the
> verdict, the exact fetch path, and the load-bearing clause that justifies it. This is the operational
> core of *"a license-classification workflow at scale"* — the answer to the data-analytics theory's
> open-question #6: *"20+ sources × hundreds of datasets needs a maintained ledger + CI lint … appetite to
> automate license classification, or keep it manual per fetch-path?"*
> ([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
> §"Open questions").
>
> **Where it sits relative to its siblings.** The companion recipe
> [`patterns-provenance-stamping.md`](../../data-normalization-tet/references/patterns-provenance-stamping.md)
> (in the `data-normalization-tet` skill) is the **runtime** half — how a TET `Fetcher` *carries* a
> verdict that already exists by looking it up in the ledger. **This doc is the human half — how the
> verdict gets *into* the ledger in the first place.** The one-line division of labour:
> **classification (this doc) is human judgment that writes the ledger; stamping (the sibling) is code
> that reads the ledger and never re-decides.** A fetcher that adjudicates its own license is the single
> worst failure mode of the *runtime*; a builder who flips `commercialOk: true` without running the steps
> below is the single worst failure mode of the *classification*. Same gate, two ends.
>
> **The one rule this whole doc enforces.** **A verdict is the output of a documented procedure run
> against the GOVERNING document for the EXACT fetch path — never a reputation, a vibe, or a guess.**
> "Everyone uses Yahoo" is not a license. "It's just a price, and facts aren't copyrightable" is not a
> license. "The free tier exists, so they must allow it" is not a license. The only thing that clears a
> path to GREEN is a *quoted clause* from the *binding terms* for *that host/endpoint/key-tier*.

---

## 0. The thirty-second answer (read this first)

You found a new data source you want to ingest. Before a single byte of it is **stored, redistributed,
or displayed on a surface you charge for**, you run **six steps** and produce **two artifacts**:

1. **Pin the EXACT fetch path** — `host + endpoint + key-tier + the function name` that will call it
   (e.g. `api.worldbank.org/v2/country/all/indicator/...` · free keyless · `worldbank_indicators` fetcher).
   The license attaches here, not to "World Bank data" in the abstract.
2. **Locate the GOVERNING document** for *that path* — the specific ToS / data-license / statute that
   binds *that host at that key tier*. Not the data's general reputation; not a blog; not the homepage
   marketing copy. The contract or the statute.
3. **Quote the load-bearing clause verbatim** — the sentence(s) that decide commercial use,
   redistribution, public display, caching/storage, and AI/ML use. Copy them into the worksheet with a
   URL and a fetch date. If you can't find such a sentence, the silence *is* the finding (→ RED).
4. **Apply the decision tree** — public-domain / CC0 / CC-BY / a *purchased* display tier → **GREEN**
   (with conditions); free-tier / silent / ambiguous / NonCommercial → **RED**; an explicit AI-/ML-use ban
   → **REJECT** (do not integrate).
5. **Determine the attribution string + render obligation** — CC-BY and conditioned GREENs (World Bank,
   GDELT) are GREEN *only if* a specific credit renders on every surface that displays the data. Write the
   exact string and where it must appear.
6. **Write the ledger row** — `source | fetch path | verdict | governing clause (short)` — into
   [`sources-ledger.md`](../../../memory/sources-ledger.md) **before** the code ships, and set
   `commercialOk` to match (`true` only for a 🟢 GREEN row; default `false`).

The two artifacts are **the worksheet** (the evidence: quoted clauses + URLs + date, kept in the PR or a
`/licensing/<source>.md` file) and **the ledger row** (the durable one-line verdict the runtime and CI
read). The worksheet is *why*; the ledger row is *what*. If a future auditor asks "why is
`api.worldbank.org` GREEN?", the worksheet answers it; if `/sources-lint` asks "is this `commercialOk:
true` cleared?", the ledger row answers it.

At scale (20+ sources × hundreds of datasets) the same six steps run as a **per-source checklist with a
confirmation date**, batch-re-audited on triggers (ToS change, new key tier, a new endpoint on a
known host), and enforced — not *performed* — by CI. **The classification stays a human-judgment loop;
CI only catches drift between the code and the ledger.** §8 covers why a fully-automated ToS-parser is
the wrong build, and §9 walks one GREEN and one RED source end-to-end.

If that's all you needed, stop here. The rest is the exact procedure, the clause checklist, the decision
tree with edge cases, the scale machinery, the automation pitfalls, and two fully-worked examples.

---

## 1. Why classification is keyed to the FETCH PATH, not the concept

This is the load-bearing principle of the whole licensing layer, and it is the thing a junior build gets
wrong. Every step below exists to honour it, so read it carefully.

> **The license attaches to the FETCH PATH, not the concept.** The US-Treasury 10-year yield fetched from
> `home.treasury.gov` is public-domain **GREEN**; the *exact same number* fetched from Yahoo's chart API
> is **RED**. You cannot reason about licensing from the data *type* — only from *where you fetched it*.
> ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) §"The principle"; mirrored verbatim in
> the [sources-ledger header](../../../memory/sources-ledger.md).)

The reason this is true and not pedantic rests on a distinction that runs through all of data licensing:

- **A raw fact is not copyrightable.** A price, a yield, a temperature reading — a discrete fact — carries
  no copyright in the US, because copyright protects *original expression*, not facts (*Feist Publications
  v. Rural Telephone*, 499 U.S. 340 (1991)). The DCC's research-data guide makes the same point about
  jurisdictional variance: *"different aspects of a database – field values, field names, structure,
  interfaces, visualisations – may be treated quite differently"* and in the US *"simple sensor tables
  typically lack copyright"*
  ([dcc.ac.uk — How to License Research Data](https://www.dcc.ac.uk/guidance/how-guides/license-research-data),
  fetched 2026-06-24).
- **But the database, the API, and the right to take from them are governed by contract.** The provider's
  **Terms of Service is contract law, not copyright law.** When you accept a ToS (by signing up for a key,
  by using the API), you are bound by its grant of rights regardless of whether the underlying facts are
  copyrightable. This is *why* "facts aren't copyrightable" never clears a path: the ToS can — and
  routinely does — forbid redistribution of facts you'd otherwise be free to copy.
- **Therefore two rows holding the identical numeric value can carry opposite verdicts**, because they
  were fetched from different hosts under different contracts. `4.27%` from `home.treasury.gov` (a
  public-domain dedication, 17 USC §105) and `4.27%` from `query1.finance.yahoo.com` (a ToS with no
  commercial-display grant) are the *same number* with *opposite* display rights.

Three consequences that the six-step procedure encodes:

1. **`commercialOk` is a property of the `(fetch path) × (point in time the ToS said what it said)` pair**,
   never of the series concept. That is why Step 1 is "pin the path" and why every ledger row has a
   confirmation date (§7.2) — the ToS can change under you.
2. **An aggregator host is NOT a license layer.** `FRED` (`api.stlouisfed.org/fred`) hosts both Fed-owned
   public-domain series **and** third-party copyrighted series (CBOE's `VIXCLS`, ICE's rates). FRED's API
   terms state plainly: *"Redistributing copyrighted data series for commercial use is not allowed unless
   the data copyright owner authorizes it"*
   ([fred.stlouisfed.org/docs/api/terms_of_use.html](https://fred.stlouisfed.org/docs/api/terms_of_use.html)).
   So FRED's verdict is **per-series, not per-host** — the fetch-path key must include the series id, and
   the ledger row is the `(FRED, series-id)` pair. The same per-series carve-out applies to World Bank /
   OECD / IMF, which mix self-produced (CC-BY) indicators with third-party feeds that *"may not be
   redistributed or reused without the consent of the original data provider"*
   ([datacatalog.worldbank.org/public-licenses](https://datacatalog.worldbank.org/public-licenses),
   fetched 2026-06-24).
3. **Verdicts have a half-life.** A 2021 ToS that was silent on AI/ML was effectively GREEN-for-display and
   ambiguous-for-AI; the same provider's 2025 ToS may explicitly ban "machine learning and/or artificial
   intelligence" use (Kalshi's does — see §4.5). The recent *Fastcase v. Alexi* litigation (filed Nov 2025)
   is the entire risk in one case: a *"2021 agreement – entered into before generative AI was a generally
   known technology"* is now contested over whether AI training was *"internal research"* and whether
   showing results to users was *"publication"*
   ([Proskauer — Data License Restrictions in the AI Spotlight](https://www.proskauer.com/blog/data-license-restrictions-in-the-ai-spotlight-careful-drafting-is-more-important-than-ever),
   2025). The lesson the workflow bakes in: **a verdict is true as of its confirmation date and no
   longer**, which is why §7 makes re-confirmation a first-class discipline.

---

## 2. The two outputs and the worksheet that produces them

Before the steps, fix the data shapes so the procedure has a target.

### 2.1 The ledger row (the durable output)

The row is one line in [`sources-ledger.md`](../../../memory/sources-ledger.md), in the existing table
format. The columns are fixed by the ledger and read by both the runtime stamp and `/sources-lint`:

```
| Source | Fetch path | Verdict | Governing clause (short) |
```

A real GREEN row and a real RED row from the live ledger, so the format is unambiguous:

```
| World Bank | api.worldbank.org | 🟢 GREEN | CC-BY 4.0 (attribution). |
| CoinGecko Demo | api.coingecko.com (demo key) — getCrypto | 🔴 RED | Demo scoped to personal use; "Powered by CoinGecko" required; redistributing data as your own = prohibited. |
```

The verdict legend (also fixed by the ledger header):

| Glyph | Verdict | Meaning |
|---|---|---|
| 🟢 | **GREEN** | Displayable: public-domain / CC0 / CC-BY (+ attribution rendered), or a purchased display tier. → `commercialOk: true`. |
| 🟡 | **YELLOW** | Conditional / a derived-data license is needed before display (e.g. CME-derived). → `commercialOk: false` until the license is bought; may be *built against* informationally. |
| 🔴 | **RED** | Not for public display on this (free) path. → `commercialOk: false`. May still be *accessed* for an informational, attributed feature — RED gates the **display license**, not the **access**. |
| ⛔ | **REJECT** | The ToS forbids the use outright (caching, display, **or** AI/ML). → **do not integrate at all.** |

### 2.2 The worksheet (the evidence output)

The worksheet is what makes the verdict *auditable* and *re-runnable*. Keep it in the PR description, or —
better at scale — as a checked-in file `licensing/<source-slug>.md`. It is the per-source checklist of §7,
filled in. Minimum fields:

```markdown
# Licensing worksheet — World Bank Indicators API
- fetch_path: api.worldbank.org/v2/country/all/indicator/{id}  · keyless free  · fetcher: worldbank_indicators
- governing_doc: https://datacatalog.worldbank.org/public-licenses  (Data Catalog "Data Access and Licensing")
- governing_doc_fetched: 2026-06-24
- clauses:
  - commercial_use:  "allows users to copy, modify and distribute data in any format for any purpose, including commercial use"   [QUOTED, GREEN-supporting]
  - redistribution:  same clause permits "distribute … in any format for any purpose"                                            [QUOTED, GREEN-supporting]
  - display:         (subsumed by "any purpose")                                                                                  [INFERRED]
  - caching/storage: (not separately restricted for CC-BY datasets)                                                              [SILENT → permitted under CC-BY]
  - ai_ml_use:       (CC-BY 4.0 grants reuse "for any purpose"; no AI carve-out)                                                  [SILENT → permitted under CC-BY]
  - carve_out:       "Some datasets and indicators are provided by third parties, and may not be redistributed or reused without the consent of the original data provider"   [CRITICAL — per-series carve-out]
- verdict: 🟢 GREEN (with conditions)
- conditions:
  - attribution string MUST render: "Source: World Bank, World Development Indicators. Licensed under CC BY 4.0." + indicate changes
  - per-series gate: ONLY World-Bank-produced indicators; third-party indicators stay RED (Step-2 sub-check)
- commercialOk: true   (for World-Bank-produced indicators only)
- confirmed_by: <you>   confirmed_on: 2026-06-24   recheck_due: 2027-06-24
```

The worksheet's job is that a *different* engineer, a year later, can read it and either trust the verdict
or spot exactly which clause to re-check. **No worksheet → the verdict is a vibe → default RED.**

---

## 3. Step 1 — Pin the EXACT fetch path

The whole edifice rests on identifying *the precise thing the license binds*. A loose path ("World Bank")
silently averages GREEN and RED sub-feeds; a tight path (`host + endpoint-family + key-tier + fetcher
name`) is classifiable.

### 3.1 What goes into a fetch-path key

A fetch path is a stable string built from the parts of the request that can *change the governing terms*:

| Component | Why it matters | Example |
|---|---|---|
| **Host** | The contract owner. `data.sec.gov` (US gov) vs `query1.finance.yahoo.com` (Yahoo ToS) are different licensors of the same fact. | `api.worldbank.org` |
| **Endpoint / API family** | One host can serve free public-domain and paid proprietary endpoints under different terms. | `/v2/country/all/indicator/{id}` |
| **Key tier** | **The single most important and most-missed component.** The *same host* gives `Demo` (personal-use) and `Pro` (display-licensed) tiers wildly different rights. A path without the tier is unclassifiable. | `demo key` vs `pro key` |
| **Series id (when the host is an aggregator)** | FRED/World-Bank/IMF mix owned + third-party series; the verdict is per-series. | `(FRED, GDP)` GREEN vs `(FRED, VIXCLS)` RED |
| **The function name** | Ties the abstract path to the code, so `/sources-lint` can bridge a `commercialOk:true` in code to the ledger row. On this stack that's the TET `Fetcher` / sources fetcher name. | `worldbank_indicators` |

A canonicaliser (the one the runtime stamp uses too — see the sibling
[`patterns-provenance-stamping.md`](../../data-normalization-tet/references/patterns-provenance-stamping.md))
turns a live URL into this key deterministically:

```python
from urllib.parse import urlsplit

def fetch_path_key(url: str, *, key_tier: str, fetcher: str, series_id: str | None = None) -> str:
    """Canonical, license-relevant key for a fetch path.

    Drops query params that don't change the governing terms (api keys, pagination,
    date ranges) but KEEPS the parts that do (host, endpoint family, key tier, and —
    for aggregator hosts — the series id). This is the string a ledger row is keyed on.
    """
    parts = urlsplit(url)
    host = parts.netloc.lower()
    # Collapse path templating: /country/USA/indicator/NY.GDP.MKTP.CD -> /country/{c}/indicator/{id}
    segments = []
    for seg in parts.path.strip("/").split("/"):
        # crude templating: anything that looks like a code/id becomes a placeholder
        segments.append("{id}" if _looks_like_an_id(seg) else seg)
    endpoint = "/" + "/".join(segments)
    key = f"{host}{endpoint} | tier={key_tier} | fetcher={fetcher}"
    if series_id is not None:                 # aggregator hosts: license is per-series
        key += f" | series={series_id}"
    return key
```

The point is not the regex (templating is best done explicitly per provider); the point is that **the key
includes `tier` and, for aggregators, `series` — the two components a junior path drops and a correct path
keeps.**

### 3.2 The aggregator-host sub-check

Before leaving Step 1, ask one question that decides whether you have *one* fetch path or *many*:

> **Does this host serve series from more than one licensor?**

If yes (FRED, World Bank, OECD, IMF, Quandl/Nasdaq Data Link, any "data marketplace"), then **the host is
a distribution layer, not a license layer**, and you must classify **per series id**, not per host. FRED
is the canonical trap: Fed-owned series are public-domain GREEN, but `VIXCLS` is CBOE-copyrighted RED, and
the *same API* serves both. Skipping this sub-check is how a "FRED is GREEN" row launders a CBOE RED series
into a `commercialOk:true` display.

### 3.3 Output of Step 1

A canonical fetch-path key (or a small *set* of keys, if the aggregator sub-check fired), written into the
worksheet's `fetch_path` field. Everything downstream classifies *that key*, not the source's brand.

---

## 4. Step 2–3 — Find the GOVERNING document and quote the load-bearing clauses

Steps 2 and 3 are tightly coupled (find the doc, then mine it), so they share a section. This is where most
of the *work* lives, and where most of the *errors* hide.

### 4.1 Step 2 — Locate the GOVERNING document for THAT path

The governing document is the *binding terms for the host at the key tier you'll use* — not the homepage,
not a blog, not the data's reputation. There is a hierarchy of where it lives, in order of authority:

1. **A statute** (for government sources). US federal works are public domain *by law*: *"Data and content
   created by government employees within the scope of their employment are not subject to domestic
   copyright protection under 17 U.S.C. § 105"*
   ([resources.data.gov/open-licenses](https://resources.data.gov/open-licenses/), fetched 2026-06-24).
   The statute *is* the governing document — there is nothing to negotiate. (But note §4.6: a statute
   other than copyright can still gate use — the Ethics-in-Government-Act trap.)
2. **A named open license** (CC0, CC-BY, ODbL, PDDL). If the source declares "this dataset is CC-BY 4.0",
   the governing document is *the license deed + legal code*, and the license terms control. World Bank:
   *"CC-BY 4.0 … is the default license for all Datasets produced by the World Bank itself"*
   ([datacatalog.worldbank.org/public-licenses](https://datacatalog.worldbank.org/public-licenses)).
3. **An API-specific Terms of Service** (most commercial vendors). CoinGecko, Twelve Data, Polygon,
   Tiingo, Yahoo. This is usually at `/<vendor>/api_terms` or `/legal/api`, *distinct from* the website
   ToS. Find the **API** terms, not the site terms — they differ.
4. **A data-license / derived-data agreement** (for proprietary series). CME, ICE, CBOE require a
   *Derived Data License* before you may display anything computed from their data. ICE publishes a
   form: `ICE_Data_Form_of_Derived_Data_License_Agreement.pdf`. If the vendor has one of these, the free
   API tier almost never includes it.

**Finding-the-doc failure modes (each one is a real way a verdict goes wrong):**

- **Reading the marketing page, not the contract.** "CoinGecko provides the most comprehensive crypto
  data" tells you nothing about *your* right to display it. Find `/en/api_terms`.
- **Reading the *website* ToS instead of the *API* ToS.** They are different contracts with different
  grants. The API terms govern the API fetch path.
- **Reading the *wrong tier's* terms.** A vendor's "commercial license" page describes the *paid* tier;
  the *free/Demo* tier is governed by the base API ToS plus the plan description on the pricing page. You
  must read the terms *for the tier you will actually call*.
- **Trusting a third-party summary.** A StackShare/blog claim ("ArcticDB stores in Parquet"; "Tiingo's
  $250 tier is a display license") is a *hypothesis*, not a source. The data-analytics theory caught
  exactly this: the published Tiingo $250/mo tier is *"internal-use only, NOT a priced display SKU"* per
  the *actual* terms ([sources-ledger](../../../memory/sources-ledger.md), Tiingo row). Read the primary
  contract.

### 4.2 Step 3 — Quote the load-bearing clauses verbatim

Open the governing document and extract the sentences that decide **five questions**. Copy them *verbatim*
(with section number if present) into the worksheet — paraphrase loses the operative words ("internal",
"personal", "redistribute", "publicly display", "machine learning"). The five questions, in the order they
most often decide the verdict:

| # | Clause to find | What you're looking for | RED signal words | GREEN signal words |
|---|---|---|---|---|
| **C1** | **Commercial use** | May the data be used commercially / for profit / in a product you charge for? | "personal use", "internal use", "non-commercial", "for evaluation only" | "for any purpose, including commercial use" |
| **C2** | **Redistribution** | May you pass the data to *third parties* / your end users? | "shall not redistribute, sell, sub-license, syndicate", "internal consumption only" | "distribute … in any format", "share and adapt" |
| **C3** | **Public display** | May you *show* the data on a surface others see? | "not for public display", "no publication" | "display", "publish", "any purpose" |
| **C4** | **Caching / storage** | May you *store* a copy (the warehouse depends on this)? | "no caching", "no archived or cached data sets", "ephemeral use only" | (silence under CC-BY/PD = permitted) |
| **C5** | **AI / ML use** | May the data train / fine-tune / ground an AI system? | "no machine learning", "no artificial intelligence", "no training", "no LLM" | (PD/CC0/CC-BY "any purpose" covers it) |

The clause families and their canonical wording come straight from the legal literature on data licensing.
On redistribution: *"Except as expressly permitted, licensees will not redistribute, license, retransmit,
or rebroadcast the Contents or Derived Product or any portion thereof"*
([Law Insider — Data License sample clauses](https://www.lawinsider.com/clause/data-license)). On caching:
*"Under no circumstance will licensees, directly or indirectly, use, copy, modify, decompile, disassemble,
scrape, cache, frame, mask, correlate, or apply any process to data"* — caching is *named* as a restricted
act, which is why C4 is its own line and not folded into "use"
([Law Insider](https://www.lawinsider.com/clause/data-license)). On scope generally: *"the license might
limit data use to internal marketing purposes"* — the grant is an *enumerated* set of permitted uses, and
anything not enumerated is *not granted*
([Thomson Reuters — Data licensing](https://legal.thomsonreuters.com/en/insights/articles/data-licensing-taking-into-account-data-ownership)).

**The default-deny reading.** A data license is a *grant of enumerated rights*, so the correct reading of
silence is **"not granted" = RED**, never "not forbidden = OK". If the ToS lists "you may use the data for
internal analysis" and says nothing about display, **display is not granted.** This is the inverse of how
people read *prohibition* lists, and getting it backwards is the most common classification error. The
in-repo gate states it flatly: *"When a ToS is silent or ambiguous about commercial redistribution/display,
the verdict is RED"* ([commercial-ok-gate.md](../../../rules/commercial-ok-gate.md)).

### 4.3 The "what counts as commercial use?" trap (C1 is genuinely hard)

C1 looks binary but is the *most* litigated clause, because **"commercial" is not crisply defined even by
the people who write the licenses.** Creative Commons — the authors of the NC clause — say so directly:

> *"NonCommercial means not primarily intended for or directed towards commercial advantage or monetary
> compensation."* … *"There will always be uses that are challenging to categorize as commercial or
> noncommercial, and Creative Commons cannot advise you on what is and is not commercial use."*
> ([wiki.creativecommons.org/wiki/NonCommercial](https://wiki.creativecommons.org/wiki/NonCommercial);
> [CC FAQ](https://creativecommons.org/faq/), fetched 2026-06-24)

A CC study found *"significantly differing interpretations of 'non-commercial' exist, with the majority of
users tending to identify 'commercial' with 'for profit'"* — and even that majority splits on
advertising-supported and cost-recovery uses
([CC — Defining Noncommercial report](https://creativecommons.org/2009/09/14/defining-noncommercial-report-published/)).

**The workflow's rule for this ambiguity is the same as for all ambiguity: ambiguity → RED.** If C1's
answer is "it depends what you mean by commercial" and your product *is* a commercial product (a paid data
service, an ad-supported app), then a NonCommercial / personal-use source is **RED for you**, full stop.
You do not get to argue your way into the gray zone — *"the failure this rule prevents is shipping a Tier-1
implementation while believing it's Tier-3"* applied to licensing is **shipping a RED source while
believing the gray zone is GREEN.** (The data-analytics product is unambiguously a commercial data
service, so any NC source is RED by construction.)

### 4.4 The C5 / AI-ML clause is now a first-class question

Until ~2023 most ToS were silent on AI, and a builder could treat "use the data" as covering "ground an
LLM with the data." That era is over. Two facts make C5 a separate, mandatory line:

1. **New ToS increasingly ban it explicitly.** *"New license agreements in 2025 increasingly include
   prohibitions on using products for machine learning, algorithmic development, testing or enhancing, or
   any other artificial intelligence purposes, and for creating, using or inputting content into Large
   Language Models (LLMs)"*
   ([Proskauer](https://www.proskauer.com/blog/data-license-restrictions-in-the-ai-spotlight-careful-drafting-is-more-important-than-ever),
   2025). Kalshi's data ToS is the in-repo example: it bans *"machine learning and/or artificial
   intelligence"* use by name → **⛔ REJECT** ([sources-ledger](../../../memory/sources-ledger.md), Kalshi
   row).
2. **Old, AI-silent ToS are legally ambiguous, not safe.** *Fastcase v. Alexi* (filed Nov 2025) turns on
   exactly this: a 2021 license is now contested over whether AI training fit *"internal research"* and
   whether AI output to users was *"publication"*
   ([Proskauer](https://www.proskauer.com/blog/data-license-restrictions-in-the-ai-spotlight-careful-drafting-is-more-important-than-ever)).
   A silent-on-AI ToS gives you an *untested affirmative defense*, not a grant — and per §4.2's
   default-deny reading, **untested-and-silent → RED for AI use**, even where it's GREEN for plain display.

**Verdict consequence:** an *explicit* AI/ML ban is not "RED" — it is **⛔ REJECT**, the strongest verdict,
because it removes even the informational-access fallback that RED leaves open. You do not integrate the
source at all, not even to *access* it, because the act of running it through an AI pipeline is the named
prohibited act. RED says "don't *display* it on a free path"; REJECT says "don't *touch* it."

### 4.5 The C4 / caching clause gates the warehouse specifically

This product line **stores** data — the whole architecture is a materialized warehouse, *"compute-once,
store, serve"*, explicitly *not* a fetch-through proxy
([00-theory.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
§"Selected approach", CRITICAL-2). That makes **C4 (caching/storage) load-bearing in a way it isn't for a
live-proxy app.** A source whose ToS forbids *"providing archived or cached data sets"* (Kalshi's wording)
cannot be ingested into the warehouse *even for internal use* — the act of storing it is the prohibited
act. So for *this* product:

- A source that's RED-for-display but silent-on-caching can still be **fetch-through-only** (accessed live,
  never stored) for an informational feature.
- A source that **bans caching** cannot enter the warehouse path at all → it is REJECT for the warehouse
  even if it'd be merely RED for a proxy.

This is why C4 is its own checklist line and not folded into "use": for a storage product, the
caching clause can be *more* restrictive than the display clause.

### 4.6 The non-copyright statute trap (a public-domain source that's still gated)

GREEN-by-copyright does not mean GREEN-by-every-law. The in-repo Congressional-trading example: House/Senate
trade disclosures are public-domain under 17 USC §105 (no *copyright*), **but** the Ethics in Government Act
(5 USC §13107(c)(1)) makes it *"unlawful … to use a report … for any commercial purpose, other than by news
and communications media for dissemination to the general public"* — a separate statute, civil penalty up
to $10k ([sources-ledger](../../../memory/sources-ledger.md), Congressional-trading row). So the worksheet's
"governing document" search must ask **"is there *another* statute or regulation gating this use?"**, not
just "is it copyrighted?" A copyright-free source can still be **RED by statute**.

### 4.7 Output of Steps 2–3

The worksheet's `governing_doc` (URL + fetch date) and `clauses` block, with C1–C5 each either **quoted**
(verbatim, with section) or marked **SILENT** (and the default-deny reading applied). A clause you couldn't
find is recorded as SILENT, not skipped — silence is evidence, and it points the verdict toward RED.

---

## 5. Step 4 — Apply the decision tree

With C1–C5 quoted, the verdict is mostly mechanical. Walk the tree top-to-bottom; the **first** matching
node wins. (Order matters: REJECT is checked before everything, because an AI-ban overrides an otherwise-
GREEN display grant for *this* AI product line.)

```
                        ┌─────────────────────────────────────────────┐
                        │  Does C5 (AI/ML) or C4 (caching) EXPLICITLY  │
                        │  PROHIBIT the act this product performs?      │
                        │  (we store, and we run AI over data)          │
                        └───────────────┬─────────────────────────────┘
                                 yes    │    no
                          ┌─────────────┘             └──────────────┐
                          ▼                                          ▼
                     ⛔ REJECT                          ┌─────────────────────────────┐
              (do not integrate at all)                 │ Is the path PUBLIC-DOMAIN    │
                                                        │ (17 USC §105 / CC0 / PDDL)?  │
                                                        └────────┬────────────────────┘
                                                          yes    │    no
                                            ┌──────────────────┘      └────────────┐
                                            ▼                                       ▼
                              ┌──────────────────────────┐         ┌──────────────────────────────┐
                              │ ANOTHER statute gates the │         │ Is it CC-BY / ODC-BY          │
                              │ use? (e.g. EIGA §13107)   │         │ (attribution required)?       │
                              └───────┬──────────────────┘         └─────────┬────────────────────┘
                                 yes  │  no                            yes    │    no
                              ┌───────┘    └────────┐          ┌──────────────┘     └─────────────┐
                              ▼                      ▼          ▼                                   ▼
                          🔴 RED            🟢 GREEN     🟢 GREEN-with-attribution     ┌──────────────────────────────┐
                       (by statute)     (commercialOk:true)  (commercialOk:true,      │ Did we PURCHASE a commercial │
                                                              attribution MUST render) │ display/redistribution tier? │
                                                                                       └────────┬─────────────────────┘
                                                                                          yes   │   no
                                                                              ┌──────────────────┘   └──────────────┐
                                                                              ▼                                      ▼
                                                                   🟢 GREEN (licensed)          ┌──────────────────────────────────┐
                                                                  (commercialOk:true,           │ Is it CC-BY-SA / ODbL (share-     │
                                                                   keep the SKU/contract)       │ alike) or CC-BY-NC (non-commercial)│
                                                                                                │ or a FREE vendor tier / SILENT /  │
                                                                                                │ AMBIGUOUS?                         │
                                                                                                └───────────────┬──────────────────┘
                                                                                                                ▼
                                                                                                            🔴 RED
                                                                                                     (commercialOk:false;
                                                                                                  may be fetch-through-only
                                                                                                   for informational use)
```

### 5.1 The tree as a table (the version you actually grade against)

| Path characteristic (from C1–C5) | Verdict | `commercialOk` | Note |
|---|---|---|---|
| Explicit **AI/ML ban** (C5) or **caching ban** (C4) that this product would violate | ⛔ **REJECT** | n/a — don't integrate | Strongest verdict. Removes even informational access. |
| **US-gov public domain** (17 USC §105), no *other* statute gating | 🟢 **GREEN** | `true` | SEC EDGAR, Treasury, BLS, BEA, CFTC. |
| US-gov public domain **but** another statute gates commercial use | 🔴 **RED** by statute | `false` | Congressional-trading / EIGA §13107. |
| **CC0 / PDDL** (public-domain dedication) | 🟢 **GREEN** | `true` | No attribution required, but rendering source is courteous. |
| **CC-BY / ODC-BY** (attribution required) | 🟢 **GREEN with attribution** | `true` *iff* the credit renders | World Bank, OECD, IMF, GDELT (conditioned). Attribution is a *condition of the grant* — un-attributed = unlicensed. |
| **Purchased** commercial display/redistribution tier | 🟢 **GREEN (licensed)** | `true` | Keep the SKU + contract in the worksheet; verdict dies if the subscription lapses. |
| **CC-BY-SA / ODbL** (share-alike / copyleft) | 🔴 **RED** for this use | `false` | Share-alike would force *our whole product* under the copyleft license — incompatible with a proprietary data service. Treat as RED unless legal signs off. |
| **CC-BY-NC** (non-commercial) | 🔴 **RED** | `false` | We are a commercial product; NC excludes us (§4.3). |
| **Free vendor tier** (Demo/Basic personal-use) | 🔴 **RED** | `false` | "A free API tier is NOT a display license." May be fetch-through-only. |
| **Silent / ambiguous** on display or redistribution | 🔴 **RED** | `false` | Default-deny: silence is not a grant. |
| **Derived-data** from a proprietary index (CME/ICE/CBOE) without the derived-data license | 🟡 **YELLOW** | `false` | Needs a Derived-Data License before display; build against it informationally meanwhile. |

### 5.2 The share-alike (copyleft) sub-rule deserves its own paragraph

CC-BY-SA and ODbL are *open* licenses, so a junior reflex files them under GREEN. **They are RED for a
proprietary product** for a structural reason the DCC guide names exactly: *"The problem with copyleft
licences is they prevent the licensed data being combined with data released under a different copyleft
licence: the derived dataset would not be able to satisfy both sets of licence terms simultaneously"*
([dcc.ac.uk](https://www.dcc.ac.uk/guidance/how-guides/license-research-data)). Worse for us: building a
*commercial* service *on* ODbL data can trigger the share-alike obligation on the *output database* — i.e.
force our catalog open. Unless legal explicitly clears a specific ODbL/CC-BY-SA dataset, the workflow
verdict is **RED**. (This is also why the in-repo GREEN spine is all PD + CC-BY, never share-alike.)

### 5.3 Output of Step 4

The `verdict` field in the worksheet (one of 🟢/🟡/🔴/⛔) and the provisional `commercialOk` boolean. For
anything 🟢, continue to Step 5 (attribution). For 🔴/🟡, `commercialOk: false` and you're nearly done —
record whether the source may be *fetch-through-only* (RED, silent-on-caching) or built-against-
informationally (RED/YELLOW). For ⛔, stop — do not write a "use this anyway" row.

---

## 6. Step 5 — Determine the attribution string + render obligation

A GREEN verdict from CC-BY (or a conditioned source like GDELT/World Bank) is GREEN **only while the
required credit renders on the surface that displays the data.** Attribution is not decoration — it is *the
condition that makes the grant valid*. An un-attributed CC-BY display is an *unlicensed* display, even
though the source is "GREEN." So Step 5 produces a concrete string and a concrete *where*.

### 6.1 What CC-BY 4.0 actually requires

CC-BY's attribution obligation has four parts (the "TASL" set): **T**itle, **A**uthor (creator), **S**ource
(link), **L**icense (name + link), plus an indication if you modified the data. For World Bank that
resolves to a specific string:

> **Required:** *"Users are only obligated to give appropriate credit (attribution) and indicate if they
> have made any changes."*
> ([datacatalog.worldbank.org/public-licenses](https://datacatalog.worldbank.org/public-licenses))

A compliant rendered string for a World Bank indicator:

```
Source: World Bank — World Development Indicators (NY.GDP.MKTP.CD).
Licensed under CC BY 4.0. Retrieved <date>; modified (resampled to UTC daily).
```

### 6.2 Conditioned GREENs whose attribution wording is *mandatory and exact*

Some GREENs specify the *exact* credit string, and a paraphrase breaks the license:

| Source | Mandatory string | Where it must render |
|---|---|---|
| **GDELT** | `Source: The GDELT Project (gdeltproject.org)` — verbatim + a link | *Every surface* that shows the tone/volume number, "not just sit in the payload" ([sources-ledger](../../../memory/sources-ledger.md), GDELT row). |
| **CoinGecko (paid tiers only)** | `Powered by CoinGecko` *or* `Data provided by CoinGecko`, font ≥ size 10, with a hyperlink | Prominent, legible — but note this only *unlocks* display on a **paid** tier; the **Demo** tier is RED regardless of attribution (§9.2). ([coingecko.com/en/api_terms](https://www.coingecko.com/en/api_terms) §4.4) |
| **World Bank** | CC-BY credit + "indicate changes" | The display surface. |

The attribution string is therefore a **machine-readable field on the provenance stamp** (the sibling
[`patterns-provenance-stamping.md`](../../data-normalization-tet/references/patterns-provenance-stamping.md)
carries it through to the catalog and the Parquet sidecar), *and* a **contract on the render layer** — the
frontend/SDK MUST surface it. A GREEN row whose attribution never renders is a licensing violation hiding
behind a `true` gate. Record in the worksheet: the exact string, where it renders, and the fact that
sub-licensees must pass it through (CC-BY's attribution travels downstream).

### 6.3 Output of Step 5

The `conditions` block: the verbatim attribution string, the render location, and any pass-through
obligation. If a GREEN source has *no* attribution requirement (CC0 / pure public domain), record
"attribution: none required" explicitly — so a future auditor knows it was *checked*, not *forgotten*.

---

## 7. Step 6 + scale — writing the row, and running this for 20+ sources

### 7.1 Step 6 — write the ledger row BEFORE shipping, set `commercialOk` to match

The ledger row is the last step and the *gating* step: **no code that fetches the source ships before its
row exists.** The discipline is stated in the ledger's own maintenance section: *"Adding a source? Add a
row here **before** shipping it. `/sources-lint` audits code for `commercialOk:true` without a matching 🟢
row"* ([sources-ledger](../../../memory/sources-ledger.md), Maintenance). Concretely:

1. Add the row to the correct ledger table (Market data / Prediction markets / Government / Hard RED traps).
2. Set the fetcher's `Provenance.commercialOk` to **exactly** what the verdict says — `true` only for 🟢,
   `false` for everything else. **Default `false`** if you're unsure; an under-claim is safe, an
   over-claim is the violation.
3. If 🟢-with-attribution, wire the attribution string into the stamp *and* confirm the render layer shows
   it (Step 5's render contract).
4. Commit the worksheet alongside the code (PR description or `licensing/<source>.md`).

The PreToolUse hook ([`precheck-licensing.mjs`](../../../hooks/precheck-licensing.mjs)) fires the moment an
edit introduces `commercialOk:true`, nudging: *"verify it has a 🟢 GREEN row … A free API tier is NOT a
display license. If there is no GREEN row, keep it false."* That nudge is your reminder that Step 6 must
already be done — the hook is a backstop, not the procedure.

### 7.2 The "every verdict has a confirmation date" discipline

A verdict is **true as of the day you read the ToS, and no longer** (§1, consequence 3). At one source you
remember when you checked; at 20+ sources × hundreds of datasets you do not. So every row's worksheet
carries:

```
confirmed_by: <engineer>      confirmed_on: 2026-06-24      recheck_due: 2027-06-24
```

- **`confirmed_on`** — the date the governing document was read. This is the *only* date that matters for
  "is this verdict current?"
- **`recheck_due`** — `confirmed_on + 12 months` for stable government/CC sources; `+ 6 months` for
  commercial-vendor ToS (which change more often and more adversarially, per the 2025 AI-clause wave).
- The ledger stays a clean one-liner; the *date* lives in the worksheet. (Optionally, append a tiny
  `(conf. 2026-06)` to the ledger's clause column for the highest-risk vendor rows.)

### 7.3 The per-source checklist template (the artifact you copy for each new source)

This is the §3–§6 procedure compressed into a fill-in-the-blanks checklist. Copy it per source. At scale,
this *is* the workflow — a builder who runs the checklist cannot skip a step, and a reviewer can see at a
glance which line is unfilled.

```markdown
## Licensing checklist — <SOURCE NAME>
- [ ] STEP 1 — fetch path pinned:  host=______  endpoint=______  tier=______  fetcher=______
      - [ ] aggregator sub-check: does this host serve >1 licensor? if yes → classify PER SERIES
- [ ] STEP 2 — governing doc located:  url=______   (API terms, NOT site terms; tier-specific)   fetched=______
      - [ ] confirmed it's the binding contract for THIS tier, not the paid-tier marketing page
- [ ] STEP 3 — clauses quoted verbatim:
      - [ ] C1 commercial use:     "______"            (or SILENT → lean RED)
      - [ ] C2 redistribution:     "______"            (or SILENT → lean RED)
      - [ ] C3 public display:     "______"            (or SILENT → lean RED)
      - [ ] C4 caching/storage:    "______"            (WAREHOUSE-CRITICAL: a ban here = REJECT for storage)
      - [ ] C5 AI/ML use:          "______"            (explicit ban = REJECT; SILENT = RED for AI use)
      - [ ] other-statute check:   "______"            (copyright-free can still be RED by statute)
- [ ] STEP 4 — decision tree applied:  verdict = 🟢 / 🟡 / 🔴 / ⛔
- [ ] STEP 5 — attribution:  required? Y/N   string="______"   renders where? ______   pass-through? Y/N
- [ ] STEP 6 — ledger row written + commercialOk set:
      `| <source> | <fetch path> | <verdict> | <clause short> |`   commercialOk = ______
- [ ] worksheet committed:  confirmed_by=______  confirmed_on=______  recheck_due=______
```

### 7.4 Batch re-audit triggers (when to re-run the checklist on existing rows)

Re-classification is not only calendar-driven. Re-run the checklist for a source on any of these events:

| Trigger | Why | Scope of re-audit |
|---|---|---|
| **`recheck_due` reached** | ToS drift; verdicts have a half-life. | That one row. |
| **Vendor ToS-change notice** (email / changelog / a 4xx with a new terms URL) | The clauses you quoted may no longer exist. | That vendor's rows. |
| **A new key tier is used** | Tier changes the grant (Demo→Pro can flip RED→GREEN; the *reverse* never assume). | The new tier path (a *new* row, not an edit of the old). |
| **A new endpoint on a known host** | The endpoint may sit under different terms (a paid endpoint on a free host). | The new endpoint path. |
| **A new series on an aggregator** (FRED/WB/IMF) | Per-series carve-out: the new series may be third-party RED. | The new `(host, series)` pair. |
| **A composite/derived field gains a new input** | Contamination rule: a derived field inherits its *most restrictive* input. One RED input turns the composite RED. | The composite's row. |
| **A legal/regulatory change** (a new statute, a ruling like *Fastcase v. Alexi* resolving) | The *law* gating a use changed, independent of the ToS. | All rows touching that use class. |

The contamination-rule trigger is the subtle one: it means a *downstream* change (adding a RED input to a
GREEN composite) forces a re-audit of a row whose own *source* ToS never changed. The classification graph
is connected; a verdict can be invalidated from below.

### 7.5 CI enforcement vs. CI classification (the boundary)

`/sources-lint` and the PreToolUse hook are **enforcement, not classification.** Be precise about what each
does, because over-trusting CI is itself a failure mode:

- **What CI *does*:** grep every `commercialOk: true` in the codebase, bridge each to a ledger row, and
  **fail the build** on any `true` whose fetch path lacks a 🟢 row (or whose row is 🔴/🟡/⛔/missing). It
  also flags the inverse drift (a 🟢 row under-claimed as `false`) and providers referenced in code with
  **no row at all** ([sources-lint.md](../../../commands/sources-lint.md)).
- **What CI *cannot* do:** read a ToS and *decide* the verdict. It checks that *code matches the ledger*;
  it cannot check that *the ledger matches reality*. The ledger's correctness is a human output — the §7.3
  checklist run by a person who read the contract. CI catches "you set `true` without a GREEN row"; it
  cannot catch "your GREEN row is wrong because you misread the ToS" or "the ToS changed last week."
- **The division in one line:** **a human classifies (writes the ledger); CI enforces (code can't
  out-claim the ledger).** Never invert this — a CI that *generated* verdicts would be the automated-ToS-
  parser anti-pattern of §8.

---

## 8. Why this stays a human-judgment loop — the automation pitfalls

Open-question #6 asks directly: *"appetite to automate license classification, or keep it manual per
fetch-path?"* The answer this workflow commits to is: **automate the *enforcement and bookkeeping*; keep
the *judgment* human.** Here is the evidence for why a fully-automated "ToS → verdict" parser is the wrong
build, not just an un-built one.

### 8.1 The accuracy ceiling of automated legal-text classification

The NLP-on-legal-text literature is candid that ToS classification is *not* a solved, high-accuracy task on
the documents that actually matter:

- Automated contract review *"works well when the training and test data have a similar structure and when
  documents have a rather uniform layout,"* but real contracts have *"a complex structure with lists,
  footnotes, side notes, multiple columns, headers and footers"* that degrade accuracy
  ([ScienceDirect — comparative study of automated legal text classification](https://www.sciencedirect.com/science/article/abs/pii/S0306457321002764);
  [Preparing Legal Documents for NLP Analysis](https://www.researchgate.net/publication/358028171)).
  Reported gains are *"from 0.95 to 0.98"* on the *easy* uniform single-column case — and a 2% error rate
  on a binary "may we display this commercially?" decision, across hundreds of datasets, is *guaranteed*
  mis-licensing on some of them. Licensing is a domain where **one wrong GREEN is a takedown or a
  contract-breach suit**, so a 98%-accurate classifier is not "98% good" — it's "guaranteed to ship a
  violation at scale."
- The general legal-NLP survey lists *ambiguity, long-document reasoning, and domain shift* as open
  challenges ([arXiv 2410.21306 — Legal NLP survey](https://arxiv.org/html/2410.21306v1)). A ToS is exactly
  a long, ambiguous, domain-shifting document.

### 8.2 The ambiguity is in the *law*, not just the parser

Even a *perfect* parser cannot resolve what the *license author* left undefined. Creative Commons say it of
their own NC clause: *"Creative Commons cannot advise you on what is and is not commercial use"*
([CC FAQ](https://creativecommons.org/faq/)). If the entity that *wrote* the license declines to draw the
line, an LLM "reading" the license is *inventing* a line, not *extracting* one. Automating that is
automating a guess — and the workflow's prime directive is that **a verdict is a quoted clause, never a
guess.** An LLM that emits "GREEN" with a confident paraphrase is precisely the *"metric in a costume"* /
*"fluency is not evidence"* failure the repo's red-team rule hunts
([red-team-negation-loop.md](../../../rules/red-team-negation-loop.md) §A).

### 8.3 The cost asymmetry makes the automation trade-off lopsided

Classification is **rare and slow** (you onboard a source once, and re-check it ~once or twice a year);
**display is frequent and fast** (the verdict is read on every served row). So the right place to spend
effort is the rare, high-stakes *classification* (a human reading the contract), and the right place to
automate is the frequent, mechanical *enforcement* (CI checking code-vs-ledger). Automating classification
inverts the asymmetry: you'd spend engineering on an unreliable parser to save a few human-hours/year,
while *increasing* the probability of the one outcome (a wrong GREEN) that's catastrophic. The verified
in-repo precedent is the **25-agent adversarial verification** that produced the current ledger — verdicts
were *"adversarially verified … against primary ToS/statute text"* by a research workflow, not parsed by a
classifier ([sources-ledger header](../../../memory/sources-ledger.md)). That is the correct shape:
*augment* human judgment with parallel research + red-team negation, then a human signs the verdict.

### 8.4 What *can* be safely automated (the augmentation, not the decision)

The pitfalls are about replacing the *judgment*. These supporting tasks are safe — even valuable — to
automate, because a human still signs the verdict:

- **Surfacing the candidate clauses.** An LLM/regex pass that *highlights* the sentences containing
  "redistribute", "commercial", "machine learning", "cache", "personal use" — so the human reads the right
  paragraphs first. (Extraction-to-review, not extraction-to-verdict.)
- **Diffing a re-fetched ToS** against the version quoted in the worksheet, to *flag* drift for re-audit
  (the §7.4 trigger). This is a string-diff, not a judgment.
- **`/sources-lint`** code-vs-ledger enforcement (§7.5).
- **Reminding** when `recheck_due` passes.
- **Per-series carve-out detection** on aggregators: an automated check that *flags* any FRED/WB/IMF series
  not individually classified, forcing a human row.

The dividing line is invariant: **machines surface, remind, diff, and enforce; humans read, decide, and
sign.** Cross it and you've built the anti-pattern.

---

## 9. Two worked examples, end-to-end

The procedure is concrete only when you watch it run. Here is one GREEN and one RED, each through all six
steps, ending in a real ledger row.

### 9.1 Worked example A — World Bank Indicators API → 🟢 GREEN (with attribution)

**Step 1 — pin the fetch path.**
- host = `api.worldbank.org`
- endpoint = `/v2/country/{country}/indicator/{indicator}?format=json`
- key tier = **keyless / free** (the World Bank Indicators API needs no key)
- fetcher = `worldbank_indicators`
- aggregator sub-check: **fires.** World Bank serves *both* its own indicators (WDI) *and* third-party
  feeds. So we classify **per indicator family**, and the carve-out below is mandatory.
- canonical key: `api.worldbank.org/v2/country/{c}/indicator/{id} | tier=keyless | fetcher=worldbank_indicators`

**Step 2 — locate the governing document.**
The binding terms are the Data Catalog's "Data Access and Licensing" page, *not* the worldbank.org site
ToS: [datacatalog.worldbank.org/public-licenses](https://datacatalog.worldbank.org/public-licenses)
(fetched 2026-06-24). This is the page that declares the dataset license.

**Step 3 — quote the load-bearing clauses.**
- **C1 commercial use — QUOTED, GREEN:** *"The Creative Commons Attribution 4.0 International license
  allows users to copy, modify and distribute data in any format for any purpose, including commercial
  use."*
- **C2 redistribution — QUOTED, GREEN:** same clause — *"distribute data in any format for any purpose."*
- **C3 public display — INFERRED GREEN:** "any purpose" subsumes display.
- **C4 caching/storage — SILENT → permitted:** CC-BY 4.0 grants reuse "in any format for any purpose"; no
  caching carve-out. Storing into the warehouse is within the grant. ✅ (This matters because we *store*.)
- **C5 AI/ML — SILENT → permitted:** CC-BY 4.0's "any purpose" covers ML; no AI carve-out.
- **The carve-out — QUOTED, CRITICAL:** *"Some datasets and indicators are provided by third parties, and
  may not be redistributed or reused without the consent of the original data provider, or may be subject
  to terms and conditions that are different from those described above."* → **the GREEN verdict applies
  ONLY to World-Bank-produced indicators; third-party indicators on the same API are RED.**
- **Other-statute check:** none — CC-BY is the whole story for WB-produced data.

**Step 4 — decision tree.** Path is CC-BY (attribution required), no AI/caching ban, not gated by another
statute → **🟢 GREEN-with-attribution** for World-Bank-produced indicators; the *third-party* indicators
fall to the "silent/ambiguous on *that* provider's terms" branch → **🔴 RED** until each is individually
cleared.

**Step 5 — attribution.**
- Required: yes (CC-BY). *"Users are only obligated to give appropriate credit (attribution) and indicate
  if they have made any changes"* ([public-licenses](https://datacatalog.worldbank.org/public-licenses)).
- String: `Source: World Bank — World Development Indicators (<indicator-id>). Licensed under CC BY 4.0.
  Retrieved <date>; modified (<transforms>).`
- Renders where: every surface/series card showing the indicator; pass-through to SDK consumers.

**Step 6 — ledger row + `commercialOk`.**

```
| World Bank | api.worldbank.org (WB-produced indicators only) | 🟢 GREEN | CC-BY 4.0 — "any purpose, including commercial use"; attribution required; third-party indicators on same API are RED (per-series carve-out). |
```

`commercialOk: true` for WB-produced indicators *and only while the attribution renders*; `false` for any
third-party indicator until individually cleared. Worksheet: `confirmed_on 2026-06-24, recheck_due
2027-06-24` (stable institutional source → 12-month cadence).

> Note the live ledger's existing one-liner is the *compressed* form (`api.worldbank.org · 🟢 GREEN ·
> CC-BY 4.0 (attribution)`). The worked row above is what the *worksheet* expands it to — same verdict,
> with the per-series carve-out and attribution made explicit so a future engineer doesn't launder a
> third-party WB indicator into a GREEN display.

### 9.2 Worked example B — CoinGecko Demo (free) API → 🔴 RED

**Step 1 — pin the fetch path.**
- host = `api.coingecko.com`
- endpoint = `/api/v3/coins/markets` (and the simple-price family)
- key tier = **Demo (free)** — *this is the decisive component.* The same host's **Pro** tier is a
  different contract.
- fetcher = `getCrypto`
- aggregator sub-check: does not fire (CoinGecko is the single licensor of its aggregated data).
- canonical key: `api.coingecko.com/api/v3/coins/markets | tier=demo | fetcher=getCrypto`

**Step 2 — locate the governing document.**
The API Terms of Service: [coingecko.com/en/api_terms](https://www.coingecko.com/en/api_terms) (fetched
2026-06-24), *plus* the plan description on the pricing page that scopes the Demo tier to
testing/personal use. (Reading the website ToS instead would miss §4 entirely.)

**Step 3 — quote the load-bearing clauses.**
- **C1 commercial use — paid-only:** the API terms tie commercial permissions to *"the usage plan that you
  select"* (§4.1.1); commercial display is a feature of the *paid* plans, not the Demo tier.
- **C2 redistribution — QUOTED, RED:** *"you are not permitted to sell, rent, lease, sub-license,
  re-distribute or syndicate access to the CoinGecko API or part thereof"* (§4.1.6). Serving the data to
  our end users *is* redistribution.
- **C3 public display — RED on this tier:** "Personal Use" is *"non-commercial review and republication
  (on a non-commercial site) … with due attribution"* — a *commercial* data service is not personal use,
  and the Demo tier grants only personal use.
- **C4 caching/storage — RED for our warehouse:** redistribution-prohibited + personal-use-only means we
  cannot store-and-serve it as our own data; that's exactly *"redistributing data as your own = prohibited."*
- **C5 AI/ML — not separately banned**, but moot: the source is already RED for display/redistribution, so
  we never reach an AI-specific question on the free tier.
- **Attribution — QUOTED:** *"display prominently the message 'Powered by CoinGecko' in a legible font …
  no smaller than font size 10"* (§4.4). Note this attribution *unlocks* the **paid** tiers' display
  grant; it does **not** rescue the Demo tier, which lacks the grant in the first place.

**Step 4 — decision tree.** Free vendor tier, redistribution explicitly prohibited, commercial display
gated behind a paid plan → falls straight to the **"free vendor tier / SILENT-or-prohibited"** branch →
**🔴 RED.** `commercialOk: false`. It *may* be **fetch-through-only** for an informational, attributed
crypto feature (RED gates the display *license*, not the *access*), but it may **not** be stored as our own
data or displayed on a paid surface.

**Step 5 — attribution.** On the **paid** tier you'd render "Powered by CoinGecko" (the §4.4 string). On
the **Demo** tier, attribution is irrelevant to the verdict — RED stands with or without it, because the
underlying *grant* (commercial display/redistribution) is absent. (This is the trap §6.2 flags: attribution
makes a *granted* display compliant; it cannot *create* a grant that the tier never gave.)

**Step 6 — ledger row + `commercialOk`.** This matches the live ledger row exactly:

```
| CoinGecko Demo | api.coingecko.com (demo key) — getCrypto | 🔴 RED | Demo scoped to personal use; "Powered by CoinGecko" required; redistributing data as your own = prohibited. |
```

`commercialOk: false`. Worksheet: `confirmed_on 2026-06-24, recheck_due 2026-12-24` (commercial vendor ToS
→ 6-month cadence, because vendor terms change faster and more adversarially than CC/government licenses).

### 9.3 What the two examples teach side-by-side

| | World Bank (A) | CoinGecko Demo (B) |
|---|---|---|
| What decided the verdict | the **named license** (CC-BY 4.0, "any purpose incl. commercial") | the **key tier** (Demo = personal-use; redistribution prohibited) |
| The subtle gotcha | per-series carve-out: third-party WB indicators are RED on the same GREEN API | attribution exists but *does not* rescue the free tier — it only unlocks the *paid* tier's grant |
| Caching (warehouse-critical) | permitted (CC-BY silent → granted) → may store | prohibited as "your own data" → may NOT store; fetch-through-only at most |
| `commercialOk` | `true` (WB-produced + attribution renders) | `false` |
| Re-check cadence | 12 months (stable institution) | 6 months (commercial vendor, fast-drifting ToS) |

The pair is the whole workflow in miniature: **A** shows that "GREEN" still has conditions (attribution +
per-series carve-out) you must *write down*; **B** shows that "free and popular" is not "licensed", and that
the *tier*, not the brand, is what the license binds.

---

## 10. The grading rubric for a classification (what "done" means)

A classification is **done** when an independent reviewer can answer "yes" to every line:

1. **Path pinned to `host + endpoint + tier + fetcher`** (+ series, if the aggregator sub-check fired).
   A path that's just the source's brand name is unclassified. ✅/❌
2. **Governing document is the binding contract for *that tier*** (API terms, not site terms; not
   marketing; not a blog), with a **URL and a fetch date**. ✅/❌
3. **C1–C5 each quoted verbatim or marked SILENT**, with the default-deny reading applied to every SILENT.
   No clause is "skipped." ✅/❌
4. **The AI/ML (C5) and caching (C4) clauses were checked specifically** — C5 because an explicit ban is
   REJECT for this AI product, C4 because a ban is REJECT for this *storage* product. ✅/❌
5. **Verdict follows the decision tree**, with REJECT checked before GREEN, share-alike/NC filed under RED,
   silence under RED, and a non-copyright statute able to override a public-domain GREEN. ✅/❌
6. **Attribution string + render location written down** for every GREEN-with-attribution (and "none
   required" written explicitly for CC0/PD). ✅/❌
7. **Ledger row exists *before* the code ships**, and `commercialOk` matches the verdict exactly (`true`
   only for 🟢; default `false`). ✅/❌
8. **Worksheet committed** with `confirmed_by / confirmed_on / recheck_due`. ✅/❌
9. **No clause was paraphrased into a grant it doesn't contain**, and no "everyone uses it" / "it's just a
   fact" / "the free tier exists" reasoning appears anywhere in the justification. ✅/❌
10. **`/sources-lint` passes** against the new row (code-vs-ledger), and the classification *judgment* was
    made by a human reading the contract — not generated by a parser. ✅/❌

A classification that fails any of 1–10 is **not done**; default the verdict to **RED** until it passes.
The asymmetry is the whole point: an under-claimed RED costs you a feature; an over-claimed GREEN costs you
a takedown or a lawsuit.

---

## 11. Cross-references

- **The runtime half** (how code carries the verdict the procedure above produced):
  [`patterns-provenance-stamping.md`](../../data-normalization-tet/references/patterns-provenance-stamping.md)
  in the `data-normalization-tet` skill — the TET `Fetcher` looks up the ledger by fetch-path key and
  stamps `commercialOk`, never re-deciding it; carries the contamination rule and the attribution field
  through to the catalog + Parquet sidecar.
- **The gate's principle** ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)) — "license
  attaches to the fetch path, not the concept; default false; silence is not a license."
- **The truth table** ([`sources-ledger.md`](../../../memory/sources-ledger.md)) — the output format, the
  legend, and the 25-agent-verified existing verdicts (the precedent §8.3 builds on).
- **The enforcement endpoints** — [`/sources-lint`](../../../commands/sources-lint.md) (code-vs-ledger CI
  audit) and [`precheck-licensing.mjs`](../../../hooks/precheck-licensing.mjs) (the PreToolUse nudge on
  `commercialOk:true`).
- **The product context** —
  [`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  §"Selected approach" (GREEN-set scope, warehouse-not-proxy) and §"Open questions" #6 (the question this
  doc answers).
- **The red-team posture this workflow is built to survive**
  ([`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md) §B2 F2) — *"prove a displayed
  series is mis-licensed: `commercialOk:true` without a 🟢 row, a free tier treated as a display license,
  or a composite that inherits a RED input yet claims GREEN."* Every step above exists to make that
  negation impossible to land.
```
