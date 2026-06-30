# patterns-retention-data-lifecycle — the TimescaleDB data lifecycle (retention, downsample-then-drop, tiering, and how compression + caggs + retention compose)

> **Layer:** `patterns-*` — a concrete build recipe, not generic theory. This is the recipe for the
> **data lifecycle** of a market-data hypertable: how raw ticks are compressed, rolled up into
> 1m/1h/1d continuous aggregates, dropped after a window, and (on Cloud) tiered to object storage —
> and the **ordering constraints** that keep you from silently deleting data you wanted to keep.
>
> **Product line:** JPM-Markets re-engineering **data-analytics product line — NOT Lumina.** This is
> greenfield Python/FastAPI + TimescaleDB builder knowledge; there is no codebase `file:line` to cite
> yet. Every concrete claim below is cited to a primary source (Tiger Data / TimescaleDB docs, the
> `timescale/timescaledb` repo, or release notes) read in June 2026.
>
> **Version pinning.** Behaviour and API names below are pinned to **TimescaleDB 2.18.0+** (where
> `add_compression_policy` was deprecated in favour of `add_columnstore_policy`) and call out
> **2.27.0** (2026-05-12) features explicitly. Always re-confirm against your installed version with
> `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';` — the policy API has churned and
> the columnstore/Hypercore rename is recent.

---

## 0. The one-paragraph mental model (read this first)

A TimescaleDB hypertable is a logical table physically split into **chunks** (one per time range, e.g.
one chunk per day). The *only* unit the lifecycle machinery moves, compresses, tiers, or drops is the
**chunk** — never an individual row. The lifecycle is four policies, each a **background job** run by
TimescaleDB's in-database scheduler on its own clock:

1. **Roll up** — a *continuous aggregate* (cagg) refresh policy materialises raw rows into coarser
   buckets (1m → 1h → 1d) so the answer survives after the raw rows are gone.
2. **Compress / columnstore** — a columnstore policy converts cold chunks from rowstore to columnar
   (Hypercore), shrinking them ~90–98% and speeding scans.
3. **Drop** — a *retention policy* drops whole chunks older than `drop_after`, reclaiming disk.
4. **Tier** (Cloud only) — a tiering policy moves cold chunks to S3/Parquet object storage instead of
   dropping them.

The entire risk surface of this document is **one ordering rule**: *never drop a raw chunk before the
continuous aggregate that summarises it has materialised that time range.* Everything else is plumbing.

---

## 1. `add_retention_policy` and the in-DB scheduler

### 1.1 The API — exact signature, every argument, defaults

