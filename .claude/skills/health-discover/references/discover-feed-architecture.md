# The Shared Discover Feed — `shared.ts`, the fetch→shape→cache flow

> The one card-feed pattern that Health and Academic both run on, and that the Finance Discover
> carousel can migrate onto. Read this when adding/changing a Discover vertical, debugging a feed
> that goes dark or shows duplicate/imageless cards, or when you need to know how a cached *card
> feed* differs from the streamed *chat answer*. `lumina-` ref = THIS codebase; cite the live file
> before you change it (line numbers drift). Adjacent refs: **health-news-sourcing.md** (the
> health source itself + licensing), **research-agent** skill (the `/perplexity_ask` chat pipeline
> these feeds deliberately are NOT), and **finance-markets / data-licensing** (the shared
> ship-rule + `Provenance` this pattern generalizes from `backend/finance/news.ts`).

---

## 1. What the shared layer is (and is not)

A Discover feed is **compute-once-serve-many cards** — no auth, no LLM, no streaming. A vertical
file (`health.ts`, `academic.ts`) does the I/O against ONE source; everything *cross-cutting*
(card shape, dedup, dates, og:image, the legal envelope) lives in
[`backend/discover/shared.ts`](../../../../backend/discover/shared.ts). The two-line job of a
vertical is: **fetch upstream → map each item to a `DiscoverArticle` → `finalizeArticles(...)`**.

| Concern | Owned by | Why centralized |
|---|---|---|
| Card type, payload type, `Provenance` | `shared.ts` (`DiscoverArticle`, `DiscoverPayload`, `Provenance`) | Frontend renders every Discover surface identically — one type, one renderer. |
| Dedup + cap + image-first sort | `shared.ts` `finalizeArticles` | Every source produces dupes / imageless rows; fix once. |
| URL canonicalization | `shared.ts` `canonicalUrl` | Tracking params (`utm_*`, `fbclid`, …) defeat naive dedup. |
| Loose-date → ISO | `shared.ts` `toIso` | NewsData gives `pubDate` strings, OpenAlex `YYYY-MM-DD`, Finnhub epoch seconds. |
| og:image hotlink | `shared.ts` `fetchOgImage` | Tavily/OpenAlex return no hero image; we hotlink, never re-host. |
| **The source call + its `Provenance` + fallback** | the **vertical** (`health.ts` / `academic.ts`) | The only per-source logic. |
| Cache key, TTL, market split, cron warming | [`backend/discover/routes.ts`](../../../../backend/discover/routes.ts) | One route factory for all verticals. |

The legal envelope is encoded in the *type itself*: `DiscoverArticle`
([`shared.ts:14`](../../../../backend/discover/shared.ts)) has **no `content`/`body`/`abstract`
field** — only `id, title, source, url, image, publishedAt, category`. A publisher snippet is
literally unrepresentable, so no vertical can leak one by accident. See the Tavily lane in
[`health.ts`](../../../../backend/discover/health.ts) deliberately dropping `r.content`.

---

## 2. The data shapes (copy these exactly)

```ts
// backend/discover/shared.ts
export type Market = "us" | "in";
export type Provenance = { source: string; commercialOk: boolean; attribution: string };

export type DiscoverArticle = {
  id: string; title: string; source: string; url: string;
  image: string | null; publishedAt: string /* ISO */; category: string;
};
export type DiscoverPayload = { articles: DiscoverArticle[]; provenance: Provenance; needsKey?: boolean };

export const MAX_ARTICLES = 18;
export const MIN_WITH_IMAGE = 6; // keep imageless cards only if fewer than this many have an image
```

`Provenance` is a deliberate copy of the finance shape (see
[`shared.ts:11-12`](../../../../backend/discover/shared.ts)) so the frontend renders attribution +
freshness on every surface the same way. `commercialOk` is a **legal display gate, not a technical
flag**: it is `false` for all publisher-derived news (health) and `true` only for CC0 data
(OpenAlex academic — [`academic.ts:47`](../../../../backend/discover/academic.ts)).
`needsKey:true` signals "no API key configured" so the UI/orchestrator can fall back rather than
show an empty rail.

