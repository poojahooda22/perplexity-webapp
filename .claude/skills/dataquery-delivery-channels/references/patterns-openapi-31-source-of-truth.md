# patterns · OpenAPI 3.1 as the single contract source — FastAPI emission, clean SDK-gen, the two-spec reconcile, spec-as-CI-artifact

> **Scope.** This is the **concrete build recipe** for the `dataquery-delivery-channels` dev-skill
> (the **JPM-Markets re-engineering data-analytics product line — NOT Lumina**). It answers one
> operational question: *how do we make the OpenAPI 3.1 document the single, authoritative,
> machine-checked contract for every delivery channel — and never let it drift from the code?*
> Specifically: (1) **why 3.1, not 3.0** — full JSON Schema 2020-12 compatibility, `type: [string,null]`
> replacing `nullable`, `examples` anywhere, top-level `webhooks` — and why each one buys cleaner SDK
> generation; (2) **how FastAPI emits 3.1 natively** from routes + Pydantic v2 models, and the exact
> knobs (`operation_id`, `generate_unique_id_function`, `openapi_tags`, `separate_input_output_schemas`)
> that turn a default ugly spec into a navigable one; (3) **documenting the cross-cutting schemas ONCE**
> (pagination envelope, RFC-9457 error, rate-limit headers, the OAuth2 `clientCredentials` security
> scheme) under `components` and `$ref`-ing them everywhere; (4) **the two-spec problem** — the TS Express
> gateway spec (the public face) vs the FastAPI data-plane spec (internal) — and how to reconcile them to
> one published contract; (5) **spec-as-CI-artifact** — Spectral lint + oasdiff breaking-change diff
> gating every PR; and (6) a **worked, runnable FastAPI app** that ties it all together.
>
> **Why this doc is load-bearing.** Every channel in this skill (REST retrieval, batch, Excel add-in, an
> MCP server, a generated TS/Python SDK) is a *consumer* of the contract. If the contract is hand-written,
> it lies the moment code changes; if it is generated but not gated, breaking changes ship silently. This
> doc makes the spec a **build output** of the code and a **CI gate** on every change — the one mechanism
> that keeps N channels honest against one source of truth.
>
> **Greenfield.** No codebase `file:line` exists yet. Every concrete claim is cited inline to (a) primary
> spec text (OpenAPI 3.1.0 / JSON Schema 2020-12 / RFC 9457), (b) primary library source read this run
> (`fastapi/utils.py`, `fastapi/openapi/utils.py`, `fastapi/security/oauth2.py`), or (c) primary tool docs
> (FastAPI, Spectral, oasdiff). The code here is the recipe to write, not a description of code that exists.
>
> **Versions pinned this run (2026-06).** FastAPI **0.138.0** (released 2026-06-20) — emits OpenAPI
> **3.1.0** by default; Pydantic **2.13.4** (released 2026-05-06); OpenAPI Specification **3.1.0/3.1.1**
> (JSON Schema dialect **2020-12**); `@stoplight/spectral-cli` (OpenAPI 3.1/3.0/2.0 support); oasdiff
> (`oasdiff/oasdiff`, breaking-change CLI + GitHub Action `@v0`). **Re-confirm every version before
> pinning it in `pyproject.toml` / `package.json`.** [fastapi-pypi][pydantic-pypi]

---

## 0. The thirty-second recipe (read this first)

**The contract is a build artifact, not a hand-written file. The code is the source; the spec is its
output; CI is the judge.**

```
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │  THE SOURCE-OF-TRUTH PIPELINE                                                      │
  │                                                                                    │
  │   Python routes + Pydantic v2 models  ──FastAPI──▶  openapi.json (3.1.0)           │
  │        (the data-plane code IS the spec source)        │                           │
  │                                                         ▼                           │
  │   TS Express gateway routes + zod/TS  ──gen──▶  gateway-openapi.json (3.1.0)        │
  │        (the PUBLIC face IS the spec source)            │                           │
  │                                                         ▼                           │
  │                                          RECONCILE → ONE public contract            │
  │                                          (gateway is canonical; data-plane          │
  │                                           is internal/private)                      │
  │                                                         │                           │
  │                              ┌──────────────────────────┼──────────────────┐        │
  │                              ▼                          ▼                  ▼        │
  │                       spectral lint            oasdiff breaking      SDK codegen     │
  │                       (style/governance)       (block breaks)       (TS, Python)     │
  │                              └────────── CI gate on every PR ───────┘                │
  └────────────────────────────────────────────────────────────────────────────────┘
```

Six rules, each justified below:

1. **Emit, never hand-write.** FastAPI generates the data-plane spec from routes+models;
   `app.openapi()` returns OpenAPI **3.1.0** (`openapi_version: str = "3.1.0"` in `get_openapi`). A
   hand-maintained YAML is drift waiting to happen. [fastapi-openapi-utils]
2. **Stabilize `operationId`s** with a `generate_unique_id_function` so SDK method names are
   `getSeriesObservations`, not `read_series_observations_v1_series__id__observations_get`.
   [fastapi-generate-clients]
3. **Tag every operation** with exactly one primary tag → tags become SDK service classes
   (`SeriesService`, `CatalogService`). [fastapi-generate-clients]
4. **Define cross-cutting schemas once** under `components` (Pagination, `Problem` per RFC 9457,
   rate-limit `headers`, the `clientCredentials` security scheme) and `$ref` them — never inline-repeat.
   [rfc9457][oas31-components]
5. **Reconcile two specs to one public contract.** The TS gateway is the published face; the FastAPI
   spec is internal. Lint + diff *the gateway spec* as the contract clients depend on.
6. **Gate the spec in CI.** `spectral lint` for style/governance; `oasdiff breaking --fail-on ERR` to
   block changes that would break an existing client. [spectral][oasdiff-breaking]

---

## 1. Why OpenAPI 3.1 (not 3.0) — and why each change buys clean SDK generation

The single biggest reason to be on 3.1 is that **its Schema Object IS JSON Schema 2020-12** (a superset),
not a near-miss subset. The OpenAPI 3.1.0 spec states data types "are based on the types supported by the
JSON Schema Specification Draft 2020-12, and Models are defined using the Schema Object, which is a
superset of JSON Schema Specification Draft 2020-12." [oas31-spec] In 3.0, the Schema Object was a
*modified, incompatible subset* of an older draft — which is why every 3.0 toolchain needed bespoke
translation code and why generated SDKs were lossy. 3.1 removes that translation layer entirely.

For a financial data-plane that publishes SDKs in multiple languages (the DataQuery/Fusion re-engineering
ships TS + Python clients), the version choice is not cosmetic: it determines whether the generated types
are *exactly* your model types or a lossy approximation.

### 1.1 The four changes that matter most, with before/after

#### (a) `nullable` is gone → union types `type: [T, "null"]`

In 3.0 you wrote an OpenAPI-proprietary `nullable: true`. In 3.1 you express nullability the JSON Schema
way — a type array including `"null"`. From the official upgrade guide: [oas-upgrade]

```yaml
# OpenAPI 3.0
asOf:
  type: string
  nullable: true

# OpenAPI 3.1
asOf:
  type:
    - "string"
    - "null"
```

LornaJane's 3.1 write-up confirms: "from 3.1, the `nullable` keyword is removed – use the array of types
and one of the types is null." [lornajane] Beeceptor's comparison shows the same `schema: type:
["string", "null"]` form. [beeceptor]

**Why it matters for SDK-gen.** A TypeScript generator turns `type: ["number","null"]` into `number |
null` directly — a faithful, idiomatic optional. With 3.0's `nullable`, generators had to special-case a
vendor keyword, and many produced `number | undefined` or dropped the null entirely. The union type is
the difference between a generated client that compiles against your real data shape and one that lies
about it. **For us this is load-bearing:** point-in-time series carry genuinely nullable fields (`asOf`,
`revisedValue`, a gap-filled `v` that is `null` on a true gap), and the client MUST model `null`
distinctly from "absent". (Pydantic v2 emits exactly this: `Optional[float]` / `float | None` →
`{"anyOf": [{"type": "number"}, {"type": "null"}]}` or the type-array form depending on settings — both
are 2020-12-valid and round-trip cleanly.)

#### (b) `example` (singular, vendor) → `examples` (plural, standard JSON Schema, *anywhere*)

3.1 supports the JSON Schema `examples` keyword (an array) *inside any Schema Object*. The original
singular `example` is still valid but `examples` is recommended. [lornajane] Beeceptor: in 3.0.3
"examples … were not allowed directly inside JSON Schema definitions"; 3.1.0 "permits embedding examples
anywhere within schema objects." [beeceptor] Upgrade mapping: [oas-upgrade]

```yaml
# OpenAPI 3.0
freq:
  type: string
  example: D

