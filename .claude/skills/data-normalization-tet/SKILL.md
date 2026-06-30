---
name: data-normalization-tet
description: >
  Build the provider-normalization WRITE PATH for the JPM-Markets re-engineering data-analytics product
  line (NOT Lumina) — the clean-room TET (Transform-Extract-Transform) pattern that maps N heterogeneous
  financial-data provider schemas + value conventions onto ONE validated standard model, on a NEW
  Python/Pydantic/data-engineering stack separate from Lumina's Bun + Express + Prisma + Supabase +
  Upstash stack. This is the normalization layer of the DataQuery/Fusion re-engineering (Project 3):
  given a raw upstream API response, produce validated, unit-/timezone-/scale-normalized standard-model
  rows + a provenance stamp, ready for the time-series store to persist. Covers the three-stage Fetcher
  pipeline (transform_query → extract_data/aextract_data → transform_data); the standard-model layer (a
  base QueryParams + Data pair per logical endpoint where the STANDARD is the field-INTERSECTION shared
  by ≥2 providers, everything narrower is Optional, and provider models SUBCLASS the standard); field/
  schema normalization mechanics (__alias_dict__ provider→standard renaming, __json_schema_extra__ for
  list/enum params, Pydantic v2 field_validator/model_validator coercion, extra='allow' as the
  preserve-don't-drop escape hatch); ROW/VALUE normalization across sources (units & scale — cents vs
  dollars, millions/thousands factors, bps vs percent vs decimal; currency; timezone→UTC; trading
  calendars/business-day grids; frequency/periodicity with resample/reindex/merge_asof point-in-time
  alignment; null/missing/as-of semantics); the provider-adapter plugin/registry architecture
  (endpoint→Fetcher map, the ProviderInterface-style singleton, require_credentials); the validation +
  coercion + typed error taxonomy (unavailable/needsKey/EmptyData, the 204-vs-error trap, ground-or-skip
  never-fabricate); the clean-room legal discipline (reimplement the AGPL-3.0-only OpenBB PATTERN from
  public docs only, never vendor any openbb-* package, idea/expression distinction); and provenance +
  the commercialOk stamp that TET CARRIES but never adjudicates. Pins: Python 3.12+, Pydantic 2.13.x,
  pandas 2.x. Use whenever the task touches writing/extending a provider Fetcher, defining a standard
  model, mapping provider field names, reconciling units/currency/timezone/frequency across data
  sources, the typed empty-data/error path on the write path, the provider registry, or the clean-room
  reimplementation of the OpenBB normalization pattern for this product line.
metadata:
  priority: 55
  sessionStart: false
  productLine: jpm-markets-reengineering
  pathPatterns:
    - '.agents/jpm-markets-reengineering/**'
  bashPatterns:
    - 'transform_query'
    - 'transform_data'
    - 'extract_data'
    - 'alias_dict'
    - 'merge_asof'
    - 'field_validator'
    - 'model_validator'
  promptSignals:
    phrases:
      - 'data normalization'
      - 'normalize provider'
      - 'standard model'
      - 'field intersection'
      - 'tet pipeline'
      - 'transform extract transform'
      - 'fetcher'
      - 'transform_query'
      - 'transform_data'
      - 'extract_data'
      - 'alias_dict'
      - 'json_schema_extra'
      - 'provider adapter'
      - 'provider registry'
      - 'openbb pattern'
      - 'clean room'
      - 'agpl'
      - 'units normalization'
      - 'scale factor'
      - 'bps vs percent'
      - 'cents vs dollars'
      - 'timezone utc'
      - 'trading calendar'
      - 'merge_asof'
      - 'point in time'
      - 'as-of'
      - 'pydantic validator'
      - 'extra allow'
      - 'empty data'
      - 'provenance stamp'
      - 'commercialok'
    minScore: 2
---

# Data Normalization (TET) — the provider-normalization write path for the JPM-Markets re-engineering line (NOT Lumina)

