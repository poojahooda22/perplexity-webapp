# Patterns — TimescaleDB Toolkit Hyperfunctions (OHLC, time-weighted, ASAP, percentiles, counters, two-step aggregation)

> **Scope.** Concrete build recipes for the `timescaledb_toolkit` extension's hyperfunctions **beyond
> `lttb()`** — the stat aggregates you reach for in a markets/data-analytics backend so the *math lives
> in SQL, not in app code*. Covers: the toolkit extension itself (separate install, **TSL-licensed**),
> `lttb()` + `asap_smooth()` (downsample vs smooth), `candlestick_agg()` / `candlestick()` for finance
> OHLCV, `time_weight()` for irregular series, `stats_agg` / rolling stats / regression, `percentile_agg`
> with `uddsketch` / `tdigest`, `counter_agg` / `gauge_agg` for metric-style series, and the **two-step
> aggregation pattern** (aggregate → store in a continuous aggregate → `rollup()` → accessor at read
> time) that makes all of them compose.
>
> This is for the **JPM-Markets re-engineering data-analytics product line (NOT Lumina).** The data
> store is a Python/FastAPI service over TimescaleDB; these hyperfunctions are how the analytics API
> answers "give me 1-minute candles for AAPL", "p99 request latency", "time-weighted average price"
> without pulling raw rows to the app and looping in Python.
>
> **Companion reads:** `theory-hypertables-chunks.md` (the storage substrate), `patterns-continuous-aggregates.md`
> (the materialized-view machinery these aggregates are *stored in*), `patterns-downsampling-lttb.md`
> (the read-path decimation companion to the `lttb`/`asap` section here).

---

## 0. The one-paragraph mental model

A TimescaleDB Toolkit hyperfunction is **not** a scalar function — it is a *two-step aggregate*. Step
one (`candlestick_agg`, `stats_agg`, `percentile_agg`, `time_weight`, `counter_agg`, …) chews raw rows
into a small **intermediate summary object** (a partial aggregate — a `Candlestick`, `StatsSummary1D`,
`UddSketch`, `TimeWeightSummary`, `CounterSummary`). Step two — an **accessor** (`close()`,
`average()`, `approx_percentile()`, `rate()`) — reads a final answer *out of* that object. Between the
two you can store the summary in a **continuous aggregate** and later **`rollup()`** many summaries into
a coarser one *without touching raw data and without statistical error from naïve re-averaging*. That
single design — aggregate → store → rollup → accessor — is why these functions exist and why they beat
hand-rolled `GROUP BY` math. Everything below is an instance of it.

> Primary source for the pattern: [`docs/two-step_aggregation.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/two-step_aggregation.md)
> — *"It allows different accessor function calls to use the same internal state and not redo work … It
> makes it explicit how and when aggregates can be re-aggregated or 'stacked' on themselves with
> logically consistent results … It allows for better retrospective analysis of downsampled data in
> continuous aggregates."*

---

## 1. The toolkit extension — what it is, the license, how to enable it

### 1.1 It is a SEPARATE extension from TimescaleDB

`timescaledb_toolkit` is a **distinct PostgreSQL extension**, written in **Rust** (via `pgrx`),
shipped and versioned separately from the core `timescaledb` extension. Core TimescaleDB gives you
hypertables, compression, and continuous aggregates; the **hyperfunctions in this doc live in the
Toolkit**, not in core.

> *"Extension for more hyperfunctions, fully compatible with TimescaleDB and PostgreSQL."* —
> [github.com/timescale/timescaledb-toolkit](https://github.com/timescale/timescaledb-toolkit). The
> extension supports PostgreSQL 15–18 on x86_64 and aarch64 (Linux/macOS) per the repo README and
> [DeepWiki install notes](https://deepwiki.com/timescale/timescaledb-toolkit/2-installation-and-setup).

You enable it independently:

```sql
-- Core TimescaleDB (needed first for hypertables + continuous aggregates):
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- The Toolkit — a SEPARATE extension that adds the hyperfunctions below:
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
```

- A role with **`CREATE` privilege on the database** (e.g. the DB owner) can run
  `CREATE EXTENSION timescaledb_toolkit` **without superuser** — per
  [Tiger Data install-toolkit docs](https://www.tigerdata.com/docs/deploy/self-hosted/tooling/install-toolkit).
- On **Timescale/Tiger Cloud** the extension binaries are **pre-installed**; you still must run
  `CREATE EXTENSION timescaledb_toolkit;` **in each database** that needs the functions (the catalog
  entry is per-database).
- On the **`timescaledb-ha` Docker image**, the Toolkit is **pre-installed and pre-enabled** — already
  active, ready to use.
- **Self-hosted bare metal:** install the OS package `timescaledb-toolkit-postgresql-<PGMAJOR>` from
  the Tiger Data DEB/RPM repo, then `CREATE EXTENSION`.

Check what you actually have:

```sql
-- Is it installed, and at what version?
SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb_toolkit';

-- What is the latest version available to upgrade to?
SELECT default_version, installed_version
FROM pg_available_extensions
WHERE name = 'timescaledb_toolkit';

-- Upgrade (the toolkit is upgraded independently of core timescaledb):
ALTER EXTENSION timescaledb_toolkit UPDATE;
```

> **Build-recipe note for our FastAPI service:** add **both** `CREATE EXTENSION` statements to the
> first idempotent migration (Alembic / raw SQL bootstrap). They are `IF NOT EXISTS`, so the migration
> stays re-runnable. Do **not** assume the Toolkit is present just because `timescaledb` is — a vanilla
> `timescale/timescaledb:latest-pg16` image has core only; you need `:latest-pg16` of the **`-ha`**
> image or a manual package install for the Toolkit. This is the #1 "function does not exist" surprise.

### 1.2 The license — **TSL (Timescale License), NOT open source** — and why it matters

The entire `timescaledb-toolkit` repository is licensed under the **Timescale License (TSL)**, *not*
Apache 2.0.

> [`timescaledb-toolkit/LICENSE`](https://github.com/timescale/timescaledb-toolkit/blob/main/LICENSE):
> *"source code in this repository, and any binaries built from this source code, in whole or in part,
> are licensed under the Timescale License."*

Contrast with core TimescaleDB, which is **split**: the Apache-2.0 core plus a TSL `tsl/` directory.
Per [Tiger Data licensing](https://www.tigerdata.com/legal/licenses): *"TimescaleDB Open Source is made
available under the Apache 2.0 License while TimescaleDB Community is made available under the Timescale
License (TSL)."* **The Toolkit is wholly on the Community/TSL side.**

What the TSL actually restricts (the load-bearing clause for us):

- **No DBaaS clause.** You may **not** offer the TSL software (or a product whose primary value derives
  from it) **as a managed/hosted database-as-a-service** to third parties. The TSL is **not
  OSI-approved**; it is a source-available commercial license.
- **You CAN** use it freely **inside your own product** — run it, query it, build features on it,
  ship the product to customers — including a commercial product. The restriction is specifically on
  *reselling the database engine itself as a managed service*, which is not what our analytics product
  does.

> **So what for our product line:** the Toolkit is **safe to depend on** for the JPM-Markets analytics
> backend — we are building a product *on top of* Postgres, not reselling Postgres-as-a-service. But
> **tag it in the architecture doc as TSL**, because: (a) it changes the deployment story (the `-ha`
> image / Tiger Cloud, not vanilla upstream Postgres + apt `postgresql-16`); (b) a future "let
> customers self-host the whole stack" or "offer our DB as a managed tenant" pivot would need a TSL
> review; (c) if we ever want a **pure-Apache** subset, only *core* TimescaleDB qualifies, and we'd
> lose every hyperfunction in this doc. **Every snippet below is therefore tagged `[license: TSL]`.**

> **Per-file caveat.** Tiger's general policy is that a source file with no explicit header defaults to
> TSL ([search result, Tiger licensing](https://www.tigerdata.com/legal/licenses)). In *core*
> TimescaleDB some files are Apache; in the **Toolkit repo the top-level `LICENSE` is TSL for the whole
> repo**, so treat **all** toolkit hyperfunctions as TSL unless a specific file header says otherwise.

### 1.3 Stable vs experimental — the `toolkit_experimental` schema

Functions promoted to stable live in the default search path; **experimental** functions live
**only** in the `toolkit_experimental` schema and must be schema-qualified.

> [`docs/README.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/README.md):
> *"Experimental features and functions can be found exclusively in the `toolkit_experimental`
> schema."*

