# Background work and the worker boundary

> **Skill:** `python-fastapi-data-service` (JPM-Markets re-engineering data-analytics product line — **NOT Lumina**).
> **Type:** `patterns-*` — concrete build recipe + a hard decision boundary.
> **Scope:** When may work run *in-process after the response* (FastAPI `BackgroundTasks` /
> `asyncio.create_task`), and when must it move to the **external write-path worker** (a `cron` +
> `CRON_SECRET`-triggered Fly process, owned by the sibling `data-pipeline-worker-cron` skill). This is the
> enforcement reference for repo non-negotiable **#4**: *"the serverless / read-request process cannot hold
> sockets, timers, or durable background work."*

---

## 0. The one-paragraph answer (read this first)

This data-analytics service is split into **two processes that never share a request**:

1. **The READ service** (FastAPI on the request path). It answers queries, serves cached series, runs the
   agent tool-loop. It is *allowed* to use `BackgroundTasks` for **sub-second, loss-tolerant trivia** — a
   cache-warm nudge, an audit-log row, an analytics ping. Nothing whose loss would page a human.
2. **The WRITE path** (a separate worker process: ingest, normalization, continuous-aggregate refresh,
   anything multi-second / retryable / idempotent). It is **never** a FastAPI background task. It runs as a
   cron-triggered job (`CRON_SECRET`-guarded) on Fly, owned by the `data-pipeline-worker-cron` skill.

The decision rule, lifted verbatim from the FastAPI best-practices repo, is the whole law in one line:

> **"Rule of thumb: if you'd page someone when the task is lost, it doesn't belong in `BackgroundTasks`."**
> — [zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)

Everything below is the *why*, the *exactly-how-it-fails*, and the *runnable recipe* for both sides of that
boundary.

---

## 1. What FastAPI `BackgroundTasks` actually is (mechanics, at the source level)

### 1.1 It is a thin Starlette feature, not a job queue

FastAPI's `BackgroundTasks` is re-exported straight from Starlette. The FastAPI tutorial says so
explicitly:

