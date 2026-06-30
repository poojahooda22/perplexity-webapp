# Pattern: High-Throughput Ingestion & Correct Upserts in TimescaleDB

> **Layer:** `patterns-*` (concrete build recipe).
> **Product line:** JPM-Markets re-engineering **data-analytics** product line — the data foundation
> for the Athena/DataQuery/Fusion-class market-data platform. **NOT Lumina.** Lumina is a separate
> repo that happens to be the filesystem home for this research; do not wire any of this into Lumina's
> app code.
> **Stack assumption:** Python 3.12 + FastAPI for the request path, a separate **ingestion worker**
> (long-lived process / cron, NOT a serverless request) writing into **TimescaleDB ≥ 2.16**
> (Postgres 16/17) via **asyncpg** and/or **psycopg 3**.
>
> **What this doc answers.** How do you get market ticks, bars, fundamentals, and reference data into
> a hypertable *fast*, *correctly*, and *idempotently* — so a retried batch never double-writes, a
> late-arriving correction updates the right row, and ingestion never silently touches compressed
> historical data and tanks. It is the operational counterpart to `theory-columnstore-compression.md`
> (what compression is) and `theory-hypertables-chunking.md` (what chunks are).

---

## 0. The on-ramp (plain language, then the rest is dense)

You are pumping numbers into a database that physically stores recent data one way (row-by-row, fast to
write) and old data another way (squeezed into columnar "batches," slow to write but cheap to store).
Three things go wrong if you are naive:

1. **You insert one row per network round-trip.** A market feed does 100k+ ticks/second; one-row
   `INSERT`s top out around 5–10k rows/s and you fall permanently behind. Fix: **batch**, and for bulk
   loads use the **COPY protocol** (50–100× faster than single-row inserts).
2. **You re-run a batch after a crash and double-count.** Time-series corrections (a vendor restates
   a print, a bar is revised) and at-least-once feeds mean the *same* `(symbol, time)` arrives twice.
   Fix: a **unique key per `(series, time)`** plus `INSERT … ON CONFLICT DO UPDATE`, so a retry is a
   no-op-or-overwrite, never a duplicate.
3. **A correction lands on data old enough to be compressed.** Writing into a compressed chunk used to
   force a full decompress-modify-recompress, which can be 300–400× slower and lock the chunk. Fix:
   keep the **uncompressed hot window wide enough that normal ingest never touches compressed data**,
   and treat true backfill-into-history as a *deliberate, scheduled* operation — never something a live
   request triggers.

The rest of this doc is the exact mechanism, the numbers, and runnable Python.

---

## 1. The throughput ladder: row-at-a-time vs batched INSERT vs COPY

There are three ways to put rows in, separated by **orders of magnitude**. Pick by job, not by habit.

| Method | How it works | Throughput (single process, modern HW) | Use it for |
|---|---|---|---|
| **Row-at-a-time `INSERT`** | One `INSERT … VALUES (…)` per row, one round-trip each | ~thousands of rows/s; dominated by network RTT + parse | **Never** for a feed. Only one-off admin writes. |
| **Batched multi-row `INSERT`** | `INSERT … VALUES (…),(…),… ` — hundreds–thousands of rows per statement | ~50× single-row at batch=50; climbs to a plateau ~5,000 rows | Live streaming feeds where you also need `ON CONFLICT` |
| **`COPY … FROM STDIN`** | Binary/CSV stream, **bypasses the SQL parser**, writes near-directly to heap pages | **50–100× single-row**; Timescale cites **~1–2M rows/s** batch ingest on a 16-core server (2.26) | Bulk loads, ETL, migrations, backfill staging |

