# patterns-catalog-discovery-endpoint.md

> **Recipe.** The consumer-facing **catalog/discovery channel** — the exact HTTP contract a
> developer (or our own dashboard, or an agent) hits to *browse, facet, search, and typeahead*
> over datasets → groups → instruments → expressions, **before** they ever pull a number.
> End-to-end runnable Express/TS gateway handlers + a generated OpenAPI 3.1 shape + the
> response cards with per-result `Provenance` + a prefix-`/suggest` autocomplete endpoint,
> modelled 1:1 on JPM's own `dataquery-sdk` discovery surface and FRED's `series/search` +
> `category/*` split.
>
> **Product line:** JPM-Markets re-engineering **data-analytics** line — **NOT Lumina**. This is
> the DataQuery re-engineering's *read/discovery* channel on the **Express 5 / TypeScript
> gateway** (Vercel serverless), the sibling of the `/series` retrieval channel. It serves
> **only from our store + Redis** — never fetch-through on a user request
> (`02-skills-and-pipeline.md` §"read path serves from the store; only the write path fetches").
>
> **The layer line (read this first).** This doc is the **wire contract** — URLs, query params,
> status codes, JSON shapes, pagination semantics, the response cards. It is **not** the index.
> The GIN/`pg_trgm`/btree index build, the `tsvector` weighting, the BM25-ish ranking math, the
> CTR-signal store — all of that lives in the sibling **`faceted-discovery-search`** dev-skill
> (`faceted-filters-and-indexes.md`, `keyword-trigram-and-autocomplete.md`,
> `matching-vs-ranking.md`). **This doc consumes that index; it does not specify it.** Where a
> section needs an index guarantee (e.g. "every faceted field is indexed server-side"), it
> states the *contract the index must satisfy* and points at that skill for the *how*.

---

## 0. What this channel is, in one paragraph

