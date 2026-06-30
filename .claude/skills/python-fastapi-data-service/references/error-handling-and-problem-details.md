# patterns · Error handling & RFC 9457 problem+json — one machine-readable error contract for the published data API

> **Scope.** This is the **error-contract** reference for the `python-fastapi-data-service` dev-skill
> (the **JPM-Markets re-engineering data-analytics product line — NOT Lumina**). It owns exactly one
> thing: **how a published data API returns errors**, end to end. Registered exception handlers, the
> override of FastAPI's default `RequestValidationError` (422) shape, a single
> [RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457) `application/problem+json` envelope, the
> mapping from *domain* exceptions (catalog NotFound, licensing-gated series, upstream-unavailable) to
> problem responses, the rule that a failed upstream returns a **typed `unavailable` — never a
> fabricated number**, the correlation-id echoed in every error body (the seam to the logging doc), how
> the envelope appears in the emitted OpenAPI, and the build-vs-buy call between
> [`fastapi-problem-details`](https://github.com/g0di/fastapi-problem-details) /
> [`fastapi-problem`](https://nrwldev.github.io/fastapi-problem/) and hand-rolled handlers.
>
> **Why this is its own doc, and load-bearing.** A data API that ships *inconsistent* errors —
> `{"detail": "..."}` from one path, a Pydantic `{"detail": [{...}]}` array from validation, a bare
> Starlette HTML 500 from an unhandled bug, and a stack trace leaking through a misconfigured proxy — is
> a Tier-1 demo dressed as a product. Every SDK, Excel add-in, and (later) MCP agent that consumes this
> API has to special-case each shape, and the stack-trace leak is a security finding. The fix is **one
> envelope, registered once at the app factory, that every error funnels through.** This doc makes that
> contract concrete and pins it to the project's non-negotiable that a finance number is **fetched and
> grounded or typed `unavailable`, never invented** (root `CLAUDE.md` #1; mirrored as F1 in
> [`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md)).
>
> **Versions pinned this run (2026-06).** FastAPI **0.138.0** (released 2026-06-20, Python 3.10–3.14,
> Starlette ≥0.46, Pydantic v2) — [pypi.org/project/fastapi](https://pypi.org/project/fastapi/). RFC 9457
> (July 2023, obsoletes RFC 7807) — [datatracker.ietf.org/doc/html/rfc9457](https://datatracker.ietf.org/doc/html/rfc9457).
> `fastapi-problem-details` **0.1.4** (MIT, 2024-11-08, Python ≥3.10) —
> [pypi.org/project/fastapi-problem-details](https://pypi.org/project/fastapi-problem-details/).
> `fastapi-problem` **0.12.1** (Apache-2.0, 2026-02-10, Python ≥3.10) —
> [pypi.org/project/fastapi-problem](https://pypi.org/project/fastapi-problem/). Re-confirm versions before pinning in code.
>
> **Greenfield.** No codebase `file:line` exists yet. Citations are to (a) primary framework/spec docs
> read this run, (b) the two reference libraries' source/docs, and (c) the sibling skill docs this one
> bridges to. The code here is the recipe to write, not a description of code that exists.

---

## 0. The thirty-second contract (read this first)

**One envelope. Registered once. Every error funnels through it. No exceptions — including the ones you
didn't write.**

```
 any failure inside a request
        │
        ├── RequestValidationError (Pydantic 422)  ─┐
        ├── HTTPException / domain HTTPException ────┤
        ├── DomainError subclasses (NotFound, …) ────┼──► registered exception handler
        ├── unhandled Exception (the 500 bug) ───────┘        │
                                                              ▼
                                              one to_problem() serializer
                                                              │
                                                              ▼
                          Response(media_type="application/problem+json", …)
                          {
                            "type":     "https://errors.example.com/catalog-not-found",
                            "title":    "Catalog entry not found",
                            "status":   404,
                            "detail":   "No series with id 'GDP-XYZ'.",
                            "instance": "/v1/series/GDP-XYZ",
                            "correlation_id": "01J…",     ← echoed from request state (logging doc)
                            "errors":   [ … ]             ← extension, only on 422
                          }
```

**The five rules this doc enforces (each is a graded line in §8):**

1. **One shape.** Every 4xx/5xx body is RFC 9457 `application/problem+json` with the same five core
   members. No path returns a bare `{"detail": ...}`, a Pydantic array, or framework HTML.
2. **No leaks.** A 5xx body NEVER contains a stack trace, exception class name, SQL, file path, or
   upstream URL. RFC 9457 §5 says so explicitly; this is also a security finding, not a style nit.
3. **Typed `unavailable`, never a number.** A failed/over-budget/licensing-gated upstream produces a
   problem response (or a typed `unavailable` payload on a 200) — **never a fabricated, zero, or
   last-known value silently passed off as live** (`CLAUDE.md` #1 / F1).
4. **Correlation-id in the body.** Every error echoes the request's correlation id so a consumer can
   quote it in a ticket and an operator can `grep` straight to the structured log line.
5. **The OpenAPI matches reality.** The emitted schema documents the problem envelope on the responses
   it actually returns — the default hard-coded `HTTPValidationError` 422 is replaced, not left lying.

---

## 1. What FastAPI gives you by default — and why it is not a contract

Start from the primary tutorial
([fastapi.tiangolo.com/tutorial/handling-errors](https://fastapi.tiangolo.com/tutorial/handling-errors/),
read this run). FastAPI ships three default behaviours. Each is fine for a tutorial and wrong for a
published API, for a different reason.

### 1.1 `HTTPException` → `{"detail": ...}`

```python
from fastapi import FastAPI, HTTPException

app = FastAPI()
items = {"foo": "The Foo Wrestlers"}

@app.get("/items/{item_id}")
async def read_item(item_id: str):
    if item_id not in items:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"item": items[item_id]}
```

Response body (verbatim from the tutorial):

```json
{ "detail": "Item not found" }
```

`detail` may be any JSON-serializable value — a `str`, `dict`, or `list`
([tutorial, "You can pass … any value that can be converted to JSON"](https://fastapi.tiangolo.com/tutorial/handling-errors/)).
You can add headers:

```python
raise HTTPException(
    status_code=404,
    detail="Item not found",
    headers={"X-Error": "There goes my error"},
)
```

**Why it's not a contract:** `{"detail": ...}` has no machine-readable `type` to switch on, no stable
`title`, no `instance`, and `detail` is overloaded — sometimes a string, sometimes (on 422) an array of
objects. A consumer can't reliably branch on it. It is the right *raise site* API; it is the wrong *wire
shape*. We keep raising `HTTPException` (and our own subclasses), and we **replace the serializer**.

### 1.2 `RequestValidationError` → a Pydantic 422 array

When request data fails Pydantic validation, FastAPI raises `RequestValidationError` and renders (from
the tutorial, abridged — the exact `type` strings are Pydantic v2's, see §3):

```json
{
  "detail": [
    {
      "type": "int_parsing",
      "loc": ["path", "item_id"],
      "msg": "Input should be a valid integer, …",
      "input": "foo"
    }
  ]
}
```

**Why it's not a contract:** now `detail` is an *array of objects*, not a string — the same key, a
different type, on a different status. A consumer parsing `response.detail` as a string crashes on every
validation error. This is the single biggest reason to standardise: **two built-in error shapes share
one key with incompatible types.**

### 1.3 Unhandled `Exception` → Starlette's plain 500

Any exception you didn't handle bubbles to Starlette's `ServerErrorMiddleware`, which (with
`debug=False`, the production default) returns a terse `Internal Server Error` — and, critically, **with
`debug=True` returns an HTML page containing the traceback.** That debug page is the leak in §0 rule 2.
In production it must be off, and even off, the bare 500 doesn't carry our envelope or correlation id.

> **`RequestValidationError` is NOT Pydantic's `ValidationError`.** FastAPI wraps request-validation
> failures in `fastapi.exceptions.RequestValidationError` (a Starlette `HTTPException` subclass carrying
> `.errors()` and `.body`). A Pydantic `ValidationError` raised in *your* code (e.g. constructing a model
> by hand inside a handler) is a *different* exception and, if unhandled, falls through to the 500 path —
> FastAPI does **not** auto-convert it to a 422 ([tutorial](https://fastapi.tiangolo.com/tutorial/handling-errors/);
> [Pydantic error docs](https://docs.pydantic.dev/latest/errors/errors/)). Decide deliberately: either
> register a handler for `pydantic.ValidationError` too, or never let one escape a handler.

---

## 2. RFC 9457 — the one envelope, member by member

[RFC 9457 "Problem Details for HTTP APIs"](https://datatracker.ietf.org/doc/html/rfc9457) (July 2023,
obsoletes RFC 7807) defines a JSON object with **five standard members**, served as
`application/problem+json`. Read this run; the canonical example from the RFC:

```json
{
  "type": "https://example.com/probs/out-of-credit",
  "title": "You do not have enough credit.",
  "detail": "Your current balance is 30, but that costs 50.",
  "instance": "/account/12345/msgs/abc",
  "balance": 30,
  "accounts": ["/account/12345", "/account/67890"]
}
```

### 2.1 The five members (exact semantics, from the spec)

| Member | Type | Meaning (RFC 9457 §3.1) | Default / rule |
|---|---|---|---|
| `type` | URI (string) | A URI **identifying the problem category**. "Consumers MUST use the 'type' URI (after resolution, if necessary) as the problem type's primary identifier." | Defaults to `"about:blank"` when absent → "no semantics beyond the HTTP status code." Absolute URIs recommended. |
| `title` | string | Short, human-readable summary of the **type**. Should be constant across occurrences (except for localization). | Stable per `type`. Not the place for per-request specifics. |
| `status` | int 100–599 | The HTTP status code generated for *this occurrence*. | **Advisory only** — "conveys the HTTP status code … for the convenience of the consumer." MUST equal the actual response status. |
| `detail` | string | Human-readable explanation **specific to this occurrence**. "ought to focus on helping the client correct the problem, rather than giving debugging information." | Per-request. NO stack traces, NO SQL, NO upstream URLs. |
| `instance` | URI (string) | A URI identifying *this specific occurrence*. Can be a unique id or a dereferenceable resource. | Use the request path, or a `/errors/{correlation_id}` URI. |

> **The `type`/`title` vs `detail`/`instance` split is the whole point.** `type` + `title` are the
> *constant* class of the problem (a consumer keys on `type`, shows `title`). `detail` + `instance` are
> the *variable* specifics of this one occurrence. Get this wrong and consumers parse human prose to
> branch — exactly the failure mode the spec was written to kill.

### 2.2 Extension members

A problem type MAY define **additional members** beyond the five (RFC 9457 §3.2). In the canonical
example, `balance` and `accounts` are extensions. **Consumers MUST ignore members they don't
recognize** — which is what makes the format forward-compatible. We use extensions for exactly two
things: `correlation_id` (§6) and `errors` (the validation field-list, §3).

> **Extension naming caution.** RFC 9457 §3.2 warns extension members "should be designed in a way that
> doesn't conflict with future standard members" and that mixing problem-specific and standard members in
> one flat object can collide. Keep extensions namespaced-by-convention (`errors`, `correlation_id`) and
> never reuse a name the spec might later standardize. We deliberately do NOT flatten arbitrary domain
> fields into the top level; structured extras go under a single known key.

### 2.3 The media type and the security clause

- **`application/problem+json`** is the media type (Appendix A registers it; XML variant
  `application/problem+xml` exists but we ship JSON only). The `Content-Type` header on the response MUST
  be `application/problem+json`, not `application/json` — a consumer's content negotiation and error
  middleware key on it.
- **§5 (Security Considerations) is a hard rule, not advice:** "Generators providing links to occurrence
  information are encouraged to avoid making implementation details such as a stack dump available
  through the HTTP interface." This is the citation behind §0 rule 2 and §5 below.

### 2.4 The IANA registry and `about:blank`

RFC 9457 §4.2 establishes an IANA registry of common problem `type` URIs for interoperability. The only
pre-registered type is `about:blank` (status-code-only semantics). Our domain types
(`catalog-not-found`, `series-licensing-gated`, …) are **private** type URIs under our own documentation
host — they need not be registered, but they MUST be stable and (ideally) dereferenceable to a doc page.

> **Do NOT make `type` a localhost/relative URL that 404s in production.** A `type` that resolves to
> nothing is permitted (resolution is optional) but is a missed affordance and an embarrassment in
> review. Point it at a real docs page, or use `about:blank` honestly until the docs page exists.

---

## 3. Overriding the 422: the validation-error shape

This is the highest-traffic error on a data API (every malformed query string, every bad `POST` body),
so its shape matters most. We replace FastAPI's default `{"detail": [array]}` with our problem envelope
**while preserving the field-level Pydantic error list** as a single `errors` extension.

### 3.1 The Pydantic v2 error dict — what `exc.errors()` gives you

`RequestValidationError.errors()` returns a list of Pydantic v2 error dicts. Each has
([Pydantic v2 error docs](https://docs.pydantic.dev/latest/errors/errors/), confirmed this run):

| Key | Meaning | Example |
|---|---|---|
| `type` | error category | `"missing"`, `"int_parsing"`, `"value_error"`, `"greater_than"` |
| `loc` | tuple: location path of the failing field | `("body", "size")`, `("query", "limit")`, `("path", "item_id")` |
| `msg` | human-readable message | `"Field required"`, `"Input should be a valid integer, …"` |
| `input` | the actual value that failed | `"XL"`, `{}` |
| `url` | link to Pydantic docs for this error type | `https://errors.pydantic.dev/2/v/int_parsing` |
| `ctx` | *(optional)* extra context | `{"gt": 0}` for a `greater_than` error |

> **`input` can leak — scrub it.** `input` echoes back the raw client value, which for a body validation
> error is *part of the request body*. That's usually fine (it's the client's own data), but if a request
> can carry a secret in a field (an API key in a header bound to a model, a token), echoing `input`
> reflects it into the error body and the logs. For a public data API the safe default is to **keep
> `loc`/`msg`/`type` and DROP `input`** in production, or scrub known-sensitive locs. Decide per field;
> don't blindly forward `exc.errors()`.

> **The `ctx` field can hold non-JSON-serializable objects.** For a `value_error` raised from a Python
> `ValueError`, Pydantic v2 may put the actual exception object in `ctx` (e.g.
> `{"error": ValueError(...)}`). `JSONResponse` would choke on it. FastAPI's own default handler runs the
> list through `jsonable_encoder` first (see [tutorial "Use the `RequestValidationError` body"](https://fastapi.tiangolo.com/tutorial/handling-errors/)).
> **Always `jsonable_encoder(exc.errors())`** before serializing — never pass the raw list to
> `JSONResponse`.

### 3.2 The override handler

```python
from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    # Scrub `input` (and `url`) so we neither leak request internals nor couple
    # consumers to Pydantic's docs host. Keep the actionable triple.
    errors = [
        {"type": e["type"], "loc": list(e["loc"]), "msg": e["msg"]}
        for e in jsonable_encoder(exc.errors())
    ]
    problem = {
        "type": "https://errors.example.com/validation-error",
        "title": "Request validation failed",
        "status": 422,
        "detail": "One or more request parameters are invalid.",
        "instance": str(request.url.path),
        "correlation_id": getattr(request.state, "correlation_id", None),
        "errors": errors,
    }
    return JSONResponse(
        status_code=422,
        content=problem,
        media_type="application/problem+json",
    )
```

Registration (and why the import path matters) is in §4. The shape now matches the
[`fastapi-problem-details` validation example](https://github.com/g0di/fastapi-problem-details) — `type`
/ `title` / `status` / `detail` plus an `errors` extension — which is the de-facto community convention,
so SDK generators and middleware recognize it.

### 3.3 Why `JSONResponse` with an explicit `media_type` and not a `Response` subclass

`JSONResponse(content=..., media_type="application/problem+json")` is the lowest-friction path: it
serializes the dict and sets the content type in one call. You *can* define a `ProblemResponse(JSONResponse)`
subclass that hard-codes `media_type = "application/problem+json"` (this is what
[`fastapi-problem-details` exports as `ProblemResponse`](https://github.com/g0di/fastapi-problem-details))
— do that once you have ≥2 handlers, so the media type is set in one place and can't drift. §7 shows the
shared serializer that makes this DRY.

> **Status-code parity is a graded line.** `JSONResponse(status_code=422, content={..., "status": 422})`
> — the outer status and the body `status` MUST be the same integer. Derive the body `status` from the
> response status in the serializer (§7) so they can't disagree. RFC 9457 §3.1 calls the body `status`
> "advisory," but a mismatch is a bug that confuses every consumer.

### 3.4 Optional: relax 422 → 400

Some teams prefer `400 Bad Request` for validation failures (422 is technically WebDAV-origin and some
gateways/old clients mishandle it). FastAPI lets you do this — the override handler simply returns
`status_code=400`. `fastapi-problem-details` exposes this as `validation_error_code` on `init_app`
([g0di docs](https://github.com/g0di/fastapi-problem-details)). **Pick one and document it**; don't return
400 from the handler while the OpenAPI still advertises 422 (§9). For a data API consumed by generated
SDKs, staying on **422** is the lower-surprise default — it's what FastAPI, Pydantic, and the tooling
ecosystem expect.

---

## 4. Registering the handlers — three correct ways, one ordering trap

### 4.1 The decorator form (small apps)

```python
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError

app = FastAPI()

@app.exception_handler(RequestValidationError)
async def _vh(request, exc):
    return await validation_exception_handler(request, exc)
```

### 4.2 The `add_exception_handler` form (preferred — app factory friendly)

`@app.exception_handler(...)` requires `app` to exist at module import. In a real service the app is
built in a `create_app()` factory (so tests can build a fresh app, so settings inject cleanly). Use the
**imperative** registration, which takes the same handler functions:

```python
def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(DomainError, domain_exception_handler)   # §5
    app.add_exception_handler(Exception, unhandled_exception_handler)  # §5.4
```

### 4.3 The HTTPException handler — use **Starlette's** class, not FastAPI's

This is the subtle bit the tutorial calls out
([fastapi.tiangolo.com/tutorial/handling-errors → "Reuse FastAPI's exception handlers"](https://fastapi.tiangolo.com/tutorial/handling-errors/)):

```python
from starlette.exceptions import HTTPException as StarletteHTTPException
```

> **Why Starlette's, not `fastapi.HTTPException`.** FastAPI's `HTTPException` *subclasses* Starlette's.
> Internally FastAPI and Starlette both raise the **Starlette** `HTTPException` (e.g. for a 404 on an
> unmatched route, a 405, a 500 from middleware). If you register a handler keyed on
> `fastapi.HTTPException`, you catch only the ones *you* raised and **miss the framework's own** — those
> fall through to the default and break your one-shape contract. Register on
> `starlette.exceptions.HTTPException` and you catch **both** (yours, because it's a subclass, and the
> framework's). This is verbatim from the tutorial.

```python
from starlette.exceptions import HTTPException as StarletteHTTPException

async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    return problem_response(            # the shared serializer, §7
        request,
        status=exc.status_code,
        detail=exc.detail if isinstance(exc.detail, str) else "Request failed.",
        headers=exc.headers,
    )
```

### 4.4 You can still reuse FastAPI's defaults inside your handler

If you only want to *log* and otherwise keep the default behaviour, the tutorial shows you can delegate:

```python
from fastapi.exception_handlers import (
    http_exception_handler as default_http_handler,
    request_validation_exception_handler as default_validation_handler,
)
# inside your handler: return await default_http_handler(request, exc)
```

We generally **don't** — we want our envelope, not the default — but it's the documented escape hatch and
useful in a migration where you replace handlers one at a time.

### 4.5 The ordering trap (and the OpenAPI ordering trap)

- **Specific before general.** `Exception` (the catch-all, §5.4) is the *most general* handler. Starlette
  matches handlers by exception type with MRO resolution, so a more specific handler (e.g. `DomainError`)
  wins over `Exception` regardless of registration order — but register specific→general anyway for
  readability and to avoid surprises with overlapping hierarchies.
- **`init_app` before `include_router` (library path).** If you use `fastapi-problem-details`, its docs
  are explicit: `problem.init_app(app)` must run **before** `app.include_router(...)` for the default
  problem response to be documented on the included routes' OpenAPI
  ([g0di docs](https://github.com/g0di/fastapi-problem-details)). The same ordering discipline applies to
  the hand-rolled OpenAPI patch in §9.

---

## 5. Domain exceptions → problem responses (the mapping table)

The data API's *domain* failures are a small, closed set. Model each as an exception class carrying the
fields the envelope needs, and map it to a problem. This is where the project's non-negotiables become
wire-level contract.

### 5.1 The domain exception base

```python
from dataclasses import dataclass, field


@dataclass
class DomainError(Exception):
    """Base for every modeled, expected failure in the data plane."""
    status: int = 500
    type_uri: str = "about:blank"
    title: str = "Internal error"
    detail: str = "An error occurred."
    extras: dict = field(default_factory=dict)   # extension members for the problem body

    def __post_init__(self) -> None:
        super().__init__(self.detail)
```

### 5.2 The catalog of domain problems

| Domain exception | HTTP | `type` (under `errors.example.com/`) | `title` | When it fires | Non-negotiable it enforces |
|---|---|---|---|---|---|
| `CatalogNotFound(series_id)` | 404 | `catalog-not-found` | "Catalog entry not found" | A requested series / dataset id isn't in the catalog | — |
| `SeriesLicensingGated(series_id, provenance)` | 403 | `series-licensing-gated` | "Series not licensed for this surface" | The series exists but its `Provenance.commercialOk` is `false` for a commercial-display consumer | `commercialOk` gate (F2) |
| `UpstreamUnavailable(source, reason)` | 503 | `upstream-unavailable` | "Upstream data source unavailable" | The write path / store has no fresh value (fetch failed, over budget, stale past TTL) | **typed `unavailable`, never a fabricated number** (F1 / `CLAUDE.md` #1) |
| `RateLimited(retry_after)` | 429 | `rate-limited` | "Rate limit exceeded" | Per-consumer quota exhausted | — |
| `RequestValidationError` (FastAPI) | 422 | `validation-error` | "Request validation failed" | Pydantic rejects request data (§3) | — |
| `Unauthenticated` | 401 | `unauthenticated` | "Authentication required" | Missing/invalid token | trust boundary |
| `Forbidden` | 403 | `forbidden` | "Access denied" | Authn ok, authz fails (wrong consumer for this row) | trust boundary |
| *unhandled* `Exception` | 500 | `internal-error` | "Internal server error" | A bug — anything you didn't model | **no leak** (RFC 9457 §5) |

### 5.3 The domain handler

```python
async def domain_exception_handler(request: Request, exc: DomainError) -> JSONResponse:
    return problem_response(
        request,
        status=exc.status,
        type_uri=f"https://errors.example.com/{exc.type_uri}",
        title=exc.title,
        detail=exc.detail,
        extras=exc.extras,
    )
```

And the raise sites read like English:

```python
# read_api/series.py  (the read path — serves from store, NEVER fetches; see topology doc)
entry = await catalog.get(series_id)
if entry is None:
    raise CatalogNotFound(series_id)            # → 404 problem

if not entry.provenance.commercial_ok and consumer.is_commercial:
    raise SeriesLicensingGated(series_id, entry.provenance)  # → 403 problem, NOT the data

point = await store.latest(series_id)
if point is None or point.is_stale(entry.max_staleness):
    # The store has nothing fresh. We do NOT invent, zero-fill, or serve a silent stale value.
    raise UpstreamUnavailable(source=entry.source, reason="no_fresh_value")   # → 503 problem
```

> **§5.3 is where F1 lives.** The temptation under load is to "return *something*" — a `0.0`, the last
> cached value with no staleness flag, a synthesized point. That is the exact failure
> [`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md) F1 hunts: "a displayed finance
> number is invented / ungrounded … a failed tool was backfilled instead of returning typed
> `unavailable`." The handler's job is to make the *honest* path (a typed 503 problem) the easy path. A
> consumer that gets a `upstream-unavailable` problem renders "data unavailable," which is correct; a
> consumer handed a fabricated `0.0` renders a chart that lies.

> **The 503 vs the typed-200 `unavailable`.** Two valid shapes, pick by surface:
> - **Single-series request that has no data → 503 problem** (`upstream-unavailable`). The whole request
>   failed; an HTTP error is honest.
> - **Multi-series / panel request where *some* series are unavailable → 200 with a typed
>   `{"status": "unavailable", "reason": "..."}` per missing series** in the payload. You can't fail the
>   whole batch because one cell is missing. The per-cell `unavailable` token is the F1-compliant shape
>   here — it's a *typed marker*, never a number. Mirror the field name (`unavailable` / `needsKey`) the
>   root `CLAUDE.md` #1 uses so the contract is consistent across the product line.

### 5.4 The catch-all — the one handler that must never leak

```python
import logging

logger = logging.getLogger("data_api.errors")

async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    correlation_id = getattr(request.state, "correlation_id", None)
    # Log the FULL detail server-side — class, message, traceback — keyed by correlation_id.
    logger.exception(
        "unhandled exception",
        extra={"correlation_id": correlation_id, "path": request.url.path},
    )
    # Return the OPAQUE problem to the client. No class name, no message, no traceback.
    return problem_response(
        request,
        status=500,
        type_uri="https://errors.example.com/internal-error",
        title="Internal server error",
        detail="An unexpected error occurred. Quote the correlation id when reporting it.",
    )
```

> **The split is the whole security posture:** the *full* detail (class, message, stack) goes to the
> **structured log** (the [logging doc](./logging-and-observability.md) owns this), keyed by
> `correlation_id`; the *opaque* problem with the same `correlation_id` goes to the **client**. The
> operator joins them by id. This satisfies RFC 9457 §5 ("avoid making … a stack dump available through
> the HTTP interface") and gives support a single token to triage on. **Registering an
> `Exception`-keyed handler also requires `ServerErrorMiddleware` not to short-circuit** — in current
> Starlette/FastAPI the `Exception` handler is honored; verify on your pinned version that a raised
> non-HTTP exception reaches it and doesn't render the debug page (it won't, with `debug=False`).

---

## 6. The correlation id — the seam to the logging doc

Every error body carries a `correlation_id` extension. This is the single most useful field for
operating the API: the consumer quotes it in a ticket, the operator greps the logs for it, and the full
stack trace (which never left the server) is one line away.

### 6.1 Where it comes from

A middleware (owned by the [logging doc](./logging-and-observability.md)) reads an inbound
`X-Request-ID` / `X-Correlation-ID` header or mints a new ULID, stashes it on `request.state`, and
echoes it on the response header. The error handlers **read it off `request.state`** — they do not mint
it (so the error body and the access log share one id).

```python
# In every handler / the shared serializer:
correlation_id = getattr(request.state, "correlation_id", None)
```

`getattr(..., None)` is defensive: if an exception fires *before* the correlation middleware ran (rare,
but possible for very early ASGI errors), the field is `null` rather than the handler itself crashing
with `AttributeError` — which would replace your clean 500 with a *second*, uncaught 500.

### 6.2 Echo it on the header too

```python
headers = {"X-Correlation-ID": correlation_id} if correlation_id else {}
return JSONResponse(..., headers=headers, media_type="application/problem+json")
```

A consumer reads it from the body (in-band, survives logging the response) and the header (out-of-band,
available even if they don't parse the body). The popular
[`asgi-correlation-id`](https://github.com/snok/asgi-correlation-id) library implements exactly this
middleware + a logging filter, and is the reference impl the logging doc points to; this doc only
*consumes* `request.state.correlation_id`.

> **One id, generated once, per request.** A common bug: the access-log middleware mints id A, the error
> handler mints id B, the consumer is told B, the operator greps the logs and finds A. Generate once
> (middleware), store on `request.state`, read everywhere. This doc's contract is "read it, never mint
> it."

---

## 7. The shared serializer — one function, no drift

Every handler above calls one function. This is the DRY core that guarantees §0 rule 1 (one shape).

```python
from typing import Any
from fastapi import Request
from fastapi.responses import JSONResponse

PROBLEM_MEDIA_TYPE = "application/problem+json"


def problem_response(
    request: Request,
    *,
    status: int,
    type_uri: str = "about:blank",
    title: str = "Error",
    detail: str = "An error occurred.",
    extras: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    correlation_id = getattr(request.state, "correlation_id", None)
    body: dict[str, Any] = {
        "type": type_uri,
        "title": title,
        "status": status,           # derived from the same `status` → can't disagree with the outer code
        "detail": detail,
        "instance": str(request.url.path),
    }
    if correlation_id is not None:
        body["correlation_id"] = correlation_id
    if extras:
        # Never let an extra clobber a core member.
        for k, v in extras.items():
            if k not in body:
                body[k] = v
    out_headers = dict(headers or {})
    if correlation_id is not None:
        out_headers.setdefault("X-Correlation-ID", correlation_id)
    return JSONResponse(
        status_code=status,
        content=body,
        media_type=PROBLEM_MEDIA_TYPE,
        headers=out_headers,
    )
```

Properties this buys you, each a graded line in §8:

- **Status parity** — outer `status_code` and body `status` are the *same variable*.
- **Media type** — set in exactly one place; can't be forgotten on a new handler.
- **Correlation id** — added uniformly to body and header.
- **No-clobber** — an `extras` key can't overwrite `type`/`status`/etc.
- **One place to evolve** — add a future member (e.g. a `docs` link) once.

> **Why a plain dict and not a Pydantic model for the body.** You *can* define a `Problem(BaseModel)` and
> return it (and `fastapi-problem-details` exports a `Problem` schema class for OpenAPI — §9). For the
> *serializer* a dict is faster and avoids a model-construction round-trip on the error path (the error
> path should be cheap and allocation-light, since a 5xx storm is when you least want overhead). Use the
> Pydantic `Problem` model for **documentation** (§9), a dict for **emission**.

---

## 8. Output contract — the graded rubric for this surface

A PR that touches error handling earns the bar only if **every** line holds. This is the F-section
of [`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md) made concrete for errors.

| # | Requirement | Pass looks like | Fail (any one) |
|---|---|---|---|
| C1 | **One shape** | Every 4xx/5xx body is `application/problem+json` with `type/title/status/detail/instance` | A path returns bare `{"detail": ...}`, a Pydantic array, or framework HTML |
| C2 | **Media type** | `Content-Type: application/problem+json` on every error | `application/json` on an error body |
| C3 | **422 overridden** | Validation errors return the problem envelope + `errors` extension; `input` scrubbed | Default `{"detail": [array]}` still reaches the client; `input` leaks a secret-bearing field |
| C4 | **Starlette HTTPException caught** | Handler keyed on `starlette.exceptions.HTTPException` — framework 404/405/500 wrapped too | Keyed only on `fastapi.HTTPException`; framework errors fall through |
| C5 | **No leak (F-no-leak / RFC 9457 §5)** | 5xx body has no class name, traceback, SQL, file path, or upstream URL; `debug=False` in prod | A stack trace, `repr(exc)`, or upstream URL appears in any client-visible body |
| C6 | **Typed `unavailable`, never a number (F1)** | Failed/gated/over-budget upstream → 503 problem or typed `unavailable` token; no `0.0`/synthesized/silent-stale value | A fabricated, zero, or undisclosed stale number is served as live |
| C7 | **Licensing gate (F2)** | A series with `commercialOk:false` returns `series-licensing-gated` 403 to a commercial consumer, not the data | The gated series' values are returned |
| C8 | **Correlation id** | Every error body + `X-Correlation-ID` header carries the request's id; full detail is in the log under the same id | No id in the body, or a different id in log vs body |
| C9 | **Status parity** | Body `status` == HTTP response status, always | They disagree on any path |
| C10 | **OpenAPI matches** | Emitted schema documents the problem envelope on returned responses; default `HTTPValidationError` 422 replaced where overridden | Docs advertise a 422 array the API no longer returns |
| C11 | **Registered once, factory-safe** | Handlers registered in `create_app()` via `add_exception_handler`; library `init_app` before `include_router` | Decorator at module top forces import-time `app`; routers included before handlers |

---

## 9. The OpenAPI surface — making the docs tell the truth

A consumer reads `/openapi.json` (and the `/docs` Swagger UI) to know what errors to expect. FastAPI
*hard-codes* a default 422 `HTTPValidationError` response on every operation that has parameters/body —
and **does not** know about your overridden shape or your domain problems. Three moves bring the docs
back in line with reality.

### 9.1 Document each domain problem per route with `responses=`

FastAPI's [Additional Responses in OpenAPI](https://fastapi.tiangolo.com/advanced/additional-responses/)
lets you attach a `model` per status code on a path operation:

```python
from pydantic import BaseModel

class Problem(BaseModel):
    type: str = "about:blank"
    title: str
    status: int
    detail: str
    instance: str | None = None
    correlation_id: str | None = None

class ValidationProblem(Problem):
    errors: list[dict]

@router.get(
    "/series/{series_id}",
    responses={
        404: {"model": Problem, "description": "Catalog entry not found",
               "content": {"application/problem+json": {}}},
        403: {"model": Problem, "description": "Series not licensed for this surface"},
        503: {"model": Problem, "description": "Upstream data source unavailable"},
        422: {"model": ValidationProblem, "description": "Request validation failed"},
    },
)
async def get_series(series_id: str): ...
```

The `"content": {"application/problem+json": {}}` key documents the media type, not just the schema.

> **The honesty trap the FastAPI issue tracker documents.** Adding `responses={422: {"model": ...}}`
> changes the **docs** but NOT the runtime response — and conversely, overriding the handler changes the
> **runtime** but not the docs ([fastapi#3650](https://github.com/fastapi/fastapi/issues/3650),
> [discussion #8134](https://github.com/fastapi/fastapi/discussions/8134), confirmed this run). You must
> do **both**: override the handler (§3) AND fix the schema (here + §9.2), or the OpenAPI lies — a C10
> failure. The two are not substitutes.

### 9.2 Replace or remove the global default 422 with a custom `openapi()`

To stop FastAPI advertising the *default* `HTTPValidationError` 422 everywhere (which no longer matches
your overridden shape), post-process the schema once:

```python
from fastapi.openapi.utils import get_openapi

def custom_openapi(app: FastAPI):
    def _openapi():
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(
            title="Data API", version="1.0.0", routes=app.routes,
        )
        # Point the default validation schema at OUR problem shape, app-wide.
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        # (Option A) Replace the auto-generated HTTPValidationError with our ValidationProblem,
        # or (Option B) walk paths and rewrite every 422 response's $ref / content type.
        for path in schema.get("paths", {}).values():
            for op in path.values():
                resp = op.get("responses", {})
                if "422" in resp:
                    resp["422"]["content"] = {
                        "application/problem+json": {
                            "schema": {"$ref": "#/components/schemas/ValidationProblem"}
                        }
                    }
        app.openapi_schema = schema
        return schema
    return _openapi

app.openapi = custom_openapi(app)
```

This is the documented community pattern from
[discussion #7967](https://github.com/fastapi/fastapi/discussions/7967) and
[discussion #6695](https://github.com/fastapi/fastapi/discussions/6695) (read this run): the 422 schema
is "still hardcoded" and there is "no built-in way" to swap it, so you patch the generated dict. Run the
patch **once** and cache it on `app.openapi_schema` (as above) so it isn't recomputed per request.

### 9.3 A reusable `responses` constant (DRY)

Define the common error set once and spread it per route:

```python
COMMON_ERROR_RESPONSES = {
    422: {"model": ValidationProblem, "content": {"application/problem+json": {}}},
    429: {"model": Problem, "content": {"application/problem+json": {}}},
    500: {"model": Problem, "content": {"application/problem+json": {}}},
}

@router.get("/series/{series_id}", responses={**COMMON_ERROR_RESPONSES,
            404: {"model": Problem}, 503: {"model": Problem}})
async def get_series(series_id: str): ...
```

---

## 10. Build vs buy — the two reference libraries vs hand-rolled

Three options. The recommendation is **hand-rolled handlers built on the §7 serializer**, with the
libraries as cross-checks and accelerators. Here is the honest trade-off.

### 10.1 `fastapi-problem-details` (g0di)

- **Version / license:** 0.1.4, MIT, released 2024-11-08, Python ≥3.10
  ([pypi](https://pypi.org/project/fastapi-problem-details/)).
- **What it does** ([g0di README](https://github.com/g0di/fastapi-problem-details), read this run):
  `problem.init_app(app)` registers handlers for `RequestValidationError` (422 with an `errors`
  extension), `HTTPException` (Starlette + FastAPI), and **generic `Exception`** (catches, logs, returns
  500). Exports `ProblemResponse` (return from a custom handler), `ProblemException` (raise with extras +
  headers), and a `Problem` Pydantic schema for OpenAPI documentation. Auto-adds a default Problem
  response schema to all routes — **`init_app` must run before `include_router`**.
- **Config:** `validation_error_code` (override 422→400), `validation_error_detail`,
  `include_exc_info_in_response` (adds `exc_type` + `exc_stack` — **development only**; turning this on in
  prod is a direct C5 / RFC 9457 §5 violation).
- **Raise-with-extras example (verbatim shape):**
  ```python
  from fastapi_problem_details import ProblemException
  raise ProblemException(status=503, detail="Service unavailable",
                         service_1="down", headers={"Retry-After": "30"})
  ```
- **Subclass to avoid duplication:**
  ```python
  class UserPermissionError(ProblemException):
      def __init__(self, user_id, headers=None):
          super().__init__(status=403, detail=f"User {user_id} not allowed",
                           user_id=user_id, headers=headers)
  ```
- **Verdict:** smallest, cleanest API; matches our envelope almost exactly. **Risks:** pre-1.0 (0.1.4),
  single-maintainer, last release 2024 — pin it and read its handler source before depending on it for a
  billion-dollar-grade line. It has **no built-in correlation-id** member (you'd add it via a custom
  `ProblemResponse` or a subclass), and **`include_exc_info_in_response` is a foot-gun** (must be wired
  off in prod). Good accelerator; verify the OpenAPI ordering and the leak setting yourself.

### 10.2 `fastapi-problem` (NRWLDev)

- **Version / license:** 0.12.1, **Apache-2.0**, released 2026-02-10, Python ≥3.10
  ([pypi](https://pypi.org/project/fastapi-problem/), [docs](https://nrwldev.github.io/fastapi-problem/)).
  Built on the underlying [`rfc9457`](https://github.com/NRWLDev/rfc9457) exception library (shared with
  Starlette).
- **What it does:** register via `add_exception_handler(app, new_exception_handler())` from
  `fastapi_problem.handler`. Provides `Problem` / `StatusProblem` base exceptions and convenience
  subclasses (`NotFoundProblem`, etc.):
  ```python
  from fastapi_problem.error import NotFoundProblem
  class UserNotFoundError(NotFoundProblem):
      title = "User not found."
  raise UserNotFoundError(detail="detail")
  ```
  Custom errors take `error_type`, `title`, `status`, `detail`, and `**kwargs` extras. Handles
  `RequestValidationError` and unhandled exceptions, with a **`strip_debug` / production mode to hide
  internal details** — which is the C5 control built in, a real advantage over g0di's opt-in leak flag.
- **Verdict:** more actively maintained (2026 release), Apache-2.0 (cleaner for a commercial line than
  MIT? both permissive — Apache adds an explicit patent grant), `strip_debug` is the right default
  posture. The raise-an-exception-class ergonomics map well to our `DomainError` catalog (§5). **Strongest
  buy candidate** if you don't hand-roll.

### 10.3 Hand-rolled (the §3–§7 recipe) — the recommendation

- **Pros:** zero dependency on a pre-1.0 / small-maintainer package on the critical error path; the
  serializer is ~30 lines you fully understand and can audit; correlation-id, the typed-`unavailable`
  contract, `input` scrubbing, and the no-clobber rule are *yours* and exactly fit the project's
  non-negotiables (which no generic library knows about); trivial to unit-test.
- **Cons:** you write (and must maintain) the OpenAPI patch (§9) and the handler registration — but those
  are one-time and small.
- **The CTO call** (per [`cto-rules.md`](../../../rules/cto-rules.md) §5 "no hacks," "first principles"):
  **hand-roll the handlers + serializer; read both libraries' source as the spec cross-check**; lift
  `fastapi-problem`'s `strip_debug` posture and g0di's `responses`-schema documentation pattern. The
  error path is small, security-sensitive, and tied to project-specific non-negotiables (F1, F2, no-leak)
  that no off-the-shelf library encodes — owning ~30 lines is cheaper than auditing and pinning a
  dependency forever on the one path you cannot afford to get wrong.

> **If you DO adopt a library**, the non-negotiable wiring is: (1) `init_app` / `add_exception_handler`
> **before** `include_router`; (2) the leak flag **off** in prod (`include_exc_info_in_response=False` /
> `strip_debug` on); (3) add the **correlation-id** extension via a subclass/custom response (neither
> library does it for you); (4) re-confirm it catches **Starlette's** `HTTPException`, not only
> FastAPI's. Verify all four against the installed source, not the README.

---

## 11. Testing the contract

Every line in §8 is mechanically testable. Use `httpx.AsyncClient` against the app (FastAPI's `TestClient`
wraps it). The error path is exactly where tests pay off, because errors are the paths humans skip.

```python
import pytest
from httpx import AsyncClient, ASGITransport

@pytest.mark.anyio
async def test_404_is_problem_json(app):
    async with AsyncClient(transport=ASGITransport(app), base_url="http://t") as c:
        r = await c.get("/v1/series/DOES-NOT-EXIST")
    assert r.status_code == 404
    assert r.headers["content-type"] == "application/problem+json"     # C2
    body = r.json()
    assert body["status"] == 404                                       # C9 parity
    assert body["type"].endswith("/catalog-not-found")                 # C1 typed
    assert "correlation_id" in body                                    # C8
    assert r.headers["x-correlation-id"] == body["correlation_id"]     # C8 header == body

@pytest.mark.anyio
async def test_422_is_problem_not_pydantic_array(app):
    async with AsyncClient(transport=ASGITransport(app), base_url="http://t") as c:
        r = await c.get("/v1/series/X?limit=not-an-int")
    assert r.status_code == 422
    body = r.json()
    assert isinstance(body, dict) and "type" in body                   # C3 not a bare array
    assert isinstance(body["errors"], list)                            # field list preserved
    assert all("input" not in e for e in body["errors"])               # C3 input scrubbed

@pytest.mark.anyio
async def test_500_never_leaks(app, force_bug):
    async with AsyncClient(transport=ASGITransport(app), base_url="http://t",
                           raise_app_exceptions=False) as c:
        r = await c.get("/v1/boom")
    assert r.status_code == 500
    raw = r.text.lower()
    for leak in ("traceback", "file \"", ".py\"", "select ", "psycopg", "asyncpg"):
        assert leak not in raw                                         # C5 no leak
    assert "correlation_id" in r.json()                                # C8 id present to triage

@pytest.mark.anyio
async def test_unavailable_is_typed_not_a_number(app, upstream_down):
    """C6 / F1: a dead upstream yields a typed problem, never a fabricated value."""
    async with AsyncClient(transport=ASGITransport(app), base_url="http://t") as c:
        r = await c.get("/v1/series/GDP")
    assert r.status_code == 503
    assert r.json()["type"].endswith("/upstream-unavailable")
    # The body carries NO numeric value masquerading as data.
    assert "value" not in r.json()
```

> **The `test_500_never_leaks` test is the one a reviewer will check exists.** It's the executable form of
> RFC 9457 §5 and C5. Note `raise_app_exceptions=False` on the client so the test asserts on the
> *response* the handler produced, not on the re-raised exception. Run it with `debug=False` (production
> config) — `debug=True` would render the traceback HTML and the test (correctly) fails.

---

## 12. Anti-patterns (mistake → fix)

| Anti-pattern | Why it breaks | Fix |
|---|---|---|
| Returning bare `{"detail": ...}` from some paths | Two error shapes (string vs Pydantic array) share one key; consumers can't branch | One `problem_response()` serializer (§7); register handlers for all error classes (§4) |
| Registering only `fastapi.HTTPException` | Framework 404/405/500 raise **Starlette's** `HTTPException` and fall through | Key the handler on `starlette.exceptions.HTTPException` (§4.3) — catches both |
| Forwarding raw `exc.errors()` to `JSONResponse` | `ctx` may hold a non-serializable `ValueError`; `input` may echo a secret-bearing field | `jsonable_encoder(...)`, then keep `type/loc/msg`, drop `input` (§3.1) |
| `include_exc_info_in_response=True` / printing `repr(exc)` in the body | Leaks class, stack, SQL → RFC 9457 §5 / C5 / security finding | Full detail to the structured log keyed by correlation id; opaque problem to the client (§5.4) |
| Serving `0.0` / last value / synthesized point on a dead upstream | Fabricates a finance number — F1 / `CLAUDE.md` #1 violation; the chart lies | Raise `UpstreamUnavailable` → 503 problem, or a typed per-cell `unavailable` token (§5.3) |
| Returning gated series data because "it's in the store" | `commercialOk:false` series leak past the display license — F2 | `SeriesLicensingGated` → 403, never the values (§5.2) |
| Body `status` ≠ HTTP status | Confuses every consumer; a latent bug | Derive both from one variable in the serializer (§7 / C9) |
| `responses={422: {"model": ...}}` *or* override the handler, not both | One fixes docs, the other fixes runtime; they aren't substitutes | Do both — override handler (§3) **and** patch OpenAPI (§9) — fastapi#3650 |
| `@app.exception_handler` at module top | Forces import-time `app`; breaks the test factory | `register_error_handlers(app)` via `add_exception_handler` in `create_app()` (§4.2) |
| `init_app(app)` after `include_router(...)` | Default problem response isn't documented on those routes | `init_app` / register handlers **before** including routers (§4.5) |
| Minting a new correlation id in the handler | Body id ≠ access-log id; operator greps the wrong one | Read `request.state.correlation_id`; never mint here (§6) |
| `type` pointing at `localhost`/a relative path that 404s | Misses the dereference affordance; embarrasses in review | Absolute URI under your docs host, or honest `about:blank` until docs exist (§2.4) |
| `debug=True` in any deployed env | Starlette renders the traceback HTML on a 500 — total leak | `debug=False` in prod; the catch-all handler (§5.4) owns the 500 |

---

## 13. Cross-references

- **[`lumina-data-plane-topology.md`](./lumina-data-plane-topology.md)** — where the read API vs write
  path sit; the read path that raises `UpstreamUnavailable` here is the same read path that, by
  construction, holds no `httpx` client.
- **`logging-and-observability.md`** *(sibling)* — owns the correlation-id middleware + structured logger
  this doc *consumes*; the full stack trace that never reaches the client lands there.
- **Root [`CLAUDE.md`](../../../../CLAUDE.md) #1** — never invent a finance number; failed tools return
  typed `unavailable`/`needsKey`. §5.3 / C6 is the wire-level form.
- **[`rules/commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)** — the `commercialOk`
  discipline behind the `series-licensing-gated` 403 (§5.2 / C7 / F2).
- **[`rules/red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md)** — F1 (ungrounded
  number), F2 (mis-licensed), F6 (no-leak) are the negation goals §8 operationalizes.
- **[`rules/cto-rules.md`](../../../rules/cto-rules.md)** §5 — "no hacks / first principles," the basis
  for the hand-roll recommendation (§10.3).

### Primary sources read this run

- FastAPI — Handling Errors: <https://fastapi.tiangolo.com/tutorial/handling-errors/>
- FastAPI — Additional Responses in OpenAPI: <https://fastapi.tiangolo.com/advanced/additional-responses/>
- RFC 9457, Problem Details for HTTP APIs: <https://datatracker.ietf.org/doc/html/rfc9457>
- Pydantic v2 — Error Handling: <https://docs.pydantic.dev/latest/errors/errors/>
- fastapi-problem-details (g0di) — <https://github.com/g0di/fastapi-problem-details> ·
  <https://pypi.org/project/fastapi-problem-details/>
- fastapi-problem (NRWLDev) — <https://nrwldev.github.io/fastapi-problem/> ·
  <https://pypi.org/project/fastapi-problem/> · <https://github.com/NRWLDev/rfc9457>
- FastAPI 422 OpenAPI override discussions — <https://github.com/fastapi/fastapi/issues/3650> ·
  <https://github.com/fastapi/fastapi/discussions/7967> ·
  <https://github.com/fastapi/fastapi/discussions/8134> ·
  <https://github.com/fastapi/fastapi/discussions/6695>
- FastAPI release/version (0.138.0, 2026-06-20): <https://pypi.org/project/fastapi/>
- asgi-correlation-id (correlation middleware reference impl): <https://github.com/snok/asgi-correlation-id>
