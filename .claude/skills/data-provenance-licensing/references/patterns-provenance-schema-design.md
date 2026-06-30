# patterns: provenance-schema design — the `Provenance`/`commercialOk` record at every tier

> **Scope.** A concrete schema recipe for the **provenance/licensing record** that travels with every
> displayed data series in the **JPM-Markets re-engineering data-analytics product line (NOT Lumina)**.
> It answers one question at three tiers: *what fields does the record carry, and how does it thread
> from the fetcher, through the cache, across the route, to the surface that renders attribution?*
>
> This is a **patterns** (build-recipe) reference. It opens from the v1 shape Lumina ships today
> (`backend/finance/sources.ts`), names its gaps for a Data-as-a-Service (DaaS), then designs the
> fuller record, maps it onto the two W3C standards a data product is expected to speak —
> **DCAT-3** (the *what-it-is* catalog model) and **PROV-O** (the *where-it-came-from* lineage model) —
> gives the composite/derived shape that makes the contamination rule computable, threads it through
> the stack with runnable TypeScript and Pydantic, versions it, and closes with the one performance
> trap that kills this whole idea at scale: **per-row validation on the bulk path.**
>
> Companion theory: the *why* of the `commercialOk` gate lives in the project rule
> [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) and the
> [`sources-ledger`](../../../memory/sources-ledger.md); the *stamping mechanics* on the Python write
> path are `data-normalization-tet`'s `patterns-provenance-stamping.md`. This file is the **schema** —
> the shape of the record itself, the field-by-field design, and how it survives every hop.

---

## 0. The one-paragraph on-ramp (read this first)

Every number we display is a legal liability until proven otherwise. The proof is a small record
stamped onto the data the instant it is fetched, that says **where it came from, under what license, and
whether we are allowed to show it commercially**. Lumina ships a 4-field version of this record today; it
is *correct* but *thin* — it has no machine license id, no fetch-path string, no "as-of" timestamp, no
lineage pointer. For a real data product (a DaaS that resells series to other companies), the thin record
fails an audit: a customer's compliance team will ask "prove this series is CC-BY and show me the exact
URL it came from and when," and a free-text `attribution: "Data provided by X"` string cannot answer that.
So we design a **fuller record** that borrows its field *names* from two W3C standards every data catalog
already speaks — **DCAT-3** for the license/access fields and **PROV-O** for the lineage fields — so that
our internal record can be **projected** to a catalog entry without re-engineering. We keep the record
small and **stamp it at series granularity, never per row** — because per-row validation of a 100-million-row
pull is the single performance pathology that makes a data product unusable (the negation-loop pre-mortem
item 6: a 120 ms call balloons to 840 ms once per-row Pydantic models get instantiated).

---

## 1. The v1 shape — what Lumina ships today, and exactly where it breaks

### 1.1 The record as it exists

`backend/finance/sources.ts` defines the canonical type, duplicated verbatim on the frontend in
`frontend/src/lib/finance-api.ts` so the wire contract is symmetric:

```ts
// backend/finance/sources.ts  (and mirrored in frontend/src/lib/finance-api.ts)
export type Provenance = {
  source: string;          // human label, e.g. "CoinGecko", "Yahoo Finance", "The GDELT Project"
  commercialOk: boolean;   // the hard licensing gate — default false
  attribution: string;     // the EXACT render string the surface must show, e.g. "Data provided by CoinGecko"
  unit?: "USD" | "mana";   // a payload-specific tag (prediction-market volume unit) — not a license field
};
```

Every fetcher returns a payload **that embeds one of these**, via a small factory:

```ts
// the GREEN path — sentiment-sources.ts (public-domain → commercialOk:true by LAW of the fetch path)
provenance: {
  source: "The GDELT Project",
  commercialOk: true,
  attribution: "Source: The GDELT Project (gdeltproject.org)",
}

// the RED path — sources.ts cgProvenance() (CoinGecko Demo tier = personal use → commercialOk:false)
function cgProvenance(): Provenance {
  return {
    source: "CoinGecko",
    commercialOk: false,   // Demo tier = personal use; flip true on a paid commercial plan
    attribution: "Data provided by CoinGecko",
  };
}
```

This is genuinely good for what it is. Three properties make it work:

1. **The gate defaults closed.** `commercialOk` is `false` everywhere until a human proves a GREEN fetch
   path. The Lumina rule states the licensing principle precisely — *the license attaches to the FETCH
   PATH, not the concept* — and the v1 record encodes the verdict, not the data type.
2. **`attribution` is the render string, not a description.** It is the literal text the UI must print.
   That is a real design decision: it makes the rendering side dumb (print this string), which is correct
   because the legal obligation (CC-BY requires attribution *shown on the surface*) lives with the data,
   not the component.
3. **It rides inside the payload, so it survives the cache for free.** `getOrRefresh` stores
   `Entry<T> = { data: T; fetchedAt }` — the *whole* payload, provenance included — so the record never
   has to be re-derived or re-attached on a cache hit. (More on this in §6.)

### 1.2 The four gaps that matter for a data product

The v1 record is a Tier-1 artifact: correct for a demo, *believed* correct for production is the bug. For a
DaaS — where the record is the **product contract**, audited by a customer's lawyers — it has four gaps.

| Gap | What's missing | Why it bites in a DaaS |
|---|---|---|
| **G1 — No fetch path** | The record names the *source label* ("CoinGecko") but not the **exact URL/endpoint** the number came from. | The licensing rule is *the license attaches to the fetch path*. The same 10Y yield is GREEN from treasury.gov and RED from Yahoo's chart API. Without the URL recorded, you cannot **re-prove** the verdict in an audit, and you cannot tell two fetch paths apart. (`commercial-ok-gate.md` makes this the central principle; the record must capture what the rule reasons over.) |
| **G2 — No machine license id** | `source` and `attribution` are free text. There is no **SPDX identifier** (`CC0-1.0`, `CC-BY-4.0`, `NOASSERTION`). | A customer's automated compliance pipeline filters by license id, not by an English sentence. `commercialOk: true` with no `licenseId` is an *assertion with no machine-checkable basis*. SPDX is the universal short id for exactly this. |
| **G3 — No as-of / fetched-at on the record** | `fetchedAt` lives on the *cache* `Entry`, not on the *provenance*. The payload that leaves the cache loses the timestamp's binding to the *data*. | A data product must answer "as of when is this number true?" (the **as-of** / point-in-time question) and "when did *we* fetch it?" (the **fetched-at** freshness question) — two different timestamps. The v1 record has neither; the cache has one of them, on the wrong object. |
| **G4 — No lineage ref** | A composite (Market Mood) is built from a Treasury leg + a GDELT leg + a recession probit. The output record names "Lumina (composite: …)" in prose but carries **no pointer to the input records**. | The **contamination rule** — a composite inherits the *most restrictive* license of its inputs — is *not computable* from a prose string. If one input flips RED, you cannot mechanically find every composite that must flip with it. (§5.) |

