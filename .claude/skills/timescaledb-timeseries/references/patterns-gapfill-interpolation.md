# patterns-gapfill-interpolation.md

> **Skill:** `timescaledb-timeseries` · **Type:** pattern (concrete build recipe)
> **Product line:** JPM-Markets re-engineering **data-analytics** product line (NOT Lumina).
> **Scope:** Filling missing time buckets *honestly* with `time_bucket_gapfill()`, `locf()`, and
> `interpolate()` — and the finance-specific traps where naive gapfilling fabricates a price that
> never traded. This reference grounds the "never invent a finance number" rule **at the SQL layer**.

---

## 0. The one-paragraph version (read this first)

A query that buckets time (`time_bucket('1 day', ts)`) returns **only the buckets that have data**.
If a sensor or a market is silent for an interval, that interval is simply *absent* from the result —
not a row of `NULL`, just gone. `time_bucket_gapfill()` is the only TimescaleDB function that
**manufactures rows for the empty buckets** so the series is contiguous and evenly spaced. By itself it
leaves the manufactured rows' values as `NULL`. You then choose how to fill those `NULL`s:
`locf(value)` carries the last real observation forward; `interpolate(value)` draws a straight line
between the two surrounding real observations. **Both are honest for regular-cadence data (a sensor
sampling every second) and dangerous for irregular market data (a stock that does not trade on
weekends, holidays, or during a halt)** — because carrying Friday's close across Saturday, or
interpolating across a trading halt, prints a number that *no transaction ever produced*. This doc is
the recipe for using these three functions correctly and the rule-set for never letting them fabricate
a tradable price.

**Primary sources used throughout** (read these before changing gapfill code):
- `time_bucket_gapfill()` API reference — TigerData (formerly Timescale) docs:
  <https://docs.tigerdata.com/api/latest/hyperfunctions/gapfilling/time_bucket_gapfill/>
