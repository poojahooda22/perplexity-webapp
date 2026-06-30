# Continuous Aggregates — the compute-once-serve-many engine

> **Scope.** Dev-skill reference for the **JPM-Markets re-engineering data-analytics product line (NOT Lumina)**.
> Continuous aggregates (CAGGs) end to end: how `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)`
> builds a *second hypertable*, how the materialization engine + invalidation log keep it current
> incrementally, the `add_continuous_aggregate_policy(start_offset, end_offset, schedule_interval)`
> refresh model, **real-time vs `materialized_only`** (the default flipped in v2.13 — read §4 carefully),
> **hierarchical caggs** (cagg-on-a-cagg, 1m→1h→1d), the `MATPARTCOL_INTERVAL_FACTOR = 10` chunk detail,
> compression + retention *on* caggs, the `timescaledb_information.continuous_aggregates` view, and the
> pitfalls that silently serve stale or double-counted numbers.
>
> **Why this matters for the product line.** A markets data-analytics platform is read-dominated: thousands
> of dashboard panels and agent tool-calls all want "1-day OHLC for AAPL", "hourly mean spread for this
> index", "p95 latency of the pricing service per 5 min". Computing those from raw ticks on every request is
> the J.P.-Morgan-Athena anti-pattern at scale — you re-derive the same flyer for every reader. A continuous
> aggregate **computes the rollup once, incrementally, in the background, and serves it from an indexed
> second hypertable** to every reader. This is the engine that turns a tick firehose into a fast dashboard.
> It is the database-native realization of the repo's own R-SCALE law: *compute-once-serve-many*.

**Version baseline.** All claims below are pinned to TimescaleDB **2.13+** (the version line where
`materialized_only` defaults to `true`). Where a behavior is version-gated, the version is stated inline.
Verify against your installed version with `SELECT extversion FROM pg_extension WHERE extname='timescaledb';`
before trusting a default — the v2.13 default flip is the single most common source of "why is my cagg
empty / stale?" confusion.

---

## 0. Mental model in one paragraph

A continuous aggregate is **two things wearing one name**:

1. A **materialization hypertable** (internal name `_materialized_hypertable_<id>`) — a real, chunked,
   indexable, compressible hypertable that physically stores the pre-computed `time_bucket(...)` rollup rows.
2. A **view** (the name you `CREATE MATERIALIZED VIEW … AS`) that you `SELECT` from. In the default
   `materialized_only = true` mode the view just reads the materialization hypertable. In real-time mode
   (`materialized_only = false`) the view is a `UNION ALL` of the materialization hypertable **plus** a
   live aggregation of the raw source data newer than the materialization **watermark**.

Around those two objects sits the **refresh machinery**: an *invalidation log* records which old time
regions changed, a *threshold/watermark* marks how far materialization has advanced, and a *refresh policy*
(a background job) periodically walks the invalidation log and re-materializes only the dirty buckets inside
a bounded window. Nothing is recomputed from scratch on each refresh — that incrementality is the whole point.