Three of these (G1, G2, G4) are *licensing-correctness* gaps; G3 is a *data-correctness* gap. All four are
invisible at Tier 1 because the demo has one source per series and no resale contract.

---

## 2. The recommended fuller record — field by field, with the design rationale

The target record adds exactly the fields the four gaps demand, and **nothing else** — no padding, because
every extra field is a field that must be stamped, stored, transported, and validated at scale.

```ts
// the DaaS provenance record — internal canonical shape
export type Provenance = {
  // ── identity / display (carried over from v1) ──────────────────────────
  source: string;              // human label of the originating provider, e.g. "U.S. Department of the Treasury"
  attribution: string;         // the EXACT render string the surface must show (CC-BY obligation lives here)
  attributionRequired: boolean;// MUST the surface render `attribution`? (CC-BY/GDELT: true; public-domain: optional)

  // ── the licensing gate (the load-bearing field) ───────────────────────
  commercialOk: boolean;       // the hard gate — default false; true ONLY for a proven GREEN fetch path
  licenseId: string;           // SPDX short id: "CC0-1.0" | "CC-BY-4.0" | "NOASSERTION" | "LicenseRef-Provider-Commercial"

  // ── the fetch path (closes G1 — the license attaches HERE) ────────────
  fetchPath: string;           // the exact endpoint the number came from, e.g. "https://home.treasury.gov/.../xml?data=daily_treasury_yield_curve"

  // ── time (closes G3 — two different timestamps) ───────────────────────
  asOf: string | null;         // ISO 8601 — the data's own effective date (curve date, last close). PIT correctness.
  fetchedAt: string;           // ISO 8601 — when WE fetched it. Freshness/staleness. (mirrors the cache stamp ONTO the record)

  // ── lineage (closes G4 — makes the contamination reduce computable) ───
  derivedFrom?: Provenance[];  // for composites: the input records, so the most-restrictive license is COMPUTABLE
  ledgerRow?: string;          // optional pointer into the sources-ledger row that cleared this fetch path (audit anchor)

  // ── payload-specific tags (NOT license fields; carried for the surface)─
  unit?: string;               // e.g. "USD" | "mana" | "bps" — a value-convention tag, kept distinct from licensing
};
```

### 2.1 Why each new field earns its place

