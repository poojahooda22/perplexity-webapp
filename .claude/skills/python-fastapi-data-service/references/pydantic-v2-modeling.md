# Pydantic v2 Modeling — request/response/standard data, and the validate-vs-construct cost model

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (NOT Lumina). This is a
> NEW Python/FastAPI/data-engineering service, separate from Lumina's Bun/Express/Prisma/Upstash stack.
> Pydantic v2 is the schema layer for every FastAPI request/response, every internal DTO, and every
> "standard envelope" the data plane emits.
>
> **Scope of THIS reference:** how to model data with Pydantic v2 (`BaseModel`, `Field`, validators,
> serializers, `model_config`, aliasing), what the Rust core (`pydantic-core`) actually does under the
> hood, and — the load-bearing part for a market-data service — the **cost model of validate vs.
> construct vs. dump at financial-series volume**, so you know *when* a `BaseModel` is the right tool and
> when it is a per-row tax that must be paid in Arrow instead.
>
> **Version pin (verify before relying on exact behavior):** Pydantic **2.13.4**, released **2026-05-06**
> (PyPI: <https://pypi.org/project/pydantic/> — "Latest Version: 2.13.4 … Release Date: May 6, 2026 …
> Minimum Python Version: Python >=3.9"). The Rust engine is `pydantic-core` (now living in the main repo
> at `github.com/pydantic/pydantic/tree/main/pydantic-core`, the standalone `pydantic/pydantic-core` repo
> was **archived 2026-04-11**; latest standalone release **v2.41.5**, 2025-11-04 —
> <https://github.com/pydantic/pydantic-core>). When you read `:line` or an exact option name here, treat
> it as a hint and re-confirm against the installed version with `python -c "import pydantic; print(pydantic.version.version_info())"`.

---

## 0. The one-paragraph mental model (read this first)

A `BaseModel` subclass is **not** a dataclass with type hints. When the class is defined, Pydantic walks
its annotations and **compiles a "core schema"** — a serializable Python dict describing the validation
and serialization plan — then hands that schema to the Rust package `pydantic-core`, which builds two
optimized objects: a **`SchemaValidator`** and a **`SchemaSerializer`**. Those live on the class as
`__pydantic_validator__` and `__pydantic_serializer__`. Every `Model(...)`, `Model.model_validate(...)`,
and `model.model_dump(...)` call is a trip into Rust against that pre-compiled plan. This is *why* v2 is
4–50× faster than v1 (pure-Python) — and it is *also* why the right scaling question is never "is
Pydantic fast?" but "**how many times do I cross the Python↔Rust boundary per request?**" One model
validated once is free. One million rows each wrapped in a model is a boundary crossing per row, and that
is the anti-pattern this whole reference exists to prevent.

---

## 1. `BaseModel` + `Field` constraints — the request/response surface

### 1.1 Defining a model

> "Models are simply classes which inherit from `BaseModel` and define fields as annotated attributes."
> — pydantic docs, Models (<https://pydantic.dev/docs/validation/latest/concepts/models/>)

```python
from datetime import datetime
from decimal import Decimal
from pydantic import BaseModel, Field

class BarRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32, pattern=r"^[A-Z0-9.\-:]+$")
    interval: str = Field(default="1d")
    start: datetime
    end: datetime
    limit: int = Field(default=1000, gt=0, le=50_000)
```

A bare annotation (`symbol: str`) is a **required** field. An annotation with a default
(`interval: str = "1d"`) is optional. `Field(...)` attaches constraints and metadata; when you need a
default *and* constraints, either pass `default=` inside `Field(...)` **or** use the `Annotated` form
(§1.4), which is the recommended style for reuse.

### 1.2 The `Field()` constraint catalogue (verified against docs/concepts/fields)

Source: <https://pydantic.dev/docs/validation/latest/concepts/fields/>

| Constraint | Applies to | Meaning | Notes |
|---|---|---|---|
| `gt`, `ge`, `lt`, `le` | numeric | greater/less than (or equal) | compiled into the core schema, enforced in Rust |
| `multiple_of` | numeric | value must be a multiple | |
| `min_length`, `max_length` | str / collections | length bounds | for `str`, also lists/dicts/sets |
| `pattern` | str | regex match | Rust regex engine — **not** Python `re`; some lookahead/backref unsupported |
| `max_digits`, `decimal_places` | `Decimal` | total digits / digits after point | the right type for money/prices (§7) |
| `default` | any | direct default value | |
| `default_factory` | any | callable producing the default | "can accept validated data as argument in v2.10+" — `Field(default_factory=lambda data: data['email'])` |
| `alias` | any | input+output name | see §4 |
| `validation_alias` | any | input-only name (str / `AliasPath` / `AliasChoices`) | §4 |
| `serialization_alias` | any | output-only name (str) | §4 |
| `frozen` | any | field is read-only after construction | per-field immutability |
| `exclude` | any | omit from serialization | |
| `exclude_if` | any | omit conditionally — `Field(exclude_if=lambda v: v == 0)` | newer; verify in installed version |
| `strict` | any | force strict (no coercion) for this field | §3.4 |
| `description`, `title`, `examples` | any | JSON-Schema / OpenAPI metadata | surfaces in FastAPI `/docs` |
| `repr` | any | include in `repr()` | set `False` to hide secrets from logs |

```python
class Model(BaseModel):
    positive: int = Field(gt=0)
    short_str: str = Field(max_length=3)
    precise_decimal: Decimal = Field(max_digits=5, decimal_places=2)
```
(verbatim from the fields docs.)

`default_factory` that reads already-validated data (v2.10+):

```python
from uuid import uuid4
class User(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    username: str = Field(default_factory=lambda data: data["email"])
```

> **Why this matters for the data service.** FastAPI uses these constraints to **reject bad input at the
> edge in Rust before your handler runs** and to auto-generate the OpenAPI schema. A `limit: int =
> Field(le=50_000)` is your first line of defense against a client asking for ten million bars — a
> scale-surface guard expressed declaratively, enforced in compiled code, documented for free.

### 1.3 Required vs. optional vs. nullable (the three are different)

```python
from typing import Optional
class Q(BaseModel):
    a: int            # required, must be present
    b: int = 0        # optional, defaults to 0
    c: Optional[int]  # REQUIRED, but may be None  (Optional != optional!)
    d: Optional[int] = None  # optional AND nullable — the usual "nullable field"
```

This trips everyone once. `Optional[int]` (i.e. `int | None`) only changes the *type* to allow `None`; it
does **not** give the field a default. If you want "may be omitted, defaults to null", you must write
`= None`. For a public API surface, be explicit — an omitted-but-required field produces a
`missing` error, while a nullable-with-default silently fills `None`, and the difference is visible to
every client.

### 1.4 The `Annotated` form — the reuse primitive

> "For metadata-rich declarations without confusing default value syntax" — fields docs.

```python
from typing import Annotated
from pydantic import BaseModel, Field

Symbol      = Annotated[str, Field(min_length=1, max_length=32, pattern=r"^[A-Z0-9.\-:]+$")]
PositiveInt = Annotated[int, Field(gt=0)]
Price       = Annotated[Decimal, Field(max_digits=18, decimal_places=8, ge=0)]

class Quote(BaseModel):
    symbol: Symbol
    size:   PositiveInt
    last:   Price
```

`Annotated[T, Field(...)]` separates the **type** from the **default value slot**, so the same constraint
bundle (`Symbol`, `Price`) is declared once and reused across every model in the service. This is the
*right* place to put domain constraints in a multi-model codebase; it also composes with validators and
serializers (which are themselves just more entries in the `Annotated[...]` list — see §5/§6 ordering).

---

## 2. `model_config` — the per-model behavior switchboard

Set via a class attribute `model_config = ConfigDict(...)`. It governs coercion strictness, extra-field
policy, aliasing, immutability, and JSON serialization defaults.

```python
from pydantic import BaseModel, ConfigDict

class User(BaseModel):
    model_config = ConfigDict(str_max_length=10)
    id: int
    name: str = "Jane Doe"
```
(verbatim shape from the models docs.)

### 2.1 The options that bite in a data service

Source: config API (<https://pydantic.dev/docs/validation/latest/api/config/>) + alias concepts
(<https://pydantic.dev/docs/validation/latest/concepts/alias/>).

| `ConfigDict` key | Default | What it does | When you flip it |
|---|---|---|---|
| `extra` | `'ignore'` | unknown input keys: `'ignore'` drop, `'forbid'` raise, `'allow'` keep in `__pydantic_extra__` | **`'forbid'` on request models** (catch client typos); `'allow'` only on passthrough envelopes |
| `validate_by_name` | `False` | accept field **name** even when an alias is set | the v2.11+ name for `populate_by_name` (see §2.2) |
| `validate_by_alias` | `True` | accept the alias as input | turning this off + `validate_by_name=True` = name-only |
| `serialize_by_alias` | `False` | `model_dump()` emits aliases without needing `by_alias=True` | external-contract models that always emit camelCase |
| `alias_generator` | `None` | callable or `AliasGenerator` producing aliases for every field | snake↔camel boundary (§4.4) |
| `str_strip_whitespace` | `False` | strip leading/trailing whitespace on `str` inputs | hygienic for symbols/tickers |
| `str_max_length` / `str_min_length` | `None` | global string bounds | |
| `frozen` | `False` | whole model immutable + hashable | value objects, cache keys, dict keys |
| `from_attributes` | `False` | validate from arbitrary objects by attribute (ORM mode) | building response models off ORM rows |
| `revalidate_instances` | `'never'` | re-validate nested model instances on assignment/validation: `'never'`/`'always'`/`'subclass-instances'` | leave `'never'` for trusted internal flow (perf) |
| `validate_assignment` | `False` | run validators on attribute set, not just construction | safety vs. speed trade — off on hot paths |
| `validate_default` | `False` | run validators on default values too | |
| `arbitrary_types_allowed` | `False` | permit fields whose type has no validator (validated by `isinstance`) | wrapping numpy/pandas types — but see §8 |
| `use_enum_values` | `False` | store the enum's `.value` instead of the enum member | when downstream wants the raw string/int |
| `ser_json_timedelta` | `'iso8601'` | timedelta JSON form (`'iso8601'` / `'float'`) | |
| `ser_json_bytes` | `'utf8'` | bytes JSON form (`'utf8'` / `'base64'` / `'hex'`) | |
| `coerce_numbers_to_str` | `False` | allow int/float → str coercion | |
| `defer_build` | `False` | don't build the validator/serializer until first use | import-time cost / forward refs (§9.3) |
| `json_schema_extra` | `None` | extra keys merged into the generated JSON Schema | OpenAPI examples |

> **Recommended baseline for this service.** Request models: `ConfigDict(extra='forbid',
> str_strip_whitespace=True)` so a client's `lmit=...` typo 422s instead of being silently dropped.
> Internal DTOs that round-trip through trusted code: leave defaults and prefer `model_construct` (§3.3)
> over re-validation. External-contract response models: a shared base with `serialize_by_alias=True` +
> an `alias_generator=to_camel` (§4.4 / §10).

### 2.2 `populate_by_name` is being renamed — use `validate_by_name`

> "Pydantic 2.11 introduced `validate_by_name`, which is equivalent to `populate_by_name`, and
> `populate_by_name` is pending deprecation in V3."
> — (search synthesis over the alias/config docs; corroborated by the alias concepts page below)

The alias docs state the modern pair plainly:

> "`validate_by_alias` (default: `True`): Accept data using aliases. `validate_by_name` (default:
> `False`): Accept data using field names. Both can be `True` simultaneously. **Cannot both be `False`.**"
> — alias concepts (<https://pydantic.dev/docs/validation/latest/concepts/alias/>)

```python
from pydantic import BaseModel, ConfigDict, Field

class Model(BaseModel):
    my_field: str = Field(validation_alias="my_alias")
    model_config = ConfigDict(validate_by_alias=True, validate_by_name=True)

Model(my_alias="foo")  # works (alias)
Model(my_field="foo")  # works (name)  ← because validate_by_name=True
```

**Write `validate_by_name=True` in new code**, not `populate_by_name=True`. They mean the same thing today
but the latter is on the V3 deprecation path. This foreshadows — but does **not** own — the TET
`__alias_dict__` pattern (a per-class alias map a downstream layer may build); the modeling layer's job is
just to declare aliases correctly and pick the right `validate_by_*` policy. The TET alias-map mechanism
is documented wherever that pattern is owned, not here.

### 2.3 `frozen=True` — immutable value objects

```python
class Money(BaseModel):
    model_config = ConfigDict(frozen=True)
    amount: Decimal
    currency: str
```

A frozen model is **immutable and hashable**, so it can be a `dict` key or a set member (useful for cache
keys keyed on a request shape). Attempting `m.amount = ...` raises a validation error. Combine with
`model_copy(update={...})` (§3.6) to "change" a field by producing a new instance.

---

## 3. The five methods that matter — `validate`, `validate_json`, `construct`, `dump`, `dump_json`

This section is the heart of the cost model. Each of these is a distinct round-trip into the Rust core (or
a deliberate *skip* of it).

### 3.1 `model_validate(obj)` — validate a Python object

> "Validates Python objects (dicts or model instances). Arbitrary objects supported with
> `from_attributes=True`." — models docs

```python
m = User.model_validate({"id": 123, "name": "James"})
# from an ORM row / arbitrary object:
m = User.model_validate(orm_row)   # needs model_config = ConfigDict(from_attributes=True)
```

Runs the **full validation pipeline** (coercion, constraints, validators) against an already-in-memory
Python object. Use it when the data arrived as a `dict`/object (not a raw JSON string), or when validating
ORM rows into response models.

### 3.2 `model_validate_json(json_str)` — validate **directly from JSON** (the fast path for JSON in)

> "On `model_validate(json.loads(...))`, the JSON is parsed in Python, then converted to a dict, then it's
> validated internally. On the other hand, `model_validate_json()` already performs the validation
> internally." — performance docs (<https://pydantic.dev/docs/validation/latest/concepts/performance/>)

```python
m = User.model_validate_json('{"id": 123, "name": "James"}')   # bytes or str
```

**This is a real, free speedup.** `pydantic-core` contains its own JSON parser (`jiter`) and parses +
validates in one Rust pass, never materializing the intermediate Python `dict`. The announcement is
explicit that this is by design:

> "pydantic-core can parse JSON directly into a model or output type, this both improves performance and
> avoids issue with strictness." — Pydantic v2 announcement (<https://pydantic.dev/articles/pydantic-v2>)

**Rule for the service:** when the bytes are JSON (a request body, an upstream provider response), reach
for `model_validate_json(raw_bytes)` — never `model_validate(json.loads(raw_bytes))`. In FastAPI the
framework already does this for typed request bodies; the rule bites in your own provider-client code.

### 3.3 `model_construct(...)` — **skip validation** (the trusted-data fast path)

> "You should only ever use the `model_construct()` method with data which has already been validated, or
> that you definitely trust." — models docs

```python
# Build an instance WITHOUT running any validation:
m = User.model_construct(id=123, name="James")
```

Behaviors (from the models docs, verbatim/condensed):

- **No validation occurs**, including dict→model conversions of nested fields.
- **Default values still apply** (missing fields get their defaults).
- **Private attributes populate normally**; no parent `__init__` runs.
- **Extra-data handling is different from validated construction:**
  - `extra='allow'` → unmatched keys go to `__pydantic_extra__`
  - `extra='ignore'` → unmatched keys silently dropped
  - `extra='forbid'` → **does NOT raise** (unlike normal instantiation); the extra data is simply
    ignored. *This is a footgun:* `model_construct` will not catch the bad key that `Model(...)` would.

#### The critical performance caveat — **profile before you reach for it**

> "In Pydantic V2, the performance gap between validation and `model_construct()` has been narrowed
> considerably. For simple models, going with validation may even be faster. If you are using
> `model_construct()` for performance reasons, you may want to profile your use case before assuming it is
> actually faster." — models docs

This is counter-intuitive and load-bearing: in v1, `construct()` was a big win because validation was slow
Python; in v2 the validator is compiled Rust, and `model_construct` is *Python-side* attribute-setting
that bypasses that fast path — so for a **simple flat model it can be SLOWER than validating**. The wins
are real only when (a) the model is **deep/nested** (you skip recursively building+validating sub-models)
or (b) you're avoiding an **expensive custom validator**, and you have **already verified the data** at an
earlier boundary.

**Where it is the right tool in this service** (and the *only* in-process place a `BaseModel` belongs on a
bulk path):

- Replaying a **trusted internal envelope** that was validated on ingress and is now round-tripping
  between two of your own services (don't pay validation twice).
- Reconstructing models from a **trusted cache/store** you wrote yourself (e.g. a Redis/JSON blob you
  serialized minutes ago).
- The **escape hatch** when you *must* hand a typed model to a downstream that requires one, but the data
  is already known-good and you want to avoid the per-instance validation tax — see §11 for exactly where
  this sits relative to the columnar bulk path.

**Where it is wrong:** any **untrusted** boundary (a client body, a third-party provider response). There,
validation *is* the product — `model_construct` would let a garbage `price` straight through, violating
the "never invent / never pass an ungrounded number" posture of a finance data plane.

### 3.4 Strict vs. lax — the coercion knob that interacts with all three

> Strict: "only the exact data type is allowed, e.g. passing `"123"` to an `int` field would result in a
> validation error." Lax: "If the input data has a SINGLE and INTUITIVE representation, in the field's
> type, AND no data is lost during the conversion, then the data will be converted." — v2 announcement

Lax (default) coerces `"123"` → `123`; strict rejects it. JSON validation relaxes *some* strict rules on
purpose (an ISO-8601 string → `datetime` is allowed even in strict JSON mode, because in JSON there is no
native datetime). Set strictness per call (`model_validate(..., strict=True)`), per field
(`Field(strict=True)`), or per model (`ConfigDict(strict=True)`).

For a market-data API: **strict on internal numeric DTOs** (a `price` that arrives as a string is a
provider bug you want to *see*, not silently coerce), **lax on the public request edge** (a query-string
`?limit=1000` arrives as a string and you *want* `1000`).

### 3.5 `model_dump(...)` and `model_dump_json(...)` — serialize out

> "`model_dump()` converts Pydantic models to dictionaries in Python mode, while `model_dump_json()`
> produces JSON-encoded strings. Both support extensive customization." — serialization docs
> (<https://pydantic.dev/docs/validation/latest/concepts/serialization/>)

```python
user.model_dump()                  # -> dict, native Python types preserved
user.model_dump(mode="json")       # -> dict, but JSON-safe types (datetime->str, tuple->list)
user.model_dump_json()             # -> str (JSON), one Rust pass, no intermediate dict
```

The `mode` distinction is exact (verbatim example from the docs):

```python
m = FooBarModel(banana=3.14, foo="hello", bar={"whatever": (1, 2)})
print(m.model_dump())            # tuple preserved: {'whatever': (1, 2)}
print(m.model_dump(mode="json")) # converted to list: {'whatever': [1, 2]}
```

Key parameters (both methods, from the serialization docs):

| Param | Effect |
|---|---|
| `mode='python'` / `'json'` | native types vs JSON-safe types (`model_dump` only; `model_dump_json` is always JSON) |
| `include` / `exclude` | field sets or nested dicts to keep/drop |
| `by_alias` | emit serialization aliases as keys |
| `exclude_unset` | drop fields the caller never explicitly set (PATCH semantics) |
| `exclude_defaults` | drop fields equal to their default |
| `exclude_none` | drop `None` values |
| `round_trip` | ensure output re-validates back to the same model |
| `serialize_as_any` | duck-type serialization (serialize by the runtime object, not the declared type) |
| `context` | pass a dict to custom serializers (§6.3) |
| `warnings` | control the warning on a serializer/type mismatch |

> **The `model_dump_json()` fast path (mirror of §3.2).** For a JSON HTTP response, prefer
> `model.model_dump_json()` over `json.dumps(model.model_dump())`: the former serializes straight to a
> JSON string in **one Rust pass** without building the intermediate Python dict. In FastAPI, returning a
> `BaseModel` from a handler triggers this internally — but in your own code (writing a response to a
> queue, a cache, a log) the explicit call is the difference between one boundary crossing and two.

> **`exclude_unset` for PATCH.** A `PUT`/`PATCH` request model dumped with `exclude_unset=True` yields
> only the fields the client actually sent — the canonical way to build a partial-update payload without a
> sentinel-laden "unset" type. Pairs with `model_copy(update=...)` (§3.6).

### 3.6 `model_copy(...)` — duplicate with edits (esp. for frozen models)

```python
m = FooBarModel(banana=3.14, foo="hello", bar={"whatever": 123})
m.model_copy(update={"banana": 0})   # shallow copy with field overrides
m.model_copy(deep=True)              # deep copy
```

`model_copy` does **not** re-validate by default (it's a copy of trusted in-memory state); pass
`update={...}` to override fields. This is how you "mutate" a `frozen=True` value object — produce a new
one. (verbatim shape from the models docs.)

### 3.7 The decision table — which method, when

| Situation | Use | Why |
|---|---|---|
| Untrusted JSON bytes in (request body, provider response) | `model_validate_json(raw)` | parse+validate in one Rust pass; never `model_validate(json.loads())` |
| Untrusted Python object/dict in | `model_validate(obj)` | full pipeline; the validation **is** the safety |
| ORM row → response model | `model_validate(row)` + `from_attributes=True` | attribute-based validation |
| Already-validated data round-tripping internally | `model_construct(**data)` (profile first) | skip the second validation — only wins on nested/expensive models |
| Need a JSON string out (HTTP/queue/cache) | `model_dump_json()` | one Rust pass, no intermediate dict |
| Need a Python dict out (further processing) | `model_dump()` (`mode='json'` if it must be JSON-safe) | |
| Partial-update payload | `model_dump(exclude_unset=True)` | only client-sent fields |
| "Change" a frozen value object | `model_copy(update={...})` | immutability-preserving |
| **Bulk: a million rows** | **NONE of the above per row** — go columnar (Arrow) | every per-row call is a Python↔Rust boundary crossing → §11 |

---

## 4. Aliasing — the snake_case↔camelCase / wire-name boundary

External APIs and upstream providers speak many naming conventions; your Python fields should stay
`snake_case`. Aliases bridge the two without leaking wire names into your code.

### 4.1 The three alias fields

Source: alias concepts (<https://pydantic.dev/docs/validation/latest/concepts/alias/>).

- **`alias`** — one string used for *both* validation input and serialization output.
- **`validation_alias`** — input only; may be a `str`, an `AliasPath`, or an `AliasChoices`.
- **`serialization_alias`** — output only; must be a `str`.

```python
class User(BaseModel):
    name: str = Field(alias="username")   # accepts {"username": ...}, emits "username" with by_alias
```

### 4.2 `AliasChoices` — accept several input names

```python
from pydantic import BaseModel, Field, AliasChoices

class User(BaseModel):
    first_name: str = Field(validation_alias=AliasChoices("first_name", "fname"))

User.model_validate({"fname": "John"})   # first match wins, in order
```

Indispensable when two upstream providers disagree on a field name (`"vol"` vs `"volume"` vs `"v"`) — list
all of them, normalize to one Python field.

### 4.3 `AliasPath` — pull a field out of a nested input

```python
from pydantic import BaseModel, Field, AliasPath

class User(BaseModel):
    first_name: str = Field(validation_alias=AliasPath("names", 0))
    address: str   = Field(validation_alias=AliasPath("contact", "address"))

User.model_validate({"names": ["John", "Doe"], "contact": {"address": "221B Baker Street"}})
```

Flattens a nested provider payload into a flat DTO without a hand-written pre-validator. Combine
`AliasPath` inside `AliasChoices` for "try this nested path, else that flat key".

### 4.4 `alias_generator` / `AliasGenerator` — convention at the model level

```python
from pydantic import AliasGenerator, BaseModel, ConfigDict
from pydantic.alias_generators import to_camel  # also: to_pascal, to_snake

class Tree(BaseModel):
    model_config = ConfigDict(
        alias_generator=AliasGenerator(
            validation_alias=to_camel,         # accept camelCase input
            serialization_alias=to_camel,      # emit camelCase output
        ),
        validate_by_name=True,                 # ALSO accept snake_case names
    )
    height_in_metres: float
```

A plain callable (`alias_generator=to_camel`) generates the same alias for both validation and
serialization; the `AliasGenerator` class splits them. Built-ins: `to_camel`, `to_pascal`, `to_snake`.
**Field-level aliases override the generator** by default (control with `alias_priority`):

> "`alias_priority=2`: Field alias won't be overridden. `alias_priority=1`: Field alias will be
> overridden. Not set: Default behavior (alias blocks generator)." — alias concepts

> **For this service:** put the camel/snake bridge on a **shared response base** (§10) so the entire
> external contract is camelCase while internal code stays snake_case — and set `validate_by_name=True` so
> your own tests/services can construct models with the Python names. This is exactly the seam the TET
> `__alias_dict__` pattern formalizes downstream; the modeling layer just declares it.

---

## 5. Field & model validators — `field_validator` / `model_validator`, modes before/after/wrap/plain

Source: validators (<https://pydantic.dev/docs/validation/latest/concepts/validators/>).

### 5.1 The four field-validator modes

| Mode | Runs | Sees | Use for |
|---|---|---|---|
| **after** (default) | *after* Pydantic's own validation/coercion | the already-typed value (`int`, `datetime`, …) | business rules on a known-good type; **type-safe, preferred** |
| **before** | *before* coercion | the **raw** input (any object) | reshaping input (string→list, normalize a symbol) |
| **plain** | instead of validation | the raw input; **terminates** — no internal validation, no later validators | full manual control of one field |
| **wrap** | around validation | raw input **+** a `handler` you call to invoke Pydantic | catch/recover from a validation error, conditionally skip |

After (decorator + Annotated forms — both verbatim from docs):

```python
from pydantic import BaseModel, field_validator

class Model(BaseModel):
    number: int
    @field_validator("number", mode="after")
    @classmethod
    def is_even(cls, value: int) -> int:
        if value % 2 == 1:
            raise ValueError(f"{value} is not an even number")
        return value
```

```python
from typing import Annotated
from pydantic import AfterValidator, BaseModel

def is_even(value: int) -> int:
    if value % 2 == 1:
        raise ValueError(f"{value} is not an even number")
    return value

class Model(BaseModel):
    number: Annotated[int, AfterValidator(is_even)]
```

Before (reshape raw input):

```python
from typing import Any
from pydantic import BaseModel, field_validator

class Model(BaseModel):
    numbers: list[int]
    @field_validator("numbers", mode="before")
    @classmethod
    def ensure_list(cls, value: Any) -> Any:
        return value if isinstance(value, list) else [value]

Model(numbers=2)  # numbers=[2]
```

Wrap (recover from an error — a real, useful pattern):

```python
from typing import Any, Annotated
from pydantic import BaseModel, Field, ValidationError, ValidatorFunctionWrapHandler, field_validator

class Model(BaseModel):
    my_string: Annotated[str, Field(max_length=5)]
    @field_validator("my_string", mode="wrap")
    @classmethod
    def truncate(cls, value: Any, handler: ValidatorFunctionWrapHandler) -> str:
        try:
            return handler(value)
        except ValidationError as err:
            if err.errors()[0]["type"] == "string_too_long":
                return handler(value[:5])
            raise

Model(my_string="abcdef")  # my_string='abcde'
```

> **Performance note (verbatim):** "Wrap validators are generally slower than other validators because
> they require data materialization in Python during validation." — performance docs. So: prefer
> `after` for ordinary rules; reach for `wrap` only when you genuinely need to intercept the error, and
> **never** put a `wrap` validator on a field that appears in a bulk-decoded row.

### 5.2 Model validators (whole-object rules)

```python
from typing_extensions import Self
from pydantic import BaseModel, model_validator

class BarRequest(BaseModel):
    start: datetime
    end: datetime
    @model_validator(mode="after")
    def check_range(self) -> Self:
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self
```

- `mode="after"` — instance method, runs after all fields validate, **must return `self`**. The place for
  cross-field invariants (`end > start`, `limit ≤ window-size`).
- `mode="before"` — classmethod over the **raw input** (often a dict); reshape/guard before field
  validation. (Verbatim `check_card_number_not_present` example in the docs.)
- `mode="wrap"` — classmethod with a `handler`; wrap the whole-model validation (e.g. log on failure).

> Model validators in a base class run during subclass validation; overriding in a subclass replaces the
> base version. (docs)

### 5.3 `ValidationInfo` — cross-field reads, context, mode

```python
from pydantic import BaseModel, ValidationInfo, field_validator

class UserModel(BaseModel):
    password: str
    password_repeat: str
    @field_validator("password_repeat", mode="after")
    @classmethod
    def check_match(cls, value: str, info: ValidationInfo) -> str:
        if value != info.data["password"]:
            raise ValueError("Passwords do not match")
        return value
```

`info.data` exposes **already-validated** fields (ordered by definition — you can only read earlier
fields), `info.context` carries a per-call dict (only available via `model_validate(..., context=...)`,
**not** plain `Model(...)`), and `info.field_name` / `info.mode` ('python'/'json'/'strings') tell you where
you are. Context example (verbatim) removes stopwords given `context={"stopwords": [...]}`.

### 5.4 Validator execution order (when you stack several on one field)

> "Before and wrap validators execute right-to-left, then after validators execute left-to-right." — docs

```python
class Model(BaseModel):
    name: Annotated[str,
        AfterValidator(runs_3rd),
        AfterValidator(runs_4th),
        BeforeValidator(runs_2nd),
        WrapValidator(runs_1st),
    ]
```

Decorator-defined validators are appended last and follow the same ordering. **Keep validators few and
`after`-mode on any model that may be decoded in volume** — each is a Python callback that defeats the
"stay in Rust" optimization.

### 5.5 Raising errors

Three accepted exception types: `ValueError` (most common, becomes a `ValidationError`),
`AssertionError` (note: skipped under `python -O`, so **don't** rely on `assert` for real validation), and
`PydanticCustomError` (typed, with a template + context dict) for machine-readable error codes:

```python
from pydantic_core import PydanticCustomError
raise PydanticCustomError("the_answer_error", "{number} is the answer!", {"number": v})
```

---

## 6. Serializers — `field_serializer` / `model_serializer`, and a custom base for datetime

Source: serialization docs. Serializers are the output-side mirror of validators.

### 6.1 `@field_serializer`

```python
from typing import Any
from pydantic import BaseModel, field_serializer, SerializerFunctionWrapHandler

class M(BaseModel):
    number: int
    @field_serializer("number", mode="plain")
    def ser_number(self, value: Any) -> Any:
        return value * 2 if isinstance(value, int) else value
```

`mode="plain"` replaces serialization for the field; `mode="wrap"` gives a `handler` to call Pydantic's
default then post-process. Annotated/reusable form:

```python
from typing import Annotated
from pydantic import PlainSerializer
DoubleNumber = Annotated[int, PlainSerializer(lambda v: v * 2)]
class Model(BaseModel):
    my_number: DoubleNumber
```

### 6.2 `@model_serializer` (whole-object output shape)

```python
from pydantic import model_serializer, SerializerFunctionWrapHandler

class M(BaseModel):
    username: str
    password: str
    @model_serializer(mode="wrap")
    def ser(self, handler: SerializerFunctionWrapHandler) -> dict:
        out = handler(self)
        out["fields"] = list(out)
        return out
```

### 6.3 Serialization context

Custom serializers can read a `context` dict passed at dump time
(`model.model_dump(context={...})`) — symmetric with validation context. Useful for "redact PII unless
`context={'role':'admin'}`".

### 6.4 A shared base model for consistent datetime serialization

Financial payloads are full of timestamps; you want **one** canonical wire format (UTC, RFC-3339/ISO-8601,
`Z` suffix) across every model. Put it on a base class so every response inherits it:

```python
from datetime import datetime, timezone
from typing import Any
from pydantic import BaseModel, ConfigDict, field_serializer

class ApiModel(BaseModel):
    """Service-wide base for every external response model."""
    model_config = ConfigDict(
        extra="forbid",            # contract is closed
        ser_json_timedelta="iso8601",
        populate_by_name=False,    # external names only on the wire
    )

    @field_serializer("*", mode="wrap", when_used="json", check_fields=False)
    def _utc_isoformat(self, value: Any, handler):
        if isinstance(value, datetime):
            # normalize naive -> UTC, then emit RFC-3339 with 'Z'
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return handler(value)
```

> **Verify the wildcard serializer signature** (`field_serializer("*", ..., check_fields=False)`) against
> the installed 2.13.x — wildcard field serializers and the `when_used` argument are supported, but the
> exact accepted kwargs evolve; run it once and read the deprecation/signature warnings. Pydantic's
> *default* datetime JSON form is already ISO-8601; you only need this base when you require a **specific**
> normalization (forced UTC, `Z` instead of `+00:00`, microsecond trimming) consistently. If the default
> ISO output is acceptable, **don't add the serializer** — fewer Python callbacks on the dump path.

### 6.5 `computed_field` — derived values in the output

```python
from pydantic import BaseModel, computed_field

class Box(BaseModel):
    width: float
    height: float
    depth: float
    @computed_field
    @property
    def volume(self) -> float:
        return self.width * self.height * self.depth
```

A `@computed_field` `@property` is **included in serialization** (and JSON Schema) but is not an input
field — perfect for derived market metrics on a response (e.g. `mid = (bid+ask)/2`, `spread_bps`). It is
computed on dump, not stored; if the input recurs and the computation is expensive, cache it upstream
rather than recompute per dump.

---

## 7. The number-type decision for a finance data plane

Modeling money/prices is a correctness surface, not a style choice:

| Type | Use when | Caveat |
|---|---|---|
| `int` | counts, sizes, share quantities, epoch millis | exact; never for fractional money |
| `Decimal` + `Field(max_digits, decimal_places)` | **prices, money, anything where 0.1+0.2 must equal 0.3** | exact base-10; JSON-serialized as string by default (good — preserves precision) |
| `float` | already-approximate analytics (returns, ratios, indicators), interop with numpy | **binary float — never for money**; `0.1+0.2 != 0.3` |
| `condecimal`/constrained via `Annotated[Decimal, Field(...)]` | reusable money type | prefer the `Annotated` form over the legacy `condecimal` |

```python
from decimal import Decimal
from typing import Annotated
from pydantic import Field

Price = Annotated[Decimal, Field(max_digits=18, decimal_places=8, ge=0)]
USD   = Annotated[Decimal, Field(max_digits=18, decimal_places=2, ge=0)]
```

> This ties to the line's non-negotiable: a finance number is fetched and grounded, never invented — and
> never silently mangled by float rounding on the way through the model. `Decimal` is the type that keeps
> the grounded number intact end-to-end. Note the **boundary cost**: `Decimal` validation/serialization is
> heavier than `float`; on a bulk OHLC path you do **not** wrap each bar's five `Decimal`s in a model
> (§11) — you carry them in a typed Arrow/columnar buffer and validate the *shape* once.

---

## 8. What `pydantic-core` actually is (the Rust engine) — and why the boundary is the cost

### 8.1 The two-package split

> "Part of the codebase is written in Rust in a separate package called `pydantic-core`" — to "enhance
> validation and serialization performance. The architecture separates concerns into model definition
> (Python/Pydantic) and validation/serialization (Rust/Pydantic-Core)." — architecture docs
> (<https://pydantic.dev/docs/validation/latest/internals/architecture/>)

> "The core validation logic of pydantic V2 will be performed by a separate package `pydantic-core`…"
> — v2 announcement. The rationale: performance; "Better code organization through recursive validator
> trees without stack overhead"; "Type safety and maintainability via Rust's error handling."

`pydantic-core` is built with **PyO3** (Rust↔Python bindings). The repo description: "Core validation
logic for pydantic written in rust" (<https://github.com/pydantic/pydantic-core>). Its README is explicit
that you don't touch it directly: "You should not need to use pydantic-core directly; instead, use
pydantic, which in turn uses pydantic-core."

### 8.2 Core schema → `SchemaValidator` + `SchemaSerializer`

> "The central communication mechanism between packages is the **core schema** — a structured (and
> serializable) Python dictionary … describing a specific validation and serialization logic. Every core
> schema requires a `type` key … Models store this as the `__pydantic_core_schema__` attribute." — arch
> docs. And: "It is not possible to define a custom core schema" — pydantic-core only supports the fixed
> schema types in `pydantic_core.core_schema`.

From that schema, pydantic-core builds:

> - "**SchemaValidator**: Provided data is sent to pydantic-core by using the
>   `SchemaValidator.validate_python` method"
> - "**SchemaSerializer**: The `model` instance is sent to pydantic-core by using the
>   `SchemaSerializer.to_python` method"
> — arch docs.

Internally (per pydantic-core's structure): the `SchemaValidator` owns one **`CombinedValidator`** which
recursively owns more `CombinedValidator`s mirroring the schema tree; `SchemaSerializer` likewise owns a
tree of **`CombinedSerializer`s`**. This is the "recursive validator tree without stack overhead" the
announcement cites — the dispatch happens in Rust, not via Python recursion. The raw pydantic-core API
(you will never call this directly, shown to make the layering concrete) — verbatim from the README:

```python
from pydantic_core import SchemaValidator, ValidationError

v = SchemaValidator(
    {
        "type": "typed-dict",
        "fields": {
            "name": {"type": "typed-dict-field", "schema": {"type": "str"}},
            "age":  {"type": "typed-dict-field", "schema": {"type": "int", "ge": 18}},
            "is_developer": {
                "type": "typed-dict-field",
                "schema": {"type": "default", "schema": {"type": "bool"}, "default": True},
            },
        },
    }
)
```

On every `BaseModel` subclass these compiled objects are reachable as `__pydantic_validator__` and
`__pydantic_serializer__`; the core schema is `__pydantic_core_schema__`. **Schema compilation happens
once at class-definition time** (or lazily with `defer_build=True`), so the per-call cost is *running* the
compiled plan, not building it.

### 8.3 The performance numbers (cited, not rounded)

- v2 announcement (verbatim): "pydantic V2 is between **4x and 50x faster** than pydantic V1.9.1" and
  "pydantic V2 is about **17x faster** than V1 when validating a model containing a range of common
  fields." (<https://pydantic.dev/articles/pydantic-v2>)
- pydantic-core README (verbatim): "Pydantic-core is currently around **17x faster** than pydantic V1."
- Independent benchmark (Samuel Colvin's own test-drive workflow): "**5x speedup** over v1" on a realistic
  end-to-end workflow — "~1.3 million validations in roughly 6 seconds [v2], while the exact same workflow
  in v1 took almost 30 seconds." (<https://github.com/samuelcolvin/pydantic-v2-test-drive>) — *this is the
  honest, end-to-end figure*; the 17×/50× are micro-benchmarks on validation alone.

> **What the numbers actually tell you.** The headline 17×/50× are *per-validation* micro-benchmarks. The
> realistic end-to-end speedup over a whole pipeline is closer to **~5×** (the test-drive figure) because a
> real workflow is not 100% validation. So: v2 made validation cheap, but **not free**, and the residual
> cost is *per crossing of the Python↔Rust boundary*. That single fact drives §11.

---

## 9. `TypeAdapter` — validating non-`BaseModel` types

Source: type_adapter docs (<https://pydantic.dev/docs/validation/latest/concepts/type_adapter/>).

> "You may have types that are not `BaseModel`s that you want to validate data against." — `TypeAdapter`
> gives you `model_validate`-style power over `list[...]`, `dict[...]`, `TypedDict`, dataclasses, and bare
> primitives, **without** declaring a `BaseModel`.

```python
from typing_extensions import TypedDict
from pydantic import TypeAdapter

class User(TypedDict):
    name: str
    id: int

user_list_adapter = TypeAdapter(list[User])
user_list = user_list_adapter.validate_python([{"name": "Fred", "id": "3"}])
# [{'name': 'Fred', 'id': 3}]   ← '3' coerced to int
```

Methods mirror `BaseModel`: `validate_python`, `validate_json`, `dump_python`, **`dump_json` (returns
`bytes`, not `str`)**, `json_schema`.

### 9.1 The reuse rule (this is a real cost)

> "Schema building carries **non-trivial overhead**, so reuse adapter instances across loops or
> performance-critical sections rather than recreating them repeatedly." — type_adapter docs.

Performance docs make it a named anti-pattern (verbatim):

```python
# Bad — rebuilds the validator every call
def my_func():
    adapter = TypeAdapter(list[int])

# Good — build once, at module scope
adapter = TypeAdapter(list[int])
def my_func():
    ...  # use the module-level adapter
```

**Build every `TypeAdapter` at module scope (or cache it), never inside a request handler.** A
`TypeAdapter(list[BarRow])` rebuilt per request pays the full schema-compilation cost on every call — a
silent latency tax that won't show up in a 1-row test and will dominate at load.

### 9.2 When `TypeAdapter` beats a `BaseModel`

For "a list of N records" the natural shape is `TypeAdapter(list[Row])` (or `list[TypedDict]`), not a
wrapper `BaseModel` with a single `items: list[Row]` field — it skips the outer-model overhead.
Crucially, a `TypedDict` row is **~2.5× faster than a nested `BaseModel`** (perf docs: "With a simple
benchmark, `TypedDict` is about ~2.5x faster than nested models"), because it produces a plain `dict`
instead of constructing a model instance. For internal, list-shaped data, `TypeAdapter(list[TypedDict])`
is frequently the right call.

### 9.3 `defer_build` — for forward refs / import-time cost

`TypeAdapter(SomeType, config=ConfigDict(defer_build=True))` (and `.rebuild()` when refs resolve) avoids
building the schema until first use — useful for forward references or to keep import time low. The same
`defer_build` exists on `ConfigDict` for models.

---

## 10. The shared-base-model pattern for this service (putting it together)

A market-data service has three model *families* with different posture; give each a base.

```python
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Any
from pydantic import BaseModel, ConfigDict, Field, field_serializer
from pydantic.alias_generators import to_camel

# ---- reusable domain types -------------------------------------------------
Symbol = Annotated[str, Field(min_length=1, max_length=32, pattern=r"^[A-Z0-9.\-:]+$")]
Price  = Annotated[Decimal, Field(max_digits=18, decimal_places=8, ge=0)]

# ---- 1. inbound request models: closed contract, lax coercion at the edge --
class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

# ---- 2. outbound response models: camelCase wire, forced-UTC timestamps ----
class ResponseModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        serialize_by_alias=True,     # always emit camelCase
        validate_by_name=True,       # but our own code may build with snake_case
        extra="forbid",
    )
    @field_serializer("*", mode="wrap", when_used="json", check_fields=False)
    def _utc(self, value: Any, handler):
        if isinstance(value, datetime):
            v = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
            return v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return handler(value)

# ---- 3. trusted internal DTOs: strict types, reconstructed via construct ---
class InternalDTO(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

# ---- concrete models -------------------------------------------------------
class BarsRequest(RequestModel):
    symbol: Symbol
    interval: str = "1d"
    start: datetime
    end: datetime
    limit: int = Field(default=1000, gt=0, le=50_000)

class Bar(ResponseModel):
    ts: datetime
    open: Price
    high: Price
    low: Price
    close: Price
    volume: int
```

Why this shape:
- **Request edge** is lax-coercing (`?limit=1000` string → int) but **closed** (`extra='forbid'` 422s a
  typo) — and `limit`'s `le=50_000` is a declarative scale guard.
- **Response edge** speaks camelCase to the world while your code stays snake_case, with one canonical UTC
  timestamp format — set once on the base, inherited everywhere.
- **Internal DTOs** are strict (a provider sending a stringified price is a bug you want surfaced) and are
  reconstructed via `model_construct` when round-tripping already-validated data (§3.3).

---

## 11. The per-row-Pydantic-on-bulk anti-pattern (the most important section)

> **Owned elsewhere; flagged here.** The *fix* — Arrow/columnar batch decoding — is owned by the
> `columnar-parquet-arrow` reference. This section's job is to make the **failure mode unmissable** and to
> mark the exact line where `model_construct` is the right escape hatch and where it is not.

### 11.1 The anti-pattern

```python
# ANTI-PATTERN: one Pydantic model per market-data row
rows = fetch_bars(symbol, start, end)          # e.g. 1_000_000 dict rows
bars = [Bar.model_validate(r) for r in rows]   # 1,000,000 Python↔Rust crossings
payload = [b.model_dump() for b in bars]        # 1,000,000 MORE crossings
```

Each `model_validate` is a call into Rust **and back**, allocating a Python model object per row; each
`model_dump` is another. At 1M rows that is **~2M boundary crossings + 1M object allocations + 1M GC-able
instances** per request. The validator being 17× faster than v1 does not save you — you've multiplied a
fast operation by a million. This is the canonical way a "Pydantic is fast" assumption ships as a Tier-1
implementation that dies at Tier-2.

**The tell:** a list comprehension `[Model.model_validate(r) for r in big_iterable]`, or
`for r in rows: Model(**r)`, anywhere the row count scales with the data, not with the request count.

### 11.2 Why it doesn't scale — the arithmetic

Take a generous 1µs per `model_validate` of a small flat `Bar` (Rust is fast, but a per-instance
crossing + allocation is not free; measured per-instance costs for small models are typically low-µs).
1,000,000 rows × 1µs = **1 s just in validation**, plus another ~1 s in `model_dump`, plus the GC pressure
of 1M short-lived objects — before any I/O. Run that on a serverless/HTTP request and you've blown the
budget on plumbing. The columnar path validates the **shape once** and moves the bytes in bulk; its cost
is ~O(1) in model-crossings regardless of row count.

| Surface | Per-row model | Columnar (Arrow) |
|---|---|---|
| Python↔Rust crossings | O(rows) | O(1) |
| Python object allocations | O(rows) | O(0) (buffers, not objects) |
| GC pressure | high | negligible |
| Tier it survives | 1× (demo) | 100× / 10,000× |

### 11.3 The boundary rule (commit this)

- **Pydantic models are for boundaries, not for bulk.** Validate the **request/response envelope** with a
  model (one model, once). For the **payload of N rows**, do **not** wrap each row in a model on a path
  where N scales — carry the rows in a columnar buffer (Arrow/Parquet) and serialize the buffer directly.
- A `BaseModel` field can *type* a bulk payload (`bars: list[Bar]`) for the OpenAPI schema **without** you
  ever actually running per-row validation on the hot path — validate the envelope, attach the
  already-serialized buffer to the response, and let the model document the shape. (See
  `columnar-parquet-arrow` for the exact handoff.)

### 11.4 Where `model_construct` is the right escape hatch — and where it isn't

`model_construct` is the **in-process** escape hatch when you are *forced* to produce typed model instances
from **already-trusted** data and cannot avoid the model entirely:

```python
# Trusted, already-validated rows (e.g. replayed from a buffer YOU wrote):
bars = [Bar.model_construct(**r) for r in trusted_rows]   # skips re-validation
```

But heed the §3.3 caveat: on a **simple flat model `model_construct` can be SLOWER than
`model_validate`**, and it *still* allocates one Python object per row and crosses the boundary per
construct — so it shrinks the validation cost but **not** the O(rows) crossing/allocation cost. Therefore:

- **Right** for `model_construct`: a **bounded** list of trusted, nested/expensive models you must hand to
  a typed downstream — profile, and only if it wins.
- **Wrong** for `model_construct`: a **million** rows. It does not fix the boundary problem; it only skips
  validation. The fix at that scale is **not** a faster way to make a million model objects — it is to
  make **zero** model objects and move columns (→ `columnar-parquet-arrow`).

> **The one-line rule:** `model_validate` at untrusted boundaries · `model_construct` for bounded trusted
> reconstruction (profiled) · **neither, per row, at scale** — go columnar.

---

## 12. Anti-patterns quick table

| Anti-pattern | Why it hurts | Fix |
|---|---|---|
| `model_validate(json.loads(raw))` | parses in Python, builds a dict, then re-walks it | `model_validate_json(raw)` — one Rust pass |
| `json.dumps(m.model_dump())` for a response | two passes + intermediate dict | `m.model_dump_json()` — one Rust pass |
| `TypeAdapter(T)` built inside a handler/loop | re-compiles the schema every call | build at module scope once |
| `[Model.model_validate(r) for r in million_rows]` | O(rows) boundary crossings + allocations | columnar/Arrow batch (§11) |
| `model_construct` to "speed up" a simple flat model | can be **slower** than validating in v2 | profile; only nested/expensive + trusted |
| `model_construct` on untrusted input | lets garbage through; `extra='forbid'` doesn't even raise | `model_validate` at any untrusted edge |
| `float` for prices/money | binary rounding (`0.1+0.2 != 0.3`) | `Decimal` + `Field(max_digits, decimal_places)` |
| `wrap` validator on a hot/bulk field | "require data materialization in Python" (slow) | `after` validator, or no validator |
| `Optional[int]` expecting it to be optional | it's required-but-nullable; omission errors | `Optional[int] = None` |
| `populate_by_name=True` in new code | pending deprecation in V3 | `validate_by_name=True` |
| `assert` for real validation | stripped under `python -O` | `raise ValueError(...)` / `PydanticCustomError` |
| `extra='ignore'` (default) on a request model | silently swallows a client's typo'd field | `extra='forbid'` on request models |
| `validate_assignment=True` on a hot internal DTO | re-validates on every attribute set | leave default `False`; validate once |

---

## 13. Output contract — what "done" looks like for a Pydantic-modeled surface

A modeled surface in this service is correct when:

1. **Boundary models exist and are closed.** Every request body is a `BaseModel` with `extra='forbid'`;
   every response is a `BaseModel` (typed for OpenAPI). Constraints (`gt`/`le`/`max_length`/`pattern`)
   express the input guards declaratively, including a hard `limit` cap on any list surface.
2. **The JSON fast paths are used.** JSON in → `model_validate_json`; JSON out → `model_dump_json`. No
   `model_validate(json.loads(...))`, no `json.dumps(model_dump())`.
3. **Numbers are the right type.** Money/prices are `Decimal` with `max_digits`/`decimal_places`; counts
   are `int`; `float` only for already-approximate analytics. No invented or float-mangled finance number.
4. **Aliasing is declared, not hand-coded.** snake_case fields + `alias`/`AliasChoices`/`alias_generator`
   for the wire; `validate_by_name=True` (never `populate_by_name`) where both names must be accepted.
5. **Validators are minimal and mostly `after`-mode.** Cross-field rules in a `model_validator(mode=
   'after')` returning `self`. No `wrap` validator on a bulk field. `assert` is never load-bearing.
6. **`TypeAdapter`s are module-scoped**, never rebuilt per call.
7. **The bulk path crosses the Rust boundary O(1), not O(rows).** No `[Model.model_validate(r) for r in
   big]`. `model_construct` is used only for bounded, trusted reconstruction *and only where profiling
   shows a win*; at row-scale the answer is columnar (→ `columnar-parquet-arrow`), not a faster way to make
   a million models.
8. **The tier is stated.** Each modeled surface says which load tier it survives and what breaks next — a
   per-row-model response is explicitly marked Tier-1 and routed to the columnar path before it ships as
   production.

---

## 14. Sources (read these first, in this order)

Primary (pydantic official docs — the redirect target host is `pydantic.dev/docs/validation/latest/…`):
- Models — <https://pydantic.dev/docs/validation/latest/concepts/models/> (`model_construct`,
  `model_validate*`, `model_dump*`, `model_copy`, nested models)
- Fields — <https://pydantic.dev/docs/validation/latest/concepts/fields/> (`Field` constraints,
  `default_factory`, `Annotated`, `computed_field`)
- Validators — <https://pydantic.dev/docs/validation/latest/concepts/validators/> (modes, `ValidationInfo`,
  ordering, `PydanticCustomError`)
- Serialization — <https://pydantic.dev/docs/validation/latest/concepts/serialization/> (`model_dump*`
  params, `field_serializer`/`model_serializer`, `mode='python'` vs `'json'`)
- Alias — <https://pydantic.dev/docs/validation/latest/concepts/alias/> (`AliasChoices`/`AliasPath`/
  `AliasGenerator`, `validate_by_name`/`validate_by_alias`, `populate_by_name` deprecation)
- Performance — <https://pydantic.dev/docs/validation/latest/concepts/performance/> (`model_validate_json`,
  `TypeAdapter` reuse, TypedDict-vs-model 2.5×, wrap-validator cost, tagged unions, `FailFast`)
- Type Adapter — <https://pydantic.dev/docs/validation/latest/concepts/type_adapter/>
- **Internals / Architecture** — <https://pydantic.dev/docs/validation/latest/internals/architecture/>
  (core schema, `SchemaValidator`/`SchemaSerializer`, `__pydantic_core_schema__`)
- Config API — <https://pydantic.dev/docs/validation/latest/api/config/> (`ConfigDict` options)

Engine & performance evidence:
- Pydantic v2 announcement — <https://pydantic.dev/articles/pydantic-v2> ("4x and 50x", "17x", strict/lax,
  "parse JSON directly into a model")
- `pydantic-core` repo — <https://github.com/pydantic/pydantic-core> (archived 2026-04-11; "Core
  validation logic for pydantic written in rust"; PyO3; the `SchemaValidator` README example; code now in
  the main repo at `github.com/pydantic/pydantic/tree/main/pydantic-core`)
- End-to-end benchmark — <https://github.com/samuelcolvin/pydantic-v2-test-drive> (~5× on a real workflow;
  "~1.3 million validations in roughly 6 seconds [v2] … almost 30 seconds [v1]")

Version pin:
- PyPI — <https://pypi.org/project/pydantic/> (2.13.4, 2026-05-06, Python ≥3.9)

> **Verify before relying on an exact signature:** `python -c "import pydantic, pydantic_core;
> print(pydantic.VERSION, pydantic_core.__version__)"`. The wildcard `field_serializer('*', ...)` kwargs,
> `exclude_if`, and the `validate_by_name`/`populate_by_name` deprecation status are the items most likely
> to have shifted between 2.11 and the installed 2.13.x — read the runtime deprecation warnings.
