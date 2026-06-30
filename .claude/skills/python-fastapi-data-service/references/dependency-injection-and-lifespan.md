# Dependency Injection & Lifespan — FastAPI for a long-lived data service

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (Python / FastAPI /
> data-engineering). **NOT Lumina** (Lumina is Bun + Express + Prisma + Upstash). This doc is
> builder-knowledge for the *new* Python service that fronts the TimescaleDB time-series warehouse and
> exposes pricing/analytics endpoints to the agent and to internal callers.
>
> **Scope of this file:** FastAPI's dependency-injection (DI) system *in depth* for a service — the
> `Depends()` graph, request-scoped caching, `yield` setup/teardown deps, reading `app.state`
> singletons from a dependency, class-based / parametrised deps — and the **lifespan-vs-`Depends`
> split** that is the spine of resource management: lifespan owns app-lived singletons (the connection
> pool, the shared HTTP client, the settings cache); `Depends` owns per-request resources (the DB
> session, the current user, the per-request transaction). The last third is the **`dependency_overrides`
> test seam** — the reason you build the service this way in the first place.
>
> **Pinned versions (verified June 2026):**
> - **FastAPI 0.138.0** — released 2026-06-20 ([PyPI](https://pypi.org/project/fastapi/)). Built on
>   Starlette; `app.state` / `request.app.state` / lifespan-state are Starlette features FastAPI re-exports.
> - **Dependency `scope=` parameter** (`scope="function"` vs `scope="request"` on `yield` deps) — added
>   in **FastAPI 0.121.0** (Nov 2025), [PR #14262](https://github.com/fastapi/fastapi/pull/14262). It
>   resolves the 0.106 → 0.118 churn over *when* `yield`-dep teardown runs. **Confirm the installed
>   version is ≥ 0.121** before using `scope=`; on older versions teardown timing is fixed, not
>   selectable.
> - **Pydantic 2.x / pydantic-settings 2.x** for `BaseSettings`.
> - **httpx ≥ 0.27** for `AsyncClient`; **asyncpg / psycopg 3 / SQLAlchemy 2.x async** for the DB session
>   (covered by sibling references; here we only show the *seams*, not the driver internals).

---

## Why DI is the load-bearing decision for this service (the one-paragraph thesis)

A market-data / pricing service is a thin, hot, I/O-bound shell over slow upstreams (the TimescaleDB
warehouse, a market-data vendor, a cache). Every request needs: a DB session scoped to *this* request,
a shared HTTP client that must **not** be created per request (TLS + pool warm-up is expensive), a
settings object loaded **once**, and an authenticated caller. FastAPI's DI is how you wire those four
things so that (a) singletons live exactly as long as the process, (b) per-request resources are created
and torn down deterministically *per request*, and (c) **every one of them is a single function you can
swap in a test** via `app.dependency_overrides`. Get the lifespan-vs-`Depends` split wrong and you
either leak connections (a per-request pool), or share a non-thread-safe session across requests (an
app-lived session), or build a service you cannot test without a live database. The whole rest of this
file is the mechanism for getting that split right.

---

## Part 1 — `Depends()` basics: typed injection

A FastAPI dependency is **any callable** — a function, an `async` function, a class, or a callable
instance — that you wrap in `Depends()` and attach to a parameter. FastAPI calls it, takes the return
value, and passes it to your path operation as that parameter
([tutorial/dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/): *"FastAPI will… call your
dependency function with the correct parameters, get the result… assign that result to the parameter in
your path operation function"*).

```python
from typing import Annotated
from fastapi import Depends, FastAPI

app = FastAPI()

async def common_parameters(
    q: str | None = None, skip: int = 0, limit: int = 100
) -> dict:
    return {"q": q, "skip": skip, "limit": limit}

@app.get("/items/")
async def read_items(commons: Annotated[dict, Depends(common_parameters)]):
    return commons
```

Source verbatim: [tutorial/dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/).

### Three things that bite

1. **Pass the callable, do not call it.** `Depends(common_parameters)` — *no* parentheses.
   `Depends(common_parameters())` would call it at import time and pass the *result* as the dependency,
   which is almost never what you want.

2. **Use `Annotated`, not the default-value form.** The docs state the `Annotated` form is preferred
   and that the older `commons: dict = Depends(common_parameters)` form still works
   ([tutorial/dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/)). `Annotated` is
   strictly better here because the dependency lives in the *type*, not the *default*, so the same
   `Annotated[...]` alias is reusable on a path op, on another dependency, and on a `dependencies=[...]`
   list — and your editor/`mypy` sees the real return type. **House rule for this service:** all deps
   are `Annotated`.

3. **The dependency's own signature is itself injected.** `common_parameters` declares `q/skip/limit`;
   FastAPI treats those as query params of the endpoint, validates them, and shows them in OpenAPI. A
   dependency is a first-class request-parsing unit, not just a value provider.

### The reusable type alias — the single most important ergonomic

```python
# deps.py
from typing import Annotated
from fastapi import Depends

CommonsDep = Annotated[dict, Depends(common_parameters)]
```

```python
# routes.py
@app.get("/items/")
async def read_items(commons: CommonsDep):  # type preserved, autocompletion works
    return commons
```

Source: [tutorial/dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/) — *"you can create
a type alias… and use it across multiple places… This is especially useful if you use it in a lot of
endpoints."* Build every dependency in this service as a `…Dep` alias in `deps.py`. The endpoint then
reads `def quote(symbol: str, db: SessionDep, user: CurrentUser)` — three injected resources, zero
boilerplate, and each is a name you can override in a test.

### Sync vs async path-op / dependency interop

A dependency can be `async def` while the path op is `def`, or vice versa, in any combination — FastAPI
handles the mix ([tutorial/dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/)). **But**
that flexibility hides a performance cliff, covered in Part 8: a *sync* dependency on the hot path runs
in a threadpool. For this I/O-bound service, default to `async def` deps.

---

## Part 2 — The lifespan-vs-`Depends` split (the spine)

This is the single most important architectural decision in the service. State the rule plainly:

| | **Lifespan** | **`Depends` (per-request)** |
|---|---|---|
| **Lives for** | the whole process (one warmup, one teardown) | one request (created on entry, torn down on exit) |
| **Owns** | the connection **pool**, the shared **HTTP client**, the **settings** cache, a loaded model, a Redis client | a DB **session/connection** checked out of the pool, the **current user**, a per-request transaction, a request-scoped span |
| **Mechanism** | `@asynccontextmanager` passed as `FastAPI(lifespan=…)` | a `yield` dependency, or a plain dependency that *reads* a singleton out of `app.state` |
| **Cardinality** | 1 per process | N per request-rate |
| **Cost of getting it wrong** | per-request pool/client = TLS + handshake on every call; a model reloaded per request | a session shared across requests (data corruption, "this Session is already bound"); a leaked connection |

The rule, said once: **expensive-to-create, safe-to-share, long-lived → lifespan singleton.
Cheap-to-create, unsafe-to-share, request-bound → `Depends`.** A connection *pool* is the singleton; a
*connection out of* that pool is per-request. An `httpx.AsyncClient` (which *is* a pool of keep-alive
connections) is the singleton; a single HTTP *call* is per-request use of it.

### 2a. Lifespan: the canonical shape

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ---- startup: runs ONCE before the app serves any request ----
    app.state.pool = await create_pool(settings.database_url)        # DB connection pool
    app.state.http = httpx.AsyncClient(timeout=10.0)                  # shared HTTP client
    app.state.settings = settings                                    # already-loaded settings
    yield
    # ---- shutdown: runs ONCE after the app stops serving ----
    await app.state.http.aclose()
    await app.state.pool.close()

app = FastAPI(lifespan=lifespan)
```

The structure (setup before `yield`, app runs at `yield`, teardown after `yield`) is the official
pattern: *"the code before the `yield` will be executed before the application starts taking requests…
the code after the `yield` will be executed after the application has finished handling requests"*
([advanced/events](https://fastapi.tiangolo.com/advanced/events/)). It is the ASGI Lifespan Protocol
([asgi.readthedocs.io/.../lifespan](https://asgi.readthedocs.io/en/latest/specs/lifespan.html)).

Official minimal example (verbatim, [advanced/events](https://fastapi.tiangolo.com/advanced/events/)):

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

> **Do not use `@app.on_event("startup")` / `@app.on_event("shutdown")`.** They are deprecated, and *"if
> you define a `lifespan`… `startup` and `shutdown` handlers won't be called"*
> ([advanced/events](https://fastapi.tiangolo.com/advanced/events/)). `lifespan` is one function for
> both ends, so a resource and its cleanup sit next to each other — you cannot create a pool in one
> handler and forget to close it in a far-away other one.

> **Lifespan runs only for the main app, not for mounted sub-apps**
> ([advanced/events](https://fastapi.tiangolo.com/advanced/events/)). If this service mounts a sub-app,
> that sub-app's lifespan does **not** fire automatically — wire it through the parent.

### 2b. Two ways to hand a singleton to a request — and which to use

**Way A — `app.state` (recommended for this service).** Store the singleton on `app.state` in lifespan;
a tiny dependency reads it off `request.app.state`:

```python
from fastapi import Request
import httpx

def get_http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http          # the ONE client created in lifespan

HttpDep = Annotated[httpx.AsyncClient, Depends(get_http)]

@app.get("/quote/{symbol}")
async def quote(symbol: str, http: HttpDep):
    r = await http.get(f"https://vendor/quote/{symbol}")
    return r.json()
```

`app.state` holds the original reference for the whole process; *"objects attached to `app.state` are
lifespan-scoped for each FastAPI worker process and should be closed in the shutdown phase, and can
persist across many requests for the lifetime of the server"*
([sqlpey](https://sqlpey.com/python/fastapi-state-management-app-vs-request-state/)). Reading it through
a dependency (not by touching `request.app.state` inside every handler) keeps endpoints clean and —
critically — gives you a **named seam** (`get_http`) to override in tests.

**Way B — lifespan *state dict* (yield a dict).** Instead of `app.state`, the lifespan can `yield` a
dict; Starlette copies it onto `request.state` for every request:

```python
from typing import TypedDict
from contextlib import asynccontextmanager

class State(TypedDict):
    pool: Pool
    http: httpx.AsyncClient

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient() as http:
        pool = await create_pool(...)
        yield {"pool": pool, "http": http}     # -> request.state.pool / request.state.http
        await pool.close()

def get_http(request: Request) -> httpx.AsyncClient:
    return request.state.http
```

*"When using a lifespan context manager, you can yield a dictionary to populate `request.state`… if you
yield `{"notification_handler": client}` you access it as `request.state.notification_handler`"*
([search summary, FastAPI lifespan docs + Medium](https://fastapi.tiangolo.com/advanced/events/)).

**Which?** For this service: **Way A (`app.state`)** as the default. The state-dict (Way B) gives each
request a *shallow copy* of the dict — *"`request.state` receives a shallow copy of the state dictionary
for every incoming request"* ([sqlpey](https://sqlpey.com/python/fastapi-state-management-app-vs-request-state/)).
For immutable singletons (a pool, a client) both are equivalent; `app.state` is one fewer concept and is
what most FastAPI codebases use. Use Way B only if you specifically want per-request copies of mutable
state (rare in a stateless data service). **Either way, the endpoint never reaches into state directly —
always through a `get_*` dependency, because that dependency is the test seam.**

### 2c. The full split, end to end (pool singleton + per-request session)

This is the canonical wiring for a DB-backed service. Pool in lifespan; session per request via `yield`.

```python
# db.py  — SQLAlchemy 2.x async; the same shape works for asyncpg/psycopg pools
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)

def make_engine(url: str):
    # engine == a connection pool. ONE per process.
    return create_async_engine(url, pool_size=20, max_overflow=10, pool_pre_ping=True)
```

```python
# main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession

@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = make_engine(settings.database_url)
    app.state.engine = engine
    app.state.sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    app.state.http = httpx.AsyncClient(timeout=10.0)
    yield
    await app.state.http.aclose()
    await engine.dispose()        # closes the pool

app = FastAPI(lifespan=lifespan)
```

```python
# deps.py  — per-request session, checked out of the singleton pool
from typing import Annotated, AsyncIterator
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker = request.app.state.sessionmaker
    async with sessionmaker() as session:        # checkout from pool
        yield session                            # injected into the endpoint
        # __aexit__ returns the connection to the pool (and rolls back if not committed)

SessionDep = Annotated[AsyncSession, Depends(get_session)]
```

```python
# routes.py
@app.get("/prices/{symbol}")
async def prices(symbol: str, db: SessionDep):
    rows = await db.execute(select(Price).where(Price.symbol == symbol))
    return rows.scalars().all()
```

Notice the symmetry: the **pool** (`engine`) is a lifespan singleton; the **session** is a `yield`
dependency that borrows from the pool for one request and returns it on the way out. This is the split,
made concrete. The `async with sessionmaker()` block is the teardown — covered in depth in Part 4.

---

## Part 3 — Request-scoped caching: a dependency used twice runs once

**The rule:** within a single request, FastAPI calls each distinct dependency **once** and reuses the
result everywhere it appears in that request's dependency graph. Official wording
([tutorial/dependencies/sub-dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/sub-dependencies/)):
*"if one of your dependencies is declared multiple times for the same path operation… FastAPI will call
that sub-dependency only once per request… and will save the returned value in a 'cache' and pass it to
all the 'dependants' that need it in that specific request."* The best-practices repo states it the same
way ([zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices):
*"FastAPI caches dependency's result within a request's scope by default"*).

"Distinct" = same callable **and** same call (same sub-args). The cache key is the dependency callable.

### Why this is the killer feature for a service: reusable validation chains

Because a dependency runs once per request and its result is shared, you can build **validation chains**
where each link is a dependency that (a) parses/validates and (b) returns a useful object — and stack
several path ops on the same chain with zero re-fetching. The best-practices repo's canonical example
([zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)):

```python
# valid_post_id hits the DB once; cached for the whole request.
async def valid_post_id(post_id: UUID4) -> dict[str, Any]:
    post = await service.get_by_id(post_id)
    if not post:
        raise PostNotFound()
    return post

# parse_jwt_data runs once; cached.
async def parse_jwt_data(
    token: str = Depends(OAuth2PasswordBearer(tokenUrl="/auth/token"))
) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, "JWT_SECRET", algorithms=["HS256"])
    except InvalidTokenError:
        raise InvalidCredentials()
    return {"user_id": payload["id"]}

# valid_owned_post reuses BOTH cached results — neither runs twice even if
# several deps below also depend on valid_post_id.
async def valid_owned_post(
    post: dict[str, Any] = Depends(valid_post_id),
    token_data: dict[str, Any] = Depends(parse_jwt_data),
) -> dict[str, Any]:
    if post["creator_id"] != token_data["user_id"]:
        raise UserNotOwner()
    return post
```

Apply to this service: `valid_symbol` (does this ticker exist in the warehouse?) → `valid_series`
(does the requested series exist for that symbol?) → `valid_window` (is the date range within the
licensed range?). A `/chart` endpoint depends on `valid_window`; a `/quote` endpoint depends on
`valid_series`. If `/chart` also separately depends on `valid_symbol`, the warehouse lookup still
happens once. **You get DRY validation that does not re-query.** That is the mechanism the global
R-SCALE rule wants on a list/lookup surface — no duplicate fetches per request.

### Turning the cache OFF: `use_cache=False`

Occasionally you need the dependency to run *every* time it appears (e.g. it returns a fresh nonce, a
new short-lived token, or a randomised shard pick). Set `use_cache=False`
([tutorial/dependencies/sub-dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/sub-dependencies/),
confirmed [issue #1635](https://github.com/fastapi/fastapi/issues/1635)):

```python
async def needy_dependency(
    fresh_value: Annotated[str, Depends(get_value, use_cache=False)],
):
    return {"fresh_value": fresh_value}
```

Default is `use_cache=True`. *"You only need `use_cache=False` when you specifically want the same
dependency executed multiple times within a single request"*
([sub-dependencies docs](https://fastapi.tiangolo.com/tutorial/dependencies/sub-dependencies/)). In a
data service this is rare — prefer caching. **The one historical gotcha:** `Security(...)` with
*different OAuth2 scopes* used to wrongly share one cache entry; fixed in
[PR #2945](https://github.com/fastapi/fastapi/pull/2945). On modern FastAPI the cache key accounts for
security scopes, so you don't normally need `use_cache=False` to disambiguate scoped security deps.

### The caching boundary — what it does NOT survive

- Caching is **per request**. The next request re-runs everything. It is *not* a cross-request cache —
  for that you need Redis / a `@lru_cache` on a pure function (see Part 7 for settings).
- Caching is keyed by the callable, not the value. Two *different* functions that both fetch the same
  user run twice. Share the *one* `get_current_user` dependency, not two look-alikes, to get the reuse.

---

## Part 4 — `yield` dependencies: per-request setup / teardown

A `yield` dependency is the per-request analogue of lifespan: code **before** `yield` is setup, the
yielded value is injected, code **after** `yield` (in a `finally`) is teardown. This is how a DB session
opens and closes per request.

Official pattern (verbatim,
[dependencies-with-yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)):

```python
async def get_db():
    db = DBSession()
    try:
        yield db
    finally:
        db.close()
```

### Execution timing — the part everyone gets wrong

- **Before `yield`** runs before the path operation.
- The yielded value is injected.
- **After `yield`** (the `finally`) runs — **by default, *after* the response is sent to the client**
  ([dependencies-with-yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/):
  *"the code after the `yield` statement is executed after the response has been delivered"*). It runs
  even on exceptions.

This default ("teardown after response") was itself a moving target — see Part 5 — and it has a real
consequence: **anything in the teardown block runs after the client already got the response**, so a
slow `db.close()` or a flush in teardown does not add to the client's perceived latency, *but* an
exception raised there cannot change the response the client already received.

### Always use `try/finally`; never swallow an exception

If your `yield` dep catches an exception, it **must** re-raise (or convert to `HTTPException`), or
FastAPI never learns the request failed
([dependencies-with-yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)):

```python
def get_username():
    try:
        yield "Rick"
    except InternalError:
        print("We don't swallow the internal error here, we raise again 😎")
        raise                                   # ✅ re-raise — client gets 500 + logs
```

```python
def get_username():
    try:
        yield "Rick"
    except OwnerError as e:
        raise HTTPException(status_code=400, detail=f"Owner error: {e}")   # ✅ convert
```

A bare `except: pass` here is the *worst* bug in the file: it converts a real failure into a silent
mystery (the F-class "swallowed error" anti-pattern). For this service, teardown that can fail (a commit)
goes in `finally`, and any business exception is re-raised.

### Transaction management via a yield dep (the pattern this service uses)

Commit on success, roll back on any exception — all in one place:

```python
async def get_tx(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker = request.app.state.sessionmaker
    async with sessionmaker() as session:
        try:
            yield session
            await session.commit()          # success path
        except Exception:
            await session.rollback()        # any failure rolls back
            raise                           # re-raise so the client sees the error
        # `async with` returns the connection to the pool either way

TxDep = Annotated[AsyncSession, Depends(get_tx)]
```

Writes use `TxDep` (commit/rollback semantics); pure reads use the plain `SessionDep` from Part 2c. For a
mostly-read analytics service, most endpoints take `SessionDep`; the few that ingest take `TxDep`.

### Sub-dependencies with `yield`: teardown is LIFO

When `yield` deps depend on each other, teardown runs in **reverse** order, and a parent still has access
to its child during its own teardown
([dependencies-with-yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)):

```python
async def dependency_a():
    dep_a = generate_dep_a()
    try:
        yield dep_a
    finally:
        dep_a.close()

async def dependency_b(dep_a: Annotated[DepA, Depends(dependency_a)]):
    dep_b = generate_dep_b()
    try:
        yield dep_b
    finally:
        dep_b.close(dep_a)                  # dep_a still alive here

async def dependency_c(dep_b: Annotated[DepB, Depends(dependency_b)]):
    dep_c = generate_dep_c()
    try:
        yield dep_c
    finally:
        dep_c.close(dep_b)                  # dep_b still alive here
```

**Setup order:** `a → b → c`. **Teardown order:** `c → b → a` (LIFO). FastAPI builds these from
`contextlib.asynccontextmanager` / `contextmanager` internally
([dependencies-with-yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)),
which is exactly why the unwind is stack-ordered — the same guarantee as nested `async with` blocks.

### `yield` deps work for both `async def` and `def`

`def get_db(): ...` (sync) and `async def get_db(): ...` both work; the sync one runs in a threadpool
(Part 8). For an async DB driver, the dep must be `async def` so it can `await` the session — covered
next.

---

## Part 5 — Teardown timing & `scope=` (FastAPI ≥ 0.121)

This is the subtle, version-sensitive part. The history
([PR #14262](https://github.com/fastapi/fastapi/pull/14262), confirmed in release notes):

- **≤ 0.106.0:** `yield`-dep teardown ran **before** the response was sent.
- **0.118.0:** changed so teardown runs **after** the response is sent. This broke a class of streaming
  responses, where the dep (e.g. the DB session feeding a `StreamingResponse` generator) was being closed
  too early under the *old* behaviour and the change was meant to fix exactly that — but it also meant a
  normal request's session now outlives the response.
- **0.121.0:** introduced the **`scope=`** parameter so you can **opt in** to either timing per
  dependency ([PR #14262](https://github.com/fastapi/fastapi/pull/14262)).

| `scope=` value | teardown runs… | use it for |
|---|---|---|
| `"request"` (**default**) | **after** the response is sent to the client | normal request resources; required when a `StreamingResponse` generator still needs the resource while streaming |
| `"function"` | **after the path op finishes but BEFORE the response is sent** | when you want the resource (e.g. DB session) definitely released before the response goes out — frees pool connections sooner under load |

Official semantics ([dependencies-with-yield, "Early exit and
scope"](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/) + PR #14262):

```python
def get_username():
    try:
        yield "Rick"
    finally:
        print("Cleanup up before response is sent")

@app.get("/users/me")
def get_user_me(username: Annotated[str, Depends(get_username, scope="function")]):
    return username
```

**Scope nesting constraint** (PR #14262 / docs): a `scope="request"` dependency may only have
`scope="request"` sub-dependencies; a `scope="function"` dependency may have **both** kinds. Rationale:
a request-scoped (longer-lived) parent must not depend on a function-scoped (shorter-lived) child that
would be torn down while the parent still needs it.

**Recommendation for this service:**

- **Default = `"request"`.** Leave it. It is the modern default and it is what `StreamingResponse`
  endpoints (chart streams, large CSV exports) require.
- **Use `scope="function"` for the DB session dep when (a) the endpoint is *not* streaming and (b) you
  are connection-pool-constrained under load.** Releasing the session before the (possibly large)
  response serialises and flushes returns a pool connection ~tens of ms sooner per request, which at
  100×/10,000× tiers measurably raises the effective pool throughput. Name the trade-off in code with a
  comment; don't cargo-cult it onto streaming endpoints (it would close the session mid-stream → "this
  Session is closed" error).
- **Pin the version.** `scope=` is a 0.121+ keyword. On older FastAPI it raises `TypeError`. Gate it
  behind your pinned `fastapi>=0.121` and confirm against the installed version this session.

> **Streaming + yield-dep historical trap:** before 0.121, a `StreamingResponse` whose generator used a
> `yield`-dep session could hit a closed session mid-stream (the source of
> [discussion #11444](https://github.com/fastapi/fastapi/discussions/11444)). On 0.121+ the default
> `scope="request"` keeps the session alive through the stream — this is the correct default and why you
> don't blanket-apply `scope="function"`.

---

## Part 6 — Reading `app.state` singletons from a dependency

The bridge between Part 2 (lifespan singletons) and Part 1 (Depends): a trivial dependency that reads a
singleton off `request.app.state` and returns it. This is the *only* sanctioned way endpoints touch a
singleton.

```python
from fastapi import Request
import httpx
from sqlalchemy.ext.asyncio import AsyncEngine

def get_http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http

def get_engine(request: Request) -> AsyncEngine:
    return request.app.state.engine

HttpDep   = Annotated[httpx.AsyncClient, Depends(get_http)]
EngineDep = Annotated[AsyncEngine, Depends(get_engine)]
```

Why a dependency and not `request.app.state.http` inline in every handler:

1. **It is the test seam.** `app.dependency_overrides[get_http] = lambda: fake_client` swaps the client
   everywhere at once (Part 9). Inline `request.app.state` access has no seam — you'd have to monkeypatch
   `app.state`, which is global and order-dependent.
2. **It centralises the type.** `HttpDep` is the type the whole codebase imports; if the client type
   changes you edit one line.
3. **It keeps endpoints declarative.** `def quote(symbol, http: HttpDep)` reads as a contract.

These deps are *sync* `def` on purpose — they do no I/O, just an attribute read, so there's no benefit to
`async` and FastAPI runs a trivial sync dep inline-cheaply (the threadpool cost in Part 8 matters for
sync deps that *block*; a one-line attribute getter doesn't block). If you prefer total uniformity, make
them `async def` — both are fine for a non-blocking getter. (House rule: keep getters sync, keep
I/O-doing deps async.)

`Request` is itself injectable — FastAPI recognises the `Request`-typed parameter and passes the live
request without a `Depends`. `request.app` is the `FastAPI` instance; `request.app.state` is the same
`app.state` you wrote in lifespan.

---

## Part 7 — Settings as a cached singleton + per-module decoupling

Settings (`pydantic-settings` `BaseSettings`) are read once and shared. Two correct patterns:

### 7a. `@lru_cache` factory (the idiomatic FastAPI way)

```python
# config.py
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    database_url: str
    vendor_api_key: str
    cache_url: str = "redis://localhost:6379"
    model_config = SettingsConfigDict(env_file=".env")

@lru_cache                      # parse env ONCE per process
def get_settings() -> Settings:
    return Settings()

SettingsDep = Annotated[Settings, Depends(get_settings)]
```

`@lru_cache` makes `get_settings()` parse the environment exactly once and return the same instance for
the life of the process — a process-wide singleton that is *also* a `Depends`-injectable dependency. This
is the FastAPI-docs-recommended settings pattern ([Settings and
Environment Variables](https://fastapi.tiangolo.com/advanced/settings/)). Because it's a dependency, a
test overrides it with `app.dependency_overrides[get_settings] = lambda: Settings(database_url="…test…")`
— **no env-var mutation, no monkeypatch.**

### 7b. Load in lifespan, store on `app.state`

If settings must drive lifespan itself (the DB URL is needed to build the pool *before* any request),
load them at the top of `lifespan` and stash on `app.state`; the dependency reads them like any other
singleton (Part 6). In practice you do both: `get_settings()` (lru_cache) is called inside `lifespan` to
build the pool, *and* exposed as `SettingsDep` for endpoints — one source of truth, two access paths.

### 7c. Decouple `BaseSettings` and deps per module

The best-practices repo and general structuring guidance: **do not** put one giant `Settings` and one
`deps.py` god-module for a multi-domain service. Split by domain
([zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices) project
structure guidance — module-per-domain with each module owning its `dependencies.py` / `config.py`):

```
service/
  config.py            # global Settings (db url, log level)
  db.py                # engine/sessionmaker factory
  deps.py              # global deps: get_session, get_http, get_settings, get_current_user
  pricing/
    config.py          # PricingSettings (vendor key, default ccy)  — nested BaseSettings
    dependencies.py    # valid_symbol, valid_series  — pricing-specific deps
    router.py
  analytics/
    dependencies.py    # valid_window, valid_resolution
    router.py
```

Each domain's `BaseSettings` can be a nested model on the root `Settings`, or its own `BaseSettings`
read from the same env. The win: the `pricing` module's deps don't import `analytics`, the test for
`pricing` overrides only `pricing`'s deps, and the dependency graph per domain is small and legible.

---

## Part 8 — Prefer async dependencies (the threadpool cost)

**The rule, verbatim** ([zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)):
*"Prefer `async` dependencies. … sync dependencies run in a threadpool, incurring unnecessary thread
overhead for small non-I/O operations."*

The mechanism: FastAPI/Starlette run the event loop on the main thread. An `async def` path op or
dependency runs **on the event loop**. A *sync* (`def`) path op or dependency is run in an
**`anyio` threadpool** (default cap ~40 worker threads) so it can't block the loop. That offload has a
real per-call cost (thread acquisition, context switch) and, worse, the **threadpool is a bounded
shared resource** — fill it with blocking sync deps and *new requests stall waiting for a free thread*,
which is a self-inflicted 100×-tier outage.

**Decision table for this I/O-bound service:**

| Dependency does… | Make it… | Why |
|---|---|---|
| `await`s the DB / HTTP / Redis | `async def` | runs on the loop; no thread; correct for async drivers |
| pure CPU-trivial (attribute read, dict build, header parse) | `async def` *or* `def` | either is cheap; prefer `async` for uniformity |
| a **blocking** call you can't avoid (a sync-only SDK, `time.sleep`, blocking `requests`) | `def` (so it offloads) — **but** prefer replacing the blocking lib with an async one | a blocking call in an `async def` dep freezes the **entire event loop** for every request — far worse than the threadpool |

The trap that ends most "why is my FastAPI slow" investigations: putting a **blocking** call inside an
`async def` (e.g. `requests.get(...)` or a sync DB driver) — it blocks the *single* event-loop thread,
serialising every concurrent request. Either make the dep `async` *with an async client* (best), or make
it `def` so Starlette offloads it. **For this service: every I/O dep is `async def` over an async driver
(asyncpg/psycopg-async, `httpx.AsyncClient`, async Redis).** No `requests`, no sync DB driver on the hot
path. ([Starlette threadpool / anyio behaviour;
[fastapi async docs](https://fastapi.tiangolo.com/async/) for the def-vs-async-def execution model.])

---

## Part 9 — `dependency_overrides`: the test seam (the whole point)

`app.dependency_overrides` is a plain `dict` mapping **original dependency → replacement**. When set,
FastAPI calls the replacement and **does not execute the original or its sub-dependencies**
([advanced/testing-dependencies](https://fastapi.tiangolo.com/advanced/testing-dependencies/)).

```python
app.dependency_overrides[original_dependency] = override_dependency
```

This is *why* every resource in this service is a named dependency: each is a key you can swap. **You do
not monkeypatch `app.state`, you do not patch `httpx`, you do not set env vars** — you override the
dependency.

Official example (verbatim,
[advanced/testing-dependencies](https://fastapi.tiangolo.com/advanced/testing-dependencies/)):

```python
from typing import Annotated
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

app = FastAPI()

async def common_parameters(q: str | None = None, skip: int = 0, limit: int = 100):
    return {"q": q, "skip": skip, "limit": limit}

@app.get("/items/")
async def read_items(commons: Annotated[dict, Depends(common_parameters)]):
    return {"message": "Hello Items!", "params": commons}

client = TestClient(app)

async def override_dependency(q: str | None = None):
    return {"q": q, "skip": 5, "limit": 10}

app.dependency_overrides[common_parameters] = override_dependency

def test_override_in_items():
    response = client.get("/items/")
    assert response.status_code == 200
    assert response.json() == {
        "message": "Hello Items!",
        "params": {"q": None, "skip": 5, "limit": 10},
    }
```

### Always clean up overrides — the pytest fixture pattern

Overrides are process-global state on `app`; a leaked override poisons later tests. Use a fixture that
sets and **clears** ([advanced/testing-dependencies](https://fastapi.tiangolo.com/advanced/testing-dependencies/)):

```python
import pytest

@pytest.fixture
def override_common_dependency():
    app.dependency_overrides[common_parameters] = override_dependency
    yield
    app.dependency_overrides = {}          # or app.dependency_overrides.clear()
```

Clear with either `app.dependency_overrides = {}` or `app.dependency_overrides.clear()`
([advanced/testing-dependencies](https://fastapi.tiangolo.com/advanced/testing-dependencies/)).

### The service test harness — override the three real seams

This is the payoff of the whole file. A test client where `get_session` hits a transactional test DB,
`get_http` returns a mock transport, and `get_settings` returns test config — all without touching the
real upstreams:

```python
# conftest.py
import pytest
import httpx
from fastapi.testclient import TestClient
from myservice.main import app
from myservice.deps import get_session, get_http, get_settings
from myservice.config import Settings

@pytest.fixture
def test_settings():
    return Settings(database_url="postgresql+asyncpg://…/test", vendor_api_key="test")

@pytest.fixture
async def test_session(test_settings):
    # build an engine bound to the test DB, hand out a session in a rolled-back tx
    engine = create_async_engine(test_settings.database_url)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        yield s
        await s.rollback()            # each test sees a clean DB
    await engine.dispose()

@pytest.fixture
def mock_http():
    # httpx MockTransport: deterministic vendor responses, zero network
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"price": 101.5})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))

