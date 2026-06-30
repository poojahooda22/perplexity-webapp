---
name: data-provenance-licensing
description: >
  Build the CATALOG + PROVENANCE + per-series LICENSING layer for the JPM-Markets re-engineering
  data-analytics product line (NOT Lumina) — the differentiating moat of the DataQuery/Fusion
  re-engineering (Project 3, under
  `.agents/jpm-markets-reengineering/financial-data-analytics-service/`) AND the discipline behind
  Lumina's in-repo `Provenance{commercialOk}` gate. This skill owns ONE thing: deciding, recording,
  and rendering whether a displayed financial data series is legally clear to show commercially, and
  modelling WHERE every series came from. It is greenfield (theory + design recipes, no built code yet)
  on a stack-agnostic standards spine — W3C DCAT v3 (catalog), W3C PROV-O (provenance/lineage),
  OpenLineage (operational run lineage), ODRL + SPDX (machine-readable rights) — bridged to the verified
  JPM Fusion 5-level ontology (Catalog → Data Product → Dataset → Dataset Series Member → Distribution).
  Covers: (1) the per-Distribution/per-series `commercialOk` gate — the verdict bound to the FETCH PATH
  not the data concept (GREEN: US-gov public-domain 17 USC §105 / CC0 / PDDL / CC-BY + rendered
  attribution / purchased display tier; RED: a free vendor tier is NOT a display license, a silent/
  ambiguous ToS = RED); (2) modelling the data catalog on DCAT v3 (dcat:Catalog/Dataset/Distribution/
  DataService/DatasetSeries) and the exact class/property vocabulary where licensing + provenance hang
  (dct:license, dct:rights, dct:accessRights, odrl:hasPolicy, prov:wasGeneratedBy); (3) a
  license-classification WORKFLOW at scale (20+ sources × hundreds of datasets) + the maintained
  sources-ledger and the /sources-lint CI + PreToolUse hook that enforce it; (4) the contamination /
  derived-data rule (a composite inherits its MOST-RESTRICTIVE input's verdict — a GREEN claim over any
  RED leg is RED, as briefing.ts already does); (5) mandatory attribution RENDERING for CC-BY / ODC-BY /
  conditioned sources (World Bank, OECD, IMF, GDELT) on every surface that displays the data, not merely
  in a metadata field; (6) provenance + lineage capture modelled on W3C PROV-O (Entity/Activity/Agent;
  wasGeneratedBy/wasDerivedFrom/wasAttributedTo) and OpenLineage (Job/Run/Dataset + facets); (7) the
  Provenance/commercialOk SCHEMA design at each tier — the TS `{source, commercialOk, attribution}` shape
  Lumina ships today, the DCAT/PROV-shaped record at warehouse scale, and how it threads tool → cache →
  route → frontend; (8) machine-readable rights via ODRL 2.2 policies + SPDX license identifiers; (9) the
  specific RED/GREEN traps (FRED-hosting ≠ public-domain, US-gov-CONTRACTOR data, the Ethics-in-Government
  -Act statutory bar on congressional-trade data, ODbL/CC-BY-SA share-alike copyleft). Does NOT cover the
  market-data FETCHERS or their cache/rate-budget plumbing (→ finance-markets / redis), the
  numeric-grounding or no-advice guards (→ finance-markets guards/; this skill owns LICENSE provenance,
  not value-grounding), the security-master / FIGI-ISIN-CUSIP symbology subsystem (a separate pillar —
  this skill stamps provenance ON a resolved series, it does not resolve identity), the time-series STORE
  choice (→ timescaledb-timeseries / prisma), the OpenBB TET normalization mechanics (→
  data-normalization-tet), or legal advice (this encodes a conservative engineering DISCIPLINE for a
  portfolio product, not a substitute for counsel). Use whenever the task is: setting or auditing a
  `commercialOk` verdict, adding a new data source to the ledger, modelling the data catalog, deciding a
  derived/composite series' license, rendering attribution for a conditioned source, designing the
  Provenance record, encoding rights as ODRL/SPDX, capturing lineage, or reasoning about a specific
  GREEN/RED licensing trap — for the JPM-Markets re-engineering data-analytics product line (NOT Lumina).
