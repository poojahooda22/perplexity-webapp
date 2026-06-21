# Lumina Academic Vertical — the wiring map

> The whole Academic Discover slice, file by file, with the request flow, the cache/cron topology,
> and the one architectural seam that surprises people (the cached OpenAlex feed exists, but the
> shipped `AcademicView` fires the *search* flow, not the feed). `lumina-` ref = THIS codebase;
> cite the live file before you change it — line numbers drift, so phrasing references "in fn X".
> Sibling refs: `openalex-and-scholarly-apis.md` (provider/fields/params + alternatives),
> `citations-and-dois.md` (DOI/citation metadata, OA status, dedupe), `academic-search-and-ranking.md`
> (relevance × citations × recency, R-SCALE §H), `paper-cards-ui.md` (the card/carousel rendering).
> Start here when you're lost; branch to those when the task is narrow.

---

## 1. What "Academic" actually is

Academic is the **simplest** of Lumina's verticals because its data is CC0 and slow-moving. It is
**two surfaces that barely touch each other today**:

1. **The cached scholarly feed** — `GET /discover/academic?market=us|in` →
   [`fetchAcademicDiscover`](../../../../backend/discover/academic.ts) → OpenAlex `/works` →
   `DiscoverPayload` of paper cards. Public, no auth, no LLM, compute-once-serve-many. Rides the
   *same* `getOrRefresh` cache + cron warmer the finance/health feeds use.
2. **The Academic home UI** — [`AcademicView`](../../../../frontend/src/components/discover/topic-discover-view.tsx)
   — a search box + two **static** category carousels (Trending Topics, Research Papers). Every
   card and the search box call `onAsk(query, attachments)` (cards pass `[]`), which fires the shared **web-search answer flow**
   (`/perplexity_ask`, Tavily, `[n]` citations) — owned by **research-agent**, NOT this skill.

```
                          ┌──────────────────────────────────────────┐
  Browser (Academic tab)  │  Backend (Bun + Express, on Vercel)       │   Free provider
  ───────────────────►    │                                           │   ─────────────
  GET /discover/academic  │  routes.ts ─► getOrRefresh ─► academic.ts ─┼─► OpenAlex /works (CC0,
   ?market=us|in          │   (cache.ts)  discover[:in]:academic       │   keyless, polite pool)
  ◄── DiscoverPayload ────│                                           │
                          │                                           │
  AcademicView search box │  index.ts ─► /perplexity_ask (Tavily) ────┼─► (research-agent owns this)
  + category cards (onAsk)│                                           │
  ◄── SSE answer stream ──│                                           │
                          └──────────────────────────────────────────┘
  cron-job.org ──► POST /discover/cron/refresh (CRON_SECRET) ──► warms us+in × academic+health
```

**The seam to know:** `fetchAcademicDiscover` and the `/discover/academic` route are fully built,
cached, and warmed — but `AcademicView` does **not** consume them. The feed is wired end-to-end on
the backend and exposed in [`frontend/src/lib/discover-api.ts`](../../../../frontend/src/lib/discover-api.ts)
(`fetchAcademicDiscover(market)`), yet the current home renders hand-picked Wikimedia-art category
tiles that trigger generated searches. If a task says "show the live papers feed on the Academic
page", you are *connecting an existing backend to the UI*, not building the backend. See §6.

---

## 2. File-by-file

### Data layer
- [`backend/discover/academic.ts`](../../../../backend/discover/academic.ts) — **the fetcher.**
  `fetchAcademicDiscover(market="us")` → `Promise<DiscoverPayload>`. Builds the OpenAlex query,
  maps each `OAWork` → `DiscoverArticle`, finalizes. Returns `{ articles, provenance }` with a CC0
  `Provenance` (`commercialOk:true`).
  - `openalexMailto()` reads `OPENALEX_MAILTO` (optional; the polite-pool courtesy — there is no
    API key).
  - `OAWork` is the **minimal** shape of the fields actually read: `id`, `doi`, `title`/
    `display_name`, `publication_date`, `primary_location.{landing_page_url, source.display_name}`,
    `primary_topic.{display_name, field.display_name}`. Don't widen this without need.
  - `LOOKBACK_DAYS = 21` — the "last ~3 weeks, newest first" window.
