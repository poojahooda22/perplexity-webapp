# Pattern: Field & Schema Aliasing Recipes — `__alias_dict__` and `__json_schema_extra__`

> **Layer:** `patterns-*` (concrete build recipe).
> **Product line:** JPM-Markets re-engineering **data-analytics** product line — the data foundation
> for the Athena / DataQuery / Fusion-class market-data platform. **NOT Lumina.** Lumina is a separate
> repo (Bun + Express + Prisma) that happens to be the filesystem home for this research; do not wire
> any of this Python into Lumina's app code.
> **Stack assumption:** Python 3.12 · Pydantic **v2** (v2.13.x) · the OpenBB-style provider pattern
> (`Fetcher` = Transform→Extract→Transform, with `QueryParams` and `Data` Pydantic models). This doc is
> the mechanical recipe for the **field-renaming half** of normalization: how you map one vendor's
> `{t,o,h,l,c,v}` and another's `{fiscalDateEnding, reportedEPS}` onto one canonical schema **without
> scattering string literals through your transform code**.

> **What this doc answers.** When you ingest the *same logical series* (a daily OHLCV bar, an EPS
> surprise) from five vendors, each vendor names the columns differently. You need every record that
> reaches your warehouse / chart / API to use **one** name set (`date, open, high, low, close, volume`).
> This doc is the declarative recipe: put a single class-level dict (`__alias_dict__`) at the top of each
> provider model that maps **canonical → vendor**, use `__json_schema_extra__` to mark a param as
> multi-valued or enum-constrained, and reach for a `field_validator` only when the transform is
> computed (not a pure rename). It is the build-recipe sibling of the theory docs on the TET pipeline and
> the standard-model contract.

---

## 0. The on-ramp (plain language, then the rest is dense)

Five data vendors hand you the same daily price bar. Polygon calls the columns `t o h l c v`. Alpha
Vantage calls the open `1. open`. FMP calls the dividend-adjusted close `adjClose`. Your charting code,
your warehouse table, and your API contract must see **one** name for each — `date, open, high, low,
close, volume` — or every downstream consumer has to special-case every vendor. That is the failure this
recipe prevents.

The naive fix is to write, inside each vendor's transform function, lines like
`row["open"] = raw["o"]; row["close"] = raw["c"]; ...`. Do that across 30 vendors × 40 endpoints and you
have **thousands of scattered string literals** — a rename in one place, a silent `KeyError` in another,
no single place to read "what does Polygon call close?". The whole point of the pattern is to replace
that scatter with **one declarative dict per model**:

```python
class PolygonEquityHistoricalData(EquityHistoricalData):
    __alias_dict__ = {"date": "t", "open": "o", "high": "h", "low": "l", "close": "c", "volume": "v"}
```

Read that as *"my canonical `date` arrives from Polygon under the key `t`."* The model machinery does the
rename at validation time; your transform code never touches `"t"` again. Three things ride on top:

1. **`__alias_dict__`** — the rename map. Lives on both `QueryParams` (canonical param → vendor query
   key, used on the way *out* to the API) and `Data` (canonical field → vendor response key, used on the
   way *in* from the API). Same syntax, opposite direction. (§1–§4)
2. **`__json_schema_extra__`** — per-parameter metadata: `multiple_items_allowed: True` turns a single
   `"AAPL,MSFT,GOOG"` string into a real list and fans out N upstream calls; `choices: [...]` constrains
   a param to an enum. (§5–§6)
3. **`field_validator` / `model_validator`** — the escape hatch for when the transform is *computed*
   (divide a percent by 100, parse a date, coalesce `"None"`→`None`, derive a field), not a pure rename.
   A rename is an alias; a computation is a validator. Knowing which is which is most of the skill. (§7)

The rest is the exact mechanism (which Pydantic primitive each one compiles down to, and which
*direction* — input vs output — it acts in), every dict spelled out, and runnable before/after code.

---

## 1. The canonical schema is the contract — aliases bend vendors to it, never the reverse

Before any aliasing, you fix **one** standard model per logical entity. In the OpenBB pattern these are
the `standard_models` — the abstract base every provider model inherits. The standard model for a price
bar is, verbatim from the source:

```python
# openbb_core/provider/standard_models/equity_historical.py
class EquityHistoricalQueryParams(QueryParams):
    symbol: str = Field(description=QUERY_DESCRIPTIONS.get("symbol", ""))
    start_date: Optional[dateType] = Field(default=None, description=QUERY_DESCRIPTIONS.get("start_date", ""))
    end_date:   Optional[dateType] = Field(default=None, description=QUERY_DESCRIPTIONS.get("end_date", ""))

    @field_validator("symbol", mode="before", check_fields=False)
    @classmethod
    def to_upper(cls, v: str) -> str:
        """Convert field to uppercase."""
        return v.upper()


class EquityHistoricalData(Data):
    date:   Union[dateType, datetime] = Field(description=DATA_DESCRIPTIONS.get("date", ""))
    open:   float = Field(description=DATA_DESCRIPTIONS.get("open", ""))
    high:   float = Field(description=DATA_DESCRIPTIONS.get("high", ""))
    low:    float = Field(description=DATA_DESCRIPTIONS.get("low", ""))
    close:  float = Field(description=DATA_DESCRIPTIONS.get("close", ""))
    volume: Optional[Union[float, int]] = Field(default=None, description=DATA_DESCRIPTIONS.get("volume", ""))
    vwap:   Optional[float] = Field(default=None, description=DATA_DESCRIPTIONS.get("vwap", ""))
```

