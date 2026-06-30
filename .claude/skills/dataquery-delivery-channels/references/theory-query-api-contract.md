# theory · The query-API contract — what the API *is* (two endpoints, an addressing model, a read-from-store boundary)

> **Scope.** This is the **conceptual-design** reference for the `dataquery-delivery-channels` dev-skill
> (the **JPM-Markets re-engineering data-analytics product line — NOT Lumina**). It answers one
> question: *what is the query API, as a whole?* Specifically: (1) why **discovery and retrieval are two
> different jobs** that must be two endpoints, and what breaks when you collapse them; (2) the
> **`dataset → instrument → expression` addressing model** DataQuery uses, and how it maps onto our
> FIGI-anchored security master + DCAT/Fusion catalog; (3) the **three retrieval query patterns**
> (by-expression, by-instrument+attribute, by-group) plus the **grid/pivot** secondary mode, taken
> straight from JPM's own SDK; (4) the **resource-modeling fork** — flat expression list vs nested
> `/datasets/{id}/series/{id}/observations` — and the trade-offs; (5) the **read-from-store-not-upstream
> boundary** that is the spine of the whole design; and (6) **where this skill's surface ends** and the
> sibling skills (`faceted-discovery-search` for the catalog, `timescaledb-timeseries` for the store)
> begin.
>
> **Why this doc is load-bearing and comes first.** Every other reference in this skill — the channel
> adapters (Excel, Batch/SFTP, MCP), the downsampling contract, the pagination shape, the rate-limit
> budget — *assumes a contract*. If the contract is wrong (one mega-endpoint, a text-to-SQL box, a
> fetch-through read path), every channel inherits the wrong shape and the rework is total. This doc
> fixes the contract before any channel code is written. It is the "what is the API" doc; the
> `patterns-*` docs are the "here is exactly how to build each piece" recipes.
>
> **Greenfield.** No codebase `file:line` exists yet. Citations are to (a) primary library source read
> this run (the JPM `dataquery-sdk` README, the macrosynergy `dataquery.py` client), (b) primary API
> docs (FRED, World Bank, Bloomberg BLPAPI), (c) API-design standards (Google AIP-121, RESTful naming),
> and (d) the project's own committed design doc
> [`03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md).
> The code here is the recipe to write, not a description of code that exists.
>
> **Versions / sources pinned this run (2026-06).** JPM `dataquery-sdk` (jpmorganchase/dataquery-sdk,
> read this run) · macrosynergy `dataquery.py` (`macrosynergy/macrosynergy@develop`, read this run) ·
> FRED API docs (`fred.stlouisfed.org/docs/api/fred/`) · World Bank Indicators API v2
> (`api.worldbank.org/v2`) · Google AIP-121 (`google.aip.dev/121`) · Bloomberg BLPAPI Core Developer
> Guide. Re-confirm before pinning anything in code.

---

## 0. The thirty-second contract (read this first)

**The query API is exactly two endpoints, served from our own store, addressed by a stable series id
that the catalog resolves to.**

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │  THE CONTRACT                                                                  │
  │                                                                                │
  │   1. DISCOVERY     GET /v1/catalog?asset=…&region=…&freq=…&q=…&cursor=…        │
  │        (browse)    → ranked, paginated list of {seriesId, label, facets,       │
  │                       provenance} — NO numbers. "Which series exist?"          │
  │                                                                                │
  │   2. RETRIEVAL     GET /v1/series/{id}/observations?from=…&to=…&freq=…         │
  │        (pull)        &agg=…&units=…&asOf=…&maxPoints=…&cursor=…                 │
  │                    → the grounded {t, v}[] for ONE (or a few) known series,     │
  │                       downsampled to ≤ maxPoints. "Give me the numbers."        │
  │                                                                                │
  │   Both read from STORE + REDIS only. Neither EVER fetches an upstream          │
  │   provider on a user request. Both stamp Provenance{commercialOk} per series.  │
  └─────────────────────────────────────────────────────────────────────────────┘
```

**The five rules this doc establishes (each graded in §11):**

1. **Two endpoints, not one.** Discovery (catalog browse/search) and retrieval (pull numbers) are
   different jobs with different caching, ranking, pagination, and rate-limit needs. Never one
   `/query` that does both.
2. **No text-to-SQL on the read path.** The user never supplies SQL or a free-form expression that
   reaches the database. They pick a **stable series id** from the catalog and parameterize a
   **bounded** retrieval. (P2SQL injection is a documented, real attack — §1.4.)
3. **Address by `dataset → instrument → expression`, resolve through the security master.** A series id
   is a stable handle; the catalog maps it to the physical store rows via the FIGI-anchored security
   master. The user never addresses a raw storage table.
4. **Read from store, never fetch-through.** A user request touches only TimescaleDB + Redis. The only
   thing that fetches an upstream is the write-path worker, off the request path. (Committed in
   [`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)
   as the fix for CRITICAL-2.)
5. **The channel layer sits on top of this contract, not beside it.** Excel, Batch/SFTP, the SDK, and
   (later) MCP are all *adapters over these two endpoints*. They reshape the contract; they do not
   re-implement it or open a second path to the store.

---

## 1. Discovery vs retrieval are two different jobs

This is the single most important design decision in the whole API, and it is the one a junior build
gets wrong — by shipping one `/query` endpoint (or one "ask anything" box) that both finds series and
returns their numbers. Every production time-series API that has survived at scale separates the two.
This section proves *why* the split is forced, not stylistic, by walking the four axes on which the two
jobs diverge.

### 1.1 The two jobs, stated precisely

| | **Discovery** (browse the catalog) | **Retrieval** (pull grounded numbers) |
|---|---|---|
| **The user's question** | *"Which series exist that match {asset class, region, frequency, source, keyword}?"* | *"Give me the values of series X over [from, to] at frequency F."* |
| **Input** | facets + free-text query + paging cursor | a **known** series id (or a few) + a time window + reductions |
| **Output** | a **ranked, paginated list of metadata** — labels, facets, provenance. **No data points.** | a **time-ordered array of `{t, v}`** for known series, downsampled. **No catalog metadata beyond a provenance stamp.** |
| **Cardinality** | over the *whole catalog* (130m+ at JPM scale) | over *one* series's history (a few hundred → a few million points) |
| **The hard problem** | **ranking** — at 130m series nobody scrolls a list, they search/facet into a handful, and *which* handful comes back first is the product | **point-volume** — a 20-year daily series is 5k points; intraday is millions; the chart can draw ~800 |

JPM's own DataQuery instantiates exactly this split. The macrosynergy client (the strongest available
primary evidence, since JPM's portal is auth-walled) hard-codes **two different endpoints**
(`macrosynergy/macrosynergy@develop:macrosynergy/download/dataquery.py`, read this run):

```python
# Discovery — "which instruments exist in this group?"
CATALOGUE_ENDPOINT = "/group/instruments"
# Retrieval — "give me the numbers for these expressions"
TIMESERIES_ENDPOINT = "/expressions/time-series"
```

FRED does the same — a `fred/series/search` discovery family and a `fred/series/observations` retrieval
endpoint are entirely separate resources
([fred.stlouisfed.org/docs/api/fred](https://fred.stlouisfed.org/docs/api/fred/), confirmed via search
this run: *"`fred/series/search` … retrieves economic data series that match keywords"* vs
*"`fred/series/observations` … gets the observations or data values for an economic data series"*).
Bloomberg's BLPAPI splits a `ReferenceDataRequest` from a `HistoricalDataRequest` — different request
types, different field limits (400 fields for reference, 25 for historical), different response shapes —
inside one `//blp/refdata` service
([Bloomberg BLPAPI Core Developer Guide](https://data.bloomberglp.com/professional/sites/10/2017/03/BLPAPI-Core-Developer-Guide.pdf)).
**Three independent senior systems converge on the same split.** That convergence is the evidence the
split is correct, not a preference.

### 1.2 Why collapsing them breaks **caching**

The two jobs have *opposite* cache profiles:

- **Discovery responses** are *computed* — a facet filter + ranking over the catalog. They are
  **identical across users** for the same query, change only when the catalog changes (rare — a nightly
  ingest), and are small (metadata, not data). They are the textbook **compute-once-serve-many** read:
  cache the whole ranked page in Redis under the query key, serve it to every user, refresh on ingest.
- **Retrieval responses** are *grounded data slices* — keyed by `(seriesId, from, to, freq, agg, units,
  asOf, maxPoints)`. The cache key is a **wide tuple**; a 1-pixel change in `maxPoints` or a different
  `asOf` vintage is a different cache entry. They change when the *series* updates (also nightly for
  EOD), and warm-window slices (last 1Y/5Y at common widths) are the cacheable hot set.

If you collapse them into one endpoint, you cannot key the cache cleanly. The "find + fetch" response
varies on the union of *both* parameter sets, so the cache key explodes (every facet combination ×
every time window × every width), the hit rate collapses, and you have thrown away the one property
that lets a 4-billion-hits-per-year product survive on cached REST/JSON
([the JPM DataQuery product page reports 4B+ hits/year, 75% API](https://www.jpmorgan.com/markets/dataquery),
WebFetched in
[`03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)).
Two endpoints = two clean, independently-tunable caches (the repo's `getOrRefresh` +
stale-while-revalidate + in-flight de-dupe on each). One endpoint = one un-cacheable mess.

### 1.3 Why collapsing them breaks **ranking and rate-limiting**

- **Ranking** only makes sense on discovery. A retrieval ("series X, 2010–2024") has a *deterministic*
  answer — there is nothing to rank. A discovery ("USD credit spreads, daily") has *thousands* of
  candidate series and the order they come back in **is the product** (the R-SCALE rule: matching **and**
  ranking; you can't rank by signals — instrument CTR, click-through — you never stored, so you
  instrument from day one). Fold retrieval into the same endpoint and the ranking logic has to special-
  case "did the user actually want a list or a number?" on every call — a branch that should never exist.
- **Rate-limiting** must be *different* for the two. Discovery calls are cheap (an indexed metadata
  query) and bursty (a user types in a search box — debounced, but still many small calls). Retrieval
  calls are expensive (a downsample over a continuous-aggregate scan, possibly a large window) and should
  be metered harder and possibly billed differently (a bulk pull is a different cost class than a
  type-ahead). One endpoint forces one rate budget across two cost classes — you either throttle search
  too hard or let expensive pulls through too freely.

### 1.4 Why collapsing them invites **text-to-SQL injection** (the security argument)

The tempting "collapse" is an **LLM "ask anything about the data" box** that turns a natural-language
question into SQL (or into a free-form expression that reaches the query planner). This is the
**prompt-to-SQL (P2SQL) injection** attack, and it is a documented, peer-reviewed risk — not a
hypothetical:

- *"LLM-integrated applications are at risk of SQL injections generated from prompt injections,
  compromising database integrity and confidentiality"* — Pedro et al., **"From Prompt Injections to SQL
  Injection Attacks: How Protected is Your LLM-Integrated Web Application?"**
  ([arXiv:2308.01990](https://arxiv.org/abs/2308.01990) /
  [ICSE'25 paper PDF](https://syssec.dpss.inesc-id.pt/papers/pedro_icse25.pdf)).
- *"Current LLMs simply do not enforce a security boundary between instructions and data inside a
  prompt"* — the same line of work; a grammatically-clean prompt with hidden instructions bypasses
  basic intent checks ([TDS write-up](https://medium.com/data-science/text-to-sql-llm-applications-prompt-injections-ebee495d0c16)).
- The UK NCSC's framing is blunter: **"Prompt injection is not SQL injection (it may be worse)"** —
  because you cannot fully parameterize away an attack that lives in natural language
  ([ncsc.gov.uk](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection)).

Even JPM's DataQuery — which *does* have an "expression" string — does **not** let the user type SQL.
The expression is a **bounded, parseable mini-language** (`DB(group, instrument, …, metric)`) with a
fixed grammar that resolves to known series, **not** arbitrary SQL against the warehouse (§2). And the
expression is **constructed by the client from catalog metadata**, not free-typed by an end user against
a planner.

**The contract's answer:** the read path takes **structured parameters against a stable series id**, never
SQL, never a free expression that reaches the planner. A natural-language layer, if we ship one, runs in
the *agent/MCP channel* and is constrained to **emit the same structured retrieval parameters** the REST
endpoint takes — it never reaches the database directly. (This is the same discipline the project's
`data-analytics-tab-research` memory already committed: *"NOT freeform text-to-SQL"* — a pgvector catalog
+ an AI-SDK tool loop that calls the *bounded* tools, not a SQL box.) The boundary is: **NL → structured
params → the two endpoints → store.** Never **NL → SQL → store.**

---

## 2. The DataQuery addressing model: `dataset → instrument → expression`

### 2.1 What JPM actually does (verbatim)

A DataQuery client addresses a single number as an **expression**. The canonical example, confirmed at
source this run in the macrosynergy client and JPM's product copy:

```
DB(JPMAQS, USD_EQXR_VT10, value)
   │        │              └── metric / attribute   ("value", "eop_lag", "grade", …)
   │        └── instrument / ticker  (cross-section + category: USD + EQXR_VT10)
   └── group / dataset                (JPMAQS = JPMorgan Quantamental System)
```

The full JPMaQS ticker grammar is `DB(JPMAQS, <cross_section>_<category>, <info>)`, where `info ∈
{value, eop_lag, mop_lag, grade, …}` ([docs.macrosynergy.com — `macrosynergy.download.jpmaqs`](https://docs.macrosynergy.com/stable/macrosynergy.download.jpmaqs.html);
[jpmorgan.com/markets/jpmaqs](https://www.jpmorgan.com/markets/jpmaqs)). A second example from JPM's own
SDK shows the same grammar over a *different* group (market-traded-entity bonds), with positional/empty
slots and an ISIN inside the instrument coordinate:

```
DB(MTE, IRISH EUR 1.100 15-May-2029 LON, , IE00BH3SQ895, MIDPRC)
   │     │                                  │             └── metric (mid price)
   │     │                                  └── ISIN coordinate
   │     └── instrument (the bond, by description)
   └── group (MTE = market-traded entity)
```

(verbatim example string from the **jpmorganchase/dataquery-sdk** README, read this run). The structure
is invariant across groups: **`DB(GROUP, INSTRUMENT[, …coordinates], METRIC)`**.

The three-level hierarchy — **group (dataset) → instrument (ticker) → expression (metric on an
instrument)** — is the addressing spine. Discovery answers *"which instruments are in this group?"*
(`CATALOGUE_ENDPOINT = "/group/instruments"`); retrieval answers *"give me this metric on this instrument
over this window"* (`TIMESERIES_ENDPOINT = "/expressions/time-series"`)
(`macrosynergy/macrosynergy@develop:macrosynergy/download/dataquery.py`).

### 2.2 How it maps onto OUR model

We are not cloning JPM's string grammar; we are cloning its **shape** and mapping it onto our committed
catalog + security master. The 1:1 correspondence:

| JPM DataQuery | Our model | Owned by |
|---|---|---|
| **Group / dataset** (`JPMAQS`, `MTE`) | **Dataset** in the DCAT v3 catalog (a `dcat:Dataset` under a Data Product; the Fusion 5-level ontology's middle tier) | `data-provenance-licensing` skill |
| **Instrument / ticker** (`USD_EQXR_VT10`, a bond) | a **security** in the FIGI-anchored **security master** (canonical internal id, bitemporal crosswalk to provider symbols + ISIN/LEI/DTI) | `security-master-symbology` skill |
| **Metric / attribute** (`value`, `MIDPRC`) | a **measure** column on the series (`value`, `open/high/low/close`, `eop_lag`, …) in the TimescaleDB store | `timescaledb-timeseries` skill |
| **Expression** `DB(g,i,m)` | a resolved **`seriesId`** (stable opaque handle) the catalog hands out; the user never assembles it from coordinates by hand | THIS skill's contract |

**Our key divergence from JPM (deliberate):** we do **not** expose a free-typed expression string as the
primary handle. JPM's expression is constructed by the SDK from catalog metadata; an end user does not
free-type `DB(...)` against the planner. We make that explicit by handing the client a **stable
`seriesId`** from the catalog (discovery) and accepting *that id* on retrieval. The id is the resolved
`(dataset, instrument, metric)` triple, canonicalized through the security master. This:

- **kills the symbology ambiguity** — `USD_EQXR_VT10` from provider A and the same instrument under a
  different symbol from provider B resolve to **one** `seriesId` because the security master joins them
  (the moat: *"ingest the same instrument from two providers under different symbols and return one
  joined series"* — [`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)
  Phase-1 exit test);
- **decouples the wire handle from the physical storage** — the `seriesId` is stable even if we re-shard
  the store, change providers, or rename a measure;
- **closes the injection surface** — there is no free-text coordinate string for a user to smuggle a
  planner instruction through; the id is validated against the catalog before any store query.

We *can* still offer an expression-style convenience (a `DB(...)`-like string or a `{dataset, instrument,
metric}` object) in the SDK/Excel channel for power users, but it is **parsed and resolved to a
`seriesId` first** — the resolver is the gate, exactly as JPM's SDK resolves an expression to a catalog
hit before hitting `/expressions/time-series`.

### 2.3 The security master is the addressing engine (why it's built first)

The reason the security master is Phase 1 — *before* any multi-provider dataset ships
([`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md))
— is that **it is what makes the addressing model work**. Without it, `dataset → instrument` is a
free-text join across clashing provider symbologies (the fragmentation pain the whole product exists to
kill). With it, `instrument` is a canonical FIGI-anchored node and the crosswalk resolves any provider's
symbol, any ISIN, any LEI to the one canonical security. The catalog stores the *mapping* `seriesId →
(datasetId, canonicalSecurityId, measure)`; the security master stores `canonicalSecurityId →
{provider symbols, ISIN, LEI, DTI}` bitemporally. Retrieval is then a pure store read against the
resolved coordinates — no upstream symbology lookup, no fetch-through.

---

## 3. The three retrieval query patterns (+ grid/pivot), from JPM's own SDK

JPM's `dataquery-sdk` exposes **three** ways to retrieve a time series, plus a **grid (pivot)** mode.
These are not arbitrary — they are the three natural "shapes" of a request against a `dataset →
instrument → expression` model, and our retrieval endpoint should support the same three *intents* (even
if collapsed behind one URL with a discriminated request body). Verbatim method names from the
**jpmorganchase/dataquery-sdk** README (JSON Data API), read this run:

```python
# Pattern 1 — by EXPRESSION (fully-specified handles)
get_expressions_time_series_async(expressions, start_date, end_date)
#   "I already know the exact series handles I want."

# Pattern 2 — by INSTRUMENT + ATTRIBUTE (a security, a set of metrics)
get_instrument_time_series_async(instruments, attributes, start_date, end_date)
#   "Give me {bid, ask, mid} for THIS instrument."  (the cross-product instruments × attributes)

# Pattern 3 — by GROUP + ATTRIBUTE + FILTER (a whole dataset slice)
get_group_time_series_async(group_id, attributes, filter, start_date, end_date)
#   "Give me {value} for ALL instruments in this group matching this filter."

# Secondary mode — GRID (pivoted) data
get_grid_data_async(expr=None, grid_id=None, date=None)
#   "Give me a pre-pivoted 2-D grid (a snapshot table), not a long time series."
```

### 3.1 What each pattern is *for*

| Pattern | The intent | Cardinality | Our endpoint shape |
|---|---|---|---|
| **By expression** | The client resolved the handles already (from discovery or a saved query). The simplest, most-cacheable call. | 1..N known series | `GET /v1/series/{id}/observations` (single) or `GET /v1/series/observations?ids=a,b,c` (batch) |
| **By instrument + attribute** | "This security, these metrics" — the cross-product `instruments × attributes`. Common in finance (OHLC = one instrument, four attributes). | instruments × attributes | a retrieval request keyed by `{securityId, measures[]}` that the resolver expands to N `seriesId`s |
| **By group + filter** | "This whole dataset, optionally filtered" — a bulk slice. **This is the dangerous one** (it can fan out to thousands of series). | up to a whole dataset | route to the **bulk/Parquet path**, off the synchronous request, not a per-point JSON stream |
| **Grid / pivot** | A snapshot **table** (rows × columns at a date), not a long series — e.g. "all currencies × all tenors, as of today." | a 2-D matrix | a secondary `GET /v1/grid/{id}?asOf=…` returning a pivoted shape (§7) |

### 3.2 The contract decision: collapse to one expressive endpoint, keep three *intents*

JPM exposes three SDK methods; we do **not** need three URLs. The cleaner contract (and the one our
channel adapters consume) is **one retrieval endpoint** whose request expresses the three intents via the
coordinate set supplied:

- give a `seriesId` (or a list) → **by-expression**;
- give a `securityId` + `measures[]` → **by-instrument+attribute** (resolver expands to series);
- give a `datasetId` + `filter` → **by-group** (and the gateway *forces* this onto the bulk path if the
  fan-out exceeds a threshold — never a synchronous mega-pull).

This mirrors how OpenBB's router resolves any of these to a single standardized `Fetcher[Q,R]` and returns
a uniform model regardless of the input shape
([openbb.co architecture](https://openbb.co/blog/exploring-the-architecture-behind-the-openbb-platform/),
read this run: *"Identify the provider… Send a request… Return the data inside a well-defined model"*).
The three intents are *input ergonomics*; the **output is one uniform series envelope**. That keeps the
channel adapters simple — every channel speaks "give me observations for these coordinates," and the
gateway figures out which intent it is.

> **The bulk guard (load-bearing).** Pattern 3 (by-group) is where a junior build dies: a single
> `GET /v1/series/observations?datasetId=BIG` fans out to 50,000 series and tries to stream them as JSON.
> **The contract forbids this on the synchronous path.** Any request whose resolved fan-out exceeds a
> threshold (or whose total point estimate exceeds a budget) is **rejected with a pointer to the bulk
> Parquet endpoint** — exactly the discipline JPM's own File-Delivery surface uses (CSV/Parquet bulk +
> SSE notification for async batch, off the request path —
> [`03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)).
> Bulk export lives in the `patterns-batch-sftp-channel.md` recipe, not here.

---

## 4. Resource modeling: nested `/datasets/{id}/series/{id}/observations` vs the flat expression list

This is the genuine API-design fork, and it deserves a derived answer, not a reflex. Two shapes:

### 4.1 Shape A — the **nested resource hierarchy** (REST-orthodox)

```
GET /v1/datasets                                    → list datasets (discovery, top level)
GET /v1/datasets/{datasetId}                        → one dataset's metadata
GET /v1/datasets/{datasetId}/series                 → list series IN a dataset (discovery, scoped)
GET /v1/series/{seriesId}                            → one series's metadata
GET /v1/series/{seriesId}/observations?from=…&to=…  → the numbers (retrieval)
```

This is textbook resource-oriented design. Google AIP-121 (the canonical resource-modeling standard,
read this run): APIs *"should be modeled as resource hierarchies where each node is either a simple
resource or a collection of same-type resources,"* with the rule that *"a resource **must** support at
minimum Get"* and *"**must** also support List, except for singleton resources"*
([google.aip.dev/121](https://google.aip.dev/121)). The hierarchy *"**must** be representable via a
directed acyclic graph."* RESTful naming convention agrees: pluralize collections, use the path for
containment (`/customers/123/orders`), but **"one level of nesting is normal; two levels is a smell;
three levels is almost always wrong"**
([restfulapi.net/resource-naming](https://restfulapi.net/resource-naming/);
[DreamFactory naming guide](https://blog.dreamfactory.com/best-practices-for-naming-rest-api-endpoints)).
World Bank's Indicators API is exactly this nested shape:
`api.worldbank.org/v2/country/{iso};{iso}/indicator/{id};{id}?date=2000:2010&format=json`
([API Basic Call Structures](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures);
[Indicator API Queries](https://datahelpdesk.worldbank.org/knowledgebase/articles/898599-indicator-api-queries)).

**Pros:** self-documenting URLs; clean separation of discovery (`List` on a collection) from retrieval
(`Get`/observations on a leaf); cache keys fall out of the path naturally; an SDK and an OpenAPI spec
generate cleanly; each level has obvious standard methods.

**Cons:** to retrieve, you need the `{seriesId}` first — which means a discovery round-trip (fine, that
*is* the model). Cross-dataset batch retrieval doesn't fit a single nested path cleanly (you need a
flat batch endpoint alongside it).

### 4.2 Shape B — the **flat expression list** (DataQuery / FRED style)

```
GET /v1/series/observations?ids=FIGI…:value,FIGI…:close&from=…&to=…   (or POST a list)
```

One endpoint, a flat list of fully-specified handles, no hierarchy in the URL. This is what JPM does
(`/expressions/time-series` takes a list of expression strings, **max 20 per request** — confirmed:
`batch_size: int = 20` in `dataquery.py`) and what FRED does
(`fred/series/observations?series_id=GNPCA` — one id, flat).

**Pros:** trivial batch retrieval (just a longer list); no need to model containment in the URL;
matches the incumbent's wire shape (lower migration friction for a DataQuery user); the handle *is* the
fully-resolved coordinate, so the server does no path parsing.

**Cons:** the URL is opaque (not self-documenting); discovery has to live in a *separate* endpoint
family anyway (DataQuery has `/group/instruments` for exactly this); no natural `List` semantics; harder
to cache by path (you cache by the query-string tuple instead).

### 4.3 The derived decision: **nested for discovery, flat-batch for retrieval — both, with one canonical leaf**

Neither shape is wholly right; the standards and the incumbents actually use **both**, for different
jobs. The committed contract:

- **Discovery is nested** — `GET /v1/catalog` (or `GET /v1/datasets`, `GET /v1/datasets/{id}/series`)
  with facets + cursor. This is where the resource hierarchy earns its keep: browse a dataset, list its
  series, drill in. (Owned by `faceted-discovery-search`; this doc only fixes the URL shape.)
- **Retrieval has one canonical nested leaf** `GET /v1/series/{seriesId}/observations` for the common
  single-series case (cleanest cache key, self-documenting, AIP-121-clean), **plus** a flat batch
  sibling `GET /v1/series/observations?ids=a,b,c` (cap the list, e.g. 20–50 like JPM's 20) for the
  multi-series case that the nested path can't express. Both return the **same envelope**.
- **Both leaves resolve `seriesId` through the catalog/security master** before touching the store.

This is the same dual that Google's own services ship (a `Get` on `/v1/.../{id}` plus a `BatchGet` /
list-with-filter sibling) and that FRED ships (per-series `observations` + the search family). We adopt
the orthodox nested hierarchy as the *primary*, and add the flat batch as the *named exception* for
batch — not a free-for-all flat list as the only shape. The reason flat-only is wrong for us: it throws
away the path-derived cache key and the self-documenting discovery hierarchy that a 130m-series catalog
*needs* to be navigable.

### 4.4 Why not custom-verb RPCs (`/getTimeSeries`, `/queryData`)

A junior instinct is to ship verbs: `POST /getTimeSeries`, `POST /searchCatalog`. AIP-121 is explicit:
*"Custom methods are available in situations where the standard methods do not fit"* — i.e. the
**exception**, not the default ([google.aip.dev/121](https://google.aip.dev/121)). RESTful naming: *"Use
nouns, not verbs: `POST /orders`, not `/createOrder`. HTTP methods carry the verb"*
([DreamFactory guide](https://blog.dreamfactory.com/best-practices-for-naming-rest-api-endpoints)).
Our two jobs map cleanly onto standard methods (`List` a collection = discovery; `Get`
observations on a leaf = retrieval), so there is **no custom verb**. The one place a POST is justified is
the **batch retrieval body** when the id list is too long for a query string — a standard `BatchGet`
shape, still a noun (`/series/observations` with a body), not a verb.

---

## 5. The read-from-store-not-upstream boundary

This is the spine of the entire data plane, restated here because the *query API is where it is
enforced or violated*.

### 5.1 The rule

> **A user request — discovery OR retrieval — reads only from our store (TimescaleDB) + Redis. It NEVER
> fetches an upstream provider. The only thing that fetches an upstream is the write-path worker, off the
> request path, on a cron.**

This is a committed non-negotiable, the fix for negation finding **CRITICAL-2**
([`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md):
*"The read path never touches an upstream provider. It reads store + Redis only."*). It mirrors Lumina's
own discipline (the finance cards are cron-warmed into Redis; a user request serves the warm copy) and
the repo's standing rule that pollers/timers/fetch loops live in `worker/`, not the serverless request
path.

### 5.2 Why it is non-negotiable (the four reasons)

1. **Latency & determinism.** A store+Redis read is single-digit-to-low-tens of milliseconds and
   bounded. An upstream fetch is hundreds of ms to seconds, varies by provider, and can hang. A query
   API whose latency is a hostage to EDGAR/World-Bank/BLS response times is not a product.
2. **Availability.** The exit test for the write path is literally *"a series exists in the store and is
   served with all providers disconnected"*
   ([`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)
   Phase-2 exit test). If reads fetched through, an upstream outage = our outage. Reading from store
   means upstream-down degrades to *stale-but-served*, never *down*.
3. **Rate limits & fair-access.** EDGAR caps at ≤10 req/s with a required User-Agent; World Bank, FRED,
   BLS all have quotas. If every user read hit upstream, a traffic spike would blow the upstream quota
   and get us banned. The write-path worker fetches at a controlled, batched rate (the same self-throttle
   JPM's own clients use: `API_DELAY_PARAM = 0.25`, `batch_size = 20` in `dataquery.py`); user reads never
   touch the quota.
4. **Licensing & grounding.** `commercialOk` is bound to the **fetch path**. The write path is where the
   fetch happens, so it is where provenance is stamped. A read that fetched-through would have to re-derive
   licensing on every request — and a failed fetch on the read path is exactly the moment a junior build
   "backfills to look complete," fabricating a number. Reading from store means the number was already
   fetched, grounded, and stamped once; the read just serves it.

### 5.3 What this means for the contract concretely

- The retrieval endpoint's *only* data source is `SELECT … FROM <hypertable / continuous_aggregate>`
  wrapped by Redis `getOrRefresh`. There is **no `fetch()` to a provider anywhere in the gateway**.
- A series the user asks for that **isn't in the store** returns a typed `unavailable` /
  `not_in_catalog` — **never** a synchronous "let me go fetch it for you." (If we want fetch-on-demand
  for a missing series, that enqueues a *write-path job* and returns `pending`; the read still doesn't
  fetch.)
- "Freshness" is a write-path SLA (how often the cron runs), not a read-path behavior. The read serves
  whatever the store last has, with an `asOf` / staleness stamp so the consumer sees the vintage.

### 5.4 The one allowed seam: gateway → data-plane (internal HTTP), still store-only

The gateway (TS/Express on Vercel) does call the Python data plane over internal HTTP. That is **not**
an upstream fetch — the data plane reads the same store. The boundary is: gateway → (internal HTTP) →
data plane → store. Both hops are "read from store." Neither hop fetches a *provider*. (Topology in
[`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)
architecture diagram.)

---

## 6. The uniform response envelope (what every retrieval returns)

Both the nested leaf and the flat batch return the **same** envelope, so every channel adapter parses one
shape. The envelope is the contract's output half.

```jsonc
// GET /v1/series/USD_GG10Y:value/observations?from=2010-01-01&to=2024-12-31&freq=monthly&maxPoints=800
{
  "series": [
    {
      "seriesId": "USD_GG10Y:value",
      "label": "US 10Y government bond yield",
      "dataset": "RATES_GOV",
      "measure": "value",
      "unit": "percent",
      "frequency": "monthly",          // the frequency actually served (post-aggregation)
      "asOf": "2026-06-23",            // vintage / last write-path refresh
      "downsampled": true,             // was LTTB / bucket reduction applied?
      "pointCount": 180,
      "observations": [                // time-ordered, ≤ maxPoints
        { "t": "2010-01-31", "v": 3.73 },
        { "t": "2010-02-28", "v": 3.61 }
        // …
      ],
      "provenance": {                  // MANDATORY, per series — never omitted
        "source": "US Treasury FiscalData",
        "commercialOk": true,          // default false; true only for a GREEN fetch path w/ attribution
        "attribution": "Source: U.S. Department of the Treasury, Fiscal Data",
        "license": "public-domain"
      }
    }
  ],
  "meta": {
    "cursor": null,                    // pagination for the raw/table path (§8)
    "requestedMaxPoints": 800,
    "warnings": []                     // e.g. ["frequency coerced monthly→quarterly: native is monthly"]
  }
}
```

**The non-negotiable in the envelope:** `provenance.commercialOk` is present on **every** series, defaults
`false`, and is `true` only for a GREEN fetch path with `attribution` rendered. This is the repo's
`commercial-ok-gate` discipline, reused verbatim
([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)). A channel that drops the provenance
footer is shipping an un-licensed number — an F2 finding under the negation loop. (Lumina already has the
exact `Provenance{source, commercialOk, attribution}` shape and a `ProvenanceLine` renderer; the channels
reuse it as a pattern source.)

**Why a uniform envelope matters for the channel layer (§9):** the Excel add-in flattens
`observations[]` into rows; the Batch/SFTP channel serializes the same series to CSV/Parquet; the SDK
maps it to a DataFrame; the MCP channel returns it as a tool result. **One envelope, five renderings.**
If retrieval returned a different shape per intent (§3), every channel would need three parsers.

---

## 7. The grid/pivot response shape (the secondary retrieval mode)

JPM's `get_grid_data_async(expr, grid_id, date)` returns a **pivoted 2-D snapshot table**, not a long
time series. This is a distinct, legitimate retrieval *mode* — and our contract supports it as a
**secondary** endpoint, not a special case of the time-series leaf.

### 7.1 When you want a grid

A time series is *long* (one series, many timestamps). A grid is *wide* (many series, one — or few —
timestamps, arranged as a matrix). Examples a quant actually asks for:

- a **yield-curve snapshot**: rows = currencies, columns = tenors (2Y/5Y/10Y/30Y), cells = yield as of
  today;
- a **cross-asset board**: rows = instruments, columns = metrics (last, chg, %chg), as of close;
- a **correlation/return matrix** at a date.

Forcing these through the long time-series endpoint and pivoting client-side is wasteful (you'd pull N
series × their histories to display one column of "today"). The grid mode pulls the *latest* (or
`asOf`-dated) value for a *set* of series and returns them already pivoted.

### 7.2 The shape

```jsonc
// GET /v1/grid/yield-curve?asOf=2026-06-23&rows=currency&cols=tenor
{
  "gridId": "yield-curve",
  "asOf": "2026-06-23",
  "rowKey": "currency",
  "colKey": "tenor",
  "columns": ["2Y", "5Y", "10Y", "30Y"],
  "rows": [
    { "currency": "USD", "cells": { "2Y": 4.31, "5Y": 4.05, "10Y": 4.18, "30Y": 4.42 } },
    { "currency": "EUR", "cells": { "2Y": 2.10, "5Y": 2.28, "10Y": 2.55, "30Y": 2.81 } }
  ],
  "provenance": [ /* per-source provenance for the cells, same commercialOk gate */ ]
}
```

### 7.3 The contract rules for grids

- A grid is **a snapshot, not a chart** — it returns scalar cells at `asOf`, not `{t,v}[]`. (If a cell
  needs a sparkline, that's a *separate* tiny time-series retrieval per cell, lazily.)
- A grid is **derived from the same store** — it is a `SELECT DISTINCT ON (seriesId) … ORDER BY t DESC`
  (latest per series) or an `asOf`-filtered query, served from the store, cached in Redis like any read.
- A grid's cell count is **bounded** (rows × cols), so it doesn't hit the point-volume problem — but the
  *number of distinct series* it touches is bounded too (it's a fan-out, so the same bulk-guard as §3
  applies: a 5,000-series grid goes to the bulk path).
- Grids are **secondary** — ship the two core endpoints first; add `/v1/grid/{id}` when a dashboard needs
  a board/matrix. It is named here so the contract is complete, not so it's built day one.

---

## 8. Pagination, frequency, and the bounded-retrieval parameters (the contract's params)

The retrieval endpoint's parameter set is copied from the **universal contract** that FRED, JPM, and
World Bank all converge on — `series id(s) + range + frequency + aggregation + units + asOf + paging`.
This doc fixes *which* params exist and what they mean; the *implementation* of downsampling lives in
`patterns-downsampling-and-pagination.md` and the SQL lives in the `timescaledb-timeseries` skill.

### 8.1 The canonical parameter set (cross-verified across three APIs)

| Param | Meaning | FRED analogue | JPM analogue | World Bank analogue |
|---|---|---|---|---|
| `id` / `ids` | the series handle(s) | `series_id` | `expressions[]` (max 20) | `indicator` (in path) |
| `from` / `to` | the time window | `observation_start` / `observation_end` | `start_date` / `end_date` | `date=YYYY:YYYY` |
| `freq` | requested frequency | `frequency` (`d/w/m/q/sa/a`) | `frequency` (`FREQ_DAY`, …) | `frequency=Y/Q/M` |
| `agg` | aggregation when down-sampling frequency | `aggregation_method` (`avg/sum/eop`) | `conversion` (`CONV_LASTBUS_ABS`, …) | — |
| `units` | value transform | `units` (`lin/chg/pch/…`) | — | — |
| `asOf` | point-in-time vintage | `vintage_dates` / `realtime_*` | — | `mrv` (most-recent-values) |
| `maxPoints` | chart-driven point cap (§ downsampling) | — (FRED has no native cap) | — | — |
| `cursor` / `limit`+`offset` | pagination of the raw/table path | `limit` (max 100000) + `offset` | `links[1].next` cursor | `page` / `per_page` |

The two FRED rules worth internalizing (they constrain *our* contract):

1. **Frequency only aggregates DOWNWARD.** FRED's `frequency` parameter *"is used to aggregate values to
   a lower frequency"* — you can roll daily → monthly, never monthly → daily (you can't invent
   sub-period data). Our `freq` param obeys the same one-way rule; a request below native resolution
   returns a `warning` and serves native (FRED docs;
   [fredr CRAN vignette](https://cran.r-project.org/web/packages/fredr/vignettes/fredr-series.html)).
2. **`aggregation_method` picks the reducer** — `avg` (default) / `sum` / `eop` (end-of-period). This is
   *frequency* aggregation (daily→monthly), **distinct** from *chart downsampling* (LTTB), and our
   contract keeps the two separate params (`agg` vs `maxPoints`). (FRED `series/observations` docs.)

### 8.2 Pagination: cursor for the table path, never for the chart path

- The **chart path** is *not* paginated — it is **downsampled** to `maxPoints`. You never page a chart;
  you reduce it. (The whole point of `maxPoints` is to fit the visible window in one response.)
- The **raw / table path** (a user wants every observation, e.g. to export or to scroll a data grid) **is**
  paginated, by **cursor** (opaque, keyset-based on `t`), not offset. Offset pagination over a 5M-row
  series re-scans on every page; keyset/cursor (`WHERE t > :lastT ORDER BY t LIMIT n`) is O(page). This
  matches JPM's own `links[1].next` cursor recursion in `dataquery.py` and the repo's R-SCALE rule
  (server-side paginate; index the sorted column — here `t` is the hypertable's time index, free).
- **Default `maxPoints` is gateway-enforced.** A direct HTTP call that omits `maxPoints` must not pull an
  unbounded series. The gateway defaults it (≈800, the Grafana HTTP-API default —
  [grafana.com query-transform-data](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/),
  confirmed in
  [`03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)).
  The dashboard sends its real pixel width; an SDK/Excel/Batch caller gets the safe default.

---

## 9. The channel layer sits ON TOP of this contract

This is the architectural claim that makes this skill *the channel skill*: **every delivery channel is an
adapter over the two-endpoint contract.** JPM ships four channels (Web, API, Batch/SFTP+email, Excel —
[jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery)); we add MCP later. None of
them is a second path to the store. All of them reshape the *same two endpoints*.

```
            ┌──────────┬──────────┬──────────┬──────────┬──────────┐
  CHANNELS  │  Web/SPA │  REST/SDK│  Excel   │ Batch/SFTP│   MCP    │   ← adapters (this skill)
            │ dashboard│  (JSON)  │  add-in  │  +email   │ (agent)  │
            └────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┘
                 │ all speak the SAME two-endpoint contract + the SAME envelope
                 ▼          ▼          ▼          ▼          ▼
            ┌─────────────────────────────────────────────────────┐
  CONTRACT  │  GET /v1/catalog…   (discovery)                       │   ← THIS doc
            │  GET /v1/series/{id}/observations…   (retrieval)      │
            │  + /v1/grid/{id}   (pivot, secondary)                 │
            │  uniform envelope · Provenance{commercialOk} per series│
            └───────────────────────┬─────────────────────────────┘
                                    │ read from store + Redis ONLY (§5)
            ┌───────────────────────▼─────────────────────────────┐
  DATA PLANE│  catalog · security master · TimescaleDB · Parquet/R2 │   ← sibling skills
            └───────────────────────▲─────────────────────────────┘
                                    │ writes only, off the request path
  WRITE PATH│  TET worker: fetch GREEN → normalize → persist → stamp │
            └───────────────────────────────────────────────────────┘
```

### 9.1 What each channel adapter does (and does NOT do)

| Channel | Reshapes the contract into… | Does NOT |
|---|---|---|
| **Web / SPA dashboard** | the catalog browser (discovery) + `IndexChart` (retrieval with `maxPoints` = panel px) + result table (cursor-paged) | re-implement filtering/ranking/downsampling — those are in the contract |
| **REST / Python SDK** | the raw JSON contract + a `to_dataframe()` convenience (the JPM SDK shape) | open a second endpoint; the SDK is a thin client over the two URLs |
| **Excel add-in** | a worksheet function (`=DQ.SERIES("USD_GG10Y:value","2010","2024")`) → rows | fetch upstream; it calls `/series/{id}/observations` like everyone else |
| **Batch / SFTP + email** | a scheduled bulk pull → Parquet/CSV file dropped on SFTP / emailed | stream point-by-point; bulk goes to the Parquet/R2 path (§3 bulk guard) |
| **MCP (agent)** | the two endpoints as **tools** (`search_catalog`, `get_observations`), cached read-cards as **resources** | bypass auth/provenance; the agent channel *inherits* `commercialOk`, adds approval/audit on top |

The load-bearing rule (from the sibling
[`distribution-mcp-channel/01-plan.md`](../../../../.agents/jpm-markets-reengineering/distribution-mcp-channel/01-plan.md)):
**"Core owns ALL business logic… No adapter re-implements logic, auth decisions, or provenance. Each BFF
only *reshapes* the core for its surface."** The two-endpoint contract IS that core for the data product.
A channel that re-implements ranking, or downsampling, or its own store query, has violated the boundary
and will drift out of sync with the others.

### 9.2 Where this skill's surface ENDS

This skill owns the **contract and the channels**. It explicitly does **not** own:

- **the faceted discovery internals** — how `/v1/catalog` filters, indexes, ranks, autocompletes, and
  scores. That is the **`faceted-discovery-search`** skill. This doc fixes only the *URL shape* and the
  *discovery-vs-retrieval split*; the matching+ranking machinery is next door.
- **the time-series store** — hypertables, continuous aggregates, the LTTB/`time_bucket` SQL,
  compression, the connection layer. That is the **`timescaledb-timeseries`** skill. This doc fixes only
  *that `maxPoints`/`freq`/`agg` exist and what they mean*; the SQL that honors them is next door.
- **the security master** — FIGI anchoring, the bitemporal crosswalk, OpenFIGI mapping. That is the
  **`security-master-symbology`** skill. This doc fixes only *that a `seriesId` resolves through it*.
- **the catalog/provenance ontology** — DCAT v3, Fusion 5-level, PROV-O, the `commercialOk` ledger. That
  is the **`data-provenance-licensing`** skill. This doc fixes only *that the envelope carries
  `Provenance{commercialOk}`*.
- **the write path** — the TET fetcher, normalization, persistence. That is `openbb-tet-normalization` +
  `data-pipeline-worker-cron`. This doc fixes only *that the read path never does what the write path
  does*.

The seam: **this skill defines the contract and adapts it to channels; the sibling skills implement the
machinery behind the two endpoints.** If a task is "how does ranking work," route to
`faceted-discovery-search`. If it's "what shape does the API expose, and how does Excel/Batch/MCP consume
it," it's here.

---

## 10. Worked end-to-end: one user, two endpoints, three channels

To make the contract concrete, trace a single intent ("chart the US 10Y yield, 2010–2024, monthly")
through the contract from three different channels. **Same two endpoints every time.**

### 10.1 From the Web dashboard

```
1. User types "10 year treasury" into the catalog search box (debounced ~250ms).
   → GET /v1/catalog?q=10%20year%20treasury&asset=rates&region=us&cursor=null
   → ranked list; top hit: { seriesId: "USD_GG10Y:value", label: "US 10Y government bond yield", … }
   (DISCOVERY — store+Redis, ranked, paginated. No numbers yet.)

2. User clicks it. The IndexChart measures its panel: 740px wide.
   → GET /v1/series/USD_GG10Y:value/observations?from=2010-01-01&to=2024-12-31&freq=monthly&maxPoints=740
   → envelope with ≤740 observations (LTTB-reduced), provenance{commercialOk:true, attribution:"…Treasury…"}
   (RETRIEVAL — store+Redis, downsampled. ProvenanceLine footer rendered.)
```

### 10.2 From the Python SDK

```python
import dataquery
c = dataquery.Client(api_key=...)                  # thin client over the two URLs

# DISCOVERY
hits = c.search_catalog(q="10 year treasury", asset="rates", region="us")
sid = hits[0].series_id                             # "USD_GG10Y:value"

# RETRIEVAL — same endpoint the dashboard hit, default maxPoints (gateway-enforced ~800)
df = c.get_observations(sid, start="2010-01-01", end="2024-12-31", freq="monthly").to_dataframe()
#   to_dataframe() is the only SDK-specific bit (the JPM SDK shape: response → pandas).
#   df.attrs["provenance"]["commercialOk"] is preserved — the gate rides through the SDK.
```

### 10.3 From Excel

```
=DQ.SEARCH("10 year treasury", "rates", "us")        → spills the catalog hits (DISCOVERY)
=DQ.SERIES("USD_GG10Y:value", "2010-01-01", "2024-12-31", "monthly")
                                                     → spills t,v rows (RETRIEVAL, default maxPoints)
```

The Excel add-in calls the *identical* `/v1/series/{id}/observations` endpoint. It never fetches
upstream, never queries the store directly, never re-implements downsampling — it reshapes the envelope
into a worksheet range. **One contract, three renderings, zero logic duplication.** That is the whole
point of fixing the contract before building any channel.

---

## 11. Output Contract — the grading rubric for this skill

A query-API or channel design produced under this skill is **done** only when:

1. **Two endpoints, named.** Discovery (`/v1/catalog` or `/v1/datasets…`) and retrieval
   (`/v1/series/{id}/observations` + a flat batch sibling) are *separate*, with the discovery-vs-retrieval
   split justified on caching/ranking/rate-limit grounds (§1). No single `/query` does both. (NN1)
2. **No text-to-SQL / free-expression on the read path.** Retrieval takes a **stable `seriesId`** +
   **bounded structured params**; any NL layer emits those params, never SQL/an expression that reaches
   the planner. The P2SQL risk is named. (NN2, §1.4)
3. **Addressing resolves through the catalog + security master.** The `seriesId` maps to
   `(datasetId, canonicalSecurityId, measure)`; the user never addresses a raw storage table or
   free-types coordinates against the planner. The `dataset → instrument → expression` shape is mirrored.
   (NN3, §2)
4. **Read-from-store boundary stated.** The design says, in writing, that user reads touch only
   TimescaleDB + Redis and **never** fetch an upstream; a missing series returns typed `unavailable` /
   enqueues a write-path job, never a synchronous fetch. (NN4, §5)
5. **Uniform envelope with mandatory provenance.** Every retrieval (single, batch, grid) returns the same
   envelope; **`Provenance{commercialOk}` is on every series, default `false`**, `true` only for a GREEN
   fetch path with attribution. (§6)
6. **Bounded retrieval.** `maxPoints` is gateway-defaulted (~800); frequency aggregates downward only;
   the chart path is downsampled (not paged), the table path is **cursor**-paged; by-group fan-out beyond
   threshold is forced onto the bulk/Parquet path. (§3 bulk guard, §8)
7. **Resource modeling justified.** Nested discovery hierarchy + a flat-batch retrieval exception, with
   the choice argued against flat-only and against custom-verb RPCs (AIP-121, RESTful naming). One level
   of nesting; nouns not verbs. (§4)
8. **Channels are adapters, not paths.** Every delivery channel (Web/SDK/Excel/Batch/MCP) is shown to
   reshape the *same* two endpoints + envelope; none re-implements logic, opens a second store path, or
   drops provenance. The skill's surface boundary (vs `faceted-discovery-search`, `timescaledb-timeseries`,
   `security-master-symbology`, `data-provenance-licensing`) is stated. (§9)
9. **R-SCALE tier named.** The contract states which tier each surface survives and what breaks next:
   discovery scales via server-side faceted filter + cursor + indexed facets + ranking; retrieval scales
   via continuous-aggregate frequency rollups + LTTB + Redis compute-once-serve-many; bulk via Parquet
   off the request path. The binding constraint (point-volume, not hit count) is named. (§1, §8)

---

## 12. Anti-patterns this contract exists to prevent

| Anti-pattern (the mistake) | Why it breaks | The fix |
|---|---|---|
| One `/query` endpoint that both searches and returns numbers. | Un-cacheable (key explodes across both param sets); ranking has to special-case "list or number?"; one rate budget across two cost classes. | Two endpoints (§1): `/catalog` (discovery) + `/series/{id}/observations` (retrieval), each with its own cache + rank + rate budget. |
| An "ask anything about the data" box that turns NL → SQL against the warehouse. | **P2SQL injection** ([arXiv:2308.01990](https://arxiv.org/abs/2308.01990)); the LLM enforces no instruction/data boundary; you lose query visibility and control. | NL → **structured retrieval params** → the two endpoints. The agent emits the same params the REST endpoint takes; SQL never derives from a prompt. (§1.4) |
| Retrieval fetches the upstream provider if the series isn't warm. | Latency hostage to upstreams; an upstream outage = our outage; blows the upstream rate quota on a spike; invites fabricated backfill on fetch failure. | Read from **store + Redis only**; missing → typed `unavailable` / enqueue a write-path job. Only the worker fetches. (§5) |
| Address series by a free-typed expression string the user composes against the planner. | Symbology ambiguity (two providers, two symbols, "two series"); an injection surface; the wire handle is coupled to physical storage. | Hand out a **stable `seriesId`** from the catalog, resolved through the FIGI security master; parse any expression to a `seriesId` *first*. (§2) |
| Flat expression list as the ONLY shape (no nested discovery hierarchy). | Throws away path-derived cache keys and the self-documenting discovery hierarchy a 130m-series catalog needs to be navigable. | Nested discovery (`/datasets/{id}/series`) as primary + flat **batch** retrieval as the named exception. (§4) |
| Custom-verb RPCs (`POST /getTimeSeries`, `/searchData`). | Verbs in URLs violate resource-orientation; the two jobs map cleanly onto standard `List`/`Get`. | Nouns + HTTP verbs; `List` a collection = discovery, `Get` observations = retrieval. POST only for an over-long batch body. (§4.4) |
| A by-group request fans out to thousands of series and streams them as JSON synchronously. | Unbounded response; freezes the gateway; the point-volume problem at its worst. | Threshold the fan-out; **force bulk onto the Parquet/R2 path** off the request, with an async pointer/notification. (§3 bulk guard) |
| A channel (Excel/Batch/MCP) opens its own store query or re-implements downsampling. | Logic drifts out of sync across channels; the `commercialOk` gate gets dropped on one surface; the boundary collapses. | Every channel is a **thin adapter over the two endpoints + the uniform envelope**; logic and provenance live once, in the contract. (§9) |
| Returning a different response shape per retrieval intent (expression vs instrument vs group). | Every channel needs three parsers; the uniform-envelope guarantee is gone. | Three *input* intents, **one output envelope** (§3.2, §6); the gateway resolves the intent, the wire shape is invariant. |
| A grid/board built by pulling N full series and pivoting client-side. | Pulls N histories to display one "today" column; wasteful and slow. | A bounded `/v1/grid/{id}` snapshot mode (latest-per-series / `asOf`), served from the store. (§7) |

---

## 13. References consulted (primary sources, this run)

**JPM DataQuery — the addressing model & query patterns (read at source):**
- **jpmorganchase/dataquery-sdk** README — the three retrieval methods
  (`get_expressions_time_series_async`, `get_instrument_time_series_async`,
  `get_group_time_series_async`), `get_grid_data_async`, the discovery methods
  (`list_groups`/`search_groups`/`list_instruments`/`search_instruments`/`get_group_attributes`/
  `get_group_filters`), the `DB(MTE, …, MIDPRC)` expression example, and the token-bucket rate-limiter /
  retry / connection-pool features. (github.com/jpmorganchase/dataquery-sdk)
- **macrosynergy/macrosynergy@develop:macrosynergy/download/dataquery.py** — the endpoint constants
  (`CATALOGUE_ENDPOINT = "/group/instruments"`, `TIMESERIES_ENDPOINT = "/expressions/time-series"`,
  the OAUTH/CERT base URLs, `OAUTH_DQ_RESOURCE_ID`), the retrieval defaults (`CAL_ALLDAYS`, `FREQ_DAY`,
  `CONV_LASTBUS_ABS`, `NA_NOTHING`, `NO_REFERENCE_DATA`, `format=JSON`), `batch_size = 20`,
  `API_DELAY_PARAM = 0.25`, `API_RETRY_COUNT = 5`, and the `links[1].next` cursor recursion.
- **docs.macrosynergy.com** — the JPMaQS ticker grammar `DB(JPMAQS, <cross_section>_<category>, <info>)`
  and the `info ∈ {value, eop_lag, mop_lag, grade}` set.
- **jpmorgan.com/markets/dataquery** — the four delivery channels (Web · API · Batch SFTP+email · Excel)
  and the scale stats (650 datasets, 130m+ series, 4B+ hits/yr, 75% API).

**The universal two-endpoint / parameter contract (cross-verification — 3+ independent systems):**
- **FRED API** — `fred/series/search` (discovery) vs `fred/series/observations` (retrieval) split; the
  `frequency` (down-only) / `aggregation_method` (`avg/sum/eop`) / `units` / `vintage_dates` parameter
  set; `limit`+`offset` paging. (fred.stlouisfed.org/docs/api/fred/;
  cran.r-project.org/web/packages/fredr)
- **World Bank Indicators API v2** — the nested `country/{id};{id}/indicator/{id};{id}?date=YYYY:YYYY`
  hierarchy, the URL-vs-argument structure duality, `mrv`/`format=json`. (datahelpdesk.worldbank.org)
- **Bloomberg BLPAPI** — `ReferenceDataRequest` vs `HistoricalDataRequest` as distinct request types
  (400 vs 25 field limits) inside one `//blp/refdata` service. (Bloomberg BLPAPI Core Developer Guide)
- **OpenBB Platform** — the router → standardized `Fetcher[Q,R]` → uniform model flow; one architecture,
  many identical-output interfaces (library/Workspace/Excel). (openbb.co/blog architecture)

**API-design standards (resource modeling, naming, granularity):**
- **Google AIP-121** (resource-oriented design) — resources-as-hierarchies, standard methods
  `Get`/`List`/`Create`/`Update`/`Delete`, "custom methods only when standard ones don't fit," the DAG
  rule. (google.aip.dev/121)
- **restfulapi.net** + DreamFactory naming guide — nouns-not-verbs, pluralized collections, path for
  containment, "one level of nesting normal, two a smell, three almost always wrong."
- **API granularity** (DZone / Nordic APIs / Horizontal Digital) — read requests coarse-grained, fine
  for public/unknown clients; decide by use case.

**Security (the text-to-SQL argument):**
- **Pedro et al.**, "From Prompt Injections to SQL Injection Attacks" (arXiv:2308.01990 / ICSE'25) — P2SQL
  injection; "current LLMs do not enforce a security boundary between instructions and data."
- **UK NCSC** — "Prompt injection is not SQL injection (it may be worse)."

**Project design docs (the committed contract this doc instantiates):**
- [`03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)
  — the `/catalog` + `/series` two-endpoint contract, `maxPoints` default, the store-only read path.
- [`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)
  — the hard boundaries (read-never-fetches, write-only-fetches, security-master-first), the chosen stack.
- [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
  — the skill split this doc routes to.
- [`distribution-mcp-channel/01-plan.md`](../../../../.agents/jpm-markets-reengineering/distribution-mcp-channel/01-plan.md)
  — "core owns logic, adapters only reshape" — the channel-layer law §9 rests on.
- [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) — the per-series `commercialOk` gate the
  envelope carries.
</content>
</invoke>
