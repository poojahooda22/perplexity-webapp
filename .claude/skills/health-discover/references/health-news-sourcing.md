# Health News Sourcing — providers, categories, cadence & the licensing reality

> How the Health Discover feed actually gets its cards: NewsData.io (primary, real per-article
> images) → Tavily (fallback, trusted-domain scoped), the global-vs-India domain lists, the
> retry/dedup/cadence machinery, and the hard licensing gate (`commercialOk:false`, headline +
> link-out only, transformative synthesis). Read this when **choosing, adding, or debugging a
> health feed source**, tuning cadence/cache, or answering "can we display this?".
> `lumina-` ref = THIS codebase; cite the live file before you change it (line numbers drift).
>
> **Sibling refs:** the full wiring map (route → UI → hook) is `lumina-health-vertical.md`; the
> shared card primitives (`canonicalUrl`/`finalizeArticles`/`fetchOgImage`/`toIso`) are
> `discover-feed-architecture.md`; safety framing is `medical-info-safety.md`; topic taxonomy +
> source-quality tiers are `health-domain-coverage.md`. For the deep licensing rationale this doc
> reuses, read **finance-markets** → `data-licensing-and-compliance.md`.

Files: [`backend/discover/health.ts`](../../../../backend/discover/health.ts),
[`backend/discover/shared.ts`](../../../../backend/discover/shared.ts),
[`backend/discover/routes.ts`](../../../../backend/discover/routes.ts).

---

## 1. The two-lane source design

The Health feed is **one orchestrator over two interchangeable lanes** that emit the identical
`DiscoverPayload` (`{ articles, provenance, needsKey? }`). The orchestrator
`fetchHealthDiscover(market)` in [`health.ts`](../../../../backend/discover/health.ts) prefers the
richer lane and falls back so **the carousel never goes dark**:

```
fetchHealthDiscover(market="us")            // health.ts, bottom of file
  ├─ newsdataKey() set?
  │    ├─ try fetchHealthNewsData(market)  → if articles.length > 0  ⇒ RETURN (real images)
  │    └─ throw / empty                    → console.warn, fall through
  └─ fetchHealthTavily(market)             // always works, no NewsData key needed
```

| Lane | Function | Provider | Key | Image quality | When it runs |
|------|----------|----------|-----|---------------|--------------|
| PRIMARY | `fetchHealthNewsData` | NewsData.io `/api/1/latest` | `NEWSDATA_API_KEY` | Real per-article `image_url` (best) | Key present AND it returns ≥1 article |
| FALLBACK | `fetchHealthTavily` | Tavily `search({topic:"news"})` | `TAVILY_API_KEY` (already in stack) | None from Tavily → hotlink each publisher's `og:image` | No key / NewsData throws / NewsData empty |

**Why two lanes, not one:** NewsData has the best images but its free tier is keyless-fragile and
plan-gates filters (see §3). Tavily is already paid-for in the stack (search vertical) and reaches
India publishers, so it is the always-available floor. This mirrors finance India, which also rides
Tavily when the premium provider can't serve a market — same pattern, different vertical.

> **Anti-pattern:** adding a third lane that throws on failure. Every lane must return an empty
> `DiscoverPayload` or be caught by the orchestrator. A health feed that 500s is worse than a stale
> one — `getOrRefresh` (in `routes.ts`) serves the last good payload on error, but only if a lane
> returned cleanly before.

---

## 2. NewsData.io lane — the primary

`fetchHealthNewsData(market)` ([`health.ts`](../../../../backend/discover/health.ts), in fn
`fetchHealthNewsData`) builds three pieces:

```ts
// image=1 → only articles WITH an image; removeduplicate=1 → server-side dedup.
const base = `${NEWSDATA_LATEST}?apikey=${enc(key)}&language=en&image=1&removeduplicate=1`;
const filteredUrl = market === "in" ? `${base}&country=in&category=health` : `${base}&category=health`;
// country/category can be plan-gated on some keys → retry with a pure keyword query.
const keywordUrl   = `${base}&q=${enc(market === "in"
  ? "India health hospital ICMR vaccine disease"
  : "health medicine disease vaccine WHO outbreak")}`;
```

| Query param | Value | Why |
|---|---|---|
| `image=1` | filtered | The carousel is image-first; drop bodyless cards at the source so the visible page looks rich. |
| `removeduplicate=1` | server-side | Cuts wire-service reprints before our own `finalizeArticles` dedup. |
| `language=en` | always | We render English cards. |
| `category=health` | US lane | NewsData's health vertical. |
| `country=in&category=health` | India lane | Indian-origin health press. |