> "The class `BackgroundTasks` comes directly from
> [`starlette.background`](https://www.starlette.dev/background/)."
> — [fastapi.tiangolo.com/tutorial/background-tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)

So to understand the mechanics you read `starlette/background.py`, not FastAPI. The class is tiny. Here is
the load-bearing part of the implementation
([encode/starlette `starlette/background.py`](https://github.com/encode/starlette/blob/master/starlette/background.py)):

```python
# starlette/background.py  (shape of the current implementation)
from starlette._utils import is_async_callable
from starlette.concurrency import run_in_threadpool

class BackgroundTask:
    def __init__(self, func, *args, **kwargs):
        self.func = func
        self.args = args
        self.kwargs = kwargs
        self.is_async = is_async_callable(func)   # decided ONCE, at construction

    async def __call__(self) -> None:
        if self.is_async:
            await self.func(*self.args, **self.kwargs)        # awaited on the event loop
        else:
            await run_in_threadpool(self.func, *self.args, **self.kwargs)  # pushed to the threadpool


class BackgroundTasks(BackgroundTask):
    def __init__(self, tasks=None):
        self.tasks = list(tasks) if tasks else []

    def add_task(self, func, *args, **kwargs) -> None:
        task = BackgroundTask(func, *args, **kwargs)
        self.tasks.append(task)

    async def __call__(self) -> None:
        for task in self.tasks:        # SEQUENTIAL — one awaited before the next starts
            await task()
```

Three facts fall directly out of this code, and they matter:

1. **Sync vs async is decided once, at `add_task` time**, by `is_async_callable(func)`. If you pass a plain
   `def` function it goes to the threadpool; an `async def` is awaited on the loop. You do not get to choose
   at runtime.
2. **`run_in_threadpool` is AnyIO's bounded threadpool.** The default capacity is **40 tokens** shared
   across the *whole* process (and shared with every other library that calls `anyio.to_thread.run_sync`).
   Source: [starlette.dev/threadpool](https://starlette.dev/threadpool/) ("the default thread pool size is
   only 40 tokens … this limit is shared"). A sync background task **holds one of those 40 slots for its
   entire duration**, and that pool is the same one your sync route handlers and sync DB drivers use.
3. **Tasks run strictly sequentially** (`for task in self.tasks: await task()`). Three tasks added in one
   request run one-after-another, not concurrently. A slow first task delays the others.

### 1.2 When does it run? AFTER the response — this is the whole point

The FastAPI tutorial frames `BackgroundTasks` as work "to be run *after* returning a response"
([fastapi.tiangolo.com/tutorial/background-tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)).
At the ASGI level, the response object's `__call__` sends the HTTP response **and then** invokes the attached
background callable. Confirmed against the Starlette execution flow: "Background tasks run only once the
response has been sent, and they are executed through the response's `__call__` method"
([Starlette background docs / source discussion](https://www.starlette.io/background/)).

The sequence on the wire for one request:

```
client request
  → route handler runs, returns a Response (+ a populated BackgroundTasks)
  → ASGI sends response.start + response.body   ← client's HTTP request is now COMPLETE (e.g. 200/202)
  → response.__call__ awaits background_tasks()  ← your task runs HERE, client already gone
  → event loop continues
```

This is why a background task **cannot influence the response** (status, body, headers) — they are already
on the wire. It is also why a task failure **cannot be reported to the caller**: there is no caller anymore.

### 1.3 The canonical API (three ways to attach a task)

```python
from fastapi import BackgroundTasks, Depends, FastAPI
from typing import Annotated

app = FastAPI()

def write_audit(row: dict) -> None:          # sync → threadpool
    audit_log.append(row)

async def warm_cache(key: str) -> None:      # async → event loop
    await cache.touch(key)

# (1) Parameter injection — FastAPI sees the BackgroundTasks type hint and injects the instance.
@app.get("/series/{symbol}")
async def get_series(symbol: str, background_tasks: BackgroundTasks):
    data = await read_series(symbol)
    background_tasks.add_task(write_audit, {"symbol": symbol, "ts": now()})
    return data

# (2) From inside a dependency — the SAME BackgroundTasks instance is merged across all levels.
def audited_query(background_tasks: BackgroundTasks, q: str | None = None):
    if q:
        background_tasks.add_task(write_audit, {"q": q})
    return q

@app.get("/search")
async def search(bt: BackgroundTasks, q: Annotated[str, Depends(audited_query)]):
    return {"q": q}

# (3) Attaching to a Response object directly (advanced / streaming responses).
from starlette.background import BackgroundTask
from fastapi.responses import JSONResponse

@app.get("/raw")
async def raw():
    return JSONResponse({"ok": True}, background=BackgroundTask(write_audit, {"raw": True}))
```

FastAPI merges all `BackgroundTasks` injected at any dependency level into one instance and runs them after
the response: *"FastAPI knows what to do in each case and how to reuse the same object, so that all the
background tasks are merged together and are run in the background afterwards"*
([fastapi.tiangolo.com/tutorial/background-tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)).

### 1.4 Pinned versions (verify before you build)

| Package | Version pinned here | Source |
|---|---|---|
| `fastapi` | **0.138.0** (latest on PyPI as of this writing) | [pypi.org/pypi/fastapi/json](https://pypi.org/pypi/fastapi/json) |
| `starlette` | FastAPI 0.138.0 requires **`starlette>=0.46.0`** | same `requires_dist` |
| `uvicorn` | the ASGI server; `--timeout-graceful-shutdown` governs how long in-flight work survives a SIGTERM | [uvicorn settings](https://www.uvicorn.org/settings/) |

`BackgroundTasks` has been stable in shape across these versions; the source above matches the `>=0.46.0`
Starlette line. Re-confirm `is_async_callable` and the threadpool default if you bump major Starlette.

---

## 2. The hard limits — exactly how `BackgroundTasks` fails in production

Every limitation below is a *property of the design*, not a bug. The FastAPI maintainer's framing, echoed by
the field reports: *"That is not a criticism of the design. It is designed this way intentionally"*
([hafiqiqmal93, *FastAPI's BackgroundTasks Will Burn You in
Production*](https://hafiqiqmal93.medium.com/fastapis-backgroundtasks-will-burn-you-in-production-4490a8d403e8)).
The trap is using it as if it were a queue.

### 2.1 No persistence — in-memory, gone on restart

The task list lives in the FastAPI worker's RAM. There is no broker, no Redis, no disk.

> "All task state lives in memory. If your application restarts — a redeploy, a crash, a container restart —
> every pending task that had not started yet is gone."
> — [field report, via search of *no retry no persistence*](https://oneuptime.com/blog/post/2026-01-25-background-task-processing-fastapi/view)

For this product line specifically, that means: **a deploy that rolls a Fly machine mid-request silently
drops every queued background task on that machine.** Deploys happen constantly. If ingest were a background
task, every deploy would punch holes in the data.

### 2.2 No retry — one exception and it's over

The Starlette `__call__` `await`s the task. If it raises, the exception propagates up out of the background
runner and the task is simply **done, failed, forgotten**. There is no backoff, no DLQ, no "try again in 5
seconds."

> "If the task function raises an exception, it fails and that is the end of it. There is no retry
> mechanism, no backoff, no way to tell FastAPI to try again."
> — [field report](https://oneuptime.com/blog/post/2026-01-25-background-task-processing-fastapi/view)

### 2.3 No visibility — you cannot observe it

You cannot ask "did task X run? is it running? did it return?"

> "No Status Tracking: You can't check if a task has started, is running, or has completed. No Result
> Retrieval: There is no way to get the return value of a task."
> — [davidmuraya.com, *BackgroundTasks vs arq*](https://davidmuraya.com/blog/fastapi-background-tasks-arq-vs-built-in)

The return value is discarded (`await task()` — the result is not captured). There is no job id, no status
endpoint, no metric, unless you build all of it yourself — at which point you've built a worse queue.

### 2.4 Exceptions are *swallowed*, and can even be mangled

Because the response is already sent, an unhandled exception in a background task cannot become an HTTP error
— and worse, if the exception type has a registered FastAPI exception handler, Starlette tries to turn it
into a response that no longer exists:

> "when a background task raises an exception with a registered handler, you get a cryptic error like
> `RuntimeError: Caught handled exception, but response already started` … which also hides the original
> exception."
> — [search synthesis of FastAPI issues #2505 / #3589](https://github.com/fastapi/fastapi/issues/3589)

So a background task that raises `HTTPException` (or anything with a handler) loses its *real* error in the
logs. The only safe pattern is to wrap the body in your own `try/except` + log (see §4.1). The default is a
**silent failure with a misleading log line** — the worst kind for a data product where the symptom is
"yesterday's numbers look wrong" three days later.

### 2.5 It can starve the app under load (the threadpool / event-loop trap)

Two distinct ways:

- **Sync task → threadpool starvation.** A sync background task occupies one of the ~40 AnyIO threadpool
  tokens for its full duration. If many requests each enqueue a multi-second sync task, the pool fills, and
  now your *sync route handlers and sync DB calls* (which share that pool) queue behind background work. The
  API gets slow for reasons that don't show up in any obvious place.
- **Async task → event-loop blocking.** An `async def` background task that does CPU work or a blocking call
  without `await` blocks the single event loop — which serves *every* request on that worker. *"A
  CPU-intensive task could slow down your entire API"*
  ([davidmuraya.com](https://davidmuraya.com/blog/fastapi-background-tasks-arq-vs-built-in)).

The FastAPI docs themselves draw the line: if you need heavy compute and don't need the same process,
*"you might benefit from using other bigger tools like Celery"*; `BackgroundTasks` is for when *"you need to
perform small background tasks (like sending an email notification)"*
([fastapi.tiangolo.com/tutorial/background-tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)).

### 2.6 It can be cancelled mid-flight by a client disconnect

A subtle one specific to certain middleware/connection paths: Starlette has a history of background tasks
being **cancelled when the client closes the connection** before they finish
([encode/starlette issue #1438](https://github.com/encode/starlette/issues/1438)). The lifecycle is bound to
the response object, which is bound to the connection. You do not get to assume "the response was sent,
therefore the task is safe" in all configurations.

### 2.7 It interacts badly with `BaseHTTPMiddleware`

If you use legacy `BaseHTTPMiddleware`, background tasks can fail to run as expected — the request isn't
considered finished until the background task completes, and context/cancellation semantics get tangled
([Kludex/starlette issue #919](https://github.com/Kludex/starlette/issues/919);
[discussion #1729](https://github.com/Kludex/starlette/discussions/1729)). The fix is "use pure ASGI
middleware," but the deeper lesson is: **`BackgroundTasks` has emergent edge cases tied to the request
pipeline.** A real worker has none of these because it isn't tied to a request at all.

### 2.8 The limits, as a table

| Property | `BackgroundTasks` | What a real worker (cron+Fly) gives |
|---|---|---|
| Persistence | ❌ in-RAM, lost on restart/redeploy/crash | ✅ the job is a durable trigger; state in DB/cache |
| Retry / backoff | ❌ none | ✅ re-runs on schedule; idempotent upsert makes retry safe |
| Visibility / status | ❌ none (no id, no result) | ✅ logs, exit code, last-run timestamp, metrics |
| Failure surfacing | ❌ swallowed / can be mangled | ✅ non-zero exit, alert, dashboard |
| Isolation from API | ❌ shares event loop + 40-token threadpool | ✅ separate process; API never slows |
| Concurrency control | ❌ sequential per request | ✅ worker controls its own pool/batching |
| Survives deploy | ❌ no | ✅ yes (decoupled lifecycle) |
| Lifecycle | bound to the response/connection | independent of any request |

Sources for the table: [fastapi.tiangolo.com](https://fastapi.tiangolo.com/tutorial/background-tasks/),
[zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices),
[davidmuraya.com](https://davidmuraya.com/blog/fastapi-background-tasks-arq-vs-built-in),
[starlette.dev/threadpool](https://starlette.dev/threadpool/).

---

## 3. The decision rule (the boundary this skill owns)

### 3.1 The one-line test

> **If you'd page someone when the task is lost, it does NOT belong in `BackgroundTasks`.**
> — [zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)

Negate it to get the only acceptable use: *only* work whose silent loss is, by design, fine.

### 3.2 The best-practices matrix, applied to this repo

The `fastapi-best-practices` repo gives the full split. Use `BackgroundTasks` **only when ALL of these hold**
([zhanymkanov/fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices)):

- "Task is short (**< 1 second**)"
- "Failure can be **silently dropped**"
- "It's **in-process** (send email, log a row)"
- "You **don't need scheduling or rate limiting**"

Move to an external worker (their list: Celery / arq / RQ; **ours: cron-triggered Fly worker**) when **ANY**
of these hold:

- "Task takes **seconds to minutes**"
- "You need **retries or dead-letter handling**"
- "It's **CPU-heavy** or needs a **separate worker pool**"
- "You need **cron, ETA, or rate limiting**"

### 3.3 The flowchart

```
                    ┌─────────────────────────────────────────────┐
                    │ I want to do work that the user doesn't wait │
                    │ for in the HTTP response. Where does it go?  │
                    └──────────────────────┬──────────────────────┘
                                           │
                  ┌────────────────────────▼─────────────────────────┐
                  │ Q1: If this work is silently LOST, is that fine?  │
                  │     (no human paged, no data corrupted, no        │
                  │      missing series, no broken invariant)         │
                  └───────────────┬───────────────────┬──────────────┘
                              NO  │                   │  YES
                                  ▼                   ▼
                   ┌──────────────────────┐   ┌──────────────────────────────┐
                   │  EXTERNAL WORKER      │   │ Q2: Is it reliably < ~1s,     │
                   │  (cron + CRON_SECRET  │   │     no retry, no scheduling,  │
                   │   on Fly).            │   │     pure in-process side-effect│
                   │  → data-pipeline-     │   │     (touch cache / append log)│
                   │     worker-cron skill │   └──────┬───────────────┬────────┘
                   └──────────────────────┘      NO   │               │  YES
                                                      ▼               ▼
                                       ┌──────────────────────┐  ┌──────────────────┐
                                       │  EXTERNAL WORKER      │  │ BackgroundTasks   │
                                       │  (same as above)      │  │ is OK. Wrap body  │
                                       └──────────────────────┘  │ in try/except+log │
                                                                  │ (§4.1).           │
                                                                  └──────────────────┘
```

If you hesitate on Q1 — answer **NO**. Hesitation means there's a scenario where loss matters, and the cost
of a wrong "yes" (silent data gaps in a data-analytics product) is far higher than the cost of a wrong "no"
(a slightly heavier worker job).

### 3.4 The non-negotiable, restated for this product line

Repo non-negotiable **#4**: the request/serverless process does not own durable background work. In *this*
service:

- The **READ FastAPI app** may emit `BackgroundTasks` for §3.2-qualifying trivia.
- The **WRITE path is a separate process**, triggered by an external cron hitting a `CRON_SECRET`-guarded
  route on the Fly worker. Ingest, normalization, continuous-aggregate refresh, snapshot builds, embedding
  jobs, retention/compression — **all** of it. None of it is ever a FastAPI background task. (Build details:
  `data-pipeline-worker-cron` skill.)

---

## 4. Legitimate uses — the recipe (READ service, sub-second fire-and-forget)

These are the **only** things that may ride `BackgroundTasks` in this service. Each is < 1 second, loss-OK,
in-process, side-effect-only.

### 4.1 The mandatory wrapper (always, no exceptions)

Because exceptions are swallowed/mangled (§2.4), **every** background callable wraps its body and logs.
Never let one throw raw.

```python
import logging
from functools import wraps

log = logging.getLogger("bg")

def safe_bg(fn):
    """Wrap a background task so a failure logs loudly instead of vanishing or mangling a handler."""
    @wraps(fn)
    async def aw(*a, **k):
        try:
            await fn(*a, **k)
        except Exception:                      # noqa: BLE001 — last line of defense, must be broad
            log.exception("background task %s failed (swallowed by design)", fn.__name__)
    @wraps(fn)
    def sw(*a, **k):
        try:
            fn(*a, **k)
        except Exception:                      # noqa: BLE001
            log.exception("background task %s failed (swallowed by design)", fn.__name__)
    import asyncio
    return aw if asyncio.iscoroutinefunction(fn) else sw
```

### 4.2 Use #1 — cache-warm *nudge* (NOT cache-warm the data)

The distinction is everything. A **nudge** marks a key as worth refreshing or extends a soft-TTL; the
**actual recompute** of a series is the worker's job. Losing a nudge just means the next request recomputes —
no harm.

```python
@safe_bg
async def nudge_warm(symbol: str) -> None:
    # sub-second: bump a soft-TTL / flag the key as "recently requested" so the cron warmer
    # prioritizes it next cycle. Does NOT fetch or compute the series itself.
    await cache.expire(f"warm-flag:{symbol}", ttl=900)   # one Redis op

@app.get("/series/{symbol}")
async def get_series(symbol: str, background_tasks: BackgroundTasks):
    data = await read_from_cache_or_db(symbol)      # the read still serves synchronously
    background_tasks.add_task(nudge_warm, symbol)   # fire-and-forget popularity signal
    return data
```

Why this is safe: if the nudge is lost on a redeploy, the worst case is the key isn't prioritized next cycle.
No number is wrong, no series is missing. The *recompute* lives in the worker (`data-pipeline-worker-cron`),
which is compute-once-serve-many and durable.

### 4.3 Use #2 — audit / access log row

```python
@safe_bg
def write_access_audit(row: dict) -> None:
    # a single fast INSERT to an append-only audit table, or one structured log line.
    audit_sink.write(row)        # sync, sub-ms; threadpool slot held for microseconds

@app.get("/datasets/{ds}/query")
async def query_dataset(ds: str, q: str, background_tasks: BackgroundTasks, user=Depends(current_user)):
    result = await run_query(ds, q)
    background_tasks.add_task(write_access_audit,
                             {"user": user.id, "ds": ds, "q": q, "ts": now()})
    return result
```

If a single audit row is lost on crash, that is acceptable for *operational* audit telemetry. (Caveat: if the
audit log is **compliance/regulatory** — e.g. you must prove who accessed what — then loss is NOT acceptable,
Q1 = NO, and it becomes a durable write on the request path or a worker job. Know which kind you have.)

### 4.4 Use #3 — non-critical analytics ping

```python
@safe_bg
async def emit_usage_event(event: dict) -> None:
    await analytics.send(event)     # one HTTP call to an internal metrics sink, best-effort

# add via background_tasks.add_task(emit_usage_event, {...}) in the handler
```

Loss-tolerant by definition (product analytics, not money, not data integrity).

### 4.5 What these three share (the invariant for "legitimate")

- **Side-effect only** — they never produce the response data the user is reading.
- **Idempotent-or-don't-care** — re-running or skipping changes nothing the user sees.
- **Sub-second** — one cache op / one insert / one ping. No loops, no fan-out, no upstream-API pagination.
- **No invariant depends on them** — no row count, no series completeness, no balance, no "is fresh."

If a candidate fails *any* of these, it is not legitimate `BackgroundTasks` work — it is worker work.

---

## 5. The boundary to the external worker (the WRITE path)

### 5.1 What MUST be the worker, never a background task

Everything in the data write-path. Concretely, for this product line:

| Work | Why it's worker-only |
|---|---|
| **Ingest** (pull provider/market files, paginated upstream APIs) | multi-second, retryable, rate-limited, must not lose rows on deploy |
| **Normalization / transform** (raw → canonical schema, dedupe, unit fixes) | CPU-ish, must complete fully or a downstream invariant breaks |
| **Continuous-aggregate / rollup refresh** (OHLC buckets, downsamples) | scheduled, compute-once-serve-many, must be reliable |
| **Snapshot / materialized briefing builds** | multi-second, must be durable & retryable |
| **Embedding / index jobs** (catalog → pgvector) | batch, slow, retryable, idempotent upsert |
| **Retention / compression / vacuum** of the time-series store | scheduled maintenance, never on a request |

All of these satisfy at least one "move it" criterion from §3.2 (seconds-to-minutes / retries / CPU /
scheduling). None of them satisfies the §4.5 "legitimate" invariant. The verdict is mechanical: **worker.**

### 5.2 The trigger shape (owned by `data-pipeline-worker-cron`)

This skill does **not** implement the worker — it draws the boundary. The worker is a separate Fly process
exposing `CRON_SECRET`-guarded endpoints that an external scheduler (cron-job.org or Fly's scheduler) hits.
The contract, in brief, so you know what's on the *other* side of the boundary:

```python
# WORKER process (separate Fly app). NOT the read API. Illustrative — built in the worker skill.
import os, hmac
from fastapi import FastAPI, Header, HTTPException, status

worker = FastAPI()
CRON_SECRET = os.environ["CRON_SECRET"]

def require_cron(authorization: str = Header(...)) -> None:
    # constant-time compare; the external cron sends Authorization: Bearer <CRON_SECRET>
    expected = f"Bearer {CRON_SECRET}"
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad cron secret")

@worker.post("/jobs/ingest-eod", dependencies=[Depends(require_cron)])
async def ingest_eod():
    # multi-second, retryable, IDEMPOTENT upsert. Safe to re-run if the cron retries.
    rows = await pull_provider_eod()
    await upsert_canonical(rows)     # ON CONFLICT DO UPDATE — re-run = same end state
    return {"ingested": len(rows)}
```

Two non-negotiables that make the boundary *safe* (detailed in the worker skill, named here so you know why
the line is where it is):

1. **`CRON_SECRET` guard** — the write-path endpoints are not public; only the scheduler can fire them.
2. **Idempotent upsert** — because the cron *will* retry on failure or fire twice on a network blip, the job
   must be safe to run again. This is exactly what `BackgroundTasks` cannot give you (it has no retry, so it
   never needs idempotency — it just loses the work).

### 5.3 The contract sentence

> **The READ service may use `BackgroundTasks` for trivia. The WRITE path is a separate process.**

That is the line. When a PR puts ingest/normalization/refresh logic into a FastAPI background task, it
crosses the line and violates non-negotiable #4 — reject it and move the logic to the worker.

---

## 6. Why `asyncio.create_task` is the SAME trap (and worse)

A common "clever" workaround when someone has been told not to use `BackgroundTasks`:

```python
import asyncio

@app.post("/ingest")          # ❌ DO NOT DO THIS
async def ingest(payload: dict):
    asyncio.create_task(do_heavy_ingest(payload))   # "fire and forget"
    return {"status": "accepted"}
```

This is **not** an escape from the boundary — it's the boundary violated more dangerously. Every §2 limit
still applies (in-process, no persistence, no retry, dies on restart, swallowed errors, shares the loop), and
`create_task` adds two new failure modes:

### 6.1 The garbage-collection disappearance bug

The event loop holds only a **weak reference** to a bare task. If you don't keep a strong reference, the
garbage collector can collect the task **mid-execution** — and it's cancelled silently, no exception, no log.
This is a documented CPython footgun:

> "The event loop only keeps weak references to tasks. A task that isn't referenced elsewhere may get
> garbage collected at any time, even before it's done."
> — [Python docs, asyncio Tasks](https://docs.python.org/3/library/asyncio-task.html);
> [cpython issue #91887](https://github.com/python/cpython/issues/91887);
> [SuperFastPython, *Asyncio Disappearing Task Bug*](https://superfastpython.com/asyncio-disappearing-task-bug/)

The Python docs' own mitigation proves how sharp the edge is — you must manually pin a strong reference and
clean it up:

```python
_bg = set()                                   # module-level strong-ref set
def fire(coro):
    t = asyncio.create_task(coro)
    _bg.add(t)                                # strong ref so the GC can't eat it
    t.add_done_callback(_bg.discard)          # ...but drop it when done, or you leak
```

If you find yourself writing *that*, you are hand-building a worse, in-memory, non-durable queue — exactly
what the boundary forbids. ([Python asyncio docs](https://docs.python.org/3/library/asyncio-task.html).)

### 6.2 No lifecycle binding at all → silent loss on shutdown

`BackgroundTasks` is at least bound to the response and runs *before* the request fully closes. A bare
`create_task` is bound to **nothing**: on shutdown/SIGTERM, uvicorn cancels the loop and any in-flight
free-flying task is killed with no drain, no await, no log. There is no `--timeout-graceful-shutdown`
coverage for tasks the framework doesn't know about. Field reports on graceful shutdown note that "tasks in a
background queue … may already be gone by the time shutdown events trigger"
([FastAPI graceful-shutdown discussions](https://github.com/fastapi/fastapi/discussions/6912)).

### 6.3 The rule

> **`asyncio.create_task` for request-spawned background work is `BackgroundTasks` with the safety rails
> removed.** Same boundary, same verdict: trivia only (and even then prefer `BackgroundTasks`, which at least
> runs sequentially after the response and is GC-safe); anything durable → the worker.

`TaskGroup` (`async with asyncio.TaskGroup()`) is the *correct* tool for **structured concurrency within a
single request** (e.g. fan-out three upstream reads and await all before responding) — that is a different
problem (in-request parallelism, the caller waits) and is fine. It is **not** a fire-and-forget mechanism and
must not be repurposed as one.

---

## 7. The READ-vs-WRITE contract this skill owns (summary card)

```
┌──────────────────────────── READ SERVICE (FastAPI, request path) ────────────────────────────┐
│ Owns: query answering, cached-series reads, the agent tool-loop, the API surface.             │
│ MAY use BackgroundTasks ONLY for: sub-second, loss-OK, side-effect-only trivia                 │
│   • cache-warm NUDGE (flag a key — not recompute it)                                           │
│   • operational audit-log row                                                                  │
│   • non-critical analytics ping                                                                │
│ ALWAYS wraps the task body in try/except + log (§4.1) — failures are swallowed by design.      │
│ MUST NOT: ingest, normalize, refresh aggregates, build snapshots, embed, hold timers/sockets,  │
│           or asyncio.create_task durable work. None of these are "trivia".                     │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                            │  boundary = non-negotiable #4
                                            ▼
┌──────────────────────── WRITE PATH (separate Fly worker process) ─────────────────────────────┐
│ Owns: ingest · normalization · continuous-aggregate/rollup refresh · snapshot builds ·         │
│       embedding/index jobs · retention/compression. Everything multi-second / retryable /      │
│       scheduled / CPU-heavy / invariant-bearing.                                               │
│ Triggered by: external cron → CRON_SECRET-guarded endpoint (never a request-path background).  │
│ Properties it provides that BackgroundTasks cannot: persistence, retry, idempotent re-run,     │
│       visibility, isolation from the API, survival across deploys.                              │
│ Built in: the `data-pipeline-worker-cron` skill (this skill only draws the line to it).        │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### The five sentences to remember

1. `BackgroundTasks` runs **in the same process, after the response, with no persistence, no retry, no
   visibility** — and exceptions are swallowed (often mangled). ([FastAPI
   docs](https://fastapi.tiangolo.com/tutorial/background-tasks/), [Starlette
   source](https://github.com/encode/starlette/blob/master/starlette/background.py).)
2. The test: **"if you'd page someone when it's lost, it doesn't belong in `BackgroundTasks`."**
   ([fastapi-best-practices](https://github.com/zhanymkanov/fastapi-best-practices).)
3. Legitimate uses are **sub-second, loss-OK, side-effect-only**: cache-warm nudge, audit row, analytics
   ping — always wrapped in try/except+log.
4. **Everything in the data write-path is the external worker** (cron + `CRON_SECRET` on Fly), never a
   background task — per non-negotiable #4 and the `data-pipeline-worker-cron` skill.
5. `asyncio.create_task` is the **same trap with the rails off** (GC-disappearance + no shutdown drain) —
   never use it for durable request-spawned work.

---

## 8. Anti-pattern catalogue (mistake → fix)

| # | Anti-pattern | Why it breaks | Fix |
|---|---|---|---|
| A1 | Ingest/normalize in a `BackgroundTasks` task | lost on redeploy, no retry → silent data gaps | move to the cron+`CRON_SECRET` worker (§5) |
| A2 | `asyncio.create_task(heavy())` in a handler | GC can kill it mid-run; no shutdown drain; no persistence | worker; if in-request parallelism, use `TaskGroup` and await it |
| A3 | Background task that *returns the user's data* | response already sent; result discarded | do the read synchronously in the handler |
| A4 | No `try/except` in the task body | exception swallowed or mangled (`response already started`) | wrap with `safe_bg` (§4.1) |
| A5 | Multi-second sync task in `BackgroundTasks` | holds 1 of ~40 threadpool tokens → starves sync routes/DB | worker; or make it a fast async op |
| A6 | Compliance/financial audit as loss-OK background task | a lost legally-required record | durable write on request path, or worker; Q1 = NO |
| A7 | Cache-*recompute* (not nudge) as a background task | the expensive compute is now per-request, in-process, lossy | nudge in bg (§4.2); recompute in the cron warmer |
| A8 | Hand-rolling a strong-ref set + done-callback to "fix" create_task | you've built a worse in-memory queue | use the real worker |
| A9 | Polling/timer (`while True: await sleep`) inside the FastAPI app | serverless/request process can't hold timers (#4) | scheduled cron → worker |
| A10 | Relying on the task to maintain an invariant (row count, "is fresh") | bg loss breaks the invariant invisibly | invariant-bearing work → worker, idempotent |

---

## References cited in this document

- FastAPI — Background Tasks tutorial: <https://fastapi.tiangolo.com/tutorial/background-tasks/>
- Starlette `background.py` source: <https://github.com/encode/starlette/blob/master/starlette/background.py>
- Starlette Thread Pool docs (40-token default): <https://starlette.dev/threadpool/>
- zhanymkanov/fastapi-best-practices (the < 1s rule + the "page someone" rule + the matrix):
  <https://github.com/zhanymkanov/fastapi-best-practices>
- davidmuraya — *FastAPI Background Tasks: built-in vs arq*:
  <https://davidmuraya.com/blog/fastapi-background-tasks-arq-vs-built-in>
- hafiqiqmal93 — *FastAPI's BackgroundTasks Will Burn You in Production*:
  <https://hafiqiqmal93.medium.com/fastapis-backgroundtasks-will-burn-you-in-production-4490a8d403e8>
- Starlette issue #919 (background tasks + `BaseHTTPMiddleware`):
  <https://github.com/Kludex/starlette/issues/919>
- Starlette discussion #1729 (`BaseHTTPMiddleware` limitations):
  <https://github.com/Kludex/starlette/discussions/1729>
- Starlette issue #1438 (background tasks cancelled on client disconnect):
  <https://github.com/encode/starlette/issues/1438>
- FastAPI issue #3589 / #2505 (background-task exceptions with registered handlers):
  <https://github.com/fastapi/fastapi/issues/3589>
- Python asyncio Tasks docs (weak-ref / strong-ref pattern):
  <https://docs.python.org/3/library/asyncio-task.html>
- CPython issue #91887 (strong references for free-flying tasks):
  <https://github.com/python/cpython/issues/91887>
- SuperFastPython — *Asyncio Disappearing Task Bug*:
  <https://superfastpython.com/asyncio-disappearing-task-bug/>
- FastAPI graceful-shutdown discussion #6912: <https://github.com/fastapi/fastapi/discussions/6912>
- PyPI fastapi metadata (version 0.138.0, `starlette>=0.46.0`): <https://pypi.org/pypi/fastapi/json>
- uvicorn settings (`--timeout-graceful-shutdown`): <https://www.uvicorn.org/settings/>

> **Cross-references in this repo:** the `data-pipeline-worker-cron` skill owns the WRITE-path worker
> implementation (cron + `CRON_SECRET` + idempotent upsert) referenced throughout §5. The `02-skills`
> overview doc records that the write-path is a Fly worker. Repo non-negotiable **#4** (in `CLAUDE.md`) is
> the law this reference enforces.
