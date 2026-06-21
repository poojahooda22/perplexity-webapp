# Lumina Discover Feeds — the shared card-feed pattern

> The cross-vertical **Discover card-feed** pattern: how `/discover/*` serves cached headline/paper
> cards (health, academic — finance has its own twin) from the SAME `getOrRefresh` cache + cron
> warmer that powers the dashboards, why the legal card shape is identical everywhere, and how a feed
> differs fundamentally from the `/perplexity_ask` chat pipeline. `lumina-` ref = THIS codebase; cite
> the live file before changing it (line numbers drift). Read this when building or extending a
> Discover feed. For the chat search pipeline see `lumina-research-pipeline.md`; for the *domain* of
> each source (which provider, why, licensing depth) see the **health-discover** / **academic-discover**
> skills — this ref covers the shared plumbing only.

---

## 1. What a Discover feed IS (and what it is NOT)

A Discover feed is a **compute-once-serve-many card carousel**: no auth, no LLM on the hot path, no
per-user state. A fetcher hits an upstream (OpenAlex, NewsData, Tavily), normalizes the response into
a uniform `DiscoverArticle[]`, and that one payload is cached and handed to every visitor until it
goes stale. It is the **public-read** half of a vertical, the exact analogue of the finance dashboard
cards (`/finance/crypto`, `/finance/home`) — see `lumina-finance-architecture.md` §1 "two faces".

| | Discover feed (`/discover/*`) | Chat pipeline (`/perplexity_ask`) |
|---|---|---|
| Auth | **None** — mounted before auth, like `/finance/*` | Auth middleware → `req.userId` |
| LLM on hot path | **No** — pure fetch + normalize | Yes — `streamText` / classify / answer protocol |
| Per-user | No — one payload for everyone | Yes — conversation, history, persisted turns |
| Caching | `getOrRefresh(key, ttl, …)`; cron-warmed | Semantic cache (skipped for time-sensitive) |
| Response | One JSON blob `{articles, provenance, fetchedAt, stale}` | SSE token stream + `<SOURCES>`/`<IMAGES>` tail |
| Legal shape | Headline + source + link + hotlinked image only | Transformative synthesis with `[n]` citations |
| Failure mode | 502 + stale-served; degrade to a fallback source | Stream error; persist what streamed |
| Citations | None — each card *is* a link-out | Numbered `[n]` lined up to `<SOURCES>` |

**The mental split:** a feed is a *flyer printed once and copied* (R-SCALE read-spike); a chat turn is
*hand-written per reader*. Never put an LLM call on the feed hot path, and never serve a chat answer
from the un-personalized feed cache.

---

## 2. The wiring map (file by file)

### Router — [`backend/discover/routes.ts`](../../../../backend/discover/routes.ts)
- `discoverRouter`, mounted at `/discover` in `index.ts`, **before auth** (public). Each route is
  rate-limited with the **reused** `financeRateLimit` middleware (no Discover-specific limiter).
- `discoverRoute(topic, ttl, fetcher)` (in `routes.ts`) is the factory every endpoint goes through —
  the Discover analogue of finance's `marketReadRoute`. It:
  1. reads `?market=in` → `Market` ("us" default),
  2. computes a **market-namespaced cache key**: `discover:in:<topic>` vs `discover:<topic>`,
  3. wraps the fetcher in `getOrRefresh(key, ttl, () => fetcher(market))`,
  4. responds `{ ...payload, fetchedAt, stale }` so the UI can render a freshness/stale badge,
  5. on throw → `502 { error: "<key> upstream failed" }` (a read that has *never* succeeded; if it
     had, `getOrRefresh` would serve the stale copy instead — see §4).
