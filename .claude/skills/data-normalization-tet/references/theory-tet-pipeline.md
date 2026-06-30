# Theory — The TET Pipeline (Transform → Extract → Transform)

> **Reference for the dev-skill `data-normalization-tet`.** Product line: the **JPM-Markets
> re-engineering data-analytics service** (re-engineers DataQuery + Fusion). **NOT Lumina.** This is a
> separate Python/FastAPI/data-engineering line; nothing here is wired into Lumina's Bun/Express runtime.
>
> **Type:** `theory-*` — generic, reusable conceptual spine. The concrete build recipe (our directory
> layout, the worker that persists, the security-master call-out at the seam) lives in the sibling
> `patterns-*.md` references; read those when you are writing code, this when you need to know *why* each
> stage exists and *exactly* what its contract is.
>
> **Provenance of this doc.** It is a **clean-room re-derivation** of OpenBB's public Transform-Extract-
> Transform pattern from OpenBB's own blog, docs, and the `develop`-branch source of
> [`OpenBB-finance/OpenBB`](https://github.com/OpenBB-finance/OpenBB) (read at source level, cited inline
> as `repo:path`). We copy the **normalization mechanism** (the write half). We **reject** OpenBB's
> no-storage proxy model for the read path — the single most important divergence, stated in full in §9
> and grounded in the project's own
> [`financial-data-analytics-service/00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
> CRITICAL-2.

---

## 0. The one-paragraph version (read this first)

Every market-data provider speaks a different dialect for the *same* facts. Polygon calls the start of a
date range `from`; FMP also calls it `from`; another vendor calls it `begin`; the OpenBB standard calls it
`start_date`. Polygon returns OHLC under `o/h/l/c`; FMP returns adjusted closes under `adjClose`; the
standard wants `open/high/low/close`. **TET** is a three-stage assembly line that absorbs this chaos at a
single, testable boundary so the rest of the system only ever sees one shape:

1. **Transform (query)** — rename *our* standard params into *the provider's* native param words, apply
   defaults, set up pagination. Input: a plain `dict`. Output: a validated provider-native query object.
2. **Extract (data)** — do the I/O and *nothing else*. Hit the provider's HTTP API (async `httpx`),
   maybe fan out concurrent calls, return raw `list[dict]` / `dict`. **No renaming. No typing. No
   standard model.**
3. **Transform (data)** — map the provider's raw field names onto our standard field names (the alias
   map), coerce types, validate. This is the **only** stage where standard names and types appear.

The hard rule that makes it work: **a clean boundary between each stage.** Each stage has one job, one
input type, one output type, and is independently testable — so when a number is wrong you know *which*
stage broke (bad param mapping vs. bad fetch vs. bad alias/coercion), instead of staring at one 300-line
`fetch_and_parse()` blob.

The canonical statement of the pattern is OpenBB's own:

> *"Every provider has different words for the same thing, but OpenBB translates them in a standardized
> interface."*
> — [OpenBB, *The OpenBB Platform data pipeline — How we conquer financial data with TET*](https://openbb.co/blog/the-openbb-platform-data-pipeline)

**Our one divergence:** OpenBB's TET output flows *straight back to the user on their request* — a
fetch-through proxy that owns no data and is therefore "constrained by individual provider rate limits"
([OpenBB Providers docs](https://docs.openbb.co/odp/python/extensions/providers): *"OpenBB does not host or
serve any data…"*). **Ours flows into a worker that PERSISTS** into a time-series warehouse; the public read
path serves from *our* store, never re-hitting upstream on a user request. TET is our **write path**, not
our read path. §9 is the full treatment.

---

## 1. Why TET exists — the problem it solves

### 1.1 The N-dialects problem, concretely

Pick one universal fact: *"daily OHLCV for AAPL, 2024-01-01 to 2024-06-01."* Here is how three real
providers express the **request** and the **response** for that identical fact. (Param/field names below
are read from OpenBB provider source on `develop`; see citations.)

| Concept | OpenBB **standard** | FMP | Polygon | yfinance |
|---|---|---|---|---|
| ticker | `symbol` | `symbol` | `stocksTicker` (path segment) | `tickers` |
| range start | `start_date` | `from` | `from` (path) | `start` |
| range end | `end_date` | `to` | `to` (path) | `end` |
| bar interval | `interval` | `interval` | `timespan`+`multiplier` | `interval` |
| opening price | `open` | `adjOpen` (adjusted) | `o` | `Open` |
| closing price | `close` | `adjClose` (adjusted) | `c` | `Close` |
| volume | `volume` | `volume` | `v` | `Volume` |
| bar timestamp | `date` | `date` | `t` (epoch ms) | index `Date` |

Sources for the standard names: `repo:openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py`
(`symbol`, `start_date`, `end_date`, `date`, `open`, `high`, `low`, `close`, `volume`, `vwap`).
Sources for FMP's native names: `repo:openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py`
— verbatim `__alias_dict__ = {"start_date": "from", "end_date": "to"}` on the query and
`__alias_dict__ = {"open": "adjOpen", "high": "adjHigh", "low": "adjLow", "close": "adjClose"}` on the data.

Without a normalization layer, **every downstream consumer** — a chart, a screener, a backtest, an AI tool
— would have to know all N dialects and branch on `provider`. That is the cost TET removes: it pushes the
N-way knowledge into exactly one place per (endpoint × provider) pair, and hands everyone else **one
shape**.

### 1.2 Why a *pipeline*, not a function

You could write `def get_aapl(provider): ...` as one function that builds the URL, fetches, and parses. It
would work for one provider. It fails the moment you have forty providers and a hundred endpoints, because:

- **Errors are unlocalizable.** A wrong number could come from a bad param name (Transform-query bug), a
  bad fetch / wrong endpoint (Extract bug), or a bad field map / type coercion (Transform-data bug). In a
  monolith you cannot tell which. OpenBB's own words: the structure *"segregates errors, making them easier
  to spot."* ([data-pipeline blog](https://openbb.co/blog/the-openbb-platform-data-pipeline)).
- **You cannot test the stages in isolation.** With three pure-ish functions you can assert "given this
  param dict, transform_query produces this provider query," "given this query, extract returns raw rows,"
  "given these raw rows, transform_data produces validated standard rows" — independently. (OpenBB's
  `Fetcher.test()` does exactly this; §7.)
- **Async and sync get tangled.** The fetch (I/O-bound, should be `async`) and the parse (CPU-bound, pure)
  have different concurrency needs. Separating them lets the fetch fan out with `asyncio.gather` while the
  parse stays a simple pure transform.

> **First-principles framing.** TET is the *adapter pattern* (GoF) specialized for "many sources, one
> schema," with the adapter split along the **I/O boundary**: query-shaping and result-shaping are pure;
> only the middle stage touches the network. That split is what makes the pure stages trivially testable
> and the I/O stage independently mockable.

### 1.3 Where this lands in our architecture

In the data-analytics service, TET is the **ingest mechanism** of the **write path**. A scheduled worker
calls a Fetcher per (endpoint × provider), gets back validated standard rows, and **persists** them into
TimescaleDB + a Parquet distribution, stamping each series with `Provenance{commercialOk}`. The public read
API never runs a Fetcher on a user request. (Topology + storage decisions: `00-theory.md` "Selected
approach"; the persistence seam: `patterns-*.md`.)

---

## 2. The name: Transform → Extract → Transform (and why it is *not* ETL)

**TET = Transform (the query) → Extract (the data) → Transform (the data).**

It is deliberately **not** ETL. ETL is *Extract → Transform → Load*: you pull raw, you reshape, you load.
TET adds a **Transform *before* the Extract** — because for a *query API over heterogeneous providers* the
first problem is not "reshape the data," it is "**phrase the request in the provider's words**." You cannot
even fetch correctly until you have translated `start_date → from`, defaulted the missing range, and built
the pagination cursor. So:

- The **first T** transforms the *request* (standard → provider-native params).
- The **E** extracts the *raw response* (pure I/O).
- The **second T** transforms the *response* (provider-native → standard model).

OpenBB names the three stages, on the canonical blog, as:

> Stage 1 — *"the first stage of the pipeline, Transform Query, where every provider has different words for
> the same thing, but OpenBB translates them in a standardized interface."*
> Stage 2 — *"This stage is where the bulk of the work gets done, grabbing the data from the provider."*
> Stage 3 — *"the Transform Data stage … with standardized names and type enforcement applied … Data is
> guaranteed to be JSON serializable."*
> — [OpenBB data-pipeline blog](https://openbb.co/blog/the-openbb-platform-data-pipeline)

And in the architecture overview, equivalently:

> *"Transform: when the query arrives, the first step is to check if the parameters are valid and apply
> defaults. Extract: the provider accesses the external data source… Transform: validate the structure and
> apply additional transformations to the raw data, such as standardizing the date format or dropping
> specific fields."*
> — [OpenBB, *Exploring the architecture behind the OpenBB Platform*](https://openbb.co/blog/exploring-the-architecture-behind-the-openbb-platform)

> **The mnemonic that prevents the #1 confusion:** the two T's are **different transforms on different
> objects**. T1 transforms the *query* (a `dict` → a `QueryParams`). T2 transforms the *data* (raw rows →
> standard `Data` rows). Naming both "Transform" is intentional (it is the same *verb* — translate
> provider↔standard) but they never touch the same object, and conflating them (e.g. renaming fields in the
> middle Extract stage) is the canonical anti-pattern. See §4.4 and `patterns-*.md` anti-patterns.

---

## 3. The container: `Fetcher[Q, R]` — one class, three stages

The three stages are bound together in a single generic class. This is the verbatim OpenBB base
(`repo:openbb_platform/core/openbb_core/provider/abstract/fetcher.py`, `develop`, read at source level):

```python
"""Abstract class for the fetcher."""

from typing import Any, Generic, TypeVar, get_args, get_origin

from openbb_core.provider.abstract.annotated_result import AnnotatedResult
from openbb_core.provider.abstract.data import Data
from openbb_core.provider.abstract.query_params import QueryParams
from openbb_core.provider.utils.helpers import maybe_coroutine, run_async

Q = TypeVar("Q", bound=QueryParams)
D = TypeVar("D", bound=Data)
R = TypeVar("R")  # Return, usually List[D], but can be just D for example


class Fetcher(Generic[Q, R]):
    """Abstract class for the fetcher."""

    # Tell query executor if credentials are required. Can be overridden by subclasses.
    require_credentials = True

    @staticmethod
    def transform_query(params: dict[str, Any]) -> Q:
        """Transform the params to the provider-specific query."""
        raise NotImplementedError

    @staticmethod
    async def aextract_data(query: Q, credentials: dict[str, str] | None) -> Any:
        """Asynchronously extract the data from the provider."""

    @staticmethod
    def extract_data(query: Q, credentials: dict[str, str] | None) -> Any:
        """Extract the data from the provider."""

    @staticmethod
    def transform_data(query: Q, data: Any, **kwargs) -> R | AnnotatedResult[R]:
        """Transform the provider-specific data."""
        raise NotImplementedError

    def __init_subclass__(cls, *args, **kwargs):
        """Initialize the subclass."""
        super().__init_subclass__(*args, **kwargs)

        if cls.aextract_data != Fetcher.aextract_data:
            cls.extract_data = cls.aextract_data  # type: ignore[method-assign]
        elif cls.extract_data == Fetcher.extract_data:
            raise NotImplementedError(
                "Fetcher subclass must implement either extract_data or aextract_data"
                " method. If both are implemented, aextract_data will be used as the"
                " default."
            )

    @classmethod
    async def fetch_data(
        cls,
        params: dict[str, Any],
        credentials: dict[str, str] | None = None,
        **kwargs,
    ) -> R | AnnotatedResult[R]:
        """Fetch data from a provider."""
        query = cls.transform_query(params=params)
        data = await maybe_coroutine(
            cls.extract_data, query=query, credentials=credentials, **kwargs
        )
        return cls.transform_data(query=query, data=data, **kwargs)
```

### 3.1 What each piece means

- **`Generic[Q, R]`** — the Fetcher is parameterized by **two types**: `Q` (the query-params model, bound
  to `QueryParams`) and `R` (the return, *"usually `List[D]`, but can be just `D`"* — the comment is
  verbatim). A concrete fetcher reads like `class FMPEquityHistoricalFetcher(Fetcher[FMPEquityHistoricalQueryParams, list[FMPEquityHistoricalData]])`
  (`repo:.../providers/fmp/.../equity_historical.py`). The two type args **are the contract**: input shape
  and output shape are declared on the class, and the `test()` harness reflects on them via
  `__orig_bases__[0].__args__` (the `query_params_type` / `return_type` / `data_type` classproperties in
  the same file).
- **`require_credentials = True`** — a class flag telling the executor whether this provider needs an API
  key. Public-domain GREEN sources (SEC EDGAR, US Treasury, BLS) set it `False`. (For our build this also
  feeds the licensing path — a keyless public-domain source is the common shape of a `commercialOk: true`
  series.)
- **`transform_query` / `extract_data` / `aextract_data` / `transform_data`** — the three stages.
  `raise NotImplementedError` on T1 and T3 makes them **mandatory**; the extract pair is governed by
  `__init_subclass__` (§5.2). **All three are `@staticmethod`** — they carry no instance state; everything
  flows through the explicit `query` / `data` arguments. This is what keeps each stage a pure-ish function
  you can call and test in isolation.
- **`fetch_data` (the orchestrator)** — chains the three: `transform_query` → `maybe_coroutine(extract_data)`
  → `transform_data`. `maybe_coroutine` lets one orchestrator drive both sync and async extract (it awaits
  if the result is a coroutine, else returns directly). You never call the stages by hand in production; you
  call `fetch_data` (or our worker's wrapper around it).
- **`AnnotatedResult[R]`** — the return is `R | AnnotatedResult[R]`. `AnnotatedResult` lets `transform_data`
  return the rows **plus** out-of-band metadata (warnings, a "chart" payload, extra provenance) without
  polluting the row model. For our build this is the natural carrier for per-fetch provenance/`commercialOk`
  and partial-failure warnings. (Don't shove provenance into the row model; attach it here.)

### 3.2 Why a class and not three loose functions

The class is a **namespace + type contract + test harness** bound to one (endpoint × provider) pair:

- it pins `Q` and `R` so the stages share a typed query and the executor knows the output type;
- it gives `__init_subclass__` a place to enforce "implement exactly one of extract/aextract";
- it gives `test()` a place to run the whole TET against live params with stage-by-stage assertions;
- it is the unit the **registry** maps (standard-model key → Fetcher class), which is how "connect once,
  consume everywhere" works (one Fetcher feeds REST + SDK + CLI + MCP). ([architecture overview](https://docs.openbb.co/odp/python/developer/architecture_overview):
  one core, *"both Python Interface and REST API — share core logic and models."*)

---

## 4. Stage 1 — `transform_query`: standard params → provider-native params

**Contract.**

| | |
|---|---|
| **Signature** | `@staticmethod def transform_query(params: dict[str, Any]) -> Q` |
| **Input** | a plain `dict` of *standard* params (`{"symbol": "AAPL", "start_date": None, ...}`) |
| **Output** | a validated **provider-native** `QueryParams` subclass instance (`Q`) |
| **May do** | apply defaults; rename standard→native (`start_date→from`); build pagination params; validate cross-field constraints |
| **Must NOT do** | any network I/O; any data fetching; touch the response |
| **Purity** | pure + deterministic (given the same `params`, same `Q`) — no clock-dependence except explicit "default to now/1y-ago" |

### 4.1 The three jobs of T1

**(a) Defaulting.** Standard params arrive sparse (the user gave a symbol, not a date range). T1 fills the
gaps. Verbatim from FMP (`repo:.../fmp/.../equity_historical.py`):

```python
@staticmethod
def transform_query(params: dict[str, Any]) -> FMPEquityHistoricalQueryParams:
    """Transform the query params."""
    transformed_params = params
    now = datetime.now().date()
    if params.get("start_date") is None:
        transformed_params["start_date"] = now - relativedelta(years=1)
    if params.get("end_date") is None:
        transformed_params["end_date"] = now
    return FMPEquityHistoricalQueryParams(**transformed_params)
```

Note: the **standard** names (`start_date`, `end_date`) are still in use here. The rename to native words
happens **at serialization time**, not in this method (§4.2). T1's body works in standard names and the
model carries the alias map.

**(b) Renaming standard → native** — done declaratively via `__alias_dict__` on the QueryParams subclass,
not imperatively in the method body. From FMP:

```python
class FMPEquityHistoricalQueryParams(EquityHistoricalQueryParams):
    __alias_dict__ = {"start_date": "from", "end_date": "to"}
    __json_schema_extra__ = {"symbol": {"multiple_items_allowed": True}}
    interval: Literal["1m","5m","15m","30m","1h","4h","1d"] = Field(default="1d", ...)
    adjustment: Literal["splits_only","splits_and_dividends","unadjusted"] = Field(default="splits_only", ...)
```

The mechanism (verbatim, `repo:.../provider/abstract/query_params.py`): the base `QueryParams` overrides
`model_dump` to apply the alias map on the way *out*:

```python
model_config = ConfigDict(extra="allow", populate_by_name=True)

def model_dump(self, *args, **kwargs):
    """Dump the model."""
    original = super().model_dump(*args, **kwargs)
    if self.__alias_dict__:
        return {
            self.__alias_dict__.get(key, key): value
            for key, value in original.items()
        }
    return original
```

So when the Extract stage does `query.model_dump()` to build the URL query-string, `start_date` becomes
`from` and `end_date` becomes `to` **automatically**. The fetcher author writes `start_date` everywhere in
Python and the provider sees `from` on the wire. (Note the asymmetry with the `Data` model, §6.2: query
aliasing renames standard→native on **dump**; data aliasing renames native→standard on **load**.)

**(c) Pagination params.** Many providers page (cursor or offset/limit). T1 is where you set up the initial
page params (`limit`, `cursor=None`); the *iteration* over pages happens in Extract (§5.4), but the
*shape* of a page request is fixed here. (For a provider with `max 20 expressions/request`, T1 chunks the
symbol list into 20-symbol batches; the chunk loop runs in Extract.)

**(d) Cross-field validation.** T1 (via the model's validators) rejects impossible combinations *before*
any fetch. FMP's example forbids adjustment on intraday bars:

```python
@model_validator(mode="before")
@classmethod
def _validate_params(cls, values: dict) -> dict:
    interval = values.get("interval", "1d")
    adjustment = values.get("adjustment", "splits_only")
    if adjustment != "splits_only" and interval != "1d":
        raise ValueError("Adjustment can only be applied to daily ('1d') interval.")
    return values
```

This is the cheapest possible failure: invalid params die at T1 with a clear message, never burning a
network round-trip.

### 4.2 The standard model the provider QueryParams subclasses

The provider QueryParams **inherits** from a *standard* model that defines the canonical param names. From
`repo:.../standard_models/equity_historical.py`:

```python
class EquityHistoricalQueryParams(QueryParams):
    """Equity Historical Price Query."""
    symbol: str = Field(description=QUERY_DESCRIPTIONS.get("symbol", ""))
    start_date: dateType | None = Field(default=None, description=QUERY_DESCRIPTIONS.get("start_date", ""))
    end_date: dateType | None = Field(default=None, description=QUERY_DESCRIPTIONS.get("end_date", ""))

    @field_validator("symbol", mode="before", check_fields=False)
    @classmethod
    def to_upper(cls, v: str) -> str:
        return v.upper()
```

The **standard** model is the contract everyone codes against; the **provider** subclass adds provider-only
params (`interval`, `adjustment`) and the alias map. This inheritance is *why* a consumer can swap providers
without changing the call — the standard param surface is identical; only the subclass and its alias map
differ. (How the standard model itself is *derived* — the field-intersection rule across ≥2 providers — is
covered in `patterns-standard-models.md`; here it is enough to know it exists and that providers subclass
it.)

### 4.3 What T1 buys you

- **Fail-fast on bad input** before any I/O (cheapest error).
- **One place per provider** that knows its param dialect; the rest of the system speaks standard.
- **Deterministic, pure** → trivially unit-testable: `assert transform_query({"symbol":"aapl"}).symbol == "AAPL"` and `assert ...start_date == one_year_ago`.

### 4.4 The boundary T1 must not cross

T1 **never fetches**. If you find an `httpx.get` or `requests` call in `transform_query`, the stage
boundary is broken and you have re-created the unlocalizable monolith. The output of T1 is *a description of
the request*, not the response.

---

## 5. Stage 2 — `extract_data` / `aextract_data`: raw fetch ONLY

**Contract.**

| | |
|---|---|
| **Signature (async, preferred)** | `@staticmethod async def aextract_data(query: Q, credentials: dict[str,str] \| None, **kwargs) -> Any` |
| **Signature (sync)** | `@staticmethod def extract_data(query: Q, credentials: dict[str,str] \| None, **kwargs) -> Any` |
| **Input** | the validated provider-native `Q` + the credentials dict |
| **Output** | **raw** data — `list[dict]` or `dict` (the provider's JSON, untouched in name/shape) |
| **May do** | build the URL from `query.model_dump()`; async `httpx` fetch; concurrent `asyncio.gather`; paginate; light unwrapping (pull the `"results"` array out of an envelope); attach the symbol to each row for multi-symbol calls |
| **Must NOT do** | rename fields to standard names; coerce/validate types; construct the standard `Data` model |
| **Concurrency** | I/O-bound → async; fan out multiple symbols/pages with `asyncio.gather` |

### 5.1 "Raw fetch ONLY" — the load-bearing rule

Extract returns the provider's response **as-is**: provider field names, provider types, provider envelope
(minus a light unwrap to the rows array). This is enforced *structurally* by OpenBB's own `test()` harness,
which **asserts the data is NOT yet a standard model** at the end of Extract (verbatim from `fetcher.py`):

```python
assert (
    issubclass(type(data[0]), cls.data_type) is False
), f"Data must not be transformed yet. Expected: {cls.data_type} Got: {type(data[0])}"
```

Read that twice: the framework *fails the test* if Extract returns typed standard rows. The rule "Extract
returns raw, Transform-data returns standard" is not a style preference — it is asserted in the test
harness. (Why: if Extract both fetches *and* normalizes, you are back to the monolith — you cannot tell a
fetch bug from an alias bug, and you cannot mock the network seam cleanly.)

### 5.2 Sync vs async: exactly one must exist

`__init_subclass__` (verbatim in §3) enforces:

- If you implement `aextract_data`, it is copied over `extract_data` and used as the default.
- If you implement neither, subclass construction **raises** `NotImplementedError("Fetcher subclass must
  implement either extract_data or aextract_data method…")`.
- If you implement both, `aextract_data` wins.

**Prefer `aextract_data`.** Market-data extract is I/O-bound (HTTP); async lets one worker fan out dozens of
provider calls concurrently instead of serializing them. Use sync `extract_data` only for genuinely
blocking sources with no async client (some local-file or legacy-driver reads).

### 5.3 The real `httpx` async pattern (multi-symbol gather)

OpenBB's FMP fetcher delegates the actual I/O to a helper; the helper is the part worth studying because it
is the canonical "fetch many, return raw" shape (read from `repo:.../fmp/openbb_fmp/utils/helpers.py`):

```python
# Concurrent fan-out, one request per symbol:
results = await asyncio.gather(*[get_one(symbol) for symbol in symbols])

# Each get_one builds the provider URL and fetches raw:
#   base_url += "historical-price-eod/full?"      (daily)
#   base_url += "historical-chart/1min?"          (1-minute bars)
#   url = base_url + f"symbol={symbol}&{query_str}&apikey={api_key}"
#   response = await amake_request(url, response_callback=response_callback, **kwargs)

# Light unwrap of the provider envelope, NO renaming:
#   if isinstance(response, list) and len(response) > 0:
#       data = response
#   elif isinstance(response, dict) and response.get("historical"):
#       data = response.get("historical", [])
#   for d in data:
#       d["symbol"] = symbol          # attach symbol; still raw provider field names
#       results.append(d)
# returns list[dict]
```

The fetcher's `aextract_data` is then a thin wrapper (verbatim, `repo:.../fmp/.../equity_historical.py`):

```python
@staticmethod
async def aextract_data(
    query: FMPEquityHistoricalQueryParams,
    credentials: dict[str, str] | None,
    **kwargs: Any,
) -> list[dict]:
    """Return the raw data from the FMP endpoint."""
    from openbb_fmp.utils.helpers import get_historical_ohlc
    return await get_historical_ohlc(query, credentials, **kwargs)
```

What the helper does and does **not** do is the whole lesson:
- **Does:** build the provider URL, pull the API key from `credentials`, fetch concurrently per symbol,
  unwrap the `"historical"` / list envelope, stamp each row with its `symbol`.
- **Does NOT:** rename `adjClose → close`, coerce `t` epoch-ms to a `date`, or build `FMPEquityHistoricalData`.
  Those are T3's job. The rows leaving Extract still say `adjClose`, `adjOpen`, etc.

### 5.4 Pagination and multi-call inside Extract

Two fan-out shapes both live in Extract (never in T1, never in T3):

- **Symbol fan-out** — `asyncio.gather(*[get_one(s) for s in symbols])` (above). Concatenate the per-symbol
  lists into one flat `list[dict]`.
- **Cursor/offset pagination** — loop: fetch page → read `next` cursor (or detect a short page) → fetch
  next → until exhausted, concatenating rows. For a provider capped at *"max 20 expressions/request,
  ~0.2s rate-limit delay"* (DataQuery's real shape, `00-theory.md` Tier-1), Extract chunks the request and
  paces the loop. The rate-limit *pacing* lives here because it is part of the I/O; the standard model never
  sees it.

> **`**kwargs` threads through.** Note `extract_data`/`transform_data`/`fetch_data` all carry `**kwargs`.
> That is how cross-cutting concerns (a shared `httpx` client/session, a request-budget token, a timeout)
> are injected without changing the stage signatures.

### 5.5 Why Extract must be I/O-pure (no normalization)

Three concrete payoffs:
1. **Mockability** — to test the rest, you mock *one* function (`aextract_data`) with a captured raw JSON
   fixture. If Extract also normalized, your fixture would have to be post-normalization and you'd never test
   the alias map.
2. **Error localization** — a 401/429/timeout is unambiguously an Extract failure; a wrong field name is
   unambiguously a T3 failure. The boundary is the diagnostic.
3. **Reuse** — the same raw fetch helper serves multiple endpoints/intervals (FMP's helper handles daily
   *and* 1-minute by URL switch); normalization differs per endpoint and stays in each endpoint's T3.

---

## 6. Stage 3 — `transform_data`: raw → validated standard-model rows

**Contract.**

| | |
|---|---|
| **Signature** | `@staticmethod def transform_data(query: Q, data: Any, **kwargs) -> R \| AnnotatedResult[R]` |
| **Input** | the raw `data` from Extract (provider field names/types) + the original `query` (for context-sensitive sorting/derivation) |
| **Output** | validated **standard-model** rows: `list[D]` (or `D`), or `AnnotatedResult[R]` with metadata |
| **May do** | apply the alias map (native→standard names); coerce types (epoch→date, str→float, %→fraction); validate; sort; derive trivial fields; **raise `EmptyDataError` on no rows** |
| **Must NOT do** | any network I/O (the data is already in hand) |
| **The rule** | **this is the ONLY stage where standard names and standard types appear** |

### 6.1 The canonical T3 body

Verbatim from FMP (`repo:.../fmp/.../equity_historical.py`):

```python
@staticmethod
def transform_data(
    query: FMPEquityHistoricalQueryParams, data: list[dict], **kwargs: Any
) -> list[FMPEquityHistoricalData]:
    """Return the transformed data."""
    if not data:
        raise EmptyDataError("No data returned from FMP for the given query.")
    return [
        FMPEquityHistoricalData.model_validate(d)
        for d in sorted(
            data,
            key=lambda x: (
                (x["date"], x["symbol"])
                if len(query.symbol.split(",")) > 1
                else x["date"]
            ),
            reverse=False,
        )
    ]
```

Three things happen, in order:
1. **Empty guard** — no rows → `raise EmptyDataError`. (This becomes a typed `unavailable` in our build, per
   non-negotiable #1: a failed/empty fetch returns a typed absence, **never** a fabricated value.)
2. **Sort** — deterministic ordering (note it uses `query.symbol` to decide single- vs multi-symbol sort
   key — this is *why* T3 receives the `query`, not just the data).
3. **`model_validate(d)` per row** — this single call triggers the alias map + type coercion + validation
   (next section). The list comprehension turns `list[dict]` → `list[FMPEquityHistoricalData]`.

### 6.2 How the alias + coercion actually fires

`model_validate(d)` runs the standard `Data` base model's machinery. Verbatim from
`repo:.../provider/abstract/data.py`:

```python
model_config = ConfigDict(
    extra="allow",
    populate_by_name=True,
    strict=False,
    alias_generator=AliasGenerator(
        validation_alias=alias_generators.to_camel,
        serialization_alias=alias_generators.to_snake,
    ),
)

@model_validator(mode="before")
@classmethod
def _use_alias(cls, values):
    """Use alias for error locs."""
    aliases = {orig: alias for alias, orig in cls.__alias_dict__.items()}
    if aliases and isinstance(values, dict):
        return {aliases.get(k, k): v for k, v in values.items()}
    return values
```

So for a raw FMP row `{"adjClose": 187.4, "adjOpen": 186.1, ...}` and the data model's
`__alias_dict__ = {"open": "adjOpen", "high": "adjHigh", "low": "adjLow", "close": "adjClose"}`:

1. `_use_alias` **inverts** the alias dict (`{"adjOpen": "open", "adjClose": "close", ...}`) and renames the
   incoming keys → `{"close": 187.4, "open": 186.1, ...}`.
2. Field validators coerce types (e.g. FMP's `change_percent` validator divides by 100 to normalize a
   percent into a fraction; the standard `date` validator `isoparse`s a timestamp or `parse`s a date).
3. Pydantic validates against the standard model's typed fields.
4. `extra="allow"` keeps any provider-only fields that have no standard slot (the **typed-extension escape
   hatch** — pure field-intersection would *lose* them; this preserves richness, which is the documented
   fix for "normalization loses data and pushes analysts back to raw fields").

> **The two alias directions (do not confuse them):**
> - **QueryParams** (T1): standard→native on **`model_dump`** (we *send* native words). §4.1(b).
> - **Data** (T3): native→standard on **`model_validate`** (we *receive* native words and store standard).
>
> Same `__alias_dict__` convention, opposite direction, opposite stage. Memorize this; mixing them is a
> common bug.

### 6.3 The standard Data model T3 produces

The provider Data subclass extends the standard one (`repo:.../standard_models/equity_historical.py`):

```python
class EquityHistoricalData(Data):
    """Equity Historical Price Data."""
    date: dateType | datetime = Field(description=DATA_DESCRIPTIONS.get("date", ""))
    open: float = Field(description=DATA_DESCRIPTIONS.get("open", ""))
    high: float = Field(description=DATA_DESCRIPTIONS.get("high", ""))
    low: float = Field(description=DATA_DESCRIPTIONS.get("low", ""))
    close: float = Field(description=DATA_DESCRIPTIONS.get("close", ""))
    volume: float | int | None = Field(default=None, description=DATA_DESCRIPTIONS.get("volume", ""))
    vwap: float | None = Field(default=None, description=DATA_DESCRIPTIONS.get("vwap", ""))

    @field_validator("date", mode="before", check_fields=False)
    @classmethod
    def date_validate(cls, v):
        from dateutil import parser
        if ":" in str(v):
            return parser.isoparse(str(v))
        return parser.parse(str(v)).date()
```

After T3, **every provider's** equity-historical rows are `EquityHistoricalData` with identical names and
types. That uniformity is the entire product of TET. The OpenBB guarantee: *"Data is guaranteed to be JSON
serializable"* and field names are *"lower_snake_case"* across all sources ([data-pipeline blog](https://openbb.co/blog/the-openbb-platform-data-pipeline)).

### 6.4 `AnnotatedResult` — rows + metadata

When T3 needs to return more than rows (warnings, partial-failure notes, a derived chart payload, or — in
**our** build — the per-fetch provenance/`commercialOk` record), it returns `AnnotatedResult[R]` instead of
bare `R`. The orchestrator and `test()` both handle either (`test()` unwraps via
`result.result if isinstance(result, AnnotatedResult) else result`). Keep the **row model clean** (pure data
facts) and put cross-cutting metadata on the AnnotatedResult — do not pollute `EquityHistoricalData` with a
`commercialOk` field.

### 6.5 Why T3 owns *all* typing

If types lived in Extract, you'd validate before you knew the standard shape and couldn't reuse one raw
fetch across endpoints. If types lived in T1, you'd be typing the *request*, not the *response*. Pinning all
name-mapping + coercion + validation to T3 means: **one place to look when a value is wrong**, and the raw
Extract output stays a faithful, mockable record of what the provider actually returned.

---

## 7. The hard boundary between stages — and the `test()` that enforces it

The value of TET is *entirely* in the **boundaries** between stages. OpenBB encodes the boundaries as
assertions in `Fetcher.test()` (verbatim, `repo:.../abstract/fetcher.py`). The harness runs the full TET
against live params and asserts each stage's contract:

**Stage-1 (query) assertions:**
```python
query = cls.transform_query(params=params)
assert query, "Query must not be None."
assert issubclass(type(query), cls.query_params_type), "Query type mismatch…"
assert all(getattr(query, key) == value for key, value in params.items()), \
    "Query must have the correct values…"
```
→ T1 produced a `Q` of the right type whose fields reflect the input params.

**Stage-2 (raw data) assertions:**
```python
data = run_async(cls.extract_data, query=query, credentials=credentials, **kwargs)
assert data, "Data must not be None."
# fields present under provider OR standard names:
assert all(field in data[0] for field in cls.data_type.model_fields if field in data[0]), \
    "Data must have the correct fields…"
# the load-bearing boundary check — raw, NOT yet standardized:
assert issubclass(type(data[0]), cls.data_type) is False, \
    "Data must not be transformed yet…"
assert len(data) > 0, "Data must not be empty."
```
→ Extract returned **raw rows that are NOT yet the standard model**. This single assertion is the codified
rule "Extract does not normalize."

**Stage-3 (transformed data) assertions:**
```python
result = cls.transform_data(query=query, data=data, **kwargs)
transformed_data = result.result if isinstance(result, AnnotatedResult) else result
assert transformed_data, "Transformed data must not be None."
assert len(transformed_data) > 0, "Transformed data must not be empty."
assert all(field in transformed_data[0].__dict__ for field in return_type_fields), \
    "Transformed data must have the correct fields…"
assert issubclass(type(transformed_data[0]), cls.data_type), \
    "Transformed data must be of the correct type…"
```
→ T3 produced rows that **ARE** instances of the standard `Data` type, with the standard fields.

The symmetry is the whole point: **after Extract, `issubclass(..., data_type) is False`; after Transform-
data, `issubclass(..., data_type) is True`.** The boundary between "raw" and "standard" is the literal line
the test asserts. If you ever feel tempted to normalize in Extract, this assertion will fail — and it is
*right* to fail you.

### 7.1 What the boundaries buy (summary table)

| Property | Mechanism | Payoff |
|---|---|---|
| **Error localization** | each stage one job, one I/O surface | a wrong number ⇒ exactly one suspect stage |
| **Independent testability** | pure T1/T3 + mockable E | unit-test each stage with fixtures; `test()` runs all three |
| **Mock seam** | E is the only I/O | one function to mock; deterministic offline tests |
| **Reuse** | E provider-helper shared across endpoints | one fetch helper, many endpoints' T3 |
| **Concurrency isolation** | async lives only in E | T1/T3 stay simple pure functions |
| **Type contract** | `Fetcher[Q, R]` + standard models | the executor/registry knows in/out types statically |

---

## 8. End-to-end trace (one request through the three stages)

Take `equity.price.historical("aapl", provider="fmp")` with no dates:

```
INPUT dict (standard):           {"symbol": "aapl"}
                                          │
              ┌───────────────────────────▼───────────────────────────┐
   STAGE 1    │ transform_query(params)                                │
   Transform  │  • to_upper → "AAPL"                                   │
   (query)    │  • default start_date = today − 1y, end_date = today   │
              │  • validate (adjustment×interval rule)                 │
              │  → FMPEquityHistoricalQueryParams(symbol="AAPL", …)    │
              └───────────────────────────┬───────────────────────────┘
                                          │  query.model_dump() →
                                          │  {"symbol":"AAPL","from":"2023-…","to":"2024-…"}   (native words!)
              ┌───────────────────────────▼───────────────────────────┐
   STAGE 2    │ aextract_data(query, credentials)                      │
   Extract    │  • build URL …/historical-price-eod/full?symbol=AAPL&from=…&to=…&apikey=… │
   (raw I/O)  │  • async httpx GET (gather if many symbols)            │
              │  • unwrap envelope → list[dict]                        │
              │  → [{"date":"2024-…","adjOpen":186.1,"adjClose":187.4,…}, …]  (RAW provider names) │
              └───────────────────────────┬───────────────────────────┘
                                          │  (test() asserts: NOT yet EquityHistoricalData)
              ┌───────────────────────────▼───────────────────────────┐
   STAGE 3    │ transform_data(query, data)                            │
   Transform  │  • EmptyDataError if no rows                           │
   (data)     │  • sort by date                                        │
              │  • model_validate per row:                             │
              │      _use_alias inverts {open:adjOpen,…} → renames     │
              │      validators coerce (date parse, % normalize)       │
              │  → [EquityHistoricalData(date=…, open=186.1, close=187.4, …), …]  (STANDARD) │
              └───────────────────────────┬───────────────────────────┘
                                          ▼
OUTPUT: list[EquityHistoricalData]  ── identical shape for FMP, Polygon, yfinance, …
```

In OpenBB this list goes **back to the user** (proxy). **In our build, it goes to §9.**

---

## 9. The ONE divergence from OpenBB — proxy vs. stored DaaS (our write path)

This is the most important section in the document. Everything above (the TET mechanism) we **copy**.
Where the TET output **goes** we **change**.

### 9.1 OpenBB is a fetch-through proxy that owns no data

OpenBB's own primary docs, verbatim:

> *"OpenBB does not host or serve any data, and it provides connectors without warranty or support."*
> — [OpenBB Providers docs](https://docs.openbb.co/odp/python/extensions/providers)

> *"Provider extensions expand the breadth and coverage of the data available from the application
> endpoints. Each source (provider) is its own independent extension…"*
> — same page

> *"The precise naming convention will differ by source, it's best to reference each source's own
> documentation for conventions."*
> — [OpenBB Data Providers FAQ](https://docs.openbb.co/odp/python/faqs/data_providers)
> (This is also OpenBB's explicit *non-solution* to symbology — it passes provider symbols through and
> maintains **no security master**. Net-new for us; see §9.4.)

Architecturally: a user request → `Fetcher.fetch_data` → **live upstream HTTP call** → response back to the
user. OpenBB stores nothing. Therefore its throughput is **bounded by the upstream provider's rate limits
and uptime** — if the provider is down or you've burned its free-tier quota, OpenBB returns nothing. This is
fine for a *desktop research tool* (one analyst, occasional calls). It is **fatal** for a Data-as-a-Service
at spike scale.

### 9.2 DataQuery (what we re-engineer) owns the bytes

The incumbent we are rebuilding is the architectural opposite. DataQuery's own scale shape
(`00-theory.md` Tier-1, fetched verbatim from [jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery)):
`130m+ historical time series`, `4 billion+ hits per year — 75% API`, `350+ batch files delivered per day`.
You cannot serve **4 billion hits/year** by proxying to upstream vendors on each hit — every vendor would
throttle you to zero in minutes. DataQuery serves those hits from **its own materialized store**, decoupled
from any upstream's rate limit or uptime. That is **compute-once-store-serve**.

### 9.3 The divergence, precisely: TET is our WRITE path, not our READ path

```
OpenBB (proxy):
  user request ─▶ Fetcher.fetch_data ─▶ LIVE upstream HTTP ─▶ response
                 (bound by upstream rate limit; stores nothing)

OURS (stored DaaS):
  WRITE path (off the request path, on a worker/cron — repo non-negotiable #4):
    scheduler ─▶ Fetcher.fetch_data (TET) ─▶ list[StandardData]
              ─▶ PERSIST into TimescaleDB + materialize a Parquet distribution
              ─▶ stamp Provenance{commercialOk} per series

  READ path (the public API):
    user request ─▶ serve from OUR store + Redis cache  (NEVER upstream)
                 ─▶ discovery = structured/faceted over indexed metadata
```

The TET pipeline is **identical** to OpenBB's; the difference is its **sink**. In OpenBB the sink is the
HTTP response. **In ours the sink is `persist()`** — TET feeds a worker that writes normalized, stamped
series into the warehouse, and the read path never touches a Fetcher. This is the design fix for
`00-theory.md` **CRITICAL-2** ("Copy OpenBB wholesale imports a non-storage proxy into a stored-DaaS
requirement"), quoted there:

> *"OpenBB supplies **only the normalization/ingest pattern** (the write path: fetch → normalize →
> persist). The read path is a materialized store + cache (DataQuery's actual shape). … the public API
> serves from store + Redis (compute-once-serve-many) and never fetch-throughs to upstream on a user
> request."*

### 9.4 Two corollaries of the divergence

- **The security master is ours to build.** OpenBB passes provider symbols through (the FAQ quote in §9.1).
  A *stored* catalog that must join Provider A's `AAPL` to Provider B's ISIN `US0378331005` for the *same
  logical series* needs a security-master/symbology cross-walk OpenBB does not provide. TET's T3 is where a
  provider symbol is **resolved to our canonical instrument id** before persistence — the seam where the
  security master plugs in. (`00-theory.md` CRITICAL-3; build recipe in `patterns-*.md`.)
- **The licensing stamp is ours to attach, at the fetch path.** Because we persist, we must record *where
  each stored series came from* and *whether we may display it commercially*. The `commercialOk` verdict
  attaches to the **fetch path, not the concept** (Lumina's [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)):
  the 10Y treasury yield from treasury.gov is GREEN; the same number from Yahoo's chart API is RED. This is
  carried on the `AnnotatedResult` (§6.4) at write time and stored with the series. OpenBB, being a proxy
  that stores nothing, has no equivalent — it never *redistributes*, so it never needs the verdict. **We
  do.**

### 9.5 The falsifiability test for "did we actually diverge?"

From `00-theory.md`, the test that proves we built the store and not the proxy:

> *"Run a read-spike load test … against the store+cache **with all upstream providers disconnected**. If
> the read path cannot serve at target latency with providers offline, the design has silently regressed to
> a fetch-through proxy and CRITICAL-2 was not actually fixed."*

If you can pull the upstream plug and the read path keeps serving, TET-as-write-path is real. If the read
path goes dark, someone wired a Fetcher into a user request — the exact failure this divergence exists to
prevent.

---

## 10. Anti-patterns (the boundary violations, each with its fix)

| Mistake | Why it breaks | Fix |
|---|---|---|
| **Fetch inside `transform_query`** | Re-creates the monolith; a 401 now looks like a param bug; T1 no longer pure/testable | T1 only shapes the *request* (`Q`). All I/O is in Extract. |
| **Rename/type fields inside `extract_data`** | Breaks the "raw" boundary (`test()` asserts `issubclass(data[0], data_type) is False`); can't tell a fetch bug from an alias bug; can't reuse the raw fetch across endpoints | Extract returns raw `list[dict]`. All renaming/coercion in T3 via `__alias_dict__` + validators. |
| **Network I/O inside `transform_data`** | Data is already in hand; an I/O failure here is unattributable; T3 stops being pure | T3 only maps/coerces/validates the `data` it was given. |
| **Imperative renaming in a stage body** (`row["open"] = row.pop("adjOpen")`) | Bypasses the declarative alias map; drift between query-dump aliasing and data-load aliasing; untestable in isolation | Declare `__alias_dict__` on the model; let `model_dump` (query) / `_use_alias` (data) apply it. |
| **Confusing the two alias directions** | Query aliases standard→native on dump; Data aliases native→standard on load. Mixing them sends standard words to the provider or stores native words | Memorize §6.2: dump=send-native, load=receive-native. |
| **Returning a fabricated value on empty/failed fetch** | Violates non-negotiable #1 ("never invent a finance number") | `raise EmptyDataError` in T3 → typed `unavailable`/`needsKey`, never a backfilled number. |
| **Implementing both `extract_data` and `aextract_data` and expecting sync** | `__init_subclass__` makes `aextract_data` win silently | Implement exactly one; prefer async for HTTP. |
| **Wiring a Fetcher into the read/user-request path** | Re-creates OpenBB's proxy; melts on a read spike / upstream throttle (§9) | TET runs in the **worker/write path** only; reads serve from the store + cache. |
| **Per-row Pydantic on a 100M-row bulk pull** | Pydantic model construction is ~6.5× slower than dataclasses; validation dominates on thin bulk paths (`00-theory.md` MAJOR/Pydantic-cost) | Per-row `model_validate` is correct for *ingest-time* normalization (bounded batches); the *bulk read/distribution* path uses Arrow/columnar batch transport, **not** per-row models. Different path, different tool. |

---

## 11. Mental model checklist (use before writing any Fetcher)

- [ ] **Two type args chosen:** `Fetcher[ProviderQueryParams, list[ProviderData]]` — the in/out contract.
- [ ] **T1 is pure:** renames via `__alias_dict__` on the QueryParams; defaults + cross-field validation;
      **no I/O**.
- [ ] **The standard QueryParams subclassed:** provider params extend the standard model; only the subclass
      knows the dialect.
- [ ] **Exactly one of `extract_data` / `aextract_data`** — prefer async; raw `list[dict]` out; **no
      renaming/typing**; concurrency (`gather`) + pagination + rate-pacing live here.
- [ ] **T3 is the only typed stage:** `model_validate` per row applies the data `__alias_dict__`
      (native→standard) + coercion + validation; `EmptyDataError` on no rows; sort deterministically;
      `AnnotatedResult` for metadata (incl. our `commercialOk`).
- [ ] **The boundary holds:** after Extract `issubclass(row, StandardData) is False`; after T3 it is `True`.
- [ ] **The sink is `persist()`, not the HTTP response** — TET runs in the **worker/write path**; the read
      path serves from the store. (Our divergence from OpenBB.)
- [ ] **Provenance attached at the fetch path** — `commercialOk` default `false`, GREEN only when the fetch
      path is public-domain / CC / purchased.

---

## 12. Sources (read this run, at source level where cited `repo:`)

**OpenBB primary docs / blog (the TET pattern):**
- [The OpenBB Platform data pipeline — How we conquer financial data with TET](https://openbb.co/blog/the-openbb-platform-data-pipeline) — canonical stage descriptions; *"Every provider has different words for the same thing…"*; *"segregates errors"*; *"Data is guaranteed to be JSON serializable."*
- [Exploring the architecture behind the OpenBB Platform](https://openbb.co/blog/exploring-the-architecture-behind-the-openbb-platform) — *"Transform … check if the parameters are valid and apply defaults. Extract … Transform: validate the structure…"*; one core → REST/SDK/CLI.
- [Architecture Overview — OpenBB Docs](https://docs.openbb.co/odp/python/developer/architecture_overview) — Fetcher three stages; QueryParams/Data standard models; registry via entry points; *"both Python Interface and REST API — share core logic and models."*
- [Build Provider Extensions — OpenBB Docs](https://docs.openbb.co/python/developer/extension_types/provider) — Fetcher imposes Transform-query (→QueryParams child) → Extract (→`Any`/dict) → Transform-data (→`List[Data]`/`Data` child); `__alias_dict__` maps output fields to provider input names.
- [Providers — OpenBB Docs](https://docs.openbb.co/odp/python/extensions/providers) — *"OpenBB does not host or serve any data, and it provides connectors without warranty or support."*; provider = independent removable extension.
- [Data Providers FAQ — OpenBB Docs](https://docs.openbb.co/odp/python/faqs/data_providers) — *"The precise naming convention will differ by source…"* (the no-security-master non-solution).

**OpenBB source (read on `develop`, `repo:` = `OpenBB-finance/OpenBB`):**
- `openbb_platform/core/openbb_core/provider/abstract/fetcher.py` — verbatim `Fetcher[Q,R]`, `transform_query`/`extract_data`/`aextract_data`/`transform_data`, `__init_subclass__`, `fetch_data`, the `test()` TET assertions (incl. *"Data must not be transformed yet."*).
- `openbb_platform/core/openbb_core/provider/abstract/query_params.py` — base `QueryParams`; `model_dump` applies `__alias_dict__` standard→native.
- `openbb_platform/core/openbb_core/provider/abstract/data.py` — base `Data`; `model_config` (`extra="allow"`, `populate_by_name`, `AliasGenerator`); `_use_alias` validator inverts `__alias_dict__` native→standard.
- `openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py` — standard `EquityHistoricalQueryParams` / `EquityHistoricalData` (the canonical OHLCV contract).
- `openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py` — real provider Fetcher: `__alias_dict__ = {"start_date":"from","end_date":"to"}` (query) and `{"open":"adjOpen",...}` (data); the three concrete stage bodies.
- `openbb_platform/providers/fmp/openbb_fmp/utils/helpers.py` — `get_historical_ohlc`: async `httpx` fetch, `asyncio.gather` per symbol, envelope unwrap, raw `list[dict]` out (no renaming).

**Project (the divergence + the incumbent we re-engineer):**
- [`financial-data-analytics-service/00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md) — CRITICAL-2 (proxy-vs-stored), CRITICAL-3 (security master net-new), the selected write/read split, the falsifiability tests, DataQuery scale shape.
- [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) — the licensing stamp attaches to the fetch path, not the concept; `commercialOk` default `false`.

---

> **Where to go next.** This doc is the *why* and the stage *contracts*. For the concrete build — our
> Python package layout, the worker that calls `fetch_data` and `persist()`, how the security master plugs
> into T3, and how `commercialOk` rides the `AnnotatedResult` into storage — read the `patterns-*.md`
> references in this skill.
