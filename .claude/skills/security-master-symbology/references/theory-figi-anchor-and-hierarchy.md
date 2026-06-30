# theory · FIGI as the canonical anchor + the FIGI hierarchy

> **Product line:** JPM-Markets re-engineering **data-analytics product line (NOT Lumina)** — the
> DataQuery/Fusion re-engineering's security-master/symbology layer. Greenfield: this is **theory +
> design**, no codebase `file:line` yet. The Python examples use the planned stack
> (Python 3.12+, Pydantic v2, `httpx`) but are illustrative, not yet-shipped code.
>
> **What this doc justifies:** the security-master's **non-negotiable #1 — anchor every instrument on its
> FIGI.** It is the first reference any symbology task should read, because every later decision
> (entity/instrument/listing modelling, cross-provider join keys, the licensing gate on descriptive
> metadata) depends on understanding *why* FIGI is the spine and *exactly* how the FIGI system is
> structured.

---

## 0. The one-paragraph thesis (read this first)

A security master needs **one identifier you can build the whole graph around** — a stable internal anchor
that (a) you are legally allowed to store and redistribute, (b) never silently changes meaning under you,
(c) can be resolved for free, and (d) covers every asset class you ingest. **FIGI is the only widely-used
identifier that satisfies all four.** Its 12-character *value* is dedicated to the public domain (you may
store and redistribute it with zero license), it is **never reused** and stays with the instrument **in
perpetuity** (it survives every corporate action, even a ticker change or a delisting), it is resolvable
through the free OpenFIGI API, and it spans equities, options, futures, FX, indices, corporate and
government bonds, loans, mortgages, money markets, municipals, and crypto. **CUSIP and ISIN fail at least
one of those four** — CUSIP is a licensed, proprietary, fee-bearing identifier under active antitrust
litigation; ISIN structurally wraps a national identifier (a CUSIP for US securities) and inherits that
license; both can mutate or recycle in ways FIGI guarantees it never will. So: **the anchor is the FIGI;
CUSIP/ISIN/SEDOL/ticker are stored as *cross-reference attributes hanging off* the FIGI, never as the
primary key.**

**The one trap this doc exists to prevent:** the FIGI *value* is public domain, but the **descriptive
metadata** OpenFIGI returns alongside it (`name`, `ticker`, `securityType`, `securityDescription` — Bloomberg
calls these the *Related Security Descriptions*) is provided **"AS IS" and is licensed separately**. Do
**not** assume the whole OpenFIGI payload is public-domain just because the identifier is. §7 is entirely
about this line — it is where teams get the licensing wrong.

---

## 1. Why anchor on FIGI, not ISIN/CUSIP

### 1.1 The four properties a security-master anchor must have

| Property | Why the master needs it | FIGI | ISIN | CUSIP |
|---|---|---|---|---|
| **Storable + redistributable (license-clean)** | You persist the key in your DB and serve it to consumers; a licensed key contaminates every row and channel. | **🟢 Public domain** (OMG/X9 MIT; dedicated to PD by Bloomberg ToS) | 🔴 Inherits the wrapped NSIN's license (US ISIN ⊃ CUSIP → fee-bearing) | 🔴 Proprietary; per-CUSIP issuance fee + ongoing data-license fees |
| **Immutable identity (never silently re-points)** | The join key cannot change meaning under your historical rows. | **🟢 Never changes for the instrument; never reused; survives all corporate actions** | 🟡 Generally stable, but a security-level change (re-domicile, restructure) can change it | 🟡 Mostly stable, **but recycled** for some classes (discount CP, agency discount notes, TBA pools) |
| **Free to resolve** | You must enrich and cross-reference at ingest without a paid feed gating the master. | **🟢 OpenFIGI API, free, keyless (rate-limited) or keyed (higher limit)** | 🔴 No free authoritative lookup; ANNA/vendors gate it | 🔴 Licensed lookup only |
| **Cross-asset coverage** | One key shape for equities *and* options *and* bonds *and* crypto, or you fragment the master per asset class. | **🟢 All asset classes incl. crypto, loans, mortgages** | 🟡 Mostly securities; uneven for derivatives/crypto | 🟡 US/Canada-centric; CINS extends internationally but still licensed |

Every load-bearing cell is sourced in the sub-sections below.

### 1.2 FIGI value = public domain (the storable property)

Bloomberg, as the FIGI Registration Authority, dedicates the FIGI **identifiers** to the public domain in
the OpenFIGI Terms of Service:

> "Bloomberg … hereby dedicates FIGI Identifiers to the public domain and makes FIGI Identifiers available
> to the public at large for free … FIGI Identifiers may be freely reproduced, distributed, transmitted,
> used, modified, built upon, or otherwise exploited by anyone for any purpose."
> — OpenFIGI Terms of Service, https://www.openfigi.com/docs/terms-of-service

The OMG/X9 standard reinforces this at the standard level:

> "The ASC X9.145 FIGI standard is the first X9 data standard incorporating the MIT Open Source License, in
> which the data created and identified within the standard will be available to the public. FIGI
> identifiers and Open Symbology metadata are available free of charge with no material impediments to
> their use. The identifiers can be used for research, trading and database mapping."
> — *Allocation Rules for the FIGI Standard*, v29.9 (July 2022), §1.2.2, https://www.openfigi.com/assets/local/figi-allocation-rules.pdf

> "FIGI is the only financial instrument identifier system offered under the MIT Open Source license."
> — *Allocation Rules*, §1.1.1 (FIGI Core Principles)

**Caveat carried to §7:** "Open Symbology metadata … available free of charge" is *not* the same as
"public domain." The free-of-charge *descriptive* metadata is governed by the separate AS-IS terms (§7).
The unambiguous public-domain dedication applies to the **identifier string itself**.

### 1.3 CUSIP / ISIN = restricted and mutable (the contrast)

**CUSIP is proprietary and fee-bearing.** CUSIP Global Services (CGS) charges issuers ~US$280 per CUSIP
and charges data providers ongoing license fees to *use* CUSIPs in their databases:

> "S&P charges securities issuers a fee (usually about $280 per CUSIP number) … and also charges data
> providers licensing fees for using CUSIPs in their databases."
> — Class-action coverage, https://kehoelawfirm.com/cusip-numbers-cusip-licensing-fees/