(Field set + the `to_upper` symbol validator confirmed against
[`openbb_core/provider/standard_models/equity_historical.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py).)

**The rule this encodes:** the canonical names — `symbol, start_date, end_date, date, open, high, low,
close, volume, vwap` — are the *only* names any downstream code (your chart endpoint, your warehouse
`COPY`, your API SDK) ever sees. Every provider subclass exists to translate **that vendor's wire names →
these canonical names**, and nothing else. A provider model that introduces a *new* canonical field name
for a concept the standard model already covers is the bug: now two consumers disagree on what "close"
is called. Add a field to the *standard model* (one place) before you add it to a provider.

> **Source diversity caveat (cto-rules §3).** The OpenBB platform is the most-readable open-source
> implementation of this exact pattern, so it anchors this doc. The *primitive* underneath — Pydantic v2
> aliases — is independently documented at
> [pydantic.dev/docs/validation/latest/concepts/alias](https://pydantic.dev/docs/validation/latest/concepts/alias/),
> and the OpenBB pattern is one *convention layer* over those primitives. §8 strips the convention away
> and shows the raw Pydantic, so you can apply the recipe even if you never use OpenBB's base classes.

---

## 2. `__alias_dict__` on `Data` — the canonical→vendor rename map (the OHLCV recipe)

`__alias_dict__` is a **class-level plain `dict`** declared at the *top* of the model, above any field.
Direction: **`{ standard_field_name : provider_field_name }`** — canonical key on the left, the raw
key the vendor sent on the right.

### 2.1 The Polygon OHLCV example (the canonical illustration)

Quoted verbatim from the OpenBB data-pipeline blog
([openbb.co/blog/the-openbb-platform-data-pipeline](https://openbb.co/blog/the-openbb-platform-data-pipeline)):

```python
class PolygonEquityHistoricalData(EquityHistoricalData):
    """Polygon Equity Historical Price Data."""

    __alias_dict__ = {
        "date": "t",
        "open": "o",
        "high": "h",
        "low": "l",
        "close": "c",
        "volume": "v",
        "vwap": "vw",
    }

    transactions: Optional[PositiveInt] = Field(
        default=None,
        description="Number of transactions for the symbol in the time period.",
        alias="n",
    )
```

The blog states the goal plainly: the pipeline "guarantees that field names are always in
`lower_snake_case` and have standardized names across all data sources, wherever possible" — so OHLCV
"consistently uses: `open`, `high`, `low`, `close`, and `volume`" no matter the vendor
([openbb.co blog](https://openbb.co/blog/the-openbb-platform-data-pipeline)).

**Read the example line by line:**

| Canonical field (your code uses) | `__alias_dict__` key | Vendor wire key (Polygon sends) | What Polygon's raw JSON looks like |
|---|---|---|---|
| `date`   | `"date"`   | `"t"`  | `{"t": 1701388800000, ...}` (epoch ms) |
| `open`   | `"open"`   | `"o"`  | `{"o": 191.41}` |
| `high`   | `"high"`   | `"h"`  | `{"h": 192.93}` |
| `low`    | `"low"`    | `"l"`  | `{"l": 190.83}` |
| `close`  | `"close"`  | `"c"`  | `{"c": 192.32}` |
| `volume` | `"volume"` | `"v"`  | `{"v": 53624412}` |
| `vwap`   | `"vwap"`   | `"vw"` | `{"vw": 192.05}` |

**Before / after.** Vendor row in → canonical record out:

```python
raw = {"t": 1701388800000, "o": 191.41, "h": 192.93, "l": 190.83, "c": 192.32, "v": 53624412, "vw": 192.05, "n": 740301}
rec = PolygonEquityHistoricalData(**raw)
rec.model_dump()
# {'date': ..., 'open': 191.41, 'high': 192.93, 'low': 190.83,
#  'close': 192.32, 'volume': 53624412, 'vwap': 192.05, 'transactions': 740301}
```

The transform function that produced `raw` **never wrote `row["open"] = raw["o"]`** — it just unpacked
the vendor dict into the model. The dict is the single source of truth for "what does Polygon call this".

### 2.2 `__alias_dict__` vs the per-field `alias=` — two ways to spell the same rename

Notice `transactions` above uses `alias="n"` on the `Field`, not a `__alias_dict__` entry. Both are
legal; they're equivalent for a single field. The convention:

- **Standard fields inherited from the base** (`open`, `close`, `date`…) → put their vendor names in
  **`__alias_dict__`**, because you're overriding the inherited field's source, and you can't redeclare
  the field just to add `alias=`. The dict reaches up and re-points an inherited field.
- **New provider-only fields** (`transactions`, which the standard model doesn't have) → declare the
  field fresh and put `alias=` right on it. It reads locally with the field it renames.

Don't mix randomly. A reader scanning the model wants *one* place — the dict at the top — for "how do I
re-point an inherited standard field," and the field line itself for "this is a new vendor extra."

### 2.3 The fundamentals example — Alpha Vantage EPS (`fiscalDateEnding`, `reportedEPS`)

OHLCV aliases are terse (`o`, `c`); fundamentals aliases are verbose camelCase. Same dict, different
shape of value. Verbatim mapping confirmed against
[`alpha_vantage/.../models/historical_eps.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/alpha_vantage/openbb_alpha_vantage/models/historical_eps.py):

```python
class AVHistoricalEpsData(HistoricalEpsData):
    """AlphaVantage Historical EPS Data."""

    __alias_dict__ = {
        "date": "fiscalDateEnding",
        "eps_actual": "reportedEPS",
        "eps_estimated": "estimatedEPS",
        "surprise_percent": "surprisePercentage",
        "reported_date": "reportedDate",
    }

    surprise: Optional[float] = Field(
        default=None,
        description="Surprise in EPS (Actual - Estimated).",
    )
    surprise_percent: Optional[Union[float, str]] = Field(
        default=None,
        description="EPS surprise as a normalized percent.",
        json_schema_extra={"x-unit_measurement": "percent", "x-frontend_multiply": 100},
    )
    reported_date: Optional[dateType] = Field(
        default=None,
        description="Date of the earnings report.",
    )
    report_time: Optional[str] = Field(
        default=None,
        description="Time of day when the earnings report was released, e.g., 'post-market'.",
    )
```

| Canonical field | Vendor wire key (Alpha Vantage) | Note |
|---|---|---|
| `date`             | `fiscalDateEnding`    | the period the EPS is *for* |
| `eps_actual`       | `reportedEPS`         | |
| `eps_estimated`    | `estimatedEPS`        | |
| `surprise_percent` | `surprisePercentage`  | also needs a *validator* — see §7, it's `/100` |
| `reported_date`    | `reportedDate`        | the day the report *dropped* (≠ `fiscalDateEnding`) |

> **A `date` aliased to `fiscalDateEnding` is a meaning decision, not just a rename.** Alpha Vantage's
> payload has two date-like fields (`fiscalDateEnding` and `reportedDate`); the model deliberately maps
> the canonical `date` to `fiscalDateEnding` (the period) and keeps `reportedDate` as a *separate*
> canonical field `reported_date`. Aliasing is where you make these "which vendor field *is* the
> canonical concept" calls — get it wrong and every consumer that sorts by `date` is sorting by the
> wrong axis. The alias dict is the one place to audit those calls.

### 2.4 The adjusted-vs-raw example — FMP (`adjClose`)

FMP returns *both* raw and split/dividend-adjusted OHLC, and the model chooses which one fills the
canonical fields. Verbatim from
[`fmp/.../models/equity_historical.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py):

```python
class FMPEquityHistoricalData(EquityHistoricalData):
    """FMP Equity Historical Price Data."""

    __alias_dict__ = {
        "open": "adjOpen",
        "high": "adjHigh",
        "low": "adjLow",
        "close": "adjClose",
    }
    ...
```

Here the alias dict carries a *semantic* decision again: canonical `close` is sourced from `adjClose`
(adjusted), not the raw `close` that FMP also sends. If your platform's contract is "`close` means
adjusted close," this dict is where you enforce it for FMP — one line, auditable, not buried in a
transform. (The FMP query side controls *whether* you even get adjusted data via an `adjustment` param;
see §6.2.)

---

## 3. `__alias_dict__` on `QueryParams` — the canonical→vendor *param* map (output direction)

The **same dict syntax** sits on the query model, but it acts in the opposite direction of the data
model: it renames *your canonical parameter names* into *the vendor's expected query-string keys* on the
way **out** to the API.

Verbatim, FMP again (same file as §2.4):

```python
class FMPEquityHistoricalQueryParams(EquityHistoricalQueryParams):
    """FMP Equity Historical Price Query."""

    __alias_dict__ = {"start_date": "from", "end_date": "to"}
    __json_schema_extra__ = {"symbol": {"multiple_items_allowed": True}}

    interval: Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d"] = Field(
        default="1d", description=QUERY_DESCRIPTIONS.get("interval", "")
    )
    adjustment: Literal["splits_only", "splits_and_dividends", "unadjusted"] = Field(
        default="splits_only",
        description="Type of adjustment for historical prices. Only applies to daily data.",
    )
```

And a second canonical example, verbatim from the OpenBB architecture-overview docs
([docs.openbb.co/odp/python/developer/architecture_overview](https://docs.openbb.co/odp/python/developer/architecture_overview)):

```python
class SomeQueryParams(QueryParams):
    __alias_dict__ = {
        "symbol": "ticker",
        "start_date": "begin",
    }
    __json_schema_extra__ = {
        "symbol": {"multiple_items_allowed": True, "choices": SOME_SYMBOL_LIST},
        "interval": {"multiple_items_allowed": False},
    }
```

| Your canonical param | Vendor query key it becomes on the wire |
|---|---|
| `symbol`     | `ticker` |
| `start_date` | `begin` (FMP: `from`) |
| `end_date`   | `to` |

**The direction is the whole point.** On `Data`, the alias maps vendor-name → canonical on the way *in*
(deserialization / validation). On `QueryParams`, the alias maps canonical → vendor on the way *out*
(serialization, when the query model is dumped to build the request URL). It is the *same* dict literal
because the OpenBB base classes wire each class's dict to the correct Pydantic primitive for its
direction (validation-side on `Data`, serialization-side on `QueryParams` — see §8 for the raw
mechanism). You write `{canonical: vendor}` in both; the framework reads it the right way around.

> **The mental model:** the alias dict always reads **"my canonical name `X`, the vendor's name `Y`"** —
> `{X: Y}`. What changes per class is *when* the rename fires (reading a response vs writing a request),
> not how you spell it. If you ever find yourself writing `{vendor: canonical}` to "make it work," you've
> inverted it; fix the direction at the framework layer, not by flipping the dict.

---

## 4. The auto CamelCase→snake_case path vs the explicit map — when you need *no* dict

Before you write an `__alias_dict__` entry, check whether the rename is **purely a case convention**. A
huge fraction of vendor fields differ from canonical only by `camelCase` vs `snake_case`
(`reportedDate` ↔ `reported_date`, `marketCap` ↔ `market_cap`, `priceToBook` ↔ `price_to_book`). For
those you need **zero dict entries** — the base `Data` model already installs an automatic
case-converting alias generator.

The OpenBB `Data` base class config (mechanism confirmed at
[`openbb_core/provider/abstract/data.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/data.py)):