metadata:
  priority: 55
  sessionStart: false
  productLine: jpm-markets-reengineering
  pathPatterns:
    - '.agents/jpm-markets-reengineering/**'
  bashPatterns:
    - 'commercialOk'
    - 'sources-ledger'
    - 'sources-lint'
    - 'dcat:'
    - 'prov:'
    - 'wasGeneratedBy'
    - 'wasDerivedFrom'
    - 'dct:license'
    - 'odrl:'
    - 'SPDX'
  promptSignals:
    phrases:
      - 'data provenance'
      - 'provenance licensing'
      - 'commercialok'
      - 'commercial ok'
      - 'license verdict'
      - 'licensing gate'
      - 'fetch path'
      - 'sources ledger'
      - 'sources-lint'
      - 'data catalog'
      - 'dcat'
      - 'dataset series'
      - 'distribution license'
      - 'prov-o'
      - 'provenance model'
      - 'lineage'
      - 'openlineage'
      - 'data lineage'
      - 'attribution rendering'
      - 'cc-by'
      - 'cc by attribution'
      - 'public domain'
      - '17 usc 105'
      - 'odrl'
      - 'spdx'
      - 'machine readable rights'
      - 'contamination rule'
      - 'derived data license'
      - 'composite license'
      - 'fred copyright'
      - 'vixcls'
      - 'odbl'
      - 'share alike'
      - 'green red trap'
      - 'redistribution license'
      - 'free tier display'
      - 'fusion ontology'
      - 'data product catalog'
    minScore: 2
---

# Data Provenance & Licensing — the catalog + per-series license gate for the JPM-Markets re-engineering line (NOT Lumina)

