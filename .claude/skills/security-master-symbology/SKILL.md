---
name: security-master-symbology
description: >-
  Build the FIGI-anchored, bitemporal SECURITY MASTER + symbology cross-reference layer for the
  JPM-Markets re-engineering data-analytics product line (NOT Lumina) — the identity spine of the
  DataQuery/Fusion re-engineering (Project 3, `.agents/jpm-markets-reengineering/financial-data-analytics-service/`),
  built FIRST, before any multi-provider dataset ships. A NEW Python/FastAPI/Pydantic/Postgres
  data-engineering line, separate from Lumina's Bun + Express + Prisma + Supabase + Upstash stack.
  This skill owns ONE thing: giving every instrument ONE canonical, immutable, license-clean
  identity across many providers, and recording how each provider's identifier maps onto it over
  time. Covers: the three LEVELS of identity (legal entity → instrument/share-class → listing/venue)
  and which identifier names each; why the canonical anchor is the FIGI (public-domain value,
  never reused, free OpenFIGI resolution, cross-asset) and never ISIN/CUSIP/ticker; the verified
  per-identifier LICENSING reality (FIGI public-domain + LEI CC0 = GREEN, displayable; ISIN/CUSIP/
  SEDOL = RED, crosswalk-IN-only, stripped before the distribution boundary; DTI AMBER) and the
  fetch-path principle that the license attaches to where you got the string, not to the concept;
  the OpenFIGI-metadata trap (the FIGI value is PD but its descriptive payload is licensed "AS IS"
  separately); BITEMPORAL modeling (valid-time vs transaction-time on every version, never update in
  place, point-in-time "what did we believe on date Y about date X" queries); the concrete Postgres
  crosswalk SCHEMA (entity/instrument/listing tables, surrogate keys, `tstzrange` + `EXCLUDE USING
  gist` overlap guard, the `identifier_xref` with per-value commercialOk); the OpenFIGI `/v3`
  RESOLVER recipe (async httpx, Pydantic v2 models, job/window rate-limit batching, 429 backoff, the
  never-collapse-the-listing-fan-out + no-match-is-typed-unavailable discipline); and corporate
  actions / symbol changes / ticker reuse over the bitemporal substrate. Use whenever the task
  touches instrument identity, security master, symbology, FIGI/ISIN/CUSIP/SEDOL/LEI/ticker
  cross-referencing, OpenFIGI, identifier licensing, point-in-time/bitemporal reference data, or the
  join key that lets the data-analytics platform blend providers.
---

# Security Master & Symbology

The identity spine of the data-analytics product line. Every quote, every time-series, every
screener row is keyed by an instrument identity; *cross-referencing* those identities (ISIN → FIGI →
ticker → CUSIP) is the join that lets us blend providers. Get this layer wrong and you either silently
merge two different instruments / split one in two, lose the answer to "what did the data say that
day?", or ship an identifier you have no legal right to display. This skill makes that layer correct.

## Domain Identity

**This skill covers** — the *who-is-this-instrument* subsystem of the data plane, built first:
- The three **levels** of identity — legal **entity** (LEI), **instrument**/share-class (share-class
  FIGI), **listing**/venue (exchange FIGI) — and which identifier legitimately names each.
- The **canonical anchor** decision: FIGI as the primary key; ISIN/CUSIP/SEDOL/ticker as
  cross-reference attributes hanging off it, never as the join key.
- The verified **identifier licensing** reality and the fetch-path principle — what may be
  *displayed/redistributed* (`commercialOk`) vs what is *crosswalk-IN-only*.
- **Bitemporal** identity-over-time — valid time + transaction time, append-only versioning,
  point-in-time queries, corporate actions / symbol changes / ticker reuse.
- The concrete **crosswalk schema** (Postgres) and the **OpenFIGI resolver** that populates it.

