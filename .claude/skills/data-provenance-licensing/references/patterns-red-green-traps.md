# patterns · The RED/GREEN trap catalogue — sources that LOOK clear but produce a WRONG verdict

> **Scope.** This is the trap field-guide for the `data-provenance-licensing` dev-skill of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina.** The sibling docs build the
> *theory*: [`theory-commercialok-fetch-path-licensing.md`](./theory-commercialok-fetch-path-licensing.md)
> (the license attaches to the FETCH PATH), [`theory-open-data-licenses.md`](./theory-open-data-licenses.md)
> (the public-domain / CC0 / CC-BY / ODC family), [`theory-contamination-derived-data-rule.md`](./theory-contamination-derived-data-rule.md)
> (a composite inherits its reddest input), and [`theory-prov-o-lineage-model.md`](./theory-prov-o-lineage-model.md)
> (the provenance stamp). This doc is the **recipe**: the specific, named sources where a licensing analysis
> done by the book *still gets the wrong answer*, why, and the exact reasoning that lands the right verdict.
>
> **The product line, in one sentence.** We re-engineer JPMorgan's internal data products (DataQuery /
> Fusion class) into our own **free-license, prosumer** financial-data-analytics platform on a **new
> Python/FastAPI/data-engineering stack** (separate from Lumina's Bun + Express + Prisma + Supabase +
> Upstash). The platform **owns the bytes** — it ingests, normalizes, **persists**, and **redistributes**
> upstream numbers — so every wrong GREEN verdict is a ship-blocking legal exposure, not a footnote.
>
> **The on-ramp (plain language).** Most licensing mistakes are not "I forgot to check." They are "I checked,
> the source *looked* open, and I was wrong." A government website hosts a copyrighted index. A statute bans a
> use that copyright law permits. A free API returns data fine — but the contract says you may not *show* it.
> A vendor's terms literally forbid the AI feature you were going to build. A "GREEN" source hands you a
> number that is correctly licensed and factually wrong. Each of these is a **trap**: the surface says one
> thing, the real rule says another. This file is the catalogue of the traps we have actually hit, each one
> reduced to *surface appearance → real rule → verdict → the ledger row that records it*, with runnable Python
> guards so the trap is caught by code, not by hoping a reviewer remembers it.

---

## 0. How to use this file

1. **You are about to add a source to the ingest layer.** Before you set `commercial_ok`, scan §1's
   trap index. If your source matches *any* trap pattern by shape (gov-hosted, gov-contractor, statute-gated,
   free-tier, AI-banned, derived, silent-ToS, green-but-wrong), jump to that section and apply its rule
   **before** trusting your first read.
2. **You are reviewing a PR that flips `commercial_ok=True`.** Run §11's reviewer checklist. Every `True`
   must survive every applicable trap, not just the one the author was thinking about.
3. **You are writing the CI lint.** §10 is the machine-checkable encoding of every trap as a Python rule over
   the ledger + the code. Wire it into the `sources-lint`-class check.

> **The one sentence to take away.** *A source can be RED for a reason that has nothing to do with copyright,
> nothing to do with your API tier, and nothing to do with what the number is — and the only defense is to
> enumerate the failure modes and check each one explicitly.* The traps below are that enumeration.

### 0.1 The eight trap families (the index)

| # | Trap | One-line tell | The verdict it produces | §|
|---|------|---------------|-------------------------|---|
| T1 | **Gov-HOSTING ≠ public-domain** | The number is *on* a `.gov`/Fed site, so "it's public domain" | RED for the copyrighted-source series; GREEN only for gov-owned series | §2 |
| T2 | **Gov-CONTRACTOR ≠ §105** | "A federal agency published it, so 17 USC 105 applies" | RED — contractor/grantee keeps copyright; also state/local/foreign gov are out | §3 |
| T3 | **Statute bar beyond copyright** | "It's public-domain disclosure data, so it's GREEN" | RED **by statute** (5 USC 13107) — a non-copyright legal bar a license analysis never sees | §4 |
| T4 | **Free-tier ≠ display license** | "The free API key works, so we can show it" | RED — access ≠ display/redistribution | §5 |
| T5 | **AI/ML-use ban** | "We'll just summarize it with the model" | ⛔ REJECT — ToS explicitly bans caching + display + AI use | §6 |
| T6 | **Derived-data license (YELLOW)** | "It's just a probability we computed, not their data" | YELLOW — a derived-data license is still required | §7 |
| T7 | **Silent ToS = RED default** | "Their terms don't *say* we can't" | RED — silence is not permission | §8 |
| T8 | **GREEN-but-WRONG** | "The license is GREEN, so the number is fine" | License GREEN, **number still wrong** — a second gate fails | §9 |

