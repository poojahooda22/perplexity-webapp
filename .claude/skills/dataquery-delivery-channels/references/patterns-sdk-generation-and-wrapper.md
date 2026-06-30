# Pattern: SDK Generation & the Deliberate Hand-Written Wrapper — From One OpenAPI 3.1 Contract to a Published, Idiomatic Python Client

> **Layer:** `patterns-*` (concrete build recipe — the runnable mechanism, not the survey).
> **Product line:** JPM-Markets re-engineering **data-analytics** product line — the
> DataQuery/Fusion-class market-data delivery platform we are building to beat the incumbents.
> **NOT Lumina.** Lumina (this repo, Bun + Express + Prisma + Supabase + Upstash) is only the filesystem
> home for this research; do not wire any of this into Lumina's app code. The client this doc builds
> targets the **Python/FastAPI data-analytics service** whose OpenAPI 3.1 contract is produced by the
> sibling `python-fastapi-data-service` skill.
>
> **Stack assumption (the new line).** The service is Python 3.12 + FastAPI emitting OpenAPI 3.1 (the
> single contract source — see `theory-query-api-contract.md`). The consumer SDK is a Python package
> published to a registry (public PyPI or a private index). The recipes below are runnable Python; the
> generator-tool comparison is language-agnostic but every code sample is Python because that is the
> consumer the quant/data-science audience actually uses.
>
> **What this doc answers.** Once the REST query API exists (`patterns-catalog-discovery-endpoint.md`,
> `patterns-series-retrieval-endpoint.md`) and is documented by an OpenAPI 3.1 spec, the *last mile* to a
> consumable data product is a client library nobody has to hand-roll. This doc is the decision and the
> recipe for that library: **generate it, buy a generator, or hand-write it** — and the answer is a
> hybrid (**generate the typed transport from the 3.1 spec, then wrap it in a thin ergonomic layer**),
> with the hand-written exception (`DQInterface`/`DataQuery` style) justified as a *documented decision,
> not drift*. It covers the generator matrix with current (June 2026) facts, the exact shape every good
> client must have (bearer auto-refresh, 429 backoff, cursor auto-iteration, typed errors, DataFrame
> convenience), and the PyPI publish + semver discipline tied to the API's `/v1`.

---

## 0. The on-ramp (plain language, then the rest is dense)

You have built a data API. A consumer — a quant desk, a data scientist, an internal panel team — does
not want to write `httpx.get(url, headers={"Authorization": ...})`, parse JSON, re-implement pagination,
guess the date format, and handle 429s. They want:

```python
from jpmd import Client          # "jpmd" = our data-analytics client, placeholder name
client = Client(client_id=..., client_secret=...)
df = client.series("DB(MARKETS,US_CPI,value)", start="2015-01-01").to_dataframe()
```

…and for that one call to silently: fetch an OAuth token (and refresh it before it expires), retry the
429 it hit, follow the three pages of cursors the server returned, validate the payload against the
schema, and hand back a tidy pandas DataFrame. **The client library is the product's last 10 feet.** A
brilliant API with a hostile client is a hostile API.

There are exactly three ways to produce that library, and the whole first half of this doc is choosing
between them:

1. **Generate it free** with the open-source **OpenAPI Generator** — 50+ language targets, costs
   nothing, but the Python it emits "reads like something a Java developer would write," has no built-in
   retries or pagination helpers, and the project carries 4,500+ open issues.
2. **Buy/rent a generator** — **Fern** (Apache-2 CLI core, idiomatic, retries+pagination+streaming by
   default, OAuth paid), or the fully-closed **Speakeasy** / **Stainless** (idiomatic, Zod/Pydantic
   runtime validation, but paid and — for Stainless — cloud-only generation). These produce SDKs whose
   quality "gives the impression of being hand-written with precision and care."
3. **Hand-write a thin ergonomic wrapper** — the **deliberate exception**. JP Morgan's own
   `jpmorganchase/dataquery-sdk` and the third-party `macrosynergy/dataquery-api` both did exactly this:
   a small, opinionated Python client over the raw API with `to_dataframe`, token caching, rate-limit
   handling, and async+sync parity. You do this **on purpose, for DX**, and you document it as a decision
   so a future reader does not mistake it for the team failing to adopt a generator.

The recommendation this doc lands on (§7): **generate the typed transport + models from the 3.1 spec
for breadth and zero-drift, then hand-write a thin ergonomic facade on top** for the two or three calls
that matter (`series`, `catalog`, `download`) — getting the generator's correctness *and* the
hand-written client's ergonomics, each in the layer it belongs.

The rest is the matrix with current facts, the exact client shape, the wrapper recipe (runnable), and the
PyPI publish.

---

## 1. The generation matrix — four routes, current facts (June 2026)

The four routes differ on five axes that actually decide the call: **cost/license**, **output
idiomaticity**, **runtime type safety**, **built-in resilience (retries / pagination / OAuth / SSE)**,
and **whether OpenAPI is the source of truth or a proprietary DSL sits in between**. Decide on those
axes, not on a feature checkbox.

| Route | Cost / license | Idiomatic Python? | Runtime validation | Retries / pagination / OAuth / SSE built-in | OpenAPI = source of truth? | Generation needs cloud? |
|---|---|---|---|---|---|---|
| **OpenAPI Generator** (OSS) | Free, Apache-2.0; 50+ targets | **No** — "a Java developer would write" | Basic Pydantic v2 only | **None** (no retry, no pagination helper) | Yes (OpenAPI-native) | No (local JAR/CLI) |
| **Fern** | Apache-2.0 CLI core; cloud/enterprise paid; **OAuth on paid plans** | **Yes** — idiomatic per-language | Custom validation library | **Yes** by default (retries+backoff, pagination iterators, streaming, idempotency, multipart) | ⚠️ DSL-based; OpenAPI is an *import* | Generation local; some features cloud |
| **Speakeasy** | Paid (~$600/mo per language; free tier = 1 language / 250 endpoints) | **Yes** | **Pydantic v2 + TypedDict + advanced enums** | **Yes** (all four) | Yes — "single source of truth" | No — runs on-prem / air-gapped / any CI |
| **Stainless** | Paid (~$250/mo per SDK; limited free tier) | **Yes** (official OpenAI/Anthropic/Cloudflare SDKs) | **Casts without runtime validation** | Pagination yes; OAuth **manual** | ⚠️ Custom config layer over OpenAPI | **Yes — requires cloud connectivity** |
| **Hand-written wrapper** | Your eng time | **Yes (you control it)** | Whatever you write (typically Pydantic v2) | Whatever you write | N/A | No |

Sourcing for every cell in this table is in §1.1–§1.5. Each claim is cited inline; this is a licensing-
and-cost decision, so nothing here is from memory.

### 1.1 OpenAPI Generator (the free OSS baseline)

The breadth leader and the zero-cost floor. **"Over 50 generators covering languages, server stubs, and
documentation formats"** with "no other tool coming close in target count," and it is **"free and open
source with no licensing costs"** with "the full source available to fork and customize"
([Speakeasy — Choosing an SDK generator](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)).
Fern's own write-up agrees on the breadth and the trade: it is the **"free, open-source option with more
than 50 language targets,"** has "the largest language breadth in the market but inconsistent feature
coverage across generators, no runtime type safety, and a repository with more than 4,500 open issues"
([Speakeasy — Python OSS comparison, paraphrasing the same article corpus](https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python); the 4,500+ figure: [Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)).

