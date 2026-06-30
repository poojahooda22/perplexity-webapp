# Patterns — Pydantic v2 for the Transform stage (validation, coercion, aliasing, bulk caveat)

> **Skill:** `data-normalization-tet` · **Type:** `patterns-*` (concrete build recipe)
> **Product line:** JPM-Markets re-engineering **data-analytics** product line (NOT Lumina). NEW
> Python/FastAPI/data-engineering stack, separate from Lumina's Bun + Express + Prisma + Supabase + Upstash.
> **Standard:** [`../../../rules/cto-rules.md`](../../../rules/cto-rules.md) — verify-never-assert; every
> load-bearing claim is cited inline (primary docs / library behavior).
> **Pins (verified 2026-06-24):** Pydantic **2.13.4** (PyPI release 2026-05-06,
> [pypi.org/pypi/pydantic/json](https://pypi.org/pypi/pydantic/json)) · pydantic-core is the Rust engine
> ([pydantic.dev/articles/pydantic-v2](https://pydantic.dev/articles/pydantic-v2)) · docs now live under
> `pydantic.dev/docs/validation/latest/...` (the old `docs.pydantic.dev/latest` 301-redirects there).

---

## What this reference is

This is the **Pydantic v2 toolbox for the Transform stage** of the TET (Transform–Extract–Transform)
write path. In TET, the second **T** is where a provider's raw payload `Q` is coerced and validated into
our **standard model** `R` before the security master resolves it and the persistence step writes it to
TimescaleDB + a Parquet Distribution (see
[`../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md),
"openbb-tet-normalization" skill row). Pydantic v2 **is** that coerce-and-validate layer.

The job of this doc is to make every Pydantic decision a *named* one, not a default:

- **`field_validator(mode='before')`** sees the **raw** provider string — this is where `"2026-06-24"` →
  `datetime`, `"1,234.50"` → `Decimal`, and scale-factor application live.
- **`field_validator(mode='after')`** runs on the **already-parsed, type-safe** value — range checks,
  normalization of an already-typed field.
- **`model_validator`** does **cross-field** invariants (`high >= low >= 0`, `close ∈ [low, high]`).
- **Coercion is ON by default** (`"42"` → `42`); `strict=True` (model / field / call-time) turns it off.
  You must decide per field whether lax coercion is a feature or a silent-corruption risk.
- **`extra='allow'`** is the **standard for Data** — provider payloads carry fields we have no column for
  yet, and discarding them loses information we may need. They land in `model_extra`.
- **`alias_generator=to_snake`** does bulk `camelCase`/`PascalCase` → `snake_case` so a provider's
  `marketCap` populates our `market_cap` without one `Field(alias=...)` per column.
- **`TypeAdapter`** validates a `list[R]` (or any non-model type) **without** a wrapper model.
- **The bulk caveat:** Pydantic v2 is Rust-core and 5–50× faster than v1, **but it is still per-object**.
  At 100M rows that per-row tax is the `120ms→...` pathology the plan REJECTED. **Full per-row
  validation is for point / low-volume paths; bulk paths validate a SAMPLE and coerce columnar.**

> **The one rule that governs every choice below:** *who reads the validated value, and what breaks if it
> is wrong?* A point-read of one EOD bar can afford full validation; a 100M-row backfill cannot — and the
> contamination that a single un-grounded number causes (cto-rules / Lumina non-negotiable #1) is the same
> in both. Validate where it changes a decision; coerce-in-bulk where it does not.

---

## §0 — The 30-second decision table

| You need to… | Use | Mode / config | Section |
|---|---|---|---|
| Parse a raw provider `str` into `datetime`/`Decimal`/`int` | `@field_validator(mode='before')` | sees raw input | [§1](#1-field_validatormodebefore--the-raw-input-coercion-hook) |
| Apply a scale factor (units → actual, e.g. `value * 1000`) | `@field_validator(mode='before')` | sees raw input | [§1.3](#13-scale-factor-application--the-classic-before-validator-job) |
| Range / sanity check a value that is already the right type | `@field_validator(mode='after')` | type-safe | [§2](#2-field_validatormodeafter--the-type-safe-post-parse-hook) |
| Enforce a cross-field invariant (`high >= low`, `close ∈ [low,high]`) | `@model_validator(mode='after')` | whole model | [§3](#3-model_validator--cross-field-invariants) |
| Reshape a whole provider envelope before field parsing | `@model_validator(mode='before')` | raw dict | [§3.3](#33-model_validatormodebefore--reshape-the-envelope) |
| Turn OFF lax coercion for a field where a wrong type must error | `Field(strict=True)` / `Strict()` | per-field | [§4](#4-coercion-on-by-default-vs-strict) |
| Keep unknown provider fields instead of dropping them | `ConfigDict(extra='allow')` | model | [§5](#5-extraallow--the-standard-for-data) |
| Accept either our field name or the provider alias on input | `validate_by_name=True` (+ alias set) | model | [§6](#6-aliases-validate_by_name-validate_by_alias-and-the-populate_by_name-deprecation) |
| Bulk-rename `camelCase` → `snake_case` for a whole provider | `alias_generator=to_snake` | model | [§7](#7-alias_generatorto_snake--bulk-camelpascal--snake) |
| Validate a `list[R]` from a provider with no wrapper model | `TypeAdapter(list[R]).validate_python(...)` | constructed once | [§8](#8-typeadapter--validating-a-list-without-a-wrapper-model) |
| Validate 100M rows on a backfill without the per-row tax | sample-validate + columnar-coerce | NOT per-row | [§9](#9-the-bulk-path-caveat--why-per-row-pydantic-is-rejected-at-100m-rows) |

---

## §1 — `field_validator(mode='before')` — the raw-input coercion hook

### 1.1 What `mode='before'` actually sees

A **before** validator runs **before** Pydantic's internal parsing/coercion for that field. It receives
the **raw, unvalidated input** and "must handle any arbitrary object" — there is no guarantee the value is
even close to the declared type yet
([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/): *"Before
validators … receive raw, unvalidated input and must handle any arbitrary object"*). It returns a value
that Pydantic then validates against the field's type annotation.

This is the **only** place you can intercept a provider's string representation before Pydantic decides
what to do with it. It is the workhorse of the Transform stage.

```python
from datetime import datetime
from decimal import Decimal
from pydantic import BaseModel, field_validator

class EodBar(BaseModel):
    """Standard model R for one end-of-day bar."""
    as_of: datetime
    close: Decimal

    @field_validator("as_of", mode="before")
    @classmethod
    def parse_as_of(cls, v: object) -> object:
        # v is RAW — could be "2026-06-24", "20260624", an epoch int, or already a datetime.
        if isinstance(v, str) and v.isdigit() and len(v) == 8:
            # provider sends YYYYMMDD with no separators
            return f"{v[0:4]}-{v[4:6]}-{v[6:8]}"
        return v  # let Pydantic's own str->datetime / int->datetime handle the rest
```

**Decorator contract** (from the validators concept page):

- `@field_validator("field", mode="before")` **stacked above** `@classmethod` — the `@classmethod` is
  **mandatory**; the validator's first arg is `cls`, not `self`.
- It **must return the value** (Pydantic uses the return value as the field input). Returning `None`
  implicitly is a common bug — it silently nulls the field.
- Raise `ValueError`, `AssertionError`, or `PydanticCustomError` to fail validation; Pydantic wraps it into
  a `ValidationError` with the field location
  ([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/): *"raise
  ValueError(...) … AssertionError … PydanticCustomError"*).

### 1.2 Why you usually *don't* need a before-validator for plain coercion

Pydantic's **lax mode already coerces** the common provider-string cases. From the
[conversion table](https://pydantic.dev/docs/validation/latest/concepts/conversion_table/):

| Input → field type | Lax (default) | Strict | Note (verbatim from the table) |
|---|---|---|---|
| `str → int` | ✅ | ✅ | *"Must be numeric only, e.g. `[0-9]+`"* |
| `str → float` | ✅ | ❌ | *"Requires matching pattern `[0-9]+(\.[0-9]+)?`"* |
| `str → Decimal` | ✅ | ✅ | *"Must match `[0-9]+(\.[0-9]+)?`"* |
| `str → datetime` | ✅ | ✅ | *"Format `YYYY-MM-DDTHH:MM:SS.f` or `YYYY-MM-DD`"* |
| `str → date` | ✅ | ✅ | *"Format `YYYY-MM-DD`"* |
| `int → Decimal` | ✅ | ❌ | |
| `float → Decimal` | ✅ | ❌ | |
| `str → bool` | ✅ | ❌ | *accepts `'true'/'yes'/'false'/'no'` and variants* |

> **Read this carefully — `str → Decimal` and `str → datetime` are allowed in BOTH lax and strict mode**,
> but **only** for the canonical formats above. A before-validator is needed precisely when the provider's
> string is **not** canonical: `"1,234.50"` (thousands separators), `"$1234.50"` (currency symbol),
> `"20260624"` (no separators), `"24/06/2026"` (locale order), `"1.234,50"` (EU decimal comma), `"(123)"`
> (accounting negative), `"N/A"`/`"-"`/`""` (sentinels). Those all fail the canonical pattern and need
> cleaning **before** Pydantic sees them.

### 1.3 Scale-factor application — the classic before-validator job

Financial providers ship values in **units** with a separate **scale** field (BLS reports some series in
thousands; FRED carries a `units` note; XBRL facts carry a `decimals`/scale and a `unitRef`). The
standard model must store the **actual** number, so the scale is applied in the before-validator while the
raw inputs are still both available.

```python
from decimal import Decimal, InvalidOperation
from pydantic import BaseModel, field_validator, ValidationInfo

# Sentinels providers use for "no value" — must become None, never 0 or a fake number
# (cto-rules / Lumina non-negotiable #1: never invent a finance number).
_MISSING = {"", "-", "—", "N/A", "n/a", "NA", "null", "None", "."}

class ScaledObservation(BaseModel):
    raw_value: str            # provider's string, e.g. "1,234.5"
    scale_factor: int = 1     # provider's multiplier, e.g. 1000 for "thousands"
    value: Decimal | None = None   # the actual, scaled number we store

    @field_validator("value", mode="before")
    @classmethod
    def apply_scale(cls, v: object, info: ValidationInfo) -> object:
        # `value` is typically NOT in the payload; we derive it from raw_value * scale_factor.
        # info.data holds fields validated SO FAR (definition order) — see §1.4.
        raw = info.data.get("raw_value")
        if raw is None:
            return v
        cleaned = str(raw).strip().replace(",", "").replace("$", "")
        if cleaned in _MISSING:
            return None                      # typed unavailable, NOT 0.0
        try:
            base = Decimal(cleaned)
        except InvalidOperation:
            raise ValueError(f"unparseable numeric: {raw!r}")
        scale = info.data.get("scale_factor", 1)
        return base * Decimal(scale)
```

Two non-obvious points, both load-bearing:

1. **`ValidationInfo.data` only contains fields validated *before* this one** — *"Fields validate in
   definition order; access only previously-defined fields"*
   ([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/)). So
   `raw_value` and `scale_factor` must be **declared above** `value` in the class body, or `info.data`
   won't have them yet. Field order is a real dependency here.
2. **Missing → `None`, never `0` or a fabricated value.** The sentinel set converts provider "no data"
   markers into a typed `None`. This is the Pydantic-level enforcement of the project's #1 rule (*"never
   invent a finance number … failed tools return typed unavailable/needsKey, never fabricated data"*,
   [02-skills-and-pipeline.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)).
   The partial-failure recipe (throw → cache serves stale) lives in the `data-pipeline-worker-cron` skill;
   the Transform stage's contribution is *never coerce a sentinel into a number*.

### 1.4 `ValidationInfo` — the second argument

Both field and model validators may take an optional `ValidationInfo` (or `FieldValidationInfo`) second
argument exposing
([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/)):

| Attribute | Meaning | Available in |
|---|---|---|
| `info.data` | dict of already-validated field values (definition order) | field validators |
| `info.field_name` | the current field's name (useful for shared validators) | field validators |
| `info.context` | the dict you passed to `model_validate(data, context=...)` | field + model |
| `info.mode` | `'python'` \| `'json'` \| `'strings'` — the input source | field + model |

`info.context` is how you thread per-fetch metadata (e.g. the provider id, an as-of override, a
`scale_factor` table) into validation **without** putting it on the model:

```python
EodBar.model_validate(raw_row, context={"provider": "edgar", "decimals": -3})
# inside a before-validator: prov = info.context.get("provider")
```

### 1.5 Multiple fields, wildcards, and `check_fields`

```python
@field_validator("open", "high", "low", "close", mode="before")
@classmethod
def clean_price(cls, v: object) -> object:
    if isinstance(v, str):
        v = v.strip().replace(",", "")
        if v in _MISSING:
            return None
    return v
```

- One validator can cover **many fields**: `@field_validator("open", "high", "low", "close", ...)`.
- `@field_validator("*")` applies to **all** fields
  ([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/): *"Apply to all
  fields: `@field_validator('*')`"*).
- `check_fields=False` disables the "this field exists" check — needed when the validator lives on a
  **base class** whose subclasses define the field (*"Disable field existence check: `check_fields=False`
  (useful in base classes)"*). For a shared `StandardModel` base across providers, set this.

> **Order within before-validators:** when you stack multiple before/wrap validators, they run
> **right-to-left** (bottom-up); after-validators run **left-to-right**
> ([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/): *"before/wrap
> validators right-to-left, then after validators left-to-right"*). Don't rely on a fragile stack order;
> prefer one before-validator that does the whole clean.

---

## §2 — `field_validator(mode='after')` — the type-safe post-parse hook

### 2.1 What `mode='after'` sees

`mode='after'` is the **default**. It runs **after** Pydantic has parsed and coerced the value to the
field's declared type, so the value is **already type-safe** — *"run after Pydantic's internal validation
… generally more type safe"*
([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/)). The argument is
a real `Decimal`/`datetime`/`int`, not a raw string.

Use after-validators for **range and sanity checks** and for **normalizing an already-typed value** — not
for parsing.

```python
from datetime import datetime, timezone, date
from decimal import Decimal
from pydantic import BaseModel, field_validator

class EodBar(BaseModel):
    as_of: datetime
    close: Decimal
    volume: int

    @field_validator("close", mode="after")
    @classmethod
    def non_negative_price(cls, v: Decimal) -> Decimal:
        # v is already a Decimal here — pure business rule, no parsing.
        if v < 0:
            raise ValueError("price cannot be negative")
        return v

    @field_validator("as_of", mode="after")
    @classmethod
    def normalize_tz(cls, v: datetime) -> datetime:
        # Normalize naive timestamps to UTC for a consistent store key.
        if v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc)

    @field_validator("volume", mode="after")
    @classmethod
    def non_negative_volume(cls, v: int) -> int:
        if v < 0:
            raise ValueError("volume cannot be negative")
        return v
```

### 2.2 Prefer `Annotated` constraints over after-validators where you can

For pure **declarative** constraints (`>= 0`, `> 0`, string length, regex), use `Annotated[..., Field(...)]`
rather than an after-validator. pydantic-core enforces those **in Rust**, with no Python call per row, and
the measured gap is large — a benchmark of 50k records found **field validators 0.971s vs Annotated
constraints 0.036s ≈ 30× faster**
([Towards Data Science, "Pydantic Performance: 4 Tips"](https://towardsdatascience.com/pydantic-performance-4-tips-on-how-to-validate-large-amounts-of-data-efficiently/)).

```python
from typing import Annotated
from decimal import Decimal
from pydantic import BaseModel, Field

NonNegPrice = Annotated[Decimal, Field(ge=0)]
NonNegInt   = Annotated[int, Field(ge=0)]

class EodBar(BaseModel):
    close: NonNegPrice     # enforced in Rust, no per-row Python callback
    volume: NonNegInt
```

> **Rule of thumb:** if the check is `ge/gt/le/lt/multiple_of/min_length/max_length/pattern`, write it as a
> `Field(...)` constraint, **not** an after-validator. Reserve after-validators for logic the declarative
> constraints can't express (e.g. tz normalization, cross-referencing `info.data`). This matters most on
> bulk paths (§9) — but apply it everywhere; it's free.

---

## §3 — `model_validator` — cross-field invariants

### 3.1 `mode='after'` — the whole model is built and type-safe

A `@model_validator(mode='after')` receives the **fully-validated model instance** (`self`) and returns it
(or raises). This is where **relationships between fields** are enforced — the single most important
Transform-stage invariant for OHLC bars:

```python
from decimal import Decimal
from typing import Self
from pydantic import BaseModel, model_validator

class OhlcBar(BaseModel):
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int

    @model_validator(mode="after")
    def ohlc_consistency(self) -> Self:
        # Enforce high >= low >= 0 and that open/close sit inside [low, high].
        if self.low < 0:
            raise ValueError("low cannot be negative")
        if self.high < self.low:
            raise ValueError(f"high ({self.high}) < low ({self.low})")
        if not (self.low <= self.open <= self.high):
            raise ValueError(f"open ({self.open}) outside [low, high]")
        if not (self.low <= self.close <= self.high):
            raise ValueError(f"close ({self.close}) outside [low, high]")
        return self
```

Contract (from the validators concept page):

- `mode='after'` model validators are **instance methods** (`def f(self) -> Self`), take **no** `cls`, and
  **must return the instance** — *"`@model_validator(mode='after') def check(self) -> Self: ... return
  self`"* ([validators concept](https://pydantic.dev/docs/validation/latest/concepts/validators/)).
- Return type `Self` (from `typing`) keeps the type checker happy.
- They run **after** every field is parsed/validated — so `self.high` etc. are real `Decimal`s.

> **Why this is a Transform-stage non-negotiable, not a nicety.** A provider feed with `high < low`, or a
> `close` outside `[low, high]`, is a corrupt bar — storing it lets a downstream chart or aggregate emit a
> number nobody can trust. This is exactly the "metric in a costume" failure the negation loop (F4) hunts:
> an OHLC bar that *looks* fine but encodes an impossible price. The model_validator is where we refuse it
> at the door instead of persisting it.

### 3.2 `mode='wrap'` — pre/post around the build

`mode='wrap'` is the most flexible: a **classmethod** that receives the raw input **and** a handler; you
can do work before calling `handler(data)` (which runs the normal validation) and after it returns the
built model. Use it sparingly — **wrap validators are slower** because they force a Python materialization
during validation (*"Wrap validators are generally slower than other validators … requiring Python
materialization"*,
[performance concept](https://pydantic.dev/docs/validation/latest/concepts/performance/)). Reach for it
only when you genuinely need to observe *both* sides of the build (e.g. catch a specific error and re-raise
as a typed one).

### 3.3 `model_validator(mode='before')` — reshape the envelope

A `@model_validator(mode='before')` is a **classmethod** that receives the **raw input dict/object** before
any field is parsed. This is where you **reshape a provider's envelope** into the flat shape the standard
model expects — flatten a nested `{"data": {"attributes": {...}}}`, lift a value out of an array, or merge
two provider shapes into one.

```python
from typing import Any
from pydantic import BaseModel, model_validator

class EodBar(BaseModel):
    symbol: str
    close: float

    @model_validator(mode="before")
    @classmethod
    def lift_envelope(cls, data: Any) -> Any:
        # Provider returns {"meta": {"sym": "AAPL"}, "bar": {"c": 191.2}}
        if isinstance(data, dict) and "bar" in data:
            return {
                "symbol": data.get("meta", {}).get("sym"),
                "close": data["bar"].get("c"),
            }
        return data
```

> **Before-model vs before-field:** reshape the **envelope** in a model-before validator; clean an
> **individual value** in a field-before validator. Don't do field cleaning in the model-before — you lose
> the per-field error location that makes `ValidationError` debuggable.

---

## §4 — Coercion ON by default vs strict

### 4.1 The default is lax coercion

By default Pydantic **coerces**: `Model(x="123")` with `x: int` yields `x == 123`
([strict-mode concept](https://pydantic.dev/docs/validation/latest/concepts/strict_mode/): *"By default,
Pydantic coerces values (e.g. `'123'` → `123`)"*). For a financial Transform stage this is **mostly a
feature** — providers send everything as JSON strings, and lax `str→Decimal` / `str→datetime` saves you a
before-validator for the canonical cases (§1.2).

### 4.2 When lax coercion is a *risk* — and how to forbid it

Lax coercion is dangerous exactly where a wrong type should be a **loud error**, not a silent best-effort:

- A **ticker / FIGI / identifier** field that is `str` but the provider sometimes sends a number — lax
  `int→str` (with `coerce_numbers_to_str=True`) or the reverse can quietly corrupt the security-master key.
- A **boolean flag** (`is_delisted`, `commercial_ok`) where `"no"`/`0`/`""` must not silently become a
  bool — lax `str→bool` accepts `'true'/'yes'/'no'/...`
  ([conversion table](https://pydantic.dev/docs/validation/latest/concepts/conversion_table/)), which is a
  footgun for provider sentinels.
- A **count / volume** that must be a true integer, where `"12.0"`/`12.7` floating in via lax paths would
  truncate or mislead.

Three ways to turn coercion **off**, narrowest scope first
([strict-mode concept](https://pydantic.dev/docs/validation/latest/concepts/strict_mode/)):

```python
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field, Strict, StrictBool, StrictStr

# (1) Per-field — preferred: surgical, only the fields that must be exact.
class SecurityKey(BaseModel):
    figi: str = Field(strict=True)              # provider int will now ERROR, not coerce
    is_delisted: StrictBool                     # == Annotated[bool, Strict()]
    ticker: Annotated[str, Strict()]            # equivalent long form

# (2) Model-wide, with per-field opt-OUT where lax IS wanted.
class StrictBar(BaseModel):
    model_config = ConfigDict(strict=True)
    as_of: "datetime"                            # strict
    close: float = Field(strict=False)           # allow lax str->float here only

# (3) Call-time, for one validation only (e.g. a trusted-vs-untrusted boundary).
SecurityKey.model_validate(raw, strict=True)
```

Available strict aliases: `StrictInt`, `StrictStr`, `StrictBool`, `StrictFloat`, `StrictBytes` (each
`≡ Annotated[T, Strict()]`)
([strict-mode concept](https://pydantic.dev/docs/validation/latest/concepts/strict_mode/)).

> **The JSON exception that bites:** *"strict mode is looser when validating from JSON … date/time strings
> remain acceptable in strict mode when parsing JSON"*
> ([strict-mode concept](https://pydantic.dev/docs/validation/latest/concepts/strict_mode/)). So a
> `datetime` field under `strict=True` **still accepts** a `"2026-06-24"` string when the input came in via
> `model_validate_json` — by design. Don't be surprised that strict-from-JSON ≠ strict-from-Python for
> dates.

### 4.3 The Transform-stage policy (committed)

| Field class | Coercion | Why |
|---|---|---|
| Identifiers (figi, ticker, isin, lei, provider_symbol) | **strict** (`Field(strict=True)`) | a coerced id silently corrupts the security-master crosswalk |
| Booleans / enums (is_delisted, commercial_ok, status) | **strict** | lax `str→bool` accepts sentinels as `True/False` |
| Counts (volume, share_count) | **strict int** or explicit before-validator | avoid float→int truncation surprises |
| Numeric series values (price, yield, level) | **lax** (default) **but** cleaned in a before-validator for non-canonical strings | providers ship JSON-string numbers; lax `str→Decimal` is the feature |
| Timestamps (as_of) | **lax** | lax `str→datetime` handles the canonical ISO case; before-validator only for weird formats |

> **Never `coerce_numbers_to_str=True` on an id field.** It exists (lax `int/float/Decimal → str`,
> [config api](https://pydantic.dev/docs/validation/latest/api/pydantic/config/)) and is occasionally
> handy, but on a `figi`/`ticker` it would mask a provider returning a number where a string was promised —
> the exact silent corruption strict mode is for.

---

## §5 — `extra='allow'` — the standard for Data

### 5.1 The three `extra` modes

`ConfigDict(extra=...)` controls unrecognized input keys
([config api](https://pydantic.dev/docs/validation/latest/api/pydantic/config/)):

| `extra` | Behavior | Default? |
|---|---|---|
| `'ignore'` | extra keys **silently discarded** | **yes (default)** |
| `'forbid'` | extra keys → `ValidationError` | — |
| `'allow'` | extra keys **stored in `__pydantic_extra__`** and included in `model_dump()` | — |

### 5.2 Why Data uses `extra='allow'`

The plan makes this an explicit standard: the OpenBB-pattern standard models are **field-intersection +
`extra='allow'`** so a provider's surplus fields are **preserved, not dropped**
([01-plan.md, Normalization row](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md):
*"standard models = field-intersection + `__alias_dict__` + `extra='allow'`"*;
[02-skills-and-pipeline.md, openbb-tet row](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)).

The reasoning, from first principles: our standard model `R` is the **intersection** of fields every
provider supplies (so it is stable across providers). But each provider also ships **extra** fields we
haven't promoted to a column. The default `'ignore'` would **throw that information away** — and in a
data-as-a-service product, a field one provider gives today is a Distribution column we may want tomorrow.
`'allow'` captures it losslessly into `model_extra`, where the persistence step can stash it (e.g. a JSONB
`extra` column or a Parquet `extra` struct) without a schema migration.

```python
from pydantic import BaseModel, ConfigDict

class StandardEodBar(BaseModel):
    model_config = ConfigDict(extra="allow")   # the Data standard
    symbol: str
    close: float

m = StandardEodBar.model_validate(
    {"symbol": "AAPL", "close": 191.2, "vwap": 190.8, "provider_id": "twelvedata"}
)
assert m.__pydantic_extra__ == {"vwap": 190.8, "provider_id": "twelvedata"}
assert m.model_extra == {"vwap": 190.8, "provider_id": "twelvedata"}   # public accessor
assert m.model_dump() == {                                             # extras round-trip
    "symbol": "AAPL", "close": 191.2, "vwap": 190.8, "provider_id": "twelvedata",
}
```

Verified behavior
([models concept](https://pydantic.dev/docs/validation/latest/concepts/models/)): *"`m.__pydantic_extra__
== {'y': 'a'}` … Extra fields are accessible via the `__pydantic_extra__` dictionary attribute and
included in serialization output."* `model_extra` is the public property over the same dict.

### 5.3 When NOT to use `extra='allow'`

- **The gateway's outbound API response models** → `extra='forbid'`. The public OpenAPI contract should be
  exact; an accidental extra key in a response is a contract leak. `'allow'` is for **ingest** (capture
  provider surplus), `'forbid'` is for **egress** (lock the published shape).
- **Anything you persist as typed columns** → promote the field to a real field; don't let load-bearing
  data live forever in `model_extra` (it's untyped, unvalidated, and easy to forget).

> **`model_extra` is untyped.** Values in `__pydantic_extra__` are **not** validated or coerced (they're
> whatever the provider sent). Treat them as raw — if you later promote one to a column, give it a real
> typed field + validator. Don't read a number out of `model_extra` and trust it.

---

## §6 — Aliases, `validate_by_name`, `validate_by_alias`, and the `populate_by_name` deprecation

### 6.1 The deprecation you must get right (2.11+)

`populate_by_name` is **deprecated in 2.11+** in favor of two granular flags
([config api](https://pydantic.dev/docs/validation/latest/api/pydantic/config/)):

| Setting | Default | Meaning | Since |
|---|---|---|---|
| `validate_by_alias` | **`True`** | an aliased field **may** be populated by its alias | (always) |
| `validate_by_name` | **`False`** | an aliased field **may** be populated by its attribute name | **new in 2.11** |
| `populate_by_name` | `False` | **DEPRECATED in 2.11+, removed in v3** | legacy |

Verbatim deprecation note ([config api](https://pydantic.dev/docs/validation/latest/api/pydantic/config/)):
*"Deprecated in v2.11+ and will be deprecated in v3. Instead, you should use the `validate_by_name`
configuration setting."* The old `populate_by_name=True` behavior is now `validate_by_name=True` **and**
`validate_by_alias=True` together.

```python
from pydantic import BaseModel, ConfigDict, Field

# OLD (deprecated) — do NOT write new code this way:
# model_config = ConfigDict(populate_by_name=True)

# NEW (2.11+) — accept EITHER the snake_case attribute name OR the provider alias:
class Bar(BaseModel):
    model_config = ConfigDict(validate_by_name=True, validate_by_alias=True)
    market_cap: int = Field(alias="marketCap")

Bar.model_validate({"marketCap": 100})   # OK — by alias
Bar.model_validate({"market_cap": 100})  # OK — by name (needs validate_by_name=True)
```

> **The footgun:** *"You cannot set both `validate_by_alias` and `validate_by_name` to `False`"*
> ([config api](https://pydantic.dev/docs/validation/latest/api/pydantic/config/)) — that would make the
> field unpopulatable. And if you set `validate_by_name=True` but leave `validate_by_alias` at its `True`
> default, both names work (the desired ingest behavior). For the Transform stage we want **both `True`**:
> a provider sends `marketCap`, but our own re-feeds and tests use `market_cap`.

### 6.2 alias vs validation_alias vs serialization_alias

Three field-level alias hooks
([alias concept](https://pydantic.dev/docs/validation/latest/concepts/alias/)):

| Hook | Used for | Accepts |
|---|---|---|
| `alias=` | **both** input and output by default | `str` |
| `validation_alias=` | **input only** | `str`, `AliasPath`, `AliasChoices` |
| `serialization_alias=` | **output only** | `str` |

`AliasChoices` gives **fallback aliases** (first = highest priority) — invaluable when several providers
name the same concept differently:

```python
from pydantic import BaseModel, Field, AliasChoices, AliasPath

class Quote(BaseModel):
    # accept any of these inbound keys for the same standard field
    last_price: float = Field(
        validation_alias=AliasChoices("last", "lastPrice", "price", "regularMarketPrice")
    )
    # pull a nested value out of an array/object without reshaping the envelope
    first_name: str = Field(validation_alias=AliasPath("names", 0))
```

`AliasPath("names", 0)` reaches `data["names"][0]`; `AliasChoices(...)` tries each in order — *"Choices
that appear first in the list will have higher priority during validation"*
([alias concept](https://pydantic.dev/docs/validation/latest/concepts/alias/)). `AliasChoices` can mix in
`AliasPath`: `AliasChoices("first_name", AliasPath("names", 0))`.

> This is the standard-model `__alias_dict__` mechanism the plan names — except expressed natively with
> `AliasChoices`, which is cleaner than an external dict because the choices live on the field.

---

## §7 — `alias_generator=to_snake` — bulk camel/Pascal → snake

### 7.1 The bulk rename

When a whole provider speaks `camelCase` (`marketCap`, `lastPrice`, `fiscalYearEnd`) or `PascalCase`
(`LanguageCode`), you do **not** write one `Field(alias=...)` per field. Set an `alias_generator`
([config api](https://pydantic.dev/docs/validation/latest/api/pydantic/config/): *"A callable that takes a
field name and returns an alias for it or an instance of AliasGenerator"*). Pydantic ships
`to_snake`, `to_camel`, `to_pascal` in `pydantic.alias_generators`
([alias concept](https://pydantic.dev/docs/validation/latest/concepts/alias/)).

Our standard models are `snake_case` and providers are `camelCase`, so the generator must produce the
**provider's** camel name **as the alias** of our snake field — i.e. our field `market_cap` needs alias
`marketCap`. That is `to_camel` applied as the generator:

```python
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

class ProviderBar(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,        # market_cap -> alias "marketCap"
        validate_by_name=True,           # also accept our own snake names (2.11+)
        validate_by_alias=True,          # accept the provider's camel aliases (default)
        extra="allow",                   # the Data standard (§5)
    )
    market_cap: int
    last_price: float
    fiscal_year_end: str

ProviderBar.model_validate({"marketCap": 100, "lastPrice": 1.2, "fiscalYearEnd": "09-30"})
```

> **Which generator?** The scope text says *"`alias_generator=to_snake` for bulk camel→snake"*. Read that
> as the **intent** (normalize a camel provider into our snake model), and pick the generator by **which
> direction the alias must point**:
>
> - Our fields are **snake**, provider keys are **camel** → use **`to_camel`** as the generator so each
>   snake field gets the matching camel **alias** that pydantic matches the inbound key against (the recipe
>   above — this is the common case).
> - Your model fields are **camel** and you want to *emit*/match **snake** → use **`to_snake`**.
>
> `to_snake` is the right tool when the transformation you want **is** "produce a snake_case alias" — e.g.
> a model whose fields are camel but whose serialization/validation alias should be snake. Both are
> one-liners; name the direction explicitly so a reviewer can verify it.

### 7.2 Explicit `Field(alias=...)` overrides the generator

A field-level alias beats the generator unless you reset `alias_priority`
([alias concept](https://pydantic.dev/docs/validation/latest/concepts/alias/): *"When an explicit field
`alias` is set alongside `alias_generator`, the explicit alias takes precedence unless you set
`alias_priority=1`"*). Use this for the one-off field whose provider name doesn't fit the camel rule:

```python
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

class Bar(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)
    market_cap: int                                  # -> "marketCap" (generator)
    pe_ratio: float = Field(alias="PERatio")         # explicit wins over "peRatio"
```

### 7.3 `AliasGenerator` for split validation/serialization

If you need **different** aliases for input vs output (validate against provider camel, serialize to your
public snake), use the `AliasGenerator` object
([alias concept](https://pydantic.dev/docs/validation/latest/concepts/alias/)):

```python
from pydantic import BaseModel, ConfigDict, AliasGenerator
from pydantic.alias_generators import to_camel, to_snake

class Bar(BaseModel):
    model_config = ConfigDict(
        alias_generator=AliasGenerator(
            validation_alias=to_camel,      # accept provider camelCase on input
            serialization_alias=to_snake,   # emit snake_case on output
        ),
        validate_by_name=True,
    )
    market_cap: int
```

> **Tradeoff vs `AliasChoices`:** the generator is **uniform** (one rule, all fields) and great for a
> provider that is consistently camel. When providers **disagree** field-by-field (`last` vs `lastPrice`
> vs `price`), per-field `AliasChoices` (§6.2) is the better tool. Real adapters use **both**: a generator
> for the bulk, `AliasChoices` for the messy fields.

---

## §8 — `TypeAdapter` — validating a list without a wrapper model

### 8.1 The pattern

A provider page is usually a **JSON array** of bars. You do **not** need a `class BarList(BaseModel): items:
list[Bar]` wrapper — `TypeAdapter` validates any type, including `list[Bar]`
([type_adapter concept](https://pydantic.dev/docs/validation/latest/concepts/type_adapter/)):

```python
from pydantic import TypeAdapter

# Construct ONCE at module scope — see §8.2.
_BAR_LIST = TypeAdapter(list[EodBar])

def parse_page(rows: list[dict]) -> list[EodBar]:
    return _BAR_LIST.validate_python(rows)

# Straight from provider bytes (no json.loads — see §9.2):
def parse_page_json(raw: bytes) -> list[EodBar]:
    return _BAR_LIST.validate_json(raw)
```

Key methods ([type_adapter concept](https://pydantic.dev/docs/validation/latest/concepts/type_adapter/)):

| Method | Input | Output | Note |
|---|---|---|---|
| `.validate_python(obj)` | Python objects (dicts/lists) | typed value | the Python path |
| `.validate_json(data)` | `str`/`bytes` JSON | typed value | parse + validate in one Rust pass (§9.2) |
| `.dump_python(value)` | typed value | Python objects | |
| `.dump_json(value)` | typed value | **`bytes`** | *returns `bytes`, unlike `BaseModel.model_dump_json` which returns `str`* |
| `.json_schema()` | — | JSON Schema dict | for the catalog / OpenAPI |

```python
adapter = TypeAdapter(list[User])
adapter.validate_python([{"name": "Fred", "id": "3"}])   # id "3" -> 3 (lax)
adapter.dump_json([...])   # b'[{"name":"Fred","id":3}]'  -- bytes
```

### 8.2 Construct the TypeAdapter ONCE — the non-negotiable

Constructing a `TypeAdapter` builds a **new validator + serializer** every time, which carries
**non-trivial overhead** — *"it is recommended to create a `TypeAdapter` for a given type just once and
reuse it in loops or other performance-critical code"*
([type_adapter concept](https://pydantic.dev/docs/validation/latest/concepts/type_adapter/)); the
[performance concept](https://pydantic.dev/docs/validation/latest/concepts/performance/) repeats it:
*"Each time a `TypeAdapter` is instantiated, it will construct a new validator and serializer. If you're
using a `TypeAdapter` in a function, it will be instantiated each time the function is called. Instead,
instantiate it once, and reuse it."*

```python
# WRONG — rebuilds the validator on every call (silent throughput killer)
def parse_page(rows):
    return TypeAdapter(list[EodBar]).validate_python(rows)   # ❌ per-call construction

# RIGHT — module-level singleton, reused across every page/provider call
_BAR_LIST = TypeAdapter(list[EodBar])                         # ✅ built once
def parse_page(rows):
    return _BAR_LIST.validate_python(rows)
```

Measured payoff for batch validation: reusing a `TypeAdapter(list[Model])` beats per-item validation and a
wrapper model — for n=250k, **TypeAdapter 0.381s vs per-item 0.502s vs wrapper-model 0.602s**, an absolute
saving of **120–220 ms** per batch
([Towards Data Science, "Pydantic Performance: 4 Tips"](https://towardsdatascience.com/pydantic-performance-4-tips-on-how-to-validate-large-amounts-of-data-efficiently/)).

> Put every standard-model list adapter in a small `adapters.py` module constructed at import time, keyed
> by standard-model type. That is the single biggest cheap win on the validation hot path — and it is the
> direct mitigation for the per-call-construction footgun.

---

## §9 — The bulk-path caveat — why per-row Pydantic is REJECTED at 100M rows

### 9.1 The pathology

Pydantic v2's core is **Rust** (`pydantic-core`, via pyo3), and it is broadly **5–50× faster than v1** —
about **17×** on a model of common fields
([pydantic.dev/articles/pydantic-v2](https://pydantic.dev/articles/pydantic-v2);
[HN: "Pydantic V2 rewritten in Rust is 5–50x faster than V1"](https://news.ycombinator.com/item?id=35490449)).
**But Rust-fast-per-object is still per-object.** Validation cost scales **linearly with row count**, and
the constant — though small — is paid once per row.

The plan states the rejection explicitly. From
[02-skills-and-pipeline.md, "Dead ends / rejected"](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md):

> **"Per-row Pydantic on bulk paths — REJECTED: use Arrow/columnar batch transport (the 120ms→840ms
> pathology)."**

And from [01-plan.md, Phase 5](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md):

> **"bulk-path rebuilt on Arrow batch transport (avoid per-row Pydantic at 100M rows)."**

The arithmetic that makes it a pathology: the per-row saving of switching to a reused `TypeAdapter` is
**~120 ms on 250k rows** ([TDS, above]) — i.e. the *Pydantic tax itself* is on the order of hundreds of
milliseconds per quarter-million rows. Scale that to a **100M-row** EOD backfill and the per-row tax is
**~400× larger** — minutes of pure CPU spent re-validating data that arrives already-uniform (a Parquet
column is, by construction, all the same type). The "120ms→840ms" shorthand names the regime where the
validation overhead has grown from "noise" into "the dominant cost of the ingest" — work spent proving a
columnar block is the type the column header already guarantees.

### 9.2 Even on the validate path, parse JSON in ONE pass

Before any bulk discussion: on the *point/low-volume* paths, never `json.loads` then `model_validate`.
Use `model_validate_json` / `TypeAdapter.validate_json` so pydantic-core does parse **and** validate in a
single Rust pass — *"On `model_validate(json.loads(...))`, the JSON is parsed in Python, then converted to
a dict, then validated internally … `model_validate_json()` already performs the validation internally"*
([performance concept](https://pydantic.dev/docs/validation/latest/concepts/performance/)). Measured:
n=250k, `model_validate_json` **0.209s** vs `json.loads` + validate **0.368s**
([TDS, above]). This is necessary but **not sufficient** for 100M rows — it removes the double-parse, not
the per-row tax.

### 9.3 The committed bulk strategy: validate a SAMPLE + coerce columnar

The Transform stage runs **two modes**, chosen by path volume:

| Path | Volume | Strategy |
|---|---|---|
| **Point / low-volume** (one quote, one bar, a single point-read, a small page) | 1 – ~10k rows | **Full per-row Pydantic** via a reused `TypeAdapter(list[R])`. Cheap, maximally safe, gives the full cross-field `model_validator` guarantees. |
| **Bulk** (an EOD backfill, a multi-year series, a 100M-row reload) | 100k – 100M+ rows | **Validate a SAMPLE** with Pydantic (schema + a representative slice), then **coerce the rest columnar** with PyArrow — never per-row. |

The bulk recipe:

```python
import pyarrow as pa
import pyarrow.compute as pc
from pydantic import TypeAdapter

_BAR_LIST = TypeAdapter(list[EodBar])              # built once (§8.2)

# 1) Define the target columnar schema ONCE (this is the standard model R, as Arrow types).
#    (pydantic-to-pyarrow can derive this from R; or hand-write it — it is the contract.)
TARGET_SCHEMA = pa.schema([
    ("symbol", pa.string()),
    ("as_of",  pa.timestamp("us", tz="UTC")),
    ("open",   pa.decimal128(18, 6)),
    ("high",   pa.decimal128(18, 6)),
    ("low",    pa.decimal128(18, 6)),
    ("close",  pa.decimal128(18, 6)),
    ("volume", pa.int64()),
])

def transform_bulk(rows: list[dict], sample_n: int = 1000) -> pa.Table:
    # 2) SAMPLE-VALIDATE: run full Pydantic (incl. model_validator OHLC checks) on a slice.
    #    Proves the provider's shape/aliases/units match R before we trust the rest.
    sample = rows[:sample_n]
    _BAR_LIST.validate_python(sample)              # raises on drift -> fail the run, don't persist

    # 3) COLUMNAR-COERCE the FULL set: one vectorized cast, no per-row Python objects.
    raw = pa.Table.from_pylist(rows)               # build columns once
    table = raw.cast(TARGET_SCHEMA)                # vectorized type coercion in C++
    # 4) Columnar invariants instead of per-row model_validator (vectorized, no Python loop):
    bad = pc.or_(pc.less(table["high"], table["low"]),
                 pc.less(table["low"], 0))
    if pc.any(bad).as_py():
        raise ValueError("bulk OHLC invariant violated (high<low or low<0)")
    return table   # -> write to TimescaleDB COPY + Parquet Distribution (other refs)
```

Why this is the correct shape, from first principles:

- **A Parquet/Arrow column is type-homogeneous by construction.** Once the *schema* is proven on a sample,
  every row in the column is already the same type — re-instantiating a Python `EodBar` per row proves
  nothing new and costs a Python allocation + GC per row.
- **The cross-field invariant becomes a vectorized predicate.** `high >= low >= 0` over 100M rows is a
  single Arrow `compute` pass in C++ (`pc.less`, `pc.any`), not 100M Python `model_validator` calls — same
  guarantee, ~no per-row Python.
- **The schema contract still comes from Pydantic.** The standard model `R` remains the single source of
  truth for field names, types, aliases, and units; the bulk path derives its Arrow schema *from* `R`
  (`pydantic-to-pyarrow` exists for exactly this:
  [github.com/simw/pydantic-to-pyarrow](https://github.com/simw/pydantic-to-pyarrow)). You are not
  bypassing the model — you are applying it **once at the schema level**, then enforcing it columnar.

This is the same architecture the plan pins: Arrow as the bulk in-memory/transport format
([01-plan.md, "Transport (later)" + Phase 5](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)),
with the `columnar-parquet-arrow` skill owning the Arrow/Parquet I/O and this skill owning the *decision*
of where the Pydantic boundary sits.

### 9.4 The R-SCALE tier statement (required by the standard)

| Tier | Load | What this Transform design survives |
|---|---|---|
| **1× (demo)** | 1 provider, ≤10k rows | **Full per-row Pydantic** via reused `TypeAdapter`. Maximal safety, trivial cost. |
| **100× (traction)** | several providers, 100k–1M rows/run | **Sample-validate + columnar-coerce.** Full Pydantic on a representative slice + Arrow vectorized cast + vectorized invariants. |
| **10,000× (product)** | 100M+ rows, scheduled backfills | **Same as 100× but mandatory** — per-row Pydantic at this tier is the rejected pathology; the Arrow path is the only one that fits the ingest window. Heavy ingest runs **off the request path** on the Fly worker (non-negotiable #4), never on the gateway. |

> **What breaks at the next tier if you ignore this:** a Tier-1 "just validate every row" backfill that is
> instant on 10k rows turns a 100M-row reload into minutes-of-CPU of pure validation overhead and can blow
> the ingest window / memory budget — the classic "ship Tier-1 believing it's Tier-3" failure the
> product-at-scale rule exists to catch. The mitigation is the sample-validate boundary above, decided
> **at build time**, not retrofitted after an incident.

---

## §10 — `model_construct` — skip validation for ALREADY-trusted data

`model_construct(**data)` builds a model instance **bypassing validation entirely**
([models concept](https://pydantic.dev/docs/validation/latest/concepts/models/)): *"creates instances
bypassing validation entirely … You should only ever use the `model_construct` method with data which has
already been validated, or that you definitely trust."*

Legitimate Transform-stage use: re-hydrating a row **read back from our own store** (it was validated on
the way in — re-validating on the way out is wasted work). **Never** use it on raw provider input — it
would let a corrupt bar (negative price, `high<low`, a fabricated number) straight through, defeating the
entire Transform stage and violating non-negotiable #1.

```python
# OK: row came from OUR TimescaleDB, already validated at ingest
bar = EodBar.model_construct(**row_from_store)

# NEVER: provider data must go through validate_python / validate_json
# bar = EodBar.model_construct(**raw_provider_row)   # ❌ skips every check
```

> `model_construct` also **does not** convert nested dicts to nested models (*"skips nested
> dictionary-to-model conversion, so inner model instances require manual conversion"* — models concept).
> One more reason it is a read-back-only tool, not an ingest tool.

---

## §11 — Anti-patterns → fixes (Transform stage)

| Anti-pattern | Why it breaks | Fix |
|---|---|---|
| Parsing a raw provider string in a `mode='after'` validator | After-validators get the **already-coerced** value; the raw string is gone, or coercion already failed | Parse in `mode='before'` (§1); after for range checks only |
| Forgetting to `return` from a validator | Implicit `None` silently nulls the field | Always `return value` / `return self` (§1.1, §3.1) |
| Field order wrong for a cross-field before-validator | `info.data` only has **earlier** fields | Declare dependency fields **above** the dependent field (§1.3) |
| Coercing a provider sentinel (`"N/A"`, `"-"`, `""`) into `0`/`0.0` | Fabricates a finance number (non-negotiable #1) | Map sentinels to `None` in a before-validator (§1.3) |
| `extra='ignore'` (default) on an ingest model | Silently drops provider fields we may want as columns later | `extra='allow'` for ingest; `'forbid'` for egress (§5) |
| `coerce_numbers_to_str=True` (or lax) on an id field | A numeric provider value silently becomes a string id — corrupts the security-master key | `Field(strict=True)` on figi/ticker/isin/lei (§4.3) |
| `populate_by_name=True` in new code | Deprecated in 2.11+, removed in v3 | `validate_by_name=True` (+ `validate_by_alias=True`) (§6.1) |
| `validate_by_alias=False` **and** `validate_by_name=False` | Field becomes unpopulatable; Pydantic errors | Leave at least one `True` (§6.1) |
| One `Field(alias=...)` per camelCase field | Boilerplate; drifts | `alias_generator` (to_camel/to_snake) + `AliasChoices` for outliers (§7) |
| Constructing `TypeAdapter(...)` inside a function/loop | Rebuilds validator+serializer every call (non-trivial overhead) | Module-level singleton, built once (§8.2) |
| `json.loads(raw)` then `model_validate(...)` | Double parse (Python dict → re-validate) | `model_validate_json` / `TypeAdapter.validate_json` — one Rust pass (§9.2) |
| Per-row Pydantic on a 100M-row backfill | The 120ms→840ms pathology; minutes of pure validation CPU | Sample-validate + columnar Arrow coerce + vectorized invariants (§9.3) |
| `@field_validator` for `ge/le/min_length/pattern` checks | ~30× slower than declarative constraints | `Annotated[T, Field(ge=..., ...)]` enforced in Rust (§2.2) |
| `model_construct` on raw provider data | Skips ALL validation — lets corrupt/fabricated bars through | Only on data read back from our own store (§10) |
| `mode='wrap'` validator used casually | Forces Python materialization — slower than before/after | Use before/after; wrap only when you must see both sides (§3.2) |

---

## §12 — Output contract (grading rubric for a Transform-stage Pydantic model)

A standard model `R` and its validators are "done" only when:

1. **Raw provider strings are parsed in `mode='before'`** (datetime/Decimal/scale), and the **canonical**
   cases lean on Pydantic's own lax coercion rather than a redundant validator (§1.2). ✔/�’
2. **Sentinels (`"N/A"`, `"-"`, `""`) map to `None`**, never to a fabricated number (non-negotiable #1). ✔/✗
3. **Range/sanity checks are `mode='after'` or — better — `Annotated[..., Field(...)]`** declarative
   constraints (≈30× faster) (§2). ✔/✗
4. **Cross-field invariants** (`high >= low >= 0`, `close ∈ [low, high]`) are a `model_validator(mode='after')`
   returning `self` (§3.1). ✔/✗
5. **Identifier / boolean fields are `strict=True`**; numeric series fields are lax-with-clean; the policy
   table (§4.3) is followed and stated. ✔/✗
6. **`extra='allow'` on ingest models** (capture provider surplus into `model_extra`); `'forbid'` on
   published egress models (§5). ✔/✗
7. **Aliasing uses `validate_by_name`/`validate_by_alias`, not deprecated `populate_by_name`**; bulk renames
   use an `alias_generator` (named direction) + `AliasChoices` for outliers (§6, §7). ✔/✗
8. **List validation uses a `TypeAdapter(list[R])` constructed once at module scope**, not per-call, not a
   wrapper model (§8). ✔/✗
9. **The bulk path is sample-validate + columnar-coerce, never per-row at 100M rows**; the model's
   R-SCALE tier and next-tier break are stated (§9). ✔/✗
10. **`model_construct` appears only on read-back from our own store**, never on raw provider input (§10). ✔/✗
11. **Every Pydantic version/API claim used in the model matches the pinned `pydantic==2.13.x`** (no API
    invented for a version that doesn't ship it). ✔/✗

---

## §13 — Citations (primary sources, verified 2026-06-24)

- **Validators** (field/model, before/after/wrap/plain, `check_fields`, `ValidationInfo`, error types,
  order) — [pydantic.dev/docs/validation/latest/concepts/validators](https://pydantic.dev/docs/validation/latest/concepts/validators/)
  (canonical URL; the old `docs.pydantic.dev/latest/concepts/validators` 301-redirects here).
- **ConfigDict** (`extra`, `validate_by_name`, `validate_by_alias`, `populate_by_name` deprecation,
  `alias_generator`, `strict`, `coerce_numbers_to_str`, `str_strip_whitespace`, `validate_assignment`,
  `frozen`) — [pydantic.dev/docs/validation/latest/api/pydantic/config](https://pydantic.dev/docs/validation/latest/api/pydantic/config/).
- **Aliases** (`alias`/`validation_alias`/`serialization_alias`, `AliasChoices`, `AliasPath`,
  `AliasGenerator`, `to_camel`/`to_snake`/`to_pascal`, alias_priority) —
  [pydantic.dev/docs/validation/latest/concepts/alias](https://pydantic.dev/docs/validation/latest/concepts/alias/).
- **TypeAdapter** (`validate_python`/`validate_json`/`dump_json` returns bytes/`json_schema`, construct-once
  guidance) — [pydantic.dev/docs/validation/latest/concepts/type_adapter](https://pydantic.dev/docs/validation/latest/concepts/type_adapter/).
- **Models** (`model_extra`/`__pydantic_extra__`, `model_construct`, `model_validate`/`model_validate_json`,
  `model_dump`) — [pydantic.dev/docs/validation/latest/concepts/models](https://pydantic.dev/docs/validation/latest/concepts/models/).
- **Strict mode** (model/field/call-time strict, `Strict()`, `StrictInt`/`StrictStr`/…, JSON looseness) —
  [pydantic.dev/docs/validation/latest/concepts/strict_mode](https://pydantic.dev/docs/validation/latest/concepts/strict_mode/).
- **Conversion table** (str→int/float/Decimal/datetime/date/bool, lax vs strict) —
  [pydantic.dev/docs/validation/latest/concepts/conversion_table](https://pydantic.dev/docs/validation/latest/concepts/conversion_table/).
- **Performance** (`model_validate_json` one-pass, TypeAdapter reuse, avoid wrap validators, `FailFast`,
  concrete types, TypedDict ~2.5×) — [pydantic.dev/docs/validation/latest/concepts/performance](https://pydantic.dev/docs/validation/latest/concepts/performance/).
- **Rust core / 5–50×** — [pydantic.dev/articles/pydantic-v2](https://pydantic.dev/articles/pydantic-v2);
  [news.ycombinator.com/item?id=35490449](https://news.ycombinator.com/item?id=35490449).
- **Bulk benchmark numbers** (30× Annotated; 0.209s vs 0.368s JSON; TypeAdapter 0.381s vs per-item 0.502s,
  120–220 ms saving) — [Towards Data Science, "Pydantic Performance: 4 Tips on How to Validate Large
  Amounts of Data Efficiently"](https://towardsdatascience.com/pydantic-performance-4-tips-on-how-to-validate-large-amounts-of-data-efficiently/).
- **pydantic-to-pyarrow** (derive an Arrow schema from a Pydantic model for the bulk path) —
  [github.com/simw/pydantic-to-pyarrow](https://github.com/simw/pydantic-to-pyarrow);
  [pypi.org/project/pydantic-to-pyarrow](https://pypi.org/project/pydantic-to-pyarrow/).
- **Version pin** (pydantic 2.13.4, 2026-05-06, MIT) — [pypi.org/pypi/pydantic/json](https://pypi.org/pypi/pydantic/json).
- **Project decisions** (per-row Pydantic REJECTED → Arrow batch; `extra='allow'` standard; Arrow bulk
  transport; never-invent-a-number) — [02-skills-and-pipeline.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md),
  [01-plan.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md).
