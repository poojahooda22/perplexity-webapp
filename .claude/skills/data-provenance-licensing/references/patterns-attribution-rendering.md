---
name: patterns-attribution-rendering
description: >
  The concrete build recipe for satisfying conditioned-license attribution obligations at DISPLAY
  time — the most-missed half of CC-BY and other "free but conditioned" licenses. For the JPM-Markets
  re-engineering data-analytics product line (NOT Lumina). Turns "attribution string in the metadata"
  into "attribution rendered on every surface that shows the data": the card footer, the chart caption,
  the JSON API response field, the exported Parquet/CSV manifest, and the email/SFTP delivery. Covers
  the exact per-source render obligations (CC-BY 4.0 TASL + "indicate changes" + the link-to-a-page
  allowance; World Bank / OECD / IMF CC-BY acknowledgment + the sub-license PASS-THROUGH duty; GDELT's
  mandatory citation + link on every tone surface; CoinGecko "Powered by CoinGecko" if a paid tier ever
  flips the gate), the composite/union rule for multi-source derived series, a reusable
  <Attribution provenance> render component, an `attribution` field convention for the JSON envelope and
  the batch manifest, and the anti-pattern gallery (attribution in JSON but not the DOM; on the web page
  but stripped from the API; "changes made" omitted on a transformed CC-BY series).
type: reference
---

# Pattern: Rendering Attribution — the display-time half of the license

> **The license is not satisfied when you *store* the attribution string. It is satisfied when the
> attribution *renders* on the surface a human (or a downstream machine) actually sees.** A CC-BY series
> with a perfect `attribution` field in your database, displayed on a chart with no caption, is a license
> violation — identical, legally, to having no attribution at all. This recipe is about the render.

This is the companion to the **provenance-stamp** theory (every series carries a `Provenance{commercialOk,
attribution, ...}`) and the **commercialOk-gate** rule. The stamp is the *data*; this doc is the *display
obligation* that the stamp's `attribution` and `licenseUrl` fields exist to satisfy. The provenance stamp
without a render path is a stamp that lies by omission: it asserts the license is honored while the
surface honors nothing.

---

## §0 — TL;DR: the five things this recipe enforces

1. **Attribution is a runtime render obligation, not a stored field.** Every surface that shows a
   conditioned series must render its attribution *on that surface*. Storing it is necessary but not
   sufficient.
2. **"Every surface" is literal** — the web card, the chart caption, the **JSON API response**, the
   **exported file (Parquet/CSV) + its manifest**, and the **email/SFTP/S3 delivery**. An API consumer is
   a surface; a downloaded file opened six months later is a surface.
3. **CC-BY has TWO display duties most builds drop:** (a) the **attribution itself** (TASL — Title,
   Author, Source, License, each linked) and (b) **"indicate if you modified the Material"** — a
   transformed/rebased/resampled CC-BY series must say it was changed.
4. **World Bank / OECD / IMF add a PASS-THROUGH duty:** when you re-deliver their data to *your*
   consumers, you must contractually *require those consumers to attribute too*. The obligation does not
   stop at your edge — it flows downstream.
5. **A composite renders the UNION of all conditioned inputs' attributions.** A series blended from World
   Bank + OECD + GDELT shows all three. The contamination rule (a RED input makes the composite RED)
   governs `commercialOk`; this union rule governs `attribution`.

---

## §1 — Why attribution is a runtime render obligation, not a stored field

### 1.1 The legal mechanism: the license is conditioned, and the condition is *display*

A "free" data license is not the same as "do whatever you want." Every license in our GREEN/conditioned
column grants broad rights **on a condition** — and for the conditioned sources, that condition is a
*display act you must perform on the surface*. Drop the act, and the grant evaporates: you are now an
infringer using the data without a license.

