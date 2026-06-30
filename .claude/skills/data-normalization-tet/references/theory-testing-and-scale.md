# theory-testing-and-scale.md

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (a NEW Python /
> Pydantic / data-engineering write path, **NOT** Lumina's Bun/Express/Prisma/Supabase/Upstash app).
> This doc covers the two properties that make the TET normalization layer **trustworthy** and
> **fast**: (1) how to **test a `Fetcher`** so a green test bar actually means "this provider still
> maps cleanly onto the standard model," and (2) the **R-SCALE tier story for the write path** — why
> per-row Pydantic is correct at Tier 1 and a pathology on the bulk-backfill path, and what to switch
> to. Greenfield: there are no codebase `file:line` anchors yet; everything is a design + recipe
> grounded in primary docs, cited inline.

**The clean line this doc never crosses.** TET ends at **validated standard-model rows + a provenance
stamp**. *Testing* TET means proving the mapping (provider response → validated rows) is correct and
stays correct. *Scaling* TET means making that mapping cheap per row at 100M rows. **Persisting** those
rows — the hypertable, the upsert SQL, the COPY protocol, chunk/compression behavior — is the
**`timescaledb-timeseries`** skill's job, not this one. Where this doc touches the store (the idempotent
upsert the worker calls, the "validate-then-COPY" handoff) it states the **contract** TET must satisfy
and hands off; it does not re-teach the store.

---

## What this doc decides for you, up front (the verdicts)

