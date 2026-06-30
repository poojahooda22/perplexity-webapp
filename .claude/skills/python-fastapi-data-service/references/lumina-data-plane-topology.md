# patterns · The data-plane topology — where the persistent Python service sits, and the framework-level read-never-fetches contract

> **Scope.** This is the **first** reference a builder reads in the `python-fastapi-data-service`
> dev-skill (the **JPM-Markets re-engineering data-analytics product line — NOT Lumina**). It is the
> *orientation map*: where the persistent Python data plane sits in the polyglot topology, what THIS
> skill owns vs the nine sibling skills, and — the load-bearing part — how the architecture's hard
> boundaries (read serves from the store, only the write path fetches) become **enforceable framework
> rules** in the FastAPI module layout, not just a diagram in a plan doc.
>
> **Why a topology doc and not just "go read the FastAPI tutorial".** The single most expensive mistake
> in this product line is wiring an `httpx` upstream fetch into a read endpoint — it turns a
> compute-once-serve-many read service into a fetch-through proxy that goes down whenever a provider
> rate-limits you, and it re-introduces the exact `CRITICAL-2` the architecture was designed to kill
> (`01-plan.md` §"Hard boundaries"). A diagram can't prevent that; a **module layout where the read
> service literally has no HTTP client to call** can. This doc pins the boundary to a directory
> structure (`read_api/` has no `httpx.AsyncClient`; `worker/` is the only place one exists) so the rule
> is mechanically true, not aspirational.
>
> **Derives from** the three project research docs — `01-plan.md` (architecture diagram + the six hard
> boundaries), `02-skills-and-pipeline.md` (the end-to-end pipeline table + the 10-skill list), and
> `03-dataquery-system-design.md` (the gateway / data-plane / write-path ASCII diagram). It **does not
> re-decide** any committed stack choice; it makes the committed topology concrete at the framework
> level. Where this doc and those disagree, those win — re-read them.
>
> **Greenfield.** No codebase `file:line` exists yet. Citations here are to (a) the project research
> docs, (b) primary framework/platform docs read this run, and (c) the existing repo's `worker/` as the
> *pattern source* the data plane's write path mirrors.

---

## 0. The thirty-second map (read this first)

Five processes, three languages, one rule.

```
 caller (SDK / REST / Excel / — later — MCP agent)
     │  HTTPS
     ▼
 ┌──────────────────────────────────────────────┐
 │  GATEWAY        TS/Node · Express 5 · Vercel  │   ← serverless, stateless, edge
 │  auth · rate-limit · /catalog · /series       │     reuses Lumina cache.ts + ratelimit.ts
 │  Provenance{commercialOk} response gate       │
 └───────────────┬──────────────────────────────┘
                 │  internal HTTP  (READ-ONLY: gateway → data plane)
                 ▼
 ┌──────────────────────────────────────────────┐
 │  DATA PLANE     Python · FastAPI+Uvicorn · Fly│   ← PERSISTENT: pools, clients, caggs
 │  read_api/  →   reads store + Redis ONLY       │     **NO httpx client injected here**
 │  (no upstream fetch ever on a request)         │
 └───────────────▲──────────────────────────────┘
                 │  writes only — NEVER on a user request
                 ▼  (same Python codebase, different entrypoint + process)
 ┌──────────────────────────────────────────────┐
 │  WRITE PATH     Python · worker/ · Fly · cron │   ← the ONLY process that holds httpx
 │  TET fetch → normalize → PERSIST → Parquet     │     external cron + CRON_SECRET (repo NN #4)
 │  → PROV-O + commercialOk stamp                 │
 └───────────────▲──────────────────────────────┘
                 │  fetch  (GREEN = redistributable; RED = fetch-through-only)
            [ EDGAR · Treasury · BLS · BEA · World Bank · OECD · IMF ]
```

**The one rule that governs the whole topology** (`02-skills-and-pipeline.md` §"Summary", verbatim):

> "the read path serves from our store; only the write path fetches; and every series carries a
> `commercialOk` verdict bound to its fetch path."

