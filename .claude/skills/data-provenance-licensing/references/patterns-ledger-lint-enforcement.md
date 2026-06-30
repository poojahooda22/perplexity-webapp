# patterns · The ledger + lint + hook — turning the `commercialOk` rule into a mechanically-checked gate

> **Scope.** This is the **enforcement recipe** for the `data-provenance-licensing` dev-skill of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina.** The three sibling *theory*
> docs say *what the verdict is* and *why* — the fetch-path principle
> ([`theory-commercialok-fetch-path-licensing.md`](theory-commercialok-fetch-path-licensing.md)), the
> open-data license landscape ([`theory-open-data-licenses.md`](theory-open-data-licenses.md)), and the
> PROV-O lineage vocabulary ([`theory-prov-o-lineage-model.md`](theory-prov-o-lineage-model.md)). This
> doc says *how the verdict is mechanically enforced so a wrong one cannot ship.* It is the **gate**, not
> the philosophy: the ledger format that is the single source of truth, the `/sources-lint`-class CI
> audit that blocks a build, the PreToolUse hook that puts a human in the loop, the end-to-end loop that
> ties them together, and the concrete extension of all three to the DaaS catalog's per-Distribution
> license field.
>
> **The product line, in one sentence.** We re-engineer JPMorgan's internal data products
> (DataQuery / Fusion class) into our own free-license, prosumer financial-data-analytics platform on a
> **new Python/FastAPI/data-engineering stack** (separate from Lumina's Bun + Express + Prisma + Supabase
> + Upstash). The platform **owns the bytes**: it ingests N upstream feeds, normalizes them onto one
> standard model, **persists** them, and **redistributes** them at spike scale. Persistence +
> redistribution is exactly what turns a free-tier licence breach from a footnote into a takedown notice.
> An *enforced* gate is the only thing that keeps a 200-dataset catalog honest.
>
> **The on-ramp (plain language).** A rule that lives only in a human's head gets forgotten the day the
> author goes on holiday and a new engineer wires a fast, free API into the catalog because it "just
> works." The fix is to make the rule *mechanical*: write every cleared source into one table (the
> **ledger**); make the code that flips the "OK to display commercially" switch *point back at a row in
> that table*; and run a **linter in CI** that fails the build if any switch is flipped without a green
> row behind it. A **hook** nudges the engineer the moment they type the switch, so the mistake is caught
> at the keyboard, not in production. This doc is the build recipe for that ledger + linter + hook, and
> for extending it to a catalog where every *distribution* of every dataset carries its own licence.
>
> **What this doc is NOT.** It is not the licence taxonomy (that's `theory-open-data-licenses.md`) and not
> the classification *decision* for a given source (that's the source-classification recipe + the ledger
> verdicts themselves). It assumes you already *have* a verdict; it makes that verdict un-bypassable.

---

## 0. The thirty-second answer (read this first)

1. **The ledger is the single source of truth.** One table — `source · fetch path · verdict · governing
   clause · confirmed-on` — is the *only* place a `commercialOk:true` is allowed to originate. Lumina's
   live ledger is [`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md); the DaaS
   inherits its format and turns each row into a typed record.

2. **Code that flips the gate must anchor to a ledger row.** In the runnable model, `commercial_ok=True`
   is *illegal without a `ledger_row`* (it raises at construction — see
   [`theory-commercialok-fetch-path-licensing.md` §10](theory-commercialok-fetch-path-licensing.md), the
   `Provenance._enforce_gate` validator). The anchor is what the linter walks.

3. **`/sources-lint` is the CI audit.** It greps every `commercialOk:true` / `commercial_ok=True` in the
   code, finds the fetch path each describes, looks up the matching ledger row, and **flags any hit whose
   row is not 🟢 GREEN** (RED / YELLOW / REJECT / *missing*). Default to RED when a path can't be matched —
   *silence is not a licence.* ([`.claude/commands/sources-lint.md`](../../../commands/sources-lint.md).)

4. **The PreToolUse hook is the human-in-the-loop checkpoint.** `precheck-licensing.mjs` fires on every
   `Write|Edit`; if the edit *introduces* `commercialOk:true` it emits a non-blocking **nudge** ("verify
   the fetch path is GREEN in the ledger"); on a real `.env` write it **asks** for confirmation. It catches
   the mistake at the keyboard, before the diff exists.
   ([`.claude/hooks/precheck-licensing.mjs`](../../../hooks/precheck-licensing.mjs).)

5. **The loop, end to end:** *edit sets the gate → hook nudges → the ledger must already have a GREEN row →
   CI lint blocks the merge if it doesn't.* Three independent checks at three different moments (keyboard,
   commit, merge), so a single missed one is backstopped by the next.

6. **Add the row BEFORE you ship.** The ledger discipline is *write the row first.* An un-ledgered source
   is, by the linter's default-RED rule, treated as RED — so the build breaks until a human files the
   verdict. This is the mechanism that forces classification to *precede* integration.

7. **Lint cannot catch a wrong-but-ledgered verdict or an un-rendered attribution.** A row that *says*
   GREEN but is legally RED passes every machine check; a CC-BY series whose attribution sits in the
   payload but never renders on screen also passes. These are exactly the holes a **periodic human
   re-audit** and the **red-team negation loop (F2)** exist to close. The gate makes the *common* mistake
   impossible and *narrows* the surface a human must review — it does not eliminate the human.

If that's the whole answer you needed, stop here. The rest is the runnable recipe: the ledger row schema
and parser, the linter implementation (Python + a policy-as-code variant), the hook in detail, the DaaS
per-Distribution extension with a catalog-wide audit, the falsifiability test, and the precise statement of
what stays human.

---

## 1. The sources-ledger as single source of truth

### 1.1 Why one table, and why it is the *only* origin of a GREEN verdict

The licensing discipline has exactly one failure mode that matters at catalog scale: **a `commercialOk:true`
that no human ever cleared.** It happens not through malice but through entropy — an engineer wires a
fast free API, the demo looks great, the gate gets flipped to make a card render, and three months later
the product is publicly redistributing a vendor's data under a personal-use ToS. The defence is
*centralisation*: there is **one** table of cleared paths, and a gate-true is *only* legitimate if it can
name a green row in that table. Everything else in this doc is machinery to enforce "name a green row."

This mirrors how SBOM tooling solves the identical problem for *software* licences. CycloneDX attaches a
per-component licence with an `acknowledgement` attribute that is either `"declared"` (what the author
claims) or `"concluded"` (what an audit confirmed), plus `evidence.licenses` for *observed* licences found
during scanning ([CycloneDX, "Open Source Licensing" use-case](https://cyclonedx.org/use-cases/open-source-licensing/),
fetched 2026-06-24). Our ledger is the **concluded** layer for *data*: a human's confirmed verdict, the
thing downstream tooling is allowed to trust. The lesson SBOMs teach is that *declared ≠ concluded* — and
our ledger is deliberately the concluded one, which is why §7's "wrong-but-ledgered" hole exists and must be
human-audited.

> **The principle, restated (from [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)):** *the
> licence attaches to the FETCH PATH, not the concept.* The ledger is therefore keyed by **fetch path**,
> never by data concept. "US 10-year yield" is not a row; `home.treasury.gov/daily-treasury-rates.xml` is.

### 1.2 The row format

Lumina's live ledger ([`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md)) uses a
four-column markdown table per category. The exact header (verbatim from the file):

```
| Source | Fetch path | Verdict | Governing clause (short) |
```

A representative row, copied verbatim:

```
| US Treasury | `home.treasury.gov` daily yield XML | 🟢 GREEN | US-gov public domain (17 USC §105). |
| Yahoo chart API | `query*.finance.yahoo.com` — `getIndices` | 🔴 RED | No commercial-display grant; ToS forbids redistribution. |
| GDELT DOC 2.0 | `api.gdeltproject.org` — `fetchNewsSentiment` | 🟢 GREEN (conditioned) | "Unlimited and unrestricted… commercial use" with mandatory verbatim citation + link… |
```

