# Theory — The Standard-Model Layer & the Field-Intersection Rule

> **Reference for the dev-skill `data-normalization-tet`.** Product line: the **JPM-Markets
> re-engineering data-analytics service** (re-engineers DataQuery + Fusion). **NOT Lumina.** This is a
> separate Python/Pydantic/data-engineering line; nothing here is wired into Lumina's Bun/Express runtime.
>
> **Type:** `theory-*` — generic, reusable design discipline. It answers *why a standard model is defined
> the way it is and exactly where its boundary sits*. The concrete recipes (writing a real `QueryParams` /
> `Data` / `Fetcher` for a GREEN source, the alias mechanics, the security-master seam) live in the sibling
> `patterns-*.md` references. Read this when you are **designing or extending a standard model** — deciding
> which fields are standard, which are `Optional`, and which are provider-specific. Read
> [`theory-tet-pipeline.md`](theory-tet-pipeline.md) first if you do not yet know what the three stages are.
>
> **Provenance of this doc.** Clean-room re-derivation of OpenBB's public *standard-model* design from
> OpenBB's own blog, docs, and the `develop`-branch source of
> [`OpenBB-finance/OpenBB`](https://github.com/OpenBB-finance/OpenBB) (read at source level; cited inline as
> `repo:path` or URL+excerpt). We copy the **field-intersection mechanism** (a sound, well-tested design we
> would re-derive on our own). We **reject** OpenBB's no-storage read path — see
> [`theory-tet-pipeline.md`](theory-tet-pipeline.md) §9 and the project's own
> [`financial-data-analytics-service/00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
> primitive #1(a) and CRITICAL-2.
>
> **Honesty note (cto-rules.md).** Every concrete claim about OpenBB's code is cited to a file I read this
> session or to a primary OpenBB doc/blog. Where I could not open the exact file (Polygon's historical
> model path 404'd on `develop`), the claim is sourced to OpenBB's own blog and tagged `[blog-sourced]` —
> not promoted to source-read fact. Pydantic v2 behaviour is cited to the installed-version docs.

---

## 0. The one-paragraph version (read this first)

A **standard model** is one validated Pydantic shape per *logical endpoint* — e.g. "daily equity OHLCV" —
that every provider for that endpoint must produce. It is **two classes**: a `QueryParams` (the inputs the
caller may pass) and a `Data` (one row of the output). The rule that decides *which fields go in* is the
**field-intersection rule**: **a field is standard (required) only if it is shared by ≥2 providers; a field
some providers lack is `Optional` with `default=None`; a field unique to one provider does not touch the
standard at all — it lives on that provider's subclass.** Each provider then writes a model that
**SUBCLASSES** the standard and **ADDS** its own fields — it never deletes a standard field and never
makes a standard-required field optional. The payoff is the only thing that matters: because every
provider emits the same guaranteed core shape, **a caller swaps `provider=` and compares apples to
apples** — the downstream warehouse, validators, and charts never branch on which vendor answered. This
layer is the *easy 20%* of normalization (renaming + presence). It deliberately does **not** make the
*values* comparable (a 4 from Polygon and a 4 from FMP can be different things — cents vs dollars, adjusted
vs raw). That is the hard 80%, left to `theory-value-normalization-units-currency.md`,
`theory-time-calendar-frequency-normalization.md`, and the security master.

The canonical statement of the rule is OpenBB's own contributing guide:

> *"We standardize fields that are shared between two or more providers. If there is a third provider that
> doesn't share the same fields, we will declare it as an `Optional` field."*
> — [`OpenBB-finance/OpenBB@develop:openbb_platform/CONTRIBUTING.md`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)

And the user-facing promise it buys:

> *"OpenBB will guarantee a set of fields that are expected to always be returned by any of the supported
> providers and a set of query parameters that will work for all of them."*
> — [OpenBB Providers docs](https://docs.openbb.co/odp/python/extensions/providers) (paraphrased in the
> docs; see §3.3 for the exact mechanism this maps to in source).

---

## 1. What a "standard model" is — precisely

### 1.1 One endpoint, two classes, N providers

For a single *logical endpoint* (a question a user asks: "give me daily OHLCV for AAPL"), the standard
model is **exactly two classes**:

| Class | Base | Holds | Lifecycle role |
|---|---|---|---|
| `XxxQueryParams` | `QueryParams` (which is `pydantic.BaseModel`) | the **inputs** a caller may pass — `symbol`, `start_date`, `end_date` | validated *before* the fetch; defines the request contract |
| `XxxData` | `Data` (which is `pydantic.BaseModel`) | **one row** of the output — `date`, `open`, `high`, `low`, `close`, `volume`, `vwap` | validated *after* the fetch; defines the response-row contract |

That both are `pydantic.BaseModel` subclasses is not incidental — it is the entire enforcement mechanism.
The standard is a *type*, so "this provider must produce the standard shape" becomes a Pydantic validation
that fails loudly at the boundary instead of a convention nobody checks. From the base classes I read on
`develop`:

```python
# OpenBB-finance/OpenBB@develop:openbb_platform/core/openbb_core/provider/abstract/query_params.py
class QueryParams(BaseModel):
    """The OpenBB Standardized QueryParams Model. ... to be extended by
    providers and to be used by fetchers when making data provider requests."""
    __alias_dict__: dict[str, str] = {}
    __json_schema_extra__: dict[str, Any] = {}
    model_config = ConfigDict(extra="allow", populate_by_name=True)
```

```python
# OpenBB-finance/OpenBB@develop:openbb_platform/core/openbb_core/provider/abstract/data.py
class Data(BaseModel):
    """The OpenBB Standardized Data Model. ... structured to support dynamic field definitions."""
    __alias_dict__: dict[str, str] = {}
    model_config = ConfigDict(
        extra="allow",
        populate_by_name=True,
        strict=False,
        alias_generator=AliasGenerator(
            validation_alias=alias_generators.to_camel,
            serialization_alias=alias_generators.to_snake,
        ),
    )
```

Read off the two configs (both verified in source, file-cited above):

- **`extra="allow"`** — a provider may carry *more* fields than the standard declares; Pydantic keeps them
  instead of raising. This is what lets a provider subclass "add fields" without the base class knowing
  about them, and it is the **preserve-don't-drop** escape hatch. (Details in
  [`patterns-pydantic-v2-validation-coercion.md`](patterns-pydantic-v2-validation-coercion.md).)
- **`populate_by_name=True`** — a field can be filled by either its Python name or its alias. Required for
  the `__alias_dict__` round-trip to work.
- **`strict=False` (on `Data`)** — relaxed coercion: a numeric string `"4.20"` will coerce to `float`
  rather than erroring. Finance feeds ship numbers-as-strings constantly; strict mode would reject them.
- **`alias_generator` (on `Data`)** — `validation_alias=to_camel`, `serialization_alias=to_snake`. This is
  the *automatic* camelCase↔snake_case bridge (§4). It is on `Data` (the response side) and **not** on
  `QueryParams` (the request side) — a deliberate asymmetry, explained in §4.3.

> **Design note for our line.** We re-derive this same two-class shape in our own namespace (no OpenBB
> import — clean-room). We add **two things OpenBB does not need because it never stores**: (1) a
> `Provenance` stamp travels alongside each `Data` row (the `commercialOk`/source/as-of metadata —
> [`patterns-provenance-stamping.md`](patterns-provenance-stamping.md)), and (2) the standard `Data` is the
> exact row the time-series warehouse persists, so its field set is also our **storage schema contract**,
> not just a transport shape. That raises the stakes on getting the intersection right: an `Optional` field
> we add later is a nullable column migration, not just a model edit.

### 1.2 "Logical endpoint", not "API call"

A standard model is keyed to the *question*, not to any one vendor's URL. "Daily equity OHLCV" is one
logical endpoint even though Polygon serves it from `/v2/aggs/...`, FMP from
`/historical-price-eod/full`, and yfinance from a Python library call. The standard model is the place
where those three *converge*. If you find yourself wanting two standard models for what is plainly one user
question, you have mis-drawn the boundary — collapse them. If one standard model is straining to cover two
genuinely different questions (intraday tick vs end-of-day bar), split it.

---

## 2. The field-intersection rule — the heart of the layer

### 2.1 The rule, verbatim and operationalized

> **The rule (OpenBB's wording):** *"We standardize fields that are shared between two or more providers.
> If there is a third provider that doesn't share the same fields, we will declare it as an `Optional`
> field."* — [`CONTRIBUTING.md`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)

Operationalized into a procedure you can run mechanically when adding/extending a standard model:

1. **Enumerate** the fields every candidate provider can return for this endpoint. Build a presence matrix:
   field × provider → `present? Y/N`.
2. **Required-standard** ← fields present in **all** providers you are committing to, that carry the same
   meaning. (These can be `Field(...)` with no default — truly required.)
3. **Optional-standard** ← fields present in **≥2** providers but **not all**. Declare them on the standard
   with `Optional[...] = Field(default=None)`. A provider that lacks the field simply leaves it `None`.
4. **Provider-specific** ← fields present in **exactly one** provider. **These never go on the standard.**
   They go on that provider's subclass (§3).
5. **Re-check meaning, not just name.** Two providers calling a field `close` does not make it the *same*
   `close` (one adjusted, one raw). Name-collision is *not* field-sharing. Sharing requires same concept;
   value reconciliation is a separate layer (§7). If the meanings differ irreconcilably, they are two
   different standard fields (e.g. `close` and `adj_close`), not one.

### 2.2 The three buckets, as a decision table

| Field appears in… | Same meaning across them? | Goes where | Declared as |
|---|---|---|---|
| **all** committed providers | yes | standard model | `Field(...)` (required, no default) |
| **≥2** providers (not all) | yes | standard model | `Optional[...] = Field(default=None)` |
| **exactly 1** provider | n/a | that **provider subclass** only | `Optional[...] = Field(default=None)` on the subclass |
| **≥2** providers but **different meaning** | no | **two** standard fields | each its own `Field`, distinct names |

The **default for everything you are unsure about is `Optional[...] = None`.** A field that is required and
turns out to be missing for some provider makes the *whole row* fail validation — you have coupled an
unrelated provider's quirk to your required contract. `Optional` is the safe direction; you can always
tighten later (with a migration). This mirrors the licensing-gate default in our line: **default to the
permissive-for-the-model, restrictive-for-the-promise side** (`commercialOk` defaults `false`; a finance
field defaults `Optional`).

### 2.3 Why intersection and not union (and not lowest-common-denominator)

Three candidate designs, and why OpenBB's intersection-with-optional wins:

| Design | What the standard required-set is | Failure mode |
|---|---|---|
| **Union** (every field any provider has, all required) | huge | Every provider fails validation on every field it lacks. The standard is unsatisfiable. |
| **Strict intersection** (only fields ALL providers have, nothing else) | tiny | You lose `vwap`, `volume`, dividends — real, comparable data — just because one provider omits them. Lossy. |
| **Intersection-with-Optional (OpenBB)** | the genuinely-shared core, **required**; the partially-shared, **Optional** | none of the above — the guaranteed core is always present; partial data is carried when available, `None` when not |

The middle column is the contract a consumer can *rely* on: "for this endpoint, these fields are always
here." The `Optional` fields are *bonus, when present* — a consumer must null-check them, and that null is
honest ("this provider didn't supply it"), never fabricated.

### 2.4 The hard rule on provider subclasses: never narrow

A provider model **SUBCLASSES** the standard and **may only ADD**. The three forbidden moves:

| Forbidden move | Why it breaks comparability |
|---|---|
| Remove a standard field | Caller swapping to this provider gets a *different shape* — the guarantee is void. |
| Re-declare a required standard field as `Optional` | Same: a consumer that relied on it being present now gets `None` from this one provider. |
| Re-type a standard field to an incompatible type | The warehouse column type no longer holds for this provider's rows. |

OpenBB's contributing guide states the governance bluntly:

> *"The standard models are created and maintained by the OpenBB team."* … you cannot remove or narrow the
> required fields defined in the standard model parent class.
> — [`CONTRIBUTING.md`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)

In Python the subclass *can* technically re-annotate a parent field, so this is a **review discipline plus a
test**, not something the type system stops on its own. Our line enforces it with a registry-conformance
test (`patterns-provider-registry-plugin.md`): for each provider model, assert its required-field set is a
**superset** of the standard's required-field set and that no standard field's type narrows. The check:

```python
# Conformance guard — run in CI for every provider Data subclass.
# Re-derived for our line; not copied from OpenBB.
def assert_extends_standard(provider_cls: type[BaseModel], standard_cls: type[BaseModel]) -> None:
    std_fields = standard_cls.model_fields
    prov_fields = provider_cls.model_fields
    for name, std_field in std_fields.items():
        assert name in prov_fields, (
            f"{provider_cls.__name__} dropped standard field '{name}'"
        )
        prov_field = prov_fields[name]
        # A required standard field must not become optional on the subclass.
        if std_field.is_required():
            assert prov_field.is_required(), (
                f"{provider_cls.__name__} narrowed required '{name}' to optional"
            )
        # The annotation must be the same or a widening (we keep it exact in practice).
        assert prov_field.annotation == std_field.annotation, (
            f"{provider_cls.__name__} re-typed standard '{name}': "
            f"{std_field.annotation} -> {prov_field.annotation}"
        )
```

`model_fields` and `FieldInfo.is_required()` are the Pydantic v2 introspection surface for this; see
[Pydantic v2 — Models / `model_fields`](https://docs.pydantic.dev/latest/concepts/models/) and
[`FieldInfo`](https://docs.pydantic.dev/latest/api/fields/).

---

## 3. How providers subclass the standard — read from real source

This is the concrete heart. Below are the **standard model** and **two real provider subclasses I read on
`develop`**, verbatim, so the abstract rule above lands on actual code.

### 3.1 The standard model — `EquityHistorical`

Verbatim, the whole standard (read this session):

```python
# OpenBB-finance/OpenBB@develop:openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py
"""Equity Historical Price Standard Model."""

from datetime import (
    date as dateType,
    datetime,
)

from openbb_core.provider.abstract.data import Data
from openbb_core.provider.abstract.query_params import QueryParams
from openbb_core.provider.utils.descriptions import (
    DATA_DESCRIPTIONS,
    QUERY_DESCRIPTIONS,
)
from pydantic import Field, field_validator


class EquityHistoricalQueryParams(QueryParams):
    """Equity Historical Price Query."""

    symbol: str = Field(description=QUERY_DESCRIPTIONS.get("symbol", ""))
    start_date: dateType | None = Field(
        default=None,
        description=QUERY_DESCRIPTIONS.get("start_date", ""),
    )
    end_date: dateType | None = Field(
        default=None,
        description=QUERY_DESCRIPTIONS.get("end_date", ""),
    )

    @field_validator("symbol", mode="before", check_fields=False)
    @classmethod
    def to_upper(cls, v: str) -> str:
        """Convert field to uppercase."""
        return v.upper()


class EquityHistoricalData(Data):
    """Equity Historical Price Data."""

    date: dateType | datetime = Field(description=DATA_DESCRIPTIONS.get("date", ""))
    open: float = Field(description=DATA_DESCRIPTIONS.get("open", ""))
    high: float = Field(description=DATA_DESCRIPTIONS.get("high", ""))
    low: float = Field(description=DATA_DESCRIPTIONS.get("low", ""))
    close: float = Field(description=DATA_DESCRIPTIONS.get("close", ""))
    volume: float | int | None = Field(
        default=None, description=DATA_DESCRIPTIONS.get("volume", "")
    )
    vwap: float | None = Field(
        default=None, description=DATA_DESCRIPTIONS.get("vwap", "")
    )

    @field_validator("date", mode="before", check_fields=False)
    @classmethod
    def date_validate(cls, v):
        """Return formatted datetime."""
        from dateutil import parser

        if ":" in str(v):
            return parser.isoparse(str(v))
        return parser.parse(str(v)).date()
```

Read the field-intersection rule **off this exact code**:

| Field | Declared as | What that says about the providers |
|---|---|---|
| `symbol` (query) | required `str` | every provider needs a ticker — truly universal |
| `start_date`, `end_date` (query) | `Optional = None` | a provider can default the range; not all require both |
| `date`, `open`, `high`, `low`, `close` (data) | required | the OHLC core — guaranteed by **all** providers for this endpoint |
| `volume` (data) | `float \| int \| None = None` | shared by ≥2 but not guaranteed by *all* (some series omit it) → **Optional** |
| `vwap` (data) | `float \| None = None` | the textbook Optional: present in some providers (Polygon, Tiingo), absent in others (raw yfinance) → on the **standard** as Optional, not dropped |

`vwap` is the canonical worked instance of the rule: it is *not* removed (that would be lossy for the
providers that have it) and *not* required (that would break the providers that don't). It is
`Optional[...] = None` on the standard — the exact "third provider doesn't share it → Optional" case from
the verbatim rule.

> **Descriptions are centralized.** `QUERY_DESCRIPTIONS` / `DATA_DESCRIPTIONS` are shared dicts so the
> *same* field carries the *same* human description everywhere
> ([`...:core/openbb_core/provider/utils/descriptions.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/utils/descriptions.py),
> read this session — e.g. `"open": "The open price."`, `"vwap": "Volume Weighted Average Price over the
> period."`). This is a small but real anti-drift mechanism: a field's *meaning* lives in one place.