> **Product line.** This skill belongs to the **JPM-Markets re-engineering data-analytics product
> line** — a *separate* product line from Lumina (see [`cto-rules.md`](../../rules/cto-rules.md)
> §"Scope note"). Nothing here wires into Lumina's app code; the two repos only share a filesystem home
> for the research. The research substance lives in
> [`.agents/jpm-markets-reengineering/financial-data-analytics-service/`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md).
>
> **What this skill makes you expert at.** The **catalog + provenance + per-series licensing** layer —
> the moat the project's own theory names as the differentiator: *"the incumbents normalize data, but
> neither DataQuery nor OpenBB systematically tells you the license verdict per series"*
> ([00-theory.md §Summary](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).
> Concretely: how to **model the data catalog** on the W3C DCAT v3 standard and bridge it to JPM's
> verified Fusion 5-level ontology; how to **decide, record, lint, and RENDER** the `commercialOk`
> licensing verdict per Distribution; how to **capture provenance + lineage** on PROV-O / OpenLineage;
> and how to **encode rights machine-readably** with ODRL + SPDX. It is also the canonical home for the
> discipline behind Lumina's in-repo `Provenance{commercialOk}` gate — Lumina is the **Tier-1 reference
> implementation** of exactly the rule this skill scales to a warehouse.

This skill follows the **finance-markets gold-standard** cognitive-mesh structure: a thin router here,
deep cited references loaded on demand. It is **greenfield** — references are theory + design/recipe, not
yet `file:line` traces into a built data-plane codebase (the product line has no committed code), though
they cite Lumina's *existing* `backend/finance/` provenance code as the Tier-1 prior art. Standards pinned
this build (re-verify the URLs, not a blog summary): **W3C DCAT v3** (W3C Recommendation, Aug 2024 —
adds `spdx:checksum`, `dcat:version`/`previousVersion`/`hasCurrentVersion`,
[w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)); **W3C PROV-O** (W3C Recommendation,
2013-04-30, [w3.org/TR/prov-o](https://www.w3.org/TR/prov-o/)); **ODRL Information Model 2.2** (W3C
Recommendation, 2018-02-15, [w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/)); **OpenLineage**
(LF AI & Data, [openlineage.io](https://openlineage.io/docs/spec/object-model)); **SPDX License List**
([spdx.org/licenses](https://spdx.org/licenses/)).

> **Where this layer sits in the data plane.** `data-normalization-tet` produces validated rows;
> `timescaledb-timeseries` persists them; `dataquery-delivery-channels` serves them. **This skill owns
> the metadata that travels WITH every series** — the catalog entry it lives under, the provenance record
> of where it came from, and the `commercialOk` verdict that gates whether the delivery channel may
> display it. TET **stamps** a `Provenance` it is handed; **this skill decides what that stamp says.**

---

## Domain Identity

### This skill COVERS

- **The `commercialOk` licensing gate — the central concept.** The per-series boolean whose verdict is
  bound to the **FETCH PATH, not the data concept**: the 10Y Treasury yield from treasury.gov is
  public-domain GREEN; the *same number* from Yahoo's chart API is RED. The full GREEN/RED decision rule,
  the default-false discipline, and why a free vendor tier is never a display license.
  (`theory-commercialok-fetch-path-licensing.md`)
- **Modelling the data catalog on W3C DCAT v3** — `dcat:Catalog` / `dcat:Dataset` / `dcat:Distribution`
  / `dcat:DataService` / `dcat:DatasetSeries`, the exact licensing/provenance/versioning properties
  (`dct:license`, `dct:rights`, `dct:accessRights`, `odrl:hasPolicy`, `prov:wasGeneratedBy`,
  `dcat:version`), and the bridge to JPM's verified **Fusion 5-level** ontology (Catalog → Data Product
  → Dataset → Dataset Series Member → Distribution). Where in the model licensing metadata HANGS.
  (`theory-dcat-catalog-modeling.md`)
- **Provenance + lineage modelling on W3C PROV-O** — Entity / Activity / Agent;
  `wasGeneratedBy` / `used` / `wasDerivedFrom` / `wasAttributedTo` / `wasAssociatedWith`. The vocabulary
  for *describing* where a series came from and how it was produced. (`theory-prov-o-lineage-model.md`)
- **The contamination / derived-data rule** — how a verdict propagates through computation, joins, and
  composites: a derived series inherits the **MOST RESTRICTIVE** verdict of all its inputs, so a GREEN
  computation over any RED leg is RED. The single most leak-prone surface; an F2-CRITICAL in the
  red-team battery. (`theory-contamination-derived-data-rule.md`)
- **The open-data license landscape a classifier must recognize** — the CC family (CC0, CC-BY,
  CC-BY-SA), the Open Data Commons family (PDDL, ODC-By, ODbL), US public-domain (17 USC §105), and the
  **share-alike / copyleft viral trap** that can poison a proprietary product. What each license actually
  *requires*. (`theory-open-data-licenses.md`)
- **The license-classification WORKFLOW at scale** — the step-by-step a builder runs to classify a new
  source and produce its verdict + ledger row: identify the exact fetch path → find & quote the governing
  ToS/statute clause → apply the GREEN/RED decision tree → write the ledger row → set the gate.
  (`patterns-license-classification-workflow.md`)
- **The Provenance / `commercialOk` SCHEMA design** — the lightweight TS `{source, commercialOk,
  attribution}` shape Lumina ships today, the DCAT/PROV-shaped record at warehouse scale, and how the
  stamp threads tool → cache → route → frontend. (`patterns-provenance-schema-design.md`)
- **Attribution RENDERING** — satisfying the CC-BY / ODC-BY / GDELT-conditioned obligation at DISPLAY
  time on every surface, not merely storing the string in a metadata field (the most-missed half of
  CC-BY). (`patterns-attribution-rendering.md`)
- **Operational lineage capture on OpenLineage** — Job / Run / Dataset + facets, so each stored
  warehouse series records the fetch+normalize run that produced it.
  (`patterns-lineage-capture-openlineage.md`)
- **The catalogue of specific RED/GREEN traps** — FRED-hosting ≠ public-domain (VIXCLS is CBOE ©), the
  US-gov-CONTRACTOR carve-out, the Ethics-in-Government-Act statutory bar on congressional-trade data,
  the share-alike traps — each with the reasoning to avoid the wrong verdict. (`patterns-red-green-traps.md`)
- **Machine-readable rights via ODRL + SPDX** — encoding the verdict as a queryable ODRL policy
  (Permission / Prohibition / Duty / Constraint) + an SPDX license identifier instead of a bare boolean.
  (`patterns-machine-readable-rights-odrl-spdx.md`)
- **Enforcement** — the sources-ledger format, the `/sources-lint` CI audit, the PreToolUse licensing
  hook, and how to extend them for the DaaS catalog. (`patterns-ledger-lint-enforcement.md`)

### This skill does NOT cover

- **NOT the market-data FETCHERS or their plumbing.** How a quote/series is actually *fetched*, cached
  (`getOrRefresh`), rate-budgeted, or retried is `finance-markets` + `redis` + (on the new line)
  `data-normalization-tet`. This skill decides the **license** of the bytes; it does not move them.
- **NOT numeric-grounding or the no-advice boundary.** "Never invent a finance number" (value grounding)
  and the no-advice guard are **orthogonal gates** owned by `finance-markets` / `guards/`. A correct
  *license* verdict never excuses an ungrounded or unvalidated *value* — this skill cites that rule
  (GREEN-but-wrong is still a violation) but does not own value-grounding or advice-boundary mechanics.
- **NOT instrument IDENTITY / symbology.** Resolving `AAPL`@providerA, ISIN@providerB, and a FIGI venue
  fan-out to one logical security is the **bitemporal security master** — a separate first-class pillar
  (its own skill). This skill **stamps provenance ON a resolved series**; it does not resolve identity.
- **NOT the time-series STORE choice.** TimescaleDB vs Parquet/DuckDB vs ClickHouse is
  `timescaledb-timeseries` / `prisma` + the JPM theory doc. This skill defines the metadata the store
  carries, not the store engine.
- **NOT the OpenBB TET normalization mechanics.** Field aliasing, the Fetcher pipeline, value/unit
  normalization is `data-normalization-tet`. TET **carries** the `Provenance`; this skill decides what
  goes in it.
- **NOT legal advice.** This encodes a **conservative engineering DISCIPLINE** for a portfolio product —
  it is **not** a substitute for counsel before flipping a gate to `true` on a paid tier. When the law
  is unsettled (e.g. the Ethics-in-Government-Act "news media" carve-out), this skill says so and stays
  RED.

---

## Decision Tree — task → the ONE reference to open

Open the matched reference and read its decision tables before writing code. Never load the whole
`references/` folder. For any verdict on a source **already assessed**, the live truth is the ledger,
[`.claude/memory/sources-ledger.md`](../../memory/sources-ledger.md) — read it first, then the trap doc
for the reasoning.

| The task is to… | Read this reference |
|---|---|
| Add a NEW data source / provider and decide its `commercialOk` verdict (the operational recipe) | `patterns-license-classification-workflow.md` |
| Understand WHY the license binds to the fetch path, and the GREEN/RED first principles | `theory-commercialok-fetch-path-licensing.md` |
| Design the Provenance / `commercialOk` record — the TS shape today, or the warehouse-scale record | `patterns-provenance-schema-design.md` |
| Model the data CATALOG (catalog/dataset/distribution) or map to the Fusion 5-level ontology | `theory-dcat-catalog-modeling.md` |
| Find exact W3C property names for licensing/provenance/versioning on a catalog resource | `theory-dcat-catalog-modeling.md` (property tables) + `theory-prov-o-lineage-model.md` |
| Capture transform LINEAGE (which fetch+transform produced this stored series) | `theory-prov-o-lineage-model.md` + `patterns-lineage-capture-openlineage.md` |
| Decide the verdict of a DERIVED/composite series (AI briefing, sentiment composite, computed spread) | `theory-contamination-derived-data-rule.md` |
| Render attribution correctly for a CC-BY / ODC-BY / GDELT-conditioned source | `patterns-attribution-rendering.md` + `theory-open-data-licenses.md` |
| Choose / assess an open-data license (CC0/PDDL vs CC-BY vs ODbL vs ODC-By; share-alike risk) | `theory-open-data-licenses.md` |
| Re-check a source you think is public-domain because a .gov site (FRED, data.gov, an agency portal) hosts it | `patterns-red-green-traps.md` |
| Encode the verdict as machine-readable rights (an ODRL policy / SPDX id) instead of a boolean | `patterns-machine-readable-rights-odrl-spdx.md` |
| Wire the sources-ledger + `/sources-lint` + the PreToolUse hook, or audit the codebase for gate violations | `patterns-ledger-lint-enforcement.md` |
| Know the licensing reality (verdict + clause) for a SPECIFIC source already assessed | [`sources-ledger.md`](../../memory/sources-ledger.md) (the live truth table) → then `patterns-red-green-traps.md` |

---

## Non-Negotiables — the rules that always apply

1. **THE LICENSE ATTACHES TO THE FETCH PATH, NOT THE DATA CONCEPT.** The *same number* is GREEN or RED
   depending only on where the bytes were fetched: the US 10Y Treasury yield from `home.treasury.gov` is
   public-domain GREEN (17 USC §105); from Yahoo's chart API it is RED. You can **never** infer
   `commercialOk` from the data *type* — only from the exact URL/API/key that fetched it. Every
   Distribution row records its precise fetch path, and the verdict is derived from **that**. This is the
   foundational principle the whole skill rests on
   ([`commercial-ok-gate.md`](../../rules/commercial-ok-gate.md): *"The license attaches to the FETCH
   PATH, not the concept"*). (`theory-commercialok-fetch-path-licensing.md`)

2. **`commercialOk` DEFAULTS TO `false`. It may be flipped `true` ONLY when the fetch path is** (a)
   US-gov public-domain (17 USC §105 — verified: copyright is *"not available for any work of the United
   States Government,"* a work *"prepared by an officer or employee … as part of that person's official
   duties,"*
   [law.cornell.edu/uscode/text/17/105](https://www.law.cornell.edu/uscode/text/17/105)), (b) CC0 / PDDL
   (public-domain dedication), (c) CC-BY / ODC-By **with the attribution actually rendered on the display
   surface**, or (d) a **PURCHASED** commercial display/redistribution tier — **and only after confirming
   a matching 🟢 row exists in** [`sources-ledger.md`](../../memory/sources-ledger.md). **No ledger row ⇒
   not cleared ⇒ stays `false`.** (`patterns-license-classification-workflow.md`)

3. **A FREE API TIER IS NOT A DISPLAY LICENSE, AND "A COMPETITOR DISPLAYS IT" IS NOT A LICENSE.** Free /
   cheap access is an **access** grant, almost never a **redistribution/display** grant. Map every free
   vendor tier (CoinGecko Demo, Twelve Data free, Finnhub free, FMP free, Tiingo's published internal-use
   tier) to **RED** until a paid display SKU is bought and named in the ledger. When a ToS is **silent or
   ambiguous** about commercial redistribution/display, the verdict is **RED**, never GREEN.
   (`theory-commercialok-fetch-path-licensing.md`, `patterns-red-green-traps.md`)

4. **THE CONTAMINATION RULE: a derived/composite series inherits the MOST RESTRICTIVE verdict among ALL
   its inputs.** A GREEN computation over even one RED leg is **RED**. A composite may claim
   `commercialOk:true` only if **every** input fetch path is independently GREEN. Lumina's
   [`briefing.ts`](../../../backend/finance/briefing.ts) is correct to stamp `commercialOk:false`
   because its prose synthesis mixes Yahoo index levels + Tavily snippets (RED legs); its
   [`sentiment-sources.ts`](../../../backend/finance/sentiment-sources.ts) Market-Mood composite is
   correctly `true` because **every** leg (Treasury + BLS + GDELT) is independently GREEN. Never launder a
   RED leg through a computation and stamp the output `true`. (`theory-contamination-derived-data-rule.md`)

5. **ATTRIBUTION IS A RUNTIME RENDER OBLIGATION, NOT A METADATA FIELD.** For CC-BY / ODC-By / conditioned
   sources, the required attribution string MUST **render on every surface that displays the data** — not
   merely sit unused in the Provenance object. Verified conditions this build: **World Bank** = CC-BY 4.0,
   credit *"The World Bank: Dataset name: Data source"* and **pass the acknowledgment requirement through
   to any sub-licensees**
   ([worldbank.org/en/about/legal/terms-of-use-for-datasets](https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets));
   **GDELT** = *"unlimited and unrestricted use for any … commercial … use of any kind without fee"* but
   *"any use or redistribution of the data must include a citation to the GDELT Project and a link to this
   website"* ([gdeltproject.org/about.html](https://www.gdeltproject.org/about.html)); **CC-BY 4.0** §3(a)
   requires retaining creator identification, copyright notice, license notice, disclaimer notice, **and a
   URI/hyperlink to the material**
   ([creativecommons.org/licenses/by/4.0/legalcode](https://creativecommons.org/licenses/by/4.0/legalcode.en)).
   A series whose attribution does not render is **mis-licensed at display time** even if the metadata is
   correct. (`patterns-attribution-rendering.md`)

6. **EVERY DISPLAYED SERIES CARRIES A PROVENANCE RECORD.** At minimum: `source`, the **exact fetch path**,
   `commercialOk` (boolean, default `false`), the **rendered attribution string**, an SPDX-style license
   id where one exists, and `asOf` / `fetchedAt`. Lumina ships the minimal shape today —
   `type Provenance = { source; commercialOk; attribution }` in
   [`backend/finance/sources.ts`](../../../backend/finance/sources.ts). At warehouse scale this becomes a
   **PROV-O / DCAT-shaped record** — a `prov:Entity` (the series) with a generating `prov:Activity`, a
   responsible `prov:Agent`, and `dct:license` on the `dcat:Distribution` — **not** a free-text note.
   (`patterns-provenance-schema-design.md`)

7. **GREEN-BUT-WRONG IS STILL A VIOLATION.** A public-domain source can return a wrong / duplicate /
   non-comparable number — e.g. SEC EDGAR `frames` returns **duplicate, non-comparable XBRL facts**
   (flagged in the ledger). A correct *license* verdict never excuses an ungrounded or unvalidated
   *value*. License provenance and numeric grounding are **orthogonal gates that must BOTH pass** — this
   skill owns the first; `finance-markets` / `guards/numeric-grounding.ts` owns the second.
   (`theory-commercialok-fetch-path-licensing.md`)

8. **ADDING ANY NEW SOURCE REQUIRES ITS LEDGER ROW BEFORE SHIPPING**, with the governing ToS/statute
   clause quoted (short) and the fetch path named. The **PreToolUse licensing hook**
   ([`precheck-licensing.mjs`](../../hooks/precheck-licensing.mjs)) nudges on any edit introducing
   `commercialOk:true`; **`/sources-lint`** fails on any `commercialOk:true` lacking a 🟢 ledger row. The
   ledger is the single source of truth; **code must not out-run it.** (`patterns-ledger-lint-enforcement.md`)

9. **A VERDICT IS A POINT-IN-TIME FINDING, NOT A PERMANENT FACT.** ToS get rewritten, vendors re-license,
   free tiers get withdrawn, vendors add AI-use bans (Kalshi). Every verdict is tagged with its
   confirmation date; treat any verdict older than the last audit as **needing re-verification before
   relying on it for a NEW display surface**. Re-confirm before flipping a gate.
   (`patterns-ledger-lint-enforcement.md`)

---

## Anti-Patterns — mistake → fix

| Anti-pattern (the mistake) | The fix |
|---|---|
| Reasoning about a license from the DATA TYPE/CONCEPT ("treasury yields are public, so it's GREEN"). | The concept being public-domain *somewhere* does not license **your pipe** to it. Always ask: **which exact URL / API / key fetched these bytes?** The verdict is a property of the fetch path, not the number. (NN1) |
| Treating a free API tier (CoinGecko Demo, Twelve Data free, Finnhub free, FMP free, Tiingo's published internal-use tier) as a display license. | Free/cheap access is an **ACCESS** grant, almost never a **REDISTRIBUTION/DISPLAY** grant. Map free-tier → **RED** until a paid display SKU is bought and named in the ledger. (NN3) |
| The **FRED-hosting trap**: assuming a series is public-domain because a government site (FRED / St. Louis Fed) hosts it. | FRED's own legal page: *"neither the Federal Reserve Bank of St. Louis's provision of the FRED® API to you nor your use of the FRED® API override the data series owners' copyrights"* ([fred.stlouisfed.org/legal](https://fred.stlouisfed.org/legal/)). `VIXCLS` is *"Copyrighted: Citation Required"* (CBOE ©). **Only Fed-OWNED FRED series are GREEN**; CBOE/ICE/Dow-Jones series on FRED are RED. (`patterns-red-green-traps.md`) |
| Storing the attribution string in `Provenance` and **never rendering it** ("attribution in the JSON, absent on the page"). | Silently breaks the CC-BY/GDELT condition and turns a GREEN source into an **infringing display**. Attribution **unrendered == mis-licensed**. Render it on every surface. (NN5) |
| Letting a composite/derived metric claim GREEN while one input is RED (the **contamination leak**). | A "sentiment composite" or "AI briefing" over a RED price feed or RED news snippet is **RED**. Do not launder a RED leg through a computation. Inherit the most-restrictive verdict. (NN4) |
| Backfilling a failed/over-budget fetch with a fabricated or RED-tier value "to look complete." | A failed fetch returns typed `unavailable` / `needsKey`; it **never** silently substitutes a different (possibly RED, possibly invented) number. This violates **both** the licensing gate and "never invent a finance number." (NN7) |
| Putting the license verdict in free-text prose or a code comment instead of a machine-readable, lintable field. | If `/sources-lint` and the PreToolUse hook can't mechanically check it, the gate isn't enforced — it's a **hope**. The verdict must be a structured boolean keyed to a ledgered fetch path. (NN8) |
| Treating a one-time license audit as permanent. | Verdicts **rot**: ToS get rewritten, free tiers vanish, vendors add AI-use bans. A verdict without a **confirmation date** and a re-audit trigger is a future incident. (NN9) |
| Confusing the two senses of "series": DCAT v3's `dcat:DatasetSeries` is an **ordered COLLECTION OF DATASETS**, NOT a financial time-series. | Modelling a price time-series as `dcat:DatasetSeries` is a **category error** — *"a dataset that represents a collection of datasets that are published separately, but share some characteristics that group them"* ([DCAT v3 §5.1](https://www.w3.org/TR/vocab-dcat-3/)). A financial series maps to a `dcat:Dataset` (with its Distributions), or to Fusion's "Dataset Series Member." Disambiguate explicitly in the catalog model. (`theory-dcat-catalog-modeling.md`) |
| Over-engineering full W3C-PROV/OpenLineage RDF triplestores for a v1 that needs only `{source, fetchPath, commercialOk, attribution, asOf}`. | PROV-O/OpenLineage are the **SCALE target** and the vocabulary to borrow **names** from; shipping a triplestore for a 5-field provenance stamp is **junior gold-plating**. Match provenance depth to the tier. (`patterns-provenance-schema-design.md`) |
| Assuming all US-government output is public-domain. | 17 USC §105 covers works by federal officers/employees in their official duties — **NOT** government-CONTRACTOR works (the bill *"deliberately avoids"* an unqualified prohibition; an agency may let a contractor keep copyright, [LII §105 notes](https://www.law.cornell.edu/uscode/text/17/105)), **NOT** state/local government, **NOT** foreign government. Check the **producer**, not just the `.gov` domain. (`patterns-red-green-traps.md`) |
| Ignoring share-alike / copyleft data licenses. | ODbL §4.4 and CC-BY-SA require any **Derivative Database** you publicly use to carry *"only … This License … or a compatible license"* ([opendatacommons.org/licenses/odbl/1-0](https://opendatacommons.org/licenses/odbl/1-0/)) — a **viral** obligation that can be unacceptable for a proprietary product. "It's open" is not "it's safe to build a closed product on." Read the share-alike clause. (`theory-open-data-licenses.md`) |

---

## Output Contract — the grading rubric

A provenance/licensing artifact produced under this skill is **done** only when:

1. **The verdict is bound to a named fetch path.** Every `commercialOk` value is keyed to an exact
   URL/API/key in a ledger row, never to a data *type* or concept. (NN1)
2. **`commercialOk` defaults false and any `true` has a 🟢 ledger row.** A `true` is justified only by
   (a) US-gov public-domain, (b) CC0/PDDL, (c) CC-BY/ODC-By **with rendered attribution**, or (d) a
   purchased display tier — and the matching ledger row exists *before* the gate flips. (NN2, NN8)
3. **Free tiers and silence are RED.** No free vendor tier and no silent/ambiguous ToS is marked GREEN.
   (NN3)
4. **Composites inherit the most-restrictive input.** Any derived/composite series' verdict is the min
   over all input verdicts; a GREEN-over-RED claim is caught and corrected to RED. (NN4)
5. **Attribution renders.** For every CC-BY/ODC-By/conditioned source, the required attribution string is
   shown on every display surface — not just stored. (NN5)
6. **The Provenance record is complete and tier-appropriate.** It carries source, fetch path,
   `commercialOk`, rendered attribution, SPDX id where one exists, and asOf/fetchedAt — as the minimal TS
   shape at Tier-1 or the PROV-O/DCAT-shaped record at warehouse scale, with depth matched to the tier
   (no triplestore for five fields). (NN6)
7. **License and value are kept as separate gates.** A GREEN verdict is never used to wave through an
   ungrounded/unvalidated number; the doc states that value-grounding is a *separate* gate it does not
   own. (NN7)
8. **The catalog model is standards-shaped and disambiguated.** Catalog resources map to DCAT v3 classes
   with licensing/provenance on the right property (`dct:license` on the Distribution, `odrl:hasPolicy`
   for machine-readable rights), and a financial time-series is **not** modelled as `dcat:DatasetSeries`.
   (`theory-dcat-catalog-modeling.md`)
9. **The verdict is mechanically enforceable and dated.** It lives in a lintable field `/sources-lint`
   and the PreToolUse hook can check, and it carries a confirmation date with a re-audit trigger. (NN8, NN9)

---

## References

| File | When to read |
|---|---|
| `theory-commercialok-fetch-path-licensing.md` | The foundational principle the whole skill rests on: the `commercialOk` gate, and WHY the license attaches to the fetch path and not the data concept. The conceptual on-ramp every other doc assumes. |
| `theory-dcat-catalog-modeling.md` | How to model the data catalog on W3C DCAT v3, the exact class/property vocabulary, and the bridge to the JPM Fusion 5-level ontology. The structural backbone for where provenance + license metadata HANG. |
| `theory-prov-o-lineage-model.md` | The W3C PROV-O provenance model — the vocabulary for stamping WHERE a series came from and HOW it was produced. The "how do we describe lineage" theory under the lineage-capture recipe. |
| `theory-contamination-derived-data-rule.md` | The derived-data / contamination rule: how a verdict propagates through computation, joins, and composites. The single most leak-prone area and a CRITICAL in the red-team battery (F2 contamination). |
| `theory-open-data-licenses.md` | The open-data license landscape a classifier must recognize and the rules each imposes — CC family, Open Data Commons family, US public-domain, and the share-alike viral trap. The "what does this license actually require" reference. |
| `patterns-license-classification-workflow.md` | The step-by-step recipe a builder runs to classify a new source and produce its verdict + ledger row. The operational core of "a license-classification workflow at scale." |
| `patterns-provenance-schema-design.md` | How to DESIGN the Provenance/`commercialOk` record at each tier — the lightweight TS shape Lumina ships today, and the DCAT/PROV-shaped record for the warehouse. A concrete schema recipe. |
| `patterns-attribution-rendering.md` | The recipe for satisfying attribution obligations at DISPLAY time — the most-missed half of CC-BY/conditioned licensing. Turns "attribution string in metadata" into "attribution rendered on the surface." |
| `patterns-lineage-capture-openlineage.md` | The recipe for capturing operational transform LINEAGE for stored series, modelled on OpenLineage (dataset/job/run + facets) — so each warehouse series records the fetch+normalize run that produced it. |
| `patterns-red-green-traps.md` | The catalogue of specific licensing traps that produce a WRONG verdict, with the reasoning to avoid each. The "why this source that looks GREEN is actually RED" reference, grounded in the live ledger. |
| `patterns-machine-readable-rights-odrl-spdx.md` | How to encode the licensing verdict as MACHINE-READABLE rights (ODRL policy + SPDX id) instead of a bare boolean — the path from a `commercialOk` gate to a queryable, evolvable rights layer. |
| `patterns-ledger-lint-enforcement.md` | How the discipline is ENFORCED in this repo: the sources-ledger format, the `/sources-lint` CI audit, and the PreToolUse licensing hook — and how to extend them for the DaaS catalog. Turns the rule into a mechanically-checked gate. |
</content>
</invoke>