1. **Test a Fetcher with record/replay, not live calls.** Capture a real provider response **once**
   into a checked-in cassette; replay it offline on every CI run. This is OpenBB's `--record=all` /
   `@pytest.mark.record_http` idea ([OpenBB tests doc](https://docs.openbb.co/odp/python/developer/how-to/tests))
   reimplemented on our stack with **`pytest-recording`** (a VCR.py plugin) for any `requests`/`urllib`
   path and **`respx`** for an `httpx` path — because we standardized on async `httpx`
   ([01-plan.md chosen stack](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md);
   [respx PyPI](https://pypi.org/pypi/respx/json)).
2. **Unit-test `transform_query` and `transform_data` in isolation** — pure functions, **no network**.
   The three-stage `Fetcher` boundary (query-transform → extract → data-transform) exists precisely so
   the two pure stages can be tested without a cassette at all. The cassette test covers `extract_data`
   (the I/O stage); the pure-function tests cover the mapping logic.
3. **Pin the standard model with golden files.** A `transform_data` test asserts its output against a
   checked-in `golden.json` of the expected standard-model rows. Golden-file diffs are how you catch a
   silent schema drift ("provider renamed `pctChange` → `percentChange`") that a type-only assertion
   misses.
4. **A contract test enforces the field-intersection invariant.** One parametrized test asserts that
   **every registered provider model for a logical endpoint can produce every field the standard model
   marks required.** This is the test that makes "the standard is the intersection" a fact, not a
   comment.
5. **Per-row Pydantic is right at Tier 1, fatal at bulk.** Point reads (a few hundred rows) → per-row
   `Model.model_validate(...)` is fine and reads clean. A 100M-row backfill that instantiates one
   Pydantic model per row is the **120 ms → 840 ms pathology** the plan already
   **REJECTED** ([02-skills-and-pipeline.md, "Per-row Pydantic on bulk paths — REJECTED"](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md);
   [00-theory.md pre-mortem #6](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)).
   The bulk path coerces **columnar** (PyArrow/Polars batch) and validates a **sample** with **Pandera
   schema-level checks**, not every row ([Pandera `validate(... sample=, random_state=)`](https://pandera.readthedocs.io/en/stable/reference/generated/pandera.api.dataframe.model.DataFrameModel.html)).
6. **The bulk write path lives on the worker/cron, never the user request path.** Idempotent upsert on
   the natural key; off-request; partial-failure = ground-or-skip, never a fabricated number (repo
   non-negotiables #1 and #4; [product-at-scale.md](../../../../.claude/rules/product-at-scale.md)).

**Pinned versions referenced** (verify against your `pyproject.toml` at build time; all licenses
checked from primary sources):

| Library | Version (current mid-2026) | License | Source |
|---|---|---|---|
| `pytest` | 8.x | MIT | [pypi.org/project/pytest](https://pypi.org/project/pytest/) |
| `vcrpy` | **8.1.1** (8.0.0 = 2026-05-25) | MIT | [pypi.org/project/vcrpy](https://pypi.org/project/vcrpy/) |
| `pytest-recording` | **0.13.4** (depends `vcrpy>=2.0.1`) | MIT | [pypi.org/pypi/pytest-recording/json](https://pypi.org/pypi/pytest-recording/json) |
| `respx` | **0.23.1** (needs `httpx>=0.25.0`) | BSD-3-Clause | [pypi.org/pypi/respx/json](https://pypi.org/pypi/respx/json) |
| `pandera` | **0.32.0** (Narwhals backend: polars/ibis/pyspark) | MIT | [pypi.org/project/pandera](https://pypi.org/project/pandera/) |
| `pydantic` | **2.13.x** (Rust `pydantic-core`) | MIT | [02-skills-and-pipeline.md verified toolchain](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md) |
| `pyarrow` | **24.0.0** (2026-04-21) | Apache-2.0 | [02-skills-and-pipeline.md verified toolchain](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md) |
| `polars` | 1.x | MIT | [pola.rs](https://pola.rs) |
| `httpx` | 0.28.x | BSD-3-Clause | [02-skills-and-pipeline.md verified toolchain](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md) |

> **AGPL trap reminder (carries into the test layer).** OpenBB's whole repo — **including its test
> harness and `unit_tests_generator.py`** — is **AGPL-3.0-only**
> ([OpenBB LICENSE](https://github.com/OpenBB-finance/OpenBB/blob/develop/LICENSE);
> [02-skills-and-pipeline.md trap #1](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)).
> We **reimplement the testing *idea*** (record once, replay offline; a `Fetcher.test()` self-check)
> from OpenBB's public **docs** on MIT/BSD-licensed tools (`pytest-recording`, `respx`). We do **not**
> vendor `openbb-*` packages, copy its test code, or run its generators. The pattern is an
> uncopyrightable idea; only OpenBB's *source* is encumbered.

---

## Table of contents

1. [Why a Fetcher needs its own test story](#1-why)
2. [The stage boundary is the test boundary](#2-stage-boundary)
3. [Record/replay: the OpenBB `--record=all` idea reimplemented](#3-record-replay)
   - 3a. [VCR.py mental model + record modes](#3a-vcr-modes)
   - 3b. [`pytest-recording` for `requests`/`urllib` paths](#3b-pytest-recording)
   - 3c. [`respx` for our `httpx` async path](#3c-respx)
   - 3d. [Scrubbing API keys out of cassettes (non-negotiable)](#3d-scrubbing)
   - 3e. [Cassette hygiene: when to re-record, CI in `none` mode](#3e-hygiene)
4. [Unit-testing `transform_query` and `transform_data` in isolation](#4-pure-units)
5. [Golden-file standard-model assertions](#5-golden)
6. [The `Fetcher.test()` self-check (our clean-room version)](#6-fetcher-test)
7. [The contract test: every provider satisfies the required set](#7-contract)
8. [Property-based and edge-case tests](#8-property)
9. [R-SCALE: the write-path tier story](#9-rscale)
   - 9a. [The tiers, restated for this write path](#9a-tiers)
   - 9b. [Tier 1 — per-row Pydantic is correct here](#9b-tier1)
   - 9c. [The break: per-row Pydantic at 100M rows (120 ms → 840 ms)](#9c-break)
   - 9d. [Tier 100×/10000× — columnar batch coercion + Pandera sample validation](#9d-columnar)
   - 9e. [Validate a sample, not every row — the statistics + the API](#9e-sample)
   - 9f. [The validated-rows → store handoff (where TET ends)](#9f-handoff)
10. [The worker/cron write path: idempotent, off-request](#10-worker)
11. [A measurement harness: never claim a speedup you didn't measure](#11-harness)
12. [Anti-patterns quick table](#12-anti-patterns)
13. [Output contract checklist](#13-checklist)
14. [Sources](#14-sources)

---

## 1. Why a Fetcher needs its own test story <a name="1-why"></a>

A `Fetcher[Q,R]` sits on the seam between **the outside world (a vendor API you don't control)** and
**your standard model (a contract your store and SDK depend on)**. Two independent things can break it,
and a naive test catches neither:

1. **Your mapping code is wrong.** `transform_query` builds the wrong URL params; `transform_data`
   reads `data["close"]` when the standard field is `close_price`; a unit conversion drops a factor of
   100 (cents vs dollars). This is *your* bug.
2. **The provider changed under you.** They renamed a field, changed a date format from `YYYY-MM-DD`
   to epoch millis, started returning `null` where they used to return `0`, or added a wrapper object.
   Your code is unchanged; the contract silently broke. This is the **most dangerous** class because
   nothing in your repo changed — only a green CI bar that *still calls the live API* would catch it,
   and that bar is flaky, slow, rate-limited, and needs a secret in CI.

The discipline that handles both: **record a real response once, freeze it, and assert your mapping
against the frozen copy.** Class (1) is caught the moment you write the test. Class (2) is caught when
you **deliberately re-record** and the golden diff lights up — you upgrade the contract on purpose,
in a reviewed PR, instead of discovering the drift in production as a fabricated or missing number
(which would violate non-negotiable #1, "never invent a finance number").

This is exactly OpenBB's design: *"Each `Fetcher` comes equipped with a `test` method that will ensure
it is implemented correctly, that it is returning the expected data, that all types are correct, and
that the data is valid"* and *"The plugins capture the HTTP interactions as a YML cassette and replays
it while running tests"*
([OpenBB tests doc](https://docs.openbb.co/odp/python/developer/how-to/tests)). We rebuild that idea on
our own MIT/BSD tools.

---

## 2. The stage boundary is the test boundary <a name="2-stage-boundary"></a>

The TET `Fetcher` is three methods (see the sibling `patterns-fetcher-three-stage.md` /
`tet-pattern-and-fetcher.md` for the full pattern). For testing, the only thing that matters is **which
stages touch the network and which are pure**:

| Stage | Signature (shape) | Network? | How you test it |
|---|---|---|---|
| `transform_query` | `params dict → ProviderQueryParams` | **No** — pure | Plain unit test, no cassette (§4) |
| `extract_data` / `aextract_data` | `(query, credentials) → raw JSON/bytes` | **Yes** — the only I/O stage | Record/replay cassette (§3) |
| `transform_data` | `(query, raw, ...) → list[ProviderData]` | **No** — pure | Golden-file unit test, no cassette (§4, §5) |

This split is the whole payoff of the three-stage design for testing: **two of the three stages are
pure functions you can test with zero network and zero cassette.** A bug in `transform_data` (the field
mapping, the unit math, the timezone coercion — where most real bugs live) is caught by a fast,
deterministic, offline unit test that takes a fixed `raw` dict in and asserts rows out. You only need a
cassette for the one stage that does I/O.

```python
# The shape we test against. Stages are separable on purpose.
class MyProviderEquityHistoricalFetcher(
    Fetcher[MyProviderEquityHistoricalQueryParams, list[MyProviderEquityHistoricalData]]
):
    @staticmethod
    def transform_query(params: dict) -> MyProviderEquityHistoricalQueryParams:   # PURE
        return MyProviderEquityHistoricalQueryParams(**params)

    @staticmethod
    async def aextract_data(query, credentials, **kwargs) -> dict:                # I/O ONLY
        url = build_url(query, api_key=credentials.get("my_provider_api_key"))
        async with httpx.AsyncClient() as client:
            r = await client.get(url, timeout=20.0)
            r.raise_for_status()
            return r.json()

    @staticmethod
    def transform_data(query, data: dict, **kwargs) -> list[MyProviderEquityHistoricalData]:  # PURE
        rows = data["historical"]
        return [MyProviderEquityHistoricalData.model_validate(r) for r in rows]
```

Note the per-row `model_validate` in `transform_data` — **correct here**, because a single point read
returns hundreds of rows, not 100M. §9 is about what changes when the *worker* calls this Fetcher in a
loop over a decade of daily history for 10,000 instruments.

---

## 3. Record/replay: the OpenBB `--record=all` idea reimplemented <a name="3-record-replay"></a>

### 3a. VCR.py mental model + record modes <a name="3a-vcr-modes"></a>

VCR.py *"records all HTTP interactions that take place through the libraries it supports and serializes
and writes them to a flat file (in yaml format by default). This flat file is called a cassette"*
([vcrpy usage](https://vcrpy.readthedocs.io/en/latest/usage.html)). The cassette is checked into the
repo next to the test. On replay, VCR intercepts the request, **matches it** against a recorded
interaction, and returns the recorded response — **no socket is opened**.

The four record modes, **verbatim** from the VCR.py docs
([vcrpy usage](https://vcrpy.readthedocs.io/en/latest/usage.html)):

| Mode | Behavior (verbatim) | When we use it |
|---|---|---|
| `once` (default) | "Replay previously recorded interactions. Record new interactions if there is no cassette file. Cause an error to be raised for new requests if there is a cassette file." | Local: first author run that *creates* the cassette |
| `none` | "Replay previously recorded interactions. Cause an error to be raised for any new requests." | **CI — always.** A new/unrecorded request is a hard failure, not a silent live call. |
| `new_episodes` | "Record new interactions. Replay previously recorded interactions." | Adding one new case to an existing cassette |
| `all` | "Record new interactions. Never replay previously recorded interactions." | **Deliberate re-record** of a whole cassette (the OpenBB `--record=all`) |

The mapping to OpenBB's surface: OpenBB's `pytest <file> --record=all` and per-test
`pytest <file>::test_x --record http`
([OpenBB tests doc](https://docs.openbb.co/odp/python/developer/how-to/tests)) is VCR.py's `all` mode
driven through the `pytest-recording` plugin's `--record-mode` flag (below). We reimplement the surface
on our own tooling.

**`match_on` — what counts as "the same request."** VCR decides a replay matches by a tuple of request
attributes. The default is `(method, scheme, host, port, path, query)`; you can add `body` and
`headers` ([vcrpy advanced](https://vcrpy.readthedocs.io/en/latest/advanced.html)). For financial
providers, **match on `query` (and `body` for POST)** — that's where the ticker/date-range lives, so
two different `extract_data` calls don't accidentally replay each other's response. Do **not** match on
`headers` (your `Authorization`/`User-Agent` will differ between record and replay machines and would
break replay).

### 3b. `pytest-recording` for `requests`/`urllib` paths <a name="3b-pytest-recording"></a>

`pytest-recording` is *"A pytest plugin powered by VCR.py to record and replay HTTP traffic"*
([pytest-recording](https://github.com/kiwicom/pytest-recording)), MIT-licensed, depends on
`vcrpy>=2.0.1` ([PyPI json](https://pypi.org/pypi/pytest-recording/json)). Use it for any code path
that goes through `requests` or `urllib` (VCR.py's native stubs cover those). The key mechanics,
**verbatim** from the plugin:

- The marker: `@pytest.mark.vcr` — *"By default, cassettes are stored in a `cassettes/{module_name}/`
  directory and named after the test function."*
- The CLI flag: `--record-mode`, **default `none`** *"to prevent unintentional network requests"* —
  modes `none` / `once` / `new_episodes` / `all` / `rewrite` ("rewrite a cassette from scratch").
- Config fixture: a `vcr_config` fixture at any scope returns a dict passed to `VCR.use_cassettes`
  (e.g. `{"filter_headers": ["authorization"]}`).
- Hard network block: `@pytest.mark.block_network` (or `--block-network`) raises if any un-cassetted
  request escapes ([pytest-recording](https://github.com/kiwicom/pytest-recording)).

```python
# tests/providers/test_treasury_fetcher.py
# Path: cassettes live at tests/providers/cassettes/test_treasury_fetcher/<test_name>.yaml
import pytest
from datetime import date
from dataplane.providers.treasury.equity_historical import TreasuryYieldFetcher

# Module-scoped: scrub secrets out of every cassette this module records.
@pytest.fixture(scope="module")
def vcr_config():
    return {
        "filter_headers": ["authorization", "x-api-key"],
        "filter_query_parameters": ["api_key", "token"],
        "match_on": ["method", "scheme", "host", "port", "path", "query"],
    }

@pytest.mark.vcr            # records on --record-mode=once|all, replays on none (CI default)
@pytest.mark.block_network # a missed cassette is a hard error, never a live call
def test_treasury_yield_fetcher_maps_to_standard_model():
    params = {"symbol": "DGS10", "start_date": date(2010, 1, 1), "end_date": date(2010, 1, 31)}
    query = TreasuryYieldFetcher.transform_query(params)
    raw = TreasuryYieldFetcher.extract_data(query, credentials={})   # cassette serves this
    rows = TreasuryYieldFetcher.transform_data(query, raw)

    assert len(rows) > 0
    first = rows[0]
    assert first.date == date(2010, 1, 4)        # first trading day of 2010
    assert isinstance(first.value, float)
    assert first.value == pytest.approx(3.85, abs=0.01)   # the actual DGS10 close, frozen
```

To author the cassette the first time:

```bash
# Author run — hits the real API ONCE, writes the YAML cassette, scrubs secrets via vcr_config.
pytest tests/providers/test_treasury_fetcher.py -k treasury_yield --record-mode=once

# Deliberate re-record after a known provider change (the OpenBB --record=all equivalent):
pytest tests/providers/test_treasury_fetcher.py -k treasury_yield --record-mode=rewrite
# then review the cassette + golden diff in the PR before merging.
```

### 3c. `respx` for our `httpx` async path <a name="3c-respx"></a>

Our committed stack uses **async `httpx`** as the upstream client
([01-plan.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)).
VCR.py's native transport stubs target `requests`/`urllib`/`aiohttp`; for `httpx` the first-class tool
is **`respx`** — *"a simple, yet powerful, utility for mocking out the HTTPX, and HTTP Core, libraries"*
([respx](https://github.com/lundberg/respx)), BSD-3-Clause, needs `httpx>=0.25.0`
([PyPI json](https://pypi.org/pypi/respx/json)).

**Be precise about what respx is and isn't.** respx is a **mocking** library — you *declare* the
response, it does not *record* a live one. There is no cassette. That's the correct trade for our
write path: provider responses are **stable, public, schema-bound documents** (a Treasury yield row, a
World Bank indicator point), so a curated, checked-in fixture (a small JSON file) replayed through
respx is just as good as a recorded cassette and is **easier to review** (it's the literal payload, not
a YAML envelope). Use the two tools by transport:

| Your `extract_data` uses… | Use | Why |
|---|---|---|
| `httpx` (our default) | **respx** + a checked-in fixture JSON | respx is the first-class `httpx` mock; cassette-style recording isn't native to `httpx` in VCR |
| `requests` / `urllib` (a legacy provider lib) | **pytest-recording** (VCR cassette) | VCR records those transports natively |

> There are community VCR-over-httpx shims, but for a stack we control, **curated respx fixtures are
> the lower-magic, more-reviewable choice** for the always-the-same financial payloads we fetch. Reserve
> real cassettes for `requests`-based provider SDKs you can't easily hand-author.

```python
# tests/providers/test_worldbank_fetcher.py
import json, pathlib
import httpx, respx, pytest
from dataplane.providers.worldbank.indicator import WorldBankIndicatorFetcher

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "worldbank_NY_GDP_MKTP_CD_IND.json"

@pytest.mark.asyncio
@respx.mock
async def test_worldbank_indicator_maps_to_standard_model():
    # Declare the upstream response from a checked-in fixture (the "frozen real payload").
    payload = json.loads(FIXTURE.read_text())
    respx.get(url__regex=r"https://api\.worldbank\.org/v2/country/IND/indicator/.*").mock(
        return_value=httpx.Response(200, json=payload)
    )

    params = {"country": "IND", "indicator": "NY.GDP.MKTP.CD"}
    query = WorldBankIndicatorFetcher.transform_query(params)
    raw = await WorldBankIndicatorFetcher.aextract_data(query, credentials={})  # respx serves this
    rows = WorldBankIndicatorFetcher.transform_data(query, raw)

    assert all(r.country == "IND" for r in rows)
    assert rows[0].value is not None
    # Attribution provenance is part of the standard model for a CC-BY source — assert it's present.
    assert rows[0].provenance.commercial_ok is True
    assert "World Bank" in rows[0].provenance.attribution
```

**Authoring the fixture.** Hit the real World Bank endpoint once with `curl`/a throwaway script, save
the JSON into `tests/providers/fixtures/`, and **manually trim it to the minimum + scrub anything
sensitive** (there are no keys on World Bank, but a Finnhub/Twelve Data fixture must have its key
removed — §3d). The fixture is the test's source of truth; the test asserts the mapping, not the
network.

### 3d. Scrubbing API keys out of cassettes (non-negotiable) <a name="3d-scrubbing"></a>

A recorded cassette captures the **request headers and query string** — which is exactly where your
API key lives. **A cassette with a live key checked into git is a secret leak**, and it will work
locally then "pass locally but fail on CI" once someone rotates the key. OpenBB calls this out
directly: *"you might run into issues with the cache tied to your specific provider on your local
machine, which you'll know is the case if your tests pass locally but fail on the CI… delete the cache
file… and re-record"* ([OpenBB tests doc](https://docs.openbb.co/odp/python/developer/how-to/tests)).

The two scrub knobs (VCR.py / pytest-recording config):

- `filter_headers=["authorization", "x-api-key"]` — removes the auth header from the cassette
  ([vcrpy advanced](https://vcrpy.readthedocs.io/en/latest/advanced.html)).
- `filter_query_parameters=["api_key", "token"]` — removes a key passed in the URL query (Twelve Data,
  Finnhub, FMP all pass keys this way) ([vcrpy advanced](https://vcrpy.readthedocs.io/en/latest/advanced.html)).

For respx fixtures the scrub is trivial — you hand-author the fixture, so a key never enters it. The
discipline is: **a checked-in fixture/cassette must contain zero live secrets; a CI grep for known key
prefixes (`sk-`, the provider's documented prefix) in `tests/**/fixtures` and `tests/**/cassettes`
should be a pre-commit/CI gate.** This mirrors the repo's `precheck-licensing.mjs` posture — make the
leak mechanically catchable, not a reviewer's vigilance.

### 3e. Cassette hygiene: when to re-record, CI in `none` mode <a name="3e-hygiene"></a>

The operating rules that keep record/replay honest:

1. **CI runs in `--record-mode=none` + `--block-network`.** Verbatim default of `pytest-recording` is
   `none` *"to prevent unintentional network requests"*
   ([pytest-recording](https://github.com/kiwicom/pytest-recording)). A test that needs a request with
   no matching cassette **fails the build** — it never silently makes a live call. This is the single
   most important config line: without it, a CI green can mean "we successfully hit the live API," which
   is flaky, rate-limited, and not a real test.
2. **Re-recording is a reviewed event.** Run `--record-mode=rewrite` (or OpenBB's `--record=all`
   equivalent), **then read the golden diff** (§5). A changed number, a renamed field, a new wrapper —
   each is a deliberate decision to accept a new provider contract, made in a PR, not a surprise in
   prod.
3. **One cassette/fixture per logical case, named after the test.** Don't share a cassette between
   unrelated tests; a shared cassette is the "tests pass in isolation, fail together" trap.
4. **Cassettes are small and trimmed.** A 5-MB raw response makes a useless diff. Trim to the rows the
   assertion needs (a month of daily history, not a decade) so the golden diff is human-readable.

---

## 4. Unit-testing `transform_query` and `transform_data` in isolation <a name="4-pure-units"></a>

This is where the **stage boundary pays off** (the prompt's phrase, and it's literally true). The two
pure stages need **no cassette, no respx, no network** — they're functions from data to data.

**`transform_query` test** — the request-building logic. Catches: wrong param names, missing required
params, bad date formatting, list→CSV joins, enum coercion.

```python
import pytest
from datetime import date
from dataplane.providers.twelvedata.equity_historical import (
    TwelveDataEquityHistoricalQueryParams as Q,
    TwelveDataEquityHistoricalFetcher as F,
)

def test_transform_query_maps_standard_to_provider_params():
    std = {"symbol": "aapl", "start_date": date(2024, 1, 1), "end_date": date(2024, 1, 31),
           "interval": "1d"}
    q = F.transform_query(std)
    assert isinstance(q, Q)
    assert q.symbol == "AAPL"                 # provider wants uppercase — the field_validator ran
    assert q.interval == "1day"              # __json_schema_extra__/alias mapped 1d → 1day
    assert q.outputsize == 5000              # provider-specific default applied

def test_transform_query_rejects_inverted_dates():
    with pytest.raises(ValueError):          # model_validator enforces start <= end
        F.transform_query({"symbol": "AAPL", "start_date": date(2024, 2, 1),
                           "end_date": date(2024, 1, 1)})
```

**`transform_data` test** — the mapping + value-normalization logic, fed a **literal raw dict** (the
shape `extract_data` would have returned). Catches the dangerous bugs: field rename, unit/scale error,
timezone, null handling.

```python
def test_transform_data_normalizes_units_and_fields():
    # The raw payload shape, inlined — no network. (For big payloads, load from fixtures/*.json.)
    raw = {"values": [
        {"datetime": "2024-01-03", "open": "184.22", "close": "184.25", "volume": "58414460"},
        {"datetime": "2024-01-02", "open": "187.15", "close": "185.64", "volume": "82488700"},
    ]}
    query = F.transform_query({"symbol": "AAPL", "start_date": date(2024, 1, 1),
                               "end_date": date(2024, 1, 3)})
    rows = F.transform_data(query, raw)

    assert len(rows) == 2
    # Provider returns newest-first strings; standard model is oldest-first typed floats.
    assert [r.date for r in rows] == [date(2024, 1, 2), date(2024, 1, 3)]   # sorted ascending
    assert rows[0].close == 185.64 and isinstance(rows[0].close, float)     # str → float coerced
    assert rows[0].volume == 82_488_700 and isinstance(rows[0].volume, int)
```

These two tests run in **single-digit milliseconds**, never flake, and pin the exact logic that breaks
most often. The cassette/respx test (§3) covers only the thin `extract_data` I/O stage. **This is the
return on the three-stage design.**

---

## 5. Golden-file standard-model assertions <a name="5-golden"></a>

Inline `assert` on three fields is fine for a 2-row fixture. For a realistic response (a month of OHLCV,
20 fields), hand-writing asserts is both tedious and **misses the field you forgot to assert** — which
is the field a provider will silently rename. The fix is a **golden file**: serialize the full
standard-model output once, check it in, and assert future output equals it byte-for-byte.

```python
# tests/providers/test_twelvedata_golden.py
import json, pathlib
from dataplane.providers.twelvedata.equity_historical import TwelveDataEquityHistoricalFetcher as F

GOLDEN = pathlib.Path(__file__).parent / "golden" / "twelvedata_aapl_2024_01.json"
RAW    = pathlib.Path(__file__).parent / "fixtures" / "twelvedata_aapl_2024_01_raw.json"

def _serialize(rows) -> list[dict]:
    # Deterministic: Pydantic v2 model_dump with mode="json" so dates/Decimals are stable strings.
    return [r.model_dump(mode="json") for r in rows]

def test_twelvedata_standard_model_matches_golden(request):
    raw = json.loads(RAW.read_text())
    query = F.transform_query({"symbol": "AAPL"})
    got = _serialize(F.transform_data(query, raw))

    if request.config.getoption("--update-golden", default=False):
        GOLDEN.write_text(json.dumps(got, indent=2, sort_keys=True))   # regenerate on purpose
        return

    expected = json.loads(GOLDEN.read_text())
    assert got == expected     # any field rename, dropped column, or value drift fails here
```

Wire `--update-golden` as a custom pytest option (a 5-line `conftest.py` `addoption`). The workflow:

1. Author the fixture (`*_raw.json`) and golden (`*.json`) once with `--update-golden`.
2. Every CI run asserts `transform_data(fixture) == golden`. **A silent provider rename now fails the
   golden test**, even if you never asserted that specific field by hand.
3. When you re-record the fixture (§3e) and the golden legitimately changes, regenerate with
   `--update-golden` and **review the golden diff in the PR** — the diff *is* the changelog of the
   provider contract.

**Why golden beats type-only asserts.** A test that only checks `isinstance(r.close, float)` passes
even if `close` is now reading the wrong column (it's still a float — the *wrong* float). The golden
file pins the **value**, so a misread column changes the number and the test catches it. This is the
test that defends non-negotiable #1 ("never invent a finance number") at the unit level: the number in
the golden file is the real, grounded number; drift from it is a red flag.

**Determinism rules for golden files** (or they flake):
- Always `model_dump(mode="json")` — dates → ISO strings, `Decimal` → string, no Python `repr` drift.
- `sort_keys=True` in `json.dumps` — dict ordering is stable across Python versions.
- Sort rows by the natural key (date, symbol) **inside `transform_data`**, so order is part of the
  contract, not an accident of provider response order.
- No timestamps-of-now, no random IDs, no machine-dependent floats in the golden output.

---

## 6. The `Fetcher.test()` self-check (our clean-room version) <a name="6-fetcher-test"></a>

OpenBB ships a `Fetcher.test()` that *"will ensure it is implemented correctly, that it is returning
the expected data, that all types are correct, and that the data is valid"* and the canonical use is
`fetcher.test({}, {})` returning `None` on success
([OpenBB tests doc](https://docs.openbb.co/odp/python/developer/how-to/tests)). We reimplement the
**idea** — a single method that runs the whole Fetcher end-to-end against a recorded/mocked response
and asserts the standard-model invariants — on our own code (no `openbb-*` import):

```python
# dataplane/tet/fetcher.py  — our clean-room base, AGPL-free.
from typing import Generic, TypeVar, get_args
from pydantic import BaseModel

Q = TypeVar("Q", bound=BaseModel)
R = TypeVar("R", bound=BaseModel)

class Fetcher(Generic[Q, R]):
    require_credentials: bool = False

    # ... transform_query / extract_data / transform_data defined by subclasses ...

    @classmethod
    async def test(cls, params: dict, credentials: dict | None = None) -> None:
        """Run the full pipeline and assert standard-model invariants. Returns None on success.

        Mirrors OpenBB's Fetcher.test idea (reimplemented from public docs, not its AGPL source):
        correct implementation, expected data shape, correct types, valid data.
        """
        query = cls.transform_query(params)
        assert isinstance(query, cls._query_type()), "transform_query returned wrong type"

        raw = await cls._aextract(query, credentials or {})
        rows = cls.transform_data(query, raw)

        assert isinstance(rows, list) and rows, "transform_data returned no rows"
        row_type = cls._data_type()
        for r in rows:
            assert isinstance(r, row_type), f"row is {type(r)}, expected {row_type}"
        # Standard-model required-field invariant: every required field is populated.
        required = {n for n, f in row_type.model_fields.items() if f.is_required()}
        for r in rows:
            missing = [n for n in required if getattr(r, n, None) is None]
            assert not missing, f"required field(s) {missing} are None"
        # The provenance stamp is part of every row TET emits.
        assert all(getattr(r, "provenance", None) is not None for r in rows), "missing provenance"

    @classmethod
    def _query_type(cls): return get_args(cls.__orig_bases__[0])[0]
    @classmethod
    def _data_type(cls):
        r = get_args(cls.__orig_bases__[0])[1]
        return get_args(r)[0] if hasattr(r, "__args__") else r
```

Then a **provider test is two lines**, with the network mocked by respx/cassette:

```python
@pytest.mark.asyncio
@respx.mock
async def test_treasury_fetcher_selfcheck():
    respx.get(url__regex=r"https://api\.fiscaldata\.treasury\.gov/.*").mock(
        return_value=httpx.Response(200, json=_treasury_fixture())
    )
    await TreasuryYieldFetcher.test({"symbol": "DGS10"}, {})   # raises AssertionError on any defect
```

`Fetcher.test()` is the **cheap, uniform gate** every new provider must pass; the golden test (§5) is
the **value-level** gate; the contract test (§7) is the **cross-provider** gate. Together they're the
three rungs.

---

## 7. The contract test: every provider satisfies the required set <a name="7-contract"></a>

The defining invariant of the standard-model layer (see `standard-models-and-aliasing.md`): **the
standard model is the field *intersection* shared by ≥2 providers; every provider model SUBCLASSES the
standard; anything narrower than the intersection is `Optional`.** A comment can claim this. A
**contract test** makes it a fact that fails CI the day someone adds a provider that can't produce a
required field.

```python
# tests/contract/test_standard_model_satisfiable.py
import pytest
from dataplane.tet.registry import REGISTRY   # maps logical endpoint -> [provider Fetcher classes]
from dataplane.standard_models import STANDARD_MODELS   # logical endpoint -> standard Data model

def _required_fields(model) -> set[str]:
    return {n for n, f in model.model_fields.items() if f.is_required()}

# Parametrize over EVERY (endpoint, provider) pair so the failure names the offending provider.
PAIRS = [(ep, prov) for ep, provs in REGISTRY.items() for prov in provs]

@pytest.mark.parametrize("endpoint,provider", PAIRS, ids=lambda p: getattr(p, "__name__", str(p)))
def test_provider_subclasses_standard_and_can_fill_required(endpoint, provider):
    standard = STANDARD_MODELS[endpoint]            # e.g. EquityHistoricalData
    provider_data = provider._data_type()           # e.g. TwelveDataEquityHistoricalData

    # 1. Structural: provider model IS a subclass of the standard (the field-intersection law).
    assert issubclass(provider_data, standard), (
        f"{provider_data.__name__} must subclass {standard.__name__} "
        f"(standard = field intersection; providers extend, never narrow it)"
    )

    # 2. Satisfiability: the provider model exposes every field the standard marks required.
    std_required = _required_fields(standard)
    prov_fields = set(provider_data.model_fields)
    missing = std_required - prov_fields
    assert not missing, (
        f"{provider_data.__name__} cannot satisfy required standard fields {missing}; "
        f"either the provider truly lacks them (then they must be Optional in the standard) "
        f"or the mapping/alias is missing"
    )
```

This test encodes the **negation-loop F4 defense** ("a metric in a costume") at the schema level: if a
provider can't actually produce a "required" field, the field was never really part of the intersection
and pretending otherwise would mean fabricating or null-filling it. The test forces the honest choice:
either the field is genuinely shared (keep it required) or it isn't (make it `Optional`, and the SDK
contract says so). It is the structural enforcement of non-negotiable #1 at design time.

**Extend it with a data-level contract** (optional, stronger): run each provider's `Fetcher.test()`
against a small recorded fixture and assert the union of produced fields **covers** the standard's
required set with real values, not just declares them. That catches a model that declares a field but
whose `transform_data` never populates it.

---

## 8. Property-based and edge-case tests <a name="8-property"></a>

Golden + cassette tests pin known inputs. **Property tests** (Hypothesis, MIT) pin invariants across
*generated* inputs — valuable for the value-normalization math where a single off-by-100 hides in an
untested range.

```python
from hypothesis import given, strategies as st

@given(cents=st.integers(min_value=0, max_value=10_000_000))
def test_cents_to_dollars_is_exact(cents):
    # The unit-normalization helper transform_data uses for a cents-quoting provider.
    from dataplane.normalize.units import cents_to_dollars
    dollars = cents_to_dollars(cents)
    assert dollars == pytest.approx(cents / 100)
    # Round-trip invariant: no precision loss in the integer domain.
    assert round(dollars * 100) == cents
```

Edge cases every Fetcher test suite must cover explicitly (these are the production incidents):

- **Empty response** — provider returns `{"values": []}` for a valid-but-dataless query → `transform_data`
  returns `[]`, **never raises and never fabricates a row** (non-negotiable #1).
- **Provider error envelope** — a 200 with `{"status":"error","message":"..."}` (Twelve Data does this)
  → mapped to a typed `unavailable`, not parsed as data.
- **Null in a non-null field** — `{"close": null}` mid-series → the documented policy (skip the row, or
  carry forward, or `None` if the standard field is Optional), asserted.
- **Timezone/DST boundary** — a timestamp on a spring-forward day coerces to the right UTC instant.
- **Out-of-order rows** — provider returns descending; standard model is ascending (assert the sort).

---

## 9. R-SCALE: the write-path tier story <a name="9-rscale"></a>

### 9a. The tiers, restated for this write path <a name="9a-tiers"></a>

The repo's R-SCALE discipline ([product-at-scale.md](../../../../.claude/rules/product-at-scale.md))
demands that any scale-surface feature state **which tier it survives and what breaks at the next**. The
TET **write path** is a scale surface (a "heavy ingest" surface — the rule names it explicitly: *"Heavy
ingest (e.g. nightly EDGAR XBRL): lives in `worker/` on a cron, not the serverless route"*). Restated
for this layer:

| Tier | Load on the write path | What it looks like |
|---|---|---|
| **1× (demo)** | A point read or a small backfill: 1 instrument, a month–year of daily history (hundreds–thousands of rows) | A user-triggered `getQuote`-shape fetch; the first provider you wire up |
| **100× (traction)** | A real backfill: 10k instruments × a decade of daily = **~25M rows**; nightly increments of millions | The first production cron warming the store |
| **10,000× (the product)** | Full universe backfill / re-ingest: **100M+ rows** in one job; intraday or tick pulls in 10–100× more | DataQuery's proven shape (~4B hits/yr served from the store) |

The crucial framing the rule exists to prevent: **shipping a Tier-1 implementation while believing it's
Tier-3.** Per-row Pydantic in `transform_data` *is correct at Tier 1* and reads like clean, considered
code — which is exactly why it survives review and then melts the bulk path in production (the
pre-mortem #6: *"Bulk endpoints melt under Pydantic… the 120ms→840ms pathology at scale"*
([00-theory.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md))).

### 9b. Tier 1 — per-row Pydantic is correct here <a name="9b-tier1"></a>

For a point read or a small backfill, **per-row `Model.model_validate(...)` is the right tool** and you
should not over-engineer it away:

```python
@staticmethod
def transform_data(query, data: dict, **kwargs) -> list[EquityHistoricalData]:
    # Tier 1: hundreds–low-thousands of rows. Per-row validation is fine and reads clean.
    return [EquityHistoricalData.model_validate(r) for r in data["values"]]
```

Why it's fine here: Pydantic v2's core is Rust (`pydantic-core`), *"between 4x and 50x faster than v1"*
([Pydantic v2 article](https://pydantic.dev/articles/pydantic-v2)). A few hundred `model_validate`
calls is sub-millisecond-per-row, well under any latency budget. You get full per-row validation, clean
errors, typed output — the right trade when N is small. **Do not reach for Arrow here**; columnar batch
machinery is overhead you don't need at Tier 1 and obscures the code. R-SCALE is explicit that *building
only Tier 1 is fine* — the bug is *believing* it's Tier 3.

### 9c. The break: per-row Pydantic at 100M rows (120 ms → 840 ms) <a name="9c-break"></a>

The pathology is **structural, not a tuning problem.** Per-row validation pays a fixed Python-level cost
**per row**:

- Each `model_validate` is a Python call into `pydantic-core`, builds a Python model **object** (one per
  row), allocates its `__dict__`/slots, runs each field's validator, and returns a Python instance the
  GC must later track.
- The cost is **O(rows × fields)** in Python object construction — and Python object construction is the
  expensive part, which Rust-core speeds up but does not eliminate. The Pydantic perf docs confirm the
  shape: even the cheapest path, `TypedDict`, is only *"~2.5x faster than nested models"* and
  *"wrap validators… require that data is materialized in Python during validation"*
  ([Pydantic performance](https://pydantic.dev/docs/validation/latest/concepts/performance/)) — i.e. the
  per-object Python materialization is the floor you can't get under while you validate row-by-row.

**The first-principles arithmetic** (the kind of derivation the negation loop's Q2 demands, shown
explicitly). Take an optimistic, measured-ballpark **~3 µs per row** for `model_validate` of a small
financial row on `pydantic-core` (small models validate in the low-single-digit microseconds on v2;
treat this as an order-of-magnitude figure, not a guarantee — `[measure on your hardware]`):

- 100M rows × 3 µs = **~300 s of pure validation CPU**, single-threaded, plus
- 100M Python objects allocated and GC-tracked → heap pressure, GC pauses, and a memory ceiling if you
  materialize the list (100M × ~200 B/object ≈ **20 GB** just for the model instances).

That is the "120 ms → 840 ms" shape the pre-mortem names, scaled to a full backfill: a path that is
fast on a point read becomes a multi-minute, multi-GB CPU/GC grinder on the bulk path. The plan
**already rejected it**: *"Per-row Pydantic on bulk paths — REJECTED: use Arrow/columnar batch
transport (the 120ms→840ms pathology)"*
([02-skills-and-pipeline.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)).

**The general principle (carry this everywhere):** *per-row work in Python over a bulk dataset is the
bug; the fix is to make the unit of work a **column/batch**, where the per-row constant is paid once per
column in compiled code, not once per row in Python.* This is the same reason the store side uses `COPY`
not `INSERT … executemany`, and the same reason charts downsample server-side — all three are
"don't do N Python operations when one columnar operation does it."

### 9d. Tier 100×/10000× — columnar batch coercion + Pandera sample validation <a name="9d-columnar"></a>

The bulk write path replaces "loop → per-row Pydantic" with **two columnar operations**:

1. **Coerce the whole batch columnar** — load the provider rows into an **Arrow Table / Polars
   DataFrame** in one shot, cast dtypes per column (string→float64, ISO-string→date32,
   string→int64) using the compiled engine, not Python. PyArrow (Apache-2.0, v24.0.0) and Polars (MIT)
   both do typed columnar cast in Rust/C++ over the whole column at once.
2. **Validate at the *schema* level on a *sample*** — run **Pandera** (MIT, v0.32.0) against the
   DataFrame. Pandera checks dtype + range + nullability **per column** (one vectorized pass), and its
   `validate()` takes a **`sample=`** argument to check only a random subset of rows (§9e).

```python
import polars as pl
import pandera.polars as pa
from pandera.typing.polars import Series

# 1. Standard-model schema as a Pandera DataFrameModel (the columnar twin of the Pydantic model).
class EquityHistoricalSchema(pa.DataFrameModel):
    symbol: Series[str]   = pa.Field(str_length={"min_value": 1, "max_value": 12})
    date:   Series[pl.Date]
    open:   Series[float] = pa.Field(ge=0)
    high:   Series[float] = pa.Field(ge=0)
    low:    Series[float] = pa.Field(ge=0)
    close:  Series[float] = pa.Field(ge=0)
    volume: Series[int]   = pa.Field(ge=0)

    class Config:
        strict = True          # reject unexpected columns at the bulk boundary
        coerce = True          # let Pandera/Polars cast dtypes columnar

def transform_data_bulk(raw_rows: list[dict]) -> pl.DataFrame:
    # 1. ONE columnar build + typed cast — no per-row Python object.
    df = pl.DataFrame(raw_rows).with_columns(
        pl.col("date").str.strptime(pl.Date, "%Y-%m-%d"),
        pl.col(["open", "high", "low", "close"]).cast(pl.Float64),
        pl.col("volume").cast(pl.Int64),
    )
    # 2. Schema-level validation on a SAMPLE — vectorized, not row-by-row (see §9e).
    validated = EquityHistoricalSchema.validate(df, sample=10_000, random_state=42, lazy=True)
    return validated     # validated columnar rows, ready for the store's COPY path (§9f)
```

Pandera *"provides runtime validation for DataFrames"* and *"you can define a schema once and use it to
validate different dataframe types including pandas, polars, dask, modin, ibis, and pyspark"*
([Pandera Polars blog](https://www.union.ai/blog-post/pandera-0-19-0-polars-dataframe-validation)). v0.32.0
added a *"Narwhals-powered backend"* for unified validation across polars/ibis/pyspark
([Pandera docs](https://pandera.readthedocs.io/en/stable/)). The `lazy=True` flag *"lazily evaluates
dataframe against all validation checks and raises a `SchemaErrors`"* — collecting **all** column
violations in one report instead of dying on the first
([Pandera `validate()`](https://pandera.readthedocs.io/en/stable/reference/generated/pandera.api.dataframe.model.DataFrameModel.html)),
which is exactly what you want for a backfill triage.

**Keep both schemas in lockstep.** The Pydantic `Data` model (point-read path) and the Pandera
`DataFrameModel` (bulk path) describe the **same standard model** in two engines. They must not drift —
a `close` that's `ge=0` in one and unconstrained in the other is a contract split. Defend it with a
test that introspects both and asserts the same field set + same constraints, or generate one from the
other. This is the F4/F5 negation defense: one logical contract, two physical expressions, mechanically
kept identical.

### 9e. Validate a sample, not every row — the statistics + the API <a name="9e-sample"></a>

The instinct "validate every row or you might miss a bad one" is the per-row trap wearing a safety vest.
At 100M rows, full validation is the cost you're trying to avoid; and you don't need it, because **schema
violations are not needle-in-haystack random — they're systemic.** When a provider changes a unit,
renames a field, or shifts a date format, it does so for **the whole response**, not one row in ten
million. A random sample of a few thousand rows catches a systemic break with near-certainty:

- If even **0.1%** of rows are bad (a tiny systemic fraction), the chance a 10,000-row random sample
  misses *all* of them is `(1 − 0.001)^10000 ≈ e^(−10) ≈ 0.0045%` — you catch it ~99.995% of the time.
- For a true whole-batch break (a renamed column → 100% of rows fail the dtype/coerce), the sample
  catches it on the **first row**.

So the policy is: **dtype/coerce on 100% columnar** (free — the cast either works for the column or
fails the column), **value/range checks on a statistically sufficient sample.** Pandera's `validate()`
signature makes this one argument
([Pandera `validate()`](https://pandera.readthedocs.io/en/stable/reference/generated/pandera.api.dataframe.model.DataFrameModel.html)),
**verbatim**:

```python
validate(check_obj, head=None, tail=None, sample=None, random_state=None, lazy=False, inplace=False)
```

- `sample` — *"validate a random sample of n rows. Rows overlapping with head or tail are de-duplicated."*
- `random_state` — *"random seed for the `sample` argument."* (Pin it so failures are reproducible.)
- `head` / `tail` — *"validate the first/last n rows."* Combine with `sample` to **always** check the
  newest rows (`tail`) plus a random body sample — the newest rows are where a just-changed provider
  contract shows up first.
- `lazy` — *"if True, lazily evaluates dataframe against all validation checks and raises a
  `SchemaErrors`."*

```python
# Belt-and-suspenders sampling policy for a backfill:
EquityHistoricalSchema.validate(
    df,
    head=1_000,        # always check the oldest rows (start-of-series edge)
    tail=1_000,        # always check the newest rows (where a contract change appears first)
    sample=20_000,     # plus a random body sample for systemic-but-partial breaks
    random_state=42,   # reproducible failures
    lazy=True,         # collect every violation, not just the first
)
```

**Don't sample structural checks.** Column existence, dtype, and the `strict`/`coerce` config apply to
the *frame*, not rows — they're always whole-batch and ~free. Sampling is only for the per-value range/
content checks. This split (structure = always, values = sampled) is the whole trick.

### 9f. The validated-rows → store handoff (where TET ends) <a name="9f-handoff"></a>

**This is the clean line.** TET's output at bulk scale is a **validated columnar batch + a provenance
stamp**. What happens next — the hypertable, the upsert key, the `COPY` protocol, chunk routing,
compression — is the **`timescaledb-timeseries`** skill (`patterns-ingestion-upsert.md`,
`patterns-python-connection-layer.md`). TET hands the validated Arrow/Polars frame across the boundary
and **states the contract** the store relies on; it does not perform or re-teach the persistence:

```python
# The handoff. TET produces validated rows + stamp; the STORE skill owns everything after this call.
async def write_path_for_provider(provider_fetcher, query, repo, provenance):
    raw = await provider_fetcher.aextract_data(query, credentials)   # I/O (worker only)
    df = transform_data_bulk(raw["values"])                          # TET: columnar coerce + validate
    df = attach_provenance_columns(df, provenance)                   # TET: stamp commercialOk/source/as_of
    # --- TET ENDS HERE. Everything below is the timescaledb-timeseries skill's COPY/upsert path. ---
    await repo.bulk_upsert_ohlcv(df)        # store skill: COPY into staging + idempotent merge on key
```

The **contract TET guarantees** to the store (so the store's idempotent upsert is sound):
- Every row carries the **natural key** the store dedups on (e.g. `(security_master_id, date, frequency,
  source)`) — TET resolved the security master and stamped the source, so the key is complete.
- Dtypes are already the store's column types (no cast-on-insert).
- The `provenance`/`commercialOk` columns are present and correct **per row** (a CC-BY source carries
  its attribution; a RED fetch-through series is flagged so the store/gateway never redistributes it).
- No fabricated rows: a provider gap is an **absent** row, never a zero/forward-filled invention
  (non-negotiable #1; the `unavailable` path, §8).

What TET explicitly does **not** decide (the store skill owns these): hypertable chunk interval,
compression policy, whether the upsert is `ON CONFLICT DO UPDATE` vs a staging-table merge, continuous
aggregates, retention. Stating that boundary is itself the R-SCALE answer: *the write path's
correctness invariants live in TET; the write path's storage scale lives in the store skill.*

---

## 10. The worker/cron write path: idempotent, off-request <a name="10-worker"></a>

The bulk path **never runs on a user request.** It is the repo's non-negotiable #4 and R-SCALE's
"heavy ingest" rule:

> *"Heavy ingest (e.g. nightly EDGAR XBRL): lives in `worker/` on a cron, not the serverless route…
> State the ingest runtime + partial-failure behavior."*
> ([product-at-scale.md](../../../../.claude/rules/product-at-scale.md))

Mapped to this Python data plane (the plan's committed shape: external cron → `CRON_SECRET` route →
async scheduler, on Fly, never Vercel
([01-plan.md](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md))):

| Property | Requirement | Why |
|---|---|---|
| **Off-request** | Triggered by external cron (`cron-job.org`) hitting a `CRON_SECRET`-guarded route on the Fly worker, which kicks an async job (APScheduler). A user request never starts a backfill. | Non-negotiable #4; a 100M-row job can't run inside a request timeout. |
| **Idempotent** | The store upsert is on the **natural key** (`security_master_id, date, frequency, source`). Re-running the same backfill **overwrites**, never duplicates. | A cron retries; a crash mid-job re-runs the window. Idempotency makes "run it again" safe. |
| **Append-only transaction-time** | Bitemporal: a correction writes a **new** `(valid_time, transaction_time)` row, never an in-place mutate of history. | Reproducible point-in-time reads; an audit of "what did we believe on date X." |
| **Partial-failure = ground-or-skip** | Provider down / over budget → the row/window is **skipped or marked `unavailable`**, never backfilled with a fabricated number. Throw so the cache serves the last-good (the `sentiment-sources.ts` throw-to-serve-stale pattern). | Non-negotiable #1. A gap is honest; a fake number is a finance lie. |
| **Bounded** | One job processes one provider × one window; fan-out is many small jobs, not one unbounded loop. EDGAR fair-access (`User-Agent`, ≤10 req/s) is honored per the provider's ToS. | A throttled upstream (EDGAR, GDELT) bites if you hammer it; small bounded jobs respect the budget. |

**Testing the worker write path** reuses everything above: the Fetcher is tested by §3–§7 with the
network mocked; the **idempotency** is tested by running `bulk_upsert` twice over the same fixture and
asserting the row count is unchanged and values match (a property the store skill owns the SQL for, but
TET's test asserts the *contract* — that two identical batches produce one logical set). The
**partial-failure** path is tested by making the respx mock return a 503 and asserting the job records
`unavailable` and **writes zero fabricated rows**.

```python
@pytest.mark.asyncio
@respx.mock
async def test_partial_failure_writes_no_fabricated_rows(repo_spy):
    respx.get(url__regex=r".*").mock(return_value=httpx.Response(503))
    result = await run_backfill(TreasuryYieldFetcher, window=("2010-01-01", "2010-12-31"),
                                repo=repo_spy)
    assert result.status == "unavailable"        # honest typed failure
    assert repo_spy.rows_written == 0            # NEVER a fabricated/zero-filled backfill
```

---

## 11. A measurement harness: never claim a speedup you didn't measure <a name="11-harness"></a>

The negation loop's evidence mandate and the CTO rules forbid "improves perf by N%" with no harness.
The "per-row → columnar" switch is a real win **only if you measure it on your data**. Ship a tiny,
reproducible benchmark next to the bulk path so the 120 ms→840 ms claim is *your* number, not a recalled
one:

```python
# bench/bench_transform.py  — run with: python -m bench.bench_transform
import time, statistics, json, pathlib
import polars as pl
from dataplane.standard_models import EquityHistoricalData
from dataplane.providers.twelvedata.equity_historical import transform_data_bulk

RAW = json.loads((pathlib.Path(__file__).parent / "100k_rows.json").read_text())["values"]

def per_row_pydantic(rows):
    return [EquityHistoricalData.model_validate(r) for r in rows]   # Tier-1 path

def columnar_pandera(rows):
    return transform_data_bulk(rows)                                # bulk path

def time_it(fn, rows, n=5):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter(); fn(rows); ts.append(time.perf_counter() - t0)
    return statistics.median(ts)

if __name__ == "__main__":
    n = len(RAW)
    pr = time_it(per_row_pydantic, RAW)
    co = time_it(columnar_pandera, RAW)
    print(f"rows={n}")
    print(f"per-row pydantic : {pr*1000:8.1f} ms  ({pr/n*1e6:6.2f} µs/row)")
    print(f"columnar pandera : {co*1000:8.1f} ms  ({co/n*1e6:6.2f} µs/row)")
    print(f"speedup          : {pr/co:6.1f}x")
```

Rules for this harness (so the number is honest):
- **Warm up** (the first run pays import/JIT/allocator costs); report the **median** of N runs, not the
  min or a single run.
- Use a **realistic row shape and count** (100k+), not 10 toy rows — the crossover where columnar wins
  is exactly at scale.
- Report **µs/row**, the scale-invariant number, alongside total — so the reader can extrapolate to 100M
  themselves.
- If columnar is **slower** at your N (it can be, at small N — the batch machinery has fixed setup
  cost), that's the *finding*: it confirms §9b (per-row is right at Tier 1) and tells you where the
  crossover is. Don't bury it.

---

## 12. Anti-patterns quick table <a name="12-anti-patterns"></a>

| # | Anti-pattern | Why it bites | Fix |
|---|---|---|---|
| 1 | **CI tests hit the live provider API** | Flaky, rate-limited, needs a secret in CI, breaks when the vendor is down — and a green bar can mean "we reached the API," not "the mapping is right." | Record once, replay offline; CI in `--record-mode=none` + `--block-network` ([pytest-recording](https://github.com/kiwicom/pytest-recording)). |
| 2 | **Cassette/fixture with a live API key checked in** | Secret leak; "passes locally, fails on CI after a key rotation" ([OpenBB docs](https://docs.openbb.co/odp/python/developer/how-to/tests)). | `filter_headers` + `filter_query_parameters`; CI grep gate for key prefixes in `tests/**`. |
| 3 | **Type-only asserts (`isinstance(r.close, float)`)** | Passes even when `close` reads the *wrong* column — still a float, wrong value. Misses the field a provider silently renamed. | Golden-file value assertions (§5); pin the number, not just the type. |
| 4 | **Testing `transform_data` through the network** | Slow, flaky, and conflates the I/O bug with the mapping bug. Wastes the three-stage boundary. | Test `transform_data` as a pure function on a literal `raw` dict — no cassette (§4). |
| 5 | **"Standard model is the intersection" left as a comment** | The day someone adds a provider that can't produce a required field, it null-fills or fabricates — silently. | The contract test (§7): parametrize over every provider, assert subclass + required-field satisfiability. |
| 6 | **Per-row `model_validate` on the bulk backfill** | The 120 ms→840 ms / 20 GB pathology; O(rows) Python object construction ([02-skills-and-pipeline.md REJECTED](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)). | Columnar coerce (Arrow/Polars) + Pandera schema validation on a sample (§9d–§9e). |
| 7 | **"Validate every row or we'll miss one"** at 100M rows | Re-introduces the per-row cost you're avoiding; schema breaks are systemic, not random — a sample catches them. | `validate(sample=, head=, tail=, random_state=, lazy=True)` ([Pandera](https://pandera.readthedocs.io/en/stable/reference/generated/pandera.api.dataframe.model.DataFrameModel.html)). |
| 8 | **Pydantic model and Pandera schema drift apart** | Two physical contracts for one logical standard model; a constraint in one but not the other is a silent split. | One test asserts both describe the same fields + constraints; or generate one from the other. |
| 9 | **Backfill on the user request path** | A 100M-row job can't fit a request timeout; blocks the read path; violates non-negotiable #4. | Worker/cron + `CRON_SECRET`; reads serve from the store only (§10). |
| 10 | **Provider gap backfilled with 0 / forward-fill to "look complete"** | Fabricated finance number — non-negotiable #1; the negation loop's F1. | Skip or mark `unavailable`; throw-to-serve-stale; absent row, never invented (§8, §10). |
| 11 | **`@pytest.mark.parametrize` over providers but the test only checks the first** | The summary claims "all providers tested"; the diff tests one. The AI tell. | Parametrize the **pair list** so every `(endpoint, provider)` runs and the failure names the provider (§7). |
| 12 | **Claiming the speedup with no harness** | "120ms→840ms" recalled, not measured; fails the evidence mandate. | Ship `bench_transform.py`; report median µs/row on realistic N (§11). |

---

## 13. Output contract checklist <a name="13-checklist"></a>

A Fetcher's test + scale story is "done" only when every box is true:

**Testing**
- [ ] `transform_query` has a pure unit test (right params, rejects bad input) — **no network**.
- [ ] `transform_data` has a pure unit test fed a literal `raw` dict — **no network** — asserting field
      mapping **and** value normalization (units/scale/timezone/sort/null).
- [ ] `extract_data` has a record/replay test: respx fixture (httpx) or `pytest-recording` cassette
      (requests), with **secrets scrubbed**.
- [ ] A **golden file** pins the full standard-model output; CI asserts `transform_data(fixture) ==
      golden`; the golden diff is reviewed on every re-record.
- [ ] `Fetcher.test()` runs the pipeline end-to-end and asserts type + required-field + provenance
      invariants; it's the uniform per-provider gate.
- [ ] The **contract test** parametrizes over every `(endpoint, provider)` pair and asserts subclass +
      required-field satisfiability (the field-intersection law, enforced).
- [ ] Edge cases covered: empty response, error envelope, null-in-required, timezone boundary,
      out-of-order rows — none fabricate a row.
- [ ] CI runs in `--record-mode=none` + `--block-network`; a missed cassette **fails the build**.

**Scale (R-SCALE)**
- [ ] The write path states **which tier it survives and what breaks at the next**, in numbers.
- [ ] Point-read path uses per-row Pydantic (correct at Tier 1); bulk path uses columnar coerce
      (Arrow/Polars) + Pandera schema validation — **no per-row `model_validate` in the bulk loop**.
- [ ] Bulk validation uses `sample=` (+ `head`/`tail`/`random_state`/`lazy=True`), not full-row
      validation; the sampling policy is justified (systemic-not-random breaks).
- [ ] The Pydantic and Pandera schemas are kept in lockstep by a test.
- [ ] TET hands off **validated rows + provenance stamp**; persistence/scale of the store is explicitly
      the `timescaledb-timeseries` skill (the clean line is named, not crossed).
- [ ] The bulk write path is on the worker/cron, **off the request path**, idempotent (upsert on natural
      key), append-only transaction-time, partial-failure = ground-or-skip (never a fabricated number).
- [ ] Any speedup claim is backed by the measurement harness (median µs/row on realistic N), not recalled.

---

## 14. Sources <a name="14-sources"></a>

**OpenBB testing pattern (the IDEA we reimplement clean-room; AGPL — docs read, code not copied)**
- OpenBB Platform — Tests / Fetcher `.test()`, `--record=all`, `@pytest.mark.record_http`, vcrpy YML
  cassettes, `unit_tests_generator.py` / `integration_tests_api_generator.py`, the
  "passes-locally-fails-on-CI / re-record" guidance:
  [docs.openbb.co/odp/python/developer/how-to/tests](https://docs.openbb.co/odp/python/developer/how-to/tests)
  (also referenced as `docs.openbb.co/platform/developer_guide/tests`).
- OpenBB AGPL-3.0-only LICENSE (the reason we reimplement, never vendor):
  [github.com/OpenBB-finance/OpenBB/blob/develop/LICENSE](https://github.com/OpenBB-finance/OpenBB/blob/develop/LICENSE).

**Record/replay tooling (our stack)**
- VCR.py — record modes (`once`/`none`/`new_episodes`/`all`, quoted verbatim), cassette YAML,
  `use_cassette`, `match_on`:
  [vcrpy.readthedocs.io/en/latest/usage.html](https://vcrpy.readthedocs.io/en/latest/usage.html),
  [advanced.html](https://vcrpy.readthedocs.io/en/latest/advanced.html);
  PyPI (v8.0.0 2026-05-25, latest 8.1.1, MIT): [pypi.org/project/vcrpy](https://pypi.org/project/vcrpy/).
- pytest-recording — `@pytest.mark.vcr`, `--record-mode` (default `none`), `vcr_config`,
  `block_network`, cassette naming:
  [github.com/kiwicom/pytest-recording](https://github.com/kiwicom/pytest-recording);
  PyPI (v0.13.4, MIT, `vcrpy>=2.0.1`): [pypi.org/pypi/pytest-recording/json](https://pypi.org/pypi/pytest-recording/json).
- respx — httpx mocking (the `httpx`-path choice), routes/`respx.mock`:
  [github.com/lundberg/respx](https://github.com/lundberg/respx),
  [lundberg.github.io/respx](https://lundberg.github.io/respx/);
  PyPI (v0.23.1, BSD-3-Clause, `httpx>=0.25.0`): [pypi.org/pypi/respx/json](https://pypi.org/pypi/respx/json).

**Bulk schema validation**
- Pandera — `DataFrameModel`/`DataFrameSchema`, `validate(head, tail, sample, random_state, lazy,
  inplace)` (signature + param descriptions quoted verbatim), Polars/pyarrow/Narwhals backends:
  [pandera.readthedocs.io/en/stable](https://pandera.readthedocs.io/en/stable/),
  [DataFrameModel.validate reference](https://pandera.readthedocs.io/en/stable/reference/generated/pandera.api.dataframe.model.DataFrameModel.html),
  [Polars validation blog](https://www.union.ai/blog-post/pandera-0-19-0-polars-dataframe-validation);
  PyPI (v0.32.0, MIT): [pypi.org/project/pandera](https://pypi.org/project/pandera/).

**Pydantic performance (the per-row pathology, grounded)**
- Pydantic v2 performance docs — TypedDict ~2.5x vs nested models, `model_validate_json`, wrap-validator
  materialization, `FailFast`, discriminated unions:
  [pydantic.dev/docs/validation/latest/concepts/performance](https://pydantic.dev/docs/validation/latest/concepts/performance/).
- Pydantic v2 (Rust core, 4–50x over v1): [pydantic.dev/articles/pydantic-v2](https://pydantic.dev/articles/pydantic-v2).

**Project decisions this doc derives from (no new substance added)**
- [`01-plan.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)
  — committed stack: async httpx, Python data plane on Fly, worker/cron write path, Phase 4 Arrow batch
  transport, Phase 5 "avoid per-row Pydantic at 100M rows."
- [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
  — "Per-row Pydantic on bulk paths — REJECTED (the 120ms→840ms pathology)"; verified toolchain +
  licenses; the OpenBB AGPL trap.
- [`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  — pre-mortem #6: "Bulk endpoints melt under Pydantic… 120ms→840ms at scale."
- [`product-at-scale.md`](../../../../.claude/rules/product-at-scale.md) — R-SCALE tiers; "heavy ingest
  lives in worker/ on a cron, not the serverless route; state the ingest runtime + partial-failure
  behavior."
- Repo non-negotiables #1 (never invent a finance number) and #4 (Vercel can't hold sockets/timers →
  worker/cron), from [`CLAUDE.md`](../../../../CLAUDE.md).

**Hand-off (the clean line — persistence/scale of the STORE is not this skill)**
- `timescaledb-timeseries` skill — `patterns-ingestion-upsert.md`,
  `patterns-python-connection-layer.md` (COPY protocol, idempotent upsert, hypertable DDL). TET hands
  off validated rows + stamp; the store owns everything after `bulk_upsert`.