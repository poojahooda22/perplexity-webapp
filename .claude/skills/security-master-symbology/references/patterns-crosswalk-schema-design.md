# patterns — the bitemporal, FIGI-anchored crosswalk schema (Supabase Postgres)

> **Product line:** JPM-Markets re-engineering **data-analytics** line (Project 3,
> `financial-data-analytics-service`). **NOT Lumina.** This is the **security-master subsystem** the
> plan builds *first*, before any multi-provider Dataset ships
> ([`01-plan.md` Phase 1](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md);
> [`03-dataquery-system-design.md` §data-plane](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)
> — *"Security Master (FIGI canonical + bitemporal crosswalk) — Supabase Postgres"*).
>
> **What this doc is.** The **concrete, copy-runnable Postgres DDL** for the three-level entity model
> (`legal_entity` → `instrument` → `listing`), the **canonical surrogate key**, the **bitemporal**
> columns + half-open interval convention + open-row sentinel, the **`identifier_xref`** crosswalk with
> per-`id_value` `commercialOk`, and the **`EXCLUDE USING gist` overlap-prevention constraint** that is
> the load-bearing integrity guard. It is the *buildable* companion to the theory refs: read
> [`theory-bitemporal-modeling.md`](theory-bitemporal-modeling.md) for *why* two time axes, and
> [`theory-figi-anchor-and-hierarchy.md`](theory-figi-anchor-and-hierarchy.md) for *what* a FIGI is. This file is the **recipe**.
>
> **Stack note.** The data plane is **Python/FastAPI persistent service** on Fly
> ([`01-plan.md` Chosen stack](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md)),
> but the **store is Supabase Postgres** — co-located with the catalog metadata and pgvector. So the
> migrations here are **raw SQL** (the canonical form), with a **Prisma-7 schema projection** shown in §8
> for teams that drive Supabase through Prisma (the Lumina convention). **pgvector lives elsewhere** (the
> catalog's NL-search descriptors); this subsystem is **purely relational + temporal** — no vectors.

---

## 0. The shape in one diagram

```
                  ┌──────────────────────────────────────────────────────────────┐
                  │  legal_entity         (LEI-anchored)                          │
                  │   entity_pk  UUID  PK (canonical surrogate)                    │
                  │   lei        CHAR(20)   external anchor (tx-current unique)    │
                  │   + bitemporal: valid_from/valid_to · tx_from/tx_to           │
                  └───────────────▲──────────────────────────────────────────────┘
                                  │  issuer_entity_pk  FK
                  ┌───────────────┴──────────────────────────────────────────────┐
                  │  instrument           (SHARE-CLASS-FIGI-anchored)             │
                  │   instrument_pk  UUID  PK  ◀── THE canonical security id      │
                  │   share_class_figi  CHAR(12)  external anchor (tx-curr unique)│
                  │   + bitemporal                                                │
                  └───────────────▲──────────────────────────────────────────────┘
                                  │  instrument_pk  FK
                  ┌───────────────┴──────────────────────────────────────────────┐
                  │  listing              (EXCHANGE-FIGI-anchored)                │
                  │   listing_pk  UUID  PK                                        │
                  │   figi          CHAR(12)  external anchor (tx-curr unique)    │
                  │   composite_figi CHAR(12)  (country roll-up)                  │
                  │   mic / currency / local_symbol                               │
                  │   + bitemporal                                                │
                  └───────────────────────────────────────────────────────────────┘
                                  ▲
       ┌──────────────────────────┴───────────────────────────────────────────────┐
       │  identifier_xref   one row per (security_ref, id_type, id_value)           │
       │   security_ref (polymorphic: which table + which surrogate pk)             │
       │   id_type  enum (ISIN, CUSIP, SEDOL, TICKER, LEI, DTI, RIC, BBG_TICKER…)   │
       │   id_value text                                                            │
       │   source · commercialOk · fetched_at                                       │
       │   + bitemporal  (valid_from/valid_to · tx_from/tx_to)                      │
       │   ◀── EXCLUDE gist: no two OPEN rows for the same (security_ref,id_type)   │
       │       with overlapping valid-time AND overlapping tx-time                  │
       └───────────────────────────────────────────────────────────────────────────┘
```

**The three rules this schema enforces, stated once:**

1. **The PK is an internal surrogate (UUID/bigint). FIGI/ISIN/CUSIP/ticker are NEVER the PK** — they
   change role, get reassigned by data vendors (ISIN/CUSIP do; FIGI does *not*, which is exactly why FIGI
   is the *anchor* not the *key*), and a ticker is reused (`FB`→`META`, then `FB` freed). The PK must be
   meaningless and immortal. ([theory-symbology §"why not ticker"]; OpenFIGI permanence below.)
2. **Every fact is bitemporal** — `[valid_from, valid_to)` (when the mapping was *true in the world*) and
   `[tx_from, tx_to)` (when *we knew it / recorded it*). Half-open `[)`, open row sentinel for `_to`.
3. **An `EXCLUDE USING gist` constraint makes "two open versions of the same fact" physically impossible** —
   the database row-level guard, not app code. This is the one constraint that turns a pile of SCD2 rows
   into a *correct* bitemporal table.

---

## 1. Why these exact anchors (FIGI levels → tables)

The three table levels map **1:1 onto OpenFIGI's three assignment levels**. This is not coincidence — it
is the whole reason to anchor on FIGI: the identifier system already encodes the entity/instrument/listing
hierarchy we need.

| Our table | FIGI level | OpenFIGI definition (verbatim, cited) | What attaches here |
|---|---|---|---|
| `instrument` | **Share Class FIGI** (global) | *"A Share Class level Financial Instrument Global Identifier is assigned to an instrument that is traded in more than one country … link multiple Composite FIGIs for the same instrument … aggregated view across all countries globally."* ([OpenFIGI hierarchy](https://www.openfigi.com/about/features)) | the **canonical security**; corporate actions; fundamentals |
| `listing` (composite tier) | **Composite FIGI** (country) | *"provided in cases where there are multiple trading venues for the instrument within a single country … aggregated view for that instrument within that country or market."* | the country roll-up (`composite_figi` column on `listing`) |
| `listing` (venue row) | **Exchange-level FIGI** | *"the most granular hierarchy that identifies an instrument specific to the exchange on which it trades."* | **prices**; the per-venue `mic`/`currency`/`local_symbol` |

> **Worked example, cited verbatim:** *"All common stock are the same security and hence share the Share
> Class FIGI `BBG001S69JW7`. Within this Share Class FIGI, the two FIGI that trade on XETRA and Frankfurt
> share the same Country Composite FIGI `BBG000CCVZZ9`."*
> ([OpenFIGI hierarchy](https://www.openfigi.com/about/features), fetched 2026-06-24.) So: one
> `instrument` row (`share_class_figi = BBG001S69JW7`) → one `listing` per venue, both carrying
> `composite_figi = BBG000CCVZZ9`, each with its own exchange-level `figi`.

**`legal_entity`** sits above `instrument` and is anchored on the **LEI** (Legal Entity Identifier,
ISO 17442 — 20 chars), not a FIGI, because FIGI identifies *instruments*, not *issuers*. The issuer of
many instruments (common stock, prefs, bonds) is one `legal_entity`. Ownership/13F/insider data attaches
to `legal_entity`; an instrument's `issuer_entity_pk` FK points at it.

**Why FIGI is the anchor and not the PK (the load-bearing distinction):**

- **FIGI is permanent and never reused** — *"Once issued, a FIGI is never reused and represents the same
  instrument in perpetuity"* and *"An instrument's FIGI never changes as a result of any corporate
  action."* ([Wikipedia: FIGI](https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier),
  citing the OpenFIGI standard). That makes it an *excellent stable external anchor* — far better than
  ISIN (changes on some corporate actions, country-bound) or ticker (reused).
- **But it is still external.** We do not control its issuance, its format could change at the standard
  level, and a security might legitimately exist in our system *before* we have resolved its FIGI (a new
  IPO, a provider that gives us only a ticker). The PK must exist the instant we create the row. So: the
  PK is an internal surrogate; FIGI is a **unique-within-tx-current-slice anchor column** that we resolve
  *to* and de-dupe *on*.

---

## 2. Prerequisites — extensions

Run once per Supabase project, in the SQL Editor (NOT via Prisma — see §8/§9 on the extension-drift trap):

```sql
-- btree_gist lets a GiST index mix a scalar equality (=) with a range overlap (&&)
-- in ONE exclusion constraint. Without it, EXCLUDE (security_ref WITH =, period WITH &&)
-- fails: GiST has no default operator class for uuid/enum equality.
-- Verbatim from the PG docs room-reservation example: "CREATE EXTENSION btree_gist;"
--   https://www.postgresql.org/docs/current/rangetypes.html  (§ "Constraints on Ranges")
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- pgcrypto only if you generate UUIDs server-side with gen_random_uuid().
-- (Postgres 13+ ships gen_random_uuid() in core; pgcrypto is the fallback / older PG.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

> **Supabase caveat (verified).** Postgres has **no native SQL:2011 system-versioned temporal tables** —
> *"Postgres and SQLite are basically the only SQL databases that don't yet support it"*
> ([hyPiRion: Implementing System-Versioned Tables in Postgres](https://hypirion.com/musings/implementing-system-versioned-tables-in-postgres)).
> The popular `temporal_tables` extension *"isn't supported on Azure/AWS/GCP"* managed Postgres
> ([pgxn temporal_tables](https://pgxn.org/dist/temporal_tables/)) — and Supabase does **not** offer it
> either. **Conclusion: we hand-roll SCD2 + bitemporal.** `btree_gist` *is* available on Supabase (it is a
> standard contrib module Supabase ships), so the EXCLUDE-constraint approach below works on Supabase as
> written. The SQL:2011-vs-hand-rolled trade-off is in §9.

---

## 3. The bitemporal column contract (applied to every table)

Every table in this subsystem carries the **same four temporal columns** plus the surrogate PK. We define
the convention **once** and apply it everywhere; this uniformity is what lets a single generic
"as-of" query work across all four tables.

| Column | Type | Meaning | Open-row value |
|---|---|---|---|
| `valid_from` | `timestamptz NOT NULL` | start of **valid time** — when the fact became true *in the world* (e.g. the day a ticker change took effect) | — (always set) |
| `valid_to` | `timestamptz NOT NULL` | end of valid time, **exclusive** | sentinel `'infinity'::timestamptz` |
| `tx_from` | `timestamptz NOT NULL DEFAULT now()` | start of **transaction time** — when *we recorded* this row | — (always `now()` at insert) |
| `tx_to` | `timestamptz NOT NULL` | end of transaction time, **exclusive** | sentinel `'infinity'::timestamptz` |

**Conventions, fixed:**

1. **Half-open intervals `[from, to)`.** Lower bound inclusive, upper bound exclusive. This is the
   Postgres range default and matches the SQL standard: *"PostgreSQL ranges default to half-open
   `[start, end)` which matches SQL standard"* and *"avoids boundary ambiguity"*
   ([Red-Gate: Overlapping Ranges in PostgreSQL](https://www.red-gate.com/simple-talk/databases/postgresql/overlapping-ranges-in-subsets-in-postgresql/)).
   The payoff: **adjacent intervals do not overlap.** A row valid `[2020-01-01, 2021-01-01)` and its
   successor `[2021-01-01, 2022-01-01)` share the instant `2021-01-01` only as one's *exclusive* end and
   the other's *inclusive* start — `&&` reports **no overlap**, so the EXCLUDE constraint accepts both.
   With closed `[]` intervals you would get a spurious overlap at every boundary and the constraint would
   reject legal successors.
2. **Open-row sentinel = `'infinity'::timestamptz`, not `9999-12-31`.** Postgres has a *real* `infinity`
   value for `timestamptz`; it sorts after every finite timestamp and is exact in range comparisons. The
   `9999-12-31` convention exists because SQL Server / DB2 lack a true infinity (*"SQL Server uses
   9999-12-31"* — [bitemporal.net / Asserted Versioning](https://bitemporal.net/generate-bitemporal-intervals/));
   on Postgres, prefer the genuine sentinel. A row with `tx_to = 'infinity'` is **tx-current** ("the
   currently-believed truth"); a row with `valid_to = 'infinity'` is **valid-now** ("true until further
   notice").
3. **Append-only on the transaction axis.** We **never** `UPDATE … SET tx_to`-and-mutate-in-place a fact's
   payload. A correction is: `UPDATE` the old row's `tx_to` from `'infinity'` to `now()` (logically close
   it — "we stopped believing this at `now()`"), then `INSERT` a new row with `tx_from = now()`,
   `tx_to = 'infinity'`, carrying the corrected payload and the (possibly unchanged) valid-time window.
   The old row is **never deleted** — that is the audit trail. (This is the SCD2/dual-SCD2 pattern from
   [Jaco van der Laan: Dual SCD2](https://jacovanderlaan.com/from-historization-to-exposure-building-a-usable-data-platform-with-dual-scd2/)
   and [Kaustubh Saha: Bi-temporal design](https://medium.com/@kaustubh.saha/bi-temporal-database-design-34cd7f0cd250).)

**The two derived range expressions** (used by the EXCLUDE constraint and as-of queries). We do **not**
store these as columns — we compute them from the four scalars, so there is one source of truth:

```sql
tstzrange(valid_from, valid_to, '[)')   -- the valid-time interval
tstzrange(tx_from,    tx_to,    '[)')   -- the transaction-time interval
```

> **Design choice: four scalar columns + computed ranges, NOT two stored `tstzrange` columns.** Storing
> the ranges directly is legal and slightly terser in the constraint, but (a) it complicates the Prisma
> projection (range types are `Unsupported`), (b) point queries on `valid_from` alone want a plain btree on
> a scalar, and (c) the half-open convention is then implicit in the data rather than explicit in every
> write. We keep scalars as the stored truth and build ranges in indexes/constraints. (The alternative is
> fine; this is the documented trade-off, not a silent default.)

---

## 4. Table DDL — the three entity levels

### 4.1 `legal_entity` (LEI-anchored)

```sql
CREATE TABLE legal_entity (
    -- ── canonical surrogate PK (internal, meaningless, immortal) ──
    entity_pk     uuid        NOT NULL DEFAULT gen_random_uuid(),

    -- ── external anchor: the LEI (ISO 17442, 20 chars). Unique only within the
    --    tx-current slice (enforced by a partial unique index, §6), because the
    --    history holds many tx-superseded rows for the same LEI. ──
    lei           char(20),                       -- nullable: an entity may exist pre-LEI-resolution

    -- ── payload (the fact this row asserts) ──
    legal_name    text        NOT NULL,
    jurisdiction  char(2),                         -- ISO 3166-1 alpha-2
    entity_status text,                            -- ACTIVE / INACTIVE / MERGED …

    -- ── bitemporal (the universal contract, §3) ──
    valid_from    timestamptz NOT NULL,
    valid_to      timestamptz NOT NULL DEFAULT 'infinity',
    tx_from       timestamptz NOT NULL DEFAULT now(),
    tx_to         timestamptz NOT NULL DEFAULT 'infinity',

    -- the PK is the surrogate ALONE. Versioning is expressed by the temporal
    -- columns + the EXCLUDE constraint, NOT by widening the PK with dates.
    CONSTRAINT legal_entity_pkey PRIMARY KEY (entity_pk, tx_from),
    CONSTRAINT legal_entity_valid_order CHECK (valid_from <  valid_to),
    CONSTRAINT legal_entity_tx_order    CHECK (tx_from    <  tx_to)
);
```

> **Why is `tx_from` in the PK?** Because the **same `entity_pk` legitimately appears in many rows** — one
> per transaction-time version. The natural-uniqueness of a *physical* row is `(entity_pk, tx_from)`: a
> given surrogate can be (re)recorded at most once per instant. `entity_pk` alone is **not** unique
> (history!), so it cannot be the sole PK. This is the standard Asserted-Versioning move: *"Asserted
> Versioning schemas use surrogate keys and include both effective and assertion begin … dates in the
> primary key"* ([ScienceDirect: Bitemporal Data](https://www.sciencedirect.com/topics/computer-science/bitemporal-data)).
> We include only `tx_from` (not `valid_from`) in the PK because the EXCLUDE constraint (§5) — not the PK —
> enforces the no-overlap invariant across *both* axes; the PK only needs to make a physical row
> addressable. Downstream FKs reference `entity_pk` (the *logical* identity), resolved through the
> tx-current view (§7).

### 4.2 `instrument` (share-class-FIGI-anchored — THE canonical security)

```sql
CREATE TABLE instrument (
    instrument_pk    uuid        NOT NULL DEFAULT gen_random_uuid(),  -- ◀ canonical security id

    -- external anchor: the Share Class FIGI (global level). 12 chars, permanent,
    -- never reused (OpenFIGI), so it is the strongest possible anchor — but still
    -- not the PK (it can be unknown at row-creation time). tx-current unique (§6).
    share_class_figi char(12),                       -- nullable pre-resolution

    -- the issuer. FK to legal_entity's LOGICAL id; resolved tx-current (§7).
    issuer_entity_pk uuid,

    -- payload
    asset_class      text        NOT NULL,           -- EQUITY / BOND / FUND / FUTURE …
    security_type    text,                            -- 'Common Stock', 'Preferred', …
    name             text        NOT NULL,
    primary_currency char(3),                         -- ISO 4217

    -- bitemporal
    valid_from       timestamptz NOT NULL,
    valid_to         timestamptz NOT NULL DEFAULT 'infinity',
    tx_from          timestamptz NOT NULL DEFAULT now(),
    tx_to            timestamptz NOT NULL DEFAULT 'infinity',

    CONSTRAINT instrument_pkey PRIMARY KEY (instrument_pk, tx_from),
    CONSTRAINT instrument_valid_order CHECK (valid_from < valid_to),
    CONSTRAINT instrument_tx_order    CHECK (tx_from    < tx_to)
);
```

> **The FK to `legal_entity` is deliberately NOT a SQL `REFERENCES` constraint.** A standard FK demands the
> parent row's *PK* — but our PK is `(entity_pk, tx_from)`, a physical row, whereas we want to reference the
> *logical* entity (`entity_pk`) and let the temporal join pick the right version *as of* the instrument's
> validity. SQL FKs cannot express "reference the version of the parent valid at the child's `valid_from`."
> So `issuer_entity_pk` is a **soft FK** (a plain `uuid` column) and referential integrity is enforced by
> the application's resolution layer + a periodic integrity check, not by a row-pinning `REFERENCES`. This
> is a known, documented consequence of bitemporal modeling — the same reason SQL:2011's temporal FKs
> (`FOREIGN KEY … PERIOD`) exist and why hand-rolled designs use soft FKs. (See §9.)

### 4.3 `listing` (exchange-FIGI-anchored — where prices attach)

```sql
CREATE TABLE listing (
    listing_pk      uuid        NOT NULL DEFAULT gen_random_uuid(),

    -- external anchor: the EXCHANGE-LEVEL FIGI (most granular).
    figi            char(12),                        -- the per-venue FIGI
    composite_figi  char(12),                        -- the COUNTRY roll-up (Composite FIGI)

    -- FK to the canonical instrument (logical id, resolved tx-current)
    instrument_pk   uuid        NOT NULL,

    -- payload — the venue-specific facts
    mic             char(4),                          -- ISO 10383 Market Identifier Code (e.g. XNAS)
    local_symbol    text,                             -- the venue ticker (e.g. 'AAPL', '7203')
    currency        char(3),                          -- ISO 4217 trading currency
    listing_status  text,                             -- ACTIVE / DELISTED / SUSPENDED

    -- bitemporal
    valid_from      timestamptz NOT NULL,
    valid_to        timestamptz NOT NULL DEFAULT 'infinity',
    tx_from         timestamptz NOT NULL DEFAULT now(),
    tx_to           timestamptz NOT NULL DEFAULT 'infinity',

    CONSTRAINT listing_pkey PRIMARY KEY (listing_pk, tx_from),
    CONSTRAINT listing_valid_order CHECK (valid_from < valid_to),
    CONSTRAINT listing_tx_order    CHECK (tx_from    < tx_to)
);
```

---

## 5. `identifier_xref` — the crosswalk (the heart of the subsystem)

One row per **(which security, which kind of id, which value)**, bitemporal, **with `commercialOk` per
`id_value`**. This is the table that answers "given an ISIN, what is our canonical instrument?" and "what
were all the tickers this instrument traded under, as we believed them on 2019-06-01?".

```sql
-- The kinds of identifier we crosswalk. Enum (not free text) so the discovery
-- index can facet on it and so the licence map (§6.3) is exhaustive.
CREATE TYPE id_type AS ENUM (
    'FIGI',        -- exchange-level FIGI (also stored on listing.figi for the anchor)
    'COMPOSITE_FIGI',
    'SHARE_CLASS_FIGI',
    'ISIN',        -- ⚠ RED licence (see §6.3)
    'CUSIP',       -- ⚠ RED licence
    'SEDOL',       -- ⚠ RED licence
    'LEI',         -- GREEN (GLEIF, CC0)
    'DTI',         -- Digital Token Identifier (ISO 24165) — GREEN
    'TICKER',      -- our own normalized ticker
    'BBG_TICKER',  -- Bloomberg-style 'AAPL US Equity'
    'RIC',         -- ⚠ Refinitiv Instrument Code — RED
    'PERMID',      -- ⚠ check licence per use
    'PROVIDER_SYMBOL' -- a raw upstream provider symbol (e.g. an EDGAR CIK-linked symbol)
);

-- Which level a crosswalk row attaches to. The crosswalk is POLYMORPHIC over the
-- three entity tables; this enum + the matching *_pk column says which.
CREATE TYPE security_level AS ENUM ('ENTITY', 'INSTRUMENT', 'LISTING');

CREATE TABLE identifier_xref (
    xref_pk        uuid          NOT NULL DEFAULT gen_random_uuid(),

    -- ── the polymorphic target: (level, surrogate) ──
    -- We store the level + a single nullable surrogate per level so an FK-style
    -- integrity check is still possible per level. (An alternative single
    -- 'security_ref uuid' loses which table it points at — we keep it explicit.)
    sec_level      security_level NOT NULL,
    entity_pk      uuid,                              -- set iff sec_level = 'ENTITY'
    instrument_pk  uuid,                              -- set iff sec_level = 'INSTRUMENT'
    listing_pk     uuid,                              -- set iff sec_level = 'LISTING'

    -- ── the identifier itself ──
    id_type        id_type       NOT NULL,
    id_value       text          NOT NULL,

    -- ── provenance + licence, PER id_value (§6.3) ──
    source         text          NOT NULL,           -- the fetch path: 'openfigi', 'gleif', 'edgar', 'provider:twelvedata' …
    commercial_ok  boolean       NOT NULL DEFAULT false,  -- the gate. default FALSE.
    fetched_at     timestamptz   NOT NULL DEFAULT now(),  -- when we pulled this value from `source`

    -- ── bitemporal ──
    valid_from     timestamptz   NOT NULL,
    valid_to       timestamptz   NOT NULL DEFAULT 'infinity',
    tx_from        timestamptz   NOT NULL DEFAULT now(),
    tx_to          timestamptz   NOT NULL DEFAULT 'infinity',

    CONSTRAINT identifier_xref_pkey PRIMARY KEY (xref_pk, tx_from),
    CONSTRAINT identifier_xref_valid_order CHECK (valid_from < valid_to),
    CONSTRAINT identifier_xref_tx_order    CHECK (tx_from    < tx_to),

    -- exactly one of the three surrogates is set, matching sec_level
    CONSTRAINT identifier_xref_polymorphic CHECK (
        (sec_level = 'ENTITY'     AND entity_pk     IS NOT NULL AND instrument_pk IS NULL AND listing_pk IS NULL) OR
        (sec_level = 'INSTRUMENT' AND instrument_pk IS NOT NULL AND entity_pk     IS NULL AND listing_pk IS NULL) OR
        (sec_level = 'LISTING'    AND listing_pk    IS NOT NULL AND entity_pk     IS NULL AND instrument_pk IS NULL)
    )
);
```

> **One canonical `security_ref` vs the explicit three-column polymorphism.** The prompt's mental model is
> "one row per `(security_ref, id_type, id_value)`". We realize `security_ref` as **`(sec_level, <the one
> set surrogate>)`** rather than a single opaque `uuid`, because a single opaque column (a) cannot carry a
> per-level integrity check and (b) loses *which* of the three tables it joins to (two different tables
> could, in principle, mint colliding UUIDs — astronomically unlikely, but the schema should not *depend*
> on that). A generated column gives us the convenient single handle when we want it:

```sql
ALTER TABLE identifier_xref
  ADD COLUMN security_ref uuid
  GENERATED ALWAYS AS (COALESCE(entity_pk, instrument_pk, listing_pk)) STORED;
```

`security_ref` is now the single value the EXCLUDE constraint and resolution queries key on, while
`sec_level` disambiguates the table. (`STORED` so it can be indexed and used inside the EXCLUDE GiST index.)

### 5.1 The EXCLUDE constraint — the integrity guard that makes this *correct*

This is the load-bearing line of the whole subsystem. It says: **for a given security + id_type + value,
there can never be two rows whose valid-time intervals overlap AND whose transaction-time intervals
overlap.** In a half-open world, that precisely forbids "two open versions of the same fact" while
permitting legal successors (adjacent, non-overlapping) and tx-superseded history (the old row's
`tx_to` is now finite, so its tx-range no longer overlaps the new open row's).

```sql
ALTER TABLE identifier_xref
  ADD CONSTRAINT identifier_xref_no_overlap
  EXCLUDE USING gist (
    security_ref WITH =,                         -- same security  (needs btree_gist)
    sec_level    WITH =,                         -- same level     (needs btree_gist)
    id_type      WITH =,                         -- same id kind   (needs btree_gist)
    id_value     WITH =,                         -- same value     (needs btree_gist)
    tstzrange(valid_from, valid_to, '[)') WITH &&,   -- overlapping VALID time
    tstzrange(tx_from,    tx_to,    '[)') WITH &&    -- AND overlapping TX time
  );
```

**Why this is the right shape — line by line, each grounded in the PG docs:**

- The pattern `EXCLUDE USING gist (scalar WITH =, range WITH &&)` is the canonical Postgres recipe.
  Verbatim from the docs: `EXCLUDE USING GIST (room WITH =, during WITH &&)` — *"This constraint rejects
  overlapping ranges only if the meeting room numbers are equal."*
  ([PG docs, Range Types §Constraints](https://www.postgresql.org/docs/current/rangetypes.html)). We have
  *four* equality keys (security + level + type + value) instead of one "room", and *two* range overlaps
  (valid **and** tx) instead of one "during" — but the mechanism is identical.
- `btree_gist` is **required** because GiST has no built-in operator class for `=` on `uuid`, an enum, or
  `text`. The docs: *"You can use the `btree_gist` extension to define exclusion constraints on plain
  scalar data types, which can then be combined with range exclusions."* Without it the `ADD CONSTRAINT`
  errors with *"data type uuid has no default operator class for access method gist"*.
- **Both** `tstzrange(...) WITH &&` clauses are present, so a row is rejected only when it collides on
  *both* time axes. Two rows for the same ISIN that were each "true" at different times (different
  valid-windows) coexist freely; two rows recorded at different times for the same valid-window coexist
  *as long as* the older one has been logically closed (`tx_to` set finite, so its tx-range no longer
  overlaps `[now, infinity)`). The half-open `[)` is what makes the boundary instants not collide.
- **The constraint replaces app-level "is there already an open row?" checks.** Never read-then-insert from
  application code to enforce this — that is a TOCTOU race under concurrency (two writers both read "no
  open row", both insert). The GiST index is the single ticket window: under contention exactly one insert
  wins, the other gets `conflicting key value violates exclusion constraint`. (Mirrors the repo's
  atomic-guarded-write non-negotiable; the EXCLUDE constraint is its bitemporal form.)

> **GiST write-cost caveat (honest).** A GiST exclusion constraint checks every insert/update against the
> index, which is more expensive than a plain btree unique check, and GiST index maintenance on `text`
> keys (`id_value`) is heavier than on fixed-width keys. At our write rate this is a non-issue (the write
> path is a nightly/intraday worker, not a user request path — [`01-plan.md` Phase 2]), but it is the
> reason we put the cheap-to-compare keys (`security_ref` uuid, the enums) *first* in the constraint
> column list: GiST evaluates left-to-right and the cheap equality keys prune most candidates before the
> two range overlaps are tested. (Column-order-matters in GiST is noted in
> [ScienceDirect: Bitemporal Table indexing](https://www.sciencedirect.com/topics/computer-science/bitemporal-table)
> — *"The physical sequence of columns within an index significantly impacts query performance."*)

### 5.2 The anchor-uniqueness EXCLUDE on the entity tables

The same mechanism guards the **external anchor columns** on the three entity tables — "no two open
versions assert the same FIGI for different surrogates, or the same surrogate twice." We want: *within the
tx-current + valid-current slice, a `share_class_figi` maps to exactly one `instrument_pk`*. Two
complementary guards:

```sql
-- (a) one surrogate cannot have two overlapping open versions of itself
ALTER TABLE instrument
  ADD CONSTRAINT instrument_self_no_overlap
  EXCLUDE USING gist (
    instrument_pk WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&,
    tstzrange(tx_from,    tx_to,    '[)') WITH &&
  );

-- (b) one share_class_figi cannot be claimed by two surrogates in the same slice.
--     Partial (WHERE) so superseded history and pre-resolution NULLs are exempt.
ALTER TABLE instrument
  ADD CONSTRAINT instrument_figi_no_overlap
  EXCLUDE USING gist (
    share_class_figi WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&,
    tstzrange(tx_from,    tx_to,    '[)') WITH &&
  )
  WHERE (share_class_figi IS NOT NULL);
```

> **Partial EXCLUDE constraints are supported** — an exclusion constraint may carry a `WHERE` predicate
> exactly like a partial index, and only rows satisfying the predicate are checked. We use it here so (i)
> rows with an unresolved (`NULL`) FIGI never collide, and (ii) — if you prefer — you can scope the whole
> guard to tx-current rows with `WHERE (tx_to = 'infinity' AND share_class_figi IS NOT NULL)`, making the
> index smaller and the check cheaper. (Whether to scope to tx-current is a trade-off: scoping shrinks the
> index but means the constraint no longer protects *historical* slices from overlap — fine if corrections
> always close-then-insert, which our write protocol guarantees.)

---

## 6. Indexes — for resolution, history, and search

The query that runs a million times a day is **forward resolution**: "given `(id_type, id_value)` —
e.g. `('ISIN', 'US0378331005')` — what is the canonical security *as of now*?" and its point-in-time
sibling "…as we believed it on `<date>`?". Indexes are designed for exactly these.

### 6.1 The resolution index (the workhorse)

```sql
-- Forward resolution: id → security, with the temporal columns trailing so a
-- range-scan on (id_type, id_value) lands the row and the temporal predicate is
-- evaluated on the narrow matched set.
CREATE INDEX identifier_xref_resolve
  ON identifier_xref (id_type, id_value, valid_from, valid_to);

-- Reverse lookup: security → all its identifiers (for building a row's "all aliases").
CREATE INDEX identifier_xref_by_security
  ON identifier_xref (security_ref, sec_level, id_type);
```

> **Why `(id_type, id_value, valid_from, valid_to)` and not just `(id_value)`?** Because `id_value` is not
> unique across `id_type` (a SEDOL and a local ticker can collide as strings), and because resolution
> always supplies the type. Leading with `id_type` lets one composite index serve both "all ISINs" facet
> scans and exact `(type,value)` probes. The trailing `valid_from/valid_to` keep the temporal filter
> index-resident so the planner does an index-only-ish scan rather than a heap re-check per candidate.

### 6.2 The tx-current partial index (the "what do we believe now" fast path)

The overwhelmingly common case asks only about the **currently-believed** truth (`tx_to = 'infinity'`).
A **partial index** on just those rows is small (it excludes all superseded history) and turns
resolution into a tiny scan:

```sql
-- Only tx-current rows. This is the index the 'resolve as of now' path uses.
CREATE INDEX identifier_xref_tx_current
  ON identifier_xref (id_type, id_value, valid_from, valid_to)
  WHERE (tx_to = 'infinity');

-- Same idea on the entity tables: index only the live versions.
CREATE INDEX instrument_tx_current
  ON instrument (share_class_figi)
  WHERE (tx_to = 'infinity' AND valid_to = 'infinity' AND share_class_figi IS NOT NULL);

CREATE INDEX legal_entity_tx_current
  ON legal_entity (lei)
  WHERE (tx_to = 'infinity' AND valid_to = 'infinity' AND lei IS NOT NULL);

CREATE INDEX listing_tx_current
  ON listing (figi)
  WHERE (tx_to = 'infinity' AND valid_to = 'infinity' AND figi IS NOT NULL);
```

> Partial indexes on the open-row predicate are the standard bitemporal optimization — *"partial/filtered
> indexes can optimize queries against current versions by focusing only on rows with open transaction time
> periods"* ([ScienceDirect: Bitemporal Table](https://www.sciencedirect.com/topics/computer-science/bitemporal-table)).
> Because `'infinity'` is a single constant, `tx_to = 'infinity'` is a sargable equality the partial-index
> predicate matches exactly.

### 6.3 The licence map — storing `commercialOk` per `id_value` and stripping RED at read

The **`commercial_ok` column is per crosswalk row**, because the licence attaches to the **fetch path**,
not the id type in the abstract — the repo's contamination-aware gate
([`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md): *"The license attaches to the
FETCH PATH, not the concept."*). But for symbology the *type* is a strong prior:

| `id_type` | Typical licence verdict | Reason (the fetch-path reality) |
|---|---|---|
| `FIGI` / `COMPOSITE_FIGI` / `SHARE_CLASS_FIGI` | 🟢 GREEN | OpenFIGI is **free and openly redistributable** — the whole point of FIGI is open symbology. |
| `LEI` | 🟢 GREEN | GLEIF publishes the LEI database as **CC0** (public domain). |
| `DTI` | 🟢 GREEN | ISO 24165 DTI registry is openly available. |
| `ISIN` | 🔴 RED | ISIN is administered by national numbering agencies / ANNA; **commercial redistribution is licensed**, not free. |
| `CUSIP` | 🔴 RED | CUSIP is a licensed, fee-bearing identifier (CUSIP Global Services). Redistribution without a licence is a known legal trap. |
| `SEDOL` | 🔴 RED | SEDOL is licensed by the LSE. |
| `RIC` | 🔴 RED | Refinitiv/LSEG proprietary. |

**Default `commercial_ok = false`** (the column default above), flipped to `true` **only** when the fetch
path is on a 🟢 row of the [sources-ledger](../../../.claude/memory/sources-ledger.md). A composite that
*inherits* a RED input stays RED (the contamination rule).

**Strip RED at read** — the gateway never serves a RED `id_value` for *display*; it may still *use* it
internally for joining. A read view that hides RED values:

```sql
-- The view the gateway's /resolve and /catalog read from. RED id_values are
-- nulled for DISPLAY but the row still exists for internal joins.
CREATE VIEW identifier_xref_displayable AS
SELECT
    xref_pk, security_ref, sec_level, id_type,
    CASE WHEN commercial_ok THEN id_value ELSE NULL END AS id_value_display,
    id_value,                          -- raw value: internal joins only, never serialized to a client
    source, commercial_ok, fetched_at,
    valid_from, valid_to, tx_from, tx_to
FROM identifier_xref;
```

> The display layer must **select `id_value_display`** (NULL for RED) and **never** `id_value` for a
> client payload. Internal resolution joins use `id_value`. This is the same split the repo enforces with
> `Provenance{commercialOk}` on every series; here it is enforced one level down, per identifier. A RED
> identifier is *fetchable and joinable, not displayable* — exactly the gate's "RED gates the display
> licence, not access" rule.

### 6.4 Name-search fallback (GIN / trigram)

When an upstream gives us **only a name** (no FIGI/ISIN — e.g. a PDF filing, a news mention), resolution
falls back to fuzzy name match. `pg_trgm` over the instrument/entity name:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN index for fuzzy 'samsng' → 'Samsung Electronics' name resolution.
CREATE INDEX instrument_name_trgm
  ON instrument USING gin (name gin_trgm_ops)
  WHERE (tx_to = 'infinity' AND valid_to = 'infinity');

CREATE INDEX legal_entity_name_trgm
  ON legal_entity USING gin (legal_name gin_trgm_ops)
  WHERE (tx_to = 'infinity' AND valid_to = 'infinity');
```

Query: `WHERE name % $1 ORDER BY similarity(name, $1) DESC LIMIT 10` — the `%` operator and `similarity()`
are `pg_trgm`'s. This is a **fallback / matching** aid only; it is *not* the resolution path (which is the
exact-id index in §6.1). Name match is ambiguous (two "Acme Corp"s) — it returns *candidates* for a
human/agent to disambiguate, never a silent canonical pick. (Per the repo's "never invent" discipline:
a fuzzy name hit is a *suggestion*, not a *resolution*.)

---

## 7. Level-linking — how a price, a corporate action, and ownership attach to the right table

The three levels exist precisely so that each kind of fact attaches where its **identity is stable**:

| Fact | Attaches to | Key it joins on | Why this level |
|---|---|---|---|
| **Price / quote / OHLC** | `listing` | `listing_pk` (resolved from exchange-level `figi` or `(mic, local_symbol)`) | A price is **venue-specific** — AAPL on XNAS ≠ AAPL on a German venue in EUR. Prices live in TimescaleDB keyed by `listing_pk`. |
| **Corporate action** (split, dividend, name change, ticker change) | `instrument` | `instrument_pk` (resolved from `share_class_figi`) | A 4:1 split applies to the **security**, across all its venues — it is an instrument-level event. The FIGI *survives* the action (OpenFIGI: *"never changes as a result of any corporate action"*), so `instrument_pk`/`share_class_figi` is the stable join. A *ticker change* becomes a new `identifier_xref` row (old TICKER `valid_to` closed, new TICKER `valid_from` opened) — the `instrument_pk` is untouched. |
| **Ownership / 13F / insider / fundamentals (issuer-level)** | `legal_entity` | `entity_pk` (resolved from `lei`) | "BlackRock owns X" or "issuer's total debt" is about the **issuer**, not a single share class or venue. |

**The join chain (tx-current, as-of-now), as a concrete query:**

```sql
-- "Give me the price series' identity context for exchange-level FIGI BBG000B9XRY4"
-- (Apple on XNAS), as we believe it now.
WITH lst AS (
  SELECT listing_pk, instrument_pk, mic, local_symbol, currency, composite_figi
  FROM listing
  WHERE figi = 'BBG000B9XRY4'
    AND tx_to = 'infinity' AND valid_to = 'infinity'
), ins AS (
  SELECT i.instrument_pk, i.issuer_entity_pk, i.name, i.share_class_figi, i.asset_class
  FROM instrument i JOIN lst ON i.instrument_pk = lst.instrument_pk
  WHERE i.tx_to = 'infinity' AND i.valid_to = 'infinity'
), ent AS (
  SELECT e.entity_pk, e.legal_name, e.lei
  FROM legal_entity e JOIN ins ON e.entity_pk = ins.issuer_entity_pk
  WHERE e.tx_to = 'infinity' AND e.valid_to = 'infinity'
)
SELECT lst.*, ins.name AS instrument_name, ins.share_class_figi,
       ent.legal_name AS issuer_name, ent.lei
FROM lst JOIN ins ON true JOIN ent ON true;
```

**The point-in-time variant** — "as we believed it on 2019-06-01" — replaces every
`tx_to = 'infinity'` with the bitemporal predicate and parameterizes the as-of instants:

```sql
-- as_of_valid = the business date you want truth FOR; as_of_tx = the date you want truth AS WE KNEW IT.
WHERE tstzrange(valid_from, valid_to, '[)') @> $as_of_valid::timestamptz   -- valid then
  AND tstzrange(tx_from,    tx_to,    '[)') @> $as_of_tx::timestamptz      -- as recorded by then
```

`@>` ("range contains element") is the as-of operator: it selects the single version whose valid-interval
contained the business instant *and* whose tx-interval contained the knowledge instant. With the EXCLUDE
constraint guaranteeing non-overlap, **exactly one row** matches — no `ORDER BY … LIMIT 1` tie-break
needed. (This is the bitemporal "as-of" join; cf.
[JUXT FAQs on Bitemporality](https://www.juxt.pro/blog/bitemporal-webinar-q-and-a/) and
[Marcin Kulakowski: Bi-Temporal Tables for Finance](https://mkulakowski2-73849.medium.com/bi-temporal-tables-a-quick-guide-for-the-financial-industry-9c443ba343ad).)

> **A convenience: tx-current views.** Define a thin view per table so app code that only wants "now"
> never repeats the predicate:
> ```sql
> CREATE VIEW instrument_current AS
>   SELECT * FROM instrument WHERE tx_to = 'infinity' AND valid_to = 'infinity';
> ```
> The partial index (§6.2) backs these efficiently. The resolution layer uses the *current* views for the
> hot path and the *base* tables (with `@>`) for the rare point-in-time / audit query.

---

## 8. Prisma-7 projection (optional — for teams driving Supabase via Prisma)

The **canonical migration form is raw SQL** above. But Lumina's house style drives Supabase through
**Prisma 7** ([prisma skill](../../prisma/SKILL.md)). Prisma **cannot express** `tstzrange`, the EXCLUDE
constraint, or partial-index `WHERE` predicates — so the projection is: **model the scalar columns in
`schema.prisma`, then add the temporal range constraint + partial indexes as hand-written SQL in a
customized migration.** This is the *exact same* split Lumina already uses for pgvector
([`lumina-pgvector-and-raw-queries.md`](../../prisma/references/lumina-pgvector-and-raw-queries.md)):
Prisma owns the columns it understands; raw SQL owns the type/constraint it does not.

```prisma
// schema.prisma — the columns Prisma DOES understand. The bitemporal RANGE
// constraint and partial indexes are added by hand in the migration's SQL (below).
//
// NOTE: like Lumina's pgvector setup, do NOT put `extensions = [btree_gist]` in the
// datasource — on Supabase that makes `prisma migrate dev` flag Supabase's own
// pre-installed extensions as drift and threaten a destructive reset. Enable
// btree_gist / pg_trgm via the Supabase SQL editor (CREATE EXTENSION …).

model Instrument {
  instrumentPk    String   @default(dbgenerated("gen_random_uuid()")) @map("instrument_pk") @db.Uuid
  shareClassFigi  String?  @map("share_class_figi") @db.Char(12)
  issuerEntityPk  String?  @map("issuer_entity_pk") @db.Uuid
  assetClass      String   @map("asset_class")
  securityType    String?  @map("security_type")
  name            String
  primaryCurrency String?  @map("primary_currency") @db.Char(3)

  validFrom DateTime @map("valid_from") @db.Timestamptz
  validTo   DateTime @default(dbgenerated("'infinity'")) @map("valid_to") @db.Timestamptz
  txFrom    DateTime @default(now())                     @map("tx_from") @db.Timestamptz
  txTo      DateTime @default(dbgenerated("'infinity'")) @map("tx_to")   @db.Timestamptz

  // Prisma CAN model the composite PK and plain btree indexes:
  @@id([instrumentPk, txFrom])
  @@index([shareClassFigi], map: "instrument_share_class_figi_idx")
  @@map("instrument")
}
```

Then **edit the generated migration** before `migrate deploy` to add what Prisma cannot emit. Prisma's docs
confirm migration files are *"fully customizable, enabling you to … run custom SQL to make use of native
database features"*
([Prisma: Customizing migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations)):

```sql
-- ── appended to prisma/migrations/<ts>_security_master/migration.sql ──

-- 1. the bitemporal no-overlap guard (Prisma cannot express EXCLUDE/tstzrange)
ALTER TABLE "instrument"
  ADD CONSTRAINT instrument_self_no_overlap
  EXCLUDE USING gist (
    instrument_pk WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&,
    tstzrange(tx_from,    tx_to,    '[)') WITH &&
  );

-- 2. the partial tx-current index (Prisma cannot express the WHERE predicate)
CREATE INDEX instrument_tx_current
  ON "instrument" (share_class_figi)
  WHERE (tx_to = 'infinity' AND valid_to = 'infinity' AND share_class_figi IS NOT NULL);

-- 3. CHECK ordering constraints (these Prisma 7 CAN do via @@check, but if your
--    generator version can't, add them here)
ALTER TABLE "instrument" ADD CONSTRAINT instrument_valid_order CHECK (valid_from < valid_to);
ALTER TABLE "instrument" ADD CONSTRAINT instrument_tx_order    CHECK (tx_from    < tx_to);
```

> **The Prisma `Unsupported` parallel, made explicit.** Just as `embedding Unsupported("vector(1536)")`
> tells Prisma "emit the column, keep it out of the typed client", here the *constraint* is the
> unsupported thing. If you ever need a stored range column, declare it
> `period Unsupported("tstzrange")?` and touch it only via `$queryRaw`/`$executeRaw` — never the typed
> client. (Prisma issue [#3287 "native types range on Postgres"](https://github.com/prisma/prisma/issues/3287)
> confirms range types are not first-class.) **Because the EXCLUDE constraint lives only in raw SQL,
> `prisma migrate dev` will not see it and will not try to drop it on the next diff — but you must NEVER
> run `prisma migrate reset` against this Supabase DB**, or the hand-added constraint and extensions are
> lost (the same reset hazard the prisma skill flags).

**ESM `.js` import reminder** (if the data plane's TS gateway reads this DB through a generated Prisma
client): the generated client must keep `importFileExtension = "js"` or Vercel's strict ESM resolver
fails the build — the repo's cross-cutting non-negotiable #3. (The Python data plane reaches Postgres via
asyncpg/SQLAlchemy and is unaffected; this caveat only bites if the *TS gateway* uses Prisma.)

---

## 9. Why Supabase Postgres, hand-rolled SCD2, and the SQL:2011 trade-off

**Why Supabase Postgres at all** (the plan's choice, restated and defended):

- **Co-location.** The catalog metadata, the security master, and pgvector NL-descriptors all live in **one
  Postgres** ([`03-dataquery` data-plane box](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md)).
  A resolution join (`identifier_xref` → `instrument` → catalog `dataset`) is a single in-database join, not
  a cross-service network hop. The *time-series* warehouse is TimescaleDB (a separate, also-Postgres store);
  the security master is the **relational/temporal** store and belongs with the catalog.
- **`btree_gist` + range types + partial indexes are all native Postgres** — the entire integrity model
  above is built from core/contrib features Supabase ships. No exotic dependency.
- **Supabase gives auth + Realtime + a managed pooler for free**, matching the repo's existing operational
  model. The data plane connects with a service-role connection string.

**Why hand-rolled SCD2 and not native temporal tables** (verified, not assumed):

- **Postgres has no native SQL:2011 system-versioning.** *"There's no official support for system-versioned
  tables in Postgres yet"* and *"Postgres and SQLite are basically the only SQL databases that don't yet
  support it"* ([hyPiRion](https://hypirion.com/musings/implementing-system-versioned-tables-in-postgres)).
  Work on `PERIOD FOR` / application-time is ongoing but not shipped
  ([PostgreSQL wiki: SQL2011Temporal](https://wiki.postgresql.org/wiki/SQL2011Temporal)).
- **The `temporal_tables` extension is not an option on managed Postgres** — *"the temporal extensions
  aren't supported on Azure/AWS/GCP"* ([pgxn temporal_tables](https://pgxn.org/dist/temporal_tables/));
  Supabase likewise does not offer it. And even where available it *"does not provide complete support for
  the 2011 standard … no support for … `AS OF SYSTEM TIME`."*
- **So the only portable, Supabase-compatible route is hand-rolled** — four temporal columns, the
  half-open convention, the open-row sentinel, append-only corrections, and the `EXCLUDE USING gist` guard.
  This is the documented industry practice for finance reference data on Postgres
  ([Marcin Kulakowski: Bi-Temporal Tables for the Financial Industry](https://mkulakowski2-73849.medium.com/bi-temporal-tables-a-quick-guide-for-the-financial-industry-9c443ba343ad);
  [Jaco van der Laan: Dual SCD2](https://jacovanderlaan.com/from-historization-to-exposure-building-a-usable-data-platform-with-dual-scd2/)).

**The honest SQL:2011-vs-hand-rolled trade-off:**

| | SQL:2011 native (e.g. on MariaDB/SQL Server/DB2) | Our hand-rolled Postgres |
|---|---|---|
| **Temporal FKs** (`FOREIGN KEY … PERIOD`) | enforced by the engine | **soft FKs** — app + integrity-check enforced (§4.2) |
| **`AS OF` syntax** | `FOR SYSTEM_TIME AS OF …` reads cleanly | `WHERE tstzrange(...) @> $asof` (more verbose, equally correct) |
| **History-table management** | engine auto-maintains a history table | we manage it with append-only writes + the close-then-insert protocol |
| **Overlap prevention** | application-time `WITHOUT OVERLAPS` in some engines | **`EXCLUDE USING gist`** — actually *more* expressive (two-axis overlap in one constraint) |
| **Portability / cost** | locks us to a temporal-native engine; loses Postgres ecosystem (pgvector, PostGIS, Supabase) | **stays on Postgres** — the whole rest of the stack is here |
| **Correctness** | engine-guaranteed | **constraint-guaranteed** (the EXCLUDE is the linchpin) + a tested write protocol |

**Verdict:** the only thing native SQL:2011 buys that we genuinely lose is *engine-maintained temporal FKs
and `AS OF` sugar* — neither is worth leaving Postgres for, given that (a) the EXCLUDE constraint gives us
overlap-prevention that is *stronger* than the SQL:2011 application-time `WITHOUT OVERLAPS`, and (b) staying
on Postgres keeps the security master co-located with the catalog and pgvector. The cost is **discipline**:
the close-then-insert write protocol (§3) and the soft-FK integrity check must be *correct and tested*,
because the engine isn't doing it for us. That discipline is exactly what the EXCLUDE constraint backstops —
a buggy write protocol that tries to create an overlapping open row is *rejected by the database*, not
silently accepted. That backstop is why the hand-rolled approach is safe.

---

## 10. The write protocol (close-then-insert) — runnable

Because corrections are append-only, every "the world changed" or "we were wrong" event is a **two-row
transaction**. Wrap it so the EXCLUDE constraint sees a consistent state:

```sql
-- A ticker change: instrument's ticker 'FB' → 'META' effective 2022-06-09.
-- We are recording it now (tx). Both steps in ONE transaction.
BEGIN;

-- 1. logically close the old open TICKER row at the valid-time boundary.
--    (valid_to moves from 'infinity' to the change date; tx_to stays open OR is
--     closed-and-reinserted depending on whether this is a NEW FACT vs a CORRECTION.)
--    NEW FACT (the ticker really changed): close valid-time, keep the row tx-current.
UPDATE identifier_xref
   SET valid_to = '2022-06-09'
 WHERE security_ref = $instrument_pk
   AND sec_level = 'INSTRUMENT'
   AND id_type = 'TICKER'
   AND id_value = 'FB'
   AND valid_to = 'infinity'
   AND tx_to   = 'infinity';

-- 2. insert the new open TICKER row.
INSERT INTO identifier_xref
  (sec_level, instrument_pk, id_type, id_value, source, commercial_ok,
   valid_from, valid_to, tx_from, tx_to)
VALUES
  ('INSTRUMENT', $instrument_pk, 'TICKER', 'META', 'edgar', true,
   '2022-06-09', 'infinity', now(), 'infinity');

COMMIT;
```

```sql
-- A CORRECTION (we recorded the wrong ISIN yesterday): close the TX axis, not valid.
BEGIN;

-- 1. retract the belief: close tx_to (we stopped believing it now).
UPDATE identifier_xref
   SET tx_to = now()
 WHERE xref_pk = $wrong_row_xref_pk
   AND tx_to = 'infinity';

-- 2. assert the corrected value with the SAME valid window, new tx window.
INSERT INTO identifier_xref
  (sec_level, instrument_pk, id_type, id_value, source, commercial_ok,
   valid_from, valid_to, tx_from, tx_to)
VALUES
  ('INSTRUMENT', $instrument_pk, 'ISIN', 'US0378331005', 'openfigi', false,
   $orig_valid_from, $orig_valid_to, now(), 'infinity');

COMMIT;
```

> **The EXCLUDE constraint is what makes step ordering safe.** If a buggy writer skipped step 1 and tried
> to insert a second open row whose valid- and tx-ranges overlap the existing open row, the `INSERT` is
> *rejected* — `conflicting key value violates exclusion constraint "identifier_xref_no_overlap"`. The
> writer cannot create a corrupt bitemporal state even by mistake. Idempotency: re-running step 2 after a
> successful commit also fails the constraint (the row is already open), so a retried/double-tapped write
> is naturally idempotent — exactly the repo's idempotency requirement, enforced by the constraint rather
> than an app-level dedup key.

---

## 11. Acceptance checklist (what "done" looks like for this schema)

1. **PK discipline** — every table's PK is `(surrogate_uuid, tx_from)`; **no** FIGI/ISIN/CUSIP/SEDOL/ticker
   appears in any PK. FIGI/LEI are **anchor columns** with **tx-current partial unique** guards, not keys.
2. **Bitemporal columns present + correct** — `valid_from`/`valid_to`/`tx_from`/`tx_to` on all four tables,
   half-open `[)`, `'infinity'` sentinel, CHECK `from < to` on both axes.
3. **The EXCLUDE constraint exists on `identifier_xref`** (and the entity anchors) keying on
   `(security_ref, sec_level, id_type, id_value)` equality + **both** valid-time and tx-time `&&` overlap,
   with `btree_gist` enabled. Verified by an insert test: a second overlapping open row is rejected.
4. **Resolution indexes** — composite `(id_type, id_value, valid_from, valid_to)` + the **partial
   tx-current** index; `pg_trgm` GIN for the name fallback.
5. **`commercial_ok` per `id_value`**, default `false`, RED types (ISIN/CUSIP/SEDOL/RIC) flagged; the
   **display view nulls RED `id_value`**; raw value used only for internal joins.
6. **Level-linking correct** — prices key on `listing_pk`, corporate actions on `instrument_pk`, ownership
   on `entity_pk`; a corporate action leaves the FIGI/`instrument_pk` untouched (only crosswalk rows turn
   over).
7. **As-of query returns exactly one row** per `(security, id_type)` for any `(as_of_valid, as_of_tx)` pair
   — proving the no-overlap invariant holds.
8. **Migration form** — raw SQL is canonical; if Prisma drives it, the EXCLUDE + partial indexes are
   hand-appended to a customized migration, extensions are enabled in Supabase (never `extensions=[…]` in
   the datasource), and **no `prisma migrate reset`** is run against this DB.

---

## Sources (read this run)

**Postgres EXCLUDE / ranges / btree_gist (the integrity mechanism):**
- [PostgreSQL docs — Range Types §Constraints on Ranges](https://www.postgresql.org/docs/current/rangetypes.html) — verbatim `EXCLUDE USING GIST (room WITH =, during WITH &&)`, `CREATE EXTENSION btree_gist`, half-open `[)` default, the conflicting-key error shape.
- [Red-Gate / Simple-Talk — Overlapping Ranges in PostgreSQL](https://www.red-gate.com/simple-talk/databases/postgresql/overlapping-ranges-in-subsets-in-postgresql/) — `EXCLUDE USING gist (tsrange(planned_start, planned_end) WITH &&)`, the half-open `[start,end)` = SQL-standard note, btree_gist for the partition key.
- [Daniel Clayton — Preventing Overlapping Data in PostgreSQL](https://blog.danielclayton.co.uk/posts/overlapping-data-postgres-exclusion-constraints/) — `EXCLUDE USING gist (room_name WITH =, tsrange(check_in, check_out) WITH &&)` + `CREATE EXTENSION btree_gist`.

**FIGI structure + hierarchy + permanence (the anchor):**
- [Wikipedia — Financial Instrument Global Identifier](https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier) — 12-char structure (2-char prefix + 'G' + 8 alnum + check digit), reserved prefixes (BS/BM/GG/GB/GH/KY/VG), BBG legacy prefix, modulus-10 check digit, **permanence**: *"never reused … represents the same instrument in perpetuity"*, *"never changes as a result of any corporate action."*
- [OpenFIGI — Features / hierarchy](https://www.openfigi.com/about/features) — the three levels (Share Class global / Composite country / Exchange-level) verbatim + the `BBG001S69JW7` / `BBG000CCVZZ9` worked example.

**Bitemporal modeling (the column design + SCD2):**
- [Kaustubh Saha — Bi-temporal database design](https://medium.com/@kaustubh.saha/bi-temporal-database-design-34cd7f0cd250) — the 4-timestamp model (valid + transaction).
- [Jaco van der Laan — Dual SCD2](https://jacovanderlaan.com/from-historization-to-exposure-building-a-usable-data-platform-with-dual-scd2/) — business-valid + system-valid dual SCD2.
- [ScienceDirect — Bitemporal Data / Bitemporal Table](https://www.sciencedirect.com/topics/computer-science/bitemporal-data) — surrogate keys + effective/assertion dates in the key; open periods ending in 9999/infinity; partial indexes on open-tx rows; index column-order matters.
- [bitemporal.net — Generate Bitemporal Intervals](https://bitemporal.net/generate-bitemporal-intervals/) — the `9999-12-31` / open-period sentinel convention (and why Postgres prefers true `infinity`).
- [Marcin Kulakowski — Bi-Temporal Tables for the Financial Industry](https://mkulakowski2-73849.medium.com/bi-temporal-tables-a-quick-guide-for-the-financial-industry-9c443ba343ad) · [JUXT — FAQs on Bitemporality](https://www.juxt.pro/blog/bitemporal-webinar-q-and-a/) — finance framing + as-of semantics.

**SQL:2011 vs hand-rolled (the trade-off):**
- [hyPiRion — Implementing System-Versioned Tables in Postgres](https://hypirion.com/musings/implementing-system-versioned-tables-in-postgres) — Postgres has no native SQL:2011 system-versioning.
- [PostgreSQL wiki — SQL2011Temporal](https://wiki.postgresql.org/wiki/SQL2011Temporal) — status of temporal support.
- [pgxn — temporal_tables](https://pgxn.org/dist/temporal_tables/) — the extension and its managed-cloud unavailability.

**Prisma 7 projection (the migration caveat):**
- [Prisma docs — Customizing migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations) — hand-edit migration SQL for native features.
- [Prisma docs — Native database types / Unsupported](https://www.prisma.io/docs/orm/prisma-migrate/workflows/native-database-types) · [prisma#3287 range types](https://github.com/prisma/prisma/issues/3287) — `tstzrange`/range types are `Unsupported`, touch via `$queryRaw`.
- In-repo: [`prisma/references/lumina-pgvector-and-raw-queries.md`](../../prisma/references/lumina-pgvector-and-raw-queries.md) (the Unsupported + extension-drift + reset-hazard pattern this projection copies); [`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md) (the per-fetch-path licence gate applied per `id_value`); [`03-dataquery-system-design.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/03-dataquery-system-design.md) + [`01-plan.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/01-plan.md) (the data-plane / Phase-1 security-master commitment).
