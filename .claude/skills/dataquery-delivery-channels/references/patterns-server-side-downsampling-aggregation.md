# Pattern: Server-Side Downsampling + Frequency Aggregation at the Retrieval Boundary

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (the DataQuery / Fusion /
> Athena-class query API + dashboard) — **NOT Lumina**. Greenfield: this is a build recipe, not a map of
> existing code. The retrieval boundary is the **TypeScript gateway** (Express 5, Vercel serverless) that
> serves `GET /series` to the dashboard; the store behind it is **TimescaleDB** (PostgreSQL + the
> `timescaledb` + `timescaledb_toolkit` extensions) reached through the **Python data plane**
> (FastAPI + asyncpg).

## Scope — what THIS file owns, and what it delegates

This file is about the **`/series` API contract**: the two server-side reductions a retrieval request may
ask for, the *parameters* that name them, and the *guardrails* the gateway enforces so that no caller —
dashboard panel or raw `curl` — can pull an unbounded payload. It is the **retrieval-boundary** view.

It is **deliberately NOT** the SQL-mechanics view. The raw SQL — the `lttb()` `unnest()` pattern, the
`time_bucket` + `first/max/min/last` OHLC builders, the `candlestick_agg` + `rollup()` continuous-aggregate
hierarchy, the bucket-width `ceil` math, and the complete FastAPI + asyncpg handler — lives in the **sibling
`timescaledb-timeseries` skill**, file
[`references/patterns-server-side-downsampling-charts.md`](../../timescaledb-timeseries/references/patterns-server-side-downsampling-charts.md).
**Read that file for the database mechanics. This file is the API contract over them.** Where the two touch,
this file cites the sibling rather than re-deriving the SQL.

| Concern | Owner |
|---|---|
| What `frequency` / `maxPoints` mean in the **public `/series` request**, and the verb, units, and floor for each | **this file** |
| The **mandatory default cap** so a raw HTTP call can't pull the universe; the per-frequency **minimum-interval floor** | **this file** |
| The end-to-end **request flow** (gateway → cache → data plane → store) and the contract-enforcement points | **this file** |
| The exact `lttb()` SQL, `candlestick_agg`/`rollup()`, bucket `ceil` math, `unnest`, the asyncpg handler | sibling [`timescaledb-timeseries`](../../timescaledb-timeseries/references/patterns-server-side-downsampling-charts.md) |
| How continuous aggregates are *built/materialized/maintained* (hierarchical CAGGs, real-time aggregation) | sibling [`timescaledb-timeseries` `theory-continuous-aggregates.md`](../../timescaledb-timeseries/references/theory-continuous-aggregates.md) |

