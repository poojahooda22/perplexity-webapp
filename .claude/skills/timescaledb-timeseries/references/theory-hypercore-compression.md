# theory · Hypercore compression (rowstore + columnstore)

> **Skill:** `timescaledb-timeseries` · **Product line:** JPM-Markets re-engineering **data-analytics**
> product line (NOT Lumina). This is *builder knowledge* for the markets data-engineering stack.
> **Scope of this doc:** Hypercore — TimescaleDB's hybrid row/column engine. How compression works,
> the encoders, `segmentby`/`orderby` tuning, the chunk lifecycle, chunk-skipping, the 2.27/2.28
> query improvements, and how to *measure* the ratio you actually got.
>
> **theory-\*** = generic, reusable mechanism (this file). The concrete "configure a markets ticks
> hypertable and prove the ratio" recipe lives in `patterns-*`.
>
> **Version anchor.** Written against TimescaleDB **2.27 / 2.28** (the latest line as of 2026-06).
> `hypertable_compression_stats()` was **deprecated in 2.18.0** in favour of
> `hypertable_columnstore_stats()`; the declarative `tsdb.hypertable` / `tsdb.segmentby` table
> options and the `enable_columnstore` / `convert_to_columnstore` vocabulary are the current API.
> The older `timescaledb.compress*` `ALTER TABLE` form still works and is what most existing SQL in
> the wild uses — both are documented below. **Pin the exact version in your environment** (`SELECT
> extversion FROM pg_extension WHERE extname='timescaledb';`) before copying any version-specific
> claim — encoder behaviour and stat-view names have changed across minor releases.

---

## 0. The one-paragraph mental model

A TimescaleDB **hypertable** is a normal Postgres table that is automatically partitioned by time
into **chunks** (child tables). **Hypercore** gives each chunk *two physical representations*:

- a **rowstore** chunk — an ordinary Postgres heap, row-oriented, optimised for high-speed inserts,
  updates, upserts, and late-arriving rows; this is where **hot** (recent) data lives.
- a **columnstore** chunk — the *same logical rows* re-laid-out **column-by-column**, packed into
  **batches of up to 1000 rows**, with each column's array run through a **type-specific encoder**
  (Gorilla XOR for floats, delta-of-delta for timestamps/ints, dictionary/RLE for low-cardinality
  text, etc.). This is where **cold** (aged) data lives and where the **90–98% storage reduction**
  comes from.

A background **columnstore policy** (or a manual `convert_to_columnstore()` call) moves a chunk from
rowstore → columnstore once it ages past a threshold (e.g. `after => INTERVAL '7 days'`). You can
move it back with `convert_to_rowstore()`. The same hypertable answers queries across *both* stores
transparently — the planner reads recent rows from the rowstore heap and decompresses only the
columnstore batches a query actually needs.