The Python-specific reality is the disqualifier for a *premium* DX product: the default `python`
generator uses **`urllib3`** and async is **"❌ Not supported"** on that default library; it ships
**"Basic Pydantic only,"** **"No retry support,"** and **"Not supported"** pagination
([Speakeasy — OSS comparison for Python](https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python)).
The blunt characterization that decides it: **OpenAPI Generator "produces something a Java developer
would write,"** whereas an idiomatic generator "produces something a Python developer reads and
recognises immediately"
([Speakeasy — Python OSS comparison](https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python)).
Nordic APIs concurs: OpenAPI Generator has "complex source code" and (with Kiota and AutoRest) the
reviewer "was unable to find a way to generate documentation for the SDK, which was a major drawback"
([Nordic APIs — Review of 8 SDK Generators 2025](https://nordicapis.com/review-of-8-sdk-generators-for-apis-in-2025/)).

The Python generator's real config surface (so you can drive it from a Makefile) — from the official docs
([openapi-generator.tech — python generator](https://openapi-generator.tech/docs/generators/python/)):

| Option | Default | What it does |
|---|---|---|
| `library` | `urllib3` | HTTP template: `urllib3` (sync), `asyncio` (async), `tornado` (deprecated). **Only `asyncio` emits async.** |
| `packageName` | `openapi_client` | Python package name (snake_case). |
| `packageVersion` | `1.0.0` | Generated package version — **tie this to the API version (§6).** |
| `generateSourceCodeOnly` | `false` | Emit only the library source (no test/docs scaffolding). |
| `buildSystem` | `setuptools` | Build backend written into `pyproject.toml`. |
| `disallowAdditionalPropertiesIfNotPresent` | `true` (legacy) | Set **`false`** for OAS/JSON-Schema-spec-compliant `additionalProperties` handling. |

Models inherit from Pydantic v2 `BaseModel` and "Pydantic validates data at runtime and provides clear
error messages when data is invalid"
([Speakeasy — pydantic v2 confirmation](https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python)).
So you *do* get runtime model validation from the OSS generator — what you do **not** get is retries,
pagination iteration, OAuth flows, or idiomatic ergonomics.

**Modern OSS alternative worth naming:** `openapi-python-client` (the `openapi-generators` org) "focuses
on creating the best developer experience for Python developers by using all the latest Python features
like type annotations and dataclasses," is "modern, async-aware, and produces a clean typed client," and
"produces something a Python developer reads and recognises immediately"
([Speakeasy — Python OSS comparison](https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python);
repo: [github.com/openapi-generators/openapi-python-client](https://github.com/openapi-generators/openapi-python-client)).
Its weakness vs the big generators is the same: **no built-in retries/pagination/OAuth helpers** — it
generates a clean *transport+models* layer, which is exactly what we want under a hand-written facade
(§7). Note one OpenAPI-3.1 caveat: OpenAPI Generator is "slower to adapt to OpenAPI 3.1 specifics"
([sourced.sh / Speakeasy corpus](https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python)),
so if you emit a strict 3.1 spec, test the generator against it before committing.

### 1.2 Fern (Apache-2 core, idiomatic, retries+pagination by default — OAuth paid)

Fern's CLI is **"licensed under Apache 2.0"** and **"available on GitHub"**, generating SDKs in
**"TypeScript, Python, Go, Java, C#/.NET, PHP, Ruby, Swift, and Rust"**
([Fern — Open Source vs Closed Source SDK Generators](https://buildwithfern.com/post/open-source-vs-closed-source-sdk-generators)).
The headline feature for a data product: resilience and ergonomics **ship by default** — "generated SDKs
include proper error handling, OAuth token management, retry logic, and streaming support without
configuration," "pagination is abstracted behind simple iterators … while the SDK manages cursors or
page tokens under the hood," and resilience "applies by default with automatic retries with exponential
backoff, configurable timeouts, idempotency safeguards, and native support for multipart file uploads"
([Fern — Best SDK generation tools](https://buildwithfern.com/post/best-sdk-generation-tools-multi-language-api)).
Nordic APIs rates Fern top for code quality: it produces output of "impeccable quality" that "gives the
impression of being hand-written with precision and care"
([Nordic APIs](https://nordicapis.com/review-of-8-sdk-generators-for-apis-in-2025/)).

The two facts that gate the decision:

1. **It is open-core, not all-open.** "The core software is released under a permissive open source
   license, while enterprise features and managed services are sold commercially" — and those paid
   features include "self-hosted documentation, automated publishing to package registries, and
   role-based access control"
   ([Fern — Open Source vs Closed Source](https://buildwithfern.com/post/open-source-vs-closed-source-sdk-generators)).
   Critically, **OAuth 2.0 is "paid plans only"**
   ([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)).
   Our API uses OAuth2 client-credentials (see `theory-query-api-contract.md` and the channel-auth
   recipes), so the one feature we most need from Fern's "by default" list is behind the paywall.
2. **It is DSL-based, not OpenAPI-native.** Fern is "DSL-based, not OpenAPI-native … OpenAPI support is
   optional" — OpenAPI is an *import* format, and a proprietary config layer "can cause the spec and the
   generator configuration to drift apart over time"
   ([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)).
   Our whole architecture treats the **OpenAPI 3.1 doc as the single source of truth**
   (`theory-query-api-contract.md`); a generator that puts a DSL between spec and SDK is a drift surface.
3. **Vendor connectivity / acquisition risk.** Fern was **"acquired by Postman in January 2026"**
   ([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)). The
   Apache-2 CLI insulates you (you can keep generating from the open core even if the commercial product
   pivots), but anything depending on Fern's hosted features inherits Postman's roadmap.

### 1.3 Speakeasy (closed, idiomatic, strong validation — paid, but runs anywhere)

Closed-source generation logic, paid, but the strongest Python output of the commercial tools and — the
operationally important bit — **not cloud-locked**. Speakeasy supports "ten languages," "treats your
OpenAPI specification as the single source of truth," and ships TypeScript with "a single dependency
(Zod)" using "Zod to validate data at both compile time and runtime"
([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)). For **Python
specifically**, the output is **"Pydantic + TypedDict + Advanced Enums"** (both `BaseModel` and
`TypedDict` for static checking), uses **`urllib3` + `httpx`** (so async via httpx is supported), has
**"Built-in configurable retries"** and **"Supported"** pagination, and ships "Rich usage examples with
working code" — directly contrasted against OpenAPI Generator's "Basic Pydantic only / No retry support /
Not supported pagination / Incomplete examples"
([Speakeasy — Python OSS comparison](https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python)).
It also **"runs on-prem, in air-gapped environments, or in any CI/CD pipeline"**
([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)) — meaning no
build-time dependency on a vendor cloud, which matters for a financial-data product's supply chain.

Cost: roughly **"$600/mo per language,"** with a free tier of "1 language, 250 endpoints"
([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)). The free tier
may actually cover a single-Python-SDK, ≤250-endpoint data API early on — worth a serious look before
paying.

### 1.4 Stainless (closed, idiomatic, but no runtime validation and cloud-only generation)

Generates "the official SDKs for OpenAI, Anthropic, and Cloudflare" — so the output quality is
battle-proven — but three facts make it a poor fit for *this* product:
1. **"Unsafely cast response data to expected types rather than validating"** — no runtime validation
   ([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)). For a
   numbers-must-be-right financial data product, a client that casts-without-validating means a malformed
   upstream payload surfaces as a wrong number rather than a clean validation error.
2. **OAuth is "Manual"** and there is a "custom configuration layer … as an intermediary" (the same
   drift risk as Fern's DSL)
   ([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)).
3. **"Requires cloud connectivity"; "SDK generation requires network access"**
   ([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)) — generation
   itself phones home to Stainless's cloud, a build-supply-chain dependency Speakeasy explicitly avoids.

Cost: "$250/month per SDK," limited free tier
([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)). Excellent
tool, wrong constraints here.

### 1.5 The hand-written wrapper (the deliberate exception)

Not a generator at all — you write a small Python client by hand. **This is what the incumbents
themselves did**, and §2–§5 reverse-engineer both real examples. It is the right call *only* as a
deliberate, documented DX decision (§2.3), never as "we didn't get around to a generator." The cost is
ongoing maintenance: every new endpoint is hand-added, and there is no spec→SDK drift *guard* unless you
build one (§7 solves this by generating the transport and hand-writing only the facade).

### 1.6 The decision rule in one paragraph

If you have **no budget and need it now** → OpenAPI Generator (or `openapi-python-client` for cleaner
Python), accepting "no retries/pagination/OAuth" and bolting those on. If you want **idiomatic + resilient
out of the box and can pay**, and you do **not** want a vendor cloud in your build → **Speakeasy** (it
keeps OpenAPI as the source of truth, runs in your own CI, and gives Pydantic-v2 runtime validation —
the closest commercial fit). If you want **Apache-2 open core** and don't mind paying for OAuth →
**Fern**, accepting the DSL-drift surface. If the SDK is a **first-class product surface with a small,
opinionated public API** (it is, for a quant-facing data product) → **generate the typed transport, then
hand-write the thin facade** (§7) — the route this doc recommends.

---

## 2. The hand-written DELIBERATE exception — the macrosynergy / jpmorganchase pattern

Two real, public, financial-data Python clients both **chose to hand-write** rather than generate. Reading
them is the cheapest way to learn the exact shape a good client needs — because they are battle-tested
against the *actual* DataQuery API we are re-engineering. Both are studied here at the source level.

### 2.1 `macrosynergy/dataquery-api` — the minimal, readable reference (`DQInterface`)

A "simple API client for the DataQuery API"
([github.com/macrosynergy/dataquery-api](https://github.com/macrosynergy/dataquery-api)). The class shape,
read from `dataquery_api.py`:

```python
# class DQInterface — constructor
def __init__(self, client_id: str, client_secret: str,
             proxy: Optional[Dict] = None, batch_size: int = EXPR_LIMIT,
             base_url: str = OAUTH_BASE_URL,
             dq_resource_id: Optional[str] = OAUTH_DQ_RESOURCE_ID): ...
# EXPR_LIMIT = 20   (the API's max expressions per request)
```

**Token caching (get-or-refresh, with a 90% expiry buffer)** — this is the single most important pattern
to copy. The client never re-fetches a token it still holds; it refreshes at 90% of the token lifetime so
a token never expires mid-request:

```python
TOKEN_EXPIRY_BUFFER = 0.9   # refresh at 90% of expires_in

def _is_active(token: Optional[dict] = None) -> bool:
    if token is None:
        return False
    expires = token["created_at"] + timedelta(
        seconds=token["expires_in"] * TOKEN_EXPIRY_BUFFER)
    return datetime.now() < expires

def get_access_token(self) -> str:
    if _is_active(self.current_token):
        return self.current_token["access_token"]
    r_json = request_wrapper(url=OAUTH_TOKEN_URL, data=self.token_data,
                             method="post", proxies=self.proxy).json()
    self.current_token = {
        "access_token": r_json["access_token"],
        "created_at": datetime.now(),
        "expires_in": r_json["expires_in"],
    }
    return self.current_token["access_token"]
```

**Auth header injection on every request** (the token getter is called *per request*, so refresh is
transparent):

```python
def _request(self, url: str, params: dict, **kwargs) -> requests.Response:
    return request_wrapper(
        url=url, params=params,
        headers={"Authorization": f"Bearer {self.get_access_token()}"},
        method="get", proxies=self.proxy, **kwargs).json()
```

**Batching to the API's expression limit + concurrency with a fixed inter-request delay** (the API caps
expressions per call at 20; the client splits the request list into batches of `batch_size` and fans them
out on a thread pool, sleeping `API_DELAY_PARAM` (0.2 s) between submissions to stay under the rate
limit):

```python
expr_batches = [
    expressions[i: min(i + self.batch_size, len(expressions))]
    for i in range(0, len(expressions), self.batch_size)
]
with concurrent.futures.ThreadPoolExecutor() as executor:
    futures = []
    for expr_batch in expr_batches:
        current_params = params.copy()
        current_params["expressions"] = expr_batch
        futures.append(executor.submit(self._get_result,
                       url=self.base_url + TIMESERIES_ENDPOINT,
                       params=current_params, **kwargs))
        time.sleep(API_DELAY_PARAM)   # 0.2 s — the API's fastest allowed cadence
```

**Retry by re-collecting failed batches** (the minimal repo uses a simple decrementing `max_retry`
counter, not exponential backoff):

```python
if len(failed_batches) > 0 and max_retry > 0:
    retry_exprs = [e for batch in failed_batches for e in batch]
    retried = self._get_timeseries(expressions=retry_exprs, params=params,
                                   max_retry=max_retry - 1, ...)
    downloaded_data.extend(retried)
# MAX_RETRY = 3, MAX_CONSECUTIVE_FAILURES = 5
```

**The bare-bones HTTP wrapper raises on any non-200** (no 429-specific handling in the minimal repo — the
production macrosynergy package adds it, §2.2):

```python
def request_wrapper(url, headers=None, params=None, method="get", **kwargs):
    response = requests.request(method=method, url=url, params=params,
                                headers=headers, **kwargs)
    if response.status_code == 200:
        return response
    raise Exception(f"Request failed with status {response.status_code}")
```

(All snippets above are read from `dataquery_api.py` and `dataquery_api_jpmaqs.py` in
[github.com/macrosynergy/dataquery-api](https://github.com/macrosynergy/dataquery-api).)

**The JPMaQS-specific ergonomics layer** sits on top — building DataQuery expressions from tickers and
reshaping the JSON to a long-format DataFrame. This is the "thin ergonomic facade" idea in miniature:

```python
def construct_jpmaqs_expressions(
        ticker, metrics=["value", "grading", "eop_lag", "mop_lag"]):
    return [f"DB(JPMAQS,{ticker},{metric})" for metric in metrics]
    # -> "DB(JPMAQS,GBP_EQXR_NSA,value)"  (ticker = "{cid}_{xcat}")

def time_series_to_df(dicts_list):
    expressions = [d["attributes"][0]["expression"] for d in dicts_list]
    return_df = pd.concat([
        pd.DataFrame(dicts_list.pop()["attributes"][0]["time-series"],
                     columns=["real_date", "value"]
                     ).assign(expression=expressions.pop())
        for _ in range(len(dicts_list))
    ]).reset_index(drop=True)[["real_date", "expression", "value"]]
    return_df["real_date"] = pd.to_datetime(return_df["real_date"])
    return return_df
```

### 2.2 The production-grade macrosynergy package — retry, 429, CertAuth, heartbeat

The `macrosynergy` package's `macrosynergy.download.dataquery` module is the hardened version of the same
client and shows the production touches the minimal repo omits
([docs.macrosynergy.com — dataquery module source](https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html)):

**A real retry loop with status-aware exception classes** — auth errors fail fast (never retried),
transient errors (429 / 5xx / timeouts) retry up to 5 times with a fixed delay (note: still **not**
exponential — a finding we improve on in §4.2):

```python
API_RETRY_COUNT = 5
API_DELAY_PARAM = 0.25      # 250 ms; validation warns if a caller sets < 0.2 s

while retry_count < API_RETRY_COUNT:
    try:
        ...   # request
    except Exception as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise exc
        if isinstance(exc, AuthenticationError):
            raise exc                       # 401 -> fail immediately, never retry
        if any(isinstance(exc, e) for e in known_exceptions):  # 429/5xx/timeout
            logger.warning(error_statement)
            retry_count += 1
            time.sleep(API_DELAY_PARAM)     # FIXED delay (improvement target: §4.2)
```

**Certificate-auth alternative** (some enterprise clients use mTLS instead of OAuth):

```python
class DataQueryCertAuth:
    def get_auth(self):
        return {"headers": {"Authorization": f"Basic {self.auth}"},
                "cert": (self.crt, self.key)}   # client cert + key for requests
```

**A heartbeat / connection check** before a big download (cheap liveness probe against `/heartbeat`):

```python
def check_connection(self, raise_error=False) -> bool:
    time.sleep(API_DELAY_PARAM)
    js = request_wrapper(url=self.base_url + HEARTBEAT_ENDPOINT,
                         params={"data": "NO_REFERENCE_DATA"}, ...)
    return int(js["info"]["code"]) == 200 and js["info"]["message"] == "Service Available."
```

**Same 90% expiry buffer** (`TOKEN_EXPIRY_BUFFER = 0.9`) and the same `concurrent.futures` fan-out, with a
hard stop after `MAX_CONSECUTIVE_FAILURES` that calls
`executor.shutdown(wait=False, cancel_futures=True)`
([docs.macrosynergy.com source](https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html)).

### 2.3 `jpmorganchase/dataquery-sdk` — the full, packaged hand-written client (`DataQuery`)

JP Morgan's own official SDK is the most complete hand-written example: a packaged, MIT-licensed,
Python-3.12+ client described as "a high-performance Python SDK … with advanced features like querying,
downloading, availability checking, rate limiting, retry logic, connection pool monitoring, and
comprehensive logging"
([github.com/jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk)). It is the
gold-standard target for *our* client's shape. Read at the source level:

**Construction — four ways, all converging on a `ClientConfig`** (env vars, `.env`, kwargs, or an explicit
config object), and it is an **async context manager**:

```python
from dataquery import ClientConfig, DataQuery

config = ClientConfig(
    client_id="...", client_secret="...",
    timeout=60.0, max_retries=3, requests_per_minute=300,
)
async with DataQuery(config) as dq:      # async context manager
    ts = await dq.get_expressions_time_series_async(...)

# or sync, same surface:
with DataQuery(client_id="...", client_secret="...") as dq:
    ts = dq.get_expressions_time_series(...)
```

(README, [github.com/jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk).)

**Async/sync parity via a `_async` suffix convention + a persistent background event loop** — this is the
cleanest sync-from-async bridge in the wild and the one to copy. Every operation is *written once* as an
async method named `..._async`; the sync surface is generated by a proxy that runs the coroutine on a
**persistent** background loop (not a throwaway `asyncio.run` per call, so the aiohttp session is reused):

```python
# Pairing (README): the sync name drops the _async suffix
#   list_groups_async()                    <-> list_groups()
#   get_expressions_time_series_async(...) <-> get_expressions_time_series(...)
#   download_file_async(...)               <-> download_file(...)

# Bridge (dataquery/dataquery.py):
def _run_sync(self, coro):
    return self._sync_runner.run(coro)   # SyncRunner holds ONE persistent event loop

class _SyncProxy:                         # exposes dq.sync.<method>()
    def __getattr__(self, name):
        target = getattr(self._dq, f"{name}_async", None)
        if target is None or not callable(target):
            raise AttributeError(f"DataQuery has no async method '{name}_async'")
        def _sync_call(*args, **kwargs):
            return self._dq._run_sync(target(*args, **kwargs))
        return _sync_call
```

The doc comment in the source states the design rationale verbatim: *"The coroutine runs on a persistent
background event loop (one per `DataQuery` instance) rather than a throwaway loop, so the aiohttp session
created on the first call remains usable on every subsequent call."*
([dataquery/dataquery.py](https://github.com/jpmorganchase/dataquery-sdk)).

**The full public surface** (read from the README) — note how few of these you'd actually hand-write a
facade over; most are discovery:

```
# Discovery
list_groups_async(limit)            search_groups_async(keywords, limit, offset)
list_instruments_async(group_id)    search_instruments_async(group_id, keywords)
get_group_attributes_async(group_id)  get_group_filters_async(group_id, page)
# Time-series
get_expressions_time_series_async(expressions, start_date, end_date)
get_instrument_time_series_async(instruments, attributes, start_date, end_date)
get_group_time_series_async(group_id, attributes, filter, start_date, end_date)
# Files / bulk
list_files_async  list_available_files_async  check_availability_async
download_file_async  run_group_download_async  download_historical_async  auto_download_async
# Grid + diagnostics
get_grid_data_async(expr, grid_id, date)
health_check_async()   to_dataframe(response)   get_rate_limit_info()   get_stats()   get_pool_stats()
```

**`to_dataframe` — a proxy to the client, with typed convenience flags and specialized variants:**

```python
def to_dataframe(self, response_data, flatten_nested=True, include_metadata=False,
                 date_columns=None, numeric_columns=None, custom_transformations=None):
    if self._client is None:
        self._client = DataQueryClient(self.client_config)
    return self._client.to_dataframe(response_data, flatten_nested=flatten_nested, ...)
# plus: groups_to_dataframe(), files_to_dataframe(),
#       instruments_to_dataframe(), time_series_to_dataframe()
```

**`get_rate_limit_info` — exposes the live token-bucket state to the caller** (so a well-behaved client can
self-pace, mirroring the server's `RateLimit-*` headers — see `patterns-rate-limiting-and-quotas.md`):

```python
def get_rate_limit_info(self) -> Dict[str, Any]:
    if not self._client:
        return {"error": "Client not connected"}
    rc, rs = self._client.rate_limiter.config, self._client.rate_limiter.state
    return {
        "configuration": {"requests_per_minute": rc.requests_per_minute,
                          "burst_capacity": rc.burst_capacity, ...},
        "current_state": {"available_tokens": rs.tokens,
                          "queue_size": len(rs.queue), ...},
    }
```

**Resilience config knobs** (constructor params + env vars — every one has a `DATAQUERY_*` env override):

```python
DataQuery(max_retries=3, retry_delay=1.0, timeout=600.0,
          requests_per_minute=300, burst_capacity=5, circuit_breaker_threshold=5)
# Env: DATAQUERY_MAX_RETRIES, DATAQUERY_RETRY_DELAY, DATAQUERY_TIMEOUT,
#      DATAQUERY_REQUESTS_PER_MINUTE, DATAQUERY_BURST_CAPACITY, DATAQUERY_CIRCUIT_BREAKER_THRESHOLD
```

**Packaging facts** (from `pyproject.toml`, [github.com/jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk)):
package `dataquery-sdk`, `requires-python >=3.12`, build backend `setuptools.build_meta`, core deps
`aiohttp>=3.10.11,<4`, `pydantic>=2.0.0,<3`, `structlog>=23`, `python-dotenv>=1`, `idna>=3.15`; **pandas is
an *optional extra*** (`[pandas] -> pandas>=2.0.0`, plus `[dev]`, `[docs]`, `[all]`); classifiers include
`Development Status :: 5 - Production/Stable` and `License :: OSI Approved :: MIT License`. Two design
lessons here: **(a)** the transport (`aiohttp`) is async-native and the sync surface is the *derived*
layer; **(b)** pandas is an *extra*, not a hard dependency — a caller who only wants JSON shouldn't be
forced to install a 40 MB numerical stack.

### 2.4 Why both teams hand-wrote — and when that's the right call

Neither team generated. The reason is visible in the surface: a financial time-series client's value is
**90% in the ergonomics of three or four calls** (`series`, `download`, `catalog`, `to_dataframe`) and the
**expression DSL** (`DB(JPMAQS,...,value)`), not in faithfully reflecting 40 CRUD endpoints. A generator
gives you correct-but-generic bindings for all 40; it does **not** give you `construct_jpmaqs_expressions`,
the long-format `QDF` reshape, the 90%-buffer token cache, or the persistent-loop sync bridge — those are
*product* decisions a generator cannot infer from a spec. **That is the deliberate exception: when the
SDK's value is concentrated in a small, opinionated, domain-shaped surface, hand-writing that surface is
not laziness — it is the product.** Document it as such (§2.5) so it is never mistaken for "we skipped the
generator."

### 2.5 Documenting the deliberation (so it isn't read as drift)

A hand-written client must carry, in its repo README and an ADR, the explicit record:

> **Why this client is hand-written (decision, not drift).** The data-analytics API is documented by an
> OpenAPI 3.1 spec (the source of truth). We deliberately do **not** ship a fully-generated SDK as the
> public client. The SDK's value is concentrated in (a) the expression DSL, (b) the `to_dataframe`
> reshape to long format, (c) OAuth token caching with a 0.9 expiry buffer, and (d) async+sync parity —
> none of which a generator infers from the spec. We **do** generate the typed transport + Pydantic
> models from the 3.1 spec (`openapi-python-client`) into an internal `_transport` package, and
> hand-write the thin `Client` facade over it (§7). The generated layer is the drift *guard*; the
> hand-written layer is the *product*. Re-generate `_transport` on every spec change in CI; a diff there
> is the early-warning that the facade needs updating.

This single paragraph is the difference between an auditor reading the hand-written client as a
*senior trade-off* versus *junior corner-cutting*.

---

## 3. What a good client MUST include — the non-negotiable shape

Whether you generate, buy, or hand-write, the resulting Python client is only "good" if it has all of the
following. Each is a thing the two incumbent clients have and a naive generated client lacks by default.

| # | Capability | Why | Incumbent reference |
|---|---|---|---|
| 1 | **Bearer-token auto-refresh** with an expiry **buffer** (refresh at ~90% of lifetime) | A token must never expire mid-request; the caller must never see auth as their problem | macrosynergy `_is_active` + `TOKEN_EXPIRY_BUFFER=0.9` |
| 2 | **Token caching** (don't re-fetch a token you still hold) | One token fetch per ~lifetime, not per request — saves the auth round-trip and the auth-server load | macrosynergy `get_access_token` |
| 3 | **429 / 5xx backoff** with `Retry-After` honored, then exponential + jitter, capped | The server *will* 429 under load; a client that retries instantly makes it worse | jpmorganchase `max_retries`+`retry_delay`; macrosynergy retry loop |
| 4 | **Cursor / pagination auto-iteration** | The server returns one page; the caller wants the whole series without writing a `while next_cursor:` loop | Fern "pagination behind simple iterators"; our §4.3 |
| 5 | **Typed errors** (one exception per failure class) | `except RateLimitError` / `except AuthError` is usable; `except Exception` is not | macrosynergy `AuthenticationError`/`known_exceptions`; §4.4 |
| 6 | **pandas / DataFrame convenience** as an **optional extra** | The audience is quants — `df = resp.to_dataframe()` is the killer feature — but don't force pandas on JSON-only callers | jpmorganchase `to_dataframe` + `[pandas]` extra |
| 7 | **Async + sync parity** (one written once, the other derived) | Notebook users want sync; services want async — give both from one implementation | jpmorganchase `_async` suffix + persistent-loop bridge |
| 8 | **Runtime validation** of responses (Pydantic v2) | A wrong/malformed number must surface as a validation error, not a silent cast — the no-invented-number rule at the client edge | Speakeasy Pydantic+TypedDict; OSS-gen basic Pydantic |
| 9 | **Provenance pass-through** | The API envelope carries `Provenance{commercialOk}` (see `theory-query-api-contract.md`); the client must expose it, never strip it | our envelope contract |
| 10 | **`get_rate_limit_info()`** exposing the limiter state | Lets a batch caller self-pace before it gets a 429 | jpmorganchase `get_rate_limit_info` |

If any of rows 1–8 is missing, the client is not production-grade — it's a thin `requests.get` wrapper with
a logo. The generated-vs-written choice is really "which route gives me all ten cheapest."

---

## 4. The recipe — building the missing pieces (runnable Python)

A generated transport (OpenAPI Generator / `openapi-python-client`) gives you models + a typed transport
and *not* rows 1, 3, 4, 5, 7, 10 above. Here is each missing piece as runnable code on `httpx` (async) so
you can hand-write the facade layer (§7). These are the patterns; adapt names to your generated transport.

### 4.1 Bearer-token auto-refresh + caching (rows 1, 2)

The 90%-buffer cache, generalized and thread/async-safe. This is `macrosynergy._is_active` +
`get_access_token` rebuilt for `httpx.AsyncClient`:

```python
import time, httpx, anyio
from dataclasses import dataclass, field

@dataclass
class _Token:
    access_token: str
    created_at: float        # monotonic-ish wall clock (time.time())
    expires_in: float        # seconds, from the token endpoint
    buffer: float = 0.9      # refresh at 90% of lifetime (the incumbent constant)

    @property
    def is_active(self) -> bool:
        return time.time() < self.created_at + self.expires_in * self.buffer

class TokenProvider:
    """OAuth2 client-credentials token cache with a 0.9 expiry buffer.

    Refreshes BEFORE expiry so a long batch never fails mid-flight on a stale token.
    Concurrency-guarded so a burst of 50 concurrent calls triggers exactly ONE refresh.
    """
    def __init__(self, token_url: str, client_id: str, client_secret: str,
                 http: httpx.AsyncClient, audience: str | None = None):
        self._url, self._cid, self._sec = token_url, client_id, client_secret
        self._http, self._aud = http, audience
        self._token: _Token | None = None
        self._lock = anyio.Lock()

    async def bearer(self) -> str:
        if self._token and self._token.is_active:
            return self._token.access_token            # cache hit, no network
        async with self._lock:                          # only one refresh under a burst
            if self._token and self._token.is_active:   # double-checked locking
                return self._token.access_token
            data = {"grant_type": "client_credentials",
                    "client_id": self._cid, "client_secret": self._sec}
            if self._aud:
                data["audience"] = self._aud
            r = await self._http.post(self._url, data=data)
            r.raise_for_status()
            j = r.json()
            self._token = _Token(access_token=j["access_token"],
                                 created_at=time.time(),
                                 expires_in=float(j.get("expires_in", 3600)))
            return self._token.access_token
```

The **double-checked lock** is the one improvement over the naive incumbent code: under a 50-concurrent-
request burst with no cached token, the macrosynergy code can fire 50 token fetches; this fires exactly
one. (See `theory-channel-auth.md` / the channel-auth recipes for the server side of the same OAuth2 flow.)

### 4.2 429 / 5xx backoff — exponential + jitter, honoring `Retry-After` (row 3)

The incumbents use a **fixed** delay (macrosynergy `time.sleep(0.25)`); a financial data API under spike
load needs **exponential backoff with full jitter** to avoid the retry stampede, and must **honor the
server's `Retry-After`** when present (our server sends it — see
`patterns-rate-limiting-and-quotas.md`). This is the documented improvement over the incumbent pattern:

```python
import random, httpx

RETRYABLE = {429, 500, 502, 503, 504}

async def request_with_retry(http: httpx.AsyncClient, method: str, url: str,
                             *, bearer: str, max_retries: int = 4,
                             base: float = 0.5, cap: float = 20.0, **kw) -> httpx.Response:
    """Single HTTP attempt with retries. Honors Retry-After; else exp backoff + full jitter."""
    attempt = 0
    while True:
        r = await http.request(method, url,
                               headers={**kw.pop("headers", {}),
                                        "Authorization": f"Bearer {bearer}"}, **kw)
        if r.status_code not in RETRYABLE:
            r.raise_for_status()        # turns 4xx (non-retryable) into a typed error (§4.4)
            return r
        attempt += 1
        if attempt > max_retries:
            raise RateLimitError(r) if r.status_code == 429 else UpstreamError(r)
        # honor server guidance first; it KNOWS when the window resets
        ra = r.headers.get("Retry-After")
        if ra is not None:
            delay = float(ra)
        else:                            # AWS "full jitter": sleep in [0, min(cap, base*2^n))
            delay = random.uniform(0, min(cap, base * (2 ** (attempt - 1))))
        await anyio.sleep(delay)
```

Why full jitter and not the incumbent's fixed delay: with a fixed delay, N clients that all hit a 429 at
the same instant retry *in lockstep* — they re-collide every cycle. Full jitter de-synchronizes them,
which is the AWS-documented fix for the "thundering herd of retries." (The server-side companion — `429`,
`Retry-After`, `RateLimit-*` headers, circuit breaker — is fully specified in
`patterns-rate-limiting-and-quotas.md` and `patterns-error-contract-and-status-codes.md`.)

### 4.3 Cursor auto-iteration (row 4)

Our API uses keyset/cursor pagination (`theory-pagination-cursor-vs-offset.md`,
`patterns-series-retrieval-endpoint.md`): each page returns a `meta.nextCursor`. Fern abstracts this
"behind simple iterators"; here is that iterator by hand as an **async generator** so the caller writes
`async for page in client.iter_series(...)` and never sees a cursor:

```python
from typing import AsyncIterator

async def iter_pages(fetch, **params) -> AsyncIterator[dict]:
    """Yield every page; follow meta.nextCursor until exhausted. `fetch(cursor=..., **params)`
    returns the parsed JSON envelope: {data, meta: {nextCursor}, provenance}."""
    cursor = None
    while True:
        page = await fetch(cursor=cursor, **params)
        yield page
        cursor = page.get("meta", {}).get("nextCursor")
        if not cursor:
            return

async def collect_series(fetch, **params) -> list[dict]:
    """Convenience: flatten all pages' data rows into one list (the common case)."""
    rows: list[dict] = []
    async for page in iter_pages(fetch, **params):
        rows.extend(page["data"])
    return rows
```

The facade then offers both the streaming form (`iter_series`, memory-bounded — never holds the universe,
the R-SCALE rule) and the eager form (`series(...).to_dataframe()`), letting the caller choose between
bounded memory and convenience.

### 4.4 Typed errors (row 5)

One exception class per failure mode, all under a common base so callers can `except DataAPIError` broadly
or catch a specific one. This is `macrosynergy`'s `AuthenticationError`/`known_exceptions` split,
generalized and mapped to our RFC-9457 error envelope (`patterns-error-contract-and-status-codes.md`):

```python
class DataAPIError(Exception):
    """Base for every client error. Carries the RFC-9457 problem body when present."""
    def __init__(self, response: httpx.Response | None = None, message: str | None = None):
        self.response = response
        self.problem = (response.json() if response is not None
                        and "application/problem+json" in response.headers.get("content-type", "")
                        else None)
        super().__init__(message or (self.problem or {}).get("detail")
                         or (str(response.status_code) if response is not None else "error"))

class AuthError(DataAPIError): ...          # 401/403 — never retried
class RateLimitError(DataAPIError):         # 429 — exposes retry_after for the caller
    @property
    def retry_after(self) -> float | None:
        v = self.response.headers.get("Retry-After") if self.response else None
        return float(v) if v is not None else None
class NotFoundError(DataAPIError): ...       # 404 — bad dataset/expression id
class ValidationError(DataAPIError): ...     # 422 — bad query params
class UpstreamError(DataAPIError): ...       # 5xx — provider/our-side failure, retryable

def raise_for_status_typed(r: httpx.Response) -> None:
    if r.is_success:
        return
    cls = {401: AuthError, 403: AuthError, 404: NotFoundError,
           422: ValidationError, 429: RateLimitError}.get(r.status_code)
    if cls is None:
        cls = UpstreamError if r.status_code >= 500 else DataAPIError
    raise cls(r)
```

### 4.5 pandas convenience as an OPTIONAL extra (row 6)

Mirror the jpmorganchase choice: pandas is an **extra**, imported lazily so JSON-only callers never pay
for it. The reshape is the macrosynergy `time_series_to_df` long-format pattern, productized:

```python
def to_dataframe(envelope: dict, *, wide: bool = False):
    """Convert a series envelope to a tidy DataFrame. Lazy pandas import -> optional dep."""
    try:
        import pandas as pd
    except ImportError as e:                 # actionable error, not an AttributeError
        raise RuntimeError("DataFrame support requires the [pandas] extra: "
                           "pip install jpmd[pandas]") from e
    rows = envelope["data"]                   # [{date, expression, value}, ...]
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])   # date arithmetic lives here, not in the caller
    if wide:                                   # pivot to one column per expression
        df = df.pivot(index="date", columns="expression", values="value").sort_index()
    return df
```

### 4.6 Date arithmetic helpers (the small ergonomics that matter)

Quant callers pass dates a dozen ways; the client normalizes them (the incumbents default `end_date` to
"now" and accept both `YYYY-MM-DD` and `YYYYMMDD`). Centralize it so no caller hand-formats a date string:

```python
from datetime import date, datetime, timezone

def _norm_date(d: str | date | datetime | None, *, default_today: bool = False) -> str | None:
    if d is None:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d") if default_today else None
    if isinstance(d, (date, datetime)):
        return d.strftime("%Y-%m-%d")
    s = str(d)
    if len(s) == 8 and s.isdigit():           # "20250131" -> "2025-01-31"
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s                                    # assume already ISO "YYYY-MM-DD"
```

---

## 5. The full thin-facade client (the recommended hand-written layer, end to end)

Putting §4 together: a small `Client` over the generated transport (or raw httpx), with async + sync
parity, the jpmorganchase persistent-loop bridge, and the two or three calls that *are* the product.

```python
# jpmd/client.py  — the thin ergonomic facade over the generated _transport
import anyio, httpx
from ._auth import TokenProvider
from ._http import request_with_retry, raise_for_status_typed
from ._paginate import iter_pages, collect_series
from ._frames import to_dataframe
from ._dates import _norm_date
from ._sync import SyncRunner          # persistent-loop bridge (see §5.1)

class AsyncClient:
    def __init__(self, *, client_id: str, client_secret: str,
                 base_url: str = "https://api.jpmd.example/v1",
                 token_url: str | None = None, timeout: float = 60.0,
                 max_retries: int = 4, requests_per_minute: int = 300):
        self._base = base_url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=timeout)        # ONE pooled client, reused
        self._tokens = TokenProvider(token_url or f"{self._base}/oauth/token",
                                     client_id, client_secret, self._http)
        self._max_retries = max_retries

    async def __aenter__(self): return self
    async def __aexit__(self, *exc): await self._http.aclose()

    async def _get(self, path: str, **params) -> dict:
        bearer = await self._tokens.bearer()
        # drop None params so the query string stays clean
        params = {k: v for k, v in params.items() if v is not None}
        r = await request_with_retry(self._http, "GET", f"{self._base}{path}",
                                     bearer=bearer, max_retries=self._max_retries,
                                     params=params)
        return r.json()                                        # envelope: {data, meta, provenance}

    # ---- the product surface (3 calls + helpers) ----
    async def catalog(self, *, search: str | None = None, cursor: str | None = None) -> dict:
        return await self._get("/catalog", search=search, cursor=cursor)

    async def series_async(self, expression: str | list[str], *,
                           start=None, end=None, frequency: str | None = None,
                           cursor: str | None = None) -> dict:
        exprs = ",".join(expression) if isinstance(expression, list) else expression
        return await self._get("/series", expression=exprs,
                               start=_norm_date(start), end=_norm_date(end, default_today=True),
                               frequency=frequency, cursor=cursor)

    async def iter_series(self, expression, **kw):
        async for page in iter_pages(lambda cursor: self.series_async(expression, cursor=cursor, **kw)):
            yield page

    async def series_all(self, expression, **kw) -> list[dict]:
        return await collect_series(lambda cursor: self.series_async(expression, cursor=cursor, **kw))

    def to_dataframe(self, envelope: dict, *, wide: bool = False):
        return to_dataframe(envelope, wide=wide)               # optional [pandas] extra

    async def get_rate_limit_info(self) -> dict:
        return await self._get("/_meta/ratelimit")             # mirrors RateLimit-* headers
```

### 5.1 Async/sync parity — the persistent-loop bridge (copying jpmorganchase)

```python
# jpmd/_sync.py
import anyio
from threading import Thread
from queue import Queue

class SyncRunner:
    """Runs coroutines on ONE persistent background event loop (per the jpmorganchase design),
    so the pooled httpx client created on the first call is reused on every later call —
    instead of asyncio.run() spinning up and tearing down a loop (and the connection pool) per call."""
    def __init__(self):
        self._jobs: "Queue" = Queue()
        self._thread = Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        async def loop():
            while True:
                coro, out = await anyio.to_thread.run_sync(self._jobs.get)
                if coro is None:
                    return
                try:    out.put(("ok", await coro))
                except BaseException as e:  out.put(("err", e))
        anyio.run(loop)

    def run(self, coro):
        out: "Queue" = Queue()
        self._jobs.put((coro, out))
        kind, val = out.get()
        if kind == "err":
            raise val
        return val

# jpmd/client.py  — the sync facade derives EVERY *_async method (the _SyncProxy pattern)
class Client:
    def __init__(self, **kw):
        self._runner = SyncRunner()
        self._async = AsyncClient(**kw)

    def __getattr__(self, name):
        target = getattr(self._async, f"{name}_async", None)
        if not callable(target):
            raise AttributeError(f"no sync method '{name}' (no '{name}_async' on the async client)")
        return lambda *a, **k: self._runner.run(target(*a, **k))

    # explicit pass-throughs for the non-async helpers
    def catalog(self, **kw):   return self._runner.run(self._async.catalog(**kw))
    def series(self, *a, **k): return self._runner.run(self._async.series_async(*a, **k))
    def to_dataframe(self, *a, **k): return self._async.to_dataframe(*a, **k)
```

Now both `await aclient.series_async("DB(...)")` and `Client(...).series("DB(...)")` work from the **one**
async implementation — the jpmorganchase parity guarantee, reproduced.

---

## 6. Publishing to PyPI + semver tied to the API `/v1`

A client nobody can `pip install` is a code sample. Publishing is part of the recipe, and the **version
discipline is load-bearing**: the SDK's *major* version tracks the API's *major* version.

### 6.1 The versioning contract (the one rule that prevents the worst client bug)

- The API is versioned in the **path**: `/v1/...` (see `theory-query-api-contract.md`). The path major is
  the contract.
- **The SDK major version == the API path major version.** SDK `1.x.y` only ever talks to `/v1`. When the
  API ships `/v2` (a breaking contract change), the SDK goes to `2.0.0` and points at `/v2`. A caller who
  pins `jpmd>=1,<2` is *guaranteed* a `/v1`-compatible client — they never silently get a breaking change.
- Within a major: **minor** = new endpoints / new optional fields (backward-compatible); **patch** = bug
  fixes. This is SemVer applied so the *consumer's* `pip` constraint maps to an *API contract* guarantee.
- Generated transport: drive `packageVersion` from the spec's `info.version`
  (`openapi-generator ... --additional-properties=packageVersion=$(spec_version)`), so a regenerated client
  can never disagree with the spec it was built from.

### 6.2 `pyproject.toml` (the publishable shape — modeled on the jpmorganchase package)

```toml
[project]
name = "jpmd"                              # the public PyPI name (placeholder)
version = "1.0.0"                          # major == API /v1
description = "Python client for the JPM-Markets data-analytics API"
requires-python = ">=3.12"                 # match the incumbent floor
readme = "README.md"
license = "MIT"
dependencies = [
    "httpx>=0.27,<1.0",                    # async-native transport, HTTP/2-ready
    "anyio>=4.0",                          # the sync/async bridge primitive
    "pydantic>=2.0.0,<3.0.0",              # runtime response validation (row 8)
    "python-dotenv>=1.0.0",               # .env credential loading (incumbent convenience)
]

[project.optional-dependencies]
pandas = ["pandas>=2.0.0"]                 # to_dataframe — OPTIONAL, never forced
dev = ["pytest>=8", "pytest-asyncio", "ruff", "mypy", "respx", "build", "twine"]

[project.urls]
Homepage = "https://github.com/yourorg/jpmd"
Documentation = "https://yourorg.github.io/jpmd"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"     # the jpmorganchase choice; hatchling is equally fine

[tool.setuptools.packages.find]
include = ["jpmd*"]
```

### 6.3 Build + publish (trusted publishing — no long-lived token in CI)

The modern, secure publish path is **PyPI Trusted Publishing (OIDC)** from GitHub Actions — no PyPI API
token stored anywhere. Build with the standard `build` frontend, publish with the official
`pypa/gh-action-pypi-publish`:

```yaml
# .github/workflows/publish.yml
name: publish
on:
  release:
    types: [published]            # publish on a GitHub Release (tag drives the version)
jobs:
  pypi:
    runs-on: ubuntu-latest
    environment: pypi             # bind the trusted-publisher to this environment
    permissions:
      id-token: write             # REQUIRED for OIDC trusted publishing — no API token
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install build
      - run: python -m build      # -> dist/jpmd-1.0.0-py3-none-any.whl + .tar.gz
      - uses: pypa/gh-action-pypi-publish@release/v1   # OIDC; no password/token needed
```

(Trusted publishing is configured once on PyPI under the project's *Publishing* settings, binding the
GitHub repo + workflow + environment; the OIDC token minted at run time replaces a stored API key. This is
the current PyPI-recommended path — verify the exact `environment`/permissions wiring against
[docs.pypi.org Trusted Publishers](https://docs.pypi.org/trusted-publishers/) before first publish, as the
action version pin may have moved.)

For a **private** registry (a financial-data SDK is often internal-only), the same `python -m build`
output is pushed to a private index (CodeArtifact / Artifactory / Azure Artifacts / a self-hosted
`devpi`) with `twine upload --repository-url <private-index>` — the build step is identical; only the
publish target changes.

### 6.4 Pre-publish checklist (the gates before `1.0.0` goes out)

- `python -m build` produces both a wheel and an sdist with no warnings.
- `twine check dist/*` passes (README renders on PyPI).
- The package version == the spec `info.version` major (§6.1) — enforce with a CI assert.
- `pip install dist/*.whl` in a clean venv, then `import jpmd; jpmd.__version__` works, and the
  `[pandas]` extra installs/imports only when requested.
- `mypy`/`ruff` clean; the generated `_transport` re-generates with no diff against the committed copy
  (the drift guard from §2.5).
- A smoke test hits a sandbox `/v1` endpoint with a real OAuth token (the auth + retry + pagination paths
  actually execute, not just import).

---

## 7. The recommendation — generate the transport, hand-write the facade

Synthesizing §1–§6 into the call for this product line:

**Generate the typed transport + Pydantic v2 models from the OpenAPI 3.1 spec using
`openapi-python-client` (idiomatic, async-aware, Apache-2/free, clean typed dataclasses) into an internal
`jpmd/_transport/` package — then hand-write the thin `Client` facade (§5) over it.**

Why this hybrid beats each pure route:

- **vs pure OpenAPI Generator / `openapi-python-client`:** the generated layer alone is missing rows 1, 3,
  4, 7, 10 of §3 (token cache+buffer, exponential-jitter backoff, cursor iteration, sync parity, rate-limit
  introspection) and the domain ergonomics (expression DSL, long-format `to_dataframe`). The facade adds
  exactly those — the *product* surface — without re-deriving the 40 endpoints' bindings by hand.
- **vs pure Fern/Speakeasy/Stainless:** no recurring per-language/per-SDK fee, no DSL/config layer between
  the 3.1 spec and the SDK (zero drift — the spec stays the single source of truth), no build-time vendor-
  cloud dependency (Stainless's "requires cloud connectivity"), and **OAuth2 — which we need and which is
  Fern-paywalled — is in our own facade**, free. We keep Speakeasy's best property (OpenAPI as source of
  truth, Pydantic-v2 runtime validation) without its bill.
- **vs pure hand-written (the incumbents):** the incumbents hand-wrote *everything*, including the transport
  bindings — so a new endpoint is hand-coded and the client can silently drift from the API. Our hybrid
  **generates** the transport, so the regeneration diff in CI is the drift alarm (§2.5); we hand-write only
  the small, opinionated facade where hand-writing is genuinely better.

**The trade-off we are accepting, stated plainly (not hidden):** we own and maintain the facade and the
generation pipeline. That is ~one engineer-week to stand up and a few hours per API change. We accept it
because the SDK is a *first-class product surface* for a quant audience — its value is concentrated in the
facade, exactly the layer a generator cannot produce. If the audience were "any developer hitting a CRUD
API," the calculus flips toward Speakeasy (pay, get all ten rows for free). **Re-evaluate this call when:**
the endpoint count crosses ~30 and the facade stops being "thin," *or* a second language client is needed
(at which point Speakeasy's multi-language consistency may beat maintaining two hand-written facades) —
both are the documented falsifiability tests for this decision.

### 7.1 The build sequence (where this sits in the project)

1. The FastAPI service emits OpenAPI 3.1 at `/openapi.json` (sibling `python-fastapi-data-service` skill;
   contract in `theory-query-api-contract.md`).
2. CI runs `openapi-python-client generate --url .../openapi.json` → `jpmd/_transport/` (committed; a diff
   here is the drift alarm).
3. Hand-write `jpmd/_auth.py`, `_http.py`, `_paginate.py`, `_frames.py`, `_sync.py`, `client.py` (§4–§5).
4. `pyproject.toml` (§6.2) with the `[pandas]` extra and SDK-major == API-major.
5. GitHub Release → Trusted-Publishing workflow (§6.3) → PyPI (or private index).
6. The README carries the "decision, not drift" ADR paragraph (§2.5).

This is the `api-publishing-sdk-portal` skill's outline made concrete for the Python client: one OpenAPI
3.1 contract → a generated, idiomatic, published SDK with the resilient, ergonomic facade the audience
actually consumes.

---

## 8. Anti-patterns (mistake → fix)

| Mistake | Why it breaks | Fix |
|---|---|---|
| Ship the **raw OpenAPI Generator** Python output as the public SDK | "A Java developer would write it"; no retries, no pagination, no OAuth flow — the consumer hates it | Generate the *transport* only; hand-write the idiomatic facade (§7), or pay for Speakeasy |
| **Hand-write the whole client** with no spec linkage (like the incumbents) | New endpoints drift silently; no guard that the client matches the API | Generate the transport from the 3.1 spec; the regen diff is the drift alarm (§2.5) |
| Fetch a **new token on every request** | Hammers the auth server; adds a round-trip to every call | Cache the token; refresh at 90% of `expires_in` with a double-checked lock (§4.1) |
| **Fixed-delay** retry on 429 (the incumbent default) | N clients retry in lockstep → re-collide every cycle → retry stampede | Honor `Retry-After`; else exponential backoff + **full jitter**, capped (§4.2) |
| Make **pandas a hard dependency** | Forces a 40 MB numerical stack on JSON-only callers | pandas is an **optional extra**; lazy-import in `to_dataframe` with an actionable error (§4.5) |
| `asyncio.run(coro)` **per sync call** | Spins up/tears down a loop *and the connection pool* every call — slow, leaks | One persistent background loop per client (the jpmorganchase `SyncRunner`, §5.1) |
| `except Exception` as the only error surface | Caller can't distinguish auth vs rate-limit vs not-found vs 5xx | One typed exception per failure class under a common base (§4.4) |
| **Cast** responses without validating (the Stainless trade-off) | A malformed upstream number surfaces as a wrong value, not an error — violates "never invent a number" at the client edge | Validate with Pydantic v2 at the response boundary (§3 row 8) |
| **Strip** the `Provenance{commercialOk}` envelope to "just the data" | The consumer loses the licensing flag and may redistribute a RED series | Expose provenance on every response object; never drop it (§3 row 9) |
| SDK version **unrelated** to the API version | Caller's `pip` pin gives no contract guarantee; a breaking API change silently breaks them | SDK major == API path major; `pip install 'jpmd>=1,<2'` ⇒ guaranteed `/v1` (§6.1) |
| Choose **Stainless** for an air-gapped/regulated build | "Requires cloud connectivity" for generation — a build-supply-chain dependency | Speakeasy (runs on-prem/air-gapped) or the OSS+facade hybrid (§1.4, §7) |
| Adopt **Fern** for the OAuth flow without checking the plan | OAuth 2.0 is "paid plans only" on Fern | Put OAuth in your own facade (free), or budget for the paid Fern tier (§1.2) |
| Store a **PyPI API token** in CI secrets | Long-lived credential, blast radius if leaked | PyPI **Trusted Publishing** (OIDC) — no stored token (§6.3) |

---

## 9. Sources

Primary library source (read at the source level):
- `jpmorganchase/dataquery-sdk` — official JPM hand-written Python SDK: README (public surface, async/sync
  `_async` convention, `to_dataframe`, `get_rate_limit_info`, config knobs), `dataquery/dataquery.py`
  (persistent-loop sync bridge, `_SyncProxy`, `to_dataframe` proxy, `get_rate_limit_info`),
  `pyproject.toml` (deps, `[pandas]` extra, `requires-python>=3.12`, MIT). https://github.com/jpmorganchase/dataquery-sdk
- `macrosynergy/dataquery-api` — minimal `DQInterface` reference: `dataquery_api.py` (90%-buffer token
  cache, `get_access_token`, batching to `EXPR_LIMIT=20`, ThreadPool fan-out + `API_DELAY_PARAM=0.2`,
  retry counter), `dataquery_api_jpmaqs.py` (`construct_jpmaqs_expressions`, `time_series_to_df`). https://github.com/macrosynergy/dataquery-api
- `macrosynergy` package — production `DataQueryInterface`: retry loop (`API_RETRY_COUNT=5`,
  auth-error-fail-fast, fixed `API_DELAY_PARAM=0.25`), `DataQueryCertAuth`, `check_connection` heartbeat,
  `TOKEN_EXPIRY_BUFFER=0.9`. https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html

Generator comparison (current-facts, cross-verified across Speakeasy + Fern + Nordic APIs):
- Speakeasy — Choosing an SDK generator (the matrix: languages, pricing, source-of-truth, runtime
  validation, dependency counts, OAuth/pagination/retries/SSE, 4,500+ issues, Postman acquisition,
  Stainless cloud-only, Speakeasy on-prem). https://www.speakeasy.com/blog/comparison-sdk-generators-openapi
- Speakeasy — Python OSS comparison (OpenAPI Generator vs Speakeasy for Python: urllib3 vs urllib3+httpx,
  Basic-Pydantic vs Pydantic+TypedDict, async ❌ vs ✅, no-retry/no-pagination vs built-in, "a Java
  developer would write it", file-count comparison). https://www.speakeasy.com/docs/sdks/languages/python/oss-comparison-python
- Fern — Open Source vs Closed Source SDK Generators (Apache-2 CLI, languages list, open-core boundary,
  Speakeasy/Stainless proprietary). https://buildwithfern.com/post/open-source-vs-closed-source-sdk-generators
- Fern — Best SDK generation tools (retries+backoff, pagination iterators, OAuth token mgmt, streaming,
  idempotency, multipart "by default"). https://buildwithfern.com/post/best-sdk-generation-tools-multi-language-api
- Nordic APIs — Review of 8 SDK Generators 2025 (Fern "impeccable quality"/"hand-written precision",
  OpenAPI-Generator complex source + no SDK docs, Kiota/AutoRest, closed/commercial tags). https://nordicapis.com/review-of-8-sdk-generators-for-apis-in-2025/
- OpenAPI Generator — python generator docs (the config table: `library` urllib3/asyncio/tornado/httpx,
  `packageName`, `packageVersion`, `generateSourceCodeOnly`, `disallowAdditionalPropertiesIfNotPresent`). https://openapi-generator.tech/docs/generators/python/
- `openapi-generators/openapi-python-client` — the idiomatic OSS Python generator (typed dataclasses,
  async-aware, clean output) used as the transport generator in the §7 recommendation. https://github.com/openapi-generators/openapi-python-client
- PyPI Trusted Publishers (OIDC publish from GitHub Actions, no stored token). https://docs.pypi.org/trusted-publishers/

> **Verification note.** All version/feature/pricing claims are pinned to the cited pages as read June
> 2026. Pricing and plan boundaries for the commercial generators (Speakeasy ~$600/mo per language; Fern
> and Stainless ~$250/mo per SDK; Fern OAuth paid-only) move frequently — re-confirm against the vendor's
> pricing page before a purchase decision. The two incumbent SDKs are public repos; their constants
> (`TOKEN_EXPIRY_BUFFER=0.9`, `EXPR_LIMIT=20`, `API_DELAY_PARAM=0.2/0.25`, `API_RETRY_COUNT=5`,
> `requires-python>=3.12`) were read from the cited files and may change on a new release — re-read the
> file, treat these as the shape, not a frozen contract.
