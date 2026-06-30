# Structured Logging & Observability (JSON logs · correlation IDs · async-safe)

> **Skill:** `python-fastapi-data-service` · **Product line:** JPM-Markets re-engineering
> **data-analytics service (NOT Lumina).** This is a *new* Python/FastAPI/data-engineering line —
> separate from Lumina's Bun + Express + Prisma + Upstash stack. Nothing here ships to Lumina.
>
> **This reference (theory + recipe):** production-grade **structured JSON logging** for the data
> plane — every line machine-parseable, every line for a request carrying a **correlation ID**, and
> the whole thing **async-safe** under Uvicorn's coroutine concurrency. It covers the structlog +
> stdlib bridge that funnels *both* your app logs and Uvicorn's own loggers through one JSON
> formatter, the `contextvars`-based request-id binding (and the subtle `BaseHTTPMiddleware`
> pitfall that silently drops it), the per-request access log, what must never reach a log line,
> and the hook from a logged error back to the response's correlation ID.
>
> **Versions pinned this session (verify before relying):**
> - **structlog 26.1.0** — current stable, docs at
>   [structlog.org/en/stable](https://www.structlog.org/en/stable/api.html) (API reference header
>   reads "structlog 26.1.0 documentation").
> - **asgi-correlation-id 4.3.4** — current, [PyPI](https://pypi.org/project/asgi-correlation-id/) /
>   [libraries.io](https://libraries.io/pypi/asgi-correlation-id).
> - **uvicorn 0.49.0** — released 2026-06-03, [PyPI](https://pypi.org/project/uvicorn/) /
>   [release notes](https://uvicorn.dev/release-notes/).
> - **orjson 3.x** line — optional fast JSON serializer (used by structlog's `JSONRenderer` if passed
>   `serializer=orjson.dumps`, or via `BytesLoggerFactory`).
> - Python **3.11+** (assumed for `X | None` unions, `tomllib`, fast `contextvars`).
>
> Companion refs: `fastapi-app-structure-and-lifespan.md` (where `setup_logging()` is called from
> the lifespan), `background-work-and-the-worker-boundary.md` (propagating the correlation ID into
> Celery/worker tasks), and the error-envelope contract that this doc's §9 hooks into.

---

## 0. Plain-language on-ramp (the "so what")

When this service is one developer on a laptop, `print()` and Uvicorn's default coloured access log
are fine. When it is a fleet of containers behind a load balancer, serving a market-data platform,
two things break at once:

1. **You can't read coloured prose at scale.** A human-formatted line like
   `INFO: 127.0.0.1:53122 - "GET /v1/quotes/AAPL HTTP/1.1" 200 OK` is unparseable by machines. The
   log aggregator (Grafana **Loki**, **Datadog**, **ELK/OpenSearch**, Google Cloud Logging) wants
   **one JSON object per line** with consistent typed fields — `level`, `timestamp`, `event`,
   `status`, `duration_ms` — so you can query `status>=500 AND path="/v1/quotes/*"` instead of
   grepping text.

2. **You can't follow one request across many log lines.** A single `/v1/analytics/var` request might
   emit ten lines (cache miss → upstream fetch → DB write → compute → response) interleaved with a
   hundred *other* concurrent requests' lines. Without a **correlation ID** stamped on every line of
   *that* request, the logs are a shuffled deck. With one, you filter on `correlation_id=abc123` and
   the request's entire story reassembles in order.

The mechanism that makes the correlation ID "stick" to every line for the duration of a request —
without you threading it through every function call — is Python's `contextvars`. structlog's
`merge_contextvars` processor reads that context-local store and merges it into every event dict.
That is the whole trick, and the whole danger: `contextvars` are **isolated per concurrency
mechanism** (sync thread vs. async task), and FastAPI's `@app.middleware("http")`
(`BaseHTTPMiddleware`) runs your endpoint in a *separate* anyio task with a *copied* context — so a
value you bind in the endpoint is **invisible** when the middleware reads it back. §6 is the
load-bearing section: get the middleware layer wrong and your correlation IDs silently vanish from
half your logs.

**What you walk away able to build:** a `setup_logging(json: bool)` that renders dev as pretty
console and prod as JSON; both your structlog logs *and* Uvicorn's `uvicorn.error` / `uvicorn.access`
in that same JSON; a request-id middleware (the correct ASGI kind) that stamps every line; a
per-request access log with `method/path/status/duration_ms/correlation_id`; a redaction discipline
so secrets never land in a log; and the `correlation_id` echoed into the error response so a user's
screenshot of a `500` is enough to find the exact log lines.

---

## 1. Why JSON structured logs (the contract, not the cargo cult)

A log line has two audiences and they want opposite things:

| Audience | Wants | Format |
|---|---|---|
| A human at a terminal during dev | colour, alignment, readable tracebacks | `ConsoleRenderer` (pretty) |
| A log pipeline in prod (Loki/Datadog/ELK) | one parseable object per line, typed fields, stable keys | `JSONRenderer` (machine) |

**The design rule: emit *structured events*, render the format at the edge.** You write
`log.info("upstream_fetch", provider="twelvedata", symbol="AAPL", ms=42, status=200)` — an event name
plus key/value pairs — and a *renderer* at the end of the pipeline turns that into either pretty
console (dev) or a JSON object (prod). The same call site serves both. This is structlog's core idea
and why it beats `logging.getLogger().info(f"...")` f-string interpolation, which bakes the values
into an opaque string the moment you write it.

**Why one-JSON-object-per-line specifically.** Log shippers split on newlines. If a log line is valid
JSON, the shipper parses it into fields with zero config; if it is prose, you must write and maintain
brittle Grok/regex parsers per message shape, and any message you forget to parse becomes a blob you
cannot query. structlog's official best-practices guidance is to "log to unbuffered standard out and
let other tools take care of the rest" and to use JSON in production rather than pretty-printing
([structlog: Logging Best Practices](https://www.structlog.org/en/stable/logging-best-practices.html)).
The container runtime captures stdout/stderr; the platform's agent (Promtail/Alloy for Loki, the
Datadog agent, Filebeat for ELK) tails it and ships it. **Your app never opens a network socket to a
log backend** — that would be a blocking I/O dependency on the request path, exactly the kind of
serverless/worker hazard the companion refs warn against. Log to stdout; let the platform ship it.

**The fields that earn their place on every line** (the schema this line standardises on):

| Field | Type | Source | Why |
|---|---|---|---|
| `timestamp` | ISO-8601 string (UTC) | `TimeStamper(fmt="iso")` | sortable, timezone-unambiguous |
| `level` | string (`info`/`error`/…) | `add_log_level` | filter by severity |
| `logger` | string (e.g. `app.pricing`) | `add_logger_name` | which subsystem |
| `event` | string | the first positional arg to `log.info(...)` | the message / event name |
| `correlation_id` | string (uuid hex) | `merge_contextvars` ← request middleware | stitch a request together |
| `duration_ms` | number | access-log middleware | latency, the #1 ops metric |

> **Anti-pattern:** putting human-readable interpolation in the `event` string —
> `log.info(f"fetched {symbol} in {ms}ms")`. Now `symbol` and `ms` are un-queryable. Write
> `log.info("upstream_fetch", symbol=symbol, ms=ms)`; the event name stays a *constant* you can
> `GROUP BY`.

---

## 2. The two libraries, and why structlog over stdlib-only

You have two viable stacks. Both are legitimate; this line picks structlog, and you must understand
the trade so you can defend it (and fall back if a dependency constraint forbids structlog).

### Option A — stdlib `logging` + `python-json-logger`

Pure standard library plus one thin formatter. You configure a `logging.dictConfig` whose formatter
is `pythonjsonlogger.jsonlogger.JsonFormatter`. Correlation IDs come in via a **logging filter**
(`asgi-correlation-id`'s `CorrelationIdFilter`) that injects `record.correlation_id` so the formatter
can include `%(correlation_id)s`. This is the lowest-dependency path and the one to choose if the
service must avoid extra deps or already standardises on stdlib `dictConfig`.

```python
# Option A: stdlib + python-json-logger + asgi-correlation-id filter
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "correlation_id": {
            "()": "asgi_correlation_id.CorrelationIdFilter",
            "uuid_length": 32,         # full uuid4().hex; set 8 for shorter dev IDs
            "default_value": "-",      # what appears when no request context (startup, cron)
        },
    },
    "formatters": {
        "json": {
            "()": "pythonjsonlogger.jsonlogger.JsonFormatter",
            "format": "%(asctime)s %(levelname)s %(name)s %(correlation_id)s %(message)s",
            "rename_fields": {"asctime": "timestamp", "levelname": "level", "name": "logger"},
        },
    },
    "handlers": {
        "default": {
            "class": "logging.StreamHandler",
            "filters": ["correlation_id"],
            "formatter": "json",
            "stream": "ext://sys.stdout",
        },
    },
    "loggers": {
        "": {"handlers": ["default"], "level": "INFO"},
        "uvicorn":        {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error":  {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.access": {"handlers": ["default"], "level": "INFO", "propagate": False},
    },
}
```

The filter-class path and parameters (`uuid_length`, `default_value`) are documented in
[snok/asgi-correlation-id](https://github.com/snok/asgi-correlation-id) — see the "Standard logging
integration" example.

### Option B — `structlog` (this line's choice) + stdlib bridge

structlog adds the **processor pipeline**: a composable chain of small functions
(`event_dict -> event_dict`) that enrich each event before a final renderer serialises it. The
reasons this line picks it:

1. **`merge_contextvars` is first-class.** Binding the correlation ID is one processor; with stdlib
   you need a custom filter per field.
2. **One pipeline, dev and prod.** Swap the last processor (`ConsoleRenderer` ↔ `JSONRenderer`) and
   the same call sites render either way — no second formatter config.
3. **Structured tracebacks (`dict_tracebacks`)** turn an exception into a JSON object (frames, lines,
   locals) instead of a multi-line string the shipper can't keep on one line.
4. **The stdlib bridge (`ProcessorFormatter`) is built for exactly our problem** — funnelling
   *foreign* logs (Uvicorn, SQLAlchemy, httpx) through the *same* structlog renderer so the whole
   process emits one consistent JSON shape. structlog's standard-library docs describe
   `ProcessorFormatter` as "a `logging.Formatter` that enables consistent formatting of both
   structlog and standard library log entries"
   ([Standard Library Logging](https://www.structlog.org/en/stable/standard-library.html)).

**The cost:** two configs that must agree (the `structlog.configure(...)` chain *and* the
`ProcessorFormatter`'s chain), which is the single most error-prone part and gets its own section
(§4). If that complexity isn't worth it for a small service, Option A is a defensible downgrade — say
so explicitly rather than half-building Option B.

> **Decision rule for this line:** default to **B (structlog)** for any service that handles request
> traffic; use **A** only for a pure batch/cron worker where the contextvars dance buys nothing.

---

## 3. structlog's processor pipeline — the mental model

A structlog logger call (`log.info("event", k=v)`) creates an `event_dict` (`{"event": "event",
"k": v}`) and pushes it through an ordered list of **processors**. Each processor takes
`(logger, method_name, event_dict)` and returns a (possibly mutated) `event_dict`. The **last**
processor is a *renderer* that turns the dict into the final output (a string for `JSONRenderer`,
bytes for orjson-backed renderers).

The processors this line uses, in the order they must run, and *why each*:

| # | Processor | What it does | Why this position |
|---|---|---|---|
| 1 | `structlog.contextvars.merge_contextvars` | merges request-scoped context (the correlation ID) into the event dict | **must be early** so later processors and the renderer see those keys |
| 2 | `structlog.stdlib.add_log_level` | adds `level` (`info`/`error`/…) from the method name | before render; cheap |
| 3 | `structlog.stdlib.add_logger_name` | adds `logger` (e.g. `app.pricing`) | before render |
| 4 | `structlog.processors.TimeStamper(fmt="iso")` | adds an ISO-8601 `timestamp` (UTC) | before render; pin `iso` for sortability |
| 5 | `structlog.processors.StackInfoRenderer()` | renders `stack_info=True` call sites | before exc handling |
| 6 | `structlog.processors.dict_tracebacks` *(prod JSON)* **or** `format_exc_info` | turns `exc_info` into a structured dict (prod) or a string (legacy) | must run before the renderer |
| 7 | `structlog.processors.CallsiteParameterAdder([...])` *(optional)* | adds `func_name`/`lineno`/`filename` | before render; costs a stack walk — see §3.1 |
| **last** | `JSONRenderer()` (prod) / `ConsoleRenderer()` (dev) | serialise the dict | **must be last** — output processors are always terminal |

The official API names and behaviours are in
[structlog Processors](https://www.structlog.org/en/stable/processors.html) and
[API Reference](https://www.structlog.org/en/stable/api.html) (structlog 26.1.0). The critical
ordering rule, stated by structlog's own community guidance, is that "the processor that handles
output is always the last one in the chain"
([BetterStack structlog guide](https://betterstack.com/community/guides/logging/structlog/)).

### 3.1 `dict_tracebacks` vs `format_exc_info` — pick the right exception renderer

- **`format_exc_info`** renders the traceback as a single multi-line **string** under an
  `exception` key. Fine for console; in JSON it produces embedded `\n`s and is hard to query.
- **`dict_tracebacks`** renders the traceback as a **structured list** of frames (filename, lineno,
  function, and, if enabled, locals) — a real JSON object the aggregator can index and you can click
  through. This is the production choice. structlog's best-practices page shows the production JSON
  pipeline using `structlog.processors.dict_tracebacks` followed by `JSONRenderer()`
  ([Logging Best Practices](https://www.structlog.org/en/stable/logging-best-practices.html)). The
  structured-traceback parser was added in
  [structlog PR #407](https://github.com/hynek/structlog/pull/407).

> **Caution on `dict_tracebacks` + locals:** it can serialise frame-local variables. If a local holds
> an API key or a raw payload, it lands in the log. See §8 — exception locals are a real PII/secret
> leak vector. Keep secrets out of locals near the failure site, or post-process.

### 3.2 `CallsiteParameterAdder` — useful, but it costs

`CallsiteParameterAdder([CallsiteParameter.FUNC_NAME, CallsiteParameter.LINENO])` stamps each line
with where it was logged. It is genuinely helpful for debugging, **but it walks the Python stack on
every log call**, which is measurable under load. Enable it in dev and for `ERROR`+ in prod, not for
high-volume `INFO` access logs. Example usage shape from the
[BetterStack guide](https://betterstack.com/community/guides/logging/structlog/):

```python
structlog.processors.CallsiteParameterAdder(
    [structlog.processors.CallsiteParameter.FUNC_NAME,
     structlog.processors.CallsiteParameter.LINENO]
)
```

### 3.3 `cache_logger_on_first_use=True` — the cheap, important perf flag

Set it in `structlog.configure(...)`. It freezes the bound logger after the first call so structlog
skips re-building the processor chain on every `get_logger()`. The
[apitally guide](https://apitally.io/blog/fastapi-logging-guide) and structlog's own performance docs
recommend it for production. The one caveat: with caching on, you cannot change configuration after
the first log call — which is fine because `setup_logging()` runs once at boot, before any request.

### 3.4 Performance tier: `BytesLoggerFactory` + orjson

For the hottest paths, the fastest structlog config renders directly to **bytes** with **orjson** and
writes them to a `BytesLogger`, skipping the str→bytes encode the stdlib handler does:

```python
import orjson, structlog

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.dict_tracebacks,
        structlog.processors.JSONRenderer(serializer=orjson.dumps),
    ],
    logger_factory=structlog.BytesLoggerFactory(),   # writes bytes straight to stdout
    cache_logger_on_first_use=True,
)
```

`JSONRenderer(serializer=orjson.dumps)` returns `bytes` (orjson emits bytes), which `BytesLoggerFactory`
writes without re-encoding; orjson also serialises `datetime` natively. **The trade-off:** this path
**bypasses the stdlib bridge**, so Uvicorn/third-party stdlib logs are *not* rendered by this pipeline.
Use it only if you also route foreign logs another way, or for a service that emits no foreign logs.
For our data plane — which has Uvicorn access/error logs we want unified — §4's stdlib-bridge config
is the default, and you reach for `BytesLoggerFactory` only after profiling shows logging is hot.

---

## 4. The full `setup_logging()` — stdlib bridge, dev + prod (the canonical recipe)

This is the load-bearing function. It does four things: (1) configures structlog to hand off to the
stdlib formatter, (2) builds a single `ProcessorFormatter` that renders **both** structlog and
foreign (Uvicorn) records, (3) attaches it to the root handler, (4) re-points Uvicorn's loggers at
that root so *everything* comes out as one JSON shape. The skeleton follows the
[apitally guide](https://apitally.io/blog/fastapi-logging-guide) and the
[nymous gist](https://gist.github.com/nymous/f138c7f06062b7c43c060bf03759c29e), hardened for this
line.

```python
# app/logging_config.py
import logging
import sys

import structlog
from structlog.types import EventDict, Processor


def _drop_color_message_key(_, __, event_dict: EventDict) -> EventDict:
    """Uvicorn duplicates the message under `color_message` (with ANSI codes). Drop it."""
    event_dict.pop("color_message", None)
    return event_dict


def setup_logging(*, json_logs: bool = True, log_level: str = "INFO") -> None:
    """Configure structlog + stdlib so app logs AND Uvicorn logs emit one JSON shape.

    Call ONCE, before the server starts handling requests (e.g. at module import in
    `logging_config`, invoked from the FastAPI lifespan startup — see
    fastapi-app-structure-and-lifespan.md). Re-running after the first log call is a
    no-op because cache_logger_on_first_use freezes the chain.
    """
    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)

    # Processors shared by BOTH the structlog path and the foreign (stdlib) pre-chain.
    # Keeping them in one list is what makes app logs and Uvicorn logs look identical.
    shared_processors: list[Processor] = [
        structlog.contextvars.merge_contextvars,      # <-- the correlation_id lands here
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.PositionalArgumentsFormatter(),  # handle %-style args from foreign logs
        structlog.stdlib.ExtraAdder(),                # promote logging `extra={...}` to event keys
        _drop_color_message_key,
        timestamper,
        structlog.processors.StackInfoRenderer(),
    ]

    # structlog's OWN chain ends by handing the event dict to ProcessorFormatter.
    structlog.configure(
        processors=[
            *shared_processors,
            # MUST be last on structlog's chain when using the stdlib formatter:
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    # The renderer the stdlib formatter uses at the very end — JSON in prod, pretty in dev.
    if json_logs:
        renderer: Processor = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=True)

    formatter = structlog.stdlib.ProcessorFormatter(
        # foreign_pre_chain runs on logs that did NOT come from structlog (Uvicorn, httpx,
        # SQLAlchemy) so they get the same level/name/timestamp/contextvars treatment.
        foreign_pre_chain=shared_processors,
        processors=[
            # strip structlog's internal bookkeeping keys before rendering
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            # dict_tracebacks belongs here so BOTH app & foreign exceptions render structured
            structlog.processors.dict_tracebacks if json_logs else _passthrough,
            renderer,
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(log_level)

    # Re-point Uvicorn's loggers at the root handler so they flow through our formatter.
    _configure_uvicorn_loggers(log_level)


def _passthrough(_, __, event_dict: EventDict) -> EventDict:
    return event_dict
```

Notes on the parts that are easy to get wrong:

- **`wrap_for_formatter` must be the last processor in `structlog.configure`** when you bridge to
  stdlib. It packages the event dict so `ProcessorFormatter` can pick it up. structlog's standard-lib
  docs: it is "the required renderer at the end of structlog's processor chain when using
  `ProcessorFormatter`" ([Standard Library Logging](https://www.structlog.org/en/stable/standard-library.html)).
- **`foreign_pre_chain` mirrors `shared_processors`** so a `uvicorn.access` record gets the same
  `level`/`logger`/`timestamp`/contextvars keys an app log gets. Without it, Uvicorn lines come out
  with a different shape and break your schema.
- **`remove_processors_meta`** strips the internal `_from_structlog` / `_record` keys structlog adds
  for the bridge; the docs call it "a convenience processor that strips internal metadata keys … keeping
  entries clean."
- **`ExtraAdder`** promotes a stdlib `logger.info("x", extra={"symbol": "AAPL"})` into a top-level
  `symbol` key — useful for third-party libs you don't control.
- **`PositionalArgumentsFormatter`** resolves `%s`-style args foreign loggers use, so Uvicorn's
  `'%(client_addr)s - "%(request_line)s"'` doesn't arrive half-formatted.

### 4.1 Taming Uvicorn's loggers into the same JSON

Uvicorn ships its own `dictConfig` with three loggers and two formatters. From
[`uvicorn/config.py`](https://github.com/encode/uvicorn/blob/master/uvicorn/config.py) (current
master, uvicorn 0.49.0) the default is:

```python
LOGGING_CONFIG: dict[str, Any] = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "()": "uvicorn.logging.DefaultFormatter",
            "fmt": "%(levelprefix)s %(message)s",
            "use_colors": None,
        },
        "access": {
            "()": "uvicorn.logging.AccessFormatter",
            "fmt": '%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s',
        },
    },
    "handlers": {
        "default": {"formatter": "default", "class": "logging.StreamHandler", "stream": "ext://sys.stderr"},
        "access":  {"formatter": "access",  "class": "logging.StreamHandler", "stream": "ext://sys.stdout"},
    },
    "loggers": {
        "uvicorn":        {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error":  {"level": "INFO"},
        "uvicorn.access": {"handlers": ["access"], "level": "INFO", "propagate": False},
    },
}
```

Two facts make this fightable:

1. `uvicorn` and `uvicorn.access` set **`propagate: False`** and attach their *own* handlers — so by
   default they bypass your root handler entirely (that's why you see Uvicorn's coloured prose
   alongside your JSON if you do nothing).
2. `uvicorn.error` has **no handler and `propagate` defaults to `True`**, so it already bubbles to the
   root once you remove its own handler list.

The fix — clear Uvicorn's handlers and turn propagation **on** so they reach your root JSON handler:

```python
def _configure_uvicorn_loggers(log_level: str) -> None:
    # uvicorn.error: let it propagate to root (default formatter prose -> our JSON).
    # uvicorn.access: clear its own handler and propagate so the access line goes JSON too.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
        lg.setLevel(log_level)
```

The apitally guide does exactly this for `uvicorn`/`uvicorn.error`
(`logging.getLogger(name).handlers = []; ....propagate = True`)
([apitally](https://apitally.io/blog/fastapi-logging-guide)). We extend it to `uvicorn.access`.

**Two design choices for the access log — pick one, don't do both:**

- **(A) Keep `uvicorn.access` but re-route it through structlog** (above). Uvicorn still emits one
  access line per request; it now comes out as JSON via `foreign_pre_chain`. Simplest. Downside:
  Uvicorn's access record does **not** carry your `correlation_id` (it's emitted by Uvicorn, outside
  your contextvars binding for that request — actually it *is* inside the ASGI app call, so with the
  pure-ASGI correlation middleware it *can* pick up `merge_contextvars`; verify per setup), and you
  don't control its fields (no `duration_ms`).
- **(B) Disable Uvicorn's access log and emit your own** (recommended for this line). Run with
  `--no-access-log` (or `access_log=False` in `uvicorn.run(...)`) and write a per-request access log
  in your own middleware (§7) with `method/path/status/duration_ms/correlation_id`. You own every
  field and the correlation ID is guaranteed present.

The `--no-access-log` flag and `access_log=False` programmatic option are documented in
[Uvicorn settings](https://uvicorn.dev/settings/); custom `log_config` is the `--log-config` /
`log_config=` option ([Uvicorn logging](https://uvicorn.dev/concepts/logging/)).

### 4.2 Don't let Uvicorn re-apply its own config over yours

If you call `uvicorn.run(...)` programmatically and you've already configured logging in your
lifespan/module, pass **`log_config=None`** so Uvicorn does *not* re-apply `LOGGING_CONFIG` and clobber
your handlers ([apitally guide](https://apitally.io/blog/fastapi-logging-guide): "pass
`log_config=None` to prevent Uvicorn from overwriting your custom setup"):

```python
import uvicorn

uvicorn.run(
    "app.main:app",
    host="0.0.0.0",
    port=8000,
    log_config=None,     # we own logging via setup_logging()
    access_log=False,    # we emit our own access line (choice B above)
)
```

When you run from the CLI (`uvicorn app.main:app --no-access-log --log-config ...`) the same applies:
either supply a `--log-config` file that matches your structlog bridge, or call `setup_logging()` in
the lifespan and use `--no-access-log` so Uvicorn's access logger stays quiet. **Order matters under
`--reload` / Gunicorn workers:** each worker process boots fresh and must run `setup_logging()` in its
own lifespan — logging config is per-process, not shared. Put the call in the lifespan startup (see
`fastapi-app-structure-and-lifespan.md`), not in a module-level side effect that a reloader might skip.

---

## 5. Correlation / request IDs — the `contextvars` mechanism

A **correlation ID** (a.k.a. request ID, trace ID) is a unique token per inbound request that you
stamp on every log line that request produces, and echo back in a response header so a client can
quote it in a bug report. The flow:

1. A request arrives. Middleware reads an incoming `X-Request-ID` header if present (trust it only
   if it validates — see §5.2), else generates a fresh `uuid4().hex`.
2. The ID is stored in a **`contextvars.ContextVar`** — a variable whose value is *local to the
   current execution context* (the async task handling this request), so concurrent requests each see
   their own ID without locks or thread-locals.
3. structlog's `merge_contextvars` processor reads that context store and merges the ID into every
   event dict — so every `log.info(...)` anywhere in the call stack for this request automatically
   carries `correlation_id` with zero plumbing.
4. The ID is written to the response's `X-Request-ID` header on the way out.

### 5.1 Why `contextvars`, and the async-safety guarantee

`contextvars` (PEP 567, stdlib since 3.7) gives you a value bound to the *current execution context*.
In asyncio, each Task runs in its own copied context, so a value set inside one request's task is
**invisible** to other concurrently-running request tasks — which is exactly what you want: request A's
correlation ID never bleeds into request B's logs. structlog's contextvars docs state it "allows having
a global structlog context that is local to the current execution context" and that this "works across
threading, asyncio, and greenlet implementations because execution contexts remain isolated per
concurrency method" ([structlog contextvars](https://www.structlog.org/en/stable/contextvars.html)).

This is *why* you must **not** use thread-locals or a module global for the correlation ID in an async
app: under Uvicorn many requests share one thread (the event loop), so a thread-local would be shared
across all of them and IDs would cross-contaminate. `contextvars` is the only correct primitive here.

The structlog API surface you'll use ([structlog contextvars](https://www.structlog.org/en/stable/contextvars.html)):

| Function | Use |
|---|---|
| `merge_contextvars` | the **processor** in your pipeline that reads the store into each event |
| `bind_contextvars(**kw)` | set keys for the current context (returns reset tokens) |
| `clear_contextvars()` | wipe the store — call at the **start** of each request to avoid leakage |
| `unbind_contextvars(*keys)` | remove specific keys |
| `bound_contextvars(**kw)` | context manager / decorator for a temporary binding |
| `reset_contextvars(**tokens)` | restore prior values using tokens from `bind_contextvars` |

### 5.2 Using `asgi-correlation-id` (the batteries-included path)

`asgi-correlation-id` (4.3.4) provides `CorrelationIdMiddleware` (generates/validates/propagates the
ID and writes the response header) plus a `correlation_id` ContextVar you read anywhere. From
[snok/asgi-correlation-id](https://github.com/snok/asgi-correlation-id):

```python
from uuid import uuid4
from asgi_correlation_id import CorrelationIdMiddleware

app.add_middleware(
    CorrelationIdMiddleware,
    header_name="X-Request-ID",       # header read on the way in, written on the way out
    update_request_header=True,
    generator=lambda: uuid4().hex,    # how to mint a fresh ID
    validator=None,                   # validate incoming IDs (default: is_valid_uuid4); None = trust any
    transformer=lambda a: a,          # optionally normalise (e.g. lowercase)
)
```

Documented parameter defaults ([README](https://github.com/snok/asgi-correlation-id)):
`header_name='X-Request-ID'`, `update_request_header=True`, `generator=lambda: uuid4().hex`,
`validator=is_valid_uuid4`, `transformer=lambda a: a`.

> **Security note on `validator`.** The default `is_valid_uuid4` rejects an incoming `X-Request-ID`
> that isn't a uuid4 and replaces it with a fresh one. **Keep validation on** unless an upstream proxy
> you trust sets the header. Trusting an arbitrary client-supplied ID is a **log-injection** vector: a
> malicious client could send a newline or a forged ID to confuse your aggregator or impersonate
> another request's trace. If you trust the edge proxy's ID format, set a `validator` that matches it;
> never `validator=None` on an internet-facing service.

`CorrelationIdMiddleware` is implemented as a **pure ASGI middleware** (not `BaseHTTPMiddleware`),
which is why it works correctly with downstream contextvars — see §6, which is the reason this matters.

### 5.3 Binding the ID into structlog so every line carries it

`asgi-correlation-id` stores the ID in its own `correlation_id` ContextVar; structlog reads its *own*
`contextvars` store. Two ways to bridge them:

**(a) A tiny processor** that copies the ID across (from the
[snok README structlog example](https://github.com/snok/asgi-correlation-id)):

```python
import logging
from typing import Any
import structlog
from asgi_correlation_id import correlation_id

def add_correlation(logger: logging.Logger, method_name: str,
                    event_dict: dict[str, Any]) -> dict[str, Any]:
    if request_id := correlation_id.get():
        event_dict["correlation_id"] = request_id
    return event_dict

# put `add_correlation` early in shared_processors, before the renderer
```

**(b) Bind it into structlog's contextvars in middleware** so `merge_contextvars` picks it up (the
apitally pattern — but note the `BaseHTTPMiddleware` caveat in §6):

```python
from asgi_correlation_id import correlation_id
from structlog.contextvars import bind_contextvars, clear_contextvars

# inside a request middleware, at the start of each request:
clear_contextvars()
bind_contextvars(correlation_id=correlation_id.get())
```

This line uses **(b) via a pure-ASGI middleware (§6.3)** so the same binding also carries
`method`/`path` and is guaranteed visible to the endpoint. Approach (a) is the safe fallback if you
can't control middleware ordering — a processor reading the ContextVar directly side-steps the whole
propagation issue.

---

## 6. THE pitfall: `@app.middleware("http")` silently drops contextvars

This is the section that most "FastAPI structured logging" tutorials get wrong, and it produces the
exact symptom "my correlation IDs are present in some logs but missing in others." Read it twice.

### 6.1 What breaks

FastAPI's `@app.middleware("http")` decorator (and `app.add_middleware(BaseHTTPMiddleware, ...)`) is
**`BaseHTTPMiddleware`**. Starlette's own docs state, verbatim:

> "Using `BaseHTTPMiddleware` will prevent changes to `contextvars.ContextVar`s from propagating
> upwards. That is, if you set a value for a `ContextVar` in your endpoint and try to read it from a
> middleware you will find that the value is not the same value you set in your endpoint … this also
> means that if a `BaseHTTPMiddleware` is positioned earlier in the middleware stack, it will disrupt
> `contextvars` propagation for any subsequent Pure ASGI Middleware that relies on them."
> ([Starlette Middleware](https://www.starlette.io/middleware/))

### 6.2 Why it breaks (the mechanism)

`BaseHTTPMiddleware` runs the rest of the request (`call_next`) inside a **separate anyio task group
with a copied context**. A `ContextVar` set *inside* that inner task — e.g. in an endpoint or a
dependency — lives in the *copy*; when control returns to the middleware after
`await call_next(request)`, you're back in the *outer* context where that set never happened. The
FastAPI maintainers confirm this on
[FastAPI discussion #8632](https://github.com/fastapi/fastapi/discussions/8632): "`BaseHTTPMiddleware`
… runs request handling in a separate anyio task group with a copied context … When control returns to
the middleware after `await call_next(request)`, execution resumes in the middleware's original context
where those modifications are invisible." structlog's own contextvars warning is the same root cause:
context variables are "isolated from each other" across concurrency boundaries, so values set in one
context "don't appear in logs from an async context and vice versa"
([structlog contextvars](https://www.structlog.org/en/stable/contextvars.html)).

The practical consequences:

- If you bind the correlation ID in a `BaseHTTPMiddleware` *before* the endpoint runs, the endpoint
  *can* see it (the copy inherits the parent's already-set values at task-creation time). So the
  apitally pattern in §5.3(b) usually *works for the read-down direction* — the ID set in the
  outer middleware is visible inside.
- But if a dependency or endpoint binds *additional* contextvars (e.g. `user_id`) expecting a later
  `BaseHTTPMiddleware` (or your access-log line emitted *after* `call_next`) to pick them up, those
  bindings are **lost** — they happened in the inner copied context.
- And a `BaseHTTPMiddleware` earlier in the stack **poisons** propagation for any pure-ASGI middleware
  after it.

### 6.3 The fix: pure ASGI middleware

A **pure ASGI middleware** runs in the **same** execution context as the endpoint, so every contextvar
bound anywhere in the request — middleware, dependency, or endpoint — is visible everywhere, including
the `finally` block where you emit the access log. Starlette's pure-ASGI contract
([Starlette Middleware](https://www.starlette.io/middleware/)):

```python
class ASGIMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        await self.app(scope, receive, send)
```

This line's logging + access middleware, written as pure ASGI so contextvars propagate correctly:

```python
# app/middleware/logging.py
import time
from typing import Callable

import structlog
from asgi_correlation_id import correlation_id
from structlog.contextvars import bind_contextvars, clear_contextvars

access_logger = structlog.get_logger("app.access")


class StructlogAccessMiddleware:
    """Pure ASGI middleware: binds request context into structlog's contextvars and emits
    one access log line per request with method/path/status/duration_ms/correlation_id.

    Place this AFTER CorrelationIdMiddleware in the stack (so correlation_id is already set),
    and use NO BaseHTTPMiddleware anywhere upstream that would break contextvar propagation.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            # pass through websocket / lifespan unchanged
            await self.app(scope, receive, send)
            return

        # Fresh per-request context. clear_contextvars() prevents leakage across requests
        # that happen to reuse the same task context.
        clear_contextvars()
        bind_contextvars(
            correlation_id=correlation_id.get(),
            method=scope["method"],
            path=scope["path"],
        )

        status_code = 500  # default if the app never sends a response.start (crash)
        start = time.perf_counter_ns()

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = (time.perf_counter_ns() - start) / 1_000_000
            # This line runs in the SAME context as the endpoint -> any extra contextvars
            # the endpoint bound (e.g. user_id) ARE present here. That is the whole point.
            access_logger.info(
                "http_access",
                status=status_code,
                duration_ms=round(duration_ms, 2),
            )
            clear_contextvars()
```

Wire it up — **order matters**, outermost first:

```python
# app/main.py
from uuid import uuid4
from asgi_correlation_id import CorrelationIdMiddleware
from app.middleware.logging import StructlogAccessMiddleware

# add_middleware adds OUTERMOST-last in Starlette: the LAST added wraps first.
app.add_middleware(StructlogAccessMiddleware)            # inner: needs correlation_id set
app.add_middleware(CorrelationIdMiddleware, generator=lambda: uuid4().hex)  # outer: sets it first
```

> Starlette applies middleware in reverse order of `add_middleware` (last added = outermost). To get
> `CorrelationIdMiddleware` to run *before* `StructlogAccessMiddleware`, add it **last**. Both are pure
> ASGI, so contextvars set by either are visible to the endpoint and to the access line.

### 6.4 The workaround when you're stuck with `BaseHTTPMiddleware`

If a dependency genuinely needs `BaseHTTPMiddleware` (some auth integrations do), store the data on
`request.state` in the dependency and read it back in the middleware (from
[FastAPI discussion #8632](https://github.com/fastapi/fastapi/discussions/8632)):

```python
# in a dependency / endpoint:
request.state.user_id = user_id

# in the middleware (after call_next), bind from request.state:
if hasattr(request.state, "user_id"):
    bind_contextvars(user_id=request.state.user_id)
```

`request.state` survives the task-copy boundary because it's an attribute on the request object, not a
ContextVar. This is a patch, not a cure — prefer pure ASGI.

---

## 7. The per-request access log (the most-read line you'll emit)

One line per request is the backbone of operational observability: it's how you compute p50/p95/p99
latency, error rate, and traffic by route, and it's the first thing you filter when something's slow.
The fields and where each comes from:

| Field | Source in middleware | Notes |
|---|---|---|
| `event: "http_access"` | constant | the stable event name to `GROUP BY` |
| `method` | `scope["method"]` | GET/POST/… |
| `path` | `scope["path"]` | the **route path**, not the templated route — see below |
| `status` | captured from `http.response.start` message | default 500 if app crashed before responding |
| `duration_ms` | `perf_counter_ns()` delta | use a **monotonic** clock, never `time.time()` |
| `correlation_id` | via `merge_contextvars` | stitches this line to the request's app logs |
| `client` *(optional)* | `scope["client"]` `(host, port)` | for abuse/geo; treat IP as PII (§8) |

Key correctness points:

- **Use a monotonic clock.** `time.perf_counter_ns()` (or `perf_counter()`) is monotonic and immune to
  wall-clock adjustments/NTP steps; `time.time()` can go backwards and produce negative durations.
  The nymous gist times with `time.perf_counter_ns()`
  ([gist](https://gist.github.com/nymous/f138c7f06062b7c43c060bf03759c29e)).
- **Capture status from the ASGI `http.response.start` message**, as the `send_wrapper` above does —
  this is the only place the real status code is available in pure ASGI, and it correctly captures
  `500`/`503` from error handlers, unlike reading `response.status_code` which a crash can skip.
- **High-cardinality path warning.** Logging the raw `scope["path"]` means
  `/v1/quotes/AAPL`, `/v1/quotes/MSFT`, … each become distinct values. That's fine for *logs* (you
  filter on them) but **fatal for metrics labels** (Prometheus would explode with one time series per
  symbol). For metrics, label by the **route template** (`/v1/quotes/{symbol}`), read from
  `request.scope["route"].path` / `request.url_for`. Keep the raw path in logs, the template in
  metrics. (See §10.)
- **Don't double-log.** If you keep Uvicorn's access log *and* emit this one, you get two lines per
  request with conflicting fields. Pick choice B from §4.1: disable Uvicorn's access log, emit only
  this one.

Example output (prod JSON, one line):

```json
{"event":"http_access","method":"GET","path":"/v1/quotes/AAPL","status":200,"duration_ms":42.13,"correlation_id":"9f2c7e1a8b4d4f0e9c2a1b3d4e5f6a7b","level":"info","logger":"app.access","timestamp":"2026-06-24T16:09:00.123456Z"}
```

---

## 8. What NOT to log (the discipline that keeps you out of court)

A log line is durable, replicated to the aggregator, often retained for 30–90 days, and readable by
anyone with dashboard access. For a financial-data platform, a leaked secret or PII in a log is a
**security incident and a compliance breach** (GDPR/CCPA for PII; provider-ToS and internal policy for
keys). The rule: **logs record events and identifiers, never secrets or raw sensitive payloads.**

| Never log | Why | Instead log |
|---|---|---|
| API keys, tokens, `Authorization` headers, cookies, session IDs | direct credential theft | a boolean `authenticated=true` or a key *fingerprint* (last-4) |
| Passwords, even hashed | offline cracking, accidental plaintext | nothing — never touch a log line |
| Full request/response bodies | PII, payloads, secrets buried inside | a content-length, a field allowlist, a hash |
| Raw PII (full name, email, SSN, full IP, account number) | GDPR/CCPA scope | a stable pseudonymous `user_id`; truncated/hashed IP |
| Connection strings / DSNs (contain passwords) | DB credential leak | the host/db name only |
| Exception **locals** that hold any of the above | `dict_tracebacks` can serialise frame locals | scrub locals; keep secrets out of scope near failures |

### 8.1 A redaction processor (defence in depth)

Don't rely only on call-site discipline — add a structlog processor that censors known-sensitive keys
before the renderer, so even an accidental `log.info("x", password=...)` is neutralised:

```python
_SENSITIVE_KEYS = {
    "password", "passwd", "secret", "token", "api_key", "apikey",
    "authorization", "cookie", "set-cookie", "access_token", "refresh_token",
    "client_secret", "private_key", "ssn", "card_number",
}
_REDACTED = "***REDACTED***"

def redact_sensitive(logger, method_name, event_dict):
    for key in list(event_dict.keys()):
        if key.lower() in _SENSITIVE_KEYS:
            event_dict[key] = _REDACTED
    return event_dict

# place `redact_sensitive` in shared_processors, BEFORE the renderer (and before
# dict_tracebacks if you also want it to scrub serialized exception fields).
```

This is a backstop, not a license to be sloppy — it only catches exact key names. The primary control
is **never put a secret in a log call**. For headers specifically, redact the whole `Authorization`
and `Cookie` headers if you ever log headers at all (prefer not to).

> **`dict_tracebacks` + locals caveat (repeat, because it bites):** structured tracebacks can include
> frame locals. If `setup_logging` enables locals capture and a function near a failure holds
> `api_key = "..."`, that key serialises into the log. Either don't enable locals capture in prod, or
> ensure secrets are fetched lazily and not held in locals at the failure site. Audit this for any
> handler that touches credentials.

---

## 9. Hooking the error envelope to the correlation ID

Your service returns a uniform error envelope (see the app-structure ref's error contract). The
correlation ID must appear in **two** places on an error: the response body/header the *client* sees,
and the log line the *operator* sees — so a user's screenshot of a `500` and its `X-Request-ID` is
enough to jump straight to the exact log lines. The wiring:

1. **`CorrelationIdMiddleware` already writes `X-Request-ID` to every response** (success or error),
   because it sets it on `http.response.start` regardless of status. Nothing extra needed for the
   header.
2. **Put the ID in the error body** so it's copy-pasteable even from a JSON client:

```python
from fastapi import Request
from fastapi.responses import JSONResponse
from asgi_correlation_id import correlation_id
import structlog

log = structlog.get_logger("app.errors")

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    cid = correlation_id.get()
    # the exception is logged WITH the correlation_id via merge_contextvars (same request context)
    log.exception("unhandled_exception", path=request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "internal_error",
                "message": "An unexpected error occurred.",  # never leak exc detail to the client
                "correlation_id": cid,                       # the bridge: client <-> logs
            }
        },
        headers={"X-Request-ID": cid} if cid else None,
    )
```

3. **Log the exception, not the message-string-with-PII.** `log.exception(...)` (or
   `log.error(..., exc_info=True)`) routes through `dict_tracebacks` for a structured stack trace.
   Keep the *client* message generic (`"An unexpected error occurred."`) — never echo `str(exc)` to the
   client, which can leak SQL, file paths, or upstream provider errors. The apitally guide's
   exception-logging pattern is the same shape: catch, `logger.exception(...)`, re-raise/handle
   ([apitally](https://apitally.io/blog/fastapi-logging-guide)).

Now: `500` happens → operator filters logs on the `correlation_id` from the user's screenshot → the
`http_access` line + the `unhandled_exception` line + every app log for that request appear together,
in order, with the full structured traceback. That round-trip is the entire payoff of this document.

---

## 10. Metrics & health endpoints (where logging meets the rest of observability)

Logging is one of the three observability pillars (logs · metrics · traces). A few connections so this
doc doesn't leave a gap:

- **Health/readiness endpoints.** Expose `GET /healthz` (liveness: "the process is up") and
  `GET /readyz` (readiness: "deps — DB pool, Redis, upstream — are reachable"). These are hit
  constantly by the orchestrator (Kubernetes, the load balancer) and will **flood your access log** if
  you log them at INFO. Either exclude them in the access middleware (`if scope["path"] in
  {"/healthz", "/readyz"}: skip the log line`) or log them at DEBUG. Keep them dependency-light:
  readiness should do a cheap `SELECT 1` / `PING`, not a full query.
- **Metrics.** For Prometheus, use `prometheus-fastapi-instrumentator` or
  `starlette-prometheus` to expose `GET /metrics` with request count/latency histograms. **Label by
  the route template, not the raw path** (§7's high-cardinality warning) — `/v1/quotes/{symbol}`, not
  `/v1/quotes/AAPL` — or your time-series database melts. The access-log `duration_ms` and the metrics
  histogram measure the same thing from two angles: the log gives you the per-request detail and the
  correlation ID; the histogram gives you cheap aggregate p99 without scanning logs.
- **Traces.** If you adopt OpenTelemetry later, its `trace_id` plays the same role as the correlation
  ID across *services*. Bridge them: set the correlation ID *from* the OTel trace context when present,
  so a single ID follows the request across service hops. Until then, the per-service correlation ID is
  the pragmatic 80%.
- **Don't reinvent the log shipper.** The app writes JSON to stdout; the platform agent (Promtail/Alloy
  → Loki, Datadog agent, Filebeat → ELK, the cloud's native log router) ships it. Your only contract
  with them is "one valid JSON object per line on stdout" — which §1–§4 deliver.

---

## 11. End-to-end assembly (the minimal correct wiring)

Putting §4–§9 together, the four files and the one call order:

```python
# app/main.py  (abbreviated; lifespan + routers omitted — see fastapi-app-structure-and-lifespan.md)
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI
from asgi_correlation_id import CorrelationIdMiddleware

from app.logging_config import setup_logging
from app.middleware.logging import StructlogAccessMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(json_logs=True, log_level="INFO")   # ONCE, per process, before traffic
    # ... open DB pool, httpx client, etc.
    yield
    # ... close them


app = FastAPI(lifespan=lifespan)

# Pure-ASGI both; CorrelationIdMiddleware added LAST so it's OUTERMOST and runs first.
app.add_middleware(StructlogAccessMiddleware)
app.add_middleware(CorrelationIdMiddleware, generator=lambda: uuid4().hex)

# ... app.include_router(...) ; app.add_exception_handler(Exception, unhandled_exception_handler)
```

```python
# anywhere in the app:
import structlog
log = structlog.get_logger("app.pricing")

async def get_quote(symbol: str):
    log.info("quote_lookup_start", symbol=symbol)        # carries correlation_id automatically
    # ...
    log.info("quote_lookup_done", symbol=symbol, source="cache", ms=3)
```

Run it (choice B — own access log):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log --log-config=/dev/null
# or programmatically: uvicorn.run("app.main:app", log_config=None, access_log=False)
```

The result: every line — your app logs, your access log, Uvicorn's startup/error logs, and any
exception's structured traceback — is one JSON object on stdout, every request-scoped line carries the
same `correlation_id`, and the platform agent ships it to Loki/Datadog/ELK with zero parsing config.

---

## 12. R-SCALE: the tier this design survives, and what breaks next

Per `~/.claude/rules/product-scale-architecture.md` §C (read spike) and this repo's
`product-at-scale.md`, state the tier honestly:

| Tier | Load | Does this design hold? |
|---|---|---|
| **1× (demo)** | 1 user, dev console renderer | Yes — `ConsoleRenderer`, pretty tracebacks. |
| **100× (traction)** | thousands of req/s, JSON to stdout → Loki/Datadog | Yes — JSON, `cache_logger_on_first_use`, monotonic timing, redaction. The pure-ASGI middleware adds ~one dict-bind + one log line per request (microseconds). |
| **10,000× (spike day)** | lakhs of req/s, log volume becomes the cost | **Partially — and here's what breaks.** See below. |

**What breaks at 10,000× and the named mitigations:**

1. **Log volume = money and I/O.** At a market-open spike, INFO-per-request access logs can dominate
   both your aggregator bill and stdout throughput. Mitigations: (a) **sample** non-error access logs
   (log 100% of `status>=400`, 1-in-N of `2xx`) via a sampling processor; (b) drop health-check noise
   (§10); (c) move to **`BytesLoggerFactory` + orjson** (§3.4) to cut serialisation CPU. Sampling is
   the big lever — a sampling processor that keeps all errors and a fraction of successes is the
   standard answer; structlog's pipeline makes it a 10-line processor.
2. **`CallsiteParameterAdder` stack walks** become a measurable CPU tax at this volume. Disable it for
   INFO; keep it for ERROR only.
3. **`dict_tracebacks` with locals** on a high error rate (e.g. an upstream outage causing mass 503s)
   can produce huge log lines. Cap locals, or disable locals capture in prod.
4. **Synchronous stdout writes** can block the event loop if stdout is a slow pipe. Mitigation: ensure
   stdout is unbuffered and the platform tails it fast; for extreme volume, a `QueueHandler` +
   `QueueListener` moves the formatting/IO off the event-loop thread. This is the only change that
   touches the logging *transport* rather than its *content*.

The mechanism (structlog pipeline + contextvars + pure-ASGI middleware + JSON-to-stdout) is correct at
all three tiers; the *configuration knobs* (sampling, callsite, locals, queue handler) are what you
turn as volume climbs. State which knobs are set when you ship.

---

## 13. Anti-patterns (mistake → fix), quick reference

| Mistake | Why it bites | Fix |
|---|---|---|
| `@app.middleware("http")` to bind correlation contextvars read after `call_next` | `BaseHTTPMiddleware` copies context; bindings made in the endpoint are invisible (§6) | pure ASGI middleware (`__call__(scope, receive, send)`) |
| Thread-local / module global for the request ID | one event-loop thread serves many concurrent requests → IDs cross-contaminate | `contextvars.ContextVar` (async-isolated) |
| `time.time()` for duration | wall-clock can step backwards (NTP) → negative latencies | `time.perf_counter_ns()` (monotonic) |
| Keeping Uvicorn's access log *and* a custom one | two lines/request, conflicting fields | `--no-access-log` + emit one custom JSON line |
| Leaving Uvicorn loggers with their own handlers | coloured prose mixed with your JSON; aggregator can't parse | clear handlers, `propagate=True`, route to root (§4.1) |
| `log.info(f"fetched {symbol} in {ms}ms")` | values baked into an opaque string → un-queryable | `log.info("upstream_fetch", symbol=symbol, ms=ms)` |
| `format_exc_info` in prod JSON | multi-line string traceback, hard to query/keep on one line | `dict_tracebacks` → structured frames |
| Logging `Authorization` headers / request bodies | credential & PII leak in durable logs | redaction processor + allowlist; log fingerprints not secrets (§8) |
| `validator=None` on `CorrelationIdMiddleware` for an internet-facing service | log-injection / trace spoofing via client-supplied header | keep `is_valid_uuid4` or a strict validator |
| Echoing `str(exc)` to the client | leaks SQL/paths/provider errors | generic message + `correlation_id` in the envelope (§9) |
| `setup_logging()` at module import only, under `--reload`/Gunicorn | per-worker config may be skipped/duplicated | call it in the lifespan startup, once per process |
| Renderer not last in the pipeline | output processor must be terminal or later processors get a string | renderer (`JSONRenderer`/`ConsoleRenderer`) is always last |

---

## 14. Sources (read this session)

**Primary (read directly):**

- [apitally.io — A complete guide to logging in FastAPI](https://apitally.io/blog/fastapi-logging-guide)
  — the `setup_logging()` stdlib-bridge config, the request middleware with `clear_contextvars()` +
  `bind_contextvars(correlation_id=...)`, taming `uvicorn`/`uvicorn.error`, `log_config=None`, the
  exception-logging middleware.
- [nymous gist — Logging setup for FastAPI, Uvicorn and Structlog](https://gist.github.com/nymous/f138c7f06062b7c43c060bf03759c29e)
  — shared-processor list, the `api.access` access middleware with `time.perf_counter_ns()`,
  `uvicorn.access` `propagate=False` reset, `drop_color_message_key`, Datadog `tracer_injection`.
- [github.com/snok/asgi-correlation-id](https://github.com/snok/asgi-correlation-id) (v4.3.4) —
  `CorrelationIdMiddleware` parameter table, `CorrelationIdFilter`, the `add_correlation` structlog
  processor example, the Celery `before_task_publish`/`task_prerun`/`task_postrun` propagation.
- [structlog — Standard Library Logging](https://www.structlog.org/en/stable/standard-library.html)
  (26.1.0) — `ProcessorFormatter`, `wrap_for_formatter`, `foreign_pre_chain`, `remove_processors_meta`.
- [structlog — contextvars](https://www.structlog.org/en/stable/contextvars.html) — `merge_contextvars`,
  `bind/clear/unbind/bound/reset_contextvars`, the async-isolation guarantee and the hybrid-app warning.
- [structlog — Logging Best Practices](https://www.structlog.org/en/stable/logging-best-practices.html)
  — log to unbuffered stdout, JSON in prod, `dict_tracebacks` + `JSONRenderer`.
- [structlog — Processors](https://www.structlog.org/en/stable/processors.html) /
  [API Reference](https://www.structlog.org/en/stable/api.html) (26.1.0) — processor names/signatures.
- [Starlette — Middleware](https://www.starlette.io/middleware/) — pure ASGI contract,
  `BaseHTTPMiddleware` contextvars limitation (verbatim).
- [FastAPI discussion #8632](https://github.com/fastapi/fastapi/discussions/8632) — the anyio
  copied-context mechanism and the `request.state` workaround.
- [Uvicorn config.py — `LOGGING_CONFIG`](https://github.com/encode/uvicorn/blob/master/uvicorn/config.py)
  + [Uvicorn logging](https://uvicorn.dev/concepts/logging/) +
  [Uvicorn settings](https://uvicorn.dev/settings/) (0.49.0) — default loggers/formatters,
  `--no-access-log`, `--log-config` / `log_config`.

**Secondary (cross-checked):**

- [BetterStack — A Comprehensive Guide to Python Logging with Structlog](https://betterstack.com/community/guides/logging/structlog/)
  — `EventRenamer`, `CallsiteParameterAdder`, processor-order rule, redaction direction.
- [structlog PR #407](https://github.com/hynek/structlog/pull/407) — the structured-traceback
  (`dict_tracebacks`) parser.
- [PyPI: structlog](https://www.structlog.org/en/stable/api.html) (26.1.0),
  [asgi-correlation-id](https://pypi.org/project/asgi-correlation-id/) (4.3.4),
  [uvicorn](https://pypi.org/project/uvicorn/) (0.49.0) — version pins.

> **Verification note (cto-rules honesty):** version numbers were read from PyPI/docs this session and
> are accurate as of 2026-06-24; **re-pin before relying** — structlog/asgi-correlation-id/uvicorn
> release frequently. The `BaseHTTPMiddleware`-contextvars limitation is quoted verbatim from
> Starlette's own docs and confirmed by FastAPI maintainers; it is the single highest-leverage,
> most-misunderstood fact in this document.