The project design context for this contract is
[`.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)
§"Our system design" (the `GET /series` contract), §Scale(b) (charting a series out of a 130m-series
store), and Open Decisions 1 (downsampling method) + 5 (`maxPoints` default + minimum-interval floor) —
this file is the concrete recipe those open decisions resolve into.

---

## The one rule this whole file defends

> **The retrieval boundary never returns more points than the caller can use, and it decides that — not
> the caller.** Two reductions happen at this boundary and **only** here: (1) **frequency aggregation** —
> collapse to a coarser bucket (daily → monthly) served from a *pre-rolled* store, never a raw scan; and
> (2) **point-count downsampling** — reduce to a declared `maxPoints` via a shape-preserving reducer. The
> caller may *request* both, but the gateway enforces a **default `maxPoints` cap** and a **per-frequency
> minimum-interval floor** so that omitting a parameter, or asking for an absurd one, can never produce an
> unbounded or sub-native-resolution payload.

Everything below is the mechanism for that sentence.

---

## Section 1 — Why the API caps points at all (the failure it prevents)

The dashboard's binding scale constraint is **point-volume-per-query**, not aggregate request rate. The
project teardown makes this explicit: JPM DataQuery serves "4 billion+ hits/year" ≈ 127 req/s average — a
modest *sustained* rate that "says nothing about … the **point-volume-per-query** problem (charting a
20-year daily series in a browser)" (03-doc §"Scale-stat framing"). A product can be comfortable on request
throughput and still melt one tab at a time on point volume. So the cap is not a throughput defense; it is a
**per-response payload** defense.

### 1.1 The point-volume arithmetic, by series shape

A chart canvas in this product is **~600–1200 px wide** (the `IndexChart` measures its own width via a
`ResizeObserver`; 03-doc §"Components we REUSE"). Every data point beyond roughly one-per-horizontal-pixel
lands on a pixel that already has a point — it is invisible on screen but fully paid for in DB I/O, JSON
serialization, network bytes, and browser parse/layout/draw. The table below is the case *for* the cap:

| Series request | Raw points in window | Naive (no cap) payload* | Visible on a ~1000px chart | This recipe (cap ~800) |
|---|---|---|---|---|
| 1 month of **daily** | ~22 | ~1 KB | all ~22 | ~22 (under cap, untouched) |
| 1 year of **daily** | ~252 | ~10 KB | all ~252 | ~252 (under cap, untouched) |
| **20 years of daily** | **~5,200** | ~210 KB | only ~1,000 distinct | **≤ 800** (downsampled) |
| 1 year of **hourly** (mkt hrs) | ~1,640 | ~66 KB | ~1,000 | ≤ 800 (downsampled) |
| 1 month of **1-minute** | ~8,200 | ~330 KB | ~1,000 | ≤ 800 (downsampled) |
| 6 months of **1-second tick** | **~15.7 M** | **~600 MB → tab crash** | ~1,000 | ≤ 800 (downsampled from a CAGG) |

\* ≈ 40 bytes/point JSON for `{"t":<epoch-ms>,"v":<float>}`. The naive column grows linearly with the
window and the native frequency; the recipe column is **flat** — governed by `maxPoints` (the screen), not
by the window. That flatness is the entire design goal. (The flat-vs-linear framing and the 15.7M-row
6-months-of-1s-ticks figure are from the sibling SQL doc, §1.2; the project doc's own anchor is "20-year
daily series (~5k pts)" and "intraday melts SVG", 03-doc §Scale(b).)

### 1.2 The two distinct degradations a raw payload causes

These are different failure modes and both matter — a cap that fixes only one is not enough:

1. **Egress + transfer.** A 600 MB (or even a 1.5 MB) JSON body is a serialization cost on the server, a
   bandwidth cost on the wire (and a real money cost: Vercel/Cloud egress is billed per GB), and a parse
   cost on the client. The sibling doc's measured receipt: LTTB took a real series from **1.53 MB → 13 KB**
   (~99.5% smaller) while keeping the visible shape
   ([rajnandan.com, *Largest Triangle Three Buckets*](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/);
   [phare.io, *Downsampling time series data*](https://phare.io/blog/downsampling-time-series-data/)).
2. **SVG / DOM degradation at the renderer.** This is the one the project doc names: "intraday melts SVG"
   (03-doc §Scale(b)). The reason is concrete — the dashboard's primary chart, `IndexChart`, is a
   **hand-rolled inline SVG** (03-doc §"Charting stack": *no charting library is installed*; every chart is
   inline SVG). An SVG line/area chart creates **one DOM node per point** (or one giant `<path>` whose `d`
   attribute string grows linearly). At a few thousand points the browser's layout/paint cost and the path
   string size both start to stutter on pan/zoom; at tens of thousands the tab janks. Canvas/WebGL libs
   (Lightweight Charts ~10k+ pts at 60fps; Highcharts Boost ~1M) push the ceiling out, but they do **not**
   remove it — and the project's v1 chart is SVG, which has the *lowest* ceiling. Tiger Data's own
   slow-Grafana post measures the same wall: a query of "nearly 1.3 million data points … takes nearly 20
   seconds to load, pan, or zoom," cut by downsampling to "less than 0.5 % of the points" while the result
   was "barely distinguishable from the original"
   ([tigerdata.com, *Slow Grafana Performance? Learn How to Fix It Using Downsampling*](https://www.tigerdata.com/blog/slow-grafana-performance-learn-how-to-fix-it-using-downsampling)).

**Conclusion the cap is built on:** because (a) the chart can only *show* ~its-pixel-width points and (b)
the SVG renderer *degrades* well before canvas does, the right number of points to ship is "~the panel's
pixel width," and the boundary must be able to enforce that even when the caller forgets to ask. That is
Sections 4–5.

---

## Section 2 — Reduction #1: frequency aggregation (coarsen the bucket)

Frequency aggregation answers a *different* question from point-count downsampling, and conflating them is
the most common design error in this layer (see Anti-Patterns). Frequency aggregation is **semantic**: a
caller asks "give me this daily series *as monthly numbers*," and each output point is a **defined
statistic of a calendar bucket** (the month's average, sum, or end-of-period value). Point-count
downsampling is **cosmetic**: "give me at most N points that *look like* this series." A monthly request is
not "fewer daily points"; it is *different numbers* with their own meaning.

The reference contract for this is **FRED's `series/observations`** — the most-documented public
time-series API of this exact shape, and the one the project doc copies (03-doc §"Our system design": the
`/series` parameter shape is "copied from the universal contract (FRED `series/observations`, JPM
`/expressions/time-series`, World Bank Indicators)").

### 2.1 The FRED rule we copy verbatim: aggregate to a LOWER frequency only

FRED's frequency model, confirmed from the docs this run:

- **The frequency ladder is daily (highest) → annual (lowest).** Allowed `frequency` values:
  `d` (Daily), `w` (Weekly), `bw` (Biweekly), `m` (Monthly), `q` (Quarterly), `sa` (Semiannual),
  `a` (Annual), plus the week-ending-and-biweekly-anchored variants `wef`/`weth`/`wew`/`wetu`/`wem`/`wesa`/
  `wesu`, `bwew`/`bwem`
  ([sboysel.github.io/fredr — `fredr_series_observations` reference](https://sboysel.github.io/fredr/reference/fredr.html);
  list cross-confirmed against [fred.stlouisfed.org `series/observations`](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)).
- **You may aggregate ONLY to a lower frequency.** Verbatim from FRED: *"No frequency aggregation will
  occur if the frequency specified by the frequency parameter matches the native frequency of the series.
  For instance if the value of the frequency parameter is 'm' and the native frequency of the series is
  'Monthly', observations will be returned, but they will not be aggregated to a lower frequency.
  Additionally, an error will be returned if a frequency is specified that is higher than the native
  frequency of the series."*
  ([fred.stlouisfed.org `series/observations`](https://fred.stlouisfed.org/docs/api/fred/series_observations.html),
  as surfaced this run).

This is the **floor in disguise**: you cannot fabricate a finer resolution than the series natively has.
Asking a monthly series for daily values is not "interpolate" — it is an **error**. Our gateway copies this
exactly (Section 5: the minimum-interval floor). It also dovetails with the repo's #1 non-negotiable —
*never invent a finance number*: up-sampling a monthly series to daily would *manufacture* numbers that
were never observed. The FRED rule and the no-fabrication rule are the **same rule** seen from two angles.

### 2.2 The three aggregation methods (and the default)

When `frequency` coarsens the bucket, `aggregation_method` says how the sub-period values combine. FRED's
three, verbatim, with the default:

| `aggregation_method` | Meaning (FRED's exact words) | Right for |
|---|---|---|
| `avg` (**default**) | *"Calculates an average of the original series values and converts it to a lower frequency"* — e.g. 12 monthly values summed and ÷12 → the annual value. | levels / rates / index values (the central tendency of the period) |
| `sum` | *"Adds data values to convert to a lower frequency"* — e.g. 12 monthly values added → the annual value. | flows / counts (volume, issuance, units shipped) — a flow's annual value *is* the sum of its months |
| `eop` | *"End of Period … takes the last value at the end of the period"* — e.g. the December value becomes the annual value. | stocks / point-in-time levels (a closing price, an end-of-month balance, a yield level) |

Sources: the three methods and that **`avg` is the default** are confirmed from
[sboysel.github.io/fredr reference](https://sboysel.github.io/fredr/reference/fredr.html) and the FRED help
*"Edit the Frequency and Aggregation Method"* page; the descriptions are FRED's own
([fred.stlouisfed.org `series/observations`](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)).

> **Why the right `aggregation_method` is a correctness issue, not a cosmetic one.** Summing a price series
> is nonsense (the "annual price" is not Jan-price + Feb-price + …); averaging a flow understates the year
> (the "annual issuance" is not the average month). The wrong method does not error — it returns a number
> that is *quietly wrong*, which under the repo's #1 non-negotiable is the same severity as inventing one.
> The aggregation method is therefore a **per-series property in the catalog** (declared with the series),
> not a free knob the dashboard picks blindly. Default to `avg`, but every series whose semantics are
> "flow" or "stock" must carry `sum` / `eop` as its declared aggregation, and the dashboard's frequency
> picker uses that declared default.

### 2.3 The mechanism: serve the pre-rolled bucket, NEVER a raw scan

The performance half of frequency aggregation is: a monthly request must **not** scan every daily row and
`GROUP BY month` on the fly at request time. It must read a **pre-materialized monthly bucket** — a
**TimescaleDB continuous aggregate (CAGG)**. The "build it once, read it cheap" mechanism (hierarchical
CAGGs `1m → 1h → 1d`, `materialized_only=false` real-time aggregation, `candlestick_agg` + `rollup()` so a
coarser level derives correctly from the level below) is the sibling skill's territory — see
[`timescaledb-timeseries` §7 "Reading from a continuous aggregate"](../../timescaledb-timeseries/references/patterns-server-side-downsampling-charts.md)
and [`theory-continuous-aggregates.md`](../../timescaledb-timeseries/references/theory-continuous-aggregates.md).

The contract-level rule is simply: **the gateway's `/series` handler routes a `frequency` request to the
matching CAGG level**, and only falls through to a raw `time_bucket` scan for a window *finer* than the
smallest CAGG (where, by definition, the window is short, so the scan is bounded). The "use both together"
production pattern is well-established: continuous aggregates do the **storage-efficient frequency rollup**,
and LTTB (Section 3) runs **at query time over the aggregate** for the final point-count reduction
([the canonical two-stage setup is described across the TimescaleDB CAGG + LTTB literature](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates);
[Toolkit LTTB tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_lttb_tutorial/)).

So a 1-year line of a 1-second series is **two cheap reductions, never one giant scan**: read the 1-day (or
1-hour) CAGG (≈ hundreds–thousands of rows, not ~31 M raw rows) → LTTB that down to `maxPoints`. The
sibling doc §7.3 spells this out: *"The CAGG cuts the input from millions of ticks to ~525k minute-rows;
LTTB then cuts that to 800. Two cheap reductions beat one expensive scan."*

---

## Section 3 — Reduction #2: point-count downsampling (fit the pixels)

After frequency aggregation has chosen *which* numbers (the right statistic of the right bucket),
point-count downsampling chooses *how many* to ship: at most `maxPoints`. Two reducer families matter at the
boundary, and the choice is a **per-series / per-chart-kind** decision, not a global setting.

### 3.1 LTTB — the shape-preserving default for volatile lines

**LTTB = Largest-Triangle-Three-Buckets**, Sveinn Steinarsson's 2013 algorithm (Univ. of Iceland). It
reduces a line to `n_out` points while preserving the **visual silhouette** — the peaks, valleys, and sharp
reversals a human reads off the chart — which is exactly what an average destroys. Use it as the **default
for any volatile series** (prices, yields, spreads, FX, anything with spikes that carry meaning).

**The algorithm, verbatim from the primary sources** (so the gateway author knows what they are buying):

1. *"The first and last data points are preserved."* The remaining `n−2` points are split into `n−2`
   **equal-width buckets** along the time axis.
2. For each bucket, it selects *"the point in the current bucket that forms the largest triangle"* with
   (a) the point already selected in the **previous** bucket and (b) the **average of the next** bucket.
   The triangle area is `area = |x₁(y₂−y₃) + x₂(y₃−y₁) + x₃(y₁−y₂)| / 2`. *"By selecting points that
   maximize these areas, we preserve visual features: sharp turns, peaks, valleys, and trend changes."*
   ([rajnandan.com, *Largest Triangle Three Buckets*](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/))
3. After every bucket has contributed one point, the final original point is appended.

**Why it is the right default here — three load-bearing properties:**

- **Points come from the ORIGINAL set; outliers survive.** *"LTTB is a value-preserving aggregation method
  as it downsamples by selecting data points from the original time series"* — it never synthesizes a value
  ([as surfaced from the Toolkit downsampling literature](https://docs.timescale.com/api/latest/hyperfunctions/downsampling)).
  Sift's write-up: LTTB *"keeps the key visual characteristics intact while discarding less significant
  points,"* specifically preserving *"transient spikes that simpler methods miss"*; by contrast *"averaging
  data … can hide significant events that are clearly visible in the original"*
  ([siftstack, *LTTB downsampling*](https://www.siftstack.com/mission-critical/lttb-downsampling)). This
  matters for the repo's #1 non-negotiable: because every output point is a **real observed value**, LTTB
  cannot *invent* a finance number the way an interpolating/averaging reducer can blur one into existence.
- **O(n) time, O(1) memory.** *"LTTB has a time complexity of O(N) and a memory complexity of O(1)"* — one
  sequential pass. Measured pass times on modern hardware: *"10,000 points: 2ms; 100,000 points: 15ms;
  1,000,000 points: 150ms; 10,000,000 points: 1,500ms"*
  ([rajnandan.com](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/)). Cheap enough
  to run per-request.
- **The reduction is dramatic.** Tiger Data's slow-Grafana post: a real series cut to *"less than 0.5 % of
  the points"* with the result *"barely distinguishable from the original"*; a 315k-row, 5-second query
  became *"1,404 rows that took less than one second to fetch"*
  ([tigerdata.com](https://www.tigerdata.com/blog/slow-grafana-performance-learn-how-to-fix-it-using-downsampling)).
  The sibling SQL doc's headline receipt: **130k → 750 points, 1.53 MB → 13 KB.**

**One caveat (cited so the author doesn't trip on it):** *"LTTB cannot be parallelized, as it requires
sequential pass over the data since the previously selected data point is part of the local surface
calculation"* (the surface calc needs the prior selection), and it operates on a **single series** with a
**strictly increasing x and no NaN** input. The Python package enforces exactly that: it expects *"a
two-dimensional array of two columns"* where *"the values in the first column are strictly increasing"* and
*"there are no missing (NaN) values"*
([pypi.org/project/lttb](https://pypi.org/project/lttb/)). For multi-series compare, run LTTB **per series**
(not over a merged frame), and filter `NULL`/NaN before feeding it (or use the gap-preserving variant — the
sibling doc's `gp_lttb` note).

**Where LTTB actually runs (two valid placements, both cited):**

- **In the database, as a TimescaleDB hyperfunction** — `lttb(time, value, resolution) RETURNS
  SortedTimevector`; *"will construct and return a sorted timevector with at most `resolution` points"*;
  unnested back to rows with the `SELECT time, value FROM unnest((SELECT lttb(time, val, N) FROM …))`
  pattern ([timescaledb-toolkit `docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md);
  [Toolkit downsampling API](https://docs.timescale.com/api/latest/hyperfunctions/downsampling)). This is
  the **preferred** placement (reduce next to the data; ~10× faster than app-side per the sibling doc's
  benchmark). The exact SQL is the sibling skill's §5.
- **In the Python data plane, as the `lttb` PyPI package** — `lttb.downsample(data, n_out=20)` over a numpy
  `(N,2)` array ([pypi.org/project/lttb](https://pypi.org/project/lttb/)). Use this only when the source is
  not a TimescaleDB relation (e.g. an in-memory frame already assembled from Parquet), since doing it in
  SQL avoids shipping the raw rows out of the DB at all.

> **Boundary note:** whichever placement, `resolution`/`n_out` is fed **`maxPoints` directly** — LTTB does
> its own internal bucketing, so you do **not** compute a `time_bucket` width for it. (The Grafana recipe
> passes `2 * (($__to − $__from) / $__interval_ms)` as the resolution — i.e. ~2× the panel's pixel buckets,
> a small over-fetch so the renderer's own grouping has headroom;
> [tigerdata.com](https://www.tigerdata.com/blog/slow-grafana-performance-learn-how-to-fix-it-using-downsampling).)
> The bucket-width `ceil` math is only for the `time_bucket` reducers below, and it lives in the sibling
> doc §3.

### 3.2 `time_bucket` avg/min/max — the cheap rollup for OHLC and smooth series

For an **OHLC candle** request, or a series so smooth that averaging loses nothing, the cheaper reducer is a
plain `time_bucket` aggregate: bucket the window and emit the bucket's statistic(s).

- **OHLC** = `time_bucket(W, time)` + `first(price,time)` (open) / `max(price)` (high) / `min(price)` (low)
  / `last(price,time)` (close). A candle is *defined* by those four order-statistics; `avg()` would erase
  all four. The exact SQL, the `candlestick_agg`/`rollup()` toolkit form, and why you must store the
  aggregate (not flat OHLC columns) to re-roll correctly, are the **sibling doc's §4**.
- **Smooth-line `avg`** is legitimate *only* when the chart's meaning is "the central tendency of each
  bucket" (a de-noised trend where spikes are genuinely noise). For anything where a spike is signal, `avg`
  *"completely smooths away almost all of the peaks and valleys, and those are the most interesting parts of
  the dataset"* — use LTTB instead
  ([tigerdata.com](https://www.tigerdata.com/blog/slow-grafana-performance-learn-how-to-fix-it-using-downsampling)).

The production-standard guidance, cross-confirmed: **continuous aggregates (time_bucket rollups) do the
storage-efficient frequency reduction; LTTB does the query-time visual reduction.** Best-for, from the
literature: CAGGs/`time_bucket` are *"best for … OHLC (Open/High/Low/Close) data and financial tick data
… pre-computing 1-minute averages on raw 1-second metrics,"* while LTTB is *"best for reducing points for
charts … downsamples to 500-1000 points preserving visual fidelity"*
([cross-confirmed across the TimescaleDB CAGG-vs-LTTB literature](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates);
[nickb.dev, *Downsampling Timescale Data with Continuous Aggregations*](https://nickb.dev/blog/downsampling-timescale-data-with-continuous-aggregations/)).

### 3.3 Which reducer — the boundary decision table

| Chart / series kind | Reducer | Why | Output count budget |
|---|---|---|---|
| Volatile line (price, yield, spread, FX, an index level) | **LTTB** (`resolution = maxPoints`) | preserves spikes/shape; points are real observed values (no fabrication) | ≤ `maxPoints` |
| OHLC candles | `time_bucket` + `first/max/min/last` (or `candlestick_agg`) — sibling §4 | a candle *is* four order-statistics; `avg` erases them | ≤ `maxPoints` (size bucket for `maxPoints` buckets) |
| Smooth trend where spikes are noise | `time_bucket` + `avg` | the bucket's central tendency *is* the meaning here | ≤ `maxPoints` |
| Monitoring "did it ever spike" (rare in this product; common in infra) | min/max envelope (sibling §6) | guarantees the bucket extreme survives | ≤ `maxPoints` (2 rows/bucket → size for `maxPoints/2`) |

The default for a markets data-analytics product's primary series chart is **LTTB**; OHLC is the
candlestick chart kind; `avg` is opt-in for explicitly-smooth series. The choice rides on the series/chart
kind, which the dashboard already knows (it picked the chart type), so the gateway can pass a
`reducer`/`kind` hint, defaulting to LTTB.

---

## Section 4 — The `maxPoints` contract + the mandatory default cap

This is the crux of the file and the resolution of **Open Decision 5**.

### 4.1 What the panel declares

On the **dashboard panel path**, the chart declares its real pixel width and sends it as `maxPoints`. The
plumbing already exists in the components the project reuses: `IndexChart` measures itself with a
`ResizeObserver` (03-doc §"NEW components": *"pass `maxPoints = panelPixelWidth` from a `ResizeObserver`
(which `IndexChart` already uses)"*). So the panel→API request carries a *truthful* point budget:
"this chart is 920 px wide; do not send me more than ~920 points; they would land on pixels I already
drew." This is exactly Grafana's **UI default**, verbatim: *"The default value is the width (or number of
pixels) of the graph, because you can only visualize as many data points as the graph panel has room to
display"*
([grafana.com, *Query and transform data*](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/)).

### 4.2 The lesson the project doc pins: pixel-width is NOT free on the raw API path

Here is the trap, and why the cap is **mandatory and server-enforced**, not "the chart will send its
width." Grafana's pixel-width default is a **UI-panel** behavior. On its **raw HTTP-API** path — a `curl`,
a script, our own `GET /series` hit directly without a chart attached — there is *no panel*, so there is
**no pixel width to default to**, and Grafana falls back to a **fixed numeric default of 800**:

> *"When querying directly through the HTTP API … `maxDataPoints` is set to **800** by default. You can
> change this value by appending `&maxDataPoints=<number>`."*
> ([grafana.com docs, surfaced this run](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/))

The project doc states this lesson exactly and makes it our rule (03-doc §Scale(b)):

> *"`maxPoints` defaults to the panel's pixel width on the dashboard panel path; note that a direct HTTP-API
> call defaults to no cap, so our gateway must enforce a default `maxPoints` server-side (≈800, the Grafana
> HTTP-API default — confirmed … that Grafana's pixel-width default is a UI-panel behavior, while its
> HTTP-API path defaults to 800, not pixel-width). For us the chart sends its real pixel width;
> ~pixel-width is the design target to implement, not a default we inherit for free."*

**The contract, stated once:**

| Caller | `maxPoints` source | Result |
|---|---|---|
| Dashboard panel | the chart's real measured pixel width (e.g. 920) | server downsamples to ≤ 920 |
| Raw API (`curl`, script, our gateway hit directly) | **omitted** → server applies the **default cap = 800** | server downsamples to ≤ 800; a raw call can NEVER pull the universe |
| Any caller asking for an absurd value | `maxPoints` capped at a **hard server max** (e.g. 5000) | request for `maxPoints=10_000_000` is clamped to 5000 |

The default 800 is **defensible by precedent**, not arbitrary: it is Grafana's HTTP-API default; it is the
target ASAP/Toolkit smoothers aim for (*"approximately 800 points of smoothed data"*, sibling doc §1.1);
and it is ~the horizontal pixel resolution of a real chart. Use 800 as the gateway default unless a
Lumina-specific bench (Open Decision 1) says otherwise.

### 4.3 Express-gateway enforcement (the recipe)

The gateway is **TypeScript / Express 5** (03-doc: the `/catalog` and `/series` endpoints are "both on the
Express/TS gateway"). The cap is enforced as **request validation**, before any cache or data-plane call —
so a malformed or unbounded request is rejected at the door, never reaching the store.

```ts
// gateway/series-params.ts — parse + clamp the /series query into a validated shape.
// The cap is enforced HERE, at the boundary, so neither the cache key nor the data
// plane ever sees an unbounded maxPoints. (Express 5 + zod; mirrors the repo's
// ratelimit.ts/cache.ts boundary discipline.)
import { z } from "zod";

const DEFAULT_MAX_POINTS = 800;   // Grafana HTTP-API default; ~chart pixel width; ASAP target
const HARD_MAX_POINTS    = 5000;  // absolute ceiling: a client can't defeat the cap with a huge N

// FRED frequency ladder, highest -> lowest. The INDEX is the rank; a request may only
// move DOWN the ladder (coarser), never up (finer) than the series' native frequency.
const FREQ_LADDER = ["d", "w", "bw", "m", "q", "sa", "a"] as const;
type Freq = (typeof FREQ_LADDER)[number];

const AGG = ["avg", "sum", "eop"] as const;  // FRED's three; avg is the default
const KIND = ["line", "candles", "avg-line"] as const;

export const seriesQuerySchema = z.object({
  ids: z.string().min(1).transform((s) => s.split(",").map((x) => x.trim())),
  from: z.coerce.date(),
  to: z.coerce.date(),
  // frequency is OPTIONAL: omit => serve the series' native frequency (no aggregation).
  frequency: z.enum(FREQ_LADDER).optional(),
  // aggregation_method only applies when frequency coarsens; default avg (FRED default).
  aggregation: z.enum(AGG).default("avg"),
  // the point-count reducer; default line (LTTB).
  kind: z.enum(KIND).default("line"),
  // THE CAP. Omitted => DEFAULT_MAX_POINTS (the raw-API-path lesson). Present =>
  // clamped to [2, HARD_MAX_POINTS]. 2 is the LTTB minimum (it always keeps first+last).
  maxPoints: z.coerce.number().int().min(2).max(HARD_MAX_POINTS).default(DEFAULT_MAX_POINTS),
  cursor: z.string().optional(),  // for the raw/table pagination path, not the chart path
})
  .refine((q) => q.to > q.from, { message: "`to` must be after `from`", path: ["to"] });

export type SeriesQuery = z.infer<typeof seriesQuerySchema>;

// .max(HARD_MAX_POINTS) does the clamp for "absurd value"; .default() does the
// "omitted => 800" raw-API defense. Both are the contract — not suggestions.
```

```ts
// gateway/series-route.ts — the handler shell. Validate -> floor-check -> cache -> data plane.
import type { Request, Response } from "express";
import { seriesQuerySchema } from "./series-params.js";   // NB: .js extension (ESM/Vercel rule)
import { enforceMinIntervalFloor } from "./freq-floor.js";
import { getOrRefresh } from "../lib/cache.js";            // reuse repo cache.ts (SWR + de-dupe)
import { fetchSeriesFromDataPlane } from "./data-plane-client.js";

export async function seriesHandler(req: Request, res: Response) {
  // 1. Validate + clamp at the boundary. Bad/unbounded requests die here.
  const parsed = seriesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(422).json({ error: "invalid_series_request", detail: parsed.error.issues });
  }
  const q = parsed.data;

  // 2. Per-frequency MINIMUM-INTERVAL FLOOR: reject up-sampling below native resolution
  //    (the FRED "lower frequency only" rule). Section 5.
  const floor = await enforceMinIntervalFloor(q);  // throws 422 if q asks finer than native
  if (floor.rejected) {
    return res.status(422).json({ error: "frequency_above_native", detail: floor.detail });
  }

  // 3. Cache key MUST include every parameter that changes the output, incl. maxPoints,
  //    frequency, aggregation, kind. (A cache keyed only by id+range would serve a 920-pt
  //    body to an 800-pt request and vice versa — a correctness bug, not just a miss.)
  const cacheKey =
    `series:${q.ids.join(",")}:${+q.from}:${+q.to}:` +
    `${q.frequency ?? "native"}:${q.aggregation}:${q.kind}:${q.maxPoints}`;

  const payload = await getOrRefresh(cacheKey, () => fetchSeriesFromDataPlane(q));

  // 4. Defense in depth: the data plane already bounds this, but assert the contract.
  for (const s of payload.series) {
    if (s.points.length > q.maxPoints) {
      // a regression in the reducer must be a loud failure, not a silent fat payload
      throw new Error(`contract violated: ${s.id} returned ${s.points.length} > ${q.maxPoints}`);
    }
  }
  return res.json(payload);
}
```

The three enforcement points — **validation clamp** (step 1), **floor check** (step 2), and **post-fetch
assert** (step 4) — are belt-and-suspenders on purpose: the SQL reducer already guarantees ≤ `maxPoints`
(LTTB by `resolution`, the others by `ceil` bucket math), but the assert turns any future reducer
regression into a loud error instead of a silently-fat body.

> **Cache-key correctness (non-obvious, load-bearing).** The cache key in step 3 includes `maxPoints`,
> `frequency`, `aggregation`, and `kind` — every parameter that changes the *output bytes*. The repo's
> `cache.ts` `getOrRefresh` discipline (SWR + in-flight de-dupe) only serves the right thing if the key
> captures everything that changes the answer. A key of just `id:from:to` would let a 920-pixel panel and an
> 800-default raw call collide and serve each other's payload — the right *shape*, wrong *count*. This is
> the standard "is the cache keyed by everything that changes the output" battery question (R70 §B4), and
> here the answer must be yes.

---

## Section 5 — The per-frequency minimum-interval floor (can't ask below native)

`maxPoints` caps the **top** (no more than N points). The **minimum-interval floor** caps the **bottom**:
a request may not ask for a resolution **finer than the series natively has**. This is the FRED *"an error
will be returned if a frequency is specified that is higher than the native frequency of the series"* rule
(Section 2.1), made into our own guard, and it is the second half of Open Decision 5.

### 5.1 Why the floor exists (two reasons, both real)

1. **No-fabrication (#1 non-negotiable).** A monthly series has *no* daily observations. "Give me this
   monthly series as daily" can only be answered by **inventing** ~20 numbers per month that were never
   measured (interpolation, forward-fill, or worse). That is precisely the finance number the repo forbids.
   The floor makes that request a **422**, not a silent fabrication.
2. **Cost / nonsense.** Even where up-sampling *could* be defined (e.g. forward-fill), it produces a series
   with a true information content of the native frequency dressed up as N× more points — pure padding that
   costs bytes and renders a staircase. There is no reader who is better off.

The floor is also what makes the relationship to Grafana's **Min interval** explicit. Grafana's Min
interval *"sets a minimum limit for the automatically calculated interval … allows you to retrieve queries
that are more coarse-grained rather than benefiting from finer intervals"* and *"corresponds to the min step
in Prometheus"*
([grafana.com, *Query and transform data*](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/)).
Same idea, applied at our retrieval boundary: there is a **smallest bucket this series supports**, and a
request can't go below it.

### 5.2 What the floor is, concretely

The floor is a **per-series property carried in the catalog metadata**: each series declares its
**native frequency** (`d`/`w`/`m`/…) and equivalently a **minimum bucket interval** (`1 day`, `1 week`,
`1 month`). The gateway enforces: `requested-frequency-rank ≥ native-frequency-rank` on the FRED ladder
(i.e. requested is the *same or coarser*). For the *chart downsampling* path (no explicit `frequency`, just
`maxPoints`), the floor manifests as: the chosen `time_bucket` width is `max(ceil(span/maxPoints),
native_interval)` — you can pick a *wider* bucket to fit the pixels, but never *narrower* than native,
because there is nothing finer in the store to read.

```ts
// gateway/freq-floor.ts — reject any request finer than the series' native frequency.
import { FREQ_LADDER } from "./series-params.js";
import { getSeriesMeta } from "./catalog-client.js";   // catalog metadata: { id, nativeFreq, ... }

// rank on the FRED ladder: d=0 (finest) ... a=6 (coarsest). Lower rank = finer.
function rank(freq: string): number {
  const i = (FREQ_LADDER as readonly string[]).indexOf(freq);
  if (i < 0) throw new Error(`unknown frequency ${freq}`);
  return i;
}

export async function enforceMinIntervalFloor(q: {
  ids: string[];
  frequency?: string;
}): Promise<{ rejected: boolean; detail?: unknown }> {
  // No explicit frequency => serve native; the chart-downsample path applies the
  // floor as a bucket-width clamp downstream (never narrower than native), so nothing
  // to reject here.
  if (!q.frequency) return { rejected: false };

  const reqRank = rank(q.frequency);
  const offenders: { id: string; native: string; requested: string }[] = [];

  for (const id of q.ids) {
    const meta = await getSeriesMeta(id);          // { nativeFreq: "m", ... }
    // FRED rule: requested may be SAME or COARSER (>= rank). Finer (< rank) is an error.
    if (reqRank < rank(meta.nativeFreq)) {
      offenders.push({ id, native: meta.nativeFreq, requested: q.frequency });
    }
  }
  return offenders.length
    ? { rejected: true, detail: { rule: "frequency must be >= native (FRED lower-only)", offenders } }
    : { rejected: false };
}
```

> **Edge case — multi-series request, mixed native frequencies.** If `ids` mixes a daily and a monthly
> series and the caller asks for `frequency=w` (weekly), the weekly request is *valid for the daily series*
> (coarsen d→w) but *invalid for the monthly series* (w is finer than m). The handler above flags the
> monthly one as an offender and 422s the whole request with a precise `offenders` list, rather than
> silently fabricating weekly points for the monthly series. (Alternative product choice: serve each series
> at `max(requested, native)` and stamp a per-series note — but that returns *mixed* frequencies in one
> response, which a compare chart must then reconcile. Rejecting is the honest default; the "serve at native
> floor per series" relaxation is a deliberate later decision, not the default.)

---

## Section 6 — Worked example: request → flow → SQL

The complete path for the canonical hard case from the project doc: **a 20-year daily series charted on a
920-pixel panel** (03-doc §Scale(b): "20-year daily series (~5k pts)").

### 6.1 The request

```
GET /series
  ?ids=DGS10                       # US 10Y Treasury constant-maturity yield (GREEN: treasury.gov / FRED public-domain)
  &from=2006-06-24
  &to=2026-06-24                   # 20 years
  &kind=line                       # volatile rate series -> LTTB
  &maxPoints=920                   # the panel measured itself: 920 px wide
```

### 6.2 What the gateway does, step by step

1. **Validate + clamp** (`seriesQuerySchema`). `maxPoints=920` is within `[2, 5000]` → kept as 920. `kind`
   defaults nothing (explicit `line`). `frequency` omitted → serve native daily. `aggregation` irrelevant
   (no coarsening) → defaults `avg`, unused.
2. **Floor check** (`enforceMinIntervalFloor`). No explicit `frequency` → nothing to reject; the floor will
   apply downstream as a bucket-width clamp (and LTTB doesn't use a width anyway).
3. **Native point count** ≈ 20 yr × ~252 trading days ≈ **~5,040 raw points** > 920. So the **point-count
   reduction fires** (it would *not* fire for, say, a 1-year daily request of ~252 pts < 920 — that is
   returned untouched).
4. **Cache key** `series:DGS10:<from>:<to>:native:avg:line:920` → `getOrRefresh`. On a cold key, call the
   data plane; on a warm key, serve the cached ≤920-point body (SWR refresh in the background).
5. **Data plane runs LTTB** with `resolution = 920`. Because DGS10 native daily over 20 years is only
   ~5,040 rows (not millions), LTTB can run over the **daily continuous aggregate / raw daily hypertable**
   directly — no intermediate frequency coarsening needed; 5k rows is a cheap single pass (~1–2 ms per the
   O(n) timings). For a *1-second* series over 20 years (~630 M rows) the same step would first read the
   **1-day CAGG** to get to ~5k rows, *then* LTTB — the "two cheap reductions" of Section 2.3.
6. **Post-fetch assert** `points.length <= 920`. Holds (LTTB returns ≤ resolution). Respond.

### 6.3 The SQL the data plane runs (LTTB over the daily series)

The exact `lttb()` + `unnest()` SQL is the **sibling skill's §5**; reproduced minimally here only to show
the boundary parameter (`resolution = maxPoints`) flowing through:

```sql
-- resolution ($3) is maxPoints (920), passed straight through. LTTB buckets internally;
-- NO time_bucket width is computed for the line path. Reads the daily relation for DGS10
-- over the 20y window; returns <= 920 (time, value) rows. Full mechanics: sibling §5.
SELECT t.time, t.value
FROM unnest((
    SELECT lttb(bucket, value, $3::int)        -- bucket = the daily CAGG's day; value = the yield
    FROM dgs10_daily                            -- the pre-rolled daily continuous aggregate
    WHERE series_id = $1                        -- 'DGS10'
      AND bucket >= $2a AND bucket < $2b        -- [from, to)
      AND value IS NOT NULL
)) AS t(time, value)
ORDER BY t.time;
```

### 6.4 The same example, but a MONTHLY request (frequency aggregation fires)

```
GET /series?ids=DGS10&from=2006-06-24&to=2026-06-24&frequency=m&aggregation=eop&maxPoints=920
```

- **Floor check:** `m` (rank 3) vs native `d` (rank 0). `3 >= 0` → coarser → **allowed**.
- **Frequency aggregation fires:** serve the **monthly continuous-aggregate** bucket of DGS10, with
  `aggregation=eop` → each month's value is its **last** observation (correct for a yield *level*; `avg`
  would have been the default but the caller correctly chose `eop` for a stock-type series — Section 2.2).
- **Point count:** 20 yr × 12 = **240 monthly points** < 920 → **point-count reduction does NOT fire**; the
  240 monthly points are returned as-is. (Frequency aggregation and point-count downsampling are
  independent: this request triggers the first, not the second.)
- **Counter-case — reject:** `GET /series?ids=CPIAUCSL&frequency=d` where `CPIAUCSL` (CPI) is **natively
  monthly** → `d` (rank 0) < native `m` (rank 3) → **422 `frequency_above_native`**. We do not interpolate a
  monthly CPI into daily points; that would invent numbers.

### 6.5 The flow as a diagram

```
  panel (920px)                gateway (Express/TS, Vercel)                  data plane (FastAPI)        store
  ─────────────                ────────────────────────────                 ───────────────────        ─────
  GET /series                  1. validate+clamp maxPoints  ──────────┐
   ids=DGS10                       (omit => 800; >5000 => 5000)        │
   from..to (20y)               2. min-interval floor check           │
   kind=line                       (freq >= native, else 422)         │
   maxPoints=920                3. cache key incl. maxPoints/freq/     │
                                   agg/kind  -> getOrRefresh ──cold──> 4. frequency: read pre-rolled ──> TimescaleDB
                                                          │             CAGG bucket (never raw scan)     CAGG / hypertable
                                              warm <──────┘          5. point-count: LTTB(resolution=    timescaledb_toolkit
                                                                        maxPoints) over the CAGG         lttb()
                                6. assert points<=maxPoints  <─────────  <= maxPoints rows + Provenance
   <= 920 points  <────────────  respond (+ ProvenanceLine/commercialOk)
```

Every series in the response also carries `Provenance{source, commercialOk, attribution}` (default
`false`), unchanged by either reduction — downsampling a series **does not** upgrade its license, and a
RED-source series stays RED whether you ship 5,040 points or 920 (03-doc §"What we WILL implement";
repo `commercial-ok-gate` rule). The reductions are about *how many* points and *at what frequency*, never
about *whether you may display them*.

---

## Section 7 — Anti-patterns (mistake → fix)

| Mistake | Why it breaks | Fix |
|---|---|---|
| Trusting the client to send `maxPoints` ("the chart always sends its width") | The **raw API path has no panel** → no pixel width → Grafana itself falls back to a fixed 800. An un-defaulted gateway returns the *universe* to a `curl`. | **Gateway-enforced default cap (800)** for an omitted `maxPoints`; clamp to a hard max (5000). The chart's pixel width is a *truthful input*, not the *guarantee*. ([grafana.com](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/)) |
| Conflating frequency aggregation with point-count downsampling | They answer different questions: monthly is *different numbers* (defined statistics), downsampling is *fewer points that look the same*. Treating "monthly" as "every 30th daily point" returns the wrong number. | Two independent reductions: `frequency`+`aggregation` (semantic, from a CAGG) and `maxPoints`+`kind` (cosmetic, LTTB/`time_bucket`). Both can fire, or neither, or one. |
| `avg()` to downsample a volatile price/yield line | Averaging is a low-pass filter: it *"completely smooths away almost all of the peaks and valleys"* — the signal a markets chart exists to show. | **LTTB** for volatile lines (points are real observed values, spikes survive); `avg` only for explicitly-smooth series. ([tigerdata.com](https://www.tigerdata.com/blog/slow-grafana-performance-learn-how-to-fix-it-using-downsampling)) |
| Up-sampling a series below its native frequency (monthly → daily) | There are **no** daily observations of a monthly series; producing them **invents finance numbers** (#1 non-negotiable). | **Minimum-interval floor**: 422 if `requested-freq-rank < native-freq-rank` (the FRED *"error if higher than native"* rule). |
| `sum` on a price series / `avg` on a flow series | The wrong aggregation method returns a *quietly wrong* number, not an error — same severity as inventing one. | Aggregation method is a **per-series catalog property** (level→avg, flow→sum, stock→eop); the picker uses the declared default. ([FRED method defs](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)) |
| Raw-scanning daily rows and `GROUP BY month` at request time | At Tier-3 (millions of rows) this scans the whole window on every request; the read-spike falls over. | Serve the **pre-rolled continuous-aggregate** monthly bucket (sibling §7); raw `time_bucket` only for windows finer than the smallest CAGG. |
| LTTB over raw ticks for a multi-year line | Reads tens/hundreds of millions of rows per request even though it returns ≤800. | LTTB over the matching **CAGG level**: CAGG cuts millions→thousands, LTTB cuts thousands→800 — two cheap reductions. (sibling §7.3) |
| Computing a `time_bucket` width for the LTTB path | LTTB buckets internally; an extra outer bucket double-decimates and mangles the shape. | Pass `maxPoints` straight in as `resolution`; width math is only for the `time_bucket` reducers (sibling §3). ([lttb.md](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md)) |
| Cache key of just `id:from:to` | A 920-pixel panel and an 800-default raw call collide → one gets the other's point count (right shape, wrong count). | Key on **every output-changing param**: `id:from:to:frequency:aggregation:kind:maxPoints`. |
| Feeding LTTB a multi-series merged frame, or a frame with NaNs | LTTB is single-series and requires strictly-increasing x with no NaN; a merged/NaN frame mis-selects or errors. | Run LTTB **per series**; filter `NULL`/NaN first (or `gp_lttb` to preserve real gaps). ([pypi lttb](https://pypi.org/project/lttb/)) |
| Shipping ISO-8601 timestamps to the chart | Per-point string parse on the client defeats the bandwidth win. | Epoch-ms on the x-axis (the JS charting unit); convert server-side. (sibling §8.4) |
| Treating a downsampled RED-source series as displayable because "it's only 800 points now" | Point count has nothing to do with the display license; the series is still RED-sourced. | `Provenance{commercialOk}` is unchanged by reduction; default `false`; render `ProvenanceLine` regardless of point count. (repo `commercial-ok-gate`) |
| Streaming a whole-series export point-by-point through `/series` | A full export is the opposite job: it *wants* all points. Forcing it through the capped chart endpoint either truncates it (wrong) or removes the cap (universe-to-client). | Bulk/whole-series export goes to the **Parquet/R2 path off the request**, never the capped `/series` chart endpoint. (03-doc §"What we WILL implement") |

---

## Section 8 — Output contract (how to grade an implementation of this recipe)

A `/series` implementation satisfies this recipe iff:

1. **The default cap exists and is server-side.** Omitting `maxPoints` yields ≤ a fixed default (≈800), not
   the universe. A `curl` with no `maxPoints` cannot pull an unbounded body. (Tested with the param absent.)
2. **The hard max exists.** `maxPoints=10_000_000` is clamped (e.g. to 5000), not honored.
3. **The minimum-interval floor exists.** A request for a frequency *finer* than the series' native
   frequency returns 422, never fabricated points. (Tested with a monthly series + `frequency=d`.)
4. **Frequency aggregation reads a pre-rolled CAGG**, not a request-time raw `GROUP BY` scan, for any
   coarsening served at scale. (Verified by the query plan: the coarse request hits the CAGG relation.)
5. **The reducer matches the series kind:** LTTB for volatile lines (points are original-set values),
   `time_bucket`/`candlestick_agg` for OHLC, `avg` only for explicitly-smooth series. No `avg` on a price
   line.
6. **The aggregation method is the series' declared default** (level→avg, flow→sum, stock→eop), not a blind
   global `avg`.
7. **The cache key includes every output-changing parameter** (`frequency`, `aggregation`, `kind`,
   `maxPoints`), so two different point budgets cannot collide.
8. **A post-fetch assert** guarantees `len(points) ≤ maxPoints` and fails loudly on a reducer regression.
9. **Provenance is unchanged by reduction** — `commercialOk` stays correct (default `false`); a
   `ProvenanceLine` renders regardless of point count.
10. **Bulk export is a separate path** (Parquet/R2), never the capped chart endpoint.

A scale-tier statement (R-SCALE) must accompany the implementation: **Tier-1** = direct draw of a
few-hundred-point series; **Tier-2** = LTTB to `maxPoints` over a daily/hourly window, warm-cached;
**Tier-3** = frequency aggregation from a continuous aggregate **+** LTTB over the CAGG, compute-once-serve-
many via `getOrRefresh`+SWR, bulk to Parquet — with the render-side caveat that the SVG `IndexChart` breaks
before canvas does at extreme N (03-doc §Scale(b)).

---

## Sources

- **The `maxPoints` contract / pixel-width-vs-HTTP-API-default-800 / Min interval** —
  [grafana.com, *Query and transform data*](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/)
  (default = panel pixel width; *"can only visualize as many data points as the graph panel has room to
  display"*; data sources reduce by *"average, max, or another function"*; Min interval *"sets a minimum
  limit for the automatically calculated interval … corresponds to the min step in Prometheus"*; the
  HTTP-API **800** default surfaced this run from the same doc family).
- **Frequency aggregation: lower-frequency-only rule + the three methods (avg default/sum/eop) + the full
  frequency-code ladder** —
  [fred.stlouisfed.org `series/observations`](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)
  (*"No frequency aggregation will occur if the frequency … matches the native frequency … an error will be
  returned if a frequency is specified that is higher than the native frequency of the series"*);
  [sboysel.github.io/fredr — `fredr_series_observations` reference](https://sboysel.github.io/fredr/reference/fredr.html)
  (full `frequency` value list incl. `wef`/`weth`/`bwew`/… and the `avg`/`sum`/`eop` methods);
  FRED Help *"What is Frequency Aggregation?"* + *"Edit the Frequency and Aggregation Method"* (method
  examples; daily=highest, annual=lowest).
- **LTTB — algorithm, shape preservation, original-set points, O(n), benchmarks** —
  [rajnandan.com, *Largest Triangle Three Buckets*](https://rajnandan.com/posts/largest-triangle-three-buckets-downsampling/)
  (triangle-area formula `|x₁(y₂−y₃)+x₂(y₃−y₁)+x₃(y₁−y₂)|/2`; *"preserve visual features: sharp turns,
  peaks, valleys"*; per-N pass timings 10k=2ms … 10M=1500ms);
  [siftstack, *LTTB downsampling*](https://www.siftstack.com/mission-critical/lttb-downsampling)
  (the four-step process; *"Averaging data … can hide significant events"*; O(n));
  [pypi.org/project/lttb](https://pypi.org/project/lttb/) (`lttb.downsample(data, n_out)`; numpy
  `(N,2)`, strictly-increasing x, no NaN);
  [timescaledb-toolkit `docs/lttb.md`](https://github.com/timescale/timescaledb-toolkit/blob/main/docs/lttb.md)
  (`lttb(time, value, resolution) RETURNS SortedTimevector`; *"at most `resolution` points"*; the
  `unnest()` pattern);
  [timescaledb-toolkit discussion #30](https://github.com/timescale/timescaledb-toolkit/discussions/30)
  (*"Sending thousands of points to the client … causes slowdowns"*; *"sums/averages … isn't always a great
  way of getting fidelity to the visual shape"* → LTTB).
- **Why the cap matters / SVG-melts / payload + render numbers / LTTB-vs-avg / CAGG+LTTB two-stage / the
  `2×($__to−$__from)/$__interval_ms` resolution** —
  [tigerdata.com, *Slow Grafana Performance? Learn How to Fix It Using Downsampling*](https://www.tigerdata.com/blog/slow-grafana-performance-learn-how-to-fix-it-using-downsampling)
  (1.3M points → 20s; *"less than 0.5 % of the points"*, *"barely distinguishable"*; 315k→1,404 rows, 5s→<1s;
  avg *"completely smooths away almost all of the peaks and valleys"*).
- **time_bucket / continuous aggregates as the storage-rollup half; CAGG-vs-LTTB best-for** —
  [tigerdata.com, *About continuous aggregates*](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates);
  [nickb.dev, *Downsampling Timescale Data with Continuous Aggregations*](https://nickb.dev/blog/downsampling-timescale-data-with-continuous-aggregations/);
  [Toolkit LTTB tutorial](https://timescale.github.io/timescaledb-ruby/toolkit_lttb_tutorial/).
- **Async-load-per-zoom (the render-side Tier-3 pattern referenced by §Scale)** —
  [highcharts.com, *1.7 million points with async loading*](https://www.highcharts.com/demo/stock/lazy-loading)
  (`afterSetExtremes` → server picks resolution per viewport → returns the window's data; the same
  "server downsamples per viewport" loop `maxPoints` implements).
- **Point-in-time / `asOf` vintage (the `/series` `asOf` parameter, adjacent to this recipe)** —
  [fred.stlouisfed.org `series/observations`](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)
  + [FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html)
  (`realtime_start`/`realtime_end`/`vintage_dates`/`output_type` — ALFRED point-in-time model).
- **The raw SQL mechanics this file delegates (LTTB `unnest`, `candlestick_agg`/`rollup`, bucket `ceil`
  math, the FastAPI+asyncpg handler, CAGG build/maintenance)** — sibling skill
  [`timescaledb-timeseries/references/patterns-server-side-downsampling-charts.md`](../../timescaledb-timeseries/references/patterns-server-side-downsampling-charts.md)
  and [`theory-continuous-aggregates.md`](../../timescaledb-timeseries/references/theory-continuous-aggregates.md).
- **Project design context** —
  [`.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)
  §"Our system design" (the `GET /series` contract), §Scale(b) (point-volume / SVG-melts / Grafana-800
  lesson / LTTB-vs-`time_bucket` fork), Open Decisions 1 (downsampling method) + 5 (`maxPoints` default +
  minimum-interval floor).
```