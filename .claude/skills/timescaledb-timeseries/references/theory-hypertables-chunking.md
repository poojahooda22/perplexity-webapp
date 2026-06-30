# theory-hypertables-chunking — the foundational mental model

> **Skill:** `timescaledb-timeseries` (JPM-Markets re-engineering **data-analytics product line**, NOT Lumina).
> **Type:** `theory-*` — generic, reusable. The mental model + sizing math you carry into every
> hypertable design decision. The concrete "create this exact table for OHLCV ticks" recipe lives in the
> `patterns-*` references; this doc is the *why* underneath them.
>
> **Read this first, before any other reference in this skill.** Everything else — compression
> (columnstore), continuous aggregates, retention, ingest tuning — is built on top of the chunk. If the
> chunk model is wrong, every layer above it is fighting an uphill battle.

---

## 0. The one-paragraph mental model (read this even if you read nothing else)

A **hypertable** is a single logical PostgreSQL table that TimescaleDB *automatically* splits, behind
the scenes, into many physical child tables called **chunks**, partitioned by a time column (and,
optionally, a second "space" column). You `INSERT`, `SELECT`, `UPDATE`, `JOIN`, and index a hypertable
exactly as if it were one ordinary table — TimescaleDB transparently routes each row to the right chunk
on write, and on read it uses the time predicate in your `WHERE` clause to **skip** (exclude) every chunk
that can't contain matching rows. The single design knob that matters most is **`chunk_time_interval`**:
the span of time each chunk covers (default **7 days**). Get it right — roughly *one chunk plus its
indexes fits in ~25% of RAM* — and ingest stays fast, queries scan only the chunks they need, and old
data drops in milliseconds. Get it wrong — too small → thousands of tiny chunks and slow query
*planning*; too large → a chunk's working set spills out of memory and you're back to a giant
unpartitioned table — and the whole system degrades.

That's the entire game. The rest of this document earns those sentences.

---

## 1. What a hypertable IS (and is not)

### 1.1 The abstraction

