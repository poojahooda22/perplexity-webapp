# OpenAlex & the scholarly APIs — choosing and querying the source

> The scholarly data source for the Academic vertical: what OpenAlex is, why Lumina uses it (CC0,
> keyless, the polite pool), the EXACT fields and `filter`/`sort`/`per_page` params
> [`fetchAcademicDiscover`](../../../../backend/discover/academic.ts) sends, and a when-each matrix
> for the alternatives (Crossref, Semantic Scholar, arXiv). Read this when choosing/debugging the
> provider or extending the query. Siblings: **lumina-academic-vertical.md** = the full wiring map
> (route, cache, UI); **citations-and-dois.md** = DOI/OA-status/dedupe metadata; **academic-search-
> and-ranking.md** = how to ORDER results (relevance × citation impact × recency). `lumina-` ref =
> THIS codebase — cite the live file before you change it (line numbers drift).

---

## 1. Why OpenAlex is the spine

OpenAlex is the open replacement for Microsoft Academic Graph: a single free index of ~250M scholarly
**works**, plus **authors**, **sources** (journals/repositories), **institutions**, **topics**, and
**publishers** — all linked. Lumina reads only the `works` endpoint today.

The reason it sits at the center of the Academic feed is in the file header of
[`academic.ts`](../../../../backend/discover/academic.ts): **all OpenAlex data is CC0 (public
domain)**, so unlike news publishers Lumina may legally **display the title commercially with no
licence** — attribution is courtesy, not obligation. This is why academic is the cleanest of all the
Discover feeds and why `commercialOk:true` is *earned*, not optimistic:

```ts
const provenance: Provenance = {
  source: "OpenAlex",
  commercialOk: true, // OpenAlex data is CC0 — free to display, attribution courtesy only
  attribution: market === "in"
    ? "Latest India-affiliated research via OpenAlex (CC0) — cards link to the paper / DOI"
    : "Latest research via OpenAlex (CC0) — cards link to the paper / DOI",
};
```

Contrast the news-licensing trap that bites health/finance Discover (a free API tier is NOT a display
licence) — see **citations-and-dois.md** and project memory `discover-news-licensing`.