- `locf()` API reference: <https://docs.tigerdata.com/api/latest/hyperfunctions/gapfilling/locf/>
- `interpolate()` API reference: <https://docs.tigerdata.com/api/latest/hyperfunctions/gapfilling/interpolate/>
- Use-case page: <https://docs.tigerdata.com/use-timescale/latest/hyperfunctions/gapfilling-interpolation/time-bucket-gapfill/>
- **Source of truth — the SQL definitions:** `timescale/timescaledb` →
  [`sql/gapfill.sql`](https://github.com/timescale/timescaledb/blob/main/sql/gapfill.sql)
- **Source of truth — the planner node:** `timescale/timescaledb` →
  [`tsl/src/nodes/gapfill/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/nodes/gapfill/README.md)
  and `tsl/src/nodes/gapfill/gapfill_plan.c` (error strings quoted in §9)
- Behavior gotcha: issue **#6528** "Unexpected time_bucket_gapfill behavior (with locf and last)" —
  <https://github.com/timescale/timescaledb/issues/6528>
- `treat_null_as_missing` history: PR #1067, issue #1588 —
  <https://github.com/timescale/timescaledb/pull/1067>, <https://github.com/timescale/timescaledb/issues/1588>

---

## 1. The exact signatures (from `sql/gapfill.sql`, not from memory)

These are copied verbatim from
[`timescale/timescaledb/sql/gapfill.sql`](https://github.com/timescale/timescaledb/blob/main/sql/gapfill.sql)
(`main` branch). Pin to your installed extension version with `SELECT extversion FROM pg_extension
WHERE extname='timescaledb';` and re-confirm against the tag if a signature here looks off.

### 1.1 `time_bucket_gapfill()` — 7 overloads

```sql
-- integer time axes (sequence numbers, epoch ints)
time_bucket_gapfill(bucket_width SMALLINT, ts SMALLINT, start SMALLINT=NULL, finish SMALLINT=NULL) RETURNS SMALLINT
time_bucket_gapfill(bucket_width INT,      ts INT,      start INT=NULL,      finish INT=NULL)      RETURNS INT
time_bucket_gapfill(bucket_width BIGINT,   ts BIGINT,   start BIGINT=NULL,   finish BIGINT=NULL)   RETURNS BIGINT

-- date / timestamp axes (the ones you use for market & sensor data)
time_bucket_gapfill(bucket_width INTERVAL, ts DATE,        start DATE=NULL,        finish DATE=NULL)        RETURNS DATE
time_bucket_gapfill(bucket_width INTERVAL, ts TIMESTAMP,   start TIMESTAMP=NULL,   finish TIMESTAMP=NULL)   RETURNS TIMESTAMP
time_bucket_gapfill(bucket_width INTERVAL, ts TIMESTAMPTZ, start TIMESTAMPTZ=NULL, finish TIMESTAMPTZ=NULL) RETURNS TIMESTAMPTZ

-- timezone-aware overload (TimescaleDB 2.9+) — bucket boundaries align to the named zone
time_bucket_gapfill(bucket_width INTERVAL, ts TIMESTAMPTZ, timezone TEXT, start TIMESTAMPTZ=NULL, finish TIMESTAMPTZ=NULL) RETURNS TIMESTAMPTZ
```

| Arg | Type | Default | Meaning |
|---|---|---|---|
| `bucket_width` | `INTERVAL` (or int for integer axes) | — (required) | bucket size, e.g. `'1 day'`, `'5 minutes'`, `'1 hour'`. **Must be > 0.** |
| `ts` | timestamp/date/int column | — (required) | the time column being bucketed |
| `start` | same as `ts` | `NULL` | **explicit** lower bound of the manufactured range (inclusive) |
| `finish` | same as `ts` | `NULL` | **explicit** upper bound of the manufactured range (exclusive) |
| `timezone` | `TEXT` | — | zone for bucket alignment; **must be a constant** (see §9) — 2.9+ only |

The return type **always matches the `ts` input type** (a `TIMESTAMPTZ` column gives a `TIMESTAMPTZ`
bucket). Source: `time_bucket_gapfill()` reference, "Returns … The return type matches the input
`time` type."

### 1.2 `locf()` — one polymorphic overload

```sql
locf(value ANYELEMENT, prev ANYELEMENT=NULL, treat_null_as_missing BOOL=false) RETURNS ANYELEMENT
```

| Arg | Type | Default | Meaning |
|---|---|---|---|
| `value` | `ANYELEMENT` | — | the aggregate to carry forward, e.g. `locf(avg(price))`, `locf(last(close, ts))` |
| `prev` | `ANYELEMENT` | `NULL` | a **scalar subquery** that supplies the value *before* the query window, so the **first** bucket can be filled when the window opens on a gap (see §6) |
| `treat_null_as_missing` | `BOOL` | `false` | when `true`, real `NULL`s in `value` are *skipped* and the last **non-NULL** value is carried; when `false`, a real `NULL` is itself carried forward (a `NULL` aggregate counts as an observation) |

`prev` is a single value per group (`device_id`, `symbol`, …); `value` is `ANYELEMENT` so the carried
type is whatever you aggregate. Source: `sql/gapfill.sql` and the `locf()` reference.

### 1.3 `interpolate()` — five numeric overloads (numeric only — you cannot interpolate text)

```sql
interpolate(value SMALLINT, prev RECORD=NULL, next RECORD=NULL) RETURNS SMALLINT
interpolate(value INT,      prev RECORD=NULL, next RECORD=NULL) RETURNS INT
interpolate(value BIGINT,   prev RECORD=NULL, next RECORD=NULL) RETURNS BIGINT
interpolate(value REAL,     prev RECORD=NULL, next RECORD=NULL) RETURNS REAL
interpolate(value FLOAT,    prev RECORD=NULL, next RECORD=NULL) RETURNS FLOAT
```

| Arg | Type | Default | Meaning |
|---|---|---|---|
| `value` | numeric | — | the aggregate to linearly interpolate, e.g. `interpolate(avg(temp))` |
| `prev` | `RECORD` `(time, value)` | `NULL` | a subquery returning **a tuple of `(time, value)`** before the window, so the leading edge can be interpolated/extrapolated |
| `next` | `RECORD` `(time, value)` | `NULL` | a subquery returning a `(time, value)` tuple after the window, for the trailing edge |

Note the asymmetry with `locf`: `interpolate`'s `prev`/`next` are **records carrying a timestamp**, not
bare scalars, because linear interpolation needs *both endpoints' times* to compute the slope. Source:
`interpolate()` reference: "the `prev` and `next` expressions … each return a tuple with time and value,
where the time is necessary to compute missing values correctly." There is **no** `NUMERIC` / `DECIMAL`
overload — interpolate operates on `float`/`int` families. To interpolate a `NUMERIC` price column, cast
to `double precision` first (and accept the float-precision caveat — see §11).

---

## 2. How the three functions actually compose (the plan-node mental model)

Understanding the execution model prevents 80% of the mistakes. From
[`tsl/src/nodes/gapfill/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/nodes/gapfill/README.md):

> "the time_bucket_gapfill functions only serves to trigger injecting the gapfill customscan node in
> the planner; all the tuple injecting happens in the gapfill node and time_bucket_gapfill just calls
> plain time_bucket."
>
> "the locf and interpolate function calls serve as markers in the plan to trigger locf or interpolate
> behaviour. In the targetlist of the gapfill node those functions will be toplevel function calls."

So the pipeline is:

```
  base scan (hypertable)
        │
        ▼
  aggregation (GROUP BY time_bucket_gapfill(...), symbol)   ← produces ONLY non-empty buckets
        │
        ▼
  Sort by (group keys, time)                                ← injected automatically if needed
        │
        ▼
  Custom Scan: GapFill node                                 ← INVENTS the missing-bucket rows here,
        │                                                      then applies locf/interpolate markers
        ▼
  result (contiguous, evenly spaced buckets)
```

Three consequences fall straight out of this model:

1. **`time_bucket_gapfill` must be the top-level call in the `GROUP BY`.** You cannot wrap it
   (`date_trunc('day', time_bucket_gapfill(...))` fails) — the planner looks for the *literal*
   top-level function to anchor the node. Error: `"no top level time_bucket_gapfill in group by
   clause"` (§9).
2. **`locf`/`interpolate` must be top-level in their `SELECT` column** and must be in the **same
   query** as the `time_bucket_gapfill` that created the rows. They are *markers*: outside a gapfill
   query they do literally nothing useful, and nesting them inside another function call
   (`round(locf(avg(x)))`) breaks the marker detection — wrap the *other* way or push the rounding to
   an outer query (§3, §9).
3. **Exactly one `time_bucket_gapfill` per query level.** Error: `"multiple time_bucket_gapfill calls
   not allowed"`. One time axis per gapfill node.

---

## 3. The "same query" rule, stated precisely

This is the single most-misunderstood constraint, so here it is mechanically:

- `time_bucket_gapfill(...)`, `locf(...)`, and `interpolate(...)` are recognized **only by the planner
  building the GapFill node for that specific SELECT**. They are not ordinary functions you can layer.
- ✅ **Correct** — all three markers live in one SELECT, gapfill at the top of `GROUP BY`, fills at the
  top of their columns:

  ```sql
  SELECT
    time_bucket_gapfill('1 day', ts) AS bucket,
    symbol,
    locf(last(close, ts))            AS close_locf,
    interpolate(avg(close))          AS close_interp
  FROM prices
  WHERE ts >= '2024-01-01' AND ts < '2024-02-01'
  GROUP BY bucket, symbol
  ORDER BY symbol, bucket;
  ```

- ❌ **Wrong** — gapfill in an inner query, `locf` in an outer query. The outer `locf` has no GapFill
  node to mark, so it errors / no-ops:

  ```sql
  -- DON'T: locf in the outer query cannot see the inner gapfill node
  SELECT bucket, symbol, locf(avg_close) FROM (
    SELECT time_bucket_gapfill('1 day', ts) AS bucket, symbol, avg(close) AS avg_close
    FROM prices WHERE ts >= '2024-01-01' AND ts < '2024-02-01'
    GROUP BY bucket, symbol
  ) sub;
  ```

- ❌ **Wrong** — nesting the marker inside another call. `round(locf(...))` hides the `locf` marker
  from the planner:

  ```sql
  -- DON'T nest the marker:  round(locf(avg(close)))
  -- DO push the transform to an OUTER query over the gapfill result:
  SELECT bucket, symbol, round(close_locf::numeric, 2) AS close_locf
  FROM (
    SELECT time_bucket_gapfill('1 day', ts) AS bucket, symbol,
           locf(avg(close)) AS close_locf
    FROM prices WHERE ts >= '2024-01-01' AND ts < '2024-02-01'
    GROUP BY bucket, symbol
  ) g;
  ```

  The marker stays top-level in the **inner** query (where the GapFill node lives); the cosmetic
  `round()` happens **outside** it. This nesting rule is why most production gapfill code is a two-layer
  query: inner gapfill+fill, outer formatting/labeling.

---

## 4. Bounded vs unbounded ranges — and why you MUST pass explicit `start`/`finish`

### 4.1 The two ways to bound a gapfill range

`time_bucket_gapfill` needs to know the **first** and **last** bucket of the contiguous range it should
manufacture. There are two ways to tell it:

1. **Inferred from the `WHERE` clause.** If you write `WHERE ts >= '2024-01-01' AND ts < '2024-02-01'`,
   the planner can *sometimes* extract `2024-01-01` as `start` and `2024-02-01` as `finish`.
2. **Explicit `start`/`finish` arguments:** `time_bucket_gapfill('1 day', ts, '2024-01-01',
   '2024-02-01')`. Unambiguous, always works.

### 4.2 Why inference is fragile — pass the arguments explicitly

WHERE-clause inference is a *best-effort* parse and breaks in many real situations, each with its own
error or silent truncation. From the issue tracker (all real, all linked):

- **A subquery or non-constant bound in the predicate** → `"invalid time_bucket_gapfill argument: start
  must be a simple expression"`. The planner only accepts *simple* (constant-foldable) bound
  expressions. (issue #2595: <https://github.com/timescale/timescaledb/issues/2595>)
- **Calling inside a PL/pgSQL function** where the bound is a parameter → `"invalid time_bucket_gapfill
  argument: bucket_width must be a simple expression"` / cannot infer bounds, because the parameter
  isn't a constant at plan time. (issue #1231:
  <https://github.com/timescale/timescaledb/issues/1231>)
- **Casting / `AT TIME ZONE` in the predicate** → `"missing time_bucket_gapfill argument: could not
  infer start from WHERE clause"` or `"ts needs to refer to a single column if no start or finish is
  supplied"`. (issues #1345, #1818)
- **A predicate that folds to constant-false** → `"invalid time_bucket_gapfill argument: could not infer
  start boundary from WHERE clause"`.
- **A REST/ORM layer that parameterizes the bounds** → the bounds arrive as bind parameters, not
  constants, and inference fails at runtime even though the literal SQL "looked fine." (issue #4279:
  <https://github.com/timescale/timescaledb/issues/4279>)

> **RULE: always pass `start` and `finish` explicitly.** Treat WHERE-inference as an undocumented
> convenience that will betray you the moment the query goes through an ORM, a prepared statement, a
> view, or a function. Every gapfill query in the data-analytics product line passes the four-arg form.
> This also makes the manufactured range **deterministic and independent of which data happens to
> exist** — which is the whole point of gapfilling.

```sql
-- ✅ canonical form: bounds as ARGUMENTS, and the same bounds in WHERE for index pruning
SELECT time_bucket_gapfill('1 hour', ts, $1, $2) AS bucket, sensor_id, avg(reading)
FROM readings
WHERE ts >= $1 AND ts < $2          -- WHERE still needed so the scan uses the chunk/time index
  AND sensor_id = $3
GROUP BY bucket, sensor_id
ORDER BY bucket;
```

Note the WHERE clause is **still required** even with explicit args — not for bound inference, but so
the base scan only reads the relevant chunks (chunk exclusion + the time index). Without it you scan the
whole hypertable, then throw most of it away. The args define *what range to manufacture*; the WHERE
defines *what range to read*. Keep them aligned.

### 4.3 What "unbounded" actually does (and why it is a footgun)

If you provide neither args nor an inferable WHERE bound, gapfill can only fill *between the first and
last rows that actually exist* — it has no way to manufacture buckets before the earliest datum or after
the latest. So an "unbounded" gapfill:

- silently produces a range that **depends on the data**, not on your intent;
- cannot fill a leading or trailing gap (there is nothing to bound against);
- changes its output shape every time a new row arrives at the edges.

For a finance API that promises "one row per trading interval from `start` to `finish`", that
non-determinism is unacceptable. **Bounded, explicit, every time.**

---

## 5. `locf()` semantics in depth — and the `last()` trap (issue #6528)

### 5.1 What `locf` does, exactly

`locf(value)` looks at the **chronologically previous bucket's value** for the same group and copies it
into an empty bucket. It carries forward across *as many* consecutive empty buckets as exist, until a
real value appears. This is "last observation carried forward."

The subtlety is the difference between *an empty bucket* and *a bucket whose aggregate is `NULL`*:

- With `treat_null_as_missing => false` (the default), a bucket whose aggregate evaluated to `NULL`
  (e.g. `avg()` over zero rows, or over only-`NULL` rows) is treated as **a real observation of
  `NULL`**, and that `NULL` is then carried forward. You can get long runs of carried-`NULL`.
- With `treat_null_as_missing => true`, `NULL` aggregates are treated as *missing*, so `locf` skips
  over them and carries the **last non-NULL** value. This is almost always what you want for finance.
  (Added in PR #1067 to fix issue #1588:
  <https://github.com/timescale/timescaledb/pull/1067>, <https://github.com/timescale/timescaledb/issues/1588>.)

```sql
-- carry the last real close across empty buckets, skipping NULL-aggregate buckets
locf(last(close, ts), treat_null_as_missing => true)
```

### 5.2 The `locf(last(...))` "wrong value" trap — issue #6528 in full

This is a genuine, currently-open gotcha that bites finance downsampling specifically. Repro from
[issue #6528](https://github.com/timescale/timescaledb/issues/6528):

```sql
CREATE TABLE test (ts TIMESTAMPTZ, val INTEGER);
SELECT create_hypertable('test', 'ts');

INSERT INTO test (ts, val) VALUES
  ('2023-01-01 00:00:00', 0),
  ('2023-01-01 00:00:30', 0),
  ('2023-01-01 00:01:00', 1),
  ('2023-01-01 00:02:00', 2),
  ('2023-01-01 00:03:00', 3),
  ('2023-01-01 00:03:59', 4),   -- a SECOND reading inside the 00:03 minute-bucket
  ('2023-01-01 00:05:00', 5);

SELECT time_bucket_gapfill('1 minute', ts) AS ts_fill,
       locf(last(val, ts), treat_null_as_missing => true)
FROM test
WHERE ts BETWEEN '2023-01-01 00:00:00' AND '2023-01-01 00:07:00'
GROUP BY ts_fill
ORDER BY ts_fill ASC;
```

The reporter expected the `00:03` bucket to surface `3` and then `locf` to carry `3` into the empty
`00:04` bucket. What actually happens: `last(val, ts)` is an **aggregate within the bucket**, so for the
`00:03` bucket it correctly returns `4` (the last reading *in* that minute, at `00:03:59`). Then `locf`
carries **`4`** — not `3` — into `00:04`.

**This is not a bug in `locf`; it is a misunderstanding of aggregate order-of-operations.** The
aggregate (`last`, `avg`, `first`, …) runs *first, per bucket, over every row in that bucket*; `locf`
only ever sees the per-bucket aggregate, never the individual rows. The lesson:

> **`locf(last(close, ts))` carries forward the *last trade of the bucket*, which is exactly the OHLC
> "close" — that is correct for a close series. But if you wanted the value as-of the bucket
> *boundary*, the bucket aggregate is the wrong tool, and no `locf` argument fixes it.** Decide
> deliberately whether your aggregate is "close of interval" (`last`), "open" (`first`), VWAP, or
> `avg`, because `locf` faithfully propagates whatever the aggregate produced.

For finance, `last(close, ts)` for the close series is the right pairing; just know that "last" means
last-within-the-bucket, not last-before-the-bucket.

### 5.3 `locf` is **directional**: it only looks backward

`locf` cannot fill a **leading** gap from inside the window — there is no earlier bucket to carry from.
The first bucket of your range, if empty, stays `NULL` *unless* you supply the `prev` argument (§6).
This matters enormously for a finance chart that opens on a holiday: bucket #1 will be `NULL` without
`prev`.

---

## 6. The `prev` / `next` boundary arguments — filling the leading & trailing edges

### 6.1 Why they exist

The `WHERE ts >= start AND ts < finish` predicate hides every row outside the window. So when the
**first** bucket of the window is empty, `locf` has nothing to carry forward, and when the first/last
bucket is empty, `interpolate` has no left/right endpoint. The `prev`/`next` arguments are escape
hatches that run a **separate scalar subquery reaching outside the window** to fetch the needed anchor.

> From the `locf()` reference: "Because the locf function relies on having values before each bucketed
> period to carry forward, it might not have enough data to fill in a value for the first bucket… The
> prev expression tells the function how to look for values outside of the range specified by the time
> predicate. The prev expression will only be evaluated when no previous value is returned by the outer
> query (i.e. the first bucket in the queried time range is empty)."

### 6.2 `locf` with `prev` (a bare scalar subquery)

```sql
SELECT
  time_bucket_gapfill('1 day', time, now() - INTERVAL '1 week', now()) AS day,
  device_id,
  avg(temperature) AS value,
  locf(
    avg(temperature),
    (SELECT temperature                       -- prev: one scalar value
       FROM metrics m2
      WHERE m2.time < now() - INTERVAL '1 week'  -- strictly BEFORE the window
        AND m.device_id = m2.device_id
      ORDER BY m2.time DESC
      LIMIT 1)
  )
FROM metrics m
WHERE time > now() - INTERVAL '1 week'
GROUP BY day, device_id
ORDER BY day;
```

(Adapted from the official `locf()` reference example.) The correlated `m.device_id = m2.device_id`
makes the `prev` lookup per-group — essential when you gapfill many symbols/devices at once.

### 6.3 `interpolate` with `prev` and `next` (record subqueries carrying time)

```sql
SELECT
  time_bucket_gapfill('1 day', time, '2024-01-01', '2024-02-01') AS day,
  device_id,
  interpolate(
    avg(temperature),
    (SELECT (time, temperature)               -- prev: a (time, value) RECORD
       FROM metrics m2
      WHERE m2.time < '2024-01-01'
        AND m.device_id = m2.device_id
      ORDER BY m2.time DESC LIMIT 1),
    (SELECT (time, temperature)               -- next: a (time, value) RECORD
       FROM metrics m3
      WHERE m3.time >= '2024-02-01'
        AND m.device_id = m3.device_id
      ORDER BY m3.time ASC LIMIT 1)
  ) AS value
FROM metrics m
WHERE time >= '2024-01-01' AND time < '2024-02-01'
GROUP BY day, device_id
ORDER BY day;
```

The `(time, temperature)` row constructor is mandatory — `interpolate` needs the timestamp of the
out-of-window anchor to compute the slope across the boundary. Source: `interpolate()` reference.

### 6.4 The hidden cost of `prev`/`next`

Each is a **correlated subquery executed per group** when the edge bucket is empty. For a 5,000-symbol
gapfill that opens on a market holiday, that is up to 5,000 extra index lookups. It is still cheap with a
`(symbol, ts DESC)` index (`ORDER BY ts DESC LIMIT 1` is an index-only backward scan), but **confirm the
index exists** or it becomes 5,000 sequential scans. See §10.

---

## 7. `interpolate()` semantics in depth

### 7.1 The formula

For an empty bucket at time `t`, with the nearest real observation **before** at `(t0, v0)` and the
nearest real observation **after** at `(t1, v1)`, interpolate returns the point on the straight line:

```
v(t) = v0 + (v1 - v0) * (t - t0) / (t1 - t0)
```

From the use-case docs: "Linear interpolation takes the average of the previous and next windows" —
which is the special case when `t` is the exact midpoint. The general formula above is what executes.

### 7.2 What it can and cannot do

- It **only** fills buckets that are *between* two real observations. A gap that extends past the last
  real value (or before the first) cannot be interpolated from inside the window — there is no second
  endpoint. Use `prev`/`next` (§6.3) to extrapolate across the leading/trailing edge, or accept `NULL`.
- It is **numeric only** (no `text`/`bool`/`numeric` overload — §1.3). Cast `NUMERIC` to
  `double precision` to interpolate, then read §11 on precision.
- It produces values that **vary smoothly** — which is exactly why it is *more* dangerous than `locf`
  for prices: `locf` at least repeats a number that *did* trade once; `interpolate` invents an entirely
  new number that **never traded at all**.

---

## 8. The FINANCE traps — where gapfilling fabricates a price (the core of this doc)

This is where the data-analytics product line's "never invent a finance number" non-negotiable meets
SQL. **A gapfilled finance value can be a fabricated price, and the database will not warn you.**

### 8.1 Trap #1 — carrying a close across a weekend/holiday (`locf` over a non-trading gap)

A daily equity series buckets to one row per calendar day. Saturdays, Sundays, and exchange holidays
have **no trades** — they are empty buckets. `locf(last(close, ts))` will dutifully copy Friday's close
into Saturday, Sunday, and the holiday Monday.

```sql
-- ⚠️ This SILENTLY prints Friday's close as if it were Saturday's and Sunday's price.
SELECT time_bucket_gapfill('1 day', ts, '2024-07-01', '2024-07-08') AS day,
       symbol,
       locf(last(close, ts), treat_null_as_missing => true) AS close
FROM equity_prices
WHERE ts >= '2024-07-01' AND ts < '2024-07-08' AND symbol = 'AAPL'
GROUP BY day, symbol
ORDER BY day;
-- July 4 (US holiday) and the weekend get a "close" that no exchange ever printed.
```

The number isn't *wrong* in the sense of "different from a real value" — it's wrong in the sense that
**there is no real value for that day at all**, and a carried value misrepresents a non-trading day as a
trading day with an unchanged price. A reader (or the agent) seeing seven daily closes will compute a
7-day return, a 7-day volatility, a 7-day average — all contaminated by three fabricated observations.

**The honest options, in order of preference:**
1. **Don't gapfill calendar days at all for equities.** Bucket by trading session and *only return
   buckets that exist*. The absence of a weekend row is the truth.
2. **If you must produce an evenly-spaced series** (a fixed-grid chart, an ML feature matrix), gapfill
   **but flag every manufactured row as synthetic** (§8.5) so the consumer can drop or down-weight them.
3. **Never feed gapfilled closes into a return/volatility calculation** without first removing the
   synthetic rows. A weekend-carried close produces a fake "0% return day" that deflates realized
   volatility.

### 8.2 Trap #2 — interpolating across a trading halt or suspension

A stock halted intraday (LULD halt, news pending, circuit breaker) has a gap *inside* a session.
`interpolate` will draw a smooth line from the pre-halt price to the post-halt price — manufacturing a
sequence of prices **at which no trade was possible**, because trading was, by definition, suspended.

```sql
-- ⚠️ Invents a glide path of prices DURING a halt — none were tradable.
SELECT time_bucket_gapfill('1 minute', ts, $1, $2) AS minute,
       interpolate(avg(price)) AS price
FROM trades
WHERE ts >= $1 AND ts < $2 AND symbol = 'XYZ'
GROUP BY minute ORDER BY minute;
```

The danger is *worse* than the weekend case: a halt often brackets a large price **gap** (the stock
reopens far from where it halted, precisely because of the news that caused the halt). Interpolating
across it paints a gentle ramp where reality had a cliff — erasing exactly the event a finance reader
cares about. **Never interpolate a price across a halt.** If you need a continuous series, `locf` the
last pre-halt print (honest: "the last price we know") and flag it synthetic — never `interpolate`.

### 8.3 Trap #3 — interpolating/locf'ing across an illiquid asset's no-trade gaps

A thinly-traded small-cap, an OTC name, or a far-dated option may simply not trade for hours or days.
Every no-trade interval is an empty bucket. Both fills lie here, in different ways:
- `interpolate` invents intermediate prices implying continuous price discovery that did not occur.
- `locf` implies the price "held" at the last print, when in reality there was **no market** — the
  last print may be hours stale and unexecutable.

The honest representation of an illiquid gap is **`NULL` plus the timestamp of the last real print**, so
the consumer knows both "we don't have a price here" and "here's how stale the last one is."

### 8.4 The rule, grounded at the SQL layer

> **A gapfilled finance value is a fabricated number unless the gap is a genuine within-cadence dropout
> (a missed tick on an instrument that *was* trading).** Carrying or interpolating across a period when
> the market was **closed or the instrument was not trading** invents a price that never existed —
> violating "never invent a finance number." The SQL layer cannot tell a missed tick from a market
> holiday; **you** must, via a trading-calendar / session filter, before you let `locf`/`interpolate`
> touch the data.

Concretely: restrict the gapfill `start`/`finish` and the bucket grid to **trading sessions only**, so
the manufactured buckets are only ever within-session intervals where a missing bucket really does mean
"a tick we expected but didn't get," not "the market was shut."

### 8.5 Labeling filled points as synthetic in the API payload (non-negotiable)

Whenever the product *does* emit gapfilled rows, **every manufactured value must be labeled distinctly**
so the reader and the agent know it is synthetic, not observed. The cheapest, most robust way is to
carry an `is_real` / `source` flag alongside the value. Trick: select the **raw aggregate** (which is
`NULL` for manufactured buckets) *next to* the filled value, and derive the flag from whether the raw
aggregate was `NULL`:

```sql
SELECT
  bucket,
  symbol,
  filled_close,
  -- the raw aggregate is NULL exactly on the buckets gapfill manufactured:
  (raw_close IS NOT NULL)                         AS is_real,
  CASE WHEN raw_close IS NOT NULL THEN 'observed'
       ELSE fill_method END                       AS value_source
FROM (
  SELECT
    time_bucket_gapfill('1 day', ts, $1, $2)      AS bucket,
    symbol,
    last(close, ts)                               AS raw_close,      -- NULL on empty buckets
    locf(last(close, ts), treat_null_as_missing => true) AS filled_close,
    'locf'                                         AS fill_method
  FROM equity_prices
  WHERE ts >= $1 AND ts < $2 AND symbol = ANY($3)
  GROUP BY bucket, symbol
) g
ORDER BY symbol, bucket;
```

The JSON the API serves then looks like:

```json
{ "t": "2024-07-05", "symbol": "AAPL", "close": 192.25, "is_real": true,  "source": "observed" }
{ "t": "2024-07-06", "symbol": "AAPL", "close": 192.25, "is_real": false, "source": "locf"     }  // weekend — synthetic
```

> A downstream chart can grey out / dash the synthetic points; an analytics job can `WHERE is_real`
> before computing returns; the LLM agent, handed `is_real:false`, knows not to assert "AAPL was 192.25
> on Saturday." **This single flag is what turns a fabricated-number liability into an honest, labeled
> gapfill.** Do not ship a gapfilled finance payload without it.

### 8.6 The P&L-vs-model split (the deeper principle)

The industry-standard reconciliation (see the missing-data references in §12) is to keep **two** series:
- an `locf` "model price" series — usable for *features and signals* (you may not trade on it, but it's
  a defensible "last known"), and
- a separate "tradable price" series that is **`NULL` whenever no trade was possible** — usable for
  *P&L and execution* evaluation.

Never collapse them. A backtest that prices fills at `locf`/interpolated prices "executes" at numbers
no one could have hit, and reports a fantasy P&L. Encode the distinction as the `is_real` flag plus,
optionally, separate columns.

### 8.7 Treat a missing bucket as `NULL`, never `0`

A tempting "fix" for empty buckets is `coalesce(avg(price), 0)` or `sum(volume)` defaulting to `0`.
**For a price, `0` is catastrophic** — it implies the asset went to zero (bankruptcy), and any return
computed across it is `-100%` then `+∞`. The correct null is `NULL`:

| Quantity | Empty-bucket correct value | Why |
|---|---|---|
| price / close / level / yield | `NULL` (or `locf`+flag) | there was no price; `0` means "worthless" |
| return | `NULL` | no two prices to difference |
| **traded volume / count / # trades** | `0` is *correct* | a count of "how many trades happened" genuinely is zero on a no-trade interval |
| open interest / shares outstanding | `locf` (it persists) | a stock-of-quantity, not a flow — it carries forward by nature |

So the `0`-vs-`NULL` choice is **per-column and physical**: flows that count events are legitimately `0`
on an empty interval; levels/prices are `NULL`. Gapfill leaves manufactured buckets `NULL` by default —
which is correct for prices; you opt into `0` *only* for true counts:

```sql
SELECT time_bucket_gapfill('1 minute', ts, $1, $2) AS minute,
       symbol,
       last(price, ts)               AS close,       -- NULL on empty bucket = honest
       coalesce(sum(volume), 0)      AS volume        -- 0 on empty bucket = honest count
FROM trades
WHERE ts >= $1 AND ts < $2 AND symbol = $3
GROUP BY minute, symbol
ORDER BY minute;
```

---

## 9. The error catalogue (verbatim, from `gapfill_plan.c`)

These strings are raised by the planner node
([`tsl/src/nodes/gapfill/gapfill_plan.c`](https://github.com/timescale/timescaledb/blob/main/tsl/src/nodes/gapfill/gapfill_plan.c)).
Memorize the cause→fix for each — every one is a real mistake you will make once.

| Error string (verbatim) | Cause | Fix |
|---|---|---|
| `invalid time_bucket_gapfill argument: bucket_width must be greater than 0` | passed `'0 days'` or a negative/zero interval | use a positive interval |
| `multiple interpolate/locf function calls per resultset column not supported` | wrapped two markers in one column, e.g. `locf(interpolate(x))` | one fill per column; split into two columns |
| `<fn> must be toplevel function call` | nested a marker, e.g. `round(locf(avg(x)))` | keep the marker top-level; format in an outer query (§3) |
| `aggregate functions must be below <fn>` | aggregate placed above the gapfill marker | aggregate is the *argument* to the marker: `locf(avg(x))`, not `avg(locf(x))` |
| `window functions must not be below <fn>` / `multiple window function calls per column not supported` | mixed window functions under gapfill | move window functions to an outer query over the gapfill result |
| `multiple time_bucket_gapfill calls not allowed` | two `time_bucket_gapfill` in one query level | one time axis per query (§2) |
| `no top level time_bucket_gapfill in group by clause` | wrapped it (`date_trunc(...gapfill...)`) or it's not in `GROUP BY` | put the literal `time_bucket_gapfill(...)` at the top of `GROUP BY` |
| `time_bucket_gapfill does not support non-constant timezone` / `Use a constant timezone value.` | timezone arg is a column/parameter | pass a string literal zone (`'America/New_York'`) |
| `invalid time_bucket_gapfill argument: start must be a simple expression` | bound is a subquery/non-constant in WHERE-inference | pass `start`/`finish` as explicit **constant** args (§4) |
| `missing time_bucket_gapfill argument: could not infer start from WHERE clause` / `could not infer start boundary from WHERE clause` | WHERE has no usable bound (cast/`AT TIME ZONE`/false predicate) | pass explicit `start`/`finish` args (§4) |
| `ts needs to refer to a single column if no start or finish is supplied` | `ts` is an expression, not a plain column, and no bounds given | pass explicit bounds, or bucket a plain column |

The meta-lesson of this whole table: **pass explicit `start`/`finish`, keep markers top-level, one
gapfill per query.** Follow those three and almost every error above disappears.

---

## 10. Performance notes

### 10.1 The GapFill node is cheap; the scan under it is what costs

From the node README (§2), the GapFill custom-scan sits *above* aggregation and merely injects rows for
empty buckets. Its own cost is roughly `O(number of buckets in the range)` — it streams the sorted
aggregate output and emits manufactured rows in between. The expensive parts are:

1. **The base scan + aggregation.** Make sure the `WHERE ts >= start AND ts < finish` lets TimescaleDB
   do **chunk exclusion** (only touch chunks overlapping the range) and use the time index. A gapfill
   over a tight window on a well-chunked hypertable is fast; a gapfill that scans the whole hypertable
   because the WHERE bound got dropped is not.
2. **The injected Sort.** The node "requires data to be sorted by time, but it will inject sort nodes in
   the plan to ensure data is sorted correctly" (README). If your aggregation already emits rows ordered
   by `(group_keys, bucket)` — which it will if the hypertable's chunk-time ordering and the GROUP BY
   align — the planner can skip an explicit sort. Check `EXPLAIN` for a `Sort` node directly under
   `Custom Scan (GapFill)`; a large sort there is your cost. Adding an index on `(symbol, ts)` (the
   group key then time) often lets the plan produce pre-sorted input.

### 10.2 The range size is the multiplier you control

The node manufactures **one row per bucket per group across the entire `start`→`finish` range, whether
or not data exists**. That's the trap of an over-wide bounded range with a fine bucket:

```
rows_emitted ≈ (finish - start) / bucket_width  ×  number_of_groups
```

A `'1 second'` gapfill over a **year** for **1,000 symbols** is `31.5M × 1,000 ≈ 3.15e10` rows — it will
try to materialize tens of billions of rows and OOM or run for hours, *even if almost all are empty*.
Tiers, concretely (data-analytics product line R-SCALE discipline):

| Tier | Range × bucket × groups | rows manufactured | verdict |
|---|---|---|---|
| 1× | 1 day × 1 min × 1 symbol | 1,440 | trivial |
| 100× | 30 days × 1 min × 100 symbols | ~4.3M | OK with index + tight WHERE; paginate the API |
| 10,000× | 1 yr × 1 min × 1,000 symbols | ~525M | **don't** — pre-aggregate to a continuous aggregate, gapfill the *rollup*, not raw |

**Mechanisms to stay inside the tier:**
- **Pick the coarsest bucket the consumer actually needs.** A daily chart does not need a 1-minute
  gapfill.
- **Gapfill a continuous aggregate, not the raw hypertable.** Roll raw ticks into a `1m`/`1d`
  continuous aggregate (materialized, incrementally refreshed), then run `time_bucket_gapfill` over the
  *already-small* rollup. The gapfill then reads thousands of rows, not billions. (This is the standard
  TimescaleDB downsampling pattern; see the `patterns-continuous-aggregates` reference in this skill.)
- **Bound `start`/`finish` to exactly the requested window** — never "gapfill all of history just in
  case."
- **Restrict groups per query** (a watchlist of N symbols, paginated) rather than the whole universe.

### 10.3 `prev`/`next` subqueries

Each fires once **per group** *only when the edge bucket is empty* (§6.4). With a `(symbol, ts DESC)`
index the `ORDER BY ts DESC LIMIT 1` is an index-only backward scan — microseconds. Without it, it's a
per-group sequential scan and the gapfill that "ran fine in dev" times out the first holiday-opening
query in prod. **Verify the index in `EXPLAIN` before shipping any `prev`/`next` gapfill.**

---

## 11. Type & precision caveats

- **`interpolate` is numeric-only and float-precision.** It has overloads for
  `SMALLINT/INT/BIGINT/REAL/FLOAT` (§1.3) — **no `NUMERIC`**. To interpolate a `NUMERIC(18,6)` price you
  cast to `double precision`, which introduces binary-float rounding. For display that's fine; for a
  number you'll persist or reconcile against an exact ledger, round deliberately and document the
  precision loss. Prefer storing prices as `NUMERIC` and only casting at the interpolate boundary.
- **`locf` is fully polymorphic (`ANYELEMENT`)** — it carries `NUMERIC`, `text`, `bool`, anything, with
  no precision loss. When exactness matters, prefer `locf` over `interpolate`.
- **Integer interpolation truncates.** `interpolate(value INT)` returns `INT`; the midpoint of `1` and
  `2` is `1`, not `1.5`. Cast to `float` if you want fractional results.
- **`bucket_width` and DST.** With the timezone overload, calendar-day buckets across a DST boundary are
  23h/25h, not 24h — correct, but means your "evenly spaced" series isn't evenly spaced in *seconds*.
  For finance this is usually what you want (sessions align to local exchange time); just be aware when
  computing per-second rates.

---

## 12. Two complete, runnable, contrasting recipes

### 12.1 Regular-cadence sensor — interpolation is honest ✅

A temperature sensor *samples every 10 seconds*. A missing 1-minute bucket genuinely means "we expected
~6 readings and got none (a dropout)" — the underlying quantity (temperature) **did** vary continuously
during the gap, so a straight-line estimate between the neighbors is a *defensible* reconstruction.

```sql
-- Setup
CREATE TABLE sensor_data (ts TIMESTAMPTZ NOT NULL, sensor_id INT, temperature DOUBLE PRECISION);
SELECT create_hypertable('sensor_data', by_range('ts'));
CREATE INDEX ON sensor_data (sensor_id, ts DESC);   -- powers prev/next & pre-sorts gapfill

-- Honest interpolation of a continuous physical quantity over a dropout
SELECT
  time_bucket_gapfill('1 minute', ts, $1::timestamptz, $2::timestamptz) AS minute,
  sensor_id,
  avg(temperature)                          AS raw_avg,        -- NULL on a dropout bucket
  interpolate(
    avg(temperature),
    (SELECT (ts, temperature) FROM sensor_data s2
      WHERE s2.ts < $1 AND s2.sensor_id = s.sensor_id
      ORDER BY s2.ts DESC LIMIT 1),                            -- prev anchor
    (SELECT (ts, temperature) FROM sensor_data s3
      WHERE s3.ts >= $2 AND s3.sensor_id = s.sensor_id
      ORDER BY s3.ts ASC  LIMIT 1)                             -- next anchor
  )                                          AS temp_est,
  (avg(temperature) IS NOT NULL)             AS is_real        -- label synthetic points
FROM sensor_data s
WHERE ts >= $1 AND ts < $2 AND sensor_id = ANY($3::int[])
GROUP BY minute, sensor_id
ORDER BY sensor_id, minute;
```

Why this is honest: continuous physical signal + within-cadence dropout ⇒ interpolation estimates a
value the system plausibly held. The `is_real` flag still ships, so a consumer can distinguish measured
from estimated.

### 12.2 Irregular market series — gapfill with caution, `locf` only, sessions only, all flagged ⚠️

A daily equity close series. The market is **closed** on weekends/holidays — an empty bucket is **not** a
dropout, it's a non-trading day. We **do not interpolate** (it would invent prices). We **only**
forward-fill, **only flag** them, and ideally we restrict the grid to trading days.

```sql
-- Setup
CREATE TABLE equity_prices (ts TIMESTAMPTZ NOT NULL, symbol TEXT, close NUMERIC(18,6));
SELECT create_hypertable('equity_prices', by_range('ts'));
CREATE INDEX ON equity_prices (symbol, ts DESC);

-- (Recommended) a trading-calendar table so we never gapfill a closed day at all
CREATE TABLE trading_days (d DATE PRIMARY KEY);   -- one row per actual session

-- Honest forward-fill, SESSION-RESTRICTED, every fill labeled
WITH g AS (
  SELECT
    time_bucket_gapfill('1 day', ts, $1::timestamptz, $2::timestamptz) AS day,
    symbol,
    last(close, ts)                                       AS raw_close,   -- NULL on empty bucket
    locf(last(close, ts), treat_null_as_missing => true)  AS close_locf,
    'locf'                                                AS fill_method
  FROM equity_prices
  WHERE ts >= $1 AND ts < $2 AND symbol = ANY($3::text[])
  GROUP BY day, symbol
)
SELECT
  g.day,
  g.symbol,
  g.close_locf                              AS close,
  (g.raw_close IS NOT NULL)                 AS is_real,
  CASE WHEN g.raw_close IS NOT NULL THEN 'observed' ELSE g.fill_method END AS source
FROM g
JOIN trading_days td ON td.d = g.day::date   -- ⬅ DROP weekend/holiday buckets entirely
ORDER BY g.symbol, g.day;
```

What this recipe enforces, point by point:
1. **`locf`, never `interpolate`** — a carried close is "last known"; an interpolated close is invented.
2. **`treat_null_as_missing => true`** — skip `NULL` aggregate buckets, carry the last *real* close.
3. **`raw_close` kept beside the fill** — the `is_real` flag is derived from it, so synthetic points are
   labeled in the payload (§8.5).
4. **`JOIN trading_days`** — non-trading buckets are *removed*, not carried, so the series never claims a
   price on a closed day (§8.4). If you can't drop them (a fixed-grid ML matrix needs every calendar
   day), keep them but rely on `is_real:false` and never compute returns over them.
5. **Explicit `start`/`finish` args** + matching WHERE (§4) — deterministic range, index-pruned scan.
6. **`(symbol, ts DESC)` index** — pre-sorts the gapfill input and would power any `prev` lookup (§10).

> The difference between 12.1 and 12.2 is the whole lesson: **same three functions, opposite verdicts,
> because the data-generating process is different.** A continuous signal with random dropouts may be
> interpolated; a market that is genuinely closed may not. The SQL is identical-looking — *you* supply
> the judgment, and you encode it as session filters + `is_real` flags so the next reader doesn't have
> to re-derive it.

---

## 13. Checklist before you ship a gapfill query

- [ ] `start` and `finish` passed as **explicit constant arguments** (not relying on WHERE-inference).
- [ ] `WHERE ts >= start AND ts < finish` also present (for chunk exclusion / index use).
- [ ] `time_bucket_gapfill(...)` is the **literal top-level** call in `GROUP BY`.
- [ ] `locf`/`interpolate` are **top-level** in their column; cosmetic transforms (`round`, casts) are
      in an **outer** query.
- [ ] Exactly **one** `time_bucket_gapfill` in the query level.
- [ ] **Finance:** is the gap a within-session dropout or a closed market? If closed → **no
      `interpolate`**, `locf`-or-`NULL` only, and **drop** non-session buckets or flag them.
- [ ] Every manufactured row carries an **`is_real` / `source` flag** in the payload.
- [ ] Empty **price** buckets are `NULL` (or flagged `locf`), never `0`; only true **counts** default to
      `0`.
- [ ] `treat_null_as_missing => true` chosen deliberately for `locf` over sparse aggregates.
- [ ] Range × bucket × groups row-count estimated against the tier table (§10.2); gapfill a **continuous
      aggregate**, not raw, at scale.
- [ ] `(group_key, ts DESC)` index exists — confirmed in `EXPLAIN` — if using `prev`/`next` or to
      pre-sort.
- [ ] `interpolate` on a `NUMERIC` column: precision loss from the `double precision` cast is
      acknowledged/rounded.

---

## 14. Sources (all read for this reference)

- `time_bucket_gapfill()` reference — <https://docs.tigerdata.com/api/latest/hyperfunctions/gapfilling/time_bucket_gapfill/>
- `locf()` reference — <https://docs.tigerdata.com/api/latest/hyperfunctions/gapfilling/locf/>
- `interpolate()` reference — <https://docs.tigerdata.com/api/latest/hyperfunctions/gapfilling/interpolate/>
- Use-case page (gapfilling & interpolation) — <https://docs.tigerdata.com/use-timescale/latest/hyperfunctions/gapfilling-interpolation/time-bucket-gapfill/>
- **`sql/gapfill.sql`** (exact signatures) — <https://github.com/timescale/timescaledb/blob/main/sql/gapfill.sql>
- **GapFill node `README.md`** (plan-node model) — <https://github.com/timescale/timescaledb/blob/main/tsl/src/nodes/gapfill/README.md>
- `gapfill_plan.c` (error strings, §9) — <https://github.com/timescale/timescaledb/blob/main/tsl/src/nodes/gapfill/gapfill_plan.c>
- Issue #6528 — `locf(last(...))` per-bucket behavior — <https://github.com/timescale/timescaledb/issues/6528>
- PR #1067 / issue #1588 — `treat_null_as_missing` — <https://github.com/timescale/timescaledb/pull/1067>, <https://github.com/timescale/timescaledb/issues/1588>
- Issues #1231, #1345, #1818, #2595, #4279 — WHERE-inference failure modes (§4.2) — `https://github.com/timescale/timescaledb/issues/{1231,1345,1818,2595,4279}`
- Mind-the-gap / missing-data-in-finance discussion (the `locf`-vs-tradable-price split, §8.6) —
  <https://www.researchgate.net/post/How-to-deal-with-missing-value-in-a-time-series-stock-market-data>,
  <https://growth-onomics.com/handling-missing-data-in-time-series-5-methods/>

> **Note on doc hostnames:** the canonical docs now live under `docs.tigerdata.com` /
> `www.tigerdata.com/docs` (Timescale rebranded to TigerData); `docs.timescale.com` 301-redirects there.
> The `github.com/timescale/timescaledb` source repo is unchanged and authoritative for signatures and
> error strings — prefer it when a doc page is ambiguous.