# OpenAPI 3.1
freq:
  type: string
  examples:
    - D
    - W
    - M
```

**Why it matters.** Examples that live *on the schema* travel with every `$ref` to that schema —
documentation and mock servers (Prism, Beeceptor) get realistic data for free at every use site, not just
where you hand-wrote a media-type example. For a data API, a realistic `{t, v}[]` example on the
`Observation` schema means every endpoint that returns observations shows live-looking data in docs.

#### (c) `webhooks` is a top-level keyword

3.1 adds `webhooks` alongside `paths` at the document root. From the spec change notes: "The new
`webhooks` keyword is a top-level element, alongside `paths`." And the document-validity rule changed:
"only `openapi` and `info` are always required, but the document must also contain at least one of
`paths` or `webhooks` or `components`." [lornajane] FastAPI exposes this — `get_openapi(... webhooks=...)`
takes a webhooks sequence. [fastapi-openapi-utils]

**Why it matters for us.** A data platform's **batch-delivery-ready** and **dataset-revised** events are
genuine webhooks (the gateway POSTs to a subscriber URL when a nightly batch lands or a series is
restated). In 3.1 these are first-class, documented, and code-generatable as typed callback handlers — in
3.0 you'd hack them as `x-` extensions or out-of-band docs. (The batch event payloads live in
`patterns-batch-delivery-transports.md`; here they are just *documented* in the same contract.)

#### (d) `exclusiveMinimum`/`exclusiveMaximum` became numeric (a silent footgun)

This one bites silently on migration. In 3.0 `exclusiveMinimum` was a *boolean modifier* of `minimum`; in
3.1 (per JSON Schema 2020-12) it is *itself the numeric bound*. [oas-upgrade]

```yaml
# OpenAPI 3.0  (minimum 7, exclusive)
minimum: 7
exclusiveMinimum: true

# OpenAPI 3.1
exclusiveMinimum: 7
```

**Why it matters.** If any hand-written fragment (or a copied 3.0 snippet) carries
`exclusiveMinimum: true` into a 3.1 doc, validators interpret `true` as the *bound value 1* — a wrong
constraint that may pass linting and silently reject valid `maxPoints`/`limit` values. This is exactly
the kind of drift the CI lint in §6 catches. **Action:** never copy 3.0 schema fragments into a 3.1 doc
by hand; let Pydantic emit them. Pydantic v2 emits the numeric 2020-12 form natively.

### 1.2 The dialect detail: `$schema` and `jsonSchemaDialect`

3.1 lets a document declare which JSON Schema dialect its Schema Objects use. Per the spec: a
`jsonSchemaDialect` value "may be set within the OpenAPI Object to allow use of a different default
`$schema` value for all Schema Objects … If this default is not set, then the OAS dialect schema id MUST
be used," and "The value of `$schema` within a Schema Object always overrides any default." [oas31-dialect]
The default OAS dialect id is `https://spec.openapis.org/oas/3.1/dialect/base`, which *is* 2020-12 plus
OAS-specific keywords (`discriminator`, `xml`, `externalDocs`, `example`). [oas31-dialect]

**Practical stance for us.** Do **not** set a custom `jsonSchemaDialect` — accept the default OAS dialect
(2020-12-based). FastAPI does not emit a `jsonSchemaDialect` field, and that is correct: the default is
exactly what you want. Only set it if you embed schemas authored against a *different* draft, which you
will not. Mentioning it here is to inoculate against a future "let's add `$schema` everywhere" cargo-cult
— it is unnecessary and some older tools choke on it.

### 1.3 The decision table (3.1 vs 3.0 for this product line)

| Axis | OpenAPI 3.0.x | OpenAPI 3.1.x | Verdict for us |
|---|---|---|---|
| Schema model | Modified subset of an old JSON Schema draft | **Superset of JSON Schema 2020-12** [oas31-spec] | **3.1** — faithful, lossless SDK types |
| Nullability | `nullable: true` (vendor) | `type: [T, "null"]` (standard) [oas-upgrade] | **3.1** — `T \| null` in TS directly |
| Examples | media-type `example` only | `examples[]` on any schema [beeceptor] | **3.1** — examples travel with `$ref` |
| Webhooks | not modeled (x-ext hacks) | top-level `webhooks` [lornajane] | **3.1** — batch/revision events documented |
| Tooling maturity (2026) | very mature | mature; Spectral/oasdiff/Hey-API all support 3.1 | **3.1** — no longer an early-adopter tax |
| FastAPI default | n/a | **emits 3.1.0 by default** [fastapi-openapi-utils] | **3.1** — zero effort, it's the default |

**There is no reason to target 3.0 for a greenfield 2026 data API.** The only historical argument
(tooling gaps) is closed: Spectral lints 3.1, oasdiff diffs 3.1, Hey-API/openapi-generator gen from 3.1.

---

## 2. FastAPI emits 3.1 natively — and the knobs that make it *clean*

### 2.1 What FastAPI does for free

FastAPI builds the OpenAPI document from your routes and Pydantic models: "For every route in your
FastAPI application, FastAPI adds an operation to the OpenAPI document." [speakeasy-fastapi] The version
is **3.1.0 by default** — confirmed in source, `get_openapi(..., openapi_version: str = "3.1.0", ...)`
and `output: dict[str, Any] = {"openapi": openapi_version, "info": info}`. [fastapi-openapi-utils] You get
the live spec three ways:

- `GET /openapi.json` — served by the running app.
- `app.openapi()` — the Python method that builds (and caches in `app.openapi_schema`) the dict.
- Swagger UI at `/docs`, ReDoc at `/redoc`.

The default is *correct* but *ugly* for SDK generation. The next three subsections fix the three things
that make a generated SDK pleasant: stable operationIds, tags-as-services, and reusable schemas.

### 2.2 Stable, clean `operationId`s (the #1 SDK-quality lever)

**The problem.** Every operation needs a globally-unique `operationId` (OpenAPI requires it). FastAPI's
default generator, in `fastapi/utils.py`, builds it from the function name + path + method:
[fastapi-utils]

```python
# fastapi/utils.py — the DEFAULT generator (read this run, master)
def generate_unique_id(route: "APIRoute") -> str:
    operation_id = f"{route.name}{route.path_format}"
    operation_id = re.sub(r"\W", "_", operation_id)
    assert route.methods
    operation_id = f"{operation_id}_{list(route.methods)[0].lower()}"
    return operation_id
```

So `read_burger(burger_id)` at `GET /burger/{burger_id}` becomes
`read_burger_burger__burger_id__get`. The FastAPI docs are blunt about the consequence: "Right now, the
generated method names like `createItemItemsPost` don't look very clean … because the client generator
uses the OpenAPI internal **operation ID** … FastAPI uses the **function name**, the **path**, and the
**HTTP method/operation** to generate that operation ID." [fastapi-generate-clients] The SDK call site
then reads `ItemsService.createItemItemsPost(...)` — noise no human wants. [fastapi-generate-clients]

**The fix — option A (per-operation `operation_id`).** Explicit, surgical, verbose. From the FastAPI
advanced-config docs: [fastapi-path-adv]

```python
@app.get("/items/", operation_id="some_specific_id_you_define")
async def read_items():
    return [{"item_id": "Foo"}]
```

**The fix — option B (a project-wide `generate_unique_id_function`).** Pass a callable that receives each
`APIRoute` and returns the id. The simplest faithful version uses the function name: [fastapi-path-adv]

```python
from fastapi import FastAPI
from fastapi.routing import APIRoute

def custom_generate_unique_id(route: APIRoute) -> str:
    return route.name

app = FastAPI(generate_unique_id_function=custom_generate_unique_id)
```