| Property | OpenAlex reality | Consequence for Lumina |
|---|---|---|
| Auth | **No API key.** Ever. | Nothing to vault; no `needsKey` path for academic. |
| Licence | **CC0** on the metadata | `commercialOk:true`; title is safe to render; link out for full text. |
| Polite pool | Send `mailto` (param + UA) → faster, more reliable lane | `openalexMailto()` + the `fetch` headers; optional but expected. |
| Rate limit | 100k calls/day, ≤10/sec (polite pool) | Trivial vs our cron-warmed, cached read pattern. |
| Coverage | Works, authors, sources, institutions, topics, publishers | We use `works` only; the rest are upgrade lanes. |
| Freshness | Indexed continuously; some records carry **future dates** (2050-…) | Must bound `to_publication_date` (see §4, Non-Negotiable #5). |

---

## 2. The polite pool — be a good citizen

OpenAlex has no key, so the courtesy mechanism is your email. Sending it moves you from the shared
"common pool" into the faster, more reliable **polite pool**. `academic.ts` sends it BOTH ways —
as the `mailto` query param and inside the `User-Agent` — gated on `OPENALEX_MAILTO`:

```ts
function openalexMailto(): string | null { return process.env.OPENALEX_MAILTO || null; }
// …
const mailto = openalexMailto();
if (mailto) params.set("mailto", mailto);
// …
headers: {
  Accept: "application/json",
  "User-Agent": mailto ? `perplexity-webapp (${mailto})` : "perplexity-webapp",
},
```

It's optional (the fetcher works without it) but **set `OPENALEX_MAILTO` in every real
environment** — the polite pool is the difference between a steady feed and intermittent throttling
under load.

---

## 3. The exact fields Lumina reads (the `OAWork` contract)

We deliberately read a **minimal slice** of each work — only what the `DiscoverArticle` card needs
(title + venue + outbound link + date + field). The typed shape in
[`academic.ts`](../../../../backend/discover/academic.ts) is the source of truth:

| `DiscoverArticle` field | OpenAlex source field | Fallback chain | Notes |
|---|---|---|---|
| `title` | `title` | → `display_name` → `""` | **JATS-stripped** (`<scp>`, `<i>` removed) then trimmed. |
| `url` | `doi` | → `primary_location.landing_page_url` → `id` | DOI-first: stable, resolvable. Skip card if all empty. |
| `source` (venue) | `primary_location.source.display_name` | → `"OpenAlex"` | The journal name. |
| `publishedAt` | `publication_date` ("YYYY-MM-DD") | `toIso()` → now | Normalized to ISO by `toIso` (shared.ts). |
| `category` (field) | `primary_topic.field.display_name` | → `primary_topic.display_name` → `"Research"` | Broad FIELD, not the narrow topic. |
| `id` | `id` (OpenAlex id) | → `url` | Used for dedupe key in `finalizeArticles`. |
| `image` | — | always `null` | Papers have no hero image → clean placeholder, like imageless finance India cards. |

### Two field choices worth understanding

**The link priority is a correctness rule, not a style choice.** Never string-guess a DOI; use the
value OpenAlex returns, then degrade:

```ts
const title = (w.title ?? w.display_name ?? "").replace(/<[^>]+>/g, "").trim();
const url = w.doi || w.primary_location?.landing_page_url || w.id || "";
if (!title || !url) continue; // no real link → drop the card, never fabricate one
```

**The topic hierarchy.** OpenAlex classifies every work as `domain > field > subfield > topic`
(narrowest). The card groups by the **broad FIELD** (e.g. "Medicine", "Computer Science",
"Environmental Science", "Social Sciences") so the UI can bucket papers into a small, legible set of
categories — not hundreds of granular topics:

```ts
category: w.primary_topic?.field?.display_name || w.primary_topic?.display_name || "Research",
```

### Fields we do NOT read yet (upgrade lanes)

| Field | What it unlocks | Where it'd be used |
|---|---|---|
| `cited_by_count` | Citation-impact ranking | **academic-search-and-ranking.md** (the Tier-2 ranker). |
| `abstract_inverted_index` | Show an abstract (CC0-safe to display) | A card expand / answer grounding. Reconstruct from the inverted index. |
| `authorships[].author.display_name` | Author list on the card | **citations-and-dois.md**. |
| `open_access.is_oa` / `oa_status` | OA vs paywall badge, OA-only filter | **citations-and-dois.md**, ranking filter. |
| `relevance_score` (only when `search=` is used) | Text-relevance ranking for query search | The search path (not the recency feed). |

---

## 4. The query Lumina sends — filters, sort, paging

`fetchAcademicDiscover` builds ONE request to `https://api.openalex.org/works`. All selection happens
**at the source via `filter=`** — never in the client (the client renders a page, not a corpus).

```ts
const today = new Date().toISOString().slice(0, 10);
const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10); // 21 days
const filters = [
  `from_publication_date:${since}`,
  `to_publication_date:${today}`,            // EXCLUDE future-dated junk (OpenAlex has 2050-… rows)
  "type:article",
  "has_doi:true",                            // every card gets a clean, stable outbound link
  "primary_location.source.type:journal",    // real peer-reviewed journals, not preprint repos
];
if (market === "in") filters.push("authorships.institutions.country_code:in");

const params = new URLSearchParams({
  filter: filters.join(","),
  sort: "publication_date:desc",             // newest first → a real "latest research" feed
  per_page: "40",
});
```

### What each filter buys you

| Filter | Effect | Why it matters |
|---|---|---|
| `from_publication_date:<since>` | Last ~21 days (`LOOKBACK_DAYS`) | A "latest research" feed, not the whole archive. |
| `to_publication_date:<today>` | Bound the upper end | **Footgun guard:** OpenAlex carries 2050-dated records; without this a date-desc sort fills with garbage. |
| `type:article` | Drop datasets, editorials, errata, book chapters | Keep actual research articles. |
| `has_doi:true` | Only works with a DOI | Guarantees a resolvable outbound link before the row crosses the wire. |
| `primary_location.source.type:journal` | Journals only, not preprint repos | This feed is the **peer-reviewed** lane; preprints would need a "preprint" label (see §6). |
| `authorships.institutions.country_code:in` | India-affiliated works only | The India facet — a filter, NOT a fork (same fetcher, separate cache key). |

### Params cheat-sheet (the ones you'll actually touch)

| Param | Lumina value | Notes |
|---|---|---|
| `filter` | comma-joined list above | Comma = AND. Same-key OR uses `\|` (pipe). |
| `sort` | `publication_date:desc` | For query search switch to `relevance_score:desc` (only meaningful with `search=`). |
| `per_page` | `40` | Max 200. We over-fetch then `finalizeArticles` caps at `MAX_ARTICLES` (18) after dedupe. |
| `search` | *(not used yet)* | Full-text search across title/abstract/fulltext; enables `relevance_score`. The search path's matching half. |
| `select` | *(not used yet)* | Comma list of fields to return — shrinks the payload. Worth adding: we read ~6 fields of a fat object. |
| `mailto` | from env | Polite pool (§2). |
| `cursor` | *(not used)* | Deep pagination beyond page 1 (`cursor=*` then follow `meta.next_cursor`). Use this, not `page=`, past ~10k results. |

> **`select` is the easy win.** We pull the full work object and use six fields. Adding
> `select=id,doi,title,display_name,publication_date,primary_location,primary_topic` cuts payload
> size with zero behavior change. Confirm field names against the live response before shipping.

### Response handling

The fetcher reads `data.results`, loops, strips JATS, builds the link, skips title/url-less rows, then
hands off to the shared finalizer:

```ts
if (!res.ok) throw new Error(`OpenAlex ${res.status}`); // throw → cache serves stale, never a 500
const data = (await res.json()) as { results?: OAWork[] };
// …push qualifying articles…
return { articles: finalizeArticles(articles), provenance };
```

`finalizeArticles` ([`shared.ts`](../../../../backend/discover/shared.ts)) dedupes by canonical URL +
lowercased title, caps at `MAX_ARTICLES` (18), and sorts image-bearing cards first (a no-op here since
papers are imageless). The throw-on-`!res.ok` is deliberate: it lets the cache layer
(`getOrRefresh`, owned by **finance-markets** `caching-and-rate-budgets.md`) serve a stale value
instead of 500ing a read it has served before. The 9s `AbortSignal.timeout(9000)` bounds a hung
upstream.

---

## 5. Alternatives — Crossref, Semantic Scholar, arXiv (when each)

OpenAlex is the right default for "latest peer-reviewed research, displayable, keyless." The others
are specialists. Pick by the job, not by habit.

| Source | Auth | Licence (metadata) | Best at | Weak at | Reach for it when |
|---|---|---|---|---|---|
| **OpenAlex** | none (mailto) | **CC0** | Unified index: works+authors+topics+OA status+citations; clean display rights | No fulltext; abstracts are inverted-index | **Default.** The feed, the field grouping, citation counts, OA status. |
| **Crossref** | none (mailto, "Plus" paid tier exists) | CC0 (most fields) | Authoritative **DOI registration** metadata, funder/grant data, references | No topic taxonomy; no OA discovery; noisier display names | Resolving/validating a DOI; funder or reference-list data; cross-checking publisher metadata. |
| **Semantic Scholar** | optional key (higher limits) | CC BY-NC for some fields — **check before commercial display** | **Citation graph** (influential citations, TLDR summaries, embeddings), CS/biomed depth | Stricter rate limits; licence is NOT CC0 — display caution | You need citation-context, "influential" citations, recommendations, or paper embeddings. |
| **arXiv** | none | arXiv API terms; per-paper licences vary | **Preprint freshness** (physics/CS/math/quant-bio); same-day postings | Preprints (not peer-reviewed); no citations; physics-skewed coverage | A "preprints / latest from arXiv" lane — but label it **"preprint"** explicitly. |

### Decision framework

```
Need scholarly data
|
+-- Display a "latest research" feed, commercially, no key? ----------------> OpenAlex (what we do)
+-- Just validate/resolve a DOI, or need funder/reference data? -----------> Crossref
+-- Need the citation GRAPH / TLDRs / embeddings / recommendations? -------> Semantic Scholar (mind licence)
+-- Want bleeding-edge PREPRINTS (CS/physics), freshness over peer-review? > arXiv (label "preprint")
+-- Need citation COUNT for ranking, displayable? ------------------------> OpenAlex cited_by_count (still CC0)
```

**Licence is the gate, not capability.** Semantic Scholar's TLDRs are tempting, but parts of its data
are CC BY-NC — clear it before rendering commercially. OpenAlex stays the spine precisely because CC0
removes that question. If you add a second source, give it its own `Provenance` with the correct
`commercialOk` — never inherit OpenAlex's `true`.

---

## 6. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| String-guessing a DOI URL (`https://doi.org/10.xxxx/…`). | Use `w.doi`, then `landing_page_url`, then `id`; `continue` if all absent. |
| Filtering/sorting the result set in React. | Push it into the OpenAlex `filter=`/`sort=`; cap + dedupe server-side via `finalizeArticles`. |
| Omitting `to_publication_date` on a date-desc feed. | Always bound `[since, today]` — OpenAlex has 2050-dated rows that flood the top. |
| Calling OpenAlex with no `mailto`. | Set `OPENALEX_MAILTO`; send it as param + UA for the polite pool. |
| Treating India as a separate fetcher/codepath. | One fetcher; add the `country_code:in` filter + a separate `discover:in:academic` cache key. |
| Rendering raw JATS titles (`<scp>DNA</scp>`). | `title.replace(/<[^>]+>/g, "")` before display (done in the fetcher; keep it). |
| Pulling preprints into the journal feed unmarked. | Keep `source.type:journal`; if you add arXiv, label it "preprint" and give it its own provenance. |
| Inheriting `commercialOk:true` for a non-OpenAlex source. | Re-evaluate per source — Semantic Scholar is NOT CC0; Crossref mostly is. |
| Fetching the full work object then using six fields. | Add `select=` to shrink the payload (verify field names live first). |
| `page=N` for deep pagination. | OpenAlex caps offset paging; use `cursor=*` + `meta.next_cursor`. (Not needed for our single-page feed.) |
| Hammering OpenAlex per keystroke / per request. | Debounce client search; serve the feed from cache + cron warmer (1800s TTL). |

---

## 7. Verify it's working

```bash
# Raw OpenAlex — the exact query the fetcher builds (swap in your mailto):
curl -s "https://api.openalex.org/works?filter=from_publication_date:2026-06-01,to_publication_date:2026-06-21,type:article,has_doi:true,primary_location.source.type:journal&sort=publication_date:desc&per_page=5&mailto=you@example.com" | jq '.results[] | {title, doi, venue: .primary_location.source.display_name, date: .publication_date, field: .primary_topic.field.display_name}'

# India facet — add the country_code filter:
curl -s "https://api.openalex.org/works?filter=type:article,has_doi:true,authorships.institutions.country_code:in&per_page=3" | jq '.meta.count'

# Through Lumina (cached + finalized):
curl -s "http://localhost:3000/discover/academic?market=us" | jq '.articles[0]'
curl -s "http://localhost:3000/discover/academic?market=in" | jq '.provenance'
```

Expect: real recent papers, every `url` a DOI/landing page (never blank), titles tag-free, `field`
populated, `provenance.source == "OpenAlex"` with `commercialOk:true`. If you edited `academic.ts`,
do a **full dev-server restart** (Bun `--hot` misses new/changed backend files in some cases) and
confirm relative imports keep their explicit `.js` (`./shared.js`) or Vercel's ESM resolver fails the
build — see **lumina-academic-vertical.md**.
