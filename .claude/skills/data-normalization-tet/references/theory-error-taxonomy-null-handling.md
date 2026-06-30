# Theory — Error Taxonomy & Null-Handling on the Normalization Write Path

> **Skill:** `data-normalization-tet` · **Product line:** JPM-Markets re-engineering **data-analytics
> service** (re-engineers DataQuery + Fusion). **NOT Lumina.** Separate Python/FastAPI data plane on the
> stack pinned in [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md).
> **Generic + reusable** (`theory-*`): the design vocabulary for *what the pipeline does when data is
> missing, empty, partial, or the fetch fails*. The concrete code recipe lives in the sibling
> `patterns-*` references; this doc is the model those recipes implement.

---

## 0. The one-sentence thesis

**An absence is a value.** A fetch that returns no rows, a credential that is missing, a 200 with an
empty body, a 204 No Content, a single bad symbol inside a five-symbol batch — each is a *distinct,
typed outcome* that the write path must **name**, **carry**, and **act on differently**. The failure
this whole document exists to prevent is the silent collapse of all of these into one indistinct
"empty result" that the next layer fills with a zero, a `0.0`, a stale row re-stamped as fresh, or a
fabricated number to "look complete."

This is the write-path enforcement of the product line's **#1 non-negotiable** — *never invent a
finance number* — inherited verbatim from the host repo's
[`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md):

> *"Failed/over-budget fetches return typed `unavailable`/`needsKey` — never a fabricated value, never a
> RED-tier backfill to 'look complete.'"* — `.claude/rules/commercial-ok-gate.md:28`

and from `CLAUDE.md` non-negotiable #1:

> *"Never invent a finance number (price/level/stat). Tools fetch; the model grounds. Failed tools
> return typed `unavailable`/`needsKey`, never fabricated data."* — `CLAUDE.md`

The rest of this doc is the *mechanism* that makes those two sentences true on a Python normalization
write path. We adopt the **OpenBB error model** as the design source — it is the most battle-tested
public articulation of exactly this problem — and we reimplement it **clean-room** (OpenBB is
AGPL-3.0-only; we reuse the *pattern*, never the *code* — see §11 and the licensing trap in
[`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md) §"Licensing traps", item 1).

---

## 1. Why this is the hardest part of normalization (first principles)

