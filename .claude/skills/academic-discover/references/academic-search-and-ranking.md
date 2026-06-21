# Academic Search & Ranking — matching, then relevance × impact × recency

> The reusable mechanics of scholarly search: how to **filter to real candidates** (matching) and
> then **order them well** (ranking) by relevance, citation impact, and recency — plus open-access
> filtering, field/concept filtering, and query expansion. This is a GENERIC-domain ref (the
> knowledge transfers to any scholarly source); it cites Lumina's
> [`backend/discover/academic.ts`](../../../../backend/discover/academic.ts) only to show the
> patterns in our code. Sibling refs cover the adjacent ground: `openalex-and-scholarly-apis.md`
> (which API, exact fields, filter/sort params), `citations-and-dois.md` (DOI/metadata, dedupe,
> OA-status detection), `academic-domain-coverage.md` (preprint vs peer-review, predatory journals,
> answer quality). For the cross-domain ranking battery this all maps onto, read finance
> **`finance-at-scale-rscale.md` §H (matching vs ranking)** — academic search is the same problem
> as e-commerce search wearing a lab coat.

---

## 1. The one idea: matching ≠ ranking

Every real search is **two systems glued together** (R-SCALE §H):

| Half | Question | Failure if you skip it |
|------|----------|------------------------|
| **Matching** | *Which works qualify at all?* (set membership) | Junk, future-dated, off-topic, paywalled-only, DOI-less rows enter the result set. |
| **Ranking** | *In what order do the qualifiers appear?* (sort within the set) | The most-cited, most-relevant landmark paper sits at position 37; the user trusts what's on top, so the answer is wrong even though the corpus was right. |

Shipping only matching — `filter=…&sort=publication_date:desc` and calling it "search" — is a
**Tier-1 ranker**. It is fine for a "latest research" feed (recency *is* the intended order there)
and wrong for a query search ("transformer attention mechanisms"), where the user wants the
*important* papers, not merely the *newest*.

**Lumina today (the honest baseline):** the academic feed is matching-heavy + recency-only ranking.
[`fetchAcademicDiscover`](../../../../backend/discover/academic.ts) does all real work in the
OpenAlex `filter` (matching) then `sort: "publication_date:desc"` (rank = recency), and
`finalizeArticles` nudges image-bearing cards up. That is a deliberate Tier-1 ranker for a *feed*.
The moment you add a query box that searches papers, you owe the ranking half below.

---

## 2. Matching — filter to real scholarship AT THE SOURCE

Filter on the server, in the API query, never in React. The client renders a page, not a corpus.
The matching predicate is a conjunction of cheap, indexed facets. Lumina's set, as a template:

| Facet | OpenAlex filter (in `academic.ts`) | Why it's a matching gate |
|-------|-----------------------------------|--------------------------|
| Date window | `from_publication_date:{since}` + `to_publication_date:{today}` | Bounds the corpus; the `to_` bound is **non-optional** — OpenAlex carries `2050-…` rows; without it a recency sort fills with garbage. |
| Work type | `type:article` | Drops datasets, errata, editorials, peer-review records. |
| Resolvable link | `has_doi:true` | Guarantees every survivor has a stable outbound target (DOI). No DOI → can't cite cleanly → not a candidate. |
| Venue type | `primary_location.source.type:journal` | Keeps peer-reviewed journals; excludes preprint repositories from the "research" feed. |
| Geography (facet) | `authorships.institutions.country_code:in` (only when `market === "in"`) | India is a **facet on the same matcher**, not a separate pipeline. |

```ts
// academic.ts — matching lives entirely in the query string:
const filters = [
  `from_publication_date:${since}`,
  `to_publication_date:${today}`,        // EXCLUDE 2050-dated junk
  "type:article",
  "has_doi:true",
  "primary_location.source.type:journal",
];
if (market === "in") filters.push("authorships.institutions.country_code:in");
```

