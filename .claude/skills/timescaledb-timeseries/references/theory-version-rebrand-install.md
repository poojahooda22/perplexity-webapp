# theory · TimescaleDB — current version line, the Tiger Data rebrand, install & extension setup

> **Scope.** The operational ground-truth a builder needs before writing a single line of
> TimescaleDB-backed code for the **JPM-Markets re-engineering data-analytics product line (NOT
> Lumina)**: which version is current and which PostgreSQL majors it runs on, the **Timescale Inc. →
> Tiger Data** corporate rebrand and the **docs-host + doc-path move** it caused (the single biggest
> source of stale, wrong instructions in 2025–2026), how the extension actually installs (Docker vs
> apt/yum vs Tiger Cloud), the `CREATE EXTENSION` dance for `timescaledb` **and** `timescaledb_toolkit`,
> the `timescaledb.license` GUC that gates Community-vs-Apache features, the version-upgrade ritual
> (including the 2.27 bloom-filter migration), and the discipline of **verifying every API against the
> installed version this session**.
>
> **This is `theory-*`: generic, reusable, not tied to any codebase file:line** (greenfield). It is the
> first reference any other doc in this skill assumes you have read. Everything here is pinned to a
> primary source; **re-fetch the releases page at build time** (see §10) because this line moves roughly
> every two weeks.

---

## 0 · The 60-second version of this doc

If you read nothing else:

1. **Current stable: TimescaleDB `2.28.1`, released 2026-06-23.** Supports PostgreSQL **15, 16, 17, 18**.
   PG15 support **ends at 2.28.x** — `2.29.0` drops it. **Pin `>=16` for any new build.** (§1)
2. **Timescale Inc. is now "Tiger Data" (rebrand 2025-06-17).** The **open-source extension is still
   named `TimescaleDB`** — that did not change. The **cloud product is now "Tiger Cloud"** (was Timescale
   Cloud). (§2)
3. **`docs.timescale.com` 301-redirects to `www.tigerdata.com/docs/...`** and **some doc paths were
   reorganized**, so a URL you remember from 2024 may resolve to the wrong page or a 404. **Do not trust a
   stale doc URL or a pre-rebrand function name without re-checking the live page.** (§3)
4. **Terminology changed: "compression" → "columnstore"; the storage engine is "Hypercore"
   (rowstore + columnstore).** The old **Hypercore *access method* (TAM)** was deprecated and sunset —
   use the **columnstore via `convert_to_columnstore` / `add_columnstore_policy`**, not the deprecated
   `USING hypercore` TAM. (§4)
5. **Install:** Docker `timescaledb-ha` (recommended, includes toolkit + PostGIS) or apt/yum
   `timescaledb-2-postgresql-NN`. Then `shared_preload_libraries='timescaledb'`, restart, and
   `CREATE EXTENSION timescaledb`. Toolkit is a **separate** `CREATE EXTENSION timescaledb_toolkit`. (§5, §6)
6. **`timescaledb.license`** GUC = `timescale` (Community, the default — gives you continuous aggregates,
   columnstore, retention/job policies, advanced hyperfunctions) or `apache` (strips all of those). (§7)
7. **Upgrade** = `apt upgrade` the package → restart PG → `psql -X` → `ALTER EXTENSION timescaledb UPDATE`.
   The **2.27 upgrade has a bloom-filter caveat** requiring a catalog-only migration script. (§8)
8. **Verify the API against the INSTALLED version this session** before you ship a function call. (§9)

---

## 1 · The current version line and the PostgreSQL support matrix

### 1.1 Current release (verify at build time — see §10)

| Fact | Value | Source |
|---|---|---|
| Latest stable | **`2.28.1`** | github.com/timescale/timescaledb/releases — tag `2.28.1` |
| Release date | **2026-06-23** | same |
| Prior recent tags | `2.28.0` (2026-06-16), `2.27.2` (2026-06-02), `2.27.1` (2026-05-19), `2.27.0` (2026-05-12), `2.26.4` (2026-04-28) | releases page |
| Supported PostgreSQL | **15, 16, 17, 18** | CHANGELOG (v2.23 "available for PostgreSQL 15, 16, 17, and 18") |
| PG18 support added in | **`2.23.0`** | CHANGELOG: *"This release introduces full PostgreSQL 18 support for all existing features. TimescaleDB v2.23 is available for PostgreSQL 15, 16, 17, and 18."* |
| PG14 dropped in | **`2.20.0`** | CHANGELOG (PG14 no longer supported as of v2.20.0) |

`2.28.1` is a pure performance + bugfix point release over `2.28.0` — *"This release contains performance
improvements and bug fixes since the 2.28.0 release. We recommend that you upgrade at the next available
opportunity."* (github.com/timescale/timescaledb/releases/tag/2.28.1). No schema migration, no breaking
change in `.1`. Its fixes are in the compressed-table / `first`/`last` / `ALTER TABLE ADD CONSTRAINT`
paths — relevant if you compress (columnstore) financial tick data and run `first()`/`last()` aggregates,
which a markets analytics product does constantly.

