# Lumina Health Vertical — the wiring map

> The whole Health vertical, file by file: the `health.ts` feeds (NewsData.io → Tavily fallback),
> the `/discover/health` route + cron warmer, the `HealthView` UI + shared `discover-parts`, the
> `useHealthDiscover` hook, and the workflows/upload path that turns a lab report into a multimodal
> chat turn. Read this first when lost in the Health tab. `lumina-` ref = THIS codebase; cite the
> live file before you change it (line numbers drift). Sibling refs: `health-news-sourcing.md`
> (source selection/debugging + licensing depth), `discover-feed-architecture.md` (the shared
> `shared.ts` card pattern), `health-workflows-and-upload.md` (multimodal/PHI depth),
> `medical-info-safety.md` (the not-advice contract).

---

## 1. The two faces of "Health"

Like Finance, Health is **two subsystems** that meet at the chat agent — but unlike Finance there is
no Health-specific agent: Health reuses the shared Discover/research pipeline.

1. **Public Discover reads** — one cached news card feed (`GET /discover/health`). No auth, no LLM on
   the hot path. Compute-once-serve-many, market-aware (`?market=us|in`).
2. **The chat hand-off** — every search-box submit, every workflow card click, and the lab-report
   upload all call the same frontend `onAsk(query, attachments)` → Dashboard `handleAsk` →
   `POST /perplexity_ask`. Health owns *what gets asked* (the prompts, the upload-to-attachment step);
   the **research-agent** skill owns what happens after (web search → `[n]` citations → stream).

```
                       ┌──────────────────────────────────────────────┐
 Browser (Health tab)  │  Backend (Bun + Express, on Vercel)          │  Free-tier providers
 ───────────────────►  │                                              │  ─────────────────
 GET /discover/health  │  routes.ts ─► getOrRefresh ─► health.ts ──────┼─► NewsData.io (category=health)
   ?market=us|in       │   (cache)     (cache.ts)    fetchHealthDiscover│   Tavily news (fallback)
                       │                              ├─ NewsData primary│
 POST /perplexity_ask  │                              └─ Tavily fallback │
   {query, attachments}│  index.ts ─► buildAttachmentParts ─► streamText┼─► Tavily (web search)
   (workflow / upload) │   (shared research pipeline, image/file parts) │   + vision model (Claude…)
 ◄─── SSE stream ──────│                                              │
                       └──────────────────────────────────────────────┘
 cron-job.org ──► POST /discover/cron/refresh (CRON_SECRET) ──► warms us+in health & academic keys
```

---

## 2. File-by-file

