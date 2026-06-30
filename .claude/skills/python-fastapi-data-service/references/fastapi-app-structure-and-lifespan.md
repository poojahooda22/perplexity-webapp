# FastAPI App Structure & the Lifespan Protocol

> **Skill:** `python-fastapi-data-service` · **Product line:** JPM-Markets re-engineering
> **data-analytics service (NOT Lumina).** This is a *new* Python/FastAPI/data-engineering line —
> separate from Lumina's Bun + Express + Prisma + Upstash stack. Nothing here ships to Lumina.
>
> **This reference (theory + skeleton):** the FastAPI app object, the **lifespan** async context
> manager as the canonical startup/shutdown mechanism, where the shared `httpx` client + DB pool +
> object-store client get initialised, and the scalable **domain-module** project layout. It is the
> first thing you read before laying down `main.py` for any service in this line.
>
> **Versions pinned this session (verify before relying):**
> - FastAPI **0.138.0** — released 2026-06-20 ([PyPI](https://pypi.org/project/fastapi/),
>   [release notes](https://fastapi.tiangolo.com/release-notes/)).
> - Starlette **1.3.1** — bumped in FastAPI 0.137.2, 2026-06-18 ([release notes](https://fastapi.tiangolo.com/release-notes/)).
> - httpx **0.28.x** line — `DEFAULT_LIMITS = Limits(max_connections=100, max_keepalive_connections=20, keepalive_expiry=5.0)`
>   ([Resource Limits](https://www.python-httpx.org/advanced/resource-limits/)).
> - Python **3.11+** (assumed for `X | None` runtime unions, `asyncio.TaskGroup`, `tomllib`).

---

## 0. Plain-language on-ramp (the "so what")

A FastAPI service is two things: a tree of **route handlers** (the HTTP surface) and a set of
**long-lived resources** those handlers share — one HTTP client to call upstream market-data APIs,
one database connection pool, one object-store client. The single most common production bug in a
data service is getting the *second* thing wrong: opening a new `httpx.AsyncClient` or a new DB
connection **per request**. That throws away connection pooling and TLS reuse, exhausts upstream
rate budgets, and melts the database under load.

**Lifespan** is FastAPI's answer. It is one async function that runs **once** when the process boots
(open the pool, open the client) and **once** when it shuts down (close them cleanly). Everything in
between — every request — borrows from those already-open resources. Get this right and the service
scales; get it wrong and it dies at the first traffic spike with `too many connections` or
`connection pool exhausted`.

The **project structure** question is the other half: where does the quote-pricing code live vs. the
reference-data code vs. the analytics code? The answer this line uses is **domain modules** — one
folder per business domain (`pricing/`, `reference/`, `analytics/`), each holding its own router,
schemas, service, and repository — because a market-data platform has *many* domains, and the
alternative (one giant `routers/` folder, one giant `schemas/` folder) stops scaling the moment you
have more than a handful.

---

## 1. The FastAPI app object — what it actually is

`FastAPI` is a subclass of Starlette's `Starlette` ASGI application. Creating it is one line:

```python
from fastapi import FastAPI

app = FastAPI()
```

The constructor takes a large keyword surface; for this line the ones that matter are:

| Parameter | Purpose | This-line default |
|---|---|---|
| `lifespan` | the startup/shutdown context manager (see §2) | always set |
| `title` / `version` / `summary` | OpenAPI metadata | from settings |
| `docs_url` / `redoc_url` / `openapi_url` | the auto-docs paths | gated off in prod |
| `dependencies` | app-wide dependencies run on every request | auth/trace |
| `default_response_class` | swap to `ORJSONResponse` for speed | `ORJSONResponse` |
| `root_path` | when mounted behind a proxy at a sub-path | from settings |

The `lifespan` parameter's exact type in FastAPI 0.138.0 is
(`fastapi/applications.py`, around the `__init__` signature):

```python
lifespan: Annotated[
    Lifespan[AppType] | None,
    Doc(
        """
        A `Lifespan` context manager handler. This replaces `startup` and
        `shutdown` functions with a single context manager.
        ...
        """
    ),
] = None
```

`Lifespan[AppType]` is Starlette's type alias for "a callable that takes the app and returns an async
context manager." The default is `None`, meaning *no* startup/shutdown work. We never leave it `None`
in a data service — a data service is defined by the resources it holds open.

> Source: FastAPI 0.138.0 `fastapi/applications.py` `lifespan` parameter
> (`raw.githubusercontent.com/fastapi/fastapi/0.138.0/fastapi/applications.py`); the docstring
> points at <https://fastapi.tiangolo.com/advanced/events/>.

---

## 2. Lifespan — the canonical startup/shutdown mechanism

### 2.1 The signature you will write a hundred times

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── startup: everything BEFORE the yield runs once, before the
    #    server accepts a single request ──
    yield
    # ── shutdown: everything AFTER the yield runs once, after the last
    #    request has drained ──

app = FastAPI(lifespan=lifespan)
```

This is the verbatim shape from the official docs
([Lifespan Events](https://fastapi.tiangolo.com/advanced/events/)). Three load-bearing facts, each
confirmed against primary docs:

1. **`@asynccontextmanager` is mandatory.** The function is a generator with exactly one `yield`.
   The decorator turns it into an async context manager that Starlette enters on boot and exits on
   shutdown.
2. **Before `yield` = startup, after `yield` = shutdown.** The docs state the pre-yield block runs
   "once before the application starts taking requests" and the post-yield block runs "once after the
   application finishes handling requests, during the shutdown."
   ([Lifespan Events](https://fastapi.tiangolo.com/advanced/events/))
3. **The server does not serve until startup finishes.** Starlette: *"Starlette will not start
   serving any incoming requests until the lifespan has been run."*
   ([Starlette Lifespan](https://www.starlette.io/lifespan/)) So the pool/client are guaranteed
   present for the first request — there is no race.

### 2.2 The official "load a model on startup" example (verbatim)

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI

def fake_answer_to_everything_ml_model(x: float):
    return x * 42

ml_models = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the ML model
    ml_models["answer_to_everything"] = fake_answer_to_everything_ml_model
    yield
    # Clean up the ML models and release the resources
    ml_models.clear()

app = FastAPI(lifespan=lifespan)

@app.get("/predict")
async def predict(x: float):
    result = ml_models["answer_to_everything"](x)
    return {"result": result}
```

> Source: <https://fastapi.tiangolo.com/advanced/events/>. **Caveat:** the docs use a *module-global*
> dict (`ml_models = {}`) for brevity. We do **not** do that — see §4 on why singletons go on
> `app.state`, never module globals.

### 2.3 Why `lifespan` replaced `@app.on_event("startup")` / `@app.on_event("shutdown")`

The old API used two decorated functions:

```python
# DEPRECATED — do not write new code like this
@app.on_event("startup")
async def startup_event():
    ...

@app.on_event("shutdown")
async def shutdown_event():
    ...
```

The docs are explicit that lifespan is now the recommended way, and that the two are mutually
exclusive: *"If you provide a `lifespan` parameter, `startup` and `shutdown` event handlers will no
longer be called. It's all `lifespan` or all events, not both."*
([Lifespan Events](https://fastapi.tiangolo.com/advanced/events/))

**Why the migration matters — four concrete reasons, not style:**

1. **Shared scope without globals.** A single function `lifespan(app)` opens a resource into a local
   variable *and* tears it down in the same scope after `yield`. The old API needed module-level
   globals to bridge `startup_event()` and `shutdown_event()` because they were two separate
   functions with no shared frame. Globals are exactly the thing §4 warns against.
2. **Correct context-manager semantics.** Many resources are *themselves* async context managers —
   `httpx.AsyncClient`, an `aioboto3` session, an `asyncpg` pool acquire. With lifespan you write
   `async with httpx.AsyncClient() as client: yield {...}` and cleanup is guaranteed even on
   exceptions. The two-callback API could not naturally hold an `async with` open across the app's
   life. This is precisely the problem in FastAPI discussion
   [#6068](https://github.com/fastapi/fastapi/discussions/6068) (long-lived `aioboto3` client), whose
   accepted answer is: *"With the release of 0.94.0 the lifespan start up context manager is now
   available so in the case of aioboto that is where I would do it now."*
3. **`AsyncExitStack` composition.** Multiple resources stack cleanly under one
   `contextlib.AsyncExitStack` inside lifespan (see §6.4) — open pool, open client, open store, and
   they unwind in reverse on shutdown. There is no clean equivalent with two callbacks.
4. **Deprecation trajectory.** `on_event` is documented as the legacy path and Starlette's own
   guidance routes everyone to lifespan; writing new `on_event` code is writing to-be-removed code.

> **Decision rule:** every service in this line uses `lifespan`. Never `@app.on_event`. If you see
> `on_event` in a copied snippet, port it before committing.

### 2.4 Lifespan does NOT run for mounted sub-applications

If you `app.mount("/subapi", subapi)` a second FastAPI instance, **the sub-app's lifespan does not
run** — only the main application's does. The docs: *"these lifespan events (startup and shutdown)
will only be executed for the main application, not for Sub Applications - Mounts."*
([Lifespan Events](https://fastapi.tiangolo.com/advanced/events/))

**Consequence for this line:** do not split a data service into mounted FastAPI sub-apps that each
expect their own pool to open. Use **one** app, **one** lifespan, and **routers** (`include_router`,
§5) for modular composition — routers share the parent's lifespan and `app.state`. If you genuinely
need an independently-deployed service, deploy a separate process, not a mount.

### 2.5 The shutdown drain guarantee

Starlette: *"The lifespan teardown will run once all connections have been closed, and any in-process
background tasks have completed."* ([Starlette Lifespan](https://www.starlette.io/lifespan/)) So the
post-`yield` cleanup runs **after** in-flight requests drain — closing the DB pool there will not rip
the rug out from a request that is mid-query, *provided* the request holds a connection from the pool
rather than the pool object itself. (Edge case under hard `SIGKILL` or a frozen worker the platform
forcibly reaps: cleanup may not run at all — never make correctness depend on shutdown firing; pools
and clients must also survive abrupt death, which they do because the OS closes the sockets.)

---

## 3. Two ways to expose shared state from lifespan

There are **two** mechanisms to hand a startup-created resource to request handlers. Know both;
this line standardises on (A).

### (A) `app.state` — the FastAPI-idiomatic store

Assign the resource as an attribute of `app.state` during startup; read it in a handler via
`request.app.state.<name>`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db_pool = await create_pool(...)
    yield
    await app.state.db_pool.close()

@app.get("/health/db")
async def db_health(request: Request):
    async with request.app.state.db_pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"db": "ok"}
```

This is the pattern the top answer in FastAPI discussion
[#9097](https://github.com/fastapi/fastapi/discussions/9097) recommends ("store the connection pool
on `app.state` ... access it via `request.app.state`"), and what discussion
[#11742](https://github.com/fastapi/fastapi/discussions/11742) confirms: *"During requests, access
stored values via `request.app.state.x`."* `app.state` is a `starlette.datastructures.State` — a
plain attribute bag living for the whole app lifetime.

We wrap the raw `request.app.state.X` read in a **dependency** so handlers stay decoupled from the
storage mechanism (§7).

### (B) Yielding a state dict — the Starlette mechanism

Starlette's lifespan may `yield` a dict; that dict becomes the per-request `request.state`:

```python
@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient() as client:
        yield {"http_client": client}
# handler: client = request.state["http_client"]
```

> Source: [Starlette Lifespan](https://www.starlette.io/lifespan/). Note: *"The `state` received on
> the requests is a **shallow** copy of the state received on the lifespan handler."*

**Why this line prefers (A) over (B):**

- FastAPI's own docs, the dependency-injection ecosystem, and `request.app.state` examples are all
  written against `app.state`. (B) is Starlette-level and less idiomatic in FastAPI.
- (A) makes the resource reachable from *anywhere* you can get the `app` (background tasks, the
  lifespan itself, test fixtures via `app.state`), not only from a request scope.
- The shallow-copy semantics of (B) are a subtlety that bites people (mutating a nested object in
  `request.state` mutates the shared one). (A) avoids the surprise.

**Rule:** use `app.state` (A). Reserve the yielded-dict form for when you specifically want
per-request `request.state` ergonomics and accept the shallow-copy contract.

---

## 4. Singletons go on `app.state`, NEVER on module globals

The textbook examples (`ml_models = {}`, `app.state` patterns) make this look like a free choice. It
is not. **Store every startup-created singleton on `app.state`; never on a module-level global.**

### 4.1 Why module globals break

```python
# ❌ ANTI-PATTERN — module global mutated at startup
db_pool = None  # module level

@asynccontextmanager
async def lifespan(app):
    global db_pool
    db_pool = await create_pool(...)   # mutates module state
    yield
    await db_pool.close()
```

Four concrete failures:

1. **Two apps in one process collide.** Tests routinely build a *second* `FastAPI()` (a fresh app per
   test module, or an app-under-test plus a mock app). Module globals are shared across them — app B's
   startup stomps app A's `db_pool`. With `app.state`, each app owns its own pool. This alone is
   reason enough; the test suite is where this bug surfaces first and most painfully.
2. **`None` until startup runs.** A module global is `None` at import time. Any code that touches it
   before lifespan has run (a module-load side effect, a mis-ordered import, a `--reload` worker that
   imported but hasn't booted) gets `AttributeError: 'NoneType' object has no attribute 'acquire'`.
   `app.state.db_pool` simply doesn't exist until set, and the failure is localised and obvious.
3. **No clean teardown isolation.** `global db_pool; await db_pool.close()` leaves a *closed* pool
   object bound to the global. A subsequent test or re-entry reuses the dead handle. `app.state` dies
   with the app object.
4. **Import-time coupling.** Reaching a global means `from app.db import db_pool` everywhere — now
   half the codebase imports the db module just to get the pool, and circular imports bloom.
   `app.state` is reached through the request/app you already have.

### 4.2 The rule, stated precisely

> Anything created in `lifespan` that must outlive a single request — the DB pool, the `httpx`
> client, the object-store client, a Redis client, a warmed cache, a background scheduler — is
> assigned to `app.state.<name>` in the startup block and torn down in the shutdown block. Handlers
> reach it through a **dependency** that reads `request.app.state.<name>` (§7). Module globals are
> reserved for genuine constants (`DEFAULT_LIMITS`, enum values, the settings object — itself a
> cached singleton, see §8).

---

## 5. Router composition — `APIRouter` + `include_router`

A data service has many endpoints; they must not all live in `main.py`. FastAPI's unit of modular
routing is `APIRouter` — *"a 'mini FastAPI' class"* with the same options as the app
([Bigger Applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/)).

### 5.1 Defining a router (verbatim shape from the docs)

```python
from fastapi import APIRouter, Depends, HTTPException
from ..dependencies import get_token_header

router = APIRouter(
    prefix="/items",
    tags=["items"],
    dependencies=[Depends(get_token_header)],
    responses={404: {"description": "Not found"}},
)

@router.get("/")
async def read_items():
    return fake_items_db

@router.get("/{item_id}")
async def read_item(item_id: str):
    if item_id not in fake_items_db:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"name": fake_items_db[item_id]["name"], "item_id": item_id}
```

> Source: [Bigger Applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/). The
> `prefix` must **not** end in `/` (`"/items"`, never `"/items/"`).

The `APIRouter` constructor mirrors `include_router`: `prefix`, `tags`, `dependencies`, `responses`
all attach to every route in the router.

### 5.2 Mounting routers with `include_router`

```python
from fastapi import Depends, FastAPI
from .dependencies import get_query_token, get_token_header
from .internal import admin
from .routers import items, users

app = FastAPI(dependencies=[Depends(get_query_token)])

app.include_router(users.router)
app.include_router(items.router)
app.include_router(
    admin.router,
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(get_token_header)],
    responses={418: {"description": "I'm a teapot"}},
)
```

> Source: [Bigger Applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/).

Key behaviours, all from the docs:

- `include_router(prefix=..., tags=..., dependencies=..., responses=...)` layers **on top of** what
  the router already declares. If the router has `tags=["items"]` and an operation also has
  `tags=["custom"]`, the route ends up with **both** — `["items", "custom"]`.
- **Router-level dependencies run first**, then `include_router`-level, then per-operation. Order is
  outer-to-inner.
- The **same router can be included twice under different prefixes** —
  `app.include_router(router, prefix="/api/v1")` and `app.include_router(router, prefix="/api/latest")`
  — which is exactly how this line serves a stable `/api/v1` while previewing `/api/latest`.
- Routers nest: `router.include_router(other_router)` composes an `APIRouter` into another.

### 5.3 The `/api/v1` versioning convention for this line

Every public route lives under a **version prefix**. We attach it once at the composition root so the
domain routers stay version-agnostic:

```python
# src/api.py — the single place all routers are assembled
from fastapi import APIRouter
from src.pricing.router import router as pricing_router
from src.reference.router import router as reference_router
from src.analytics.router import router as analytics_router

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(pricing_router)     # -> /api/v1/pricing/...
api_router.include_router(reference_router)   # -> /api/v1/reference/...
api_router.include_router(analytics_router)   # -> /api/v1/analytics/...
```

Then `main.py` does a single `app.include_router(api_router)`. When `/api/v2` arrives, you build a
second `api_router_v2` from the *next* versions of the domain routers and include both — old clients
keep `/api/v1`, new clients get `/api/v2`, no route handler changed. The version prefix lives at the
boundary, not smeared through every `@router.get`.

---

## 6. Where lifespan initialises the shared resources

This is the heart of a data service. The three resources every market-data service in this line holds
open: **an `httpx.AsyncClient`** (upstream provider calls), **a DB connection pool** (Postgres /
TimescaleDB), and **an object-store client** (S3-compatible, for large series / Parquet / report
artefacts).

### 6.1 The shared `httpx.AsyncClient` — one per process

**Why one:** *"Generally you want a single client instance, that lasts for the lifetime of the
application, and closes when the program terminates ... all connections will share the same connection
pool"* ([httpx Discussion #1552](https://github.com/encode/httpx/discussions/1552), summarised in the
httpx docs' [Resource Limits](https://www.python-httpx.org/advanced/resource-limits/)). A per-request
client throws away keep-alive and re-does the TLS handshake on every upstream call — fatal when you
are fanning out to Twelve Data / a market-data vendor under a tight per-minute rate budget.

```python
import httpx

# module-level constant — a config value, NOT a runtime singleton (§4 exception)
HTTPX_LIMITS = httpx.Limits(
    max_connections=100,            # DEFAULT_LIMITS value, made explicit
    max_keepalive_connections=20,
    keepalive_expiry=5.0,
)
HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)

# inside lifespan startup:
app.state.http_client = httpx.AsyncClient(
    limits=HTTPX_LIMITS,
    timeout=HTTPX_TIMEOUT,
    headers={"user-agent": settings.user_agent},
)
# inside lifespan shutdown:
await app.state.http_client.aclose()
```

`max_connections=100 / max_keepalive_connections=20 / keepalive_expiry=5.0` are the documented httpx
**defaults** ([Resource Limits](https://www.python-httpx.org/advanced/resource-limits/)) — we write
them explicitly so the budget is visible and tunable, not hidden. **Always set an explicit
`Timeout`** — httpx's default is generous and an upstream hang must not pin a worker forever.
**`await client.aclose()` on shutdown is mandatory**; an un-closed `AsyncClient` emits a resource
warning and leaks sockets ([Resource Limits](https://www.python-httpx.org/advanced/resource-limits/)).

### 6.2 The DB connection pool — `asyncpg` and SQLAlchemy-async forms

**asyncpg (raw, fastest path for read-heavy series):**

```python
import asyncpg

# startup
app.state.db_pool = await asyncpg.create_pool(
    dsn=settings.database_url,
    min_size=settings.db_pool_min,   # e.g. 2
    max_size=settings.db_pool_max,   # e.g. 10
    command_timeout=30,
)
# shutdown
await app.state.db_pool.close()
```

`asyncpg.create_pool(...)` then `await pool.close()` is the pattern confirmed in FastAPI discussion
[#9097](https://github.com/fastapi/fastapi/discussions/9097). Handlers acquire a connection per query
via `async with request.app.state.db_pool.acquire() as conn:` and **release it back** — they never
hold the pool object itself across a long operation.

**SQLAlchemy async engine (when you want the ORM / `text()` / Alembic ergonomics):**

```python
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

# startup
engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=20)
app.state.db_engine = engine
app.state.db_sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
# shutdown
await engine.dispose()
```

The async engine's correct teardown is `await engine.dispose()` — this closes the underlying
connection pool. (See the asyncpg/SQLAlchemy-async lifespan discussions surfaced in search; the
sibling `timescaledb-timeseries` skill owns the deep connection-layer details — `asyncpg` vs
`psycopg` vs SQLAlchemy, bulk `COPY`, Alembic.)

> **Pool sizing is a scale decision, not a default.** `max_size` × number of worker processes must
> stay under Postgres's `max_connections`. Four Gunicorn/Uvicorn workers × `max_size=10` = 40
> connections from one box. Behind a serverless or many-box deploy, front the DB with **PgBouncer**
> (transaction pooling) — the per-process pool then talks to PgBouncer, not directly to Postgres.
> State the tier: a single box with `max_size=10` is fine to early traction; lakhs-concurrent needs
> PgBouncer + bounded per-process pools. (Battery: `~/.claude/rules/product-scale-architecture.md`.)

### 6.3 The object-store client (S3-compatible)

Large series, Parquet exports, and report artefacts go to object storage, not the row store. The
client is long-lived like the others. `aioboto3` is an **async context manager** — exactly the case
that motivated lifespan (FastAPI discussion
[#6068](https://github.com/fastapi/fastapi/discussions/6068)):

```python
import aioboto3

# startup — aioboto3 needs an exit stack because its client IS a context manager
session = aioboto3.Session()
app.state._s3_cm = session.client("s3", endpoint_url=settings.s3_endpoint)
app.state.s3 = await app.state._s3_cm.__aenter__()
# shutdown
await app.state._s3_cm.__aexit__(None, None, None)
```

The bare `__aenter__`/`__aexit__` above is ugly; §6.4 replaces it with `AsyncExitStack`, which is the
clean form for *any* resource that is itself a context manager.

### 6.4 Composing all three with `AsyncExitStack` (the production lifespan)

When several resources are context managers, stack them under one
[`contextlib.AsyncExitStack`](https://docs.python.org/3/library/contextlib.html#contextlib.AsyncExitStack)
so they unwind in reverse on shutdown, even if one raises:

```python
# src/core/lifespan.py
import contextlib
from contextlib import asynccontextmanager

import aioboto3
import asyncpg
import httpx
from fastapi import FastAPI

from src.core.config import settings
from src.core.logging import configure_logging, get_logger

logger = get_logger(__name__)

HTTPX_LIMITS = httpx.Limits(max_connections=100, max_keepalive_connections=20, keepalive_expiry=5.0)
HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)
    logger.info("startup.begin", env=settings.environment)

    async with contextlib.AsyncExitStack() as stack:
        # 1. HTTP client for upstream market-data providers
        app.state.http_client = await stack.enter_async_context(
            httpx.AsyncClient(limits=HTTPX_LIMITS, timeout=HTTPX_TIMEOUT)
        )

        # 2. Postgres / TimescaleDB connection pool
        app.state.db_pool = await asyncpg.create_pool(
            dsn=settings.database_url,
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
            command_timeout=30,
        )
        stack.push_async_callback(app.state.db_pool.close)

        # 3. S3-compatible object store (itself an async context manager)
        s3_session = aioboto3.Session()
        app.state.s3 = await stack.enter_async_context(
            s3_session.client("s3", endpoint_url=settings.s3_endpoint)
        )

        logger.info("startup.ready")
        yield
        logger.info("shutdown.begin")
    # AsyncExitStack unwinds here: s3 closed, then db_pool.close(), then http_client.aclose()
    logger.info("shutdown.complete")
```

Why `AsyncExitStack`:

- `enter_async_context(cm)` opens a context manager and registers its `__aexit__` for shutdown — one
  call covers open *and* the matching close.
- `push_async_callback(fn)` registers a plain coroutine (like `pool.close`) for shutdown — for
  resources that are *not* context managers (asyncpg's pool is created by an awaitable, not an
  `async with`).
- On `yield`-exit the stack unwinds **in reverse order**, so dependencies close after their
  dependents.
- If *startup itself* raises after opening the pool but before the client, the already-entered
  resources still unwind — no leak on a half-failed boot.

> Note on dependencies-in-lifespan: FastAPI's `Depends()` injection does **not** natively run inside
> lifespan (it is a request-time mechanism). FastAPI discussion
> [#11742](https://github.com/fastapi/fastapi/discussions/11742) shows an unofficial `solve_dependencies`
> workaround, but the maintained guidance is: do resource setup **directly** in lifespan (as above),
> and expose it to requests via `app.state` + a small dependency (§7). Do not pull the `solve_dependencies`
> hack into this line.

---

## 7. Bridging `app.state` to handlers with dependencies

Handlers should not reach into `request.app.state.db_pool` directly everywhere — that hardwires every
handler to the storage detail. Wrap each resource in a one-line dependency; handlers depend on the
dependency. Swapping storage later touches one function, not fifty.

```python
# src/core/dependencies.py
from typing import Annotated

import asyncpg
import httpx
from fastapi import Depends, Request


def get_http_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.http_client


def get_db_pool(request: Request) -> asyncpg.Pool:
    return request.app.state.db_pool


HttpClient = Annotated[httpx.AsyncClient, Depends(get_http_client)]
DbPool = Annotated[asyncpg.Pool, Depends(get_db_pool)]
```

```python
# in a domain router — clean, storage-agnostic, fully typed
from src.core.dependencies import DbPool, HttpClient

@router.get("/quote/{symbol}")
async def get_quote(symbol: str, client: HttpClient, db: DbPool):
    ...
```

The `Annotated[..., Depends(...)]` alias (the `HttpClient` / `DbPool` types) is the modern FastAPI
idiom — it makes the dependency reusable and the signature self-documenting, and it is the form the
docs use for `dependencies.py` modules
([Bigger Applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/) uses
`Annotated[str, Header()]` in the same spirit). A per-request DB **session** (SQLAlchemy) gets a
`yield`-dependency that opens a session from the sessionmaker and closes it after the request —
distinct from the long-lived *pool*, which lives on `app.state`.

---

## 8. The `create_app()` factory pattern

Rather than a module-level `app = FastAPI(...)` with all wiring at import time, this line uses a
**factory** — a function that builds and returns a configured app:

```python
# src/main.py
from fastapi import FastAPI
from fastapi.responses import ORJSONResponse

from src.api import api_router
from src.core.config import settings
from src.core.lifespan import lifespan
from src.core.middleware import install_middleware
from src.core.exceptions import install_exception_handlers


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        lifespan=lifespan,
        default_response_class=ORJSONResponse,
        docs_url="/docs" if settings.enable_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.enable_docs else None,
    )
    install_middleware(app)
    install_exception_handlers(app)
    app.include_router(api_router)        # /api/v1/...

    @app.get("/health", tags=["meta"], include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()   # the ASGI entrypoint: `uvicorn src.main:app`
```

**Why a factory, not a bare module global app:**

1. **Tests build a fresh, isolated app per case** — `app = create_app()` in a fixture, with settings
   overridden, no import-time side effects bleeding between tests. A module-global `app` is created
   once at import and shared across the whole suite, so any test that mutates it poisons the next.
2. **Config-dependent construction.** `docs_url`, middleware, and CORS differ by environment; the
   factory reads settings and *decides* at build time. A module-global app would have to read settings
   at import, which forces settings to be import-safe and ordering-fragile.
3. **Multiple apps in one process** (a worker + an admin app; a test harness with a mock upstream)
   each call the factory — no collision.
4. **Clean ASGI entrypoint** — `uvicorn src.main:app` still works because the module ends with a
   single `app = create_app()`; the factory is an implementation detail behind it.

The `settings` object is the one acceptable module-level singleton — it is an immutable, cached
`pydantic-settings` `BaseSettings` instance (`@lru_cache`'d `get_settings()` or a module constant),
not a mutable runtime resource. ([fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)
recommends splitting settings *across* domain modules — a global `src/core/config.py` for app-wide
values plus per-domain `config.py` for domain-specific ones.)

---

## 9. Project structure — domain modules vs. file-type layout

### 9.1 The two layouts

**File-type ("scale by layer") — what the FastAPI tutorial shows:**

```
app/
├── main.py
├── dependencies.py
├── routers/        ← ALL routers
│   ├── items.py
│   └── users.py
└── internal/
    └── admin.py
```

> Source: [Bigger Applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/).

**Domain-module ("package by feature") — what this line uses:**

```
src/
├── pricing/
│   ├── router.py
│   ├── schemas.py
│   ├── service.py
│   ├── repository.py
│   ├── dependencies.py
│   └── exceptions.py
├── reference/
│   └── (same six files)
├── analytics/
│   └── (same six files)
├── core/
│   ├── config.py
│   ├── logging.py
│   ├── lifespan.py
│   ├── dependencies.py
│   ├── middleware.py
│   └── exceptions.py
├── api.py          ← assembles the /api/v1 router from the domains
└── main.py         ← create_app()
```

This mirrors the
[fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices) recommended structure
(`src/auth/`, `src/posts/` each with `router.py`, `schemas.py`, `models.py`, `dependencies.py`,
`service.py`, `config.py`, `exceptions.py`, `utils.py`). Their stated rationale: the file-type
approach *"works well for microservices or smaller projects. However, this approach didn't scale well
for our monolith with many domains and modules."*

### 9.2 The trade-off, made explicit

| | File-type layout | Domain-module layout |
|---|---|---|
| **Add a domain** | edit `routers/`, `schemas/`, `services/` — touch many global folders | add one new folder `src/<domain>/` — touch nothing else |
| **Delete a domain** | hunt across every layer folder | `rm -r src/<domain>/` + one line in `api.py` |
| **Find a domain's code** | scattered by file type | all in one folder |
| **Onboarding** | "where does pricing live?" → everywhere | → `src/pricing/` |
| **Sweet spot** | a handful of endpoints, one bounded context | many domains (a data platform — exactly this line) |
| **Risk** | `schemas.py` becomes a 3000-line god-file | a domain folder can get fat → split into sub-packages |

**Verdict for this line:** **domain modules.** A market-data analytics platform has many bounded
contexts (pricing, reference/instruments, analytics, ingestion, auth) that grow independently. The
file-type layout's god-files (`schemas/`, `services/`) are the exact failure
[fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices) hit on a real
monolith.

### 9.3 The six files in a domain module and what each owns

| File | Owns | Must NOT contain |
|---|---|---|
| `router.py` | endpoint definitions, HTTP I/O, status codes; **thin** — delegates to service | business logic, SQL |
| `schemas.py` | Pydantic request/response models (the API contract) | DB models, logic |
| `service.py` | business logic; **fat** — orchestrates repos + upstream calls | raw SQL, FastAPI types |
| `repository.py` | data access; **owns the SQL** / asyncpg / ORM queries | HTTP concerns, business rules |
| `dependencies.py` | domain-specific `Depends()` (resource resolution, validation, authz for this domain) | logic that belongs in service |
| `exceptions.py` | domain exception types mapped to HTTP errors | |

---

## 10. Thin routers · fat services · repositories own the SQL

This is the separation of concerns that keeps a data service maintainable. Each layer has exactly one
reason to change.

### 10.1 The rule

- **Router (thin):** parse the request, call **one** service method, shape the response. The router
  knows HTTP; it knows nothing about *how* a quote is fetched or stored. If a route handler contains
  an `if/else` of business logic or a SQL string, it is too fat.
  [fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices): `router.py` is
  *"the core of each module with all the endpoints"*; logic lives in `service.py` (*"module specific
  business logic"*).
- **Service (fat):** the business logic — orchestrate repositories, call upstream providers via the
  shared httpx client, enforce rules (rate budget, `commercialOk`-style licensing gates on which
  series may be displayed), compose results. The service is the only layer that knows *the domain*.
  It takes already-resolved resources (a repo, the http client) as arguments — it does not import
  `app.state` or FastAPI request types, which keeps it unit-testable without a running server.
- **Repository (owns SQL):** the *only* place raw SQL / asyncpg calls / ORM queries live. One method
  per query intent (`fetch_latest_quote(symbol)`, `bulk_insert_bars(rows)`). Swapping Postgres for
  TimescaleDB-specific SQL, or adding an index, touches the repository and nothing above it. This
  isolates the data layer so a query change never ripples into business logic or HTTP code.

### 10.2 The shape, end to end

```python
# src/pricing/repository.py — OWNS the SQL
import asyncpg

class QuoteRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def fetch_latest(self, symbol: str) -> asyncpg.Record | None:
        async with self._pool.acquire() as conn:
            return await conn.fetchrow(
                "SELECT symbol, price, ts, source FROM quotes "
                "WHERE symbol = $1 ORDER BY ts DESC LIMIT 1",
                symbol,
            )
```

```python
# src/pricing/service.py — FAT: business logic, no SQL, no FastAPI types
import httpx
from src.pricing.repository import QuoteRepository
from src.pricing.schemas import Quote
from src.pricing.exceptions import QuoteUnavailable

class PricingService:
    def __init__(self, repo: QuoteRepository, http: httpx.AsyncClient) -> None:
        self._repo = repo
        self._http = http

    async def get_quote(self, symbol: str) -> Quote:
        row = await self._repo.fetch_latest(symbol)
        if row is not None and _is_fresh(row["ts"]):
            return Quote.model_validate(dict(row))
        # cache miss / stale → fetch upstream via the SHARED client, then return
        # a typed `unavailable` on failure — never fabricate a number
        try:
            resp = await self._http.get(_provider_url(symbol))
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise QuoteUnavailable(symbol) from exc
        return _to_quote(resp.json())
```

```python
# src/pricing/router.py — THIN: HTTP in, service call, HTTP out
from fastapi import APIRouter, Depends
from src.pricing.dependencies import get_pricing_service
from src.pricing.schemas import Quote
from src.pricing.service import PricingService

router = APIRouter(prefix="/pricing", tags=["pricing"])

@router.get("/quote/{symbol}", response_model=Quote)
async def get_quote(
    symbol: str,
    service: PricingService = Depends(get_pricing_service),
) -> Quote:
    return await service.get_quote(symbol)
```

```python
# src/pricing/dependencies.py — wires resources → repo → service
from fastapi import Depends, Request
from src.pricing.repository import QuoteRepository
from src.pricing.service import PricingService

def get_pricing_service(request: Request) -> PricingService:
    pool = request.app.state.db_pool
    http = request.app.state.http_client
    return PricingService(QuoteRepository(pool), http)
```

Note how the dependency is the **only** place that touches `request.app.state` — the service and repo
receive plain objects and are fully unit-testable with fakes. This is the payoff of §7's bridge.

---

## 11. The minimal runnable `main.py` skeleton

A complete, runnable starting point that embodies §2–§10. Drop it into `src/` and `uvicorn src.main:app`
boots a service with a real lifespan, real shared resources, one domain router, and a health check.

```python
# src/core/config.py
from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "jpm-markets-data-service"
    app_version: str = "0.1.0"
    environment: str = "dev"
    enable_docs: bool = True
    log_level: str = "INFO"

    database_url: str = Field(..., alias="DATABASE_URL")
    db_pool_min: int = 2
    db_pool_max: int = 10
    s3_endpoint: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
```

```python
# src/core/lifespan.py
import contextlib
from contextlib import asynccontextmanager

import asyncpg
import httpx
from fastapi import FastAPI

from src.core.config import settings

HTTPX_LIMITS = httpx.Limits(max_connections=100, max_keepalive_connections=20, keepalive_expiry=5.0)
HTTPX_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with contextlib.AsyncExitStack() as stack:
        app.state.http_client = await stack.enter_async_context(
            httpx.AsyncClient(limits=HTTPX_LIMITS, timeout=HTTPX_TIMEOUT)
        )
        app.state.db_pool = await asyncpg.create_pool(
            dsn=settings.database_url,
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
            command_timeout=30,
        )
        stack.push_async_callback(app.state.db_pool.close)
        yield
    # AsyncExitStack unwinds: db_pool.close(), then http_client.aclose()
```

```python
# src/core/dependencies.py
import asyncpg
import httpx
from fastapi import Request


def get_http_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.http_client


def get_db_pool(request: Request) -> asyncpg.Pool:
    return request.app.state.db_pool
```

```python
# src/pricing/schemas.py
from datetime import datetime
from pydantic import BaseModel


class Quote(BaseModel):
    symbol: str
    price: float
    ts: datetime
    source: str
```

```python
# src/pricing/router.py
from fastapi import APIRouter, Depends, HTTPException

from src.core.dependencies import get_db_pool
from src.pricing.schemas import Quote

router = APIRouter(prefix="/pricing", tags=["pricing"])


@router.get("/quote/{symbol}", response_model=Quote)
async def get_quote(symbol: str, pool=Depends(get_db_pool)) -> Quote:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT symbol, price, ts, source FROM quotes "
            "WHERE symbol = $1 ORDER BY ts DESC LIMIT 1",
            symbol,
        )
    if row is None:
        raise HTTPException(status_code=404, detail=f"No quote for {symbol}")
    return Quote.model_validate(dict(row))
```

```python
# src/api.py
from fastapi import APIRouter
from src.pricing.router import router as pricing_router

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(pricing_router)
```

```python
# src/main.py
from fastapi import FastAPI
from fastapi.responses import ORJSONResponse

from src.api import api_router
from src.core.config import settings
from src.core.lifespan import lifespan


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        lifespan=lifespan,
        default_response_class=ORJSONResponse,
        docs_url="/docs" if settings.enable_docs else None,
        openapi_url="/openapi.json" if settings.enable_docs else None,
        redoc_url=None,
    )
    app.include_router(api_router)

    @app.get("/health", tags=["meta"], include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
```

Run it: `uvicorn src.main:app --reload`. The `/api/v1/pricing/quote/{symbol}` route borrows the pool
opened once in lifespan; `/health` answers without touching any resource; on Ctrl-C the
`AsyncExitStack` closes the pool then the client.

> **`--reload` and lifespan note:** `uvicorn --reload` re-runs lifespan on every code change (each
> reload restarts the worker). That is fine in dev; just know your pool reopens on every save. Never
> rely on long-lived in-memory state surviving a reload.

---

## 12. Testing the lifespan (so it actually runs)

A subtle gotcha: with Starlette's `TestClient`, **lifespan only runs if you use the client as a
context manager.** A bare `TestClient(app)` does not trigger startup, so `app.state.db_pool` is never
set and tests fail with `AttributeError`.

```python
from fastapi.testclient import TestClient
from src.main import create_app

def test_quote_route():
    app = create_app()                 # fresh, isolated app (the factory payoff)
    with TestClient(app) as client:    # <-- the `with` runs lifespan startup/shutdown
        resp = client.get("/api/v1/pricing/quote/AAPL")
    assert resp.status_code in (200, 404)
```

> Source: Starlette's testing note — *"Use `TestClient` as a context manager to ensure lifespan
> execution during tests."* ([Starlette Lifespan](https://www.starlette.io/lifespan/)). For async
> tests with `httpx.ASGITransport`, wrap startup with `async with LifespanManager(app)` (from
> `asgi-lifespan`) since the raw ASGI transport does not fire lifespan either.

---

## 13. Anti-patterns (mistake → fix)

| Mistake | Why it breaks | Fix |
|---|---|---|
| `@app.on_event("startup")` / `"shutdown")` | legacy API; can't hold an `async with` open; forces globals | one `lifespan` async context manager (§2) |
| `httpx.AsyncClient()` created **per request** | no keep-alive/TLS reuse; exhausts upstream rate budget; socket churn | one client in lifespan on `app.state` (§6.1) |
| New DB connection per request | connection storms; blows past `max_connections` | one pool in lifespan; `acquire()` per query (§6.2) |
| Singleton on a **module global** | breaks 2-apps-in-one-process; `None` before startup; no teardown isolation | assign to `app.state.<name>` (§4) |
| Un-closed `AsyncClient` / pool | resource warning; leaked sockets/connections | `aclose()` / `pool.close()` after `yield`; prefer `AsyncExitStack` (§6.4) |
| All routes in `main.py` | one unmergeable god-file | `APIRouter` per domain + `include_router` (§5) |
| `routers/` + `schemas/` god-folders for a many-domain platform | doesn't scale; scattered code | domain modules `src/<domain>/...` (§9) |
| SQL inside a route handler | HTTP and data layers fused; untestable | repository owns SQL; thin router → fat service → repo (§10) |
| `request.app.state.X` read in every handler | hardwires storage detail everywhere | one `Depends()` bridge in `core/dependencies.py` (§7) |
| Module-global `app = FastAPI()` with import-time wiring | tests share/poison one app; config-at-import fragility | `create_app()` factory (§8) |
| Bare `TestClient(app)` in tests | lifespan never runs; `app.state` empty | `with TestClient(app) as client:` (§12) |
| Mounting FastAPI sub-apps expecting their own startup | sub-app lifespan does **not** run | one app + routers; separate process if truly independent (§2.4) |
| No explicit `httpx.Timeout` | an upstream hang pins a worker indefinitely | explicit `Timeout(connect/read/write/pool)` (§6.1) |

---

## 14. Sources (read this session)

- **FastAPI — Lifespan Events** — <https://fastapi.tiangolo.com/advanced/events/> — the `@asynccontextmanager`
  signature, the ml-model example, `on_event` deprecation ("all `lifespan` or all events"), sub-app
  caveat.
- **FastAPI — Bigger Applications** — <https://fastapi.tiangolo.com/tutorial/bigger-applications/> —
  `APIRouter`, `include_router(prefix/tags/dependencies/responses)`, the file structure, relative
  imports, double-include under different prefixes.
- **FastAPI — Sub Applications** — <https://fastapi.tiangolo.com/advanced/sub-applications/> — `app.mount`.
- **FastAPI 0.138.0 source `applications.py`** —
  <https://raw.githubusercontent.com/fastapi/fastapi/0.138.0/fastapi/applications.py> — the
  `lifespan: Lifespan[AppType] | None = None` parameter + docstring.
- **FastAPI — Release Notes** — <https://fastapi.tiangolo.com/release-notes/> — 0.138.0 (2026-06-20);
  Starlette bumped to 1.3.1 in 0.137.2.
- **Starlette — Lifespan** — <https://www.starlette.io/lifespan/> — yielded-state dict, shallow-copy
  semantics, "won't serve until lifespan run," shutdown-drain, TestClient-as-context-manager.
- **FastAPI Discussion #6068** — <https://github.com/fastapi/fastapi/discussions/6068> — long-lived
  `aioboto3` client → use lifespan (since 0.94.0).
- **FastAPI Discussion #11742** — <https://github.com/fastapi/fastapi/discussions/11742> —
  `request.app.state.x` access; the `solve_dependencies`-in-lifespan workaround (which we do NOT adopt).
- **FastAPI Discussion #9097** — <https://github.com/fastapi/fastapi/discussions/9097> — global DB
  pool on `app.state`, `asyncpg.create_pool` + `pool.close`.
- **zhanymkanov/fastapi-best-practices** — <https://github.com/zhanymkanov/fastapi-best-practices> —
  the `src/<domain>/{router,schemas,service,...}` package-by-feature structure, "didn't scale for our
  monolith," thin-router/fat-service, split config across domains, SQL-first repositories.
- **httpx — Resource Limits** — <https://www.python-httpx.org/advanced/resource-limits/> — `DEFAULT_LIMITS`
  (`max_connections=100, max_keepalive_connections=20, keepalive_expiry=5.0`).
- **httpx Discussion #1552** — <https://github.com/encode/httpx/discussions/1552> — single long-lived
  client, shared connection pool, close on shutdown.
- **PyPI — fastapi** — <https://pypi.org/project/fastapi/> — 0.138.0 latest, 2026-06-20.

> **Confidence:** HIGH on the lifespan signature, `on_event` deprecation, `include_router` semantics,
> sub-app lifespan caveat, and the httpx/asyncpg patterns — all from primary docs/source read this
> session. MEDIUM on exact pool-sizing numbers (`max_size=10` etc.) — those are tier-dependent
> starting points to tune against the real `max_connections` and PgBouncer topology, not absolutes.
> Deep connection-layer specifics (asyncpg vs psycopg vs SQLAlchemy, COPY, Alembic) belong to the
> sibling `timescaledb-timeseries` skill.
