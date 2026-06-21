---
name: academic-discover
description: >
  Build Lumina's Academic vertical: the OpenAlex scholarly fetcher
  ([`backend/discover/academic.ts`](../../../backend/discover/academic.ts)), the cached
  `/discover/academic` route + cron warmer, citations/DOIs and scholarly source quality, the
  academic home UI (search box + topic/paper carousels), and academic search & ranking
  (relevance × citation impact × recency). Covers OpenAlex (works/authors/concepts/sources, CC0,
  keyless, polite-pool email) and its alternatives (Crossref, Semantic Scholar, arXiv), the
  open-access-vs-paywall distinction, never fabricating a citation, and the matching-vs-ranking
  split. Use whenever the task touches papers, DOIs, OpenAlex, scholarly search, the
  `/discover/academic` route, the academic feed/cards, or "latest research" answers.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/discover/academic.ts'
    - 'backend/discover/shared.ts'
    - 'backend/discover/routes.ts'
    - 'frontend/src/components/discover/topic-discover-view.tsx'
    - 'frontend/src/components/discover/discover-parts.tsx'
    - 'frontend/src/lib/discover-api.ts'
    - 'frontend/src/hooks/use-discover.ts'
  bashPatterns:
    - 'openalex'
    - 'discover/academic'
    - 'doi'
  promptSignals:
    phrases:
      - 'academic'
      - 'openalex'
      - 'paper'
      - 'doi'
      - 'scholarly'
      - 'citation'
      - 'research paper'
      - 'arxiv'
      - 'crossref'
    minScore: 3
---

# academic-discover — Lumina's Academic Vertical

> Build the Academic tab the way the live code does: a CC0 scholarly fetcher (OpenAlex) behind
> the same `getOrRefresh` cache + cron warmer the finance/health feeds use, cards that carry a
> stable outbound link (DOI > landing page > OpenAlex id) and NEVER a fabricated citation, and
> ranking that is relevance × citation impact × recency — never raw array order. This skill maps
> any academic task to the exact reference + the exact file in
> [`backend/discover/`](../../../backend/discover/).

---

## Domain Identity

**This skill OWNS:**
- The scholarly fetcher [`backend/discover/academic.ts`](../../../backend/discover/academic.ts)
  (`fetchAcademicDiscover(market)` → OpenAlex `/works`, the filters, JATS-strip, DOI-first URL,
  field grouping, US + India via `country_code`).
- The academic slice of the discover routes
  ([`backend/discover/routes.ts`](../../../backend/discover/routes.ts) — `GET /discover/academic`,
  the `discover:academic` / `discover:in:academic` cache keys, the 1800s TTL, the cron warmer).
- The academic-specific use of the shared card contract
  ([`backend/discover/shared.ts`](../../../backend/discover/shared.ts) — `DiscoverArticle`,
  `Provenance`, `finalizeArticles`, `canonicalUrl`/dedupe, `toIso`).
- The academic UI: [`frontend/src/components/discover/topic-discover-view.tsx`](../../../frontend/src/components/discover/topic-discover-view.tsx)
  (`AcademicView` — search box, Trending Topics + Research Papers carousels) and its rendering
  blocks in [`frontend/src/components/discover/discover-parts.tsx`](../../../frontend/src/components/discover/discover-parts.tsx).
- Scholarly **provider choice** (OpenAlex vs Crossref / Semantic Scholar / arXiv), DOI/citation
  metadata, OA-vs-paywall status, and academic **search ranking**.
- Scholarly **source quality**: peer-reviewed vs preprint, predatory-journal awareness, what makes
  a high-quality academic answer.

**This skill does NOT own (route elsewhere):**
- The shared discover/chat pipeline — the web-search answer flow that `AcademicView`'s `onAsk`
  actually fires (`/perplexity_ask`, Tavily, citation protocol) → **research-agent**.
- The generic AI-SDK engine (`streamText`/tools/`generateObject`/`loadSkill`) → **ai-sdk-agent**.
- Generic UI shell, routing, theming, the carousel/card primitives' reuse beyond academic →
  **lumina-frontend** (this skill owns the *academic composition* of those parts).
- Cache/rate-budget internals (`getOrRefresh`, Upstash, in-flight de-dupe) → owned in depth by
  **finance-markets** `caching-and-rate-budgets.md`; academic just rides it.

---

## Decision Tree