| Function family | Status (per docs/README.md, mid-2025) | How you call it |
|---|---|---|
| `candlestick_agg` / `candlestick` / OHLC accessors | **stable** | `candlestick_agg(...)` |
| `stats_agg` (1D/2D) + accessors + `rolling()` | **stable** | `stats_agg(...)` |
| `percentile_agg`, `uddsketch`, `tdigest`, `approx_percentile*` | **stable** | `approx_percentile(...)` |
| `time_weight` + accessors | **stable** | `time_weight(...)` |
| `counter_agg` / accessors | **stable** | `counter_agg(...)` |
| `gauge_agg` / accessors | **stable** (was experimental earlier) | `gauge_agg(...)` |
| `lttb` | **experimental** (per docs/README.md table) | `toolkit_experimental.lttb(...)` *(see §2.1 note)* |
| `asap_smooth` | **experimental** | `toolkit_experimental.asap_smooth(...)` |
| `hyperloglog` | **experimental** | `toolkit_experimental.hyperloglog(...)` |

> **Verification caveat `[unverified across versions]`.** Promotion status drifts between releases —
> e.g. `lttb` is listed *experimental* in the repo's `docs/README.md` table
> ([source](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/README.md)) but appears
> **unqualified** in some Tiger Data API docs and tutorials, implying it is reachable without the
> `toolkit_experimental.` prefix in current releases. **Always confirm against the installed version**:

```sql
-- Find which schema a toolkit function actually lives in on THIS install:
SELECT n.nspname AS schema, p.proname AS function
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname IN ('lttb','asap_smooth','candlestick_agg','stats_agg',
                    'time_weight','counter_agg','gauge_agg','percentile_agg')
ORDER BY 2,1;
```

> **Recipe rule:** never hardcode `toolkit_experimental.` in a migration that must survive an upgrade —
> a function can graduate out of that schema and break the call. Probe with the query above at startup,
> or pin the toolkit version in your Docker tag and test against exactly that.

---

## 2. Downsample vs smooth — `lttb()` and `asap_smooth()`

Both reduce a dense series to ~N points for a chart, but they answer **different questions**. Picking
the wrong one is a classic "metric in a costume" trap: a smoothed line that *looks* like the data but
hides the spike a trader needed to see, or a decimated line that *is* every spike but unreadably noisy.

### 2.1 `lttb()` — Largest-Triangle-Three-Buckets decimation (preserve shape, keep real points)

LTTB **selects a subset of the actual original points** so the downsampled line is *visually similar*
to the full series — it keeps peaks and troughs that simple `every-Nth-row` or `avg()` bucketing would
erase. The returned points are **real data points**, never synthesized.

> [`docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md): *"Largest
> Triangle Three Buckets is a downsampling method that tries to retain visual similarity between the
> downsampled data and the original dataset."*

**Signature** (per `docs/lttb.md`):

```sql
lttb(
    time TIMESTAMPTZ,
    value DOUBLE PRECISION,
    resolution INTEGER         -- target number of output points
) RETURNS SortedTimevector    -- unpack with unnest()
```

**Runnable** `[license: TSL]`:

```sql
-- Reduce a dense series to 4 representative points, preserving shape:
SELECT time, value
FROM unnest(
    (SELECT lttb(time, val, 4) FROM sample_data)
);
-- For a 1000px chart, ask for ~1000–2000 points:
SELECT time, value
FROM unnest(
    (SELECT lttb(ts, price, 1200)
     FROM ticks
     WHERE symbol = 'AAPL' AND ts >= now() - interval '90 days')
);
```

> **Note:** `lttb` is documented experimental in the repo (`docs/lttb.md` /
> [`docs/README.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/README.md)). If
> `function lttb(...) does not exist`, qualify it: `toolkit_experimental.lttb(ts, price, 1200)`. See
> §1.3 and `patterns-downsampling-lttb.md` for the deep treatment of the read-path decimation pattern.

**Reach for `lttb` when:** the consumer is a **chart** and the user must still see **transient spikes**
(a flash crash, a single-tick gap, an outlier). Financial price charts are the canonical case — you
must NOT smooth away a real low/high.

### 2.2 `asap_smooth()` — smoothing for human-readable trend (remove cyclic noise)