The four columns, and what each is *for*:

| Column | What it holds | Why the linter needs it |
|---|---|---|
| **Source** | Human name of the provider/feed ("US Treasury", "CoinGecko Demo"). | The label a reviewer scans; the linter matches it loosely. |
| **Fetch path** | The *exact door*: host + endpoint + account tier (`api.coingecko.com` demo key). | The **key**. The licence attaches here. The linter matches a code site's fetch path against this. |
| **Verdict** | One of 🟢 GREEN / 🟡 YELLOW / 🔴 RED / ⛔ REJECT (the legend, §1.3). | The boolean the linter computes the gate from. Only GREEN clears `commercialOk:true`. |
| **Governing clause (short)** | A one-line quote/paraphrase of the ToS/statute that *justifies* the verdict, with the instrument named (e.g. "17 USC §105"). | The audit trail. A verdict with no cited clause is a vibe, not a finding — and the row should be rejected in review. |

For the DaaS we keep these four as the *legal core* and add operational columns the catalog needs
(§6.2): `confirmed_on` (date), `attribution` (the string that must render for CC-BY/conditioned-GREEN),
`spdx` (machine licence id), and `distribution_ref` (which catalog Distribution this clears). The legal core
stays identical so the discipline transfers unchanged.

### 1.3 The GREEN / YELLOW / RED / REJECT legend

Verbatim from the ledger header — these four rungs are the entire verdict space, and the only one that
clears the gate is GREEN:

| Symbol | Verdict | Means | Gate |
|---|---|---|---|
| 🟢 | **GREEN** | Displayable: public-domain / CC0 / CC-BY (with attribution rendered), or a *purchased* display tier. | `commercialOk` **may** be `true`. |
| 🟡 | **YELLOW** | Conditional / a derived-data licence is needed before display (e.g. CME-derived FedWatch → needs a Derived-Data Licence). | `commercialOk:false` until the condition is satisfied and documented. |
| 🔴 | **RED** | No display grant on this path (every free vendor tier; a silent/ambiguous ToS). *Access may still work* — build against it, gated false, attributed. | `commercialOk:false`, always. |
| ⛔ | **REJECT** | The ToS *forbids the use outright* — caching, display, scraping, or AI use is named-prohibited (Kalshi is the textbook case: its ToS bans non-commercial-only use, archived/cached datasets, public display, scraping, **and** ML/AI use). **Do not integrate at all.** | Not even *access*. The source does not enter the codebase. |

The REJECT rung is the one most teams miss: RED still lets you *build against* a source informationally
(you keep the gate false), but REJECT means the source is radioactive — even fetching-to-inform-the-model
is a ToS breach. The linter must therefore treat REJECT as a *harder* failure than RED: a RED gate-true is
a mis-licence; a REJECT *anywhere in the code* is a "remove this integration" finding (§5.4).

> **The contamination corollary (composites).** A composite series (a blend, an index, an "AI briefing"
> over multiple inputs) inherits the **most restrictive** verdict among its inputs. This is exactly SPDX's
> `AND` (conjunctive) semantics: *"if required to simultaneously comply with two or more licenses"*
> ([SPDX 3.0.1 license-expressions annex](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/),
> fetched 2026-06-24). A GREEN-and-RED composite is **RED** — a `commercialOk:true` on it is the
> *contamination* violation the red-team loop's F2 hunts ("a composite that inherits a RED input yet claims
> GREEN"). The ledger must therefore be walkable not just per-source but per-*composite*, resolving the
> conjunction (§6.4).

### 1.4 The "add the row BEFORE shipping" rule

The single most important *process* rule, verbatim from the ledger's Maintenance section:

> *"Adding a source? Add a row here **before** shipping it. `/sources-lint` audits code for
> `commercialOk:true` without a matching 🟢 row."*
> ([`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md), "Maintenance".)

This is *fail-closed by construction*. Because the linter's default for an unmatched fetch path is **RED**
(§5.3), a source that has not been ledgered is *treated as RED* — so the moment you try to display it, the
build breaks. The only way to make the build green is to *first* file a verdict. The ordering — ledger row,
then code — is not a nicety; it is the mechanism that forces a licence decision to *precede* integration
rather than chase it. (This is the data-analogue of "write the test first": the gate exists before the
behaviour that must satisfy it.)

The DaaS hardens this from a convention into a CI invariant (§6.3, the catalog-level audit): **every
Distribution registered in the catalog must reference a ledgered fetch path before its dataset can be
published.** A publish of a Distribution with no ledger anchor fails the catalog-build, not just the lint.

### 1.5 The confirmation-date discipline

A licence verdict is **perishable.** A ToS is a living document; a free tier that was silent on
redistribution last year can add an explicit non-commercial clause this year (or, rarely, the other way).
The ledger header records *when* the verdicts were last adversarially verified:

> *"Verdicts below were adversarially verified (2026-06-23, 25-agent research workflow) against primary
> ToS/statute text. **Re-confirm before flipping any gate.**"*
> ([`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md) header.)

Two disciplines follow, and the DaaS must encode both:

1. **Per-row `confirmed_on` date.** Each row carries the date its governing clause was last read against
   the *live* ToS. A row older than the staleness horizon (we use **180 days** for vendor ToS, which churn;
   **365 days** for statutes like 17 USC §105, which do not) is *stale* and the linter emits a **warning**
   (not a hard fail — the verdict is still presumed valid, but flagged for re-read). See §6.5 for the
   `staleness` check.

2. **Re-confirm before flipping a gate.** When an engineer *changes* a gate from false→true (the highest-risk
   edit), the discipline is to re-read the live ToS *that day*, not trust a year-old row. The PreToolUse
   hook (§4) is the prompt that triggers this re-read; the `confirmed_on` date is bumped as part of the same
   change.

> **Why the date is load-bearing.** Without it, the ledger silently rots: every verdict looks equally fresh,
> and an audit cannot tell a verdict re-read yesterday from one filed two years ago against a ToS that has
> since changed. The date turns "is this verdict current?" from an unanswerable question into a subtraction.

### 1.6 The ledger as a typed record (the DaaS upgrade from markdown)

Markdown is the right format for a 20-row team ledger a human reads. At 200 datasets × multiple
distributions, the linter needs to *parse* it, so the DaaS promotes the ledger to a typed registry that the
markdown is *generated from* (so humans still read a table, but tools read structured records). The minimal
schema, in Pydantic v2 (matching the stack the rest of this skill builds on):

