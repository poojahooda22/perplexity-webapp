# theory-open-data-licenses

> **Scope.** The open-data license *landscape* a provenance classifier must recognize, and the exact
> rule each license imposes. This is the **"what does this license actually require"** reference for the
> JPM-Markets re-engineering data-analytics product line (a **NEW Python/FastAPI/data-engineering
> stack**, *not* Lumina). It covers the Creative Commons 4.0 family, the Open Data Commons family, US
> federal public domain (17 USC §105), the EU `sui generis` database right that ODC exists to address,
> the **SPDX** machine identifiers that let us store a verdict per fetch path, and the **share-alike
> viral trap** that is the single most expensive licensing mistake a proprietary data product can make.
>
> **The one sentence that governs everything below.** The license attaches to the **fetch path**, not
> to the concept: the same 10-year Treasury yield is public-domain GREEN from `treasury.gov` and
> licensed-RED from a vendor's chart API. So a classifier reasons from *where a series was fetched and
> under what terms it was offered* — never from the data's *subject*. This doc is the catalogue of terms
> the classifier must be able to read off a source page and map to a verdict.

---

## 0. How to read this doc (the verdict ladder)

Everything here resolves to a four-rung ladder that the data product stamps onto every series as a
`Provenance.commercialOk` plus a human-readable license id (SPDX). Memorise the ladder; the rest of the
doc earns each rung:

| Rung | License class | `commercialOk` | Display obligation | One-line reason |
|---|---|---|---|---|
| **GREEN-unconditional** | CC0-1.0 · PDDL-1.0 · US-PD (17 USC §105) | `true` | none (cite as courtesy) | All rights waived / never had copyright |
| **GREEN-with-attribution** | CC-BY-4.0 · ODC-By-1.0 | `true` | **must render TASL attribution** on the surface | Commercial use allowed *iff* you credit |
| **YELLOW / avoid** | CC-BY-SA-4.0 · ODbL-1.0 | `true` for a *Produced Work*, but **viral on a Derivative Database** | attribution **+ share-alike on derivative DBs** | Copyleft: a derived *database* must be re-opened |
| **RED** | any `…-NC-…` · "all rights reserved" · silent/ambiguous ToS · free API tier | `false` | not displayable commercially | No commercial-display grant exists |

> The default for an *unknown* fetch path is **RED**. Silence is not permission. A free API tier is not
> a display license. "A competitor shows it" is not a license. This conservative default is the rule the
> rest of the doc is built to let you *escape* — but only with a cited grant.

---

## 1. Why data needs its own licenses at all — copyright vs the database right

Before the licenses, the **rights**. A financial dataset can be encumbered by *two completely different*
legal monopolies, and a classifier that only thinks about "copyright" will mis-clear half the world's
data:

### 1.1 Copyright (and "neighbouring/related rights")

Copyright protects **original creative expression**. Raw facts are **not** copyrightable — in the US,
*Feist Publications v. Rural Telephone* (1991) held that a telephone white-pages listing lacked the
"modicum of creativity" copyright requires, so the bare facts (names, numbers) were free to copy. A bare
list of closing prices is, on the same logic, *facts* — not protected by copyright. This is why you
cannot license your way out of someone fetching a number; the protection, where it exists, is elsewhere.

### 1.2 The `sui generis` database right (the part that bites data)

The European Union created a **separate** right — the **`sui generis` database right** — precisely
because copyright fails to protect the *investment* in a database of facts. From Directive 96/9/EC of 11
March 1996 on the legal protection of databases:

> "Member States shall provide for a right for the maker of a database which shows that there has been
> qualitatively and/or quantitatively a **substantial investment in either the obtaining, verification
> or presentation of the contents** to prevent **extraction and/or re-utilization** of the whole or of a
> substantial part … of the contents of that database." — Directive 96/9/EC, Art. 7(1)
> (per [EUR-Lex consolidated text](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:01996L0009-20190606)
> and the [WIPO Lex copy](https://www.wipo.int/wipolex/en/text/126788)).

Key properties a classifier must internalise:

- It protects the **collection** (the investment in assembling/verifying), even when the **individual
  facts are not copyrightable**. So "these are just facts" does **not** clear a *database* of them in the
  EU.
- Term: **15 years** from completion, and — the trap — **renewable on each substantial new investment**.
  A continuously-maintained market-data feed can therefore enjoy a *perpetually-refreshing* 15-year
  right because every substantial update restarts the clock
  ([Directive Art. 10](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:01996L0009-20190606);
  search summary above).
- It is **EU/UK/EEA** law. The US has **no** `sui generis` database right (post-*Feist*). So the *same
  raw factual dataset* can be far freer to redistribute when sourced under US law than under EU law — a
  jurisdiction dimension the classifier should record alongside the license.

**Why this matters for license design.** Creative Commons licenses (≤ v3.0) were written for *creative
works* and were ambiguous about whether they even reached database rights. So Open Data Commons built a
parallel family that licenses the **database right explicitly**. CC fixed this in **4.0** by pulling
"Sui Generis Database Rights" into the license's scope (see §2.5). The upshot:

| Right at stake | Licensed by CC ≤3.0? | Licensed by CC 4.0? | Licensed by ODC family? |
|---|---|---|---|
| Copyright + neighbouring rights | yes | yes | partial (ODC defers to CC for these) |
| `sui generis` database right | **ambiguous → no** | **yes (explicit)** | **yes (the whole point)** |

> **Classifier rule of thumb.** For a *database/feed* (rows of facts), prefer to see an **ODC** license
> or a **CC 4.0** license. A CC **2.x/3.0** license on a *database* is a yellow flag: it may not have
> licensed the database right at all, leaving an EU-law gap.

This is also the precise reason Creative Commons itself **recommends against using CC licenses other
than CC0 for data**: per the Open Data Commons FAQ, *"[Creative Commons] recommended against using their
licenses (other than CC0) for data and databases"* because data carries *"additional IP rights, such as
the database right"* and "a high level of reuse" unlike ordinary content
([opendatacommons.org/faq/licenses](https://opendatacommons.org/faq/licenses/)).

---

## 2. The Creative Commons 4.0 family

The CC 4.0 International suite is **four** licenses built from three composable elements (BY, SA, NC) on
top of the unconditional CC0 dedication. Each is identified by an SPDX id (see §6). The classifier must
recognise all four plus CC0.

### 2.1 CC0 1.0 — "No Rights Reserved" (= public domain, **GREEN-unconditional**)

CC0 is **not a license — it is a waiver/dedication**. The affirmer renounces every right they hold:

> "Affirmer hereby overtly, fully, permanently, irrevocably and unconditionally **waives, abandons, and
> surrenders all of Affirmer's Copyright and Related Rights** … in all territories worldwide … for the
> maximum duration provided by applicable law or treaty."
> — [CC0 1.0 legalcode §2](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en)

Three properties a classifier must encode:

1. **It explicitly waives the database right.** CC0's "Copyright and Related Rights" list names
   *"database rights (such as those arising under Directive 96/9/EC …)"* — so CC0 clears **both** the
   copyright and the EU `sui generis` right. This is what makes CC0 the *correct* public-domain tool for
   data, where bare CC-BY (content-only on ≤3.0) was not.
2. **No attribution is required.** CC0 contains *no* attribution clause. You may use the data with **zero
   credit**. (Citing anyway is good scientific/engineering hygiene and the
   [Turing Way](https://book.the-turing-way.org/reproducible-research/licensing/licensing-data) calls
   for relying on *"norms such as good citation practices"* — but it is a **norm, not a legal
   obligation**. Do not let a classifier *require* attribution for CC0.)
3. **Fallback license.** If the waiver is "judged legally invalid or ineffective", CC0 grants a
   *"royalty-free, non transferable, non sublicensable, non exclusive, irrevocable and unconditional
   license"* for any purpose — so even in a jurisdiction that won't honour an outright waiver, the data
   is still freely usable. ([CC0 §3](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en).)
4. **No warranties** — "as-is", no warranty of title/non-infringement (§4). This is true of *every*
   open license below; a GREEN verdict never means "guaranteed correct", only "freely displayable". (The
   product's *"never invent a finance number"* discipline is orthogonal: GREEN-but-wrong is still wrong.)

> **Verdict:** `commercialOk: true`, attribution **not** required. The cleanest possible source.

### 2.2 CC-BY 4.0 — Attribution (= **GREEN-with-rendered-attribution**)

Commercial use is **fully permitted** under CC-BY 4.0 — the *only* condition is that you **attribute**.
This is the workhorse "free but credit me" license, and the one that most often clears a useful data
feed for commercial display. The exact obligation lives in **Section 3(a)**:

> When You Share the Licensed Material, You must, *"if supplied by the Licensor with the Licensed
> Material"*, **retain**:
> - "**identification of the creator(s)** of the Licensed Material and any others designated to receive
>   attribution";
> - "a **copyright notice**";
> - "a **notice that refers to this Public License**";
> - "a **notice that refers to the disclaimer of warranties**";
> - "a **URI or hyperlink to the Licensed Material** to the extent reasonably practicable";
>
> AND you must **indicate if You modified** the Licensed Material and **retain an indication of any
> previous modifications**; AND **indicate** the material is licensed under CC-BY-4.0 *"and include the
> text of, or the URI or hyperlink to, this Public License."*
> — [CC-BY-4.0 legalcode §3(a)(1)–(2)](https://creativecommons.org/licenses/by/4.0/legalcode.en)

Two clauses make CC-BY *practical* for a UI surface (these are the ones a build will lean on):

- **"Any reasonable manner" flexibility.** *"You may satisfy the conditions in Section 3(a)(1) in any
  reasonable manner based on the medium, means, and context in which You Share the Licensed Material."*
  → On a dense chart you are **not** required to print four lines of notice on the canvas; a credible,
  reasonable placement (a footnote, an "ⓘ Sources" affordance) is acceptable.
- **The separate-attribution-page allowance.** *"For example, it may be reasonable to satisfy the
  conditions by providing a URI or hyperlink to a resource that includes the required information."*
  → You may host **one canonical attribution/sources page** and link every CC-BY series to it, rather
  than crowding the chart. **This is the pattern the data product should standardise on.**

> **Verdict:** `commercialOk: true` **provided** the surface renders TASL attribution (§4) — directly or
> via a linked sources page — and indicates any modifications. Missing attribution = a **license breach**
> even though commercial use itself was granted.

### 2.3 CC-BY-SA 4.0 — Attribution-ShareAlike (= **YELLOW / copyleft / avoid in the database**)

CC-BY-SA adds the **ShareAlike** element on top of attribution. Commercial use is *allowed*, attribution
is required **and** — the trap — any **Adapted Material** must be released under the **same (or a
BY-SA-compatible) license**. From **Section 3(b)**:

> - "The **Adapter's License You apply must be a Creative Commons license with the same License
>   Elements**, this version or later, or a BY-SA Compatible License."
> - "You must **include the text of, or the URI or hyperlink to, the Adapter's License** You apply."
> - "You may **not offer or impose any additional or different terms** … or apply any **Effective
>   Technological Measures** to, Adapted Material that restrict exercise of the rights granted under the
>   Adapter's License."
> — [CC-BY-SA-4.0 legalcode §3(b)](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)

The database-right interaction is the dangerous part for a data product. CC-BY-SA **Section 4** states
that if you include a substantial portion of a BY-SA database's *contents* in a database **in which you
have Sui Generis Database Rights**, then *"the database in which You have Sui Generis Database Rights (but
not its individual contents) is **Adapted Material**, including for purposes of Section 3(b)"* — i.e. **your
resulting database inherits ShareAlike** ([CC-BY-SA-4.0 §4](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)).
For a proprietary product whose entire value is its *enriched, normalized database*, that is exactly the
asset you do **not** want forced open. See §5 for the full mechanics; this is the headline trap.

> **Verdict:** Treat as **YELLOW → avoid as a database input.** You *can* use CC-BY-SA data to render a
> standalone *output* (a chart/answer — analogous to a "produced work") without your whole database
> becoming BY-SA, but the moment substantial BY-SA contents land **in your stored database**, that
> database is contaminated. Default policy: **do not ingest BY-SA into the warehouse** unless legal has
> explicitly cleared it; render-only at most, with a flag.

### 2.4 CC-BY-NC 4.0 — Attribution-NonCommercial (= **RED**)

The **NC** element is dispositive for a commercial product. NonCommercial is defined as:

> "**NonCommercial** means **not primarily intended for or directed towards commercial advantage or
> monetary compensation**."
> — [CC-BY-NC-4.0 legalcode §1](https://creativecommons.org/licenses/by-nc/4.0/legalcode.en)

A commercial financial-data product **is** "directed towards commercial advantage". Therefore any
NC-licensed series is **RED — not displayable** in the product, full stop. (NC variants — BY-NC,
BY-NC-SA, BY-NC-ND — all carry this poison pill; the classifier can short-circuit on `-NC-` in the
SPDX id.) It also makes NC **incompatible** with ShareAlike sources — see §5.4.

> **Verdict:** `commercialOk: false`, unconditional. May be *built against* for an internal/research,
> non-displayed purpose, but never shown commercially.

### 2.5 Scope clause — why CC 4.0 (not 3.0) is the one that licenses data

CC 4.0 explicitly defines its scope to include the database right, which is exactly the gap §1.2
described. From **Section 1 / 2(a)** of CC-BY-4.0, the **Licensed Rights** are *"Copyright and Similar
Rights"*, and the license is built to *"apply … to all Copyright and Similar Rights, including … Sui
Generis Database Rights"* — and **Section 4** then governs those rights specifically, granting the right
to *"extract, reuse, reproduce, and Share all or a substantial portion of the contents of the database"*
([CC-BY-4.0 §2/§4](https://creativecommons.org/licenses/by/4.0/legalcode.en)). For **CC-BY** (no SA),
Section 4 is the place that confirms ShareAlike does **not** bite even when you create a derivative
database — there is no SA element to propagate. This is why a **CC-BY-4.0 database** is GREEN-with-
attribution and a **CC-BY-SA-4.0 database** is the copyleft trap.

---

## 3. The Open Data Commons family — licenses *for databases*

Open Data Commons (ODC, a project of the Open Knowledge Foundation) built three licenses that mirror the
CC ladder but are written **specifically around the `sui generis` database right**. A classifier should
treat each as the *data-native twin* of a CC license:

| ODC license | SPDX id | "Twin" CC license | What it requires |
|---|---|---|---|
| **PDDL** — Public Domain Dedication & License | `PDDL-1.0` | CC0 | nothing (public-domain dedication for data) |
| **ODC-BY** — Attribution License | `ODC-By-1.0` | CC-BY | attribution only |
| **ODbL** — Open Database License | `ODbL-1.0` | CC-BY-SA | attribution **+ share-alike + keep-open** |

ODC's own one-liners: PDDL = *"Public Domain for data/databases"*, ODC-BY = *"Attribution for
data/databases"*, ODbL = *"Attribution Share-Alike for data/databases"*
([opendatacommons.org/licenses](https://opendatacommons.org/licenses/)).

### 3.1 PDDL 1.0 — public domain for data (= **GREEN-unconditional**)

PDDL is **CC0 for databases**. It dedicates the database (and the `sui generis` right in it) to the
public domain; no attribution is legally required. ODC packages a set of **non-binding "community
norms"** (e.g. cite the source) alongside it, but those are *norms, not license terms* — per the Turing
Way, PDDL is *"analogous to CC0 but includes a set of recommended community norms"* that are
non-binding ([Turing Way](https://book.the-turing-way.org/reproducible-research/licensing/licensing-data)).

> **Verdict:** `commercialOk: true`, attribution not legally required (cite as courtesy). Equivalent to
> CC0 for ingest purposes.

### 3.2 ODC-BY 1.0 — attribution for data (= **GREEN-with-attribution**)

The data twin of CC-BY. Commercial use permitted; you must **attribute** and pass along the license
notice on redistribution. Per the ODI, redistributions *"must include original license information"*
([Turing Way](https://book.the-turing-way.org/reproducible-research/licensing/licensing-data)). Crucially
**there is no share-alike** — a *derived database* from ODC-BY data does **not** have to be ODC-BY; you
just keep the attribution. This makes ODC-BY safe to ingest into a proprietary warehouse (unlike ODbL).

> **Verdict:** `commercialOk: true` **provided** TASL-style attribution is rendered on the surface (and
> the license notice travels with any redistribution). Safe to ingest into the proprietary DB.

### 3.3 ODbL 1.0 — the Open Database License (= **YELLOW / the database-rights viral trap**)

ODbL is the data twin of CC-BY-SA, and it is the **single most important license for the classifier to
flag**, because so much high-value open data (OpenStreetMap, many government open-data portals) ships
under it. Its human-readable summary lists three freedoms and **three conditions**:

> **Freedoms:** *Share* ("To copy, distribute and use the database"), *Create* ("To produce works from
> the database"), *Adapt* ("To modify, transform and build upon the database").
>
> **Conditions:**
> - **Attribute** — *"You must attribute any public use of the database, or works produced from the
>   database, in the manner specified in the ODbL."*
> - **Share-Alike** — *"If you publicly use any adapted version of this database, or works produced from
>   an adapted database, you must also offer that adapted database under the ODbL."*
> - **Keep open** — *"If you redistribute the database, or an adapted version of it, then you may use
>   technological measures that restrict the work (such as DRM) as long as you also redistribute a
>   version without such measures."*
> — [ODbL human-readable summary](https://opendatacommons.org/licenses/odbl/summary/)

ODbL pins its share-alike to a single, load-bearing definition pair in the **full legal text** — and
this pair is the escape hatch a proprietary product needs to understand precisely:

> - **Derivative Database** = *"a database based upon the Database, and includes any translation,
>   adaptation, arrangement, modification, or any other alteration of the Database or of a Substantial
>   part of the Contents."*
> - **Produced Work** = *"a work (such as an image, audiovisual material, text, or sounds) **resulting
>   from using the whole or a Substantial part of the Contents (via a search or other query)** from this
>   Database, a Derivative Database, or this Database as part of a Collective Database."*
> — [ODbL 1.0 legal text §1](https://opendatacommons.org/licenses/odbl/1-0/)

**The crucial asymmetry (memorise this):**

- **Share-Alike attaches to a *Derivative Database*** (§4.4: *"Any Derivative Database that You Publicly
  Use must be only under the terms of: This License; A later version …; or A compatible license."*).
  So if you **enrich/merge/extend the ODbL database into your stored database**, that database becomes a
  Derivative Database and must be re-offered under ODbL — **your warehouse is contaminated.**
- **A *Produced Work* is NOT a Derivative Database.** A chart, a computed answer, an analysis output —
  generated *via query* from the data — is a **Produced Work**. Produced Works carry **Attribution**
  (and a notice that the underlying DB is ODbL) but are **NOT forced to be ODbL themselves**, and your
  *internal* database is not dragged open merely because you *displayed* an output.
  ([ODbL §4.3 produced-work notice; §4.4 share-alike scoped to Derivative Databases](https://opendatacommons.org/licenses/odbl/1-0/).)

So the practical, defensible posture for ODbL data in a proprietary product is: **render Produced Works
(attributed), do not create/store a Derivative Database.** The danger is operational — a normalization
pipeline that *materializes a merged, enriched copy of the ODbL data into the warehouse* has created a
Derivative Database, even if the intent was only "to serve charts faster". §5.3 gives the decision rule.

> **Verdict:** **YELLOW.** Displaying an attributed *Produced Work* is defensible; *ingesting/merging
> into the stored proprietary database* triggers viral ODbL share-alike on that database. Default policy:
> **do not warehouse ODbL data**; if a feature needs it, serve it as render-time Produced Works with
> attribution, and get legal sign-off before any pipeline writes a merged copy to disk.

### 3.4 CC vs ODC — the one-line distinction to store

> **CC licenses cover copyright + neighbouring rights; ODC licenses cover the `sui generis` DATABASE
> right.** That is *why* a database needs the database-rights angle: a CC-BY-3.0 stamp on a feed may
> leave the EU database right unlicensed, whereas ODC-BY/ODbL/PDDL license it head-on, and CC **4.0**
> retro-fitted the database right into CC's own scope. For *data*, prefer ODC-family or CC-**4.0**; treat
> a CC-**3.0**-on-data stamp as ambiguous-on-the-database-right (lean conservative).

(Per [ODC FAQ](https://opendatacommons.org/faq/licenses/) and
[Turing Way](https://book.the-turing-way.org/reproducible-research/licensing/licensing-data): ODC
licenses *"were made specifically to be applied to data, and typically cover only database rights,"*
whereas CC licenses are *"more general-purpose"* covering *"copyrights plus neighbouring rights."*)

---

## 4. The TASL attribution model — what minimally satisfies a BY license

For any GREEN-with-attribution source (CC-BY, ODC-BY), the classifier's verdict is conditional on the
surface **actually rendering attribution**. Creative Commons' recommended practice packages the required
information into the mnemonic **TASL — Title, Author, Source, License**
([CC wiki: Recommended practices for attribution](https://wiki.creativecommons.org/wiki/Recommended_practices_for_attribution)):

| Letter | Question | What to render | Notes |
|---|---|---|---|
| **T — Title** | "What is the name of the work?" | the work/dataset title, if the creator gave one | omit if untitled — acceptable |
| **A — Author** | "Who allows you to use the work?" | the creator/licensor's **preferred name** (pseudonym if requested); include any supplied copyright notice | this is the *most* important element |
| **S — Source** | "Where can people find the work?" | a **URL/hyperlink to the original** (prefer the full link over a shortener) | satisfies CC-BY §3(a)(1)(A)(v)'s "URI or hyperlink" |
| **L — License** | "How can you use the work?" | the license **name + a link to the license deed/legalcode** | e.g. "CC BY 4.0" linked to the deed |

**Plus the two duties that are not in the acronym** but are in CC-BY §3(a):

- **Indicate modifications.** If you transformed the data (normalized units, resampled, merged), you must
  *"indicate if You modified the Licensed Material and retain an indication of any previous
  modifications."* For a data product this is satisfied by a short "transformed: normalized to USD,
  resampled daily" note in the provenance/sources panel.
- **Pass along the license notice.** Include the license name + link (the **L**), satisfying *"include
  the text of, or the URI or hyperlink to, this Public License."*

### 4.1 What *minimally* satisfies CC-BY 4.0 on a product surface

CC-BY §3(a)(3) lets you attribute *"in any reasonable manner based on the medium, means, and context"*
and explicitly permits *"providing a URI or hyperlink to a resource that includes the required
information"* ([legalcode §3(a)](https://creativecommons.org/licenses/by/4.0/legalcode.en)). For a dense
analytics UI the minimally-compliant, recommended pattern is therefore:

1. **Near the rendered series** (chart footnote / "ⓘ Sources" affordance): a short credit — *"Data:
   {Author} ({Title}) — CC BY 4.0"* — where **{Author}** and **CC BY 4.0** are links.
2. **One canonical `/attribution` (sources) page** that lists, per source: full TASL (title, author with
   link, source URL, license name+link), and a note of any modifications made. Every CC-BY/ODC-BY series
   links here. This is the **separate-page allowance** in action and the pattern the product standardises.

> **Grading a build's attribution.** PASS = author + license-name + a link to the source **and** a link
> to the license, reachable from the surface (inline or via the linked sources page), plus a modifications
> note where data was transformed. FAIL = "Source: the internet", a license name with no link, or
> attribution that exists only in a code comment / `Provenance` object the user never sees. **Attribution
> the user cannot see does not satisfy the license.**

### 4.2 ODbL / ODC-BY attribution specifics

ODbL requires attribution on *both* the database **and** Produced Works, in the manner the ODbL
specifies, and a **notice that the source is ODbL-licensed** must travel with a Produced Work
([ODbL §4.2–4.3](https://opendatacommons.org/licenses/odbl/1-0/)). ODC-BY similarly requires the
attribution + the license notice to ride along on redistribution. The same `/attribution`-page pattern
covers these; just record the SPDX id (`ODbL-1.0` / `ODC-By-1.0`) and link the ODC license text.

---

## 5. The share-alike viral trap — the most expensive mistake in the catalogue

This is the section to read twice. ShareAlike / copyleft (CC-BY-SA, ODbL) is the mechanism that can
**force a proprietary database open**, and the failure is *silent* — nothing errors at build time; the
liability only surfaces when someone asserts the obligation.

### 5.1 The mechanism, in one paragraph

A share-alike license grants you broad rights (including commercial use) **on the condition** that any
**adaptation you publicly distribute** is released under the *same* license. The Open Data Institute's
compatibility guidance states the rule flatly: *"The Share Alike requirement requires that derived data
is published under the same or compatible terms as the original,"* and *"It is not possible to take a
dataset published under a Creative Commons licence and then distribute the same dataset under a different
licence. The original licence always applies to the original work."*
([theodi/open-data-licensing, licence-compatibility.md](https://github.com/theodi/open-data-licensing/blob/master/guides/licence-compatibility.md)).
So when you derive a *new database* from a BY-SA/ODbL source and publish it, you cannot relicense it under
your proprietary terms — it inherits the copyleft.

### 5.2 Why "we'll just keep it internal" is a thin defence

Share-alike obligations trigger on **public use / distribution**, not on mere private possession. ODbL's
trigger is *"any Derivative Database that You **Publicly Use**"*, where **Publicly** is defined broadly as
*"to Persons other than You or under Your control"* ([ODbL §1, §4.4](https://opendatacommons.org/licenses/odbl/1-0/)).
A SaaS data product that *serves derived data to external customers* is publicly using it. "It's just on
our servers" does not save you once a customer queries a derived series. (The "private use" carve-outs in
the EU Directive are for *non-electronic*, teaching, or judicial use — not a commercial SaaS — per
[Directive Art. 9](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:01996L0009-20190606).)

### 5.3 The Produced-Work escape — the line a data product must hold

The defensible line, drawn precisely from ODbL's own definitions (§3.3):

| You do this with ODbL/BY-SA data | Legal character | Result for your proprietary DB |
|---|---|---|
| Query it and **render a chart / computed answer** at request time | **Produced Work** | **Safe** — attribute, note it's ODbL/BY-SA-sourced; your DB is untouched |
| **Materialize a merged/enriched copy** of it into your warehouse and serve from there | **Derivative Database** | **Contaminated** — that stored DB must be re-offered under ODbL/BY-SA |
| Mix it with your other data into one stored, queryable dataset | **Derivative Database** | **Contaminated** |
| Combine it with a **CC0/PDDL/US-PD** dataset into a stored dataset | **Derivative Database** (still, if it includes substantial SA contents) | **Contaminated** — public-domain neighbours do **not** dilute the SA obligation |

The last row is the subtle one: per the ODI, *"When a public domain (CC0, PDDL) source is combined with a
CC-BY-SA source, then the derivative must also be published under a CC-BY-SA licence."* Mixing in free
data does **not** wash out share-alike — the *most-restrictive* input governs the combined database.

> **Engineering rule for the normalization/warehouse layer.** A pipeline that **persists a transformed,
> merged copy** of a share-alike source into the time-series store has created a **Derivative Database**.
> Therefore: **share-alike sources must not enter the persistent warehouse.** If a feature genuinely
> needs ODbL data, fetch it at request time, derive a **Produced Work** (chart/answer), attribute it, and
> do **not** write the merged result back to the proprietary store. Encode this as a hard gate in the
> ingest classifier: `if license in {ODbL-1.0, CC-BY-SA-4.0}: block_warehouse_ingest unless legal_clears`.

### 5.4 NC × SA incompatibility (a second trap, for completeness)

You also cannot combine an **NC** source with an **SA** source: per the ODI, *"works licensed under the
Open Data Commons Open Database Licence (ODbL) cannot be used in combination with works licensed under the
CC-BY-NC license: the non-commercial prohibition on the CC-BY-NC licence is at odds with the sharealike
provision of the ODbL license"*
([theodi/open-data-licensing](https://github.com/theodi/open-data-licensing/blob/master/guides/licence-compatibility.md)).
The mechanism: SA forces you to grant downstream users *all* the freedoms you received (including
commercial use); NC forbids granting commercial use — the two requirements are mutually unsatisfiable.
For us, NC is RED anyway, so this is moot at the *display* layer, but the classifier should still refuse
to *merge* an NC source into an SA-licensed output.

### 5.5 The compatibility summary table (store this matrix)

Downstream-license a *Derivative Database* can be published under, given the most-restrictive input:

| Most-restrictive input | Can the derived DB be proprietary? | Derived DB must be… |
|---|---|---|
| CC0-1.0 / PDDL-1.0 / US-PD | **yes** | anything (incl. proprietary) |
| CC-BY-4.0 / ODC-By-1.0 | **yes** (attribution travels) | anything, *with attribution preserved* |
| CC-BY-SA-4.0 | **no** | CC-BY-SA-4.0 (or BY-SA-compatible) |
| ODbL-1.0 | **no** | ODbL-1.0 (or ODbL-compatible) |
| any `-NC-` | **no** (RED) | not displayable commercially; cannot mix with SA |

---

## 6. US federal public domain — 17 USC §105 and its hard limits

US-government data is the workhorse GREEN-unconditional source for a finance product (Treasury yields,
Fed/Board releases, BLS/BEA statistics, SEC EDGAR filings). The legal basis is **17 U.S. Code §105**:

> "**Copyright protection under this title is not available for any work of the United States
> Government**, but the United States Government is not precluded from receiving and holding copyrights
> transferred to it by assignment, bequest, or otherwise."
> — [17 USC §105(a)](https://www.law.cornell.edu/uscode/text/17/105)

And the **definition** that fixes the scope, from 17 USC §101:

> "A '**work of the United States Government**' is a work prepared by **an officer or employee of the
> United States Government as part of that person's official duties**."
> — 17 USC §101 (via [Cornell LII](https://www.law.cornell.edu/uscode/text/17/105))

### 6.1 The four limits a classifier MUST enforce (the §105 gotchas)

§105 is narrow. It clears a *federal officer/employee's official-duty work* and **nothing else**. Each of
the following is **outside** §105 and therefore **NOT automatically public domain** — treat as **RED until
its own terms are checked**:

1. **Contractor / grantee works.** §105 deliberately does **not** prohibit copyright in works made under
   government *contract or grant*. A dataset built for an agency by a contractor may be copyrighted; the
   agency decides case-by-case. → **A `.gov` URL is not proof of public domain** if the data was
   contractor-produced. Check the page's own rights statement.
2. **State and local government works.** §105 applies to the **federal** government only. State/county/
   municipal works (and their open-data portals) may carry their **own** copyright or license (often
   CC-BY) — read each portal's terms.
3. **Foreign government works.** §105 does not place foreign-government works in the US public domain;
   other nations routinely copyright their government output (e.g. UK Crown Copyright → typically the
   Open Government Licence, which is CC-BY-compatible but is its *own* license to render attribution for).
4. **Copyrights *transferred to* the US government.** §105(a) lets the government *hold* copyrights
   assigned/bequeathed to it. Such a work, though held by a federal agency, **is** under copyright. (Also
   note **USPS** works are carved out by the Postal Reorganization Act and are **not** §105 public
   domain.)

> **Classifier rule.** `US-PD GREEN` requires *both* (a) a federal source *and* (b) confirmation the data
> is a federal officer/employee's **official-duty work** (not contractor/transferred/foreign/state). The
> high-confidence list for a finance product: **treasury.gov, federalreserve.gov (Board), bls.gov,
> bea.gov, sec.gov/EDGAR, census.gov, data.gov federal datasets** — but always confirm the *specific
> dataset's* rights statement, because a §105 source can still host a contractor dataset on a sub-path.

### 6.2 Two more US-PD cautions

- **No `sui generis` right ≠ contractually unrestricted.** Even where data is US-PD (no copyright, no
  database right), an API's **Terms of Service** can still impose access/rate limits or redistribution
  conditions *by contract*. Public-domain content cleanly clears the *copyright/database* gate but the
  ToS still governs the *access path*. (E.g. a US-gov dataset re-served by a private vendor's API: the
  *facts* are PD, but the vendor's ToS may restrict redistribution — which is the "fetch path, not
  concept" rule again.)
- **GREEN-but-wrong is still wrong.** A public-domain source can return a defective number (e.g.
  duplicate or non-comparable SEC XBRL facts). US-PD clears the *display license*; it does **not** vouch
  for *correctness*. The product's separate "never invent / ground every number" discipline still applies.

---

## 7. SPDX identifiers — the canonical machine id to store per fetch path

Every license above has a canonical, machine-readable **SPDX short identifier**. This is what the
provenance record should store (not free-text like "creative commons attribution"), so the classifier and
any lint can reason exactly. As of the **SPDX License List v3.28.0 (released 2026-02-20)**
([spdx.org/licenses](https://spdx.org/licenses/)):

| SPDX id (exact case) | Full name | Our rung | `commercialOk` |
|---|---|---|---|
| `CC0-1.0` | Creative Commons Zero v1.0 Universal | GREEN-unconditional | `true` |
| `PDDL-1.0` | Open Data Commons Public Domain Dedication & License 1.0 | GREEN-unconditional | `true` |
| `CC-BY-4.0` | Creative Commons Attribution 4.0 International | GREEN-with-attribution | `true` (+attr) |
| `ODC-By-1.0` | Open Data Commons Attribution License v1.0 | GREEN-with-attribution | `true` (+attr) |
| `CC-BY-SA-4.0` | Creative Commons Attribution Share Alike 4.0 International | YELLOW (copyleft DB) | `true` for Produced Work; **viral on Derivative DB** |
| `ODbL-1.0` | Open Data Commons Open Database License v1.0 | YELLOW (copyleft DB) | `true` for Produced Work; **viral on Derivative DB** |
| `CC-BY-NC-4.0` | Creative Commons Attribution Non Commercial 4.0 International | RED | `false` |
| *(no SPDX id — not a license)* | US Government work, 17 USC §105 | GREEN-unconditional (federal official-duty only) | `true` |

**Exact-capitalization gotchas to encode** (these trip up string matching):

- `ODC-By-1.0` — note the lowercase **`y`** in `By` and the capital `O`, `D`, `C`. It is **not**
  `ODC-BY-1.0`. ([SPDX list](https://spdx.org/licenses/).)
- `PDDL-1.0` — all caps, single hyphen before the version.
- `CC0-1.0` — the digit zero, no hyphen between `CC` and `0`.
- `ODbL-1.0` — lowercase **`b`**, capital `L`. Not `ODBL`.
- CC ids use a hyphen before each element and the version: `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC-BY-NC-4.0`.

For **US public domain there is no SPDX license id** (it is the *absence* of copyright, not a license).
SPDX models "no license / public domain" cases via the deprecated `CC-PDDM`-style or the document-level
`PublicDomain` notion; the pragmatic choice for our provenance schema is a sentinel string such as
`US-PD-17USC105` (not an SPDX id, flagged as such) so a lint can distinguish "dedicated public domain
(`CC0-1.0`)" from "never had copyright (`US-PD-17USC105`)" — legally different routes to the same GREEN.

> **Why store SPDX, not prose.** A SPDX id is unambiguous, case-checkable, and lets a `/sources-lint`-style
> audit assert "`commercialOk:true` requires the id to be in the GREEN allow-list" mechanically. Free-text
> "CC BY" cannot be linted (is it 4.0? 3.0-on-data with the database-right gap? NC?).

### 7.1 Recognising a license off a source page (classifier heuristics)

A classifier reading a dataset's landing page or API docs maps surface signals → SPDX id → verdict:

| Surface signal seen | Map to | Verdict |
|---|---|---|
| "CC0", "public domain", "no rights reserved", CC0 button/deed link | `CC0-1.0` | GREEN |
| "PDDL", "Public Domain Dedication and License", ODC PD button | `PDDL-1.0` | GREEN |
| `.gov` federal source + official-duty data + no contractor/foreign caveat | `US-PD-17USC105` | GREEN (confirm §6.1) |
| "CC BY 4.0", "Attribution 4.0", CC-BY deed link | `CC-BY-4.0` | GREEN + must render TASL |
| "ODC-BY", "Attribution License" (ODC) | `ODC-By-1.0` | GREEN + must render TASL |
| "ShareAlike", "BY-SA", "ODbL", "share-alike", "copyleft" | `CC-BY-SA-4.0` / `ODbL-1.0` | YELLOW — Produced-Work only, no DB ingest |
| "NonCommercial", "BY-NC", "non-commercial use only" | `CC-…-NC-…` | RED |
| **No license stated / "all rights reserved" / "free tier" / silent ToS** | unknown | **RED (default)** |

> **The default is the rule.** Anything that does not positively resolve to a GREEN or cleared-YELLOW row
> is **RED**. A free API tier, a silent ToS, and "everyone else displays it" all land here.

---

## 8. The license → verdict map (the deliverable of this doc)

Collapse everything above into the table a classifier and a reviewer both work from:

| License (SPDX) | Commercial display? | Attribution? | Share-alike on a derived **database**? | Safe to **warehouse-ingest**? | Net verdict |
|---|---|---|---|---|---|
| `CC0-1.0` | yes | no | no | **yes** | **GREEN-unconditional** |
| `PDDL-1.0` | yes | no | no | **yes** | **GREEN-unconditional** |
| `US-PD-17USC105` (federal official-duty) | yes | no (cite as courtesy) | n/a (no copyright) | **yes** | **GREEN-unconditional** |
| `CC-BY-4.0` | yes | **required (TASL)** | no | **yes** (keep attribution) | **GREEN-with-attribution** |
| `ODC-By-1.0` | yes | **required (TASL)** | no | **yes** (keep attribution) | **GREEN-with-attribution** |
| `CC-BY-SA-4.0` | yes (Produced Work) | required | **YES — viral** | **NO** | **YELLOW / avoid in DB** |
| `ODbL-1.0` | yes (Produced Work) | required | **YES — viral on Derivative DB** | **NO** | **YELLOW / avoid in DB** |
| `CC-BY-NC-4.0` (any `-NC-`) | **no** | — | — | **no** | **RED** |
| unknown / silent ToS / free tier / "all rights reserved" | **no** | — | — | **no** | **RED (default)** |

### 8.1 The three rules a reviewer applies with this map

1. **`commercialOk: true` is justified only by a GREEN row** — a `CC0-1.0` / `PDDL-1.0` / `US-PD-17USC105`
   stamp (unconditional) or a `CC-BY-4.0` / `ODC-By-1.0` stamp **with rendered attribution present on the
   surface**. No GREEN row → `commercialOk: false`.
2. **A YELLOW (`CC-BY-SA-4.0` / `ODbL-1.0`) source may be *displayed* as an attributed Produced Work but
   must NOT be merged into the persistent proprietary database** — that creates a viral Derivative
   Database. Block at the ingest classifier; render-only with legal sign-off.
3. **Default to RED.** Unknown license, silent/ambiguous ToS, free API tier, "all rights reserved", or a
   `.gov` page whose data is contractor/foreign/state → RED. Silence is not a grant.

---

## 9. Common misconceptions a classifier must reject (anti-patterns)

| Misconception | Reality | Cite |
|---|---|---|
| "It's just facts (prices), so no one owns it." | True for **US copyright** post-*Feist*, but the **EU `sui generis` database right** still protects the *collection* of facts. Jurisdiction matters. | [Directive 96/9/EC Art.7](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:01996L0009-20190606) |
| "CC-BY is fine for our database." | CC **4.0** licenses the database right; CC **2.x/3.0** is ambiguous on data — the EU database-right gap. Prefer ODC-family or CC-**4.0** for data. | [ODC FAQ](https://opendatacommons.org/faq/licenses/) |
| "We'll just keep the ODbL-derived DB internal." | Share-alike triggers on **public use** (serving external customers), and `Publicly` is defined broadly. SaaS ≠ private. | [ODbL §1, §4.4](https://opendatacommons.org/licenses/odbl/1-0/) |
| "Mixing in CC0 data washes out the share-alike." | No — the **most-restrictive** input governs the combined database; PD neighbours don't dilute SA. | [theodi compatibility](https://github.com/theodi/open-data-licensing/blob/master/guides/licence-compatibility.md) |
| "It's on a `.gov` site, so it's public domain." | Only federal *officer/employee official-duty* work. Contractor/foreign/state/transferred works are NOT §105. | [17 USC §105](https://www.law.cornell.edu/uscode/text/17/105) |
| "CC0 needs a credit." | No — CC0 has **no** attribution clause. Citing is a *norm*, not a legal duty. | [CC0 legalcode](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en) |
| "We rendered a CC-BY chart, attribution lives in our `Provenance` object." | Attribution must be **visible to the user** (inline or via a linked sources page). A code-side object the user never sees does not satisfy §3(a). | [CC-BY §3(a)](https://creativecommons.org/licenses/by/4.0/legalcode.en) |
| "The free API tier lets us display it." | A free *access* tier is **not** a commercial-*display/redistribution* license. Silent/ambiguous redistribution terms → RED. | (policy; ToS-silence default) |
| "NonCommercial is fine, we're not selling the data directly." | NC = *"not primarily intended for or directed towards commercial advantage."* A commercial product is. NC = RED. | [CC-BY-NC §1](https://creativecommons.org/licenses/by-nc/4.0/legalcode.en) |
| "GREEN means the number is correct." | GREEN clears the **display license** only. Grounding/validation is a *separate* obligation; GREEN-but-wrong is still wrong. | (cross-cutting #1) |

---

## 10. Quick-reference: minimal Python the classifier core leans on

A small, deterministic mapping is enough for the *license-id → verdict* step (the hard part is reading the
id off the source, which §7.1 covers). This is the spine the data-provenance classifier wraps with
fetch-path metadata:

```python
# license_verdict.py  — the SPDX-id → verdict spine (greenfield reference shape).
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum


class Rung(str, Enum):
    GREEN_UNCONDITIONAL = "green_unconditional"      # CC0 / PDDL / US-PD
    GREEN_WITH_ATTRIBUTION = "green_with_attribution"  # CC-BY / ODC-BY
    YELLOW_COPYLEFT = "yellow_copyleft"              # CC-BY-SA / ODbL
    RED = "red"                                       # NC / unknown / silent ToS


@dataclass(frozen=True)
class Verdict:
    rung: Rung
    commercial_ok: bool          # display license granted?
    attribution_required: bool   # must render TASL on the surface?
    warehouse_ingest_ok: bool    # safe to persist a merged copy into the proprietary DB?
    note: str


# Canonical SPDX ids (exact case — see §7). US-PD uses a non-SPDX sentinel.
_GREEN_UNCONDITIONAL = {"CC0-1.0", "PDDL-1.0", "US-PD-17USC105"}
_GREEN_WITH_ATTR = {"CC-BY-4.0", "ODC-By-1.0"}
_YELLOW_COPYLEFT = {"CC-BY-SA-4.0", "ODbL-1.0"}


def verdict_for(spdx_id: str) -> Verdict:
    """Map a stored license id to our four-rung verdict. Default is RED."""
    sid = spdx_id.strip()  # exact-case match; do NOT lowercase (ODC-By-1.0, ODbL-1.0 are case-bearing)

    # Any NonCommercial element is dispositive RED — short-circuit on the -NC- token.
    if "-NC-" in sid or sid.endswith("-NC") or "-NC-ND" in sid or "-NC-SA" in sid:
        return Verdict(Rung.RED, False, False, False,
                       "NonCommercial: not displayable in a commercial product (CC-…-NC-…).")

    if sid in _GREEN_UNCONDITIONAL:
        return Verdict(Rung.GREEN_UNCONDITIONAL, True, False, True,
                       "All rights waived / never had copyright. Cite as courtesy only.")

    if sid in _GREEN_WITH_ATTR:
        return Verdict(Rung.GREEN_WITH_ATTRIBUTION, True, True, True,
                       "Commercial use OK *iff* TASL attribution is rendered on the surface.")

    if sid in _YELLOW_COPYLEFT:
        # commercial_ok True ONLY for an attributed Produced Work (render-time output).
        # warehouse_ingest_ok False: persisting a merged copy creates a viral Derivative Database.
        return Verdict(Rung.YELLOW_COPYLEFT, True, True, False,
                       "Copyleft: attributed Produced Work OK; do NOT ingest into the proprietary DB.")

    # Unknown id, silent/ambiguous ToS, free API tier, "all rights reserved" → RED by default.
    return Verdict(Rung.RED, False, False, False,
                   f"No GREEN/cleared row for {sid!r}; default RED (silence is not a grant).")


def assert_warehouse_ingest_allowed(spdx_id: str) -> None:
    """Hard gate for the normalization/ingest path: refuse to persist a copyleft/RED source."""
    v = verdict_for(spdx_id)
    if not v.warehouse_ingest_ok:
        raise PermissionError(
            f"Refusing warehouse ingest of {spdx_id!r}: {v.note} "
            f"(serve as a render-time Produced Work instead, with attribution)."
        )
```

> Two non-obvious choices this code encodes, both load-bearing:
> 1. **No `.lower()`** — `ODC-By-1.0` and `ODbL-1.0` are case-bearing SPDX ids; lowercasing breaks the
>    match and silently drops to RED (a *safe* failure here, but it would mis-clear a GREEN source as
>    needing manual review). Match exact case, and normalise *upstream* when reading the id off a page.
> 2. **`warehouse_ingest_ok` is a separate axis from `commercial_ok`** — a YELLOW source is
>    `commercial_ok=True` (you may display an attributed Produced Work) yet `warehouse_ingest_ok=False`
>    (you may not persist a Derivative Database). Collapsing the two into one boolean is exactly how the
>    share-alike trap gets shipped.

---

## 11. Sources (primary, read for this doc)

- **CC-BY 4.0 legalcode** — attribution obligations §3(a), reasonable-manner & URI-page allowance, scope §2/§4:
  <https://creativecommons.org/licenses/by/4.0/legalcode.en>
- **CC-BY-SA 4.0 legalcode** — ShareAlike §3(b), database-right adaptation §4:
  <https://creativecommons.org/licenses/by-sa/4.0/legalcode.en>
- **CC-BY-NC 4.0 legalcode** — NonCommercial definition §1:
  <https://creativecommons.org/licenses/by-nc/4.0/legalcode.en>
- **CC0 1.0 legalcode** — waiver §2, database-rights inclusion, fallback license §3, no-warranty §4:
  <https://creativecommons.org/publicdomain/zero/1.0/legalcode.en>
- **CC recommended practices for attribution (TASL)**:
  <https://wiki.creativecommons.org/wiki/Recommended_practices_for_attribution>
- **Open Data Commons — licenses index** (PDDL / ODC-BY / ODbL one-liners):
  <https://opendatacommons.org/licenses/>
- **Open Data Commons — licenses FAQ** (why ODC ≠ CC; data needs the database-right angle):
  <https://opendatacommons.org/faq/licenses/>
- **ODbL 1.0 — human-readable summary** (Attribute / Share-Alike / Keep open):
  <https://opendatacommons.org/licenses/odbl/summary/>
- **ODbL 1.0 — full legal text** (Derivative Database vs Produced Work; §4.4 share-alike):
  <https://opendatacommons.org/licenses/odbl/1-0/>
- **The Turing Way — Licensing data** (CC0/CC-BY/PDDL/ODC-BY/ODbL guidance for data):
  <https://book.the-turing-way.org/reproducible-research/licensing/licensing-data>
- **The Open Data Institute — licence compatibility** (share-alike propagation; NC×SA incompatibility):
  <https://github.com/theodi/open-data-licensing/blob/master/guides/licence-compatibility.md>
- **SPDX License List** (canonical short ids; v3.28.0, 2026-02-20) + CC-BY-4.0 detail page:
  <https://spdx.org/licenses/> · <https://spdx.org/licenses/CC-BY-4.0.html>
- **17 U.S. Code §105** — US Government works (and §101 definition):
  <https://www.law.cornell.edu/uscode/text/17/105>
- **Directive 96/9/EC** — EU `sui generis` database right (Art. 7 substantial investment; Art. 10 15-yr term):
  <https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:01996L0009-20190606> ·
  <https://www.wipo.int/wipolex/en/text/126788>
