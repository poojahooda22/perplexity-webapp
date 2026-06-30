---
name: python-fastapi-data-service
description: >
  Build the PERSISTENT Python data-plane foundation for the JPM-Markets re-engineering
  data-analytics product line (NOT Lumina) — the FastAPI service that re-engineers DataQuery/Fusion
  into our own, on a NEW Python/FastAPI/data-engineering stack separate from Lumina's
  Bun + Express + Prisma + Supabase + Upstash stack. This is the P0 skeleton every other Python
  data-plane skill plugs into. Covers the FastAPI app object (Python 3.12+, FastAPI 0.138.x,
  Pydantic v2.13.x, Uvicorn 0.49.x), the lifespan async-context-manager for startup/shutdown of shared
  resources (DB pool, object-store client, the ONE shared httpx.AsyncClient), dependency-injection
  design (Depends chains, app.state singletons, dependency_overrides), the async-def-vs-def route
  discipline and the AnyIO threadpool, off-request heavy work (BackgroundTasks limits vs the external
  worker boundary), Pydantic v2 modeling + pydantic-core performance, pydantic-settings config, the
  shared async httpx upstream client (pools/Limits/Timeout/retries), uv packaging + reproducible
  multi-stage Docker, the Uvicorn/Gunicorn process model + graceful shutdown, project structure
  (routers/services/repositories), structured JSON logging + correlation IDs, RFC-9457 error handling,
  OpenAPI 3.1 as the SDK source of truth, dependency security (API key / OAuth2 / JWT as a dependency),
  pytest + httpx ASGITransport testing, and PERSISTENT deploy on Fly — INCLUDING the first-principles
  reason a shared-pool / shared-client service cannot be a Vercel serverless function. It owns the
  read-never-fetches / write-only-fetches boundary at the FRAMEWORK level. Use whenever the task touches
  standing up or changing this Python service: the app/lifespan, a route's async-vs-def choice, a
  Depends/DI design, the shared httpx client, pydantic-settings config, the Dockerfile/uv lockfile, the
  Uvicorn process model, error/logging/auth middleware, the OpenAPI contract, service tests, or the Fly
  deploy. This is a DEV skill (teaches Claude-the-builder how to write Python service code); it is never
  loaded at the Lumina runtime.
metadata:
  priority: 60
  sessionStart: false
  productLine: jpm-markets-reengineering
  pathPatterns:
    - '.agents/jpm-markets-reengineering/**'
  bashPatterns:
    - 'fastapi'
    - 'uvicorn'
    - 'pydantic'
    - 'uv sync'
    - 'uv run'
    - 'uv lock'
    - 'httpx'
    - 'pytest'
  promptSignals:
    phrases:
      - 'fastapi'
      - 'uvicorn'
      - 'pydantic'
      - 'pydantic-settings'
      - 'lifespan'
      - 'asynccontextmanager'
      - 'depends'
      - 'dependency injection'
      - 'background tasks'
      - 'async def'
      - 'run_in_threadpool'
      - 'anyio'
      - 'event loop'
      - 'httpx'
      - 'asyncclient'
      - 'uv lock'
      - 'pyproject.toml'
      - 'multi-stage dockerfile'
      - 'gunicorn'
      - 'graceful shutdown'
      - 'problem details'
      - 'rfc 9457'
      - 'openapi'
      - 'correlation id'
      - 'asgitransport'
      - 'data plane'
      - 'data service'
      - 'python service'
      - 'fly.io'
    minScore: 2
---

# python-fastapi-data-service — the persistent Python data plane for the JPM-Markets re-engineering line (NOT Lumina)