@pytest.fixture
def client(test_settings, test_session, mock_http):
    app.dependency_overrides[get_settings] = lambda: test_settings
    app.dependency_overrides[get_session] = lambda: test_session
    app.dependency_overrides[get_http]    = lambda: mock_http
    with TestClient(app) as c:           # `with` runs lifespan in tests
        yield c
    app.dependency_overrides.clear()      # critical: no leak across tests
```

```python
def test_quote(client):
    r = client.get("/quote/AAPL")
    assert r.status_code == 200
    assert r.json()["price"] == 101.5     # came from the mock, no live vendor
```

Override notes ([advanced/testing-dependencies](https://fastapi.tiangolo.com/advanced/testing-dependencies/)):

- The override may have the **same or a different signature** than the original; FastAPI re-parses it,
  so the override can even *drop* params it doesn't need.
- Overrides work for deps used anywhere — path ops, routers, `dependencies=[...]` decorators.
- The original and its sub-deps are **not** executed when overridden — so overriding `get_session`
  means the real `get_engine`/pool code never runs in that test.

> **Use `with TestClient(app) as c:` (context-manager form) in tests** so the **lifespan runs** during
> the test (startup builds whatever singletons your *non-overridden* deps still read). The bare
> `TestClient(app)` form does **not** trigger lifespan
> ([FastAPI testing docs / Starlette TestClient](https://fastapi.tiangolo.com/advanced/testing-events/)).
> If you override every singleton-reading dep you can skip lifespan; if some endpoint still reads
> `app.state` directly, you need the `with` form.

---

## Part 10 — Class-based & parametrised dependencies

### 10a. A class as a dependency

A class is a callable; `Depends(CommonQueryParams)` instantiates it, treating `__init__` params as
request params (verbatim,
[classes-as-dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/classes-as-dependencies/)):

```python
class CommonQueryParams:
    def __init__(self, q: str | None = None, skip: int = 0, limit: int = 100):
        self.q = q
        self.skip = skip
        self.limit = limit