Source for the four-component decomposition (materialization hypertable · materialization engine ·
invalidation engine · query engine):
[Understand continuous aggregates — Tiger Data Docs](https://www.tigerdata.com/docs/learn/continuous-aggregates)
("Continuous aggregates … are refreshed automatically in the background as new data is added, or old data is modified.").

---

## 1. Creating a continuous aggregate — `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)`

### 1.1 The canonical form

```sql
CREATE MATERIALIZED VIEW conditions_summary_daily
WITH (timescaledb.continuous) AS
SELECT
    device,
    time_bucket(INTERVAL '1 day', time) AS bucket,
    AVG(temperature)  AS avg_temp,
    MAX(temperature)  AS max_temp,
    MIN(temperature)  AS min_temp
FROM conditions
GROUP BY device, bucket
WITH NO DATA;
```

Verbatim shape from
[Create a continuous aggregate — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/create-a-continuous-aggregate)
(the docs' canonical example uses `device, time_bucket(INTERVAL '1 day', time) AS bucket, AVG/MAX/MIN`).

The contract, piece by piece:

| Clause | Rule | Why |
|---|---|---|
| `WITH (timescaledb.continuous)` | The storage parameter that tells TimescaleDB this is a CAGG, not a plain PG materialized view. | A plain `MATERIALIZED VIEW` has **no** incremental refresh — you'd `REFRESH MATERIALIZED VIEW` the whole thing, which is the exact O(all-rows) cost a cagg exists to avoid. |
| `time_bucket(<interval>, <time_col>)` in `SELECT` **and** `GROUP BY` | The `GROUP BY` **must** include `time_bucket` on the hypertable's time partitioning column. | The bucket column becomes the time dimension of the materialization hypertable. |
| All functions in `SELECT` / `GROUP BY` / `HAVING` **immutable** | "all functions and their arguments included in `SELECT`, `GROUP BY`, and `HAVING` clauses must be immutable." | A mutable function (e.g. `now()`) would make a materialized bucket's value depend on *when* it was computed — non-deterministic, un-cacheable. Source: [Create a continuous aggregate](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/create-a-continuous-aggregate). |
| `WITH NO DATA` (recommended) vs `WITH DATA` | `WITH NO DATA` creates the cagg instantly without back-filling; `WITH DATA` materializes the entire history synchronously at creation. | See §1.3 — `WITH DATA` also materializes the **currently-open bucket**, a documented foot-gun. |

### 1.2 Aggregate-function support by version

- **2.7+**: *all* PostgreSQL aggregates, including non-parallelizable ones. Earlier versions only allowed
  parallelizable aggregates (`SUM`, `AVG`, `COUNT`). Source:
  [About continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates).
- **2.10+**: `ORDER BY` inside aggregates, `DISTINCT` in aggregates, and `FILTER` clauses are allowed, e.g.
  `COUNT(DISTINCT symbol)`. Same source.
- **2.10+ / 2.16+**: JOINs. `INNER JOIN` since 2.10.0; `LEFT JOIN`, `LATERAL JOIN`, multiple PG tables, and
  flexible join conditions since 2.16.x. **Only changes to the hypertable are tracked for invalidation —
  changes to a joined plain PostgreSQL table are *not* tracked**, so a dimension-table update will not
  invalidate already-materialized buckets. Source:
  [About continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates).

```sql
-- JOIN a hypertable to a dimension table (TimescaleDB 2.10+ INNER JOIN)
CREATE MATERIALIZED VIEW conditions_by_day WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', time) AS bucket, devices.name,
       MIN(temperature), MAX(temperature)
FROM conditions
JOIN devices ON devices.id = conditions.device_id
GROUP BY bucket, devices.name
WITH NO DATA;
```

(Exact example from the docs cited above. **Caveat for the markets product line:** if `devices` were a
mutable instrument-reference table, a renamed instrument would not back-propagate into already-materialized
rows — treat joined dimension tables as effectively frozen at materialization time, or re-materialize on
dimension change.)

### 1.3 `WITH NO DATA` is the default you want — and why `WITH DATA` is a trap

`WITH DATA` materializes everything at `CREATE` time *including the currently-open (incomplete) time bucket*.
That open bucket's aggregate is computed from whatever raw rows exist at that instant, the **watermark is set
past it**, and subsequent inserts into that same open bucket **do not show up** until a manual refresh or the
next policy run.

> "the currently open time bucket is materialized which leads to weird, unexpected results when adding
> additional data into the currently open time bucket."
> — [timescaledb#5379: Initial materialization (with data) materializes the currently open time bucket](https://github.com/timescale/timescaledb/issues/5379)
> (repro: watermark set to `10:00`, current bucket `09:00`; an inserted value of 1000 into the open bucket
> still shows the stale max of 50).

**Recipe:** always create `WITH NO DATA`, then either attach a refresh policy (§3, whose `end_offset`
excludes the open bucket) or back-fill explicitly with a bounded `refresh_continuous_aggregate` whose
`window_end` is strictly before the current open bucket (§5). This is also faster and memory-safer on a
multi-year hypertable — you control the back-fill in chunks rather than blocking on one giant transaction.

---

## 2. The materialization hypertable — and the `× 10` chunk-interval detail

When you create a cagg, TimescaleDB creates a **second, internal hypertable** to hold the rollup rows. Its
internal name is `_materialized_hypertable_<id>`, in the `_timescaledb_internal` schema. It is a *real*
hypertable: it has chunks, you can index it, compress it, set a retention policy on it, and inspect its
chunks. Source for the naming convention:
[Creating and Configuring Continuous Aggregates — DeepWiki (reads timescaledb source)](https://deepwiki.com/timescale/timescaledb/4.1-creating-and-configuring-continuous-aggregates)
("an internal hypertable (`_materialized_hypertable_ID`) that stores the results of the Partial View").

### 2.1 The default chunk interval is **10× the source** (for non-hierarchical caggs)

This is the detail that trips people who tune chunk sizes carefully on the raw hypertable and then wonder why
the cagg has oddly large chunks. The materialization hypertable's `chunk_time_interval` defaults to
**the source hypertable's chunk interval × 10**, applied **only for non-hierarchical caggs**.

Verified at the source level — `tsl/src/continuous_aggs/create.c`:

```c
/* tsl/src/continuous_aggs/create.c, line ~96 */
#define MATPARTCOL_INTERVAL_FACTOR 10

/* tsl/src/continuous_aggs/create.c, ~line 815-825 */
matpartcol_interval = bucket_info->htpartcol_interval_len;
/* Apply the factor just for non-Hierachical CAggs */
if (bucket_info->parent_mat_hypertable_id == INVALID_HYPERTABLE_ID)
{
    matpartcol_interval *= MATPARTCOL_INTERVAL_FACTOR;
}
```

Source: [timescaledb/tsl/src/continuous_aggs/create.c @ main](https://github.com/timescale/timescaledb/blob/main/tsl/src/continuous_aggs/create.c)
(the constant `MATPARTCOL_INTERVAL_FACTOR` = `10`, multiplied into `matpartcol_interval` only when
`parent_mat_hypertable_id == INVALID_HYPERTABLE_ID`, i.e. the cagg is built directly on a raw hypertable,
not on another cagg).

**The arithmetic, made concrete.** Suppose the raw `ticks` hypertable has `chunk_time_interval => INTERVAL '1 day'`
and you build a `ticks_1m` cagg bucketed at 1 minute:

- Raw hypertable chunk = 1 day of raw ticks.
- A 1-minute cagg produces 1440 rows/day per group. The *bucket width* is 1 minute, but the **materialization
  chunk** spans **10 days** (`1 day × 10`), so each materialization chunk holds ~14,400 bucket-rows/group.

**Why 10× and not 1×:** the rollup is far smaller than the raw data, so a 1× chunk interval would create
*tiny* materialization chunks (chunk-per-day of an already-shrunken table) — too many chunks, more planning
overhead, worse compression ratios. 10× keeps chunk count sane while still small enough to drop/compress at a
useful granularity.

**Hierarchical caggs (cagg-on-a-cagg) do NOT get the ×10.** Because the parent is already a cagg
(`parent_mat_hypertable_id != INVALID`), the factor branch is skipped and the child's materialization chunk
interval equals the parent's bucket-derived interval. This prevents the multiplier from compounding (10×
then 100× then 1000×) up a deep hierarchy. (Same `create.c` code path above.)

### 2.2 Override the chunk interval after creation

There is no `chunk_time_interval` option inside the `CREATE MATERIALIZED VIEW … WITH (...)` clause in current
released versions (it is a long-standing
[enhancement request, timescaledb#6923](https://github.com/timescale/timescaledb/issues/6923)). To change it,
call `set_chunk_time_interval()` on the **materialization hypertable** (not on the view name), which you look
up from the information view:

```sql
-- Find the materialization hypertable name for a cagg:
SELECT view_name, materialization_hypertable_schema, materialization_hypertable_name
FROM   timescaledb_information.continuous_aggregates
WHERE  view_name = 'ticks_1m';
--  ticks_1m | _timescaledb_internal | _materialized_hypertable_7

-- Set a custom chunk interval on that internal hypertable:
SELECT set_chunk_time_interval(
  format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass,
  INTERVAL '7 days')
FROM timescaledb_information.continuous_aggregates
WHERE view_name = 'ticks_1m';
```

**Pitfall:** historically `set_chunk_time_interval` directly on a cagg's materialization hypertable hit a bug
([timescaledb#4002](https://github.com/timescale/timescaledb/issues/4002)). On modern versions it works via
the `regclass` of the internal hypertable as above; if a version errors, change it before the cagg accumulates
chunks (it only affects *future* chunks regardless). Always confirm on your pinned version.

---

## 3. Refresh policies — `add_continuous_aggregate_policy(...)`

A cagg created `WITH NO DATA` is empty and **stays empty forever** unless something refreshes it. The
standard mechanism is a background **refresh policy**.

### 3.1 Full signature and every parameter

```sql
SELECT add_continuous_aggregate_policy(
    continuous_aggregate       => '<view_name>',      -- REGCLASS, required
    start_offset               => <interval|integer>, -- required
    end_offset                 => <interval|integer>, -- required
    schedule_interval          => <interval>,         -- default 24 hours
    if_not_exists              => true|false,         -- default false
    initial_start              => <timestamptz>,      -- default NULL
    timezone                   => '<timezone>',       -- default NULL
    include_tiered_data        => true|false,         -- default NULL (inherits GUC)
    buckets_per_batch          => <integer>,          -- default 10
    max_batches_per_execution  => <integer>,          -- default 0 (unlimited)
    refresh_newest_first       => true|false          -- default TRUE
);
-- returns job_id (INTEGER)
```

Full signature/defaults verified at
[add_continuous_aggregate_policy() — Tiger Data Docs](https://www.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/add_continuous_aggregate_policy).

| Parameter | Meaning (verbatim/condensed from docs) |
|---|---|
| `start_offset` | "Start of the refresh window as an interval relative to the time when the policy is executed." `NULL` ⇒ `MIN(timestamp)` of the hypertable (open-ended back to the beginning of time). |
| `end_offset` | "End of the refresh window … relative to … the policy is executed." `NULL` ⇒ `MAX(timestamp)`. **See §3.3 — this is the most consequential knob.** |
| `schedule_interval` | Wall-clock time between policy runs. **Defaults to 24 hours.** For an operational dashboard you almost always lower this (e.g. `INTERVAL '1 minute'`). |
| `initial_start` | First time the policy runs; becomes the origin from which subsequent `next_start` is computed. `NULL` ⇒ scheduler picks. |
| `timezone` | "Mitigates DST alignment shifts when `initial_start` is specified." Set it (e.g. `'UTC'` or a market TZ) so the schedule doesn't drift across DST. |
| `if_not_exists` | `true` ⇒ emit a notice instead of erroring if a policy already exists. Idempotent migrations. |
| `include_tiered_data` | Overrides the `timescaledb.enable_tiered_reads` GUC for this policy (object-storage-tiered chunks). |
| `buckets_per_batch` | Splits the refresh window into batches of `bucket_width × buckets_per_batch`; **each batch is its own transaction**, so partially-refreshed results become visible sooner. Default 10. |
| `max_batches_per_execution` | Cap on batches processed per run; `0` = unlimited. Bound the work a single run can do on huge back-fills. |
| `refresh_newest_first` | `TRUE` ⇒ refresh newest→oldest (dashboards see fresh data first); `FALSE` ⇒ oldest→newest. |

`buckets_per_batch` semantics — verbatim: "Setting `buckets_per_batch` greater than zero means that the
refresh window is split in batches of `bucket width * buckets per batch`. … Because each batch is an
individual transaction, executing a policy in batches make the data visible for the users before the entire
job is executed." Source:
[add_continuous_aggregate_policy() — Tiger Data Docs](https://www.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/add_continuous_aggregate_policy).

### 3.2 The window is *relative to now, sliding*

A refresh policy run computes its window each time as
`[ now() - start_offset , now() - end_offset ]` and re-materializes the **invalidated** buckets inside it.
Conceptually:

```
                 start_offset                end_offset
   |----------------|===========================|----------|  raw time axis →
 -∞              window start              window end      now()
                    \____________ refresh window _________/
                     (only DIRTY buckets here are re-materialized)
```

- **`start_offset` bounds how far back** the policy is willing to reach to pick up late/changed data. Set it
  to cover your realistic late-arrival horizon (and any historical corrections you expect). `NULL` = "all of
  history every run" — correct but potentially expensive on huge tables; bound it when you can.
- **`end_offset` bounds how close to `now()`** the policy is allowed to materialize.

### 3.3 What `end_offset` really means — "never materialize newer than this"

`end_offset` is the **"never materialize newer than now − end_offset"** guard. It exists to keep the policy
from materializing the **currently-open, incomplete bucket** — because that bucket is still receiving
in-order writes and its aggregate would be immediately outdated, forcing wasteful re-materialization minutes
later.

> "If you set `end_offset` within the current time bucket, this bucket is excluded from materialization"
> because "The current bucket is incomplete and can't be refreshed" and it "gets a lot of writes in the
> timestamp order, and its aggregate becomes outdated very quickly."
> — [Refresh policies — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/refresh-policies)

Practical sizing rule (from a production rollup-design guide): set `end_offset` to **"max expected
late-arrival window + a couple of minutes of safety."** If your ingest can lag 30 minutes (e.g. buffering
mobile/edge clients, or a delayed market-data vendor backfill), set `end_offset` to ≥ 35 minutes; for a
clean low-latency feed, one bucket-width plus a small margin is enough. Source:
[TimescaleDB continuous aggregates: designing rollups for fast dashboards — Stack Harbor](https://stackharbor.com/en/knowledge-base/timescaledb-continuous-aggregates-strategy/).

There is a tension here that you tune deliberately:

- **`end_offset` too small** → you materialize incomplete buckets and re-materialize them repeatedly (waste,
  and transient wrong values for the open bucket).
- **`end_offset` too large** → the materialized data is stale by `end_offset`, and (in `materialized_only`
  mode) dashboards can't see anything newer than `now() − end_offset` at all.

Real-time mode (§4) resolves the "too large = stale tail" half of this by unioning the live tail; but the
policy should *still* not materialize the open bucket.

### 3.4 Two canonical policies

```sql
-- (A) Keep the cagg in lockstep with the hypertable: re-aggregate the full history each run.
--     start_offset = NULL  -> reach back to the beginning of time (picks up any old change).
SELECT add_continuous_aggregate_policy('conditions_summary_hourly',
  start_offset      => NULL,
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- (B) Preserve a bounded window (don't let deletes/old changes more than 1 month back rewrite the cagg).
SELECT add_continuous_aggregate_policy('conditions_summary_hourly',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');
```

Both verbatim from [Refresh policies — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/refresh-policies)
(policy (A) = "keeping data in sync with hypertable"; (B) = "preserving deleted data in aggregate").

### 3.5 Inspecting and removing policies

```sql
-- See policy jobs:
SELECT * FROM timescaledb_information.jobs
WHERE proc_name = 'policy_refresh_continuous_aggregate';

-- See last run + success/failure:
SELECT job_id, last_run_status, last_successful_finish, total_failures
FROM timescaledb_information.job_stats
WHERE job_id IN (
  SELECT job_id FROM timescaledb_information.jobs
  WHERE proc_name = 'policy_refresh_continuous_aggregate');

-- Remove a policy (by cagg name):
SELECT remove_continuous_aggregate_policy('conditions_summary_hourly');
```

(`remove_continuous_aggregate_policy(<cagg>)` is the inverse of `add_…`; if a version requires it, pass
`if_exists => true` for idempotent teardown. Confirm the exact arg list on your pinned version.)

---

## 4. Real-time vs `materialized_only` — read this twice

This is the single most misunderstood knob, because **the default flipped in v2.13** and most blog posts
(and the older docs, and some training data) describe the *old* default.

### 4.1 The two modes

| Mode | Setting | What a `SELECT` returns | Cost |
|---|---|---|---|
| **Materialized-only** | `timescaledb.materialized_only = true` | **Only** rows already in the materialization hypertable. Anything newer than the watermark is invisible until the next refresh. | Fast — pure indexed read of the materialization hypertable; **never touches the source hypertable.** |
| **Real-time** | `timescaledb.materialized_only = false` | Materialized rows **`UNION ALL`** a live aggregation of raw source rows **newer than the watermark**. Always up to `now()`. | Slower on the recent window — runs the full aggregation over raw data for the unmaterialized tail on every query. |

How the real-time plan actually looks (verified description): the planner produces "an `Append` node with two
children — one scan of the materialization hypertable (fast) and one scan of the source hypertable (slower,
because it runs the full aggregation on raw data)." The two result sets are unioned automatically, split at
the **`cagg_watermark`**. Source:
[TimescaleDB Continuous Aggregates: Real-Time vs Materialized-Only — DEV (philip_mcclarence)](https://dev.to/philip_mcclarence_2ef9475/timescaledb-continuous-aggregates-real-time-vs-materialized-only-4k75).

The split is by the materialization **watermark** (`cagg_watermark` function reads
`_timescaledb_catalog.continuous_aggs_watermark`, "the high-water mark of materialization"). Real-time mode
takes materialized rows **at or below** the watermark and live-aggregates raw rows **above** it — so by
construction the two halves do **not overlap** and cannot double-count. Source:
[Continuous Aggregates — DeepWiki (reads source)](https://deepwiki.com/timescale/timescaledb/4-continuous-aggregates).

### 4.2 The default flip in v2.13 — the load-bearing version fact

- **TimescaleDB < 2.13**: real-time aggregates were **ENABLED** by default (`materialized_only = false`).
  A freshly-created cagg returned current data immediately.
- **TimescaleDB ≥ 2.13**: real-time aggregates are **DISABLED** by default — `materialized_only` defaults to
  **`true`**. A freshly-created cagg with no policy yet, queried right after creation, returns **nothing**
  for the recent (unmaterialized) range, and you must *opt in* to the live tail.

Source (authoritative): "In TimescaleDB v2.13 and later, real-time aggregates are **DISABLED** by default."
[Real-time aggregates — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/real-time-aggregates)
and [About continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates).

> ⚠️ **Documentation discrepancy, flagged.** Several otherwise-good third-party write-ups (e.g. the dev.to
> "Real-Time vs Materialized-Only" article, and the TraderMade OHLC tutorial which sets
> `timescaledb.materialized_only = false` explicitly) describe real-time as "the default." That was true
> *before* 2.13. On a modern install, **assume `materialized_only = true` unless you set otherwise.** Treat
> the official Tiger/Timescale docs as authoritative over blogs on this point. Always verify with the
> information view (§6).

### 4.3 Switching modes after creation

```sql
-- Turn ON the live tail (real-time aggregation):
ALTER MATERIALIZED VIEW ticks_1m SET (timescaledb.materialized_only = false);

-- Turn it OFF (materialized-only; fastest reads, but stale by end_offset + schedule_interval):
ALTER MATERIALIZED VIEW ticks_1m SET (timescaledb.materialized_only = true);
```

Both verbatim from [Real-time aggregates — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/real-time-aggregates).
You can also set it inline at creation: `WITH (timescaledb.continuous, timescaledb.materialized_only = false)`.

### 4.4 Which mode for which surface (markets product line)

| Surface | Mode | Why |
|---|---|---|
| Live operational dashboard, alerting, "current price/spread/latency" panel | **real-time** (`materialized_only = false`) | Users need data up to `now()`; they tolerate slightly slower recent-window queries. |
| Billing/usage reports, daily research notes, EOD analytics, anything reconciled against a "closed" period | **materialized-only** (`materialized_only = true`) | Freshness can lag; **query consistency** (a number that won't shift mid-report) and fastest reads matter more. |
| A cagg that is the **source of a hierarchical cagg** (a 1m feeding a 1h) | usually **real-time on the leaf, materialized-only on internal levels** | See §5.4 — a non-real-time parent halts recursive live-tailing above it. |

Trade-off table (verbatim structure from the dev.to article):

| Aspect | Real-Time | Materialized-Only |
|---|---|---|
| Freshness | Current (up to `now()`) | Stale by `end_offset + schedule_interval` |
| Recent-window query perf | Slower (live aggregation over raw tail) | Fast (materialization read only) |
| Touches source hypertable on read | Yes, for the unmaterialized range | Never |

Source: [Real-Time vs Materialized-Only — DEV](https://dev.to/philip_mcclarence_2ef9475/timescaledb-continuous-aggregates-real-time-vs-materialized-only-4k75).
On a massive source hypertable the live-tail aggregation can dominate; the rollup-design guide reports
flipping to `materialized_only = true` giving up to a "100x speedup" on the recent window at the cost of
staleness. Source: [Stack Harbor rollups guide](https://stackharbor.com/en/knowledge-base/timescaledb-continuous-aggregates-strategy/).

---

## 5. Manual refresh — `refresh_continuous_aggregate(...)`

The policy automates refresh, but you call `refresh_continuous_aggregate` directly for **back-fills**,
**targeted re-materialization** after a correction, and **bounded initial population** of a `WITH NO DATA`
cagg.

### 5.1 Signature and semantics

```sql
CALL refresh_continuous_aggregate(
    continuous_aggregate => '<view_name>',  -- required
    window_start         => <timestamptz>,  -- NULL ⇒ lowest changed element in raw hypertable
    window_end           => <timestamptz>,  -- NULL ⇒ largest changed element in raw hypertable
    force                => false            -- optional; default false
);

-- Example:
CALL refresh_continuous_aggregate('conditions', '2021-05-01', '2021-06-01');
```

Key rules (verbatim/condensed from
[refresh_continuous_aggregate() — Tiger Data Docs](https://www.tigerdata.com/docs/api/latest/continuous-aggregates/refresh_continuous_aggregate)):

- **"Only buckets that are wholly within the specified range are refreshed."** For `'2021-05-01','2021-06-01'`
  the buckets refreshed are those *up to but not including* `2021-06-01`. A partial bucket at either edge is
  excluded — "It is not possible to compute the aggregate over an incomplete bucket."
- `window_start = NULL` ⇒ "the lowest changed element in the raw hypertable"; `window_end = NULL` ⇒ "the
  largest changed element."
- **`force => true`** "forces refresh of every bucket in the time range … even when the bucket has already
  been refreshed." Default (`false`) skips buckets already materialized and not invalidated — i.e. it only
  does the *incremental* work. Use `force` only when you've changed the *definition*/logic outside the
  invalidation system's knowledge.

```sql
-- Force a full re-materialization of a window even if already current:
CALL refresh_continuous_aggregate('conditions', '2020-01-01', '2020-02-01', force => TRUE);
```

(Verbatim example from the docs cited above.)

### 5.2 The bounded back-fill recipe (the right way to populate a `WITH NO DATA` cagg on a big table)

A single `CALL refresh_continuous_aggregate('cagg', NULL, NULL)` over years of data can blow memory and lock
for a long time. Back-fill in **bounded slices**, oldest to newest, each its own transaction:

```sql
-- Back-fill month by month (script or generate_series the bounds in app code):
CALL refresh_continuous_aggregate('metrics_5min', '2025-01-01', '2025-02-01');
CALL refresh_continuous_aggregate('metrics_5min', '2025-02-01', '2025-03-01');
-- … up to but not including the current open bucket.
```

Recipe and rationale ("refresh in chunks to avoid memory pressure") from
[Stack Harbor rollups guide](https://stackharbor.com/en/knowledge-base/timescaledb-continuous-aggregates-strategy/).
Stop the back-fill before the currently-open bucket; let the policy take over from there (its `end_offset`
keeps it off the open bucket — §3.3).

---

## 6. Inspecting caggs — `timescaledb_information.continuous_aggregates`

The catalog view that tells you everything about a cagg's wiring:

```sql
SELECT
    view_schema, view_name, view_owner,
    materialized_only,                    -- bool: real-time OFF when true
    compression_enabled,                  -- bool: columnstore/compression on the materialization hypertable
    finalized,                            -- bool: finalized format (required for hierarchical; default since 2.7)
    hypertable_schema, hypertable_name,   -- the SOURCE hypertable
    materialization_hypertable_schema,    -- e.g. _timescaledb_internal
    materialization_hypertable_name,      -- e.g. _materialized_hypertable_7
    view_definition
FROM timescaledb_information.continuous_aggregates
WHERE view_name = 'ticks_1m';
```

Column list verified at
[timescaledb_information.continuous_aggregates — Tiger Data Docs](https://docs.timescale.com/api/latest/informational-views/continuous_aggregates/):
`hypertable_schema, hypertable_name, view_schema, view_name, view_owner, materialized_only,
compression_enabled, materialization_hypertable_schema, materialization_hypertable_name, view_definition,
finalized`.

- **`materialized_only`** — your real-time-vs-not status. After the v2.13 flip this is `true` (real-time off)
  unless you set it. If a dashboard "is missing the last few minutes", check this column **first**.
- **`finalized`** — `true` means the cagg uses the finalized storage format, the **default since 2.7** and a
  **hard prerequisite for stacking another cagg on top** (§7). An old non-finalized cagg must be migrated
  before it can be a hierarchical parent.
- **`materialization_hypertable_name`** — the handle you pass to `set_chunk_time_interval`, compression
  policies, retention policies, and `show_chunks` when you want to operate on the rollup's physical storage.

Detecting staleness (is the policy actually keeping up?):

```sql
-- "How far behind real time is the materialized data?"
SELECT
    c.view_name,
    (SELECT max(bucket) FROM ticks_1m)                AS latest_materialized,
    now() - (SELECT max(bucket) FROM ticks_1m)        AS staleness
FROM timescaledb_information.continuous_aggregates c
WHERE c.view_name = 'ticks_1m';
```

(Pattern from the dev.to article: if `staleness` far exceeds `end_offset + schedule_interval`, "the refresh
policy is not running properly" — cross-check `job_stats.last_run_status`.) Source:
[Real-Time vs Materialized-Only — DEV](https://dev.to/philip_mcclarence_2ef9475/timescaledb-continuous-aggregates-real-time-vs-materialized-only-4k75).

---

## 7. Hierarchical continuous aggregates — cagg on a cagg (1m → 1h → 1d)

This is the heart of the "right-sized rollup per dashboard zoom" design. You build a base cagg on the raw
hypertable, then build coarser caggs **on the cagg below**, never re-scanning raw data at each level.

### 7.1 The rule set

From [Hierarchical continuous aggregates — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates):

1. **Build on a cagg, not a hypertable.** "select from a continuous aggregate rather than from the hypertable,
   and use the time-bucketed column from the existing continuous aggregate as your time column."
2. **The parent must be FINALIZED.** "You can only create a continuous aggregate on top of a finalized
   continuous aggregate." Finalized is the default since 2.7; older caggs need migration. (Check `finalized`
   in the info view — §6.)
3. **The upper bucket must be a multiple of the lower bucket**, and **≥** it. "greater than or equal to the
   time bucket of the underlying continuous aggregate" and "a multiple of the underlying time bucket" — e.g.
   6h on top of 1h ✓; **90 min on top of 1h ✗** (not a multiple).
4. **No fixed-on-variable.** "A continuous aggregate with a fixed-width time bucket can't be created on top of
   a continuous aggregate with a variable-width time bucket." (Variable-on-fixed is fine — e.g. monthly on
   daily ✓, because months are variable-width and days are fixed.)

### 7.2 The cascade, written out

```sql
-- LEVEL 0: raw hypertable `ticks(time, symbol, bid, ask)` (1s or sub-second ticks)

-- LEVEL 1: 1-minute OHLC, built on the RAW hypertable.
CREATE MATERIALIZED VIEW ticks_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket('1 minute', time)            AS bucket,
    symbol,
    FIRST((bid+ask)/2, time)                 AS open,
    MAX((bid+ask)/2)                         AS high,
    MIN((bid+ask)/2)                         AS low,
    LAST((bid+ask)/2, time)                  AS close,
    COUNT(*)                                 AS ticks
FROM ticks
GROUP BY bucket, symbol
WITH NO DATA;

SELECT add_continuous_aggregate_policy('ticks_1m',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- LEVEL 2: 1-hour OHLC, built on the 1-minute cagg (NOT on raw ticks).
--   open  = FIRST of the minute-opens, high = MAX of minute-highs,
--   low   = MIN of minute-lows,        close = LAST of the minute-closes.
CREATE MATERIALIZED VIEW ticks_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket('1 hour', bucket)            AS bucket,
    symbol,
    FIRST(open, bucket)                      AS open,
    MAX(high)                                AS high,
    MIN(low)                                 AS low,
    LAST(close, bucket)                      AS close,
    SUM(ticks)                               AS ticks
FROM ticks_1m
GROUP BY time_bucket('1 hour', bucket), symbol
WITH NO DATA;

SELECT add_continuous_aggregate_policy('ticks_1h',
  start_offset      => INTERVAL '1 day',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes');

-- LEVEL 3: 1-day OHLC, built on the 1-hour cagg.
CREATE MATERIALIZED VIEW ticks_1d
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
    time_bucket('1 day', bucket)             AS bucket,
    symbol,
    FIRST(open, bucket)                      AS open,
    MAX(high)                                AS high,
    MIN(low)                                 AS low,
    LAST(close, bucket)                      AS close,
    SUM(ticks)                               AS ticks
FROM ticks_1h
GROUP BY time_bucket('1 day', bucket), symbol
WITH NO DATA;

SELECT add_continuous_aggregate_policy('ticks_1d',
  start_offset      => INTERVAL '7 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');
```

The base-on-raw / level-on-level structure and the `FIRST/LAST/MAX/MIN` re-rollup of OHLC are taken from the
TimescaleDB OHLC tutorial (which builds `tick_1m_view` on raw `tick_data`, then `ohlc_1h_view` on the
minute data with `FIRST(open,time)/MAX(high)/MIN(low)/LAST(close,time)`):
[Real-Time Market Data to OHLC Candles Pipeline — TraderMade](https://tradermade.com/tutorials/6-steps-fx-stock-ticks-ohlc-timescaledb).
**Note:** that tutorial sets `materialized_only = false` on every level; on the v2.13+ default you would have
to set it explicitly anyway (§4.2) — and for internal levels weigh §7.4.

### 7.3 OHLC is *algebraically composable* — percentiles are NOT

`open/high/low/close` and `count/sum` re-roll cleanly: `MAX` of `MAX`es is a `MAX`, `FIRST` of `FIRST`s is a
`FIRST`, etc. That is **why** the hierarchy works for OHLC. But many statistics are **not** composable —
you **cannot** average pre-computed averages weighted-correctly without the counts, and you **cannot**
average percentiles at all:

> "percentile aggregates aren't algebraically composable — you cannot aggregate pre-computed percentiles
> directly." — [Stack Harbor rollups guide](https://stackharbor.com/en/knowledge-base/timescaledb-continuous-aggregates-strategy/)

For non-composable stats, store a **partial/two-step aggregate** at the base level and `rollup()` it at
higher levels using TimescaleDB Toolkit hyperfunctions, which are explicitly designed for this:

```sql
-- Base (1-hour) with a two-step percentile aggregate:
CREATE MATERIALIZED VIEW response_times_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 h'::interval, ts)         AS bucket,
    api_id,
    avg(response_time_ms),
    percentile_agg(response_time_ms)         AS percentile_hourly   -- toolkit, composable
FROM response_times
GROUP BY 1, 2
WITH NO DATA;

-- Daily, rolling up the partial percentile aggregate (NOT a raw re-percentile):
CREATE MATERIALIZED VIEW response_times_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 d'::interval, bucket)     AS bucket_daily,
    api_id,
    mean(rollup(percentile_hourly))          AS mean,
    rollup(percentile_hourly)                AS percentile_daily     -- rollup of partials
FROM response_times_hourly
GROUP BY 1, 2
WITH NO DATA;
```

Verbatim cascade from
[Hierarchical continuous aggregates — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates)
(`percentile_agg` at the hourly level, `rollup(percentile_hourly)` + `mean(rollup(...))` at the daily level).

**For OHLC specifically**, the Toolkit `candlestick_agg()` two-step aggregate is the production-grade choice:
`candlestick_agg(time, price, volume)` builds an intermediate candlestick; `rollup(candlestick)` combines
smaller-timeframe candlesticks into bigger ones; accessors `open/high/low/close/open_time/high_time/low_time/
close_time/volume/vwap` read them out. "use `rollup` to combine candlestick aggregates from 15-minute buckets
into daily buckets … without needing to reprocess all the data." Source:
[candlestick_agg() — Tiger Data Docs](https://docs.tigerdata.com/api/latest/hyperfunctions/financial-analysis/candlestick_agg/)
and [Introduce Candlestick Aggregate — timescaledb-toolkit#596](https://github.com/timescale/timescaledb-toolkit/pull/596).
`candlestick_agg` carries **vwap and volume** through the rollup, which the naive `FIRST/LAST/MAX/MIN` form
above does not — prefer it when you need VWAP or a correct volume roll-up.

### 7.4 Refresh ordering and the real-time-parent caveat

- **Refresh bottom-up.** A higher level reads the level below; if the 1h cagg hasn't been refreshed, the 1d
  cagg built on it has nothing fresh to read. With independent policies, schedule the **leaf to refresh more
  frequently** and the upper levels slightly behind. The invalidation system propagates: changes to raw data
  invalidate the 1m cagg, whose refresh invalidates the 1h, whose refresh invalidates the 1d.
- **A non-real-time level halts the live tail above it.** "When non-real-time continuous aggregates exist in
  a stack, recursive joining stops at that non-real-time continuous aggregate," limiting higher layers to
  already-materialized data below that point. Source:
  [Hierarchical continuous aggregates — Tiger Data Docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates).
  **Implication:** if you want the 1d view to reflect data up to `now()`, *every* level beneath it that you
  rely on for the live tail must be `materialized_only = false`. If the 1m level is materialized-only, the 1h
  and 1d live tails see only what the 1m policy has already materialized — fresh enough for EOD, **not**
  fresh enough for a live intraday board.

### 7.5 Why each dashboard zoom hits a right-sized rollup

A chart asking for "5 years of daily candles" should read ~1,250 rows from `ticks_1d`, **not** aggregate
billions of raw ticks. A chart asking for "the last hour, minute-by-minute" reads 60 rows from `ticks_1m`.
Route the query to the coarsest cagg whose bucket ≤ the pixel resolution of the requested window:

| Dashboard window | Read from | Rows returned (per symbol) |
|---|---|---|
| Last 1–6 hours, minute detail | `ticks_1m` (real-time) | ≤ 360 |
| 1–30 days, hourly detail | `ticks_1h` (real-time) | ≤ 720 |
| Months–years, daily detail | `ticks_1d` (materialized-only ok) | ≤ ~1,825 over 5y |
| Sub-minute, last few minutes | raw `ticks` directly | bounded by window |

Routing table adapted from the production rollup guide's "route by time window" pattern (last 24h → 1-minute
cagg; 24h–7d → 5-minute; 7d+ → 1-hour; sub-minute → raw hypertable):
[Stack Harbor rollups guide](https://stackharbor.com/en/knowledge-base/timescaledb-continuous-aggregates-strategy/).
**This is the compute-once-serve-many payoff:** every panel reads a few hundred indexed rows regardless of
how many billions of ticks underlie them. The rollup was computed once, in the background; each reader gets
the printed flyer, not a hand-derived one.

Verify a query actually hits the cagg (and not the raw table) with `EXPLAIN ANALYZE` — you want an index/seq
scan on `_materialized_hypertable_*`, not on `ticks`:

```sql
EXPLAIN ANALYZE
SELECT bucket, close FROM ticks_1h
WHERE symbol = 'AAPL' AND bucket > now() - interval '7 days';
-- expect: scan of the materialization hypertable, NOT a full aggregation over `ticks`.
```

(Pattern from the same guide.)

---

## 8. Compression and retention — *on the cagg itself*

Caggs are hypertables, so you can compress old rollup chunks (columnstore) and drop ancient rollup chunks —
**independently of the source hypertable**. This is what lets you keep `ticks_1d` for 20 years while dropping
raw `ticks` after 90 days.

### 8.1 Columnstore compression on a cagg

```sql
-- 1) Enable columnstore on the cagg. With no other options, data is segmented by the
--    GROUP BY columns and ordered by the time (bucket) column.
ALTER MATERIALIZED VIEW ticks_1d SET (timescaledb.enable_columnstore = true);

-- 2) Add the policy that converts rollup chunks to columnstore after `after`.
--    Rule: `after` MUST be greater than the refresh policy's `start_offset`,
--    so you never compress a region the refresh policy still wants to rewrite.
CALL add_columnstore_policy('ticks_1d', after => INTERVAL '45 days');
```

Verbatim from
[Compress continuous aggregates — timescale/docs (compression-on-continuous-aggregates.md)](https://github.com/timescale/docs/blob/latest/use-timescale/continuous-aggregates/compression-on-continuous-aggregates.md):
"When you enable columnstore with no other options, your data is segmented by the groupby columns in the cagg,
and ordered by the time column"; and "the `after` parameter must be greater than the value of `start_offset`
in the refresh policy." (Older/`hypercore`-era syntax used `ALTER … SET (timescaledb.compress, …)` +
`add_compression_policy(<cagg>, compress_after => …)`; the `enable_columnstore` + `add_columnstore_policy`
form is the current naming — pick the pair your installed version exposes.)

You can tune segmentation/ordering explicitly for the cagg's query pattern:

```sql
ALTER MATERIALIZED VIEW ticks_1d SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'symbol',     -- group columnstore by the column you filter on
  timescaledb.orderby   = 'bucket DESC' -- order within a segment by time
);
```

### 8.2 Retention on a cagg (drop old *rollup* chunks)

```sql
-- Keep 10 years of daily candles, then drop older rollup chunks.
SELECT add_retention_policy('ticks_1d', INTERVAL '10 years');
```

`add_retention_policy` on a cagg drops chunks of the **materialization hypertable**, not the source. This is
the mechanism behind tiered retention: drop raw `ticks` aggressively, keep `ticks_1m` for weeks, `ticks_1h`
for months, `ticks_1d` for years. The
[About continuous aggregates docs](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates)
note this "tiered" pattern ("1-second raw → 1-minute → 1-hour → 1-day, with retention policies dropping the
lower tiers as data ages").

### 8.3 One-step `add_policies()`

```sql
-- Add refresh + columnstore + retention to a cagg in a single call:
SELECT add_policies(
  'ticks_1d',
  refresh_start_offset => INTERVAL '1 month',
  refresh_end_offset   => INTERVAL '1 day',
  compress_after       => INTERVAL '45 days',
  drop_after           => INTERVAL '10 years'
);
```

"You can add refresh, compression, and data retention policies to a continuous aggregate in one step with
`add_policies()`, and the added compression and retention policies apply to the **continuous aggregate, not
to the original hypertable**." Source:
[add_policies() — Tiger Data Docs](https://www.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/add_policies).
(Exact arg names vary slightly by version — confirm with `\df add_policies` on your install.)

### 8.4 The retention interaction with real-time mode — a real trap

If a cagg is **real-time** (`materialized_only = false`) and you **drop raw source chunks** via a retention
policy on the *source hypertable*, the live-tail half of the real-time union has nothing to read for those
dropped ranges. As long as the watermark is **past** the dropped range (i.e. those buckets are already
materialized), you're fine — the materialized half serves them. But if raw retention is shorter than the
distance between the watermark and `now()`, the live tail can lose rows. **Rule:** keep raw source data at
least as long as `end_offset + schedule_interval + a safety margin`, so every range the live tail might scan
still exists in raw form. For anything older, rely on the materialized rollup (and consider flipping internal
levels to `materialized_only = true`).

---

## 9. The internals you should be able to reason about

You rarely touch these catalogs directly, but knowing they exist explains every behavior above. Names from
[Continuous Aggregates — DeepWiki (reads timescaledb source)](https://deepwiki.com/timescale/timescaledb/4-continuous-aggregates):

| Catalog object | Role |
|---|---|
| `_materialized_hypertable_<id>` | The physical rollup store (a hypertable). |
| `continuous_aggs_hypertable_invalidation_log` | **Global** log of raw-hypertable modifications, per source hypertable. |
| `continuous_aggs_materialization_invalidation_log` | **Per-cagg** log of pending refresh ranges. |
| `continuous_aggs_invalidation_threshold` | The **threshold** that dampens write amplification in the hot recent region — "Invalidations are typically written before the threshold but not after it." |
| `continuous_aggs_watermark` | The **high-water mark** of materialization; `cagg_watermark()` reads it; the real-time union splits at it. |

The flow: a write/update/delete to old raw data records an entry in the hypertable invalidation log. On
refresh, `continuous_agg_refresh()` (a) reads the invalidation logs to find dirty bucket ranges inside the
policy window, (b) aligns the window to bucket boundaries, (c) re-materializes only those ranges
(`PLAN_TYPE_MERGE` / `PLAN_TYPE_INSERT`), and (d) advances the watermark. Recent in-order inserts past the
threshold cost **no** invalidation overhead — which is exactly why time-series ingest stays cheap. Source:
[Continuous Aggregates — DeepWiki](https://deepwiki.com/timescale/timescaledb/4-continuous-aggregates) and
[About continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates)
("the first [phase] briefly blocks writes to determine time ranges and update thresholds; the second
materializes aggregates without blocking other operations").

---

## 10. Common pitfalls (mistake → why → fix)

| Pitfall | Why it happens | Fix |
|---|---|---|
| **Cagg is empty / stale after creation** | Created `WITH NO DATA` and **no refresh policy attached** — nothing ever materializes. On v2.13+ the default `materialized_only = true` also hides the live tail. | Attach `add_continuous_aggregate_policy(...)`, **or** flip to real-time (`materialized_only = false`) for the recent window, **or** run a manual `refresh_continuous_aggregate`. Check `materialized_only` + `job_stats.last_run_status`. |
| **"Last few minutes are missing" on a v2.13+ install** | Real-time disabled by default; only materialized buckets show, and `end_offset` keeps the open bucket unmaterialized. | `ALTER MATERIALIZED VIEW v SET (timescaledb.materialized_only = false);` for live surfaces. The classic version-flip bug. |
| **Open bucket shows wrong/frozen value** | Created `WITH DATA`, which materialized the incomplete open bucket and set the watermark past it; later inserts into that bucket don't appear until refresh. ([timescaledb#5379](https://github.com/timescale/timescaledb/issues/5379)) | Always `WITH NO DATA`; let `end_offset ≥ one bucket` keep the policy off the open bucket; use real-time mode for the live tail. |
| **Back-fill OOMs / locks for minutes** | One unbounded `refresh_continuous_aggregate(cagg, NULL, NULL)` over years of raw data. | Bounded slices oldest→newest (§5.2), or `buckets_per_batch`/`max_batches_per_execution` on the policy. |
| **Double-counting in a hierarchy** | Re-rolling a **non-composable** stat (averaging averages without weights, "averaging" percentiles) instead of rolling up a partial aggregate. | Store a two-step partial (`percentile_agg`, `candlestick_agg`, `stats_agg`) at the base and `rollup()` it; for OHLC use `FIRST/LAST/MAX/MIN` (composable) or `candlestick_agg`. |
| **"Double-materialization" / overlapping union** (the bug *class* people fear) | Misconception. The real-time union splits strictly at the watermark — materialized ≤ watermark, live > watermark — so it cannot overlap. The actual risk is **stale-not-double**: the policy hasn't advanced the watermark and `materialized_only = true`, so recent data is simply absent (not double-counted). | Diagnose with the staleness query (§6); ensure the policy runs (`schedule_interval` low enough, job not failing). Don't "fix" by widening windows blindly. |
| **Hierarchical create fails: "must be finalized"** | Parent cagg predates 2.7 / is non-finalized. | Migrate the parent to finalized form, then stack; verify `finalized = true` in the info view. |
| **Higher level's live tail is empty despite raw data** | An internal level is `materialized_only = true`; recursive live-tailing "stops at that non-real-time continuous aggregate." | Set `materialized_only = false` on every level you need the live tail from (§7.4). |
| **Cagg chunks are surprisingly huge / few** | Forgot the `MATPARTCOL_INTERVAL_FACTOR = 10`: the materialization chunk is 10× the source chunk for base caggs. | Expected. Override with `set_chunk_time_interval` on the materialization hypertable (§2.2) if 10× is wrong for your retention/compression granularity. |
| **Compression policy fights the refresh policy** | `add_columnstore_policy` `after` ≤ refresh `start_offset`, so the policy tries to rewrite compressed chunks. | Keep `compress_after > start_offset` (and beyond your late-arrival window). |
| **Joined dimension change doesn't reflect** | Only **hypertable** changes are tracked for invalidation; a plain-table (dimension) update is invisible to the invalidation log. | Re-materialize (`force => true`) the affected range after a dimension change, or avoid joining mutable dimensions into the cagg. |
| **Refresh "did nothing" at the edges** | Only buckets **wholly within** the window refresh; a partial bucket at `window_end` is excluded. | Align `window_start`/`window_end` to bucket boundaries; remember `'…06-01'` excludes the bucket containing `06-01`. |

---

## 11. Decision checklist for a new rollup (markets product line)

1. **What's the smallest bucket any surface displays?** That's your **base cagg** width, built on the raw
   hypertable. (Stack Harbor: "The bucket has to match the smallest resolution your dashboard ever displays.")
2. **Composable or not?** OHLC/count/sum → plain SQL aggregates. Percentile/stats/distinct-heavy/VWAP →
   Toolkit two-step (`candlestick_agg`, `percentile_agg`, `stats_agg`) + `rollup()`.
3. **Build the hierarchy** 1m→1h→1d (each multiple-of and ≥ the level below; parents finalized).
4. **Set `end_offset`** = max late-arrival window + small safety; **`schedule_interval`** = how fresh the
   materialized half must be; lower it well below the default 24h for operational surfaces.
5. **Pick the mode per level.** Live surfaces → `materialized_only = false` on every level the live tail
   traverses. EOD/reconciled surfaces → `materialized_only = true` for speed/consistency.
6. **Create `WITH NO DATA`**, attach the policy, then **bounded back-fill** oldest→newest stopping before the
   open bucket.
7. **Compress + retain on each cagg** (`add_columnstore_policy` with `after > start_offset`;
   `add_retention_policy` per tier) — keep coarse rollups for years, drop raw fast.
8. **Verify**: `EXPLAIN ANALYZE` hits `_materialized_hypertable_*`; the staleness query is within
   `end_offset + schedule_interval`; `job_stats.last_run_status = 'Success'`.

---

## Sources

Primary (authoritative — Tiger/Timescale docs & source):
- [About continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates)
- [Create a continuous aggregate](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/create-a-continuous-aggregate)
- [Refresh policies](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/refresh-policies)
- [Real-time aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/real-time-aggregates)
- [Hierarchical continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates)
- [Understand continuous aggregates (learn)](https://www.tigerdata.com/docs/learn/continuous-aggregates)
- [add_continuous_aggregate_policy() reference](https://www.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/add_continuous_aggregate_policy)
- [refresh_continuous_aggregate() reference](https://www.tigerdata.com/docs/api/latest/continuous-aggregates/refresh_continuous_aggregate)
- [add_policies() reference](https://www.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/add_policies)
- [timescaledb_information.continuous_aggregates view](https://docs.timescale.com/api/latest/informational-views/continuous_aggregates/)
- [Compress continuous aggregates (docs source .md)](https://github.com/timescale/docs/blob/latest/use-timescale/continuous-aggregates/compression-on-continuous-aggregates.md)
- [candlestick_agg() reference](https://docs.tigerdata.com/api/latest/hyperfunctions/financial-analysis/candlestick_agg/)

Source-code / internals (read at source level):
- [timescaledb/tsl/src/continuous_aggs/create.c @ main — `MATPARTCOL_INTERVAL_FACTOR 10`](https://github.com/timescale/timescaledb/blob/main/tsl/src/continuous_aggs/create.c)
- [DeepWiki: Continuous Aggregates (invalidation log, watermark, threshold)](https://deepwiki.com/timescale/timescaledb/4-continuous-aggregates)
- [DeepWiki: Creating and Configuring Continuous Aggregates](https://deepwiki.com/timescale/timescaledb/4.1-creating-and-configuring-continuous-aggregates)
- [timescaledb#5379 — WITH DATA materializes the open bucket](https://github.com/timescale/timescaledb/issues/5379)
- [timescaledb#4002 — set_chunk_time_interval on materialization hypertable](https://github.com/timescale/timescaledb/issues/4002)
- [timescaledb#6923 — request: chunk_time_interval WITH option](https://github.com/timescale/timescaledb/issues/6923)
- [timescaledb-toolkit#596 — Introduce Candlestick Aggregate](https://github.com/timescale/timescaledb-toolkit/pull/596)

Secondary (practitioner guides — cross-checked against primary; flagged where they describe the pre-2.13 default):
- [Stack Harbor — designing rollups for fast dashboards](https://stackharbor.com/en/knowledge-base/timescaledb-continuous-aggregates-strategy/)
- [DEV (philip_mcclarence) — Real-Time vs Materialized-Only](https://dev.to/philip_mcclarence_2ef9475/timescaledb-continuous-aggregates-real-time-vs-materialized-only-4k75) *(states real-time as "the default" — true only before 2.13)*
- [TraderMade — Market Data to OHLC Candles Pipeline](https://tradermade.com/tutorials/6-steps-fx-stock-ticks-ohlc-timescaledb) *(sets `materialized_only = false` explicitly on every level)*