```
Academic task arrives
|
+-- "How is the Academic vertical wired? Where does X live?" ----> lumina-academic-vertical.md
+-- "Which scholarly API? OpenAlex fields? Crossref/SS/arXiv?" --> openalex-and-scholarly-apis.md
+-- "DOIs / citation metadata / OA status / dedupe / link-out" -> citations-and-dois.md
+-- "Rank papers; relevance vs citations vs recency; OA filter" > academic-search-and-ranking.md
+-- "Build/style the academic cards, carousels, search box, UI" > paper-cards-ui.md
+-- "Is this source any good? preprint vs peer-review; quality" > academic-domain-coverage.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Always link to the authoritative source; never fabricate a citation, author, year, or venue.** Every card/answer points at a real DOI, landing page, or OpenAlex id. If a field is missing, omit it — do not invent it. | `fetchAcademicDiscover` builds the link DOI > `primary_location.landing_page_url` > `id`, and `continue`s when title OR url is empty (`backend/discover/academic.ts`). A made-up DOI is the academic equivalent of a fabricated price. |
| 2 | **Prefer open-access; mark paywalled vs OA; respect attribution.** OpenAlex data is **CC0** (public domain) → free to display the title commercially, attribution courtesy only. Still set it correctly. | `Provenance` with `commercialOk:true` + the CC0 attribution string in `fetchAcademicDiscover`. CC0 is *why* academic is the cleanest of all the discover feeds (contrast the news-licensing trap in health/finance). |
| 3 | **Ranking is relevance × citation impact × recency — never just array order.** Cross-ref finance **R-SCALE §H** (matching vs ranking). | Today the feed ranks by `sort=publication_date:desc` (recency only) + `finalizeArticles` puts image-bearing cards first — a Tier-1 ranker. State that plainly and design the upgrade (cited_by_count, relevance score). See `academic-search-and-ranking.md`. |
| 4 | **Filter to real scholarship at the source, not in the client.** `type:article`, `has_doi:true`, `primary_location.source.type:journal`, and a date window are OpenAlex `filter` params — the server returns only qualifying works. | `filters[]` in `fetchAcademicDiscover`. Cuts preprint repos, type junk, and DOI-less rows before they cross the wire. |
| 5 | **Cap the future-date footgun.** OpenAlex carries records dated `2050-…`; always bound `to_publication_date:<today>` or a "latest" feed fills with garbage. | `to_publication_date:${today}` filter, commented in code. |
| 6 | **Reads are cached + warmed, never live per request.** Every `/discover/academic` hit goes through `getOrRefresh("discover:academic", 1800, …)`; the cron warmer keeps US + India hot. | `discoverRoute()` + `POST /discover/cron/refresh` in `backend/discover/routes.ts`. Academic changes slowly → a long TTL is correct. |
| 7 | **India is a SEPARATE cache key + a facet, not a fork.** `?market=in` → `discover:in:academic` + the `authorships.institutions.country_code:in` filter; same fetcher. | `discoverRoute` key switch + `if (market === "in")` push in `academic.ts`. |
| 8 | **Be polite to OpenAlex: send the mailto.** `OPENALEX_MAILTO` enters the faster, more reliable "polite pool"; it is optional but expected, sent both as the `mailto` param and the `User-Agent`. | `openalexMailto()` + the `fetch` headers in `academic.ts`. No API key exists; the email is the courtesy. |
| 9 | **Strip JATS/HTML out of titles.** OpenAlex titles carry `<scp>`, `<i>`, etc. — render the cleaned text, never raw markup. | `title.replace(/<[^>]+>/g, "")` in `academic.ts`. |
| 10 | **New backend files need a full dev-server restart** (Bun `--hot` misses them); relative imports need explicit `.js` (`./shared.js`, `./academic.js`) or Vercel's ESM resolver fails the build. | Recurring gotcha; see `lumina-academic-vertical.md`. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Letting the model write a paper title, author list, year, or DOI from memory. | Fetch real works (OpenAlex) or run the cited web-search flow; link to the DOI/landing page. No source → say so, don't invent one. |
| Constructing a DOI URL by string-guessing (`https://doi.org/10.xxxx/…`). | Use the value OpenAlex returns (`w.doi`), then `landing_page_url`, then `id`; skip the card if all are absent. |
| Ranking "latest research" purely by recency (date desc) and calling it search. | That's matching only. Add citation impact (`cited_by_count`) + a relevance score for query searches — see R-SCALE §H. |
| Pulling preprints/repositories into the "peer-reviewed" feed unmarked. | Keep `primary_location.source.type:journal` for the journal feed; if you add arXiv, label it "preprint" explicitly (see `academic-domain-coverage.md`). |
| Flipping `commercialOk:false` "to be safe" on OpenAlex data. | OpenAlex is CC0 — `commercialOk:true` is correct and earned; over-restricting hides legal content. Get the licence right per source. |
| Re-hosting or storing publisher abstracts/PDFs. | Display only what the licence allows (title is safe under CC0); link out for the full text. Treat non-OpenAlex sources per their own ToS. |
| Filtering or sorting the full result set in React. | Filter at the OpenAlex `filter=` query; cap + dedupe server-side via `finalizeArticles`. The client renders a page, not a corpus. |
| Forgetting `to_publication_date` and surfacing 2050-dated junk. | Always bound the window to `[since, today]`. |
| Rendering raw OpenAlex JATS titles (`<scp>DNA</scp>`). | Strip tags before display (done in the fetcher; keep it). |
| Hammering OpenAlex per keystroke / per request. | Debounce client search; serve the feed from cache + cron warmer; send `mailto` for the polite pool. |