@app.get("/items/")
async def read_items(commons: Annotated[CommonQueryParams, Depends(CommonQueryParams)]):
    items = fake_items_db[commons.skip : commons.skip + commons.limit]
    return {"q": commons.q, "items": items}
```

**Shortcut:** when the type annotation already *is* the class, `Depends()` (empty) infers it
([classes-as-dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/classes-as-dependencies/)):

```python
async def read_items(commons: Annotated[CommonQueryParams, Depends()]):
    ...
```

Use a class dependency when the injected thing is a small typed bundle of request params (an attribute
object beats a `dict` for autocompletion). For this service: a `PageParams` class (`limit`, `cursor`,
`order`) shared across every list endpoint (screener, symbol search, predictions list).

### 10b. Parametrised dependency via a callable instance (`__call__`)

When you need the *same* dependency logic with *different config*, build a class with `__init__` (config)
+ `__call__` (the per-request logic), instantiate it once with config, and `Depends(instance)`
(verbatim, [advanced/advanced-dependencies](https://fastapi.tiangolo.com/advanced/advanced-dependencies/)):

```python
class FixedContentQueryChecker:
    def __init__(self, fixed_content: str):
        self.fixed_content = fixed_content        # FastAPI does NOT call __init__

    def __call__(self, q: str = ""):              # FastAPI inspects/ calls __call__
        if q:
            return self.fixed_content in q
        return False