ASAP (Automatic Smoothing for Attention Prioritization, from the
[MacroBase/Stanford ASAP paper](https://arxiv.org/abs/1703.00983)) does the **opposite** of LTTB: it
**minimizes local variance** (kurtosis-targeted moving average) so the eye sees **the larger trend**,
deliberately *removing* high-frequency cyclic noise. The output points are **synthesized** (a smoothed
curve at regular intervals), not original samples.

> [`docs/asap.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/asap.md):
> *"create human readable graphs which preserve the rough shape and larger trends of the input data
> while minimizing the local variance between points."* **Status: experimental.**

**Signature** (per `docs/asap.md`):

```sql
asap_smooth(
    ts TIMESTAMPTZ,
    value DOUBLE PRECISION,
    resolution INT             -- approximate number of output points
) RETURNS NormalizedTimevector -- unpack with unnest()
```

**Runnable** `[license: TSL]` (the doc's own example — a noisy sine wave smoothed to 8 points):

```sql
SET TIME ZONE 'UTC';
CREATE TABLE metrics(date TIMESTAMPTZ, reading DOUBLE PRECISION);
INSERT INTO metrics
SELECT
    '2020-1-1 UTC'::timestamptz + make_interval(hours => foo),
    (5 + 5 * sin(foo / 12.0 * PI()))
FROM generate_series(1, 168) foo;

SELECT time, round(value::numeric, 14)
FROM unnest(
    (SELECT toolkit_experimental.asap_smooth(date, reading, 8) FROM metrics)
);
```

### 2.3 Decision table — when smoothing beats decimation

| Question the chart must answer | Use | Why |
|---|---|---|
| "Show me the price action, **including every spike**" | **`lttb`** | keeps real extrema; never invents a point |
| "Show me the **trend**; the per-minute jitter is noise" | **`asap_smooth`** | removes cyclic variance, easier to read |
| "Plot **monotonic-counter** rate over a day" | smooth the **rate** (`counter_agg`→`rate`) then `lttb` | smooth the derived metric, not raw counter |
| "Audit / compliance view — must reflect **actual** ticks" | **`lttb`** | decimation = subset of real data; smoothing fabricates |
| Anomaly detection feed | **neither here** — keep raw or use `stats_agg` thresholds | both hide the anomaly you're hunting |

> **Anti-pattern (F4 "metric in a costume"):** showing an `asap_smooth`'d price line on a *trading*
> surface where a user makes a decision. A smoothed curve removes the very low that mattered — and the
> reader cannot tell it was smoothed. For any price surface a user *acts on*, decimate (`lttb`), don't
> smooth; reserve `asap_smooth` for **monitoring/overview dashboards** where the trend, not the
> extremum, is the message. State which one you chose **and why** in the API contract.

---

## 3. Finance OHLC — `candlestick_agg()` / `candlestick()` and the OHLCV accessors

The single highest-value family for a markets product. It turns a stream of raw `(ts, price, volume)`
trades into a **`Candlestick`** summary, from which you read **open / high / low / close / volume /
VWAP** — *and* their **timestamps** — and which **rolls up** from 1-minute candles to 1-hour candles
with no error. This is the SQL-native replacement for "pull ticks into Python and loop to compute
OHLC".

> Group docs: [Tiger Data financial-analysis / candlestick_agg](https://www.tigerdata.com/docs/api/latest/hyperfunctions/financial-analysis/candlestick_agg),
> introduced in [toolkit PR #596](https://github.com/timescale/timescaledb-toolkit/pull/596).
> *"candlestick_agg produces a candlestick aggregate from raw tick data, which can then be used with
> accessor and rollup functions, while candlestick takes pre-aggregated data and transforms it into the
> same format that candlestick_agg produces."*

### 3.1 `candlestick_agg()` — build a candle from raw ticks

**Signature** (per [candlestick_agg docs](https://www.tigerdata.com/docs/api/latest/hyperfunctions/financial-analysis/candlestick_agg)):

```sql
candlestick_agg(
    ts     TIMESTAMPTZ,        -- timestamp of the trade
    price  DOUBLE PRECISION,   -- trade price
    volume DOUBLE PRECISION    -- trade volume
) RETURNS Candlestick
```

> Returns *"An object storing `(timestamp, value)` pairs for each of the opening, high, low, and
> closing prices, in addition to information used to calculate the total volume and Volume Weighted
> Average Price."* All three args required; no optional args.

### 3.2 The accessors — read OHLCV out of a `Candlestick`

Every accessor takes a `Candlestick` and returns a scalar (or a `TimestampTz` for the `*_time`
variants):

| Accessor | Returns | Meaning |
|---|---|---|
| `open(candlestick)` | `DOUBLE PRECISION` | first price in the bucket |
| `high(candlestick)` | `DOUBLE PRECISION` | max price |
| `low(candlestick)` | `DOUBLE PRECISION` | min price |
| `close(candlestick)` | `DOUBLE PRECISION` | last price |
| `open_time(candlestick)` | `TIMESTAMPTZ` | when the open trade occurred |
| `high_time(candlestick)` | `TIMESTAMPTZ` | when the high occurred |
| `low_time(candlestick)` | `TIMESTAMPTZ` | when the low occurred |
| `close_time(candlestick)` | `TIMESTAMPTZ` | when the close occurred |
| `volume(candlestick)` | `DOUBLE PRECISION` | total volume in the bucket |
| `vwap(candlestick)` | `DOUBLE PRECISION` | Volume-Weighted Average Price |

> Accessor list per [Tiger Data candlestick_agg docs](https://www.tigerdata.com/docs/api/latest/hyperfunctions/financial-analysis/candlestick_agg)
> and the [timescaledb-ruby candlestick tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_candlestick/).

### 3.3 Runnable — raw ticks → 1-minute OHLCV `[license: TSL]`

```sql
-- Build the intermediate Candlestick per symbol per minute:
SELECT time_bucket('1m', time) AS time,
       ticks.symbol,
       candlestick_agg(time, price, volume) AS candlestick
FROM ticks
GROUP BY 1, 2
ORDER BY 1;
```

```sql
-- Read full OHLCV (+ VWAP + per-field times) out of the candle:
SELECT symbol,
       "time",
       open(candlestick),
       high(candlestick),
       low(candlestick),
       close(candlestick),
       open_time(candlestick),
       high_time(candlestick),
       low_time(candlestick),
       close_time(candlestick),
       volume(candlestick),
       vwap(candlestick)
FROM (
    SELECT time_bucket('1m', time) AS time,
           ticks.symbol,
           candlestick_agg(time, price, volume) AS candlestick
    FROM ticks
    GROUP BY 1, 2
    ORDER BY 1
) AS candlestick;
```

> Both queries verbatim from the [timescaledb-ruby candlestick tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_candlestick/)
> (lightly reformatted). Note the **two-step shape**: the inner query builds the summary once; the outer
> query reads *many* fields off it without re-scanning ticks (reason #1 of the two-step design — shared
> state).

### 3.4 Continuous aggregate + `rollup()` — 1-minute candles → 1-hour candles, no re-scan

The whole point: materialize 1-minute candles **once** in a continuous aggregate, then derive every
coarser timeframe by **`rollup()`** of the stored `Candlestick` objects — never re-reading raw ticks.

```sql
-- 1) Materialize 1-minute candles as a continuous aggregate:
CREATE MATERIALIZED VIEW candlestick_1m
WITH (timescaledb.continuous) AS
    SELECT time_bucket('1 minute', time) AS bucket,
           symbol,
           candlestick_agg(time, price, volume) AS candlestick
    FROM ticks
    GROUP BY 1, 2
WITH NO DATA;

-- 2) HIERARCHICAL caggs: 1-hour candles BY ROLLING UP the 1-minute candles:
CREATE MATERIALIZED VIEW candlestick_1h
WITH (timescaledb.continuous) AS
    SELECT time_bucket('1 hour', bucket) AS bucket,
           symbol,
           rollup(candlestick) AS candlestick   -- <-- combines 60 one-minute candles
    FROM candlestick_1m
    GROUP BY 1, 2
WITH NO DATA;
```

> Rollup-of-candlestick into a hierarchical cagg per the [search-verified example](https://timescale.github.io/timescaledb-ruby/toolkit_candlestick/)
> and Tiger's [hierarchical continuous aggregates docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates).
> `rollup(candlestick)` is **correct OHLC composition** — the 1h `open` is the *first* minute's open,
> the 1h `high` is the *max* of minute highs, the 1h `close` is the *last* minute's close, volume sums,
> VWAP recomputes from the components. You cannot get that from `max(high), min(low)` over plain columns
> because you'd lose which timestamp the open/close came from.

```sql
-- 3) Read 1-hour OHLCV at query time from the rolled-up cagg:
SELECT symbol, bucket,
       open(candlestick)  AS o,
       high(candlestick)  AS h,
       low(candlestick)   AS l,
       close(candlestick) AS c,
       volume(candlestick) AS v,
       vwap(candlestick)   AS vwap
