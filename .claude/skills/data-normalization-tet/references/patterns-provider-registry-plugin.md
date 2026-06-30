# Patterns — The Provider-Registry Plugin Architecture

> **Skill:** `data-normalization-tet` · **Line:** JPM-Markets re-engineering **data-analytics product line (NOT Lumina)**.
> **Stack:** Python 3.12+ / FastAPI / data-engineering — the new line, separate from Lumina's Bun + Express + Prisma + Supabase + Upstash.
> **This file is a `patterns-*` recipe:** a concrete build recipe for our provider-adapter plugin layer. The generic theory of the
> Transform→Extract→Transform contract lives in the sibling `theory-tet-fetcher-contract.md`; this file is the *registry/selection/credential*
> half — how many `Fetcher`s get **registered**, **selected at request time**, and **credential-scoped**.
>
> **Clean-room discipline (read before you copy anything).** Everything below is a **clean-room re-implementation of the SHAPES** of
> OpenBB's provider layer — `Provider`, `Fetcher`, `ProviderInterface`, the entry-point discovery pattern. We studied OpenBB's source to learn
> the *design*, then we re-derive it from first principles and Python's own stdlib (`importlib.metadata`). **We import nothing from `openbb-core`.**
> OpenBB Platform core is **AGPL-3.0-or-later** (verify: `github.com/OpenBB-finance/OpenBB` → `openbb_platform/core/pyproject.toml`, `license = "AGPL-3.0-only"` historically; the repo root LICENSE is `AGPLv3`). AGPL would virally attach to our backend if we imported it. We take the *idea* (entry-point-discovered provider objects, a singleton registry, a TET fetcher), not the *code*. Citations to OpenBB throughout are **"this is the shape we are reproducing,"** never "import this."

---

## 0. Plain-language on-ramp (what this is, in one breath)

We will ingest market data from **many upstream providers** — Twelve Data, FMP, Tiingo, government sources (Treasury, BLS, FRED), CoinGecko, and
so on. Each provider speaks a different dialect: a different URL, different auth, a different JSON shape. We do **not** want our analytics code to
know or care which provider answered. So we put a thin **adapter** in front of every (provider, endpoint) pair — a `Fetcher` — and a **registry**
that, given *"give me an EquityQuote, you may use provider `twelve_data`,"* finds the right adapter, hands it the right credential, runs it, and
returns one **standardized** object. The analytics layer asks for `EquityQuote`; it never writes `if provider == "fmp": ...`.

Three jobs, in order, are what this file teaches:

1. **Register** — how each provider package *declares* the adapters it ships (the `Provider` object: a name + a `{endpoint → Fetcher}` map +
   its credential list), and how the registry *discovers* all installed providers into one singleton.
2. **Select** — at request time, given `(endpoint, provider)`, resolve the one `Fetcher` to run, and **fall back** across providers when one
   has no key, is rate-limited, or is RED for our display licence.