```python
# daas/licensing/ledger.py
from __future__ import annotations
from datetime import date, timedelta, datetime, timezone
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator, model_validator


class Verdict(str, Enum):
    GREEN = "GREEN"     # displayable: PD / CC0 / CC-BY (attributed) / purchased display tier
    YELLOW = "YELLOW"   # conditional — needs a derived-data licence first
    RED = "RED"         # no display grant on this path (default for free vendor tiers, silent ToS)
    REJECT = "REJECT"   # ToS forbids the use outright — do not integrate at all

    @property
    def clears_gate(self) -> bool:
        # The ONLY rung that may carry commercialOk=True.
        return self is Verdict.GREEN


# Staleness horizons (§1.5): vendor ToS churn fast; statutes do not.
_STALE_AFTER = {
    "statute": timedelta(days=365),   # e.g. 17 USC §105
    "vendor":  timedelta(days=180),   # any ToS-governed path
}


class LedgerRow(BaseModel):
    """One verified fetch-path verdict — the typed form of a sources-ledger row.

    This is the CONCLUDED licence (the human-confirmed verdict), in the SBOM sense:
    downstream tooling is allowed to trust it. The DECLARED licence (what the vendor's
    page claims) is captured separately during classification and is NOT trusted here.
    """
    model_config = {"frozen": True}

    row_id: str = Field(..., min_length=1, description="Stable anchor, e.g. 'treasury-par-yield'. Code points here.")
    source: str = Field(..., min_length=1, description='Human name, e.g. "US Treasury".')
    fetch_path: str = Field(..., min_length=1, description="The exact door: host+endpoint+tier. THE KEY.")
    verdict: Verdict
    governing_clause: str = Field(..., min_length=8, description="Cited ToS/statute justifying the verdict. No vibe verdicts.")
    clause_kind: str = Field(default="vendor", description="'statute' | 'vendor' — picks the staleness horizon.")
    confirmed_on: date = Field(..., description="Date the live ToS was last read for this row (§1.5).")
    spdx: Optional[str] = Field(default=None, description='SPDX id/expression, e.g. "CC-BY-4.0" or "OR-of-inputs".')
    attribution: str = Field(default="", description="String that MUST render on any surface showing this (CC-BY/conditioned-GREEN).")

    @field_validator("governing_clause")
    @classmethod
    def _no_empty_clause(cls, v: str) -> str:
        # A verdict with no cited instrument is not a verdict. Reject it at parse time.
        if not v.strip() or v.strip().lower() in {"n/a", "tbd", "unknown", "todo"}:
            raise ValueError("governing_clause must cite the actual ToS/statute — placeholders are rejected.")
        return v

    @model_validator(mode="after")
    def _green_needs_attribution_when_required(self) -> "LedgerRow":
        # A conditioned-GREEN / CC-BY row that clears the gate MUST carry the attribution string
        # the licence requires to render (the lint can't see the screen — §7 — but it can see the row).
        if self.verdict is Verdict.GREEN and self.spdx in {"CC-BY-4.0", "ODC-By-1.0"} and not self.attribution.strip():
            raise ValueError(
                f"{self.spdx} is GREEN only WITH a rendered attribution — the ledger row must carry the "
                "attribution string so the surface can render it. (§1.3 contamination/attribution.)"
            )
        return self

    @property
    def is_stale(self) -> bool:
        horizon = _STALE_AFTER.get(self.clause_kind, _STALE_AFTER["vendor"])
        return date.today() - self.confirmed_on > horizon


class Ledger(BaseModel):
    rows: list[LedgerRow]

    def by_path(self, fetch_path: str) -> Optional[LedgerRow]:
        """Match a code-site fetch path to its ledger row. Longest-prefix wins so
        'api.coingecko.com/api/v3/coins' matches the 'api.coingecko.com' demo row."""
        candidates = [r for r in self.rows if fetch_path.startswith(r.fetch_path) or r.fetch_path in fetch_path]
        return max(candidates, key=lambda r: len(r.fetch_path), default=None)

    def verdict_for(self, fetch_path: str) -> Verdict:
        """The load-bearing default: an UNMATCHED path is RED. Silence is not a licence (§1.4)."""
        row = self.by_path(fetch_path)
        return row.verdict if row else Verdict.RED
```

Three design choices a reviewer will (and should) interrogate:

- **`frozen=True`** — a verdict is immutable once written; a re-confirmation produces a *new row* (new
  `confirmed_on`), it does not mutate the old one. This keeps an audit trail of *when* each verdict held.
- **`verdict_for` defaults to RED on no-match** — this is the single most important line in the file. It is
  the machine form of "silence is not a licence." An un-ledgered path is RED, so the build breaks until a
  human files a row.
- **`governing_clause` rejects placeholders at parse time** — a `TBD`/`unknown` clause can never enter the
  ledger, so a "GREEN" row with no legal basis cannot exist. (This narrows but does not close the
  wrong-but-ledgered hole — a *plausible-but-wrong* clause still parses. §7.)

---

## 2. `/sources-lint` — the CI audit (what it scans, how to run, how to read a failure)

### 2.1 What it is and what it scans for

`/sources-lint` is a repo command ([`.claude/commands/sources-lint.md`](../../../commands/sources-lint.md))
whose single job is: **no `commercialOk:true` whose fetch path lacks a 🟢 GREEN ledger row.** Its procedure,
distilled from the command definition:

1. Grep for every `commercialOk: true` and `commercialOk:true` in the code.
2. For each hit, read enough surrounding context to identify the **fetch path / provider** it describes.
3. Load the ledger; for each hit, find the matching source row.
4. **Flag any hit whose matching row is not 🟢 GREEN** (RED / YELLOW / REJECT / *missing*). Each flag is a
   potential violation of the [commercial-ok gate](../../../rules/commercial-ok-gate.md).
5. Also flag the **inverse drift**: a ledger source used in code that *still says `commercialOk:false`* but
   whose ledger row is 🟢 (a safe *under-claim* worth noting — you are leaving a legal display right on the
   table), and any provider referenced in code with **no ledger row at all** (→ ADD-ROW).
6. Report a short table: `file:line · provider · code says · ledger says · verdict (OK / FIX / ADD-ROW)`,
   ending with the count of FIX-level findings.

> **The default rule, verbatim:** *"Default to RED when a fetch path can't be matched to a ledger row —
> silence is not a license."* ([`sources-lint.md`](../../../commands/sources-lint.md).)

The genius of the design is that it is *bidirectional*. It catches the dangerous error (a gate-true with no
green row → **over-claim** → a licence breach) *and* the wasteful one (a gate-false on a green path →
**under-claim** → you are hiding data you are legally allowed to show). Both are drift from the ledger; the
ledger is the truth, the code is audited against it.

### 2.2 How to run it

In the Lumina repo today it is an **agentic command** (`allowed-tools: Grep, Read, Bash`) — Claude runs the
grep, reads the context, loads the ledger, and reports. That is the right tool when "identify the fetch path
this hit describes" needs judgement (the gate-true might be three lines from the `fetch()` call).

For the DaaS we want it *also* as a **deterministic CI check** that runs with no model in the loop, because
CI must be reproducible and fast. The two are complementary: the deterministic linter is the gate that
*blocks the merge*; the agentic command is the *investigative* tool a human runs to understand a failure or
to do the periodic re-audit (§7). Both walk the same ledger.

The deterministic linter, as a runnable Python script the DaaS CI invokes:

```python
# daas/licensing/sources_lint.py
"""Deterministic licensing linter. Exit 1 (fail CI) on any FIX-level finding.

Scans the codebase for sites that flip the display gate (commercial_ok=True /
commercialOk:true) and asserts each one's fetch_path resolves to a GREEN ledger row.
Default-RED on no match: silence is not a licence.
"""
from __future__ import annotations
import re, sys
from dataclasses import dataclass
from pathlib import Path
from daas.licensing.ledger import Ledger, Verdict, load_ledger  # load_ledger parses the registry

# Match a gate-true in either stack's syntax. We capture the line; the fetch_path is resolved by
# walking UP to the nearest fetch_path=/url=/endpoint= assignment in the same construction.
GATE_TRUE = re.compile(r"commercial_?ok\s*[:=]\s*True\b|commercialOk\s*:\s*true\b")
FETCH_PATH = re.compile(r"""fetch_path\s*[:=]\s*["']([^"']+)["']""")
GATE_FALSE = re.compile(r"commercial_?ok\s*[:=]\s*False\b|commercialOk\s*:\s*false\b")


@dataclass
class Finding:
    file: str; line: int; provider: str; code_says: str; ledger_says: str; verdict: str  # OK|FIX|ADD-ROW|UNDER


def _nearest_fetch_path(lines: list[str], idx: int, window: int = 12) -> str | None:
    # Walk a small window above the gate line for the fetch_path the Provenance was built with.
    for j in range(idx, max(0, idx - window), -1):
        m = FETCH_PATH.search(lines[j])
        if m:
            return m.group(1)
    return None


def lint(root: Path, ledger: Ledger) -> list[Finding]:
    findings: list[Finding] = []
    for path in root.rglob("*.py"):
        if "/tests/" in str(path) or path.name.startswith("test_"):
            continue  # tests legitimately fabricate gate-true fixtures
        lines = path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            is_true = bool(GATE_TRUE.search(line))
            is_false = bool(GATE_FALSE.search(line))
            if not (is_true or is_false):
                continue
            fp = _nearest_fetch_path(lines, i)
            if fp is None:
                # A gate-true with no resolvable fetch path is itself a finding — it can't be audited.
                if is_true:
                    findings.append(Finding(str(path), i + 1, "?", "true", "unresolvable", "FIX"))
                continue
            row = ledger.by_path(fp)
            ledger_verdict = row.verdict if row else None
            if is_true:
                if ledger_verdict is None:
                    findings.append(Finding(str(path), i + 1, fp, "true", "MISSING", "ADD-ROW"))
                elif ledger_verdict is Verdict.REJECT:
                    findings.append(Finding(str(path), i + 1, fp, "true", "REJECT", "FIX"))  # hardest fail
                elif not ledger_verdict.clears_gate:  # RED or YELLOW
                    findings.append(Finding(str(path), i + 1, fp, "true", ledger_verdict.value, "FIX"))
                else:  # GREEN
                    findings.append(Finding(str(path), i + 1, fp, "true", "GREEN", "OK"))
            else:  # gate-false — flag the safe UNDER-claim (green row, false in code)
                if ledger_verdict is Verdict.GREEN:
                    findings.append(Finding(str(path), i + 1, fp, "false", "GREEN", "UNDER"))
    return findings


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("daas")
    ledger = load_ledger(Path("daas/licensing/ledger.registry.json"))
    findings = lint(root, ledger)
    fix = [f for f in findings if f.verdict in {"FIX", "ADD-ROW"}]
    under = [f for f in findings if f.verdict == "UNDER"]
    for f in findings:
        if f.verdict != "OK":
            print(f"{f.verdict:8} {f.file}:{f.line}  path={f.provider!r}  code={f.code_says}  ledger={f.ledger_says}")
    print(f"\n{len(fix)} FIX-level finding(s); {len(under)} under-claim(s) noted.")
    return 1 if fix else 0   # exit 1 => CI fails (the gate)


if __name__ == "__main__":
    raise SystemExit(main())
```