FROM candlestick_1h
WHERE symbol = 'AAPL'
  AND bucket >= now() - interval '7 days'
ORDER BY bucket;
```

### 3.5 `candlestick()` — the pseudo-aggregate for *already-OHLC* data

If your upstream feed **already delivers OHLC bars** (e.g. a vendor sends pre-aggregated 1-minute bars,
not raw ticks), use `candlestick()` (no `_agg`) to lift those columns **into the same `Candlestick`
type** so you can still `rollup()` and use the accessors.

> Per [Tiger Data candlestick docs](https://docs.timescale.com/api/latest/hyperfunctions/financial-analysis/candlestick/):
> *"candlestick takes pre-aggregated data and transforms it into the same format that candlestick_agg
> produces."* Signature takes the OHLC values **with their timestamps** plus volume.

```sql
-- Conceptual signature (confirm arg order against your installed version):
candlestick(
    ts          TIMESTAMPTZ,   -- bar timestamp
    open        DOUBLE PRECISION,
    high        DOUBLE PRECISION,
    low         DOUBLE PRECISION,
    close       DOUBLE PRECISION,
    volume      DOUBLE PRECISION
) RETURNS Candlestick
```

```sql
-- Roll vendor-supplied 1-min OHLC bars up to 1-hour candles [license: TSL]:
SELECT time_bucket('1 hour', bar_ts) AS bucket,
       symbol,
       rollup(candlestick(bar_ts, open, high, low, close, volume)) AS candle