### Data layer (feeds)
- [`backend/discover/health.ts`](../../../../backend/discover/health.ts) — **the fetchers + orchestrator.**
  - `fetchHealthDiscover(market="us")` (the orchestrator, exported): if a NewsData key is set, try
    `fetchHealthNewsData`; if it throws OR returns zero articles, fall through to `fetchHealthTavily`.
    No key at all → straight to Tavily. The feed never goes dark (Non-Negotiable #5). See the
    try/catch in `fetchHealthDiscover`.
  - `fetchHealthNewsData(market)` — NewsData.io `/api/1/latest`, `language=en&image=1&removeduplicate=1`
    (`image=1` = only articles with a hero image; `removeduplicate=1` = server-side dedup). Two URLs:
    a **filtered** query (`&category=health`, `+&country=in` for India) and a **keyword** retry
    (`&q=health medicine disease…`) because `country`/`category` are **plan-gated on some keys** — the
    filtered query throws → it retries keyword-only. Returns `{articles, provenance, needsKey?}`.
  - `fetchHealthTavily(market)` — `tvly.search(query, {topic:"news", days:7, maxResults:25,
    searchDepth:"basic", includeDomains})`. Tavily returns **no hero image**, so it sets `image:null`
    then back-fills each card with `fetchOgImage(url)` (hotlink the publisher's own og:image, never
    re-host). `r.content` (the publisher snippet) is **deliberately not read** — the comment says so.
  - `newsdataKey()` reads `process.env.NEWSDATA_API_KEY` (backend-only; Non-Negotiable #6).
  - `callNewsData(url)` — 8s `AbortSignal.timeout`; throws on `!res.ok` or `body.status === "error"`
    so the orchestrator's catch can fall back.
  - Trusted-domain lists: `GLOBAL_HEALTH_DOMAINS` (who.int, cdc.gov, nih.gov, statnews, healthline,
    nature, …) and `INDIA_HEALTH_DOMAINS` (who.int, icmr.gov.in, pib.gov.in, mohfw.gov.in + Indian
    press). The Tavily lane is **scoped to these** so a fallback search can't surface junk.
  - Both lanes hardcode `commercialOk:false` in their `Provenance` (Non-Negotiable #3).
- [`backend/discover/shared.ts`](../../../../backend/discover/shared.ts) — the **shared Discover toolkit**
  health depends on (owned by `discover-feed-architecture.md`, summarized here):
  - `DiscoverArticle` = `{id, title, source, url, image, publishedAt, category}` — **no `content`/body
    field by design** (the licensing ship-rule is enforced by the *type*).
  - `Provenance` = `{source, commercialOk, attribution}` (mirrors finance so the UI renders identically).
  - `finalizeArticles()` — dedup by canonical URL **and** lowercased title, drop title/url-less items,
    cap at `MAX_ARTICLES=18`, sort image-bearing cards first (rich carousel page). Both health lanes
    pass through it.
  - `canonicalUrl()`/`hostOf()`/`toIso()`/`fetchOgImage()` — reused by every vertical; never
    re-implement these in `health.ts`.

### Read route + cron warmer
- [`backend/discover/routes.ts`](../../../../backend/discover/routes.ts) — `discoverRouter`, mounted at
  `/discover` in [`backend/index.ts`](../../../../backend/index.ts) (`app.use("/discover",
  discoverRouter)` at index.ts:57). Mounted **before auth** → public.
  - `discoverRoute(topic, ttl, fetcher)` — the market-aware cached read factory: `?market=in` →
    `discover:in:<topic>` key; default → `discover:<topic>`. Wraps `getOrRefresh`, merges
    `fetchedAt`+`stale` into the JSON, and 502s with a logged message on upstream failure. (Mirrors
    finance's `marketReadRoute`.)
  - `GET /health` = `discoverRoute("health", TTL.health, fetchHealthDiscover)` behind `financeRateLimit`.
  - `TTL = { academic: 1800, health: 600 }` — health is **10 min** (news moves faster than research).
  - `POST /cron/refresh` — secret-guarded (`CRON_SECRET`, Bearer or `x-cron-secret`; skipped if unset).
    Force-refreshes all four series (job labels `health`, `in:health`, `academic`, `in:academic`)
    via `getOrRefresh("discover:" + key, 0, fn)` (ttl 0 = always re-fetch) under
    `Promise.allSettled`, then reports `{key, ok}` per job. Wire cron-job.org to POST here to keep
    every key hot.

### The chat hand-off (shared, not Health-owned)
- [`backend/index.ts`](../../../../backend/index.ts) `buildAttachmentParts(input)` (index.ts:285) —
  maps each raw attachment to an AI-SDK `ContentPart`: `image/*` → `{type:"image", image:base64,
  mediaType}`, everything else → `{type:"file", data:base64, mediaType, filename}`. Used by both
  `/perplexity_ask` (index.ts:670) and `/perplexity_ask/follow_up` (index.ts:844). This is where an
  uploaded lab report enters the model. **No persistence** — it's a per-request part only (Non-Neg #4).

### Frontend
- [`frontend/src/components/discover/health-view.tsx`](../../../../frontend/src/components/discover/health-view.tsx)
  — `HealthView({onAsk})`: header, search textarea, `WORKFLOWS` cards, the right-rail file-upload,
  and the Discover carousel + `MarketToggle`. State: `market`, `value` (textarea), `fileRef`.
- [`frontend/src/components/discover/discover-parts.tsx`](../../../../frontend/src/components/discover/discover-parts.tsx)
  — shared building blocks: `Carousel<T>` (paged grid, arrows + dots), `ArticleCard` (image +
  favicon + source + `timeAgo` + title, opens `url` in a new tab), `CategoryCard`, `timeAgo`,
  `faviconFromUrl`. Health uses `Carousel` + `ArticleCard` (not `CategoryCard` — that's Academic).
- [`frontend/src/hooks/use-discover.ts`](../../../../frontend/src/hooks/use-discover.ts) —
  `useHealthDiscover(market)`: TanStack `useQuery`, key `["discover","health",market]`,
  `refetchInterval: 600_000` (**aligned to the 10-min backend cache** — don't poll faster than the TTL).
- [`frontend/src/lib/discover-api.ts`](../../../../frontend/src/lib/discover-api.ts) —
  `fetchHealthDiscover(market)` → `GET /discover/health[?market=in]`; re-exports the finance card types.
- [`frontend/src/components/attachments.tsx`](../../../../frontend/src/components/attachments.tsx) —
  `fileToAttachment(file)`: `FileReader.readAsDataURL` → strips the `data:…;base64,` prefix →
  `{name, mediaType, base64}`. (`MAX_BYTES = 20MB`.)
- [`frontend/src/pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx) — mounts
  `<HealthView onAsk={handleAsk} />` (Dashboard.tsx:281); `handleAsk` resets the conversation, switches
  to the answer tab, and runs the turn (Dashboard.tsx:149).

---

## 3. Request flows

### A. The Discover feed (read)
1. `HealthView` mounts → `useHealthDiscover(market)` fires `GET /discover/health[?market=in]`.
2. `discoverRoute` resolves the key (`discover:health` / `discover:in:health`) → `getOrRefresh`.
3. **HIT** → cached payload (`stale` flagged if past soft TTL). **MISS** → `fetchHealthDiscover(market)`:
   NewsData primary → (throws/empty) → Tavily fallback → `finalizeArticles`.
4. JSON `{articles, provenance, fetchedAt, stale}` → `Carousel` of `ArticleCard`s. The Discover
   subhead renders `data.provenance.attribution`.
5. The cron warmer re-runs all four feeds on schedule so step 3 is almost always a HIT.

### B. A workflow / search / upload (chat hand-off)
1. **Search box:** submit → `ask(value)` → `onAsk(query, [])`.
2. **Workflow card:** click → `ask(w.prompt)` (the canned, deliberately-guidance-framed prompt).
3. **Upload:** pick file → `onUpload` → `fileToAttachment(file)` → `ask("Summarize this health
   report… Note anything I should discuss with a doctor.", [att])`.
4. All three → Dashboard `handleAsk(query, attachments)` → `POST /perplexity_ask` with
   `{query, attachments}`.
5. Backend → `buildAttachmentParts` (upload → `image`/`file` part) → shared research pipeline
   (web search → `streamText` → `<ANSWER>`/`<FOLLOW_UPS>` + `<SOURCES>`). **research-agent** owns this.

> Note the verticals: Health workflows do **not** send `vertical:"finance"`. They run the default
> Discover/research pipeline (live web search + citations), which is exactly right for "today's
> outbreak" health questions — never answer those from model memory (anti-pattern below).

---

## 4. The two source lanes — decision framework

| Situation | Lane used | Why |
|-----------|-----------|-----|
| `NEWSDATA_API_KEY` set, filtered query returns ≥1 article | **NewsData filtered** | Real per-article hero images; richest cards. |
| Key set but `country`/`category` plan-gated (filtered throws) | **NewsData keyword** (`&q=…`) | Same key, no gated params; still real images. |
| Key set, keyword also empty/throws | **Tavily fallback** | `fetchHealthDiscover` catch / empty-check. |
| No key at all | **Tavily fallback** | `fetchHealthNewsData` returns `needsKey`; orchestrator skips it. |
| `market === "in"` | Whichever lane, **India-scoped** | NewsData `&country=in`; Tavily `INDIA_HEALTH_DOMAINS` + India query; key `discover:in:health`. |

Selection logic, condensed from `fetchHealthDiscover`:

```ts
export async function fetchHealthDiscover(market: Market = "us"): Promise<DiscoverPayload> {
  if (newsdataKey()) {
    try {
      const nd = await fetchHealthNewsData(market);
      if (nd.articles.length > 0) return nd;   // primary won
    } catch (e) { /* log + fall through */ }
  }
  return fetchHealthTavily(market);            // the feed always returns SOMETHING
}
```

And the NewsData filtered→keyword retry (inside `fetchHealthNewsData`):

```ts
try { data = await callNewsData(filteredUrl); }   // &category=health (+&country=in)
catch (e) { data = await callNewsData(keywordUrl); }  // plan-gated → pure &q= keyword query
```

---

## 5. The card shape & the legal ship-rule (why there's no body field)

A health card carries **only**: `title`, `source`, `url` (outbound), `image` (hotlinked og:image,
never re-hosted), `publishedAt`, `category`. The publisher's article body/snippet is **never** stored
or shown — and the `DiscoverArticle` type has no field to hold one, so this is enforced structurally,
not by discipline. The Tavily lane proves the intent by explicitly dropping `r.content`.

`commercialOk:false` on every health `Provenance` means: build-and-demo-only, **not** cleared for
public launch. A free API tier is not a commercial-display licence. (Deep rationale:
`health-news-sourcing.md` + the `discover-news-licensing` memory + finance
`data-licensing-and-compliance.md`.)

---

## 6. UI anatomy (`HealthView` + `discover-parts`)

| Region | Component / source | Behaviour |
|--------|--------------------|-----------|
| Search box | `<textarea>` + submit | Enter (no Shift) → `ask(value)`; clears after. Runs the web-search answer flow. |
| Health Workflows | `WORKFLOWS[]` → buttons | 6 cards (Health review, Nutrition, Lab interpreter, Visit prep, Fitness, Sleep). Each `onClick={() => ask(w.prompt)}`. Prompts are guidance-framed ("Explain how to read…", "evidence-based ways to…") — never "diagnose me." |
| Right rail — Health files | `fileRef` + hidden `<input>` | `accept="image/*,application/pdf,.txt,.csv,.doc,.docx"`; `onUpload` → `fileToAttachment` → canned summarize prompt + attachment. (A commented-out "Connectors" card is parked above it.) |
| Discover | `useHealthDiscover` → `Carousel`/`ArticleCard` | Subhead = `provenance.attribution`. Loading → spinner; error → "Couldn't load — the source may be rate-limited or down."; empty → "No health news right now." |
| Market toggle | `MarketToggle` | `us` shows as **"Global"**, `in` as **"India"**; flips `market` → re-queries the India cache key. |

`ArticleCard` self-heals broken media: both the hero `<img>` and the favicon `<img>` hide themselves
`onError` (`e.currentTarget.style.display="none"`) — a dead hotlink degrades to a clean card, never a
broken-image glyph. `Carousel` is `perPage={3}` here; pages computed from `items.length`.

---

## 7. The workflows / upload feature (the multimodal path)

The upload is the one place Health does something the other Discover tabs don't: it converts a
user's file into model-readable content **for one request only**.

```
Upload lab PDF/image
  └─ onUpload(e)  [health-view.tsx]
       └─ fileToAttachment(file)              // base64, data-URL prefix stripped  [attachments.tsx]
            └─ ask("Summarize this health report… discuss with a doctor.", [att])
                 └─ onAsk → handleAsk → POST /perplexity_ask {query, attachments}
                      └─ buildAttachmentParts(attachments)   // image|file part   [index.ts:285]
                           └─ streamText(... messages with the part ...)          // shared pipeline
```

Hard rules (see `health-workflows-and-upload.md` for depth):
- **PHI-adjacent.** Never persist the file to disk/DB, never log its bytes, never let it cross users,
  never enter the semantic cache. It lives as a per-request base64 part and is gone after the turn.
- **Model must be vision/doc-capable** (Claude/Gemini/GPT). Sonar can't read `image`/`file` parts —
  route uploads to a capable model or the report is silently ignored.
- The canned prompt is deliberately framed as "summarize + flag things to discuss with a doctor,"
  never "tell me what's wrong with me" (the safety contract, §Non-Negotiable #1 in SKILL.md).

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Adding a `content`/`snippet` field to the card to look richer. | The card type has none by design; show headline + source + link-out + image + timestamp only. |
| Re-hosting the publisher's image on our origin. | Hotlink the source's own og:image via `fetchOgImage` (browser UA); blockers → `null` → `ArticleCard` hides it. |
| Letting the feed 500 / go blank when NewsData is keyless or rate-limited. | The orchestrator falls back to the trusted-domain Tavily search; `getOrRefresh` serves stale on error. |
| Polling `useHealthDiscover` faster than the 10-min cache to "feel live." | Keep `refetchInterval` aligned to `TTL.health`; the cron warmer keeps the key hot, not the client. |
| Treating India like the US path (US publishers, no country filter). | `market==="in"` → NewsData `&country=in`, `INDIA_HEALTH_DOMAINS`, India query, `discover:in:health` key. |
| Re-implementing dedup / og:image / date parsing in `health.ts`. | Reuse `finalizeArticles`/`fetchOgImage`/`canonicalUrl`/`toIso` from `shared.ts`. |
| A workflow prompt that says "diagnose me" or asks for a drug dose. | Frame as guidance + "discuss with a doctor"; mirror the existing `WORKFLOWS` prompts. |
| Answering a "latest outbreak / today" health query from the model's memory. | Route via `onAsk` → the live web-search research pipeline; never fabricate health facts or dates. |
| Sending an uploaded PDF to Sonar (non-vision). | Route to a vision/doc-capable model; `buildAttachmentParts` emits `image`/`file` parts those read. |
| Persisting / logging / caching an uploaded lab report. | Per-request base64 part only; no store, no logs of bytes, excluded from the semantic cache. |
| Flipping `commercialOk:true` because "the NewsData call worked." | It gates *legal display*, not technical access — stays `false` until a display licence is signed. |

---

## 9. Where to add things (cheat sheet)

- **New health source / lane** → add a `fetchHealth<X>` in `health.ts` returning the shared
  `DiscoverPayload` (no body field, `commercialOk:false`, run through `finalizeArticles`), wire it into
  `fetchHealthDiscover`'s fallback chain so the feed never goes dark. See `health-news-sourcing.md`.
- **New trusted publisher** → add the domain to `GLOBAL_HEALTH_DOMAINS` / `INDIA_HEALTH_DOMAINS`.
- **New Discover topic (like health)** → fetcher file + `discoverRoute("<topic>", ttl, fetcher)` in
  `routes.ts` + a job in `/cron/refresh` + a `use<Topic>Discover` hook aligned to the TTL.
- **New workflow card** → append to `WORKFLOWS[]` in `health-view.tsx` with a guidance-framed `prompt`.
- **New market (e.g. UK)** → extend `Market` in `shared.ts` + the per-lane domain/query branches in
  `health.ts`; routes are already `?market=`-aware via `discoverRoute`; separate cache key is automatic.

---

## 10. Deploy gotchas (inherited repo-wide)

| Concern | Reality | Fix |
|---------|---------|-----|
| New backend file (e.g. a new source) | Bun `--hot` doesn't pick it up. | **Full dev-server restart.** |
| Relative imports | Vercel's strict Node ESM. | Explicit `.js` extension (`./shared.js`, `./health.js`) — Bun is lenient locally, Vercel fails the build. |
| Long-lived timers/sockets | Vercel functions freeze between requests. | Health has none on the hot path; refresh is an external cron → `POST /discover/cron/refresh`. |
| In-memory cache on serverless | Per-instance, cold-start-wiped. | Set `UPSTASH_*` for a shared hot cache before a real deploy. |
| Keys | Never reach the client. | `NEWSDATA_API_KEY`/`TAVILY_API_KEY` read from `process.env` server-side; the browser only hits `/discover/health`. |
