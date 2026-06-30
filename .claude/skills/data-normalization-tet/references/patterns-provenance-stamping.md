# patterns · Stamping provenance + the `commercialOk` verdict on every normalized batch

> **Product line.** This reference belongs to the **`data-normalization-tet` dev-skill** of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina**. That line is a *separate*
> product (the DataQuery / Fusion re-engineering), built on a **new Python / FastAPI / data-engineering
> stack**, not Lumina's Bun + Express + Prisma + Supabase + Upstash stack. Nothing here is wired into
> Lumina's runtime; the two repos only share a filesystem home for the research
> ([`cto-rules.md`](../../../rules/cto-rules.md) §"Scope note").
>
> **What this doc is.** The concrete build recipe for the TET write path's **fifth primitive — Stamp**
> ([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
> §"First-principles decomposition", primitive #5). Every normalized batch that `transform_data` emits
> carries a machine-readable **provenance record** that says *where the number came from* and *whether
> you are licensed to display it commercially*. This is the project's headline differentiator: DataQuery
> and OpenBB normalize data, but neither **systematically stamps the per-series commercial-licensing
> verdict** ([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
> §"Summary").
>
> **The one rule this whole doc enforces.** **TET CARRIES the verdict; it never INVENTS it.** The stamp
> is a *lookup against the sources-ledger keyed by the exact fetch path*, not an adjudication. A fetcher
> that decides its own `commercialOk` is the single worst failure mode in this file — it is exactly the
> "GREEN-but-wrong" / "free-tier-treated-as-display-license" trap the in-repo gate exists to stop
> ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)).

---

## 0. The thirty-second answer (read this first)

When a TET `Fetcher` finishes normalizing a batch, it attaches **one `Provenance` record per emitted
series/row-batch**. That record is built from **two inputs and zero opinions**:

1. **Runtime facts the fetcher already holds** — the URL it called, the wall-clock `fetchedAt`, the
   data's own `asOf`, the frequency, the source's unit/scale convention, and the list of transforms it
   applied (which aliases, which coercions, which unit normalisations).
2. **A licensing lookup** — it takes the **fetch-path key** (a canonical string for the exact URL/host
   it called) and looks it up in the **sources-ledger** ([`sources-ledger.md`](../../../memory/sources-ledger.md)).
   The ledger returns `🟢 GREEN` → `commercialOk: true`, or anything else (`🟡 / 🔴 / ⛔ / not-found`) →
   `commercialOk: false`. **Default is `false`.** Silence is not a license.

The fetcher **never** writes `commercialOk: true` from its own reasoning. It copies what the ledger says.
If the path is not in the ledger, the batch ships with `commercialOk: false` and a `ledgerMiss` flag so
the ingest run is visibly under-claimed and someone adds a row. Then:

- **Composites/derived fields inherit the most-restrictive input** (the **contamination rule**): a field
  computed from a GREEN input and a RED input is **RED**.
- The stamp flows downstream **unchanged** — into the TimescaleDB row metadata, into the catalog
  (modeled as **W3C PROV-O** + **DCAT** `dct:license`/`dct:rights`), and into the Parquet Distribution's
  sidecar. The verdict is *recorded at the fetch boundary once* and propagated; it is never re-derived.
- **`/sources-lint`** ([`sources-lint.md`](../../../commands/sources-lint.md)) is the CI gate that audits
  every `commercialOk: true` in the codebase against a 🟢 ledger row, and fails the build on any
  `true` that lacks one.

If that paragraph is all you needed, stop here. The rest is the exact record shape, the fetch-path
canonicalisation, the contamination algorithm, the PROV-O/OpenLineage/DCAT serialisation, and the
runnable Python.

---

## 1. Why the stamp is keyed to the FETCH PATH, not the concept

This is the load-bearing principle of the whole licensing layer, and it is the thing a junior build gets
wrong. Read it carefully because every line of code below exists to honour it.

> **The license attaches to the FETCH PATH, not the concept.** The US-Treasury 10-year yield fetched
> from `home.treasury.gov` is public-domain **GREEN**; the *exact same number* fetched from Yahoo's
> chart API is **RED**. You cannot reason about licensing from the data *type* — only from *where you
> fetched it*. ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) §"The principle";
> mirrored verbatim in the [sources-ledger header](../../../memory/sources-ledger.md).)

The reason this is true and not pedantic: a **price is a fact, and facts are not copyrightable** — but a
**database of prices, and the API that serves it, are protected by the provider's Terms of Service**,
which is contract law, not copyright law. Treasury.gov grants you a public-domain dedication (17 USC
§105 — works of the US government are not subject to copyright); Yahoo's ToS grants you *no commercial
redistribution/display right at all*. The number `4.27%` is identical in both responses. The *right to
put it on a screen you charge for* is opposite. So:

- **`commercialOk` cannot be a property of the series concept** ("the 10Y yield"). Two rows holding the
  identical numeric value can carry opposite verdicts because they were fetched from different hosts.
- **`commercialOk` is a property of the `(fetch-path) × (point in time the ToS said what it said)` pair.**
  The fetcher knows the fetch path. That is *why the fetcher is the right place to stamp* — it is the
  only layer that knows, with certainty, which URL produced these bytes.