```python
model_config = ConfigDict(
    extra="allow",
    populate_by_name=True,
    alias_generator=AliasGenerator(
        validation_alias=alias_generators.to_camel,    # input:  accept camelCase wire keys
        serialization_alias=alias_generators.to_snake, # output: emit snake_case
    ),
)
```

So **`reportedDate` validates into the snake_case field `reported_date` automatically** — you do *not*
need `__alias_dict__ = {"reported_date": "reportedDate"}`. (In §2.3's Alpha Vantage model, `reported_date`
*is* in the dict — but that's belt-and-suspenders / explicitness; the generator would have caught it.)

### 4.1 The exact `to_snake` rule (so you can predict what auto-converts)

Pydantic's `to_snake` is four sequential regex substitutions, verbatim from
[`pydantic/alias_generators.py`](https://github.com/pydantic/pydantic/blob/main/pydantic/alias_generators.py):

```python
def to_snake(camel: str) -> str:
    """Convert a PascalCase, camelCase, or kebab-case string to snake_case."""
    snake = re.sub(r'([A-Z]+)([A-Z][a-z])', lambda m: f'{m.group(1)}_{m.group(2)}', camel)
    snake = re.sub(r'([a-z])([A-Z])',       lambda m: f'{m.group(1)}_{m.group(2)}', snake)
    snake = re.sub(r'([0-9])([A-Z])',       lambda m: f'{m.group(1)}_{m.group(2)}', snake)
    snake = re.sub(r'([a-z])([0-9])',       lambda m: f'{m.group(1)}_{m.group(2)}', snake)
    snake = snake.replace('-', '_')
    return snake.lower()
```

And `to_camel` (the validation-side generator), verbatim from the same file:

```python
def to_camel(snake: str) -> str:
    """Convert a snake_case string to camelCase."""
    if re.match('^[a-z]+[A-Za-z0-9]*$', snake) and not re.search(r'\d[a-z]', snake):
        return snake
    camel = to_pascal(snake)
    return re.sub('(^_*[A-Z])', lambda m: m.group(1).lower(), camel)
```

**Worked predictions** (so you know when the generator suffices and when you need an explicit dict):

| Vendor wire key | `to_snake` output | Matches canonical? | Verdict |
|---|---|---|---|
| `reportedDate`     | `reported_date`     | yes | **auto — no dict needed** |
| `marketCap`        | `market_cap`        | yes | auto |
| `priceToBook`      | `price_to_book`     | yes | auto |
| `peRatioTTM`       | `pe_ratio_ttm`      | (`TTM`→`ttm` via the `[A-Z]+[A-Z][a-z]` rule + lower) | auto-ish — **verify**, acronyms are where it surprises |
| `fiscalDateEnding` | `fiscal_date_ending`| **no** — canonical is `date` | **explicit dict required** |
| `reportedEPS`      | `reported_eps`      | **no** — canonical is `eps_actual` | **explicit dict required** |
| `t` / `o` / `c`    | `t` / `o` / `c`     | **no** — canonical is `date`/`open`/`close` | **explicit dict required** |

**The decision rule:**

> Use the **auto generator** when the *only* difference between the vendor key and the canonical name is
> case style (camel↔snake). Use an **explicit `__alias_dict__` entry** the moment the vendor uses a
> *different word* (`t`≠`date`, `reportedEPS`≠`eps_actual`, `fiscalDateEnding`≠`date`). The generator
> renames *style*; the dict renames *vocabulary*. Acronym-heavy keys (`EPS`, `TTM`, `VWAP`, `EBITDA`)
> are the gray zone — run the regex in your head or a REPL and add an explicit entry if `to_snake`
> doesn't land exactly on your canonical name.

### 4.2 `populate_by_name=True` is what makes both names work

`populate_by_name=True` (set on the base) means the model accepts **either** the field's own name **or**
its alias as input. Without it, once a field has a `validation_alias`, Pydantic v2 rejects the plain
field name. With it, both `Data(date=...)` (canonical) and `Data(t=...)` (vendor) validate. That's why
your *own* internal code can construct a record with canonical names while the vendor transform feeds
vendor names into the *same* model — both paths are legal. (Pydantic v2.11+ also exposes this as
`validate_by_name` / `validate_by_alias`; `populate_by_name` remains the back-compatible spelling —
[pydantic alias-config docs](https://pydantic.dev/docs/validation/latest/concepts/alias/).)

---

## 5. `__json_schema_extra__` — per-parameter metadata that changes *behavior*, not just docs

Where `__alias_dict__` renames, `__json_schema_extra__` **annotates a parameter with platform-level
behavior**. It is a class-level dict keyed by *canonical param name*, whose value is a dict of metadata
flags. The two flags that matter for normalization:

```python
__json_schema_extra__ = {
    "symbol":   {"multiple_items_allowed": True, "choices": SOME_SYMBOL_LIST},
    "interval": {"multiple_items_allowed": False},
}
```

(Canonical form confirmed at
[architecture_overview](https://docs.openbb.co/odp/python/developer/architecture_overview) and the
"Add Provider To An Existing Command" how-to,
[docs.openbb.co/platform/user_guides/add_data_to_existing_endpoint](https://docs.openbb.co/platform/user_guides/add_data_to_existing_endpoint).)

This dict is read by the *command/provider-interface layer* (the layer that merges all providers'
params for one endpoint and builds the request), not by Pydantic field validation alone. It's how the
model **declaratively tells the platform** "this param is a list" and "these are the only legal values,"
so the platform can split, validate, and surface choices to the frontend — without you writing that
logic per endpoint.

---

## 6. `multiple_items_allowed` and `choices` in depth

### 6.1 `multiple_items_allowed: True` — one string → a real list → N upstream calls

This is the single most useful flag, and the one whose mechanism is most worth understanding.

**What the user / API sends:** a single comma-joined string — `symbol="AAPL,MSFT,GOOG"`.

**What the platform does**, because `__json_schema_extra__["symbol"]["multiple_items_allowed"] is True`:
the command layer reads that flag from the **merged JSON schema** for the endpoint, recognizes `symbol`
as multi-valued, and **splits the string on `,` into `["AAPL", "MSFT", "GOOG"]`**. The provider's
`Fetcher` then fans out — typically one upstream HTTP request per item (or one batched request if the
vendor supports it) — and concatenates the results into one flat `List[Data]`.

The flag also drives **OpenAPI generation**: a param marked `multiple_items_allowed` is advertised to the
frontend / SDK as accepting multiple values, so clients render a multi-select and encode the list
correctly ([add_data_to_existing_endpoint how-to](https://docs.openbb.co/platform/user_guides/add_data_to_existing_endpoint),
which states the dict is added "to allow multiple items in a query parameters field — i.e. a list of
tickers").

**Real usage — FMP marks `symbol` multi, nothing else:**

```python
class FMPEquityHistoricalQueryParams(EquityHistoricalQueryParams):
    __alias_dict__ = {"start_date": "from", "end_date": "to"}
    __json_schema_extra__ = {"symbol": {"multiple_items_allowed": True}}
```

So `obb.equity.price.historical("AAPL,MSFT", provider="fmp")` becomes two FMP calls, merged. The
*model* declares the capability; the *platform* implements the split + fan-out. You write one line.

**Where the split lives (be precise, don't claim a line you didn't read).** The `multiple_items_allowed`
flag is consumed in the **ProviderInterface / command-runner layer** that assembles endpoint params from
the merged provider JSON schemas — not inside the `QueryParams` model's own field validation. The model
is purely *declarative metadata*; the imperative "split this string and loop" lives in the command layer.
I confirmed the flag's *declaration* in the provider models and its *contract* in the OpenBB docs; I did
**not** read the exact splitting line in core, so treat "splits on `,` then fans out one call per item"
as the documented behavior, not a cited `file:line`. *(Verify against the command-runner source before
relying on edge behavior like whitespace trimming or dedup.)*

**The build recipe for our platform (greenfield):** since we're re-engineering this, *we* own the split
layer. Implement it once, generically:

```python
# command layer (pseudocode for our re-engineered platform)
def expand_multi_params(raw_params: dict, schema_extra: dict) -> list[dict]:
    """Fan a {param: 'a,b,c'} into N param-dicts when the schema marks the param multi."""
    multi = [p for p, meta in schema_extra.items()
             if meta.get("multiple_items_allowed") and isinstance(raw_params.get(p), str)]
    if not multi:
        return [raw_params]
    # split each multi param; cartesian only over the symbol-like axis in practice
    # (typically exactly ONE multi param — symbol — so this is a simple loop)
    base = dict(raw_params)
    p = multi[0]
    values = [v.strip() for v in raw_params[p].split(",") if v.strip()]
    return [{**base, p: v} for v in values]
```

> **Scale note (R-SCALE, fan-out is a contested surface).** `multiple_items_allowed` is a fan-out
> multiplier: one API call with `symbol="A,...,Z"` (500 tickers) becomes **500 upstream calls**. At Tier
> 1 (demo, 1–3 symbols) it's free. At Tier 2/3 you must (a) **cap** the list length per request, (b)
> **bound concurrency** with a semaphore so you don't hammer the vendor's rate limit, and (c) prefer the
> vendor's *native batch* endpoint when it exists (one call for N symbols) over N single calls. A naive
> `await asyncio.gather(*[fetch(s) for s in 500_symbols])` is a Tier-1 implementation that DOSes your own
> vendor key at Tier 2. State the cap and the concurrency bound where you implement the split.

### 6.2 `choices: [...]` — constrain a param to an enum (and surface it to the UI)

`choices` lists the legal values for a param. Two complementary ways to express an enum constraint, and
you'll often want **both**:

**(a) `Literal[...]` on the field** — enforces the constraint at *validation* time (Pydantic rejects a
bad value with a clear error). FMP's `interval` and `adjustment` do exactly this (verbatim, §3):

```python
interval: Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d"] = Field(default="1d", ...)
adjustment: Literal["splits_only", "splits_and_dividends", "unadjusted"] = Field(default="splits_only", ...)
```

**(b) `choices` in `__json_schema_extra__`** — surfaces the legal values to the **frontend / OpenAPI /
CLI autocomplete** so a UI can render a dropdown, *and* documents them in the merged schema. Use this
when the choice list is **dynamic or large** (a symbol universe, a list of exchange codes) and can't be a
static `Literal`:

```python
__json_schema_extra__ = {
    "symbol":   {"multiple_items_allowed": True, "choices": SOME_SYMBOL_LIST},
    "exchange": {"choices": ["NYSE", "NASDAQ", "LSE", "TSX"]},
}
```

| Mechanism | Enforces at validation? | Surfaces to UI/OpenAPI? | Use when |
|---|---|---|---|
| `Literal[...]` on the field | **yes** (Pydantic error on bad value) | yes (becomes a JSON-schema `enum`) | small, **static** value set known at code time |
| `choices` in `__json_schema_extra__` | no (advisory) — pair with a validator if you need rejection | **yes** | **dynamic / large** value sets (symbol universe) |

> **Pitfall:** `choices` in `__json_schema_extra__` alone is *advisory metadata* — it tells the UI what's
> valid, it does **not** itself reject an out-of-list value at validation. If a bad value must be
> rejected server-side, back it with a `Literal` (static) or a `field_validator` (dynamic). Shipping only
> the `choices` hint and assuming the platform rejects bad input is a Tier-1 trap.

---

## 7. When to prefer a `field_validator` over an alias — rename vs *compute*

The single sharpest line in this whole recipe:

> **An alias renames a value. A validator *changes* a value. If the bytes that come out differ from the
> bytes that went in — divided, parsed, coalesced, derived — it is a validator, not an alias. Never try
> to make `__alias_dict__` do arithmetic; it can't, and reaching for a "clever" alias to fake a
> computation is the scatter you're trying to avoid, relocated.**

### 7.1 Decision table

| The transform you need | Mechanism | Why |
|---|---|---|
| Vendor calls `close` → `c` | **`__alias_dict__`** | pure rename, value unchanged |
| Vendor calls `close` → `adjClose` | **`__alias_dict__`** | still a rename — you *pick* which field, value unchanged |
| camelCase → snake_case only | **auto `alias_generator`** (no dict) | §4 — style-only rename |
| Percent comes as `5.2`, you store `0.052` | **`field_validator(mode="before")`** | value is *divided by 100* |
| Date comes as epoch-ms `1701388800000` → `dateType` | **`field_validator`** (or the base date validator) | value is *parsed/transformed* |
| String `"None"` / `"0"` should become real `None` | **`field_validator(mode="before")`** | value is *coalesced* |
| `surprise = eps_actual - eps_estimated` (derived) | **`model_validator(mode="after")`** | value is *computed from siblings* |
| Symbol must be upper-cased | **`field_validator(mode="before")`** (the standard model's `to_upper`) | value is *transformed* |
| One param value must split to a list | **`__json_schema_extra__: multiple_items_allowed`** | structural, handled by the platform — not a per-model validator |

### 7.2 The canonical computed example — `/100` percent normalization

Alpha Vantage sends `surprisePercentage` as a whole-number percent (`5.2` meaning 5.2%); the canonical
contract stores it as a normalized fraction. That's a **division**, so it's a validator, even though the
*rename* (`surprise_percent` ← `surprisePercentage`) is already handled by `__alias_dict__`. Both
mechanisms coexist on the same field — the dict renames, the validator computes. Verbatim from FMP's
equivalent field (same file as §2.4):

```python
class FMPEquityHistoricalData(EquityHistoricalData):
    __alias_dict__ = {"open": "adjOpen", "high": "adjHigh", "low": "adjLow", "close": "adjClose"}

    change: Optional[float] = Field(default=None, description="Change in the price from the previous close.")
    change_percent: Optional[float] = Field(
        default=None,
        description="Change in the price from the previous close, as a normalized percent.",
        json_schema_extra={"x-unit_measurement": "percent", "x-frontend_multiply": 100},
    )

    @field_validator("change_percent", mode="before", check_fields=False)
    @classmethod
    def _normalize_percent(cls, v):
        """Normalize percent."""
        return v / 100 if v else None
```

And Alpha Vantage's EPS model uses two validators alongside its alias dict (behavior confirmed at
[`historical_eps.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/alpha_vantage/openbb_alpha_vantage/models/historical_eps.py)):

- a `validate_null`-style `field_validator(mode="before")` over `eps_estimated, eps_actual, surprise`
  that turns the vendor's string `"None"`/`"0"` sentinels into real `None`;
- a `normalize_percent`-style `field_validator(mode="before")` over `surprise_percent` that divides by
  100 (and also coalesces the `"None"`/`"0"` sentinel).

**The pattern: alias for the name, `mode="before"` validator for the value.** `mode="before"` runs on the
*raw* incoming value **before** Pydantic coerces it to the field's type — exactly the hook you want when
the vendor's wire form (`"5.2"`, `"None"`, epoch-ms) needs massaging into the typed canonical form.

### 7.3 `field_validator` vs `model_validator` — single field vs cross-field

| Use | Decorator | Sees |
|---|---|---|
| Transform one field's value | `@field_validator("x", mode="before")` | just `x`'s raw value |
| Coalesce / split several fields, or guard the whole dict | `@model_validator(mode="before")` | the **entire incoming dict** |
| Derive a field from siblings (`surprise = actual − est`) | `@model_validator(mode="after")` | the **fully-validated model** |

FMP's `_validate_params` (verbatim, §3) is a cross-field guard — *"adjustment can only apply to daily
interval"* — which inherently needs two fields, so it's a `model_validator(mode="before")`:

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

> **Why not just alias `surprise_percent` to a "pre-divided" key?** Because no such key exists on the
> wire — the vendor only sends the whole-number percent. The division is *information you add*, not a
> name you pick. The instant the recipe requires you to *invent* a value, you've left aliasing and
> entered validation. Conflating the two is the #1 mistake (§9).

---

## 8. Under the hood — which Pydantic primitive each convention compiles to

The OpenBB conventions are sugar over Pydantic v2. Knowing the desugaring lets you (a) debug when an
alias "doesn't fire," and (b) apply the recipe without OpenBB's base classes (which we may or may not
adopt wholesale in the re-engineered platform).

### 8.1 `Data.__alias_dict__` desugars to a *before* model-validator that reverses the map

Confirmed at [`data.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/data.py):
the `Data` base does **not** turn `__alias_dict__` into per-field `validation_alias`es. It installs a
`@model_validator(mode="before")` that **inverts** the dict and rewrites incoming keys:

```python
# inside Data, conceptually:
aliases = {orig: alias for alias, orig in cls.__alias_dict__.items()}  # invert {canonical: vendor} -> {vendor: canonical}
if aliases and isinstance(values, dict):
    return {aliases.get(k, k): v for k, v in values.items()}           # rename vendor keys -> canonical, before validation
```

So at validation time, `{"t": ..., "o": ...}` is rewritten to `{"date": ..., "open": ...}` *before* the
fields validate. Combined with the `AliasGenerator(to_camel/to_snake)` (§4) and `populate_by_name=True`,
both vendor and canonical inputs land on the canonical fields. **Direction: input/validation.**

### 8.2 `QueryParams.__alias_dict__` acts on `model_dump()` (output direction)

Confirmed at [`query_params.py`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/query_params.py):
the query model applies `__alias_dict__` when it's **dumped** to build the request — it renames canonical
param names to vendor query keys on the way *out*:

```python
# inside QueryParams.model_dump(), conceptually:
if self.__alias_dict__:
    return {self.__alias_dict__.get(key, key): value for key, value in original.items()}
```

`model_config = ConfigDict(extra="allow", populate_by_name=True)` lets it *accept* canonical names on
input and *emit* vendor names on output. **Direction: output/serialization.** This is the concrete reason
the *same* `{canonical: vendor}` dict means "rename on read" for `Data` and "rename on write" for
`QueryParams` — each base class wires the dict to the primitive matching its job.

### 8.3 The raw-Pydantic equivalent (no OpenBB base) — `alias` / `validation_alias` / `serialization_alias`

If you implement the recipe directly on `pydantic.BaseModel`, the three alias kinds map to the three
directions explicitly ([pydantic alias docs](https://pydantic.dev/docs/validation/latest/concepts/alias/)):

```python
from pydantic import BaseModel, Field, AliasChoices, ConfigDict

class PriceBar(BaseModel):
    model_config = ConfigDict(populate_by_name=True)  # accept BOTH canonical and alias on input

    # validation_alias: controls INPUT only — read the vendor key 'c', field stays 'close'
    close: float = Field(validation_alias="c")
    # general alias: input AND output — accept 'o' in, emit 'o' out when by_alias=True
    open:  float = Field(alias="o")
    # serialization_alias: controls OUTPUT only
    date:  str   = Field(serialization_alias="t")

bar = PriceBar.model_validate({"c": 192.32, "o": 191.41, "date": "2023-12-01"})
bar.model_dump()                 # {'close': 192.32, 'open': 191.41, 'date': '2023-12-01'}  (field names)
bar.model_dump(by_alias=True)    # uses aliases where defined
```

| Pydantic primitive | Direction it controls | Maps to OpenBB convention |
|---|---|---|
| `Field(validation_alias=...)` | **input** (deserialization) | `Data.__alias_dict__` (read vendor → canonical) |
| `Field(serialization_alias=...)` | **output** (serialization) | `QueryParams.__alias_dict__` (write canonical → vendor) |
| `Field(alias=...)` | **both** | the per-field `alias=` (§2.2, Polygon's `transactions`) |
| `AliasGenerator(validation_alias=to_camel, serialization_alias=to_snake)` | both, by convention | the base `Data` auto-case generator (§4) |

### 8.4 `AliasChoices` — one canonical field, *several* possible vendor keys

When a vendor (or worse, *one* endpoint across versions) sends the same concept under more than one key —
`fname` *or* `first_name`, `vol` *or* `volume` — `__alias_dict__`'s single-value map can't express it.
Drop to Pydantic's `AliasChoices` (verbatim from
[pydantic alias docs](https://pydantic.dev/docs/validation/latest/concepts/alias/)):

```python
from pydantic import BaseModel, Field, AliasChoices

class Bar(BaseModel):
    volume: int = Field(validation_alias=AliasChoices("v", "volume", "Volume"))

Bar.model_validate({"v": 100})       # works
Bar.model_validate({"Volume": 100})  # works — earlier choices win on conflict
```

Earlier entries win when several are present. Combine with `AliasPath` to reach into nested vendor JSON:

```python
from pydantic import AliasPath
# vendor nests the value at results[0].close
close: float = Field(validation_alias=AliasPath("results", 0, "close"))
# or fall back across a nested path AND a flat key:
close: float = Field(validation_alias=AliasChoices(AliasPath("results", 0, "c"), "close"))
```

> **Recipe:** if `__alias_dict__` (one canonical ↔ one vendor key) covers it, use the dict — it's the
> readable, scannable form. The instant a field has **two or more** legal vendor keys, or the value is
> **nested**, escalate to a per-field `AliasChoices` / `AliasPath` on that one field. Don't bend the dict.

---

## 9. The core anti-pattern this recipe exists to kill: scattered string literals

This is the failure the entire pattern prevents, stated as a before/after.

### 9.1 Before — the scatter (junior, unmaintainable)

```python
# DON'T: rename logic smeared across the transform function
def transform_polygon(raw_rows: list[dict]) -> list[dict]:
    out = []
    for r in raw_rows:
        out.append({
            "date":   r["t"],          # literal "t" here ...
            "open":   r["o"],
            "high":   r["h"],
            "low":    r["l"],
            "close":  r["c"],
            "volume": r["v"],
            "vwap":   r["vw"],
            "transactions": r.get("n"),
        })
    return out
```

Now multiply by 30 vendors × 40 endpoints. Symptoms, every one of which has bitten production systems:

- **No single source of truth.** "What does Polygon call close?" requires grepping transform bodies.
- **Silent `KeyError` / `None` drift.** A vendor renames `vw`→`vwap`; this line throws or silently nulls,
  and nothing flags it because the mapping isn't declared anywhere a schema check can see it.
- **Copy-paste rot.** Endpoint 41 copies endpoint 40's loop, inherits a stale `"adjClose"` literal.
- **Untestable in isolation.** You can't assert "Polygon's alias map is correct" — there's no *map*, only
  imperative code you'd have to execute to inspect.
- **Invisible to the UI/SDK.** The frontend can't learn that `symbol` is multi-valued or that `interval`
  has choices, because that knowledge is buried in `if`-statements, not declared metadata.

### 9.2 After — the declarative map (the recipe)

```python
class PolygonEquityHistoricalData(EquityHistoricalData):
    __alias_dict__ = {"date": "t", "open": "o", "high": "h", "low": "l", "close": "c", "volume": "v", "vwap": "vw"}
    transactions: Optional[PositiveInt] = Field(default=None, alias="n", description="Number of transactions.")

# transform is now trivial — no per-field renames:
def transform_polygon(query, raw, **_) -> list[PolygonEquityHistoricalData]:
    return [PolygonEquityHistoricalData.model_validate(r) for r in raw["results"]]
```

One dict, top of the model, declares the entire vendor↔canonical mapping. It is: greppable (one place),
testable (assert against the dict literal), schema-visible (the platform/SDK can read it), and
computation-free (renames only; the value massaging lives in clearly-separate validators). The transform
function shrinks to "validate each raw row into the model."

### 9.3 The anti-pattern checklist

| Smell | Why it's wrong | Fix |
|---|---|---|
| `row["open"] = raw["o"]` inside a transform | scattered literal, no single source of truth | `__alias_dict__ = {"open": "o"}` |
| `__alias_dict__ = {"close": "adjClose", "pct": "x"}` **and** `/100` done via a fake alias | aliases can't compute; you faked it | keep the alias for the rename, add a `field_validator(mode="before")` for `/100` |
| `__alias_dict__ = {"t": "date"}` (inverted) | wrong direction — `{canonical: vendor}`, not `{vendor: canonical}` | flip to `{"date": "t"}`; never invert the dict to "make it work" |
| `__alias_dict__ = {"reported_date": "reportedDate"}` (case-only) | redundant — the auto generator already does camel→snake | delete it; rely on `alias_generator=to_camel/to_snake` (§4) |
| `choices` set, but a bad value still accepted | `choices` is advisory metadata, not enforcement | back it with `Literal[...]` (static) or a `field_validator` (dynamic) (§6.2) |
| `multiple_items_allowed: True` with no concurrency cap | fan-out DOSes your own vendor key at scale | cap list length + bound concurrency at the split layer (§6.1) |
| Two vendor keys for one field, forced into the single-value dict | the dict can't express "either key" | use `AliasChoices` on that field (§8.4) |
| New canonical field name invented in a provider subclass | two consumers now disagree on the name | add the field to the **standard model** first, then alias to it (§1) |

---

## 10. Greenfield build checklist (apply when you author a provider model in our platform)

1. **Start from the standard model.** Inherit `XQueryParams` / `XData`. If your concept has no standard
   model, write that *first* (one place owns the canonical names). (§1)
2. **For each canonical field, ask: rename or compute?**
   - Style-only difference (camel↔snake) → **nothing** (auto generator). (§4)
   - Different vendor *word*, value unchanged → **`__alias_dict__` entry** `{canonical: vendor}`. (§2)
   - Value changes (÷100, parse, coalesce, derive) → **`field_validator`/`model_validator`**. (§7)
   - One concept, several possible vendor keys, or nested → **`AliasChoices`/`AliasPath`** on the field. (§8.4)
3. **On `QueryParams`, alias canonical params → vendor query keys** (`start_date→from`, `symbol→ticker`).
   Remember this dict fires on *output*. (§3)
4. **Mark multi-valued params** with `__json_schema_extra__["param"]["multiple_items_allowed"] = True`,
   and **cap + bound the fan-out** where the split happens. (§6.1)
5. **Constrain enums** with `Literal[...]` for static sets, `choices` for dynamic/large sets — and pair
   `choices` with enforcement if bad values must be rejected. (§6.2)
6. **Keep the transform function dumb:** `model_validate(raw_row)`. If it's doing renames, you skipped
   step 2 — move them into the dict. (§9)
7. **Test the map declaratively:** assert the `__alias_dict__` literal and round-trip one real vendor
   payload through the model. The map being data (not code) is what makes this cheap.

---

## Sources

- **OpenBB data-pipeline blog** — the Polygon OHLCV `__alias_dict__` example, `lower_snake_case`
  standardization guarantee:
  [openbb.co/blog/the-openbb-platform-data-pipeline](https://openbb.co/blog/the-openbb-platform-data-pipeline)
- **OpenBB Architecture Overview (Developer)** — TET `Fetcher`, the `QueryParams`/`Data` skeletons,
  `__alias_dict__` + `__json_schema_extra__` (`multiple_items_allowed`, `choices`):
  [docs.openbb.co/odp/python/developer/architecture_overview](https://docs.openbb.co/odp/python/developer/architecture_overview)
- **OpenBB "Add Provider To An Existing Command" how-to** — `multiple_items_allowed` for a list of
  tickers, the comma-split / multi-value behavior:
  [docs.openbb.co/platform/user_guides/add_data_to_existing_endpoint](https://docs.openbb.co/platform/user_guides/add_data_to_existing_endpoint)
- **OpenBB source — FMP equity historical** — real `__alias_dict__` (`start_date→from`, `close→adjClose`),
  `__json_schema_extra__`, `field_validator` `_normalize_percent`, `model_validator` `_validate_params`:
  [github.com/OpenBB-finance/OpenBB · fmp/.../models/equity_historical.py](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py)
- **OpenBB source — Alpha Vantage historical EPS** — `__alias_dict__` (`date→fiscalDateEnding`,
  `eps_actual→reportedEPS`, …), null-coalescing + `/100` validators:
  [github.com/OpenBB-finance/OpenBB · alpha_vantage/.../models/historical_eps.py](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/alpha_vantage/openbb_alpha_vantage/models/historical_eps.py)
- **OpenBB source — standard model** — `EquityHistoricalQueryParams`/`Data` canonical fields + `to_upper`:
  [github.com/OpenBB-finance/OpenBB · core/.../standard_models/equity_historical.py](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/standard_models/equity_historical.py)
- **OpenBB source — `Data` / `QueryParams` base classes** — the `__alias_dict__` desugaring
  (before-validator reversing the map; `model_dump` rename; `AliasGenerator(to_camel/to_snake)`;
  `populate_by_name`):
  [data.py](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/data.py)
  ·
  [query_params.py](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/query_params.py)
- **Pydantic v2 — Alias concepts** — `alias` vs `validation_alias` vs `serialization_alias` (direction),
  `AliasChoices`, `AliasPath`, `populate_by_name`/`validate_by_name`, `alias_generator`, `alias_priority`:
  [pydantic.dev/docs/validation/latest/concepts/alias](https://pydantic.dev/docs/validation/latest/concepts/alias/)
- **Pydantic v2 — `alias_generators` source** — exact `to_snake` / `to_camel` regex transformation rules:
  [github.com/pydantic/pydantic · pydantic/alias_generators.py](https://github.com/pydantic/pydantic/blob/main/pydantic/alias_generators.py)
