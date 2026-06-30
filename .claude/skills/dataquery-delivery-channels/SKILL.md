---
name: dataquery-delivery-channels
description: >
  Build the CONSUMER-FACING DELIVERY CHANNELS for the JPM-Markets re-engineering data-analytics
  product line (NOT Lumina) — the "one OpenAPI core → many surfaces" layer that sits ON TOP of the
  already-built catalog + time-series store and turns it into a consumable data product. A NEW
  Python/FastAPI/data-engineering line, separate from Lumina's Bun + Express + Prisma + Supabase +
  Upstash stack. This is the channel/contract/auth/SDK layer of the DataQuery/Fusion re-engineering
  (Project 3) — everything the OUTSIDE consumer touches. Covers (1) the REST QUERY API CONTRACT: the
  universal two-endpoint shape (catalog/discovery + series retrieval), the dataset→instrument→
  expression addressing model, query params (asOf/range/frequency/aggregation/units/maxPoints),
  cursor/keyset pagination, server-side frequency-aggregation + LTTB downsampling AT the API boundary,
  the JSON envelope (data + Provenance{commercialOk} + meta), and OpenAPI 3.1 as the single contract
  source. (2) CHANNEL AUTH: OAuth2 client_credentials machine-to-machine, bearer-JWT verification
  against cached JWKS, consumer-side token caching/refresh (0.9 expiry buffer), and per-key rate
  limiting (token-bucket, 429 + Retry-After + RateLimit-* headers, circuit breaker). (3) The BATCH
  CHANNEL: scheduled/on-demand bulk-extraction JOBS (off the request path on the Fly worker),
  Parquet/CSV files + manifests, delivery via SFTP / S3 presigned-URL / secure-link / email, SSE-or-
  webhook 'file ready' notification, idempotency + file-fingerprint dedup + atomic write-temp-then-
  rename delivery. (4) The EXCEL CHANNEL: Office.js custom-function add-in vs xlwings-server vs legacy
  RTD, the formula-driver UX (=LUMINA.SERIES(...)), streaming functions + onCanceled, shared-runtime/
  CORS, manifest packaging. (5) SDK GENERATION + the developer portal: OpenAPI-as-source-of-truth,
  openapi-generator vs Fern/Speakeasy/Stainless vs a hand-written macrosynergy-style wrapper, a
  Scalar/Redoc docs portal, API-key issuance, and additive /v1 versioning. Use whenever the task
  touches the consumer-facing REST query API shape, the discovery-vs-retrieval split, channel auth
  (OAuth2 client_credentials / bearer JWT / API keys), rate limiting + quotas, the typed error
  contract, the batch/bulk-extraction channel (jobs, manifests, SFTP/S3/email delivery), the Excel
  add-in, OpenAPI 3.1 as contract, SDK generation, the developer portal, or API versioning — for this
  data-analytics product line. This is a DEV skill (teaches Claude-the-builder how to write the channel
  layer); it is never loaded at the Lumina runtime.
metadata:
  priority: 58
  sessionStart: false
  productLine: jpm-markets-reengineering
  pathPatterns:
    - '.agents/jpm-markets-reengineering/**'
  bashPatterns:
    - 'openapi-generator'
    - 'fern generate'
    - 'speakeasy'
    - 'office-addin'
    - 'xlwings'
    - 'presigned'
    - 'client_credentials'
  promptSignals:
    phrases:
      - 'delivery channel'
      - 'query api'
      - 'rest api contract'
      - 'two endpoint'
      - 'discovery vs retrieval'
      - 'catalog endpoint'
      - 'series retrieval'
      - 'dataset instrument expression'
      - 'asof'
      - 'maxpoints'
      - 'downsample'
      - 'lttb'
      - 'frequency aggregation'
      - 'cursor pagination'
      - 'keyset pagination'
      - 'next_cursor'
      - 'json envelope'
      - 'provenance'
      - 'commercialok'
      - 'oauth2 client credentials'
      - 'machine to machine'
      - 'bearer jwt'
      - 'jwks'
      - 'token refresh'
      - 'rate limit'
      - 'token bucket'
      - 'retry-after'
      - 'ratelimit header'
      - 'circuit breaker'
      - 'quota'
      - 'error contract'
      - 'needskey'
      - 'unavailable'
      - 'batch channel'
      - 'bulk extraction'
      - 'manifest'
      - 'parquet'
      - 'sftp'
      - 'presigned url'
      - 's3 delivery'
      - 'secure link'
      - 'file ready notification'
      - 'idempotent delivery'
      - 'file fingerprint'
      - 'excel add-in'
      - 'office.js'
      - 'custom functions'
      - 'streaming function'
      - 'xlwings'
      - 'rtd'
      - 'shared runtime'
      - 'openapi 3.1'
      - 'openapi source of truth'
      - 'sdk generation'
      - 'openapi-generator'
      - 'fern'
      - 'speakeasy'
      - 'stainless'
      - 'macrosynergy'
      - 'developer portal'
      - 'api key'
      - 'scalar'
      - 'redoc'
      - 'api versioning'
      - 'dataquery'
      - 'fusion'
    minScore: 2