This is the same exit-code contract every policy-as-code gate uses: **a violation sets exit 1, which aborts
the CI job.** It is precisely how OPA's `--fail` / `--fail-defined` flags and conftest's `deny` rules work —
"the simplest model treats policy evaluation like a unit test: if the policy fails, the pipeline fails"
([Open Policy Agent, "Using OPA in CI/CD Pipelines"](https://www.openpolicyagent.org/docs/cicd), fetched
2026-06-24). §3 shows the OPA/conftest variant for teams that prefer Rego policy over a bespoke script.

### 2.3 How to read a failure

A `/sources-lint` run prints a table; each non-OK row is one of three findings, and each has a different
fix:

| Finding | Means | The fix |
|---|---|---|
| **FIX** (gate-true, ledger RED/YELLOW) | The code displays a series the ledger says is not displayable. **A live licence breach.** | Flip the gate to `false` (and render attribution if you keep showing it informationally), OR buy a display tier and re-ledger the path GREEN — *then* the gate may be true. Never edit the ledger to GREEN to silence the lint without re-reading the ToS. |
| **FIX** (gate-true, ledger **REJECT**) | The code touches a source the ToS forbids touching. **Hardest fail.** | *Remove the integration.* REJECT is not "gate it false" — the source doesn't enter the codebase (Kalshi). |
| **FIX** (gate-true, fetch path unresolvable) | A gate-true the linter can't tie to a path — un-auditable, therefore presumed unsafe. | Refactor so the `Provenance` is built at the fetcher with an explicit `fetch_path`, so the gate is always auditable. |
| **ADD-ROW** (gate-true, no matching row) | A source displayed before it was ledgered — violates "add the row before shipping." | Read the live ToS, file the verdict, add the row. If the verdict is not GREEN, *also* flip the gate false. |
| **UNDER** (gate-false, ledger GREEN) | A safe under-claim — you are hiding data you may legally show. | Optional: flip the gate true to surface the data. Not a breach; logged for awareness. |

> **The cardinal anti-pattern (and why a human stays in the loop):** the *wrong* way to clear a FIX is to
> open the ledger and change the row to GREEN. The linter will then pass — but you have laundered a RED path
> into a fake GREEN verdict. The linter cannot tell a *correct* GREEN from a *fabricated* one (§7); only a
> human re-reading the ToS can. The lint enforces *consistency between code and ledger*; it does **not**
> validate the ledger against reality. Editing the ledger to silence the lint is the exact move the
> red-team negation loop's F2 is built to catch.

### 2.4 Wiring it into CI

```yaml
# .github/workflows/licensing.yml  (DaaS)
name: licensing-gate
on: [pull_request, push]
jobs:
  sources-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6      # the DaaS uses uv (see python-fastapi-data-service skill)
      - run: uv sync --frozen
      - name: sources-lint (block on FIX/ADD-ROW)
        run: uv run python -m daas.licensing.sources_lint daas
      - name: catalog audit (every Distribution has a ledgered path)
        run: uv run python -m daas.licensing.catalog_audit   # §6.3
      - name: ledger staleness (warn-only)
        run: uv run python -m daas.licensing.staleness || true   # never blocks; just surfaces stale rows
```

The first two steps **block the merge** (exit 1 fails the job); the staleness step is `|| true` so it
*warns without blocking* — a stale verdict is presumed still valid, it just needs a re-read scheduled.

---

## 3. The policy-as-code variant (OPA / conftest over a provenance manifest)

A team that already runs policy-as-code may prefer to express the gate as a **Rego policy** rather than a
bespoke script — same mechanism, industry-standard tooling. The pattern: the build emits a **provenance
manifest** (every series the product will serve, with its `fetch_path` + `commercial_ok` + `ledger_row`),
and conftest evaluates it against the licence policy.

The manifest (a build artifact, one object per displayed series):

```json
// build/provenance-manifest.json
{
  "series": [
    { "id": "ust-10y", "fetch_path": "home.treasury.gov/daily-treasury-rates.xml",
      "commercial_ok": true,  "ledger_row": "treasury-par-yield" },
    { "id": "spx-idx", "fetch_path": "query1.finance.yahoo.com/v8/finance/chart/^GSPC",
      "commercial_ok": true,  "ledger_row": null }
  ]
}
```

The policy (Rego) — and a *data document* derived from the ledger so the policy knows which rows are GREEN:

```rego
# policy/licensing.rego
package licensing

import rego.v1

# data.ledger is generated from ledger.registry.json: { "<row_id>": "GREEN"|"RED"|... }

# A displayed series is a violation when commercial_ok is true but its ledger_row is
# missing, unknown, or not GREEN. Default-RED: an unknown row_id is NOT green.
deny contains msg if {
    some s in input.series
    s.commercial_ok == true
    not _is_green(s.ledger_row)
    msg := sprintf("series %q sets commercial_ok=true but ledger_row=%v is not GREEN (path=%q)",
                   [s.id, s.ledger_row, s.fetch_path])
}

_is_green(row) if {
    row != null
    data.ledger[row] == "GREEN"
}
```

Run it in CI:

```bash
# conftest's `deny` rules return a non-zero exit on any violation → CI fails.
conftest test build/provenance-manifest.json \
  --policy policy/ \
  --data ledger.registry.json
# FAIL - build/provenance-manifest.json - series "spx-idx" sets commercial_ok=true but
#        ledger_row=null is not GREEN (path="query1.finance.yahoo.com/...")
```

conftest is "a testing utility built on OPA that validates structured configuration files against policies
written in Rego … it is important that the job aborts the build if conftest reports a violation"
([Open Policy Agent CI/CD docs](https://www.openpolicyagent.org/docs/cicd); the `deny`-rule + non-zero-exit
pattern is the canonical conftest gate). The advantage over the bespoke script: the *policy* is
declarative, version-controlled, and unit-testable in Rego; the disadvantage: it audits a *manifest* the
build emits, so you must also trust the build to emit a faithful manifest (the bespoke linter audits the
*source* directly, which is harder to fool). **Use both:** the source linter (§2) for the gate-true sites,
the manifest policy (§3) for the assembled-product invariant.

---

## 4. The PreToolUse hook — the human-in-the-loop checkpoint

### 4.1 What it does

`precheck-licensing.mjs` is a **PreToolUse hook** wired in `settings.json` on the `Write|Edit` matcher
([`.claude/hooks/README.md`](../../../hooks/README.md)). It fires *before* every file write/edit and
inspects the text being introduced. Verbatim from the source
([`.claude/hooks/precheck-licensing.mjs`](../../../hooks/precheck-licensing.mjs)):

- It reads the hook stdin payload, pulls `tool_input.content` (Write) or `tool_input.new_string` (Edit) as
  the **text being introduced**.
- **Rule 1 — real `.env` writes → `ask`.** If the path matches `/\.env(\.[A-Za-z0-9]+)?$/` and is *not*
  `.env.example`, it emits a `permissionDecision: "ask"` — the operator must confirm. (Keeps secrets out of
  git.)
- **Rule 2 — introducing `commercialOk:true` → nudge.** If the added text matches
  `/commercialOk\s*:\s*true/`, it emits a non-blocking `systemMessage`:

  > *"⚠️ This edit sets commercialOk:true. The license attaches to the FETCH PATH, not the concept — verify
  > it has a 🟢 GREEN row in .claude/memory/sources-ledger.md (public-domain / CC0 / CC-BY, or a purchased
  > display tier). A free API tier is NOT a display license. If there is no GREEN row, keep it false."*

- **Fail-open by design.** On any parse error it `allow()`s (exit 0, no output). A licensing *nudge* must
  never spuriously *block real work* — its job is to prompt a thought, not to gate. (Contrast the CI lint,
  which *does* block — different layer, different risk posture.)

The README documents the manual test:

```bash
# Should nudge:
echo '{"tool_name":"Edit","tool_input":{"file_path":"x.ts","new_string":"commercialOk: true"}}' \
  | node .claude/hooks/precheck-licensing.mjs
# Should be silent (exit 0, no output):
echo '{"tool_name":"Edit","tool_input":{"file_path":"x.ts","new_string":"const a = 1"}}' \
  | node .claude/hooks/precheck-licensing.mjs
```

### 4.2 Why a *nudge*, not a *block* — the layering

This is the most important design decision in the whole enforcement stack, and a reviewer will test it:
**the hook nudges (non-blocking); the CI lint blocks.** They sit at *different moments* with *different
costs of a false positive*:

| Layer | Moment | Action | Why this strength |
|---|---|---|---|
| **PreToolUse hook** | At the keyboard, *as the edit is typed* | **Nudge** (or `ask` for `.env`) | A false positive here would block *legitimate* gate-true edits (a genuinely GREEN path) — high friction, low value. The nudge *informs* the engineer to check the ledger *now*, while the context is hot, costing nothing if they already did. |
| **CI lint** | At commit/merge | **Block** (exit 1) | By now the edit is complete and reviewable; a false positive is cheap (re-run after fixing the ledger). The block is the *backstop* that catches the edit the engineer made *despite* the nudge (or with the hook disabled). |

The two are complementary precisely because they fail differently. The hook is a *reminder a human can act
on in the moment*; the lint is a *gate a human cannot bypass by ignoring a message.* A nudge that blocked
would train engineers to disable the hook; a lint that only nudged would let the breach merge. Each is the
right strength for its moment.

### 4.3 Porting the hook to the DaaS toolchain

The DaaS is Python/FastAPI, not a Claude-Code harness — but the *checkpoint at the keyboard* concept ports
directly to a **pre-commit hook** (the git-native equivalent of "before the change lands"):

```yaml
# .pre-commit-config.yaml  (DaaS)
repos:
  - repo: local
    hooks:
      - id: licensing-nudge
        name: licensing nudge (commercial_ok=True)
        entry: python tools/licensing_nudge.py
        language: python
        types: [python]
        # NON-blocking by intent: it warns, but stage `verbose: true` and exit 0 so it never blocks a commit.
        verbose: true
```

```python
# tools/licensing_nudge.py  — the pre-commit analogue of precheck-licensing.mjs
import re, sys
GATE = re.compile(r"commercial_?ok\s*=\s*True\b")
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if GATE.search(line):
                print(f"⚠️  {path}:{n} sets commercial_ok=True. The licence attaches to the FETCH PATH, "
                      "not the concept — verify a GREEN row in daas/licensing/ledger.registry.json. "
                      "A free API tier is NOT a display licence; if no GREEN row, keep it False.")
sys.exit(0)   # NUDGE, not block — the CI sources_lint (§2) is the blocking gate.
```

The split is preserved: pre-commit *nudges* at the keyboard, CI *blocks* at the merge. The `.env` →
`ask` rule ports to a *blocking* pre-commit hook (e.g. `detect-secrets` / a `.env`-path guard) because a
committed secret, unlike a gate-true, has no legitimate version of itself.

---

## 5. The enforcement loop, end to end

Putting §1–§4 together: the gate is enforced at **three moments by three independent mechanisms**, so a
single miss is always backstopped.

```
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │  MOMENT 1 — the keyboard                                                          │
 │  Engineer edits a fetcher, sets Provenance(..., commercial_ok=True)              │
 │       │                                                                          │
 │       ▼                                                                          │
 │  PreToolUse hook / pre-commit NUDGE:                                              │
 │  "⚠️ licence attaches to the FETCH PATH — verify a GREEN ledger row."            │
 │       │  (non-blocking — informs, does not gate)                                 │
 └───────┼──────────────────────────────────────────────────────────────────────────┘
         ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │  MOMENT 2 — construction time (runtime, even before CI)                          │
 │  Provenance(commercial_ok=True, ledger_row=None)  →  RAISES at construction      │
 │  (the model validator: "commercial_ok=True without a ledger_row is illegal")     │
 │       │  so a gate-true that names NO row cannot even be built                    │
 └───────┼──────────────────────────────────────────────────────────────────────────┘
         ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │  MOMENT 3 — the merge (CI)                                                        │
 │  sources_lint walks every gate-true → resolves fetch_path → ledger.by_path()     │
 │       │                                                                          │
 │       ├── ledger row is GREEN  ───────────────►  OK, merge proceeds              │
 │       ├── ledger row RED/YELLOW/REJECT ───────►  FIX  →  exit 1, BLOCK merge     │
 │       └── no ledger row (default-RED) ────────►  ADD-ROW → exit 1, BLOCK merge   │
 └─────────────────────────────────────────────────────────────────────────────────┘
         ▲
         │  to make CI green, the engineer must FIRST add a GREEN ledger row
         │  (which requires reading the live ToS) — "add the row before shipping."
         └──────────────────────────────────────────────────────────────────────────
```

Stated as a sentence (the §0 summary, expanded): **an edit sets the gate → the hook nudges the engineer to
check the ledger → the typed model refuses a gate-true with no ledger anchor → CI lint blocks the merge if
the anchored row is not GREEN → the only way to turn CI green is to file a GREEN row first, which forces a
ToS read.** Three checks, three moments, fail-closed at every one.

### 5.1 Why three and not one

Each mechanism has a hole the next one covers:

- The **hook** can be disabled, or the engineer can ignore the nudge. → caught by the lint.
- The **typed validator** only fires if the code path that builds the `Provenance` actually runs in the
  test suite; a gate-true assembled in a config blob the tests never construct could slip it. → caught by
  the lint, which reads source, not runtime.
- The **lint** can be fooled by a *fabricated GREEN row* (the wrong-but-ledgered hole, §7). → caught by the
  human re-audit and the red-team loop, *not* by another machine.

This is defence in depth. No single layer is trusted to be complete; the *composition* is what makes the
common failure impossible.

### 5.2 The two gates are orthogonal — both must pass

A reminder that surfaces throughout this skill: **licensing-provenance and numeric-grounding are
independent gates.** A GREEN source can still hand you a *wrong number* — SEC EDGAR (public-domain GREEN)
XBRL `frames` returns *"duplicate/non-comparable facts"*, and a GREEN-but-wrong number still violates "never
invent a finance number" ([`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md) SEC EDGAR
row). The licensing lint clears *display rights*; a separate grounding gate clears *correctness*. Passing
`/sources-lint` says nothing about whether the number is right — that is a different check, and both must
pass before a series is served.

---

## 6. Extending the discipline to the DaaS catalog

The DaaS is a *data product*: a **catalog** of Datasets, each with one or more **Distributions** (a
Distribution = a concrete delivery of a dataset through a specific access path — the DCAT term). Licensing
in a catalog is *per-Distribution*, because the same dataset can be distributed through a GREEN path and a
RED one. This section makes the per-row gate a *per-Distribution* gate that the lint can walk catalog-wide.

### 6.1 The model: a `license` field on every Distribution

```python
# daas/catalog/models.py
from __future__ import annotations
from pydantic import BaseModel, Field, model_validator
from daas.licensing.ledger import Ledger, Verdict


class Distribution(BaseModel):
    """One concrete way to obtain a Dataset (DCAT dcat:Distribution). The licence attaches HERE —
    to the access path — not to the abstract Dataset."""
    dist_id: str
    dataset_id: str
    fetch_path: str = Field(..., description="The exact upstream door this distribution is sourced from.")
    ledger_row: str = Field(..., description="REQUIRED. Anchor into the sources-ledger. No un-ledgered distribution.")
    commercial_ok: bool = Field(default=False, description="THE GATE — derived from the ledger verdict, never hand-set.")

    @model_validator(mode="after")
    def _gate_must_derive_from_ledger(self) -> "Distribution":
        # The gate is DERIVED, not asserted: a Distribution may not claim commercial_ok=True
        # by hand. It must be set by `bind_to_ledger` below, which reads the verdict.
        if self.commercial_ok and not self.ledger_row:
            raise ValueError("commercial_ok=True requires a ledger_row (§1.4).")
        return self


def bind_to_ledger(dist: Distribution, ledger: Ledger) -> Distribution:
    """The ONLY sanctioned way to set commercial_ok on a Distribution: derive it from the ledger
    verdict for the distribution's ledger_row. Hand-setting the gate is forbidden (the validator
    allows true only WITH a row; this makes the value itself ledger-derived)."""
    row = next((r for r in ledger.rows if r.row_id == dist.ledger_row), None)
    if row is None:
        # An un-ledgered distribution is RED by default — silence is not a licence.
        return dist.model_copy(update={"commercial_ok": False})
    if row.fetch_path not in dist.fetch_path and dist.fetch_path not in row.fetch_path:
        raise ValueError(
            f"distribution {dist.dist_id} fetch_path={dist.fetch_path!r} does not match its ledger row "
            f"{row.row_id!r} (path={row.fetch_path!r}) — the anchor must point at the SAME door."
        )
    return dist.model_copy(update={"commercial_ok": row.verdict.clears_gate})
```

The key move: **`commercial_ok` is derived, never asserted.** A Distribution cannot *claim* it is
displayable; it can only *inherit* the verdict of its ledgered fetch path via `bind_to_ledger`. That single
choice removes the entire class of "engineer hand-set the gate true" bug — there is no supported code path
that sets the gate true except reading a GREEN ledger row.

### 6.2 The DaaS ledger row (the four legal columns + operational columns)

The DaaS `LedgerRow` (§1.6) already carries the four legal columns plus `confirmed_on`, `spdx`, and
`attribution`. The DaaS adds one more: a back-reference so the *catalog audit* (§6.3) can walk
ledger → distributions and assert coverage. In practice the link is by `row_id` (a Distribution names its
row; a row need not name its Distributions), which keeps the ledger the *source* and the catalog the
*consumer*.

### 6.3 The catalog-level audit — "every Distribution has a ledgered fetch path"

The per-site lint (§2) catches gate-trues in *code*. The catalog audit catches the *structural* invariant:
**no Distribution may be published without a ledger anchor whose verdict matches its gate.** It walks the
whole catalog, not the code:

```python
# daas/licensing/catalog_audit.py
"""Catalog-wide licensing audit. Asserts EVERY published Distribution:
  (1) names a ledger_row,
  (2) that row EXISTS in the ledger,
  (3) the row's fetch_path matches the distribution's door,
  (4) the gate value EQUALS the row's verdict (no over- or under-claim),
  (5) the row is not REJECT (a REJECT distribution must not be in the catalog at all).
Exit 1 on any breach → blocks the catalog publish.
"""
from __future__ import annotations
import sys
from daas.catalog.repo import all_published_distributions   # reads the live catalog
from daas.licensing.ledger import load_ledger, Verdict


def audit() -> int:
    ledger = load_ledger_index()              # { row_id -> LedgerRow }
    breaches: list[str] = []
    for dist in all_published_distributions():
        row = ledger.get(dist.ledger_row)
        if row is None:
            breaches.append(f"{dist.dist_id}: ledger_row={dist.ledger_row!r} not found (un-ledgered → RED).")
            continue
        if row.verdict is Verdict.REJECT:
            breaches.append(f"{dist.dist_id}: ledger row is REJECT — this distribution must not be published.")
        if row.fetch_path not in dist.fetch_path and dist.fetch_path not in row.fetch_path:
            breaches.append(f"{dist.dist_id}: door mismatch — dist={dist.fetch_path!r} vs row={row.fetch_path!r}.")
        if dist.commercial_ok != row.verdict.clears_gate:
            breaches.append(
                f"{dist.dist_id}: gate={dist.commercial_ok} disagrees with ledger verdict={row.verdict.value} "
                "(re-bind via bind_to_ledger; never hand-set the gate)."
            )
    for b in breaches:
        print("BREACH:", b)
    print(f"\n{len(breaches)} catalog licensing breach(es).")
    return 1 if breaches else 0


if __name__ == "__main__":
    raise SystemExit(audit())
```

This audit is the structural twin of the source lint. The source lint asks *"does every gate-true in the
code have a green row?"*; the catalog audit asks *"does every shipping product surface (Distribution) have a
ledger anchor that agrees with its gate?"* Both run in CI; both block.

### 6.4 Walking composites — the contamination rule, mechanised

A composite Distribution (an index, a blend, an AI-briefing) declares its **inputs**; its effective verdict
is the **most restrictive** input verdict — SPDX `AND` (conjunctive) semantics. The walk:

```python
# daas/licensing/composite.py
from daas.licensing.ledger import Verdict

# Restrictiveness order: REJECT > RED > YELLOW > GREEN (most → least restrictive).
_RANK = {Verdict.REJECT: 3, Verdict.RED: 2, Verdict.YELLOW: 1, Verdict.GREEN: 0}


def composite_verdict(input_verdicts: list[Verdict]) -> Verdict:
    """A composite inherits the MOST RESTRICTIVE input verdict (the contamination rule).
    This is SPDX 'AND' semantics: you must SIMULTANEOUSLY comply with every input's licence,
    so the binding constraint is the strictest one. A GREEN-and-RED composite is RED."""
    if not input_verdicts:
        return Verdict.RED                       # no inputs declared → cannot prove GREEN → RED
    return max(input_verdicts, key=lambda v: _RANK[v])


# Worked: an "AI market briefing" over [Treasury(GREEN), GDELT(GREEN), Yahoo(RED)] → RED.
# Even one RED input contaminates the whole composite; its gate MUST be False.
```

The justification is the SPDX grammar itself: a conjunctive (`AND`) expression means *"required to
simultaneously comply with two or more licenses"* ([SPDX 3.0.1 license-expressions
annex](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/)) — so the binding
constraint is the *strictest* member, exactly `max` over restrictiveness. The catalog audit (§6.3) runs
`composite_verdict` over each composite's declared inputs and asserts the composite's gate equals the
result. This is the mechanised form of the red-team F2 contamination hunt: *"a composite that inherits a
RED input yet claims GREEN."* The PROV-O `wasDerivedFrom` edges
([`theory-prov-o-lineage-model.md`](theory-prov-o-lineage-model.md)) are exactly the input declarations the
walk consumes — lineage is what makes contamination *queryable*.

