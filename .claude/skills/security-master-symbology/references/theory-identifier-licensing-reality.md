# theory · Identifier Licensing Reality — the verified, primary-source verdict for every symbology identifier

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (the DataQuery/Fusion/Athena
> re-engineering — Projects 3 & 1). **NOT Lumina.** This is greenfield: Python/FastAPI/Pydantic data-plane,
> separate from Lumina's Bun + Express + Prisma + Supabase + Upstash stack.
>
> **Why this doc is the most load-bearing in the skill.** The security-master / symbology layer is the
> spine of every other data product: every quote, every time-series, every screener row is keyed by an
> instrument identity, and *cross-referencing* identities (ISIN→FIGI→ticker→CUSIP) is the join that lets
> us blend providers. The whole pitch — "we re-engineered DataQuery/Fusion to be *more valuable* and
> reach use-cases the incumbents can't" — only survives if our **identifier licensing is correct**. Get it
> wrong and we either (a) ship a number we have no right to display and inherit S&P/LSEG/ANNA legal
> exposure, or (b) over-block and lose the cross-reference that is the product. The edge here is precisely
> **"licensing as a headline feature":** an open security master that says, per identifier, exactly which
> codes you may *display* and which you may only *join on internally* — something the incumbents bury in a
> contract. To sell that, the verdicts below must each be backed by the **issuer's own license text,
> quoted verbatim, cross-verified against ≥1 independent source.** Every verdict in this doc is.

**Pinned as of 2026-06-24.** License terms change; re-confirm the quoted text against the cited primary URL
before any production launch. Where a verdict turns on live litigation (CUSIP), the litigation status is
stated and the conservative verdict is held until resolution.

---

## 0. TL;DR — the verdict table (read this first, then the proof)

| Identifier | Issuer / authority | Anchor on it? | Join-IN on it? | **DISPLAY / redistribute (`commercialOk`)?** | Ledger color | License basis (quoted below) |
|---|---|---|---|---|---|---|
| **FIGI** | Bloomberg / OMG | ✅ **yes — primary anchor** | ✅ yes | ✅ **`true`** | 🟢 GREEN | Public-domain dedication; MIT licence embedded in the standard |
| **LEI** | GLEIF | ✅ yes (entity anchor) | ✅ yes | ✅ **`true`** | 🟢 GREEN | CC0 1.0 Universal |
| **ISIN** | ANNA / NNAs | ❌ no | ✅ yes (≤1,000/day, internal) | ❌ **`false`** | 🔴 RED | ANNA "solely for internal use"; ≤1,000 records/day |
| **CUSIP** | CGS (FactSet, ABA-owned IP) | ❌ no | ⚠️ only if licensed | ❌ **`false`** | 🔴 RED | CGS paid licence; "not … onward distribution … or commercialization" (litigated; held RED) |
| **SEDOL** | LSEG | ❌ no | ⚠️ only if licensed | ❌ **`false`** | 🔴 RED | Masterfile distribution licence; "not permitted to redistribute … in the original format"; annual reporting |
| **DTI** | DTIF / Etrading Software | ⚠️ for digital tokens, with caveat | ✅ yes | ⚠️ **`false` in v1** (caveat logged) | 🟡 AMBER | Non-profit cost-recovery, open-data principles, FRAND — but **no PD/CC0 artifact** |

**The one-line rule this table encodes:** *anchor on and display only the two identifiers with an explicit
open-data legal artifact (FIGI = public domain, LEI = CC0). Everything else is a **crosswalk-IN-only** key:
store it to JOIN, strip it before the read/distribution boundary.* The rest of this doc proves each row.

---

## 1. The principle: the license attaches to the FETCH PATH, not the concept

This is the single mental model that makes the whole table derivable instead of memorized. It is the
**`commercial-ok-gate`** restated for symbology.

> **The license attaches to the FETCH PATH, not the concept.** The US-Treasury 10Y yield fetched from
> treasury.gov is public-domain GREEN; the *exact same number* from Yahoo's chart API is RED. You cannot
> reason about licensing from the data *type* — only from *where you fetched it.*
> — `commercial-ok-gate.md`, this repo's rules

**Applied to identifiers, the same fact-vs-fetch-path split is even sharper, because an identifier is
*purely* a fact** — a string that designates a real-world instrument, no creativity in it. Naively you'd
conclude every identifier is uncopyrightable and therefore free. **That conclusion is wrong, and the error
is worth a billion dollars** (literally — see CUSIP §3.2). Here is why:

1. **The *value* (the 12-char ISIN `US0378331005`) may well be an uncopyrightable fact.** The CUSIP
   plaintiffs argue exactly this (§3.2), and *Feist Publications v. Rural Telephone* (499 U.S. 340, 1991)
   holds that facts and the "sweat of the brow" of compiling them are not copyrightable
   ([supreme.justia.com/cases/federal/us/499/340](https://supreme.justia.com/cases/federal/us/499/340/)).

2. **But you do not obtain the value from the platonic realm of facts — you obtain it from a *database*,
   under that database's *contract*.** ANNA, CGS, and LSEG do not (only) rely on copyright. They rely on:
   - **contract / licence terms** you accept to access the database (the ToS, the subscriber agreement),
   - **the compilation/database right** over the *aggregate* (even *Feist* leaves selection/arrangement of
     a whole DB protectable; and in the EU the *sui generis* database right protects substantial extraction
     regardless of originality), and
   - **antitrust-enabled market power** — being the sole gatekeeper of the issuance pipeline.

3. **Therefore the verdict is a property of the fetch path (which database, under which contract), not of
   the string.** The *same* ISIN value:
   - pulled from **OpenFIGI's mapping** (FIGI's public-domain payload that *happens to include* an ISIN
     field) is governed by FIGI's PD terms for the FIGI, but the **ISIN field still carries ANNA's terms**
     (the contamination rule — §6);
   - pulled from a **CGS-licensed feed** is governed by the CGS licence;
   - pulled from the **GLEIF ISIN-to-LEI relationship file** (§2.2) is CC0 *for the relationship/LEI*, but,
     again, the ISIN token within it is the ANNA-issued value.

**So the operative question is never "is an ISIN copyrightable?" (interesting, unsettled, and not our
risk to litigate). It is: "what is the license of the database I fetched this string from, and what does
that license permit me to DISPLAY or REDISTRIBUTE?"** Two issuers — Bloomberg (FIGI) and GLEIF (LEI) —
have *answered that question for us in writing* with an open-data artifact. Everyone else has answered it
with a restrictive contract. That asymmetry **is** the table in §0.

> **Conservatism rule (from the gate).** "When a ToS is silent or ambiguous about commercial
> redistribution/display, the verdict is RED." Default `commercialOk: false`; flip to `true` **only** on
> an explicit open-data artifact whose text you have read and quoted. This doc flips exactly two rows.

---

## 2. GREEN — anchorable + redistributable + `commercialOk: true`

These two carry an **explicit, public open-data legal artifact**. They are the only identifiers we both
**anchor** the security master on and **display/redistribute**.

### 2.1 FIGI — Financial Instrument Global Identifier (Bloomberg / OMG) — 🟢 the primary anchor

**Verdict: GREEN. Anchor the entire security master on FIGI.** It is the only instrument-level identifier
that is simultaneously (a) free to *obtain* via a public API, (b) explicitly dedicated to the **public
domain**, and (c) covers *all* asset classes globally with a stable, never-reused 12-char code.

**Primary license text — the public-domain dedication.** From the OpenFIGI Terms of Service
([openfigi.com/docs/terms-of-service](https://www.openfigi.com/docs/terms-of-service)):

> "Bloomberg Finance L.P. … hereby **dedicates FIGI Identifiers to the public domain** and makes FIGI
> Identifiers available to the public at large for free"

> "FIGI Identifiers may be **freely reproduced, distributed, transmitted, used, modified, built upon, or
> otherwise exploited by anyone for any purpose, commercial or non-commercial**"

This is an unambiguous public-domain dedication that *names commercial use*. It clears the
`commercial-ok-gate` on its face: a public-domain dedication is the textbook GREEN basis (the gate lists
"public-domain (e.g. US-gov, 17 USC §105)" first).

**Cross-verification (independent source #1):** the FIGI standard is published by the **Object Management
Group (OMG)**, an international non-profit standards body, and the standard *embeds an MIT open-source
license* — meaning the openness is part of the spec, not just a website ToS that could be revised:

> "FIGI is offered to the public domain under the **MIT Open Source license** and has no restrictions on
> use or redistribution. … the MIT Open Source declaration is embedded in the standard, ensuring its
> status as Open Data in perpetuity."
> "There is no cost recovery, licensing or re-use restrictions or hidden fees for access, use, or
> redistribution of the FIGI symbology. … FIGIs **and the associated metadata defined in the standard** are
> released free into the public domain with no commercial terms or restrictions on usage."
> — OpenFIGI / OMG (cross-confirmed via Wikipedia's FIGI article and the OMG FIGI standard page
> [omg.org/figi](https://www.omg.org/figi/), [omg.org/intro/FIGI.pdf](https://www.omg.org/intro/FIGI.pdf))

**Cross-verification (independent source #2):** US regulatory recognition. In **September 2021** FIGI was
recognized as an official US data standard, after a multi-year process
([openfigi.com/insights/all/2021/9/15/after-lengthy-fight-bloombergs-figi-recognized-as-official-us-data-standard](https://www.openfigi.com/insights/all/2021/9/15/after-lengthy-fight-bloombergs-figi-recognized-as-official-us-data-standard)).
A US-government-recognized, OMG-published, MIT-licensed standard is as hard a GREEN artifact as exists in
private-sector symbology.

**THE ONE NUANCE — "Related Security Descriptions" are AS-IS, not warranted (but still PD).** Bloomberg
draws a line between (i) the *FIGI value itself* and (ii) the descriptive metadata Bloomberg ships
alongside it (name, security type, exchange code, etc.), which the ToS calls **"Related Security
Descriptions."** Both are covered by the PD/MIT terms, but the metadata carries a separate **AS-IS
no-warranty** disclaimer:

> "FIGI Identifiers and **Related Security Descriptions are provided 'AS IS,'** with no representations or
> warranties of any kind, express or implied"
> — OpenFIGI ToS ([openfigi.com/docs/terms-of-service](https://www.openfigi.com/docs/terms-of-service))

> "Related Security Descriptions … the descriptions of associated securities and financial instruments
> provided by Bloomberg … Bloomberg states that it attempts to ensure the integrity and accuracy of FIGI
> identifiers and Related Security Descriptions, but **makes no guarantee** as to their correctness or
> accuracy" — OpenFIGI ToS (as summarized from the same document)

**What this means for our build (do NOT skip this):**
- The **AS-IS clause is a *quality* disclaimer, not a *licensing* restriction.** It does not move FIGI off
  GREEN. We may display both the FIGI and its Related Security Descriptions commercially.
- But AS-IS interacts with our **non-negotiable #1 ("never invent / never display a wrong number")**: a
  GREEN-but-AS-IS field can be *stale or wrong*. So we treat Related Security Descriptions as a
  **hint/enrichment**, validated against another source where it's load-bearing, and we never let a wrong
  Bloomberg name silently become the canonical display name without reconciliation. (Same discipline the
  gate flags for SEC EDGAR: "GREEN can still produce a wrong number.")
- **Practical consequence:** anchor on the FIGI *value* (high trust — it's the join key), but treat the
  *descriptions* as enrichment to be reconciled, not gospel.

**Why FIGI is the anchor and not just "a GREEN id":**
- **Covers everything** — equities, bonds, options, futures, FX, indices, crypto (via DTI/exchange feeds),
  across every venue, with a venue-level granularity (a share has a *composite* FIGI and per-exchange FIGIs).
- **Never reused, never recycled** — once assigned, a FIGI is permanent; corporate actions issue new FIGIs
  rather than overloading an old one. That is exactly the stability a time-series store needs as its PK.
- **Free issuance + free bulk mapping** — `POST /v3/mapping` on the OpenFIGI API maps from ISIN/ticker/etc.
  to FIGI, and bulk files are downloadable, all under the PD terms.
- **It is the legal "clean" anchor** precisely *because* it is PD: anchoring the master on a RED id (ISIN)
  would mean the master's own PK carries ANNA's contract. Anchoring on FIGI means the PK is free.

```python
# Greenfield recipe sketch — FIGI as the master anchor (mapping IN from a RED/AMBER id is fine;
# the OUTPUT we anchor on and DISPLAY is the GREEN FIGI). Concrete build lives in patterns-*.md.
import httpx

OPENFIGI = "https://api.openfigi.com/v3/mapping"

async def map_isin_to_figi(client: httpx.AsyncClient, isin: str, api_key: str | None) -> list[dict]:
    """Cross-reference an ISIN (RED, join-IN-only) -> FIGI (GREEN, anchor + display).

    We *send* the ISIN as a query key (lawful: we hold it for internal join under ANNA's
    'internal use' grant). We *store and display* only the returned FIGI + PD metadata.
    The ISIN never crosses the display/redistribution boundary (contamination rule, §6).
    """
    headers = {"Content-Type": "application/json"}
    if api_key:                       # raises the rate cap; not required for PD status
        headers["X-OPENFIGI-APIKEY"] = api_key
    body = [{"idType": "ID_ISIN", "idValue": isin}]
    r = await client.post(OPENFIGI, json=body, headers=headers)
    r.raise_for_status()
    matches = r.json()[0].get("data", []) or []
    # Each match: figi (GREEN anchor), name/ticker/securityType (Related Security Descriptions, AS-IS).
    return [
        {
            "figi": m["figi"],                       # 🟢 anchor + display
            "name": m.get("name"),                   # 🟢 PD but AS-IS -> enrichment, reconcile if load-bearing
            "ticker": m.get("ticker"),
            "exchCode": m.get("exchCode"),
            "securityType": m.get("securityType"),
            "provenance": {"source": "openfigi", "commercialOk": True, "asIs": True},
        }
        for m in matches
    ]
```

---

### 2.2 LEI — Legal Entity Identifier (GLEIF) — 🟢 the entity anchor

**Verdict: GREEN.** LEI is to *legal entities* (the issuer "Apple Inc.") what FIGI is to *instruments*. We
anchor the **entity** layer of the master on the LEI and display it freely.

**Primary license text — CC0 1.0 Universal.** From the GLEIF *LEI Data Terms of Use*
([gleif.org/en/meta/lei-data-terms-of-use](https://www.gleif.org/en/meta/lei-data-terms-of-use)):

> "The data available through the Access Service are provided under the **CC0 licence**, see CC0 1.0
> Universal (CC0 1.0)." (links to https://creativecommons.org/publicdomain/zero/1.0/)

> "You acknowledge that you **do not have, and will not acquire, any intellectual property or other
> proprietary rights in the LEIs and LE-RD** as provided by the Access Service, and that you do not, and
> will not, claim such rights."

> "The Access Service on the website http(s)://www.gleif.org is **provided for free**."

**Why this is rock-solid GREEN:** **CC0 1.0 Universal** is a public-domain *dedication*, the most permissive
instrument that exists — no attribution required, commercial use explicit, irrevocable. It is on the gate's
allow-list ("CC0 / CC-BY"). The "no IP rights acquired" clause is GLEIF clarifying that *they* are not
granting *you* a monopoly either — it reinforces, not restricts, the openness.

**Cross-verification (independent source):** GLEIF's own Open Data page:

> "Any interested party can access and search the Global LEI Index **free of charge** via the GLEIF
> website using the LEI search tool."
> "The data on GLEIF's website is provided under a **Creative Commons (CC0) license**."
> — [gleif.org/en/about/open-data](https://www.gleif.org/en/about/open-data)

**The ISIN-to-LEI relationship file — a GREEN bridge that touches a RED token (read carefully).** GLEIF +
ANNA publish a **free, daily, open ISIN-to-LEI relationship file**
([gleif.org/en/lei-data/lei-mapping/download-isin-to-lei-relationship-files](https://www.gleif.org/en/lei-data/lei-mapping/download-isin-to-lei-relationship-files)):

> "the mapping of LEIs against other identifiers enables market participants to link and cross-reference
> key entity identifiers **free of charge**" — GLEIF LEI-mapping page (cross-confirmed: the GLEIF+ANNA
> April-2019 pilot of "daily **open-source** relationship files" linking ISINs and LEIs).

This file is **excellent for the JOIN** — it is exactly how we cross-reference instrument→issuer for free.
**But note the seam:** the *relationship* and the *LEI* are CC0/GREEN; the **ISIN token sitting inside each
row is still an ANNA-issued value** and inherits ANNA's terms at the *display* boundary (§6, the
contamination rule). Operationally: use the GLEIF file to *join* instrument↔entity; **display the LEI and
the entity, not the ISIN.** GLEIF giving the file away does not re-license ANNA's identifier — GLEIF can
only CC0 *its own* contribution (the relationship + the LEI).

**Bulk consumption:** GLEIF publishes the **Golden Copy** (full LEI dataset) and daily delta files, plus
concatenated files, all CC0 — ideal for seeding and refreshing the entity table of the master without per-
call rate limits ([gleif.org/en/lei-data/gleif-golden-copy](https://www.gleif.org/en/lei-data/gleif-golden-copy)).

```python
# LEI entity anchor — bulk-seed from the CC0 Golden Copy, display freely.
# (Sketch; concrete ingest/upsert recipe is in patterns-*.md and the timescaledb skill.)
ENTITY_PROVENANCE = {"source": "gleif", "license": "CC0-1.0", "commercialOk": True}

def lei_row_to_master(rec: dict) -> dict:
    return {
        "lei": rec["LEI"],                                # 🟢 anchor + display
        "legal_name": rec["Entity"]["LegalName"],         # 🟢 CC0
        "jurisdiction": rec["Entity"]["LegalJurisdiction"],
        "provenance": ENTITY_PROVENANCE,
    }
```

---

## 3. RED — crosswalk-IN-only, `commercialOk: false`, **never displayed**

These three are the incumbents' moat: each is a *paid, restricted* identifier whose issuer's own license
text forbids redistribution or display by an unlicensed party. **We never anchor on them and never display
them.** We may *hold* them as **join keys** strictly to the extent the relevant access grant allows
(detail per id), and we **strip them at the read/distribution boundary** (§6, §7).

### 3.1 ISIN — International Securities Identification Number (ANNA / NNAs) — 🔴 RED

**Verdict: RED — join-IN-only, ≤1,000 records/day, internal use, never displayed.**

ISIN feels like it *should* be free — it's an ISO standard (ISO 6166), issued by **National Numbering
Agencies (NNAs)** mostly on a cost-recovery basis, and many people treat it as the universal public key.
**It is not free to redistribute or display.** The ANNA service that lets you look ISINs up is explicitly
**internal-use-only with a hard daily cap.**

**Primary license text — the ANNA ISIN-lookup subscriber license** (annaservice.com `displayLicense`,
[annaservice.com/isinlookup/displayLicense](https://www.annaservice.com/isinlookup/displayLicense)):

> "The Service is **solely for the internal use of Subscriber**, which means access and use of the Service
> and ISIN Data by Subscriber solely in connection with the trading and administration of securities
> transactions. Internal use allows subscribers to furnish ISIN Data to customers and supervisory/public
> bodies **solely to the extent necessary** to trade, clear, settle and report such customer's own
> securities transactions …"

> "The Service provides Subscribers with the capability to export or download a portfolio of ISIN
> identifiers in an aggregate amount of **up to 1000 active ISIN Records per day**."

**Cross-verification (independent source):** the ISIN.org Terms of Use:

> "Except as otherwise expressly permitted under copyright law, **you may not copy, redistribute, publish,
> display or commercially exploit any material from this site** without the express permission of Isin.org
> and, if applicable, the copyright owner."
> — [isin.org/terms-of-use](https://www.isin.org/terms-of-use/)

Two independent ANNA-affiliated sources both land on the same verdict: **internal use only, no display, no
redistribution, capped at 1,000 records/day on the free tier.** That is the definition of RED under the
gate ("a free API tier is NOT a commercial-display license").

**The "power-user / bulk" tier.** ANNA / the **ANNA Service Bureau (ASB)** and the regional NNAs (e.g.
SIX, CUSIP Global Services co-operating the ASB) offer **paid bulk/redistribution licenses** above the
1,000/day lookup tier ([anna-web.org/about-the-anna-service-bureau](https://anna-web.org/about-the-anna-service-bureau/),
[six-group.com/.../20210923-six-asb-cusip.html](https://www.six-group.com/en/newsroom/media-releases/2021/20210923-six-asb-cusip.html)).
**A paid redistribution license *could* flip ISIN to GREEN — but only the *purchased* tier, and only for the
scope purchased.** Until/unless we buy it and read its grant, ISIN stays RED. (This is the gate's third
GREEN door: "a **purchased** commercial display/redistribution tier." We have not walked through it.)

**Operational rule for ISIN:**
- **Hold it as a join key, internally only**, respecting the 1,000/day export cap on the lookup tier (so
  *batch* your enrichment; don't hammer the lookup as a live per-request resolver).
- **Prefer the free GLEIF ISIN-to-LEI file (§2.2) and the OpenFIGI ISIN→FIGI mapping (§2.1) as the
  *lawful* way to cross-reference**, because those return GREEN outputs we can anchor/display, with the
  ISIN only ever an *input* we send, never an output we ship.
- **Strip ISIN at the display/redistribution boundary** (§6). It must never appear in an API response,
  export file, chart label, or UI cell that leaves our trust boundary unlicensed.

### 3.2 CUSIP — Committee on Uniform Securities Identification Procedures (CGS) — 🔴 RED (contested)

**Verdict: RED, held conservatively pending litigation.** CUSIP (and its zero-padded ISIN form for US/CA
instruments) is the most aggressively licensed identifier in the market, and the basis for that licensing
is **actively being litigated**. Until the litigation resolves *against* the licensor, we treat CUSIP as
RED.

**Primary license text — CGS license requirement and the no-redistribution restriction**
([cusip.com/services/license-fees.html](https://www.cusip.com/services/license-fees.html)):

> "On March 1, 2022, Standard & Poor's sold the CUSIP business to FactSet Research Systems Inc., who is now
> the **operator of CUSIP Global Services, on behalf of the ABA**." (The **American Bankers Association**
> holds the IP rights to the CUSIP system.)

> "A CGS License is **required** when: (a) an end user customer subscribes to a particular CGS product or
> service, and/or (b) an end user customer obtains the benefit of CGS Data indirectly through one of CGS's
> Authorized Data Vendors."

> "Internal operations and internal business processes **do not include further onward distribution of CGS
> Data to third parties or commercialization of CGS Data**."

So CGS asserts: a license is required even to *receive* CUSIPs indirectly, fees scale with the *number of
unique CUSIPs accessed/stored/used*, and onward distribution/commercialization is excluded. That is RED on
its face under the gate.

**The antitrust class action — the "facts aren't copyrightable" argument (why this is *contested*, not
settled).** Cross-verified across three independent sources:

- **The suit & claims.** *Dinosaur Financial Group LLC et al. v. CUSIP Global Services et al.*
  (S.D.N.Y., No. 1:22-cv-01860), filed **March 4, 2022**, alleges CGS, S&P Global, FactSet, and the ABA
  **conspired to charge excessive licensing fees and eliminate competition**, in violation of **Sections 1
  and 2 of the Sherman Act** and **Section 4 of the Clayton Act**
  ([waterstechnology.com/.../class-action-lawsuit-takes-aim-at-cusip-sp-factset-aba](https://www.waterstechnology.com/regulation/7936086/class-action-lawsuit-takes-aim-at-cusip-sp-factset-aba);
  [wmd-law.com/.../firm-files-class-action-antitrust-suit-concerning-the-licensing-of-cusip-identifiers](https://www.wmd-law.com/wmd-practice-areas/news/firm-files-class-action-antitrust-suit-concerning-the-licensing-of-cusip-identifiers)).
- **"Not copyrightable."** Plaintiffs argue the ABA's purported copyright is "thin … covers purely factual
  information (strings of numbers and letters) … no different than a license plate," and that "injecting
  novelty, creativity, or subjectivity into the CUSIP would destroy its utility." At a Nov-2022 conference,
  defendants' counsel, asked "what precisely is copyrighted?", confirmed it is **not the individual CUSIP
  but the "aggregation"** (the whole database, not extracts)
  ([waterstechnology.com/.../plaintiffs-in-cusips-lawsuit-argue-the-codes-arent-copyrightable](https://www.waterstechnology.com/regulation/7947116/plaintiffs-in-cusips-lawsuit-argue-the-codes-arent-copyrightable)).
  This squares with **Feist** (facts uncopyrightable; only original selection/arrangement of a compilation
  is).
- **Status.** Judge **Katherine Polk Failla dismissed most claims but let the Section 2 (monopolization)
  Sherman Act claim proceed to discovery**; as of the most recent sources reviewed, **no final judgment or
  settlement** has been reached
  ([wmd-law.com/.../wmd-defeats-motion-to-dismiss-antitrust-and-consumer-protection-claims](https://www.wmd-law.com/wmd-practice-areas/news/wmd-defeats-motion-to-dismiss-antitrust-and-consumer-protection-claims-on-behalf-of-cusip-users);
  [integrity-research.com/update-on-the-cusip-case-the-verdict-is-in-not](https://www.integrity-research.com/update-on-the-cusip-case-the-verdict-is-in-not/)).
  Context on the licensor's value: **FactSet acquired CGS from S&P for ~$1.925 billion in March 2022**
  ([news.bloomberglaw.com/antitrust/s-p-factset-banking-group-face-antitrust-suit-on-cusip-numbers](https://news.bloomberglaw.com/antitrust/s-p-factset-banking-group-face-antitrust-suit-on-cusip-numbers)).
  *(Note: the suit is sometimes described in coverage as seeking damages on the order of ~$1B; the
  precisely-verified figure here is the $1.925B acquisition price, not a court-confirmed damages number —
  do not cite a damages dollar figure as fact.)*

**Why we hold RED despite a *plausible* "it's just a fact" argument:**
- **The case is unresolved.** Betting our product's legal posture on an *undecided* monopolization claim is
  the opposite of the CTO/no-hacks standard. "A court might agree the codes are uncopyrightable" is a
  **hypothesis**, not a license.
- **Even if copyright fails, the licensor has *contract* and *market-power* leverage**, and the practical
  enforcement reality (CGS audits, demands fees on *stored* CUSIP counts) is unchanged until a court or
  settlement says otherwise.
- **The conservative move costs us nothing**, because **FIGI already gives us a free anchor** that covers
  US/CA instruments. We never *needed* CUSIP as an anchor; we only ever needed it as an inbound join key for
  data that arrives keyed by CUSIP — and even that we do only if we hold a CGS license for that path.

**Operational rule for CUSIP:** treat as RED. **Do not store CUSIPs harvested from an unlicensed path; do
not display CUSIPs at all.** If a *licensed* upstream feed delivers data keyed by CUSIP, use the CUSIP only
as an *inbound* join to resolve to FIGI, then **drop it** before persistence/display (§6). **Re-evaluate
the verdict if and when the litigation produces a final ruling or settlement that changes the licensor's
enforceable rights** — and log that re-evaluation in the sources-ledger.

### 3.3 SEDOL — Stock Exchange Daily Official List (LSEG) — 🔴 RED

**Verdict: RED — paid Masterfile distribution license, no raw redistribution, annual reporting.**

SEDOL is **owned and licensed by the London Stock Exchange Group (LSEG).** Access is a **paid Masterfile**
with an explicit **distribution-license** regime.

**Primary license text — the SEDOL Masterfile Pricing and Policy Guidelines 2025**
([lseg.com/.../sedol-masterfile-pricing-and-policy-guidelines-2025.pdf](https://www.lseg.com/content/dam/lseg/en_us/documents/sedol/sedol-masterfile-pricing-and-policy-guidelines-2025.pdf)):

> "**Distributors are not permitted to redistribute the SEDOL Masterfile data in the original format** in
> which it is received."

> "A **Distribution Licence** is granted to allow distributors to include the SEDOL Masterfile data within
> their products to aid identification or assist in the maintenance of their data within their customer's
> products."

> "All Distribution Licence holders must ensure that the third parties they distribute to are appropriately
> Licenced for SEDOL codes. … the distributor will **provide the Exchange with a report … on an annual
> basis** detailing those customers, by product, that it supplies SEDOL Masterfile data to."

So even a *paying distributor* (a) may not redistribute the raw Masterfile, (b) may only embed SEDOLs into
*their own products as an identification aid*, (c) must ensure downstream recipients are **separately
licensed**, and (d) must **report annually** to LSEG. That is RED, full stop — and notably it stays RED
*even for a paying party* unless they hold the specific distribution tier and meet its obligations.

**Cross-verification (independent source):** the 2024 edition of the same guidelines carries identical
distribution-license language ([lseg.com/.../sedol-masterfile-pricing-and-policy-guidelines-2024.pdf](https://www.lseg.com/content/dam/lseg/en_us/documents/sedol/sedol-masterfile-pricing-and-policy-guidelines-2024.pdf)),
and LSEG's product page presents SEDOL as a paid, licensed "Global Reference Data Set" under its Data &
Analytics pricing/symbology line ([lseg.com/en/data-analytics/market-data/data-analytics-pricing/data-symbology/sedol](https://www.lseg.com/en/data-analytics/market-data/data-analytics-pricing/data-symbology/sedol)).
Year-over-year stability of the restriction is itself evidence it is a deliberate, enforced policy.

**Operational rule for SEDOL:** treat as RED. Same as CUSIP — never anchor, never display, hold as an
inbound join key only if we hold the applicable LSEG license for that path, strip before the boundary
(§6). The **annual-reporting obligation** is a specific operational tripwire: even being a *licensed*
distributor imposes a downstream-licensing-assurance + annual-report duty we do not want in v1.

---

## 4. AMBER — DTI (DTIF) — `commercialOk: false` in v1, caveat logged

**Verdict: AMBER. Decision for v1 → `commercialOk: false`, accept as a *join-IN* key for digital tokens
with the basis explicitly logged; defer a display decision until we read the DTIF data-license artifact in
full.** This is the honest verdict: DTI's openness is *real and well-intentioned* but its **legal artifact
is weaker than FIGI's public-domain dedication or LEI's CC0**, and we found no quotable
"redistribute/display freely" grant equivalent to those two.

**DTI = Digital Token Identifier**, ISO 24165, the crypto/digital-asset analogue of an instrument id. Why
it matters to us: the security master must identify *digital tokens* too, and DTI is the ISO-standard way.

**What we *can* quote (the operating model — non-profit, cost-recovery, open-data principles, FRAND):**

> "DTIF issues and maintains DTIs on a **non-profit, cost-recovery model**, to increase transparency in the
> digital asset space through the creation of a **core reference data set based on open data principles and
> available as a public good**. … the Foundation allocates and maintains DTIs on a cost-recovery basis
> under ISO governance principles of **fairness, reasonability, and non-discrimination (FRAND)**."
> — DTIF FAQ ([dtif.org/wp-content/uploads/2023/09/FAQs-on-DTI.pdf](https://dtif.org/wp-content/uploads/2023/09/FAQs-on-DTI.pdf))

> "A Digital Token Identifier (DTI) is a global identification system for digital tokens defined by …
> **ISO 24165, published in September 2021**. In 2025, the initial version … was updated to
> **ISO 24165-1:2025**." (over **3,700** DTIs in the registry as of the cited material)

**Cross-verification (independent source):** the Registration Authority structure —

> "The Digital Token Identifier Foundation (DTIF) operates as a **non-profit entity within Etrading
> Software**, serving as the **Registration Authority** for the ISO standard 24165 for DTIs."
> — [21analytics.co/glossary/digital-token-identifier-dti](https://www.21analytics.co/glossary/digital-token-identifier-dti/)

**Why AMBER and not GREEN — the honest gap (this is the finding, not a hedge):**
- **"Open data principles" and "public good" are *aspirational descriptors*, not a *license*.** FIGI says
  "dedicated to the public domain … may be freely … distributed … commercial or non-commercial." LEI says
  "provided under the CC0 licence." **DTIF's quotable text says cost-recovery + FRAND + open-data
  *principles* — it does *not*, in the text we located, grant an explicit, irrevocable
  redistribute-and-display-commercially right with a named instrument (PD / CC0 / CC-BY).** The gate is
  explicit: GREEN requires public-domain, or CC0/CC-BY *with attribution rendered*, or a purchased tier.
  "Open-data principles" is none of those *by name*.
- **"Cost-recovery, non-profit, FRAND"** describes *how access is priced and governed* (fairly, at cost),
  not *what you may do with the data once you have it.* A registry can be FRAND-priced and still restrict
  redistribution.
- Under the **conservatism rule (§1)**: ambiguous display terms → RED/`false`. We don't have an artifact
  strong enough to flip it; therefore `commercialOk: false`.

**Why AMBER and not flat RED:** we have *positive evidence of intended openness* (open-data principles,
public good, FRAND, non-profit, an ISO standard with a public registry) that is materially stronger than
the *prohibitive* contracts behind ISIN/CUSIP/SEDOL. It is plausible the full DTIF data-license terms grant
display rights; we simply have not read and quoted that artifact yet. So DTI sits between the two camps —
hence AMBER.

**v1 DECISION (logged):**
- **Accept DTI as a *crosswalk-IN* key** for digital tokens (use it to identify/join tokens) — low risk,
  it's an inbound identification aid.
- **Do NOT display/redistribute DTI as `commercialOk:true` in v1.** Set `commercialOk:false`, attach a
  provenance note: `"basis":"DTIF open-data principles + FRAND; no PD/CC0 artifact located as of 2026-06-24
  — display deferred."`
- **Open the door, don't walk through it:** the next research task is to fetch and read the **DTIF data
  license / terms-of-use** in full (not just the FAQ/SEC-letter). If it contains a CC0/CC-BY/PD or explicit
  "redistribute and display" grant, **re-grade to GREEN and log the quoted clause**; if it's silent/
  restrictive, **confirm RED**. Until then: AMBER, `false`, caveat on record.
- For digital-token *display*, prefer anchoring on the **FIGI** assigned to the token where one exists
  (GREEN), and use DTI as the inbound cross-reference — same pattern as ISIN.

---

## 5. (reserved) — the GREEN/RED reasoning recap

The four buckets above are derived, not memorized, from **one test applied to each fetch path**:

> *Did the issuer put an explicit open-data legal artifact (public-domain dedication / CC0 / CC-BY /
> purchased redistribution tier) on the data I fetched?*
> **Yes, quotable →** GREEN (display + redistribute). **No / ambiguous →** RED (`false`). **Open-data
> intent but no named artifact →** AMBER (`false`, caveat, revisit).

FIGI and LEI pass with quotable PD/CC0 text. ISIN, CUSIP, SEDOL fail with quotable *restrictive* text. DTI
sits in the ambiguous middle with quotable *intent* but no quotable *grant*.

---

## 6. The contamination rule — a crosswalk row that exposes a RED value inherits RED at the display boundary

This is the rule that most often trips up a symbology layer, because the *join* and the *display* feel like
one operation but are two different licensing events.

**Statement of the rule:**

> A crosswalk/mapping row may be **internally GREEN to compute** (you lawfully held each input under its own
> grant), yet **RED to display** if it *exposes a RED identifier value* at the read/redistribution boundary.
> The composite inherits the **most restrictive** license of any value it surfaces. A GREEN FIGI sitting in
> the same row as an ISIN does **not** launder the ISIN; the ISIN drags the *displayed row* to RED.

This is the symbology instance of the gate's general **contamination rule** (F2: "a composite that inherits
a RED input yet claims GREEN").

**Worked examples:**

| Crosswalk row (stored) | Internally lawful to *hold*? | What you may **display / return** |
|---|---|---|
| `{figi, isin, ticker, name}` | ✅ (ISIN held under ANNA internal-use, ≤1,000/day) | **`{figi, ticker, name}`** — strip `isin` |
| `{figi, cusip}` from a CGS-licensed feed | ✅ only if we hold the CGS license for that path | **`{figi}`** — strip `cusip`; if no CGS license, don't even store it |
| `{figi, sedol}` from a licensed LSEG Masterfile | ✅ only under our SEDOL distribution license | **`{figi}`** — strip `sedol` (no raw redistribution) |
| GLEIF ISIN-to-LEI row `{lei, isin}` | ✅ (file is CC0) | **`{lei}` + entity** — strip `isin` (CC0 covers the relationship+LEI, not the ANNA token) |
| `{figi, lei, ticker, name}` | ✅ all GREEN inputs | **whole row** — nothing to strip |

**The trap to avoid:** "but the relationship file is CC0, so the ISIN in it must be free now." **No.** GLEIF
can only CC0 *its own contribution*. The ISIN string inside the row is ANNA's identifier and keeps ANNA's
terms. The *fetch-path principle* (§1) is what makes this obvious: the row came partly from GLEIF (CC0) and
the ISIN *value* originates from ANNA (RED) — each token carries the license of *its* origin, and the row's
display verdict is the **max-restriction** over its tokens.

**Implementation consequence:** the master's display/distribution serializer must be **allowlist-based, not
denylist-based** — it returns only the GREEN columns explicitly marked displayable, so a newly-added RED
column can never *accidentally* leak. (Recipe in patterns-*.md.)

---

## 7. What "crosswalk-IN-only" means operationally — store to JOIN, strip at the boundary

"Crosswalk-IN-only" is the concrete handling for every RED/AMBER identifier. It has four parts:

**(1) IN, not OUT.** A RED id may enter the system as an **input** — a key we *send* to a mapper, or a key
on an *inbound* provider record we must join. It may never be an **output** — never in an API response,
export, file, webhook, chart label, or UI cell that crosses our trust boundary unlicensed.

**(2) Store with a license tag, or don't store at all.** If holding the RED value internally is itself
permitted (ISIN internal-use; CUSIP/SEDOL only under license), store it in a column **tagged
`display: false` / `commercialOk: false`** with its provenance. If holding it is *not* permitted (a CUSIP
scraped from an unlicensed path), **do not persist it** — resolve to FIGI in-flight and drop it.

**(3) The strip happens at exactly one place — the read/distribution boundary.** Centralize it. Do not rely
on every endpoint remembering to omit RED columns; that's a denylist and it leaks. Use one
**allowlist serializer / DB view** that the catalog API, the batch-export job, and the UI all read through.
Everything not on the GREEN allowlist is invisible to consumers by construction.

**(4) Internal joins are fine; the boundary is the line.** Using a RED ISIN to `JOIN` two internal tables,
or to call OpenFIGI, is *use*, not *redistribution* — lawful under ANNA's "internal use" grant. The
identifier becomes a problem only when it would *leave*. So the architecture is: **RED ids live in a
private join layer; the public layer speaks only FIGI/LEI (+ ticker/name, which are commodity/PD).**

```python
# Allowlist serializer — the single read/distribution boundary (sketch).
# Anything NOT named here is never emitted, so a new RED column can't leak.
GREEN_DISPLAY_FIELDS = {"figi", "lei", "ticker", "name", "exch_code", "security_type"}
# RED/AMBER join keys deliberately absent: "isin", "cusip", "sedol", "dti".

def to_public(master_row: dict) -> dict:
    """The ONE place internal master rows become consumer-facing records.
    Strips every RED/AMBER identifier; emits only GREEN, displayable fields."""
    public = {k: master_row[k] for k in GREEN_DISPLAY_FIELDS if k in master_row}
    public["provenance"] = {
        "anchor": "figi",
        "commercialOk": True,           # true because we emit ONLY green fields
        "note": "RED/AMBER join keys (isin/cusip/sedol/dti) held internally, stripped at boundary",
    }
    return public

# At the DB layer, enforce the same thing as a VIEW so even ad-hoc queries can't leak:
#   CREATE VIEW security_master_public AS
#     SELECT figi, lei, ticker, name, exch_code, security_type, ... -- GREEN columns only
#     FROM security_master;          -- isin/cusip/sedol/dti columns are NOT selected
```

**The headline-feature payoff (why this is a *selling point*, not just compliance):** because the public
layer is GREEN-only and *self-describing* (each row says `commercialOk:true` and names what was stripped),
**our consumers inherit a clean license.** A customer building on our security master never has to wonder
whether a code they re-display will draw a CGS audit — we already removed every RED token. The incumbents
hand you a contract and a footnote; we hand you a master where *every visible column is yours to use.* That
is the "licensing as a headline feature" edge made concrete.

---

## 8. The sources-ledger rows to add

Append these to `.claude/memory/sources-ledger.md` (or this product line's equivalent ledger). The ledger
is the enforcement surface: `commercialOk:true` anywhere in code must trace to a 🟢 row here, or
`/sources-lint` fails it.

```markdown
## Symbology identifiers (security-master-symbology)

🟢 GREEN — anchorable + displayable + redistributable (commercialOk:true)
| Source / fetch path | Identifier | License artifact | Quote (verbatim) | Primary URL | Cross-verified |
|---|---|---|---|---|---|
| OpenFIGI API / FIGI standard | FIGI | Public-domain dedication + MIT (embedded in OMG standard) | "Bloomberg … dedicates FIGI Identifiers to the public domain … may be freely reproduced, distributed … commercial or non-commercial" | openfigi.com/docs/terms-of-service | OMG omg.org/figi; US data-standard recognition 2021 |
| GLEIF Access Service / Golden Copy / ISIN-to-LEI file | LEI | CC0 1.0 Universal | "The data … are provided under the CC0 licence … CC0 1.0 Universal" ; "do not … acquire, any intellectual property … rights" | gleif.org/en/meta/lei-data-terms-of-use | gleif.org/en/about/open-data |

🔴 RED — crosswalk-IN-only, NEVER displayed (commercialOk:false)
| Source / fetch path | Identifier | Restriction artifact | Quote (verbatim) | Primary URL | Cross-verified | Notes |
|---|---|---|---|---|---|---|
| ANNA ISIN lookup (annaservice.com) | ISIN | Internal-use license + daily cap | "solely for the internal use of Subscriber" ; "up to 1000 active ISIN Records per day" | annaservice.com/isinlookup/displayLicense | isin.org/terms-of-use ("may not copy, redistribute, publish, display") | Paid ASB bulk tier could flip to GREEN if purchased; not purchased |
| CGS / CUSIP feed | CUSIP | CGS paid license; no onward distribution | "A CGS License is required …" ; "do not include further onward distribution … or commercialization of CGS Data" | cusip.com/services/license-fees.html | waterstechnology.com (antitrust suit; "not copyrightable" — contested) | Held RED pending Dinosaur v. CGS, S.D.N.Y. 1:22-cv-01860; re-grade only on final ruling/settlement |
| LSEG SEDOL Masterfile | SEDOL | Paid Masterfile distribution license | "Distributors are not permitted to redistribute the SEDOL Masterfile data in the original format" ; annual reporting required | lseg.com/.../sedol-masterfile-pricing-and-policy-guidelines-2025.pdf | 2024 guidelines (identical clause); lseg.com SEDOL product page | RED even for paying party absent the specific distribution tier |

🟡 AMBER — crosswalk-IN-only in v1, display deferred (commercialOk:false, caveat logged)
| Source / fetch path | Identifier | Basis | Quote (verbatim) | Primary URL | Cross-verified | v1 decision |
|---|---|---|---|---|---|---|
| DTIF / ISO 24165 registry | DTI | Non-profit, cost-recovery, open-data principles, FRAND — but NO PD/CC0/CC-BY artifact located | "non-profit, cost-recovery model … open data principles … public good … fairness, reasonability, and non-discrimination (FRAND)" | dtif.org/wp-content/uploads/2023/09/FAQs-on-DTI.pdf | 21analytics.co/glossary/digital-token-identifier-dti (non-profit RA) | Accept as join-IN; commercialOk:false; revisit after reading full DTIF data-license |
```

**Ledger hygiene notes:**
- The two GREEN rows are the *only* identifier fetch-paths that may back a `commercialOk:true` in code.
- The CUSIP row carries an explicit **re-grade trigger** (litigation outcome) — this is the gate's
  "GREEN-but-wrong / RED-but-might-change" discipline made auditable.
- The AMBER row carries an explicit **next-research task** (read the full DTIF data license). AMBER is a
  *parked* verdict, not a permanent one.

---

## 9. Practitioner table — the full decision matrix

| Identifier | What it names | Anchor? | Join-IN? | Display / redistribute? | Ledger color | Governing artifact (verbatim, abbreviated) | Primary citation |
|---|---|---|---|---|---|---|---|
| **FIGI** | Instrument (per-venue + composite) | ✅ **primary anchor** | ✅ | ✅ `commercialOk:true` | 🟢 GREEN | "dedicates FIGI Identifiers to the public domain … freely reproduced, distributed … commercial or non-commercial" (Related Sec. Descriptions AS-IS) | openfigi.com/docs/terms-of-service |
| **LEI** | Legal entity (issuer) | ✅ entity anchor | ✅ | ✅ `commercialOk:true` | 🟢 GREEN | "provided under the CC0 licence … CC0 1.0 Universal"; "do not … acquire any intellectual property … rights" | gleif.org/en/meta/lei-data-terms-of-use |
| **ISIN** | Instrument (ISO 6166) | ❌ | ✅ (≤1,000/day, internal) | ❌ `false` — strip at boundary | 🔴 RED | "solely for the internal use of Subscriber … up to 1000 active ISIN Records per day"; "may not copy, redistribute, publish, display" | annaservice.com/isinlookup/displayLicense; isin.org/terms-of-use |
| **CUSIP** | US/CA instrument | ❌ | ⚠️ only if CGS-licensed | ❌ `false` — strip at boundary | 🔴 RED (contested) | "A CGS License is required …"; "do not include further onward distribution … or commercialization"; *(plaintiffs: "not copyrightable" — unresolved)* | cusip.com/services/license-fees.html; waterstechnology.com |
| **SEDOL** | LSE/UK instrument | ❌ | ⚠️ only if LSEG-licensed | ❌ `false` — strip at boundary | 🔴 RED | "Distributors are not permitted to redistribute the SEDOL Masterfile data in the original format"; annual reporting | lseg.com/.../sedol-masterfile-pricing-and-policy-guidelines-2025.pdf |
| **DTI** | Digital token (ISO 24165) | ⚠️ caveat (prefer FIGI) | ✅ | ❌ `false` in v1 (caveat) | 🟡 AMBER | "non-profit, cost-recovery model … open data principles … public good … FRAND" (no PD/CC0 artifact) | dtif.org/.../FAQs-on-DTI.pdf; 21analytics.co |

---

## 10. Scale & confidence notes (R-SCALE + honesty)

**R-SCALE relevance.** The security master is a **list/search/join scale surface** (millions of
instruments). The licensing layer interacts with scale in three ways, each handled in patterns-*.md but
flagged here:
- **The ISIN 1,000-records/day cap is a *throughput* constraint, not just a legal one.** At 10,000×
  (millions of instruments) you cannot resolve ISIN→FIGI live per request on the free ANNA lookup. You
  **batch-enrich offline** (off the request path, on the worker) and cache the FIGI mapping. The free
  **GLEIF Golden Copy + OpenFIGI bulk mapping** are the scale-correct paths precisely because they're
  bulk-downloadable and GREEN.
- **The allowlist serializer (§7) is O(1) per row** and adds no scale cost — it's a projection. The DB
  *view* form means even a careless analyst query against the public view cannot leak a RED column.
- **CUSIP fee exposure scales with *stored* count.** CGS fees key off "number of unique CUSIPs accessed,
  stored, maintained." A *don't-store-CUSIP* policy (§7.2) isn't just clean — it removes a per-identifier
  cost that would balloon at 10,000×.

**Confidence levels (per the CTO output-discipline standard):**
- **HIGH — FIGI GREEN, LEI GREEN.** Two independent quotable artifacts each (ToS + OMG/MIT for FIGI; ToS +
  Open-Data page for LEI), both naming public-domain/CC0 explicitly. This is as settled as private-sector
  symbology gets.
- **HIGH — ISIN RED, SEDOL RED.** Direct restrictive license text from the issuer, cross-verified
  (ANNA+ISIN.org; SEDOL 2025+2024 guidelines).
- **MEDIUM-HIGH — CUSIP RED.** The *current* restriction is HIGH-confidence (CGS license text is explicit);
  the **durability** is MEDIUM because live antitrust litigation could change the enforceable rights. The
  conservative RED verdict is HIGH-confidence *as a v1 decision*; the **re-grade trigger is logged.**
- **MEDIUM — DTI AMBER.** We have quotable *intent* (open-data principles, FRAND, non-profit) but did **not**
  locate a quotable PD/CC0/redistribution *grant*. The AMBER verdict is deliberate and the gap is named, not
  papered over.

**Open questions (carry into the next research pass):**
1. **DTI display rights** — fetch and read the full DTIF *data-license / terms-of-use* (not the FAQ). Flip
   to GREEN only on a quotable PD/CC0/CC-BY or explicit redistribution grant; else confirm RED.
2. **CUSIP litigation outcome** — monitor *Dinosaur v. CGS* (S.D.N.Y. 1:22-cv-01860) for a final ruling or
   settlement; re-grade and re-quote on resolution.
3. **A purchased ISIN/SEDOL/CUSIP tier** — if the business later buys a redistribution license, that *fetch
   path* becomes GREEN *for its purchased scope only*; add a new ledger row quoting the purchased grant. The
   *free* paths stay RED.
4. **Ticker/name as display fields** — treated here as commodity/PD-ish (a ticker is a public exchange
   symbol; a name is a fact). Confirm per-exchange ticker redistribution terms before relying on them as
   *primary* display in regulated surfaces; they are safe as enrichment alongside the GREEN FIGI/LEI anchor.

---

## 11. The five sentences to memorize

1. **The license attaches to the fetch path, not the identifier concept** — the same ISIN string is RED from
   ANNA and "still ANNA's" even inside a CC0 GLEIF file.
2. **Anchor and display only on FIGI (public domain) and LEI (CC0)** — the only two with a quotable open-data
   artifact.
3. **ISIN, CUSIP, SEDOL are crosswalk-IN-only RED** — store to JOIN under their grant (or not at all), never
   display, strip at the boundary.
4. **DTI is AMBER** — open-data *intent* but no PD/CC0 *grant*; `commercialOk:false` in v1, revisit after
   reading the full DTIF data license.
5. **The contamination rule + an allowlist boundary serializer** are what turn "we know the verdicts" into
   "we cannot leak a RED value" — and that GREEN-only public master is the product's headline edge.

---

### References cited in this doc (primary unless noted)
- OpenFIGI Terms of Service — https://www.openfigi.com/docs/terms-of-service
- OMG FIGI standard — https://www.omg.org/figi/ · https://www.omg.org/intro/FIGI.pdf
- OpenFIGI US-data-standard recognition — https://www.openfigi.com/insights/all/2021/9/15/after-lengthy-fight-bloombergs-figi-recognized-as-official-us-data-standard
- GLEIF LEI Data Terms of Use — https://www.gleif.org/en/meta/lei-data-terms-of-use
- GLEIF Open Data — https://www.gleif.org/en/about/open-data
- GLEIF ISIN-to-LEI relationship files — https://www.gleif.org/en/lei-data/lei-mapping/download-isin-to-lei-relationship-files
- GLEIF Golden Copy — https://www.gleif.org/en/lei-data/gleif-golden-copy
- ANNA ISIN lookup license — https://www.annaservice.com/isinlookup/displayLicense
- ISIN.org Terms of Use — https://www.isin.org/terms-of-use/
- ANNA Service Bureau — https://anna-web.org/about-the-anna-service-bureau/ · https://www.six-group.com/en/newsroom/media-releases/2021/20210923-six-asb-cusip.html
- CGS / CUSIP license fees — https://www.cusip.com/services/license-fees.html
- CUSIP antitrust coverage — https://www.waterstechnology.com/regulation/7936086/class-action-lawsuit-takes-aim-at-cusip-sp-factset-aba · https://www.waterstechnology.com/regulation/7947116/plaintiffs-in-cusips-lawsuit-argue-the-codes-arent-copyrightable · https://www.wmd-law.com/wmd-practice-areas/news/wmd-defeats-motion-to-dismiss-antitrust-and-consumer-protection-claims-on-behalf-of-cusip-users · https://news.bloomberglaw.com/antitrust/s-p-factset-banking-group-face-antitrust-suit-on-cusip-numbers · https://www.integrity-research.com/update-on-the-cusip-case-the-verdict-is-in-not/
- Feist v. Rural Telephone, 499 U.S. 340 (1991) — https://supreme.justia.com/cases/federal/us/499/340/
- SEDOL Masterfile Pricing & Policy Guidelines 2025 — https://www.lseg.com/content/dam/lseg/en_us/documents/sedol/sedol-masterfile-pricing-and-policy-guidelines-2025.pdf (2024 ed. cross-check; LSEG SEDOL product page)
- DTIF FAQ on DTI — https://dtif.org/wp-content/uploads/2023/09/FAQs-on-DTI.pdf
- DTI / DTIF (independent) — https://www.21analytics.co/glossary/digital-token-identifier-dti/ · https://www.21analytics.co/glossary/iso-24165/
