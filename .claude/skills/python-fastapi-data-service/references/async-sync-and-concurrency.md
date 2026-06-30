# theory · async/sync route discipline & the AnyIO threadpool

> **Scope.** The single highest-blast-radius performance-correctness topic in a FastAPI data
> service: when to write `async def` vs `def`, how FastAPI runs each, the AnyIO worker threadpool
> (default **40** threads) that backs `def` routes, the event-loop-stall failure mode (one blocking
> call inside an `async def` freezes *every* concurrent request on that worker), the escape hatches
> (`run_in_threadpool` / `anyio.to_thread.run_sync`) for one-off sync calls inside async code, tuning
> the threadpool limiter, and the iron rule that CPU-bound work goes **off-process** — never on the
> loop, never silently eating threadpool slots.
>
> **Product line.** This is the **JPM-Markets re-engineering data-analytics product line (NOT
> Lumina)** — a greenfield Python / FastAPI / data-engineering service (asyncpg/TimescaleDB,
> httpx upstreams, pandas/numpy compute). Lumina is the Bun/Express/TypeScript app and is unrelated.
> Citations here point at upstream library source + primary docs; there is no in-repo `file:line`
> yet — this is a design/recipe reference for code not yet written.
>
> **Versions pinned this research (June 2026, latest on PyPI):**
> `fastapi==0.138.0` (2026-06-20) · `starlette==1.3.1` (2026-06-12) · `anyio==4.14.0` (2026-06-15) ·
> `httpx==0.28.1` (2024-12-06). Verify with `pip show fastapi starlette anyio httpx` before relying
> on a line number — FastAPI re-exports Starlette's `run_in_threadpool`, and Starlette wraps AnyIO,
> so the behavior chain is `FastAPI → Starlette → AnyIO → asyncio`.
> Source: <https://pypi.org/pypi/fastapi/json> etc.

---

## 0. The one-paragraph mental model (read this first)

A FastAPI app runs on **one event loop per worker process** (Uvicorn worker). That single thread
runs the loop. When you declare a route `async def`, FastAPI **calls it directly on the loop and
`await`s it** — so the moment your code does anything blocking (a synchronous DB driver call,
`requests.get`, `time.sleep`, a 200 ms pandas `groupby`), **the loop cannot advance any other task**:
every other in-flight request on that worker is frozen until your blocking line returns. When you
declare a route plain `def`, FastAPI does **not** call it on the loop — it ships it to the **AnyIO
worker threadpool** (default cap **40** threads) and `await`s the thread's completion, so blocking
there is harmless to the loop. The entire discipline reduces to one sentence:

> **Write `async def` ONLY if every blocking operation in that function (and its dependencies) is
> `await`ed against a genuinely non-blocking library. If anything blocks and isn't `await`ed, write
> `def` — or push that one call through `run_in_threadpool`.**

Get this wrong in *one* hot route and your p99 latency collapses under concurrency while CPU sits
near-idle: the classic "FastAPI is slow" incident that is never FastAPI's fault.

---

## 1. What FastAPI actually does — the dispatch, in source

FastAPI does not guess from your code style; it **introspects the callable** and branches. The
branch lives in `run_endpoint_function`.

### 1.1 `run_endpoint_function` — the fork

```python
# fastapi/routing.py  (fastapi==0.138.0, master)  lines 336–346
async def run_endpoint_function(
    *, dependant: Dependant, values: dict[str, Any], is_coroutine: bool
) -> Any:
    # Only called by get_request_handler. Has been split into its own function to
    # facilitate profiling endpoints, since inner functions are harder to profile.
    assert dependant.call is not None, "dependant.call must be a function"

    if is_coroutine:
        return await dependant.call(**values)              # ← async def: run ON the loop
    else:
        return await run_in_threadpool(dependant.call, **values)  # ← def: ship to threadpool
```

Source (read it, do not recall it):
<https://github.com/fastapi/fastapi/blob/master/fastapi/routing.py> — the `if is_coroutine:` branch
calls your coroutine directly and `await`s it; the `else` branch hands the plain function to
`run_in_threadpool`. That is the whole mechanism. There is no third path.

The official docs state the same in prose:

> "When you declare a *path operation function* with normal `def` instead of `async def`, it is run
> in an external threadpool that is then awaited, instead of being called directly (as it would block
> the server)."
> — <https://fastapi.tiangolo.com/async/>

> "The same applies for dependencies. If a dependency is a standard `def` function instead of
> `async def`, it is run in the external threadpool."
> — <https://fastapi.tiangolo.com/async/> (so a *blocking dependency* also gets a thread — and a
> blocking `async def` dependency does **not**; see §6).

### 1.2 `is_coroutine` is computed by introspection, and it unwraps `functools.partial`

`is_coroutine` comes from `dependant.is_coroutine_callable`, a `@cached_property` on the `Dependant`
model that uses `inspect.iscoroutinefunction` against the callable, **after stripping any
`functools.partial` wrappers** and after checking a `__call__` dunder:

```python
# fastapi/dependencies/models.py  (paraphrased shape; read source for exact lines)
def _impartial(func):
    while isinstance(func, partial):
        func = func.func
    return func

@cached_property
def is_coroutine_callable(self) -> bool:
    if inspect.isroutine(_impartial(self.call)) and iscoroutinefunction(_impartial(self.call)):
        return True
    # ... also checks self.call.__call__ for callable instances ...
```