Concretely, the GREEN set this product line is cleared to redistribute in v1 is fixed by *fetch path*
([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
§"Selected approach"; [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
Group-5 table):

| Fetch path (host / API)                | Concept it carries          | Verdict | Basis (cited in Group-5) |
|----------------------------------------|-----------------------------|---------|--------------------------|
| `data.sec.gov` (XBRL companyfacts / frames / submissions) | fundamentals, filings | 🟢 GREEN | U.S. public domain — SEC dissemination policy; descriptive `User-Agent` + ≤10 req/s |
| `home.treasury.gov` / `api.fiscaldata.treasury.gov` | yields, federal debt, DTS/MTS | 🟢 GREEN | U.S. public domain (17 USC §105), "Citation Requested" |
| `api.bls.gov` (LNS14000000 …)          | CPI, employment, wages      | 🟢 GREEN | U.S. public domain — bls.gov copyright-information |
| `apps.bea.gov` / BEA API               | GDP, national/regional accts| 🟢 GREEN | U.S. public domain — bea.gov FAQ 147 |
| `api.worldbank.org`                    | WDI development indicators   | 🟢 GREEN **with attribution** | CC BY 4.0 — credit string MUST render |
| OECD SDMX API                          | OECD statistics              | 🟢 GREEN **with attribution** | CC BY 4.0 (default from 2024-07-01) |
| IMF Data API                           | IFS/BOP/DOT/GFS macro        | 🟢 GREEN **with "Source: IMF"** | IMF Data terms — publish/distribute/sell with attribution |
| `api.gdeltproject.org` (DOC 2.0 tone)  | news tone/volume (numeric)   | 🟢 GREEN **with verbatim citation+link** | GDELT "unrestricted commercial use" *conditioned on* the mandatory "Source: The GDELT Project (gdeltproject.org)" rendering |
| `api.twelvedata.com` (free)            | stock quote                 | 🔴 RED | free tier = personal/internal use, no third-party display |
| `query*.finance.yahoo.com`             | index/quote                 | 🔴 RED | no commercial-display grant; ToS forbids redistribution |
| `api.coingecko.com` (demo key)         | crypto                      | 🔴 RED | demo scoped to personal use; "Powered by CoinGecko" required |
| `api.elections.kalshi.com`             | event markets               | ⛔ REJECT | ToS bans caching, display, AND ML/AI use — **do not integrate** |

Two subtleties that the table makes visible and that the code below must encode:

1. **An aggregator host is NOT a license layer.** `FRED` (`api.stlouisfed.org/fred`) hosts both Fed-owned
   public-domain series **and** third-party copyrighted series (CBOE's VIXCLS, ICE's rates). FRED's API
   terms explicitly state *"Redistributing copyrighted data series for commercial use is not allowed
   unless the data copyright owner authorizes it"*
   ([fred.stlouisfed.org/docs/api/terms_of_use.html](https://fred.stlouisfed.org/docs/api/terms_of_use.html),
   cited in [`sources-ledger.md`](../../../memory/sources-ledger.md) "Hard RED traps"). So a FRED fetch
   path's verdict is **per-series, not per-host** — the fetch-path key must include the series id, and the
   ledger row must be the `(FRED, series-id)` pair, not just `FRED`. The same per-series carve-out
   applies to World Bank / OECD / IMF where some indicators are vendor-supplied
   ([`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
   trap #4).
2. **CC-BY GREENs are conditional GREENs.** World Bank / OECD / IMF / GDELT are `commercialOk: true`
   **only if the required attribution string is actually rendered on the surface** and passed through to
   sub-licensees. An un-attributed display breaks the license even though the source is "GREEN"
   ([`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
   trap #5). The stamp therefore carries an `attribution` string that the *render* layer is contractually
   obliged to show — the provenance record is where that obligation is recorded.

---

## 2. The `Provenance` record — the exact shape

The stamp is one record per **emitted series/row-batch** (the unit `transform_data` returns). It is the
machine-readable answer to "where did this come from, when, in what units, after what transforms, and may
I display it." It composes cleanly into the catalog standards in §5; here it is as the Pydantic v2 model
the data plane actually constructs.

### 2.1 The fields, and why each one exists

| Field | Type | Source | Why it's load-bearing |
|---|---|---|---|
| `fetch_path` | `str` (canonical) | the fetcher's URL | **The licensing key.** Everything keys off this. Canonicalised (§3) so the *same* logical source always produces the *same* key. |
| `source_label` | `str` | ledger row | Human-readable provider name for UI/attribution ("U.S. Department of the Treasury"). |
| `commercial_ok` | `bool` | **ledger lookup only** | The display-license verdict. **Default `false`.** Never set from fetcher reasoning. |
| `license_basis` | `str` | ledger row | The governing clause short-form ("17 USC §105 public domain"; "CC BY 4.0"). Audit trail for why the verdict is what it is. |
| `attribution` | `str \| None` | ledger row | The exact credit string the render layer is contractually obliged to show (CC-BY / GDELT). `None` for public-domain with no required credit. |
| `ledger_verdict` | `Literal["GREEN","YELLOW","RED","REJECT","MISS"]` | ledger lookup | The raw verdict, kept distinct from the boolean so `YELLOW`/`MISS` are visible (both → `commercial_ok=false`, but for different reasons). |
| `fetched_at` | `datetime` (UTC) | wall clock at fetch | When *we* pulled the bytes. Drives cache TTL + staleness UX. |
| `as_of` | `datetime \| date` | the data itself | The economic timestamp the data refers to (e.g. the trade date, the reference period). Distinct from `fetched_at`. |
| `frequency` | `Literal["tick","1min",...,"daily","weekly","monthly","quarterly","annual"]` | normalised | The series cadence after normalisation. |
| `source_unit` | `str` | per-provider convention | The unit/scale the source emitted in **before** our normalisation ("percent", "basis_points", "USD_millions", "index_points"). Records the convention so a later reader knows what we coerced from. |
| `transform_lineage` | `list[TransformStep]` | the fetcher's own log | Ordered list of every alias/coercion/unit-norm applied: `{op, detail}`. The "what did TET do to this" audit. |
| `figi` / `instrument_id` | `str \| None` | security master | The canonical instrument id this batch resolved to (anchored on free FIGI). Lets two providers' rows for the same instrument join. (Built by the `security-master-symbology` skill; carried here.) |
| `run_id` | `UUID` | the ingest run | Ties the batch to the OpenLineage `RunEvent` (§5.2) so the whole pipeline run is traceable. |

### 2.2 The Pydantic v2 model (runnable)

```python
# app/provenance/models.py
from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class LedgerVerdict(str, Enum):
    GREEN = "GREEN"        # public-domain / CC0 / CC-BY+attribution / purchased display tier
    YELLOW = "YELLOW"      # conditional / derived-data licence needed
    RED = "RED"            # not for public display on a free path
    REJECT = "REJECT"      # ToS forbids the use outright — must not even ingest
    MISS = "MISS"          # fetch path has NO ledger row → treat as RED, flag for a human


class TransformStep(BaseModel):
    """One normalisation operation, recorded in order. The 'what did TET do' audit."""
    model_config = ConfigDict(frozen=True)
    op: Literal["alias", "coerce_type", "normalize_unit", "rescale", "tz_normalize",
                "dedup", "fill_default", "rename_field", "split", "join"]
    detail: str  # e.g. "adjClose -> close"; "percent -> ratio (x0.01)"; "naive -> UTC"


class Provenance(BaseModel):
    """
    The per-batch stamp. Built by `transform_data` from runtime facts + ONE ledger lookup.
    `commercial_ok` is NEVER assigned by fetcher reasoning — it is copied from the ledger.
    """
    model_config = ConfigDict(frozen=True)  # immutable once stamped — propagated, never edited

    # — licensing (the load-bearing half) —
    fetch_path: str
    source_label: str
    commercial_ok: bool = False                       # DEFAULT FALSE. Silence is not a license.
    license_basis: str
    attribution: str | None = None
    ledger_verdict: LedgerVerdict = LedgerVerdict.MISS

    # — temporal —
    fetched_at: datetime
    as_of: datetime | date

    # — series shape —
    frequency: Literal["tick", "1min", "5min", "15min", "30min", "1h",
                        "daily", "weekly", "monthly", "quarterly", "annual"]
    source_unit: str

    # — lineage —
    transform_lineage: list[TransformStep] = Field(default_factory=list)
    instrument_id: str | None = None                  # canonical FIGI-anchored id (security master)
    run_id: UUID

    @field_validator("commercial_ok")
    @classmethod
    def _green_only(cls, v: bool, info) -> bool:
        """
        Defence-in-depth: a `True` is only ever legal alongside a GREEN verdict.
        If anything tries to construct a True with a non-GREEN verdict, refuse —
        this is the in-code mirror of the /sources-lint CI gate.
        """
        verdict = info.data.get("ledger_verdict")
        if v and verdict is not LedgerVerdict.GREEN:
            raise ValueError(
                f"commercial_ok=True is illegal with ledger_verdict={verdict}. "
                "The verdict comes from the sources-ledger; True requires a GREEN row."
            )
        return v
```

Three design notes the model encodes deliberately:

- **`frozen=True`.** Once stamped at the fetch boundary, the record is immutable. Downstream code
  *propagates* it; it never edits a verdict. This is the in-type enforcement of "stamp once, carry
  forever." If a later stage needs a different verdict (e.g. a composite), it builds a **new** record via
  the contamination merge (§4) — it does not mutate the input.
- **`ledger_verdict` is kept separate from `commercial_ok`.** A `false` boolean alone can't distinguish
  "RED because we're not licensed" from "MISS because nobody's classified this path yet." Operators need
  to see `MISS` so they add a ledger row; they need to see `YELLOW` so they know a derived-data licence
  *could* be bought. Collapsing both to `false` hides actionable state.
- **The `_green_only` validator is the in-code twin of `/sources-lint`.** `/sources-lint` is the *CI*
  gate (it greps the repo). This validator is the *runtime* gate (it refuses to even construct an illegal
  record). Belt and braces: the bad value never reaches the store, and CI catches it if a hardcode tries.

---

## 3. The fetch-path key — canonicalising "where did this come from"

The verdict keys off `fetch_path`, so the key must be **stable and canonical**: the same logical source
must always produce the same key, regardless of irrelevant URL noise (query-param order, ephemeral
tokens, pagination cursors). Otherwise the ledger lookup misses and a GREEN source silently ships as
`MISS → false` (an under-claim — annoying but safe) or, worse, two spellings of the same RED source let
one slip through unaudited.

### 3.1 What goes IN the key and what is stripped

| Component | In the key? | Why |
|---|---|---|
| scheme + host | **yes** | The host is the licensing boundary (`home.treasury.gov` ≠ `query1.finance.yahoo.com`). |
| path | **yes** | Distinguishes APIs on the same host (`data.sec.gov/api/xbrl/frames` vs `/submissions`). |
| *license-bearing* query params | **yes, normalised** | For FRED, `series_id` IS the licensing dimension (per-series verdict). For SDMX, the dataflow id. Keep only the params the ledger row keys on. |
| API keys / tokens / `apikey=` | **stripped** | A secret in the key would leak into the store and CI logs, and it's not a licensing dimension. |
| pagination cursors / `offset` / `page` | **stripped** | Same logical source, different page → same verdict. |
| volatile params (timestamps, nonces) | **stripped** | Noise. |
| param order | **sorted** | `?a=1&b=2` ≡ `?b=2&a=1`. |

### 3.2 Canonicaliser (runnable)

```python
# app/provenance/fetch_path.py
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

# Params that ARE a licensing dimension and must stay in the key, per host.
# (FRED's verdict is per-series; SDMX's is per-dataflow; EDGAR's path already disambiguates.)
_LICENSE_PARAMS: dict[str, set[str]] = {
    "api.stlouisfed.org": {"series_id"},          # FRED — per-series GREEN/RED gate
    "sdmx.oecd.org": {"dataflow", "agencyId"},     # OECD SDMX
    "api.worldbank.org": {"indicator"},            # WDI per-indicator
}

# Params that are always noise/secret and must be stripped from EVERY host.
_STRIP_ALWAYS = {"api_key", "apikey", "key", "token", "access_token", "registrationKey",
                 "page", "offset", "limit", "cursor", "_", "timestamp", "nonce", "format"}


def canonical_fetch_path(url: str) -> str:
    """
    Produce the stable, secret-free licensing key for a fetched URL.
    The SAME logical source always yields the SAME string.
    """
    parts = urlsplit(url)
    host = parts.netloc.lower()
    # collapse Yahoo's query1/query2 round-robin hosts to one logical path
    if host.startswith(("query1.finance.yahoo.com", "query2.finance.yahoo.com")):
        host = "query.finance.yahoo.com"

    keep = _LICENSE_PARAMS.get(host, set())
    params = [
        (k, v) for (k, v) in parse_qsl(parts.query, keep_blank_values=False)
        if k in keep and k not in _STRIP_ALWAYS
    ]
    params.sort()  # order-independent
    query = urlencode(params)
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme or "https", host, path, query, ""))  # no fragment


# Examples (these are the keys the ledger is indexed by):
#   "https://home.treasury.gov/.../daily-treasury-rates.csv?field=...&apikey=SECRET"
#     -> "https://home.treasury.gov/.../daily-treasury-rates.csv"            (GREEN)
#   "https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=X"
#     -> "https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS"  (RED — CBOE ©)
#   "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=X"
#     -> "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10"   (GREEN — Fed-owned)
#   "https://query1.finance.yahoo.com/v8/finance/chart/^GSPC"
#     -> "https://query.finance.yahoo.com/v8/finance/chart/^GSPC"            (RED)
```

The FRED example is the whole point: two URLs that differ *only* in `series_id` produce two keys with two
opposite verdicts, because the licensing dimension for FRED is the series, not the host. A canonicaliser
that stripped `series_id` would collapse them and ship CBOE's copyrighted VIX as GREEN — a licensing
violation born of a normalisation bug. **The canonicaliser is part of the licensing surface, not a
utility.**

---

## 4. The ledger lookup — TET carries, never adjudicates

This is the heart of the rule. The fetcher's job is a **lookup**, not a judgment.

### 4.1 The sources-ledger as the single source of truth

The ledger ([`sources-ledger.md`](../../../memory/sources-ledger.md)) is the human-maintained truth
table. In the Lumina repo it is a Markdown table read by humans + `/sources-lint`. For this product
line's data plane, the *runtime* form is a typed registry compiled from that same table (one row per
canonical fetch-path key). The compile step is mechanical — it parses the Markdown rows into the typed
dict below — so the Markdown stays the human-editable source of truth and the code never drifts from a
parallel hand-maintained copy.

```python
# app/provenance/ledger.py
"""
Runtime mirror of .claude/memory/sources-ledger.md — the licensing truth table.
ONE row per canonical fetch-path key. This file is GENERATED from the Markdown ledger
by a build step; do not hand-edit. The Markdown is the source of truth.

DEFAULT for any path not present here is RED/MISS -> commercial_ok False.
"""
from dataclasses import dataclass

from .models import LedgerVerdict


@dataclass(frozen=True)
class LedgerRow:
    source_label: str
    verdict: LedgerVerdict
    license_basis: str
    attribution: str | None  # required credit string, or None for bare public-domain


# Keyed by the EXACT output of canonical_fetch_path(). Prefix match for path families.
LEDGER: dict[str, LedgerRow] = {
    "https://home.treasury.gov": LedgerRow(
        "U.S. Department of the Treasury", LedgerVerdict.GREEN,
        "17 USC §105 — U.S. government public domain", None),
    "https://api.fiscaldata.treasury.gov": LedgerRow(
        "U.S. Treasury FiscalData", LedgerVerdict.GREEN,
        "U.S. public domain (Citation Requested)", None),
    "https://api.bls.gov": LedgerRow(
        "U.S. Bureau of Labor Statistics", LedgerVerdict.GREEN,
        "U.S. public domain — bls.gov copyright-information", None),
    "https://apps.bea.gov": LedgerRow(
        "U.S. Bureau of Economic Analysis", LedgerVerdict.GREEN,
        "U.S. public domain — bea.gov FAQ 147", None),
    "https://data.sec.gov": LedgerRow(
        "SEC EDGAR", LedgerVerdict.GREEN,
        "U.S. public domain — SEC dissemination policy (User-Agent + <=10 req/s)", None),
    "https://api.worldbank.org": LedgerRow(
        "World Bank Open Data", LedgerVerdict.GREEN,
        "CC BY 4.0 — attribution required",
        "Source: World Bank Open Data (CC BY 4.0)"),
    "https://api.gdeltproject.org": LedgerRow(
        "The GDELT Project", LedgerVerdict.GREEN,
        "GDELT unrestricted commercial use — conditioned on verbatim citation+link",
        "Source: The GDELT Project (gdeltproject.org)"),
    # — per-series FRED rows (the host alone is NOT a verdict) —
    "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10": LedgerRow(
        "FRED (Fed-owned series)", LedgerVerdict.GREEN,
        "Fed-owned FRED series — U.S. public domain", None),
    "https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS": LedgerRow(
        "FRED (CBOE VIXCLS)", LedgerVerdict.RED,
        "CBOE © — FRED hosting is not a public-domain dedication", None),
    # — RED vendor tiers (fetch-through-only; never stored/redistributed) —
    "https://query.finance.yahoo.com": LedgerRow(
        "Yahoo Finance", LedgerVerdict.RED,
        "No commercial-display grant; ToS forbids redistribution", None),
    "https://api.twelvedata.com": LedgerRow(
        "Twelve Data (free)", LedgerVerdict.RED,
        "Free tier = personal/internal use only", None),
    "https://api.coingecko.com": LedgerRow(
        "CoinGecko (demo)", LedgerVerdict.RED,
        "Demo key scoped to personal use; redistribution prohibited", None),
    # — REJECT: do not even ingest —
    "https://api.elections.kalshi.com": LedgerRow(
        "Kalshi", LedgerVerdict.REJECT,
        "ToS bans caching, display, AND ML/AI use — do not integrate", None),
}

_MISS = LedgerRow("UNKNOWN (no ledger row)", LedgerVerdict.MISS,
                  "fetch path not in sources-ledger — defaulting to RED", None)


def lookup(canonical_path: str) -> LedgerRow:
    """
    Exact match first, then longest-prefix match (for path families on a GREEN host).
    A REJECT host is matched by prefix so we never accidentally ingest a sub-path of it.
    Anything unmatched -> _MISS -> RED. Silence is not a license.
    """
    if canonical_path in LEDGER:
        return LEDGER[canonical_path]
    best: tuple[int, LedgerRow] | None = None
    for key, row in LEDGER.items():
        if canonical_path.startswith(key) and (best is None or len(key) > best[0]):
            best = (len(key), row)
    return best[1] if best else _MISS
```

### 4.2 The stamp builder — the only place a verdict is set

```python
# app/provenance/stamp.py
from datetime import date, datetime, timezone
from typing import Literal
from uuid import UUID

from .fetch_path import canonical_fetch_path
from .ledger import lookup
from .models import LedgerVerdict, Provenance, TransformStep


class RejectedSourceError(RuntimeError):
    """Raised when a fetcher targets a ⛔ REJECT path. The ingest must abort, not stamp."""


def build_provenance(
    *,
    fetched_url: str,
    as_of: datetime | date,
    frequency: Literal["tick", "1min", "5min", "15min", "30min", "1h",
                       "daily", "weekly", "monthly", "quarterly", "annual"],
    source_unit: str,
    transform_lineage: list[TransformStep],
    run_id: UUID,
    instrument_id: str | None = None,
) -> Provenance:
    """
    The SINGLE function that assigns commercial_ok. It does so by LOOKUP, never by reasoning.
    Called by every Fetcher's transform_data at the fetch boundary.
    """
    key = canonical_fetch_path(fetched_url)
    row = lookup(key)

    if row.verdict is LedgerVerdict.REJECT:
        # A REJECT source must not even be ingested (Kalshi: ToS bans caching+display+AI).
        raise RejectedSourceError(
            f"Fetch path {key} is ⛔ REJECT ({row.license_basis}). Abort ingest — do not stamp.")

    commercial_ok = row.verdict is LedgerVerdict.GREEN  # the ONLY way True is ever produced

    return Provenance(
        fetch_path=key,
        source_label=row.source_label,
        commercial_ok=commercial_ok,
        license_basis=row.license_basis,
        attribution=row.attribution,
        ledger_verdict=row.verdict,
        fetched_at=datetime.now(timezone.utc),
        as_of=as_of,
        frequency=frequency,
        source_unit=source_unit,
        transform_lineage=transform_lineage,
        instrument_id=instrument_id,
        run_id=run_id,
    )
```

Notice what `build_provenance` does **not** do:

- It does **not** look at the data *type* to decide the verdict. A 10Y yield and a meme-stock quote go
  through the identical code path; only their `fetched_url` differs, and that is the entire input to the
  verdict.
- It does **not** "upgrade" a MISS to GREEN because "this is obviously public data." A `MISS` ships as
  `false` and someone adds a ledger row. That is the whole discipline — **TET carries what the ledger
  says; a human (with the cited ToS) decides what the ledger says.**
- It does **not** suppress a RED. A RED source can still be *built against* for an informational,
  attributed feature ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) §"In practice":
  "RED gates the *display license*, not *access*"). The stamp records `false`; the render layer shows
  attribution and withholds the commercial-display surface. The fetcher's job is to *record* RED
  accurately, not to refuse it (except ⛔ REJECT, which it must refuse).

### 4.3 Wiring it into the TET `transform_data`

The TET pattern (clean-room reimplemented from OpenBB's public docs — **never vendor `openbb-*`, it is
AGPL-3.0**, see [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
trap #1) ends in `transform_data(query, raw) -> R`. The stamp is built *inside* `transform_data`, after
field-aliasing and security-master resolution, because that is the moment the fetcher holds *both* the
fetch URL *and* the finished transform list:

```python
# app/providers/treasury/yields.py  (one provider's TET fetcher — abridged)
from uuid import UUID

from app.provenance.models import TransformStep
from app.provenance.stamp import build_provenance
from app.tet.fetcher import Fetcher  # our clean-room Fetcher[Q, R] base


class TreasuryYieldFetcher(Fetcher):
    @staticmethod
    def transform_query(params: dict) -> "TreasuryYieldQuery":
        ...  # validate/default the request params

    @staticmethod
    async def aextract_data(query, credentials, *, http) -> list[dict]:
        # the ONLY place that fetches. The URL it calls becomes the licensing key.
        url = "https://home.treasury.gov/.../daily-treasury-rates.csv?field_tdr_date_value=2026"
        resp = await http.get(url)
        return _parse_csv(resp.text), url  # carry the url out for the stamp

    @staticmethod
    def transform_data(query, extracted, *, run_id: UUID) -> "TreasuryYieldBatch":
        rows, fetched_url = extracted
        lineage: list[TransformStep] = []

        # 1. field aliasing (the easy 20%)
        rows = _alias(rows, {"BC_10YEAR": "yield_10y"}); lineage.append(
            TransformStep(op="alias", detail="BC_10YEAR -> yield_10y"))
        # 2. unit normalisation — Treasury emits percent; our standard model is ratio
        rows = _rescale(rows, "yield_10y", 0.01); lineage.append(
            TransformStep(op="normalize_unit", detail="percent -> ratio (x0.01)"))
        # 3. security-master resolution (carried, built by the security-master skill)
        instrument_id = "BBG-CT10-GOVT"  # FIGI-anchored canonical id for the 10Y benchmark

        # 4. THE STAMP — lookup, not adjudication
        prov = build_provenance(
            fetched_url=fetched_url,        # -> GREEN via the ledger
            as_of=rows[-1]["date"],
            frequency="daily",
            source_unit="percent",          # what Treasury emitted, before our x0.01
            transform_lineage=lineage,
            run_id=run_id,
            instrument_id=instrument_id,
        )
        return TreasuryYieldBatch(series=rows, provenance=prov)
```

The `source_unit="percent"` + the `normalize_unit` lineage step together answer a question that bites in
production: *"this value is `0.0427`; is that 4.27% or 0.0427%?"* The lineage says the source spoke
`percent` and we multiplied by `0.01`, so `0.0427` is a ratio meaning 4.27%. Without that record, a
downstream consumer re-deriving the percentage has a 100× error waiting. The stamp is not just licensing
— it is the **unit-of-measure contract** between the write path and every reader.

---

## 5. The contamination rule — composites inherit the most-restrictive input

A derived field is no more freely-licensed than its least-free input. This is not a stylistic preference;
it is the only logically sound rule, and it is already in force in the live Lumina repo
([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) is the principle; the
[red-team F2 goal](../../../rules/red-team-negation-loop.md) names the *contamination rule* explicitly:
*"a composite that inherits a RED input yet claims GREEN"* is a CRITICAL finding).

### 5.1 Why "most-restrictive wins"

If you compute `spread = treasury_10y(GREEN) − corporate_yield(RED_vendor)`, the resulting number
**encodes** the RED vendor's data — you cannot reconstruct the corporate yield without it, but you have
*displayed information derived from it*. The vendor's ToS forbade commercial display of *their* number;
a transform does not launder that. The composite is RED. Symmetrically, GREEN + GREEN = GREEN (both
inputs grant display); GREEN + CC-BY = GREEN **but the CC-BY attribution string propagates** (you must
now show both credit lines).

The ordering of verdicts by restrictiveness (least → most restrictive on display):

```
GREEN  <  YELLOW  <  RED  <  REJECT(/MISS)
```

- A composite's verdict = the **max (most restrictive)** of its inputs' verdicts.
- A composite's `attribution` = the **union** of every input's required attribution string (de-duplicated).
- If *any* input is `REJECT`, the composite must not exist — you should never have ingested that input.
- A `MISS` input contaminates to RED (default-deny): you cannot certify a composite GREEN on top of an
  unclassified input.

### 5.2 The live-repo precedent (this is not theoretical)

This exact merge is already implemented in Lumina's finance backend. The "Market Mood" dial is a
composite of Treasury (GREEN) + GDELT (GREEN), and the code comment states the rule plainly
([`backend/finance/sentiment-sources.ts`](../../../../backend/finance/sentiment-sources.ts), read
2026-06-24):

> ```
> // NOTE: the richer 7-signal CNN-Fear&Greed-rhyme (momentum/breadth/put-call/VIX) leans on
> // equity prices that today come from Yahoo (commercialOk:false) → that dial is a Phase-2,
> // paid-spine build. THIS launch dial is composed ONLY of GREEN inputs (Treasury + GDELT),
> // so the whole composite is `commercialOk:true`.
> ```

That is the contamination rule operating in production: the *richer* dial would pull in Yahoo (RED), so
its composite is `commercialOk:false` and is deferred; the shipped dial uses **only GREEN inputs**, so —
and *only* so — the composite is `true`. The data-analytics product line inherits this discipline
verbatim; the code below is its Python form.

### 5.3 The contamination merge (runnable)

```python
# app/provenance/contaminate.py
from datetime import datetime, timezone
from uuid import UUID

from .models import LedgerVerdict, Provenance, TransformStep

# Restrictiveness order — index = restrictiveness. MISS sits with RED (default-deny).
_ORDER = {
    LedgerVerdict.GREEN: 0,
    LedgerVerdict.YELLOW: 1,
    LedgerVerdict.MISS: 2,
    LedgerVerdict.RED: 2,
    LedgerVerdict.REJECT: 3,
}


def merge_provenance(
    inputs: list[Provenance],
    *,
    derived_label: str,
    derived_op: str,         # e.g. "spread = 10y - corp_yield"
    run_id: UUID,
) -> Provenance:
    """
    Build the Provenance for a COMPOSITE/derived field.
    Verdict = the MOST RESTRICTIVE input's verdict. commercial_ok True ONLY if ALL inputs GREEN.
    """
    if not inputs:
        raise ValueError("a composite needs at least one input provenance")

    worst = max(inputs, key=lambda p: _ORDER[p.ledger_verdict])
    if worst.ledger_verdict is LedgerVerdict.REJECT:
        # should be unreachable — a REJECT input should never have been ingested
        raise RuntimeError(
            f"composite '{derived_label}' has a ⛔ REJECT input ({worst.fetch_path}); abort.")

    verdict = worst.ledger_verdict
    commercial_ok = all(p.ledger_verdict is LedgerVerdict.GREEN for p in inputs)

    # union of every required attribution (CC-BY / GDELT credit strings propagate)
    attributions = sorted({p.attribution for p in inputs if p.attribution})
    attribution = "; ".join(attributions) if attributions else None

    # lineage records WHICH inputs fed the composite and the derive op
    lineage: list[TransformStep] = [
        TransformStep(op="join", detail=f"{derived_op} from [{p.source_label} @ {p.fetch_path}]")
        for p in inputs
    ]

    return Provenance(
        fetch_path=f"derived://{derived_label}",        # a composite has no single fetch path
        source_label=derived_label,
        commercial_ok=commercial_ok,                     # validator re-checks GREEN-only
        license_basis=f"derived; inherits most-restrictive input ({worst.source_label}: "
                      f"{worst.license_basis})",
        attribution=attribution,
        ledger_verdict=verdict,
        fetched_at=datetime.now(timezone.utc),
        as_of=max((p.as_of for p in inputs), default=datetime.now(timezone.utc)),  # newest input
        frequency=min(inputs, key=lambda p: _FREQ_RANK[p.frequency]).frequency,    # coarsest cadence
        source_unit="derived",
        transform_lineage=lineage,
        instrument_id=None,
        run_id=run_id,
    )


_FREQ_RANK = {"tick": 0, "1min": 1, "5min": 2, "15min": 3, "30min": 4, "1h": 5,
              "daily": 6, "weekly": 7, "monthly": 8, "quarterly": 9, "annual": 10}
```

```python
# Worked examples — the rule in action:
#   merge([treasury_GREEN, gdelt_GREEN], "market_mood")        -> commercial_ok True  (all GREEN)
#   merge([treasury_GREEN, yahoo_RED],   "credit_spread")      -> commercial_ok False (RED contaminates)
#   merge([worldbank_GREEN_ccby, oecd_GREEN_ccby], "wdi_index")-> True, attribution = both credit lines
#   merge([edgar_GREEN, fred_MISS],      "fundamentals_blend") -> False (MISS = default-deny)
```

The `derived://` fetch-path prefix is deliberate: a composite has **no single fetch path**, so it cannot
have a real licensing key — its verdict is *purely* the contamination result, and `/sources-lint` knows
to validate a `derived://` row against the inheritance rule rather than against a ledger host row. The
`license_basis` string names *which* input was the binding constraint, so an auditor can see at a glance
*why* the composite is RED ("because corporate_yield came from Yahoo").

---

## 6. How the stamp flows to the catalog/store — PROV-O, OpenLineage, DCAT

The stamp is born in `transform_data` and must travel, unchanged, into three places: (1) the **catalog**
(so a discovery query can filter by `commercialOk` and show provenance), (2) the **time-series store**
(so each row's licensing is queryable), and (3) the **Parquet Distribution** (so a downloaded file
carries its own licence). The project's theory mandates modelling provenance on **W3C PROV-O** for the
*shape* and **OpenLineage** for *run-level lineage*
([`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
Tier-2/Tier-3; [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
Group-5). Here is the precise mapping to each standard, with verbatim spec definitions so the
serialisation is grounded, not invented.

### 6.1 PROV-O — the per-series provenance shape

W3C **PROV-O** (a 2013 W3C Recommendation) defines three core classes; namespace
`http://www.w3.org/ns/prov#` ([w3.org/TR/prov-o](https://www.w3.org/TR/prov-o/), fetched 2026-06-24):

- **`prov:Entity`** — *"a physical, digital, conceptual, or other kind of thing with some fixed aspects;
  entities may be real or imaginary."* → **our normalized series/batch is an Entity.**
- **`prov:Activity`** — *"something that occurs over a period of time and acts upon or with entities; it
  may include consuming, processing, transforming, modifying, relocating, using, or generating
  entities."* → **our TET ingest run is an Activity.**
- **`prov:Agent`** — *"something that bears some form of responsibility for an activity taking place, for
  the existence of an entity, or for another agent's activity."* → **the provider (Treasury/SEC) and our
  fetcher are Agents.**

The core relating properties we use (verbatim definitions from the same Recommendation):

| Property | Verbatim definition | Our use |
|---|---|---|
| `prov:wasGeneratedBy` | *"the completion of production of a new entity by an activity"* (Entity → Activity) | the series **was generated by** the ingest run |
| `prov:used` | *"the beginning of utilizing an entity by an activity"* (Activity → Entity) | the run **used** the upstream raw response |
| `prov:wasAttributedTo` | *"the ascribing of an entity to an agent"* (Entity → Agent) | the series **was attributed to** the provider (this carries the licensing agent) |
| `prov:wasDerivedFrom` | *"a transformation of an entity into another … or the construction of a new entity based on a pre-existing entity"* (Entity → Entity) | a **composite** series **was derived from** its inputs — this is the PROV-O encoding of the contamination edge |
| `prov:wasAssociatedWith` | *"an assignment of responsibility to an agent for an activity"* (Activity → Agent) | the run **was associated with** our fetcher software agent |
| `prov:generatedAtTime` | *"the moment an entity was produced"* (xsd:dateTime) | = our `fetched_at` |
| `prov:wasInformedBy` | *"the exchange of an entity by two activities, one using the entity generated by the other"* | chains the fetch activity → the normalise activity |

`commercialOk` is **not** a native PROV-O term — it is our domain qualifier, carried as a custom property
in our namespace (`lic:commercialOk`, `lic:basis`, `lic:attribution`) hung off the Entity. This is the
correct extension pattern: PROV-O gives the lineage skeleton; the licensing verdict is a domain
annotation on the generated Entity. Serialised to JSON-LD:

```python
# app/provenance/prov_o.py
def to_prov_o_jsonld(p: "Provenance", series_uri: str) -> dict:
    """Render one batch's Provenance as a PROV-O JSON-LD fragment for the catalog."""
    return {
        "@context": {
            "prov": "http://www.w3.org/ns/prov#",
            "lic": "https://jpm-reeng.example/ns/license#",  # OUR domain extension
            "xsd": "http://www.w3.org/2001/XMLSchema#",
        },
        "@id": series_uri,
        "@type": "prov:Entity",
        "prov:generatedAtTime": {"@type": "xsd:dateTime",
                                 "@value": p.fetched_at.isoformat()},
        "prov:wasGeneratedBy": {"@id": f"urn:run:{p.run_id}", "@type": "prov:Activity"},
        "prov:wasAttributedTo": {"@id": f"urn:agent:{_slug(p.source_label)}",
                                 "@type": "prov:Agent",
                                 "prov:label": p.source_label},
        # the licensing verdict as a domain annotation (NOT native PROV-O)
        "lic:fetchPath": p.fetch_path,
        "lic:commercialOk": p.commercial_ok,
        "lic:verdict": p.ledger_verdict.value,
        "lic:basis": p.license_basis,
        **({"lic:attribution": p.attribution} if p.attribution else {}),
        # contamination edges, if this is a composite
        **({"prov:wasDerivedFrom": [
            {"@id": s.detail} for s in p.transform_lineage if s.op == "join"]}
           if any(s.op == "join" for s in p.transform_lineage) else {}),
    }
```

### 6.2 OpenLineage — the run-level lineage

PROV-O describes the *static* provenance of a series. **OpenLineage** (Apache-2.0, an LF AI & Data
project) describes the *dynamic* lineage of the **ingest run** — which job ran, what it read, what it
wrote, and structured **facets** carrying extra metadata
([github.com/OpenLineage/OpenLineage](https://github.com/OpenLineage/OpenLineage);
[openlineage.io/docs/spec/object-model](https://openlineage.io/docs/spec/object-model/), fetched
2026-06-24). The object model:

- **`RunEvent`** — the runtime event. Fields: `eventTime`, `eventType`, `run` (a `Run` with a UUID
  `runId`), `job` (a `Job` = *"a process that consumes or produces Datasets"*, identified by
  `namespace` + `name`), `inputs` (input `Dataset`s), `outputs` (output `Dataset`s), `producer` (the
  emitting system URI). `eventType` ∈ `{START, RUNNING, COMPLETE, ABORT, FAIL, OTHER}`.
- **`Dataset`** — *"an abstract representation of data"*, identified by `namespace` + `name`, carrying
  **facets**.
- **Facet** — a structured, extensible metadata payload. **Every facet carries a `_producer` URI and a
  `_schemaURL`** — both are *required* fields of the OpenLineage `BaseFacet`
  (`required: ["_producer","_schemaURL"]`, `_producer` = a URI identifying the metadata producer,
  `_schemaURL` = an immutable JSON-pointer URL to that facet's schema version)
  ([OpenLineage.json BaseFacet](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json);
  the spec requires the `_schemaURL` be *"an immutable pointer … a git sha and not a branch name"*).
  Standard dataset facets include `schema`, `dataSource`, `documentation`, `ownership`, and the
  input-only `dataQualityMetrics`.

Our `commercialOk` stamp becomes a **custom dataset facet** on each output Dataset of the ingest
`RunEvent`. This is the run-level home of the verdict (PROV-O §6.1 is the series-level home; they agree
by construction because both are built from the same `Provenance` record):

```python
# app/provenance/openlineage.py
_OL = "https://openlineage.io/spec/2-0-2/OpenLineage.json"
_PRODUCER = "https://jpm-reeng.example/tet-write-path"  # our producer URI


def license_facet(p: "Provenance") -> dict:
    """A custom OpenLineage dataset facet carrying the commercialOk verdict."""
    return {
        # BaseFacet REQUIRED fields — every facet must carry both
        "_producer": _PRODUCER,
        "_schemaURL": "https://jpm-reeng.example/facets/1-0-0/CommercialLicenseFacet.json",
        # our payload
        "fetchPath": p.fetch_path,
        "commercialOk": p.commercial_ok,
        "verdict": p.ledger_verdict.value,
        "licenseBasis": p.license_basis,
        "attribution": p.attribution,
        "sourceLabel": p.source_label,
    }


def run_event_complete(p: "Provenance", *, dataset_namespace: str, dataset_name: str) -> dict:
    """A COMPLETE RunEvent for one ingest, with our license facet on the output dataset."""
    return {
        "eventType": "COMPLETE",
        "eventTime": p.fetched_at.isoformat(),
        "producer": _PRODUCER,
        "schemaURL": f"{_OL}#/$defs/RunEvent",
        "run": {"runId": str(p.run_id)},
        "job": {"namespace": "tet-write-path", "name": f"ingest::{p.source_label}"},
        "inputs": [{"namespace": "upstream", "name": p.fetch_path,
                    "facets": {"dataSource": {"_producer": _PRODUCER, "_schemaURL": _OL,
                                              "uri": p.fetch_path}}}],
        "outputs": [{
            "namespace": dataset_namespace,
            "name": dataset_name,
            "facets": {
                "commercialLicense": license_facet(p),     # OUR verdict facet
                "schema": {"_producer": _PRODUCER, "_schemaURL": _OL,
                           "fields": [{"name": "date"}, {"name": "value"}]},
            },
        }],
    }
```

The win of emitting OpenLineage: the verdict becomes visible to *any* OpenLineage-aware catalog
(OpenMetadata, Marquez, DataHub) without bespoke integration — the licensing stamp rides the same
lineage rail as schema and data-quality metadata. The ingest run is also where the **partial-failure**
behaviour is recorded: a provider-down run emits `eventType: FAIL` and writes **no** output dataset, so
the catalog never gains a series that was never grounded — the OpenLineage event is the audit that we
*didn't* fabricate a number to "look complete"
([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md): *"Failed/over-budget fetches return
typed `unavailable`/`needsKey` — never a fabricated value, never a RED-tier backfill"*).

### 6.3 DCAT — the catalog's license property

The catalog itself is modelled on **W3C DCAT v3** (Recommendation 2024-08-22), whose `dcat:Distribution`
is exactly the Fusion "Distribution" (the downloadable Parquet/CSV instance). DCAT carries license/rights
through **`dct:license`**, **`dct:rights`**, and **`dct:accessRights`**
([w3.org/TR/vocab-dcat-3](https://www.w3.org/TR/vocab-dcat-3/)):

- **`dct:license`** — *"the license document under which the distribution is made available"* — used only
  for licensable data, to name the license used. → our public-domain / CC-BY / vendor-ToS document.
- **`dct:rights`** — for rights statements not covered by license/accessRights (copyright statements). →
  the GDELT/CC-BY required-credit obligation, the "RED — display not licensed" statement.
- **`dct:accessRights`** — controlled vocab `{public, restricted, non-public}` — *access* conditions,
  distinct from *use* conditions. → GREEN → `public`; RED → `restricted`.
- For *machine-enforceable* commercial-use policy beyond a license URL, DCAT recommends **ODRL** (Open
  Digital Rights Language) via `odrl:hasPolicy` — permissions/prohibitions/obligations. Our
  `commercialOk` boolean is the *summary* of an ODRL permission ("display: permitted" vs "prohibited");
  for v1 the boolean + `dct:license` suffices, with ODRL flagged as the path to a fuller policy model.

```python
# app/provenance/dcat.py
def to_dcat_distribution(p: "Provenance", *, dist_uri: str, parquet_url: str) -> dict:
    """Render the Distribution's catalog entry, license carried in DCAT terms."""
    access = "http://publications.europa.eu/resource/authority/access-right/PUBLIC" \
        if p.commercial_ok else \
        "http://publications.europa.eu/resource/authority/access-right/RESTRICTED"
    return {
        "@context": {"dcat": "http://www.w3.org/ns/dcat#",
                     "dct": "http://purl.org/dc/terms/"},
        "@id": dist_uri,
        "@type": "dcat:Distribution",
        "dcat:accessURL": parquet_url,
        "dcat:mediaType": "application/vnd.apache.parquet",
        "dct:license": _license_doc_uri(p),          # the license document
        "dct:accessRights": access,
        # rights statement carries the commercialOk verdict + required attribution
        "dct:rights": (
            f"commercialOk={str(p.commercial_ok).lower()}; verdict={p.ledger_verdict.value}; "
            f"{p.license_basis}"
            + (f"; ATTRIBUTION REQUIRED: {p.attribution}" if p.attribution else "")
        ),
    }
```

### 6.4 The store row — the verdict at row granularity

In the TimescaleDB warehouse (built by the `timescaledb-timeseries` skill), the stamp is stored once per
*series* (in a `series_provenance` metadata table joined by `instrument_id` + `fetch_path`), **not**
duplicated on every tick row — duplicating a 200-byte stamp across a billion rows is a storage and
correctness disaster (any drift between copies is a contradiction). The series-level provenance row is
the single source of truth; queries join to it. The contamination check runs at **read/derive time** as
well: any query that computes a derived series across two `series_provenance` rows re-applies
`merge_provenance`, so a join that crosses a RED source produces a RED result-set the API gate then
refuses to display.

```sql
-- one provenance row per logical series; ticks join to it, never copy it
CREATE TABLE series_provenance (
  series_id       text PRIMARY KEY,          -- instrument_id + ':' + fetch_path
  fetch_path      text NOT NULL,
  source_label    text NOT NULL,
  commercial_ok   boolean NOT NULL DEFAULT false,   -- DEFAULT FALSE, mirrors the type
  ledger_verdict  text NOT NULL,                    -- GREEN/YELLOW/RED/REJECT/MISS
  license_basis   text NOT NULL,
  attribution     text,
  source_unit     text NOT NULL,
  fetched_at      timestamptz NOT NULL,
  run_id          uuid NOT NULL,
  CONSTRAINT green_only_for_true
    CHECK (commercial_ok = false OR ledger_verdict = 'GREEN')  -- the gate, in the DB
);
```

The `CHECK (commercial_ok = false OR ledger_verdict = 'GREEN')` constraint is the **third** layer of the
same gate: the Pydantic validator (runtime), the DB constraint (at-rest), and `/sources-lint` (CI). No
single layer is trusted alone; an illegal `true` would have to defeat all three.

---

## 7. `/sources-lint` — the CI audit that closes the loop

The stamp is only as good as the enforcement that no `commercialOk: true` escapes without a GREEN ledger
row. That enforcement is **`/sources-lint`** ([`sources-lint.md`](../../../commands/sources-lint.md)) —
the same command Lumina already runs. Its contract:

1. Grep the codebase for every `commercialOk: true` / `commercialOk:true` (and, here, `commercial_ok=True`
   / `commercial_ok: true` for the Python data plane).
2. For each hit, read enough context to identify the **fetch path / provider** it describes.
3. Load the sources-ledger and match each hit to a row.
4. **Flag any hit whose matching row is not 🟢 GREEN** (RED / YELLOW / REJECT / **missing**). Each flag is
   a potential licensing violation.
5. Also flag the inverse drift (a GREEN source still stamped `false` — a safe under-claim) and any
   provider in code with **no ledger row** (add one).
6. Report `file:line · provider · code says · ledger says · verdict (OK / FIX / ADD-ROW)`.

> **"Default to RED when a fetch path can't be matched to a ledger row — silence is not a license."**
> ([`sources-lint.md`](../../../commands/sources-lint.md), closing line.)

For this product line the audit extends in three project-specific ways:

- **`derived://` composites** are validated against the **contamination rule**, not a host row: a
  `derived://credit_spread` carrying `commercial_ok: true` is a FIX unless *every* named input in its
  `transform_lineage` join steps resolves to GREEN.
- **Per-series FRED/SDMX hits** must match the `(host, series_id)` row, not the bare host — a
  `commercial_ok: true` on `api.stlouisfed.org` with no `series_id` in the key is an automatic FIX
  (host-level GREEN on FRED does not exist).
- **CC-BY GREENs require a rendered attribution** — a `commercial_ok: true` on World Bank/OECD/IMF/GDELT
  whose `attribution` field is empty is a FIX, because an un-attributed CC-BY display breaks the license
  even though the verdict is GREEN.

The PreToolUse licensing guard ([`precheck-licensing.mjs`](../../../hooks/precheck-licensing.mjs)) is the
*pre-commit* twin: it nudges on any edit that introduces `commercialOk: true`, so the verdict is
double-checked at the moment it is written, before it ever reaches `/sources-lint`.

---

## 8. The boundary, restated — what TET must NEVER do

The single most important sentence in this document, expanded into the concrete prohibitions a reviewer
should hunt for (these map to the red-team **F1/F2** goals,
[`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md)):

| TET must NEVER… | because… | the right move |
|---|---|---|
| set `commercial_ok` from the *data type* | the license is on the fetch path, not the concept; the 10Y is GREEN from Treasury, RED from Yahoo | look up the canonical fetch path in the ledger |
| set `commercial_ok: true` for a path not in the ledger | silence is not a license; a MISS is a default-deny | ship `false` + `MISS`, flag for a human to add a row |
| "upgrade" a MISS/RED to GREEN because "it's obviously public" | the ToS, not intuition, decides; many "obviously public" feeds are vendor-ToS-RED | leave it RED; the human adds a *cited* ledger row or it stays RED |
| certify a composite GREEN when any input is RED/MISS/YELLOW | contamination — a transform doesn't launder a RED input | `merge_provenance` → most-restrictive wins |
| ingest a ⛔ REJECT path at all | Kalshi-class ToS bans caching/display/AI use outright | `RejectedSourceError`, abort the run, ingest nothing |
| backfill a failed fetch with a fabricated or RED-tier value to "look complete" | violates "never invent a finance number" + the gate | return typed `unavailable`/`needsKey`; emit a `FAIL` RunEvent; write no series |
| drop the required attribution on a CC-BY/GDELT GREEN | un-attributed display breaks the license even though GREEN | carry `attribution`; the render layer is contractually obliged to show it |
| mutate a stamped `Provenance` downstream | the verdict is decided once at the boundary; edits invite drift | `frozen=True`; build a *new* record for derivations |

And the one positive obligation that frames all of them: **TET's job is to record the truth about where a
number came from and what the ledger says about it — accurately, immutably, and at the fetch boundary
where it has the facts.** Adjudicating the license — deciding *what* the ledger should say — is a human
job, done against primary ToS/statute text, written into `sources-ledger.md`, and only *then* read by the
fetcher. The fetcher carries the verdict; it never invents it.

---

## 9. Decision checklist (use before locking any stamping code)

1. **Does the fetcher build the stamp inside `transform_data`, after aliasing + security-master
   resolution?** (Anywhere earlier and it lacks the transform list; anywhere later and the URL is lost.)
2. **Is `commercial_ok` produced ONLY by `row.verdict is GREEN`?** (Grep for any other assignment — a
   literal `True`, a `type ==` check, an `if "treasury" in url`. Each is a FIX.)
3. **Does the canonical fetch-path key strip secrets/pagination and keep the per-series licensing param
   (FRED `series_id`, SDMX dataflow)?**
4. **Does every composite go through `merge_provenance` (most-restrictive wins, attribution union)?**
5. **Is the verdict carried into all three sinks — PROV-O catalog entry, OpenLineage RunEvent facet,
   DCAT `dct:rights`/`dct:license` — built from the *same* `Provenance`, never re-derived?**
6. **Are all three gate layers present — Pydantic validator, DB `CHECK` constraint, `/sources-lint`?**
7. **Does a failed fetch emit `FAIL` and write no series (no fabricated/RED backfill)?**
8. **Is the stamp `frozen` and propagated unmutated?**

If every box is checked, the stamp carries the verdict faithfully and invents nothing — which is the
entire job of this primitive.

---

## Sources

- [`.claude/rules/commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) — fetch-path principle,
  default `false`, RED-gates-display-not-access, no-fabricated-backfill.
- [`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md) — the GREEN/YELLOW/RED/REJECT
  truth table; the per-series FRED carve-out; the GDELT/CC-BY attribution conditions.
- [`.claude/commands/sources-lint.md`](../../../commands/sources-lint.md) — the CI audit contract;
  "silence is not a license."
- [`.claude/rules/red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md) — F2 names the
  *contamination rule* (a composite inheriting a RED input yet claiming GREEN = CRITICAL).
- [`backend/finance/sentiment-sources.ts`](../../../../backend/finance/sentiment-sources.ts) — the
  live-repo contamination precedent (Market Mood = GREEN-only composite; the richer Yahoo-fed dial
  deferred), read 2026-06-24.
- Project theory: [`00-theory.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  primitive #5 (Stamp) + Selected-approach GREEN provider scope; and
  [`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md)
  Group-5 (catalog/provenance standards + GREEN providers) + licensing traps #1/#4/#5.
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) — Entity/Activity/Agent + wasGeneratedBy/used/
  wasAttributedTo/wasDerivedFrom/wasAssociatedWith/generatedAtTime/wasInformedBy; namespace
  `http://www.w3.org/ns/prov#` (fetched 2026-06-24).
- [OpenLineage object model](https://openlineage.io/docs/spec/object-model/) +
  [OpenLineage.json spec](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.json) —
  RunEvent (`eventType` ∈ START/RUNNING/COMPLETE/ABORT/FAIL/OTHER), Dataset (namespace/name/facets),
  BaseFacet `_producer`+`_schemaURL` required, custom facets (fetched 2026-06-24).
- [W3C DCAT v3](https://www.w3.org/TR/vocab-dcat-3/) — `dcat:Distribution`, `dct:license` ("the license
  document under which the distribution is made available"), `dct:rights`, `dct:accessRights`
  ({public,restricted,non-public}), ODRL `odrl:hasPolicy` for machine-enforceable commercial-use policy.
- [FRED API terms of use](https://fred.stlouisfed.org/docs/api/terms_of_use.html) — "Redistributing
  copyrighted data series for commercial use is not allowed unless the data copyright owner authorizes
  it" (the per-series, not per-host, gate).