> Source: [Hypercore reference, tigerdata.com](https://www.tigerdata.com/docs/reference/timescaledb/hypercore)
> — "New incoming rows go to the rowstore … As data cools, TimescaleDB automatically converts it to
> the columnstore … 90–98% compression in the columnstore reduces storage cost dramatically."

The two levers you tune are **`segmentby`** (which column groups rows so you can skip whole batches
on a `WHERE`) and **`orderby`** (the sort within each batch, which makes the encoders' deltas tiny
and powers min/max batch skipping). Get those two right and you get both the storage win *and* an
analytical-query speedup; get them wrong and you get a mediocre ratio and full-chunk decompression
on every query.

---

## 1. Why columnar + why time-series compresses so well

### 1.1 The row-vs-column split (the first-principles "why")

A row-store keeps a row's fields physically adjacent: `(time₁, symbol₁, price₁, vol₁), (time₂, …)`.
Good for "give me this whole row" (OLTP). Bad for "average `price` over 10M rows" — you drag every
other column through cache to touch one.

A column-store keeps each column's values physically adjacent: all `time`s, then all `symbol`s, then
all `price`s. Good for analytics — a `AVG(price)` scan touches *only* the `price` array, sequentially,
cache-friendly, and **SIMD-vectorizable**. The other thing it unlocks is **compression**: adjacent
values *of the same type and similar magnitude* compress far better than a heterogeneous row does.
This is the entire bet of Hypercore: time-series analytics is column-shaped, so store cold data as
columns and encode each column with an algorithm that exploits its specific redundancy.

### 1.2 Why *time-series* columns are unusually compressible

Time-series columns are not random — they have structure the encoders are built to exploit:

| Column kind (markets example) | Structure | Best-fit encoder |
|---|---|---|
| `time` (regular ticks/bars) | near-constant step (1s, 1m) | **delta-of-delta** → mostly a single bit/row |
| `symbol` / `exchange` / `venue` | few distinct values repeated | **dictionary + RLE** |
| `price`, `bid`, `ask`, `iv` (floats) | small move between consecutive rows | **Gorilla XOR** (most values → 1 bit) |
| `volume`, `trade_count` (ints) | slowly varying or repeated | **delta + simple-8b + RLE** |
| `is_halted` (bool) | long runs of the same value | **bool bitmap + simple-8b RLE** |

> Source: [Time-series compression algorithms, explained — tigerdata.com](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained)
> — "Delta-of-delta + Simple-8b with run-length encoding compression for integers, timestamps, and
> other integer-like types; XOR-based compression for floats; Whole-row dictionary compression for
> columns with a few repeating values (plus LZ compression on top); LZ-based array compression for
> all other types."

That "up to 98%" headline is real *for the right shape of data* and a lie for the wrong shape. §6
quantifies both.

---

## 2. Hypercore architecture: rowstore + columnstore lifecycle

### 2.1 The two stores

> Source for this whole subsection: [Hypercore reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore).

- **Rowstore (hot):** "optimized for high-speed inserts and updates"; handles "rapid ingest streams
  including upserts and late-arriving rows." A standard Postgres heap per chunk.
- **Columnstore (cold):** the chunk's rows re-encoded column-by-column. Delivers the "90–98%
  compression" and the analytical scan speed. **Row Level Security is NOT supported on chunks in the
  columnstore** — a hard limitation to remember if your access model leans on RLS.

A single hypertable holds a mix: the newest N chunks in rowstore, everything older in columnstore.
Queries span both with no application change.

### 2.2 Moving a chunk between stores

**Manual, per-chunk** (these are the current verbs; the legacy aliases are `compress_chunk` /
`decompress_chunk`):

```sql
-- aged a chunk into columnar form
SELECT convert_to_columnstore('_timescaledb_internal._hyper_1_42_chunk');

-- pull it back to rowstore (e.g. before a big backfill into that chunk)
SELECT convert_to_rowstore('_timescaledb_internal._hyper_1_42_chunk');
```

> Source: [Hypercore reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore) —
> `convert_to_columnstore()` "Manually add chunks to columnstore … Different chunks do not block each
> other" (so you can convert many in parallel across sessions); `convert_to_rowstore()` "Move chunks
> back from columnstore to rowstore, useful when backfilling old data conflicts with active
> conversions."

**Automatic, policy-driven** — the normal production path:

```sql
-- convert any chunk whose data is older than 7 days, on a background schedule
CALL add_columnstore_policy('crypto_ticks', after => INTERVAL '7 days');

-- stop the policy (already-converted chunks stay columnar)
CALL remove_columnstore_policy('crypto_ticks');
```

> Source: [Hypercore reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore) —
> "`add_columnstore_policy(hypertable_name, after => interval)`: Runs as a background job converting
> eligible chunks on schedule … The policy runs single-threaded, so backlogs may take time."
> `remove_columnstore_policy()` "Removes the policy while keeping converted chunks in columnstore."

> **Operational gotcha (single-threaded policy).** The columnstore policy job converts chunks
> **single-threaded**. If you enable compression on a large existing hypertable, the policy can take a
> long time to chew through the backlog. To compress a big historical table *fast*, fan out
> `convert_to_columnstore()` calls across several sessions (chunks don't block each other) instead of
> waiting on the one policy worker. (Source: same reference, "Different chunks do not block each
> other" + "runs single-threaded, so backlogs may take time.")

### 2.3 When you create the table the policy can be implicit

With the declarative table options, declaring `segmentby`/`orderby` *also* sets up the columnstore:

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
  tsdb.orderby   = 'time DESC'
);
```

> Source: [Basic compression how-to](https://www.tigerdata.com/docs/build/how-to/basic-compression)
> — "When you create a hypertable with these parameters, TimescaleDB automatically creates a
> columnstore policy that converts older chunks into columnar format. Recent data remains in rowstore
> for fast inserts, while older data compresses in the columnstore."

---

## 3. Enabling compression: the exact DDL (both forms)

There are two surface syntaxes for the **same** underlying feature. Know both; you will see both.

### 3.1 Legacy `ALTER TABLE … SET (timescaledb.compress*)` — the form most existing SQL uses

```sql
ALTER TABLE <table_name> SET (
  timescaledb.compress,
  timescaledb.compress_orderby   = '<column> [ASC|DESC] [NULLS {FIRST|LAST}] [, ...]',
  timescaledb.compress_segmentby = '<column> [, ...]',
  timescaledb.compress_chunk_time_interval = '<interval>'   -- experimental
);
```

> Source: [ALTER TABLE (Compression) API](https://www.tigerdata.com/docs/api/latest/compression/alter_table_compression/)
> (resolves to [the docs repo file](https://github.com/timescale/docs/blob/latest/api/compression/alter_table_compression.md)).

| Parameter | Type | Required | Behaviour (verbatim-grounded) |
|---|---|---|---|
| `timescaledb.compress` | BOOLEAN | **Yes** | "Activates or deactivates compression." |
| `timescaledb.compress_orderby` | TEXT | No | "Ordering applied during compression; follows SELECT ORDER BY syntax. **Defaults to descending time column order.**" |
| `timescaledb.compress_segmentby` | TEXT | No | "Columns designating compressed segment keys (e.g. `device_id`). **Defaults to no segmentation.**" |
| `timescaledb.compress_chunk_time_interval` | TEXT | No | **Experimental.** "Defines compressed chunk rollup interval; merges adjacent chunks and prevents splitting during decompression." |

Canonical example (verbatim from the API page):

```sql
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_orderby   = 'time DESC',
  timescaledb.compress_segmentby = 'device_id'
);
```

Tune (or disable) the compressed-chunk rollup interval independently:

```sql
ALTER TABLE metrics SET (timescaledb.compress_chunk_time_interval = '24 hours');
ALTER TABLE metrics SET (timescaledb.compress_chunk_time_interval = '0');  -- disable rollup
```

### 3.2 Current `enable_columnstore` / `tsdb.*` form — the Hypercore vocabulary

```sql
ALTER TABLE crypto_ticks SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'symbol',
  timescaledb.orderby   = 'time DESC'
);
```

> Source: [Hypercore reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore) —
> shows exactly this `enable_columnstore` / `segmentby` / `orderby` triple.

The `tsdb.*` alias of the same options is what appears in the `WITH (...)` clause at `CREATE TABLE`
time (§2.3). `tsdb.` and `timescaledb.` are interchangeable prefixes.

> **Mapping the two vocabularies:** `compress` ↔ `enable_columnstore`; `compress_segmentby` ↔
> `segmentby`; `compress_orderby` ↔ `orderby`. Same feature, two names. Pick one per codebase and be
> consistent so greps and migrations stay legible.

### 3.3 What happens to already-existing chunks when you change settings

Changing `segmentby`/`orderby` on a table whose chunks are **already columnar does not retroactively
re-encode them.** New settings apply to chunks compressed *after* the change. To apply new
segmentby/orderby to existing data you must `convert_to_rowstore()` then `convert_to_columnstore()`
(or `recompress`) those chunks. This is the same "applies only to chunks created after" rule that
governs chunk-skipping (§5) — internalise it: **TimescaleDB compression settings are forward-looking,
not migrations.**

---

## 4. The encoders — what actually shrinks the bytes

This is the heart of the "theory." Each column is compressed with an algorithm chosen **by its data
type and value distribution**, not a one-size LZ. The five core compressors (plus a couple of newer
specialised ones) and how they work:

### 4.1 The type → algorithm map (deterministic)

> Source: [compression-methods.md (docs)](https://github.com/timescale/docs/blob/latest/use-timescale/hypercore/compression-methods.md)
> + [time-series compression algorithms blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained):

| Column data type / shape | Algorithm(s) applied |
|---|---|
| `int`, `bigint`, `timestamp`, `timestamptz`, integer-like | **delta** → **delta-of-delta** → **simple-8b** → **run-length encoding** (combination) |
| `float4` / `float8` (doubles) | **Gorilla XOR**-based float compression |
| low-cardinality columns (few repeated values, any type) | **whole-row / whole-column dictionary** (+ LZ on top) |
| `boolean` | **bool compressor** — bitmap + simple-8b RLE |
| **everything else** (fallback) | **LZ-based array compression** (uncompressed array → LZ) |
| `uuid` (v7) | **UUID compressor** — delta-delta on the timestamp portion + dictionary where cardinality warrants |

> The selection is **deterministic by type**, not a "try them all and pick the smallest" auction —
> with one exception: dictionary compression "automatically detects when … isn't beneficial and
> falls back to not using a dictionary" (i.e. it bails to the array path if the dictionary would be as
> big as the data). (Source: [compression-methods.md](https://github.com/timescale/docs/blob/latest/use-timescale/hypercore/compression-methods.md).)

The **base primitive under everything** is `simple8b_rle` — a header-only implementation that
bit-packs `uint64` values and run-length-encodes on the fly. Delta, delta-of-delta, dictionary
indexes, and bool runs all ultimately feed into it. (Source: [timescaledb `tsl/src/compression/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/compression/README.md)
— "The base building block is simple8b_rle … compresses uint64 values through bit-packing and
run-length encoding.")