Source: <https://github.com/fastapi/fastapi/blob/master/fastapi/dependencies/models.py>

**Why this matters in practice:**

- A **`functools.partial` of an `async def`** is still detected as a coroutine (partial is unwrapped),
  so it runs on the loop — good.
- An **`async def` that is actually blocking** (you `await`ed nothing, or you `await`ed a fake-async
  wrapper) is **still detected as a coroutine** and **still runs on the loop**. FastAPI cannot know
  your "async" function blocks; the type system says coroutine, so it trusts you. **The detection is
  syntactic, not behavioral.** This is exactly why the discipline is a *human* rule, not a thing the
  framework enforces.
- A **callable class instance** with an `async def __call__` is detected as async. A sync
  `__call__` → threadpool.

### 1.3 The call chain, fully resolved

```
Uvicorn worker  →  one asyncio event loop (one OS thread runs it)
   └─ ASGI app (FastAPI/Starlette)
        └─ get_request_handler  →  run_endpoint_function(is_coroutine=?)
             ├─ is_coroutine = True   →  await your_coro(**values)           [ON THE LOOP]
             └─ is_coroutine = False  →  await run_in_threadpool(your_fn)    [OFF THE LOOP → AnyIO]
                                              └─ starlette.concurrency.run_in_threadpool
                                                   └─ anyio.to_thread.run_sync(func)
                                                        └─ acquires a token from CapacityLimiter(40)
                                                        └─ runs func in a worker thread
                                                        └─ result/exception marshalled back to loop
```

---

## 2. `run_in_threadpool` and the AnyIO bridge — the exact source

### 2.1 Starlette's `run_in_threadpool` (what FastAPI re-exports)

```python
# starlette/concurrency.py  (starlette==1.3.1, master)
import functools
import anyio.to_thread

async def run_in_threadpool(func: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    func = functools.partial(func, *args, **kwargs)
    return await anyio.to_thread.run_sync(func)
```

Source: <https://github.com/encode/starlette/blob/master/starlette/concurrency.py>

Two facts to internalize:

1. It binds positional + keyword args into a `functools.partial` because
   `anyio.to_thread.run_sync(func, *args)` only forwards **positional** args — kwargs must be
   pre-bound. (If you call AnyIO directly, you have the same constraint: bind kwargs yourself.)
2. It uses **the default limiter** (no `limiter=` passed) → the shared `CapacityLimiter(40)`. So
   every `def` route, every blocking dependency, AND every manual `run_in_threadpool(...)` call all
   draw from **the same 40-token pool**. They contend with each other. (See §3.3 — this is the
   exhaustion footgun.)

Starlette also ships `iterate_in_threadpool(iterator)` — drains a **synchronous** iterator one
`next()` per thread hop, used for streaming a blocking generator (e.g. a `psycopg` server-side
cursor) without blocking the loop:

```python
# starlette/concurrency.py
async def iterate_in_threadpool(iterator: Iterable[T]) -> AsyncIterator[T]:
    as_iterator = iter(iterator)
    while True:
        try:
            yield await anyio.to_thread.run_sync(_next, as_iterator)  # one next() per thread hop
        except _StopIteration:
            break
```