- **`licenseId` (SPDX).** SPDX is *the* standardized short identifier for a license — each entry has "a
  standardized short identifier, the full name, the license text, and a canonical permanent URL"
  ([spdx.org/licenses](https://spdx.org/licenses/)). It is machine-filterable. The two ids you will use
  most: **`CC0-1.0`** ("essentially releases the material to the public domain for purposes of only
  copyright" — the right id for US-gov public-domain *and* CC0 sources) and **`CC-BY-4.0`** (attribution
  required). When you have *not* concluded a license, SPDX defines **`NOASSERTION`** — meaning the author
  "has attempted to but cannot reach a reasonable objective determination," or made no attempt, or
  intentionally provided no information ([SPDX 3.0.1 expressions annex](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/)).
  For a purchased commercial display tier there is no public SPDX id, so use the user-defined-reference
  form **`LicenseRef-[idstring]`** (e.g. `LicenseRef-Twelvedata-Commercial`); the format is fixed by SPDX
  and the variable part after `LicenseRef-` is case-insensitive
  ([same annex](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/)).
  **The hard rule: `commercialOk: true` is only ever paired with a license id that *permits* commercial
  display** (`CC0-1.0`, `CC-BY-4.0`, or a `LicenseRef-*-Commercial` you bought). `NOASSERTION` with
  `commercialOk: true` is a contradiction the linter must reject.

- **`attributionRequired`.** v1 conflated "we have an attribution string" with "we must show it." They are
  different. Public-domain US-gov data carries an attribution string for *courtesy* but the surface is not
  legally bound to render it; **CC-BY-4.0 and GDELT bind it** — GDELT's terms grant "unlimited and
  unrestricted… commercial use" **with a mandatory verbatim citation+link** (recorded in
  `sentiment-sources.ts`). The boolean lets the renderer enforce the obligation without parsing English.

- **`fetchPath`.** This is the field the whole licensing rule reasons over. Recording it makes the
  `commercialOk` verdict **re-provable** ("here is the exact URL; check it against the ledger") and lets two
  fetch paths for the same concept be told apart. It maps directly to DCAT's `dcat:accessURL` (§3).

- **`asOf` vs `fetchedAt` — two timestamps, never one.** `asOf` is the *data's* effective date — the
  Treasury curve's `NEW_DATE`, the last-close date, the BLS reference month. It answers point-in-time
  questions ("what was the 10Y on 2026-05-12?"). `fetchedAt` is *our* retrieval time — it answers freshness
  ("is this stale?"). Conflating them is a classic data-product bug: a number can be freshly *fetched*
  (fetchedAt = now) but as-of a stale *date* (asOf = last Friday, because the market is closed). v1 has
  `fetchedAt` on the cache `Entry` only; the fuller record mirrors it **onto the provenance** so the binding
  to the data survives serialization, and adds `asOf`. Both are ISO-8601 strings (PROV-O's timestamps are
  `xsd:dateTime`; ISO-8601 is its lexical form —
  [prov:generatedAtTime](https://www.w3.org/TR/prov-o/)).

- **`derivedFrom` (lineage).** The field that makes the contamination rule *code* rather than *vigilance*.
  A composite carries the array of its input records; `deriveComposite()` (§5) reduces over them. This is
  the operational analogue of PROV-O's `prov:wasDerivedFrom` (entity→entity, §4).

- **`ledgerRow`.** An optional string pointer (a slug or row id) into the
  [`sources-ledger`](../../../memory/sources-ledger.md). It is the audit anchor: given a displayed series,
  one hop to the human-maintained row that cleared it. Optional because RED series have no clearing row.

### 2.2 What the fuller record deliberately does NOT add

- **No nested `License` object** with name + url + text. The SPDX id *is* the canonical pointer (every id
  has a permanent URL); duplicating the license text into every series record is bytes you transport a
  billion times for data you can look up once. Keep `licenseId`; resolve to text only at the catalog edge.
- **No free-form `notes` blob.** A notes field becomes a dumping ground that no machine reads. Anything that
  needs structure gets a field; anything that doesn't goes in the ledger row, not the per-series record.
- **No per-row anything.** The record describes a **series/distribution**, not a row. (§8 is the whole
  argument; it is the single most important constraint in this file.)

---

## 3. Mapping the record onto DCAT-3 (the *what-it-is* projection)

DCAT-3 became a **W3C Recommendation on 22 August 2024**
([W3C news](https://www.w3.org/news/2024/data-catalog-vocabulary-dcat-version-3-is-a-w3c-recommendation/)).
It is "an RDF vocabulary designed to facilitate interoperability between data catalogs published on the
Web" ([vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)). We do **not** adopt RDF internally — that would
be over-engineering for a JSON service. We adopt DCAT's **field names and semantics** so our record
**projects cleanly** to a catalog entry when a customer wants one. This is the "borrow the vocabulary,
keep the JSON" discipline.

### 3.1 The key insight: our record describes a *Distribution*, not a *Dataset*

DCAT distinguishes a **`dcat:Dataset`** (the abstract thing — "US Treasury daily par-yield curve") from a
**`dcat:Distribution`** — "an accessible form of a dataset such as a downloadable file"
([vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)). The link is `dcat:distribution`
(domain `dcat:Dataset`, range `dcat:Distribution` — DCAT-3 §6.6.1).

**Our `Provenance` record describes a Distribution** — a *specific fetch path* to the data. That is exactly
why the licensing rule says "the license attaches to the fetch path": in DCAT terms, **`dcterms:license` is
a property of the `Distribution`, not the `Dataset`.** The same dataset (the 10Y yield) has two
distributions (treasury.gov XML, Yahoo chart API) with two *different* licenses. DCAT's structure encodes
the licensing rule for free. (Project Open Data's DCAT-US mapping confirms the operational pattern:
license/rights from the dataset object are applied to *each distribution* —
[resources.data.gov DCAT-US](https://resources.data.gov/resources/dcat-us/).)

### 3.2 The field-to-DCAT crosswalk

| Our field | DCAT-3 property | DCAT meaning (verbatim where quoted) |
|---|---|---|
| `licenseId` | **`dcterms:license`** | "A legal document under which the resource is made available." Range `dcterms:LicenseDocument`. We carry the SPDX id; the SPDX permanent URL is the `LicenseDocument` IRI. ([vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)) |
| `commercialOk` + `attributionRequired` | **`dcterms:rights`** | "Statement concerning rights not addressed by license or access rights." Range `dcterms:RightsStatement`. Our *display-commercial* verdict is a rights statement layered on top of the bare license. ([vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)) |
| `fetchPath` | **`dcat:accessURL`** | "URL providing access to a distribution of the dataset" — "the URL of a service or location that can provide access to this distribution, typically through a Web form, query or API call." Exactly our endpoint string. ([vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)) |
| `fetchPath` (when a direct file) | **`dcat:downloadURL`** | "Direct link to a downloadable file in a given format." Use this instead of `accessURL` when the path is a file (a Parquet bulk export), `accessURL` when it's an API call. ([vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)) |
| `attribution` | (rendered from `dcterms:rights` / publisher) | The render string; in a full catalog it is derived from `dcterms:publisher` + the license's attribution clause. We precompute it to keep the renderer dumb. |
| `asOf` | **`dcterms:modified`** | "Most recent date the distribution was changed or updated." The data's own effective date. ([vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)) |
| `fetchedAt` | **`dcterms:issued`** *(of our distribution)* / PROV `generatedAtTime` | When our copy was produced. (Catalog tools often use `issued` for first-publication; we treat our fetch as the issuance of *our* distribution.) |
| `unit` | `dcat:mediaType` / a custom `qb:` measure tag | Not a license field; a value-convention tag. In a full catalog it rides on the data-cube measure, not the distribution license. |
| `source` | **`dcterms:publisher`** / **`prov:wasAttributedTo`** Agent | The originating provider as an Agent (§4). |
| `ledgerRow` | **`dcterms:provenance`** (a statement) | "provenance statements about datasets (typically their lineage)" — DCAT-AP's `dct:provenance` ([DCAT-AP→schema.org mapping](https://ec-jrc.github.io/dcat-ap-to-schema-org/)). Our ledger row *is* that statement. |

### 3.3 The projection function (record → DCAT-3 JSON-LD)

When a customer asks for a catalog entry, project — don't re-engineer:

```ts
// project our internal record onto a DCAT-3 Distribution as JSON-LD (only at the catalog edge)
function toDcatDistribution(p: Provenance): Record<string, unknown> {
  return {
    "@type": "dcat:Distribution",
    "dcterms:license": spdxUrl(p.licenseId),       // SPDX id → its canonical permanent URL
    "dcterms:rights": {
      "@type": "dcterms:RightsStatement",
      "commercialDisplay": p.commercialOk,          // our layered verdict
      "attributionRequired": p.attributionRequired,
      "rdfs:label": p.attribution,
    },
    "dcat:accessURL": { "@id": p.fetchPath },
    "dcterms:modified": p.asOf ?? undefined,         // data's effective date
    "dcterms:issued": p.fetchedAt,                   // our retrieval time
    "dcterms:publisher": { "@type": "foaf:Organization", "foaf:name": p.source },
    "dcterms:provenance": p.ledgerRow ? { "rdfs:label": p.ledgerRow } : undefined,
  };
}

// SPDX ids resolve to a canonical permanent URL — https://spdx.org/licenses/<id>.html
function spdxUrl(id: string): string {
  if (id === "NOASSERTION" || id.startsWith("LicenseRef-")) return id; // no public URL
  return `https://spdx.org/licenses/${id}.html`;
}
```

> **Why JSON-LD, not raw JSON, at the edge.** DCAT is an RDF vocabulary; JSON-LD is JSON that carries an
> `@context` so the `dcterms:`/`dcat:` prefixes resolve to the real IRIs. A consumer's catalog tool ingests
> it as RDF; a plain-JSON consumer reads it as ordinary JSON. One projection serves both. (Note: schema.org
> `Dataset` is the *web-SEO* projection — `dcat:` for catalog interop, `schema:Dataset` for Google Dataset
> Search; an alignment to schema.org is included in DCAT itself —
> [DCAT-AP→schema.org](https://ec-jrc.github.io/dcat-ap-to-schema-org/). Pick the projection per consumer;
> keep one internal record.)

---

## 4. Mapping the record onto PROV-O (the *where-it-came-from* projection)

DCAT answers *what the data is and under what license*. **PROV-O answers *how it came to exist*** — the
lineage. PROV-O is a W3C Recommendation providing "a set of general provenance concepts and properties for
interconnecting entities, activities, and agents" ([prov-o](https://www.w3.org/TR/prov-o/)). The JPM
theory doc already selected it as "the domain-agnostic model to stamp lineage/licensing per series"
(`00-theory.md` Tier-2 finding, citing [w3.org/TR/prov-o](https://www.w3.org/TR/prov-o/)).

### 4.1 The three classes map onto our three nouns

| PROV-O class | URI | Our thing |
|---|---|---|
| **`prov:Entity`** | `http://www.w3.org/ns/prov#Entity` | the **data series** we fetched ("a physical, digital, conceptual… thing with some fixed aspects") |
| **`prov:Activity`** | `http://www.w3.org/ns/prov#Activity` | the **fetch** ("something that occurs over a period of time and acts upon or with entities") |
| **`prov:Agent`** | `http://www.w3.org/ns/prov#Agent` | the **provider** ("something that bears some form of responsibility"); a provider is a `prov:Organization` (subclass of Agent); *our fetcher code* is a `prov:SoftwareAgent` |

### 4.2 The four properties that encode our lineage

| PROV-O property | URI | Domain → Range | Encodes |
|---|---|---|---|
| **`prov:wasGeneratedBy`** | `…#wasGeneratedBy` | Entity → Activity | "the series was generated by the fetch" — binds the data to the fetch run |
| **`prov:used`** | `…#used` | Activity → Entity | "the fetch used the provider's endpoint" — the `fetchPath` as a used resource |
| **`prov:wasAttributedTo`** | `…#wasAttributedTo` | Entity → Agent | "the series is attributed to CoinGecko" — *this is the licensing-relevant link*: attribution + the agent whose license governs |
| **`prov:wasDerivedFrom`** | `…#wasDerivedFrom` | Entity → Entity | "the composite was derived from the Treasury leg and the GDELT leg" — the lineage edge `derivedFrom` materializes |
| **`prov:generatedAtTime`** | `…#generatedAtTime` | Entity → `xsd:dateTime` | our `fetchedAt` |
| **`prov:wasAssociatedWith`** | `…#wasAssociatedWith` | Activity → Agent | the fetcher software agent that ran the fetch |

(All URIs and domain/range per [prov-o](https://www.w3.org/TR/prov-o/).)

### 4.3 The projection (record → PROV turtle)

A single fetched series projects to:

```turtle
# the data series IS a prov:Entity, generated by the fetch, attributed to the provider
:treasuryCurve_2026-05-12
  a prov:Entity ;
  prov:wasGeneratedBy   :fetch_treasury_xml ;
  prov:wasAttributedTo  :provider_USTreasury ;     # <- the LICENSING-relevant edge
  prov:generatedAtTime  "2026-05-13T06:00:11Z"^^xsd:dateTime ;
  dcterms:license       <https://spdx.org/licenses/CC0-1.0.html> .

:fetch_treasury_xml
  a prov:Activity ;
  prov:used             <https://home.treasury.gov/.../xml?data=daily_treasury_yield_curve&...> ;  # fetchPath
  prov:wasAssociatedWith :luminaFetcherSoftwareAgent ;
  prov:endedAtTime      "2026-05-13T06:00:11Z"^^xsd:dateTime .

:provider_USTreasury  a prov:Organization ;  foaf:name "U.S. Department of the Treasury" .
:luminaFetcherSoftwareAgent  a prov:SoftwareAgent .
```

A **composite** (Market Mood) adds `wasDerivedFrom` edges — *one per input* — which is precisely what
`derivedFrom: Provenance[]` becomes:

```turtle
:marketMood_2026-05-13
  a prov:Entity ;
  prov:wasGeneratedBy  :compute_marketMood ;
  prov:wasDerivedFrom  :treasuryCurve_2026-05-12 , :gdeltTone_2026-05-13 , :recessionProbit_2026-05-13 ;
  prov:wasAttributedTo :luminaSoftwareAgent .     # WE computed it; but the LICENSE inherits from inputs (§5)
```

> **The point of the PROV projection is not to ship turtle.** It is that **the lineage edges we need for the
> contamination rule are the *same edges* PROV-O defines.** `derivedFrom` ≡ `wasDerivedFrom`. By shaping our
> record to PROV's model, the contamination reduce (§5) is not an ad-hoc Lumina invention — it is a standard
> derivation walk, and our record can be exported to any PROV-consuming lineage tool (OpenLineage,
> OpenMetadata) without re-modeling. (`00-theory.md` Tier-2: "Operational lineage = OpenLineage…
> OpenMetadata consumes both [PROV + OpenLineage].")

---

## 5. The composite / derived shape — making the contamination rule *computable*

### 5.1 The rule, stated

A composite series inherits the **most restrictive** license of its inputs. Concretely:

- `commercialOk(composite) = AND over all inputs` — one RED input makes the whole composite RED.
- `attributionRequired(composite) = OR over all inputs` — if *any* input requires attribution, the
  composite must render *all* required attributions.
- `licenseId(composite) = the most-restrictive input license` (or a synthetic "mixed" marker if they
  genuinely differ and none dominates).

This is the **`commercial-ok-gate.md` contamination rule** ("a composite that inherits a RED input yet
claims GREEN" is a CRITICAL finding F2). In the live code, `fetchMarketMood` is a textbook example: it is
GREEN *only because every input is GREEN* (Treasury + GDELT + the recession probit). The code comment in
`sentiment-sources.ts` makes the dependency explicit — the richer 7-signal dial "leans on equity prices that
today come from Yahoo (commercialOk:false) → that dial is a Phase-2, paid-spine build." That sentence **is**
the contamination rule applied by hand. The schema's job is to make it apply itself.

### 5.2 Why a prose `source` string cannot do it

Today the composite's record says `source: "Lumina (composite: U.S. Treasury, BLS, GDELT)"`. That string is
**human-readable but not machine-walkable**:

- If GDELT's terms changed tomorrow (flip GDELT to RED), there is **no mechanical way** to find every
  composite that must flip with it. You would grep prose. That is the exact failure the lineage field
  prevents.
- You cannot *compute* `commercialOk` for the composite from the string — you have to trust that whoever
  wrote `commercialOk: true` did the AND in their head. That is the vigilance-not-code failure mode.

### 5.3 The shape: carry the input records

```ts
// a composite carries its inputs so the reduce is COMPUTABLE, not asserted
const moodProvenance: Provenance = deriveComposite({
  source: "Lumina Market Mood",
  attribution: "Lumina Market Mood — composite of public sources.",
  fetchPath: "internal:compute/market-mood",
  asOf: rec.asOf,
  fetchedAt: new Date().toISOString(),
  inputs: [treasuryProv, gdeltProv, recessionProbitProv], // <- the lineage
});
```

### 5.4 `deriveComposite()` — the reducer (runnable)

```ts
/**
 * Derive a composite's provenance from its inputs, ENFORCING the contamination rule.
 * The composite's licensing is a fold over the inputs:
 *   - commercialOk  = AND   (one RED input ⇒ composite RED)
 *   - attributionReq = OR   (one input needs attribution ⇒ composite must show ALL)
 *   - licenseId     = the most-restrictive input license
 *   - attribution   = the UNION of every required input attribution string
 *   - derivedFrom   = the input records themselves (the lineage edge)
 *
 * This makes the F2 contamination rule CODE, not vigilance. A composite can never
 * claim GREEN over a RED input because the AND short-circuits to false.
 */
function deriveComposite(args: {
  source: string;
  attribution: string;
  fetchPath: string;
  asOf: string | null;
  fetchedAt: string;
  inputs: Provenance[];
}): Provenance {
  const { inputs } = args;

  // 1. commercialOk = AND. Empty inputs ⇒ default CLOSED (false), never accidentally GREEN.
  const commercialOk = inputs.length > 0 && inputs.every((p) => p.commercialOk);

  // 2. attributionRequired = OR.
  const attributionRequired = inputs.some((p) => p.attributionRequired);

  // 3. most-restrictive license. Order from most→least restrictive; pick the worst present.
  const licenseId = mostRestrictiveLicense(inputs.map((p) => p.licenseId));

  // 4. the composite must render EVERY required input attribution (de-duped, stable order).
  const required = inputs.filter((p) => p.attributionRequired).map((p) => p.attribution);
  const attribution =
    required.length > 0
      ? `${args.attribution} Includes: ${[...new Set(required)].join("; ")}.`
      : args.attribution;

  return {
    source: args.source,
    attribution,
    attributionRequired,
    commercialOk,
    licenseId,
    fetchPath: args.fetchPath,
    asOf: args.asOf,
    fetchedAt: args.fetchedAt,
    derivedFrom: inputs, // the lineage — enables re-walking when an input flips
  };
}

// SPDX ids ranked MOST → LEAST restrictive for OUR display purpose. Anything not listed,
// or NOASSERTION, is treated as MOST restrictive (closed by default).
const LICENSE_RESTRICTIVENESS: string[] = [
  "NOASSERTION",                 // unknown ⇒ treat as most restrictive
  "LicenseRef-Provider-NoDisplay",
  "CC-BY-NC-4.0",                // non-commercial
  "CC-BY-SA-4.0",                // share-alike
  "CC-BY-4.0",                   // attribution required
  "LicenseRef-Provider-Commercial", // we BOUGHT display rights
  "CC0-1.0",                     // public domain — least restrictive
];

function mostRestrictiveLicense(ids: string[]): string {
  if (ids.length === 0) return "NOASSERTION";
  let worstRank = Infinity;
  let worst = "NOASSERTION";
  for (const id of ids) {
    const rank = LICENSE_RESTRICTIVENESS.indexOf(id);
    const effective = rank === -1 ? 0 : rank; // unknown id ⇒ rank 0 (most restrictive)
    if (effective < worstRank) {
      worstRank = effective;
      worst = id;
    }
  }
  return worst;
}
```

### 5.5 The re-walk: when an input flips, find every affected composite

Because `derivedFrom` is structured, a license flip is a tree walk, not a grep:

```ts
/** Does this record (transitively) depend on a series matching `predicate`? */
function dependsOn(p: Provenance, predicate: (leaf: Provenance) => boolean): boolean {
  if (predicate(p)) return true;
  return (p.derivedFrom ?? []).some((child) => dependsOn(child, predicate));
}

// "GDELT just turned RED — which displayed composites must flip?"
const affected = allDisplayedRecords.filter((rec) =>
  dependsOn(rec, (leaf) => leaf.source === "The GDELT Project"),
);
```

That capability — *one upstream change, a mechanical sweep of everything it taints* — is the entire reason
the lineage field exists, and the reason a DaaS can sign a licensing SLA at all.

---

## 6. Threading the record through the stack — the five hops

The record is born at the fetcher and must arrive *intact* at the surface that renders attribution. There
are exactly five hops; the v1 design gets three of them right for free, and the fuller design must preserve
that.

```
 (1) STAMP            (2) CACHE              (3) ROUTE             (4) WIRE            (5) RENDER
 fetcher/normalizer → getOrRefresh(Entry)  → res.json(payload) → frontend client  → attribution UI
 attaches Provenance  stores it WITH data    rides in payload     parses payload     prints attribution
```

### Hop 1 — STAMP (at the fetcher / normalizer, never later)

The record is attached **the instant the data is fetched**, by the code that *knows the fetch path*. This is
non-negotiable: only the fetcher knows the URL, the provider, and (from the ledger) the license. Stamping
later (e.g. in the route) means re-deriving the fetch path, which is impossible to do reliably.

In Lumina this is the `*Provenance()` factory pattern (`cgProvenance()`, `tdProvenance()`, the inline GREEN
objects in `sentiment-sources.ts`). The fuller version is a factory that fills the new fields from a static
**source registry** keyed by fetch path:

```ts
// a tiny static registry: fetch-path family → its proven licensing facts (mirrors the sources-ledger)
const SOURCE_REGISTRY: Record<string, Omit<Provenance, "fetchPath" | "asOf" | "fetchedAt" | "derivedFrom">> = {
  treasury: {
    source: "U.S. Department of the Treasury",
    commercialOk: true,   licenseId: "CC0-1.0",
    attribution: "Source: U.S. Department of the Treasury",
    attributionRequired: false, ledgerRow: "us-treasury-yield-curve",
  },
  gdelt: {
    source: "The GDELT Project",
    commercialOk: true,   licenseId: "CC-BY-4.0",   // attribution MANDATORY per GDELT terms
    attribution: "Source: The GDELT Project (gdeltproject.org)",
    attributionRequired: true,  ledgerRow: "gdelt-doc-2.0",
  },
  coingecko: {
    source: "CoinGecko",
    commercialOk: false,  licenseId: "NOASSERTION", // Demo tier = personal use; no display license
    attribution: "Data provided by CoinGecko",
    attributionRequired: true,  // CoinGecko asks for attribution even on paid tiers
  },
};

function stamp(
  key: keyof typeof SOURCE_REGISTRY,
  fetchPath: string,
  asOf: string | null,
): Provenance {
  return { ...SOURCE_REGISTRY[key], fetchPath, asOf, fetchedAt: new Date().toISOString() };
}
```

> **Layer-law check.** This is *write-path* logic — it belongs at the fetcher/normalizer (Lumina:
> `sources.ts`; the DaaS Python plane: the TET `transform_data` stage). It is **not** a dev-skill concern
> and **not** a runtime-product-skill concern. (`skill-layer-law.md`: "New **data the model must fetch** →
> a tool… Tag every payload with `Provenance{commercialOk}`.")

### Hop 2 — CACHE (the record rides inside the payload, so it survives for free)

This is the hop the v1 design already nails, and it is worth understanding *why* so the fuller design doesn't
break it. `getOrRefresh` stores `Entry<T> = { data: T; fetchedAt }` — **the whole payload**, provenance
included. There is no separate "provenance store" to keep in sync; the record is a *field of the cached
value*. Consequences:

- A cache **hit** returns the provenance with zero extra work — it was never detached.
- A **stale** serve (the SWR path: `return { data: existing.data, …, stale: true }`) returns the *same*
  provenance the data was fetched with — the licensing verdict cannot drift away from the data it describes.
- The cache's own `fetchedAt` and the record's `fetchedAt` are *both* present and should agree at write
  time. The cache stamp is the freshness clock for SWR; the record stamp is the *durable* fetched-at that
  survives once the payload leaves the cache (the cache `Entry` wrapper is stripped at the route).

> **The trap to avoid:** do **not** be tempted to store provenance in a *separate* Redis key from the data
> ("normalize" it out). The moment they live in two keys, a stale data serve can pair fresh provenance with
> stale data (or vice-versa), and the licensing verdict no longer provably describes the bytes on screen.
> **Co-locate the record with the data it describes, always.** (This is the "how many sources of truth for
> this value after the change" interrogation-battery question, answered: exactly one.)

### Hop 3 — ROUTE (rides in the response body, unchanged)

The route hands the cached `data` (provenance and all) straight to `res.json`. No transformation, no
re-stamping. The cache `Entry` wrapper (`{ data, fetchedAt, stale }`) is flattened into the payload —
in Lumina the route spreads `fetchedAt`/`stale` onto the payload so the frontend sees them
(`finance-api.ts` payload types all carry optional `fetchedAt?`/`stale?`).

### Hop 4 — WIRE (the type is symmetric on both sides)

The frontend declares the **identical `Provenance` type** (`frontend/src/lib/finance-api.ts` lines 3–8
today). When the backend type grows the new fields, the frontend type grows them in the same commit — the
wire contract is a single shared shape, duplicated by hand (the two files must move together; a schema
version field, §7, makes a drift detectable at runtime).

### Hop 5 — RENDER (the surface prints `attribution`, gated by `attributionRequired`)

The renderer is deliberately dumb: it prints `attribution` when `attributionRequired` is true (and may show
it for courtesy otherwise). `renderAttribution()`:

```ts
/**
 * Produce the attribution line a surface MUST render. The legal obligation lives with the
 * data (the record), not the component — so the component just asks the record what to show.
 */
function renderAttribution(p: Provenance): string | null {
  // CC-BY / GDELT: MUST render. Public-domain: optional courtesy (return it anyway; cheap goodwill).
  if (!p.attribution) return null;
  // For composites, attribution already UNIONs every required input string (see deriveComposite).
  return p.attribution;
}

// in a React surface:
//   const line = renderAttribution(payload.provenance);
//   {line && <p className="text-xs text-muted-foreground">{line}</p>}
```

The `commercialOk` flag is consumed *earlier* than render — at the **gate**: a `commercialOk: false` series
is fine to build and demo against but must not be *published* on a public commercial surface. In a DaaS the
gate is enforced at the **delivery channel** (the batch/query API filters out RED series for a paying
customer, or stamps the response as internal-only). Render is where *attribution* is enforced; the channel
is where *display-commercial* is enforced.

---

## 7. Versioning the schema

The record is a wire contract between (a) the fetcher, (b) the cache, (c) the route, (d) the frontend, and —
in a DaaS — (e) external customers. Wire contracts drift. Version the record so drift is *detectable*, not
silent.

### 7.1 Add a `schemaVersion`

```ts
export type Provenance = {
  schemaVersion: 1;   // bump on any breaking field change; readers branch on it
  // … the rest of the fields …
};
```

### 7.2 The migration discipline (additive-first)

- **Additive change (new optional field):** *no* version bump. Old readers ignore the field; new readers
  default it. This covers most evolution (adding `ledgerRow`, adding a `unit` value).
- **Breaking change (rename, type change, removing a field, changing `commercialOk` semantics):** bump
  `schemaVersion`, and keep a reader for the old version for as long as cached `v1` payloads can still be
  served (recall the cache hard-TTL is `softTTL × 12` — a `v1` payload can linger up to 12 TTLs after a
  deploy). A reader that sees an unknown `schemaVersion` **fails closed** (treats the series as RED), never
  open.

```ts
function readProvenance(raw: unknown): Provenance {
  const v = (raw as { schemaVersion?: number })?.schemaVersion;
  if (v === 1) return raw as Provenance;
  // unknown/missing version ⇒ FAIL CLOSED: a record we can't parse is not provably licensed.
  return { schemaVersion: 1, source: "unknown", attribution: "", attributionRequired: true,
           commercialOk: false, licenseId: "NOASSERTION", fetchPath: "", asOf: null,
           fetchedAt: new Date().toISOString() };
}
```

### 7.3 In the DaaS, the catalog is the contract

For external customers the versioned shape is published as the **OpenAPI 3.1 schema** of the response
envelope (the `dataquery-delivery-channels` skill owns the envelope: `data + Provenance{commercialOk} + meta`).
OpenAPI 3.1 is the single contract source; bumping `schemaVersion` is a versioned API change, announced, not
silently shipped. (Compatibility rule: never *remove* a field within a major API version; deprecate, then
remove at the next major.)

---

## 8. The performance trap: per-row validation on the bulk path

This is the most important section in the file, because it is the one that turns a clean schema into an
unusable product. The schema above is **a per-series record**, and it must *stay* per-series. The failure
mode is stamping/validating provenance **per row**.

### 8.1 The pathology, named

The JPM theory pre-mortem already wrote the epitaph (`00-theory.md`, pre-mortem item 6):

> "**Bulk endpoints melt under Pydantic.** A 100M-row pull instantiates per-row Pydantic models; latency
> balloons (the 120 ms→840 ms pathology at scale) and the bulk path is unusable until rebuilt on Arrow
> batch transport."

And the trade-off matrix scored the Python-normalization monolith "4 — **Pydantic cost on thin paths**, but
columnar bulk path bypasses it" (`00-theory.md` §A1). The schema-design implication: **provenance is
metadata about a series, not a column of the series.** If you attach a `Provenance` object to every row and
validate each one, you have re-created the exact pathology — but for *metadata*, which makes it worse,
because the metadata is *identical across all rows of a series*.

### 8.2 Why per-row validation is so expensive (the primary-source mechanics)

Pydantic v2's own performance guidance is explicit
([Pydantic v2 performance](https://pydantic.dev/docs/validation/latest/concepts/performance/)):

- **Validating in a loop instantiates machinery repeatedly.** "Each time a `TypeAdapter` is instantiated,
  it will construct a new validator and serializer. If you're using a `TypeAdapter` in a function, it will
  be instantiated each time the function is called." → *Create the validator once, globally.*
- **Validate the *whole list* in one call, not row-by-row.** Use a single `TypeAdapter(list[Model])` and
  call `.validate_python(rows)` once — the Rust core (`pydantic-core`) iterates internally, far faster than
  a Python `for` loop calling `Model.model_validate(row)` N times.
- **`model_validate_json` beats `model_validate(json.loads(...))`** — "Direct JSON parsing within Pydantic
  is generally faster than first parsing to Python, converting to dict, then validating."
- **`TypedDict` ≈ 2.5× faster than nested `BaseModel`** for plain data shapes, and **`Any` skips validation
  entirely** "when validation isn't required, to keep the value unchanged."
- The docs themselves caution: "validation rarely becomes your bottleneck — optimize only if profiling
  confirms it." On a *thin* path (one quote, one series header) Pydantic is free. On a *bulk* path
  (100M rows) it is the bottleneck, and the rules above are mandatory.

### 8.3 The recipe: stamp at series granularity, validate columnar in batch

**Rule 1 — provenance is stamped once per series, not per row.** The bulk payload is `{ provenance, columns }`
where `columns` is a columnar block (Arrow / a typed array bundle), and `provenance` is **one** record for
the whole block:

```python
# the bulk shape: ONE provenance record over a COLUMNAR data block (NOT a row list with embedded prov)
from dataclasses import dataclass
import pyarrow as pa

@dataclass(slots=True)            # slots=True ⇒ no per-instance __dict__, smaller + faster than a BaseModel
class Provenance:
    schema_version: int
    source: str
    attribution: str
    attribution_required: bool
    commercial_ok: bool
    license_id: str               # SPDX id
    fetch_path: str
    as_of: str | None
    fetched_at: str
    derived_from: tuple["Provenance", ...] = ()

@dataclass(slots=True)
class SeriesBlock:
    provenance: Provenance        # ONE record for the whole block
    table: pa.Table               # columnar: dates[], values[] — NOT a list[RowModel]
```

**Rule 2 — validate provenance ONCE per series with a module-level `TypeAdapter`.** The provenance record is
validated when it is *stamped* (once per fetch), with a reused adapter — never re-validated per delivery:

```python
from pydantic import TypeAdapter

# module-level: built ONCE at import, reused for every stamp (per the perf docs)
_PROV_ADAPTER = TypeAdapter(Provenance)

def stamp(key: str, fetch_path: str, as_of: str | None) -> Provenance:
    base = SOURCE_REGISTRY[key]                       # static dict, no validation cost
    rec = {**base, "fetch_path": fetch_path, "as_of": as_of,
           "fetched_at": _now_iso(), "schema_version": 1}
    return _PROV_ADAPTER.validate_python(rec)         # ONE validate, per series
```

**Rule 3 — never put a `Provenance` field on the row model.** If you must validate the *data* rows at all,
validate them **columnar in one batch**, and keep provenance out of the loop:

```python
# WRONG — per-row provenance + per-row validation = the 120ms→840ms pathology
class Row(BaseModel):
    date: str
    value: float
    provenance: Provenance        # ← identical on every row; validated N times for nothing
rows = [Row.model_validate(r) for r in raw]   # ← N Python-level validate calls

# RIGHT — one provenance for the block; if rows need validation, ONE list-adapter call
_ROWS_ADAPTER = TypeAdapter(list[RowTD])      # RowTD is a TypedDict (≈2.5x faster than BaseModel)
def to_block(raw: list[dict], prov: Provenance) -> SeriesBlock:
    rows = _ROWS_ADAPTER.validate_python(raw) # ONE call; pydantic-core loops in Rust
    table = pa.table({"date": [r["date"] for r in rows], "value": [r["value"] for r in rows]})
    return SeriesBlock(provenance=prov, table=table)   # prov stamped ONCE, off the row loop
```

**Rule 4 — on the truly hot bulk path, skip row validation entirely.** A 100M-row Parquet/Arrow export is
*already typed by Arrow's columnar schema*. Re-validating each value through Pydantic is redundant work that
re-creates the pathology. Validate the **series header** (the provenance record + the column schema) and let
Arrow's columnar types be the row-level guarantee. Pydantic's `Any` / skipping validation "to keep the value
unchanged" ([perf docs](https://pydantic.dev/docs/validation/latest/concepts/performance/)) is the right call
here — the bytes were already validated when the series was *ingested*; the bulk *read* must not re-pay it.

### 8.4 The size argument (why per-row metadata is also a transport disaster)

Even ignoring validation cost: a `Provenance` record serializes to ~300–500 bytes. Attached per row on a
100M-row series, that is **30–50 GB of duplicated, identical metadata** transported per pull — for data that
is one record. Stamping at series granularity makes provenance **O(series)**, not **O(rows)** — the
difference between a few kilobytes and tens of gigabytes per response. This is the same compute-once /
serve-many discipline the read-spike cache uses, applied to metadata: **the license is computed once for the
series and carried once, not hand-written onto every row.**

---

## 9. Putting it together — the full reference record, both runtimes

### 9.1 TypeScript (Lumina-shaped, the thin/serving path)

```ts
export type Provenance = {
  schemaVersion: 1;
  source: string;
  attribution: string;
  attributionRequired: boolean;
  commercialOk: boolean;
  licenseId: string;            // SPDX id | "NOASSERTION" | "LicenseRef-…"
  fetchPath: string;            // dcat:accessURL / downloadURL
  asOf: string | null;         // dcterms:modified (data's effective date)
  fetchedAt: string;           // our retrieval time (prov:generatedAtTime)
  derivedFrom?: Provenance[];   // prov:wasDerivedFrom — the lineage
  ledgerRow?: string;          // dcterms:provenance anchor → sources-ledger
  unit?: string;               // value-convention tag (NOT a license field)
};
```

### 9.2 Python (DaaS write path, with the bulk discipline of §8)

```python
from dataclasses import dataclass

@dataclass(slots=True)          # dataclass+slots, NOT BaseModel, for the per-series record carried in bulk
class Provenance:
    schema_version: int
    source: str
    attribution: str
    attribution_required: bool
    commercial_ok: bool
    license_id: str
    fetch_path: str
    as_of: str | None
    fetched_at: str
    derived_from: tuple["Provenance", ...] = ()
    ledger_row: str | None = None
    unit: str | None = None
```

(Validate with a *module-level* `TypeAdapter(Provenance)` at stamp time only; never re-validate per delivery
or per row.)

### 9.3 The three projections, one record

```
                       ┌─ toDcatDistribution(p)  → dcat:Distribution JSON-LD   (catalog interop)
internal Provenance ──┼─ toProvBundle(p)        → PROV-O turtle/JSON-LD        (lineage tools)
                       └─ toSchemaOrgDataset(p)  → schema:Dataset              (Google web SEO)
```

One internal record, three standard projections produced **only at the edge that needs them**. Internally we
move plain JSON; we never pay RDF cost on the hot path.

---

## 10. Quick decision table

| Situation | Field(s) to set | Why |
|---|---|---|
| US-gov public-domain (Treasury, BLS, SEC) | `commercialOk:true`, `licenseId:"CC0-1.0"`, `attributionRequired:false` | 17 USC §105 public domain; courtesy attribution only |
| CC-BY source (GDELT, OpenAlex) | `commercialOk:true`, `licenseId:"CC-BY-4.0"`, `attributionRequired:true` | attribution is a *license condition*, must render |
| Free API tier (CoinGecko Demo, Yahoo, Twelve Data free) | `commercialOk:false`, `licenseId:"NOASSERTION"`, `attributionRequired:true` | free tier ≠ display license; gate stays closed |
| Purchased display tier | `commercialOk:true`, `licenseId:"LicenseRef-<Provider>-Commercial"`, `ledgerRow` set | the only RED→GREEN path is a paid contract |
| Composite of N inputs | call `deriveComposite()`; never hand-set | `commercialOk = AND`, `attribution = UNION`, license = most-restrictive |
| Bulk 100M-row export | ONE `Provenance` over the columnar block; no per-row prov; no per-row validate | §8 — per-row metadata is the 120ms→840ms pathology + 30–50 GB of duplication |
| Unknown / can't conclude license | `commercialOk:false`, `licenseId:"NOASSERTION"` | SPDX `NOASSERTION` semantics; fail closed |

---

## 11. The grading rubric for a provenance-record design

A provenance schema for this product line is **done** when:

1. **The gate defaults closed.** `commercialOk` is `false` unless a proven GREEN fetch path sets it true,
   and `commercialOk:true` is *always* paired with a license id that permits commercial display (never
   `NOASSERTION`).
2. **The fetch path is recorded** (`fetchPath`), so every verdict is re-provable against the ledger.
3. **The license is machine-readable** (`licenseId` is a valid SPDX id, `NOASSERTION`, or a `LicenseRef-*`).
4. **Two timestamps exist and are distinct** — `asOf` (data effective date) and `fetchedAt` (our retrieval).
5. **Attribution is an obligation flag, not just a string** — `attributionRequired` drives the renderer.
6. **Composites carry their lineage** (`derivedFrom`), and `commercialOk`/`attribution`/`licenseId` are
   *computed* by `deriveComposite()`, never hand-asserted — so an input flip is a mechanical re-walk.
7. **The record co-locates with the data it describes** through cache → route → wire → render (one source of
   truth; a stale serve pairs the *same* provenance with the *same* data).
8. **The schema is versioned** (`schemaVersion`), and an unknown version **fails closed** (RED).
9. **Provenance is stamped at series granularity, validated once with a reused adapter, and NEVER per
   row** — the bulk path carries one record over a columnar block, sidestepping the per-row Pydantic
   pathology and the O(rows) metadata-duplication transport cost.
10. **The record projects to DCAT-3 + PROV-O** field names (so it is catalog- and lineage-interoperable)
    without internal RDF — RDF is paid only at the edge.

A record that misses #1, #3, #6, or #9 fails review: those are, respectively, the open-gate bug, the
unfalsifiable-license bug, the contamination bug, and the bulk-path performance bug — the four failures this
schema exists to prevent.

---

## Sources

**Primary specs (read this run):**
- DCAT-3 — W3C Recommendation, 22 Aug 2024. `dcat:Distribution`, `dcterms:license`, `dcterms:rights`,
  `dcat:accessURL`, `dcat:downloadURL`, `dcterms:modified`, `dcterms:issued`, `dcat:distribution`.
  <https://www.w3.org/TR/vocab-dcat-3/> ·
  Recommendation date: <https://www.w3.org/news/2024/data-catalog-vocabulary-dcat-version-3-is-a-w3c-recommendation/>
- PROV-O — The PROV Ontology (W3C Rec). `prov:Entity/Activity/Agent/Organization/SoftwareAgent`,
  `wasGeneratedBy`, `used`, `wasAttributedTo`, `wasAssociatedWith`, `wasDerivedFrom`, `generatedAtTime`.
  <https://www.w3.org/TR/prov-o/>
- SPDX License List + identifiers (`CC0-1.0`, `CC-BY-4.0`, canonical permanent URLs).
  <https://spdx.org/licenses/>
- SPDX license expressions — `NOASSERTION`, `NONE`, `LicenseRef-[idstring]` semantics (3.0.1 annex B).
  <https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/>
- Pydantic v2 performance — reuse `TypeAdapter`, validate lists in one call, `TypedDict` vs nested
  `BaseModel` (~2.5×), `model_validate_json`, skip validation with `Any`, "validation rarely the bottleneck."
  <https://pydantic.dev/docs/validation/latest/concepts/performance/>
- DCAT-AP → schema.org mapping (`dct:provenance` ↔ schema.org; the Dataset/Distribution license-on-distribution
  pattern). <https://ec-jrc.github.io/dcat-ap-to-schema-org/> ·
  Project Open Data DCAT-US (license/rights applied per-distribution): <https://resources.data.gov/resources/dcat-us/>

**Codebase (this repo, read this run):**
- `backend/finance/sources.ts` — the v1 `Provenance` type + every `*Provenance()` factory (`cgProvenance`,
  `tdProvenance`, inline Polymarket/Yahoo/Twelve-Data records).
- `backend/finance/sentiment-sources.ts` — the GREEN provenance (`commercialOk:true` by fetch-path law:
  Treasury CC0, GDELT CC-BY, recession probit) and the composite `fetchMarketMood` (the contamination rule
  applied by hand).
- `backend/finance/briefing.ts:213` — the composite `PROVENANCE` (`commercialOk:false` because the prose
  synthesizes over `commercialOk:false` legs — contamination by hand).
- `backend/lib/cache.ts` — `getOrRefresh`/`Entry<T> = { data, fetchedAt }`; provenance survives the cache by
  riding inside the payload (hop 2).
- `frontend/src/lib/finance-api.ts` — the mirrored `Provenance` type + payload `fetchedAt?`/`stale?`; how the
  frontend consumes provenance (hops 4–5).
- `.claude/rules/commercial-ok-gate.md` — the fetch-path-not-concept principle + the contamination rule.
- `.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md` — Tier-2 PROV-O/OpenLineage
  selection; §A1 trade-off (Pydantic cost on thin paths); pre-mortem item 6 (the 120ms→840ms per-row Pydantic
  pathology on the bulk path).