**Rules that generalize to any scholarly source:**
- Every filter must hit an **indexed field** on the provider (date, type, concept id, OA status,
  country). An unindexed filter = a full scan = a slow/limited endpoint.
- Prefer **structured ids over free text** for concept/field filters (an OpenAlex concept/topic id
  or a Crossref subject code beats `?q=machine+learning` for set membership).
- Set membership is **boolean and cheap**; do it before you spend on ranking signals.

---

## 3. Ranking — the three signals and how to combine them

Once you have the candidate set, order it. Scholarly ranking has three primary signals; production
search blends them, weighted by **query intent**.

| Signal | Source field | What it rewards | When it dominates |
|--------|-------------|-----------------|-------------------|
| **Relevance** | text match of query vs title/abstract/concepts | "is this *about* what I asked" | Keyword/topic searches |
| **Citation impact** | `cited_by_count` (raw) → normalized | influence / landmark status | "foundational papers on X", literature reviews |
| **Recency** | `publication_date` | freshness | "latest research", news-style feeds |

### 3a. Relevance scoring (matching's quantitative twin)
**Where the match occurs matters** — this is the heart of text relevance:
- A hit in the **title** outranks a hit in the **abstract** outranks a hit in references.
- An **exact phrase / whole-word** match outranks a partial/stemmed one.
- **Rarer query terms score higher** than common ones — search engines formalize this as
  **TF-IDF / BM25**: term frequency in the doc, damped, times inverse document frequency across the
  corpus. You rarely implement BM25 yourself; you get it from the provider's relevance sort
  (OpenAlex `sort=relevance_score:desc` when a `search=` is present) or a real engine (§6).

### 3b. Citation impact — normalize before you trust it
Raw `cited_by_count` is a **biased** signal; never sort by it naked:
- **Age bias:** a 2008 paper had 16 years to accrue citations; a 2024 paper had months. Comparing
  raw counts buries recent work.
- **Field bias:** biomedicine cites far more than mathematics. Cross-field raw counts are
  apples-to-oranges.

Normalize: divide by **years since publication** (citations/year) or by a **field-and-year
baseline** (the field's mean citations for that year — OpenAlex exposes
`cited_by_percentile_year`, a ready-made normalized rank). Citations/year is the cheap, good-enough
default.

### 3c. Recency — decay, don't cliff
For "latest" intent, a hard date window (`from_/to_publication_date`) + date-desc sort is fine.
When recency is one signal *among* others, use a **decay function** (e.g. `exp(-age_days / τ)`, τ ≈
365) so a slightly older but far more relevant/cited paper can still win, instead of a hard cliff
that discards everything before a cutoff.

### 3d. The blended score (a concrete recipe)
Normalize each signal to 0–1, then weight by intent. Compute on the **already-matched** set:

```ts
// Pseudocode — rank the candidate works the matcher returned.
// (Lumina does NOT do this yet; this is the Tier-2 upgrade for a query search.)
function score(work, query, weights) {
  const rel    = relevanceScore(work, query);              // provider relevance_score, 0..1
  const impact = clamp01(work.cited_by_count / Math.max(1, yearsSince(work)) / IMPACT_NORM);
  const recent = Math.exp(-ageDays(work) / 365);           // 0..1 decay
  const oa     = work.open_access?.is_oa ? 1 : 0;           // tie-breaker, small weight
  return weights.rel*rel + weights.impact*impact + weights.recent*recent + weights.oa*oa;
}
```

| Query intent | rel | impact | recent | oa |
|--------------|-----|--------|--------|----|
| "latest research on X" (the **feed** today) | 0.2 | 0.1 | **0.7** | tie-break |
| "key/foundational papers on X" | 0.4 | **0.5** | 0.1 | tie-break |
| "what does the evidence say about X" (answer-grounding) | **0.5** | 0.3 | 0.2 | +OA preferred |