(`_next` exists because a raw `StopIteration` cannot cross the thread/coroutine boundary — it is
coerced into a private `_StopIteration` exception. Don't fight this; use the helper.)

### 2.2 AnyIO `to_thread.run_sync` — signature and default

```python
# anyio/to_thread.py  (anyio==4.14.0, master)
async def run_sync(
    func: Callable[[Unpack[PosArgsT]], T_Retval],
    *args: Unpack[PosArgsT],
    abandon_on_cancel: bool = False,
    cancellable: bool | None = None,          # deprecated alias for abandon_on_cancel
    limiter: CapacityLimiter | None = None,   # None → the default 40-token limiter
) -> T_Retval:
    """Call the given function with the given arguments in a worker thread."""
```

Source: <https://github.com/agronholm/anyio/blob/master/src/anyio/to_thread.py>

### 2.3 The default limiter is `CapacityLimiter(40)` — confirmed in AnyIO source

The "40" is not folklore; it is a literal in the asyncio backend:

```python
# anyio/_backends/_asyncio.py  (anyio==4.14.0, master)
# line 2139:
_default_thread_limiter: RunVar[CapacityLimiter] = RunVar("_default_thread_limiter")

# lines 3034–3039  (inside the AsyncIOBackend):
@classmethod
def current_default_thread_limiter(cls) -> CapacityLimiter:
    try:
        return _default_thread_limiter.get()
    except LookupError:
        limiter = CapacityLimiter(40)        # ← THE DEFAULT: 40 worker threads
        _default_thread_limiter.set(limiter)
        return limiter
```

Source (grep it yourself):
<https://github.com/agronholm/anyio/blob/master/src/anyio/_backends/_asyncio.py> — search
`current_default_thread_limiter` and `CapacityLimiter(40)`.

Confirmed against the AnyIO docs as well:

> "The default AnyIO worker thread limiter has a value of 40, meaning that any calls to
> `to_thread.run_sync()` without an explicit `limiter` argument will cause a maximum of 40 threads
> to be spawned." — <https://anyio.readthedocs.io/en/stable/threads.html>

It is a `RunVar` (per-event-loop variable), lazily created on first use, so it is created fresh per
loop and shared across the whole worker once created.

> **Important nuance from the AnyIO docs:** "AnyIO's default thread pool limiter does not affect the
> default thread pool executor on asyncio." — <https://anyio.readthedocs.io/en/stable/threads.html>
> i.e. if some library bypasses AnyIO and uses `loop.run_in_executor` with asyncio's own default
> `ThreadPoolExecutor`, that pool is governed separately. For FastAPI's own dispatch this is moot
> (everything goes through AnyIO), but know it exists if you mix raw-asyncio libraries in.

---

## 3. The failure mode this whole topic exists to prevent: the event-loop stall

### 3.1 The mechanism, stated precisely

A single event loop is **cooperative**: a coroutine holds the loop until it hits an `await` that
actually yields control (a real I/O suspension point). Synchronous CPU or blocking-I/O code inside
an `async def` contains **no yield point**, so the loop is pinned on that one coroutine — *all other
requests, timers, and the health check stall* until it returns. This is not a slowdown; it is a
**serialization** of everything happening concurrently on that worker.

The FastAPI best-practices repo states it with the canonical example:

```python
# from github.com/zhanymkanov/fastapi-best-practices  (README "I/O Intensive Tasks")
@router.get("/terrible-ping")
async def terrible_ping():
    time.sleep(10)   # 1. blocks the event loop → ALL clients on this worker wait 10s
    return {"pong": True}

@router.get("/good-ping")
def good_ping():
    time.sleep(10)   # 1. runs in a threadpool worker → the loop stays free
    return {"pong": True}
```

> "if you violate that trust and execute blocking operations within async routes, the event loop
> won't be able to run other tasks until the blocking operation completes."
> — <https://github.com/zhanymkanov/fastapi-best-practices>

**What clients observe with `/terrible-ping` under load:** fire 50 concurrent requests; they do not
run in 10 s, they run in ~500 s wall-clock — strictly serialized — because each `time.sleep(10)`
monopolizes the loop in turn. With `/good-ping`, the first 40 run concurrently in the threadpool
(~10 s), the rest queue for a token (see §3.3).

### 3.2 The list of "looks async but blocks the loop" landmines

Every one of these, placed inside an `async def` route/dependency, stalls the loop:

| Blocking thing inside `async def` | Why it blocks | Correct fix |
|---|---|---|
| `time.sleep(n)` | sync sleep, no yield | `await asyncio.sleep(n)` |
| `requests.get(...)` / `urllib` | sync socket I/O | `await httpx.AsyncClient().get(...)` |
| `psycopg2` / sync `psycopg` / sync SQLAlchemy | sync DB driver | `asyncpg` / async SQLAlchemy / or `def` route |
| `redis.Redis().get()` (sync client) | sync socket | `redis.asyncio` (`await r.get()`) |
| `df.groupby(...).agg(...)` on a big frame | CPU-bound, no yield | off-process (§5) or `run_in_threadpool` for modest sizes |
| `json.loads` on a 50 MB payload | CPU-bound | threadpool/off-process if hot |
| `open(path).read()` of a large file | sync filesystem I/O | `anyio.open_file` / `run_in_threadpool` |
| `boto3` / most cloud SDKs | sync HTTP under the hood | run in threadpool, or the async variant (aioboto3) |
| `subprocess.run(...)` | blocks until process exits | `await anyio.run_process(...)` / `asyncio.create_subprocess_exec` |
| `hashlib`/`bcrypt`/crypto on big input | CPU-bound | threadpool (small) / off-process (hot) |
| any `.result()` on a sync future, any lock `.acquire()` (sync) | blocks | use the async primitive |

The unifying tell: **if the line is not preceded by `await`, it runs synchronously, and if it does
real work or real I/O, it stalls the loop.** A line with no `await` in an `async def` that touches
the network/disk/DB/CPU-heavy-compute is the bug.

### 3.3 The *second*, subtler failure: threadpool exhaustion (the 40-token ceiling)

`def` routes are the safe default — but they are **not free**, and the pool is **bounded at 40**.
Implications:

- The pool is shared by **(a) every `def` route, (b) every blocking dependency (sync or
  blocking-`async`-detected-as-coroutine? no — only `def`/sync deps), (c) every manual
  `run_in_threadpool`/`to_thread.run_sync` you call.** All draw the same 40 tokens.
- If 40 requests are each inside a 10 s `def` route, request #41 **does not 503** — it *suspends on
  the loop waiting to acquire a token* (AnyIO's `CapacityLimiter.acquire` is an async wait). So the
  loop stays responsive, but throughput of blocking work is capped at 40 concurrent.
- A slow upstream behind a `def` route (a sync DB query that takes 30 s) can **hold all 40 tokens**,
  starving every other blocking path — including blocking dependencies that other *async* routes
  rely on. One slow sync dependency can throttle the whole worker's blocking capacity.

From the best-practices repo:

> "Threads require more resources than coroutines, so they are not as cheap as async I/O operations."
> "Thread pool has a limited number of threads, i.e. you might run out of threads and your app will
> become slow." — <https://github.com/zhanymkanov/fastapi-best-practices>

**Design consequence for a data service:** a route that fans out to a slow sync upstream (or runs a
multi-hundred-ms pandas job) should **not** silently sit in a `def` route eating one of 40 shared
tokens for the whole job. Either (a) make the I/O genuinely async (asyncpg + httpx) so it never
needs a thread, or (b) push heavy CPU to a **separate process/worker** (§5) so threadpool tokens
stay reserved for short, incidental sync glue. The 40-token pool is for *brief* sync hops, not for
parking long jobs.

---

## 4. The decision rule, as a flowchart you can apply per route/dependency

```
For each path-operation function AND each dependency, ask:

1. Does it perform I/O (DB, HTTP, cache, disk) or non-trivial CPU work?
   NO  → write async def (trivially correct; nothing blocks). Or def; doesn't matter.
   YES → go to 2.

2. Is there a genuinely-async library for that I/O that you will `await`?
   (asyncpg / SQLAlchemy-async / httpx.AsyncClient / redis.asyncio / aiofiles ...)
   YES, and you will await EVERY such call → write async def.  ← best: zero threads
   NO  → go to 3.

3. Is the blocking thing I/O-bound (waiting on network/disk) or CPU-bound (computing)?
   I/O-bound, no async lib  → write def  (FastAPI runs it in the threadpool; loop stays free)
                              — OR keep the route async and wrap THAT call in run_in_threadpool.
   CPU-bound and CHEAP (<~10–50 ms, low QPS)  → def, or run_in_threadpool from an async route.
   CPU-bound and HEAVY/HOT  → OFF-PROCESS (§5). Never on the loop. Never parked in the threadpool.

Tie-breaker the docs give: "If you just don't know, use normal def."
  — https://fastapi.tiangolo.com/async/
Because a def route is always SAFE (worst case: it costs a thread); a wrong async def is a
loop stall that takes the whole worker down.
```

The docs' own "In a hurry?" summary maps to this exactly:

> - Use `async def` if you use a third-party library you call with `await`.
> - Use normal `def` if the library does **not** support `await` (most DB libraries don't).
> - Use `async def` (even without `await`) if your function does no I/O and doesn't wait on anything.
> - "If you just don't know, use normal `def`."
> — <https://fastapi.tiangolo.com/async/>

---

## 5. CPU-bound work: off-process, always

### 5.1 Why threads do not help CPU-bound work in CPython

CPython's **GIL** (Global Interpreter Lock) lets only one thread execute Python bytecode at a time.
So pushing a CPU-bound pandas/numpy job into the AnyIO threadpool **does not parallelize it** — it
only moves it off the event loop (which is still worth doing for loop responsiveness), but the job
still competes for the GIL with everything else and burns a precious threadpool token for its whole
duration. The best-practices repo is explicit:

> "Awaiting CPU-intensive tasks provides no benefit since the CPU must actively work" … the GIL
> "restricts Python threads to single-threaded execution for CPU work" … recommendation: "offload
> them to worker processes (e.g., using `multiprocessing` or a task queue like Celery)."
> — <https://github.com/zhanymkanov/fastapi-best-practices>

**Caveat worth knowing (don't over-rely):** numpy/pandas/pyarrow release the GIL *during their C
kernels*, and Python 3.13+ ships an experimental **free-threaded (no-GIL) build**. So a single big
numpy reduction *can* run while the loop does other things, and on 3.13t threads *can* parallelize.
But you cannot assume a given pandas operation releases the GIL throughout, and free-threaded builds
are not the default in production yet (June 2026). **The safe, portable rule stays: heavy/hot
CPU-bound work runs off-process.**

### 5.2 The three off-process patterns (pick by job shape)

| Pattern | Use when | Mechanism | Notes |
|---|---|---|---|
| **`ProcessPoolExecutor` + `loop.run_in_executor`** | request-scoped CPU job that must return in the response, modest fan-out | spawn/maintain N processes; `await loop.run_in_executor(pool, fn, *args)` | true parallelism (bypasses GIL); args/results must be **picklable**; per-call IPC + pickling overhead — not for tiny jobs. Size pool ≈ CPU cores. |
| **A dedicated task queue / worker** (Celery, RQ, Dramatiq, Arq) | long jobs (seconds–minutes), retries, scheduling, the result need not block the response | enqueue a message; a **separate worker process/fleet** runs it; client polls a status/result endpoint | the production-grade answer; decouples request latency from compute; survives deploys; horizontally scalable. **This is the R-SCALE-correct path.** |
| **A separate compute microservice** | the heavy compute is its own bounded context (e.g. a backtest engine, a risk calc) | FastAPI route makes an **async httpx** call to a service that owns the CPU | keeps the API worker's loop pristine; the compute service can use processes/Ray/Spark internally. |

The anti-pattern all three replace:

```python
# ❌ heavy CPU on the loop — stalls every concurrent request on the worker
@app.get("/analytics/heavy")
async def heavy():
    df = load_million_rows()           # blocks (I/O)
    result = df.groupby("symbol").apply(expensive_fn)   # blocks (CPU, seconds)
    return result.to_dict()
```

```python
# ⚠️ better but still wrong for HEAVY/HOT: parks a threadpool token for the whole job,
#    no real parallelism under the GIL — acceptable only for cheap/low-QPS compute.
@app.get("/analytics/medium")
async def medium():
    return await run_in_threadpool(do_modest_pandas_job)
```

```python
# ✅ heavy/hot CPU off-process via a process pool (true parallelism), result returned inline
import asyncio
from concurrent.futures import ProcessPoolExecutor

# module-level, created once (fork/spawn cost is real — don't make one per request)
_CPU_POOL = ProcessPoolExecutor(max_workers=os.cpu_count())

@app.get("/analytics/heavy")
async def heavy():
    loop = asyncio.get_running_loop()
    # args + return value MUST be picklable; keep the function top-level/importable
    result = await loop.run_in_executor(_CPU_POOL, expensive_pure_function, params)
    return result
```

```python
# ✅✅ long/queued CPU off-process via a task queue — the route returns immediately
@app.post("/analytics/backtest")
async def submit_backtest(req: BacktestRequest) -> dict:
    job_id = await enqueue_backtest(req)     # push to Celery/Arq/Dramatiq; returns fast
    return {"job_id": job_id, "status": "queued"}

@app.get("/analytics/backtest/{job_id}")
async def backtest_status(job_id: str) -> dict:
    return await fetch_job_status(job_id)    # client polls; compute happens in the worker fleet
```

> **Non-negotiable for this product line (mirrors the R-SCALE rule):** heavy and/or scheduled work
> runs **off the request path** — a separate worker/process, never on the serving loop, never parked
> in the shared 40-token threadpool. State, in writing, which off-process pattern a given heavy route
> uses and what happens on partial failure (job lost? retried? idempotent?).

### 5.3 `ProcessPoolExecutor` gotchas (so you don't ship a footgun)

- **Picklability:** the target function and all args/returns must pickle. Closures, lambdas, local
  functions, open DB connections, and non-top-level callables fail. Keep the worker function a
  **module-level pure function**.
- **Start method:** on Linux the default `fork` is fast but copies (and can deadlock with threads
  holding locks at fork time — including the very threadpool you run under); `spawn` is safer with
  threaded parents but slower to start. Set explicitly with
  `multiprocessing.get_context("spawn")` for a pool created inside a threaded server.
- **Pool lifecycle:** create the pool **once** (module level or in lifespan), shut it down in the
  lifespan teardown. Creating a pool per request is its own latency bug.
- **Memory:** each process is a full interpreter + its own copy of large data. Don't fan a 2 GB
  DataFrame across 16 processes by pickling it 16 times — pass a query/path and let each worker load
  its slice, or use shared memory (`multiprocessing.shared_memory` / Arrow IPC).

---

## 6. Dependencies follow the SAME rule — and are an easy blind spot

A blocking call hidden in a **dependency** stalls the loop exactly like one in the route, because
dependencies are run on the same loop when they're `async def`:

- `async def` dependency → run **on the loop** (`await`ed directly). A blocking line in it stalls
  everything — same as a route.
- `def` dependency → run **in the threadpool** (FastAPI wraps it in `run_in_threadpool`). Safe to
  block; costs a token.

```python
# ❌ blocking work in an async dependency — stalls the loop on EVERY request that uses it
async def get_reference_data() -> dict:
    return requests.get("https://upstream/ref").json()   # sync HTTP on the loop → stall

# ✅ option A: make the dependency def → FastAPI threadpools it
def get_reference_data() -> dict:
    return requests.get("https://upstream/ref").json()    # safe: runs in a worker thread

# ✅ option B: keep it async but use an async client (best — no thread at all)
async def get_reference_data(client: httpx.AsyncClient = Depends(get_client)) -> dict:
    r = await client.get("https://upstream/ref")
    return r.json()
```

The docs confirm dependencies share the dispatch: "The same applies for dependencies. If a
dependency is a standard `def` function instead of `async def`, it is run in the external
threadpool." — <https://fastapi.tiangolo.com/async/>

**Audit tip:** when chasing a loop-stall, grep dependencies too (`Depends(...)` targets), not just
routes. A single shared blocking `async def` dependency injected into many async routes can be the
root cause of a whole service's tail latency.

---

## 7. The shared `httpx.AsyncClient` — the fully-async upstream path

For a data service, upstream fetches (market data, reference data, internal microservices) are the
dominant I/O. The correct shape is a **single, app-lifetime, shared `httpx.AsyncClient`** awaited
from `async def` routes — **zero threadpool involvement**.

### 7.1 Why one shared client (not per-request)

- A client owns a **connection pool**; reuse means HTTP keep-alive + TLS session reuse → far lower
  per-request latency and no socket churn. A new `AsyncClient()` per request throws away the pool
  and can exhaust ephemeral ports under load.
- `httpx.AsyncClient` is safe to share across concurrent tasks; that is its design.
  Docs: <https://www.python-httpx.org/async/>

### 7.2 The lifespan pattern (create once, close on shutdown)

```python
import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request

@asynccontextmanager
async def lifespan(app: FastAPI):
    # one client for the whole process; tune pool + timeouts explicitly
    app.state.http = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=2.0, read=5.0, write=5.0, pool=2.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        http2=True,                      # multiplex many requests over fewer sockets
    )
    try:
        yield
    finally:
        await app.state.http.aclose()    # graceful pool shutdown

app = FastAPI(lifespan=lifespan)

def get_http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http        # inject the shared client

@app.get("/quote/{symbol}")
async def quote(symbol: str, http: httpx.AsyncClient = Depends(get_http)):
    r = await http.get(f"https://upstream/quote/{symbol}")   # awaited → loop free
    r.raise_for_status()
    return r.json()
```

### 7.3 The trap: the **sync** `httpx.Client` (and `requests`) inside `async def`

`httpx` ships both `Client` (sync) and `AsyncClient` (async). Using the **sync** `Client` inside an
`async def` blocks the loop — same class of bug as `requests`. Only `AsyncClient` + `await` is the
non-blocking path.

```python
# ❌ sync client on the loop — stalls
async def bad(sym):
    return httpx.get(f"https://upstream/{sym}").json()      # httpx.get is SYNC → blocks

# ❌ requests is always sync
async def also_bad(sym):
    return requests.get(f"https://upstream/{sym}").json()   # blocks

# ✅ async client, awaited
async def good(sym, http: httpx.AsyncClient = Depends(get_http)):
    return (await http.get(f"https://upstream/{sym}")).json()
```

### 7.4 Concurrency within one request — fan out with `asyncio.gather` / a task group

Async I/O's payoff: issue N upstream calls **concurrently** on the single loop, no threads:

```python
import asyncio

@app.get("/snapshot")
async def snapshot(http: httpx.AsyncClient = Depends(get_http)):
    quote_t   = http.get("https://upstream/quote/AAPL")
    fxrate_t  = http.get("https://upstream/fx/USDJPY")
    ref_t     = http.get("https://upstream/ref/AAPL")
    quote, fx, ref = await asyncio.gather(quote_t, fxrate_t, ref_t)   # all in flight at once
    return {"quote": quote.json(), "fx": fx.json(), "ref": ref.json()}
```

For structured cancellation + error propagation prefer `anyio.create_task_group()` (cancels siblings
on first failure) over bare `gather` when partial results are unacceptable. Docs:
<https://anyio.readthedocs.io/en/stable/tasks.html>

---

## 8. The async DB driver — never a sync driver inside `async def`

Same rule, highest-frequency surface in a data service. For this product line the warehouse is
TimescaleDB/Postgres (see the `timescaledb-timeseries` skill); the access library decides the route
discipline.

| Driver | Nature | Use from `async def`? | Notes |
|---|---|---|---|
| `asyncpg` | native async Postgres | **Yes** — `await conn.fetch(...)` | fastest async PG driver; pool via `asyncpg.create_pool`. The default for this line. |
| `psycopg` (v3) **async** | async mode | **Yes** — `await aconn.execute(...)` | modern; supports async + binary + pipeline. |
| `psycopg2` | sync only | **No on the loop** | only in a `def` route or via `run_in_threadpool`. |
| `psycopg` (v3) **sync** | sync | **No on the loop** | same — `def` route or threadpool. |
| SQLAlchemy **`asyncio`** (`create_async_engine` + asyncpg/psycopg-async) | async | **Yes** — `await session.execute(...)` | the ORM path; the underlying driver must be async. |
| SQLAlchemy **sync** engine | sync | **No on the loop** | `def` route or threadpool. |

```python
# ✅ asyncpg pool created once in lifespan, awaited from async routes
import asyncpg
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db = await asyncpg.create_pool(dsn=DSN, min_size=2, max_size=20)
    try:
        yield
    finally:
        await app.state.db.close()

@app.get("/series/{symbol}")
async def series(symbol: str, request: Request):
    async with request.app.state.db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT ts, px FROM ticks WHERE symbol = $1 ORDER BY ts DESC LIMIT 1000", symbol)
    return [dict(r) for r in rows]
```

```python
# If you MUST use a sync driver (legacy lib, sync-only feature), do NOT put it in an async def
# unawaited. Either make the route def:
@app.get("/legacy/{symbol}")
def legacy(symbol: str):                    # def → threadpool; sync driver is safe here
    with sync_engine.connect() as c:
        return [dict(r) for r in c.execute(text("SELECT ..."), {"s": symbol})]

# ...or wrap the one sync call from an async route (costs a threadpool token):
@app.get("/legacy2/{symbol}")
async def legacy2(symbol: str):
    return await run_in_threadpool(_blocking_query, symbol)
```

**Pool sizing vs the threadpool:** an async pool's `max_size` caps concurrent DB work without
touching threads. A *sync* driver behind a `def` route is double-capped: by the 40-token threadpool
**and** by the sync pool — and a slow query holds a token the whole time. Prefer the async driver so
DB concurrency is governed by the DB pool, not by the shared threadpool.

---

## 9. The one-off escape hatch: `run_in_threadpool` / `anyio.to_thread.run_sync`

When a route is otherwise fully async but must make **one** blocking call (a sync-only SDK, a
CPU-cheap pure function), don't downgrade the whole route to `def` — wrap just that call.

```python
from starlette.concurrency import run_in_threadpool   # FastAPI/Starlette idiom
# equivalently: import anyio ; await anyio.to_thread.run_sync(fn, *args)

@app.get("/report/{rid}")
async def report(rid: str, http: httpx.AsyncClient = Depends(get_http)):
    raw = await http.get(f"https://upstream/raw/{rid}")          # async I/O on the loop
    parsed = await run_in_threadpool(parse_blocking_format, raw.content)  # one sync hop → thread
    return parsed
```

Rules for the escape hatch:

- **`run_in_threadpool(fn, *args, **kwargs)`** binds kwargs for you (it builds a `functools.partial`
  — §2.1). `anyio.to_thread.run_sync(fn, *args)` forwards **positional only**; bind kwargs yourself
  with `functools.partial`.
- It draws from the **same 40-token pool** as everything else. Do not loop it for a heavy batch
  (`for x in 10_000: await run_in_threadpool(...)`) — that floods the pool and serializes on tokens.
  Batch the work into one threadpool call, or go off-process.
- For **CPU-heavy** work it is the *wrong* tool (GIL — §5). Reserve it for **I/O-bound or
  CPU-cheap** one-offs.
- **Tuning the limiter** (raise the 40 ceiling) when your workload is legitimately
  many-concurrent-short-blocking-I/O calls:

```python
# Raise the per-loop default threadpool size at startup. Do it inside the running loop
# (lifespan), NOT at import time — the RunVar is per event loop.
from contextlib import asynccontextmanager
import anyio

@asynccontextmanager
async def lifespan(app):
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = 80          # was 40; raise deliberately, with a reason
    yield

# The older, internal-API form seen in FastAPI discussion #8690 (works, but pokes a private RunVar):
#   from anyio.lowlevel import RunVar
#   from anyio import CapacityLimiter
#   RunVar("_default_thread_limiter").set(CapacityLimiter(80))
# Prefer current_default_thread_limiter().total_tokens — it is the documented surface.
```

Source for the documented form:
<https://anyio.readthedocs.io/en/stable/threads.html> ("Adjusting the default maximum worker thread
count"). Source for the discussion + the Uvicorn-vs-AnyIO tradeoff:
<https://github.com/fastapi/fastapi/discussions/8690>.

> **Tradeoff to state when you raise it:** more threads = more memory + more context-switching +
> more GIL contention; it does **not** speed up CPU-bound work. Raise it only for *I/O-bound* sync
> calls that genuinely benefit from more concurrency. A maintainer in #8690 notes the AnyIO limiter
> queues excess requests in Uvicorn's queue, whereas Uvicorn's own `--limit-concurrency` returns
> **503** past the cap — different backpressure semantics; choose deliberately.
> — <https://github.com/fastapi/fastapi/discussions/8690>

---

## 10. Concrete do/don't table per upstream / driver (the cheat sheet)

| Upstream / operation | ❌ Don't (inside `async def`) | ✅ Do |
|---|---|---|
| Sleep / backoff | `time.sleep(n)` | `await asyncio.sleep(n)` |
| HTTP to a microservice / market-data API | `requests.get` · `httpx.get` (sync) · sync `httpx.Client` | shared `httpx.AsyncClient` → `await client.get(...)` |
| Postgres / TimescaleDB | `psycopg2` · sync `psycopg` · sync SQLAlchemy on the loop | `asyncpg` pool · async SQLAlchemy → `await ...`; else a **`def`** route |
| Redis cache | `redis.Redis().get()` (sync) | `redis.asyncio` → `await r.get(...)` |
| File read/write | `open(p).read()` of large files on the loop | `anyio.open_file(...)` / `aiofiles`; or `run_in_threadpool` |
| Cloud SDK (boto3, gcs sync) | `boto3` call on the loop | `aioboto3` (async) · or `run_in_threadpool(blocking_sdk_call)` |
| Subprocess (ffmpeg, a CLI tool) | `subprocess.run(...)` on the loop | `await anyio.run_process(...)` / `asyncio.create_subprocess_exec` |
| Parse a blocking binary/text format | parse a 100 MB blob inline on the loop | `await run_in_threadpool(parse, blob)` (I/O-cheap/CPU-modest) |
| **Heavy pandas/numpy / backtest / risk calc** | `df.groupby().apply(...)` on the loop · or parking it in the threadpool | **off-process**: `ProcessPoolExecutor` (inline result) or a task queue (async result) — §5 |
| Sync-only third-party lib, one call | call it directly in `async def` | `await run_in_threadpool(lib_call, ...)` — or make the route `def` |
| Crypto/hash on big input | `hashlib`/`bcrypt` on big data on the loop | threadpool (small) / off-process (hot) |

---

## 11. Observability — how to *catch* a stall before it's an incident

A loop stall is invisible in a single-request curl (it only manifests under concurrency), so
instrument for it:

- **Enable asyncio debug mode in non-prod**: `PYTHONASYNCIODEBUG=1` (or `asyncio.run(..., debug=True)`).
  It logs a warning when a callback/coroutine runs longer than `loop.slow_callback_duration`
  (default 0.1 s) without yielding — a direct signal that something blocked the loop.
  Docs: <https://docs.python.org/3/library/asyncio-dev.html#debug-mode>
- **Watch event-loop lag** as a first-class metric: a background task that does
  `t=loop.time(); await asyncio.sleep(0.5); lag = loop.time()-t-0.5` and exports `lag`. Rising lag =
  the loop is being starved by blocking code. (Equivalent to Node's event-loop-lag metric.)
- **Load-test concurrently, not serially.** A serial test (one request at a time) will *pass* on
  `/terrible-ping` — 10 s each, "fine." Only `hey -c 50` / `wrk -c 50` exposes the serialization.
  Make the concurrency ≥ your expected real concurrency and ≥ 40 (the threadpool ceiling) so both
  failure modes (loop stall and token exhaustion) show up.
- **Monitor threadpool saturation.** If p99 climbs while CPU is low and exactly ~40 requests are
  in-flight in blocking paths, you're token-starved — the fix is async I/O or off-process, not "more
  threads" (which only defers the ceiling).

---

## 12. Pre-mortem — six months out, this failed; why?

- **A "fast async refactor" reintroduced `requests`/`psycopg2`** in a hot path because it was "just a
  quick fix," and p99 collapsed under the next traffic spike. *Defense:* CI lint that flags `requests`,
  `time.sleep`, `psycopg2`, and sync `httpx.Client`/`httpx.get` imports in modules that define
  `async def` routes; code-review checklist item "no un-`await`ed I/O in any `async def`."
- **A heavy pandas job sat in a `def` route** and, under load, held 30+ of the 40 tokens for seconds
  each, throttling every other blocking path service-wide. *Defense:* the R-SCALE rule — heavy/hot CPU
  goes off-process; the threadpool is for brief sync glue only; document the tier each heavy route
  survives.
- **A shared blocking `async def` dependency** (sync ref-data fetch) silently stalled every route that
  injected it; the route code looked clean. *Defense:* audit dependencies, not just routes; make all
  shared dependencies either async-awaited or `def`.
- **Per-request `AsyncClient()`** exhausted ephemeral ports and added TLS-handshake latency to every
  call. *Defense:* one shared client in `lifespan`; lint against `AsyncClient()` constructed inside a
  route body.
- **`ProcessPoolExecutor` created per request**, or a non-picklable closure passed to it, turned the
  CPU fix into a new latency/crash bug. *Defense:* one module-level pool, pure top-level worker
  functions, `spawn` context under a threaded server.
- **The team raised the AnyIO limiter to 500 "to fix slowness"** — memory ballooned, GIL contention
  rose, CPU-bound work was still slow. *Defense:* the limiter only helps I/O-bound sync concurrency;
  diagnose the bound (I/O vs CPU) before tuning; CPU-bound → off-process, full stop.

---

## 13. Confidence & open items

- **High confidence (read in source this session, pinned versions):** the `is_coroutine` fork in
  `fastapi/routing.py:336–346`; Starlette `run_in_threadpool` = `functools.partial` + `to_thread.run_sync`;
  AnyIO default `CapacityLimiter(40)` at `_asyncio.py:3038`; the `RunVar("_default_thread_limiter")` at
  `:2139`; `to_thread.run_sync` signature with `abandon_on_cancel`/`limiter`; the loop-stall mechanism
  and the `def`→threadpool dispatch from the official docs; the FastAPI best-practices blocking/CPU
  warnings; the limiter-tuning forms from the AnyIO docs + FastAPI discussion #8690.
- **Medium confidence:** exact GIL-release behavior of specific pandas/numpy kernels varies by
  operation and version — treat "off-process for heavy/hot CPU" as the portable rule, not "threads are
  always useless for compute." Free-threaded 3.13t changes the calculus but is not a production default
  as of June 2026.
- **Open (decide at build time):** the off-process pattern per heavy route (process pool inline vs
  task-queue async) — pick per latency budget + durability need; the limiter value (start at the
  default 40, raise only with a measured I/O-bound justification); whether to standardize on `asyncpg`
  vs async-SQLAlchemy for the warehouse (separate decision; both keep the loop clean).

---

## Sources (primary, read this session)

- FastAPI — *Concurrency and async / await*: <https://fastapi.tiangolo.com/async/>
- FastAPI source — `run_endpoint_function` / `is_coroutine` fork (`routing.py`):
  <https://github.com/fastapi/fastapi/blob/master/fastapi/routing.py>
- FastAPI source — coroutine detection (`dependencies/models.py`, unwraps `functools.partial`):
  <https://github.com/fastapi/fastapi/blob/master/fastapi/dependencies/models.py>
- Starlette source — `run_in_threadpool` / `iterate_in_threadpool` (`concurrency.py`):
  <https://github.com/encode/starlette/blob/master/starlette/concurrency.py>
- AnyIO source — `to_thread.run_sync` (`to_thread.py`):
  <https://github.com/agronholm/anyio/blob/master/src/anyio/to_thread.py>
- AnyIO source — default `CapacityLimiter(40)` + `RunVar` (`_backends/_asyncio.py`, lines 2139 / 3034–3039):
  <https://github.com/agronholm/anyio/blob/master/src/anyio/_backends/_asyncio.py>
- AnyIO docs — *Working with threads* (default 40, `current_default_thread_limiter().total_tokens`):
  <https://anyio.readthedocs.io/en/stable/threads.html>
- AnyIO docs — *Working with tasks* (`create_task_group`): <https://anyio.readthedocs.io/en/stable/tasks.html>
- FastAPI best practices — blocking-in-async + CPU-bound warnings (`zhanymkanov/fastapi-best-practices`):
  <https://github.com/zhanymkanov/fastapi-best-practices>
- FastAPI discussion #8690 — tuning the thread limiter; AnyIO-queue vs Uvicorn `--limit-concurrency` 503:
  <https://github.com/fastapi/fastapi/discussions/8690>
- httpx docs — *Async support* (shared `AsyncClient`, connection pooling): <https://www.python-httpx.org/async/>
- Python docs — *asyncio debug mode* / `slow_callback_duration`:
  <https://docs.python.org/3/library/asyncio-dev.html#debug-mode>
- Versions pinned via PyPI JSON API (`/pypi/<pkg>/json`): fastapi 0.138.0 · starlette 1.3.1 · anyio 4.14.0 · httpx 0.28.1