### 3.2 Provider subclass #1 — FMP (renames params **and** swaps to adjusted OHLC)

Verbatim, read this session:

```python
# OpenBB-finance/OpenBB@develop:openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py
class FMPEquityHistoricalQueryParams(EquityHistoricalQueryParams):
    """FMP Equity Historical Price Query.
    Source: https://site.financialmodelingprep.com/developer/docs#historical-price-eod-full
    """

    __alias_dict__ = {"start_date": "from", "end_date": "to"}
    __json_schema_extra__ = {
        "symbol": {"multiple_items_allowed": True},
    }

    interval: Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d"] = Field(
        default="1d", description=QUERY_DESCRIPTIONS.get("interval", "")
    )
    adjustment: Literal["splits_only", "splits_and_dividends", "unadjusted"] = Field(
        default="splits_only",
        description="Type of adjustment for historical prices. Only applies to daily data.",
    )
    # ... model_validator that rejects adjustment on non-daily intervals ...


class FMPEquityHistoricalData(EquityHistoricalData):
    """FMP Equity Historical Price Data."""

    __alias_dict__ = {
        "open": "adjOpen",
        "high": "adjHigh",
        "low": "adjLow",
        "close": "adjClose",
    }

    change: float | None = Field(
        default=None,
        description="Change in the price from the previous close.",
    )
    change_percent: float | None = Field(
        default=None,
        description="Change in the price from the previous close, as a normalized percent.",
        json_schema_extra={"x-unit_measurement": "percent", "x-frontend_multiply": 100},
    )
    # ... field_validator that divides change_percent by 100 ...
```