3. **Credential-scope** — inject `api_key` into the fetcher **by closure / by the registry**, scoped to *that* provider, so the **model never
   supplies a secret and a user never names a credential** (the confused-deputy defense, mirrored from Lumina non-negotiable #6).

---

## 1. The four objects (the whole vocabulary)

| Object | What it is | Lives where | One-line job |
|---|---|---|---|
| **`QueryParams`** | A Pydantic model of the *standard input* to an endpoint (`symbol`, `start_date`, `interval`, …). | `core/provider/abstract/query_params.py` (ours) | The typed request, provider-agnostic. |
| **`Data`** | A Pydantic model of the *standard output* of an endpoint (`open`, `high`, `low`, `close`, `volume`, …). | `core/provider/abstract/data.py` (ours) | The typed row, provider-agnostic. |
| **`Fetcher[Q, R]`** | The **adapter** for one (provider, endpoint). Implements TET: `transform_query → extract_data → transform_data`. | `providers/<name>/.../models/<endpoint>.py` | Turn a standard query into *this provider's* call, hit the wire, normalize the response back to `list[Data]`. |
| **`Provider`** | A provider package's **manifest**: `{name, website, description, credentials, fetcher_dict}`. One per provider package, declared in its `__init__.py`. | `providers/<name>/__init__.py` | "I am provider X; here are my credentials and my `{endpoint → Fetcher}` map." |
| **`ProviderInterface` / `Registry`** | The **singleton** that maps every installed `Provider` → its callables, and resolves `provider=` at execution. | `core/provider/registry.py` (ours) | The phone book + the operator: find the fetcher, scope the credential, run it. |

`Fetcher`, `QueryParams`, `Data`, and the TET method contract are the subject of `theory-tet-fetcher-contract.md`. **This file owns `Provider`,
the registry, discovery, selection, fallback, and credentials.** We restate the `Fetcher`'s `fetch_data` orchestration only where the registry calls it.

OpenBB's own names, for cross-reference when you read their source: the abstract `Provider` is
`openbb_core.provider.abstract.provider.Provider`; the abstract `Fetcher` is `openbb_core.provider.abstract.fetcher.Fetcher`; the singleton is
`openbb_core.provider.registry_map.RegistryMap` fronted by `openbb_core.app.provider_interface.ProviderInterface`; discovery is
`openbb_core.app.extension_loader.ExtensionLoader`. We reproduce the *shapes* of these, named for our line.

---

## 2. The `Provider` manifest — one per provider package

### 2.1 The shape we are reproducing (OpenBB, for study only)

OpenBB's `Provider` constructor — read at
`github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/provider.py` — has this signature
(transcribed from the source, **not imported**):

```python
# OpenBB's shape — STUDY ONLY, we re-implement below, we do NOT import this.
class Provider:
    def __init__(
        self,
        name: str,
        description: str,
        website: str | None = None,
        credentials: list[str] | None = None,
        fetcher_dict: dict[str, type[Fetcher]] | None = None,
        repr_name: str | None = None,
        deprecated_credentials: dict[str, str | None] | None = None,
        instructions: str | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.website = website
        self.fetcher_dict = fetcher_dict or {}
        self.repr_name = repr_name
        self.deprecated_credentials = deprecated_credentials
        self.instructions = instructions
        # CRITICAL detail: credentials are NAMESPACED by provider name at construction.
        self.credentials = []
        if credentials:
            for c in credentials:
                self.credentials.append(f"{self.name.lower()}_{c}")
```

The single **load-bearing detail** here, and the thing most people miss: **OpenBB does not store `"api_key"`; it stores `"fmp_api_key"`.** A
provider declaring `credentials=["api_key"]` ends up with `self.credentials == ["fmp_api_key"]`. This is why the global credential dict is keyed
`{provider}_{credential}` — it lets every provider declare the generic `"api_key"` while the registry keeps a flat, collision-free namespace.
(Verified against `provider.py` on the `develop` branch: each `c` becomes `f"{self.name.lower()}_{c}"`.)

A real `Provider` declaration — OpenBB's FMP, read at
`github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/openbb_fmp/__init__.py` (excerpted; FMP ships ~76 fetchers):

```python
# OpenBB FMP __init__.py — STUDY ONLY.
fmp_provider = Provider(
    name="fmp",
    website="https://financialmodelingprep.com",
    description="""Financial Modeling Prep is a new concept that informs you about
stock market information ...""",
    credentials=["api_key"],
    fetcher_dict={
        "EquityQuote": FMPEquityQuoteFetcher,
        "EquityHistorical": FMPEquityHistoricalFetcher,
        "BalanceSheet": FMPBalanceSheetFetcher,
        "IncomeStatement": FMPIncomeStatementFetcher,
        "TreasuryRates": FMPTreasuryRatesFetcher,
        # ... ~70 more endpoint → Fetcher entries ...
    },
    repr_name="Financial Modeling Prep (FMP)",
    deprecated_credentials={"API_KEY_FINANCIALMODELINGPREP": "fmp_api_key"},
    instructions="Go to: https://site.financialmodelingprep.com/developer/docs ...",
)
```

Note `fetcher_dict` is keyed by **standardized endpoint name** (`"EquityQuote"`), not by the provider's own URL. That key is the contract the
registry indexes on: *"who can serve `EquityQuote`?"* → *"fmp, twelve_data, tiingo."*

### 2.2 Our re-implementation (clean-room, for the data-analytics line)

We re-derive the same shape with a frozen dataclass. We keep the namespacing, drop OpenBB-specific cruft (`deprecated_credentials` migration map,
`repr_name`), and add **one field OpenBB lacks but our line needs: `commercial_ok` / licence provenance per provider**, because our charter is the
GREEN/RED display-licence gate (mirrored from Lumina's `commercial-ok-gate`).

```python
# core/provider/abstract/provider.py  — OURS. Clean-room.
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal

from .fetcher import Fetcher  # our abstract base; see theory-tet-fetcher-contract.md

LicenceClass = Literal["GREEN", "YELLOW", "RED"]


@dataclass(frozen=True, slots=True)
class Provider:
    """A provider package's manifest. One per installed provider extension.

    Declared in the package's __init__.py and exposed via a pyproject entry point
    (see §4). The registry discovers these at startup.
    """

    name: str
    description: str
    fetcher_dict: dict[str, type[Fetcher]] = field(default_factory=dict)
    website: str | None = None
    instructions: str | None = None
    # Generic credential keys the provider's fetchers need, e.g. ["api_key"].
    # NAMESPACED to f"{name}_{key}" by __post_init__ (see below).
    credentials: tuple[str, ...] = ()
    # OUR addition: the display-licence verdict for this fetch PATH.
    # Default RED — a free API tier is NOT a commercial-display licence.
    licence: LicenceClass = "RED"
    # When licence is CC-BY, the attribution string the surface MUST render.
    attribution: str | None = None

    def namespaced_credentials(self) -> tuple[str, ...]:
        """('api_key',) on provider 'fmp' -> ('fmp_api_key',)."""
        return tuple(f"{self.name.lower()}_{c}" for c in self.credentials)
```

> **Why a frozen dataclass, not a Pydantic model?** A `Provider` is a *static declaration* loaded once at import; it never round-trips through
> JSON validation. `frozen=True, slots=True` makes it immutable (a registry entry must not mutate after discovery) and cheap. `QueryParams`/`Data`
> *are* Pydantic v2 models — they validate request/response data on every call — but the manifest is config, not data.

> **Why `licence` lives on the `Provider`, not the `Fetcher`?** The commercial-display licence **attaches to the fetch PATH, not the concept**
> (the exact rule from `commercial-ok-gate.md`: the US 10Y yield from treasury.gov is GREEN; the *same number* from a vendor chart API is RED).
> The provider *is* the fetch path. Putting `licence` here means the registry can refuse to select a RED provider for a *display* surface
> (§5.4) without the analytics layer ever re-litigating it. Default `RED` so a forgotten field fails closed.

A concrete provider declaration in our line — the GREEN US-Treasury provider:

```python
# providers/treasury/treasury_provider/__init__.py  — OURS.
from core.provider.abstract.provider import Provider
from .models.treasury_rates import TreasuryRatesFetcher
from .models.yield_curve import TreasuryYieldCurveFetcher

treasury_provider = Provider(
    name="treasury",
    website="https://home.treasury.gov",
    description="U.S. Department of the Treasury — daily par yield curve rates, "
    "public domain (17 U.S.C. §105).",
    credentials=(),               # keyless — public-domain gov source
    licence="GREEN",              # public domain → display OK
    fetcher_dict={
        "TreasuryRates": TreasuryRatesFetcher,
        "YieldCurve": TreasuryYieldCurveFetcher,
    },
)
```

And a keyed, RED-by-default vendor provider:

```python
# providers/twelve_data/twelve_data_provider/__init__.py  — OURS.
from core.provider.abstract.provider import Provider
from .models.equity_quote import TwelveDataEquityQuoteFetcher
from .models.equity_historical import TwelveDataEquityHistoricalFetcher

twelve_data_provider = Provider(
    name="twelve_data",
    website="https://twelvedata.com",
    description="Twelve Data — real-time and historical equity, FX, and crypto.",
    credentials=("api_key",),     # -> ('twelve_data_api_key',) after namespacing
    licence="RED",                # free tier is NOT a display licence; keep RED
    fetcher_dict={
        "EquityQuote": TwelveDataEquityQuoteFetcher,
        "EquityHistorical": TwelveDataEquityHistoricalFetcher,
    },
)
```

---

## 3. The registry / `ProviderInterface` singleton

### 3.1 What OpenBB's singleton actually is

OpenBB's docs describe `ProviderInterface` as *"the map of all installed provider extensions to their respective callables, and is a Singleton
accepting no initialization parameters"* and *"Each item in the `ProviderInterface` maps to a `Fetcher`, which executes the TET pattern"*
(`docs.openbb.co/odp/python/developer/architecture_overview`). Under it sits `RegistryMap`, which iterates every provider's `fetcher_dict` to build
the inverted index:

```python
# OpenBB RegistryMap — STUDY ONLY (registry_map.py, develop branch).
def _get_maps(self, registry):
    # builds a 3-level map: {model_name: {provider_name: {query/data info}}}
    for p in registry.providers:
        for model_name, fetcher in registry.providers[p].fetcher_dict.items():
            ...  # records that provider `p` can serve `model_name` via `fetcher`

def _get_credentials(self, registry) -> dict[str, list[str]]:
    return {name: provider.credentials
            for name, provider in registry.providers.items()}

def _get_available_providers(self, registry) -> list[str]:
    return sorted(list(registry.providers.keys()))
```

The two structures that matter: **`{provider_name → Provider}`** (the phone book) and the **inverted `{endpoint → {provider → Fetcher}}`** (the
selection index). Everything else (credential maps, available-provider lists) is derived from those two.

### 3.2 Our singleton

```python
# core/provider/registry.py  — OURS. Clean-room re-implementation.
from __future__ import annotations
import threading
from collections import defaultdict
from typing import Iterable

from .abstract.provider import Provider
from .abstract.fetcher import Fetcher


class ProviderNotFound(LookupError):
    pass


class FetcherNotFound(LookupError):
    pass


class Registry:
    """The provider phone book + the selection index.

    Built once from the set of installed Provider objects (see §4 for how they
    are discovered). Read-mostly after construction.
    """

    def __init__(self, providers: Iterable[Provider]) -> None:
        self._providers: dict[str, Provider] = {}
        # inverted index: endpoint -> {provider_name -> Fetcher}
        self._index: dict[str, dict[str, type[Fetcher]]] = defaultdict(dict)
        for p in providers:
            self._include(p)

    def _include(self, provider: Provider) -> None:
        key = provider.name.lower()
        if key in self._providers:
            # Two packages claiming the same name is a hard config error, not a warning.
            raise ValueError(f"Duplicate provider name: {key!r}")
        self._providers[key] = provider
        for endpoint, fetcher in provider.fetcher_dict.items():
            self._index[endpoint][key] = fetcher

    # ---- phone book -------------------------------------------------------
    @property
    def providers(self) -> dict[str, Provider]:
        return dict(self._providers)

    @property
    def available_providers(self) -> list[str]:
        return sorted(self._providers)

    def get_provider(self, name: str) -> Provider:
        key = name.lower()
        if key not in self._providers:
            raise ProviderNotFound(
                f"Provider {key!r} not installed. "
                f"Available: {self.available_providers}"
            )
        return self._providers[key]

    # ---- selection index --------------------------------------------------
    def providers_for(self, endpoint: str) -> list[str]:
        """Which installed providers can serve this endpoint, sorted."""
        return sorted(self._index.get(endpoint, {}))

    def get_fetcher(self, endpoint: str, provider: str) -> type[Fetcher]:
        key = provider.lower()
        prov = self.get_provider(key)                  # raises ProviderNotFound
        if endpoint not in prov.fetcher_dict:
            raise FetcherNotFound(
                f"Provider {key!r} has no fetcher for endpoint {endpoint!r}. "
                f"It serves: {sorted(prov.fetcher_dict)}"
            )
        return prov.fetcher_dict[endpoint]


# ---- the singleton -------------------------------------------------------
_LOCK = threading.Lock()
_REGISTRY: Registry | None = None


def get_registry() -> Registry:
    """Thread-safe lazy singleton. Built from discovered providers (§4)."""
    global _REGISTRY
    if _REGISTRY is None:
        with _LOCK:
            if _REGISTRY is None:
                from .discovery import discover_providers   # §4
                _REGISTRY = Registry(discover_providers())
    return _REGISTRY
```

> **Singleton, but built once — not a god object.** The registry is read-mostly: discovered at first access, then only *queried*. The
> double-checked lock guards the *build*, not every read (reads of an immutable dict need no lock in CPython). On FastAPI this should be primed in
> the **lifespan** startup (see the sibling `python-fastapi-data-service` skill's `dependency-injection-and-lifespan.md`) so the entry-point scan
> happens once at boot, never on the request path. **Do not** rebuild the registry per request — entry-point discovery touches the filesystem and
> imports modules; that is boot work.

---

## 4. Discovery — two roads, and which we take

There are exactly two ways the registry gets its set of `Provider` objects:

* **Road A — entry-point discovery (what OpenBB does):** each provider is a *separately installed package* that advertises its `Provider` object
  via a `pyproject.toml` entry point. The registry scans installed entry points at runtime. Open ecosystem; any third party can `pip install
  openbb-some-provider` and it appears.
* **Road B — an explicit in-repo registry dict (likely what WE want):** providers live in our own monorepo; a single module imports each
  `Provider` and lists them. Closed set; no scanning, no surprise plugins.

### 4.1 Road A — entry-point discovery (the OpenBB shape)

The provider package declares the entry point. OpenBB uses Poetry's plugin table; the **PEP 621 standard** equivalent is `[project.entry-points]`.
Both compile to the same `entry_points.txt` in the wheel's `.dist-info`.

**Poetry form** (OpenBB's FMP — verified at
`github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/pyproject.toml`):

```toml
[tool.poetry.plugins."openbb_provider_extension"]
fmp = "openbb_fmp:fmp_provider"
```

**PEP 621 standard form** (what we'd write with setuptools/hatchling/uv —
`packaging.python.org/en/latest/specifications/entry-points/` and `peps.python.org/pep-0621/`):

```toml
[project.entry-points."jpm_data_provider"]
treasury    = "treasury_provider:treasury_provider"
twelve_data = "twelve_data_provider:twelve_data_provider"
```

The value format is **`name = "module:attr"`** — the spec resolves it by
`importlib.import_module(module)` then `getattr` down the `attr` path
(`packaging.python.org/.../entry-points/`: *"`modname, _, qualname = object_ref.partition(':'); obj = import_module(modname); for attr in
qualname.split('.'): obj = getattr(obj, attr)"`). The **group** (`"jpm_data_provider"`) is the namespace the loader queries.

The loader, re-derived from `importlib.metadata` (current stdlib API, Python 3.12+ — `docs.python.org/3/library/importlib.metadata.html`):

```python
# core/provider/discovery.py  — OURS, Road A. Clean-room of ExtensionLoader.
from __future__ import annotations
import logging
from importlib.metadata import entry_points, EntryPoint

from .abstract.provider import Provider

log = logging.getLogger(__name__)

# Our entry-point group. PyPI-owned-prefix convention says prefix with our org.
PROVIDER_GROUP = "jpm_data_provider"


def discover_providers() -> list[Provider]:
    """Scan installed packages for advertised Provider objects.

    entry_points(group=...) returns an EntryPoints collection (3.12+); each
    EntryPoint has .name/.value/.group and a .load() that imports module:attr.
    """
    found: list[Provider] = []
    eps = entry_points(group=PROVIDER_GROUP)   # EntryPoints, NOT a dict (3.12+)
    for ep in eps:                             # ep: EntryPoint(name, value, group)
        try:
            obj = ep.load()                    # import module, getattr the attr
        except ModuleNotFoundError:
            # A provider's own deps aren't installed -> skip it, don't crash boot.
            log.warning("provider %r skipped: module not importable", ep.name)
            continue
        if not isinstance(obj, Provider):
            log.error("entry point %r did not resolve to a Provider (%r)",
                      ep.name, type(obj).__name__)
            continue
        found.append(obj)
    return found
```

Verified API facts behind this code:

* `entry_points(group="...")` **returns an `EntryPoints` collection, not a dict** — *"Changed in version 3.12: `entry_points()` now always
  returns an `EntryPoints` object instead of a dictionary."* (`docs.python.org/3/library/importlib.metadata.html`). The pre-3.10 dict-keyed-by-group
  API is deprecated; do **not** write `entry_points()["jpm_data_provider"]`.
* Each `EntryPoint` exposes `.name`, `.value` (e.g. `'twelve_data_provider:twelve_data_provider'`), `.group`, `.module`, `.attr`, and `.load()`
  (same source). `.load()` does the `import_module` + `getattr` walk.
* OpenBB's loader does exactly this — `ExtensionLoader._sorted_entry_points` calls `sorted(entry_points(group=group))` over the group
  `"openbb_provider_extension"`, defined in an `OpenBBGroups(Enum)`, and its `load_provider` loop calls `ep.load()`, `isinstance(..., Provider)`
  checks the result, and `except ModuleNotFoundError: continue` to tolerate uninstalled optional providers (read at
  `openbb_platform/core/openbb_core/app/extension_loader.py`, develop branch). We reproduce the **isinstance guard** and the **skip-on-missing-module**
  behavior because both are correctness-load-bearing: the guard stops a typo'd entry point from poisoning the registry; the skip stops one optional
  provider's missing dependency from taking down the whole service at boot.

### 4.2 Road B — the explicit in-repo registry (what WE should ship first)

For a **closed set of vetted, mostly-GREEN providers in our own monorepo**, entry-point discovery is *machinery we don't need and a risk we don't
want*. The explicit dict:

```python
# core/provider/discovery.py  — OURS, Road B. The closed-set form.
from __future__ import annotations
from .abstract.provider import Provider

# Import each provider's manifest directly. No scanning, no entry points.
from providers.treasury import treasury_provider
from providers.bls import bls_provider
from providers.fred import fred_provider
from providers.twelve_data import twelve_data_provider
from providers.fmp import fmp_provider
from providers.coingecko import coingecko_provider

# The single source of truth for "what providers exist."
INSTALLED_PROVIDERS: tuple[Provider, ...] = (
    treasury_provider,
    bls_provider,
    fred_provider,
    twelve_data_provider,
    fmp_provider,
    coingecko_provider,
)


def discover_providers() -> list[Provider]:
    return list(INSTALLED_PROVIDERS)
```

`get_registry()` from §3.2 is unchanged — it calls `discover_providers()` either way. **That is the point of the seam:** Road A and Road B differ in
*one function*; the registry, selection, and credential logic never know which road built them.

### 4.3 The trade-off — and the recommendation

| Dimension | Road A — entry points | Road B — explicit dict |
|---|---|---|
| **Who can add a provider** | Any installed package; third parties, plugins, private wheels. | Only us, by editing `INSTALLED_PROVIDERS` and importing. |
| **Coupling** | Loose — providers are independently versioned/installable packages. | Tight — one repo, one deploy, shared version. |
| **Startup cost** | A filesystem + metadata scan, plus a `.load()` import per provider. | Plain imports; the import graph is static and analyzable. |
| **Failure mode** | A broken/incompatible 3rd-party wheel can crash or poison boot; must be defended (isinstance guard, skip-on-error). | A bad import fails the build/test, not production boot. **Statically checkable.** |
| **Supply-chain surface** | Anything advertising the group string runs `.load()` (arbitrary import) at boot. **A real attack surface.** | Closed — only code in our repo runs. |
| **Licence governance** | A 3rd-party provider could ship `licence="GREEN"` falsely; you must re-audit every discovered provider. | Every provider is in-repo and reviewed; the GREEN/RED verdict is in our diff. |
| **Tooling** | Harder to grep "where is provider X used"; discovery is dynamic. | `grep INSTALLED_PROVIDERS` and you have the whole set. |
| **When it wins** | A genuine *open ecosystem* with external contributors (OpenBB's actual situation). | A *product* with a curated, licence-gated provider set (**our** situation). |

**Recommendation for the data-analytics line: ship Road B.** Reasons, in priority order:

1. **Licence governance is our charter.** Our non-negotiable is the GREEN/RED display-licence gate. A provider's `licence` field is a legal claim
   we are accountable for. Road A would let an *installed wheel* assert `licence="GREEN"` and have the registry believe it — we'd have to re-audit
   every discovered provider at runtime, which defeats the purpose. Road B keeps every licence verdict **in our reviewed source tree.**
2. **Closed set, no ecosystem.** We are not building a plugin marketplace; we have a known, small set of providers (GREEN gov sources + a few
   vetted vendors). Entry-point discovery solves a problem we don't have.
3. **Static analyzability.** `discover_providers()` returning a literal tuple means the whole provider graph is visible to type-checkers, importable
   in tests, and greppable. A dynamic scan is none of these.
4. **No arbitrary-import boot surface.** `ep.load()` imports and executes whatever advertises the group string. For a service touching credentials,
   that is an attack surface we simply delete by not scanning.

**Keep the seam, though.** `discover_providers()` is the only function that differs. If we ever *do* open the line to external providers, we swap
Road B for Road A behind that one function — and we'd add an **allow-list + licence re-audit** step on top of `.load()`, never trusting a discovered
provider's self-asserted `licence`. Design the seam now; choose Road B today.

> **The OpenBB lesson, stated plainly:** OpenBB's entry-point design is *correct for OpenBB* because OpenBB *is* an open data ecosystem — its whole
> value proposition is "pip install another provider." Copying the entry-point machinery into a closed, licence-gated product is **cargo-culting the
> pattern without its constraint** (the exact anti-pattern the CTO rules name). Take the *registry + Provider + Fetcher shapes*; leave the discovery
> mechanism unless and until you have OpenBB's constraint.

---

## 5. Selection + credential scoping at request time

This is the operator half: given an analytics call, pick the fetcher, **scope the credential to that provider**, run it, and fall back if needed.

### 5.1 How OpenBB scopes credentials (the shape we reproduce)

OpenBB's `QueryExecutor` (read at `openbb_platform/core/openbb_core/provider/query_executor.py`, develop branch) does three things in order —
`get_provider`, `get_fetcher`, `filter_credentials` — then calls `fetcher.fetch_data(params, credentials)`. The credential filter is the
load-bearing part:

```python
# OpenBB filter_credentials — STUDY ONLY (query_executor.py, develop branch).
@staticmethod
def filter_credentials(credentials, provider, require_credentials):
    filtered = {}
    if provider.credentials:               # e.g. ['fmp_api_key'] (already namespaced)
        for c in provider.credentials:
            v = credentials.get(c)          # pull ONLY this provider's keys
            secret = v.get_secret_value() if v else None
            if c not in credentials or not secret:
                if require_credentials:
                    raise OpenBBError(f"Missing credential '{c}'.")
            else:
                filtered[c] = secret
    return filtered
```

Two facts to carry into ours:

* **The executor passes only the keys in `provider.credentials`** — a `Fetcher` for `fmp` receives `{"fmp_api_key": "..."}` and **nothing else**.
  It cannot see `twelve_data_api_key`. This is least-privilege per fetch: a provider adapter sees exactly the credentials it declared, no more.
* **`require_credentials`** is a per-`Fetcher` class attribute (OpenBB defaults it `True`; read at
  `openbb_platform/core/openbb_core/provider/abstract/fetcher.py`: `require_credentials = True`). A fetcher can set it `False` for an endpoint that
  works without a key even though the provider *has* keyed endpoints — "useful if a provider has some endpoints requiring API keys, but not all"
  (OpenBB docs). The filter raises **only** when a required credential is missing.

And the `Fetcher.fetch_data` orchestration the executor calls (transcribed from `fetcher.py`, develop branch — the TET pipeline detailed in
`theory-tet-fetcher-contract.md`):

```python
# OpenBB Fetcher.fetch_data — STUDY ONLY.
@classmethod
async def fetch_data(cls, params, credentials=None, **kwargs):
    query = cls.transform_query(params=params)
    data = await maybe_coroutine(
        cls.extract_data, query=query, credentials=credentials, **kwargs
    )
    return cls.transform_data(query=query, data=data, **kwargs)
```

The credential dict reaches the fetcher only as the `credentials` argument to `extract_data`. The model/analytics-caller supplies `params`;
**it never supplies `credentials`.** That separation is the whole confused-deputy defense — formalized next.

### 5.2 The confused-deputy defense — credentials by closure, never by param

**The rule (Lumina non-negotiable #6, re-grounded for this line):** *the secret is injected by the trusted layer, scoped to the provider; the
model and the user never name, supply, or choose a credential.*

A **confused deputy** is a privileged component tricked into using its authority on behalf of a less-privileged caller. Here the deputy is the
*executor*: it holds every provider's API key. If the *caller* (an LLM tool call, or a user request) could name which credential to use, a prompt
injection could say *"fetch with `credentials={'admin_internal_key': '...'}'"* or coerce the executor to leak one provider's key to another
provider's URL. The defense: **the caller supplies only `params` (the standardized query — symbol, dates); the executor pulls the credential from a
server-side vault, keyed by the resolved provider, and injects it.** The credential is never in the caller's input surface.

```python
# core/provider/credentials.py  — OURS.
from __future__ import annotations
import os
from pydantic import SecretStr

from .abstract.provider import Provider


class CredentialStore:
    """Server-side vault. The ONLY place provider secrets are read.

    In the data-analytics line, secrets come from env / a secrets manager
    (Fly secrets, AWS SM, etc.) — NEVER from a request body, query param, or
    an LLM tool argument.
    """

    def __init__(self, source: dict[str, str] | None = None) -> None:
        # keys are namespaced: 'fmp_api_key', 'twelve_data_api_key', ...
        self._secrets: dict[str, SecretStr] = {
            k.lower(): SecretStr(v)
            for k, v in (source if source is not None else os.environ).items()
        }

    def scoped_for(self, provider: Provider) -> dict[str, str]:
        """Return ONLY the credentials this provider declared, unwrapped.

        Least privilege: an FMP fetcher gets {'fmp_api_key': ...} and nothing
        else. A keyless provider (treasury) gets {}.
        """
        scoped: dict[str, str] = {}
        for key in provider.namespaced_credentials():   # ('fmp_api_key',)
            secret = self._secrets.get(key)
            if secret is not None:
                scoped[key] = secret.get_secret_value()
        return scoped
```

> **`SecretStr` so a stray `repr`/log line can't leak the key.** Pydantic's `SecretStr` renders as `'**********'` in `repr`/`str`/JSON and
> only yields the value via `.get_secret_value()` (Pydantic v2 docs). We hold secrets as `SecretStr` in the store and unwrap **only** at the moment
> of injection into the fetcher's `extract_data`. A structured-log line that accidentally captures the credentials dict before unwrap prints stars,
> not the key.

> **Where the key must NOT appear:** not in a `QueryParams` field, not in a route's request model, not in an LLM tool's input schema, not in a URL
> we log, not in an error message. The grep test: `git grep -n "api_key"` should hit `CredentialStore`, `Provider.credentials`, and the fetcher's
> *use* of `credentials["..._api_key"]` — and **never** a Pydantic request model or a tool argument schema.

### 5.3 The executor — putting selection + scoping together

```python
# core/provider/executor.py  — OURS. The request-time operator.
from __future__ import annotations
from typing import Any

from .registry import Registry, get_registry
from .credentials import CredentialStore
from .abstract.data import Data


class MissingCredential(RuntimeError):
    pass


class QueryExecutor:
    def __init__(self, registry: Registry, creds: CredentialStore) -> None:
        self._registry = registry
        self._creds = creds

    async def execute(
        self,
        endpoint: str,
        provider: str,
        params: dict[str, Any],
    ) -> list[Data]:
        """Resolve (endpoint, provider) -> Fetcher, scope creds, run TET.

        `params` is the standardized query (symbol/dates/interval). It comes from
        the analytics caller / LLM tool. It contains NO credentials — by design.
        """
        fetcher = self._registry.get_fetcher(endpoint, provider)   # raises if absent
        prov = self._registry.get_provider(provider)

        scoped = self._creds.scoped_for(prov)        # least-privilege dict (§5.2)
        if getattr(fetcher, "require_credentials", True) and prov.credentials \
                and not scoped:
            raise MissingCredential(
                f"Provider {provider!r} requires {prov.namespaced_credentials()} "
                f"for endpoint {endpoint!r}, none configured."
            )

        # The caller never touched `scoped`. Closure-injected here, by the trusted
        # executor, scoped to THIS provider only. Confused-deputy defense holds.
        return await fetcher.fetch_data(params=params, credentials=scoped)
```

Notice the asymmetry that *is* the security model: `execute(endpoint, provider, params)` — the caller chooses **what** (endpoint), **which source**
(provider, from a closed registry of allowed names), and the **standardized inputs** (params). The caller never chooses **the credential**. The
executor derives the credential from the resolved provider via the server-side store. Even a fully-compromised caller can only ask for an
*installed, allowed* provider, and will only ever cause *that provider's* declared key to be used against *that provider's* fetcher.

### 5.4 Fallback across providers

The inverted index (`providers_for(endpoint)`) is what makes fallback trivial: when the preferred provider has no key, is rate-limited, returns
`unavailable`, or is **RED for a display surface**, try the next provider that serves the same endpoint.

```python
# core/provider/executor.py  (continued) — OURS.
from .abstract.provider import LicenceClass


class AllProvidersFailed(RuntimeError):
    def __init__(self, endpoint: str, attempts: list[tuple[str, str]]):
        self.endpoint = endpoint
        self.attempts = attempts   # [(provider, reason), ...]
        super().__init__(f"No provider served {endpoint!r}: {attempts}")


class QueryExecutor(QueryExecutor):   # extend §5.3 for illustration
    async def execute_with_fallback(
        self,
        endpoint: str,
        params: dict[str, Any],
        *,
        prefer: list[str] | None = None,
        require_licence: LicenceClass | None = None,   # 'GREEN' for display surfaces
    ) -> tuple[list[Data], str]:
        """Try providers in order; return (rows, winning_provider).

        Ordering policy (explicit, not array order):
          1. Caller's `prefer` list (e.g. cheapest / freshest first), then
          2. remaining providers that serve the endpoint, GREEN before RED.
        Skips providers that fail the licence gate for the surface.
        """
        candidates = self._ordered_candidates(endpoint, prefer, require_licence)
        attempts: list[tuple[str, str]] = []
        for name in candidates:
            prov = self._registry.get_provider(name)
            # Hard licence gate: a display surface NEVER falls back to RED.
            if require_licence == "GREEN" and prov.licence != "GREEN":
                attempts.append((name, f"licence {prov.licence} != GREEN"))
                continue
            try:
                rows = await self.execute(endpoint, name, params)
            except MissingCredential as e:
                attempts.append((name, f"no-credential: {e}"))
                continue
            except UpstreamRateLimited as e:        # raised by the fetcher layer
                attempts.append((name, f"rate-limited: {e}"))
                continue
            except UpstreamUnavailable as e:
                attempts.append((name, f"unavailable: {e}"))
                continue
            if not rows:
                attempts.append((name, "empty"))
                continue
            return rows, name
        raise AllProvidersFailed(endpoint, attempts)

    def _ordered_candidates(self, endpoint, prefer, require_licence) -> list[str]:
        serving = self._registry.providers_for(endpoint)       # all that can serve
        prefer = [p for p in (prefer or []) if p in serving]
        rest = [p for p in serving if p not in prefer]
        # GREEN-first within `rest` so display surfaces hit a clean source first.
        rest.sort(key=lambda n: self._registry.get_provider(n).licence != "GREEN")
        return prefer + rest
```

**Why fallback ordering is explicit, never array order.** Three real constraints drive provider order and *none* of them is "whatever order the
dict happens to be in": **licence** (a display surface must prefer GREEN and refuse RED — `require_licence="GREEN"` *gates*, it doesn't just sort);
**cost/rate-budget** (free gov sources before metered vendors); **freshness/quality** (a real-time vendor before a 15-min-delayed one for a quote).
The `prefer` list lets the calling surface state its own policy; the GREEN-first sort is the safe default underneath it.

> **Fallback is NOT "invent a number when all fail."** This is the #1 grounding rule of the line (mirrored from Lumina non-negotiable #1). When
> `execute_with_fallback` exhausts every candidate, it raises `AllProvidersFailed` — the surface renders a typed **`unavailable`/`needsKey`** state,
> **never** a fabricated value and **never** a RED-tier backfill "to look complete." A failed fetch is a visible gap, not a silent guess.

> **Idempotency note for the worker path.** Heavy/scheduled ingest (nightly EDGAR XBRL, etc.) runs off-request in the worker (the Vercel/serverless
> boundary rule, mirrored). When a fetch is retried after a partial failure, the *fetcher* must be idempotent at the storage layer (upsert by
> natural key, not blind insert) — fallback at the read path doesn't help a write path that double-inserts. That belongs to the ingest recipe; the
> registry/executor here is the *read/selection* layer.

---

## 6. The end-to-end trace (one request, every object touched)

A FastAPI route asks for the latest 10Y Treasury yield, display surface (must be GREEN):

```
GET /v1/treasury/rates?maturity=10y     (the analytics caller; NO credential in the request)
        │
        ▼
route handler builds params = {"maturity": "10y"}            # standardized QueryParams input
        │
        ▼
QueryExecutor.execute_with_fallback(
    endpoint="TreasuryRates", params=params,
    prefer=["treasury"], require_licence="GREEN")
        │
        ├─ registry.providers_for("TreasuryRates") -> ["fmp", "treasury"]   # inverted index
        ├─ _ordered_candidates -> ["treasury", "fmp"]   # prefer + GREEN-first
        │
        ├─ candidate "treasury": Provider.licence == "GREEN" ✓ (passes display gate)
        │     ├─ registry.get_fetcher("TreasuryRates","treasury") -> TreasuryRatesFetcher
        │     ├─ creds.scoped_for(treasury_provider) -> {}     # keyless gov source
        │     ├─ require_credentials False / no creds needed -> OK
        │     └─ TreasuryRatesFetcher.fetch_data(params, credentials={})
        │            transform_query -> TreasuryRatesQueryParams(maturity="10y")
        │            extract_data    -> GET home.treasury.gov ... (the ONE shared httpx client)
        │            transform_data  -> [TreasuryRatesData(date=..., rate=4.21)]
        │     └─ returns (rows, "treasury")
        ▼
route serializes list[Data] -> JSON, tags Provenance{licence:"GREEN", source:"treasury"}
```

If `treasury` were down, the loop would try `fmp` next — but because the surface passed `require_licence="GREEN"` and `fmp_provider.licence ==
"RED"`, the executor **skips fmp** and raises `AllProvidersFailed` rather than serving a RED number on a display surface. The page renders
`unavailable`. That is the licence gate and the no-fabrication rule both firing through the same selection path.

---

## 7. Anti-patterns (mistake → fix)

| # | Mistake | Why it breaks | Fix |
|---|---|---|---|
| 1 | `import openbb_core` to reuse `Provider`/`Fetcher`/`ProviderInterface`. | AGPL-3.0 virally attaches to our backend (`github.com/OpenBB-finance/OpenBB` LICENSE). | Clean-room the **shapes** from this doc; import nothing from OpenBB. |
| 2 | Caller passes `credentials` in `params` / a tool arg / a request body. | Confused-deputy: a prompt injection or malicious request chooses or leaks a secret. | Caller supplies only `params`; the executor injects credentials from the server-side `CredentialStore`, scoped to the resolved provider (§5.2–5.3). |
| 3 | Global flat `{"api_key": ...}` shared across providers. | Wrong key sent to wrong provider; one leak exposes all. | Namespace every credential `{provider}_{key}` at `Provider` construction; `scoped_for` hands a fetcher only its own keys. |
| 4 | Copy OpenBB's entry-point discovery into our closed monorepo. | Cargo-cult: machinery (filesystem scan, arbitrary `ep.load()` import surface, self-asserted licences) for an ecosystem we don't have. | Road B — explicit `INSTALLED_PROVIDERS` tuple; keep the `discover_providers()` seam to swap to Road A later if ever needed (§4.3). |
| 5 | Trust a discovered provider's `licence="GREEN"`. | A third-party wheel could falsely claim GREEN and slip a RED source onto a display surface. | Every provider's licence verdict lives in our reviewed source (Road B). If you ever go Road A, re-audit each discovered provider's licence against the ledger; never trust the self-assertion. |
| 6 | Rebuild the registry / re-scan entry points per request. | Filesystem + import work on the hot path; latency and thundering-herd at boot spikes. | Build the singleton once in FastAPI lifespan startup; reads are lock-free dict lookups (§3.2). |
| 7 | Fallback in array/dict order. | Serves a RED or delayed source when a GREEN/real-time one was available; non-deterministic. | Explicit ordering: caller `prefer` list, then GREEN-first; `require_licence="GREEN"` *gates* display surfaces (§5.4). |
| 8 | On all-providers-fail, return last cached value or a zero/placeholder. | Fabricates a finance number (non-negotiable #1) or silently serves stale data as live. | Raise `AllProvidersFailed`; surface renders typed `unavailable`/`needsKey`. Never backfill (§5.4). |
| 9 | `entry_points()["jpm_data_provider"]` (dict-key form). | Deprecated/removed: `entry_points()` returns an `EntryPoints` collection in 3.12+, not a dict (`docs.python.org/3/library/importlib.metadata.html`). | `entry_points(group="jpm_data_provider")`. |
| 10 | No `isinstance(obj, Provider)` guard after `ep.load()` (Road A). | A typo'd entry point resolves to *some* object and poisons the registry; a missing dep crashes boot. | Guard the type; `except ModuleNotFoundError: continue` to tolerate optional providers (mirrors OpenBB's `load_provider`). |
| 11 | One `Fetcher` instance reused with mutable per-request state. | TET methods are `@staticmethod`/`@classmethod` on the class for a reason — fetchers are stateless; instance state leaks across concurrent requests. | Keep fetchers stateless; per-request data lives in the `query`/`credentials` arguments, not on the class. (See `theory-tet-fetcher-contract.md`.) |
| 12 | Logging the `credentials` dict or the resolved URL with the key in it. | Secret leaks to logs/observability. | Hold secrets as `SecretStr`; unwrap only at injection; never log the credentials dict or a key-bearing URL. |

---

## 8. Output contract — what "done" looks like for this layer

A correct provider-registry plugin layer for the data-analytics line satisfies **all** of:

1. **`Provider` manifest** — a frozen, immutable per-package object with `{name, description, fetcher_dict, credentials, licence}`; credentials
   namespaced `{provider}_{key}`; `licence` defaults `RED` (fail-closed). One per provider package, in its `__init__.py`.
2. **Registry singleton** — built once, thread-safe lazy or lifespan-primed; exposes the phone book (`get_provider`, `available_providers`) and the
   inverted index (`providers_for(endpoint)`, `get_fetcher(endpoint, provider)`); duplicate provider names are a hard error.
3. **Discovery seam** — a single `discover_providers()` function; **Road B (explicit `INSTALLED_PROVIDERS`)** for our closed, licence-gated set, with
   the seam kept clean so Road A (entry points) is a one-function swap. Road A, if used, guards `isinstance(..., Provider)` and skips missing modules.
4. **Credential scoping** — a server-side `CredentialStore` (secrets as `SecretStr`, sourced from env/secrets-manager, **never** from request input);
   `scoped_for(provider)` returns least-privilege — only that provider's declared keys.
5. **Confused-deputy defense** — the executor's API is `execute(endpoint, provider, params)`; the caller never supplies, names, or chooses a
   credential; the secret is closure/registry-injected, scoped to the resolved provider.
6. **Selection + fallback** — `(endpoint, provider)` resolves to exactly one fetcher; `execute_with_fallback` orders candidates by explicit policy
   (`prefer` + GREEN-first), **gates display surfaces with `require_licence="GREEN"`**, and on exhaustion raises `AllProvidersFailed` → typed
   `unavailable` (no fabrication, no RED backfill).
7. **Clean-room** — zero imports from `openbb-core`; the shapes are re-derived; OpenBB references are study-only.
8. **No hot-path scanning** — entry-point discovery / registry build happens at boot, never per request.

If any of 1–8 is missing, the layer is not done — it is a Tier-1 sketch wearing senior vocabulary.

---

## 9. Sources (read this run)

Primary OpenBB source (studied for shapes; **not imported** — AGPL-3.0):

- `docs.openbb.co/odp/python/developer/architecture_overview` — `ProviderInterface` described as *"the map of all installed provider extensions to
  their respective callables, and is a Singleton accepting no initialization parameters"*; *"Each item in the `ProviderInterface` maps to a
  `Fetcher`, which executes the TET pattern."* Provider fields (`name/website/description/credentials/fetcher_dict/repr_name/instructions`);
  `require_credentials` semantics.
- `github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/provider.py` — `Provider.__init__` signature;
  the **credential namespacing** `self.credentials.append(f"{self.name.lower()}_{c}")`; `fetcher_dict: dict[str, type[Fetcher]] | None` stored as
  `fetcher_dict or {}`.
- `github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/core/openbb_core/provider/abstract/fetcher.py` — `Fetcher` generics `(Q, R)`;
  `require_credentials = True` default; `transform_query`/`extract_data`/`aextract_data`/`transform_data`; the `fetch_data` classmethod chaining
  TET and passing `credentials` through to `extract_data`.
- `github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/openbb_fmp/__init__.py` — a real `Provider(...)` call:
  `name="fmp"`, `credentials=["api_key"]`, a `fetcher_dict` of ~76 `{endpoint → Fetcher}` entries, `deprecated_credentials`, `instructions`.
- `github.com/OpenBB-finance/OpenBB/blob/develop/openbb_platform/providers/fmp/pyproject.toml` — the entry-point declaration
  `[tool.poetry.plugins."openbb_provider_extension"]` with `fmp = "openbb_fmp:fmp_provider"`.
- `openbb_platform/core/openbb_core/app/extension_loader.py` (develop) — `OpenBBGroups(Enum)` with `provider = "openbb_provider_extension"`;
  discovery via `entry_points(group=...)`; `load_provider` loop with `ep.load()`, `isinstance(entry, Provider)` guard, `except ModuleNotFoundError:
  continue`.
- `openbb_platform/core/openbb_core/provider/query_executor.py` (develop) — `get_provider`/`get_fetcher`/`filter_credentials`; the filter pulls
  **only** keys in `provider.credentials`, unwraps `SecretStr`, raises on missing required credential.
- `openbb_platform/core/openbb_core/provider/registry_map.py` (develop) — `_get_maps` nested loop over `registry.providers[p].fetcher_dict.items()`
  building `{model_name: {provider_name: ...}}`; `_get_credentials`, `_get_available_providers`.
- `openbb_platform/core/openbb_core/provider/registry.py` (develop) — the load loop `for name, entry in
  ExtensionLoader().provider_objects.items(): registry.include_provider(provider=entry)`; debug-mode `LoadingError` vs normal-mode `OpenBBWarning`.

Standards / stdlib (the basis for our clean-room re-implementation):

- `packaging.python.org/en/latest/specifications/entry-points/` — entry-point data model (group/name/object-reference); object-ref resolution
  `import_module(modname)` + `getattr` walk; the `name = "module:attr"` value format; `entry_points.txt` in `.dist-info`.
- `peps.python.org/pep-0621/` — the standard `[project.entry-points."group"]` table in `pyproject.toml` (vs Poetry's `[tool.poetry.plugins]`; both
  compile to the same metadata).
- `packaging.python.org/en/latest/guides/writing-pyproject-toml/` — `[project.entry-points.GROUP]` with `entry_name = "module:attr"`; supported by
  setuptools and hatchling.
- `docs.python.org/3/library/importlib.metadata.html` — `entry_points(group="...")` returns an `EntryPoints` collection (**"Changed in version
  3.12: now always returns an `EntryPoints` object instead of a dictionary"**); `EntryPoint` fields `.name/.value/.group/.module/.attr` and
  `.load()`; `.select(group=, name=)`.

Our charter (the rules these patterns enforce):

- `CLAUDE.md` non-negotiable #6 — *secure tool args by closure; `userId`/secrets injected in the tool factory, the model never supplies them* (the
  confused-deputy defense generalized to the credential store).
- `CLAUDE.md` non-negotiable #1 — *never invent a finance number; failed fetches return typed `unavailable`/`needsKey`* (the no-fabrication
  fallback rule).
- `.claude/rules/commercial-ok-gate.md` — *the licence attaches to the fetch PATH, not the concept; default RED; free tier ≠ display licence* (the
  `Provider.licence` field and the `require_licence="GREEN"` display gate).