FROM vendor_minute_bars
GROUP BY 1, 2;
```

> **Recipe decision:** raw trades arriving → `candlestick_agg`. Pre-baked OHLC bars arriving →
> `candlestick`. **Verify the exact `candlestick()` argument order** against your installed toolkit
> version with `\df candlestick` — the docs page for the pseudo-aggregate moved/404'd during research,
> so this signature is `[unverified — confirm with \df]`; the *behavior* (lift OHLC into the Candlestick
> type so rollup/accessors work) is confirmed by the candlestick_agg group docs.

### 3.6 What this replaces in app code

Without the Toolkit, a Python OHLC pipeline pulls every tick for the window, sorts by time, and loops:
`o = first.price; h = max(...); l = min(...); c = last.price; v = sum(...)`, and re-implements VWAP and
multi-timeframe rollups by hand — **O(ticks) rows over the wire** and a fragile, untested re-derivation
on every timeframe. The Toolkit pushes all of it into one indexed aggregate that the **planner
parallelizes and the continuous-aggregate machinery incrementally maintains**. Pull *candles*, not
ticks.

---

## 4. `time_weight()` — time-weighted averages for **irregular** series

A plain `avg(value)` is **wrong** for irregularly-sampled data because it weights every *sample*
equally regardless of how long that value *held*. A sensor that reads `100` for 59 minutes and then
spikes to `0` for 1 minute has a *time-weighted* average near 100, but `avg()` over (say) 30 dense
readings during the spike and 2 sparse readings during the plateau can land anywhere. For **prices,
balances, temperatures, gauges** — anything that *persists* between samples — you want
`time_weight()`.

> [Tiger Data time-weighted averages](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/time-weighted-averages):
> a simple mean *"can overweight short spikes or underweight long plateaus"*; time-weighting assigns
> weight proportional to **duration**.

### 4.1 Signature + interpolation methods

```sql
time_weight(
    method TEXT,              -- 'Linear' (a.k.a. trapezoidal) or 'LOCF'
    ts     TIMESTAMPTZ,
    value  DOUBLE PRECISION
) RETURNS TimeWeightSummary   -- intermediate; read with accessors below
```

- **`'Linear'`** — interpolate linearly (trapezoidal) between observations. Use when the value
  *changes smoothly* between samples (price, temperature).
- **`'LOCF'`** — Last Observation Carried Forward; the value is assumed **constant** until the next
  sample. Use for **step** signals (a set-point, a config value, an account balance that holds until the
  next transaction).

> Signature + methods per [Tiger Data API time_weight](https://www.tigerdata.com/docs/api/latest/hyperfunctions/time-weighted-calculations/time_weight).

### 4.2 Accessors

| Accessor | Returns | Meaning |
|---|---|---|
| `average(tws)` | `DOUBLE PRECISION` | the time-weighted average value |
| `integral(tws [, unit])` | `DOUBLE PRECISION` | time-weighted integral (area under the curve) |
| `interpolated_average(tws, start, interval, prev, next)` | `DOUBLE PRECISION` | TWA for a bucket using neighbors to fill bucket edges |
| `interpolated_integral(...)` | `DOUBLE PRECISION` | integral with boundary interpolation |
| `first_val / last_val / first_time / last_time` | scalar / ts | endpoint helpers |
| `rollup(tws)` | `TimeWeightSummary` | combine adjacent summaries |

> `average`/`integral`/`interpolated_*`/`rollup` per the [time-weighted API group](https://www.tigerdata.com/docs/api/latest/hyperfunctions/time-weighted-calculations/time_weight).
> The `interpolated_*` accessors exist precisely so a **bucketed** TWA is correct at bucket boundaries
> (a value that started before the bucket and continues after it).

### 4.3 Runnable `[license: TSL]`

```sql
-- Compare a naive mean vs a time-weighted mean per device (the doc's freezer example):
SELECT freezer_id,
       avg(temperature)                                    AS naive_mean,
       average(time_weight('Linear', ts, temperature))     AS time_weighted_average
FROM freezer_temps
GROUP BY freezer_id;
```

```sql
-- Rolling 15-minute TWA as a window function (note: NOT parallelizable, but cagg-supported):
SELECT *,
       average(
         time_weight('Linear', ts, temperature)
           OVER (PARTITION BY freezer_id ORDER BY ts RANGE '15 minutes'::interval PRECEDING)
       ) AS rolling_twa
FROM freezer_temps
ORDER BY freezer_id, ts;
```

```sql
-- Store TWA summaries in a continuous aggregate, roll up to a day at read time:
CREATE MATERIALIZED VIEW temp_15m
WITH (timescaledb.continuous) AS
    SELECT time_bucket('15 min', ts) AS bucket,
           freezer_id,
           time_weight('Linear', ts, temperature) AS tw
    FROM freezer_temps
    GROUP BY 1, 2
WITH NO DATA;

-- Daily TWA by rolling up the 15-minute summaries:
SELECT time_bucket('1 day', bucket) AS day,
       freezer_id,
       average(rollup(tw)) AS daily_twa
FROM temp_15m
GROUP BY 1, 2;
```

> Freezer + window examples verbatim from [Tiger Data time-weighted averages](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/time-weighted-averages),
> which also notes these aggregates are *"not parallelizable, but … supported with continuous
> aggregates."* — meaning push them into a cagg rather than computing them ad-hoc at scale.

> **Markets use:** a **time-weighted average price** over an irregular tick stream (TWAP, distinct from
> VWAP) is exactly `average(time_weight('Linear', ts, price))`. Use **LOCF** for an order-book best-bid
> that *holds* until the next update; **Linear** for a continuously-traded price.

---

## 5. `stats_agg` — rolling statistics & regression in SQL

`stats_agg` rolls raw values into a `StatsSummary` from which you read **mean, sum, stddev, variance,
skewness, kurtosis, count** (1-variable) or **slope, intercept, correlation, covariance** (2-variable
linear regression). Like everything here it **rolls up** — so a continuous aggregate of `stats_agg`
serves *all* of those statistics at *any* rollup granularity, computed once.

> [Tiger Data statistical aggregation](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/stats-aggs):
> *"stats_agg is well suited for creating a continuous aggregate that can serve multiple purposes
> later"* — reuse one stored summary for many accessors.

### 5.1 One-variable: `stats_agg(value)`

**Signature** (per [API stats_agg one-variable](https://www.tigerdata.com/docs/api/latest/hyperfunctions/statistical-and-regression-analysis/)):

```sql
stats_agg(value DOUBLE PRECISION) RETURNS StatsSummary1D
stats_agg(value BIGINT)           RETURNS StatsSummary1D   -- BIGINT must be within ±2^53
```

**Accessors:** `average`, `sum`, `stddev`, `variance`, `skewness`, `kurtosis`, `num_vals`. Plus
`rolling()` (window combine) and `rollup()` (cagg combine).

> Accessor list + the `±2^53` BIGINT constraint per [API stats_agg one-variable](https://www.tigerdata.com/docs/api/latest/hyperfunctions/statistical-and-regression-analysis/stats_agg-one-variable);
> `stddev`/`variance` take an optional `'population'` | `'sample'` argument.

```sql
-- Per-day distribution stats from one stored aggregate [license: TSL]:
SELECT time_bucket('1 day', ts) AS day,
       average(stats_agg(val))  AS mean,
       stddev(stats_agg(val))   AS sd,
       skewness(stats_agg(val)) AS skew,
       kurtosis(stats_agg(val)) AS kurt,
       num_vals(stats_agg(val)) AS n
FROM measurements
GROUP BY 1
ORDER BY 1;
-- The planner reuses ONE stats_agg(val) state for all five accessors (two-step reason #1).
```

### 5.2 Rolling stats with `rolling()` — moving windows without re-scanning

```sql
-- 7-day rolling mean/stddev over DAILY pre-aggregates:
WITH daily AS (
    SELECT time_bucket('1 day', ts) AS day, stats_agg(val) AS s
    FROM measurements GROUP BY 1
)
SELECT day,
       average(rolling(s) OVER seven_days) AS mean_7d,
       stddev(rolling(s)  OVER seven_days) AS sd_7d
FROM daily
WINDOW seven_days AS (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
ORDER BY day;
```

> `rolling()` combines the per-bucket `StatsSummary` objects across a window frame — so a 7-day moving
> stat reuses the 7 daily summaries instead of re-reading 7 days of raw rows. Pattern per
> [Tiger statistical aggregation docs](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/stats-aggs).

### 5.3 Two-variable: `stats_agg(y, x)` — linear regression

**Signature:** `stats_agg(y DOUBLE PRECISION, x DOUBLE PRECISION) RETURNS StatsSummary2D`.
**Accessors:** `slope`, `intercept`, `corr` (Pearson correlation), `covariance`, `x_intercept`,
`determination_coeff` (R²), plus 1D accessors on each axis via `average_x`/`average_y` etc.

```sql
-- Beta of a stock vs an index per month (slope of returns regression) [license: TSL]:
SELECT time_bucket('1 month', ts) AS month,
       slope(stats_agg(stock_return, index_return))     AS beta,
       intercept(stats_agg(stock_return, index_return)) AS alpha,
       corr(stats_agg(stock_return, index_return))      AS correlation
FROM returns
GROUP BY 1
ORDER BY 1;
```

> 2D accessor names (`slope`, `intercept`, `corr`, `covariance`, `x_intercept`) per
> [Tiger statistical aggregation docs](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/stats-aggs).
> **This is a real markets feature:** rolling beta/alpha/correlation, computed in the database, stored
> in a cagg, served instantly — instead of pulling return series into pandas and running `np.polyfit`
> per pair per window.

### 5.4 Stored in a continuous aggregate (the payoff)

```sql
CREATE MATERIALIZED VIEW measurements_hourly
WITH (timescaledb.continuous) AS
    SELECT time_bucket('1 hour', ts) AS bucket,
           device_id,
           stats_agg(val) AS stats           -- store the SUMMARY, not the mean
    FROM measurements
    GROUP BY 1, 2
WITH NO DATA;

-- Daily mean+stddev by rolling up the hourly summaries — correct, not an avg-of-avgs:
SELECT time_bucket('1 day', bucket) AS day, device_id,
       average(rollup(stats)) AS mean,
       stddev(rollup(stats))  AS sd
FROM measurements_hourly
GROUP BY 1, 2;
```

> **Why store the summary, not the mean:** an `avg()` of hourly `avg()`s is only correct if every hour
> has equal counts; `rollup(stats_agg)` carries the counts and sums, so the daily mean/stddev is
> **exact**. This is the canonical "naïve re-aggregation is wrong" failure the two-step pattern
> eliminates.

---

## 6. `percentile_agg` / `approx_percentile` — latency-style distributions (uddsketch & tdigest)

Exact percentiles (`percentile_cont`) require **sorting all values** — impossible to maintain
incrementally in a continuous aggregate and brutal at scale. The Toolkit's **approximate** percentiles
build a small **sketch** that *is* rollup-able, so a continuous aggregate can serve **p50/p95/p99** at
any granularity. This is the standard answer to "p99 request latency per minute, queryable for a year".

> Two algorithms, per [Tiger percentile-approx advanced agg](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/percentile-approx/advanced-agg):
> **`uddsketch`** (the default behind `percentile_agg`) uses *"exponentially sized buckets to guarantee
> the approximation falls within a known error range"* and is **order-independent / deterministic** —
> *"always returns the same percentile estimate for the same underlying data, regardless of how it is
> ordered or re-aggregated."* **`tdigest`** *"buckets data more aggressively toward the center … giving
> it greater accuracy at the tails (around 0.001 or 0.995)"* but is *"somewhat dependent on input
> order."*

### 6.1 The default path: `percentile_agg` + `approx_percentile`

```sql
percentile_agg(value DOUBLE PRECISION) RETURNS UddSketch   -- uddsketch with sane defaults
approx_percentile(p DOUBLE PRECISION, sketch) RETURNS DOUBLE PRECISION       -- value at percentile p
approx_percentile_rank(value DOUBLE PRECISION, sketch) RETURNS DOUBLE PRECISION -- the rank of a value
```

```sql
-- p10/p50/p90 from ONE shared sketch state (two-step reason #1) [license: TSL]:
SELECT approx_percentile(0.1, percentile_agg(val)) AS p10,
       approx_percentile(0.5, percentile_agg(val)) AS p50,
       approx_percentile(0.9, percentile_agg(val)) AS p90
FROM foo;
```

> Verbatim from [`docs/two-step_aggregation.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/two-step_aggregation.md);
> *"The optimizer combines redundant `percentile_agg(val)` calls"* so the sketch is built once.

### 6.2 Stored in a continuous aggregate + `rollup()`

```sql
-- Materialize hourly latency sketches:
CREATE MATERIALIZED VIEW latency_hourly
WITH (timescaledb.continuous) AS
    SELECT time_bucket('1 hour', ts) AS bucket,
           service,
           percentile_agg(latency_ms) AS sketch
    FROM request_log
    GROUP BY 1, 2
WITH NO DATA;

-- Daily p95/p99 by ROLLING UP the hourly sketches (exact-shaped, not avg-of-percentiles):
SELECT time_bucket('1 day', bucket) AS day, service,
       approx_percentile(0.95, rollup(sketch)) AS p95,
       approx_percentile(0.99, rollup(sketch)) AS p99
FROM latency_hourly
GROUP BY 1, 2
ORDER BY 1;
```

> Rollup pattern per [`docs/two-step_aggregation.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/two-step_aggregation.md)
> and [Tiger uddsketch API](https://www.tigerdata.com/docs/api/latest/hyperfunctions/percentile-approximation/uddsketch).
> **You cannot average percentiles** (an avg of hourly p99s is meaningless); you **can** `rollup()` the
> sketches and *then* take the percentile — that is the whole reason sketches exist.

### 6.3 Choosing the algorithm explicitly: `uddsketch()` vs `tdigest()`

```sql
-- uddsketch with explicit bucket count + max relative error:
uddsketch(buckets INTEGER, max_error DOUBLE PRECISION, value DOUBLE PRECISION) RETURNS UddSketch
-- tdigest with a buckets/compression param:
tdigest(buckets INTEGER, value DOUBLE PRECISION) RETURNS TDigest
```

```sql
-- High-resolution tail latency with tdigest (better at 0.99/0.999) [license: TSL]:
SELECT time_bucket('1 hour', ts) AS bucket,
       approx_percentile(0.999, tdigest(200, latency_ms)) AS p999
FROM request_log
GROUP BY 1;

-- uddsketch with a guaranteed 1% relative error, 200 buckets:
SELECT time_bucket('1 hour', ts) AS bucket,
       approx_percentile(0.5, uddsketch(200, 0.01, latency_ms)) AS median
FROM request_log
GROUP BY 1;
```

> `uddsketch(buckets, max_error, value)` and `tdigest(buckets, value)` signatures + the
> `error()`/`mean()`/`num_vals()` accessors + the `rollup()` example per
> [Tiger uddsketch API](https://www.tigerdata.com/docs/api/latest/hyperfunctions/percentile-approximation/uddsketch).

| Pick | When |
|---|---|
| `percentile_agg` (uddsketch defaults) | general purpose; **deterministic & order-independent**; safe in caggs |
| `uddsketch(buckets, max_error, …)` | you need a **guaranteed bounded relative error** (SLA reporting) |
| `tdigest(buckets, …)` | you care about **extreme tails** (p99.9) and accept order-sensitivity |

> Selection guidance per [Tiger percentile-approx advanced agg](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/percentile-approx/advanced-agg):
> *"If your workflow involves estimating ninety-ninth percentiles, then choose tdigest … if you're more
> concerned about getting highly accurate median estimates, choose uddsketch."*

> **Extra accessors** on a sketch: `error(sketch)` (max relative error), `mean(sketch)` (exact mean of
> the inserted values), `num_vals(sketch)` (count), `approx_percentile_rank(value, sketch)` ("what
> percentile is *this* value at"). Source: same uddsketch API page.

---

## 7. `counter_agg` / `gauge_agg` — monotonic counters and bidirectional gauges

For **metric-style** series — request counts, bytes transferred, cumulative volume, a counter that
*resets* on process restart — naïve `max - min` or `last - first` is wrong because the series **resets**
(a Prometheus-style counter wraps to 0). `counter_agg` understands resets; `gauge_agg` is its sibling
for values that legitimately go **up and down** (temperature, queue depth, open positions).

> [Tiger counters-and-gauges API](https://www.tigerdata.com/docs/api/latest/hyperfunctions/counters-and-gauges/counter_agg):
> `counter_agg` analyzes *"data whose values are designed to monotonically increase, and where any
> decreases are treated as resets."* `gauge_agg` differs in that gauges *"can decrease as well as
> increase,"* so decreases are **valid data**, not resets.

### 7.1 `counter_agg()` — signature + accessors

```sql
counter_agg(
    ts     TIMESTAMPTZ,
    value  DOUBLE PRECISION
    -- optional bounds parameter to define the time range for extrapolation
) RETURNS CounterSummary
```

| Accessor | Meaning |
|---|---|
| `delta(cs)` | total change in the counter's value over the period (reset-aware) |
| `rate(cs)` | average rate of change (per second) |
| `irate_left/right(cs)` | instantaneous rate at the left/right boundary |
| `idelta_left/right(cs)` | instantaneous change at the boundary |
| `num_resets(cs)` | how many resets occurred |
| `num_changes(cs)` | how many times the value changed |
| `num_elements(cs)` | number of points |
| `time_delta(cs)` | elapsed time covered |
| `extrapolated_delta(cs)` / `extrapolated_rate(cs)` | estimate the change/rate over the **full bounds** (Prometheus-style edge extrapolation) |
| `slope/intercept/corr(cs)` | linear-regression view of the counter |
| `counter_zero_time(cs)` | estimated time the counter was zero |

> Full accessor list verbatim from [Tiger counter_agg API](https://www.tigerdata.com/docs/api/latest/hyperfunctions/counters-and-gauges/counter_agg).
> Plus `rollup()` to *"combine multiple counter aggregates."*

```sql
-- Reset-aware per-minute rate from a cumulative counter [license: TSL]:
SELECT time_bucket('1 min', ts) AS bucket,
       device_id,
       delta(counter_agg(ts, requests_total)) AS requests_in_bucket,
       rate(counter_agg(ts, requests_total))  AS requests_per_sec
FROM device_metrics
GROUP BY 1, 2
ORDER BY 1;
```

```sql
-- Continuous aggregate of counter summaries + rollup to a coarser rate:
CREATE MATERIALIZED VIEW reqs_1m
WITH (timescaledb.continuous) AS
    SELECT time_bucket('1 min', ts) AS bucket, device_id,
           counter_agg(ts, requests_total) AS cs
    FROM device_metrics
    GROUP BY 1, 2
WITH NO DATA;

SELECT time_bucket('1 hour', bucket) AS hour, device_id,
       delta(rollup(cs)) AS reqs_in_hour,
       rate(rollup(cs))  AS reqs_per_sec_hour
FROM reqs_1m
GROUP BY 1, 2;
```

### 7.2 `gauge_agg()` — when decreases are real

```sql
gauge_agg(ts TIMESTAMPTZ, value DOUBLE PRECISION) RETURNS GaugeSummary
```

Accessors mirror counters but treat down-moves as data: `delta`, `extrapolated_delta`,
`interpolated_delta`, `rate`, `extrapolated_rate`, `interpolated_rate`, `idelta_left/right`,
`irate_left/right`, `corr`, `slope`, `intercept`, `gauge_zero_time`, `num_changes`, `num_elements`,
`time_delta`.

```sql
-- Warehouse temperature change & rate per hour (decreases are NOT resets) [license: TSL]:
WITH hourly AS (
    SELECT time_bucket('1 hour'::interval, ts) AS hour,
           gauge_agg(ts, temperature) AS gauge_summary
    FROM sensors
    WHERE location = 'warehouse'
    GROUP BY hour
)
SELECT hour,
       delta(gauge_summary) AS temp_change,
       rate(gauge_summary)  AS temp_change_rate
FROM hourly
ORDER BY hour;
```

> `gauge_agg` example verbatim + accessor list from [Tiger gauge_agg API](https://www.tigerdata.com/docs/api/latest/hyperfunctions/counters-and-gauges/gauge_agg).

| Pick | When |
|---|---|
| `counter_agg` | the series **only increases**, resets to 0 on restart (request totals, bytes, cumulative volume) |
| `gauge_agg` | the series **goes up and down** legitimately (temperature, queue depth, in-flight orders, open interest) |

> **Markets use:** cumulative traded volume that resets at session open → `counter_agg`. Open interest
> or net position that rises and falls → `gauge_agg`. Using `counter_agg` on a gauge mis-reads every
> legitimate dip as a reset and inflates the delta — a silent correctness bug (F1: a wrong number that
> *looks* fine).

---

## 8. The two-step aggregation pattern — the spine that makes everything compose

Everything above is the same machine. State it once, formally, so a reviewer can grade any new
hyperfunction usage against it.

### 8.1 The three roles

1. **Aggregate function** (`*_agg`, `time_weight`, `percentile_agg`, `stats_agg`): scans raw rows →
   builds a **machine-readable partial-aggregate object**. Cheap to store, mergeable.
2. **Accessor function** (`open`, `average`, `approx_percentile`, `rate`, `delta`): reads a **final,
   human-readable answer** out of that object. Multiple accessors share one object's state.
3. **`rollup()`**: merges many partial-aggregate objects into one **coarser** partial-aggregate object,
   *logically consistently* — so re-aggregation has no statistical error.

### 8.2 Why it exists — the four documented reasons (verbatim)

> From [`docs/two-step_aggregation.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/two-step_aggregation.md):
> 1. *"It allows different accessor function calls to use the same internal state and not redo work."*
> 2. *"It cleanly distinguishes the parameters that affect the aggregate and those that only affect the
>    accessor."*
> 3. *"It makes it explicit how and when aggregates can be re-aggregated or 'stacked' on themselves with
>    logically consistent results."*
> 4. *"It allows for better retrospective analysis of downsampled data in continuous aggregates."*

### 8.3 The canonical composition with continuous aggregates

```sql
-- STEP 1 — aggregate, stored in a continuous aggregate (built once, incrementally maintained):
CREATE MATERIALIZED VIEW foo_15
WITH (timescaledb.continuous) AS
    SELECT id,
           time_bucket('15 min', ts) AS bucket,
           percentile_agg(val) AS pct        -- store the SKETCH, not a percentile
    FROM foo
    GROUP BY id, time_bucket('15 min', ts)
WITH NO DATA;

-- STEP 2 — rollup the stored aggregates to a coarser bucket, THEN accessor at read time:
SELECT id,
       time_bucket('1 day', bucket) AS day,
       approx_percentile(0.5, rollup(pct)) AS median
FROM foo_15
GROUP BY id, time_bucket('1 day', bucket);
```

> Composition verbatim from [`docs/two-step_aggregation.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/two-step_aggregation.md).
> The cagg stores the **partial aggregate** (`percentile_agg` → a sketch); the day-level query
> `rollup()`s the 15-minute sketches and only **then** applies the accessor. **Store the summary in the
> view; apply the accessor at read time** — never store the final scalar, or you lose the ability to
> roll up.

### 8.4 The rule of thumb for our codebase

> **In a continuous aggregate, store the `*_agg` object. Never store its accessor's scalar output.**
> `SELECT close(candlestick)` belongs in the *query against* the cagg, not in the cagg's `SELECT`. The
> moment you materialize `close(...)` you have thrown away the `Candlestick` and can no longer `rollup`
> to a coarser timeframe. Same for `average(stats_agg)`, `approx_percentile(...)`, `rate(...)`,
> `average(time_weight(...))`. **Materialize the noun (`Candlestick`/`StatsSummary`/`UddSketch`); apply
> the verb (`close`/`average`/`approx_percentile`) at read time.**

---

## 9. How these reduce app-side math — the "push the stat into SQL" recipe

The reason this doc exists: in a Python/FastAPI analytics service, the *wrong* default is to `SELECT *`
the raw rows and compute statistics in pandas/numpy. That ships **O(rows)** over the wire, re-implements
(buggily) what the database already does correctly, and cannot be incrementally maintained.

| App-side anti-pattern (pull rows, loop in Python) | SQL-native replacement | Net effect |
|---|---|---|
| pull ticks, loop to compute OHLC per timeframe | `candlestick_agg` + accessors + `rollup()` (§3) | candles over the wire, not ticks; multi-timeframe free |
| `np.mean` on irregular samples | `average(time_weight(...))` (§4) | correct *time-weighted* mean; no resampling in Python |
| pandas `.rolling().std()` over a pulled frame | `rolling(stats_agg(...))` window (§5.2) | moving stats computed on stored summaries |
| `np.polyfit` for beta/alpha per pair | `slope/intercept/corr(stats_agg(y,x))` (§5.3) | regression in one indexed aggregate |
| sort + `np.percentile` for p99 | `approx_percentile(0.99, percentile_agg(...))` (§6) | sketch, rollup-able, cagg-maintainable |
| `max - min` on a resetting counter (WRONG) | `delta(counter_agg(...))` (§7) | reset-aware, correct |
| every-Nth-row or `avg()` bucket for a chart | `lttb(...)` (§2.1) | shape-preserving decimation, keeps spikes |

**The recipe, generalized:**

1. Identify the statistic the API endpoint returns.
2. Find its `*_agg` (§3–§7). **Store that aggregate in a continuous aggregate** keyed by the smallest
   bucket any consumer needs (`patterns-continuous-aggregates.md`).
3. The HTTP handler issues a **thin** query: `time_bucket` (coarser) + `rollup(agg)` + the accessor,
   `WHERE` on the entity + time range, `LIMIT`/paginate. Return **the computed scalars**, never raw
   rows.
4. For chart endpoints, wrap the result series in `lttb(...)` to cap payload at the pixel budget.
5. Tag every series' provenance with its license — and remember **the Toolkit itself is TSL** (§1.2),
   which is a *dependency/deployment* tag, separate from each data series' upstream-source license.

> **R-SCALE note (state the tier).** Two-step aggregates + continuous aggregates are the **10,000×**
> answer for read-heavy stat endpoints: the heavy scan happens **once** during cagg materialization
> (off the request path, on the refresh policy / worker), and every API read is an indexed scan of a
> tiny materialized table + a cheap `rollup`+accessor. A *Tier-1* implementation (compute the stat from
> raw rows on every request) survives the demo and dies at traction; the cagg-stored two-step aggregate
> is what makes it survive a spike. **The break it prevents:** p99-latency or OHLC endpoints that do a
> full hypertable scan per request. Move the aggregate into a cagg before that endpoint is "done".

---

## 10. Anti-patterns → fixes (grading checklist)

| Mistake | Why it breaks | Fix |
|---|---|---|
| Assuming the Toolkit is present because `timescaledb` is | vanilla image ships **core only**; `function … does not exist` | `CREATE EXTENSION timescaledb_toolkit;` in the bootstrap migration; use the `-ha` image / Tiger Cloud (§1.1) |
| Hardcoding `toolkit_experimental.` in a migration | the function may **graduate** out of that schema on upgrade → call breaks | probe the live schema (§1.3 query) or pin the toolkit version; only qualify experimentals (`asap_smooth`, sometimes `lttb`) |
| Storing `close(candlestick)` (a scalar) in a continuous aggregate | throws away the `Candlestick` → **cannot `rollup`** to a coarser timeframe | store `candlestick_agg(...)`; apply `close()` in the read query (§8.4) |
| `avg()` of hourly `avg()`s; `avg()` of percentiles | naïve re-aggregation is **statistically wrong** unless counts are equal / meaningless for percentiles | `rollup(stats_agg)` then `average`; `rollup(sketch)` then `approx_percentile` (§5.4, §6.2) |
| `avg(price)` on irregular ticks | overweights dense periods, underweights plateaus | `average(time_weight('Linear', ts, price))` (§4) |
| `max - min` on a Prometheus-style counter | a **reset** to 0 makes the delta wrong/negative | `delta(counter_agg(ts, val))` — reset-aware (§7.1) |
| `counter_agg` on a value that legitimately decreases | every real dip read as a reset → inflated delta | `gauge_agg` (§7.2) |
| `asap_smooth` on a price chart a trader acts on | smoothing **erases the real spike** the user needed | `lttb` for decision surfaces; reserve `asap_smooth` for overview dashboards (§2.3) |
| `tdigest` when you need order-independent reproducibility (audit) | tdigest is **input-order dependent** | `uddsketch`/`percentile_agg` — deterministic & order-independent (§6.3) |
| Treating the Toolkit as Apache/OSS in the deploy/legal doc | it is **TSL**, not OSI-approved; changes deploy + a DBaaS-resale story | tag it **TSL** in the architecture doc; only *core* TimescaleDB is Apache (§1.2) |
| Pulling raw rows into pandas to compute a stat the DB has | O(rows) over the wire, buggy re-impl, no incremental maintenance | push the stat into SQL via the matching `*_agg` (§9) |

---

## 11. Verification status & open items

- **Confirmed by primary docs / repo:** install + TSL license (`LICENSE`, install-toolkit, Tiger
  licensing); `lttb`/`asap_smooth` signatures + experimental status (`docs/lttb.md`, `docs/asap.md`);
  `candlestick_agg` signature, return, accessor list + runnable OHLCV/rollup examples (Tiger
  candlestick_agg docs + timescaledb-ruby tutorial + PR #596); `time_weight` signature/methods/accessors
  + runnable examples (Tiger time-weighted docs/API); `stats_agg` 1D signature + accessors + BIGINT
  constraint (Tiger stats API); `percentile_agg`/`approx_percentile`/`uddsketch`/`tdigest` signatures,
  algorithm trade-off, rollup example (`two-step_aggregation.md` + Tiger percentile API);
  `counter_agg`/`gauge_agg` signatures + accessor lists + runnable examples (Tiger counters-and-gauges
  API); the four reasons + the cagg composition (`docs/two-step_aggregation.md`, verbatim).
- **`[unverified — confirm with \df]`:** the exact **argument order of `candlestick()`** (the
  pseudo-aggregate) — its dedicated docs page 404'd during research; the *behavior* (lift OHLC into the
  `Candlestick` type for rollup/accessors) is confirmed, the precise positional signature should be read
  off the installed version with `\df candlestick`.
- **`[unverified across versions]`:** whether `lttb` requires the `toolkit_experimental.` prefix —
  documented experimental in the repo but appears unqualified in some current Tiger docs/tutorials.
  Resolve per install with the §1.3 `pg_proc` probe.
- **General rule:** these are **version-sensitive** (the Toolkit ships frequently and promotes functions
  between schemas/releases). Pin the toolkit version in the Docker tag for the analytics service, and
  treat every signature here as "confirm against the pinned version's `\df`" before shipping a
  migration.

---

## 12. Sources

Primary (read this run):

- [`timescaledb-toolkit/docs/README.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/README.md) — function catalogue + stable/experimental + `toolkit_experimental` schema.
- [`timescaledb-toolkit/docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md) — LTTB signature + example.
- [`timescaledb-toolkit/docs/asap.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/asap.md) — ASAP smoothing signature + example.
- [`timescaledb-toolkit/docs/two-step_aggregation.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/two-step_aggregation.md) — the pattern, the four reasons, the percentile + cagg examples.
- [`timescaledb-toolkit/LICENSE`](https://github.com/timescale/timescaledb-toolkit/blob/main/LICENSE) — the repo is TSL.
- [Tiger Data — install/update/uninstall Toolkit](https://www.tigerdata.com/docs/deploy/self-hosted/tooling/install-toolkit) — `CREATE EXTENSION`, privileges, per-database enable.
- [Tiger Data — Software Licensing (TSL)](https://www.tigerdata.com/legal/licenses) — Apache-core vs TSL-Community split.
- [Tiger Data — candlestick_agg()](https://www.tigerdata.com/docs/api/latest/hyperfunctions/financial-analysis/candlestick_agg) — signature, return, accessor list.
- [timescale/timescaledb-toolkit PR #596](https://github.com/timescale/timescaledb-toolkit/pull/596) — "Introduce Candlestick Aggregate".
- [timescaledb-ruby — Candlesticks tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_candlestick/) — runnable OHLCV + accessor + rollup SQL.
- [Tiger Data — Time-weighted averages](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/time-weighted-averages) + [API time_weight](https://www.tigerdata.com/docs/api/latest/hyperfunctions/time-weighted-calculations/time_weight).
- [Tiger Data — Statistical aggregation](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/stats-aggs) + [API stats_agg one-variable](https://www.tigerdata.com/docs/api/latest/hyperfunctions/statistical-and-regression-analysis/stats_agg-one-variable).
- [Tiger Data — Percentile approximation advanced agg](https://www.tigerdata.com/docs/use-timescale/latest/hyperfunctions/percentile-approx/advanced-agg) + [API uddsketch](https://www.tigerdata.com/docs/api/latest/hyperfunctions/percentile-approximation/uddsketch) + [API tdigest](https://www.tigerdata.com/docs/api/latest/hyperfunctions/percentile-approximation/tdigest).
- [Tiger Data — counter_agg()](https://www.tigerdata.com/docs/api/latest/hyperfunctions/counters-and-gauges/counter_agg) + [gauge_agg()](https://www.tigerdata.com/docs/api/latest/hyperfunctions/counters-and-gauges/gauge_agg).
- [Tiger Data — Hierarchical continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates) — cagg-on-cagg + rollup.
- [DeepWiki — Toolkit install & setup](https://deepwiki.com/timescale/timescaledb-toolkit/2-installation-and-setup) — PG version support, packaging.

Background: [ASAP paper (arXiv:1703.00983)](https://arxiv.org/abs/1703.00983) — the smoothing algorithm behind `asap_smooth`.
