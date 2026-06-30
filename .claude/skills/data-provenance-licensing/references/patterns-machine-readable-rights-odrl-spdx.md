# patterns-machine-readable-rights-odrl-spdx.md

> **Scope.** How to encode the licensing verdict as **machine-readable rights** — an **SPDX license
> identifier** for *which license* + an **ODRL policy** for *which actions are permitted under which
> conditions* — instead of a bare `commercialOk: true` boolean. This is the path from the v1 floor (a
> boolean gate) to a queryable, evolvable rights layer that survives a paid-tier catalog, per-action
> grants, and an attribution obligation a boolean physically cannot express.
>
> **Product line.** JPM-Markets re-engineering **data-analytics product line (NOT Lumina)** — the
> normalized financial Data-as-a-Service that re-engineers J.P. Morgan **DataQuery + Fusion** into our
> own. New Python/FastAPI/data-engineering stack, separate from Lumina's Bun + Express + Prisma +
> Supabase + Upstash stack. This doc is greenfield: the recipes are design + runnable Python/JSON-LD,
> not `file:line` against existing code (none exists yet).
>
> **`patterns-*` doc** = concrete build recipe. The generic, reusable knowledge it implements lives in
> the `theory-*` siblings:
> - [`theory-commercialok-fetch-path-licensing.md`](theory-commercialok-fetch-path-licensing.md) — *why*
>   the verdict attaches to the fetch path, and the boolean it produces today.
> - [`theory-open-data-licenses.md`](theory-open-data-licenses.md) — the GREEN/RED license families
>   (CC0/CC-BY/ODbL/PDDL/ODC-By/CDLA) this doc encodes as identifiers.
> - [`theory-dcat-catalog-modeling.md`](theory-dcat-catalog-modeling.md) — the `dcat:Distribution` node
>   the policy hangs on (via `odrl:hasPolicy`).
> - [`theory-contamination-derived-data-rule.md`](theory-contamination-derived-data-rule.md) — why a
>   composite inherits the most-restrictive input's verdict; here it becomes an ODRL policy-merge rule.
> - [`theory-prov-o-lineage-model.md`](theory-prov-o-lineage-model.md) — the lineage the rights layer
>   sits beside.

---

## 0. The one-paragraph version (read this first)