### 4.2 Delta encoding

Store the **difference** from the previous value instead of the absolute value.

```
raw:   [1,073,741,824 ,  858,993,459 , ...]
delta: [1,073,741,824 ,   -214,748,365 , ...]   -- second value now needs far fewer bits
```

> Source: [time-series compression blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained)
> — delta "reduces the amount of information required … by only storing the difference (or delta)
> between that object and one or more reference objects."

Why it helps: a slowly-varying integer column (volume, depth, an incrementing counter) has small
deltas, and small numbers need fewer bits under simple-8b.

### 4.3 Delta-of-delta (the timestamp killer)

Apply delta **twice**. For a regular interval the first delta is a constant (the step), and the
*delta of that constant* is **zero**.

```
times:        t, t+5s, t+10s, t+15s, ...
delta:        5s, 5s, 5s, ...
delta-of-delta: 0, 0, 0, ...   -> a long run of zeros -> ~1 bit each
```

> Source: [time-series compression blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained)
> — "This compresses a full timestamp (8 bytes = 64 bits) down to just a single bit (**64×
> compression**)." Implementation: [`tsl/src/compression/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/compression/README.md)
> — DeltaDelta "takes the delta-of-deltas with the previous integer, **zigzag encodes** this
> deltadelta, then finally simple8b_rle encodes" it. (Zigzag maps signed → unsigned so small negative
> deltas stay small.)

This is **the** reason a regularly-sampled `time` column nearly vanishes after compression, and it is
why `orderby = 'time DESC'` is almost always correct: sorting by time makes the time-column deltas
maximally regular.

### 4.4 Simple-8b

Pack many small integers into fixed 64-bit words, choosing the bit-width per word so the largest
value in that word fits. "Each integer is represented in the minimal bit-length needed to represent
the largest integer in that block." Amortises the per-value length overhead across a block.