checker = FixedContentQueryChecker("bar")         # you instantiate, with config

@app.get("/query-checker/")
async def read_query_check(
    fixed_content_included: Annotated[bool, Depends(checker)],   # pass the INSTANCE
):
    return {"fixed_content_in_query": fixed_content_included}
```

`__init__` = config (you call it); `__call__` = request logic (FastAPI calls it, parsing its signature
as request params) ([advanced/advanced-dependencies](https://fastapi.tiangolo.com/advanced/advanced-dependencies/)).

**Service use — a parametrised role/scope guard (dependency factory):**

```python
class RequireScope:
    def __init__(self, scope: str):
        self.scope = scope

    async def __call__(self, user: "CurrentUser") -> None:
        if self.scope not in user.scopes:
            raise HTTPException(status_code=403, detail=f"missing scope {self.scope}")

require_pricing = RequireScope("pricing:read")
require_ingest  = RequireScope("ingest:write")

@app.get("/quote/{symbol}", dependencies=[Depends(require_pricing)])   # no return value used
async def quote(symbol: str, db: SessionDep): ...

@app.post("/ingest", dependencies=[Depends(require_ingest)])
async def ingest(rows: list[Row], db: TxDep): ...
```

One class, many configured guards — no copy-pasted `if scope not in …` per endpoint. This is the
canonical FastAPI way to parametrise a dependency (its own security utilities use the `__call__` pattern,
per [advanced-dependencies](https://fastapi.tiangolo.com/advanced/advanced-dependencies/)).

---

## Part 11 — `dependencies=[...]`: side-effect deps whose return value you don't need

When a dependency is used purely for its **side effect** (auth check, rate-limit, audit), and you don't
need its return value as a parameter, attach it via the `dependencies=[...]` list at path, router, or app
level (verbatim, [global-dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/global-dependencies/)
and [dependencies-in-path-operation-decorators](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-in-path-operation-decorators/)):

```python
# app-wide: every endpoint requires these headers
async def verify_token(x_token: Annotated[str, Header()]):
    if x_token != settings.api_token:
        raise HTTPException(status_code=400, detail="X-Token header invalid")