---

## Output Contract (what "done" looks like)

An academic change is done when:
1. **Data path:** the series carries a `Provenance` ({source, commercialOk, attribution}) and flows
   through `getOrRefresh` with a sensible TTL (academic = slow → long); US + India use distinct
   cache keys and are both in the cron warmer.
2. **Source integrity:** every card has a real outbound link (DOI > landing page > id); no
   fabricated title/author/year/venue; titles are JATS-stripped; the date window is bounded to
   `[since, today]`.
3. **Filtering at source:** scholarly filters (`type:article`, `has_doi:true`,
   `source.type:journal`, dates, optional `country_code:in`) live in the OpenAlex query, not the
   client.
4. **Licensing:** you can state in one sentence why this source is (or isn't) cleared for display
   and what attribution renders — OpenAlex = CC0, commercialOk:true.
5. **Ranking:** for any search/sort surface you can name the ranking function (relevance × citation
   impact × recency) and which R-SCALE tier it survives; recency-only is documented as Tier-1.
6. **UI:** cards/carousels render title + source(venue) + link + timestamp with graceful imageless
   fallback; search is debounced; loading/empty states handled (see `paper-cards-ui.md`).
7. **Verified:** `GET /discover/academic?market=us|in` returns 200 with real, recent, DOI-linked
   papers; new backend files → full restart done; `.js` import extensions present.

---

## Bundled References (6 files)

Read the one or two the task needs — never the whole folder.

### Project-grounded (cite real files)
| File | Load when |
|------|-----------|
| `lumina-academic-vertical.md` | You need the full wiring map: `academic.ts` (the scholarly fetcher), the `/discover/academic` route + cron warmer + cache keys, the shared `DiscoverArticle`/`finalizeArticles` contract, and the `AcademicView` UI — how a request flows end to end and the recurring gotchas. Start here when lost. |
| `openalex-and-scholarly-apis.md` | Choosing/debugging the scholarly source: OpenAlex (works/authors/concepts/sources, free, no key, polite-pool `mailto`), the exact fields `academic.ts` reads, the `filter`/`sort`/`per_page` params, and the alternatives (Crossref, Semantic Scholar, arXiv) with a when-each matrix. |
| `paper-cards-ui.md` | Building/styling the academic UI: rendering title/authors/abstract/venue/links, the `Carousel`/`CategoryCard`/`ArticleCard` parts, the search box, imageless fallback, loading/empty states. Cross-refs **lumina-frontend** (shell) + **research-agent** (the search feed `onAsk` fires). |

### Generic domain (reusable knowledge)
| File | Load when |
|------|-----------|
| `citations-and-dois.md` | Working with DOIs and citation metadata (authors / year / venue / citation count), citation formats, linking out correctly, deduping the same work across sources, and determining open-access status. |
| `academic-search-and-ranking.md` | Designing scholarly search: relevance vs citation-count vs recency ranking, open-access filtering, field/concept filtering, query expansion, and the matching-vs-ranking split. Cross-ref finance **R-SCALE §H**. |
| `academic-domain-coverage.md` | Judging scholarly quality: field taxonomy/concepts, preprint vs peer-reviewed, predatory-journal awareness, and what makes a high-quality, well-sourced academic answer. |

---

## Cross-repo prior art / cross-skill routing

- **research-agent** — owns the shared web-search answer pipeline that `AcademicView.onAsk` and the
  topic/paper carousels actually trigger (Tavily, citation `[n]` protocol). When the task is about
  the *answer*, not the *feed*, route there.
- **finance-markets** — the gold-standard sibling and the source of the patterns academic reuses:
  the `Provenance`/`commercialOk` licensing gate, `getOrRefresh` cache + cron warmer
  (`caching-and-rate-budgets.md`), and the R-SCALE ranking battery (`finance-at-scale-rscale.md`,
  §H matching-vs-ranking) referenced by `academic-search-and-ranking.md`.
- **lumina-frontend** — owns the carousel/card primitives in `discover-parts.tsx` and the app shell;
  this skill owns their academic composition.
- Project memory: `discover-tabs-build` (Academic + Health tabs shipped), `brand-is-lumina`
  (never write "Perplexity" in UI text), `discover-news-licensing` (the free-tier-display trap that
  CC0 OpenAlex sidesteps). Verify against live code before trusting any `file:line`.
