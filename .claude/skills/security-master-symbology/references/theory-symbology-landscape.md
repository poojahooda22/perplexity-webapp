# Theory — The Financial Symbology Landscape

> **Skill:** `security-master-symbology` · **Product line:** JPM-Markets re-engineering
> **data-analytics product line (NOT Lumina).** This doc is part of the Python/FastAPI/
> data-engineering line (DataQuery/Fusion re-engineering), separate from Lumina's
> Bun + Express + Prisma + Supabase + Upstash stack.
>
> **Doc type:** `theory-*` — generic, reusable landscape orientation. **Read this FIRST**,
> before any licensing decision (`theory-identifier-licensing-reality.md`), any schema decision
> (`patterns-crosswalk-schema-design.md`), or any cross-reference / mapping build
> (`patterns-openfigi-api-integration.md`). This is the map of the territory; it is not a build recipe.

---

## 0. The on-ramp (plain language)

A "security" — say, one share of Apple — does not have one name. It has a dozen. The ticker on a
US trading screen is `AAPL`. A European compliance system calls the same share
`US0378331005`. A US clearing house calls it `037833100`. A UK index system calls it `2046251`.
A Bloomberg-derived data feed calls it `BBG000B9XRY4`. A Refinitiv terminal calls it `AAPL.OQ`.
A regulator that wants to know *which company issued it* calls the company (not the share)
`HWUPKR0MPOU8FGXBT394`. **Every one of those strings points at "Apple stock", and yet no two are
equal, and most are not even talking about the same thing** — some name the *company*, some name
the *share class*, some name *one specific listing on one specific exchange*.

A data platform that ingests from many providers receives these names mixed together with no
warning about which is which. If you treat them as interchangeable labels you will silently merge
two different instruments, or split one instrument into two. The job of a **security master** is to
collapse all of these aliases onto one internal key per real-world thing, at the right *level*.
This doc teaches the three levels and the identifier that serves each, so that every later decision
— what to store as the join key, what is safe to redistribute, how to map provider A's symbol to
provider B's — starts from a correct mental model instead of "an ID is an ID".

The single most important idea: **identifiers live at different LEVELS of granularity.** An LEI
names a legal *entity*. An ISIN names an *instrument / share class* (roughly one per security,
globally). An exchange ticker + venue names *one listing on one venue*. Mixing levels is the
root cause of nearly every symbology bug. Get the levels right and the rest is bookkeeping.

---

## 1. The core problem — the same security has many names

### 1.1 Statement of the problem

A modern data-analytics platform ingests reference and market data from many upstream providers
(Bloomberg-derived, Refinitiv/LSEG, exchange direct feeds, regulators, vendors). Each provider
identifies "the same" security with a *different* identifier, drawn from a different identification
scheme, sometimes at a different level of granularity. There is **no single universal primary key**
that every provider agrees on. Concretely, one ordinary US equity (Apple common stock) is
simultaneously addressable as:

| Provider / context | Identifier it uses | Scheme | Level it actually names |
|---|---|---|---|
| US trading screen | `AAPL` | exchange ticker | a listing (which venue is implied, not stated) |
| Global compliance / settlement | `US0378331005` | ISIN | the instrument (share class, country-rooted) |
| US/Canada clearing | `037833100` | CUSIP | the instrument (North America) |
| UK index/fund systems | `2046251` | SEDOL | a *listing* (per-market) |
| Bloomberg-derived data feeds | `BBG000B9XRY4` | FIGI (composite) | the instrument within one country |
| Refinitiv/LSEG terminal | `AAPL.OQ` | RIC | a listing (NASDAQ) |
| Entity/ownership regulators | `HWUPKR0MPOU8FGXBT394` | LEI | the **company**, not the share |
| Market-venue tagging | `XNAS` | MIC (ISO 10383) | the venue itself |

