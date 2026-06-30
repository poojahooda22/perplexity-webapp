# patterns · Capturing operational transform LINEAGE for stored series, modelled on OpenLineage

> **Product line.** This reference belongs to the **`data-provenance-licensing` dev-skill** of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina**. That line is a *separate*
> product (the DataQuery / Fusion re-engineering, "Project 3"), built on a **new Python / FastAPI /
> data-engineering stack** — not Lumina's Bun + Express + Prisma + Supabase + Upstash stack. Nothing
> here is wired into Lumina's runtime; the two repos only share a filesystem home for the research
> ([`cto-rules.md`](../../../rules/cto-rules.md) §"Scope note"). Greenfield: this reference is theory +
> a build recipe, with no codebase `file:line` to cite yet.
>
> **What this doc is.** The concrete recipe for capturing the **operational transform lineage** of every
> series we store: which fetch+normalize **run** produced which **stored series**, modelled on the
> **OpenLineage** object model (Dataset / Job / Run + facets), with a **custom `license` facet** carrying
> our `commercialOk` verdict — a facet OpenLineage does not ship by default, and the project's
> differentiator on the lineage rail. It is the *run-level, dynamic* half of provenance.
>
> **The sibling doc, and the split.** The `data-normalization-tet` skill already owns the *static,
> per-series* licensing **stamp** — the `Provenance` record, the fetch-path key, the ledger lookup, the
> contamination merge, and the PROV-O / DCAT *serialisation* of the verdict
> ([`patterns-provenance-stamping.md`](../../data-normalization-tet/references/patterns-provenance-stamping.md)).
> **This doc does NOT re-derive any of that.** It assumes a `Provenance` already exists and asks the next
> question: *how do we record the **run** that produced the series — the job definition, the one
> execution, the input feed → output series edge, and the column-level "which inputs fed which output"
> that backs the contamination check?* The stamp says *what a series is licensed for*; the lineage says
> *what process, reading what, produced it, when*. They are built from the same facts and they agree by
> construction.

---

## 0. The thirty-second answer (read this first)

Every time the write-path worker fetches an upstream feed, normalizes it, and persists a series, it
records **one OpenLineage run** describing that execution. The run names:

- a **Job** — the *definition* of the fetch+normalize work (`namespace` + `name`, e.g.
  `tet-write-path` / `ingest.treasury.daily_yields`). The Job is the recipe; it is stable across every
  nightly run.
- a **Run** — *one execution* of that Job, with a UUID `runId` and a `nominalTime` (the schedule slot it
  ran for). Two nights = two Runs of the same Job.
- input **Dataset(s)** — the upstream provider feed (`namespace: upstream`, `name:` the canonical
  fetch path).
- output **Dataset(s)** — the stored series in our warehouse (`namespace: warehouse`, `name:` the
  `instrument_id:fetch_path` series key).