### 6.5 Staleness as a catalog check

`LedgerRow.is_stale` (§1.6) drives a warn-only CI step that lists every row whose `confirmed_on` is past its
horizon (180d vendor / 365d statute):

```python
# daas/licensing/staleness.py  — WARN only; never blocks (a stale verdict is presumed still valid)
from daas.licensing.ledger import load_ledger
def main() -> int:
    stale = [r for r in load_ledger().rows if r.is_stale]
    for r in stale:
        print(f"STALE: {r.row_id} (confirmed {r.confirmed_on}, {r.clause_kind}) — re-read the live ToS.")
    print(f"{len(stale)} stale row(s) to re-confirm.")
    return 0   # warn-only
```

This is the operational answer to the JPM theory's **open-question #6** — *"20+ sources × hundreds of
datasets needs a maintained ledger + CI lint … Appetite to automate license classification, or keep it
manual per fetch-path?"*
([`.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md),
open-question #6). The answer this skill gives: **automate the *bookkeeping and consistency* (the ledger +
lint + staleness + catalog audit), keep the *classification verdict* human.** A machine can guarantee every
gate-true names a green row and every row gets re-read on a cadence; it cannot read a novel ToS and decide
GREEN vs RED (§7). The automation makes the human's job *small and scheduled* (re-read the stale rows;
classify the new sources) instead of *large and continuous* (audit every gate-true by hand).

### 6.6 The falsifiability test — "disconnect the upstreams"

The strongest test of the whole discipline is a **falsifiability experiment** the JPM theory and the
red-team loop both demand: *cut off every upstream feed and assert that every series the product still
displays can name a GREEN ledgered fetch path.* If a number survives the disconnect with a `commercial_ok:
true` and no green-ledgered origin, the discipline has a hole.

```python
# daas/licensing/falsifiability_test.py  (a CI/integration test, not a runtime path)
"""Falsifiability test: every DISPLAYED series must trace to a GREEN ledgered path.
Procedure:
  1. Point all upstream fetchers at a dead host (force every live fetch to fail).
  2. Render every catalog surface that would show a commercial_ok=True series.
  3. Assert each such series' Provenance.ledger_row resolves to a GREEN ledger row,
     and that NO displayed number was backfilled (a failed fetch must yield typed
     `unavailable`, never a fabricated value).
The test FAILS if any displayed commercial series cannot cite a GREEN ledgered origin.
"""
import pytest
from daas.catalog.render import displayed_series         # what the product would actually show
from daas.licensing.ledger import load_ledger_index, Verdict


@pytest.mark.integration
def test_every_displayed_series_traces_to_green_ledger(disconnect_all_upstreams):
    ledger = load_ledger_index()
    for series in displayed_series():
        if not series.provenance.commercial_ok:
            continue                                      # gated-false series are fine; not on a commercial surface
        row = ledger.get(series.provenance.ledger_row)
        assert row is not None, f"{series.id}: commercial display with NO ledger row (un-traceable origin)."
        assert row.verdict is Verdict.GREEN, f"{series.id}: commercial display from a non-GREEN row {row.row_id}."
        assert series.values_are_grounded, f"{series.id}: displayed values not grounded (backfill on a dead fetch?)."
```

This test operationalises the data-lineage principle that *"downstream consumers can validate claims about
data … bound to released artifacts"* — provenance integrated into the operational life-cycle so every
released output is traceable to an authorised origin
([Netskope / data-lineage survey, "What is Data Lineage?"](https://www.netskope.com/security-defined/what-is-data-lineage),
fetched 2026-06-24; the GDPR "right to be forgotten" operationalisation is the same recursive-trace
mechanism applied to deletion). It is the *product-level* version of `/sources-lint`: the lint proves
*code* is consistent with the ledger; the falsifiability test proves *the rendered product* is. A series
that displays commercially but cannot survive the disconnect with a GREEN-ledgered origin is, by definition,
either mis-licensed or ungrounded — both ship-blockers.

---

## 7. What lint CANNOT catch — and why a human re-audit stays in the loop

The enforcement stack makes the *common* mistake (a gate-true with no green row) **mechanically impossible
to merge**. It does **not** make licensing safe, because three failure modes are invisible to every machine
check, and pretending otherwise is the exact "polished-junior" tell the red-team loop hunts.

### 7.1 A wrong-but-ledgered verdict

The lint proves *code is consistent with the ledger*. It cannot prove *the ledger is consistent with
reality.* If a human (or a sloppy classifier) files a row that *says* `GREEN` for a path that is *legally*
RED — misread the ToS, missed a non-commercial clause, mistook a free tier for a display tier — every machine
check passes and the product ships a breach with a green CI. This is *precisely* the SBOM declared-vs-concluded
gap: ScanCode and friends achieve high *detection* accuracy but *"implementation requires human oversight in
establishing compliance policies"* and produce *"a list of ambiguous detections … to review"*
([ScanCode license-detection reference, via Aikido's scanner survey](https://scancode-toolkit.readthedocs.io/en/latest/reference/license-detection-reference.html);
[Aikido, "Open Source License Scanners"](https://www.aikido.dev/learn/devsecops/software-security-tools/license-scanning),
fetched 2026-06-24). The *concluded* verdict is a human judgement; a tool can detect a *declared* licence
string but cannot adjudicate a silent/ambiguous ToS — and a silent ToS is RED *by policy*, a call no parser
makes.

**Mitigation:** the ledger's `governing_clause`-with-citation requirement (§1.6 rejects placeholder
clauses), the `confirmed_on` staleness re-read cadence (§6.5), and — the real backstop — the **periodic human
re-audit** running the *agentic* `/sources-lint` (§2.2) plus a fresh ToS read for any row touched, and the
**red-team negation loop F2** which is built to *prove* "a displayed series is mis-licensed … a free tier
treated as a display licence" ([`.claude/rules/red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md),
F2). F2's whole purpose is to attack the ledger's *verdicts*, not just the code's consistency with them — the
one thing the lint cannot do.

