---
name: timescaledb-timeseries
description: >
  Build the time-series warehouse for the JPM-Markets re-engineering data-analytics product line
  (NOT Lumina) on TimescaleDB — a NEW Python/FastAPI/data-engineering line, separate from Lumina's
  Bun/Express/Prisma/Upstash stack. Covers hypertables + chunking, continuous aggregates (the
  compute-once-serve-many rollup), Hypercore columnar compression + retention, the Apache-2 / Timescale
  License (TSL) split and the self-host-commercial allowance, time-series indexing & query planning,
  high-throughput ingestion/upsert (COPY + staging, writes into/around compressed chunks), gapfilling /
  interpolation (time_bucket_gapfill / locf / interpolate), the SERVER-SIDE downsampling contract for
  charts (time_bucket OHLC aggregation + lttb() — never return more points than the chart can draw,
  ~800 default), the Python connection layer (asyncpg / psycopg / SQLAlchemy / Alembic / bulk COPY),
  the timescaledb-toolkit hyperfunctions (candlestick_agg/OHLC, time-weighted, percentile-approx, ASAP,
  counter/gauge), and the swap-criteria decision against ClickHouse / native Postgres partitioning /
  DuckDB+Parquet. Pins the current line: TimescaleDB 2.27.0 (2026-05-12), PostgreSQL 15–18, and the
  Timescale→Tiger Data rebrand (docs at tigerdata.com). Use whenever the task touches storing or
  querying time-series/market data, hypertables, continuous aggregates, compression, retention,
  chart-data downsampling, OHLC candles, gapfill, time-series ingestion, or the TimescaleDB licensing
  decision for this data-analytics product line.
metadata:
  priority: 55
  sessionStart: false
  productLine: jpm-markets-reengineering
  pathPatterns:
    - '.agents/jpm-markets-reengineering/**'
  bashPatterns:
    - 'timescale'
    - 'create_hypertable'
    - 'time_bucket'
    - 'continuous_aggregate'
    - 'asyncpg'
    - 'psycopg'
  promptSignals:
    phrases:
      - 'timescaledb'
      - 'tiger data'
      - 'hypertable'
      - 'continuous aggregate'
      - 'time_bucket'
      - 'time-series'
      - 'time series database'
      - 'hypercore'
      - 'columnstore'
      - 'compression policy'
      - 'retention policy'
      - 'chunk_time_interval'
      - 'downsample'
      - 'lttb'
      - 'ohlc'
      - 'candlestick'
      - 'gapfill'
      - 'time_bucket_gapfill'
      - 'interpolate'
      - 'locf'
      - 'asyncpg'
      - 'psycopg'
      - 'market data warehouse'
    minScore: 2
---

# TimescaleDB — the time-series warehouse for the JPM-Markets re-engineering line (NOT Lumina)

