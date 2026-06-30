# theory · The TimescaleDB licensing split: Apache-2 vs the Timescale License (TSL)

> **Scope.** This is the load-bearing licensing reference for the `timescaledb-timeseries` dev-skill
> (the **JPM-Markets re-engineering data-analytics product line — NOT Lumina**). It exists to answer
> one question with zero ambiguity before any design decision is locked: **for the feature my design
> leans on, is the code Apache-2 or TSL Community, and does our deployment trip the single DBaaS
> prohibition?** Get this wrong and you either (a) over-restrict — refusing free-and-legal Community
> features out of unfounded "SSPL fear" — or (b) under-restrict — shipping a product whose deployment
> shape is the one thing the TSL forbids. Both are expensive; both are avoidable by reading the actual
> license text, which this doc does, with verbatim citations.
>
> **What this doc is NOT.** It is **not** about market-DATA licensing (the price/quote/series feeds).
> That is a completely separate axis — see the closing section "Two orthogonal license axes". The
> *software* license (TimescaleDB the engine) and the *data* license (the numbers flowing through it)
> never substitute for each other. A GREEN data feed in a TSL-licensed engine is still TSL on the
> engine and GREEN on the data; an Apache engine full of RED scraped quotes is still RED on the data.

---

## 0. The thirty-second answer (read this first)

For an internal analytics platform that we **self-host** (our own VMs / our own Kubernetes / a managed
**Postgres** host where *we* installed the extension), running on our own infrastructure to serve our
own product:

1. **You may use every TimescaleDB feature — Apache-2 AND TSL Community — for free, in production,
   commercially.** Self-hosting for your own business is explicitly permitted by both licenses, with no
   fee, no source-disclosure trigger, and no per-core/per-seat cost.
   ([tigerdata.com/docs/.../timescaledb-editions](https://www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions))
2. **There is exactly ONE prohibition in the TSL that matters to us:** you may not take TimescaleDB
   itself and **offer it to third parties as a managed database service** (a DBaaS / time-sharing /
   SaaS where *the database* is what you sell). We are building a finance analytics product, not a
   "rent a TimescaleDB" cloud — so this prohibition does not bind us, *as long as we never expose the
   raw database DDL/DML interface to external customers as the product*. ([TSL §2.2, verbatim
   below](https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE))
3. **TSL is NOT AGPL and NOT SSPL.** It has no network-copyleft, no "disclose your whole stack if you
   offer it as a service" SSPL clause, and no source-disclosure-on-network-use trigger. The "fear" that
   adopting TimescaleDB Community forces us to open-source the JPM-Markets platform is **unfounded** —
   the TSL restricts exactly one *deployment shape* (reselling the DB as a service) and nothing about
   our *own* code. ([dev.to analysis](https://dev.to/okedialf/what-the-timescale-license-means-for-database-administrators-in-the-cloud-era-1h82),
   cross-verified against the TSL text)

If that paragraph is all you needed, stop here. The rest is the precise feature-by-feature split, the
exact license text, the GUC/build mechanics, and a decision checklist — for when a reviewer asks "prove
it" or a feature lands in a grey zone.

---

## 1. The two licenses and where each applies

TimescaleDB ships as **one Postgres extension built from a dual-licensed source tree**. The split is
**physical — by source directory** — not by feature name on a marketing page. This matters: the
directory layout is the ground truth; the editions page is a human-readable *summary* of it.

### 1.1 The source-directory rule (the ground truth)

From the repository's top-level `LICENSE` file, verbatim:

> "Outside of the 'tsl' directory, source code in a given file is licensed under the Apache License
> Version 2.0, unless otherwise noted."
>
> "Within the 'tsl' folder, source code in a given file is licensed under the Timescale License, unless
> otherwise noted."
> — [github.com/timescale/timescaledb/blob/main/LICENSE](https://github.com/timescale/timescaledb/blob/main/LICENSE)

And on the *built artifacts*:

> separate binaries are generated — those containing "-tsl" in their filename carry the Timescale
> License, while others use Apache 2.0.
> — [same LICENSE file](https://github.com/timescale/timescaledb/blob/main/LICENSE)

So when TimescaleDB is compiled normally, you get **two loadable modules**: the Apache core, plus a
`-tsl` submodule containing the Community features. The architecture is deliberate — per the original
implementation commit, "Dynamically loaded modules allow users to determine which licenses they wish to
use … if they wish to only use Apache-Licensed code, they do not load the Timescale-Licensed submodule."
([commit 4ff6ac7](https://github.com/timescale/timescaledb/commit/4ff6ac7b917a3dae8796b4a4e36001598db645d0))

### 1.2 The two named editions

| Edition | License | Source | Marketing/docs name |
|---|---|---|---|
| **Apache 2 Edition** | Apache License 2.0 | everything **outside** `tsl/` | "TimescaleDB Apache 2 Edition" / "Open Source" |
| **Community Edition** | Timescale License (TSL) — a.k.a. "Tiger Data License" | the `tsl/` directory's features, loaded **in addition to** the Apache core | "TimescaleDB Community Edition" |

> **Naming note for the new product line.** Tiger Data (formerly "Timescale") rebranded; recent docs call
> the TSL the **"Tiger Data License"** and host docs at `tigerdata.com`. The license acronym is still
> **TSL**, and the in-database GUC value is still `timescale`. Treat "Timescale License", "Tiger Data
> License", and "TSL" as the same thing. ([tigerdata.com/legal/licenses](https://www.tigerdata.com/legal/licenses))

The Apache 2 Edition is **a strict subset**. The Community Edition = Apache core **+** the `tsl/`
features. There is no third tier of "the extension" to self-host; Tiger Data's *managed cloud* (the
hosted service) is a separate commercial offering and is not what "Community Edition" means.

### 1.3 What "Apache 2 Edition" actually permits (the fully-open tier)

From the editions page, verbatim — the Apache tier is **completely unrestricted**, classic OSS:

> "anyone can take this code and offer it as a service"
> "You can install TimescaleDB Apache 2 Edition on your own on-premises or cloud infrastructure and run
> it for free"
> "You can sell TimescaleDB Apache 2 Edition as a service, even if you're not the main contributor"
> "You can modify the TimescaleDB Apache 2 Edition source code and run it for production use"
> — [tigerdata.com/docs/.../timescaledb-editions](https://www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions)

So if — and only if — your entire design uses *exclusively* Apache-tier features, you have **zero**
licensing constraints, including the freedom to resell it as a DBaaS. That freedom is the **only**
practical reason to deliberately restrict yourself to the Apache subset. For our internal product, we
don't need that freedom, so we will use the Community feature set freely.

### 1.4 What "Community Edition (TSL)" permits and the one thing it forbids

From the editions page, verbatim:

> "You can install TimescaleDB Community Edition in your own on-premises or cloud infrastructure and run
> it for free."
> "Developers using TimescaleDB Community Edition have the 'right to repair' and make modifications to
> the source code and run it in their own on-premises or cloud infrastructure."
>
> **The single prohibition:**
> "You cannot sell TimescaleDB Community Edition as a service, even if you are the main contributor."
> — [tigerdata.com/docs/.../timescaledb-editions](https://www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions)

That is the whole story at the summary level: **install on your own infra and run for free; the one
thing you cannot do is sell TimescaleDB Community *itself* as a managed service.** §3 below grounds that
summary in the actual legal clauses, because the precise wording is what protects us in the grey zone.

---

## 2. The exact feature split — which functions are Apache, which are TSL Community

This is the table you will return to most. It is verified against **both** the editions/comparison page
**and** the per-function license behavior. Every "Community-only" function below will raise the runtime
error `function <name> is not supported under the current "apache" license` if the engine is running in
Apache-only mode (see §4). That runtime gate is the *operational* proof of the classification, beyond
the marketing page.

> **Sources for this whole section:**
> [editions/feature matrix](https://www.tigerdata.com/docs/about/latest/timescaledb-editions),
> [compare editions](https://www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions),
> the `apache`-license runtime error documented in
> [issue #3718](https://github.com/timescale/timescaledb/issues/3718).

### 2.1 Apache-2 tier (free in EVERY edition, resell-as-a-service OK)

These are the building blocks of the time-series model itself. They are in the Apache core — you can
use them even in a deliberately Apache-only build.

| Capability | Functions / DDL | Notes |
|---|---|---|
| **Hypertables** | `CREATE TABLE`, `create_hypertable()` | The core abstraction: a virtual table auto-partitioned into chunks by time (and optionally space). Apache. |
| **Chunk inspection / lifecycle (basic)** | `show_chunks()`, `drop_chunks()` | Listing and dropping chunks is Apache. (Note: *automated* retention via a policy is **not** — see 2.2.) |
| **Dimensions / partitioning config** | `add_dimension()`, `set_chunk_time_interval()`, `set_integer_now_func()` | Space partitioning + chunk-interval tuning. Apache. |
| **Tablespace management** | `attach_tablespace()`, `detach_tablespace()`, `detach_tablespaces()`, `show_tablespaces()` | Spreading chunks across tablespaces/disks. Apache. |
| **Indexing** | `create_index()` (transactional, per-chunk) | Apache. |
| **Size / cardinality introspection** | `hypertable_size()`, `chunks_detailed_size()`, etc., and **`approximate_row_count()`** | `approximate_row_count()` (fast cardinality estimate from planner stats) is **Apache**. |
| **Time bucketing (basic)** | **`time_bucket()`** | The fixed-width time-bucketing function for `GROUP BY` rollups is **Apache**. Its *gap-filling* variant is **not** (see 2.2). |
| **Basic hyperfunctions** | **`first()`**, **`last()`**, **`histogram()`** | These three aggregate hyperfunctions are **Apache**. (Almost every *other* hyperfunction is TSL — see 2.2/2.3.) |
| **Informational views & admin** | `timescaledb_information.*` views, general admin functions | Available in both editions. |

**Mental model:** *the schema and the manual operations are Apache; the **automation** and the
**advanced math** are TSL.* You can create a hypertable, bucket it with `time_bucket`, and run
`first/last/histogram` with nothing but Apache code. The moment you want it to compress itself, roll
itself up continuously, expire old data on a schedule, gap-fill, or compute a percentile sketch — you
have crossed into TSL Community.

### 2.2 TSL Community tier (free to self-host; the DBaaS-resale prohibition applies)

These are the features that make TimescaleDB *TimescaleDB* for an analytics workload. **All of them are
free for us to self-host and use commercially internally.** They are TSL only in the sense that the
`tsl/` submodule must be loaded (the default; see §4) and the one DBaaS-resale clause attaches.

| Capability | Functions / DDL | Why our analytics platform wants it |
|---|---|---|
| **Hypercore / columnstore compression** | `ALTER TABLE … SET (timescaledb.compress…)`, `convert_to_columnstore()`, `add_columnstore_policy()`, compression stats views | Column-oriented compressed storage for historical chunks; 90%+ size reduction and fast analytical scans. **The single biggest reason a finance time-series store picks Timescale.** TSL. |
| **Continuous aggregates** | `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)`, `ALTER`/`DROP MATERIALIZED VIEW`, `add_continuous_aggregate_policy()`, `refresh_continuous_aggregate()`, `remove_continuous_aggregate_policy()` | Incrementally-maintained rollups (1-min → 1-h → 1-d bars) refreshed by a background policy. The compute-once-serve-many pattern for OHLC/aggregates. TSL. |
| **Data retention** | `add_retention_policy()`, `remove_retention_policy()` | Automatic expiry of chunks older than N (e.g. drop raw ticks >90d). TSL. (Manual `drop_chunks()` is Apache — the *policy/automation* is TSL.) |
| **Compression policy** | `add_compression_policy()` / columnstore policy | Auto-compress chunks once they age past a threshold. TSL. |
| **Reorder / chunk ops (advanced)** | `add_reorder_policy()`, `reorder_chunk()`, `split_chunk()`, `move_chunk()` | Cluster a chunk by an index for locality; split/move chunks. TSL. (Also **`SkipScan`** planner optimization — TSL.) |
| **Job scheduler (user-defined automation)** | **`add_job()`**, **`alter_job()`**, **`delete_job()`**, `run_job()` | Run arbitrary SQL procedures on a schedule inside the DB (the general-purpose engine under all the policies). The whole "set it and forget it" automation surface is **TSL**. |
| **Gap-filling & interpolation** | **`time_bucket_gapfill()`**, **`locf()`** (last-observation-carried-forward), **`interpolate()`** | Produce a continuous bucketed series with no missing intervals — essential for charts and contiguous time axes on illiquid/after-hours data. **TSL** (note: plain `time_bucket()` is Apache; the *gapfill* family is not). |

### 2.3 The `timescaledb_toolkit` extension — separate package, also TSL

The advanced statistical/analytical hyperfunctions live in a **separate extension**,
`timescaledb_toolkit` (its own repo, its own install). It is licensed under the **Timescale License
(TSL)**, not Apache. From its `LICENSE` file, verbatim:

> "Source code in this repository, and any binaries built from this source code, in whole or in part,
> are licensed under the Timescale License (the 'License')."
> — [github.com/timescale/timescaledb-toolkit/blob/main/LICENSE](https://github.com/timescale/timescaledb-toolkit/blob/main/LICENSE)

(The repo header notes individual files may carry Apache 2.0 where marked, but the **default and the
package as a whole is TSL.**) The toolkit gives you the heavyweight hyperfunctions a finance analytics
product reaches for:

| Toolkit hyperfunction family | Examples | Finance use |
|---|---|---|
| **Percentile approximation** | `percentile_agg` / `uddsketch` / `tdigest` (`approx_percentile`, `percentile_agg`) | p50/p95/p99 of latency, spreads, returns over huge tick volumes without sorting. |
| **Time-weighted aggregates** | `time_weight()`, `average()` over `TimeWeightSummary` | Time-weighted average price/exposure where samples are irregular. |
| **Counter/gauge aggregates** | `counter_agg`, `gauge_agg` | Rate/delta over resetting counters. |
| **Statistical aggregates** | `stats_agg`, `corr`, regression summaries | Rolling volatility, correlation between instruments. |
| **`asof` / `lttb` / state-tracking** | `lttb()` downsampling, `state_agg` | Downsample a million-point series to a chart-ready few hundred while preserving shape. |

**Licensing implication:** because the toolkit is TSL, the **exact same self-host-free /
no-DBaaS-resale** rule applies to it as to the Community features in the main extension. There is no
*additional* restriction from adding the toolkit — it's the same TSL bucket. Just record it as a TSL
dependency (see the decision checklist, §6).

### 2.4 The one-line classifier

> **Apache:** the *schema* (`create_hypertable`), *manual* chunk ops (`show_chunks`/`drop_chunks`),
> *tablespace* mgmt, `time_bucket`, `approximate_row_count`, and `first`/`last`/`histogram`.
> **TSL Community:** everything *automated* (every `*_policy`, the `add_job`/`alter_job`/`delete_job`
> scheduler), all *compression/columnstore*, all *continuous aggregates*, gap-fill/`locf`/`interpolate`,
> and the *entire `timescaledb_toolkit`*.

---

## 3. The precise legal text — what the TSL actually says

The summary ("self-host free, don't resell as a service") is correct, but a billion-dollar-grade product
line locks decisions to the *clauses*, not the blog gloss. Here are the load-bearing sections, verbatim,
from the canonical license file
[`tsl/LICENSE-TIMESCALE`](https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE) and
the [legal/licenses](https://www.tigerdata.com/legal/licenses) page.

### 3.1 The grant — internal business use (§2.1(a))

> **§2.1(a):** "A license to copy, compile, install, and use the Timescale Software and Derivative Works
> solely for Your own internal business purposes in a manner that does not expose or give access to … the
> Timescale Data Definition Interfaces or the Timescale Data Manipulation Interfaces to any person or
> entity other than You or Your employees and Contractors working on Your behalf."

Read the two named interfaces precisely:

- **Data Definition Interface (DDL):** `CREATE`/`ALTER`/`DROP` — the ability to *define and reshape the
  schema*. SQL: `CREATE TABLE`, `create_hypertable`, `ALTER TABLE`, etc.
- **Data Manipulation Interface (DML):** `SELECT`/`INSERT`/`UPDATE`/`DELETE` — the ability to *query and
  write rows*.

The grant says: use it all for **your own internal business purposes**, and **do not hand the raw
DDL/DML interfaces to outsiders.** Your employees and contractors are fine. The distinction that follows
(§2.1(b)) is what lets you *build a product on top*.

### 3.2 The grant — Value-Added Products & Services (§2.1(b))

> **§2.1(b):** [permits using the software] "to develop and maintain Your Value Added Products or
> Services" and distribute binaries "solely as incorporated into or utilized with Your Value Added
> Products or Services," **provided customers cannot modify the database schema through the Data
> Definition Interfaces.**

This is the clause that **explicitly blesses our use case.** A "Value Added Product or Service" is a
product *you build* that *uses* TimescaleDB internally. Your customers may query/write through *your
product's* interface (controlled DML), but they may **not** be handed the raw DDL to redefine the schema.
A finance analytics dashboard / API where the customer sees *your endpoints* and never the bare Postgres
DDL is precisely a Value-Added Product. Per the search-verified gloss:

> "The TSL allows and encourages Value Added Products and Services, with end users able to query or write
> to the database through DML operations, but the TSL prohibits them from allowing their end users to
> redefine or modify the underlying database structure or schema through DDL interfaces."
> — [tigerdata.com/legal/licenses](https://www.tigerdata.com/legal/licenses) (cross-verified against §2.1(b))

### 3.3 The single prohibition (§2.2) — verbatim

> **§2.2:** "You are prohibited from (i) using any TSL Licensed Software to provide time-sharing services
> or database-as-a-service services, or to provide any form of software-as-a-service or service offering
> in which the TSL Licensed Software is offered or made available to third parties to provide time-series
> database functions or operations, **other than as part of Your Value Added Products or Services**."
> — [github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE](https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE)

Parse the prohibition into its parts — **all** must be true for a violation:

1. You take the **TSL Licensed Software** (the Community features), and
2. You **offer / make it available to third parties** — i.e. outsiders, not your own org, and
3. The thing you offer is **the database itself** — "time-series database functions or operations",
   the DBaaS / time-sharing / SaaS *where the DB is the product*, and
4. It is **NOT part of your Value Added Product** (the §2.1(b) carve-out).

If condition (4) is satisfied — it *is* part of your own value-added product — **§2.2 does not apply.**
That is the whole game. A finance analytics platform is a value-added product; "rent a TimescaleDB
instance" is not.

### 3.4 Definition: what *is* "TSL Licensed Software" (§3.9)

> **§3.9:** "'TSL Licensed Software' means those parts of the Timescale Software other than the Timescale
> Open Source Software."

I.e. exactly the `tsl/`-directory Community features and the toolkit. The Apache core is the "Timescale
Open Source Software" and is *never* subject to §2.2 — so a pure-Apache deployment can do anything,
including reselling.

### 3.5 The naming requirement

> Users must refer to their implementation as "TimescaleDB Community Edition" when using the TSL.
> — [tigerdata.com/legal/licenses](https://www.tigerdata.com/legal/licenses)

Minor, but real: in *technical/attribution* contexts you should call the engine "TimescaleDB Community
Edition", not invent a marketing name for the database itself. This does **not** mean your product must
be called that — your product is the JPM-Markets analytics platform; the *embedded database component*
is "TimescaleDB Community Edition". (Compare: a webapp built on Postgres still calls its DB "Postgres".)

---

## 4. The mechanics: `timescaledb.license` GUC, the apache-only build, and how to *check* what you're running

The license isn't just legal text — it's **enforced in the binary** by a GUC (Grand Unified
Configuration, i.e. a Postgres runtime setting) named `timescaledb.license`. This is what produces the
runtime `function … is not supported under the current "apache" license` error, and it's how you *prove*
which edition a server is actually running.

### 4.1 The GUC values

`timescaledb.license` takes one of two values:

- **`timescale`** — the Community Edition: the `-tsl` submodule loads, all Community features available.
- **`apache`** — Apache-only mode: the `-tsl` submodule is **not** loaded; calling any Community
  function errors out.

([editions page on the GUC](https://www.tigerdata.com/docs/about/latest/timescaledb-editions))

### 4.2 The default-value gotcha (READ THIS — it bites in production)

The official documentation has historically described the default as `timescale`. **The actual default
in real binary distributions has been observed as `apache`** in some package paths — documented and still
open as a *documentation* bug:

> "The default value for `timescaledb.license` is `apache` rather than `timescale` as the doc describes."
> Users installing via standard package managers received Apache mode by default and hit errors like
> `function xxx is not supported under the current 'apache' license`.
> — [issue #3718](https://github.com/timescale/timescaledb/issues/3718)

**Practical rule for our deploys:** never assume the edition — **set it explicitly** in
`postgresql.conf` and verify it at boot. Don't let a continuous-aggregate policy fail at 2am because a
package defaulted to `apache`.

```conf
# postgresql.conf — pin Community Edition explicitly.
# (timescaledb must already be in shared_preload_libraries.)
shared_preload_libraries = 'timescaledb'
timescaledb.license = 'timescale'
```

### 4.3 How to check, in SQL, which edition a live server is running

Run this against any TimescaleDB server before trusting that a TSL feature will work:

```sql
-- 1. What license mode is active right now?
SHOW timescaledb.license;          -- -> 'timescale' (Community) or 'apache' (Apache-only)

-- equivalently, from the settings catalog:
SELECT name, setting
FROM pg_settings
WHERE name = 'timescaledb.license';

-- 2. Which extension version is installed?
SELECT extname, extversion FROM pg_extension WHERE extname LIKE 'timescaledb%';

-- 3. Is the toolkit (separately-installed, also-TSL) present?
SELECT * FROM pg_extension WHERE extname = 'timescaledb_toolkit';

-- 4. Smoke-test a TSL feature is actually callable (will raise the
--    "not supported under the current 'apache' license" error if in apache mode):
SELECT add_job('my_noop_proc', '1 day');  -- only works under 'timescale'
```

### 4.4 Building or pulling an apache-only binary (when you'd want to)

You would only do this if you wanted the **resale freedom** of pure-Apache (we don't, for an internal
product). The mechanism:

- **Source build:** pass `-DAPACHE_ONLY=1` to the `bootstrap` script — this compiles **only** the
  Apache core, no `tsl/` submodule at all.
- **Official Docker image:** the image build accepts a build-arg; e.g. setting
  `TIMESCALEDB_APACHE_ONLY` controls whether the Community (`tsl`) version is built. (Confirmed in
  ecosystem build tooling such as Spilo/Zalando's image, which threads a
  [`TIMESCALEDB_APACHE_ONLY` docker build flag](https://github.com/zalando/spilo/pull/419).)

> **Decision:** for the JPM-Markets analytics platform we do **NOT** build apache-only. We want
> compression, continuous aggregates, retention policies, gap-fill, and toolkit hyperfunctions — all
> TSL. We self-host, so TSL costs us nothing and forbids nothing we plan to do. Pin `timescaledb.license
> = 'timescale'` and move on.

---

## 5. Why TSL is NOT AGPL and NOT SSPL (killing the copyleft fear)

A common reflexive objection — "a source-available license on the database means we have to open-source
our platform / it'll behave like Mongo's SSPL" — is **wrong**, and reviewers will raise it. Here is the
precise refutation, grounded in the license families.

| License | Copyleft trigger | Effect on YOUR code (a self-hosted internal product) |
|---|---|---|
| **AGPL-3.0** | *Network use*: if users interact with the software **over a network**, you must offer **the software's** corresponding source to those users. | You must publish your modifications **to the AGPL'd program itself** to network users. (It does **not** reach *your* surrounding app — but the trigger is network interaction, which scares people.) |
| **SSPL (MongoDB)** | *Offering the software as a service*: if you offer the program "as a service," you must release the source of **the entire service-management stack** (orchestration, monitoring, APIs — everything). | The famously broad clause: a *hosting* business must open **its whole platform**. This is the clause people fear. |
| **TSL (Timescale Community)** | **Only** the act of **offering TimescaleDB itself to third parties as a DBaaS / time-sharing / SaaS *where the DB is the product*** (§2.2). | **Nothing.** No source-disclosure obligation at all. No network-use trigger. No "release your management stack." Self-hosting for your own product — even a commercial, customer-facing one — is explicitly permitted (§2.1(a)/(b)). |

The key distinctions, with citation:

> "The Timescale License takes a different approach than traditional copyleft licenses like AGPL or
> SSPL. Rather than requiring source code disclosure based on network use or creating a shared business
> competitor restriction, the Timescale License prevents public cloud vendors from offering TimescaleDB
> as a hosted database service, while still giving everyday users … the freedom to run and modify the
> software."
> — [search synthesis over tigerdata + dev.to](https://dev.to/okedialf/what-the-timescale-license-means-for-database-administrators-in-the-cloud-era-1h82)

> "Roughly speaking, as long as you are not offering TimescaleDB as a hosted Database-as-a-Service, you
> can use all Community features for free. The Timescale License doesn't lock you into proprietary cloud
> deployment, restrict internal use or self-hosting, or prohibit commercial use or embedding in
> applications."
> — [same](https://dev.to/okedialf/what-the-timescale-license-means-for-database-administrators-in-the-cloud-era-1h82)

**Three concrete falsifications of the SSPL/AGPL fear:**

1. **There is no source-disclosure clause in the TSL at all.** Grep the
   [license text](https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE) — no
   "corresponding source", no "Service Source Code", no "make available the source". The SSPL's defining
   §13 has no TSL analog.
2. **The trigger is a *deployment shape*, not *network interaction*.** AGPL fires when users touch the
   software over a network (which our analytics API would do). TSL fires only when you *resell the DB
   itself*. Our analytics API serving customers does the former and not the latter → AGPL would bind,
   TSL does not.
3. **Tiger Data's *own stated intent* is to stop cloud vendors reselling, not to copyleft adopters.**
   The license was authored specifically so "everyday users, like DBAs and developers" keep full freedom
   while AWS-class hosts can't offer a managed TimescaleDB.
   ([medium/how-we-are-building](https://medium.com/timescale/how-we-are-building-a-self-sustaining-open-source-business-in-the-cloud-era-a7701516a480))

> **Caveat worth stating honestly:** TSL is **source-available**, not OSI-approved open source, and *is*
> a proprietary license in the formal sense (the OSI would not certify it; it fails the
> no-field-of-use-restriction criterion because of §2.2). If your org has a **hard policy of "only
> OSI-approved / only Apache-compatible licenses in the stack"**, then you must either (a) restrict to
> the Apache-2 subset (losing compression/continuous-aggregates/policies — a large loss for analytics),
> or (b) get a policy exception for the well-scoped TSL. That is a *governance* question, not a
> *technical* one — flag it to the operator rather than assuming. For most product teams the TSL is a
> non-issue; for a bank's OSS-governance committee it is a checkbox that needs an explicit sign-off.

---

## 6. The decision checklist — apply this to every feature and every deployment

Before any TimescaleDB-leaning design is called "done", answer these in writing. This is the operational
distillation of §§1–5.

### 6.1 Per-feature: Apache or TSL?

For each TimescaleDB function/DDL the design depends on, classify it (use the §2 tables):

- [ ] **Is it in the Apache subset?** (`create_hypertable`, `show_chunks`/`drop_chunks`, tablespace
      funcs, `time_bucket`, `approximate_row_count`, `first`/`last`/`histogram`.) → No license
      constraint whatsoever, including resale.
- [ ] **Is it TSL Community?** (any `*_policy`, `add_job`/`alter_job`/`delete_job`, compression /
      columnstore / Hypercore, continuous aggregates, `time_bucket_gapfill`/`locf`/`interpolate`, any
      `timescaledb_toolkit` function.) → Free to self-host; the §2.2 DBaaS-resale prohibition is the only
      attached condition.
- [ ] **Record the classification next to the feature in the design doc** (so a later reviewer doesn't
      re-derive it). Tag toolkit usage explicitly — it's a *separate extension to install*, also TSL.

### 6.2 Per-deployment: do we trip §2.2?

- [ ] **Are we self-hosting?** (Our VMs / our K8s / a managed *Postgres* where *we* installed the
      extension — Supabase/RDS-with-extension/Crunchy/etc.) → Self-host grant applies (§2.1(a)).
- [ ] **Is the database the product, or is the database *inside* the product?** If customers interact
      with **our endpoints / our app** and never get raw Postgres DDL access, we are a **Value-Added
      Product** (§2.1(b)) → §2.2 does not bind us. If we were literally renting out TimescaleDB
      instances for customers to run their own DDL → §2.2 **would** bind. (We are the former.)
- [ ] **Do any external customers get the DDL interface?** They must not be able to redefine the schema
      via DDL (§2.1(b) proviso). DML through our controlled API is fine; raw `CREATE/ALTER TABLE` access
      handed to outsiders is not.
- [ ] **Is `timescaledb.license` pinned to `timescale` and verified at boot?** (Defaults can land on
      `apache` — §4.2.) Confirm with `SHOW timescaledb.license;` in the health check.
- [ ] **OSS-governance policy check:** does the org forbid non-OSI / non-Apache licenses in the stack?
      If yes → escalate (Apache-subset or policy exception). If no policy → TSL is cleared.

### 6.3 The one-question summary

> **"Is the feature my design leans on Apache or TSL — and does my deployment hand the TimescaleDB DB
> interface itself to third parties as the product?"**
> If the answer is "(either license) and *no, the DB is embedded in our value-added product, self-hosted
> on our infra*" → **fully cleared, free, commercial, no source disclosure.** That is our case.

---

## 7. Two orthogonal license axes — DO NOT conflate the engine license with the market-DATA license

This is the most important boundary in this whole doc, and it borrows the *mindset* from Lumina's
`commercial-ok-gate` rule **without** importing its data-licensing conclusions. (Lumina is a different
product; we cite its rule only as a reasoning pattern.)

**The Lumina mindset we keep:** *"The license attaches to the FETCH PATH, not the concept."* In Lumina's
world the same 10-year-yield number is GREEN from treasury.gov and RED from Yahoo's chart API — you
cannot reason about a license from the *data type*, only from *where it came from*. (See
`.claude/rules/commercial-ok-gate.md`.)

**We apply the identical *structure* to a different pair of axes here:**

| Axis | Question it answers | Governed by | Our verdict |
|---|---|---|---|
| **Engine/software license** | "May we run this *database software* in production, commercially, self-hosted, without disclosing our source?" | Apache-2 / TSL (this doc) | **Cleared** — self-host, Value-Added Product, §2.2 not tripped. |
| **Market-DATA license** | "May we *display/redistribute* this specific price/quote/series to users?" | The *provider's* ToS for the *exact fetch path* (Twelve Data tier, Yahoo chart API, EDGAR, GDELT, treasury.gov, …) — the `commercialOk` gate | **Per-feed, default RED** until a GREEN fetch path is confirmed. **Entirely independent of TimescaleDB's license.** |

**The two never substitute for each other:**

- A **GREEN** public-domain series (e.g. US-Treasury yields from treasury.gov) stored in a **TSL
  Community** TimescaleDB: the *data* is GREEN to display, the *engine* is TSL self-hosted-fine. Both
  green-light, on different grounds.
- A **RED** scraped quote feed (e.g. a free-tier API with no display license) stored in an **Apache**
  TimescaleDB: the Apache engine license does **nothing** to make the data displayable — it's still RED
  on the data axis and you cannot show it. Apache-on-the-engine ≠ clearance-on-the-data.

> **The trap this section prevents:** a junior reasoner sees "TimescaleDB is free / Apache-open" and
> concludes "so the data in it is fine to display." That is a category error. The engine license clears
> *running the software*; it says **nothing** about whether the *numbers flowing through it* carry a
> display/redistribution right. Keep two separate ledgers: (1) an **engine-license note** per feature
> ("uses continuous aggregates → TSL Community → self-host-cleared"), and (2) a **per-feed
> `commercialOk` / provenance record** for every market-data series, exactly as the JPM-Markets data
> ingestion design must — defaulting RED until the *fetch path* is proven GREEN.

---

## 8. Pre-mortem — "six months out, this licensing call blew up. Why?"

1. **We shipped on `apache` mode by accident** and a continuous-aggregate refresh policy silently never
   ran (or threw at deploy), corrupting our rollups. → *Fix already specified:* pin
   `timescaledb.license = 'timescale'`, assert `SHOW timescaledb.license` in the boot health check (§4).
2. **An OSS-governance committee blocked TSL late** because nobody flagged "source-available ≠ OSI
   open-source" up front. → *Fix:* surface the §5 caveat at design kickoff, get the exception or scope to
   Apache-subset *before* building on compression/continuous-aggregates.
3. **A product pivot turned us into a DBaaS** — e.g. someone proposed "let customers bring their own
   schema and run raw SQL against our TimescaleDB." That *would* trip §2.2 / the §2.1(b) proviso. → *Fix:*
   the §6.2 checklist re-runs on every deployment-shape change; "do external customers get the DDL
   interface?" is the tripwire.
4. **We assumed Timescale Cloud's pricing/terms applied to our self-host.** They don't — *managed cloud*
   is a separate commercial product; the **self-hosted extension under TSL is free**. → *Fix:* never
   reason about self-host cost from the cloud pricing page.
5. **We conflated the engine license with data licensing** and displayed a RED feed because "the DB is
   open." → *Fix:* §7 — two ledgers, never substitute one for the other.

---

## 9. Confidence & open items

| Claim | Confidence | Basis |
|---|---|---|
| Source split is by directory (`tsl/` = TSL, else Apache); `-tsl` binary suffix | **High** | Repo `LICENSE` file, verbatim. |
| Feature classification in §2 (Apache vs TSL) | **High** | Editions page + comparison page + the runtime `apache`-license error in issue #3718, cross-verified. |
| `first`/`last`/`histogram`/`time_bucket`/`approximate_row_count` are Apache; gapfill/`locf`/`interpolate` and all policies/jobs are TSL | **High** | Editions feature matrix, explicit. |
| `timescaledb_toolkit` is TSL | **High** | Toolkit `LICENSE` file, verbatim. |
| Self-host is free incl. commercial internal/value-added use; §2.2 is the sole prohibition | **High** | TSL §2.1(a), §2.1(b), §2.2 verbatim + editions page. |
| `timescaledb.license` default can be `apache` in real packages (set it explicitly) | **Medium-High** | Issue #3718 (open, observed on 2.4.2); behavior may vary by package/version — **verify on the exact image you deploy** rather than trusting the default. |
| TSL is not AGPL/SSPL; no source-disclosure trigger | **High** | License text has no disclosure clause; corroborated by vendor + third-party analysis. |
| OSI-status caveat (source-available, not OSI-approved) | **High** | §2.2 is a field-of-use restriction → fails OSI criteria; this is the standard reading. |

**Open items to confirm at build time (not assumptions — verifications):**
- The **exact** `timescaledb.license` default on the **specific Docker tag / package** we deploy — run
  `SHOW timescaledb.license;` against the real image; don't trust the docs default.
- The **pinned TimescaleDB and toolkit versions** for the platform — record `extversion` from
  `pg_extension`; this doc cites behavior current as of the 2.x line / `main`, but pin and re-read the
  per-function license badges in the API reference for the exact version chosen.
- Whether the org's **OSS-governance policy** clears source-available licenses — a governance decision to
  route to the operator, per §5's caveat.

---

### Primary sources (read at authoring time)

- TimescaleDB editions / feature matrix — https://www.tigerdata.com/docs/about/latest/timescaledb-editions
- Compare TimescaleDB editions (per-edition rights, verbatim) — https://www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions
- Legal / licenses (TSL overview, §2.1/§2.2/§3.9 clauses) — https://www.tigerdata.com/legal/licenses
- Repo top-level LICENSE (directory split, `-tsl` binaries) — https://github.com/timescale/timescaledb/blob/main/LICENSE
- TSL full text — https://github.com/timescale/timescaledb/blob/main/tsl/LICENSE-TIMESCALE
- Toolkit LICENSE (TSL) — https://github.com/timescale/timescaledb-toolkit/blob/main/LICENSE
- GUC default-value issue #3718 — https://github.com/timescale/timescaledb/issues/3718
- Apache-only build flag (ecosystem) — https://github.com/zalando/spilo/pull/419
- Original dynamic-module/license-key commit — https://github.com/timescale/timescaledb/commit/4ff6ac7b917a3dae8796b4a4e36001598db645d0
- AGPL/SSPL distinction analysis — https://dev.to/okedialf/what-the-timescale-license-means-for-database-administrators-in-the-cloud-era-1h82
- Vendor intent (why the TSL exists) — https://medium.com/timescale/how-we-are-building-a-self-sustaining-open-source-business-in-the-cloud-era-a7701516a480