From the official conceptual docs, a hypertable is described as a PostgreSQL table that **"automatically
partition[s] your time-series data by time and optionally by other dimensions."** When you query it,
TimescaleDB **"identifies the correct partition, called chunk, and runs the query on it, instead of going
through the entire table."** Critically, **"there is no added complexity, you interact with hypertables
in the same way as you would with regular PostgreSQL tables"** — the optimization happens transparently.
(Source: [Hypertables: conceptual overview, Tiger Data
docs](https://www.tigerdata.com/docs/use-timescale/latest/hypertables/about-hypertables).)

Two things follow immediately, and both matter for the JPM-Markets analytics product:

1. **It is a real Postgres table, not a separate datastore.** A hypertable lives inside your normal
   Postgres database, speaks SQL, supports `JOIN`s to your reference/dimension tables (instruments,
   issuers, calendars), foreign keys, transactions, and `psql`/JDBC/`asyncpg`/SQLAlchemy. You do **not**
   bolt on a second system (InfluxDB, ClickHouse, kdb+) and reconcile it with Postgres. This is the
   entire reason TimescaleDB exists for a finance-data backend: time-series scale **without** giving up
   relational joins and ACID.
2. **The partitioning is automatic and continuous.** You never pre-create next month's partition; you
   never run a nightly "make tomorrow's partition" job. As rows arrive with new timestamps, TimescaleDB
   creates the chunk that covers that timestamp on the fly. (Contrast native declarative partitioning,
   §8.)

### 1.2 What a chunk physically IS

A chunk is not a logical fiction — it is a genuine child Postgres table. From a developer who dug into
the internals: TimescaleDB **"does not store your data in a single table. It automatically partitions
incoming rows across many physical tables called chunks"** — these are **"real PostgreSQL tables in the
`_timescaledb_internal` schema, with real indexes, real CHECK constraints, and real performance
implications."** Each chunk covers a specific time interval; with a 1-day interval, every day gets its
own table with an auto-generated constraint like:

```sql
CHECK (recorded_at >= '2026-02-01' AND recorded_at < '2026-02-02')
```

(Source: ["How TimescaleDB Chunks Actually Work (And Why Size
Matters)"](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5).)

You can see them. After creating a hypertable and inserting data, the chunks are physical relations:

```text
_timescaledb_internal._hyper_1_1_chunk
_timescaledb_internal._hyper_1_2_chunk
_timescaledb_internal._hyper_1_3_chunk
...
```

The naming is `_hyper_<hypertableId>_<chunkId>_chunk`, in schema `_timescaledb_internal` by default.
(The schema and prefix are configurable — see `associated_schema_name` / `associated_table_prefix` in
§3.3, but you almost never change them.)

**Why "real CHECK constraints" is the load-bearing phrase.** That per-chunk `CHECK` on the time column
is what makes *chunk exclusion* (constraint exclusion) work — see §6. It is also why the time column
**must be `NOT NULL`**: a NULL timestamp can't be routed to a chunk and can't satisfy a range `CHECK`.
The official function adds the constraint automatically if the column is missing it. (Source: ["How to
Create Hypertables in TimescaleDB", oneuptime](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view)
— *"The time column must be NOT NULL."*)

### 1.3 The dimensions: time, and optionally space

Every hypertable has at least one **dimension**: the time (range) dimension. It can have a second
**space** (hash) dimension. Mentally:

- **Time / range dimension** → chunks are **range-partitioned**: chunk N holds `[t0, t0+interval)`,
  chunk N+1 holds `[t0+interval, t0+2·interval)`, and so on. This is the spine of every hypertable.
- **Space / hash dimension** → *within* each time slice, rows are further split into `number_partitions`
  buckets by a hash of a chosen column (e.g. `symbol`, `tenant_id`). So you get a **grid**:
  `(time-slice) × (hash-bucket)` chunks. (See §7 for when this helps and — far more often — when it
  hurts.)

A hypertable with only a time dimension produces a simple **1-D sequence** of chunks along time. A
hypertable with time + space produces a **2-D grid**. Default and correct for ~95% of cases, including
nearly all of our market-data hypertables: **time only.**

---

## 2. Creating a hypertable — the modern API (v2.13+) and the legacy API

There are two ways to make a hypertable. You will see both in the wild; know both, prefer the modern one
for new code.

### 2.1 Modern path A — `CREATE TABLE ... WITH (tsdb.hypertable)` (declarative, newest)

The newest docs make the hypertable at `CREATE TABLE` time via storage options, so the table is born as
a hypertable in one statement (no second `SELECT create_hypertable(...)` call). Verbatim example from the
official API page:

```sql
CREATE TABLE conditions (
  time        TIMESTAMPTZ       NOT NULL,
  location    TEXT              NOT NULL,
  device      TEXT              NOT NULL,
  temperature DOUBLE PRECISION  NULL,
  humidity    DOUBLE PRECISION  NULL
) WITH (
  tsdb.hypertable,
  tsdb.segmentby = 'device',
  tsdb.orderby = 'time DESC'
);
```

(Source: [`create_hypertable()`, Tiger Data API
docs](https://www.tigerdata.com/docs/api/latest/hypertable/create_hypertable). `tsdb.segmentby` /
`tsdb.orderby` are **columnstore/compression** hints — covered in the compression reference, not here.)

> **Note for our stack:** the `WITH (tsdb.hypertable)` form is the most recent. Most existing tutorials,
> ORMs (`dbt-timescaledb`), migration tools, and Stack Overflow answers still use the function call
> `create_hypertable(...)`. Both produce the same chunked hypertable. For migrations driven by Alembic /
> raw SQL in a Python/FastAPI backend, the function call (§2.2) is the most portable and best-documented;
> use it unless you have a reason not to.

### 2.2 Modern path B — `create_hypertable()` generalized API (v2.13+)

Introduced in TimescaleDB **v2.13**, this is the current function form. Signature and arguments
(verbatim from the API reference):

```sql
SELECT create_hypertable(
    relation                => '<table_name>',         -- REGCLASS, required
    dimension               => by_range('<column>'),   -- DIMENSION_INFO, required
    create_default_indexes  => true,                   -- BOOLEAN, default TRUE
    if_not_exists           => false,                  -- BOOLEAN, default FALSE
    migrate_data            => false                   -- BOOLEAN, default FALSE
);
```

| Argument | Type | Default | Required | Meaning |
|---|---|---|---|---|
| `relation` | `REGCLASS` | — | ✔ | The existing table to convert into a hypertable. |
| `dimension` | `DIMENSION_INFO` | — | ✔ | Built with `by_range(...)` (time/range) or `by_hash(...)` (space). |
| `create_default_indexes` | `BOOLEAN` | `TRUE` | ✖ | Create default indexes on the time/partitioning columns. |
| `if_not_exists` | `BOOLEAN` | `FALSE` | ✖ | `TRUE` → warn instead of erroring if `relation` is already a hypertable. |
| `migrate_data` | `BOOLEAN` | `FALSE` | ✖ | `TRUE` → move existing rows in `relation` into chunks (can lock the table — see §9). |

Returns: `hypertable_id INTEGER`, `created BOOLEAN` (`FALSE` when `if_not_exists=TRUE` and it already
existed). (Source: [`create_hypertable()` reference, Tiger
Data](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable).)

#### The dimension builders: `by_range` and `by_hash`

The generalized API moved the partitioning detail out of positional args into composable **dimension
builder** functions. You pass exactly one to `create_hypertable`, and add more with `add_dimension`.

```sql
-- TIME / RANGE dimension (the spine — every hypertable has one)
by_range(
    column_name        => 'time',                 -- NAME, required
    partition_interval => INTERVAL '1 day',        -- the chunk_time_interval; default 7 days if omitted
    partition_func     => NULL                     -- optional: function to derive a partitionable value
)

-- SPACE / HASH dimension (optional second dimension)
by_hash(
    column_name        => 'symbol',                -- NAME, required
    number_partitions  => 4,                        -- INTEGER, required, > 0
    partition_func     => NULL                      -- optional custom hash function
)
```

(Source: [`create_hypertable()` reference, Tiger
Data](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable); the
`by_range`/`by_hash` builders and `dimension_info` type were introduced with the generalized API in
v2.13.)

Worked example — a daily-bar hypertable, time-only, 1-month chunks:

```sql
CREATE TABLE bars_1d (
    time   TIMESTAMPTZ NOT NULL,
    symbol TEXT        NOT NULL,
    open   DOUBLE PRECISION,
    high   DOUBLE PRECISION,
    low    DOUBLE PRECISION,
    close  DOUBLE PRECISION,
    volume BIGINT
);

SELECT create_hypertable(
    'bars_1d',
    by_range('time', INTERVAL '1 month')
);
```

### 2.3 Legacy / old API — `create_hypertable()` pre-2.13 (still everywhere)

The pre-2.13 positional/named form is **deprecated as of 2.13.0** but is still the form most online
material uses, still works, and is the one most Python tutorials show. Full signature, every argument,
type, and default (verbatim from the old-interface reference):

```sql
SELECT create_hypertable(
    relation,                -- REGCLASS,  required
    time_column_name,        -- NAME,      required — the time column AND primary partition column
    partitioning_column,     -- NAME,      optional — extra (space) column; requires number_partitions
    number_partitions,       -- INTEGER,   optional — hash partitions for partitioning_column; must be > 0
    chunk_time_interval,     -- INTERVAL,  default 7 days — event time each chunk covers; must be > 0
    create_default_indexes,  -- BOOLEAN,   default TRUE
    if_not_exists,           -- BOOLEAN,   default FALSE
    partitioning_func,       -- REGCLASS,  optional — function to compute a value's space partition
    associated_schema_name,  -- NAME,      default '_timescaledb_internal'
    associated_table_prefix, -- TEXT,      default '_hyper'
    migrate_data,            -- BOOLEAN,   default FALSE
    time_partitioning_func,  -- REGCLASS,  optional — convert incompatible time values to compatible ones
    replication_factor,      -- INTEGER,   optional — distributed hypertables only (multi-node)
    data_nodes               -- ARRAY,     optional — distributed hypertables only (multi-node)
);
```

| Argument | Type | Default | Description |
|---|---|---|---|
| `relation` | `REGCLASS` | — | Table to convert to a hypertable. |
| `time_column_name` | `NAME` | — | Column holding the time values; the **primary** column to partition by. |
| `partitioning_column` | `NAME` | — | Optional additional (space) column. If set, `number_partitions` is required. |
| `number_partitions` | `INTEGER` | — | Number of hash partitions for `partitioning_column`. Must be `> 0`. |
| `chunk_time_interval` | `INTERVAL` | **`7 days`** | Event time each chunk covers. Must be `> 0`. |
| `create_default_indexes` | `BOOLEAN` | `true` | Whether to create default indexes on the time/partitioning columns. |
| `if_not_exists` | `BOOLEAN` | `false` | Warn instead of raising if already a hypertable. |
| `partitioning_func` | `REGCLASS` | — | Function used to compute a value's space partition. |
| `associated_schema_name` | `NAME` | `_timescaledb_internal` | Schema that holds the internal chunk tables. |
| `associated_table_prefix` | `TEXT` | `_hyper` | Prefix for internal chunk table names. |
| `migrate_data` | `BOOLEAN` | `false` | Move existing rows into chunks on creation (can lock — §9). |
| `time_partitioning_func` | `REGCLASS` | — | Convert an incompatible time-column type into a partitionable value. |
| `replication_factor` | `INTEGER` | — | Distributed (multi-node) hypertables only. |
| `data_nodes` | `ARRAY` | — | Distributed (multi-node) hypertables only. |

(Source: [`create_hypertable()` old interface, Tiger
Data](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable_old). The
multi-node `replication_factor`/`data_nodes` args belong to the now-deprecated distributed-hypertable
feature — ignore them; we run single-node.)

Legacy worked example — the form you'll see in 90% of tutorials:

```sql
SELECT create_hypertable(
    'sensor_data',
    'time',
    chunk_time_interval => INTERVAL '1 day'
);
```

(Source: [oneuptime, "How to Create Hypertables in
TimescaleDB"](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view).)

> **Decision rule for our codebase.** New migrations → **generalized API** (`by_range`/`by_hash`) on the
> current installed version. Reading old code / SO answers / `dbt-timescaledb` → recognize the **legacy**
> positional form. They are semantically equivalent; only the call shape differs. Pin the installed
> TimescaleDB version in your migration's comment so the next engineer knows which API was current
> (latest at time of writing is **2.26.0**, 2026-03-24 — source:
> [timescaledb 2.26.0 release](https://github.com/timescale/timescaledb/releases/tag/2.26.0)).

---

## 3. The single most important knob: `chunk_time_interval`

### 3.1 What it is and its default

`chunk_time_interval` is **"the event time that each chunk covers"** and **"must be > 0"**, with a
default of **`7 days`**. (Source: [`create_hypertable()` old interface
reference](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable_old) — the
parameter table lists `chunk_time_interval … INTERVAL … 7 days … Must be > 0`.)

Crucially, the interval is defined by **event time, not wall-clock arrival time.** A row whose
`time = '2024-01-03 09:30:00'` lands in the chunk covering January's relevant 7-day window **regardless
of when it was inserted.** This is why back-filling years of historical OHLCV "just works": each row
flows to the chunk its own timestamp belongs to, and TimescaleDB creates any missing chunks on demand.

It can be specified two ways:

```sql
-- as a real INTERVAL (for TIMESTAMP / TIMESTAMPTZ / DATE time columns):
SELECT set_chunk_time_interval('conditions', INTERVAL '24 hours');

-- as a raw integer of MICROSECONDS (also valid for timestamp columns):
SELECT set_chunk_time_interval('conditions', 86400000000);   -- 86,400,000,000 µs = 24 h
```

(Both forms verbatim from [`set_chunk_time_interval()`
reference](https://www.tigerdata.com/docs/api/latest/hypertable/set_chunk_time_interval).)

> **Integer time columns.** If your time column is a `BIGINT`/`INTEGER` (e.g. a Unix-epoch nanosecond
> count from a market-data feed, common in HFT-style schemas) rather than a `TIMESTAMPTZ`, then
> `chunk_time_interval` is a **plain integer in the same units as the column** — *not* an `INTERVAL`.
> For nanosecond epochs, a 1-day interval is `86400 * 1e9 = 86_400_000_000_000`. Getting the units wrong
> here is a classic Tier-1 bug that silently makes every chunk the wrong size.

### 3.2 `set_chunk_time_interval` — affects only NEW chunks

```sql
SELECT set_chunk_time_interval(
    hypertable          => 'conditions',    -- REGCLASS, required
    chunk_time_interval => INTERVAL '24 hours', -- required
    dimension_name      => NULL             -- NAME, optional; only with multiple time dimensions
);
-- returns void
```

The **non-negotiable behavior to internalize** (verbatim):

> **"The new interval is used when new chunks are created, and time intervals on existing chunks are not
> changed."**

(Source: [`set_chunk_time_interval()`
reference](https://www.tigerdata.com/docs/api/latest/hypertable/set_chunk_time_interval).)

Consequences that bite people:

- Calling `set_chunk_time_interval` **does not retroactively re-chunk** your historical data. Yesterday's
  7-day chunks stay 7-day chunks; only chunks created *after* the call use the new interval.
- To change the size of *existing* data you must physically rewrite it — there is no in-place `ALTER`.
  Options: (a) accept the mixed sizes (usually fine — chunk size is per-chunk metadata), or (b) create a
  new hypertable with the right interval and copy data in (e.g. `INSERT INTO new SELECT * FROM old`),
  optionally chunk-by-chunk to bound lock time.
- Therefore: **set the interval at creation time** from your ingest-rate estimate (§4). Use
  `set_chunk_time_interval` to *correct course going forward* once you've measured real chunk sizes, not
  as a primary design tool. The right loop is: estimate → create → ingest representative data → measure
  with `chunks_detailed_size()` → adjust the interval for future chunks. (Source:
  [testing-your-chunk-size blog](https://www.tigerdata.com/blog/timescale-cloud-tips-testing-your-chunk-size)
  — *"Apply this before materializing data… to ensure proper retention behavior."*)

### 3.3 The two name-prefix knobs you'll never touch

`associated_schema_name` (default `_timescaledb_internal`) and `associated_table_prefix` (default
`_hyper`) only change *where* and *what* the internal chunk tables are named. There is essentially no
operational reason to override them on our product. Mentioned only so you recognize them in the legacy
signature and don't mistake them for sizing knobs.

---

## 4. Sizing the chunk: the memory working-set rule (the core of this doc)

This is the section that separates a Tier-1 demo from a system that survives real load. Read it twice.

### 4.1 The rule, stated

> **Set `chunk_time_interval` so that one chunk's *recent working set* — the most-actively-written /
> -queried chunk(s) plus their indexes — fits in roughly 25% of the machine's RAM.**

Sources converge on this exact number:

- *"The recommended best practice is to set `chunk_time_interval` so that 25% of main memory can store one
  chunk, including its indexes."* — synthesized from the official guidance and TimescaleDB memory-tuning
  writeups ([DEV: chunk-sizing & memory
  tuning](https://dev.to/philip_mcclarence_2ef9475/timescaledb-memory-tuning-sharedbuffers-workmem-and-chunk-sizing-3fem);
  [myDBA.dev mirror](https://mydba.dev/blog/timescaledb-memory-tuning)).
- *"Active chunks from all hypertables should reside in approximately 25% of your PostgreSQL memory
  allocation."* — ([testing-your-chunk-size
  blog](https://www.tigerdata.com/blog/timescale-cloud-tips-testing-your-chunk-size); in its 16 GB
  example that's ~4 GB of active chunks total).

### 4.2 *Why* 25%, and why "including indexes" is the load-bearing clause

The reason is mechanical, not folklore. **Postgres builds the chunk's index on the fly during
ingestion.** If the index for the chunk currently being written does **not** fit in memory
(`shared_buffers` / OS page cache), Postgres is forced to constantly flush index pages to disk and read
them back — random I/O on every insert — which **"wastes IO resources."** (Source: [chunk-sizing memory
tuning](https://dev.to/philip_mcclarence_2ef9475/timescaledb-memory-tuning-sharedbuffers-workmem-and-chunk-sizing-3fem).)

So the working set you must fit is **chunk *data* + chunk *indexes*** of the chunk(s) you're actively
writing to and querying — not the whole hypertable. The whole hypertable is allowed to be terabytes;
only the *hot edge* needs to fit in cache. That is the entire trick of time-series partitioning: you keep
a small, bounded, recent slice hot, and let everything older sit cold on disk (or compressed — see the
compression reference), where it's almost never touched because queries are overwhelmingly recent.

### 4.3 The formula with multiple hypertables

You rarely have one hypertable. The product will have `bars_1m`, `bars_1d`, `ticks`, `quotes`, plus
continuous aggregates. The refined rule (verbatim):

> **Each chunk should be smaller than `shared_buffers / (N × 2)`**, where **N is the number of actively
> queried hypertables.**

(Source: [chunk-sizing memory
tuning](https://dev.to/philip_mcclarence_2ef9475/timescaledb-memory-tuning-sharedbuffers-workmem-and-chunk-sizing-3fem).)

The `× 2` accounts for data **and** index pages competing for the same buffer pool, and the `/ N` shares
the budget across all hypertables whose hot chunks must be resident simultaneously. So if you have 4
actively-queried hypertables and `shared_buffers = 16 GB`, target each chunk < `16 / (4 × 2) = 2 GB`.

### 4.4 The complementary row-count anchor: ~25 million rows/chunk

The memory rule is the *first-principles* target; in practice TimescaleDB also publishes a row-count
rule of thumb that's easier to reason about from an ingest rate:

> **Target roughly 25 million rows per chunk.**

(Sources: [chunk-sizing best practice
synthesis](https://dev.to/philip_mcclarence_2ef9475/timescaledb-memory-tuning-sharedbuffers-workmem-and-chunk-sizing-3fem);
["How TimescaleDB Chunks Actually
Work"](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5)
— *"The recommended target is approximately 25 million rows per chunk."*)

From which the closed-form interval is:

```text
chunk_interval_seconds = 25_000_000 / rows_per_second
```

Worked from that source:

- **100 rows/second** → `25_000_000 / 100 = 250_000 s ≈ 2.9 days` → round to a **3-day** (or, more
  conveniently, **2-day** or **7-day**) interval.
- **1,000 rows/second** → `25_000_000 / 1_000 = 25_000 s ≈ 6.9 hours` → a **~7-hour** (round to **6-hour**
  or **12-hour**) interval gives ~25M-row chunks.

(Both verbatim from ["How TimescaleDB Chunks Actually
Work"](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5).)

> **Reconcile the two rules:** memory (4.1) is the hard ceiling; 25M rows (4.4) is a convenient default
> that *usually* lands inside the memory ceiling for typical narrow time-series rows (~tens of bytes).
> For **wide** rows (many columns, large `text`/`jsonb` payloads), 25M rows can blow past the memory
> budget — in that case the **memory rule wins** and you use a smaller interval. Always validate by
> measuring (§5), never by assuming.

### 4.5 An index-growth-rate worked example (the "by how much does my index grow per day" lens)

A second, very practical sizing lens used by the docs is index growth per unit time:

> On a system with **64 GB** of memory, if **index growth is ~2 GB/day**, a **1-week** chunk interval is
> appropriate. If **index growth is ~10 GB/day**, use a **1-day** interval.

(Source: [chunk-sizing memory
tuning](https://dev.to/philip_mcclarence_2ef9475/timescaledb-memory-tuning-sharedbuffers-workmem-and-chunk-sizing-3fem).)

Sanity check the math against the 25% rule: 64 GB × 25% = 16 GB working-set budget. At 2 GB index/day, a
7-day chunk has ~14 GB of index — just under 16 GB. ✔. At 10 GB index/day, a 7-day chunk would be ~70 GB
of index — 4× over budget — so you drop to a 1-day chunk (~10 GB), comfortably under 16 GB. ✔ The
arithmetic confirms the recommendation rather than restating it.

### 4.6 What goes wrong at each extreme (keep this table on a sticky note)

| | **Chunks too LARGE** (interval too long) | **Chunks too SMALL** (interval too short) |
|---|---|---|
| **Root cause** | One chunk + its index exceeds RAM working set | Thousands of tiny chunks accumulate |
| **Symptom** | *"more data in the partition than the PostgreSQL cache available to manage it, similar to having one large regular PostgreSQL table"* — i.e. you've **lost** the benefit of partitioning; ingest does random index I/O | *"you may overwhelm the query planner or create extra overhead in other management areas"* — **planning time** balloons (§6) |
| **Where it bites** | Write path (ingest slows) + recent-data queries (cache misses) | Read path **planning** (even queries that touch few chunks) + catalog/autovacuum overhead |
| **Fix** | Smaller interval going forward (`set_chunk_time_interval` to a shorter value) | Larger interval going forward + retention to cap total chunk count |

(Source for both quoted consequences: [testing-your-chunk-size
blog](https://www.tigerdata.com/blog/timescale-cloud-tips-testing-your-chunk-size) — *"Chunks too large:
… similar to having one large regular PostgreSQL table"* / *"Chunks too small: you may overwhelm the
query planner or create extra overhead."*)

### 4.7 Ingest-volume cheat-sheet (a starting point, then MEASURE)

A widely-used rule-of-thumb table by raw daily volume — treat as a *starting interval*, then validate
against the memory rule by measuring real chunk size (§5):

| Data volume | Recommended `chunk_time_interval` | Why |
|---|---|---|
| `< 10K` rows/day | 1 week – 1 month | Fewer chunks, simpler management |
| `10K – 1M` rows/day | 1 day | Balance chunk count vs size |
| `1M – 100M` rows/day | 1 hour – 6 hours | Smaller chunks for faster ops |
| `> 100M` rows/day | 15 min – 1 hour | Very granular for high-volume |

Guiding principle from the same source: **"aim for chunks between 25–100 GB each"** *(this is a generous
upper band for large analytical deployments; for memory-bound OLTP-style ingest the 25%-of-RAM rule in §4.1
is the tighter, governing constraint — when they conflict, the memory rule wins)*. (Source: [oneuptime,
"How to Design TimescaleDB
Hypertables"](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view).)

---

## 5. How to MEASURE chunk size (close the loop — never assume)

Sizing is empirical. The official workflow (verbatim, condensed):

> "Determine how many rows you track per hour or day… If possible, **import representative data with the
> default 7-day setting and measure chunk sizes.** Adjust upward (14 or 30 days) if chunks consume only a
> fraction of available memory. Adjust downward (1 day) if chunks would consume significant memory."

(Source: [testing-your-chunk-size
blog](https://www.tigerdata.com/blog/timescale-cloud-tips-testing-your-chunk-size).)

The measurement tool is `chunks_detailed_size()` (and the hypertable-level `hypertable_detailed_size`):

```sql
-- per-chunk: table bytes, index bytes, toast bytes, total — THIS is what you size against
SELECT * FROM chunks_detailed_size('bars_1m');

-- the catalog view, with compression status, ranges, etc.
SELECT chunk_schema, chunk_name, range_start, range_end, is_compressed
FROM   timescaledb_information.chunks
WHERE  hypertable_name = 'bars_1m'
ORDER  BY range_start DESC;
```

(`chunks_detailed_size` cited in [testing-your-chunk-size
blog](https://www.tigerdata.com/blog/timescale-cloud-tips-testing-your-chunk-size); the
`timescaledb_information.chunks` view + columns verbatim from [oneuptime
design-guide](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view).)

**The loop:** import a representative slice → run `chunks_detailed_size` → compare the **index bytes** (and
total) against your `RAM × 25% / (N×2)` budget → `set_chunk_time_interval` to the corrected value → repeat
on the next batch. You are tuning the *index* footprint primarily, because that's what gets thrashed (§4.2).

### 5.1 The official worked example (memorize the shape)

> Dataset: **16 GB** server memory; **100 devices** recording every **5 minutes** (= **28,800 rows/day per
> device**); the default 7-day chunk measured at **~1 GB**. Recommendation: start at **14 days** — "more
> rows of data per device in each chunk" while staying memory-efficient (1 GB/7-day → ~2 GB/14-day, well
> under the 4 GB / 25%-of-16GB budget).

(Source: [testing-your-chunk-size
blog](https://www.tigerdata.com/blog/timescale-cloud-tips-testing-your-chunk-size).)

This is the entire method in miniature: **default → measure → the measured size is comfortably under
budget → enlarge the interval to reduce chunk count** (which improves planning time, §6) without breaching
the memory ceiling.

---

## 6. The planning-time tax of too many chunks (the most important scale failure)

This is the failure mode that most surprises engineers, because it's invisible on demo data and only
appears once chunk count climbs. **It is a planning-time cost, separate from execution time.**

### 6.1 The mechanism: chunk exclusion happens at PLAN time

When you query a hypertable with a **time predicate**, Postgres evaluates each chunk's `CHECK` constraint
during planning and **excludes** chunks that can't match — *before* execution. `EXPLAIN ANALYZE` shows
this as e.g. `Chunks excluded during startup: 347`. **But** — and this is the catch — *"the planner still
evaluates every chunk's constraint during the planning phase, creating costs that scale linearly with
total chunk count."* Excluded chunks were still *examined* to decide they should be excluded. (Source:
["How TimescaleDB Chunks Actually
Work"](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5).)

### 6.2 The measured cost (real production numbers)

| Chunk count (interval) | **Planning time** | **Execution time** |
|---|---|---|
| 4,322 chunks (1-hour interval) | **443 ms** | 2 ms |
| 26 chunks (7-day interval) | **~5 ms** | 2 ms |

> *"The execution time is identical because the same rows are scanned. But with 4,322 chunks, the planner
> spends 443 ms just evaluating constraints and building the query plan."*

(Source: ["How TimescaleDB Chunks Actually
Work"](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5).)

This is the whole argument for not over-shrinking chunks: a 1-hour interval on a low-ingest table buys you
*nothing* at execution (same rows scanned) but a **~90× planning penalty** versus a 7-day interval on the
identical data. The chunks were tiny and pointless; the planner paid for every one.

### 6.3 The root cause inside TimescaleDB (so you understand the fix, not just the symptom)

Historically, planning was slow because `expand_inherited_tables` **"expands all chunks of a hypertable
without regard to constraints present in the query, and then `get_relation_info` is called on all chunks
before constraint exclusion. Getting statistics on many chunks ends up being expensive because
`RelationGetNumberOfBlocks` has to open the file for each relation."** TimescaleDB's fix moved chunk
exclusion to **before** chunks are opened and statistics fetched — *"this optimization dramatically
decreased planning times from 600 ms to 36 ms, around a 15× improvement"* on a 4000-chunk hypertable.
(Sources: [Optimizing queries on TimescaleDB hypertables with thousands of partitions, Matvey Arye /
Timescale](https://medium.com/timescale/optimizing-queries-timescaledb-hypertables-with-partitions-postgresql-6366873a995d);
[timescaledb#2897 high planning time w/ many chunks +
LIMIT](https://github.com/timescale/timescaledb/issues/2897).)

The point for *us*: even with that optimization, planning cost still **scales with the number of chunks
the query can't immediately exclude**, so the number-one defense is **don't manufacture chunks you don't
need** (right-size the interval) **and cap total chunk count with retention** (§ below).

### 6.4 The three operational rules that fall out of §6

1. **Always include a time predicate** in queries against a hypertable. *"Without a time predicate in your
   `WHERE` clause, PostgreSQL cannot exclude any chunks"* — every chunk is scanned, defeating the entire
   point. In practice: `WHERE time >= now() - interval '7 days'` (or a literal range), **not** a query
   that filters only on `symbol`. (Source: ["How TimescaleDB Chunks Actually
   Work"](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5).)
2. **Treat planning time > ~50 ms as a red flag** that you have too many chunks. *"Planning time over 50
   ms signals too many chunks… Flag planning times over 50 ms as problematic."* Use `EXPLAIN (ANALYZE)`
   and read the `Planning Time:` line, not just `Execution Time:`. (Source: same article + [search
   synthesis](https://github.com/timescale/timescaledb/issues/2897).)
3. **Cap chunk count with a retention policy.** *"Without retention, even a well-configured interval
   produces an ever-growing chunk count."* `add_retention_policy()` drops old chunks; *"dropping a chunk
   is an instant metadata operation. PostgreSQL removes the underlying table file rather than deleting
   rows individually."* (Retention/`drop_chunks` is detailed in §10 + its own pattern reference.)

---

## 7. Space (hash) partitioning: when it helps and (usually) when it HURTS

This is the most-misused feature in the API. Default answer for a single-node finance-data product:
**do not use it.** Here's the precise reasoning.

### 7.1 What it does

`by_hash('symbol', 4)` (or legacy `partitioning_column => 'symbol', number_partitions => 4`) adds a second
dimension: within each time slice, rows are hashed into N buckets, turning the 1-D chunk sequence into a 2-D
**grid** (`time-slice × hash-bucket`). The advertised win is **I/O parallelization** — spreading concurrent
chunks across multiple physical disks/nodes so reads/writes can happen in parallel. (Source: [oneuptime
design-guide](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view) — *"useful for
multi-tenant applications where queries often filter by tenant"*; *"Space partitioning helps when you have
high cardinality dimensions (tenant_id, sensor_id)."*)

### 7.2 The official "use sparingly" guidance — and the RAID alternative

The authoritative best-practices text is blunt: for **single-node** hypertables, additional (space)
partitioning is for **specialized use cases and *not recommended for most users*.** And the recommended
single-node alternative is RAID, not space partitions:

> *"For regular hypertables that exist only on a single node, additional partitioning… is not recommended
> for most users."* … *"A more transparent way to increase I/O performance is to use a **RAID setup across
> multiple physical disks**, and expose a single logical disk to the hypertable. With a RAID setup, **no
> spatial partitioning is required on a single node.**"*

When you *do* use space partitions, tie the count to hardware: *"use 1 space partition per disk"*, and the
benefit is real only when *"(a) two or more concurrent queries… read from different disks in parallel, or
(b) a single query… uses query parallelization to read from multiple disks in parallel."*

(Sources: [TimescaleDB hypertable best-practices
docs](https://docs-dev.timescale.com/docs-tutorial-aws-lambda/timescaledb/tutorial-aws-lambda/how-to-guides/hypertables/best-practices/);
[guidance on partitioning/parallelism, timescaledb#31](https://github.com/timescale/timescaledb/issues/31);
[guidelines around N space partitions, timescaledb#1401](https://github.com/timescale/timescaledb/issues/1401).)

### 7.3 Why it HURTS when misused

- **It multiplies chunk count by N**, directly inflating the planning-time tax of §6. A 2-D grid with
  `number_partitions = 16` has 16× the chunks of a time-only hypertable over the same period — 16× the
  per-chunk constraints for the planner to evaluate.
- On a **single logical disk** (the typical cloud-VM / managed-Postgres case — one EBS/PD volume), there's
  no parallel-disk win to capture, so you pay the chunk-multiplication cost for **zero** I/O benefit.
- It does **not** help "queries filter by symbol" the way people assume — a normal **B-tree index on
  `symbol`** inside each chunk handles that, without multiplying chunk count. Space partitioning is about
  *physical I/O spread across devices*, not logical filtering.

### 7.4 Verdict for the JPM-Markets analytics product

| Situation | Use space partitioning? |
|---|---|
| Single-node Postgres / single (or RAID) logical disk (our default) | **No.** Time dimension only. Index `symbol` with a B-tree. |
| Genuinely multiple independent physical disks, and you can map 1 space-partition → 1 disk | Maybe — `number_partitions = (#disks)`, and *measure* the parallelism win against the chunk-count cost. |
| "We filter by `symbol`/`tenant` a lot" | **No** — that's a job for a per-chunk index, not a space dimension. |
| Distributed/multi-node (deprecated feature, not our deployment) | N/A — we run single-node. |

> **One-line rule:** reach for space partitioning *only* to spread I/O across real, separate disks; reach
> for a **RAID array + an index** in every other case. On our stack the answer is almost always
> *time-only.*

---

## 8. Under the hood: the relationship to native PostgreSQL partitioning

Worth understanding so you know *what TimescaleDB is doing for you* and *why you don't hand-roll it*.

- **TimescaleDB chunks are built on PostgreSQL's older inheritance-based partitioning**, *not* the modern
  declarative partitioning introduced in PostgreSQL 10. Inheritance is *"harder to implement manually but
  also more flexible, giving more granular control over the partitions."* (Source: [pg_partman vs.
  Hypertables, Tiger Data](https://www.tigerdata.com/learn/pg_partman-vs-hypertables-for-postgres-partitioning).)
- **The decisive difference is automation.** TimescaleDB *"creates partitions through inheritance but does
  it automatically as data comes in, with no need to pre-create partitions"* (chunks). Native declarative
  partitioning *"still requires manual intervention"* to create new partitions — *unless* you add a tool
  like `pg_partman`. With TimescaleDB you never pre-create the next time window; the chunk is created on
  first insert into its range. (Source: same.)
- **Tuple routing & shallow tree.** TimescaleDB implements its own efficient tuple routing (deciding which
  chunk a row belongs to) and keeps a *"shallow inheritance tree,"* which *"avoids issues of processing
  many tables and allows easy repartitioning."* Native PG-10 declarative partitioning historically *"doesn't
  scale well with a large number of sub-tables."* This is precisely *why* you let TimescaleDB manage chunks
  rather than building your own range-partitioned table set with `pg_partman` for a high-cardinality,
  high-chunk-count time-series workload. (Sources: [Problems with PostgreSQL 10 for time-series data, Erik
  Nordström / Timescale](https://medium.com/timescale/time-series-data-postgresql-10-vs-timescaledb-816ee808bac5);
  [pg_partman vs. Hypertables](https://www.tigerdata.com/learn/pg_partman-vs-hypertables-for-postgres-partitioning).)

**Practical takeaway:** a hypertable *is* a Postgres-partitioned table with (a) automatic on-demand chunk
creation, (b) automatic tuple routing, (c) a planner that does fast chunk exclusion, and (d) a stack of
time-series features (compression, continuous aggregates, retention, hyperfunctions) built on the chunk
boundary. You get all that without writing a single partition-management cron. That is the value you'd be
throwing away by reaching for raw declarative partitioning + `pg_partman` for our use case.

---

## 9. Migrating an existing table into a hypertable (`migrate_data`)

You will frequently have a plain table already holding data (a back-fill, a `COPY` from CSV/Parquet, a
table created by an ORM migration before you remembered to make it a hypertable). To convert it:

```sql
-- generalized API
SELECT create_hypertable(
    'existing_metrics_table',
    by_range('time', INTERVAL '1 day'),
    migrate_data => true
);

-- legacy API (equivalent)
SELECT create_hypertable(
    'existing_metrics_table',
    'time',
    chunk_time_interval => INTERVAL '1 day',
    migrate_data => true
);
```

(Source: [oneuptime design-guide migration
example](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view).)

**The cost you must respect** (verbatim from the API): setting `migrate_data => true` *"migrate[s] any
existing data in `relation` in to chunks in the new hypertable. Depending on the amount of data to be
migrated, setting `migrate_data` can **lock the table for a significant amount of time**."* (Source:
[`create_hypertable()` reference, `migrate_data`
arg](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable).)

So:

- **`migrate_data` is fine for small/empty tables.** By default (`migrate_data => false`) the source table
  **must be empty**, or the call errors — that default exists precisely to stop you from accidentally
  taking a long lock.
- **For large back-fills, do NOT rely on a single `migrate_data => true` call.** The standard pattern,
  recommended by the design guide for large tables — *"For large tables, batch migrate to avoid locks"* —
  is:
  1. `CREATE TABLE bars_new (LIKE bars_old INCLUDING ALL);`
  2. `SELECT create_hypertable('bars_new', by_range('time', INTERVAL '1 day'));` (empty → instant, no lock)
  3. Copy in **time-bounded batches** so each transaction is short:
     `INSERT INTO bars_new SELECT * FROM bars_old WHERE time >= $start AND time < $end;` looped over
     windows.
  4. Swap names in a final short transaction.
  This keeps the table available throughout instead of holding one giant lock.

(Source for the batch-migrate guidance: [oneuptime
design-guide](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view) — *"For large
tables, batch migrate to avoid locks."*)

> **R-SCALE note for the heavy back-fill.** The bulk historical ingest of years of market data is exactly
> the kind of "heavy ingest" that must run **off the request path** — a worker/cron job, batched, idempotent
> (re-runnable without double-inserting), with partial-failure resumability — not a one-shot
> `migrate_data => true` inside an API handler. State the runtime and the resume semantics in the build plan.

---

## 10. Inspecting & dropping chunks: `show_chunks` / `drop_chunks`

These are the two operational verbs you'll use constantly (and what retention policies call under the
hood).

### 10.1 `show_chunks`

```sql
SELECT show_chunks(
    relation       => 'conditions',     -- REGCLASS, required: hypertable or continuous aggregate
    older_than     => INTERVAL '3 months', -- ANY, optional: chunks older than this cut-off
    newer_than     => NULL,             -- ANY, optional: chunks newer than this cut-off
    created_before => NULL,             -- ANY, optional: chunks created before this timestamp
    created_after  => NULL              -- ANY, optional: chunks created after this timestamp
);
```

Returns one row per matching chunk (the internal chunk relation name). The `older_than`/`newer_than`
filters operate on the chunk's **time range**; `created_before`/`created_after` operate on when the chunk
was **physically created** — these differ when you back-fill old data today. (Source: [`show_chunks()`
reference](https://www.tigerdata.com/docs/api/latest/hypertable/show_chunks).)

Common uses:

```sql
-- everything, newest first
SELECT show_chunks('bars_1m');

-- chunks holding data older than a quarter (retention candidates)
SELECT show_chunks('bars_1m', older_than => INTERVAL '3 months');
```

### 10.2 `drop_chunks`

```sql
SELECT drop_chunks(
    relation       => 'conditions',     -- REGCLASS, required
    older_than     => INTERVAL '3 months', -- ANY, optional: drop chunks older than this
    newer_than     => NULL,             -- ANY, optional
    verbose        => false,            -- BOOLEAN, default FALSE: print progress messages
    created_before => NULL,             -- ANY, optional
    created_after  => NULL              -- ANY, optional
);
```

Returns a `TEXT` row **per dropped chunk** — the name of each dropped chunk, e.g.
`_timescaledb_internal._hyper_1_2_chunk`. Verbatim example:

```sql
SELECT drop_chunks('conditions', INTERVAL '3 months');
```

(Source: [`drop_chunks()`
reference](https://www.tigerdata.com/docs/api/latest/hypertable/drop_chunks).)

**Why dropping a chunk is cheap and deleting rows is not.** `drop_chunks` removes whole chunk *tables*:
it's *"an instant metadata operation. PostgreSQL removes the underlying table file rather than deleting
rows individually."* A `DELETE FROM bars WHERE time < ...` instead touches every row, generates dead
tuples, and triggers autovacuum churn. **For time-series expiry, always drop chunks; never `DELETE` by
time.** (Source: ["How TimescaleDB Chunks Actually
Work"](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5).)

In production you automate this with a **retention policy** (`add_retention_policy`, which schedules
`drop_chunks`), capping total chunk count and bounding the planning-time tax of §6. Manual `drop_chunks`
is for one-off cleanup; the policy is for steady state. (Retention policies are covered in detail in the
retention/lifecycle pattern reference.)

---

## 11. Worked sizing examples for the THREE canonical market-data resolutions

Tie it all together for the resolutions this product actually ingests. Method each time: estimate
rows/sec → 25M-rows interval → sanity-check against the 25%-of-RAM working-set rule → round to a clean
interval → **import a sample and measure with `chunks_detailed_size` before committing.**

Assume a single-node Postgres with **32 GB RAM** → working-set budget ≈ `32 × 25% = 8 GB`; assume ~4
actively-queried hypertables → per-chunk ceiling ≈ `shared_buffers / (N×2)` with `shared_buffers ≈ 8 GB`
→ `8 / (4×2) = 1 GB` per chunk (use this as the tight ceiling).

### 11.1 Raw trade/quote **ticks** (highest volume)

- **Profile:** US equities consolidated tape peaks at *very* high message rates; even a curated slice of a
  few thousand liquid symbols can produce **thousands of rows/second** sustained, far more at the open/close.
- Say a conservative **2,000 rows/sec**. 25M-rows interval = `25_000_000 / 2_000 = 12_500 s ≈ 3.5 h` →
  round to **a few hours, often 1–2 h** at the open-heavy reality.
- Cross-check the cheat-sheet (§4.7): this is the `1M–100M rows/day` … `>100M rows/day` band → **15 min – 6 h**.
- **Decision:** start at **`1 hour`** (or `30 min` for the busiest symbol set), then **measure** — tick rows
  are narrow, so 25M-row chunks usually stay well under the 1 GB ceiling, but volume spikes mean you watch
  the chunk count and lean on aggressive retention (raw ticks rarely live more than weeks; downsample into
  1-min bars via a continuous aggregate, then drop the raw chunks).

```sql
CREATE TABLE ticks (
    time   TIMESTAMPTZ NOT NULL,
    symbol TEXT        NOT NULL,
    price  DOUBLE PRECISION NOT NULL,
    size   INTEGER     NOT NULL
);
SELECT create_hypertable('ticks', by_range('time', INTERVAL '1 hour'));
SELECT set_chunk_time_interval('ticks', INTERVAL '1 hour');  -- adjust after measuring
```

### 11.2 **1-minute OHLCV bars** (the analytics workhorse)

- **Profile:** one row per symbol per minute, ~390 minutes/regular-session. For **8,000 symbols** that's
  `8_000 × 390 ≈ 3.12M rows/day` → during a 6.5 h session, `3.12M / 23_400 s ≈ 133 rows/sec`.
- 25M-rows interval = `25_000_000 / 133 ≈ 188_000 s ≈ 2.2 days` → round to **1 day** (clean) or **2 days**.
- Cross-check cheat-sheet: ~3M rows/day sits at the top of the `10K–1M`/bottom of `1M–100M` band → **1 day**. ✔
- **Decision:** **`1 day`.** Bars are slightly wider than ticks but still narrow; a 1-day chunk of ~3M rows
  is far under the 1 GB ceiling, and 1-day chunks keep planning fast for the common "last N days" dashboard
  queries.

```sql
CREATE TABLE bars_1m (
    time   TIMESTAMPTZ NOT NULL,
    symbol TEXT        NOT NULL,
    open   DOUBLE PRECISION,
    high   DOUBLE PRECISION,
    low    DOUBLE PRECISION,
    close  DOUBLE PRECISION,
    volume BIGINT
);
SELECT create_hypertable('bars_1m', by_range('time', INTERVAL '1 day'));
```

### 11.3 **Daily bars** (low volume, long horizon)

- **Profile:** one row per symbol per trading day. **8,000 symbols × ~252 trading days/yr ≈ 2.0M rows/yr**,
  i.e. ~8,000 rows on a busy day — *tiny*.
- 25M-rows interval at ~8,000 rows/day = `25_000_000 / 8_000 ≈ 3_125 days ≈ 8.5 years`. You would *never*
  want an 8-year chunk (it'd defeat exclusion and balloon the working set on the hot edge), so the
  **row-count rule yields to common sense + the planning/exclusion goal.**
- Cross-check cheat-sheet: `<10K rows/day` → **1 week – 1 month.**
- **Decision:** **`1 month`** (or `3 months`). This keeps chunk count low over decades of history (12–4
  chunks/year), keeps each chunk trivially memory-resident, and still gives the planner clean monthly/
  quarterly exclusion for typical "this year vs last year" comparisons. This is the canonical case where
  **25M-rows is the wrong rule and the cheat-sheet + planning concern govern.**

```sql
CREATE TABLE bars_1d (
    time   TIMESTAMPTZ NOT NULL,
    symbol TEXT        NOT NULL,
    open   DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION,
    close  DOUBLE PRECISION, volume BIGINT
);
SELECT create_hypertable('bars_1d', by_range('time', INTERVAL '1 month'));
```

### 11.4 The summary table

| Hypertable | Rows/day (8k symbols) | 25M-row interval | **Chosen interval** | Governing rule |
|---|---|---|---|---|
| `ticks` | 10s–100s of millions | ~hours | **1 hour** (measure!) | memory + retention; volume-driven |
| `bars_1m` | ~3 million | ~2.2 days | **1 day** | 25M-rows + clean planning |
| `bars_1d` | ~8 thousand | ~8.5 years (absurd) | **1 month** | cheat-sheet + planning (25M-rows yields) |

> **The meta-lesson of this table:** the 25M-row rule, the memory rule, and the planning-cost concern do
> **not** always agree. For high-volume ticks the memory/retention rules govern; for mid-volume 1-min bars
> they all converge on 1 day; for low-volume daily bars the row-count rule produces an absurd interval and
> the planning-cost concern (keep chunk *count* reasonable, keep exclusion meaningful) governs instead.
> **Always reconcile all three, then measure.** A single rule applied blindly is the Tier-1 mistake.

---

## 12. Checklist — does a new hypertable design pass?

Run this before any hypertable migration is "done":

- [ ] **Time column is `NOT NULL`** and is a `TIMESTAMPTZ` (preferred) or a documented integer-epoch with
      the matching integer `chunk_time_interval` units.
- [ ] **`chunk_time_interval` chosen from the ingest rate**, not left at the 7-day default by accident —
      and the choice is *justified in a comment* against the 25M-row / memory-working-set rules.
- [ ] **Memory check stated:** one hot chunk + its indexes fits in ≈ `RAM × 25% / (N×2)`; the number is
      written down, not assumed.
- [ ] **Measured, not guessed:** representative data imported and `chunks_detailed_size()` checked; interval
      corrected via `set_chunk_time_interval` if the measured size is off (knowing it affects only *future*
      chunks).
- [ ] **Time-only dimension** unless there's a *specific multi-disk I/O* justification for `by_hash`; if
      space-partitioned, `number_partitions` ties to real separate disks (else use RAID + a B-tree index).
- [ ] **Queries include a time predicate** (designed into the API/query layer) so chunk exclusion actually
      fires; `EXPLAIN` shows `Planning Time` < ~50 ms and chunks excluded.
- [ ] **Retention policy planned** to cap total chunk count (and thus planning cost) over the data's
      lifetime; expiry uses `drop_chunks`/a policy, **never** `DELETE … WHERE time < …`.
- [ ] **Back-fill is off the request path** — batched, idempotent, resumable in a worker/cron — not a
      single `migrate_data => true` in an API handler.
- [ ] **R-SCALE tier stated:** which load tier this survives (1× demo / 100× / 10,000×) and what breaks at
      the next — in writing.

---

## Sources

Primary docs (Tiger Data / TimescaleDB):
- [`create_hypertable()` — API reference (generalized API, `WITH (tsdb.hypertable)` form)](https://www.tigerdata.com/docs/api/latest/hypertable/create_hypertable)
- [`create_hypertable()` — reference (generalized API, `by_range`/`by_hash`)](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable)
- [`create_hypertable()` — old interface (legacy, full positional signature + defaults)](https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable_old)
- [`set_chunk_time_interval()` — reference (affects only NEW chunks)](https://www.tigerdata.com/docs/api/latest/hypertable/set_chunk_time_interval)
- [`show_chunks()` — reference](https://www.tigerdata.com/docs/api/latest/hypertable/show_chunks)
- [`drop_chunks()` — reference](https://www.tigerdata.com/docs/api/latest/hypertable/drop_chunks)
- [Hypertables: conceptual overview](https://www.tigerdata.com/docs/use-timescale/latest/hypertables/about-hypertables)
- [Hypertable best practices (space partitioning "not recommended for most users"; RAID alternative)](https://docs-dev.timescale.com/docs-tutorial-aws-lambda/timescaledb/tutorial-aws-lambda/how-to-guides/hypertables/best-practices/)
- [Testing your chunk size (25%-of-RAM rule, `chunks_detailed_size`, 16 GB worked example)](https://www.tigerdata.com/blog/timescale-cloud-tips-testing-your-chunk-size)
- [TimescaleDB 2.26.0 release (current version, PG 15–18)](https://github.com/timescale/timescaledb/releases/tag/2.26.0)

Engineering writing & source-level analysis:
- [How TimescaleDB Chunks Actually Work (And Why Size Matters) — chunk internals, 4,322-chunk planning-time table, 25M-rows rule, drop-chunk metadata op](https://dev.to/philip_mcclarence_2ef9475/how-timescaledb-chunks-actually-work-and-why-size-matters-3hl5)
- [TimescaleDB Memory Tuning: shared_buffers, work_mem, Chunk Sizing — `shared_buffers/(N×2)`, 64 GB / index-growth example, why index-in-memory matters](https://dev.to/philip_mcclarence_2ef9475/timescaledb-memory-tuning-sharedbuffers-workmem-and-chunk-sizing-3fem)
- [Choosing the Right chunk_time_interval for Your Workload](https://dev.to/philip_mcclarence_2ef9475/choosing-the-right-chunktimeinterval-for-your-workload-2gdp)
- [How to Design / Create TimescaleDB Hypertables (oneuptime) — volume cheat-sheet, migration, pitfalls](https://oneuptime.com/blog/post/2026-02-02-timescaledb-hypertables/view)
- [Optimizing queries on TimescaleDB hypertables with thousands of partitions — Matvey Arye / Timescale (planning-time root cause, 600 ms→36 ms)](https://medium.com/timescale/optimizing-queries-timescaledb-hypertables-with-partitions-postgresql-6366873a995d)
- [pg_partman vs. Hypertables — inheritance vs declarative partitioning under the hood](https://www.tigerdata.com/learn/pg_partman-vs-hypertables-for-postgres-partitioning)
- [Problems with PostgreSQL 10 for time-series data — Erik Nordström / Timescale](https://medium.com/timescale/time-series-data-postgresql-10-vs-timescaledb-816ee808bac5)

Issue tracker (planning-time / space-partition guidance):
- [timescaledb#2897 — extremely high planning time with many chunks + LIMIT](https://github.com/timescale/timescaledb/issues/2897)
- [timescaledb#31 — guidance on partitioning, chunk time interval, parallelism (1 space partition per disk)](https://github.com/timescale/timescaledb/issues/31)
- [timescaledb#1401 — guidelines around needing N space partitions](https://github.com/timescale/timescaledb/issues/1401)
