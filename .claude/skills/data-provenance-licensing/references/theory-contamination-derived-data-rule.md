# theory — The Contamination / Derived-Data Rule

> **Skill:** `data-provenance-licensing` — JPM-Markets re-engineering **data-analytics product line (NOT Lumina)**.
> **Reference type:** `theory-*` — generic, reusable doctrine + algebra. The concrete build recipe (the
> `Provenance` value object, the `merge_provenance()` reducer wired into the TET write path, the attribution
> renderer) lives in the sibling `patterns-*` references; this file is the *why* and the *law* those recipes
> implement.
>
> **What this is.** A single, self-contained treatment of the most leak-prone surface in any data-analytics
> product: **what license a *computed* value carries.** A price you fetch has a license you can look up. A
> *spread*, a *z-score*, a *composite index*, an *AI briefing*, a *backtest equity curve*, a *correlation
> matrix* — these are values you **manufactured by joining and transforming other people's data**, and the
> question "may I display this commercially?" has no answer until you can trace every input. Get this wrong and
> you ship a number that *looks* clean (it's "your" computation) while *legally* it is still displaying a
> licensed feed you never paid for. In this product line's red-team battery this is **F2 (contamination)** and
> landing it is a **CRITICAL**.

---

## 0. The one-sentence rule (memorize this)

> **A derived value inherits the MOST RESTRICTIVE license verdict among ALL of its inputs.**

Formally: over the totally-ordered lattice `GREEN > YELLOW > RED` (least → most restrictive), the verdict of a
derived series is the **meet** (the minimum / greatest-lower-bound) of its inputs' verdicts:

```
verdict(derived) = meet( verdict(in₁), verdict(in₂), …, verdict(inₙ) )
                 = min over the lattice  (RED dominates; one RED leg ⇒ RED out)
```

Equivalently in the boolean projection this codebase already ships (`commercialOk: boolean`):

```
commercialOk(derived) = AND( commercialOk(in₁), …, commercialOk(inₙ) )   // one false ⇒ false
```

And the **attribution set** of a derived value is the **UNION** of the required attributions of every
conditioned input:

```
attribution(derived) = ⋃ attribution(inᵢ)   for every inᵢ whose license demands a notice
```

Those three lines — **meet the verdict, AND the boolean, UNION the attributions** — are the entire rule. The
rest of this document is *why each is true*, *the worked examples already in our codebase*, *the edge cases
that look like exceptions and aren't*, and *how to compute it so it can't be forgotten*.

---

## 1. Why a transformation does not launder a license

The intuitive (and wrong) mental model is: *"I did math to it, so now it's my number."* The data-vendor
contract, the EU database right, and every share-alike license were all written **specifically to defeat that
intuition**, because it is the obvious evasion every licensee tries first.

### 1.1 The principle: the license attaches to the *fetch path*, not the *concept*

This product line inherits the rule already encoded in the sibling Lumina repo's `commercialOk` gate, and it is
the foundation contamination sits on:

> "The license attaches to the FETCH PATH, not the concept. The US-Treasury 10Y yield fetched from
> treasury.gov is public-domain GREEN; the *exact same number* from Yahoo's chart API is RED. So you cannot
> reason about licensing from the data type — only from where you fetched it."
> — `.claude/rules/commercial-ok-gate.md`

The contamination rule is the *closure* of that principle under computation. If the verdict is a property of the
**path the bytes travelled**, then a value computed from those bytes still carries the path — the computation
is just a longer path. A 50-day moving average of a Yahoo price series is a *function of* Yahoo's bytes; the
function does not erase the provenance, it extends the `wasDerivedFrom` chain by one hop.

### 1.2 The legal mechanics, three independent bodies of law that all say the same thing

The rule is not a Lumina house-style preference. **Three independent legal regimes** each, on their own, force
"the restriction survives the transformation." That triple-redundancy is *why* we treat it as a hard default
rather than a judgment call.

#### (a) Copyleft / share-alike in copyright-style licenses (CC-BY-SA, ODbL)

A share-alike license is *engineered* to propagate. From the CC BY-SA 4.0 legal code, **§1 (Definitions)**:

> "**Adapted Material** means material subject to Copyright and Similar Rights that is derived from or based
> upon the Licensed Material and in which the Licensed Material is translated, altered, arranged, transformed,
> or otherwise modified in a manner requiring permission…"
> — <https://creativecommons.org/licenses/by-sa/4.0/legalcode.en>

Note the verb list — *"translated, altered, arranged, transformed, or otherwise modified"* — is exactly the
list of things "doing math to it" is. The share-alike obligation (**§3(b)**) then forces:

> "the Adapter's License You apply must be a Creative Commons license with the same License Elements, this
> version or later, or a BY-SA Compatible License."

Creative Commons states the propagation as the **two-license rule** — the downstream user holds *both* the
original and the adapter's license, and cannot escape the original's terms:

> "A user of an adaptation licensed under a CC license is receiving and must comply with (at least) two
> licenses — one from the creator of the original work, and a second from the adapter for use of the new
> content and modifications contributed by the adapter."
> — <https://wiki.creativecommons.org/wiki/4.0/Treatment_of_adaptations>

So: transform a CC-BY-SA series → your output is an Adaptation → your output **must** ship under (at least)
CC-BY-SA → its restrictiveness did not go down, and in the boolean projection a share-alike obligation you must
honor on your output means it is **not** a free-and-clear commercial display. The restriction survived the math.

#### (b) The *sui generis* database right (the EU Database Directive 96/9/EC)

For *data* (numbers, facts, time-series — the bread and butter of this product line), copyright often doesn't
bite (facts aren't copyrightable) but the **database right does**. The directive grants the maker the right to
prevent "extraction" and "re-utilisation" of a **substantial part**:

> "the maker of a database … [has] the right to prevent extraction and/or re-utilization of the whole or of a
> substantial part, evaluated qualitatively and/or quantitatively, of the contents of that database."
> — Directive 96/9/EC; see <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:31996L0009>

A derived series that *embeds* a substantial part of a protected database (every point of a vendor's price
curve, processed) is a re-utilization of that substantial part. Crucially, the directive *also* closes the
"I'll just take a little at a time" door:

> "The repeated and systematic extraction and/or re-utilization of insubstantial parts … which conflict with a
> normal exploitation of that database … shall not be permitted."
> — Directive 96/9/EC, Art. 7(5)

That is the legal reason the de-minimis / "it's just a tiny fraction" defense is *unreliable* for a product —
see §6.

#### (c) The data-vendor contract — the "Derived Data" clause (the one that actually governs us)

For paid financial feeds (Bloomberg, Refinitiv/LSEG, ICE, CME, S&P, Moody's…) copyright and database rights are
moot because you signed a **contract**, and the contract has a bespoke **"Derived Data"** definition that says
in black ink when a computed value escapes the license — and it is *narrow*. Representative language from
real exchange/vendor agreements found in this research:

> "Derived data means data created by a licensee through combining, processing, changing, converting or
> calculating the data with other data, **where the resultant data cannot be readily reverse-engineered or used
> as a substitute for** the original data provider's products."
> — paraphrased composite of the ICE and CME *Derived Data License Agreement* forms
> (<https://www.cmegroup.com/market-data/files/cme-derived-data-license-agreement.pdf>,
> <https://www.ice.com/publicdocs/ICE_Data_Form_of_Derived_Data_License_Agreement.pdf>);
> see also the survey at <https://revisionlegal.com/internet-law/data-licensing-agreements-what-businesses-should-know/>

Read that test carefully — it is the heart of vendor derived-data law:

1. A value escapes the original license **only** when it is *irreversible* — you cannot reverse-engineer the
   source value back out of it, AND
2. it is **not a substitute** — a user cannot use your output *instead of* paying the vendor for the original.

A spread, a ratio, a z-score, a *displayed chart of the underlying price* — almost always **fail** both prongs:
the source value is trivially recoverable, and a user reading your "AAPL last price" off your screen is using
it *as a substitute* for the vendor's quote. **Most things you'd want to display do not qualify as Derived
Data under the vendor definition** — which means they remain governed by the original (expensive,
display-restricted) license. The contract wrote the contamination rule for us, and made the laundering
exception deliberately hard to reach.

### 1.3 The synthesis: the AND-gate is the *conservative intersection* of three regimes

Because three different legal regimes each independently make the restriction survive a transformation, the
**safe** engineering posture is the one that satisfies all of them simultaneously: **assume the restriction
survives unless you can prove it was extinguished.** That proof is hard (§6), so the operational default is the
meet/AND. A value is GREEN/`commercialOk:true` **only when every input is independently GREEN**; the presence of
a single RED leg makes the whole composite RED. This is not pessimism — it is the *only* verdict that is
correct under all three regimes at once.

---

## 2. The lattice and the algebra (the formal core)

### 2.1 The verdict lattice

Define the verdict domain as a three-element **totally-ordered lattice**, ordered by *permissiveness*
(GREEN most permissive → RED least):

```
GREEN  ⊐  YELLOW  ⊐  RED
 │         │          │
 └ public  └ attrib./ └ no commercial display license
   domain    share-     (free tier, silent ToS,
   / CC0      alike,      "ambiguous", competitor-displays-it)
              "build but
              attribute"
```

- **GREEN** — `commercialOk: true`. Public domain (17 USC §105 US-gov), CC0, or a **purchased** commercial
  display tier. Display freely.
- **YELLOW** — displayable **but conditioned**: requires attribution (CC-BY, GDELT) and/or share-alike (CC-BY-SA,
  ODbL). In the boolean projection this *collapses toward GREEN for the `commercialOk` flag* (you may display)
  **but carries a non-empty attribution obligation** and, for share-alike, a downstream-licensing obligation.
  Treat YELLOW as "GREEN-with-strings": the strings are what the attribution-union and share-alike rules track.
- **RED** — `commercialOk: false`. No commercial-display license on the fetch path. Free API tier, silent or
  ambiguous ToS, "a competitor shows it" (the same fallacy). **Default for anything unproven.**

> **Why total, not partial.** A general license lattice is a *partial* order (CC-BY-NC and CC-BY-SA are
> incomparable — neither is "more restrictive", they're *mutually incompatible*, see §5.3). We **deliberately
> project to a total order** for the `commercialOk` decision because the product only needs one bit out: *may I
> display this commercially, yes/no*. The total order is the projection `{can-display} → GREEN/YELLOW`,
> `{cannot-display} → RED`. Incompatibility (no common downstream license exists) projects to RED — you can't
> display it, full stop — and is flagged separately as a *build-time error* (§5.3), not a runtime verdict.

### 2.2 The meet operation

`meet(a, b)` = the **more restrictive** (lower) of the two on the lattice:

| `meet` | GREEN | YELLOW | RED |
|---|---|---|---|
| **GREEN** | GREEN | YELLOW | RED |
| **YELLOW** | YELLOW | YELLOW | RED |
| **RED** | RED | RED | RED |

Properties (these matter for the reducer in §7):

- **Idempotent:** `meet(a, a) = a`.
- **Commutative:** `meet(a, b) = meet(b, a)` → input order doesn't change the verdict.
- **Associative:** `meet(meet(a, b), c) = meet(a, meet(b, c))` → you can fold the inputs in any grouping; a
  `reduce` is well-defined.
- **Identity = GREEN:** `meet(GREEN, x) = x` → GREEN is the unit, so an empty input set (a constant, a value with
  *no* licensed inputs — e.g. a pure config number) is GREEN. (A value with zero licensed inputs is not a
  *derived* value; it's an authored one. The reducer seeds the fold with GREEN precisely so "no inputs"
  ⇒ GREEN.)
- **Absorbing = RED:** `meet(RED, x) = RED` → **one RED leg poisons the whole composite.** This is the
  contamination rule, stated as the absorbing element of the meet.

### 2.3 The boolean projection (what `commercialOk` actually is)

The codebase ships a boolean `commercialOk`, which is the projection `GREEN|YELLOW → true`, `RED → false`. Under
that projection the meet becomes a plain **logical AND**:

```
commercialOk(derived) = commercialOk(in₁) ∧ commercialOk(in₂) ∧ … ∧ commercialOk(inₙ)
```

This is why the rule is so easy to *state* ("if any input is `false`, the output is `false`") and so easy to
*get wrong by omission* (you forgot to include a leg in the AND — see the anti-patterns, §8). **The boolean
loses the GREEN-vs-YELLOW distinction**, which is exactly why `Provenance` must *also* carry the attribution
set separately: `commercialOk:true` alone cannot tell you whether you still owe a citation. (See §3 — the
attribution-union rule is what recovers the YELLOW obligations the boolean dropped.)

---

## 3. The attribution-union rule

`commercialOk` answers *"may I display it?"* It does **not** answer *"what must I render alongside it?"* Those
are different obligations and they propagate **differently**:

- The **commercial-OK bit** propagates by **AND / meet** — one bad leg kills it.
- The **attribution obligations** propagate by **UNION** — every conditioned leg *adds* its required notice, and
  none of them ever drops out.

> **The attribution-union rule:** a composite must render the attribution of **EVERY** input whose license
> conditions display on attribution. Attributions accumulate; they never cancel. A GREEN composite can still
> carry a long, mandatory attribution string inherited from a single attribution-required leg.

### 3.1 Worked: GDELT's citation survives into anything that touches its tone

GDELT is the canonical case. Its terms grant *unlimited commercial use* — so on the `commercialOk` axis it is
GREEN — **but** that grant is **conditioned on a mandatory citation**:

> "all datasets released by the GDELT Project are available for unlimited and unrestricted use for any academic,
> commercial, or governmental use of any kind without fee … **any use or redistribution of the data must
> include a citation to the GDELT Project and a link to this website (https://www.gdeltproject.org/).**"
> — <https://www.gdeltproject.org/about.html>

So GDELT is **YELLOW**: displayable, but the citation is a *condition of the grant*, not a courtesy. Now build a
composite that conditions on GDELT tone — e.g. our Market Mood dial blends a recession probit (Treasury+BLS,
public-domain) with GDELT news tone. The composite's `commercialOk` is still `true` (every leg is
displayable). But the **attribution set is the union**, and GDELT's mandatory citation **must survive into the
composite's rendered attribution** — exactly as our `sentiment-sources.ts` does:

```ts
// backend/finance/sentiment-sources.ts  (the GREEN composite, lines ~349-353)
provenance: {
  source: "Lumina (composite: U.S. Treasury, BLS, GDELT)",
  commercialOk: true,
  attribution: "Lumina Market Mood — composite of U.S. Treasury, BLS and GDELT (gdeltproject.org) public data.",
},
```

The string is not decoration — `(gdeltproject.org)` is the *required link*, carried up from the GDELT leg
through the composite. Drop it and you have breached GDELT's terms even though the dial reads `commercialOk:true`.
**That is the attribution-union rule landing in production code.**

### 3.2 Why union, never intersection or "the dominant one"

A naive implementation renders *one* attribution — "the main source" — and drops the rest. That is a license
breach for every dropped conditioned leg. Each license's attribution clause is satisfied **only** by rendering
*its* notice; satisfying source A's clause does nothing for source B's. There is no "dominant attribution."
The set-union is the *minimum* that satisfies all of them, and it is mandatory. (Share-alike adds a *second*
obligation on top of attribution — the downstream-licensing requirement — which the union must also carry; see
§5.)

### 3.3 The two obligations YELLOW carries, separated

| Obligation | Propagates by | What it costs you on the output |
|---|---|---|
| **Attribution** (CC-BY, GDELT, ODbL §4.3 notice) | **union** | render the notice/link on the surface |
| **Share-alike** (CC-BY-SA §3(b), ODbL §4.4) | **union of constraints → most-restrictive common license** | you must *license your output* under (at least) the same terms — which usually means you **cannot** put it behind a proprietary paywall (see §5.4) |

The `commercialOk` boolean captures *neither* of these directly — it only says "displayable at all." A complete
`Provenance` must therefore carry, at minimum: `commercialOk` (the meet/AND bit), `attribution` (the union), and
— for a rigorous build — a `shareAlike` flag and the `licenses[]` set so the share-alike obligation isn't lost.

---

## 4. Worked examples — the four canonical shapes (two already shipped in code)

These four cover essentially every derived-value licensing question this product line will face. Two are
*literally* in the sibling codebase; learn the pattern from them.

### 4.1 RED composite — the AI briefing over Yahoo + Tavily legs

**Shape:** an LLM synthesizes prose *grounded in* RED inputs. The output is "your text" — and people reflexively
assume generated text is clean. **It is not.** The briefing's factual content is *conditioned on* (derived from)
the RED legs; the LLM is a transformation, and §1 says transformation doesn't launder.

This is exactly what `briefing.ts` stamps. Read the inline comment — it *is* the contamination rule, written by
the author at the point of the stamp:

```ts
// backend/finance/briefing.ts  (lines ~213-217)
const PROVENANCE: Provenance = {
  source: "Lumina (AI over public-domain data + cited news)",
  commercialOk: false, // prose synthesis over Tavily snippets + Yahoo index levels (commercialOk:false legs)
  attribution: "The Lumina Tape — AI briefing grounded in U.S. Treasury/BLS/GDELT data and cited news sources.",
};
```

**The verdict math:** legs = { Yahoo index levels (RED), Tavily news snippets (RED), Treasury (GREEN),
BLS (GREEN), GDELT (YELLOW) }.

```
meet(RED, RED, GREEN, GREEN, YELLOW) = RED        // the two RED legs are absorbing
commercialOk = (false ∧ false ∧ true ∧ true ∧ true) = false
```

Note the *defense-in-depth* design already in the same file: the briefing's prompt **forbids the model from
emitting any specific price level or percentage** (it must describe moves qualitatively — "rose", "slipped"),
and a deterministic validator (`validateBriefing`) scans the generated prose for stray numbers and warns:

```ts
// backend/finance/briefing.ts  (validateBriefing, lines ~193-209)
const NUMBER_RE = /(?<!\[)\b\d[\d,]*\.?\d*\s?%?/g;
// … flags any numeric token in prose that isn't a year or a [n] citation index …
```

This matters for contamination reasoning: **stripping the literal RED numbers out of the prose does NOT relicense
the prose to GREEN.** Even with zero numbers, the *content* is derived from RED sources, so the verdict stays
RED. The number-stripping serves a *different* non-negotiable ("never invent/display an ungrounded number"), not
the licensing one. Two separate guards, two separate reasons — do not conflate them. (A red-teamer who sees the
number-stripper and concludes "so it's safe to flip to GREEN" has landed F2 against you. The verdict is RED
because of the *fetch paths of the inputs*, independent of whether numbers appear on screen.)

### 4.2 GREEN composite — the recession probit over Treasury + BLS + a published method

**Shape:** a quantitative model output computed *entirely* from public-domain inputs using a published
(uncopyrightable-as-applied) methodology. Every leg is GREEN → the meet is GREEN → the composite is GREEN.

```ts
// backend/finance/sentiment-sources.ts  (the recession gauge stamp, lines ~163-171)
method:
  "Estrella–Mishkin (1998) probit on the 10-year minus 3-month Treasury spread, the methodology applied by " +
  "the Federal Reserve Bank of New York. Sahm Rule from BLS U-3 unemployment.",
provenance: {
  source: "U.S. Treasury + BLS (Lumina-computed probit)",
  commercialOk: true,
  attribution: "Source: U.S. Department of the Treasury & U.S. Bureau of Labor Statistics; recession " +
               "probability computed by Lumina (Estrella–Mishkin).",
},
```

**The verdict math:** legs = { Treasury par-yield curve (GREEN — 17 USC §105), BLS U-3 unemployment
(GREEN — 17 USC §105), Estrella–Mishkin probit *method* (not a data input; a public formula) }.

```
meet(GREEN, GREEN) = GREEN
commercialOk = (true ∧ true) = true
```

Two subtleties worth internalizing:

1. **The GREEN basis is the *fetch path*, verified.** Treasury and BLS data is public domain because it is a
   "work of the United States Government" under **17 USC §105** — "Copyright protection under this title is not
   available for any work of the United States Government" (<https://www.law.cornell.edu/uscode/text/17/105>),
   and Treasury/BLS are federal agencies whose official-duty output falls under it. **But** the comment in
   `sources.ts` is the discipline: *fetched from treasury.gov / bls.gov it is GREEN; the same number from Yahoo
   is RED.* The GREEN verdict is licensed only because we fetch from the gov source directly.
2. **A published method is not a licensed input.** The Estrella–Mishkin probit and the Sahm Rule are *formulas*;
   applying a formula to public-domain data is not "deriving from" a copyrighted database. The method adds a
   citation-of-courtesy (good scholarship, rendered in `method`) but **no license constraint** — it is not a
   leg in the meet. Don't confuse "I should credit the paper" (academic norm) with "the paper's license
   conditions my output" (it doesn't).

> **GREEN-but-wrong is still a violation of a *different* rule.** A GREEN source can produce a *wrong* number
> (the classic: SEC EDGAR XBRL duplicate/non-comparable facts). The contamination rule clears the *license*; it
> says nothing about *correctness*. Ground and validate the number independently — GREEN is necessary, not
> sufficient.

### 4.3 RED spread — a GREEN leg minus a RED leg

**Shape:** a difference/ratio/spread between two series where **one leg is RED**. People assume a *spread* is
"derivative enough" to be clean — it is the textbook contamination trap.

Example: a "real yield" = (Treasury 10Y nominal, GREEN, from treasury.gov) − (a breakeven-inflation series
pulled from a RED vendor feed). Or a "Lumina credit spread" = (corporate yield from a RED bond-data vendor) −
(Treasury benchmark, GREEN).

```
legs = { GREEN, RED }
meet(GREEN, RED) = RED
commercialOk = (true ∧ false) = false
```

Why it can't be GREEN, against the vendor "Derived Data" test (§1.2c): the RED leg is **trivially
reverse-engineerable** out of the spread (you published the GREEN leg too, or it's a known benchmark — subtract
and you have the vendor's number back), and the spread is a **substitute** for the vendor series for any user who
cares about the relationship. It fails *both* prongs of the Derived-Data escape, so it remains under the RED
vendor's license. **One RED leg ⇒ RED spread.** No exceptions on the display axis. (You may still *build and
demo* the spread internally; you may not *display it commercially*. RED gates the display license, not the
access — §6.4.)

### 4.4 YELLOW composite — share-alike input forces share-alike output

**Shape:** a composite that conditions on a **CC-BY-SA or ODbL** input. `commercialOk` may be `true`
(displayable), but the **output now inherits a share-alike obligation** — you must offer your derived series
(or derived database) under the same copyleft terms, which is usually incompatible with locking it behind your
proprietary product.

```
legs = { GREEN public-domain, YELLOW CC-BY-SA }
meet(GREEN, YELLOW) = YELLOW
commercialOk = true            // displayable
shareAlike   = true            // …but you must share-alike your output
attribution  = ⋃ (the CC-BY-SA notice + any others)
```

The ODI states the combine-rule for exactly this case:

> "if a public domain (CC0, PDDL) source is combined with a CC-BY-SA source, then the derivative must also be
> published under a CC-BY-SA licence or one which also includes requirements for attribution and sharealike."
> — <https://github.com/theodi/open-data-licensing/blob/master/guides/licence-compatibility.md>

**Engineering consequence:** a CC-BY-SA leg is *not free* even though it's displayable. For a proprietary
commercial data-analytics product, a share-alike obligation on an output is often a **dealbreaker** — you would
have to open-license your derived dataset. Treat YELLOW-share-alike inputs as a *flagged decision*, not a silent
pass: either (a) you're fine open-licensing the specific derived series, or (b) you must replace the input with a
non-copyleft source. This is why `Provenance` carries `shareAlike` separately from `commercialOk` — the boolean
alone would hide a poison pill.

### 4.5 Summary table

| Composite | Inputs (verdicts) | `meet` | `commercialOk` | Attribution (union) | Where in code |
|---|---|---|---|---|---|
| AI briefing | Yahoo(R), Tavily(R), Treasury(G), BLS(G), GDELT(Y) | **RED** | `false` | "…grounded in Treasury/BLS/GDELT + cited news" | `briefing.ts:213` |
| Recession probit | Treasury(G), BLS(G), method(—) | **GREEN** | `true` | "Treasury & BLS; computed by Lumina (Estrella–Mishkin)" | `sentiment-sources.ts:163` |
| Market Mood | recession-probit(G), GDELT(Y) | **YELLOW→displayable** | `true` | "…Treasury, BLS and **GDELT (gdeltproject.org)**" | `sentiment-sources.ts:349` |
| GREEN−RED spread | Treasury(G), vendor(R) | **RED** | `false` | n/a (not displayed) | — (counter-example) |
| CC-BY-SA composite | gov(G), CC-BY-SA(Y/SA) | **YELLOW+SA** | `true`* | union incl. CC-BY-SA notice | — (decision flag) |

\* *displayable, but with a share-alike obligation on your output — a flagged build decision, not a silent pass.*

---

## 5. The PROV-O view — provenance as a graph the constraint travels along

W3C **PROV-O** gives a standard vocabulary for *exactly* the thing the contamination rule reasons over: a
directed graph of entities linked by derivation. Using it (even just as a mental model, or as actual RDF
metadata on your stored series) makes the rule mechanical rather than ad-hoc.

### 5.1 The three terms you need

- **`prov:Entity`** — "a physical, digital, conceptual, or other kind of thing with some fixed aspects." Each of
  your fetched series and each computed series is an Entity. (<https://www.w3.org/TR/prov-o/>)
- **`prov:wasDerivedFrom`** — "A derivation is a transformation of an entity into another, an update of an
  entity resulting in a new one, or the construction of a new entity based on a pre-existing entity." This is
  the edge: `derivedSeries prov:wasDerivedFrom sourceSeries`.
- **`prov:wasAttributedTo` / `prov:Agent`** — assigns responsibility for an entity to an agent (the source
  publisher). This is the carrier for *who you must credit* — it maps onto the attribution-union.

### 5.2 The constraint travels along the edges

PROV-O models a chain by chaining the binary relation: if `C wasDerivedFrom B` and `B wasDerivedFrom A`, then C
transitively depends on A. The contamination rule is then a **graph fold**:

> The verdict of any entity = `meet` over the verdicts of the *roots* of its `wasDerivedFrom` DAG (the leaf
> entities that were *fetched*, each carrying the verdict of its fetch path). The attribution set = `union` over
> the `wasAttributedTo` agents of every entity in that DAG whose license conditions display on attribution.

In other words: **walk the `wasDerivedFrom` chain back to the fetch leaves, `meet` their verdicts, `union` their
attributions.** A computed entity never *gains* permissiveness as you walk up the chain — `meet` is monotone
non-increasing — and never *loses* an attribution obligation — `union` is monotone non-decreasing. The graph
makes both monotonicities visible.

PROV-O even gives you the sub-properties to be precise about *what kind* of derivation, which can matter for the
vendor "substantial part" test (§6): `prov:wasQuotedFrom` (you took a portion), `prov:wasRevisionOf`
(substantial reuse — almost certainly still licensed), `prov:hadPrimarySource` (the ultimate origin to trace the
license to). Recording `hadPrimarySource` on every stored series is the single most valuable provenance
annotation for licensing audits — it answers "what is the original fetch path?" without re-deriving it.

### 5.3 Incompatibility = no common downstream license (a *build error*, not a runtime verdict)

The lattice meet handles "more restrictive wins." But some input pairs are **mutually incompatible** — there is
*no* license your output could carry that satisfies both — and that is a different, harder failure. The ODI
gives the canonical pairs:

> "it's not possible to mix together one dataset published under CC-BY-SA with another dataset published under
> CC-BY-NC-SA … works licensed under the ODbL cannot be used in combination with works licensed under the
> CC-BY-NC license: the non-commercial prohibition on the CC-BY-NC licence is at odds with the sharealike
> provision of the ODbL license."
> — <https://github.com/theodi/open-data-licensing/blob/master/guides/licence-compatibility.md>

When two inputs' share-alike requirements demand *different, conflicting* downstream licenses, no derivative can
be lawfully published at all. In the total-order projection this lands as RED ("you can't display it"), but you
should **surface it distinctly at build time**: a `meet` that detects an incompatible pair should raise, not
silently stamp RED, because the fix is different — you must *remove or replace an input*, not just hide the
output. (See §7.4 for the reducer that flags this.)

### 5.4 Share-alike's second obligation, in PROV-O terms

Attribution rides `wasAttributedTo` (credit the agent). Share-alike is a constraint on the *license of the
derived entity itself* — "this entity, because it `wasDerivedFrom` a CC-BY-SA entity, must itself be offered
under CC-BY-SA." It's a property the derivation edge *imposes on the new node*. The union-of-constraints
therefore yields not just an attribution string but a **required output license** = the most-restrictive license
that satisfies every share-alike leg. For a proprietary product, if that required output license is anything
copyleft, you have a §4.4 dealbreaker.

---

## 6. The "substantial transformation" question — and why we DON'T rely on it

The single most dangerous *seductive* idea in this area: *"I transformed it so much that it's no longer the
original data — it's substantially new, so the original license no longer applies."* There **is** a real legal
seam here (the vendor Derived-Data escape, the database-right "insubstantial part" defense, copyright's
idea/expression line). The doctrine here is: **the seam exists, but we do not stand on it.** We treat it as RED
by default and only ever cross it on *written legal sign-off for a specific transformation*, never as an
engineering judgment call.

### 6.1 The three "it's transformed enough" theories and why each is unreliable

#### (a) The vendor "Derived Data" escape — narrow, and fails for displayable values

As established in §1.2(c), the contract test is *irreversible* AND *not a substitute*. Almost everything you'd
*display* fails it: prices, spreads, ratios, levels, indices the user reads as a stand-in for the source. The
escape is real (a deeply aggregated, anonymized statistic computed across a whole universe might qualify) but
it is **the exception, narrowly drawn by the vendor's own lawyers to be hard to reach**. Engineering may not
self-certify that a given transform clears it — that is a contract-interpretation question for counsel, per the
specific agreement.

#### (b) The database-right "insubstantial part" defense — undermined by the systematic-use clause

EU law lets a lawful user extract *insubstantial* parts freely (Directive 96/9/EC). But Art. 7(5) **closes the
loop**: "repeated and systematic extraction … of insubstantial parts … which conflict with a normal
exploitation … shall not be permitted." A product that *systematically* pulls a vendor's series to compute and
display derived values is the paradigm case the systematic-use clause targets. So the de-minimis defense, which
might cover a one-off academic extract, **does not cover a product's repeated programmatic use.** (See
<https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:31996L0009>.)

#### (c) Copyright's idea/expression line — doesn't help with *facts*

For copyright (as opposed to database right or contract), facts and data aren't protected — only original
expression is. One might argue a heavily-transformed series contains none of the original *expression*. But for
financial data the binding constraints are almost always the **contract** and the **database right**, not
copyright — and neither cares about idea/expression. So this theory rarely reaches the actual constraint.

### 6.2 Why "conservative default" is the *correct* engineering choice, not timidity

1. **The defenses are untested *for this use*.** De-minimis/aggregation defenses succeed in narrow, often
   academic, fact patterns; their application to a *commercial product systematically displaying derived values*
   is largely **untested in court**. Building a product on an untested defense is building on a contingent
   liability that detonates exactly when the product is successful enough to be noticed.
2. **The downside is catastrophic and asymmetric.** If RED-defaulting is wrong, you under-displayed a series you
   could have shown (recoverable: get sign-off, flip the flag). If "transformed enough" is wrong, you have been
   *commercially redistributing a licensed feed without a license* across your whole user base — breach,
   damages, injunction, reputational hit. The expected-value math is one-sided.
3. **The rule must be mechanical to be enforceable.** "Is this transformed *substantially* enough?" is a
   judgment call that *every engineer will answer differently and optimistically.* A red-teamer hunting F2 will
   find the optimistic call every time. `meet` over verified fetch-path verdicts is mechanical, auditable, and
   has no optimism knob. Replacing a mechanical AND-gate with a per-feature judgment call is precisely the
   "vibe-engineering" the negation loop exists to catch.

### 6.3 The narrow door that *is* allowed

You **may** treat a transformed series as escaping a RED leg's license **only when** all of the following hold,
*in writing*:

- the specific transformation has **written legal sign-off** against the **specific** source agreement
  (a clause, an excerpt, a counsel memo — recorded like a GREEN ledger row), AND
- it provably fails the vendor's Derived-Data test in the *escape* direction (irreversible AND not-a-substitute),
  AND
- the escape is recorded as an explicit, source-specific entry — never a blanket "transforms are clean" policy.

Absent all three, the leg stays RED and the meet carries it. The default is RED; the GREEN-via-transformation
verdict is a *documented exception per fetch path*, mirroring how a GREEN source verdict requires a ledger row.

### 6.4 RED gates *display*, not *access* — build freely, display only when cleared

A vital corollary so the conservative default doesn't paralyze development: **a RED verdict gates the commercial
*display* license, not your ability to *build against* the source.** You may fetch, compute, prototype, and demo
a RED-derived series internally all day; you simply may not ship it to users as a commercial display until the
verdict is cleared (paid tier, gov source swap, written transform sign-off). This is the same posture Lumina
takes with Polymarket/CoinGecko-Demo: build now, gate the public display. Conservatism on the *verdict* does not
mean conservatism on *exploration*.

---

## 7. Computing the composite verdict in code

The rule is only as good as its enforcement. The mechanism is a **`reduce` (fold) over the input `Provenance`
values**, seeded with the GREEN identity, applying `meet` to the verdict and `union` to the attribution at each
step. Crucially, **the merge happens at the point of composition** — wherever you build a derived value from
upstream values, you merge their provenances into the new value's provenance, in the same function, so it can't
be forgotten.

### 7.1 The verdict type and lattice (Python — this product line's stack)

```python
# provenance.py — the verdict lattice + the Provenance value object.
from __future__ import annotations
from enum import IntEnum
from dataclasses import dataclass, field, replace
from functools import reduce
from typing import Iterable

class Verdict(IntEnum):
    """Permissiveness lattice. Higher int = MORE permissive, so `min()` IS the meet."""
    RED = 0      # no commercial-display license on the fetch path. Default for the unproven.
    YELLOW = 1   # displayable but conditioned (attribution and/or share-alike).
    GREEN = 2    # public domain / CC0 / purchased display tier. Free to display.

def meet(a: Verdict, b: Verdict) -> Verdict:
    """The lattice meet = the more restrictive (lower) verdict. min() because higher = more permissive."""
    return Verdict(min(int(a), int(b)))
```

> **Why `IntEnum` with RED=0.** The meet is then *literally* `min()` — associative, commutative, idempotent for
> free, and a fold over an empty iterable can seed with `GREEN` (the identity) cleanly. Encoding RED as the
> smallest int makes "one RED leg ⇒ RED" fall out of `min` automatically; you cannot forget the absorbing
> element because arithmetic enforces it.

### 7.2 The `Provenance` value object (carries all three propagating facts)

```python
@dataclass(frozen=True)
class Provenance:
    """
    Travels WITH every series — fetched or derived. `frozen=True` so a stamped provenance can't be
    silently mutated downstream (a derived value gets a NEW Provenance via merge, never an edit).
    """
    verdict: Verdict
    # The set of attribution notices that MUST be rendered. Frozenset → union is mechanical & dedup'd.
    attributions: frozenset[str] = field(default_factory=frozenset)
    # Share-alike: the set of copyleft licenses imposed on THIS entity by its inputs. Non-empty ⇒
    # the output must be offered under (at least) the most-restrictive of these — a §4.4 dealbreaker
    # for a proprietary product. Tracked separately because `verdict` (commercialOk) can't represent it.
    share_alike_licenses: frozenset[str] = field(default_factory=frozenset)
    # For audit: the fetch-path identifiers of the leaf sources (PROV-O hadPrimarySource roots).
    sources: frozenset[str] = field(default_factory=frozenset)
    # Flags any mutually-incompatible input pair detected during merge (§5.3) — a BUILD error.
    incompatible_pairs: tuple[tuple[str, str], ...] = ()

    @property
    def commercial_ok(self) -> bool:
        """The boolean projection the front end consumes. GREEN|YELLOW are displayable; RED is not."""
        return self.verdict >= Verdict.YELLOW
```

### 7.3 The merge reducer (the contamination rule, executable)

```python
# The identity element: a value with NO licensed inputs (a constant) is GREEN with no obligations.
GREEN_IDENTITY = Provenance(verdict=Verdict.GREEN)

def _merge_two(acc: Provenance, p: Provenance) -> Provenance:
    return Provenance(
        verdict=meet(acc.verdict, p.verdict),                                   # meet: one RED ⇒ RED
        attributions=acc.attributions | p.attributions,                         # union: never drop a notice
        share_alike_licenses=acc.share_alike_licenses | p.share_alike_licenses, # union: carry every copyleft
        sources=acc.sources | p.sources,
        incompatible_pairs=acc.incompatible_pairs
            + _detect_incompatible(acc.share_alike_licenses, p.share_alike_licenses),
    )

def merge_provenance(inputs: Iterable[Provenance]) -> Provenance:
    """
    THE contamination rule. Fold the meet over verdicts, the union over attributions & share-alike.
    Seed with GREEN_IDENTITY so an empty input set ⇒ GREEN (an authored constant, no licensed legs).
    Call this AT THE POINT a derived value is composed, and stamp its result onto the new value.
    """
    return reduce(_merge_two, inputs, GREEN_IDENTITY)
```

### 7.4 Detecting incompatible share-alike pairs (the build-error path of §5.3)

```python
# Pairs that have NO common downstream license — combining them is unpublishable, not merely RED.
# Source: ODI licence-compatibility (CC-BY-SA × CC-BY-NC-SA; ODbL × CC-BY-NC) — extend as counsel confirms.
_INCOMPATIBLE = frozenset({
    frozenset({"CC-BY-SA-4.0", "CC-BY-NC-SA-4.0"}),
    frozenset({"ODbL-1.0", "CC-BY-NC-4.0"}),
    frozenset({"ODbL-1.0", "CC-BY-NC-SA-4.0"}),
})

def _detect_incompatible(a: frozenset[str], b: frozenset[str]) -> tuple[tuple[str, str], ...]:
    out: list[tuple[str, str]] = []
    for x in a:
        for y in b:
            if frozenset({x, y}) in _INCOMPATIBLE:
                out.append(tuple(sorted((x, y))))
    return tuple(out)

def assert_publishable(p: Provenance) -> None:
    """Call after merge, BEFORE persisting/displaying a derived series. Incompatible inputs ⇒ raise."""
    if p.incompatible_pairs:
        raise LicenseIncompatibilityError(
            f"Derived series combines mutually-incompatible licenses {p.incompatible_pairs}; "
            f"no lawful downstream license exists. Remove or replace an input — do not stamp RED and ship."
        )
```

### 7.5 Using it at the point of composition (the discipline that makes it un-forgettable)

```python
def compute_spread(green_leg: Series, red_leg: Series) -> DerivedSeries:
    values = green_leg.values - red_leg.values          # the transformation
    prov = merge_provenance([green_leg.provenance, red_leg.provenance])
    assert_publishable(prov)                             # raises on incompatible inputs
    return DerivedSeries(values=values, provenance=prov) # stamp the merged provenance onto the output

# meet(GREEN, RED) = RED  ⇒  spread.provenance.commercial_ok is False, automatically.
# There is no place to "forget a leg": every input series you read is an arg, and every arg's
# provenance goes into the merge. The reducer can't be partially applied.
```

> **The single highest-leverage convention:** *the function that computes a derived value is the function that
> merges the provenance.* Co-locating them means you cannot add an input to a computation without adding its
> provenance to the merge — the type system and code review both surface a `Series` arg whose `.provenance` was
> not fed in. Splitting "compute here, license later" is the #1 way contamination leaks (§8.1).

### 7.6 Property tests that pin the algebra

```python
# test_provenance.py — these tests ARE the spec; they fail loudly if someone "optimizes" the rule.
def test_one_red_leg_poisons_the_composite():
    legs = [Provenance(Verdict.GREEN), Provenance(Verdict.GREEN), Provenance(Verdict.RED)]
    assert merge_provenance(legs).verdict is Verdict.RED
    assert merge_provenance(legs).commercial_ok is False

def test_meet_is_order_independent():           # commutativity — input order must not change the verdict
    a, b, c = Provenance(Verdict.GREEN), Provenance(Verdict.YELLOW), Provenance(Verdict.RED)
    from itertools import permutations
    verdicts = {merge_provenance(p).verdict for p in permutations([a, b, c])}
    assert verdicts == {Verdict.RED}            # every ordering ⇒ RED

def test_attributions_union_never_drops_a_leg():
    legs = [
        Provenance(Verdict.GREEN, attributions=frozenset({"Treasury"})),
        Provenance(Verdict.YELLOW, attributions=frozenset({"GDELT (gdeltproject.org)"})),
    ]
    merged = merge_provenance(legs)
    assert merged.attributions == {"Treasury", "GDELT (gdeltproject.org)"}   # both survive
    assert merged.commercial_ok is True                                      # displayable…
    assert "gdeltproject.org" in " | ".join(sorted(merged.attributions))     # …with GDELT's mandatory link

def test_empty_inputs_is_green_identity():      # an authored constant has no licensed legs ⇒ GREEN
    assert merge_provenance([]).verdict is Verdict.GREEN

def test_incompatible_share_alike_pair_raises():
    legs = [
        Provenance(Verdict.YELLOW, share_alike_licenses=frozenset({"CC-BY-SA-4.0"})),
        Provenance(Verdict.YELLOW, share_alike_licenses=frozenset({"CC-BY-NC-SA-4.0"})),
    ]
    import pytest
    with pytest.raises(LicenseIncompatibilityError):
        assert_publishable(merge_provenance(legs))
```

---

## 8. Anti-patterns — how contamination actually leaks (each with the fix)

These are the concrete failure modes a red-teamer hunting **F2** will probe. Each is a real, easy-to-make
mistake; the fix is mechanical.

### 8.1 "Compute now, license later" (the split that loses a leg)

**Mistake.** The transformation lives in one module; provenance gets stamped in a *different* module (often the
route handler) by a human eyeballing "the main source." Every input that the stamper forgot is a dropped leg —
a silent RED → GREEN promotion. **Fix.** Co-locate: `merge_provenance` is called in the same function that does
the math, fed *every* input's provenance (§7.5). The verdict is an output of the computation, never a separate
later annotation.

### 8.2 "It's my computation, so it's clean" (the laundering fallacy)

**Mistake.** Treating a generated/derived value as authored-from-scratch because *you* wrote the code. The AI
briefing case (§4.1) is the trap: generated prose *feels* like your IP. **Fix.** Internalize §1 — transformation
extends the `wasDerivedFrom` chain, it doesn't cut it. If the value's content is *conditioned on* an input, that
input is a leg. The briefing stamps `commercialOk:false` even though every word was model-generated.

### 8.3 "I stripped the numbers, so it's GREEN now" (conflating two guards)

**Mistake.** Seeing the briefing's number-stripping validator and concluding the prose is now license-clean.
**Fix.** The number-strip serves the *grounding* non-negotiable, not the *licensing* one (§4.1). A
RED-derived value with the numbers removed is still RED — the verdict tracks the *fetch paths of the inputs*,
which removing on-screen digits does not change.

### 8.4 "One attribution is enough" (the dropped-citation breach)

**Mistake.** Rendering only the "primary" source's attribution and dropping the rest — so a GDELT-conditioned
composite ships without GDELT's mandatory `gdeltproject.org` link. **Fix.** Attribution propagates by **union**
(§3); render *every* conditioned leg's notice. The `attributions` frozenset and its `|` merge make this
automatic — the only way to drop one is to not feed its provenance in (which §8.1's co-location catches).

### 8.5 "Substantially transformed, so the license drops" (the untested-defense gamble)

**Mistake.** An engineer self-certifies that a transform is "derivative enough" to escape a RED vendor leg.
**Fix.** §6 — the escape is a narrow, source-specific, **written-legal-sign-off** exception, never an
engineering judgment call. Default RED; cross only on a recorded per-source clearance. A red-teamer treats any
unsigned "it's transformed enough" as a landed CRITICAL.

### 8.6 "Stamp RED and ship" on incompatible inputs (hiding a build error as a runtime verdict)

**Mistake.** Two share-alike inputs have no common downstream license; the code `meet`s them to RED and serves
the composite as "not for display" — but it has *already combined them*, which is itself unpublishable.
**Fix.** `assert_publishable` raises on incompatible pairs (§7.4); the resolution is to *remove or replace an
input*, not to hide the output behind a RED flag.

### 8.7 "GREEN, therefore correct" (clearing license but not numbers)

**Mistake.** A GREEN verdict treated as a quality pass. **Fix.** GREEN clears the *license* only; a GREEN source
can still emit a wrong/duplicate number (§4.2). Ground and validate independently — the contamination rule and
the numeric-grounding rule are orthogonal.

### 8.8 "The cache key forgot the source" (a stale verdict on a refreshed leg)

**Mistake.** A composite is cached, an input source is swapped (gov → vendor, or a free tier downgraded), but
the cached composite keeps its old GREEN provenance. **Fix.** The provenance is *part of* the cached value and
is recomputed by `merge_provenance` on every refresh from the *current* leg provenances — never hand-cached
separately from the data it describes.

---

## 9. The decision procedure (run this for any derived value)

1. **Enumerate the legs.** List *every* fetched input the value is conditioned on. Walk the `wasDerivedFrom`
   chain to the **fetch leaves** — not the immediate inputs, the roots. (A composite of composites: recurse.)
2. **Verdict each leaf by its fetch path**, not its concept. GREEN only if the path has a recorded
   public-domain / CC0 / purchased-tier basis (a ledger row). Unproven ⇒ RED. Attribution/share-alike-conditioned
   ⇒ YELLOW.
3. **`meet` the verdicts.** One RED ⇒ RED. The output's `commercialOk` is the AND of the legs'.
4. **`union` the attributions.** Render *every* conditioned leg's required notice on the surface. Carry mandatory
   links (GDELT's `gdeltproject.org`) verbatim.
5. **Check share-alike & incompatibility.** Any CC-BY-SA/ODbL leg ⇒ flag the output's share-alike obligation
   (a proprietary-product decision). Any incompatible pair ⇒ **build error**, replace an input.
6. **Stamp the merged `Provenance` onto the derived value at the point of composition** — same function, not a
   later annotation. Persist provenance *with* the value.
7. **Do NOT invoke "substantially transformed"** to upgrade a RED leg unless you have written, source-specific
   legal sign-off (§6.3). Default RED; the upgrade is a documented exception, never a judgment call.

---

## 10. Quick reference card

```
VERDICT     = meet over all input verdicts        (GREEN>YELLOW>RED; one RED ⇒ RED)
commercialOk = AND over all input commercialOk     (one false ⇒ false)
ATTRIBUTION = UNION over all conditioned inputs    (every notice survives; never drop GDELT's link)
SHARE-ALIKE = UNION of copyleft obligations        (CC-BY-SA/ODbL leg ⇒ your output is share-alike too)
INCOMPATIBLE = no common downstream license         (build error — replace an input, don't stamp RED & ship)

WHY: a transformation does not launder a license (copyleft adaptation + DB right + vendor Derived-Data clause).
DEFAULT: RED. "Substantially transformed ⇒ clean" is an UNTESTED defense — cross only on written legal sign-off.
RED gates DISPLAY, not ACCESS — build/demo freely; ship commercially only when the verdict clears.
IN CODE: reduce(meet, verdicts, GREEN) + reduce(union, attributions, ∅), merged AT the point of composition.
SHIPPED EXAMPLES: briefing.ts:213 (RED composite) · sentiment-sources.ts:163,349 (GREEN/YELLOW composites).
```

---

## Sources

**Primary license / legal texts**
- ODbL v1.0 — Derivative Database & Produced Work definitions, §4.3 notice, §4.4 share-alike, §4.5(b):
  <https://opendatacommons.org/licenses/odbl/1-0/>
- CC BY-SA 4.0 legal code — Adapted Material definition (§1), share-alike (§3(b)):
  <https://creativecommons.org/licenses/by-sa/4.0/legalcode.en>
- CC "Treatment of adaptations" — the two-license propagation rule:
  <https://wiki.creativecommons.org/wiki/4.0/Treatment_of_adaptations>
- ODI open-data-licensing — licence-compatibility (the "minimum licence" combine rule + incompatible pairs):
  <https://github.com/theodi/open-data-licensing/blob/master/guides/licence-compatibility.md>
- EU Database Directive 96/9/EC — sui generis right, substantial part, Art. 7(5) systematic insubstantial use:
  <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:31996L0009>
- 17 U.S.C. §105 — no copyright in US Government works (Treasury/BLS public-domain basis):
  <https://www.law.cornell.edu/uscode/text/17/105>
- GDELT terms of use — unlimited commercial use *conditioned on* a mandatory citation + link:
  <https://www.gdeltproject.org/about.html>

**Vendor "Derived Data" contracts (the clause that governs paid feeds)**
- CME Group Derived Data License Agreement (irreversible + not-a-substitute test):
  <https://www.cmegroup.com/market-data/files/cme-derived-data-license-agreement.pdf>
- ICE Data Form of Derived Data License Agreement:
  <https://www.ice.com/publicdocs/ICE_Data_Form_of_Derived_Data_License_Agreement.pdf>
- Revision Legal — data-licensing agreements / derived-data & combine-with-third-party clauses:
  <https://revisionlegal.com/internet-law/data-licensing-agreements-what-businesses-should-know/>

**Provenance modeling**
- W3C PROV-O — `prov:Entity`, `prov:wasDerivedFrom`, `prov:Derivation`, `prov:wasAttributedTo`, derivation chains:
  <https://www.w3.org/TR/prov-o/>

**License-combination / most-restrictive-propagation (corroborating)**
- Creative Commons "Remix and compatibility" — combining CC-BY + CC-BY-SA ⇒ output must be CC-BY-SA:
  <https://course.oeru.org/lida100/unit-3/creative-commons/remix-and-compatibility/>
- Wikipedia "License compatibility" — most-restrictive-license-of-the-parents rule for combined works:
  <https://en.wikipedia.org/wiki/License_compatibility>

**In-repo sibling evidence (Lumina codebase, read this run)**
- `backend/finance/briefing.ts:213` — RED composite stamp + the inline "RED legs" comment; `:193` validator.
- `backend/finance/sentiment-sources.ts:163` — GREEN recession probit; `:349` YELLOW Market Mood (GDELT union).
- `backend/finance/sources.ts:17` — the `Provenance` type; the "license attaches to the fetch path" doctrine.
- `.claude/rules/red-team-negation-loop.md` — F2 "contamination rule"; `.claude/rules/commercial-ok-gate.md`.