What this subclass demonstrates about the rule:

- **It only ADDS.** `FMPEquityHistoricalData` keeps every standard field (`date/open/high/low/close/volume/
  vwap`) and adds `change`, `change_percent` — both `Optional = None`, because they are FMP-specific (the
  field-intersection rule again, one level down: a field unique to one provider lives on that provider's
  subclass, as Optional).
- **It only ADDS to the query too.** `interval`, `adjustment` are FMP-specific params; the standard's
  `symbol/start_date/end_date` are untouched and un-narrowed.
- **`__alias_dict__` on the query** maps *our* `start_date`/`end_date` → FMP's `from`/`to`. This is a
  param rename (the "Transform query" stage of TET).
- **`__alias_dict__` on the data** maps *our* `open/high/low/close` → FMP's `adjOpen/adjHigh/adjLow/
  adjClose`. **Read this carefully — it is a trap.** The alias makes FMP's *adjusted* columns satisfy the
  standard's plain `open/high/low/close`. That is field-level renaming doing a *semantic* substitution:
  FMP's standard "close" is the **split-adjusted** close, while another provider's "close" might be raw.
  **The schema layer cannot see this** — both validate fine, both are `float`. This is precisely the
  hand-off line where the standard-model layer ends and **value normalization** begins (§7). The
  field-intersection layer guarantees *a* `close` exists and is a number; it does **not** guarantee two
  providers' `close` mean the same economic thing.

### 3.3 Provider subclass #2 — yfinance (carries dividends/splits as Optional extras)

Verbatim, read this session:

```python
# OpenBB-finance/OpenBB@develop:openbb_platform/providers/yfinance/openbb_yfinance/models/equity_historical.py
class YFinanceEquityHistoricalQueryParams(EquityHistoricalQueryParams):
    """Yahoo Finance Equity Historical Price Query."""

    __json_schema_extra__ = {
        "symbol": {"multiple_items_allowed": True},
        "interval": {"choices": ["1m","2m","5m","15m","30m","60m","90m","1h","1d","5d","1W","1M","1Q"]},
    }

    interval: Literal["1m","2m","5m","15m","30m","60m","90m","1h","1d","5d","1W","1M","1Q"] = Field(
        default="1d", description=QUERY_DESCRIPTIONS.get("interval", ""),
    )
    extended_hours: bool = Field(default=False, description="Include Pre and Post market data.")
    include_actions: bool = Field(default=True, description="Include dividends and stock splits in results.")
    adjustment: Literal["splits_only", "splits_and_dividends"] = Field(
        default="splits_only", description="The adjustment factor to apply. Default is splits only.",
    )
    _ignore_tz: bool = PrivateAttr(default=True)
    _period: PERIODS = PrivateAttr(default="max")
    # ... more PrivateAttr config knobs ...