> Source: [time-series compression blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained).
> TimescaleDB extends it for **reverse-order decompression** so backward time scans (the common
> `ORDER BY time DESC LIMIT n`) are cheap. (Source: [compression-methods.md](https://github.com/timescale/docs/blob/latest/use-timescale/hypercore/compression-methods.md)
> — "Simple-8b variant … extended to support reverse-order decompression.")

### 4.5 Run-length encoding (RLE)

Replace a run of identical values with `{count, value}`.

```
raw:  11,12,12,12,12,12,12,1,12,12,12,12
rle:  {1;11},{6;12},{1;1},{4;12}
```

> Source: [time-series compression blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained)
> — TimescaleDB uses "a variant of Simple-8b RLE, where we detect runs on-the-fly, and
> run-length-encode if it would be beneficial." It is *adaptive*: it only switches to RLE when it pays.

### 4.6 Gorilla XOR — the float compressor

Floats don't delta well (a tiny price move is a large, irregular bit change in IEEE-754). Gorilla
instead **XORs consecutive doubles** and stores only the meaningful (differing) bits — leading-zero
count + meaningful-bit block.

> Source: [time-series compression blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained)
> — "Successive floating-point numbers are XORed together, storing only differing bits." Reported
> distribution on real data: "Over **50% of floating point values (all doubles) were compressed to a
> single bit**, ~30% to 26.6 bits, and the remainder to 39.6 bits." Implementation:
> [`tsl/src/compression/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/compression/README.md)
> — Gorilla "uses the Facebook gorilla algorithm to encode floats by storing compressed xors of
> adjacent values." Origin paper: Pelkonen et al., *Gorilla: A Fast, Scalable, In-Memory Time Series
> Database*, VLDB 2015.

The practical consequence for markets data: a `price`/`bid`/`ask`/`iv` column where consecutive ticks
are close (which is *most* of the time) collapses to roughly a bit per row. A column of *random*
floats (e.g. nonce, hash-like) does NOT — Gorilla needs the locality.

### 4.7 Dictionary compression

Build the set of distinct values; store each row as an **index** into that dictionary; the index
column is then simple-8b/RLE compressed.

```
raw:   ["NASDAQ","NYSE","NYSE","NASDAQ", ...]
dict:  {0:"NASDAQ", 1:"NYSE"}
codes: [0,1,1,0, ...]   -> tiny + LZ on top
```

> Source: [time-series compression blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained)
> — and its limit: "In a dataset with very few repeated values, the dictionary will be the same size
> as the original data." (Hence the auto-fallback in §4.1.) Implementation:
> [`tsl/src/compression/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/compression/README.md)
> — Dictionary stores the "unique value in the dataset (stored as an array)" + "simple8b_rle
> compressed list of indexes into the dictionary."

This is the encoder for `symbol`, `exchange`, `currency`, `option_type`, `sector` — anything with a
bounded vocabulary. It is *also* why putting a low-cardinality text column in `orderby` (so its rows
cluster) further improves its dictionary/RLE result.

### 4.8 The array fallback + bool/UUID specials

- **Array**: "uncompressed storage as a fallback mechanism for any data type when other algorithms
  prove unsuitable" — i.e. the catch-all (then LZ on top for the "all other types" path).
- **Bool**: simple-8b RLE over a bitmap. A `is_active`/`halted` flag with long runs is near-free.
- **UUID**: delta-delta on the time portion of UUID v7 + dictionary as warranted.

> Source: [`tsl/src/compression/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/compression/README.md).

### 4.9 The speed claim, kept honest

> "These [type-specific] techniques are **up to 40× faster than LZ-based compression during
> decoding**." — [time-series compression blog](https://www.tigerdata.com/blog/time-series-compression-algorithms-explained).

"Up to 40×" is a decode-speed ceiling on favourable data, not a guarantee. The real win is twofold:
specialised encoders **both** shrink more *and* decode faster than throwing generic LZ at a row blob,
because they exploit the column's known structure. Treat 40× as "much faster," not as a number to
quote to stakeholders.

---

## 5. The physical layout: batches, metadata, and why `segmentby`/`orderby` are *the* levers

You cannot tune compression well without knowing what the compressed chunk physically *is*.

### 5.1 The compressed-chunk shape

When a chunk is converted to columnstore, TimescaleDB:

1. **Groups rows by the `segmentby` columns.** Each distinct segmentby combination is a **segment**.
2. **Within a segment, sorts rows by `orderby`** (e.g. `time DESC`).
3. **Packs the sorted rows into batches of up to 1000 rows.** Each batch becomes **one row** in the
   compressed table, where each original column is now a **compressed array** of (up to) 1000 values.
4. Keeps the **segmentby columns stored as-is** (not array-ified) on that compressed row — so the
   planner can filter on them *without decompressing anything*.
5. Attaches **per-batch metadata** for each orderby column at position N:
   - `_ts_meta_min_N` — minimum orderby value in the batch
   - `_ts_meta_max_N` — maximum orderby value in the batch
   - `_ts_meta_count` — number of rows in the batch
6. Builds an **index on `(segmentby_cols…, _ts_meta_min_1, _ts_meta_max_1)`**.

> Sources: [`tsl/src/compression/README.md`](https://github.com/timescale/timescaledb/blob/main/tsl/src/compression/README.md)
> ("packs rows into batches of ~1000 and compresses each batch separately … each batch becomes a
> single row in the compressed table, in which the columns are arrays"); the `ts_guc_compression_batch_size_limit`
> GUC "controls the maximum number of rows per compression batch (default: 1000)";
> [DeepWiki — Enabling and Configuring Compression](https://deepwiki.com/timescale/timescaledb/3.1-enabling-and-configuring-compression)
> (segmentby columns "stored in their original form (not compressed)"; `_ts_meta_min_N`/`_ts_meta_max_N`
> per orderby column; the segmentby + 2-keys-per-orderby index, bounded by Postgres `INDEX_MAX_KEYS`).

> **The mechanism in one sentence:** a query that filters `WHERE symbol='AAPL' AND time BETWEEN …`
> uses the segmentby value to jump to AAPL's compressed rows, then the `_ts_meta_min_1`/`_ts_meta_max_1`
> on each batch to skip batches whose time range can't overlap — touching the compressed `price` array
> for **only** the batches that survive both filters, often "an order of magnitude faster than without
> segmentby." (Source: [DeepWiki, same page](https://deepwiki.com/timescale/timescaledb/3.1-enabling-and-configuring-compression).)

### 5.2 `segmentby` — choosing it

`segmentby` is the column(s) you **filter on in `WHERE`** and that define the unit of selective
decompression. The single most consequential choice you make.

**The cardinality sweet spot:** roughly **100–10,000 distinct values per chunk**.

> Source (synthesised from primary + community): [forum: best practices for compress_segmentby](https://forum.tigerdata.com/forum/t/what-are-the-best-practices-for-compress-segmentby/2229);
> [basic compression how-to](https://www.tigerdata.com/docs/build/how-to/basic-compression)
> ("Choose `segmentby` based on how you filter data … Lower cardinality `segmentby` columns give
> better compression"). The failure modes at each end:

| Cardinality per chunk | What happens | Verdict |
|---|---|---|
| **None set** | one giant segment per chunk | ratio may be fine, but **every** filtered query decompresses the whole chunk — kills selective decompression |
| **Too low (<100 distinct)** | few, huge segments | great ratio, but coarse skipping; a `WHERE symbol=…` still scans a large fraction |
| **Sweet spot (~100–10k)** | each segment has enough rows for encoders to find patterns AND filtering is selective | **the target** |
| **Too high (≈ unique per row, >10k)** | each segment = ~1 row; nothing to compress; **per-segment metadata overhead grows the table** | actively bad — ratio *worse* than no segmentby |

> Source for the failure modes: search synthesis grounded in the forum thread above + the DEV
> guide [Why Your TimescaleDB Compression Ratio Is Bad](https://dev.to/philip_mcclarence_2ef9475/why-your-timescaledb-compression-ratio-is-bad-and-how-to-fix-it-lb1)
> — "Each segment of data should contain at least 100 rows in each chunk. If your segments are too
> small … move some columns from the segmentby list to the orderby list."

**Decision rules for `segmentby`:**

1. Pick the column(s) that appear in **`WHERE … = …`** on your hot queries (markets: `symbol`,
   `instrument_id`, `venue`). If you never filter by it, it should not be segmentby.
2. Keep total distinct combinations **per chunk** in the 100–10k band. If `symbol` alone is 8,000
   tickers, that's perfect; if you add `× venue × side` and blow past tens of thousands, pull the
   extra columns into `orderby` instead.
3. **More segmentby columns ≠ better.** Each one multiplies cardinality and shrinks segments. The
   "compression ratio is bad" diagnosis is most often *too many* segmentby columns.
4. A segmentby column is stored **uncompressed and repeated once per batch** — so a wide text
   segmentby (long strings) carries overhead; prefer a compact id.

### 5.3 `orderby` — choosing it

`orderby` sorts rows **within** each segment before batching. Two jobs:

1. **Maximise encoder locality** — consecutive sorted values have tiny deltas/XORs (§4). `time DESC`
   makes the time column delta-of-delta to near-zero and clusters nearby prices/volumes.
2. **Power batch min/max skipping** — the `_ts_meta_min/max` on the orderby column let the planner
   skip batches that can't match a range predicate.

> Source: [compression_settings concepts](https://github.com/timescale/docs/blob/latest/api/informational-views/compression_settings.md)
> + [basic how-to](https://www.tigerdata.com/docs/build/how-to/basic-compression) — orderby "defines
> the sort order for data within each compressed segment. This enables efficient range queries through
> min/max metadata indexes."

**Rules of thumb:**

- **`time DESC` is right ~95% of the time.** It is the default, it suits the dominant "latest N"
  access, and it makes the time column compress maximally.
- Add a **secondary** orderby column only if it (a) is also range-queried and (b) further clusters
  similar values — e.g. `orderby = 'symbol, time DESC'` when symbol is *not* segmentby but you still
  scan ranges per symbol.
- A column that is `segmentby` should **not** also be `orderby` (it's already constant within a
  segment — wasted metadata).

### 5.4 The `segmentby`-vs-`orderby` trade you will actually make

A column can go in **exactly one** of the two roles, and the choice is a real trade:

- as **`segmentby`** → exact-match filtering is free (skip whole segments), but if cardinality is too
  high segments fragment and the ratio collapses.
- as **`orderby`** → no segment fragmentation, range filtering via min/max metadata, but a
  *point* `=` filter is less surgical than segmentby.

Rule: **filtered-by-equality + moderate-cardinality → segmentby; range-filtered or
high-cardinality-but-clustered → orderby.** When in doubt for a markets ticks table: `segmentby =
'symbol'`, `orderby = 'time DESC'`, and measure (§6) before adding anything.

### 5.5 Inspecting what you configured

```sql
-- current (per docs): the columnstore settings, deprecated-but-everywhere compression_settings
SELECT * FROM timescaledb_information.compression_settings
WHERE hypertable_name = 'crypto_ticks';
```

> Columns (verbatim from [compression_settings.md](https://github.com/timescale/docs/blob/latest/api/informational-views/compression_settings.md)):
> `hypertable_schema`, `hypertable_name`, `attname` (the column), `segmentby_column_index` (position in
> the segmentby list, NULL if not segmentby), `orderby_column_index` (position in the orderby list),
> `orderby_asc` (true=ASC), `orderby_nullsfirst`. **Deprecation note:** this view is "maintained for
> backwards compatibility"; the recommended replacements are
> `timescaledb_information.hypertable_compression_settings` and
> `timescaledb_information.chunk_compression_settings`. Per-chunk settings:
> `timescaledb_information.chunk_columnstore_settings`.

One row per segmentby/orderby column. If a column you *thought* was segmentby shows
`segmentby_column_index IS NULL`, your `ALTER TABLE` didn't take — fix it before measuring.

---

## 6. Compression ratios: the real numbers and how to measure yours

### 6.1 The headline and the honest caveat

The docs quote **90–98% storage reduction** in the columnstore (≈10×–50× smaller). That is **real for
the right data and misleading as a default expectation.**

> Source: [Hypercore reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore)
> ("90–98% compression in the columnstore"). Hypercore reference example: 194 MB → 24 MB ≈ **88%**.

Real-world calibration from a practitioner write-up:

> [roszigit.com — TimescaleDB Compression: Hypercore … up to 98%](https://roszigit.com/en/blog/timescaledb-compression-hypercore/):
> on MQTT sensor data with "~180 unique `id` values with 4,000–113,000 rows each," using
> `segmentby='id', orderby='time DESC'`, a chunk went **2.3 GB → 7.2 MB ≈ 42.8×** with query time
> 10.2 ms → 0.36 ms (≈28× faster). **The author's own caveat:** "42× is *my* dataset" with
> "exceptionally high redundancy"; for typical workloads **expect 8–20×.**

> Another production report: [DEV — 150 GB → 15 GB, 90% reduction](https://dev.to/polliog/timescaledb-compression-from-150gb-to-15gb-90-reduction-real-production-data-bnj)
> — a clean ~10× on real data, which is a much more typical headline than 98%.

**What to tell stakeholders:** plan for **~10× (90%)** on well-shaped markets time-series; treat 20×+
as a pleasant surprise that depends on low-cardinality segmentby and smooth float columns; treat
"98%" as a marketing ceiling, not a forecast. The number is entirely a function of *your* data's
redundancy and *your* segmentby/orderby choices.

### 6.2 Measuring the actual ratio — the correct, current function

`hypertable_compression_stats()` is **deprecated since 2.18.0**. Use
`hypertable_columnstore_stats()`:

```sql
SELECT
  total_chunks,
  number_compressed_chunks,
  pg_size_pretty(before_compression_total_bytes) AS before,
  pg_size_pretty(after_compression_total_bytes)  AS after,
  round(
    before_compression_total_bytes::numeric
      / NULLIF(after_compression_total_bytes, 0), 1
  ) AS ratio_x
FROM hypertable_columnstore_stats('crypto_ticks');
```

> Columns of `hypertable_columnstore_stats()` (from [hypertable_columnstore_stats reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore/hypertable_columnstore_stats)
> / search synthesis): `total_chunks`, `number_compressed_chunks`,
> `before_compression_table_bytes`, `before_compression_index_bytes`,
> `before_compression_toast_bytes`, `before_compression_total_bytes`,
> `after_compression_table_bytes`, `after_compression_index_bytes`,
> `after_compression_toast_bytes`, `after_compression_total_bytes`, `node_name`. It "replaces
> `hypertable_compression_stats()`, which was deprecated in 2.18.0."

The Hypercore reference's own one-liner (verbatim):

```sql
SELECT
  pg_size_pretty(before_compression_total_bytes) AS before,
  pg_size_pretty(after_compression_total_bytes)  AS after
FROM hypertable_columnstore_stats('crypto_ticks');
```

> **Stat-staleness trap.** `*_stats` values can be **stale/incorrect until chunks are
> (re)compressed** — this is a known issue (see [timescaledb#7713](https://github.com/timescale/timescaledb/issues/7713),
> [#3581](https://github.com/timescale/timescaledb/issues/3581)). If a ratio looks impossible (0,
> negative, or unchanged after compression), recompress the chunk and re-read, or fall back to raw
> on-disk sizes (below) before trusting it.

### 6.3 The ground-truth fallback — physical sizes

When in doubt, measure bytes on disk directly — what roszigit did to get the honest 42.8×:

```sql
-- whole-hypertable footprint
SELECT pg_size_pretty(hypertable_size('crypto_ticks'));

-- per-chunk breakdown (compare a rowstore chunk to a columnstore chunk of similar row count)
SELECT chunk_name,
       pg_size_pretty(table_bytes)  AS table_sz,
       pg_size_pretty(index_bytes)  AS index_sz,
       pg_size_pretty(total_bytes)  AS total_sz
FROM chunks_detailed_size('crypto_ticks')
ORDER BY total_bytes DESC;
```

> Sources: [basic how-to](https://www.tigerdata.com/docs/build/how-to/basic-compression)
> (`hypertable_size`, `chunks_detailed_size`); roszigit derived 42.8× "by comparing physical chunk
> sizes on disk."

### 6.4 The right way to run a compression-tuning experiment

1. Load a representative chunk's worth of real data into the rowstore.
2. Record `chunks_detailed_size()` for that chunk (the "before").
3. `convert_to_columnstore()` that one chunk.
4. Record `hypertable_columnstore_stats()` **and** `chunks_detailed_size()` (the "after").
5. Vary **one** of `segmentby` / `orderby` at a time (remember §3.3: re-convert to apply), re-measure.
6. Also time the **queries you actually run** before/after — ratio is half the story; if the
   segmentby is wrong you can compress 95% and *still* be slow because every query decompresses the
   whole chunk. Optimise for "ratio **and** query latency," not ratio alone.

---

## 7. Query implications: what gets faster, what gets slower

### 7.1 Faster on the columnstore

> Sources: [Hypercore reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore),
> [TimescaleDB 2.27 blog](https://www.tigerdata.com/blog/timescaledb-2-27).

- **Segmentby-filtered queries** (`WHERE symbol='AAPL'`): jump straight to that segment's compressed
  rows; skip everyone else's batches without decompressing — "an order of magnitude faster."
- **Time-range queries** (`WHERE time BETWEEN …`): `_ts_meta_min_1/max_1` skip non-overlapping
  batches.
- **Columnar analytical scans** (`AVG/SUM/COUNT(price)` over many rows): touch only that column's
  arrays, sequential + vectorizable.
- **Summary aggregates** (`COUNT`, `MIN`, `MAX`, `FIRST`, `LAST`): "read results straight from batch
  metadata" — frequently answered without decompressing the data at all.
- **Sparse-index pruning**: bloom indexes for equality + minmax for ranges "let the engine skip
  individual batches without decompressing them."

### 7.2 Slower / costly on the columnstore

The cost of columnar form is **mutation**. A compressed batch is an encoded array; to change one row
inside it the engine has to locate, decompress, modify, and re-compress that batch.

- **Point `UPDATE`/`DELETE` by a non-segmentby predicate** on compressed data historically had to
  decompress matching batches — expensive.
- **`INSERT … ON CONFLICT` (upsert)** into a compressed chunk must check existing batches for the
  conflict key, which historically meant decompressing candidate batches.
- **Backfilling / late-arriving rows** into an already-columnstore chunk: contends on locks; the
  recommended pattern is `convert_to_rowstore()` → backfill → `convert_to_columnstore()` (Source:
  [Hypercore reference](https://www.tigerdata.com/docs/reference/timescaledb/hypercore) — "Conversion
  contends on locks with any concurrent write to the same chunk").

> **Architectural takeaway:** keep **hot, mutable** data in the rowstore (recent chunks) and only age
> **immutable** data into the columnstore. The columnstore is for data you append-once and read-many.
> A workload that updates week-old rows constantly is fighting the design — set the columnstore policy
> `after` interval *past* your mutation window.

### 7.3 The 2.27 / 2.28 mutation improvements (this is the big recent change)

2.27 substantially narrowed the "writes on compressed data are slow" gap:

> Source: [TimescaleDB 2.27 blog](https://www.tigerdata.com/blog/timescaledb-2-27).

- **Bloom filters prune compressed batches before decompression on `UPDATE`/`DELETE`** — "up to
  **160× more efficient** UPDATE and DELETE on compressed data"; a benchmark dropped **820 ms → 4.4
  ms**. `EXPLAIN` now shows `Compressed batches filtered` and `Batches filtered after decompression`.
  Works best when "equality predicates are highly selective and multiple columns are combined."
- **Composite bloom filters for `UPSERT`** — accelerate conflict detection for `INSERT … ON CONFLICT`
  on compressed hypertables; new `EXPLAIN` stats: `Batches checked by bloom`, `Batches pruned by
  bloom`, `Batches without bloom`, `Bloom false positives`.
- **Vectorized filter evaluation** — filters evaluated inline through the standard Postgres function
  path within the columnstore pipeline, covering previously non-vectorizable `WHERE` clauses (e.g.
  `time_bucket()`); **"30%–2× faster"** in many cases (and especially continuous-aggregate refreshes).
  **2.28** added `CASE`-expression support to the vectorized path.
- **`compress_after_refresh`** — lets a continuous-aggregate policy "refresh and compression … run
  together as part of a single policy execution," removing separate-job coordination.
- **Smarter direct compression** — TimescaleDB now "automatically selects an appropriate `segmentby`
  column when one isn't explicitly configured," and per-chunk compression failures no longer fail the
  whole job: it "report[s] success with warnings, isolating the failure to the affected chunks."

> Net: on **2.27+** the "never update compressed data" folklore is softened — guarded
> `UPDATE`/`DELETE`/`UPSERT` with selective equality predicates are now genuinely fast because bloom
> filters prune most batches before any decompression. It is still true that *bulk* re-mutation of
> cold data is a smell; the rowstore is still where churn belongs.

---

## 8. Chunk-skipping on correlated columns (`enable_chunk_skipping`)

Beyond per-batch `_ts_meta_min/max` (which work on the orderby column), TimescaleDB can track a
**per-chunk min/max range for an additional column** so the planner excludes whole *chunks* on a
`WHERE` over that column — even though the table is partitioned by `time`, not that column.

```sql
SELECT enable_chunk_skipping(
  hypertable    => 'crypto_ticks',
  column_name   => 'trade_id',         -- a column correlated with time
  if_not_exists => true
);
```

> Source: [enable_chunk_skipping() API](https://www.tigerdata.com/docs/api/latest/hypertable/enable_chunk_skipping)
> / [docs repo](https://github.com/timescale/docs/blob/latest/api/hypertable/enable_chunk_skipping.md):

- **Signature:** `enable_chunk_skipping(hypertable REGCLASS, column_name NAME, if_not_exists BOOLEAN
  DEFAULT false)`; returns `(column_stats_id INTEGER, enabled BOOLEAN)`.
- **What it does:** tracks the min/max value of `column_name` **per chunk**, stored
  `[start_inclusive, end_exclusive)` in the `chunk_column_stats` catalog. On a query with a range/`=`
  predicate over that column, the planner does **dynamic chunk exclusion** — skips chunks whose stored
  range can't match.
- **Supported types:** `smallint`, `int`, `bigint`, `serial`, `bigserial`, `date`, `timestamp`,
  `timestamptz`. (No text/float chunk-skipping.)
- **Critical timing rule:** "applies only to the chunks created after chunk skipping is enabled" —
  ranges are "calculated when a chunk … is compressed using the `compress_chunk` function." So:
  **enable it BEFORE compressing**, or **recompress** existing chunks to populate ranges. (Confirmed
  by the [recompression-needed forum thread](https://forum.tigerdata.com/forum/t/recompression-needed-for-chunk-skipping/2909).)
- **When it earns its keep:** a column **correlated with the partitioning time** — e.g. a
  monotonically increasing `trade_id`/`sequence_no`/`ingest_id` that you also filter on. If the column
  is uncorrelated with time (random per chunk), every chunk's range covers everything and nothing is
  skipped — no benefit.

> Reported impact: [Boost Postgres Performance by 7× with chunk-skipping indexes](https://www.tigerdata.com/blog/boost-postgres-performance-by-7x-with-chunk-skipping-indexes).

**Markets fit:** enable on `ingest_seq`/`event_id` if your audit/replay queries filter by it; do NOT
bother on `symbol` (that's what `segmentby` is for) or on `price` (unsupported type + uncorrelated).

---

## 9. Putting it together — a markets ticks checklist

A condensed decision flow for "configure compression on a markets hypertable" (full recipe is in
`patterns-*`):

1. **Partition by time** (it's a hypertable). Pick a `chunk_time_interval` so a chunk is a workable
   size (target a chunk that fits comfortably in memory; e.g. a day or an hour of ticks).
2. **`segmentby` = the equality-filtered, moderate-cardinality column** — almost always `symbol` /
   `instrument_id`. Confirm distinct-per-chunk lands in ~100–10k. If your symbol universe is huge,
   that's fine (still in band); if you're tempted to add `× venue × side`, *don't* — push those to
   orderby.
3. **`orderby = 'time DESC'`** (plus a secondary clustering column only if range-queried).
4. **`add_columnstore_policy(..., after => INTERVAL 'X')`** where `X` is safely past your
   mutation/backfill window (so cold = immutable).
5. **`enable_chunk_skipping`** on a time-correlated secondary id *before* first compression, if you
   query by it.
6. **Measure**: `hypertable_columnstore_stats()` for the ratio + `chunks_detailed_size()` for
   ground-truth, and **time your real queries** before/after. Expect ~10×; investigate if <5× (likely
   too many/too-high-cardinality segmentby columns).
7. **Keep the rowstore for churn.** If a feature needs to update recent data, make sure that data is
   still in rowstore (policy `after` interval long enough); rely on 2.27 bloom-pruned
   `UPDATE`/`DELETE` only for occasional, selective corrections of cold data.

---

## 10. Anti-patterns (mistake → fix), compression-specific

| Mistake | Why it bites | Fix |
|---|---|---|
| No `segmentby` set | one giant segment/chunk; every filtered query decompresses the whole chunk | set `segmentby` to your `WHERE =` column (moderate cardinality) |
| Too many `segmentby` columns | segments fragment to <100 rows; metadata overhead grows the table; ratio *drops* | keep to 1 (maybe 2) columns; move the rest to `orderby` |
| Unique-per-row `segmentby` (>10k/chunk) | ~1 row/segment; nothing to compress; bigger than uncompressed | never segment by a high-cardinality id; that's an orderby/chunk-skipping job |
| `orderby` not `time DESC` without reason | time column's delta-of-delta no longer near-zero; worse ratio + worse "latest N" | default to `time DESC`; add secondary keys only if range-queried |
| Same column in both `segmentby` and `orderby` | it's constant within a segment; wasted metadata | pick one role |
| Expecting "98%" | it's a ceiling on redundant data, not a forecast | plan ~10×; measure your data |
| Quoting `hypertable_compression_stats()` | deprecated since 2.18.0 | use `hypertable_columnstore_stats()` |
| Trusting a stat right after compression | `*_stats` can be stale/incorrect pre-recompress | recompress + re-read, or use `chunks_detailed_size()` |
| Heavy `UPDATE`/`UPSERT` on cold compressed data | decompress-modify-recompress churn | keep mutable data in rowstore; tune policy `after`; rely on 2.27 bloom pruning only for selective cold fixes |
| Changing `segmentby`/`orderby` and expecting old chunks to follow | settings are forward-looking, not migrations | `convert_to_rowstore` → `convert_to_columnstore` (or recompress) affected chunks |
| `enable_chunk_skipping` after compressing | ranges only populate for chunks compressed *after* enabling | enable before first compression, or recompress |
| RLS-based access on columnstore chunks | "ROW LEVEL SECURITY is not supported on chunks in the columnstore" | enforce authz in the app/query layer, not RLS, for compressed data |

---

## 11. Confidence & open items

- **High confidence** (primary docs + source README, cross-checked): the two DDL forms and their
  parameters; the encoder→type map; the batch/metadata layout (1000-row batches, `_ts_meta_*`); the
  segmentby cardinality band; chunk-skipping signature/types/timing; the 2.27 bloom/vectorization
  numbers; the deprecation of `hypertable_compression_stats()`.
- **Medium confidence:** exact internal column names like `_ts_meta_v2_*` (DeepWiki-sourced, an
  AI-generated wiki over the repo — directionally right, verify against your installed version's
  `\d+ <compressed_chunk>` if you depend on the literal name). The "default batch size = 1000" GUC
  name (`ts_guc_compression_batch_size_limit` / `timescaledb.compression_batch_size_limit`) — confirm
  against `SHOW` on your build before relying on it.
- **Calibration, not a guarantee:** the 42.8× and 88% and "8–20× typical" figures are
  dataset-specific; the *only* number that counts is the one you measure on your own data (§6.4).
- **Always pin version.** Encoder set, stat-view names, and the mutation fast-paths have all evolved
  across minor releases. Re-confirm any version-specific claim against
  `SELECT extversion FROM pg_extension WHERE extname='timescaledb';`.

### Primary sources (read these first)

- Hypercore reference — https://www.tigerdata.com/docs/reference/timescaledb/hypercore
- ALTER TABLE (Compression) API — https://www.tigerdata.com/docs/api/latest/compression/alter_table_compression/
  (→ https://github.com/timescale/docs/blob/latest/api/compression/alter_table_compression.md)
- Basic compression how-to — https://www.tigerdata.com/docs/build/how-to/basic-compression
- Compression methods (type→encoder) — https://github.com/timescale/docs/blob/latest/use-timescale/hypercore/compression-methods.md
- Time-series compression algorithms, explained — https://www.tigerdata.com/blog/time-series-compression-algorithms-explained
- TimescaleDB source, compression README — https://github.com/timescale/timescaledb/blob/main/tsl/src/compression/README.md
- TimescaleDB 2.27 release blog — https://www.tigerdata.com/blog/timescaledb-2-27
- `enable_chunk_skipping()` — https://www.tigerdata.com/docs/api/latest/hypertable/enable_chunk_skipping
- `compression_settings` view — https://github.com/timescale/docs/blob/latest/api/informational-views/compression_settings.md
- `hypertable_columnstore_stats()` — https://www.tigerdata.com/docs/reference/timescaledb/hypercore/hypertable_columnstore_stats
- DeepWiki: Enabling and Configuring Compression — https://deepwiki.com/timescale/timescaledb/3.1-enabling-and-configuring-compression
- Practitioner calibration (42.8×) — https://roszigit.com/en/blog/timescaledb-compression-hypercore/
- Practitioner calibration (150→15 GB) — https://dev.to/polliog/timescaledb-compression-from-150gb-to-15gb-90-reduction-real-production-data-bnj