CC-BY 4.0 makes this explicit. Section 2(a)(1) grants the rights ("to reproduce and Share … in whole or
in part; and to produce, reproduce, and Share Adapted Material") **subject to the conditions in Section
3.** Section 3(a)(1) then states the condition:

> "If You Share the Licensed Material … You must … retain the following if it is supplied by the Licensor
> with the Licensed Material: identification of the creator(s) … a copyright notice; a notice that refers
> to this Public License; a notice that refers to the disclaimer of warranties; a URI or hyperlink to the
> Licensed Material to the extent reasonably practicable; **indicate if You modified the Licensed Material
> and retain an indication of any previous modifications**; and **indicate the Licensed Material is
> licensed under this Public License, and include the text of, or the URI or hyperlink to, this Public
> License.**"
> — CC BY 4.0 legalcode §3(a)(1), https://creativecommons.org/licenses/by/4.0/legalcode.en

"If You Share" is the trigger. **Sharing is the display.** The obligation activates *at the moment the
data is shown to someone* — on a web card, in an API response, in a delivered file. It does not activate
when you write the row to the database. Therefore the discharge of the obligation must happen *at that
same moment* — at render — not at ingest.

### 1.2 The engineering consequence: storage ≠ discharge

A naïve build stores `provenance.attribution = "World Bank — World Development Indicators (CC BY 4.0)"`
on the series row and considers the license honored. It is not. The license is honored only where the
series is *Shared*. Three independent things can each happen, and each is a separate surface with its own
discharge:

| Event | Is this "Sharing"? | Must attribution render here? |
|---|---|---|
| Row written to TimescaleDB | No (internal, not Shared) | No — but the stamp must be *stored* so a later render can read it |
| Rendered on a web chart | Yes | **Yes** — caption / footer |
| Returned in a `GET /series` JSON response | Yes (Shared to the API consumer) | **Yes** — an `attribution` field in the envelope |
| Written into an exported Parquet file | Yes (Shared to whoever opens the file) | **Yes** — manifest + embedded metadata |
| Emailed / SFTP'd to a B2B consumer | Yes | **Yes** — in the delivery + the file |

The stored stamp is the *source of truth that feeds every render*. The render is the *discharge*. Confuse
the two and you ship the canonical violation: **attribution in the JSON but not the DOM**, or
**attribution on the web page but stripped from the API/export** (§7).

### 1.3 The "reasonable manner" flexibility — and its one hard limit

CC-BY does *not* dictate a fixed format. §3(a)(2) grants flexibility:

> "You may satisfy the conditions in Section 3(a)(1) in any reasonable manner based on the medium, means,
> and context in which You Share the Licensed Material. **For example, it may be reasonable to satisfy the
> conditions by providing a URI or hyperlink to a resource that includes the required information.**"
> — CC BY 4.0 legalcode §3(a)(2)

This is the **"link to a separate attribution page" allowance** — load-bearing for our build. On a dense
finance dashboard with 30 series, you do not need 30 verbose TASL blocks inline. You may render a *short*
credit on each surface plus a single link to a `/attributions` (or "Data sources") page that carries the
full TASL + license URIs + change notices for every series shown. This is what offline / space-constrained
media do, per CC's own recommended practice:

> "If you are using offline media and cannot include hyperlinks, consider including the same information in
> another way … one approach is to publish a webpage that lists the attribution information with active
> links."
> — CC Recommended practices for attribution, https://wiki.creativecommons.org/wiki/Recommended_practices_for_attribution

**The hard limit:** the link allowance covers the *attribution detail*, not the *existence of a credit*.
You may move the verbose TASL to a linked page, but every surface must still carry *some* visible credit
("Source: World Bank ·") and the link. A surface with zero credit and zero link satisfies nothing — the
reader has no way to reach the required information. And the link target must actually *contain* the
required info; a 404 or a generic homepage does not discharge the duty.

> **Frame-0 / engineering corollary:** the attribution string and the license URI must travel *with the
> series through every transform*, because any transform stage is a potential render boundary. If your
> resample/rebase step drops the provenance, the render at the far end has nothing to show. This is why
> the **TET write path** (`data-normalization-tet`) stamps provenance in `transform_data` and the
> **time-series store** persists it — so the render layer can always read it back. Attribution rendering
> is the *last mile* of a chain that must be unbroken from fetch to pixel.

---

## §2 — Per-source render requirements (the exact obligations)

The license attaches to the **fetch path**, so the *render* obligation is per-fetch-path too. Below is the
exact display duty for each conditioned source we touch, quoted from primary terms. Pin these — they are
what the `<Attribution>` component and the API field must emit.

### 2.1 CC-BY 4.0 (generic) — the TASL block + "indicate changes"

**The grant:** copy, redistribute, adapt, **commercial use allowed**, no permission needed.
**The condition (what must render):**

| TASL element | What to render | Source clause |
|---|---|---|
| **T**itle | The work's name if supplied (optional in 4.0, required in 3.0) | "Include the work's name if provided" — CC recommended practices |
| **A**uthor | The creator/licensor, by the name/pseudonym they designate; **never** "Creative Commons" | §3(a)(1)(A)(i): "identification of the creator(s) … and any others designated to receive attribution" |
| **S**ource | A URI/hyperlink to the Licensed Material, "to the extent reasonably practicable" — prefer the original location, full URL | §3(a)(1)(A)(v) |
| **L**icense | Name **and link** the exact license ("CC BY 4.0") + a URI to the license text | §3(a)(1)(C): "include the text of, or the URI or hyperlink to, this Public License" |
| *(changes)* | **"indicate if You modified the Licensed Material and retain an indication of any previous modifications"** | §3(a)(1)(B) — *the most-dropped duty* |

CC's own **ideal** rendered example (links elided here, present in original):

> "*Creative Commons 10th Birthday Celebration San Francisco* by Timothy Vollmer is licensed under CC BY 4.0"
> — CC Recommended practices for attribution

And the **marginally acceptable** minimum (omits title, still links source + author + license):

> "Photo by Timothy Vollmer / CC BY"
> — CC Recommended practices for attribution

**The "indicate changes" duty — why it bites a data product specifically.** We almost never display a
CC-BY series *raw*. We **rebase to 100**, **resample** monthly→quarterly, **gap-fill**, **merge_asof
point-in-time align**, **z-score**, **blend into a composite**. Every one of those is a modification of the
Licensed Material, and §3(a)(1)(B) requires we *say so on the surface*. The recommended wording for a
modified work:

> "*[Original Title]* by *[Author]*, used under CC BY 4.0 / Cropped from original"
> (for slight modifications), or for a real adaptation:
> "This work, '[New Title]', is adapted from '[Original Title]' by [Original Author], used under CC BY 4.0."
> — CC Recommended practices for attribution

Our render therefore appends a **change note** to any transformed CC-BY series, e.g.
`"Source: World Bank — GDP (CC BY 4.0). Rebased to 100 and resampled to quarterly by [Product]."` Dropping
the "rebased/resampled" clause on a transformed CC-BY series is a real, common violation (§7.3).

### 2.2 World Bank — CC-BY **plus** an acknowledgment format **plus** sub-license pass-through

World Bank open data is CC-BY 4.0 by default, but the World Bank Terms of Use for Datasets add **three
display duties beyond generic CC-BY** — and the third is the one almost every build misses.

**(a) The exact acknowledgment format.** Not free-form — a specified shape:

> "You agree to provide attribution to The World Bank and its data providers in the following format:
> **The World Bank: Dataset name: Data source (if known).**"
> — World Bank Terms of Use for Datasets, https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets
> (mirrored at https://data.worldbank.org/summary-terms-of-use)

So the render is not "World Bank" — it is `World Bank: World Development Indicators: [original data
source]`. The "Data source (if known)" tail matters: WDI aggregates from national statistical offices,
the IMF, the UN, etc., and where the underlying provider is named in the dataset metadata, it must appear.

**(b) The sub-license PASS-THROUGH duty (the missed one).** Because we are a *redistribution* product —
we re-serve World Bank series to our own API/batch consumers — we inherit an obligation to *bind our
consumers to the same attribution*:

> "When sharing or facilitating access to the Datasets, you agree to **include the same acknowledgment
> requirement in any sub-licenses of the data that you grant, and a requirement that any sub-licensees do
> the same.**"
> — World Bank Terms of Use for Datasets §(attribution)

**Engineering translation:** it is not enough that *we* render `World Bank: …` on our card. Our **API
terms of service** (the contract a consumer accepts to call our endpoints) and our **batch manifest /
delivery license** must *require the consumer to attribute World Bank too, and to require their consumers
to do the same.* This is a recursive contractual obligation, and the only place to discharge it is (i) the
machine-readable `attribution` field we emit (so their renderer can pick it up) **and** (ii) a clause in
*our* consumer ToS. See §5 (API field) and §6 (consumer-ToS clause). A composite built on World Bank data
that is offered to a third party with no attribution pass-through clause is in breach even if our own UI
renders perfectly.

**(c) No-endorsement + third-party carve-out** (render/behavior duties):

> "You may not publicly represent or imply that The World Bank is participating in, or has sponsored,
> approved or endorsed the manner or purpose of your use or reproduction of the Datasets."
> — World Bank Terms of Use for Datasets (no-endorsement)

> "Some datasets and indicators are provided by third parties, and may not be redistributed or reused
> without the consent of the original data provider, or may be subject to terms and conditions that are
> different from those described above."
> — World Bank Terms of Use for Datasets (third-party carve-out)

The third-party carve-out is a *gate* concern, not just a render concern: a WDI indicator sourced from a
RED third party is **not** ours to redistribute under CC-BY, even though the *envelope* is World Bank. This
is the contamination rule operating *inside* a single nominal source — confirm the underlying provider per
indicator before flipping `commercialOk:true`. (Belongs in the sources-ledger row, enforced at fetch time;
mentioned here because the *attribution render* must name the underlying provider, which is exactly the
field that tells you whether the gate is safe.)

### 2.3 OECD — CC-BY 4.0 (since July 2024) **plus** an adaptation/translation disclaimer

Since July 2024 the OECD applies CC-BY 4.0 by default to its data and publications. Generic CC-BY TASL
applies, **plus** two OECD-specific render strings for derived works:

> "Attribution – you must cite the work. For adaptations specifically, you must cite the original work and
> add the following text: **This is an adaptation of an original work by the OECD.**"
> — OECD Terms & Conditions, https://www.oecd.org/en/about/terms-conditions.html

> "When translating OECD content … you must indicate if any changes were made to the original work, and
> must add the following disclaimer along with the attribution to the original work: **'In the event of any
> discrepancy between the original work and the translation, only the text of original work should be
> considered valid'.** … you must not use the OECD logo, visual identity or cover image."
> — OECD Terms & Conditions

Because our product *adapts* (rebases/resamples/blends) OECD series, the **"This is an adaptation of an
original work by the OECD"** string is mandatory on any transformed OECD series — it is OECD's concrete
spelling of the generic CC-BY "indicate changes" duty (§2.1). Render it; do not paraphrase it.

### 2.4 IMF — CC-BY 4.0 on most public datasets, *but verify per-dataset*

The IMF moved much of its open data to CC-BY 4.0, but the IMF is the textbook case for **"the license
attaches to the fetch path, not the concept":** some IMF datasets remain under more restrictive terms, and
IMF data frequently *embeds third-party series* (e.g. provider-sourced exchange rates) that are **not**
CC-BY. Treat IMF like World Bank: generic CC-BY TASL + acknowledgment, **plus** a per-dataset confirmation
in the sources-ledger before `commercialOk:true`, **plus** the third-party carve-out check on the render
(name the underlying provider). When the IMF terms for a specific dataset are silent/ambiguous on
commercial redistribution, the verdict is RED (default), and the surface renders attribution **without**
the GREEN gate — built-against, not displayed-as-cleared. *(This row must be added to the sources-ledger
with the exact governing clause before any IMF series ships; it is not currently in the ledger.)*

### 2.5 GDELT — the exact mandatory citation + link on EVERY tone surface

GDELT is the cleanest "free + conditioned" grant we have, and the condition is a *render* condition:

> "all datasets released by the GDELT Project are available for **unlimited and unrestricted use for any
> academic, commercial, or governmental use of any kind without fee.** … **any use or redistribution of
> the data must include a citation to the GDELT Project and a link to this website
> (https://www.gdeltproject.org/).**"
> — The GDELT Project, https://www.gdeltproject.org/about.html

Our sources-ledger pins the exact rendered string the team standardized on:

> GDELT DOC 2.0 — 🟢 GREEN (conditioned): "Unlimited and unrestricted… commercial use **with mandatory
> verbatim citation + link** (**'Source: The GDELT Project (gdeltproject.org)'**). **The condition must
> render on every surface that displays it, not just sit in the payload.** Only the numeric tone is GREEN —
> underlying article headlines are third-party."
> — `.claude/memory/sources-ledger.md`, GDELT row

Two render rules fall out:

1. **Every surface that shows GDELT tone/buzz renders `Source: The GDELT Project (gdeltproject.org)` with
   a working link to https://www.gdeltproject.org/.** The sentiment chart caption, the API `attribution`
   field, the exported file — all of them. "Just sit in the payload" is named in the ledger as the failure.
2. **Tone is GREEN; the underlying article headline/text is NOT.** If a surface renders only the numeric
   tone series (a sentiment line, a buzz bar), GDELT attribution is sufficient and `commercialOk:true`. The
   moment a surface renders an *article headline* GDELT surfaced, that headline is third-party content under
   its own (typically RED) license — `commercialOk` for *that element* is `false` and you link out, you do
   not display the headline as cleared. This is a per-*element* gate within one GDELT-fed card.

### 2.6 CoinGecko — "Powered by CoinGecko" (only relevant if a paid tier flips the gate)

In the *current* ledger CoinGecko's free/Demo tier is **RED** for display (Demo is personal-use only),
so on our stack a CoinGecko series is built-against / link-out, not displayed-as-cleared. The
attribution-render duty becomes *gate-flipping* only if we ever purchase a CoinGecko commercial display
tier. If/when that happens, the render obligation is:

> "Display prominently the message 'Powered by CoinGecko' … place the attribution in a visible location,
> close to where the data is displayed, i.e. above or below the data set." Acceptable phrasings:
> "**Data provided by CoinGecko**" or "**Powered by CoinGecko API**", hyperlinked to
> https://www.coingecko.com or https://www.coingecko.com/en/api/. When using the logo, "add the text
> 'Data powered by' OR 'Price data provided by' next to the logo."
> — CoinGecko Attribution Guide, https://brand.coingecko.com/resources/attribution-guide
> (the API ToS additionally specifies a legible font no smaller than size 10:
> https://www.coingecko.com/en/api_terms)

Pin the placement rule — **"close to where the data is displayed, above or below the data set"** — because
it forbids burying the credit on a far-off page for CoinGecko (unlike CC-BY's link-to-a-page allowance,
CoinGecko wants it *adjacent*). Ledger note: our current CoinGecko row stays RED; this section exists so
the render is *ready* the day the gate legitimately flips, not so we render it now.

### 2.7 Public-domain US-gov sources (SEC EDGAR, Treasury, BLS, CFTC) — no *legal* attribution duty, but render a courtesy source line + honor the fair-access ToS

17 USC §105 public-domain sources impose **no copyright attribution condition** — there is no license to
honor because there is no copyright. You *may* display Treasury/BLS/EDGAR numbers with no credit and not
breach a license. **Render a source line anyway**, for three non-license reasons:

1. **Grounding / "never invent a number."** The source line is the user-visible proof the number was
   *fetched and grounded*, not fabricated. It is part of our trust contract even when no law requires it.
2. **EDGAR's operational ToS** is not a copyright condition but is still binding: a descriptive
   `User-Agent` and ≤10 req/s fair-access (sources-ledger, SEC EDGAR row). That governs the *fetch*, not
   the render — but the render's source line is what makes the data's origin auditable.
3. **Uniformity.** A dashboard where some series cite a source and some don't trains the reader that the
   credit is decorative. Render a consistent `Source: …` line everywhere; for public-domain sources it
   carries *no license URI and no change-note duty*, which the component encodes as `commercialOk:true,
   licenseUrl:null`.

---

## §3 — Where it must render (every surface)

The obligation is per-*surface*, and a data product has more surfaces than a UI dev usually counts. The
exhaustive list, with the discharge mechanism for each:

| Surface | What "Sharing" looks like here | Discharge mechanism | Most-common miss |
|---|---|---|---|
| **Web card footer** | Series shown on a dashboard card | `<Attribution provenance>` in the card footer | none (usually present) |
| **Chart caption** | A line/candle/area chart of the series | caption under the chart axis, or an info-icon popover with the full TASL | credit on the *card* but the chart screenshot/export has none |
| **JSON API response** | `GET /series` returns the data to a machine consumer | an `attribution` object **in the envelope** (§5) | **stripped from the API** while present on the web (§7.2) |
| **Exported file (Parquet/CSV)** | A batch job writes the series to a file the consumer downloads | a **manifest** sidecar + embedded file-level metadata (§5.3) | file has data, zero provenance — opened 6mo later, untraceable |
| **Email / SFTP / S3 delivery** | The batch channel pushes the file to a consumer | attribution in the delivery email body **and** the manifest **and** the file metadata | email "your data is ready" with a bare file, no credit anywhere |
| **A consumer's OWN re-display** | Our consumer renders our (World Bank-derived) data | the **pass-through clause** in our consumer ToS + the machine-readable `attribution` they can pick up (§6) | we attribute; we never *require them* to → World Bank pass-through breach |

**The governing principle:** *find every boundary where the bytes leave our control and reach a viewer
(human or machine), and render at each one.* A boundary with no render is an undischarged Share. The batch
channel (`dataquery-delivery-channels`) and the time-series query API are *two more surfaces* that the UI
team often forgets — they are where the pass-through duty and the "stripped from API/export" anti-pattern
live.

---

## §4 — The composite case: render the UNION of all conditioned inputs' attributions

A derived series — "Global Growth Pulse" = z-scored blend of (World Bank GDP) + (OECD CLI) + (GDELT
economic tone) — is a single line on a chart, but it is **Shared from three Licensed Materials at once.**
The render must show **all three** attributions.

### 4.1 The union rule, stated

> **The composite's `attribution` is the union of the attributions of every conditioned input that
> contributes to it.** Each input that has a render duty contributes its full required credit (TASL +
> change note + any source-specific string). Public-domain inputs contribute a courtesy source line.
> Nothing is dropped because "it's just one of several."

This pairs with — and is distinct from — the **contamination rule** for the gate:

| Rule | Governs | Direction |
|---|---|---|
| **Contamination** (gate) | `commercialOk` of the composite | **AND of strictness** — one RED input ⇒ composite RED |
| **Union** (attribution) | `attribution` of the composite | **OR of obligations** — every conditioned input's credit must render |

A composite of two GREEN CC-BY sources is GREEN (gate) **and** must render *both* credits (union). A
composite of one GREEN + one RED is RED (gate, contamination) **and** still must render *both* credits
(union) — the RED one because you built against it and must attribute even when you don't claim a display
license, the GREEN one because it's conditioned. Forgetting either credit is a violation; the gate being
RED does not excuse you from attributing the inputs.

### 4.2 The change note is *mandatory* on every composite

A composite is, by definition, an **adaptation** of each CC-BY input (§2.1's "indicate changes"). So every
composite carries a change note naming the transform:

```
Sources: World Bank — GDP (CC BY 4.0); OECD — Composite Leading Indicator (CC BY 4.0,
  "This is an adaptation of an original work by the OECD"); The GDELT Project (gdeltproject.org).
Composite computed by [Product]: z-scored and blended. Not the original works.
```

The "Composite computed by … Not the original works" tail discharges §3(a)(1)(B) for **all** CC-BY inputs
at once and, critically, prevents the **no-endorsement** breach (§2.2(c), §2.3): it makes explicit that the
blend is *ours*, so no reader infers the World Bank or OECD endorsed or produced the composite.

### 4.3 Carrying the union through the pipeline

The composite's provenance is computed *where the composite is computed* — in the transform/aggregation
layer — by merging the input stamps:

```python
# patterns: building the composite provenance (union of inputs) — Python side (TET / aggregation layer)
from dataclasses import dataclass, field

@dataclass(frozen=True)
class Attribution:
    source: str                 # "World Bank — World Development Indicators"
    license: str | None         # "CC BY 4.0"  (None for public-domain)
    license_url: str | None     # "https://creativecommons.org/licenses/by/4.0/"
    source_url: str             # canonical link back to the Licensed Material
    required_string: str | None = None   # exact mandated string, e.g. GDELT's / OECD's
    changes: str | None = None  # "rebased to 100; resampled to quarterly"
    commercial_ok: bool = False # the gate for THIS input's fetch path

@dataclass(frozen=True)
class Provenance:
    attributions: tuple[Attribution, ...]  # the UNION — never a single string
    commercial_ok: bool                    # AND-of-strictness over inputs (contamination)
    computed_by: str | None = None         # "z-scored blend by [Product]" — the composite change note

def merge_provenance(inputs: list[Provenance], computed_by: str) -> Provenance:
    """Union the attributions; AND the gate (one RED ⇒ composite RED)."""
    attrs: list[Attribution] = []
    seen: set[tuple] = set()
    for p in inputs:
        for a in p.attributions:
            key = (a.source, a.license, a.source_url)   # de-dupe identical inputs
            if key not in seen:
                seen.add(key)
                attrs.append(a)
    gate = all(p.commercial_ok for p in inputs)         # contamination rule
    return Provenance(attributions=tuple(attrs), commercial_ok=gate, computed_by=computed_by)
```

**Two non-negotiables encoded above:** (1) `attributions` is a **tuple/list, never a single joined
string** — joining early destroys the structure the renderer needs to link each source separately and to
emit the per-source `required_string`. (2) the gate is `all(...)` (AND), the attribution is the de-duped
**union** (OR). Get these backwards and you ship either an over-permissive gate (one RED input silently
GREEN) or a lossy credit (one source's mandated string dropped).

---

## §5 — The reusable render: `<Attribution provenance>` + the API field convention

The whole recipe collapses to one rule: **never hand-write an attribution at a call site.** Make the
provenance stamp the single source, and have *one* component render it for the DOM and *one* serializer
emit it for the API/file. Two renderers, one data shape — so a new surface can never "forget."

### 5.1 The envelope shape (one shape, every surface reads it)

```ts
// frontend/src/lib/finance-api.ts already has a flat Provenance:
//   { source, commercialOk, attribution, unit? }
// The composite/union upgrade makes `attributions` a LIST. Both shapes below; prefer the list.

export interface AttributionEntry {
  source: string;            // "World Bank — World Development Indicators"
  license: string | null;    // "CC BY 4.0" | null (public-domain)
  licenseUrl: string | null; // "https://creativecommons.org/licenses/by/4.0/"
  sourceUrl: string;         // canonical link back to the material
  requiredString: string | null; // exact mandated string (GDELT / OECD), rendered verbatim
  changes: string | null;    // "rebased to 100; resampled to quarterly"
  commercialOk: boolean;     // gate for THIS source's fetch path
}

export interface Provenance {
  attributions: AttributionEntry[]; // the UNION — drives every render
  commercialOk: boolean;            // AND-of-strictness (contamination)
  computedBy?: string | null;       // composite change note ("z-scored blend by [Product]")
}
```

### 5.2 The DOM component (`<Attribution>`)

Anchored to the existing `ProvenanceLine` in `frontend/src/components/finance/finance-view.tsx:1292`
(GREEN dot = cleared, AMBER dot = attribute/link-out) — this generalizes it to the union + the
link-to-page allowance + the required-string + the change note.

```tsx
// A reusable attribution renderer. Drop into any card footer / chart caption.
// Compact mode renders a one-line credit + a "Sources" link to the full /attributions page
// (CC-BY §3(a)(2) link allowance). Full mode renders the complete TASL per source.
import { cn } from "@/lib/utils";
import type { Provenance, AttributionEntry } from "@/lib/finance-api";

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      title={ok ? "Cleared for commercial display" : "Attribution / link-out only"}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", ok ? "bg-emerald-500" : "bg-amber-500")}
    />
  );
}

function OneEntry({ a }: { a: AttributionEntry }) {
  return (
    <span className="inline">
      <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
        {a.source}
      </a>
      {a.license && (
        <>
          {" ("}
          {a.licenseUrl ? (
            <a href={a.licenseUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
              {a.license}
            </a>
          ) : (
            a.license
          )}
          {")"}
        </>
      )}
      {/* the exact mandated string (GDELT / OECD) — rendered verbatim, never paraphrased */}
      {a.requiredString && <span className="ml-1">— {a.requiredString}</span>}
      {/* CC-BY §3(a)(1)(B): indicate changes on a transformed series */}
      {a.changes && <span className="ml-1 italic">· {a.changes}</span>}
    </span>
  );
}

/**
 * <Attribution provenance>  — the ONE attribution renderer.
 *  - `variant="compact"` (default): a single credit line + a "Sources" link to /attributions.
 *  - `variant="full"`: the complete TASL for every source (use on the /attributions page itself
 *    and in chart-caption popovers).
 */
export function Attribution({
  provenance,
  variant = "compact",
  className,
}: {
  provenance: Provenance;
  variant?: "compact" | "full";
  className?: string;
}) {
  const { attributions, commercialOk, computedBy } = provenance;
  if (!attributions?.length) {
    // FAIL LOUD: a series with no attribution is a bug, not a blank footer. A conditioned
    // series MUST carry its credit. Surfacing nothing silently is how the violation ships.
    if (import.meta.env.DEV) {
      console.error("[Attribution] series rendered with no attributions — license render obligation unmet", provenance);
    }
    return null;
  }

  if (variant === "full") {
    return (
      <div className={cn("space-y-1 text-[11px] text-muted-foreground", className)}>
        {attributions.map((a, i) => (
          <div key={`${a.source}-${i}`} className="flex items-start gap-2">
            <Dot ok={a.commercialOk} />
            <OneEntry a={a} />
          </div>
        ))}
        {computedBy && <div className="pl-3.5 italic">Composite computed by {computedBy} — not the original works.</div>}
      </div>
    );
  }

  // compact: first source inline + count + a single link to the full /attributions page
  const [first, ...rest] = attributions;
  return (
    <div className={cn("mt-3 flex items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground", className)}>
      <Dot ok={commercialOk} />
      <span className="min-w-0 truncate">
        <OneEntry a={first} />
        {rest.length > 0 && <span className="ml-1">+ {rest.length} more</span>}
      </span>
      {/* CC-BY §3(a)(2): the link-to-a-resource allowance — the full TASL lives on /attributions */}
      <a href="/attributions" className="ml-auto shrink-0 underline-offset-2 hover:underline">
        Sources
      </a>
    </div>
  );
}
```

**Design decisions worth their lines:**

- **`attributions` is a list, the component owns the union render.** No call site ever concatenates
  credits — the §4 union rule is enforced by *data shape*, not by reviewer vigilance.
- **`requiredString` renders verbatim.** GDELT's `Source: The GDELT Project (gdeltproject.org)` and
  OECD's `This is an adaptation of an original work by the OECD` are mandated *exact strings* — the
  component prints them as-is, never paraphrased, never localized.
- **`changes` is a first-class field, always rendered when present.** This is how "indicate changes"
  (§2.1, the most-dropped duty) becomes *impossible to forget*: if the transform stage set `changes`,
  the renderer shows it.
- **Empty attribution fails loud in dev.** A conditioned series reaching render with no credit is a bug;
  the component logs it rather than rendering a silent (violating) blank.
- **The `/attributions` page is the §3(a)(2) "resource that includes the required information."** It
  renders `variant="full"` for every series currently on screen. The compact footer's "Sources" link is
  the discharge for space-constrained surfaces.

### 5.3 The API + file convention (the surfaces UIs forget)

**JSON API response** — every series-returning endpoint embeds the provenance in the envelope. This is the
machine-readable discharge that lets a downstream consumer's renderer pick up the credit (and is half of
the World Bank pass-through duty — the other half is the ToS clause, §6):

```jsonc
// GET /v1/series/global-growth-pulse?range=5y  → 200
{
  "data": [ { "t": 1717200000, "v": 102.4 }, /* … */ ],
  "provenance": {
    "commercialOk": false,                       // contamination: one RED input ⇒ RED composite
    "computedBy": "z-scored blend by [Product]",
    "attributions": [
      {
        "source": "World Bank — World Development Indicators",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "sourceUrl": "https://data.worldbank.org/indicator/NY.GDP.MKTP.CD",
        "requiredString": "The World Bank: World Development Indicators: national sources",
        "changes": "rebased to 100; resampled to quarterly",
        "commercialOk": true
      },
      {
        "source": "OECD — Composite Leading Indicators",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "sourceUrl": "https://www.oecd.org/...",
        "requiredString": "This is an adaptation of an original work by the OECD.",
        "changes": "z-scored",
        "commercialOk": true
      },
      {
        "source": "The GDELT Project",
        "license": null,
        "licenseUrl": null,
        "sourceUrl": "https://www.gdeltproject.org/",
        "requiredString": "Source: The GDELT Project (gdeltproject.org)",
        "changes": "tone aggregated; daily mean",
        "commercialOk": true
      }
    ]
  },
  "meta": { "asOf": "2026-06-24T00:00:00Z", "frequency": "quarterly" }
}
```

**Exported file (Parquet/CSV)** — two discharges, because the file outlives the request:

1. **A manifest sidecar** (`<file>.manifest.json`) carrying the *same* `provenance` block above, plus the
   file fingerprint and asOf. This is the batch channel's render surface.
2. **Embedded file-level metadata** so the credit survives even if the manifest is separated from the file.
   Parquet supports key-value file metadata; write the attribution + license there:

```python
# patterns: embed attribution in the Parquet file itself (survives manifest loss)
import json
import pyarrow as pa
import pyarrow.parquet as pq

def write_with_provenance(table: pa.Table, path: str, provenance: dict) -> None:
    # Parquet file-level key/value metadata — opens with the file, not a sidecar.
    meta = {
        b"x-provenance": json.dumps(provenance).encode("utf-8"),
        b"x-attribution": "; ".join(   # a human-readable one-liner for `parquet meta`
            f"{a['source']} ({a['license']})" if a.get("license") else a["source"]
            for a in provenance["attributions"]
        ).encode("utf-8"),
        b"x-license-note": b"See x-provenance for full TASL, required strings, and change notes.",
    }
    existing = table.schema.metadata or {}
    table = table.replace_schema_metadata({**existing, **meta})
    pq.write_table(table, path)
```

For CSV (no metadata channel), write a comment-prefixed header block **and** the sidecar manifest:

```
# Source: World Bank — World Development Indicators (CC BY 4.0) — The World Bank: WDI: national sources — rebased to 100; resampled to quarterly
# Source: OECD — Composite Leading Indicators (CC BY 4.0) — This is an adaptation of an original work by the OECD. — z-scored
# Source: The GDELT Project (gdeltproject.org)
# Composite computed by [Product]: z-scored blend — not the original works.
t,v
1717200000,102.4
```

**Email / SFTP / S3 delivery** — the delivery notification body renders the same one-liner credit, and the
manifest travels with the file. A "your extract is ready" email with a bare download link and no credit is
an undischarged Share (§3, §7.2).

---

## §6 — The pass-through clause (World Bank / OECD / IMF) — where it actually lives

The pass-through duty (§2.2(b)) cannot be discharged by a render alone — it is a *contractual* obligation
to bind your consumer. It lives in **two** places, both required:

1. **Machine-readable** — the `attribution` block in the API/manifest (§5.3). This *enables* the consumer
   to attribute (they can read your `requiredString` and render it). Necessary, not sufficient.
2. **Contractual** — a clause in *our* consumer Terms of Service / data-license agreement that *requires*
   them to. This is the actual discharge of "a requirement that any sub-licensees do the same." Template:

> **Attribution pass-through.** Certain datasets made available through the API are sourced from third
> parties (including The World Bank and the OECD) under the Creative Commons Attribution 4.0 license. Where
> a response's `provenance.attributions[]` includes such a source, you must (a) reproduce that
> attribution — including the source name, the license, the link, and any `requiredString` and `changes`
> note — on every surface where you display or redistribute the data, and (b) impose this same attribution
> requirement on any party to whom you further redistribute the data, and require them to do the same.

Without clause (b), a World Bank-derived endpoint offered to a third party is in breach **even if every
one of our own surfaces renders perfectly** — because the World Bank ToS obligates us to *bind our
downstream*, recursively. This is the single most-missed obligation in the whole recipe, because it is
invisible in our own UI: our pixels look compliant while the contract underneath is not.

---

## §7 — Anti-pattern gallery (mistake → fix)

### 7.1 Attribution in the JSON/metadata but not the DOM

**Mistake.** `provenance.attribution` is perfectly populated on the row and in the API envelope, but the
web card renders only the number and the chart — no caption, no footer credit. The team believes "we store
it, so we're covered."
**Why it breaks.** The license condition activates on *Sharing* = display (§1.1). The DOM is a Share; the
unrendered string discharges nothing there. Storing the credit is necessary but not sufficient.
**Fix.** Every card/chart that shows a conditioned series renders `<Attribution provenance>`. The component
fails loud in dev if a series reaches render with no attribution (§5.2), so this can't ship silently.

### 7.2 Attribution on the web page but stripped from the API / export

**Mistake.** The dashboard renders credits beautifully, but `GET /series` returns `{ data: [...] }` with no
provenance, and the Parquet export is bare data. "The API is for machines, machines don't need credits."
**Why it breaks.** The API consumer is a *surface* — returning the data to them is a Share (§3). And it
breaks the World Bank/OECD **pass-through** duty doubly: the consumer *can't* attribute what we didn't send
them, and we never *required* them to (§6). The bare export is the worst case — opened six months later, it
is untraceable data of unknown license.
**Fix.** The envelope carries `provenance.attributions[]` on every series response (§5.3); the batch
manifest + embedded Parquet metadata carry it on every file; the consumer ToS carries the pass-through
clause (§6). One serializer emits the same shape the DOM component reads.

### 7.3 "Changes made" omitted on a transformed CC-BY series

**Mistake.** A World Bank GDP series is rebased to 100 and resampled to quarterly, then rendered as
"Source: World Bank (CC BY 4.0)" — with no indication it was modified.
**Why it breaks.** CC-BY §3(a)(1)(B) requires you to "indicate if You modified the Licensed Material." A
rebased/resampled/blended series *is* modified. OECD spells this out as a mandatory verbatim string
("This is an adaptation of an original work by the OECD"). Omitting the change note is a real, common
license breach — and it also risks the **no-endorsement** breach, because an unmarked transform implies the
World Bank/OECD published *your* numbers.
**Fix.** The transform stage sets `changes` on the attribution (and `computedBy` on the composite). The
`<Attribution>` component always renders `changes` when present (§5.2). For OECD/World Bank, render the
mandated adaptation/disclaimer string verbatim.

### 7.4 Joining the union into one string at the data layer

**Mistake.** `provenance.attribution = "World Bank, OECD, GDELT"` — a single pre-joined string.
**Why it breaks.** It destroys structure: you can no longer link each source separately, render each
`requiredString` verbatim, attach each `changes` note, or let a downstream consumer's parser pick up
individual credits. GDELT's exact mandated string and OECD's exact disclaimer get smeared into an
un-compliant blob.
**Fix.** `attributions` is always a **list of structured entries** (§4.3, §5.1); the renderer/serializer
produces the human/JSON output from the structure. Never join early.

### 7.5 Attributing "Creative Commons" or the platform instead of the creator

**Mistake.** "Data licensed by Creative Commons" or "Source: our data provider."
**Why it breaks.** CC's recommended practices explicitly flag this: do not attribute the work to "Creative
Commons" (the org, not an author) and do not credit the platform instead of the actual creator. CC-BY
§3(a)(1)(A)(i) requires identifying *the creator(s)*.
**Fix.** `source` names the actual creator/licensor (World Bank, OECD, GDELT Project), `license` names the
license, and they are separate fields rendered separately.

### 7.6 Dead or generic link target

**Mistake.** The "Sources" link points to the product homepage, or the `sourceUrl` 404s, or the
`/attributions` page doesn't list the series actually on screen.
**Why it breaks.** The §3(a)(2) link allowance only discharges the duty if the linked resource *contains
the required information*. A link to nothing discharges nothing.
**Fix.** `sourceUrl` is the canonical material link (validated at ingest); `/attributions` renders
`variant="full"` for *every series currently rendered*, driven by the same provenance stamps — so it can
never drift out of sync with what's on screen.

### 7.7 GDELT credit "sits in the payload" but never renders on the tone chart

**Mistake.** The GDELT `requiredString` is in the JSON, but the sentiment chart caption shows only "Market
Sentiment" with no GDELT credit/link.
**Why it breaks.** The sources-ledger pins this exact failure: "The condition must render on **every
surface** that displays it, not just sit in the payload." The chart is a surface; the credit must render
there with a working link to gdeltproject.org.
**Fix.** `<Attribution>` in the chart caption (or an info-popover that's always reachable), rendering
`Source: The GDELT Project (gdeltproject.org)` verbatim with the link. And: if the surface ever shows an
*article headline* (not just the numeric tone), that headline is third-party RED — link out, don't display.

### 7.8 Rendering CoinGecko/RED-tier data as cleared because the credit is present

**Mistake.** "We added 'Powered by CoinGecko', so we can display the Demo-tier data commercially."
**Why it breaks.** Attribution and the `commercialOk` gate are *orthogonal*. The CoinGecko Demo tier is
RED for display regardless of attribution (sources-ledger). Rendering the credit does not buy a display
license; only a purchased commercial tier flips the gate (§2.6).
**Fix.** Keep `commercialOk:false` for RED fetch paths even when attributed; render the AMBER dot +
link-out, not the GREEN "cleared" dot. Attribution is a *condition you must meet when you have a license*,
not a *substitute for having one*.

### 7.9 No-endorsement breach via logo/branding

**Mistake.** Rendering the World Bank or OECD *logo* next to our composite, or phrasing the credit as
"In partnership with the OECD."
**Why it breaks.** World Bank: "You must not … use The World Bank's name, logo(s) or trademark(s) in
conjunction with such use" / "imply that The World Bank … endorsed" your use. OECD: "you must not use the
OECD logo, visual identity." Logos imply endorsement.
**Fix.** Render the source *name as text*, never the logo, for these sources; the `computedBy` note makes
clear the composite is ours. (Contrast CoinGecko, whose terms *permit* their logo with the prescribed
wording — §2.6. The rule is per-source: read the terms, don't generalize.)

---

## §8 — Output contract (what "attribution rendering done" means)

A surface passes review only if **all** hold:

- [ ] **Every conditioned series renders a visible credit on every surface it appears on** — web card,
      chart caption, JSON envelope, exported file + manifest, delivery email. No surface is exempt.
- [ ] The credit names **the actual creator** (not "Creative Commons", not the platform), the **license**
      (linked), and a **working source link**.
- [ ] **Transformed CC-BY series carry a change note** ("rebased/resampled/blended"); OECD/World Bank
      transforms render the **mandated adaptation string verbatim**.
- [ ] **GDELT tone surfaces render `Source: The GDELT Project (gdeltproject.org)` + a working link**;
      GDELT article headlines (if shown) are treated as third-party RED (link-out, not display).
- [ ] **Composites render the UNION** of all conditioned inputs' attributions (list, not a joined string),
      plus the `computedBy` "not the original works" note.
- [ ] The **API response and exported file carry the same structured `provenance.attributions[]`** the DOM
      reads — never stripped for "machines."
- [ ] For World Bank / OECD / IMF data re-served to consumers, the **consumer ToS contains the
      attribution pass-through clause** (§6), and the machine-readable attribution is present so they *can*
      comply.
- [ ] `commercialOk` is rendered **orthogonally** to attribution: a RED fetch path shows the AMBER /
      link-out treatment even when fully attributed; attribution never flips the gate.
- [ ] Public-domain (US-gov) series render a **courtesy source line** (grounding/trust), with no license
      URI and no change-note duty.
- [ ] The render is **driven by the provenance stamp**, not hand-written at call sites — one DOM component
      (`<Attribution>`) and one serializer, both reading one shape, so a new surface cannot silently omit.

> **The one-line test:** *for each series, on each surface a viewer (human or machine) reaches, can they
> read who made it, under what license, with the changes we made, via a working link — and, for World
> Bank/OECD/IMF, are our own consumers contractually bound to do the same?* If any answer is no on any
> surface, the license is not satisfied — no matter how clean the stored metadata looks.

---

## Sources

- CC BY 4.0 legalcode §2(a), §3(a)(1), §3(a)(2) — grant + attribution + "indicate changes" + link
  allowance — https://creativecommons.org/licenses/by/4.0/legalcode.en
- CC Recommended practices for attribution (TASL, ideal/acceptable examples, modified-work wording,
  offline/multi-source guidance) — https://wiki.creativecommons.org/wiki/Recommended_practices_for_attribution
- CC BY 4.0 deed (the three-line "give credit, link the license, indicate changes" summary) —
  https://creativecommons.org/licenses/by/4.0/deed.en
- World Bank Terms of Use for Datasets (acknowledgment format, sub-license pass-through, no-endorsement,
  third-party carve-out) — https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets ·
  mirror: https://data.worldbank.org/summary-terms-of-use · catalog: https://datacatalog.worldbank.org/public-licenses
- OECD Terms & Conditions (CC-BY since July 2024; adaptation string; translation disclaimer; no-logo) —
  https://www.oecd.org/en/about/terms-conditions.html
- The GDELT Project — terms (unlimited/unrestricted use + mandatory citation + link to gdeltproject.org) —
  https://www.gdeltproject.org/about.html
- CoinGecko Attribution Guide ("Powered by CoinGecko"/"Data provided by", placement, logo wording) —
  https://brand.coingecko.com/resources/attribution-guide · API ToS (font/size): https://www.coingecko.com/en/api_terms
- Internal: `.claude/memory/sources-ledger.md` (GDELT row — exact mandated string + "render on every
  surface, not just the payload"; CoinGecko Demo = RED; World Bank = CC-BY; the contamination rule)
- Internal anchors: `frontend/src/lib/finance-api.ts` (the `Provenance` type) ·
  `frontend/src/components/finance/finance-view.tsx:1292` (`ProvenanceLine`, the GREEN/AMBER dot pattern
  this recipe generalizes) · `:325` (the `Section` `attribution` slot) · `:338` (TradingView attribution
  link "required by their ToS and must stay" — a live example of a render obligation already honored)
