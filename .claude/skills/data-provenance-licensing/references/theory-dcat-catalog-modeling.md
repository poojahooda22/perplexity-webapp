# theory-dcat-catalog-modeling.md

> **Scope.** How to model the financial data catalog on **W3C DCAT v3**, with the exact RDF
> class/property vocabulary, the **place where provenance + license metadata HANG**, and the bridge
> to the **JPM Fusion 5-level ontology**. This is the *structural backbone* of the
> `data-provenance-licensing` dev-skill: every later pattern (license stamping, provenance lineage,
> the per-distribution schema) attaches metadata to nodes defined here. Get the catalog model right
> and "where does the `commercialOk` verdict live?" stops being a guess.
>
> **Product line.** JPM-Markets re-engineering **data-analytics product line (NOT Lumina)** — the
> normalized financial Data-as-a-Service that re-engineers J.P. Morgan **DataQuery + Fusion** into our
> own. New Python/FastAPI/data-engineering stack, separate from Lumina's Bun + Express + Prisma.
> Cross-references the project theory doc
> [`.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
> (the ontology section, lines 26, 85–86, 103–104, 111).
>
> **`theory-*` doc** = generic, reusable knowledge (the DCAT vocabulary is a W3C Recommendation, not
> our invention). The concrete "build the catalog tables / serialize a `dcat:Distribution`" recipe
> lives in the `patterns-*` siblings; this doc is the model they implement.

---

## 0. The one-paragraph version (read this first)

A **catalog** is a curated collection of metadata *about* data — not the data itself
([w3.org/TR/vocab-dcat-3 §6.2](https://www.w3.org/TR/vocab-dcat-3/): "A curated collection of metadata
about resources"). W3C DCAT v3 (a **W3C Recommendation**, published **22 August 2024** —
[w3.org/news/2024](https://www.w3.org/news/2024/data-catalog-vocabulary-dcat-version-3-is-a-w3c-recommendation/))
gives us five core classes — `dcat:Catalog`, `dcat:Dataset`, `dcat:Distribution`, `dcat:DataService`,
`dcat:DatasetSeries` — and a vocabulary for hanging license, provenance, versioning, and temporal
metadata on them. The **single most important modeling decision** in this whole skill: **a license
attaches to the `dcat:Distribution`**, because the license follows the *fetch path*, not the abstract
data concept (the 10Y treasury yield from treasury.gov is GREEN; the same number from Yahoo's chart API
is RED — they are two different `Distribution`s of conceptually the same `Dataset`). DCAT-AP 3.0 states
this verbatim: rights expressions belong at "the most concrete level of sharing, i.e. Distribution or
Data Service" ([DCAT-AP 3.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/)). The **second most
important** decision: **`dcat:DatasetSeries` is an *ordered collection of datasets*, NOT a financial
price-series** — those are false friends, and conflating them is a documented modeling trap (the
project theory doc's negation MINOR,
[00-theory.md:103](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).
A price series maps to a `dcat:Dataset` + its `dcat:Distribution`s. Finally, the **Fusion 5-level
ontology** (Catalog → Data Product → Dataset → Dataset Series Member → Distribution) lines up onto DCAT
class-by-class — and Fusion's own catalog "is written in a DCAT standard"
([Fusion data-catalog solution page](https://fusion.jpmorgan.com/solutions/data-catalog)), so adopting
DCAT v3 is *literally re-engineering the incumbent*, not picking a random standard.

---

## 1. Why a catalog standard at all — the first-principles case

### 1.1 The problem the catalog solves

Our product is a normalized financial Data-as-a-Service: one interface over ~hundreds of datasets and
millions of series, where *finding the right series among millions by structured filters* (asset class,
frequency, source, region) is half the value proposition
([00-theory.md:46](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).
Discovery at that scale is a **faceted/inverted-index problem over metadata**, not a vector-similarity
problem ([00-theory.md:73](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).
To filter and facet, the metadata must be **structured and standardized** — every series needs a row
that says, in machine-readable form: *what it is, who published it, what license governs it, what
period it covers, how often it updates, what file formats it ships in.* That row is a **catalog
record**. The question "what schema does that record use?" is what DCAT answers.

### 1.2 Why DCAT specifically (the three reasons, in order of weight)

1. **It is the incumbent's own model.** J.P. Morgan Fusion — the product we re-engineer — states its
   catalog "is written in a DCAT standard, designed to facilitate metadata consumption and aggregation
   from multiple catalogs to maximize dataset discoverability." Adopting DCAT *is* re-engineering Fusion's
   catalog layer, not inventing a parallel one. *Caveat, version-pinned:* the "written in DCAT" claim
   appears in **Fusion 3.0.2 docs** and is **absent from the latest docs**
   ([00-theory.md:86](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)) —
   so the DCAT recommendation rests on DCAT being a **W3C Recommendation with a peer-reviewed design
   paper**, not on Fusion's current marketing.
2. **It is a W3C Recommendation with peer-reviewed design rationale.** DCAT v3 reached **Recommendation**
   status on 2024-08-22 ([w3.org/news/2024](https://www.w3.org/news/2024/data-catalog-vocabulary-dcat-version-3-is-a-w3c-recommendation/)),
   and its design principles are documented in a peer-reviewed paper in *Data Intelligence* (MIT Press),
   "The W3C Data Catalog Vocabulary, Version 2: Rationale, Design Principles, and Uptake"
   ([direct.mit.edu/dint/article/6/2/457/118751](https://direct.mit.edu/dint/article/6/2/457/118751/The-W3C-Data-Catalog-Vocabulary-Version-2)).
   That is the difference between "a standard" and "a thing a vendor made up."
3. **It is the lingua franca of government open-data portals** — which are exactly the GREEN
   public-domain sources our redistributable v1 catalog is built from (SEC EDGAR, World Bank, US
   Treasury/BLS/BEA, IMF/OECD/Eurostat —
   [00-theory.md:168](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).
   data.gov uses **DCAT-US**, the EU uses **DCAT-AP**. Speaking DCAT means our catalog can *consume*
   theirs and *be consumed by* federated search with zero translation.

### 1.3 What DCAT is and is NOT

| DCAT IS | DCAT is NOT |
|---|---|
| A **vocabulary** (a set of RDF classes + properties with agreed URIs) | A database, a storage format, or a query API |
| A **metadata** model — describes data *about* the data | A model of the data values themselves (that's Frictionless Table Schema — §9) |
| **Serialization-agnostic** — express it as Turtle, JSON-LD, RDF/XML, *or as plain relational columns that mirror the vocabulary* | A mandate to run a triplestore (you do NOT need RDF infra — §10) |
| The model for **Catalog / Dataset / Distribution / Series** structure | The model for **lineage** (that's W3C PROV — see `theory-prov-provenance.md`) or **value-row schema** (Frictionless — §9) |

> **The key liberation (carried in full in §10):** adopting the DCAT *model* does not commit you to
> RDF *technology*. You can implement DCAT v3 as five Postgres tables whose columns are named after
> DCAT properties, and emit a DCAT JSON-LD document only at the API boundary for federation. Match the
> RDF depth to the tier.

---

## 2. The five DCAT v3 core classes (exact vocabulary)

All definitions below are quoted from the W3C DCAT v3 Recommendation
([w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)) unless otherwise cited. The namespace
prefixes used throughout:

```turtle
@prefix dcat:  <http://www.w3.org/ns/dcat#> .
@prefix dcterms: <http://purl.org/dc/terms/> .   # often abbreviated dct:
@prefix dct:   <http://purl.org/dc/terms/> .     # alias for dcterms — both are valid
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix odrl:  <http://www.w3.org/ns/odrl/2/> .
@prefix spdx:  <http://spdx.org/rdf/terms#> .
@prefix adms:  <http://www.w3.org/ns/adms#> .
@prefix foaf:  <http://xmlns.com/foaf/0.1/> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
@prefix vcard: <http://www.w3.org/2006/vcard/ns#> .
```

> `dct:` and `dcterms:` are interchangeable aliases for the same Dublin Core Terms namespace
> `http://purl.org/dc/terms/`. The W3C spec uses `dcterms:`; most examples and this doc use `dct:` for
> brevity. They denote the **same** properties.

### 2.1 `dcat:Catalog`

- **URI:** `http://www.w3.org/ns/dcat#Catalog`
- **Definition (verbatim):** *"A curated collection of metadata about resources."*
- **Subclass of:** `dcat:Dataset` — a catalog is itself a kind of dataset (a dataset whose records are
  metadata). This is why catalog-level properties (license, publisher) reuse the Dataset vocabulary.
- **Usage note (verbatim):** *"A Web-based data catalog is typically represented as a single instance
  of this class."*
- **Key properties:** `dcat:dataset` (links to its `dcat:Dataset`s), `dcat:service` (links to its
  `dcat:DataService`s), `dcat:catalog` (links to sub-catalogs — catalogs nest), `dct:title`,
  `dct:description`, `dct:publisher`, `dct:license`, `dct:issued`, `dct:modified`, `dcat:themeTaxonomy`.

In our product, the **top-level catalog** is the whole data service ("Lumina Markets Data Catalog" or
whatever the product line is named). Sub-catalogs (`dcat:catalog`) can mirror the Fusion **Data
Product** grouping (§7).

### 2.2 `dcat:Dataset`

- **URI:** `http://www.w3.org/ns/dcat#Dataset`
- **Definition (verbatim):** *"A collection of data, published or curated by a single agent or
  identifiable community."*
- **The abstract/concrete split (load-bearing):** A `dcat:Dataset` is the **abstract** data resource —
  the *idea* of "Apple daily closing prices." It has **zero or more** `dcat:Distribution`s, which are
  its **concrete, accessible manifestations** (the CSV, the Parquet, the JSON-over-API). The MIT design
  paper's central principle is precisely this layering: the dataset is conceptual; the distribution is
  what you can actually retrieve. *This separation is the hook that makes the fetch-path licensing rule
  work — see §4.*
- **Key properties:** `dcat:distribution` (→ `dcat:Distribution`), `dct:title`, `dct:description`,
  `dcat:keyword`, `dcat:theme`, `dct:publisher`, `dct:creator`, `dct:license`, `dct:temporal`,
  `dct:spatial`, `dct:accrualPeriodicity`, `dcat:temporalResolution`, `dcat:inSeries` (→ a
  `dcat:DatasetSeries`).
- **In our product:** **one logical financial series = one `dcat:Dataset`.** "Apple daily close"
  is a Dataset; its Twelve Data CSV and its Yahoo JSON are two Distributions. (See §6 — the price-series
  mapping — and the critical disambiguation against `DatasetSeries` in §3.)

### 2.3 `dcat:Distribution`

- **URI:** `http://www.w3.org/ns/dcat#Distribution`
- **Definition (verbatim):** *"An accessible form of a dataset such as a downloadable file."*
- **Role:** the **serialized, retrievable** manifestation of a Dataset — a specific file in a specific
  format at a specific URL, with a specific license. **This is where license + integrity (checksum) +
  format + byte-size metadata live.**
- **Full property list (all verbatim from [w3.org/TR/vocab-dcat-3 §6.4](https://www.w3.org/TR/vocab-dcat-3/)):**

  | Property | URI | Definition (verbatim or close) |
  |---|---|---|
  | `dcat:accessURL` | `dcat:accessURL` | *"A URL of the resource that gives access to a distribution of the dataset."* (landing page / endpoint, **mandatory in DCAT-AP**) |
  | `dcat:downloadURL` | `dcat:downloadURL` | *"A direct link to a downloadable file in a given format."* |
  | `dcat:accessService` | `dcat:accessService` | Links to a `dcat:DataService` that provides access to this distribution. |
  | `dcat:byteSize` | `dcat:byteSize` | *"The size of a distribution in bytes."* (range `xsd:nonNegativeInteger`) |
  | `dcat:compressFormat` | `dcat:compressFormat` | The compression format of the distribution (e.g. gzip). |
  | `dcat:packageFormat` | `dcat:packageFormat` | The packaging format of the distribution (e.g. tar). |
  | `dcat:mediaType` | `dcat:mediaType` | *"The media type of the distribution as defined by IANA"* (e.g. `text/csv`). |
  | `dct:format` | `dcterms:format` | The file format of the distribution (often an EU file-type authority URI). |
  | `dct:title` | `dcterms:title` | *"A name given to the resource."* |
  | `dct:description` | `dcterms:description` | *"A free-text account of the resource."* |
  | **`dct:license`** | `dcterms:license` | *"A legal document under which the resource is made available."* **← the license home (§4).** |
  | `dct:rights` | `dcterms:rights` | A statement concerning rights not addressed by license or accessRights. |
  | `dct:accessRights` | `dcterms:accessRights` | *"Information about who can access the resource or an indication of its security status."* |
  | `dct:conformsTo` | `dcterms:conformsTo` | *"An established standard to which the described resource conforms."* (→ point this at the Frictionless Table Schema — §9.) |
  | `dct:issued` | `dcterms:issued` | *"Date of formal issuance (e.g., publication) of the resource."* |
  | `dct:modified` | `dcterms:modified` | *"Most recent date on which the resource was changed, updated or modified."* |
  | `dcat:temporalResolution` | `dcat:temporalResolution` | The minimum time interval between items (e.g. `P1D` for daily). |
  | `dcat:spatialResolutionInMeters` | `dcat:spatialResolutionInMeters` | *"Minimum spatial separation of items within the dataset"* in meters. |
  | **`spdx:checksum`** | `spdx:checksum` | A cryptographic digest for verifying distribution integrity (§8). |

- **`accessURL` vs `downloadURL` (the spec's explicit distinction, verbatim):** `accessURL` gives
  general "access" including the case where *"the distribution(s) are accessible only through a landing
  page (i.e., direct download URLs are not known)."* `downloadURL` is *"a direct link to a downloadable
  file in a given format."* The spec rule: *"If the distribution(s) are accessible only through a
  landing page (i.e., direct download URLs are not known), then the landing page link SHOULD be
  duplicated as `dcat:accessURL`"* ([§6.4.17](https://www.w3.org/TR/vocab-dcat-3/)).
  - For a **downloadable Parquet file on object storage**, set **both** `downloadURL` (the presigned
    S3 URL) and `accessURL` (the catalog/landing page).
  - For a **live REST endpoint** (the point-read API), use `accessURL` → the endpoint and link
    `dcat:accessService` → the `dcat:DataService` describing the API.

### 2.4 `dcat:DataService`

- **URI:** `http://www.w3.org/ns/dcat#DataService`
- **Definition (verbatim):** *"A collection of operations accessible through an interface (API) that
  provide access to one or more datasets or data processing functions."*
- **Added in:** DCAT 2.
- **Key properties:** `dcat:endpointURL` (the API root), `dcat:endpointDescription` (→ the OpenAPI
  3.1 doc — which our product makes the single contract source,
  [00-theory.md](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)),
  `dcat:servesDataset` (→ the `dcat:Dataset`s it serves), `dct:title`, `dct:license` (the API's terms
  of use), `dct:conformsTo`.
- **In our product:** the **REST query API itself** is a `dcat:DataService`. Its `endpointDescription`
  points at our OpenAPI 3.1 spec; its `servesDataset` enumerates the catalog. A `Distribution` that is
  "live from the API" links to this service via `dcat:accessService`. This is how DCAT models the
  difference between *a file you download* and *an API you call* — both are ways to access the same
  abstract `Dataset`.

### 2.5 `dcat:DatasetSeries` — and the CRITICAL disambiguation

- **URI:** `http://www.w3.org/ns/dcat#DatasetSeries`
- **Definition (verbatim):** *"A dataset that represents a collection of datasets that are published
  separately, but share some characteristics that group them."* (Editor's draft phrasing:
  *"A collection of datasets that are published separately, but share some characteristics that group
  them."* — [w3c.github.io/dxwg/dcat](https://w3c.github.io/dxwg/dcat/).)
- **Subclass of:** `dcat:Dataset`.
- **Added in:** **DCAT 3** (one of the headline v3 additions).
- **The spec's own examples (verbatim):** *"Common scenarios for dataset series include: time series
  composed of periodically released subsets; map-series composed of items of the same type or theme but
  with differing spatial footprints."*

> ### ⚠️ THE FALSE FRIEND — read this twice
>
> `dcat:DatasetSeries` is an **ordered collection of *whole datasets*** that are each *published
> separately*. It is **NOT** a financial **price time-series** (a single sequence of `(timestamp,
> value)` rows for one instrument).
>
> The two senses of "series" collide on the word but are structurally different:
>
> | | DCAT `dcat:DatasetSeries` | A financial price series |
> |---|---|---|
> | What it groups | *Whole datasets*, each separately published (e.g. "2022 budget", "2023 budget", "2024 budget") | *Rows* `(date, OHLCV)` for one instrument |
> | Members are | `dcat:Dataset` instances | data points, not datasets |
> | Granularity | One dataset per *release/edition* | One value per *observation* |
> | Right DCAT mapping | `dcat:DatasetSeries` whose members are `dcat:Dataset`s | a **single** `dcat:Dataset` + its `dcat:Distribution`s |
>
> **The project's negation review caught this explicitly** and tagged it a MINOR:
> *"DCAT has no first-class 'Series' class in the financial sense; map 'Series' to a
> Dataset-or-finer granularity (DCAT v3's `dcat:DatasetSeries` is an *ordered collection of datasets* —
> a different sense of 'series'; disambiguate in the model)."*
> ([00-theory.md:103](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md))
>
> **Rule for our product:** "Apple daily close" → ONE `dcat:Dataset`. Do **not** model each day, each
> month, or each year of prices as a member of a `dcat:DatasetSeries`. (When `dcat:DatasetSeries` *is*
> the right tool for us is a narrow, real case — see §3.4.)

- **Series-navigation properties** (for when you *do* model a true dataset series — all from
  [w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/) /
  [w3c.github.io/dxwg/dcat](https://w3c.github.io/dxwg/dcat/)):

  | Property | URI | Domain → Range | Definition (verbatim) |
  |---|---|---|---|
  | `dcat:inSeries` | `dcat:inSeries` | `dcat:Dataset` → `dcat:DatasetSeries` | *"A dataset series of which the dataset is part."* |
  | `dcat:seriesMember` | `dcat:seriesMember` | `dcat:DatasetSeries` → `dcat:Dataset` | The inverse — list of members of the series. (DCAT-US 3.0 marks it **Recommended**.) |
  | `dcat:first` | `dcat:first` | resource → resource | *"The first resource in an ordered collection or series of resources, to which the current resource belongs."* |
  | `dcat:last` | `dcat:last` | resource → resource | *"The last resource in an ordered collection or series of resources, to which the current resource belongs."* |
  | `dcat:prev` | `dcat:prev` | resource → resource | *"The previous resource (before the current one) in an ordered collection or series of resources."* |
  | `dcat:next` | `dcat:next` | resource → resource | The next resource (after the current one). (Inverse of `dcat:prev`.) |

  Note: the *abstract series* is linked to *members* via `dcat:inSeries` / `dcat:seriesMember`; the
  *members to each other* via `dcat:first`/`dcat:prev`/`dcat:next`/`dcat:last`. **Ordering is
  optional** — the editor's draft does not mandate temporal ordering and explicitly allows
  non-temporal grouping (the map-series example). DCAT-AP discussion confirms the definition is "very
  loose and not necessarily restricted to time series."

---

## 3. The disambiguation in depth: time-series vs DatasetSeries

This section earns its length because **getting it wrong cascades** — a wrong choice here makes every
license stamp, every facet filter, and every API path wrong.

### 3.1 The mental model

```
ABSTRACT (what it is)              CONCRETE (how you get it)
─────────────────────             ──────────────────────────
dcat:Dataset                      dcat:Distribution
"Apple Inc. daily close"  ──┬──►  CSV file on S3   (license: Twelve Data → RED)
                            ├──►  Parquet on S3    (license: Twelve Data → RED)
                            └──►  via REST API      (dcat:accessService → our DataService)

         ▲
         │  the (date, value) ROWS live INSIDE each Distribution.
         │  Their COLUMN schema is the Frictionless Table Schema (§9).
         │  They are NOT cataloged individually.
```

A financial price series is **a single `dcat:Dataset`**. The thousands of `(date, value)` observations
are *rows inside its Distributions*, described once by a Table Schema (§9) — never cataloged as
separate DCAT resources. Cataloging every daily bar as a DCAT resource would explode the catalog by a
factor of ~250 trading days × N years × M instruments and is precisely the anti-pattern §3.3 names.

### 3.2 Why `dcat:DatasetSeries` is tempting but wrong here

It is tempting because:
- The word "series" matches "time series."
- The DCAT spec's *own first example* of a DatasetSeries is *"time series composed of periodically
  released subsets."*

But read that example carefully: the members are *"periodically released **subsets**"* — i.e.
**separately published datasets**, like "the 2024 annual climate observations file" vs "the 2023
annual climate observations file" (the exact DCAT-US worked example —
[resources.data.gov DCAT-US 3 Dataset Series](https://resources.data.gov/resources/dcat-us-3-dataset-series/),
"Annual Climate Observations" 2000–2024 with members 2022/2023/2024). Each member is *itself a full
dataset you could download independently*. A single instrument's continuous price tape is **not**
published as separately-downloadable per-year datasets in our model — it is one continuous Dataset we
materialize into Distributions and serve range-sliced via the API.

### 3.3 The anti-pattern, stated plainly

> **Anti-pattern:** modeling "AAPL price history" as a `dcat:DatasetSeries` whose members are
> `dcat:Dataset`s like "AAPL-2020", "AAPL-2021", "AAPL-2022".
>
> **Why it breaks:** (1) Catalog cardinality explodes — you get N datasets per instrument instead of
> 1, and the facet index (`asset class`, `frequency`, `source`) now has to dedupe across year-shards.
> (2) The license/`commercialOk` verdict is identical across all year-shards (it's the same fetch
> path), so you've duplicated the stamp N times with no information gain. (3) Range queries
> ("2019-06 to 2023-03") now have to *assemble across multiple Datasets* instead of slicing one — the
> exact thing TimescaleDB continuous aggregates and `time_bucket` exist to make trivial *within one
> hypertable* (see the `timescaledb-timeseries` skill). (4) It misrepresents the data: a price tape is
> *one* evolving thing, not a *collection of editions*.
>
> **Fix:** one `dcat:Dataset` per logical instrument-frequency-source series. The time axis lives in
> the rows (the store), the row schema lives in the Distribution's Table Schema (§9), and range
> selection is an API parameter, not a catalog navigation.

### 3.4 When `dcat:DatasetSeries` IS the right tool for us (the narrow real cases)

DatasetSeries is legitimately useful when we genuinely publish **separate, independently-downloadable
editions** of a dataset over time. Real financial examples:

- **Point-in-time / vintage snapshots of a fundamentals dataset.** SEC EDGAR financial-statement
  datasets are released as *quarterly ZIP archives* — "2024q1", "2024q2", each a complete, separately
  downloadable file. Modeling those as a `dcat:DatasetSeries` (members = the per-quarter Datasets,
  linked `prev`/`next`) is correct: each *is* a separately published dataset.
- **Versioned reference data** published as discrete dated releases (e.g. an index-constituents file
  reissued each rebalance).
- **Snapshot exports of a full catalog dump** ("the 2026-06-24 full extract" vs "the 2026-06-25 full
  extract").

The test: *"Is each member something a user would download as a standalone, complete dataset?"* If yes
→ `dcat:DatasetSeries`. If the "members" are just time-ranges of one continuous series → ONE
`dcat:Dataset`, ranges are an API parameter. (Even here, prefer modeling vintages via **bitemporal
columns in the store + a `validFrom/validTo` provenance stamp** — see `theory-prov-provenance.md` and
the security-master discussion — and use DatasetSeries only when you genuinely ship the editions as
separate files.)

### 3.5 Decision table

| Your data | DCAT mapping | Time axis lives in |
|---|---|---|
| One instrument's continuous price tape (any frequency) | **1× `dcat:Dataset`** + its Distributions | the rows / store; range = API param |
| Same series from 3 providers | **1× `dcat:Dataset`** + **3× `dcat:Distribution`** (one per provider/fetch-path) | the rows; provider = which Distribution |
| Quarterly EDGAR financial-statement archives | **`dcat:DatasetSeries`** + member `dcat:Dataset` per quarter | each member is a whole file |
| Full nightly catalog export, one file per night | **`dcat:DatasetSeries`** + member per date | each member is a whole snapshot |
| A panel (many instruments × many dates) shipped as one bulk file | **1× `dcat:Dataset`** + Distribution(s); the panel shape is in the Table Schema | the rows |

---

## 4. WHERE LICENSING ATTACHES — the most important section

### 4.1 The DCAT facts

DCAT permits `dct:license`, `dct:rights`, `dct:accessRights`, and `odrl:hasPolicy` on **any
`dcat:Resource`** — and `dcat:Catalog`, `dcat:Dataset`, `dcat:Distribution`, and `dcat:DataService` are
all subclasses of `dcat:Resource`. The spec is permissive: *"Information about licenses and rights MAY
be provided for the Resource."* ([w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)). So
*structurally* the license could go on the Catalog, the Dataset, or the Distribution.

The four rights properties (all verbatim):

| Property | URI | Range | Definition |
|---|---|---|---|
| `dct:license` | `dcterms:license` | `dcterms:LicenseDocument` | *"A legal document under which the resource is made available."* |
| `dct:rights` | `dcterms:rights` | `dcterms:RightsStatement` | *"A statement that concerns all rights not addressed with license or accessRights."* |
| `dct:accessRights` | `dcterms:accessRights` | `dcterms:RightsStatement` | *"Information about who can access the resource or an indication of its security status."* |
| `odrl:hasPolicy` | `odrl:hasPolicy` | `odrl:Policy` | *"An ODRL conformant policy expressing the rights associated with the resource."* |

### 4.2 The decision: license attaches to the `dcat:Distribution`

**Two authoritative profiles both moved the license to Distribution, and both for our exact reason:**

1. **DCAT-US 3.0:** *"License moves from Dataset to Distribution level in v3.0 … Agencies should add
   `license` to each Distribution object."*
   ([resources.data.gov/resources/dcat-us3](https://resources.data.gov/resources/dcat-us3/)).
2. **DCAT-AP 3.0:** rights expressions belong at *"the most concrete level of sharing, i.e.
   Distribution or Data Service,"* avoiding conflicts with Dataset-level declarations, *because
   "licences, rights and access rights are expressions in the context of a legislation"* and the
   concrete artifact is what is actually licensed
   ([semiceu.github.io/DCAT-AP/releases/3.0.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/)).

### 4.3 Why the Distribution is the natural home — the fetch-path rule

This is the linchpin connecting DCAT to **this product's entire licensing discipline.** The rule (from
[`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md)):

> **The license attaches to the FETCH PATH, not the concept.** The US-Treasury 10Y yield fetched from
> treasury.gov is public-domain GREEN; the *exact same number* from Yahoo's chart API is RED. You
> cannot reason about licensing from the data *type* — only from *where you fetched it*.

DCAT models this perfectly **because the `dcat:Distribution` IS the fetch path:**

- The **`dcat:Dataset`** is the *concept* — "Apple daily close." A concept has no license; the *idea*
  of Apple's stock price isn't copyrighted.
- The **`dcat:Distribution`** is the *concrete artifact obtained from a specific source by a specific
  access path* — "Apple daily close, as a CSV fetched from Twelve Data." **That** has a license,
  because *that specific delivery* is what a provider's ToS governs.

So the same `dcat:Dataset` "10Y Treasury yield" can carry **two Distributions**:

```turtle
<dataset/ust-10y>  a dcat:Dataset ;
    dct:title "US 10-Year Treasury Constant Maturity Yield" ;
    dcat:distribution <dist/ust-10y/treasury-gov>, <dist/ust-10y/yahoo> .

<dist/ust-10y/treasury-gov>  a dcat:Distribution ;
    dct:title "From treasury.gov (public-domain)" ;
    dcat:downloadURL <https://.../treasury-10y.csv> ;
    dct:license <https://www.usa.gov/government-works> ;   # US-gov public domain
    # → our Provenance stamp: commercialOk: true   (GREEN, §4.5)
    .

<dist/ust-10y/yahoo>  a dcat:Distribution ;
    dct:title "From Yahoo chart API" ;
    dcat:accessURL <https://query1.finance.yahoo.com/...> ;
    dct:rights "Yahoo Terms of Service — no commercial redistribution" ;
    # → our Provenance stamp: commercialOk: false   (RED, §4.5)
    .
```

**Same Dataset, same numbers, two licenses — and DCAT puts each license exactly where it belongs:
on the Distribution.** If the license lived on the Dataset, you could not express that the same
concept is GREEN via one path and RED via another. **That is the whole reason the Distribution is the
home.** Put the license on the Dataset and the fetch-path rule becomes inexpressible.

### 4.4 The contamination corollary (where a composite's license lives)

When a Distribution is a **derived/composite** series (e.g. a sentiment composite blending GDELT-GREEN
with an ApeWisdom-RED input), the *output* Distribution inherits the **most restrictive** input
license — RED contaminates GREEN ([`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md);
the F2 "contamination rule" in [`red-team-negation-loop.md`](../../../.claude/rules/red-team-negation-loop.md)).
DCAT expresses the inputs via provenance (`dct:source`, `prov:wasDerivedFrom` — §5), but the
**`dct:license`/`commercialOk` of the composite Distribution is the floor of its inputs**, computed by
us, not a free pass. This is enforced in `patterns-license-resolution.md`; the *modeling* point here:
the composite is its own Distribution with its own (derived) license, sourced-from the inputs.

### 4.5 The bridge to our `Provenance{commercialOk}` stamp

DCAT gives us the *standard structural slot* (`dct:license` on the Distribution); our product layers a
**machine-readable verdict** on top — the `Provenance{ source, commercialOk, fetchedAt, asOf, ... }`
record that every series carries
([00-theory.md:50](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md),
[`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md)). The relationship:

| Concept | DCAT property (the standard slot) | Our enrichment (the verdict) |
|---|---|---|
| The legal document | `dct:license` → a `LicenseDocument` URI on the Distribution | — |
| Human rights note | `dct:rights` on the Distribution | — |
| Who can access | `dct:accessRights` on the Distribution | — |
| **Is it OK to display commercially?** | *(DCAT has no boolean for this)* | **`commercialOk: boolean`, default `false`** — derived from the fetch path, gated against the [sources-ledger](../../../.claude/memory/sources-ledger.md) |

`commercialOk` is **not** a DCAT property — it is *our* computed verdict, stamped alongside the DCAT
metadata. DCAT says *what the license document is*; `commercialOk` says *what we concluded we're allowed
to do with this exact fetch path.* `dct:license` is the citation; `commercialOk` is the ruling. The
machinery that derives one from the other lives in `patterns-license-resolution.md` and
`theory-licensing-buckets.md`; the *place it hangs* — the `dcat:Distribution` — is fixed here.

### 4.6 ODRL — when you need machine-enforceable policy

`odrl:hasPolicy` lets you attach an **ODRL (Open Digital Rights Language) policy** — a machine-readable
permission/prohibition/duty graph (e.g. "permit `display` if duty `attribution` fulfilled; prohibit
`redistribute`"). This is **overkill for v1** (our `commercialOk` boolean + attribution string covers
the GREEN public-domain catalog). Reach for ODRL only at Tier 3 when you sell access tiers with
*differentiated, automatically-enforced* usage rights per consumer. Note it exists; do not build it
yet. (Matches the §10 tier discipline.)

---

## 5. Provenance properties (the DCAT side; PROV-O depth is its own doc)

DCAT carries a *light* provenance vocabulary; deep lineage (Entity/Activity/Agent graphs, transform
chains) is **W3C PROV-O**, covered in the sibling `theory-prov-provenance.md`. Here: the DCAT-native
slots that bridge into it.

| Property | URI | Domain | Definition / use |
|---|---|---|---|
| `dct:creator` | `dcterms:creator` | `dcat:Resource` | *"The entity responsible for producing the resource."* (e.g. the upstream data originator.) |
| `dct:publisher` | `dcterms:publisher` | `dcat:Resource` | *"The entity responsible for making the resource available."* (e.g. the provider; or *us* for our own derived series.) |
| `prov:qualifiedAttribution` | `prov:qualifiedAttribution` | `prov:Entity` (incl. `dcat:Resource`) | *"Link to an Agent having some form of responsibility for the resource"* — when the relationship is known but isn't plain creator/publisher. Use a `prov:Attribution` node with `dcat:hadRole` to name the role. |
| `dcat:hadRole` | `dcat:hadRole` | on `prov:Attribution` / `dcat:Relationship` | Names the role an agent (or related resource) plays (e.g. "originator", "redistributor", "funder"). |
| `dct:provenance` | `dcterms:provenance` | `dcat:Resource` | A `dcterms:ProvenanceStatement` — *human-readable* statement of changes in ownership/custody since creation. Free-text lineage. |
| `dct:source` | `dcterms:source` | `dcat:Resource` | *"A related resource from which the described resource is derived."* — **this is the catalog hook for the fetch-path origin** and for composite inputs (§4.4). |
| `dcat:wasGeneratedBy` | `dcat:wasGeneratedBy` (sub-property of `prov:wasGeneratedBy`) | `dcat:Dataset` | Links a dataset to the **`prov:Activity`** that generated it — the bridge to a full PROV lineage graph. |
| `dcat:qualifiedRelation` | `dcat:qualifiedRelation` | `dcat:Resource` → `dcat:Relationship` | *"Link to a description of a relationship with another resource"* when it isn't a standard Dublin Core/PROV property. |

> **Note on `dct:provenance` and `dct:source`:** the W3C DCAT spec's property *index* does not list
> these as DCAT-coined terms (they are Dublin Core terms reused), so a naive read of the DCAT page can
> miss them — but they are valid on any `dcat:Resource` and are the idiomatic catalog-level provenance
> hooks. DCAT-US 3.0 specifically structures provenance through *"Activity-related governance terms via
> `wasGeneratedBy` and `wasUsedBy`,"* replacing free-text
> ([resources.data.gov/resources/dcat-us3](https://resources.data.gov/resources/dcat-us3/)).

### 5.1 Plain vs qualified attribution — when to upgrade

- **Plain** (`dct:creator`, `dct:publisher`): use when the relationship fits the Dublin Core word.
  "World Bank is the `dct:publisher`." Cheap, 90% of cases.
- **Qualified** (`prov:qualifiedAttribution` + `dcat:hadRole`): use when you need to name a **specific
  role** that isn't creator/publisher — "this agent is the *redistributor*", "this agent is the
  *licensor*", "this agent *normalized* it." The spec rationale (verbatim): *"Used to link to an Agent
  where the nature of the relationship is known but does not match one of the standard Dublin Core
  properties … Use `dcat:hadRole` on the `prov:Attribution` to capture the responsibility of the Agent
  with respect to the Resource."* ([w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)).

```turtle
# Plain — enough for most:
<dist/wb-gdp>  dct:creator   <agent/world-bank> ;
               dct:publisher <agent/our-data-service> .

# Qualified — when role matters (we are the *normalizer/redistributor*, not the originator):
<dist/wb-gdp>  prov:qualifiedAttribution [
    a prov:Attribution ;
    prov:agent  <agent/our-data-service> ;
    dcat:hadRole <http://www.iana.org/assignments/relation/... or a role vocab IRI> ;
] .
```

In our product, **the originator vs us-as-redistributor distinction is licensing-relevant** (it's the
difference between "World Bank's CC-BY" and "our value-add layer"), so the qualified form earns its
keep on the Distribution-level provenance stamp. Deep transform-lineage (which Activity produced this,
from which inputs, when) → `dcat:wasGeneratedBy` → a PROV `Activity` → `theory-prov-provenance.md`.

---

## 6. Mapping a financial price series onto DCAT (the worked model)

Pulling §2–§5 together for the canonical case. **"Apple Inc. daily closing price, from Twelve Data."**

```turtle
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix spdx: <http://spdx.org/rdf/terms#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .

### The ABSTRACT series — ONE dcat:Dataset (NOT a DatasetSeries) ###
<dataset/equity/AAPL/daily-close>
    a dcat:Dataset ;
    dct:title       "Apple Inc. (AAPL) — Daily Close" ;
    dct:description "Daily closing price for AAPL on NASDAQ, adjusted." ;
    dcat:keyword    "equity", "AAPL", "US", "daily" ;
    dcat:theme      <theme/equities> ;
    dct:publisher   <agent/our-data-service> ;
    dct:temporal    [ a dct:PeriodOfTime ;
                      dcat:startDate "1980-12-12"^^xsd:date ;
                      dcat:endDate   "2026-06-24"^^xsd:date ] ;
    dcat:temporalResolution "P1D"^^xsd:duration ;       # daily
    dct:accrualPeriodicity <http://publications.europa.eu/resource/authority/frequency/DAILY> ;
    dcat:distribution
        <dist/.../parquet> ,            # bulk download
        <dist/.../live-api> .           # via the REST DataService

### CONCRETE manifestation 1 — the Parquet file (a real fetch path → licensed) ###
<dist/equity/AAPL/daily-close/parquet>
    a dcat:Distribution ;
    dct:title       "AAPL daily close — Parquet (Twelve Data origin)" ;
    dcat:downloadURL <https://cdn.../aapl_daily_close.parquet> ;
    dcat:accessURL   <https://catalog.../dataset/equity/AAPL/daily-close> ;
    dct:format       <http://publications.europa.eu/resource/authority/file-type/PARQUET> ;
    dcat:mediaType   <https://www.iana.org/assignments/media-types/application/vnd.apache.parquet> ;
    dcat:byteSize    "184320"^^xsd:nonNegativeInteger ;
    dct:issued       "2026-06-24T02:00:00Z"^^xsd:dateTime ;
    dct:modified     "2026-06-24T02:00:00Z"^^xsd:dateTime ;
    dcat:temporalResolution "P1D"^^xsd:duration ;
    dct:rights       "Twelve Data ToS — free tier, no commercial redistribution" ;
    # ← Provenance stamp (our enrichment, §4.5): commercialOk:false (RED — vendor free tier)
    dct:conformsTo   <schema/ohlcv-daily.tableschema.json> ;     # the Table Schema (§9)
    spdx:checksum    [ a spdx:Checksum ;
                       spdx:algorithm spdx:checksumAlgorithm_sha256 ;
                       spdx:checksumValue "9f86d0818...e7cf"^^xsd:hexBinary ] .

### CONCRETE manifestation 2 — live via the API (a dcat:DataService) ###
<dist/equity/AAPL/daily-close/live-api>
    a dcat:Distribution ;
    dct:title        "AAPL daily close — live via Markets Data API" ;
    dcat:accessURL   <https://api.../v1/series/equity/AAPL/daily-close> ;
    dcat:accessService <service/markets-data-api> ;
    dct:format       <.../file-type/JSON> ;
    dct:conformsTo   <schema/ohlcv-daily.tableschema.json> .

### The API itself — a dcat:DataService ###
<service/markets-data-api>
    a dcat:DataService ;
    dct:title             "Markets Data API" ;
    dcat:endpointURL      <https://api.../v1> ;
    dcat:endpointDescription <https://api.../openapi.json> ;     # OpenAPI 3.1, the contract source
    dcat:servesDataset    <dataset/equity/AAPL/daily-close> .
```

**Things to notice (each is a deliberate modeling choice):**
- **One `dcat:Dataset`**, not a DatasetSeries (§3).
- **Same Dataset → two Distributions** (file + live); each is a fetch path with its own access props.
  Add a *third* Distribution if you also ingest the same series from Yahoo — and **that** one would
  carry `commercialOk:false` for a *different* reason (Yahoo ToS), proving §4.3's point.
- **License lives on each Distribution** (here both are Twelve Data → RED). A treasury.gov-sourced
  Distribution on a *different* Dataset would be GREEN — the per-path verdict.
- **`dct:conformsTo` points at the Table Schema** (§9) — the row-level column contract.
- **`spdx:checksum`** gives integrity (§8).
- **`dct:accrualPeriodicity`** uses the EU frequency authority list (§7.2).
- The **time axis is nowhere in the catalog** — it lives in the rows inside the Parquet / behind the
  API. `dct:temporal` states only the *coverage envelope*; range selection is an API param.

---

## 7. Versioning, temporal/spatial/frequency, and the v3 deltas

### 7.1 Versioning (much of this is NEW in DCAT v3)

The W3C v3 announcement names *"addition of properties for supporting versioning"* as a headline delta
([w3.org/news/2024](https://www.w3.org/news/2024/data-catalog-vocabulary-dcat-version-3-is-a-w3c-recommendation/),
elaborated in [w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)).

| Property | URI | New in v3? | Definition / sub-property-of |
|---|---|---|---|
| `dcat:version` | `dcat:version` | refined in v3 | *"The version indicator (name or identifier) of a resource."* (literal) |
| `dcat:versionNotes` | `dcat:versionNotes` | refined | *"Textual notes for describing a version in detail."* (alias for `adms:versionNotes`) |
| `dcat:previousVersion` | `dcat:previousVersion` | **NEW v3** | *"The previous version of a resource in a lineage."* Sub-property of `prov:wasRevisionOf`. |
| `dcat:hasVersion` | `dcat:hasVersion` | **NEW v3** | *"This resource has a more specific, versioned resource."* Sub-property of `dcterms:hasVersion`, `prov:generalizationOf`. |
| `dcat:hasCurrentVersion` | `dcat:hasCurrentVersion` | **NEW v3** | *"This resource has a more specific, versioned resource with equivalent content."* Sub-property of `pav:hasVersion`. |

> **Versioning vs `dcat:DatasetSeries` — don't confuse them either.** Versioning
> (`previousVersion`/`hasCurrentVersion`) is for *revisions of the same dataset* (schema change, error
> correction → a new version). `DatasetSeries` is for *a sequence of distinct editions*. For a
> price-tape **data correction/restatement**, versioning is the right vocabulary (the Dataset gets a new
> `dcat:version` and a `dcat:previousVersion` link). For bitemporal *vintage* tracking (what the value
> *was thought to be* as-of a past date), prefer store-level bitemporal columns + a PROV stamp; surface
> the DCAT version link only for catalog-visible reissues.

### 7.2 Temporal, spatial, frequency

| Property | URI | Domain | Range / value | Notes |
|---|---|---|---|---|
| `dct:temporal` | `dcterms:temporal` | `dcat:Dataset` | `dct:PeriodOfTime` (with `dcat:startDate`/`dcat:endDate`, both `xsd:date`/`xsd:dateTime`) | The **coverage envelope** of the series. |
| `dcat:temporalResolution` | `dcat:temporalResolution` | `dcat:Dataset`, `dcat:Distribution` | `xsd:duration` (e.g. `P1D` daily, `PT1M` 1-minute, `P1Y` annual) | The **bar spacing** — load-bearing facet for "show me all minute-bar series." |
| `dct:accrualPeriodicity` | `dcterms:accrualPeriodicity` | `dcat:Dataset` | a frequency authority URI | **Update frequency** (≠ resolution!). Use the EU Publications Office Frequency NAL: `http://publications.europa.eu/resource/authority/frequency/{DAILY,WEEKLY,MONTHLY,QUARTERLY,ANNUAL,IRREG,NEVER,...}` ([interoperable-europe.ec.europa.eu — VO4](https://interoperable-europe.ec.europa.eu/collection/semic-support-centre/solution/dcat-application-profile-data-portals-europe/discussion/vo4-choose-between-dcmi-and-sdmx-frequency-vocabulary); the DCMI/SDMX vocabularies are alternatives). |
| `dct:spatial` | `dcterms:spatial` | `dcat:Dataset` | a Location IRI (e.g. Geonames) | Coverage region — for us, the **market/exchange region** (`US`, `IN`, `EU`). |
| `dcat:spatialResolutionInMeters` | `dcat:spatialResolutionInMeters` | `dcat:Dataset`, `dcat:Distribution` | `xsd:decimal` | Geo only — irrelevant for most financial series; omit. |

> **`temporalResolution` ≠ `accrualPeriodicity` (a common bug):** resolution is *how finely spaced the
> data points are* (a daily series has `P1D` resolution); periodicity is *how often we refresh the
> dataset* (a daily series might be refreshed `DAILY`, but an annual GDP figure has `P1Y` resolution
> and is *also* accrued `ANNUAL`). For an intraday series refreshed every minute: resolution `PT1M`,
> periodicity `CONT`/continuous. Index **both** as facets — users filter on each.

### 7.3 The full v3 delta list (what changed from v2 → v3)

From the W3C v3 Recommendation + announcement
([w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/);
[w3.org/news/2024](https://www.w3.org/news/2024/data-catalog-vocabulary-dcat-version-3-is-a-w3c-recommendation/)):

1. **`dcat:DatasetSeries`** — new class for ordered collections of separately-published datasets (§2.5).
2. **Versioning properties** — `dcat:previousVersion`, `dcat:hasVersion`, `dcat:hasCurrentVersion` (§7.1).
3. **`spdx:checksum`** property + **`spdx:Checksum`** class — integrity digests on Distributions (§8).
4. **Data quality / relations** — qualified relations (`dcat:qualifiedRelation`), DQV alignment.
5. **Relaxed constraints, backward-compatible.** Spec note (verbatim): *"DCAT 3 maintains the DCAT
   namespace as its terms preserve backward compatibility with DCAT 2. DCAT 3 relaxes constraints and
   adds new classes and properties, but these changes do not break the definition of previous terms."*

---

## 8. Integrity: `spdx:checksum` (NEW in v3)

A Distribution is a *file*; files can corrupt or silently change. DCAT v3 adopts the **SPDX** checksum
vocabulary so a catalog record can carry a verifiable digest.

- **Property:** `spdx:checksum` on `dcat:Distribution` → an `spdx:Checksum` node.
- **Class:** `spdx:Checksum` with:
  - `spdx:algorithm` → an algorithm IRI, e.g. `spdx:checksumAlgorithm_sha256`,
    `spdx:checksumAlgorithm_sha1`, `spdx:checksumAlgorithm_md5`.
  - `spdx:checksumValue` → the hex digest, typed `xsd:hexBinary`.

```turtle
<dist/.../parquet>
    spdx:checksum [ a spdx:Checksum ;
        spdx:algorithm   spdx:checksumAlgorithm_sha256 ;
        spdx:checksumValue "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"^^xsd:hexBinary ] .
```

Real-world pattern, verbatim from a production catalog
([etl.linkedpipes.com csv-to-rdf example](https://etl.linkedpipes.com/tutorials/csv-to-rdf/add_metadata)):

```turtle
<.../distribution/checksum>
    a spdx:Checksum ;
    spdx:algorithm     spdx:checksumAlgorithm_sha1 ;
    spdx:checksumValue "1d89b35e6e1f1a08b93a02c6c954e3e4ad97e125"^^xsd:hexBinary .
```

**For our product, the checksum earns its keep three ways:** (1) it lets a consumer verify a bulk
Parquet download wasn't truncated; (2) it is a cheap **change-detection key** — if last night's
materialization produced the same SHA-256, nothing changed and the cache/CDN copy is still valid
(compute-once-serve-many); (3) it is a **provenance integrity anchor** — the checksum recorded at
ingest, carried through the PROV stamp, proves the bytes a user got are the bytes we validated. Prefer
**SHA-256**. Compute it at materialization time, store it on the Distribution row, serve it in the
catalog response.

---

## 9. The per-Distribution row schema: Frictionless Table Schema

DCAT describes the Distribution as a *thing* (format, size, license, checksum) but says **nothing about
the columns inside it.** A consumer who downloads `aapl_daily_close.parquet` needs to know: what
columns, what types, what units, which is the key. That contract is the **Frictionless Table Schema**
([specs.frictionlessdata.io/table-schema](https://specs.frictionlessdata.io/table-schema/)), pointed
to from the Distribution via `dct:conformsTo`. The project theory doc selects exactly this:
*"Per-Distribution schema = Frictionless Table Schema / Data Package — a lightweight JSON descriptor
that travels with each series alongside DCAT catalog metadata"*
([00-theory.md:111](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).

### 9.1 Table Schema structure (exact)

Top-level descriptor (verbatim spec: *"The descriptor MUST contain a property `fields`"*):

```json
{
  "fields": [ /* array of field descriptors — REQUIRED */ ],
  "missingValues": ["", "NA", "null"],
  "primaryKey": "date",
  "foreignKeys": []
}
```

Each **field descriptor**: `name` (required), `title`, `description`, `type` (default `"string"`),
`format`, `constraints`, `example`, `rdfType`.

**Field types** (complete list, [Frictionless](https://specs.frictionlessdata.io/table-schema/)):
`string` (formats: default/email/uri/binary/uuid), `number` (with `decimalChar`/`groupChar`/`bareNumber`),
`integer`, `boolean`, `object`, `array`, `date`, `time`, `datetime`, `year`, `yearmonth`, `duration`,
`geopoint`, `geojson`, `any`.

**Constraints object:** `required`, `unique`, `minLength`, `maxLength`, `minimum`, `maximum`,
`pattern` (regex), `enum`.

### 9.2 The canonical OHLCV daily Table Schema (a build artifact)

```json
{
  "$schema": "https://frictionlessdata.io/schemas/table-schema.json",
  "name": "ohlcv-daily",
  "title": "Daily OHLCV bar",
  "fields": [
    { "name": "date",   "type": "date",   "format": "%Y-%m-%d",
      "title": "Trading date (exchange local)",
      "constraints": { "required": true, "unique": true } },
    { "name": "open",   "type": "number", "title": "Open price",
      "description": "Opening price in quote currency (see dataset units).",
      "constraints": { "minimum": 0 } },
    { "name": "high",   "type": "number", "constraints": { "minimum": 0 } },
    { "name": "low",    "type": "number", "constraints": { "minimum": 0 } },
    { "name": "close",  "type": "number", "title": "Close price (adjusted)",
      "constraints": { "required": true, "minimum": 0 } },
    { "name": "volume", "type": "integer", "title": "Share volume",
      "constraints": { "minimum": 0 } },
    { "name": "currency", "type": "string", "constraints": { "enum": ["USD","INR","EUR"] } }
  ],
  "missingValues": ["", "NaN", "null"],
  "primaryKey": "date"
}
```

Then on the Distribution: `dct:conformsTo <schema/ohlcv-daily.tableschema.json>`. Now a consumer (human
*or* the MCP agent) knows the exact column contract **without downloading the file** — which is the
whole point of a catalog. Units, currency, and adjustment semantics that the Table Schema can't fully
express belong in the **normalization standard-model** (the `data-normalization-tet` skill) and the
**provenance stamp**; the Table Schema is the *structural* contract, the standard-model is the
*semantic* one. (A **Frictionless Data Package** — `datapackage.json` — bundles the Table Schema(s) +
DCAT-ish metadata into one descriptor shipped *with* a bulk export; reach for it when you ship
multi-table bulk distributions.)

### 9.3 What lives where (the layering, stated once)

| Layer | Standard | Answers |
|---|---|---|
| Catalog structure | **DCAT v3** | What datasets/distributions exist, license, period, frequency |
| Row/column contract | **Frictionless Table Schema** (via `dct:conformsTo`) | What columns, types, key, allowed values |
| Value semantics (units/scale/tz/currency) | **the normalization standard-model** (`data-normalization-tet`) | What the numbers *mean* (cents vs dollars, UTC, adjusted) |
| Lineage / who-did-what | **W3C PROV-O** (via `dcat:wasGeneratedBy`/`dct:source`) | How it was produced, from what, when |
| Display-license verdict | **our `Provenance{commercialOk}`** (alongside `dct:license`) | May we display it commercially |

DCAT is the **spine**; the other four hang off it at the points this doc fixed.

---

## 10. The Fusion 5-level ontology → DCAT mapping (the bridge)

The product re-engineers Fusion, whose ontology is **5 levels** (verbatim from
[jpmorganchase.github.io/fusion/latest](https://jpmorganchase.github.io/fusion/latest/), adopted as the
headline at [00-theory.md:26,85,97](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)):

**Catalog → Data Product → Dataset → Dataset Series Member → Distribution**

Fusion's own definitions (verbatim from the Fusion data-model docs):

| Fusion level | Fusion definition (verbatim) |
|---|---|
| **Catalog** | *"An inventory of data products and datasets. It maintains metadata that describes each product or dataset, allowing data to be classified and effectively managed."* |
| **Data Product** | *"A grouping of related datasets with its own metadata that may reflect a logical way to group datasets."* |
| **Dataset** | *"A grouping of related data, for example the data held in a database table or data relating to a specific entity."* |
| **Dataset Series Member** | *"A specific instance of a dataset. For structured data, a series member typically represents an instance of a time series range. For unstructured data, this contain a variety of forms, for example, a PDF within a corpus of documents."* |
| **Distribution** | *"Downloadable instances of a dataset, containing a file type, for example CSV or Parquet."* |

And Fusion's **REST API path hierarchy** confirms the nesting
([Fusion API / PyFusion](https://jpmorganchase.github.io/fusion/latest/),
[00-theory.md:96–98](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)):

```
GET catalogs/{catalog}/datasets/{dataset}/datasetseries
GET catalogs/{catalog}/datasets/{dataset}/datasetseries/{seriesmember}
GET catalogs/{catalog}/datasets/{dataset}/datasetseries/{seriesmember}/distributions
```

### 10.1 The mapping table

| Fusion level | DCAT v3 class | Fit | Notes |
|---|---|---|---|
| **Catalog** | `dcat:Catalog` | **exact** | Both = curated inventory of metadata. |
| **Data Product** | `dcat:Catalog` (sub-catalog via `dcat:catalog`) **or** a `dcat:Dataset` group | **good** | A "grouping of related datasets" maps to a nested catalog or a themed grouping. DCAT has no first-class "Data Product"; model it as a sub-`dcat:Catalog` (preferred — it *contains* datasets) or via `dcat:theme`/`dct:isPartOf`. |
| **Dataset** | `dcat:Dataset` | **exact** | Both = a grouping of related data / a logical entity. **One financial series = one `dcat:Dataset`.** |
| **Dataset Series Member** | *(see below — the subtle one)* | **CAREFUL** | Fusion's "series member = an instance of a time-series **range**" is **NOT** `dcat:DatasetSeries` (§3). Map a member to a **`dcat:Distribution`** (a concrete instance of the dataset) — or, if members are genuinely separately-published whole datasets, to member `dcat:Dataset`s under a `dcat:DatasetSeries`. |
| **Distribution** | `dcat:Distribution` | **exact** | Both = downloadable instance with a file type (CSV/Parquet). |

### 10.2 The "Dataset Series Member" subtlety — resolved

This is the single trickiest junction, because **Fusion's "Dataset Series Member" and DCAT's
`dcat:DatasetSeries` use "series" in *different* senses** — the same false-friend trap as §3, now at
the ontology-bridge.

- Fusion says a Series Member *"typically represents an instance of a **time series range**"* — i.e. a
  **slice/instance** of a dataset (a downloadable chunk covering some time range), often a *file*.
- DCAT's `dcat:DatasetSeries` is a *collection of separately-published whole datasets*.

So **do not** reflexively map Fusion "Dataset Series Member" → `dcat:DatasetSeries`. The correct
mapping depends on what the member *is*:

| If the Fusion Series Member is… | Map it to… | Why |
|---|---|---|
| A downloadable instance/slice of one dataset (a file covering a time range) | **`dcat:Distribution`** of the parent `dcat:Dataset` | It is a *concrete accessible form* — that's literally the Distribution definition. The "range" is metadata on the Distribution (`dct:temporal`). |
| A separately-published *whole edition* (e.g. the 2024Q1 EDGAR archive) | A member **`dcat:Dataset`** under a parent **`dcat:DatasetSeries`** | Each edition is itself a complete dataset (§3.4). |
| A point-in-time *vintage* of values | a **Distribution + bitemporal provenance stamp** (preferred) | Vintage = "what we believed as-of date X"; model in the store + PROV, not as a catalog explosion. |

**Default for our continuous price tapes:** a Fusion "Series Member" → a **`dcat:Distribution`** (the
downloadable Parquet for a range, or the live-API form), under **one** `dcat:Dataset` per logical
series. We reserve `dcat:DatasetSeries` for the genuine separately-published-editions cases (EDGAR
quarterly archives, nightly full exports). This keeps the catalog at ~1 Dataset per series (sane facet
cardinality) and puts the time-range where it belongs — on the Distribution and in the store.

### 10.3 The resulting nesting (our model)

```
dcat:Catalog  "Markets Data Catalog"                    ← Fusion Catalog
 └─ dcat:Catalog "Equities" (sub-catalog)               ← Fusion Data Product
     └─ dcat:Dataset "AAPL daily close"                 ← Fusion Dataset  (ONE per series)
         ├─ dcat:Distribution  Parquet (Twelve Data)    ← Fusion Series Member / Distribution
         │     · dct:license / commercialOk  (per fetch path)
         │     · spdx:checksum · dct:conformsTo → Table Schema
         ├─ dcat:Distribution  Parquet (Yahoo)          ← different fetch path → different license
         └─ dcat:Distribution  live-API (→ dcat:DataService)
 └─ dcat:DataService "Markets Data API"  (endpointDescription → OpenAPI 3.1)
```

This *is* the Fusion ontology, expressed in a W3C Recommendation, with the licensing layer **promoted
from afterthought to headline** — the product's stated edge
([00-theory.md:15,26](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).

---

## 11. When NOT to go full RDF — match the depth to the tier

Adopting the DCAT *model* does **not** require running a triplestore or emitting Turtle for every
internal call. Match RDF depth to the R-SCALE tier ([`product-at-scale.md`](../../../.claude/rules/product-at-scale.md);
the global R-SCALE battery `~/.claude/rules/product-scale-architecture.md`).

| Tier | What to build | RDF depth | Rationale |
|---|---|---|---|
| **1× (demo)** | Catalog as a handful of **Postgres tables** whose columns are named after DCAT properties (`catalog`, `dataset`, `distribution`, with `license`, `commercial_ok`, `temporal_start/end`, `accrual_periodicity`, `temporal_resolution`, `checksum_sha256`, `conforms_to`). **No RDF at all.** | **None** | The DCAT *model* gives you the right column set and relationships; you get standards-aligned structure with plain SQL. The vocabulary is the value; RDF is optional packaging. |
| **100× (traction)** | Same relational core; add a **DCAT JSON-LD serializer at the API boundary** so the catalog can be *consumed by* federated portals and *emit* `application/ld+json`. Facet/search via Postgres FTS / a search engine over the relational catalog columns. | **JSON-LD at the edge only** | You speak DCAT to the outside world without paying RDF cost internally. JSON-LD is "JSON that happens to be RDF" — cheap to emit from relational rows. |
| **10,000× (the product)** | Relational catalog + JSON-LD edge **+** optionally a triplestore/SPARQL endpoint **iff** a consumer demands federated SPARQL or rich qualified-relation graph traversal; ODRL policies (§4.6) for differentiated paid usage rights. | **Full RDF where a consumer pays for it** | Only build the triplestore when an actual integration needs SPARQL. Most consumers want JSON + OpenAPI, not SPARQL. Don't pre-build the graph DB. |

> **The discipline:** DCAT is a **modeling decision**, not a **technology decision**. Get the classes,
> the property names, and *where license/provenance hang* right from day one (cheap, permanent). Defer
> RDF serialization to the API boundary (Tier 2), and a triplestore to a paying federation consumer
> (Tier 3). The project theory doc's whole warning is *"shipping a Tier-1 implementation while
> believing it's Tier-3"* ([product-at-scale.md](../../../.claude/rules/product-at-scale.md)) — for the
> catalog the inverse trap also bites: **over-building a SPARQL triplestore for a Tier-1 catalog nobody
> federates with yet.** Build the model now; build the RDF infra when a consumer pays for it.

### 11.1 The relational catalog skeleton (Tier-1/2, no RDF)

```sql
-- DCAT model as plain Postgres. Column names mirror DCAT/Dublin Core property names.
CREATE TABLE catalog (
  id            text PRIMARY KEY,
  title         text NOT NULL,                 -- dct:title
  description   text,                          -- dct:description
  publisher     text,                          -- dct:publisher
  parent_id     text REFERENCES catalog(id),   -- dcat:catalog (sub-catalog = Fusion Data Product)
  issued        timestamptz, modified timestamptz
);

CREATE TABLE dataset (
  id                   text PRIMARY KEY,
  catalog_id           text NOT NULL REFERENCES catalog(id),
  title                text NOT NULL,                  -- dct:title
  description          text,
  keywords             text[],                         -- dcat:keyword   (GIN-indexed facet)
  theme                text,                           -- dcat:theme     (facet)
  asset_class          text,                           -- our facet
  region               text,                           -- dct:spatial    (facet)
  temporal_start       date,  temporal_end date,       -- dct:temporal
  temporal_resolution  text,                           -- dcat:temporalResolution  (e.g. 'P1D')  (facet)
  accrual_periodicity  text,                            -- dct:accrualPeriodicity   (facet)
  version              text,                           -- dcat:version
  previous_version_id  text REFERENCES dataset(id),    -- dcat:previousVersion
  in_series_id         text                            -- dcat:inSeries (NULL for continuous tapes)
);
-- index the columns users actually facet on (R-SCALE §A.4: an unindexed filter is a full-table scan)
CREATE INDEX ON dataset (asset_class, region, temporal_resolution, accrual_periodicity);
CREATE INDEX ON dataset USING gin (keywords);

CREATE TABLE distribution (
  id            text PRIMARY KEY,
  dataset_id    text NOT NULL REFERENCES dataset(id),
  title         text,
  download_url  text,                           -- dcat:downloadURL
  access_url    text,                           -- dcat:accessURL
  media_type    text,                           -- dcat:mediaType  ('application/vnd.apache.parquet')
  format        text,                           -- dct:format
  byte_size     bigint,                         -- dcat:byteSize
  -- ── licensing lives HERE, per fetch path (§4) ──
  source        text NOT NULL,                  -- the fetch path / provider  (e.g. 'twelvedata')
  license       text,                           -- dct:license  (the legal doc / URI)
  rights        text,                           -- dct:rights
  commercial_ok boolean NOT NULL DEFAULT false, -- OUR verdict — default false (commercial-ok-gate)
  -- ── integrity + schema ──
  checksum_sha256 text,                         -- spdx:checksum
  conforms_to   text,                           -- dct:conformsTo → Table Schema URI/id
  issued        timestamptz, modified timestamptz
);
CREATE INDEX ON distribution (dataset_id);
CREATE INDEX ON distribution (commercial_ok);   -- "show me only GREEN-displayable series"
```

This skeleton **is** DCAT v3 — every column traces to a property defined in §2–§8 — yet it is plain
indexed Postgres that the faceted-discovery API (the
[dataquery-delivery-channels](../../dataquery-delivery-channels/SKILL.md) skill) queries directly. RDF
is a serialization you bolt on at the edge when federation demands it, **not** a prerequisite to having
a correct, standards-aligned catalog.

---

## 12. Pitfalls index (the quick-reference)

| Pitfall | Why it's wrong | Fix |
|---|---|---|
| Model a price tape as `dcat:DatasetSeries` | DatasetSeries = ordered collection of *separate datasets*, not a row-sequence (§3) | ONE `dcat:Dataset`; rows in the store; range = API param |
| Put `dct:license` on the `dcat:Dataset` | The license follows the **fetch path**; same concept can be GREEN via one path, RED via another (§4) | License on each `dcat:Distribution` |
| Treat `commercialOk` as a DCAT property | DCAT has no display-license boolean; it's *our* derived verdict (§4.5) | Stamp `commercialOk` alongside `dct:license`, default `false` |
| Confuse `temporalResolution` with `accrualPeriodicity` | Resolution = bar spacing; periodicity = refresh frequency (§7.2) | Index and populate *both* as separate facets |
| Map Fusion "Series Member" → `dcat:DatasetSeries` reflexively | Fusion's "series member = time-range instance" ≠ DCAT DatasetSeries (§10.2) | Member → `dcat:Distribution` (default), or member-`Dataset` under a `DatasetSeries` only if separately-published editions |
| A composite series claims GREEN while blending a RED input | RED contaminates (§4.4) | Composite Distribution's license = floor of its inputs |
| Build a SPARQL triplestore for a Tier-1 catalog | Over-building RDF infra nobody federates with yet (§11) | Relational catalog now; JSON-LD at edge (Tier 2); triplestore only for a paying federation consumer |
| Catalog every daily bar as a DCAT resource | Cardinality explosion × license-stamp duplication (§3.3) | The time axis lives in rows, not catalog nodes |
| Omit `dct:conformsTo` on the Distribution | Consumer can't know the column contract without downloading (§9) | Point `dct:conformsTo` at the Frictionless Table Schema |

---

## 13. Sources (primary, read this run)

- **W3C DCAT v3 Recommendation** — exact class/property vocabulary, license-on-Distribution, DatasetSeries
  definition, qualified attribution, accessURL-vs-downloadURL.
  [w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/) ·
  editor's draft [w3c.github.io/dxwg/dcat](https://w3c.github.io/dxwg/dcat/)
- **W3C v3-is-a-Recommendation announcement** — publication date 2024-08-22 + the v3 deltas (versioning,
  checksum, DatasetSeries).
  [w3.org/news/2024](https://www.w3.org/news/2024/data-catalog-vocabulary-dcat-version-3-is-a-w3c-recommendation/)
- **MIT/Data Intelligence design paper** — DCAT rationale & design principles (the abstract/concrete
  Dataset-vs-Distribution split; uptake).
  [direct.mit.edu/dint/article/6/2/457/118751](https://direct.mit.edu/dint/article/6/2/457/118751/The-W3C-Data-Catalog-Vocabulary-Version-2)
  (HTTP-403 to the fetcher; cited via the project theory doc which read it +
  [MIT Press journal index](https://direct.mit.edu/dint))
- **JPM Fusion docs** — the 5-level ontology verbatim + REST path hierarchy + "written in a DCAT standard."
  [jpmorganchase.github.io/fusion/latest](https://jpmorganchase.github.io/fusion/latest/) ·
  [fusion.jpmorgan.com/solutions/data-catalog](https://fusion.jpmorgan.com/solutions/data-catalog)
- **Frictionless Table Schema** — the per-Distribution column contract.
  [specs.frictionlessdata.io/table-schema](https://specs.frictionlessdata.io/table-schema/)
- **DCAT-US 3.0** — government profile; "license moves from Dataset to Distribution"; obligation levels;
  Dataset Series worked example.
  [resources.data.gov/resources/dcat-us3](https://resources.data.gov/resources/dcat-us3/) ·
  […/dcat-us-3-dataset-series](https://resources.data.gov/resources/dcat-us-3-dataset-series/)
- **DCAT-AP 3.0** — EU profile; "most concrete level of sharing, i.e. Distribution or Data Service"
  for rights; property obligation tables.
  [semiceu.github.io/DCAT-AP/releases/3.0.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/)
- **LinkedPipes ETL** — a real production DCAT distribution with `spdx:checksum` in Turtle.
  [etl.linkedpipes.com/tutorials/csv-to-rdf/add_metadata](https://etl.linkedpipes.com/tutorials/csv-to-rdf/add_metadata)
- **EU frequency NAL discussion** — the `dct:accrualPeriodicity` value vocabulary.
  [interoperable-europe.ec.europa.eu — VO4](https://interoperable-europe.ec.europa.eu/collection/semic-support-centre/solution/dcat-application-profile-data-portals-europe/discussion/vo4-choose-between-dcmi-and-sdmx-frequency-vocabulary)

### In-repo cross-references
- Project theory (ontology section): [`.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  — lines 26, 46, 50, 73, 85–86, 96–98, 103–104, 111, 168.
- Licensing rule (fetch-path / `commercialOk` / contamination): [`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md)
- Scale tiers (R-SCALE): [`product-at-scale.md`](../../../.claude/rules/product-at-scale.md)
- Sibling skills: `data-normalization-tet` (value semantics), `timescaledb-timeseries` (the store the
  rows live in), `python-fastapi-data-service` (the service), `dataquery-delivery-channels` (the API
  that queries this catalog).
- Companion refs in THIS skill: `theory-prov-provenance.md` (PROV lineage depth),
  `theory-licensing-buckets.md` (GREEN/RED verdicts), `patterns-license-resolution.md`,
  `patterns-provenance-stamping.md`.

> **Verification notes (`[unverified — flagged]`).** (1) Several exact DCAT property *definitions* were
> read through the W3C-page fetcher's extraction rather than from a byte-exact copy of the normative
> table; the property **URIs, domains, and the load-bearing claims** (license-on-Distribution,
> DatasetSeries = collection-of-datasets, the v3 deltas) are **cross-confirmed across ≥2 independent
> sources** (W3C spec + DCAT-AP/DCAT-US profiles + the LinkedPipes production example), but re-confirm a
> specific verbatim definition against [w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)
> §6 before quoting it in shipped output. (2) The spec uses `prov:hadRole` and `dcat:hadRole` in
> adjacent text; confirm which on the specific `prov:Attribution`/`dcat:Relationship` node before
> serializing. (3) The MIT paper was unreachable to the fetcher (HTTP 403); its design-principle claims
> here are sourced via the project theory doc, which read it — treat the *exact wording* of its
> abstract as unverified pending direct access.