There is no universal weight vector — **name your ranking function per surface** and state which
R-SCALE tier it survives. That sentence ("this surface ranks by 0.5·rel + 0.3·impact + 0.2·recency,
Tier-2, breaks at >X works because it ranks in-memory") is the deliverable.

---

## 4. Decision framework — what kind of search is this?

```
Academic search request arrives
|
+-- Is there a user QUERY string, or is this a passive feed?
|     |
|     +-- Passive feed ("latest research", a topic carousel)
|     |     → matching = date window + type + DOI + journal (+country facet)
|     |     → ranking  = recency (date desc). This is the Lumina feed today. Tier-1, correct here.
|     |
|     +-- User query ("transformer attention", "CRISPR off-target")
|           → matching = the facets ABOVE + a text/concept match (search= or concept filter)
|           → ranking  = blended score (§3d). Recency-only here is a BUG. Owe R-SCALE §H.
|
+-- What is the user's INTENT? (sets the weights)
|     latest → recency-heavy | foundational → impact-heavy | evidence → relevance+OA-heavy
|
+-- How big is the corpus / how live is the surface?
      ≤ a few hundred candidates, in-process → client/edge re-rank is fine (Tier-1/2)
      large corpus, faceted, typo-tolerant     → push to a real search engine (§6, Tier-3)
```

---

## 5. Open-access filtering & field/concept filtering

### Open access (OA)
OA is **both** a matching filter and a ranking tie-breaker.
- **As a matcher:** when the user wants *readable* results, filter to OA at the source
  (OpenAlex `is_oa:true`, or `oa_status:gold|green|hybrid|diamond`). Don't filter OA in the client —
  you'd be discarding rows you already paid to fetch.
- **As a ranker signal:** even when paywalled work is allowed, prefer OA on ties so the top results
  are actually openable (the `oa` term in §3d).
- **Always mark OA vs paywalled** in the card so the user knows before clicking. Detecting OA status
  + the best free URL (`best_oa_location`) is covered in `citations-and-dois.md`.
- Lumina's feed today filters by DOI + journal but **not** by OA status — every card is CC0-titled
  and DOI-linked, but the destination may be paywalled. Adding `is_oa` is a one-line matcher upgrade
  when "show me readable papers" becomes a requirement.

### Field / concept filtering
Scholarly corpora are organized by a **concept taxonomy**, not free-text categories. OpenAlex uses a
4-level hierarchy: **domain > field > subfield > topic**.

- **Filter** by concept/field id, not by keyword, for precision
  (`primary_topic.field.id:…` / `concepts.id:…`).
- **Group/label** cards by the broad **field** so the UI can present a concept tree, which is how
  people actually navigate a million-item corpus (R-SCALE §A.5 — nobody "browses the list").
  `academic.ts` already reads the field for grouping:

```ts
// academic.ts — group by broad FIELD (Medicine / Computer Science / …):
category: w.primary_topic?.field?.display_name || w.primary_topic?.display_name || "Research",
```

- A concept filter is a far stronger matcher than a title keyword: it uses the provider's own
  classifier (which read the abstract + references), so "papers in *Environmental Science*" is
  precise where `q=environment` is noisy.

---

## 6. Query expansion & typo tolerance — closing the recall gap

A literal substring match misses what the user *meant*. The recall ladder:

| Technique | Catches | Tier / where |
|-----------|---------|--------------|
| Exact / prefix substring | "transform" → "transformer" | Tier-1, in-memory |
| **Synonym / acronym expansion** | "ML" → "machine learning"; "MI" → "myocardial infarction" | curated map or a thesaurus (MeSH for biomed) |
| **Stemming / lemmatization** | "ranking" ↔ "rank" ↔ "ranked" | engine-side analyzer |
| **Typo tolerance (fuzzy)** | "samsng" → "Samsung"; "covd" → "covid" | Tier-3 engine (edit-distance index) |
| **Concept expansion** | query → the provider's matched concept ids, then filter by id | OpenAlex `search=` already does light concept matching |
| **Vector / semantic** | "heart attack" ↔ "myocardial infarction" with zero shared tokens | embeddings (pgvector) — overkill for most discover surfaces |

**Practical rule:** expand the query *before* matching (broaden recall), then let ranking restore
precision (§3). Expansion without good ranking just floods the user with loosely-related work.

**Where search actually runs (the three tiers), mapped to scholarly sources:**
- **Tier-1** — client-side fuzzy library (Fuse.js / MiniSearch) over the in-memory result set. Fine
  for re-ranking the ~40 works a feed already holds.
- **Tier-2** — the **provider's own index**: OpenAlex `search=`, Crossref `query=`,
  Semantic Scholar relevance. You inherit their BM25 + concept matching for free. **This is the
  right next step for Lumina** — add `search=` to the existing fetcher; matching + relevance ranking
  come bundled, no infra.
- **Tier-3** — your **own** search engine (Typesense / Meilisearch / Elasticsearch) over an ingested
  corpus, for typo tolerance + custom ranking + autocomplete. Only when you outgrow the providers'
  query semantics or need offline/blended ranking across sources.

**Debounce the input** (~250 ms after typing stops) so you don't fire a request per keystroke, and
serve feeds from cache + cron warmer rather than hitting the API live per request — both are
R-SCALE §B/§C reflexes, and both protect the OpenAlex polite pool.

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Calling `sort=publication_date:desc` "search" for a user query. | That's matching + recency only. Add a relevance/impact-blended rank for query intent (§3d); reserve recency-only for the *feed*. |
| Sorting by raw `cited_by_count`. | Normalize by age (citations/year) or field-year baseline (`cited_by_percentile_year`); raw counts bury recent work and over-reward old/big-field papers. |
| Filtering or re-sorting the full corpus in React. | Filter + sort at the provider's indexed query; fetch one page. Client may re-rank only the page it holds. |
| Hard date cliff when recency is just *one* signal. | Decay (`exp(-age/τ)`) so a relevant older paper can still surface. |
| Free-text category filter (`q=environment`). | Filter by the concept/field **id** from the provider's taxonomy — precise, classifier-backed. |
| Filtering OA in the client after fetching. | `is_oa:true` at the source when you want readable results; otherwise keep OA as a ranking tie-breaker + mark each card. |
| Forgetting `to_publication_date`. | Always bound `[since, today]` — OpenAlex's future-dated rows poison any recency sort. |
| Firing a search request per keystroke. | Debounce ~250 ms; serve feeds from cache + cron warmer; send the OpenAlex `mailto` for the polite pool. |
| Letting the model write paper titles/DOIs to "fill" thin results. | Never fabricate a citation. Thin results → broaden the matcher (wider window, OA off, synonym expansion), not the imagination. |
| Standing up Elasticsearch for a 40-card carousel. | Tier-2 (provider `search=`) first; only reach for an owned engine at real corpus scale + typo/autocomplete needs. |

---

## 8. Done = you can say this in one breath

For any academic search/sort surface, "done" means you can state:
1. **The matching predicate** — which indexed facets define the candidate set (date, type, DOI,
   journal, concept, OA, country), all at the source.
2. **The ranking function** — the weighted blend of relevance × citation impact (normalized!) ×
   recency, with weights chosen for the surface's query intent — or, for a feed, "recency-only, by
   design."
3. **Which R-SCALE tier it survives and what breaks next** (e.g. "Tier-2: provider `search=` ranking,
   in-memory re-rank of one page; breaks at multi-source blended ranking → needs an owned engine").
4. **OA handling** — filtered or tie-broken, and marked on the card.
5. **Recall hygiene** — debounced input, cached/warmed feed, query expansion strategy named.

If any of those is "I don't know," you've shipped matching and called it search.
