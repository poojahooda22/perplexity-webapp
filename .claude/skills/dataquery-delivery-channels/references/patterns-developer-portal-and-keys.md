# patterns-developer-portal-and-keys

> **Recipe.** The consumer-facing **developer portal + onboarding surface** for the data-analytics
> API: (1) the **docs portal** — Scalar vs Redoc vs Swagger UI, the decision, and the exact FastAPI
> integration; (2) the **self-serve console** — sign up, **create/rotate/revoke API keys** (shown
> once, stored hashed), see usage/quota, pick a **GREEN-only vs RED-fetch-through** tier — built on
> the repo's **React + Vite + Supabase-auth** frontend pattern; (3) how **`commercialOk` + the
> attribution string** surface to the consumer in *both* the docs and the console, so a developer
> knows exactly what they may redistribute. End-to-end runnable code: the FastAPI Scalar route, the
> key-issuance service (generate → prefix → hash → store), the Postgres key table, the verification
> dependency, and the React console pages.
>
> **Product line:** JPM-Markets re-engineering **data-analytics product line — NOT Lumina.** This is
> the DataQuery/Fusion re-engineering (Project 3) **onboarding/delivery** layer. The data-plane stack
> is **Python 3.12 · FastAPI · Pydantic v2 · TimescaleDB** (per `01-plan.md` / `02-skills-and-pipeline.md`);
> the **console** deliberately **reuses Lumina's React + Vite + Supabase-auth frontend pattern** (per
> `02-skills-and-pipeline.md` line 168: *"Developer console: API keys, commercialOk surfacing
> (React+Vite+Supabase)"*). Greenfield — every code block below is a **design recipe**, not a
> transcription of shipped files. Reused *patterns* (not files) are cited to the Lumina repo as the
> proven shape.
>
> **The layer line (read this first).** This doc owns the **onboarding surface**: docs rendering, key
> lifecycle, tier selection, and licensing surfacing. It does **not** own: the OpenAPI spec content or
> SDK codegen (→ `api-publishing-sdk-portal` skill's `openapi-as-source-of-truth.md` /
> `sdk-generation.md`); the rate-limit/quota *enforcement* algorithm (→ the gateway's limiter — this
> doc *displays* quota, the gateway *enforces* it); the error envelope (→
> `patterns-error-contract-and-status-codes.md`); the actual data fetch (→
> `patterns-series-retrieval-endpoint.md`). Where this doc needs one of those, it states the *contract*
> and points at the owner.

---

## 0. What this surface is, in one paragraph

