# Paper Cards & the Academic Home UI

> The frontend half of the Academic vertical: how `AcademicView` renders the search box + topic/
> paper carousels, what the `ArticleCard`/`CategoryCard`/`Carousel` primitives draw, and the live
> wiring (and the gaps) between this UI and the OpenAlex feed. `lumina-` ref = THIS codebase; cite
> the live file before you change it (line numbers drift). Read this when building or styling the
> academic UI. Adjacent refs: **lumina-frontend** owns the carousel/card primitives + app shell in
> the abstract; **research-agent** owns the web-search answer flow that every card's `onAsk`
> actually fires; `lumina-academic-vertical.md` (sibling) maps the backend fetcher + route this UI
> is meant to consume; `openalex-and-scholarly-apis.md` documents the `DiscoverArticle` field
> source.

---

## 1. The one fact that reframes everything

**`AcademicView` does not render fetched papers.** It is a *static* discovery surface: a search
box plus two carousels of hardcoded category cards. Every card and chip fires a *generated
natural-language query* through `onAsk` → the shared `/perplexity_ask` web-search flow — it never
hits `/discover/academic`.

See [`frontend/src/components/discover/topic-discover-view.tsx`](../../../../frontend/src/components/discover/topic-discover-view.tsx),
the `TRENDING`/`RESEARCH`/`CHIPS` constants (file:13–33) and every `onClick={() => ask(...)}`.

This is deliberate — the header comment says it: *"papers are a library — you browse by category,
not a flat paper dump."* The consequence for you:

| If the task is… | Then… |
|---|---|
| Restyle / add a category card / change the search box | Edit `topic-discover-view.tsx` only; no data layer involved. |
| Wire a real paper feed into the home (cards from OpenAlex) | The fetch hook ([`useAcademicDiscover`](../../../../frontend/src/hooks/use-discover.ts)) and the card primitive ([`ArticleCard`](../../../../frontend/src/components/discover/discover-parts.tsx)) **already exist** but are **not used by `AcademicView`**. You are wiring two finished parts together — see §6. |
| Change what a card "asks" | Edit the `ask(...)` template strings; the answer is rendered by the chat view, not here. → **research-agent**. |

Do not "add fetching to the cards" by reinventing it — the hook, the API client, the type, and the
card component are all built. The gap is purely that `AcademicView` renders `CategoryCard`
(static) instead of `ArticleCard` (data).

---

## 2. Component map

```
AcademicView (topic-discover-view.tsx)          ← the page; props: { onAsk }
├─ <h1> "lumina academic"                        gradient title (foreground / muted)
├─ <form> search box                             textarea + MicButton + submit → ask(value)
├─ CHIPS row                                     5 buttons → ask("Latest <chip> research … <year>")
├─ Trending Topics  <section>
│   └─ Carousel<Category> perPage=3
│        └─ CategoryCard (×6)                     → ask("…latest research trends in <label>…")
└─ Research Papers  <section>
    └─ Carousel<Category> perPage=3
         └─ CategoryCard (×6)                     → ask("…latest research papers … in <label>…")
```

Shared primitives live in
[`frontend/src/components/discover/discover-parts.tsx`](../../../../frontend/src/components/discover/discover-parts.tsx)
(reused by Academic AND Health):

| Export | What it draws | Used by AcademicView? |
|---|---|---|
| `Carousel<T>` | paged grid (1/2/3 cols responsive) + prev/next + dot pager; `perPage` slice | ✅ both sections |
| `CategoryCard` | full-bleed image, dark gradient, bottom-left label; whole card is a `<button>` | ✅ the static cards |
| `ArticleCard` | news/paper card: optional image, favicon + source + `timeAgo`, 3-line clamped title; whole card is an `<a target=_blank>` | ❌ built, not wired in (this is the paper card) |
| `wiki(file)` | Wikimedia public-domain image URL helper | ✅ for category art |
| `timeAgo(iso)` | "just now / N min ago / Nh ago / Nd ago" | via `ArticleCard` |
| `faviconFromUrl(url)` | Google s2 favicon by hostname | via `ArticleCard` |
| `type Category` | `{ label, image }` | ✅ |

---

## 3. The search box (the primary surface)

[`topic-discover-view.tsx`](../../../../frontend/src/components/discover/topic-discover-view.tsx)
form, file:58–96. The pattern to copy for any Lumina composer:

- **Auto-growing textarea**, not an input: `field-sizing-content` + `rows={1}` +
  `max-h-[30vh] min-h-[28px]` + `resize-none`. One line until you type, grows to a cap, then
  scrolls.
- **Enter submits, Shift+Enter newlines** — handled in `onKeyDown` (`e.key === "Enter" && !e.shiftKey`)
  AND in the form `onSubmit`. Both call `ask(value)` then clear `value`.