Each trap below has the same four-part structure the prompt demands: **the surface appearance** (what
fooled you), **the real rule** (the primary-source reason), **the verdict** (GREEN/YELLOW/RED/REJECT), and
**the ledger row** (the durable record in
[`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md), which this product line mirrors as
its `provenance_catalog`).

---

## 1. The mental model these traps break

A naive licensing pipeline reasons in **one** dimension:

```
is_copyright_free(source)  →  commercial_ok
```

Every trap in this file is a place where that single check is **necessary but not sufficient**. The correct
model is a **conjunction of independent gates**, and a source is displayable only if it passes *all* of
them:

```python
# The trap-aware verdict is a CONJUNCTION, not a single boolean.
# Each gate can independently force RED; passing one says nothing about the others.

def is_displayable(src: SourceFacts) -> Verdict:
    # Gate 1 — copyright: is the bytestream free of third-party copyright on THIS fetch path?
    if not src.copyright_clear:          # T1 (gov-hosting), T2 (gov-contractor)
        return Verdict.RED
    # Gate 2 — statute: is there a NON-copyright legal bar on this USE? (the gate a license read misses)
    if src.statutory_use_bar:            # T3 (Ethics in Government Act 5 USC 13107)
        return Verdict.RED
    # Gate 3 — contract: does the ToS of THIS tier grant display/redistribution?
    if not src.tos_grants_display:       # T4 (free tier), T7 (silent ToS = RED default)
        return Verdict.RED
    # Gate 4 — prohibited-use: does the ToS forbid the way we INTEND to use it?
    if src.tos_forbids_our_use:          # T5 (Kalshi AI/caching/display ban)
        return Verdict.REJECT
    # Gate 5 — derived-data: are we deriving from their data, triggering a derived-data license?
    if src.requires_derived_data_license: # T6 (CME FedWatch)
        return Verdict.YELLOW
    return Verdict.GREEN
    # NOTE: passing ALL FIVE clears DISPLAY rights only. CORRECTNESS is a SIXTH, orthogonal gate (T8) —
    # a GREEN series can still hand you a wrong number. See §9 and the numeric-grounding guard.
```

**The whole file is the proof that each of those five gates is real and independent**, plus a sixth
(correctness) that licensing never touches. The default at every gate is the conservative one: closed until
a human proves open. (The product line's `Provenance.commercial_ok` defaults to `False`; see
[`theory-commercialok-fetch-path-licensing.md`](./theory-commercialok-fetch-path-licensing.md) §0.)

The Python types these traps are checked against (greenfield — this is the design, no codebase `file:line`
exists yet):

```python
from __future__ import annotations
from enum import Enum
from pydantic import BaseModel, Field


class Verdict(str, Enum):
    GREEN = "green"     # displayable on a free path (public-domain / CC0 / CC-BY+attr / licensed)
    YELLOW = "yellow"   # conditional — a derived-data or other supplemental license is required
    RED = "red"         # not for public commercial display on this fetch path
    REJECT = "reject"   # ToS forbids the use outright — do not integrate at all


class SourceFacts(BaseModel):
    """Everything the verdict function needs, sourced from the PRIMARY ToS/statute, not from intuition."""
    source_id: str
    fetch_path: str                      # the exact host/endpoint — the license attaches HERE
    copyright_clear: bool = False        # Gate 1 — no third-party copyright on this path
    statutory_use_bar: bool = False      # Gate 2 — a non-copyright statute bars the USE
    tos_grants_display: bool = False     # Gate 3 — the ToS of THIS tier grants display/redistribution
    tos_forbids_our_use: bool = False    # Gate 4 — the ToS forbids our intended use (AI/cache/display)
    requires_derived_data_license: bool = False  # Gate 5 — derived-data license needed
    governing_clause: str = Field(..., description="the verbatim ToS/statute clause that decides it")
    primary_source_url: str
```

---

## 2. T1 — The gov-HOSTING trap: a federal site hosting a number does NOT make the number public domain

### 2.1 The surface appearance (what fools you)

You need the VIX (CBOE Volatility Index). You find it on **FRED**, the Federal Reserve Bank of St. Louis's
data service, at `fred.stlouisfed.org/series/VIXCLS`. The reasoning that *feels* airtight:

> "FRED is a Federal Reserve service. The Federal Reserve is the US government. US-government works are
> public domain under 17 USC §105. Therefore VIXCLS is public domain — GREEN."

Every link in that chain is individually plausible, and the conclusion is **wrong**. The same trap fires for
any third-party series FRED *re-hosts*: VIX (CBOE), most equity-index series, anything sourced from ICE,
S&P, Dow Jones, MSCI, Haver, etc.

### 2.2 The real rule (primary source)

**FRED's own Terms of Use disclaims exactly this inference.** The St. Louis Fed makes it explicit that
*hosting does not override the third-party owner's copyright*:

> "Before using data series owned by third parties for anything other than your own personal use, you
> must contact the data owner to obtain permission. The Federal Reserve Bank of St. Louis cannot give you
> such permission and **making the data series available through the FRED® API does not constitute such
> permission**."
> — FRED API Terms of Use, `fred.stlouisfed.org/docs/api/terms_of_use.html`

> "Neither the Federal Reserve Bank of St. Louis's provision of the FRED® API to you nor your use of the
> FRED® API **override the data series owners' copyrights, requirements and restrictions**. … In the case of
> FRED, redistributing copyrighted data series for commercial use is not allowed unless the data copyright
> owner authorizes it."
> — *ibid.*

And FRED tells you, per series, which ones carry third-party copyright:

> "**Copyrighted series contain the word 'Copyright' in their notes.** A copyright notice on a FRED series
> indicates other parties may have ownership rights, and you must contact the data owner to obtain permission
> for any use other than your own personal use."
> — *ibid.*

For **VIXCLS** specifically, FRED's series page carries the machine-readable status:

> Copyright status: **"Copyrighted: Citation Required"** — "The data is copyrighted by **Chicago Board
> Options Exchange, Inc.**"
> — `fred.stlouisfed.org/series/VIXCLS` (series notes / copyright field)

So FRED is doing exactly the right thing: it *tells* you the series is copyrighted by CBOE and that its own
hosting grants you nothing. The trap is purely in the consumer's head — assuming the *host's* legal status
flows to the *series*.

### 2.3 The discriminating principle: HOSTING vs OWNERSHIP

This is the cleanest instance of the FETCH-PATH principle from
[`theory-commercialok-fetch-path-licensing.md`](./theory-commercialok-fetch-path-licensing.md): the license
attaches to *who owns the bytes*, not to *whose server you pulled them from*. FRED is a **host**, not an
**owner**, for third-party series. The dividing line:

| FRED series category | Owner | Verdict | Example |
|---|---|---|---|
| **Fed-produced / gov-produced** | A US-gov body (Fed Board, BLS, BEA, Treasury, Census) | 🟢 GREEN — 17 USC §105 public domain | `DGS10` (Treasury yields, gov), `UNRATE` (BLS), `GDP` (BEA), `FEDFUNDS` (Fed) |
| **Third-party re-hosted** | A private vendor (CBOE, ICE, S&P, Dow Jones, MSCI, Haver, OECD) | 🔴 RED — vendor copyright, FRED hosting grants nothing | `VIXCLS` (CBOE ©), `SP500` (S&P/Dow Jones ©), `DJIA` (Dow Jones ©), most `BAMLH0A0...` ICE series |

**The actionable detection rule:** never trust "it's on FRED" — check the *series-level* copyright field.
FRED exposes it programmatically; the existence of a `Copyright` note in the series metadata is a hard RED
signal. The only GREEN FRED series are those whose owner is a US-gov body.

> **Subtle corollary — even the GREEN FRED series:** for a series like `DGS10` (Treasury) or `UNRATE`
> (BLS), the *underlying number* is public domain — but **fetch it from the OWNER's path, not from FRED**,
> when you can. The Treasury 10-year from `home.treasury.gov` is unambiguously GREEN; the same number routed
> through FRED is GREEN-by-luck (FRED happens to host a gov series) but you've now coupled your provenance to
> FRED's hosting terms and rate limits. The fetch-path discipline says: *fetch the public-domain series from
> its public-domain owner.* Use FRED for gov series only as a convenience/fallback, and stamp the provenance
> with FRED as the immediate path and the gov body as the ultimate owner.

### 2.4 Detecting it in code (runnable)

FRED's series metadata API returns the copyright note. A guard that auto-RED's any copyrighted FRED series:

```python
"""
T1 guard — FRED gov-hosting trap.
A FRED series is GREEN only if (a) FRED reports no third-party copyright AND (b) the owner is a US-gov body.
The 'Copyright' word in series notes is FRED's own machine signal that a third party owns it.
"""
import httpx

# US-government data producers whose works are 17 USC 105 public domain (the GREEN owners on FRED).
GOV_OWNED_FRED_SOURCES = {
    "Board of Governors of the Federal Reserve System (US)",
    "U.S. Bureau of Labor Statistics",
    "U.S. Bureau of Economic Analysis",
    "U.S. Department of the Treasury. Fiscal Service",
    "U.S. Census Bureau",
    "Federal Reserve Bank of St. Louis",   # FRED's own calculated series (e.g. STLFSI)
}


async def classify_fred_series(series_id: str, fred_api_key: str) -> Verdict:
    """Return the licensing verdict for a single FRED series id, from FRED's own metadata."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            "https://api.stlouisfed.org/fred/series",
            params={"series_id": series_id, "api_key": fred_api_key, "file_type": "json"},
        )
        r.raise_for_status()
        series = r.json()["seriess"][0]

    notes = (series.get("notes") or "")
    source = (series.get("source") or "").strip()  # FRED exposes the producing org

    # Hard RED signal: FRED itself flags third-party copyright in the notes.
    if "copyright" in notes.lower():
        return Verdict.RED          # T1 — CBOE/S&P/ICE/Haver etc. own it; FRED hosting grants nothing.

    # GREEN only if the OWNER is a US-gov body. Anything else is RED-by-default (silent ToS, T7).
    if source in GOV_OWNED_FRED_SOURCES:
        return Verdict.GREEN
    return Verdict.RED              # unknown owner, no explicit gov-public-domain basis → conservative RED.


# --- usage / sanity (these are the expected verdicts) ---
# classify_fred_series("VIXCLS")  -> Verdict.RED    (CBOE ©, "Copyrighted: Citation Required")
# classify_fred_series("DGS10")   -> Verdict.GREEN  (US Treasury, public domain)
# classify_fred_series("UNRATE")  -> Verdict.GREEN  (BLS, public domain)
# classify_fred_series("SP500")   -> Verdict.RED    (S&P Dow Jones Indices ©)
```

> **Note on the FRED API key:** even though FRED requires a key, the key is for *rate-limiting and
> identification* — it is NOT a display license, and it does NOT change the per-series copyright status. A
> key giving you access to VIXCLS does not give you the right to display VIXCLS. This is the same
> ACCESS ≠ DISPLAY distinction as the free-tier trap (T4, §5); FRED just happens to make it explicit at the
> series level.

### 2.5 The verdict and the ledger row

**Verdict:** 🔴 RED for any third-party-copyrighted FRED series (VIXCLS and the rest); 🟢 GREEN only for
gov-owned FRED series — and for those, prefer the owner's own fetch path.

**Ledger row** (from `sources-ledger.md`, "Hard RED traps"):

| Source | Verdict | Why |
|---|---|---|
| FRED VIXCLS / 3rd-party FRED series | 🔴 RED | CBOE © / ICE © etc. — FRED *hosting* ≠ public domain. Only **Fed-owned** FRED series are GREEN. |

---

## 3. T2 — The gov-CONTRACTOR trap: 17 USC §105 covers officers/employees, NOT contractors

### 3.1 The surface appearance

You find a dataset on a federal agency's website — a model output, a report, a database — published by the
agency. The reasoning:

> "A US-government agency published it on a `.gov` domain. 17 USC §105 says US-government works can't be
> copyrighted. So it's public domain — GREEN."

This is the **broader, more dangerous cousin of T1**: T1 is "the host re-hosts a private vendor's series";
T2 is "the agency itself *commissioned* the work from a contractor who kept the copyright." The number isn't
even from a private vendor's separate feed — it's *on the agency's own site*, which makes the trap harder to
see.

### 3.2 The real rule (primary source)

**17 USC §105 is scoped precisely — and the scope excludes contractors.** The statute:

> "Copyright protection under this title is not available for any **work of the United States Government**,
> but the United States Government is not precluded from receiving and holding copyrights transferred to it
> by assignment, bequest, or otherwise."
> — 17 U.S.C. §105(a), `law.cornell.edu/uscode/text/17/105`

The load-bearing phrase is the *defined term* "work of the United States Government," which 17 USC §101
defines as:

> "a work prepared by an **officer or employee** of the United States Government **as part of that person's
> official duties**."
> — 17 U.S.C. §101 (definition), `law.cornell.edu/definitions/uscode.php`

Two independent boundaries fall out of that definition, both of which the trap ignores:

**(a) Contractors and grantees are NOT officers or employees.** The statute's drafters considered and
*deliberately declined* to extend §105 to contractor works. The legislative history (House Report, carried
in the Cornell/Wikisource revision notes) records that whether a contractor or grantee may secure copyright
in work prepared with government funds was left to *each agency to decide case by case* — it is **not** a
blanket prohibition:

> "the Government agency concerned could determine in each case whether to allow an independent contractor
> or grantee to secure copyright in works prepared in whole or in part with the use of Government funds."
> — Historical & Revision Notes to 17 USC §105, via `law.cornell.edu/uscode/text/17/105` and
> `en.wikisource.org/wiki/United_States_Code/Title_17/Chapter_1/Sections_105_and_106`

The corroborating secondary sources state it plainly:

> "Works produced by contractors … are **not** necessarily in the public domain. … The government can, and
> often does, allow contractors to retain copyright."
> — *Copyright status of works by the federal government of the United States*,
> `en.wikipedia.org/wiki/Copyright_status_of_works_by_the_federal_government_of_the_United_States`

> "A work produced by a contractor for the government is not automatically in the public domain. … The
> contract determines who owns the copyright."
> — Public Domain Sherpa, `publicdomainsherpa.com/us-government-works.html`

**(b) §105 is FEDERAL only — state, local, and foreign government works are NOT covered.** The Wikipedia
survey and the ARL issue brief are explicit:

> "§105 applies only to the federal government. **State and local governments may claim copyright** in their
> works, and many do."
> — `en.wikipedia.org/wiki/Copyright_status_of_works_by_the_federal_government_of_the_United_States`

> "There is **no equivalent of §105 for state, local, or foreign governments.**"
> — ARL, *U.S. Copyright Status of U.S. Federal Government Works*, `arl.org/.../copyright-status-of-government-works.pdf`

### 3.3 The discriminating principle

The trap collapses *three* distinct legal facts into one false "it's on a .gov, so it's public domain":

| What you saw | The actual §105 question | If you skip it |
|---|---|---|
| Published *by* a federal agency | Was it authored by a federal **officer/employee** in their official duties, or by a **contractor/grantee** who kept copyright? | You assume public domain; a contractor copyright bites. |
| On a `.gov` domain | Is the producing body **federal**, or **state / local / foreign**? | A state-agency dataset (e.g. a state energy office, a city open-data portal, a foreign central bank) is *not* §105. |
| A "government dataset" | Did the agency **receive** a copyright by assignment (the §105(a) carve-back), or embed third-party copyrighted inputs? | The agency may hold a transferred copyright, or the dataset may contain RED third-party material. |

**The actionable rule:** to claim §105 public domain, you must affirmatively establish *all three*: (1)
**federal** body, (2) authored by **officers/employees**, not contractors/grantees who retained copyright,
(3) no third-party copyrighted inputs embedded. Absent positive evidence on each, the default is RED (T7).

### 3.4 Worked examples (the boundary in practice)

| Source | Producer | §105 applies? | Verdict | Why |
|---|---|---|---|---|
| BLS unemployment (`api.bls.gov`) | Federal officers/employees | ✅ yes | 🟢 GREEN | Federal employee work, official duties. |
| US Treasury daily yields (`home.treasury.gov`) | Federal officers/employees | ✅ yes | 🟢 GREEN | Federal employee work. |
| A NASA/NOAA dataset built by a **named contractor** under a retained-rights clause | Contractor | ❌ no (unless contract assigned rights to gov) | 🔴 RED / check contract | Contractor may hold copyright; must read the contract / data-rights clause. |
| A **state** energy commission's electricity dataset | State agency | ❌ no (§105 is federal-only) | 🔴 RED / check state policy | State may copyright; need an explicit open-data license (often CC-BY — then YELLOW/GREEN *via the license*, not via §105). |
| A **foreign** central bank's statistics | Foreign gov | ❌ no | 🔴 RED / check that body's terms | No §105 equivalent; many have their own (sometimes open) licenses. |
| Eurostat / ECB / World Bank | Foreign/international, **but with an explicit open license** | n/a (license, not §105) | 🟢/🟡 via the license | The GREEN basis is CC-BY 4.0 / a stated open license **with attribution**, NOT §105. |

> **The cross-link:** when a state/local/foreign government *does* publish openly, your GREEN basis is the
> **explicit open license** (CC0/CC-BY/ODC) covered in
> [`theory-open-data-licenses.md`](./theory-open-data-licenses.md) — never §105. World Bank is the canonical
> example in our ledger: it is GREEN, but on a **CC-BY 4.0** basis (attribution required), not a
> public-domain one.

### 3.5 Detecting it in code

There is no single API field for "was this authored by a contractor" — this trap is irreducibly a
**human read of the contract / data-rights clause / agency policy**. What code *can* do is force the human
to record the answer and refuse to default to GREEN:

```python
"""
T2 guard — gov-contractor / non-federal trap.
§105 public-domain is claimable ONLY when all three facts are affirmatively recorded.
Code cannot infer 'authored by a federal employee' — it can refuse to assume it.
"""
from pydantic import BaseModel, model_validator


class GovPublicDomainBasis(BaseModel):
    """Required evidence to stamp a source as 17 USC 105 GREEN. Every field defaults to the SAFE answer."""
    is_federal_body: bool = False              # NOT state/local/foreign
    authored_by_officers_employees: bool = False  # NOT a contractor/grantee who retained copyright
    no_third_party_copyright_inputs: bool = False  # no embedded RED material (the T1 cousin)
    evidence_url: str = ""                     # the agency policy / contract clause / statute citation

    @model_validator(mode="after")
    def must_prove_all_three(self):
        claims_105 = self.is_federal_body and self.authored_by_officers_employees \
            and self.no_third_party_copyright_inputs
        if claims_105 and not self.evidence_url:
            raise ValueError("17 USC 105 GREEN claimed but no evidence_url recorded — cite the basis.")
        return self

    @property
    def verdict(self) -> Verdict:
        if (self.is_federal_body and self.authored_by_officers_employees
                and self.no_third_party_copyright_inputs):
            return Verdict.GREEN
        return Verdict.RED   # any missing leg → conservative RED (cf. T7 silent-ToS default)
```

### 3.5b A note on the §105(a) carve-back (the assignment clause)

§105(a) ends with "*the United States Government is not precluded from receiving and holding copyrights
transferred to it by assignment, bequest, or otherwise.*" This is the **inverse** trap: a work on a gov site
might be **copyrighted, held by the government**. Public-domain (no one can stop you) and
government-held-copyright (the gov can) are different. In practice this is rare for the data series we touch,
but it is why "the government published it" never *by itself* equals "you may redistribute it" — you must
still confirm the work is a §105 *work of the US government* and not a copyright the gov merely *holds*.

### 3.6 The verdict and the ledger linkage

**Verdict:** 🟢 GREEN only on positive proof of (federal + officer/employee-authored + no third-party
inputs); otherwise 🔴 RED. The GREEN spine in our ledger (SEC EDGAR, Treasury, BLS, CFTC COT) all pass T2 —
they are federal-employee works. World Bank is GREEN on **CC-BY**, *not* §105, and is the standing reminder
that the open-license path and the §105 path are different doors.

---

## 4. T3 — The Ethics-in-Government-Act trap: public-domain DATA, but a STATUTE bans commercial use

### 4.1 The surface appearance — this one is the most dangerous, because the *license* analysis passes

You want a "Politicians" / congressional-trading feature: members of Congress disclose their securities
trades in **Periodic Transaction Reports (PTRs)** under the STOCK Act. You source them from the House Clerk /
Senate eFD portals (or an aggregator: Quiver Quantitative, Unusual Whales, Capitol Trades). The reasoning:

> "These are *mandatory government disclosure filings*, published by the House Clerk and the Senate on
> official `.gov` portals. They're government records — public domain under 17 USC §105. **GREEN.**"

And the **copyright** analysis is *correct*. The filings genuinely are government records with no copyright.
That is exactly what makes this the worst trap in the file: a by-the-book licensing review checks copyright,
finds it clear, and stamps GREEN — **while missing an entirely separate body of law that bars the use.**

### 4.2 The real rule — a NON-copyright statutory bar

The **Ethics in Government Act**, as recodified at **5 U.S.C. §13107(c)**, makes it *unlawful* to use these
reports for a commercial purpose, with a civil penalty — independent of, and unreached by, copyright law:

> "It shall be unlawful for any person to obtain or use a report — (A) for any unlawful purpose; **(B) for
> any commercial purpose, other than by news and communications media for dissemination to the general
> public**; (C) for determining or establishing the credit rating of any individual; or (D) for use,
> directly or indirectly, in the solicitation of money for any political, charitable, or other purpose."
> — 5 U.S.C. §13107(c)(1), `law.cornell.edu/uscode/text/5/13107`

> "The Attorney General may bring a civil action against any person who obtains or uses a report for any
> purpose prohibited in paragraph (1) of this subsection. The court in which such action is brought **may
> assess against such person a penalty in any amount not to exceed $10,000.**"
> — 5 U.S.C. §13107(c)(2), *ibid.*

### 4.3 Why this is invisible to a license analysis

A licensing pipeline asks *one* question — "is the bytestream encumbered by copyright?" — and for a gov
disclosure the honest answer is *no*. **§13107 is not a copyright provision.** It is a use-restriction in the
*ethics* title (Title 5, the government-organization-and-employees title), enforced by the Attorney General,
not by a copyright holder. So:

- Copyright gate: **passes** (gov record, no §105 copyright).
- A naive `is_copyright_free → commercial_ok` pipeline therefore returns **GREEN**.
- The statutory-use gate (`statutory_use_bar` in the §1 model) is the one and only thing that catches it —
  and only if you *knew to look for it.*

This is the textbook case for **Gate 2** in the §1 conjunction: a non-copyright legal bar a license analysis
never sees. It is *why* the verdict model has a `statutory_use_bar` field at all.

### 4.4 The "news media" carve-out is a trap-within-a-trap

The statute exempts "news and communications media for dissemination to the general public." It is tempting
to claim it: "we're a media/information product, so we're covered." **Do not rely on it as a license:**

1. **It is an affirmative defense, not a grant.** It says certain *conduct* isn't unlawful; it does not
   *license* you. You'd be asserting it in court after the AG sued.
2. **"News and communications media" is undefined in the section and untested for an AI data-analytics
   product.** Whether an automated feature that algorithmically republishes individual members' trades for a
   commercial product qualifies as "news media … for dissemination to the general public" is an open legal
   question, not a settled safe harbor.
3. **The penalty is per-violation and the AG is the enforcer** — you cannot settle with a copyright holder
   the way you could license a copyrighted feed; there is no counterparty to buy a license from.

**Verdict:** treat congressional-trading disclosures as 🔴 **RED by statute**, regardless of the (correct)
public-domain copyright status, until legal sign-off. The aggregators (Quiver, Unusual Whales, Capitol
Trades) inherit the same bar *and* add their own ToS — sourcing from them does not cure §13107.

### 4.5 The general lesson (this trap is a family, not a one-off)

§13107 is the case we have hit, but the *pattern* generalizes: **a use can be barred by a statute outside
copyright even when the data is copyright-free.** Other members of this family to keep on the radar:

| Data | Copyright status | The non-copyright bar |
|---|---|---|
| Congressional/exec/judicial financial disclosures | Public domain | Ethics in Government Act, 5 USC §13107(c) — commercial-use bar |
| Driver / motor-vehicle records | Often gov records | Driver's Privacy Protection Act (18 USC §2721) |
| Certain court records with PII | Public record | PACER terms + privacy redaction rules |
| Personal data of EU/UK/CA residents in any feed | n/a to copyright | GDPR / UK-GDPR / CCPA — a *processing* restriction, not a copyright one |

**The actionable rule:** when a source involves **disclosures about identified individuals**, the copyright
gate is necessary but never sufficient — add the statutory-use gate and search for the governing
disclosure/privacy statute *before* shipping.

### 4.6 The ledger row

| Source | Verdict | Why |
|---|---|---|
| Congressional trading (House Clerk PTR / Senate eFD / Quiver / Unusual Whales / Capitol Trades) | 🔴 RED by statute | 17 USC §105 (copyright public-domain) does NOT cure the **Ethics in Government Act 5 USC §13107(c)(1)**: unlawful to "use a report… for any commercial purpose, other than by news and communications media for dissemination to the general public" (civil penalty up to $10k). The "news media" carve-out is an untested affirmative defense, not a license. **Politicians tab = CUT** pending legal sign-off. |

---

## 5. T4 — The free-tier trap: an API key that WORKS is not a license to DISPLAY

### 5.1 The surface appearance

You sign up for a free API tier (CoinGecko Demo, Twelve Data Basic, Finnhub Free, FMP Free, Tiingo). You get
a key. The endpoint returns 200 OK with real, current data. The reasoning:

> "We have a working key, the data flows, there's no paywall. We can build the product on it — GREEN, or at
> least good enough to ship."

This is the single most common trap because it conflates two completely different things the API *response*
cannot distinguish: **the right to fetch** (access) and **the right to show** (display/redistribution). The
HTTP 200 answers the first and is silent on the second; the ToS answers the second and almost always says
*no* for a free tier.

### 5.2 The real rule, provider by provider (primary ToS text)

**CoinGecko Demo** — personal use, attribution required, redistribution prohibited:

> "You are **not permitted to sell, rent, lease, sub-license, re-distribute or syndicate** access to the
> CoinGecko API or part thereof."
> — CoinGecko API Terms of Service, `coingecko.com/en/api_terms`

> "Users of the CoinGecko API must duly attribute ownership to CoinGecko by displaying prominently the
> message **'Powered by CoinGecko'**" (legible, ≥ font size 10).
> — *ibid.* / `brand.coingecko.com/resources/attribution-guide`

The Demo plan is explicitly "a free plan to try out the CoinGecko API … good for testing and exploration."
The "Powered by CoinGecko" attribution is required but **does not upgrade the Demo tier into a redistribution
license** — redistribution/white-labeling requires the **Enterprise** plan's custom license. So: even with
attribution rendered, the Demo path is RED for display-as-our-own.

**Twelve Data Basic** — individual plans are personal/internal only:

> "Individual plans are intended strictly for **personal or internal use**. … Internal Use means use solely
> for Customer's internal business purposes and **not for redistribution or external commercial purposes**.
> Any redistribution of data requires a separate agreement with Twelve Data."
> — Twelve Data, `support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage` and `twelvedata.com/terms`

**Finnhub Free** — personal / non-commercial:

> "The free tier is for **personal or non-commercial use** … You must delete all of our proprietary data at
> the end of your subscription. … For commercial licenses, … reach out to sales@finnhub.io."
> — Finnhub FAQ / ToS, `finnhub.io/faq`

**FMP Free** — explicitly non-commercial, no third-party display:

> "[The free plan is] limited to personal use only by individuals for their own personal, non-business and
> **non-commercial purposes**. … [Users may not] integrate the Data or Services into tools or applications
> accessible by third parties, or use the Services to **host, share, display, or provide content for
> others**. … Displaying or redistributing data sourced from FMP requires a specific **Data Display and
> Licensing Agreement** with FMP."
> — FMP Terms of Service, `site.financialmodelingprep.com/terms-of-service`

**Tiingo** — internal-use even on the published paid tier:

> "Data via the API is for **internal consumption only**. … Redistribution only upon special request **+
> ADDITIONAL FEES** — contact sales."
> — Tiingo terms, `api.tiingo.com` (as recorded in the ledger). The published \$250/mo tier is an
> *internal-use* SKU, **not** a priced display/redistribution license.

### 5.3 The discriminating principle: ACCESS ≠ DISPLAY (the four sub-confusions)

The free-tier trap is really four confusions, each independently fatal:

1. **"It returns data" ⇒ "we can show it."** No — the 200 is access; display is a contract term.
2. **"It's free" ⇒ "it's unrestricted."** No — free tiers are the *most* restricted (personal/non-commercial),
   not the least.
3. **"We added the attribution" ⇒ "now we're licensed."** No — attribution is a *condition* of some licenses
   (CC-BY, "Powered by CoinGecko"), but rendering it does not *create* a license the tier never granted. On a
   personal-use tier, attribution + display is still display-without-a-display-license.
4. **"A competitor shows it on the same provider" ⇒ "so can we."** No — they either bought a higher tier or
   are themselves exposed. Their risk is not your license.

### 5.4 The crucial nuance: RED gates DISPLAY, not ACCESS — you can still build informational features

A RED free-tier source is **not useless.** The distinction the platform must encode:

- ❌ You may **not** persist its numbers and **redistribute them as your own** displayable series with
  `commercial_ok=True`.
- ✅ You **may** call it for an *informational, attributed, non-persisted* feature where the gate stays
  `False` and the provenance shows the source — exactly the posture our ledger takes for Polymarket
  ("build the tabs, gate stays false, render attribution").

This is why the verdict model keeps `commercial_ok` *separate* from "do we integrate at all." RED ≠ REJECT.
(REJECT is T5 — when the ToS bans even the *access/AI* use.)

### 5.5 Detecting it in code — the structural rule

There is no API field that says "this tier is display-licensed." The only durable defense is a **registry
that pins every provider's tier to its display verdict**, and a CI lint that refuses `commercial_ok=True`
unless the registry says the *specific tier* grants display:

```python
"""
T4 guard — free-tier trap. Display rights live in a hand-maintained registry keyed by (provider, tier),
sourced from the primary ToS. The API response can never tell you; the contract does.
"""
from pydantic import BaseModel

class TierLicense(BaseModel):
    provider: str
    tier: str
    grants_display: bool            # does THIS tier's ToS grant public display/redistribution?
    attribution_required: str | None  # e.g. "Powered by CoinGecko" — a condition, not an upgrade
    tos_clause_url: str

# The registry — every row sourced from the provider's primary ToS (see §5.2 citations).
TIER_LICENSES: dict[tuple[str, str], TierLicense] = {
    ("coingecko", "demo"): TierLicense(
        provider="coingecko", tier="demo", grants_display=False,
        attribution_required="Powered by CoinGecko", tos_clause_url="https://www.coingecko.com/en/api_terms"),
    ("twelvedata", "basic"): TierLicense(
        provider="twelvedata", tier="basic", grants_display=False,
        attribution_required=None, tos_clause_url="https://twelvedata.com/terms"),
    ("finnhub", "free"): TierLicense(
        provider="finnhub", tier="free", grants_display=False,
        attribution_required=None, tos_clause_url="https://finnhub.io/faq"),
    ("fmp", "free"): TierLicense(
        provider="fmp", tier="free", grants_display=False,
        attribution_required=None, tos_clause_url="https://site.financialmodelingprep.com/terms-of-service"),
    ("tiingo", "power"): TierLicense(   # the published $250/mo tier — STILL internal-use only
        provider="tiingo", tier="power", grants_display=False,
        attribution_required=None, tos_clause_url="https://api.tiingo.com"),
}

def commercial_ok_for_tier(provider: str, tier: str) -> bool:
    lic = TIER_LICENSES.get((provider, tier))
    if lic is None:
        return False                # unknown tier → conservative RED (T7).
    return lic.grants_display       # only a registry-confirmed display grant flips it True.
```

### 5.6 The verdict and the ledger rows

**Verdict:** 🔴 RED for display on every free tier (and for Tiingo, even the published paid tier). Access is
fine for informational/attributed/non-persisted features with the gate kept `False`.

| Source | Fetch path | Verdict | Governing clause (short) |
|---|---|---|---|
| Twelve Data (free) | `api.twelvedata.com` | 🔴 RED | Individual/Basic = "personal/internal" use; no third-party display/redistribution. |
| CoinGecko Demo | `api.coingecko.com` (demo key) | 🔴 RED | Demo scoped to personal use; "Powered by CoinGecko" required; redistributing data as your own = prohibited. |
| Finnhub (free) | `finnhub.io` | 🔴 RED for display | Free tier personal-use only; not for public display/redistribution. |
| FMP (free) | `financialmodelingprep.com` | 🔴 RED for display | Free tier non-commercial. |
| Tiingo | `api.tiingo.com` | 🔴 RED (unpriced) | "internal consumption only … Redistribution only upon special request + ADDITIONAL FEES." \$250/mo tier is internal-use, NOT a display SKU. |

---

## 6. T5 — The AI/ML-use-ban trap: a ToS that forbids the very thing you're building → REJECT

### 6.1 The surface appearance

You want prediction-market data and Kalshi has a clean public API. The reasoning:

> "It's a public API, returns market probabilities, we'll cache it and let the model write a one-line blurb
> over it. Worst case it's RED like the other free tiers — informational, attributed, gate stays false."

The trap: you reach for the *RED* posture (build informationally, keep the gate false) — but Kalshi's ToS
doesn't just withhold a *display* license, it **affirmatively prohibits the exact operations your pipeline
performs**: caching, public display, **and** machine-learning / AI use. When the ToS forbids the use itself,
the verdict isn't RED — it's **REJECT** (don't integrate at all).

### 6.2 The real rule (primary source)

Kalshi's **Data Terms of Service** prohibit, without prior written consent, the operations that *define* a
data-analytics platform — software development including AI/ML training, and providing cached/archived data:

> "[Without Kalshi's prior written consent, you may not] develop any software program, including training a
> **machine learning or artificial intelligence system**, or **provide archived or cached data sets**
> containing Kalshi Data to another person."
> — Kalshi Data Terms of Service, `kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf`

Our ledger summarizes the full set of named prohibitions: the Data ToS "bans non-commercial-only use,
'providing archived or cached data sets,' public display, scraping, AND any 'machine learning and/or
artificial intelligence' use." Three of the platform's *core mechanisms* — **caching** (the time-series
store persists every series), **public display** (the whole product is a display surface), and **AI use**
(the agent reasons over the data) — are each independently named as prohibited.

### 6.3 The discriminating principle: RED vs REJECT

This is the line between **Gate 3** (no display grant → RED) and **Gate 4** (the use itself is forbidden →
REJECT) in the §1 model:

| | RED (e.g. CoinGecko Demo) | REJECT (Kalshi) |
|---|---|---|
| May you **access** the API? | Yes | Yes (technically), but the ToS forbids the use |
| May you **persist/cache** it? | Not for redistribution as your own | **No** — caching itself is named-prohibited |
| May you build an **informational, attributed** feature? | ✅ Yes (gate `False`, render attribution) | **No** — display + AI use are named-prohibited |
| May the **model reason over it**? | Yes (it's your access, informational) | **No** — "machine learning and/or artificial intelligence" use is named-prohibited |
| Verdict | 🔴 RED | ⛔ REJECT — do not integrate |

The defining feature of REJECT: there is **no posture** in which integrating is compliant. RED says "you may
build informationally but not display commercially." REJECT says "the building itself is prohibited." For an
AI-over-data product specifically, an **AI-use ban is automatically REJECT**, because reasoning over the data
is the product.

### 6.4 Detecting it in code

REJECT sources must be **blocklisted at the ingest boundary** — not merely gated `False`, because even an
informational read violates the ToS:

```python
"""
T5 guard — AI/ML-use-ban → REJECT. A REJECT source must never be fetched at all, in any posture.
This is stricter than commercial_ok=False; it's a hard ingest blocklist.
"""
REJECTED_SOURCES: dict[str, str] = {
    # source_id -> the named-prohibition that makes it REJECT (not merely RED)
    "kalshi": ("Data ToS bans caching, public display, AND machine-learning/AI use — each a core "
               "mechanism of this platform. No compliant posture exists. "
               "https://kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf"),
}

def assert_integratable(source_id: str) -> None:
    """Call at the TOP of every fetcher factory. REJECT sources fail closed before any network call."""
    if source_id in REJECTED_SOURCES:
        raise PermissionError(
            f"Source '{source_id}' is REJECT (ToS forbids the use outright): {REJECTED_SOURCES[source_id]}"
        )
```

### 6.5 The verdict and the ledger row

| Source | Fetch path | Verdict | Governing clause (short) |
|---|---|---|---|
| Kalshi | `api.elections.kalshi.com/trade-api/v2` | ⛔ REJECT | Data ToS bans non-commercial-only use, "providing archived or cached data sets," public display, scraping, AND any "machine learning and/or artificial intelligence" use. Caching + display + AI-blurb are all named prohibited. **Do not integrate.** |

---

## 7. T6 — The derived-data trap (YELLOW): "we computed it" doesn't escape the license

### 7.1 The surface appearance

You want **CME FedWatch**-style rate-cut probabilities, or an options-implied-move number. The reasoning:

> "FedWatch is a *probability* CME *calculates* from Fed Funds futures — it's not raw exchange data, it's a
> derived statistic. And even if we computed our own version from futures prices, *we* did the math, so it's
> our output. No CME license needed."

The trap: deriving a statistic from licensed data does **not** strip the license. Exchanges (CME, ICE, etc.)
explicitly license **derived data** — the outputs of computations performed *on* their market data — as a
separate product. You don't escape by transforming; you trigger a *different* license tier.

### 7.2 The real rule (primary source)

CME Group maintains a dedicated **Derived Data License Agreement**, distinct from raw real-time and
historical data licenses:

> CME Group offers a **Derived Data License Agreement** governing the creation and distribution of works
> derived from CME market data; the base license allows creating limited derivative works for *internal
> business purposes*, and broader (external display/redistribution) use of derived outputs requires the
> appropriate license tier.
> — CME Group, `cmegroup.com/market-data/license-data.html` and
> `cmegroup.com/market-data/files/cme-derived-data-license-agreement.pdf`

> "All Non-Display Use must be licensed directly with CME Group under an Information License Agreement
> (ILA)…"
> — CME Group Data Licensing Policy Guidelines,
> `cmegroup.com/market-data/distributor/files/cme-group-data-licensing-policy-guidelines-and-non-display-licensing-faq.pdf`

FedWatch itself is "market-derived probabilities of FOMC interest rate moves" built on CME Fed Funds futures
— i.e. a *derived* product over CME data. Redistributing/displaying it (or our own equivalent computed from
CME futures) on a commercial product is a **derived-data** use, which CME licenses.

### 7.3 The discriminating principle: transformation does not launder a license

This is the **contamination rule** from
[`theory-contamination-derived-data-rule.md`](./theory-contamination-derived-data-rule.md) seen from the
single-source angle: a value computed *from* a licensed input **inherits** the input's license. The naive
intuition "I did the math, so it's mine" is exactly backwards for market data — the *input prices* are the
licensed asset, and the derived statistic is a downstream work the licensor explicitly reserves rights over.

| What you think you have | What you actually have | License triggered |
|---|---|---|
| "Our probability, our computation" | A derivative work of CME Fed Funds futures prices | CME **Derived Data License** |
| "An implied move we calculated" | A derivative of exchange option prices | The exchange's derived-data tier |
| "A custom index we built from their constituents' prices" | A derivative of the licensed constituent feed | The data owner's derived-data/index license |

**Why YELLOW, not RED:** unlike a free-tier RED (no path to display short of a fundamentally different
provider relationship), a derived-data use has a *defined, purchasable* license. It is **conditional** — the
display is allowed *once the derived-data license is signed*. So it sits at YELLOW: not GREEN (you don't have
the license yet), not flatly RED (there's a clear, named path to GREEN). The build posture: you may design
and prototype the feature, keep `commercial_ok=False`, and the YELLOW flag is a *procurement task* ("get the
CME Derived Data License") rather than a *cut* (T3) or a *blocklist* (T5).

### 7.4 Detecting it in code

YELLOW sources carry a `requires_license` pointer so the gate cannot flip to `True` without recording that
the license was actually obtained:

```python
"""
T6 guard — derived-data YELLOW. A derived statistic over a licensed feed cannot be GREEN until the
derived-data license is signed and recorded. commercial_ok stays False; the YELLOW flag is a procurement TODO.
"""
from pydantic import BaseModel, model_validator

class DerivedDataStatus(BaseModel):
    source_id: str
    is_derived_from_licensed_feed: bool        # computed FROM CME/ICE/index data?
    derived_data_license_signed: bool = False  # has the derived-data license actually been obtained?
    license_doc_url: str = ""

    @property
    def verdict(self) -> Verdict:
        if not self.is_derived_from_licensed_feed:
            return Verdict.GREEN   # not derived from a licensed feed → this gate is N/A
        return Verdict.GREEN if self.derived_data_license_signed else Verdict.YELLOW

    @model_validator(mode="after")
    def green_needs_paperwork(self):
        if self.is_derived_from_licensed_feed and self.derived_data_license_signed and not self.license_doc_url:
            raise ValueError("Derived-data GREEN claimed but no signed-license doc recorded.")
        return self
```

### 7.5 The verdict and the ledger row

| Source | Verdict | Why |
|---|---|---|
| CME FedWatch / options-implied move | 🟡 YELLOW | CME-derived → needs a Derived-Data License to display. |

---

## 8. T7 — The silent-ToS trap: silence is not permission → RED by default

### 8.1 The surface appearance

You find a source — a community sentiment feed (ApeWisdom over Reddit/WSB), a niche data site, an
undocumented endpoint. You read its terms and… there *aren't* any clear ones about commercial
redistribution/display. The reasoning:

> "Their ToS doesn't *say* we can't display it. No prohibition = permission. GREEN (or at least fine)."

The trap is reading **absence of a prohibition as presence of a grant.** Copyright and data rights are
*default-closed*: a work is protected unless a license *grants* you rights. Silence grants nothing.

### 8.2 The real rule

Two independent legal defaults converge on RED:

1. **Copyright is opt-out, not opt-in.** Under the Berne framework (and US law since 1989), original works
   are protected *automatically on creation*, with **no notice required**. The absence of a "©" or a stated
   license does not place a work in the public domain — it means the default exclusive rights apply. (See
   [`theory-open-data-licenses.md`](./theory-open-data-licenses.md) on why "no license stated" ≠ open.)
2. **A ToS that is silent on display/redistribution has not *granted* it.** A license is an affirmative
   grant of specified rights. If the grant is absent, you have not received the right, no matter that no
   sentence forbids it.

Our own rule states it directly: *"When a ToS is silent or ambiguous about commercial
redistribution/display, the verdict is RED."*
([`.claude/rules/commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md);
[`sources-ledger.md`](../../../memory/sources-ledger.md) header.)

### 8.3 The discriminating principle: the burden of proof is on the GRANT

The trap inverts the burden. The correct posture:

- To set `commercial_ok=True`, you must point to an **affirmative** grant: a public-domain statute (§105), a
  CC0/CC-BY/ODC license, or a purchased display tier. **One of these must exist and be cited.**
- If you cannot point to such a grant — because the ToS is silent, ambiguous, missing, or only addresses
  *access* — the answer is **RED**. Not "probably fine," not "no one will mind." RED.

This is why the verdict model defaults *every* gate to the closed value and the ledger defaults
`commercial_ok` to `False`. The default *is* the silent-ToS rule, encoded.

### 8.4 The "scraping with no ToS at all" sub-case

A source with literally no terms (a raw endpoint, an unmaintained site) is **not** more permissive than one
with restrictive terms — it is *equally* RED, because the copyright default still applies and you have *no*
grant. Add: scraping may independently violate the *site's* anti-automation terms or the CFAA-class access
rules even where copyright is unclear. Silence on the license does not imply silence on access.

### 8.5 Detecting it in code

The silent-ToS rule is the **default branch** of every classifier in this file — it's what the `else`
returns. Make it loud:

```python
"""
T7 guard — silent-ToS default. There is no positive grant on record → RED. This is the default arm of
EVERY classifier; it must be explicit, never an accidental fall-through.
"""
def classify_with_silent_default(grant: GrantEvidence | None) -> Verdict:
    if grant is None:
        return Verdict.RED          # no affirmative grant recorded → RED. Silence ≠ permission.
    if grant.kind in {"us_gov_105", "cc0", "purchased_display_tier"}:
        return Verdict.GREEN
    if grant.kind in {"cc_by", "odc_by"} and grant.attribution_rendered:
        return Verdict.GREEN        # GREEN only WITH the attribution actually rendered (see open-data theory)
    return Verdict.RED              # an ambiguous/partial grant is still RED.
```

### 8.6 The ledger row

| Source | Verdict | Why |
|---|---|---|
| ApeWisdom / Reddit / StockTwits / X direct | 🔴 RED | No published ToS / non-commercial. |

---

## 9. T8 — The GREEN-but-WRONG trap: correct license, incorrect number

### 9.1 The surface appearance

You source company financials from **SEC EDGAR** — unambiguously GREEN (US-gov public domain, §105). The
reasoning:

> "EDGAR is GREEN, so we're done — we can display these XBRL facts."

The trap: **licensing and correctness are orthogonal gates.** A GREEN source can hand you a *wrong* number.
Displaying a wrong number violates the *other* non-negotiable — "never invent a finance number" — even when
the licensing gate is flawless. GREEN clears *display rights*; it says nothing about *accuracy*.

### 9.2 The real rule (primary source — the EDGAR XBRL duplicate/non-comparable-facts problem)

EDGAR's company-facts / frames APIs return *every amount reported in every filing*, which produces
**duplicate and non-comparable facts** for the same concept and period:

> "The EDGAR API generally returns data for every amount reported in every filing, and inevitably, filings
> contain time-period comparisons and tables that re-use information already filed in prior periods. … it is
> not uncommon to see the same value repeated over and over again because that amount shows up in multiple
> filings."
> — *Introduction to Working with the SEC's EDGAR API*, `thefullstackaccountant.com/blog/intro-to-edgar`

> "The 'frame' attribute is used by the EDGAR frames API to 'aggregate one fact for each reporting entity
> that is last filed that most closely fits the calendrical period requested,' … but **if there are two
> different values for the same filing period in multiple filings (perhaps because of a change in estimate in
> the later filing), you won't see that history.** … a frame is generated for every separate calendar quarter
> in isolation, [so] any income statement disclosures summarizing performance over multiple quarters will be
> eliminated."
> — *ibid.*

So the *same* concept (say, `Revenues`) for the *same* period can appear with **different values** across an
original 10-Q and a later restatement/amendment, in different units, or aggregated over inconsistent
periods. Pick naively and you display a number that is *correctly licensed* and *factually wrong* (stale,
restated-away, or summed over the wrong window).

### 9.3 The discriminating principle: two orthogonal gates, both must pass

| Gate | Question | EDGAR's answer | Failure mode if you skip it |
|---|---|---|---|
| **License** (Gates 1–5) | May we display this? | ✅ GREEN (§105 public domain) | You'd block a usable public source for no reason |
| **Correctness** (Gate 6) | Is this the *right* value? | ⚠️ NOT guaranteed — duplicate/restated/non-comparable facts | You display a wrong number — violating "never invent a finance number" |

These are *independent*: a source can be GREEN-and-right (Treasury yields), GREEN-and-wrong (EDGAR naive
read), RED-and-right (a paid feed's accurate number you may not display), or RED-and-wrong. The licensing
skill owns Gates 1–5; **the numeric-grounding guard owns Gate 6** — but this file flags the intersection
because the trap is *thinking GREEN implies correct.*

### 9.4 The fix — a dedup / restatement / comparability gate before display

```python
"""
T8 guard — GREEN-but-WRONG (EDGAR XBRL facts). License is GREEN; correctness is a SEPARATE gate.
Resolve duplicates/restatements deterministically and require comparable units/period before display.
"""
from datetime import date
from pydantic import BaseModel

class XbrlFact(BaseModel):
    concept: str            # e.g. "Revenues"
    value: float
    unit: str               # e.g. "USD"
    period_start: date
    period_end: date
    filed: date             # filing date — later filing wins on restatement
    form: str               # "10-K", "10-Q", "10-K/A" (amendment), etc.
    frame: str | None       # present only on frame-deduplicated facts

def pick_canonical_fact(facts: list[XbrlFact], unit: str, start: date, end: date) -> XbrlFact | None:
    """
    Deterministically choose ONE comparable value for (concept, unit, period):
      1. filter to the requested UNIT (never mix USD with shares/EUR — non-comparable),
      2. filter to the EXACT period bounds (never sum mismatched windows),
      3. among matches, take the LATEST 'filed' (restatement/amendment supersedes original).
    Returns None if no comparable fact exists — caller then renders 'unavailable', never a guess.
    """
    candidates = [
        f for f in facts
        if f.unit == unit and f.period_start == start and f.period_end == end
    ]
    if not candidates:
        return None                       # no comparable fact → 'unavailable', NOT a fabricated number.
    return max(candidates, key=lambda f: f.filed)   # latest filing wins (handles restatements).

# The licensing verdict is GREEN; the DISPLAY decision is gated on pick_canonical_fact(...) is not None.
# GREEN-but-unresolved → render 'unavailable', because a wrong number violates 'never invent a finance number'.
```

### 9.5 The general lesson

GREEN sources still need a **correctness gate**: dedup, restatement-resolution, unit/period comparability,
unit-of-measure checks, and "no comparable fact → `unavailable`" (never a fabricated backfill). The licensing
skill's job ends at "may we display it"; this trap is the handshake to the numeric-grounding discipline that
owns "is it the right number."

### 9.6 The ledger row

| Source | Fetch path | Verdict | Governing clause (short) |
|---|---|---|---|
| SEC EDGAR | `data.sec.gov` (XBRL companyfacts/companyconcept/frames, `/submissions`) | 🟢 GREEN | Public domain (17 USC §105). Requires a descriptive `User-Agent` + ≤10 req/s fair-access. ⚠️ frames returns **duplicate/non-comparable facts** — a GREEN-but-wrong number still violates "never invent a finance number"; needs a dedup/restatement gate. |

---

## 10. The conditioned-GREEN sub-trap: GDELT, World Bank, and the unrendered attribution

A short but important trap that sits *inside* GREEN: a CC-BY / conditioned-GREEN source is GREEN **only when
its condition is actually met on the surface that displays it.** Render the data without the required
citation and you have *forfeited* the license — a GREEN source used RED-ly.

**GDELT** — its grant is broad, *conditioned on a rendered citation + link*:

> "all datasets released by the GDELT Project are available for **unlimited and unrestricted use for any
> academic, commercial, or governmental use of any kind without fee.** … any use or redistribution of the
> data **must include a citation to the GDELT Project and a link to this website
> (https://www.gdeltproject.org/).**"
> — GDELT, `gdeltproject.org/about.html`

**World Bank** — GREEN on **CC-BY 4.0**, which *requires* attribution. Drop the attribution and the CC-BY
grant lapses.

**The trap:** the attribution is treated as a payload field that "sits in the JSON" rather than a UI element
that must render on every surface. Our ledger is explicit: the GDELT citation "must render on every surface
that displays it, not just sit in the payload." So the condition is a **render obligation**, enforced at the
view layer, not merely a data field.

```python
"""
Conditioned-GREEN guard — a CC-BY/GDELT source is GREEN only if its attribution actually RENDERS.
The verdict is conditional on a UI obligation, not just a payload field.
"""
class ConditionedGreen(BaseModel):
    source_id: str
    attribution_text: str       # e.g. "Source: The GDELT Project (gdeltproject.org)"
    attribution_link: str       # e.g. "https://www.gdeltproject.org/"
    rendered_on_surface: bool = False   # set True ONLY by the view layer that actually shows it

    @property
    def verdict(self) -> Verdict:
        # GREEN only when the condition is met on the displaying surface; otherwise the grant lapses → RED.
        return Verdict.GREEN if self.rendered_on_surface else Verdict.RED
```

| Source | Fetch path | Verdict | Governing clause (short) |
|---|---|---|---|
| GDELT DOC 2.0 | `api.gdeltproject.org` | 🟢 GREEN (conditioned) | "Unlimited and unrestricted… commercial use" **with mandatory verbatim citation + link**. The condition must render on every surface that displays it. Only the numeric tone is GREEN — underlying article headlines are third-party. |
| World Bank | `api.worldbank.org` | 🟢 GREEN | CC-BY 4.0 (attribution). |

> **Nested trap inside GDELT:** "only the numeric *tone* is GREEN — underlying article *headlines* are
> third-party." So even a conditioned-GREEN source can have RED sub-fields. Display the GDELT tone score
> (GREEN, with citation); do **not** treat the third-party headline text it references as GREEN. This is the
> contamination rule running *within* a single source's payload.

---

## 11. The reviewer checklist — running every trap against a `commercial_ok=True`

When a PR sets `commercial_ok=True` (or stamps a verdict), the reviewer runs the *full* battery, not the one
trap the author considered. A `True` survives only if it clears **every** applicable gate:

```text
[ ] T1  Is the number HOSTED on a gov/aggregator site but OWNED by a third party? (FRED VIXCLS pattern)
        → if owner ≠ US-gov body, RED. Check the series-level copyright field, not the host.
[ ] T2  Is the §105 claim backed by (federal) AND (officer/employee-authored, not contractor) AND
        (no third-party inputs)? State/local/foreign gov ≠ §105. Contractor may have kept copyright.
[ ] T3  Is there a NON-copyright STATUTE barring this use? (disclosures → Ethics Act 5 USC 13107;
        personal data → privacy law). Copyright-clear ≠ use-permitted.
[ ] T4  Is this a FREE/personal/internal API tier? Access ≠ display. Registry must confirm THIS tier
        grants display. Attribution rendered ≠ license granted.
[ ] T5  Does the ToS FORBID our use (caching / display / AI-ML)? → REJECT, blocklist at ingest, not just gate False.
[ ] T6  Is this DERIVED from a licensed feed (CME/ICE/index)? → YELLOW until the derived-data license is signed.
[ ] T7  Is the ToS SILENT/ambiguous on display? → RED. No affirmative grant cited = no grant.
[ ] T8  License GREEN — but is the NUMBER right? Dedup/restatement/unit/period gate before display.
        No comparable fact → 'unavailable', never a fabricated backfill.
[ ] C   Conditioned-GREEN (CC-BY/GDELT): does the required attribution actually RENDER on the surface?
[ ] X   Composite: does this value INHERIT a RED/YELLOW input? (the contamination rule — see theory doc)
```

The CI lint (the `sources-lint`-class check for this product line) encodes the mechanical subset: every
`commercial_ok=True` in code must map to a 🟢 row in the `provenance_catalog`/ledger whose `fetch_path`
matches, and no `provenance_catalog` row may be 🟢 if any trap field (third-party-copyright, statutory bar,
free-tier-no-display, silent-ToS) is set. Human review owns T2 (contractor reads), T3 (statute search), and
T8 (correctness) — the ones no field can fully infer.

---

## 12. The whole catalogue, on one page

| Trap | Source(s) we hit it on | Surface appearance | Real rule (primary cite) | Verdict |
|---|---|---|---|---|
| **T1 gov-hosting ≠ PD** | FRED VIXCLS / 3rd-party FRED series | "It's on FRED (the Fed), so it's public domain" | FRED ToS: "making the data series available through the FRED API does not constitute … permission"; VIXCLS "Copyrighted: Citation Required" (CBOE ©) | 🔴 RED (gov-owned FRED series only = GREEN) |
| **T2 contractor ≠ §105** | (general) gov datasets by contractors / state / local / foreign | "A .gov published it → §105 public domain" | §105 covers "officer or employee … official duties" (17 USC 101); contractors may keep copyright; §105 is federal-only | 🔴 RED unless federal+employee+no-3p-inputs proven |
| **T3 statute bar** | Congressional trading (House/Senate/Quiver/UW/Capitol Trades) | "Public-domain gov disclosures → GREEN" | Ethics in Government Act 5 USC 13107(c): unlawful for "any commercial purpose," civil penalty ≤ \$10k; news-media carve-out is an untested defense | 🔴 RED by statute |
| **T4 free-tier ≠ display** | CoinGecko Demo, Twelve Data, Finnhub, FMP, Tiingo | "The free key works → we can show it" | Each ToS scopes free/individual tiers to personal/internal/non-commercial; redistribution needs a separate agreement | 🔴 RED for display |
| **T5 AI/ML-use ban** | Kalshi | "We'll cache it and let the model blurb it" | Kalshi Data ToS bans caching, public display, AND machine-learning/AI use | ⛔ REJECT |
| **T6 derived-data** | CME FedWatch / implied move | "We computed the probability, so it's ours" | CME licenses derived data separately (Derived Data License Agreement) | 🟡 YELLOW |
| **T7 silent ToS** | ApeWisdom / Reddit / StockTwits / X | "Their terms don't forbid it → fine" | Copyright is default-closed; silence is not a grant; rule: silent/ambiguous → RED | 🔴 RED |
| **T8 GREEN-but-wrong** | SEC EDGAR XBRL frames | "EDGAR is GREEN, so the number's fine" | frames returns duplicate/non-comparable/restated facts; correctness is a separate gate | 🟢 GREEN license / ⚠️ number needs dedup gate |
| **C conditioned-GREEN** | GDELT, World Bank | "It's GREEN, ship it" | CC-BY / GDELT grant is conditioned on a RENDERED citation+link; unrendered → grant lapses | 🟢 GREEN *iff* attribution renders |

---

## 13. References (where each fact in this file comes from)

**Primary law**
- 17 U.S.C. §105 (subject matter of copyright: US Government works) — `law.cornell.edu/uscode/text/17/105`
- 17 U.S.C. §101 (definition of "work of the United States Government") — `law.cornell.edu/definitions/uscode.php`
- Historical & Revision Notes to §105 (contractor case-by-case) — Cornell *ibid.* / `en.wikisource.org/wiki/United_States_Code/Title_17/Chapter_1/Sections_105_and_106`
- 5 U.S.C. §13107(c)(1)–(2) (Ethics in Government Act — prohibited uses + civil penalty) — `law.cornell.edu/uscode/text/5/13107`

**Secondary legal**
- *Copyright status of works by the federal government of the United States* — `en.wikipedia.org/wiki/Copyright_status_of_works_by_the_federal_government_of_the_United_States`
- Public Domain Sherpa, *US Government Works* — `publicdomainsherpa.com/us-government-works.html`
- ARL, *U.S. Copyright Status of U.S. Federal Government Works* — `arl.org/.../copyright-status-of-government-works.pdf`

**Provider / source ToS**
- FRED API Terms of Use — `fred.stlouisfed.org/docs/api/terms_of_use.html`
- FRED VIXCLS series (copyright status) — `fred.stlouisfed.org/series/VIXCLS`
- CoinGecko API ToS + Attribution Guide — `coingecko.com/en/api_terms` · `brand.coingecko.com/resources/attribution-guide`
- Twelve Data commercial/personal usage + terms — `support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage` · `twelvedata.com/terms`
- Finnhub FAQ/ToS — `finnhub.io/faq`
- FMP Terms of Service — `site.financialmodelingprep.com/terms-of-service`
- Tiingo terms — `api.tiingo.com`
- Kalshi Data Terms of Service — `kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf`
- CME Group derived-data + licensing policy — `cmegroup.com/market-data/license-data.html` · `cmegroup.com/market-data/files/cme-derived-data-license-agreement.pdf`
- GDELT terms — `gdeltproject.org/about.html`
- SEC EDGAR APIs + XBRL duplicate-facts discussion — `sec.gov/search-filings/edgar-application-programming-interfaces` · `thefullstackaccountant.com/blog/intro-to-edgar`

**In-repo**
- The live ledger (every trap row) — [`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md)
- The gate rule — [`.claude/rules/commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)
- Sibling theory: fetch-path licensing, open-data licenses, contamination/derived-data, PROV-O lineage —
  [`./theory-commercialok-fetch-path-licensing.md`](./theory-commercialok-fetch-path-licensing.md) ·
  [`./theory-open-data-licenses.md`](./theory-open-data-licenses.md) ·
  [`./theory-contamination-derived-data-rule.md`](./theory-contamination-derived-data-rule.md) ·
  [`./theory-prov-o-lineage-model.md`](./theory-prov-o-lineage-model.md)

> **The closing rule.** Every trap in this file is a place where a *single* check returns the wrong answer.
> The defense is never "check harder" — it's "check *more gates*." A source is GREEN only when it survives
> copyright (T1/T2), statute (T3), contract-grant (T4/T7), prohibited-use (T5), derived-data (T6), and —
> separately — correctness (T8) and the rendered-attribution condition (C). Default every gate closed; open
> one only against a primary-source citation you can paste into the ledger row.