### 1.2 The PG15 deprecation cliff — pin `>=16`

This is the load-bearing decision for a **new** build. Two primary quotes:

- **v2.27.0 changelog:** *"We will continue supporting PostgreSQL 15 until June 2026. Closer to that
  time, we will announce the specific TimescaleDB version in which PostgreSQL 15 support will not be
  included going forward."*
- **v2.28.0 changelog / release notes:** *"This release marks the final minor version of TimescaleDB
  that will support PostgreSQL 15. Starting with our next release, version 2.29.0, we will officially
  drop support for Postgres 15, and only support Postgres 16, 17, and 18."*

**Decision for this product line:**

> **Build on PostgreSQL 16, 17, or 18. Never start a new TimescaleDB project on PG15 in mid-2026** — it
> is end-of-line within one TimescaleDB release and you would inherit a forced major-version migration on
> day one.

Which of 16/17/18 to pick:

| PG major | Choose it when | Caveat |
|---|---|---|
| **17** | **Default recommendation for a production financial-analytics build today.** Mature, every TimescaleDB feature GA, broadest managed-host + extension-ecosystem support. | — |
| **18** | You specifically want PG18 features (e.g. async I/O, the newer planner work) and have verified your *other* extensions (PostGIS, pgvector, etc.) all ship PG18 builds. | TimescaleDB supports it since `2.23.0`, but the surrounding extension ecosystem lags a new PG major by months — **confirm every extension you load has a PG18 build before committing**. |
| **16** | A managed host (RDS, Cloud SQL, Tiger Cloud) you must use only offers up to 16. | Fine; fully supported. Just not the newest planner. |

> **R-SCALE note (this product line ships at scale).** PG major choice is a *foundational* decision, not a
> tuning knob — changing it later is a `pg_dump`/`pg_restore` or logical-replication migration of the
> whole dataset. State the chosen major in `00-theory.md` / `01-plan.md` with the reason, per cto-rules §6.

---

## 2 · The Tiger Data rebrand — what changed and what did NOT

This trips up every builder who learned TimescaleDB before mid-2025. The mechanics:

### 2.1 The event

- **2025-06-17: Timescale Inc. announced it is now "Tiger Data."** Primary sources:
  `www.tigerdata.com/blog/timescale-becomes-tigerdata` and the newsroom release
  `www.tigerdata.com/newsroom/timescale-becomes-tiger-data-defining-a-new-standard-as-the-fastest-postgresql-platform-for-modern-applications`;
  the Hacker News discussion (news.ycombinator.com/item?id=44300064, "Timescale Is Now TigerData")
  captures the community confusion.
- The framing (from the blog): *"This is not a reinvention: it's a reflection of how we already serve our
  customers today."* The logo (the tiger) stayed.

### 2.2 The rename map — memorize this

| Old name (pre-2025-06-17) | New name | Notes |
|---|---|---|
| Timescale **Inc.** (the company) | **Tiger Data** | Corporate identity only. |
| **Timescale Cloud** (the managed DBaaS) | **Tiger Cloud** | The hosted product. |
| **TimescaleDB** (the open-source PG extension) | **TimescaleDB** — *unchanged* | *"Our open source time-series PostgreSQL extension remains TimescaleDB."* (blog) |
| `docs.timescale.com` | **`www.tigerdata.com/docs`** (also `docs.tigerdata.com`) | 301 redirect — see §3. |
| `@TimescaleDB` (social) | `@TigerDatabase` / `@TigerData` | Cosmetic. |

> **The one fact that prevents 90% of the confusion:** the thing you `CREATE EXTENSION` and write SQL
> against is **still literally called `timescaledb`**. The extension name, the GitHub repo
> (`timescale/timescaledb`), the package names (`timescaledb-2-postgresql-NN`), the Docker org
> (`timescale/...`), the GUC prefix (`timescaledb.*`), and the SQL functions did **not** get renamed to
> "tiger." Only the *company*, the *cloud product*, and the *docs host* moved. So when you see "Tiger
> Cloud" in docs and "timescaledb" in SQL, that is correct and consistent, not a mistake.

### 2.3 Why this matters for the build

- Training data, blog posts, Stack Overflow answers, and your own memory from before 2025-06-17 will say
  "Timescale Cloud," cite `docs.timescale.com`, and use pre-rebrand UI labels. **None of that is wrong
  about the SQL**, but all of it is wrong about *where to read the current docs* and *what the cloud
  product is called*. Treat any pre-rebrand doc URL as "verify against the live page first."
- For citations in `00-theory.md`: cite the **current** host (`www.tigerdata.com/docs/...`) so the links
  don't look stale, but know the old links still resolve via 301 if you only have those.

---

## 3 · The docs-host + doc-path gotcha (the #1 stale-instruction trap)

