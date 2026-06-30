# patterns-openfigi-api-integration.md

> **Recipe.** The end-to-end, runnable recipe for resolving third-party security
> identifiers (ISIN / CUSIP / SEDOL / ticker …) into Bloomberg FIGIs through the **OpenFIGI
> `/v3` API**, then folding the multi-row result into the security-master crosswalk
> (entity / instrument / listing). Concrete Python: async `httpx` client, Pydantic v2
> request/response models, a rate-limited batcher that respects both the per-request **job
> cap** and the per-window **request cap**, exponential backoff on `429`, and the
> never-fabricate discipline (a `warning` is a typed `unavailable`, multi-row `data` is a
> **listing fan-out** that is never collapsed).
>
> **Product line:** JPM-Markets re-engineering **data-analytics** line — **NOT Lumina.** New
> Python/FastAPI/data-engineering stack, separate from Lumina's Bun + Express + Prisma +
> Supabase + Upstash stack. OpenFIGI is the canonical *resolver* on the symbology write
> path; this recipe writes the `openfigi` client package from scratch.
>
> **Stack pins (verify before building):** Python 3.12+, `httpx` **0.28.1**
> (`pip install httpx==0.28.1`, [pypi.org/project/httpx](https://pypi.org/project/httpx/) —
> latest stable, published 2024-12-06, requires Python ≥3.8), Pydantic **2.13.x** (v2 API;
> latest in the v2 line is **2.13.4**, published 2026-05-06, requires Python ≥3.9 —
> [pypi.org/project/pydantic](https://pypi.org/project/pydantic/)). The ONE shared
> `httpx.AsyncClient` is owned by the FastAPI app (see `python-fastapi-data-service`); this
> client *receives* it, never constructs a per-call client on the request path.
>
> **Mesh layer note.** This is the **OpenFIGI resolver recipe** (the "how, end to end"). The
> *why* of symbology levels (entity vs instrument vs listing; the ISIN/CUSIP/FIGI semantics)
> lives in `theory-symbology-landscape.md`; the crosswalk table design it writes into lives in
> `patterns-crosswalk-schema-design.md`; the licensing posture for OpenFIGI's output lives in
> `theory-figi-anchor-and-hierarchy.md`. Read those for the model; this file is the call mechanics.

---

## 0. The one-paragraph orientation

OpenFIGI is Bloomberg's free, public symbology service. You hand it an identifier and its
type — `{"idType": "ID_ISIN", "idValue": "US0378331005"}` — and it returns the matching
**FIGIs** (Financial Instrument Global Identifiers, 12-char codes) plus descriptive metadata.
The FIGI is the *anchor* of our security master because it is the only free, openly-licensed,
globally-unique key that spans **all three levels** of the symbology hierarchy in one call:
the **share-class FIGI** (the instrument, e.g. Apple common stock worldwide), the
**composite FIGI** (the country roll-up), and the **listing FIGI** (the specific
exchange-traded line). One mapping job can return *many* rows — one per exchange listing —
and the recipe's central discipline is: **never collapse that fan-out, never invent a row,
and a no-match is a typed `unavailable`, not an empty success.**

The licensing is uniquely clean: the FIGI symbology is "provided free of charge to all" with
"no cost recovery, licensing or re-use restrictions or hidden fees for access, use, or
redistribution"
([openfigi.com/about/faq](https://www.openfigi.com/about/faq)). That makes OpenFIGI output a
🟢 **GREEN** source for `commercialOk` — the *only* identifier provider in this product line
that clears the display gate without a purchased tier. (Verify the exact wording against the
FAQ before stamping; see `theory-figi-anchor-and-hierarchy.md`.)

---

## 1. The three endpoints

OpenFIGI `/v3` exposes three POST endpoints for resolution plus one GET enum helper. Base
URL is `https://api.openfigi.com`
([openfigi.com/api/documentation](https://www.openfigi.com/api/documentation);
the OpenAPI contract is served at [api.openfigi.com/schema](https://api.openfigi.com/schema)).

| Endpoint | Input | Output | When to use |
|---|---|---|---|
| **`POST /v3/mapping`** | array of jobs, each `{idType, idValue, …filters}` | array of results, one per job, each `{data:[…]}` or `{warning}` or `{error}` | **The workhorse.** You already have a *known identifier* and want its FIGIs. 99% of the write path. |
| **`POST /v3/search`** | `{query, start?, …filters}` | `{data:[…], next?, error?}` | Keyword/free-text → candidate FIGIs. Paginated by an opaque **cursor** (`start` in → `next` out). Use only when you have a *name*, not an ID. |
| **`POST /v3/filter`** | `{query?, start?, …filters}` | `{data:[…], next?, total, error?}` | Like search but `query` is **optional** and the response carries a **`total`** count. Use to enumerate a slice (e.g. "all Equity listings on exchange X") with a count. |
| `GET /v3/mapping/values/{key}` | path `key` ∈ {`idType`,`exchCode`,`micCode`,`currency`,`marketSecDes`,`securityType`,`securityType2`,`stateCode`} | `{values:[…]}` | Enum discovery — fetch the *live* valid values for a filter property. Use at build time to validate, not on the hot path. |

> Source for endpoint set, request/response keys, and the `values` enum helper:
> [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation) and the
> OpenAPI schema at [api.openfigi.com/schema](https://api.openfigi.com/schema) (paths
> `/mapping`, `/mapping/values/{key}`, `/search`, `/filter`, all under the `/v3` server base).

**Decision rule for this recipe:** the security-master write path is *ID-in, FIGI-out*, so
**`/v3/mapping` is the endpoint you build first and rely on.** `/search` and `/filter` are
secondary tools for the "I only have a name" reconciliation case and for back-office
enumeration; they are covered in §11 but are not the primary write path.

---

## 2. The exact request — array of jobs

`/v3/mapping` takes a **JSON array** of *mapping jobs*. Each job is one identifier to resolve.
You batch many jobs into one HTTP request (up to the job cap — §5). The two required fields
are `idType` and `idValue`; everything else is an optional **filter** that narrows the result.

### 2.1 Job fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `idType` | ✅ | string (enum) | The kind of identifier — see the full list in §4. |
| `idValue` | ✅ | string \| integer | The identifier value itself. |
| `exchCode` | — | string | Bloomberg exchange code filter (e.g. `US`, `LN`, `GR`). Narrows to one listing. |
| `micCode` | — | string | ISO 10383 MIC filter (e.g. `XNAS`, `XLON`) — the standards-based alternative to `exchCode`. |
| `currency` | — | string | ISO 4217 currency filter. |
| `marketSecDes` | — | string | Market sector description filter (e.g. `Equity`, `Corp`, `Govt`). |
| `securityType` | — | string | Security type filter (e.g. `Common Stock`). |
| `securityType2` | — | string | Coarser security-type filter (e.g. `Common Stock`, `REIT`). |
| `includeUnlistedEquities` | — | boolean | Include unlisted equities in results. |
| `optionType` | — | enum `Put`\|`Call` | Derivatives filter. |
| `strike` | — | number-interval | Derivatives strike filter (a `[min,max]` interval). |
| `contractSize` | — | number-interval | Derivatives filter. |
| `coupon` | — | number-interval | Bond coupon filter. |
| `expiration` | — | date-interval | Derivatives expiration filter (a `[from,to]` interval). |
| `maturity` | — | date-interval | Bond maturity filter. |
| `stateCode` | — | string | US municipal state-code filter. |

> Field set confirmed against the OpenAPI schema's `MappingJob` (extends
> `CommonSearchMappingRequest`):
> [api.openfigi.com/schema](https://api.openfigi.com/schema) and the doc page's job-property
> table, [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation). The
> interval-typed filters (`coupon`, `strike`, `maturity`, `expiration`, `contractSize`) take a
> two-element array, e.g. `"coupon": [2.5, 5.0]`.

### 2.2 The filter discipline — over-resolution is the bug, not the no-match

A *bare* job (`idType` + `idValue` only) resolves to **every listing across every exchange**
for that identifier. That is the correct default for building the master (you *want* the full
fan-out). But when you are resolving a **specific listing** — e.g. "AAPL as traded on
NASDAQ" — add `exchCode` (or the standards-cleaner `micCode`) so the response is the one row
you mean, not a 20-row global fan-out you then have to disambiguate. Pick **one** of
`exchCode` / `micCode`; prefer `micCode` (ISO 10383) for a standards-clean master.

```json
[
  { "idType": "ID_ISIN", "idValue": "US0378331005" },
  { "idType": "ID_ISIN", "idValue": "US0378331005", "exchCode": "US" },
  { "idType": "TICKER",   "idValue": "AAPL", "exchCode": "US", "marketSecDes": "Equity" }
]
```

- Job 1 → all global Apple-common listings (the full fan-out).
- Job 2 → only the US-composite listing(s).
- Job 3 → ticker `AAPL`, US, equities only — narrowed because a bare `TICKER` is ambiguous
  (tickers are reused across markets and time).

---

## 3. The exact response — per job

The response is a JSON **array the same length and order as the request**: result `[i]`
corresponds to job `[i]`. Each element is **exactly one of three shapes**:

### 3.1 Success — `{ "data": [ … ] }`

```json
{
  "data": [
    {
      "figi": "BBG000B9XRY4",
      "name": "APPLE INC",
      "ticker": "AAPL",
      "exchCode": "US",
      "compositeFIGI": "BBG000B9XRY4",
      "uniqueID": null,
      "securityType": "Common Stock",
      "marketSector": "Equity",
      "shareClassFIGI": "BBG001S5N8V8",
      "securityType2": "Common Stock",
      "securityDescription": "AAPL"
    }
  ]
}
```

The `data` array is the **listing fan-out**: one object per distinct (security, exchange)
line. A globally-cross-listed name returns *many* objects in one job's `data`. The fields:

| Field | Type | Meaning / how the crosswalk uses it |
|---|---|---|
| `figi` | string | **Listing-level FIGI** — the row's primary key in the `listing` table. Unique per (security, exchange). |
| `compositeFIGI` | string \| null | **Composite FIGI** — country-level roll-up. The `composite` grouping key. Many listings → one composite. |
| `shareClassFIGI` | string \| null | **Share-class FIGI** — global instrument key. The `instrument` row's natural key. Many composites → one share class. |
| `securityType` | string \| null | Fine security type (`Common Stock`, `REIT`, `ADR`, `GDR`, `Mutual Fund`, …). |
| `securityType2` | string \| null | Coarse security type — useful as a stable bucket when `securityType` varies by region. |
| `marketSector` | string \| null | Bloomberg market sector — `Equity`, `Corp`, `Govt`, `Mtge`, `Muni`, `Pfd`, `Comdty`, `Curncy`, `Index`, `M-Mkt`. Drives entity classification. |
| `exchCode` | string \| null | Bloomberg exchange code of this listing (`US`, `LN`, `GR`, …). |
| `ticker` | string \| null | The local ticker on that exchange. |
| `name` | string \| null | Issuer/security name (`APPLE INC`). |
| `securityDescription` | string \| null | A short description (often the ticker or a contract descriptor). |

> Field set and example structure confirmed against
> [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation) (response
> property list) and the OpenAPI `FigiResult`
> ([api.openfigi.com/schema](https://api.openfigi.com/schema)): `figi`, `securityType`,
> `marketSector`, `ticker`, `name`, `exchCode`, `shareClassFIGI`, `compositeFIGI`,
> `securityType2`, `securityDescription`, plus a nullable `metadata`. **V3 change:** the
> always-null `uniqueID` / `uniqueIDFutOpt` fields were dropped in V3 and the no-match key was
> renamed from `error` → `warning` (see §3.2); treat any `uniqueID` you see as a legacy
> artifact and ignore it.

### 3.2 No match — `{ "warning": "…" }`

```json
{ "warning": "No identifier found." }
```

This is **not an error** — the request was valid, OpenFIGI simply has no FIGI for that
identifier. In V3 this key is `warning` (it was `error` in V2). **The non-negotiable:** a
`warning` result maps to a typed **`unavailable`** in our domain, *never* a fabricated row and
*never* a silently-dropped job. The job index that warned must surface to the caller so the
write path records "ISIN X did not resolve" rather than silently writing nothing.

### 3.3 Error — `{ "error": "…" }`

```json
{ "error": "Invalid idType." }
```

A per-job `error` means *that job* was malformed (bad `idType`, unparseable `idValue`, an
invalid filter combination). The other jobs in the same request still succeed — errors are
per-element, not whole-request. Distinguish from a **transport-level** failure: a `400` on the
*whole request* means the JSON body was malformed or exceeded the job cap; a per-job `error`
inside a `200` body means one job was bad. Handle both.

> Source for the three result shapes (`data` / `warning` / `error`):
> [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation) and the OpenAPI
> `MappingJobResultFigiNotFound` (`warning`) / per-element `error`
> ([api.openfigi.com/schema](https://api.openfigi.com/schema)).

---

## 4. The supported `idType` list — and which to use

The **live, authoritative** list comes from `GET /v3/mapping/values/idType`. As fetched
2026-06 it is the following **28** values (verify against the live endpoint before relying on
any one — OpenFIGI adds vendor codes over time):

```
BARCLAYS_TICKER, BASE_TICKER, COMPOSITE_ID_BB_GLOBAL, ID_BB, ID_BB_8_CHR,
ID_BB_GLOBAL, ID_BB_GLOBAL_SHARE_CLASS_LEVEL, ID_BB_SEC_NUM_DES, ID_BB_UNIQUE,
ID_CINS, ID_COMMON, ID_CUSIP, ID_CUSIP_8_CHR, ID_EXCH_SYMBOL,
ID_FULL_EXCHANGE_SYMBOL, ID_ISIN, ID_ITALY, ID_SEDOL, ID_SHORT_CODE, ID_TRACE,
ID_WERTPAPIER, OCC_SYMBOL, OPRA_SYMBOL, TICKER, TRADEBOOK_TICKER,
TRADING_SYSTEM_IDENTIFIER, UNIQUE_ID_FUT_OPT, VENDOR_INDEX_CODE
```

> Source: live `GET https://api.openfigi.com/v3/mapping/values/idType`, fetched 2026-06.
> Cross-checked against the doc page's enumerated examples
> ([openfigi.com/api/documentation](https://www.openfigi.com/api/documentation)). Note: the
> doc-page prose sometimes also names `OPRA_SYMBOL` / `ID_TRACE`; the `values` endpoint is the
> ground truth — **fetch it at build time, do not hardcode the list as gospel.**

### 4.1 The map — input identifier → which `idType`

| Your input | Use `idType` | Notes |
|---|---|---|
| ISIN (12-char, e.g. `US0378331005`) | **`ID_ISIN`** | The global standard. First choice for cross-border. |
| CUSIP (9-char, North America) | **`ID_CUSIP`** | US/CA. `ID_CUSIP_8_CHR` for the 8-char form (no check digit). |
| CINS (CUSIP International Numbering System) | **`ID_CINS`** | Non-US securities in CUSIP format. |
| SEDOL (7-char, UK/LSE) | **`ID_SEDOL`** | London-listed and many international. |
| Bloomberg FIGI (12-char `BBG…`) | **`ID_BB_GLOBAL`** | Round-trip a listing FIGI back to its metadata. |
| Composite FIGI | **`COMPOSITE_ID_BB_GLOBAL`** | Resolve the composite roll-up. |
| Share-class FIGI | **`ID_BB_GLOBAL_SHARE_CLASS_LEVEL`** | Resolve the share-class anchor → all its listings. |
| Bloomberg "common" number (BBGID/BSID) | **`ID_COMMON`** | Legacy Bloomberg common identifier. |
| Bloomberg unique ID | **`ID_BB_UNIQUE`** | |
| Ticker (exchange-local) | **`TICKER`** | **Ambiguous** — always add `exchCode`/`micCode` + `marketSecDes`. |
| Root/base ticker (no class suffix) | **`BASE_TICKER`** | E.g. `BRK` for both `BRK/A` and `BRK/B`. |
| OCC option symbol | **`OCC_SYMBOL`** | US listed options. |
| OPRA option symbol | **`OPRA_SYMBOL`** | US options (OPRA feed format). |
| Futures/option unique ID | **`UNIQUE_ID_FUT_OPT`** | Derivatives. |
| German Wertpapier (WKN) | **`ID_WERTPAPIER`** | German market. |
| Index vendor code | **`VENDOR_INDEX_CODE`** | Index symbology. |
| TRACE-eligible bond ID | **`ID_TRACE`** | US corporate bonds. |

**Preference order for the master's primary resolution path:** `ID_ISIN` → `ID_CUSIP`/`ID_SEDOL`
(regional fallbacks) → `TICKER` (last resort, always filtered). ISIN-first because it is the
single most-universal external key; ticker-last because tickers are *not* identifiers — they
are reused across instruments and time and will silently over-resolve.

---

## 5. Rate limits — keyed vs keyless

This is the single most important operational fact. There are **two independent ceilings**
per endpoint: a **per-request job cap** (how many jobs in one HTTP POST) and a **per-window
request rate** (how many HTTP POSTs per time window). The batcher in §6/§10 must respect both
simultaneously.

| Endpoint | No API key (keyless) | With free API key (`X-OPENFIGI-APIKEY`) |
|---|---|---|
| **`/v3/mapping`** request rate | **25 requests / minute** | **25 requests / 6 seconds** |
| **`/v3/mapping`** job cap | **10 jobs / request** | **100 jobs / request** |
| **`/v3/search`** & **`/v3/filter`** rate | **5 requests / minute** | **20 requests / minute** |

> Source: the rate-limit table on
> [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation) — keyless
> Mapping "25 Per Minute / 10 Jobs", keyed Mapping "25 Per 6 Seconds / 100 Jobs"; keyless
> Search/Filter "5 Per Minute", keyed "20 Per Minute". The API key is **free** (no daily,
> weekly, or monthly cap on the API itself —
> [openfigi.com/api/overview](https://www.openfigi.com/api/overview): "free to use without
> daily, weekly or monthly limitations"). Get a key at openfigi.com. **Always run keyed in
> production** — the throughput delta is enormous (see §5.1).

### 5.1 Throughput math — why you key, and why you batch

The two ceilings multiply. Effective **jobs/second** is `job_cap × request_rate`:

| Configuration | Jobs/request | Requests/window | Jobs per minute |
|---|---|---|---|
| **Keyless** | 10 | 25 / min | **250 jobs/min** |
| **Keyed** | 100 | 25 / 6s = 250 / min | **25,000 jobs/min** |

That **100×** gap (250 → 25,000 jobs/min) is exactly the "Bulk mapping can also be done via the
free web-based mapping API at a rate limit of 25,000 jobs per minute" figure the FAQ quotes
([openfigi.com/about/faq](https://www.openfigi.com/about/faq)) — i.e. 100 jobs × 250
requests/min, the *keyed* ceiling. To resolve a 50,000-symbol universe:

- **Keyless:** 50,000 / 250 = **200 minutes** (≈3.3 h). Painful.
- **Keyed:** 50,000 / 25,000 = **2 minutes**. ("anyone can map hundreds of thousands of
  instruments in minutes" — [openfigi.com/api/overview](https://www.openfigi.com/api/overview).)

**The two failure modes the batcher must prevent:**
1. **Under-packing** — sending 1 job per request wastes 99% of the job cap and you hit the
   *request* ceiling at 1/100th throughput. Always pack to the job cap.
2. **Over-running the request rate** — packing perfectly but firing requests too fast →
   `429`. The keyed window is **25 requests per 6 seconds**, i.e. a sustained ceiling of one
   request every **240 ms**. Pace to that.

### 5.2 The `429` contract

> A `429 Too Many Requests` is returned when the rate-limit window is exhausted
> ([openfigi.com/api/documentation](https://www.openfigi.com/api/documentation)). Other
> status codes the doc enumerates: `200` success, `400` invalid payload, `401` invalid API
> key, `404` unknown path, `405` method not allowed, `413` payload exceeds the job limit,
> `429` rate-limited, `500`/`503` server errors. **`413` is your tell that you packed past the
> job cap** — clamp the batch size to the cap (§6) so you never see it. On `429`, back off
> exponentially with jitter (§7) and retry the *same* batch — the batch was valid, you were
> just early.

---

## 6. Batching strategy

Two nested constraints → two layers in the batcher:

1. **Pack** the input identifiers into jobs, chunked to the **job cap** (`100` keyed / `10`
   keyless). One chunk = one HTTP request. Never exceed the cap (→ `413`).
2. **Pace** the requests under the **request-rate ceiling** (one per `240 ms` keyed; one per
   `2.4 s` keyless for mapping). A token-bucket / fixed-interval limiter gates the request
   firing.
3. **Backoff** on `429` with exponential delay + jitter, then resume pacing.

Pseudocode of the control flow (full runnable version in §10):

```
chunks = chunk(identifiers, size=JOB_CAP)          # layer 1: pack to cap
for chunk in chunks:
    await rate_limiter.acquire()                   # layer 2: pace to window
    resp = await post_with_backoff("/v3/mapping", chunk)   # layer 3: 429 backoff
    for job, result in zip(chunk, resp):           # align by index
        route(job, result)                         # data → fan-out | warning → unavailable | error
```

**Index alignment is load-bearing.** The response array is positional — `resp[i]` is the
result for `chunk[i]`. Never sort, filter, or reorder the response before zipping it back to
its input job, or you will attach FIGIs to the wrong identifier. This is the quiet
data-corruption bug that a `key=index` mistake produces; keep the chunk list and the response
list strictly parallel.

**Concurrency caveat.** It is tempting to fire N chunks concurrently with `asyncio.gather`.
You *can*, but the rate limiter must still gate the global request rate across all coroutines
— a per-coroutine limiter does not bound the aggregate. The §10 implementation uses a single
shared async limiter so concurrency raises utilization toward the ceiling without breaching it.

---

## 7. The `429` backoff — exact recipe

Exponential backoff with full jitter, capped, bounded retries. The base delay is anchored to
the keyed window (one request per 240 ms), so the first backoff already clears a brief burst.

```python
import asyncio, random

async def _post_with_backoff(client, url, payload, *, headers,
                             max_retries=6, base=0.5, cap=30.0):
    """POST with exponential backoff + full jitter on 429 / 5xx.

    base=0.5s, doubling, full-jitter (sleep ~ U(0, min(cap, base*2**n))).
    Retries only the *retryable* statuses; 4xx (except 429) raise immediately.
    """
    for attempt in range(max_retries + 1):
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429 or 500 <= resp.status_code < 600:
            if attempt == max_retries:
                resp.raise_for_status()           # give up → caller marks the batch unavailable
            # Honor Retry-After if OpenFIGI sends it, else exponential+jitter
            retry_after = resp.headers.get("Retry-After")
            if retry_after:
                delay = float(retry_after)
            else:
                delay = random.uniform(0, min(cap, base * (2 ** attempt)))
            await asyncio.sleep(delay)
            continue
        # 400 / 401 / 404 / 413 → a bug in OUR request, not a transient → raise now
        resp.raise_for_status()
    raise RuntimeError("unreachable")
```

Notes:
- **`413` raises immediately** (not retried) — it means the chunk exceeded the job cap, a
  packing bug. Fix the cap, don't retry.
- **`401` raises immediately** — a bad/expired API key. Retrying won't help.
- **Full jitter** (`U(0, ceiling)`) over equal-jitter avoids the thundering-herd resync that
  pure exponential backoff causes when many coroutines retry in lockstep (AWS Architecture
  Blog, "Exponential Backoff And Jitter" — the standard reference for this choice).
- OpenFIGI's docs do not *promise* a `Retry-After` header on `429`; the code honors it *if*
  present and falls back to computed backoff otherwise. Confirm presence empirically before
  relying on it.

---

## 8. The no-bulk-flat-file reality

There is **no bulk download** of the FIGI universe. Two hard facts from the FAQ:

1. **"Bulk flat files are not available on the site."**
2. **"The OpenFIGI Search page supports exporting up to 5000 results to a `.CSV` formatted
   Excel file."**

> Source: [openfigi.com/about/faq](https://www.openfigi.com/about/faq).

So you cannot seed the master from a downloadable dump, and the UI CSV export caps at **5,000
rows** — useless for a 50k+ universe and a manual UI action besides. **The consequence for
the architecture:** the master is built by **resolving identifiers through the API on the
write path and persisting the results yourself.** OpenFIGI is the *resolver*, your store
(TimescaleDB / Postgres — see `timescaledb-timeseries` and the crosswalk theory doc) is the
*system of record*. You call OpenFIGI once per new/changed identifier (an ingest job on the
Fly worker, off the request path — non-negotiable #4 of the line: heavy/scheduled work never
runs on the serverless request path), write the FIGIs + metadata into the crosswalk, and
thereafter read from your own store. The API is the source; the DB is the cache-of-record.

This also means **idempotency on the write path**: re-resolving the same ISIN must
upsert (not duplicate) the listing rows. Key the upsert on `figi` (the listing-level
primary key) so a re-run is a no-op when nothing changed.

---

## 9. Mapping the response into entity / instrument / listing rows

OpenFIGI hands you exactly the three-level hierarchy the crosswalk needs. The mapping is
direct:

| OpenFIGI field | Crosswalk level | Table / key |
|---|---|---|
| `shareClassFIGI` | **Instrument** (global share class) | `instrument.share_class_figi` (natural key) |
| `compositeFIGI` | **Composite** (country roll-up) | `composite.composite_figi` (groups listings within a country) |
| `figi` | **Listing** (exchange line) | `listing.figi` (**primary key**, unique per exchange) |
| `name` | **Entity / Issuer** | `entity.name` (the issuer — enrich with LEI from a separate source) |
| `marketSector`, `securityType`, `securityType2` | classification on instrument/listing | drive the asset-class taxonomy |
| `exchCode` / `micCode` | listing venue | `listing.exch_code` / `listing.mic` |
| `ticker` | listing local symbol | `listing.ticker` |

### 9.1 The hierarchy, made concrete

A FIGI is a 12-char code: chars 1–2 are the issuer/Certified-Provider prefix, char 3 is always
`G`, chars 4–11 are a random consonant/digit body (no vowels A/E/I/O/U), char 12 is a Modulus-10
Double-Add-Double check digit
([en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier](https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier);
[openfigi.com/about/overview](https://www.openfigi.com/about/overview)). The three *levels* are
distinct FIGIs, not parts of one string:

- **Share-class FIGI** — "the most general level that groups all securities globally for a
  given share class (e.g. all Apple common stock worldwide)" — links every composite that
  represents the same share class.
- **Composite FIGI** — "country-level aggregation … groups securities across all exchanges
  within a country."
- **Exchange/listing FIGI** — "the most granular hierarchy that identifies an instrument
  specific to the exchange on which it trades."

> Source: web research summary of
> [en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier](https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier)
> and the FIGI allocation rules
> ([openfigi.com/assets/local/figi-allocation-rules.pdf](https://www.openfigi.com/assets/local/figi-allocation-rules.pdf)).

So for IBM, the *same company* trades on many exchanges with **different listing FIGIs**
(e.g. `BBG000BLNNH6` US, `BBG000BLNNV0`/`BBG000BLNQ16` on other venues) that all share **one
`compositeFIGI`** per country and **one `shareClassFIGI`** globally
(`BBG001S5S399` for IBM common per the doc-page example,
[openfigi.com/api/documentation](https://www.openfigi.com/api/documentation)). The mapping
into rows:

```
shareClassFIGI BBG001S5S399  ──┐  one instrument row
   compositeFIGI BBG000BLNNH6 ──┤  one composite row (US)
      figi BBG000BLNNH6 (US)   │  listing row  ticker=IBM exchCode=US
      figi BBG000BLNNV0 (…)    │  listing row
      figi BBG000BLNQ16 (…)    │  listing row
   compositeFIGI <other-ctry> ─┘  another composite row → its own listings
```

The **write order matters**: insert/upsert the instrument (share class) first, then the
composite, then the listings (FK-parent before child). The §10 code emits the three levels in
that order.

### 9.2 Edge cases the mapping must handle

- **`compositeFIGI == figi`** is normal for the composite-level listing itself (e.g. the
  Apple US-composite line where the listing FIGI *is* the composite FIGI). Don't treat equality
  as an error.
- **Null `shareClassFIGI` / `compositeFIGI`** happens for instrument types without that level
  (some bonds, derivatives, indices). Persist the listing with a null parent rather than
  inventing one. The crosswalk's instrument/composite tables allow null linkage.
- **`marketSector` drives the asset-class branch** — `Equity` vs `Corp`/`Govt`/`Muni`/`Mtge`
  (debt) vs `Comdty`/`Curncy`/`Index`. Bucket on it before applying type-specific enrichment.

---

## 10. Full Python example — async client + Pydantic models + rate-limited batcher → crosswalk

This is a **complete, runnable** module. It uses the shared `httpx.AsyncClient` (injected, not
constructed here), Pydantic v2 models for every request/response shape, a shared async
fixed-interval rate limiter, the §7 backoff, strict index alignment, and emits the three
crosswalk levels in FK order. No external deps beyond `httpx==0.28.1` and `pydantic>=2.13,<2.14`.

```python
# openfigi/client.py
"""OpenFIGI /v3 resolver for the JPM-Markets data-analytics security master.
NOT Lumina. Python 3.12+, httpx 0.28.1, pydantic 2.13.x.

Resolves third-party identifiers -> FIGIs and folds the result into the
entity/instrument/composite/listing crosswalk. A `warning` is a typed
`unavailable`; multi-row `data` is a listing fan-out that is NEVER collapsed.
"""
from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

BASE_URL = "https://api.openfigi.com"
MAPPING_PATH = "/v3/mapping"

# --- Rate-limit constants (verify on the docs page before changing) -----------
# keyless: 10 jobs/req, 25 req/min ; keyed: 100 jobs/req, 25 req/6s
JOB_CAP_KEYLESS, REQ_PER_WINDOW_KEYLESS, WINDOW_KEYLESS = 10, 25, 60.0
JOB_CAP_KEYED,   REQ_PER_WINDOW_KEYED,   WINDOW_KEYED   = 100, 25, 6.0


# ============================================================================
# 1. Request models
# ============================================================================
class IdType(StrEnum):
    """The live idType enum (fetch /v3/mapping/values/idType at build time to
    refresh — this is the 2026-06 snapshot, used only to fail fast on typos)."""
    ID_ISIN = "ID_ISIN"
    ID_CUSIP = "ID_CUSIP"
    ID_CUSIP_8_CHR = "ID_CUSIP_8_CHR"
    ID_CINS = "ID_CINS"
    ID_SEDOL = "ID_SEDOL"
    ID_COMMON = "ID_COMMON"
    ID_WERTPAPIER = "ID_WERTPAPIER"
    ID_BB = "ID_BB"
    ID_BB_8_CHR = "ID_BB_8_CHR"
    ID_BB_UNIQUE = "ID_BB_UNIQUE"
    ID_BB_GLOBAL = "ID_BB_GLOBAL"
    ID_BB_GLOBAL_SHARE_CLASS_LEVEL = "ID_BB_GLOBAL_SHARE_CLASS_LEVEL"
    ID_BB_SEC_NUM_DES = "ID_BB_SEC_NUM_DES"
    COMPOSITE_ID_BB_GLOBAL = "COMPOSITE_ID_BB_GLOBAL"
    TICKER = "TICKER"
    BASE_TICKER = "BASE_TICKER"
    ID_EXCH_SYMBOL = "ID_EXCH_SYMBOL"
    ID_FULL_EXCHANGE_SYMBOL = "ID_FULL_EXCHANGE_SYMBOL"
    ID_ITALY = "ID_ITALY"
    ID_TRACE = "ID_TRACE"
    ID_SHORT_CODE = "ID_SHORT_CODE"
    OCC_SYMBOL = "OCC_SYMBOL"
    OPRA_SYMBOL = "OPRA_SYMBOL"
    UNIQUE_ID_FUT_OPT = "UNIQUE_ID_FUT_OPT"
    TRADING_SYSTEM_IDENTIFIER = "TRADING_SYSTEM_IDENTIFIER"
    VENDOR_INDEX_CODE = "VENDOR_INDEX_CODE"
    BARCLAYS_TICKER = "BARCLAYS_TICKER"
    TRADEBOOK_TICKER = "TRADEBOOK_TICKER"


class MappingJob(BaseModel):
    """One mapping job. Required idType+idValue; optional narrowing filters.
    `model_dump(exclude_none=True)` drops unset filters so the wire payload is
    exactly what OpenFIGI's schema expects."""
    model_config = ConfigDict(use_enum_values=True)

    idType: IdType
    idValue: str
    exchCode: str | None = None
    micCode: str | None = None
    currency: str | None = None
    marketSecDes: str | None = None
    securityType: str | None = None
    securityType2: str | None = None
    includeUnlistedEquities: bool | None = None
    optionType: Literal["Put", "Call"] | None = None
    # interval filters are two-element [min,max] / [from,to] arrays
    strike: list[float] | None = None
    contractSize: list[float] | None = None
    coupon: list[float] | None = None
    expiration: list[str] | None = None
    maturity: list[str] | None = None
    stateCode: str | None = None


# ============================================================================
# 2. Response models — the three result shapes
# ============================================================================
class FigiRow(BaseModel):
    """One listing-level result row inside a job's `data` array."""
    model_config = ConfigDict(extra="ignore")  # tolerate legacy uniqueID etc.

    figi: str
    compositeFIGI: str | None = None
    shareClassFIGI: str | None = None
    securityType: str | None = None
    securityType2: str | None = None
    marketSector: str | None = None
    exchCode: str | None = None
    ticker: str | None = None
    name: str | None = None
    securityDescription: str | None = None


class MappingResult(BaseModel):
    """Exactly one of: data (success), warning (no-match), error (bad job).
    A Pydantic model + validator enforces the 'exactly one' invariant so a
    malformed body surfaces loudly instead of silently routing as a no-match."""
    data: list[FigiRow] | None = None
    warning: str | None = None
    error: str | None = None

    @property
    def is_match(self) -> bool:
        return bool(self.data)

    @property
    def is_unavailable(self) -> bool:
        # `warning` => valid request, no FIGI => typed unavailable (never fabricate)
        return self.warning is not None and not self.data


# ============================================================================
# 3. A shared async rate limiter (fixed-interval, global across coroutines)
# ============================================================================
class AsyncRateLimiter:
    """Allows `rate` requests per `window` seconds, fairly, across all callers.
    A single shared instance bounds the AGGREGATE request rate even under
    asyncio.gather concurrency (a per-coroutine limiter would not)."""
    def __init__(self, rate: int, window: float) -> None:
        self._min_interval = window / rate
        self._lock = asyncio.Lock()
        self._next_allowed = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = self._next_allowed - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = time.monotonic()
            self._next_allowed = max(now, self._next_allowed) + self._min_interval


# ============================================================================
# 4. The resolver
# ============================================================================
@dataclass
class CrosswalkRow:
    """What we persist: the three FK-ordered levels for one listing."""
    instrument_share_class_figi: str | None
    composite_figi: str | None
    listing_figi: str
    exch_code: str | None
    ticker: str | None
    name: str | None
    market_sector: str | None
    security_type: str | None
    security_type2: str | None


@dataclass
class ResolveOutcome:
    """Per-input outcome — strictly aligned to the input order."""
    job: MappingJob
    rows: list[CrosswalkRow] = field(default_factory=list)
    unavailable: bool = False          # warning => no FIGI for this identifier
    error: str | None = None           # per-job error (bad idType/value/filter)


class OpenFigiResolver:
    def __init__(self, client: httpx.AsyncClient, api_key: str | None) -> None:
        self._client = client
        self._headers = {"Content-Type": "application/json"}
        if api_key:
            # keyed: higher ceilings
            self._headers["X-OPENFIGI-APIKEY"] = api_key
            self._job_cap = JOB_CAP_KEYED
            self._limiter = AsyncRateLimiter(REQ_PER_WINDOW_KEYED, WINDOW_KEYED)
        else:
            self._job_cap = JOB_CAP_KEYLESS
            self._limiter = AsyncRateLimiter(REQ_PER_WINDOW_KEYLESS, WINDOW_KEYLESS)

    @staticmethod
    def _chunk(jobs: list[MappingJob], size: int) -> list[list[MappingJob]]:
        return [jobs[i : i + size] for i in range(0, len(jobs), size)]

    async def _post_chunk(self, chunk: list[MappingJob]) -> list[MappingResult]:
        payload = [j.model_dump(exclude_none=True) for j in chunk]
        await self._limiter.acquire()
        raw = await _post_with_backoff(
            self._client, BASE_URL + MAPPING_PATH, payload, headers=self._headers
        )
        # response is positional: raw[i] is the result for chunk[i]
        if len(raw) != len(chunk):
            raise RuntimeError(
                f"OpenFIGI returned {len(raw)} results for {len(chunk)} jobs "
                "— alignment broken, refusing to map (never fabricate)."
            )
        return [MappingResult.model_validate(r) for r in raw]

    @staticmethod
    def _to_crosswalk(row: FigiRow) -> CrosswalkRow:
        return CrosswalkRow(
            instrument_share_class_figi=row.shareClassFIGI,
            composite_figi=row.compositeFIGI,
            listing_figi=row.figi,
            exch_code=row.exchCode,
            ticker=row.ticker,
            name=row.name,
            market_sector=row.marketSector,
            security_type=row.securityType,
            security_type2=row.securityType2,
        )

    async def resolve(self, jobs: list[MappingJob]) -> list[ResolveOutcome]:
        """Resolve all jobs, packed to the job cap, paced to the request window,
        backed off on 429. Returns one ResolveOutcome per input, in input order."""
        outcomes: list[ResolveOutcome] = [ResolveOutcome(job=j) for j in jobs]
        chunks = self._chunk(jobs, self._job_cap)

        offset = 0
        for chunk in chunks:
            results = await self._post_chunk(chunk)
            for k, result in enumerate(results):
                oc = outcomes[offset + k]
                if result.error:
                    oc.error = result.error                 # bad job, surfaced
                elif result.is_unavailable:
                    oc.unavailable = True                   # typed unavailable
                elif result.is_match:
                    # multi-row data => listing fan-out, NEVER collapsed
                    oc.rows = [self._to_crosswalk(r) for r in result.data]
                # else: empty data with no warning — treat as unavailable too
                else:
                    oc.unavailable = True
            offset += len(chunk)
        return outcomes


# ============================================================================
# 5. The 429/5xx backoff (full jitter, honors Retry-After if present)
# ============================================================================
async def _post_with_backoff(client, url, payload, *, headers,
                             max_retries=6, base=0.5, cap=30.0):
    for attempt in range(max_retries + 1):
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429 or 500 <= resp.status_code < 600:
            if attempt == max_retries:
                resp.raise_for_status()
            ra = resp.headers.get("Retry-After")
            delay = float(ra) if ra else random.uniform(0, min(cap, base * 2 ** attempt))
            await asyncio.sleep(delay)
            continue
        resp.raise_for_status()  # 400/401/404/413 => our bug, fail loud
    raise RuntimeError("unreachable")
```

### 10.1 Wiring it into the write path (idempotent upsert)

```python
# openfigi/writepath.py
"""Resolve a universe of identifiers and upsert into the crosswalk.
Runs on the Fly worker (off the serverless request path — non-negotiable #4).
Idempotent: keyed on listing FIGI, re-runs are no-ops when nothing changed."""
from openfigi.client import OpenFigiResolver, MappingJob, IdType, ResolveOutcome


async def build_master(client, api_key, isins: list[str], repo) -> dict:
    resolver = OpenFigiResolver(client, api_key)
    jobs = [MappingJob(idType=IdType.ID_ISIN, idValue=i) for i in isins]
    outcomes: list[ResolveOutcome] = await resolver.resolve(jobs)

    resolved = unavailable = errored = listings = 0
    async with repo.transaction() as tx:               # one tx per batch
        for oc in outcomes:
            if oc.error:
                errored += 1
                await tx.record_resolution_error(oc.job.idValue, oc.error)
                continue
            if oc.unavailable:
                unavailable += 1
                # typed unavailable — recorded, NOT a fabricated row
                await tx.mark_unresolved(oc.job.idValue, source="openfigi")
                continue
            resolved += 1
            for row in oc.rows:                         # the fan-out, preserved
                # FK order: instrument -> composite -> listing (upsert each)
                if row.instrument_share_class_figi:
                    await tx.upsert_instrument(row.instrument_share_class_figi,
                                               name=row.name,
                                               market_sector=row.market_sector)
                if row.composite_figi:
                    await tx.upsert_composite(row.composite_figi,
                                              row.instrument_share_class_figi)
                await tx.upsert_listing(                # PK = listing_figi (idempotent)
                    figi=row.listing_figi,
                    composite_figi=row.composite_figi,
                    exch_code=row.exch_code,
                    ticker=row.ticker,
                    security_type=row.security_type,
                    security_type2=row.security_type2,
                )
                listings += 1

    return {"resolved": resolved, "unavailable": unavailable,
            "errored": errored, "listings": listings}
```

### 10.2 A real request/response trace (what goes over the wire)

**Request** (`POST https://api.openfigi.com/v3/mapping`, keyed):

```http
POST /v3/mapping HTTP/1.1
Host: api.openfigi.com
Content-Type: application/json
X-OPENFIGI-APIKEY: <your-free-key>

[
  {"idType": "ID_ISIN", "idValue": "US0378331005"},
  {"idType": "ID_ISIN", "idValue": "US4592001014"},
  {"idType": "ID_ISIN", "idValue": "XX0000000000"}
]
```

**Response** (`200 OK`, array aligned to the three jobs):

```json
[
  { "data": [
      { "figi": "BBG000B9XRY4", "name": "APPLE INC", "ticker": "AAPL",
        "exchCode": "US", "compositeFIGI": "BBG000B9XRY4",
        "securityType": "Common Stock", "marketSector": "Equity",
        "shareClassFIGI": "BBG001S5N8V8", "securityType2": "Common Stock",
        "securityDescription": "AAPL" },
      { "figi": "BBG000B9Y5X2", "name": "APPLE INC", "ticker": "AAPL",
        "exchCode": "UN", "compositeFIGI": "BBG000B9XRY4",
        "securityType": "Common Stock", "marketSector": "Equity",
        "shareClassFIGI": "BBG001S5N8V8", "securityType2": "Common Stock",
        "securityDescription": "AAPL" }
  ]},
  { "data": [
      { "figi": "BBG000BLNNH6", "name": "INTL BUSINESS MACHINES CORP",
        "ticker": "IBM", "exchCode": "US", "compositeFIGI": "BBG000BLNNH6",
        "securityType": "Common Stock", "marketSector": "Equity",
        "shareClassFIGI": "BBG001S5S399", "securityType2": "Common Stock",
        "securityDescription": "IBM" }
  ]},
  { "warning": "No identifier found." }
]
```

> The IBM row values (`figi: BBG000BLNNH6`, `name: INTL BUSINESS MACHINES CORP`,
> `ticker: IBM`, `compositeFIGI: BBG000BLNNH6`, `securityType: Common Stock`,
> `marketSector: Equity`, `shareClassFIGI: BBG001S5S399`) are the doc-page example values,
> [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation). Job 1 returns
> a **two-row fan-out** (composite `US` line + a venue `UN` line, same composite & share-class
> FIGI) — exactly the case §9 forbids collapsing. Job 3 (a bogus ISIN) returns the
> `warning` no-match → routed to a typed `unavailable`.

---

## 11. The secondary endpoints — `/v3/search` and `/v3/filter`

Use these **only** when you have a *name*, not an identifier (reconciliation, manual lookup,
back-office enumeration). They are **not** the master write path and have **much tighter** rate
limits (keyless **5/min**, keyed **20/min** — [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation)).

### 11.1 `/v3/search` — keyword → cursor-paginated FIGIs

```python
# Request:  POST /v3/search   {"query": "APPLE", "exchCode": "US"}
# Response: {"data": [ {figi,...}, ... ], "next": "<opaque-cursor>"}
async def search_all(client, headers, query: str, **filters):
    """Walk the cursor pages. `start` in <- `next` out; stop when no `next`."""
    out, cursor = [], None
    while True:
        body = {"query": query, **filters}
        if cursor:
            body["start"] = cursor          # opaque cursor, NOT an offset/page number
        await asyncio.sleep(3.0)            # pace under 20/min keyed
        resp = await client.post(f"{BASE_URL}/v3/search", json=body, headers=headers)
        resp.raise_for_status()
        page = resp.json()
        out.extend(page.get("data", []))
        cursor = page.get("next")
        if not cursor:
            break
    return out
```

- **`start` is an opaque cursor, not a page index.** You pass back the exact `next` string the
  previous response gave you. Do not synthesize offsets.
- **Pagination ceiling:** the search/filter result set is capped (the docs note a large but
  bounded total — on the order of 15,000 results, 100/page, ~150 pages). Search is a *funnel
  to a few candidates*, not a bulk-extract tool. If a query returns thousands, **narrow the
  filters**, don't page to the end.

### 11.2 `/v3/filter` — optional query + a `total` count

```python
# Request:  POST /v3/filter   {"exchCode": "US", "marketSecDes": "Equity"}  (query optional)
# Response: {"data": [...], "next": "<cursor>", "total": 8123}
```

`/v3/filter` differs from `/v3/search` in two ways: **`query` is optional** (you can enumerate
purely by filters) and the response carries **`total`** — the full count of matches, useful for
"how many US equity listings exist" without walking every page. Same opaque-cursor pagination,
same tight rate limit. Use `total` to decide whether the slice is small enough to enumerate or
needs narrower filters.

---

## 12. The never-fabricate contract (the rules, restated as a checklist)

Every one of these is a hard line — violating it is the failure mode the security-master skill
exists to prevent (the "never invent a finance number" non-negotiable, applied to identifiers):

- [ ] **A `warning` is a typed `unavailable`.** No FIGI for an ISIN → record "unresolved",
      never write a placeholder/guessed FIGI, never drop the input silently.
- [ ] **Multi-row `data` is a listing fan-out — never collapsed.** N exchange listings → N
      `listing` rows. Picking "the first one" or "the US one" silently discards real instruments
      and corrupts the cross-listing graph. Persist all; let the *reader* choose a venue.
- [ ] **Response array is positional — align strictly by index.** `resp[i]` ↔ `job[i]`. Never
      sort/filter the response before zipping it back. A length mismatch is a hard error
      (refuse to map), not a best-effort guess.
- [ ] **A per-job `error` is surfaced, not swallowed.** Bad `idType`/`idValue` → recorded as a
      resolution error against that input, not hidden inside a try/except.
- [ ] **`commercialOk` only after the FAQ check.** OpenFIGI's "free, no re-use restrictions"
      wording makes it 🟢 GREEN; stamp `commercialOk: true` only after confirming the live FAQ
      text and adding the ledger row (`theory-figi-anchor-and-hierarchy.md`). Default stays `false`
      until confirmed.
- [ ] **Resolution runs off the request path.** The bulk resolve is a worker/cron job, not a
      serverless route (non-negotiable #4). Reads come from your own persisted master.
- [ ] **Upserts are idempotent on `figi`.** Re-resolving the same identifier is a no-op when
      unchanged — never duplicate listings on a re-run.

---

## 13. Scale note (R-SCALE) — which tier this survives

| Surface | Tier-1 (demo) | Tier-2 (early) | Tier-3 (product) |
|---|---|---|---|
| Resolve N identifiers | keyless, 250 jobs/min | **keyed, 25k jobs/min** | keyed + queued worker, idempotent upsert, delta-only re-resolve |
| Read the master | from your DB | from your DB | from your DB (OpenFIGI never on the read path) |

**The ceiling and what breaks at the next tier:** the OpenFIGI *resolve* step tops out at
**25,000 jobs/min keyed** — a hard upstream rate, not something you scale past by adding workers
(more workers just share the same global rate budget; the §10 shared limiter must be a *single
process-wide* limiter, or worse, a Redis token bucket if you fan out across machines, so the
aggregate never breaches 25 req/6s). At a **1M-symbol** universe a full cold rebuild is
1,000,000 / 25,000 = **40 minutes** of continuous keyed resolution — acceptable as a one-time
seed, *not* acceptable per request. The Tier-3 move is **delta resolution**: resolve only
new/changed identifiers on a nightly worker cron, and serve every read from the persisted
master. OpenFIGI is the *seed and the delta*, never the live read path. (Battery:
`product-at-scale.md` + `~/.claude/rules/product-scale-architecture.md`.)

---

## 14. Sources

- **OpenFIGI API documentation** (endpoints, request/response fields, rate-limit table, status
  codes, `idType` examples): [openfigi.com/api/documentation](https://www.openfigi.com/api/documentation)
- **OpenFIGI API overview** (free, no daily/weekly/monthly limit; "hundreds of thousands in
  minutes"): [openfigi.com/api/overview](https://www.openfigi.com/api/overview)
- **OpenFIGI FAQ** (no bulk flat files; CSV export ≤5000; free with no re-use restrictions;
  25,000 jobs/min bulk web mapping): [openfigi.com/about/faq](https://www.openfigi.com/about/faq)
- **OpenAPI schema** (the machine contract — paths, `MappingJob`, `FigiResult`, `warning`,
  pagination `next`/`total`): [api.openfigi.com/schema](https://api.openfigi.com/schema)
- **Live `idType` enum** (the 28-value snapshot in §4):
  `GET https://api.openfigi.com/v3/mapping/values/idType`
- **Official client examples** (the urllib pattern, header construction):
  [github.com/OpenFIGI/api-examples](https://github.com/OpenFIGI/api-examples) →
  [python/example.py](https://github.com/OpenFIGI/api-examples/blob/main/python/example.py)
- **FIGI structure & hierarchy** (12-char format; share-class/composite/listing levels;
  market sectors): [en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier](https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier),
  [openfigi.com/about/overview](https://www.openfigi.com/about/overview),
  [figi-allocation-rules.pdf](https://www.openfigi.com/assets/local/figi-allocation-rules.pdf)
- **Version pins:** [pypi.org/project/httpx](https://pypi.org/project/httpx/) (0.28.1,
  2024-12-06), [pypi.org/project/pydantic](https://pypi.org/project/pydantic/) (2.13.4,
  2026-05-06)