class YFinanceEquityHistoricalData(EquityHistoricalData):
    """Yahoo Finance Equity Historical Price Data."""

    __alias_dict__ = {
        "split_ratio": "stock_splits",
        "dividend": "dividends",
    }

    split_ratio: float | None = Field(
        default=None, description="Ratio of the equity split, if a split occurred.",
    )
    dividend: float | None = Field(
        default=None, description="Dividend amount (split-adjusted), if a dividend was paid.",
    )
```

What this subclass adds to the picture:

- **Same standard core, different extras.** yfinance keeps `date/open/high/low/close/volume/vwap` and adds
  `split_ratio`, `dividend` (both Optional, both yfinance-specific). FMP added `change`/`change_percent`;
  yfinance added `split_ratio`/`dividend`. **The intersection (the standard) is what they share; the
  union lives across the subclasses.** This is the rule at work across two real providers at once.
- **`__json_schema_extra__ → choices`** advertises yfinance's specific allowed `interval` values to the
  schema/UI layer (a different valid-set than FMP's). The standard does not own `interval` at all — it is a
  per-provider param — so each subclass declares its own `Literal`.
- **`PrivateAttr` config knobs** (`_ignore_tz`, `_period`, …) are *not data fields* — Pydantic excludes
  underscore-prefixed `PrivateAttr` from the schema/serialization
  ([Pydantic v2 — Private model attributes](https://docs.pydantic.dev/latest/concepts/models/#private-model-attributes)).
  They are fetch-config that the Fetcher's `extract_data` reads. Worth knowing so you don't mistake them
  for standard or Optional data fields.

### 3.4 Provider subclass #3 — Polygon (pure rename of cryptic native names) `[blog-sourced]`

Polygon's aggregates response uses single-letter keys (`t,o,h,l,c,v,vw`). Its model maps them straight onto
the standard via `__alias_dict__`:

```python
# Polygon's mapping, per OpenBB's own data-pipeline blog (I could not open the exact `develop` file —
# the path 404'd this session — so this is [blog-sourced], not source-read):
class PolygonEquityHistoricalData(EquityHistoricalData):
    __alias_dict__ = {
        "date": "t", "open": "o", "high": "h", "low": "l",
        "close": "c", "volume": "v", "vwap": "vw",
    }
