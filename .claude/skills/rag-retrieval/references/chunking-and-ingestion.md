# Chunking & Ingestion — turning a document corpus into retrievable, embedded chunks

> The **offline half** of knowledge-RAG: how to split finance/health/academic documents into
> chunks, what overlap + metadata to attach, and the chunk → embed → store pipeline that fills a
> vector table. Generic reusable knowledge — Lumina's `index.ts` is cited only to show the embed
> call + `::vector` write you'd reuse. Read this when you're designing the corpus side of a RAG
> feature. Adjacent refs: **`semantic-cache-vs-knowledge-rag.md`** (why this is different from the
> answer-cache Lumina ships today), **`embeddings-fundamentals.md`** (the model/dims this pipeline
> embeds with), **`pgvector-and-postgres.md`** (the column/index it writes into), and
> **`retrieval-and-reranking.md`** (the online half — how these chunks get fetched at query time).

The iron law of RAG: **retrieval quality is capped by chunk quality.** A perfect reranker cannot
rescue chunks that split a table from its header, embed a 9-page PDF as one blob, or strip the
metadata you need to filter and cite. Ingestion is where most RAG systems silently fail — and it
fails *offline*, so you only discover it as bad answers months later. Get chunking right first.

---

## 1. The pipeline at a glance

```
 source docs                parse            chunk              enrich            embed                store
 (PDF/HTML/MD/  ──────►  extract clean  ──► split into      ──► attach        ──► batch into       ──► INSERT rows
  DOCX/transcripts)       text + struct     overlapping         metadata          embedding vecs       (chunk text,
                          (headings,        passages           (source, title,    (text-embed-          metadata jsonb,
                           tables, page#)                        section, page,     3-small, 1536d)       embedding vector)
                                                                 url, date, hash)
                                                                                        ▲
                                                                          same model + dims as
                                                                          query-time embedding —
                                                                          NON-NEGOTIABLE (§7)
```

Five stages, each a distinct failure surface:

| Stage | Job | The classic mistake |
|-------|-----|---------------------|
| **Parse** | Get clean text + structure out of the source format. | Feeding raw HTML/PDF bytes (nav bars, footers, ligatures, `\f` page breaks) straight into the chunker. |
| **Chunk** | Split into passages an embedding can represent and an LLM can read. | One size for all doc types; splitting mid-sentence/mid-table. |
| **Enrich** | Attach metadata for filtering, citation, dedup, invalidation. | Storing bare text with no source/section/date — uncitable, unfilterable, un-updatable. |
| **Embed** | Turn each chunk into a vector with the *query-time* model. | Mixing models/dims; one-at-a-time API calls; embedding the raw chunk without its heading context. |
| **Store** | Persist text + metadata + vector idempotently. | Re-ingesting creates duplicates; no content hash, so you can't tell new from changed. |

---

## 2. Chunking strategies — pick by document shape

There is no universal chunk size. Choose the strategy from the **structure of the source**, then
tune size against retrieval evals (§8), not by guessing.

| Strategy | How it splits | Best for | Cost / risk |
|----------|---------------|----------|-------------|
| **Fixed-size** (token/char window) | Every N tokens, hard cut, with K overlap. | Uniform prose; a fast baseline; transcripts with no structure. | Cuts mid-sentence/mid-fact; cheapest to build, lowest quality ceiling. |
| **Sentence / paragraph** | Split on sentence or paragraph boundaries, then pack up to a token budget. | Articles, news, health explainers, most prose. | Needs a real sentence splitter (not `.split(".")` — "Dr. Smith" / "3.5%" break it). |
| **Structure-aware** (heading/Markdown/HTML) | Split on `#`/`##`, `<h2>`, list/table boundaries; one section ≈ one chunk (sub-split if too big). | Docs with headings: academic papers, SEC filings, clinical guidelines, API docs. | Requires a parser that preserves structure; sections vary wildly in size. |
| **Semantic** (embedding-similarity boundaries) | Embed sentences, cut where adjacent-sentence similarity drops below a threshold (topic shift). | Long, flowing docs where topics drift without headings. | Expensive (extra embeddings at ingest), more code, marginal gains over good structure-aware. |
| **Recursive** (hierarchical separator list) | Try to split on `\n\n` → `\n` → `. ` → ` ` in order, keeping each piece under the budget. | A robust general default across mixed formats. | The pragmatic workhorse — start here when in doubt. |