---

## 3. The fetch → shape → cache flow (end to end)

```
GET /discover/health?market=in            (index.ts → app.use("/discover", discoverRouter))
  └─ financeRateLimit                      (lib/ratelimit.ts — same limiter as finance reads)
  └─ discoverRoute("health", 600, fetchHealthDiscover)        // routes.ts factory
       └─ key = "discover:in:health"       (market==="in" ? discover:in:<topic> : discover:<topic>)
       └─ getOrRefresh(key, ttl, () => fetchHealthDiscover("in"))   // lib/cache.ts
            ├─ HIT  (age < ttl)                  → return cached {data, fetchedAt, stale:false}
            └─ MISS → fetchHealthDiscover("in")  // the VERTICAL does the work:
                 ├─ try NewsData.io  → map items → DiscoverArticle[] → finalizeArticles()
                 └─ catch/empty → fetchHealthTavily() → map → fetchOgImage() → finalizeArticles()
       └─ res.json({ ...payload, fetchedAt, stale })
```

The vertical's job, distilled (mirror this for any new feed):

```ts
// shape of every vertical fetcher: (market) => DiscoverPayload
const articles: DiscoverArticle[] = [];
for (const it of upstream.results ?? []) {
  if (!it.link || !it.title) continue;                  // never push a card without url+title
  articles.push({
    id: it.article_id || canonicalUrl(String(it.link)), // stable id, falls back to canonical url
    title: String(it.title),
    source: it.source_name || hostOf(String(it.link)),  // hostOf strips www. as the label fallback
    url: String(it.link),
    image: it.image_url ?? null,
    publishedAt: toIso(it.pubDate),                      // never trust raw upstream dates
    category: it.category?.[0] ?? "health",
  });
}
return { articles: finalizeArticles(articles), provenance };  // finalize is the last step, always
```

`finalizeArticles` ([`shared.ts:93`](../../../../backend/discover/shared.ts)) does four things in
order: drop title/url-less items → dedup by **canonical URL AND lowercased title** → cap at
`MAX_ARTICLES` (18) → **sort image-bearing cards first** so the first visible carousel page looks
rich. It also backfills `id` with the canonical URL. Never re-implement any of this in a vertical.

---

## 4. The three shared helpers, precisely

| Helper | What it guarantees | Gotcha it fixes |
|---|---|---|
| `canonicalUrl(u)` ([`shared.ts:33`](../../../../backend/discover/shared.ts)) | lowercased host, hash stripped, 10 tracking params deleted, trailing slash removed | `…/x?utm_source=fb` and `…/x` dedup to one card; bad URL → returned as-is (never throws). |
| `hostOf(u)` ([`shared.ts:49`](../../../../backend/discover/shared.ts)) | hostname without `www.`; `""` on a bad URL | A clean source label when the source name is missing (Tavily/OpenAlex). |
| `fetchOgImage(url)` ([`shared.ts:59`](../../../../backend/discover/shared.ts)) | the page's own `og:image`/`twitter:image`, or `null` | Sources with no hero image (Tavily, papers): hotlink the publisher's image, **never re-host**; 7s timeout + browser UA; blockers → `null` → clean placeholder. |
| `toIso(input)` ([`shared.ts:77`](../../../../backend/discover/shared.ts)) | a valid ISO string for epoch-seconds, ms, ISO, or `YYYY-MM-DD`; `now()` on garbage | A card never shows an "Invalid Date"; OpenAlex future-dated junk is still parseable (filtered upstream in `academic.ts`). |

`fetchOgImage` is fired in parallel over all Tavily cards (`Promise.all`) in
[`health.ts` `fetchHealthTavily`](../../../../backend/discover/health.ts) — don't await it in a
loop. NewsData already returns real per-article images (`image=1`), so its lane skips og:image
entirely; that's the whole reason NewsData is the *primary* health source.

---

## 5. The route factory + cache + market split

[`routes.ts`](../../../../backend/discover/routes.ts) is the only place a vertical is wired:

```ts
const TTL = { academic: 1800, health: 600 };   // academic changes slowly; health news is 10-min

function discoverRoute(topic, ttl, fetcher) {  // routes.ts:21
  return async (req, res) => {
    const market: Market = req.query.market === "in" ? "in" : "us";
    const key = market === "in" ? `discover:in:${topic}` : `discover:${topic}`;
    const r = await getOrRefresh(key, ttl, () => fetcher(market));
    res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
  };
}
discoverRouter.get("/academic", financeRateLimit, discoverRoute("academic", TTL.academic, fetchAcademicDiscover));
discoverRouter.get("/health",   financeRateLimit, discoverRoute("health",   TTL.health,   fetchHealthDiscover));
```

| Mechanism | Detail | Source |
|---|---|---|
| **Cache** | `getOrRefresh(key, ttl, fetcher)` — Upstash Redis when configured, in-process `Map` (cap 500, LRU-ish) otherwise. HIT under soft TTL; MISS runs fetcher; **stale-on-error** serves the last value flagged `stale:true` rather than 500; **in-flight de-dupe** shares one fetch per key (thundering-herd guard). | [`lib/cache.ts`](../../../../backend/lib/cache.ts) |
| **Hard TTL** | Redis hard TTL = soft × 12, so a stale value survives long enough to be the fallback. | [`cache.ts:54`](../../../../backend/lib/cache.ts) |
| **Market split** | `?market=in` → a **separate** `discover:in:<topic>` key; default → `discover:<topic>`. Never share one key across markets. | [`routes.ts:27-28`](../../../../backend/discover/routes.ts) |
| **Rate limit** | `financeRateLimit` (reused from finance) on every read route. | [`routes.ts:39-40`](../../../../backend/discover/routes.ts) |
| **Errors** | route catch → `502 {error}` only when the cache has *nothing* to serve (otherwise stale wins inside `getOrRefresh`). | [`routes.ts:32-35`](../../../../backend/discover/routes.ts) |
| **Cron warmer** | `POST /discover/cron/refresh` (guarded by `CRON_SECRET`, skipped if unset) force-refreshes all 4 series (`academic`, `in:academic`, `health`, `in:health`) via `getOrRefresh(key, 0, fn)` so reads stay hot. Wire cron-job.org to it. | [`routes.ts:44-60`](../../../../backend/discover/routes.ts) |

`getOrRefresh(key, 0, fn)` with `ttl=0` is the warmer idiom: any age ≥ 0 is "stale", so it always
re-fetches. `Promise.allSettled` warms all four in parallel and reports per-key `{ok}` so one
dead source can't fail the whole cron.

---

## 6. How this differs from the chat pipeline (`/perplexity_ask`)

These two systems live in the same backend but share almost nothing — confusing them is the most
common mistake. The Discover feed is the **research-agent** skill's "Discover card feeds" surface;
the chat answer is its `/perplexity_ask` pipeline.

| Axis | Discover feed (`/discover/*`) | Chat answer (`/perplexity_ask`) |
|---|---|---|
| Output | JSON array of cards (`DiscoverPayload`) | SSE token **stream** (`<ANSWER>`/`<FOLLOW_UPS>`) |
| LLM | **None** on the hot path | `streamText` tool loop, per request |
| Auth | Public, before auth in `index.ts` | Authed (`req.userId`), per-user rate limit |
| Caching | Yes — compute-once-serve-many, cron-warmed | Per-turn; no card cache (uploads never cached) |
| Personalization | None — same cards for everyone | Per query + conversation history |
| Sources | One source + a fallback, no citations | Tavily web search → numbered `[n]` citations |
| Failure mode | Serve **stale** cards / fall back source | Stream an error / decline |
| Latency budget | Sub-ms on HIT | Seconds (model generation) |

The connection point: a Discover card's "open" or a Health workflow click does **not** hit
`/discover` again — it calls the frontend `onAsk`, which fires the **chat** pipeline. Discover is
the *browse* surface; `/perplexity_ask` is the *ask* surface. Keep them separate: never add an LLM
call inside a `getOrRefresh` fetcher (it would be cached and reused across users), and never try to
stream from a Discover route.