> **Product line.** This skill belongs to the **JPM-Markets re-engineering data-analytics product
> line** — a *separate* product line from Lumina (see [`cto-rules.md`](../../rules/cto-rules.md) §"Scope
> note"). That line is **new ground**: a **Python / FastAPI / data-engineering** stack, NOT Lumina's
> Bun + Express + Prisma + Supabase + Upstash stack. Nothing in this skill wires into Lumina's app code.
> The two repos only share a filesystem home for the research.
>
> **What this skill makes you expert at.** Standing up and operating the **persistent Python service**
> that IS the data plane — the FastAPI process that the re-engineered DataQuery/Fusion analytics product
> reads from. Every other Python data-plane skill (the TimescaleDB store, the OpenBB normalization
> layer, the security master, the licensing catalog, the ingest worker) plugs *into this skeleton*. This
> skill owns the **framework**: the app object, the lifespan, dependency injection, the async/sync
> discipline, the single shared httpx client, config, packaging, the container, the process model, and
> the Fly deploy — and it owns, at the **framework level**, the hard **read-never-fetches /
> write-only-fetches** boundary (the read API has no upstream client injected at all).

This skill follows the **finance-markets gold-standard** cognitive-mesh structure: a thin router here,
deep cited references on demand. It is **greenfield** — the references are theory + design/recipe, not
yet `file:line` traces into a built codebase, because the product line has no committed code yet.

> **The pinned line, stated once (verified 2026-06; re-confirm at write time).**
> **Python 3.12+** · **FastAPI 0.138.0** (requires Python ≥3.10, supports 3.10–3.14) · **Pydantic
> 2.13.4** (2026-05-06; pydantic-core now lives in the pydantic repo but ships as a separate wheel) ·
> **Starlette** (FastAPI's ASGI substrate) · **Uvicorn 0.49.0** · **httpx 0.28.1** · **uv 0.11.24**
> (still pre-1.0 — minor versions shift behavior; pin it). Every concrete API claim below is checked
> against these versions' primary docs. An option that does not exist in the installed version is a
> hallucination and fails review. Full pinning detail: `uv-packaging-and-reproducibility.md`.
> Sources: [PyPI fastapi 0.138.0](https://pypi.org/pypi/fastapi/json) ·
> [Pydantic v2.13.4 changelog](https://pydantic.dev/docs/validation/latest/get-started/changelog/) ·
> [PyPI uvicorn 0.49.0](https://pypi.org/pypi/uvicorn/json) ·
> [PyPI httpx 0.28.1](https://pypi.org/pypi/httpx/json) ·
> [PyPI uv 0.11.24](https://pypi.org/pypi/uv/json).

---

## Domain Identity

### This skill COVERS

The **persistent FastAPI service skeleton** for the JPM-Markets re-engineering data-analytics line:

- **The FastAPI app object + the lifespan async context manager** — `@asynccontextmanager` for
  startup/shutdown of shared resources (DB pool, object-store client, the single shared
  `httpx.AsyncClient`), `app = FastAPI(lifespan=lifespan)`, the `yield` boundary, and the scalable
  domain-module project structure (`routers/`, `services/`, `repositories/`, `models/`, `core/`).
  (`fastapi-app-structure-and-lifespan.md`)
- **Dependency injection** — `Depends` chains, request-scoped caching/reuse, the **app.state-singleton-
  via-dependency** pattern (lifespan creates it, a `Depends` reads it), `yield`-dependencies for
  per-request setup/teardown, and `dependency_overrides` as the test seam. (`dependency-injection-and-lifespan.md`)
- **The async-def-vs-def route discipline** — `async def` only when the body awaits non-blocking I/O the
  whole way; blocking/sync work in a plain `def` (FastAPI runs it in the AnyIO threadpool, default 40
  threads), or explicit `run_in_threadpool`; CPU-bound work off-process. The highest-blast-radius
  performance topic. (`async-sync-and-concurrency.md`)
- **Off-request heavy work** — `BackgroundTasks` (fire-and-forget, in-process, no persistence) vs the
  external **worker/cron** write-path; the hard decision boundary. (`background-work-and-the-worker-boundary.md`)
- **Pydantic v2 modeling** — `BaseModel`, fields/validators, `model_validate`/`model_dump`/
  `model_construct`, serialization, and the pydantic-core validate-vs-construct cost model at
  financial-series volume. (`pydantic-v2-modeling.md`)
- **Configuration & secrets** — pydantic-settings `BaseSettings`, env precedence, nested settings,
  `secrets_dir`, fail-fast startup, one cached `Settings` singleton. (`pydantic-settings-config.md`)
- **The single shared async httpx client** — the ONE `httpx.AsyncClient` that is the only thing in the
  data plane allowed to fetch upstream (used by the write-path), with explicit `Limits`/`Timeout`,
  retries, and failure isolation; read-path handlers never get it injected. (`async-httpx-client.md`)
- **Packaging with uv** — `pyproject.toml`, `uv.lock`, dependency groups, `.python-version`, the
  `uv run`/`sync`/`add` workflow, reproducibility. (`uv-packaging-and-reproducibility.md`)
- **The production Dockerfile** — RECIPE: multi-stage with the official `ghcr.io/astral-sh/uv` image,
  cache mounts, `uv sync --locked`, bytecode compile, slim runtime. (`patterns-uv-docker-image.md`)
- **The ASGI server / process model** — Uvicorn as the committed server, workers-vs-replication,
  graceful shutdown on SIGTERM, timeouts; the Gunicorn caveats. (`uvicorn-gunicorn-process-model.md`)
- **Deploy on Fly** — `fly.toml`, Dockerfile wiring, health checks, internal port, rolling deploy,
  volumes — AND the first-principles argument for why this service cannot be a Vercel serverless
  function. (`lumina-deploy-on-fly.md`)
- **Error handling** — registered exception handlers, `RequestValidationError` shaping, the RFC 9457
  `application/problem+json` envelope; one error contract. (`error-handling-and-problem-details.md`)
- **Structured logging & observability** — JSON logs with per-request correlation IDs, `contextvars`,
  request middleware, Uvicorn logger integration; async-safe. (`structured-logging-and-observability.md`)
- **API security as dependencies** — API key / OAuth2 / JWT validation via `Depends`/`Security`, scopes,
  the secrets-by-closure rule; authn AND authz. (`api-security-dependencies.md`)
- **OpenAPI as the contract** — the emitted OpenAPI 3.1 doc as the single SDK/portal source of truth,
  `operation_id`/`tags`/`response_model`, additive `/api/v1` versioning. (`openapi-as-contract-and-versioning.md`)
- **Testing the service** — pytest + `httpx.ASGITransport` AsyncClient, `anyio`, async fixtures,
  `dependency_overrides`, mocking the upstream httpx so the read path is provider-independent. (`testing-the-data-plane.md`)
- **In-project orientation** — where this Python data plane sits vs the TS gateway / write-path worker /
  store, and the read-never-fetches contract made concrete. The map a builder reads FIRST.
  (`lumina-data-plane-topology.md`)

### This skill does NOT cover

- **NOT the OpenBB Fetcher[Q,R] Transform-Extract-Transform normalization pattern, or the AGPL trap.**
  That is the **openbb-tet-normalization** skill. This skill owns the *service that calls* a normalizer,
  not the normalizer.
- **NOT the bitemporal security master / FIGI symbology.** That is **security-master-symbology**.
- **NOT the DCAT/PROV catalog or the `commercialOk`-on-fetch-path licensing model.** That is
  **data-provenance-licensing**. This skill enforces *where fetches may happen* (write-path only); the
  licensing *verdict* per fetch path is that skill's job.
- **NOT the TimescaleDB hypertable/continuous-aggregate store internals.** That is
  **timescaledb-timeseries**. This skill owns the connection-pool *lifecycle* (created in lifespan) and
  the repository call site; the SQL and hypertable design are that skill's.
- **NOT the PyArrow Parquet distributions or Arrow Flight transport.** That is **columnar-parquet-arrow**.
- **NOT the faceted / keyword / vector discovery API** — that lives on the **TS gateway**, not this
  Python plane (→ **faceted-discovery-search**).
- **NOT the idempotent bitemporal write-path worker or cron scheduling.** That is
  **data-pipeline-worker-cron**. This skill owns the *boundary* (heavy/ingest work leaves the request
  path); the worker's internals are that skill's.
- **NOT the MCP server surface** (→ **mcp-server-building**) **nor the published SDK/docs-portal
  generation beyond OpenAPI emission** (→ **api-publishing-sdk-portal**). This skill *emits* the OpenAPI
  3.1 doc; turning it into a portal + typed SDKs is downstream.
- **NOT Lumina's existing stack** — the **TS gateway**, the Upstash-Redis `getOrRefresh` cache, and
  Supabase auth are reused via Lumina's own `redis` / `supabase` / `finance-markets` skills, not
  rebuilt here. Do not import those patterns into the Python plane.
- **NOT generic React/TS frontend.** Out of scope entirely.
- **NOT a Lumina runtime skill.** This is a **dev** skill: it teaches Claude-the-builder how to write
  Python service code. It is never loaded by the Lumina product at runtime.

---

## Decision Tree — task → the ONE reference to open

Open the matched reference and read its **Non-Negotiables / decision tables / runnable code** before
writing Python. Never load the whole `references/` folder.

| The task is to… | Read this reference |
|---|---|
| Orient: where the Python data plane sits vs the TS gateway / worker / store, and the read-never-fetches contract at the framework level | `lumina-data-plane-topology.md` |
| Stand up the FastAPI app object, wire routers, structure the repo (where routers/services/settings/lifespan live) | `fastapi-app-structure-and-lifespan.md` |
| Decide what goes in lifespan vs a `Depends`; design dependency chains, app.state singletons, `dependency_overrides` for tests | `dependency-injection-and-lifespan.md` |
| Choose `async def` vs `def`; fix an event-loop stall; `run_in_threadpool`; AnyIO threadpool sizing; CPU-bound offload | `async-sync-and-concurrency.md` |
| Decide BackgroundTasks vs the external worker; where heavy/ingest/retryable work belongs | `background-work-and-the-worker-boundary.md` |
| Model request/response data with Pydantic v2; validators; serialization; `model_validate`/`model_dump`/`model_construct`; performance | `pydantic-v2-modeling.md` |
| Configure & load secrets via pydantic-settings `BaseSettings`; env precedence; nested settings; fail-fast | `pydantic-settings-config.md` |
| Build the single shared async httpx client: pools, `Limits`, `Timeout`, retries, failure isolation (the only thing that fetches upstream) | `async-httpx-client.md` |
| Package with uv: `pyproject.toml`, `uv.lock`, dependency groups, python pinning, `uv run`/`sync`/`add` reproducibility | `uv-packaging-and-reproducibility.md` |
| Write the production Dockerfile (uv multi-stage, cache mounts, `--locked`, bytecode, slim image) for the data plane | `patterns-uv-docker-image.md` |
| Choose/operate the ASGI server: Uvicorn vs Gunicorn, workers vs replication, graceful shutdown, timeouts, concurrency limits | `uvicorn-gunicorn-process-model.md` |
| Deploy the persistent service to Fly (fly.toml, health checks, internal port, rolling deploy, volumes) and WHY not Vercel | `lumina-deploy-on-fly.md` |
| Return consistent machine-readable errors (RFC 9457 `problem+json`), custom exception handlers, `RequestValidationError` shaping | `error-handling-and-problem-details.md` |
| Emit structured JSON logs with correlation/request IDs, `contextvars`, request middleware, Uvicorn log integration | `structured-logging-and-observability.md` |
| Secure endpoints: API key / OAuth2 / JWT validation as a dependency, scopes, secrets-by-closure | `api-security-dependencies.md` |
| Treat the emitted OpenAPI 3.1 doc as the SDK/portal source of truth: `operation_id`, tags, `response_model`, `/api/v1` versioning | `openapi-as-contract-and-versioning.md` |
| Test the service: pytest + `httpx.ASGITransport` AsyncClient, anyio, async fixtures, `dependency_overrides`, mocking httpx upstreams | `testing-the-data-plane.md` |

---

## Non-Negotiables — the rules that always apply

1. **THE DATA PLANE IS A PERSISTENT PROCESS, NEVER A VERCEL SERVERLESS FUNCTION.** A connection pool, the
   single shared `httpx.AsyncClient`, in-memory caches, and the lifespan-initialised singletons all
   **die between serverless invocations**: each cold boot re-establishes connections, and under
   serverless the FastAPI **lifespan often does not run at all** (or runs per-cold-instance), so the
   pool you "created once" is created per-instance and leaked on suspend. Vercel's own docs confirm it:
   *"Database connections cannot be shared between serverless invocations… each time your serverless
   function is called (while cold), a new database connection will need to be established"*
   ([Vercel KB, Connection Pooling with Functions](https://vercel.com/kb/guide/connection-pooling-with-functions)).
   Deploy as **one (or N) long-running Uvicorn process(es) on Fly**; let **Fly replication**, not a
   serverless platform, scale it. State this in any deploy design. (`lumina-deploy-on-fly.md`)

2. **READ NEVER FETCHES; WRITE-ONLY FETCHES — ENFORCED AT THE FRAMEWORK LAYER.** The read path serves
   only from the **store + cache**; it never calls an upstream provider. The **write-path/worker** is the
   ONLY thing that calls `httpx` out to a provider, and it runs **off the request path**. This is
   enforced structurally here: **read-API route handlers have NO httpx client injected** (the
   `get_http_client` dependency exists only in the write-path/worker entrypoints). A read handler that
   imports or constructs an httpx client is a contract violation, not a convenience.
   (`lumina-data-plane-topology.md`, `async-httpx-client.md`)

3. **PIN EXACT VERSIONS AND COMMIT A LOCKFILE.** Use **uv** with a committed **`uv.lock`**; pin **uv
   itself** (pre-1.0, 0.11.x — minor versions shift behavior) and a **`.python-version`** (3.12+). In
   Docker use **`uv sync --locked`** (or `--frozen`) so a build **fails** rather than silently
   re-resolving. Never `pip install` loose ranges into a production image. A transitive bump that changes
   behavior in prod but not locally is exactly the bug the verify-never-assert standard exists to kill.
   (`uv-packaging-and-reproducibility.md`, `patterns-uv-docker-image.md`)

4. **INITIALISE/TEAR DOWN EVERY SHARED RESOURCE IN THE LIFESPAN; STORE SINGLETONS ON `app.state`.** The
   `@asynccontextmanager` lifespan creates the shared `httpx.AsyncClient`, the DB pool, and the
   object-store client **once before `yield`** and closes them **once after `yield`** — never per
   request, never as a module-level mutable global. Store them on `app.state` (or a typed lifespan-state
   object) and read them through a `Depends`. Module globals cause import-order bugs, leak state between
   tests, and silently fail where startup may not run. (`fastapi-app-structure-and-lifespan.md`,
   `dependency-injection-and-lifespan.md`)

5. **EXACTLY ONE SHARED `httpx.AsyncClient`, WITH EXPLICIT `Limits` AND `Timeout`.** Create it in the
   lifespan; never a new client per request (`async with httpx.AsyncClient() as c` inside a handler kills
   connection reuse, repeats the TLS handshake every call, and exhausts ephemeral sockets under load).
   Set **explicit** `httpx.Timeout(connect=…, read=…, write=…, pool=…)` (the default is a single 5s
   inactivity timeout — too coarse for an upstream SLA) and **explicit** `httpx.Limits(max_connections=…,
   max_keepalive_connections=…)` (defaults: `max_connections=100`, `max_keepalive_connections=20`,
   `keepalive_expiry=5.0` —
   [httpx resource-limits](https://www.python-httpx.org/advanced/resource-limits/)). Tune to the upstream,
   don't ship the defaults. (`async-httpx-client.md`)

6. **GET `async def` VS `def` RIGHT PER ROUTE.** Use `async def` **only** when the body awaits
   non-blocking I/O the whole way; any **blocking** I/O or sync library inside an `async def` **stalls the
   entire event loop** for every concurrent request on that worker. FastAPI's own docs:
   *"When you declare a path operation function with normal `def` instead of `async def`, it is run in an
   external threadpool that is then awaited, instead of being called directly (as it would block the
   server)"* ([FastAPI — Concurrency](https://fastapi.tiangolo.com/async/)). That threadpool is AnyIO's,
   **default 40 tokens** ([Starlette threadpool](https://starlette.dev/threadpool/)). Put blocking/sync
   work in a plain `def` handler or explicit `run_in_threadpool`; CPU-bound work goes **off-process
   entirely**, never on the loop and never silently consuming threadpool slots. (`async-sync-and-concurrency.md`)

7. **`BackgroundTasks` IS SUB-SECOND, FIRE-AND-FORGET, NON-CRITICAL — INGEST IS THE EXTERNAL WORKER.**
   `BackgroundTasks` is in-process, no persistence, no retry, no visibility; it **dies on
   restart/redeploy** mid-task. Any ingest, multi-second job, anything that must survive a crash or be
   retried, or anything you'd page on if lost, is **NOT a BackgroundTask** — it is the off-request
   **worker/cron write-path** (this repo's standing rule: heavy/scheduled work runs off the request
   path). State this boundary explicitly; never smuggle ingest into a BackgroundTask or an in-process
   `asyncio.create_task`. (`background-work-and-the-worker-boundary.md`)

8. **CONFIG IS ONE TYPED `Settings` OBJECT (pydantic-settings), INJECTED VIA A CACHED DEPENDENCY.**
   Configuration comes from a single `BaseSettings` subclass — typed, validated, env-overridable —
   instantiated **once** (`@lru_cache` factory) and injected via `Depends`; never `os.environ[...]`
   scattered through modules. Secrets are read from the environment / `secrets_dir`, never committed. The
   `Settings` object is the single config source of truth and **fails fast at startup** on a
   missing/invalid required var. (`pydantic-settings-config.md`)

9. **ONE MACHINE-READABLE ERROR ENVELOPE (RFC 9457), VIA REGISTERED HANDLERS.** A published data API
   returns `application/problem+json` with the standard members (`type`, `title`, `status`, `detail`,
   `instance`) plus typed extensions — from registered exception handlers, including a
   `RequestValidationError` handler. **Never** leak a raw stack trace, a framework-default 500, or an
   inconsistent ad-hoc shape (both a UX and a security failure).
   ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)). (`error-handling-and-problem-details.md`)

10. **THE EMITTED OpenAPI 3.1 DOC IS THE SDK/PORTAL SOURCE OF TRUTH — NEVER HAND-EDITED.** FastAPI
    **emits** OpenAPI 3.1 from the typed route + Pydantic-model signatures. That emitted doc is what the
    downstream SDK/portal consumes. Hand-editing it, or maintaining a parallel hand-written spec,
    guarantees the generated SDK lies about the API. Give every operation a stable `operation_id`, tags,
    and a `response_model`; version additively under `/api/v1`. (`openapi-as-contract-and-versioning.md`)

11. **GRACEFUL SHUTDOWN ON SIGTERM; THE WRITE-PATH IS IDEMPOTENT.** Fly rolling deploys send SIGTERM. Set
    Uvicorn's graceful-shutdown timeout, drain in the lifespan shutdown branch (after `yield`: close the
    pool/client), and make the write-path **idempotent** so a killed run is safely retried. An in-flight
    request or half-written ingest killed on every deploy is a correctness bug, not a deploy detail.
    (`uvicorn-gunicorn-process-model.md`, `background-work-and-the-worker-boundary.md`)

12. **VERIFY EVERY API/OPTION/VERSION AGAINST THE INSTALLED PRIMARY DOCS — NEVER RECALL.** Pin FastAPI
    0.138.x / Pydantic 2.13.x / Uvicorn 0.49.x / httpx 0.28.x / uv 0.11.x (verified 2026-06; re-confirm
    at write time). An option that does not exist in the installed version is a hallucination and fails
    review on sight. Confidence may not exceed the evidence rung (primary docs > source read > single
    blog > recall — flag the last `[unverified]`).

---

## Anti-Patterns — mistake → fix

| Anti-pattern (the mistake) | The fix |
|---|---|
| Treating the data plane as "just another serverless API" — deploying it on Vercel, or opening a fresh DB connection / fresh httpx client **per request** "because serverless does that anyway". | The whole point of a persistent service is **amortised pools and a shared client**; a per-request-connection design throws away the only reason it exists off-serverless. **Persistent process on Fly; pool + client created once in lifespan.** (NN1, NN4, NN5) |
| Blocking the event loop: calling a **sync DB driver**, `requests`, `time.sleep`, a heavy `pandas`/`pyarrow` transform, or a CPU-bound loop directly inside an `async def` route. | It freezes **all** concurrent requests on that worker, not just the one (the classic 120 ms → 840 ms tail-latency pathology under load). Use a plain `def` handler (AnyIO threadpool), `await run_in_threadpool(...)`, or push CPU work **off-process**. (NN6) |
| Per-request `httpx.AsyncClient()` (or `async with httpx.AsyncClient() as c:` inside the handler). | New TLS handshake + zero connection reuse every call; under a read spike this exhausts ephemeral sockets and tanks throughput. The client is a **lifespan singleton with tuned `Limits`/`Timeout`**. (NN5) |
| Module-level mutable globals for shared state (`client = None`, assigned in a startup hook). | Import-order bugs, state leaks between tests, and silent failure under serverless where startup may not run. Use **`app.state` + a `Depends`** that reads from it. (NN4) |
| Smuggling real ingest/normalization into `BackgroundTasks` or an in-process `asyncio.create_task`. | No persistence, no retry, no idempotency, no visibility — it vanishes on the next redeploy mid-job and corrupts a bitemporal store. **Ingest is the external worker/cron write-path, full stop.** (NN7) |
| Scattering `os.getenv`/`os.environ` reads and magic constants through the codebase. | Undeclared/undocumented env vars, no startup validation, config drift between dev and Fly. **One typed pydantic-settings `Settings`, injected via a cached dependency.** (NN8) |
| Loose, unpinned dependencies and no lockfile (`pip install fastapi uvicorn` in the Dockerfile, or `uv sync` **without** `--locked`). | Non-reproducible builds; a transitive bump silently changes behavior in prod but not locally. **Committed `uv.lock` + `uv sync --locked`/`--frozen` in Docker; pin uv and `.python-version`.** (NN3) |
| Returning raw stack traces / framework-default 500s / inconsistent error shapes to API consumers. | A published data API needs **ONE** machine-readable envelope (RFC 9457 `problem+json`) via registered handlers; leaking internals is a UX **and** a security failure. (NN9) |
| `async def` **everywhere** by reflex, then calling sync libraries inside. | The worst of both worlds: you lose the threadpool protection a `def` handler gives **and** you block the loop. **Choose per-route from the actual I/O — don't default-async.** (NN6) |
| Hand-editing the OpenAPI doc or maintaining a parallel hand-written spec. | FastAPI **emits** OpenAPI 3.1 from the typed route + model signatures; that emitted doc is the SDK/portal source of truth. A divergent hand-spec makes the generated SDK **lie**. (NN10) |
| Misusing the Gunicorn-UvicornWorker pattern on a container platform. | FastAPI's deploy docs now recommend **a single Uvicorn process per container** (let the platform replicate) or `fastapi run --workers N` / `uvicorn --workers N` — **not** the legacy `gunicorn -k uvicorn.workers.UvicornWorker`; and **Gunicorn 26 removed the eventlet worker**, breaking old `-k eventlet` configs ([Gunicorn 2026 news](https://gunicorn.org/2026-news/)). (NN1, NN11) |
| Ignoring graceful shutdown: no SIGTERM handling, so an in-flight request / half-written ingest is killed on every Fly rolling deploy. | Set Uvicorn `--timeout-graceful-shutdown`, **drain in the lifespan shutdown branch**, and make the write-path **idempotent** so a killed run is safely retried. (NN11) |

---

## Output Contract — the grading rubric

A design or implementation produced under this skill is **done** only when:

1. **Persistence is stated and justified.** The design says the service is a **long-running process on
   Fly** (not Vercel serverless), and any deploy artifact reflects that. The first-principles reason
   (pool/client/lifespan die between serverless invocations) is named, not hand-waved. (NN1)
2. **The read/write fetch boundary holds structurally.** No read-API route handler has an httpx client
   injected; the only `get_http_client` dependency lives on write-path/worker entrypoints. Read serves
   from store + cache. (NN2)
3. **Versions are pinned + locked.** Code targets FastAPI 0.138.x / Pydantic 2.13.x / Uvicorn 0.49.x /
   httpx 0.28.x on Python 3.12+; `uv.lock` is committed; Docker uses `uv sync --locked`; uv and
   `.python-version` are pinned. No claim rests on a hallucinated function/option. (NN3, NN12)
4. **Shared resources live in the lifespan, on `app.state`.** The httpx client, DB pool, and object-store
   client are created once before `yield` and closed once after; no module-level mutable global holds
   them; a `Depends` reads them. (NN4)
5. **There is exactly one shared httpx client with explicit Limits/Timeout.** Never per-request; the
   `Timeout` sets connect/read/write/pool and the `Limits` set max/keepalive connections, tuned to the
   upstream — not the defaults. (NN5)
6. **Each route's async/def choice is deliberate.** `async def` only where the body awaits the whole way;
   blocking/sync work is in a `def` handler or `run_in_threadpool`; CPU-bound work is off-process. No
   sync call blocks the loop. (NN6)
7. **Heavy work is off the request path.** Nothing that must survive a crash, retry, or be paged on runs
   in `BackgroundTasks`/`create_task`; ingest is the external worker/cron, and the write-path is
   idempotent. (NN7, NN11)
8. **Config is one typed Settings object.** pydantic-settings `BaseSettings`, injected via a cached
   dependency, fails fast at startup on a missing/invalid required var; no scattered `os.environ`;
   secrets are never committed. (NN8)
9. **Errors are one RFC 9457 envelope.** All error responses are `application/problem+json` from
   registered handlers (incl. `RequestValidationError`); no raw stack trace or default 500 leaks. (NN9)
10. **The OpenAPI 3.1 doc is the contract.** It is emitted from typed routes/models, never hand-edited;
    operations carry stable `operation_id`/tags/`response_model`; versioning is additive under
    `/api/v1`. (NN10)
11. **Shutdown is graceful.** SIGTERM drains in-flight requests; the lifespan shutdown branch closes the
    pool/client; the write-path is idempotent against a killed run. (NN11)
12. **The R-SCALE tier is named.** The design states which tier it survives (1× demo / 100× traction /
    10,000× product) and what breaks at the next tier, in **numbers** — and the read-spike strategy
    (compute-once-serve-many via the store/cache, Fly replication for read capacity) is named, not
    assumed.

---

## References

| File | When to read |
|---|---|
| `lumina-data-plane-topology.md` | In-project orientation: where the persistent Python data plane sits in the financial-data-analytics product line, its boundaries with the TS gateway / write-path worker / store, and the read-never-fetches contract made concrete at the framework level. **The map a builder reads FIRST.** |
| `fastapi-app-structure-and-lifespan.md` | The FastAPI app object, the lifespan async context manager as the canonical startup/shutdown mechanism, and the scalable domain-module project structure for a data service. Generic theory + the concrete skeleton. |
| `dependency-injection-and-lifespan.md` | FastAPI's dependency-injection system in depth: `Depends` chains, request-scoped caching/reuse, app.state-singleton-via-dependency, yield-dependencies for setup/teardown, and `dependency_overrides` as the test seam. Pairs with lifespan (singletons) vs Depends (per-request). |
| `async-sync-and-concurrency.md` | The async-def-vs-def route discipline, the AnyIO threadpool, blocking-I/O pitfalls, `run_in_threadpool`, and CPU-bound offload — the single highest-blast-radius performance-correctness topic for this service. |
| `background-work-and-the-worker-boundary.md` | FastAPI `BackgroundTasks` vs an external worker/queue, with a hard decision boundary: what may run in-process post-response vs what MUST be the off-request write-path. Enforces the heavy-work-off-the-request-path rule. |
| `pydantic-v2-modeling.md` | Modeling request/response/standard data with Pydantic v2 + pydantic-core performance: `BaseModel`, fields/validators, serialization, and the validate-vs-construct cost model that matters at financial-series volume. |
| `pydantic-settings-config.md` | Typed configuration & secrets with pydantic-settings `BaseSettings` v2 — one validated Settings object, env precedence, nested settings, `secrets_dir`, and fail-fast startup. The single config source of truth. |
| `async-httpx-client.md` | The single shared async `httpx.AsyncClient` that is the ONLY thing in the data plane allowed to fetch upstream (used by the write-path) — pools, `Limits`, `Timeout`, retries, and failure isolation. Read-path handlers never get it injected. |
| `uv-packaging-and-reproducibility.md` | Astral uv as the packaging/dependency/python-version manager for a reproducible service: `pyproject.toml`, `uv.lock`, dependency groups, python pinning, and the `uv run`/`sync`/`add` workflow. |
| `patterns-uv-docker-image.md` | RECIPE: the production multi-stage Dockerfile for the Python data plane using the official uv image, cache mounts, locked sync, bytecode compilation, and a slim runtime — the exact image that ships to Fly. |
| `uvicorn-gunicorn-process-model.md` | The ASGI server layer: Uvicorn as the committed server, the workers-vs-replication decision, graceful shutdown on SIGTERM, and production tuning (timeouts, concurrency limits). Includes the Gunicorn caveats. |
| `lumina-deploy-on-fly.md` | Deploying the persistent Python data plane to Fly (fly.toml, Dockerfile wiring, health checks, internal port, rolling deploy, volumes) AND the first-principles argument for why it cannot be a Vercel serverless function. Mirrors the repo's `worker/` deploy. |
| `error-handling-and-problem-details.md` | Consistent, machine-readable error responses for a published data API: registered exception handlers, `RequestValidationError` shaping, and the RFC 9457 `problem+json` envelope. One error contract across the service. |
| `structured-logging-and-observability.md` | Production structured JSON logging with per-request correlation IDs for the data plane: structlog/stdlib JSON, `contextvars`, request middleware, and integrating Uvicorn's loggers. Async-safe. |
| `api-security-dependencies.md` | Securing the data-plane API as dependencies: API key / OAuth2 / JWT validation injected via `Depends`/`Security`, scopes, and the secrets-by-closure rule. Authn AND authz at the right layer. |
| `openapi-as-contract-and-versioning.md` | Treating FastAPI's emitted OpenAPI 3.1 document as the single SDK/docs-portal source of truth, plus additive `/api/v1` versioning. The contract the api-publishing-sdk-portal skill consumes downstream. |
| `testing-the-data-plane.md` | Testing the FastAPI service the right way: pytest + `httpx.ASGITransport` AsyncClient, anyio, async fixtures, `dependency_overrides` as the seam, and mocking the upstream httpx so the read path is provider-independent in tests. |
