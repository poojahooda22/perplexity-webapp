# Deploying the persistent Python data plane on Fly.io

> **Skill:** `python-fastapi-data-service` · **Product line:** the **JPM-Markets re-engineering
> data-analytics product line — NOT Lumina.** This is a *new* Python / FastAPI / data-engineering
> stack, separate from Lumina's Bun + Express + Prisma + Upstash app. Nothing here ships to Lumina;
> the two repos only share a filesystem home (see [`cto-rules.md`](../../rules/cto-rules.md) §"Scope note").
>
> **What this reference owns (and what it deliberately does NOT).** This is the **deploy** reference:
> how the persistent FastAPI read service runs on **Fly.io** — `fly.toml`, the Dockerfile wiring, the
> `/health` route + `internal_port` match, rolling/zero-downtime deploys, graceful shutdown, the
> Volume-vs-managed-DB store decision, secrets → `pydantic-settings`, the `CRON_SECRET`-guarded
> trigger route — **and the first-principles argument for why this data plane CANNOT be a Vercel
> serverless function.** It does **not** re-teach: the lifespan internals / resource wiring (that is
> [`fastapi-app-structure-and-lifespan.md`](fastapi-app-structure-and-lifespan.md)), the
> `BackgroundTasks`-vs-worker boundary and the cron job *body* (that is
> [`background-work-and-the-worker-boundary.md`](background-work-and-the-worker-boundary.md)), or
> where the data plane sits in the polyglot topology (that is
> [`lumina-data-plane-topology.md`](lumina-data-plane-topology.md)). This doc is the *host*; those are
> the *app*.
>
> **Why it mirrors the repo's `worker/`.** Lumina already runs one always-on process on Fly — the
> [`worker/`](../../../worker/) price worker — for exactly the reason this data plane needs Fly:
> *Vercel serverless functions can't hold a persistent socket* ([`worker/README.md`](../../../worker/README.md)
> §"Why it's a separate service"). The data plane generalises that worker's `fly.toml` /
> `Dockerfile` / always-on pattern to an **inbound-HTTP** service. We cite that existing config as the
> proven in-repo pattern throughout.
>
> **Greenfield.** No data-plane `file:line` exists yet. Citations are to (a) primary Fly.io /
> FastAPI / pydantic docs read this session, (b) the existing repo's `worker/` as the *pattern
> source*, and (c) the project research docs. Where a version or schema key is load-bearing, it is
> pinned and dated; **verify against the live Fly schema at build time** — Fly's config has changed
> shape before (legacy `[[services]]` → `[http_service]`).
>
> **Versions / facts pinned this session (2026-06, verify before relying):**
> - Fly.io `fly.toml` reference — current `[http_service]` + `[checks]` + `[[vm]]` + `[mounts]` +
>   `[deploy]` schema ([fly.io/docs/reference/configuration](https://fly.io/docs/reference/configuration/)).
> - Fly default `kill_signal` = **`SIGINT`**; `kill_timeout` default **5 s**, max **300 s** shared /
>   **24 h** dedicated ([fly.io/blog/graceful-vm-exits-some-dials](https://fly.io/blog/graceful-vm-exits-some-dials/),
>   [config reference](https://fly.io/docs/reference/configuration/)).
> - Fly FastAPI canonical: `uvicorn main:app --host 0.0.0.0 --port 8080`, `internal_port = 8080`
>   ([fly.io/docs/python/frameworks/fastapi](https://fly.io/docs/python/frameworks/fastapi/) + the
>   community health-check thread cited in §3).
> - **Fly Managed Postgres (MPG)** supports only **pgvector + PostGIS** as third-party extensions —
>   **NOT `timescaledb`** ([fly.io/docs/mpg/extensions](https://fly.io/docs/mpg/extensions/)). TimescaleDB
>   exists only on the **legacy unmanaged Postgres Flex** image `flyio/postgres-flex-timescaledb:16`
>   ([fly.io/docs/postgres/getting-started/enabling-timescale](https://fly.io/docs/postgres/getting-started/enabling-timescale/)).
> - Vercel added FastAPI **lifespan** support **2025-12-09**, with a hard **500 ms** post-SIGTERM
>   cleanup cap ([vercel.com/changelog/fastapi-lifespan-events-are-now-supported-on-vercel](https://vercel.com/changelog/fastapi-lifespan-events-are-now-supported-on-vercel),
>   confirmed via the Vercel community threads in §8).
> - FastAPI **0.138.0** (2026-06-20), Python **3.11+**, `pydantic-settings` **2.x**, `uvicorn` current
>   line with `--timeout-graceful-shutdown` ([uvicorn settings](https://uvicorn.dev/settings/)).

---

## Table of contents

0. [Plain-language on-ramp (the "so what")](#0-on-ramp)
1. [The decision, stated once: Fly, not Vercel — the framework-level WHY](#1-why-not-vercel)
2. [The Dockerfile — image, port, the uvicorn entrypoint](#2-dockerfile)
3. [`fly.toml` essentials — every section, annotated](#3-fly-toml)
4. [The `/health` route + lifespan readiness](#4-health-route)
5. [Rolling / zero-downtime deploys + the graceful-shutdown handshake](#5-rolling-deploy)
6. [The store: Fly Volume vs Timescale (Tiger) Cloud — and NOT Fly Managed Postgres](#6-the-store)
7. [Secrets: `fly secrets set` → `pydantic-settings`](#7-secrets)
8. [The `CRON_SECRET`-guarded trigger route for the write path](#8-cron-trigger)
9. [The WHY-NOT-VERCEL section in full (map onto repo non-negotiable #4)](#9-why-not-vercel-full)
10. [The complete deploy runbook](#10-runbook)
11. [Anti-patterns quick table](#11-anti-patterns)
12. [Sources](#12-sources)

---

## 0. Plain-language on-ramp (the "so what") <a name="0-on-ramp"></a>

This product line has two kinds of process. One is the **gateway** (TypeScript/Express on Vercel):
stateless, edge, dies after each request — perfect for serverless. The other is the **data plane**
(this Python/FastAPI service): it holds a **database connection pool**, a **shared `httpx` client**,
and **in-memory continuous-aggregate caches** that must *survive across requests* so the second
caller doesn't pay the cold-start price the first one did. A process that must keep things warm
between requests is, by definition, **not serverless** — it is a **long-lived server**.

Fly.io runs long-lived servers (it boots a Firecracker microVM and keeps it running); Vercel runs
ephemeral functions (it boots, handles one request — possibly a few — then freezes/discards). That
is the entire reason the plan pins the data plane to Fly. This doc is the recipe for the Fly side
*and* the rigorous argument for why the Vercel side would silently break the data plane's core
guarantees — so nobody six months from now "simplifies" the architecture by moving the FastAPI app
onto Vercel and quietly destroys the connection pool.

The in-repo proof point: Lumina **already** runs the [`worker/`](../../../worker/) price worker on
Fly for the same class of reason — a persistent **outbound** WebSocket Vercel can't hold. This data
plane is the **inbound-HTTP** generalisation of that worker. We copy its `fly.toml` shape and add an
`[http_service]`, health checks, and a Volume.

---

## 1. The decision, stated once: Fly, not Vercel — the framework-level WHY <a name="1-why-not-vercel"></a>

Stated up front so the rest reads as *how*, not *whether*. The full evidence is §9; the verdict:

> **The persistent Python data plane runs on Fly.io as a long-lived Uvicorn process inside a
> Firecracker VM. It is NOT a Vercel serverless function.** The disqualifier is not preference —
> it is that a serverless function **cannot hold the four things this service is built around**:
>
> | The thing the data plane needs to hold | Why serverless cannot | Where it's defined |
> |---|---|---|
> | A **DB connection pool** (asyncpg `Pool`, opened once in lifespan) | Each cold boot is a fresh process with a fresh empty pool; pools don't survive freeze/thaw. At spike, N concurrent invocations open N pools → `too many connections` on Postgres. | [`fastapi-app-structure-and-lifespan.md`](fastapi-app-structure-and-lifespan.md) §pool |
> | A **shared `httpx.AsyncClient`** (write path; keep-alive + TLS reuse) | Same — a per-invocation client throws away keep-alive and burns the upstream rate budget (EDGAR/Treasury throttle). | same ref §client |
> | **In-memory hot state** (cagg results, computed cards) | Frozen/discarded between invocations; the "compute-once-serve-many" guarantee evaporates — every caller is a cold caller. | [`lumina-data-plane-topology.md`](lumina-data-plane-topology.md) §read-never-fetches |
> | **The lifespan startup actually running, reliably, once** | On serverless, lifespan runs per *instance* cold start (or historically not at all); state you set there is gone on the next instance. | §8, §9 |
>
> This maps directly onto Lumina **non-negotiable #4** — *"Vercel can't hold sockets or timers;
> WebSockets/pollers go in `worker/` (Fly); scheduled work is an external cron"*
> ([`CLAUDE.md`](../../../CLAUDE.md) §"Cross-cutting non-negotiables"). A connection **pool** and a
> shared **httpx client** are the same class of object as a socket: *long-lived, process-bound, not
> serializable across a freeze*. The data plane is the FastAPI analogue of `worker/`.

The gateway (Express, stateless) **stays** on Vercel — it is the right tool for the edge/auth/rate-
limit job. The split is deliberate: serverless for the stateless edge, a long-lived VM for the
stateful data plane. Do not collapse them.

---

## 2. The Dockerfile — image, port, the uvicorn entrypoint <a name="2-dockerfile"></a>

Fly builds your app from a `Dockerfile` (it can also use buildpacks, but for a data service you want
the control of an explicit Dockerfile, exactly as `worker/` does —
[`worker/Dockerfile`](../../../worker/Dockerfile) is a 7-line explicit Dockerfile). The
load-bearing facts, from Fly's own FastAPI guidance and the community deploy thread:

- **Bind to `0.0.0.0`, not `127.0.0.1`.** *"You need to bind the server to `0.0.0.0` so traffic
  coming from outside of the container is accepted; otherwise it will not be reachable from outside
  the container."* — Fly community / FastAPI deploy thread
  ([community.fly.io health-check-on-port-8080](https://community.fly.io/t/health-check-on-port-8080-has-failed-for-fastapi/21043)).
  A `127.0.0.1` bind is the #1 cause of "health check on port 8080 failed" on Fly.
- **The canonical command is `uvicorn main:app --host 0.0.0.0 --port 8080`** and the canonical
  internal port is **8080** ([fly.io/docs/python/frameworks/fastapi](https://fly.io/docs/python/frameworks/fastapi/);
  the `fly-apps/hello-fastapi` example uses Python-slim + uvicorn on 8080).
- **The container port MUST equal `[http_service].internal_port` in `fly.toml`** (§3). If they
  disagree, Fly's proxy sends traffic to a port nothing is listening on → every health check fails →
  the deploy never goes healthy.

### 2.1 A production Dockerfile (multi-stage, `uv`-based, non-root)

```dockerfile
# syntax=docker/dockerfile:1
# ---- builder: resolve + install deps into a venv ----
FROM python:3.12-slim AS builder
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# uv is the current fast resolver/installer (Astral). pip works too; uv is just faster CI.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
# --frozen: fail if the lock is out of date (reproducible builds, no silent drift)
RUN uv sync --frozen --no-dev

# ---- runtime: copy only the venv + source ----
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"
# Run as a non-root user (defence in depth; Fly does not require root)
RUN useradd --create-home --uid 10001 appuser
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY ./src ./src
USER appuser

# Document the port (Fly does NOT read EXPOSE for routing — internal_port in fly.toml does — but it
# documents intent and is good Docker hygiene).
EXPOSE 8080

# The entrypoint. host 0.0.0.0 is mandatory; port 8080 must match fly.toml internal_port.
# --timeout-graceful-shutdown gives in-flight requests time to finish on a deploy/stop (see §5).
# NOTE: a single Uvicorn process (NO --workers). Fly scales by running MORE MACHINES, not more
# in-process workers — one process = one clean lifespan = one pool. See §2.2.
CMD ["uvicorn", "src.main:app", \
     "--host", "0.0.0.0", "--port", "8080", \
     "--timeout-graceful-shutdown", "25"]
```

Notes that earn their place:

- **`PYTHONUNBUFFERED=1`** — without it, Python buffers stdout and your logs don't appear in
  `fly logs` until the buffer flushes (or the process dies). Mirror of why the `worker/` logs are
  line-by-line.
- **Non-root `appuser`** — Fly runs whatever the image runs; root is not required. Drop it.
- **`--timeout-graceful-shutdown 25`** — Uvicorn stops accepting new requests on SIGTERM/SIGINT and
  waits up to this many seconds for in-flight requests to finish before exiting
  ([uvicorn.dev/settings](https://uvicorn.dev/settings/)). Pair it with `kill_timeout` in `fly.toml`
  (§5) so Fly waits at least as long before SIGKILL. **25 < the 30 s `kill_timeout` we set** so
  Uvicorn finishes draining *before* Fly's hard kill.

### 2.2 Why **one Uvicorn process, no `--workers`** (and how to actually scale)

A market-data read service is **I/O-bound** (await the DB, await Redis), not CPU-bound, so a single
async event loop saturates the box on I/O long before CPU. More importantly:

- **`uvicorn --workers N` (or gunicorn + UvicornWorker) forks N processes that each run the lifespan
  independently** → N connection pools inside *one* machine, N copies of the in-memory cache, N
  copies of any `add_job`-style scheduler. That multiplies your Postgres connection count and
  fragments your cache in a way that is invisible until you wonder why your pool config "doesn't
  match" the connections Postgres reports.
- **Fly's scaling unit is the Machine, not the worker.** To handle more load you run
  `fly scale count N` (more machines, each one process, each behind the Fly proxy's load balancer) —
  this is also what gives you zero-downtime deploys (§5 needs ≥2 machines). Concurrency *within* a
  machine is the async event loop + the `[http_service.concurrency]` soft/hard limits (§3.4), not
  OS processes.

> **Rule:** one Uvicorn worker per Machine; scale horizontally with `fly scale count`. If you later
> measure a genuine CPU bottleneck (heavy in-process number-crunching), that work belongs in the
> **write path / worker**, not in more API workers — see
> [`background-work-and-the-worker-boundary.md`](background-work-and-the-worker-boundary.md).

---

## 3. `fly.toml` essentials — every section, annotated <a name="3-fly-toml"></a>

The complete data-plane `fly.toml`. Every key below is from the current Fly config reference
([fly.io/docs/reference/configuration](https://fly.io/docs/reference/configuration/)); annotations
explain the *why* and the value we choose for a persistent data service. Contrast with the
`worker/`'s [`fly.toml`](../../../worker/fly.toml), which is a **no-inbound-port** worker (no
`[http_service]`); this service is the **inbound-HTTP** sibling, so it adds `[http_service]` +
checks.

```toml
# fly.toml — the JPM-Markets data-analytics READ service (FastAPI/Uvicorn on Fly).
# Mirrors worker/fly.toml's always-on shape, but ADDS an inbound HTTP service + health checks.

app            = "jpm-markets-dataplane"
primary_region = "iad"                 # match the store's region (Volume is region-pinned; see §6)

[build]
  dockerfile = "Dockerfile"            # explicit Dockerfile (§2), not a buildpack

[env]
  # Non-secret config only. Strings only. Cannot begin with FLY_. Secrets (§7) OVERRIDE these.
  LOG_LEVEL = "info"
  APP_ENV   = "production"
  # NOTE: NEVER put DATABASE_URL / API keys here — those are `fly secrets set` (§7).

# ── The inbound HTTP service (this is what worker/fly.toml does NOT have) ─────────────────
[http_service]
  internal_port       = 8080           # MUST equal the uvicorn --port in the Dockerfile (§2)
  force_https         = true           # redirect 80→443; the gateway talks HTTPS to us
  auto_stop_machines  = "off"          # PERSISTENT service: never scale-to-zero (pools must stay warm)
  auto_start_machines = true
  min_machines_running = 2             # ≥2 for zero-downtime rolling deploys (§5)
  processes           = ["app"]

  # Load-balancing concurrency. type="requests" is recommended for HTTP (vs "connections").
  # soft_limit: prefer routing elsewhere past this; hard_limit: refuse past this.
  [http_service.concurrency]
    type       = "requests"
    soft_limit = 200
    hard_limit = 250

  # ── The HTTP health check (gates the rolling deploy; see §4 + §5) ──────────────────────
  # Times accept unit suffixes ("15s"); bare numbers are MILLISECONDS — ALWAYS use the suffix.
  [[http_service.checks]]
    method       = "GET"
    path         = "/health"           # the readiness route (§4)
    protocol     = "http"              # the check hits the app on internal_port over plain http
    interval     = "15s"               # time between checks once healthy
    timeout      = "5s"                # a check that takes longer than this is a failure
    grace_period = "10s"               # wait this long AFTER boot before the FIRST check (lifespan time)
    [http_service.checks.headers]
      X-Forwarded-Proto = "https"      # so the app doesn't 308-redirect the check under force_https

# ── VM sizing (per process group) ────────────────────────────────────────────────────────
[[vm]]
  size      = "shared-cpu-1x"          # start small; a data plane is I/O-bound (§2.2)
  memory    = "512mb"                  # min for shared-cpu-1x is 256mb; 512mb gives pool+cache headroom
  cpus      = 1
  cpu_kind  = "shared"
  processes = ["app"]

# ── Graceful shutdown dials (§5) ──────────────────────────────────────────────────────────
kill_signal  = "SIGTERM"               # default is SIGINT; SIGTERM is the conventional "drain now"
kill_timeout = "30s"                   # wait up to 30s for drain before SIGKILL (max 300s on shared)

# ── Deploy strategy (§5) ──────────────────────────────────────────────────────────────────
[deploy]
  strategy        = "rolling"          # default; one machine at a time, gated on health checks
  max_unavailable = 1                  # whole number = count of machines that may be down at once
```

### 3.1 The `internal_port` match (the single most common deploy failure)

`[http_service].internal_port` is the port **inside the VM** where your app listens
([config reference](https://fly.io/docs/reference/configuration/) — default `8080`). Fly's proxy
accepts public traffic on 80/443 and forwards to `internal_port`. **It must equal the
`uvicorn --port` from the Dockerfile (§2).** If you write `--port 8000` in the Dockerfile but leave
`internal_port = 8080`, the proxy forwards to 8080, nothing is listening, and **every health check
fails** — the deploy hangs then rolls back. This is the exact failure documented in the Fly community
thread *"Health check on port 8080 has failed for fastAPI"*
([community.fly.io/t/.../21043](https://community.fly.io/t/health-check-on-port-8080-has-failed-for-fastapi/21043)),
where the cause was binding `127.0.0.1` instead of `0.0.0.0` *or* a port mismatch. Keep one number:
**8080 everywhere.**

### 3.2 `auto_stop_machines = "off"` + `min_machines_running` — the persistence dial

`auto_stop_machines` accepts `"off"`, `"stop"`, `"suspend"`
([config reference](https://fly.io/docs/reference/configuration/)). For a *consumer* web app you
*want* `"stop"` + `min_machines_running = 0` to scale to zero and save money. **For this data plane
you want the opposite** — `"off"` and `min_machines_running = 2` — because:

- scaling to zero throws away the warm pool/cache/lifespan-state the whole architecture is built on
  (every wake is a cold start — exactly the serverless failure we left Vercel to avoid);
- the `worker/` already learned this lesson: its [`fly.toml`](../../../worker/fly.toml) sets
  `auto_stop_machines = false`, `auto_start_machines = false`, `min_machines_running = 1` and its
  comment warns *"`fly launch` tends to add an `[http_service]` with `auto_stop_machines='stop'` and
  `min_machines_running=0` — for a worker like this you do NOT want that."* Same correction here.
- `min_machines_running = 2` (not 1) because **zero-downtime rolling deploys need ≥2 machines** (§5).

> **`fly launch` will get this wrong by default.** It scaffolds a scale-to-zero web service. After
> `fly launch --no-deploy`, *edit* the generated `fly.toml` to the values above before the first
> `fly deploy` — precisely as the `worker/` README instructs for the worker.

### 3.3 Health check times: the units trap

In Fly's check sections, **times with a unit suffix are literal** (`"15s"`, `"10s"`), but **a bare
number is interpreted as milliseconds** ([config reference](https://fly.io/docs/reference/configuration/)
— *"Times in milliseconds unless specified with units"*). Writing `interval = 15` means **15 ms**, a
self-inflicted DoS on your own `/health` route. **Always write the suffix.** The four dials:

| Key | Our value | Meaning |
|---|---|---|
| `grace_period` | `"10s"` | Time after the Machine boots before the **first** check runs. This is your **lifespan budget** — set it ≥ how long the pool + client + warm caches take to open (§4). Too short → the first check fires before the app is ready → deploy looks unhealthy. |
| `interval` | `"15s"` | Time between checks once it's been checked. |
| `timeout` | `"5s"` | A single check slower than this counts as failed. `/health` must be **fast** (no heavy query) so it never trips this — see §4. |
| `method` / `path` / `protocol` | `GET /health http` | What the check requests. |

### 3.4 Concurrency soft/hard limits

`[http_service.concurrency]` tells Fly's proxy *when to spread load to another machine* and *when to
refuse* ([config reference](https://fly.io/docs/reference/configuration/)):

- `type = "requests"` (recommended for HTTP) counts in-flight **requests**; `"connections"` counts
  TCP connections (the default, but less useful for HTTP/2-multiplexed or keep-alive traffic).
- `soft_limit` (default 20): past this, the proxy **prefers** routing new requests to a *different*
  machine (and, with `auto_start_machines`, can wake one). It does **not** reject.
- `hard_limit`: past this, the machine **refuses** new requests (back-pressure). Set
  `hard_limit > soft_limit`.

Pick `soft_limit` from a measured number: what concurrency does one Uvicorn event loop handle before
p99 latency degrades? Start conservative (`200/250`), load-test, adjust. The R-SCALE discipline
([`product-at-scale.md`](../../rules/product-at-scale.md)): these limits are your **per-machine
ceiling**; `fly scale count` multiplies it. State the tier — `2 × shared-cpu-1x × 200 req soft` is a
Tier-1/early-Tier-2 ceiling; Tier-3 (lakhs concurrent) needs `fly scale count` into double digits +
read replicas on the store, and the *math* should be written down, not assumed.

### 3.5 `[[vm]]` sizing

`[[vm]]` (double-bracket for per-process-group sizing) sets the compute
([config reference](https://fly.io/docs/reference/configuration/)). Presets and the memory rule:

- `size` accepts presets like `shared-cpu-1x`, `shared-cpu-2x`, `performance-1x` (lowest precedence;
  `cpus`/`cpu_kind`/`memory` override it).
- Memory rule (from [machine-sizing](https://fly.io/docs/machines/guides-examples/machine-sizing/)):
  *"Memory limits are `2gb * shared CPU size` or `8gb * performance CPU size`"*; *"Minimum memory is
  `256m * shared CPU size`"*; *"Memory must be a multiple of 256 for shared sizes."* So
  `shared-cpu-1x` → 256 MB min, 2 GB max; we pick **512 MB** for pool + cache + Python headroom.
- A data plane is I/O-bound (§2.2): start at `shared-cpu-1x`, scale **out** (`fly scale count`)
  before scaling **up** (`performance-Nx`). Move to `performance` only when you measure CPU
  saturation that horizontal scaling can't fix.

---

## 4. The `/health` route + lifespan readiness <a name="4-health-route"></a>

The `/health` route is what the Fly check in §3.3 hits. Its job is to answer **one question
honestly**: *is this machine ready to serve traffic right now?* On a data plane "ready" means **the
connection pool is open and reachable** — because a machine whose lifespan hasn't finished opening
the pool will 500 every real request, and the proxy must *not* route to it. This is the readiness
gate that makes the rolling deploy (§5) zero-downtime.

### 4.1 Liveness vs readiness — and why `/health` here is *readiness*

| Probe | Question | Cheap or real? |
|---|---|---|
| **Liveness** | "Is the process up at all?" | Trivial: `return {"status": "ok"}`. Detects a hung/crashed process. |
| **Readiness** | "Can it serve a real request *now*?" | Must touch the pool: `SELECT 1`. Detects "process up but DB pool not open / unreachable." |

For a data plane the meaningful one is **readiness** — a process that's up but can't reach Postgres
is *not* ready, and routing to it causes user-visible 500s during a deploy. So `/health` runs a
**cheap-but-real** `SELECT 1` against the pool. The discipline (from §3.3): keep it well under the
`timeout = "5s"` — `SELECT 1` on a warm pool is sub-millisecond, so it never trips the timeout, while
still catching "pool dead."

> **Do NOT make `/health` heavy.** A `/health` that runs a real aggregation, or fans out to upstream
> APIs, will (a) blow the `5s` timeout under load and flap the machine in/out of the pool, and (b)
> turn your health checker into a load generator. Cheapest query that proves the load-bearing
> dependency. Nothing more.

### 4.2 The lifespan sets a "ready" flag; `/health` reads it

The lifespan (owned in full by
[`fastapi-app-structure-and-lifespan.md`](fastapi-app-structure-and-lifespan.md) — this doc does
**not** re-teach pool wiring) opens the pool and flips a flag. `/health` reports `503` until the flag
is set and the pool answers. The `grace_period = "10s"` (§3.3) is the budget for the lifespan to
finish before the first check fires.

```python
# src/health.py — the readiness route. NO business logic, NO upstream fetch.
from fastapi import APIRouter, Request, Response, status

router = APIRouter()

@router.get("/health")
async def health(request: Request, response: Response) -> dict:
    pool = getattr(request.app.state, "pool", None)
    # Frame-0 guard: before lifespan finishes opening the pool, we are NOT ready.
    if pool is None or not getattr(request.app.state, "ready", False):
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "starting"}
    try:
        # Cheap-but-real: proves the pool can actually reach Postgres. Sub-ms on a warm pool.
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
    except Exception:
        # Pool exists but DB is unreachable → NOT ready → 503 → proxy stops routing here.
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "db_unreachable"}
    return {"status": "ok"}
```

```python
# src/main.py — the lifespan that flips the readiness flag (skeleton; full version in the
# fastapi-app-structure-and-lifespan reference). Shown here ONLY to make the /health flag concrete.
from contextlib import asynccontextmanager
from fastapi import FastAPI
import asyncpg
from src.health import router as health_router
from src.config import settings  # pydantic-settings (§7)

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.ready = False
    # Open the pool ONCE for the whole process (this is the thing serverless can't keep — §1/§9).
    app.state.pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=2, max_size=10,            # sized to the store's connection budget (§6)
        command_timeout=30,
    )
    app.state.ready = True                   # NOW /health returns 200 → proxy routes traffic here
    try:
        yield
    finally:
        # Shutdown (after yield): close the pool cleanly so no half-open connections leak (§5).
        app.state.ready = False              # flip ready OFF first so the proxy drains us
        await app.state.pool.close()

app = FastAPI(lifespan=lifespan)
app.include_router(health_router)
```

The ordering is deliberate and is what makes the deploy zero-downtime:

1. **Boot → lifespan opens pool → `ready = True`.** Only now does `/health` return 200. Within the
   `grace_period`, the proxy hasn't even checked yet; once it does and gets 200, it starts routing.
2. **Shutdown → `ready = False` FIRST**, so the next `/health` check returns 503 and the proxy stops
   routing *before* we close the pool — draining in-flight requests, not cutting them. This dovetails
   with the SIGTERM handshake in §5.

> Note: FastAPI **`lifespan`** is the current mechanism; the old `@app.on_event("startup")` /
> `("shutdown")` decorators are deprecated and *"will no longer be called"* if a `lifespan` is
> provided ([fastapi.tiangolo.com/advanced/events](https://fastapi.tiangolo.com/advanced/events/)).
> Use `lifespan` only — and lifespan code runs **once for the whole app, not per request** (ibid.),
> which is the whole point (§9).

---

## 5. Rolling / zero-downtime deploys + the graceful-shutdown handshake <a name="5-rolling-deploy"></a>

### 5.1 What "rolling" actually does

`[deploy].strategy = "rolling"` is the default
([config reference](https://fly.io/docs/reference/configuration/)). The step-by-step, from Fly's
seamless-deployments blueprint
([fly.io/docs/blueprints/seamless-deployments](https://fly.io/docs/blueprints/seamless-deployments/)):

1. Fly **boots a new Machine** with the new image.
2. It **waits for that machine's health checks to pass** (the `/health` 200 from §4, after its
   `grace_period`).
3. **Only then** does it take down an old machine and replace it. *"The platform won't kill a healthy
   Machine until a new one is up and running"* (ibid.).
4. Repeat, one machine at a time (`max_unavailable` controls how many may be down concurrently — a
   whole number is a count, `0–1` is a fraction; default `0.33`, i.e. one-third —
   [config reference](https://fly.io/docs/reference/configuration/)).

**Zero-downtime requires three things together** (seamless-deployments blueprint):

- **a working health check** (§4) — *"traffic won't be sent to new code until it passes a health
  check"*;
- **≥2 Machines** — *"Working with health checks and at least two Machines, you can avoid
  downtime"* (this is why §3.2 sets `min_machines_running = 2`);
- **a `grace_period`** long enough for the app to boot — *"forgetting to delay checks with a
  `grace_period` after boot"* is a named common failure; *"If the first request after deploy always
  fails (not just slow), your grace period is probably too short."*

### 5.2 The strategy menu (and when each fits)

| Strategy | Behaviour | Use for the data plane? |
|---|---|---|
| `rolling` (default) | One machine at a time, gated on health checks. | **Yes** — works with Volumes, simple, zero-downtime with ≥2 machines + checks. |
| `canary` | Boot one test machine; if healthy, continue rolling. | Optional extra safety; **cannot be used if the machine has a Volume attached** (canary boots an extra machine that would need its own volume). |
| `bluegreen` | Boot a full new set alongside old; cut traffic over once all pass. | Fastest/safest **but cannot use attached Volumes** ([config reference](https://fly.io/docs/reference/configuration/)). If the data plane mounts a Volume (§6), bluegreen is **out** — use `rolling`. |
| `immediate` | Replace all at once, **no waiting for checks**. | **No** — defeats zero-downtime. |

> **The Volume constraint decides the strategy.** If you put the store on a Fly **Volume** attached to
> the data-plane machine, `bluegreen`/`canary` are unavailable and you use **`rolling`**. If the store
> is an **external managed DB** (§6 — the recommended path) the data-plane machines are *stateless*
> and you *could* use `bluegreen`. The plan's recommended topology (external store) keeps `rolling` as
> the safe default and leaves bluegreen as an option.

### 5.3 The graceful-shutdown handshake (the part that prevents dropped requests)

When Fly replaces a machine (deploy) or stops one, it must let in-flight requests finish. The
mechanism ([fly.io/blog/graceful-vm-exits-some-dials](https://fly.io/blog/graceful-vm-exits-some-dials/)
+ [config reference](https://fly.io/docs/reference/configuration/)):

1. Fly sends the **`kill_signal`** to PID 1 (your Uvicorn). **Default is `SIGINT`**; we override to
   **`SIGTERM`** in `fly.toml` (§3) — the conventional "drain and exit" signal Uvicorn handles.
2. Fly **waits up to `kill_timeout`** (default **5 s**; max **300 s** on shared CPU, **24 h** on
   dedicated). We set **`"30s"`** to give a busy aggregation request time to finish.
3. If the process is still alive after `kill_timeout`, Fly sends **`SIGKILL`** (forced).

The app side of the handshake — **Uvicorn already does the right thing on SIGTERM**: it stops
accepting new connections, finishes in-flight requests, then runs the FastAPI **lifespan shutdown**
(after `yield`), closing the pool ([uvicorn.dev/settings](https://uvicorn.dev/settings/) —
`--timeout-graceful-shutdown` bounds the wait). The numbers must nest:

```
uvicorn --timeout-graceful-shutdown 25   <   fly.toml kill_timeout "30s"
                         │                              │
        Uvicorn drains in-flight ≤25s, then  ───────────┘  Fly SIGKILLs at 30s only if drain hung
        runs lifespan shutdown (pool.close)
```

> **Invariant:** `uvicorn --timeout-graceful-shutdown` **<** `fly.toml kill_timeout`. If Fly's
> `kill_timeout` were *shorter* than Uvicorn's drain window, Fly would SIGKILL mid-drain and you'd
> drop the very requests the drain exists to protect. 25 < 30 satisfies it with margin.

Combined with the §4.2 ordering (lifespan flips `ready=False` first → `/health` 503 → proxy stops
routing → drain → close pool), a deploy moves traffic off a machine *before* it shuts down, and the
new machine only receives traffic *after* its `/health` is 200. That is the whole zero-downtime
contract.

### 5.4 Pre-deploy schema work: `release_command`

If a deploy needs a DB migration (Alembic) to run **once** before the new machines start, use
`[deploy].release_command` ([config reference](https://fly.io/docs/reference/configuration/) —
*"One-off task before deploy"*, default timeout 5 min, overridable via `release_command_timeout`):

```toml
[deploy]
  strategy        = "rolling"
  release_command = "alembic upgrade head"   # runs ONCE in an ephemeral machine before the rollout
```

This runs in a temporary machine *before* any app machine is replaced — so the schema is migrated
before new code touches it. **Do NOT run migrations in the lifespan** (it would run on every machine
boot, racing N machines against one schema). `release_command` is the single-run hook. (Hypertable /
continuous-aggregate DDL is `op.execute()` raw SQL in the Alembic migration — owned by the
`timescaledb-timeseries` skill's `patterns-python-connection-layer.md`.)

---

## 6. The store: Fly Volume vs Timescale (Tiger) Cloud — and NOT Fly Managed Postgres <a name="6-the-store"></a>

The data plane reads time-series from a **TimescaleDB** (Postgres + the `timescaledb` extension)
store — engine design is the `timescaledb-timeseries` skill. The *deploy* question is **where that
Postgres physically runs**, and there is a sharp, evidence-backed verdict:

> **Fly Managed Postgres (MPG) CANNOT host this store, because MPG does not support the `timescaledb`
> extension.** The three real options are: (1) **Timescale/Tiger Cloud** (managed, recommended for
> production), (2) **a self-managed Postgres-with-Timescale on a Fly Machine + Volume** (cheapest,
> you own ops), or — only for non-Timescale relational data — (3) MPG.

### 6.1 Why NOT Fly Managed Postgres (the load-bearing fact)

Fly Managed Postgres supports **only `pgvector` and `PostGIS`** as third-party extensions:
*"Currently only Vector and PostGIS are supported"*
([fly.io/docs/mpg/extensions](https://fly.io/docs/mpg/extensions/)). The full bundled-extension list
there (`btree_gin`, `citext`, `hstore`, `ltree`, `pg_trgm`, `pgcrypto`, `vector`, `PostGIS`, …)
**does not include `timescaledb`**. So `CREATE EXTENSION timescaledb` fails on MPG. **Do not pick MPG
for the time-series store.**

TimescaleDB *does* exist on Fly — but only on the **legacy unmanaged Postgres Flex** offering, via a
special image: *"provision a new Postgres app using our TimescaleDB-adapted image"*
`flyio/postgres-flex-timescaledb:16`, then `CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE`
([fly.io/docs/postgres/getting-started/enabling-timescale](https://fly.io/docs/postgres/getting-started/enabling-timescale/)).
But Fly explicitly **does not support** unmanaged Postgres: *"We are not able to provide support or
guidance for unmanaged Postgres"* (ibid.). So the unmanaged-Flex-with-Timescale path means **you own
all the database ops** (failover, backups, upgrades) yourself.

### 6.2 The store decision table

| Option | Timescale ext? | Ops burden | When to pick |
|---|---|---|---|
| **Tiger Cloud** (managed TimescaleDB, ex-Timescale Cloud) | ✅ native | **Managed** — HA replicas, backups, tiering to object storage, 99.9% SLA | **Recommended for production.** Connect via DSN in a Fly secret (§7). $1,000 / 30-day starter credit, no card ([tigerdata.com/cloud](https://www.tigerdata.com/cloud)). |
| **Self-managed Postgres+Timescale on a Fly Machine + Volume** | ✅ (Flex image) | **You own it** (failover/backup/upgrade) | Cheapest; fine for dev / early traction where you accept the ops. Use the `flyio/postgres-flex-timescaledb:16` image; data lives on a **Volume**. |
| **Fly Managed Postgres (MPG)** | ❌ **no timescaledb** | Managed | **NOT for the time-series store.** Only if you also need a *separate* relational/pgvector DB. |

### 6.3 If you do use a Fly Volume — the constraints you must design around

A Fly **Volume** is *"a slice of an NVMe drive on the same physical server as the Machine on which
it's mounted… It is not network storage"*
([fly.io/docs/volumes/overview](https://fly.io/docs/volumes/overview/)). The hard facts that shape
the design:

- **Region- and machine-pinned, one-to-one.** *"A volume exists on one server in a single region."*
  *"There's a one-to-one mapping between Machines and volumes. A Machine can only mount one volume at
  a time and a volume can be attached to only one Machine."* So a Volume-backed Postgres is **a
  single machine** — it does **not** scale horizontally and a host NVMe failure takes that instance
  down: *"if… the NVMe drive hosting your volume fails, then that instance of your app goes down."*
- **No automatic replication.** *"Fly.io does not automatically replicate data among the volumes on
  an app, so if you need the volumes to sync up, then your app has to make that happen."* HA is **your
  job** on this path.
- **Snapshots are not a backup strategy.** Daily snapshots (retained 1–60 days, default 5) exist but
  *"the snapshots shouldn't be your primary backup method."* You implement real backups.
- **A Volume forbids `bluegreen` deploys** (§5.2). And the data-plane **API** machines should
  generally **not** carry the store's Volume — keep the store a *separate* app/machine so the API can
  scale out statelessly.

The `[mounts]` section if you do attach a Volume (e.g. to a dedicated DB machine)
([config reference](https://fly.io/docs/reference/configuration/)):

```toml
[mounts]
  source       = "tsdb_data"      # volume name (create with: fly volumes create tsdb_data --size 50)
  destination  = "/var/lib/postgresql/data"
  initial_size = "50gb"
  # Optional auto-extend (all three required together if used):
  auto_extend_size_threshold = 80      # extend when 80% full
  auto_extend_size_increment = "10GB"
  auto_extend_size_limit     = "200GB"
```

> **Recommendation for this product line:** the data-plane **API** machines are **stateless** (they
> hold pools/caches in RAM, persist nothing locally — no Volume), and the **store** is **Tiger Cloud**
> (managed Timescale) reached over a `DATABASE_URL` secret. This keeps the API horizontally scalable
> (`fly scale count`), keeps `rolling`/`bluegreen` both available, and offloads DB HA/backups to the
> managed provider. Use the Volume-backed self-managed path only for dev or a deliberately-accepted
> ops trade-off. Either way: **never MPG for the Timescale store.**

---

## 7. Secrets: `fly secrets set` → `pydantic-settings` <a name="7-secrets"></a>

Config crosses two boundaries: **Fly secrets** (encrypted, injected as env vars at boot) →
**`pydantic-settings`** (typed, validated config object the app reads). Never the Dockerfile, never
`[env]` in `fly.toml`, never committed.

### 7.1 Setting secrets on Fly

```sh
# Set one or many. Encrypted at rest; injected as ENV VARS into the Machine at boot — NOT baked
# into the image. Setting a secret triggers a Machine restart by default.
fly secrets set DATABASE_URL="postgresql://user:pass@host.tsdb.cloud.timescale.com:5432/tsdb?sslmode=require"
fly secrets set CRON_SECRET="$(openssl rand -hex 32)"
fly secrets set TWELVE_DATA_API_KEY="..."

# Stage several without restarting yet, then apply once:
fly secrets set FOO=bar BAZ=qux --stage
fly secrets deploy            # redeploy to apply staged secrets

fly secrets list              # names + digests only — NEVER plaintext values
fly secrets unset OLD_KEY     # remove
```

The mechanics, verbatim from Fly
([fly.io/docs/apps/secrets](https://fly.io/docs/apps/secrets/)): *"The Fly.io agent on the host uses
this token to decrypt your app secrets and inject them into your Machine as environment variables at
boot time."* Setting a secret *"involves a restart of the Machine."* **Secrets override `[env]`** in
`fly.toml`, so a secret named the same as an `[env]` key wins — keep all sensitive values in secrets
and only non-sensitive defaults in `[env]` (§3).

> **Security note Fly states explicitly:** *"People with deploy access can deploy code that reads
> secret values and prints them to logs."* So `fly logs` and your own logging must never echo a
> secret. This mirrors Lumina non-negotiable #6 (secrets injected, never surfaced) and the
> licensing-precheck hook's `.env` caution.

### 7.2 Reading them with `pydantic-settings`

`pydantic-settings` (`BaseSettings`) reads each field from the matching env var, validates and
coerces the type, and fails fast at startup if a required secret is missing
([pydantic settings docs](https://pydantic.dev/docs/validation/latest/concepts/pydantic_settings/)).
This is the typed boundary between "raw env string Fly injected" and "validated config the app uses."

```python
# src/config.py — the ONE place env/secrets become typed config. Imported everywhere; instantiated once.
from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",          # local dev only; on Fly the vars come from injected secrets/env
        env_file_encoding="utf-8",
        case_sensitive=False,     # DATABASE_URL or database_url both map
        extra="ignore",
    )

    # Required — startup FAILS LOUDLY (ValidationError) if Fly hasn't injected these. That is correct:
    # a data plane with no DATABASE_URL must not start and pretend to be healthy.
    database_url: str = Field(..., alias="DATABASE_URL")
    cron_secret: str = Field(..., alias="CRON_SECRET")

    # Optional with defaults (can come from [env] in fly.toml, overridable by a secret).
    log_level: str = "info"
    app_env: str = "production"

@lru_cache                         # one cached Settings instance per process (read env ONCE)
def get_settings() -> "Settings":
    return Settings()

settings = get_settings()
```

The fail-fast property is a feature: if `fly secrets set DATABASE_URL=…` was forgotten, the process
raises `ValidationError` at boot, `/health` never goes 200, the rolling deploy never promotes the
broken machine, and the **old machines keep serving** — the misconfiguration cannot reach users. A
"works without the secret then 500s on first query" design would have shipped the outage.

---

## 8. The `CRON_SECRET`-guarded trigger route for the write path <a name="8-cron-trigger"></a>

The data plane's **read** service never fetches upstream; the **write path** (ingest, normalize,
refresh) runs on a schedule. Per repo non-negotiable #4, scheduled work is *"an external cron hitting
a `CRON_SECRET`-guarded route"* ([`CLAUDE.md`](../../../CLAUDE.md)) — not an in-process timer
(serverless can't hold one; and even on Fly you want the *trigger* external so the schedule is
auditable and one source of truth). This section is the **trigger route + guard**; the job *body*
(what ingest actually does) is owned by
[`background-work-and-the-worker-boundary.md`](background-work-and-the-worker-boundary.md).

### 8.1 The exact guard, mirrored from the repo

Lumina's finance cron warmer already implements this guard, and we copy its shape exactly. From
[`backend/finance/routes.ts`](../../../backend/finance/routes.ts) (the `/cron/refresh` endpoint):
it reads `process.env.CRON_SECRET`, accepts the secret as either a `Bearer` token in `Authorization`
**or** an `x-cron-secret` header, returns **401** on mismatch, and — the deliberate dev affordance —
**skips the guard entirely when `CRON_SECRET` is unset** (so local dev is open). The FastAPI port:

```python
# src/cron.py — the trigger route. Validates the shared secret, then enqueues/runs the write job.
# Body of the job lives in the worker reference; THIS file is only the guarded entrypoint.
from fastapi import APIRouter, Header, HTTPException, BackgroundTasks, status
from src.config import settings

router = APIRouter(prefix="/cron", tags=["cron"])

def _authorized(authorization: str | None, x_cron_secret: str | None) -> bool:
    secret = settings.cron_secret
    if not secret:
        return True  # mirror routes.ts: guard SKIPPED when unset = open in local dev
    bearer = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization[7:].strip()
    provided = bearer or x_cron_secret
    return provided == secret

@router.post("/refresh", status_code=status.HTTP_202_ACCEPTED)
async def cron_refresh(
    background: BackgroundTasks,
    authorization: str | None = Header(default=None),
    x_cron_secret: str | None = Header(default=None, alias="X-Cron-Secret"),
) -> dict:
    if not _authorized(authorization, x_cron_secret):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unauthorised")
    # Heavy/retryable ingest is NOT a FastAPI BackgroundTask in production (it would die on a deploy /
    # not be retried). See background-work-and-the-worker-boundary.md: durable write work belongs to
    # the SEPARATE worker process (a cron-triggered Fly job). This route may only enqueue / signal it.
    # For a SUB-SECOND, loss-tolerant nudge, background.add_task(...) is acceptable.
    return {"accepted": True}
```

> **The boundary that bites:** this route **authorizes and dispatches**; it must **not** *be* the
> ingest. A multi-second, retryable ingest in a FastAPI `BackgroundTask` dies if a deploy replaces the
> machine mid-task and is never retried — the exact failure
> [`background-work-and-the-worker-boundary.md`](background-work-and-the-worker-boundary.md) exists to
> prevent. The cron *trigger* lives here; the cron *worker* is a separate Fly process.

### 8.2 Wiring the external scheduler

Exactly as the repo does it for the finance warmer ([`CLAUDE.md`](../../../CLAUDE.md) #4 + the
`routes.ts` comment *"Wire a free scheduler (cron-job.org) to POST here with the CRON_SECRET"*):
configure an external scheduler (cron-job.org, GitHub Actions schedule, or Fly's own machine-scheduling)
to `POST https://jpm-markets-dataplane.fly.dev/cron/refresh` on an interval **≤ the shortest TTL** the
warm data must respect, sending `Authorization: Bearer $CRON_SECRET`. Same secret on both ends, set
via `fly secrets set CRON_SECRET=…` (§7).

---

## 9. The WHY-NOT-VERCEL section in full (map onto repo non-negotiable #4) <a name="9-why-not-vercel-full"></a>

This is the load-bearing argument the plan rests on, stated rigorously so it survives a red-team
(`red-team-negation-loop.md` Q2/F5/F6). The claim is **not** "Vercel is bad" — Vercel is *correct*
for the stateless gateway. The claim is precise: **a stateful, long-lived data plane built around a
connection pool + shared client + in-memory hot state cannot run as a serverless function without
silently losing those guarantees.** Four independent mechanisms, each sufficient on its own.

### 9.1 Mechanism 1 — serverless re-establishes connections per cold boot; pools don't survive

A serverless function is a **fresh process per cold boot**. The connection pool you open in
lifespan lives in that process's memory; when the platform freezes/discards the instance, the pool is
gone. At a **read spike**, the platform spins up **many concurrent instances**, each opening its own
pool — so `max_size=10` per process × 50 cold instances = **500 connections** hammering a Postgres
sized for far fewer → `FATAL: too many connections`. This is the canonical serverless-Postgres failure
and the reason serverless deployments need an **external** pooler (PgBouncer/Supavisor in transaction
mode) and `statement_cache_size=0` — see
[`fastapi-app-structure-and-lifespan.md`](fastapi-app-structure-and-lifespan.md) and the
`timescaledb-timeseries` skill's `patterns-python-connection-layer.md` §"the pgbouncer trap." It is
documented in the wild: FastAPI + Neon on Vercel where *"the pool was never initialized"* /
*"connection errors because the pool was never initialized"*
([Vercel community: lifespan not initialized](https://community.vercel.com/t/fastapi-lifespan-not-being-initialized-on-runtime/8823),
[FastAPI discussion #13008](https://github.com/fastapi/fastapi/discussions/13008)).

A long-lived Fly VM holds **one** pool for the **whole process lifetime** (opened once in lifespan,
§4.2), reused by every request. The pool *is* the architecture. Serverless cannot keep it.

### 9.2 Mechanism 2 — no shared `httpx` client / in-memory caggs across invocations

The write path's keep-alive `httpx.AsyncClient` and the read path's in-memory computed cards / cagg
results exist to make the service **compute-once-serve-many** (the core promise in
[`lumina-data-plane-topology.md`](lumina-data-plane-topology.md)). On serverless, *every* invocation
is potentially a fresh instance → the client's keep-alive pool is empty, the in-memory caches are
empty → **every caller pays the cold price**, and the upstream rate budget (EDGAR/Treasury throttle)
is burned by re-handshaking. The "serve many warm" guarantee requires shared process memory that
survives across requests — which is exactly what a long-lived VM provides and a function does not.

### 9.3 Mechanism 3 — lifespan reliability on serverless

FastAPI **lifespan** is the canonical place to open the pool/client
([fastapi.tiangolo.com/advanced/events](https://fastapi.tiangolo.com/advanced/events/), runs *once
for the whole app*). Historically, serverless platforms ran the function handler **outside** the ASGI
lifespan context, so startup/shutdown **didn't run at all** — *"Vercel is using a runtime that isn't
reading properly the event as it is outside the app context and its route definitions"*
([Vercel community](https://community.vercel.com/t/fastapi-lifespan-not-being-initialized-on-runtime/8823)).
Vercel **added** lifespan support on **2025-12-09**
([vercel.com/changelog](https://vercel.com/changelog/fastapi-lifespan-events-are-now-supported-on-vercel)),
which *narrows* this gap — but the framework reality remains: lifespan runs **per instance cold
start**, and any state it sets is **scoped to that instance** and gone when the instance is recycled.
Even *with* the fix, the shutdown half is capped: *"Cleanup logic during shutdown is limited to a
maximum of 500ms after receiving the SIGTERM signal"* (ibid.) — far too short to drain a busy
aggregation and close a pool cleanly. A 30-second `kill_timeout` graceful drain (§5.3) is simply not
expressible on the platform.

### 9.4 Mechanism 4 — request-timeout caps long work

Serverless functions enforce a **maximum request duration**. A heavy backfill, a multi-second
analytical aggregation, or a long ingest exceeds it and is **killed mid-flight**. The data plane's
write path is *designed* to run for seconds-to-minutes off the request path; that work has **no home**
on a request-duration-bounded function. On Fly it runs in the worker process for as long as it needs
(`kill_timeout` up to 300 s / 24 h, §5.3) and as a separate cron-triggered process (§8).

### 9.5 The map onto repo non-negotiable #4

[`CLAUDE.md`](../../../CLAUDE.md) #4: *"Vercel can't hold sockets or timers. WebSockets/pollers go in
`worker/` (Fly.io); scheduled work is an external cron hitting a `CRON_SECRET`-guarded route."* The
generalisation this product line makes explicit:

> **A connection pool and a shared HTTP client are the same class of object as a socket** —
> long-lived, process-bound, not serializable across a freeze. The non-negotiable's *"goes in
> `worker/` (Fly)"* therefore extends to the entire **stateful data plane**, not just WebSockets. The
> data plane is the inbound-HTTP `worker/`. Scheduled refresh is still an external `CRON_SECRET` cron
> (§8). Nothing about #4 is bent; it is applied at its true scope.

### 9.6 What this is NOT claiming (pre-empting the red-team)

- **Not** "you can't run FastAPI on Vercel at all" — you can, for a *stateless* function-shaped API,
  now even with lifespan (since 2025-12-09). The claim is scoped to **this stateful data plane**.
- **Not** "Fly is the only long-lived host" — Railway, Render (non-free), a VPS, ECS/Fargate, etc.
  also hold long-lived processes. Fly is chosen because the repo **already** runs `worker/` there
  (one platform, one mental model, proven `fly.toml`), not because alternatives can't host a server.
- **Not** an argument against serverless for the **gateway** — that *stays* on Vercel. The split is
  the point.

---

## 10. The complete deploy runbook <a name="10-runbook"></a>

End-to-end, mirroring [`worker/README.md`](../../../worker/README.md)'s deploy section, adapted for an
inbound-HTTP service.

```sh
# 0. Verify the app boots locally and /health goes 200 (verify the pipe before deploying).
uvicorn src.main:app --host 0.0.0.0 --port 8080
curl -fsS localhost:8080/health        # expect {"status":"ok"} once the pool opens

# 1. Scaffold the Fly app WITHOUT deploying (so you can fix the scale-to-zero defaults first).
cd dataplane
fly launch --no-deploy                  # accept the Dockerfile; it will scaffold a fly.toml

# 2. EDIT the generated fly.toml to the §3 values:
#    - internal_port = 8080 (match the Dockerfile)
#    - auto_stop_machines = "off", min_machines_running = 2   (persistent, ≥2 for zero-downtime)
#    - the [[http_service.checks]] block hitting /health with grace_period
#    - kill_signal = "SIGTERM", kill_timeout = "30s"
#    fly launch's defaults are WRONG for a persistent service (it builds a scale-to-zero web app).

# 3. Provision the store. RECOMMENDED: Tiger Cloud (managed Timescale) — create a service, copy its DSN.
#    (NOT Fly Managed Postgres — no timescaledb. See §6.)

# 4. Set secrets (NOT in fly.toml). These are injected as env vars at boot; trigger a restart.
fly secrets set \
  DATABASE_URL="postgresql://...timescale.cloud...:5432/tsdb?sslmode=require" \
  CRON_SECRET="$(openssl rand -hex 32)" \
  TWELVE_DATA_API_KEY="..."

# 5. Deploy (rolling, zero-downtime once ≥2 machines exist and /health passes).
fly deploy

# 6. Ensure ≥2 always-on machines for zero-downtime rolling deploys.
fly scale count 2

# 7. Confirm.
fly status                              # 2 machines, both passing the /health check
fly logs                               # lifespan "pool opened" line; no secrets echoed
curl -fsS https://jpm-markets-dataplane.fly.dev/health

# 8. Wire the external scheduler to POST /cron/refresh with `Authorization: Bearer $CRON_SECRET`
#    on an interval ≤ the shortest data-freshness TTL (§8).
```

**Post-deploy checklist (the Output-Contract gate for this reference):**

- [ ] `internal_port` in `fly.toml` == `uvicorn --port` in the Dockerfile == **8080**; app binds
      `0.0.0.0`.
- [ ] `[[http_service.checks]]` hits `/health`, with `grace_period` ≥ lifespan boot time, all times
      **suffixed** (`"15s"`, not `15`).
- [ ] `/health` does a **cheap-but-real** `SELECT 1` and returns 503 until the pool is ready.
- [ ] `auto_stop_machines = "off"`, `min_machines_running = 2`; `fly scale count` ≥ 2.
- [ ] `kill_signal = "SIGTERM"`, `kill_timeout = "30s"` **>** `uvicorn --timeout-graceful-shutdown`.
- [ ] Store is **Tiger Cloud** (or self-managed Flex-Timescale on a Volume) — **never MPG** for the
      Timescale store.
- [ ] All secrets via `fly secrets set` → `pydantic-settings` (fail-fast on missing); **no** secret in
      `[env]`, Dockerfile, or repo; logs never echo secrets.
- [ ] `/cron/refresh` is `CRON_SECRET`-guarded (Bearer or `x-cron-secret`, 401 on mismatch, open when
      unset); the cron **trigger** lives here, the cron **job** in the worker.
- [ ] The R-SCALE tier is **written down**: per-machine ceiling (concurrency limits × machine size) and
      what `fly scale count` + store replicas buy at the next tier — in numbers, not vibes.

---

## 11. Anti-patterns quick table <a name="11-anti-patterns"></a>

| Anti-pattern (the mistake) | The fix |
|---|---|
| Deploying the FastAPI data plane as a **Vercel serverless function**. | It can't hold the pool / shared client / in-memory caggs across cold boots, lifespan state is per-instance, shutdown is capped at 500 ms, and long work hits the request-timeout. Run it as a **long-lived Uvicorn process on Fly** (§1, §9). The gateway stays on Vercel; the data plane does not. |
| `uvicorn --host 127.0.0.1` (or any loopback) in the Dockerfile. | The container is unreachable from Fly's proxy → every health check fails. **Bind `0.0.0.0`** (§2). |
| `internal_port` in `fly.toml` ≠ the `uvicorn --port`. | Proxy forwards to a dead port → deploy never goes healthy. **Keep one number: 8080 everywhere** (§3.1). |
| Accepting `fly launch`'s defaults (`auto_stop_machines="stop"`, `min_machines_running=0`). | Scales to zero → throws away warm pool/cache → every wake is a cold start (the serverless problem you left Vercel to avoid). Set `"off"` + `min_machines_running=2` and **edit the generated fly.toml before first deploy** (§3.2) — same correction `worker/` documents. |
| Bare numbers for check times (`interval = 15`). | Bare = **milliseconds** → 15 ms interval = self-DoS. **Always suffix** (`"15s"`) (§3.3). |
| A **heavy** `/health` (real aggregation / upstream fan-out). | Trips the `5s` timeout under load and flaps the machine; turns the checker into a load generator. **Cheapest query that proves the dependency** — `SELECT 1` on the pool (§4.1). |
| Opening the pool / running migrations **in the lifespan on every machine**. | Pool-in-lifespan is correct (once per process); but **migrations** in lifespan race N machines against one schema. Run migrations in `[deploy].release_command` (single ephemeral run) (§5.4). |
| `uvicorn --workers N` (or gunicorn+UvicornWorker) inside one Fly machine. | N forked processes = N pools = N caches = N schedulers inside one box; multiplies DB connections invisibly. **One process per machine; scale with `fly scale count`** (§2.2). |
| `kill_timeout` **shorter** than the Uvicorn graceful-shutdown window. | Fly SIGKILLs mid-drain → drops the in-flight requests the drain exists to protect. Keep `uvicorn --timeout-graceful-shutdown` **<** `kill_timeout` (§5.3). |
| Putting the Timescale store on **Fly Managed Postgres**. | MPG supports only pgvector+PostGIS — **`CREATE EXTENSION timescaledb` fails** (§6.1). Use **Tiger Cloud** (managed) or self-managed Flex-Timescale on a Volume. |
| Relying on a Fly **Volume** for HA, or assuming snapshots are backups. | A Volume is single-machine, single-region, un-replicated; a host NVMe failure takes it down; *"snapshots shouldn't be your primary backup method."* Use a managed DB, or own replication+backups explicitly (§6.3). Also: a Volume forbids `bluegreen` deploys (§5.2). |
| Secrets in `fly.toml [env]`, the Dockerfile, or the repo. | `[env]` is plaintext config and committed; the image is inspectable. **`fly secrets set` → `pydantic-settings`**; secrets override `[env]` and inject at boot (§7). Never log them. |
| Running the **ingest job body** inside the `/cron/refresh` FastAPI `BackgroundTask`. | A multi-second retryable ingest dies on a deploy mid-task and is never retried. The route **authorizes + dispatches**; the **worker** runs the job ([worker-boundary ref](background-work-and-the-worker-boundary.md), §8). |
| An **in-process timer** (`asyncio` loop / `add_job`) to schedule refresh "because we're on Fly now." | Even on Fly, the schedule should be **one external source of truth** (`CRON_SECRET` cron) so it's auditable and survives a redeploy/scale-out (repo NN #4, §8). |

---

## 12. Sources <a name="12-sources"></a>

**Primary — Fly.io docs (read this session):**
- App configuration (`fly.toml`) reference — `[http_service]` (internal_port, force_https,
  auto_stop_machines, concurrency), `[[http_service.checks]]` (path/interval/timeout/grace_period/
  method/protocol, ms-vs-suffix), `[checks]`, `[[vm]]`, `[mounts]`, `[deploy]` (strategy,
  max_unavailable, release_command), `kill_signal`/`kill_timeout` — https://fly.io/docs/reference/configuration/
- Run a FastAPI app — `uvicorn main:app --host 0.0.0.0 --port 8080`, internal_port 8080, fly launch
  flow — https://fly.io/docs/python/frameworks/fastapi/
- Health checks reference (TCP vs HTTP vs machine checks; checks gate rolling/canary deploys) —
  https://fly.io/docs/reference/health-checks/
- Seamless / zero-downtime deployments blueprint (new machine boots → passes check → old replaced;
  ≥2 machines; grace_period) — https://fly.io/docs/blueprints/seamless-deployments/
- Graceful VM exits (default `SIGINT`; `kill_timeout` default 5 s / max 300 s shared / 24 h
  dedicated; SIGINT → wait → SIGKILL) — https://fly.io/blog/graceful-vm-exits-some-dials/
- Volumes overview (single-server NVMe, region/machine-pinned 1:1, no auto-replication, snapshots not
  a backup, single-machine failure domain) — https://fly.io/docs/volumes/overview/
- Machine sizing (memory rule: 256m × shared CPU min, 2gb × shared CPU max; multiple of 256) —
  https://fly.io/docs/machines/guides-examples/machine-sizing/
- App secrets (`fly secrets set/list/unset`, `--stage`/`deploy`, encrypted + injected as env at boot,
  restart on set, override `[env]`) — https://fly.io/docs/apps/secrets/
- Managed Postgres extensions — **only pgvector + PostGIS** third-party (no timescaledb) —
  https://fly.io/docs/mpg/extensions/
- Enable TimescaleDB (only on legacy unmanaged Postgres Flex via `flyio/postgres-flex-timescaledb:16`;
  `CREATE EXTENSION timescaledb CASCADE`; unmanaged = unsupported) —
  https://fly.io/docs/postgres/getting-started/enabling-timescale/
- Fly community — "Health check on port 8080 has failed for fastAPI" (bind 0.0.0.0; port match) —
  https://community.fly.io/t/health-check-on-port-8080-has-failed-for-fastapi/21043

**Primary — FastAPI / Uvicorn / pydantic:**
- FastAPI Lifespan Events (`@asynccontextmanager`, runs once for the whole app, `@app.on_event`
  deprecated) — https://fastapi.tiangolo.com/advanced/events/
- Uvicorn settings (`--timeout-graceful-shutdown`, `--lifespan`, graceful drain) —
  https://uvicorn.dev/settings/
- pydantic-settings (`BaseSettings` reads env, validates/coerces, fail-fast) —
  https://pydantic.dev/docs/validation/latest/concepts/pydantic_settings/

**Vercel (the why-not evidence):**
- FastAPI lifespan now supported on Vercel (added 2025-12-09; 500 ms post-SIGTERM cleanup cap) —
  https://vercel.com/changelog/fastapi-lifespan-events-are-now-supported-on-vercel
- Vercel community — FastAPI lifespan not initialized at runtime (pool never initialized) —
  https://community.vercel.com/t/fastapi-lifespan-not-being-initialized-on-runtime/8823
- FastAPI discussion #13008 — lifespan events not triggering on serverless deployment —
  https://github.com/fastapi/fastapi/discussions/13008

**Timescale / Tiger Cloud (the managed store):**
- Tiger Cloud (managed TimescaleDB; HA replicas, tiering; starter credit) —
  https://www.tigerdata.com/cloud
- Create a Tiger Cloud service (connection config download) —
  https://docs.tigerdata.com/use-timescale/latest/services/

**In-repo pattern source + non-negotiables:**
- [`worker/fly.toml`](../../../worker/fly.toml) — the always-on (no-inbound) Fly config this service
  generalises; the `auto_stop_machines=false` / `min_machines_running` correction.
- [`worker/Dockerfile`](../../../worker/Dockerfile) — the explicit-Dockerfile, long-running CMD pattern.
- [`worker/README.md`](../../../worker/README.md) — "Vercel serverless functions can't hold a
  persistent WebSocket… must run on an always-on host"; the `fly launch --no-deploy` → secrets →
  deploy → `scale count` runbook.
- [`backend/finance/routes.ts`](../../../backend/finance/routes.ts) — the `/cron/refresh` endpoint
  with the `CRON_SECRET` Bearer / `x-cron-secret` guard (skipped when unset) that §8 mirrors.
- [`CLAUDE.md`](../../../CLAUDE.md) — non-negotiable #4 (Vercel can't hold sockets/timers; worker on
  Fly; scheduled work = external `CRON_SECRET` cron) and #6 (secrets injected, never surfaced).
- [`.claude/rules/product-at-scale.md`](../../rules/product-at-scale.md) — the R-SCALE tier discipline
  applied to the concurrency-limit / scale-count ceiling.

**Sibling references (do not duplicate — cross-read):**
- [`fastapi-app-structure-and-lifespan.md`](fastapi-app-structure-and-lifespan.md) — the lifespan
  internals + pool/client wiring this doc references but does not re-teach.
- [`background-work-and-the-worker-boundary.md`](background-work-and-the-worker-boundary.md) — the
  `BackgroundTasks`-vs-worker boundary and the cron job *body*.
- [`lumina-data-plane-topology.md`](lumina-data-plane-topology.md) — where the data plane sits and the
  read-never-fetches contract.
- `timescaledb-timeseries` skill, `patterns-python-connection-layer.md` — the pgbouncer/Supavisor
  prepared-statement trap and the asyncpg pool config referenced in §6/§9.