Two *separate* things changed, and they compound:

### 3.1 Host moved: `docs.timescale.com` → `www.tigerdata.com/docs` (301)

Verified live: fetching `https://docs.timescale.com/self-hosted/latest/install/installation-docker/`
returns **`301 Moved Permanently`** to
`https://www.tigerdata.com/docs/self-hosted/latest/install/installation-docker`. So old links *work*, but
they redirect, and link-checkers / WebFetch surface the redirect rather than following it silently.

### 3.2 Paths were reorganized, so some old URLs 404 or land on a different page

The docs site was **restructured**, not just rehosted. Concretely, the **API reference** now lives under
multiple parallel trees and the *path you remember may not exist*:

| You might remember… | It may now be… |
|---|---|
| `docs.timescale.com/api/latest/hypertable/create_hypertable/` | `www.tigerdata.com/docs/api/latest/hypertable/create_hypertable` *and* a parallel `www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable` |
| `docs.timescale.com/use-timescale/latest/hypercore/` | `www.tigerdata.com/docs/build/columnar-storage/...` (the "compression" docs were renamed to "columnstore" — §4) |
| `docs.timescale.com/self-hosted/latest/upgrades/minor-upgrade/` | `www.tigerdata.com/docs/deploy/self-hosted/upgrades/minor-upgrade` (note the added `/deploy/` segment — the bare `/self-hosted/...` path can **404**) |

**Empirically observed:** `www.tigerdata.com/docs/self-hosted/latest/upgrades/minor-upgrade/` returns
**404**, while `www.tigerdata.com/docs/deploy/self-hosted/upgrades/minor-upgrade` is the live page. So the
gotcha is not just "swap the hostname" — the **path segments moved too**.

### 3.3 The operating rule

> **Before citing or following any TimescaleDB doc URL, fetch it and confirm it 200s and is about what
> you think.** If it 301s, update to the destination. If it 404s, search
> `site:tigerdata.com <topic>` to find the current path. Never paste a pre-rebrand `docs.timescale.com`
> link into `00-theory.md` as if it's canonical — re-resolve it to the live `tigerdata.com` page first.

Anchor doc roots that are live as of this writing (re-verify at build time):

- Releases / changelog (the source of truth for versions): `github.com/timescale/timescaledb/releases`
  and `github.com/timescale/timescaledb/blob/main/CHANGELOG.md` (the GitHub copy never moved).
- Install (self-hosted): `www.tigerdata.com/docs/get-started/choose-your-path/install-timescaledb`.
- Toolkit install: `www.tigerdata.com/docs/deploy/self-hosted/tooling/install-toolkit`.
- Editions / license: `www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions`.
- API reference: `www.tigerdata.com/docs/api/latest/...`.

---

## 4 · Terminology that changed: "compression" → "columnstore", and the Hypercore TAM deprecation

A second naming shift, internal to the product, that pre-rebrand docs and training data get wrong:

### 4.1 The current vocabulary

- **Hypercore** = the hybrid **row + columnar storage engine**.
  (docs.tigerdata.com/use-timescale/latest/hypercore/real-time-analytics-in-hypercore/)
- **Rowstore** = where new data lands first; optimized for high-speed inserts/updates.
- **Columnstore** = compressed columnar form chunks are converted into; *"reduce your chunk size by up to
  98% and speed up your queries."* What older docs called **"compression"** is now **"columnstore."**
- Functions: **`convert_to_columnstore(chunk)`** (manual) and **`add_columnstore_policy(...)`** (the
  recommended automatic policy). `convert_to_rowstore()` is the inverse.
  (github.com/timescale/docs `api/hypercore/convert_to_columnstore.md`;
  www.tigerdata.com/docs/api/latest/hypercore/convert_to_rowstore)

> **Mapping for old muscle memory:** the function you may remember as `compress_chunk()` / the
> `timescaledb.compress` table option / `add_compression_policy()` corresponds to today's
> **columnstore** vocabulary (`convert_to_columnstore` / `add_columnstore_policy`). The old function names
> may still exist as aliases on a given version, **but do not assume — check the installed version's
> `\dx+ timescaledb` / the API reference for that version** (§9). This is exactly the kind of
> pre-rebrand-name trap §0.4 warns about.

### 4.2 The Hypercore *access method* (TAM) is deprecated — do NOT use `USING hypercore`

There were briefly **two** ways to get columnar storage:

1. The **columnstore policy** (the supported, recommended path): keep the table as a normal hypertable and
   let `add_columnstore_policy` / `convert_to_columnstore` move aged chunks to columnar form.
2. The **Hypercore Table Access Method (TAM)** — `CREATE TABLE ... USING hypercore` — a Postgres
   custom access method.