A normalization pipeline has two jobs. Job one — *make the shapes match* (Polygon's `symbol`, Intrinio's
`stocksTicker`, FMP's `symbol` all become one field) — is the visible work and the easy work. Job two —
*decide what a non-answer means* — is the invisible work and the one that breaks production silently.

The asymmetry is brutal:

- A **wrong shape** fails loud. A field that should be a float and arrives as `"N/A"` throws a validation
  error the moment Pydantic touches it. You find it in development, on the first run, in the stack trace.
- A **wrong absence** fails quiet. A series that should have 252 trading days but arrives with 0 rows,
  silently zero-filled to `[0.0, 0.0, …]`, validates perfectly, persists perfectly, serves perfectly,
  and renders a chart that is *wrong but plausible*. Nobody notices until a quant trades on a 0.0 price
  that is not a price — it is the *absence* of a price wearing a price's clothes.

The OpenBB blog that names the TET pattern (Transform-Extract-Transform) states the standardization goal
as making *"Numbers are numbers, dates are dates, and strings are strings"* and *"NaN, empty strings, and
the various string representations of None are converted to null"*
([openbb.co/blog/the-openbb-platform-data-pipeline](https://openbb.co/blog/the-openbb-platform-data-pipeline)).
That last clause is the entire subject of this document: **the disciplined conversion of every flavor of
absence into a single, honest, typed null — and the refusal to let an absence ever become a zero.**

A finance product carries a unique multiplier on this risk: **a zero is a legal number in this domain.**
A price can be (almost) zero. A change can be exactly zero. A volume can be zero on a halted day. So you
cannot use `0` as a sentinel for "missing" the way a naive pipeline in another domain might — the moment
you do, you have made "missing" and "genuinely zero" indistinguishable, and a quant's `if price == 0`
guard now fires on *both* a delisted instrument *and* a penny stock. The only safe sentinel for "missing"
is a type that is **not** in the number's value domain: `None` / `null` / `NaN`-as-explicitly-marked —
never `0`.

---

## 2. The typed-outcome taxonomy (the core model)

Every fetch on the write path resolves to **exactly one** of the following typed outcomes. This is the
contract. The worker's job (§8) is to translate each into a *persistence action*; the model's job is to
never produce anything outside this set.

| Outcome | Meaning | Triggered by | Worker action |
|---|---|---|---|
| `Ok(rows)` | success, ≥1 valid row | provider returned data that passed validation | upsert the rows (idempotent, §10) |
| `EmptyData` | success, **zero** rows | 204; 200 with `[]`/`{}`; query parameters legitimately match nothing | **ground-or-skip**: do NOT write; the stored series (if any) continues to serve stale (§8) |
| `Unavailable` | fetch **failed** or over budget | network error, 5xx, timeout, rate-limit, circuit-open, budget exhausted | do NOT write; stored series serves stale; surface typed `unavailable` |
| `NeedsKey` | credential **missing/invalid** | no API key configured; 401/403/`UnauthorizedError` | do NOT write; surface typed `needsKey`; do **not** retry blindly |
| `PartialBatch` | mixed: some symbols `Ok`, some `Unavailable`/`EmptyData` | a multi-symbol request where ≥1 but not all members resolved | write the good members; type the bad ones individually; **never backfill** the missing ones (§7) |

Two of these — `EmptyData` and `Unavailable` — look identical from a careless caller's seat (both produce
"no new rows"). They are **not** the same thing, and conflating them is the most common bug this taxonomy
prevents:

- `EmptyData` is a **truthful negative**: *"I asked correctly; the answer is genuinely nothing."* The 10Y
  Treasury yield for a date before the series began is `EmptyData`. The right reaction is *accept it as a
  fact*, do not retry, do not alarm.
- `Unavailable` is a **failure to learn**: *"I could not get an answer."* The right reaction is *serve
  the last known good, retry on the next cron, and alert if it persists.* Treating an `Unavailable` as
  `EmptyData` would let a multi-day provider outage masquerade as "the data genuinely stopped existing"
  — and a downstream consumer that reacts to "series ended" (closes a position, drops a panel) acts on a
  network blip. The reverse — treating `EmptyData` as `Unavailable` — spins retries forever against a
  query that will *always* legitimately return nothing.

These map onto a small, honest exception hierarchy reimplemented from OpenBB's (§3), and onto a result
envelope the worker consumes (§8, §9).

---

## 3. The OpenBB error model — read it, then reimplement it

OpenBB ships the canonical version of this taxonomy. We study it, quote it, and **reimplement** it (the
AGPL trap, §11). Here is the actual upstream source, fetched verbatim, as the reference shape.

### 3.1 `OpenBBError` — the base

```python
# openbb_platform/core/openbb_core/app/model/abstract/error.py
# (verbatim, OpenBB develop branch — github.com/OpenBB-finance/OpenBB)
"""OpenBB Error."""


class OpenBBError(Exception):
    """OpenBB Error."""

    def __init__(self, original: str | Exception | None = None):
        """Initialize the OpenBBError."""
        self.original = original
        super().__init__(str(original))
```

Two design facts worth internalizing:

1. It accepts an **`Exception`** as well as a string. That is the *wrapping* idiom — a low-level provider
   exception (an `httpx.HTTPStatusError`, a `KeyError` on a missing JSON field) is caught and **re-raised
   as a typed `OpenBBError` (or subclass) carrying the original** in `self.original`. The taxonomy is a
   *façade*: arbitrary upstream chaos enters; a small, named set of typed errors exits.
2. It is the **single base** every handled error inherits. Catching `OpenBBError` (our equivalent) at the
   worker boundary catches the *whole* handled taxonomy with one `except`, while letting genuinely
   *unhandled* exceptions (a bug in our code) propagate loud — which is exactly what you want: a typed
   `EmptyData` is "data said nothing"; an unhandled `AttributeError` is "our code is broken," and those
   must never be confused.

### 3.2 `EmptyDataError` and `UnauthorizedError` — the typed leaves

```python
# openbb_platform/core/openbb_core/provider/utils/errors.py
# (verbatim, OpenBB develop branch — github.com/OpenBB-finance/OpenBB)
"""Custom exceptions for the provider."""

from openbb_core.app.model.abstract.error import OpenBBError


class EmptyDataError(OpenBBError):
    """Exception raised for empty data."""

    def __init__(
        self, message: str = "No results found. Try adjusting the query parameters."
    ):
        """Initialize the exception."""
        self.message = message
        super().__init__(self.message)


class UnauthorizedError(OpenBBError):
    """Exception raised for an unauthorized provider request response."""

    def __init__(
        self,
        message: str | tuple[str] = (
            "Unauthorized <provider name> API request."
            " Please check your <provider name> credentials and subscription access.",
        ),
        provider_name: str = "<provider name>",
    ):
        """Initialize the exception."""
        if provider_name and provider_name != "<provider name>":
            msg = message
            if isinstance(msg, tuple):
                msg = msg[0].replace("<provider name>", provider_name)
            elif isinstance(msg, str):
                msg = msg.replace("<provider name>", provider_name)
            message = msg
        self.message = message
        super().__init__(str(self.message))
```

Note the shape, because we copy the *shape* (not the bytes):

- `EmptyDataError` carries a **human-readable default message** that *names the likely cause*: *"No
  results found. Try adjusting the query parameters."* The message is itself part of the contract — an
  empty-data outcome that surfaces to a developer should tell them *it might be their parameters, not a
  bug.*
- `UnauthorizedError` **templates the provider name into the message at raise time** (`<provider name>` →
  the real provider). The credential-missing outcome must be *actionable*: "check your **FMP**
  credentials," not a generic 403.

### 3.3 The HTTP-status mapping — and why it matters to us even without HTTP

OpenBB's docs map each typed error to an HTTP status when the platform is run as an API
([docs.openbb.co/odp/python/faqs/errors](https://docs.openbb.co/odp/python/faqs/errors)):

| Typed error | HTTP status (OpenBB) | Verbatim doc gloss |
|---|---|---|
| `OpenBBError` | **422** Unprocessable Entity | *"This error is raised for handled exceptions. An abbreviated traceback message will display…"* |
| `EmptyDataError` | **204** No Content | *"Also a 204 status code from the API. It means that the data was returned empty but the operation was a success."* |
| `UnauthorizedError` | **502** (provider creds bad) | "Occurs when provider credentials are invalid or subscription is insufficient" |
| `UnexpectedError` | **500** | unhandled; enable `OPENBB_DEBUG_MODE` |

The mapping is instructive even though our v1 write path raises these *in-process* (the worker catches
the exception directly; there's no HTTP hop between fetch and persist). Two reasons it still matters:

1. Our **read** path *is* an HTTP API (the TS gateway). When the gateway asks the data plane for a series
   and the data plane has nothing, the data plane must answer with the *right* status — and OpenBB's
   table is the proven mapping. A genuinely-empty series is **204**, *not* 200-with-`[]` (see §4) and
   *not* 404 (404 means "no such series exists in the catalog," a different, catalog-level fact).
2. The **422 vs 204** split is the API-surface restatement of the **`Unavailable` vs `EmptyData`** split
   from §2. 422 = "I couldn't process this" (a failure); 204 = "I processed it; the answer is nothing" (a
   truthful negative). Same distinction, two layers.

---

## 4. The 204 trap — the silent disappearance (this is the load-bearing section)

This is the single most important paragraph in the document, so it gets its own section.

OpenBB's own docs say the quiet part out loud
([docs.openbb.co/odp/python/faqs/errors](https://docs.openbb.co/odp/python/faqs/errors)):

> **Empty Data Error** is *"Also a 204 status code from the API. It means that the data was returned
> empty but the operation was a success."*

And the harder warning, from the same FAQ — the reason a 204 is dangerous in an API context — is that a
**204 No Content has no message body**. By the HTTP spec, a 204 response *carries no payload*. So when an
`EmptyDataError` is converted to a 204 on the wire, **its carefully-worded message ("No results found.
Try adjusting the query parameters.") is gone** — the body is empty by definition. A client that only
checks `response.json()` sees nothing; a client that doesn't check the status code at all sees a
falsy/empty value and, if it's careless, treats it as `[]` and moves on. The signal *silently
disappears*. This is precisely why OpenBB's own developers concluded it is **better to raise a typed
`OpenBBError`-style exception than to let an `EmptyDataError` collapse into a bare 204** — the typed
exception *cannot* be silently swallowed; it has to be caught and named.

There is a second, nastier variant the same FAQ flags: **a 200 with an empty body.**

> *"Some sources will return bad requests with a 200 status code and no message."* —
> [docs.openbb.co/odp/python/faqs/errors](https://docs.openbb.co/odp/python/faqs/errors)

So in the wild, "no data" arrives in at least three disguises, and a naive `if response.ok:` check
catches **none** of them:

| On the wire | `response.ok`? | `.json()` | The trap |
|---|---|---|---|
| `204 No Content`, empty body | `True` (2xx) | raises / `None` | success status, no body → looks like "fine, nothing to do" |
| `200 OK`, body `[]` or `{}` | `True` | `[]` / `{}` | genuinely empty *or* a provider's way of signaling a bad request |
| `200 OK`, body `{"data": null}` | `True` | `{"data": None}` | the "string representations of None" the TET stage must catch |

**The rule that falls out of this:** the write path **must not** treat `response.ok` (or `2xx`) as "I got
data." It must inspect the *parsed result* and decide `Ok` vs `EmptyData` *explicitly*, then **model
`EmptyData` as a typed signal, not a swallowed empty.** Concretely, in the `transform_data` stage
(§5–6), an empty parsed result is converted into a `raise EmptyDataError(...)` — turning the invisible
204/empty-body into a loud, named, un-swallowable signal that the worker (§8) then maps to ground-or-skip.

A bare `return []` from `transform_data` is the bug; `raise EmptyDataError(...)` is the fix. The `return
[]` flows downstream as "here are zero rows" — indistinguishable from a successful query that legitimately
has zero rows *and* from a list a later step might pad. The `raise` is a *control-flow event* that *forces*
a handler. **Make the absence un-ignorable.**

---

## 5. The TET pipeline and where each error lives

The product line's normalization is the OpenBB **TET (Transform-Extract-Transform)** `Fetcher[Q, R]`
pattern, reimplemented clean-room for our *write* path (OpenBB validates and returns; we validate, resolve
the security master, **and persist** — see [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md), the
`openbb-tet-normalization` skill row). The blog defines the three stages
([openbb.co/blog/the-openbb-platform-data-pipeline](https://openbb.co/blog/the-openbb-platform-data-pipeline)):

> *"Transform the query. Extract the data. Transform the data."*

Each stage owns a different slice of the error taxonomy. Knowing **which stage raises which error** is how
you keep the taxonomy clean instead of scattering `try/except` everywhere.

| Stage | What it does | Errors it raises |
|---|---|---|
| **`transform_query`** | provider params → standard params (validation of *inputs*) | input/validation `OpenBBError` (a 422-class fault: the *request* was malformed). **Never** `EmptyData` — there's no data yet. |
| **`extract_data`** | hit the upstream; return raw, *unprocessed* response | `Unavailable` (network/5xx/timeout/budget), `NeedsKey`/`UnauthorizedError` (401/403). The blog: extract returns data *"as-is"* so you can *"isolate whether failures stem from data requests or data quality issues"* — i.e. extract owns **transport** failures, not **emptiness**. |
| **`transform_data`** | raw → validated standard models (`Pydantic.model_validate`) | **`EmptyDataError`** (the parsed result is empty → §4), and per-field null normalization (§6). This is where "200-but-empty" becomes a typed signal. |

The clean separation has a real payoff named in the blog: because `extract_data` returns raw data
untouched, *"developers can isolate whether failures stem from data requests or data quality issues."*
Transport failure (couldn't reach the provider) and emptiness (reached it; it had nothing) are diagnosed
in **different stages**, so they never get conflated into one ambiguous "it didn't work."

### 5.1 The canonical `transform_data` empty-guard (real upstream code)

This is the FMP equity-historical model's `transform_data`, fetched verbatim — the **exact pattern** we
reimplement:

```python
# openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py
# (verbatim, OpenBB develop branch)
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

The whole §4 argument compressed into two lines: **`if not data: raise EmptyDataError(...)`** *before*
the validation loop. The empty case is intercepted and typed *first*; only a non-empty list reaches
`model_validate`. The message names the provider, so the surfaced error is actionable.

---

## 6. Per-field null policy — `None` vs `0` vs `NaN`, and never zero-fill a price

Section 4 handled the *whole-result-empty* case. This section handles the *row-exists-but-a-field-is-
missing* case — the per-field policy that runs inside `model_validate` / your Pydantic field validators.

### 6.1 The three sentinels and what each legitimately means

| Sentinel | Means | Legitimate use | The trap |
|---|---|---|---|
| `None` / `null` | **the value is absent / unknown** | a field the provider didn't return; a not-yet-traded instrument's open | the ONLY honest "missing" marker |
| `0` / `0.0` | **the value is genuinely zero** | a 0% change on a flat day; 0 volume on a halt; a price that is actually ~0 | NEVER as a stand-in for missing |
| `NaN` (float) | **not-a-number** — usually a *computed* gap | a returns calc dividing by a zero prior; an explicitly-marked data gap | ambiguous on the wire; normalize to `null` for storage/JSON |

The TET standardization rule, verbatim, is the field-level law:

> *"NaN, empty strings, and the various string representations of None are converted to null."* —
> [openbb.co/blog/the-openbb-platform-data-pipeline](https://openbb.co/blog/the-openbb-platform-data-pipeline)

So at the field level, every disguise of absence — `NaN`, `""`, `"N/A"`, `"None"`, `"null"`, `"-"` — is
**normalized to one canonical `None`/`null`** before storage. One missing-marker, not six. That is what
makes a stored series queryable: a consumer's `WHERE close IS NOT NULL` works only if every provider's
idiosyncratic "missing" was first folded into a real SQL `NULL`.

### 6.2 The cardinal rule: **never zero-fill a price (or any level/stat)**

This is the field-level restatement of non-negotiable #1. **A missing price is `None`, never `0`.** The
reasons, stacked:

1. **`0` is a valid price.** As established in §1, you cannot use `0` as "missing" without making
   genuinely-zero and missing indistinguishable. (A near-zero penny stock, a zero-rate environment, a
   zero-volume halt are all *real* zeros.)
2. **A zero-filled price corrupts every downstream computation.** A return series computed across a
   zero-filled gap produces a `-100%` then `+∞%` spike that is pure fiction. A moving average pulled
   toward zero. A min() that returns 0 forever. A chart with a cliff to the axis. The zero doesn't stay
   put — it propagates.
3. **A zero-filled price is a *fabricated number*** — the exact thing non-negotiable #1 forbids. The
   model didn't *fetch* a `0`; the pipeline *invented* one to fill a hole. That is fabrication with a
   friendly face, and it is a CRITICAL by the product line's standard.

The contract, stated as code-shaped rules for the standard model:

```python
# Standard model fields that are NUMBERS-THAT-CAN-BE-ABSENT are Optional, never zero-defaulted.
class EquityHistoricalData(BaseModel):
    date: date                      # required — a row without a date is not a row
    open:  float | None = None      # NOT  `open: float = 0.0`   ← that would fabricate
    high:  float | None = None
    low:   float | None = None
    close: float | None = None
    volume: int | None = None       # NOT `volume: int = 0`  ← 0 volume ≠ missing volume

    @field_validator("open", "high", "low", "close", "volume", mode="before")
    @classmethod
    def absence_to_none(cls, v):
        # Fold every disguise of absence into one canonical None.
        if v is None:
            return None
        if isinstance(v, float) and math.isnan(v):
            return None
        if isinstance(v, str) and v.strip() in {"", "N/A", "None", "null", "-", "nan"}:
            return None
        return v
```

What this validator does **not** do is supply a default. There is no `= 0.0`, no `or 0`, no
`fillna(0)`. The absence stays an absence all the way to storage, where it becomes a SQL `NULL`, where a
chart renders it as a **gap** (the honest depiction) rather than a **dip to zero** (the lie).

> **Gapfill is a read-side, explicitly-requested transform — never a write-side default.** The
> `timescaledb-timeseries` skill covers `time_bucket_gapfill` / `locf` / `interpolate`. Those are
> opt-in, on the *read* path, *labeled* as interpolated. The *write* path stores the true `NULL`. Never
> interpolate on ingest; never let "make the chart pretty" leak a fabricated value into the store of
> record.

### 6.3 What about required fields that arrive missing?

A `None` is honest for an *optional* field. But some fields are *structurally required* — a row with no
`date` is not a row; a price observation with no `symbol` cannot be placed in the security master. When a
**required** field is absent, the row is **not** zero-filled and **not** silently dropped — it is a
**data-quality fault** on that row. The choices, in order of preference:

1. **Drop the row, count the drop, log it.** If 2 of 252 rows lack a date, emit the 250, record
   `dropped=2` in the run's metadata/PROV stamp. Silent dropping is forbidden; *counted* dropping is
   correct — the count is itself a quality signal you can alert on.
2. If **every** row is malformed → the parsed result is effectively empty → `raise EmptyDataError` (§4),
   not a partial write of garbage.

Never the third option: invent the missing required field. A row whose `date` you *guessed* is a
fabricated observation.

---

## 7. Partial-batch failure — some symbols ok, some not

Multi-symbol requests ("quote AAPL, MSFT, NVDA, BADTICKER, TSLA") are the case where the taxonomy earns
its keep, because the result is *neither* fully-ok *nor* fully-failed. OpenBB's yfinance equity-quote
model shows the canonical handling, fetched verbatim in behavior:

```python
# openbb_platform/providers/yfinance/openbb_yfinance/models/equity_quote.py (behavior, verbatim)
# extract_data:
symbols = [s.strip() for s in query.symbol.split(",") if s.strip()]

async def get_one(symbol):
    try:
        ... # fetch this one symbol's quote
        results.append(extracted)
    except Exception as e:
        warn(f"Error getting data for {symbol}: {e}")   # warn, do NOT raise — continue

await asyncio.gather(*(get_one(symbol) for symbol in symbols))
# returns whatever succeeded: 3 of 5 ok → those 3; all fail → []  (then transform_data's
# `if not data: raise EmptyDataError` converts the all-fail case to the typed empty signal)
```

The three load-bearing behaviors:

1. **Per-member isolation.** Each symbol is fetched independently; one symbol's failure is caught *inside*
   its own `get_one` and converted to a **warning**, not a raise. One bad ticker does **not** sink the
   four good ones. (`asyncio.gather` would, by default, propagate the first exception and cancel the rest
   — so the per-member `try/except` *inside* `get_one` is essential. The alternative,
   `gather(..., return_exceptions=True)`, also works and is sometimes cleaner; the point is the same:
   isolate per member.)
2. **Emit the good, type the bad.** The succeeded members flow on as `Ok` rows. The failed members are
   *recorded* (the warning; in our system, a typed per-member outcome — see below) — never silently
   vanished, never backfilled.
3. **All-fail collapses to `EmptyData`.** If *every* member fails, `extract_data` returns `[]`, and
   `transform_data`'s `if not data: raise EmptyDataError` (§5.1) turns the whole batch into one honest
   `EmptyData`. A batch where everything failed is empty, by definition.

### 7.1 Our divergence: type the bad members, don't just warn

OpenBB *warns* on a failed batch member (it's a library; a warning to the console is its surface). **Our
write path must do better than a warning** — a warning evaporates; the worker needs to *act*
differently per member. So our partial-batch result is a **structured envelope**, not a flat list:

```python
@dataclass
class MemberOutcome:
    symbol: str
    status: Literal["ok", "empty", "unavailable", "needs_key"]
    rows: list[StandardData] | None = None     # populated only when status == "ok"
    detail: str | None = None                  # the reason, for empty/unavailable/needs_key

@dataclass
class BatchResult:
    members: list[MemberOutcome]

    @property
    def ok_rows(self) -> list[StandardData]:
        return [r for m in self.members if m.status == "ok" for r in (m.rows or [])]

    @property
    def is_total_failure(self) -> bool:
        return all(m.status != "ok" for m in self.members)
```

The worker then persists `batch.ok_rows`, and for each non-ok member it does the *member-appropriate*
thing: an `unavailable` member leaves that symbol's stored series to serve stale; an `empty` member is a
truthful negative for that symbol; a `needs_key` member is surfaced as a credential gap. Critically:

> **A missing batch member is never backfilled.** Not from a sibling symbol, not from yesterday's row
> re-stamped as today's, not from a sector average, not from a `0`. The good members are written; the
> bad members are *absent*, typed, and left for the next cron. Backfilling a missing member to "complete
> the batch" is fabrication — the same CRITICAL as zero-filling a price (§6.2).

---

## 8. `transform_data` raises → the worker turns it into ground-or-skip

Here is where the typed error meets the persistence decision. The chain, end to end:

```
transform_data:  if not data: raise EmptyDataError(...)      # the typed signal (§5.1)
        │
        ▼
worker catch:    except EmptyDataError:  →  ground-or-skip   # the persistence decision (§8)
        │                except Unavailable: →  ground-or-skip
        │                except NeedsKey:    →  surface needsKey, skip
        ▼
result:          stored series (if any) keeps serving stale  # never a fabricated row
```

**Ground-or-skip** is the product line's name for the discipline (from
[`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md):
*"partial-failure = ground-or-skip (throw → cache serves stale), never a fabricated number"*). It means:

> When a fetch yields `EmptyData`, `Unavailable`, or `NeedsKey`, the worker **writes nothing new**. The
> previously-persisted series stays in the store untouched, and the read path continues to serve it
> *as-is, with its true `as_of` timestamp*. The system degrades to **stale-but-honest**, never to
> **fresh-but-fabricated**.

This is the *direct* inheritance of the host repo's proven mechanism. In Lumina's
`backend/finance/sentiment-sources.ts`, the comment states it exactly:

> *"the cache (getOrRefresh) can serve stale / the route can 502 honestly — never a fake number."* —
> `backend/finance/sentiment-sources.ts:13`

and the fetchers there **throw** on a bad upstream rather than returning a placeholder:

```ts
// backend/finance/sentiment-sources.ts (host-repo prior art)
if (!res.ok) throw new Error(`Treasury ${res.status}`);              // :96  — fail, don't fake
if (!latest) throw new Error("Treasury: no parseable yield-curve rows"); // :106 — empty → throw
if (!res.ok || text.startsWith("Please limit")) throw new Error("GDELT throttled/unavailable"); // :209
```

The mechanism: the fetcher **throws**; the caching layer's `getOrRefresh(...).catch(() => null)` (e.g.
`sentiment-sources.ts:308`) swallows the throw *into a null at the call site*, the prior cached value
keeps being served, and **no fabricated row ever enters the store.** Our Python worker is the same shape
with different syntax: `transform_data` *throws* a typed error; the worker's `except` block declines to
write; TimescaleDB keeps the last good rows; the gateway serves them with their honest `as_of`.

The throw is doing real work here. A function that *returns* `[]` or `None` or `{close: 0}` on failure
*hands a value to the next layer* — and the next layer might persist it, average it, or render it. A
function that *throws* hands **control** to a handler whose only options are *retry* or *skip* —
**neither of which can fabricate.** Throwing is how you make "do nothing" the only safe failure path.

### 8.1 Why "skip" beats "write a zero" beats "write yesterday as today"

Three candidate behaviors on a failed daily ingest; only one is honest:

| Behavior | What the store holds after | Honest? |
|---|---|---|
| **Skip** (ground-or-skip) | yesterday's row, with **yesterday's** `as_of` | ✅ stale-but-true; the consumer sees the gap |
| Write a zero for today | a `0.0` row stamped **today** | ❌ fabricated; corrupts every downstream calc |
| Re-stamp yesterday as today | yesterday's value stamped **today** | ❌ fabricated *freshness*; a flat line that lies about being current |

The skip is the only one where a consumer asking *"what's the latest, and as of when?"* gets a true
answer. The other two answer *"here's today's number"* with a number that was never observed today. The
staleness is **visible** (the `as_of` is old) and therefore safe; fabricated freshness is **invisible**
and therefore dangerous.

---

## 9. The result envelope (carrying the type across the in-process boundary)

Exceptions are the right tool *inside* the TET stages (they force a handler; §4, §8). But the worker
sometimes wants to *enumerate* outcomes without `try/except` per item — especially across a batch. So the
write path also defines an explicit **result envelope** the worker consumes. (This is the Python analog
of the Rust `Result`/the TS discriminated union — and a clean-room cousin of OpenBB's `OBBject` wrapper,
which carries `results` plus `warnings`/`error` metadata.)

```python
from dataclasses import dataclass, field
from typing import Generic, Literal, TypeVar

T = TypeVar("T")

@dataclass
class Provenance:
    source: str
    fetch_path: str                 # the URL/endpoint — the license attaches HERE (commercial-ok-gate)
    as_of: datetime
    commercial_ok: bool = False     # DEFAULT FALSE — see commercial-ok-gate.md

@dataclass
class FetchResult(Generic[T]):
    status: Literal["ok", "empty", "unavailable", "needs_key"]
    rows: list[T] = field(default_factory=list)
    provenance: Provenance | None = None
    detail: str | None = None       # human-readable reason for non-ok
    dropped: int = 0                # quality counter (§6.3) — rows discarded as malformed

    @property
    def has_data(self) -> bool:
        return self.status == "ok" and len(self.rows) > 0
```

The rules the envelope enforces by construction:

- A non-`ok` `FetchResult` has `rows == []`. There is **no** state where `status="unavailable"` and
  `rows` is non-empty — you cannot accidentally ship fabricated rows under a failure status.
- Every `ok` result carries a `Provenance` with `commercial_ok` defaulting **False** — wiring the
  licensing gate (`commercial-ok-gate.md`) into the same envelope as the data, so a series can never be
  served for display without an explicit, ledger-backed `commercial_ok=True`.
- `dropped` is the per-result quality counter (§6.3). A result with `status="ok"`, `rows=250`,
  `dropped=2` is *honestly partial* and the count is queryable/alertable.

Whether you carry the type as a **raised exception** (inside the stage, forces a handler) or as a
**returned envelope** (across a batch, enumerable) is a local choice. The invariant is the same:
**the type is always present; the absence is never anonymous.**

---

## 10. Mapping to the idempotent upsert (non-negotiable #1 on the write path)

The taxonomy only delivers "never fabricate" if the *write* it gates is also safe. Two properties:

### 10.1 Only `Ok` reaches the upsert

The worker writes **iff** `FetchResult.has_data` (or `BatchResult.ok_rows` for a batch). `empty`,
`unavailable`, `needs_key` short-circuit before the DB call — ground-or-skip (§8). There is exactly one
code path to the upsert, and it is guarded by a single boolean: *did we get real rows?*

### 10.2 The upsert is idempotent and append-only-in-transaction-time

From [`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)
and the `data-pipeline-worker-cron` skill: *"Idempotent: upsert on natural key, append-only
transaction-time rows."* The write is:

```sql
-- one statement; the DB's unique constraint is the single source of truth.
INSERT INTO series_observation (series_id, obs_date, value, as_of, source, commercial_ok)
VALUES (:series_id, :obs_date, :value, :as_of, :source, :commercial_ok)
ON CONFLICT (series_id, obs_date)            -- the natural key
DO UPDATE SET value = EXCLUDED.value,        -- a *corrected* observation overwrites
              as_of = EXCLUDED.as_of,
              source = EXCLUDED.source
  WHERE EXCLUDED.value IS NOT NULL           -- ← never overwrite a real value with a NULL
    AND EXCLUDED.value IS DISTINCT FROM series_observation.value;  -- no-op if unchanged
```

Why this closes the loop with the taxonomy:

- **`ON CONFLICT … DO UPDATE`** makes a re-run of the same cron *idempotent*: ingesting the same day twice
  produces one row, not two. A retried/double-fired cron (non-negotiable: idempotency on retries) cannot
  double-write.
- **`WHERE EXCLUDED.value IS NOT NULL`** is the field-level §6 rule enforced *at the database*: even if a
  `None` somehow reaches the writer, it **cannot overwrite a previously-good value with a null**. The
  store never *regresses* a real number to absent. (Combined with §10.1's "only `Ok` writes," a `None`
  shouldn't reach here at all — this is defense in depth.)
- **`IS DISTINCT FROM`** makes an unchanged re-ingest a no-op (no churn, no spurious `as_of` bump on a
  value that didn't move).
- **Append-only transaction-time** (the bitemporal dimension, owned by `security-master-symbology` /
  `data-pipeline-worker-cron`): a *correction* doesn't destroy history — the prior observation is
  retained on its transaction-time axis. You can always answer "what did we believe the close was, as of
  last Tuesday?" — which is itself an anti-fabrication property: the record of what we knew, when, is
  immutable.

The single-statement, guarded upsert is the same shape as the host repo's contested-write rule (atomic
guarded `UPDATE … WHERE …`, never read-then-write from app code — `~/.claude/rules/product-scale-
architecture.md` §D). Here the guard is `WHERE EXCLUDED.value IS NOT NULL` rather than `qty > 0`, but the
principle is identical: **the database, not application code, is the final arbiter of whether the write is
legal.**

---

## 11. The AGPL clean-room boundary (non-negotiable for this product line)

Everything in §3 and §5.1 quotes OpenBB **source**. OpenBB is **AGPL-3.0-only** (relicensed MIT→AGPL on
2024-05-15), and AGPL §13 triggers on *network/SaaS* use — exactly our hosted data plane. Per
[`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
("Licensing traps", item 1), the rule is absolute:

- **Never `import openbb_*`. Never vendor `openbb-*` bytes.** Importing/vendoring any `openbb-*` package
  obligates full source disclosure of our derivative work (or a purchased commercial license).
- **Reimplement the *pattern*, clean-room, from the public *docs*.** The error *taxonomy* (a typed
  base + `EmptyData`/`Unauthorized` leaves), the *204-is-a-trap* insight, the *raise-on-empty in
  `transform_data*` discipline, the *NaN/empty/None → null* field rule — these are **ideas**, which are
  uncopyrightable. OpenBB's *source* is AGPL-encumbered; the *design* is free to reuse. The §3.1/§3.2
  listings above are **reference, to be retyped fresh**, not copied into our tree.

In practice: our `errors.py` defines `DataPlaneError(Exception)`, `EmptyDataError(DataPlaneError)`,
`UnavailableError(DataPlaneError)`, `NeedsKeyError(DataPlaneError)` — same *shape* (typed base, named
leaves, actionable messages, provider templating), our *own* names and our *own* bytes, written against
this document, not pasted from GitHub.

---

## 12. Anti-patterns (mistake → fix)

| # | Mistake | Why it breaks | Fix |
|---|---|---|---|
| 1 | `if response.ok: return response.json()` | a 204 / 200-empty-body / `{"data":null}` is `ok` but carries no data → silent empty (§4) | inspect the **parsed** result; `if not data: raise EmptyDataError` |
| 2 | `transform_data` returns `[]` on empty | a bare empty list flows downstream indistinguishable from "zero legit rows" and may be padded | **raise** `EmptyDataError` — make the absence un-ignorable (§4, §5.1) |
| 3 | `close: float = 0.0` (default-zero field) | `0` is a real price; missing becomes indistinguishable from genuine zero, corrupts every calc (§6.2) | `close: float \| None = None`; fold NaN/""/"N/A" → `None` |
| 4 | `df.fillna(0)` / `value or 0` on ingest | fabricates numbers the model never fetched → violates non-negotiable #1 | leave `NULL`; gapfill is read-side, opt-in, *labeled* (§6.2) |
| 5 | one bad symbol throws the whole batch | 4 good symbols lost because of 1 bad ticker | per-member `try/except` inside `get_one`; isolate; emit good, type bad (§7) |
| 6 | backfill a missing batch member from a sibling / yesterday | invents an observation that was never made → fabrication | leave the member absent + typed; next cron retries (§7.1) |
| 7 | `unavailable` treated as `empty` (or vice-versa) | outage looks like "series ended" / forever-retry on a genuinely-empty query | keep them distinct types; failure≠truthful-negative (§2) |
| 8 | on failure, `return None` / `return {"close": 0}` | hands a value to the next layer that may persist/render it | **throw** a typed error; control (not a value) goes to the handler → ground-or-skip (§8) |
| 9 | re-stamp yesterday's value with today's `as_of` | fabricates *freshness*; a flat line that lies about being current | skip; store keeps yesterday's row *with yesterday's* `as_of` (§8.1) |
| 10 | overwrite a stored real value with a freshly-fetched `None` | the store *regresses* a known number to absent | `ON CONFLICT … WHERE EXCLUDED.value IS NOT NULL` (§10.2) |
| 11 | swallow the provider exception (`except: pass`) in `extract_data` | a transport failure becomes an invisible empty; you can't tell outage from no-data | catch, **wrap** the original in a typed `UnavailableError(original=e)`, re-raise (§3.1) |
| 12 | `import openbb_core` to get `EmptyDataError` | AGPL §13 network-copyleft → source-disclosure obligation | clean-room reimplement; never vendor `openbb-*` (§11) |
| 13 | drop malformed rows silently | a quality problem becomes invisible; you can't alert on it | drop + **count** (`dropped=N`) + log; surface the count in PROV/metadata (§6.3) |

---

## 13. The output-contract checklist (grade a write path against this)

A normalization write path passes the error-taxonomy bar **iff** every line is true:

- [ ] Every fetch resolves to **exactly one** typed outcome from §2 (`Ok` / `EmptyData` / `Unavailable` /
      `NeedsKey` / `PartialBatch`). No anonymous empties.
- [ ] `EmptyData` and `Unavailable` are **distinct types** and the worker reacts differently to each (§2).
- [ ] `transform_data` does **`if not data: raise EmptyDataError`** — never `return []` (§4, §5.1).
- [ ] No `response.ok`/`2xx`-as-"got data". The **parsed** result decides `Ok` vs `EmptyData` (the 204 /
      200-empty-body trap, §4).
- [ ] Every nullable number field is `T | None`, never zero-defaulted; **no price/level/stat is ever
      zero-filled** (§6.2).
- [ ] NaN / `""` / `"N/A"` / `"None"` / `"null"` are folded to one canonical `None`/`null` before storage
      (§6.1).
- [ ] Gapfill/interpolation appears **only** on the read path, opt-in, labeled — **never** on ingest
      (§6.2).
- [ ] Partial batches **emit the good members, type the bad ones individually, and backfill nothing**
      (§7, §7.1).
- [ ] On `EmptyData`/`Unavailable`/`NeedsKey` the worker **writes nothing**; the stored series serves
      stale with its **true `as_of`** (ground-or-skip, §8). No fabricated freshness (§8.1).
- [ ] The failure path **throws** (hands control to a handler) rather than **returning** a placeholder
      value (§8).
- [ ] The upsert is **idempotent** (`ON CONFLICT` on the natural key) and **never overwrites a real value
      with `None`** (`WHERE EXCLUDED.value IS NOT NULL`) (§10).
- [ ] Malformed-but-required rows are **dropped + counted + logged**, never invented, never silently
      vanished (§6.3).
- [ ] The error classes are **clean-room** — no `openbb-*` import or vendored bytes (§11).
- [ ] Every `Ok` result carries `Provenance{ commercial_ok }` defaulting **False** (§9; `commercial-ok-
      gate.md`).

---

## 14. Sources (primary, read this run)

- **OpenBB Errors FAQ** — the typed-error → HTTP-status table; the verbatim 204 ("data returned empty but
  the operation was a success") and the "some sources return bad requests with a 200 status code and no
  message" warning; the 422 `OpenBBError` gloss. [docs.openbb.co/odp/python/faqs/errors](https://docs.openbb.co/odp/python/faqs/errors)
- **OpenBB Data Providers FAQ** — "the provider may not have data from the requested period, in which
  case the data will be what they return"; entitlement-driven coverage gaps.
  [docs.openbb.co/odp/python/faqs/data_providers](https://docs.openbb.co/odp/python/faqs/data_providers)
- **`openbb_core/provider/utils/errors.py`** (verbatim source) — `EmptyDataError` + `UnauthorizedError`
  class shapes, default messages, provider-name templating. github.com/OpenBB-finance/OpenBB,
  `openbb_platform/core/openbb_core/provider/utils/errors.py` (develop).
- **`openbb_core/app/model/abstract/error.py`** (verbatim source) — the `OpenBBError(Exception)` base
  with `original: str | Exception | None`. github.com/OpenBB-finance/OpenBB (develop).
- **FMP `equity_historical.py` `transform_data`** (verbatim) — the canonical `if not data: raise
  EmptyDataError(...)` guard before `model_validate`. github.com/OpenBB-finance/OpenBB,
  `openbb_platform/providers/fmp/openbb_fmp/models/equity_historical.py` (develop).
- **yfinance `equity_quote.py`** (verbatim behavior) — per-symbol `try/except` + `warn`, partial-batch
  isolation, all-fail → `[]`. github.com/OpenBB-finance/OpenBB,
  `openbb_platform/providers/yfinance/openbb_yfinance/models/equity_quote.py` (develop).
- **OpenBB blog — "The OpenBB Platform data pipeline … TET"** — "Transform the query. Extract the data.
  Transform the data."; "NaN, empty strings, and the various string representations of None are converted
  to null"; "Numbers are numbers, dates are dates, and strings are strings"; the extract-returns-raw
  rationale. [openbb.co/blog/the-openbb-platform-data-pipeline](https://openbb.co/blog/the-openbb-platform-data-pipeline)
- **Host-repo prior art** — `commercial-ok-gate.md:28` (typed `unavailable`/`needsKey`, never fabricated);
  `CLAUDE.md` non-negotiable #1; `backend/finance/sentiment-sources.ts:13,96,106,209,308` (throw-so-
  cache-serves-stale).
- **Project plan** — `financial-data-analytics-service/01-plan.md:257` ("partial-failure = ground-or-skip
  (throw → cache serves stale), never a fabricated number"; "idempotent: upsert on natural key, append-
  only transaction-time rows"); `02-skills-and-pipeline.md` (`openbb-tet-normalization` skill row; AGPL
  trap item 1).