app = FastAPI(dependencies=[Depends(verify_token)])

# router-wide: every pricing endpoint requires the pricing scope
from fastapi import APIRouter
pricing = APIRouter(prefix="/pricing", dependencies=[Depends(require_pricing)])

# single endpoint:
@app.get("/items/", dependencies=[Depends(verify_token)])
async def read_items(): ...
```

Three levels ([global-dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/global-dependencies/)):

- `FastAPI(dependencies=[...])` → applies to **all** path operations (global auth/headers).
- `APIRouter(dependencies=[...])` → applies to a **group** (all pricing endpoints share a scope check).
- `@app.get(..., dependencies=[...])` → applies to **one** endpoint.

Return values from `dependencies=[...]` deps are **not** injected — *"when dependencies are added via the
`dependencies=` parameter (rather than as function parameters), their return values are not needed"*
([global-dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/global-dependencies/)). They
can still `raise HTTPException` to reject the request — which is the whole point for guards. (They *are*
still request-cached, so a `dependencies=[Depends(parse_jwt_data)]` guard and a parameter
`user: CurrentUser` that also uses `parse_jwt_data` share one decode.)

**Service router layout:**

```python
# main.py
from fastapi import FastAPI, Depends
from .deps import verify_token
from .pricing.router import router as pricing_router
from .analytics.router import router as analytics_router