**This skill owns exactly one box: the PERSISTENT Python data plane** (the FastAPI service skeleton),
*and* the write-path worker entrypoint that lives in the same Python codebase. It does **not** own the
TS gateway (that reuses Lumina's `redis` + `supabase` skills), the store internals (`timescaledb-…`),
normalization (`openbb-tet-normalization`), symbology (`security-master-symbology`), the catalog model
(`data-provenance-licensing`), Parquet (`columnar-parquet-arrow`), discovery (`faceted-discovery-search`),
or the post-v1 MCP/SDK surfaces. §3 is the full ownership table; §6 is the file→skill index.

If that map is all you needed, stop. The rest makes each boundary a concrete framework rule with
runnable code.

---

## 1. The polyglot topology, reproduced and explained

The committed topology is **polyglot by design**, not by accident. From `01-plan.md` §"Chosen stack",
the Topology row, verbatim:

> "Polyglot: **TS/Node gateway** + **Python data plane** (persistent service), internal HTTP boundary
> — Each language does its best job; forces the data plane to be a persistent service, not a Vercel
> function."

There are **five** runtime roles. Two are TS (gateway + the existing Lumina frontend pattern source),
three are Python-or-infra (data plane, write-path worker, and the stores). This skill is responsible
for the **Python** roles.

### 1.1 The five roles and why each is where it is

| # | Role | Language / runtime | Host | Persistent? | Owned by |
|---|---|---|---|---|---|
| 1 | **Gateway** — auth, rate-limit, `/catalog` discovery, `/series` retrieval, `commercialOk` response gate, Redis cache | TS / Express 5 | **Vercel serverless** | **No** (stateless, scales to zero) | reuses `redis` + `supabase` + `faceted-discovery-search` |
| 2 | **Data plane (read)** — serves series + catalog from the store + Redis; the persistent home of DB pools, the catalog/security-master query layer, the Timescale connection | **Python / FastAPI + Uvicorn** | **Fly (Firecracker VM)** | **Yes** (always-on) | **THIS skill** (`read_api/`) |
| 3 | **Write path (ingest)** — TET fetch → normalize → persist Timescale + Parquet → PROV/`commercialOk` stamp | **Python / worker entrypoint** | **Fly worker** | **Yes** (long-running, cron-triggered) | **THIS skill** (`worker/`) + `openbb-tet-normalization` + `data-pipeline-worker-cron` |
| 4 | **Stores** — TimescaleDB (series), Supabase Postgres + pgvector (catalog, security master, PROV), R2 (Parquet), Upstash Redis (hot cache) | Postgres / object store / Redis | Fly Volume / Supabase / Cloudflare R2 / Upstash | n/a (data) | `timescaledb-…`, `prisma`, `columnar-parquet-arrow`, `redis` |
| 5 | **Frontend / dev console** (post-v1, optional) — Scalar docs portal, API-key console, catalog explorer | React + Vite | Vercel | No | `lumina-frontend` + `react-typescript` (reused) |

> **Why the gateway is TS-on-Vercel and the data plane is Python-on-Fly.** Three forces, each cited:
>
> 1. **Reuse.** The gateway is "zero new gateway plumbing" — it reuses Lumina's `cache.ts`
>    (`getOrRefresh` + stale-while-revalidate + in-flight de-dupe), `ratelimit.ts`, and the
>    `Provenance{commercialOk}` type wholesale (`01-plan.md` §"Chosen stack", Gateway row). Rewriting
>    those in Python would be pure waste.
> 2. **The data plane physically *cannot* be a Vercel function.** It needs to **hold** things across
>    requests: a TimescaleDB connection pool, a long-lived DB session layer, continuous-aggregate query
>    state, and (in the write path) an `httpx.AsyncClient` connection pool. Vercel serverless functions
>    are ephemeral — "no persistent sockets/timers, no columnar engine" — which is exactly the
>    `MAJOR-2` finding the topology fixes (`02-skills-and-pipeline.md` §"Dead ends / rejected":
>    *"Data plane on Vercel — REJECTED"*). This is the same constraint that already forces Lumina's
>    live-price worker onto Fly rather than Vercel (`CLAUDE.md` non-negotiable #4; the existing
>    `worker/fly.toml` exists precisely for this reason).
> 3. **Best-tool-per-job.** The Python data ecosystem (PyArrow, the TET/Pydantic normalization pattern,
>    the scientific stack) is where ingest + normalization belong; the TS/edge ecosystem is where auth
>    + caching + the SPA belong. Splitting at the internal-HTTP boundary lets each side use its strongest
>    tools without contaminating the other.

### 1.2 The internal-HTTP boundary is **read-only and one-directional**

The gateway calls the data plane. The data plane **never** calls the gateway. The arrow points one way
on purpose:

```
  GATEWAY  ──(GET /internal/series?…  ·  GET /internal/catalog?…)──►  DATA PLANE
           ◄──────────────── JSON (series rows + Provenance) ─────────
```

From `03-dataquery-system-design.md` §"Our system design", the boundary is annotated verbatim on the
diagram as **"internal HTTP — READ FROM STORE ONLY"**. That phrase is the contract: when the gateway
hits the data plane, the data plane resolves the answer out of TimescaleDB / Postgres / Redis and
returns it. It does **not**, on that request, reach out to EDGAR or Treasury or any provider. (How that
is made *mechanically impossible* rather than merely *intended* is §4 — the read service has no HTTP
client to fetch with.)

> **This is the CQRS read-model pattern, named.** The data plane's read side is a classic CQRS
> *read model* / *materialized view*: a store kept up to date by a separate write path, serving queries
> without synchronous upstream calls. The industry rationale for *why* a read service must not call
> upstream synchronously is well-documented: *"Instead of fetching data from services in real-time, the
> … View service can maintain a local materialized view to feed the queries … far more effective than
> making synchronous API calls over the network"*, and *"Synchronous invocations of multiple services
> introduce latency … and force you to deal with the availability of downstream services, requiring
> additional measures like circuit breakers and exponential backoff"*
> ([microservices.io CQRS](https://microservices.io/patterns/data/cqrs.html);
> [Querying Microservices with CQRS + Materialized View](https://medium.com/event-driven-utopia/querying-microservices-with-the-cqrs-and-materialized-view-pattern-bdb8b17f95d1)).
> Our topology *is* CQRS: the write path is the command side, the data plane read API is the query side,
> the TimescaleDB + catalog store is the materialized read model, and the cron-driven ingest is the
> (batch, not event) synchronization mechanism.

### 1.3 On Fly, the internal hop runs over private networking

The gateway→data-plane hop, and any data-plane↔worker coordination, ride Fly's private network — they
never traverse the public internet. Fly apps in one organization share a **6PN** mesh: *"Fly Apps in an
organization are connected by a mesh of WireGuard tunnels using IPv6 called a 6PN. Private networking
over your 6PN is always available to apps by default"*, reachable by `.internal` DNS:
*"You can use `.internal` domains to connect your app to databases, API servers, or other apps in your
6PN"* ([Fly private networking](https://fly.io/docs/networking/private-networking/)).

For the data plane specifically — a private HTTP service that the gateway calls but the public never
touches — use **Flycast** (a private Fly-Proxy address) rather than a raw 6PN machine address, because
Flycast gives load-balancing across the data-plane's machines and autostart/autostop:
*"A Flycast address is an app-wide private IPv6 address that Fly Proxy can route to over the private
network … unlocks … waking up sleeping services … and load balancing across regions, all while staying
completely private"* ([Fly Flycast](https://fly.io/docs/networking/flycast/)). For a *persistent*
always-on data plane you'll typically keep autostop off (like the existing `worker/fly.toml` does for
the price worker), so the value Flycast adds is the **load-balancer + private DNS**, not the wake-up.

**Framework rule (network):** the data plane FastAPI app binds to the Fly private interface for the
internal endpoints and exposes **no public HTTP service** for them. The only public surface in the whole
topology is the *gateway* (Vercel). The data plane is private-by-default; the gateway is its only client.

---

## 2. Why the data plane is *persistent* (and the gateway/worker are separate processes)

"Persistent" is not a vibe — it is a list of concrete things the process must **hold across requests**
that a serverless function structurally cannot. This is the entire reason the Python box is a long-lived
Fly VM and not three Vercel functions.

### 2.1 The four things the data plane holds

| Held resource | Why it must persist | Created where | Framework citation |
|---|---|---|---|
| **DB connection pool(s)** — Timescale + catalog Postgres | Opening a Postgres connection costs a TCP+TLS handshake + auth round-trip; doing it per-request at read-spike scale exhausts the DB's connection slots and adds latency. A pool is opened **once at startup** and reused. | FastAPI **lifespan** (§2.2) | FastAPI lifespan is for *"Database connection pools - initialized at startup, used by all requests"* ([FastAPI Lifespan Events](https://fastapi.tiangolo.com/advanced/events/)) |
| **Continuous-aggregate / pre-rolled query layer** | The store serves pre-computed buckets (monthly/weekly rollups), not raw scans (`03-…` §Scale(b)). The query objects, prepared statements, and any in-process metadata cache live with the process. | lifespan + module state | TimescaleDB caggs (sibling skill) |
| **Redis client** | Compute-once-serve-many reads check Redis first. One client, pooled, reused. | lifespan | reuses `redis` skill |
| **(Write path only) `httpx.AsyncClient`** | A single client *"that lasts for the lifetime of the application … so that all connections share the same connection pool and outgoing HTTP requests won't need to establish a new connection"* ([HTTPX Clients](https://www.python-httpx.org/advanced/clients/)). **Lives only in the worker**, never the read API. | worker lifespan/main | §4 |

> **The serverless contradiction, stated plainly.** A Vercel function is created and destroyed per
> request (or per cold burst); it cannot keep a warm DB pool or a warm httpx pool between requests, and
> it cannot hold a continuous-aggregate query layer in process memory. So either every request pays the
> full connection-setup cost (slow, and it melts the DB's connection cap under load), or you bolt on an
> external pooler and accept the serverless cold-start tax anyway. The persistent Fly VM sidesteps all
> of it: open the pools once, serve thousands of reads off them. This is *the* mechanical reason
> `02-skills-and-pipeline.md` rejects "Data plane on Vercel".

### 2.2 The lifespan pattern — the persistent service's spine

FastAPI's **lifespan** async context manager is where the persistent resources are opened (before the
app takes requests) and closed (on shutdown). The official pattern, verbatim
([FastAPI Lifespan Events](https://fastapi.tiangolo.com/advanced/events/)):

> "The first part of the function, before the `yield`, will be executed **before** the application
> starts." … "the code before the `yield` will be executed **before** the application **starts taking
> requests**, during the _startup_." … "right after the `yield`, … This code will be executed **after**
> the application **finishes handling requests**, right before the _shutdown_."

Applied to the data plane read service (note: **no httpx client here** — that is the whole point of §4):

```python
# app/main.py  — the persistent READ data plane (Fly, always-on)
from contextlib import asynccontextmanager
from fastapi import FastAPI
from .settings import settings
from .stores import open_timescale_pool, open_catalog_pool, open_redis, Stores


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── startup: open every persistent resource ONCE, before requests ──
    app.state.stores = Stores(
        timescale=await open_timescale_pool(settings.timescale_dsn),
        catalog=await open_catalog_pool(settings.catalog_dsn),   # Supabase Postgres + pgvector
        redis=open_redis(settings.redis_url),
    )
    # NOTE: there is deliberately NO httpx.AsyncClient opened here.
    # The read plane cannot fetch upstream — it has nothing to fetch WITH.  (see §4)
    yield
    # ── shutdown: close them in reverse ──
    await app.state.stores.timescale.close()
    await app.state.stores.catalog.close()
    await app.state.stores.redis.aclose()


app = FastAPI(
    title="financial-data-analytics-service · data plane (read)",
    version="1",
    lifespan=lifespan,
)
```

Two framework facts make this load-bearing:

1. **It's all-lifespan-or-nothing.** *"If you provide a `lifespan` parameter, `startup` and `shutdown`
   event handlers will no longer be called. It's all `lifespan` or all events, not both"*
   ([FastAPI Lifespan Events](https://fastapi.tiangolo.com/advanced/events/)). Pick lifespan; don't mix
   in the deprecated `@app.on_event`.
2. **Lifespan is for app-wide shared resources, NOT per-request state.** The pools opened here are
   shared across every request; per-request things (a transaction, the current series id) come through
   `Depends`, not `app.state`. (`fastapi-app-structure-and-lifespan.md` covers this split in depth.)

> **Worker-process caveat that bites here.** If you run Uvicorn with `--workers N`, **each worker is a
> separate OS process with its own Python interpreter and its own copy of `app.state`** — *"each worker
> being a separate process with its own Python interpreter and GIL"*, and *"If you populate data at
> module load time, that initial data will be visible to every worker, but future modifications will
> not be because they happen in separate processes"*
> ([FastAPI Server Workers](https://fastapi.tiangolo.com/deployment/server-workers/);
> [shared cache across workers](https://justlike.medium.com/can-we-have-a-scalable-fastapi-service-with-common-cache-across-multiple-workers-or-threads-26b8197ceb81)).
> **Consequence for this product line:** never treat in-process memory as a cache shared across the
> data plane — a value written by worker A is invisible to worker B. The shared cache is **Redis**
> (the gateway's `getOrRefresh`), and the shared truth is **the store**. The lifespan pools are
> per-worker (each worker opens its own pool — fine, pools are cheap relative to the DB cap; just size
> `pool_size × workers ≤ DB connection limit`). This is *why* the compute-once-serve-many cache is
> Upstash Redis and not a Python dict.

### 2.3 Three separate processes, one repo

The gateway, the read data plane, and the write-path worker are **three separate processes** (the
gateway on a different host and language entirely). The data plane and worker share **one Python
codebase** but run as **two different entrypoints / Fly apps**:

```
financial-data-analytics-service/        (the Python repo for this product line)
├── app/                  ← shared library: settings, stores, models, security-master query, catalog query
│   ├── __init__.py
│   ├── settings.py       ← Pydantic-Settings (one source of config)
│   ├── stores.py         ← pool factories: open_timescale_pool / open_catalog_pool / open_redis
│   ├── models/           ← Pydantic v2 standard models (shared by read + write)
│   └── ...
├── read_api/             ← ENTRYPOINT 1: the persistent FastAPI read plane  (Fly app A, always-on)
│   ├── main.py           ← FastAPI(app, lifespan=…) — NO httpx import anywhere under this dir
│   ├── routers/
│   │   ├── series.py     ← GET /internal/series  → reads store + Redis
│   │   └── catalog.py    ← GET /internal/catalog → reads catalog Postgres
│   └── deps.py           ← Depends(get_stores) — hands routers the read pools, never an http client
└── worker/               ← ENTRYPOINT 2: the write path  (Fly app B, cron-triggered)
    ├── main.py           ← long-running ingest loop / APScheduler; HOLDS the httpx.AsyncClient
    ├── fetchers/         ← TET Fetcher[Q,R] per GREEN provider (httpx lives here ONLY)
    └── persist.py        ← Timescale upsert + Parquet materialize + PROV/commercialOk stamp
```

The hard rule, made structural: **`worker/` may import `httpx`; `read_api/` may not.** A one-line CI
grep (`! grep -rln "import httpx" read_api/`) enforces it. The read plane and the worker can share
everything under `app/` (settings, models, pool factories, the security-master query helpers) — but the
*fetch* capability lives strictly under `worker/`. (§4 turns this into the framework contract.)

> **This mirrors the repo's existing split exactly.** Lumina already runs a persistent always-on
> process for the one thing Vercel can't do (hold a socket): the price `worker/` on Fly
> (`worker/index.ts`, `worker/fly.toml` — `min_machines_running = 1`, `auto_stop_machines = false`).
> Our data plane reuses that deploy shape (Dockerfile + fly.toml + always-on machine) and adds a second
> always-on app for the write path. The `deploy-on-fly.md` reference covers the Dockerfile/fly.toml in
> depth; this doc only fixes *which* processes exist and *why* they're separate.

---

## 3. What THIS skill owns vs the sibling skills

This skill (`python-fastapi-data-service`, called `python-fastapi-service` in `02-…`'s skill table) owns
**the Python service skeleton** — the boxes labelled "data plane (read)" and "write path" *as
processes*: their structure, lifecycle, async discipline, settings, and Fly deploy shape. It does **not**
own what *flows through* them. The clean way to think about it: **this skill builds the pipes and the
process; the siblings build what runs inside.**

| Concern | Skill that owns it | This skill's relationship |
|---|---|---|
| **FastAPI app structure, routers, lifespan, settings, async/threadpool discipline, off-request work, Fly deploy, the read/write boundary** | **`python-fastapi-data-service`** (this skill) | **Owns.** Everything in §1–§6 here. |
| **TET normalization** — `Fetcher[Q,R]`, field-intersection standard models, `__alias_dict__`, `extra='allow'`, the AGPL clean-room trap | `openbb-tet-normalization` | This skill provides the *worker process* the fetchers run in; that skill provides the fetcher *logic*. |
| **Security master** — FIGI canonical anchor, bitemporal crosswalk, corporate actions, OpenFIGI `/v3/mapping` | `security-master-symbology` | This skill's `app/` hosts the query helpers; that skill designs the subsystem (built **first**, before any multi-provider Dataset). |
| **Catalog model + licensing** — DCAT v3, Fusion 5-level ontology, PROV-O/OpenLineage, `commercialOk`-on-fetch-path | `data-provenance-licensing` (extends `finance-markets`) | This skill's responses *carry* `Provenance`; that skill *defines* it and the gate. |
| **TimescaleDB store** — hypertables, continuous aggregates, compression, retention, `time_bucket`, the TSL license nuance | `timescaledb-timeseries` (extends `prisma`) | This skill *opens the pool to* Timescale in lifespan; that skill designs the schema, caggs, and license posture. |
| **Parquet / Arrow** — PyArrow I/O, partitioning, the Fusion Distribution format, per-Distribution `commercialOk`, future Arrow Flight | `columnar-parquet-arrow` | This skill's worker *calls* the materializer; that skill designs the file format + transport. |
| **Faceted discovery** — server-side filter+paginate, GIN/btree facet indexes, `pg_trgm`/inverted keyword, matching-vs-ranking, the optional pgvector secondary | `faceted-discovery-search` | **Lives on the TS gateway, not here.** This skill's data-plane `/catalog` read endpoint serves the *already-indexed* metadata; the discovery *index design* is that skill. |
| **Write-path worker discipline** — idempotent bitemporal ingest, partial-failure / no-fake-number, TET scheduling, EDGAR fair-access, cron+`CRON_SECRET` | `data-pipeline-worker-cron` | **Shared seam.** This skill owns the worker *process/entrypoint*; that skill owns the *ingest semantics* (upsert-on-natural-key, append-only transaction-time, throw-so-cache-serves-stale). |
| **MCP server** (post-v1) — MCP primitives, FastMCP, stdio vs streamable-HTTP, OAuth 2.1, catalog-as-tools | `mcp-server-building` | Post-v1; a *new persistent process* this skill's deploy patterns will host (worker-only on Fly — holds long-lived connections, repo NN #4). |
| **SDK + docs portal** (post-v1) — one OpenAPI 3.1 core, OpenAPI Generator, Scalar/Redoc, `/api/v1` versioning | `api-publishing-sdk-portal` | Post-v1; consumes the OpenAPI spec FastAPI emits from the structure this skill defines. |

**Reused-as-is (do NOT recreate)** — from `02-skills-and-pipeline.md` §"Existing skills reused":
`redis` (gateway cache + ratelimit), `prisma` (catalog/security-master/PROV metadata), `supabase`
(gateway auth/JWT), `rag-retrieval` (the optional pgvector NL secondary), `backend-testing` +
`bun-testing` (TS gateway tests), `react-typescript` + `lumina-frontend` (only if a console ships),
`finance-markets` (origin of `Provenance` + the `commercialOk` gate + the sources-ledger),
`improvement-loop` (the Phase-5 read-spike latency loop).

> **The skill-layer law applies here too.** Per the repo's `skill-layer-law.md`: a *dev-skill* teaches
> Claude-the-builder how to write code (this is one); it is **not** shipped at runtime. Don't put
> runtime agent-reasoning content in this skill, and don't put fetch logic in a place that never runs.
> This skill is purely "how to build the Python data plane".

---

## 4. The read-never-fetches contract, made a framework rule

This is the heart of the doc. The architecture states the boundary as prose; here it becomes
**three mechanical FastAPI-level enforcements** so the boundary is *structurally true*, not just
documented.

### 4.1 The boundary, restated from the source docs

From `01-plan.md` §"Hard boundaries (the non-negotiables that fix the negation findings)", verbatim:

> - "The **read path never touches an upstream provider.** It reads store + Redis only. (Fixes
>   CRITICAL-2.)"
> - "The **write path is the only thing that fetches**, and it runs on a worker/cron, off the request
>   path. (Repo non-negotiable #4.)"

And `03-dataquery-system-design.md` annotates the internal hop as **"internal HTTP — READ FROM STORE
ONLY"** and the write hop as **"writes only — NEVER on a user request"**.

These two sentences are the contract. The failure they prevent (`CRITICAL-2`): a read endpoint that, on
a cache miss, "helpfully" fetches the missing series from EDGAR live. That turns the read service into a
fetch-through proxy — it inherits every upstream's rate limit, latency, and downtime; it can fabricate
load on a throttled provider during a read spike; and it violates repo non-negotiable #4 (sockets/timers
off the request path) the moment it does so under serverless or even just under load.

### 4.2 Enforcement #1 — the read service has no HTTP client to fetch with

The simplest enforcement is *capability removal*: you can't make an upstream fetch if there is no client
object anywhere in the read service to make it with.

**Rule:** the `read_api/` package opens **no** `httpx.AsyncClient` in its lifespan, injects **none** via
`Depends`, and imports `httpx` **nowhere**. The only thing a read router can be handed by dependency
injection is the **store bundle** (DB pools + Redis) — read-only query handles.

```python
# read_api/deps.py — the ONLY things a read router may depend on
from fastapi import Depends, Request
from app.stores import Stores


def get_stores(request: Request) -> Stores:
    # the read-only resource bundle opened in lifespan: timescale pool, catalog pool, redis.
    # There is no http client in here. By construction, a read router cannot fetch upstream.
    return request.app.state.stores


# read_api/routers/series.py
from fastapi import APIRouter, Depends
from app.stores import Stores
from app.models import SeriesResponse
from .deps import get_stores

router = APIRouter(prefix="/internal/series", tags=["series"])


@router.get("", response_model=SeriesResponse)
async def get_series(
    ids: list[str],
    frm: str,                  # from
    to: str,
    frequency: str = "FREQ_DAY",
    stores: Stores = Depends(get_stores),
) -> SeriesResponse:
    # 1) hot cache  2) pre-rolled continuous-aggregate bucket  3) raw hypertable — STORE ONLY.
    cached = await stores.redis.get(_key(ids, frm, to, frequency))
    if cached:
        return SeriesResponse.model_validate_json(cached)
    rows = await stores.timescale.fetch_series(ids, frm, to, frequency)  # SELECT, never a fetch
    resp = SeriesResponse.from_rows(rows)              # carries Provenance{commercialOk} per series
    await stores.redis.set(_key(ids, frm, to, frequency), resp.model_dump_json(), ex=_ttl(frequency))
    return resp
```

There is no `httpx` import in this file, in `deps.py`, or anywhere under `read_api/`. **CI rule:**

```bash
# fails the build if any upstream-fetch capability leaks into the read plane
! grep -rEln "import httpx|httpx\.AsyncClient|requests\.|aiohttp" read_api/ \
  && echo "OK: read plane has no fetch capability"
```

This is the FastAPI-level analogue of the repo's existing "secure tool args by closure" non-negotiable
(#6): the model never supplies a secret because it's injected by the factory; here the read endpoint
never fetches upstream because no client is injectable. **Capability you don't hand in is capability
that can't be misused.**

### 4.3 Enforcement #2 — the write path is the *only* place httpx lives

Symmetrically, the upstream-fetch capability is concentrated in exactly one place: the worker. The
`httpx.AsyncClient` is a single, long-lived, pooled instance (the documented best practice —
*"a single client instance that lasts for the lifetime of the application and closes when the program
terminates, so that all connections will share the same connection pool"*
[HTTPX Clients](https://www.python-httpx.org/advanced/clients/)), opened in the worker's lifecycle and
handed to the TET fetchers.

```python
# worker/main.py — the ONLY process that holds an upstream client
import httpx
from contextlib import asynccontextmanager
from app.stores import open_timescale_pool, open_catalog_pool
from app.settings import settings
from .fetchers import GREEN_FETCHERS        # one TET Fetcher[Q,R] per GREEN provider
from .persist import persist_series


@asynccontextmanager
async def worker_resources():
    # ONE pooled client for the whole worker — tune limits to avoid socket exhaustion under spike.
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        headers={"User-Agent": settings.edgar_user_agent},   # EDGAR fair-access (data-pipeline skill)
    )
    timescale = await open_timescale_pool(settings.timescale_dsn)
    catalog = await open_catalog_pool(settings.catalog_dsn)
    try:
        yield client, timescale, catalog
    finally:
        await client.aclose()
        await timescale.close()
        await catalog.close()


async def run_ingest(provider: str) -> None:
    async with worker_resources() as (client, timescale, catalog):
        fetcher = GREEN_FETCHERS[provider]
        raw = await fetcher.fetch(client)                 # TET: extract (httpx) — worker-only
        normalized = fetcher.transform(raw, catalog)      # TET: normalize fields + security master
        await persist_series(normalized, timescale)       # PERSIST + Parquet + PROV/commercialOk stamp
```

The fetch (`fetcher.fetch(client)`) **only** happens here, **only** when triggered by the cron, **never**
on a user request. The write path is the command side of CQRS; it runs on its own Fly app, off the read
request path entirely.

### 4.4 Enforcement #3 — the write path runs off the request path (repo NN #4)

The worker is **not** reachable as an HTTP endpoint the public can hit to trigger a fetch. It is driven
by an **external cron** (`cron-job.org`) hitting a `CRON_SECRET`-guarded trigger, which kicks an
**async APScheduler** job — the exact discipline `CLAUDE.md` non-negotiable #4 demands:

> "**Vercel can't hold sockets or timers.** WebSockets/pollers go in `worker/` (Fly.io); scheduled work
> is an external cron hitting a `CRON_SECRET`-guarded route." (`CLAUDE.md` §"Cross-cutting
> non-negotiables", #4)

and which Lumina's `product-at-scale.md` rule restates for this exact surface:

> "**Heavy ingest** (e.g. nightly EDGAR XBRL): lives in `worker/` on a cron, **not** the serverless
> route (non-negotiable #4)." (`.claude/rules/product-at-scale.md`)

So the cron trigger is a thin, secret-guarded entrypoint whose *only* job is to enqueue the ingest job;
the heavy fetch+normalize+persist runs asynchronously in the worker process, never blocking a request,
never on Vercel. (`data-pipeline-worker-cron.md` covers the cron/secret/scheduler wiring; this doc only
fixes that the trigger and the fetch are off the request path.)

### 4.5 The contract table — every boundary, who enforces it

| Boundary (from source docs) | Made-concrete framework rule | Enforced by |
|---|---|---|
| "read path never touches an upstream provider" (`01` CRITICAL-2) | `read_api/` imports no `httpx`; only `Depends(get_stores)` injectable; no client in lifespan | §4.2 + CI grep |
| "write path is the only thing that fetches" (`01`) | single `httpx.AsyncClient` lives only under `worker/`, opened in worker lifecycle | §4.3 |
| "off the request path … worker/cron" (repo NN #4) | external cron + `CRON_SECRET` + async APScheduler; no public fetch-trigger endpoint | §4.4 |
| "internal HTTP — READ FROM STORE ONLY" (`03`) | gateway→data-plane is GET-only; data plane resolves from Timescale/Postgres/Redis | §1.2 + §5 |
| "every series carries a `commercialOk` verdict" (`02`) | every read response model embeds `Provenance{source, commercialOk, attribution}` per series; default `false` | response model (`data-provenance-licensing`) |
| "never a fabricated number" (repo NN #1) | provider-down in the worker = ground-or-skip / throw → cache serves stale; read returns typed `unavailable`, never invented | worker partial-failure (`data-pipeline-worker-cron`) + read response |

---

## 5. The internal-HTTP contract shape (gateway → data plane)

The gateway is the only public surface; it calls the data plane over the private network for the two
read operations. The contract is deliberately **narrow and read-only** — two GET-shaped operations, both
served from the store. (The gateway also does auth, rate-limit, the `commercialOk` *response* gate, and
the Redis edge cache; those are gateway concerns reusing `redis`/`supabase`, not data-plane concerns.)

### 5.1 The two internal endpoints

| Gateway public route | Internal data-plane endpoint | What the data plane does | Source |
|---|---|---|---|
| `GET /catalog?facets…` | `GET /internal/catalog?…` | Faceted/keyword query over **indexed catalog metadata** in Postgres (GIN/btree + `pg_trgm`), cursor pagination, ranking. **No upstream fetch.** | `03` §"query-API contract"; DataQuery's `/group/instruments` analogue |
| `GET /series?ids&from&to&freq&agg&maxPoints&cursor` | `GET /internal/series?…` | Resolve from Timescale: serve the pre-rolled **continuous-aggregate** bucket for the frequency, then **LTTB downsample** to `maxPoints`, attach `Provenance`. **No upstream fetch.** | `03` §"query-API contract"; FRED/JPM/World-Bank universal shape |

The retrieval parameter shape is copied from the universal time-series contract (FRED
`series/observations`, JPM `/expressions/time-series`, World Bank Indicators), per `03-…`:
**`ids + from/to + frequency + aggregation + units + asOf + maxPoints + cursor`**.

### 5.2 The two server-side reductions happen in `/series` and **only** there

From `03-dataquery-system-design.md`, verbatim — these are the two reductions, and the reason the read
plane is persistent (it needs the pre-rolled buckets + a place to run LTTB):

1. **Frequency aggregation** — *"never ship daily ticks for a monthly request; serve from the pre-rolled
   TimescaleDB **continuous aggregate** bucket, not a raw scan."*
2. **Chart downsampling** — *"when `maxPoints` is set (the chart sends its pixel width), reduce to ≤ that
   many points via **LTTB** (shape-preserving) before serialization."*

> **Gateway must enforce a default `maxPoints`.** `03-…` flags this as a real rule: a *direct* HTTP-API
> call (not a chart panel) defaults to no cap, so the gateway sets a server-side default (≈800, the
> Grafana HTTP-API default) so a raw call can't pull an unbounded series. This is a *gateway* concern,
> but the data plane should also defensively clamp: never serialize more than `maxPoints` rows even if
> asked for more.

### 5.3 Why the contract is GET-only and read-only

The internal contract has **no write verbs**. The gateway cannot tell the data plane to ingest, refresh,
or fetch a series — those happen only on the write path, only via cron. If the gateway asks for a series
that isn't in the store yet, the correct answer is a typed `unavailable` (not a live fetch). This keeps
the two halves of CQRS cleanly separated: the gateway/data-plane axis is **query-only**; the cron/worker
axis is **command-only**. A reviewer can verify the separation by checking that `read_api/routers/` has
no `POST`/`PUT`/`DELETE` that triggers a fetch, and `worker/` has no inbound HTTP read endpoint.

### 5.4 Async vs threadpool on the read endpoints

The read endpoints are I/O-bound (DB + Redis). Use `async def` **only if** the DB/Redis driver is an
`await`-able async driver; if you call a **synchronous** driver, use plain `def` so FastAPI offloads it
to the threadpool instead of blocking the event loop. The exact FastAPI guidance
([Concurrency and async / await](https://fastapi.tiangolo.com/async/)):

- A plain `def` path operation *"is run in an external threadpool that is then awaited, instead of being
  called directly (as it would block the server)."*
- If you use libraries **without** `await` support (most databases): *"use `def`"* — FastAPI offloads it.
- If you use libraries **with** `await` support: *"use `async def`"* with `await`.
- *"If you just don't know, use normal `def`."*

> **The trap:** an `async def` endpoint that calls a **blocking** DB call without `await` blocks the
> *entire* event loop — *"a single blocking IO operation in an async def endpoint will block the entire
> server"* (search synthesis,
> [FastAPI async docs](https://fastapi.tiangolo.com/async/)). At read-spike scale that is a self-inflicted
> outage. So: async driver → `async def`; sync driver → `def` (threadpool). Never `async def` + a
> blocking call. (`async-and-background-work.md` covers this in depth; here it's a topology-level
> reminder because the read plane *is* the I/O-bound box.)

---

## 6. Which file / which skill for which task (the index)

The router from "I need to do X" to the right place. Use this when a task lands and you're unsure whether
it's *this* skill's concern or a sibling's.

| Task | Where it goes | Skill / reference |
|---|---|---|
| Stand up the FastAPI app; add the lifespan; open DB/Redis pools | `read_api/main.py` (lifespan) | this skill · `fastapi-app-structure-and-lifespan.md` |
| Add a new read endpoint (series/catalog) | `read_api/routers/*.py` + `Depends(get_stores)` | this skill · `fastapi-app-structure-and-lifespan.md` |
| Decide `async def` vs `def` for a route | the route signature | this skill · `async-and-background-work.md` |
| Move heavy work off the request path | `worker/` + cron trigger | this skill · `async-and-background-work.md` + `data-pipeline-worker-cron` |
| Add Pydantic settings / config | `app/settings.py` | this skill · `pydantic-v2-models-and-settings.md` |
| Write the Dockerfile / fly.toml; deploy to Fly | `read_api/` + `worker/` deploy | this skill · `deploy-on-fly.md` |
| **Stop a read endpoint from fetching upstream** | remove the capability — no httpx under `read_api/` | this skill · **this doc §4** |
| Write a provider fetcher (TET `Fetcher[Q,R]`) | `worker/fetchers/*.py` | `openbb-tet-normalization` (logic) + this skill (process) |
| Field-intersection standard models / `__alias_dict__` / `extra='allow'` | `app/models/` | `openbb-tet-normalization` |
| FIGI anchor / bitemporal crosswalk / corporate actions | `app/` security-master query + schema | `security-master-symbology` |
| DCAT/Fusion catalog model; PROV-O; the `commercialOk` definition | catalog schema + `Provenance` type | `data-provenance-licensing` |
| TimescaleDB hypertables / continuous aggregates / compression / `time_bucket` | Timescale schema + caggs | `timescaledb-timeseries` |
| Open the Timescale connection pool in lifespan | `app/stores.py` (pool factory) | this skill (opens it) · `timescaledb-timeseries` (designs the store) |
| Parquet Distribution write / partitioning / Arrow | `worker/persist.py` materialize step | `columnar-parquet-arrow` |
| Faceted filter + index + ranking + keyword search | **TS gateway** (not Python) | `faceted-discovery-search` |
| Idempotent bitemporal ingest / partial-failure / EDGAR fair-access | `worker/persist.py` + ingest semantics | `data-pipeline-worker-cron` |
| Redis `getOrRefresh` + SWR + rate-limit | **TS gateway** | `redis` (reused) |
| Gateway auth / JWT validation | **TS gateway** | `supabase` (reused) |
| MCP server surface (post-v1) | new persistent process on Fly | `mcp-server-building` |
| OpenAPI core / SDK gen / docs portal (post-v1) | spec emitted from `read_api/` structure | `api-publishing-sdk-portal` |

---

## 7. The five things to internalize before writing any data-plane code

1. **There are five roles, three of them yours-in-Python only as a *process*.** Gateway (TS/Vercel) and
   frontend (TS) are not this skill. You own the persistent read data plane and the write-path worker —
   their *structure and lifecycle*, not the data logic inside them (§3).

2. **Persistent ≠ optional.** The data plane holds DB pools, the cagg query layer, a Redis client across
   requests — things a Vercel function structurally cannot. That's *the* reason it's a Fly VM. Open them
   once in **lifespan**; never per-request (§2).

3. **In-process memory is not a shared cache.** Under `--workers N`, each worker has its own `app.state`;
   a value written in one is invisible to another. The shared cache is **Redis**, the shared truth is
   **the store**. Never build a cross-request cache as a Python dict (§2.2 caveat).

4. **The read plane has no fetch capability — by construction.** `read_api/` imports no `httpx`, injects
   only `get_stores`, and a CI grep proves it. The single `httpx.AsyncClient` lives only under
   `worker/`. The fetch happens only on the cron-driven write path, off the request path (§4). This is
   the framework-level form of repo non-negotiables #4 and #6, and it fixes `CRITICAL-2`.

5. **The internal contract is two GET-only read operations** (`/internal/catalog`, `/internal/series`),
   served from the store, each response carrying `Provenance{commercialOk}` per series, with frequency
   aggregation + LTTB downsampling the only server-side reductions — and they happen in `/series` only
   (§5).

---

## Sources

Project research docs (in-repo, read this run):
- `01-plan.md` — architecture diagram + the six hard boundaries + chosen stack + phased plan.
- `02-skills-and-pipeline.md` — the end-to-end pipeline table + the 10-skill list + the verified toolchain + dead-ends.
- `03-dataquery-system-design.md` — the gateway/data-plane/write-path diagram + the query-API contract + R-SCALE.

Repo rules / pattern source (in-repo):
- `CLAUDE.md` §"Cross-cutting non-negotiables" #1, #4, #6 — never-invent-a-number; Vercel-can't-hold-sockets (worker/cron + `CRON_SECRET`); secure-args-by-closure.
- `.claude/rules/product-at-scale.md` — R-SCALE tiers; "Heavy ingest … lives in `worker/` on a cron, not the serverless route".
- `.claude/rules/skill-layer-law.md` — dev-skill vs runtime product-skill vs tool.
- `worker/index.ts` + `worker/fly.toml` — the existing always-on Fly worker this data plane's deploy shape mirrors (`min_machines_running = 1`, `auto_stop_machines = false`).

Primary framework / platform docs (web, read this run):
- FastAPI — Lifespan Events: <https://fastapi.tiangolo.com/advanced/events/> ("before the `yield` … executed before the application starts taking requests"; "DB connection pools - initialized at startup, used by all requests"; "It's all `lifespan` or all events").
- FastAPI — Bigger Applications (project structure, APIRouter, `include_router`): <https://fastapi.tiangolo.com/tutorial/bigger-applications/>.
- FastAPI — Concurrency and async / await: <https://fastapi.tiangolo.com/async/> ("run in an external threadpool that is then awaited"; "If you just don't know, use normal `def`").
- FastAPI — Server Workers (Uvicorn `--workers`, per-process interpreter/GIL, in-memory state not shared): <https://fastapi.tiangolo.com/deployment/server-workers/>.
- HTTPX — Clients (single AsyncClient for the application lifetime; connection pooling): <https://www.python-httpx.org/advanced/clients/>.
- HTTPX — Resource Limits (`max_connections`, `max_keepalive_connections`, `keepalive_expiry`): <https://www.python-httpx.org/advanced/resource-limits/>.
- Fly.io — Private Networking (6PN WireGuard mesh, `.internal` DNS): <https://fly.io/docs/networking/private-networking/>.
- Fly.io — Flycast (private app-wide IPv6 via Fly Proxy, load balancing): <https://fly.io/docs/networking/flycast/>.
- microservices.io — CQRS pattern (read model / query side): <https://microservices.io/patterns/data/cqrs.html>.
- Querying Microservices with the CQRS and Materialized View Pattern (read service should not call upstream synchronously): <https://medium.com/event-driven-utopia/querying-microservices-with-the-cqrs-and-materialized-view-pattern-bdb8b17f95d1>.