> **Warning (verbatim from the docs):** "If you do this, you have to make sure each one of your *path
> operation functions* has a unique name. Even if they are in different modules (Python files)."
> [fastapi-path-adv]

**The fix — option C (tags + name — the recommended production form).** The official generate-clients doc
recommends combining the primary tag with the function name, which gives both a stable id *and* the data a
generator needs to group methods into service classes: [fastapi-generate-clients]

```python
from fastapi import FastAPI
from fastapi.routing import APIRoute

def custom_generate_unique_id(route: APIRoute) -> str:
    return f"{route.tags[0]}-{route.name}"

app = FastAPI(generate_unique_id_function=custom_generate_unique_id)
```

This yields ids like `series-get_observations`, `catalog-search`. Hey-API/openapi-generator turn the tag
prefix into a service class and the suffix into the method. [fastapi-generate-clients]

**Our convention.** Use **option C** but with a defensive function-name policy so ids are *already*
camelCase-friendly and tag-safe even if a route has no tag (so the app never 500s building the spec):

```python
from fastapi.routing import APIRoute

def dq_unique_id(route: APIRoute) -> str:
    """Project-wide operationId generator.

    Result: '<primaryTag>_<functionName>' -> e.g. 'series_getObservations'.
    - We NAME functions in camelCase-equivalent snake (getObservations) so the
      suffix is a clean SDK method after a snake->camel pass.
    - Falls back to 'default' tag so a missing tag never crashes spec build.
    """
    tag = route.tags[0] if route.tags else "default"
    return f"{tag}_{route.name}"
```

> **Stability is the contract, not just cleanliness.** An `operationId` is a *client-facing identifier*:
> SDK method names, MCP tool names, and analytics keys derive from it. **Renaming an operationId is a
> breaking change** even if the URL is unchanged — oasdiff flags `api-operation-id-removed` /
> `api-operation-id-changed`. Treat operationIds like public API; choose them deliberately and freeze them.
> [oasdiff-breaking]

### 2.3 Tags → SDK service classes (and navigable docs)

Tags do double duty: they group operations in Swagger/ReDoc *and* they tell the SDK generator how to
partition methods into classes. "If you generate a client for a FastAPI app using tags, it will normally
also separate the client code based on the tags." → `ItemsService`, `UsersService`.
[fastapi-generate-clients] Declare tag metadata (description, order) on the app: [speakeasy-fastapi]

```python
tags_metadata = [
    {"name": "catalog", "description": "Dataset discovery & search (no numbers)."},
    {"name": "series",  "description": "Time-series observation retrieval."},
    {"name": "batch",   "description": "Bulk extract jobs & delivery."},
]

app = FastAPI(openapi_tags=tags_metadata)

@app.get("/v1/series/{series_id}/observations", tags=["series"])
async def getObservations(...): ...
```

**Rule: exactly one *primary* tag per operation.** A route may carry a secondary tag for docs grouping,
but the `generate_unique_id_function` uses `route.tags[0]`, so the *first* tag is contractually the
service. Order tags consistently (declare the primary first on every route).

### 2.4 Separate input/output schemas — the Pydantic v2 nuance

Since Pydantic v2, FastAPI may emit **two** JSON Schemas for one model — one for input (request) and one
for output (response) — because fields with defaults are required on the way out but optional on the way
in. The FastAPI docs: "in some cases [it] will have two JSON Schemas in OpenAPI for the same Pydantic
model, for input and output." You can disable with `separate_input_output_schemas=False`. [fastapi-sep-io]

**Our stance: keep it `True` (the default).** The docs are explicit it makes the spec "more precise, and
if you have autogenerated clients and SDKs, they will be more precise too." [fastapi-sep-io] The cost is
schemas named `ObservationInput` / `ObservationOutput`; that is fine and *correct* — a client building a
request and a client reading a response genuinely face different required-field sets. Disable it only if a
downstream generator you're stuck with can't handle the `-Input`/`-Output` suffixes.

> **Pydantic v2.4.0+ gotcha (verbatim caveat):** "since Pydantic v2.4.0, default values are serialized as
> non-required by default, and to enable the schema separation behavior, you must add … `model_config =
> ConfigDict(json_schema_serialization_defaults_required=True)` to your model." [fastapi-sep-io] If your
> output schemas look wrong (defaulted fields marked optional when they should be required), this is why.

### 2.5 Overriding `app.openapi()` to stamp document-level metadata

To inject things FastAPI doesn't set from routes — `servers`, `security` global requirement, license SPDX
`identifier`, contact, `x-` vendor extensions — override `app.openapi()` and cache the result. Verbatim
pattern from the FastAPI docs: [fastapi-extending]

```python
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

app = FastAPI()

def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="Custom title",
        version="2.5.0",
        summary="This is a very custom OpenAPI schema",
        description="Here's a longer description of the custom **OpenAPI** schema",
        routes=app.routes,
    )
    openapi_schema["info"]["x-logo"] = {
        "url": "https://fastapi.tiangolo.com/img/logo-margin/logo-teal.png"
    }
    app.openapi_schema = openapi_schema
    return app.openapi_schema

app.openapi = custom_openapi
```

`get_openapi`'s full signature (read this run) shows every document-level knob you can set:
[fastapi-openapi-utils]

```python
def get_openapi(
    *,
    title: str,
    version: str,
    openapi_version: str = "3.1.0",
    summary: str | None = None,
    description: str | None = None,
    routes: Sequence[BaseRoute | routing.RouteContext],
    webhooks: Sequence[BaseRoute | routing.RouteContext] | None = None,
    tags: list[dict[str, Any]] | None = None,
    servers: list[dict[str, str | Any]] | None = None,
    terms_of_service: str | None = None,
    contact: dict[str, str | Any] | None = None,
    license_info: dict[str, str | Any] | None = None,
    separate_input_output_schemas: bool = True,
    external_docs: dict[str, Any] | None = None,
) -> dict[str, Any]: ...
```

**Our override** stamps: `servers` (so the SDK base URL is correct per env), the SPDX `license` identifier
(3.1 supports `license.identifier` with an SPDX code [lornajane]), `contact`, and the global `security`
requirement (so every operation inherits OAuth2 unless it opts out). See the worked app in §7.

### 2.6 Dumping the spec to a file (the build step)

The spec must be a *committed artifact* so CI can lint/diff it and SDK gen can consume it offline. Two
ways:

```python
# scripts/dump_openapi.py — run in CI before lint/diff/codegen
import json
from pathlib import Path
from app.main import app  # the FastAPI() instance

def main() -> None:
    spec = app.openapi()              # builds + caches the 3.1.0 dict
    Path("openapi.json").write_text(json.dumps(spec, indent=2, sort_keys=True))

if __name__ == "__main__":
    main()
```

`sort_keys=True` makes the file **diff-stable** (dict ordering changes otherwise produce noise diffs).
Alternatively, FastAPI ships a one-liner via the running server: `curl localhost:8000/openapi.json -o
openapi.json` — but the in-process dump is preferred in CI (no server to boot). Hey-API can read either
the URL or the file: `npx @hey-api/openapi-ts -i ./openapi.json -o src/client`. [fastapi-generate-clients]

---

## 3. Document the cross-cutting schemas ONCE → `$ref` everywhere

The whole point of `components` is *define once, reference many*. Four cross-cutting concerns recur on
every endpoint; each gets exactly one component definition and a `$ref` at every use site. Inline-repeating
them is the single most common way a spec rots (the 40th copy of the error shape drifts from the 1st).

### 3.1 The pagination envelope (one cursor model, reused)

Our retrieval and discovery endpoints are cursor-paginated (see `theory-pagination-cursor-vs-offset.md`
for *why* cursor, not offset). The page wrapper and the cursor params are components:

```yaml
components:
  schemas:
    Page:                              # generic envelope; data is endpoint-specific
      type: object
      required: [data, page]
      properties:
        data:
          type: array
          items: {}                    # overridden per-endpoint via allOf
        page:
          $ref: '#/components/schemas/PageMeta'
    PageMeta:
      type: object
      required: [hasMore]
      properties:
        hasMore: { type: boolean, examples: [true] }
        nextCursor:
          type:    ["string", "null"]  # 3.1 union: opaque cursor or null on last page
          examples: ["eyJvZmZzZXQiOjUwMH0", null]
  parameters:
    Cursor:
      name: cursor
      in: query
      required: false
      schema: { type: ["string", "null"] }
      description: Opaque forward cursor from the previous page's `nextCursor`.
    Limit:
      name: limit
      in: query
      required: false
      schema: { type: integer, minimum: 1, maximum: 1000, default: 100 }
```

