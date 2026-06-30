# Pattern: The Series-Retrieval Endpoint (`GET /series`) — Full Recipe

> **Layer:** `patterns-*` (concrete build recipe — the most-used endpoint, fully specified).
> **Product line:** JPM-Markets re-engineering **data-analytics** product line — the DataQuery/Fusion-class
> market-data platform. **NOT Lumina.** Lumina is a separate repo (Bun + Express + Prisma + Supabase +
> Upstash) that is merely the filesystem home for this research; do not wire any of this Python into
> Lumina's app code.
> **Stack assumption:** Python 3.12+ · FastAPI 0.138.x · Pydantic v2.13.x · Uvicorn 0.49.x (pinned by the
> sibling `python-fastapi-data-service` skill, verified 2026-06). The endpoint reads **from our own store**
> (TimescaleDB continuous aggregates + Parquet/R2 for bulk), never fetch-through to an upstream on a user
> request (committed in `03-dataquery-system-design.md` §"Our system design").
> **Derives from:** the project `/series` contract in
> [`.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)
> §"The query-API contract" — *"series id(s) + from/to range + frequency + aggregation (avg/sum/eop) +
> units transform + asOf (point-in-time vintage) + maxPoints + cursor."* This doc turns that one paragraph
> into every query parameter, default, validation rule, and the exact JSON envelope, with runnable
> FastAPI + Pydantic v2 code.

---

## 0. The on-ramp (plain language, then the rest is dense)

A user picks a series — say "US 10-Year Treasury yield" — and a chart appears. The single request behind
that chart is `GET /series`. It is the most-hit endpoint in the whole product (JPM's DataQuery does ~4
billion hits/year, **75% via the API**, per the dedicated product page fetched in the project's 03 doc;
[jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery)). Everything else — catalog
browse, autocomplete, export — exists to get the user *to* this call. So it has to be exactly right: every
parameter named, every default chosen, every bad input rejected with a clean 400 instead of a 500 or, worse,
a silently-wrong chart.

The shape is not invented. Every production time-series API converges on the same parameter set, because
the same five questions always have to be answered: **which series, over what date range, at what frequency,
transformed how, and as-of when.** This doc copies that contract from the three canonical sources — **FRED**
`series/observations` (the richest public reference for units transforms and point-in-time vintages),
**JPMorgan DataQuery** `/expressions/time-series` (the incumbent we re-engineer, with its 20-expression
batch cap and relative-date arithmetic), and the **World Bank** Indicators API (the cleanest MRV / frequency
model) — and pins each rule to its primary source.

The five things this endpoint must get right, and where each is specified below:

1. **Which series** — `ids` (a list, capped at 20 per request like JPM) → §2.1, §6 batching.
2. **What range** — `from`/`to`, defaulting to earliest/latest, with relative-date arithmetic (`TODAY-1Y`
   like the JPM SDK) → §2.2, §5.
3. **What frequency** — `frequency` (`d/w/bw/m/q/sa/a`) + `aggregation_method` (`avg/sum/eop`), under the
   **hard rule: you can only aggregate to a frequency LOWER than the series' native one** (FRED) → §2.3.
4. **Transformed how** — `units` (`lin/chg/ch1/pch/pc1/pca/cch/cca/log`, FRED's growth codes, with the exact
   formulas) → §2.4.
5. **As-of when** — `asOf` (point-in-time vintage; `realtime_start`/`realtime_end` semantics) → §2.5, §7.

Plus the two scale guards every production system enforces: **`maxPoints`** (the chart tells the API how many
points it can draw; the API never returns more — §2.6) and **cursor pagination** (`cursor`/`limit` for the
raw/table path — §2.7). The response is one envelope: `{data, series_meta, provenance, pagination,
request_echo}` (§4). The worked FastAPI route with Pydantic v2 request/response models is §8.

---

## 1. The contract at a glance (the universal parameter table)

This is the full parameter set, with the **default**, the **allowed values**, and the **primary source** each
rule is copied from. Read it once; the rest of the doc is the detail behind each row.

| Param | Type | Default | Allowed / range | Copied from (primary source) |
|---|---|---|---|---|
| `ids` | `list[str]` | — (required) | 1–**20** ids per request | JPM `EXPR_LIMIT=20` |
| `expression` | `str` (alt) | — | one DataQuery-style expression | JPM `DB(ds,inst,metric)` |
| `from` (`observation_start`) | `str` date / rel | earliest (`1776-07-04`) | `YYYY-MM-DD` or `TODAY-1Y` | FRED + JPM SDK |
| `to` (`observation_end`) | `str` date / rel | latest (`9999-12-31`) | `YYYY-MM-DD` or `TODAY` | FRED |
| `frequency` | `str` | series native | `d w bw m q sa a` (+ FRED extras) | FRED `frequency` |
| `aggregation_method` | `str` | `avg` | `avg sum eop` | FRED `aggregation_method` |
| `units` | `str` | `lin` | `lin chg ch1 pch pc1 pca cch cca log` | FRED `units` |
| `asOf` | `str` date | latest (today) | `YYYY-MM-DD` (point-in-time) | FRED `realtime_*` / `vintage_dates` |
| `realtime_start` | `str` date | today | `YYYY-MM-DD` | FRED |
| `realtime_end` | `str` date | today | `YYYY-MM-DD` | FRED |
| `output_type` | `int` | `1` | `1 2 3 4` | FRED `output_type` |
| `maxPoints` | `int` | **800** (server-enforced) | `1 … 100000` | Grafana HTTP default + project 03 |
| `cursor` | `str \| null` | `null` | opaque (last `id`+`t`) | FRED `next_cursor` |
| `limit` | `int` | `10000` | `1 … 100000` | FRED `limit` (max 100000) |
| `sort_order` | `str` | `asc` | `asc desc` | FRED `sort_order` |

> **One rule binds two of these together and is the most common silent bug:** `maxPoints` (chart
> downsampling) and `frequency` (server-side aggregation) are **both** point-reduction mechanisms, and they
> compose: first aggregate to the requested frequency from the pre-rolled continuous aggregate, *then* LTTB
> down to `maxPoints` if still over. Never apply LTTB to raw ticks when a monthly bucket was asked for — that
> scans data you already paid to pre-aggregate. (Project 03 §"Server-side reductions in `/series` only".)

**Source anchors for the table (all fetched/confirmed this run):**

- FRED `series/observations` parameter set, defaults, and the `limit` max of **100000** —
  [fred.stlouisfed.org/docs/api/fred/series_observations.html](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)
  (403 to a bare fetcher; confirmed via the documented snippets: *"The default value of `limit` is 100000
  and `offset` defaults to 0"*; *"Observation dates default to 1776-07-04 as the earliest available date and
  9999-12-31 as the latest"*; *"`realtime_start` and `realtime_end` … default to today's date"*).
- JPM `EXPR_LIMIT = 20`, the `/expressions/time-series` endpoint, and the param dict (`format`, `start-date`,
  `end-date`, `calendar`, `frequency`, `conversion`, `nan_treatment`, `data`) — read this run from
  [github.com/macrosynergy/macrosynergy](https://github.com/macrosynergy/macrosynergy) `download/dataquery.py`
  (`API_DELAY_PARAM=0.25`, `API_RETRY_COUNT=5`, max 20 expressions/request, pagination via
  `response["links"][1]["next"]`).
- Grafana's HTTP-API `maxDataPoints` default of **800** (vs the UI's pixel-width default) —
  [grafana.com query-transform-data](https://grafana.com/docs/grafana/latest/panels-visualizations/query-transform-data/);
  carried into project 03 §Scale(b) as the gateway-enforced default we adopt.

---

## 2. Every parameter, fully specified

### 2.1 `ids` / `expression` — which series (and the 20-cap)

Two addressing styles, supported side-by-side, because we re-engineer both worlds:

- **`ids: list[str]`** — our canonical series identifiers, resolved against the catalog (FRED-style flat
  ids: `DGS10`, `UNRATE`). This is the common path the dashboard uses.
- **`expression: str`** — a single DataQuery-style structured expression `DB(<dataset>,<instrument>,<metric>)`,
  e.g. `DB(JPMAQS,USD_EQXR_VT10,value)` — the verbatim JPM example confirmed at source in the macrosynergy
  client (project 03 §"The API model"). We accept it for compatibility but normalize it to one or more `ids`
  internally; the response still echoes the expression in `request_echo`.

**The cap: at most 20 ids per request.** This is JPM's `EXPR_LIMIT`, read this run from
`macrosynergy/download/dataquery.py` (the in-package client enforces a default & max batch of **20
expressions**; the standalone `macrosynergy/dataquery-api` client uses the same `EXPR_LIMIT=20`). We adopt 20
not because JPM is magic but because it is the documented batch size for this exact product shape, and an
unbounded `ids` list is a denial-of-service surface (a single request fanning out to 10,000 series scans).

> **Why a per-request cap at all (R-SCALE, Q-D contested/heavy-read).** Without it, one client can request
> the whole catalog in one call — a Tier-1 mistake invisible until a user does it. The cap turns a potential
> full-store scan into a bounded, paginatable unit of work. A client wanting 100 series makes 5 requests of
> 20, each independently cacheable. (Project's `product-at-scale.md` §"Lists".)

Validation: `1 <= len(ids) <= 20`; exactly one of `ids` or `expression` must be present; duplicate ids are
de-duplicated (preserving first-seen order) before the store query.

### 2.2 `from` / `to` — the date range (defaults + relative arithmetic)

- **Names.** We expose `from`/`to` as the public names (clean, short), and accept `observation_start`/
  `observation_end` as FRED-compatible aliases. JPM's wire names are `start-date`/`end-date`
  (`download/dataquery.py`); World Bank uses a single `date=YYYY:YYYY` range.
- **Defaults.** Omitting `from` means **earliest available** for the series; omitting `to` means **latest**.
  FRED encodes these as the sentinel dates `1776-07-04` (earliest) and `9999-12-31` (latest) —
  [series_observations docs](https://fred.stlouisfed.org/docs/api/fred/series_observations.html). We do **not**
  leak sentinels to the client; internally an absent bound becomes the series' actual first/last observation
  date from `series_meta`.
- **Relative dates (the JPM SDK affordance).** The DataQuery surface lets callers express ranges relative to
  today — `TODAY`, `TODAY-1Y`, `TODAY-90D`. We support a small, **closed** grammar (no arbitrary expression
  evaluation — that's an injection surface): `TODAY` and `TODAY{±}{N}{D|W|M|Y}`. `TODAY-1Y` resolves to one
  calendar year before the server's current date; `TODAY-90D` to 90 days before. This mirrors the relative
  windows the JPM SDK and every charting client express ("1Y", "5Y", "MAX" buttons). The resolution happens
  **server-side, once, against the server clock** — never the client clock (the first-come-first-served
  fairness rule: client clocks lie). See §5 for the exact resolver code.

> **Validation, not assumption.** `from > to` after resolution is a **400** (`invalid_range`). A `from` in the
> future is a **400**. A malformed relative token (`TODAY-1X`) is a **400** with the offending token echoed.
> Silent clamping is forbidden — a wrong-but-rendered chart is worse than an error (project F4: "a number/dial
> that misleads").

### 2.3 `frequency` + `aggregation_method` — and the "no upsampling" law

**`frequency` allowed codes** (copied verbatim from FRED `series/observations`, confirmed this run):

| Code | Meaning | | Code | Meaning |
|---|---|---|---|---|
| `d` | Daily | | `wef` | Weekly, ending Friday |
| `w` | Weekly (= `wef`) | | `weth` | Weekly, ending Thursday |
| `bw` | Biweekly | | `wew` | Weekly, ending Wednesday |
| `m` | Monthly | | `wetu` | Weekly, ending Tuesday |
| `q` | Quarterly | | `wem` | Weekly, ending Monday |
| `sa` | Semiannual | | `wesu` | Weekly, ending Sunday |
| `a` | Annual | | `wesa` | Weekly, ending Saturday |
| | | | `bwew` | Biweekly, ending Wednesday |
| | | | `bwem` | Biweekly, ending Monday |

Source: FRED docs, *"one of the following values: 'd', 'w', 'bw', 'm', 'q', 'sa', 'a', 'wef', 'weth', 'wew',
'wetu', 'wem', 'wesu', 'wesa', 'bwew', 'bwem'"*; and *"the value 'w' defaults to … 'Weekly, Ending Friday'
which is the same as 'wef'"*
([series_observations.html](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)).

**For our v1 we ship the core seven** (`d w bw m q sa a`) — those map 1:1 onto TimescaleDB continuous-aggregate
buckets we pre-roll. The weekly-ending-X and biweekly-ending-X variants are accepted-and-validated but may
return `unavailable` if no matching cagg exists yet; we never compute them on-the-fly on a user request.

**`aggregation_method` allowed codes** (FRED): `avg` (average), `sum`, `eop` (end of period). **Default `avg`**
— *"There are 3 aggregation methods … 'avg', 'sum', 'eop' with a default value of 'avg'"*
([FRED docs](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)). `eop` is the right default
for level/price series (you want the close, not the average), but FRED's default is `avg`, so we keep `avg` to
match the contract and let the catalog's `series_meta.default_aggregation` override per series.

**THE LAW: you can only aggregate DOWN, never UP.** FRED, verbatim:

> *"An error will be returned if a frequency is specified that is higher than the native frequency of the
> series. For instance, if a series has the native frequency 'Monthly', it is not possible to aggregate the
> series to the higher 'Daily' frequency."*
> — [series_observations.html](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)

This is not a style choice — it is arithmetic. You cannot fabricate daily observations from a monthly series;
there is no information to invent them (and inventing them violates project non-negotiable #1, "never invent a
finance number"). So `frequency` may only request a frequency **lower-or-equal** to the series' native
frequency. We encode a total order and reject the rest with a **400** (`frequency_too_high`):

```
d (7) > w/bw (6/5) > m (4) > q (3) > sa (2) > a (1)
```

If `rank(requested) > rank(native)` → 400. The native frequency comes from `series_meta.native_frequency`,
read from the catalog — never guessed.

> **Worked rejection.** Series `UNRATE` is native Monthly. Request `frequency=d` → `400
> {"type":"frequency_too_high","detail":"UNRATE is native 'm'; cannot aggregate to higher 'd'","native":"m",
> "requested":"d"}`. Request `frequency=q, aggregation_method=avg` → valid (quarterly average of the monthly
> series, served from the quarterly cagg).

### 2.4 `units` — the growth transforms (with exact formulas)

`units` applies a value transformation. **Default `lin`** (no transform). The full code set and the **exact
formulas** are from the FRED/ALFRED documentation (*"ALFRED growth formulas"*; confirmed this run):

| Code | Name | Formula | Notes |
|---|---|---|---|
| `lin` | Levels (no transform) | `xₜ` | default |
| `chg` | Change | `xₜ − xₜ₋₁` | first difference |
| `ch1` | Change from year ago | `xₜ − xₜ₋ₙ` | `n` = obs/year |
| `pch` | Percent change | `((xₜ / xₜ₋₁) − 1) × 100` | |
| `pc1` | Percent change from year ago | `((xₜ / xₜ₋ₙ) − 1) × 100` | YoY % |
| `pca` | Compounded annual rate of change | `(((xₜ / xₜ₋₁))^n − 1) × 100` | annualizes a period change |
| `cch` | Continuously compounded rate of change | `(ln(xₜ) − ln(xₜ₋₁)) × 100` | log return |
| `cca` | Continuously compounded annual rate | `((ln(xₜ) − ln(xₜ₋₁)) × 100) × n` | annualized log return |
| `log` | Natural log | `ln(xₜ)` | |

Where `xₜ` is the series value at time `t` and **`n` is the number of observations per calendar year**
(`n = 12` for monthly, `n = 4` for quarterly, `n = 252`≈ for daily-business, `n = 1` for annual). Source:
[ALFRED growth formulas](https://alfred.stlouisfed.org/help#growth_formulas) and the
[FRED Add-In User Guide](https://fred.stlouisfed.org/fred-addin/FRED_Addin_User_Guide.pdf) (the formulas as
quoted: *"Change (chg): xt − xt-1 … Compound Annual Rate of Change (pca): (((xt /xt-1))^n – 1) × 100 …
Continuously Compounded Annual Rate (cca): ((ln(xt) – ln(xt-1)) × 100) × n …"*).

Three rules that bite when you implement these:

1. **`n` depends on the FINAL (aggregated) frequency, not the native one.** If you aggregate a daily series to
   monthly and then ask for `pca`, `n = 12`, not 252. Compute the transform *after* aggregation, on the
   monthly grid. (FRED applies units after frequency.)
2. **`ch1`/`pc1` need a full year of lag.** The first `n` observations of the output have no year-ago
   comparator and are **dropped** (or returned `null` per `output_type`/null policy) — never back-filled with
   a fabricated prior. Same for `chg`/`pch` and the first observation.
3. **`log`/`cch`/`cca` require `xₜ > 0`.** A non-positive value makes `ln` undefined. We return that point as
   `null` with a `series_meta.transform_warning`, never `NaN`-serialized-as-`0` (a classic silent corruption;
   project F1/F4).

These transforms are **pure functions of the already-fetched grounded series** — they do not call upstream,
so they live in the data plane's compute step, not a tool. (They are deterministic post-processing, exactly
the kind of thing project F5 says belongs in the data plane, not a "tool" that fetches.)

### 2.5 `asOf` / `realtime_start` / `realtime_end` — point-in-time vintages

This is the parameter that separates a real markets-data API from a toy. Economic and market data get
**revised**: the GDP print you saw in Jan-2024 is not the GDP value the same date shows today. A point-in-time
(PIT) / "vintage" query asks: *"what did this series look like as it was known on date D?"* — essential for
backtesting (using a revised number you couldn't have known is look-ahead bias; project's `trading-systems`
skill flags look-ahead as a cardinal backtest sin).

FRED models this with the **real-time period**, a `(realtime_start, realtime_end)` closed-closed interval:

> *"The real-time period marks when facts were true or when information was known until it changed … The
> real-time period set by `realtime_start` and `realtime_end` is a (closed, closed) period."*
> — [FRED realtime_period docs](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html)

Both default to **today** — i.e. "give me the latest revision," the common case.

We expose a single friendly **`asOf`** (a date) that is sugar for `realtime_start = realtime_end = asOf`
("the series as it was known on `asOf`"), and also accept raw `realtime_start`/`realtime_end` for the FRED
power case. The store side is **bitemporal**: every observation row carries a `valid_time` (the observation
date `t`) and a `transaction_time` (when we ingested/learned that value). An `asOf=D` query filters
`transaction_time <= D` and takes, per `t`, the latest row — the standard bitemporal "as-of" select. This is
the same Security-Master bitemporal crosswalk the project commits to in 03 §"Data plane".

**`output_type`** controls how vintages collapse into the response (FRED, confirmed this run —
*"1 (observations by real-time period), 2 (… all observations), 3 (… new and revised observations only),
4 (observations, initial release only)"*,
[series_observations.html](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)):

| `output_type` | Meaning | Use case |
|---|---|---|
| `1` (default) | Observations **by real-time period** — one value per date, as known in `[realtime_start, realtime_end]` | the normal chart |
| `2` | **All** observations across all vintages (the full revision history) | revision analysis |
| `3` | **New and revised** observations only | "what changed since" feeds |
| `4` | **Initial release only** — first-printed value, never revised | clean backtest input (no look-ahead) |

`output_type=4` is the one quants reach for: it gives the number as first published, which is what you could
actually have traded on. We implement `1` and `4` for v1 (the two with the highest decision value) and accept
`2`/`3` as validated-but-may-`unavailable` until the full vintage history is materialized.

> **Why this earns its place (project F4 "metric in a costume" defense).** A PIT/vintage capability is not a
> dashboard decoration — it changes the answer. Without `output_type=4`, every backtest built on the API has
> look-ahead bias baked in and its results are fiction. *Who reads this and what do they do differently?* A
> quant building a strategy reads the initial-release vintage and avoids trading on numbers that didn't exist
> yet. That is a real, load-bearing decision, which is why we build the bitemporal store rather than serving
> only "latest."

### 2.6 `maxPoints` — the chart-downsampling cap (the load-bearing scale rule)

The single most important scale parameter. **The chart tells the API how many points it can draw (its pixel
width), and the API never returns more.** A 20-year daily series is ~5,000 points; a 4K-wide panel can draw
~3,840 of them, and an `<svg>` with one DOM node per point degrades long before that. Shipping all 5,000 to
the browser is a Tier-1 mistake that every production system avoids by **server-side downsampling**.

- **Default: 800** — server-enforced. The dashboard panel sends its real pixel width; a direct API caller who
  omits `maxPoints` gets 800, not "unbounded." This default is Grafana's HTTP-API `maxDataPoints`
  ([grafana.com query-transform-data](https://grafana.com/docs/grafana/latest/panels-visualizations/query-transform-data/)),
  carried into project 03 §Scale(b) precisely because *"a direct HTTP-API call defaults to no cap, so our
  gateway must enforce a default `maxPoints` server-side (≈800)."*
- **Range: `1 … 100000`.** Above 100000 is a 400 (you don't draw a 100k-point chart; that's a bulk export,
  which goes to the Parquet/R2 path off the request — project 03 §"Bulk export").
- **Method: LTTB** (Largest-Triangle-Three-Buckets, Steinarsson 2013) — shape-preserving, so spikes survive
  the reduction, unlike naive every-Nth or average ([pypi.org/project/lttb](https://pypi.org/project/lttb/)).
  Applied **after** frequency aggregation, **only if** the post-aggregation point count still exceeds
  `maxPoints`. If a monthly request already yields ≤ `maxPoints` rows, no LTTB runs.

The response echoes both `series_meta.raw_point_count` (before downsampling) and the returned count, and sets
`series_meta.downsampled = true/false`, so the client knows whether it's looking at every point or a
shape-preserving sample.

### 2.7 `cursor` / `limit` / `sort_order` — pagination for the raw/table path

The chart path uses `maxPoints`; the **table** path (a user scrolling raw observations) uses cursor
pagination. FRED uses an opaque `next_cursor`:

> *"You should not set `next_cursor` on the first request … On subsequent requests, set `next_cursor` to the
> value in the previous response … The `next_cursor` value is a combination of the last `series_id` and
> observation date retrieved."*
> — [FRED series_observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)

We copy this exactly: `cursor` is **opaque** (base64 of `{last_id, last_t}`), keyset-based (NOT offset — an
offset paginator re-scans every prior row and drifts when data changes underneath it). `limit` defaults to
**10000**, max **100000** (FRED's max; *"The default value of `limit` is 100000"* — we choose a smaller
page default of 10000 for the table path and keep 100000 as the ceiling). `sort_order` is `asc` (default) or
`desc`.

> **Keyset, not offset (R-SCALE, why it matters).** `LIMIT … OFFSET 50000` makes Postgres/Timescale read and
> discard 50,000 rows every page — O(n²) over a full scroll. A keyset cursor (`WHERE (id, t) > (last_id,
> last_t) ORDER BY id, t LIMIT n`) reads exactly `n` rows per page off the `(id, t)` index, regardless of
> depth. This is the difference between a table that stays fast at page 1000 and one that times out. (Project
> `product-at-scale.md` §"Lists" — "server-side filter + paginate + index the sorted columns.")

---

## 3. The DataQuery-expression compatibility surface

For callers migrating off JPM DataQuery, we accept the `expression` form and the JPM wire param names as
aliases. The mapping (JPM wire name → our canonical), read this run from `macrosynergy/download/dataquery.py`:

| JPM wire param | JPM default | Our canonical | Note |
|---|---|---|---|
| `expressions` (List[str]) | — | `ids` / `expression` | the 20-cap applies |
| `start-date` | `"2000-01-01"`* | `from` | *client default; our default is earliest |
| `end-date` | `None` (→ latest) | `to` | |
| `calendar` | `CAL_ALLDAYS` | (store calendar) | trading-calendar handled store-side |
| `frequency` | `FREQ_DAY` | `frequency=d` | JPM uses `FREQ_*` enum strings |
| `conversion` | `CONV_LASTBUS_ABS` | `aggregation_method` | last-business-day ≈ `eop` |
| `nan_treatment` | `NA_NOTHING` | (null policy) | how gaps render |
| `data` (`reference_data`) | `NO_REFERENCE_DATA` | `output_type`-ish | metadata inclusion |
| `format` | `JSON` | — | we are JSON-only |

Source: the `params_dict` construction in `download/dataquery.py` (`{"format":"JSON","start-date":...,
"end-date":...,"calendar":...,"frequency":...,"conversion":...,"nan_treatment":...,"data":...}`) and the
`download_data(...)` signature defaults (`start_date="2000-01-01"`, `calendar="CAL_ALLDAYS"`,
`frequency="FREQ_DAY"`, `conversion="CONV_LASTBUS_ABS"`, `nan_treatment="NA_NOTHING"`,
`reference_data="NO_REFERENCE_DATA"`), both read this run from
[github.com/macrosynergy/macrosynergy](https://github.com/macrosynergy/macrosynergy).

> **We do NOT re-expose JPM's `FREQ_*`/`CONV_*` enum vocabulary** to our clients — those are JPM's internal
> strings. We expose the FRED-style short codes (`d/m/q`, `avg/sum/eop`) which are the cleaner, more widely
> understood contract, and translate `expression`-form requests internally. The compatibility layer is a thin
> alias map, not a second parameter system.

---

## 4. The response envelope (fully specified)

One envelope, the same shape for one series or many. This is the contract the dashboard's `useDataQuery`
hook and the table render against (project 03 §"Generic parameterized fetch hook").

```jsonc
{
  "data": [
    {
      "id": "DGS10",
      "points": [
        { "t": "2024-01-02", "v": 3.95 },
        { "t": "2024-01-03", "v": 3.91 },
        { "t": "2024-01-04", "v": null }   // a real gap — null, never fabricated
      ]
    }
    // ... one entry per requested id (≤ 20)
  ],
  "series_meta": [
    {
      "id": "DGS10",
      "title": "Market Yield on U.S. Treasury Securities at 10-Year Constant Maturity",
      "native_frequency": "d",
      "returned_frequency": "d",
      "aggregation_method": "avg",
      "units": "lin",
      "unit_label": "Percent",
      "as_of": "2026-06-24",
      "output_type": 1,
      "raw_point_count": 5113,
      "returned_point_count": 800,
      "downsampled": true,
      "downsample_method": "lttb",
      "observation_start": "1962-01-02",
      "observation_end": "2026-06-23",
      "transform_warning": null
    }
  ],
  "provenance": [
    {
      "id": "DGS10",
      "source": "US Treasury (via FRED H.15)",
      "fetch_path": "fred:DGS10",
      "commercialOk": true,
      "license": "public-domain (US-gov, 17 USC §105)",
      "attribution": "U.S. Department of the Treasury",
      "retrieved_at": "2026-06-24T03:00:00Z"
    }
  ],
  "pagination": {
    "next_cursor": "eyJpZCI6IkRHUzEwIiwidCI6IjIwMjQtMDEtMDQifQ==",
    "has_more": false,
    "limit": 10000
  },
  "request_echo": {
    "ids": ["DGS10"],
    "from": "1962-01-02",
    "to": "2026-06-23",
    "frequency": "d",
    "aggregation_method": "avg",
    "units": "lin",
    "as_of": "2026-06-24",
    "output_type": 1,
    "max_points": 800
  }
}
```

The five top-level keys, and why each exists:

- **`data`** — the actual series, one entry per id, each a list of `{t, v}` points. `t` is ISO `YYYY-MM-DD`
  (or full ISO timestamp for intraday); `v` is the (possibly transformed) value or `null` for a real gap.
  This is the only key the chart needs.
- **`series_meta`** — one metadata object per id: title, the frequencies (native vs returned — so the client
  can show "monthly" honestly), the transform applied, point counts before/after downsampling, and any
  `transform_warning`. **`downsampled`/`raw_point_count` are not optional** — they tell the client whether it
  is seeing every point (project F4: don't dress a sample as the full series without saying so).
- **`provenance`** — one per id, carrying the **`commercialOk` gate** (default `false`), the `fetch_path` the
  license attaches to (the license attaches to the fetch path, not the concept — `commercial-ok-gate.md`),
  the `license` string, and the `attribution` the surface must render. This is **mandatory on every series**;
  a response without it is a build bug. (Project non-negotiable #2.)
- **`pagination`** — `next_cursor` (opaque, `null` when exhausted), `has_more`, and the page `limit`. Present
  on the raw/table path; on the chart path `has_more` is `false` (downsampling returns the whole window).
- **`request_echo`** — the **resolved** parameters the server actually used (relative dates resolved to
  absolute, defaults filled in, frequency validated). This lets the client build a stable cache key / permalink
  and see exactly what it got. (FRED echoes the request block similarly.)

> **One source of truth per value (project battery "Data & flow").** The client must never re-derive
> `from`/`to`/`frequency` from its own inputs — it reads them from `request_echo`. If the server clamped or
> resolved anything, the echo is the truth, and the chart labels off the echo, not the request. This kills the
> class of bug where the UI says "1Y" but the server returned "MAX."

---

## 5. Relative-date arithmetic (`TODAY-1Y`) — the resolver

The JPM SDK and every charting client express ranges relative to now ("1Y", "5Y"). We support a **closed
grammar** — `TODAY` optionally followed by `±N{D|W|M|Y}` — resolved server-side against the server clock. No
`eval`, no arbitrary expressions (that would be an injection surface).

```python
# relative_dates.py
from __future__ import annotations
import re
from datetime import date
from dateutil.relativedelta import relativedelta  # python-dateutil, calendar-correct month/year math

_REL = re.compile(r"^TODAY(?:([+-])(\d+)([DWMY]))?$", re.IGNORECASE)
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

class DateParseError(ValueError):
    """Raised on a malformed date token; the route turns this into a 400."""

def resolve_date(token: str, *, today: date | None = None) -> date:
    """
    Resolve a date token to an absolute date.

    Accepts:
      - ISO 'YYYY-MM-DD'                      -> that date
      - 'TODAY'                              -> server today
      - 'TODAY-1Y' / 'TODAY+90D' / 'TODAY-6M' -> relative to server today
    Units: D=days, W=weeks, M=calendar months, Y=calendar years.
    Resolution is against the SERVER clock (never the client's) — fairness rule.
    """
    today = today or date.today()
    token = token.strip()

    if _ISO.match(token):
        try:
            return date.fromisoformat(token)
        except ValueError as exc:                       # e.g. 2024-13-40
            raise DateParseError(f"not a valid date: {token!r}") from exc

    m = _REL.match(token)
    if not m:
        raise DateParseError(
            f"unrecognized date token {token!r}; expected 'YYYY-MM-DD' or 'TODAY[±N{{D|W|M|Y}}]'"
        )
    sign, num, unit = m.groups()
    if sign is None:                                    # bare 'TODAY'
        return today
    n = int(num) * (1 if sign == "+" else -1)
    unit = unit.upper()
    delta = {
        "D": relativedelta(days=n),
        "W": relativedelta(weeks=n),
        "M": relativedelta(months=n),   # calendar months (Jan-31 - 1M -> Dec-31, not Dec-01)
        "Y": relativedelta(years=n),    # calendar years  (leap-safe)
    }[unit]
    return today + delta
```

Why `dateutil.relativedelta` and not `timedelta`: `timedelta` has no concept of "one calendar month/year" —
`timedelta(days=365)` is wrong across a leap year, and there is no `timedelta(months=1)`. `relativedelta`
does calendar-correct month/year arithmetic, which is what "1Y" means to a user
([dateutil docs](https://dateutil.readthedocs.io/en/stable/relativedelta.html)). It is a single small,
well-maintained dependency.

Edge cases the resolver handles:

- `TODAY-1Y` on `2024-02-29` (leap day) → `2023-02-28` (`relativedelta` clamps to the last valid day; no
  exception, no Feb-29-2023).
- `TODAY+0D` → today (sign present, n=0 — valid, returns today).
- Case-insensitive (`today-1y` works) but we recommend the uppercase canonical form in docs.
- A token like `TODAY-1X` (bad unit) → `DateParseError` → **400** with the token echoed.

---

## 6. Multi-series request batching

`ids` accepts 1–20 series. Internally the route resolves all 20 against the store in **one** set-based query
(a single `WHERE id = ANY($1) AND t BETWEEN ...` against the appropriate continuous-aggregate hypertable),
**not** a loop of 20 single-series queries (which would be 20 round-trips — a classic N+1).

Per-series independence in the response: if 19 ids resolve and 1 is unknown, the response returns the 19 with
data and the 20th with an empty `points` list plus a `series_meta` entry whose `transform_warning` (or a
dedicated `status`) says `unknown_id`. **One bad id does not 400 the whole request** — partial success is the
correct behavior for a batch (the same discipline as a batch-quote endpoint). A request where *all* ids are
unknown returns 200 with empty data and per-id `unknown_id` statuses, not a 404 (the request was well-formed;
the data just isn't there — `unavailable`, not "bad request").

Downsampling and unit transforms apply **per series** (each series has its own native frequency and point
count), so `maxPoints=800` means "≤800 points **per series**," and a 5-series request can return up to 4,000
points total — which is fine, because the binding constraint is per-chart-panel point density, and each series
is one line on the panel.

> **Cache keying (R-SCALE, read-spike).** The Redis cache key for a `/series` response is the **fully-resolved**
> parameter tuple: `sha1(sorted(ids) | from | to | frequency | agg | units | asOf | output_type | maxPoints)`.
> Because relative dates are resolved first, `TODAY-1Y` requested twice in the same day hits the same key —
> compute-once-serve-many. The cron-warmer pre-computes the popular windows (1Y/5Y daily of the top series)
> into Redis so the spike-day first request is already warm (project 03 §Scale(b); reuse `cache.ts`
> `getOrRefresh`). The key MUST include everything that changes the output, or you serve a stale/wrong series
> (project battery: "is the cache keyed by everything that changes the output").

---

## 7. Validation rules → the exact 400s

Every bad input must produce a clean, specific **400** (FastAPI/Pydantic give this for free on type/constraint
violations; the cross-field rules need a `model_validator`). The full rejection table:

| Condition | HTTP | `type` | Detail |
|---|---|---|---|
| `len(ids) == 0` or `> 20` | 400 | `ids_count` | "1–20 ids per request" |
| both `ids` and `expression`, or neither | 400 | `addressing` | "supply exactly one of ids/expression" |
| `frequency` not in allowed set | 422→400 | `enum` | Pydantic enum error |
| `frequency` higher than native | 400 | `frequency_too_high` | echoes native+requested |
| `aggregation_method` ∉ {avg,sum,eop} | 422→400 | `enum` | |
| `units` ∉ the 9 codes | 422→400 | `enum` | |
| `from`/`to`/`asOf` unparseable | 400 | `bad_date` | echoes the token |
| resolved `from > to` | 400 | `invalid_range` | |
| `from` in the future | 400 | `future_start` | |
| `maxPoints` < 1 or > 100000 | 422→400 | `range` | |
| `limit` > 100000 | 422→400 | `range` | FRED's max |
| `output_type` ∉ {1,2,3,4} | 422→400 | `enum` | |
| unknown query param (typo) | 422→400 | `extra_forbidden` | Pydantic `extra="forbid"` |

> **Note on 422 vs 400.** FastAPI's default for a request-validation failure is **422 Unprocessable Entity**.
> Many teams (and the JPM/FRED contracts) prefer **400** for client errors. We install a small exception
> handler that re-maps `RequestValidationError` → 400 with the same body, so the whole surface speaks one
> client-error code. Either is defensible; pick one and be consistent (shown in §8).

The `extra="forbid"` config is the unsung hero: a client that sends `?frequencey=m` (typo) gets a clear
`extra_forbidden` error naming `frequencey`, instead of silently getting the default `frequency` and a
wrong-but-rendered chart. *"If a client sends `?limit=10&tool=plumbus`, they receive an error … `extra_forbidden`
… 'Extra inputs are not permitted'"* — [FastAPI query-param-models docs](https://fastapi.tiangolo.com/tutorial/query-param-models/).

---

## 8. The worked FastAPI route (Pydantic v2 request + response models)

Putting it all together: the request model (as a `Query()` dependency, FastAPI ≥ 0.115.0), the response
models, the cross-field validators, the frequency-rank law, and the `maxPoints` default **enforced server-side**.
Targets the pinned stack (Python 3.12+, FastAPI 0.138.x, Pydantic 2.13.x).

```python
# series_models.py
from __future__ import annotations
from datetime import date
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, ConfigDict, model_validator

from relative_dates import resolve_date, DateParseError  # §5

# ---- enums (single source of truth for the allowed values) ------------------

class Frequency(str, Enum):
    d = "d"; w = "w"; bw = "bw"; m = "m"; q = "q"; sa = "sa"; a = "a"
    # FRED weekly/biweekly-ending variants accepted but cagg-gated:
    wef = "wef"; weth = "weth"; wew = "wew"; wetu = "wetu"
    wem = "wem"; wesu = "wesu"; wesa = "wesa"; bwew = "bwew"; bwem = "bwem"

# Total order: higher rank = higher (finer) frequency. Used for the no-upsample law.
_FREQ_RANK: dict[str, int] = {
    "d": 7, "w": 6, "wef": 6, "weth": 6, "wew": 6, "wetu": 6,
    "wem": 6, "wesu": 6, "wesa": 6,
    "bw": 5, "bwew": 5, "bwem": 5,
    "m": 4, "q": 3, "sa": 2, "a": 1,
}

class Aggregation(str, Enum):
    avg = "avg"; sum = "sum"; eop = "eop"

class Units(str, Enum):
    lin = "lin"; chg = "chg"; ch1 = "ch1"; pch = "pch"; pc1 = "pc1"
    pca = "pca"; cch = "cch"; cca = "cca"; log = "log"

# ---- the request model (used as a Query() dependency) -----------------------

MAX_IDS = 20            # JPM EXPR_LIMIT
DEFAULT_MAX_POINTS = 800  # Grafana HTTP default; gateway-enforced
MAX_POINTS_CEIL = 100_000
LIMIT_CEIL = 100_000     # FRED's limit max
DEFAULT_LIMIT = 10_000

class SeriesQuery(BaseModel):
    # forbid unknown query params so a typo is a 400, not a silent default
    model_config = ConfigDict(extra="forbid")

    ids: list[str] = Field(default_factory=list, max_length=MAX_IDS,
                           description="1–20 canonical series ids")
    expression: str | None = Field(default=None,
                                   description="alt: one DataQuery-style DB(ds,inst,metric)")

    # dates as raw tokens; resolved in the validator (ISO or TODAY±N{D|W|M|Y})
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    as_of: str | None = Field(default=None, alias="asOf")

    frequency: Frequency | None = None             # None => series native
    aggregation_method: Aggregation = Aggregation.avg
    units: Units = Units.lin
    output_type: Literal[1, 2, 3, 4] = 1

    max_points: int = Field(default=DEFAULT_MAX_POINTS, ge=1, le=MAX_POINTS_CEIL,
                            alias="maxPoints")
    limit: int = Field(default=DEFAULT_LIMIT, ge=1, le=LIMIT_CEIL)
    sort_order: Literal["asc", "desc"] = Field(default="asc", alias="sortOrder")
    cursor: str | None = None

    # ----- resolved (filled by the validator; not client-supplied) -----
    resolved_from: date | None = Field(default=None, exclude=True)
    resolved_to: date | None = Field(default=None, exclude=True)
    resolved_as_of: date | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def _validate(self) -> "SeriesQuery":
        # 1) addressing: exactly one of ids / expression
        has_ids = bool(self.ids)
        has_expr = self.expression is not None
        if has_ids == has_expr:  # both or neither
            raise ValueError("addressing: supply exactly one of 'ids' or 'expression'")
        if has_ids and len(self.ids) < 1:
            raise ValueError("ids_count: 1–20 ids per request")
        # de-dup ids preserving order
        if has_ids:
            seen: set[str] = set()
            self.ids = [i for i in self.ids if not (i in seen or seen.add(i))]

        # 2) resolve dates (raises DateParseError -> 400 via the handler)
        today = date.today()
        self.resolved_from = resolve_date(self.from_, today=today) if self.from_ else None
        self.resolved_to = resolve_date(self.to, today=today) if self.to else None
        self.resolved_as_of = resolve_date(self.as_of, today=today) if self.as_of else today

        # 3) cross-field range checks
        if self.resolved_from and self.resolved_from > today:
            raise ValueError("future_start: 'from' is in the future")
        if (self.resolved_from and self.resolved_to
                and self.resolved_from > self.resolved_to):
            raise ValueError("invalid_range: 'from' is after 'to'")
        return self

    def assert_freq_not_higher_than(self, native: str) -> None:
        """The no-upsample law (FRED). Call once native frequency is known."""
        if self.frequency is None:
            return
        if _FREQ_RANK[self.frequency.value] > _FREQ_RANK[native]:
            raise FrequencyTooHigh(native=native, requested=self.frequency.value)


class FrequencyTooHigh(Exception):
    def __init__(self, native: str, requested: str) -> None:
        self.native, self.requested = native, requested
        super().__init__(f"cannot aggregate '{native}' up to '{requested}'")

# ---- response models --------------------------------------------------------

class Point(BaseModel):
    t: str                      # ISO date or datetime
    v: float | None             # null for a real gap — never fabricated

class SeriesData(BaseModel):
    id: str
    points: list[Point]
    status: Literal["ok", "unknown_id", "unavailable"] = "ok"

class SeriesMeta(BaseModel):
    id: str
    title: str | None = None
    native_frequency: str
    returned_frequency: str
    aggregation_method: str
    units: str
    unit_label: str | None = None
    as_of: date
    output_type: int
    raw_point_count: int
    returned_point_count: int
    downsampled: bool
    downsample_method: Literal["lttb", "none"] = "none"
    observation_start: date | None = None
    observation_end: date | None = None
    transform_warning: str | None = None

class Provenance(BaseModel):
    id: str
    source: str
    fetch_path: str
    commercialOk: bool = False          # DEFAULT FALSE — the gate
    license: str | None = None
    attribution: str | None = None
    retrieved_at: str | None = None

class Pagination(BaseModel):
    next_cursor: str | None = None
    has_more: bool = False
    limit: int = DEFAULT_LIMIT

class SeriesResponse(BaseModel):
    data: list[SeriesData]
    series_meta: list[SeriesMeta]
    provenance: list[Provenance]
    pagination: Pagination
    request_echo: dict
```

The route itself, with the 422→400 remap and the `maxPoints` default already enforced by the model:

```python
# series_route.py
from typing import Annotated
from fastapi import FastAPI, Query, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from series_models import (
    SeriesQuery, SeriesResponse, FrequencyTooHigh,
)
from relative_dates import DateParseError
from store import fetch_series  # reads TimescaleDB cagg + applies units + LTTB

app = FastAPI(title="DataQuery Series API")

# --- error handlers: one client-error code (400) across the surface ---------

@app.exception_handler(RequestValidationError)
async def _validation_to_400(_: Request, exc: RequestValidationError):
    # Pydantic enum/range/extra_forbidden -> 400 (not FastAPI's default 422)
    return JSONResponse(status_code=400, content={"errors": exc.errors()})

@app.exception_handler(DateParseError)
async def _bad_date_to_400(_: Request, exc: DateParseError):
    return JSONResponse(status_code=400, content={"type": "bad_date", "detail": str(exc)})

@app.exception_handler(FrequencyTooHigh)
async def _freq_too_high_to_400(_: Request, exc: FrequencyTooHigh):
    return JSONResponse(
        status_code=400,
        content={"type": "frequency_too_high", "native": exc.native,
                 "requested": exc.requested,
                 "detail": f"cannot aggregate native '{exc.native}' up to '{exc.requested}'"},
    )

# --- the endpoint ------------------------------------------------------------

@app.get("/series", response_model=SeriesResponse)
async def get_series(q: Annotated[SeriesQuery, Query()]) -> SeriesResponse:
    """
    The series-retrieval endpoint. Reads from our store (TimescaleDB continuous
    aggregates + Parquet for bulk), NEVER fetch-through to an upstream on a user
    request (project non-negotiable #4 + 03 §"read from store only").

    Reductions happen here and ONLY here, in order:
      1. point-in-time / asOf vintage select (bitemporal: transaction_time <= asOf)
      2. frequency aggregation (serve the pre-rolled cagg bucket; no raw scan)
      3. units transform (the FRED growth formulas — pure post-processing)
      4. LTTB downsample to max_points (only if still over after step 2)
    Every series carries a Provenance{commercialOk} (default false).
    """
    # store layer resolves ids/expression, enforces the no-upsample law per series
    # (calls q.assert_freq_not_higher_than(native) for each), applies steps 1–4,
    # and stamps provenance from the fetch-path ledger.
    result = await fetch_series(q)        # returns a SeriesResponse-shaped object

    # the echo reflects the RESOLVED params (relative dates -> absolute, defaults filled)
    result.request_echo = {
        "ids": q.ids or None,
        "expression": q.expression,
        "from": q.resolved_from.isoformat() if q.resolved_from else None,
        "to": q.resolved_to.isoformat() if q.resolved_to else None,
        "frequency": q.frequency.value if q.frequency else None,
        "aggregation_method": q.aggregation_method.value,
        "units": q.units.value,
        "as_of": q.resolved_as_of.isoformat() if q.resolved_as_of else None,
        "output_type": q.output_type,
        "max_points": q.max_points,
        "limit": q.limit,
        "sort_order": q.sort_order,
    }
    return result
```

Notes on the code, tied to the rules:

- **`maxPoints` default is in the model** (`Field(default=800, ...)`), so a direct API caller who omits it is
  capped at 800 — the gateway-enforced default from project 03. The dashboard always sends its real pixel
  width; the default protects the raw-HTTP path.
- **`extra="forbid"`** (`ConfigDict`) turns a query-param typo into a 400 `extra_forbidden`, per the FastAPI
  docs. This is the cheapest defense against the silent-wrong-chart class.
- **`alias="from"` / `alias="asOf"` / `alias="maxPoints"`** — `from` is a Python keyword so the field is
  `from_`; aliases let the wire use the clean names. (Pydantic v2 `Field(alias=...)`.)
- **The no-upsample law lives in `assert_freq_not_higher_than`**, called by the store layer once the native
  frequency is known (it isn't known at parse time — it comes from the catalog). This is the one validation
  that can't be a pure Pydantic constraint because it needs `series_meta`.
- **`v: float | None`** — a gap is `null`, never `0` or a fabricated value (non-negotiable #1; the FRED `.`
  missing-value convention maps to `null`).
- **`commercialOk: bool = False`** — the gate defaults closed; the store stamps `true` only for a GREEN
  fetch path with attribution (project non-negotiable #2 + `commercial-ok-gate.md`).

---

## 9. R-SCALE: the tier this endpoint survives, and what breaks next

`/series` is a **read-spike + point-volume** scale surface. The honest tiering (project `product-at-scale.md`):

| Tier | Load | Survives? | Mechanism / break |
|---|---|---|---|
| **1×** | one series, few-hundred points, 1 user | ✅ trivially | direct cagg read, no downsample needed |
| **100×** | 20-year daily (~5k pts), 20-id batch, thousands of users | ✅ | **frequency aggregation from continuous aggregates** (no raw scan) + **LTTB to `maxPoints`** + **Redis `getOrRefresh`** (compute-once-serve-many) + **keyset cursor** for the table path. Every filter/sort column (`id`, `t`) indexed. |
| **10,000×** | 130m-series store, multi-decade multi-series, lakhs concurrent, spike day | ✅ store-side / ⚠️ render at extreme N | **Store:** continuous aggregates (only changed chunks recompute) + Hypercore columnar compression; serves pre-rolled buckets, never a raw-tick scan. **Read:** reads scale independently of writes (write path is a separate Fly worker; non-negotiable #4). Cron-warm the popular windows. **Bulk** export (whole-series) → Parquet/R2 off the request, never streamed point-by-point. **Break point:** render-side SVG at very high N → canvas/WebGL + async-load-per-zoom (the same `maxPoints`-per-viewport loop). |

**The single load-bearing rule, restated:** *the API never returns more points than the chart can draw.* The
chart sends `maxPoints`; the server downsamples to it. Without this, a spike day of users each pulling 5k-point
series melts the serialization + transfer + browser-render path — the exact Tier-1-believed-Tier-3 failure the
project's R-SCALE rule exists to prevent. (Project 03 §Scale(b).)

---

## 10. Anti-patterns specific to this endpoint

| Mistake | Why it's wrong | Fix |
|---|---|---|
| No `maxPoints` cap on the raw-HTTP path | a caller pulls an unbounded series; melts the transfer/render path at scale | server-enforced default 800 (Grafana); ceiling 100000 (§2.6) |
| Allowing upsampling (`frequency` finer than native) | fabricates observations that don't exist → violates non-negotiable #1 | the rank check + `frequency_too_high` 400 (§2.3) |
| Computing `units` transform on the native grid, then aggregating | wrong `n`, wrong YoY base; numbers are subtly wrong | aggregate first, transform on the final grid; `n` from returned frequency (§2.4) |
| Back-filling the first `n` points of `ch1`/`pc1` | invents a year-ago comparator that doesn't exist | drop or `null` the lead-in points; never fabricate (§2.4) |
| `OFFSET`-based pagination on the table path | O(n²) full re-scan per page; drifts under concurrent writes | opaque keyset `cursor` over `(id, t)` index (§2.7) |
| 422 for some client errors, 400 for others | inconsistent surface; clients can't handle errors uniformly | remap `RequestValidationError` → 400 (§8) |
| Looping 20 single-series store queries | N+1 round-trips | one `id = ANY($ids)` set query (§6) |
| One bad id → 400 the whole batch | a 20-series request fails because of one typo | partial success: per-id `status: unknown_id`, 200 overall (§6) |
| `commercialOk` defaulting `true` or omitted | mis-licenses a series; legal exposure (non-negotiable #2) | default `false`; `true` only for a GREEN fetch path with attribution (§4) |
| Echoing the *requested* params, not the *resolved* ones | client labels a chart "1Y" when it got "MAX" | `request_echo` carries resolved absolute dates + filled defaults (§4) |
| Resolving `TODAY-1Y` against the client clock | client clocks lie/drift; non-deterministic, un-cacheable | resolve server-side once; cache key uses resolved dates (§5, §6) |
| `eval`-ing the relative-date string | code-injection surface | closed grammar regex only (§5) |
| `NaN` serialized as `0` for a `log` of a negative value | silent data corruption read as a real value | `null` + `transform_warning` (§2.4) |

---

## 11. Sources (all consulted this run)

**Primary (parameter contracts, defaults, formulas):**

- FRED `series/observations` — params, `units` codes, `frequency` codes + the no-upsample rule,
  `aggregation_method` (avg/sum/eop, default avg), `limit` default/max **100000**, `offset`, default dates
  `1776-07-04` / `9999-12-31`, `output_type` 1–4, `next_cursor` pagination, `realtime_start`/`realtime_end`
  default today —
  [fred.stlouisfed.org/docs/api/fred/series_observations.html](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)
  (bare-fetcher 403; confirmed via the documented snippets quoted inline).
- FRED real-time periods — the (closed, closed) `realtime_*` semantics —
  [fred.stlouisfed.org/docs/api/fred/realtime_period.html](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html).
- ALFRED / FRED Add-In growth formulas — the exact `chg/ch1/pch/pc1/pca/cch/cca/log` formulas and the
  definition of `n` —
  [alfred.stlouisfed.org/help#growth_formulas](https://alfred.stlouisfed.org/help#growth_formulas) ·
  [FRED Add-In User Guide (PDF)](https://fred.stlouisfed.org/fred-addin/FRED_Addin_User_Guide.pdf).
- JPMorgan DataQuery client — `/expressions/time-series` endpoint, `EXPR_LIMIT=20`, `download_data(...)`
  defaults + the `params_dict` (`start-date`/`end-date`/`calendar`/`frequency`/`conversion`/`nan_treatment`/
  `data`), pagination via `response["links"][1]["next"]` —
  [github.com/macrosynergy/macrosynergy](https://github.com/macrosynergy/macrosynergy) `download/dataquery.py`
  (read this run) · [github.com/macrosynergy/dataquery-api](https://github.com/macrosynergy/dataquery-api).
- DataQuery product scale/channels — 130m+ series, 4B hits/yr (75% API), the `DB(ds,inst,metric)` expression —
  [jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery) (as captured in project 03).
- World Bank Indicators API — `date=YYYY:YYYY` ranges, `mrv`/`mrnev`/`gapfill`/`frequency` (Y/Q/M),
  `per_page`/`page`, the `[pagination, data]` two-element JSON shape —
  [datahelpdesk.worldbank.org … api-basic-call-structures](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures) ·
  [… advanced-data-api-queries](https://datahelpdesk.worldbank.org/knowledgebase/articles/1886686-advanced-data-api-queries).

**Framework (validation + typing):**

- FastAPI query-parameter Pydantic models (≥ 0.115.0), `model_config={"extra":"forbid"}`, `Annotated[Model,
  Query()]`, the `extra_forbidden` error —
  [fastapi.tiangolo.com/tutorial/query-param-models](https://fastapi.tiangolo.com/tutorial/query-param-models/) ·
  [… query-params-str-validations](https://fastapi.tiangolo.com/tutorial/query-params-str-validations/).
- Pydantic v2 `field_validator`/`model_validator`, `ConfigDict`, `Field(alias=...)` —
  [docs.pydantic.dev/latest](https://docs.pydantic.dev/latest/).
- `python-dateutil` `relativedelta` (calendar-correct month/year math) —
  [dateutil.readthedocs.io … relativedelta](https://dateutil.readthedocs.io/en/stable/relativedelta.html).

**Scale references:**

- Grafana `maxDataPoints` HTTP default (800) vs UI pixel-width —
  [grafana.com … query-transform-data](https://grafana.com/docs/grafana/latest/panels-visualizations/query-transform-data/).
- LTTB downsampling (shape-preserving) — [pypi.org/project/lttb](https://pypi.org/project/lttb/) ·
  Steinarsson 2013 (Univ. of Iceland thesis).

**Project (the committed contract this recipe implements):**

- `/series` contract + the read-from-store / per-series-provenance / server-side-reductions decisions —
  [`.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md).
- Pinned Python stack (FastAPI 0.138.x / Pydantic 2.13.x / Uvicorn 0.49.x / Python 3.12+) —
  [`.claude/skills/python-fastapi-data-service/SKILL.md`](../../python-fastapi-data-service/SKILL.md).
- Non-negotiables (#1 never invent a number, #2 `commercialOk`, #4 worker-not-serverless) +
  `commercial-ok-gate.md` + `product-at-scale.md` (this repo's rules, applied to the new line).
