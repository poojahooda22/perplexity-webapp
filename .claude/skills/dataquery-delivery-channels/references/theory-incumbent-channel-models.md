# theory · Incumbent Channel Models — the primary-source teardown

> **What this doc is.** The grounding reference the whole `dataquery-delivery-channels` skill cites.
> Before we design our own four-channel delivery surface (Web · API · Batch · Excel) for the
> **JPM-Markets re-engineering data-analytics product line (NOT Lumina)**, we read what the real
> incumbents shipped — J.P. Morgan DataQuery itself, plus FRED, the World Bank, LSEG Tick-History,
> and Bloomberg BLPAPI — at the *source level*: their published method catalogs, their actual client
> code, their endpoint shapes. Every design choice in `patterns-*.md` is anchored to one of these
> shipped references rather than invented. When a `patterns-*` recipe says "expose a JSON
> point-query and a separate file-delivery surface over one auth client," **this** is the doc that
> proves real products do exactly that.
>
> **Scope note (from `cto-rules.md`).** This product line re-engineers JPM-Markets internal products
> into our own, better. It is a *separate product line*, NOT a feature of Lumina (the Bun + Express
> Perplexity-style app this repo also hosts). Nothing here wires into Lumina's app code. The stack is
> the new Python/FastAPI/data-engineering line.

---

## Evidence tiering — read this first

Every load-bearing claim in this doc carries one of three tags. The rule is from `cto-rules.md`:
**ground every empirical/version/behavior claim, or mark it `[unverified]` and name what would verify it.**

| Tag | Meaning | What earns it |
|---|---|---|
| **`[verified]`** | Read this run from a primary source — the actual published doc, page, or repo. | A URL + an excerpt I quoted, or a `repo:file` I read the contents of. |
| **`[inferred]`** | Not stated verbatim anywhere, but follows from two+ primary observations by first-principles reasoning, with the reasoning shown. | The observations are each `[verified]`; the *bridge* between them is mine and flagged. |
| **`[unverified]`** | Could not confirm from a primary source this run (auth-walled portal, binary PDF, 403). Named so a future pass can close it. | I state exactly what doc would verify it. |

**A standing trap this doc enforces (and the skill inherits):** a *client-side self-throttle is not an
enforced server quota.* When the macrosynergy client sleeps 200–250 ms between requests, or the JPM SDK
defaults to "300 req/min, 5 req/s burst," that is the **client being polite**, not proof of what the
server enforces. The server's real limit is invisible from the outside (you only discover it by getting
`429`'d). Every "rate limit" figure below is tagged for *which side* it lives on. Conflating the two is
exactly the kind of "scalability surface with no derived ceiling" the red-team loop (`R70`, goal Q2)
exists to catch.

---

## 0. The one-paragraph thesis (the on-ramp)

Every serious financial-data product exposes **the same logical data twice, through different doors**,
because two different consumers want it two different ways. A human exploring or a notebook pulling a
handful of series wants a **synchronous point query**: "give me these expressions, this date range,
as JSON, now." A production system that needs the *whole* dataset every morning wants an **asynchronous
bulk job**: "prepare the full file, tell me when it's ready, I'll pull it." DataQuery names these the
**JSON Data API** and the **File Delivery API** and runs them over **one OAuth client**. FRED splits them
into `series/observations` (point) and there is no bulk door at all (it's small). LSEG Tick-History makes
the bulk door an explicit **on-demand-or-scheduled extraction job** with a `202 → poll → 302-to-S3`
lifecycle. Bloomberg splits **request/response** (`//blp/refdata`) from **streaming subscription**
(`//blp/mktdata`). Learn the *mechanism* — point-query vs bulk-job vs stream, over one auth — not the
vendor. That mechanism is what our four channels re-implement.

---

## 1. J.P. Morgan DataQuery — the product we are re-engineering

### 1.1 The four verbatim channels

From the product page `jpmorgan.com/markets/dataquery`, the four delivery channels are named and described
verbatim as **`[verified]`** (fetched this run):

1. **DataQuery Web** — *"all on-demand via DataQuery Web"*: explore, construct pre-trade analysis, and
   build custom visualizations interactively.
2. **DataQuery API** — *"Seamlessly discover, navigate and download the complete data catalog using the
   DataQuery REST API."*
3. **DataQuery Batch** — *"automate the delivery of your data with DataQuery Batch"* via **"SFTP and
   email."**
4. **DataQuery Excel** — *"integrate DataQuery data directly into your workbooks, analysis and models"*
   via an **"Excel add-in."**

> Source: WebFetch of `https://www.jpmorgan.com/markets/dataquery` (this run). The four channel names
> ("DataQuery Web", "DataQuery API", "DataQuery Batch", "DataQuery Excel") and the SFTP/email + Excel
> add-in phrasing are quoted verbatim from that page.

These map **one-to-one** onto the four channels this skill teaches you to build. That is not a
coincidence we engineered — it is the shipped reference we are matching.

### 1.2 The verified scale stats — and the discrepancy we are NOT papering over

The same product page (`jpmorgan.com/markets/dataquery`) states, verbatim **`[verified]`**:

| Stat | Verbatim value | Source |
|---|---|---|
| Datasets | **"650 Datasets"** | `jpmorgan.com/markets/dataquery` |
| Historical time series | **"130m+ Historical timeseries"** | `jpmorgan.com/markets/dataquery` |
| Active users | **"15,000 Active users on the platform"** | `jpmorgan.com/markets/dataquery` |
| Batch files/day | **"350+ Batch files delivered per day"** | `jpmorgan.com/markets/dataquery` |
| API traffic | **"4 billion+ Hits per year – 75% API"** | `jpmorgan.com/markets/dataquery` |

**The unresolved discrepancy (flagged, not resolved).** A *different* J.P. Morgan page,
`jpmorgan.com/securities-services/data-analytics`, says verbatim **`[verified]`**:

> *"Drive your investment insights using J.P. Morgan's data marketplace with **over 50 million time
> series** accessible on the web, desktop, excel, batch and modern APIs."*

So two J.P. Morgan-owned pages give **two different time-series counts for the same platform**:
**130m+** (the `markets/dataquery` product page) vs **over 50 million** (the
`securities-services/data-analytics` marketplace page). A third page,
`markets.jpmorgan.com/data-and-analytics`, gives only *"500+ cross-asset datasets"* (vs the 650 on the
product page) and **no time-series count at all** **`[verified]`** (fetched this run).

**The honest verdict (`cto-rules.md` §3: "if the picture stays ambiguous, the ambiguity IS the finding"):**

- These are **not reconcilable from public sources.** Plausible reasons (each `[inferred]`, none confirmed):
  the 50m and 130m pages were published at different times and the platform grew; "time series" is counted
  differently (a *base* series vs a *base × derived-expression* expansion — DataQuery's expression language
  can synthesize derived series, so "130m+" may count expressible series while "50m" counts stored base
  series); or the marketplace page (`securities-services`) describes a broader/narrower product cut than the
  `markets` product page.
- **The rule for us:** when we cite DataQuery's scale, **cite the page and the number together** ("130m+ per
  the product page; 50m+ per the marketplace page") and never silently pick one. A red-team negator
  (`R70`, hunt catalogue: "hallucinated metric") would land a CRITICAL on any doc that asserts a single
  bare number as fact. The discrepancy is the finding; the resolution is `[unverified]` and would require a
  JPM-internal data-dictionary we cannot read.

> Prior art in this repo's memory already caught two *other* refuted JPM stats (~800 not 1,000 analysts;
> 130m not 13m time-series) — see `jpm-markets-platform-deep-research`. This is the same discipline: the
> "13m" typo elsewhere and the "50m vs 130m" split here both die if you ground every number to its page.

