# patterns — the single shared async `httpx.AsyncClient` (the data plane's only upstream door)

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (NOT Lumina). New
> Python / FastAPI / data-engineering stack. This is a concrete build recipe, not theory.
>
> **Scope of this doc.** The *one* `httpx.AsyncClient`, created in FastAPI's `lifespan`, stored on
> `app.state`, closed on shutdown, that is the **only** object in the data plane permitted to fetch an
> upstream provider. It is injected **only** into write-path / worker code (the ingest + warm path).
> **Read-path handlers never get it** — that absence is the framework-level enforcement of the
> repo's read-never-fetches contract.
>
> **The non-negotiable that governs this whole file (repo CLAUDE.md #1):** *"Never invent a finance
> number. Tools fetch; the model grounds. Failed tools return typed `unavailable`/`needsKey`, never
> fabricated data."* Everything below — the timeouts, the retries, the exception mapping — exists so
> that a failed fetch becomes a **typed `Unavailable`**, never a guessed price.

Versions pinned this research pass (June 2026): **httpx 0.28.1** (released 2024-12-06, current latest
on PyPI — https://pypi.org/project/httpx/), riding **httpcore** for the connection layer, on
**FastAPI** with the `lifespan` API (https://fastapi.tiangolo.com/advanced/events/). Re-confirm
versions before pinning in `pyproject.toml`; httpx pre-1.0 has changed defaults between minors.

---

## 0. The 60-second version (what to build)

```python
# app/clients/http.py
import httpx

# Created ONCE, in lifespan. Never per-request. Never module-import-time.
def build_upstream_client() -> httpx.AsyncClient:
    timeout = httpx.Timeout(
        connect=5.0,    # TCP + TLS handshake budget
        read=15.0,      # slowest GREEN upstream (EDGAR full-text) chunk wait
        write=10.0,
        pool=5.0,       # wait to ACQUIRE a pooled connection before PoolTimeout
    )
    limits = httpx.Limits(
        max_connections=50,            # hard ceiling on concurrent sockets
        max_keepalive_connections=20,  # idle warm sockets kept for reuse
        keepalive_expiry=30.0,         # seconds an idle keep-alive lingers
    )
    transport = httpx.AsyncHTTPTransport(
        retries=2,   # CONNECT-layer retries only (ConnectError/ConnectTimeout)
    )
    return httpx.AsyncClient(
        timeout=timeout,
        limits=limits,
        transport=transport,
        http2=True,                 # needs the h2 extra: httpx[http2]
        headers={"User-Agent": "JPMMarketsAnalytics/1.0 (data-eng@example.com)"},
        follow_redirects=False,     # explicit; redirects on a data API are a smell
    )
```

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.clients.http import build_upstream_client

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.upstream = build_upstream_client()   # one client for the process
    try:
        yield
    finally:
        await app.state.upstream.aclose()          # drains the pool on shutdown

app = FastAPI(lifespan=lifespan)
```

Everything else in this file is *why each line is what it is*, *what breaks if you skip it*, and the
*exact failure-isolation wrapper* that turns an httpx exception into a typed `Unavailable` instead of a
fabricated number. Read §1–§4 before changing any value above.

---

## 1. Why one shared client — the mechanism, not the slogan

### 1.1 What a `Client` actually owns

A `Client` / `AsyncClient` instance **owns a connection pool**. From the httpx docs
(https://www.python-httpx.org/advanced/clients/):

> *"A `Client` instance uses HTTP connection pooling. This means that when you make several requests to
> the same host, the `Client` will reuse the underlying TCP connection."*

The docs enumerate the benefits:

> *"Reduced latency across requests (no handshaking) · Reduced CPU usage and round-trips · Reduced
> network congestion."*

"No handshaking" is the load-bearing phrase. Each fresh HTTPS connection to a host costs:

1. **TCP handshake** — 1 round-trip (SYN / SYN-ACK / ACK).
2. **TLS handshake** — 1 round-trip on TLS 1.3, 2 on TLS 1.2, plus asymmetric crypto (the expensive
   part: certificate verification, key exchange).
3. **(HTTP/2) connection preface + SETTINGS exchange.**

To a GREEN upstream like `data.sec.gov` or `api.worldbank.org` sitting 50–150 ms away, that's
**100–450 ms of pure overhead per request** before a single byte of data is requested. A pooled
keep-alive connection amortises all of it: the first request to a host pays the handshake; the next N
requests reuse the warm socket and pay only the round-trip for the request/response itself.

### 1.2 The per-request-client anti-pattern (the thing that kills the data plane)

The httpx async docs are explicit (https://www.python-httpx.org/async/):

> *"In order to get the most benefit from connection pooling, make sure you're not instantiating
> multiple client instances - for example by using `async with` inside a 'hot loop'. This can be
> achieved either by having a single scoped client that's passed throughout wherever it's needed, or by
> having a single global client instance."*

What goes wrong if you ignore this and write `async with httpx.AsyncClient() as c: await c.get(...)`
inside each fetch:

| Failure | Mechanism | When it bites |
|---|---|---|
| **No keep-alive reuse** | Each new client = new empty pool. The TCP+TLS handshake is re-paid on *every* request; nothing is ever warm. | Immediately — latency 2×–4× higher than necessary. The community measurement: *"For external endpoints, the overhead can double your total execution time."* (https://medium.com/@sparknp1/8-httpx-asyncio-patterns-for-safer-faster-clients-f27bc82e93e6) |
| **Socket exhaustion via `TIME_WAIT`** | A closed TCP connection's local port sits in `TIME_WAIT` for ~2×MSL (≈60–240 s, OS-dependent). Open-and-close thousands of connections in a tight ingest loop and you exhaust the ephemeral port range (~28k ports by default). | Under load / a backfill loop — `OSError: [Errno 99] Cannot assign requested address`. Documented mechanism: *"the underlying sockets don't get released immediately — they linger in a TIME_WAIT state for approximately four minutes … you will eventually exhaust the available sockets."* (https://www.hougaard.com/httpclient-requires-an-anti-pattern-for-performance/) |
| **No global concurrency ceiling** | `Limits(max_connections=...)` caps connections *per client*. N clients = N independent caps = no real ceiling. You can flood a throttled GREEN upstream past its rate limit and get IP-banned. | The first time you fan out an ingest — EDGAR returns 403 + a 10-minute IP block (see §6). |
| **CPU burn** | TLS asymmetric crypto on every request. | Always; invisible until profiled. |

**The rule, stated as a contract:** the data plane creates **exactly one** `AsyncClient` per process,
in `lifespan`, and every fetch goes through it. There is no second client and no `async with
AsyncClient()` anywhere in the fetch path. A `grep -r "AsyncClient(" app/` that returns more than the
single `build_upstream_client` factory is a review failure.

### 1.3 Why `lifespan` + `app.state`, not a module global

You *could* make the client a module-level global. Don't — for three concrete reasons:

1. **Lifecycle.** A module global is created at import time, possibly before the event loop exists, and
   is never deterministically closed. The httpx docs require explicit closure:
   *"client = httpx.AsyncClient(); await client.aclose()"* — *"Failing to do so would leave connections
   open, most likely resulting in resource leaks down the line."* (https://www.python-httpx.org/async/).
   `lifespan`'s `finally: await client.aclose()` gives you that guaranteed drain on shutdown.
2. **Event-loop binding.** An `AsyncClient` binds to the running event loop when it first opens a
   connection. Creating it inside `lifespan` (which runs *on* the server's loop) guarantees it's bound
   to the right loop. A client created at import time can bind to the wrong loop under some test runners
   and ASGI servers.
3. **Per-worker correctness.** FastAPI's `lifespan` runs **once per worker process**
   (https://fastapi.tiangolo.com/advanced/events/). With Uvicorn `--workers 4` you get four processes,
   each with its own client and its own pool — which is exactly right (a pool can't be shared across
   processes). `app.state.upstream` is the per-process handle. **Corollary for §6:** your real
   per-upstream rate ceiling is `max_connections × worker_count`, not `max_connections`. Budget against
   the product.

The FastAPI lifespan shape is canonical (https://fastapi.tiangolo.com/advanced/events/):

> *"Code before `yield` executes before the application starts receiving requests. Code after `yield`
> executes after the application finishes handling requests."* and *"If you provide a `lifespan`
> parameter, `startup` and `shutdown` event handlers will no longer be called."*

Use `lifespan`, never the deprecated `@app.on_event("startup")` / `@app.on_event("shutdown")`.

```python
# app/main.py — the full shape, with multiple resources
from contextlib import asynccontextmanager
from fastapi import FastAPI

from app.clients.http import build_upstream_client
from app.db.pool import open_pg_pool   # asyncpg / SQLAlchemy engine, etc.

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ---- startup: open everything the WRITE path needs ----
    app.state.upstream = build_upstream_client()
    app.state.pg = await open_pg_pool()
    try:
        yield
    finally:
        # ---- shutdown: close in reverse order; both must run even on error ----
        await app.state.upstream.aclose()   # drain HTTP pool
        await app.state.pg.close()           # drain DB pool

app = FastAPI(lifespan=lifespan)
```

Note the `try/finally`: if `open_pg_pool()` raises during startup, you still want the already-created
client closed. Pair each resource with its teardown in the same `finally`.

---

## 2. `httpx.Timeout` — four budgets, never the default

### 2.1 The four timeout types (verbatim from the docs)

From https://www.python-httpx.org/advanced/timeouts/, *"The default behavior is to raise a
`TimeoutException` after 5 seconds of network inactivity."* The four sub-timeouts:

| Timeout | Docs definition | Exception | What it protects against |
|---|---|---|---|
| **connect** | *"the maximum amount of time to wait until a socket connection to the requested host is established"* | `ConnectTimeout` | A dead/slow host; DNS+TCP+TLS hang. |
| **read** | *"the maximum duration to wait for a chunk of data to be received"* (i.e. between chunks) | `ReadTimeout` | An upstream that accepts the connection then dribbles or stalls. |
| **write** | *"the maximum duration to wait for a chunk of data to be sent"* | `WriteTimeout` | A large POST body to a slow consumer (rare for read-heavy ingest). |
| **pool** | *"the maximum duration to wait for acquiring a connection from the connection pool"* | `PoolTimeout` | Pool exhaustion — all `max_connections` are in use and this request is queued. |

**`read` is per-chunk, not total wall-clock.** A 15 s read timeout does **not** mean the whole response
must arrive in 15 s; it means no more than 15 s may elapse *between consecutive chunks*. A 200 MB EDGAR
filing streamed in 30 chunks over 40 s with ≤15 s gaps will **not** trip the read timeout. If you need a
hard total-time ceiling, wrap the call in `asyncio.timeout()` (Python 3.11+) or `asyncio.wait_for()` —
httpx does not offer a single "total request" timeout. This distinction trips people constantly.

### 2.2 Setting it explicitly (the build recipe)

```python
timeout = httpx.Timeout(
    connect=5.0,   # handshake to a healthy GREEN upstream is < 1s; 5s tolerates a slow TLS path
    read=15.0,     # tuned to the SLOWEST acceptable chunk gap (EDGAR full-text can be slow)
    write=10.0,
    pool=5.0,      # don't let a request hang forever waiting for a pool slot — fail fast → typed unavailable
)
client = httpx.AsyncClient(timeout=timeout)
```

The docs' own fine-grained form (https://www.python-httpx.org/advanced/timeouts/):

```python
# Shorthand: first positional = default for all four, kwargs override one.
timeout = httpx.Timeout(10.0, connect=60.0)   # connect=60, read=write=pool=10
client = httpx.Client(timeout=timeout)
```

We **do not** use that shorthand in the data plane — we set all four explicitly so the budget is
auditable and no value is an accident.

### 2.3 Why "never the default" is a hard rule here

The default 5 s applies uniformly to all four phases (https://www.python-httpx.org/advanced/timeouts/).
That's wrong for a market-data ingest in both directions:

- **5 s `connect` is too generous** for a healthy upstream — a connect that takes 5 s is already a
  failed fetch; you want to give up at ~5 s *and convert to `Unavailable`* rather than tie up a pool
  slot, but you also don't want 5 s of latency masquerading as success. We keep connect at 5 s as a
  *ceiling*, paired with transport retries (§3) that re-attempt the handshake fast.
- **5 s `read` is too tight** for large/slow GREEN endpoints (EDGAR full-text search, World Bank
  multi-page indicator pulls) and will spuriously fail real data. We widen `read` to 15 s.
- **The default leaves `pool` at 5 s**, which is *fine* — but only because we set it deliberately. An
  unbounded `pool` (`None`) means a request can hang forever when the pool is saturated, turning a
  transient spike into a permanent hang. Always bound it.

**Per-request override** is available and occasionally right — a known-slow one-off pull can pass its
own budget without changing the client default (https://www.python-httpx.org/advanced/timeouts/):

```python
resp = await client.get(url, timeout=httpx.Timeout(connect=5.0, read=60.0, write=10.0, pool=5.0))
```

Disabling timeouts entirely (`timeout=None`) is **banned in the data plane** — an upstream that hangs
must become a typed `Unavailable`, never an indefinitely-pending coroutine holding a pool slot.

### 2.4 Decision table — timeout per GREEN upstream class

| Upstream class | Latency profile | connect | read | write | pool | Note |
|---|---|---|---|---|---|---|
| Small JSON APIs (World Bank, FRED, Treasury) | fast, small bodies | 5.0 | 10.0 | 10.0 | 5.0 | default-ish; these are quick |
| EDGAR submissions / company-facts JSON | medium | 5.0 | 15.0 | 10.0 | 5.0 | facts JSON can be MBs |
| EDGAR full-text / large filings | slow, large | 5.0 | 30.0 | 10.0 | 5.0 | per-request override, not client default |
| Anything behind a CDN on a bad day | variable | 5.0 | 20.0 | 10.0 | 5.0 | retries (§3) cover transient connect blips |

Set the **client default** to the common case and **override per-request** for the slow outliers.
Don't widen the global `read` to 30 s just because one endpoint needs it — that delays detecting every
*other* upstream's failure.

---

## 3. `httpx.Limits` — pool sizing, never the default

### 3.1 The three knobs and their exact defaults

From https://www.python-httpx.org/advanced/resource-limits/:

| Parameter | Docs definition | **Default** |
|---|---|---|
| `max_connections` | *"maximum number of allowable connections, or `None` for no limits"* | **100** |
| `max_keepalive_connections` | *"number of allowable keep-alive connections, or `None` to always allow"* | **20** |
| `keepalive_expiry` | *"time limit on idle keep-alive connections in seconds, or `None` for no limits"* | **5** (seconds) |

The docs' example (https://www.python-httpx.org/advanced/resource-limits/):

```python
limits = httpx.Limits(max_keepalive_connections=5, max_connections=10)
client = httpx.Client(limits=limits)
```

### 3.2 What each knob actually does

- **`max_connections`** — the hard ceiling on *concurrent* open connections across the whole pool (all
  hosts). Request N+1 when N=`max_connections` are busy **does not fail** — it *waits* up to the `pool`
  timeout for a slot, then raises `PoolTimeout`. This is the back-pressure valve: it's how you stop a
  fan-out from opening 10,000 sockets and flooding an upstream.
- **`max_keepalive_connections`** — of the connections that go idle, how many are kept *warm* for reuse
  instead of being closed. Must be `≤ max_connections`. Set it to the steady-state concurrency you
  expect to a given host so warm sockets are there when the next request arrives.
- **`keepalive_expiry`** — how long an idle warm connection lingers before httpx closes it. The default
  **5 s is short** for a periodic-cron ingest pattern: if your warm path runs a burst, idles 20 s, then
  bursts again, every idle socket has already expired and you re-handshake. Widen it to **30 s** so a
  short idle gap between ingest sub-tasks reuses warm sockets.

### 3.3 The build recipe (and the math behind the numbers)

```python
limits = httpx.Limits(
    max_connections=50,            # global concurrency ceiling PER WORKER PROCESS
    max_keepalive_connections=20,  # warm sockets retained on idle
    keepalive_expiry=30.0,         # idle keep-alive linger (s) — wider than the 5s default
)
```

**Why 50, not the default 100?** The ceiling is a *budget against the throttled upstream*, not a
"go fast" dial. EDGAR's published limit is **10 requests/second total, across all your machines**
(§6). If each request takes ~150 ms, then `10 req/s × 0.15 s = 1.5` connections of steady concurrency
saturate EDGAR's budget — so 50 is already far more headroom than EDGAR allows, and you must *also* rate-limit
in application code (§6.3), because `max_connections` caps concurrency, **not request rate**. The number 50
exists to cap *bursts* and protect *your own* memory/FD budget, not to authorise 50 req/s to a 10-req/s
upstream.

**Remember the per-worker multiplier (§1.3):** with 4 workers, `max_connections=50` means **up to 200
concurrent sockets to a single host across the box**. If the upstream is shared and throttled, divide:
`per_worker_max = upstream_safe_concurrency / worker_count`. For a single dedicated ingest worker
process (the recommended topology — see §5), this is moot, and 50 is a comfortable ceiling.

### 3.4 The `PoolTimeout` ↔ `Limits` ↔ `Timeout` interaction (the subtle one)

These three settings interlock. When `max_connections` connections are all in use:

1. The next request **blocks**, waiting for a slot.
2. It waits up to the **`pool`** sub-timeout (§2).
3. If no slot frees in time → `PoolTimeout` (a subclass of `TimeoutException` → `TransportError`).

So a too-small `max_connections` + a too-small `pool` timeout = spurious `PoolTimeout`s under modest
load. A too-large `max_connections` + an unbounded `pool` = a silent flood of the upstream and unbounded
memory. The data-plane defaults above (`max_connections=50`, `pool=5.0`) are tuned so that healthy load
never queues and a genuinely saturated pool fails *fast and typed* (→ `Unavailable`) rather than hanging.

---

## 4. HTTP/2 — opt-in, and what it actually buys

### 4.1 Enabling it (the exact extra)

From https://www.python-httpx.org/http2/:

```bash
pip install httpx[http2]      # pulls in the optional `h2` package
```

```python
client = httpx.AsyncClient(http2=True)
```

`http2=True` **without** the `h2` extra installed raises `ImportError` at client construction. Pin it in
`pyproject.toml`:

```toml
[project]
dependencies = [
  "httpx[http2]==0.28.1",   # the [http2] extra installs h2
  "fastapi==0.115.*",       # re-confirm current minor before pinning
]
```

### 4.2 What HTTP/2 buys (and when it does nothing)

From the docs (https://www.python-httpx.org/http2/): HTTP/2 enables *"a single TCP stream to handle
multiple concurrent requests"* via **multiplexing**, plus *"efficient compression of HTTP headers"*.

- **Where it helps:** many concurrent requests to the **same host** — exactly the ingest fan-out shape
  (pull 200 EDGAR company-facts in parallel from `data.sec.gov`). Instead of opening up to
  `max_keepalive_connections` separate TCP+TLS connections, HTTP/2 multiplexes them over **one**
  connection, slashing handshake count and FD usage.
- **Where it's a no-op:** the docs warn it's negotiated, not forced — *"enabling HTTP/2 support on the
  client doesn't guarantee that requests will be sent over HTTP/2 … the client will use a standard
  HTTP/1.1 connection instead"* if the server doesn't support it. Many gov/GREEN endpoints are HTTP/1.1
  only; you get HTTP/1.1 pooling, which is still fine.

**Verify what you actually got** (https://www.python-httpx.org/http2/):

```python
resp = await client.get("https://data.sec.gov/...")
assert resp.http_version in ("HTTP/1.0", "HTTP/1.1", "HTTP/2")
log.info("upstream protocol", host=resp.url.host, version=resp.http_version)
```

Log `resp.http_version` per host during bring-up so you know which upstreams negotiated HTTP/2 and which
fell back. There's no harm in leaving `http2=True` on — worst case is a transparent fallback to
HTTP/1.1.

---

## 5. Retries & idempotency — three layers, used for different failures

There are **three distinct retry mechanisms**. They are not interchangeable; each handles a different
failure class. Using the wrong one (e.g. expecting `transport=retries` to catch a 503) is a common,
costly mistake.

### 5.1 Layer 1 — transport `retries`: connect-establishment ONLY

From https://www.python-httpx.org/advanced/transports.md:

> *"Requests will be retried the given number of times in case an `httpx.ConnectError` or an
> `httpx.ConnectTimeout` occurs, allowing smoother operation under flaky networks."*

```python
transport = httpx.AsyncHTTPTransport(retries=2)
client = httpx.AsyncClient(transport=transport, ...)
```

**Exactly what it covers:** failures *establishing the TCP/TLS connection* — `ConnectError`,
`ConnectTimeout`. **What it does NOT cover:** `ReadTimeout`, `WriteTimeout`, `RemoteProtocolError`, or
**any HTTP status code** (429, 500, 503 are *successful* HTTP exchanges as far as the transport is
concerned). The docs are explicit you need `tenacity` for those.

**The backoff sequence (verified in httpcore source, not assumed).** httpx delegates the retry to
httpcore. From `httpcore/_async/connection.py`
(https://github.com/encode/httpcore/blob/master/httpcore/_async/connection.py):

```python
RETRIES_BACKOFF_FACTOR = 0.5  # 0s, 0.5s, 1s, 2s, 4s, etc.
```

The delay generator yields `0` first, then `factor * 2**n` — i.e. the sleep sequence is
**0 s, 0.5 s, 1 s, 2 s, 4 s, …**. So `retries=2` means: attempt → (on ConnectError) sleep 0 s → attempt →
(on ConnectError) sleep 0.5 s → attempt → raise. **Default is `retries=0`** (no connect retries). This is
genuine exponential backoff *for the connect phase only*, with **no jitter** — fine for a single low-volume
ingest worker; if you ever run many parallel workers against one host, add jitter at Layer 2 to avoid a
thundering-herd reconnect.

**This is the right tool for the data plane's default** because the dominant transient failure for
fetching a healthy GREEN upstream over the public internet is a flaky connect (DNS blip, TLS reset), and
retrying the *connection* is safe regardless of HTTP method — it retries *before any request bytes are
sent*, so it can never duplicate a side effect.

### 5.2 Layer 2 — `tenacity`: HTTP-status & read/write retries (with idempotency care)

For retrying on **429 / 503 / read errors**, use `tenacity` (the httpx docs' own recommendation). This
layer requires idempotency reasoning because it re-issues a *fully-formed request*, not just a connect.

```python
import asyncio
import httpx
from tenacity import (
    retry, stop_after_attempt, wait_exponential_jitter,
    retry_if_exception_type, before_sleep_log,
)
import logging

log = logging.getLogger("ingest")

RETRYABLE = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.RemoteProtocolError,   # upstream dropped the connection mid-response
)

class RetryableStatus(Exception):
    """Raised for 429/503 so tenacity retries; carries Retry-After if present."""

@retry(
    stop=stop_after_attempt(4),
    wait=wait_exponential_jitter(initial=0.5, max=20.0),  # jitter avoids herd
    retry=retry_if_exception_type(RETRYABLE + (RetryableStatus,)),
    before_sleep=before_sleep_log(log, logging.WARNING),
    reraise=True,   # on exhaustion, raise the LAST real exception (so §7 can type it)
)
async def fetch_json(client: httpx.AsyncClient, url: str) -> dict:
    resp = await client.get(url)
    if resp.status_code in (429, 500, 502, 503, 504):
        raise RetryableStatus(f"{resp.status_code} for {url}")
    resp.raise_for_status()   # 4xx (except 429) → HTTPStatusError, NOT retried
    return resp.json()
```

The tenacity primitives (https://tenacity.readthedocs.io/):

- `stop_after_attempt(4)` — at most 4 tries total.
- `wait_exponential_jitter(initial=0.5, max=20.0)` — exponential backoff **with jitter**, which the
  plain httpcore backoff lacks; jitter is essential when multiple workers retry the same throttled host
  so they don't all wake at the same instant.
- `retry_if_exception_type(...)` — retry *only* the transient classes; a `404` or a malformed-URL error
  must **not** be retried (it'll never succeed and you waste the upstream's budget).
- `reraise=True` — on exhaustion, re-raise the underlying exception so the failure-isolation wrapper
  (§7) can map it to a typed `Unavailable`. Without it, tenacity raises its own `RetryError` and you
  lose the original cause.

**Honour `Retry-After`.** A 429/503 often carries a `Retry-After` header. Respecting it is both polite
and the difference between recovering and getting IP-banned:

```python
from tenacity import wait_combine, wait_random

def _retry_after_seconds(resp: httpx.Response) -> float | None:
    ra = resp.headers.get("Retry-After")
    if ra is None:
        return None
    try:
        return float(ra)                     # delta-seconds form
    except ValueError:
        from email.utils import parsedate_to_datetime
        from datetime import datetime, timezone
        when = parsedate_to_datetime(ra)     # HTTP-date form
        return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
```

When present, sleep `max(Retry-After, backoff)` before the next attempt. (For status-code retries with
`Retry-After` handling out-of-the-box, the `httpx-retries` library's `RetryTransport` is an option —
see §5.4.)

### 5.3 Idempotency on retried fetches (repo non-negotiable, restated for HTTP)

Every retry **re-sends the request**. For the data plane this is *almost always safe* because the write
path issues **GET** reads against data APIs — GETs are idempotent by HTTP semantics (RFC 9110): the same
GET yields the same resource with no side effect, so retrying it can't double-charge, double-create, or
corrupt anything upstream.

The discipline (for the rare non-GET):

1. **Only auto-retry idempotent methods by default.** GET, HEAD, PUT, DELETE are idempotent; **POST is
   not** (it may create a resource each time). For our GREEN reads this is all GET, so retries are
   unconditionally safe. If a connector ever POSTs (it shouldn't in the data plane), gate its retry on
   an explicit allow-list, not the default.
2. **Idempotency must hold at the SINK, not just the source.** The fetch is idempotent; the *ingest* is
   only idempotent if the DB write is an **upsert keyed by a natural key** (e.g.
   `(symbol, ts) ON CONFLICT DO UPDATE`). If a fetch succeeds, the response is lost to a crash *after*
   the HTTP 200 but *before* the commit, and the whole job re-runs, the re-fetch + upsert must converge
   to the same row — never insert a duplicate or double a counter. This is the repo's atomic-guarded-
   write rule applied to ingest: **never `set qty = N` from app code; upsert by key.** (See the
   `prisma`/timeseries skills for the DB side; here we just guarantee the *fetch* is safely repeatable.)
3. **A retried fetch must not be counted twice in rate-budget accounting** — increment the per-minute
   budget counter (§6.3) once per *successful* upstream call, decided where the budget is checked, not
   per attempt, or retries silently blow the budget.

### 5.4 Optional Layer 3 — `httpx-retries` `RetryTransport` (status-aware at the transport level)

The `httpx-retries` library (https://will-ockmore.github.io/httpx-retries/) provides a transport that
retries on status codes *and* honours `Retry-After`, configured like urllib3's `Retry`:

```python
from httpx_retries import RetryTransport, Retry

retry = Retry(total=5, backoff_factor=0.5)   # exponential; status-aware
transport = RetryTransport(retry=retry)

async with httpx.AsyncClient(transport=transport) as client:
    resp = await client.get("https://example.com")
```

**Trade-off vs tenacity:** `RetryTransport` is cleaner (no decorator on every fetch fn, applies to all
requests through the client) but less granular (one policy for the whole client). For a data plane with
heterogeneous upstreams (EDGAR wants `Retry-After` respected; World Bank rarely 429s), **prefer the
explicit tenacity wrapper per-fetch-function** so each upstream's policy is visible and auditable, and
keep `transport=AsyncHTTPTransport(retries=2)` for the cheap connect-layer safety net underneath. The
two compose — transport retries the connect, tenacity retries the status — but don't stack `RetryTransport`
*and* tenacity (you'd multiply the attempt counts: 5 × 4 = 20 tries, blowing the upstream budget).

### 5.5 Retry decision table

| Failure you observe | Layer that handles it | Why |
|---|---|---|
| `ConnectError`, `ConnectTimeout` (DNS blip, TLS reset, host briefly down) | **Transport `retries`** (§5.1) | Pre-request; safe for any method; cheap. |
| `429 Too Many Requests`, `503 Service Unavailable`, `502/504` | **tenacity** (§5.2) or `RetryTransport` (§5.4) | Status codes; transport retries can't see them. |
| `ReadTimeout`, `RemoteProtocolError` mid-response | **tenacity**, **idempotent GET only** | Re-issuing is safe for GET; risky for POST. |
| `404`, `400`, `401`, malformed URL | **None — fail immediately** | Will never succeed; retrying wastes the upstream budget. → typed `Unavailable`/`NeedsKey`. |
| `403` from EDGAR after a burst | **None — back off the WHOLE worker** | It's an IP block (§6); retrying makes it worse. Pause ingest, alert. |

---

## 6. Timeouts & budgets vs throttled GREEN upstreams

The client's job is to be a *good citizen* of throttled public-domain data sources. Mis-sizing limits or
ignoring rate ceilings gets your IP banned, which is a self-inflicted `Unavailable` for every user.

### 6.1 SEC EDGAR — the hard one

Official policy (https://www.sec.gov/about/developer-resources and the SEC fair-access announcement):

- **Rate limit: no more than 10 requests/second**, counted **per IP, summed across all your machines.**
  The SEC: *"the SEC limits each user to a total of no more than 10 requests per second, regardless of
  the number of machines used to submit requests."*
- **A descriptive `User-Agent` is mandatory.** EDGAR **blocks** requests without one. Required format:
  a company/app name plus a contact email, e.g. `Sample Company AdminContact@sample.com`. Our client
  sets it globally:
  ```python
  headers={"User-Agent": "JPMMarketsAnalytics/1.0 (data-eng@example.com)"}
  ```
- **Consequence of breach:** *"your IP receives a 403 Forbidden response and is blocked for
  approximately 10 minutes."* (https://tldrfiling.com/blog/sec-edgar-api-rate-limits-best-practices)

So for EDGAR: the `User-Agent` header is non-optional, and **`max_connections` alone cannot enforce 10
req/s** — concurrency ≠ rate. You need an application-level rate limiter (§6.3).

### 6.2 World Bank, FRED, Treasury, etc.

- **World Bank Indicators API** (https://datahelpdesk.worldbank.org/) — keyless, no published hard
  req/s, but the docs explicitly advise *"implement a caching layer … that caches results of calls made
  to the API"* and cap per-call payloads (≤ a max number of indicators, ≤ 16k data points/call for
  SDMX). Treat it as "be reasonable + cache aggressively," not "hammer freely." Our compute-once-serve-
  many cache layer (the repo's read-path) does exactly this; the client just shouldn't burst.
- **FRED / Treasury / BLS / BEA** — public-domain, generally generous, but each has its own courtesy
  limits and some want an API key (→ if missing, return **`NeedsKey`**, never fabricate). Pin each
  upstream's limit in a per-source config table, not in code comments.

**Re-verify every upstream's current limit before relying on it** — these change. Pin the verified value
and the date in the source registry.

### 6.3 The application-level rate limiter (because `Limits` ≠ rate)

`httpx.Limits(max_connections=...)` bounds *concurrent sockets*, not *requests per second*. To honour
EDGAR's 10 req/s you need a token-bucket / leaky-bucket *in front of* the client. The clean shape is an
`asyncio.Semaphore` for concurrency **plus** a rate gate:

```python
import asyncio, time

class RateGate:
    """Token bucket: at most `rate` permits per second, shared across the worker."""
    def __init__(self, rate_per_sec: float):
        self._interval = 1.0 / rate_per_sec
        self._lock = asyncio.Lock()
        self._next = time.monotonic()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = max(0.0, self._next - now)
            self._next = max(now, self._next) + self._interval
        if wait:
            await asyncio.sleep(wait)

# one gate per throttled upstream, created in lifespan alongside the client
edgar_gate = RateGate(rate_per_sec=8.0)   # 8, not 10 — leave headroom under the ceiling

async def fetch_edgar(client: httpx.AsyncClient, url: str) -> dict:
    await edgar_gate.acquire()            # never exceed EDGAR's 10/s (we target 8/s)
    return await fetch_json(client, url)  # fetch_json carries the tenacity retry (§5.2)
```

Target **below** the published ceiling (8 of 10) to absorb retries and clock skew. The gate lives on
`app.state` next to the client and is shared by every ingest task in the worker process. (At >1 worker
process, a per-process gate of 8/s × 4 workers = 32/s **breaks EDGAR's 10/s** — another reason the ingest
path is **one dedicated worker process**, §1.3 + the worker-topology rule. A multi-process ingest needs a
*distributed* rate limiter, e.g. a Redis token bucket, not a per-process `RateGate`.)

---

## 7. Failure isolation — httpx exception → typed `Unavailable` (the #1 rule lives here)

This is the section the whole file exists for. **A failed fetch must NEVER become a fabricated number.**
The repo's non-negotiable #1: *"Failed tools return typed `unavailable`/`needsKey`, never fabricated
data."* The client's failure-isolation wrapper is how that rule is mechanically enforced at the data
plane's only door.

### 7.1 The httpx exception hierarchy (so you map every case)

From https://www.python-httpx.org/exceptions/ — the tree you must handle:

```
HTTPError
├── RequestError              # raised issuing the request
│   └── TransportError
│       ├── TimeoutException
│       │   ├── ConnectTimeout
│       │   ├── ReadTimeout
│       │   ├── WriteTimeout
│       │   └── PoolTimeout
│       ├── NetworkError
│       │   ├── ConnectError
│       │   ├── ReadError
│       │   ├── WriteError
│       │   └── CloseError
│       ├── ProtocolError (LocalProtocolError / RemoteProtocolError)
│       ├── ProxyError
│       └── UnsupportedProtocol
└── HTTPStatusError           # raised by resp.raise_for_status() on 4xx/5xx
```

Key facts:
- `HTTPError` is the common base for `RequestError` **and** `HTTPStatusError` — a single
  `except httpx.HTTPError` catches both a transport failure and a bad status, but you usually want to
  distinguish them.
- `HTTPStatusError` is **only** raised if you *call* `resp.raise_for_status()`. A 404 does **not** throw
  on its own — `await client.get(...)` returns a `Response` with `.status_code == 404` and you decide.
- `raise_for_status()` *"raises `HTTPStatusError` for error status codes (4xx/5xx)."*

### 7.2 The typed result envelope

Model the outcomes as a typed union so a caller *cannot* read a number out of a failure:

```python
from dataclasses import dataclass
from enum import Enum
from typing import Generic, TypeVar

T = TypeVar("T")

class FailureKind(str, Enum):
    TIMEOUT = "timeout"
    CONNECT = "connect"
    UPSTREAM_5XX = "upstream_5xx"
    NOT_FOUND = "not_found"
    RATE_LIMITED = "rate_limited"
    NEEDS_KEY = "needs_key"
    BAD_RESPONSE = "bad_response"   # malformed JSON / schema mismatch
    UNKNOWN = "unknown"

@dataclass(frozen=True)
class Ok(Generic[T]):
    value: T

@dataclass(frozen=True)
class Unavailable:
    kind: FailureKind
    detail: str          # for logs/observability — NEVER shown as a value
    status_code: int | None = None
    retry_after_s: float | None = None

@dataclass(frozen=True)
class NeedsKey:
    provider: str

# The ONLY thing a fetch may return:
FetchResult = Ok[T] | Unavailable | NeedsKey
```

The point of the union: downstream code must `match` on it. There is **no code path** that yields a
plausible-looking float on failure. A `None`-returning fetch (`-> float | None`) is *banned* here,
because a `None` silently coerced to `0.0` somewhere downstream is exactly the "fabricated number" the
rule forbids — the typed `Unavailable` makes the failure un-ignorable.

### 7.3 The wrapper (the canonical mapping)

```python
import httpx
import logging

log = logging.getLogger("fetch")

async def safe_fetch_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    provider: str,
    api_key_present: bool = True,
    **kwargs,
) -> FetchResult[dict]:
    """The ONLY way the data plane calls an upstream. Every exit is typed."""
    if not api_key_present:
        return NeedsKey(provider=provider)   # never fabricate to look complete

    try:
        resp = await client.get(url, **kwargs)
    except httpx.PoolTimeout as e:
        log.warning("pool exhausted", url=url, err=str(e))
        return Unavailable(FailureKind.TIMEOUT, f"pool: {e}")
    except httpx.TimeoutException as e:        # Connect/Read/Write timeouts
        log.warning("timeout", url=url, err=str(e))
        return Unavailable(FailureKind.TIMEOUT, f"timeout: {e}")
    except httpx.ConnectError as e:
        log.warning("connect failed", url=url, err=str(e))
        return Unavailable(FailureKind.CONNECT, f"connect: {e}")
    except httpx.RequestError as e:            # any other transport-level failure
        log.warning("request error", url=url, err=str(e))
        return Unavailable(FailureKind.UNKNOWN, f"request: {e}")

    # We have a Response. Decide on status BEFORE trusting the body.
    sc = resp.status_code
    if sc == 404:
        return Unavailable(FailureKind.NOT_FOUND, f"404 {url}", status_code=404)
    if sc == 429:
        ra = _retry_after_seconds(resp)
        return Unavailable(FailureKind.RATE_LIMITED, "429", status_code=429, retry_after_s=ra)
    if sc in (401, 403):
        # EDGAR 403 after a burst = IP block; an auth 401 = key problem.
        return Unavailable(FailureKind.NEEDS_KEY if sc == 401 else FailureKind.UPSTREAM_5XX,
                           f"{sc} {url}", status_code=sc)
    if sc >= 500:
        return Unavailable(FailureKind.UPSTREAM_5XX, f"{sc} {url}", status_code=sc)
    if sc >= 400:
        return Unavailable(FailureKind.UNKNOWN, f"{sc} {url}", status_code=sc)

    # 2xx — but a 200 with garbage is still NOT a number. Validate the body.
    try:
        data = resp.json()
    except ValueError as e:                    # malformed JSON
        log.error("bad json", url=url, err=str(e))
        return Unavailable(FailureKind.BAD_RESPONSE, f"json: {e}", status_code=sc)

    return Ok(data)
```

Notes that matter:

- **Order of `except` clauses matters.** `PoolTimeout` ⊂ `TimeoutException` ⊂ `TransportError` ⊂
  `RequestError`. Catch the *most specific* first (here we split `PoolTimeout` and `ConnectError` out
  for distinct telemetry); a bare `except httpx.RequestError` last is the catch-all.
- **A 200 is not a success.** The "GREEN-but-wrong" trap (repo rule): a public-domain source can return
  a 200 with a duplicate/non-comparable/garbage value. The wrapper validates the *shape* (`resp.json()`
  parses), and the **caller still validates the value** (range checks, freshness, schema) before it's
  persisted or shown. The wrapper guarantees "no exception leaked and the body is well-formed JSON" — it
  does **not** guarantee the number is *right*. Grounding/validation is a separate, mandatory step.
- **`detail` is for logs only.** It never reaches a user surface as a value. The user/agent sees
  "data unavailable for X", never the raw error string and never a backfilled placeholder.

### 7.4 What the caller does with the result (no silent fabrication)

```python
result = await safe_fetch_json(client, url, provider="edgar")
match result:
    case Ok(value):
        await upsert_facts(value)                      # validated + idempotent upsert
    case NeedsKey(provider):
        record_provider_state(provider, "needs_key")   # surfaced as needsKey, not a value
    case Unavailable(kind, detail, status, retry_after):
        record_unavailable(url, kind, detail)          # the field is marked unavailable
        if kind is FailureKind.RATE_LIMITED:
            await backoff_worker(retry_after)          # pause; never hammer
```

The persisted record carries an explicit `unavailable` marker for that field/timestamp. The read path
(§8) serves the *last known good* value with its real `as_of` timestamp, or an explicit "unavailable"
state — it **never** interpolates a fake current value to fill the gap. Stale-but-labelled beats
fabricated.

---

## 8. The read-never-fetches enforcement (why read routes don't get the client)

This is the architectural payoff of putting the client on `app.state` and injecting it *narrowly*.

### 8.1 The contract

| Plane | Gets the `AsyncClient`? | What it does |
|---|---|---|
| **Write / ingest / warm path** (the worker, cron-triggered jobs) | **Yes** — pulls `app.state.upstream`, fetches, validates, upserts into the warehouse + warms the cache. | The *only* code that touches an upstream. |
| **Read path** (the FastAPI request handlers serving the API/UI) | **No** — never sees `app.state.upstream`. Reads from the warehouse / Redis only. | Compute-once-serve-many; cannot make an upstream call even by accident. |

The repo's read-spike rule (compute-once-serve-many) and non-negotiable #4 (no sockets/timers on the
serverless request path — here generalised to "no upstream fetch on the read path") are enforced not by
discipline but by **wiring**: the read handlers' dependency graph simply doesn't include the client.

### 8.2 How to make it enforceable, not just conventional

Use FastAPI dependency injection so the *type system and the DI graph* express the rule:

```python
from fastapi import Request, Depends
import httpx

# Provided ONLY to write/worker routers. Read routers never import this.
def get_upstream(request: Request) -> httpx.AsyncClient:
    return request.app.state.upstream

# Read path depends on the REPOSITORY (warehouse/cache), never on get_upstream.
def get_repo(request: Request) -> "MarketDataRepo":
    return request.app.state.repo

# --- write/ingest router (worker-triggered) ---
@ingest_router.post("/ingest/edgar-facts")
async def ingest(client: httpx.AsyncClient = Depends(get_upstream)):
    ...   # fetches via the shared client

# --- read router (serves users) ---
@read_router.get("/series/{symbol}")
async def read_series(symbol: str, repo: "MarketDataRepo" = Depends(get_repo)):
    return await repo.get_series(symbol)   # warehouse/cache only — NO get_upstream in scope
```

The enforcement properties:

1. **`get_upstream` is importable only in write modules.** A read handler that tried to fetch would have
   to import `get_upstream` (or reach into `request.app.state.upstream`) — a one-line `grep` over the
   read package catches it in review/CI. Add a lint rule: `app/api/read/**` may not reference
   `app.state.upstream` or `get_upstream`.
2. **The read repo's interface has no fetch method.** `MarketDataRepo` exposes `get_series`,
   `get_latest`, etc. — all warehouse/cache reads. There is no `repo.fetch_upstream()`, so a read
   handler *physically cannot* originate an upstream call through its injected dependencies.
3. **Separate routers, separate concerns.** Ingest endpoints are `CRON_SECRET`-guarded and called by the
   scheduler/worker only; read endpoints are public/auth'd and never trigger a fetch. (This mirrors the
   repo's worker/cron split — heavy/scheduled fetch work runs off the request path.)

### 8.3 Why this matters at scale (R-SCALE tie-in)

If read handlers could fetch on a cache miss, a read spike (every user hitting `/series/AAPL` at the
open) becomes a fetch storm against the throttled upstream — 10,000 read requests → 10,000 EDGAR calls →
instant 403 IP-ban → total outage. The read-never-fetches wiring makes that *structurally impossible*:
reads serve from the warehouse/cache (compute-once-serve-many), and the **single** warm path refreshes
the cache on a schedule through the **single** rate-gated client. Read capacity scales (cache/replicas)
without ever touching the write/fetch capacity — exactly the repo's "scale reads without touching
writes" principle.

---

## 9. Lifecycle, observability, and testing the client

### 9.1 Graceful shutdown (drain, don't sever)

`await app.state.upstream.aclose()` in the `lifespan` `finally` (§1.3) closes the pool and lets in-flight
requests complete their close handshake. Combined with the ASGI server's graceful-shutdown window
(Uvicorn drains active requests on `SIGTERM`), this avoids severing a fetch mid-stream and leaking a
half-read socket. **Never** skip `aclose()` — the docs' warning bears repeating:
*"Failing to do so would leave connections open, most likely resulting in resource leaks."*
(https://www.python-httpx.org/async/).

### 9.2 Observability hooks (instrument the door)

httpx supports **event hooks** for `request` and `response` — wire structured logging + metrics once, at
the client, so every fetch is observable without touching call sites:

```python
async def _log_request(request: httpx.Request):
    log.debug("→ upstream", method=request.method, url=str(request.url))

async def _log_response(response: httpx.Response):
    await response.aread()   # ensure body is available if you need size
    log.info("← upstream",
             url=str(response.request.url),
             status=response.status_code,
             http_version=response.http_version,
             elapsed_ms=response.elapsed.total_seconds() * 1000)

client = httpx.AsyncClient(
    timeout=timeout, limits=limits, transport=transport, http2=True,
    headers={"User-Agent": "JPMMarketsAnalytics/1.0 (data-eng@example.com)"},
    event_hooks={"request": [_log_request], "response": [_log_response]},
)
```

Emit metrics for: request count & status per host, `elapsed` latency histogram, retry count, `Unavailable`
count by `FailureKind`, and **pool saturation** (a rising `PoolTimeout` rate means `max_connections` is
too low for the load — the §3.4 signal). These are how you *detect* the failures §7 isolates.

### 9.3 Testing — `MockTransport`, no network

httpx ships a `MockTransport` (https://www.python-httpx.org/advanced/transports.md) so tests never hit
the real upstream — fast, deterministic, and the only way to exercise the §7 error mapping:

```python
import httpx, pytest

def _handler(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/ok"):
        return httpx.Response(200, json={"price": 101.5})
    if request.url.path.endswith("/rate"):
        return httpx.Response(429, headers={"Retry-After": "30"})
    if request.url.path.endswith("/down"):
        return httpx.Response(503)
    return httpx.Response(404)

@pytest.fixture
def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(_handler))

@pytest.mark.anyio
async def test_429_maps_to_rate_limited(client):
    res = await safe_fetch_json(client, "https://x/rate", provider="edgar")
    assert isinstance(res, Unavailable)
    assert res.kind is FailureKind.RATE_LIMITED
    assert res.retry_after_s == 30.0           # Retry-After parsed

@pytest.mark.anyio
async def test_404_never_returns_a_number(client):
    res = await safe_fetch_json(client, "https://x/missing", provider="edgar")
    assert isinstance(res, Unavailable)        # NOT an Ok with a fabricated value
    assert res.kind is FailureKind.NOT_FOUND
```

To simulate a transport-level exception (timeout/connect) the handler can raise:

```python
def _timeout_handler(request):
    raise httpx.ConnectTimeout("simulated", request=request)
```

The test that matters most for the repo's #1 rule: **assert that every failure path returns an
`Unavailable`/`NeedsKey`, never an `Ok` and never a default number.** That test is the executable form of
"never invent a finance number."

`pytest-httpx` (https://pypi.org/project/pytest-httpx/) is the higher-level alternative — a fixture
(`httpx_mock`) that registers responses/exceptions declaratively. Either works; `MockTransport` keeps the
dependency surface minimal.

---

## 10. Full assembled recipe (copy-paste starting point)

```python
# app/clients/http.py
import httpx

USER_AGENT = "JPMMarketsAnalytics/1.0 (data-eng@example.com)"   # EDGAR requires this

def build_upstream_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0),
        limits=httpx.Limits(
            max_connections=50,
            max_keepalive_connections=20,
            keepalive_expiry=30.0,
        ),
        transport=httpx.AsyncHTTPTransport(retries=2),   # connect-layer retries
        http2=True,                                      # needs httpx[http2]
        headers={"User-Agent": USER_AGENT},
        follow_redirects=False,
    )
```

```python
# app/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.clients.http import build_upstream_client
from app.clients.rate import RateGate

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.upstream = build_upstream_client()
    app.state.edgar_gate = RateGate(rate_per_sec=8.0)   # under EDGAR's 10/s ceiling
    try:
        yield
    finally:
        await app.state.upstream.aclose()

app = FastAPI(lifespan=lifespan)
# read routers depend on the repo; only write/ingest routers depend on get_upstream.
```

Checklist before this client ships:

- [ ] Exactly one `AsyncClient` in the codebase (grep `AsyncClient(`), created in `lifespan`, on `app.state`.
- [ ] `aclose()` in the `lifespan` `finally`.
- [ ] All four `Timeout` sub-values set explicitly; no `timeout=None` anywhere.
- [ ] `Limits` set explicitly; `max_connections` budgeted against the throttled upstream × worker count.
- [ ] `httpx[http2]` pinned; `http2=True`; `resp.http_version` logged during bring-up.
- [ ] Transport `retries=2` (connect) + per-fetch tenacity (status/read) with `reraise=True` and jitter.
- [ ] EDGAR `User-Agent` header present; application-level `RateGate` ≤ the published req/s ceiling.
- [ ] Every fetch goes through `safe_fetch_json` → returns `Ok` | `Unavailable` | `NeedsKey`, never a number on failure.
- [ ] Read routers do **not** import `get_upstream` / touch `app.state.upstream` (lint + grep enforced).
- [ ] `MockTransport` tests assert every failure path is typed, never an `Ok`/default value.

---

## Sources (verified this pass — June 2026)

Primary (httpx official docs + source):
- Clients / connection pooling — https://www.python-httpx.org/advanced/clients/ (*"reuse the underlying TCP connection"*, *"reduced latency … no handshaking"*).
- Async support — https://www.python-httpx.org/async/ (`async with httpx.AsyncClient()`, `await client.aclose()`, the hot-loop warning, the resource-leak warning).
- Resource limits — https://www.python-httpx.org/advanced/resource-limits/ (defaults: `max_connections=100`, `max_keepalive_connections=20`, `keepalive_expiry=5`).
- Timeouts — https://www.python-httpx.org/advanced/timeouts/ (the four types + exceptions; default 5 s; `httpx.Timeout`).
- HTTP/2 — https://www.python-httpx.org/http2/ (`pip install httpx[http2]`, `http2=True`, `resp.http_version`, negotiated-not-forced).
- Transports — https://www.python-httpx.org/advanced/transports.md and https://github.com/encode/httpx/blob/master/docs/advanced/transports.md (`retries` on `ConnectError`/`ConnectTimeout` only; recommends tenacity; `MockTransport`).
- Exceptions — https://www.python-httpx.org/exceptions/ (the `HTTPError`→`RequestError`/`HTTPStatusError` hierarchy; `raise_for_status`).
- **httpcore retry source** — https://github.com/encode/httpcore/blob/master/httpcore/_async/connection.py (`RETRIES_BACKOFF_FACTOR = 0.5 # 0s, 0.5s, 1s, 2s, 4s, etc.`; retries on `ConnectError`/`ConnectTimeout`; default `retries=0`).
- httpx version — https://pypi.org/project/httpx/ (0.28.1, 2024-12-06).

FastAPI / tenacity:
- FastAPI lifespan — https://fastapi.tiangolo.com/advanced/events/ (`@asynccontextmanager` lifespan, before/after `yield`, replaces startup/shutdown events).
- tenacity — https://tenacity.readthedocs.io/ (`@retry`, `stop_after_attempt`, `wait_exponential_jitter`, `retry_if_exception_type`, `reraise`).
- httpx-retries — https://will-ockmore.github.io/httpx-retries/ (`RetryTransport`, `Retry(total=, backoff_factor=)`, status-aware + `Retry-After`).

GREEN-upstream throttles:
- SEC EDGAR — https://www.sec.gov/about/developer-resources + https://www.sec.gov/filergroup/announcements-old/new-rate-control-limits + https://tldrfiling.com/blog/sec-edgar-api-rate-limits-best-practices (10 req/s per IP across all machines; mandatory descriptive `User-Agent`; 403 + ~10-min IP block on breach).
- World Bank Indicators API — https://datahelpdesk.worldbank.org/knowledgebase/articles/902064-development-best-practices (keyless; "implement a caching layer"; per-call payload caps).

Mechanism (cross-checked, secondary):
- Per-request-client anti-pattern / TIME_WAIT socket exhaustion — https://medium.com/@sparknp1/8-httpx-asyncio-patterns-for-safer-faster-clients-f27bc82e93e6 and https://www.hougaard.com/httpclient-requires-an-anti-pattern-for-performance/ (handshake re-pay, ~4-min TIME_WAIT linger, ephemeral-port exhaustion).

Repo cross-refs: `CLAUDE.md` non-negotiable #1 (never invent a finance number; typed `unavailable`/`needsKey`) and #4 (no sockets/timers on the serverless request path → fetch lives in the worker/write path); the `02-skills` GREEN-provider throttle notes and the `timescaledb-timeseries` sibling skill for the ingest/upsert sink.