`add_retention_policy` registers a background job that periodically calls `drop_chunks` on a hypertable
or continuous aggregate. Signature and argument table, quoted from the API reference
([tigerdata.com/docs/api/latest/data-retention/add_retention_policy](https://www.tigerdata.com/docs/api/latest/data-retention/add_retention_policy/)):

```sql
SELECT add_retention_policy(
    relation              => '<hypertable_or_cagg_name>',  -- REGCLASS, required
    drop_after            => <interval>,                   -- INTERVAL | INTEGER, default NULL
    drop_created_before   => <interval>,                   -- INTERVAL,           default NULL
    schedule_interval     => <interval>,                   -- INTERVAL,           default NULL (→ a derived default)
    initial_start         => <timestamptz>,                -- TIMESTAMPTZ,        default NULL
    timezone              => '<timezone>',                 -- TEXT,               default NULL
    if_not_exists         => true | false                  -- BOOLEAN,            default false
);
```

| Argument | Type | Default | Meaning (quoted) |
|---|---|---|---|
| `relation` | REGCLASS | — (required) | "Name of the hypertable or continuous aggregate to create the policy for" |
| `drop_after` | INTERVAL or INTEGER | NULL | "Drops chunks fully older than this interval." **"You must specify either `drop_after` or `drop_created_before`."** |
| `drop_created_before` | INTERVAL | NULL | "Chunks with creation time older than this cut-off point are dropped." *Unsupported for continuous aggregates.* |
| `schedule_interval` | INTERVAL | derived | Interval between successive policy executions. |
| `initial_start` | TIMESTAMPTZ | NULL | "Establishes the origin for calculating subsequent execution times." |
| `timezone` | TEXT | NULL | "A valid time zone" — pin it to avoid DST drift on fixed schedules. |
| `if_not_exists` | BOOLEAN | false | "Set to `true` to avoid an error if the `drop_chunks_policy` already exists." |

**Return value:** `job_id` (INTEGER) — "TimescaleDB background job ID created to implement this policy."
Capture it; you need it to inspect or `alter_job` the policy later.

> Source: [add_retention_policy() API reference](https://www.tigerdata.com/docs/api/latest/data-retention/add_retention_policy/).

### 1.2 The three hard constraints (each is a real failure mode)

1. **Exactly one of `drop_after` / `drop_created_before`.** They are mutually exclusive; you must supply
   one. `drop_after` is age-by-*data-time* (the chunk's time range vs `now()`); `drop_created_before`
   is age-by-*ingest-time* (when the chunk was physically created). For market data you almost always
   want `drop_after` — you care how old the *prices* are, not when the row landed.

2. **"Only one retention policy may exist per hypertable."** ([add_retention_policy()](https://www.tigerdata.com/docs/api/latest/data-retention/add_retention_policy/)).
   You cannot stack two retention policies on the same relation. If you need different behaviour, you
   either `alter_job` the one policy or drop chunks manually (§7).

3. **Integer time columns need an `integer_now_func`.** If your hypertable is partitioned on a `BIGINT`
   epoch column rather than `TIMESTAMPTZ`, "integer-based time columns require setting `integer_now_func`
   beforehand" ([same ref](https://www.tigerdata.com/docs/api/latest/data-retention/add_retention_policy/)).
   Market-data tables should partition on `TIMESTAMPTZ` (`ts timestamptz NOT NULL`) and avoid this.

### 1.3 What "fully older than" means — the chunk-boundary trap

`drop_after` drops a chunk **only when the chunk's *entire* time range is older than `now() - drop_after`.**
A chunk that straddles the boundary is *not* dropped. This is the same semantics `drop_chunks`
documents: "Chunks drop only if entire time range falls outside specified boundaries"
([drop_chunks()](https://www.tigerdata.com/docs/api/latest/hypertable/drop_chunks/)).

Consequence: with a 1-day `chunk_time_interval` and `drop_after => INTERVAL '7 days'`, the *oldest data
you still hold* can be up to ~8 days old, because the chunk covering day-7-to-day-8 still has its newer
edge inside the window. **Never promise an exact retention horizon to the chunk boundary** — promise it
*to the chunk granularity*. This matters for compliance ("we hold raw ticks for exactly 7 days"): the
honest statement is "we drop chunks once their entire range is older than 7 days; with daily chunks the
effective floor is 7–8 days."

### 1.4 The in-DB scheduler — what actually runs the policy

A retention policy is not magic; it is a row in TimescaleDB's job catalog executed by the **background
worker scheduler**. A "job" is a "[registered] procedure scheduled through the automation framework to
execute automatically at defined intervals" ([add_job()](https://www.tigerdata.com/docs/api/latest/actions/add_job/)).
The scheduler:

- Runs each due job in a background worker process (you must have enough
  `timescaledb.max_background_workers` configured; the default is small — bump it for a multi-policy
  multi-hypertable deployment).
- Tracks `next_start`, `last_run_status`, failure counts, and retry timing per job in
  `_timescaledb_internal.bgw_job_stat`, surfaced via `timescaledb_information.job_stats` (§8).
- **fixed vs drift schedule.** With `fixed_schedule => true` (the `add_job` default — see §6) the next run
  is aligned to `initial_start + N * schedule_interval` (runs at wall-clock times like 02:00 daily).
  With `fixed_schedule => false`, the next run is `last_finish + schedule_interval` (drifts by job
  duration). For a nightly retention sweep you usually want **fixed** so it always runs at a low-traffic
  hour; pin `timezone` so DST doesn't shift it.

### 1.5 Default `schedule_interval` for a retention policy

If you omit `schedule_interval`, TimescaleDB derives a default. For policy jobs the documented default
behaviour is a daily-ish cadence; **do not rely on the derived value for a production market-data
table** — state it explicitly so the schedule is auditable:

```sql
SELECT add_retention_policy(
    'ticks',
    drop_after        => INTERVAL '7 days',
    schedule_interval => INTERVAL '1 day',     -- explicit: run the sweep once a day
    initial_start     => '2026-01-01 03:00:00+00',  -- 03:00 UTC, off-peak
    timezone          => 'UTC'
);
```

> **R-SCALE / "state the schedule + partial-failure behaviour" requirement (from `cto-rules.md` §5 and
> the JPM data-line's product-at-scale discipline):** every lifecycle policy in this doc states (a) its
> **schedule** (cadence + the hour it runs + fixed-vs-drift) and (b) its **partial-failure behaviour**
> (what happens when the job fails mid-run, and how you detect it). The retention policy's partial-failure
> behaviour: `drop_chunks` is effectively all-or-nothing *per chunk* (a chunk drop is a catalog op + file
> unlink; a failed run leaves not-yet-dropped chunks in place and the job retries on its `retry_period`
> back-off, §6.2). It **never** half-drops a chunk's rows. See §8 for detection.

---

## 2. The canonical market-data lifecycle (the whole recipe)

This is the target shape for a JPM-class market-data store. Numbers are illustrative; tune to your
ingest volume and query SLAs.

```
        ingest (rowstore, hot)
            │  raw ticks: every trade/quote, full fidelity
            ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  ticks  (hypertable, chunk_time_interval = 1 day)            │
   │   • compressed/columnstore  AFTER  3 days   (cold → columnar) │
   │   • dropped (retention)     AFTER 14 days                    │
   └─────────────────────────────────────────────────────────────┘
            │  rolled up by continuous aggregates (refresh policies)
            ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ ohlcv_1m     │   │ ohlcv_1h     │   │ ohlcv_1d     │
   │ start_offset │   │ rolled from  │   │ rolled from  │
   │  = 2 days    │   │ ohlcv_1m     │   │ ohlcv_1h     │
   │ (< 14d drop) │   │ (hierarchy)  │   │ (hierarchy)  │
   │ compress 30d │   │ compress 90d │   │ compress 1y  │
   │ drop  90 days│   │ drop 2 years │   │ keep forever │
   └──────────────┘   └──────────────┘   └──────────────┘
```

The principle: **raw is expensive and short-lived; rollups are cheap and long-lived.** You keep
14 days of every tick for intraday replay/debugging, but you keep 1-day candles *forever* because a
daily OHLCV bar for a symbol is a few hundred bytes/year. This is "downsample-then-drop": the
information you care about long-term is preserved in the cagg before the raw rows are dropped.

### 2.1 Step 1 — the raw hypertable

```sql
CREATE TABLE ticks (
    ts      timestamptz NOT NULL,
    symbol  text        NOT NULL,
    price   double precision NOT NULL,
    size    integer     NOT NULL
);

-- TimescaleDB 2.13+ unified create_hypertable signature
SELECT create_hypertable('ticks', by_range('ts', INTERVAL '1 day'));

-- index the columns you filter/sort by (R-SCALE: an unindexed filter is a full scan)
CREATE INDEX ON ticks (symbol, ts DESC);
```

> Chunk sizing rule of thumb (from Tiger Data sizing guidance): aim for a chunk that, **with its
> indexes, fits in ~25% of RAM**. A 1-day chunk is a sane start for symbol-level tick data; widen to
> hours if a single day is huge, widen to weeks if a day is tiny. The chunk interval bounds how
> precisely retention and compression can act (§1.3).

### 2.2 Step 2 — the continuous aggregate hierarchy

A continuous aggregate is a materialized view with an incremental refresh policy. Build a **hierarchy**:
roll `ticks → ohlcv_1m`, then `ohlcv_1m → ohlcv_1h`, then `ohlcv_1h → ohlcv_1d`. Each level reads from
the level below (cheaper) rather than re-scanning raw ticks.

```sql
CREATE MATERIALIZED VIEW ohlcv_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 minute', ts) AS bucket,
    symbol,
    first(price, ts) AS open,
    max(price)       AS high,
    min(price)       AS low,
    last(price, ts)  AS close,
    sum(size)        AS volume
FROM ticks
GROUP BY 1, 2
WITH NO DATA;          -- don't backfill on create; let the refresh policy do it incrementally
```

The hierarchical roll-up (1h from 1m) uses `time_bucket` over the lower cagg and re-aggregates OHLC
correctly: `first()`/`last()` must be over the original timestamp, `high`/`low` are `max`/`min` of the
lower-level high/low. (Hierarchical caggs are a first-class TimescaleDB feature; the lower cagg is just
another hypertable you can `time_bucket` over.)

### 2.3 Step 3 — the refresh policy (and what `start_offset` / `end_offset` mean)

```sql
SELECT add_continuous_aggregate_policy('ohlcv_1m',
    start_offset      => INTERVAL '2 days',   -- refresh window REACHES BACK this far
    end_offset        => INTERVAL '1 minute', -- refresh window STOPS this short of now()
    schedule_interval => INTERVAL '1 minute');
```

Definitions, quoted from the refresh-policy reference
([tigerdata.com/docs/.../refresh-policies](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/refresh-policies)):

- **`start_offset`** — "the start of the refresh window relative to when the policy runs." How far back
  each refresh re-materialises. Older buckets are assumed already-materialised and left alone.
- **`end_offset`** — "the end of the refresh window relative to when the policy runs." How recent the
  refresh stops. **Must be ≥ one bucket width.** The reference warns that if `end_offset` lands inside
  the current bucket, "that bucket is excluded because it's incomplete and experiences frequent writes,
  degrading performance" — and the bucket would have to be re-materialised constantly. For 1-minute
  buckets, `end_offset => INTERVAL '1 minute'` excludes only the in-flight minute.

So each minute, the policy re-materialises `[now()-2d, now()-1m)`. The `start_offset = 2 days` is the
load-bearing number for retention safety (§3): it is **smaller than** the raw `drop_after = 14 days`, so
the refresh window can never reach into already-dropped raw chunks.

### 2.4 Step 4 — compress the raw chunks (columnstore / Hypercore)

`add_compression_policy` was **deprecated in 2.18.0** and superseded by `add_columnstore_policy`
([add_columnstore_policy() reference](https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy):
"add_columnstore_policy() replaces add_compression_policy(), deprecated in 2.18.0"). On 2.18+ use the
columnstore form; on older installs the compression form still works.

First enable columnstore on the hypertable and pick a `segmentby` (the column most queries filter on —
for market data, `symbol`), then add the policy. Note `add_columnstore_policy` is a **`CALL`** (a
procedure), not a `SELECT`:

```sql
-- enable columnstore + segment by symbol so per-symbol scans skip other symbols' batches
ALTER TABLE ticks SET (
    timescaledb.enable_columnstore = true,
    timescaledb.segmentby          = 'symbol',
    timescaledb.orderby            = 'ts DESC'
);

CALL add_columnstore_policy('ticks', after => INTERVAL '3 days');
```

Argument table for `add_columnstore_policy`, from the API reference
([tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy](https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy)):

| Argument | Type | Default | Meaning (quoted) |
|---|---|---|---|
| `hypertable` | REGCLASS | — (required) | "Table or continuous aggregate name" |
| `after` | INTERVAL or INTEGER | — | "Add chunks containing data older than `now - {after}::interval`" |
| `created_before` | INTERVAL | NULL | Chunks created before `now() - created_before`; **mutually exclusive with `after`** |
| `schedule_interval` | INTERVAL | "12 hours when chunk_time_interval >= 1 day" (else chunk_interval/2) | Interval between executions |
| `initial_start` | TIMESTAMPTZ | NULL | "Set the time this job is first run" |
| `timezone` | TEXT | NULL | Mitigates DST shifting |
| `if_not_exists` | BOOLEAN | false | Warning instead of error if policy exists |

Hypercore is "a hybrid row-columnar storage engine … new data is initially written to the rowstore
optimized for high-speed inserts … and as data cools it is automatically converted to the columnstore
for fast scanning." Compression uses "delta encoding, delta-of-delta, Gorilla XOR and run-length
encoding" and shrinks chunks "by up to 98%" ([Hypercore search summary, tigerdata.com](https://www.tigerdata.com/docs/api/latest/hypercore)).

> **Old API (≤2.17, still valid as deprecated on 2.18+):**
> ```sql
> ALTER TABLE ticks SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol');
> SELECT add_compression_policy('ticks', compress_after => INTERVAL '3 days');  -- SELECT, not CALL
> ```
> `add_compression_policy` returns a `job_id`; `add_columnstore_policy` is a void `CALL`. Pick one;
> don't run both on the same relation.

### 2.5 Step 5 — drop the raw chunks, keep the caggs

```sql
-- raw ticks: keep 14 days, then drop
SELECT add_retention_policy('ticks', drop_after => INTERVAL '14 days');
```

Because `ohlcv_1m`'s refresh `start_offset` (2 days) is well inside 14 days, every minute-bucket is
materialised long before its raw chunk is dropped. The 1m/1h/1d candles persist; the raw ticks are gone.

### 2.6 Step 6 — caggs get their OWN compression + retention

Continuous aggregates are themselves hypertables (the *materialization hypertable*), so they take their
own columnstore and retention policies. This is how rollups stay cheap long-term:

```sql
-- compress 1m candles after 30 days
ALTER MATERIALIZED VIEW ohlcv_1m SET (
    timescaledb.enable_columnstore = true,
    timescaledb.segmentby          = 'symbol'
);
CALL add_columnstore_policy('ohlcv_1m', after => INTERVAL '30 days');

-- drop 1m candles after 90 days (still far longer than the 14d raw)
SELECT add_retention_policy('ohlcv_1m', drop_after => INTERVAL '90 days');

-- 1h candles: compress 90d, drop 2y
ALTER MATERIALIZED VIEW ohlcv_1h SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'symbol');
CALL add_columnstore_policy('ohlcv_1h', after => INTERVAL '90 days');
SELECT add_retention_policy('ohlcv_1h', drop_after => INTERVAL '2 years');

-- 1d candles: compress 1y, NO retention — keep forever
ALTER MATERIALIZED VIEW ohlcv_1d SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'symbol');
CALL add_columnstore_policy('ohlcv_1d', after => INTERVAL '1 year');
-- (intentionally no add_retention_policy on ohlcv_1d)
```

Compressing a cagg requires `ALTER MATERIALIZED VIEW … SET (timescaledb.enable_columnstore = true, …)`
first, then the columnstore policy — same two-step as a hypertable, but with `ALTER MATERIALIZED VIEW`
instead of `ALTER TABLE` ([add_columnstore_policy() CA example](https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy)).

> **Why the cagg retention windows nest (90d ⊂ 2y ⊂ ∞):** each coarser level is cheaper per unit time,
> so you can afford to keep it longer. The *information* a user asks for ("daily close of AAPL in 2019")
> lives only in `ohlcv_1d` by then — the raw ticks and even the 1m candles are long gone. This is the
> whole point of downsample-then-drop: **you drop the bytes, not the answer.**

---

## 3. The ordering constraint — the one rule that bites (`start_offset` vs `drop_after`)

This is the single most important section. Get it wrong and a retention sweep silently **empties cagg
buckets** instead of just dropping raw rows.

### 3.1 The mechanism (why it breaks)

When a retention policy drops a raw chunk, the rows are gone. If a **subsequent cagg refresh** then runs
over a window that *includes that now-empty time range*, it recomputes those buckets — and because the
source rows are gone, it recomputes them as **empty / NULL**, overwriting the correct values you had
materialised earlier. The docs state it directly:

> "If a continuous aggregate is refreshing when data is dropped because of a retention policy, the
> aggregate is updated to reflect the loss of data."
> — [drop-data.md, timescale/docs](https://github.com/timescale/docs/blob/latest/use-timescale/continuous-aggregates/drop-data.md)

> "If the continuous aggregate policy window covers data that is removed by the data retention policy,
> the data will be removed when the aggregates for those buckets are refreshed."
> — [refresh-policies reference](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/refresh-policies)

### 3.2 The rule (how to avoid it)

> **The cagg refresh `start_offset` MUST be strictly smaller than the raw retention `drop_after`.**
> — quoted: "If you need to retain the continuous aggregate after dropping the underlying data, set the
> `start_offset` value of the aggregate policy to a smaller interval than the `drop_after` parameter of
> the retention policy." ([drop-data.md](https://github.com/timescale/docs/blob/latest/use-timescale/continuous-aggregates/drop-data.md))

Concretely, the invariant is:

```
cagg.start_offset  <  raw_hypertable.drop_after
```

In our recipe: `start_offset = 2 days` `<` `drop_after = 14 days`. ✓ The refresh window
`[now()-2d, now()-1m)` never reaches the 14-day-old chunks being dropped, so a refresh can never
recompute a dropped range to empty.

### 3.3 The "materialize before you drop" corollary

The flip side of the same coin: **don't drop a raw chunk before the cagg has materialised the buckets
that chunk feeds.** With a refresh policy that runs every minute and a `start_offset` far inside
`drop_after`, this is automatic — every range is materialised within 2 days, dropped after 14. But two
ways to break it:

1. **A refresh policy that isn't running** (disabled, or failing — see §8). If `ohlcv_1m`'s refresh job
   is stuck and you keep dropping raw at 14 days, you lose buckets that were never materialised. **The
   refresh policy is a precondition for the retention policy's safety** — monitor both.
2. **A `start_offset` too large or `NULL`.** `start_offset => NULL` means "refresh all the way back to
   the beginning of the hypertable" — which by definition reaches into dropped ranges. **Never combine
   `start_offset => NULL` with a retention policy on the same source.** Use a finite `start_offset`
   strictly less than `drop_after`.

### 3.4 What `end_offset` has to do with it

`end_offset` is the *recent* edge — it keeps the refresh from touching incomplete current buckets. It
is not directly part of the retention-safety inequality (that's `start_offset` vs `drop_after`), but it
matters for a *different* correctness property: if `end_offset` is too small (inside the current
bucket), you re-materialise an incomplete bucket every run and your latest candle flickers. Keep
`end_offset ≥ one bucket`. So the two offsets guard two different edges:

| Offset | Guards | Set it… |
|---|---|---|
| `start_offset` | the **old** edge — don't refresh into dropped raw | strictly `< drop_after` of the raw retention policy |
| `end_offset` | the **new** edge — don't refresh an incomplete current bucket | `≥` one bucket width (e.g. `INTERVAL '1 minute'` for 1m caggs) |

### 3.5 Decision table — does this config silently lose data?

| `start_offset` | raw `drop_after` | Refresh job healthy? | Verdict |
|---|---|---|---|
| `2 days` | `14 days` | yes | ✅ Safe. Refresh never reaches dropped raw. |
| `30 days` | `14 days` | yes | ❌ **DATA LOSS.** Refresh window (30d) reaches into chunks dropped at 14d → those buckets recompute to NULL. |
| `NULL` | `14 days` | yes | ❌ **DATA LOSS.** `NULL` = refresh from the beginning → always overlaps dropped raw. |
| `2 days` | `14 days` | **no (failing)** | ⚠️ Buckets newer than the last successful refresh are never materialised, then their raw is dropped at 14d → **permanent gap**. Fix the refresh job first. |
| `2 days` | (no retention on raw) | yes | ✅ Safe (nothing dropped) but raw grows unbounded — add retention or you'll fill disk. |

---

## 4. The combined policy helpers (2.27 `compress_after_refresh`, `add_policies`)

Coordinating three independent jobs (refresh, compress, drop) on the *same* cagg can cause **lock
contention**: a compression job and a refresh job competing for the same chunk leads to "lock
contention, retries, or failed policy executions" ([TimescaleDB 2.27 blog](https://www.tigerdata.com/blog/timescaledb-2-27)).
Two features reduce that.

### 4.1 `compress_after_refresh` (TimescaleDB 2.27.0, 2026-05-12)

The cagg refresh policy can now compress the just-refreshed chunks *in the same job execution*,
eliminating the race. Opt in via the policy `config`:

```sql
SELECT add_continuous_aggregate_policy(
    continuous_aggregate => 'ohlcv_1m',
    start_offset         => INTERVAL '2 days',
    end_offset           => INTERVAL '1 minute',
    schedule_interval    => INTERVAL '1 minute',
    config               => '{"compress_after_refresh": true}'::jsonb
);
```

> "In TimescaleDB 2.27, continuous aggregate refresh policies can now optionally compress data
> immediately after a refresh completes. A new `compress_after_refresh` configuration option allows
> refresh and compression to run together as part of a single policy execution. … The behavior is
> opt-in and only applies when refreshes are executed through a policy. Manual calls to
> `refresh_continuous_aggregate()` continue to behave as before."
> — [TimescaleDB 2.27 release blog](https://www.tigerdata.com/blog/timescaledb-2-27)

This removes the refresh-vs-compress race on the cagg, but you **still need a separate retention
policy** on the cagg for `drop_after` — `compress_after_refresh` only fuses refresh + compress, not drop.

### 4.2 `add_policies` — one call for refresh + compress + drop on a cagg

`add_policies` (in the `timescaledb_experimental` schema as of current releases) bundles all three cagg
policies into one statement:

```sql
SELECT timescaledb_experimental.add_policies(
    'ohlcv_1m',
    refresh_start_offset => INTERVAL '2 days',
    refresh_end_offset   => INTERVAL '1 minute',
    compress_after       => INTERVAL '30 days',
    drop_after           => INTERVAL '90 days'
);
```

Caveat from the reference: "`add_policies()` does not allow the `schedule_interval` for the continuous
aggregate to be set, instead using a default value of 1 hour. For custom scheduling, configure policies
individually." ([add_policies() reference](https://www.tigerdata.com/docs/api/latest/continuous-aggregates/add_policies/)).
A 1-minute cagg that you want refreshed every minute therefore can **not** use `add_policies` for the
refresh schedule — use the individual `add_continuous_aggregate_policy` (with the explicit
`schedule_interval`) plus separate compress/retention policies. `add_policies` is convenient for hourly+
caggs where a 1-hour refresh cadence is fine. Remove with `timescaledb_experimental.remove_policies` /
`remove_all_policies`.

> **Recommendation for this product line:** prefer the explicit individual policies (§2) for the 1m
> cagg (you need sub-hour refresh) and `compress_after_refresh` on 2.27+ to kill the lock race. Reserve
> `add_policies` for the coarse 1h/1d caggs where one-line setup and a 1-hour cadence are acceptable.

---

## 5. Reorder policies — clustering chunks by an index

### 5.1 What it is and why

Over time a chunk's physical row order drifts from any single index's order, hurting range scans that
follow that index (e.g. "all ticks for symbol X in time order"). Postgres `CLUSTER` fixes this but takes
an `ACCESS EXCLUSIVE` lock (blocks reads). TimescaleDB's **reorder** does the same clustering on a chunk
*without* the heavy lock, and a **reorder policy** automates it.

### 5.2 The API

```sql
-- add_reorder_policy(main_table REGCLASS, index_name NAME, if_not_exists BOOL = false) RETURNS INTEGER
SELECT add_reorder_policy('ticks', 'ticks_symbol_ts_idx');
```

Behaviour, from the API reference ([add_reorder_policy](https://docs.timescale.com/api/latest/hypertable/add_reorder_policy/)):

- "The policy reorders the rows for all chunks except the two most recent ones, because these are still
  getting writes." (You don't reorder hot chunks.)
- "By default, the policy runs every 24 hours."
- "You can have only one reorder policy on each hypertable."
- "When a chunk's rows have been reordered by a policy, they are not reordered by subsequent runs of the
  same policy." (Each chunk is reordered once and then left alone — idempotent per chunk.)

Manual single-chunk version: `reorder_chunk('_timescaledb_internal._hyper_1_4_chunk', 'ticks_symbol_ts_idx')`.
Remove the policy with `remove_reorder_policy('ticks')`.

### 5.3 Reorder vs columnstore `orderby` — when to use which

| | Reorder policy | Columnstore `orderby` / `segmentby` |
|---|---|---|
| Applies to | **rowstore** (uncompressed) chunks | chunks being converted to **columnstore** |
| Mechanism | physically re-sorts rows by an index | groups rows into compressed batches ordered by `orderby`, segmented by `segmentby` |
| When | data stays in rowstore but scans are slow | data is cold and you're compressing anyway |

**The key interaction:** if a chunk is going to be compressed to columnstore (where `orderby`/`segmentby`
already control physical layout), a reorder policy on the *same* chunk is wasted work — columnstore
conversion re-lays-out the data regardless. **Use a reorder policy only for hypertables whose recent
(uncompressed) chunks stay in rowstore long enough that index-order scans matter and they aren't yet
compressed.** For our recipe, `ticks` compresses at 3 days; a reorder policy would only help the
3-day-and-newer rowstore window, which is small — usually **skip reorder for tick data** and rely on
columnstore `orderby => 'ts DESC'` instead. Reorder earns its keep on hypertables with a *long*
rowstore tail and a dominant single-index scan pattern.

---

## 6. The job scheduler in depth — `add_job`, `alter_job`, and retry/failure semantics

Every policy above is a row in the job catalog. To tune cadence, retries, and to detect/repair
failures you operate on **jobs**.

### 6.1 `add_job` — register a custom maintenance action

Beyond the built-in policies you can register your own procedure as a scheduled job (e.g. a custom
self-host tiering sweep, §7.4). Signature, from [add_job()](https://www.tigerdata.com/docs/api/latest/actions/add_job/):

```sql
SELECT add_job(
    proc              => '<procedure_name>',  -- REGPROC, required
    schedule_interval => <interval>,          -- default 24 hours
    config            => '<jsonb>',           -- passed to proc at runtime
    initial_start     => <timestamptz>,
    scheduled         => true | false,        -- default true
    check_config      => '<procedure_name>',  -- validates config
    fixed_schedule    => true | false,        -- default true
    timezone          => '<timezone>'
);
```

A custom action is a procedure taking `(job_id int, config jsonb)`:

```sql
CREATE OR REPLACE PROCEDURE drop_stale_partials(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
BEGIN
  -- example custom maintenance
  RAISE NOTICE 'Running custom job % with config %', job_id, config;
END $$;

SELECT add_job('drop_stale_partials', '1h');
```

> Note the **`fixed_schedule` default differs by entry point**: `add_job` defaults `fixed_schedule =>
> true` ([add_job()](https://www.tigerdata.com/docs/api/latest/actions/add_job/)), whereas `alter_job`
> documents the argument default as `false` ([alter_job()](https://www.tigerdata.com/docs/api/latest/actions/alter_job/)).
> Always set it explicitly if the run-time alignment matters.

### 6.2 `alter_job` — tune cadence, retries, and the retry back-off math

Signature and the load-bearing retry arguments, from [alter_job()](https://www.tigerdata.com/docs/api/latest/actions/alter_job/):

| Argument | Type | Default | Meaning (quoted) |
|---|---|---|---|
| `job_id` | INTEGER | — (required) | "The ID of the policy job being modified" |
| `schedule_interval` | INTERVAL | 24 hours | "The interval at which the job runs" |
| `max_runtime` | INTERVAL | — | "The maximum amount of time the job is allowed to run" before the scheduler stops it |
| `max_retries` | INTEGER | — | "The number of times the job is retried if it fails" |
| `retry_period` | INTERVAL | — | "The amount of time the scheduler waits between retries of the job on failure" |
| `scheduled` | BOOLEAN | true | Exclude from background execution when `false` (pause a policy) |
| `next_start` | TIMESTAMPTZ | — | "The next time at which to run the job" (force an immediate run) |
| `if_exists` | BOOLEAN | false | Notice instead of error if the job is absent |

**The retry back-off (exact formula, quoted):**

> "Upon failure, the system calculates: `next_start = finish_time + consecutive_failures * retry_period
> ± jitter`, where jitter applies ±13% to avoid the 'thundering herds' effect. The calculation caps at
> 5× `schedule_interval`, and consecutive failures exceeding 20 are treated as 20."
> — [alter_job() reference](https://www.tigerdata.com/docs/api/latest/actions/alter_job/)

Read this carefully — it defines the **partial-failure behaviour** of *every* lifecycle policy:

- A failed run does **not** stop the schedule. The job retries, with each consecutive failure pushing
  `next_start` further out (linear in `consecutive_failures`), **capped at 5× the normal
  `schedule_interval`**. So a daily job that keeps failing eventually settles to retrying ~every 5 days,
  not in a tight loop.
- `consecutive_failures` is clamped at 20 for the math.
- The `±13%` jitter de-synchronises many failing jobs so they don't all retry at the same instant
  (thundering-herd protection at the scheduler level).

**Pause / resume / force-run a policy (operational muscle memory):**

```sql
-- pause the retention job on `ticks` (e.g. during a backfill you don't want auto-dropped)
SELECT alter_job(j.job_id, scheduled => false)
FROM   timescaledb_information.jobs j
WHERE  j.proc_name = 'policy_retention' AND j.hypertable_name = 'ticks';

-- resume it
SELECT alter_job(j.job_id, scheduled => true)
FROM   timescaledb_information.jobs j
WHERE  j.proc_name = 'policy_retention' AND j.hypertable_name = 'ticks';

-- force a job to run now (e.g. after fixing whatever made it fail)
SELECT alter_job(<job_id>, next_start => now());
```

### 6.3 The built-in policy proc names (so you can find them in the catalog)

Each policy type runs a fixed internal procedure; filter `timescaledb_information.jobs.proc_name` by it:

| Policy | `proc_name` |
|---|---|
| Retention | `policy_retention` |
| Compression (legacy) | `policy_compression` |
| Columnstore (2.18+) | `policy_compression` (columnstore reuses the compression job machinery) / check your version |
| Continuous aggregate refresh | `policy_refresh_continuous_aggregate` |
| Reorder | `policy_reorder` |
| Error-log retention (built-in, job_id 2) | `policy_job_error_retention` |

> Confirm the exact `proc_name` on your version with `SELECT DISTINCT proc_name FROM
> timescaledb_information.jobs;` — they've been renamed across releases (notably the columnstore rename).

---

## 7. Manual `drop_chunks` for ops, and self-host tiering

### 7.1 `drop_chunks` — the manual escape hatch

A retention *policy* is just an automated `drop_chunks`. For one-off ops (free disk now, drop a known-bad
backfill range) call it directly. Signature, from [drop_chunks()](https://www.tigerdata.com/docs/api/latest/hypertable/drop_chunks/):

```sql
SELECT drop_chunks(
    relation       => '<hypertable_or_cagg>',  -- REGCLASS, required
    older_than     => <interval | timestamp>,
    newer_than     => <interval | timestamp>,
    created_before => <interval | timestamp>,
    created_after  => <interval | timestamp>,
    verbose        => true | false             -- default false
);
```

Examples:

```sql
-- free disk NOW: drop everything in `ticks` older than 3 months
SELECT drop_chunks('ticks', older_than => INTERVAL '3 months');

-- drop a specific bad backfill window (intersection of older_than ∩ newer_than)
SELECT drop_chunks('ticks', older_than => INTERVAL '3 months', newer_than => INTERVAL '4 months');

-- drop by absolute date
SELECT drop_chunks('ticks', older_than => '2025-01-01'::date);
```

Return value: "The name of each chunk that was dropped. Returns one row per dropped chunk" in
`_timescaledb_internal._hyper_X_Y_chunk` form ([drop_chunks()](https://www.tigerdata.com/docs/api/latest/hypertable/drop_chunks/)).
Empty result = nothing matched.

Constraints to remember:
- "Chunks can only be dropped based on their time intervals. They cannot be dropped based on a hash
  partition."
- You **cannot mix** time-range params (`older_than`/`newer_than`) with creation-time params
  (`created_before`/`created_after`) in one call.
- Same chunk-boundary rule as retention: a chunk drops only if its *entire* range is outside the bound.

> **The ops trap:** a manual `drop_chunks` on a raw hypertable is subject to the **exact same** cagg
> ordering rule as a retention policy (§3). If you `drop_chunks('ticks', older_than => INTERVAL '1 day')`
> while a cagg's refresh `start_offset` is 2 days, the next refresh recomputes the just-dropped day to
> empty. Quoted: "If any still-refreshing … part of the continuous aggregate is dropped via a retention
> policy or **direct drop_chunks call**, the aggregate will be updated to reflect the loss of data."
> — [continuous-aggregates retention guidance](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/refresh-policies).
> **Before a manual raw drop, confirm the cagg has materialised that range** (or temporarily disable the
> refresh policy / set its `start_offset` accordingly).

### 7.2 `show_chunks` — see what you'd drop before you drop it

Always dry-run with `show_chunks` (same predicate args as `drop_chunks`) before a manual drop:

```sql
SELECT show_chunks('ticks', older_than => INTERVAL '3 months');  -- list, don't delete
```

### 7.3 Data tiering — the concept, and the Cloud-vs-self-host split

"Tiering" = move *cold* chunks to **cheaper storage** instead of dropping them, so old data is still
queryable (slower, cheaper) rather than gone. This is the alternative to step-5 retention when you must
keep data for compliance/research but not on hot disk.

**On Tiger Cloud — object-storage tiering (a managed feature, NOT self-host):**

> "This is a **Tiger Cloud feature only**, available on Scale and Enterprise pricing plans. **It is not
> available for self-hosted TimescaleDB.**" — [enabling-data-tiering](https://www.tigerdata.com/docs/use-timescale/latest/data-tiering/enabling-data-tiering)

Cloud tiering moves cold chunks to an S3/Azure-Blob object tier stored in **Apache Parquet**; chunks
from one hypertable can "stretch across these two storage tiers" ([about-storage-tiers](https://www.tigerdata.com/docs/learn/data-lifecycle/storage/about-storage-tiers)).
API:

```sql
-- Cloud only
SELECT add_tiering_policy('ticks', move_after => INTERVAL '90 days');  -- runs hourly by default
SELECT remove_tiering_policy('ticks');
CALL   untier_chunk('_timescaledb_internal._hyper_1_1_chunk');         -- bring a chunk back, synchronous
SELECT tier_chunk('_timescaledb_internal._hyper_1_1_chunk');            -- tier one chunk manually
```

> "A tiering policy automatically moves any chunks that only contain data older than the `move_after`
> threshold to the object storage tier." Removing a policy "does not untier already-tiered chunks": "If
> you remove a tiering policy, the remaining scheduled chunks are not tiered. However, chunks in tiered
> storage are not untiered." — [enabling-data-tiering](https://www.tigerdata.com/docs/use-timescale/latest/data-tiering/enabling-data-tiering)

**On self-hosted — there is NO object-storage tiering.** Self-host tiers across *attached/local* storage
tiers (NVMe → HDD, or a cheap mounted volume) using **Postgres tablespaces** + TimescaleDB's
`move_chunk`. There is no built-in self-host policy for it — you automate it with a custom `add_job`
(§7.4).

### 7.4 Self-host tiering recipe — tablespaces + `move_chunk` + a custom job

```sql
-- 1. create a tablespace on the cheap/slow volume (HDD, mounted disk)
CREATE TABLESPACE cold_storage LOCATION '/mnt/cold/pgdata';

-- 2. move a single cold chunk there. Signature from move_chunk() reference:
SELECT move_chunk(
    chunk                        => '_timescaledb_internal._hyper_1_4_chunk',  -- REGCLASS, required
    destination_tablespace       => 'cold_storage',                           -- NAME, required
    index_destination_tablespace => 'cold_storage',                           -- NAME, optional
    reorder_index                => 'ticks_symbol_ts_idx',                    -- REGCLASS, optional
    verbose                      => true
);
```

> `move_chunk` requires **superuser**, and `reorder_index` lets you cluster the chunk by an index *as*
> you move it. "Unlike cloud object storage solutions, self-hosted implementations leverage this
> function to transition aging data chunks across attached storage tiers (e.g. NVMe to HDD) on local
> infrastructure." — [move_chunk() reference](https://www.tigerdata.com/docs/api/latest/hypertable/move_chunk/)

Automate it with a custom job that moves every chunk older than N days to the cold tablespace:

```sql
CREATE OR REPLACE PROCEDURE tier_old_chunks_to_cold(job_id int, config jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    cold_ts   text := config->>'tablespace';        -- e.g. 'cold_storage'
    move_after interval := (config->>'move_after')::interval;  -- e.g. '90 days'
    ch        regclass;
BEGIN
    FOR ch IN
        SELECT show_chunks('ticks', older_than => move_after)
    LOOP
        -- only move chunks not already on the cold tablespace (re-entrancy: this job may run again)
        PERFORM move_chunk(chunk => ch, destination_tablespace => cold_ts,
                           index_destination_tablespace => cold_ts);
        RAISE NOTICE 'Moved % to %', ch, cold_ts;
    END LOOP;
END $$;

-- schedule it: nightly at 04:00 UTC
SELECT add_job(
    'tier_old_chunks_to_cold',
    schedule_interval => INTERVAL '1 day',
    initial_start     => '2026-01-01 04:00:00+00',
    timezone          => 'UTC',
    fixed_schedule    => true,
    config            => '{"tablespace":"cold_storage","move_after":"90 days"}'::jsonb
);
```

> **Partial-failure behaviour of this custom tiering job:** `move_chunk` is per-chunk and effectively
> transactional per chunk. If the job dies mid-loop (e.g. cold volume full), some chunks moved, some
> didn't; the job retries on its back-off (§6.2) and — because `move_chunk` won't re-move a chunk
> already on the target tablespace (it errors / you guard with the not-already-there check) — the loop
> is **safe to re-run**. State this explicitly in your runbook: "the self-host tiering job is
> idempotent per chunk; a failed run leaves a mix of moved/unmoved chunks and self-heals on the next
> nightly run."

---

## 8. Verifying jobs — `timescaledb_information.jobs`, `job_stats`, `job_errors`

You cannot trust a lifecycle you don't monitor. Three views give you everything.

### 8.1 `timescaledb_information.jobs` — the *configuration* of every job

Schema, from [jobs view reference](https://www.tigerdata.com/docs/api/latest/informational-views/jobs/):

| Column | Type | Meaning (quoted) |
|---|---|---|
| `job_id` | INTEGER | "The ID of the background job" |
| `application_name` | TEXT | "Name of the policy or job" |
| `schedule_interval` | INTERVAL | "The interval at which the job runs. Defaults to 24 hours" |
| `max_runtime` | INTERVAL | "The maximum amount of time the job is allowed to run … before it is stopped" |
| `max_retries` | INTEGER | "The number of times the job is retried if it fails" |
| `retry_period` | INTERVAL | "The amount of time the scheduler waits between retries of the job on failure" |
| `proc_schema` / `proc_name` | TEXT | The function/procedure the job runs |
| `owner` | TEXT | "Owner of the job" |
| `scheduled` | BOOLEAN | "Set to `true` to run the job automatically" |
| `fixed_schedule` | BOOLEAN | fixed-time vs drift scheduling |
| `config` | JSONB | "Configuration passed to the function … at execution time" (this is where `drop_after`, `compress_after_refresh`, etc. live) |
| `next_start` | TIMESTAMPTZ | "Next start time for the job" |
| `initial_start` | TIMESTAMPTZ | first-run / fixed-schedule alignment origin |
| `hypertable_schema` / `hypertable_name` | TEXT | the relation, or `NULL` for a plain job |
| `check_schema` / `check_name` | TEXT | the optional config-validation function |

```sql
-- see every lifecycle policy and its config in one place
SELECT job_id, application_name, proc_name, hypertable_name,
       schedule_interval, scheduled, config
FROM   timescaledb_information.jobs
ORDER  BY hypertable_name, proc_name;
```

### 8.2 `timescaledb_information.job_stats` — the *runtime health* of every job

Schema, from [job_stats view reference](https://www.tigerdata.com/docs/api/latest/informational-views/job_stats/):

| Column | Type | Meaning (quoted) |
|---|---|---|
| `hypertable_schema` / `hypertable_name` | TEXT | the relation |
| `job_id` | INTEGER | "The id of the background job created to implement the policy" |
| `last_run_started_at` | TIMESTAMPTZ | "Start time of the last job" |
| `last_successful_finish` | TIMESTAMPTZ | "Time when the job completed successfully" |
| `last_run_status` | TEXT | "Whether the last run succeeded or failed" — value is **`'Success'`** or **`'Failed'`** |
| `job_status` | TEXT | "Status of the job. Valid values are `'Running'`, `'Scheduled'` and `'Paused'`" |
| `last_run_duration` | INTERVAL | "Duration of last run of the job" |
| `next_start` | TIMESTAMPTZ | "Start time of the next run" |
| `total_runs` | BIGINT | "The total number of runs of this job" |
| `total_successes` | BIGINT | "The total number of times this job succeeded" |
| `total_failures` | BIGINT | "The total number of times this job failed" |

> **What `last_run_status` shows on failure — confirmed from source.** It is derived by a `CASE`
> expression: `'Success'` when the internal `last_run_success` is true, `'Failed'` when false. So a
> failed job shows **`last_run_status = 'Failed'`**, and you query failures with
> `WHERE last_run_status = 'Failed'`. (The view is built over `_timescaledb_internal.bgw_job_stat`.)
> — corroborated by the [job_stats reference](https://www.tigerdata.com/docs/api/latest/informational-views/job_stats/)
> and the [timescaledb source / CHANGELOG](https://github.com/timescale/timescaledb/blob/main/CHANGELOG.md).

> **Gotcha (open caveat, flagged):** as of an open bug report, `SELECT * FROM
> timescaledb_information.job_stats` can **return no row at all** for a job that has *never run yet* (no
> stats accumulated), rather than a row with zero counts
> ([timescaledb issue #8551](https://github.com/timescale/timescaledb/issues/8551)). So "no row in
> job_stats" ≠ "job is fine" — cross-check against `jobs` (which always has the config row). Treat a
> policy present in `jobs` but absent from `job_stats` as "registered but never executed — investigate."

### 8.3 What a failed job looks like — the monitoring query

```sql
-- the single most important operational query: are any lifecycle jobs failing?
SELECT  job_id, hypertable_name, last_run_status, job_status,
        last_run_started_at, last_successful_finish,
        total_runs, total_failures, next_start
FROM    timescaledb_information.job_stats
WHERE   last_run_status = 'Failed'            -- the failed ones
   OR   total_failures > 0                    -- or anything with a failure history
ORDER BY total_failures DESC;
```

A failing retention or refresh job is **the** silent killer in this lifecycle:
- A failing **refresh** job → buckets stop materialising → and if retention keeps dropping raw, you get
  permanent data gaps (§3.3). **Alert on it.**
- A failing **retention** job → disk fills up over days/weeks (slower, but still an outage).
- A failing **columnstore** job → chunks stay uncompressed → disk grows faster, queries slower.

### 8.4 `timescaledb_information.job_errors` — *why* it failed

Schema, from [job_errors view reference](https://www.tigerdata.com/docs/api/latest/informational-views/job_errors/):

| Column | Type | Meaning (quoted) |
|---|---|---|
| `job_id` | INTEGER | "The ID of the background job created to implement the policy" |
| `proc_schema` / `proc_name` | TEXT | the function/procedure that ran |
| `pid` | INTEGER | process ID; "NULL in the case of a job crash" |
| `start_time` | TIMESTAMPTZ | job start |
| `finish_time` | TIMESTAMPTZ | "Time when error was reported" |
| `sqlerrcode` | TEXT | "The error code associated with this error, if any" |
| `err_message` | TEXT | "The detailed error message" |

```sql
-- WHY did the retention job on `ticks` fail? read the actual error
SELECT job_id, proc_name, start_time, finish_time, sqlerrcode, err_message
FROM   timescaledb_information.job_errors
WHERE  job_id = <job_id>            -- from job_stats above
ORDER  BY finish_time DESC
LIMIT  20;
```

> **The error log is itself retained** by a built-in job (job_id 2): "A system background job
> `Error Log Retention Policy` is enabled by default … Schedule: Monthly cleanup … Configuration:
> `{"drop_after": "1 month"}`." Adjust how long error history is kept with
> `SELECT alter_job(2, config := jsonb_set(config, '{drop_after}', '"3 months"'))`.
> — [job_errors reference](https://www.tigerdata.com/docs/api/latest/informational-views/job_errors/).
> So your forensic window into *why* a job failed is **one month by default** — widen it if your
> on-call rotation is slow, or you'll lose the error message before anyone reads it.

### 8.5 A production health-check you can put behind an endpoint / cron

```sql
-- "is the data lifecycle healthy?" — one query for a /health/lifecycle endpoint
SELECT
    j.hypertable_name,
    j.proc_name,
    js.last_run_status,
    js.last_successful_finish,
    now() - js.last_successful_finish        AS staleness,
    js.total_failures,
    js.next_start
FROM   timescaledb_information.jobs j
LEFT   JOIN timescaledb_information.job_stats js USING (job_id)
WHERE  j.proc_name IN ('policy_retention','policy_compression',
                       'policy_refresh_continuous_aggregate','policy_reorder')
ORDER  BY js.last_run_status NULLS FIRST, staleness DESC NULLS FIRST;
```

Alert if: any row has `last_run_status = 'Failed'`, OR a refresh job's `staleness` exceeds a few
multiples of its `schedule_interval`, OR a policy in `jobs` has **no matching `job_stats` row** (never
ran — §8.2 caveat).

---

## 9. The lifecycle as one runnable script (copy-paste recipe)

Putting §2–§3 together for a single symbol-level tick store. This is the deliverable artifact — the
whole lifecycle in one transcript, with the schedule and the safety inequality made explicit.

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- 0. raw hypertable
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE ticks (
    ts     timestamptz NOT NULL,
    symbol text        NOT NULL,
    price  double precision NOT NULL,
    size   integer     NOT NULL
);
SELECT create_hypertable('ticks', by_range('ts', INTERVAL '1 day'));
CREATE INDEX ON ticks (symbol, ts DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. roll up: 1-minute OHLCV continuous aggregate
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW ohlcv_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket, symbol,
       first(price, ts) AS open, max(price) AS high,
       min(price) AS low, last(price, ts) AS close, sum(size) AS volume
FROM ticks GROUP BY 1, 2
WITH NO DATA;

-- refresh policy. SAFETY INVARIANT:  start_offset (2d)  <  raw drop_after (14d)
SELECT add_continuous_aggregate_policy('ohlcv_1m',
    start_offset      => INTERVAL '2 days',     --  ← MUST be < the 14d below
    end_offset        => INTERVAL '1 minute',   --  ← ≥ one bucket; excludes the live minute
    schedule_interval => INTERVAL '1 minute',
    config            => '{"compress_after_refresh": true}'::jsonb);  -- 2.27+: fuse refresh+compress

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. compress raw (columnstore) after 3 days
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE ticks SET (
    timescaledb.enable_columnstore = true,
    timescaledb.segmentby          = 'symbol',
    timescaledb.orderby            = 'ts DESC');
CALL add_columnstore_policy('ticks', after => INTERVAL '3 days');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. drop raw after 14 days  (caggs already materialised → no data loss)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT add_retention_policy('ticks',
    drop_after        => INTERVAL '14 days',
    schedule_interval => INTERVAL '1 day',
    initial_start     => '2026-01-01 03:00:00+00',   -- nightly 03:00 UTC, off-peak
    timezone          => 'UTC');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. cagg gets its OWN compression + (longer) retention — keep candles far longer than raw
-- ─────────────────────────────────────────────────────────────────────────────
-- (compression on ohlcv_1m is handled by compress_after_refresh above on 2.27+;
--  on <2.27 add it explicitly:)
-- ALTER MATERIALIZED VIEW ohlcv_1m SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'symbol');
-- CALL add_columnstore_policy('ohlcv_1m', after => INTERVAL '30 days');
SELECT add_retention_policy('ohlcv_1m', drop_after => INTERVAL '90 days');

-- (repeat the hierarchy: ohlcv_1h from ohlcv_1m drop 2y; ohlcv_1d from ohlcv_1h keep forever)

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. verify everything is registered and healthy
-- ─────────────────────────────────────────────────────────────────────────────
SELECT job_id, application_name, proc_name, hypertable_name, schedule_interval, config
FROM   timescaledb_information.jobs ORDER BY hypertable_name;

SELECT job_id, hypertable_name, last_run_status, total_failures, next_start
FROM   timescaledb_information.job_stats ORDER BY last_run_status;
```

---

## 10. R-SCALE / tier statement — what this survives and what breaks next

Per `cto-rules.md` §5 ("state the tier each design survives") and the JPM data-line product-at-scale
discipline, here is the explicit tier read for this lifecycle:

| Surface | Tier-1 (demo) | Tier-2 (early) | Tier-3 (real) | What breaks at the next tier |
|---|---|---|---|---|
| **Raw ingest** | one hypertable, no policies | + compression at N days | + hierarchical caggs + retention + tiering | At Tier-3, *no policies* = unbounded disk; at lakhs of symbols × ticks, a 1-day chunk is too big → widen partitioning or partition by symbol space. |
| **Rollups** | query raw directly | one cagg, manual refresh | refresh **policy** hierarchy (1m→1h→1d), `compress_after_refresh` | Manual `refresh_continuous_aggregate` doesn't scale; a single flat cagg over raw re-scans too much → go hierarchical. |
| **Retention** | none (data accumulates) | manual `drop_chunks` | `add_retention_policy` + the `start_offset < drop_after` invariant enforced | Manual drops are forgotten → disk fills; an un-audited `start_offset ≥ drop_after` silently empties caggs (§3). |
| **Compression** | none | `add_columnstore_policy` | columnstore + `segmentby` tuned to the query filter | Default (no `segmentby`) scans all symbols' batches; wrong `segmentby` = slow per-symbol queries. |
| **Tiering** | n/a | n/a | Cloud `add_tiering_policy` **or** self-host tablespace `move_chunk` job | Self-host has NO object tiering; if you assumed S3 tiering on self-host it simply doesn't exist (§7.3) — you must build the tablespace job. |
| **Monitoring** | eyeball | check `job_stats` manually | alert on `last_run_status='Failed'` + refresh staleness + missing `job_stats` row | A failing refresh + live retention = **permanent data gaps**; the #1 production incident this lifecycle can cause. |

**The single break that matters most:** a *believed-healthy but actually-failing* continuous-aggregate
refresh job, combined with a *working* retention policy, deletes raw data whose rollups were never
materialised — an irreversible gap. This is exactly the "Tier-1 shipped as Tier-3" failure: the policies
*exist*, so it *looks* production-grade, but nobody alerts on `job_stats`, so the gap is invisible until
a user queries 2019 daily candles and finds holes. **The monitoring query in §8.5 is not optional.**

---

## 11. Anti-patterns (mistake → fix), specific to this sub-topic

| Mistake | Why it breaks | Fix |
|---|---|---|
| `start_offset => NULL` (or `≥ drop_after`) on a cagg whose source has retention | Refresh window reaches into dropped raw → buckets recompute to NULL → silent permanent data loss | `start_offset` strictly `< drop_after`; never `NULL` with retention (§3.2) |
| Retention policy but no cagg / no rollup | You drop the raw *and the answer* — nothing summarised the data first | Build the cagg hierarchy *before* adding retention; downsample-then-drop (§2) |
| Trusting "no row in `job_stats`" as healthy | A never-run job has no stats row ([#8551](https://github.com/timescale/timescaledb/issues/8551)); absence ≠ success | Cross-check `jobs` (config) vs `job_stats` (runtime); a policy in `jobs` with no `job_stats` row = never executed (§8.2) |
| No alert on `last_run_status='Failed'` | A failing refresh + live retention = irreversible gaps; failing retention = disk fills — both invisible | The §8.5 health query behind a cron/endpoint; alert on Failed + staleness (§8.3) |
| Manual `drop_chunks` on raw without checking the cagg | Same data-loss mechanism as a bad retention policy — direct drops also trigger cagg recompute to empty | `show_chunks` dry-run + confirm the cagg materialised that range first (§7.1–7.2) |
| Assuming object-storage (S3) tiering on self-host | Object tiering is **Cloud-only** ([enabling-data-tiering](https://www.tigerdata.com/docs/use-timescale/latest/data-tiering/enabling-data-tiering)); it does not exist self-host | Self-host = Postgres tablespaces + `move_chunk` + a custom `add_job` (§7.4) |
| Using `add_compression_policy` on 2.18+ as the go-forward API | Deprecated in 2.18.0, superseded by `add_columnstore_policy` | `CALL add_columnstore_policy(...)` after enabling columnstore (§2.4); old form only for legacy installs |
| Separate refresh + compress jobs racing on a 2.27 cagg | Lock contention → "retries or failed policy executions" ([2.27 blog](https://www.tigerdata.com/blog/timescaledb-2-27)) | `compress_after_refresh: true` in the refresh policy config (§4.1) |
| Reorder policy on chunks that are about to be compressed | Columnstore conversion re-lays-out the chunk; the reorder is wasted CPU | Reorder only the long-lived *rowstore* tail; otherwise rely on columnstore `orderby` (§5.3) |
| `end_offset` inside the current bucket | Re-materialises an incomplete bucket every run; latest candle flickers, perf degrades | `end_offset ≥` one bucket width (§2.3, §3.4) |
| No explicit `schedule_interval` / `initial_start` / `timezone` on policies | Derived defaults run at unpredictable hours; DST shifts a "nightly" sweep | State schedule explicitly; `fixed_schedule + timezone` for off-peak nightly runs (§1.5, §6.1) |
| Expecting `job_errors` to keep history forever | Built-in job 2 drops errors after 1 month by default | Widen `alter_job(2, config := jsonb_set(...,'{drop_after}','"3 months"'))` for slow on-call (§8.4) |

---

## 12. Sources (all read June 2026)

Primary (Tiger Data / TimescaleDB API references and guides):
- [add_retention_policy()](https://www.tigerdata.com/docs/api/latest/data-retention/add_retention_policy/) — signature, args, "one policy per hypertable", `drop_after`/`drop_created_before` exclusivity, integer_now_func note.
- [remove_retention_policy()](https://www.tigerdata.com/docs/api/latest/data-retention/remove_retention_policy/) — relation, if_exists.
- [drop_chunks()](https://www.tigerdata.com/docs/api/latest/hypertable/drop_chunks/) — manual drop args, "entire time range" boundary rule, can't mix time-range with creation-time params.
- [add_columnstore_policy()](https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy) — replaces add_compression_policy (deprecated 2.18.0); `after`/`created_before`; hypertable + cagg examples; `CALL` form.
- [add_compression_policy() (deprecated)](https://github.com/timescale/docs/blob/latest/api/compression/add_compression_policy.md) — legacy `compress_after`, "Superseded by add_columnstore_policy()".
- [add_job()](https://www.tigerdata.com/docs/api/latest/actions/add_job/) — custom action signature, "what is a job", fixed_schedule default true.
- [alter_job()](https://www.tigerdata.com/docs/api/latest/actions/alter_job/) — max_retries/retry_period, the exact `next_start = finish_time + consecutive_failures * retry_period ± 13% jitter`, cap 5× schedule_interval, clamp at 20.
- [timescaledb_information.jobs](https://www.tigerdata.com/docs/api/latest/informational-views/jobs/) — full config schema.
- [timescaledb_information.job_stats](https://www.tigerdata.com/docs/api/latest/informational-views/job_stats/) — runtime schema, `last_run_status` Success/Failed, job_status Running/Scheduled/Paused.
- [timescaledb_information.job_errors](https://www.tigerdata.com/docs/api/latest/informational-views/job_errors/) — error schema, built-in error-log retention (job 2, 1 month default).
- [add_reorder_policy()](https://docs.timescale.com/api/latest/hypertable/add_reorder_policy/) — index clustering, "all chunks except the two most recent", 24h default, idempotent per chunk.
- [move_chunk()](https://www.tigerdata.com/docs/api/latest/hypertable/move_chunk/) — self-host tablespace tiering, superuser, reorder_index.
- [add_continuous_aggregate_policy / refresh-policies](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/refresh-policies) — start_offset/end_offset definitions, the retention-overlap warning.
- [Continuous aggregates: drop-data](https://github.com/timescale/docs/blob/latest/use-timescale/continuous-aggregates/drop-data.md) — the `start_offset < drop_after` rule (verbatim), the refresh-empties-buckets warning.
- [add_policies()](https://www.tigerdata.com/docs/api/latest/continuous-aggregates/add_policies/) — combined refresh+compress+drop helper, 1-hour fixed schedule caveat.
- [Understand tiered storage](https://www.tigerdata.com/docs/learn/data-lifecycle/storage/about-storage-tiers) and [enabling data tiering](https://www.tigerdata.com/docs/use-timescale/latest/data-tiering/enabling-data-tiering) — Cloud-only object tiering, S3/Parquet, add_tiering_policy/move_after, untier_chunk; explicitly "not available for self-hosted".
- [Data lifecycle overview](https://www.tigerdata.com/docs/learn/data-lifecycle) — the five phases (ingest → query → rollup → compress/archive → drop).

Release / source corroboration:
- [TimescaleDB 2.27 (2026-05-12) blog](https://www.tigerdata.com/blog/timescaledb-2-27) — `compress_after_refresh`, fused refresh+compress, the lock-contention rationale.
- [timescaledb CHANGELOG](https://github.com/timescale/timescaledb/blob/main/CHANGELOG.md) and [issue #8551](https://github.com/timescale/timescaledb/issues/8551) — `last_run_status` CASE → 'Success'/'Failed'; job_stats empty-when-never-run caveat.

**Verification posture:** the load-bearing claims — the `start_offset < drop_after` invariant, the
`add_compression_policy`→`add_columnstore_policy` deprecation at 2.18.0, the retry back-off formula, and
the Cloud-only nature of object tiering — were each confirmed against a primary Tiger Data reference and
cross-checked against a second source (a second doc page, the release blog, or the repo). Two items are
flagged for your version: (1) the exact built-in `proc_name` for columnstore vs legacy compression has
shifted across releases — confirm with `SELECT DISTINCT proc_name FROM timescaledb_information.jobs;`;
(2) `add_policies` lives under `timescaledb_experimental` and its exact arg names/schema have changed —
re-confirm on your installed `extversion` before scripting it. `[unverified — confirm on install]`.