**The batching curve is measured, and it plateaus.** Benchmarked against a 1-day-chunk hypertable,
"even modest batching (50 rows) delivers a 5x improvement," and "larger batches continue to improve
throughput up to about 5,000 rows, after which diminishing returns set in." The recommended sweet spot:
"The optimal batch size for most workloads falls between 500 and 5,000 rows… A 1,000-row batch is a
sensible default."
([dev.to — INSERT Performance Tuning for TimescaleDB](https://dev.to/philip_mcclarence_2ef9475/insert-performance-tuning-for-timescaledb-4m7h),
cross-confirmed by [oneuptime — High-Ingestion Workloads](https://oneuptime.com/blog/post/2026-02-02-timescaledb-high-ingestion/view):
"batching 1000-5000 rows per statement"). **Going above ~5,000 actively hurts**: "Above 5,000, returns
diminish and you begin competing with autovacuum for buffer pool resources."

**Why COPY is in a different league.** "COPY bypasses the SQL parser entirely — the client streams raw
tuples in binary or CSV format, and PostgreSQL writes them directly to heap pages with minimal per-row
overhead. In production, COPY consistently delivers 50-100x the throughput of single-row inserts."
([dev.to, ibid.](https://dev.to/philip_mcclarence_2ef9475/insert-performance-tuning-for-timescaledb-4m7h)).
oneuptime puts the absolute figure at "100,000+ rows per second on modern hardware" for a single COPY
stream ([oneuptime](https://oneuptime.com/blog/post/2026-02-02-timescaledb-high-ingestion/view)), and
Timescale's own tuning guidance frames the *per-process* target as "ingesting 50-100k rows per second
per ingest process" — above that, **add processes, don't grow the batch**
([TigerData — Optimize Your Ingest Rate](https://www.tigerdata.com/blog/timescale-cloud-tips-how-to-optimize-your-ingest-rate)).

> **Order-of-magnitude anchor for this product line.** A US equities consolidated tape peaks around
> 100k–300k messages/second; options (OPRA) can exceed tens of millions/second at the open. A single
> COPY stream (~100k rows/s) covers an equities tape with headroom. OPRA-scale needs **fan-out**:
> N parallel COPY workers partitioned by symbol-range, or Direct Compress (§7). Name the tier
> explicitly in the design doc — this is the R-SCALE discipline.

### 1.1 The decision rule (memorize this)

```
Need ON CONFLICT semantics (idempotent upsert)?  ── yes ─▶ COPY → staging temp table → INSERT … ON CONFLICT   (§4)
                                                  └─ no ──▶ append-only, no dup risk?
                                                              ├─ yes ─▶ raw COPY straight into the hypertable      (§3)
                                                              └─ no ──▶ batched multi-row INSERT … ON CONFLICT      (§5)
```

COPY has **no `ON CONFLICT` clause** — this is a hard PostgreSQL limitation, not a TimescaleDB one
(see §4). So any path that needs conflict handling routes COPY through a staging table first.

---

## 2. Prerequisite: the unique key that makes upserts and idempotency possible

Everything downstream (idempotency, dedupe, corrections) rests on **one unique constraint** per
hypertable. Get it wrong and you cannot upsert at all.

**The hypertable rule:** "Unique constraints must include all partitioning columns. That means unique
constraints on a hypertable must include the time column."
([TigerData docs — Upsert data](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)).
You **cannot** create a unique index on `(symbol)` alone on a time-partitioned hypertable; the time
column must be part of it. If you also space-partition by, say, `venue`, the unique key must include
`venue` too.

```sql
-- OHLCV bars: one row per (symbol, bar timestamp). The natural identity is (symbol, time).
CREATE TABLE bars_1m (
    time     TIMESTAMPTZ      NOT NULL,
    symbol   TEXT             NOT NULL,
    open     DOUBLE PRECISION,
    high     DOUBLE PRECISION,
    low      DOUBLE PRECISION,
    close    DOUBLE PRECISION,
    volume   BIGINT,
    -- the unique key MUST include the partitioning (time) column:
    UNIQUE (symbol, time)
);

SELECT create_hypertable('bars_1m', by_range('time', INTERVAL '1 day'));
```

Column **order** in the constraint matters for the index it builds. `UNIQUE (symbol, time)` builds a
B-tree on `(symbol, time)` — good for "all bars for AAPL in a range." `UNIQUE (time, symbol)` is better
for "everything in this minute across symbols." For a per-symbol corrections feed, lead with `symbol`.

**The `ON CONFLICT` target must be column-listed, not constraint-named on a hypertable.** "TimescaleDB
does not yet support using `ON CONFLICT ON CONSTRAINT` with a named key… so you need to specify the
columns explicitly rather than using constraint names"
([WebSearch synthesis of TigerData upsert docs](https://docs.timescale.com/use-timescale/latest/write-data/upsert/);
root cause tracked in [timescaledb#1094](https://github.com/timescale/timescaledb/issues/1094) — Hasura
compatibility break). So write `ON CONFLICT (symbol, time)`, never
`ON CONFLICT ON CONSTRAINT bars_1m_symbol_time_key`.

```sql
-- ✅ works on a hypertable
INSERT INTO bars_1m VALUES (…) ON CONFLICT (symbol, time) DO UPDATE SET …;
-- ❌ NOT supported on a hypertable — raises an error
INSERT INTO bars_1m VALUES (…) ON CONFLICT ON CONSTRAINT bars_1m_symbol_time_key DO UPDATE SET …;
```

---

## 3. Raw COPY straight into the hypertable (append-only, no dup risk)

If the source is *exactly-once* (you control the producer, sequence numbers are gap-checked, no
re-delivery) and the table is append-only, COPY directly into the hypertable. This is the fastest path
and the cleanest code.

### 3.1 asyncpg — `copy_records_to_table`

asyncpg's bulk-load method is `Connection.copy_records_to_table`. The verified current signature
([asyncpg API reference](https://magicstack.github.io/asyncpg/current/api/index.html)):

```python
async copy_records_to_table(table_name, *, records, columns=None,
                            schema_name=None, timeout=None, where=None)
```

- `records` — "an iterable of row tuples," and crucially **"Asynchronous record iterables are also
  supported"** — so you can stream straight off an async queue without materializing the whole batch.
- `columns` — explicit column list (always pass it; don't rely on table column order).
- `where` — server-side filter, PostgreSQL 12+ (rarely needed for ingest).
- Returns the COPY status string, e.g. `'COPY 140000'`.

```python
# ingestion_worker/copy_ingest.py  — append-only direct COPY
import asyncpg
from datetime import datetime

async def copy_bars(pool: asyncpg.Pool, rows: list[tuple]) -> int:
    """
    rows: list of (time, symbol, open, high, low, close, volume) tuples.
    Returns the number of rows COPYed. Use ONLY when rows cannot collide.
    """
    async with pool.acquire() as conn:
        status = await conn.copy_records_to_table(
            "bars_1m",
            records=rows,
            columns=["time", "symbol", "open", "high", "low", "close", "volume"],
            timeout=30.0,
        )
    # status == "COPY 5000"
    return int(status.split()[1])
```

Datatypes must already be Python-native (`datetime` for `timestamptz`, `int` for `bigint`, etc.) —
asyncpg uses the **binary** COPY protocol and binds by type, so a stringified timestamp will error.
This is a feature: no per-row text parsing on the server.

**The trap that motivates §4.** asyncpg's COPY is all-or-nothing on conflicts. From the maintainer
thread: "when this happens `copy_records_to_table` 'abandons' the rest of the non-violating rows" on a
unique violation — there is **no way to make `copy_records_to_table` ignore unique violations**
([MagicStack/asyncpg#749](https://github.com/MagicStack/asyncpg/issues/749)). The recommended fix in
that thread is exactly the staging pattern of §4: COPY into a scratch table, then `INSERT … ON
CONFLICT`. So **if your feed can ever re-deliver, do not COPY into the hypertable directly.**

### 3.2 psycopg 3 — the COPY context manager

psycopg 3's COPY is a context manager you `write_row` into; it speaks the same COPY-FROM-STDIN protocol.

```python
# ingestion_worker/copy_ingest_psycopg.py
import psycopg

def copy_bars_psycopg(conn: psycopg.Connection, rows: list[tuple]) -> None:
    with conn.cursor() as cur:
        with cur.copy(
            "COPY bars_1m (time, symbol, open, high, low, close, volume) FROM STDIN"
        ) as copy:
            for r in rows:
                copy.write_row(r)
    conn.commit()
```

For maximum speed add `WITH (FORMAT BINARY)` and call `copy.set_types([...])` so psycopg binds binary
without round-tripping through text. Use the text default for first cut; switch to binary only after
profiling shows serialization is the bottleneck.
([psycopg 3 COPY docs](https://www.psycopg.org/psycopg3/docs/basic/copy.html) — `cursor.copy()`,
`copy.write_row()`, `set_types`.)

> **Library choice for this product line:** prefer **asyncpg** in the FastAPI/async worker — it is the
> faster driver and its async-iterable COPY composes with an async feed queue. Keep **psycopg 3** for
> sync ETL scripts / migrations and for cases needing libpq features asyncpg omits (e.g. easy binary
> COPY with declared types). Do not mix both on the same connection.

---

## 4. The canonical idempotent recipe: COPY → staging → `INSERT … ON CONFLICT`

This is the **default** ingest path for any feed that can re-deliver, restate, or be retried — which is
nearly every real market-data feed. It combines COPY's speed with `ON CONFLICT`'s correctness.

**Why two steps.** "COPY doesn't support `ON CONFLICT` clauses directly," so the documented best
practice is a staging table: "This two-step approach combines the speed of COPY for bulk loading with
the flexibility of `INSERT...ON CONFLICT` for upsert logic. For large datasets, this is much faster than
using `INSERT...ON CONFLICT` directly."
([TigerData docs — Upsert data](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)).

### 4.1 The SQL, exactly

```sql
-- 1. staging table shaped like the target (TEMP = auto-dropped at session/txn end)
CREATE TEMP TABLE bars_1m_staging (LIKE bars_1m INCLUDING DEFAULTS)
    ON COMMIT DROP;                       -- gone when this txn commits

-- 2. fast bulk load — no constraint checking, no index maintenance on a plain temp table
COPY bars_1m_staging (time, symbol, open, high, low, close, volume) FROM STDIN;

-- 3. merge into the hypertable with conflict resolution
INSERT INTO bars_1m (time, symbol, open, high, low, close, volume)
SELECT time, symbol, open, high, low, close, volume
FROM bars_1m_staging
ON CONFLICT (symbol, time) DO UPDATE
    SET open   = EXCLUDED.open,
        high   = EXCLUDED.high,
        low    = EXCLUDED.low,
        close  = EXCLUDED.close,
        volume = EXCLUDED.volume;
-- (TEMP table auto-dropped on commit; otherwise DROP TABLE bars_1m_staging;)
```

`EXCLUDED.<col>` is the proposed (incoming) row's value; this is standard PostgreSQL upsert. Matched
on `(symbol, time)`, an existing bar gets overwritten with the latest values — exactly what a vendor
*correction* should do. (Docs example, adapted from the `conditions(time, location, …)` sample.)

**Dedupe inside the batch first.** If the *same* `(symbol, time)` appears twice **within one COPY
batch**, PostgreSQL raises `ON CONFLICT DO UPDATE command cannot affect row a second time`. Collapse
duplicates in the SELECT before the upsert:

```sql
INSERT INTO bars_1m (time, symbol, open, high, low, close, volume)
SELECT DISTINCT ON (symbol, time)
       time, symbol, open, high, low, close, volume
FROM bars_1m_staging
ORDER BY symbol, time, /* tiebreaker: keep the latest */ ingest_seq DESC
ON CONFLICT (symbol, time) DO UPDATE SET … ;
```

Add an `ingest_seq`/arrival-order column to the staging table so `DISTINCT ON` keeps the *last* version,
not an arbitrary one.

### 4.2 The full asyncpg recipe (one transaction, idempotent, retry-safe)

```python
# ingestion_worker/upsert_ingest.py
import asyncpg

STAGING_DDL = """
CREATE TEMP TABLE bars_1m_staging (LIKE bars_1m INCLUDING DEFAULTS)
ON COMMIT DROP
"""

MERGE_SQL = """
INSERT INTO bars_1m (time, symbol, open, high, low, close, volume)
SELECT DISTINCT ON (symbol, time)
       time, symbol, open, high, low, close, volume
FROM bars_1m_staging
ORDER BY symbol, time
ON CONFLICT (symbol, time) DO UPDATE
SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
    close=EXCLUDED.close, volume=EXCLUDED.volume
"""

async def upsert_bars(pool: asyncpg.Pool, rows: list[tuple]) -> int:
    """
    Idempotent upsert of OHLCV bars. Safe to retry: a re-run of the SAME rows
    produces the SAME table state (no duplicates, last-write-wins on corrections).
    """
    if not rows:
        return 0
    async with pool.acquire() as conn:
        # one transaction: staging table + COPY + merge all commit together,
        # or all roll back. A crash mid-way leaves the hypertable untouched.
        async with conn.transaction():
            await conn.execute(STAGING_DDL)
            await conn.copy_records_to_table(
                "bars_1m_staging",
                records=rows,
                columns=["time", "symbol", "open", "high", "low", "close", "volume"],
                timeout=30.0,
            )
            status = await conn.execute(MERGE_SQL)   # "INSERT 0 4998"
    return int(status.split()[-1])
```

**Why this is idempotent.** Re-running the identical batch: COPY refills the (fresh) staging table,
the merge re-matches every `(symbol, time)`, and `DO UPDATE` rewrites the same values → the hypertable
is byte-identical to before. A retry after a partial crash is therefore *safe by construction* — there
is no "did it commit or not?" ambiguity because the whole staging+merge is one atomic transaction
(non-negotiable: **a retried/double-delivered batch must not double-write**).

**Cost note.** The staging table is created and dropped **per batch**. For a 1,000-row batch at 1Hz
this is cheap; for very high frequency, reuse a **session-scoped** staging table (`CREATE TEMP TABLE …`
once, `TRUNCATE` between batches) to avoid catalog churn — but then you cannot use `ON COMMIT DROP` and
must manage cleanup yourself.

### 4.3 `DO UPDATE` vs `DO NOTHING` — pick by feed semantics

| Clause | On conflict it… | Use when |
|---|---|---|
| `ON CONFLICT (k) DO UPDATE SET …` | overwrites the existing row with incoming values | **Corrections/restatements** matter (vendor revises a print/bar). Last-write-wins. |
| `ON CONFLICT (k) DO NOTHING` | silently keeps the existing row, drops the incoming one | **First-write-wins** / pure dedupe (an at-least-once feed where the *first* delivery is authoritative and re-deliveries are exact duplicates). |

`DO NOTHING` "is useful to prevent the entire transaction from failing when writing many rows as one
batch" ([TigerData docs](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)) — and
it is **cheaper on compressed data** (see §6: a no-op conflict can be pruned without decompression; a
`DO UPDATE` may still need to write). If your feed never restates and you only fear duplicates, prefer
`DO NOTHING`.

---

## 5. Batched multi-row `INSERT … ON CONFLICT` (the streaming-feed path)

When you need conflict handling on a *continuous* low-to-mid-rate stream and the per-batch staging-table
overhead isn't worth it, use a parameterized multi-row `INSERT … ON CONFLICT`. asyncpg's `executemany`
pipelines, but a single multi-row statement with `unnest` is usually fastest and still idempotent:

```python
async def upsert_bars_multirow(pool: asyncpg.Pool, rows: list[tuple]) -> None:
    # unnest() turns 7 arrays into rows server-side: one statement, one round-trip.
    sql = """
    INSERT INTO bars_1m (time, symbol, open, high, low, close, volume)
    SELECT * FROM unnest(
        $1::timestamptz[], $2::text[], $3::float8[], $4::float8[],
        $5::float8[], $6::float8[], $7::bigint[])
    ON CONFLICT (symbol, time) DO UPDATE
    SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
        close=EXCLUDED.close, volume=EXCLUDED.volume
    """
    cols = list(zip(*rows))  # transpose rows→columns
    async with pool.acquire() as conn:
        await conn.execute(sql, *cols)
```

Keep batches in the 500–5,000 range (§1). For >50–100k rows/s, this path won't keep up — graduate to the
COPY-staging recipe of §4 or fan out across processes.

---

## 6. The compressed-chunk hazard — and how to keep ingest off it entirely

This is the single most important operational rule in this doc. **Upserts (and any write) into a
*compressed* chunk are vastly more expensive than into an uncompressed one, because the engine must
locate and decompress the affected columnar batch before Postgres can apply the conflict logic.**

### 6.1 What actually happens, and the historical cost

For a conflicting row, "TimescaleDB must first decompress the rows that may be conflicting with the row
being inserted," then PostgreSQL's standard speculative `ON CONFLICT` insertion runs
([TigerData — 300x Faster Upserts](https://www.tigerdata.com/blog/how-we-made-postgresql-upserts-300x-faster-on-compressed-data)).
Before the 2.16 optimization this was catastrophic: a flame graph showed `decompress_batches_for_insert`
consuming **>99% CPU**, and upserting 10,000 rows with only 10 conflicts took **427,580 ms (>7 minutes)
on v2.14.2**, versus **1,149 ms on v2.16 — a ~300× speedup** (ibid.).

### 6.2 The 2.x optimizations (know the version you're on)

| Version | Optimization | Mechanism | Measured |
|---|---|---|---|
| **2.16** | **Segmentby index reuse** for upsert conflict-finding | When chunks are compressed with `segmentby`, "a B-tree index is automatically created on the `segmentby` columns and the batch sequence number." Old code did a sequential scan; 2.16 uses that index to "quickly locate the relevant compressed batches." | **~300×** on the high-cardinality benchmark above (427,580 ms → 1,149 ms, v2.14.2 → v2.16). ([TigerData blog](https://www.tigerdata.com/blog/how-we-made-postgresql-upserts-300x-faster-on-compressed-data)) |
| **(bloom sparse indexes, pre-2.27)** | **Sparse bloom index pruning on conflict columns** | "When your hypertable has bloom sparse indexes on the conflict columns, TimescaleDB skips columnstore batches that can't contain the conflict values." | "more than 2× faster on large columnstore datasets" ([TigerData upsert docs](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)) |
| **2.27** (2026-05-12 release; blog 2026-06-09) | **Composite bloom-filter pruning extended into the write path** for UPSERT/UPDATE/DELETE | "blooms filters can now prune compressed batches before decompression." For UPSERT, "When the values being checked for a conflict cannot be present in a compressed batch, TimescaleDB can eliminate that batch immediately without decompression." Multi-column conflict keys use **composite** filters; "the most selective is chosen automatically." | **Up to 160× more efficient UPDATE/DELETE** on compressed data; a benchmark query "dropped from 820ms to 4.4ms." ([TigerData — 2.27](https://www.tigerdata.com/blog/timescaledb-2-27), [release 2.27.0](https://github.com/timescale/timescaledb/releases/tag/2.27.0)) |

> **The "~32×" figure to keep straight.** The headline upsert win is **~300×** (sequential-scan → index
> reuse, 2.16). Bloom pruning adds another **>2×** (pre-2.27 sparse) and up to **160×** on UPDATE/DELETE
> (2.27 composite). If a spec cites "~32× upsert speedup," it is referring to a sub-case (e.g. a
> moderate-cardinality slice) of the same 2.16 index-reuse work — the *load-bearing* claim to cite is the
> measured **427,580 ms → 1,149 ms (≈300×)** primary number, which is unambiguous.

**2.27 caveat that bites in practice.** Bloom filters "apply only to newly compressed data. Existing
chunks require recompression to benefit"
([2.27 blog](https://www.tigerdata.com/blog/timescaledb-2-27)). So upgrading the binary does **not**
retroactively speed up writes against already-compressed history — you must `recompress_chunk` (or wait
for the policy to recompress) for old chunks to gain the filters.

**Observe it with EXPLAIN.** 2.27 added four counters — *Batches checked by bloom*, *Batches pruned by
bloom*, *Batches without bloom*, *Bloom false positives* — to `EXPLAIN (ANALYZE)` on UPSERT/UPDATE/DELETE
([2.27 blog](https://www.tigerdata.com/blog/timescaledb-2-27)). In a perf review, *pruned ÷ checked*
should be high and *without bloom* should be ~0 (else recompress to gain filters).

### 6.3 The design rule: keep the hot/uncompressed window wider than normal ingest reach

Even at 300×, writing into compressed data is far slower than into the row-store, and it generates
write amplification (decompress → modify → recompress). **The fix is not "make compressed writes fast";
it is "arrange that normal ingest never touches compressed chunks at all."**

```sql
-- Compress chunks only AFTER they fall outside the window where corrections/late data still arrive.
ALTER TABLE bars_1m SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'symbol',     -- conflict/filter column → enables 2.16 index reuse
    timescaledb.compress_orderby   = 'time DESC'
);

-- The lever: compress_after must be > your maximum normal data lateness.
SELECT add_compression_policy('bars_1m', compress_after => INTERVAL '14 days');
```

**Sizing the window (the actual engineering decision):**

1. Measure the **lateness distribution** of each feed: how old is the *oldest* row a healthy live feed
   ever writes? Vendor corrections for equities bars typically arrive same-day to a few days late;
   end-of-day reference/fundamentals can restate weeks later.
2. Set `compress_after` **comfortably beyond the p99.9 lateness** of the feeds that write that table.
   If equities corrections can be 7 days late, `compress_after => INTERVAL '14 days'` keeps a 2× safety
   margin so a routine correction lands on an *uncompressed* chunk — a cheap row-store upsert, never a
   decompress.
3. **Separate hot and historical tables when lateness profiles differ wildly.** Tick data that is never
   corrected can compress after 1 day; a fundamentals table that restates for weeks should compress
   after 30+ days. Don't force one `compress_after` onto feeds with different correction tails.

> **`segmentby` = your conflict column.** Compressing with
> `compress_segmentby = 'symbol'` is what makes the 2.16 B-tree-on-segmentby index-reuse work for
> `ON CONFLICT (symbol, time)`. If you set `compress_orderby = 'time'` only and leave `segmentby`
> empty, conflict-finding falls back to scanning. **Always segment by the leading conflict/filter
> column.** ([TigerData blog](https://www.tigerdata.com/blog/how-we-made-postgresql-upserts-300x-faster-on-compressed-data),
> [docs](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)).

### 6.4 Operational guard: detect a write that crossed into compressed territory

If a misbehaving feed starts writing old timestamps, you want to *alarm*, not silently melt. A cheap
guard: in the staging→merge step, reject (to dead-letter) any row older than the hot window before it
ever reaches the hypertable.

```sql
-- in the merge, route would-be compressed-chunk writes aside instead of paying the decompress cost
WITH fresh AS (
    SELECT * FROM bars_1m_staging
    WHERE time >= now() - INTERVAL '14 days'   -- inside the uncompressed window
)
INSERT INTO bars_1m SELECT * FROM fresh
ON CONFLICT (symbol, time) DO UPDATE SET … ;
-- rows older than 14 days went nowhere → handle them via the deliberate backfill path (§8), not live ingest
```

---

## 7. Direct Compress (tech preview) — when you *want* ingest to land already-compressed

For pure bulk-load of historical or append-only data, **Direct Compress** (a.k.a. Direct-to-Columnstore)
compresses **during ingestion, in memory**, so COPY produces compressed chunks directly — no separate
compress job. Introduced as a **tech preview in TimescaleDB 2.21**, COPY-only at first; later releases
add INSERT support.
([TigerData — Introducing Direct Compress](https://www.tigerdata.com/blog/introducing-direct-compress-up-to-40x-faster-leaner-data-ingestion-for-developers-tech-preview)).

**Throughput (measured, narrow tables):** "up to 40x faster" overall; **148.8M tuples/s** for a
single-column integer table at 10k internal batch; **66M tuples/s** for timestamp + 2 integers. The 2.21
release frames Direct-to-Columnstore as enabling "sustained rates over 5M records per second with bursts
up to 100M records per second in tests"
([TigerData 2.21](https://www.tigerdata.com/blog/speed-without-sacrifice-37x-faster-high-performance-ingestion-42x-faster-deletes-improved-cagg-updates-timescaledb-2-21)).

**Enable it (GUCs — verified names):**

```sql
SET timescaledb.enable_direct_compress_copy = on;                 -- default off; core feature for COPY
SET timescaledb.enable_direct_compress_copy_sort_batches = on;    -- default on;  per-batch sort before write
-- SET timescaledb.enable_direct_compress_copy_client_sorted = on; -- default off; ⚠️ DANGER: asserts data is globally sorted
```
([TigerData blog](https://www.tigerdata.com/blog/introducing-direct-compress-up-to-40x-faster-leaner-data-ingestion-for-developers-tech-preview)).

**Hard constraints (why it is NOT the default ingest path).** Direct Compress **cannot** be used if the
hypertable has **unique constraints, triggers, or continuous aggregates** (ibid.). Our idempotent design
**requires** a unique key (§2), so Direct Compress is **incompatible with the upsert recipe** — you
cannot have both `ON CONFLICT` and Direct Compress on the same table. It also "can regress query
performance or storage ratio if the ingested rows are not sorted by the table's orderby columns or if
the data has very high cardinality."

**Where it fits this product line:** a **one-time historical backfill** of an append-only,
correction-free archive (e.g. ingesting years of vendor EOD bars into a fresh, constraint-free staging
hypertable, then attaching/merging) — not the live corrections feed. Keep it on the backfill path (§8),
gated behind the tech-preview caveats, and re-verify the GUC names against the installed version's docs
before relying on them.

---

## 8. Backfill into history — the deliberate, scheduled operation

"Backfill" = writing rows whose timestamp "already corresponds to a compressed chunk"
([decompress/backfill docs](https://docs.tigerdata.com/use-timescale/latest/compression/decompress-chunks/)).
This is **not** live ingest; it is a maintenance job. Two routes:

### 8.1 Classic decompress → insert → recompress

The documented four-step workflow: "Temporarily turn off any compression policy, Decompress chunks that
will be affected by modifications or backfill, [insert], Re-enable compression policy (which will
recompress the recently-decompressed chunks)"
([decompress-chunks docs](https://docs.tigerdata.com/use-timescale/latest/compression/decompress-chunks/)).
TimescaleDB ships a `decompress_backfill` helper in `timescaledb_extras` that "halts the compression
policy, identifies the compressed chunks that the backfilled data corresponds to, decompresses the
chunks, inserts data from the backfill table into the main hypertable, and then re-enables the
compression policy."

```sql
-- 1. pause the policy so it doesn't recompress under you
SELECT alter_job(j.job_id, scheduled => false)
FROM timescaledb_information.jobs j
WHERE j.proc_name = 'policy_compression' AND j.hypertable_name = 'bars_1m';

-- 2. decompress exactly the chunks the backfill touches (scope by time range)
SELECT decompress_chunk(c)
FROM show_chunks('bars_1m', older_than => INTERVAL '14 days',
                            newer_than => INTERVAL '30 days') c;

-- 3. COPY → staging → INSERT … ON CONFLICT  (the §4 recipe) into the now-uncompressed chunks

-- 4. recompress (procedure since 2.6.0) and re-enable the policy
CALL recompress_chunk( … );      -- or just re-enable the policy and let the next scheduled job do it
SELECT alter_job(j.job_id, scheduled => true) FROM … ;
```

`recompress_chunk` is a **procedure** since 2.6.0 and "the database automatically recompresses your
chunks in the next scheduled job"
([WebSearch synthesis of TigerData compression docs](https://docs.timescale.com/api/latest/compression/recompress_chunk/)).
Note this whole dance is necessary because, historically, "TimescaleDB does not support inserts or
updates into compressed chunks" without first decompressing — the 2.16/2.27 work makes the *write into
a recompressed/segmented chunk* fast, but the decompress-modify-recompress shape remains the safe
batch-backfill model.

### 8.2 When to prefer which

| Situation | Use |
|---|---|
| A few late corrections, timestamps inside the hot window | Nothing special — the §4 upsert lands on an uncompressed chunk |
| Late corrections that fall on compressed chunks | §8.1 decompress→upsert→recompress, scoped to the affected chunks, **run off-hours** |
| One-time huge historical load, append-only, no unique key needed | §7 Direct Compress into a constraint-free staging hypertable |
| Routine end-of-day restatements weeks late | Widen `compress_after` (§6.3) so they never hit compressed data in the first place |

---

## 9. Off-request-path discipline (mirror Lumina non-negotiable #4)

**Ingestion never runs on a serverless request or inside a web handler.** This is the same constraint as
Lumina's #4 ("Vercel can't hold sockets or timers — pollers go in `worker/`; scheduled work is an
external cron"), restated for this product line's Python/FastAPI stack:

- **Live feed consumers** (WebSocket/UDP multicast → TimescaleDB) are **long-lived worker processes**
  (systemd unit / container with a restart policy / Fly/ECS service), **not** FastAPI route handlers. A
  serverless function cannot hold a feed socket open or maintain a write batch across requests; it would
  be killed mid-batch and lose backpressure state.
- **Scheduled/heavy jobs** — nightly vendor-file ETL, compaction, the §8 backfill — run on an **external
  cron** (or `pg_cron` for in-DB jobs) hitting a secret-guarded admin route or, better, a dedicated job
  runner. Never on the request path.
- **Why it matters here specifically:** a bulk COPY or a decompress→recompress can run for minutes and
  hold locks. On a request path that is a guaranteed timeout/incident; in a worker with bounded
  concurrency it is routine. State the **ingest runtime** (which process, which schedule) and its
  **partial-failure behavior** in the design doc — that's the R-SCALE "heavy ingest lives off the
  request path" check.

FastAPI's role is the **read** side (serve the analytics API over the already-ingested data); the
worker owns the **write** side. Keep them in separate deployables so a write spike never starves reads
and a read spike never blocks ingest.

---

## 10. The async ingestion worker: pooling, batching, backpressure, dead-letter

A production feed worker is a small pipeline: **receive → buffer → flush-on-size-or-time → on-failure
retry/dead-letter**. Here is the shape, with the pieces that actually matter wired in.

### 10.1 Connection pooling

asyncpg's pool is the right primitive in-process; for many worker processes front the database with
**PgBouncer in transaction mode**. oneuptime's recommended PgBouncer baseline:
`max_client_conn = 1000`, `default_pool_size = 50`, `server_idle_timeout = 60`
([oneuptime](https://oneuptime.com/blog/post/2026-02-02-timescaledb-high-ingestion/view)).

> **Caveat with COPY + transaction-mode PgBouncer:** COPY and explicit transactions are fine in
> *transaction* mode, but **prepared statements** are not — asyncpg prepares by default. Either point
> the ingest worker's pool at a *session-mode* PgBouncer port (or directly at Postgres), or disable
> statement caching (`asyncpg.create_pool(..., statement_cache_size=0)`). Pick one and document it; this
> is a classic silent-breakage seam.

```python
pool = await asyncpg.create_pool(
    dsn=DSN,
    min_size=4, max_size=16,          # match to client CPUs; Timescale: server CPUs ≈ client CPUs
    statement_cache_size=0,           # required if behind transaction-mode PgBouncer
    command_timeout=60,
)
```

### 10.2 The flush loop: size- *and* time-bounded batching with backpressure

```python
# ingestion_worker/feed_worker.py
import asyncio, asyncpg, logging
from collections import deque

log = logging.getLogger("ingest")

BATCH_MAX   = 2_000          # rows; inside the 500–5,000 sweet spot (§1)
FLUSH_EVERY = 0.25           # seconds; bound latency even when the feed is slow
QUEUE_MAX   = 100_000        # backpressure ceiling: bounded memory, never unbounded growth

class FeedIngester:
    def __init__(self, pool: asyncpg.Pool, upsert_fn):
        self.pool = pool
        self.upsert_fn = upsert_fn                 # e.g. upsert_bars from §4.2
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self.dead_letter: deque = deque(maxlen=50_000)

    async def submit(self, row: tuple):
        # await on a full queue = BACKPRESSURE. The feed reader slows to DB speed
        # instead of OOM-ing. This is the single most important line for stability.
        await self.queue.put(row)

    async def run(self):
        buf: list[tuple] = []
        while True:
            try:
                # wait up to FLUSH_EVERY for the next row, then flush whatever we have
                row = await asyncio.wait_for(self.queue.get(), timeout=FLUSH_EVERY)
                buf.append(row)
                if len(buf) < BATCH_MAX:
                    continue
            except asyncio.TimeoutError:
                pass  # time-based flush
            if buf:
                await self._flush(buf)
                buf = []

    async def _flush(self, rows: list[tuple]):
        try:
            n = await self.upsert_fn(self.pool, rows)        # idempotent (§4) → retry-safe
            log.info("ingested %d rows", n)
        except (asyncpg.PostgresError, OSError) as e:
            await self._handle_failure(rows, e)

    async def _handle_failure(self, rows, exc):
        # Transient (deadlock, connection drop, timeout) → bounded retry. The upsert is
        # idempotent (§4), so a retry of a maybe-partially-applied batch is SAFE.
        for attempt in range(3):
            await asyncio.sleep(0.2 * (2 ** attempt))   # backoff; NOT a fix for a race (no setTimeout-hacks)
            try:
                await self.upsert_fn(self.pool, rows)
                return
            except (asyncpg.PostgresError, OSError):
                continue
        # Permanent (constraint logic error, poison row) → DEAD-LETTER, don't block the feed.
        log.error("dead-lettering %d rows: %s", len(rows), exc)
        self.dead_letter.extend(rows)                  # persist to a DLQ table/topic in prod
```

**Why each piece is load-bearing (not ceremony):**

- **Bounded `asyncio.Queue(maxsize=…)`** → `await queue.put()` blocks when full → the feed reader is
  *backpressured* to DB write speed. Unbounded buffering is the #1 way an ingest worker OOM-crashes
  during a market spike. (Matches the "backpressure handling" pattern oneuptime's `AsyncMetricsIngester`
  describes, [oneuptime](https://oneuptime.com/blog/post/2026-02-02-timescaledb-high-ingestion/view).)
- **Time *and* size flush** → low latency when slow, full batches when fast. Size-only starves at low
  rate; time-only never batches at high rate.
- **Idempotent upsert → safe retry** → the §4 recipe means a retried batch can't double-write, so the
  retry loop is correct, not a gamble.
- **Dead-letter for poison rows** → one malformed/constraint-violating batch must not wedge the whole
  feed. Route it aside (to a DLQ table or Kafka topic), alarm, and keep ingesting. In production the
  dead-letter is *durable* (a `bars_1m_deadletter` table or a Kafka DLQ topic with the raw payload +
  error), not an in-memory `deque` — the deque here is the shape, not the prod sink.

### 10.3 Partial-failure semantics — what is and isn't atomic

| Scope | Atomicity | Failure outcome |
|---|---|---|
| One COPY-staging-merge transaction (§4.2) | **All-or-nothing** | Crash mid-batch → hypertable unchanged → retry replays the whole batch cleanly (idempotent) |
| `copy_records_to_table` alone on a unique violation | **Abandons remaining rows** | Don't rely on it for dup-prone data — that's why staging exists (§3.1, [asyncpg#749](https://github.com/MagicStack/asyncpg/issues/749)) |
| `INSERT … ON CONFLICT DO NOTHING` over a batch | Per-row skip, statement succeeds | Conflicting rows dropped, rest inserted — the documented way to "prevent the entire transaction from failing when writing many rows as one batch" ([docs](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)) |
| A genuinely malformed row (bad type, null in NOT NULL) | Fails the whole statement | Dead-letter the batch; optionally bisect to isolate the poison row, re-ingest the clean remainder |

**Design rule:** make the **commit unit = the retry unit = an idempotent operation**. Then every
failure mode reduces to "retry the batch" or "dead-letter the batch," and you never have to answer the
unanswerable "did half of it land?"

---

## 11. Anti-patterns (mistake → fix), with the citation

| ❌ Anti-pattern | Why it breaks | ✅ Fix |
|---|---|---|
| Row-at-a-time `INSERT` for a feed | ~1000× slower than COPY; you fall behind permanently | Batch 500–5,000 rows; COPY for bulk ([dev.to](https://dev.to/philip_mcclarence_2ef9475/insert-performance-tuning-for-timescaledb-4m7h)) |
| Batches of 50,000+ rows "to go faster" | Past ~5,000, throughput plateaus and you fight autovacuum for buffers | Cap batch ~1,000–5,000; add **processes**, not rows ([dev.to](https://dev.to/philip_mcclarence_2ef9475/insert-performance-tuning-for-timescaledb-4m7h), [TigerData](https://www.tigerdata.com/blog/timescale-cloud-tips-how-to-optimize-your-ingest-rate)) |
| Expecting `COPY … ON CONFLICT` to work | COPY has **no** `ON CONFLICT` clause | COPY → staging temp table → `INSERT … ON CONFLICT` ([docs](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)) |
| Relying on `copy_records_to_table` to skip dups | It **abandons remaining rows** on a unique violation | Staging + `ON CONFLICT` ([asyncpg#749](https://github.com/MagicStack/asyncpg/issues/749)) |
| `ON CONFLICT ON CONSTRAINT my_key` on a hypertable | Not supported; raises an error | List columns: `ON CONFLICT (symbol, time)` ([timescaledb#1094](https://github.com/timescale/timescaledb/issues/1094)) |
| Unique index on `(symbol)` only | Hypertable unique keys must include the partition (time) column | `UNIQUE (symbol, time)` ([docs](https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert)) |
| `compress_after` set tighter than feed lateness | Routine corrections hit compressed chunks → 100s× slower writes, write amplification | Widen the hot window past p99.9 lateness (§6.3) |
| `compress_segmentby` empty while upserting on `symbol` | No segmentby B-tree → conflict-finding falls back to scan (loses the 2.16 300× win) | `compress_segmentby = '<leading conflict column>'` ([TigerData blog](https://www.tigerdata.com/blog/how-we-made-postgresql-upserts-300x-faster-on-compressed-data)) |
| Same `(symbol,time)` twice in one upsert batch | `ON CONFLICT … cannot affect row a second time` error | `SELECT DISTINCT ON (symbol, time) … ORDER BY … seq DESC` before the merge (§4.1) |
| Direct Compress on a table with a unique key | Incompatible — Direct Compress forbids unique constraints/triggers/CAggs | Use Direct Compress only on constraint-free append-only backfill (§7) |
| Live ingest in a FastAPI/serverless handler | Can't hold a feed socket or batch across requests; killed mid-flush | Long-lived worker process; cron for scheduled jobs (§9, Lumina #4) |
| Unbounded in-memory buffer | OOM crash on a market-open spike | Bounded `asyncio.Queue` → `await put()` backpressures the reader (§10.2) |
| `try/except: pass` around a flush | Silently loses data; a poison row wedges or drops the feed invisibly | Bounded retry for transient, **dead-letter** for permanent, **alarm** on DLQ growth (§10.2) |
| Assuming a 2.27 binary upgrade speeds writes on old chunks | Bloom filters apply only to **newly compressed** data | `recompress_chunk` old chunks to gain filters ([2.27 blog](https://www.tigerdata.com/blog/timescaledb-2-27)) |

---

## 12. Verification checklist (the grading rubric for an ingest path)

A reviewer signs off only when all of these are answered **in writing**:

1. **Method matches job?** Feed → batched (500–5k) or COPY-staging; bulk → COPY; never row-at-a-time. The
   stated throughput target vs. one-process ceiling (~50–100k rows/s) names whether fan-out is needed.
2. **Unique key correct?** `UNIQUE (<keys…>, time)` includes the time/partition column; `ON CONFLICT`
   lists columns (not a constraint name).
3. **Idempotent?** Re-running the identical batch yields the identical table state. The commit unit =
   the retry unit. `DO UPDATE` vs `DO NOTHING` matches the feed's restate semantics.
4. **Compressed-chunk safe?** `compress_after` > p99.9 feed lateness so normal ingest never touches
   compressed data; `compress_segmentby` = the leading conflict column; backfill-into-history is a
   *scheduled* decompress→upsert→recompress, not a live write.
5. **Off the request path?** Live consumer = long-lived worker; scheduled/heavy = cron. Not a FastAPI
   route, not serverless.
6. **Bounded + recoverable?** Bounded queue (backpressure), bounded retry for transient errors, durable
   dead-letter for poison batches, alarm on DLQ growth.
7. **Version-aware?** The doc names the TimescaleDB version (≥2.16 for the 300× upsert; 2.27 for write-path
   bloom pruning) and notes that old chunks need recompression to gain new filters.

If any answer is "we'll handle it later," the path is Tier-1 (demo) being shipped as Tier-3 — the exact
failure R-SCALE exists to catch.

---

## Sources (primary, read for this doc)

- **TimescaleDB upsert docs** — staging-table pattern, hypertable unique-key rule, `ON CONFLICT`
  examples, bloom sparse-index ">2× faster" note: https://www.tigerdata.com/docs/use-timescale/latest/write-data/upsert
- **"How We Made PostgreSQL Upserts 300x Faster on Compressed Data"** — segmentby index reuse, the
  427,580 ms → 1,149 ms (v2.14.2 → v2.16) benchmark, `decompress_batches_for_insert` >99% CPU flame
  graph: https://www.tigerdata.com/blog/how-we-made-postgresql-upserts-300x-faster-on-compressed-data
- **TimescaleDB 2.27 blog** — composite bloom-filter write-path pruning for UPSERT/UPDATE/DELETE, 160×,
  820 ms → 4.4 ms, new EXPLAIN counters, "newly compressed data only" caveat (release 2026-05-12, blog
  2026-06-09): https://www.tigerdata.com/blog/timescaledb-2-27 ·
  https://github.com/timescale/timescaledb/releases/tag/2.27.0
- **"Introducing Direct Compress" (tech preview, 2.21)** — GUC names
  (`enable_direct_compress_copy[_sort_batches][_client_sorted]`), 40×/148.8M-tps/66M-tps figures,
  no-unique-constraint/trigger/CAgg constraint, COPY-only:
  https://www.tigerdata.com/blog/introducing-direct-compress-up-to-40x-faster-leaner-data-ingestion-for-developers-tech-preview
- **TimescaleDB 2.21 blog** — 5M sustained / 100M burst rows/s with Direct-to-Columnstore:
  https://www.tigerdata.com/blog/speed-without-sacrifice-37x-faster-high-performance-ingestion-42x-faster-deletes-improved-cagg-updates-timescaledb-2-21
- **oneuptime — "Handle High-Ingestion Workloads in TimescaleDB"** — COPY 100k+ rows/s, batch 1000–5000,
  PgBouncer transaction-mode settings, AsyncMetricsIngester/backpressure shape, chunk-sizing 10–100M
  rows/chunk: https://oneuptime.com/blog/post/2026-02-02-timescaledb-high-ingestion/view
- **dev.to — "INSERT Performance Tuning for TimescaleDB"** — 50-row → 5× curve, ~5,000-row plateau,
  500–5,000 sweet spot, COPY 50–100× single-row:
  https://dev.to/philip_mcclarence_2ef9475/insert-performance-tuning-for-timescaledb-4m7h
- **TigerData — "Optimize Your PostgreSQL Ingest Rate"** — 50–100k rows/s per process, scale by process
  not batch, client/server CPU parity, same-region:
  https://www.tigerdata.com/blog/timescale-cloud-tips-how-to-optimize-your-ingest-rate
- **asyncpg API reference** — `copy_records_to_table` signature, async-iterable records, returns
  `'COPY n'`; `copy_to_table`/`copy_from_query`: https://magicstack.github.io/asyncpg/current/api/index.html
- **MagicStack/asyncpg#749** — `copy_records_to_table` abandons remaining rows on unique violation →
  staging + `ON CONFLICT` is the recommended path: https://github.com/MagicStack/asyncpg/issues/749
- **psycopg 3 COPY docs** — `cursor.copy("COPY … FROM STDIN")` context manager, `write_row`, binary
  format: https://www.psycopg.org/psycopg3/docs/basic/copy.html
- **TimescaleDB decompress / backfill docs** — four-step decompress→insert→recompress, `decompress_chunk`,
  `recompress_chunk` procedure since 2.6.0, `timescaledb_extras.decompress_backfill`:
  https://docs.tigerdata.com/use-timescale/latest/compression/decompress-chunks/
- **timescaledb#1094** — `ON CONFLICT ON CONSTRAINT` unsupported on hypertables:
  https://github.com/timescale/timescaledb/issues/1094
- **timescaledb-parallel-copy** — multi-worker parallel COPY tool (`--workers N --batch-size M`):
  https://github.com/timescale/timescaledb-parallel-copy