**The plan-gate retry is the load-bearing trick.** `category`/`country` are paid features on some
NewsData keys; a free/limited key 422s the filtered URL. So the call is wrapped:

```ts
try { data = await callNewsData(filteredUrl); }
catch (e) {
  console.warn("[discover] health NewsData filtered query failed, retrying keyword-only:", …);
  data = await callNewsData(keywordUrl);          // q= is allowed on every tier
}
```

`callNewsData` ([`health.ts`](../../../../backend/discover/health.ts)) is the strict gate:
8 s `AbortSignal.timeout`, and it **throws** on `!res.ok` OR `body.status === "error"` (NewsData
returns HTTP 200 with `status:"error"` for quota/param failures — checking only `res.ok` would
silently accept an error envelope). That throw is what the orchestrator catches to fall to Tavily.

Each item is mapped to the shared `DiscoverArticle` (no body field — see §5):

| `DiscoverArticle` field | NewsData source | Fallback |
|---|---|---|
| `id` | `article_id` | `canonicalUrl(link)` |
| `title` | `title` | (skipped if absent) |
| `source` | `source_name` → `source_id` | `hostOf(link)` |
| `url` | `link` | (skipped if absent) |
| `image` | `image_url` | `null` |
| `publishedAt` | `toIso(pubDate)` | `toIso` → "now" |
| `category` | `category[0]` | `"health"` |

If the key is missing, the lane returns `{ articles: [], provenance, needsKey: true }` — it does NOT
throw, so the orchestrator's `newsdataKey()` guard skips it cleanly and Tavily serves.

---

## 3. Tavily lane — the always-on fallback