- **`ask` guards empty:** `const t = q.trim(); if (t) onAsk(t, [])`. The second arg is the
  `Attachment[]` (always `[]` here — academic home has no upload; contrast HealthView).
- **Submit button is disabled + restyled when empty** (`!value.trim()` → muted secondary vs
  primary). Keep this; a live-looking enabled button on an empty box is the amateur tell.
- **`<MicButton />`** is dropped in with no props — it manages its own STT state. Reuse, don't
  reimplement.

```tsx
const ask = (q: string) => { const t = q.trim(); if (t) onAsk(t, []); };
// form onSubmit AND textarea Enter both: ask(value); setValue("");
```

Focus/ring conventions (match across the app): container
`focus-within:border-ring/60`; interactive controls
`focus-visible:ring-[3px] focus-visible:ring-ring/50`.

---

## 4. Category cards & the generated-query pattern

A `CategoryCard` is a button, not a link — clicking it *runs a search*, it does not navigate. The
query is a **template the model can act on**, with the live year interpolated so "latest" stays
honest:

```tsx
const year = new Date().getFullYear();
// chip:      ask(`Latest ${c.toLowerCase()} research breakthroughs and notable papers in ${year}`)
// trending:  ask(`What are the latest research trends in ${t.label.toLowerCase()} in ${year}?`)
// research:  ask(`Show the latest research papers and key findings in ${r.label} (${year}), with links.`)
```

The "with links" suffix on the Research Papers cards is load-bearing — it nudges the answer flow to
surface citeable sources. When you add a card, **write the full query template**, don't pass a bare
label.

Card art is **public-domain Wikimedia artwork** via `wiki(...)` (file:13–31) — chosen because the
URLs are verified-stable and license-clean (CC0/PD), the same licensing discipline the backend
applies to data. Do not drop in arbitrary hotlinked images; pick PD art and route it through
`wiki()`.

---

## 5. The paper card (`ArticleCard`) — the data renderer

This is the component that renders a real OpenAlex paper. It consumes a `DiscoverArticle`
([`frontend/src/lib/finance-api.ts`](../../../../frontend/src/lib/finance-api.ts) file:121–129,
re-exported by `discover-api.ts`):

```ts
interface DiscoverArticle {
  id; title; source; url; image: string | null; publishedAt: string; category;
}
```

How `ArticleCard` maps each field
([`discover-parts.tsx`](../../../../frontend/src/components/discover/discover-parts.tsx) file:122–159):

| Field | Render | Note |
|---|---|---|
| `url` | wraps the whole card in `<a target="_blank" rel="noopener noreferrer">` | the authoritative link (DOI > landing > OpenAlex id, decided server-side) |
| `image` | `aspect-video` cover image, only if non-null | imageless cards render fine — no broken placeholder |
| `source` | favicon + venue/publisher name, `truncate` | favicon via `faviconFromUrl(url)` |
| `publishedAt` | `· {timeAgo(publishedAt)}` | relative time |
| `title` | `line-clamp-3` 3-line title | already JATS-stripped by the backend fetcher |

**Authors / abstract / venue note:** the current `DiscoverArticle` contract carries **no authors
and no abstract** — only `source` (which the backend sets to the venue/journal name). So a paper
card today shows *venue + title + date + link*, not an author list or an abstract snippet. If a
design needs authors/abstract, that is a **contract change**: extend `DiscoverArticle` (shared by
all discover feeds — finance/health too), populate it in `fetchAcademicDiscover`, then render it
here. Do not fake authors client-side. (Field availability: see `openalex-and-scholarly-apis.md`.)

**Graceful image failure is mandatory and already done:** both the cover and the favicon set
`onError={(e) => e.currentTarget.style.display = "none"}`. A dead OpenAlex/favicon URL collapses to
nothing, never a broken-image glyph. Keep this on any new `<img>`.

---

## 6. Decision framework — "wire a real paper feed into the home"

The most likely real task. The parts and the one missing seam:

| Part | Status | File |
|---|---|---|
| Fetch hook (`useAcademicDiscover(market)`, 30-min poll aligned to the 1800s backend cache) | ✅ built | [`use-discover.ts`](../../../../frontend/src/hooks/use-discover.ts) |
| API client (`fetchAcademicDiscover` → `GET /discover/academic`, `?market=in` switch) | ✅ built | [`discover-api.ts`](../../../../frontend/src/lib/discover-api.ts) |
| Payload type (`DiscoverPayload { articles, provenance, needsKey?, stale? }`) | ✅ built | `finance-api.ts` file:130–135 |
| Card component (`ArticleCard`) | ✅ built | `discover-parts.tsx` file:122 |
| **Render `ArticleCard`s from `useAcademicDiscover().data.articles` inside `AcademicView`** | ❌ **the gap** | `topic-discover-view.tsx` |

Wiring recipe (do it like the loading-state table in §7):