> **Product line.** This skill belongs to the **JPM-Markets re-engineering data-analytics product
> line** — a *separate* product line from Lumina (see [`cto-rules.md`](../../rules/cto-rules.md)
> §"Scope note"). That line is **new ground**: a **Python / Pydantic / data-engineering** stack, NOT
> Lumina's Bun + Express + Prisma + Supabase + Upstash stack. Nothing here wires into Lumina's app code;
> the two repos only share a filesystem home for the research.
>
> **What this skill makes you expert at.** The **normalization layer** of the DataQuery / Fusion
> re-engineering (Project 3): taking a raw response from *any* financial-data provider and producing
> **validated, value-normalized, standard-model rows + a provenance stamp** that the time-series store
> can persist. It is a clean-room reimplementation of the **TET (Transform-Extract-Transform)** pattern
> that OpenBB documented publicly — built for our **persistent** write path (OpenBB's reference
> implementation does *not* persist; ours does), and from OpenBB's **public docs/blog only**, never its
> AGPL-3.0-only source. ([OpenBB data-pipeline blog](https://openbb.co/blog/the-openbb-platform-data-pipeline);
> [license-change blog, 2024-05-15](https://openbb.co/blog/license-change-openbb-platform-goes-agpl/))

This skill follows the **finance-markets gold-standard** cognitive-mesh structure: a thin router here,
deep cited references on demand. It is **greenfield** — references are theory + design/recipe, not yet
`file:line` traces into a built codebase, because the product line has no committed code yet. Versions
pinned this build: **Python 3.12+**, **Pydantic 2.13.4** (released 2026-05-06,
[PyPI](https://pypi.org/project/pydantic/)), **pandas 2.x**.

> **Where TET sits in the data plane.** `python-fastapi-data-service` owns the FastAPI shell;
> `timescaledb-timeseries` owns the persistence target. **TET is the layer between them**: it takes the
> shared `httpx.AsyncClient` from the service, fetches + normalizes, and hands validated standard-model
> rows + a `Provenance` to the store's ingest path. TET ends at *producing rows*; it never writes to
> storage and never resolves instrument identity (that is the `security-master` skill).

---

## Domain Identity

### This skill COVERS

- **The three-stage Fetcher pipeline (TET).** `transform_query` (user/standard params → provider-native
  params) → `extract_data` / `aextract_data` (raw fetch via `httpx`, no shaping) → `transform_data`
  (raw → validated standard models). The exact contract of each stage and the hard boundaries between
  them. (`theory-tet-pipeline.md`)
- **The standard-model layer as a design discipline.** A base `QueryParams` + `Data` pair per logical
  endpoint, where the **STANDARD is the field-INTERSECTION shared by ≥2 providers** (required),
  everything provider-narrower is `Optional`, and **provider models SUBCLASS the standard** and add
  provider-specific fields. The rule that makes provider-swap give apples-to-apples comparison.
  (`theory-standard-models-field-intersection.md`)
- **Field/schema normalization mechanics.** `__alias_dict__` provider→standard renaming;
  `__json_schema_extra__` (`multiple_items_allowed`, `choices`) for list/enum params; Pydantic v2
  `field_validator`/`model_validator` coercion (camelCase→snake_case, `str`→`datetime`, `str`→`Decimal`);
  `extra='allow'` as the escape hatch that **preserves** un-modeled provider fields instead of dropping
  them. (`patterns-field-aliasing-recipes.md`, `patterns-pydantic-v2-validation-coercion.md`)
- **ROW/VALUE normalization across heterogeneous sources.** Reconciling **units & scale** (cents vs
  dollars vs index points; millions/thousands scale factors; **bps vs percent vs decimal**),
  **currency**, **timezone** (→ UTC + original-tz retention), **trading calendars / business-day grids**,
  **frequency/periodicity** (resample vs reindex, `merge_asof` point-in-time alignment), and
  **null/missing/as-of** semantics. (`theory-value-normalization-units-currency.md`,
  `theory-time-calendar-frequency-normalization.md`)
- **The provider-adapter plugin architecture.** A registry / entry-point map of `{endpoint → Fetcher}`,
  the `ProviderInterface`-style singleton, `require_credentials` + the `credentials` dict.
  (`patterns-provider-registry-plugin.md`)
- **The validation + coercion + typed error taxonomy.** `unavailable` / `needsKey` / `EmptyData`, the
  **204-vs-error trap**, ground-or-skip never-fabricate on the write path.
  (`theory-error-taxonomy-null-handling.md`)
- **Data-quality / sanity validation on normalized output.** OHLC consistency, outlier/spike/stale
  checks, schema-level batch validation — catching a GREEN-but-*wrong* number before it persists.
  (`patterns-data-quality-validation.md`)
- **The clean-room legal discipline.** Reimplement the **AGPL-3.0-only** OpenBB pattern from public docs
  only; vendor **zero** `openbb-*` packages; idea/expression distinction; AGPL §13.
  (`theory-cleanroom-agpl-legal.md`)
- **Provenance + the `commercialOk` stamp.** Every normalized batch carries a `Provenance{source,
  fetchedAt, asOf, commercialOk, transform lineage}` — TET **stamps** it; it does not invent the verdict.
  (`patterns-provenance-stamping.md`)
- **Testing + scale of the normalization layer.** Fixture/record tests, the per-row-Pydantic vs
  columnar bulk-path split, the R-SCALE tier story for the write path. (`theory-testing-and-scale.md`)

### This skill does NOT cover

- **NOT instrument IDENTITY / symbology resolution.** That `AAPL`@providerA, `ISIN`@providerB, and a
  FIGI venue fan-out are **one** point-in-time security is the **bitemporal security master** — its own
  skill (`security-master-*`). Baking a ticker→ticker crosswalk into `transform_data` re-creates exactly
  the non-solution this product line promoted to a first-class pillar. Do not solve it here.
- **NOT the persistence target.** TimescaleDB hypertables / Parquet+Arrow distributions are the
  `timescaledb-timeseries` / columnar skills. **TET ends at producing validated standard-model rows +
  a provenance stamp**; it does not own the write to storage.
- **NOT catalog / faceted discovery.** DCAT, GIN/`pg_trgm`, the dataset catalog are a separate skill.
- **NOT the licensing VERDICT.** The `sources-ledger` / `commercialOk` adjudication is owned elsewhere;
  **TET only CARRIES the stamp** — it never decides whether a fetch path is GREEN.
- **NOT the FastAPI service shell.** Uvicorn, the app object, lifespan, DI, deploy are
  `python-fastapi-data-service`. TET is a library the service calls.
- **NOT the worker/cron orchestration** (what *schedules* a backfill) or the **MCP/SDK** surfaces.
- This skill is the **Python/Pydantic NORMALIZATION layer only** — the "map N provider schemas + value
  conventions onto one validated standard model" step.

---

## Decision Tree — task → the ONE reference to open

Open the matched reference and read its decision tables / runnable code before writing Python. Never
load the whole `references/` folder.

| The task is to… | Read this reference |
|---|---|
| Understand the whole TET pipeline end-to-end before writing any provider (the three stages, what each must/must-not do, the boundaries) | `theory-tet-pipeline.md` |
| Design or extend a standard model — decide which fields are standard vs Optional vs provider-specific; the field-intersection rule | `theory-standard-models-field-intersection.md` |
| Write a concrete provider Fetcher + QueryParams + Data for a new GREEN source (full runnable recipe) | `patterns-build-a-provider-fetcher.md` |
| Map provider field names to standard fields / handle list & enum params (`__alias_dict__`, `__json_schema_extra__`) | `patterns-field-aliasing-recipes.md` |
| Reconcile VALUE conventions across sources — units, scale factors, currency, bps/percent/decimal | `theory-value-normalization-units-currency.md` |
| Reconcile TIME — timezones→UTC, trading calendars, frequency/periodicity, point-in-time as-of alignment | `theory-time-calendar-frequency-normalization.md` |
| Write Pydantic v2 validators/coercion (`field_validator`/`model_validator` modes, strict vs coercion, `extra='allow'`, `alias_generator`, `TypeAdapter`) | `patterns-pydantic-v2-validation-coercion.md` |
| Handle nulls, empty data, partial failures, the typed error taxonomy (`EmptyData`/`unavailable`/`needsKey`, the 204 trap, ground-or-skip) | `theory-error-taxonomy-null-handling.md` |
| Add data-quality / sanity validation on normalized output (OHLC consistency, outlier/spike/stale, schema-level batch checks) | `patterns-data-quality-validation.md` |
| Wire providers into the registry / plugin architecture (entry-points, `ProviderInterface`-style map, provider selection, credentials) | `patterns-provider-registry-plugin.md` |
| Stay legal — clean-room reimplement the AGPL OpenBB pattern; what may/may-not be copied; idea vs expression; AGPL §13 | `theory-cleanroom-agpl-legal.md` |
| Attach provenance + the `commercialOk` stamp to each normalized batch and keep TET out of the verdict business | `patterns-provenance-stamping.md` |
| Make the normalization layer testable + fast at scale — fixture/record tests, per-row vs columnar bulk path, R-SCALE tiers | `theory-testing-and-scale.md` |

---

## Non-Negotiables — the rules that always apply

1. **CLEAN-ROOM ONLY — reimplement the PATTERN, never the code.** OpenBB relicensed
   **MIT → AGPL-3.0-only** on **2024-05-15**
   ([blog](https://openbb.co/blog/license-change-openbb-platform-goes-agpl/); SPDX `license = "AGPL-3.0-only"`
   in their own [`pyproject.toml`](https://github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/pyproject.toml)).
   AGPL **§13** triggers on **network/SaaS use** — *exactly* our hosted model — so vendoring **ANY**
   `openbb-*` package (`openbb-core`, `openbb-yfinance`, every provider extension) obligates **full
   source disclosure** of our derivative or a purchased commercial license. The **TET concept** is an
   uncopyrightable IDEA (17 USC §102(b): copyright "does not extend to any … procedure, process, system,
   method of operation"); only OpenBB's **source** is encumbered. Reimplement `Fetcher[Q, R]` from the
   public docs/blog only; **zero `openbb-*` in `pyproject.toml`**; no copied source.
   (`theory-cleanroom-agpl-legal.md`)

2. **NEVER FABRICATE A NUMBER.** A failed / empty / over-budget fetch returns a typed
   `unavailable` / `needsKey` / `EmptyData` — **never** a synthesized value, never a RED-tier backfill to
   "look complete." `transform_data` on empty input raises a **typed empty-data signal** that the worker
   turns into **ground-or-skip** (throw → the store keeps serving stale rather than ingest a fabricated
   one). This is repo non-negotiable #1, on the write path. (`theory-error-taxonomy-null-handling.md`)

3. **THE STANDARD MODEL = THE FIELD INTERSECTION.** A field is standard (required) **only if ≥2
   providers share it**; anything narrower is `Optional` with `default=None`. *(OpenBB, verbatim: "The
   standard is defined based on the intersection of fields that are shared between two or more providers
   that can fuel the same command."* —
   [data-providers FAQ](https://docs.openbb.co/odp/python/faqs/data_providers).) Provider models
   **SUBCLASS the standard and ADD** provider-specific fields — they never redefine or narrow the
   standard's required set. This is the rule that lets a caller swap `provider=` and still compare
   apples to apples. (`theory-standard-models-field-intersection.md`)

4. **TWO SEPARATE NORMALIZATIONS, NEVER CONFLATED.** (a) **field/schema** normalization (`adjOpen`→`open`,
   `'t'`→`date`) is the easy 20% solved by `__alias_dict__` + validators; (b) **VALUE/row** normalization
   (units, scale, currency, tz, calendar, frequency, nulls) is **distinct work that aliasing does NOT
   touch**. A model with correct field *names* but a price in **cents** where the standard is **dollars**
   is **STILL wrong**. *(Instrument-identity normalization is a THIRD thing, owned by `security-master`
   — do not solve it here.)* (`theory-value-normalization-units-currency.md`)

5. **NORMALIZE VALUE CONVENTIONS TO ONE EXPLICIT STANDARD.** Pick and **document** the canonical unit per
   field — price in **major currency units** as `Decimal`; rate as **decimal `0.05`**, not `5` (percent),
   not `500` (bps); volume as **shares**; market cap **unscaled**. Convert every provider's native
   convention to it in `transform_data`, and **record the source convention + applied scale in
   provenance**. A scale-factor or bps/percent mix-up is a **silent 100× or 10000× error** — the exact
   failure mode this skill exists to prevent. (`theory-value-normalization-units-currency.md`)

6. **TIMESTAMPS → UTC, WITH CALENDAR AND FREQUENCY MADE EXPLICIT.** Every datetime is coerced to
   **tz-aware UTC** (retain the original exchange tz when it carries meaning); the **trading calendar**
   and **periodicity** are part of the standard model, **not assumed**. Align cross-source series with
   `merge_asof` (point-in-time, `direction='backward'`) or reindex to a **business-day grid** — **never**
   a naive join that silently drops or mis-pairs rows or introduces **look-ahead**.
   (`theory-time-calendar-frequency-normalization.md`)

7. **PRESERVE, DON'T DROP, UN-MODELED PROVIDER FIELDS.** `Data` uses `extra='allow'` so provider-specific
   fields not in the standard survive into `model_extra` and are documented/returned — dropping them is
   **information loss** and breaks downstream provider-native consumers. *(Symmetrically: on the bulk
   100M-row path do NOT run per-row Pydantic — batch via Arrow/columnar; per-row validation there is the
   documented order-of-magnitude pathology.)* (`patterns-pydantic-v2-validation-coercion.md`,
   `theory-testing-and-scale.md`)

8. **SECURE EXTRACT BY CLOSURE, GROUND BY PROVENANCE.** Credentials/`api_key` are injected into the
   Fetcher (`require_credentials = True` + a `credentials` dict — OpenBB's
   [Fetcher signature](https://docs.openbb.co/python/developer/extension_types/provider)), **never**
   supplied by a model/user param (confused-deputy defense; repo non-negotiable #6). Every emitted
   standard-model batch carries a `Provenance{source, fetchedAt, asOf, commercialOk (default false),
   transform lineage}` — **TET STAMPS it**; it does **not** invent the `commercialOk` verdict (that comes
   from the `sources-ledger`). (`patterns-provenance-stamping.md`)

---

## Anti-Patterns — mistake → fix

| Anti-pattern (the mistake) | The fix |
|---|---|
| Vendoring `openbb-core` / any `openbb-*` "just for the `Fetcher` base class". | Instant AGPL §13 source-disclosure obligation on our network service. **The base classes are ours, reimplemented from docs** — `Fetcher[Q, R]`, `QueryParams`, `Data` are ~60 lines you write once. Zero `openbb-*` in `pyproject.toml`. |
| Doing field aliasing and calling normalization "done". | Leaves cents-vs-dollars, bps-vs-percent, millions-scale, and local-tz timestamps **un-normalized**. Correct field NAMES with wrong VALUE conventions is the **polished-junior trap**; aliasing is the easy 20%. Finish the value/time pass. |
| Making **every** provider field required in the standard model (so a 3rd provider lacking one field fails validation), OR making **everything** Optional (so the standard guarantees nothing and provider-swap comparability is a lie). | The **intersection rule** is the discipline: **shared-by-≥2 = required, narrower = Optional**. |
| Putting fetch/HTTP logic in `transform_data`, or shaping logic in `extract_data`. | `extract_data` ONLY fetches raw (returns a dict / list-of-dicts, **no renaming**); `transform_data` ONLY maps + validates (**no network**). Crossing the boundary makes the pipeline untestable and the error stage ambiguous. |
| Returning `[]` or a zero-/NaN-filled row on an empty/failed upstream instead of raising a typed `EmptyData`/`unavailable`. | The **204-as-success trap** — OpenBB's own `EmptyDataError` maps to a **204 with no message body** that gets *lost* in an API; their guidance is to raise an explicit error instead. A swallowed 204 becomes a "mystery gap"; an empty body backfilled with zeros is a **fabricated number**. ([providers FAQ](https://docs.openbb.co/odp/python/faqs/data_providers)) |
| Per-row Pydantic validation on bulk/backfill ingest (100k+ rows). | The documented **order-of-magnitude slowdown**. Validate the schema on a **sample** / use a **columnar (Arrow / pandera)** check and **batch-coerce** instead. |
| Naive cross-source joins on raw timestamps (`concat`/`merge` on a tz-naive or mixed-frequency index). | Silently **drops rows, double-counts, or introduces look-ahead**. Use a **canonical business-day/UTC grid + `merge_asof`** (point-in-time, `direction='backward'`). |
| Hardcoding provider field maps as scattered string literals throughout the Fetcher. | Drift, untestable, impossible to diff against the provider's actual response. Put **one declarative `__alias_dict__` + `__json_schema_extra__`** at the top of the model. |
| Solving instrument identity inside the normalizer (ad-hoc ticker→ticker maps in `transform_data`). | Symbology is the **bitemporal `security-master` subsystem**. Baking a lossy ticker crosswalk into TET re-creates the exact non-solution OpenBB has — and that this project promoted to a first-class pillar. |
| An AI-assisted "rewrite" that paraphrases OpenBB source line-by-line and calls it clean-room. | **Clean-room requires building from the public SPECIFICATION/behavior, not from reading the encumbered source.** A code-shaped paraphrase of AGPL source is still a derivative. Build from the docs/blog; cite them. |

---

## Output Contract — the grading rubric

A normalization layer produced under this skill is **done** only when:

1. **Clean-room provenance is stated.** No `openbb-*` in `pyproject.toml`; the `Fetcher`/`QueryParams`/
   `Data` base classes are our own, with a one-line note that they were derived from OpenBB's **public
   docs**, not its AGPL source. The legal posture is on record. (NN1)
2. **Each Fetcher is a clean TET.** `transform_query` does params-only (no fetch); `extract_data`/
   `aextract_data` does fetch-only (no shaping, returns raw dict/list); `transform_data` does
   map+validate-only (no network). The boundaries are inspectable. (Anti-pattern #4)
3. **The standard model is the intersection.** Required fields are exactly those shared by ≥2 providers;
   everything narrower is `Optional`; provider models **subclass** and **add**, never narrow. (NN3)
4. **BOTH normalizations are done.** Field names AND value conventions: the unit per field is documented
   and canonical (price `Decimal` major units; rate decimal; volume shares; cap unscaled), every
   provider's native convention is converted, and the **applied scale is recorded in provenance**. (NN4, NN5)
5. **Time is normalized.** Every datetime is **tz-aware UTC**; the calendar + periodicity are explicit
   fields, not assumptions; cross-source alignment uses `merge_asof`/business-day-grid with **no
   look-ahead**. (NN6)
6. **Un-modeled fields survive.** `Data` is `extra='allow'`; provider-specific fields reach `model_extra`
   and are returned, not dropped. (NN7)
7. **The empty/error path is typed.** Empty/failed/over-budget fetches raise a typed
   `EmptyData`/`unavailable`/`needsKey` (never a 204-as-success, never zeros); the worker does
   **ground-or-skip**. No fabricated value reaches the store. (NN2)
8. **Credentials are closure-injected; provenance is stamped.** `api_key` comes from the `credentials`
   dict, never a model param; each batch carries `Provenance{source, fetchedAt, asOf, commercialOk
   (default false), lineage}` — and TET does **not** set `commercialOk:true` on its own authority. (NN8)
9. **Bulk path is columnar.** Backfill/100k+-row ingest does **not** run per-row Pydantic; it uses a
   columnar/batch validation. The **R-SCALE tier** the design survives is named, in numbers. (NN7;
   `theory-testing-and-scale.md`)

---

## References

| File | When to read |
|---|---|
| `theory-tet-pipeline.md` | The conceptual spine: why TET exists and the precise contract of each of the three stages, reimplemented clean-room from OpenBB's public docs/blog for OUR write path (which, unlike OpenBB, PERSISTS). |
| `theory-standard-models-field-intersection.md` | The standard-model layer as a design discipline: how the canonical `QueryParams`+`Data` per endpoint are defined by the field INTERSECTION across providers, and how provider models extend them. |
| `patterns-build-a-provider-fetcher.md` | The end-to-end runnable recipe: given a new GREEN source (e.g. Treasury FiscalData, BLS, FRED), write its `QueryParams`, `Data`, and `Fetcher` with all three TET methods, clean-room. |
| `patterns-field-aliasing-recipes.md` | The mechanical recipes for field/schema normalization: `__alias_dict__` and `__json_schema_extra__` in depth, with many before/after examples. |
| `theory-value-normalization-units-currency.md` | Row/VALUE normalization #1: reconciling numeric conventions across providers — units, scale factors, currency, and rate representations. The "correct names, wrong values" failure surface. |
| `theory-time-calendar-frequency-normalization.md` | Row/VALUE normalization #2: reconciling TIME across providers — timezones, trading calendars, frequency/periodicity, and point-in-time as-of alignment without look-ahead. |
| `patterns-pydantic-v2-validation-coercion.md` | The Pydantic v2 toolbox for the transform stage: validator modes, coercion vs strict, `extra='allow'`, `alias_generator`, `TypeAdapter`, and the bulk-path caveat. |
| `theory-error-taxonomy-null-handling.md` | What the pipeline does when data is missing, empty, partial, or the fetch fails — the typed error taxonomy that upholds "never fabricate a number" on the write path. |
| `patterns-data-quality-validation.md` | Sanity/quality checks on NORMALIZED output before it persists — catching a GREEN-but-wrong number (the second half of "never invent a number"). |
| `patterns-provider-registry-plugin.md` | The provider-adapter plugin architecture: how many Fetchers get registered, selected at request time, and credential-scoped — clean-room of OpenBB's `ProviderInterface`/`Provider`/entry-point design. |
| `theory-cleanroom-agpl-legal.md` | The legal discipline that gates this entire skill: why we reimplement the OpenBB pattern from docs and vendor zero `openbb-*` code, stated precisely enough to defend. |
| `patterns-provenance-stamping.md` | Attaching the provenance + `commercialOk` stamp to every normalized batch — and the strict boundary that TET CARRIES the verdict but never INVENTS it. |
| `theory-testing-and-scale.md` | Making the normalization layer trustworthy and fast: how to test a Fetcher, and the R-SCALE tier story for the write path (per-row vs columnar). |