---

## 7. Decision framework — adding or changing a feed

```
New Discover surface or source?
|
├─ New SOURCE for an existing vertical (e.g. another health publisher)
│     → edit health.ts only: add a fetch lane returning DiscoverPayload, slot it into the
│       orchestrator's try/fallback chain. Do NOT touch shared.ts or routes.ts.
│
├─ New VERTICAL (e.g. "tech", "science")
│     → new backend/discover/<topic>.ts exporting fetch<Topic>Discover(market): DiscoverPayload
│     → reuse canonicalUrl/hostOf/toIso/fetchOgImage/finalizeArticles from shared.ts
│     → add TTL.<topic> + discoverRoute() line + cron job entry in routes.ts
│     → add the TanStack hook + market toggle on the frontend (discover-parts.tsx)
│     → FULL dev-server restart (Bun --hot misses new files)
│
├─ Source returns publisher BODY/snippet/abstract
│     → drop it. The card type has no field for it. commercialOk stays false unless the
│       licence is CC0/explicit (academic = CC0 → true). See health-news-sourcing.md.
│
└─ Source has no hero image (Tavily, papers)
      → image:null at map time, then Promise.all(fetchOgImage) to backfill; never re-host.
```

A new card type field is almost never the answer — if you reach for `content`, re-read §1: that
field's absence *is* the legal contract.

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Re-implementing dedup / date parsing / canonicalization in a vertical file. | Reuse `finalizeArticles` / `toIso` / `canonicalUrl` from `shared.ts` — every vertical shares them. |
| Adding a `content`/`abstract` field to `DiscoverArticle` to "make cards richer." | The missing field IS the licence. Headline + source + link-out + hotlinked image + timestamp only. |
| `await fetchOgImage(url)` inside the map loop. | `Promise.all(articles.map(a => fetchOgImage(a.url)))` after mapping (see `fetchHealthTavily`). |
| Calling an LLM (`generateObject`/`streamText`) inside a `getOrRefresh` fetcher. | Discover is LLM-free; cached LLM output would be reused across users. Route generative work through `/perplexity_ask`. |
| Sharing one cache key across markets, or skipping the market check. | `discover:<topic>` vs `discover:in:<topic>` — separate keys, set by `discoverRoute`. |
| Re-hosting / proxying the publisher's image on our origin. | Hotlink the source's own `og:image` via `fetchOgImage` (browser UA); blocked → `null` → placeholder. |
| Letting a feed 500 / go blank when the primary source is keyless or rate-limited. | Vertical orchestrator falls back to a Tavily (or equiv) lane; `getOrRefresh` serves stale on error. |
| Forgetting to add a new vertical to the cron warmer's job list. | Add `["<topic>", () => fetch<Topic>Discover("us")]` (+ `in:`) in `routes.ts` `/cron/refresh`. |
| Flipping `commercialOk:true` because the API call worked. | It gates legal *display*, not technical access. Only CC0/licensed sources are `true` (OpenAlex). |
| Hardcoding `MAX_ARTICLES`/UA strings in a vertical. | Import `MAX_ARTICLES` / `BROWSER_UA` from `shared.ts`. |

---

## 9. Verified-done checklist for a feed change

1. The fetcher returns the exact `DiscoverPayload` shape — `articles` are `DiscoverArticle`s with
   **no body field**, a `Provenance` with the right `commercialOk` + an attribution string, and
   `needsKey` set when no key is configured.
2. Every card runs through `finalizeArticles` as the **last** step; dates go through `toIso`; dedup
   relies on `canonicalUrl`.
3. The feed never goes dark: a fallback lane exists, and `getOrRefresh` serves stale on upstream
   error (confirm by killing the key and re-requesting).
4. `GET /discover/<topic>?market=us|in` returns `200` with distinct cards per market, behind
   `financeRateLimit`, on `discover:<topic>` / `discover:in:<topic>` keys.
5. The cron warmer lists the new series; `POST /discover/cron/refresh` reports `{ok:true}` for it.
6. New backend file → full restart done; relative imports carry explicit `.js`.