> **Product line.** This skill belongs to the **JPM-Markets re-engineering data-analytics product
> line** — a *separate* product line from Lumina (see [`cto-rules.md`](../../rules/cto-rules.md) §"Scope
> note"). That line is **new ground**: a **Python / FastAPI / data-engineering** stack, NOT Lumina's
> Bun + Express + Prisma + Supabase + Upstash stack. Nothing in this skill wires into Lumina's app
> code. The two repos only share a filesystem home for the research.
>
> **What this skill makes you expert at.** Designing and building the **time-series store** that an
> analytics product (the DataQuery / Fusion / Athena-class re-engineering) reads from: a market-data
> warehouse on **TimescaleDB 2.27.0** (released 2026-05-12), the Postgres extension that turns one
> Postgres into a time-series database via hypertables, continuous aggregates, and the Hypercore
> columnar engine. We build *on top of* Postgres so the same database also holds the relational/OLTP
> tables — one engine, one SQL dialect, no second store until a measured ceiling forces it.

This skill follows the **finance-markets gold-standard** cognitive-mesh structure: a thin router here,
deep cited references on demand. It is **greenfield** — the references are theory + design/recipe, not
yet `file:line` traces into a built codebase, because the product line has no committed code yet.

> **The rebrand, stated once.** Timescale the company is now **Tiger Data**; the open-source extension
> is still **TimescaleDB**, the cloud is **Tiger Cloud**, and the docs now live at **`tigerdata.com`**
> (`docs.timescale.com` 301-redirects there). Some functions were renamed in the Hypercore era
> (`add_compression_policy` → `add_columnstore_policy`, etc. — both still work). Pin to the installed
> **2.27.0** line and the current docs host. Full detail: `theory-version-rebrand-install.md`.

---

## Domain Identity

### This skill COVERS

- **TimescaleDB as the time-series warehouse** for the JPM-Markets re-engineering analytics line:
  - **Hypertables + chunking** — the auto-partitioned table, `create_hypertable`, `chunk_time_interval`
    sizing, chunk exclusion. (`theory-hypertables-chunking.md`)
  - **Continuous aggregates** — incrementally-materialized rollups (1m → 1h → 1d cascades), refresh
    policies, real-time vs `materialized_only`. The compute-once-serve-many surface.
    (`theory-continuous-aggregates.md`)
  - **Hypercore columnar compression + retention** — the rowstore→columnstore engine, `segmentby`/
    `orderby` tuning, 90–98% ratios, the query implications. (`theory-hypercore-compression.md`,
    `patterns-retention-data-lifecycle.md`)
  - **The Apache-2 / Timescale License (TSL) split** and the self-host-commercial allowance.
    (`theory-licensing-apache2-tsl-split.md`)
  - **Time-series indexing & query planning** — composite `(symbol, time DESC)` indexes, `EXPLAIN`,
    chunk exclusion, querying compressed chunks, the R-SCALE tier. (`patterns-indexing-query-performance.md`)
  - **High-throughput ingestion & upsert** — COPY, batched inserts, the COPY-into-staging +
    `INSERT … ON CONFLICT` upsert pattern, writes into/around compressed chunks, off-request-path
    discipline. (`patterns-ingestion-upsert.md`)
  - **Gapfilling / interpolation** — `time_bucket_gapfill` + `locf` + `interpolate`, and the market-data
    fabrication traps. (`patterns-gapfill-interpolation.md`)
  - **The SERVER-SIDE downsampling contract for charts** — `time_bucket` OHLC aggregation + `lttb()`,
    target resolution (~800 points), the visible-range parameter; the JSON the endpoint returns.
    (`patterns-server-side-downsampling-charts.md`)
  - **The Python connection/driver layer** — `asyncpg` / `psycopg` (v3) / SQLAlchemy / Alembic,
    pooling, async, bulk COPY from Python, where queries live. (`patterns-python-connection-layer.md`)
  - **The `timescaledb-toolkit` hyperfunctions** — `candlestick_agg`/OHLC, time-weighted aggregates,
    percentile-approx (`uddsketch`/`tdigest`), ASAP smoothing, `counter_agg`/`gauge_agg`, beyond `lttb`.
    (`patterns-toolkit-hyperfunctions.md`)
  - **Swap criteria** — when TimescaleDB is *not* the right engine and you move to ClickHouse / native
    Postgres partitioning / DuckDB+Parquet, decided by measured numbers. (`theory-alternatives-swap-criteria.md`)
  - **Version / rebrand / install** — the 2.27.0 line, PG 15–18 support, the Tiger Data rebrand, the
    extension + toolkit install, the docs-host gotcha. (`theory-version-rebrand-install.md`)

### This skill does NOT cover

- **NOT the chart-rendering frontend.** Lightweight Charts / TradingView / D3 / visx are a separate
  trading-UX/frontend concern. This skill stops at the **JSON the downsampling endpoint returns**; what
  draws it is out of scope (in Lumina that maps to `trading-systems`/`lumina-frontend`, but those are a
  *different* product line — named only as the analogy).
- **NOT generic Postgres relational/OLTP design, RLS, or the transactional data model.** A sibling
  `postgres`/`prisma`-class schema skill owns the relational tables, constraints, and access control.
  This skill owns only the *time-series* tables (hypertables) and the queries against them.
- **NOT pgvector / embeddings / RAG.** That is a separate retrieval concern (Lumina's `rag-retrieval`).
- **NOT the FastAPI request/agent layer itself.** A sibling **api-platform** skill owns the routes,
  the agent tool definitions, request validation, and auth. This skill owns only the *time-series query*
  that such a route calls (it provides the SQL and the Python data-access function; the route wiring is
  the api-platform skill's job).
- **NOT Lumina's existing stack** — Upstash-Redis hot cache, Supabase, Prisma. Different product line,
  different language, different engine. Do not import those patterns here.
- **NOT InfluxDB / Prometheus / kdb+ / QuestDB as engines we build on.** They are named only as
  comparison points in `theory-alternatives-swap-criteria.md`.
- **NOT managed Tiger Cloud billing/ops** beyond the one fact that changes a build decision (the DBaaS
  prohibition in the license, and the swap economics).

---

## Decision Tree — task → the ONE reference to open

Open the matched reference and read its **Non-Negotiables / decision tables / runnable code** before
writing SQL or Python. Never load the whole `references/` folder.

| The task is to… | Read this reference |
|---|---|
| Decide whether a feature my design uses is free to ship **self-hosted** / which **license tier** it's in | `theory-licensing-apache2-tsl-split.md` |
| Create a time-series table, choose `chunk_time_interval`, or understand chunks/partitioning | `theory-hypertables-chunking.md` |
| Pre-aggregate rollups for dashboards (1m/1h/1d), set refresh policies, real-time vs materialized-only | `theory-continuous-aggregates.md` |
| Compress old data, tune `segmentby`/`orderby`, hit 90%+ ratio, understand Hypercore | `theory-hypercore-compression.md` |
| Serve a chart from the DB returning **≤ ~800 points** (OHLC candles or shape-preserving line) | `patterns-server-side-downsampling-charts.md` |
| Fill missing buckets / interpolate gaps **without fabricating a market price** | `patterns-gapfill-interpolation.md` |
| Ingest at high throughput, upsert idempotently, or write into/around compressed chunks | `patterns-ingestion-upsert.md` |
| Make a time-series query fast: indexing, chunk exclusion, `EXPLAIN`, the R-SCALE tier | `patterns-indexing-query-performance.md` |
| Set retention, design the raw → cagg → drop lifecycle, schedule/verify background jobs | `patterns-retention-data-lifecycle.md` |
| Connect from Python/FastAPI: `asyncpg`/`psycopg`/SQLAlchemy, pooling, Alembic, bulk COPY | `patterns-python-connection-layer.md` |
| Use toolkit hyperfunctions: `candlestick_agg`/OHLC, time-weighted, percentile-approx, `asap_smooth` | `patterns-toolkit-hyperfunctions.md` |
| Decide TimescaleDB vs ClickHouse vs native Postgres partitioning vs DuckDB+Parquet (swap criteria) | `theory-alternatives-swap-criteria.md` |
| Pin the current version / PG support, handle the Tiger Data rebrand, install the extension + toolkit | `theory-version-rebrand-install.md` |

---

## Non-Negotiables — the rules that always apply

1. **LICENSE THE FETCH PATH, AND KNOW WHICH HALF YOU'RE IN.** The **Apache-2 core** (hypertables,
   `time_bucket`, `show_chunks`/`drop_chunks`, `approximate_row_count`, `first`/`last`/`histogram`) is
   permissively usable anywhere. Everything that makes Timescale *Timescale* — **Hypercore/columnstore
   compression, continuous aggregates, retention/compression/columnstore/reorder policies, the job
   scheduler (`add_job`/`alter_job`), `time_bucket_gapfill`+`locf`+`interpolate`, and every
   `timescaledb-toolkit` hyperfunction (`lttb`, `candlestick_agg`, `time_weight`, percentile sketches)**
   — is **Timescale License (TSL) Community**. **Self-hosting TSL Community on your own infra (on-prem
   or your own cloud) is FREE for production, including commercial internal use**; the **one
   prohibition** is offering TimescaleDB *itself* as a managed DBaaS to third parties. State the license
   tier of every feature a design leans on, in writing. (`theory-licensing-apache2-tsl-split.md`)

2. **NEVER RETURN MORE POINTS THAN THE CHART CAN DRAW.** A chart is ~800–2000 px wide; sending 130k rows
   to draw 800 pixels wastes bandwidth and freezes the browser (a cited case: **1.53 MB → ~13 KB** by
   downsampling 130k → 750 points). Downsampling happens **SERVER-SIDE in SQL** — `time_bucket`
   aggregation for OHLC/min-max, `lttb()` for shape-preserving line charts — **never** client-side after
   transferring the full series. The endpoint takes a **target resolution** (default ~800) and the
   **visible time range**; the DB returns **at most that many points**.
   (`patterns-server-side-downsampling-charts.md`)

3. **AGGREGATE METHOD MUST MATCH CHART SEMANTICS.** Candlestick/OHLC charts need `time_bucket` +
   `first()`/`max()`/`min()`/`last()` (or toolkit `candlestick_agg`) so highs/lows **survive** bucketing
   — a plain `avg()` flattens the wicks and lies about the range. Line charts that must preserve visual
   spikes use `lttb()` (Largest-Triangle-Three-Buckets), **not** `avg()` which smooths away the spikes
   that matter. min/max-per-bucket preserves extremes for monitoring. **Pick the reducer from what the
   reader is looking for — never a blanket `avg()`.** (`patterns-server-side-downsampling-charts.md`)

4. **INDEX AND CHUNK FOR THE QUERY, NOT BY DEFAULT.** Default `chunk_time_interval` is **7 days**; size
   it so a chunk's indexes + recent data fit comfortably in memory (the working set is the *recent*
   chunks — keep them inside ~25% of RAM / `shared_buffers`). Every filtered/sorted secondary column
   needs a composite index that **LEADS with the segment key and the time column** (e.g.
   `(symbol, time DESC)`); a bare `time` index forces a scan across *all* symbols. On compressed data,
   set `compress_segmentby` on the column you filter by (`WHERE symbol = …`) and `compress_orderby` on
   `time DESC`, and enable chunk-skipping range tracking on correlated columns — **wrong `segmentby` is
   the #1 cause of poor compression and slow compressed-chunk queries.**
   (`patterns-indexing-query-performance.md`, `theory-hypercore-compression.md`)

5. **CONTINUOUS AGGREGATES ARE COMPUTE-ONCE-SERVE-MANY, NOT A VIEW YOU RE-RUN.** A continuous aggregate
   **materializes** the rollup incrementally via a background refresh policy
   (`add_continuous_aggregate_policy` with `start_offset`/`end_offset`/`schedule_interval`); querying it
   reads **pre-computed buckets**, not the raw hypertable. Choose **real-time** mode (unions live raw
   data newer than the last materialization for freshness) vs **`materialized_only`** (consistent, for
   billing/reports) **deliberately**. Build **hierarchical cascades** (1m → 1h → 1d) so each dashboard
   zoom level hits a rollup sized for it. **Never** put a heavy `GROUP BY` over raw ticks on the request
   path when a cagg can serve it. (`theory-continuous-aggregates.md`)

6. **COMPRESSION / RETENTION / AGG REFRESH ARE BACKGROUND JOBS, NEVER ON THE REQUEST PATH.**
   `ALTER TABLE … SET (timescaledb.compress, …)` (or `SET (timescaledb.enable_columnstore)`) only
   **CONFIGURES** compression — nothing compresses until `add_columnstore_policy()` (legacy:
   `add_compression_policy()`) **schedules** it; same for `add_retention_policy()` and the cagg refresh
   policy. These run on Timescale's internal **job scheduler** (a TSL feature) **inside the database**,
   off the request. This mirrors the standing engineering rule that heavy/scheduled work runs off the
   request path — here the scheduler is in-DB, but the design rule is identical. State the **policy
   schedule and partial-failure behavior** of every ingest/compress/retain job.
   (`patterns-retention-data-lifecycle.md`)

7. **NEVER INVENT A NUMBER; THE DB IS THE GROUND TRUTH, GAPFILL IS EXPLICIT.** A missing bucket is
   **missing data**, not zero. `time_bucket_gapfill()` creates the missing rows; `locf()`
   (last-observation-carried-forward) and `interpolate()` then fill them — but carrying a stale price
   forward across a weekend, or linearly interpolating across a market close/halt, can **fabricate a
   value that never traded**. Gapfill/interpolation is a **deliberate, labeled transformation the reader
   can see**, never a silent backfill. (`patterns-gapfill-interpolation.md`)

8. **INGEST IN BATCHES OFF THE REQUEST PATH; UPSERT INTO COMPRESSED CHUNKS IS EXPENSIVE BY DESIGN.**
   Bulk-load with **COPY** (or batched multi-row INSERT), not row-at-a-time; for upserts at volume use
   the **COPY-into-staging-table then `INSERT … ON CONFLICT`** pattern (COPY has no `ON CONFLICT`).
   Writing into an **already-compressed** chunk forces decompression of the conflicting batch — keep the
   recent (hot, uncompressed) window wide enough that normal ingest never touches compressed chunks, and
   run heavy backfill/ingest in **worker/cron** processes, not in a request handler.
   (`patterns-ingestion-upsert.md`)

---

## Anti-Patterns — mistake → fix

| Anti-pattern (the mistake) | The fix |
|---|---|
| `SELECT *` over a raw hypertable for a chart, then downsampling in JavaScript. | Transfers megabytes to draw 800 pixels and freezes the browser. **Aggregate / `lttb` in SQL; cap the returned points** to the target resolution. |
| Using `avg()` to bucket data destined for a **candlestick** or a **spike-sensitive line** chart. | `avg()` erases the high/low wicks and the very spikes the reader is hunting. Use `first/max/min/last` (OHLC) or `candlestick_agg`, or `lttb()` for shape-preserving lines. |
| Setting `timescaledb.compress` / `enable_columnstore` and **assuming data is now compressed**. | `ALTER TABLE` only **configures**. Without `add_columnstore_policy()` (legacy `add_compression_policy()`) or a manual `convert_to_columnstore`, **zero chunks ever compress** and storage keeps growing. |
| Choosing a **high-cardinality** column (or none) as `compress_segmentby`. | A unique-per-row `segmentby` makes every segment one row, killing ratio; **no** `segmentby` makes `WHERE symbol = …` scan everything. Target a **low-cardinality, filtered** column (e.g. `symbol`). |
| Treating a continuous aggregate as a plain `VIEW` and adding a heavy refresh on every read, or **forgetting the refresh policy** so the rollup silently goes stale. | A cagg created `WITH NO DATA` and **no** `add_continuous_aggregate_policy()` **never updates**. Add the policy; pick the refresh window deliberately. |
| Indexing **only** the `time` column on a multi-series hypertable. | A query for one symbol's history scans **every** symbol's rows in each chunk. Add a composite index **leading with the series key**: `(symbol, time DESC)`. |
| Leaving `chunk_time_interval` at the **7-day default** for high-rate ingest (or shrinking it absurdly for low-rate). | Oversized chunks blow the memory working set; thousands of tiny chunks blow up planning time. **Size to the ingest rate and the recent-working-set memory budget** (chunk indexes + recent data ≤ ~25% RAM). |
| Running gapfill with `locf()`/`interpolate()` and **presenting the filled points as real observations**. | Carrying a Friday close across the weekend, or interpolating across a halt, **fabricates prices that never traded** — a "never invent a number" violation dressed as a clean line. Label/segregate filled points. |
| Reaching for **ClickHouse** (or DuckDB+Parquet, or a second OLAP store) **before** TimescaleDB's ceiling is measured. | For point lookups, joins to relational data, transactional upserts, and small batches Timescale wins and keeps you on one Postgres. The swap is justified **only by a measured aggregation-scan ceiling**, not a vibe. |
| **Row-at-a-time** INSERT for high ingest, or **upserting straight into compressed chunks**. | Single-row inserts cap throughput far below COPY; upserts that hit compressed chunks force per-batch decompression. **Batch via COPY+staging; keep ingest in the uncompressed hot window.** |
| Citing `timescale.com` / `docs.timescale.com` URLs or the **old feature names** as authoritative without noting the rebrand. | Docs now live at **`tigerdata.com`**; functions were renamed (columnstore/Hypercore terms). **Pin to the installed 2.27.0 line and the current docs host.** |
| Putting a **poller/timer or a long-running ingest loop on the serverless API path** to "keep data fresh". | Scheduled compression/retention/refresh belong to the **in-DB job scheduler**; external ingest belongs in a **worker/cron** — never a request handler the platform can freeze on response close. |

---

## Output Contract — the grading rubric

A design or implementation produced under this skill is **done** only when:

1. **License tier stated.** Every TSL-Community feature the design uses (compression, caggs, policies,
   gapfill, toolkit) is named as TSL, with a one-line confirmation that **self-hosted commercial use is
   allowed** and we are not building a third-party DBaaS. Apache-core features are noted as
   unrestricted. (NN1)
2. **Chart endpoints are bounded.** Any chart-feeding query returns **≤ target resolution** points
   (default ~800), downsampled **in SQL**, with the **reducer matched to the chart type** (OHLC vs
   `lttb` vs min/max). No `SELECT *`-then-downsample-in-JS path exists. (NN2, NN3)
3. **Chunks + indexes are sized for the query.** `chunk_time_interval` is justified against ingest rate
   + memory budget; every filtered/sorted column has a **composite index leading with the series key +
   `time DESC`**; compressed tables set the right `segmentby`/`orderby`. (NN4)
4. **Rollups are materialized, not re-run.** Dashboard aggregations are served by **continuous
   aggregates** with an explicit **refresh policy**; real-time vs `materialized_only` is a stated choice;
   hierarchical cascades exist where multiple zoom levels are served. (NN5)
5. **Heavy work is off the request path.** Compression, retention, and cagg refresh run on the **in-DB
   scheduler**; ingest/backfill runs in **worker/cron**. Each job's **schedule + partial-failure
   behavior** is stated. (NN6, NN8)
6. **No fabricated numbers.** Gapfill/interpolation is **explicit and labeled**; no `locf`/`interpolate`
   silently presents a filled point as a traded value. Failed fetches surface as missing, never as a
   backfilled value. (NN7)
7. **Ingest is batched.** COPY / staging-table upsert is used at volume; the hot uncompressed window is
   wide enough that routine ingest never decompresses a chunk. (NN8)
8. **The R-SCALE tier is named.** The design states which tier it survives (1× demo / 100× traction /
   10,000× product) and what breaks at the next tier, in **numbers** — and the engine choice
   (TimescaleDB vs an alternative) is justified by a **measured** ceiling, not a vibe.
9. **Versions/host are current.** Code targets the **2.27.0** line on **PG 15–18**; docs/links use
   **`tigerdata.com`**; renamed functions use the current names (with the legacy alias noted where
   relevant). No claim rests on a hallucinated function or option.

---

## References

| File | When to read |
|---|---|
| `theory-licensing-apache2-tsl-split.md` | The exact Apache-2 vs Timescale-License (TSL) Community feature split, the self-host-commercial allowance, the single DBaaS prohibition, and how to reason about it for THIS product line. The load-bearing licensing doc. |
| `theory-hypertables-chunking.md` | What a hypertable IS, how chunking works, and how to size chunks. The foundational mental model. |
| `theory-continuous-aggregates.md` | Continuous aggregates end to end: creation, refresh policies, real-time vs materialized-only, hierarchical cascades, and the chunk-interval-×10 detail. |
| `theory-hypercore-compression.md` | Hypercore (rowstore+columnstore) compression: how it works, the encoders, segmentby/orderby tuning, ratios, and the query implications. |
| `patterns-server-side-downsampling-charts.md` | THE headline recipe: serve a chart from the DB returning at most ~N points, picking the reducer by chart type. Runnable SQL + a FastAPI endpoint. |
| `patterns-gapfill-interpolation.md` | `time_bucket_gapfill`, `locf`, `interpolate` — filling missing buckets honestly, and the market-data traps. |
| `patterns-ingestion-upsert.md` | High-throughput ingestion and correct upserts, including into/around compressed chunks. Off-request-path discipline. |
| `patterns-indexing-query-performance.md` | Indexing and writing fast time-series queries against hypertables (and compressed chunks). The Tier-2/3 scale doc. |
| `patterns-retention-data-lifecycle.md` | The data lifecycle: retention policies, downsample-then-drop, tiering, and how compression+caggs+retention compose. |
| `patterns-python-connection-layer.md` | Connecting to TimescaleDB from Python/FastAPI: drivers, pooling, async, SQLAlchemy/ORM caveats, and where queries live. New-ground for this product line. |
| `patterns-toolkit-hyperfunctions.md` | The timescaledb-toolkit hyperfunctions beyond lttb: financial OHLC, time-weighted/stats aggregates, ASAP smoothing, counters/gauges, percentile approx — what they are and when to reach for them. |
| `theory-alternatives-swap-criteria.md` | The honest decision doc: TimescaleDB vs native Postgres partitioning vs ClickHouse vs DuckDB+Parquet — with measured-number swap criteria, not vibes. |
| `theory-version-rebrand-install.md` | Pinning the current line and the operational facts a builder needs: version, PG support, the Tiger Data rebrand, install, extension setup, and the docs-host gotcha. |