**The TAM was deprecated in `2.21.0` and sunset in `2.22.0` (Sept 2025).** (Web sources + PR
github.com/timescale/timescaledb/pull/8341 "Allow quick migration from hypercore TAM to (columnstore)
heap.") **Do not build on `USING hypercore`.** Use the **columnstore policy** API. If you find a tutorial
using `USING hypercore`, it predates the sunset — that is a §0.4 stale-name signal; pick the policy-based
recipe instead.

---

## 5 · Installing TimescaleDB — the three paths and which one to use

| Path | What you get | Use when |
|---|---|---|
| **Docker `timescaledb-ha`** | Ubuntu base, **TimescaleDB + Toolkit + PostGIS + Patroni** pre-bundled; the extension is **pre-created** in the default DB. | **Local dev and most self-hosted builds.** The fewest moving parts; toolkit is already there. |
| **Docker `timescaledb` (light)** | Alpine base, **TimescaleDB only** — *no* Toolkit, *no* PostGIS, *no* Patroni. | A minimal image when you genuinely don't need toolkit/PostGIS and want the smallest footprint. |
| **apt / yum on a host** | The extension installed into an existing PostgreSQL; you run `timescaledb-tune` and `CREATE EXTENSION` yourself. | Bare-metal / VM production where you manage PostgreSQL directly, or RDS-adjacent setups. |
| **Tiger Cloud** (managed, was "Timescale Cloud") | Fully managed; TimescaleDB + Toolkit pre-enabled; horizontally scalable reads, hot/cold tiering, compression at scale. | You want managed ops and don't want to run Patroni/backups yourself. Features differ — see §5.3. |

### 5.1 Docker — the recommended local-dev recipe (`timescaledb-ha`)

The HA image *"uses Ubuntu, includes TimescaleDB Toolkit, and support for PostGIS and Patroni"*, and
**TimescaleDB is pre-created in the default database**
(www.tigerdata.com/docs/self-hosted/latest/install/installation-docker):

```bash
# Pull a PG-major-pinned HA image (PICK YOUR PG MAJOR — pg17 recommended; never pg15 for new builds)
docker pull timescale/timescaledb-ha:pg17

# Run it
docker run -d --name tsdb \
  -p 5432:5432 \
  -v "$PWD/pgdata:/home/postgres/pgdata/data" \
  -e POSTGRES_PASSWORD=changeme \
  timescale/timescaledb-ha:pg17
# (the docs example uses -v <local>:/pgdata with -e PGDATA=/pgdata; either works — match the image's expected PGDATA)
```

Then connect and confirm — the extension should already be present in the HA image, but `CREATE EXTENSION
IF NOT EXISTS` is idempotent and the canonical step:

```sql
-- psql -h localhost -U postgres
CREATE EXTENSION IF NOT EXISTS timescaledb;       -- pre-created in -ha, but harmless to assert
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;  -- toolkit binaries ARE in -ha; this enables them in THIS db
\dx                                                -- verify: timescaledb + timescaledb_toolkit listed with versions
SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';  -- e.g. 2.28.1
```

### 5.2 Docker — the light image (`timescaledb`, Alpine)

Tag convention is **`<tsdb-version>-pg<major>`** or **`latest-pg<major>`**; there is **deliberately no bare
`latest` tag** ("to prevent unexpected major version upgrades across both TimescaleDB and PostgreSQL" —
hub.docker.com/r/timescale/timescaledb). Examples: `latest-pg17`, `2.28.1-pg17`.

```bash
docker pull timescale/timescaledb:latest-pg17     # Alpine, TimescaleDB only (NO toolkit, NO PostGIS)
docker run -d --name tsdb-light -p 5432:5432 \
  -e POSTGRES_PASSWORD=changeme timescale/timescaledb:latest-pg17
```

> **Gotcha:** if you pull the light image and then `CREATE EXTENSION timescaledb_toolkit`, it **fails** —
> the toolkit binaries are not in the Alpine image. Toolkit ⇒ use `timescaledb-ha` (or install the toolkit
> package separately, §6). Pin the **exact** `-pg17` tag in CI; never rely on a floating `latest`.

### 5.3 apt / yum (self-hosted on an existing PostgreSQL)

Verified package names (www.tigerdata.com/docs/self-hosted/latest/install/installation-linux):

```bash
# --- Debian / Ubuntu (apt) ---
# 1. Add the Tiger Data (packagecloud) repo + GPG key (re-check the exact key URL on the live install page)
echo "deb https://packagecloud.io/timescale/timescaledb/debian/ $(lsb_release -c -s) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
# (download & install the packagecloud GPG key per the live docs, then)
sudo apt-get update

# 2. Install — note the NN is the PostgreSQL major you chose (16/17/18, NOT 15 for new builds)
sudo apt-get install -y timescaledb-2-postgresql-17 postgresql-client-17

# --- RHEL / Rocky / Fedora (yum/dnf) equivalent ---
# sudo yum install -y timescaledb-2-postgresql-17 postgresql17
```

Then **tune, configure preload, restart, create the extension**:

```bash
# 3. Tune postgresql.conf for TimescaleDB (sets shared_preload_libraries among others)
sudo timescaledb-tune            # interactive; review the diff it proposes

# If you skip the tuner, you MUST set this yourself in postgresql.conf:
#   shared_preload_libraries = 'timescaledb'
# (TimescaleDB is a preloaded extension — it will NOT work without this line + a restart.)

# 4. Restart PostgreSQL so the preload takes effect
sudo systemctl restart postgresql

# 5. In the target database:
#   CREATE EXTENSION IF NOT EXISTS timescaledb;
```

> **The single most common install failure:** running `CREATE EXTENSION timescaledb` **without**
> `shared_preload_libraries = 'timescaledb'` set and PostgreSQL restarted. The error is *"could not access
> file 'timescaledb': No such file or directory"* or a preload complaint. Fix = set the GUC, restart,
> retry. (See github.com/timescale/timescaledb/issues/2984 for the canonical "Cannot create extension"
> thread — almost always a preload/restart problem.) **Note:** package name uses `-2-`
> (`timescaledb-2-postgresql-NN`) — the `2` is the TimescaleDB v2 series, not the PG version.

### 5.4 Tiger Cloud (managed) — what differs

Tiger Cloud (the rebranded Timescale Cloud) has TimescaleDB + Toolkit **pre-enabled**, plus managed-only
capabilities the open-source extension doesn't ship: *"horizontally scalable reads, compression at 100+
petabyte scale, hot/cold data tiering, and deep observability"* (rebrand newsroom). For a self-hosted
build you get the **open-source extension feature set** (everything the Community license enables, §7) but
you operate tiering/replication/backups yourself. **Decision input:** if `00-theory.md` assumes
"data tiering to cold storage," confirm whether that means **Tiger Cloud's managed tiering** (cloud-only)
or you are building tiering yourself on self-hosted — they are not the same capability.

---

## 6 · `CREATE EXTENSION` — `timescaledb` AND `timescaledb_toolkit` are two separate extensions

This is a frequent point of confusion: **the toolkit is a different extension** from core TimescaleDB.

### 6.1 Core

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

Requires `shared_preload_libraries='timescaledb'` + restart (§5.3). Gives you hypertables, continuous
aggregates, columnstore, retention/job policies, and the base hyperfunctions (`time_bucket`, etc.).

### 6.2 Toolkit (separate extension — more hyperfunctions)

`timescaledb_toolkit` is *"Extension for more hyperfunctions, fully compatible with TimescaleDB and
PostgreSQL"* (github.com/timescale/timescaledb-toolkit). It adds the **advanced analytical hyperfunctions**
a markets product wants: time-weighted averages, percentile approximation (`tdigest`/`uddsketch`),
`stats_agg`, gap-filling pipelines, ASAP/LTTB downsampling, etc.

```sql
-- Toolkit binaries must be present first (they are in timescaledb-ha and on Tiger Cloud; install the
-- timescaledb-toolkit-postgresql-NN package on a host that doesn't have them).
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
-- After a toolkit binary upgrade, also run:
ALTER EXTENSION timescaledb_toolkit UPDATE;
```

Host install of the toolkit package (Debian/Ubuntu), per
www.tigerdata.com/docs/deploy/self-hosted/tooling/install-toolkit — *"The extension packages are named
`timescaledb-toolkit-postgresql-<VERSION>` where `<VERSION>` is the PostgreSQL major version (15, 16, 17,
or 18)"*:

```bash
sudo apt-get install -y timescaledb-toolkit-postgresql-17
# then in psql:  CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
```

### 6.3 Toolkit facts to pin

| Fact | Value | Source |
|---|---|---|
| Latest toolkit release | **`1.23.0`** (2026-06-03) | github.com/timescale/timescaledb-toolkit |
| Supported PG | **15, 16, 17, 18** (tested via `cargo pgrx test pg15..pg18`) | toolkit repo |
| License | **Timescale License (TSL)** — *"licensed under the Timescale License"* | github.com/timescale/timescaledb-toolkit/blob/main/LICENSE → tsl/LICENSE-TIMESCALE |
| Relationship to core | Independent extension; **install/enable separately** | toolkit README |

> **Versioning is independent.** Toolkit `1.23.0` ≠ TimescaleDB `2.28.1`. They have separate version
> numbers and separate `ALTER EXTENSION ... UPDATE` cycles. Don't conflate them.

> **License note for THIS product line.** Toolkit is **TSL**, not Apache-2. The cto-rules / commercial-ok
> discipline cares about *displayed-data* licensing, but **code/dependency** licensing matters too: TSL
> lets you run toolkit for free **as long as you are not offering it as a hosted DBaaS** (the TSL "you may
> not provide the software as a managed service" clause — www.tigerdata.com/legal/licenses). A
> markets-analytics product *consuming* toolkit internally is fine; **re-read the TSL** if you ever plan to
> resell database hosting. Record this in the sources/decisions trail.

---

## 7 · The `timescaledb.license` GUC — Community vs Apache features

TimescaleDB ships **two editions out of one binary**, gated by one GUC.

### 7.1 The GUC

```sql
SHOW timescaledb.license;   -- returns 'timescale' (Community, DEFAULT) or 'apache'
```

- **Valid values: `timescale` and `apache`.** (Verified against source:
  `src/license_guc.c` checks `strcmp(string, TS_LICENSE_TIMESCALE)` and
  `strcmp(string, TS_LICENSE_APACHE)`.)
- **Default is `timescale`** (Community Edition — all features enabled).
  *(Historical trap: an old docs bug — github.com/timescale/timescaledb/issues/3718 — once claimed the
  default was `apache`; the actual runtime default is `timescale`. Trust `SHOW timescaledb.license;` on
  YOUR install, not a doc sentence.)*
- The GUC name is `timescaledb.license` (the older `timescaledb.license_key` was renamed).
- **It can only be changed from the config file or the server command line, not in a live session.** The
  source's check-hook message: *"Cannot change a license in a running session. Change the license in the
  configuration file or server command line."* So to run Apache-only you set it in `postgresql.conf`:
  ```
  timescaledb.license = 'apache'
  ```
  and restart. You cannot `SET timescaledb.license = 'apache';` interactively.

### 7.2 What `apache` mode DISABLES (i.e. what Community/`timescale` gives you)

Setting `timescaledb.license = 'apache'` strips the Community (TSL-licensed) features. Per the editions
page (www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions), Apache-2-only mode
**lacks**:

| Feature group | Functions disabled in `apache` mode |
|---|---|
| **Continuous aggregates** | `CREATE/ALTER/DROP MATERIALIZED VIEW` (continuous aggs) + their refresh policies |
| **Hypercore / columnstore** | `convert_to_columnstore`, `add_columnstore_policy`, columnstore stats functions |
| **Retention & automation** | `add_retention_policy`, `remove_retention_policy`, `add_job`, `alter_job`, `delete_job`, `run_job` |
| **Advanced chunk mgmt** | `split_chunk`, `reorder_chunk`, `move_chunk`, `add_reorder_policy` |
| **Advanced hyperfunctions** | `time_bucket_gapfill`, `locf`, `interpolate`, percentile-approx, time-weighted calcs |

The docs put it bluntly: *"Many of the most recent features of TimescaleDB are only available in
TimescaleDB Community Edition."*

### 7.3 The decision for THIS product line

> **Keep the default `timescale` (Community) license.** A markets data-analytics product *needs* continuous
> aggregates (pre-rolled OHLC bars), columnstore (compress aged tick data), and retention/job policies
> (automated downsampling + drop). Apache-only mode removes exactly those. The **only** reason to set
> `apache` is a legal constraint requiring a pure Apache-2 stack — which would gut the value proposition,
> so flag it loudly in `00-theory.md` if it's ever proposed.
>
> **Why this is free for us:** Community Edition is free to self-host or run on your own cloud
> infrastructure; the TSL only restricts **offering TimescaleDB itself as a managed DBaaS**. We consume it
> internally → Community is the right, free, fully-featured choice.

---

## 8 · Version upgrades — the ritual and the 2.27 bloom-filter caveat

### 8.1 Minor upgrade (e.g. `2.27.x` → `2.28.1`)

Two halves: upgrade the **binary** (OS package or Docker image), then upgrade the **extension catalog**
inside each database.

```bash
# 1. Upgrade the binary
sudo apt-get update && sudo apt-get install --only-upgrade timescaledb-2-postgresql-17
# (Docker: pull the new -pgNN tag and recreate the container against the same volume)

# 2. Restart PostgreSQL so the new shared library loads
sudo systemctl restart postgresql

# 3. Update the extension in EACH database — note the -X flag, it is load-bearing
psql -X -d "$DB" -c "ALTER EXTENSION timescaledb UPDATE;"
# or pin a target:  ALTER EXTENSION timescaledb UPDATE TO '2.28.1';
```

The **`-X` flag is required**, not cosmetic — per the upgrade docs
(www.tigerdata.com/docs/deploy/self-hosted/upgrades/minor-upgrade): *"The `-X` flag prevents any `.psqlrc`
commands from accidentally triggering the load of a previous TimescaleDB version on session startup."* Run
the `ALTER EXTENSION` in a **fresh session** that hasn't yet touched any TimescaleDB object.

> **Read the release notes for the target version before upgrading** (the docs say so explicitly). Most
> minors are clean; some carry a one-time migration (§8.2).

### 8.2 The 2.27.0 bloom-filter migration (a real backward-incompatible change)

`2.27.0` (2026-05-12) shipped **two** backward-incompatible bloom-filter changes that bite if you compress
(columnstore) data:

1. *"bloom filter sparse indexes on compressed `int2` columns could lead to `SELECT` queries not returning
   matching rows"* — requires **manually deleting the affected index before upgrading**.
2. *"v2.27 cannot automatically utilize composite bloom filters generated in v2.26."* The fix is a
   **catalog-only** migration (no data recompression): *"This is a catalog-only operation requiring zero
   data recompression, which can be done with [this migration script]"* —
   `github.com/timescaledb-extras/.../utils/2.27.x-fix-composite-bloom-columns.sql`.

> **Concretely:** if you are coming **from 2.26.x with columnstore/compression in use**, run the
> `2.27.x-fix-composite-bloom-columns.sql` catalog migration as part of the upgrade, and check for bloom
> indexes on `int2` columns. A **fresh** build that starts directly on `2.28.x` has nothing to migrate —
> this caveat is upgrade-path-only. Either way, **read the `2.27.0` and `2.28.0` release notes** before
> any upgrade that crosses those versions.

### 8.3 Major PG upgrades are a different beast

Moving the **PostgreSQL major** under TimescaleDB (e.g. PG16→PG18) is a `pg_dump`/`pg_restore` or
logical-replication migration, governed by
www.tigerdata.com/docs/deploy/self-hosted/upgrades/upgrade-pg — **not** an `ALTER EXTENSION`. This is the
cost §1.2 warns about and the reason to pin `>=16` (ideally 17) from day one.

---

## 9 · The "verify the API against the INSTALLED version this session" discipline

This is a cto-rules / R70 §B3 ("hallucinated API not in the installed version") guardrail, made concrete
for TimescaleDB — a library where the **function names genuinely changed** (compression→columnstore,
`license_key`→`license`, the Hypercore TAM sunset, the generalized `by_range` API arriving in 2.13).

**Before you ship any TimescaleDB SQL, confirm the symbol exists on the version you actually run:**

```sql
-- 1. What version is installed RIGHT NOW?
SELECT extname, extversion FROM pg_extension WHERE extname IN ('timescaledb','timescaledb_toolkit');

-- 2. Does the function/signature I'm about to call actually exist on this version?
\df+ convert_to_columnstore          -- psql: list the function + its signature
SELECT proname, pg_get_function_arguments(oid)
FROM pg_proc WHERE proname = 'add_columnstore_policy';

-- 3. For a fresh build, confirm hypertable creation uses the CURRENT API
SELECT create_hypertable('ticks', by_range('ts'), if_not_exists => TRUE);  -- by_range = 2.13+ generalized API
```

**Rules of the discipline:**

- **Never call a function from memory or a pre-rebrand tutorial without confirming it on the installed
  version.** If a doc page uses `compress_chunk`/`add_compression_policy`/`USING hypercore`, treat it as
  *possibly stale* and check whether the **columnstore** names are what this version exposes.
- **Pin exact versions in code/CI** (Docker `-pg17` + `2.28.1-pg17`, package `timescaledb-2-postgresql-17`)
  so "the installed version" is deterministic and not a moving target.
- **Cite the version-specific doc**, e.g. `www.tigerdata.com/docs/api/latest/...`, and note that "latest"
  tracks the newest release — if you're on an older pin, read that version's API, not "latest."
- **When in doubt between two function names** (old vs new), the source of truth is **`\df`/`pg_proc` on
  the running database**, then the API reference for that version — in that order. Docs can lag; the
  catalog cannot lie about what's installed.

---

## 10 · Changelog-watching — re-check at build time

This line ships roughly **every two weeks** (2.26.4 → 2.27.0 → 2.27.1 → 2.27.2 → 2.28.0 → 2.28.1 spanned
2026-04-28 to 2026-06-23). **Anything in §1 may be stale by the time you build.** Before you finalize a
version pin:

1. **Re-fetch `https://github.com/timescale/timescaledb/releases`** — read the top tag, its date, and its
   release notes for backward-incompatible changes / migration scripts.
2. **Re-fetch `https://github.com/timescale/timescaledb/blob/main/CHANGELOG.md`** (raw:
   `raw.githubusercontent.com/timescale/timescaledb/main/CHANGELOG.md`) — confirm the **current supported
   PG matrix** and whether **PG15 has been dropped yet** (`2.29.0` is the announced cutoff).
3. **Update the pin** in this doc's §1 and in `00-theory.md`/`01-plan.md` to the version you actually built
   against, and note its date.
4. If you cross `2.27.0` on an upgrade path, re-read §8.2 (bloom migration).

> **The standing instruction (cto-rules):** never assert a version, PG-support fact, function name, or
> license value from training-data memory. Every one of those in this doc carries a primary-source
> citation precisely because they move — re-verify the load-bearing ones at write time.

---

## 11 · Quick reference card

```text
CURRENT (verify at build time — §10)
  TimescaleDB stable ........ 2.28.1   (2026-06-23)
  Supported PostgreSQL ...... 15, 16, 17, 18   (PG18 since 2.23.0; PG14 dropped 2.20.0)
  PG15 cliff ................ last supported in 2.28.x; DROPPED in 2.29.0  →  PIN >=16 (prefer 17)
  Toolkit stable ............ 1.23.0   (2026-06-03), PG15–18, license = TSL (separate versioning)

REBRAND (2025-06-17): Timescale Inc. → Tiger Data
  Extension name ............ STILL "timescaledb"  (unchanged — repo, packages, GUC, SQL all unchanged)
  Cloud product ............. "Timescale Cloud" → "Tiger Cloud"
  Docs host ................. docs.timescale.com → www.tigerdata.com/docs  (301; SOME PATHS MOVED/404)
  Vocabulary ................ "compression" → "columnstore"; engine = "Hypercore" (rowstore+columnstore)
  Deprecated ................ Hypercore ACCESS METHOD (USING hypercore) sunset 2.22.0 — use columnstore POLICY

INSTALL
  Docker (recommended) ...... timescale/timescaledb-ha:pg17     (Ubuntu; Toolkit+PostGIS+Patroni; ext pre-created)
  Docker (light) ............ timescale/timescaledb:latest-pg17 (Alpine; core ONLY — no toolkit/PostGIS)
  apt/yum ................... timescaledb-2-postgresql-17  (+ shared_preload_libraries='timescaledb' + restart)
  Tag rule .................. ALWAYS pin <ver>-pg<NN>; there is NO bare `latest` tag

EXTENSIONS (two separate)
  CREATE EXTENSION timescaledb;                 -- core (needs preload + restart)
  CREATE EXTENSION timescaledb_toolkit;         -- advanced hyperfunctions (separate; -ha image / package)

LICENSE GUC (postgresql.conf only; restart; cannot SET in-session)
  timescaledb.license = 'timescale'  (DEFAULT, Community — caggs/columnstore/policies/hyperfunctions)
  timescaledb.license = 'apache'     (strips ALL of the above — avoid for this product line)
  SHOW timescaledb.license;          -- trust THIS over any doc sentence

UPGRADE
  apt upgrade pkg → restart PG → psql -X → ALTER EXTENSION timescaledb UPDATE;   (-X is required)
  Crossing 2.27.0 w/ compression?  run 2.27.x-fix-composite-bloom-columns.sql (catalog-only) + drop int2 bloom idx

DISCIPLINE
  Verify EVERY function on the INSTALLED version (\dx, \df+, pg_proc) before shipping it.
  Re-fetch the releases page + CHANGELOG at build time; pin exact versions in CI.
```

---

## 12 · Primary sources (read these first; re-verify at build time)

- **Releases (version + PG matrix + breaking changes):** github.com/timescale/timescaledb/releases ·
  …/releases/tag/2.28.1 · …/releases/tag/2.28.0 · …/releases/tag/2.27.0
- **Changelog (raw, authoritative PG-support + drop notices):**
  raw.githubusercontent.com/timescale/timescaledb/main/CHANGELOG.md
- **Rebrand:** www.tigerdata.com/blog/timescale-becomes-tigerdata ·
  www.tigerdata.com/newsroom/timescale-becomes-tiger-data-defining-a-new-standard-as-the-fastest-postgresql-platform-for-modern-applications ·
  news.ycombinator.com/item?id=44300064
- **Install (self-hosted, Docker, Linux):** www.tigerdata.com/docs/get-started/choose-your-path/install-timescaledb ·
  www.tigerdata.com/docs/self-hosted/latest/install/installation-docker ·
  www.tigerdata.com/docs/self-hosted/latest/install/installation-linux
- **Toolkit:** github.com/timescale/timescaledb-toolkit ·
  www.tigerdata.com/docs/deploy/self-hosted/tooling/install-toolkit ·
  github.com/timescale/timescaledb-toolkit/blob/main/LICENSE
- **Editions / license GUC:** www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions ·
  github.com/timescale/timescaledb/blob/main/src/license_guc.c ·
  github.com/timescale/timescaledb/issues/3718 (default-value doc bug) · www.tigerdata.com/legal/licenses
- **Columnstore / Hypercore:** www.tigerdata.com/docs/api/latest/hypercore/convert_to_columnstore ·
  www.tigerdata.com/docs/api/latest/hypercore/convert_to_rowstore ·
  github.com/timescale/timescaledb/pull/8341 (Hypercore TAM → columnstore heap migration)
- **Upgrades:** www.tigerdata.com/docs/deploy/self-hosted/upgrades/minor-upgrade ·
  www.tigerdata.com/docs/deploy/self-hosted/upgrades/upgrade-pg ·
  github.com/timescaledb-extras (the 2.27.x bloom migration script lives here)
- **Docker tags:** hub.docker.com/r/timescale/timescaledb
- **Install troubleshooting:** github.com/timescale/timescaledb/issues/2984 ("Cannot create extension" — preload/restart)
