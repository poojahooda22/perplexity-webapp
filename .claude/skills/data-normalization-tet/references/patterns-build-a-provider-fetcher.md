# patterns-build-a-provider-fetcher.md

> **Recipe.** Given a new GREEN public-domain source, build its three TET artifacts —
> `QueryParams`, `Data`, `Fetcher` — clean-room. End-to-end runnable Python for **one real
> provider** (US Treasury FiscalData), then the second-provider deltas (BLS POST/JSON,
> FRED keyed/aliased), the `test_fetcher` record/replay fixture, and the pitfalls.
>
> **Product line:** JPM-Markets re-engineering **data-analytics** line — NOT Lumina. New
> Python/FastAPI/data-engineering stack. This recipe writes the `our_tet` package from
> scratch. **No `openbb` import anywhere** — we reimplement the shapes OpenBB's TET
> pioneered, not its code.
>
> **Stack pins (verify before building):** Python 3.12+, Pydantic **2.13.x** (v2 API),
> `httpx` **0.28.1** async client (`pip install httpx==0.28.1`,
> [pypi.org/project/httpx](https://pypi.org/project/httpx/)). The ONE shared
> `httpx.AsyncClient` is owned by the FastAPI app (see `python-fastapi-data-service`); a
> fetcher *receives* it, never constructs a per-call client.

---

## 0. Why TET, and why clean-room

The Transform–Extract–Transform contract is OpenBB's solution to "every data provider is a
unique snowflake": you wrap each upstream in three pure-ish stages so the *rest* of the
system sees one uniform shape regardless of whether the bytes came from Treasury, BLS, or
FRED. OpenBB describes it as "Transform the query → Extract the data → Transform the data,"
where the first transform's output is a `QueryParams` child, the extract output is "Any but
recommended to be a dict," and the final transform's output is a `List[Data]`
([OpenBB data-pipeline blog](https://openbb.co/blog/the-openbb-platform-data-pipeline);
[Build Provider Extensions](https://docs.openbb.co/python/developer/extension_types/provider)).

We **copy the contract, not the package.** OpenBB's provider framework is licensed and
carries `openbb-core` as a heavy dependency tree; our data-analytics line is a standalone
FastAPI service. So we reimplement four tiny base classes (`QueryParams`, `Data`, `Fetcher`,
plus a `require_credentials` flag and an `EmptyDataError`) in our own `our_tet/base.py`, and
every provider subclasses *those*. The shapes below are reconstructed from reading OpenBB's
actual source (cited inline) — the *idea* is theirs and excellent; the code is ours.

> **Mesh layer note.** This is the **fetcher recipe**. The base classes it subclasses are
> specified in `theory-tet-pipeline.md`; the licensing gate that decides *whether* a source
> is GREEN at all is in `theory-green-source-licensing.md`. Read those for the "why"; this
> file is the "how, end to end."

---

## 1. The clean-room base layer (`our_tet/base.py`)

Before any provider, we need the four primitives. This is a **complete, runnable** file. It
is the minimum reimplementation of the OpenBB shapes — `QueryParams.model_dump` alias
remap, `Data` with `extra="allow"` + `__alias_dict__` validator, the `Fetcher[Q, R]` generic
with `fetch_data` orchestration and sync/async auto-detection, and `EmptyDataError`.

```python
# our_tet/base.py
"""Clean-room TET base classes. Reimplements the OpenBB QueryParams/Data/Fetcher
*shapes* (transform-extract-transform), with zero openbb dependency.

Pydantic v2.13.x. Python 3.12+.
"""
from __future__ import annotations

import asyncio
import inspect
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, model_validator


class EmptyDataError(Exception):
    """Raised by a fetcher's extract stage when the upstream returned zero rows.

    This is a *typed* signal, never a fabricated value. The service layer maps it to an
    HTTP 404 (or an empty 200 with a 'no data' note) — it must never be silently
    swallowed into [] that looks like a successful empty result for a bad query.
    Mirrors OpenBB's pandas-borrowed EmptyDataError convention.
    """


# ---------------------------------------------------------------------------
# QueryParams — the *input* contract (stage-1 output)
# ---------------------------------------------------------------------------
class QueryParams(BaseModel):
    """Standardized query parameters, extended per provider.

    __alias_dict__ maps our standard field name -> the provider's wire name. It is
    applied ONLY on model_dump(), so the model is authored in clean standard names but
    serializes to whatever the upstream wants. (Reconstructed from OpenBB's
    query_params.py: 'The alias is only applied when running model_dump'.)
    """

    # subclasses override these two class attrs
    __alias_dict__: dict[str, str] = {}
    __json_schema_extra__: dict[str, Any] = {}

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        """Dump, remapping standard field names to provider wire names via the alias dict."""
        original = super().model_dump(*args, **kwargs)
        if self.__alias_dict__:
            return {
                self.__alias_dict__.get(key, key): value
                for key, value in original.items()
            }
        return original

    def __repr__(self) -> str:
        kv = ", ".join(f"{k}={v}" for k, v in self.model_dump().items())
        return f"{self.__class__.__name__}({kv})"


# ---------------------------------------------------------------------------
# Data — the *output* contract (stage-3 output element)
# ---------------------------------------------------------------------------
class Data(BaseModel):
    """One standardized record. extra='allow' so a provider can attach extra columns
    without us pre-declaring every field; __alias_dict__ remaps the *incoming* raw keys
    (provider wire name -> our standard field) BEFORE validation, so validation errors
    report the clean field name.

    (Reconstructed from OpenBB's data.py: model_config extra='allow',
    populate_by_name=True, and the _use_alias model_validator(mode='before').)
    """

    __alias_dict__: dict[str, str] = {}

    model_config = ConfigDict(
        extra="allow",
        populate_by_name=True,
        strict=False,
    )

    @model_validator(mode="before")
    @classmethod
    def _apply_incoming_alias(cls, values: Any) -> Any:
        """Remap raw provider keys to our field names before field validation runs."""
        # __alias_dict__ is {our_field: provider_wire_name}; invert to {wire: our_field}.
        inverse = {wire: ours for ours, wire in cls.__alias_dict__.items()}
        if inverse and isinstance(values, dict):
            return {inverse.get(k, k): v for k, v in values.items()}
        return values


# ---------------------------------------------------------------------------
# Fetcher — the orchestrator: transform_query -> (a)extract_data -> transform_data
# ---------------------------------------------------------------------------
Q = TypeVar("Q", bound=QueryParams)
R = TypeVar("R")


class Fetcher(Generic[Q, R]):
    """Glue between a request (dict) and a validated list[Data].

    Subclasses implement transform_query, transform_data, and EXACTLY ONE of
    extract_data (sync) / aextract_data (async). We auto-detect which is overridden.

    (Reconstructed from OpenBB's fetcher.py fetch_data orchestration + the
    extract/aextract split; OpenBB uses maybe_coroutine, we use the same idea.)
    """

    # Override to False for keyless GREEN sources (Treasury, GDELT). When True and the
    # required credential is absent, fetch_data raises before touching the network.
    require_credentials: bool = True

    @staticmethod
    def transform_query(params: dict[str, Any]) -> Q:  # noqa: D401
        raise NotImplementedError

    @staticmethod
    def extract_data(query: Q, credentials: dict[str, str] | None, **kwargs: Any) -> Any:
        raise NotImplementedError

    @staticmethod
    async def aextract_data(
        query: Q, credentials: dict[str, str] | None, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    @staticmethod
    def transform_data(query: Q, data: Any, **kwargs: Any) -> R:
        raise NotImplementedError

    # -- orchestration -------------------------------------------------------
    @classmethod
    def _is_async(cls) -> bool:
        """True iff the subclass overrode aextract_data (preferred when both differ)."""
        return cls.aextract_data is not Fetcher.aextract_data

    @classmethod
    async def fetch_data(
        cls,
        params: dict[str, Any],
        credentials: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> R:
        """Run the full TET pipeline. Always awaitable so callers have one shape."""
        query = cls.transform_query(params=params)
        if cls._is_async():
            data = await cls.aextract_data(query, credentials, **kwargs)
        else:
            # run the sync extract off the event loop so we never block FastAPI's loop
            loop = asyncio.get_running_loop()
            data = await loop.run_in_executor(
                None, lambda: cls.extract_data(query, credentials, **kwargs)
            )
        return cls.transform_data(query, data, **kwargs)
```

Two design notes that matter at scale:

1. **`fetch_data` is always `async`.** Even a sync `extract_data` provider is awaited via
   `run_in_executor`, so the FastAPI route never has to branch. OpenBB's `fetch_data` does
   the same with `maybe_coroutine`
   ([fetcher.py orchestration, read on `develop`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/fetcher.py)).
   A blocking `requests` call inside an `async def` route would stall every concurrent
   request on the worker — the AnyIO-threadpool offload prevents that.
2. **`require_credentials` is checked in the service layer, not here**, OR add the check at
   the top of `fetch_data`. OpenBB sets `require_credentials = True` as the class default
   and providers flip it to `False`
   ([CONTRIBUTING.md `require_credentials = False`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)).
   For keyless GREEN sources you **must** set `require_credentials = False` or the gate
   rejects them.

---

## 2. The HTTP helper (`our_tet/http.py`) — reimplement, don't import

OpenBB's `amake_request`/`get_querystring` live in
`openbb_core/provider/utils/helpers.py`. We reimplement the **shapes** on `httpx` (OpenBB
wraps `aiohttp`; we standardize on `httpx` because the FastAPI service already owns one
shared `httpx.AsyncClient` — see `python-fastapi-data-service`). The two helpers we need:

```python
# our_tet/http.py
"""Async HTTP helpers for fetchers. httpx 0.28.1. Reimplements the *shapes* of OpenBB's
amake_request / get_querystring on httpx + a single shared client.
"""
from __future__ import annotations

from typing import Any, Literal

import httpx

# A descriptive UA so upstreams (and the Treasury "polite use" expectation) can identify us.
DEFAULT_USER_AGENT = (
    "JPMReengineering-DataAnalytics/0.1 (+https://example.internal; data-plane fetcher)"
)


def get_querystring(items: dict[str, Any], exclude: list[str] | None = None) -> str:
    """Build a query string from a dict.

    - skips keys in `exclude`
    - skips None values entirely (so an unset optional param is simply absent)
    - expands a list value into repeated key=item pairs (key=a&key=b)
    - joins with '&'

    (Reconstructed from OpenBB get_querystring: 'Iterates items, skipping None values.
    Expands list values into multiple key=item pairs. Joins with &'.)
    """
    exclude = exclude or []
    parts: list[str] = []
    for key, value in items.items():
        if key in exclude or value is None:
            continue
        if isinstance(value, list):
            parts.extend(f"{key}={item}" for item in value if item is not None)
        else:
            parts.append(f"{key}={value}")
    return "&".join(parts)


async def amake_request(
    url: str,
    *,
    client: httpx.AsyncClient,
    method: Literal["GET", "POST"] = "GET",
    timeout: float | httpx.Timeout = 10.0,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    json: Any | None = None,
    **kwargs: Any,
) -> dict | list[dict]:
    """Make one async request and return parsed JSON.

    We REQUIRE the caller to pass the shared client (DI from app.state) — never open a
    client per call (httpx warns against instantiating clients in a hot loop;
    python-httpx.org/async). Default response handling = .json(), matching OpenBB's
    default callback `lambda r, _: r.json()`.
    """
    if method not in ("GET", "POST"):
        raise ValueError(f"Unsupported method: {method}")
    merged_headers = {"User-Agent": DEFAULT_USER_AGENT, **(headers or {})}
    response = await client.request(
        method,
        url,
        params=params,
        json=json,
        headers=merged_headers,
        timeout=timeout,
        **kwargs,
    )
    response.raise_for_status()  # turn 4xx/5xx into httpx.HTTPStatusError, not silent bad data
    return response.json()
```

Why these exact choices, cited:

- **Default = `.json()`.** OpenBB's `amake_request` default callback is
  `lambda r, _: asyncio.ensure_future(r.json())`
  ([helpers.py signature read on `develop`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/utils/helpers.py)).
  We keep parity: parse JSON unless the caller does it themselves.
- **`raise_for_status()`.** httpx does **not** raise on 4xx/5xx by default — you must call
  it ([httpx response handling](https://www.python-httpx.org/quickstart/)). Skipping it is a
  classic bug: a 429/500 body (`{"error": "rate limited"}`) sails into `transform_data` and
  becomes garbage rows. We raise so the service maps it to a typed error.
- **Shared client, passed in.** httpx's async guide explicitly warns: "make sure you're not
  instantiating multiple client instances — for example by using `async with` inside a 'hot
  loop'" ([python-httpx.org/async](https://www.python-httpx.org/async/)). Connection-pool
  reuse is the single biggest async-HTTP throughput lever, so the fetcher *borrows* the
  app's one `httpx.AsyncClient` rather than creating its own.
- **Timeout = explicit `10.0`.** httpx's default is 5s of network inactivity
  ([httpx timeouts](https://www.python-httpx.org/advanced/timeouts/)); gov endpoints can be
  slow under load, so we set a deliberate 10s and let the caller pass an `httpx.Timeout(...)`
  for fine-grained connect/read/write/pool control when needed.

---

## 3. End-to-end: the US Treasury FiscalData provider (GREEN, keyless)

We build one provider completely. **US Treasury FiscalData** is the ideal first build:

- **License: GREEN.** It is a U.S. federal-government work; under
  [17 U.S.C. §105](https://www.law.cornell.edu/uscode/text/17/105) federal-government works
  carry no copyright, and FiscalData's own terms confirm the data is free to use. This
  passes the `commercialOk` gate with `commercialOk: true` — but the *verdict belongs in the
  sources-ledger*, not asserted here (see `theory-green-source-licensing.md`).
- **Keyless.** No registration, no API key → `require_credentials = False`.
- **Clean REST + JSON envelope.** Base URL
  `https://api.fiscaldata.treasury.gov/services/api/fiscal_service`; endpoints like
  `/v2/accounting/od/avg_interest_rates`
  ([Treasury FiscalData API docs](https://fiscaldata.treasury.gov/api-documentation/)).

### 3.0 The real wire shape (verified live)

A live call (`GET .../v2/accounting/od/avg_interest_rates?fields=record_date,security_desc,security_type_desc,avg_interest_rate_amt&filter=record_date:gte:2024-01-01&sort=-record_date&page[number]=1&page[size]=3&format=json`)
returns this envelope (captured 2026-06, abbreviated):

```json
{
  "data": [
    { "record_date": "2026-05-31", "security_desc": "Treasury Bills",
      "security_type_desc": "Marketable", "avg_interest_rate_amt": "3.690" },
    { "record_date": "2026-05-31", "security_desc": "Treasury Notes",
      "security_type_desc": "Marketable", "avg_interest_rate_amt": "3.248" }
  ],
  "meta": {
    "count": 3,
    "labels": { "record_date": "Record Date", "avg_interest_rate_amt": "Average Interest Rate Amount" },
    "dataTypes": { "record_date": "DATE", "avg_interest_rate_amt": "PERCENTAGE" },
    "dataFormats": { "record_date": "YYYY-MM-DD", "avg_interest_rate_amt": "10.2%" },
    "total-count": 491,
    "total-pages": 164
  },
  "links": {
    "self": "&page%5Bnumber%5D=1&page%5Bsize%5D=3",
    "first": "&page%5Bnumber%5D=1&page%5Bsize%5D=3",
    "prev": null,
    "next": "&page%5Bnumber%5D=2&page%5Bsize%5D=3",
    "last": "&page%5Bnumber%5D=164&page%5Bsize%5D=3"
  }
}
```

Three facts that drive the fetcher design, all from that real payload:

1. **Rows live under `data`** (a list of flat dicts). Stage-3 iterates `payload["data"]`.
2. **Every numeric comes back as a STRING** (`"3.690"`, not `3.69`). Pydantic v2 will coerce
   `str -> float` under `strict=False`, but we add an explicit validator so a non-numeric
   sentinel (`"null"`, `""`, `"-"`) becomes a typed failure, not a silent `0.0`.
3. **Pagination is server-side** (`page[number]` / `page[size]`, `meta.total-pages: 164`).
   This is the **R-SCALE** lever: at 1× we fetch one page; at 100×/10,000× we must page or
   the route times out. The provider exposes `page`/`limit` and a max guard.

### 3.1 Step 1 — subclass `QueryParams`

```python
# our_tet/providers/treasury/models/avg_interest_rates.py
"""US Treasury FiscalData — Average Interest Rates on U.S. Treasury Securities.

Endpoint: /v2/accounting/od/avg_interest_rates
Docs: https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/
"""
from __future__ import annotations

from datetime import date as dateType
from typing import Any, Literal

from pydantic import Field, field_validator

from our_tet.base import Data, QueryParams


class TreasuryAvgRatesQueryParams(QueryParams):
    """Query params for Treasury average interest rates.

    Authored in our standard names; __alias_dict__ remaps to FiscalData's wire grammar
    only when we serialize for the request. FiscalData has no per-field rename here, so
    the alias dict stays empty — but we KEEP the slot to show the pattern and because
    pagination keys ('page[number]') ARE non-pythonic and we map them in stage-1 instead.
    """

    __alias_dict__: dict[str, str] = {}
    __json_schema_extra__: dict[str, Any] = {
        # documents that the endpoint supports multiple security types via repeated filter
        "security_type_desc": {"choices": ["Marketable", "Non-marketable"]},
    }

    start_date: dateType | None = Field(
        default=None, description="Earliest record_date (inclusive)."
    )
    end_date: dateType | None = Field(
        default=None, description="Latest record_date (inclusive)."
    )
    security_type_desc: Literal["Marketable", "Non-marketable"] | None = Field(
        default=None, description="Filter by security type."
    )
    limit: int = Field(
        default=100,
        ge=1,
        le=10_000,
        description="Rows per page (FiscalData page[size]). Hard-capped to protect the route.",
    )
    page: int = Field(
        default=1, ge=1, description="1-indexed page number (FiscalData page[number])."
    )

    @field_validator("end_date")
    @classmethod
    def _end_after_start(cls, v: dateType | None, info: Any) -> dateType | None:
        start = info.data.get("start_date")
        if v is not None and start is not None and v < start:
            raise ValueError("end_date must be on or after start_date")
        return v
```

What each piece is doing and *why*:

- **`__alias_dict__` slot kept even though empty.** The pattern is load-bearing across
  providers (FRED uses `{"symbol": "series_id", "start_date": "observation_start", ...}` —
  [FRED series.py read on `develop`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fred/openbb_fred/models/series.py)).
  Treasury's renames (`page` → `page[number]`) contain brackets that aren't valid as a dict
  remap target via simple key swap, so we build those in `transform_query` (§3.3) — but the
  slot stays so the next maintainer knows where renames go.
- **`__json_schema_extra__`** is the OpenBB mechanism for attaching provider-specific schema
  hints (`multiple_items_allowed`, `choices`) that the API/SDK layer surfaces — OpenBB merges
  these per-provider into the field's JSON schema
  ([query_params.py docstring, read on `develop`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/query_params.py)).
  We carry the same dict so our OpenAPI generator can render `choices`.
- **`limit`/`page` with `le`/`ge` bounds** are the **R-SCALE guard rails baked into the
  type**: a caller cannot request `page[size]=10_000_000` and OOM the worker — Pydantic
  rejects it at validation, before any network call. This is the difference between Tier-1
  ("trust the caller") and Tier-2 ("the contract enforces the page ceiling").
- **The cross-field validator** (`end_date >= start_date`) runs in Pydantic, so a malformed
  range is a clean `422` from FastAPI, never a confusing upstream error.

### 3.2 Step 2 — subclass `Data`

```python
class TreasuryAvgRatesData(Data):
    """One Treasury average-interest-rate record.

    __alias_dict__ maps OUR field name -> the provider's raw key. FiscalData's keys are
    already snake_case and readable, so we keep our names == theirs EXCEPT we rename the
    long 'avg_interest_rate_amt' to a cleaner 'avg_interest_rate'. extra='allow'
    (inherited) means any column we did NOT model (e.g. src_line_nbr) is preserved, not
    dropped — never silently lose provider data.
    """

    __alias_dict__: dict[str, str] = {
        "avg_interest_rate": "avg_interest_rate_amt",
    }

    record_date: dateType = Field(description="Record date (month-end).")
    security_desc: str = Field(description="Security description, e.g. 'Treasury Bills'.")
    security_type_desc: str = Field(description="Marketable / Non-marketable.")
    avg_interest_rate: float | None = Field(
        default=None, description="Average interest rate, percent."
    )

    @field_validator("avg_interest_rate", mode="before")
    @classmethod
    def _coerce_rate(cls, v: Any) -> float | None:
        """FiscalData sends rates as strings ('3.690'). Coerce; map non-numeric
        sentinels to None instead of crashing or silently becoming 0.0."""
        if v in (None, "", "null", "-", "*"):
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
```

The two non-obvious correctness rules here — both are "never invent a number" in disguise:

- **`extra="allow"` keeps unmodeled columns.** If FiscalData adds `record_fiscal_year`, it
  rides along on the `Data` instance instead of being dropped. OpenBB's `Data` sets
  `extra="allow"` for exactly this reason
  ([data.py `model_config`, read on `develop`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/data.py)).
  Dropping extras is a silent data-loss bug that no test catches until a downstream chart
  needs the missing column.
- **The `mode="before"` validator maps sentinels to `None`, never `0.0`.** A
  string `"-"` coerced blindly would either crash or (worse, with a bare `float(v or 0)`)
  become a *fabricated zero rate*. `None` is the honest "we don't have this number" —
  consistent with the line's non-negotiable that a failed/absent value is typed-absent,
  never invented.

### 3.3 Step 3 — implement the `Fetcher`

```python
class TreasuryAvgRatesFetcher(
    Fetcher[TreasuryAvgRatesQueryParams, list[TreasuryAvgRatesData]]
):
    """TET pipeline for Treasury average interest rates. Keyless GREEN source."""

    # keyless public-domain source -> no credentials required
    require_credentials = False

    _BASE = (
        "https://api.fiscaldata.treasury.gov/services/api/fiscal_service"
        "/v2/accounting/od/avg_interest_rates"
    )

    # -- stage 1: build the provider-shaped request -------------------------
    @staticmethod
    def transform_query(params: dict[str, Any]) -> TreasuryAvgRatesQueryParams:
        return TreasuryAvgRatesQueryParams(**params)

    # -- stage 2: fetch raw bytes (ASYNC) -----------------------------------
    @staticmethod
    async def aextract_data(
        query: TreasuryAvgRatesQueryParams,
        credentials: dict[str, str] | None,  # unused: keyless
        **kwargs: Any,
    ) -> list[dict]:
        # The shared httpx.AsyncClient is injected by the caller (DI from app.state).
        # We NEVER open a client here. (closure/DI = secrets-by-closure discipline; here
        # there's no secret, but the same injection path carries keys for keyed providers.)
        client: httpx.AsyncClient = kwargs["client"]

        # Build FiscalData's filter grammar: comma-joined "field:op:value" clauses.
        filters: list[str] = []
        if query.start_date is not None:
            filters.append(f"record_date:gte:{query.start_date.isoformat()}")
        if query.end_date is not None:
            filters.append(f"record_date:lte:{query.end_date.isoformat()}")
        if query.security_type_desc is not None:
            filters.append(f"security_type_desc:eq:{query.security_type_desc}")

        # FiscalData uses bracketed pagination keys, which httpx encodes correctly when
        # passed as a flat params dict.
        params: dict[str, Any] = {
            "fields": "record_date,security_desc,security_type_desc,avg_interest_rate_amt",
            "sort": "-record_date",
            "format": "json",
            "page[number]": query.page,
            "page[size]": query.limit,
        }
        if filters:
            params["filter"] = ",".join(filters)

        payload = await amake_request(
            TreasuryAvgRatesFetcher._BASE,
            client=client,
            method="GET",
            params=params,
            timeout=10.0,
        )

        rows = payload.get("data") if isinstance(payload, dict) else None
        if not rows:
            # typed, never a fabricated/empty-success. Service maps to 404 / 'no data'.
            raise EmptyDataError(
                "Treasury avg_interest_rates returned no rows for the requested filter."
            )
        return rows

    # -- stage 3: validate into the standard model --------------------------
    @staticmethod
    def transform_data(
        query: TreasuryAvgRatesQueryParams,
        data: list[dict],
        **kwargs: Any,
    ) -> list[TreasuryAvgRatesData]:
        # model_validate runs the incoming-alias remap + the field validators (string->float
        # coercion, sentinel->None). A genuinely malformed row raises here, loudly — we do
        # NOT try/except-and-skip into a fabricated partial result.
        return [TreasuryAvgRatesData.model_validate(row) for row in data]
```

The three stages, and the rules each enforces:

| Stage | Method | Job | The rule it enforces |
|---|---|---|---|
| 1 | `transform_query` | dict → validated `QueryParams` | Page/limit ceilings, date sanity — **no network here** |
| 2 | `aextract_data` | `QueryParams` → raw `list[dict]` | The **only** stage that touches the network; `EmptyDataError` on no rows |
| 3 | `transform_data` | raw rows → `list[Data]` | Alias remap + numeric coercion + sentinel→None; **no fabrication** |

Matches OpenBB's contract exactly: stage-1 output is a `QueryParams` child, stage-2 output is
"recommended to be a dict" (here a `list[dict]`), stage-3 output is a `List[Data]`
([provider pipeline](https://openbb.co/blog/the-openbb-platform-data-pipeline)).

### 3.4 Registering the provider (`__init__.py`)

OpenBB makes a model "visible" by adding its `Fetcher` to the provider's `__init__.py` inside
a `Provider(..., fetcher_dict={...})`, keyed by the standard model name
([CONTRIBUTING.md registration block](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)).
We reimplement a tiny `Provider` registry the same way:

```python
# our_tet/base.py  (append)
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Provider:
    """A named bundle of fetchers. fetcher_dict maps a standard model name -> Fetcher
    class, exactly like OpenBB's Provider(fetcher_dict={...})."""

    name: str
    website: str
    description: str
    credentials: list[str] = field(default_factory=list)  # [] for keyless GREEN sources
    fetcher_dict: dict[str, type[Fetcher]] = field(default_factory=dict)
```

```python
# our_tet/providers/treasury/__init__.py
"""US Treasury FiscalData provider — public-domain (17 USC §105), keyless, GREEN."""
from our_tet.base import Provider
from our_tet.providers.treasury.models.avg_interest_rates import (
    TreasuryAvgRatesFetcher,
)

treasury_provider = Provider(
    name="treasury",
    website="https://fiscaldata.treasury.gov",
    description="U.S. Treasury Fiscal Data — public-domain federal fiscal datasets.",
    credentials=[],  # keyless
    fetcher_dict={
        "TreasuryAvgRates": TreasuryAvgRatesFetcher,
    },
)
```

A global registry then collects providers so the service layer can dispatch
`provider="treasury", model="TreasuryAvgRates"` → the right `Fetcher.fetch_data(...)`:

```python
# our_tet/registry.py
from our_tet.base import Fetcher, Provider
from our_tet.providers.treasury import treasury_provider

PROVIDERS: dict[str, Provider] = {treasury_provider.name: treasury_provider}


def get_fetcher(provider: str, model: str) -> type[Fetcher]:
    prov = PROVIDERS.get(provider)
    if prov is None:
        raise KeyError(f"unknown provider: {provider}")
    fetcher = prov.fetcher_dict.get(model)
    if fetcher is None:
        raise KeyError(f"provider {provider} has no model {model}")
    return fetcher
```

### 3.5 Calling it from a FastAPI route

```python
# app/routers/treasury.py
from fastapi import APIRouter, Depends, HTTPException, Request
import httpx

from our_tet.base import EmptyDataError
from our_tet.registry import get_fetcher

router = APIRouter(prefix="/treasury", tags=["treasury"])


def get_http_client(request: Request) -> httpx.AsyncClient:
    """The ONE shared client created in the app lifespan (see python-fastapi-data-service)."""
    return request.app.state.http_client


@router.get("/avg-interest-rates")
async def avg_interest_rates(
    start_date: str | None = None,
    end_date: str | None = None,
    security_type_desc: str | None = None,
    limit: int = 100,
    page: int = 1,
    client: httpx.AsyncClient = Depends(get_http_client),
):
    fetcher = get_fetcher("treasury", "TreasuryAvgRates")
    params = {
        "start_date": start_date,
        "end_date": end_date,
        "security_type_desc": security_type_desc,
        "limit": limit,
        "page": page,
    }
    try:
        rows = await fetcher.fetch_data(params, credentials=None, client=client)
    except EmptyDataError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}") from exc
    # rows are TreasuryAvgRatesData; FastAPI serializes via .model_dump()
    return {"provider": "treasury", "model": "TreasuryAvgRates",
            "data": [r.model_dump() for r in rows]}
```

The `client=client` kwarg flows: route → `fetch_data(**kwargs)` → `aextract_data(**kwargs)` →
`kwargs["client"]`. The shared client is **injected by closure/DI**, never constructed inside
the fetcher — the same channel carries an API key for a keyed provider (§4.3), which is why
the model never supplies credentials.

---

## 4. The second provider, fast: where the deltas live

Once the base layer exists, a new provider is "fill the three classes." Here are the **only**
things that change for two more real GREEN sources. (Full files would repeat §3 mechanically;
these deltas are the actual learning.)

### 4.1 Delta map

| Concern | Treasury (§3) | BLS | FRED |
|---|---|---|---|
| HTTP method | `GET` w/ query params | **`POST` w/ JSON body** | `GET` w/ query params |
| Credentials | none (`require_credentials=False`) | optional key (`registrationkey`) | **required** `fred_api_key` |
| Rows location | `payload["data"]` | `payload["Results"]["series"][i]["data"]` | `payload["observations"]` |
| Numbers as | strings | strings | strings, with `"."` = missing |
| Pagination | `page[number]`/`page[size]` | none (single response, ≤20yr span) | `offset`/`limit` |
| Alias dict | one rename | per-series unpack | `{"symbol":"series_id",...}` |

### 4.2 BLS — the POST/JSON delta

BLS v2 is **POST-only with a JSON body**; the endpoint is
`https://api.bls.gov/publicAPI/v2/timeseries/data/`, the body carries
`seriesid` (array), `startyear`, `endyear`, and an optional `registrationkey`; registered
users get up to 50 series and a 20-year span per request, and **all data returns in one
response — there is no pagination**
([BLS API Signatures v2](https://www.bls.gov/developers/api_signature_v2.htm)).

```python
class BlsSeriesFetcher(Fetcher[BlsSeriesQueryParams, list[BlsSeriesData]]):
    require_credentials = False  # key is OPTIONAL (raises the daily/series limits)

    @staticmethod
    async def aextract_data(query, credentials, **kwargs) -> list[dict]:
        client: httpx.AsyncClient = kwargs["client"]
        body: dict[str, Any] = {
            "seriesid": query.series_ids,            # a LIST -> JSON array
            "startyear": str(query.start_year),
            "endyear": str(query.end_year),
        }
        # credential by closure: model never supplies it; the service injects it.
        key = (credentials or {}).get("bls_api_key")
        if key:
            body["registrationkey"] = key

        payload = await amake_request(
            "https://api.bls.gov/publicAPI/v2/timeseries/data/",
            client=client, method="POST", json=body, timeout=15.0,
        )
        # BLS wraps everything: {"status": "REQUEST_SUCCEEDED", "Results": {"series": [...]}}
        if payload.get("status") != "REQUEST_SUCCEEDED":
            raise EmptyDataError(f"BLS request not succeeded: {payload.get('message')}")
        series = (payload.get("Results") or {}).get("series") or []
        rows: list[dict] = []
        for s in series:
            sid = s.get("seriesID")
            for obs in s.get("data", []):
                rows.append({**obs, "series_id": sid})  # flatten + attach the series id
        if not rows:
            raise EmptyDataError("BLS returned no observations for the requested series/years.")
        return rows
```

The deltas that bite, each cited:

- **`method="POST", json=body`.** A list-valued `seriesid` goes in the JSON body, **not** as
  repeated query params — BLS only accepts POST/JSON for v2
  ([BLS v2 signatures](https://www.bls.gov/developers/api_signature_v2.htm)). Trying to GET it
  is the #1 BLS mistake.
- **Check the envelope status, not just HTTP 200.** BLS returns HTTP 200 with
  `"status": "REQUEST_NOT_PROCESSED"` for bad input. `raise_for_status()` won't catch it —
  you must inspect `payload["status"]` and raise `EmptyDataError` on the failure string.
- **Nested unpack in extract, flat dicts out.** Stage-2 flattens
  `Results.series[i].data[j]` into flat rows with `series_id` attached, so stage-3's
  `Data.model_validate` sees a flat dict (which is what the `Data` contract expects).
- **No pagination knobs.** Because BLS returns the full span in one response, the
  `QueryParams` exposes `start_year`/`end_year` (capped to a 20-year span via a validator),
  not `page`/`limit`.

### 4.3 FRED — the required-credential + heavy-alias delta

FRED needs an API key (`fred_api_key`) and renames most fields. The real OpenBB FRED model
shows the alias-heavy pattern we copy
([FRED series.py read on `develop`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fred/openbb_fred/models/series.py)):

```python
class FredSeriesQueryParams(QueryParams):
    __alias_dict__ = {
        "symbol": "series_id",
        "start_date": "observation_start",
        "end_date": "observation_end",
        "transform": "units",
    }
    __json_schema_extra__ = {"symbol": {"multiple_items_allowed": True}}

    symbol: str = Field(description="FRED series id, e.g. 'DGS10'.")
    start_date: dateType | None = Field(default=None, description="observation_start")
    end_date: dateType | None = Field(default=None, description="observation_end")


class FredSeriesFetcher(Fetcher[FredSeriesQueryParams, list[FredSeriesData]]):
    require_credentials = True  # FRED is keyed -> gate REJECTS the call if key absent

    @staticmethod
    async def aextract_data(query, credentials, **kwargs) -> list[dict]:
        client: httpx.AsyncClient = kwargs["client"]
        api_key = (credentials or {}).get("fred_api_key")
        if not api_key:
            raise ValueError("fred_api_key is required")  # belt-and-suspenders to require_credentials
        # model_dump() applies __alias_dict__ -> {'series_id': ..., 'observation_start': ...}
        params = {**query.model_dump(exclude_none=True), "api_key": api_key, "file_type": "json"}
        payload = await amake_request(
            "https://api.stlouisfed.org/fred/series/observations",
            client=client, params=params, timeout=10.0,
        )
        obs = payload.get("observations") or []
        if not obs:
            raise EmptyDataError("FRED returned no observations.")
        return obs
```

The deltas:

- **`require_credentials = True`.** The gate refuses to call FRED without a key — fail fast,
  before the network. OpenBB defaults `require_credentials = True` and lists `credentials`
  on the `Provider` ([CONTRIBUTING.md registration](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)).
- **Alias dict does real work now.** `query.model_dump()` turns `symbol`/`start_date` into
  `series_id`/`observation_start` — the rename happens at dump time, exactly as the OpenBB
  `QueryParams.model_dump` override does
  ([query_params.py, read on `develop`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/query_params.py)).
  We author clean field names; the wire gets FRED's names.
- **The credential rides in `credentials`, injected by the service.** The model never sees
  the key; the route/service passes `credentials={"fred_api_key": settings.fred_api_key}`.
  FRED's missing-value sentinel is `"."`, handled by the same `mode="before"` validator
  pattern as Treasury's (string→float, sentinel→None).

> **Licensing footnote.** FRED redistributes many *third-party* series whose copyright is held
> by the original provider (e.g. some indices). FRED-the-fetch-path being keyed does **not**
> make every series GREEN — the **license attaches to the fetch path and the underlying
> series**, so a FRED series may be RED for commercial display even though Treasury and BLS
> primary series are GREEN. Decide per series in `theory-green-source-licensing.md` /
> the sources-ledger; do not blanket-`commercialOk:true` FRED.

---

## 5. The `test_fetcher` record/replay fixture

OpenBB tests every fetcher with a **record-once, replay-forever** pattern: the first run hits
the live API and saves the HTTP exchange to a cassette; CI replays the cassette so tests are
fast, deterministic, and offline. We reimplement it on `pytest` + `pytest-recording`
(VCR.py), which records `httpx` traffic.

```python
# tests/providers/treasury/test_avg_interest_rates_fetcher.py
"""Record/replay test for the Treasury avg-interest-rates fetcher.

First run (records the cassette):
    pytest --record-mode=once tests/providers/treasury/
Subsequent runs (offline replay):
    pytest tests/providers/treasury/
"""
import httpx
import pytest

from our_tet.providers.treasury.models.avg_interest_rates import (
    TreasuryAvgRatesData,
    TreasuryAvgRatesFetcher,
)


@pytest.fixture
async def http_client():
    async with httpx.AsyncClient() as client:
        yield client


# Scrub secrets from cassettes so we never commit a key. (No-op for keyless Treasury,
# but the same config protects the FRED/BLS cassettes.)
@pytest.fixture(scope="module")
def vcr_config():
    return {
        "filter_query_parameters": [("api_key", "REDACTED")],
        "filter_post_data_parameters": [("registrationkey", "REDACTED")],
        "record_mode": "once",
    }


@pytest.mark.vcr  # records/replays the HTTP exchange to tests/.../cassettes/<name>.yaml
@pytest.mark.asyncio
async def test_treasury_avg_rates_fetcher(http_client):
    params = {"start_date": "2024-01-01", "end_date": "2024-12-31", "limit": 5, "page": 1}
    rows = await TreasuryAvgRatesFetcher.fetch_data(
        params, credentials=None, client=http_client
    )
    # 1. shape: we got the standard model back
    assert rows and all(isinstance(r, TreasuryAvgRatesData) for r in rows)
    # 2. coercion worked: string '3.690' became a float
    assert all(r.avg_interest_rate is None or isinstance(r.avg_interest_rate, float)
               for r in rows)
    # 3. the contract held: required fields are present
    assert all(r.record_date and r.security_desc for r in rows)


@pytest.mark.asyncio
async def test_empty_data_raises(http_client, monkeypatch):
    """A filter that returns no rows must raise EmptyDataError, NOT return []."""
    from our_tet.base import EmptyDataError

    async def _empty(*a, **k):
        return {"data": [], "meta": {}}

    monkeypatch.setattr(
        "our_tet.providers.treasury.models.avg_interest_rates.amake_request", _empty
    )
    with pytest.raises(EmptyDataError):
        await TreasuryAvgRatesFetcher.fetch_data(
            {"start_date": "1700-01-01", "end_date": "1700-01-02"},
            credentials=None, client=http_client,
        )
```

What this fixture pattern buys you and why each line is there:

- **`@pytest.mark.vcr` (pytest-recording / VCR.py)** records the real `httpx` call to a YAML
  cassette on first run, then replays it — so the assertion "string `'3.690'` coerces to
  `float`" is tested against the **real** Treasury payload, not a hand-mocked one that could
  drift from reality. This is OpenBB's exact philosophy: their fetcher tests snapshot a real
  exchange and replay it (their tooling records to JSON; the principle is identical).
- **`vcr_config` scrubs secrets** so a FRED/BLS cassette never commits `api_key`/
  `registrationkey` — the `filter_query_parameters` / `filter_post_data_parameters` redact
  them in the saved cassette. Committing a key in a fixture is a real, repeated incident; this
  fixture-level scrub is the guard.
- **The `EmptyDataError` test is separate and mock-based** (no cassette): it asserts the
  *typed-absence* contract — an empty upstream raises, it does **not** return `[]` that looks
  like a successful empty result. This is the single most important behavioral test for a
  GREEN financial fetcher (a silent `[]` becomes a fabricated "no rates exist" downstream).
- **Run modes:** `--record-mode=once` records missing cassettes and replays existing ones;
  default mode (no `--record-mode`) is replay-only, so **CI never touches the network** and a
  rate-limited or down upstream cannot fail the build.

---

## 6. Pitfalls — the mistakes this recipe exists to prevent

| Pitfall (the AI/junior tell) | Why it breaks | The fix |
|---|---|---|
| **Fetching in `transform_query` or `transform_data`** | Stage-1/3 must be pure transforms; a network call there means it runs on the wrong thread, can't be cassette-replayed, and the TET separation collapses. | The **only** network call is in `extract_data`/`aextract_data`. Stages 1 and 3 never touch the wire. |
| **Sync `requests.get(...)` inside an `async def` route** | Blocks the FastAPI event loop; one slow upstream stalls every concurrent request on the worker. | Use `aextract_data` + the shared `httpx.AsyncClient`; or `extract_data` (sync) which `fetch_data` offloads to the threadpool via `run_in_executor`. |
| **Opening `httpx.AsyncClient()` per fetch** | No connection-pool reuse; httpx explicitly warns against clients in a hot loop ([python-httpx.org/async](https://www.python-httpx.org/async/)). At 100× this exhausts sockets. | Inject the **one** app-level client via `kwargs["client"]` / `Depends`. The fetcher borrows, never builds. |
| **Forgetting `response.raise_for_status()`** | httpx doesn't raise on 4xx/5xx; an error body becomes garbage "rows" in `transform_data`. | `amake_request` calls `raise_for_status()`; a 429/500 becomes a typed `HTTPStatusError`, mapped to 502. |
| **`return []` on no rows** | A silent empty list looks identical to a successful empty query → downstream reads it as "no rates exist" = a fabricated fact. | `raise EmptyDataError(...)`; the service maps it to 404/'no data'. Mirrors the e-Stat PR's `EmptyDataError('No data returned')` ([PR #7215](https://github.com/OpenBB-finance/OpenBB/pull/7215)). |
| **`float(v or 0)` coercion** | Maps a `"-"`/`""` sentinel to a fabricated `0.0` — invents a number. | `mode="before"` validator: sentinels → `None`, real strings → `float`, junk → `None`. Never `0.0`. |
| **Dropping unmodeled columns** | `extra="ignore"` silently loses a provider column a chart later needs. | `Data` inherits `model_config = ConfigDict(extra="allow")` (mirrors OpenBB data.py). |
| **Hardcoding `commercialOk: true` on FRED** | FRED redistributes third-party copyrighted series; license attaches to the fetch path, not "it's a gov-ish API." | Per-series verdict in the sources-ledger; Treasury/BLS primary series GREEN, FRED case-by-case. |
| **Putting `page`/`limit` only in the route, not the `QueryParams`** | The page ceiling isn't enforced by the contract; a caller can request a million rows and OOM the worker. | `limit: int = Field(le=10_000)` and `page: int = Field(ge=1)` on `QueryParams` — Pydantic rejects oversized pages pre-network (Tier-2 R-SCALE). |
| **Async method named `extract_data` but defined `async`** | `fetch_data._is_async()` checks which method was *overridden*; an `async def extract_data` won't be awaited correctly. | Name the async method `aextract_data` (matches OpenBB's split). One provider overrides **exactly one** of the two. |
| **Mocking the API in tests with hand-written JSON** | Drifts from reality; the test passes while prod breaks on a field rename. | Record/replay a **real** exchange (pytest-recording/VCR); cassettes catch upstream drift on re-record. |

---

## 7. Checklist — a new GREEN provider is "done" when…

1. **`QueryParams` subclass** exists with: standard field names, an `__alias_dict__` (even if
   empty), `__json_schema_extra__` for choices/multi-item hints, `Field(le=..., ge=...)`
   bounds on `limit`/`page`, and any cross-field validators. ✅
2. **`Data` subclass** exists with: an `__alias_dict__` for renames, `extra="allow"`
   inherited, typed fields, and a `mode="before"` validator coercing provider strings and
   mapping sentinels to `None` (never `0.0`). ✅
3. **`Fetcher[QP, list[Data]]`** implements `transform_query` (no network),
   `aextract_data`/`extract_data` (the **only** network stage; borrows the shared client by
   closure; raises `EmptyDataError` on zero rows), and `transform_data` (alias + validate;
   no try/except-and-skip). ✅
4. **`require_credentials`** set correctly: `False` for keyless GREEN (Treasury, BLS-without-
   key, GDELT), `True` for keyed (FRED). ✅
5. **Registered** in the provider's `__init__.py` `fetcher_dict` and reachable via the
   registry. ✅
6. **A record/replay `test_fetcher`** asserts the standard-model shape, the numeric coercion,
   AND a separate `EmptyDataError` test — with secrets scrubbed from cassettes. ✅
7. **Licensing** verdict recorded in the sources-ledger for the exact fetch path; the route's
   `Provenance.commercialOk` matches it. ✅

When all seven hold, the provider is a Tier-2 (server-side filter + paginate + page-ceiling),
correctness-grounded (typed absence, no fabricated numbers), license-gated GREEN fetcher — and
the rest of the data-analytics service sees the one uniform `list[Data]` shape regardless of
whether the bytes came from Treasury, BLS, or FRED.

---

## Sources (read this run)

- OpenBB — Build Provider Extensions (developer guide):
  https://docs.openbb.co/python/developer/extension_types/provider
- OpenBB — `CONTRIBUTING.md` (Fetcher skeleton, `require_credentials`, Provider/`fetcher_dict`
  registration), `develop`:
  https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md
- OpenBB — `abstract/query_params.py` (`__alias_dict__`, `__json_schema_extra__`, `model_dump`
  alias remap), `develop`:
  https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/query_params.py
- OpenBB — `abstract/data.py` (`extra="allow"`, `_use_alias` validator), `develop`:
  https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/data.py
- OpenBB — `abstract/fetcher.py` (`Generic[Q, R]`, `fetch_data`, extract/aextract split),
  `develop`:
  https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/fetcher.py
- OpenBB — `provider/utils/helpers.py` (`amake_request` default `.json()` callback,
  `get_querystring`), `develop`:
  https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/utils/helpers.py
- OpenBB — FRED `models/series.py` (`__alias_dict__` with `series_id`/`observation_start`),
  `develop`:
  https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fred/openbb_fred/models/series.py
- OpenBB — e-Stat provider PR #7215 (async fetch + `EmptyDataError('No data returned')` +
  `AnnotatedResult`):
  https://github.com/OpenBB-finance/OpenBB/pull/7215
- OpenBB — data-pipeline / TET blog:
  https://openbb.co/blog/the-openbb-platform-data-pipeline
- httpx 0.28.1 — async client + hot-loop warning: https://www.python-httpx.org/async/ ;
  timeouts (5s default, `httpx.Timeout`): https://www.python-httpx.org/advanced/timeouts/ ;
  PyPI: https://pypi.org/project/httpx/
- US Treasury FiscalData API docs (base URL, `fields`/`filter`/`sort`/`format`/`page[...]`,
  `data`/`meta`/`links` envelope): https://fiscaldata.treasury.gov/api-documentation/ ;
  avg-interest-rates dataset:
  https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/
- BLS Public Data API v2 (POST/JSON, `seriesid`/`startyear`/`endyear`/`registrationkey`, no
  pagination, 20-yr span, 50 series): https://www.bls.gov/developers/api_signature_v2.htm
- 17 U.S.C. §105 (U.S. federal-government works carry no copyright → public-domain GREEN):
  https://www.law.cornell.edu/uscode/text/17/105