```

— [OpenBB, *The OpenBB Platform data pipeline*](https://openbb.co/blog/the-openbb-platform-data-pipeline)
(the post shows this exact `__alias_dict__`).

Polygon completes the three-provider picture cleanly:

| Provider | What its `__alias_dict__` does on `Data` | Adds these Optional extras |
|---|---|---|
| **Polygon** `[blog-sourced]` | `t→date, o→open, h→high, l→low, c→close, v→volume, vw→vwap` (pure rename of cryptic names) | (none in the blog snippet) |
| **FMP** (source-read) | `adjOpen→open, adjHigh→high, adjLow→low, adjClose→close` (rename **+ adjusted-vs-raw semantic swap**) | `change`, `change_percent` |
| **yfinance** (source-read) | `stock_splits→split_ratio, dividends→dividend` (renames the *extra* fields, not OHLC) | `split_ratio`, `dividend` |

Three providers, **one standard `EquityHistoricalData`**. A caller does:

```python
# OpenBB usage — the apples-to-apples payoff (docs example):
obb.equity.price.historical("AAPL", start_date="2024-01-01", provider="polygon")
obb.equity.price.historical("AAPL", start_date="2024-01-01", provider="fmp")
obb.equity.price.historical("AAPL", start_date="2024-01-01", provider="yfinance")
```

— and gets the **same `date/open/high/low/close/volume/vwap` columns** every time, regardless of which
vendor's dialect was on the wire ([OpenBB Providers docs](https://docs.openbb.co/odp/python/extensions/providers):
the standard is *"guaranteed to always be returned by any of the supported providers"*). Charts, the
warehouse schema, and validators are written **once** against the standard and never branch on `provider=`.

---

## 4. camelCase→snake_case: automatic vs. when you MUST hand-map

This is the single most misunderstood mechanic in the layer, so it gets its own section.

### 4.1 The two distinct rename mechanisms

There are **two** separate things renaming fields, and conflating them causes bugs:

| Mechanism | Where it lives | Handles | Direction |
|---|---|---|---|
| **`alias_generator` (automatic)** | `Data.model_config`, base class | *case-style* differences only: `adjClose`↔`adj_close`, `splitRatio`↔`split_ratio` | camelCase (validation) ↔ snake_case (serialization) |
| **`__alias_dict__` (manual)** | each provider model | *name* differences: `t→date`, `o→open`, `from→start_date`, `adjClose→close` | provider-native → standard |

The automatic one is configured in the base `Data` (read this session):

```python
# core/openbb_core/provider/abstract/data.py
alias_generator=AliasGenerator(
    validation_alias=alias_generators.to_camel,     # accept camelCase on the way IN
    serialization_alias=alias_generators.to_snake,  # emit snake_case on the way OUT
)
```

This is exactly the OpenBB contributing rule:

> *"When mapping the column names from a provider-specific model to the standard model, the CamelCase to
> snake_case conversion is done automatically. If the column names are not the same, you'll need to
> manually map them. (e.g. `o` -> `open`)"*
> — [`CONTRIBUTING.md`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)

### 4.2 The decision: automatic vs. hand-map

| Provider's raw key | Standard field | Is it just a case difference? | What handles it |
|---|---|---|---|
| `adjClose` | `adj_close` | **yes** — `adjClose` is the camelCase of `adj_close` | **automatic** `alias_generator` — no `__alias_dict__` entry needed |
| `splitRatio` | `split_ratio` | yes | automatic |
| `t` | `date` | **no** — different *word*, not a case variant | **MUST hand-map** in `__alias_dict__`: `{"date": "t"}` |
| `o` / `h` / `l` / `c` / `v` / `vw` | `open` / `high` / `low` / `close` / `volume` / `vwap` | no | MUST hand-map |
| `from` (FMP query) | `start_date` | no | MUST hand-map: `{"start_date": "from"}` |
| `adjClose` → `close` (FMP) | `close` | **no** — this is a *semantic* remap (adjusted→close), not casing | MUST hand-map: `{"close": "adjClose"}` |

**The rule of thumb:** if lower-casing the provider key and inserting underscores at the case boundaries
yields the standard field name, the automatic generator handles it — leave it out of `__alias_dict__`. If
the provider uses a *different word* (or a cryptic code, or a semantic substitute), you **must** put it in
`__alias_dict__` by hand. Note FMP's `{"close": "adjClose"}` is in the hand-map even though `adjClose`
*looks* camelCase — because the target is `close`, not `adj_close`; the case-generator would have produced
`adj_close`, which is a *different field*. The mapping is `close ← adjClose` (a deliberate semantic choice),
so it must be explicit.

> **The direction gotcha.** In OpenBB's `__alias_dict__`, the **key is the standard (our) name** and the
> **value is the provider's raw name** — `{"date": "t"}` means "our `date` comes from their `t`". The
> base `Data._use_alias` validator inverts the dict to apply it (read this session: it builds
> `aliases = {orig: alias for alias, orig in cls.__alias_dict__.items()}` then renames incoming keys). Get
> the direction backwards and nothing maps. Full mechanics + our line's direction convention live in
> [`patterns-field-aliasing-recipes.md`](patterns-field-aliasing-recipes.md).

### 4.3 Why the auto-generator is on `Data` but not `QueryParams`

`QueryParams` has **no** `alias_generator` (re-check the verbatim config in §1.1 — its `model_config` is
just `ConfigDict(extra="allow", populate_by_name=True)`). The asymmetry is deliberate:

- **`Data`** ingests *machine-generated* provider JSON whose casing varies wildly (`adjClose`, `marketCap`,
  …). An automatic camel↔snake bridge saves dozens of trivial alias entries. The cost — accidental
  collisions when two different camelCase keys snake to the same name — is low for response payloads.
- **`QueryParams`** ingests *our own* call. Query param names are few, deliberate, and we control them;
  there is no fleet of camelCase variants to auto-absorb. The provider-side param rename
  (`start_date→from`) is the *whole* point of `__alias_dict__` on the query, applied explicitly in
  `model_dump` (read this session: `QueryParams.model_dump` rewrites keys through `__alias_dict__` when
  serializing the query for the upstream call). Auto-casing here would add surprise without benefit.

> **For our line:** keep the same asymmetry. The response side (what we persist) benefits from automatic
> case-normalization; the request side (which we author) should be explicit. One caveat we add: because our
> `Data` row is *also* our storage schema, an automatic alias that silently maps two upstream keys onto one
> column is a data-loss bug, not just a transport quirk — so our conformance test (§2.4) also asserts no
> two declared fields collapse to the same serialization name.

---

## 5. require vs. Optional — the decision table

When you add a field to a standard model, the require-vs-Optional call is the single most consequential
choice (it becomes a NOT NULL vs nullable column in our warehouse). The table:

| Situation | Verdict | Rationale |
|---|---|---|
| Present in **every** committed provider, same meaning, never legitimately absent | **required** `Field(...)` | the guaranteed core; a missing value is a *real error* that should fail validation (e.g. a bar with no `close`) |
| Present in **≥2** providers but not all | **`Optional = None`** | the verbatim rule; a provider that lacks it leaves `None` |
| Present in **1** provider only | **not on the standard** — `Optional = None` on that **subclass** | provider-specific; the standard never learns about it |
| Present in all, but *legitimately* sometimes absent (e.g. `volume` for an index level) | **`Optional = None`** even though "shared" | "shared" ≠ "always populated"; honest null beats a fabricated 0 |
| You are unsure whether all providers have it | **`Optional = None`** (default to permissive) | tightening later is a clean migration; loosening later after consumers relied on presence is a breaking change |
| Two providers share a *name* but the *meaning* differs irreconcilably | **two fields**, each its own `Field` | `close` vs `adj_close`; never one field with two meanings |
| A computed/derived value you'll fill in transform (e.g. `change_percent`) | **`Optional = None`** | derived values are provider-specific or compute-dependent; never required of upstream |

**The asymmetry of cost** is why the default leans Optional:

- *Wrongly required* → every provider that lacks the field **fails to validate at all** → you lose the
  *entire row*, including the fields that were fine. One bad assumption nukes good data.
- *Wrongly optional* → a consumer occasionally null-checks something that was always present. Mildly
  annoying. No data lost.

In a finance pipeline where one provider's quirk should never poison another's data, **Optional is the
safe direction.** Tighten a field to required only when you have *positive evidence* (a conformance test
over real samples from every committed provider) that it is always present.

> **Note on `volume` specifically.** In OpenBB's standard it is `float | int | None = None` (Optional) —
> not because volume is exotic, but because the *same* `EquityHistoricalData` row is reused for instruments
> where volume is absent or meaningless (some index levels, some FX). The lesson: require-vs-Optional is a
> property of *the standard model's whole domain*, not of the one provider you're looking at today.

---

## 6. Why this guarantees provider-swap comparability

The single sentence that justifies the entire layer:

> **Because every provider for an endpoint emits the same guaranteed standard shape, a consumer can change
> `provider=` and the downstream code does not change — it compares apples to apples.**

Mechanically, here is *why* the guarantee holds, traced to the parts above:

1. **The standard required-set is a type.** `EquityHistoricalData` requires `date/open/high/low/close`. Any
   row that does not produce them **fails Pydantic validation at the transform boundary** — it never
   reaches the warehouse. So the warehouse *cannot* contain a row missing the core. (§1.1)
2. **Subclasses can only add.** A provider model can carry `change`, `dividend`, etc., but it cannot remove
   or narrow `date/open/high/low/close` (§2.4 + the conformance test). So *every* provider's rows are a
   superset of the standard.
3. **Consumers read the standard view.** Charts, comparison logic, and the storage schema are written
   against `EquityHistoricalData`'s fields. They see `open` whether it came from Polygon's `o`, FMP's
   `adjOpen`, or yfinance's `Open` — the alias machinery already normalized the *name*. (§3, §4)
4. **Therefore swapping `provider=` is invisible downstream.** The only thing that changed is which
   subclass produced the row; the standard projection is identical.

The comparability the layer *does* and *does not* buy:

| Comparable after this layer? | What it covers | Where the rest lives |
|---|---|---|
| **Field presence & name** ✅ | `open` is always called `open` and is always there | this doc / `patterns-field-aliasing-recipes.md` |
| **Field type** ✅ | `open` is always a number, not sometimes a string | `patterns-pydantic-v2-validation-coercion.md` |
| **Field *value* meaning** ❌ | FMP's `close` is adjusted, Polygon's is raw — both validate, both differ | `theory-value-normalization-units-currency.md` |
| **Units / scale** ❌ | one provider in cents, another in dollars; millions vs thousands | `theory-value-normalization-units-currency.md` |
| **Timestamps / timezone / calendar** ❌ | one in epoch-ms UTC, one in exchange-local date | `theory-time-calendar-frequency-normalization.md` |
| **Entity identity** ❌ | is "AAPL" on Polygon the same security as "AAPL" on FMP? corporate actions? | the **security master** (`patterns-provider-registry-plugin.md` + the service's own security-master design) |

**This is the whole point of §8 below.** The standard-model layer makes the *shape* comparable. It is the
*easy 20%*. Believing it also makes the *values* comparable is the exact failure this skill exists to
prevent.

---

## 7. The hand-off line: where this layer ends

The standard-model layer's contract is **narrow and precise**:

> *Given a raw provider response, produce a validated row whose field **names** and **types** match the
> standard, with provider-specific extras carried as Optional, and an honest `None` wherever the provider
> lacked a shared field.*

It explicitly does **not** promise:

- that two providers' `close` are the *same economic number* (adjusted vs raw, currency, split treatment),
- that `volume` is in shares vs round-lots vs notional,
- that `date` means the same instant (exchange-local trading date vs UTC timestamp),
- that "AAPL" refers to the same security across providers (the identity/security-master problem),
- that a basis-points field and a percent field have been reconciled to one representation.

Those are **value/row normalization** and **the security master**. The clean mental model:

```
raw provider JSON
      │
      ▼  ── STANDARD-MODEL LAYER (this doc) ──────────────────────────────
   [alias rename] → [type coerce] → [presence/Optional] → validated row    ← names & types comparable
      │
      ▼  ── VALUE NORMALIZATION (theory-value-normalization-units-currency,
      │      theory-time-calendar-frequency-normalization) ───────────────
   [unit/scale] → [currency] → [bps/pct/decimal] → [tz→UTC] → [calendar]    ← values comparable
      │
      ▼  ── SECURITY MASTER (registry + service design) ──────────────────
   [resolve symbol → canonical instrument id] → [corp-action alignment]     ← entities comparable
      │
      ▼  PERSIST (time-series warehouse)  +  Provenance stamp
