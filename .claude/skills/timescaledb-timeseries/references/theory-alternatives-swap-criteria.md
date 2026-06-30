# theory: alternatives & measured swap-criteria — TimescaleDB vs native Postgres partitioning vs ClickHouse vs DuckDB+Parquet

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (DataQuery / Fusion / SI 360 class). **NOT** Lumina. Greenfield Python/FastAPI/data-engineering build; no codebase `file:line` anchors yet — this is theory + measured swap-criteria.
>
> **Purpose of this doc.** When you reach for a time-series store you are choosing one of four real engines, and the marketing of all four is a minefield. This is the **honest decision doc**: the actual architectural fork, the measured numbers (each tagged vendor / independent, each cross-verified across ≥2 benchmarks where possible), a weighted trade-off matrix, and — the part everyone skips — **numeric swap-criteria** that say *exactly when* the cheap default stops being correct and you must move a tier of the system to a different engine. "It feels slow, let's use ClickHouse" is the failure this doc exists to prevent.

---

## 0. The one-paragraph answer (read this first)

For a markets data-analytics product whose primary truth is **relational** (instruments, issuers, curves, structured-product terms) and whose hot path is **point lookups + selective filtered aggregations joined to that relational data**, the correct default is **TimescaleDB on a single Postgres** — you keep transactional upserts, foreign keys, point lookups, and one ops surface, and you get continuous aggregates + columnar compression for the time-series tail. You move the **aggregation tier** (and *only* that tier) to **ClickHouse** when a measured, cagg-backed, properly-indexed query still exceeds your latency SLO at the required QPS over a denormalized scan — that is a *measured* trigger, not a vibe. You use **native Postgres declarative partitioning** (no extension) only when you need *just* partition management — typically hash/list partitioning Timescale doesn't do, or a hard no-extension policy — and you accept losing continuous aggregates, compression policies, retention policies, and hyperfunctions. You use **DuckDB + Parquet on object storage** for the **cold archive** and the **analyst/ad-hoc / embedded** surface — it is an in-process single-writer OLAP engine, **not** a concurrent write-serving database, so it never owns the live ingest path.

Everything below is the evidence and the exact thresholds.

---

## 1. The decision frame — what you are actually trading

There is exactly one architectural fork, and every benchmark argument is downstream of it:

```
                        ┌─────────────────────────────────────────────┐
                        │  Is the primary source-of-truth RELATIONAL,  │
                        │  and is the hot path point-lookups +         │
                        │  selective filtered aggregations that JOIN   │
                        │  back to that relational data?               │
                        └───────────────┬──────────────────┬──────────┘
                                  YES   │                  │  NO (denormalized,
                                        │                  │  huge full-column
                                        ▼                  ▼  scans dominate)
                        ┌──────────────────────────┐  ┌─────────────────────────┐
                        │ STAY ON ONE POSTGRES      │  │ COLUMNAR-OLAP ENGINE    │
                        │ (TimescaleDB, or native   │  │ (ClickHouse for serving │
                        │  partitioning if no exts) │  │  DuckDB for embedded/   │
                        │                           │  │  ad-hoc/cold archive)   │
                        └──────────────────────────┘  └─────────────────────────┘
```

### 1a. The "stay on one Postgres" value (often undervalued)

Four things you keep for free, that a separate columnar OLAP store makes hard or impossible:

1. **Joins to relational data are first-class.** RTABench exists precisely because real apps join time-series events to normalized dimension tables (customers, products, orders). On RTABench's *normalized* schema, TimescaleDB is **1.9× faster than ClickHouse** even though ClickHouse is **6.8× faster than TimescaleDB on ClickBench's denormalized single-table** workload — the schema, not the engine, decides the winner. (Timescale/Tiger, vendor — [tigerdata.com/blog/benchmarking-databases-for-real-time-analytics-applications](https://www.tigerdata.com/blog/benchmarking-databases-for-real-time-analytics-applications): *"1.9x faster than ClickHouse on RTABench, even though it's 6.8x slower on ClickBench"*; independently corroborated in direction by VeloDB/Doris below.)

2. **Transactional upserts & full ACID.** `INSERT ... ON CONFLICT DO UPDATE` is a single atomic statement on Postgres; corrections, late-arriving ticks, and dimension edits Just Work. ClickHouse has *"limited ACID support for inserts"* and treats updates/deletes as background **mutations** (independent — [oneuptime.com/blog/post/2026-01-21-clickhouse-vs-timescaledb](https://oneuptime.com/blog/post/2026-01-21-clickhouse-vs-timescaledb/view): *"ClickHouse: Limited ACID support for inserts"* / *"TimescaleDB: Full PostgreSQL ACID"*).

3. **Point lookups are cheap.** "Give me the latest price for instrument X" is a single-row read on an indexed Postgres b-tree — *"single-digit milliseconds"* (vendor — [tinybird.co/blog/clickhouse-vs-timescaledb](https://www.tinybird.co/blog/clickhouse-vs-timescaledb)). The same lookup in ClickHouse *"requires full granule scan"* because the storage is columnar and the primary key is a sparse sorting key, not a unique row index (independent — oneuptime, *"ClickHouse: Requires full granule scan"*).

4. **One ops surface.** One backup story, one auth model, one connection pool, one monitoring stack, one set of on-call runbooks, one place RLS/row-security lives. A second OLAP cluster doubles your operational surface and adds a **replication/ETL pipeline between the two** (the Kafka-bridge pattern below) — that pipeline is itself a source of bugs, lag, and 3am pages.

### 1b. The columnar-OLAP value (real, but narrower than the hype)

You reach for ClickHouse/DuckDB when the **dominant** workload is wide aggregation scans over mostly-immutable, append-only, denormalized data:

- ClickHouse *"processes billions of rows in seconds"* and is built ground-up for *"high-throughput analytical queries"* (independent — oneuptime).
- On the **denormalized ClickBench** workload it is **6.8× faster** than TimescaleDB (cross-verified: stated by both Tinybird and Tiger/Timescale — [tinybird](https://www.tinybird.co/blog/clickhouse-vs-timescaledb), [tigerdata](https://www.tigerdata.com/blog/benchmarking-databases-for-real-time-analytics-applications)).
- Compression is excellent: ClickHouse typically **10×–100×** (vendor-adjacent — Tinybird) / **10×–40×** (independent — oneuptime); on data loading specifically, on RTABench ClickHouse was *"4.8x faster at loading data and uses 1.7x less disk"* than TimescaleDB (vendor — Tiger, so the loser's own number, which makes the loading/disk advantage **credible against interest**).

The trap is assuming *your* workload is the ClickBench workload. Markets analytics that join events to instruments and answer "latest value" lookups look far more like RTABench than ClickBench — which is the whole point of §1a.

---

## 2. The measured numbers — one table, every figure sourced & flagged

> **Reading discipline (per cto-rules §3).** Each row is tagged **[vendor]** (authored by a party selling one of the engines — discount accordingly) or **[independent]**. Every load-bearing multiplier is cross-verified across ≥2 sources or flagged `[single-source]`. A multiplier with no benchmark behind it is a vibe and is excluded.

### 2a. Query / aggregation speed

| Claim | Number | Source & flag | Cross-verify |
|---|---|---|---|
| ClickHouse vs Timescale on **denormalized aggregation** (ClickBench) | ClickHouse **6.8× faster** | [tigerdata][T] **[vendor — but Timescale's *own* loss, credible against interest]** | Same figure on [tinybird][TB] **[vendor — ClickHouse-adjacent]** → **two independent vendors agree on direction & magnitude** |
| Timescale vs ClickHouse on **real-time analytics** (RTABench, normalized + joins) | Timescale **1.9× faster** | [tigerdata][T] **[vendor]** | VeloDB/Doris RTABench: Doris is *"6× faster than ClickHouse"* and *"nearly 4× faster than TimescaleDB"* → implies **Timescale ≈ 1.5× faster than ClickHouse** on the same bench from a *third* party ([velodb][V] **[independent of both]**). Direction confirmed; magnitude within ~25%. |
| DuckDB vs Timescale on RTABench | DuckDB **3.5× faster** than Timescale, **7.3× faster** than ClickHouse | [tigerdata][T] **[vendor]** | [search synthesis][S1] repeats same figures **[secondary]**. Note: DuckDB wins *single-user latency*, not concurrent serving — see §5. `[single-primary-source — flag]` |
| Timescale vs vanilla Postgres on RTABench | Postgres only **4.1× slower** than Timescale on raw queries | [tigerdata][T] **[vendor]** | VeloDB: Doris *"30× faster than PostgreSQL"* and *"~4× faster than TimescaleDB"* → implies **Postgres ≈ 7.5× slower than Timescale** on Doris's run ([velodb][V] **[independent]**). The two disagree (4.1× vs 7.5×) — **honest finding: "Timescale beats vanilla PG on real-time analytics by single-digit ×, exact factor is config-dependent (4–8×), not the 1000× the TSBS marketing implies."** |
| Timescale vs vanilla Postgres on **time-series-shaped** queries (TSBS) | up to **1,000×+**, one query **14,000×**, **450×** on 100M rows | [Timescale TSBS blog][TSBS] **[vendor — heavily cherry-picked]** | **No independent cross-verify found.** These are best-case single-query figures on time-bucketed scans. `[vendor cherry-pick — treat as ceiling, not expectation]`. The honest ~4× general figure (RTABench) is the planning number. |
| vectorized `time_bucket()` aggregation gain, TS 2.26 | **~3.5× faster** on affected workloads | [Timescale 2.26 changelog][TC26] **[vendor]** | `[single-source — version-specific feature claim]` |

### 2b. Ingest throughput

| Engine | Throughput | Crossover / caveat | Source & flag |
|---|---|---|---|
| ClickHouse | **~4M rows/s** single Cloud server (59 vCPU/236GB) on a 65B-row load; another run **6.37M rows/s** | needs **large batches**; *"each insert should write at least 100,000 rows, ideally 1–10M"*; small batches <1,000 rows create overhead | [ClickHouse async-insert blog / docs][CHB] **[vendor, but methodology disclosed]**; corroborated [oneuptime insert bench][O2] **[independent]** |
| TimescaleDB | *"tens of thousands of rows/s"* peak (Tinybird framing) **vs** *"1–2M data points/s"* batch (sanj framing) — these measure different things (single-row vs `COPY`/batch) | **wins ClickHouse for batches under ~1,000 rows** | Tinybird **[vendor — CH-adjacent, low-balls TS]** [TB]; sanj **[independent]** [SANJ] |
| TimescaleDB vs vanilla Postgres ingest | **20× higher inserts** sustained (111K rows/s through 1B rows vs PG 5K rows/s at 1B); PG took ~40h, TS <3h for 1B rows | space-partitioning keeps recent chunks in memory | [Timescale TSBS][TSBS] **[vendor]** `[no independent cross-verify — but mechanism (chunk-local index updates) is sound]` |
| High-cardinality penalty (Timescale) | ingest drops **557K → 159K rows/s at 10M hosts** | cardinality, not row count, is the Timescale ingest ceiling | [tinybird][TB] **[vendor]** |

**The honest ingest summary:** ClickHouse wins raw ingest **only with large batches** (~2–6M+ rows/s vs Timescale's ~1–2M with `COPY`); **Timescale wins below ~1,000-row batches** and wins **20× over vanilla Postgres** regardless. Markets tick ingest is usually micro-batched (per-symbol streams) — which sits near or below the crossover, *narrowing or erasing ClickHouse's ingest edge* unless you deliberately buffer into large batches.

### 2c. Compression & storage

| Engine | Ratio | Source & flag |
|---|---|---|
| ClickHouse | **10×–100×** [tinybird][TB] **[vendor]** / **10×–40×** [oneuptime][O] **[independent]** — call it **10×–40× realistic, 100× best-case** |
| TimescaleDB | **2×–10×** [tinybird][TB] **[vendor, CH-adjacent → low-ball]** / **10×–20×+ with Hypercore** [oneuptime][O] **[independent]** — Hypercore (columnstore) closes most of the gap |
| ClickHouse disk on RTABench load | **1.7× less disk** than Timescale [tigerdata][T] **[vendor — loser's own number, credible]** |

### 2d. Point lookups, updates, joins (the OLTP-shaped axes ClickHouse is weak on)

| Axis | TimescaleDB | ClickHouse | Source |
|---|---|---|---|
| Point lookup (single indexed row) | single-digit ms, b-tree | *"requires full granule scan"* — sparse PK, no unique row index | [tinybird][TB], [oneuptime][O] **[both, vendor+independent agree]** |
| Update/Delete | full real-time `UPDATE`/`DELETE`/`ON CONFLICT` | **mutations**: rewrite whole data parts, async, *"not a good idea for point (single row) updates like in OLTP"* — lightweight updates exist but target *rare bulk* ops | [ClickHouse mutations docs][CHM] **[vendor, primary]**; [oneuptime][O] **[independent]** |
| Joins | full Postgres planner, *"superior performance"* on normalized schemas | *"JOINs can be memory-intensive; limited optimization"* | [oneuptime][O] **[independent]** |
| ACID transactions | full Postgres ACID | *"limited ACID support for inserts"* | [oneuptime][O] **[independent]** |

> **ClickHouse update mechanics (primary, [CHM]):** a classic mutation *"forces all data parts containing those rows to be deleted to be re-written, with the target rows excluded when forming the new part"* — considerable I/O. The official guidance: lightweight updates/deletes and `ReplacingMergeTree` are the escape hatches, **not** OLTP-style row updates. For a markets product with **corrections, restatements, and late ticks**, this is a structural reason the *system of record* should not be ClickHouse.

---

## 3. Native Postgres declarative partitioning — the "no-extension" option

Declarative partitioning is **core Postgres** (`PARTITION BY RANGE/LIST/HASH`), zero extensions. You choose it over TimescaleDB when you need **only** partition management and have a reason to avoid the extension.

### What you GET (vs an un-partitioned table)
- Partition pruning (the planner skips partitions outside the `WHERE` range).
- Cheap drop-old-data: `DROP TABLE partition_2019` instead of a slow `DELETE`.
- **HASH and LIST** partitioning — which **TimescaleDB does not support** (Timescale is range/time only). If you must hash-partition by `instrument_id` or list-partition by `asset_class`, native is your *only* in-Postgres option. ([tigerdata pg_partman-vs-hypertables][PGP]: *"hash and list … not currently supported by TimescaleDB"*.)

### What you LOSE vs TimescaleDB (the whole reason Timescale exists)
- **No automatic partition creation.** *"You need to manually pre-create partitions, ensure there are no data gaps, and ensure no data is inserted outside your partition ranges."* (vs `create_hypertable` once.) You bolt on `pg_partman` + a `pg_cron` job to get auto-maintenance — i.e. you reinvent a slice of Timescale, badly. ([PGP] **[vendor — but the mechanism (manual leaf creation) is core-Postgres fact, verifiable in PG docs]**.)
- **No continuous aggregates** (incrementally-maintained materialized rollups). You hand-roll materialized views + refresh cron, with no incremental refresh.
- **No native columnar compression / compression policies.** You get only `TOAST`/row storage.
- **No retention/reorder policies, no hyperfunctions** (`time_bucket`, `first`, `last`, `time_weight`, gapfill, etc.).
- **Indexes/constraints can't live on the root table** (with few exceptions) — *"these objects have to be manually created on each leaf partition."* ([PGP].)

**Verdict:** native partitioning is the right call in exactly three cases — (a) a hard org policy against extensions / a managed PG that won't enable Timescale, (b) you genuinely need hash/list partitioning, or (c) the table is partitioned purely for **drop-old-data lifecycle** and never needs rollups/compression. Otherwise, choosing native means **re-implementing Timescale's features by hand** — a classic "saved a dependency, bought a maintenance project."

---

## 4. DuckDB + Parquet — the embedded/analyst/cold-archive engine (NOT a serving DB)

DuckDB is an **in-process** OLAP engine (SQLite-for-analytics): no server, no cluster, no cold-start, runs inside your Python/FastAPI worker, CLI, or a notebook ([duckdb.org][DD] / search synthesis).

### Where it is genuinely the best tool
1. **Cold archival over object storage.** Park multi-year history as **partitioned Parquet on S3/GCS** (`hive_partitioning=1`), query it on demand with DuckDB. *"The query optimizer leverages filter pushdown and projection pruning directly into Parquet … only touches the columns and row groups it needs … can use directory names and column statistics to skip whole files and row groups."* ([DuckDB Parquet docs / tips][DDP] **[vendor, primary]**). This is the cheap "warehouse over a data lake" pattern — no always-on cluster; pay only for the query.
2. **Analyst / ad-hoc.** A quant pulls a Parquet export and runs full SQL locally in seconds; DuckDB was **3.5× faster than Timescale and 7.3× faster than ClickHouse** on RTABench's *single-user* latency ([tigerdata][T] **[vendor — but it's DuckDB winning on a Timescale-authored bench, credible against interest]**).
3. **Embedded transform in the pipeline** (the "T" in ELT): repartition Parquet, downsample, build the cold tier — *"DuckDB to repartition parquet data in S3."*

### Why it must NOT own the live write path — the hard limit
DuckDB is **single-writer**. From the official concurrency docs ([DD], primary):
- **Single process, read-write:** *"one process can both read and write to the database."*
- **Multiple processes:** read-only mode allows many readers but *"no processes can write"*; cross-process **writing** is only via the **Quack remote protocol**, which *"remains in beta as of v1.5.2"* — i.e. **not production-grade for concurrent writers today**.
- Concurrent modification of identical rows → *"Transaction conflict: cannot update a table that has been altered!"*
- Independent corroboration: *"Concurrent writes to the same DuckDB file from multiple processes are not supported and are unlikely to be supported in the future … contention in the storage … same WAL file, same blocks."* ([GitHub discussion #4899][DDC] **[independent — maintainer thread]**.)

**Consequence for a markets product:** a FastAPI app with N worker processes/pods all ingesting ticks **cannot** share one DuckDB file as the write target. DuckDB is downstream of ingest (archive, analyst export), never the concurrent-write system of record. Treating it as a serving DB is the single most common DuckDB mistake.

---

## 5. Weighted trade-off matrix

> Weights reflect a **markets data-analytics product** whose truth is relational and whose hot path is point-lookup + filtered-aggregation-with-joins. **Re-derive the weights for a different product** (e.g. a pure denormalized event-analytics dashboard would up-weight "wide-agg scan" and down-weight "joins/transactional"). Scores 1 (poor) – 5 (excellent). This is a **decision aid, not a benchmark** — the swap-criteria in §6 are the real test.

| Axis (weight) | TimescaleDB | Native PG partitioning | ClickHouse | DuckDB+Parquet |
|---|---|---|---|---|
| **Point lookups** (5) | 5 — b-tree, single-digit ms | 4 — b-tree, but manual indexes per leaf | 1 — full granule scan | 2 — fast scan but in-process, not a serving point-API |
| **Joins to relational dims** (5) | 5 — full PG planner; RTABench leader | 5 — full PG planner | 2 — *"memory-intensive, limited"* | 4 — good SQL joins, single-user |
| **Transactional upsert / corrections** (5) | 5 — `ON CONFLICT`, full ACID | 5 — full ACID | 1 — mutations rewrite parts, async | 1 — single-writer only |
| **Wide aggregation scan throughput** (4) | 3 — good w/ caggs+columnstore | 2 — row store, no caggs | 5 — ClickBench king, 6.8× | 5 — RTABench single-user king |
| **Ingest at scale (large batch)** (4) | 4 — 1–2M/s, 20× vanilla PG | 2 — vanilla PG ingest | 5 — 2–6M+/s large batch | 2 — single-writer |
| **Ingest at small batch (<1k rows)** (3) | 5 — wins ClickHouse here | 3 | 2 — overhead dominates | 1 |
| **Compression / storage cost** (3) | 4 — 10–20× Hypercore | 1 — no native compression | 5 — 10–40× | 5 — Parquet+zstd |
| **One ops surface** (5) | 5 — it IS Postgres | 5 — it IS Postgres | 2 — separate cluster + ETL bridge | 4 — no server, but separate engine |
| **License** (2) | 4 — Timescale Community (TSL, source-available, not OSI) on a few features; Apache-2 core | 5 — PostgreSQL license (permissive) | 4 — Apache-2.0 | 5 — MIT |
| **Ecosystem / SQL familiarity** (3) | 5 — full Postgres SQL + tooling | 5 — full Postgres | 3 — ClickHouse SQL dialect, own tooling | 4 — Postgres-ish SQL, huge analyst uptake |
| **Horizontal scale ceiling** (3) | 2 — **distributed hypertables removed in 2.14**; relies on read replicas + vertical | 2 — vertical + read replicas | 5 — native sharding, *"linear horizontal scaling"* | 1 — single node by design |

> **Do not sum these to a single trophy number** — that hides the structure. Read it as: **Timescale dominates the OLTP-shaped + join + ops-surface axes; ClickHouse dominates the wide-scan + horizontal-scale + raw-ingest axes; native partitioning is "Postgres minus Timescale's features"; DuckDB owns embedded/archive.** The product's weight on each axis is what decides — §6 turns that into triggers.

> **License footnote (verify before relying):** TimescaleDB core is Apache-2; some features (e.g. parts of the columnstore/Hypercore historically) ship under the **Timescale License (TSL)** — source-available, **not** OSI-open, restricts offering it as a managed service. ClickHouse is **Apache-2.0**. DuckDB is **MIT**. Native partitioning is just the **PostgreSQL License** (permissive). `[Confirm the exact TSL feature list against the installed Timescale version's LICENSE — this has shifted release to release.]`

> **Critical scale caveat (cross-cuts the matrix):** TimescaleDB **distributed hypertables were deprecated in 2.13 and removed starting 2.14** (independent — [oneuptime][O]). So Timescale's scale story is **vertical + read replicas + compression**, *not* native sharding. If your design's 10,000× tier assumes Timescale will shard horizontally, **that assumption is false today** — this is the single biggest reason a Timescale design hits a wall, and it's exactly where a measured swap to ClickHouse becomes legitimate (§6).

---

## 6. Swap-criteria — the measured triggers, not vibes

The entire point of this doc. Each trigger is a **measured number against a stated SLO**, with the move it licenses. **No trigger fires on "it feels slow."** Default = single Postgres + TimescaleDB; you change tiers only when a trigger fires.

> **Prerequisite before ANY swap (the "did you actually tune Postgres?" gate).** A swap is illegitimate until you've measured these *on the current engine*: (a) the query is **cagg-backed** (hitting an incrementally-maintained rollup, not raw chunks); (b) the **filtered/sorted columns are indexed** and the chunk is compressed/columnstore; (c) `EXPLAIN (ANALYZE, BUFFERS)` shows the plan is chunk-pruned and not doing a seq scan; (d) you've measured at the **required QPS / concurrency**, not single-user. Most "ClickHouse would be faster" beliefs evaporate at step (a) — see the TSBS 1000× vs RTABench ~4× gap: the gap *is* continuous aggregates.

### Trigger T1 — move the AGGREGATION tier to ClickHouse
> **Fire when:** a **cagg-backed, indexed, compressed** aggregation query's **p99 latency > [your SLO, e.g. 200 ms] at [required QPS, e.g. 50 concurrent]**, measured, *and* the query is a **wide denormalized scan** (the ClickBench shape, not the RTABench shape).

- **Why this and not earlier:** on the *normalized/join* shape, Timescale is **1.9× faster than ClickHouse** — moving would make it *slower*. ClickHouse only pays off on the **denormalized wide-scan** shape, where it's **6.8× faster** ([T],[TB] cross-verified). So the trigger requires *both* a latency miss *and* the workload being the shape ClickHouse wins.
- **What you move:** *only* the aggregation/serving tier — a denormalized, append-only mirror of the hot facts, fed from Postgres via CDC/Kafka (the documented hybrid: *"data flows between these systems via Kafka … optimizes for both real-time and historical"* — [sanj][SANJ] **[independent]**). Postgres/Timescale stays the **system of record**; ClickHouse becomes a **read-optimized replica for one query class**. You do **not** move point lookups, upserts, or joins-to-dims there.
- **The cost you're accepting:** a second cluster, a CDC pipeline, replication lag, and the loss of transactional reads on that tier. Worth it *only* when T1's measured miss is real.

### Trigger T2 — Timescale ingest ceiling
> **Fire when:** sustained ingest **> ~1–2M rows/s** *and* batches are **large (≥100k rows)** *and* Timescale is the bottleneck after `COPY`/batching tuning, **OR** cardinality is driving ingest down (the **557K → 159K rows/s at 10M hosts** cliff — [TB]).

- Below this, and especially at **small batches (<1k rows)**, Timescale *wins* ClickHouse — don't move ([TB]).
- ClickHouse's ~2–6M+ rows/s edge **only exists with large batches** ([CHB],[O2]). If your ingest is naturally micro-batched (per-symbol tick streams), the *first* fix is **buffer into larger batches** (or use an ingest buffer like Kafka→batch loader) — that often clears T2 *without* swapping engines.

### Trigger T3 — horizontal scale wall
> **Fire when:** a single Postgres node (+ read replicas + compression) cannot hold the working set / write rate, *and* you've exhausted vertical scaling and compression.

- This is the **distributed-hypertables-removed-in-2.14** wall ([O], independent). Timescale will not shard for you. When you genuinely outgrow one node's writes, ClickHouse's **native sharding / linear horizontal scaling** is the documented answer — but confirm it's a *write/volume* wall, not an *unindexed-query* wall (which T1's prerequisite gate would have caught).

### Trigger T4 — move COLD history to DuckDB+Parquet
> **Fire when:** history older than **[hot window, e.g. 90 days]** is **rarely queried**, queries that touch it tolerate **seconds not ms**, and it inflates Postgres storage/backup cost.

- Move cold partitions to **partitioned Parquet on object storage**, query with DuckDB on demand (filter pushdown + row-group skipping — [DDP]). This is additive, low-risk, and **never** touches the live write path (§4). Strong default for any multi-year markets archive.

### Anti-trigger (when you must NOT swap)
- You need **point lookups, transactional upserts/corrections, or joins to relational dims** as a hot path → **stay on Postgres/Timescale**; ClickHouse is structurally worse at all three ([CHM],[O]).
- The slow query is **not cagg-backed / not indexed / measured single-user** → tune first; the swap would just hide unindexed work behind a new cluster (the cargo-cult failure cto-rules §5 names).
- DuckDB for **concurrent serving** → never; single-writer ([DD]). DuckDB is archive/embedded only.

---

## 7. Recommended target architecture for the markets data-analytics product

```
                    ┌──────────────────────────────────────────────────────┐
   live ticks ─────▶│  INGEST BUFFER (Kafka / Redpanda) — batches micro-    │
   corrections ────▶│  streams into ≥100k-row loads (clears T2 crossover)   │
                    └───────────────┬──────────────────────────────────────┘
                                    │ batched COPY / upsert
                                    ▼
            ┌────────────────────────────────────────────────────────┐
            │  POSTGRES + TimescaleDB  (SYSTEM OF RECORD)             │
            │  • hypertables for ticks/curves; relational dims        │
            │  • continuous aggregates = rollups (the ~1000×→~4× gap) │
            │  • Hypercore columnstore compression on cold chunks     │
            │  • point lookups, ON CONFLICT upserts, joins-to-dims    │
            └───────┬───────────────────────────────┬────────────────┘
                    │ CDC / Kafka (ONLY if T1 fires) │ tier-out >90d
                    ▼                                ▼
   ┌────────────────────────────────┐   ┌──────────────────────────────────┐
   │ ClickHouse (READ-OPTIMIZED     │   │ DuckDB + Parquet on S3/GCS        │
   │ AGG TIER — denormalized mirror)│   │ (COLD ARCHIVE + analyst ad-hoc)   │
   │ ONLY for wide-scan query class │   │ partitioned, hive, filter-pushdown│
   │ that missed SLO per T1         │   │ NEVER on the live write path      │
   └────────────────────────────────┘   └──────────────────────────────────┘
```

**The rule encoded above:** start with the middle box only. The two bottom boxes are **earned by a fired trigger** (T1, T4), never added speculatively. This is "compute-once-serve-many" applied to engine choice — don't pay for a ClickHouse cluster until a measured query demands it.

---

## 8. Pre-mortem — six months out, this failed. Why?

> The disciplined "name the failure modes before they happen" pass (cto-rules §6). One per choice.

- **"We picked ClickHouse as the system of record."** Six months in, restatements and late ticks turn into a mutations nightmare — every correction *"rewrites whole data parts"* ([CHM]), point lookups for "latest price" do full granule scans, and joins to the instrument master are *"memory-intensive"* ([O]). The team rebuilds a Postgres front for the OLTP shape they assumed away. **Fix it now:** Postgres/Timescale is the record; ClickHouse is a *derived* read tier behind T1 only.
- **"We picked native partitioning to avoid the extension."** Six months in, the team has hand-built partition-creation cron, hand-rolled materialized-view refresh, and has no compression — i.e. re-implemented Timescale, with bugs, on the on-call rota. **Fix it now:** only choose native for genuine hash/list needs, a hard no-extension policy, or pure drop-old lifecycle ([PGP]).
- **"We used DuckDB to serve the live dashboard."** Six months in, the second ingest pod hits *"cannot update a table that has been altered"* / cross-process writes unsupported ([DD],[DDC]); under real concurrency it serializes or errors. **Fix it now:** DuckDB is archive/embedded only; serving point-APIs is Postgres's job.
- **"We assumed Timescale would shard horizontally at 10,000×."** Six months in, the write rate exceeds one node and there's no native sharding — **distributed hypertables were removed in 2.14** ([O]). The migration to a sharded store is now an emergency, not a plan. **Fix it now:** design the T3 escape hatch (ClickHouse agg tier or a sharded store) up front, and lean on read replicas + compression + caggs to push the vertical ceiling as far as it goes.
- **"We swapped to ClickHouse on a vibe."** Six months in, the workload was actually the RTABench/join shape, and the query that "felt slow" was just unindexed / not cagg-backed — the new cluster is slower *and* the team owns a CDC pipeline. **Fix it now:** §6's prerequisite gate (cagg + index + EXPLAIN + measured-at-QPS) must pass *before* any swap; the swap requires a *measured* SLO miss on the *denormalized* shape, not a feeling.
- **"We trusted the 1000× marketing number."** Capacity planning assumed Timescale is 1000× vanilla PG; the real-workload factor is **~4–8×** (RTABench, cross-verified [T]+[V]). The fleet is under-provisioned. **Fix it now:** plan against the independent RTABench-class figure, treat TSBS 1000×/14,000× as cherry-picked ceilings ([TSBS]).

---

## 9. Confidence & open questions

**High confidence (cross-verified ≥2 independent sources, or primary docs):**
- The architectural fork (relational+join+point-lookup → Postgres; denormalized wide-scan → columnar) — multiple independent sources agree.
- ClickHouse weak at point lookups / updates / joins / transactions — primary ClickHouse docs ([CHM]) + independent ([O]).
- DuckDB single-writer, not a concurrent serving DB — primary docs ([DD]) + maintainer thread ([DDC]).
- Native partitioning loses caggs/compression/policies/hyperfunctions and needs manual leaf management — mechanism is core-Postgres fact.
- Direction of ClickBench (CH wins) vs RTABench (TS wins) — agreed by two vendors + one independent third party.

**Medium confidence:**
- Exact multipliers (1.9×, 6.8×, 3.5× DuckDB, ~4× TS-vs-PG). Direction is solid and cross-verified; exact magnitude is config/hardware/version-dependent — **always re-benchmark on YOUR schema and data before a swap.** RTABench is the right shape to copy; ClickBench is not (for this product).
- Ingest crossovers (~1k-row batch boundary, ~1–2M vs 2–6M rows/s). Sourced but vendor-tinged on both sides; verify on your batch profile.

**Low confidence / `[unverified — flag]`:**
- The TSBS 1000×/14,000× Timescale-vs-PG figures — vendor, cherry-picked, no independent cross-verify; treated as ceilings.
- Exact current TSL feature boundary — shifts release to release; confirm against the installed `LICENSE`.

**Open questions to resolve with a spike before committing:**
1. What is the **real query-shape mix** (point-lookup % vs join-agg % vs wide-scan %)? Run RTABench-style queries on a representative sample.
2. What is the **actual ingest batch profile** after the Kafka buffer — does it clear the ~1k-row crossover, neutralizing ClickHouse's ingest edge?
3. What is the **p99 latency SLO at target QPS** for the worst aggregation? That single number is what arms or disarms Trigger T1.
4. Pin the **installed TimescaleDB version** (latest is **2.27.0, 2026-05-12** — [TS releases][TR]) and confirm Hypercore/columnstore + the 2.27 UPDATE/DELETE bloom-filter write-path optimizations are available, since they materially change the compression and update story.

---

## Sources

[T]: https://www.tigerdata.com/blog/benchmarking-databases-for-real-time-analytics-applications "Tiger/Timescale — RTABench results (VENDOR): 1.9× faster than ClickHouse on RTABench, 6.8× slower on ClickBench; DuckDB 3.5×/7.3×; PG 4.1× slower; CH 4.8× faster load + 1.7× less disk."
[TB]: https://www.tinybird.co/blog/clickhouse-vs-timescaledb "Tinybird (Cameron Archer, 2025-10-22, VENDOR/ClickHouse-adjacent) — ingest ~4M rows/s CH large batch; TS wins <1k rows; compression CH 10–100× vs TS 2–10×; point lookup TS single-digit ms; cardinality 557K→159K."
[V]: https://www.velodb.io/blog/apache-doris-tops-rta-bench "VeloDB/Apache Doris (INDEPENDENT of CH & TS) — RTABench: Doris 6× faster than ClickHouse, 30× faster than Postgres, ~4× faster than TimescaleDB, 100× faster than MongoDB; score ×1.28."
[O]: https://oneuptime.com/blog/post/2026-01-21-clickhouse-vs-timescaledb/view "OneUptime (INDEPENDENT) — CH limited ACID, full granule scan point lookups, memory-intensive joins, async mutations; TS full ACID/joins/point lookups; distributed hypertables removed 2.14; compression CH 10–40× / TS 10–20×+ Hypercore."
[SANJ]: https://sanj.dev/post/postgresql-timescaledb-clickhouse-comparison/ "sanj.dev (INDEPENDENT, 2026) — TS ~1–2M pts/s batch; hybrid Kafka pipeline (Postgres OLTP + Timescale real-time + ClickHouse historical)."
[TSBS]: https://medium.com/timescale/timescaledb-vs-6a696248104e "Timescale (VENDOR, TSBS) — 20× higher inserts (111K vs 5K rows/s at 1B), 2000× faster deletes, 1.2×–14,000× queries, 1000×+ vs vanilla PG. CHERRY-PICKED ceilings."
[CHM]: https://clickhouse.com/docs/guides/developer/mutations "ClickHouse official docs (PRIMARY) — mutations rewrite whole data parts, async, not for OLTP point updates; lightweight updates/deletes + ReplacingMergeTree as alternatives."
[CHB]: https://clickhouse.com/blog/asynchronous-data-inserts-in-clickhouse "ClickHouse (VENDOR, methodology disclosed) — ~4M rows/s single Cloud server on 65B-row load; insert ≥100k rows, ideally 1–10M; async_insert buffering thresholds."
[O2]: https://oneuptime.com/blog/post/2026-03-31-clickhouse-benchmark-insert-performance/view "OneUptime (INDEPENDENT) — CH insert benchmarking; 50k-row batches + 4 workers sustain millions rows/s; test 1k→1M to find sweet spot."
[DD]: https://duckdb.org/docs/current/connect/concurrency "DuckDB official docs (PRIMARY) — single-writer; multi-process write only via Quack remote protocol (beta v1.5.2); MVCC+optimistic CC within process; conflict error on concurrent same-row update."
[DDC]: https://github.com/duckdb/duckdb/discussions/4899 "DuckDB maintainers (PRIMARY/INDEPENDENT thread) — cross-process concurrent writes not supported and unlikely ever (shared WAL/blocks contention)."
[DDP]: https://duckdb.org/docs/current/data/parquet/tips "DuckDB official Parquet docs (PRIMARY) — filter pushdown, projection pruning, row-group/file skipping via zonemaps & directory stats; hive_partitioning."
[PGP]: https://www.tigerdata.com/learn/pg_partman-vs-hypertables-for-postgres-partitioning "Tiger (VENDOR, but core-PG facts) — native partitioning needs manual leaf creation, no root-table indexes, no auto partitions; hash/list unsupported by TimescaleDB; hypertables = create_hypertable + caggs + compression."
[TC26]: https://www.tigerdata.com/docs/about/latest/changelog "Timescale changelog (VENDOR) — 2.26 vectorized time_bucket() ~3.5× faster on affected workloads; 2.27 bloom-filter write-path for UPDATE/DELETE/UPSERT + cagg query rewriter."
[TR]: https://github.com/timescale/timescaledb/releases "TimescaleDB releases (PRIMARY) — latest 2.27.0 (2026-05-12); PostgreSQL 15 support ending June 2026."
[S1]: https://www.bigdatawire.com/2025/03/26/new-benchmark-for-real-time-analytics-released-by-timescale/ "BigDATAwire (SECONDARY/press) — RTABench launch coverage; corroborates DuckDB 3.5×/7.3× and 33/40-query, 5-table normalized schema framing."