**Default recommendation for a Lumina-style corpus:** *structure-aware first, recursive as the
fallback splitter inside an over-large section.* Respect the document's own headings (they encode
the author's topical boundaries for free), and only fall back to recursive/sentence splitting when
a single section blows the token budget.

### Decision framework

```
What is the source?
|
+-- Structured (headings/markdown/HTML/filing) ──► STRUCTURE-AWARE; recursive-split oversize sections
+-- Flowing prose, no headings, long ───────────► SEMANTIC if budget allows, else SENTENCE-pack
+-- Short uniform records (FAQ, product blurbs) ─► one chunk per record (don't over-split)
+-- Transcript / chat / no structure ───────────► SENTENCE-pack or FIXED with overlap
+-- Tables / code / numeric ────────────────────► keep the unit whole; never split a row/function
```

---

## 3. Chunk size & overlap — the two dials

| Dial | Typical range | Smaller → | Larger → |
|------|---------------|-----------|----------|
| **Chunk size** | 200–800 tokens (≈ 1–3 paragraphs) | More precise retrieval, less context per hit, more rows/embeddings | More context per hit, but dilutes the embedding (one vector averages many topics → weaker match) |
| **Overlap** | 10–20% of chunk size (e.g. 50–100 tokens) | Cheaper, fewer rows; risk: a fact split across a boundary is in neither chunk's "core" | Preserves cross-boundary facts; risk: duplicate hits + wasted storage/embeddings |

**Why overlap exists:** a hard cut can land in the middle of "...the maximum dose is" / "10 mg per
day." Neither chunk fully states the fact, so neither embeds for "max dose." A sliding overlap
makes the boundary fact appear *whole* in at least one chunk. Overlap is insurance against the
splitter, not a free quality boost — pay only ~15%.

**The embedding-dilution trap:** an embedding is a *single* vector for the whole chunk. A 2000-token
chunk covering five subtopics produces a vector that is the average of all five — it matches none of
them strongly. This is why "just make chunks huge so they always have context" backfires: precision
craters. Keep chunks topically tight; use overlap + retrieved-neighbor expansion (§6) for context.

---

## 4. Metadata — the field that makes a chunk usable