```

Crossing a line without the prior one done is the classic bug: comparing FMP's adjusted `close` against
Polygon's raw `close` because "they're both `close` now" — a *value* error the *schema* layer cannot catch.
Keep the layers distinct in your head and in the code.

---

## 8. The "easy 20%" trap — what the popular reference makes look like the whole job

OpenBB's public material presents standardization as *the* hard problem solved — *"Every provider has
different words for the same thing, but OpenBB translates them in a standardized interface"*
([OpenBB blog](https://openbb.co/blog/the-openbb-platform-data-pipeline)). That sentence is true and it is
the easy 20%. The standard-model + `__alias_dict__` layer is genuinely elegant and worth copying — but a
junior reading the blog concludes "normalization = aliasing field names" and ships a pipeline that is
*schema-clean and value-wrong.*

What the field-intersection layer **deliberately leaves to others** (and a CTO must not let it hide):

| The layer makes look solved | What's actually still unsolved | The tell that it's been skipped |
|---|---|---|
| "all providers return `close`" | which `close` — adjusted? raw? in what currency? | a backtest whose returns jump where you switched providers |
| "all providers return `volume`" | shares vs round-lots vs notional; some are `None` | volume that is 100× off for one source |
| "all providers return `date`" | trading-date vs UTC-timestamp; exchange calendar | bars on a market holiday, or off-by-one days |
| "the schema validates" | the *value* could still be economically wrong | green tests, wrong numbers |
| "swap `provider=` freely" | identity: is it the *same security*? corporate actions? | a merger/ticker-change silently splices two instruments |

OpenBB itself does not claim the schema layer is the whole job — its value-side handling lives in
field validators and `json_schema_extra` unit hints (note FMP's
`json_schema_extra={"x-unit_measurement": "percent", "x-frontend_multiply": 100}` in §3.2, which is a
*value* concern leaking into the model). But the *blog framing* invites the misread. Our line states the
split explicitly in the skill's Non-Negotiable: **two separate normalizations, never conflated** — (a)
field/schema (this doc, the easy 20%) and (b) value/row (the hard 80%, separate references). The
security-master/identity problem is a *third* axis, harder still.

**The senior posture:** treat a clean standard-model pass as *necessary and ~20% of the way there*, never
as done. The skill's Output Contract grades a normalization "complete" only when the value-normalization
and identity questions are *answered* (even if "N/A for this all-GREEN gov source"), not just the schema.

---

## 9. Designing a standard model for our line — the checklist

When you create or extend a standard model for the data-analytics service, run this:

1. **Name the logical endpoint** (the user question), not a vendor URL. One question → one standard model.
2. **Build the presence matrix** (field × provider). Decide each field's bucket (required / Optional /
   provider-specific) by §2.1.
3. **Default unknowns to `Optional = None`.** Require only fields with positive evidence of universal
   presence (a conformance test over real samples from every committed provider).
4. **Re-check meaning, not name.** If two providers' same-named field differ irreconcilably, make two
   fields. Flag any field whose *value* needs reconciliation and hand it to the value-normalization layer —
   do **not** try to fix value semantics with an alias.
5. **Centralize descriptions** (one dict, like OpenBB's `DATA_DESCRIPTIONS`) so a field's meaning has one
   home.
6. **For each provider, write a subclass that only ADDS.** Put renames in `__alias_dict__` (manual) only
   when it's a *different word*; let the case-generator handle pure casing. Provider extras are Optional on
   the subclass.
7. **Run the conformance test** (§2.4): subclass required-set ⊇ standard required-set; no narrowing; no
   re-typing; no two fields colliding on one serialization name.
8. **Attach a `Provenance` stamp** to the standard `Data` (our addition;
   [`patterns-provenance-stamping.md`](patterns-provenance-stamping.md)) — source, `commercialOk`, as-of —
   because *we persist*, and a stored row without provenance is unauditable.
9. **State the hand-offs in writing**: which fields still need value normalization, timezone/calendar
   normalization, and security-master resolution. A standard model whose value/identity hand-offs are
   undocumented is the easy-20%-only trap (§8).
10. **Remember the storage implication.** Unlike OpenBB, our `Data` is the warehouse row. A new Optional
    field is a nullable column migration; a required field is NOT NULL. Design the intersection as if every
    decision is a schema migration — because it is.

---

## 10. Sources

Read at source level this session (file-cited inline above):

- [`OpenBB-finance/OpenBB@develop:openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py)
  — the `EquityHistoricalQueryParams` / `EquityHistoricalData` standard; the `vwap`/`volume` Optional pattern.