> "one stock can carry eight or more different codes at the same time" because each operates within
> distinct regional or platform ecosystems.
> — vapa.ch global stock identifier guide, Apple worked example
> (https://vapa.ch/.../global-stock-identifier-guide/)

> "A single equity might be represented by a ticker symbol in a trading system, a CUSIP identifier
> in settlement workflows, an ISIN in global reporting, and a FIGI identifier within market data
> platforms."
> — Intrinio, *Modern Security Master Architecture*
> (https://intrinio.com/blog/modern-security-master-architecture-unifying-ticker-cusip-isin-and-figi-data-at-scale)

### 1.2 Why this is hard, not just tedious

Three properties make this a genuine engineering problem rather than a lookup table:

1. **Cross-level collision.** The schemes do not all name the same kind of thing. `AAPL` (a listing)
   and `US0378331005` (an instrument) and `HWUPKR0MPOU8FGXBT394` (a company) are not three names
   for one node — they are names for *three different nodes* in a hierarchy (company → instrument →
   listing). Joining them as if they were peers corrupts the graph.

2. **Mutability.** Some identifiers are *mutable* (a ticker can be re-assigned; a company can change
   its ticker on rebrand) and some are *perpetual* (a FIGI never changes and is never reused). A
   join key built on a mutable identifier silently breaks when the identifier moves.
   > "when a company changes its ticker symbol after a rebranding or corporate restructuring,
   > historical price data may still be associated with the old symbol."
   > — Intrinio, *Modern Security Master Architecture* (link above)

3. **Reuse / ambiguity.** The same short string means different securities in different contexts.
   `AAPL` is Apple on NASDAQ but a ticker like `T` is AT&T on NYSE and could be reused after a
   delisting; a SEDOL is unique only within the SEDOL system; a CUSIP-6 issuer base is shared by all
   of one issuer's many issues. None of the *short* identifiers is globally unique by itself.

The security master exists to resolve all three: it maps every incoming alias to one canonical
internal node, at the correct level, with the level recorded so cross-level joins are impossible by
construction. The rest of this doc gives you the vocabulary to do that.

### 1.3 What a "security master" is (and is not)

> "A security master serves as the authoritative repository for financial instrument identifiers and
> metadata, maintaining a canonical record for each instrument and linking together all identifiers
> that reference the same asset across different systems and data providers."
> — Intrinio, *Modern Security Master Architecture* (link above)

It is **not** a single flat table keyed by ticker. It is a small hierarchy of nodes (entity →
instrument → listing) with an alias table that maps each external identifier to exactly one node at
exactly one level. The schema recipe lives in `patterns-crosswalk-schema-design.md`; this doc gives
you the conceptual model that schema implements.

---

## 2. The three identity LEVELS

Everything in symbology collapses into **three levels of granularity.** Internalize these and the
identifier zoo becomes orderly. They form a strict containment hierarchy: one entity issues one or
more instruments; one instrument is listed on one or more venues.

```
ENTITY (issuer / legal entity)            ← "who"      e.g. Apple Inc., the company
  └── INSTRUMENT (security / share class) ← "what"     e.g. Apple common stock (one share class)
        └── LISTING (venue / line)        ← "where"    e.g. AAPL on NASDAQ; AAPL on Frankfurt; ...
```

| Level | Question it answers | Cardinality | Canonical identifier(s) | Mutability of that ID |
|---|---|---|---|---|
| **ENTITY** | *Who is the legal issuer?* "Who is who / who owns whom" | one per legal entity | **LEI** (ISO 17442) | perpetual once issued |
| **INSTRUMENT** | *What security is this?* (the share class / the bond) | ~one per security globally | **ISIN** (≈1:1), **FIGI share-class**, CUSIP/CINS (NA), **DTI** (crypto) | perpetual |
| **LISTING** | *Where does it trade — which line on which venue?* | one per (instrument × venue) | **exchange ticker + MIC**, **FIGI exchange-level**, **RIC**, **SEDOL** (per-listing) | ticker/RIC mutable; FIGI/SEDOL perpetual |

### 2.1 ENTITY level — the issuer

The thing that *issues* securities: a company, a fund manager, a sovereign, a special-purpose
vehicle. The canonical identifier is the **LEI**.

> "An LEI identifies a **legal entity**, not financial instruments." … "Every LEI is unique and can
> represent only one entity" … the system answers "who is who" (Level 1 data) and "who owns whom"
> (Level 2 data regarding ownership structure).
> — GLEIF, *ISO 17442 — The LEI code structure*
> (https://www.gleif.org/en/about-lei/iso-17442-the-lei-code-structure)

Crucially, the LEI does **not** identify a tradable line. You cannot price an LEI. In the Apple
example, the LEI `HWUPKR0MPOU8FGXBT394` names "Apple Inc., the California corporation" — not the
share, and certainly not the NASDAQ listing.

> LEI "identifies the company (issuer), not the stock itself."
> — vapa.ch global stock identifier guide (link above)

One entity issues many instruments: Apple Inc. issues common stock *and* dozens of bond series; all
share one LEI but each bond gets its own ISIN/FIGI at the instrument level.

### 2.2 INSTRUMENT level — the security / share class

The fungible security itself: one class of common stock, one specific bond (one ISIN per coupon/
maturity), one ETF share class. There is approximately **one instrument node per security
worldwide**, independent of how many venues it trades on. The canonical identifiers are:

- **ISIN** — roughly 1:1 with an instrument, country-rooted (the country of the *issue*, not of
  trading). This is the closest thing to a global instrument key, with caveats (§3.3).
- **FIGI share-class level** — Bloomberg's explicitly cross-country instrument grouping (§4).
- **CUSIP / CINS** — the North-American instrument identifier; CUSIP is the NSIN embedded inside a
  `US`/`CA` ISIN.
- **DTI** — the instrument-level identifier for a digital token / crypto asset.

In the Apple example, the instrument node is "Apple common stock", carrying ISIN `US0378331005`,
CUSIP `037833100`, and FIGI share-class `BBG001S5N8V8`.

### 2.3 LISTING level — the venue line

A specific *line* of an instrument trading on a specific venue, in a specific currency. One
instrument has many listings (NASDAQ, Frankfurt, Mexico, …). The canonical identifiers are:

- **exchange ticker + MIC** — e.g. `AAPL` on `XNAS`. The ticker alone is *not* a key (§5); pairing
  it with the ISO-10383 MIC makes it specific to one venue, but it is still mutable.
- **FIGI exchange/venue level** — a distinct FIGI per trading venue (§4).
- **RIC** — Refinitiv's per-listing code, e.g. `AAPL.OQ` (the `.OQ` suffix = NASDAQ on Refinitiv).
- **SEDOL** — LSEG allocates a SEDOL *per listing / per market*, so one instrument can carry several
  SEDOLs (§3.5).

> "The same company can carry multiple SEDOLs if it trades on more than one exchange. HSBC has
> separate codes for its London, New York, and Hong Kong listings, even though all three represent
> shares in the same global business."
> — LSEG SEDOL explainer, via marketgenius.app SEDOL article
> (https://marketgenius.app/articles/explainers/sedol-code-uk-stock-identifier-behind-every-trade)

> "Equity instruments are allocated a FIGI at the Composite and Trading Venue level, with the
> exception of unlisted funds and private companies."
> — OpenFIGI allocation rules, surfaced in FIGI level documentation
> (https://www.openfigi.com/assets/local/figi-allocation-rules.pdf)

### 2.4 The level-mismatch trap (the thing this whole doc exists to prevent)

The single most damaging mistake in symbology is **joining across levels as if they were one
level.** Examples of the bug:

- Treating `AAPL` (listing) ⇄ `US0378331005` (instrument) ⇄ `HWUPKR0MPOU8FGXBT394` (entity) as
  three synonyms in one alias column → your "Apple" node now claims to be both a company and a
  listing; a query for "all instruments issued by this entity" returns the listing as if it were a
  sibling of the bonds.
- Using ISIN as a *listing* key → ISIN is an *instrument* key. Apple's NASDAQ line and its Frankfurt
  line share the **same** ISIN. If you key prices by ISIN you cannot distinguish the two venues'
  prices, currencies, or sessions.
- Using a ticker as an *instrument* key → tickers are reused and venue-scoped; two different
  instruments can carry the ticker `T` on two venues, and the same instrument carries different
  tickers on different venues.

The defense is structural: store the level on every alias, and only ever join identifiers that
agree on level. The FIGI hierarchy (§4) gives you an off-the-shelf, free, perpetual spine that
already encodes the level — which is why FIGI-centered architectures win.

---

## 3. Per-identifier cards

Each card states **structure** (char count, format, check digit), **issuer / registration
authority**, **scope** (asset classes), **level** it lives at, and **stability** (mutable vs
perpetual). Char counts and structures are verified against the issuer's own standard, not a blog.

> Licensing (commercialOk-style redistribution rights) is summarized per-card here for orientation
> but is treated in depth in `theory-identifier-licensing-reality.md`. The headline: **FIGI and LEI are
> free/open; CUSIP, SEDOL, and RIC are proprietary and licensed; ISIN is "free as a number but the
> NSIN inside it may be CUSIP".**

---

### 3.1 FIGI — Financial Instrument Global Identifier

| Field | Value |
|---|---|
| **Length / format** | 12 characters, alphanumeric, no embedded intelligence |
| **Char 1–2 (prefix)** | Any combination of **upper-case consonants**; prohibited combos `BS, BM, GG, GB, GH, KY, VG` (avoid clash with ISIN country codes). In practice issued FIGIs use `BBG`. |
| **Char 3** | Always the letter **`G`** ("global") |
| **Char 4–11** | 8 characters: upper-case **consonants + digits 0–9**, **no vowels** (A, E, I, O, U excluded) |
| **Char 12** | Check digit, "Modulus 10 Double Add Double" (Luhn-family) |
| **Registration authority / issuer** | **Object Management Group (OMG)** owns the standard; **Bloomberg L.P.** is Registration Authority + Certified Provider (the minter) |
| **Scope** | *All* global asset classes — equities, bonds, futures, options, **loans, cryptocurrencies, FX pairs**; fills gaps where no other global ID exists |
| **Level** | Spans all three: **share-class** (instrument, cross-country), **composite** (instrument-in-country), **exchange/venue** (listing). See §4. |
| **Stability** | **Perpetual** — never changes, never reused, assigned to active *and* inactive instruments |
| **Licensing** | **Public domain, MIT, free** — no fees, no redistribution restriction. The strategic linchpin (§3.1 note). |

> "Prohibited combinations are: BS, BM, GG, GB, GH, KY, VG. These restrictions prevent duplication
> with ISIN country codes." … char 4–11 are "Any combination of upper case consonants and the
> numerals 0 – 9" excluding vowels.
> — Wikipedia, *Financial Instrument Global Identifier*, citing the OMG standard
> (https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier)

> "FIGIs and the associated metadata defined in the standard are released free into the public
> domain with no commercial terms or restrictions on usage." … "FIGI is offered to the public domain
> under the MIT Open Source license and has no restrictions on use or redistribution."
> — OpenFIGI Terms of Service (https://www.openfigi.com/docs/terms-of-service)

> "Bloomberg intends this dedication to be an overt act of relinquishment in perpetuity of any
> present and future rights under copyright law … FIGI Identifiers may be freely reproduced,
> distributed, transmitted, used, modified, built upon, or otherwise exploited by anyone for any
> purpose, commercial or non-commercial."
> — OpenFIGI Terms of Service (link above)

**Worked check-digit note.** FIGI uses the same Modulus-10-Double-Add-Double family as CUSIP; the
example FIGI in the standard is `BBG000BLNNV0` (the legacy IBM share-class). The 12th char `0` is the
computed check digit. Validation in code is shown in `patterns-openfigi-api-integration.md`.

> **Why FIGI is the linchpin of this product line.** Because it is the *only* identifier that is
> (a) perpetual, (b) covers every asset class, (c) explicitly encodes all three levels, and
> (d) carries **zero** licensing restriction, FIGI is the natural canonical spine of the security
> master. Every proprietary identifier (CUSIP, SEDOL, RIC) becomes an *alias* mapped onto a FIGI node
> via the free OpenFIGI mapping API. This single fact dictates the schema (`patterns-crosswalk-schema-design.md`) and the licensing posture (`theory-identifier-licensing-reality.md`).

---

### 3.2 LEI — Legal Entity Identifier

| Field | Value |
|---|---|
| **Length / format** | 20 characters, alphanumeric (ISO 17442) |
| **Char 1–4** | LOU prefix — identifies the **Local Operating Unit** that issued the LEI (ensures cross-issuer uniqueness) |
| **Char 5–18** | 14 chars, entity-specific, **no embedded intelligence** (no meaning encoded) |
| **Char 19–20** | Checksum, **MOD-97-10** per **ISO/IEC 7064** |
| **Registration authority / issuer** | **GLEIF** (Global Legal Entity Identifier Foundation, Swiss law) governs; accredited **LOUs** issue individual LEIs. GLEIF does not issue directly. |
| **Scope** | **Legal entities** participating in financial transactions — companies, funds, sovereigns, SPVs. **NOT instruments.** |
| **Level** | **ENTITY** only |
| **Stability** | **Perpetual** per entity (each entity has exactly one); requires annual *renewal* to stay "ISSUED"/current, but the code never changes |
| **Licensing** | **Free / open** — full LEI reference data (Level 1 "who is who" + Level 2 "who owns whom") is published by GLEIF as open data |

> "Characters 1-4: LOU prefix … Characters 5-18: Entity-specific part (14 characters with no embedded
> intelligence) … Characters 19-20: Checksum digits (calculated using MOD-97-10 algorithm per
> ISO/IEC 7064)."
> — GLEIF, *ISO 17442 — The LEI code structure* (link above)

**Apple's LEI** is `HWUPKR0MPOU8FGXBT394` — status ACTIVE/ISSUED, jurisdiction US-CA, entity legal
form "For-Profit Corporation General Stock", registration authority California Secretary of State.
(https://www.gleif.org/lei/HWUPKR0MPOU8FGXBT394)

**Use in the master.** The LEI is the join key for the *entity* node. It is how you answer
"give me every instrument issued by this company" and how you wire ownership trees ("who owns whom").
It is also the *only* identifier that is keyless-and-free *and* names the issuer — so entity-level
analytics (issuer exposure, parent/subsidiary rollups) ride entirely on LEI.

---

### 3.3 ISIN — International Securities Identification Number

| Field | Value |
|---|---|
| **Length / format** | 12 characters (ISO 6166) |
| **Char 1–2** | **ISO 3166-1 alpha-2 country code** of the *issue* (e.g. `US`, `GB`, `DE`, `JP`, `CH`) |
| **Char 3–11** | 9-char **NSIN** (National Securities Identifying Number) — the country's native code, left-padded with zeros. For `US`/`CA` issues the NSIN **is the CUSIP**. |
| **Char 12** | Check digit, **Luhn algorithm** (same checksum as credit cards) |
| **Registration authority / issuer** | Allocated by the **National Numbering Agency (NNA)** of the issue's country; coordinated globally by **ANNA** (Association of National Numbering Agencies). |
| **Scope** | Equities, bonds, warrants, ETFs, and most listed instruments globally |
| **Level** | **INSTRUMENT** (≈1:1 with a security). **NOT** a listing key — one ISIN spans all venues. |
| **Stability** | **Perpetual** per instrument |
| **Licensing** | The ISIN *number itself* is broadly available, but for `US`/`CA` the embedded CUSIP makes commercial redistribution subject to CGS/CUSIP licensing (the "ISIN is free but the NSIN inside it is CUSIP" trap — see `theory-identifier-licensing-reality.md`). |

> ISINs "consist of two alphabetic characters, which are the ISO 3166-1 alpha-2 code for the issuing
> country, nine alpha-numeric characters (the National Securities Identifying Number, or NSIN …
> padded as necessary with leading zeros), and one numerical check digit." … "always 12 characters."
> — Wikipedia, *International Securities Identification Number* (ISO 6166)
> (https://en.wikipedia.org/wiki/International_Securities_Identification_Number)

> "While ISIN is a global identifier, CUSIP is focused on the North American market."
> — TradingView, *Identifiers (ISIN, CUSIP, FIGI)*
> (https://www.tradingview.com/support/solutions/43000734977-identifiers-isin-cusip-figi/)

**The country-code trap.** The first two chars are the country *of the issue*, **not** the country
where it trades, **not** the issuer's HQ. Apple is a US company, so `US0378331005` begins `US` — but
a US company can issue a bond out of an Irish SPV and get an `IE…` ISIN. Never infer trading venue or
issuer nationality from the ISIN prefix.

**The not-a-listing trap.** Apple's ISIN `US0378331005` is identical on NASDAQ, Frankfurt, and
Mexico. ISIN answers "what instrument", never "which venue". To get to a venue you need MIC / FIGI-
exchange-level / RIC / SEDOL.

---

### 3.4 CUSIP / CINS

| Field | Value |
|---|---|
| **Length / format** | 9 characters (CUSIP-6 issuer + 2 issue + 1 check) |
| **Char 1–6** | **CUSIP-6** issuer base — uniquely identifies the *issuer* (shared across all that issuer's issues) |
| **Char 7–8** | Issue number — identifies the specific issue (e.g. a particular bond series, share class) |
| **Char 9** | Check digit, **Modulus 10 Double Add Double** (Luhn family; letters → ordinal, A=10) |
| **CINS variant** | Same 9-char shape, but **char 1 is a letter** encoding country/region — extends CUSIP to non-North-American markets (created 1989) |
| **Registration authority / issuer** | **CUSIP Global Services (CGS)**, operated by S&P Global / FactSet on behalf of the American Bankers Association (ABA) |
| **Scope** | US + Canada equities, corporate/government/municipal bonds, and other fixed income |
| **Level** | **INSTRUMENT** (North America). The CUSIP-6 also gives a cheap *issuer* grouping. |
| **Stability** | **Perpetual** per issue |
| **Licensing** | **Proprietary, licensed, fee-bearing.** Redistribution/display is restricted by CGS license terms; subject of antitrust litigation. Treat as **RED** for redistribution. See `theory-identifier-licensing-reality.md`. |

> "A CUSIP consists of three parts: a six-character issuer code (CUSIP-6), a two-character issue
> number, and a single check digit." … "The 9th digit is an automatically generated check digit
> using the 'Modulus 10 Double Add Double' technique based on the Luhn algorithm."
> — Wikipedia, *CUSIP* (https://en.wikipedia.org/wiki/CUSIP)

> "The CUSIP International Numbering System (CINS) is a 9-character alphanumeric identifier that
> employs the same 9 characters as CUSIP, but also contains a letter of the alphabet in the first
> position signifying the issuer's country or geographic region."
> — Wikipedia, *CUSIP* (link above)

> "License agreements prohibit financial institutions from using CUSIPs they received from data
> vendors in any way not specifically allowed by S&P and CGS." A class action accused CGS / S&P
> Global / FactSet / ABA of violating the Sherman Antitrust Act with monopolistic fees; in 2011 the
> EC charged S&P CapIQ with abusing its position as sole provider of US ISINs (CUSIPs).
> — CGS license-fee reporting, asppa-net.org / integrity-research.com
> (https://www.cusip.com/services/license-fees.html ;
>  https://www.asppa-net.org/news/2022/3/class-action-suit-challenges-big-cusip-licensing-fees/)

**Why the CUSIP licensing matters here.** Because the US/CA ISIN *embeds* the CUSIP, "we only store
ISINs, not CUSIPs" does **not** escape CUSIP licensing — extracting CUSIPs from ISINs at scale has
itself drawn legal challenge. This is a core licensing decision for the data-analytics product line,
handled in `theory-identifier-licensing-reality.md`.

---

### 3.5 SEDOL — Stock Exchange Daily Official List

| Field | Value |
|---|---|
| **Length / format** | 7 characters |
| **Char 1–6** | Alphanumeric body. **Post-2004**: alphanumeric, first char alpha, consonants `B–Z` (no vowels) + digits `0–9`, issued sequentially from `B000009`. **Pre-2004**: numeric only, with geographic leading digit. |
| **Char 7** | Check digit; weighted sum with weights **`[1, 3, 1, 7, 3, 9, 1]`** must be ≡ 0 mod 10. Letters valued as 9 + alphabet position (B=11 … Z=35). |
| **Registration authority / issuer** | **London Stock Exchange (LSEG)**, assigned on request by the security issuer; distributed via the SEDOL Masterfile |
| **Scope** | Global multi-asset securities, *uniquely identified at the market level* |
| **Level** | **LISTING** — allocated **per listing / per market**, so one instrument carries several SEDOLs |
| **Stability** | **Perpetual** per listing (stays with the security for life) |
| **Licensing** | **Proprietary, licensed.** SEDOL Masterfile data requires a user/distribution license; redistribution "in the original format" is prohibited. Treat as **RED** for redistribution. |

> "SEDOLs are seven characters in length, consisting of two parts: a six-place alphanumeric code and
> a trailing check digit." … Pre-2004 "composed only of numbers"; post-Jan-26-2004 "alpha-numeric …
> beginning with B000009." Permitted: digits + consonants (vowels never used). Check-digit weights
> `1, 3, 1, 7, 3, 9, 1`. "The numbers are assigned by the London Stock Exchange, on request by the
> security issuer."
> — Wikipedia, *SEDOL* (https://en.wikipedia.org/wiki/SEDOL)

> "SEDOL codes and other substantial extracts of the SEDOL Masterfile database … are subject to
> licence requirements." … "distributors are not permitted to redistribute the SEDOL Masterfile data
> in the original format in which it is received."
> — LSEG SEDOL Masterfile Pricing & Policy Guidelines
> (https://www.lseg.com/content/dam/lseg/en_us/documents/sedol/sedol-masterfile-pricing-and-policy-guidelines-2025.pdf)

**Level subtlety.** SEDOL is the cleanest counter-example to "instrument identifiers are 1:1". It is
*listing-level*: HSBC's London, New York, and Hong Kong lines each have a distinct SEDOL though they
share one underlying instrument. If your ingest treats SEDOL as an instrument key you will split one
instrument into three. Map SEDOL to the **listing** node, then up to the instrument via FIGI.

---

### 3.6 DTI — Digital Token Identifier

| Field | Value |
|---|---|
| **Length / format** | 9 alphanumeric characters (ISO 24165) |
| **Char 1–8** | Base number, **randomly generated**, excluding vowels and the letter `Y`; first char can never be `0` |
| **Char 9** | Check character |
| **Registration authority / issuer** | **DTI Foundation (DTIF)**, operated by **Etrading Software**, the ISO-approved Registration Authority for ISO 24165 |
| **Scope** | Fungible **digital assets / crypto tokens** that use DLT (issuance, storage, exchange, ownership, validation) |
| **Level** | **INSTRUMENT** (the token), with fork-record disambiguation across forks |
| **Stability** | **Perpetual** per token |
| **Licensing** | Open registry, free to look up (DTIF as public-good RA) — verify current terms in `theory-identifier-licensing-reality.md` |

> "The standard provides a unique code consisting of 9 alphanumeric characters … the first 8
> characters are the base number … (randomly generated) excluding vowels and the letter 'Y' (… the
> first character can never be 'zero'). … The last character of the DTI is the check character."
> — 21analytics.co glossary, citing ISO 24165
> (https://www.21analytics.co/glossary/digital-token-identifier-dti/)

> "Bitcoin has been issued a DTI of 4H95J0R2X, which, with the use of fork records, uniquely
> distinguishes it from any historical Bitcoin forks such as Bitcoin Cash, Bitcoin Gold, Bitcoin SV."
> … "The DTI Foundation is the Registration Authority for … ISO 24165 … developed by ISO/TC 68 SC 8."
> — DTI Foundation materials, ledgerinsights.com / iso.org
> (https://www.iso.org/standard/80601.html)

**Why it's in the map.** FIGI also covers crypto, but DTI is the ISO-blessed *crypto-native*
instrument identifier and is what regulators (EMIR, MiCA-adjacent reporting) reference. A multi-asset
master that includes digital assets needs the entity (issuer, if any) → DTI (instrument) → venue line
mapping just like equities, plus the fork-record nuance unique to tokens.

---

### 3.7 MIC — Market Identifier Code (ISO 10383)

| Field | Value |
|---|---|
| **Length / format** | 4 alphanumeric characters (ISO 10383) |
| **Structure** | Two registration levels: an **operating MIC** (the entity running the market) and **segment MICs** (sub-venues under it). A segment MIC can only exist if its operating MIC exists. Same 4-char format for both. |
| **Registration authority / issuer** | ISO 10383 Registration Authority — **SWIFT** (the RA maintains the official list; codes randomly allocated, RA approves) |
| **Scope** | Exchanges, trading platforms, regulated/unregulated markets, trade-reporting facilities — *as sources of prices* |
| **Level** | **LISTING / VENUE** — the MIC names the *venue*, not the instrument. It is the disambiguator that turns a bare ticker into a listing key. |
| **Stability** | Stable per venue (codes can be deactivated when a venue closes) |
| **Licensing** | **Free / open** — the MIC list is published by the RA in Excel/CSV/XML |

> "The MIC is a four alphanumeric character code … MICs are structured in two levels: an operating
> MIC that denotes the entity managing the market or facility, and a segment MIC that identifies
> specific sub-sections … A market segment MIC can only be registered if an operating/exchange MIC
> already exists."
> — ISO 10383 / iso20022.org, via search summary (https://www.iso20022.org/market-identifier-codes)

**Concrete examples** (operating → segment):
- `XNYS` = New York Stock Exchange (operating)
- `XNAS` = NASDAQ (operating); segments include `XNGS` (Global Select), `XNCM` (Capital Market),
  `XNMS` (Global Market)
- `XLON` = London Stock Exchange (operating)

> Operating MIC `XNAS` identifies NASDAQ; segments `XNCM`, `XNDQ`, `XNFI`, `XNGS` sit under it.
> — Wikipedia, *Market Identifier Code* (https://en.wikipedia.org/wiki/Market_Identifier_Code)

**Use in the master.** MIC is how you make "ticker + MIC" a real listing key. Store the **segment**
MIC where you have it (most precise) and roll up to the operating MIC for "all of NASDAQ". The `X`
first letter is the common convention for many primary operating MICs but is *not* a guaranteed rule
— do not parse meaning from MIC characters; treat it as an opaque 4-char code and look up the venue.

---

### 3.8 Ticker / exchange symbol

| Field | Value |
|---|---|
| **Length / format** | Short alphanumeric (1–5 chars typical for US equities; varies by venue), **no standardized structure** |
| **Structure** | Venue-defined; may carry class suffixes (`BRK.A` / `BRK.B`), exchange conventions differ |
| **Registration authority / issuer** | The **exchange / venue** assigns and controls it; no global authority |
| **Scope** | Equities, ETFs, listed derivatives — per venue |
| **Level** | **LISTING** — but *underspecified*: a bare ticker does not name a venue, so it is genuinely ambiguous until paired with a MIC/exchange code |
| **Stability** | **MUTABLE** — can be re-assigned after delisting; a company can change ticker on rebrand. The least stable identifier. |
| **Licensing** | The string itself is generally usable, but *curated ticker→instrument mappings* from a vendor may be licensed. |

A bare ticker is the most familiar and the **least reliable** identifier — see §5 for why it is not a
key. It earns its place only when (a) paired with a MIC to specify the venue and (b) treated as
mutable (kept as a time-stamped alias, never as the primary join key).

---

### 3.9 RIC — Refinitiv Instrument Code (Reuters Instrument Code)

| Field | Value |
|---|---|
| **Length / format** | Variable: `<root>.<exchange-suffix>` for equities |
| **Structure** | **Root** (1–4 chars A–Z, ~one per company), a `.` separator, then a 1–2 char **exchange suffix** (Refinitiv-proprietary, e.g. `.N` = NYSE, `.OQ` = NASDAQ). Indexes carry a leading `.` (e.g. `.DJI`). |
| **Registration authority / issuer** | **Refinitiv / LSEG** (proprietary) |
| **Scope** | Equities, indexes, money-market, FX, derivatives — broad, terminal-oriented |
| **Level** | **LISTING** — the suffix encodes the venue, so a RIC names a specific line (`IBM.N` = IBM on NYSE) |
| **Stability** | Generally stable per listing but can change; **proprietary**, so availability depends on subscription |
| **Licensing** | **Proprietary, licensed.** RIC mappings require an LSEG/Refinitiv subscription; unlicensed redistribution is prohibited. Treat as **RED**. |

> "For equities, RIC codes are composed of a RIC Root (one to four characters – A through Z),
> followed by a period sign, then a one- or two-character (A through Z) code denoting the exchange …
> IBM.N is a valid RIC, referring to IBM being traded on the New York Stock Exchange." Indexes have a
> leading period (`.DJI`).
> — Wikipedia, *Refinitiv Identification Code*
> (https://en.wikipedia.org/wiki/Refinitiv_Identification_Code)

> "The Refinitiv Identification Code (RIC) is a proprietary, ticker-like alphanumeric identifier …
> Access to RIC mappings typically requires LSEG subscriptions, as RIC remains a proprietary code,
> and unlicensed redistribution is prohibited."
> — Grokipedia, *Refinitiv Identification Code* (summarizing LSEG terms)

---

### 3.10 Card summary table

| ID | Chars | Level | Issuer / RA | Stability | Redistribution license |
|---|---|---|---|---|---|
| **FIGI** | 12 | all 3 (share-class / composite / venue) | OMG std · Bloomberg RA | perpetual | **🟢 public-domain / MIT — free** |
| **LEI** | 20 | entity | GLEIF · LOUs | perpetual (annual renewal) | **🟢 open data — free** |
| **ISIN** | 12 | instrument | NNAs · ANNA | perpetual | 🟡 number broadly usable; US/CA embeds CUSIP → see CUSIP |
| **CUSIP/CINS** | 9 | instrument (NA) | CGS (S&P/FactSet/ABA) | perpetual | **🔴 proprietary, licensed, fee** |
| **SEDOL** | 7 | listing | LSE / LSEG | perpetual | **🔴 Masterfile license required** |
| **DTI** | 9 | instrument (crypto) | DTI Foundation (Etrading SW) | perpetual | 🟢 open registry (verify terms) |
| **MIC** | 4 | venue | ISO 10383 RA (SWIFT) | stable | **🟢 list published — free** |
| **ticker** | ~1–5 | listing (underspecified) | the venue | **mutable** | depends on vendor mapping |
| **RIC** | var. | listing | Refinitiv / LSEG | stable, proprietary | **🔴 subscription required** |

> The 🟢/🟡/🔴 verdicts are orientation only and are *not* a substitute for the per-source licensing
> analysis in `theory-identifier-licensing-reality.md`. The license attaches to the **fetch path**, not the
> identifier *type* — the same principle this product line shares with Lumina's `commercialOk` gate.

---

## 4. The FIGI hierarchy — the unifying spine

FIGI is the only scheme that **explicitly encodes all three identity levels in one family**, which is
exactly why FIGI-centered security masters dominate. The hierarchy has three (for equities) levels
that map *directly* onto §2's entity/instrument/listing model — minus the entity level, which FIGI
delegates to the LEI.

```
                      FIGI HIERARCHY                         maps to §2 LEVEL
  ┌────────────────────────────────────────────────┐
  │  SHARE-CLASS FIGI   (global, cross-country)     │   →   INSTRUMENT (the security, worldwide)
  │      e.g. AAPL  BBG001S5N8V8                     │
  │        │                                        │
  │        ├── COMPOSITE FIGI  (one per country)    │   →   INSTRUMENT-within-a-country
  │        │     e.g. AAPL US  BBG000B9XRY4          │
  │        │       │                                │
  │        │       ├── VENUE FIGI  (per exchange)   │   →   LISTING (one line on one venue)
  │        │       │     e.g. AAPL on NASDAQ        │
  │        │       ├── VENUE FIGI  (per exchange)   │
  │        │       └── ...                          │
  │        └── COMPOSITE FIGI (another country) ...  │
  └────────────────────────────────────────────────┘
   ENTITY level is NOT a FIGI — it is the LEI (§3.2).
```

### 4.1 Share-class FIGI — the instrument spine, globally

> "A Share Class level Financial Instrument Global Identifier is assigned to an instrument that is
> traded in more than one country. This enables users to link multiple Composite FIGIs for the same
> instrument in order to obtain an aggregated view for that instrument across all countries globally."
> … "Multiple listings of the same security share class will be assigned the same global identifier
> at this level. This level … will link or connect all composite global identifiers that represent
> the same share class."
> — OpenFIGI allocation-rules level documentation
> (https://www.openfigi.com/assets/local/figi-allocation-rules.pdf)

The **share-class FIGI** is the closest FIGI analog to the ISIN: ≈1:1 with the *instrument* across
the whole world. It is the natural internal **instrument node key**, with the bonus that it is
perpetual and license-free (unlike the CUSIP that hides inside a US/CA ISIN).

### 4.2 Composite FIGI — the instrument within one country

> "The Composite Financial Instrument Global Identifier (FIGI) enables users to link multiple FIGIs
> at the trading venue-level within the same country or market in order to obtain an aggregated view
> for that instrument within that country or market."
> — OpenFIGI level documentation (link above)

The **composite FIGI** groups all of a country's venue-level FIGIs for one instrument. For a US
equity that lists on 14 US venues, there is **one** composite FIGI and **14** venue-level FIGIs under
it. The composite is the right key for "the US line of Apple" without caring which of the 14 venues.

### 4.3 Venue / exchange-level FIGI — the listing

> "Equity instruments are allocated a FIGI at the Composite and Trading Venue level … For instance,
> Apple common stock has unique FIGIs for each of 14 U.S. exchanges plus a composite FIGI."
> — Wikipedia, *Financial Instrument Global Identifier* / OpenFIGI allocation rules

The **venue-level FIGI** is the listing node — one per (instrument × venue). It is the FIGI analog of
"ticker + MIC", "RIC", and "per-listing SEDOL", but free and perpetual.

### 4.4 How the OpenFIGI API exposes the hierarchy

The free OpenFIGI `POST /v3/mapping` endpoint returns, per record, the fields that let you place an
instrument into the hierarchy programmatically:

> Response fields: `figi`, `name`, `ticker`, `exchCode`, `compositeFIGI`, `securityType`,
> `marketSector`, `shareClassFIGI`, `securityType2`, `securityDescription`.
> Mappable `idType` inputs include `ID_ISIN`, `ID_CUSIP`, `ID_CINS`, `ID_SEDOL`, `ID_BB_GLOBAL`
> (a FIGI), `COMPOSITE_ID_BB_GLOBAL`, `ID_BB_GLOBAL_SHARE_CLASS_LEVEL`, `TICKER`,
> `ID_EXCH_SYMBOL`, …
> — OpenFIGI API documentation (https://www.openfigi.com/api/documentation)

So a single mapping response row carries: the **venue FIGI** (`figi`), its **composite** parent
(`compositeFIGI`), and its **share-class** grandparent (`shareClassFIGI`) — i.e. the *entire spine*
for that listing in one object. That is the mechanism the `patterns-openfigi-api-integration.md` recipe uses
to resolve any incoming alias (ISIN, CUSIP, SEDOL, ticker) onto all three levels at once, for free.

### 4.5 Why this maps so cleanly onto the master schema

Because the FIGI family already separates instrument (share-class), instrument-in-country
(composite), and listing (venue), you can adopt it wholesale as the master's spine:

- **Instrument node** keyed by **share-class FIGI** (fallback: ISIN when no share-class FIGI exists,
  e.g. single-country instruments).
- **Listing node** keyed by **venue FIGI** (carries ticker + exchCode/MIC + RIC + SEDOL as aliases).
- **Entity node** keyed by **LEI** (FIGI does not cover entities; the LEI fills the top).

Every proprietary identifier becomes an *alias edge* pointing at the right node. This is the schema
in `patterns-crosswalk-schema-design.md`.

---

## 5. Why ticker + exchange is NOT a key

It is tempting to use `(ticker, exchange)` as the primary key — it is human-readable and present in
every feed. It is wrong as a *stable* key for four reasons:

1. **Tickers are mutable / re-assigned.** A company changes its ticker on rebrand; after a delisting
   the exchange can re-issue the freed ticker to a different company. Your "primary key" silently now
   points at a different security.
   > "when a company changes its ticker symbol after a rebranding or corporate restructuring,
   > historical price data may still be associated with the old symbol."
   > — Intrinio, *Modern Security Master Architecture* (link above)

2. **A bare ticker is venue-underspecified.** `AAPL` does not say which venue. Two venues can host
   different instruments under colliding short tickers. You *must* add the MIC to specify a venue —
   and even then it is the *listing* level, not the instrument.

3. **It is the wrong level for instrument analytics.** Joining prices by `(ticker, exchange)` keys at
   the *listing* level; "all of Apple's US activity" or "the instrument across all venues" needs the
   composite/share-class level. A listing key cannot answer instrument-level questions without a
   rollup table — which is exactly the master you are trying to avoid building.

4. **No check digit, no authority, no perpetuity.** Unlike FIGI/ISIN/CUSIP/SEDOL, a ticker has no
   check digit (no self-validation), no registration authority guaranteeing global uniqueness, and no
   perpetuity guarantee. It fails every property you want in a key.

**Correct use:** keep `(ticker, exchCode/MIC)` as a **time-stamped alias** on the listing node, never
as the primary join key. Resolve it to a venue FIGI on ingest, key everything off the FIGI spine, and
let the ticker be a display label and a *lookup* path — not the identity.

> Practical rule for this product line: **the primary key is a perpetual, free, level-correct
> identifier (FIGI at the right level; LEI for entities). Everything mutable or proprietary is an
> alias.** This single rule prevents the entire class of "the data moved when the ticker changed" and
> "we merged two instruments because they shared a ticker" incidents.

---

## 6. Worked example — Apple across every identifier, at every level

This is the canonical orientation example. Every value below is sourced; the point is to *see* the
three levels and which identifier sits where.

### 6.1 ENTITY level — Apple Inc., the company

| Identifier | Value | Source |
|---|---|---|
| **LEI** | `HWUPKR0MPOU8FGXBT394` | GLEIF (https://www.gleif.org/lei/HWUPKR0MPOU8FGXBT394) |
| Legal name | Apple Inc. (prev. "Apple Computer, Inc.") | GLEIF record |
| Jurisdiction / form | US-CA · For-Profit Corporation General Stock | GLEIF record |

The LEI names the *issuer*. It is the parent of *every* Apple security (the common stock **and** all
the bond series). It does **not** price and is **not** a listing.

### 6.2 INSTRUMENT level — Apple common stock (one share class)

| Identifier | Value | Scheme / scope | Source |
|---|---|---|---|
| **ISIN** | `US0378331005` | global instrument (US-rooted) | vapa.ch guide; cbonds |
| **CUSIP** | `037833100` | North-America instrument (this is the `0378331005`-without-`US`-and-check NSIN inside the ISIN) | vapa.ch guide |
| **FIGI (share-class)** | `BBG001S5N8V8` | global instrument spine | OpenFIGI (https://www.openfigi.com/id/BBG000B9XRY4) |
| **Valor** (CH NSIN) | `908440` | Swiss national instrument number | vapa.ch guide |

Note the ISIN/CUSIP relationship: the ISIN `US0378331005` = `US` + NSIN `037833100` + check `5`, and
that NSIN **is** the CUSIP. This is the embedded-CUSIP licensing trap in §3.4.

### 6.3 LISTING level — Apple's individual venue lines

| Identifier | Value | Names | Source |
|---|---|---|---|
| **ticker + exchange** | `AAPL` (exchCode `US`) | the US line (composite-level "US") | OpenFIGI mapping (exchCode field) |
| **FIGI (composite, US)** | `BBG000B9XRY4` | Apple's *US* line (aggregates all US venues) | OpenFIGI (https://www.openfigi.com/id/BBG000B9XRY4) |
| **FIGI (venue-level)** | one per each of ~14 US venues | a single NASDAQ/NYSE-Arca/etc line | OpenFIGI allocation rules / Wikipedia FIGI |
| **RIC** | `AAPL.OQ` | Apple on NASDAQ (`.OQ` = NASDAQ) | vapa.ch guide; Wikipedia RIC |
| **SEDOL** | `2046251` | the UK-system line for Apple | vapa.ch guide |
| **MIC** | `XNAS` (operating) / `XNGS` (segment) | the NASDAQ venue itself | ISO 10383 / Wikipedia MIC |

> Note the cardinality: **one** LEI, **one** ISIN / share-class FIGI, **one** US composite FIGI, but
> **~14** US venue-level FIGIs and **multiple** SEDOLs/RICs across the world. That fan-out *is* the
> entity → instrument → listing hierarchy made concrete.

### 6.4 The same picture as a tree

```
ENTITY    Apple Inc.                         LEI  HWUPKR0MPOU8FGXBT394
  │
  ├─ INSTRUMENT  Apple common stock          ISIN US0378331005
  │     │                                    CUSIP 037833100
  │     │                                    FIGI(share-class) BBG001S5N8V8
  │     │
  │     ├─ LISTING  US composite             FIGI(composite) BBG000B9XRY4 · ticker AAPL · RIC AAPL.OQ
  │     │     ├─ venue line  NASDAQ          FIGI(venue) ...  · MIC XNAS/XNGS
  │     │     ├─ venue line  NYSE Arca       FIGI(venue) ...  · MIC ARCX
  │     │     └─ ... (≈14 US venues)
  │     ├─ LISTING  Frankfurt (DE composite) ISIN unchanged · own composite/venue FIGIs · own SEDOL
  │     └─ LISTING  ... (other countries)
  │
  └─ INSTRUMENT  Apple 3.85% 2043 bond       own ISIN/CUSIP/FIGI, same LEI parent
```

This tree is the schema in miniature. The instrument's ISIN/CUSIP do not change as you move between
listings (they are instrument-level); the listing changes the venue FIGI, ticker, RIC, SEDOL, MIC.

---

## 7. Pointer table — identity question → identifier → which ref handles it

Use this to route from a *question* to the right identifier and the right sibling reference.

| The question you're answering | Level | Identifier(s) to reach for | Where the build detail lives |
|---|---|---|---|
| "Who is the legal issuer? Who owns whom?" | ENTITY | **LEI** | `patterns-crosswalk-schema-design.md` (entity node + ownership) |
| "Which security is this, globally (one per share class)?" | INSTRUMENT | **ISIN** (≈1:1), **FIGI share-class** | `patterns-crosswalk-schema-design.md` (instrument node) |
| "Which security is this, in North America?" | INSTRUMENT | **CUSIP/CINS** (⚠ licensed) | `theory-identifier-licensing-reality.md` (CUSIP terms) |
| "Which crypto token is this?" | INSTRUMENT | **DTI** (ISO 24165) | `theory-identifier-licensing-reality.md` + crypto notes |
| "The instrument *within one country*?" | INSTRUMENT (country) | **FIGI composite** | §4.2; `patterns-openfigi-api-integration.md` |
| "Which line on which venue?" | LISTING | **FIGI venue-level**, **ticker + MIC**, **RIC** (⚠), **SEDOL** (⚠) | `patterns-crosswalk-schema-design.md` (listing node) |
| "Which venue is this, as a price source?" | VENUE | **MIC** (ISO 10383) | §3.7 |
| "Map an incoming ISIN/CUSIP/SEDOL/ticker to my canonical node(s)" | resolution | **OpenFIGI mapping** (`ID_ISIN`→`figi`/`compositeFIGI`/`shareClassFIGI`) | `patterns-openfigi-api-integration.md` |
| "Can I redistribute / display this identifier commercially?" | licensing | depends on the *fetch path*, not the type | `theory-identifier-licensing-reality.md` |
| "What is my internal primary key and what is just an alias?" | schema | **FIGI spine + LEI** as keys; everything mutable/proprietary as alias | `patterns-crosswalk-schema-design.md`; §5 above |

### 7.1 One-line decision heuristics

- **Need a stable, free, level-correct primary key?** → FIGI (right level) for instruments/listings;
  LEI for entities. Never a ticker.
- **Need cross-provider resolution for free?** → OpenFIGI `/v3/mapping` (it ingests ISIN, CUSIP,
  SEDOL, ticker and returns the FIGI spine).
- **Identifier is CUSIP / SEDOL / RIC?** → it is **proprietary**; you may *use it as an input* to map
  to a free FIGI, but treat its *storage/redistribution* as licensed (RED) until cleared in
  `theory-identifier-licensing-reality.md`.
- **Two things share a ticker?** → they are different *listings*; resolve each to its FIGI and let the
  hierarchy separate them. Never merge on ticker.
- **A value "didn't change between two venues"** (ISIN, CUSIP, share-class FIGI)? → it is
  *instrument-level*; do not use it to distinguish venues. Use venue FIGI / MIC / RIC / SEDOL.

---

## 8. Summary — what to carry forward

1. **Three levels, always:** ENTITY (LEI) → INSTRUMENT (ISIN ≈1:1 / FIGI share-class / CUSIP-NA /
   DTI-crypto) → LISTING (ticker+MIC / FIGI venue / RIC / SEDOL). Most symbology bugs are level
   confusion; record the level on every alias and never join across levels.
2. **FIGI is the spine** because it is the only scheme that is perpetual, all-asset-class, encodes all
   three levels, **and** is public-domain/MIT free. Adopt share-class FIGI as the instrument key,
   venue FIGI as the listing key, LEI as the entity key.
3. **Ticker is not a key** — mutable, venue-underspecified, no check digit, no authority. Alias only.
4. **Licensing attaches to the fetch path, not the type.** FIGI/LEI/MIC are free; CUSIP/SEDOL/RIC are
   proprietary; ISIN hides a CUSIP for US/CA. The detail is in `theory-identifier-licensing-reality.md`.
5. **Resolution is free** via OpenFIGI mapping, which returns `figi` + `compositeFIGI` +
   `shareClassFIGI` in one call — the whole spine for any input. Recipe in
   `patterns-openfigi-api-integration.md`.

---

## Sources (primary, read this run)

- OpenFIGI Terms of Service — https://www.openfigi.com/docs/terms-of-service (public-domain/MIT, no
  redistribution restriction)
- OpenFIGI Overview — https://www.openfigi.com/about/overview (12-char, all asset classes incl.
  crypto/loans)
- OpenFIGI API documentation — https://www.openfigi.com/api/documentation (`/v3/mapping` fields:
  `figi`/`compositeFIGI`/`shareClassFIGI`/`exchCode`; `idType` inputs `ID_ISIN`/`ID_CUSIP`/
  `ID_SEDOL`/…)
- OpenFIGI allocation rules — https://www.openfigi.com/assets/local/figi-allocation-rules.pdf
  (share-class > composite > venue level definitions)
- Wikipedia, *Financial Instrument Global Identifier* —
  https://en.wikipedia.org/wiki/Financial_Instrument_Global_Identifier (prefix consonant rules,
  prohibited combos `BS/BM/GG/GB/GH/KY/VG`, `G` 3rd char, 8 no-vowel chars, check digit; 14-venue
  Apple example)
- GLEIF, *ISO 17442 — The LEI code structure* —
  https://www.gleif.org/en/about-lei/iso-17442-the-lei-code-structure (20-char; 1–4 LOU, 5–18 entity,
  19–20 MOD-97-10; entity not instrument; who-is-who / who-owns-whom)
- GLEIF Apple LEI record — https://www.gleif.org/lei/HWUPKR0MPOU8FGXBT394
- Wikipedia, *ISIN* (ISO 6166) —
  https://en.wikipedia.org/wiki/International_Securities_Identification_Number (2 country + 9 NSIN +
  1 Luhn check; NSIN = CUSIP for US/CA)
- Wikipedia, *CUSIP* — https://en.wikipedia.org/wiki/CUSIP (6 issuer + 2 issue + 1 check; Mod-10
  DAD; CINS 1st-char country)
- Wikipedia, *SEDOL* — https://en.wikipedia.org/wiki/SEDOL (7 chars, pre/post-2004, consonants only,
  weights `[1,3,1,7,3,9,1]`, LSE issues, per-market)
- LSEG SEDOL Masterfile Pricing & Policy Guidelines 2025 —
  https://www.lseg.com/content/dam/lseg/en_us/documents/sedol/sedol-masterfile-pricing-and-policy-guidelines-2025.pdf
  (license required; no original-format redistribution)
- 21analytics.co, *Digital Token Identifier (DTI)* —
  https://www.21analytics.co/glossary/digital-token-identifier-dti/ (9 chars, 8 base no-vowel-no-Y,
  check char; DTI Foundation RA)
- ISO 24165-1:2021 — https://www.iso.org/standard/80601.html (DTI registration & assignment)
- ISO 10383 MIC — https://www.iso20022.org/market-identifier-codes &
  https://en.wikipedia.org/wiki/Market_Identifier_Code (4-char operating/segment MIC; `XNAS`/`XNYS`/
  `XLON`; segment requires operating)
- Wikipedia, *Refinitiv Identification Code* —
  https://en.wikipedia.org/wiki/Refinitiv_Identification_Code (root + `.` + exchange suffix; `IBM.N`
  NYSE; index leading `.`)
- TradingView, *Identifiers (ISIN, CUSIP, FIGI)* —
  https://www.tradingview.com/support/solutions/43000734977-identifiers-isin-cusip-figi/ (ISIN
  global, CUSIP NA, FIGI global open)
- Intrinio, *Modern Security Master Architecture* —
  https://intrinio.com/blog/modern-security-master-architecture-unifying-ticker-cusip-isin-and-figi-data-at-scale
  (canonical record linking identifiers; ticker instability; FIGI-centered)
- vapa.ch, *Global stock identifier guide* (Apple worked example) —
  https://vapa.ch/swiss-independent-wealth-management-blog/bankable-investment-products-in-swiss-wealth-management-overview/global-stock-identifier-guide/
  (Apple ISIN `US0378331005`, CUSIP `037833100`, SEDOL `2046251`, FIGI `BBG000B9XRY4`, RIC `AAPL.OQ`,
  Valor `908440`; "eight or more codes")
- OpenFIGI Apple record — https://www.openfigi.com/id/BBG000B9XRY4 (composite `BBG000B9XRY4`,
  share-class `BBG001S5N8V8`, ticker `AAPL`, exchCode `US`)
- CUSIP licensing — https://www.cusip.com/services/license-fees.html ;
  https://www.asppa-net.org/news/2022/3/class-action-suit-challenges-big-cusip-licensing-fees/
  (proprietary, fee-bearing, antitrust litigation)
