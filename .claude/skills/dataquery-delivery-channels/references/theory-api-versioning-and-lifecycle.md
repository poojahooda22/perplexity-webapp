# theory · API versioning & lifecycle — how the contract changes without breaking a pinned SDK

> **Scope.** This is the **versioning-and-lifecycle** reference for the `dataquery-delivery-channels`
> dev-skill — the **JPM-Markets re-engineering data-analytics product line (NOT Lumina)**. It answers one
> question: *how does the query-API contract evolve over time without silently breaking every consumer
> who has pinned an SDK against it?* Specifically: (1) **where the version lives** — URL path `/v1` vs a
> request header vs the `Accept` media type, and why the data-API world has converged on the path; (2)
> the **breaking-vs-additive taxonomy** — the exact list of changes that force a major bump versus the
> ones that ship in place; (3) the **deprecation policy** — `Deprecation`/`Sunset` headers (RFC 9745 /
> RFC 8594), the support window, and the changelog; (4) **CI contract-diff gating** — `oasdiff` to fail
> the build on an undocumented break and `spectral` to lint the spec; (5) why **not** to over-version
> (URI-footprint explosion, the N×M maintenance matrix); (6) **tying the generated SDK's semver to the
> API version**; and (7) the **expand-then-contract** migration that lets you make a "breaking" schema
> change inside one major version without a big-bang cutover.
>
> **Why this doc is load-bearing.** The whole point of this product line is that consumers — a quant's
> Python script, an Excel add-in, a scheduled Batch job, the MCP channel, our own dashboard — **pin a
> generated SDK** against the contract and walk away. The moment the contract changes shape underneath a
> pinned client, that client breaks *in production, silently, on the next deploy*, with no compile error
> and no test failure on our side. Versioning is the discipline that makes the contract a **promise**:
> "anything you built against `/v1` keeps working until we tell you, in headers and in a changelog, that
> `/v1` is sunsetting — and we give you N months." Every other reference in this skill assumes a stable
> contract; this doc is what *keeps* it stable while still letting it grow. It sits directly on top of
> [`theory-query-api-contract.md`](theory-query-api-contract.md) (which fixes *what* the two endpoints
> are) — this doc fixes *how those two endpoints change over their lifetime*.
>
> **Greenfield.** No codebase `file:line` exists yet. Citations are to (a) primary specs read this run
> (RFC 8594 Sunset, RFC 9745 Deprecation, RFC 9651 Structured Fields), (b) primary tool docs and source
> read this run (`oasdiff` v1.11.9, `@stoplight/spectral-cli`, the `oasdiff-action` GitHub Action), (c)
> primary vendor docs (Stripe API versioning, FRED API v2, World Bank Indicators API v2), and (d)
> API-design guidance (Speakeasy, Martin Fowler's Parallel Change). The code here is the recipe to write,
> not a description of code that exists.
>
> **Versions / sources pinned this run (2026-06).** `oasdiff` **v1.11.9** (released 2026-02-02,
> `oasdiff/oasdiff`) · `oasdiff-action` `breaking@v0` · `@stoplight/spectral-cli` (npm, latest) · RFC
> 8594 (Sunset, Feb 2019) · RFC 9745 (Deprecation, 2025) · RFC 9651 (Structured Field Values, 2024) ·
> Stripe API versioning docs (`docs.stripe.com/api/versioning`, current default `2026-05-27.dahlia`) ·
> FRED API docs (`fred.stlouisfed.org/docs/api/fred/`, **v2 launched Nov 2025**) · World Bank Indicators
> API v2 (`api.worldbank.org/v2`). **Re-confirm every version before pinning it in code.**

---

## 0. The thirty-second policy (read this first)

```
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  THE VERSIONING & LIFECYCLE POLICY                                              │
  │                                                                                │
  │  1. VERSION IN THE URL PATH.   /v1/catalog   /v1/series/{id}/observations      │
  │       Visible, cacheable, routable, browser-testable. The data-API norm        │
  │       (FRED /fred/v2/…, World Bank /v2, JPM DataQuery /api/v2). Major only.     │
  │                                                                                │
  │  2. ADDITIVE → SHIP IN PLACE.  New endpoint · new OPTIONAL param · new          │
  │       response field. NO version bump. The contract only grows. (Stripe,       │
  │       Speakeasy, Google AIP.)                                                   │
  │                                                                                │
  │  3. BREAKING → NEW MAJOR.  Remove/rename a field · change a type · tighten      │
  │       validation · make a param required · change pagination/defaults →         │
  │       /v1 → /v2. Old major keeps running through its window.                    │
  │                                                                                │
  │  4. DEPRECATE, DON'T DELETE.  Deprecation: <date> + Sunset: <date> headers      │
  │       (RFC 9745 / RFC 8594) + a changelog entry + a window (≥180 days for a     │
  │       stable surface). Remove ONLY after the sunset date passes.               │
  │                                                                                │
  │  5. CI GATES THE BREAK.  oasdiff breaking --fail-on ERR fails the build on an   │
  │       undocumented breaking change; spectral lint enforces spec hygiene.       │
  │       The OpenAPI spec is the contract; CI is the enforcement.                 │
  │                                                                                │
  │  6. SDK SEMVER TRACKS THE CONTRACT.  Generated SDK major == API major;          │
  │       additive API change → SDK minor; spec-internal fix → SDK patch.          │
  │                                                                                │
  │  7. DON'T OVER-VERSION.  Two live majors at most. Each new /vN is an N×M        │
  │       maintenance matrix — expand-then-contract inside a major beats a new      │
  │       major almost every time.                                                  │
  └──────────────────────────────────────────────────────────────────────────────┘
```

**The seven rules established here (each graded in §11):**

1. **Major version in the URL path** (`/v1/...`), nowhere else.
2. **Additive changes never bump the version** — the contract grows, it doesn't fork.
3. **Breaking changes are a closed, enumerated list** (§3) — if a change is on it, it forces a major; if it isn't, it ships in place.
4. **Nothing is deleted without a `Deprecation` + `Sunset` header, a changelog entry, and a window.**
5. **CI fails the build on an undocumented breaking change** via `oasdiff`, and lints the spec via `spectral`.
6. **The generated SDK's semver is derived mechanically from the contract diff.**
7. **At most two live majors; expand-then-contract inside a major is the default migration**, not a new `/vN`.

---

## 1. Where the version goes: URL path vs header vs media type

This is the first and most-consequential fork. Once you pick, every channel adapter (SDK, Excel, Batch,
MCP) inherits it, and undoing it is itself a breaking change. We pick **URL path** and defend it below.

### 1.1 The three options, with concrete request shapes

| Strategy | What the request looks like | Where the version lives |
|---|---|---|
| **URL path** | `GET https://api.example.com/v1/series/USD_GDP/observations` | The path segment `/v1`. Visible in every URL, log line, and bookmark. |
| **Custom header** | `GET /series/USD_GDP/observations` + `Api-Version: 1` | A request header. URL is version-free. ([lonti.com](https://www.lonti.com/blog/api-versioning-url-vs-header-vs-media-type-versioning) — exact header form `Api-Version: 1`.) |
| **Media type (content negotiation)** | `GET /series/USD_GDP/observations` + `Accept: application/vnd.example.v1+json` (or `Accept: application/json; version=1`) | The `Accept` header's media type. ([lonti.com](https://www.lonti.com/blog/api-versioning-url-vs-header-vs-media-type-versioning) gives `Accept: application/json; version=1`.) |

Stripe is the canonical **header**-based outlier in the *date-based* school: the version is a
`Stripe-Version` request header carrying a date+codename string, e.g.
`Stripe-Version: 2026-05-27.dahlia`, and the default lives on the account
([docs.stripe.com/api/versioning](https://docs.stripe.com/api/versioning), read this run). We discuss
why that model works *for Stripe* and not for us in §1.4.

### 1.2 The trade-off matrix (the load-bearing comparison)

| Axis | URL path `/v1` | Header `Api-Version: 1` | Media type `vnd…v1+json` |
|---|---|---|---|
| **Visibility / debuggability** | ✅ version is in the URL — obvious in logs, traces, bookmarks, error reports | ❌ invisible until you inspect headers; "which version is this 500 from?" is a header-dump away | ❌ same — invisible, and *more* obscure (buried in `Accept`) |
| **Browser / curl testability** | ✅ paste the URL in a browser, it works | ⚠️ needs a header → curl/Postman, not a browser bar | ⚠️ needs a crafted `Accept` → curl/Postman, harder still |
| **CDN / proxy caching** | ✅ each version is a **distinct cache key by URL** — caches, CDNs, load balancers route/cache/log each version independently with zero config ([lonti](https://www.lonti.com/blog/api-versioning-url-vs-header-vs-media-type-versioning); the URL/Header/Media-Type comparison) | ⚠️ cache MUST be told to vary on the header (`Vary: Api-Version`) or it serves the wrong version's body from cache — a silent correctness bug | ❌ **caching on media type is the hardest** — `Vary: Accept` fragments the cache across *every* `Accept` permutation; many CDNs handle it poorly |
| **Routing simplicity** | ✅ `/v1/*` → v1 handler, `/v2/*` → v2 handler — trivial path routing, even at the gateway/edge | ⚠️ every handler must read+branch on a header; edge routing on headers is more config | ⚠️ must parse the `Accept` media type server-side, branch, and handle malformed `Accept` |
| **"Pure REST" purity** | ❌ technically violates "a resource has one stable URI" — `/v1/x` and `/v2/x` are "different URIs for the same resource" ([digitalapi.ai](https://www.digitalapi.ai/blogs/rest-versioning-definition-best-practices-pros-cons-and-when-to-use)) | ✅ URI stays constant across versions — aligns with REST's resource-identity principle | ✅ same — uses HTTP's built-in content negotiation, the "RESTful" answer |
| **Granularity** | coarse — versions the whole API (or whole resource group) at once | fine — can version per-request, even per-resource | finest — can version a single representation |
| **Tooling / SDK-gen support** | ✅ universally supported by OpenAPI generators, gateways, API portals | ⚠️ supported but version-as-header needs explicit config in some generators | ⚠️ least-well supported; many HTTP clients/tools "don't handle custom media types well" ([lonti](https://www.lonti.com/blog/api-versioning-url-vs-header-vs-media-type-versioning)) |
| **Proxy safety** | ✅ nothing to strip | ❌ "non-standard headers can be blocked by proxies" ([versioning survey, this run](https://www.lonti.com/blog/api-versioning-url-vs-header-vs-media-type-versioning)) | ⚠️ `Accept` is standard but custom media types confuse intermediaries |

**The verdict, stated as the practitioner consensus we are adopting:** *"If you run a public API with
large-scale caching and a diverse client base, path-based versioning is typically the pragmatic
default"* — with the refinement that *"a hybrid model — major in the path, representational details in
headers — often provides the best of both worlds"*
([versioning survey synthesis, this run](https://www.lonti.com/blog/api-versioning-url-vs-header-vs-media-type-versioning)).
That is exactly our shape: **major in the path** (`/v1`), and the **lifecycle signals** (`Deprecation`,
`Sunset`) in headers (§4).

### 1.3 Why the data-API world converges on the path (the prior-art proof)

The deciding evidence isn't theory — it's that **the financial/economic data APIs we are re-engineering
all path-version**, because they all have the two properties that make the path right: heavy caching of
read-only series, and a large diverse SDK-pinning consumer base.

- **FRED** (Federal Reserve Bank of St. Louis). The data-retrieval endpoint is
  `https://api.stlouisfed.org/fred/series/observations?series_id=GNPCA&...`, and — load-bearing, fetched
  this run — **FRED launched a new major, v2, in November 2025, with the version in the URL path**:
  `https://fred.stlouisfed.org/docs/api/fred/v2/release_observations.html`, i.e.
  `/fred/v2/release/observations`
  ([FRED API docs](https://fred.stlouisfed.org/docs/api/fred/); the v2 launch
  [announcement, Nov 2025](https://news.research.stlouisfed.org/2025/11/fred-launches-new-version-of-api/)).
  A government economic-data API with 800k+ series and a decade of pinned clients chose **path
  versioning** for its first major bump. That is the single most relevant prior-art point for us.
- **World Bank Indicators API** — base is `https://api.worldbank.org/v2/...`; the major lives in the path
  (`/v2`).
- **JPM DataQuery** itself (the incumbent we are re-engineering) — both base URLs end in the path segment
  `.../api/v2`: `OAUTH_BASE_URL = "https://api-developer.jpmorgan.com/research/dataquery-authe/api/v2"`
  and `CERT_BASE_URL = "https://platform.jpmorgan.com/research/dataquery/api/v2"` (verbatim constants,
  confirmed at source in `macrosynergy/macrosynergy@develop:macrosynergy/download/dataquery.py`, read
  this run and cited in
  [`03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)).

**Three independent senior data systems — FRED, World Bank, and the incumbent we're cloning — all put the
major version in the URL path.** That convergence is the evidence (not the vibe) behind rule 1.

### 1.4 Why Stripe's header model is *right for Stripe and wrong for us*

Stripe versions by a `Stripe-Version` **request header** carrying a **date-based** string
(`2026-05-27.dahlia`), pinned per-account by default
([docs.stripe.com/api/versioning](https://docs.stripe.com/api/versioning)). This is a deliberate, very
different philosophy, and it's worth understanding *why* before copying it.

- **Stripe's API is a transactional command surface** (create a charge, a subscription, a refund), **not
  a cacheable read surface.** There is almost no CDN/proxy caching of `POST /v1/charges`, so the single
  biggest argument for the path (cache-key-by-URL) doesn't apply to them. Their cost of header-based
  versioning is low.
- **Stripe ships a new dated version on roughly every change** and asks accounts to upgrade deliberately
  — a *date-based, continuously-versioned* model where **every release is a potential breaking version**
  and old behavior is preserved per-account. That requires Stripe's enormous internal machinery to run N
  historical behaviors of the same endpoint simultaneously, keyed by the request's version. We are not
  building that machine.
- **Our surface is the inverse of Stripe's**: read-only, heavily cached time-series, with consumers who
  pin an SDK and want the URL to *be* the version so caches and logs Just Work. So we take the
  **path-major** model (FRED/World Bank/DataQuery), not the **header-date** model (Stripe). We *borrow*
  one idea from Stripe — that **the version string can carry meaning** and that **SDKs pin a version at
  release time** (§7) — but not the transport.

> **Decision (rule 1):** **major version in the URL path** (`/v1/catalog`, `/v1/series/...`). Lifecycle
> signals (`Deprecation`/`Sunset`) in **response headers**. No header- or media-type-based versioning
> for the major. This is the FRED/World-Bank/DataQuery shape, and it's the one that keeps our cacheable
> read surface cache-correct by construction.

---

## 2. The core principle: additive grows, breaking forks

Versioning discipline reduces to one rule applied relentlessly: **the contract may only ever GROW within
a major version; it may never SHRINK or CHANGE SHAPE.** A change that only grows the contract is
**additive** and ships in place. A change that shrinks or reshapes it is **breaking** and forks a new
major. Everything in §3 is just the precise enumeration of "grow" vs "shrink/reshape."

This is the **"API evolution" over "API versioning"** posture Speakeasy advocates: *"maintaining backward
compatibility by supporting old and new properties/endpoints simultaneously … adding resources
incrementally rather than replacing them"*
([speakeasy.com/api-design/versioning](https://www.speakeasy.com/api-design/versioning), read this run).
The same posture is Google's API Improvement Proposals' default and Stripe's "backward-compatible
changes" list. A well-designed API can sit on `v1` *for a decade* if every change is additive — Speakeasy
notes some APIs hold v1 for over ten years while others reach v14 purely from insufficient upfront
planning. **The version number is a failure counter, not a feature counter.** Minimize it.

### 2.1 The Robustness Principle, and its one caveat

The additive rule is the server side of Postel's "be liberal in what you accept, conservative in what you
send." We **send conservatively** (never remove/rename a field a client might read) and we may **accept
liberally** (ignore unknown request fields rather than 400 on them — so a client built for `v1.3` can
talk to a `v1.1` server). The caveat: liberal acceptance must **never silently drop** a field the client
*thinks* was applied — if a client sends a filter the server doesn't understand, returning unfiltered
data is worse than a 400. So: **ignore unknown fields you can safely ignore (cosmetic/optional);
hard-reject unknown fields whose absence would silently change the result** (a filter, an `asOf` vintage,
a unit transform). For our `/series` endpoint, an unknown `agg=` value is a 400 (silently averaging when
the client asked for `eop` is a data-integrity bug); an unknown cosmetic flag is ignored.

---

## 3. Breaking vs additive — the enumerated taxonomy

This is the table you check **before every PR** that touches the contract. It is closed: a change is
breaking **iff** it appears in the left column. The classifications match Stripe's "backward-compatible
changes" list, Speakeasy's breaking/non-breaking lists, and — critically — what `oasdiff` flags as `ERR`
(see §5).

### 3.1 BREAKING — forces a new major (`/v1` → `/v2`)

| Category | The change | Why it breaks a pinned client | `oasdiff` check (illustrative) |
|---|---|---|---|
| **Remove a field** | Delete a property from a response body | The client's deserializer/model has the field; downstream code reads it → `null`/crash. | `response-property-removed` (ERR) |
| **Rename a field** | `value` → `val` in a response | Same as remove + add; the old name vanishes. Renames are *two* breaking ops, never do them in place. | `response-property-removed` + add (ERR) |
| **Change a type** | `value: number` → `value: string`; `date: string` → integer epoch | Strongly-typed SDKs (Go/Java/C#) fail to deserialize; loosely-typed ones do arithmetic on a string. | `response-property-type-changed` (ERR) |
| **Remove an endpoint** | Delete `GET /v1/series/{id}/observations` | Every pinned call 404s. | `api-removed-without-deprecation` / `api-path-removed-without-deprecation` (ERR) |
| **Remove an operation** | Drop `POST` from an existing path | Same — the method 405s. | `api-operation-removed` (ERR) |
| **Tighten validation** | Add `maxLength`, narrow a range, add a new `required` request field, **narrow an enum** (remove an accepted value) | A request that was valid yesterday now 400s. *Narrowing accepted input is breaking; widening it is additive.* | `request-property-became-required`, `request-parameter-enum-value-removed`, `request-property-max-decreased` (ERR) |
| **Make an optional param required** | `from` was optional, now required | Clients omitting it now 400. | `request-parameter-became-required` (ERR) |
| **Remove an enum value from a response** | `status` could be `ok\|stale\|unavailable`; drop `stale` | A client with an exhaustive `switch` on the old set may have dead-but-relied-on branches; tooling that generated a sealed type breaks. (WARN-ish, but treat as breaking for response enums clients exhaustively match.) | `response-property-enum-value-removed` (WARN→treat as ERR) |
| **Change pagination** | offset→cursor, change page size semantics, change the cursor token format | A client's paging loop terminates wrong or never. | (structural — flagged by changelog) |
| **Change default behavior** | Default `frequency` flips from `daily` to `monthly`; default `maxPoints` cap changes the returned point count | A client relying on the old default silently gets different *data*. **Silent semantic change is the worst break** — it doesn't even error. | (semantic — not always auto-detectable; see §3.3) |
| **Change auth / error shape** | New required scope; change the error JSON envelope; change an HTTP status (200→204, 200→202) | Error handlers and auth fail. | `api-security-scheme-required`, `response-success-status-removed` (ERR) |
| **Change the success status** | `200` → `201`/`202` for the same operation | Clients asserting `status == 200` break. | `response-success-status-removed` (ERR) |

> **Reference list (Speakeasy, verbatim, this run):** *"Removing or renaming endpoints, removing required
> fields, and changing response structures are considered breaking changes … endpoint structure
> modifications, new required fields, removed response fields, behavior changes, altered validation
> rules, and reformatted responses"*
> ([speakeasy.com/api-design/versioning](https://www.speakeasy.com/api-design/versioning)).

### 3.2 ADDITIVE — ships in place, **no version bump**

| The change | Why it's safe |
|---|---|
| **Add a new endpoint** (`GET /v1/datasets/{id}/metadata`) | Existing clients don't call it; nothing they do changes. |
| **Add a new OPTIONAL request parameter** (`&units=...` with a back-compatible default) | A client omitting it gets the prior behavior. *Optional + back-compatible default is the test.* |
| **Add a new field to a response body** (`provenance.attribution`) | A well-behaved client ignores unknown fields. **This is why "ignore unknowns" (§2.1) is a contract requirement on clients, and why we generate SDKs that don't choke on extra fields.** |
| **Add a new value to a *request* enum** (accept a new `agg=median`) | Widening accepted input. Old values still work. (Widening = additive; narrowing = breaking — note the asymmetry vs §3.1.) |
| **Add a new optional response (a new `4xx`/`2xx` the client wasn't getting)** | Doesn't change existing responses. |
| **Relax validation** (raise a `maxLength`, widen a range) | Strictly more requests succeed; none that succeeded before now fail. |
| **Add an optional header** | Ignored by clients that don't read it. |

> **Reference list (Stripe, verbatim, this run):** *non-breaking = "Adding new fields, Adding new
> endpoints"*; *breaking = "Major releases (new codename and date) … require code updates to migrate"*
> ([docs.stripe.com/api/versioning](https://docs.stripe.com/api/versioning)). Speakeasy: *"Adding new
> endpoints, adding new properties to a response, and introducing optional parameters are non-breaking
> changes"* ([speakeasy](https://www.speakeasy.com/api-design/versioning)).

### 3.3 The dangerous middle: semantic breaks `oasdiff` can't see

The taxonomy above is **structural** — it's about the *shape* of the contract, which `oasdiff` reads off
the OpenAPI spec. But the worst breaks are **semantic**: the shape is identical, the *meaning* changed.
Examples that bite a data API specifically:

- **A default flips.** `frequency` default `daily`→`monthly`; `nan_treatment` default changes which
  observations are returned. The response schema is byte-identical; the *numbers* are different. No
  schema diff fires. → Treat any change to a **default value** or **default behavior** as breaking,
  manually, because CI won't catch it.
- **Units/scale change.** A series that returned values in millions now returns them in absolute dollars
  (same `number` type). A client multiplies wrong by 10⁶. (This is exactly the normalization risk owned
  by the sibling `data-normalization-tet` skill — and it's why provenance/units must be **explicit
  fields in the response**, never an implicit convention. If the unit is a field, changing it is a
  visible additive change; if it's a convention, changing it is an invisible break.)
- **A rounding / precision change**, a timezone-boundary change (a "daily" bucket that silently shifts
  from UTC-close to exchange-local close), a calendar change (`CAL_ALLDAYS` → business-days).

**Rule:** structural breaks are gated by `oasdiff` (§5); **semantic breaks are gated by code review +
contract tests** (§9), because the spec can't express them. The reviewer's checklist question is: *"did
the bytes stay the same but the meaning move?"* If yes, it's breaking even though `oasdiff` is silent.

---

## 4. The deprecation policy — never delete in the dark

Removing something is breaking (§3.1). The *only* sanctioned path to removal is **deprecate → window →
sunset → remove**, signalled in three places at once: **HTTP headers, the OpenAPI spec, and a
human-readable changelog.** This is the contract that protects a pinned SDK: the client is *told*, in a
machine-readable way and with lead time, before anything it depends on disappears.

### 4.1 The two headers: `Deprecation` (RFC 9745) and `Sunset` (RFC 8594)

These are two distinct, complementary standard HTTP response headers. **Deprecation** says *"this is on
the way out (and here's when that started/starts)"*; **Sunset** says *"this URI will actually stop
responding at this time."*

**`Sunset` (RFC 8594, Feb 2019).** The value is an **HTTP-date** (IMF-fixdate, per RFC 7231 §7.1.1.1).
Example, verbatim from the RFC:

```
Sunset: Sat, 31 Dec 2018 23:59:59 GMT
```

Normative points from RFC 8594 (read this run,
[rfc-editor.org/rfc/rfc8594](https://www.rfc-editor.org/rfc/rfc8594.html)):
- It indicates *"that a URI is likely to become unresponsive at a specified point in the future."*
- *"Clients SHOULD treat Sunset timestamps as hints"* — it's a hint, not a guarantee.
- The timestamp *"SHOULD be a timestamp in the future"*; a past timestamp is treated as "now."
- There is a `sunset` **link relation type** for pointing at the retirement policy:
  `Link: <https://developer.example.com/sunset-policy>; rel="sunset"`.

**`Deprecation` (RFC 9745).** The value is a **Structured Field Date** (RFC 9651) — an `@`-prefixed Unix
timestamp. Example, verbatim from the RFC:

```
Deprecation: @1688169599
```

(that's Fri 30 Jun 2023 23:59:59 UTC). Normative points from RFC 9745 (read this run,
[rfc-editor.org/rfc/rfc9745](https://www.rfc-editor.org/rfc/rfc9745.html)):
- The date *"may be in the future (the resource … will be deprecated at that date) or in the past (the
  resource … was deprecated at that date)."* — unlike Sunset, **a past Deprecation date is valid and
  normal** (it's already deprecated).
- When both headers are present, **the Sunset date `MUST NOT` be earlier than the Deprecation date.**
- There is a `deprecation` **link relation type** for the human docs:
  `Link: <https://developer.example.com/deprecation>; rel="deprecation"; type="text/html"`.
- Clients *"SHOULD always check the referred resource's documentation"* and *"SHOULD, if possible,
  consult the resource developer"* for transition planning.

> **Format gotcha (verified this run):** the two headers use **different date formats** "for historical
> reasons" (RFC 9745 says so explicitly). `Deprecation` is a Structured Field Date (`@<epoch>`); `Sunset`
> is an HTTP-date string. **Do not** put an HTTP-date in `Deprecation` or an `@epoch` in `Sunset` — they
> are not interchangeable.

**The combined response we emit on a deprecated endpoint (the canonical shape):**

```http
HTTP/1.1 200 OK
Content-Type: application/json
Deprecation: @1735603200
Sunset: Wed, 31 Dec 2025 23:59:59 GMT
Link: <https://developer.example.com/changelog#v1-series-deprecation>; rel="deprecation"; type="text/html",
      <https://developer.example.com/v2/migration>; rel="successor-version"
Warning: 299 - "This endpoint is deprecated; migrate to /v2 by 2025-12-31."
```

The `Warning: 299` is a belt-and-suspenders human-readable line (some clients/log tools surface it even
when they ignore `Deprecation`). The `rel="successor-version"` link (RFC 5829) points at the replacement.

### 4.2 The window: how long is the lead time?

The headers are the *mechanism*; the **window** is the *policy*. A consumer who pinned an SDK needs
enough lead time to notice the deprecation, schedule work, test against `/v2`, and ship. Our policy:

| Surface stability | Minimum window (deprecation → sunset) | Rationale |
|---|---|---|
| **Stable / GA** (`/v1` published, SDK generated) | **≥ 180 days** | Half a year is the common floor for a paid/relied-on data API; matches the `oasdiff --deprecation-days-stable=180` convention (§5.4). Enough for a quarterly-release consumer to catch it. |
| **Beta / preview** (flagged `x-beta`, no stability promise) | **≥ 30 days** | Beta consumers accept churn; a month is courteous, not contractual. |
| **Security-forced removal** | as short as required, **with a written exception** | A vuln may force a sub-window removal; that's an incident with sign-off, never the default. |

The window starts when the `Deprecation` header **first ships** (and the changelog entry publishes), not
when the decision is made internally. **The clock the consumer sees is the clock that counts.**

### 4.3 The changelog: the human half of the contract

Headers are for machines; the **changelog** is for the human deciding whether/when to migrate. Every
deprecation and every breaking `/v2` gets a dated changelog entry that states: **what changed, why, what
to do instead, and the sunset date.** This is the single artifact a consumer's engineer reads. Keep it:
- **append-only and dated** (a changelog you can rewrite is not a contract),
- **categorized** (Added / Deprecated / Removed / Fixed — Keep-a-Changelog style),
- **linked from the `Deprecation` header** (the `rel="deprecation"` Link target points at the entry).

Speakeasy's deprecation process is exactly this triple: *"For endpoints: Use the `Sunset` header with an
expiration date and optional `Link` header directing to migration documentation. For properties: Mark as
deprecated in OpenAPI 3.1 specifications and phase out gradually"*
([speakeasy](https://www.speakeasy.com/api-design/versioning)).

### 4.4 Deprecating a single field (not a whole endpoint)

You rarely retire a whole endpoint; far more often you retire **one field**. The mechanism in OpenAPI is
`deprecated: true` on the schema property, plus an `x-sunset` extension date (the convention `oasdiff`
reads — §5.4):

```yaml
components:
  schemas:
    Observation:
      type: object
      properties:
        t: { type: string, format: date }
        value: { type: number }
        v:
          type: number
          deprecated: true
          x-sunset: "2025-12-31"          # RFC3339 date; the field 'v' is the old name for 'value'
          description: "DEPRECATED — renamed to `value`. Removed after 2025-12-31. See /changelog#obs-v-rename."
```

During the window you ship **both** `v` and `value` (the expand phase, §8). The field-level deprecation
is a *non-breaking* change (you added `value`, you only *annotated* `v`); the *removal* of `v` after the
sunset is the breaking step that — done correctly via expand/contract — happens with zero consumer
breakage because everyone migrated to `value` during the window.

---

## 5. CI contract-diff gating — make the policy mechanical

A versioning policy that lives only in a wiki page is violated the first busy week. The policy becomes
real when **CI fails the build on an undocumented breaking change.** Two tools, two jobs:

- **`oasdiff`** — diffs the *new* OpenAPI spec against the *base* (the spec on `main`) and **fails on a
  breaking change** that isn't justified by a passed sunset.
- **`spectral`** — lints the spec for hygiene/governance (naming, required descriptions, examples,
  security) so the contract is well-formed before it's even diffed.

The OpenAPI spec is the contract; these two gates are its enforcement. (For *generating* the spec from
FastAPI on the Python data plane, see the sibling `python-fastapi-data-service` skill — OpenAPI 3.1 is
the SDK source of truth there. This doc is what *guards* that spec as it changes.)

### 5.1 `oasdiff` — the breaking-change gate (pin **v1.11.9**, 2026-02-02)

`oasdiff` ("OpenAPI Diff and Breaking Changes") is the de-facto breaking-change detector — it *"detects
470+ distinct changes, breaking and non-breaking, covering every way an API modification can affect an
existing client, across every part of the OpenAPI spec. Each change has an ID, severity level, and a
detailed description"* ([oasdiff.com](https://www.oasdiff.com/),
[github.com/oasdiff/oasdiff](https://github.com/oasdiff/oasdiff), read this run). It originated at Tufin
(hence the `tufin/oasdiff` Docker image) and is now under the `oasdiff` org. **Latest release: v1.11.9,
2026-02-02** ([releases](https://github.com/oasdiff/oasdiff/releases/)).

**Install** (any one; pin the version in CI):

```bash
# Go
go install github.com/oasdiff/oasdiff@v1.11.9
# Homebrew
brew install oasdiff
# curl, pinned
curl -fsSL https://raw.githubusercontent.com/oasdiff/oasdiff/main/install.sh | version=1.11.9 sh
# Docker (the Tufin image)
docker run --rm -t tufin/oasdiff breaking old.yaml new.yaml
```

**The four commands** (verbatim roles from the README, read this run):

| Command | Role |
|---|---|
| `oasdiff diff base.yaml revision.yaml` | full structural diff (output html/json/markdown/text/yaml — default yaml) |
| `oasdiff breaking base.yaml revision.yaml` | **only breaking changes** (the CI gate) |
| `oasdiff changelog base.yaml revision.yaml` | every significant change, breaking or not, human-readable (publish this) |
| `oasdiff summary base.yaml revision.yaml` | high-level count |

**Severity model** (verbatim, this run): `ERR` = *"definite breaking changes which should be avoided"*;
`WARN` = *"potential breaking changes which developers should be aware of, but cannot be confirmed
programmatically as breaking"*; `INFO` = non-breaking. **`oasdiff breaking` detects `ERR` and `WARN`
only**; `oasdiff changelog` includes all levels.

**Exit codes / the gate** (verbatim, this run): *"Exit code is 0 when there are no breaking changes, 1
when breaking changes are found … This makes it easy to fail a CI step automatically."* Tighten or loosen
with **`--fail-on`**:
- `--fail-on ERR` → exit 1 only on `ERR` (the sane default — fail on *definite* breaks).
- `--fail-on WARN` → exit 1 on `WARN` or `ERR` (stricter — fail on *potential* breaks too).

**Output formats** (`--format` / `-f`): `text` (default), `json`, `yaml`, `html`, `markdown`,
`singleline`, **`githubactions`** (emits `::error::` annotations inline on the PR), `junit` (GitLab).

**Specific check IDs** (illustrative, confirmed real this run — there are 470+; each has an ID + severity
+ description): `response-property-removed`, `response-property-type-changed`,
`api-removed-without-deprecation`, `request-property-became-required`,
`request-parameter-became-required`, `request-parameter-enum-value-removed`,
`response-success-status-removed`. These map 1:1 onto the §3.1 taxonomy — which is the point: **the table
you reason from and the tool that enforces it are the same list.**

### 5.2 The GitHub Action (`oasdiff/oasdiff-action`) — the canonical PR gate

The cleanest wiring is the official action, which diffs the PR's spec against the base branch's spec and
posts a PR comment + sets a commit status. **Verbatim from the action docs (read this run):**

```yaml
name: oasdiff
on:
  pull_request:
    branches: [ "main" ]
permissions:
  contents: read
  pull-requests: write          # to post the breaking-change comment
jobs:
  breaking-changes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: git fetch --depth=1 origin ${{ github.base_ref }}
      - uses: oasdiff/oasdiff-action/breaking@v0
        with:
          base: 'origin/${{ github.base_ref }}:openapi.yaml'   # the spec on the target branch
          revision: 'HEAD:openapi.yaml'                        # the spec in this PR
          fail-on: WARN                                        # ERR or WARN
          github-token: ${{ github.token }}
```

Key inputs: `base` (required), `revision` (required), `fail-on` (`ERR`|`WARN`), `github-token` (for PR
comments), `review` (`true`/`false`, default true), plus `include-checks`, `exclude-elements`,
`allow-external-refs`. Sibling action subpaths: `@changelog`, `@diff`, `@validate`, `@pr-comment`,
`@verify`. ([github.com/oasdiff/oasdiff-action](https://github.com/oasdiff/oasdiff-action), read this
run.)

**What this gate does to the workflow:** a PR that removes a field, changes a type, or makes a param
required **fails CI with a red check and an inline `::error::`** explaining exactly which check fired.
The author then has two choices: (a) it was a mistake — fix it to be additive; or (b) it's an intended
break — then it doesn't belong in `/v1` at all; it goes in `/v2` (new path, new spec file), and the `/v1`
spec only changes additively (e.g. a `deprecated:true` annotation), which passes the gate. **CI makes the
"is this a major bump?" question un-skippable.**

### 5.3 The raw-CLI gate (for non-GitHub CI, or finer control)

```bash
# Fail the build if the PR's spec breaks the base spec. Default base = the spec on main.
oasdiff breaking \
  "$BASE_SPEC" "$PR_SPEC" \
  --fail-on ERR \
  --format githubactions          # or json for a machine-readable artifact

# Publish the full human changelog as a build artifact / PR comment body:
oasdiff changelog "$BASE_SPEC" "$PR_SPEC" --format markdown > CHANGELOG-DIFF.md
```

`oasdiff` reads specs from files, URLs, or **git revisions directly** (e.g.
`oasdiff breaking main:openapi.yaml HEAD:openapi.yaml`), so the base/PR comparison needs no temp files.

### 5.4 The deprecation grace-period enforcement (the clever part)

`oasdiff` doesn't just detect breaks — it **enforces the deprecation policy** so that a *sanctioned*
removal (one that did its time) passes, while a *premature* removal fails. The mechanism (verbatim from
`docs/DEPRECATION.md`, read this run):

- Mark the resource `deprecated: true` and stamp an **`x-sunset`** extension (RFC3339 date):

  ```yaml
  /v1/series/{id}/legacy:
    get:
      deprecated: true
      x-sunset: "2025-12-31"
  ```

- **The rule:** *"At the sunset date or anytime later, the resource can be removed without triggering a
  breaking change error; an earlier removal will be considered a breaking change."* Also: *"Changing
  `x-sunset` to an earlier date"* is itself a breaking change (you can't shorten the promised window).
- **Enforce a minimum grace period** with `--deprecation-days-stable` / `--deprecation-days-beta`:

  ```bash
  # Require any deprecation of a stable resource to carry an x-sunset ≥180 days out,
  # AND only allow removal at/after that sunset:
  oasdiff breaking base.yaml revision.yaml --deprecation-days-stable=180
  ```

  *"This requires deprecation of resources to be accompanied by an `x-sunset` extension with a date which
  is at least 180 days away."* Setting it to zero disables enforcement.

**This is the whole lifecycle made mechanical:** you can't remove an endpoint in a PR (CI fails: it's a
break) **unless** that endpoint was marked `deprecated` with an `x-sunset` ≥180 days ago and that date
has now passed — in which case CI **passes**, because the policy was followed. The tool encodes rule 4.

### 5.5 `spectral` — the spec-hygiene gate (runs *before* `oasdiff`)

`oasdiff` checks *change*; **Spectral** checks *quality* — that the spec is well-formed, consistently
named, documented, and conformant to your house style, on every PR. *"You input an API description
(OpenAPI, AsyncAPI, Swagger…) and a set of rules, and Spectral checks whether the API description follows
the rules"* ([github.com/stoplightio/spectral](https://github.com/stoplightio/spectral), read this run).

```bash
npm install -g @stoplight/spectral-cli
spectral lint openapi.yaml --ruleset .spectral.yaml --fail-severity=warn
```

A minimal `.spectral.yaml` that extends the built-in OpenAPI ruleset and adds two house rules relevant to
*this* contract — every series must carry provenance, and no operation ships without a description:

```yaml
extends: ["spectral:oas"]            # the built-in OpenAPI 3.x ruleset
rules:
  operation-description: error       # every operation MUST have a description (governance)
  operation-operationId: error       # stable operationIds → stable generated SDK method names (§7)
  # House rule: a series/observation response MUST declare provenance (the commercialOk discipline,
  # carried from the data-analytics line's licensing rule — a number with no provenance is a bug).
  series-response-has-provenance:
    description: "Series/observation responses must include a `provenance` object."
    given: "$.paths[*].get.responses.200.content.application/json.schema.properties"
    then:
      field: provenance
      function: truthy
    severity: error
```

Run **Spectral first** (is the spec even valid and well-formed?), then **`oasdiff`** (did this valid spec
break the prior valid spec?). A PR passes the contract gate iff *both* are green. (Axway, Stoplight, and
the New Stack all document Spectral as the API-governance linter run in CI;
[blog.axway.com](https://blog.axway.com/learning-center/apis/api-design/api-linting-with-spectral),
[stoplight.io/open-source/spectral](https://stoplight.io/open-source/spectral).)

---

## 6. Why NOT to over-version (the URI-footprint / N×M explosion)

The failure mode opposite to "broke a pinned client" is "**versioned so eagerly that the surface is
unmaintainable.**" Every new `/vN` you publish is not one new thing — it's a new copy of **every endpoint
in the API**, each needing its own handlers, its own tests, its own docs, its own SDK, and its own
support burden, **for as long as it lives.**

- **The URI footprint multiplies.** `/v2` doesn't add 2 endpoints; it re-publishes all of `/v1`'s
  endpoints under `/v2`. The route table, the test matrix, and the doc site all double. The versioning
  survey notes this directly: *"too many URL versions create load on the cache server"* and *"resource
  URIs change with each new version"* ([digitalapi.ai](https://www.digitalapi.ai/blogs/rest-versioning-definition-best-practices-pros-cons-and-when-to-use)).
- **The N×M matrix.** N live API majors × M generated SDK languages × your test suite = the number of
  (version, language) combinations you must keep green. Two majors and four SDK languages is already 8
  matrices. Three majors is 12. This is why Speakeasy's whole thrust is **evolution over versioning** —
  a thoughtfully-additive `v1` that lives for a decade has an N of 1.
- **Consumer fatigue.** Each new major is *migration work you push onto every consumer*. Push it too
  often and they stop upgrading, stranding you on old majors you can't retire — the worst of both worlds.

**Our policy (rule 7): at most TWO live majors at any time.** When `/v3` is needed, `/v1` must already be
sunset. And — the real lever — **most "breaking" changes don't need a new major at all**, because
expand-then-contract (§8) lets you reshape the contract *inside* `v1` without breaking anyone. A new
major is the tool of last resort, for changes so pervasive they can't be done additively (a wholesale
auth model change, a fundamental resource re-modeling). For everything else, **grow `v1` and
expand/contract.**

> **The litmus test before opening `/v2`:** *"Can this be done as an additive change plus an
> expand/contract migration inside `/v1`?"* If yes — and it almost always is — **do that.** A `/v2` is
> justified only when the answer is genuinely no.

---

## 7. Tying the SDK's semver to the API version

Consumers don't call the HTTP API directly — they call a **generated SDK** (Python, TypeScript, Go,
Excel add-in). That SDK is versioned with **SemVer** (`MAJOR.MINOR.PATCH`), and the whole "don't break a
pinned client" promise only holds if the SDK's version *truthfully encodes* what changed. The mapping:

| Contract change | API effect | SDK SemVer bump | Why |
|---|---|---|---|
| **New `/vN` (breaking)** | new major path | **SDK MAJOR** (`1.x` → `2.0.0`) | The SDK now targets a different contract; pinned `^1` clients correctly *don't* auto-upgrade. |
| **Additive** (new endpoint / optional param / response field) within a major | same `/v1` | **SDK MINOR** (`1.3.0` → `1.4.0`) | New methods/params appear; old code keeps compiling. `^1.3` clients get it on `npm update`. |
| **Spec-internal fix** (better description, fixed example, doc-only) | no wire change | **SDK PATCH** (`1.4.0` → `1.4.1`) | No behavior change; safe auto-upgrade. |
| **Deprecation annotation** (`deprecated:true` on a field, still present) | same `/v1` | **SDK MINOR** | The method/field gets a `@deprecated` marker (IDE strikethrough) — additive metadata, not a removal. |

This is exactly the model Stripe ships: their typed SDKs **pin the API version current at SDK release
time** — *"stripe-node v12+ … pinned to the API version current at SDK release time … strongly typed;
requests fixed to API version at SDK release"*
([docs.stripe.com/api/versioning](https://docs.stripe.com/api/versioning)). The consequence we adopt:
**the generated SDK embeds the API major it was built against**, and a consumer who does `pip install
"ourdata-sdk>=1,<2"` is *automatically protected from `/v2`* — because `/v2`'s SDK is `2.0.0`, outside
their pin. **SemVer + pinning is the mechanism that makes the version promise self-enforcing on the
consumer side.**

**Three rules to keep the SDK semver honest:**

1. **`operationId` is forever.** The generated SDK method name comes from the OpenAPI `operationId`.
   Renaming an `operationId` renames a method = an SDK MAJOR break even if the HTTP contract is unchanged.
   So `operationId`s are stable identifiers (Spectral rule `operation-operationId: error`, §5.5) — pick
   them carefully once.
2. **Regenerate the SDK from the spec in CI, and run `oasdiff` on the *spec*, not the SDK.** The spec is
   the single source of truth; the SDK is a derivative. If the spec diff is additive, the SDK bump is
   minor — *mechanically*, not by judgment.
3. **One SDK major per API major; never straddle.** An SDK that can talk to both `/v1` and `/v2` re-imports
   the N×M problem into the client. Generate `ourdata-sdk@1` for `/v1` and `ourdata-sdk@2` for `/v2`.

---

## 8. Expand-then-contract — the breaking change that doesn't break

This is the technique that lets §6's "most breaks don't need a `/v2`" be true. It's **Parallel Change**
(Martin Fowler) — also called **expand and contract** — *"a pattern to implement backward-incompatible
changes to an interface in a safe manner, by breaking the change into three distinct phases"*
([martinfowler.com/bliki/ParallelChange.html](https://martinfowler.com/bliki/ParallelChange.html), read
this run). It turns a single big-bang break into three individually-safe steps, each backward-compatible
with the one before, so **no consumer ever experiences a breaking moment.**

### 8.1 The three phases (worked example: renaming a response field `v` → `value`)

**Phase 1 — EXPAND.** Add the new thing *alongside* the old. The response now carries **both** `v` (old)
and `value` (new), identical values. Mark `v` `deprecated:true` + `x-sunset` (§4.4). This phase is
**purely additive** → passes `oasdiff breaking` → ships in `v1` with **no version bump**.

```json
{ "t": "2026-06-24", "v": 102.4, "value": 102.4 }   ←  both present; v is deprecated
```

> *"The interface is augmented to support both old and new versions simultaneously"* — Fowler. *"new
> Coordinate-based methods are added alongside existing x,y integer methods."*

**Phase 2 — MIGRATE.** Consumers move from `v` to `value`, **at their own pace**, during the sunset
window. We don't control this; we *enable* it. The `Deprecation`/`Sunset` headers + changelog + the
IDE-strikethrough on the SDK's `v` field drive the migration. We can instrument it: log which consumers
still read `v` (e.g., via SDK telemetry or a field-usage metric) so we *know* when the window can safely
close. *"All clients consuming the legacy interface gradually transition … This phase can proceed
incrementally and is typically longest for external consumers"* — Fowler.

**Phase 3 — CONTRACT.** Once the sunset date has passed (and ideally usage telemetry confirms `v` is
dead), **remove `v`.** Because it was `deprecated` with an `x-sunset` now in the past, `oasdiff` treats
the removal as **allowed, not breaking** (§5.4) → CI passes. The response is now just `value`. *"Once all
usages have shifted … the outdated methods and underlying data structures are removed."* — Fowler.

```json
{ "t": "2026-06-24", "value": 102.4 }   ←  contract complete; v is gone, nobody broke
```

### 8.2 Why this is the default, not the exception

- **No big-bang.** At no single moment does any consumer's code stop working. The "break" (the
  contract phase) lands only after everyone has migrated.
- **Rollback-safe.** *"The expand and contract pattern allows you to rollback changes easily at most
  points in the process"* ([Prisma data guide](https://www.prisma.io/dataguide/types/relational/expand-and-contract-pattern)) —
  if the migrate phase reveals a problem, you haven't removed anything yet.
- **It keeps `v1` alive.** A rename, a type narrowing (add the new typed field beside the old), a
  pagination change (offer the cursor path beside the offset path, deprecate offset) — all of these,
  normally "breaking," become **three additive-or-allowed steps inside `v1`**. That's why two live majors
  is enough.

**The same pattern applies to the data layer underneath** (renaming a TimescaleDB column = add new
column, dual-write, backfill, switch reads, drop old column) — that's the database expand/contract owned
by the `timescaledb-timeseries` / `data-normalization-tet` skills. The *API* expand/contract here sits on
top of it: you can't contract the API field until the data behind it is migrated too.

### 8.3 The discipline trap

Fowler's warning, which is the failure mode to name explicitly: *"Maintaining discipline to complete the
contract phase, as incomplete transitions worsen the codebase state."* An expand you never contract is
**permanent dual maintenance** — two fields, two code paths, forever. **The `x-sunset` date is the
forcing function:** it's a committed deadline, CI lets you remove on/after it, and the changelog told
everyone. Put the sunset date in at expand time; don't leave it open-ended.

---

## 9. The full lifecycle, end to end (the workflow)

Putting §1–§8 together, here is the actual sequence for a change to the contract:

```
  A CHANGE TO THE CONTRACT IS PROPOSED
        │
        ▼
  Is it ADDITIVE? (new endpoint / optional param / new response field / widened input)   ── §3.2
        │ yes
        ▼
  Ship in /v1. SDK MINOR bump. Spectral lint + oasdiff (passes — no break). Changelog: "Added …".
        │
        │ no — it removes/renames/retypes/narrows something                                ── §3.1
        ▼
  Can it be done by EXPAND→CONTRACT inside /v1?  (almost always yes)                        ── §8
        │ yes
        ▼
  EXPAND: add the new shape beside the old; mark old `deprecated:true` + `x-sunset: <≥180d>`.
          → additive → oasdiff passes → ship in /v1, SDK MINOR. Emit Deprecation+Sunset headers.
          → Changelog: "Deprecated <old>; use <new>; sunset <date>."
        │
        ▼
  MIGRATE: consumers move during the window (headers + IDE strikethrough + telemetry drive it).
        │
        ▼
  (sunset date passes, usage telemetry confirms dead)
        ▼
  CONTRACT: remove the old shape. oasdiff sees deprecated+past-sunset → ALLOWED, CI passes. SDK MINOR/MAJOR.
        │
        │ no — the change is too pervasive for expand/contract (auth model, full re-modeling)  ── §6 litmus
        ▼
  OPEN /v2: new path, new spec file, new SDK MAJOR (2.0.0). /v1 gets only a deprecation annotation
            (Deprecation+Sunset on /v1 root, ≥180d). Two majors live; retire /v1 at its sunset.
```

**Two CI gates run on every PR regardless of branch:** `spectral lint` (spec hygiene) then `oasdiff
breaking --fail-on ERR` (no undocumented break). **One thing CI can't see — semantic breaks (§3.3) — is
gated by code review + contract tests** (a stored set of recorded request/response pairs replayed against
the new build; if a previously-recorded response changes shape *or value-meaning*, the test fails). The
contract is enforced by machines where it can be, by humans where it can't.

---

## 10. Anti-patterns (mistake → fix)

| Anti-pattern | Why it breaks | Fix |
|---|---|---|
| **Versioning by header/media-type "because it's more RESTful"** on a heavily-cached read API | `Vary`-based caching fragments or silently serves the wrong version's body; invisible in logs | URL path major (`/v1`) — the FRED/World-Bank/DataQuery norm (§1) |
| **Removing/renaming a response field in place** | Every pinned SDK that reads it breaks silently in prod | Expand/contract: add the new field, deprecate the old, sunset, then remove (§8) |
| **Bumping `/v2` for an additive change** (new optional param) | N×M maintenance explosion; consumers forced to migrate for nothing | Additive ships in `/v1`, SDK MINOR (§2, §3.2, §6) |
| **Deleting a deprecated endpoint with no `Sunset` header / window** | Consumers had no machine-readable warning; "deprecated in the docs" ≠ a contract | `Deprecation`+`Sunset` headers + `x-sunset` + ≥180d window + changelog (§4) |
| **`Deprecation: Sat, 31 Dec…` or `Sunset: @1735…`** (swapped date formats) | Wrong format per RFC → clients can't parse it | `Deprecation` = `@<epoch>` (RFC 9745); `Sunset` = HTTP-date (RFC 8594) — different by spec (§4.1) |
| **Sunset date earlier than the Deprecation date** | Violates RFC 9745 (`Sunset MUST NOT be earlier than Deprecation`) | Sunset ≥ Deprecation, always (§4.1) |
| **Shortening a published `x-sunset`** to remove sooner | Breaks the promise; `oasdiff` flags it as breaking | The window only moves *later*; never shorten a committed sunset (§5.4) |
| **No CI diff gate** ("we'll review the spec by eye") | A breaking change merges the first busy week; nobody notices till a consumer files a bug | `oasdiff breaking --fail-on ERR` in CI as a required check (§5) |
| **Flipping a default value / unit silently** (same schema, different numbers) | `oasdiff` is blind to it (schema unchanged); consumers get wrong data with no error | Treat any default/unit/calendar change as breaking; gate by review + contract tests (§3.3) |
| **Renaming an `operationId`** | Renames the generated SDK method = SDK MAJOR break with no HTTP change | `operationId`s are stable forever; Spectral `operation-operationId: error` (§5.5, §7) |
| **Expand without ever contracting** | Permanent dual-field maintenance; the contract bloats forever | Commit the `x-sunset` date at expand time; the date forces the contract (§8.3) |
| **An SDK that talks to both `/v1` and `/v2`** | Re-imports the N×M version matrix into the client | One SDK major per API major (§7) |
| **Three+ live majors** | Maintenance/test/doc/support cost balloons; old majors never die | Cap at two live majors; expand/contract instead of a new major (§6) |

---

## 11. Grading rubric (how to know this is done right)

A versioning-and-lifecycle design for this product line passes iff:

| # | Check | Pass condition |
|---|---|---|
| 1 | **Version location** | Major version is in the **URL path** (`/v1/...`); lifecycle signals are in **headers**. Header/media-type major versioning is justified-away, not defaulted into. |
| 2 | **Additive discipline** | A new endpoint / optional param / response field ships in `/v1` with **no major bump**; only the enumerated §3.1 list forces a major. |
| 3 | **Breaking taxonomy is closed + matches the tool** | The team's "is this breaking?" list is the §3.1 table, and it's the same list `oasdiff` enforces (`response-property-removed`, `request-property-became-required`, …). |
| 4 | **Deprecation is a contract, not a note** | Every removal is preceded by `Deprecation`+`Sunset` headers (correct RFC formats), an `x-sunset` spec annotation, a changelog entry, and a ≥180-day stable window. |
| 5 | **CI gates the break** | `oasdiff breaking --fail-on ERR` is a **required** PR check; `spectral lint` runs first; `--deprecation-days-stable=180` enforces the window so sanctioned removals pass and premature ones fail. |
| 6 | **Semantic breaks are covered** | Default/unit/calendar/precision changes are flagged manually + by contract tests, since `oasdiff` is structurally blind to them. |
| 7 | **SDK semver tracks the contract** | SDK major == API major; additive → SDK minor; doc-only → patch; `operationId`s are stable; consumers' `>=1,<2` pin protects them from `/v2`. |
| 8 | **Migration is expand/contract** | A "breaking" reshape is done as expand → migrate → contract inside `/v1`; a new `/vN` is justified only when expand/contract genuinely can't (the §6 litmus). |
| 9 | **Over-versioning is bounded** | At most two live majors; a new major retires the oldest at its sunset; the default answer to "do we need /v2?" is "no, grow /v1." |
| 10 | **Every load-bearing claim is cited** | Each rule traces to a primary source (RFC 8594/9745, `oasdiff` docs, Stripe/FRED/World-Bank/Speakeasy/Fowler) or is flagged `[unverified]`. No invented flag, version, or RFC behavior. |

---

## 12. References (read in this order for a first build)

| Source | What to take from it | URL / locator |
|---|---|---|
| **RFC 8594 — Sunset header** | Exact `Sunset` syntax (HTTP-date), `SHOULD`-future, the `sunset` link relation | [rfc-editor.org/rfc/rfc8594](https://www.rfc-editor.org/rfc/rfc8594.html) |
| **RFC 9745 — Deprecation header** | Exact `Deprecation` syntax (`@epoch` Structured Field Date), past/future allowed, Sunset-≥-Deprecation rule, `deprecation` link rel | [rfc-editor.org/rfc/rfc9745](https://www.rfc-editor.org/rfc/rfc9745.html) |
| **oasdiff** (pin v1.11.9) | `breaking`/`changelog`/`diff` commands, `--fail-on ERR/WARN`, exit 0/1, `--format githubactions`, the 470+ check IDs | [github.com/oasdiff/oasdiff](https://github.com/oasdiff/oasdiff) · [oasdiff.com](https://www.oasdiff.com/) |
| **oasdiff DEPRECATION.md** | `deprecated:true`+`x-sunset` (RFC3339), `--deprecation-days-stable/beta`, remove-after-sunset-is-allowed rule | [github.com/oasdiff/oasdiff/blob/main/docs/DEPRECATION.md](https://github.com/oasdiff/oasdiff/blob/main/docs/DEPRECATION.md) |
| **oasdiff-action** | The PR-gate GitHub Action YAML (`breaking@v0`, `base`/`revision`/`fail-on`) | [github.com/oasdiff/oasdiff-action](https://github.com/oasdiff/oasdiff-action) |
| **Spectral** | `spectral lint`, `.spectral.yaml`, `extends: spectral:oas`, CI governance rules | [github.com/stoplightio/spectral](https://github.com/stoplightio/spectral) · [stoplight.io/open-source/spectral](https://stoplight.io/open-source/spectral) |
| **Stripe API versioning** | The contrast model: date-based `Stripe-Version` header, SDK-pinned-at-release, additive list — and why it's right for a command API, not ours | [docs.stripe.com/api/versioning](https://docs.stripe.com/api/versioning) |
| **FRED API (v2, Nov 2025)** | Prior-art proof of path-versioning a major data API (`/fred/v2/...`) | [fred.stlouisfed.org/docs/api/fred](https://fred.stlouisfed.org/docs/api/fred/) · [v2 launch](https://news.research.stlouisfed.org/2025/11/fred-launches-new-version-of-api/) |
| **Speakeasy — API versioning** | Breaking/non-breaking lists; "evolution over versioning"; deprecation process; v1-for-a-decade | [speakeasy.com/api-design/versioning](https://www.speakeasy.com/api-design/versioning) |
| **Martin Fowler — Parallel Change** | The expand → migrate → contract pattern, definitions, the discipline trap | [martinfowler.com/bliki/ParallelChange.html](https://martinfowler.com/bliki/ParallelChange.html) |
| **URL vs Header vs Media-Type survey** | The three-way trade-off matrix, caching/`Vary`/proxy behavior, the practitioner consensus | [lonti.com](https://www.lonti.com/blog/api-versioning-url-vs-header-vs-media-type-versioning) · [digitalapi.ai](https://www.digitalapi.ai/blogs/rest-versioning-definition-best-practices-pros-cons-and-when-to-use) |
| **Sibling reference (this skill)** | The two-endpoint contract this doc versions over time | [`theory-query-api-contract.md`](theory-query-api-contract.md) |
| **Project design doc** | The committed DataQuery system design (path-version `/api/v2` incumbent constants, the read-from-store boundary) | [`03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md) |

> **Confidence.** *High* on the header specs (RFC 8594/9745 read at source), the `oasdiff` mechanics and
> flags (docs + README read this run, version pinned), the path-vs-header trade-offs, and the
> expand/contract pattern (Fowler at source). *Medium* on the exact `oasdiff` check-ID strings (the IDs
> cited are confirmed real and representative, but the full 470+ catalogue should be regenerated from
> `oasdiff`'s own `--format json` output before any are hard-coded into CI config). *Medium* on the
> 180-day window figure — it's the common floor and matches `oasdiff`'s `--deprecation-days-stable`
> convention, but the actual window is a business/SLA decision, not an RFC mandate; pick it deliberately.
> *[unverified]* — JPM DataQuery's *internal* deprecation policy and window are not public; we cite only
> its path-versioned base URLs (confirmed at source) and infer nothing about its lifecycle policy.
