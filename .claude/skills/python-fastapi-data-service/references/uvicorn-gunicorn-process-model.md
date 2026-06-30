# Uvicorn / Gunicorn Process Model — the ASGI server layer

> **Scope.** This is a `patterns-*`-class build recipe for the **JPM-Markets re-engineering
> data-analytics product line (NOT Lumina)**. It covers the ASGI server that sits in front of the
> FastAPI app: **Uvicorn as the committed server**, the *workers-vs-replication* decision, **graceful
> shutdown on SIGTERM/SIGINT so a rolling Fly deploy drains in-flight requests**, and production
> tuning (`--timeout-graceful-shutdown`, `--timeout-keep-alive`, `--limit-concurrency`,
> `--limit-max-requests`, `--lifespan`). It documents the Gunicorn caveats — including the **v26 removal
> of the eventlet worker** and the **`uvicorn.workers` removal from Uvicorn core** — and explains why
> Gunicorn is *not* in our committed shape. Hypercorn is deferred (HTTP/2/3 termination only).
>
> **Pinned versions (verified June 2026):**
> - **Uvicorn `0.49.0`** — latest on PyPI ([pypi.org/pypi/uvicorn/json](https://pypi.org/pypi/uvicorn/json)).
> - **Gunicorn `26.0.0`** — released **2026-05-05**; **requires Python 3.12+**
>   ([gunicorn.org/install](https://gunicorn.org/install/): *"Gunicorn requires Python 3.12 or newer."*).
> - **`uvicorn-worker 0.4.0`** — released 2025-09-20; the separated Gunicorn-worker package
>   ([pypi.org/project/uvicorn-worker](https://pypi.org/project/uvicorn-worker/)).
> - The canonical Uvicorn docs live at both `uvicorn.org` and `uvicorn.dev`; the FastAPI deployment
>   docs are at `fastapi.tiangolo.com/deployment/`.

---

## 0. The one-paragraph answer (read this first)

**Run a single Uvicorn process per container/machine and let Fly replicate.** That is the committed
shape for this product line. Use `uvicorn app.main:app` (or `fastapi run`) with **no `--workers`** on
Fly, and scale by raising the machine count, not the worker count. Set
`--timeout-graceful-shutdown 25` so a rolling deploy drains in-flight analytics queries before the old
machine dies. **Do not** reach for the legacy `gunicorn -k uvicorn.workers.UvicornWorker` incantation —
that worker class was **removed from Uvicorn core in 0.30** (it now lives in a separate `uvicorn-worker`
package), and Gunicorn **26 dropped the eventlet worker** while gaining its own native ASGI worker. We do
not need Gunicorn at all: Uvicorn has had a built-in multiprocess supervisor (`--workers N`) since 0.30,
which covers the one case (a single fat VM, no orchestrator) where you'd otherwise want a process
manager. Gunicorn is documented here as a *caveat surface*, not a dependency.

The rest of this doc proves each clause of that paragraph against primary sources and gives runnable
config.

---

## 1. Why Uvicorn (the ASGI server, not the framework)

FastAPI is an ASGI **application** — it implements the [ASGI](https://asgi.readthedocs.io/) callable
`async def app(scope, receive, send)`. It does not open sockets, parse HTTP, or manage processes. An
**ASGI server** does that. The three production-grade pure-Python ASGI servers are:

| Server | Maintainer / lineage | HTTP/1.1 | HTTP/2 | HTTP/3 | WebSocket | Notes |
|---|---|---|---|---|---|---|
| **Uvicorn** | Encode (Tom Christie) → now `Kludex/uvicorn` | ✅ (`h11` / `httptools`) | ❌ | ❌ | ✅ | the de-facto standard; what `fastapi run` invokes |
| **Hypercorn** | pgjones | ✅ | ✅ | ✅ (QUIC via `aioquic`) | ✅ | the only one that terminates HTTP/2 & HTTP/3 in-process |
| **Daphne** | Django Channels | ✅ | ✅ | ❌ | ✅ | older; Channels-oriented; rarely chosen for FastAPI now |

**We commit to Uvicorn.** Justification:

1. It is the reference server the FastAPI docs themselves invoke — `fastapi run` *is* Uvicorn under the
   hood, and every FastAPI deployment page shows `uvicorn main:app`
   ([fastapi.tiangolo.com/deployment/server-workers](https://fastapi.tiangolo.com/deployment/server-workers/):
   *"`uvicorn main:app --host 0.0.0.0 --port 8080 --workers 4`"*).
2. For a **JSON/data-analytics API behind Fly's edge proxy**, in-process HTTP/2 and HTTP/3 buy us
   nothing — Fly's proxy (and any CDN/Cloudflare layer) already terminates HTTP/2/3 at the edge and
   speaks HTTP/1.1 to the origin. Terminating HTTP/2 *inside* the app is solving a problem the platform
   already solved (see §11 on Hypercorn).
3. Uvicorn's `httptools` HTTP parser (a Cython wrapper over Node's `llhttp`) is the fastest in the
   Python ecosystem; for a read-heavy analytics service the HTTP layer should never be the bottleneck.

**Falsifiability test for this choice:** if a future requirement is *bidirectional server push over a
single HTTP/2 stream multiplexed with REST on the same origin connection, terminated in-process* (not
WebSocket, not SSE), Uvicorn cannot do it and Hypercorn becomes the answer. That requirement does not
exist for a data-analytics query API, so the choice holds. See §11.

---

## 2. The model that actually runs: one event loop, async I/O, optional pre-fork

Before tuning anything, hold the right mental model:

- **One Uvicorn process = one OS process = one asyncio event loop.** That single loop handles **many
  concurrent connections** by interleaving them at every `await` (an `async def` route that awaits a DB
  query yields the loop to other requests while the query is in flight). This is **concurrency, not
  parallelism** — a single process uses **one CPU core** for Python execution because of the GIL.
- **`--workers N` forks N independent processes**, each with its own loop, behind a shared listening
  socket (the kernel load-balances `accept()` across them). This is how you use **multiple cores in one
  container**. The FastAPI docs: workers let you *"take advantage of multiple cores in the CPU, and be
  able to serve more requests"*
  ([server-workers](https://fastapi.tiangolo.com/deployment/server-workers/)).
- **Replication** (more containers/machines) achieves the same multi-core parallelism **across machines**
  and adds fault isolation + horizontal scale. This is the orchestrator's job.

The decision in §3 is purely: **fork workers inside the box, or run one process and replicate boxes?**
Both reach N cores. They differ in *who manages the N* and *what fails when one dies*.

### 2.1 The blocking-call trap (the #1 way this model breaks)

Async concurrency only works if **nothing blocks the event loop**. A synchronous DB driver call, a
`time.sleep`, a CPU-bound pandas/numpy crunch, or a blocking `requests.get` inside an `async def` route
**freezes the entire loop** — every other in-flight request on that worker stalls until it returns. At
1× demo load this is invisible; at 100× it is a latency cliff.

```python
# WRONG — blocks the loop; all concurrent requests on this worker stall
@app.get("/series/{ticker}")
async def series(ticker: str):
    import time, psycopg2
    conn = psycopg2.connect(DSN)          # sync driver, blocks
    rows = conn.execute(...).fetchall()    # blocks the loop for the whole query
    df = expensive_pandas_resample(rows)   # CPU-bound, blocks the loop
    return df.to_dict()

# RIGHT — async driver awaits (yields loop); CPU work offloaded to a thread
@app.get("/series/{ticker}")
async def series(ticker: str):
    rows = await pool.fetch("SELECT ...", ticker)        # asyncpg: real await
    df = await anyio.to_thread.run_sync(resample, rows)  # CPU work off the loop
    return df.to_dict()
```

For this product line: use **asyncpg / SQLAlchemy 2.0 async / `psycopg` 3 async** for TimescaleDB
(see the `timescaledb-timeseries` skill), and push any pandas/numpy/lttb downsampling math through
`anyio.to_thread.run_sync` (FastAPI's default threadpool, sized via `anyio`) or — for heavy
parallelizable crunching — a `ProcessPoolExecutor`. **Worker count cannot rescue a blocked loop**; it
only multiplies the number of loops you can block.

---

## 3. THE decision: `--workers N` vs platform replication

This is the load-bearing architectural call. FastAPI's own docs give a clear, citable rule.

### 3.1 The official guidance (verbatim)

From the FastAPI **Docker** deployment page
([fastapi.tiangolo.com/deployment/docker](https://fastapi.tiangolo.com/deployment/docker/)):

> *"In those cases, you would probably want to build a Docker image from scratch … and running **a single
> Uvicorn process** instead of using multiple Uvicorn workers."*
>
> *"Having another process manager inside the container (as would be with multiple workers) would only
> add **unnecessary complexity** that you are most probably already taking care of with your cluster
> system."*

From the **Server Workers** page
([fastapi.tiangolo.com/deployment/server-workers](https://fastapi.tiangolo.com/deployment/server-workers/)):

> *"when running on **Kubernetes** you will probably **not** want to use workers and instead run **a single
> Uvicorn process per container**."*

The principle generalizes from Kubernetes to **any orchestrator that already replicates and load-balances
processes — and Fly Machines is exactly that.**

### 3.2 The decision table

| Dimension | `uvicorn --workers N` (fork in container) | Single process + platform replication (**our pick on Fly**) |
|---|---|---|
| Who manages the N | Uvicorn's internal supervisor | The orchestrator (Fly, K8s) |
| Multi-core use | ✅ within one box | ✅ across boxes |
| Fault isolation | ⚠️ one box dies → all N die | ✅ one machine dies → others serve |
| Autoscale granularity | coarse (whole box) | fine (per-machine; Fly `auto_stop`/`auto_start`) |
| Memory model | N copies of the app in one box's RAM | 1 copy per machine; right-size the machine |
| Rolling-deploy drain | supervisor must drain N at once | orchestrator drains machines one-by-one (cleaner) |
| Health-check / restart | Uvicorn restarts dead workers | Fly restarts dead machines |
| Logs / metrics per unit | interleaved across N in one stream | one stream per machine (cleaner attribution) |
| Best when | one fat VM, **no** orchestrator (bare EC2, single Docker host) | **any** orchestrator: Fly, K8s, ECS, Nomad |

### 3.3 The verdict for this product line

**On Fly: one Uvicorn process per machine, Fly replicates. No `--workers`.** Fly Machines is a
distributed container system with its own load balancer (the Fly proxy), rolling deploys, health checks,
and per-machine autoscale (`auto_start_machines` / `auto_stop_machines`). Adding `--workers 4` inside a
Fly machine would (a) duplicate the supervision Fly already provides, (b) couple 4 workers' fates to one
machine's, (c) blur per-process metrics, and (d) make rolling drains drain 4-at-once instead of cleanly
machine-by-machine. This is the *"unnecessary complexity"* the FastAPI docs name.

**The one exception** where you *would* set `--workers`: a non-orchestrated single host — e.g. a local
`docker compose up` for integration testing, or a single bare VM with no Fly/K8s in front. There,
`--workers $(nproc)` (or a tuned subset) is the right way to use all cores without standing up an
orchestrator. State the tier: that shape survives **1×–early-100×** on one box; it does **not** survive
machine failure (single point of failure) and does not autoscale — which is exactly why production is on
Fly with replication.

### 3.4 Concrete Fly shape

`fly.toml` (the committed shape — replication, not in-container workers):

```toml
app = "jpm-markets-data-svc"
primary_region = "iad"

[build]

[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = "stop"     # scale to zero / down when idle
  auto_start_machines = true      # cold-start a machine on incoming request
  min_machines_running = 1        # keep one warm to avoid cold-start on every request
  [http_service.concurrency]
    type = "requests"
    soft_limit = 200              # Fly proxy starts spilling to another machine here
    hard_limit = 250              # Fly proxy stops routing new conns to this machine here

# Drain in-flight requests on rolling deploy (see §5). SIGINT is Fly's default;
# uvicorn handles SIGINT and SIGTERM identically (graceful). 25s leaves headroom
# under uvicorn's own --timeout-graceful-shutdown 25 below.
kill_signal = "SIGINT"
kill_timeout = "30s"

[deploy]
  strategy = "rolling"            # one machine at a time; drains cleanly

[[vm]]
  size = "shared-cpu-2x"
  memory = "1gb"
```

`Dockerfile` CMD (single process, no `--workers`):

```dockerfile
# Bind 0.0.0.0 so Fly's proxy can reach the process; port matches internal_port.
# --timeout-graceful-shutdown 25 < kill_timeout 30s so uvicorn finishes its drain
#   before Fly escalates to SIGKILL.
# --lifespan on makes a failed startup (e.g. DB pool init) crash loudly instead of
#   silently starting a broken machine (see §7).
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--timeout-graceful-shutdown", "25", \
     "--timeout-keep-alive", "20", \
     "--limit-concurrency", "256", \
     "--lifespan", "on", \
     "--no-server-header", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
```

To scale: `fly scale count 6` (six single-process machines) — **not** add `--workers`. To use a bigger
machine for a CPU-heavy aggregate, `fly scale vm shared-cpu-4x` and *then* consider `--workers 2–3` only
if that one machine is genuinely under-utilizing its cores and you've measured it. Default stays
one-process-per-machine.

> **`--forwarded-allow-ips "*"` caveat.** This trusts `X-Forwarded-For` from any peer, which is correct
> *only* because on Fly the sole peer that can reach `internal_port` is Fly's own proxy. If you ever
> expose the port publicly, narrow this to the proxy's CIDR. Never trust forwarded headers from an
> untrusted edge — it lets clients spoof their source IP for rate-limiting/auditing.

---

## 4. The settings that matter — exact defaults from Uvicorn source

All defaults below are read from the Uvicorn CLI definition in
[`uvicorn/main.py`](https://github.com/encode/uvicorn/blob/master/uvicorn/main.py) and the `Config`
constructor in
[`uvicorn/config.py`](https://github.com/encode/uvicorn/blob/master/uvicorn/config.py) (verified against
master, June 2026). **Defaults are quoted verbatim from the `click.option` `default=` and `help=`.**

| Flag | Default | Verbatim help text | Set it to… |
|---|---|---|---|
| `--workers` | `None` → `1` | *"Number of worker processes. Defaults to the `$WEB_CONCURRENCY` environment variable if available, or 1."* | **leave unset on Fly** (one process); on a bare host, `$(nproc)` |
| `--timeout-graceful-shutdown` | `None` (∞) | *"Maximum number of seconds to wait for graceful shutdown."* | **25** (must be < Fly `kill_timeout`) |
| `--timeout-keep-alive` | `5` | *"Close Keep-Alive connections if no new data is received within this timeout (in seconds)."* | **20** (slightly under the edge/LB idle timeout — see §6) |
| `--limit-concurrency` | `None` | *"Maximum number of concurrent connections or tasks to allow, before issuing HTTP 503 responses."* | **256** per process (a backpressure valve — see §8) |
| `--limit-max-requests` | `None` | *"Maximum number of requests to service before terminating the process."* | usually **unset**; set (e.g. 50000) only to paper over a leak — see §9 |
| `--limit-max-requests-jitter` | `0` | *"Maximum jitter to add to limit_max_requests. Staggers worker restarts to avoid all workers restarting simultaneously."* | a few hundred, only if `--limit-max-requests` is set with `--workers` |
| `--lifespan` | `"auto"` | *"Lifespan implementation."* | **`on`** in prod (fail loud on startup) — see §7 |
| `--backlog` | `2048` | *"Maximum number of connections to hold in backlog."* | default; raise only under measured `accept()` pressure |
| `--timeout-worker-healthcheck` | `5` | *"Maximum number of seconds to wait for a worker to respond to a healthcheck."* | default (only relevant with `--workers`) |
| `--proxy-headers / --no-proxy-headers` | `True` | *"Enable/Disable X-Forwarded-Proto, X-Forwarded-For to populate url scheme and remote address info."* | keep on behind Fly's proxy |
| `--forwarded-allow-ips` | `None` | *"Comma separated list of IP Addresses, IP Networks, or literals … to trust with proxy headers."* | `*` on Fly (only the proxy can reach the port) — see §3.4 caveat |
| `--host` | `"127.0.0.1"` | *"Bind socket to this host."* | **`0.0.0.0`** in a container (else the proxy can't reach it — a classic 1× bug) |
| `--port` | `8000` | *"Bind socket to this port. If 0, an available port will be picked."* | match `internal_port` |
| `--h11-max-incomplete-event-size` | `None` | *"For h11, the maximum number of bytes to buffer of an incomplete event."* | default unless you accept very large headers |
| `--log-level` | `None` (→ `info`) | *"Log level. [default: info]"* | `info` (prod), `warning` if access logs are too noisy |
| `--access-log / --no-access-log` | `True` | *"Enable/Disable access log."* | consider `--no-access-log` if Fly logs the request line already |
| `--server-header / --no-server-header` | `True` | *"Enable/Disable default Server header."* | `--no-server-header` (don't advertise the server) |
| `--reset-contextvars` | `False` | *"Run each ASGI request in a fresh contextvars.Context. Hides context set in the lifespan."* | default; flip on only if you rely on per-request contextvars and hit cross-request leakage |
| `--factory` | `False` | *"Treat APP as an application factory, i.e. a () -> <ASGI app> callable."* | on if `app.main:create_app` is a factory |

`Config` constructor defaults (from `config.py`, for the values not exposed identically on the CLI):
`backlog=2048`, `timeout_keep_alive=5`, `timeout_graceful_shutdown=None`, `limit_concurrency=None`,
`limit_max_requests=None`, `lifespan="auto"`, `ws_max_queue=32`, `ws_ping_interval=20.0`,
`ws_ping_timeout=20.0`, `workers=None` (resolved to `1` via `self.workers or 1`).

### 4.1 Configuring without flags: `UVICORN_*` env vars + `$WEB_CONCURRENCY`

Every setting is also reachable via an environment variable with the `UVICORN_` prefix
(e.g. `UVICORN_HOST`, `UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN`), which is handy for Fly secrets/`[env]`
without rebuilding the image. The worker count specifically honors **`$WEB_CONCURRENCY`** (Uvicorn help:
*"Defaults to the `$WEB_CONCURRENCY` environment variable if available, or 1"*) — a Heroku-era convention
many platforms set automatically. **On Fly, leave `WEB_CONCURRENCY` unset** so it stays at 1; an
accidentally-set `WEB_CONCURRENCY` is a silent way to end up forking workers you didn't ask for.

```toml
# fly.toml — settings via env instead of CMD flags (equivalent to the Dockerfile CMD above)
[env]
  UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN = "25"
  UVICORN_TIMEOUT_KEEP_ALIVE = "20"
  UVICORN_LIMIT_CONCURRENCY = "256"
  UVICORN_LIFESPAN = "on"
  # deliberately NOT setting WEB_CONCURRENCY → stays 1 process per machine
```

---

## 5. Graceful shutdown & SIGTERM — the part that makes rolling deploys not drop requests

This is the highest-stakes section. A data-analytics query can take seconds (a wide `time_bucket`
aggregate over a hypertable). If a rolling Fly deploy kills the machine mid-query, the client gets a
truncated/aborted response. Graceful shutdown is what prevents that.

### 5.1 What Uvicorn does on a shutdown signal

Uvicorn installs handlers for **SIGINT and SIGTERM** (and SIGBREAK on Windows). On either signal it
performs a graceful shutdown
([uvicorn.org/server-behavior](https://www.uvicorn.org/server-behavior/),
[encode/uvicorn#853](https://github.com/encode/uvicorn/pull/853)):

1. **Stop accepting new connections.** The listening socket stops `accept()`-ing.
2. **Stop reading new requests on idle keep-alive connections**; let active requests finish.
3. **Wait for in-flight requests to complete** — up to `--timeout-graceful-shutdown` seconds (default
   `None` = wait **forever**).
4. **Run the ASGI lifespan shutdown** (your `lifespan` context-manager teardown / `shutdown` event:
   close the DB pool, flush metrics).
5. **Exit 0.**

If `--timeout-graceful-shutdown` is set and elapses with requests still running, Uvicorn **cancels** the
outstanding tasks and exits anyway — those few requests are sacrificed so the process can die within the
platform's kill window. With the **default `None`, Uvicorn waits indefinitely**, which is dangerous under
a platform `kill_timeout`: the platform sends SIGKILL when *its* timer fires, and SIGKILL cannot be
caught — so you lose the drain *and* the lifespan teardown. **Always set `--timeout-graceful-shutdown`
below the platform's `kill_timeout`.**

> **Multiple workers.** When running `--workers N`, SIGTERM/SIGINT to the parent gracefully shuts down
> the supervisor *and* all workers
> ([uvicorn.org/settings](https://www.uvicorn.org/settings/)). On Fly with one process this is moot, but
> it's why the bare-host shape in §3.3 still drains cleanly.

### 5.2 What Fly does on deploy/stop (and the SIGINT-vs-SIGTERM subtlety)

From the Fly engineering blog
([fly.io/blog/graceful-vm-exits-some-dials](https://fly.io/blog/graceful-vm-exits-some-dials/)) and the
config reference ([fly.io/docs/reference/configuration](https://fly.io/docs/reference/configuration/)):

> *"By default, we send a `SIGINT` to tell a VM it's time to go away. Then we wait 5 seconds and, if the
> VM is still running, we forcefully terminate it."*

- **Default `kill_signal` is `SIGINT`** (not SIGTERM). Overridable to
  `SIGTERM | SIGQUIT | SIGUSR1 | SIGUSR2 | SIGKILL | SIGSTOP`.
- **Default `kill_timeout` is 5 seconds** — *too short for a multi-second analytics query.* Max **300s
  (5 min) on shared CPU**, **24h on dedicated CPU**.
- After `kill_timeout`, Fly sends **SIGKILL** (uncatchable).

**Why this is fine for Uvicorn:** Uvicorn drains gracefully on **both SIGINT and SIGTERM**, so Fly's
default SIGINT already triggers Uvicorn's graceful path — *no `kill_signal` override is strictly
required.* The two things you **must** do:

1. **Raise `kill_timeout`** from the 5s default to something that fits your slowest in-flight request
   (e.g. `"30s"`), so Fly waits for the drain instead of SIGKILL-ing mid-query.
2. **Set Uvicorn's `--timeout-graceful-shutdown` *below* `kill_timeout`** (e.g. `25` < `30s`) so Uvicorn
   finishes (or cancels stragglers) and exits 0 cleanly **before** Fly escalates to SIGKILL.

The relationship that must hold:

```
slowest normal request   <   --timeout-graceful-shutdown   <   Fly kill_timeout
        (e.g. ~15s)               (e.g. 25s)                      (e.g. 30s)
```

> **Known Fly footguns (community-reported, worth guarding against):**
> [SIGTERM not respecting `kill_timeout`](https://community.fly.io/t/sigterm-sent-twice-not-respecting-kill-timeout-then-virtual-machine-exited-abruptly/15720)
> and [SIGTERM cleanup not running](https://community.fly.io/t/sigterm-cleanup-function-not-running-when-vm-is-shut-down/8551).
> The usual root cause is **PID 1 signal handling**: if your container's PID 1 is a shell (`sh -c "uvicorn …"`)
> rather than Uvicorn itself, the shell may not forward signals, so Uvicorn never sees SIGINT/SIGTERM and
> Fly SIGKILLs it. **Make Uvicorn PID 1**: use exec-form `CMD ["uvicorn", …]` (JSON array, *not*
> `CMD uvicorn …` shell-form), or front it with `tini` (`ENTRYPOINT ["tini","--"]`). The exec-form CMD in
> §3.4 already does this. **Verify in CI** that the signal path actually drains (see §10).

### 5.3 Rolling deploy: the full drain timeline

`[deploy] strategy = "rolling"` takes machines down **one at a time** (config reference:
*"One by one, each running Machine is taken down and replaced"*). For each old machine:

```
t=0    Fly proxy stops routing NEW requests to this machine (it's draining).
t=0    Fly sends kill_signal (SIGINT by default) to PID 1 (Uvicorn).
t=0+   Uvicorn: stop accept(); stop reading on idle keep-alives; finish in-flight queries.
t≤25s  All in-flight queries done → lifespan shutdown (close DB pool) → exit 0. CLEAN.
       (or) t=25s: --timeout-graceful-shutdown fires → cancel stragglers → exit 0.
t<30s  Process has exited before Fly's kill_timeout → no SIGKILL. Machine replaced.
```

Because the proxy stops routing *before* signalling, and Uvicorn drains the rest, **no client request is
dropped** as long as the timeout chain in §5.2 holds. This is the entire point of the configuration.

### 5.4 Lifespan teardown — close the pool *in* the shutdown, not after

The DB connection pool (asyncpg/SQLAlchemy) must close during the **lifespan shutdown**, which Uvicorn
runs as the *last* step of graceful shutdown (§5.1 step 4). Use the modern `lifespan` context manager:

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
import asyncpg

@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- startup (runs BEFORE the server accepts traffic) ---
    app.state.pool = await asyncpg.create_pool(dsn=DSN, min_size=2, max_size=10)
    yield
    # --- shutdown (runs DURING uvicorn graceful shutdown, after drain) ---
    await app.state.pool.close()   # waits for checked-out conns to return; closes cleanly

app = FastAPI(lifespan=lifespan)
```

If you close the pool *before* the drain completes, in-flight queries lose their connection and error —
the opposite of graceful. The `lifespan` contract guarantees shutdown runs *after* the request drain, so
put pool teardown there and nowhere else.

---

## 6. `--timeout-keep-alive` — the idle-connection / 502 dance with the edge

**Default `5`** seconds: *"Close Keep-Alive connections if no new data is received within this timeout."*

For an API behind a proxy/load balancer (Fly's proxy, an ALB, Cloudflare), the failure mode is a **race
on idle keep-alive connections**:

- The proxy keeps a pooled connection open to the origin and reuses it for the next request.
- If the **origin's** keep-alive timeout is *shorter* than the **proxy's**, the origin can close the
  connection in the exact window the proxy picks it to send a new request → the proxy sees a reset →
  client gets a **502**.

The rule: **the origin's keep-alive timeout should be ≥ the proxy's idle timeout** (or close enough that
the proxy notices the close before reusing). Hyperscaler ALBs default to 60s idle; that's why AWS guides
say to set Uvicorn/Gunicorn keep-alive *above* 60. On Fly the proxy is more forgiving, but the principle
holds. We set **`--timeout-keep-alive 20`** as a middle ground that comfortably exceeds typical
short-lived analytics request gaps while not pinning idle connections forever. **State the tier:** at 1×
nobody hits this; at 100× concurrent clients behind a pooling proxy, a mistuned keep-alive shows up as
intermittent 502s that are maddening to diagnose — set it deliberately now.

> Do **not** confuse `--timeout-keep-alive` (idle keep-alive) with a *request* timeout. Uvicorn has **no
> per-request hard timeout** — a slow handler runs until it finishes. Enforce per-request deadlines in
> the app (an `asyncio.timeout(…)` wrapper / a middleware) or at the DB (`statement_timeout`), not at the
> server. This is a real gap vs Gunicorn's `--timeout` (which kills a worker stuck on a sync request) —
> but Gunicorn's timeout is a sync-worker concept that doesn't map to an async loop anyway (see §9.1).

---

## 7. `--lifespan auto|on|off` — fail loud on a broken startup

**Default `"auto"`**: Uvicorn tries the ASGI lifespan protocol and, if the app responds that it doesn't
support lifespan, silently continues. The risk: a **startup error gets swallowed**. If your `lifespan`
startup raises (DB unreachable, bad secret), under `auto` Uvicorn may log a warning and **start anyway**
— booting a machine that 500s every request. Under a rolling deploy, that broken machine can even pass a
shallow TCP health check and take traffic.

**Set `--lifespan on` in production.** Then a startup exception **aborts the boot** — the process exits
non-zero, Fly marks the machine unhealthy, and the rolling deploy **halts/rolls back instead of replacing
good machines with broken ones**. This is the single cheapest guard against a bad deploy. (`off` disables
lifespan entirely — only correct if the app genuinely has no startup/shutdown hooks, which ours does
not.)

Pair it with a **real readiness health check** that exercises the DB, so Fly never routes to a machine
whose pool is dead:

```python
@app.get("/healthz")          # liveness: process is up
async def healthz():
    return {"ok": True}

@app.get("/readyz")           # readiness: DB reachable — wire this to Fly's [[http_service.checks]]
async def readyz():
    async with app.state.pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"ready": True}
```

---

## 8. `--limit-concurrency` — the backpressure valve (503 over cap)

**Default `None`** (unbounded): *"Maximum number of concurrent connections or tasks to allow, before
issuing HTTP 503 responses."*

Without a limit, a traffic spike or a slow upstream (a hammered TimescaleDB) lets connections pile up
**unbounded** in one process: memory climbs, the event loop's ready queue grows, latency degrades for
*everyone*, and the machine can OOM-kill — a hard crash that drops every in-flight request instead of
shedding a few. This is the classic **Tier-1-looks-fine, Tier-2-falls-over** trap.

Setting `--limit-concurrency 256` makes the process **shed load deterministically**: once 256 requests
are in flight, the 257th gets an immediate **HTTP 503** instead of joining an unbounded queue. A 503 is a
*signal* — the Fly proxy / client can retry against another machine, and the cap protects the DB from a
thundering herd. **Degrade gracefully, don't die** (R-SCALE §C).

Tuning: the right cap ≈ how many concurrent requests this process+DB can serve at acceptable latency.
Derive it, don't guess: if a typical query holds a DB connection for ~50ms and the asyncpg pool is
`max_size=10`, the process can truly progress ~10 DB-bound requests at once; a cap of ~25–50× the pool
size (256 here) leaves headroom for non-DB work and brief bursts while still bounding memory. **Coordinate
the cap with the Fly proxy `hard_limit`** (§3.4): the proxy should stop routing *before* the process
starts 503-ing, so 503s are the last line of defense, not the first.

> **What counts toward the limit.** It bounds concurrent ASGI requests/tasks, not raw TCP. Long-lived
> SSE/WebSocket streams each consume one slot the whole time they're open — if you add streaming
> endpoints, size the cap with that in mind or those streams will starve normal requests.

---

## 9. `--limit-max-requests` — process recycling (use sparingly)

**Default `None`**: *"Maximum number of requests to service before terminating the process."* Paired with
**`--limit-max-requests-jitter`** (default `0`): *"Maximum jitter to add to limit_max_requests. Staggers
worker restarts to avoid all workers restarting simultaneously."*

This recycles the process after N requests — Gunicorn's `max_requests` equivalent. Its **only legitimate
use is to bound a slow memory leak** (a C-extension or a cache that grows unboundedly) by periodically
restarting before RAM runs out. It is a **mitigation, not a fix** — a "controlled restart to paper over a
leak we haven't rooted out."

For this product line, **leave it unset by default** and instead find the leak (see the no-hacks rule).
If you do set it (e.g. while a leak is being chased), and you're running `--workers N`, **always add
jitter** so all N workers don't recycle on the same request count and create a synchronized
capacity dip:

```bash
# Only on a single fat host WITH --workers, and only while chasing a known leak:
uvicorn app.main:app --workers 4 --limit-max-requests 50000 --limit-max-requests-jitter 5000
```

On Fly (one process per machine), recycling a process = the machine briefly has no server; prefer Fly's
own machine-restart/health mechanisms over per-process recycling.

### 9.1 Note: no async equivalent of Gunicorn's `--timeout` worker-kill

Gunicorn's sync workers have a `--timeout` that **kills a worker stuck processing one request**. Uvicorn
has no such per-request worker-kill, *because in an async model a single slow request does not block the
worker* — the loop keeps serving other requests while one awaits. A request that hangs forever is an
*application* bug (a missing `asyncio.timeout`, a DB query with no `statement_timeout`), and the fix
belongs in the app/DB, not the server. Don't go looking for a Uvicorn `--timeout` flag; it deliberately
doesn't exist.

---

## 10. Verifying the signal path actually drains (do this in CI, not in prod)

The graceful-shutdown config is worthless if a PID-1/signal-forwarding bug means Uvicorn never sees the
signal (§5.2). Prove it locally:

```bash
# 1. Start the server.
uvicorn app.main:app --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 25 &
PID=$!

# 2. Fire a slow request in the background (a route that sleeps ~8s server-side).
curl -s http://localhost:8000/slow-test &
CURL=$!

# 3. Send Fly's default signal (SIGINT) — mid-request.
sleep 1
kill -INT "$PID"

# 4. The slow request must STILL complete with 200 (graceful drain), and the
#    process must exit 0 only AFTER it finishes — not immediately.
wait "$CURL" && echo "DRAINED OK"   # if curl got 200, the drain worked
wait "$PID";  echo "uvicorn exit=$?"  # expect 0
```

Repeat with `kill -TERM "$PID"` to confirm SIGTERM behaves identically. In a container, run the same
through `docker stop` (which sends SIGTERM then SIGKILL after a grace period) to catch PID-1 issues:

```bash
docker run -d --name svc -p 8000:8000 jpm-markets-data-svc
# fire a slow request, then:
time docker stop svc      # should take ~as long as the in-flight request, then exit cleanly
                          # if it takes the full 10s docker default → SIGKILL → your signal path is broken
```

If `docker stop` always takes the full 10s default grace (then SIGKILLs), Uvicorn is not receiving the
signal — fix PID 1 (exec-form CMD or `tini`).

---

## 11. Gunicorn — the caveats (why it's NOT in our committed shape)

Gunicorn is a battle-tested **pre-fork WSGI process manager**. Historically the canonical FastAPI
production line was `gunicorn -k uvicorn.workers.UvicornWorker` — Gunicorn supervised N pre-forked
Uvicorn workers. **That recommendation is now obsolete on multiple counts.** Document this so nobody
copies a stale 2022 blog into our Dockerfile.

### 11.1 The `uvicorn.workers` module was REMOVED from Uvicorn core (0.30)

In **Uvicorn 0.30** the `uvicorn.workers` module was **deprecated and moved out of core** into a separate
package, **`uvicorn-worker`**
([Kludex/uvicorn#2302](https://github.com/Kludex/uvicorn/pull/2302),
[uvicorn-worker on PyPI](https://pypi.org/project/uvicorn-worker/), latest **0.4.0**, 2025-09-20). So:

- **`gunicorn -k uvicorn.workers.UvicornWorker` → `ModuleNotFoundError`** on modern Uvicorn. The class no
  longer ships with Uvicorn.
- The correct modern incantation, *if you insist on Gunicorn supervision*, is to install `uvicorn-worker`
  and use **`gunicorn app:app -k uvicorn_worker.UvicornWorker`** (note the underscore and the separate
  package). `uvicorn-worker` also ships `uvicorn_worker.UvicornH11Worker` for PyPy.

This is the single most common stale-config bug. Search the codebase and any vendored Dockerfile for
`uvicorn.workers.UvicornWorker` and delete it.

### 11.2 Uvicorn already has its own multiprocess supervisor

Since **0.30**, Uvicorn ships a built-in multiprocess **`--workers N`** supervisor (the work that used to
*be* the reason to put Gunicorn in front). So the historical justification for Gunicorn — "Uvicorn can't
manage multiple workers / restart dead ones" — **no longer holds**. For the one non-orchestrated
single-host case (§3.3), `uvicorn --workers N` covers it without a second process manager.

### 11.3 Gunicorn 26 dropped the eventlet worker (a real breakage)

From the Gunicorn **26.0.0** release notes
([github.com/benoitc/gunicorn/releases/tag/26.0.0](https://github.com/benoitc/gunicorn/releases/tag/26.0.0),
released **2026-05-05**):

> **Breaking Changes:** *"The `eventlet` worker class has been dropped. Migrate to `gevent`, `gthread`,
> or `tornado`."*

So **`gunicorn -k eventlet` now fails** — eventlet is unmaintained upstream, the worker was deprecated in
25.x and is gone in 26. If any legacy service (or a copied config) used `-k eventlet`, the 26 upgrade
breaks it; migrate to `gevent`/`gthread`/`tornado`. **This does not affect us** (we run no eventlet), but
it's the kind of caveat that bites a team that vendored an old Flask+eventlet config alongside a new
service.

### 11.4 Gunicorn 26 added a NATIVE ASGI worker (`-k asgi`)

Also new in 26: Gunicorn grew its **own native asyncio ASGI worker**, so you can run FastAPI under
Gunicorn **without** Uvicorn at all
([gunicorn.org/asgi](https://gunicorn.org/asgi/)):

```bash
gunicorn app.main:app --worker-class asgi --bind 0.0.0.0:8000   # or: -k asgi
```

Notes from the ASGI worker docs:
- The worker class string is **`"asgi"`** (`-k asgi` / `--worker-class asgi`).
- **`--threads` has no effect** on the ASGI worker (it's a sync-worker concept); use
  **`--worker-connections`** to bound per-worker concurrency.
- Lifespan via **`--asgi-lifespan auto|on|off`** (default `auto`).
- `--graceful-timeout` is Gunicorn's analogue of Uvicorn's `--timeout-graceful-shutdown`.

Gunicorn 26 also requires **Python 3.12+** ([gunicorn.org/install](https://gunicorn.org/install/):
*"Gunicorn requires Python 3.12 or newer."*) and uses a faster C HTTP parser (`gunicorn_h1c >= 0.6.5` on
CPython). The native ASGI worker passes 438/444 of the cross-framework compatibility suite (~98%).

**Does this change our choice? No.** Gunicorn's native ASGI worker is a credible alternative *server*, but
adopting it would mean depending on Gunicorn's process model + its newer (less battle-proven on ASGI)
HTTP path, for **zero benefit over a single Uvicorn process per Fly machine**. The orchestrator already
provides the supervision Gunicorn exists to give. We note it as the modern shape *if you're ever forced
onto a single fat host and prefer Gunicorn's supervisor ergonomics* — but the committed default stays
plain Uvicorn.

### 11.5 Decision: Gunicorn is a documented caveat, not a dependency

| Question | Answer |
|---|---|
| Do we ship Gunicorn? | **No.** Plain Uvicorn, one process per Fly machine. |
| Is `gunicorn -k uvicorn.workers.UvicornWorker` valid? | **No** — removed from Uvicorn core in 0.30; would need `uvicorn-worker` + `uvicorn_worker.UvicornWorker`. |
| Is `gunicorn -k eventlet` valid? | **No** — dropped in Gunicorn 26. |
| If we *had* to use Gunicorn for ASGI today | use **`-k asgi`** (native, Gunicorn 26+) or **`-k uvicorn_worker.UvicornWorker`** (uvicorn-worker pkg). |
| When would Gunicorn make sense? | a **single non-orchestrated host** where you want Gunicorn's supervisor ergonomics; even then `uvicorn --workers N` is simpler. |

---

## 12. Hypercorn — deferred (HTTP/2 / HTTP/3 only)

[Hypercorn](https://github.com/pgjones/hypercorn) is the only mainstream ASGI server that **terminates
HTTP/2 and HTTP/3 (QUIC, via `aioquic`) in-process**. We **defer** it: a JSON data-analytics API behind
Fly's edge gets HTTP/2/3 termination *at the edge* for free, and the origin speaks HTTP/1.1 — which
Uvicorn does faster. Adopt Hypercorn **only** if a concrete requirement appears that the edge cannot
satisfy, e.g.:

- **in-process HTTP/2 multiplexing** of many concurrent streams over a single origin connection (not just
  edge→origin pooling), or
- **HTTP/3/QUIC terminated by the app itself** (an unusual requirement when a CDN/edge already does it), or
- a single deployment that must speak HTTP/2 to clients with **no proxy in front** at all.

None of these is true for this product line today. If one becomes true, the migration is mostly a CMD
swap (`hypercorn app.main:app --bind 0.0.0.0:8000`) plus re-tuning equivalents of the graceful-shutdown /
keep-alive / concurrency knobs — the app code (ASGI/FastAPI) is unchanged. Until then, Uvicorn stands.

---

## 13. R-SCALE summary — which tier this survives

| Surface | Tier-1 (demo) | Tier-2 (100×, early traction) | Tier-3 (10,000×, product) | Our position |
|---|---|---|---|---|
| **Process model** | one `uvicorn` proc, defaults | one proc/machine + a few Fly machines | many machines, autoscaled, drained rolling deploys | committed shape (§3.3); scale = `fly scale count`, not `--workers` |
| **Graceful shutdown** | none (SIGKILL drops requests) | `--timeout-graceful-shutdown` < `kill_timeout`; rolling drain | same + verified PID-1 signal path in CI (§10) | §5 — set the timeout chain, verify it |
| **Backpressure** | unbounded (OOM under spike) | `--limit-concurrency` 503 valve + Fly `hard_limit` | + per-request `asyncio.timeout` + DB `statement_timeout` | §8 — cap derived from pool size, not guessed |
| **Startup safety** | `--lifespan auto` (swallows errors) | `--lifespan on` + `/readyz` DB check halts bad deploys | + canary/bluegreen strategy for risky releases | §7 |
| **Keep-alive / 502s** | default 5s (invisible at 1×) | tune `--timeout-keep-alive` vs edge idle timeout | same, monitored | §6 |

**The break this doc prevents:** shipping a Tier-1 `uvicorn app.main:app` with stock defaults — no
graceful-shutdown timeout, no concurrency cap, `--lifespan auto`, host left at `127.0.0.1` — and
believing it's production-ready. It demos perfectly; then the first rolling deploy drops in-flight
analytics queries, the first spike OOM-kills a machine, and a bad migration silently boots broken
machines. Set the five knobs in §3.4 / §4 deliberately and the same code survives Tier-2/3.

---

## 14. Copy-paste cheat sheet

**Committed Fly production command (single process, drains, sheds load, fails loud):**

```bash
uvicorn app.main:app \
  --host 0.0.0.0 --port 8000 \
  --timeout-graceful-shutdown 25 \   # < Fly kill_timeout (30s)
  --timeout-keep-alive 20 \          # ≳ edge idle timeout, avoid 502 race
  --limit-concurrency 256 \          # 503 backpressure valve
  --lifespan on \                    # abort boot on startup error
  --no-server-header \
  --proxy-headers --forwarded-allow-ips '*'   # behind Fly's proxy only
```

**`fly.toml` essentials:** `[deploy] strategy="rolling"`, `kill_timeout="30s"`,
`min_machines_running=1`, `[http_service.concurrency] hard_limit=250`. Scale with
`fly scale count N` / `fly scale vm <size>`, **never `--workers` on Fly.**

**Bare single host (no orchestrator) only:**

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers $(nproc) \
  --timeout-graceful-shutdown 25 --lifespan on --limit-concurrency 256
```

**Things that are WRONG (don't copy from old blogs):**

- `gunicorn -k uvicorn.workers.UvicornWorker` — removed from Uvicorn core (0.30). → `uvicorn-worker` pkg or plain Uvicorn.
- `gunicorn -k eventlet` — dropped in Gunicorn 26. → `gevent`/`gthread`/`tornado`/`asgi`.
- `--host 127.0.0.1` in a container — the proxy can't reach it. → `0.0.0.0`.
- `--lifespan auto` in prod — swallows startup errors. → `on`.
- `--workers N` on Fly/K8s — duplicates the orchestrator. → one process, replicate machines.
- shell-form `CMD uvicorn …` — breaks PID-1 signal forwarding → no graceful drain. → exec-form JSON CMD or `tini`.
- no `--timeout-graceful-shutdown` under a platform `kill_timeout` — waits forever, gets SIGKILLed mid-query. → set it below `kill_timeout`.

---

## Sources (primary, read June 2026)

- Uvicorn settings & CLI defaults: [uvicorn.org/settings](https://www.uvicorn.org/settings/) ·
  [`uvicorn/main.py`](https://github.com/encode/uvicorn/blob/master/uvicorn/main.py) ·
  [`uvicorn/config.py`](https://github.com/encode/uvicorn/blob/master/uvicorn/config.py)
- Uvicorn server behavior / signals / graceful shutdown:
  [uvicorn.org/server-behavior](https://www.uvicorn.org/server-behavior/) ·
  [encode/uvicorn#853 (graceful shutdown on SIGTERM with workers)](https://github.com/encode/uvicorn/pull/853) ·
  [uvicorn.dev/deployment](https://uvicorn.dev/deployment/)
- `uvicorn.workers` removal → `uvicorn-worker` pkg:
  [Kludex/uvicorn#2302](https://github.com/Kludex/uvicorn/pull/2302) ·
  [pypi.org/project/uvicorn-worker](https://pypi.org/project/uvicorn-worker/)
- FastAPI deployment (workers vs replication, one-process-per-container):
  [fastapi.tiangolo.com/deployment/server-workers](https://fastapi.tiangolo.com/deployment/server-workers/) ·
  [fastapi.tiangolo.com/deployment/docker](https://fastapi.tiangolo.com/deployment/docker/)
- Gunicorn 26: [release notes 26.0.0](https://github.com/benoitc/gunicorn/releases/tag/26.0.0) ·
  [2026 changelog](https://gunicorn.org/2026-news/) · [install (Python 3.12+)](https://gunicorn.org/install/) ·
  [native ASGI worker](https://gunicorn.org/asgi/) · [design / pre-fork](https://gunicorn.org/design/)
- Fly graceful exits / signals / deploy:
  [fly.io/blog/graceful-vm-exits-some-dials](https://fly.io/blog/graceful-vm-exits-some-dials/) ·
  [fly.io/docs/reference/configuration](https://fly.io/docs/reference/configuration/)
- Versions: [pypi.org/pypi/uvicorn/json](https://pypi.org/pypi/uvicorn/json) (0.49.0) ·
  [pypi.org/pypi/gunicorn/json](https://pypi.org/pypi/gunicorn/json) (26.0.0, 2026-05-05)