### 1.3 Why the stats matter for *our* design (the scale read)

The stats are not trivia — they set the **tier targets** (`product-at-scale.md` / R-SCALE) our channels
must survive:

- **650 datasets · 50–130m series** → the catalog is a *list/search surface at the 10,000× tier*. Nobody
  "browses 130m series." Discovery must be **server-side search over a catalog index**, not a client-side
  scan. (This is why the JSON Data API has `search_groups`/`search_instruments` — see §1.5.)
- **"4 billion+ hits/year – 75% API"** → ≈ **127 hits/second average** across the year **`[inferred]`**
  (4e9 ÷ 31.5e6 s ≈ 127/s; arithmetic shown), and *spike* traffic (market open, a data-release minute) is
  far above the average. So the read surface is a genuine **read-spike** surface — compute-once-serve-many,
  cache the catalog and hot series, never recompute per request. The 75%-API split says **the API, not the
  Web UI, is the dominant load** — the API is the product, the UI is a thin client over it.
- **"350+ batch files/day"** → bulk delivery is **scheduled, off the request path** — a cron/worker
  concern, exactly the kind of heavy job that must NOT sit on a serverless request (the same boundary
  Lumina's non-negotiable #4 enforces, re-derived here for the Python line).

### 1.4 The official SDK: `jpmorganchase/dataquery-sdk` (read this run)

This is the **canonical contract** — JPMorgan's own open-source Python client. **`[verified]`** from the
repo README (`github.com/jpmorganchase/dataquery-sdk`, fetched this run):

| Property | Value | Source |
|---|---|---|
| License | **MIT** | repo README/LICENSE |
| Python | **3.12+** (mandatory) | README |
| Core deps | `aiohttp>=3.8,<4`, `pydantic>=2,<3`, `structlog>=23`, `python-dotenv>=1` | README |
| Optional | `pandas>=2` → `.to_dataframe()` | README |
| Concurrency model | **async-first** (`aiohttp`); every method has a sync counterpart (drop `_async`) | README |

**Authentication — one OAuth client for both APIs.** Configured via env: `DATAQUERY_CLIENT_ID` +
`DATAQUERY_CLIENT_SECRET` (OAuth2 **client-credentials** grant), or a static `DATAQUERY_BEARER_TOKEN` with
`DATAQUERY_OAUTH_ENABLED=false`, or passed directly: `DataQuery(client_id="...", client_secret="...")`
**`[verified]`**. The crucial architectural fact: **the JSON Data API and the File Delivery API are
methods on the same `DataQuery` object and share one authenticated session.** One token, two doors.

```python
# jpmorganchase/dataquery-sdk — quickstart (verbatim from README, [verified])
import asyncio
from dataquery import DataQuery

async def main():
    async with DataQuery() as dq:                 # one OAuth client...
        groups = await dq.list_groups_async(limit=5)   # ...JSON Data API door
        for g in groups:
            print(g.group_id, "—", g.group_name)

asyncio.run(main())
```

#### 1.4.1 JSON Data API — the method catalog (point queries + discovery)

All `[verified]` from the README method table (sync counterparts drop `_async`):

| Method | Signature (verbatim) | Returns / role |
|---|---|---|
| `list_groups_async` | `list_groups_async(limit)` | the group (dataset) list |
| `search_groups_async` | `search_groups_async(keywords, limit, offset)` | keyword-filtered groups — **server-side search, paginated** |
| `list_instruments_async` | `list_instruments_async(group_id, instrument_id=None, page=None)` | instruments within a group |
| `search_instruments_async` | `search_instruments_async(group_id, keywords, page=None)` | keyword-filtered instruments |
| `get_group_attributes_async` | `get_group_attributes_async(group_id, ...)` | attribute metadata for a group |
| `get_group_filters_async` | `get_group_filters_async(group_id, page=None)` | the filter facets available on a group |
| `get_expressions_time_series_async` | `get_expressions_time_series_async(expressions, start_date, end_date)` | **JSON time series for explicit expressions** |
| `get_instrument_time_series_async` | `get_instrument_time_series_async(instruments, attributes, start_date, end_date)` | time series by instrument × attribute |
| `get_group_time_series_async` | `get_group_time_series_async(group_id, attributes, filter, start_date, end_date)` | time series for a whole filtered group |
| `get_grid_data_async` | `get_grid_data_async(expr=None, grid_id=None, date=None)` | a snapshot **grid** (cross-section at a date) |

**The three-level addressing hierarchy** — this is the load-bearing design idea, **`[verified]`** from the
DataQuery API description (*"extract market data at the dataset, instrument and expression level"*):

```
GROUP (dataset, e.g. "JPMAQS_GENERIC_RETURNS")          ← list_groups / search_groups
  └─ INSTRUMENT (a tradeable/observable within the group) ← list_instruments / search_instruments
       └─ EXPRESSION (instrument × attribute, e.g.        ← get_expressions_time_series
            DB(JPMAQS,USD_EQXR_VT10,value) )
```

You can request a time series **at any of the three levels**: by raw expression (most precise), by
instrument+attribute (the SDK composes the expressions for you), or by whole group+filter (bulk-ish, still
JSON). This is the discovery/retrieval taxonomy our catalog must mirror: **dataset → series → point.**

#### 1.4.2 File Delivery API — the method catalog (bulk jobs)

All `[verified]` from the README:

| Method | Signature (verbatim) | Role |
|---|---|---|
| `list_files_async` | `list_files_async(group_id, file_group_id=None)` | what files exist for a group |
| `list_available_files_async` | `list_available_files_async(group_id, file_group_id, start_date, end_date)` | which files are ready in a date range |
| `check_availability_async` | `check_availability_async(file_group_id, file_datetime)` | is *this* file (this datetime) ready yet? |
| `download_file_async` | `download_file_async(file_group_id, file_datetime, ...)` | single **streaming** download |
| `run_group_download_async` | `run_group_download_async(group_id, start_date, end_date, file_group_id=None, ...)` → `OperationReport` | download all files for a group/range; returns a structured report |
| `download_historical_async` | chunked historical backfill (monthly ranges) | the big backfill |
| `auto_download_async` | `auto_download_async(group_id, destination_dir, file_group_id=None, ...)` → manager | **SSE push-driven** continuous delivery |

**The `auto_download` / SSE channel** is the most interesting and the least obvious — **`[verified]`**:

- Subscribes to the **`/events/notification`** Server-Sent-Events stream for **push-driven** file delivery
  (the server tells the client "a new file landed," instead of the client polling).
- **Initial backfill:** on startup, checks availability for the current day (`initial_check=True` default).
- **Event replay / resume:** the last SSE event ID persists to
  `<destination>/.sse_state/sse_<fingerprint>.json`; a restart resumes from the prior session (so you don't
  re-download or miss files across a crash).
- **Reconnection:** exponential backoff between `reconnect_delay=5s` and `max_reconnect_delay=60s`.
- **Health stats:** `manager.get_stats()` → notifications, downloads, files skipped/failed, last event ID,
  and an error ring.

```python
# auto_download — SSE push delivery (verbatim shape from README, [verified])
await dq.auto_download_async(
    group_id="JPMAQS_GENERIC_RETURNS",
    destination_dir="./downloads",
)   # subscribes to /events/notification, resumes from .sse_state, backs off 5s..60s
```

This is the reference for a **push/event Batch sub-mode** — the "tell me when the file is ready" pattern
that beats blind polling. Our Batch channel design should offer the same: SFTP/email *plus* an
event/webhook signal.

#### 1.4.3 The SDK's *client-side* knobs — and the throttle-vs-quota trap

The README documents these **defaults** (env-overridable), all **`[verified]`**:

| Knob | Default | Side |
|---|---|---|
| `DATAQUERY_REQUESTS_PER_MINUTE` | **300** | **client self-throttle** |
| `DATAQUERY_BURST_CAPACITY` | **5 req/s** | **client self-throttle** |
| `DATAQUERY_MAX_RETRIES` | 3 | client |
| `DATAQUERY_RETRY_DELAY` | 1.0 s | client |
| `DATAQUERY_TIMEOUT` | 600.0 s | client (long, because bulk files) |
| `DATAQUERY_CIRCUIT_BREAKER_THRESHOLD` | 5 | client |
| `DATAQUERY_POOL_CONNECTIONS` / `_POOL_MAXSIZE` | 10 / 20 | client (aiohttp pool) |

The SDK *"automatically inserts delays between file starts"* and exposes `dq.get_rate_limit_info()`.

> **The trap, stated plainly:** "300 req/min, 5 req/s" is **the client's own ceiling that it imposes on
> itself to be a good citizen.** It is *not* documentation of the server's enforced quota. The real
> server limit is unstated in any source I read this run; you discover it empirically (a `429` /
> `Retry-After`). **`[unverified]`** — what would verify the *server* quota: the JPM Developer Portal's
> rate-limit page behind the auth wall, or an observed `429` from production traffic. **Our design must
> assume the server enforces its own limit and handle `429` with backoff — never trust that staying under
> 300/min is "safe" just because the SDK defaults to it.**

### 1.5 The community client: `macrosynergy` (the source-readable contract)

JPMorgan's developer portal (`developer.jpmorgan.com/products/dataquery_api`) is **auth-walled** — it
returned only navigation chrome, no endpoint docs **`[verified]`** (fetched this run; got Register/Login
links only). So the **only fully source-readable specification of the wire contract** is the Macrosynergy
community client, which exists in **two variants** I read this run:

**Variant A — `macrosynergy/dataquery-api` (`dataquery_api.py`), `[verified]`:**

```python
# Constants read verbatim from macrosynergy/dataquery-api/dataquery_api.py (this run)
OAUTH_BASE_URL      = "https://api-developer.jpmorgan.com/research/dataquery-authe/api/v2"
TIMESERIES_ENDPOINT = "/expressions/time-series"
HEARTBEAT_ENDPOINT  = "/services/heartbeat"
CATALOGUE_ENDPOINT  = "/group/instruments"
OAUTH_TOKEN_URL     = "https://authe.jpmchase.com/as/token.oauth2"
OAUTH_DQ_RESOURCE_ID= "JPMC:URI:RS-06785-DataQueryExternalApi-PROD"
API_DELAY_PARAM     = 0.2     # 200 ms between requests — CLIENT self-throttle
TOKEN_EXPIRY_BUFFER = 0.9     # refresh at 90% of token lifetime
EXPR_LIMIT          = 20      # max expressions per request
MAX_RETRY           = 3
MAX_CONSECUTIVE_FAILURES = 5
```

Class: `DQInterface`. Usage **`[verified]`** (README):

```python
from dataquery_api import DQInterface
dq = DQInterface(client_id, client_secret)
data = dq.download(expressions=expressions, start_date=start_date, end_date=end_date)
# returns a pandas DataFrame; expressions like "DB(JPMAQS,USD_EQXR_VT10,value)"
```

**Variant B — `macrosynergy/macrosynergy` (`macrosynergy/download/dataquery.py`), `[verified]`:** the
production package, with **two auth modes**:

```python
# Constants read verbatim from macrosynergy/macrosynergy/download/dataquery.py (this run)
CERT_BASE_URL  = "https://platform.jpmorgan.com/research/dataquery/api/v2"           # cert auth
OAUTH_BASE_URL = "https://api-developer.jpmorgan.com/research/dataquery-authe/api/v2" # oauth auth
OAUTH_TOKEN_URL= "https://authe.jpmchase.com/as/token.oauth2"
API_DELAY_PARAM = 0.25    # 250 ms — CLIENT self-throttle (note: differs from Variant A's 0.20)
TOKEN_EXPIRY_BUFFER = 0.9
API_RETRY_COUNT = 5
HL_RETRY_COUNT  = 5       # "high-level" retry count
MAX_CONTINUOUS_FAILURES = 5
HEARTBEAT_ENDPOINT  = "/services/heartbeat"
TIMESERIES_ENDPOINT = "/expressions/time-series"
CATALOGUE_ENDPOINT  = "/group/instruments"
# batch_size: int = 20   (range 1..20 inclusive)
```

Classes: `DataQueryInterface` (high-level), `DataQueryOAuth` (OAuth handler), `DataQueryCertAuth`
(certificate handler — `username`/`password`/`crt`/`key` file paths). Downloads use
`concurrent.futures.ThreadPoolExecutor()` with `tqdm` progress **`[verified]`**.

#### 1.5.1 The four contract facts every consumer of this skill must internalize

From reading both clients' source, these are the **`[verified]`** behaviors of the real DataQuery wire:

1. **`EXPR_LIMIT = 20` — 20 expressions per HTTP request, hard.** Both clients batch a request list into
   chunks of ≤20 and loop. This is a **server-imposed payload cap** (the client doesn't choose 20 for fun —
   it chunks *to* 20 because the endpoint rejects more). This is the one number that is plausibly a real
   server constraint, not a self-throttle — **`[inferred]`**: two independent clients hard-code the same 20
   and both *split to fit it*, which only makes sense if the server enforces it. (Still `[unverified]` as an
   absolute server fact — what would verify: an observed 4xx on a 21-expression request.)

2. **Pagination via `links`.** A response carries a `links` array; if `response["links"][1]["next"]` is not
   `null`, the client recursively fetches the next page and concatenates. **`[verified]`** (both clients):
   `if 'links' in response and response['links'][1]['next'] is not None: ...`. **This is the canonical
   "follow the next-link" cursor pattern** — note it is the *second* element (`[1]`) of `links` that holds
   `next` (element `[0]` is conventionally `self`). Our JSON channel should emit the same shape.

3. **OAuth2 client-credentials, with a refresh buffer.** Token obtained by `POST` to `OAUTH_TOKEN_URL` with
   `grant_type=client_credentials`; the client stores `created_at` and `expires_in` and refreshes when
   `now > created_at + expires_in * TOKEN_EXPIRY_BUFFER` (0.9) — i.e. **refresh at 90% of lifetime**, never
   wait for an actual expiry mid-flight **`[verified]`**. The cert variant adds a mutual-TLS option for
   clients that can't do bearer tokens.

4. **The throttles are client-chosen and *inconsistent across clients*.** Variant A sleeps **200 ms**
   (`API_DELAY_PARAM=0.2`); Variant B sleeps **250 ms** (`0.25`); the JPM SDK uses a 300/min + 5/s limiter.
   **Three clients, three different self-throttle values for the same server.** This is the clinching proof
   that **the throttle is the client's politeness, not the server's quota** — if it were the server quota,
   all three would converge on it. Internalize this: *when you see a `sleep()` in a data client, it is the
   client guessing at a safe rate, not a documented contract.*

> **`[unverified]` cluster on the DataQuery wire** (auth wall): the exact JSON response schema of
> `/expressions/time-series`; the precise `429`/`Retry-After` server behavior; the full File Delivery
> endpoint paths (the SDK exposes *methods*, not the raw routes); whether `/group/filters` and `/grid`
> have stable public paths. What would verify: an authenticated session against the JPM Developer Portal,
> which we do not have. The *method catalog* (§1.4) and the *three endpoints + constants* (§1.5) are the
> firm ground; the raw JSON bodies are not.

---

## 2. FRED — the canonical two-endpoint parameter shape

FRED (Federal Reserve Bank of St. Louis) is the **public-domain reference** for *how a clean point-query
API is parameterized* (`[verified]` via search of the official docs; the docs pages 403 WebFetch directly
but the St. Louis Fed text is quoted in results). It is the simplest correct version of the JSON Data API
door, and **public-domain → `commercialOk` GREEN** (17 USC §105 — U.S. government work), which matters for
our licensing discipline (`commercial-ok-gate.md`).

### 2.1 The split: discovery vs observation

FRED separates **finding a series** from **reading its values** into two endpoints — the exact split
DataQuery makes between `search_instruments` and `get_expressions_time_series`:

| Endpoint | Role | Key params (`[verified]` from St. Louis Fed docs) |
|---|---|---|
| `fred/series/search` | **discovery** — match series by text | `search_text` (required), `realtime_start`, `realtime_end`, `limit`, `offset`, `order_by`, `sort_order`, `file_type` (xml\|json, **default xml**) |
| `fred/series` | **metadata** — one series' attributes | `series_id` (required), `realtime_start`, `realtime_end`, `file_type` |
| `fred/series/observations` | **the data** — the actual values | see table below |

### 2.2 `fred/series/observations` — the canonical parameter table

This is **the** reference shape for a time-series point query. All `[verified]` from the St. Louis Fed
`series_observations` docs (via search; the text is the official endpoint reference):

| Param | Default | Allowed / notes |
|---|---|---|
| `series_id` | — (required) | the series ID |
| `observation_start` | `1776-07-04` (earliest) — the *request* default is "today" per the docs text, but the data floor is the series start | `YYYY-MM-DD` |
| `observation_end` | `9999-12-31` (latest) | `YYYY-MM-DD` |
| `units` | `lin` | **`lin`** (levels, no transform), `chg` (change), `ch1` (change-from-year-ago), `pch` (% change), `pc1` (% change YoY), `pca` (compounded annual rate of change), `cch`, `cca`, `log`. **This is the server-side transform menu** — the API computes the derivative so the client doesn't. |
| `frequency` | (native) | `d` daily, `w` weekly, `bw` biweekly, `m` monthly, `q` quarterly, `sa` semiannual, `a` annual (+ weekly/biweekly ending-day variants) — **server-side resampling** |
| `aggregation_method` | `avg` | `avg` (average), `sum`, `eop` (end of period) — how to collapse when downsampling frequency |
| `output_type` | `1` | `1` observations by realtime period, `2` all vintages, `3` new+revised, `4` initial release only — **the ALFRED point-in-time vintages** |
| `file_type` | `xml` | `xml`, `json`, `txt`, `xlsx`, `csv` (zipped) — **format negotiation as a param, not a header** |
| `realtime_start` / `realtime_end` | today / today | `YYYY-MM-DD` — the **as-of / vintage** window (ALFRED: "what was known on date X") |
| `limit` | `100000` | 1..100000 — **pagination** |
| `offset` | `0` | pagination cursor |
| `sort_order` | `asc` | `asc` \| `desc` |

```
# A canonical FRED observation request ([verified] param shape):
https://api.stlouisfed.org/fred/series/observations
    ?series_id=GNPCA
    &observation_start=2000-01-01
    &units=pch                  # server computes % change
    &frequency=q                # server resamples to quarterly
    &aggregation_method=eop     # ...using end-of-period
    &file_type=json
    &api_key=YOUR_KEY
```

### 2.3 The four design lessons FRED hands us for free

1. **Transforms belong on the server (`units`).** The client should not be the place where "% change" or
   "year-over-year" is computed — FRED computes 9 transforms server-side. Our JSON channel should expose a
   `units`-equivalent so a notebook never re-derives a transform (and so every consumer gets the *same*
   transform, not 12 subtly different client implementations).
2. **Frequency/aggregation are paired params.** You cannot offer `frequency=q` without
   `aggregation_method` — resampling daily→quarterly is ambiguous (mean? last? sum?) until the caller says.
   This is the contract our downsampling surface must copy.
3. **Format is a parameter (`file_type`), not (only) an `Accept` header.** FRED lets the *query* choose
   json/csv/xlsx. For a Web+API+Excel+Batch product, format-as-param is more discoverable than
   content-negotiation and is how a non-engineer in Excel asks for CSV.
4. **Vintages are first-class (`realtime_*`, `output_type`).** A finance-grade series API distinguishes
   "the value as it is now" from "the value as it was known on date X" (point-in-time / as-of). Backtests
   that ignore this leak future revisions — a look-ahead bias. FRED bakes it into every observation request;
   our store and API must carry an as-of axis too.

> Licensing note (`commercial-ok-gate.md`): FRED *series* are U.S.-government public-domain → GREEN. But
> FRED **redistributes** some third-party series (e.g. certain proprietary indices) under their owners'
> terms — *the license attaches to the underlying series' source, not to "FRED."* So "from FRED" is not a
> blanket GREEN; check the series' source attribution. This is the same fetch-path-not-concept rule the
> gate states.

---

## 3. World Bank Indicators — the envelope + pagination reference

The World Bank Indicators API is the **cleanest reference for a paginated catalog envelope** and is
**CC-BY 4.0** (attribution required, commercial OK with attribution → GREEN-with-attribution per the gate).

### 3.1 The URL grammar (`[verified]` from a live request this run)

```
https://api.worldbank.org/v2/country/{ISO}/indicator/{INDICATOR}?format=json&per_page=N&page=K
# e.g. .../country/all/indicator/NY.GDP.MKTP.CD?format=json&per_page=5
```

`country` can be `all`, an ISO code, or `;`-joined codes; `{INDICATOR}` is a dotted code
(`NY.GDP.MKTP.CD`). Pagination is `page` + `per_page`; format is `format=json` (XML default).

### 3.2 The two-part envelope (`[verified]` — the response I fetched)

The response is a **2-element array**: `[ <header>, <data[]> ]`.

```jsonc
// element [0] — the header / pagination block ([verified] from the live response):
{ "page": 1, "pages": 3512, "per_page": 5, "total": 17556,
  "sourceid": "2", "lastupdated": "2026-04-08" }

// element [1] — the data rows:
[ { "indicator":   { "id": "NY.GDP.MKTP.CD", "value": "GDP (current US$)" },
    "country":     { "id": "ZH", "value": "Africa Eastern and Southern" },
    "countryiso3code": "AFE",
    "date":  "2025",
    "value": null,            // null when unavailable — NOT zero, NOT omitted
    "unit":  "",
    "obs_status": "",
    "decimal": 0 } , ... ]
```

### 3.3 Lessons

1. **Separate the pagination header from the data array.** `page`/`pages`/`total` live in a header object,
   not smuggled into the rows or only in HTTP headers. A client can compute "fetch all pages" from
   `pages`/`total` without parsing rows. (Contrast FRED, which puts `count`/`offset`/`limit` as top-level
   JSON keys alongside `observations` — both are valid; pick one and be consistent.)
2. **`value: null` is the missing-data contract.** A gap is an explicit `null`, never a `0`, never a
   dropped row. Conflating "zero" with "missing" is a classic finance-data bug (a missing price ≠ a price of
   0). Our standard model must preserve `null`-as-missing end to end.
3. **`lastupdated` is a freshness stamp on the envelope.** Caching/SWR keys off it. Our cache layer should
   carry the upstream's `lastupdated` so a consumer knows the vintage of a cached page.

---

## 4. LSEG Tick-History — the on-demand-vs-scheduled extraction job (the Batch reference)

LSEG (formerly Refinitiv) DataScope Select / Tick-History is the **richest reference for the asynchronous
bulk-job lifecycle** — the pattern our Batch channel re-implements. It is **commercial/licensed → RED** for
display (we study the *mechanism*, not the data). All `[verified]` from `developers.lseg.com` (via search,
this run).

### 4.1 Two job kinds

- **On-Demand extractions** — *"occur immediately when requested, and can only be created using the REST
  API."* Synchronous-ish: if the report finishes within the **wait preference (default 30 s)**, it runs
  inline; otherwise it goes async (poll). **`[verified]`**
- **Scheduled extractions** — *"occur at a pre-defined moment in time which could be once-off, or
  recurring, and can be created using the website, or REST API."* This is the cron/recurring half — the
  direct analog of "350+ batch files/day." **`[verified]`**

This is the *exact* split DataQuery makes between `download_file` (on-demand) and the recurring batch
files — and the split our Batch channel must offer: **"run it now" vs "run it every morning at 06:00."**

### 4.2 The async job lifecycle (`[verified]`)

```
1. POST  /Extractions/ExtractRaw  (or a typed request,
         e.g. TickHistoryTimeAndSalesExtractionRequest)
         body: { IdentifierList: [{Identifier, IdentifierType:"Ric"}],
                 ContentFieldNames: [...], Condition: { date range, ... } }
   →  if it finishes within the wait preference: 200 OK with the result
   →  otherwise:                                  202 Accepted + a Location: header (the job URL)

2. POLL  GET <Location>      repeatedly
   →  202 while still running
   →  200 OK when done — body carries a JobId / the extracted-file reference

3. GET   the extracted file by JobId
   →  optionally with header  x-direct-download: true
       →  302 Found + Location: <a presigned AWS S3 URL>   ← download direct from S3, not LSEG servers
```

**The two mechanisms worth stealing:**

1. **`202 → poll the Location → 200` is the textbook async-job protocol.** The server returns `202 Accepted`
   with a `Location` header pointing at the job; the client polls that URL until `200`. *"the most likely
   response is a 202 Accepted status code with a location URL in the header... poll the location URL
   regularly until it returns a 200 OK"* **`[verified]`**. The **wait preference defaults to 30 s** — if the
   job is fast, it runs synchronously and you skip polling. This is the contract our Batch "run now" mode
   should expose verbatim.

2. **`x-direct-download: true` → `302` redirect to S3** offloads the actual bytes to the object store.
   *"add the header `x-direct-download` set to `true`... if the file is available on AWS, the status code
   will be 302 Found with the new AWS URL in the Location HTTP header field."* **`[verified]`**. The data
   never streams through the API servers — it streams from S3 (or our object store, e.g. the Python line's
   chosen blob store), which is the only way bulk delivery scales (the API box is not in the byte path).

### 4.3 Retention (`[verified]`)

> *"On-demand extractions expire after 7 days."*

A bulk artifact is **ephemeral** — a 7-day TTL on the prepared file. The job result is a *pointer to a
temporary object*, not a permanent download. Our Batch channel must mirror this: prepared files live in the
object store under a TTL/lifecycle rule, and the API hands out short-lived presigned URLs, not permanent
ones. (Also a cost control — you do not keep every prepared extract forever.)

### 4.4 The S3-direct factsheet variant

LSEG also sells **"Tick History S3 Direct"** — the customer's data lands in an LSEG-managed S3 bucket the
customer reads directly, no REST round-trip at all **`[verified]`** (`lseg.com/.../tick-history/s3-direct`).
That is the extreme of the same idea: for the very largest consumers, **the bulk channel IS the object
store** — you hand them a bucket, not an endpoint. Worth knowing as the 10,000×-tier endpoint of the Batch
design.

---

## 5. Bloomberg BLPAPI — the request/response vs subscription split (the streaming reference)

Bloomberg's BLPAPI is the **reference for the third axis we have not covered yet: streaming subscription
vs request/response.** DataQuery's JSON/File split is *pull* (point-query vs bulk-job); Bloomberg adds the
*push* axis (snapshot-request vs live-subscription). All `[verified]` from the BLPAPI core/developer guide
and the official `blpapi` docs (via search; the PDF itself is binary and would not parse via WebFetch —
flagged below). Bloomberg data is **strictly licensed → RED**; we study the *programming model*.

### 5.1 Two services, two paradigms (`[verified]`)

| Service | Paradigm | Use |
|---|---|---|
| **`//blp/refdata`** | **Request/Response** | reference, historical, intraday — *pull a snapshot, get a finite answer* |
| **`//blp/mktdata`** | **Subscription** | streaming real-time / delayed quotes — *open a stream, get ticks until you unsubscribe* |

> *"The streaming real-time market data service (`//blp/mktdata`) uses the Subscription paradigm, whereas
> the reference data service (`//blp/refdata`) uses the Request/Response paradigm."* **`[verified]`**

### 5.2 The four request types on `//blp/refdata` (`[verified]`)

| Request type | Returns |
|---|---|
| `ReferenceDataRequest` | current values for `securities × fields` (snapshot) |
| `HistoricalDataRequest` | a time series — params: `securities`, `fields`, `startDate`, `endDate`, `periodicitySelection` |
| `IntradayBarRequest` | intraday bars (OHLC over an interval) |
| `IntradayTickRequest` | every tick over a period |

### 5.3 The programming model — field selection + the event loop (`[verified]`)

```python
# BLPAPI request/response — the shape ([verified] from the core developer guide text)
session.openService("//blp/refdata")
svc = session.getService("//blp/refdata")
req = svc.createRequest("ReferenceDataRequest")
req.append("securities", "IBM US Equity")   # explicit security selection
req.append("fields", "LAST_PRICE")          # explicit FIELD selection — never "give me everything"
session.sendRequest(req)

while True:                                  # the event loop
    ev = session.nextEvent()
    for msg in ev:
        ...                                  # parse partial data
    if ev.eventType() == blpapi.Event.RESPONSE:
        break                                # RESPONSE = final; PARTIAL_RESPONSE = more coming
```

```python
# BLPAPI subscription — the streaming shape ([verified])
subs = blpapi.SubscriptionList()
subs.add("//blp/mktdata/ticker/IBM US Equity",
         fields="LAST_PRICE,BID,ASK")        # a subscription string: service + topic + fields
session.subscribe(subs)
# then the event loop delivers SUBSCRIPTION_DATA events until you unsubscribe
```

### 5.4 The three lessons Bloomberg hands us

1. **Explicit field selection is mandatory, both modes.** You *name* the securities and the fields — you
   never "select \*". This is bandwidth (and licensing) discipline: you fetch only the columns you'll use.
   Our JSON channel should require an explicit field/attribute list, not return every attribute by default
   (DataQuery's `get_instrument_time_series(instruments, attributes, ...)` does exactly this — `attributes`
   is required).
2. **`PARTIAL_RESPONSE` → `PARTIAL_RESPONSE` → `RESPONSE` is chunked streaming over a request/response
   door.** A large pull doesn't arrive in one message; it streams as partials with a terminal `RESPONSE`.
   This is the same idea as DataQuery's `links.next` pagination and the JSON Data API's streaming downloads
   — *the answer to a big query is a sequence, not a blob.* Design every "get a lot of data" path to stream.
3. **Subscription is a genuinely different channel, not a faster request.** A live tick stream
   (`//blp/mktdata`) is push, stateful, and infinite; a snapshot (`//blp/refdata`) is pull, stateless,
   finite. Do not model "real-time" as "request really fast in a loop." If our product ever needs live
   prices, that is a *fifth* channel (WebSocket/SSE subscription) on top of the four — and on a serverless
   front it cannot hold the socket (the same boundary Lumina pushes to a `worker/`). DataQuery's
   `auto_download` SSE (§1.4.2) is its lightweight version of this push axis.

> **`[unverified]` note on Bloomberg:** the core developer-guide **PDF** at
> `data.bloomberglp.com/.../BLPAPI-Core-Developer-Guide.pdf` is a 1.2 MB binary that WebFetch could not
> parse to text this run. The service names, paradigms, request types, and event-loop shape above are
> `[verified]` from the *search-surfaced* text of that guide and the official `bloomberg.github.io/blpapi-docs`
> reference — but the exact method signatures (argument order, every overload of `SubscriptionList.add`)
> are `[unverified]` from primary text this run. What would verify: parsing the PDF locally, or reading
> `bloomberg.github.io/blpapi-docs/python/latest/` page by page.

---

## 6. The cross-incumbent synthesis — the four channels, four ways

The whole point of reading five products is to extract the **invariant mechanism** so our design copies the
*proven* shape, not one vendor's accident. Here is the consolidated map.

### 6.1 The channel × incumbent matrix

| Our channel | DataQuery | FRED | World Bank | LSEG Tick-History | Bloomberg |
|---|---|---|---|---|---|
| **Web (interactive)** | DataQuery Web (on-demand explore/visualize) | fred.stlouisfed.org site | data.worldbank.org site | DataScope website | Terminal |
| **API (point query)** | JSON Data API (`get_expressions_time_series`, `links.next` paging, ≤20 exprs/req) | `series/observations` (+ `series/search`) | `/v2/country/.../indicator/...` (2-part envelope) | (REST is the bulk door; no separate light point API) | `//blp/refdata` `ReferenceDataRequest`/`HistoricalDataRequest` |
| **Batch (bulk/scheduled)** | File Delivery API (SFTP/email + `auto_download` SSE; `202`-style availability) | — (corpus is small; download-all is cheap) | — (small) | **Extractions: on-demand (REST) vs scheduled (recurring); `202→poll→302-to-S3`; 7-day TTL** | (B-PIPE / Data License — out of scope here) |
| **Excel** | DataQuery Excel add-in | (3rd-party add-ins) | (3rd-party) | DataScope Excel | Bloomberg Excel (`=BDP`/`=BDH`) |
| **Stream (push)** | `auto_download` SSE (`/events/notification`) | — | — | (real-time feeds, separate) | **`//blp/mktdata` subscription** |

### 6.2 The eight invariants every incumbent agrees on (the design contract)

These are the patterns that appear in **2+ independent products** read this run — which (per `cto-rules.md`
"cross-verify against ≥3 independent sources" where possible, ≥2 here) is the bar for promoting a pattern
from "one vendor did it" to "this is the proven shape." Each is `[verified]` across the cited products:

1. **One auth, multiple doors.** DataQuery runs the JSON Data API and File Delivery API over **one OAuth
   client** (§1.4); LSEG runs on-demand and scheduled over one DSS credential. → *Our four channels share
   one identity/token layer; the channel is the door, not a separate login.*

2. **Discovery is separate from retrieval, and discovery is server-side search.** DataQuery
   `search_groups`/`search_instruments`; FRED `series/search`; World Bank's indicator catalog. **Nobody
   ships the catalog to the client to filter.** → *Our catalog is a server-side search index (the 130m-series
   read demands it — R-SCALE 10,000× tier).*

3. **A three-level address: dataset → series → point.** DataQuery group→instrument→expression; FRED
   (implicit) release→series→observation; World Bank source→indicator→observation. → *Our addressing model
   is exactly this hierarchy.*

4. **Big answers stream / paginate; they never arrive as one blob.** DataQuery `links.next` + ≤20-expr
   batching; Bloomberg `PARTIAL_RESPONSE…RESPONSE`; World Bank `page`/`pages`. → *Every "get a lot" path is a
   cursor or a stream, with the pagination header separate from the data.*

5. **Bulk is an async job: submit → (maybe wait) → poll → fetch-from-object-store.** LSEG `202→poll→302-S3`,
   7-day TTL; DataQuery File Delivery + `check_availability` + `auto_download`. → *Our Batch channel is a job
   queue + object store + short-lived presigned URLs, NOT a synchronous "download the universe" endpoint.*

6. **Server-side transforms and resampling (don't make the client re-derive).** FRED `units` (9 transforms)
   + `frequency`/`aggregation_method`; DataQuery's expression language. → *Transforms live behind the API so
   every consumer gets the identical computation.*

7. **Missing data is explicit `null`/`unavailable`, never `0`, never a dropped row; and a freshness stamp
   travels with the data.** World Bank `value: null` + `lastupdated`; FRED `realtime_*` vintages. → *Our
   standard model preserves `null`-as-missing and carries an as-of/freshness axis end to end* (and a failed
   fetch returns typed `unavailable`, never a fabricated value — the same non-negotiable Lumina enforces).

8. **The object store, not the API box, is in the byte path for bulk.** LSEG `x-direct-download → 302 →
   S3`; LSEG "S3 Direct." → *Our Batch bytes flow from blob storage via presigned URL; the API only ever
   hands out the pointer.*

### 6.3 Where the incumbents *differ* — the choices left to us

These are **not** invariants; the products disagree, so each is a real decision (and a place a red-team
negator will ask "why this and not that?"):

- **Format negotiation: query param (`file_type`, FRED) vs header (`Accept` / `x-direct-download`, LSEG).**
  FRED's param-driven format is friendlier to non-engineers (Excel, a URL in a browser); a header is
  cleaner REST. **`[inferred]` recommendation:** offer both — `?format=` for the Web/Excel ergonomics,
  `Accept` for the API purists — but normalize to one internal representation.
- **Self-throttle value: 200 ms vs 250 ms vs 300/min+5/s.** Three DataQuery clients, three answers (§1.5.1)
  — proving none is canonical. **Our client must read the server's `429`/`Retry-After` and adapt, not
  hard-code a guess.**
- **Pagination key position: `links[1].next` (DataQuery) vs top-level `next`/`offset` (FRED) vs header
  object (World Bank).** All work; **`[inferred]`** pick the World Bank shape (pagination header object
  separate from data array) as the clearest for a fresh API.
- **Push axis: SSE (DataQuery `auto_download`) vs native subscription protocol (Bloomberg `//blp/mktdata`).**
  For our stack, **SSE/WebSocket** is the pragmatic choice (it rides plain HTTP and our Python service can
  serve it from a long-lived worker, not the serverless front).

---

## 7. The licensing overlay (because every "what to display" question is a license question)

This doc studies *mechanisms*; the **`commercialOk` gate** (`commercial-ok-gate.md`) governs whether the
*data* may be displayed. The fetch-path-not-concept rule applies to every incumbent above:

| Source | Display verdict | Why (`[verified]` reasoning) |
|---|---|---|
| **FRED** (U.S.-gov series) | 🟢 GREEN | 17 USC §105 public domain — **but** FRED redistributes some third-party series under *their* owners' terms; check the series' source, not "FRED." |
| **World Bank Indicators** | 🟢 GREEN-with-attribution | CC-BY 4.0 — commercial OK *if* attribution is rendered on the surface. |
| **DataQuery** | 🔴 RED (paid product) | A purchased JPM subscription is a *use* license, not a blanket *redistribution/display* license — and we are re-engineering the product, not reselling its data. Study the API shape; never redisplay JPM-sourced numbers. |
| **LSEG Tick-History** | 🔴 RED | Strictly licensed market data — study the `202→S3` mechanism, never the data. |
| **Bloomberg** | 🔴 RED | The most restrictive ToS in the industry — study BLPAPI's programming model only. |

**The contamination rule restated:** a composite that mixes a GREEN input and a RED input is **RED** — the
RED license contaminates the output. So a "market dashboard" blending FRED (green) with a Bloomberg field
(red) cannot claim `commercialOk: true`. This is exactly the trap `R70` goal **F2** hunts.

---

## 8. What we still cannot verify (the honest open-questions ledger)

Per `cto-rules.md` §3 ("if the picture stays ambiguous, the ambiguity is the finding") and the confidence
discipline (no uniform high-confidence on a non-trivial study), the open items:

| # | Open question | Why unresolved this run | What would close it |
|---|---|---|---|
| 1 | **50m vs 130m vs (no count)** time-series — the canonical DataQuery size. | Three JPM pages, three answers (§1.2); not reconcilable publicly. | A JPM-internal data-dictionary / the platform's own metrics page (auth-walled). |
| 2 | The **server-enforced** rate limit (vs the three client self-throttles). | No source states the server quota; clients only self-throttle. | An observed `429`/`Retry-After` from production, or the auth-walled Developer-Portal rate page. |
| 3 | The **raw JSON response schema** of `/expressions/time-series` and the File Delivery endpoint *paths*. | `developer.jpmorgan.com/products/dataquery_api` is auth-walled (nav-only this run); the SDK exposes methods, not routes. | An authenticated portal session, or capturing a real response body. |
| 4 | Whether **`EXPR_LIMIT=20`** is a hard server cap or a client convention. | Two clients hard-code 20 and *split to it* (`[inferred]` server cap), but no doc states it. | A 21-expression request observing a 4xx. |
| 5 | Bloomberg BLPAPI **exact method signatures / overloads.** | The core-guide PDF is binary (un-parsed this run); only prose/paradigm verified. | Parsing the PDF locally or reading `bloomberg.github.io/blpapi-docs` page-by-page. |
| 6 | LSEG's **exact typed-request bodies** (full field list of `TickHistoryTimeAndSalesExtractionRequest`). | Verified the *shape* (`IdentifierList`/`ContentFieldNames`/`Condition`) and lifecycle, not every field. | The DSS REST API reference under `developers.lseg.com` (some pages auth-gated). |

**Confidence summary.** *High:* the four DataQuery channel names; the JSON/File method catalog and the
one-OAuth split (read from JPM's own SDK README); the macrosynergy constants (`EXPR_LIMIT=20`,
`links[1].next`, `TOKEN_EXPIRY_BUFFER=0.9`, the endpoints); the FRED `observations` parameter table; the
World Bank envelope; the LSEG `202→poll→302-S3` + 7-day-TTL lifecycle; Bloomberg's refdata/mktdata split.
*Medium:* the 50m-vs-130m reconciliation (we know the discrepancy is real; the cause is `[inferred]`);
whether `EXPR_LIMIT=20` is server- or client-imposed. *Low / `[unverified]`:* the raw DataQuery JSON
schema, the server-enforced quota, Bloomberg's exact signatures.

---

## Source ledger (everything read this run)

**Primary — JPM DataQuery:**
- `https://www.jpmorgan.com/markets/dataquery` — four channels + the 650/130m+/15k/350+/4B+(75% API) stats `[verified]`.
- `https://www.jpmorgan.com/securities-services/data-analytics` — *"over 50 million time series… web, desktop, excel, batch and modern APIs"* `[verified]`.
- `https://markets.jpmorgan.com/data-and-analytics` — *"500+ cross-asset datasets"*, no series count `[verified]`.
- `github.com/jpmorganchase/dataquery-sdk` (README) — MIT, Python 3.12+, aiohttp/pydantic/structlog; JSON Data API + File Delivery API method catalog; one-OAuth; SSE `auto_download`; client throttle defaults `[verified]`.
- `developer.jpmorgan.com/products/dataquery_api` — **auth-walled** (nav-only) `[verified-as-walled]`.

**Primary — community DataQuery clients (source-readable contract):**
- `github.com/macrosynergy/dataquery-api` → `dataquery_api.py` — `DQInterface`; `OAUTH_BASE_URL`, `OAUTH_TOKEN_URL`, `/expressions/time-series`, `/group/instruments`, `/services/heartbeat`, `EXPR_LIMIT=20`, `API_DELAY_PARAM=0.2`, `TOKEN_EXPIRY_BUFFER=0.9`, `links[1].next` pagination `[verified]`.
- `github.com/macrosynergy/macrosynergy` → `macrosynergy/download/dataquery.py` — `DataQueryInterface`/`DataQueryOAuth`/`DataQueryCertAuth`; `CERT_BASE_URL`, `API_DELAY_PARAM=0.25`, `HL_RETRY_COUNT=5`, `MAX_CONTINUOUS_FAILURES=5`, `batch_size=20`, ThreadPoolExecutor+tqdm `[verified]`.

**Primary — cross-references:**
- FRED `fred/series/observations`, `fred/series`, `fred/series/search` (St. Louis Fed docs, via search; pages 403 WebFetch) — full `observations` param table, `units`/`frequency`/`aggregation_method`/`output_type`/`file_type`/`realtime_*` `[verified-via-search-of-primary]`.
- `api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD?format=json` — live response: 2-part `[header, data[]]` envelope, `value:null`, `lastupdated` `[verified]`.
- `developers.lseg.com` (Tick-History REST API tutorials + S3-direct article/factsheet) — on-demand-vs-scheduled, `202→poll→200`, `x-direct-download→302→S3`, 7-day on-demand TTL, `TickHistoryTimeAndSalesExtractionRequest` shape `[verified-via-search-of-primary]`.
- Bloomberg BLPAPI core/developer guide + `bloomberg.github.io/blpapi-docs` (via search; PDF binary/un-parsed) — `//blp/refdata` (Request/Response: `ReferenceDataRequest`/`HistoricalDataRequest`/`IntradayBarRequest`/`IntradayTickRequest`) vs `//blp/mktdata` (Subscription); `PARTIAL_RESPONSE`/`RESPONSE` event loop; explicit field selection `[verified-via-search-of-primary]`; exact signatures `[unverified]`.