In Pydantic v2 (which is what actually *emits* this), the envelope is a generic model:

```python
from typing import Generic, TypeVar
from pydantic import BaseModel, Field

T = TypeVar("T")

class PageMeta(BaseModel):
    has_more: bool = Field(serialization_alias="hasMore", examples=[True])
    next_cursor: str | None = Field(
        default=None, serialization_alias="nextCursor",
        examples=["eyJvZmZzZXQiOjUwMH0", None],
    )

class Page(BaseModel, Generic[T]):
    data: list[T]
    page: PageMeta
```

`Page[Observation]` as a `response_model` makes FastAPI emit a concrete `Page_Observation_` schema that
`$ref`s `Observation` and `PageMeta` — one envelope, every list endpoint. The `next_cursor: str | None`
emits the 3.1 union `type: ["string","null"]` (the §1.1a change) so the SDK models "last page" as `null`,
not a missing field.

### 3.2 The error contract — RFC 9457 Problem Details (one shape, every 4xx/5xx)

**Use RFC 9457 `application/problem+json`, not a bespoke `{error: "..."}`.** RFC 9457 ("Problem Details
for HTTP APIs") defines a JSON object served as media type `application/problem+json` with five canonical
members: [rfc9457]

- `type` — "a JSON string containing a URI reference that identifies the problem type." Absent ⇒ assumed
  `"about:blank"`. [rfc9457]
- `title` — "a short, human-readable summary of the problem type." [rfc9457]
- `status` — "a JSON number indicating the HTTP status code." [rfc9457]
- `detail` — "a human-readable explanation specific to this occurrence." [rfc9457]
- `instance` — "a URI reference that identifies the specific occurrence." [rfc9457]

Extension members are allowed and unknown ones MUST be ignored by clients. [rfc9457] The canonical example
from the RFC: [rfc9457]

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

The component (extended with our domain members — `code`, `traceId`, and a typed `errors[]` for field
validation, which is where it differs from FastAPI's default `{"detail": ...}` body):

```yaml
components:
  schemas:
    Problem:
      type: object
      required: [type, title, status]
      properties:
        type:
          type: string
          format: uri-reference
          default: "about:blank"
          examples: ["https://errors.dq.example/series-not-found"]
        title:    { type: string, examples: ["Series not found"] }
        status:   { type: integer, examples: [404] }
        detail:   { type: ["string", "null"], examples: ["No series with id 'GDP.US.FOO'."] }
        instance: { type: ["string", "null"], format: uri-reference }
        # --- our extension members (RFC 9457 §3.2 allows these) ---
        code:     { type: string, examples: ["SERIES_NOT_FOUND"], description: "Stable machine code; the SDK switches on this, not on `title`." }
        traceId:  { type: ["string", "null"], examples: ["a1b2c3d4"] }
        errors:
          type: array
          items: { $ref: '#/components/schemas/FieldError' }
          description: "Per-field problems for 422 validation failures."
    FieldError:
      type: object
      required: [field, message]
      properties:
        field:   { type: string, examples: ["maxPoints"] }
        message: { type: string, examples: ["must be <= 50000"] }
```

> **`type`/`title`/`status` are the contract; `code` is the switch.** The RFC says clients should match on
> the `type` URI, but a *stable short string* (`code`) is friendlier for SDK `switch` statements and is the
> field your generated client's error union should key on. Keep `type` for humans/links and `code` for
> machines. The full error catalogue + status-code mapping lives in
> `patterns-error-contract-and-status-codes.md`; this section only ensures it is *one documented schema*.

In FastAPI, model it as a Pydantic class and register it as the response for error statuses so it appears
in the spec:

```python
from pydantic import BaseModel

class Problem(BaseModel):
    type: str = "about:blank"
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None
    code: str | None = None
    trace_id: str | None = None

# Per-operation: declare which errors an op can return (this is what SDK gen reads)
@app.get(
    "/v1/series/{series_id}/observations",
    tags=["series"],
    responses={
        404: {"model": Problem, "description": "Series not found"},
        422: {"model": Problem, "description": "Invalid query parameters"},
        429: {"model": Problem, "description": "Rate limit exceeded"},
    },
)
async def getObservations(...): ...
```

A repeated `responses` block is itself boilerplate — hoist the common set into a module constant and spread
it (`responses={**COMMON_ERRORS, 404: {...}}`) so every operation documents the same error envelope.

### 3.3 Rate-limit headers — reusable `components.headers`, `$ref`-ed on responses

Rate-limit signaling rides in response headers (the `RateLimit`/`RateLimit-Policy` family per the
IETF draft, and the de-facto `X-RateLimit-*` set). OpenAPI 3.1 lets you define headers once under
`components.headers` and `$ref` them from any response. The community confirms `X-RateLimit-Remaining`
"The number of requests left for the time window" as an integer-schema header referenced via
`$ref: '#/components/headers/...'`. [speakeasy-headers]

```yaml
components:
  headers:
    RateLimit-Limit:
      description: Request quota for the current window.
      schema: { type: integer, examples: [1000] }
    RateLimit-Remaining:
      description: Requests left in the current window.
      schema: { type: integer, examples: [987] }
    RateLimit-Reset:
      description: Seconds until the window resets.
      schema: { type: integer, examples: [42] }
    Retry-After:
      description: Seconds to wait before retrying (sent on 429/503).
      schema: { type: integer, examples: [30] }
```

Referenced on a response:

```yaml
paths:
  /v1/series/{seriesId}/observations:
    get:
      responses:
        '200':
          description: Observations
          headers:
            RateLimit-Limit:     { $ref: '#/components/headers/RateLimit-Limit' }
            RateLimit-Remaining: { $ref: '#/components/headers/RateLimit-Remaining' }
            RateLimit-Reset:     { $ref: '#/components/headers/RateLimit-Reset' }
        '429':
          description: Rate limit exceeded
          headers:
            Retry-After: { $ref: '#/components/headers/Retry-After' }
          content:
            application/problem+json:
              schema: { $ref: '#/components/schemas/Problem' }
```

FastAPI does not auto-document response headers from `Response.headers`, so this is one place you *do*
reach for `openapi_extra` on the route (or the `app.openapi()` override) to attach the `headers` map. The
full budget/algorithm is in `patterns-rate-limiting-and-quotas.md`; here we only ensure the headers are
*declared once and referenced*.

### 3.4 The security scheme — OAuth2 `clientCredentials` (machine-to-machine)

A data-plane consumed by SDKs, batch jobs, and an Excel add-in is **machine-to-machine**: the right OAuth2
flow is **`clientCredentials`** (a service exchanges a client id/secret for a token — no human, no browser
redirect). This is exactly the flow OpenAPI 3.1 models under `securitySchemes` → `oauth2` → `flows` →
`clientCredentials`.

FastAPI ships `OAuth2PasswordBearer` and `OAuth2AuthorizationCodeBearer` but **not** a built-in
`clientCredentials` class — so we subclass `OAuth2` and pass an `OAuthFlowsModel(clientCredentials=...)`.
The base-class pattern (read this run from `fastapi/security/oauth2.py`): the `OAuth2` class takes a
`flows` argument and stores it as the model; `OAuth2AuthorizationCodeBearer` builds
`OAuthFlowsModel(authorizationCode={...})`. [fastapi-oauth2] The community-standard client-credentials
subclass follows the identical shape: [fastapi-oauth2]

```python
from typing import Any
from fastapi.security import OAuth2
from fastapi.openapi.models import OAuthFlows as OAuthFlowsModel

class OAuth2ClientCredentials(OAuth2):
    """Documents a clientCredentials flow in OpenAPI + extracts the bearer token.

    Pattern mirrors fastapi.security.OAuth2AuthorizationCodeBearer, which builds
    OAuthFlowsModel(authorizationCode={...}); we build clientCredentials={...}.
    """
    def __init__(
        self,
        token_url: str,
        scopes: dict[str, str] | None = None,
        scheme_name: str | None = None,
        description: str | None = None,
        auto_error: bool = True,
    ) -> None:
        flows = OAuthFlowsModel(
            clientCredentials={"tokenUrl": token_url, "scopes": scopes or {}}
        )
        super().__init__(
            flows=flows,
            scheme_name=scheme_name,
            description=description,
            auto_error=auto_error,
        )
```

This emits the following into `components.securitySchemes` (and Swagger UI renders a working "Authorize"
button for it):

```yaml
components:
  securitySchemes:
    OAuth2ClientCredentials:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://auth.dq.example/oauth/token
          scopes:
            "series:read":  Read time-series observations
            "catalog:read": Browse the dataset catalog
            "batch:write":  Submit and download batch extracts
security:
  - OAuth2ClientCredentials: ["series:read"]   # global default requirement
```

Wire it as a dependency so the scheme attaches to operations and the token is extracted by closure (never
supplied by the caller as a query param):

```python
oauth2 = OAuth2ClientCredentials(
    token_url="https://auth.dq.example/oauth/token",
    scopes={
        "series:read":  "Read time-series observations",
        "catalog:read": "Browse the dataset catalog",
        "batch:write":  "Submit and download batch extracts",
    },
    scheme_name="OAuth2ClientCredentials",
)

async def require_scope(scope: str):
    async def _dep(token: str = Depends(oauth2)) -> Claims:
        claims = verify_jwt(token)            # validate sig/exp/aud against the IdP JWKS
        if scope not in claims.scopes:
            raise HTTPException(403, "insufficient_scope")
        return claims
    return _dep
```

> **Scopes are documentation AND enforcement.** The scope strings in the security scheme appear in the spec
> (so SDK docs show what each token needs) *and* are checked in `require_scope`. Keep them in sync — a
> scope documented but unenforced is a lie; a scope enforced but undocumented surprises every integrator.

---

## 4. The two-spec problem: TS gateway vs FastAPI data-plane

### 4.1 Why there are two specs at all

This product line has two HTTP surfaces, by design (see `theory-batch-channel-architecture.md` and the
project system-design doc):

- **The TS/Express gateway** — the *public face*. Auth, rate-limiting, request shaping, response
  envelopes, the channels (REST, batch job submission, webhooks). This is what external clients and SDKs
  talk to. Its spec is generated from the TS route definitions (e.g. `zod-openapi`, `@hono/zod-openapi`,
  `tsoa`, or `fastify`'s schema export — whichever the gateway uses).
- **The Python/FastAPI data-plane** — the *internal* service that reads the time-series store, runs
  downsampling/aggregation, resolves the catalog. The gateway calls *it*. Its spec is FastAPI-emitted 3.1.0.

Two services ⇒ two OpenAPI documents. The failure mode is treating both as "the API" — clients then don't
know which is authoritative, SDKs get generated from the wrong one, and the two drift.

### 4.2 The reconcile rule: the gateway spec is the canonical public contract

```
   external SDK / Excel / batch client
              │  depends on
              ▼
   ┌───────────────────────────┐     internal HTTP      ┌──────────────────────────┐
   │  TS Express GATEWAY         │ ───────────────────▶  │  FastAPI DATA-PLANE        │
   │  gateway-openapi.json       │                       │  dataplane-openapi.json    │
   │  = THE PUBLIC CONTRACT      │                       │  = INTERNAL (private)      │
   │  (linted, diffed, SDK'd)    │                       │  (linted; NOT published)   │
   └───────────────────────────┘                       └──────────────────────────┘
```

**Decision: the published, client-facing, SDK-generating, oasdiff-gated contract is the *gateway* spec.**
Reasons:

1. **It's what clients actually call.** A breaking change is "breaking" relative to what a client depends
   on — and clients depend on the gateway. A change deep in the data-plane that the gateway absorbs (e.g. an
   internal field rename the gateway re-maps) is *not* a public break and must not fail the public diff.
2. **The gateway owns the cross-cutting envelope.** Pagination, RFC-9457 errors, rate-limit headers, and
   the OAuth2 scheme are gateway concerns (auth and limits live there). The §3 components belong in the
   gateway spec as the canonical definitions.
3. **The data-plane spec is still linted** (its own Spectral run) and its own oasdiff guards the
   *gateway↔data-plane* internal contract — but it is not the public artifact.

### 4.3 Keeping the two consistent — three concrete tactics

You don't want the gateway hand-re-typing the data-plane's models. Three ways to keep them in lockstep,
best first:

**Tactic 1 — Generate gateway client types FROM the data-plane spec.** The gateway imports the
data-plane's request/response types via codegen (`openapi-typescript` over `dataplane-openapi.json`), so a
data-plane model change surfaces as a TS compile error in the gateway. The gateway then re-exports a
*curated public subset* (it does not blindly forward every internal field). This makes the data-plane the
*type source* and the gateway the *public shaper* — drift becomes a build failure, not a runtime surprise.

```bash
# gateway build step: regenerate internal client types from the data-plane spec
npx openapi-typescript ./specs/dataplane-openapi.json -o ./src/generated/dataplane.d.ts
# tsc then fails if the gateway uses a field the data-plane removed/renamed
```

**Tactic 2 — Share component schemas via a single registry.** Define the cross-cutting schemas
(`Problem`, `Page`, `PageMeta`, rate-limit headers) ONCE — ideally as JSON Schema files or a shared
package — and have *both* specs `$ref` the same definitions (the gateway authors them; the data-plane
imports the same shapes via Pydantic models generated from them, or vice-versa). The error and pagination
shapes are identical on both surfaces, so define them in one place.

**Tactic 3 — A contract test that asserts gateway-forwarded fields exist in the data-plane.** A CI test
that, for every field the gateway claims to forward, asserts the data-plane spec actually provides it.
This catches "gateway promises a field the data-plane stopped sending" — the most dangerous silent break.
oasdiff can do the structural half: diff the *previous* data-plane spec against the *current* one and, on
any removal, require a gateway change in the same PR (a CODEOWNERS/required-check policy).

### 4.4 What NOT to do

- **Do not merge the two into one spec by hand.** A hand-merged `public.yaml` is drift-bait and defeats
  the whole "spec is a build output" discipline.
- **Do not publish the data-plane spec as the public contract.** Its operationIds, internal-only fields,
  and internal error codes are not a client API. Clients that bind to it bypass auth/limits and break when
  internals move.
- **Do not let the two diverge silently.** If you cannot wire Tactic 1, at minimum run a scheduled CI job
  that diffs the two and posts a report — visibility beats nothing.

---

## 5. Spec-as-CI-artifact — lint then breaking-diff, gating every PR

The spec earns "source of truth" only if CI *checks* it on every change. Two gates, in order: **Spectral**
(is it well-formed and governed?) then **oasdiff** (does this change break an existing client?).

### 5.1 Gate 1 — Spectral lint (style + governance)

Spectral is "a command line tool for linting OpenAPI and other schema for common patterns and
anti-patterns," with built-in support for "OpenAPI (v3.1, v3.0, and v2.0)." [spectral] Install + run:
[spectral]

```bash
npm install -g @stoplight/spectral-cli
spectral lint openapi.json --ruleset .spectral.yaml
```

A ruleset extends the built-in OAS rules and adds governance rules. The built-in set is `spectral:oas`;
[spectral] our additions enforce the conventions this doc establishes (every op tagged, every op has a
stable operationId, every op documents the error envelope):

```yaml
# .spectral.yaml
extends: ["spectral:oas"]                 # built-in OpenAPI rules (3.1-aware)
rules:
  # --- our governance rules ---
  operation-operationId:                  # SDK method names require it
    description: Every operation MUST declare an operationId.
    given: "$.paths[*][get,put,post,delete,patch]"
    severity: error
    then:
      field: operationId
      function: truthy
  operation-tags:                         # tags drive SDK service classes
    description: Every operation MUST have exactly one primary tag.
    given: "$.paths[*][get,put,post,delete,patch]"
    severity: error
    then:
      field: tags
      function: length
      functionOptions: { min: 1 }
  no-nullable-keyword:                     # 3.0 vestige; must use type:[T,null]
    description: "Use 3.1 union types, not the 3.0 `nullable` keyword."
    given: "$..properties[*]"
    severity: error
    then:
      field: nullable
      function: undefined
  problem-on-4xx:                          # every 4xx documents the Problem schema
    description: 4xx/5xx responses MUST use the application/problem+json schema.
    given: "$.paths[*][*].responses[?(@property.match(/^[45]/))].content"
    severity: warn
    then:
      field: "application/problem+json"
      function: truthy
```

> Spectral rules are `given` (a JSONPath selecting nodes) + `then` (a function like `truthy`, `length`,
> `undefined`, `pattern`) + `severity` (`error`/`warn`/`info`/`hint`). `error`-severity findings fail CI
> (exit non-zero). Run it as a required PR check so "every change is linted automatically." [spectral][axway-spectral]

### 5.2 Gate 2 — oasdiff breaking-change detection (the client-protection gate)

oasdiff "is a command-line tool to compare and detect breaking changes in OpenAPI specs," detecting
"470+ distinct changes" across "three severity categories" — `ERR` ("definite breaking changes which
should be avoided"), `WARN` ("potential breaking changes … cannot be confirmed programmatically as
breaking"), and informational. [oasdiff-breaking] Local usage: [oasdiff-breaking]

```bash
# Compare the merge-base spec (old) against the PR spec (new); fail on definite breaks.
oasdiff breaking ./specs/old/openapi.json ./specs/new/openapi.json --fail-on ERR
```

`--fail-on ERR` "exits with code 1 if error-level changes exist"; `--fail-on WARN` fails on warnings too.
[oasdiff-breaking] For a human-readable list of everything that changed (breaking and not), use
`oasdiff changelog <old> <new>`. [oasdiff-breaking] Output formats include `githubactions`, `junit`,
`markdown`, `html`, `json`, `text`. [oasdiff-breaking]

**What counts as breaking (examples relevant to us):** removing an operation; removing/renaming an
`operationId`; removing a response property a client reads; adding a *required* request parameter;
narrowing a type or enum; tightening `maxLength`/`maximum`. **Non-breaking:** adding an optional field;
adding a new operation; adding an enum value to a *response* (but adding one to a *request* enum can be
breaking depending on direction). This is why operationId and field *stability* (§2.2, §3) is contractual.

### 5.3 The combined GitHub Actions workflow

The oasdiff GitHub Action compares the PR spec against the base branch and fails on breaks. Verbatim
example from the action repo (adapted to our paths): [oasdiff-action]

```yaml
# .github/workflows/api-contract.yaml
name: api-contract
on:
  pull_request:
    branches: ["main"]
permissions:
  contents: read
  pull-requests: write
jobs:
  build-and-check-spec:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      # 1. Build the data-plane spec from code (no server boot)
      - uses: astral-sh/setup-uv@v3
      - run: uv sync
      - run: uv run python scripts/dump_openapi.py          # writes openapi.json (sorted, stable)

      # 2. Build the gateway (public) spec from the TS routes
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build:openapi                          # writes specs/gateway-openapi.json

      # 3. GATE 1 — lint both specs (style + governance)
      - run: npx @stoplight/spectral-cli lint openapi.json --ruleset .spectral.yaml
      - run: npx @stoplight/spectral-cli lint specs/gateway-openapi.json --ruleset .spectral.yaml

      # 4. GATE 2 — breaking-change diff of the PUBLIC (gateway) contract vs base branch
      - run: git fetch --depth=1 origin ${{ github.base_ref }}
      - uses: oasdiff/oasdiff-action/breaking@v0
        with:
          base: 'origin/${{ github.base_ref }}:specs/gateway-openapi.json'
          revision: 'HEAD:specs/gateway-openapi.json'
          fail-on: ERR
          github-token: ${{ github.token }}
```

The action's own example uses `base`/`revision` in git-ref form and `fail-on: WARN`; we set `ERR` for the
hard gate and can add a second non-blocking `oasdiff changelog` step to comment the full change list on the
PR. [oasdiff-action] The action posts review links as PR comments when `pull-requests: write` is granted.
[oasdiff-action]

> **Order matters: lint before diff.** A malformed spec makes the diff meaningless (oasdiff may misparse
> it). Spectral first guarantees the document is structurally sound and governed; oasdiff then reasons about
> *semantic* compatibility on a known-good document.

### 5.4 The SDK-gen step (the payoff)

With a stable, linted, non-breaking spec, SDK generation is deterministic. TS (Hey-API, the FastAPI-docs
recommendation): [fastapi-generate-clients]

```bash
npx @hey-api/openapi-ts -i ./specs/gateway-openapi.json -o ./sdk/ts/src
```

If you used the `tag-name` operationId form and want the tag prefix stripped from method names before
generation, the FastAPI docs give the exact preprocessing script (run after dumping the spec, before
codegen): [fastapi-generate-clients]

```python
import json
from pathlib import Path

file_path = Path("./openapi.json")
openapi_content = json.loads(file_path.read_text())

for path_data in openapi_content["paths"].values():
    for operation in path_data.values():
        tag = operation["tags"][0]
        operation_id = operation["operationId"]
        to_remove = f"{tag}-"
        new_operation_id = operation_id[len(to_remove) :]
        operation["operationId"] = new_operation_id

file_path.write_text(json.dumps(openapi_content))
```

This turns `series-get_observations` → `get_observations`, so the method is `SeriesService.getObservations`
rather than `SeriesService.seriesGetObservations`. [fastapi-generate-clients] Run SDK gen on tagged
releases (not every PR) so the published SDK tracks released contract versions.

---

## 6. The worked FastAPI app (runnable skeleton)

Everything above, assembled. This is the recipe to write — a single-file sketch of the data-plane app with
the security scheme, tags, stable operationIds, the pagination envelope, the RFC-9457 error model, a
documented paginated response, and a documented error response. Real code splits into routers/services/
repositories (see `python-fastapi-data-service`); this is the *contract surface* condensed.

```python
# app/main.py  —  FastAPI data-plane: the OpenAPI 3.1 contract source
from __future__ import annotations

from typing import Any, Generic, TypeVar

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.openapi.models import OAuthFlows as OAuthFlowsModel
from fastapi.openapi.utils import get_openapi
from fastapi.routing import APIRoute
from fastapi.security import OAuth2
from pydantic import BaseModel, Field

# ──────────────────────────────────────────────────────────────────────────────
# 1. Stable operationIds (§2.2 option C, defensive)
# ──────────────────────────────────────────────────────────────────────────────
def dq_unique_id(route: APIRoute) -> str:
    tag = route.tags[0] if route.tags else "default"
    return f"{tag}_{route.name}"

# ──────────────────────────────────────────────────────────────────────────────
# 2. OAuth2 clientCredentials scheme (§3.4) — machine-to-machine
# ──────────────────────────────────────────────────────────────────────────────
class OAuth2ClientCredentials(OAuth2):
    def __init__(self, token_url: str, scopes: dict[str, str] | None = None,
                 scheme_name: str | None = None, auto_error: bool = True) -> None:
        flows = OAuthFlowsModel(clientCredentials={"tokenUrl": token_url, "scopes": scopes or {}})
        super().__init__(flows=flows, scheme_name=scheme_name, auto_error=auto_error)

oauth2 = OAuth2ClientCredentials(
    token_url="https://auth.dq.example/oauth/token",
    scopes={
        "series:read":  "Read time-series observations",
        "catalog:read": "Browse the dataset catalog",
    },
    scheme_name="OAuth2ClientCredentials",
)

class Claims(BaseModel):
    sub: str
    scopes: list[str]

def verify_jwt(token: str) -> Claims:                  # validate against IdP JWKS in real code
    ...                                                 # raises 401 on bad sig/exp/aud
    return Claims(sub="svc", scopes=["series:read", "catalog:read"])

def require_scope(scope: str):
    async def _dep(token: str = Depends(oauth2)) -> Claims:
        claims = verify_jwt(token)
        if scope not in claims.scopes:
            raise HTTPException(403, detail="insufficient_scope")
        return claims
    return _dep

# ──────────────────────────────────────────────────────────────────────────────
# 3. Cross-cutting models (§3.1 pagination, §3.2 RFC-9457 error)
# ──────────────────────────────────────────────────────────────────────────────
T = TypeVar("T")

class PageMeta(BaseModel):
    has_more: bool = Field(serialization_alias="hasMore", examples=[True])
    next_cursor: str | None = Field(default=None, serialization_alias="nextCursor",
                                    examples=["eyJvIjo1MDB9", None])  # emits type:[string,null]

class Page(BaseModel, Generic[T]):
    data: list[T]
    page: PageMeta

class Problem(BaseModel):
    type: str = "about:blank"
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None
    code: str | None = None
    trace_id: str | None = Field(default=None, serialization_alias="traceId")

class Observation(BaseModel):
    t: str = Field(examples=["2026-06-23"], description="ISO-8601 timestamp.")
    v: float | None = Field(examples=[20891.4, None],
                            description="Value; null on a true gap.")  # 3.1 union

# Common error responses, hoisted so every op documents the same envelope (§3.2)
COMMON_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": Problem, "description": "Unauthenticated"},
    403: {"model": Problem, "description": "Insufficient scope"},
    429: {"model": Problem, "description": "Rate limit exceeded"},
}

# ──────────────────────────────────────────────────────────────────────────────
# 4. The app + tag metadata (§2.3)
# ──────────────────────────────────────────────────────────────────────────────
tags_metadata = [
    {"name": "catalog", "description": "Dataset discovery & search (no numbers)."},
    {"name": "series",  "description": "Time-series observation retrieval."},
]

app = FastAPI(
    title="DataQuery Data-Plane",
    version="1.0.0",
    generate_unique_id_function=dq_unique_id,
    openapi_tags=tags_metadata,
    separate_input_output_schemas=True,                 # §2.4 — precise SDK types
)

# ──────────────────────────────────────────────────────────────────────────────
# 5. A documented, paginated, error-typed endpoint (§3 in one place)
# ──────────────────────────────────────────────────────────────────────────────
@app.get(
    "/v1/series/{series_id}/observations",
    tags=["series"],                                    # → SeriesService, operationId series_getObservations
    response_model=Page[Observation],                   # → $ref Page_Observation_ + Observation + PageMeta
    summary="Get observations for one series",
    responses={**COMMON_ERRORS, 404: {"model": Problem, "description": "Series not found"}},
)
async def getObservations(
    series_id: str,
    from_: str | None = Query(default=None, alias="from", examples=["2026-01-01"]),
    to: str | None = Query(default=None, examples=["2026-06-30"]),
    limit: int = Query(default=100, ge=1, le=1000),
    cursor: str | None = Query(default=None),
    _claims: Claims = Depends(require_scope("series:read")),
) -> Page[Observation]:
    # reads STORE + REDIS only — never an upstream provider on a user request
    return Page[Observation](data=[Observation(t="2026-06-23", v=20891.4)],
                             page=PageMeta(has_more=False, next_cursor=None))

# ──────────────────────────────────────────────────────────────────────────────
# 6. Document-level metadata via app.openapi() override (§2.5)
# ──────────────────────────────────────────────────────────────────────────────
def custom_openapi() -> dict[str, Any]:
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title, version=app.version, routes=app.routes,
        summary="Internal data-plane for the DataQuery re-engineering.",
        license_info={"name": "Proprietary", "identifier": "LicenseRef-Proprietary"},  # 3.1 SPDX field
        servers=[{"url": "https://dataplane.dq.internal", "description": "prod"}],
    )
    # global default security requirement (every op needs OAuth2 unless it opts out)
    schema["security"] = [{"OAuth2ClientCredentials": ["series:read"]}]
    app.openapi_schema = schema
    return app.openapi_schema

app.openapi = custom_openapi
```

What this emits (verify by `GET /openapi.json`):
- `"openapi": "3.1.0"` at the root. [fastapi-openapi-utils]
- `operationId: "series_getObservations"` (clean, stable, tag-prefixed).
- A `Page_Observation_` schema `$ref`-ing `Observation` and `PageMeta`; `Observation.v` as
  `{"anyOf": [{"type":"number"},{"type":"null"}]}` (the 3.1 nullable form).
- `components.securitySchemes.OAuth2ClientCredentials` with the `clientCredentials` flow + scopes.
- Every op's `responses` documenting `Problem` (RFC-9457) at 401/403/404/429.
- A global `security` requirement and `info.license.identifier` (SPDX).

---

## 7. Anti-patterns → fixes (the failure catalogue)

| # | Anti-pattern | Why it breaks | Fix |
|---|---|---|---|
| 1 | **Hand-writing/maintaining the OpenAPI YAML** alongside the code | Drifts the instant code changes; the spec lies | Emit from FastAPI (`app.openapi()`); commit the dumped artifact; CI rebuilds it. [fastapi-openapi-utils] |
| 2 | **Shipping the default operationIds** (`read_x_v1_x__id__get`) | SDK method names are unreadable noise | `generate_unique_id_function = f"{tag}_{name}"` (§2.2). [fastapi-generate-clients] |
| 3 | **Renaming an operationId "just to clean it up"** | It's a client-facing id → SDK method rename = breaking | Freeze operationIds; oasdiff flags the change as ERR. [oasdiff-breaking] |
| 4 | **Targeting OpenAPI 3.0** for a 2026 greenfield | Lossy SDK types, `nullable` hacks, no webhooks; needless translation layer | Use 3.1 (FastAPI's default) — JSON Schema 2020-12 superset. [oas31-spec] |
| 5 | **Copying a 3.0 schema fragment into a 3.1 doc** | `nullable:true` ignored; `exclusiveMinimum:true` reinterpreted as bound `1` | Never hand-copy; let Pydantic emit; Spectral `no-nullable-keyword` rule catches it (§5.1). |
| 6 | **Inlining the error/pagination shape on every op** | The 40th copy drifts from the 1st | One `components.schemas.Problem`/`Page`; `$ref` everywhere (§3). |
| 7 | **A bespoke `{error:"..."}` body** instead of RFC 9457 | No standard; clients can't share error handling; no `type`/`status`/`detail` contract | `application/problem+json` + the `Problem` schema (§3.2). [rfc9457] |
| 8 | **`OAuth2PasswordBearer` for a machine-to-machine data API** | Password flow implies a human/credentials grant; wrong for service tokens | `clientCredentials` flow via the `OAuth2` subclass (§3.4). [fastapi-oauth2] |
| 9 | **A token/secret as a query param or model field** | Confused-deputy / leaks in logs & the spec | Extract via the security dependency (closure), `Depends(oauth2)` (§3.4). |
| 10 | **Treating the FastAPI data-plane spec as the public contract** | Internal fields/ids leak; clients bypass the gateway's auth/limits | Gateway spec is canonical public; data-plane is internal (§4). |
| 11 | **Two specs drifting with no link** | Gateway promises a field the data-plane stopped sending → runtime break | Generate gateway types from the data-plane spec (Tactic 1, §4.3). |
| 12 | **No CI gate on the spec** | Breaking changes ship silently; SDKs break in prod | Spectral lint → oasdiff `--fail-on ERR` on every PR (§5). [spectral][oasdiff-breaking] |
| 13 | **oasdiff before Spectral** | A malformed spec makes the diff meaningless | Lint first (structural+governance), then diff (semantic) (§5.3). |
| 14 | **Setting a custom `jsonSchemaDialect`/`$schema` everywhere** | Unnecessary; some tools choke; the OAS default *is* 2020-12 | Leave it unset; accept the default OAS dialect (§1.2). [oas31-dialect] |
| 15 | **Untagged operations** | SDK can't group into services; docs are a flat wall | Exactly one primary tag per op; Spectral `operation-tags` rule (§2.3, §5.1). |

---

## 8. Verification checklist (does the contract actually hold?)

Run these against the emitted `openapi.json` before declaring the contract done:

- [ ] Root says `"openapi": "3.1.0"` (or `3.1.1`). [fastapi-openapi-utils]
- [ ] No `nullable` keyword anywhere; nullable fields use `type: [T,"null"]` or `anyOf` with `null`.
      (Spectral `no-nullable-keyword` passes.)
- [ ] Every operation has a non-empty `operationId` and exactly one primary tag. (Spectral
      `operation-operationId` + `operation-tags` pass.)
- [ ] operationIds are stable across the diff vs the last release (oasdiff shows no
      `api-operation-id-*` ERR). [oasdiff-breaking]
- [ ] `Problem` (RFC-9457) is referenced by every 4xx/5xx response; media type is
      `application/problem+json`. [rfc9457]
- [ ] `Page`/`PageMeta` is the single pagination envelope; `nextCursor` is `type:[string,null]`.
- [ ] Rate-limit headers exist once under `components.headers` and are `$ref`-ed on responses.
      [speakeasy-headers]
- [ ] `components.securitySchemes` has the `oauth2`→`clientCredentials` flow with scopes; a global
      `security` requirement is set. [fastapi-oauth2]
- [ ] `spectral lint` exits 0 with no `error`-severity findings. [spectral]
- [ ] `oasdiff breaking <base> <head> --fail-on ERR` exits 0 (no client-breaking change), or the change
      is intentional and the SDK major version is bumped. [oasdiff-breaking]
- [ ] The gateway (public) spec — not the data-plane spec — is the one wired into SDK gen and the oasdiff
      gate (§4.2).

---

## 9. Cross-references (where the rest lives)

- **Why two endpoints / the addressing model** → `theory-query-api-contract.md` (the contract this spec
  *describes*).
- **Cursor vs offset pagination** (why `nextCursor`, the opaque-cursor encoding) →
  `theory-pagination-cursor-vs-offset.md`.
- **The full error catalogue + status-code mapping** (every `code`/`type`, when each fires) →
  `patterns-error-contract-and-status-codes.md`. This doc only ensures it's *one documented schema*.
- **The rate-limit algorithm + budget** (sliding window, per-scope quotas) →
  `patterns-rate-limiting-and-quotas.md`. This doc only ensures the *headers are declared once*.
- **The series-retrieval and catalog-discovery endpoint shapes** →
  `patterns-series-retrieval-endpoint.md` / `patterns-catalog-discovery-endpoint.md`.
- **Batch jobs + webhook delivery events** (the `webhooks` block this spec documents) →
  `patterns-batch-delivery-transports.md` / `patterns-batch-file-and-manifest-format.md`.
- **The FastAPI app object, routers, lifespan, deploy** → the `python-fastapi-data-service` skill (this
  doc is its contract-surface layer).

---

## Sources (read this run, 2026-06)

- **[oas31-spec]** OpenAPI Specification v3.1.0 — Schema Object is "a superset of JSON Schema Specification
  Draft 2020-12". `https://spec.openapis.org/oas/v3.1.0.html`
- **[oas31-dialect]** OpenAPI 3.1 JSON Schema dialect — default OAS dialect id, `jsonSchemaDialect`,
  `$schema` override. `https://spec.openapis.org/oas/3.1/dialect/2024-11-10.html`
- **[oas31-components]** OpenAPI 3.1 Components Object (reusable `schemas`, `headers`, `parameters`,
  `securitySchemes`). `https://spec.openapis.org/oas/v3.1.0.html#components-object`
- **[oas-upgrade]** OpenAPI Initiative — Upgrading from 3.0 to 3.1 (nullable→type array;
  exclusiveMinimum numeric; example→examples; file uploads; `openapi: 3.1.1`).
  `https://learn.openapis.org/upgrading/v3.0-to-v3.1.html`
- **[lornajane]** LornaJane, "What's New in OpenAPI 3.1" (nullable removed, type arrays incl. `null`,
  `examples` array, top-level `webhooks`, paths/webhooks/components rule, `info.summary`, license SPDX
  `identifier`, `$ref` siblings). `https://lornajane.net/posts/2020/whats-new-in-openapi-3-1`
- **[beeceptor]** Beeceptor, "OpenAPI 3.1.0 Compared to 3.0.3" (`type:["string","null"]`, examples
  anywhere, `$schema`, webhooks, `$ref` siblings). `https://beeceptor.com/docs/concepts/openapi-what-is-new-3.1.0/`
- **[rfc9457]** RFC 9457, "Problem Details for HTTP APIs" (the 5 members type/title/status/detail/instance,
  `about:blank` default, `application/problem+json`, extension members, the example doc).
  `https://www.rfc-editor.org/rfc/rfc9457.html`
- **[fastapi-path-adv]** FastAPI docs — Path Operation Advanced Configuration (`operation_id`,
  `generate_unique_id_function`, the unique-function-name warning, `openapi_extra`, `include_in_schema`).
  `https://fastapi.tiangolo.com/advanced/path-operation-advanced-configuration/`
- **[fastapi-generate-clients]** FastAPI docs — Generating Clients (ugly default operationIds, the
  `f"{route.tags[0]}-{route.name}"` recipe, tags→service classes, the preprocessing strip script, Hey-API
  command). `https://fastapi.tiangolo.com/advanced/generate-clients/`
- **[fastapi-extending]** FastAPI docs — Extending OpenAPI (override `app.openapi()` with `get_openapi`,
  cache via `app.openapi_schema`, `x-logo`). `https://fastapi.tiangolo.com/how-to/extending-openapi/`
- **[fastapi-sep-io]** FastAPI docs — Separate OpenAPI Schemas for Input and Output
  (`separate_input_output_schemas`, the Pydantic v2.4 `json_schema_serialization_defaults_required` caveat).
  `https://fastapi.tiangolo.com/how-to/separate-openapi-schemas/`
- **[fastapi-utils]** FastAPI source `fastapi/utils.py` — the default `generate_unique_id(route)` body
  (read this run, master). `https://github.com/fastapi/fastapi/blob/master/fastapi/utils.py`
- **[fastapi-openapi-utils]** FastAPI source `fastapi/openapi/utils.py` — `get_openapi(... openapi_version:
  str = "3.1.0" ...)` and `output = {"openapi": openapi_version, "info": info}` (read this run).
  `https://github.com/fastapi/fastapi/blob/master/fastapi/openapi/utils.py`
- **[fastapi-oauth2]** FastAPI source `fastapi/security/oauth2.py` — `OAuth2`/`OAuthFlowsModel` pattern;
  `OAuth2AuthorizationCodeBearer` builds `OAuthFlowsModel(authorizationCode={...})`; the analogous
  `clientCredentials` subclass (read this run). `https://github.com/fastapi/fastapi/blob/master/fastapi/security/oauth2.py`
- **[speakeasy-fastapi]** Speakeasy, "How To Generate an OpenAPI Document With FastAPI" (FastAPI emits
  3.1.0; per-route `operation_id`; `openapi_tags`; the `custom_openapi` override pattern).
  `https://www.speakeasy.com/openapi/frameworks/fastapi`
- **[speakeasy-headers]** Speakeasy, "Headers in OpenAPI best practices" (`components.headers` +
  `$ref`; `X-RateLimit-Remaining` integer header). `https://www.speakeasy.com/openapi/responses/headers`
- **[spectral]** Stoplight Spectral (`@stoplight/spectral-cli`; `extends: spectral:oas`; supports OpenAPI
  v3.1/3.0/2.0; `given`/`then`/`severity` rules; CI usage). `https://github.com/stoplightio/spectral`
- **[axway-spectral]** Axway, "API Linting with Spectral" (governance rules in CI on every PR).
  `https://blog.axway.com/learning-center/apis/api-design/api-linting-with-spectral`
- **[oasdiff-breaking]** oasdiff — Breaking Changes docs (`oasdiff breaking <s1> <s2>`; `--fail-on ERR`;
  ERR/WARN levels; `--format`; `changelog`; 470+ change rules). `https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES.md`
- **[oasdiff-action]** oasdiff GitHub Action (`uses: oasdiff/oasdiff-action/breaking@v0`; `base`/`revision`
  git-ref inputs; `fail-on`; `github-token` for PR comments). `https://github.com/oasdiff/oasdiff-action`
- **[fastapi-pypi]** PyPI — fastapi 0.138.0 (released 2026-06-20). `https://pypi.org/project/fastapi/`
- **[pydantic-pypi]** PyPI — pydantic 2.13.4 (released 2026-05-06). `https://pypi.org/project/pydantic/`