Bare chunk text is nearly worthless. Every chunk row must carry metadata so you can **filter**
(narrow before vector search), **cite** (Lumina's `[n]`/`<SOURCES>` protocol needs a source + URL),
**dedup/invalidate** (re-ingest without duplicating), and **rank** (recency, authority).

| Field | Purpose | Example |
|-------|---------|---------|
| `source` / `vertical` | Pre-filter the vector search to the right corpus. | `"academic"`, `"health"`, `"finance"` |
| `doc_id` | Group chunks of one document; delete/re-ingest as a unit. | `"openalex:W2741809807"` |
| `title` | Citation label + a context line prepended to the embedded text. | `"2024 Dietary Guidelines"` |
| `section` / `heading` | Citation precision + context-prefix. | `"§3.2 Sodium Intake"` |
| `url` / `locator` | Link-out citation (legal requirement for news/web). | `https://…`, `"p. 14"` |
| `published_at` / `ingested_at` | Recency ranking + TTL/freshness. | ISO timestamps |
| `commercialOk` | Honor the same licensing gate finance uses (don't surface non-displayable text). | `true`/`false` |
| `content_hash` | Idempotent ingest: skip unchanged, replace changed (§5). | sha256 of chunk text |
| `token_count` | Budget the context window at assembly time. | `412` |

**Two metadata power-moves:**

1. **Pre-filtering beats post-filtering.** Filtering by `vertical = 'health'` in the SQL `WHERE`
   *before* the `<=>` scan shrinks the candidate set and keeps a finance chunk from ever competing
   with a health query. (In pgvector this rides the same `$queryRaw` shape Lumina already uses — see
   `findCachedAnswer`'s `WHERE model = ${model}` for the exact pattern, applied to a metadata column
   instead.) See `pgvector-and-postgres.md`.
2. **Embed the context, not just the body.** Prepend `title` + `section` to the chunk text *before*
   embedding (a.k.a. contextual chunking): `"2024 Dietary Guidelines — §3.2 Sodium Intake\n\n<body>"`.
   A bare body chunk that says "the limit is 2300 mg" embeds with no idea what limit; the prefixed
   version embeds near "sodium intake guideline." Store the raw body separately for display.

---

## 5. Idempotent ingest — the part everyone skips

Re-running the pipeline on the same corpus must not create duplicates, and a *changed* document must
*replace* its old chunks. The mechanism is a content hash + a delete-then-insert per `doc_id`:

```
for each document:
  doc_hash = hash(normalized full text)
  if doc_hash == stored doc_hash:  skip            # unchanged → no re-embed (saves $$)
  else:
    DELETE FROM chunk WHERE doc_id = :doc_id        # drop stale chunks atomically
    chunks = chunk(doc); embed(chunks)              # re-chunk + re-embed only changed docs
    INSERT … (one row per chunk, with content_hash) # idempotent: a retry inserts the same rows once
```

This makes ingest **resumable and cheap**: re-embedding is the expensive step, so the hash gate
ensures you only pay it for docs that actually changed. It also gives you **invalidation for free** —
delete a document's chunks by `doc_id` when it's retracted/superseded.

---

## 6. Embed & store — reuse Lumina's exact mechanics

The embed call and the vector write are *already in this repo* — for the answer-cache, but the
machinery is identical for a chunk table. Reuse it verbatim:

```ts
// Embed — same model/dims as the query side (see embedQuery in index.ts).
import { embed, embedMany } from "ai";
const { embedding } = await embed({ model: "openai/text-embedding-3-small", value: chunkText });
// Batch at ingest with embedMany (the cache uses single embed; ingestion should batch):
const { embeddings } = await embedMany({ model: "openai/text-embedding-3-small", values: chunkTexts });

// Store — raw SQL with a ::vector literal (the vector type is NOT in the typed Prisma client).
// Mirrors cacheAnswer's INSERT in index.ts.
const vec = `[${embedding.join(",")}]`;          // pgvector literal: [n1,n2,…]
await prisma.$executeRaw`
  INSERT INTO knowledge_chunk (id, doc_id, vertical, title, section, url, content_hash, chunk_text, metadata, embedding, created_at)
  VALUES (${crypto.randomUUID()}, ${docId}, ${vertical}, ${title}, ${section}, ${url}, ${hash},
          ${chunkText}, ${JSON.stringify(meta)}::jsonb, ${vec}::vector, NOW())
`;
```

Cite: [`embedQuery`](../../../../backend/index.ts) (the `embed({ model: "openai/text-embedding-3-small" })`
call) and [`cacheAnswer`](../../../../backend/index.ts) (the `${vec}::vector` `$executeRaw` INSERT) in
[`backend/index.ts`](../../../../backend/index.ts) show the exact embed + vector-write pattern a chunk
ingester reuses — the only differences are `embedMany` (batch) and a `knowledge_chunk` table with
metadata columns instead of `cached_query`.

**Batching matters at ingest.** The answer-cache embeds one query at a time (correct — it's one
request). Ingestion embeds thousands of chunks: use `embedMany` to send batches (respect the
provider's max-inputs-per-call, often 100–2048) — it cuts round-trips and cost dramatically. Embed
in batches, store in transactions, and make the whole run resumable via the §5 hash gate.

**Neighbor expansion (store-time decision):** keep chunks small for precise *matching*, but store
`prev_chunk_id`/`next_chunk_id` (or a `(doc_id, ordinal)`) so that at retrieval you can fetch a hit's
neighbors and feed the LLM a fuller window without diluting the embedding. Decide this at ingest —
you can't reconstruct order later if you didn't store it.

---

## 7. The one rule you cannot break: ingest model == query model

The chunk vectors and the query vector must come from the **same embedding model at the same
dimensionality**, or cosine distance is meaningless — you'd be comparing coordinates in two
different spaces.

- Lumina is locked to `openai/text-embedding-3-small` → **1536 dims** → a `vector(1536)` column.
  Your chunk table must use the same model and column type.
- Changing the embedding model (e.g. to a 3072-dim model) means a **new column/table + a full
  re-embed of the entire corpus** — never mix dims in one column, never query model-B vectors
  against a model-A table.
- This couples ingestion to retrieval permanently. Pin the model id in one shared constant so the
  ingester and the query path can never drift apart. See `embeddings-fundamentals.md` for model
  choice and `pgvector-and-postgres.md` for the column/index.

---

## 8. Quality pitfalls & how to catch them

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| **Splitting mid-fact** | Retrieval finds the chunk *near* the answer but not the answer. | Sentence/structure-aware split + 15% overlap; never hard-cut prose. |
| **Embedding dilution** (chunks too big) | Top hit is "relevant-ish" but never precise. | Smaller, topically-tight chunks; expand context via neighbors at query time. |
| **Over-splitting** (chunks too small) | Hits are fragments with no standalone meaning. | Pack to a token floor; one record = one chunk for short uniform data. |
| **No context prefix** | "the limit is 2300 mg" never matches "sodium guideline." | Prepend title+section before embedding (contextual chunking, §4). |
| **Dirty parse** | Nav bars, page-number lines, footers retrieved as "knowledge." | Clean in the parse stage: strip boilerplate, normalize whitespace, drop `\f`. |
| **Tables/code shredded** | Numbers retrieved without their column headers; broken code. | Keep tables/functions whole; serialize a table to labeled key:value text. |
| **Naive sentence split** | "Dr. Smith earned 3.5% in Q1." → 3 garbage chunks. | Use a real sentence segmenter, not `.split(".")`. |
| **Non-idempotent ingest** | Duplicate chunks after every run; double-counted hits. | content_hash + delete-by-`doc_id`-then-insert (§5). |
| **Missing source metadata** | Can retrieve but can't cite → can't ship (citations are non-negotiable). | Mandate source/title/url/date on every row; reject chunks without them. |
| **Model/dim mismatch** | Distances look random; recall near zero. | Lock ingest model == query model == column dims (§7). |

### Anti-patterns table

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| One fixed chunk size for PDFs, transcripts, and FAQs alike. | Pick the strategy from the doc's structure (§2 decision tree); tune size per source type. |
| Making chunks huge "so they always have enough context." | Keep them topically tight; add context via overlap + neighbor expansion, not by ballooning the chunk. |
| Embedding the raw chunk body with no heading/title. | Prepend title+section before embedding; store the body separately for display. |
| `text.split(".")` as a sentence splitter. | A real segmenter; abbreviations/decimals/URLs break naive splits. |
| Re-running ingest and appending again. | Hash-gate + delete-by-`doc_id` so re-ingest is idempotent and changed docs replace cleanly. |
| Embedding chunks one at a time in a loop. | `embedMany` in batches under the provider's input cap; far fewer round-trips and lower cost. |
| Storing only the text, no metadata. | Mandatory source/title/section/url/date/hash — needed to filter, cite, dedup, invalidate. |
| Ingesting with model A, querying with model B (or different dims). | One pinned model id + matching column dims, end to end. |
| Post-filtering vertical/source after the vector scan. | Pre-filter in the SQL `WHERE` (like `findCachedAnswer`'s `WHERE model`) before `<=>`. |
| Ingesting provider text that `commercialOk:false`. | Carry the licensing flag per chunk; never surface non-displayable text (mirror finance's gate). |

---

## 9. Output contract — an ingestion change is "done" when

1. **Strategy justified:** the chunker matches the source's structure; size/overlap were tuned
   against a retrieval eval (recall@k on a held-out question set), not guessed — see
   `retrieval-and-reranking.md` for the eval.
2. **Metadata complete:** every chunk carries source/vertical, doc_id, title, section, url/locator,
   dates, content_hash, token_count, and the licensing flag — enough to filter AND cite.
3. **Contextual embedding:** chunks are embedded with their title/section prefix; the body is stored
   separately for display.
4. **Model locked:** ingest uses the *same* model + dims as the query path (`text-embedding-3-small`,
   1536, `vector(1536)`); the id lives in one shared constant.
5. **Idempotent + resumable:** re-running ingest skips unchanged docs (hash gate), replaces changed
   ones by `doc_id`, and never duplicates; `embedMany` batches the embed step.
6. **Parse is clean:** boilerplate stripped, whitespace normalized, tables/code kept whole.
7. **Citable end-to-end:** a retrieved chunk can render in the `[n]`/`<SOURCES>` format
   (research-agent owns that wire format) with a real source + URL.