The Lumina `commercialOk` boolean answers exactly one question — *may I display this commercially, yes
or no?* — and throws away everything else: **which** actions (display? redistribute? cache? derive?),
**under which conditions** (only if attribution is rendered?), for **whom** (internal users vs. API
consumers vs. resellers?), and **with what remedy** if violated. For a free public-domain feed that is
fine — there is one action (display) under no condition, so a boolean *is* the whole truth. The moment
the data-analytics product line has a **paid commercial tier** (the JPM Fusion/DataQuery business model:
per-dataset, per-action display/redistribution grants to enterprise API consumers), the boolean
silently lies: it cannot say "this CC-BY series may be displayed AND redistributed, but ONLY if the
attribution string is rendered," and it cannot say "this vendor series may be displayed internally but
NOT redistributed to your downstream API consumers." The machine-readable upgrade is two standards
working together: **SPDX license identifiers** ([spdx.org/licenses](https://spdx.org/licenses/)) name
*which license* in a canonical, deduplicated, tooling-recognized string (`CC0-1.0`, `CC-BY-4.0`,
`ODbL-1.0`, `PDDL-1.0`, or `LicenseRef-TwelveData-Free-ToS` for a vendor ToS with no SPDX id), attached
as `dct:license` on the `dcat:Distribution`; and a **W3C ODRL policy**
([w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/), a W3C Recommendation) expresses the
**actions** as `Permission`/`Prohibition` rules and the **attribution obligation** as a `Duty` *on* the
permission — the one construct a boolean has no room for — attached as `odrl:hasPolicy` on the same
`Distribution`. The discipline: **ship the boolean + SPDX id at v1 (it is the floor, and it is enough
for the all-GREEN public-domain catalog); add ODRL only when an action-grant matrix actually exists to
express** (§8's earn-its-complexity test). The boolean never disappears — it becomes a *derived view*
computed from the ODRL policy (§9), so the gate keeps working while the rights layer underneath gets
richer.

---

## 1. The problem: what a boolean throws away

### 1.1 The Lumina baseline, stated precisely

The shipped Lumina gate is a single boolean carried on a `Provenance` stamp:

```ts
// Lumina today (the v1 floor we are upgrading)
type Provenance = {
  source: string;          // "treasury.gov" | "yahoo-chart" | "coingecko-demo"
  fetchedAt: string;       // ISO-8601
  commercialOk: boolean;   // default false; true ONLY when the FETCH PATH is GREEN
};
```

The rule behind it (`commercial-ok-gate.md`): `commercialOk: true` is legal only when the fetch path is
public-domain, CC0/CC-BY (with attribution rendered), or a *purchased* commercial display tier. A free
API tier is **not** a display license → `false`. This is correct and load-bearing, and the upgrade
does **not** remove it. The point of this doc is what the boolean *cannot say*.

### 1.2 The five things `commercialOk: true` loses

A boolean is a 1-bit answer to a multi-dimensional question. Here is everything it collapses:

| Dimension a real license has | Boolean's answer | The loss |
|---|---|---|
| **Which action** (display / distribute / reproduce / cache / derive / aggregate) | "commercial = ok" — undifferentiated | CC-BY permits *all* of these with attribution; a vendor display tier may permit display but **prohibit** redistribution. Same `true`, opposite truth. |
| **Under which condition** (attribution rendered? non-commercial purpose? geographic?) | none | CC-BY's permission is *conditional on attribution*. The boolean says "ok" and forgets the string that **must** appear next to the data, the exact thing that makes it ok. |
| **For whom** (assignee: internal user / API consumer / reseller) | everyone, identically | A paid tier grants the *licensee* display rights but forbids *their* onward redistribution. One party's permission is another's prohibition. |
| **With what remedy** if violated | none | ODbL's share-alike, a vendor ToS termination clause — the consequence of breach is part of the license and invisible to a boolean. |
| **Which exact license** produced the verdict | none — `true` is sourceless | Two `true`s from CC0 and from a purchased Bloomberg tier are legally nothing alike. The boolean can't be audited back to its license; SPDX fixes *this half* alone. |

The failure mode this prevents is the **contamination-by-flattening** trap
([`theory-contamination-derived-data-rule.md`](theory-contamination-derived-data-rule.md)): when a
composite series mixes a CC-BY input and a public-domain input, the boolean answer (`true` or `false`)
erases *which* input forced the attribution duty, so the rendered surface either over-attributes
(legally harmless, sloppy) or **drops the required attribution** (a license breach). A policy keeps the
duty attached to its originating input; a boolean cannot.

### 1.3 Two standards, two halves of the answer

The machine-readable rights layer is **two** orthogonal standards, and conflating them is the first
mistake:

- **SPDX** answers *"which license is this?"* — a canonical **identifier** for the license document.
  It is an **id**, not a policy. `CC-BY-4.0` is a name; it does not by itself tell a machine "display
  requires attribution" — a human or a profile has to know what `CC-BY-4.0` *means*.
- **ODRL** answers *"what may I do, under what condition, as whom?"* — an executable **policy** of
  permissions/prohibitions/duties. It is the machine-readable *meaning*.

You want both. SPDX is the cheap, universal, tooling-recognized *label* (every SBOM scanner, every data
catalog, every compliance bot knows `CC-BY-4.0`). ODRL is the precise, enforceable *behavior*. They
attach to the **same node** — the `dcat:Distribution` — via `dct:license` (SPDX) and `odrl:hasPolicy`
(ODRL) respectively (§7).

---

## 2. SPDX license identifiers — the canonical machine-readable license id

### 2.1 What SPDX is and why it is the right id

The SPDX License List ([spdx.org/licenses](https://spdx.org/licenses/)) is a curated registry that
assigns every well-known license a **short identifier** — a stable, case-sensitive string that uniquely
names the license document. The value of using it instead of a free-text `"CC BY 4.0"` /
`"Creative Commons Attribution"` / `"cc-by"` string: **canonicalization**. Free text has dozens of
spellings of the same license; SPDX has exactly one (`CC-BY-4.0`), and a universe of tooling already
recognizes it (SBOM scanners, license-compliance bots, data-catalog software, GitHub's license
detection). When the verdict is "this is CC-BY-4.0," the *machine-readable* way to say that is the SPDX
id, full stop.

### 2.2 The identifiers this product line actually uses

Verified exact strings from the SPDX License List ([spdx.org/licenses](https://spdx.org/licenses/)) —
the data/content licenses that show up in a financial-data catalog:

| License (human name) | **SPDX identifier** | Family | Display-commercial verdict (default) |
|---|---|---|---|
| CC0 1.0 (public-domain dedication) | `CC0-1.0` | GREEN | ✅ commercialOk, no attribution required |
| Creative Commons Attribution 4.0 | `CC-BY-4.0` | GREEN-with-duty | ✅ **IF** attribution rendered |
| Creative Commons Attribution-ShareAlike 4.0 | `CC-BY-SA-4.0` | GREEN-with-duty + viral | ✅ IF attribution + share-alike on derivatives |
| Creative Commons Attribution-NonCommercial 4.0 | `CC-BY-NC-4.0` | RED for commercial | ❌ non-commercial only |
| Open Data Commons PDDL (public domain) | `PDDL-1.0` | GREEN | ✅ commercialOk, no attribution |
| Open Data Commons Attribution License | `ODC-By-1.0` | GREEN-with-duty | ✅ IF attribution |
| Open Data Commons Open Database License | `ODbL-1.0` | GREEN-with-duty + share-alike | ✅ IF attribution + share-alike on derivative DBs |
| Community Data License Agreement – Permissive 2.0 | `CDLA-Permissive-2.0` | GREEN-with-notice | ✅ IF agreement text shared with data |
| Community Data License Agreement – Sharing 1.0 | `CDLA-Sharing-1.0` | GREEN + viral | ✅ IF share-alike |
| Apache 2.0 (occasionally on derived tooling) | `Apache-2.0` | GREEN-with-notice | ✅ IF NOTICE preserved |
| MIT | `MIT` | GREEN-with-notice | ✅ IF notice preserved |

The exact strings `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC-BY-NC-4.0`, `ODbL-1.0`, `PDDL-1.0`,
`ODC-By-1.0`, `Apache-2.0`, `MIT` are confirmed against the SPDX list
([spdx.org/licenses](https://spdx.org/licenses/)); `CDLA-Permissive-2.0` and `CDLA-Sharing-1.0` are on
the list with the Linux Foundation as steward
([spdx.org/licenses/CDLA-Permissive-2.0.html](https://spdx.org/licenses/CDLA-Permissive-2.0.html)),
CDLA-Permissive being deliberately built so that "using the results from analyzed data to create AI and
ML models" carries no share obligation
([linuxfoundation.org press release](https://www.linuxfoundation.org/press/press-release/enabling-easier-collaboration-on-open-data-for-ai-and-ml-with-cdla-permissive-2-0)).

> **Note on the public-domain pair.** `CC0-1.0` and `PDDL-1.0` are *both* "no rights reserved," but they
> are different documents and you must use the id of the one the source actually declares — do not
> "normalize" PDDL to CC0. A US-gov public-domain work (17 USC §105) often has *no* license document at
> all; for that, SPDX provides no perfect id (it is "absence of copyright," not a license). The honest
> encoding is discussed in §2.4.

### 2.3 `LicenseRef-` — the escape hatch for vendor ToS with no SPDX id

A financial-data catalog is full of licenses that are **not** on the SPDX list: Twelve Data's free-tier
ToS, Finnhub's terms, a purchased Bloomberg/Refinitiv display agreement, a bespoke exchange data
agreement. SPDX has a first-class mechanism for exactly this: the **`LicenseRef-` prefix**, a
user-defined license reference for any license not in the public list.

**Exact syntax**, from the SPDX 2.3 license-expression grammar
([spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)):

```abnf
idstring     = 1*(ALPHA / DIGIT / "-" / "." )
license-ref  = ["DocumentRef-"(idstring)":"] "LicenseRef-"(idstring)
```

So the id is `LicenseRef-` followed by an idstring of letters, digits, `-`, and `.` only. Examples the
spec lists verbatim: `LicenseRef-23`, `LicenseRef-MIT-Style-1`, and the cross-document form
`DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2`. Case sensitivity (SPDX 2.x): only the part *after*
`LicenseRef-` is case-insensitive, so `LicenseRef-Name` ≡ `LicenseRef-name`, but `licenseref-name`
(lowercased prefix) is **invalid** ([Using SPDX, license expressions
annex](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)). (SPDX 3.x makes the *whole*
expression case-insensitive — [spec
v3.0.1](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/) — but write canonical
casing anyway.)

**Our convention** for vendor ToS:

```
LicenseRef-TwelveData-Free-ToS          # the free-tier terms
LicenseRef-TwelveData-Pro-Display-2026  # a purchased display tier, year-pinned
LicenseRef-Finnhub-Free-ToS
LicenseRef-Bloomberg-Display-Agreement  # a real signed agreement
LicenseRef-CoinGecko-Demo-ToS           # our actual coingecko-demo path
```

Year-pin the *purchased* ones (`-2026`) because a commercial display tier is a contract that gets
renegotiated; the ToS you encoded may not be the ToS you have next year. A `LicenseRef-` id is a
**pointer**, not the terms — store the actual ToS text/URL and the verdict in the sources-ledger and
let the id resolve to it (§9.3).

### 2.4 The hard case: pure public domain (no license document)

US-government data under **17 USC §105** is *not licensed* — it is **outside copyright**. There is no
license document, so strictly there is no SPDX license id (`CC0-1.0` is a *dedication*, a legal act of
waiving copyright; §105 works never had copyright to waive). Three honest encodings, in order of
preference:

1. **`PDDL-1.0` or `CC0-1.0`** if the publisher itself declares one (e.g. a portal that stamps CC0 on
   its gov data) — use the publisher's declared id.
2. **`LicenseRef-US-Gov-PublicDomain-17USC105`** as a `LicenseRef-` that documents the *reason* it is
   free (no copyright), when the publisher declares nothing. This is more honest than forcing `CC0-1.0`
   onto a work that was never copyrighted.
3. **SPDX `NONE`** — the special identifier meaning "no license is present"
   ([spdx-spec issue #49 / v3 expressions](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/)).
   Use sparingly; `NONE` says "we looked and there is no license," which for §105 is *true* but loses
   the "and that's because it's public domain, which is GREEN" nuance. Prefer the `LicenseRef-` form.

Do **not** use `NOASSERTION` ("we have not determined the license") for data you have *cleared* — that
is the value for an *unverified* fetch path, and it must map to `commercialOk: false` (§9). `NONE` and
`NOASSERTION` may only combine with `AND` in an expression, never `OR`
([spdx-spec v3.0.1](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/)).

### 2.5 SPDX license expressions (when one id isn't enough)

A `dct:license` value can be a **license expression**, not just a single id, using the operators `AND`,
`OR`, `WITH`, `+`. Grammar
([spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)):

```abnf
simple-expression   = license-id / license-id"+" / license-ref
compound-expression = simple-expression
                    / simple-expression "WITH" license-exception-id
                    / compound-expression "AND" compound-expression
                    / compound-expression "OR"  compound-expression
                    / "(" compound-expression ")"
```

Precedence (tightest to loosest): `+ WITH AND OR`. Where this matters for *data*:

- **`AND`** — a composite series built from a CC-BY input **and** a PDDL input is governed by *both*:
  `CC-BY-4.0 AND PDDL-1.0`. (This is the SPDX-id-level shadow of the contamination rule: the *expression*
  records both, the *boolean* would record only the survivor. See §6.)
- **`OR`** — a source dual-licensed "either CC-BY or a commercial tier": `CC-BY-4.0 OR LicenseRef-Vendor-Commercial`.
  The catalog picks the branch it operates under; the expression records the choice was offered.
- **`+`** — "this version or later"; rare for data, common for code (`Apache-2.0+`). Mostly irrelevant
  here.

> **Caution.** An `AND` of two licenses with **conflicting** duties (CC-BY needs attribution; ODbL adds
> share-alike) means you owe *the union of all duties*. SPDX records the conjunction; it does **not**
> resolve the conflict or tell you the most-restrictive result. That resolution is ODRL's job (§6) and
> the contamination rule's job — SPDX alone is necessary but not sufficient for composites.

---

## 3. ODRL — the policy that says *which actions under which conditions*

### 3.1 The ODRL Information Model in one screen

ODRL (Open Digital Rights Language) is a **W3C Recommendation**
([w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/)). Its information model is small and exactly
the shape we need. The classes, with their required/optional properties verbatim from the model spec:

```
Policy (a non-empty group of Permissions and/or Prohibitions and/or Duties)
 ├─ uid          : IRI  (REQUIRED — identifies the Policy)
 ├─ @type        : Set (default) | Offer | Agreement | …
 ├─ profile      : IRI  (optional — the ODRL Profile in use)
 ├─ permission[] : Permission     ┐ at least ONE of
 ├─ prohibition[]: Prohibition    ┤ permission / prohibition /
 └─ obligation[] : Duty           ┘ obligation is required

Permission  (allows an action IF all constraints are satisfied)
 ├─ target      : Asset   (REQUIRED — the thing the rule applies to)
 ├─ action      : Action  (REQUIRED — what is allowed)
 ├─ assigner?   : Party   (the party issuing the rule)
 ├─ assignee?   : Party   (the party receiving the rule)
 ├─ constraint[]: Constraint        (conditions that gate the permission)
 └─ duty[]      : Duty    ◄── THE KEY CONSTRUCT: a pre-condition that MUST be fulfilled

Prohibition (disallows an action IF all constraints are satisfied)
 ├─ target      : Asset   (REQUIRED)
 ├─ action      : Action  (REQUIRED)
 ├─ assigner? / assignee?
 ├─ constraint[]
 └─ remedy[]    : Duty    (a Duty that MUST be fulfilled if the prohibition is infringed)

Duty (the obligation to exercise an action; fulfilled when its constraints are satisfied
      AND its action has been exercised)
 ├─ action      : Action  (REQUIRED)
 ├─ target?     : Asset
 ├─ constraint[]
 └─ consequence[]: Duty   (triggered if THIS duty is left unfulfilled)

Constraint (a boolean expression: leftOperand <operator> rightOperand)
 ├─ leftOperand : LeftOperand   (e.g. odrl:purpose, odrl:dateTime, odrl:recipient)
 ├─ operator    : Operator      (eq, neq, lt, gt, isPartOf, isAnyOf, isNoneOf, …)
 ├─ rightOperand  XOR  rightOperandReference   (MUST be exactly one, never both)
 ├─ unit?       : IRI
 └─ dataType?
```

Verified against [w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/): a `Permission` requires
`target` + `action`; `duty` on a Permission is "a pre-condition that requires fulfillment using the duty
property relationship from the Permission to the Duty… an agreed obligation that MUST be fulfilled" and
"if a Permission has several Duties then all of the Duties MUST be agreed to be fulfilled." A
`Constraint` "MUST have either one rightOperand … or one rightOperandReference" — never both. The
`@context` is `http://www.w3.org/ns/odrl.jsonld`.

### 3.2 The policy subtypes — `Set` vs `Offer` vs `Agreement`

From [w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/):

- **`Set`** (default) — "expresses generic Rules" over an Asset. No party required. Use this to describe
  the **inherent license** of a Distribution ("this CC-BY series, anyone, may display IF attribute"). For
  our catalog's *license metadata*, `Set` is almost always right — the license is a property of the data,
  not a deal with a named counterparty.
- **`Offer`** — requires an `assigner`. "Rules being offered from assigner Parties." Use when the catalog
  *advertises a commercial tier* ("we, the data provider, offer you the right to redistribute IF you pay").
- **`Agreement`** — requires `assigner` **and** `assignee`. "Rules granted from assigner to assignee."
  Use for a **signed paid contract** with a specific enterprise consumer.

The progression `Set → Offer → Agreement` is exactly the v1→paid-tier progression (§8). The
public-domain catalog ships `Set` policies; the day a paying API consumer exists, their grant is an
`Agreement` whose `assignee` is that consumer.

### 3.3 The actions you will actually use

Standard action IRIs from the ODRL vocabulary
([w3.org/TR/odrl-vocab](https://www.w3.org/TR/odrl-vocab/)), with the data-licensing meaning:

| Action | ODRL definition (quoted) | Use for |
|---|---|---|
| `odrl:display` | "To create a static and transient rendition of an Asset" | rendering a price/series on a Lumina surface or a customer's screen |
| `odrl:distribute` | "To supply the Asset to third-parties" | redistribution — the one a paid display tier usually *prohibits* |
| `odrl:reproduce` | "To make duplicate copies the Asset in any material form" | caching the raw series, storing it in our warehouse |
| `odrl:aggregate` | "To use the Asset or parts of it as part of a composite collection" | building a composite/index series from this input |
| `odrl:derive` | "To create a new derivative Asset from this Asset" | computing an analytic (a moving average, a normalized series) |
| `odrl:read` / `odrl:extract` | obtain / extract data | the fetch itself |
| `odrl:attribute` | "To attribute the use of the Asset" | the **duty** action that binds attribution |
| `odrl:commercialize` | (CC profile term) exercise rights for commercial purposes | the action a NonCommercial license **prohibits** |

> **The `commercialUse` / `commercialize` / `purpose` ambiguity — resolve it deliberately.** "No
> commercial use" can be modeled two ways, and the cleaner one wins:
>
> 1. **A Prohibition on `odrl:commercialize`** — the action-based way, matching the historical CC→ODRL
>    profile which maps "CC CommercialUse prohibition" to the `commercialize` action entity name
>    ([ODRL CC Profile](https://www.w3.org/2012/09/odrl/archive/odrl.net/Profiles/CC/SPEC.html)).
> 2. **A Constraint on `odrl:purpose`** — `leftOperand: odrl:purpose, operator: odrl:isNoneOf,
>    rightOperand: <commercial-purpose-IRI>`. `odrl:purpose` is the standard left operand for "a defined
>    purpose for exercising the action" ([w3.org/TR/odrl-vocab](https://www.w3.org/TR/odrl-vocab/)).
>
> **Prefer the `purpose` constraint** for our catalog: it attaches to the *display/distribute*
> permission you already have, says precisely "this permission holds only when purpose ≠ commercial,"
> and an evaluator can check it against a request's stated purpose. The standalone `commercialize`
> prohibition is coarser (it forbids a fuzzy "act commercially" with no obvious target action). Pick
> one and use it consistently — mixing them in the same catalog is the kind of inconsistency the
> red-team negation loop will land on.

### 3.4 The left-operands and operators you will use

From [w3.org/TR/odrl-vocab](https://www.w3.org/TR/odrl-vocab/):

**Left operands:** `odrl:purpose` ("a defined purpose"), `odrl:recipient` ("the party receiving the
result"), `odrl:dateTime` ("the date … of exercising the action"), `odrl:spatial` ("a named geospatial
area"), `odrl:industry` ("a defined industry sector"), `odrl:count` ("numeric count of executions"),
`odrl:elapsedTime`, `odrl:payAmount` ("the amount of a financial payment").

**Operators:** `odrl:eq`, `odrl:neq`, `odrl:lt`, `odrl:lteq`, `odrl:gt`, `odrl:gteq` (relational);
`odrl:isA`, `odrl:isPartOf`, `odrl:hasPart`, `odrl:isAnyOf`, `odrl:isNoneOf` (set-based).

**Logical operators** (for combining constraints in a `LogicalConstraint`): `odrl:and`, `odrl:or`,
`odrl:xone` (exactly one), `odrl:andSequence` (all, in order). Order **must** be preserved in JSON-LD
with `@list` ([w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/)).

---

## 4. The killer feature: the duty-on-permission (what a boolean can't do)

### 4.1 The exact thing a boolean cannot express

CC-BY's whole shape is: *you may display/distribute/reproduce/derive — **on the condition that** you
attribute.* The attribution is not a footnote; it is **the price of the permission**. A boolean
`commercialOk: true` says "display is ok" and has **nowhere to put** "…but only if the attribution
string appears." So a boolean-only system either (a) renders without attribution → **breach of
CC-BY**, or (b) hard-codes "always attribute when source is CC-BY" in application logic, scattering the
license semantics across the codebase where they rot. ODRL puts the condition *in the data*, next to the
permission, as a **Duty on the Permission**.

### 4.2 The pattern, in the model

A `Permission` carries a `duty[]`. The model spec is explicit: the duty is "a pre-condition that
requires fulfillment … an agreed obligation that MUST be fulfilled," and *all* duties on a permission
must be fulfilled for the permission to hold ([w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/)).
So:

```
Permission { action: display, target: <series> }
  duty:
    Duty { action: attribute, target: <the attribution resource / string> }
```

reads as: **display is permitted, conditional on the attribute duty being fulfilled.** No attribution →
duty unfulfilled → permission does not hold → an enforcement engine returns "not permitted." That is the
machine-readable form of "you may display this **if** you render the credit line." A boolean has no slot
for the word "if."

### 4.3 Binding the *actual attribution string* as the obligation

The duty's `target` (or a refinement constraint on it) is where the **literal required credit** lives,
so the rendering surface can pull the exact string from the policy rather than guessing:

```json
"duty": [{
  "action": "attribute",
  "constraint": [{
    "leftOperand": "https://www.w3.org/ns/odrl/2/attributedParty",
    "operator": "eq",
    "rightOperand": "Source: Financial Times via CC BY 4.0"
  }]
}]
```

Now the attribution text is **data**, queryable, renderable, and auditable — not a magic string in a
React component. (The CC→ODRL profile confirms `attribute` is the duty action for CC Attribution and
that ODRL "already covers the semantic of the CC Requirement Attribution with the attribute action
entity name" — [ODRL CC
Profile](https://www.w3.org/2012/09/odrl/archive/odrl.net/Profiles/CC/SPEC.html).)

### 4.4 The remedy on a prohibition (the symmetric construct)

A `Prohibition` carries a `remedy[]` — "an agreed Duty that MUST be fulfilled in case that a Prohibition
has been infringed" ([w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/)). Example from the spec:
prohibit `index`, remedy `anonymize`. For data: prohibit redistribution; if a downstream consumer
redistributes anyway, the remedy might be `delete` (remove all copies) — and even if you never *enforce*
the remedy in code, recording it makes the consequence of breach part of the machine-readable contract.
Most of our v1 prohibitions will have **no** remedy (a free-tier ToS that says "no redistribution" just
means "don't"); add a remedy only when the actual license specifies a consequence.

---

## 5. Worked policies — copy-paste-able JSON-LD

These are complete, valid ODRL 2.2 JSON-LD documents. Context is always
`http://www.w3.org/ns/odrl.jsonld`. The `target` is the Distribution IRI in our DCAT catalog (§7).

### 5.1 A CC-BY series — display/distribute/reproduce permitted **IF attribution**

This is the canonical "the duty does what the boolean can't" example. Source: a CC-BY-4.0 financial
news/data series.

```json
{
  "@context": [
    "http://www.w3.org/ns/odrl.jsonld",
    { "dct": "http://purl.org/dc/terms/" }
  ],
  "@type": "Set",
  "uid": "urn:rights:dist:ft-headlines:ccby",
  "profile": "http://www.w3.org/ns/odrl/2/",
  "permission": [
    {
      "target": "urn:catalog:distribution:ft-headlines:json",
      "action": ["display", "distribute", "reproduce", "aggregate"],
      "duty": [
        {
          "action": "attribute",
          "constraint": [
            {
              "leftOperand": "http://www.w3.org/ns/odrl/2/attributedParty",
              "operator": "eq",
              "rightOperand": "Source: Financial Times — licensed under CC BY 4.0"
            }
          ]
        }
      ]
    }
  ]
}
```

**What this expresses that `commercialOk:true` cannot:** the four allowed actions are *named*; the
permission is *conditional* on the `attribute` duty; and the **exact credit string** is bound as the
obligation's right-operand. A renderer reads the duty, pulls the string, and shows it. An auditor reads
the policy and sees precisely which actions are licensed. The boolean would have said only `true`.

### 5.2 A public-domain series (PDDL / CC0) — display permitted, **no duty**

The all-GREEN v1 case. Note there is *no* duty — public domain imposes no condition. This is where a
boolean genuinely suffices, and the policy is almost trivially short (which is the point of §8: don't
pay ODRL's complexity tax when there's nothing to express).

```json
{
  "@context": "http://www.w3.org/ns/odrl.jsonld",
  "@type": "Set",
  "uid": "urn:rights:dist:treasury-10y:pddl",
  "permission": [
    {
      "target": "urn:catalog:distribution:treasury-10y:json",
      "action": ["display", "distribute", "reproduce", "derive", "aggregate"]
    }
  ]
}
```

`dct:license` on the same Distribution carries `PDDL-1.0` (or `LicenseRef-US-Gov-PublicDomain-17USC105`).
Everything is permitted, unconditionally. The matching `commercialOk` view is `true` (§9).

### 5.3 A RED free-tier vendor series — display **prohibited** (commercial)

The free-tier trap, machine-readable. Twelve Data's free tier is fetchable (we may `read`) but its ToS
does not grant a commercial *display* license, so commercial display is **prohibited** and the
`commercialOk` view is `false`. Two equivalent encodings — pick the `purpose`-constraint one per §3.3:

**Encoding A — purpose constraint (preferred):** permission to display, *constrained* to non-commercial
purpose:

```json
{
  "@context": "http://www.w3.org/ns/odrl.jsonld",
  "@type": "Set",
  "uid": "urn:rights:dist:twelvedata-free:eod",
  "permission": [
    {
      "target": "urn:catalog:distribution:twelvedata-free:eod",
      "action": "read"
    },
    {
      "target": "urn:catalog:distribution:twelvedata-free:eod",
      "action": "display",
      "constraint": [
        {
          "leftOperand": "purpose",
          "operator": "isNoneOf",
          "rightOperand": { "@id": "https://example.com/purpose/CommercialDisplay" }
        }
      ]
    }
  ],
  "prohibition": [
    {
      "target": "urn:catalog:distribution:twelvedata-free:eod",
      "action": "distribute"
    }
  ]
}
```

This says, precisely: *we may `read` it; we may `display` it **only for non-commercial purposes**; we
may **not** `distribute` it at all.* `commercialOk` derives to `false` because the display permission is
gated by a non-commercial purpose constraint and distribution is prohibited (§9). A boolean would have
said `false` and lost *why* — lost that read is fine, that non-commercial display is fine, that the wall
is specifically commercial display + redistribution.

**Encoding B — prohibition on `commercialize` (CC-profile style):**

```json
{
  "@context": "http://www.w3.org/ns/odrl.jsonld",
  "@type": "Set",
  "uid": "urn:rights:dist:twelvedata-free:eod:b",
  "permission": [
    { "target": "urn:catalog:distribution:twelvedata-free:eod", "action": ["read", "display"] }
  ],
  "prohibition": [
    { "target": "urn:catalog:distribution:twelvedata-free:eod", "action": ["commercialize", "distribute"] }
  ]
}
```

### 5.4 A purchased commercial tier — an `Agreement` with a named `assignee`

The paid-tier shape that *only* ODRL can express. A purchased display agreement grants *our enterprise
consumer* (the assignee) the right to display, but **prohibits** their onward redistribution, and the
permission is constrained to the contract window. This is the `Agreement` subtype (both parties named):

```json
{
  "@context": "http://www.w3.org/ns/odrl.jsonld",
  "@type": "Agreement",
  "uid": "urn:rights:agreement:acme-corp:premium-eod:2026",
  "permission": [
    {
      "assigner": "urn:party:our-data-platform",
      "assignee": "urn:party:acme-corp",
      "target": "urn:catalog:distribution:premium-eod:json",
      "action": ["display", "reproduce"],
      "constraint": [
        {
          "leftOperand": "dateTime",
          "operator": "lteq",
          "rightOperand": { "@value": "2026-12-31T23:59:59Z", "@type": "xsd:dateTime" }
        }
      ]
    }
  ],
  "prohibition": [
    {
      "assigner": "urn:party:our-data-platform",
      "assignee": "urn:party:acme-corp",
      "target": "urn:catalog:distribution:premium-eod:json",
      "action": "distribute",
      "remedy": [
        { "action": "delete", "target": "urn:catalog:distribution:premium-eod:json" }
      ]
    }
  ]
}
```

**What no boolean can touch:** the grant is *to a specific party* (`acme-corp`), the display right
*expires* on a date, redistribution is *prohibited* with a `delete` *remedy* on breach. This is the
entire reason the rights layer must eventually be ODRL: a multi-tenant paid data product is, definitionally,
a per-assignee action-grant matrix, and a single boolean per series cannot represent "permitted for A,
prohibited for B."

### 5.5 An ODbL share-alike series — duty cascades to derivatives

ODbL permits everything *if* you attribute *and* keep derivative databases under ODbL (share-alike). The
share-alike is a duty on the `derive` permission:

```json
{
  "@context": "http://www.w3.org/ns/odrl.jsonld",
  "@type": "Set",
  "uid": "urn:rights:dist:osm-econ:odbl",
  "permission": [
    {
      "target": "urn:catalog:distribution:osm-econ:json",
      "action": "display",
      "duty": [{ "action": "attribute",
                 "constraint": [{ "leftOperand": "http://www.w3.org/ns/odrl/2/attributedParty",
                                  "operator": "eq", "rightOperand": "© OpenStreetMap contributors, ODbL 1.0" }] }]
    },
    {
      "target": "urn:catalog:distribution:osm-econ:json",
      "action": "derive",
      "duty": [
        { "action": "attribute" },
        { "action": "distribute",
          "constraint": [{ "leftOperand": "http://www.w3.org/ns/odrl/2/license",
                           "operator": "eq", "rightOperand": "ODbL-1.0" }] }
      ]
    }
  ]
}
```

The `derive` permission carries a *second* duty that says, in effect, "if you distribute the derivative,
it must itself be ODbL" — share-alike as a machine-readable obligation. This is why ODbL composites are
dangerous (the contamination rule, §6): the viral duty rides along.

---

## 6. Composites, contamination, and the policy merge

The hardest real case: a composite series built from inputs with *different* licenses. The
contamination rule ([`theory-contamination-derived-data-rule.md`](theory-contamination-derived-data-rule.md))
says the composite inherits the **most-restrictive** input's constraints. Here is how that becomes
machine-readable instead of a hand-wave:

**SPDX side:** the composite's `dct:license` is the **`AND` of all input ids** —
`CC-BY-4.0 AND PDDL-1.0`. The expression *records* both, where a merged boolean would record only the
survivor. (Necessary, not sufficient — `AND` records the conjunction but doesn't compute the result.)

**ODRL side:** the composite's policy is the **union of all input duties and prohibitions**, with the
permissions **intersected** (you may only do what *every* input permits). Merge algorithm:

```
def merge_policies(input_policies: list[Policy]) -> Policy:
    # Permissions: a composite may do action X only if EVERY input permits X.
    permitted_actions = set.intersection(*(p.permitted_action_set() for p in input_policies))

    # Duties: the composite owes the UNION of all inputs' duties (attribution from each
    # CC-BY/ODbL input survives — you must credit every source that required it).
    all_duties = union(p.duties() for p in input_policies)

    # Prohibitions: the composite is forbidden anything ANY input forbids (the wall is the
    # union — one RED input makes the composite RED for that action).
    all_prohibitions = union(p.prohibitions() for p in input_policies)

    return Policy(permission=[Permission(a, duty=duties_for(a, all_duties))
                              for a in permitted_actions],
                  prohibition=list(all_prohibitions))
```

The decisive property: **attribution duties do not collapse.** A composite of three CC-BY inputs owes
*three* attribution strings, each preserved as a separate duty with its own `attributedParty`. The
boolean `true` would have rendered one (or zero) credit lines and breached the other two licenses. This
is the single strongest argument for the policy layer over the boolean (it is exactly negation-goal
**F2**'s "composite inherits a RED input yet claims GREEN" — the policy *cannot* claim GREEN because the
RED input's prohibition is in the union).

---

## 7. Linking it to the catalog — `dct:license` + `odrl:hasPolicy` on the Distribution

### 7.1 Both attach to the `dcat:Distribution`, not the Dataset

The single most important placement decision, established in
[`theory-dcat-catalog-modeling.md`](theory-dcat-catalog-modeling.md): **license and rights hang on the
`dcat:Distribution`**, because the license follows the *fetch path*, and different distributions of the
same dataset can have different licenses (the 10Y yield from treasury.gov vs. from Yahoo's chart API are
two Distributions of one Dataset, GREEN and RED respectively). DCAT v3 confirms the properties live on
`dcat:Resource` (the parent of both Dataset and Distribution), so they are *available* on Distribution,
and W3C DXWG issue #104 is precisely the debate that settled license/rights belonging at the
distribution level, inheritable by but overridable from the dataset
([w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/);
[w3c/dxwg#104](https://github.com/w3c/dxwg/issues/104)). DCAT-AP 3.0 makes it a hard recommendation:
rights belong at "the most concrete level of sharing, i.e. Distribution or Data Service."

The two properties, from [w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/):

- **`dct:license`** — "A legal document under which the resource is made available." Range
  `dct:LicenseDocument`. **Carry the SPDX id here** (as the document's identifier / URI).
- **`odrl:hasPolicy`** — "An ODRL conformant policy expressing the rights associated with the resource."
  Range `odrl:Policy`. **Carry the ODRL policy here** (or a reference to it).

Also available and worth using: `dct:rights` ("a statement concerning all rights not addressed with
license or accessRights") and `dct:accessRights` ("information about who can access the resource").

### 7.2 The combined Distribution node (JSON-LD)

A single Distribution carrying *both* the SPDX id (cheap label) and the ODRL policy (precise behavior):

```json
{
  "@context": [
    "http://www.w3.org/ns/dcat.jsonld",
    {
      "dct":  "http://purl.org/dc/terms/",
      "odrl": "http://www.w3.org/ns/odrl/2/",
      "spdx": "http://spdx.org/rdf/terms#"
    }
  ],
  "@type": "dcat:Distribution",
  "@id": "urn:catalog:distribution:ft-headlines:json",
  "dcat:accessURL": "https://api.our-platform.example/series/ft-headlines",
  "dcat:mediaType": "application/json",

  "dct:license": { "@id": "https://spdx.org/licenses/CC-BY-4.0" },
  "dct:rights":  "Displayed under CC BY 4.0; attribution required (see policy).",

  "odrl:hasPolicy": { "@id": "urn:rights:dist:ft-headlines:ccby" }
}
```

The `odrl:hasPolicy` value is the `uid` of the policy from §5.1 — store the policy once, reference it by
IRI from every Distribution it governs (a CC-BY policy template is reused across many distributions). The
`dct:license` points at the SPDX id; SPDX publishes a stable URI per license
(`https://spdx.org/licenses/CC-BY-4.0`) that is a perfectly good `dct:LicenseDocument` IRI.

### 7.3 The `Provenance` stamp becomes a *view* over this

Lumina's `Provenance{ commercialOk }` does not vanish — it is re-derived from the Distribution's policy
(§9) and travels on the API payload as before, so every existing consumer keeps working. The catalog is
the source of truth (SPDX id + ODRL policy on the Distribution); the boolean on the wire is a computed
projection.

---

## 8. When ODRL earns its complexity (and when the boolean+SPDX suffices)

This is the section that keeps the skill honest. ODRL is **not free** — it is RDF, it needs a profile,
it needs an evaluator to *enforce* (ODRL "lacks built-in enforcement capabilities," the explicit
motivation for ODRE — [arxiv 2409.17602](https://arxiv.org/abs/2409.17602)), and an over-engineered
rights layer on an all-public-domain catalog is exactly the "senior vocabulary covering junior thinking"
the negation loop hunts. The decision is a function of **what there is to express**:

| Situation | What to ship | Why |
|---|---|---|
| **v1: all-GREEN public-domain catalog** (treasury.gov, FRED-public, SEC EDGAR, GDELT) | **boolean + SPDX id** | One action (display), no condition, one party (everyone). A `Set` policy would be `{permission: [{action: display}]}` — pure ceremony. The SPDX id (`PDDL-1.0`) + `commercialOk: true` IS the whole truth. **Do not write ODRL here.** |
| **v1.5: GREEN-with-attribution** (CC-BY, ODC-By, CDLA) | **SPDX id + a minimal ODRL policy with the attribution duty** | The boolean *cannot* carry the attribution string, and that string is legally mandatory. This is the first point ODRL earns its keep — the duty (§4) is the payload. |
| **v2: a paid commercial tier exists** (any per-assignee, per-action grant) | **full ODRL** (`Offer`/`Agreement`, prohibitions, constraints, remedies) | "permitted for paying consumer A, prohibited for free user B" is *definitionally* not a per-series boolean. The action-grant matrix IS an ODRL policy. |
| **v2+: API consumers, sub-licensing, metered/time-boxed grants** | **ODRL + an evaluator** (ODRE / ODRL-Evaluator, §10) | Now you must *enforce*, not just describe — check a request's purpose/recipient/dateTime against constraints at access time. |

**The trigger to add ODRL is the existence of an action-grant matrix** — the moment "what you may do"
differs by action, condition, or party. Until then, `boolean + SPDX id` is not a shortcut; it is the
**correct** engineering (the data has nothing more to say, so the model shouldn't either). Shipping ODRL
on a public-domain catalog is the inverse failure of shipping a boolean on a paid tier — both are
mis-matching the model to the data's actual complexity.

> **The two-way honesty test.** (a) *Under-modeled:* are you about to put a paid-tier action-grant
> behind a single boolean? → you will silently lose a prohibition; upgrade to ODRL. (b) *Over-modeled:*
> are you writing a 40-line `Agreement` for a treasury.gov series anyone may do anything with? → delete
> it; ship `PDDL-1.0` + `true`.

---

## 9. The boolean as a derived view (keeping the gate alive)

The `commercialOk` boolean is **not deleted** — it is *computed* from the policy, so the existing gate,
the `precheck-licensing` hook, and `/sources-lint` keep working unchanged while the truth underneath
gets richer. The derivation:

```python
def commercial_ok(policy: Policy, license_id: str, ledger: SourcesLedger) -> bool:
    """Derive the Lumina commercialOk boolean from the machine-readable rights.
    Conservative: any doubt -> False (matches the rule: silence/ambiguity = RED)."""

    # 1) SPDX id must be a GREEN family in the ledger (the fetch-path check).
    if not ledger.is_green(license_id):
        return False  # free-tier / unknown / NOASSERTION -> RED

    # 2) The policy must PERMIT commercial display with no blocking constraint/prohibition.
    display = policy.permission_for("display")
    if display is None:
        return False
    # A non-commercial purpose constraint blocks commercial display.
    if display.has_constraint(left="purpose", forbids="CommercialDisplay"):
        return False
    if policy.prohibits("display") or policy.prohibits("commercialize"):
        return False

    # 3) Attribution duty does NOT make it False -- it makes display conditional.
    #    commercialOk stays True, and the REQUIRED attribution travels alongside.
    return True


def required_attribution(policy: Policy) -> list[str]:
    """The credit strings the surface MUST render. Empty for public domain."""
    return [d.attributed_party_string()
            for perm in policy.permissions
            for d in perm.duties
            if d.action == "attribute"]
```

Three properties this gives you that the bare boolean never had:

1. **`commercialOk` is now auditable** — it traces to an SPDX id (ledger-checked) *and* a policy, not a
   sourceless `true`. `/sources-lint` can verify the id has a GREEN ledger row AND the policy permits
   display, catching a `true` that the ledger blesses but the policy contradicts.
2. **The attribution string ships with the verdict** — `required_attribution()` returns exactly the
   credit lines the renderer must show. The boolean never carried these; the surface guessed.
3. **`NOASSERTION` is honest** — an unverified fetch path gets `dct:license: NOASSERTION`, which
   `is_green()` returns `False` for, so `commercialOk: false`. The "we haven't checked" state is
   representable instead of defaulting silently.

### 9.3 The sources-ledger becomes the SPDX↔verdict resolver

The existing `sources-ledger.md` (GREEN/RED rows per fetch path) gains one column: the **SPDX id** for
each row. Now the ledger is the lookup table that turns a fetch path into `(spdx_id, green?)`, the
`LicenseRef-` ids resolve to their actual ToS text/URL there, and the ODRL policy template per license
family is named there too. The ledger stops being prose and becomes a small structured registry — the
exact upgrade the rights layer needs to be queryable.

---

## 10. Enforcement — when descriptions must become decisions

Encoding rights is description; a paid tier eventually needs **enforcement** (does *this* request, by
*this* consumer, for *this* purpose, satisfy the policy?). ODRL deliberately stops at description —
"it lacks an enforcement specification" ([arxiv 2409.17602](https://arxiv.org/abs/2409.17602)) — so you
add an evaluator. Two real, Apache-2.0 options, both grounded:

- **ODRE (Open Digital Rights Enforcement)** — an enforcement *algorithm* + two implementations,
  **pyodre** (Python: interpreted=Python, templated=Jinja2) and **odre-java** (SPARQL + Freemarker),
  both Apache-2.0, sub-30ms over 24 test policies
  ([arxiv 2409.17602](https://arxiv.org/abs/2409.17602)). Its model: reduce the policy (inject live
  values for operands like `dateTime`), transform constraints into an interpreted language, evaluate
  true/false, and on success check the action is supported and perform it. **pyodre fits our Python
  stack** — it is the natural enforcement engine for the FastAPI data service.
- **ODRL-Evaluator** (SolidLabResearch) — TypeScript, npm `odrl-evaluator`, built on the EYE reasoner
  (N3 rules). It takes `(Policy, Request, state-of-the-world)` and emits a **Compliance Report** stating,
  per rule, whether it is active and *why* via its constraints' satisfaction
  ([github.com/SolidLabResearch/ODRL-Evaluator](https://github.com/SolidLabResearch/ODRL-Evaluator)).

The Compliance Report model is the vocabulary you log for audit
([github.com/SolidLabResearch/ODRL-Compliance-Report-Model](https://github.com/SolidLabResearch/ODRL-Compliance-Report-Model)):
classes `PolicyReport` / `RuleReport` / `ConstraintReport`; state properties `activationState`
(values **Active** / **Inactive**), `satisfactionState` (**Satisfied** / **Unsatisfied**),
`performanceState` (Performed / Unperformed / Unknown), `deonticState` (fulfilled / violated / not-set),
`attemptedState`. A rule is **Active** iff all its premises are satisfied
([w3c/odrl formal-semantics](https://github.com/w3c/odrl/blob/master/formal-semantics/Compliance%20checking%20ODRL%20policies.md)).
This is exactly what you want for a paid data API: a request comes in, the evaluator says "permission
Active / Inactive, here is the constraint that failed," and you allow or 403 with a reason.

> **Scale + layer placement.** Enforcement evaluation is on the *request path* of the data API — keep it
> fast (pyodre's sub-30ms is the target) and **cache the policy→compiled-rule once** rather than
> re-parsing RDF per request. The heavy *authoring* of policies (LLM-assisted, §11) and the *catalog
> ingest* run off-request on the worker, never in the serverless/request hot path — the same
> compute-once-serve-many discipline the rest of the platform follows.

---

## 11. Authoring policies at scale (don't hand-write 10,000 of them)

A catalog of thousands of distributions needs thousands of policies. You do **not** hand-write them; you
**template by license family** and instantiate:

```python
# One template per license family; instantiate per Distribution. Most of the catalog is
# 5-10 families (PDDL/CC0 public-domain, CC-BY, CC-BY-SA, ODbL, CDLA, and the LicenseRef- vendors).
def policy_for(distribution_iri: str, license_id: str, attribution: str | None) -> dict:
    base = {"@context": "http://www.w3.org/ns/odrl.jsonld", "@type": "Set",
            "uid": f"urn:rights:{distribution_iri}"}
    if license_id in {"PDDL-1.0", "CC0-1.0"}:                       # public domain
        base["permission"] = [{"target": distribution_iri,
                               "action": ["display","distribute","reproduce","derive","aggregate"]}]
    elif license_id in {"CC-BY-4.0", "ODC-By-1.0"}:                 # attribution-only
        base["permission"] = [{"target": distribution_iri,
                               "action": ["display","distribute","reproduce","aggregate"],
                               "duty": [_attribute(attribution)]}]
    elif license_id.startswith("LicenseRef-") and "Free-ToS" in license_id:  # RED free tier
        base["permission"]  = [{"target": distribution_iri, "action": "read"}]
        base["prohibition"] = [{"target": distribution_iri, "action": ["display","distribute"]}]
    # ... CC-BY-SA / ODbL (share-alike), Agreement templates for paid tiers ...
    return base

def _attribute(s: str) -> dict:
    return {"action": "attribute",
            "constraint": [{"leftOperand": "http://www.w3.org/ns/odrl/2/attributedParty",
                            "operator": "eq", "rightOperand": s}]}
```

For the **long tail** of bespoke vendor ToS (where there is no clean family), the
*instructions→ODRL* approach is now a documented technique: feed the ODRL ontology + its documentation
to an LLM as the prompt context and generate the policy from the ToS text, reporting up to 91.95%
accuracy on a 12-use-case benchmark ([From Instructions to ODRL Usage Policies, GPT-4 ontology-guided —
arxiv 2506.03301](https://arxiv.org/abs/2506.03301)). **Treat LLM output as a draft** — validate it
against the ODRL SHACL shapes and a human review before it governs a paid grant; an LLM mis-reading a
ToS clause is exactly negation-goal F2 (a mis-licensed series) waiting to happen.

---

## 12. Pitfalls (each maps to a negation goal)

| Pitfall | Why it's wrong | Negation goal |
|---|---|---|
| Free-text license string (`"cc by"`, `"Creative Commons"`) instead of the SPDX id | not canonical, not tooling-recognized, ambiguous; defeats the whole point of a *machine-readable* id | Q5 (vocabulary with no substance) |
| ODRL on an all-public-domain catalog | over-modeling; a `{permission:[{action:display}]}` `Set` is pure ceremony where a boolean is the whole truth | Q5 / over-engineering |
| Boolean on a paid action-grant tier | under-modeling; silently loses the prohibition ("permitted for A, prohibited for B" can't be one bool) | F2 (mis-licensed) |
| Attribution as application logic, not a Duty in the policy | license semantics scattered in code, rot, and a dropped credit line = breach | F2 |
| Merging a composite's policies by taking the *survivor* boolean | drops the other inputs' attribution duties → under-attributes → breach; composite claims GREEN over a RED input | F2 (contamination) |
| Putting `dct:license` on the Dataset, not the Distribution | the license follows the *fetch path*; two Distributions of one Dataset differ (treasury.gov GREEN vs Yahoo RED) | F2 |
| Using `NOASSERTION` for a *cleared* source, or omitting it for an *unverified* one | `NOASSERTION` means "not determined" → must derive `commercialOk:false`; using it wrong corrupts the gate | F1/F2 |
| `LicenseRef-` for a license that *has* an SPDX id | needless non-standard id; use the canonical `CC-BY-4.0`, reserve `LicenseRef-` for genuine non-list licenses (vendor ToS) | Q5 |
| Enforcing ODRL by re-parsing RDF per request | RDF parse on the hot path; compile policy→rules once, cache, evaluate fast (pyodre sub-30ms target) | Q2 (scale) |
| Trusting LLM-generated ODRL without SHACL + human review | an LLM mis-read of a ToS clause governs a paid grant = a license breach shipped | F2 |

---

## 13. The minimal adoption path (what to actually do, in order)

1. **Now (v1):** add the **SPDX id** to every sources-ledger row and to `dct:license` on each
   Distribution. Keep `commercialOk` exactly as is. *This is a label upgrade, zero behavior change, and
   it makes every verdict auditable back to a canonical license id.* Cheapest possible win.
2. **v1.5 (first CC-BY/ODC-By source):** add a **minimal ODRL `Set` policy with the attribution duty**
   for attribution-required sources only, via the `policy_for()` template (§11). Derive
   `required_attribution()` and render it. Now the mandatory credit string lives in data, not code.
3. **v2 (first paying consumer):** introduce `Offer`/`Agreement` policies with per-assignee permissions,
   prohibitions, and constraints; flip `commercialOk` to the *derived view* (§9). The action-grant matrix
   now exists, so ODRL now earns its complexity.
4. **v2+ (enforcement needed):** wire **pyodre** as the request-path evaluator; log Compliance Reports
   for audit. Cache compiled policies; keep RDF parsing off the hot path.

Do not skip ahead. Each step is triggered by *real complexity arriving in the data*, not by wanting the
fancier model. The discipline — boolean+SPDX is the floor and often the correct ceiling; ODRL is added
exactly when an action-grant matrix exists — is the whole point.

---

## Sources

**Primary specs (read these):**
- ODRL Information Model 2.2 (W3C Rec) — Policy/Permission/Prohibition/Duty/Constraint, the duty-on-permission and remedy-on-prohibition patterns, `@context`: [w3.org/TR/odrl-model](https://www.w3.org/TR/odrl-model/)
- ODRL Vocabulary & Expression 2.2 — action IRIs (`display`/`distribute`/`reproduce`/`attribute`/`commercialize`/…), left operands (`purpose`/`recipient`/`dateTime`), operators (`eq`/`isNoneOf`/…): [w3.org/TR/odrl-vocab](https://www.w3.org/TR/odrl-vocab/)
- ODRL Creative Commons Profile — the CC element → ODRL action/duty/constraint mapping (attribution=`attribute`, NC=`commercialize`/NonCommercialUse, ShareAlike): [w3.org/2012/09/odrl/.../CC/SPEC.html](https://www.w3.org/2012/09/odrl/archive/odrl.net/Profiles/CC/SPEC.html)
- SPDX License List — exact identifiers (`CC0-1.0`, `CC-BY-4.0`, `ODbL-1.0`, `PDDL-1.0`, `ODC-By-1.0`, `CDLA-Permissive-2.0`, …): [spdx.org/licenses](https://spdx.org/licenses/)
- SPDX license-expression grammar — `idstring`, `LicenseRef-`/`DocumentRef-` ABNF, `AND`/`OR`/`WITH`/`+`, `NONE`/`NOASSERTION`: [spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/), [v3.0.1](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/)
- DCAT v3 (W3C Rec) — `dct:license`/`dct:rights`/`dct:accessRights`/`odrl:hasPolicy` on `dcat:Resource`, license-on-Distribution: [w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)
- W3C DXWG issue #104 — the license-on-Distribution-vs-Dataset debate/resolution: [github.com/w3c/dxwg/issues/104](https://github.com/w3c/dxwg/issues/104)

**Enforcement + authoring (read when you reach v2):**
- ODRE: Open Digital Rights Enforcement Framework (pyodre/odre-java, Apache-2.0, ODRL "lacks enforcement"): [arxiv.org/abs/2409.17602](https://arxiv.org/abs/2409.17602)
- ODRL-Evaluator (TypeScript/EYE reasoner, Compliance Report): [github.com/SolidLabResearch/ODRL-Evaluator](https://github.com/SolidLabResearch/ODRL-Evaluator)
- ODRL Compliance Report Model (PolicyReport/RuleReport/ConstraintReport, activationState/satisfactionState): [github.com/SolidLabResearch/ODRL-Compliance-Report-Model](https://github.com/SolidLabResearch/ODRL-Compliance-Report-Model)
- ODRL Formal Semantics — rule "Active iff all premises satisfied": [w3c/odrl formal-semantics](https://github.com/w3c/odrl/blob/master/formal-semantics/Compliance%20checking%20ODRL%20policies.md)
- From Instructions to ODRL Usage Policies (GPT-4, ontology-guided, 91.95%, 12 use cases): [arxiv.org/abs/2506.03301](https://arxiv.org/abs/2506.03301)
- CDLA-Permissive-2.0 (Linux Foundation, AI/ML-friendly): [spdx.org/licenses/CDLA-Permissive-2.0.html](https://spdx.org/licenses/CDLA-Permissive-2.0.html), [linuxfoundation.org press release](https://www.linuxfoundation.org/press/press-release/enabling-easier-collaboration-on-open-data-for-ai-and-ml-with-cdla-permissive-2-0)