app = FastAPI(lifespan=lifespan, dependencies=[Depends(verify_token)])  # global gate
app.include_router(pricing_router)     # router carries its own scope dep
app.include_router(analytics_router)
```

---

## Part 12 — The `CurrentUser` chain (per-request auth as a dependency)

Auth is the textbook per-request dependency chain: `oauth2_scheme` (extract bearer) → `get_current_user`
(decode + DB lookup) → `get_current_active_user` (status check), each cached per request
([security/get-current-user](https://fastapi.tiangolo.com/tutorial/security/get-current-user/)):

```python
# deps.py
from typing import Annotated
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/token")

async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    db: SessionDep,
) -> User:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        user_id = payload["sub"]
    except (InvalidTokenError, KeyError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Could not validate credentials")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return user

async def get_current_active_user(
    user: Annotated[User, Depends(get_current_user)],
) -> User:
    if user.disabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Inactive user")
    return user

CurrentUser = Annotated[User, Depends(get_current_active_user)]
```

```python
# any route
@app.get("/me")
async def me(user: CurrentUser):
    return user
```

The reusable alias `CurrentUser = Annotated[User, Depends(get_current_active_user)]` is the recommended
pattern ([security/get-current-user](https://fastapi.tiangolo.com/tutorial/security/get-current-user/));
*"create a type alias… `CurrentUser = Annotated[models.User, Depends(get_current_user)]`… use it
throughout your application for cleaner code"* (search summary of the same docs). Three facts that matter:

- **Per-request caching** means `get_current_user` runs once even if five deps and the endpoint all use
  `CurrentUser` — one JWT decode, one DB lookup per request (Part 3).
- **`userId` comes from the verified token, never from the request body / query** — the F-class
  "secure args by closure / verified identity" rule. The endpoint receives a `User`, not a client-supplied
  id. (This mirrors Lumina's non-negotiable #6, but here it's enforced by the auth dependency owning the
  identity.)
- **Test it by overriding the chain's top:** `app.dependency_overrides[get_current_active_user] =
  lambda: fake_user` — no token minting in tests.

---

## Decision table — which mechanism for which resource

| Resource | Mechanism | `scope` / cache | Test seam |
|---|---|---|---|
| DB connection **pool** / engine | **lifespan** singleton on `app.state` | n/a (process-lived) | override the *session* dep, not the pool |
| DB **session** (read) | `yield` dep `get_session` | default `request`; consider `function` if pool-bound & non-streaming | `dependency_overrides[get_session]` → rolled-back test session |
| DB **session** (write/tx) | `yield` dep `get_tx` (commit/rollback) | as above | same |
| shared **HTTP client** (`AsyncClient`) | **lifespan** singleton on `app.state`, read via `get_http` | request-cached getter | `dependency_overrides[get_http]` → `MockTransport` client |
| **settings** | `@lru_cache get_settings` (process singleton) + `Depends` | cached forever | `dependency_overrides[get_settings]` |
| **current user** | per-request chain `get_current_user` → … | request-cached (runs once) | `dependency_overrides[get_current_active_user]` |
| **validation** (symbol/window exists) | per-request `valid_*` `Depends` chain | request-cached (no double-fetch) | override the `valid_*` dep |
| **auth/scope guard** (no return) | `dependencies=[Depends(require_scope)]` | request-cached | override `require_scope` |
| Redis client | **lifespan** singleton on `app.state`, read via `get_redis` | request-cached getter | `dependency_overrides[get_redis]` → fakeredis |

---

## Anti-patterns (mistake → fix)

| Mistake | Why it breaks | Fix |
|---|---|---|
| New `AsyncClient()` / new pool **per request** (inside the endpoint or a `Depends` that constructs it) | TLS handshake + pool warm-up every call; connection/file-descriptor exhaustion at load | Create **once** in lifespan → `app.state` → read via `get_http`/`get_engine` dep |
| DB **session** created in **lifespan** and shared across requests | a `Session` is not concurrency-safe; cross-request data bleed, "Session already bound" | Pool in lifespan; **session per request** via a `yield` dep |
| Blocking call (`requests.get`, sync DB driver, `time.sleep`) inside an `async def` dep/endpoint | freezes the **single event-loop thread** → every concurrent request stalls | use an **async** client; or make the dep `def` so Starlette offloads to the threadpool ([fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)) |
| `except: pass` (or catch-without-reraise) in a `yield` dep | FastAPI never learns the request failed → silent 500, no logs | **re-raise** or convert to `HTTPException` ([dependencies-with-yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)) |
| Reading `request.app.state.http` **inline** in every handler | no test seam → forces monkeypatching global `app.state` | wrap in a `get_http` dependency → override it |
| Monkeypatching modules / setting env vars in tests | brittle, order-dependent, doesn't cover sub-deps | `app.dependency_overrides[dep] = fake` ([testing-dependencies](https://fastapi.tiangolo.com/advanced/testing-dependencies/)) |
| Forgetting to **clear** `dependency_overrides` after a test | global state leaks → later tests fail mysteriously | fixture that `yield`s then `app.dependency_overrides.clear()` |
| `TestClient(app)` (bare) when an endpoint reads `app.state` | **lifespan never runs** → `app.state.x` is unset → `AttributeError` | use `with TestClient(app) as c:` *or* override every singleton-reading dep |
| Two near-identical deps that both fetch the user | request cache keys on the **callable** → fetches twice | share **one** `get_current_user` dep |
| `scope="function"` on a `StreamingResponse`'s session dep | session closes before the stream finishes → "Session is closed" mid-stream | keep default `scope="request"` for streaming endpoints ([PR #14262](https://github.com/fastapi/fastapi/pull/14262)) |
| `@app.on_event("startup")` in new code | deprecated; silently ignored if a `lifespan` exists | use the `lifespan` context manager ([advanced/events](https://fastapi.tiangolo.com/advanced/events/)) |
| Calling the dependency: `Depends(get_db())` | runs at import, injects the *result* not the callable | pass the callable: `Depends(get_db)` |
| One god `deps.py` / one mega `Settings` for the whole service | every domain test drags in every dep; huge graph | per-domain `dependencies.py` + nested `BaseSettings` ([fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)) |
| `scope=` used on FastAPI < 0.121 | keyword doesn't exist → `TypeError` | pin `fastapi>=0.121`; verify installed version |

---

## R-SCALE notes (this surface, the three tiers)

DI/lifespan is the *substrate* under the scale surfaces; getting it right is what lets the lists/search/
ingest surfaces scale at all.

- **1× (demo):** any wiring works; even a per-request client "feels" fine on one user.
- **100× (traction):** the cliffs bite. A per-request `AsyncClient` or pool exhausts file descriptors;
  a blocking call in an `async def` serialises the whole worker; an unindexed `valid_symbol` dep that
  re-queries (because two look-alike deps defeat the request cache) doubles DB load. **Fix at this tier:**
  one lifespan pool + one shared `AsyncClient`; all I/O deps `async`; validation chains share one cached
  dep so each request hits the warehouse once per fact.
- **10,000× (spike day):** pool sizing and connection-hold time dominate. This is where
  `scope="function"` on non-streaming read sessions earns its keep (release the pooled connection ~tens
  of ms sooner per request → higher effective pool throughput), and where the settings/`lru_cache`
  singleton matters (no env re-parse per request). Heavy ingest never runs on a request-path dep — it's a
  worker/cron job hitting the warehouse directly (sibling `timescaledb-timeseries` reference owns the
  COPY/bulk path). DI's job at this tier is to make every request **borrow** from process-lived singletons
  and **return** them deterministically — which is exactly the lifespan-vs-`Depends` split this file is
  about.

---

## Sources (primary, read this session — June 2026)

- **FastAPI — Dependencies (tutorial):** <https://fastapi.tiangolo.com/tutorial/dependencies/> — `Depends()`
  basics, `Annotated`, type aliases, no-parentheses rule, sync/async interop.
- **FastAPI — Sub-dependencies:** <https://fastapi.tiangolo.com/tutorial/dependencies/sub-dependencies/> —
  per-request caching ("called only once per request"), `use_cache=False`.
- **FastAPI — Classes as dependencies:**
  <https://fastapi.tiangolo.com/tutorial/dependencies/classes-as-dependencies/> — class deps, `Depends()`
  shortcut.
- **FastAPI — Advanced dependencies:** <https://fastapi.tiangolo.com/advanced/advanced-dependencies/> —
  parametrised `__call__` instances; `scope=` cross-reference.
- **FastAPI — Dependencies with yield:**
  <https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/> — setup/teardown timing,
  re-raise rule, LIFO sub-dep teardown, `scope="function"` vs `"request"`.
- **FastAPI — Global / decorator dependencies:**
  <https://fastapi.tiangolo.com/tutorial/dependencies/global-dependencies/> and
  <https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-in-path-operation-decorators/> —
  `dependencies=[...]`, return-value-not-needed.
- **FastAPI — Testing dependencies:** <https://fastapi.tiangolo.com/advanced/testing-dependencies/> —
  `app.dependency_overrides` dict, override syntax, clear via `{}` / `.clear()`, fixture pattern.
- **FastAPI — Lifespan Events:** <https://fastapi.tiangolo.com/advanced/events/> — `@asynccontextmanager`
  lifespan, ML-model example, deprecated `on_event`, main-app-only, ASGI lifespan protocol.
- **FastAPI — Settings:** <https://fastapi.tiangolo.com/advanced/settings/> — `@lru_cache get_settings`
  singleton pattern.
- **FastAPI — Get Current User (security):**
  <https://fastapi.tiangolo.com/tutorial/security/get-current-user/> — the `get_current_user` chain,
  `CurrentUser` type alias.
- **PR #14262 — dependency `scope=`:** <https://github.com/fastapi/fastapi/pull/14262> — `scope="function"`
  vs `"request"`, the 0.106 → 0.118 → 0.121 history, sub-dependency scope constraint.
- **zhanymkanov/fastapi-best-practices:** <https://github.com/zhanymkanov/fastapi-best-practices> —
  "prefer async dependencies" (threadpool overhead), dependency chains/reuse, request-scoped caching,
  per-module decoupling, validation-in-deps examples.
- **PR #2945 (cached security scopes):** <https://github.com/fastapi/fastapi/pull/2945> and
  [issue #1635](https://github.com/fastapi/fastapi/issues/1635) — `use_cache` interaction with `Security`
  scopes.
- **State management — `app.state` vs `request.state`:**
  <https://sqlpey.com/python/fastapi-state-management-app-vs-request-state/> — lifespan-scoped `app.state`,
  shallow-copy `request.state`.
- **ASGI Lifespan spec:** <https://asgi.readthedocs.io/en/latest/specs/lifespan.html> — the protocol behind
  `lifespan`.
- **Version pin:** FastAPI **0.138.0**, 2026-06-20 — <https://pypi.org/project/fastapi/>.
