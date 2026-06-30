# patterns-indexing-query-performance.md

> **Skill:** `timescaledb-timeseries` — for the **JPM-Markets re-engineering data-analytics product line (NOT Lumina)**.
> **Type:** `patterns-*` — a concrete build recipe. The Tier-2 / Tier-3 scale doc for the time-series store.
> **Scope:** Indexing hypertables and writing fast queries against them — uncompressed *and* compressed
> (columnstore) chunks. How chunk exclusion actually works, which index a market-data table needs, how to
> read `EXPLAIN ANALYZE` for hypertables, and what survives 1×/100×/10,000× with the next-tier break in
> numbers.
>
> **Versions pinned this research (June 2026):** TimescaleDB **2.27.0** (released 2026-05-12) on
> PostgreSQL 14–18. Chunk-skipping indexes require **≥ 2.16.0**; configurable columnstore sparse indexes
> (`bloom(...)`, `minmax(...)`) require **≥ 2.22.0**; the `ColumnarIndexScan` custom node and write-path
> bloom pruning landed in **2.27.0**. Pin your version — the columnstore planner changes release to release.
> Sources: [Releases](https://github.com/timescale/timescaledb/releases),
> [2.22/2.23 blog](https://www.tigerdata.com/blog/timescaledb-2-22-2-23-90x-faster-distinct-queries-postgres-18-support-configurable-columnstore-indexes-uuidv7).

---

## 0. The one-paragraph mental model (read this first)

A hypertable is **one logical table split into many physical child tables called chunks**, each holding a
disjoint time range. Every fast query on a hypertable does the same two things in order: (1) **chunk
exclusion** — the planner/executor throws away whole chunks that *cannot* contain matching rows, using each
chunk's time-range `CHECK` constraint, *before* it ever reads a row; then (2) **an index scan or seq scan
inside the few surviving chunks**. Step (1) is the whole reason TimescaleDB is fast, and it only happens if
your `WHERE` clause has a **bare, sargable predicate on the partitioning (time) column**. Step (2) is
ordinary Postgres indexing, except the index you almost always need is the **composite
`(series_id, time DESC)`** — *not* the single-column time index TimescaleDB gives you for free. Get both
right and a "last 1 year of one symbol" query touches ~3 chunks and one index; get either wrong and it
seq-scans every chunk of every symbol. This doc is how to get both right, and how to *prove* it with
`EXPLAIN ANALYZE`.

For a markets dataset the partitioning column is `time` and the high-cardinality filter is the instrument
(`symbol`, `figi`, or an integer `series_id`). Everything below is written against that shape.

---

## 1. The default index, and why it is not the one you need

### 1.1 What you get for free

When you create a hypertable, TimescaleDB creates **one index automatically: a single-column index on the
time column, descending**.

> "When creating a hypertable, an index is automatically generated on the `time` column, making it faster
> to query your data based on time." — [About indexes](https://www.tigerdata.com/docs/use-timescale/latest/schema-management/about-indexing)

So after:

```sql
CREATE TABLE bars (
  time    timestamptz NOT NULL,
  symbol  text        NOT NULL,
  open    double precision,
  high    double precision,
  low     double precision,
  close   double precision,
  volume  bigint
);

SELECT create_hypertable('bars', by_range('time', INTERVAL '7 days'));
-- legacy positional form (still works, deprecated):
-- SELECT create_hypertable('bars', 'time', chunk_time_interval => INTERVAL '7 days');
```

…you have exactly one index, per chunk: `bars_time_idx` on `(time DESC)`. The default chunk interval is
**7 days** if you do not specify one. ([change-chunk-intervals](https://docs.timescale.com/use-timescale/latest/hypertables/change-chunk-intervals/):
"The default chunk interval is 7 days.")

To suppress the auto-index (you almost never want to — see §1.3): pass `create_default_indexes => FALSE`.

### 1.2 Why a single-column time index scans *all series*

Here is the failure this whole doc exists to prevent. Consider the canonical markets query:

```sql
-- "last 1 year of AAPL daily bars"
SELECT time, close
FROM bars
WHERE symbol = 'AAPL'
  AND time >= now() - INTERVAL '1 year'
ORDER BY time DESC;
```

With **only** the default `(time DESC)` index:

1. **Chunk exclusion works** on the time predicate — good. With 7-day chunks, one year ≈ **~53 chunks**
   survive; the rest of the (potentially thousands of) chunks are excluded.
2. **Inside each surviving chunk**, the only index is `(time DESC)`. It can find rows in the time range,
   but it has **no knowledge of `symbol`**. So Postgres scans *every row of every symbol* in those 53
   chunks and applies `symbol = 'AAPL'` as a post-index **Filter**. If you store 5,000 symbols, you read
   ~5,000× more rows than you return.

The index satisfies the *time* half of the predicate and pays nothing for the *symbol* half. At Tier 1 (one
symbol in the table) you never notice. At Tier 2 (5,000 symbols) this query goes from <1 ms to hundreds of
ms because the rows-read amplification is the symbol count.

### 1.3 The index you actually need: `(symbol, time DESC)`

The fix is a **composite index, equality column first, time/range column last**. This is the single most
important rule in TimescaleDB indexing and the official guidance states it directly:

> "A good rule of thumb with indexes is to think in layers. Start by choosing the columns that you typically
> want to run **equality** operators on, such as `location = garage`. Then finish by choosing columns you
> want to use **range** operators on, such as `time > 0930`." — [About indexes](https://www.tigerdata.com/docs/use-timescale/latest/schema-management/about-indexing)

```sql
CREATE INDEX bars_symbol_time_idx ON bars (symbol, time DESC);
```

Now the same query does an **index range scan**: jump to `symbol = 'AAPL'`, walk the `time DESC` leaf
entries for one year, stop. It reads ~252 rows (trading days) instead of 252 × number-of-symbols. The
column order is not cosmetic — it is *load-bearing*:

- `(symbol, time DESC)` — **correct.** Equality on the leading column positions the scan; the trailing
  `time DESC` gives an ordered range *and* satisfies `ORDER BY time DESC` with no sort node.
- `(time DESC, symbol)` — **wrong.** Leading on the range column means an equality on `symbol` cannot
  position; you get a range-then-filter, the same amplification as the default index. A b-tree can only use
  a column for equality positioning if every column to its left is itself constrained by equality.

> The official composite example is exactly this shape, with a second equality column:
> `CREATE INDEX ON devices (store_id, device_id, time DESC);` — [About indexes](https://www.tigerdata.com/docs/use-timescale/latest/schema-management/about-indexing).
> Generalize: **`(equality_cols..., time DESC)`**.

**Index per chunk, automatically, forever.** You issue one `CREATE INDEX` against the hypertable; TimescaleDB
materializes a matching index on **every existing chunk and every future chunk**. You do not (and must not)
index chunks individually.

> "For time-series data, indexing on the time column allows one index to be created per chunk, and these
> indexes are automatically applied to all chunks, including future ones." — [composite-index search synthesis, About indexes](https://www.tigerdata.com/docs/use-timescale/latest/schema-management/about-indexing)

**Always include the time column in your indexes.** Omitting it is an ingest-killer:

> "While it is possible to add an index that does not include the `time` column, doing so results in **very
> slow ingest speeds**." — [About indexes](https://www.tigerdata.com/docs/use-timescale/latest/schema-management/about-indexing)

(Why: a non-time index spans the whole time domain of a chunk, so every insert touches deep, scattered
b-tree pages; a `(…, time DESC)` index appends to the right edge where new rows live — the hot pages stay in
cache.)

**Unique / primary-key constraints must include every partitioning column.** You cannot declare
`PRIMARY KEY (symbol)` or a unique index that omits `time`:

> "To define an index as a `UNIQUE` or `PRIMARY KEY` index, it must include the partitioning column (this is
> usually the time column)." — [About indexes](https://www.tigerdata.com/docs/use-timescale/latest/schema-management/about-indexing)

For markets, the natural key is `(symbol, time)` — and it doubles as your `(symbol, time)` lookup index, so
declare it as the table's uniqueness guarantee and one-bar-per-symbol-per-timestamp dedupe in one move:

```sql
-- the natural key IS a useful composite index. (time DESC for ORDER BY pushdown.)
CREATE UNIQUE INDEX bars_symbol_time_uq ON bars (symbol, time DESC);
-- enables idempotent upsert:
INSERT INTO bars (...) VALUES (...) ON CONFLICT (symbol, time) DO UPDATE SET close = EXCLUDED.close;
```

### 1.4 Integer `series_id` vs `text` symbol — a real Tier-2/3 decision

A `text` symbol in the index leading column is fine to ~Tier 2 but has costs at Tier 3:

- **Index size & cache footprint.** `'BRK.B'` is 5+ bytes plus header; an `int` series id is 4 bytes, a
  `smallint` 2. The leading column is repeated in every index entry across billions of rows. A narrower
  leading column = more index entries per page = fewer page reads per scan.
- **Join discipline.** A normalized `instrument(series_id, symbol, figi, …)` dimension table plus
  `bars(series_id int, time, …)` gives you a clean integer key, lets you re-symbol (ticker changes,
  M&A) without rewriting fact rows, and makes the chunk-skipping index in §4 usable (it needs an integer
  type).

**Recommendation for the markets fact tables:** use `series_id int` (or `bigint`) as the in-fact instrument
key, keep the human `symbol` in a small dimension table, and build `(series_id, time DESC)`. Resolve symbol →
series_id once at the edge of the query. The worked examples below use `symbol` for readability; mentally
substitute `series_id` for the production tables.

---

## 2. Chunk exclusion — the mechanism that makes any of this fast

Indexing inside a chunk is ordinary Postgres. The TimescaleDB-specific superpower is **chunk exclusion**:
eliminating whole chunks before reading them, using the per-chunk time-range `CHECK` constraint. There are
**three** flavors and reading `EXPLAIN` correctly means knowing which one fired.

> "If a query has constraints on partitioning columns, we can use those constraints to only target chunks
> that could return results according to those constraints." — [Constraint exclusion for faster queries](https://www.tigerdata.com/blog/implementing-constraint-exclusion-for-faster-query-performance)

### 2.1 Stage 1 — plan-time exclusion (the best case)

When the time predicate is an **immutable constant** (a literal or a bound parameter), the planner prunes
chunks *during planning*. The excluded chunks never appear in the plan at all.

Query:

```sql
SELECT * FROM metrics WHERE time < '2000-01-03';
```

Plan (only the surviving chunk is present — note there is **no `ChunkAppend`**, just a plain `Append` over
the one chunk that matched):

```
Append (actual rows=2880 loops=1)
  ->  Index Scan using _hyper_1_1_chunk_metrics_time_idx on _hyper_1_1_chunk
        (actual rows=2880 loops=1)
```

> Source: [Constraint exclusion for faster queries](https://www.tigerdata.com/blog/implementing-constraint-exclusion-for-faster-query-performance).
> "Without optimization, the plan scans 5 chunks… With optimization, only 1 relevant chunk is included."

This is the gold standard: 4 of 5 chunks vanish at plan time, so they cost nothing — not even planning a
scan node. **You want your hot queries to hit this stage.**

### 2.2 Stage 2 — executor startup exclusion (`now()`, stable functions)

The moment the time predicate involves a **stable** expression — most importantly `now()` /
`CURRENT_TIMESTAMP`, or a `now() - interval` window — the planner *cannot* fold it to a constant (its value is
fixed only per-statement, not per-plan). The planner inserts TimescaleDB's custom **`ChunkAppend`** node,
which prunes chunks at **executor startup**, just before execution:

```sql
SELECT * FROM metrics WHERE time < now() - INTERVAL '19 years 5 month 28 days';
```

```
Custom Scan (ChunkAppend) on metrics (actual rows=2389 loops=1)
  Chunks excluded during startup: 4
```

> Source: [Constraint exclusion for faster queries](https://www.tigerdata.com/blog/implementing-constraint-exclusion-for-faster-query-performance).
> `ChunkAppend` "removes hypertable chunks that are not needed due to constraints during executor
> initialization."

This is **almost as good** as plan-time: the chunks are still excluded before any rows are read. The line to
look for in `EXPLAIN` is **`Chunks excluded during startup: N`**. Your `now() - INTERVAL '1 year'` market
queries land here — that is fine and expected.

### 2.3 Stage 3 — executor runtime exclusion (subqueries, `LATERAL`, nested loops)

When the time bound is only known **per outer-row at execution time** — a correlated subquery, a `LATERAL`
join, the value coming from another table — exclusion happens during execution, per loop:

```sql
SELECT * FROM metrics WHERE time = (SELECT max(time) FROM metrics);
```

```
Custom Scan (ChunkAppend) on metrics (actual rows=1 loops=1)
  Chunks excluded during runtime: 4
```

> Source: [Constraint exclusion for faster queries](https://www.tigerdata.com/blog/implementing-constraint-exclusion-for-faster-query-performance).
> Chunks proven unnecessary are marked **`(never executed)`** in the plan. Runtime exclusion was added in
> TimescaleDB 1.4.

### 2.4 The killer: no time predicate, or a function *on* the time column

Two ways to get **zero** exclusion — every chunk scanned:

**(a) No predicate on the partitioning column at all.** Without a time filter the planner has nothing to
prune with, so it builds an append over **every chunk**:

> "Without a time predicate in the WHERE clause, PostgreSQL cannot exclude any chunks, and the planner
> generates an append plan across every chunk in the hypertable… every chunk is scanned." — [chunk-exclusion search synthesis, Constraint exclusion blog](https://www.tigerdata.com/blog/implementing-constraint-exclusion-for-faster-query-performance)

**(b) Wrapping the time column in a function or arithmetic.** The chunk `CHECK` constraint is on the *raw*
column `time`. If you transform it, the constraint no longer matches the predicate and exclusion is defeated:

```sql
-- DEFEATS exclusion: every chunk is scanned, then date_trunc'd, then filtered.
SELECT * FROM bars WHERE date_trunc('day', time) = '2026-06-23';

-- DEFEATS exclusion: arithmetic on the column.
SELECT * FROM bars WHERE time + INTERVAL '1 hour' > '2026-06-23';

-- DEFEATS exclusion: cast that changes the column.
SELECT * FROM bars WHERE time::date = '2026-06-23';
```

> "Functions or operations that prevent chunk exclusion include cases like `col + 1 between :min and :max`,
> which transform the time column and make it impossible for the planner to apply constraint exclusion
> logic." — [chunk-exclusion search synthesis, Constraint exclusion blog](https://www.tigerdata.com/blog/implementing-constraint-exclusion-for-faster-query-performance)

**The fix is always the same: put the function on the literal, not the column. Filter the bare column
against a range.**

```sql
-- CORRECT: bare column, sargable range. date_trunc('day','2026-06-23') folds at plan time.
SELECT * FROM bars
WHERE time >= '2026-06-23 00:00:00+00'
  AND time <  '2026-06-24 00:00:00+00';
```

This is the single most common Tier-1-looks-fine / Tier-3-catches-fire bug: `WHERE time::date = $1` works
beautifully on a one-chunk demo and seq-scans 10,000 chunks in production.

### 2.5 The exclusion rules, as a checklist

| Want exclusion? | Do | Don't |
|---|---|---|
| Predicate target | Filter the **bare partitioning column** (`time`) | Wrap it: `date_trunc(time)`, `time::date`, `time + x`, `time AT TIME ZONE …` |
| Predicate form | A **range** with literals/params: `time >= $1 AND time < $2` | An open-ended/absent time filter |
| `now()` is fine | `WHERE time > now() - INTERVAL '1 year'` → startup exclusion (`ChunkAppend`) | — |
| Per-row bound | Correlated subquery → runtime exclusion (`ChunkAppend`, `never executed`) | — |
| Cross-chunk `ORDER BY time LIMIT k` | `ChunkAppend` streams chunks newest-first; the LIMIT short-circuits | A plain `Append` + top-N sort that must read all chunks |

---

## 3. Partitioning choices that govern exclusion quality

Chunk exclusion is only as good as your chunk geometry. Two knobs matter; one is a trap.

### 3.1 `chunk_time_interval` — the granularity of exclusion

Each chunk is a time range; exclusion is range-granular. Chunks too **big** → a 1-hour query still drags a
whole 7-day chunk into the scan (poor selectivity). Chunks too **small** → millions of chunks → planning
latency and catalog bloat.

**Official sizing rule — the working set of indexes for chunks being ingested should fit in ~25% of RAM:**

> "Best practice is to set `chunk_interval` so that prior to processing, the indexes for chunks currently
> being ingested into fit within **25% of main memory**. For example, on a system with 64 GB of memory, if
> index growth is approximately 2 GB per day, a 1-week chunk interval is appropriate. If index growth is
> around 10 GB per day, use a 1-day interval." — [change-chunk-intervals](https://docs.timescale.com/use-timescale/latest/hypertables/change-chunk-intervals/)

```sql
-- daily bars, modest volume: weekly (the default) is fine.
-- intraday minute/tick bars, thousands of symbols: go daily or sub-daily.
SELECT set_chunk_time_interval('bars', INTERVAL '1 day');
```

> "The updated chunk interval **only applies to new chunks**. This means setting an overly long interval
> might take a long time to correct." — [change-chunk-intervals](https://docs.timescale.com/use-timescale/latest/hypertables/change-chunk-intervals/)

**Markets rule of thumb:** size the interval so a *typical* chart/query window spans a small, bounded number
of chunks. Daily EOD bars → weekly chunks (a 1-year query ≈ 53 chunks). 1-minute intraday across thousands of
symbols → daily chunks. Tick data → sub-daily. The target is "each hot query touches single-digit-to-low-tens
of chunks," because every surviving chunk is a separate index scan with its own planning and buffer cost.

### 3.2 Space partitioning by symbol — **do not do this** (the trap)

It is tempting to `add_dimension('bars', by_hash('symbol', 16))` so each symbol lands in its own chunk. **For
a single-node hypertable this is an anti-pattern.** A composite `(symbol, time DESC)` **index** already gives
you per-symbol locality *inside* a chunk, with none of the downsides:

> "TimescaleDB does **not** benefit from a very large number of space partitions, and a very large number of
> partitions leads to poorer per-partition load balancing and much increased planning latency for some types
> of queries." — [add_dimension / partitioning guidance synthesis](https://www.tigerdata.com/docs/api/latest/hypertable/add_dimension)

> "For regular hypertables on a single node, additional partitioning is used for specialized use cases and
> **not recommended for most users**… Best practice is to not use additional dimensions." — [add_dimension guidance](https://www.tigerdata.com/docs/api/latest/hypertable/add_dimension)

Concrete failure mode reported in the field: 10 hash buckets on a secondary id caused a continuous-aggregate
refresh to read all 10 hash-bucket chunks simultaneously and OOM. ([Issue #515 / partitioning issue thread](https://github.com/timescale/timescaledb/issues/515)).

**Rule:** partition by **time only**; get per-symbol selectivity from the **composite index** (uncompressed)
and from **segmentby** (compressed, §5). Reach for space partitioning only on multi-node/distributed setups.

---

## 4. Chunk-skipping indexes — exclusion on a *secondary correlated* column

`(symbol, time DESC)` handles the symbol filter *inside* surviving chunks, but it does **not** exclude
chunks by symbol — a symbol filter alone (no time predicate) still scans every chunk. For a **secondary
column that correlates with time**, TimescaleDB ≥ 2.16 offers **chunk-skipping indexes**: per-chunk min/max
range metadata that lets the planner prune chunks on that column.

### 4.1 What problem they solve

> "Traditional PostgreSQL partitioning optimizes queries filtering by the partitioning column (typically
> time), but fails when queries reference other columns… many scenarios involve queries using secondary
> columns in `WHERE` clauses, not the partitioning column(s)." — [Boost Postgres performance by 7x with chunk-skipping indexes](https://www.tigerdata.com/blog/boost-postgres-performance-by-7x-with-chunk-skipping-indexes)

The mechanism: when a chunk is compressed, TimescaleDB records the **min and max** of the tracked column in
the `chunk_column_stats` catalog (start-inclusive, end-exclusive). At query time, the planner skips any chunk
whose `[min, max)` cannot contain the searched value. **This only helps when the column is correlated with
time** — e.g. a monotonic `order_id`, an `ingest_seq`, a `trade_id`, an event `created_at` distinct from the
partition time. A *random* column (like a hash, or `symbol` itself) has overlapping `[min,max]` in every
chunk and prunes nothing.

> "When secondary columns correlate with the partition key — like a job's end time following its creation
> time — chunk-skipping indexes leverage this correlation to prune irrelevant chunks." — [chunk-skipping blog](https://www.tigerdata.com/blog/boost-postgres-performance-by-7x-with-chunk-skipping-indexes)

### 4.2 The reference, exactly

```sql
SELECT enable_chunk_skipping(
    hypertable   => '<hypertable>',
    column_name  => '<column>',
    if_not_exists => true   -- optional, default false
);
```

> Arguments — `hypertable REGCLASS` (required), `column_name NAME` (required, "Column to track range
> statistics for"), `if_not_exists BOOLEAN` (default `false`). Returns `column_stats_id INTEGER` and
> `enabled BOOLEAN`. — [enable_chunk_skipping reference](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/enable_chunk_skipping)

**Supported column types (integer-ish and date/time only — NOT `text`/`float`):**

> "TimescaleDB supports min/max range tracking for the `smallint`, `int`, `bigint`, `serial`, `bigserial`,
> `date`, `timestamp`, and `timestamptz` data types." — [enable_chunk_skipping reference](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/enable_chunk_skipping)

**Requirements / gotchas:**

- Works on **compressed** hypertables; "The min/max ranges are calculated when a chunk… is added to the
  columnstore." — [reference](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/enable_chunk_skipping)
- **Applies only to chunks created/compressed *after* you enable it.** Existing chunks need recompression to
  get stats. — [reference](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/enable_chunk_skipping)
- Stored in `chunk_column_stats`, start-inclusive / end-exclusive.
- Because it is an **integer/temporal** feature, this is another reason to use an integer `series_id` /
  `ingest_seq`: a `text` symbol cannot be a chunk-skipping column.

### 4.3 The worked benchmark (verbatim)

```sql
CREATE TABLE orders (
   order_id     serial,
   time         timestamptz,
   customer_id  int,
   order_total  float
);
SELECT create_hypertable('orders', 'time', chunk_time_interval => '1 day'::interval);

SELECT enable_chunk_skipping('orders', 'order_id');
ALTER TABLE orders SET (timescaledb.compress);
SELECT compress_chunk(show_chunks('orders'));

-- the query: a point lookup on the correlated secondary column, NO time predicate
SELECT * FROM orders WHERE order_id = 3942785;
```

- **Before:** "Scanning 365 chunks in total", **2176.563 ms**.
- **After:** **5.064 ms**, with the plan showing the pruning filter
  `(_ts_meta_v2_min_order_id <= 3942785) AND (_ts_meta_v2_max_order_id >= 3942785)`.
- Headline: **"7x better performance while using 87% less storage, thanks to compression."**

> Source: [Boost Postgres performance by 7x with chunk-skipping indexes](https://www.tigerdata.com/blog/boost-postgres-performance-by-7x-with-chunk-skipping-indexes).

### 4.4 When to reach for it in markets data

| Column | Correlated with time? | Chunk-skipping? |
|---|---|---|
| `series_id` / `symbol` | No (every chunk has all symbols) | **No** — use composite index + (compressed) segmentby |
| `ingest_seq` / `trade_id` (monotonic bigint) | Yes | **Yes** — point/range lookups by id without a time filter |
| `corporate_action_id`, `fill_id` (monotonic) | Yes | Yes |
| `price`, `volume` | No (random within chunk) | No — use a compressed `minmax(...)` sparse index instead (§5.4) |

**Decision rule:** chunk-skipping is for *monotonic, time-correlated integer/temporal keys you query without a
time bound*. For everything else (the symbol filter, value-range filters) use the composite index and the
columnstore sparse indexes below.

---

## 5. Reading compressed chunks (the columnstore)

At scale you compress older chunks (10–20× storage reduction is typical, and the chunk-skipping blog cites
**87% less storage**). Compression changes *how queries execute*, and indexing rules change with it. The key
fact: **most of your row-store indexes are ignored on compressed chunks** — pruning is driven by `segmentby`,
`orderby` metadata, and the sparse columnstore indexes instead.

> "**Most indexes set on the hypertable are removed/ignored when reading from compressed chunks!** TimescaleDB
> creates and uses custom indexes to incorporate the `segmentby` and `orderby` parameters during
> compression." — [About compression / compression.md](https://github.com/timescale/docs.timescale.com-content/blob/master/using-timescaledb/compression.md)

### 5.1 The physical layout (why this matters)

Compression turns many rows into **one row holding arrays**, in batches of up to **1000 rows**:

```
-- uncompressed (4 rows)
time     | device_id | cpu   | ...
12:00:02 | 1         | 88.2  | ...
12:00:01 | 2         | 300.5 | ...
12:00:01 | 1         | 88.6  | ...
12:00:01 | 2         | 299.1 | ...

-- compressed (1 row, columns become arrays)
time                                   | device_id | cpu                  | ...
[12:00:02,12:00:02,12:00:01,12:00:01]  | [1,2,1,2] | [88.2,300.5,88.6,...]| ...
```

> Source: [About compression / compression.md](https://github.com/timescale/docs.timescale.com-content/blob/master/using-timescaledb/compression.md).

### 5.2 `segmentby` — the symbol-level prune for compressed data

`segmentby` forces each compressed row to hold a **single value** for the segment column, and builds a
**b-tree over each segmentby column**. A `WHERE symbol = …` then locates only the matching segments and
decompresses **after** filtering:

```
-- segmentby = device_id : each compressed row is one device
time                  | device_id | cpu          | ...
[12:00:02,12:00:01]   | 1         | [88.2,88.6]  | ...
[12:00:02,12:00:01]   | 2         | [300.5,299.1]| ...
```

> "Queries with WHERE clauses that filter by a `segmentby` column are much more efficient, as decompression
> can happen **after** filtering instead of before." The system "builds b-tree indexes over each `segmentby`
> column." — [About compression / compression.md](https://github.com/timescale/docs.timescale.com-content/blob/master/using-timescaledb/compression.md)

**For markets, `segmentby = 'series_id'` (or `symbol`) is the columnstore equivalent of the
`(symbol, time DESC)` index** — it is what makes "one symbol over a long window" fast on compressed chunks.

```sql
ALTER TABLE bars SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'series_id',   -- prune by instrument
  timescaledb.compress_orderby    = 'time DESC'    -- min/max time metadata + ordered output
);
```

> The improve-query-performance doc demonstrates exactly this with a ~16× speedup (29.216 ms → 1.828 ms) on a
> `device_id`-segmented, `time`-ordered metrics table for a `WHERE time BETWEEN … AND device_id = 5` query. —
> [Improve query performance](https://www.tigerdata.com/docs/use-timescale/latest/hypertables/improve-query-performance)

**Cardinality caution:** `segmentby` builds one b-tree entry per distinct value and each segment is a
separate compressed row, so **very high-cardinality segmentby hurts compression** (tiny batches) and bloats
metadata. Thousands of symbols is usually fine; millions of distinct ids is not. If your instrument universe
is huge, segment by a coarser key (exchange, asset-class) and rely on `orderby`/sparse indexes within.

### 5.3 `orderby` — the time-range prune for compressed data (min/max metadata)

For every `orderby` column, TimescaleDB **automatically stores min and max metadata** per compressed batch
so the executor can skip whole batches against a range predicate **without decompressing**:

> "The system automatically creates additional columns to store the minimum and maximum value of any
> `orderby` column, allowing the query executor to look at this metadata column… without performing
> decompression to determine whether the row could match a time predicate. For each `orderby` column at
> position N, two metadata columns are created: `_ts_meta_min_N` and `_ts_meta_max_N`." — [compression
> min/max synthesis, compression.md](https://github.com/timescale/docs.timescale.com-content/blob/master/using-timescaledb/compression.md)

So `orderby = 'time DESC'` gives compressed chunks a built-in batch-level time skip — your `time >= …` filter
prunes batches the same way chunk exclusion prunes chunks, one level finer. It also lets the executor return
rows in compressed order and **skip a SORT** when the query's `ORDER BY` matches.

### 5.4 Configurable sparse indexes (≥ 2.22): `minmax(...)` and `bloom(...)`

`segmentby` (equality prune) and `orderby` (range prune) cover the obvious columns. For *other* columns you
filter on inside compressed chunks, TimescaleDB **2.22+** lets you declare **sparse indexes** explicitly:

- **`minmax(col)`** — per-batch min/max; prunes **range** queries on `col`.
- **`bloom(col)`** — a bloom filter; prunes **equality** lookups on high-cardinality `col`.

```sql
-- declare at create time
CREATE TABLE metrics (
    time   timestamptz NOT NULL,
    device text,
    value  float
)
WITH (
    tsdb.hypertable,
    tsdb.index = 'bloom(value), minmax(value)'
);

-- or adjust later
ALTER TABLE metrics SET (
    timescaledb.compress_index = 'bloom(device), minmax(value)'
);

-- inspect
SELECT * FROM timescaledb_information.hypertable_columnstore_settings;
SELECT * FROM timescaledb_information.chunk_columnstore_settings;
```

> "you can now explicitly define which columns should use Bloom or Min/Max indexes to finely tune query
> performance… up to **8.7× faster range queries and 20× faster multi-region queries**." — [TimescaleDB 2.22 & 2.23](https://www.tigerdata.com/blog/timescaledb-2-22-2-23-90x-faster-distinct-queries-postgres-18-support-configurable-columnstore-indexes-uuidv7)

In **2.27**, the `ColumnarIndexScan` node fetches values directly from these sparse minmax indexes (cited up
to 70× on the columnstore), and bloom pruning extends to the **write path** so `UPDATE`/`DELETE`/`UPSERT` skip
non-matching batches too. ([Release 2.27.0](https://github.com/timescale/timescaledb/releases/tag/2.27.0)).

**Markets mapping:**

| Filter | Compressed-chunk mechanism |
|---|---|
| `series_id = …` (one instrument) | `segmentby = 'series_id'` (b-tree over segment) |
| `time >= … AND time < …` | `orderby = 'time DESC'` min/max metadata |
| `close BETWEEN … AND …`, `volume > …` | `minmax(close)`, `minmax(volume)` sparse index |
| `exchange = 'XNAS'` (if not segmentby) | `bloom(exchange)` sparse index |

### 5.5 Multi-column SkipScan (≥ 2.22): fast `DISTINCT ON` over instruments

A markets staple — "latest bar per symbol" / "distinct instruments traded" — is a multi-column `DISTINCT ON`.
2.22's SkipScan does this in milliseconds over billions of rows:

```sql
SELECT DISTINCT ON (site_id, unit_type, unit_id)
  site_id, unit_type, unit_id, metric_value
FROM metrics
WHERE time BETWEEN '2024-01-01' AND '2024-01-31'
ORDER BY site_id, unit_type, unit_id, time DESC;   -- 904 ms -> 10 ms (90x)
```

> Source: [TimescaleDB 2.22 & 2.23](https://www.tigerdata.com/blog/timescaledb-2-22-2-23-90x-faster-distinct-queries-postgres-18-support-configurable-columnstore-indexes-uuidv7).
> Requires a matching multi-column index (e.g. `(series_id, time DESC)`) and the segmentby/orderby to line up.

---

## 6. Partial and covering indexes (uncompressed chunks)

### 6.1 Partial indexes — index only the rows queries touch

A partial index has a `WHERE` clause; it indexes a subset of rows, so it is smaller, fits in cache, and is
cheaper to maintain. Useful when a *small, hot* subset dominates reads:

```sql
-- only index rows that are flagged/anomalous, if those dominate alerting queries
CREATE INDEX bars_flagged_idx ON bars (series_id, time DESC)
WHERE quality_flag IS NOT NULL;

-- only index the active/listed instruments if you keep delisted history around
CREATE INDEX bars_active_idx ON bars (series_id, time DESC)
WHERE is_active;
```

The predicate is applied per chunk like any other index; the planner uses the partial index only when the
query's `WHERE` implies the index predicate. **Caveat:** a partial index is repeated per chunk; if the hot
subset is most rows it saves little — measure.

### 6.2 Covering indexes — `INCLUDE` to get an index-only scan

If a query reads only a few columns, add them as **non-key `INCLUDE` payload** so the scan never touches the
heap (an *index-only scan*):

```sql
-- "last close prices for AAPL" reads only (series_id, time, close)
CREATE INDEX bars_symbol_time_close_idx
ON bars (series_id, time DESC) INCLUDE (close);
```

Now `SELECT time, close FROM bars WHERE series_id = $1 AND time >= $2 ORDER BY time DESC` can be served
entirely from the index. **Caveat:** `INCLUDE` columns widen the index (more storage, slower writes), and on
hypertables they are repeated per chunk. Add payload only for genuinely hot, narrow projections; for wide
`SELECT *` it does nothing. (Index-only scans on uncompressed chunks also need the chunk's visibility map to
be reasonably set by autovacuum.)

### 6.3 `CREATE INDEX` on big hypertables — don't lock the world

Building an index on a hypertable creates it on every chunk. Two safety levers:

- **`CREATE INDEX … WITH (timescaledb.transaction_per_chunk)`** — commit per chunk so you do not hold one
  giant transaction across thousands of chunks (lighter locking, resumable feel).
- **`CREATE INDEX CONCURRENTLY`** — avoids the `ACCESS EXCLUSIVE` write lock at the cost of a slower build.
  Combine with `transaction_per_chunk` where supported by your version. Validate against your pinned 2.27
  behavior.

---

## 7. Reading `EXPLAIN ANALYZE` on a hypertable — the field guide

Run `EXPLAIN (ANALYZE, BUFFERS) <query>;`. Read it bottom-up. The hypertable-specific signals:

| You see… | It means… | Good/Bad |
|---|---|---|
| `Append` over **one/few** `_hyper_*_chunk` nodes | **Plan-time exclusion** worked (§2.1) | ✅ best |
| `Custom Scan (ChunkAppend)` + `Chunks excluded during startup: N` | Startup exclusion (`now()` window) (§2.2) | ✅ good |
| `Chunks excluded during runtime: N` and `(never executed)` chunks | Runtime exclusion (subquery/LATERAL) (§2.3) | ✅ ok |
| `Append`/`ChunkAppend` over **every** chunk, no "excluded" line | **No exclusion** — missing/ wrapped time predicate (§2.4) | 🔴 fix |
| `Index Scan using …_series_id_time_idx` inside chunks | Composite index used; symbol positioned | ✅ |
| `Index Scan using …_time_idx` + a `Filter: (symbol = …)` with high `Rows Removed by Filter` | Default time-only index; **scanning all symbols** (§1.2) | 🔴 add composite |
| `Seq Scan` on a chunk with a big `Rows Removed by Filter` | No usable index for the predicate | 🔴 |
| `_ts_meta_v2_min_… <= x AND _ts_meta_v2_max_… >= x` filter | **Chunk-skipping** prune firing (§4) | ✅ |
| `Custom Scan (DecompressChunk)` / `ColumnarIndexScan` | Reading compressed chunks; check segmentby/orderby prune | inspect |
| A `Sort` node above a `time DESC` scan | Your index order doesn't match `ORDER BY` — add `time DESC` to the index | 🟡 |

**The two numbers that tell the truth:** (1) **how many chunk nodes appear / how many were excluded**, and
(2) **`Rows Removed by Filter`** inside the chosen scan. A query is healthy when few chunks survive *and* the
in-chunk scan removes near-zero rows by filter. High "rows removed by filter" = your index isn't covering the
predicate → you're paying the symbol-amplification tax. Use `BUFFERS` to see actual page reads — the ground
truth behind the timings.

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT time, close FROM bars
WHERE series_id = 42 AND time >= now() - INTERVAL '1 year'
ORDER BY time DESC;
```

---

## 8. The two worked queries (the spec's canonical pair)

### 8.1 "Last 1 year of one symbol" — narrow-and-deep

```sql
SELECT time, open, high, low, close, volume
FROM bars
WHERE series_id = 42
  AND time >= now() - INTERVAL '1 year'
ORDER BY time DESC;
```

**What should happen:**
- Time predicate `time >= now() - INTERVAL '1 year'` → **`ChunkAppend`, startup exclusion** (§2.2). With
  7-day chunks, ~53 chunks survive out of however many thousand exist.
- Inside each surviving chunk → `Index Scan using bars_series_id_time_idx` (§1.3): positioned at
  `series_id = 42`, range-walk `time DESC`. `Rows Removed by Filter` ≈ 0.
- `ORDER BY time DESC` is satisfied by the index order across chunks (`ChunkAppend` streams newest chunk
  first) → **no Sort node**.
- Compressed older chunks → `segmentby = 'series_id'` locates the segment, `orderby = 'time DESC'` min/max
  skips out-of-range batches (§5).
- **Net:** reads ~252 rows; touches ~53 chunks; a handful of index pages each. Sub-millisecond to low-ms even
  at Tier 3.

**The anti-pattern that breaks it:** drop the composite index and you scan every symbol's rows in those 53
chunks (§1.2). Wrap the column — `WHERE time::date >= …` — and you scan **every chunk** (§2.4).

### 8.2 "All symbols, last 1 hour" — wide-and-shallow

```sql
SELECT series_id, time, close
FROM bars
WHERE time >= now() - INTERVAL '1 hour'
ORDER BY series_id, time DESC;
```

**What should happen:**
- Time predicate → **startup exclusion**: with daily intraday chunks, **1 chunk** survives (the current
  day); with hourly chunks, ~1–2. This is the dominant win — one hour of data is one (or a few) chunks no
  matter how many years of history exist.
- Inside the surviving chunk(s), there is **no symbol filter** — you *want* all symbols — so the planner
  reads the chunk via the `(series_id, time DESC)` index (ordered, no sort) or a seq scan of just that
  chunk. Either is fine: the chunk is small (one hour) and you're returning most of it.
- `ORDER BY series_id, time DESC` is served by the composite index order → no Sort.
- **Net:** touches ~1 chunk; reads ~(#symbols × bars-per-hour) rows, which is exactly the result size — no
  amplification. Fast because **exclusion shrank the universe to one chunk**, not because of a per-symbol
  index.

**The contrast that teaches the rule:** query 8.1 is fast because of the **composite index** (symbol
selectivity inside many surviving chunks). Query 8.2 is fast because of **chunk exclusion** (almost no chunks
survive, so you read everything in the one that does). Different mechanisms; both depend on a **bare,
range-based time predicate**. Remove the time predicate from 8.2 ("all symbols, all history") and there is no
mechanism left — it is an unavoidable full scan, and the right answer is a **continuous aggregate** or a
pre-computed rollup, not an index.

---

## 9. R-SCALE tier statement (numbers, and the next-tier break)

> Convention from `~/.claude/rules/product-scale-architecture.md` and the repo `product-at-scale.md`: state
> the tier each design survives and what breaks at the next, in numbers.

Assume a `bars` hypertable, time-partitioned, with `(series_id, time DESC)` composite + the natural-key
unique index, compression on older chunks with `segmentby = 'series_id'`, `orderby = 'time DESC'`.

| Tier | Shape | Survives because | What breaks at the **next** tier |
|---|---|---|---|
| **1× (demo)** | 1–50 symbols, 1–5y daily bars ≈ 10⁴–10⁵ rows, a few dozen chunks, 1 analyst | Everything is in cache; even a seq scan is instant; the default time index "works" | A `WHERE time::date = $1` or symbol-only filter that "worked" now seq-scans every chunk; the missing composite index becomes a per-query symbol-count amplifier the moment symbols grow |
| **100× (traction)** | 5k–10k symbols, intraday minute bars, ~10⁸–10⁹ rows, thousands of chunks, thousands of users | Chunk exclusion drops a 1y query to ~53 chunks; `(series_id, time DESC)` removes symbol amplification; compression keeps hot chunks in RAM; `getOrRefresh`-style caching of the home/screener fan-out | (a) Wrong `chunk_time_interval` → either too-big chunks (a 1h query drags a 7d chunk) or **catalog/planner blow-up** from millions of tiny chunks; (b) value/secondary-id filters with **no time bound** scan all chunks → need chunk-skipping (id) or `minmax`/`bloom` sparse indexes (value); (c) ingest slows if you added a non-time index |
| **10,000× (the product)** | full instrument universe + tick data, ~10¹⁰⁺ rows, lakhs of concurrent reads, spike day | Compression (10–20×, ~87% storage cut) keeps the working set in RAM; segmentby+orderby+sparse minmax/bloom prune compressed batches; `ColumnarIndexScan` (2.27) serves columnstore range/equality from sparse indexes; SkipScan answers "latest per symbol" in ms; read fan-out is **compute-once-serve-many** (cron-warmed rollups + Redis SWR), never recomputed per request | Single-node Postgres write/IO ceiling; the answer is **continuous aggregates** (pre-roll 1m→1h→1d so dashboards never touch raw ticks), tiering cold chunks to cheaper storage, read replicas for the read spike, and moving heavy/scheduled rollups off the request path into a worker/cron (repo non-negotiable #4). At this tier you do **not** "browse the list" — you hit aggregates, faceted lookups, and time-bounded slices. |

**The failure this prevents (per the rule):** a Tier-1 schema — default time index only, `WHERE
time::date = $1`, no compression, 7-day chunks for minute data — *feels* production-correct on demo data and
silently degrades to full scans the instant real instrument breadth and history arrive. The break is invisible
until load, then it's an incident. The mechanisms above (composite index, bare-column range predicate, sized
chunks, compression + segmentby/orderby, chunk-skipping, sparse indexes, continuous aggregates) are exactly
the named, enforced scaling levers — not "it'll be fine."

---

## 10. Build checklist (copy into the PR description)

- [ ] Partition by **time only**. No space/hash dimension on `symbol` (§3.2).
- [ ] `chunk_time_interval` sized so a typical query spans single-digit-to-low-tens of chunks and ingesting
      chunks' indexes fit ~25% RAM (§3.1).
- [ ] **Composite index `(series_id, time DESC)`** — equality col first, time last (§1.3). Verify it's used
      via `EXPLAIN`, not the default time-only index.
- [ ] **Unique/natural key `(series_id, time)`** for idempotent upsert; never a key omitting `time` (§1.3).
- [ ] Every index **includes `time`** (non-time indexes kill ingest) (§1.3).
- [ ] All hot `WHERE` clauses filter the **bare** `time` column with a **range** (literal/param), never a
      function/cast on the column (§2.4).
- [ ] Compression on older chunks: `segmentby = 'series_id'`, `orderby = 'time DESC'` (§5.2–5.3).
- [ ] Sparse indexes for compressed value/secondary filters: `minmax(close)`, `bloom(exchange)` (§5.4).
- [ ] **Chunk-skipping** (`enable_chunk_skipping`) only on monotonic **integer/temporal** secondary keys
      queried *without* a time bound (`ingest_seq`, `trade_id`) (§4) — remember it only covers chunks created
      *after* enabling.
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` checked: few chunks survive, `Rows Removed by Filter` ≈ 0, no stray
      `Sort` (§7).
- [ ] R-SCALE tier statement written: which tier this survives, what breaks next, in numbers (§9).
- [ ] Heavy rollups / continuous-aggregate refreshes run off the request path (worker/cron), not in a
      serverless route.

---

## References (every load-bearing claim is cited inline above)

- Improve hypertable & query performance — segmentby/orderby, the 16× example: <https://www.tigerdata.com/docs/use-timescale/latest/hypertables/improve-query-performance>
- About indexes — default time index, composite `(store_id, device_id, time DESC)`, equality-then-range rule, no-time-column ingest penalty, unique-must-include-partition-col: <https://www.tigerdata.com/docs/use-timescale/latest/schema-management/about-indexing>
- Boost Postgres performance by 7× with chunk-skipping indexes — full `orders` walkthrough, 2176 ms → 5.064 ms, `chunk_column_stats`, correlation caveat: <https://www.tigerdata.com/blog/boost-postgres-performance-by-7x-with-chunk-skipping-indexes>
- `enable_chunk_skipping()` reference — signature, supported types, compression requirement, post-enable-only behavior: <https://www.tigerdata.com/docs/reference/timescaledb/hypertables/enable_chunk_skipping>
- Implementing constraint exclusion for faster query performance — the 3 stages, `ChunkAppend`, exact EXPLAIN output (`Chunks excluded during startup/runtime`, `never executed`), what defeats plan-time exclusion: <https://www.tigerdata.com/blog/implementing-constraint-exclusion-for-faster-query-performance>
- About compression / compression.md — compressed row layout, segmentby b-trees + decompress-after-filter, orderby min/max metadata, 1000-row batch, "most indexes ignored on compressed chunks": <https://github.com/timescale/docs.timescale.com-content/blob/master/using-timescaledb/compression.md>
- Change chunk intervals — default 7 days, 25%-of-RAM sizing rule, `set_chunk_time_interval` applies to new chunks only: <https://docs.timescale.com/use-timescale/latest/hypertables/change-chunk-intervals/>
- `add_dimension()` — space-partitioning anti-pattern on single node, "do not use additional dimensions": <https://www.tigerdata.com/docs/api/latest/hypertable/add_dimension>
- TimescaleDB 2.22 & 2.23 — configurable `bloom(...)`/`minmax(...)` sparse columnstore indexes, multi-column SkipScan (90× DISTINCT), 8.7×/20× range/multi-region: <https://www.tigerdata.com/blog/timescaledb-2-22-2-23-90x-faster-distinct-queries-postgres-18-support-configurable-columnstore-indexes-uuidv7>
- Release 2.27.0 (2026-05-12) — `ColumnarIndexScan` (up to 70× columnstore), write-path bloom pruning; version pin: <https://github.com/timescale/timescaledb/releases/tag/2.27.0>
- Releases index (version currency, June 2026): <https://github.com/timescale/timescaledb/releases>