DataQuery's product page lists four delivery channels — **Web, API, Batch (SFTP/email), Excel**
([jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery), fetched 2026-06-24).
Every one of them is unusable until a developer can **(a) read what the API does and try it, and
(b) get a credential to call it.** That is the **developer portal**: a *docs* half (the reference a
human or an LLM reads to learn the contract) and a *console* half (where they authenticate, mint an
API key, watch their quota, and choose a tier). JPM gates this behind an enterprise
[developer.jpmorgan.com](https://developer.jpmorgan.com/products/dataquery_api) portal with OAuth2
client-credentials onboarding; we re-engineer the **same two halves** on a free, self-serve stack —
**Scalar** (MIT) for the docs, **React + Vite + Supabase** for the console — and we add the one thing
JPM's portal does **not** carry on every series: an explicit **`commercialOk` + attribution** badge
so the consumer knows, per dataset, what they are *legally allowed to redistribute*. That licensing
badge is the differentiator and the non-negotiable: it must render in both the docs and the console,
and it is sourced from the same `Provenance` stamp the retrieval channel returns.

**The portal at a glance:**

| Half | What it answers | What we use | Where it lives |
|---|---|---|---|
| **Docs portal** | "What can this API do? Let me try a call." | **Scalar** (MIT, branded, embedded API client) — Redoc/Swagger fallback | served by the **FastAPI** app at `/docs` (mounted from the OpenAPI 3.1 spec) |
| **Console** | "Sign me up. Give me a key. Show my usage. Which tier?" | **React + Vite + Supabase-auth** (the Lumina frontend pattern) | a separate SPA at `console.<domain>`, talking to a small set of FastAPI `/console/*` routes |
| **The badge** (both) | "What may I *redistribute*?" | the `Provenance{commercialOk, attribution}` stamp | rendered in the docs (per-tag/per-schema) **and** in the console (per-dataset in the catalog browser) |

---

## 1. Part A — The docs portal: Scalar vs Redoc vs Swagger UI

### 1.1 The three tools, what they actually are

All three render an **OpenAPI 3.1 document** (the one FastAPI emits) into a human-readable reference.
They differ on one axis that matters more than looks: **does the page let you fire a real request
(the "Try It" / embedded API client)?**

| | **Scalar** | **Redoc (OSS)** | **Swagger UI** |
|---|---|---|---|
| Current version | **1.8.2** scalar-fastapi (PyPI, 2026-04-09) ([pypi.org/project/scalar-fastapi](https://pypi.org/project/scalar-fastapi/)) | **2.5.3** (2026-05-29) ([github.com/Redocly/redoc](https://github.com/Redocly/redoc)) | ships *inside* FastAPI (`fastapi.openapi.docs.get_swagger_ui_html`) |
| License | **MIT** ([scalar README: "licensed under MIT"](https://github.com/scalar/scalar/blob/main/integrations/fastapi/README.md)) | **MIT** ([Redocly/redoc badges](https://github.com/Redocly/redoc)) | Apache-2.0 (Swagger UI) |
| **Embedded "Try It" / API client** | **Yes — the strongest of the three.** *"a built-in API client … blurring the lines between API documentation and API client, offering the most powerful Try It of any of the documentation tools"* ([apisyouwonthate.com top-5-2025](https://apisyouwonthate.com/blog/top-5-best-api-docs-tools/)) | **No.** *"the open-source version skips the live request runner"* — the API console is Redocly's **paid** product ([Redocly/redoc; bump.sh top-5-2025](https://bump.sh/blog/top-5-api-docs-tools-in-2025/)) | **Yes** — the original "Try it out" button, the decade-old default |
| Code-sample generation | **Yes** — curl, fetch, Python, Go, PHP, etc. auto-generated ([dev.to best-api-docs-2025](https://dev.to/_d7eb1c1703182e3ce1782/best-api-documentation-tools-for-developers-in-2025-swagger-redoc-scalar-and-more-3d7g)) | code samples only if `x-codeSamples` provided in the spec | minimal (curl only, from the request) |
| Look / layout | modern, themeable, three-pane | clean read-only three-pane, great for **very large** specs | functional but dated; heavier legacy bundle |
| Bundle / perf | *"the lightest of the three despite having more features — modern ESM + tree-shaking"* ([dev.to, same](https://dev.to/_d7eb1c1703182e3ce1782/best-api-documentation-tools-for-developers-in-2025-swagger-redoc-scalar-and-more-3d7g)) | light, read-only | heaviest |
| Best at | a **branded, interactive** developer portal you want people to *use* | a **pristine reference** for a huge spec you want people to *read* | a zero-config default you already have |

### 1.2 The decision — **Scalar primary, Redoc fallback, Swagger UI off**

**Choose Scalar.** Reasoning, in priority order:

1. **The portal's job is to convert a curious developer into a first successful call.** That conversion
   happens in the *Try-It panel* — the developer pastes their key, hits `GET /series/...`, sees a JSON
   body. Scalar's embedded API client is the best of the three at exactly that
   ([apisyouwonthate.com](https://apisyouwonthate.com/blog/top-5-best-api-docs-tools/)), and it
   auto-emits a Python/curl/JS snippet they copy into their own code. Redoc (OSS) **cannot do this** —
   its try-it is a paid Redocly feature — so picking Redoc means shipping a read-only manual and losing
   the conversion moment.
2. **It's MIT and free** ([scalar README](https://github.com/scalar/scalar/blob/main/integrations/fastapi/README.md)),
   self-hostable, and has a **first-class FastAPI plugin** (`scalar-fastapi`, §1.3) — so it costs one
   route, not a build pipeline.
3. **It's the lightest bundle** of the three
   ([dev.to](https://dev.to/_d7eb1c1703182e3ce1782/best-api-documentation-tools-for-developers-in-2025-swagger-redoc-scalar-and-more-3d7g)),
   which matters because the docs page is a public, cacheable, spike-exposed read surface.
4. **It theming-matches a branded portal** — we want the docs to look like *our* product, not a generic
   Swagger page. Scalar's `Theme`/`custom_css` (§1.3) does that without a fork.

**Keep Redoc as the fallback** for one specific reason: if the catalog grows to **tens of thousands of
endpoints/schemas** and Scalar's interactive panel becomes sluggish to render, Redoc's read-only
three-pane is purpose-built for *very large* specs and stays fast. We ship Scalar at `/docs` and can
mount Redoc at `/reference` (read-only) as a parallel surface at near-zero cost (one extra route, §1.5).
This is also the **graceful-degradation** answer: if Scalar's CDN JS fails to load, Redoc (served from a
pinned bundle) is the static backup.

**Turn Swagger UI OFF in production.** FastAPI ships Swagger UI at `/docs` by default. We **disable** it
(`docs_url=None`) and repoint `/docs` at Scalar, because (a) shipping *two* interactive docs surfaces is
confusing and doubles the maintenance, and (b) Swagger UI is the heaviest/oldest of the three with no
advantage here. Keep it available **only behind a flag for local dev** if a contributor prefers it
(§1.6).

> **The one trap:** never run the interactive docs *and* expose your real upstream credentials through
> it. Scalar/Swagger "Try It" fires a request **from the browser**; the consumer must supply *their own*
> API key in the panel. The page must never embed a server-side key, and the spec's `servers` must point
> at the **public gateway** (which enforces auth), never at an internal upstream. See §6 (try-it
> security).

### 1.3 The Scalar FastAPI integration — exact code (scalar-fastapi 1.8.2)

The plugin is `scalar-fastapi` ([PyPI 1.8.2, MIT, 2026-04-09](https://pypi.org/project/scalar-fastapi/)).
It exposes one function, `get_scalar_api_reference`, which returns an `HTMLResponse` that loads the
Scalar JS over your OpenAPI URL. The **full verbatim signature** (read from
`scalar/scalar@main:integrations/fastapi/.../scalar_fastapi.py`) — every parameter and default — so we
know exactly what we can configure:

```python
# scalar-fastapi 1.8.2 — get_scalar_api_reference full signature (verbatim, Doc(...) elided)
def get_scalar_api_reference(
    *,
    openapi_url: str | None = None,
    title: str | None = None,
    content: str | dict | None = None,
    sources: list[OpenAPISource] | None = None,
    scalar_js_url: str = "https://cdn.jsdelivr.net/npm/@scalar/api-reference",
    scalar_proxy_url: str = "",
    scalar_favicon_url: str = "https://fastapi.tiangolo.com/img/favicon.png",
    layout: Layout = Layout.MODERN,
    show_sidebar: bool = True,
    hide_download_button: bool = False,
    document_download_type: DocumentDownloadType = DocumentDownloadType.BOTH,
    hide_test_request_button: bool = False,
    hide_models: bool = False,
    hide_search: bool = False,
    dark_mode: bool = None,
    force_dark_mode_state: str | None = None,
    hide_dark_mode_toggle: bool = False,
    search_hot_key: SearchHotKey = SearchHotKey.K,
    hidden_clients: bool | dict[str, bool | list[str]] | list[str] = [],
    base_server_url: str = "",
    servers: list[dict[str, Any]] = [],
    default_open_all_tags: bool = False,
    expand_all_model_sections: bool = False,
    expand_all_responses: bool = False,
    order_required_properties_first: bool = True,
    order_schema_properties_by: Literal["alpha", "preserve"] = "alpha",
    authentication: dict = {},
    hide_client_button: bool = False,
    persist_auth: bool = False,
    with_default_fonts: bool = True,
    custom_css: str = "",
    integration: str | None = "fastapi",
    theme: Theme = Theme.DEFAULT,
    show_developer_tools: Literal["always", "localhost", "never"] = "localhost",
    telemetry: bool = True,
    agent: AgentScalarConfig | None = None,
    overrides: dict[str, Any] = {},
) -> HTMLResponse: ...
```

The `Layout` and `Theme` enums (verbatim members):

```python
class Layout(str, Enum):
    MODERN = "modern"
    CLASSIC = "classic"

class Theme(str, Enum):
    ALTERNATE = "alternate";  DEFAULT = "default";  MOON = "moon"
    PURPLE = "purple";  SOLARIZED = "solarized";  BLUE_PLANET = "bluePlanet"
    SATURN = "saturn";  KEPLER = "kepler";  MARS = "mars"
    DEEP_SPACE = "deepSpace";  LASERWAVE = "laserwave";  NONE = "none"
```

**The mount** — disable FastAPI's default Swagger UI and ReDoc, keep the OpenAPI JSON, and serve Scalar
at `/docs`:

```python
# app/main.py — the docs portal mount
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from scalar_fastapi import get_scalar_api_reference, Layout, Theme

app = FastAPI(
    title="MarketData API",
    version="1.0.0",
    summary="Time-series market data over a uniform query contract.",
    # Disable BOTH built-in doc UIs. Keep the OpenAPI JSON — Scalar/Redoc/SDKs read it.
    docs_url=None,        # was Swagger UI at /docs
    redoc_url=None,       # was ReDoc at /redoc
    openapi_url="/openapi.json",
)

@app.get("/docs", include_in_schema=False)
async def scalar_docs() -> HTMLResponse:
    return get_scalar_api_reference(
        openapi_url=app.openapi_url,            # "/openapi.json" — the spec FastAPI emits
        title="MarketData API — Reference",
        layout=Layout.MODERN,
        theme=Theme.DEEP_SPACE,                 # brand match
        hide_models=False,                      # show the schemas — consumers need Data/Provenance shapes
        default_open_all_tags=False,            # huge catalog → keep tags collapsed by default
        hide_download_button=False,             # let them grab the spec for codegen
        # PIN the JS so a CDN outage or a Scalar major bump can't change our docs under us:
        scalar_js_url="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.0",
        # The Try-It panel sends requests to THESE servers (the public gateway, never an upstream):
        servers=[{"url": "https://api.<domain>/v1", "description": "Production"}],
        # Pre-fill the auth scheme so the panel prompts for the consumer's OWN key (never ours):
        authentication={"preferredSecurityScheme": "ApiKeyAuth"},
        custom_css=BRAND_CSS,                   # optional: brand the header/colors
    )
```

> **Why `docs_url=None` and not just reuse `/docs`:** FastAPI mounts Swagger UI at `/docs` itself; you
> cannot register a second route at the same path. Set `docs_url=None` (and `redoc_url=None`) to free the
> path, then register your own ([FastAPI metadata docs: *"You can disable … by setting docs_url=None …
> redoc_url=None"*](https://fastapi.tiangolo.com/tutorial/metadata/)). `openapi_url` stays set —
> **everything** (Scalar, Redoc, the SDK generator) reads that one JSON.

### 1.4 Wiring the licensing badge into the OpenAPI spec (so it shows in the docs)

The docs portal must tell a reader **what they may redistribute**, per dataset/series. The OpenAPI spec
is the carrier. Two complementary moves:

**(a) The response schema already carries `Provenance`.** Every retrieval response embeds a
`Provenance{source, commercialOk, attribution}` object (the same shape Lumina's `ProvenanceLine` takes —
`{source, commercialOk, attribution}`, per `03-dataquery-system-design.md:167`). Because FastAPI derives
the schema from the Pydantic model, the `Provenance` fields appear in the docs automatically, with their
field docs:

```python
# app/models/provenance.py  (Pydantic v2)
from pydantic import BaseModel, Field

class Provenance(BaseModel):
    source: str = Field(description="Origin of the fetch path, e.g. 'US Treasury (home.treasury.gov)'.")
    commercial_ok: bool = Field(
        default=False, alias="commercialOk",
        description=(
            "TRUE only if THIS fetch path is public-domain / CC0 / CC-BY (with attribution) or a "
            "purchased display tier. A free upstream tier is NOT a display license. When true, you may "
            "redistribute/display this series subject to `attribution`. Default false."
        ),
    )
    attribution: str | None = Field(
        default=None,
        description="The exact citation string you MUST render when displaying this series (when required).",
    )
```

**(b) Tag each dataset with a description that states the verdict in prose.** OpenAPI `tags` carry a
`description` that Scalar renders as a section header. Generate one tag per dataset and inline its
licensing verdict + attribution so a reader scanning the sidebar sees GREEN/RED before they ever read a
field:

```python
# app/openapi_tags.py — emitted into the spec's `tags`
OPENAPI_TAGS = [
    {
        "name": "treasury",
        "description": (
            "**US Treasury daily yield curve.** Source: home.treasury.gov. "
            "🟢 `commercialOk: true` — US-gov public domain (17 USC §105). Free to redistribute; "
            "no attribution required."
        ),
    },
    {
        "name": "gdelt-tone",
        "description": (
            "**GDELT news-tone series.** Source: GDELT Project. "
            "🟢 `commercialOk: true` — **with mandatory attribution.** You MUST render verbatim: "
            "*\"Source: The GDELT Project (gdeltproject.org)\"* on every surface that displays it."
        ),
    },
    {
        "name": "vendor-mirror",
        "description": (
            "**Vendor-mirrored series (e.g. CBOE VIX via a 3rd party).** "
            "🔴 `commercialOk: false` — fetch-through only on the RED tier; **do NOT redistribute or "
            "publicly display.** Your own internal use is permitted; republishing it as your data is not."
        ),
    },
]
# app = FastAPI(..., openapi_tags=OPENAPI_TAGS)
```

> **Single source of truth.** These verdict strings are **generated from the sources-ledger**, not
> hand-typed per dataset — the ledger ([`.claude/memory/sources-ledger.md`](../../memory/sources-ledger.md))
> is the truth table (Treasury/BLS/CFTC/World Bank/GDELT = 🟢; Twelve Data/Yahoo/CoinGecko/FMP/Polymarket
> = 🔴; the per-series third-party carve-out for FRED/World Bank/OECD/IMF per
> `02-skills-and-pipeline.md:117`). A build step reads the ledger row for each dataset and emits the tag
> description, so the docs can never drift from the gate. The PreToolUse licensing guard
> ([`precheck-licensing.mjs`](../../hooks/precheck-licensing.mjs)) and `/sources-lint` enforce that no
> `commercialOk:true` ships without a 🟢 ledger row — that same discipline backs these strings.

### 1.5 The Redoc fallback (read-only, large-spec, CDN-outage backup) — exact code

Mount Redoc at a second path. FastAPI's own helper (`get_redoc_html`) wraps the standalone bundle, or
serve the raw custom element. Either way it is **read-only** — no try-it, by design (that's the fallback's
job: a fast, static manual).

```python
# app/main.py — Redoc as the read-only / large-spec / outage fallback
from fastapi.openapi.docs import get_redoc_html
from fastapi.responses import HTMLResponse

@app.get("/reference", include_in_schema=False)
async def redoc_reference() -> HTMLResponse:
    return get_redoc_html(
        openapi_url=app.openapi_url,
        title="MarketData API — Reference (read-only)",
        # PIN the bundle — never "latest" in prod (a Redoc major could change rendering):
        redoc_js_url="https://cdn.jsdelivr.net/npm/redoc@2.5.3/bundles/redoc.standalone.js",
        redoc_favicon_url="/favicon.ico",
    )
```

The raw standalone element, if you ever serve it without FastAPI's helper (verbatim from
[Redocly/redoc](https://github.com/Redocly/redoc)):

```html
<redoc spec-url="https://api.<domain>/openapi.json"></redoc>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
```

> **Pin the version in prod** — the README shows `…/redoc/latest/…` for convenience, but `latest` means a
> CDN can ship a new major into your page silently. Pin `redoc@2.5.3` (or self-host the bundle).

### 1.6 Keep Swagger UI behind a dev-only flag (optional)

If a contributor prefers Swagger UI locally, re-enable it conditionally — **never in prod** (it's the
heaviest UI and a second try-it surface). Use FastAPI's own helper so it reads the same spec:

```python
# app/main.py — dev-only Swagger UI, gated by env
import os
from fastapi.openapi.docs import get_swagger_ui_html

if os.getenv("ENV") == "local":
    @app.get("/swagger", include_in_schema=False)
    async def swagger_ui() -> HTMLResponse:
        return get_swagger_ui_html(openapi_url=app.openapi_url, title="Swagger (local only)")
```

### 1.7 Customizing the OpenAPI doc itself (the spec all three render)

All three UIs are *renderers*; the substance is the OpenAPI 3.1 JSON FastAPI emits. Override
`app.openapi` to inject portal metadata (contact, license, logo, the global security scheme) **once**,
cached, so it's not recomputed per request ([FastAPI extending-openapi
docs](https://fastapi.tiangolo.com/how-to/extending-openapi/)):

```python
# app/openapi.py
from fastapi.openapi.utils import get_openapi

def custom_openapi(app):
    def _openapi():
        if app.openapi_schema:               # cache: build once, reuse the dict
            return app.openapi_schema
        schema = get_openapi(
            title="MarketData API",
            version="1.0.0",
            summary="Time-series market data over a uniform query contract.",
            description="Browse the catalog, pull a series, batch-export. Every series carries a "
                        "`commercialOk` licensing flag — see each dataset tag for the verdict.",
            routes=app.routes,
            tags=OPENAPI_TAGS,               # §1.4 — the per-dataset licensing tags
        )
        # Global API-key security scheme (header) — the Try-It panel prompts for the consumer's key:
        schema["components"]["securitySchemes"] = {
            "ApiKeyAuth": {"type": "apiKey", "in": "header", "name": "X-API-Key"}
        }
        schema["security"] = [{"ApiKeyAuth": []}]
        schema["info"]["x-logo"] = {"url": "https://<domain>/logo.svg"}
        schema["info"]["contact"] = {"name": "Developer Support", "url": "https://console.<domain>"}
        app.openapi_schema = schema
        return schema
    return _openapi

# app.openapi = custom_openapi(app)
```

> **`get_openapi(...)` accepts** `title`, `version`, `openapi_version` (default `3.1.0`), `summary`,
> `description`, `routes`
> ([FastAPI docs](https://fastapi.tiangolo.com/how-to/extending-openapi/)) — the rest (`tags`,
> `servers`, `contact`, `license_info`, `terms_of_service`) are passed through to the resulting `info`
> object. The **cache** (`if app.openapi_schema: return`) is the load-bearing line: without it FastAPI
> rebuilds the whole schema on every `/openapi.json` hit — a needless CPU cost on a spike-exposed route.

---

## 2. Part B — The self-serve console (React + Vite + Supabase)

### 2.1 What the console is and why it reuses the Lumina frontend pattern

The console is a small SPA where a developer **signs up, mints a key, watches usage, and picks a tier.**
We build it on the **exact pattern the Lumina repo already proved** — React + Vite + Supabase-auth — for
three reasons: (1) `02-skills-and-pipeline.md:168` pins it; (2) the repo has a battle-tested auth
provider we copy verbatim; (3) Supabase gives us hosted Google/GitHub OAuth + JWT for free, so the
console identity layer is *zero new code*.

**The auth provider — copy this shape verbatim** (it's the repo's `frontend/src/lib/auth-context.tsx`,
the single-subscription pattern that reads the Supabase session once and mirrors it into React; same
reference across token refreshes so query keys keyed on `user.id` don't churn):

```tsx
// console/src/lib/auth-context.tsx  (the Lumina pattern, reused)
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

interface AuthState { user: User | null; loading: boolean; }
const AuthContext = createContext<AuthState>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {            // cheap LOCAL read, not a network re-auth
      if (!active) return;
      setUser(data.session?.user ?? null); setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const next = session?.user ?? null;
      setUser((prev) => (prev?.id === next?.id ? prev : next)); // keep ref stable when identity unchanged
      setLoading(false);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);
  const value = useMemo(() => ({ user, loading }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
```

The Supabase client is the same one-liner the repo uses (`frontend/src/lib/supabase.ts`):

```ts
// console/src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,   // anon key only — never the service-role key in the bundle
);
```

> **The boundary that matters: Supabase authenticates the *human*; the API key authenticates the
> *machine*.** A developer signs into the console with Supabase (email/OAuth, a JWT). They then **mint an
> API key** (a different credential) that their *code/SDK* sends on every data call. The two are separate
> on purpose: the console JWT is short-lived and tied to a browser session; the API key is long-lived and
> tied to a program. The FastAPI **data** routes verify the **API key** (§4); the FastAPI **`/console/*`**
> routes verify the **Supabase JWT** (the human is managing their own keys). Never let a Supabase JWT call
> a data route, and never let an API key manage other keys.

### 2.2 The console pages (the surface map)

| Route | What it does | Auth |
|---|---|---|
| `/auth` | Supabase sign-up / sign-in (email + Google/GitHub OAuth) | public |
| `/` (dashboard) | tier badge, this-month usage vs quota, recent calls | JWT |
| `/keys` | list keys (prefix + last-4 + created/last-used), **Create**, **Rotate**, **Revoke** | JWT |
| `/keys/new` | the **reveal-once** modal — shows the full key exactly once | JWT |
| `/datasets` | browse the catalog with the **`commercialOk` badge** per dataset (§5) | JWT |
| `/tier` | choose **GREEN-only** vs **RED-fetch-through** (§3) | JWT |
| `/docs` ↗ | external link to the Scalar docs portal (§7) | — |

Gate every authed page with the repo's `useRequireAuth()` hook (redirects to `/auth` once the session
check resolves with no user) — copy it verbatim from `frontend/src/lib/auth-context.tsx`.

### 2.3 The console API client — attach the JWT to every `/console/*` call

```ts
// console/src/lib/api.ts
import { supabase } from "@/lib/supabase";

async function authedFetch(path: string, init: RequestInit = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${import.meta.env.VITE_CONSOLE_API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) throw await res.json();          // the typed error envelope (patterns-error-contract)
  return res.json();
}

export const api = {
  listKeys:   () => authedFetch("/console/keys"),
  createKey:  (name: string) => authedFetch("/console/keys", { method: "POST", body: JSON.stringify({ name }) }),
  rotateKey:  (id: string)   => authedFetch(`/console/keys/${id}/rotate`, { method: "POST" }),
  revokeKey:  (id: string)   => authedFetch(`/console/keys/${id}`, { method: "DELETE" }),
  usage:      () => authedFetch("/console/usage"),
  setTier:    (tier: "green_only" | "red_fetch_through") =>
                authedFetch("/console/tier", { method: "PUT", body: JSON.stringify({ tier }) }),
};
```

---

## 3. Onboarding tiers — GREEN-only (default) vs RED-fetch-through

The single product decision the console surfaces is **which licensing tier the key operates under.** This
is *not* a price tier — it's a **redistribution-rights** tier, and it exists because of the
`commercialOk` non-negotiable.

| Tier | What datasets the key can pull | What the consumer may do with the data | Default |
|---|---|---|---|
| **GREEN-only** (`green_only`) | only datasets where `commercialOk == true` (Treasury, BLS, CFTC, World Bank, GDELT, EDGAR…) | **redistribute / publicly display** the series (subject to the per-series `attribution` string) | ✅ **v1 default** |
| **RED-fetch-through** (`red_fetch_through`) | GREEN datasets **+** RED ones (vendor mirrors, Yahoo/CoinGecko-class) | **internal use only** — pull and consume, but **must NOT redistribute or publicly display** RED series | opt-in, eyes-open |

**Why GREEN-only is the v1 default and the safe path:**

- It maps 1:1 to the `commercialOk` gate. A GREEN-only key can *only* ever touch series our ledger
  cleared as displayable — so a consumer **physically cannot** redistribute something they're not licensed
  to, because the key won't return it.
- It's the all-public-domain spine: Treasury/BLS/CFTC/World Bank/GDELT/EDGAR (the 🟢 rows in the
  [sources-ledger](../../memory/sources-ledger.md)) — the exact set `02-skills-and-pipeline.md` pins as
  the v1 build path.
- It needs **no per-consumer legal agreement**: public-domain is public-domain.

**Why RED-fetch-through exists but is gated:** some consumers legitimately want RED series for **internal**
analytics (a number on their own dashboard, never republished). RED gates the *display license*, not
*access* — exactly the rule from [`commercial-ok-gate.md`](../../rules/commercial-ok-gate.md): *"A RED
source can still be built against for an informational, attributed feature — you just keep the gate
`false`."* So the RED tier is allowed, but:

1. It's **opt-in**, behind an explicit acknowledgement modal ("I will not redistribute or publicly display
   RED-flagged series").
2. Every RED series the key returns carries `commercialOk: false` in the payload **and** a per-call
   warning header, so the consumer's code can branch on it.
3. The ledger's hardest RED traps stay **un-fetchable on any tier** — Kalshi is `⛔ REJECT` (ToS bans
   caching, display, *and* AI use), Congressional-trading is RED-by-statute (5 USC §13107). These are
   **not** "RED-fetch-through"; they are **not integrated at all**. The tier toggles vendor-mirror RED, not
   forbidden RED.

**Enforcement is server-side, on the key's tier flag** — never trust the client:

```python
# app/dependencies/tier.py — the data route checks the key's tier against the dataset's verdict
from fastapi import HTTPException, Depends

async def enforce_tier(dataset_id: str, key=Depends(verify_api_key)):
    verdict = await catalog.commercial_ok(dataset_id)         # from the ledger-backed catalog
    if not verdict and key.tier == "green_only":
        # The key is GREEN-only but asked for a RED dataset → refuse with the typed error, not a 500.
        raise UpstreamUnavailable(                            # patterns-error-contract-and-status-codes
            code="dataset_not_in_tier",
            detail=f"Dataset '{dataset_id}' is commercialOk:false; your key is GREEN-only. "
                   f"Upgrade to the RED-fetch-through tier (internal-use-only) in the console.",
        )
    return key
```

The console `/tier` page is just a two-radio form posting to `PUT /console/tier`; the toggle writes the
`tier` column on the consumer row, and **every key inherits the consumer's tier** (so flipping the tier
flips all their keys at once — simpler than per-key tiers for v1).

---

## 4. API-key lifecycle — generate, hash, verify, rotate, revoke (the Stripe-grade UX)

We model the key UX on **Stripe's dashboard**, the most-copied reference in the industry. The four
load-bearing properties we copy ([docs.stripe.com/keys](https://docs.stripe.com/keys),
[restricted-api-keys](https://docs.stripe.com/keys/restricted-api-keys)):

1. **Prefixed keys** so a leaked key is instantly identifiable and greppable (`sk_live_`, `rk_live_`,
   `pk_live_`).
2. **Reveal-once:** *"When you create a secret key in live mode, we display it once before you save it.
   Copy the key before saving it because you can't reveal it later."* We **store only a hash** — we
   *cannot* re-show it even if we wanted to.
3. **Rotate** = *"revokes it and generates a replacement key that's ready to use immediately,"* with an
   optional **delayed expiry** so the old key keeps working during the migration window (Stripe: up to
   7 days).
4. **Restricted keys (RAK)** with per-resource **Read/Write/None** scopes — *"Stripe recommends always
   using RAKs instead of unrestricted secret keys, especially when giving a key to an AI agent."* We map
   this onto our **tier + scope** model.

### 4.1 The key format (prefix + entropy + last-4)

A key is `<prefix>_<tier-letter>_<random>`, e.g. `mdq_g_8f3c…` (GREEN-tier) / `mdq_r_…` (RED-tier). The
**prefix** is non-secret and stored in clear for display/grep; the **random** body is 256 bits of CSPRNG
entropy; we keep a **last-4** for the console list ("ends in …a91f") so a developer can identify a key
without us ever storing the secret.

```python
# app/services/keygen.py
import secrets, hashlib, hmac

KEY_PREFIX = "mdq"                      # "MarketData Query" — brand prefix, like Stripe's sk_

def generate_api_key(tier: str) -> tuple[str, str, str, str]:
    """Returns (full_key, prefix_public, last4, sha256_hex). full_key is shown ONCE, never stored."""
    tier_letter = "g" if tier == "green_only" else "r"
    body = secrets.token_urlsafe(32)            # 256 bits of CSPRNG entropy → unbruteforceable
    prefix_public = f"{KEY_PREFIX}_{tier_letter}"           # "mdq_g" — stored in clear, shown in console
    full_key = f"{prefix_public}_{body}"                    # "mdq_g_8f3c…" — returned ONCE
    last4 = full_key[-4:]
    digest = hashlib.sha256(full_key.encode()).hexdigest()  # store THIS, not the key
    return full_key, prefix_public, last4, digest
```

> **Why SHA-256, not bcrypt/argon2.** This is the one place the "always use bcrypt" reflex is **wrong**.
> bcrypt/argon2 are slow *on purpose* to defend **low-entropy human passwords** against offline
> brute-force. An API key is the opposite: **256 bits of CSPRNG entropy** — *"The security comes from the
> high entropy of the source key, not the slowness of the hash. A properly generated API key with 256 bits
> of entropy is computationally impossible to brute-force, regardless of hash speed"*
> ([codesignal API-key-security; cybersierra bcrypt-performance](https://codesignal.com/learn/courses/api-key-authentication-security-2/lessons/api-key-security-basics)).
> Using bcrypt here would add ~100ms to **every authenticated request** (the verify path) for zero
> security gain and a real DoS surface. **Use a fast salted/keyed hash (SHA-256, or HMAC-SHA-256 with a
> server pepper) + a constant-time compare** (§4.3). This is the documented, deliberate trade-off — not a
> shortcut. *(For comparison: passwords → bcrypt/argon2, per [OWASP Password Storage
> Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Keys are
> not passwords.)*

### 4.2 The key table (Postgres) — store the hash, never the key

```sql
-- migrations/00xx_api_keys.sql
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id   uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,  -- the Supabase user
  name          text NOT NULL,                       -- human label ("prod-ingest", "notebook")
  prefix_public text NOT NULL,                        -- "mdq_g" — shown in console, used to narrow lookup
  last4         text NOT NULL,                        -- "a91f" — display only
  key_hash      text NOT NULL,                        -- sha256 hex of the FULL key — the only stored secret
  tier          text NOT NULL DEFAULT 'green_only',   -- inherited from consumer; gates RED access
  scopes        text[] NOT NULL DEFAULT '{read}',     -- per-resource scopes (RAK model, §4.5)
  status        text NOT NULL DEFAULT 'active',       -- active | rotating | revoked
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,                          -- updated async on use (never block the request)
  expires_at    timestamptz                           -- set during a delayed-expiry rotation
);
-- Index the HASH for O(1) verify lookup; index consumer for the console list:
CREATE UNIQUE INDEX api_keys_hash_idx     ON api_keys (key_hash);
CREATE INDEX        api_keys_consumer_idx ON api_keys (consumer_id) WHERE status <> 'revoked';
```

> **Why a unique index on `key_hash`** — the verify path (§4.3) is `SELECT … WHERE key_hash = $1`, the
> hottest query in the system (one per authenticated API call). The B-tree unique index makes it an O(log
> n) point lookup, never a scan. The `prefix_public` column lets the console show a key and lets you scope
> a leaked-key search without de-hashing anything.

### 4.3 Verifying a key on the data path — hash + constant-time + lookup

```python
# app/dependencies/auth.py — the data-route auth dependency
import hashlib, hmac
from fastapi import Header, Depends
from app.errors import Unauthorized                          # typed 401, not a bare raise

async def verify_api_key(x_api_key: str = Header(...)) -> ApiKeyRow:
    digest = hashlib.sha256(x_api_key.encode()).hexdigest()  # hash the PRESENTED key
    row = await db.fetch_one(
        "SELECT * FROM api_keys WHERE key_hash = $1 AND status = 'active'", digest
    )
    # Constant-time guard even AFTER the indexed lookup: never branch on a partial match, and never leak
    # via timing whether a prefix matched. (The DB lookup is on the full hash, so this is belt-and-braces
    # against any future prefix-narrowed lookup path.)
    if row is None or not hmac.compare_digest(row["key_hash"], digest):
        raise Unauthorized(code="invalid_api_key", detail="API key is missing, invalid, or revoked.")
    if row["expires_at"] and row["expires_at"] < now():       # a rotated key past its grace window
        raise Unauthorized(code="expired_api_key", detail="This key has expired; rotate or create a new one.")
    schedule_touch(row["id"])                                  # update last_used_at OFF the request path
    return row
```

> **`hmac.compare_digest`** is Python's constant-time comparison — it does not short-circuit on the first
> mismatching byte, defeating the timing side-channel that `==` opens (*"=== doesn't perform constant-time
> operations … an attacker can statistically infer the correct value"*
> [gebna.gg timing-attack](https://gebna.gg/blog/timing-attack-javascript); a real 2025 CVE,
> [CVE-2025-59425 vLLM API-key timing bypass](https://www.miggo.io/vulnerability-database/cve/CVE-2025-59425),
> is exactly this bug). **Never** update `last_used_at` synchronously — that turns a read into a write on
> the hottest path; fire it on a background task / a batched async write.

### 4.4 Creating a key — the reveal-once flow (server + console)

**Server (`POST /console/keys`)** — generate, store the hash, return the full key **once**:

```python
# app/routes/console_keys.py
@router.post("/console/keys", status_code=201)
async def create_key(body: CreateKeyIn, user=Depends(verify_jwt)):
    full_key, prefix, last4, digest = generate_api_key(tier=user.tier)
    row = await db.fetch_one(
        """INSERT INTO api_keys (consumer_id, name, prefix_public, last4, key_hash, tier, scopes)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, prefix_public, last4, created_at""",
        user.id, body.name, prefix, last4, digest, user.tier, body.scopes or ["read"],
    )
    # The ONLY time `full_key` ever leaves the server. It is NOT stored anywhere.
    return {**row, "key": full_key, "reveal_once": True}
```

**Console (`/keys/new`)** — the reveal-once modal: show the full key, a copy button, and a warning that
it will never be shown again (the Stripe behavior verbatim):

```tsx
// console/src/components/CreateKeyModal.tsx
function CreateKeyModal({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; last4: string } | null>(null);

  async function submit() { setCreated(await api.createKey(name)); }

  if (created) {
    return (
      <Dialog open>
        <h3>Copy your API key now</h3>
        <p className="warn">
          This is the <b>only time</b> we will show this key. We store it hashed and cannot reveal it
          again. If you lose it, rotate or revoke it and create a new one.
        </p>
        <code className="key">{created.key}</code>
        <button onClick={() => navigator.clipboard.writeText(created.key)}>Copy</button>
        <button onClick={onDone}>I’ve saved it — done</button>
      </Dialog>
    );
  }
  return (
    <Dialog open>
      <h3>Create API key</h3>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. prod-ingest" />
      <button disabled={!name} onClick={submit}>Create key</button>
    </Dialog>
  );
}
```

> **Reveal-once is enforced by *not storing* the key**, exactly like Stripe: *"Copy the key before saving
> it because you can't reveal it later … We can't recover keys that you've forgotten or lost access to"*
> ([docs.stripe.com/keys](https://docs.stripe.com/keys)). The hash is irreversible, so even a malicious
> insider with DB access cannot reconstruct a customer's key. This is the whole point — store the hash,
> show the key once, and a DB breach leaks *hashes*, not usable credentials.

### 4.5 Scopes — the RAK least-privilege model (Read / Write / None)

We carry Stripe's **per-resource Read/Write/None** scope model on the `scopes text[]` column. For a
read-mostly **data** API the surface is small, but the discipline matters — *"Stripe recommends always
using RAKs instead of unrestricted secret keys, especially when giving a key to an AI agent … if a bad
actor obtained that key, they could only read dispute data"*
([restricted-api-keys](https://docs.stripe.com/keys/restricted-api-keys)). Our scopes:

| Scope | Grants | Stripe analogue |
|---|---|---|
| `read` | `GET /series`, `GET /catalog/*`, `GET /datasets/*` | resource = Read |
| `batch` | `POST /batch` (kick off a bulk export) | resource = Write |
| `admin` | manage *this consumer's* keys via API (rare; console does it via JWT normally) | full |

A key minted for a notebook gets `["read"]`; a key for a scheduled ingest job that triggers batch exports
gets `["read","batch"]`. **Write implies read** (Stripe: *"any key that can write an API resource can also
read that resource"*). Enforce per-route:

```python
def require_scope(scope: str):
    async def _dep(key=Depends(verify_api_key)):
        if scope not in key["scopes"] and "admin" not in key["scopes"]:
            raise Forbidden(code="insufficient_scope", detail=f"This key lacks the '{scope}' scope.")
        return key
    return _dep
# @router.post("/batch", dependencies=[Depends(require_scope("batch"))])
```

### 4.6 Rotation — revoke-and-replace with a delayed-expiry grace window

Rotation is the operation that distinguishes a real key system from a toy one: it must let a consumer
**swap a key without downtime.** Stripe's model: *"Rotating an API key revokes it and generates a
replacement key that's ready to use immediately … you can set a delayed expiration (up to 7 days) if you
want a safety window"* ([docs.stripe.com/keys](https://docs.stripe.com/keys)).

```python
# app/routes/console_keys.py
@router.post("/console/keys/{key_id}/rotate")
async def rotate_key(key_id: str, body: RotateIn, user=Depends(verify_jwt)):
    old = await get_owned_key(key_id, user.id)                # authz: the key must belong to this user
    # 1. Mint the replacement immediately (same tier + scopes + name) — ready to use NOW.
    full_key, prefix, last4, digest = generate_api_key(tier=old["tier"])
    new = await db.fetch_one(
        """INSERT INTO api_keys (consumer_id, name, prefix_public, last4, key_hash, tier, scopes)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, last4, created_at""",
        user.id, old["name"], prefix, last4, digest, old["tier"], old["scopes"],
    )
    # 2. Schedule the OLD key to expire after the grace window (0 = revoke now; up to 7 days).
    grace_days = min(body.grace_days or 0, 7)                  # cap the window, like Stripe
    if grace_days == 0:
        await db.execute("UPDATE api_keys SET status='revoked' WHERE id=$1", old["id"])
    else:
        await db.execute(
            "UPDATE api_keys SET status='rotating', expires_at = now() + ($2 || ' days')::interval "
            "WHERE id=$1", old["id"], grace_days,
        )
    return {**new, "key": full_key, "reveal_once": True,
            "old_key_expires_at": None if grace_days == 0 else f"+{grace_days}d"}
```

The console `/keys` row shows, during a rotation, *"old key expires in 6 days"* (Stripe: *"the remaining
time until the key expires displays below the key name"*). The data-path verify (§4.3) already rejects a
key past `expires_at` — so the old key simply stops working when the window closes, no extra job needed.

### 4.7 Revoke — immediate, idempotent

```python
@router.delete("/console/keys/{key_id}", status_code=204)
async def revoke_key(key_id: str, user=Depends(verify_jwt)):
    await get_owned_key(key_id, user.id)                       # authz
    # Idempotent: revoking an already-revoked key is a no-op, not an error.
    await db.execute("UPDATE api_keys SET status='revoked' WHERE id=$1 AND status<>'revoked'", key_id)
```

> **Authz, not just authn (the row-ownership trap).** Every key operation must check the key **belongs to
> the calling user** (`get_owned_key` filters `WHERE id=$1 AND consumer_id=$2`). Verifying the JWT is
> *authn* (a real user); checking row ownership is *authz* (the *right* user). Skipping the second lets any
> signed-in developer rotate/revoke **anyone's** key by guessing an id — the classic IDOR. This is the
> "right user, right row" check from the negation battery's trust-boundary axis.

---

## 5. Surfacing `commercialOk` + attribution to the consumer (docs **and** console)

The licensing badge is the product differentiator and a non-negotiable. It must appear in **both** halves
of the portal, sourced from the **same** `Provenance` stamp.

### 5.1 In the docs (already wired)

§1.4 put it in the spec: the `Provenance` schema fields are documented, and each dataset **tag** carries
its GREEN/RED verdict + attribution string in prose. A reader scanning Scalar's sidebar sees 🟢/🔴 per
dataset before they ever try a call.

### 5.2 In the console catalog browser (`/datasets`)

The console's dataset list shows a per-dataset badge so a developer **choosing what to integrate** knows
upfront what they can redistribute:

```tsx
// console/src/components/DatasetBadge.tsx
function DatasetBadge({ provenance }: { provenance: Provenance }) {
  if (provenance.commercialOk) {
    return (
      <span className="badge green" title={provenance.attribution ?? "Public domain — free to redistribute"}>
        🟢 Redistributable
        {provenance.attribution && <em> · attribute: “{provenance.attribution}”</em>}
      </span>
    );
  }
  return (
    <span className="badge red" title="Internal use only — do not redistribute or publicly display">
      🔴 Internal use only
    </span>
  );
}
```

### 5.3 In the live response (the machine-readable copy)

Every series the API returns embeds the same `Provenance` so the consumer's **code** can branch, and —
where the ToS demands it (GDELT, CC-BY) — a per-call header repeats the mandatory attribution so it
can't be missed:

```python
# In the series response middleware
if prov.attribution:
    response.headers["X-Data-Attribution"] = prov.attribution   # e.g. "Source: The GDELT Project (gdeltproject.org)"
if not prov.commercial_ok:
    response.headers["X-Data-License"] = "internal-use-only; do-not-redistribute"
```

> **The contamination rule (don't let a composite launder a RED input).** A derived/blended series is
> `commercialOk:true` **only if every input is GREEN**; one RED input makes the composite RED
> ([`commercial-ok-gate.md`](../../rules/commercial-ok-gate.md) F2 contamination rule). The badge and the
> tag must reflect the **most-restrictive** input. The build step that emits the tag descriptions (§1.4)
> computes the composite verdict as `AND` over input verdicts — never the optimistic `OR`.

---

## 6. The "Try-It" security — don't leak a real key

Scalar's and Swagger UI's interactive panels fire requests **from the consumer's browser**. The failure
modes and their fixes:

| Risk | Fix |
|---|---|
| The docs page embeds a **server-side / upstream key** so "Try It" works out of the box → that key is now in the page source, public. | **Never** embed a key. The `authentication` config (§1.3) only *prompts* for a scheme; it pre-fills nothing secret. The panel sends the **consumer's own** key, which they paste. |
| The spec's `servers` points at an **internal upstream** (Twelve Data, a private host) → "Try It" hits it directly, bypassing the gateway, leaking the internal URL. | `servers` MUST be the **public gateway** only (`https://api.<domain>/v1`). The gateway is the only thing that holds upstream credentials; the browser never sees them. |
| `scalar_proxy_url` is set to a permissive proxy → CORS bypass / SSRF. | Leave `scalar_proxy_url=""` unless you run a **locked-down** proxy; the gateway should serve CORS for the docs origin directly. |
| A logged-in console session token is reused as the data-API credential in the panel. | The data API accepts **only** `X-API-Key` (an API key), never a Supabase JWT (§2.1). The two credential types are non-interchangeable by design. |
| Telemetry leaks request bodies to Scalar's servers. | `telemetry=False` if the data or org policy is sensitive (the default is `True`). |

> **The principle:** the Try-It panel is a *client*, and a client never holds a server secret. The
> consumer authenticates with *their* key against the *public gateway*. There is no path by which our
> upstream credential or another consumer's key can appear in a rendered docs page.

---

## 7. Linking the spec, the SDK, and the changelog from the portal

A portal is a hub — the docs, the console, the spec download, the generated SDK, and the changelog must
all be one click apart. The wiring (the *content* of the SDK/spec/changelog is owned by the
`api-publishing-sdk-portal` skill — this doc just **links** them):

| Surface | URL | Source of truth |
|---|---|---|
| **Docs (interactive)** | `https://api.<domain>/docs` | Scalar over `/openapi.json` (§1.3) |
| **Reference (read-only)** | `https://api.<domain>/reference` | Redoc fallback (§1.5) |
| **OpenAPI spec (download)** | `https://api.<domain>/openapi.json` | FastAPI-emitted, `app.openapi` (§1.7) — the **one** source of truth |
| **Python SDK** | `pip install marketdata-sdk` → PyPI | OpenAPI Generator (Apache-2.0) off the same spec — `sdk-generation.md` |
| **Changelog** | `https://api.<domain>/changelog` (or the console nav) | additive `/api/v1` versioning — `api-versioning.md` |
| **Console** | `https://console.<domain>` | the React app (§2) |

Render the hub as a header nav present on **every** portal page (docs, console, reference), so a developer
is never more than one click from any surface. Scalar's `custom_css`/header slot, the console's top nav,
and the spec's `info.contact.url` (§1.7, pointed at the console) all carry the same links.

```tsx
// console/src/components/PortalNav.tsx — the shared hub nav
const LINKS = [
  { href: "/",                          label: "Console" },
  { href: "https://api.<domain>/docs",  label: "API Docs", external: true },
  { href: "https://api.<domain>/openapi.json", label: "OpenAPI Spec", external: true },
  { href: "https://pypi.org/project/marketdata-sdk", label: "Python SDK", external: true },
  { href: "/changelog",                 label: "Changelog" },
];
```

> **Why "one spec, many surfaces" matters here:** the docs, the SDK, the Try-It panel, and the agent tool
> layer all derive from `/openapi.json`. If you hand-maintain the docs separately from the SDK, they drift
> and a consumer's generated client lies about the contract. The portal's integrity is the spec's
> integrity — which is why §1.7 makes `app.openapi` the single emitter and every surface reads it.

---

## 8. R-SCALE — what tier this onboarding surface survives

Per [`product-at-scale.md`](../../rules/product-at-scale.md) and the global R-SCALE battery, state the
tier plainly:

| Surface | Tier it survives | The mechanism | Breaks at next tier when… |
|---|---|---|---|
| **Docs page** (`/docs`) | **10,000×** | Static HTML + a **CDN-pinned** Scalar JS bundle + a **cached** `/openapi.json` (the `app.openapi_schema` cache, §1.7). Compute-once-serve-many — print the flyer. | nothing realistic — it's a static asset; put a CDN in front and it's effectively infinite. The only risk is an un-cached `/openapi.json` recomputing per hit (the cache line prevents it). |
| **Key verify** (every data call) | **10,000×** | O(log n) **indexed** unique-hash lookup (`api_keys_hash_idx`, §4.2) + constant-time compare. `last_used_at` written **off** the request path. | a synchronous `last_used_at` write per call would turn every read into a write and serialize on the row — **don't**; batch it. A bcrypt verify (the rejected choice, §4.1) would cap throughput at ~hundreds/s — the exact reason we use SHA-256. |
| **Key create/rotate/revoke** | **10,000×** (these are rare per-user ops) | single indexed INSERT/UPDATE; idempotent revoke; authz on row ownership. | not a hot path — a developer mints a handful of keys, ever. |
| **Usage/quota display** | **100×** as written; **10,000×** with a rollup | reads a per-consumer counter. At 1×–100× a `SELECT count(*)` over a usage log is fine; at 10,000× that's a scan. | the count-over-log scan — pre-aggregate usage into a **continuous-aggregate/rollup** (the TimescaleDB rollup pattern, `timescaledb-timeseries` skill) and read the rollup, not the raw log. |
| **Console SPA** | **10,000×** | static Vite bundle on a CDN; all dynamic data is per-user, small, paginated. | nothing — it's a static SPA; the data routes behind it are the only scale surface, covered above. |

> **The honest tier statement:** docs + key-verify + key-lifecycle ship at **Tier 3 (10,000×)** as
> designed. The **only** Tier-2-as-written surface is **usage aggregation** — pre-aggregate it before
> believing the count-over-log is Tier 3. That's the one thing this surface must not ship as "fine at
> scale" while it's really a full scan.

---

## 9. Anti-patterns (mistake → fix)

| Anti-pattern | Why it's wrong | Fix |
|---|---|---|
| Storing the API key in clear (or symmetrically encrypted so it can be re-shown) | A DB breach leaks **usable credentials**; you can never honestly say "we can't see your key." | Store **only** `sha256(full_key)`; show the key **once** at creation; never persist the plaintext (§4.1–4.4). |
| Using **bcrypt/argon2** to hash the API key | Adds ~100ms to **every** authenticated request for zero gain — the key is already 256-bit entropy; it's a self-DoS. | Fast salted/keyed hash (SHA-256 / HMAC-SHA-256 + pepper) + constant-time compare (§4.1, §4.3). bcrypt is for *passwords*, not keys. |
| Comparing the key/hash with `==` | Timing side-channel — `==` short-circuits on first mismatch; an attacker statistically recovers the value (real CVE-2025-59425). | `hmac.compare_digest` (constant-time), §4.3. |
| Embedding a real (upstream/server) key in the docs so "Try It" works | The key is now in the public page source. | The Try-It panel prompts for the **consumer's own** key; `servers` points only at the public gateway (§6). |
| Shipping Swagger UI **and** Scalar in prod | Two interactive surfaces, double maintenance, the heavier one wins nothing. | Scalar primary (`docs_url=None` kills Swagger); Redoc read-only fallback; Swagger UI dev-only flag (§1.2, §1.6). |
| A `commercialOk:true` badge on a dataset with no 🟢 ledger row | Mis-licensing — exactly the F2 failure; a free tier is not a display license. | Generate badges/tags **from the sources-ledger**; `/sources-lint` + the PreToolUse guard enforce no orphan `true` (§1.4, §5). |
| A composite series shown GREEN when one input is RED | Contamination — the blend launders a RED input. | Composite verdict = `AND` over inputs; badge shows the most-restrictive (§5.3). |
| Console JWT used as a data-API credential (or vice-versa) | Conflates human-session auth with machine auth; a leaked JWT shouldn't pull data, a leaked key shouldn't manage keys. | Two credential types, non-interchangeable: `/console/*` takes the JWT, data routes take `X-API-Key` (§2.1). |
| Rotate/revoke without a row-ownership check | IDOR — any user edits anyone's key by guessing an id. | `get_owned_key(id, user.id)` filters `consumer_id` — authz, not just authn (§4.7). |
| Synchronous `last_used_at` write on the verify path | Turns the hottest read into a write; serializes on the row at scale. | Schedule the touch off the request path / batch it (§4.3, §8). |
| `latest` CDN URL for Scalar/Redoc JS in prod | A CDN can ship a new major into your docs silently and break rendering. | Pin the version (`@scalar/api-reference@1.25.0`, `redoc@2.5.3`), or self-host (§1.3, §1.5). |
| Rotation with no grace window (revoke-now only) | Forces downtime — the consumer's running code breaks the instant they rotate. | Delayed-expiry rotation: new key live immediately, old key valid for ≤7 days (§4.6). |

---

## 10. Output contract (grading rubric for work on this surface)

A change to the developer portal / key system is **done** only when:

1. **Docs:** Scalar is mounted at `/docs` over `/openapi.json`; FastAPI's default Swagger (`docs_url`) and
   ReDoc (`redoc_url`) are `None`; Redoc fallback is at `/reference`; all JS bundles are **version-pinned**.
2. **Spec carries licensing:** every dataset tag states its GREEN/RED verdict + attribution **generated
   from the sources-ledger**; the `Provenance` schema is documented; `/sources-lint` passes (no orphan
   `commercialOk:true`).
3. **Keys are reveal-once + hashed:** generated with ≥256-bit CSPRNG entropy, prefixed, **SHA-256-hashed**
   at rest, shown exactly once, verified with a **constant-time** compare over an **indexed** hash lookup.
4. **Lifecycle complete:** create, **rotate-with-grace-window (≤7d)**, revoke (idempotent), all with
   **row-ownership authz**; scopes (read/batch/admin) enforced per route.
5. **Tiers wired:** GREEN-only is the **default**; RED-fetch-through is opt-in behind an acknowledgement;
   the tier is **enforced server-side** against the dataset's ledger verdict; forbidden RED (Kalshi,
   Congress) is **un-fetchable on any tier**.
6. **Console = the Lumina pattern:** React + Vite + Supabase-auth, the verbatim single-subscription
   `AuthProvider` + `useRequireAuth`; the console JWT and the API key are **non-interchangeable**.
7. **Try-It is safe:** no server/upstream key in any page; `servers` = the public gateway only; the panel
   prompts for the consumer's own key.
8. **Badge in both halves:** `commercialOk` + attribution renders in the docs (tags/schema) **and** the
   console (`/datasets` browser) **and** the live response (header + payload), all from the same
   `Provenance` stamp; composite verdicts use `AND` (contamination rule).
9. **R-SCALE stated:** the tier each surface survives is written down (§8); usage aggregation is
   pre-rolled-up, not a scan, before claiming Tier 3.
10. **Hub linked:** docs ↔ console ↔ spec ↔ SDK ↔ changelog are one click apart, all deriving from the one
    OpenAPI spec.

---

## References (primary sources read for this doc)

| Source | What it anchors | Fetched |
|---|---|---|
| [scalar-fastapi PyPI 1.8.2 (MIT)](https://pypi.org/project/scalar-fastapi/) · [scalar/scalar README (MIT)](https://github.com/scalar/scalar/blob/main/integrations/fastapi/README.md) · `get_scalar_api_reference` full signature + `Layout`/`Theme` enums (read from `scalar/scalar@main:integrations/fastapi/.../scalar_fastapi.py`) | The Scalar integration code, params, version, license | 2026-06-24 |
| [FastAPI metadata & docs URLs](https://fastapi.tiangolo.com/tutorial/metadata/) · [FastAPI extending OpenAPI](https://fastapi.tiangolo.com/how-to/extending-openapi/) | `docs_url=None`/`redoc_url=None`, `get_openapi()` params, the `app.openapi_schema` cache, `get_redoc_html`/`get_swagger_ui_html` | 2026-06-24 |
| [Redocly/redoc (MIT, v2.5.3)](https://github.com/Redocly/redoc) | Redoc license/version, the standalone `<redoc>` element, OSS has **no** try-it | 2026-06-24 |
| [apisyouwonthate top-5 API docs 2025](https://apisyouwonthate.com/blog/top-5-best-api-docs-tools/) · [bump.sh top-5 2025](https://bump.sh/blog/top-5-api-docs-tools-in-2025/) · [dev.to best API docs 2025](https://dev.to/_d7eb1c1703182e3ce1782/best-api-documentation-tools-for-developers-in-2025-swagger-redoc-scalar-and-more-3d7g) | Scalar vs Redoc vs Swagger UI: try-it strength, bundle weight, code-sample gen | 2026-06-24 |
| [docs.stripe.com/keys](https://docs.stripe.com/keys) · [restricted API keys](https://docs.stripe.com/keys/restricted-api-keys) · [keys best practices](https://docs.stripe.com/keys-best-practices) | The key UX: prefixes (`sk_`/`rk_`/`pk_`), reveal-once, rotate + delayed expiry (≤7d), RAK Read/Write/None scopes, least-privilege | 2026-06-24 |
| [codesignal API-key security](https://codesignal.com/learn/courses/api-key-authentication-security-2/lessons/api-key-security-basics) · [cybersierra bcrypt-performance](https://cybersierra.co/blog/bcrypt-performance-issues-api/) · [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) | Why SHA-256 (not bcrypt) for high-entropy keys; passwords≠keys | 2026-06-24 |
| [gebna.gg timing attacks](https://gebna.gg/blog/timing-attack-javascript) · [CVE-2025-59425 (vLLM key timing bypass)](https://www.miggo.io/vulnerability-database/cve/CVE-2025-59425) | Constant-time compare (`hmac.compare_digest`); the real timing-attack CVE | 2026-06-24 |
| Repo: `frontend/src/lib/auth-context.tsx` · `frontend/src/lib/supabase.ts` · [`commercial-ok-gate.md`](../../rules/commercial-ok-gate.md) · [`sources-ledger.md`](../../memory/sources-ledger.md) · `02-skills-and-pipeline.md` (line 168 console pattern) · `03-dataquery-system-design.md` (`ProvenanceLine{source,commercialOk,attribution}` :167) | The reused React+Supabase auth pattern, the `commercialOk` rule, the ledger truth-table, the console-stack decision, the Provenance shape | 2026-06-24 |