`fetchHealthTavily(market)` runs a **trusted-domain-scoped news search** — this is the licensing
control as much as a quality control (you only ingest from sources you'd cite). Two inputs vary by
market: the domain allow-list and the query string.

```ts
const search = await tvly.search(query, {
  topic: "news", days: 7, maxResults: 25, searchDepth: "basic", includeDomains: domains,
});
```

| Param | Value | Note |
|---|---|---|
| `topic: "news"` | — | News index, not general web. |
| `days: 7` | recency window | A "latest" feed; widen only if a market is sparse. |
| `maxResults: 25` | over-fetch | Trimmed to `MAX_ARTICLES = 18` by `finalizeArticles` after dedup. |
| `searchDepth: "basic"` | cheap | Discover is a card list, not a research answer; no need for `advanced`. |
| `includeDomains` | trusted list | The allow-list IS the source-quality + licensing boundary. |

**Tavily returns no hero image**, so the lane sets `image: null`, then hotlinks each publisher's own
`og:image` via the shared `fetchOgImage` (browser-UA fetch, 7 s timeout, blockers → `null` → clean
placeholder):

```ts
const ogImages = await Promise.all(articles.map((a) => fetchOgImage(a.url)));
articles.forEach((a, i) => { a.image = ogImages[i] ?? null; });
```

**The licensing line:** `r.content` (Tavily's publisher snippet) is *deliberately not copied* into
the article — the code comments it out explicitly (`// r.content … intentionally NOT included`). The
`DiscoverArticle` type has no field to hold it. See §5.

### Trusted-domain lists (the source-quality contract)

Defined in [`health.ts`](../../../../backend/discover/health.ts) as `GLOBAL_HEALTH_DOMAINS` /
`INDIA_HEALTH_DOMAINS`. These are the only domains the Tavily lane will surface — extend them, don't
remove the authorities.

| Market | Authoritative bodies | Quality press / specialist |
|---|---|---|
| US / global | who.int, cdc.gov, nih.gov | statnews.com, medicalnewstoday.com, healthline.com, nature.com, sciencedaily.com, kffhealthnews.org, medscape.com |
| India (`?market=in`) | who.int, icmr.gov.in, pib.gov.in, mohfw.gov.in | thehindu.com, timesofindia.indiatimes.com, indianexpress.com, ndtv.com, livemint.com, hindustantimes.com, downtoearth.org.in, theprint.in |

> Tiering note: government/standards bodies (WHO/CDC/NIH/ICMR/MoHFW/PIB) outrank general press for
> trustworthiness. The list mixes both because press provides *freshness/volume* and bodies provide
> *authority*. The deeper source-quality tier model lives in `health-domain-coverage.md`; medical
> safety framing (how to caveat an answer built on these) is `medical-info-safety.md`.

---

## 4. Categories & cadence

**Categories.** The feed is a single `category: "health"` stream (NewsData `category[0]` passthrough,
Tavily hardcoded `"health"`) — Lumina does NOT fan out to per-disease subfeeds at this tier. The
frontend market toggle (`?market=us|in`) is the only real partition. If you add health subtopics
(mental health, nutrition, fitness, sleep — see `health-domain-coverage.md`), do it as **separate
cache keys + cron jobs**, not as an in-memory client filter (R-SCALE §A: filtering belongs on the
server, keyed and warmed).

**Cadence / caching** is owned by [`routes.ts`](../../../../backend/discover/routes.ts), not by
`health.ts` — the fetchers are pure:

| Knob | Value | Where |
|---|---|---|
| TTL (soft) | **600 s (10 min)** for health | `const TTL = { academic: 1800, health: 600 }` in `routes.ts` |
| Hard TTL | soft × 12 (≈2 h) — stale survives as fallback | `getOrRefresh` in `lib/cache.ts` |
| Cache key | `discover:health` (US) / `discover:in:health` (India) — SEPARATE keys | `discoverRoute` in `routes.ts` |
| Warmer | cron-job.org → `POST /discover/cron/refresh` (`CRON_SECRET`) | `/cron/refresh` in `routes.ts` |
| Rate limit | `financeRateLimit` middleware on the read route | `routes.ts` |
| Error behavior | 502 on a fully-failed cold read; stale-served on a warm one | `discoverRoute` try/catch + cache stale-on-error |

The cron warmer force-refreshes **all four series** (`health`, `in:health`, `academic`,
`in:academic`) by calling each fetcher with `ttl=0` through `getOrRefresh`, in a single
`Promise.allSettled` so one provider hiccup doesn't starve the others:

```ts
const jobs = [ …, ["health", () => fetchHealthDiscover("us")], ["in:health", () => fetchHealthDiscover("in")] ];
await Promise.allSettled(jobs.map(([key, fn]) => getOrRefresh(`discover:${key}`, 0, fn)));
```

**Why 10 min, not 30 s:** health news is not price-sensitive (unlike finance crypto @ 30 s). 10 min
keeps the feed live while spending NewsData/Tavily credits sparingly, and the cron warmer means a
user read is almost always a cache HIT (compute-once-serve-many). At 100× users this is unchanged —
reads are cached at one key per market; the only upstream cost is the cron tick. **Do NOT** drop the
TTL to "feel fresher": you'd burn the free tier and gain nothing a 10-min carousel needs.

> **Vercel reality:** the in-memory cache is per-instance and cold-start-wiped. Set `UPSTASH_*` for a
> shared hot cache before any real deploy, or each serverless instance re-fetches on its first read.
> (Same gotcha as finance — see `lumina-finance-architecture.md` §4.)

---

## 5. The licensing reality — the free-tier-display trap

This is the rule that gets people fired, so it's spelled out. **A free API tier is NOT a
commercial-display licence.** Technical access (the call returns 200) is unrelated to legal right to
republish. Both health lanes hardcode the gate:

```ts
// fetchHealthNewsData
const provenance: Provenance = { source: "NewsData.io", commercialOk: false,
  attribution: "Health news via NewsData.io — headlines link to publishers" };
// fetchHealthTavily
const provenance: Provenance = { source: "Tavily (health news)", commercialOk: false,
  attribution: "Health news via Tavily — headlines link to publishers" };
```

`Provenance` ([`shared.ts`](../../../../backend/discover/shared.ts)) mirrors finance's shape so the
frontend renders attribution uniformly. **`commercialOk` stays `false` for ALL publisher-derived
health content** until a display licence is signed — build-and-demo-only, never cleared for public
launch on the basis that "the API worked."

### What the card may and may NOT expose

The legal ship-rule (stated atop both `health.ts` and `shared.ts`):

| ✅ May expose (the card shape) | ❌ Never store or display |
|---|---|
| Headline (`title`) | Publisher article **body** |
| Source label (`source`) | NewsData/Tavily **snippet/abstract** (`r.content`) |
| Outbound link (`url`) to the publisher | A **re-hosted** copy of the image on our origin |
| Hotlinked `og:image` (the publisher's own URL) | Any paraphrase that substitutes for reading the source |
| Timestamp (`publishedAt`) | — |

This is **enforced by the type**, not by discipline: `DiscoverArticle` in
[`shared.ts`](../../../../backend/discover/shared.ts) has **no `content` field**. There is nowhere to
put body text. The Tavily lane's `// r.content … intentionally NOT included` comment marks the one
place a snippet was available and dropped on purpose.

### Transformative synthesis (the only way to use the text)

A *chat answer* may discuss what the news says — but only as **transformative, multi-source synthesis
in Lumina's own prose with link-out `[n]` citations**, produced by the research pipeline
(`/perplexity_ask`), never by republishing a card. The Discover feed itself does no synthesis; it is
pure headline+link. (Finance does the same: its LLM summaries/research are own-prose syntheses over
many sources — see finance `llm-market-narratives.md`.)

### Hotlinking vs re-hosting

We **hotlink** the publisher's `og:image` (the browser loads it from the publisher's CDN with our
attribution) and never copy it to our origin. `fetchOgImage` only *reads the meta tag* to get that
URL; the image bytes are served by the publisher. If a blocker/UA-wall returns nothing → `null` → a
clean placeholder, never a re-hosted copy.

---

## 6. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Flipping `commercialOk:true` because "the NewsData/Tavily call worked." | It gates *legal display*, not technical access. Stays `false` until a display licence is signed. |
| Storing/showing `r.content` / `image_url`-snippet / abstract to look richer. | Headline + source + link-out + hotlinked image + timestamp only. The card type has no body field by design. |
| Re-hosting the publisher's image on our origin/CDN. | Hotlink the source's own `og:image` via `fetchOgImage`; blockers → `null` → placeholder. |
| Adding a lane that throws on missing key / failure. | Return an empty `DiscoverPayload` (or `needsKey:true`); let the orchestrator fall through to Tavily. |
| Checking only `res.ok` on NewsData. | Also check `body.status === "error"` — NewsData returns 200 with an error envelope on quota/param failures. |
| Dropping the TTL to "feel fresher." | Health news isn't price-data; 10 min + cron warming is correct. A shorter TTL just burns the free tier. |
| Treating India like the US path (US publishers, no country filter). | `market==="in"` → `country=in&category=health`, `INDIA_HEALTH_DOMAINS`, and a separate `discover:in:health` cache key. |
| Removing WHO/CDC/ICMR from the domain list to "get more results." | Keep the authorities; extend the press list instead. The allow-list is the licensing + quality boundary. |
| Re-implementing dedup / canonicalization / date parsing in `health.ts`. | Reuse `canonicalUrl` / `hostOf` / `toIso` / `finalizeArticles` from `shared.ts` — every Discover vertical shares them. |
| Answering a "latest outbreak today" health query from the model's memory. | That's the research pipeline (live web search via `onAsk`) — never fabricate a health fact or date. |
| Per-disease subfeeds filtered client-side. | Server-side: separate cache keys + cron jobs per subtopic (R-SCALE §A). |

---

## 7. Adding a new health source — checklist

1. **Write a pure lane** `fetchHealth<Provider>(market): Promise<DiscoverPayload>` in
   [`health.ts`](../../../../backend/discover/health.ts). Map to `DiscoverArticle` (no body),
   `toIso` the date, `canonicalUrl` the id fallback.
2. **Hardcode `commercialOk:false`** + an honest `attribution` in its `Provenance`. (You can only
   set `true` with a signed display licence — and that's a finance-licensing-ref conversation.)
3. **Never copy** the provider's body/snippet/abstract. If the provider has an image URL, pass it as
   `image`; else leave `null` and let `fetchOgImage` hotlink the `og:image`.
4. **Return cleanly on failure** (empty payload / `needsKey:true`, never throw past the orchestrator)
   and wire it into `fetchHealthDiscover`'s try/fallback chain so the feed never goes dark.
5. **Finalize:** return `{ articles: finalizeArticles(articles), provenance }` — dedup + image-first
   sort + cap at `MAX_ARTICLES` come free from `shared.ts`.
6. **No route/cache work** for a new *lane* (the orchestrator is already routed). A new *topic* needs
   a `discoverRoute(...)` line, a `TTL` entry, and a `/cron/refresh` job in
   [`routes.ts`](../../../../backend/discover/routes.ts).
7. **Restart the dev server** for any new backend file (Bun `--hot` misses them) and use explicit
   `.js` on relative imports or Vercel's ESM resolver fails the build.

**Done when:** `GET /discover/health?market=us|in` returns 200 with image-first articles, the lane
falls back cleanly when its key is absent, `commercialOk:false` rides every payload, and no publisher
body text is anywhere in the response.