- Endpoints: `GET /academic` → `fetchAcademicDiscover`, `GET /health` → `fetchHealthDiscover`.
- `POST /cron/refresh` — the warmer. Optional `CRON_SECRET` guard (Bearer token or `x-cron-secret`
  header; **skipped entirely if the env var is unset** — same pattern as finance). It force-refreshes
  every (market × topic) cell by calling `getOrRefresh(key, 0, fn)` (ttl `0` = always a MISS) across a
  `Promise.allSettled` so one upstream failure never sinks the others, then reports `{refreshed:[{key,ok}]}`.

  > **Gotcha — the cron key namespace.** The warmer keys are spelled `discover:<key>` where key ∈
  > `academic | in:academic | health | in:health` (see the `jobs` array in `routes.ts`). That yields
  > `discover:in:academic`, which **matches** the read-path key from `discoverRoute`. If you add a
  > topic, mirror BOTH spellings or the cron warms a key the reads never look up.

### Shared building blocks — [`backend/discover/shared.ts`](../../../../backend/discover/shared.ts)
The contract every vertical implements. `Market`, `Provenance` (mirrors the finance `Provenance` so
the frontend renders every surface identically), and the card type:

```ts
type DiscoverArticle = { id; title; source; url; image: string | null; publishedAt: string /*ISO*/; category };
type DiscoverPayload = { articles: DiscoverArticle[]; provenance: Provenance; needsKey?: boolean };
```

Helpers, all in `shared.ts`:

| Helper | Job |
|---|---|
| `canonicalUrl(u)` | Lowercase host, strip tracking params (`utm_*`, `fbclid`, `gclid`, `ref`…) + hash + trailing slash → a stable dedup key. |
| `hostOf(u)` | Hostname minus `www.` — the fallback `source` label when none is given. |
| `fetchOgImage(url)` | Hotlink a page's OWN `og:image`/`twitter:image` (browser UA, 7s timeout, http-only). Returns `null` on block → clean placeholder. **Never re-hosts.** |
| `toIso(input)` | Loose date (epoch s/ms, ISO, `YYYY-MM-DD`) → safe ISO; falls back to "now" so a card never shows an invalid date. |
| `finalizeArticles(articles)` | Dedup (canonical URL + lowercased title), drop title/url-less items, cap at `MAX_ARTICLES` (18), then **sort image-bearing cards first** so the visible carousel page looks rich. |

Constants: `MAX_ARTICLES = 18`, `MIN_WITH_IMAGE = 6`, `BROWSER_UA`.

> **The legal ship-rule, encoded in the type.** The card shape exposes ONLY headline + source +
> outbound link + (hotlinked, never re-hosted) image + timestamp. A publisher's body/snippet/abstract
> is **never** a field — so it physically can't leak. See `shared.ts` header comment and the
> `r.content … intentionally NOT included` line in `fetchHealthTavily` (`health.ts`).

### Fetchers (high level — domain depth → the vertical skills)
- [`backend/discover/academic.ts`](../../../../backend/discover/academic.ts) — `fetchAcademicDiscover(market)`.
  OpenAlex `/works`, filtered to recent (`LOOKBACK_DAYS = 21`) peer-reviewed journal articles with a
  DOI, `sort=publication_date:desc`. India = `authorships.institutions.country_code:in` facet. **All
  OpenAlex data is CC0 → `commercialOk: true`** (the only Discover source that is). No key
  (`OPENALEX_MAILTO` optional → faster "polite pool"). Papers have no hero image → `image: null` →
  placeholder. → **academic-discover** for the field-grouping, JATS-strip, and source nuances.
- [`backend/discover/health.ts`](../../../../backend/discover/health.ts) — `fetchHealthDiscover(market)`.
  **Orchestrator with fallback:** NewsData.io (`category=health`, real per-article images) when
  `NEWSDATA_API_KEY` is set AND it returns ≥1 article; otherwise a Tavily news search scoped to a
  trusted publisher allow-list (`GLOBAL_HEALTH_DOMAINS` / `INDIA_HEALTH_DOMAINS`, then `fetchOgImage`
  per result for thumbnails). **All publisher-derived content stays `commercialOk: false`** until a
  display licence is signed. → **health-discover** for the provider matrix + the licensing wall.

---

## 3. The fetcher contract (copy this for a new vertical)

Every fetcher is `(market: Market) => Promise<DiscoverPayload>` and obeys five rules. Match
`fetchAcademicDiscover` / `fetchHealthNewsData` exactly:

1. **Build a `Provenance` first** — `{source, commercialOk, attribution}`. Set `commercialOk`
   honestly: `true` ONLY for a genuinely open licence (CC0 like OpenAlex); `false` for ALL publisher
   content regardless of whether the free tier technically returned it. (Same gate as finance — a
   working API is not a display licence.)
2. **Bound the upstream call** — `AbortSignal.timeout(…)` on every `fetch` (academic 9s, health 8s,
   `fetchOgImage` 7s). A feed must never hang the request behind it.
3. **Normalize into `DiscoverArticle`** — map each upstream row to the card fields; prefer the most
   stable outbound URL (academic: DOI → landing page → OpenAlex id); strip markup from titles
   (academic strips JATS `<scp>`/`<i>`); **never** copy the publisher body/snippet into a card.
4. **Finish through `finalizeArticles`** — return `{ articles: finalizeArticles(articles), provenance }`.
   Dedup/cap/image-sort is centralized; don't reimplement it per vertical.
5. **Signal missing config, don't crash** — return `{ articles: [], provenance, needsKey: true }` when
   the required key is absent (see `fetchHealthNewsData`), so the route still 200s and the UI can show
   "configure a key" instead of a 502.

```ts
// Skeleton for a NEW discover vertical fetcher — match academic.ts / health.ts.
export async function fetchXDiscover(market: Market = "us"): Promise<DiscoverPayload> {
  const provenance: Provenance = { source: "X", commercialOk: false,
    attribution: "X news via … — headlines link to publishers" };
  const key = xKey();
  if (!key) return { articles: [], provenance, needsKey: true };          // rule 5
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });    // rule 2
  if (!res.ok) throw new Error(`X ${res.status}`);                        // throw → cache serves stale
  const data = await res.json();
  const articles: DiscoverArticle[] = [];
  for (const it of data.results ?? []) {
    if (!it.link || !it.title) continue;
    articles.push({ id: it.id || canonicalUrl(it.link), title: it.title,
      source: it.source || hostOf(it.link), url: it.link, image: it.image ?? null,
      publishedAt: toIso(it.date), category: it.category ?? "x" });       // rule 3 — NO body/snippet
  }
  return { articles: finalizeArticles(articles), provenance };           // rule 4
}
```

Then wire it: add the route in `routes.ts` (`discoverRouter.get("/x", financeRateLimit, discoverRoute("x", TTL.x, fetchXDiscover))`),
add a `TTL.x`, and add the `x` + `in:x` cells to the cron `jobs` array. Skipping the cron wiring is the
most common miss — the feed works but goes cold between organic hits.

---

## 4. Caching, freshness & graceful degradation

The same `getOrRefresh` from [`backend/lib/cache.ts`](../../../../backend/lib/cache.ts) the finance
feeds use — Upstash Redis when `UPSTASH_*` is set, an in-process `Map` (capped 500, LRU-ish) otherwise.
What the Discover routes get for free:

- **Compute-once-serve-many:** the fetcher runs only on a MISS; every reader in the TTL window gets the
  cached copy. Reads scale without touching upstream.
- **In-flight de-dupe:** concurrent MISSes on the same key share ONE upstream fetch (thundering-herd
  guard — critical for rate-limited NewsData/Tavily).
- **Stale-on-error:** if the fetcher throws but a prior value exists, `getOrRefresh` returns it flagged
  `stale: true` (hard TTL = soft × 12). The route's `catch`/502 only fires for a key that has **never**
  succeeded. So the honest 502 in `discoverRoute` is rarer than it looks.
- **Freshness on the wire:** `{fetchedAt, stale}` is spread into every response so the UI can badge it.

TTLs (seconds), from the `TTL` map in `routes.ts`:

| Topic | TTL | Why |
|---|---|---|
| `academic` | `1800` (30m) | Research publishes slowly; daily-granularity dates anyway. |
| `health` | `600` (10m) | News moves faster; balance freshness vs. NewsData/Tavily quota. |

> **Tune the TTL to the upstream's rhythm and quota, not to "feels fresh."** A 30s health TTL would
> burn the NewsData free tier and add nothing — the underlying news doesn't change that fast. Match
> the cron cadence to the TTL so the warmer keeps every cell hot just as it expires.