---

# dataquery-delivery-channels — the consumer-facing channel layer for the JPM-Markets re-engineering line (NOT Lumina)

> **Product line.** This skill belongs to the **JPM-Markets re-engineering data-analytics product
> line** — a *separate* product line from Lumina (see [`cto-rules.md`](../../rules/cto-rules.md) §"Scope
> note"). That line is **new ground**: a **Python / FastAPI / data-engineering** stack on the data
> plane, with a thin TS gateway in front, NOT Lumina's Bun + Express + Prisma + Supabase + Upstash
> stack. Nothing in this skill wires into Lumina's app code. The two repos only share a filesystem
> home for the research.
>
> **What this skill makes you expert at.** Designing and building the **delivery channels** — the
> surfaces an OUTSIDE consumer touches — that turn the already-built data plane (catalog + time-series
> store) into a *consumable data product*. JPMorgan's own DataQuery ships its data through **four
> channels off one core**: a REST/Web API, an Excel add-in, a Python SDK, and bulk File Delivery
> ([J.P. Morgan — DataQuery](https://www.jpmorgan.com/markets/dataquery);
> [J.P. Morgan Developer — DataQuery API](https://developer.jpmorgan.com/products/dataquery_api)). We
> re-engineer that **one-OpenAPI-core → many-surfaces** pattern: the REST query API (discovery +
> retrieval), channel auth (OAuth2 client_credentials + bearer JWT + API keys), per-key rate limiting,
> the typed error contract, the async batch/bulk channel, the Excel add-in, and a generated SDK +
> developer portal. **This skill is the channel/contract layer only** — it consumes the data plane's
> store and discovery index; it does not build them.

This skill follows the **finance-markets gold-standard** cognitive-mesh structure: a thin router here,
deep cited references on demand. It is **greenfield** — the references are theory + design/recipe, not
yet `file:line` traces into a built codebase, because the product line has no committed channel code
yet.

> **Grounding, stated once (verified 2026-06; re-confirm at write time).** Every concrete external
> claim below is anchored to a primary source:
> - **JPM DataQuery's four channels** (REST API · Excel add-in · Python SDK · File Delivery):
>   [jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery).
> - **The official Python SDK's two-endpoint split + defaults**: `jpmorganchase/dataquery-sdk` exposes
>   discovery (`list_groups_async`, `search_groups_async`, `list_instruments_async`,
>   `search_instruments_async`) **separately from** retrieval (`get_expressions_time_series_async`,
>   `get_instrument_time_series_async`, `get_group_time_series_async`); rate-limit defaults are
>   **`DATAQUERY_REQUESTS_PER_MINUTE=300` / `DATAQUERY_BURST_CAPACITY=5`**, documented as *"300 rpm / 5
>   tps defaults (configurable up to API limits)"*; auth is **OAuth2 client_credentials** via
>   `DATAQUERY_CLIENT_ID` / `DATAQUERY_CLIENT_SECRET`
>   ([github.com/jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk)). **These
>   are CLIENT self-throttle defaults, not JPM's enforced server quota** — JPM's true enforced limit is
>   auth-walled and unknown; any "JPM enforces X" claim is `[unverified]`.
> - **The macrosynergy reference client** (a deliberate hand-written wrapper, the documented exception
>   to "always generate the SDK"):
>   [docs.macrosynergy.com — download.dataquery](https://docs.macrosynergy.com/latest/macrosynergy.download.dataquery.html);
>   [github.com/macrosynergy/dataquery-api](https://github.com/macrosynergy/dataquery-api).
> - **FRED's two-endpoint shape + server-side frequency aggregation** (`fred/series/search` +
>   `fred/series` for discovery vs `fred/series/observations` for retrieval, with `frequency` +
>   `aggregation_method ∈ {avg, sum, eop}`):
>   [fred/series/observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html).
> - **LTTB downsampling** (Largest-Triangle-Three-Buckets): Sveinn Steinarsson, *"Downsampling Time
>   Series for Visual Representation,"* MSc thesis, University of Iceland, 2013
>   ([skemman.is record](https://skemman.is/handle/1946/15343)).
> - **The RateLimit header fields** (`RateLimit-Limit/-Remaining/-Reset` + `Retry-After` on `429`):
>   IETF httpapi WG draft
>   ([draft-ietf-httpapi-ratelimit-headers](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/))
>   — a draft, not a published RFC; the three-field form is the widely-deployed de-facto convention.
> - **Office.js custom functions**: shared runtime recommended, `@streaming` +
>   `CustomFunctions.StreamingInvocation` + `onCanceled`, and *"A streaming function can't use the
>   `@cancelable` tag"*
>   ([custom-functions-web-reqs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs);
>   [custom-functions-runtime](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-runtime)).
> - **SDK generators**: OpenAPI Generator (50+ langs, OpenAPI-as-source-of-truth, air-gapped),
>   Speakeasy (OpenAPI source of truth), Stainless (powers OpenAI/Anthropic/Cloudflare SDKs, custom
>   DSL), Fern (acquired by Postman, Jan 2026; DSL)
>   ([speakeasy.com comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)).
> An option that does not exist in the cited version is a hallucination and fails review. Confidence
> may not exceed the evidence rung (primary docs > source read > single blog > recall — flag the last
> `[unverified]`).

---

## Domain Identity

### This skill COVERS

The **delivery-channel / contract / auth / SDK layer** that sits on top of the JPM-Markets
re-engineering data plane — what the outside consumer touches:

- **The REST query API contract** — the universal **two-endpoint shape** (a *discovery* surface to
  browse/search the catalog: datasets → instruments → expressions; a *retrieval* surface to pull the
  numbers), the `dataset→instrument→expression` addressing model, the read-from-store-not-upstream
  boundary, and how the channel layer composes over the data plane. (`theory-query-api-contract.md`)
- **The series-retrieval endpoint** — every query parameter (`asOf`/`range`/`from`/`to`/`frequency`/
  `aggregation`/`units`/`maxPoints`), defaults, validation, point-in-time vintage (`asOf`) handling,
  and the JSON response envelope (`data` + `Provenance{source, commercialOk, attribution}` + `meta`).
  (`patterns-series-retrieval-endpoint.md`)
- **The catalog/discovery endpoint as a CHANNEL** — the consumer-facing contract a developer hits to
  browse/search datasets/groups/instruments/expressions. Consumes the **faceted-discovery-search**
  index; specifies the API *shape*, not the index internals. (`patterns-catalog-discovery-endpoint.md`)
- **Server-side reductions at the API boundary** — (a) **frequency aggregation** from pre-rolled
  buckets (serve the monthly rollup for a monthly request, never raw daily), and (b) **point-count
  downsampling** (LTTB / `time_bucket`) to a declared `maxPoints`, with a **mandatory default cap**.
  (`patterns-server-side-downsampling-aggregation.md`)
- **Pagination** — **cursor/keyset** for the unbounded retrieval path, offset only for the small
  bounded catalog, the `next_cursor`/`has_more`/`max page size` envelope, the `links.next` model.
  (`theory-pagination-cursor-vs-offset.md`)
- **Channel auth** — **OAuth2 client_credentials** machine-to-machine, short-lived bearer **JWT**
  issuance + local verification against cached **JWKS**, consumer-side token caching/refresh (0.9
  expiry buffer, de-duped refresh, single-401 retry), **API-key** issuance, and the secrets-by-closure
  rule. (`patterns-oauth2-client-credentials-auth.md`)
- **Per-key rate limiting + quotas** — **token-bucket** vs sliding-window, `429` + `Retry-After` +
  `RateLimit-Limit/-Remaining/-Reset` headers, the circuit breaker, and the gateway implementation
  pattern (atomic counter, never read-then-write). (`patterns-rate-limiting-and-quotas.md`)
- **The typed error contract** — one stable error envelope (`code`, `message`, `retryable`,
  `requestId`) + correct status codes (`400/401/403/404/429/503`), with **`needsKey`/`unavailable` as
  first-class typed states**, shared across every channel. (`patterns-error-contract-and-status-codes.md`)
- **The BATCH channel architecture** — scheduled vs on-demand bulk **extraction JOBS** (off the request
  path on the Fly worker), the manifest, idempotency, atomic delivery, the job lifecycle.
  (`theory-batch-channel-architecture.md`)
- **Batch delivery transports** — **SFTP** vs **S3 presigned-URL** vs **secure-link** vs **email**
  (AWS Transfer Family), with security/automation/notification (SSE/webhook) per transport.
  (`patterns-batch-delivery-transports.md`)
- **Batch file + manifest format** — **Parquet vs CSV**, partitioning, the manifest JSON schema
  (run id, row counts, per-file checksums, per-file `commercialOk`), compression, file naming.
  (`patterns-batch-file-and-manifest-format.md`)
- **The EXCEL channel decision** — **Office.js custom functions** vs **xlwings-server** vs legacy
  **RTD**, the platform/runtime constraints, the trade-off matrix. (`theory-excel-channel-options.md`)
- **The Office.js add-in build** — the formula API (`=LUMINA.SERIES(...)`), streaming functions
  (`@streaming` + `onCanceled`), shared-runtime/CORS, the manifest, authenticating into our API, the
  production gotchas. (`patterns-officejs-custom-functions.md`)
- **OpenAPI 3.1 as the single contract source** — FastAPI emission (JSON Schema 2020-12), stable
  `operationId`/tags, documented pagination/error/rate-limit/auth schemas, reconciling the TS-gateway
  spec with the Python data-plane spec. (`patterns-openapi-31-source-of-truth.md`)
- **SDK generation + the published client** — openapi-generator vs **Fern/Speakeasy/Stainless** vs a
  deliberate hand-written **macrosynergy-style** wrapper; the Python client shape; pagination/retry/
  auth helpers; PyPI publish. (`patterns-sdk-generation-and-wrapper.md`)
- **The developer portal + keys** — API-key issuance + self-serve console, the docs portal (**Scalar**
  vs **Redoc** vs Swagger UI), and how `commercialOk`/attribution surface to the consumer.
  (`patterns-developer-portal-and-keys.md`)
- **API versioning + lifecycle** — URL `/v1` vs header vs media-type, additive-vs-breaking change
  rules, deprecation policy, CI contract-diff gating. (`theory-api-versioning-and-lifecycle.md`)
- **In-line grounding in the incumbents** — JPM DataQuery's four channels, the official SDK, and the
  FRED / World-Bank / LSEG / Bloomberg reference contracts every design choice is anchored to.
  (`theory-incumbent-channel-models.md`)

### This skill does NOT cover

- **NOT the data-plane internals** — ingestion, the TET/Fetcher normalization, the security master /
  symbology, the TimescaleDB/Parquet write path, the DCAT/PROV catalog model. Those are
  **data-normalization-tet**, **security-master-symbology**, **timescaledb-timeseries**,
  **columnar-parquet-arrow**, **data-pipeline-worker-cron**, **data-provenance-licensing**. This skill
  *reads from* the store; it never writes it.
- **NOT the discovery INDEX internals** — the GIN/`pg_trgm` faceted filter, matching-vs-ranking, the
  autocomplete index. That is **faceted-discovery-search**. This skill *consumes* its `/catalog`
  capability and specifies the channel-facing API shape; it does not build the index.
- **NOT the MCP agent channel.** That is **mcp-server-building** / the distribution-MCP-channel project.
  The agent-tool surface is a *different* channel built elsewhere.
- **NOT the visualization dashboard / charting UI.** That is the DataQuery system-design doc +
  **lumina-frontend**. This skill produces the downsampled series the chart draws; it does not draw it.
- **NOT the licensing VERDICTS themselves.** This skill **carries** `Provenance{commercialOk}` through
  every channel and renders the required attribution, but the per-source GREEN/RED rulings live in
  **data-provenance-licensing** + the [sources-ledger](../../memory/sources-ledger.md).
- **NOT the Python FastAPI service skeleton / deploy** (the app object, lifespan, DI, the shared httpx
  client, Dockerfile, Fly deploy). That is **python-fastapi-data-service**. This skill defines the
  *routes/contract/channels* that service hosts; it does not stand up the service.
- **NOT a Lumina runtime skill.** This is a **dev** skill: it teaches Claude-the-builder how to write
  the channel layer. It is never loaded by the Lumina product at runtime.

---

## Decision Tree — task → the ONE reference to open

Open the matched reference and read its **Non-Negotiables / decision tables / runnable code** before
writing channel code. Never load the whole `references/` folder.

| The task is to… | Read this reference |
|---|---|
| Design the REST query API shape — what endpoints exist, the `dataset→instrument→expression` addressing, the discovery-vs-retrieval split, the read-from-store boundary | `theory-query-api-contract.md` |
| Define the series-retrieval parameters (`asOf`/`range`/`frequency`/`aggregation`/`units`/`maxPoints`) and the JSON response envelope | `patterns-series-retrieval-endpoint.md` |
| Build the catalog/discovery endpoint surface (browse/search/groups/instruments) as a channel — the consumer-facing contract over the index | `patterns-catalog-discovery-endpoint.md` |
| Do server-side frequency aggregation + LTTB/`time_bucket` downsampling at the API boundary; the `maxPoints` cap | `patterns-server-side-downsampling-aggregation.md` |
| Choose pagination — cursor vs offset, the `next_cursor` envelope, max page size, the `links.next` model | `theory-pagination-cursor-vs-offset.md` |
| Authenticate the channel — OAuth2 client_credentials, bearer JWT, token caching/refresh, JWKS verification, API keys | `patterns-oauth2-client-credentials-auth.md` |
| Rate-limit per key — token-bucket vs sliding-window, `429`/`Retry-After`/`RateLimit-*` headers, circuit breaker, quotas | `patterns-rate-limiting-and-quotas.md` |
| Define the typed error contract + status codes + `needsKey`/`unavailable` across all channels | `patterns-error-contract-and-status-codes.md` |
| Design the BATCH channel — scheduled/on-demand jobs, manifests, idempotency, atomic delivery, the worker boundary | `theory-batch-channel-architecture.md` |
| Choose the batch DELIVERY transport — SFTP vs S3 presigned-URL vs secure-link vs email; AWS Transfer Family; notifications (SSE/webhook) | `patterns-batch-delivery-transports.md` |
| Generate the batch files — Parquet vs CSV, partitioning, the manifest schema, checksums, file naming | `patterns-batch-file-and-manifest-format.md` |
| Choose the EXCEL channel approach — Office.js custom functions vs xlwings-server vs RTD; the trade-off matrix | `theory-excel-channel-options.md` |
| Build the Office.js custom-function add-in — formula UX, streaming functions, shared runtime/CORS, manifest, auth | `patterns-officejs-custom-functions.md` |
| Make OpenAPI 3.1 the single contract source — FastAPI emission, JSON Schema 2020-12, `operationId`/tags, reconciling the TS-gateway spec | `patterns-openapi-31-source-of-truth.md` |
| Generate + publish the SDK — openapi-generator vs Fern/Speakeasy/Stainless vs the hand-written macrosynergy wrapper; the Python client | `patterns-sdk-generation-and-wrapper.md` |
| Build the developer portal + API-key onboarding + docs (Scalar vs Redoc) + self-serve console | `patterns-developer-portal-and-keys.md` |
| Decide API versioning + lifecycle — URL `/v1`, additive vs breaking, deprecation policy, CI contract-diff gating | `theory-api-versioning-and-lifecycle.md` |
| Ground a design in how the incumbent does it — JPM DataQuery's 4 channels, the official SDK, FRED/World-Bank/LSEG/Bloomberg reference contracts | `theory-incumbent-channel-models.md` |

---

## Non-Negotiables — the rules that always apply

1. **TWO ENDPOINTS, NOT ONE — DISCOVERY IS SEPARATE FROM RETRIEVAL.** Every production time-series API
   converges on a **discovery** surface (browse/search the catalog: datasets → instruments →
   expressions) and a **retrieval** surface (pull the numbers). Confirmed across **FRED**
   (`fred/series/search` + `fred/series` vs `fred/series/observations` —
   [docs](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)), **JPM DataQuery**
   (group/instrument browse vs expression time-series), and the official
   **`jpmorganchase/dataquery-sdk`** (`list_groups_async`/`search_groups_async`/`list_instruments_async`
   vs `get_expressions_time_series_async` —
   [repo](https://github.com/jpmorganchase/dataquery-sdk)). **Never** collapse discovery into retrieval
   or ship a single freeform mega-endpoint: it kills caching, rate-limiting, ranking, and invites
   text-to-SQL injection. (`theory-query-api-contract.md`)

2. **THE API NEVER RETURNS MORE POINTS THAN THE CONSUMER CAN USE — REDUCE SERVER-SIDE, AT THE
   BOUNDARY.** Retrieval does **two** reductions and only at the API edge: (a) **frequency aggregation**
   — serve the pre-rolled monthly/weekly bucket, never raw daily for a monthly request (FRED's
   `frequency` + `aggregation_method` rule —
   [docs](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)); and (b) **chart
   downsampling** via **LTTB** (Steinarsson 2013, *Downsampling Time Series for Visual Representation*,
   University of Iceland — [skemman.is](https://skemman.is/handle/1946/15343)) / `time_bucket` to a
   `maxPoints` the panel declares. The gateway **MUST enforce a default `maxPoints` cap** so a raw HTTP
   call cannot pull an unbounded series. (`patterns-server-side-downsampling-aggregation.md`)

3. **CHANNEL AUTH IS OAuth2 client_credentials (MACHINE-TO-MACHINE), NOT A USER LOGIN.** Issue
   short-lived bearer **JWTs**; the consumer caches the token and **refreshes BEFORE expiry** (the JPM
   SDK pattern uses a 0.9 expiry buffer), **de-duplicates concurrent refreshes**, and **retries a single
   `401`** with a fresh token. The API **verifies the JWT locally against cached JWKS** (or
   introspects). Secrets never travel in query strings, a committed `.env`, or the model's tool args
   (repo non-negotiable #6 — **inject by closure** in the tool factory). Store API keys **hashed**.
   (`patterns-oauth2-client-credentials-auth.md`)

4. **PER-KEY RATE LIMITING IS MANDATORY AND STANDARDS-SHAPED.** Use **token-bucket** (controlled
   bursts; what the JPM SDK ships at its `300 rpm / 5 tps` client defaults —
   [repo](https://github.com/jpmorganchase/dataquery-sdk) — and what Stripe/AWS use) or sliding-window.
   Return **HTTP `429`** (never `200`, never `503`) with **`Retry-After`** AND
   **`RateLimit-Limit`/`-Remaining`/`-Reset`** headers (IETF httpapi WG draft —
   [draft-ietf-httpapi-ratelimit-headers](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/);
   a draft, the three-field form is the de-facto convention). Add a **circuit breaker** on repeated
   upstream failure. The counter is updated **atomically** — never read-then-write from app code.
   (`patterns-rate-limiting-and-quotas.md`)

5. **SERIES RETRIEVAL USES CURSOR/KEYSET PAGINATION, NEVER OFFSET, FOR ANY UNBOUNDED RESULT.** Offset
   degrades linearly (the DB scans+discards every skipped row) and silently **skips/dupes** rows under
   concurrent inserts; cursor/keyset stays constant-time over millions of rows and is concurrency-safe.
   Expose **`next_cursor` + `has_more` + a documented max page size** (the DataQuery model paginates via
   `response.links[].next`). Catalog **discovery** may use page/offset **only** because the result set
   is small and bounded. (`theory-pagination-cursor-vs-offset.md`)

6. **EVERY PAYLOAD ON EVERY CHANNEL CARRIES `Provenance{source, commercialOk, attribution}`;
   `commercialOk` DEFAULTS FALSE.** It is `true` **only** for a GREEN fetch path with the required
   attribution string **actually rendered / passed through** — this is the repo
   [commercial-ok-gate](../../rules/commercial-ok-gate.md), and **it does not weaken at a channel
   boundary**: a Parquet batch file, an Excel cell, and a JSON response all carry it. A composite that
   mixes a RED input is **RED** (contamination rule). **Never fabricate or backfill a number to make a
   channel response look complete** — a failed fetch returns typed **`unavailable`/`needsKey`**
   (repo non-negotiable #1). (`patterns-error-contract-and-status-codes.md`, `patterns-batch-file-and-manifest-format.md`)

7. **THE BATCH CHANNEL IS A JOB, NOT A SYNCHRONOUS REQUEST.** Bulk extraction (scheduled or on-demand)
   runs **OFF the request path on the Fly worker** (repo non-negotiable #4 — Vercel holds no
   sockets/timers; this product line's persistent service is on Fly, not serverless). It produces a
   **file + a manifest** (run id, row counts, checksums, per-file `commercialOk`), delivers it
   **atomically** (write-temp-then-rename / complete-multipart — never expose a half-written file), and
   notifies via **SSE/webhook** or a "list available files" poll. Re-delivery is **idempotent via file
   fingerprint** — reprocessing the same file produces no duplicate rows (the JPM File-Delivery +
   LSEG DataScope job model). (`theory-batch-channel-architecture.md`, `patterns-batch-delivery-transports.md`)

8. **OpenAPI 3.1 IS THE SINGLE CONTRACT SOURCE; THE SDK IS GENERATED FROM IT, NEVER HAND-DRIFTED.**
   FastAPI emits **OpenAPI 3.1** (JSON Schema 2020-12) natively; the TS-gateway spec is reconciled to
   it. Stable **`operationId`s + tags + documented error/pagination/rate-limit schemas** are required so
   generation is clean (OpenAPI Generator and Speakeasy both treat the spec as the single source of
   truth — [comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)). A
   **breaking** change bumps the URL major version (`/v1 → /v2`); **additive** changes (new optional
   params, new fields, new endpoints) ship within a version. **CI fails on an undocumented breaking
   diff.** (`patterns-openapi-31-source-of-truth.md`, `theory-api-versioning-and-lifecycle.md`)

> **R-SCALE note (always state the tier).** Per [`product-at-scale.md`](../../rules/product-at-scale.md)
> + `~/.claude/rules/product-scale-architecture.md`: the retrieval path is a **list/series surface**
> (server-side aggregate + downsample + cursor-paginate + index the sort key), the home/catalog reads
> are **compute-once-serve-many** (cron-warmed rollups + cache), and the batch channel is **heavy
> ingest off the request path**. Every channel design names the tier it survives (1× demo / 100×
> traction / 10,000× product) and what breaks at the next — in numbers, not "it'll be fine."

---

## Anti-Patterns — mistake → fix

| Anti-pattern (the mistake) | The fix |
|---|---|
| Shipping **ONE endpoint** that does both discovery and retrieval (a freeform query string the model fills). | Collapses the catalog/series split every production API keeps separate, makes caching/rate-limiting/ranking impossible, and invites text-to-SQL injection. **Keep `/catalog` and `/series` distinct with typed params** — the FRED + JPM-SDK shape. (NN1) |
| Returning the **full series** and letting the client downsample. | A 20-year daily series (~5k pts) or intraday melts the browser and wastes egress; the SVG chart degrades long before canvas. **Downsample SERVER-side (LTTB/`time_bucket`) to the declared `maxPoints`, and enforce a default cap** so a raw API call can't bypass it. (NN2) |
| **Offset pagination** on the retrieval path (`?page=900&size=100`). | The DB scans and throws away 90,000 rows per page; at millions of observations it is horrendous and silently **skips/dupes** rows under concurrent writes. **Use cursor/keyset on a stable indexed sort key.** (NN5) |
| Putting the API key / `client_secret` in the **URL query string**, a committed `.env`, or the **model's tool arguments**. | It leaks into logs, browser history, and CDN caches. **Use `Authorization: Bearer`, inject secrets by closure in the tool factory** (repo non-negotiable #6), and **store keys hashed**. (NN3) |
| Treating the batch channel as **"a slow GET."** | Generating a 2 GB Parquet file inside a serverless request times out and holds a socket; exposing the file before it's fully written delivers a truncated feed; re-delivering without a fingerprint **double-loads** the consumer's warehouse. **Run it as an async worker job with a manifest, atomic publish, and idempotent re-delivery.** (NN7) |
| Building the Excel add-in on the **legacy/deprecated path** or ignoring the runtime constraints. | A **synchronous** custom function in production (Microsoft recommends the **shared runtime** instead), CORS fetches without the shared long-lifetime runtime (the request fails), or a streaming function that tries `@cancelable` (*"A streaming function can't use the `@cancelable` tag"* — [docs](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-web-reqs)) — use the **`onCanceled` callback**. Office.js custom functions need **Excel 2021/365 + shared runtime**; choose **xlwings-server** only if you want server-pushed WebSocket streaming without writing Office.js. |
| **Hand-writing the SDK and the OpenAPI spec separately** so they drift. | The spec must be **generated from the service** (FastAPI) and the SDK **generated from the spec**; a hand-maintained client (the **macrosynergy** pattern) is a **deliberate, documented exception** for ergonomics, NOT an accident. An un-versioned breaking change with no `/v2` silently breaks every consumer's pinned client. (NN8) |
| **Inventing JPM's enforced server-side rate limit / response schema as fact.** | The macrosynergy client's `20-expr/250ms` and the SDK's `300 rpm / 5 tps` are **CLIENT self-throttle defaults** *"configurable up to API limits"* — **JPM's true enforced quota is auth-walled and unknown**. **Design OUR limits as an independent decision; tag any "JPM enforces X" claim `[unverified]`.** (NN4) |
| **Skipping the typed error contract** — a bare `500` or an HTML error page from a data API. | Consumers and generated SDKs need a stable error envelope (`code`, `message`, `retryable`, `requestId`) and the right status (`400` bad param, `401` auth, `403` license, `404` unknown series, `429` rate, `503` upstream). **`needsKey`/`unavailable` are first-class typed states, not exceptions.** (NN6) |
| **Charging/labeling a free upstream tier as commercially redistributable** when packaging a batch file or SDK response. | A free API tier is **not** a display/redistribution license; the channel **inherits the fetch-path verdict**. **Stamp `commercialOk` per series, render attribution where CC-BY requires it, and never let a convenient bulk export launder a RED source.** (NN6) |

---

## Output Contract — the grading rubric

A design or implementation produced under this skill is **done** only when:

1. **The two-endpoint split holds.** Discovery (browse/search the catalog) and retrieval (pull numbers)
   are **distinct typed endpoints**, not one freeform query; the `dataset→instrument→expression`
   addressing is explicit. (NN1)
2. **No channel returns more points than the consumer declared.** Retrieval does frequency aggregation
   from pre-rolled buckets **and** LTTB/`time_bucket` downsampling to `maxPoints`, and a **default
   `maxPoints` cap is enforced** at the gateway so a raw call can't pull unbounded. (NN2)
3. **Auth is OAuth2 client_credentials, verified locally.** Short-lived bearer JWT, JWKS verification
   (or introspection), consumer-side caching/refresh with the expiry buffer + de-duped refresh +
   single-`401` retry; secrets injected by closure, keys stored hashed, never in a query string. (NN3)
4. **Every key is rate-limited, standards-shaped.** Token-bucket (or sliding-window), `429` +
   `Retry-After` + `RateLimit-*` headers, a circuit breaker, an atomic counter (never read-then-write).
   (NN4)
5. **Pagination is cursor/keyset for the unbounded path.** `next_cursor` + `has_more` + documented max
   page size on retrieval; offset only on the small bounded catalog. (NN5)
6. **Every payload carries correct `Provenance{commercialOk}`.** Default `false`; `true` only for a
   GREEN fetch path with attribution rendered; composites with a RED input are RED; no fabricated/
   backfilled number; failures return typed `unavailable`/`needsKey`. The envelope is identical across
   JSON, Parquet, and Excel. (NN6)
7. **The batch channel is an async job.** It runs off the request path on the Fly worker, produces a
   file + manifest (run id, row counts, checksums, per-file `commercialOk`), publishes atomically, and
   is idempotent on re-delivery via file fingerprint. (NN7)
8. **The Excel channel is on a supported path.** Office.js custom functions on the shared runtime
   (Excel 2021/365) with streaming via `@streaming` + `onCanceled` (never `@cancelable` on a streaming
   function), or a justified xlwings-server choice — never a synchronous-in-production custom function.
9. **OpenAPI 3.1 is the single contract source and the SDK is generated from it.** Stable
   `operationId`s/tags, documented pagination/error/rate-limit/auth schemas; the SDK is generated (or
   the hand-written macrosynergy-style wrapper is a *documented* exception); CI fails on an undocumented
   breaking diff. (NN8)
10. **Versioning is explicit.** Breaking → `/v2`; additive ships within `/v1`; a deprecation policy is
    stated. (NN8)
11. **The typed error contract is complete.** Stable envelope + correct status per failure class +
    `needsKey`/`unavailable` as first-class states, identical across channels. (NN6)
12. **The R-SCALE tier is named in numbers.** Each channel states the tier it survives and the
    next-tier break; the retrieval path is server-aggregated + downsampled + cursor-paginated + indexed;
    the home/catalog reads are compute-once-serve-many; the batch channel is off-request. (R-SCALE note)
13. **Every incumbent / version / license claim is grounded or flagged.** JPM "enforced" limits are
    tagged `[unverified]`; every concrete API/option/license is cited to a primary source; confidence
    never exceeds the evidence rung.

---

## References

| File | When to read |
|---|---|
| `theory-incumbent-channel-models.md` | The primary-source teardown of how real financial-data products expose the same four channels, so every design choice in this skill is anchored to a shipped reference rather than invented. The "read the incumbents" grounding doc the rest of the skill cites. |
| `theory-query-api-contract.md` | The conceptual design of the REST query API as a whole: why the two-endpoint contract is universal, the `dataset→instrument→expression` addressing model, the read-from-store-not-upstream boundary, and how the channel layer sits on top of the data plane. The "what is the API" doc. |
| `patterns-series-retrieval-endpoint.md` | The concrete recipe for the series-retrieval endpoint: every query parameter, defaults, validation, the JSON response envelope, and `asOf`/point-in-time vintage handling. The single most-used endpoint, fully specified. |
| `patterns-catalog-discovery-endpoint.md` | The consumer-facing recipe for the catalog/discovery channel surface — the contract a developer hits to browse/search datasets, groups, instruments, and expressions. Consumes the faceted-discovery-search index but specifies the API shape, not the index internals. |
| `patterns-server-side-downsampling-aggregation.md` | The recipe for the two server-side reductions that happen only at the retrieval boundary: frequency aggregation from pre-rolled buckets and point-count downsampling (LTTB / `time_bucket`) to a declared `maxPoints`, with the mandatory default cap. |
| `theory-pagination-cursor-vs-offset.md` | The pagination decision and contract for all channels: why cursor/keyset beats offset for series, where offset is acceptable, and the standard envelope. A focused theory doc because getting this wrong is a Tier-3 break. |
| `patterns-oauth2-client-credentials-auth.md` | The channel-auth recipe: OAuth2 client_credentials machine-to-machine, bearer-JWT issuance + verification, token caching/refresh on the consumer side, API-key issuance, and the secret-handling rules. The auth half of every channel. |
| `patterns-rate-limiting-and-quotas.md` | The recipe for per-key rate limiting, quotas, and graceful-degradation headers across channels. Mandatory because an unmetered data API is a DoS vector and a cost balloon. |
| `patterns-error-contract-and-status-codes.md` | The typed error/status contract shared by every channel so consumers and generated SDKs handle failure deterministically — including the first-class `needsKey`/`unavailable` states. |
| `theory-batch-channel-architecture.md` | The architecture of the BATCH channel: scheduled vs on-demand extraction jobs, the worker boundary, manifests, idempotency, atomic delivery, and the job lifecycle. The conceptual half before the transport/format recipes. |
| `patterns-batch-delivery-transports.md` | The recipe for actually DELIVERING a batch file: SFTP vs S3 presigned-URL vs secure-link vs email, with security, automation, and notification for each. The transport half of the batch channel. |
| `patterns-batch-file-and-manifest-format.md` | The recipe for the batch file artifacts themselves: Parquet vs CSV, partitioning, the manifest JSON schema, checksums, compression, and file naming. What's actually in the delivered bundle. |
| `theory-excel-channel-options.md` | The decision doc for the EXCEL channel: Office.js custom functions vs xlwings-server vs legacy RTD, the platform/runtime constraints, and the trade-off matrix. Picks the approach before the build recipe. |
| `patterns-officejs-custom-functions.md` | The build recipe for the Office.js custom-function Excel add-in: the formula API, streaming functions, shared-runtime/CORS config, the manifest, authenticating into our API, and the production gotchas. |
| `patterns-openapi-31-source-of-truth.md` | The recipe for making OpenAPI 3.1 the single contract source: FastAPI emission, the JSON Schema 2020-12 alignment, stable `operationId`s/tags, documenting pagination/error/rate-limit/auth schemas, and reconciling the TS gateway spec with the Python data-plane spec. |
| `patterns-sdk-generation-and-wrapper.md` | The recipe for generating and publishing the client SDK: openapi-generator vs Fern/Speakeasy/Stainless vs a deliberate hand-written macrosynergy-style wrapper; the Python client shape; pagination/retry/auth helpers; PyPI publish. |
| `patterns-developer-portal-and-keys.md` | The recipe for the developer-facing portal: API-key issuance + self-serve console, the docs portal (Scalar vs Redoc vs Swagger UI), and how `commercialOk`/attribution surface to the consumer. The onboarding surface. |
| `theory-api-versioning-and-lifecycle.md` | The versioning + lifecycle decision: URL `/v1` vs header vs media-type, additive vs breaking change rules, deprecation policy, and CI contract-diff gating. Protects every consumer's pinned SDK from silent breakage. |