On that output Dataset we hang **facets**: the standard `dataSource` (which upstream), `schema` (the
series columns), `ownership` (who owns the pipeline), `lifecycleStateChange` (was this series **CREATE**d
or **OVERWRITE**n this run), `columnLineage` (which input columns fed which output column), **and a
CUSTOM `license` facet** carrying `commercialOk` + the SPDX id + the canonical fetch path. We emit a
`START` event when the run begins and a `COMPLETE` event when it persists (or a `FAIL` event that writes
no output Dataset, so the catalog never gains a series we couldn't ground).

**Where it runs:** on the **worker/cron WRITE path** (repo non-negotiable #4 — Vercel/serverless can't
hold the sockets/timers a long ingest needs), **never** on the serverless read path. **Where it lands:**
v1 = a lightweight in-DB lineage table (5 columns); when a real multi-stage pipeline exists, the full
OpenLineage events POST to **Marquez** (the reference backend) or any OpenLineage-aware catalog.

The PROV-O correspondence (for the sibling doc's static graph): **Run = `prov:Activity`,
Dataset = `prov:Entity`, Job / owner = `prov:Agent`.** OpenLineage *is* PROV at run-level; the two views
are the same provenance seen statically (PROV-O) and dynamically (OpenLineage).

If that paragraph is all you needed, stop here. The rest is the exact object model, the facet schemas,
the custom-facet authoring rules, the runnable Python emitter, the in-DB v1 table, the Marquez wiring,
and the PROV-O bridge — all cited to the OpenLineage spec at version **`2-0-2`** (Python client
**1.47.1**, 2026-05-12).

---

## 1. Why lineage, separate from the licensing stamp

The licensing stamp ([sibling doc](../../data-normalization-tet/references/patterns-provenance-stamping.md))
answers *"may I display this number, and where did the bytes come from?"* — a **static** property of one
series. Lineage answers a **different**, operational set of questions that the static stamp cannot:

| Question lineage answers | Why the static stamp can't |
|---|---|
| **"Which run produced this series, and when did it last refresh?"** | The stamp has a `fetched_at`, but not a stable *Run* identity you can cross-reference to a job log, a duration, a success/fail state. |
| **"This upstream feed changed / went bad on date X — which of our stored series are downstream of it?"** (impact analysis) | The stamp is per-series and forward-only; it has no *graph* you can traverse upstream→downstream. Lineage's input→output edges are exactly that graph. |
| **"Was this series CREATE'd fresh or OVERWRITTEN over an existing one this run?"** | The stamp records the series, not the *lifecycle transition* of the run that wrote it. `lifecycleStateChange` does. |
| **"Which specific input columns fed this derived output column?"** (and thus: is the derived series contaminated by a RED input?) | The stamp's `transform_lineage` is a flat op-list; it does not say *column A and column B of input X produced column C of output Y*. `columnLineage` does — at field granularity. |
| **"Show me the whole DAG of our pipeline so a new engineer / an auditor / a regulator can see how data flows."** | A per-series stamp is a leaf; the run graph is the tree. Catalogs (Marquez, DataHub, OpenMetadata) render the tree *from* OpenLineage events. |

These are the canonical **data-observability** use-cases — impact analysis, root-cause debugging,
compliance/audit, and column-level traceability — and they are exactly what column-level lineage and a
lineage backend are built to serve: a lineage tool consumes the run events and lets you ask *"what breaks
downstream if I change / drop this input"* and *"what fed this column"*
([DataHub, *Open Source Data Lineage*](https://datahub.com/blog/open-source-data-lineage/); the consumer
side of OpenLineage). The licensing stamp is one **facet** on this graph — the most important one for
*this* product line, but it rides the same rail as schema, ownership, and data-quality metadata.

> **The design rule.** *Don't build a second provenance system.* The licensing stamp and the run lineage
> are **two views of one fact set**, built in the same `transform_data` boundary from the same
> `Provenance` record. The lineage **carries the stamp as a facet**; it never re-derives the verdict.
> (This mirrors the sibling doc's "stamp once, carry forever, never re-derive" rule.)

---

## 2. The OpenLineage object model — Job / Run / Dataset

OpenLineage (Apache-2.0, an LF AI & Data Foundation project) is *"an Open Standard for lineage metadata
collection"* that *"defines a generic model of run, job, and dataset entities"*
([github.com/OpenLineage/OpenLineage](https://github.com/OpenLineage/OpenLineage), fetched 2026-06-24).
The spec is a JSON Schema, current `$id` **`https://openlineage.io/spec/2-0-2/OpenLineage.json`**
([OpenLineage.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json), fetched
2026-06-24). Three core entities, verbatim from the spec object model
([openlineage.io/docs/spec/object-model](https://openlineage.io/docs/spec/object-model/), fetched
2026-06-24):

### 2.1 Job — the *definition* of the work

> **Job:** *"A process that consumes or produces Datasets."* It represents *"a discrete bit of defined
> work"* identified by a unique **`name`** within a **`namespace`** *"(which is assigned to the scheduler
> starting the jobs)"*. Jobs evolve over time and can be a task, model, query, or checkpoint.

For us, a **Job is one fetch+normalize recipe**. It is *stable*: `ingest.treasury.daily_yields` is the
same Job tonight and tomorrow night. The Job carries the *intent*; the Run carries the *occurrence*.

```python
# A Job is identified ONLY by (namespace, name). It is the recipe, not the run.
Job(namespace="tet-write-path", name="ingest.treasury.daily_yields")
```

**Naming discipline (load-bearing).** OpenLineage's whole value depends on *consistent* names — two
producers must name the same logical dataset identically or the graph fragments. Conventions from the
spec: a **Job** name is unique within its scheduler namespace; a **Dataset** name is *"derived from its
physical location (db.host.database.schema.table, for example)"*
([OpenLineage.md](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md)). Our scheme:

| Entity | Namespace | Name | Example |
|---|---|---|---|
| Job | `tet-write-path` | `ingest.<provider>.<logical_series>` | `ingest.sec.companyfacts` |
| Input Dataset (upstream feed) | `upstream` | the **canonical fetch path** (the same key the licensing stamp uses) | `https://data.sec.gov/api/xbrl/companyfacts` |
| Output Dataset (stored series) | `warehouse` | the **series key** `<instrument_id>:<fetch_path>` | `BBG-CT10-GOVT:home.treasury.gov/.../yields` |

Re-using the **canonical fetch path** as the input Dataset name is the keystone: the licensing stamp and
the lineage input node share one identifier, so a query *"all warehouse series downstream of
`query.finance.yahoo.com`"* (i.e. all RED-contaminated series) is a single graph traversal. (The
canonicaliser lives in the sibling doc, §3 of
[`patterns-provenance-stamping.md`](../../data-normalization-tet/references/patterns-provenance-stamping.md);
re-use it verbatim — do not invent a second key.)

### 2.2 Run — *one execution*, with `runId` + `nominalTime`

> **Run:** *"An instance of a Job that represents one of its occurrences in time."* Each run has a unique
> **`runId`** generated as a UUID (**UUIDv7 recommended**). The client maintains the `runId` across
> different state updates within the same run.
> ([openlineage.io/docs/spec/object-model](https://openlineage.io/docs/spec/object-model/).)

The `runId` is the **single thread** stitching a run's `START` and `COMPLETE` events together — generate
it **once** at the top of the ingest and reuse it for every event of that run. **UUIDv7** is recommended
because it is time-ordered, so run ids sort chronologically (handy for "show me the last 10 runs of this
job").

The run's *scheduled* identity is the **`nominalTime` run facet**
([NominalTimeRunFacet.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/facets/NominalTimeRunFacet.json),
fetched 2026-06-24):

> - **`nominalStartTime`** (required, format `date-time`): *"An ISO-8601 timestamp representing the
>   nominal start time (included) of the run. AKA the schedule time."*
> - **`nominalEndTime`** (optional, format `date-time`): *"An ISO-8601 timestamp representing the nominal
>   end time (excluded) of the run. (Should be the nominal start time of the next run)."*

Why `nominalTime` ≠ `eventTime`: **`eventTime`** is *when the event was emitted* (wall clock — could be
00:03:14 because the cron fired and ran 3 minutes late); **`nominalStartTime`** is *the slot the run is
**for*** (00:00:00, the scheduled EOD slot). A backfill re-running last Tuesday's EOD ingest has
*today's* `eventTime` but *last Tuesday's* `nominalStartTime`. Recording both is what lets you answer
"did the 2026-06-23 EOD load ever run?" independently of *when* the bytes were actually pulled. This is
the run-level twin of the stamp's `as_of` vs `fetched_at` distinction (sibling doc §2.1) — same idea, one
level up: **nominal (what it's for) vs actual (when it happened)**.

### 2.3 Dataset — input feed + output stored series

> **Dataset:** *"An abstract representation of data"* that is discrete and uniquely identified by
> **`namespace`** + **`name`** derived from physical location. Can represent tables, objects in buckets,
> or filesystem directories.

A Dataset is identified by `(namespace, name)` and carries **facets**. In a RunEvent, datasets split
into **`inputs`** (`InputDataset`, what the run read) and **`outputs`** (`OutputDataset`, what the run
wrote). For our write path:

- **Input** = the upstream provider feed (one per fetch). Carries a `dataSource` facet (the URI).
- **Output** = the stored warehouse series (one per persisted series). Carries `schema`,
  `lifecycleStateChange`, `columnLineage`, `ownership`, **and our custom `license` facet**.

### 2.4 The three event types

The spec defines **three** event types — and the choice between them is a real design decision, not
boilerplate ([openlineage.io/docs/spec/object-model](https://openlineage.io/docs/spec/object-model/);
[OpenLineage.json $defs](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json)):

| Event | Spec definition | Carries | `run`? | When *we* use it |
|---|---|---|---|---|
| **`RunEvent`** | *"describes the execution of a job, emitted at runtime."* | `run` + `job` + `inputs` + `outputs` | **required** | **The default.** Every ingest emits a `START` + a terminal `RunEvent`. This is where the fetch→series edge + the license facet live. |
| **`JobEvent`** | *"describes metadata about a job, such as its location in source code or declared inputs/outputs. Emitted at design-time and **not associated with a `Run`**."* | `job` (+ optional declared `inputs`/`outputs`) | **excluded** | Optionally, once, to register a job's *declared* shape (its source location, its expected I/O) independent of any run. Nice-to-have; not v1. |
| **`DatasetEvent`** | *"describes metadata changes related to a dataset, such as schema, ownership, or documentation. Emitted at design-time and **not associated with a `job` or `run`**."* | `dataset` only | **excluded** | "Runless" dataset metadata — e.g. publishing a catalog entry's schema/ownership without a run context. Useful for seeding the catalog; not the hot path. |

From the schema: `RunEvent` *"requires run and job"*; `JobEvent` *"requires job (excludes run)"*;
`DatasetEvent` *"requires dataset (excludes job/run)"*
([OpenLineage.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json), fetched
2026-06-24). **For the write path, you almost always want `RunEvent`** — the run identity is the point.
`DatasetEvent`/`JobEvent` are for *design-time* metadata with no execution, which is a later refinement.

### 2.5 The run lifecycle — `eventType`

A `RunEvent`'s **`eventType`** ∈ **`{START, RUNNING, COMPLETE, ABORT, FAIL, OTHER}`**
([OpenLineage.json `eventType` enum](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json),
fetched 2026-06-24). The minimal viable lifecycle for an ingest is a **pair**:

```
START  ──(fetch + normalize + persist)──▶  COMPLETE
                     │
                     └──(provider down / validation fail)──▶  FAIL   (NO output dataset)
```

- **`START`** — emitted when the ingest begins. Names the Job, the Run (`runId` + `nominalTime`), and the
  **input** Dataset(s) it intends to read. Outputs may be empty here (not yet known/written).
- **`COMPLETE`** — emitted *after* the series is persisted. Re-states run + job and adds the **output**
  Dataset(s) with their facets (schema, lifecycle, columnLineage, **license**).
- **`FAIL`** / **`ABORT`** — emitted when the fetch errors, a validation guard trips, or the run is
  cancelled. **Crucially, a `FAIL` writes NO output Dataset** — so the lineage graph never gains a series
  that was never grounded. This is the run-level enforcement of the gate's *"failed fetches return typed
  `unavailable` — never a fabricated value, never a RED-tier backfill to look complete"*
  ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)). The `FAIL` event *is* the audit that
  we **didn't** invent a number.
- **`RUNNING`** — optional progress pings for a long backfill; skip for a fast EOD ingest.

**The events accumulate; they don't overwrite the run.** Per the spec: *"All metadata is additive. For
example, if more inputs or outputs are detected as the job is running, we might send additional events
specifically for those datasets without re-emitting previously observed inputs or outputs"*
([OpenLineage.md](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md), fetched
2026-06-24). So the `START` and `COMPLETE` of one `runId` together describe the whole run; the backend
merges them. (The facet-level merge rule is in §3.4 — it's subtly different and matters.)

---

## 3. Facets — the metadata we hang on the run/dataset

A **facet** is *"an atomic piece of metadata identified by its name"*
([OpenLineage.md](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md)). Facets are
where the *real* content lives; the Run/Job/Dataset skeleton is deliberately thin so facets carry
everything domain-specific. They attach to four points
([openlineage.io/docs/spec/facets](https://openlineage.io/docs/spec/facets/)): **Run facets**, **Job
facets**, **Dataset facets** (on inputs or outputs), plus input-only and output-only specialisations.

### 3.1 The `BaseFacet` contract — `_producer` + `_schemaURL`

**Every** facet — standard or custom — extends `BaseFacet`, which has **two required fields**
([OpenLineage.json `BaseFacet`](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json),
fetched 2026-06-24):

> - **`_producer`** (format: `uri`, required): *"URI identifying the producer of this metadata. For
>   example this could be a git url with a given tag or sha."*
> - **`_schemaURL`** (format: `uri`, required): *"The JSON Pointer (RFC 6901) URL to the corresponding
>   version of the schema definition for this facet."*

The facet-type bases on top of `BaseFacet`: **`RunFacet`** (extends BaseFacet), **`JobFacet`** and
**`DatasetFacet`** (each extends BaseFacet *plus an optional `_deleted: boolean`* tombstone flag),
**`InputDatasetFacet`** and **`OutputDatasetFacet`** (input/output-only metadata)
([OpenLineage.json $defs](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json)).

### 3.2 The standard facets we emit (and why each)

The full standard set, by category
([OpenLineage.md standard-facets list](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md),
fetched 2026-06-24): **Run:** `nominalTime`, `parent`, `errorMessage`. **Job:** `sourceCodeLocation`,
`sourceCode`, `sql`, `ownership`. **Dataset:** `schema`, `dataSource`, `lifecycleStateChange`, `version`,
`columnLineage`, `ownership`. **Input:** `dataQualityMetrics`, `dataQualityAssertions`,
`inputStatistics`. **Output:** `outputStatistics`. The ones load-bearing for *our* write path:

#### `dataSource` (dataset facet) — which upstream

The provider feed identity. Two fields
([data_source facet](https://openlineage.io/docs/spec/facets/dataset-facets/data_source/), fetched
2026-06-24):

```json
{
  "dataSource": {
    "_producer": "https://jpm-reeng.example/tet-write-path",
    "_schemaURL": "https://openlineage.io/spec/facets/1-0-0/DatasourceDatasetFacet.json",
    "name": "U.S. Department of the Treasury",
    "uri": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/.../yields"
  }
}
```

> ⚠️ **Spec quirk:** the facet's spec *page* shows the field as `url`, but the canonical JSON schema and
> the Python client field it as **`uri`**. Pin to **`uri`** (it matches `BaseFacet._schemaURL`'s `uri`
> convention and the client model); treat `url` as a doc typo. Verify against the version you install —
> the field name has been stable as `uri` in the `1-0-x` schema line.

For us, `dataSource.uri` = the canonical fetch path; `dataSource.name` = the human source label. This is
the *standard* home for "which upstream" — but it carries **no licensing verdict**. That's why we need
the custom `license` facet (§4).

#### `schema` (dataset facet) — the series columns

The output series's columns. Each field has `name` (required), `type`, `description`,
`ordinal_position` (1-indexed), and recursive nested `fields` for structs
([SchemaDatasetFacet.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/facets/SchemaDatasetFacet.json),
fetched 2026-06-24):

```json
{
  "schema": {
    "_producer": "https://jpm-reeng.example/tet-write-path",
    "_schemaURL": "https://openlineage.io/spec/facets/1-1-0/SchemaDatasetFacet.json",
    "fields": [
      {"name": "ts",       "type": "timestamptz", "ordinal_position": 1, "description": "observation time (UTC)"},
      {"name": "value",    "type": "double",      "ordinal_position": 2, "description": "yield as a ratio"},
      {"name": "instrument_id", "type": "text",   "ordinal_position": 3}
    ]
  }
}
```

#### `ownership` (dataset / job facet) — who owns the pipeline

An `owners` array of `{name, type}`
([ownership facet](https://openlineage.io/docs/spec/facets/dataset-facets/ownership/), fetched
2026-06-24):

```json
{
  "ownership": {
    "_producer": "https://jpm-reeng.example/tet-write-path",
    "_schemaURL": "https://openlineage.io/spec/facets/1-0-0/OwnershipDatasetFacet.json",
    "owners": [{"name": "data-platform-team", "type": "MAINTAINER"}]
  }
}
```

Ownership is the *operational* "who do I page when this series is wrong"; it maps to PROV-O's `prov:Agent`
(§7) for the responsibility edge.

#### `lifecycleStateChange` (dataset facet) — CREATE vs OVERWRITE

Records what the run *did* to the dataset
([LifecycleStateChangeDatasetFacet.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/facets/LifecycleStateChangeDatasetFacet.json),
fetched 2026-06-24). The `lifecycleStateChange` enum is **`{ALTER, CREATE, DROP, OVERWRITE, RENAME,
TRUNCATE}`** (only this field is required); an optional `previousIdentifier {namespace, name}` records the
old identity on a rename.

```json
{
  "lifecycleStateChange": {
    "_producer": "https://jpm-reeng.example/tet-write-path",
    "_schemaURL": "https://openlineage.io/spec/facets/1-0-0/LifecycleStateChangeDatasetFacet.json",
    "lifecycleStateChange": "OVERWRITE"
  }
}
```

For our write path the rule is simple and important: **`CREATE`** the first time a series key is
persisted; **`OVERWRITE`** every subsequent refresh of the same series (a nightly EOD reload of the same
instrument). This distinction is what lets a consumer answer "was today's run a brand-new series or a
re-pull?" — and it's the lineage signal that a series's *value* may have changed even though its identity
did not (relevant for point-in-time/bitemporal stores: an OVERWRITE that silently restated history is a
data-quality red flag the lineage surfaces).

#### `columnLineage` (dataset facet) — which inputs fed which output → backs contamination

The single most valuable facet for the contamination rule. It maps **each output column** to the **input
columns** that produced it, with transformation metadata
([column_lineage_facet](https://openlineage.io/docs/spec/facets/dataset-facets/column_lineage_facet/),
fetched 2026-06-24). Structure: a `fields` map keyed by output column name; each value has an
`inputFields` array of `{namespace, name, field, transformations[]}`; each transformation has
`{type, subtype, description, masking}`, where `type` ∈ `{DIRECT, INDIRECT}`. There is also an optional
top-level dataset-level `dataset` array for indirect (e.g. filter/sort/groupby) dependencies.

```json
{
  "columnLineage": {
    "_producer": "https://jpm-reeng.example/tet-write-path",
    "_schemaURL": "https://openlineage.io/spec/facets/1-2-0/ColumnLineageDatasetFacet.json",
    "fields": {
      "credit_spread": {
        "inputFields": [
          {
            "namespace": "warehouse",
            "name": "BBG-CT10-GOVT:home.treasury.gov/.../yields",
            "field": "value",
            "transformations": [
              {"type": "DIRECT", "subtype": "ARITHMETIC",
               "description": "spread = corp_yield - treasury_10y", "masking": false}
            ]
          },
          {
            "namespace": "warehouse",
            "name": "CORP-IG-INDEX:query.finance.yahoo.com/.../chart",
            "field": "value",
            "transformations": [
              {"type": "DIRECT", "subtype": "ARITHMETIC",
               "description": "spread = corp_yield - treasury_10y", "masking": false}
            ]
          }
        ]
      }
    }
  }
}
```

**Why this backs the contamination reduce.** The licensing stamp's contamination merge (sibling doc §5)
says a composite inherits its **most-restrictive input's** verdict. `columnLineage` is the *machine-
readable record of which inputs a derived column actually consumed* — so the contamination check is no
longer a hand-maintained list; it is a **graph reduce over the `inputFields` of the output column**: for
output column `C`, gather every `(namespace, name)` in `C.inputFields`, look up each input series's
license verdict, and the composite verdict = `max(restrictiveness)`. In the example above,
`credit_spread` consumed a GREEN Treasury series **and** a RED Yahoo series → the reduce yields **RED**,
exactly the sibling doc's worked example `merge([treasury_GREEN, yahoo_RED]) -> False`. The lineage
*proves* the input set the contamination rule operates on, so a `/sources-lint`-style audit can be run
**from the lineage graph** rather than from code grep — a stronger guarantee. (This is the lineage's
unique contribution: the stamp *asserts* the verdict; the columnLineage *evidences the inputs* behind it.)

#### `dataQualityMetrics` / `dataQualityAssertions` (input facets) — optional

Row counts, null fractions, and pass/fail assertions on the input. Worth emitting once the validation
layer exists (the `data-normalization-tet` data-quality recipe produces exactly these numbers); they let
the catalog show "this run read 252 rows, 0 nulls, all 4 assertions passed." Not v1-critical.

### 3.3 The CUSTOM `license` facet — the project differentiator

OpenLineage ships `dataSource` (which upstream) but **no facet for a commercial-display licensing
verdict**. That verdict is *the* differentiator of this product line (sibling doc §0). So we author a
**custom dataset facet**. The rules for a legal custom facet
([custom-facets](https://openlineage.io/docs/spec/facets/custom-facets/);
[OpenLineage.md](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md), fetched
2026-06-24):

1. **Naming:** the schema type is **`{prefix}{name}{entity}Facet`** in PascalCase, where the **prefix is a
   distinct project identifier** to avoid collision with standard facets (e.g. Airflow uses `airflow_`,
   BigQuery uses `BigQuery…`). When **attached to an entity**, the key is **`{prefix}_{name}`** in
   camelCase. Example from the spec: schema `BigQueryStatisticsJobFacet` → key `bigQuery_statistics`.
   Ours: schema **`JpmReengCommercialLicenseDatasetFacet`** → key **`jpmReeng_commercialLicense`**.
2. **Must extend `BaseFacet`** so `_producer` + `_schemaURL` are present (the two mandatory fields).
3. **`_schemaURL` must be an immutable canonical pointer** — *"a tag of a git sha and **not** a branch
   name"*, *"only one URL used for a given version of a schema"* — pointing at the facet's JSON-Schema
   `$ref` location.
4. **No registration required.** Custom facets are *ad-hoc*: *"As long as they conform to `BaseFacet`
   structure with proper metadata, backends will accept and store them alongside standard facets"*
   ([custom-facets](https://openlineage.io/docs/spec/facets/custom-facets/)). Marquez/DataHub will store
   and surface an unknown facet by name without a schema upload.

The facet payload (one per output series; built from the same `Provenance` the stamp uses):

```json
{
  "jpmReeng_commercialLicense": {
    "_producer": "https://github.com/jpm-reeng/data-plane/tree/<git-sha>",
    "_schemaURL": "https://github.com/jpm-reeng/data-plane/blob/<git-sha>/spec/facets/CommercialLicenseDatasetFacet.json#/$defs/JpmReengCommercialLicenseDatasetFacet",
    "fetchPath": "https://home.treasury.gov/.../yields",
    "commercialOk": true,
    "verdict": "GREEN",
    "spdxId": "CC0-1.0",
    "licenseBasis": "17 USC §105 — U.S. government public domain",
    "attribution": null,
    "sourceLabel": "U.S. Department of the Treasury"
  }
}
```

Field notes:

- **`commercialOk`** — the boolean from the sibling doc's ledger lookup. **Carried, never re-derived** by
  the lineage layer.
- **`spdxId`** — the SPDX licence identifier ([spdx.org/licenses](https://spdx.org/licenses/)) where one
  applies: `CC0-1.0` for public-domain dedications, `CC-BY-4.0` for World Bank/OECD/IMF, or a
  proprietary marker (`LicenseRef-Yahoo-ToS`, `LicenseRef-TwelveData-Free`) for RED vendor tiers that
  have no SPDX id. SPDX gives the verdict a *standard, machine-comparable* licence token on top of our
  GREEN/RED boolean — useful when a downstream SPDX-aware tool consumes the catalog.
- **`attribution`** — the required credit string for CC-BY/GDELT GREENs; `null` for bare public domain.
  Propagated so the render layer's contractual obligation rides the lineage.
- **`verdict`** — the raw `GREEN/YELLOW/RED/REJECT/MISS` (sibling doc's `LedgerVerdict`), kept distinct
  from the boolean so a `MISS` is visible on the graph.

The custom-facet JSON Schema we host (the target of `_schemaURL`), extending the spec's `DatasetFacet`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/jpm-reeng/data-plane/blob/<git-sha>/spec/facets/CommercialLicenseDatasetFacet.json",
  "$defs": {
    "JpmReengCommercialLicenseDatasetFacet": {
      "allOf": [
        {"$ref": "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/DatasetFacet"},
        {
          "type": "object",
          "properties": {
            "fetchPath":    {"type": "string", "format": "uri"},
            "commercialOk": {"type": "boolean", "default": false},
            "verdict":      {"type": "string", "enum": ["GREEN","YELLOW","RED","REJECT","MISS"]},
            "spdxId":       {"type": "string"},
            "licenseBasis": {"type": "string"},
            "attribution":  {"type": ["string","null"]},
            "sourceLabel":  {"type": "string"}
          },
          "required": ["fetchPath", "commercialOk", "verdict"]
        }
      ]
    }
  }
}
```

The `allOf` + `$ref` to the spec's `DatasetFacet` def is the canonical extension pattern: our facet **is**
a `DatasetFacet` (so `_producer`/`_schemaURL` are inherited and required) *plus* our properties. This is
exactly how every standard facet (lifecycleStateChange, schema, …) is defined against
`#/$defs/DatasetFacet` in the spec — we follow the same shape so an OpenLineage-aware backend validates
ours identically.

### 3.4 Facet merge semantics — the one rule that bites

A facet is *"atomic … identified by its name"*, and — critically — *"emitting a new facet with the same
name for the same entity replaces the previous facet instance for that entity entirely"*
([OpenLineage.md](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md), fetched
2026-06-24). This is **whole-facet replace, last-write-wins** — *not* a deep merge. The consequence for
our START/COMPLETE pair:

- **Datasets accumulate across events** (additive — new inputs/outputs join the run), **but a facet
  re-emitted under the same name on the same dataset overwrites the prior one wholesale.** So if you put a
  partial `license` facet on the output at `START` and a complete one at `COMPLETE`, the `COMPLETE` one
  *replaces* it — fine. But if you split *fields of one facet* across two events expecting them to merge,
  you lose the earlier fields. **Rule: emit each facet complete, in one event.** For us that's trivial —
  output-dataset facets (schema, lifecycle, columnLineage, license) are only known at `COMPLETE`, so they
  go on the `COMPLETE` event whole; the `START` event carries only run-level facets (nominalTime) and the
  input dataset.

---

## 4. The runnable emitter (Python, `openlineage-python` 1.47.1)

The Python client (`openlineage-python`, current **1.47.1**, 2026-05-12 —
[pypi.org/project/openlineage-python](https://pypi.org/project/openlineage-python/)) gives typed
`RunEvent`/`Run`/`Job`/`InputDataset`/`OutputDataset` and a `Transport` abstraction. Install:

```bash
uv add openlineage-python    # the line is on the new Python/uv stack (NOT Lumina's bun)
```

### 4.1 The custom facet as a typed class

A custom facet subclasses the client `BaseFacet` so `_producer`/`_schemaURL` are populated, overriding
`_get_schema()` to point at our hosted schema
([custom-facets](https://openlineage.io/docs/spec/facets/custom-facets/) — *"To create a custom facet, it
should inherit from `BaseFacet` for the `_producer` and `_schemaURL` to be automatically added"*; the
`_get_schema()` override pattern is the documented mechanism):

```python
# app/lineage/facets.py
from __future__ import annotations

import attr
from openlineage.client.facet_v2 import DatasetFacet  # base for dataset-attached facets

_GIT_SHA = "a1b9c0d"  # the immutable build sha; _schemaURL MUST be a sha, never a branch
_SCHEMA = (
    f"https://github.com/jpm-reeng/data-plane/blob/{_GIT_SHA}"
    "/spec/facets/CommercialLicenseDatasetFacet.json"
    "#/$defs/JpmReengCommercialLicenseDatasetFacet"
)


@attr.define
class CommercialLicenseDatasetFacet(DatasetFacet):
    """Custom OpenLineage dataset facet carrying our commercialOk verdict.

    Attached under the key `jpmReeng_commercialLicense`. Built from the SAME
    Provenance the licensing stamp uses — the verdict is CARRIED, never re-derived here.
    """
    fetchPath: str = attr.field()
    commercialOk: bool = attr.field(default=False)   # DEFAULT FALSE — silence is not a license
    verdict: str = attr.field(default="MISS")         # GREEN/YELLOW/RED/REJECT/MISS
    spdxId: str | None = attr.field(default=None)
    licenseBasis: str = attr.field(default="")
    attribution: str | None = attr.field(default=None)
    sourceLabel: str = attr.field(default="")

    @staticmethod
    def _get_schema() -> str:
        # overriding the default (BaseFacet) schema URL with our immutable, sha-pinned pointer
        return _SCHEMA
```

The attached **key** must be `jpmReeng_commercialLicense` (the `{prefix}_{name}` camelCase form). The
client serialises an `attr`-defined `BaseFacet` subclass with `_producer`/`_schemaURL` injected
automatically; we only override `_get_schema()`.

### 4.2 Building the facets from the `Provenance` stamp

```python
# app/lineage/build.py
from openlineage.client.facet_v2 import (
    data_source_dataset, lifecycle_state_change_dataset, schema_dataset, ownership_dataset,
    column_lineage_dataset, nominal_time_run,
)
from openlineage.client.facet_v2.column_lineage_dataset import Fields, InputField, Transformation

from app.provenance.models import Provenance     # the SAME record the stamp builds (sibling skill)
from app.lineage.facets import CommercialLicenseDatasetFacet

_PRODUCER = "https://github.com/jpm-reeng/data-plane/tree/a1b9c0d"  # producer = our build URI


def license_facet(p: Provenance) -> CommercialLicenseDatasetFacet:
    """Carry the stamp's verdict onto the lineage — no re-derivation."""
    return CommercialLicenseDatasetFacet(
        fetchPath=p.fetch_path,
        commercialOk=p.commercial_ok,
        verdict=p.ledger_verdict.value,
        spdxId=_SPDX.get(p.ledger_verdict.name and p.fetch_path),  # see §3.3 SPDX mapping
        licenseBasis=p.license_basis,
        attribution=p.attribution,
        sourceLabel=p.source_label,
    )


def output_facets(p: Provenance, *, is_first_load: bool, columns: list[tuple[str, str]]) -> dict:
    """All standard + custom facets for the persisted OUTPUT series dataset."""
    return {
        "dataSource": data_source_dataset.DatasourceDatasetFacet(
            name=p.source_label, uri=p.fetch_path),
        "schema": schema_dataset.SchemaDatasetFacet(
            fields=[schema_dataset.SchemaDatasetFacetFields(name=n, type=t, ordinal_position=i + 1)
                    for i, (n, t) in enumerate(columns)]),
        "lifecycleStateChange": lifecycle_state_change_dataset.LifecycleStateChangeDatasetFacet(
            lifecycleStateChange="CREATE" if is_first_load else "OVERWRITE"),
        "ownership": ownership_dataset.OwnershipDatasetFacet(
            owners=[ownership_dataset.Owner(name="data-platform-team", type="MAINTAINER")]),
        "jpmReeng_commercialLicense": license_facet(p),   # the custom key
    }


def derived_column_lineage(output_col: str,
                           inputs: list[tuple[str, str, str]],  # (ns, name, field)
                           op_desc: str) -> dict:
    """columnLineage for a DERIVED series — this is the evidence the contamination reduce runs over."""
    return {
        "columnLineage": column_lineage_dataset.ColumnLineageDatasetFacet(
            fields={
                output_col: Fields(inputFields=[
                    InputField(namespace=ns, name=nm, field=fl,
                               transformations=[Transformation(
                                   type="DIRECT", subtype="ARITHMETIC",
                                   description=op_desc, masking=False)])
                    for (ns, nm, fl) in inputs
                ])
            })
    }
```

### 4.3 Emitting START → COMPLETE (and FAIL) around an ingest

```python
# app/lineage/emit.py
from datetime import datetime, timezone
from uuid import UUID

from openlineage.client import OpenLineageClient
from openlineage.client.event_v2 import (
    RunEvent, RunState, Run, Job, InputDataset, OutputDataset,
)
from openlineage.client.facet_v2 import nominal_time_run

from app.provenance.models import Provenance
from app.lineage.build import output_facets

_PRODUCER = "https://github.com/jpm-reeng/data-plane/tree/a1b9c0d"
_JOB_NS = "tet-write-path"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def emit_start(client: OpenLineageClient, *, job_name: str, run_id: UUID,
               nominal_start: datetime, input_fetch_path: str, source_label: str) -> None:
    client.emit(RunEvent(
        eventType=RunState.START,
        eventTime=_now(),
        run=Run(runId=str(run_id), facets={
            "nominalTime": nominal_time_run.NominalTimeRunFacet(
                nominalStartTime=nominal_start.isoformat())}),
        job=Job(namespace=_JOB_NS, name=job_name),
        producer=_PRODUCER,
        inputs=[InputDataset(namespace="upstream", name=input_fetch_path)],
        outputs=[],                       # outputs unknown until COMPLETE
    ))


def emit_complete(client: OpenLineageClient, *, job_name: str, run_id: UUID,
                  p: Provenance, series_key: str, is_first_load: bool,
                  columns: list[tuple[str, str]]) -> None:
    client.emit(RunEvent(
        eventType=RunState.COMPLETE,
        eventTime=_now(),
        run=Run(runId=str(run_id), facets={}),    # same runId stitches it to START
        job=Job(namespace=_JOB_NS, name=job_name),
        producer=_PRODUCER,
        inputs=[InputDataset(namespace="upstream", name=p.fetch_path)],
        outputs=[OutputDataset(
            namespace="warehouse",
            name=series_key,
            facets=output_facets(p, is_first_load=is_first_load, columns=columns))],
    ))


def emit_fail(client: OpenLineageClient, *, job_name: str, run_id: UUID,
              input_fetch_path: str, error: str) -> None:
    """A FAIL writes NO output dataset — the catalog never gains an ungrounded series."""
    from openlineage.client.facet_v2 import error_message_run
    client.emit(RunEvent(
        eventType=RunState.FAIL,
        eventTime=_now(),
        run=Run(runId=str(run_id), facets={
            "errorMessage": error_message_run.ErrorMessageRunFacet(
                message=error, programmingLanguage="python")}),
        job=Job(namespace=_JOB_NS, name=job_name),
        producer=_PRODUCER,
        inputs=[InputDataset(namespace="upstream", name=input_fetch_path)],
        outputs=[],                       # <-- the whole point: no output on failure
    ))
```

### 4.4 The ingest, wired together (worker/cron path)

```python
# worker/ingest/treasury_yields.py
import uuid
from datetime import datetime, timezone

from openlineage.client import OpenLineageClient

from app.lineage.emit import emit_start, emit_complete, emit_fail
from app.providers.treasury.yields import TreasuryYieldFetcher   # the TET fetcher (sibling skill)
from app.store.timescale import upsert_series, series_exists      # the warehouse (timescaledb skill)

OL = OpenLineageClient()   # transport from OPENLINEAGE_* env / openlineage.yml (§5)
JOB = "ingest.treasury.daily_yields"


async def run_ingest(nominal_start: datetime) -> None:
    run_id = uuid.uuid7() if hasattr(uuid, "uuid7") else uuid.uuid4()  # UUIDv7 recommended
    fetch_path = "https://home.treasury.gov/.../yields"
    emit_start(OL, job_name=JOB, run_id=run_id,
               nominal_start=nominal_start, input_fetch_path=fetch_path,
               source_label="U.S. Department of the Treasury")
    try:
        batch = await TreasuryYieldFetcher.run(run_id=run_id)     # fetch+normalize+stamp (sibling)
        series_key = f"{batch.provenance.instrument_id}:{batch.provenance.fetch_path}"
        first = not await series_exists(series_key)
        await upsert_series(series_key, batch.series)              # persist to the warehouse
        emit_complete(OL, job_name=JOB, run_id=run_id, p=batch.provenance,
                      series_key=series_key, is_first_load=first,
                      columns=[("ts", "timestamptz"), ("value", "double"),
                               ("instrument_id", "text")])
    except Exception as exc:                                       # provider down / validation fail
        emit_fail(OL, job_name=JOB, run_id=run_id,
                  input_fetch_path=fetch_path, error=repr(exc))
        raise   # re-raise: the cron logs it; the catalog already recorded a FAIL run with no output
```

Three things this wiring gets right, by construction:

1. **One `runId` per ingest**, generated once, reused for START/COMPLETE/FAIL — the run is one thread.
2. **The stamp and the lineage share `batch.provenance`** — the license facet *carries* the verdict; it
   is never re-computed on the lineage side. If they could disagree, they'd be two sources of truth; they
   can't, because there is one.
3. **The `FAIL` path persists nothing and emits no output Dataset** — the lineage is the audit trail that
   a failed fetch produced *no* series, honouring "never invent a finance number / never backfill to look
   complete" at the run level.

> **Non-negotiable #4, restated for lineage.** This emitter runs **only** on the worker/cron write path.
> The OpenLineage HTTP transport opens a socket to Marquez and the ingest holds a long-lived fetch — both
> are forbidden on Vercel/serverless (no persistent sockets, no long timers). The read API never emits
> lineage; it only *reads* the already-recorded provenance row (§6) to gate display. Emitting lineage
> from a serverless read handler is an architecture bug, not a feature.

---

## 5. Where lineage lands — Marquez vs a v1 in-DB table (tier discipline)

This is the R-SCALE call for the lineage layer: **don't stand up a lineage backend before there's a
pipeline worth tracing.**

### 5.1 v1 — a 5-field provenance/lineage row in the warehouse

At v1 there is **one** transform per series: *fetch upstream → normalize → persist*. A single linear
edge. Standing up Marquez (a Postgres-backed Java service + UI + its own ops) to render a one-hop graph is
Tier-3 machinery on a Tier-1 problem. The right v1 record is a **5-column row** co-located in the
warehouse Postgres — it captures everything a single-stage pipeline's lineage needs, and it's the table
the read API already joins for the licensing gate (so lineage costs *zero* extra infra at v1):

```sql
-- v1 lineage: one row per (series, run). Co-located with series_provenance (sibling doc §6.4).
CREATE TABLE series_lineage (
  run_id        uuid        NOT NULL,                 -- the OpenLineage runId (UUIDv7)
  series_key    text        NOT NULL,                 -- output dataset name (instrument_id:fetch_path)
  input_path    text        NOT NULL,                 -- input dataset name (canonical fetch path)
  nominal_time  timestamptz NOT NULL,                 -- the scheduled slot (nominalStartTime)
  event_type    text        NOT NULL                  -- COMPLETE | FAIL  (lifecycle terminal state)
    CHECK (event_type IN ('COMPLETE', 'FAIL', 'ABORT')),
  PRIMARY KEY (run_id, series_key)
);
CREATE INDEX series_lineage_by_input  ON series_lineage (input_path);   -- impact-analysis traversal
CREATE INDEX series_lineage_by_series ON series_lineage (series_key);   -- "how was this built"
```

The five fields are deliberately the OpenLineage primitives, not a bespoke schema: `run_id` (Run),
`series_key` (output Dataset), `input_path` (input Dataset), `nominal_time` (nominalTime facet),
`event_type` (lifecycle). This is *forward-compatible*: when you graduate to full events, every column
maps to a field you already emit, so the migration is mechanical (build a RunEvent from a row), never a
re-model. The two indexes give the two queries that matter even at v1: *"every series downstream of input
X"* (impact analysis on a bad/changed feed) and *"how was series Y built"* (root-cause).

> **The trap this avoids:** *building OpenLineage events + Marquez before there's a multi-stage pipeline*
> is senior-vocabulary cargo-culting — full lineage infra dressing up a linear ETL. State the tier:
> **v1 lineage survives a single-stage write path; it breaks (loses fidelity) the moment you have a
> multi-stage DAG** — series-built-from-series, fan-in composites, re-derivations — because a flat row
> can't express column-level fan-in. *That* is the trigger to emit full events.

### 5.2 v2 — full OpenLineage events when a real DAG exists

The moment a series is **derived from other stored series** (a credit spread from a Treasury series and a
corporate-index series; a rolled futures continuous series; any composite), the lineage is no longer
linear and the flat row can't express *which inputs fed which output column*. Now you emit full
`RunEvent`s with `columnLineage`, and you need a backend that stores and traverses the DAG.

**Marquez** is the reference backend — *"the reference implementation of the OpenLineage API"*, an LF AI &
Data project to *"collect, aggregate, and visualize a data ecosystem's metadata"*
([github.com/MarquezProject/marquez](https://github.com/MarquezProject/marquez);
[marquezproject.ai](https://marquezproject.ai/), fetched 2026-06-24). It exposes the OpenLineage ingestion
endpoint **`POST /api/v1/lineage`** which *"Receive[s], process[es], and store[s] lineage metadata using
the OpenLineage standard"*
([Record a single lineage event](https://marquezproject.ai/docs/api/record-lineage/), fetched 2026-06-24);
the API listens on **port 5000** (admin on 5001). Its `OpenLineageResource.create()` handler accepts a
`BaseEvent` (LineageEvent / DatasetEvent / JobEvent), processes it async, and returns **201** on success
(400 on `IllegalArgumentException`, 500 otherwise)
([OpenLineageResource.java](https://github.com/MarquezProject/marquez/blob/main/api/src/main/java/marquez/api/OpenLineageResource.java),
fetched 2026-06-24). Marquez decomposes the events into a queryable model of **namespaces, jobs, runs,
datasets, and dataset versions**, and renders the DAG in its UI.

Point the Python client's HTTP transport at Marquez (config via env or `openlineage.yml`):

```python
# app/lineage/client.py
from openlineage.client import OpenLineageClient
from openlineage.client.transport.http import HttpConfig, HttpTransport, HttpCompression

def make_client(marquez_url: str = "http://marquez:5000") -> OpenLineageClient:
    return OpenLineageClient(transport=HttpTransport(HttpConfig(
        url=marquez_url,
        endpoint="api/v1/lineage",
        timeout=5,
        compression=HttpCompression.GZIP,
    )))
```

```yaml
# openlineage.yml — the client auto-loads this; no code change to switch backends
transport:
  type: http
  url: http://marquez:5000
  endpoint: api/v1/lineage
  compression: gzip
```

(Transport/config shape per the
[OpenLineage Python client docs](https://openlineage.io/docs/client/python/) — `HttpConfig` /
`HttpTransport` / `OpenLineageClient.emit()`.) The same events, unchanged, also feed **DataHub** or
**OpenMetadata** (both consume OpenLineage natively) — which is the payoff of emitting the standard rather
than a bespoke format: the license facet rides into *any* OpenLineage-aware catalog with **zero bespoke
integration** ([DataHub OpenLineage](https://datahub.com/blog/open-source-data-lineage/)).

### 5.3 Tier table — what survives what

| Tier | Lineage substrate | Survives | Breaks at |
|---|---|---|---|
| **1× (demo / v1)** | `series_lineage` 5-field row in warehouse Postgres | single-stage fetch→normalize→persist; impact-analysis + root-cause by index scan | first multi-stage DAG (series-from-series) — no column-level fan-in |
| **100× (traction)** | full `RunEvent`s → **Marquez** (Postgres-backed) | multi-stage DAGs, column lineage, the UI graph, thousands of jobs | very high event volume (Marquez's sync ingest can lag) |
| **10,000× (product)** | events → a **Kafka/queue** → Marquez/DataHub async consumers; lineage off the ingest hot path | spike-day ingest fan-out; lineage emission never blocks the persist | — (this is the production shape) |

The discipline: **start at the 5-field row, graduate to events+Marquez when the DAG forces it, decouple
emission via a queue when ingest volume forces it.** Each step is triggered by a *named* break, not by
ceremony.

---

## 6. How the read path uses lineage (without emitting it)

The serverless read API **never emits** lineage — but it **reads** the recorded provenance to gate
display, and (for derived series) re-runs the contamination reduce **over the lineage graph**:

```sql
-- A derived series's display gate: is ANY upstream input non-GREEN?
-- (This is the contamination reduce, run from lineage rather than from a code list.)
WITH RECURSIVE upstream(series_key) AS (
    SELECT series_key FROM series_lineage WHERE series_key = $1          -- the requested series
  UNION
    SELECT l.input_path                                                  -- walk input edges up
    FROM series_lineage l JOIN upstream u ON l.series_key = u.series_key
)
SELECT bool_and(p.commercial_ok) AS composite_commercial_ok             -- ALL GREEN -> displayable
FROM upstream u
JOIN series_provenance p ON p.series_id = u.series_key;
```

`bool_and(commercial_ok)` is the SQL form of *"most-restrictive wins"*: the composite is displayable
**only if every** upstream series is GREEN — one RED anywhere up the graph and the `AND` is false. This is
the same verdict the sibling doc's `merge_provenance` computes in Python, but driven by the **lineage
graph** (the recorded input edges) rather than a hand-passed input list — so it's *self-maintaining*: add
a new input to a derived series, record the edge, and the gate automatically accounts for it. The read
path does a graph read; it writes nothing and emits no lineage (non-negotiable #4 honoured).

---

## 7. The PROV-O ↔ OpenLineage correspondence

The project's theory mandates **W3C PROV-O for the provenance *model*** (the static graph) and
**OpenLineage for *run-level* lineage** (the dynamic pipeline)
([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
Tier-2: *"Provenance = W3C PROV-O … the domain-agnostic model … Operational lineage = OpenLineage …
datasets/jobs/runs"*). These are **not two competing systems** — they are the **same provenance seen at
two altitudes**, and they map onto each other cleanly. PROV-O's three core classes
([W3C PROV-O](https://www.w3.org/TR/prov-o/), a 2013 W3C Recommendation, namespace
`http://www.w3.org/ns/prov#`): **`prov:Entity`** (*"a … thing with some fixed aspects"*),
**`prov:Activity`** (*"something that occurs over a period of time and acts upon or with entities …
generating entities"*), **`prov:Agent`** (*"something that bears … responsibility for an activity … or
for the existence of an entity"*). The correspondence:

| OpenLineage | ⇄ | PROV-O | Why the mapping holds |
|---|---|---|---|
| **Run** (one execution of a job) | **`prov:Activity`** | a Run *is* "something that occurs over a period of time and generates entities" — it consumes inputs and produces outputs over an interval |
| **Dataset** (input feed / output series) | **`prov:Entity`** | a Dataset *is* "a thing with fixed aspects" — the bytes produced/consumed |
| **Job** + **owner** (the recipe + responsible team) | **`prov:Agent`** | the Job/owner "bears responsibility for the activity"; the provider is also an Agent (responsible for the input Entity's existence) |
| `RunEvent` output edge (Run → output Dataset) | **`prov:wasGeneratedBy`** | the series "was generated by" the run |
| `RunEvent` input edge (Run → input Dataset) | **`prov:used`** | the run "used" the upstream feed |
| `dataSource` / `ownership` facet → provider/team | **`prov:wasAttributedTo`** / **`prov:wasAssociatedWith`** | the series "was attributed to" the provider Agent; the run "was associated with" the owner Agent |
| `columnLineage` input→output edge (composite) | **`prov:wasDerivedFrom`** | the derived series "was derived from" its inputs — the contamination edge, in PROV terms |
| `nominalTime` / `eventTime` | **`prov:startedAtTime`** / **`prov:endedAtTime`** / **`prov:generatedAtTime`** | the activity's temporal bounds and the entity's generation moment |

So: **emit OpenLineage at runtime on the write path; the same facts serialise to a PROV-O graph for the
catalog's static view** (the sibling doc §6.1 builds exactly that PROV-O JSON-LD from the `Provenance`
record). One fact set, two serialisations, agreeing by construction because both are built from the same
`Provenance` at the same `transform_data` boundary. The OpenLineage events are the *event log*; the PROV-O
graph is the *materialised view* of that log. (`commercialOk` is native to **neither** standard — it is
our domain extension: a custom *facet* in OpenLineage, a custom *property* (`lic:commercialOk`) in PROV-O.
Both carry the *same* value from the *same* stamp.)

---

## 8. Anti-patterns — the lineage-specific traps to hunt

| Mistake | Why it breaks | Fix |
|---|---|---|
| **Building Marquez + full events for a single-stage v1 pipeline** | Tier-3 infra on a Tier-1 graph; weeks of ops for a one-hop edge a 5-field row covers | Start with `series_lineage` (§5.1); graduate to events+Marquez when a real DAG (series-from-series) exists |
| **Re-deriving `commercialOk` on the lineage side** | two sources of truth for the verdict → they drift → one says GREEN, one says RED | the license facet **carries** `Provenance.commercial_ok`; never recompute it in the emitter |
| **A new `runId` per event** (one for START, another for COMPLETE) | the backend can't stitch the run; you get two orphan half-runs | generate the `runId` **once** at ingest top, reuse for every event of the run (the client maintains it across state updates) |
| **Emitting an output Dataset on a `FAIL`/`ABORT`** | the catalog gains a series the run never grounded — the exact "look complete" failure | `FAIL` carries **no** outputs; only `COMPLETE` does |
| **Splitting one facet's fields across START and COMPLETE expecting a merge** | facets are whole-replace, last-write-wins — the earlier fields are lost | emit each facet **complete in one event** (output facets only at COMPLETE) |
| **A `_schemaURL` pointing at a branch** (`/main/…`) | the spec requires an *immutable* sha pointer; a branch URL changes meaning silently | pin `_schemaURL` to a **git sha**, one canonical URL per schema version |
| **Inventing a second fetch-path key for the input Dataset name** | the lineage input node no longer joins to the licensing stamp's key → impact-analysis-by-source breaks | re-use the sibling doc's `canonical_fetch_path()` verbatim as the input Dataset `name` |
| **Putting `commercialOk` only in `dataSource`** (or skipping the custom facet) | `dataSource` has no licensing field; the verdict vanishes from the lineage rail | author the custom `jpmReeng_commercialLicense` facet (§3.3) — it's the differentiator |
| **Emitting lineage from the serverless read handler** | needs a socket to Marquez + holds the request open — forbidden on Vercel; and the read path produces no new provenance | emit **only** on the worker/cron write path; the read path *reads* the recorded row (§6) |
| **Naming a custom facet without a project prefix** | collides with a standard/other facet; the backend may mis-merge it | use `{prefix}{name}{entity}Facet` / key `{prefix}_{name}` (`jpmReeng_…`) |
| **`OVERWRITE` recorded as `CREATE` on every refresh** | the catalog can't tell a fresh series from a re-pull; silent restatements of history hide | `CREATE` only on first load (`series_exists` false), `OVERWRITE` thereafter |

---

## 9. Decision checklist (use before locking any lineage code)

1. **Is lineage emitted ONLY on the worker/cron write path** — never from a serverless read handler
   (non-negotiable #4)?
2. **Is the `runId` generated once per ingest (UUIDv7) and reused** across START / COMPLETE / FAIL?
3. **Does the input Dataset `name` re-use the licensing stamp's `canonical_fetch_path()` key** (so the
   lineage and the stamp share one identifier)?
4. **Does the output series carry all the load-bearing facets** — `dataSource`, `schema`,
   `lifecycleStateChange` (CREATE vs OVERWRITE), `ownership`, `columnLineage` (for derived), and the
   custom **`jpmReeng_commercialLicense`** facet?
5. **Is `commercialOk` CARRIED from the `Provenance` stamp into the license facet** — never re-derived on
   the lineage side?
6. **Does `FAIL`/`ABORT` write NO output Dataset** (so the catalog never gains an ungrounded series)?
7. **Is each facet emitted complete in one event** (output facets at COMPLETE), given whole-replace merge?
8. **Is `_schemaURL` an immutable git-sha pointer**, one canonical URL per schema version?
9. **For a derived series, does `columnLineage` record every input** the contamination reduce must see
   (so the read-time `bool_and(commercial_ok)` gate is driven by the real input set)?
10. **Is the substrate right for the tier** — 5-field row at v1, full events + Marquez at a real DAG, a
    queue in front of the backend at spike volume?

If every box is checked, the lineage faithfully records the run that produced each series, carries the
licensing verdict on the standard rail, evidences the inputs the contamination rule reduces over, and
adds no infra the current pipeline tier doesn't earn.

---

## Sources

- [OpenLineage object model](https://openlineage.io/docs/spec/object-model/) — Job (*"a process that
  consumes or produces Datasets"*), Run (*"an instance of a Job … one of its occurrences in time"*,
  `runId` UUIDv7), Dataset (*"an abstract representation of data"*), the three event types
  (RunEvent/JobEvent/DatasetEvent), additive/cumulative metadata (fetched 2026-06-24).
- [OpenLineage.json spec, `$id` `2-0-2`](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json) —
  `BaseFacet` (`_producer`/`_schemaURL` required, both `format: uri`), `eventType` enum
  `{START,RUNNING,COMPLETE,ABORT,FAIL,OTHER}`, RunEvent requires run+job, JobEvent excludes run,
  DatasetEvent requires only dataset, the Run/Job/Dataset/Input/Output facet base defs, `_deleted`
  tombstone (fetched 2026-06-24).
- [OpenLineage.md spec prose](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md) —
  facet atomicity + *"emitting a new facet with the same name … replaces the previous facet … entirely"*,
  *"all metadata is additive"*, custom-facet naming `{prefix}{name}{entity}Facet` / key `{prefix}_{name}`
  (`BigQueryStatisticsJobFacet` → `bigQuery_statistics`), the standard-facets list by category (fetched
  2026-06-24).
- [Custom Facets guide](https://openlineage.io/docs/spec/facets/custom-facets/) — prefix collision-
  avoidance, BaseFacet inheritance, `_get_schema()` override, `_schemaURL` must be an immutable git-sha
  `$ref` pointer (one canonical URL per version), no formal registration required (fetched 2026-06-24).
- [Facets overview](https://openlineage.io/docs/spec/facets/) — facets attach to Run / Job / Dataset
  (input or output) (fetched 2026-06-24).
- [ColumnLineageDatasetFacet](https://openlineage.io/docs/spec/facets/dataset-facets/column_lineage_facet/) —
  `fields` map → `inputFields[{namespace,name,field,transformations[{type DIRECT/INDIRECT, subtype,
  description, masking}]}]`, dataset-level indirect array (fetched 2026-06-24).
- [LifecycleStateChangeDatasetFacet.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/facets/LifecycleStateChangeDatasetFacet.json) —
  enum `{ALTER,CREATE,DROP,OVERWRITE,RENAME,TRUNCATE}` (only field required), optional
  `previousIdentifier{namespace,name}`, extends `#/$defs/DatasetFacet` (fetched 2026-06-24).
- [DatasourceDatasetFacet](https://openlineage.io/docs/spec/facets/dataset-facets/data_source/) — `name`
  + `uri` (the page shows `url`; canonical schema/client use `uri`) (fetched 2026-06-24).
- [OwnershipDatasetFacet](https://openlineage.io/docs/spec/facets/dataset-facets/ownership/) — `owners[]`
  of `{name,type}` (fetched 2026-06-24).
- [SchemaDatasetFacet.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/facets/SchemaDatasetFacet.json) —
  `fields[]` of `{name (req), type, description, ordinal_position (1-indexed), fields (nested)}` (fetched
  2026-06-24).
- [NominalTimeRunFacet.json](https://github.com/OpenLineage/OpenLineage/blob/main/spec/facets/NominalTimeRunFacet.json) —
  `nominalStartTime` (req, *"the schedule time"*) + optional `nominalEndTime` (*"nominal start time of the
  next run"*) (fetched 2026-06-24).
- [OpenLineage Python client](https://openlineage.io/docs/client/python/) +
  [pypi openlineage-python 1.47.1 (2026-05-12)](https://pypi.org/project/openlineage-python/) — `RunEvent`/
  `RunState`/`Run`/`Job`/`InputDataset`/`OutputDataset`, `HttpTransport`/`HttpConfig`, `client.emit()`
  (fetched 2026-06-24).
- [Marquez](https://marquezproject.ai/) +
  [Record a single lineage event](https://marquezproject.ai/docs/api/record-lineage/) +
  [OpenLineageResource.java](https://github.com/MarquezProject/marquez/blob/main/api/src/main/java/marquez/api/OpenLineageResource.java) —
  reference OpenLineage backend, `POST /api/v1/lineage` (port 5000), accepts BaseEvent, 201/400/500,
  stores namespaces/jobs/runs/datasets/dataset-versions (fetched 2026-06-24).
- [DataHub — Open Source Data Lineage](https://datahub.com/blog/open-source-data-lineage/) — the consumer
  side: impact analysis, column-level lineage, OpenLineage consumption into a catalog (fetched
  2026-06-24).
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) — Entity / Activity / Agent + wasGeneratedBy / used /
  wasAttributedTo / wasAssociatedWith / wasDerivedFrom; the model the OpenLineage run graph corresponds to
  (fetched 2026-06-24).
- Project theory: [`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  — primitive #5 "Stamp", and the *"PROV-O for the model + OpenLineage for run-level lineage"* provenance
  bullet (Tier-2/Tier-3).
- Sibling skill (the static stamp this doc complements, not duplicates):
  [`patterns-provenance-stamping.md`](../../data-normalization-tet/references/patterns-provenance-stamping.md)
  — the `Provenance` record, `canonical_fetch_path()`, the ledger lookup, `merge_provenance` contamination
  rule, and the PROV-O/DCAT serialisation of the verdict.
- [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) — fetch-path-not-concept, default
  `false`, no fabricated/RED backfill on a failed fetch (the rule the `FAIL`-emits-no-output behaviour
  enforces at run level).