- [`backend/discover/shared.ts`](../../../../backend/discover/shared.ts) — **the shared card
  contract** every Discover vertical obeys:
  - `DiscoverArticle` = `{ id, title, source, url, image, publishedAt(ISO), category }`.
  - `DiscoverPayload` = `{ articles, provenance, needsKey? }`.
  - `Provenance` = `{ source, commercialOk, attribution }` (mirrors finance's shape).
  - `finalizeArticles(articles)` — dedupe (canonical URL + lowercased title), drop title/url-less
    rows, cap at `MAX_ARTICLES` (18), **sort image-bearing cards first**. Academic papers have no
    hero image, so academic cards all land in the imageless tail — expected.
  - `toIso(input)` — loose date → safe ISO, "now" on garbage (so a card never shows an invalid date).
  - `canonicalUrl` / `hostOf` / `fetchOgImage` — used by the news feeds; academic uses
    `canonicalUrl` only via `finalizeArticles` (it sets `image:null` and skips OG fetching — papers
    have no thumbnail to hotlink).
- [`backend/lib/cache.ts`](../../../../backend/lib/cache.ts) — `getOrRefresh(key, ttl, fetcher)`.
  Upstash Redis when configured, in-process Map otherwise; soft TTL for freshness, hard TTL =
  soft×12 so a stale value survives; in-flight de-dupe; stale-on-error. Academic just rides it —
  internals owned by **finance-markets** `caching-and-rate-budgets.md`.

### Route layer
- [`backend/discover/routes.ts`](../../../../backend/discover/routes.ts) — `discoverRouter`, mounted
  at `/discover` in [`backend/index.ts`](../../../../backend/index.ts) (in fn that does
  `app.use("/discover", discoverRouter)`), **public** (before auth), `financeRateLimit`-guarded.
  - `discoverRoute(topic, ttl, fetcher)` — the market-aware cached read factory. `?market=in` →
    `discover:in:<topic>` cache key; else `discover:<topic>`. Wraps the fetcher in
    `getOrRefresh`, spreads the payload + `{ fetchedAt, stale }`, and 502s with a logged message on
    upstream failure. Mirrors finance's `marketReadRoute`.
  - `TTL = { academic: 1800, health: 600 }` — academic is slow-moving → 30 min is correct.
  - `GET /discover/academic` and `GET /discover/health` are the only two reads.
  - `POST /discover/cron/refresh` — the warmer. Optional `CRON_SECRET` guard (Bearer or
    `x-cron-secret`; skipped if unset). Force-refreshes 4 keys with `ttl:0` via `Promise.allSettled`:
    `academic`, `in:academic`, `health`, `in:health`. Returns per-key `{ key, ok }`.

### Frontend
- [`frontend/src/components/discover/topic-discover-view.tsx`](../../../../frontend/src/components/discover/topic-discover-view.tsx)
  — `AcademicView({ onAsk })`. Title "lumina academic", a docked search box (Enter / button →
  `onAsk`), `CHIPS` quick-search buttons, and two `Carousel`s over the static `TRENDING` and
  `RESEARCH` `Category[]` arrays. Each `CategoryCard.onClick` builds a year-stamped query string and
  calls `onAsk` — it does NOT navigate to a paper list.
- [`frontend/src/components/discover/discover-parts.tsx`](../../../../frontend/src/components/discover/discover-parts.tsx)
  — the shared primitives: `Carousel<T>` (paged, arrows + dots, `perPage` slice, responsive grid),
  `CategoryCard` (image tile + gradient + label, fires `onClick`), `ArticleCard` (the card that
  WOULD render a `DiscoverArticle` — favicon + source + `timeAgo` + clamped title, `image &&`
  guarded), plus `wiki(file)` (Wikimedia public-domain art URL), `timeAgo`, `faviconFromUrl`.
  `ArticleCard` is the bridge: it's already typed for `DiscoverArticle`, so feeding the feed in is a
  render swap, not a new component (§6).
- [`frontend/src/lib/discover-api.ts`](../../../../frontend/src/lib/discover-api.ts) —
  `fetchAcademicDiscover(market="us")` → `getJson<DiscoverPayload>("/discover/academic"+marketQuery)`.
  Re-exports the `DiscoverArticle`/`DiscoverPayload`/`Market` types from `finance-api` (every
  Discover surface shares one shape). This client fn **exists but has no caller** today.
- [`frontend/src/pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx) — mounts
  `<AcademicView onAsk={handleAsk} />` when `section === "Academic"` (in the section switch). So
  `onAsk` IS `Dashboard.handleAsk` — the same handler the main search hero uses → the web-search
  answer flow, switching the app into chat mode.

---

## 3. The OpenAlex query — every filter and why

Built in `fetchAcademicDiscover`. Filters are joined into one `filter=` param (comma = AND):

| Filter | Purpose |
|--------|---------|
| `from_publication_date:${since}` | start of the 21-day window |
| `to_publication_date:${today}` | **caps the future-date footgun** — OpenAlex carries `2050-…` rows; without this a "latest" feed fills with junk |
| `type:article` | drop datasets, book chapters, peer-reviews, errata |
| `has_doi:true` | guarantees a stable, resolvable outbound link on every card |
| `primary_location.source.type:journal` | real peer-reviewed journals, not preprint repos (arXiv etc.) |
| `authorships.institutions.country_code:in` | **only for `market==="in"`** — the India facet |

Plus: `sort=publication_date:desc` (newest first), `per_page=40` (over-fetch; `finalizeArticles`
caps to 18 after dedupe), `mailto` param when set. The request uses `Accept: application/json`, a
`User-Agent` carrying the mailto, and `AbortSignal.timeout(9000)`. Non-2xx → `throw new Error
("OpenAlex <status>")` so `getOrRefresh` serves stale instead of 500ing.

**Field grouping for `category`:** `primary_topic.field.display_name` (broad: "Medicine",
"Computer Science") → falls back to `primary_topic.display_name` → `"Research"`. OpenAlex's topic
hierarchy is domain > field > subfield > topic; we group by the broad **field**.

---

## 4. OAWork → DiscoverArticle mapping (the per-row contract)

The loop in `fetchAcademicDiscover` is small but every line defends a rule:

```ts
for (const w of data.results ?? []) {
  const title = (w.title ?? w.display_name ?? "").replace(/<[^>]+>/g, "").trim(); // strip JATS
  const url = w.doi || w.primary_location?.landing_page_url || w.id || "";        // DOI > page > id
  if (!title || !url) continue;                                                   // never a blank card
  articles.push({
    id: w.id || url,
    title,
    source: w.primary_location?.source?.display_name || "OpenAlex",              // venue, not author
    url,
    image: null,                                                                 // papers = no hero
    publishedAt: toIso(w.publication_date),
    category: w.primary_topic?.field?.display_name || w.primary_topic?.display_name || "Research",
  });
}
return { articles: finalizeArticles(articles), provenance };
```

| Field | Rule it enforces |
|-------|------------------|
| `title` strip `<[^>]+>` | OpenAlex titles carry JATS markup (`<scp>DNA</scp>`, `<i>…</i>`); render cleaned text only |
| `url` = DOI → landing → id | **never fabricate a link**; use what OpenAlex returns, skip if all absent |
| `continue` on empty title/url | a card without a real link is worse than no card |
| `source` = venue display name | the journal IS the source label (Nature, JAMA…), with `"OpenAlex"` fallback |
| `image:null` | no thumbnail to hotlink → `finalizeArticles` sinks these below image cards |
| `publishedAt` via `toIso` | guarantees a valid ISO even if `publication_date` is malformed |

---

## 5. Request flow — one Academic feed read

1. `GET /discover/academic?market=in` → `financeRateLimit` → `discoverRoute("academic", 1800, fetchAcademicDiscover)`.
2. `market = "in"`; `key = "discover:in:academic"`.
3. `getOrRefresh(key, 1800, () => fetchAcademicDiscover("in"))`.
   - **HIT (fresh):** return cached `{ articles, provenance }` immediately.
   - **HIT (stale):** return stale + revalidate in background.
   - **MISS:** call OpenAlex `/works` with the India facet, map, finalize, cache.
   - **upstream throws:** if a value was ever cached, serve it stale (never 500); else the route
     catches and 502s with a logged message.
4. Response = `{ articles, provenance, fetchedAt, stale }`.

The cron warmer keeps both markets hot so a real user never pays the cold MISS:
`cron-job.org → POST /discover/cron/refresh` (with `CRON_SECRET`) → force-refresh all 4 keys.

---

## 6. Connecting the feed to the UI (the most likely task)

The backend feed is done; the UI doesn't render it yet. To make the Academic page show live
papers, you assemble existing parts — no new backend, no new card component:

| Step | What | Where |
|------|------|-------|
| 1 | Add a TanStack hook (mirror `use-finance`/`use-discover` pattern) calling `fetchAcademicDiscover(market)` | a `use-discover.ts` hook + `frontend/src/lib/discover-api.ts` (the fetch fn already exists) |
| 2 | Render the returned `articles` with `ArticleCard` (already typed for `DiscoverArticle`) inside a `Carousel` or grid | `discover-parts.tsx` (reuse `ArticleCard`/`Carousel`) |
| 3 | Decide composition: keep the static category tiles as *entry points* + add a live "Latest papers" section, or replace one carousel with the feed | `topic-discover-view.tsx` (`AcademicView`) |
| 4 | Handle loading / empty / stale (badge off `stale`/`fetchedAt`) — see `paper-cards-ui.md` | the view |
| 5 | Keep the search box on `onAsk` (research-agent) — the *answer* path stays separate from the *feed* | unchanged |

Do NOT fetch OpenAlex from the client, sort/filter in React, or build a parallel card. The feed is
server-cached, server-filtered, server-deduped; the client renders a page of it.

---

## 7. Anti-patterns (mark an amateur) → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| "The feed isn't shown, so the backend must be missing" — rebuilding `academic.ts`. | It's built, cached, warmed, and exposed via `fetchAcademicDiscover` in `discover-api.ts`. The gap is a UI render (§6), not a fetcher. |
| Fetching OpenAlex directly from React / per keystroke. | Hit `GET /discover/academic` (cached + warmed); debounce any search; the polite-pool `mailto` is server-side. |
| String-guessing a DOI URL (`https://doi.org/10.xxxx/…`). | Use `w.doi` → `landing_page_url` → `id`; `continue` if all absent. |
| Letting the model write a paper title / author / year / DOI from memory. | Serve real OpenAlex works, or run the cited web-search flow (research-agent). No source → say so. |
| Flipping `commercialOk:false` "to be safe" on OpenAlex data. | OpenAlex is CC0 — `commercialOk:true` is correct and earned; over-restricting hides legal content. |
| Dropping `to_publication_date` from the filters. | Always bound `[since, today]` or 2050-dated junk surfaces in a "latest" feed. |
| Rendering raw OpenAlex JATS titles (`<scp>…</scp>`). | Keep the `.replace(/<[^>]+>/g, "")` strip in the fetcher. |
| Forking the fetcher for India. | `?market=in` adds one filter + a separate cache key; same fn (`if (market === "in")`). |
| Sorting/filtering the full result set in the client. | Filter at the OpenAlex `filter=`; cap + dedupe via `finalizeArticles`; client renders a page. |
| Calling recency-sorted output "search". | That's matching only — Tier-1. Add citation impact + relevance for true ranking (R-SCALE §H, `academic-search-and-ranking.md`). |
| Adding a new backend file and expecting `bun --hot` to pick it up. | New backend files need a **full dev-server restart**; relative imports need explicit `.js` (`./shared.js`, `./academic.js`) or Vercel's ESM resolver fails the build. |

---

## 8. R-SCALE posture (state the tier plainly)

| Surface | Today | Tier | Next break / upgrade |
|---------|-------|------|----------------------|
| Feed listing | server-side OpenAlex `filter=`/`sort=`/`per_page`, capped 18 via `finalizeArticles`, cached + warmed | survives 10,000× (OpenAlex indexes the corpus; we never hold it client-side) | none on the read; only the in-process cache fallback (set Upstash for shared hot cache) |
| Ranking | `sort=publication_date:desc` (recency only) + image-first in `finalizeArticles` | **Tier-1 (matching, not ranking)** | add `cited_by_count` (impact) + a relevance score for query searches — `academic-search-and-ranking.md`, R-SCALE §H |
| Search | `AcademicView` fires `onAsk` → web-search flow (research-agent), not an OpenAlex search | Tier-1 demo composition | a true scholarly search = OpenAlex `search=` + ranking; design before building |
| Licensing | CC0, `commercialOk:true`, attribution courtesy | clean at every tier | the *cleanest* feed — contrast the news-licensing trap in health/finance (`discover-news-licensing` memory) |

---

## 9. Deploy / dev landmines (shared with the rest of the repo)

| Concern | Reality | Fix in this repo |
|---------|---------|------------------|
| New backend file | `bun --hot` misses brand-new files → route/fetcher "doesn't exist". | Full restart after adding `academic.ts`-class files. |
| ESM resolver | Backend is `"type":"module"`; Vercel runs strict Node ESM. | Every relative import needs explicit `.js` (`./shared.js`, `./academic.js`); Bun is lenient locally, only breaks on Vercel. |
| Public route placement | `/discover` is mounted before auth (no `req.userId`). | Keep it that way — it imports none of auth/db so it stays up if those env vars are missing. |
| In-memory cache on serverless | Per-instance + cold-start-wiped. | Set `UPSTASH_*` for a shared hot cache before deploying for real; cron warmer needs it to matter. |
| `OPENALEX_MAILTO` unset | Works (anonymous pool), but slower/less reliable; logs may show throttling. | Set it in prod to enter the polite pool — it's the only OpenAlex "credential". |
| Frontend→backend URL | `BUN_PUBLIC_BACKEND_URL` inlined at build time, must be a full `https://…`. | Redeploy frontend after changing it; a scheme-less value → relative path → 404 on `/discover/academic`. |

---

## 10. Where to add things (cheat sheet)

- **New scholarly source (Crossref / Semantic Scholar / arXiv)** → new fetcher beside `academic.ts`
  returning `DiscoverPayload` with its OWN correct `Provenance` (preprints labeled, licence per ToS)
  → register a route in `routes.ts` + the cron warmer. See `openalex-and-scholarly-apis.md`.
- **Tune the feed window/filters** → edit `LOOKBACK_DAYS` + the `filters[]` array in `academic.ts`;
  keep `to_publication_date` and `has_doi`.
- **Add a market (e.g. EU)** → extend `Market` in `shared.ts` + the `country_code` push in
  `academic.ts`; `discoverRoute` is already `?market=` aware (separate `discover:<m>:*` keys); add
  the keys to the cron warmer.
- **Render the live feed in the UI** → §6 (hook → `ArticleCard`/`Carousel` → `AcademicView`).
- **A real scholarly search (not the web-search flow)** → add an OpenAlex `search=` fetcher +
  ranking; design ranking first (`academic-search-and-ranking.md`). The *answer* path stays with
  **research-agent**.