---

## 5. How a feed differs from the chat pipeline (and why you can't blur them)

| Concern | Feed does | Chat does | Don't |
|---|---|---|---|
| Grounding | Each card *is* a primary link — no synthesis | LLM answer grounded ONLY in numbered results | …summarize publisher bodies into a feed card |
| Citations | None — link-out per card | `[n]` lined up to `<SOURCES>` tail | …add `[n]` numbering to feed cards |
| Cache | `getOrRefresh` (TTL), shared across users | Semantic cache, **skipped** for time-sensitive | …serve a chat answer from the feed cache |
| Personalization | None — public payload | Per-user conversation + history | …key a feed by `userId` |
| Auth | Mounted before auth | Behind auth | …require auth for a Discover read |
| Persistence | None | `persistTurns` BEFORE `res.end()` | …persist anything on the feed path |
| Latency budget | One bounded fetch + cache | Search + tool loop + stream | …put an LLM call on the feed hot path |

The one thing they **share** is the cache + cron-warmer mechanism and the `Provenance`/licensing
discipline. Everything else is deliberately separate.

---

## 6. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Hitting OpenAlex/NewsData/Tavily on every `/discover` request. | Wrap the fetcher in `getOrRefresh(key, ttl, …)` and warm it in `/cron/refresh` — like academic/health. |
| Putting a publisher's snippet/abstract/body in a card to make it richer. | The card type has no body field for a reason. Headline + source + link + hotlinked image + timestamp ONLY (`shared.ts` rule); body stays out unless the licence explicitly allows it. |
| Re-hosting a thumbnail (downloading the image to your CDN). | `fetchOgImage` **hotlinks** the publisher's own `og:image`; blocked → `null` → placeholder. Never re-host. |
| Flipping `commercialOk: true` because "NewsData returned data." | It gates *legal display*, not technical access. Only CC0/open licences (OpenAlex) or a signed display licence flips it. |
| Adding a topic to the route but forgetting the cron `jobs` array. | Add the `topic` + `in:topic` cells to the warmer too, with the SAME `discover:`/`discover:in:` key spelling the read path uses. |
| Reimplementing dedup/cap/image-sort inside a new fetcher. | Always finish through `finalizeArticles`; it's the single source of truth for de-dup + the 18-card cap + image-first ordering. |
| Throwing (or 500-ing) when a vendor key is missing. | Return `{articles:[], provenance, needsKey:true}` so the route 200s and the UI prompts to configure the key. |
| One feed source with no fallback, so a vendor outage empties the carousel. | Orchestrate with a fallback like `fetchHealthDiscover` (NewsData → Tavily) so the carousel always has cards. |
| A naked `fetch` with no timeout in a fetcher. | `AbortSignal.timeout(…)` on every upstream call — a hung publisher must not stall the feed. |
| Treating India as a code branch full of `if`s. | One `Market` param; a separate `discover:in:*` cache key; market-specific domain lists/facets inside the fetcher (`INDIA_HEALTH_DOMAINS`, `country_code:in`). |

---

## 7. Output contract (what "done" looks like)

A Discover-feed change is done when:
1. **Fetcher:** `(market) => DiscoverPayload`, with a `Provenance` whose `commercialOk` is set
   honestly, every upstream call timeout-bounded, normalized into `DiscoverArticle` with NO body, and
   finished through `finalizeArticles`.
2. **Route:** registered via `discoverRoute(topic, ttl, fetcher)` behind `financeRateLimit`, returning
   `{…, fetchedAt, stale}`, 502-on-never-succeeded.
3. **Cache + cron:** a sensible TTL aligned to the upstream rhythm, AND the `topic` + `in:topic` cells
   added to the `/cron/refresh` `jobs` array with matching key spelling.
4. **Licensing:** you can state in one sentence whether the cards are cleared for public display and
   what attribution string renders.
5. **Resilience:** missing key → `needsKey` (not a crash); a primary outage degrades to a fallback
   source or stale-served cache, never an empty carousel on a key we've served before.
6. **Separation:** no LLM on the hot path, no auth, no per-user keying, no persistence — it's a feed,
   not a chat turn.