- [`...:core/openbb_core/provider/abstract/query_params.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/query_params.py)
  — `QueryParams(BaseModel)`, `__alias_dict__`, `__json_schema_extra__`, `model_dump` alias rewrite, no
  alias_generator.
- [`...:core/openbb_core/provider/abstract/data.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/data.py)
  — `Data(BaseModel)`, `extra="allow"`, `populate_by_name`, `strict=False`, the `AliasGenerator(to_camel /
  to_snake)`, the `_use_alias` model_validator (and its dict-inversion direction).
- [`...:core/openbb_core/provider/abstract/fetcher.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/fetcher.py)
  — the `Fetcher[Q, R]` generic that ties a `QueryParams` type to a `Data` return type (the TET methods).
- [`...:providers/fmp/openbb_fmp/models/equity_historical.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py)
  — FMP subclass: query `__alias_dict__` (`from`/`to`), data `__alias_dict__` (`adjOpen`→`open` etc.),
  Optional extras `change`/`change_percent`.
- [`...:providers/yfinance/openbb_yfinance/models/equity_historical.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/yfinance/openbb_yfinance/models/equity_historical.py)
  — yfinance subclass: `__json_schema_extra__` choices, Optional extras `split_ratio`/`dividend`,
  `PrivateAttr` config knobs.
- [`...:core/openbb_core/provider/utils/descriptions.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/utils/descriptions.py)
  — centralized `QUERY_DESCRIPTIONS` / `DATA_DESCRIPTIONS`.