DataQuery's product page lists four delivery channels — **Web, API, Batch (SFTP/email), Excel**
([jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery), fetched
2026-06-24). Every one of them needs the same first move: *find the series you want.* JPM
addresses data as `DB(<group/dataset>, <instrument>, <metric>)` — e.g.
`DB(JPMAQS,USD_EQXR_VT10,value)` — and **discovery (which groups/instruments exist) is a
separate surface from retrieval (the numbers)**
([developer.jpmorgan.com/products/dataquery_api](https://developer.jpmorgan.com/products/dataquery_api);
addressing model confirmed at source in the macrosynergy client). This file specifies the
**discovery surface**: the endpoints that let a consumer list datasets/groups, drill into a
group's instruments, search by keyword, read a group's available attributes/filters, and get
prefix typeahead — each result carrying a `Provenance{commercialOk}` stamp and a sparkline-preview
hint. The retrieval surface (`GET /series`) is a separate doc.

**The two channels, side by side** (the universal two-endpoint contract every production
time-series API converges on — JPM, FRED, World Bank all do exactly this):

| | **Discovery channel** *(this doc)* | **Retrieval channel** *(separate)* |
|---|---|---|
| Question it answers | "*Which* datasets/series exist? What matches `q`?" | "Give me the *numbers* for series X over [from,to]." |
| JPM analogue | `/group/instruments` + the SDK `list_*`/`search_*` methods | `/expressions/time-series` |
| FRED analogue | `series/search`, `category/series`, `category/children` | `series/observations` |
| Returns | result **cards** (id, title, facets, provenance, sparkline hint) | a downsampled `{t,v}[]` series |
| Bound scale surface | a **list/search** surface (R-SCALE §A/§B) | a **point-volume** surface (R-SCALE §C) |
| Pagination default | page/offset (bounded small result page) | cursor (deep walk of a large group) |

---

## 1. The reference surface: JPM's `dataquery-sdk` discovery methods (verbatim)

JPM ships an **official Python SDK** —
[github.com/jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk),
*"a high-performance Python SDK for the DATAQUERY Data API … querying, downloading,
availability checking, rate limiting, retry logic, connection pool monitoring."* Its discovery
methods are the **canonical shape we re-engineer** (every method has an `_async` and a sync
variant; drop the suffix for sync). Captured verbatim from the SDK README/docs this run:

| SDK method | Parameters | Returns / purpose |
|---|---|---|
| `list_groups_async(limit)` | `limit` | List of group objects (`group_id`, `group_name`). *"List groups."* |
| `search_groups_async(keywords, limit, offset)` | `keywords`, `limit`, `offset` | Filtered group results. *"Keyword search."* |
| `list_instruments_async(group_id, instrument_id=None, page=None)` | `group_id`, `instrument_id?`, `page?` | Instrument listings. *"List / lookup instruments."* |
| `search_instruments_async(group_id, keywords, page=None)` | `group_id`, `keywords`, `page?` | Filtered instruments. *"Instrument keyword search."* |
| `get_group_attributes_async(group_id)` | `group_id` | *"Available attributes for a group."* |
| `get_group_filters_async(group_id, page=None)` | `group_id`, `page?` | *"Available filters for a group."* |

Verbatim quick-start (from the SDK docs):

```python
async with DataQuery() as dq:
    groups       = await dq.list_groups_async(limit=100)
    matches      = await dq.search_groups_async("fixed income", limit=20)
    instruments  = await dq.search_instruments_async(group_id="FI_GO_BO_EA", keywords="irish")
    attrs        = await dq.get_group_attributes_async(group_id="FI_GO_BO_EA")
    filters      = await dq.get_group_filters_async(group_id="FI_GO_BO_EA")
```

Underlying REST endpoint + pagination (from the **macrosynergy** open-source client, the
strongest public evidence since JPM's own API docs are auth-walled —
`macrosynergy/macrosynergy@develop:macrosynergy/download/dataquery.py`,
[docs.macrosynergy.com/.../dataquery.html](https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html)):

```python
CATALOGUE_ENDPOINT: str = "/group/instruments"        # the discovery endpoint
TIMESERIES_ENDPOINT: str = "/expressions/time-series" # the retrieval endpoint (NOT this doc)

# get_catalogue(...) accepts page_size: int = 1000
#   "`page_size` must be an integer between 1 and 1000."

# Pagination = a server-provided next-link the client follows recursively:
if "links" in response.keys() and response["links"][1]["next"] is not None:
    downloaded_data.extend(
        self._fetch(url=self.base_url + response["links"][1]["next"], params={}, ...))
```

Rate-limit defaults exposed by the official SDK (verbatim): **`DATAQUERY_REQUESTS_PER_MINUTE: 300`**
and **`DATAQUERY_BURST_CAPACITY: 5`** ("300 rpm / 5 tps", token-bucket limiter). The
macrosynergy client's `API_DELAY_PARAM=0.25` / `API_RETRY_COUNT=5` are **client self-throttle
conventions, not JPM's enforced quota** — `[inferred]`, flag accordingly; treat our own gateway
limits as an independent design choice (`03-dataquery-system-design.md` open-Q 7).

**What we take from this, what we change.** We take the **method taxonomy** verbatim — `list_groups`,
`search_groups`, `list_instruments`, `search_instruments`, `get_group_attributes`,
`get_group_filters` map 1:1 onto our endpoints below. We **change**: (a) the server-provided
opaque `links.next` becomes a clean `next_cursor` for the deep instrument walk; (b) every result
card carries a `Provenance{commercialOk}` JPM does not give; (c) facets become first-class
typed query params with an indexed-field contract; (d) a dedicated `/suggest` prefix endpoint is
added (the SDK has keyword search but no separate prefix/typeahead surface).

---

## 2. The endpoint map (the whole channel on one page)

All under the gateway base `/api/v1`. **Method = `GET` everywhere** (discovery is a pure read;
caching, link-sharing, and CDN all want idempotent GETs).

| Endpoint | Mirrors (JPM SDK / FRED) | Returns | Pagination |
|---|---|---|---|
| `GET /datasets` | `list_groups` / FRED `category/children`+`category/series` | dataset/group cards + facet counts | page/offset |
| `GET /datasets/{id}` | `get_group_attributes` | one dataset's full metadata + attribute schema | — |
| `GET /datasets/{id}/instruments` | `list_instruments` / FRED `category/series` | instrument cards within a dataset | **cursor** (large group) |
| `GET /datasets/{id}/filters` | `get_group_filters` | the facet/filter *definitions valid for this dataset* | page/offset |
| `GET /search` | `search_groups`+`search_instruments` / FRED `series/search` | mixed result cards (datasets + instruments), ranked | page/offset |
| `GET /suggest` | *(new — no SDK analogue)* | lightweight prefix typeahead rows | top-N, no paging |
| `GET /facets` | *(derived from FRED `tags`/filters)* | the **global** facet vocabulary + counts | — |

Three design rules bind the whole map (all from `product-at-scale.md` §A/§B):

1. **Every field a client can filter or sort on is indexed server-side.** An unindexed facet is a
   full-table scan — *reading every page of a book instead of using its index*. The index build is
   the `faceted-discovery-search` skill's job; **this contract's promise is that no exposed facet
   is un-indexed.** (Enforced as a CI check, §10.)
2. **Filtering, sorting, and ranking happen on the server in a DB query — never on the client.**
   The client never holds the catalog in memory; it holds one page.
3. **Search has two halves: matching and ranking.** This contract *surfaces* the ranking signal
   (`relevance`/`popularity`) and an `_score` in each result; the ranking *function* lives in
   `matching-vs-ranking.md`. The contract also mandates **CTR instrumentation from day one** (§8) —
   you cannot rank by signals you never stored.

---

## 3. `GET /datasets` — list + facet the dataset/group catalog

The home of the browse experience. Mirrors `list_groups` but adds typed facets and facet **counts**
(so the UI can render "Rates (412) · Credit (180) · FX (96)" without a second round-trip).

### 3.1 Request

```
GET /api/v1/datasets
      ?asset_class=rates,credit            # repeatable / CSV — OR within a facet
      &region=us,eu                        # AND across facets
      &frequency=daily
      &source=edgar
      &q=treasury                          # optional free-text narrow (FTS, not the main search)
      &sort=popularity                     # relevance | popularity | name | updated
      &order=desc                          # asc | desc
      &page=1                              # 1-based
      &limit=25                            # 1..100, default 25
      &include=facets                      # opt-in: return facet counts alongside results
```

**Facet params and their domains** (the four facets the brief names; their *vocabulary* comes from
JPM's own catalog — Rates/Credit/Equities/FX/Commodities/Cross-Asset are the verbatim asset
classes on [markets.jpmorgan.com/data-and-analytics/data-content](https://markets.jpmorgan.com/data-and-analytics/data-content)):

| Param | Type | Domain (enum, served by `GET /facets`) | Combinator |
|---|---|---|---|
| `asset_class` | enum[] | `rates · credit · equities · fx · commodities · cross_asset · macro` | OR within, AND across facets |
| `region` | enum[] | `us · eu · uk · jp · em · global` | OR/AND |
| `frequency` | enum[] | `daily · weekly · monthly · quarterly · annual · intraday` | OR/AND |
| `source` | enum[] | `edgar · treasury · bls · bea · worldbank · oecd · imf · …` | OR/AND |

> **Contract:** the **value domain of every facet is itself served** (`GET /facets`, §9) — the
> client never hardcodes the enum. New GREEN sources (`02` §"green-provider-fetchers") show up in
> the `source` facet automatically once their catalog rows land. **Reject unknown enum values with
> `422`** (don't silently ignore — a typo'd facet that returns the unfiltered set is a classic
> Tier-1 "looks fine in the demo" bug).

### 3.2 Response (result cards + facet counts + page meta)

```jsonc
{
  "results": [
    {
      "id": "TREAS_CMT",                          // dataset/group id (the DB() group)
      "type": "dataset",
      "name": "US Treasury Constant Maturity Yields",
      "description": "Daily CMT par yields, 1M–30Y, US Treasury.",
      "asset_class": "rates",
      "region": "us",
      "frequency": "daily",
      "source": "treasury",
      "instrument_count": 12,                      // how many series live in this group
      "observation_start": "1990-01-02",
      "observation_end":   "2026-06-23",
      "last_updated":      "2026-06-24T11:05:00Z",
      "popularity": 87,                            // 0..100 — surfaced ranking signal (§8)
      "_score": 1.0,                               // matching/ranking score when q present
      "sparkline_hint": {                          // a PREVIEW hint, not the data (§7)
        "series_id": "TREAS_CMT.DGS10",            // the representative series to preview
        "points": 24,                              // suggested point budget for the mini-trend
        "href": "/api/v1/series?ids=TREAS_CMT.DGS10&maxPoints=24&range=1Y"
      },
      "provenance": {                              // MANDATORY per card (§6)
        "source": "U.S. Treasury FiscalData",
        "commercialOk": true,                      // GREEN public-domain fetch path
        "attribution": "Source: U.S. Treasury (fiscaldata.treasury.gov)"
      }
    }
    // … up to `limit` cards
  ],
  "facets": {                                      // present only when include=facets
    "asset_class": [ { "value": "rates", "count": 412 }, { "value": "credit", "count": 180 } ],
    "region":      [ { "value": "us", "count": 540 }, { "value": "eu", "count": 220 } ],
    "frequency":   [ { "value": "daily", "count": 610 }, { "value": "monthly", "count": 190 } ],
    "source":      [ { "value": "treasury", "count": 96 }, { "value": "edgar", "count": 310 } ]
  },
  "page": {
    "page": 1, "limit": 25, "total": 412, "total_pages": 17,
    "has_more": true,
    "next": "/api/v1/datasets?asset_class=rates&page=2&limit=25"   // ready-to-follow link
  }
}
```

**Why facet counts matter (and the cost).** Counts turn a flat list into navigable IA — at 130m+
series *nobody browses the list*; they facet/search into a handful (`03` §Scale(a)). Counts are a
second aggregate query (`GROUP BY facet`), so they are **opt-in via `include=facets`** — the first
page asks for them, paging through asks for results only. (FRED exposes this via its separate
`tags`/`related_tags` endpoints; we fold it into one opt-in param.)

---

## 4. `GET /datasets/{id}/instruments` — paginate the series inside a group

Mirrors `list_instruments(group_id, page=…)`. **This is the one discovery endpoint where the
result set can be genuinely large** (a single JPM credit-index group can hold thousands of
constituents; JPM's own catalogue page-size caps at 1000 per call and follows `links.next`). So
**this endpoint uses cursor pagination**, while §3/§5 use page/offset (the why is §11).

### 4.1 Request

```
GET /api/v1/datasets/TREAS_CMT/instruments
      ?q=10y                       # optional in-group keyword (mirrors search_instruments)
      &limit=50                    # 1..200, default 50
      &cursor=eyJpZCI6IkRHUzEwIn0  # opaque; omit for the first page
      &sort=name                   # name | updated | popularity   (NOT offset-sortable arbitrarily)
```

### 4.2 Response

```jsonc
{
  "results": [
    {
      "id": "TREAS_CMT.DGS10",                     // instrument id = group.instrument
      "type": "instrument",
      "name": "10-Year Treasury CMT Yield",
      "group_id": "TREAS_CMT",
      "metrics": ["value"],                        // the <metric> in DB(group, instrument, metric)
      "frequency": "daily",
      "unit": "percent",
      "observation_start": "1962-01-02",
      "observation_end":   "2026-06-23",
      "popularity": 94,
      "sparkline_hint": { "series_id": "TREAS_CMT.DGS10", "points": 24,
                          "href": "/api/v1/series?ids=TREAS_CMT.DGS10&maxPoints=24&range=1Y" },
      "provenance": { "source": "U.S. Treasury FiscalData", "commercialOk": true,
                      "attribution": "Source: U.S. Treasury (fiscaldata.treasury.gov)" }
    }
  ],
  "page": {
    "limit": 50,
    "has_more": true,
    "next_cursor": "eyJpZCI6IkRHUzMwIn0",          // opaque keyset cursor; null on last page
    "next": "/api/v1/datasets/TREAS_CMT/instruments?limit=50&cursor=eyJpZCI6IkRHUzMwIn0"
  }
}
```

The cursor is **opaque and stateless** — base64 of the last row's keyset (`{id}` or
`{popularity,id}` matching the `sort`). The client **must not decode it** (Speakeasy/getKnit
convention: *"Do not decode the value of `next_cursor`"*,
[getknit.dev/blog/api-pagination-best-practices](https://www.getknit.dev/blog/api-pagination-best-practices)).
On the last page, `next_cursor` is `null` and `next` is omitted.

> **Why cursor here and not offset:** at deep offsets the DB *scans and discards* every skipped
> row — *"page 10,000 (OFFSET 199,980) takes 8,200ms … doing real work for every discarded row"*;
> keyset/cursor *"performance remains consistent regardless of page depth"* (≈17× at depth)
> ([getknit.dev](https://www.getknit.dev/blog/api-pagination-best-practices);
> [milanjovanovic.tech cursor-pagination deep-dive](https://www.milanjovanovic.tech/blog/understanding-cursor-pagination-and-why-its-so-fast-deep-dive)).
> Cursor pagination is *"the safest default for a public API or infinite-scroll client"* — exactly
> the instruments-in-a-large-group walk.

---

## 5. `GET /search` — the cross-catalog search channel (typeahead → full)

Mirrors FRED's `series/search` (which fuses what the JPM SDK splits into `search_groups` +
`search_instruments`). **This is the matching-AND-ranking surface** — and the contract's job is to
*expose* the ranking, not implement it.

### 5.1 Request

```
GET /api/v1/search
      ?q=10 year treasury yield      # the query (REQUIRED; ≥2 chars or 422)
      &type=all                      # all | dataset | instrument
      &asset_class=rates             # facets narrow the search, same domain as §3
      &region=us
      &sort=relevance                # relevance(default) | popularity | updated
      &page=1
      &limit=20                      # 1..50, default 20
```

### 5.2 Response

```jsonc
{
  "query": "10 year treasury yield",
  "results": [
    {
      "id": "TREAS_CMT.DGS10", "type": "instrument",
      "name": "10-Year Treasury CMT Yield",
      "asset_class": "rates", "region": "us", "frequency": "daily",
      "_score": 8.42,                              // surfaced ranking score (text-relevance × signals)
      "_match": {                                  // WHY it matched — debuggable, drives ts_headline UI
        "field": "name", "rank": "title_exact",
        "highlight": "10-Year <em>Treasury</em> CMT <em>Yield</em>"
      },
      "popularity": 94,
      "sparkline_hint": { "series_id": "TREAS_CMT.DGS10", "points": 24,
                          "href": "/api/v1/series?ids=TREAS_CMT.DGS10&maxPoints=24&range=1Y" },
      "provenance": { "source": "U.S. Treasury FiscalData", "commercialOk": true,
                      "attribution": "Source: U.S. Treasury (fiscaldata.treasury.gov)" }
    }
  ],
  "page": { "page": 1, "limit": 20, "total": 37, "total_pages": 2, "has_more": true,
            "next": "/api/v1/search?q=10+year+treasury+yield&page=2&limit=20" }
}
```

**Three contract guarantees this endpoint makes** (each backed by `matching-vs-ranking.md`):

1. **Ranking is surfaced, not array-order.** `_score` and `sort=relevance|popularity` are
   first-class. *"Search has two halves: matching … and ranking … every production search is
   dominated by ranking"* (`product-scale-architecture.md` §H Q25). Shipping only matching (array
   order) is the Tier-1 tell.
2. **Text relevance respects match position.** A hit in `name`/title outranks a hit in
   `description`; an exact word outranks a stem/partial (`_match.rank` exposes which —
   `title_exact > title_stem > desc_match`). This is the BM25/`ts_rank` weighting
   (`A>B>C>D`) the index applies; the contract just **reports** it so the UI can highlight and so
   ranking is debuggable. (FRED's analogue: `order_by=search_rank`,
   [fred.stlouisfed.org/docs/api/fred/series_search.html](https://fred.stlouisfed.org/docs/api/fred/series_search.html).)
3. **The query must be typo-tolerant.** `samsng → Samsung`, `tресury → treasury`. That is the
   `pg_trgm` similarity layer fused with FTS — *"pg_trgm enables fuzzy matching for typo
   tolerance … the `%` similarity operator"*
   ([postgresql.org/docs/.../pgtrgm.html](https://www.postgresql.org/docs/current/pgtrgm.html)).
   The contract's promise: a near-miss still returns ranked results, never an empty page.

> **FRED parity, verbatim.** FRED's `series/search` is our closest public model. Its params we
> mirror: `search_text` → `q`; `search_type` (`full_text` | `series_id`) → our `q` is `full_text`
> by default with `type=` selecting the corpus; `limit` (1..1000, default 1000 — **we cap at 50**,
> a discovery page is small); `offset`; `order_by` ∈ {`search_rank`, `popularity`, `last_updated`,
> `group_popularity`} → our `sort` ∈ {`relevance`, `popularity`, `updated`}; `sort_order` →
> `order`; `filter_variable` ∈ {`frequency`, `units`, `seasonal_adjustment`} → our typed facets
> ([fred.stlouisfed.org/docs/api/fred/series_search.html](https://fred.stlouisfed.org/docs/api/fred/series_search.html),
> param/order_by/filter values confirmed this run).

---

## 6. The result card + `Provenance` — the load-bearing shape

Every result in every discovery response is a **card** with the same skeleton, and **every card
carries `provenance`**. This is non-negotiable: the `commercial-ok-gate` rule is inherited
verbatim from `finance-markets`, and it attaches to the **fetch path, not the concept**.

```ts
// shared/cards.ts — the discovery card contract (TS, gateway-side)
export interface Provenance {
  source: string;            // human-readable origin ("U.S. Treasury FiscalData")
  commercialOk: boolean;     // DEFAULT false; true only for a GREEN fetch-path row in the ledger
  attribution: string | null;// REQUIRED non-null string when the license demands credit (CC-BY)
}

export interface SparklineHint {
  series_id: string;         // the representative series to preview (NOT the data itself)
  points: number;            // suggested maxPoints budget (~card pixel width)
  href: string;              // a ready /series URL the card can lazy-fetch on hover/scroll-in
}

export interface DiscoveryCard {
  id: string;                // dataset id OR "group.instrument"
  type: "dataset" | "instrument";
  name: string;
  description?: string;
  asset_class?: AssetClass;
  region?: Region;
  frequency?: Frequency;
  source?: string;
  instrument_count?: number; // datasets only
  metrics?: string[];        // instruments only — the <metric> options
  unit?: string;
  observation_start?: string; // ISO date
  observation_end?: string;
  last_updated?: string;      // ISO datetime
  popularity?: number;        // 0..100 — a surfaced ranking signal
  _score?: number;            // present on search results
  _match?: { field: string; rank: string; highlight?: string };
  sparkline_hint?: SparklineHint;
  provenance: Provenance;     // NOT optional — the gate is mandatory
}
```

**Contract rules on `provenance`:**

- `commercialOk` defaults `false`. It is `true` **only** when the card's underlying fetch path is a
  🟢 row in [`../../memory/sources-ledger.md`](../../memory/sources-ledger.md) (US-gov public-domain,
  or CC-BY/CC0 *with attribution rendered*, or a purchased commercial tier). A free API tier is not
  a display license. (`commercial-ok-gate.md`.)
- **Composite/contamination rule:** if a dataset card aggregates multiple series, its
  `commercialOk` is the **AND** of its inputs — a single RED input contaminates the composite to
  RED. Never claim GREEN on a card whose underlying mix includes a RED fetch path.
- `attribution` is **non-null and rendered** for any CC-BY source (World Bank, OECD, IMF). An
  un-rendered attribution breaks the license even though the source is "GREEN" (`02` §licensing
  trap 5).
- A card for a **RED** series is still allowed in discovery (RED gates *display license*, not
  *access/listing*) — it just carries `commercialOk:false` and the UI shows the attribution +
  a "fetch-through only" affordance, never a redistributed value.

---

## 7. `sparkline_hint` — a preview *pointer*, never the data

The brief asks each result card to carry a sparkline-preview hint. The discipline: **the discovery
response must not inline the preview series.** Inlining even 24 points × N cards × the page would
(a) bloat the discovery payload, (b) couple the cacheable, slow-changing *metadata* response to
fast-changing *price* data (two TTLs in one body), and (c) break the channel boundary — discovery
returns *cards*, retrieval returns *numbers*.

So `sparkline_hint` is a **pointer**: `{ series_id, points, href }`. The client lazy-fetches the
tiny preview from the *retrieval* channel (`/series?…&maxPoints=24`) on scroll-into-view / hover —
the same retrieval endpoint, already server-downsampled to ~the sparkline's pixel width (`03`
§"the API never returns more points than the chart can draw"). This keeps the discovery response
**pure metadata** (long TTL, `getOrRefresh`-warmable) and pushes the volatile data to the channel
that owns downsampling. The `Sparkline` UI component already consumes a pre-shaped `{t,v}[]`
(`03` reuse table) so it pairs cleanly with the lazy `/series` fetch.

---

## 8. Ranking signals + CTR instrumentation (from day one)

The contract surfaces two ranking signals (`popularity`, `_score`) — but a ranking is only as good
as the signals you stored, and **you cannot rank by a signal you never captured**
(`product-scale-architecture.md` §H Q27). So the discovery channel **instruments clicks from day
one**, even before there's anyone to rank for.

```
POST /api/v1/events/click          # fire-and-forget; 202 Accepted, no body
{
  "query": "10 year treasury yield",      // the q that produced the result (null if browse)
  "result_id": "TREAS_CMT.DGS10",
  "result_type": "instrument",
  "position": 3,                          // 1-based rank the user clicked at — CTR-by-position
  "session": "anon-…"                     // pseudonymous; never PII
}
```

- This is **append-only telemetry**, written off the request path (queue/async) — it never blocks
  the click navigation. It feeds the `matching-vs-ranking.md` model: CTR-by-position, query→click
  pairs, and dwell become the *behavioral* half of `text-relevance × performance-signals`.
- **Cold-start prior** (`03` open-Q 6): before CTR accumulates, rank by `text-relevance (BM25/ts_rank)
  × source-authority × recency`. Popularity seeds from `instrument_count` / known-series lists.
- **Privacy:** the event is pseudonymous and carries no PII; it is a ranking signal store, not a
  user profile.

> **The F4 "metric in a costume" guard.** `popularity` must be a *real* stored signal (click/usage
> derived), not a fabricated dial. If we cannot yet compute it honestly, **omit the field** rather
> than ship a number that changes no reader's decision (`red-team-negation-loop.md` F4). An honest
> absent field beats a dressed-up guess.

---

## 9. `GET /facets` and `GET /datasets/{id}/filters` — the facet vocabulary

Two facet-metadata endpoints, mirroring the JPM SDK's `get_group_attributes` / `get_group_filters`
split and FRED's `tags` endpoints.

**`GET /facets`** — the **global** facet vocabulary (what every facet param can take, with counts).
The client calls this **once** to render filter chips; it never hardcodes the enum.

```jsonc
// GET /api/v1/facets
{
  "asset_class": [ {"value":"rates","label":"Rates","count":412}, {"value":"credit","label":"Credit","count":180}, … ],
  "region":      [ {"value":"us","label":"United States","count":540}, … ],
  "frequency":   [ {"value":"daily","label":"Daily","count":610}, … ],
  "source":      [ {"value":"treasury","label":"U.S. Treasury","count":96, "commercialOk":true}, … ]
}
```

**`GET /datasets/{id}/filters`** — the facets/attributes **valid for one dataset** (a credit-index
group exposes `rating`, `maturity_bucket`, `sector`; a macro group does not). Mirrors
`get_group_filters(group_id, page)` — and per the SDK it is **paginated** (`page=`), because a
large group's attribute list can itself be long:

```jsonc
// GET /api/v1/datasets/JULI_CREDIT/filters?page=1
{
  "dataset_id": "JULI_CREDIT",
  "attributes": [   // get_group_attributes analogue — the columns each instrument carries
    { "name": "rating",         "type": "enum",   "values": ["AAA","AA","A","BBB"] },
    { "name": "maturity_bucket","type": "enum",   "values": ["1-3Y","3-5Y","5-7Y","7-10Y","10Y+"] },
    { "name": "sector",         "type": "enum",   "values": ["financials","industrials","utilities"] }
  ],
  "page": { "page": 1, "limit": 100, "has_more": false, "next_cursor": null }
}
```

> **Contract:** every attribute returned here **is an indexed, filterable column** on the instrument
> table for that group — i.e. if `/datasets/{id}/filters` advertises `rating`, then
> `?rating=BBB` on the instruments endpoint is a guaranteed index hit, not a scan. The *advertise*
> and the *index* are kept in lockstep by the catalog write path (`data-provenance-licensing` +
> `faceted-discovery-search`).

---

## 10. `GET /suggest` — prefix typeahead, separate from full search

The brief (and `product-scale-architecture.md` §B Q10) is explicit: **autocomplete/suggestions use
a prefix index, separate from full search.** Conflating them is the classic mistake — typeahead
needs sub-30ms prefix latency on *every keystroke-after-debounce*, while full search runs the
heavier matching+ranking pipeline on submit.

```
GET /api/v1/suggest
      ?q=trea            # the prefix (≥1 char)
      &limit=8           # top-N, default 8, max 10 — typeahead is never paginated
      &type=all          # all | dataset | instrument
```

```jsonc
{
  "q": "trea",
  "suggestions": [
    { "id": "TREAS_CMT", "type": "dataset",   "name": "US Treasury Constant Maturity Yields",
      "highlight": "<em>Trea</em>sury CMT", "popularity": 87 },
    { "id": "TREAS_CMT.DGS10", "type": "instrument", "name": "10-Year Treasury CMT Yield",
      "highlight": "10-Year <em>Trea</em>sury", "popularity": 94 }
  ]
}
```

**Why a separate endpoint, and how the index differs:**

- **Prefix, not full text.** Suggest is a **left-anchored prefix match** ranked by popularity — the
  Postgres analogue is `to_tsquery('trea:*')` (the `:*` prefix operator) or a dedicated
  trigram/prefix index, *"prefix matching for autocomplete using `to_tsquery` with the `':*'`
  operator and `ts_rank` to sort"*
  ([postgres FTS guide](https://viprasol.com/blog/postgres-full-text-search-advanced/)). At Tier-3
  this is the Elasticsearch **Completion Suggester** — an in-memory **FST** for *"extremely fast
  prefix lookups,"* explicitly a **separate index** from the search corpus to *"minimize bloating
  nodes and provide faster suggestions"*
  ([Elastic completion suggester](https://medium.com/@taranjeet/elasticsearch-using-completion-suggester-to-build-autocomplete-e9c120cf6d87)).
- **No pagination, no facets, tiny rows.** Suggest returns ≤10 lightweight rows (`id`, `name`,
  `highlight`, `popularity`) — no provenance, no sparkline, no facet counts. It is a navigation
  aid, not a result.
- **Client debounce ≈250 ms.** The frontend fires `/suggest` ~250 ms after the keystroke pause, not
  on every key (`product-scale-architecture.md` §B Q7). Combined with the prefix index, this keeps
  typeahead cost flat under load.

> **Contract boundary:** `/suggest` and `/search` are *different indexes for a reason* — keeping
> them one endpoint with a `mode=` flag is the anti-pattern (§12). The build of both indexes is
> `keyword-trigram-and-autocomplete.md`; this doc fixes only their two distinct **wire shapes**.

---

## 11. Runnable Express/TS gateway handlers

The gateway is Express 5 / TS on Vercel serverless, reusing `cache.ts` (`getOrRefresh` + SWR +
in-flight de-dupe) and `ratelimit.ts` from this repo's `redis` skill. **Reads serve from the
store + Redis only** — the handler queries Postgres (the catalog/metadata DB), never an upstream.

### 11.1 Shared: zod-validated query parsing + the indexed-facet allowlist

```ts
// gateway/discovery/params.ts
import { z } from "zod";

// The facet enums are the SINGLE SOURCE OF TRUTH for "which columns are indexed".
// Adding a facet here WITHOUT a matching DB index must fail CI (§10 contract).
export const ASSET_CLASS = ["rates","credit","equities","fx","commodities","cross_asset","macro"] as const;
export const REGION      = ["us","eu","uk","jp","em","global"] as const;
export const FREQUENCY   = ["daily","weekly","monthly","quarterly","annual","intraday"] as const;

// CSV → string[] of allowed enum members; unknown member ⇒ throw (→ 422), never silently drop.
const csvEnum = <T extends readonly [string, ...string[]]>(vals: T) =>
  z.string().optional().transform((s, ctx) => {
    if (!s) return undefined;
    const parts = s.split(",").map(x => x.trim()).filter(Boolean);
    const bad = parts.filter(p => !(vals as readonly string[]).includes(p));
    if (bad.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown value(s): ${bad.join(", ")}` });
      return z.NEVER;
    }
    return parts as T[number][];
  });

export const datasetsQuery = z.object({
  asset_class: csvEnum(ASSET_CLASS),
  region:      csvEnum(REGION),
  frequency:   csvEnum(FREQUENCY),
  source:      z.string().optional().transform(s => s ? s.split(",").map(x=>x.trim()) : undefined),
  q:           z.string().trim().min(1).max(120).optional(),
  sort:        z.enum(["relevance","popularity","name","updated"]).default("popularity"),
  order:       z.enum(["asc","desc"]).default("desc"),
  page:        z.coerce.number().int().min(1).max(10_000).default(1),
  limit:       z.coerce.number().int().min(1).max(100).default(25),
  include:     z.string().optional(), // "facets"
});
export type DatasetsQuery = z.infer<typeof datasetsQuery>;
```

### 11.2 `GET /datasets` handler (page/offset + opt-in facet counts, cached)

```ts
// gateway/discovery/datasets.ts
import type { Request, Response } from "express";
import { datasetsQuery } from "./params.js";        // NOTE: .js ESM extension (repo rule #3)
import { getOrRefresh } from "../../lib/cache.js";
import { catalogPool } from "../db.js";              // pg Pool over the catalog DB (read-only role)

export async function listDatasets(req: Request, res: Response) {
  const parsed = datasetsQuery.safeParse(req.query);
  if (!parsed.success) return res.status(422).json({ error: "invalid_query", detail: parsed.error.issues });
  const q = parsed.data;

  // cache key = every input that changes the output (per redis skill discipline)
  const key = `disc:datasets:${JSON.stringify(q)}`;
  const body = await getOrRefresh(key, 60 /* soft TTL s */, async () => {
    // --- WHERE: every facet is an indexed column (btree on asset_class/region/frequency/source) ---
    const where: string[] = [];
    const args: unknown[] = [];
    const inClause = (col: string, vals?: string[]) => {
      if (!vals?.length) return;
      const ph = vals.map((_, i) => `$${args.length + i + 1}`).join(",");
      where.push(`${col} = ANY(ARRAY[${ph}])`); args.push(...vals);   // ANY(ARRAY) hits the btree/GIN
    };
    inClause("asset_class", q.asset_class);
    inClause("region",      q.region);
    inClause("frequency",   q.frequency);
    inClause("source",      q.source);
    if (q.q) { where.push(`search_tsv @@ websearch_to_tsquery('simple', $${args.length+1})`); args.push(q.q); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderSql = {
      relevance:  q.q ? `ts_rank(search_tsv, websearch_to_tsquery('simple', $${args.length})) DESC` : `popularity DESC`,
      popularity: `popularity ${q.order}`,
      name:       `name ${q.order}`,
      updated:    `last_updated ${q.order}`,
    }[q.sort];

    const offset = (q.page - 1) * q.limit;
    // One page only — NEVER select the whole catalog (Tier-1 anti-pattern).
    const rows = await catalogPool.query(
      `SELECT id, 'dataset' AS type, name, description, asset_class, region, frequency, source,
              instrument_count, observation_start, observation_end, last_updated, popularity
         FROM datasets ${whereSql}
        ORDER BY ${orderSql}
        LIMIT $${args.length+1} OFFSET $${args.length+2}`,
      [...args, q.limit, offset]
    );
    const total = await catalogPool.query(`SELECT count(*)::int AS n FROM datasets ${whereSql}`, args);

    let facets;
    if (q.include === "facets") facets = await computeFacetCounts(whereSql, args); // GROUP BY per facet

    return {
      results: rows.rows.map(toCard),                // attaches Provenance + sparkline_hint
      ...(facets ? { facets } : {}),
      page: pageMeta(q.page, q.limit, total.rows[0].n, req),
    };
  });

  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  res.json(body);
}
```

Notes that are load-bearing:

- **`ANY(ARRAY[...])` not `IN (...)`-string-built** — parameterized, injection-safe, and it uses the
  btree/GIN index on the facet column. Each facet is a separate AND'd indexed predicate.
- **`websearch_to_tsquery` + `ts_rank`** for the optional in-list `q` narrow —
  *"`websearch_to_tsquery` accepts natural search syntax … quoted phrases, OR, exclusions"* and
  *"`ts_rank` … {D,C,B,A} weights, A highest"*
  ([postgres FTS guide](https://viprasol.com/blog/postgres-full-text-search-advanced/)). The
  `search_tsv` column is a `GENERATED ALWAYS AS tsvector` with a GIN index (built by
  `faceted-discovery-search`).
- **One page selected, ever.** `LIMIT/OFFSET` on a bounded page; the count is a second cheap
  indexed aggregate. The client never receives the universe.

### 11.3 `GET /datasets/{id}/instruments` handler (cursor / keyset)

```ts
// gateway/discovery/instruments.ts
function decodeCursor(c?: string): { id: string } | null {
  if (!c) return null;
  try { return JSON.parse(Buffer.from(c, "base64url").toString()); } catch { return null; }
}
const encodeCursor = (id: string) => Buffer.from(JSON.stringify({ id })).toString("base64url");

export async function listInstruments(req: Request, res: Response) {
  const groupId = req.params.id;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const cursor = decodeCursor(req.query.cursor as string | undefined);
  const kw = (req.query.q as string | undefined)?.trim();

  const args: unknown[] = [groupId];
  let where = `group_id = $1`;
  if (kw)     { where += ` AND search_tsv @@ websearch_to_tsquery('simple', $${args.push(kw)})`; }
  if (cursor) { where += ` AND id > $${args.push(cursor.id)}`; }   // KEYSET: seek, don't skip

  // Fetch limit+1 to detect has_more without a COUNT(*).
  const rows = await catalogPool.query(
    `SELECT id, name, group_id, metrics, frequency, unit,
            observation_start, observation_end, popularity
       FROM instruments
      WHERE ${where}
      ORDER BY id ASC
      LIMIT $${args.push(limit + 1)}`,
    args
  );
  const page = rows.rows.slice(0, limit);
  const hasMore = rows.rows.length > limit;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1].id) : null;

  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  res.json({
    results: page.map(toCard),
    page: {
      limit, has_more: hasMore, next_cursor: nextCursor,
      ...(nextCursor ? { next: `${req.path}?limit=${limit}&cursor=${nextCursor}` } : {}),
    },
  });
}
```

- **Keyset, not offset:** `WHERE id > $cursor ORDER BY id LIMIT n+1`. Constant time at any depth.
- **`limit+1` trick:** detects `has_more` without a second `COUNT(*)` over a potentially huge group.
- The `id ASC` sort must match the cursor key; if `sort=popularity` is allowed, the cursor key
  becomes the composite `(popularity, id)` and the WHERE becomes the row-value comparison
  `(popularity, id) < ($p, $i)` — keep the key and the sort in lockstep.

### 11.4 `GET /suggest` handler (prefix, cached hot)

```ts
// gateway/discovery/suggest.ts
export async function suggest(req: Request, res: Response) {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) return res.json({ q: "", suggestions: [] });
  const limit = Math.min(Math.max(Number(req.query.limit ?? 8), 1), 10);
  const type = (req.query.type as string) ?? "all";

  const key = `disc:suggest:${type}:${q.toLowerCase()}:${limit}`;
  const body = await getOrRefresh(key, 300 /* prefixes are stable → long TTL */, async () => {
    // Prefix match via tsquery ':*' + popularity-ranked; the prefix index is built in
    // keyword-trigram-and-autocomplete.md. ts_headline drives the <em> highlight.
    const rows = await catalogPool.query(
      `SELECT id, type, name, popularity,
              ts_headline('simple', name, to_tsquery('simple', $1 || ':*'),
                          'StartSel=<em>,StopSel=</em>') AS highlight
         FROM discovery_index
        WHERE ($3 = 'all' OR type = $3)
          AND name_prefix_tsv @@ to_tsquery('simple', $1 || ':*')
        ORDER BY popularity DESC
        LIMIT $2`,
      [q, limit, type]
    );
    return { q, suggestions: rows.rows };
  });
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json(body);
}
```

---

## 12. Anti-patterns → fixes (the discovery-channel tells)

| Anti-pattern (the Tier-1 tell) | Why it breaks | Fix |
|---|---|---|
| Return the **whole catalog**, filter/sort in the browser. | Holds 130m candidates in client memory; first scale step dies. | Server-side filter + paginate; client holds one page (`product-at-scale.md` §A). |
| A facet param with **no index** behind it. | Full-table scan per filter; `?region=us` reads every row. | Index every exposed facet column; CI fails if a facet enum has no matching index (§11.1). |
| **Offset** pagination for the large instruments-in-a-group walk. | `OFFSET 200k` scans+discards 200k rows (~8.2s). | **Cursor/keyset** for §4; offset only for the bounded §3/§5 pages. |
| `/suggest` is just `/search` with a `mode=prefix` flag. | Typeahead inherits the heavy match+rank pipeline; slow per keystroke. | **Separate prefix endpoint + separate index** (FST/`:*`), ≤10 tiny rows (§10). |
| Search returns **array order** (no `_score`, no `sort`). | Ships matching only; *"every production search is dominated by ranking."* | Surface `_score` + `relevance/popularity` sort; instrument CTR (§5, §8). |
| **Inline** the sparkline series in each discovery card. | Couples slow metadata TTL to volatile prices; bloats the payload. | `sparkline_hint` is a **pointer** to `/series?maxPoints=…`, lazy-fetched (§7). |
| A card missing `provenance`, or `commercialOk:true` with no ledger row. | Silent mis-licensing; the #2 non-negotiable violated. | `provenance` mandatory; `true` only on a 🟢 ledger fetch path; composite = AND of inputs (§6). |
| Search **fires on every keystroke**. | N× the load; upstream-of-nothing here, but DB churn + jank. | Debounce ≈250 ms client-side (`product-scale-architecture.md` §B Q7). |
| Unknown facet value **silently ignored** (returns the unfiltered set). | "Looks fine in the demo," returns wrong superset in prod. | Reject unknown enum with **422** (§11.1). |
| `total_count` computed on **every** instruments page. | A `COUNT(*)` over a huge group on each page is the hidden Tier-2 cost. | `limit+1` has-more trick for cursor pages; full `total` only on the bounded §3/§5 lists (§11.3). |
| Fetch-through to upstream on a discovery request. | Read path hits a throttled provider on a user click; not cacheable. | Read **from store + Redis only**; only the write path fetches (`02` §read/write split). |

---

## 13. Output contract (grading rubric for an implementation of this channel)

An implementation of the catalog/discovery channel is **done** only if:

1. **The four endpoints exist with the SDK-mirrored taxonomy** — `/datasets` (list_groups),
   `/datasets/{id}/instruments` (list_instruments), `/search` (search_groups+search_instruments),
   `/datasets/{id}/filters` (get_group_filters) + `/datasets/{id}` (get_group_attributes), plus
   `/suggest` and `/facets`. All `GET`.
2. **Every filterable/sortable field is indexed server-side**, and exposing a facet whose column is
   unindexed fails CI. Filtering/sorting/ranking run in the DB query, never on the client.
3. **Pagination is correct per surface:** page/offset for the bounded `/datasets` and `/search`
   pages; **cursor/keyset** for `/datasets/{id}/instruments`; typeahead is top-N, never paginated.
   `has_more` + `next`/`next_cursor` present; `next_cursor` opaque and `null` on the last page.
4. **Search surfaces ranking** — `_score` + `sort=relevance|popularity`, typo-tolerant
   (`pg_trgm`), match-position-aware (`_match.rank`), with **CTR click events instrumented from day
   one**. It does not ship array order.
5. **`/suggest` is a separate prefix endpoint over a separate prefix index**, debounced ≈250 ms
   client-side, returning ≤10 lightweight rows with highlight.
6. **Every result card carries `Provenance{source, commercialOk, attribution}`** — default
   `false`, `true` only on a 🟢 ledger fetch path with rendered attribution, composite = AND of
   inputs. No card ships without it.
7. **`sparkline_hint` is a pointer**, not inlined data; the preview lazy-fetches from `/series`
   server-downsampled to ~the card's pixel width.
8. **Reads serve from store + Redis** (`getOrRefresh` + SWR), never fetch-through; responses carry
   `Cache-Control` + SWR headers. Unknown facet values → `422`.
9. **The R-SCALE tier is stated in writing** — Tier-2 today (server-side faceted filter + paginate +
   index + `pg_trgm`), Tier-3 path named (dedicated engine + ranking-by-stored-signals), and what
   breaks at the next tier (ranking quality, not throughput — `03` §Scale(a)).
10. **The layer boundary is respected** — this channel specifies the *wire contract*; it does not
    re-implement the GIN/`pg_trgm`/btree index, the BM25/`ts_rank` math, or the CTR store (those
    are `faceted-discovery-search`). A PR that inlines index internals here is mis-layered.

---

## 14. Where this ends and `faceted-discovery-search` begins (the one-line test)

> **This doc owns the *wire*: URLs, query params, status codes, the JSON card shape, pagination
> semantics, the provenance/sparkline contract, the endpoint taxonomy.**
> **`faceted-discovery-search` owns the *index*: the GIN/`pg_trgm`/btree build, the `tsvector`
> weighting, the matching+ranking (BM25/`ts_rank`) function, the prefix/FST autocomplete index,
> and the CTR-signal store.**

If the question is *"what does the response look like / what params does the client send / page or
cursor?"* → **this doc**. If it is *"how do I make `?region=us` an index hit / how does
`samsng→Samsung` work / how is `_score` computed / how do I rank by CTR?"* →
**`faceted-discovery-search`**. The contract here states the *guarantees the index must satisfy*
(every facet indexed; ranking surfaced; typo-tolerant; prefix-separate); that skill *delivers*
them. Keep them apart: a wire change shouldn't force an index rebuild, and an index swap
(Postgres → Elasticsearch/Typesense at Tier-3) shouldn't change a single byte of this contract.

---

## References (sources read this run)

- **JPM `dataquery-sdk`** — discovery method taxonomy + params + rate-limit defaults (verbatim):
  [github.com/jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk).
- **macrosynergy client** — `CATALOGUE_ENDPOINT="/group/instruments"`, `page_size 1..1000`,
  `links[1].next` recursive pagination, `API_DELAY_PARAM`/`API_RETRY_COUNT` (source-level):
  [docs.macrosynergy.com/.../dataquery.html](https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html).
- **JPM DataQuery product page** — 4 delivery channels, 650 datasets / 130m+ series, addressing
  model: [jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery);
  asset-class facet vocabulary:
  [markets.jpmorgan.com/data-and-analytics/data-content](https://markets.jpmorgan.com/data-and-analytics/data-content);
  [developer.jpmorgan.com/products/dataquery_api](https://developer.jpmorgan.com/products/dataquery_api).
- **FRED `series/search` + `category/*`** — `search_text`/`search_type`, `order_by`
  ∈ {`search_rank`,`popularity`,`last_updated`,`group_popularity`}, `filter_variable`
  ∈ {`frequency`,`units`,`seasonal_adjustment`}, `limit` 1..1000, `offset`, category endpoints:
  [fred.stlouisfed.org/docs/api/fred/series_search.html](https://fred.stlouisfed.org/docs/api/fred/series_search.html);
  [fred.stlouisfed.org/docs/api/fred/category_series.html](https://fred.stlouisfed.org/docs/api/fred/category_series.html).
- **Pagination conventions** — cursor vs offset, `next_cursor` opaque/`null`-on-last,
  `has_more`, the deep-offset cost, "cursor is the public-API default":
  [getknit.dev/blog/api-pagination-best-practices](https://www.getknit.dev/blog/api-pagination-best-practices);
  [speakeasy.com/api-design/pagination](https://www.speakeasy.com/api-design/pagination);
  [milanjovanovic.tech/.../understanding-cursor-pagination](https://www.milanjovanovic.tech/blog/understanding-cursor-pagination-and-why-its-so-fast-deep-dive).
- **Postgres FTS / `pg_trgm` / prefix typeahead** — `websearch_to_tsquery`, `ts_rank` A>B>C>D,
  `to_tsquery(':*')` prefix, `pg_trgm` `%` typo-tolerance:
  [postgresql.org/docs/current/pgtrgm.html](https://www.postgresql.org/docs/current/pgtrgm.html);
  [viprasol.com/blog/postgres-full-text-search-advanced](https://viprasol.com/blog/postgres-full-text-search-advanced/).
- **Separate autocomplete index** — Elasticsearch Completion Suggester (FST, separate index,
  prefix-only):
  [Elastic completion suggester](https://medium.com/@taranjeet/elasticsearch-using-completion-suggester-to-build-autocomplete-e9c120cf6d87).
- **In-repo** — `03-dataquery-system-design.md` (the `/catalog` contract + R-SCALE §Scale(a)),
  `02-skills-and-pipeline.md` (the `faceted-discovery-search` skill outline + read/write split),
  `.claude/rules/product-at-scale.md`, `.claude/rules/commercial-ok-gate.md`,
  `.claude/rules/red-team-negation-loop.md`.
```