The licensing model is contested enough to have produced active US antitrust litigation against S&P
Global, FactSet (CGS's owner), CGS, and the ABA, alleging Sherman Act violations; the class sought to
recoup **over US$1 billion** in past license payments:

> "The lawsuit alleges that S&P, CGS, the ABA, and FactSet had no legal right to control the use of CUSIPs
> by financial institutions and therefore had no legal basis to impose either license agreements or
> license fees on them … The lawsuit seeks to recoup over US$1 billion in past payments."
> — https://www.classaction.org/news/antitrust-lawsuit-alleges-sandp-factset-conspired-to-eliminate-competition-in-financial-instrument-id-number-market

The litigation does **not** make CUSIPs free to you today. The CGS license is the operative legal reality
until and unless a court rules otherwise. **Treat a stored CUSIP as a RED-licensed attribute** (you can
hold it for matching internally if your data agreement allows, but redistribution/display rights are
gated). This is exactly the kind of `commercialOk:false` series the data-provenance layer exists to track.

**ISIN structurally inherits CUSIP's license for US securities.** An ISIN is not an independent identifier
— it *wraps* a national security identification number (NSIN):

> "The ISIN structure is: country code (2) + CUSIP (9) + ISIN check digit (1) … Characters 1-2: ISO 3166-1
> country code; Characters 3-11: National security identifier (CUSIP for US securities)."
> — https://en.wikipedia.org/wiki/CUSIP (and ISIN structure refs)

So a US ISIN literally *contains* the CUSIP. You cannot legally treat the ISIN as license-clean while the
CUSIP it embeds is licensed — the restriction travels with the embedded NSIN. (Outside the US the wrapped
NSIN is e.g. SEDOL for GB, WKN for DE — each with its own license posture; SEDOL is licensed by the LSE.)

**Both can mutate or recycle in ways FIGI guarantees against.** CUSIPs are recycled for some classes:

> "CUSIP identifiers are not reused except for discount commercial paper, government agency discount notes
> and TBA mortgage pools."
> — https://en.wikipedia.org/wiki/CUSIP

A recycled identifier is a **time-bomb in a security master**: a historical row keyed on a CUSIP that was
later reassigned to a *different* instrument silently corrupts every join over that key. FIGI's no-reuse
guarantee (§2.3) is precisely the property that makes it safe as the *internal primary key*, while CUSIP
is safe only as a point-in-time *attribute*.

### 1.4 The decision, stated as a rule

> **Anchor on FIGI. Store CUSIP/ISIN/SEDOL/ticker/MIC as cross-reference attributes that hang off the
> FIGI, each with its own `Provenance{commercialOk}`. Never use CUSIP or ISIN as the primary key of the
> instrument or listing table.**

Rationale recap: only FIGI is simultaneously (a) PD-storable, (b) immutable/never-reused, (c)
free-to-resolve, and (d) cross-asset. The other identifiers each break at least one — and the two that
break (license, mutability) are exactly the two that *corrupt a master silently* rather than failing
loudly.

---

## 2. FIGI structure: the 12 characters in depth

### 2.1 The canonical structure statement

> "FIGI is a twelve-character, alphanumeric, semantically meaningless identifier. The first 2 characters
> are upper-case consonants (including 'Y'), the third character is the upper-case 'G', characters 4-11 are
> any upper-case consonant (including 'Y') or integer between 0 to 9, and the last character is a numeric
> check-digit."
> — *Allocation Rules*, §1.1.2 (FIGI Structure)

Breaking that down position by position:

| Position(s) | Content | Constraint | Notes |
|---|---|---|---|
| 1–2 | **Certified-Provider prefix** | Two upper-case **consonants** (incl. `Y`); **no vowels** | Identifies who *issued* the FIGI. Bloomberg = `BB`; Kaiko (crypto) = `KK`. |
| 3 | **The literal `G`** | Always upper-case `G` | Marks the string as a global identifier. Fixed; never varies. |
| 4–11 | **Random body (8 chars)** | Upper-case consonants (incl. `Y`) or digits `0–9`; **no vowels** A/E/I/O/U | Semantically meaningless, randomly assigned — you **cannot** parse meaning out of it. |
| 12 | **Check digit** | Single numeric digit `0–9` | Computed from positions 1–11 (§2.5). |

**Why "semantically meaningless" matters for the master.** Unlike a ticker (`AAPL`) or a CUSIP (whose
first 6 chars identify the issuer), a FIGI body encodes *nothing* you can read. You must **never** attempt
to parse asset class, exchange, or issuer out of the 12 characters. All meaning lives in the *associated
metadata* (the descriptive payload), not in the identifier — that is the entire point of a
"semantically meaningless" identifier and the reason FIGI never has to change when an instrument's
attributes change.

> **Prefix subtlety — `BBG` vs `BB`.** The plain-English OpenFIGI explainer says "the first three positions
> are always filled with `BBG`" (https://www.openfigi.com/assets/content/figi-check-digit-2173341b2d.pdf).
> That is true *for Bloomberg-issued FIGIs*, which dominate the universe. The formal allocation rules
> generalise it: positions 1–2 are the *Certified-Provider* code, and the 3rd is always `G`. So Kaiko's
> crypto FIGIs are `KKG…`, not `BBG…` (§2.14 of the rules: "Kaiko originated FIGIs will begin with the `KK`
> prefix"). **Validation rule for the master: require `[B-DF-HJ-NP-TV-XYZ]{2}G…` for the prefix, not a
> hard-coded `BBG`,** or you will reject every Kaiko crypto FIGI.

### 2.2 No vowels — and why the value space is what it is

The body excludes the five English vowels (A, E, I, O, U) to prevent the random generator from accidentally
producing offensive or confusable words, and to keep the alphabet free of vowel/number look-alikes. With
vowels removed there are **21 consonants** (26 letters − 5 vowels, with `Y` counted as a consonant).

The allocation rules lay out the per-position cardinality explicitly:

```
Position:        1    2   3   4   5   6   7   8   9  10  11  12
Possibilities:   21   21  G   31  31  31  31  31  31  31  31  10
```
— *Allocation Rules*, §1.1.2

- Positions 1–2: 21 each (consonants incl. Y) — *the provider prefix*.
- Position 3: fixed `G` (1 possibility).
- Positions 4–11: **31 each** = 21 consonants + 10 digits.
- Position 12: 10 (the check digit `0–9`).

**The 852-billion figure.** The number quoted everywhere ("more than 852 billion potential values") is the
size of the body space *under a single fixed 2-char prefix* (i.e. under `BBG`):

> "The encoding supports more than 852 billion potential values, under the initial BBG prefix. In total,
> there are over 330 trillion potential available identifiers."
> — https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier

Verify the arithmetic from first principles — the body is positions 4–11, eight characters each with 31
possibilities:

```
31^8 = 852,891,037,441  ≈ 852.9 billion   ← "more than 852 billion … under the BBG prefix"
```

And the full space across all valid 2-consonant prefixes:

```
21 × 21 × (31^8) = 441 × 852,891,037,441 ≈ 376,165,047,611,481  ≈ 376 trillion
```

(The Wikipedia "over 330 trillion" is a conservative phrasing of the same order of magnitude; the exact
product of the per-position cardinalities is ~376 trillion. The check digit is determined, not free, so it
does not multiply the count. Either way the takeaway is identical and load-bearing: **the value space is
so vast that exhaustion is a non-issue — there is no economic pressure ever forcing reuse,** which is part
of *why* the no-reuse guarantee is credible.)

### 2.3 Never reused, perpetual, corporate-action-stable — the three guarantees

These three are the heart of why FIGI is the anchor. All three are stated **in the allocation rules
themselves** (the standard), not in a blog — confirm them from the rules/ToS, never from a secondary
source:

> "Each FIGI is proactively allocated upon instrument creation, where possible. **A FIGI is never reused
> and remains with the instrument in perpetuity. A FIGI does not change as a result of any corporate
> action.**"
> — *Allocation Rules*, §1.2.1

> "The FIGI identifier portion will never change once issued, establishing an identifier with permanence."
> — *Allocation Rules*, §1.1.1

> "All instruments, **active and inactive**, are allocated a FIGI. FIGI is never reused and will not change
> as a result of a corporate action."
> — *Allocation Rules*, §2.1 (General rules)

> "While other market identifiers or ticker symbols may change in response to the change of name, the FIGI
> will never change." — §3.2.5 (Change of Name)
> "The FIGI continues to exist for the Composite level, for the original Place of Listing and for each
> regional exchange/Trading Venue regardless of listing status." — §3.2.4 (Delisting)
> "Exchange trading symbols frequently change for preferred instruments. The FIGI remains the same and
> **remains with the instrument in perpetuity**." — §3.3.4

The three guarantees decomposed, and what each one buys the master:

| Guarantee | Exact meaning | What it buys the security master |
|---|---|---|
| **Never reused** | Once a FIGI is issued for an instrument, it is *never* assigned to a different instrument — even after the instrument goes inactive/delists. The FIGI is retired-but-kept, never recycled. | The internal primary key is **safe forever**. A historical fact row keyed on a FIGI can never be corrupted by that key later meaning something else. (Contrast CUSIP recycling, §1.3.) |
| **Perpetuity** | The FIGI stays bound to the instrument for the instrument's whole life and remains queryable after it dies (inactive instruments still resolve). | You can key a **full history** — including delisted/expired/matured instruments — on FIGI with no gaps. |
| **Corporate-action-stable** | Ticker changes, name changes, symbol changes, ID-number changes, mergers (for both A and B), spin-offs, when-issued→regular transitions, exchange-code changes — **none** change the FIGI. | The master does **not** have to re-key or migrate history on a corporate action. Only the *attributes* (ticker, name) change; the anchor holds. |

**The corporate-action stability is what makes FIGI uniquely a *primary key* rather than just an
identifier.** Worked from the rules (§3.2.1): when `GNV US → SAR US` (a ticker change), the composite FIGI
`BBG000Q6S3Z2` and every venue FIGI (`BBG000Q6S5V1`, …) are *unchanged*; only the ticker attribute moves
from `GNV` to `SAR`. In a master keyed on ticker, that event is a re-key nightmare; in a master keyed on
FIGI, it is a one-column attribute update. This is the difference between an identifier and an *anchor*.

### 2.4 What changing an attribute does (vs changing the instrument)

A subtle but critical corollary from the rules: a FIGI is allocated to a *distinct instrument*, and the
distinctness is what generates a new FIGI — **not** a change of attribute on the same instrument. The Index
example (§2.3.1) makes this concrete:

```
FIGI           Ticker     Market Sector   Attribute
BBG000HY4HW9   DAX        Index           Deutsche Boerse AG German Stock Index
BBG000LJ6S88   DAXF       Index           DAX Fixing                          ← different instrument → new FIGI
BBG000H4FSM0   SPX        Index           S&P 500 Index
BBG000VWRDV2   SPTR500N   Index           S&P 500 Net Total Return Index      ← different index → new FIGI
```

So the rule for the master is: **a new FIGI appears only when a genuinely new tradable/identifiable
instrument comes into existence** (new listing venue, new option strike, new bond tranche, new index
variant). An attribute mutation on an existing instrument keeps the FIGI and updates the attribute row.

### 2.5 The check digit (validate every FIGI at ingest)

The 12th character is a **Modulus-10 "Double Add Double"** check digit (a Luhn-family checksum) over the
first 11 characters. Validate it at ingest so a corrupted/typo'd FIGI is rejected before it poisons a join.

**The character→value map** (note: vowels appear in the *value scheme* even though they never appear in a
real FIGI body — A=10, E=14, I=18, O=24, U=30 — because the scheme is "A=10 and each subsequent letter +1";
the vowels are simply never *used* in a valid FIGI):

```
A=10  F=15  K=20  P=25  U=30  Z=35
B=11  G=16  L=21  Q=26  V=31
C=12  H=17  M=22  R=27  W=32
D=13  I=18  N=23  S=28  X=33
E=14  J=19  O=24  T=29  Y=34
```
— *FIGI Check-Digit Calculation*, https://www.openfigi.com/assets/content/figi-check-digit-2173341b2d.pdf

**The algorithm** (verbatim from the source):

> "To calculate the check-digit, using the first 11 digits and beginning at the last digit and working
> right to left, **every second digit is multiplied by two**. Letters are converted to numbers … The
> resulting string of digits (numbers greater than 10 become two separate digits) are added up. **Subtract
> the total from the next higher number ending in zero.** If the total … is a number ending in zero, then
> the check digit is zero."

**The official worked example** (IBM's NYSE listing, FIGI `BBG000BLNQ16`):

```
11-char base:   B   B   G   0   0   0   B   L   N   Q   1
char values:    11  11  16  0   0   0   11  21  23  26  1
multiplier:     1   2   1   2   1   2   1   2   1   2   1     (every 2nd from the right ×2)
after ×:        11  22  16  0   0   0   11  42  23  52  1
digit-sum:      1+1 + 2+2 + 1+6 + 0 + 0 + 0 + 1+1 + 4+2 + 2+3 + 5+2 + 1  = 34
next-higher-10: 40
check digit:    40 − 34 = 6        →  BBG000BLNQ16  ✓
```
— *FIGI Check-Digit Calculation* PDF (exact figures reproduced)

A reference implementation in Python (planned stack — Python 3.12+):

```python
# figi_check.py — validate a FIGI's check digit (Modulus-10 Double-Add-Double).
# Source of algorithm: openfigi.com/assets/content/figi-check-digit-2173341b2d.pdf

import re

# A=10, B=11, ... Z=35. Vowels are in the value scheme but never appear in a real FIGI body.
_VAL = {chr(ord("A") + i): 10 + i for i in range(26)}  # A->10 ... Z->35

# Structural shape: 2 consonants (incl Y) + 'G' + 8 body chars (consonants incl Y or digits) + 1 digit.
_CONSONANT = "BCDFGHJKLMNPQRSTVWXYZ"  # 21 letters, vowels AEIOU removed
_FIGI_RE = re.compile(
    rf"^[{_CONSONANT}]{{2}}G[{_CONSONANT}0-9]{{8}}[0-9]$"
)


def _char_value(c: str) -> int:
    """Map one FIGI character to its numeric value for the checksum."""
    return _VAL[c] if c.isalpha() else int(c)


def figi_check_digit(first_11: str) -> int:
    """Compute the check digit for the first 11 characters of a FIGI."""
    if len(first_11) != 11:
        raise ValueError("FIGI base must be exactly 11 characters")
    total = 0
    # Work right-to-left over positions 0..10; double every SECOND position from the right.
    # Rightmost (index 10) is NOT doubled; index 9 IS doubled; etc.
    for offset, ch in enumerate(reversed(first_11)):
        v = _char_value(ch)
        if offset % 2 == 1:          # every second digit from the right
            v *= 2
        # "numbers greater than 10 become two separate digits" -> sum the digits
        total += v // 10 + v % 10 if v >= 10 else v
    return (10 - total % 10) % 10    # next-higher-multiple-of-10 minus total; 0 if already a multiple


def is_valid_figi(figi: str) -> bool:
    """Full FIGI validation: shape + check digit."""
    if not (isinstance(figi, str) and _FIGI_RE.match(figi)):
        return False
    return figi_check_digit(figi[:11]) == int(figi[11])


# Self-test against the official worked example and a Kaiko crypto FIGI shape.
if __name__ == "__main__":
    assert figi_check_digit("BBG000BLNQ1") == 6        # IBM NYSE, from the official PDF
    assert is_valid_figi("BBG000BLNQ16") is True
    assert is_valid_figi("BBG000BLNQ17") is False      # wrong check digit
    assert is_valid_figi("BAG000BLNQ16") is False       # contains a vowel 'A' in the body -> shape fail
    assert _FIGI_RE.match("KKG000000DV5")               # Kaiko (crypto) prefix is accepted by the shape
    print("FIGI check-digit self-tests passed")
```

> **Why validate at ingest, not later.** A FIGI arriving from an upstream feed may be truncated,
> transposed, or have a digit corrupted. If it passes the regex but fails the check digit, it is a *typo of
> a real FIGI*, not a real FIGI — and silently inserting it creates an orphan instrument that no resolve
> will ever match. Reject (or quarantine to a dead-letter queue) at the boundary. The check digit catches
> the single-substitution and adjacent-transposition errors that dominate hand-entry and feed corruption.

> **Edge case worth a unit test:** when the digit-sum is itself a multiple of 10, the check digit is `0`
> (`(10 - 0) % 10 == 0`). The naive `10 - total % 10` would return `10` (two characters) — the outer `% 10`
> is what collapses it to `0`. The source says this explicitly: "If the total … is a number ending in zero,
> then the check digit is zero."

---

## 3. The three FIGI levels in depth

This is the single most important structural fact for the security master, because **the three FIGI levels
map almost exactly onto the three core tables of the master** (§4). Get the levels right and the schema
falls out of them.

The allocation rules name the levels precisely (§1.4):

- **Share Class FIGI** — "assigned to Equities and Funds. This enables users to link multiple Composite
  FIGIs for the same instrument in order to obtain an aggregated view for that instrument **across all
  countries globally**." (`shareClassFIGI`, Bloomberg `ID_BB_GLOBAL_SHARE_CLASS_LEVEL`/`ID236`)
- **Composite FIGI** — "enables users to link multiple FIGIs at the Trading Venue-level **within the same
  country or market** in order to obtain an aggregated view for that instrument." (`compositeFIGI`,
  Bloomberg `COMPOSITE_ID_BB_GLOBAL`/`ID145`)
- **FIGI (exchange/venue level)** — "For equity instruments an identifier is issued **per instrument per
  trading venue**." (`figi`, Bloomberg `ID_BB_GLOBAL`/`ID135`)

And the assignment rule that ties them together:

> "Equity instruments and equity options are allocated a FIGI at the Composite and Trading Venue level. For
> all other asset classes, only one FIGI gets assigned per security … Share Class Level assignment is
> allocated for all equity instruments, **except for Warrants**."
> — *Allocation Rules*, §2.1, §2.2

So the hierarchy is **three levels for equities/funds**, but collapses for non-equity asset classes (a bond
or a future has essentially one FIGI). Design the master to handle the full three-level case; the others
are degenerate sub-cases of it.

### 3.1 Level 1 — Share Class FIGI (the global, cross-listing root)

The Share Class FIGI is the **most aggregated** level. It identifies *the share class of the issuer's
equity, independent of where in the world it trades and in what currency*. Multiple Composite FIGIs (one
per country, §3.2) roll up to a single Share Class FIGI.

> "Multiple listings of the same class of the same instrument will be assigned the same FIGI at share class
> level. This level of FIGI assignment will link or connect all COMPOSITE FIGIs globally that represent the
> same class of the same instrument. **As the SHARE CLASS FIGI can be linked to more than one traded venue
> instrument, it will not load a single instrument.**"
> — *Allocation Rules*, §2.2.4

That last sentence is the key warning: **a Share Class FIGI is NOT itself a tradable line.** You cannot
"price" a Share Class FIGI directly — it is an abstraction that groups tradable lines. Treat it as the
*entity-class root*, never as a quotable instrument.

**The canonical IBM example** (§2.2.4) — one share class FIGI `BBG001S5S399`, many composite FIGIs:

```
COMPOSITE FIGI   SHARE CLASS FIGI   Ticker
(US listing)     BBG001S5S399       IBM US
BBG000BLNNH6     BBG001S5S399       IBM LN   (London)
BBG000NP2W23     BBG001S5S399       IBMA BB  (Belgium / Euronext Brussels)
BBG000JX3D13     BBG001S5S399       IBM GR   (Germany / XETRA)
BBG000K23JG0     BBG001S5S399       IBM* MM  (Mexico)
BBG000HW8Q13     BBG001S5S399       IBM-RM RM(Romania)
BBG00YCLP757     BBG001S5S399       IBM SW   (Switzerland)
BBG000BWZBM9     BBG001S5S399       IBM CI   (Chile)
BBG004BWKQJ8     BBG001S5S399
```

One company's ordinary share class, traded in nine countries → **nine** composite FIGIs → **one** share
class FIGI. That single `BBG001S5S399` is the right key for "show me everything about IBM's common stock,
anywhere."

> **The ~1:1-with-ISIN heuristic.** The share-class level is the level that corresponds most closely to an
> ISIN — both are *issuer-and-class-level, exchange/currency-agnostic* identifiers. The Twelve Data
> symbology guidance frames the share-class FIGI as roughly one-to-one with the ISIN for ordinary equity
> (an ISIN identifies the security at the issuer/class level, not the venue). **Use this as a heuristic,
> not a law:** it holds well for plain ordinary shares, but breaks for dual-listed structures, depositary
> receipts (ADRs/GDRs get their own ISIN *and* their own FIGIs), and multi-class issuers. So: map ISIN ↔
> share-class FIGI as a *strong hint* during cross-referencing, then verify, never as a guaranteed
> bijection. (We could not retrieve the Twelve Data article body — it now redirects to a trial-plan page —
> so this 1:1 framing is carried as an *industry heuristic*, corroborated by the structural fact that both
> the ISIN and the share-class FIGI sit at the issuer/class level above the venue. Treat as
> `[heuristic — verify per instrument]`.)

### 3.2 Level 2 — Composite FIGI (the country/market aggregate)

The Composite FIGI sits **between** the global share-class root and the individual venue lines. It
aggregates *all the trading-venue FIGIs for one instrument within a single country/market*.

> "The Composite Financial Instrument Global Identifier (FIGI) enables users to link multiple FIGIs at the
> Trading Venue-level within the same country or market in order to obtain an aggregated view for that
> instrument."
> — *Allocation Rules*, §1.4.2

The "True Composite vs Non-True Composite" distinction (§4.1.1 of the rules) is essential and trips people:

- **True Composite** — the composite represents *the totality of trading in a country* and has **no local
  exchange of its own**. The composite FIGI's `exchCode` (e.g. `US`) is never the same as any venue FIGI's
  `exchCode`. Example (§4.1.1):

  ```
  Exchange     Ticker    FIGI            Composite FIGI
  Composite    IBM US    BBG000BLNNH6    BBG000BLNNH6      ← composite: exchCode "US", no local exchange
  New York     IBM UN    BBG000BLNQ16    BBG000BLNNH6      ← venue: exchCode "UN" (NYSE), rolls up to US composite
  ```

  Note `IBM US`'s `figi == compositeFIGI == BBG000BLNNH6`: for a true composite, the composite row's own
  `figi` field equals its `compositeFIGI`. The NYSE line `BBG000BLNQ16` is a *distinct* venue FIGI that
  *points up* to `BBG000BLNNH6`.

- **Non-True Composite** — the composite exchange code *is also* a real local exchange, so the composite
  and one venue share a ticker+exchange. Example (Belgium `BB` = both the Belgium composite *and* Euronext
  Brussels):

  ```
  Exchange                 Ticker    FIGI            Composite FIGI
  Composite / EN Brussels  SPA BB    BBG000BRV654    BBG000BRV5T0
  Brussels NM              SPA NB    BBG000BRV6G2    BBG000BRV5T0
  ```

**Why the master cares:** if you naively assume "composite exchCode is never a venue exchCode," you will
mis-model every non-true-composite country (Belgium, etc.) and create duplicate or orphaned listing rows.
Model the composite as a first-class node that *can* coincide with a venue, and key venue→composite by the
explicit `compositeFIGI` field returned by OpenFIGI, **never** by string-matching exchange codes.

### 3.3 Level 3 — Exchange / Venue FIGI (the one tradable line)

The venue-level FIGI is the **most granular and the only directly tradable level**: one FIGI = one
instrument trading on one specific venue, in that venue's currency, under that venue's rules.

> "For equity instruments an identifier is issued **per instrument per trading venue**."
> — *Allocation Rules*, §1.4.1

This is the level at which **prices, order books, and market microstructure live**. When the time-series
warehouse stores a quote, it stores it against a *venue FIGI* (or you lose the venue/currency dimension).
The composite and share-class FIGIs are *roll-up keys for aggregation and display*, not price keys.

The MTF example (§4.1.2) shows venue granularity at its finest — the *same* shares on XETRA vs Tradegate
get **distinct** venue FIGIs even though they share a ticker and a share-class FIGI:

```
Exchange    Ticker    FIGI            Composite FIGI   Associated Comp.  Share Class FIGI
Xetra       STM GY    BBG006GS1WM1    BBG000GPS8R9     -                 BBG001SHC3X3
Tradegate   STM TH    BBG006GST336    BBG006GST327     BBG000GPS8R9      BBG001SHC3X3
```

Note Tradegate even has its *own* composite (`BBG006GST327`) distinct from the German composite
(`BBG000GPS8R9`) — MTFs frequently do not roll up into their "natural" national composite. The master must
not assume a venue's composite equals the issuer's home-country composite; trust the returned
`compositeFIGI` field per row.

### 3.4 The level relationship as a tree (and the cardinalities)

```
                        Share Class FIGI          (BBG001S5S399)            ← 1 per equity share class, global
                        ─────┬───────────┬──────────────┬────────────
                             │           │              │
                   Composite FIGI   Composite FIGI   Composite FIGI         ← 1 per country/market
                   (US)             (London/GB)      (Germany)
                   BBG000BLNNH6     BBG000NP2W23     BBG000JX3D13
                    │       │          │                │      │
                  Venue   Venue      Venue            Venue  Venue          ← 1 per (instrument × venue)
                  FIGI    FIGI       FIGI             FIGI   FIGI           ← THE TRADABLE LINE (prices here)
                  (NYSE)  (NASDAQ…)  (LSE)            (XETRA)(Tradegate…)
                  BBG000BLNQ16 …
```

| Level | Cardinality | Currency/Venue | Tradable? | Master role |
|---|---|---|---|---|
| Share Class | 1 per global share class | agnostic | **No** (not loadable) | Entity-class root / global aggregate key |
| Composite | 1 per country | agnostic within country | **No** (aggregate) | Country roll-up key |
| Venue | 1 per instrument × venue | **specific** venue + currency | **Yes** | Listing / price key |

---

## 4. Mapping the three levels onto the security master's tables

The three FIGI levels are not just a Bloomberg curiosity — they are a *ready-made normalized schema* for
the security master. The mapping is direct:

| FIGI level | Master table | Primary key | Holds |
|---|---|---|---|
| **Share Class FIGI** | `entity` (or `security_class`) | `share_class_figi` | The issuer's share class as a global concept; name, issuer LEI, asset-class family. Cross-refs: ISIN (heuristic), home country. |
| **Composite FIGI** | `instrument` | `composite_figi` | The instrument as traded *in one country*; country (ISO 3166), the composite ticker, FK → `entity.share_class_figi`. |
| **Venue FIGI** | `listing` | `figi` (venue-level) | The one tradable line; MIC/exchange code, currency, venue ticker, FK → `instrument.composite_figi`. **Prices/time-series key on this.** |

A concrete Pydantic v2 sketch (planned stack — illustrative, not yet-shipped):

```python
# security_master_models.py — the three FIGI levels as three tables. Pydantic v2 (planned stack).
from __future__ import annotations
from pydantic import BaseModel, Field, field_validator
import re

_CONSONANT = "BCDFGHJKLMNPQRSTVWXYZ"
_FIGI_RE = re.compile(rf"^[{_CONSONANT}]{{2}}G[{_CONSONANT}0-9]{{8}}[0-9]$")


def _valid_figi_shape(v: str) -> str:
    if not _FIGI_RE.match(v):
        raise ValueError(f"not a structurally valid FIGI: {v!r}")
    return v


class Entity(BaseModel):
    """Share-Class level: one row per global equity share class. NOT a tradable line."""
    share_class_figi: str = Field(description="ANCHOR. shareClassFIGI from OpenFIGI.")
    name: str | None = None                 # AS-IS metadata (see theory-licensing) -> provenance gated
    isin: str | None = None                 # heuristic ~1:1; verify, do not assume bijection
    home_country: str | None = None         # ISO 3166-1 alpha-2

    _v = field_validator("share_class_figi")(_valid_figi_shape)


class Instrument(BaseModel):
    """Composite level: one row per (share class x country). Aggregate, not directly tradable."""
    composite_figi: str = Field(description="compositeFIGI from OpenFIGI.")
    share_class_figi: str | None = Field(default=None, description="FK -> Entity. None for warrants/non-equity.")
    country: str | None = None              # ISO 3166-1 alpha-2
    composite_ticker: str | None = None     # AS-IS metadata -> provenance gated

    _vc = field_validator("composite_figi")(_valid_figi_shape)
    @field_validator("share_class_figi")
    @classmethod
    def _v_sc(cls, v: str | None) -> str | None:
        return _valid_figi_shape(v) if v is not None else None


class Listing(BaseModel):
    """Venue level: one row per (instrument x trading venue). THE tradable line. Prices key here."""
    figi: str = Field(description="ANCHOR for time-series. Venue-level figi from OpenFIGI.")
    composite_figi: str = Field(description="FK -> Instrument.")
    mic: str | None = None                  # ISO 10383 Market Identification Code
    exch_code: str | None = None            # Bloomberg/OpenFIGI exchange code (e.g. 'UN' = NYSE)
    currency: str | None = None             # ISO 4217
    venue_ticker: str | None = None         # AS-IS metadata -> provenance gated

    _vf = field_validator("figi")(_valid_figi_shape)
    _vcf = field_validator("composite_figi")(_valid_figi_shape)
```

**Three design notes that fall directly out of the FIGI rules:**

1. **`share_class_figi` is nullable on `Instrument`.** Warrants get no share-class FIGI ("Share Class Level
   assignment is allocated for all equity instruments, **except for Warrants**" — §2.2), and non-equity
   asset classes have only one FIGI per security (§2.1). So the FK up to `Entity` is optional; a bond or a
   warrant is an `Instrument` (or even just a `Listing`) with no `Entity` parent.
2. **For unlisted funds / private companies, `figi == composite_figi`** ("the FIGI and the COMPOSITE FIGI
   are equal to each other" — §2.2.3). Your schema must allow a `Listing.figi` to equal its
   `Instrument.composite_figi` without treating it as a data error.
3. **Prices/time-series key on `Listing.figi` (venue level), never on composite or share-class.** Only the
   venue level has a currency and a venue, which a quote needs. Aggregating to "IBM globally" is a *query*
   that rolls venue → composite → share-class, not a storage key.

> **Cross-reference table.** CUSIP/ISIN/SEDOL/ticker/MIC are *not* columns you trust as keys — they are
> rows in a `cross_reference(figi, id_type, id_value, provenance)` table, each carrying its own
> `commercialOk`. ISIN may *also* be denormalized onto `Entity` as a heuristic convenience, but the
> authoritative join is always FIGI↔FIGI. See the `theory-identifier-zoo` / `theory-licensing` references
> for the per-identifier license posture.

---

## 5. Asset-class coverage (one anchor for the whole universe)

A core reason FIGI works as *the* anchor is that it spans every asset class the data-analytics platform
ingests — you do not need a different identifier scheme per asset class. The allocation rules enumerate the
coverage; here is the map of §2's sub-sections, with the assignment-granularity rule for each:

| Asset class | Rules § | Granularity | Notes for the master |
|---|---|---|---|
| **Equities, Funds, Warrants** | 2.2 | Share-class + Composite + Venue (warrants: no share-class) | The full 3-level case. Unlisted funds/private: `figi == compositeFIGI` (§2.2.3). |
| **Index** | 2.3 | One FIGI per index variant | Price-return vs net-total-return are *different* FIGIs (§2.3.1). Non-equity indices incl. SOFR/SONIA (§2.3.2). |
| **Corporates & Preferreds** | 2.4 | One FIGI per tranche | Each tranche (REG S, 144A, Intl, Registered…) is its own FIGI (§2.4.1). Venue-level not assigned for corp bonds (RFQ market) (§4.2). |
| **Loans** | 2.5 | One FIGI per facility/tranche | Term Loan B2 vs B3 vs Strip → distinct FIGIs (§2.5). Loans had **no standard identifier before FIGI** — a genuine coverage win. |
| **Money Markets** | 2.6 | One FIGI per program/instrument | ECP vs ECD under one doc → two FIGIs (§2.6). |
| **Governments** | 2.7 | One FIGI per instrument | US Treasury when-issued keeps its FIGI through auction (§2.7.1); JGB/Canada have their own when-issued nuances (§2.7.2). |
| **Mortgages** | 2.8 | One FIGI per tranche/pool/TBA | CMO/ABS/CMBS tranches each get a FIGI; restructure → new FIGIs (§2.8.1). TBAs proactively allocated 1y out (§2.8.2). |
| **Municipals** | 2.9 | One FIGI at deal issuance | Follows MSRB rules (§2.9). |
| **Equity & Index Options** | 2.10 | Composite + Venue (US/CA/JP equity; US index) | Each strike is a FIGI; FIGI survives a venue dropping a strike (§2.10). |
| **Equity Futures** | 2.11 | One FIGI per contract; generics too | FIGI persists after expiry (§2.11). |
| **Non-Equity Futures & Options** | 2.12 | One FIGI per instrument/strategy | CME/ICE option strategies, LME inventory, swaps (except CDS — *not assigned*), virtual instruments. Generic spreads **not** assigned (§2.12.6). |
| **FX / FX Options** | 2.13 | One FIGI per object | Pegged currencies share a FIGI (GBP/JEP → `BBG0013HFH84`); some representations share a FIGI (§2.13.1). Listed FX options keep their FIGI after expiry (§2.13.2). |
| **Crypto** | 2.14 | Asset + Pair + Venue (instrument) | Issued by **Kaiko** (`KK` prefix); Bloomberg-era pairs carry `BB`. Three-level like equities: asset FIGI / pair FIGI / venue FIGI (§5.1 below). |

The X9.145 standard summarizes the breadth:

> "The standard covers financial instruments globally and across asset classes, including, but not limited
> to, common stock, derivatives, corporate and government bonds, as well as those that previously lacked
> standard identifiers, **such as crypto assets and loans**."
> — *Allocation Rules*, §1.2.2

**Design consequence:** the master's `Listing`/`Instrument` tables are *asset-class-polymorphic over a
single key shape*. You do not need `equity_listing` vs `bond_listing` vs `crypto_listing` tables keyed on
different identifier schemes — they all key on a FIGI of the identical 12-char shape. Asset-class-specific
*attributes* (coupon, maturity, strike, base/quote currency) are nullable columns or a typed sidecar, but
the **key is uniform**. This is the structural payoff of a cross-asset anchor.

> **Two "not assigned" gotchas to encode as validation, not surprises:** Credit Default Swaps (§2.12.5) and
> Generic Spreads (§2.12.6) are explicitly **not** allocated a FIGI. The master must tolerate instruments
> that *legitimately have no FIGI* for these classes — don't treat a missing FIGI on a CDS as a data error;
> route it to a non-FIGI-anchored fallback path (a synthetic internal key) rather than dropping the row or
> raising.

### 5.1 The crypto three-level hierarchy (Kaiko)

Crypto reuses the equity-style three-level pattern, which is why it slots cleanly into the same schema:

> "Crypto currency FIGIs are allocated at the **asset, pair and trading venue (instrument) level** … Kaiko
> originated FIGIs will begin with the `KK` prefix."
> — *Allocation Rules*, §2.14

```
Level                  Identifies                              Example                 FIGI
Asset FIGI (Base)      Individual currency                     Ethereum (ETH/XET)      KKG000000DV5   ← like Share-Class
Pair FIGI              Base+Quote combination                  ETH-BTC                 BBG00J7SVVH8   ← like Composite
Venue FIGI (Instrument)Pair traded on a specific exchange      ETH-BTC on Kraken (KRKN)KKG000006DD9   ← like Venue (tradable)
```

So `Asset FIGI ≈ Share-Class`, `Pair FIGI ≈ Composite`, `Venue FIGI ≈ Listing`. The master treats a crypto
pair-on-a-venue exactly like an equity-on-a-venue: prices key on the venue FIGI (`KKG000006DD9`), rolling
up to the pair and the asset. The only schema accommodation is that crypto's "entity" is a *currency asset*,
not a share class — a nullable polymorphic root.

---

## 6. Governance: who runs FIGI and what "official standard" actually means

The anchor decision rests partly on FIGI being a *governed open standard*, not a single vendor's private
scheme. The governance chain — verified from the rules + primary news — is:

### 6.1 OMG (the international standard body)

> "In September 2015 the Financial Instrument Global Identifier (FIGI) standard … was designated as an
> official international standard of the Object Management Group (OMG). … **The OMG owns the trademark of
> the term 'FIGI'.** Bloomberg acts as the Registration Authority for the OMG FIGI Standard and as a
> Certified Provider of FIGIs."
> — *Allocation Rules*, §1.2.1; spec at http://www.omg.org/spec/FIGI/

The OMG is "an international, open-membership, not-for-profit technology standards consortium" founded in
1989 (§1.1). The standard predates Bloomberg's stewardship of the *name*: before OMG adoption the
identifier was the "Bloomberg Global Identifier (BBGID)"; the term was changed to FIGI in June 2015 and the
**allocation rules did not change** as a result of OMG taking ownership (§1.2.1).

### 6.2 Registration Authority vs Certified Provider (the governance roles)

A precise distinction the rules draw (§1.3), important for understanding *who you actually fetch from*:

- **Registration Authority (RA):** "a firm or organization nominated by a standards organization … to be
  responsible for the administration, promotion, and integrity of the named standard … serves as both an
  issuer of Identifiers and as a comprehensive system of record." **Bloomberg is the RA.**
- **Certified Provider (CP):** "the entity that actually issues FIGI and the associated metadata, under the
  auspice of the Registration Authority. Where there are multiple CPs, the CPs must coordinate through the
  RA." **Bloomberg and Kaiko are the two CPs** (Kaiko for crypto, approved 2021, `KK` prefix).

So Bloomberg is *both* the RA (system of record) and a CP; Kaiko is a CP for crypto only. When your master
resolves a FIGI through the OpenFIGI API, you are querying Bloomberg-the-RA's system of record.

### 6.3 ANSI/X9 — the US *standard* (X9.145-2021)

> "In September 2021, the American National Standard titled **ASC X9.145-2021**, 'Financial Instrument
> Global Identifier (FIGI),' was adopted as a United States Standard … The ASC X9.145 FIGI standard is the
> first X9 data standard incorporating the MIT Open Source License."
> — *Allocation Rules*, §1.2.2; standard at https://x9.org/

This is the "official US data standard" headline (e.g. *WatersTechnology*, "After lengthy fight,
Bloomberg's FIGI recognized as official US data standard," 2021,
https://www.openfigi.com/insights/all/2021/9/15/after-lengthy-fight-bloombergs-figi-recognized-as-official-us-data-standard).
ANSI/X9 accreditation = FIGI is a recognized US data standard *for voluntary use*. Brazil's ABNT adopted it
earlier (May 2020 ballot; §1.2.3).

### 6.4 The FDTA caveat — **do not overstate the US mandate**

This is where a lot of secondary writing gets it wrong, so be precise:

- **2024 (proposed):** Under the Financial Data Transparency Act of 2022, US financial regulators issued a
  *proposed* joint rule (Aug 2024) that **recommended FIGI** as the common financial-instrument identifier
  (https://www.federalregister.gov/documents/2024/08/22/2024-18415/).
- **June 2026 (final):** The *final* joint rule **declined to adopt FIGI** (or any single instrument
  identifier), citing CUSIP-interoperability concerns from issuers and market participants, and deferred
  the choice to a later phase:

  > "No common financial instrument identifier was established. The proposed joint rule had proposed the
  > Financial Instrument Global Identifier (FIGI); after considering divided public comments, the agencies
  > declined to establish FIGI or any alternative identifier such as CUSIP, ISIN, or the Digital Token
  > Identifier."
  > — Data Foundation FDTA Final-Rule fact sheet,
  > https://datafoundation.org/news/financial-data-transparency-hub/863/

  The June 2026 final rule (effective Oct 1, 2026) established seven common identifiers — **LEI (ISO 17442)
  for entities, UPI (ISO 4914), CFI (ISO 10962), ISO 8601 dates, USPS state abbreviations, GENC countries,
  ISO 4217 currencies** — but **explicitly not a financial-instrument identifier**, leaving FIGI-vs-CUSIP
  to a future Phase-2 rulemaking. (SEC press release 2026-53,
  https://www.sec.gov/newsroom/press-releases/2026-53; final rule
  https://www.sec.gov/files/rules/final/2026/33-11420.pdf.)

> **State the governance accurately in any artifact:** FIGI **is** a formal OMG international standard and a
> recognized US ANSI/X9 standard (X9.145-2021) and a Brazilian ABNT standard. FIGI **was proposed** for the
> US FDTA instrument-identifier mandate (2024) **but was not adopted** in the June 2026 final rule. Writing
> "FIGI is the FDTA-mandated US securities identifier" is **false** and will fail a red-team check. The
> honest framing: *recognized open standard, regulator-favored in proposal, not (yet) federally mandated.*
> The anchor decision does **not** depend on a federal mandate — it rests on the four properties in §1, all
> of which hold regardless of the FDTA outcome.

---

## 7. The metadata caveat — the line teams get wrong

**This section is the most operationally important in the doc.** The FIGI *value* being public domain does
**not** make the *descriptive payload* OpenFIGI returns public domain. They are governed by two different
clauses of the same Terms of Service.

### 7.1 The two things OpenFIGI returns

When you map an identifier through `/v3/mapping`, a successful job returns an array of data objects with
these fields (verbatim field list from the API docs, https://www.openfigi.com/api/documentation):

```
figi, securityType, marketSector, ticker, name, exchCode,
shareClassFIGI, compositeFIGI, securityType2, securityDescription
```

Bloomberg's ToS splits these into two categories with **different legal treatment**:

1. **FIGI Identifiers** — `figi`, `compositeFIGI`, `shareClassFIGI` (the 12-char strings). **Dedicated to
   the public domain.** Store, redistribute, display, build on — no license, no attribution required.
2. **Related Security Descriptions** — `name`, `ticker`, `securityType`, `securityType2`, `marketSector`,
   `exchCode`, `securityDescription` (the *descriptive* fields). **Provided "AS IS" and treated separately
   — NOT dedicated to the public domain.**

The ToS language:

> "FIGI Identifiers and Related Security Descriptions are provided **'AS IS,'** with no representations or
> warranties of any kind. … TO THE MAXIMUM EXTENT PERMITTED BY LAW, FIGI IDENTIFIERS AND RELATED SECURITY
> DESCRIPTIONS ARE PROVIDED 'AS IS' … Bloomberg … DISCLAIM ALL LIABILITY … ARISING OUT OF OR RELATED TO
> FIGI IDENTIFIERS OR RELATED SECURITY DESCRIPTIONS."
> — OpenFIGI Terms of Service, https://www.openfigi.com/docs/terms-of-service

And the *narrow* definition of what is dedicated to the public domain:

> "[The ToS] define 'FIGI Identifier' narrowly as 'a unique string of alphanumeric characters that
> designate a specific security.' 'Related Security Descriptions' refers separately to accompanying
> metadata. **Only the FIGI identifier is dedicated to [the] public domain; descriptive data receives no
> such dedication.**"
> — reading of the OpenFIGI ToS (definitions section), https://www.openfigi.com/docs/terms-of-service

### 7.2 What this means for the master, concretely

| Field | Category | `commercialOk` default | Master treatment |
|---|---|---|---|
| `figi`, `compositeFIGI`, `shareClassFIGI` | FIGI Identifier (PD) | **🟢 true** (public domain) | Store as the anchor + FKs. Redistribute/display freely. |
| `name`, `securityDescription` | Related Security Description (AS-IS) | **🔴 false** unless your data agreement covers display | Store for *internal matching/enrichment*; gate display behind a license verdict. Prefer a name from a *known-PD/known-licensed* source for the displayed field. |
| `ticker`, `exchCode`, `securityType`, `securityType2`, `marketSector` | Related Security Description (AS-IS) | **🔴 false** by default | Same — internal use is fine; display is license-gated. A ticker from the exchange's own PD listing file is a cleaner display source. |

> **The exact trap:** a junior implementation maps an ISIN through OpenFIGI, gets back
> `{figi, name, ticker, securityType, …}`, stores the whole object with `commercialOk: true` "because FIGI
> is public domain," and ships the `name`/`ticker` to the UI. **That mis-licenses the descriptive fields.**
> The public-domain dedication is *scoped to the identifier string*; the descriptions ride on the separate
> AS-IS clause. The correct posture: **identifier fields → `commercialOk:true`; descriptive fields →
> `commercialOk:false` until the specific fetch path is independently cleared** (e.g. you sourced the name
> from an exchange's PD listing file, or you hold a Bloomberg Data License that covers display).

This is a textbook case of the general licensing principle ("the license attaches to the *fetch path*, not
the *concept*"): the *same* company name is PD if you pull it from an SEC EDGAR filing and RED-by-default if
you pull it from the OpenFIGI descriptive payload. The FIGI value is the rare field where the fetch path
(OpenFIGI) *is* explicitly cleared; its descriptive neighbors in the *same response* are not. See the
data-provenance/licensing reference for the full `commercialOk` workflow; this doc's job is to make sure you
**never conflate the two halves of one OpenFIGI response.**

### 7.3 Practical sourcing strategy

- **Anchor + linkage (FIGI, compositeFIGI, shareClassFIGI):** OpenFIGI, public domain, store and display
  freely. This is the spine.
- **Displayed descriptive fields (name, ticker, sector):** prefer an independently-cleared source — the
  exchange's own public listing directory, an SEC EDGAR filing (PD under 17 USC §105 for the gov-produced
  parts), or a vendor feed whose license *explicitly* grants display. Use the OpenFIGI descriptions for
  *internal reconciliation* (fuzzy-matching a feed's free-text name to your canonical instrument) where
  display is not implicated.
- **Record provenance per field, not per row.** Because a single OpenFIGI response straddles PD and AS-IS,
  the provenance/`commercialOk` flag must attach at field (or field-group) granularity, not at the row
  level. A row-level flag forces you to either over-restrict the PD identifier or over-permit the AS-IS
  descriptions — both wrong.

---

## 8. Worked example: one company → share-class → composites → venue FIGIs

Putting the whole hierarchy together end-to-end, using IBM (the example the allocation rules themselves use
across §1.1.2, §2.2.4, §4.1.1).

### 8.1 The tree

```
ENTITY (Share Class)
  share_class_figi = BBG001S5S399                "IBM common stock, globally"   [NOT tradable]
  │
  ├─ INSTRUMENT (Composite, country = US)
  │    composite_figi = BBG000BLNNH6             "IBM as traded in the US"      [aggregate]
  │    │
  │    ├─ LISTING (Venue = NYSE,  exchCode UN)   figi = BBG000BLNQ16   ccy USD   [TRADABLE — prices here]
  │    ├─ LISTING (Venue = NASDAQ, …)            figi = BBG…           ccy USD   [TRADABLE]
  │    └─ … other US regional venues …
  │
  ├─ INSTRUMENT (Composite, country = GB)
  │    composite_figi = BBG000BLNNH6? → London   "IBM as traded in the UK"
  │    └─ LISTING (Venue = LSE,  ticker IBM LN)  figi = …              ccy GBP/USD
  │
  ├─ INSTRUMENT (Composite, country = DE)
  │    composite_figi = BBG000JX3D13             "IBM as traded in Germany"
  │    └─ LISTING (Venue = XETRA, ticker IBM GR) figi = …              ccy EUR
  │
  ├─ INSTRUMENT (Composite, country = BE)
  │    composite_figi = BBG000NP2W23             "IBM as traded in Belgium"      (IBMA BB)
  ├─ INSTRUMENT (Composite, country = MX)  composite_figi = BBG000K23JG0         (IBM* MM)
  ├─ INSTRUMENT (Composite, country = RO)  composite_figi = BBG000HW8Q13         (IBM-RM RM)
  ├─ INSTRUMENT (Composite, country = CH)  composite_figi = BBG00YCLP757         (IBM SW)
  └─ INSTRUMENT (Composite, country = CL)  composite_figi = BBG000BWZBM9         (IBM CI)
```

(Composite FIGIs above are the ones the allocation-rules §2.2.4 table maps to share-class `BBG001S5S399`.
The US composite/NYSE-venue split — `BBG000BLNNH6` composite vs `BBG000BLNQ16` NYSE venue — is the §4.1.1
"True Composite" example. The exact venue FIGIs under each non-US composite are not all listed in the rules
and would be resolved live via OpenFIGI.)

### 8.2 How you build that tree from a single ISIN, via OpenFIGI

Greenfield design — the ingest path that materializes the tree (planned stack; illustrative async client):

```python
# resolve_hierarchy.py — turn one ISIN into the full FIGI hierarchy via the OpenFIGI v3 API.
# API: https://www.openfigi.com/api/documentation  (POST api.openfigi.com/v3/mapping)
import httpx

OPENFIGI_URL = "https://api.openfigi.com/v3/mapping"


async def resolve_isin(client: httpx.AsyncClient, isin: str, api_key: str | None) -> list[dict]:
    """Map one ISIN to its FIGI rows. Returns every listing OpenFIGI knows for the ISIN."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-OPENFIGI-APIKEY"] = api_key          # higher rate limit; see rate-limit table below
    # One job per request element; the API accepts a batch array (<=10 jobs unauth, <=100 with key).
    body = [{"idType": "ID_ISIN", "idValue": isin}]
    resp = await client.post(OPENFIGI_URL, json=body, headers=headers, timeout=20.0)
    resp.raise_for_status()                              # 429 -> back off on Retry-After (rate-limited)
    result = resp.json()[0]
    return result.get("data", [])                       # [] or {"warning": ...} when no match


def build_hierarchy(rows: list[dict]) -> dict:
    """Fold OpenFIGI venue rows into entity / instrument / listing keyed on the three FIGI levels."""
    entities, instruments, listings = {}, {}, {}
    for r in rows:
        scf, cf, vf = r.get("shareClassFIGI"), r.get("compositeFIGI"), r["figi"]
        if scf:
            entities.setdefault(scf, {"share_class_figi": scf})
        if cf:
            instruments.setdefault(cf, {"composite_figi": cf, "share_class_figi": scf})
        listings[vf] = {
            "figi": vf, "composite_figi": cf,
            # --- descriptive fields below are AS-IS / license-gated (see section 7) ---
            "venue_ticker": r.get("ticker"), "exch_code": r.get("exchCode"),
            "security_type": r.get("securityType"), "name": r.get("name"),
        }
    return {"entities": entities, "instruments": instruments, "listings": listings}
```

**The key fold:** OpenFIGI returns a *flat* array of venue rows, each carrying its own `figi`,
`compositeFIGI`, and `shareClassFIGI`. You reconstruct the tree by *grouping on those keys* — `shareClassFIGI`
collapses the whole array to one entity, `compositeFIGI` groups venues into per-country instruments, and
each row's `figi` is a listing. **You never string-parse exchange codes to infer the grouping** — the
grouping keys are explicit in the response (the §4.1.2 MTF and §4.1.1 non-true-composite cases prove why
inference would be wrong).

> **Provenance split at the fold (carry §7 into the code):** in `build_hierarchy`, `figi` / `composite_figi`
> / `share_class_figi` are PD (`commercialOk:true`); `venue_ticker` / `exch_code` / `security_type` / `name`
> are AS-IS Related Security Descriptions (`commercialOk:false` by default). The comment in the code marks
> the boundary; a real implementation stamps the provenance per field-group, not per row.

### 8.3 OpenFIGI API reference (the resolve surface)

For completeness, the resolve surface the master depends on (https://www.openfigi.com/api/documentation):

- **Base:** `api.openfigi.com`. **Endpoints:** `POST /v3/mapping` (id → FIGI), `POST /v3/search`
  (keyword → FIGIs), `POST /v3/filter` (alphabetical FIGI listing + count).
- **Job request fields:** `idType` (required), `idValue` (required), plus optional `exchCode`, `micCode`,
  `currency`, `marketSecDes`, `securityType`, `securityType2`, `includeUnlistedEquities`, and
  option/futures filters (`optionType`, `strike`, `expiration`, `maturity`, …).
- **`idType` values** include: `ID_ISIN`, `ID_CUSIP`, `ID_SEDOL`, `ID_COMMON`, `ID_BB_GLOBAL` (= a FIGI),
  `COMPOSITE_ID_BB_GLOBAL` (= a composite FIGI), `ID_BB_UNIQUE`, `TICKER`, `BASE_TICKER`.
- **Response data fields:** `figi, securityType, marketSector, ticker, name, exchCode, shareClassFIGI,
  compositeFIGI, securityType2, securityDescription`.
- **Rate limits** (verbatim, https://www.openfigi.com/api/documentation):
  - **Mapping, no API key:** *25 requests / minute*, *10 jobs* per request.
  - **Mapping, with API key:** *25 requests / 6 seconds*, *100 jobs* per request.
  - **Search/Filter, no key:** *5 / minute*; **with key:** *20 / minute*.
  - `429` is returned when the window limit is hit — back off on the rate-limit window.
- **Auth header:** `X-OPENFIGI-APIKEY: <key>` (free signup raises your limit).

> **Scale note for the master's bulk backfill.** At *100 jobs × (25 requests / 6 s)* with a key you resolve
> ~25,000 instruments/minute. For a multi-million-instrument universe backfill, this is a **batch job on the
> off-request worker** (not a serverless/request-path call): chunk identifiers into 100-job requests, honor
> `Retry-After` on `429`, persist resolved rows transactionally, and checkpoint so a restart resumes. The
> resolve is *idempotent* (a FIGI never changes), so re-running a chunk is safe — which is exactly the
> property the no-reuse/perpetuity guarantee (§2.3) buys you for the ingest pipeline, not just the schema.

---

## 9. Summary — the rules this doc establishes

1. **Anchor every instrument on its FIGI** (non-negotiable #1). FIGI is the only widely-used identifier
   that is simultaneously public-domain-storable, never-reused/perpetual/corporate-action-stable,
   free-to-resolve, and cross-asset. CUSIP (licensed, fee-bearing, recyclable) and ISIN (wraps and inherits
   the NSIN's license) each fail at least one property — and the properties they fail are the ones that
   *corrupt a master silently*. (§1)
2. **Validate FIGI shape + check digit at ingest.** Require the `[consonants]{2}G[consonants|digits]{8}[digit]`
   shape (so Kaiko `KKG…` crypto FIGIs pass) and verify the Modulus-10 Double-Add-Double check digit; reject
   typos before they orphan a row. (§2.5)
3. **Model the three FIGI levels as three tables:** Share-Class FIGI → `entity` (global, not tradable),
   Composite FIGI → `instrument` (per country, aggregate), Venue FIGI → `listing` (the tradable line —
   **prices/time-series key here**). Group OpenFIGI's flat rows by the explicit `shareClassFIGI`/
   `compositeFIGI` keys; never infer grouping from exchange-code strings. (§3, §4, §8)
4. **One uniform key shape spans all asset classes** — equities/funds/warrants, options, futures, FX,
   indices, corp/govt bonds, loans, mortgages, municipals, money markets, crypto. Tolerate the documented
   "no FIGI" cases (CDS, generic spreads) with a non-FIGI fallback. Crypto is Kaiko-issued, `KK`-prefixed,
   asset/pair/venue three-level. (§5)
5. **FIGI is a governed open standard** (OMG; ANSI/X9.145-2021; Brazil ABNT). Bloomberg is RA + CP; Kaiko is
   a crypto CP. **Do NOT claim FIGI is the FDTA-mandated US securities identifier** — it was *proposed*
   (2024) and *declined* in the June 2026 final rule. The anchor decision does not depend on a mandate.
   (§6)
6. **The FIGI value is public domain; the Related Security Descriptions are AS-IS and licensed separately.**
   `figi`/`compositeFIGI`/`shareClassFIGI` → `commercialOk:true`; `name`/`ticker`/`securityType`/`exchCode`/
   etc. → `commercialOk:false` by default. Stamp provenance **per field-group**, not per row, because a
   single OpenFIGI response straddles both. Source displayed descriptive fields from independently-cleared
   paths. (§7)

---

## Sources

Primary (read at the source level for this doc):
- **OpenFIGI — Allocation Rules for the FIGI Standard, v29.9 (July 2022)** — structure, hierarchy, no-reuse/
  perpetuity, per-asset-class allocation, IBM share-class example, True/Non-True Composite, crypto/Kaiko,
  RA/CP roles, OMG/X9/ABNT governance. https://www.openfigi.com/assets/local/figi-allocation-rules.pdf
- **OpenFIGI — FIGI Check-Digit Calculation** — char→value map (A=10…Z=35), Double-Add-Double algorithm,
  worked example `BBG000BLNQ1`→`BBG000BLNQ16`. https://www.openfigi.com/assets/content/figi-check-digit-2173341b2d.pdf
- **OpenFIGI — Terms of Service** — FIGI Identifiers dedicated to public domain; Related Security
  Descriptions provided AS-IS and treated separately. https://www.openfigi.com/docs/terms-of-service
- **OpenFIGI — API Documentation (v3)** — endpoints, idTypes, response fields, rate limits, auth header.
  https://www.openfigi.com/api/documentation
- **OMG FIGI spec** — http://www.omg.org/spec/FIGI/

Standards / governance:
- **Wikipedia — Financial Instrument Global Identifier** — 852B/≈376T value-space figures, history, MIT
  license, Kaiko. https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier
- **WatersTechnology / OpenFIGI — "FIGI recognized as official US data standard" (2021)** — ANSI/X9.145.
  https://www.openfigi.com/insights/all/2021/9/15/after-lengthy-fight-bloombergs-figi-recognized-as-official-us-data-standard
- **Federal Register — FDTA Joint Data Standards (proposed, Aug 22 2024)** — FIGI proposed.
  https://www.federalregister.gov/documents/2024/08/22/2024-18415/financial-data-transparency-act-joint-data-standards
- **SEC press release 2026-53 + final rule 33-11420 (June 2026)** — FIGI **not** adopted; seven identifiers
  established (LEI/UPI/CFI/dates/states/countries/currencies); effective Oct 1 2026.
  https://www.sec.gov/newsroom/press-releases/2026-53 · https://www.sec.gov/files/rules/final/2026/33-11420.pdf
- **Data Foundation — FDTA Final-Rule fact sheet** — "declined to establish FIGI or any alternative."
  https://datafoundation.org/news/financial-data-transparency-hub/863/

Contrast (CUSIP/ISIN licensing + mutability):
- **classaction.org / Kehoe — CUSIP antitrust (S&P/FactSet/CGS/ABA), ~$280/CUSIP, >$1B class).**
  https://www.classaction.org/news/antitrust-lawsuit-alleges-sandp-factset-conspired-to-eliminate-competition-in-financial-instrument-id-number-market
  · https://kehoelawfirm.com/cusip-numbers-cusip-licensing-fees/
- **Wikipedia — CUSIP** — 9-char structure, ISIN wraps CUSIP, CUSIP recycling for discount CP/agency
  notes/TBA pools. https://en.wikipedia.org/wiki/CUSIP

Heuristic (flagged in-text as `[heuristic — verify per instrument]`):
- Twelve Data symbology guidance on share-class-FIGI ≈ ISIN 1:1 — *article body could not be retrieved (URL
  now redirects to a trial-plan page)*; the 1:1 framing is carried as an industry heuristic corroborated by
  the structural fact that both ISIN and share-class FIGI sit at the issuer/class level above the venue.