Primary docs / blog (quoted inline):

- [`OpenBB-finance/OpenBB@develop:openbb_platform/CONTRIBUTING.md`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/CONTRIBUTING.md)
  — the verbatim field-intersection rule; the camelCase→snake_case-automatic / hand-map rule; the
  "standard models are maintained by the OpenBB team / cannot narrow" governance.
- [OpenBB — *The OpenBB Platform data pipeline (TET)*](https://openbb.co/blog/the-openbb-platform-data-pipeline)
  — the Polygon `__alias_dict__` `[blog-sourced]`; "different words for the same thing"; the snake_case /
  OHLCV-naming guarantees.
- [OpenBB Providers docs](https://docs.openbb.co/odp/python/extensions/providers)
  — the "guarantee a set of fields … by any of the supported providers" promise; the no-storage stance we
  reject for our read path.

Pydantic v2 (installed-version behaviour cited):

- [Pydantic v2 — Models / `model_fields` / private attributes](https://docs.pydantic.dev/latest/concepts/models/),
  [Fields / `FieldInfo`](https://docs.pydantic.dev/latest/api/fields/),
  [Aliases / `AliasGenerator`](https://docs.pydantic.dev/latest/concepts/alias/) — `is_required()`,
  `PrivateAttr` exclusion, the camel/snake alias generator.

Our line's own docs (cross-referenced):

- [`.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  — primitive #1(a) (the field-intersection primitive) and CRITICAL-2 (why we persist, the rejected
  no-storage model). Sibling references: [`theory-tet-pipeline.md`](theory-tet-pipeline.md),
  [`theory-value-normalization-units-currency.md`](theory-value-normalization-units-currency.md),
  [`theory-time-calendar-frequency-normalization.md`](theory-time-calendar-frequency-normalization.md),
  [`patterns-field-aliasing-recipes.md`](patterns-field-aliasing-recipes.md),
  [`patterns-pydantic-v2-validation-coercion.md`](patterns-pydantic-v2-validation-coercion.md),
  [`patterns-build-a-provider-fetcher.md`](patterns-build-a-provider-fetcher.md),
  [`patterns-provider-registry-plugin.md`](patterns-provider-registry-plugin.md),
  [`patterns-provenance-stamping.md`](patterns-provenance-stamping.md).