### 7.2 An un-rendered attribution

CC-BY / ODC-BY / conditioned-GREEN (GDELT) are GREEN *only with the attribution rendered on the surface*.
The ledger row can carry the attribution string (§1.6 even *requires* it for CC-BY), and the lint can assert
the string *exists in the payload* — but **the lint cannot see the screen.** Whether the attribution
actually *renders* (vs sitting in a JSON field a React component never reads, or being clipped off a chart)
is a *rendering* fact no static check on the data plane observes. GDELT's licence is explicit that the
citation *"must render on every surface that displays it, not just sit in the payload"*
([`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md) GDELT row) — and "renders on the
surface" is a *frontend* assertion.

**Mitigation:** a *visual* test (a frontend/integration test that asserts the attribution element is
present and visible on every surface showing a CC-BY/conditioned series) plus human review of new surfaces.
This is a different test layer (DOM/visual), not the data-plane lint — and the red-team F2 explicitly hunts
"the attribution rendered where the ToS requires it."

### 7.3 A REJECT source fetched-to-inform but never displayed

The lint keys on `commercial_ok=True`. A REJECT source (Kalshi) whose ToS bans *even fetching/caching/AI
use* but which an engineer wires in *without* a gate-true — to "just inform the model" — has *no gate-true to
flag*, so the source lint is silent. The catalog audit catches it only if it became a Distribution. A REJECT
source used purely as a transient model input is invisible to both.

**Mitigation:** the lint must *also* scan for the **fetch path itself**, not just the gate — a denylist of
REJECT `fetch_path`s that fails CI on *any* reference, gate or no gate (§5, "REJECT anywhere is a remove-it
finding"). And the human re-audit must check *every integration*, not just every gate-true.

### 7.4 Why the human stays — stated plainly

| The machine guarantees | The human still owns |
|---|---|
| Every gate-true names a row (typed model). | Whether that row's *verdict* is legally correct. |
| Every named row exists and is GREEN (lint). | Reading a *novel* ToS and deciding GREEN vs RED. |
| Every Distribution has a ledger anchor (catalog audit). | Whether a silent/ambiguous ToS was correctly read as RED. |
| Every composite's gate equals its inputs' min (composite walk). | Whether all the *real* inputs were declared (an undeclared input contaminates silently). |
| Stale rows are surfaced on a cadence (staleness). | Actually re-reading the live ToS for a stale row. |
| No displayed series lacks a GREEN origin (falsifiability test). | Whether the attribution *visibly renders* on each surface. |

The automation's value is not that it *replaces* the licence lawyer — it is that it shrinks the human's job
from *"audit every data display, continuously, by hand"* (un-scalable at 200 datasets) to *"classify each
new source once, and re-read each row on a cadence"* (scalable, scheduled, small). That is the honest answer
to open-question #6: **automate the bookkeeping to near-total coverage; keep the classification judgement and
the rendering check human, because they are the two things no static check on the data plane can perform.**

---

## 8. Checklists

### 8.1 Adding a new source to the DaaS (the happy path)

1. **Read the live ToS** of the exact fetch path (host + endpoint + account tier). Silent/ambiguous on
   commercial display/redistribution → **RED** (not GREEN).
2. **File the ledger row** (`row_id`, `source`, `fetch_path`, `verdict`, `governing_clause` *with the
   instrument cited*, `confirmed_on=today`, `clause_kind`, `spdx`, `attribution` if CC-BY/conditioned). The
   typed `LedgerRow` validator rejects a placeholder clause.
3. **Wire the fetcher** to build its `Provenance`/`Distribution` with `ledger_row=<the row_id>` and let
   `bind_to_ledger` *derive* `commercial_ok` from the verdict — never hand-set the gate.
4. **Run `sources_lint`** locally; it should report `OK` (GREEN) or `FIX`/`ADD-ROW` (re-check step 2).
5. **Run `catalog_audit`** if you registered a Distribution.
6. Commit. The pre-commit nudge fires on the gate-true; CI's lint + catalog audit + falsifiability test
   gate the merge.

### 8.2 Reviewing a `/sources-lint` failure

- `FIX` (RED/YELLOW) → flip the gate false (and attribute if still shown informationally), or buy + re-ledger
  a display tier. **Do not** edit the row to GREEN to silence the lint.
- `FIX` (REJECT) → *remove the integration entirely.*
- `ADD-ROW` → read the ToS, file the verdict; if not GREEN, also flip the gate false.
- `UNDER` (gate-false on a GREEN row) → optional; you may surface the data. Not a breach.

### 8.3 The periodic human re-audit (the §7 backstop)

- Run the *agentic* `/sources-lint` over the whole repo.
- Re-read the live ToS for every **stale** row (from `staleness.py`) and every row touched since last audit.
- Eyeball every CC-BY/conditioned surface: does the attribution **visibly render**?
- Scan for any **REJECT** `fetch_path` referenced *anywhere* (gate or no gate).
- Run the red-team negation loop **F2** against the highest-traffic surfaces — *try to prove* a displayed
  series is mis-licensed.

---

## 9. Cross-references

- **The principle this enforces:** [`theory-commercialok-fetch-path-licensing.md`](theory-commercialok-fetch-path-licensing.md)
  — the fetch-path doctrine, the four GREEN bases, and the `Provenance` model whose `ledger_row` anchor this
  lint walks (§10 of that doc is the runnable model).
- **The licence taxonomy the verdicts come from:** [`theory-open-data-licenses.md`](theory-open-data-licenses.md)
  — the CC/ODC/PD families, SPDX ids, and the share-alike viral trap (a YELLOW the lint must treat as
  non-clearing).
- **The lineage edges the composite walk consumes:** [`theory-prov-o-lineage-model.md`](theory-prov-o-lineage-model.md)
  — `wasDerivedFrom` is what makes contamination (§6.4) a queryable graph fact.
- **The live ledger this skill formalises:** [`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md).
- **The command:** [`.claude/commands/sources-lint.md`](../../../commands/sources-lint.md).
- **The hook:** [`.claude/hooks/precheck-licensing.mjs`](../../../hooks/precheck-licensing.mjs) +
  [`.claude/hooks/README.md`](../../../hooks/README.md).
- **The rule + its Enforcement section:** [`.claude/rules/commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md).
- **The red-team hunt that targets this skill's blind spots:** [`.claude/rules/red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md)
  — F2 (mis-licence / contamination), F1 (ungrounded number), F5 (wrong layer).
- **The open question this answers:** [`financial-data-analytics-service/00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  open-question #6 (automate licence classification at scale).

---

## 10. Sources

Primary docs and library source read for this reference (fetched 2026-06-24):

- **Open Policy Agent — Using OPA in CI/CD Pipelines** — the `--fail` / `--fail-defined` exit-code gate, the
  "policy fails ⇒ pipeline fails" model, and conftest-for-config-files recommendation.
  https://www.openpolicyagent.org/docs/cicd
- **conftest (open-policy-agent/conftest)** — the `deny`-rule + non-zero-exit CI gate pattern.
  https://github.com/open-policy-agent/conftest
- **CycloneDX — Legal & Compliance: Open Source Licensing** — the `acknowledgement` (`declared` /
  `concluded`) + `evidence.licenses` (observed) model; SPDX `id` / `expression` / `name` license fields.
  The SBOM analogue of the ledger's concluded-verdict design and the declared-vs-concluded gap (§7.1).
  https://cyclonedx.org/use-cases/open-source-licensing/
- **SPDX Specification 3.0.1 — Annex B: License Expressions** — the ABNF grammar; precedence `+ > WITH > AND
  > OR`; `AND` = conjunctive ("simultaneously comply with two or more licenses") = the contamination rule's
  most-restrictive-wins semantics (§1.3, §6.4).
  https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/
- **ScanCode-Toolkit — License Detection Reference** + **Aikido, "Open Source License Scanners"** — automated
  detection is high-accuracy but produces "ambiguous detections to review" and "requires human oversight in
  establishing compliance policies" → the wrong-but-ledgered / human-stays-in-loop argument (§7).
  https://scancode-toolkit.readthedocs.io/en/latest/reference/license-detection-reference.html ·
  https://www.aikido.dev/learn/devsecops/software-security-tools/license-scanning
- **OpenLineage — Column Level Lineage Dataset Facet** — the `inputFields`→output-field facet that backs
  per-column contamination tracing (the standards anchor for §6.4's input declarations).
  https://openlineage.io/docs/spec/facets/dataset-facets/column_lineage_facet/
- **Netskope, "What is Data Lineage?"** — provenance bound to released artifacts so every output is traceable
  to an authorised origin; the GDPR "right to be forgotten" recursive-trace = the falsifiability test's
  mechanism (§6.6).
  https://www.netskope.com/security-defined/what-is-data-lineage

In-repo sources (read this run): `.claude/hooks/precheck-licensing.mjs`, `.claude/hooks/README.md`,
`.claude/commands/sources-lint.md`, `.claude/rules/commercial-ok-gate.md`,
`.claude/rules/red-team-negation-loop.md`, `.claude/memory/sources-ledger.md`,
`.claude/skills/data-provenance-licensing/references/theory-commercialok-fetch-path-licensing.md`,
`.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md`.