**This skill does NOT cover** (route elsewhere):
- The persistent Python service that hosts the resolver → `python-fastapi-data-service`.
- Turning a raw provider response into normalized rows → `data-normalization-tet` (this skill is the
  *identity* the normalizer resolves against).
- Storing the time-series the identity keys → `timescaledb-timeseries`.
- The catalog/provenance/licensing of *data series* (vs *identifiers*) → `data-provenance-licensing`
  (the two share the fetch-path/`commercialOk` principle; identifiers are this skill's slice of it).
- The consumer-facing API/SDK that serves resolved identities → `dataquery-delivery-channels`.

## Decision Tree

| When the task is… | Read |
|---|---|
| Orienting — "what does each identifier actually name?", the levels, the same-security-many-names problem | [`references/theory-symbology-landscape.md`](references/theory-symbology-landscape.md) **(read first)** |
| "Can I display / redistribute identifier X, or only join on it?" — the per-identifier verdict + the fetch-path rule | [`references/theory-identifier-licensing-reality.md`](references/theory-identifier-licensing-reality.md) |
| "Why FIGI as the anchor?", the share-class/composite/listing FIGI hierarchy, the OpenFIGI-metadata licensing trap | [`references/theory-figi-anchor-and-hierarchy.md`](references/theory-figi-anchor-and-hierarchy.md) |
| "Why two timelines?", point-in-time correctness, corrections, corporate actions / symbol changes over time | [`references/theory-bitemporal-modeling.md`](references/theory-bitemporal-modeling.md) |
| Building the store — the Postgres DDL, surrogate keys, `tstzrange` + `EXCLUDE USING gist`, the `identifier_xref` | [`references/patterns-crosswalk-schema-design.md`](references/patterns-crosswalk-schema-design.md) |
| Resolving an ISIN/CUSIP/SEDOL/ticker → FIGI — the OpenFIGI `/v3` client, batching, rate limits, fan-out | [`references/patterns-openfigi-api-integration.md`](references/patterns-openfigi-api-integration.md) |

> Read the relevant one or two in full — never load the whole `references/` folder at once. The two
> `theory-*` orientation docs (landscape, then licensing) come before any `patterns-*` build recipe.

## Non-Negotiables

1. **Anchor on the FIGI; never on ISIN/CUSIP/ticker.** The canonical key is the FIGI — its value is
   public-domain, immutable, never reused, free to resolve, and cross-asset. Every other identifier is
   stored as a cross-reference attribute *hanging off* the FIGI surrogate key, never as the primary key.
2. **The license attaches to the FETCH PATH, not the concept.** An identifier is a fact, but the right
   to redistribute the *string* is governed by where you got it. **Only FIGI (public domain) and LEI
   (CC0) are `commercialOk:true` / displayable.** ISIN, CUSIP, SEDOL are **crosswalk-IN-only**: store
   them to JOIN, strip them before the read/distribution boundary. DTI is AMBER → held `false` in v1.
3. **Identifiers live at LEVELS — never mix them.** LEI names an *entity*; ISIN/share-class-FIGI name an
   *instrument*; ticker+MIC/listing-FIGI name a *listing*. Joining across levels (e.g. a ticker onto an
   ISIN) is the root cause of nearly every symbology bug.
4. **Bitemporal everything; never update in place.** Every version of every attribute carries valid-time
   AND transaction-time. Corrections append a new version; they never overwrite. The master must be able
   to answer "what did we believe on date Y about date X." A single-timeline master fails silently.
5. **The `EXCLUDE USING gist` overlap constraint is load-bearing.** Temporal integrity (no two
   overlapping valid/transaction intervals for the same key) is enforced by the database constraint, not
   by application discipline.
6. **OpenFIGI descriptive metadata is licensed separately.** The FIGI *value* is public domain; the
   `name`/`ticker`/`securityType`/`securityDescription` payload is provided "AS IS" under its own terms.
   Do not assume the whole OpenFIGI response is PD.
7. **Never fabricate identity, never collapse the fan-out.** One OpenFIGI mapping job returns *many* rows
   (one per listing) — preserve the fan-out. A no-match is a typed `unavailable`, never an empty success
   and never a guessed row. (The `data-normalization-tet` never-invent discipline, applied to identity.)
8. **Build the security master FIRST.** It is Phase 1, before any multi-provider Dataset ships — the
   exit test is: ingest the *same instrument* from two providers under different symbols and return one
   joined series.

## Anti-Patterns

- **"An ID is an ID."** Treating ISIN, CUSIP, ticker as interchangeable labels → silently merging two
  instruments or splitting one. *Fix:* resolve everything to a FIGI at the correct level first.
- **ISIN/CUSIP as the primary/join key.** Inherits a license onto every row and channel, and both can
  mutate/recycle. *Fix:* FIGI surrogate key; others as `identifier_xref` rows.
- **Displaying CUSIP/ISIN/SEDOL without a purchased license.** Inherits ANNA/CGS/LSEG legal exposure.
  *Fix:* the crosswalk-IN-only rule — strip non-GREEN identifiers at the distribution boundary.
- **Assuming the whole OpenFIGI payload is public domain.** *Fix:* treat the FIGI value as GREEN and the
  descriptive metadata under its own "AS IS" terms.
- **Single-timeline ("update in place") master.** Quietly overwrites what it used to believe → amnesia an
  auditor/backtest discovers months later. *Fix:* bitemporal, append-only.
- **Storing a recycled CUSIP as if immutable.** Some classes (discount CP, agency notes, TBA pools) reuse
  CUSIPs. *Fix:* FIGI (never reused) is the identity; CUSIP is a time-bounded xref.
- **Collapsing the listing fan-out to "one row."** Loses every venue but one. *Fix:* one `listing` per
  exchange FIGI; the share-class FIGI is the roll-up.
- **Per-call OpenFIGI client / ignoring the rate caps.** *Fix:* the ONE shared `httpx.AsyncClient` from
  `python-fastapi-data-service`, a job/window-aware batcher, exponential backoff on 429.

## Output Contract

A security master built to this skill is: **FIGI-anchored** (canonical surrogate key per the
entity/instrument/listing level), **license-correct** (each identifier tagged with its `commercialOk`,
non-GREEN ones stripped before display), **bitemporal** (valid + transaction time on every version,
append-only, point-in-time queryable), **integrity-guarded** (`EXCLUDE USING gist` prevents overlapping
intervals), **honest** (no fabricated rows; no-match → typed `unavailable`; fan-out preserved), and
**provider-agnostic** (the same instrument ingested from two providers under different symbols resolves
to one joined identity). Every load-bearing licensing claim traces to the issuer's own quoted terms.

## References

| File | When to read it |
|---|---|
| [`theory-symbology-landscape.md`](references/theory-symbology-landscape.md) | First. The map — entity/instrument/listing levels, the same-security-many-names problem. |
| [`theory-identifier-licensing-reality.md`](references/theory-identifier-licensing-reality.md) | The verified per-identifier display/join verdict table + the fetch-path principle. The most load-bearing doc. |
| [`theory-figi-anchor-and-hierarchy.md`](references/theory-figi-anchor-and-hierarchy.md) | Why FIGI is the anchor; the share-class/composite/listing FIGI hierarchy; the OpenFIGI-metadata trap. |
| [`theory-bitemporal-modeling.md`](references/theory-bitemporal-modeling.md) | Valid-time vs transaction-time; point-in-time correctness; corrections; corporate actions over time. |
| [`patterns-crosswalk-schema-design.md`](references/patterns-crosswalk-schema-design.md) | The concrete Postgres DDL — the three-level tables, bitemporal columns, `EXCLUDE USING gist`, `identifier_xref`. |
| [`patterns-openfigi-api-integration.md`](references/patterns-openfigi-api-integration.md) | The OpenFIGI `/v3` resolver recipe — async httpx, Pydantic models, rate-limit batching, fan-out discipline. |
