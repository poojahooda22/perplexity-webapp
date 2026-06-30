# Pattern: Server-Side Downsampling for Charts

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (the DataQuery / Fusion /
> Athena-class chart-serving layer) — **NOT Lumina**. Greenfield: this is a build recipe, not a map of
> existing code. The stack is **TimescaleDB (PostgreSQL + the `timescaledb` + `timescaledb_toolkit`
> extensions) + FastAPI + asyncpg**.

## What this recipe gives you

THE headline endpoint of a charting data-API: a request names a series, a time window, and a pixel
budget; the database reduces a raw series of millions of rows to **at most `max_points`** rows and ships
only those. The browser never receives — and the network never carries — the raw series.

The single rule that governs the whole file:

> **Never `SELECT *` a raw time-series to the client.** A chart canvas is ~600–1200 px wide. Every point
> beyond one-per-pixel is invisible on screen but fully paid for in DB I/O, JSON serialization, network
> bandwidth, and browser parse/layout time. The reduction is a **server** concern, executed in SQL, in
> the database, next to the data.

The proof of why this matters, from Timescale's own benchmarks and field reports:

- LTTB downsampling reduced **130,000 points → 750 points** (a ~99.5 % reduction), shrinking a JSON
  payload from **1.53 MB → 13 KB** while preserving the visible shape of the curve.
  ([rajnandan.com, *Largest Triangle Three Buckets*](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/);
  [phare.io, *Downsampling time series data*](https://phare.io/blog/downsampling-time-series-data/))
- Timescale's own LTTB tutorial reduced a **~14.7 MB** raw temperature series to **~5 KB** (~3,000× smaller),
  and doing the reduction **in SQL ran ~10× faster** than the equivalent reduction in application code
  (0.69 s vs 7.04 s).
  ([Timescale Ruby docs, *Toolkit LTTB tutorial*](https://timescale.github.io/timescaledb-ruby/toolkit_lttb_tutorial/))

Those two numbers — 99.5 % fewer rows, ~10× faster than app-side — are the entire economic argument for
this pattern. Memorize them; they are why the reducer lives in the DB.

---

## Section 1 — The contract

### 1.1 The endpoint shape

```
GET /v1/series/{series_id}/chart
    ?from=2026-01-01T00:00:00Z
    &to=2026-06-24T00:00:00Z
    &max_points=800
    &kind=line            # line | candles | minmax
```

The response is bounded: **`len(response.points) <= max_points`**, always, regardless of how many raw
rows fall in `[from, to)`. That bound is the contract. A client requesting 6 months of 1-second ticks
(≈15.7 M rows) and a client requesting 1 hour of the same series both get back **≤ `max_points`** rows.

`max_points` defaults to **800** because that is roughly the horizontal pixel resolution a chart is drawn
at, and it is the figure Timescale's own ASAP implementation targets by default ("The output is
approximately 800 points of smoothed data").
([WebSearch: Timescale toolkit asap_smooth](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/asap.md))
There is no value in returning more points than the chart has pixels — every extra point lands on a pixel
that already has one.

### 1.2 What "at most N points" buys you, by tier (R-SCALE)

| Tier | Raw rows in window | Naive `SELECT *` payload | This recipe (`max_points=800`) |
|---|---|---|---|
| 1× (demo) | 1 k–10 k | ~10 KB–120 KB | ~13 KB, fixed |
| 100× (traction) | 100 k–1 M | ~1.5 MB–18 MB → browser jank | ~13 KB, fixed |
| 10,000× (product) | 10 M–100 M | **browser/tab crash, multi-second TTFB** | ~13 KB, fixed + read from a continuous aggregate |

The point of the table: **the naive approach gets linearly worse with data; this recipe is flat.** The
response size is governed by `max_points` (the screen), not by the window or the ingest rate. That flatness
is the whole design goal. At Tier 3 the flatness is preserved only if you *also* read from a pre-rolled
continuous aggregate rather than scanning raw rows — that is Section 6.

### 1.3 The reducer is chosen by chart type

There is no single correct reducer. The reducer must match what the chart *means*:

| `kind` | Reducer family | Why |
|---|---|---|
| `candles` | OHLC: `time_bucket` + `first`/`max`/`min`/`last` **or** `candlestick_agg` | A candle's body needs the open & close *and* the wick needs the true high & low of the bucket. `avg()` would erase all four. |
| `line` | **LTTB** (`lttb(time, value, resolution)`) | A price/metric line must keep its *visual shape* — the peaks and valleys a human reads. LTTB preserves the silhouette; `avg()` flattens it. |
| `minmax` | min/max **envelope** (`time_bucket` + `min`/`max`, two points per bucket) | Monitoring/anomaly views must never hide a spike. The envelope guarantees the extreme of every bucket survives. |

The remaining sections build each of the three, then wire them behind one FastAPI handler.

---

## Section 2 — Why `avg()` is the wrong reducer (the load-bearing mistake)

The intuitive reducer — "bucket the data and average each bucket" — is **wrong** for both candlestick and
line charts, and the failure is not subtle. Averaging is a **low-pass filter**: it deletes exactly the
high-frequency information (spikes, gaps, sharp reversals) that a financial or monitoring chart exists to
show.

Two concrete failures:

1. **`avg()` destroys candle bodies and wicks.** A 1-minute candle that opened at 100, spiked to 130,
   crashed to 95, and closed at 102 has OHLC = (100, 130, 95, 102). `avg()` over that minute returns a
   single number near ~104 — the open, close, high, and low are all gone. The candlestick is *defined* by
   four order-statistics; an average is none of them.

2. **`avg()` flattens the line's shape.** LTTB exists precisely because averaging "would obscure these
   critical events" — isolated spikes that represent genuine signal. Timescale's downsampling guidance is
   explicit that the LTTB algorithm "is specifically designed to preserve the overall shape of the curve
   [and] will keep any anomalies in the final data set," whereas an averaging-only approach loses them.
   ([phare.io, *Downsampling time series data*](https://phare.io/blog/downsampling-time-series-data/))

The numbers that make this concrete are the same ones from the top: LTTB took **130 k → 750** points
(**1.53 MB → 13 KB**) *while keeping the visible peaks*. An `avg()` rollup to 750 points would be the same
size on the wire but a **different, smoothed, wrong** curve — the spikes that a trader or an SRE is looking
for would be averaged into the baseline.
([rajnandan.com](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/))

> **The rule:** `avg()` is correct only when the chart's *meaning* is "the central tendency of each bucket"
> (e.g. a smoothed trend line where spikes are noise). For price candles, shape-preserving lines, and
> anomaly monitoring — the three things a markets data-analytics product charts — `avg()` silently lies.
> Use OHLC, LTTB, or the min/max envelope respectively.

There is one legitimate averaging reducer: **`asap_smooth`**, which is an *intentional* smoother ("preserves
the rough shape and larger trends while minimizing local variance between points"). Use it only when the
product *wants* a de-noised trend, never as a generic decimator.
([Timescale toolkit asap docs](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/asap.md))

---

## Section 3 — Decimation math: pick the bucket so `points <= max_points`

Before any reducer runs, you must size the bucket. The goal: choose a bucket width `W` such that the number
of buckets across the window is **≤ `max_points`**.

### 3.1 The formula

Let the window be `span = to - from` (a duration in seconds). For `n` target buckets:

```
W = ceil(span / max_points)        # bucket width, in the same unit as span
```

Using `ceil` (round **up**) is the guard: rounding up can only *reduce* the number of buckets, so

```
num_buckets = ceil(span / W) <= max_points       # always holds
```

If you rounded *down*, `num_buckets` could be `max_points + 1` and you'd break the contract. **Always round
the width up.**

Worked examples (`max_points = 800`):

| Window span | `span / 800` | Chosen `W` | Buckets returned |
|---|---|---|---|
| 1 hour (3,600 s) | 4.5 s | **5 s** | 720 |
| 1 day (86,400 s) | 108 s | **120 s (2 min)** | 720 |
| 30 days (2,592,000 s) | 3,240 s | **3,600 s (1 h)** | 720 |
| 1 year (31,536,000 s) | 39,420 s | **43,200 s (12 h)** | ~730 |

### 3.2 Snap to "nice" widths (and to a precomputed CAGG level)

Raw `ceil` produces ugly widths (4.5 s → 5 s is fine, but 108 s is awkward). Two refinements:

1. **Snap up to a human-friendly width** from a ladder: `1s, 5s, 15s, 30s, 1m, 5m, 15m, 1h, 6h, 12h, 1d, 1w`.
   Pick the smallest ladder rung `≥ W`. This keeps bucket boundaries aligned to clock time (so caches and
   continuous aggregates line up) and keeps `num_buckets ≤ max_points` (a wider bucket means fewer buckets).

2. **Snap to a continuous-aggregate level when one exists** at or below `W` — see Section 6. If you maintain
   1m / 1h / 1d CAGGs and `W` snaps to `1h`, read the 1h CAGG directly instead of `time_bucket`-ing raw rows.

```python
# Bucket-width selection: ceil(span/max_points) snapped up to a clock-friendly rung.
from datetime import timedelta

# Ladder in seconds. Each rung is a clean clock division.
_LADDER = [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 21600, 43200, 86400, 604800]

def choose_bucket_seconds(span_seconds: float, max_points: int) -> int:
    """Smallest ladder rung W such that ceil(span/W) <= max_points.

    Rounding the width UP can only reduce the bucket count, so the
    contract num_buckets <= max_points always holds.
    """
    if max_points < 1:
        raise ValueError("max_points must be >= 1")
    raw = span_seconds / max_points            # exact width if we ignored the ladder
    for rung in _LADDER:
        if rung >= raw:
            return rung
    return _LADDER[-1]                          # window so wide even 1w buckets exceed budget

def pg_interval(seconds: int) -> str:
    """Render a bucket width as a Postgres interval literal for time_bucket()."""
    return f"{seconds} seconds"
```

> **Why ceil, not round:** `round()` can round the width *down* (e.g. 108 s → 100 s), which *increases*
> the bucket count above the budget. `ceil`/snap-up is a one-directional guard. This is the single arithmetic
> bug that breaks the contract; the test in Section 7.3 pins it.

### 3.3 The LTTB exception to the bucket math

`lttb(time, value, resolution)` takes the **point budget directly** as `resolution` — you do **not** compute
a bucket width for it. LTTB does its own internal bucketing (it divides the input into `resolution` buckets
and picks one representative point per bucket; see Section 5.1). So for `kind=line`, pass
`resolution = max_points`; the bucket math in 3.1 is only for the OHLC and min/max families, which use
explicit `time_bucket`.

---

## Section 4 — Reducer family 1: OHLC candles

### 4.1 The raw approach — `time_bucket` + `first`/`max`/`min`/`last`

The canonical, version-portable OHLC query needs four order-statistics per bucket:

- **open** = the *first* price by time → `first(price, time)`
- **high** = the *max* price → `max(price)`
- **low** = the *min* price → `min(price)`
- **close** = the *last* price by time → `last(price, time)`

`first(value, time)` and `last(value, time)` are TimescaleDB hyperfunctions that return the `value` of the
row with the earliest / latest `time` in the group — exactly the open/close semantics. (`min(price)`/
`max(price)` are plain SQL aggregates.) From Timescale's own FX tick → OHLC tutorial:

```sql
-- One bucket = one candle. The four order-statistics ARE the candle.
SELECT
    time_bucket('1 minute', time)      AS bucket,
    symbol,
    first(price, time)                 AS open,    -- first tick in the minute
    max(price)                         AS high,    -- highest tick
    min(price)                         AS low,     -- lowest tick
    last(price, time)                  AS close    -- last tick in the minute
FROM ticks
WHERE symbol = $1 AND time >= $2 AND time < $3
GROUP BY bucket, symbol
ORDER BY bucket;
```

([tradermade.com, *Real-Time Market Data to OHLC Candles*](https://tradermade.com/tutorials/6-steps-fx-stock-ticks-ohlc-timescaledb))

For a quote stream with separate `bid`/`ask`, the same tutorial uses the mid-price `(bid + ask) / 2` inside
each accessor:

```sql
SELECT
    time_bucket('1 minute', time)      AS bucket,
    symbol,
    first((bid + ask) / 2, time)       AS open,
    max((bid + ask) / 2)               AS high,
    min((bid + ask) / 2)               AS low,
    last((bid + ask) / 2, time)        AS close
FROM tick_data
WHERE symbol = $1 AND time >= $2 AND time < $3
GROUP BY bucket, symbol
ORDER BY bucket;
```

Parameterized for the dynamic bucket width from Section 3 (asyncpg `$n` placeholders; the interval is a bound
literal, not string-concatenated — see Section 7.2):

```sql
SELECT
    time_bucket($4::interval, time)    AS bucket,
    first(price, time)                 AS open,
    max(price)                         AS high,
    min(price)                         AS low,
    last(price, time)                  AS close,
    sum(volume)                        AS volume      -- optional, for volume bars
FROM ticks
WHERE series_id = $1 AND time >= $2 AND time < $3
GROUP BY bucket
ORDER BY bucket;
```

### 4.2 The toolkit approach — `candlestick_agg` + accessors

The Toolkit ships a purpose-built two-step aggregate that packages all four order-statistics (plus volume &
VWAP) into one `Candlestick` object, then exposes accessors. This was added in response to
[issue #445](https://github.com/timescale/timescaledb-toolkit/issues/445), whose motivation is the exact
problem above: users "frequently perform repetitive OHLC bucketing using separate MAX/MIN/FIRST/LAST
functions," and re-aggregating those raw columns to a coarser bucket is unsafe (you can't `max(max)` then
`first(first)` correctly from already-collapsed columns in general). The aggregate fixes both.

**Signature** ([Timescale `candlestick_agg()` API docs](https://www.tigerdata.com/docs/api/latest/hyperfunctions/financial-analysis/candlestick_agg)):

```sql
candlestick_agg(
    ts     TIMESTAMPTZ,
    price  DOUBLE PRECISION,
    volume DOUBLE PRECISION
) RETURNS Candlestick
```

> The return is "an object storing `(timestamp, value)` pairs for each of the opening, high, low, and
> closing prices, in addition to information used to calculate the total volume and Volume Weighted Average
> Price." ([candlestick_agg API docs](https://www.tigerdata.com/docs/api/latest/hyperfunctions/financial-analysis/candlestick_agg))

**Build the aggregate, one per bucket:**

```sql
SELECT
    time_bucket('1 minute', time)         AS bucket,
    symbol,
    candlestick_agg(time, price, volume)  AS candlestick
FROM ticks
GROUP BY bucket, symbol
ORDER BY bucket;
```

**Extract OHLC + volume + VWAP with accessors** (the full accessor set, from Timescale's candlestick
tutorial):

```sql
SELECT
    symbol,
    bucket,
    open(candlestick),
    high(candlestick),
    low(candlestick),
    close(candlestick),
    open_time(candlestick),   -- timestamp of the open tick
    high_time(candlestick),   -- timestamp the high was hit
    low_time(candlestick),    -- timestamp the low was hit
    close_time(candlestick),  -- timestamp of the close tick
    volume(candlestick),      -- total volume in the bucket
    vwap(candlestick)         -- volume-weighted average price
FROM candlesticks_1m;
```

([Timescale Ruby docs, *Toolkit Candlesticks tutorial*](https://timescale.github.io/timescaledb-ruby/toolkit_candlestick/))

**The killer feature — `rollup()` re-aggregation.** A `Candlestick` can be combined into a coarser bucket
*correctly* without touching raw ticks. This is what makes one CAGG serve many zoom levels:

```sql
-- Roll 1-minute candlesticks up to 1-hour candlesticks. open stays the
-- earliest open, close stays the latest close, high/low stay the extremes.
SELECT
    time_bucket('1 hour', bucket) AS hour_bucket,
    symbol,
    rollup(candlestick)           AS candlestick   -- combine, don't re-derive
FROM candlesticks_1m
GROUP BY hour_bucket, symbol
ORDER BY hour_bucket;
```

([Timescale Ruby candlestick tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_candlestick/))

> **Why `rollup()` is correct and naive re-aggregation is not:** you cannot, in general, reconstruct a
> coarser candle from a table of already-collapsed `open/high/low/close` columns using plain SQL — `high`
> and `low` re-aggregate fine (`max(high)`, `min(low)`), but `open`/`close` require knowing *which* sub-bucket
> was first/last in time, information a flattened column loses. `candlestick_agg` keeps the
> `(timestamp, value)` pairs inside the object so `rollup()` can pick the true earliest open and latest
> close. This is the whole reason issue #445 asked for the aggregate instead of telling people to
> `first()/last()` by hand. ([issue #445](https://github.com/timescale/timescaledb-toolkit/issues/445))

### 4.3 Which OHLC approach to use

| Use… | When |
|---|---|
| Raw `first/max/min/last` (§4.1) | Single fixed resolution; no toolkit installed; simplest dependency surface. |
| `candlestick_agg` + accessors (§4.2) | You serve **multiple zoom levels** (1m → 1h → 1d) and want `rollup()` to derive each from the level below, plus free VWAP/volume. This is the recommendation for a markets product. |

For the chart endpoint, the bucket width is **dynamic** (Section 3), so use whichever underlies a CAGG at
the chosen level (Section 6); between CAGG levels, fall back to raw `first/max/min/last` over the hypertable
with the computed `time_bucket($interval)`.

---

## Section 5 — Reducer family 2: shape-preserving line (LTTB)

### 5.1 What LTTB is

**LTTB = Largest-Triangle-Three-Buckets** (Sveinn Steinarsson's 2013 algorithm). It downsamples a line to
`resolution` points while preserving the *visual silhouette* — the peaks and valleys a human reads off the
chart. The mechanism:

1. The first and last points of the series are **always kept**.
2. The remaining points are split into `resolution - 2` equal-time buckets.
3. For each bucket, it picks the **one** point that forms the **largest-area triangle** with (a) the point
   already selected in the *previous* bucket and (b) the *average* of the *next* bucket. Largest triangle
   = the point that contributes most to the curve's visible shape (the sharpest deviation), so spikes and
   reversals survive while flat runs collapse to a single point.

This is why LTTB beats both naive every-Nth-point sampling (which can step right over a spike) and `avg()`
(which smooths the spike away): the triangle-area criterion is explicitly a *shape* criterion.
([rajnandan.com, *Largest Triangle Three Buckets*](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/);
[MinMaxLTTB paper, arXiv:2305.00332](https://arxiv.org/pdf/2305.00332))

It is the industry default for this job: Uber's M3 metrics platform ships LTTB as a downsampling function,
and TimescaleDB exposes it as a server-side hyperfunction.
([rajnandan.com](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/))

### 5.2 The exact TimescaleDB signature and return type

```sql
lttb(
    time       TIMESTAMPTZ,
    value      DOUBLE PRECISION,
    resolution INTEGER          -- number of output points (<= resolution returned)
) RETURNS Timevector
```

- The **signature** `lttb(TIMESTAMPTZ, DOUBLE PRECISION, INTEGER)` and the documented return name
  (`SortedTimevector` in the API docs) come from the
  [Timescale downsampling hyperfunction docs](https://www.tigerdata.com/docs/api/latest/hyperfunctions/downsampling)
  and [`docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md).
- The **actual internal return type** in the Rust source is
  `Timevector_TSTZ_F64` — the `lttb_final` aggregate function is declared
  `-> Option<Timevector_TSTZ_F64<'static>>`, surfaced to SQL as a sorted timevector.
  ([`extension/src/lttb.rs`](https://github.com/timescale/timescaledb-toolkit/blob/main/extension/src/lttb.rs))
- `resolution` is "the number of points the output should have," and the function returns **at most** that
  many points. ([`docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md))

A `Timevector` is an opaque aggregate object holding the selected `(time, value)` pairs; you do not read it
directly — you **`unnest()`** it back into rows.

> **Version / schema caveat (verify against your installed toolkit):** in current Toolkit, `lttb` is
> **stable** and lives in the default schema (call it as `lttb(...)`). In older Toolkit versions it lived in
> `toolkit_experimental` (the Ruby tutorial calls `toolkit_experimental.lttb(...)` and
> `toolkit_experimental.unnest(...)`). The **gap-preserving** variant `gp_lttb` is *still* experimental
> (`toolkit_experimental.gp_lttb(time, value, gap_interval, resolution)`). Run
> `\df *lttb*` to confirm the schema on your instance before pinning a query.
> ([Downsampling overview](https://www.tigerdata.com/docs/reference/toolkit/downsampling);
> [Ruby LTTB tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_lttb_tutorial/);
> [lttb.rs](https://github.com/timescale/timescaledb-toolkit/blob/main/extension/src/lttb.rs))

### 5.3 The `unnest()` expansion pattern

The result of `lttb(...)` is a single `Timevector` value. To turn it into chartable rows, wrap it in a
subquery and `unnest()` it:

```sql
-- Canonical LTTB query: aggregate to a Timevector, then unnest to (time, value) rows.
SELECT time, value
FROM unnest((
    SELECT lttb(time, price, 800)        -- 800 = max_points, passed straight through
    FROM ticks
    WHERE series_id = $1 AND time >= $2 AND time < $3
)) ;
```

This is the exact pattern from Timescale's docs (`SELECT time, value FROM unnest((SELECT lttb(time, val,
N) FROM ...))`).
([`docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md);
[downsampling hyperfunction docs](https://www.tigerdata.com/docs/api/latest/hyperfunctions/downsampling))

Parameterized for the endpoint (resolution = `max_points`, bound as `$4`):

```sql
SELECT t.time, t.value
FROM unnest((
    SELECT lttb(time, price, $4::int)
    FROM ticks
    WHERE series_id = $1 AND time >= $2 AND time < $3
)) AS t(time, value)
ORDER BY t.time;
```

> **Note the LTTB-specific contract:** you pass `max_points` directly as `resolution`. You do **not**
> compute a `time_bucket` width for LTTB (it buckets internally). The Section-3 bucket math is only for the
> OHLC and min/max families. Passing `resolution = max_points` is what keeps the response `<= max_points`.

### 5.4 Ordering and NULL hygiene

- LTTB conceptually requires **time-ordered input**; the aggregate consumes points as an ordered series. In
  practice feed it from a hypertable (already time-ordered on the chunk) or add `ORDER BY time` inside the
  inner aggregate's source if you've joined/unioned. The Rust `lttb_trans` accepts `Option<f64>` for the
  value, so **NULL values are tolerated** at the type level — but a NULL price is not a chartable point;
  filter `WHERE price IS NOT NULL` to avoid gaps being interpolated into the triangle math. For *intended*
  gaps (market closed overnight), use `gp_lttb(time, value, '1 hour'::interval, resolution)` so the gap is
  preserved as a break in the line instead of a straight interpolation across the close.
  ([lttb.rs `lttb_trans`/`gp_lttb_trans`](https://github.com/timescale/timescaledb-toolkit/blob/main/extension/src/lttb.rs))

### 5.5 The performance receipt

LTTB's reduction is dramatic *and* cheap because it runs in the DB:

- **130,000 → 750 points; 1.53 MB → 13 KB** payload.
  ([rajnandan.com](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/);
  [phare.io](https://phare.io/blog/downsampling-time-series-data/))
- **~14.7 MB → ~5 KB** (~3,000×) in Timescale's tutorial, with the SQL path **~10× faster** than the
  application-side equivalent (0.69 s vs 7.04 s) — the argument for doing it *in the database*, not in
  Python after a `SELECT *`.
  ([Ruby LTTB tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_lttb_tutorial/))

---

## Section 6 — Reducer family 3: min/max envelope (monitoring)

### 6.1 When to use it

For **monitoring / anomaly** charts (latency, error rate, vibration, order-book depth pressure), the chart's
job is to **never hide a spike**. LTTB preserves *most* spikes but is a shape heuristic, not a guarantee; an
average hides them outright. The **min/max envelope** gives a hard guarantee: it emits, per bucket, **exactly
the minimum and the maximum** point — so the most extreme value in every bucket is, by construction, present
in the output.

> "MIN() and MAX() preserve the range of behavior in downsampled time series data… emit min and max values
> alongside the current value so that spikes are preserved even at lower resolution." The MinMax method
> "retains extreme values by returning the min and max point from each group… effectively creat[ing] an
> 'envelope' around the original data." Converting 1-second readings into 1-minute rollups "reduces data
> volume by more than 98% while preserving the overall [pattern]; engineers still see changes in amplitude,
> identify spikes, and compare trends."
> ([WebSearch: min/max envelope downsampling](https://oneuptime.com/blog/post/2026-02-02-timescaledb-downsampling/view))

### 6.2 The SQL

The envelope returns **two rows per bucket** (min and max), so to stay within `max_points` you size buckets
for **`max_points / 2`** buckets, not `max_points`:

```sql
-- min/max envelope: two points per bucket (the bucket's extremes), each
-- carrying the timestamp at which that extreme occurred so the renderer
-- can place them in the right time order within the bucket.
WITH bucketed AS (
    SELECT
        time_bucket($4::interval, time) AS bucket,
        min(value)                      AS lo,
        max(value)                      AS hi,
        -- the actual times the extremes occurred, for correct x-placement
        first(time, value)              AS lo_time,   -- time of the min value
        last(time, value)               AS hi_time    -- time of the max value
    FROM metrics
    WHERE series_id = $1 AND time >= $2 AND time < $3
    GROUP BY bucket
)
SELECT bucket, lo, hi, lo_time, hi_time
FROM bucketed
ORDER BY bucket;
```

> **`first(time, value)` / `last(time, value)` trick:** `first(a, b)` returns `a` from the row with the
> minimum `b`; `last(a, b)` returns `a` from the row with the maximum `b`. So `first(time, value)` is *the
> timestamp at which the minimum value occurred*, and `last(time, value)` is *the timestamp of the maximum*.
> That lets the frontend draw each extreme at its true x-position inside the bucket, which makes the
> envelope read like a candlestick wick rather than two arbitrary dots. (Same `first/last` hyperfunctions as
> §4.1, with the argument order swapped.)

The frontend renders the envelope as a filled band between `lo` and `hi`, or as two line series. **Budget
math:** because each bucket yields 2 rows, call `choose_bucket_seconds(span, max_points // 2)` for this
`kind`.

### 6.3 Envelope vs LTTB vs OHLC — the one-line rule

| Chart meaning | Reducer | Guarantee |
|---|---|---|
| "What did this asset trade at, candle by candle?" | OHLC | open/high/low/close exact per bucket |
| "What is the *shape* of this metric over time?" | LTTB | visual silhouette preserved (heuristic) |
| "Did this metric *ever spike*, even between samples?" | min/max envelope | bucket extreme always present (guaranteed) |

---

## Section 7 — Reading from a continuous aggregate (the Tier-3 move)

At Tier 3 (10 M–100 M raw rows in a window), even a `time_bucket` scan over the raw hypertable is too slow —
you'd read every raw row to collapse it. The fix: **pre-roll** the buckets into a **continuous aggregate**
(CAGG), a materialized, incrementally-maintained `time_bucket` rollup. When the chart's chosen bucket width
*matches* a precomputed CAGG level, read the CAGG (tiny, indexed) instead of the raw hypertable.

### 7.1 Build a hierarchy of CAGGs

Build the smallest base level on the raw hypertable, then build coarser levels **on the level below** (a
"hierarchical continuous aggregate"). The constraint: a CAGG's bucket "should be greater than or equal to…
and a multiple of the underlying time bucket."
([WebSearch: hierarchical continuous aggregates](https://docs.timescale.com/timescaledb/latest/how-to-guides/continuous-aggregates/hierarchical-continuous-aggregates))

```sql
-- LEVEL 1: 1-minute candlesticks off raw ticks (real-time aggregation on).
CREATE MATERIALIZED VIEW candle_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    series_id,
    candlestick_agg(time, price, volume) AS candle   -- keep the AGG, not flat OHLC
FROM ticks
GROUP BY bucket, series_id;

-- LEVEL 2: 1-hour candlesticks rolled up FROM the 1-minute level (not raw ticks).
CREATE MATERIALIZED VIEW candle_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    series_id,
    rollup(candle) AS candle                          -- correct re-aggregation
FROM candle_1m
GROUP BY time_bucket('1 hour', bucket), series_id;

-- LEVEL 3: 1-day, rolled up from 1-hour. Same pattern.
CREATE MATERIALIZED VIEW candle_1d
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    series_id,
    rollup(candle) AS candle
FROM candle_1h
GROUP BY time_bucket('1 day', bucket), series_id;
```

Storing the **`candlestick_agg` object** (not flat OHLC columns) in each CAGG is what lets the next level
`rollup()` it correctly — this is exactly the §4.2 argument applied to the materialization layer.

> **`materialized_only = false`** turns on **real-time aggregation**: a query against the CAGG unions the
> materialized rows with a live `time_bucket()` over the *most recent* raw rows not yet materialized, so the
> latest candle is never stale. ([WebSearch: continuous aggregates real-time aggregation](https://github.com/timescale/docs.timescale.com-content/blob/master/using-timescaledb/continuous-aggregates.md))

### 7.2 Route the chosen bucket width to the matching level (and fall back to raw between levels)

```python
# Map the chosen bucket width to the coarsest CAGG level <= W, else raw hypertable.
# Each tuple: (level_bucket_seconds, relation_name, is_cagg)
_CANDLE_LEVELS = [
    (86400, "candle_1d", True),
    (3600,  "candle_1h", True),
    (60,    "candle_1m", True),
]

def pick_candle_source(bucket_seconds: int):
    """Return (relation, level_seconds, is_cagg).

    Use the coarsest CAGG whose bucket evenly divides the requested width
    AND is <= it, so we can rollup() the CAGG up to the requested width.
    Between levels (e.g. a 7-minute width with only 1m/1h/1d CAGGs), fall
    back to the 1m CAGG and roll it up; below the smallest level, hit raw.
    """
    for level_secs, rel, _ in _CANDLE_LEVELS:
        if bucket_seconds >= level_secs and bucket_seconds % level_secs == 0:
            return rel, level_secs, True
    # requested width finer than the smallest CAGG -> read raw ticks
    return "ticks", None, False
```

- **Exact match** (`bucket_seconds == level_secs`): `SELECT bucket, open(candle), high(candle), low(candle),
  close(candle) FROM candle_1h WHERE …` — no rollup needed, just read.
- **Coarser, divisible** (`bucket_seconds == k * level_secs`): read the level and `rollup()` it up to the
  requested width in the query (`time_bucket($W, bucket)` + `rollup(candle)`).
- **Finer than the smallest level**: fall back to raw — `time_bucket($W, time)` + `candlestick_agg(time,
  price, volume)` over the `ticks` hypertable for the (narrow) window. At fine resolution the window is by
  definition short (you only zoom that far on a small time range), so the raw scan is bounded.

This three-way routing — exact CAGG / rollup CAGG / raw fallback — is the standard "multiple zoom levels"
pattern; the only real difficulty Timescale flags is the UNION plumbing across levels, which the
`pick_candle_source` router encapsulates.
([WebSearch: continuous aggregates zoom levels](https://github.com/timescale/timescaledb-toolkit/issues/445))

### 7.3 LTTB on top of a CAGG

LTTB itself can run over a CAGG's per-bucket value (e.g. `close`) to shape-preserve a long line cheaply:
materialize 1m closes, then `lttb(bucket, close, 800)` over the 1m CAGG for a 1-year line instead of LTTB
over raw ticks. The CAGG cuts the input from millions of ticks to ~525 k minute-rows; LTTB then cuts that to
800. Two cheap reductions beat one expensive scan.

---

## Section 8 — The complete FastAPI + asyncpg handler

This is the full endpoint: one route, the bucket math, the three reducers, CAGG routing, and JSON shaped for
a charting frontend (Lightweight Charts / ECharts / uPlot all accept this `{t, o, h, l, c}` / `{t, v}` shape).

### 8.1 Connection pool (app lifespan)

asyncpg's documented server pattern is `asyncpg.create_pool()` at startup, `pool.acquire()` per request.
([asyncpg usage docs](https://magicstack.github.io/asyncpg/current/usage.html))

```python
# db.py — one shared pool for the process, created at app startup.
import asyncpg
from contextlib import asynccontextmanager
from fastapi import FastAPI

DSN = "postgresql://app:secret@db.internal:5432/markets"

async def _init_conn(conn: asyncpg.Connection) -> None:
    # asyncpg returns TIMESTAMPTZ as tz-aware datetime; we convert to epoch-ms
    # at serialization time (below), so no codec needed for the time column.
    # If you store JSONB anywhere, register the json codec here:
    #   await conn.set_type_codec("json", encoder=json.dumps,
    #                             decoder=json.loads, schema="pg_catalog")
    pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(
        DSN, min_size=4, max_size=20, init=_init_conn,
        command_timeout=10.0,   # a chart query that runs >10s is a bug, fail fast
    )
    try:
        yield
    finally:
        await app.state.pool.close()
```

### 8.2 The reducer SQL builders

```python
# reducers.py — each builder returns (sql, params) ready for pool.fetch.
# series_id/from/to are bound params ($1/$2/$3); the bucket interval and the
# LTTB resolution are bound too ($4) — NEVER string-concatenated (SQL-injection
# + plan-cache hygiene). The relation name is the ONLY identifier chosen in
# Python, and it comes from a fixed allowlist (pick_candle_source), never user input.

from datetime import datetime

def build_candles_sql(relation: str, level_secs, bucket_secs: int):
    """OHLC candles. If reading a CAGG, rollup() its candlestick to the
    requested width; if raw, candlestick_agg the ticks."""
    if relation == "ticks":
        # raw fallback: aggregate ticks directly at the requested bucket width
        sql = """
            SELECT
                time_bucket($4::interval, time) AS bucket,
                open(cs)  AS o, high(cs) AS h,
                low(cs)   AS l, close(cs) AS c,
                volume(cs) AS v
            FROM (
                SELECT time_bucket($4::interval, time) AS b,
                       candlestick_agg(time, price, volume) AS cs
                FROM ticks
                WHERE series_id = $1 AND time >= $2 AND time < $3
                GROUP BY b
            ) q
            ORDER BY bucket;
        """
        # NB: the outer time_bucket is redundant with q.b; kept explicit for clarity.
        return sql, None  # see note below — prefer the CAGG path
    # CAGG path: read the level and rollup() up to the requested width.
    sql = f"""
        SELECT
            time_bucket($4::interval, bucket) AS bucket,
            open(rcs)  AS o, high(rcs) AS h,
            low(rcs)   AS l, close(rcs) AS c,
            volume(rcs) AS v
        FROM (
            SELECT time_bucket($4::interval, bucket) AS b,
                   rollup(candle) AS rcs
            FROM {relation}                       -- allowlisted relation, not user input
            WHERE series_id = $1 AND bucket >= $2 AND bucket < $3
            GROUP BY b
        ) q
        ORDER BY bucket;
    """
    return sql, None

def build_line_sql() -> str:
    """Shape-preserving line via LTTB. resolution ($4) = max_points; NO bucket
    width is computed for LTTB — it buckets internally."""
    return """
        SELECT t.time AS bucket, t.value AS v
        FROM unnest((
            SELECT lttb(time, price, $4::int)
            FROM ticks
            WHERE series_id = $1 AND time >= $2 AND time < $3
              AND price IS NOT NULL
        )) AS t(time, value)
        ORDER BY t.time;
    """

def build_minmax_sql() -> str:
    """min/max envelope: two rows per bucket (the bucket extremes + their times)."""
    return """
        SELECT
            time_bucket($4::interval, time) AS bucket,
            min(value)         AS lo,
            max(value)         AS hi,
            first(time, value) AS lo_time,
            last(time, value)  AS hi_time
        FROM metrics
        WHERE series_id = $1 AND time >= $2 AND time < $3
        GROUP BY bucket
        ORDER BY bucket;
    """
```

### 8.3 The route handler

```python
# chart.py
from datetime import datetime, timezone
from typing import Literal
from fastapi import APIRouter, Query, Request, HTTPException

from .reducers import build_candles_sql, build_line_sql, build_minmax_sql
from .bucketing import choose_bucket_seconds, pg_interval
from .levels import pick_candle_source

router = APIRouter()

Kind = Literal["line", "candles", "minmax"]

def _epoch_ms(dt: datetime) -> int:
    """asyncpg hands back tz-aware datetimes; charts want epoch milliseconds."""
    return int(dt.timestamp() * 1000)

@router.get("/v1/series/{series_id}/chart")
async def chart(
    request: Request,
    series_id: str,
    frm: datetime = Query(..., alias="from"),
    to: datetime = Query(...),
    max_points: int = Query(800, ge=2, le=5000),
    kind: Kind = Query("line"),
):
    # --- validate window ---
    if to <= frm:
        raise HTTPException(422, "`to` must be after `from`")
    # normalize to UTC-aware (asyncpg binds tz-aware datetimes to TIMESTAMPTZ)
    frm = frm.astimezone(timezone.utc)
    to = to.astimezone(timezone.utc)
    span_s = (to - frm).total_seconds()
    pool = request.app.state.pool

    # --- choose reducer + params ---
    if kind == "line":
        # LTTB takes the point budget directly; no bucket-width math.
        sql = build_line_sql()
        params = [series_id, frm, to, max_points]

    elif kind == "candles":
        bucket_s = choose_bucket_seconds(span_s, max_points)
        relation, level_secs, _is_cagg = pick_candle_source(bucket_s)
        sql, _ = build_candles_sql(relation, level_secs, bucket_s)
        params = [series_id, frm, to, pg_interval(bucket_s)]

    elif kind == "minmax":
        # envelope returns 2 rows/bucket -> size for max_points/2 buckets.
        bucket_s = choose_bucket_seconds(span_s, max(1, max_points // 2))
        sql = build_minmax_sql()
        params = [series_id, frm, to, pg_interval(bucket_s)]
    else:
        raise HTTPException(422, f"unknown kind {kind!r}")

    # --- execute (single round-trip; the DB did the reduction) ---
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    # --- shape JSON for the frontend; enforce the contract one last time ---
    if kind == "candles":
        points = [
            {"t": _epoch_ms(r["bucket"]), "o": r["o"], "h": r["h"],
             "l": r["l"], "c": r["c"], "v": r["v"]}
            for r in rows
        ]
    elif kind == "minmax":
        points = [
            {"t": _epoch_ms(r["bucket"]), "lo": r["lo"], "hi": r["hi"],
             "loT": _epoch_ms(r["lo_time"]), "hiT": _epoch_ms(r["hi_time"])}
            for r in rows
        ]
    else:  # line
        points = [{"t": _epoch_ms(r["bucket"]), "v": r["v"]} for r in rows]

    # Defense in depth: the SQL already bounds this, but assert the contract.
    assert len(points) <= max_points, (
        f"contract violated: {len(points)} > {max_points} for kind={kind}"
    )

    return {
        "series_id": series_id,
        "kind": kind,
        "from": _epoch_ms(frm),
        "to": _epoch_ms(to),
        "count": len(points),
        "points": points,
    }
```

### 8.4 Why this handler is correct, line by line

- **`max_points` is `ge=2, le=5000`.** LTTB needs ≥2 (it always keeps first+last). The upper cap (5000)
  stops a client from defeating the whole point by asking for "all of them via a huge N."
- **Params are bound (`$1..$4`), the relation name is allowlisted.** asyncpg uses native prepared
  statements; the time bounds, series id, interval, and resolution are all parameters — no string
  interpolation of user input into SQL. The only Python-chosen identifier is the **relation name**, and it
  comes from `pick_candle_source`'s fixed list, never the request. (asyncpg `pool.acquire()` /
  `conn.fetch($n, ...)` is the documented parameterized API.
  ([asyncpg usage docs](https://magicstack.github.io/asyncpg/current/usage.html)))
- **`command_timeout=10`.** A chart query touching a correctly-sized CAGG returns in single-digit ms; if one
  takes >10 s, the routing or an index is wrong — fail fast rather than pile up connections.
- **The `assert len(points) <= max_points`** is belt-and-suspenders. The SQL already guarantees it (LTTB by
  `resolution`, the others by `ceil` bucket math), but the assert turns a future regression into a loud test
  failure instead of a silent fat payload.
- **`_epoch_ms`** converts asyncpg's tz-aware `datetime` (asyncpg maps `TIMESTAMPTZ` → aware `datetime`
  automatically) to epoch-milliseconds, the x-axis unit every JS charting lib expects. Don't ship ISO
  strings to a chart — they cost parse time per point on the client.
  ([asyncpg usage docs](https://magicstack.github.io/asyncpg/current/usage.html))

---

## Section 9 — Indexing & the read-path checklist

The reduction is only fast if the window scan is fast. The non-negotiables:

1. **Hypertable on `time`.** `SELECT create_hypertable('ticks', 'time')` — chunk pruning means the
   `WHERE time >= $2 AND time < $3` only touches the chunks in range, not the whole table.
2. **Composite index `(series_id, time DESC)`** on the raw hypertable (and on each CAGG keyed by
   `(series_id, bucket)`). The chart query always filters one series over a time range; without this index
   each request is a per-chunk scan filtering `series_id` row by row.
3. **CAGGs for every zoom level you actually serve** (§7). A 1-year line over raw 1s ticks without a CAGG
   reads ~31 M rows even though it returns 800 — the CAGG turns that into reading ~525 rows (1d level) +
   rollup. **The reducer alone is Tier-2; reducer + CAGG is Tier-3.**
4. **`max_points` capped server-side** (`le=5000`). The cap is part of the contract, not a suggestion.
5. **Set a `statement_timeout` / `command_timeout`** so a pathological window can't hold a pooled connection
   open and starve the pool under a read spike.

---

## Section 10 — Anti-patterns (mistake → fix)

| Mistake | Why it breaks | Fix |
|---|---|---|
| `SELECT time, price FROM ticks WHERE time BETWEEN …` shipped to the client | 1.53 MB+ payloads, browser jank, O(rows) everything — the exact failure this recipe replaces | Reduce in SQL; ship ≤ `max_points`. |
| `avg(price)` to downsample a price line or candles | Erases spikes (line) and all four order-statistics (candles) — a *different, wrong* curve | LTTB for lines, `first/max/min/last` (or `candlestick_agg`) for candles. |
| `round()` instead of `ceil()` for bucket width | Can round down → `num_buckets > max_points` → contract violated | `ceil`/snap-up only; never round down a bucket width. |
| Computing a `time_bucket` width for the LTTB path | LTTB buckets internally; an extra outer bucket double-decimates and mangles the shape | Pass `max_points` straight in as `resolution`; no width math for `kind=line`. |
| Re-aggregating flat OHLC columns to a coarser bucket with `first(open)`/`last(close)` | `open`/`close` need the earliest/latest *sub-bucket by time*; a flattened column lost that | Store `candlestick_agg` in the CAGG and `rollup()` it. |
| min/max envelope sized for `max_points` buckets | 2 rows/bucket → returns `2 × max_points` rows, breaks the contract | Size for `max_points / 2` buckets. |
| String-interpolating `from`/`to`/interval into SQL | SQL injection + plan-cache pollution | Bind as `$1..$4`; only the allowlisted **relation name** is chosen in Python. |
| LTTB over raw ticks for a multi-year line | Reads tens of millions of rows per request even though it returns 800 | LTTB over the matching CAGG level (§7.3): two cheap reductions. |
| Shipping ISO-8601 timestamps to the chart | Per-point string parse on the client; defeats the bandwidth win | Convert to epoch-ms server-side (`_epoch_ms`). |
| Interpolating LTTB across a market-closed gap | Draws a fake straight line over the overnight/weekend gap | `gp_lttb(time, value, gap_interval, resolution)` to preserve the gap. |
| `kind=candles` with no `max_points` cap | Client requests `max_points=10_000_000` → universe-to-client again | Cap `le=5000` server-side. |

---

## Sources

- **LTTB signature, return type, unnest pattern** — Timescale Toolkit
  [`docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md);
  [downsampling hyperfunction API](https://www.tigerdata.com/docs/api/latest/hyperfunctions/downsampling);
  internal `Timevector_TSTZ_F64` return + `gp_lttb` in
  [`extension/src/lttb.rs`](https://github.com/timescale/timescaledb-toolkit/blob/main/extension/src/lttb.rs);
  schema/stability in [downsampling overview](https://www.tigerdata.com/docs/reference/toolkit/downsampling).
- **OHLC** — feature motivation & `rollup` rationale in
  [toolkit issue #445](https://github.com/timescale/timescaledb-toolkit/issues/445);
  `candlestick_agg(ts, price, volume) RETURNS Candlestick` + return-object description in
  [candlestick_agg API docs](https://www.tigerdata.com/docs/api/latest/hyperfunctions/financial-analysis/candlestick_agg);
  full accessor set (`open/high/low/close/open_time/.../volume/vwap`) + `rollup()` example in
  [Timescale Ruby candlestick tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_candlestick/);
  raw `time_bucket` + `first/max/min/last` + continuous-aggregate `CREATE MATERIALIZED VIEW` in
  [tradermade, *Real-Time Market Data to OHLC Candles*](https://tradermade.com/tutorials/6-steps-fx-stock-ticks-ohlc-timescaledb).
- **Why `avg()` is wrong / LTTB preserves shape; 130k→750, 1.53MB→13KB** —
  [phare.io, *Downsampling time series data*](https://phare.io/blog/downsampling-time-series-data/);
  [rajnandan.com, *Largest Triangle Three Buckets*](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/);
  algorithm internals + MinMax preselection in
  [MinMaxLTTB, arXiv:2305.00332](https://arxiv.org/pdf/2305.00332);
  ~14.7 MB→~5 KB + SQL-vs-app 10× in
  [Timescale Ruby LTTB tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_lttb_tutorial/).
- **min/max envelope for monitoring** —
  [oneuptime, *How to Implement Downsampling in TimescaleDB*](https://oneuptime.com/blog/post/2026-02-02-timescaledb-downsampling/view)
  (min/max preserve extremes, 2-points-per-bucket envelope, 98% reduction).
- **asap_smooth (the legitimate averaging reducer)** —
  [Timescale Toolkit `docs/asap.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/asap.md).
- **Continuous aggregates / hierarchical CAGGs / real-time aggregation / zoom levels** —
  [Timescale hierarchical continuous aggregates](https://docs.timescale.com/timescaledb/latest/how-to-guides/continuous-aggregates/hierarchical-continuous-aggregates);
  [continuous-aggregates how-to](https://github.com/timescale/docs.timescale.com-content/blob/master/using-timescaledb/continuous-aggregates.md).
- **FastAPI + asyncpg** — pool/`acquire`/`fetch`/`Record`/JSON-codec patterns in
  [asyncpg usage docs](https://magicstack.github.io/asyncpg/current/usage.html);
  TIMESTAMPTZ ↔ datetime serialization in
  [Neon, *High-Performance Sensor Data API with FastAPI and TimescaleDB*](https://neon.com/guides/timescale-fastapi).