```tsx
const { data, isLoading, isError } = useAcademicDiscover(market); // market from app section state
// add a section under Research Papers:
<section className="space-y-3">
  <h2 className="text-base font-semibold text-foreground">Latest Papers</h2>
  {isLoading ? <CardSkeletons n={6} />
   : isError || !data?.articles?.length ? <EmptyState />
   : <Carousel items={data.articles} perPage={3} render={(a) => <ArticleCard key={a.id} a={a} />} />}
</section>
```

`Carousel<T>` is generic — it already accepts `DiscoverArticle[]`; pass `render={(a) => <ArticleCard a={a} />}`.
Do **not** filter/sort `articles` in React — the backend already ranks, caps, and dedupes
(`finalizeArticles`). Render the page it sends. (Ranking rationale: `academic-search-and-ranking.md`.)

---

## 7. Loading, empty, and error states

`AcademicView` today has **no loading/empty/error states** because it fetches nothing — the static
cards are always present. The moment you wire in `useAcademicDiscover` (§6) you own all three.
TanStack Query gives you `isLoading` / `isError` / `data`; map them:

| State | Render | Why |
|---|---|---|
| `isLoading` (first load) | skeleton cards in the same grid (`aspect-video` block + 2 text bars), NOT a spinner | layout must not jump when data arrives; matches the card shape |
| `isError` or empty `articles` | quiet inline empty state ("No recent papers right now."), keep the search box + categories above it usable | the page is still useful without the feed; never blank-screen |
| `data.stale === true` | optional subtle "updated a while ago" badge | honesty (`DiscoverPayload.stale`); the backend serves stale-on-error rather than 500 |
| `data.needsKey === true` | n/a for academic (OpenAlex is keyless) | only health/finance feeds set this |

The poll is already correct: `refetchInterval: 1_800_000` (30 min) in `useAcademicDiscover`,
deliberately aligned to the backend's 1800s cache so the client never polls faster than the data
can change. Do not shorten it — academic research moves slowly and you'd just burn cache reads.

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| "Add fetching to the academic cards" from scratch. | The hook + API client + `ArticleCard` exist; just render `useAcademicDiscover().data.articles` through `Carousel`/`ArticleCard` (§6). |
| Rendering an author list or abstract that isn't in `DiscoverArticle`. | The contract carries `title/source/url/image/publishedAt/category` only. To show authors/abstract, extend the shared type + the backend fetcher first — never fabricate client-side. |
| Spinner-only loading that collapses, then jumps, when data lands. | Skeleton cards in the real grid shape (`aspect-video` + text bars) so layout is stable. |
| Filtering/sorting `articles` in React (`.filter`/`.sort` over the array). | The backend ranks/caps/dedupes via `finalizeArticles`; render the page as sent. The client holds a page, not a corpus. |
| `<img>` with no `onError`. | Always `onError={(e)=>e.currentTarget.style.display="none"}` (cover + favicon) so dead URLs collapse silently. |
| Passing a bare category label to `onAsk`. | Pass the full generated query template with the live `${year}` (and "with links" for paper cards). |
| Making a `CategoryCard` a link / navigating on click. | It's a `<button>` that runs a search via `onAsk`; only `ArticleCard` is an `<a>` (it links out to the paper). |
| Hardcoding `?market=in` logic in the component. | `fetchAcademicDiscover(market)` + the `marketQuery` helper already switch; pass the app's market down. |
| Hotlinking arbitrary images for category art. | Use public-domain Wikimedia art via `wiki(file)` (license-clean, verified-stable). |
| Writing "Perplexity" anywhere in the UI. | Brand is **Lumina**; the title literally renders `lumina academic`. |
| Reimplementing the composer (Enter-to-send, autogrow, mic). | Copy the §3 pattern verbatim; reuse `<MicButton/>`. |

---

## 9. Build checklist (UI change is "done" when)

1. **Static surface:** search box submits on Enter (not Shift+Enter), clears after, guards empty,
   and the submit button is disabled+muted when the box is empty; `<MicButton/>` present.
2. **Cards:** every clickable category fires a full generated query (with live `${year}`) via
   `onAsk`; category art is PD via `wiki()`.
3. **If you wired the feed:** `ArticleCard`s render from `useAcademicDiscover().data.articles`
   through `Carousel`; loading shows skeletons, empty/error shows a quiet inline state, `stale`
   surfaced; no client-side filter/sort; market is threaded.
4. **Images:** every `<img>` has `loading="lazy"` + an `onError` collapse.
5. **No fabricated fields:** nothing rendered that isn't in `DiscoverArticle` (no invented authors/
   abstracts).
6. **Brand:** "Lumina" only, never "Perplexity".
7. **Verified:** the home renders, a card click streams an answer (research-agent flow), and — if
   feed-wired — `GET /discover/academic` data shows as real, DOI-linked, recent paper cards.
