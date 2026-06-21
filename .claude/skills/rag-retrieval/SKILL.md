---
name: rag-retrieval
description: >
  Build Lumina's retrieval + embeddings layer: the pgvector semantic-answer cache (embed the
  query → cosine `<=>` lookup → replay a clean past answer), how embeddings work
  (openai/text-embedding-3-small via the AI Gateway, dimensions, cosine vs euclidean vs dot),
  the cosine retrieval + DISTANCE_THRESHOLD tuning, and the crucial difference between
  caching whole ANSWERS (what Lumina has today) and retrieving knowledge CHUNKS to ground a
  fresh generation (true RAG). Covers chunking/ingestion, hybrid search + reranking, cache
  freshness/TTL/invalidation, and a concrete plan to evolve the answer-cache into a
  knowledge RAG that grounds generation with citations. Use whenever the task touches
  embeddings, pgvector, the semantic cache, vector similarity, chunking, reranking, or a
  knowledge base.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/index.ts'
    - 'backend/prisma/schema.prisma'
    - 'backend/db.ts'
  promptSignals:
    phrases:
      - 'embedding'
      - 'embeddings'
      - 'pgvector'
      - 'semantic cache'
      - 'rag'
      - 'retrieval'
      - 'cosine'
      - 'rerank'
      - 'reranking'
      - 'chunk'
      - 'chunking'
      - 'vector'
      - 'vector search'
      - 'knowledge base'
      - 'knowledge rag'
      - 'similarity search'
      - 'DISTANCE_THRESHOLD'
      - 'text-embedding-3-small'
    minScore: 3
---

# rag-retrieval — Lumina's Vector & Retrieval Layer

> Everything vector in Lumina: the **pgvector semantic-answer cache** that lives in
> [`backend/index.ts`](../../../backend/index.ts) (embed the query → cosine `<=>` lookup →
> replay a clean past answer), the embeddings behind it, and the design for evolving that cache
> into a real knowledge-RAG that grounds generation. This skill is the map from any
> vector/retrieval task to the exact reference + the exact lines in `index.ts`.

The one mental model to keep straight: today Lumina caches **whole answers** keyed by query
embedding (an optimization). True **knowledge-RAG** retrieves **chunks** to ground a *fresh*
generation (a capability). Different goals, different failure modes — this skill owns both.

---

## Domain Identity

**This skill OWNS:**
- The **semantic-answer cache** — `embedQuery` → `findCachedAnswer` (cosine `<=>` with
  `DISTANCE_THRESHOLD`, model-keyed, TTL'd) → replay; `cacheAnswer` on a clean finish; the
  `42P01`-cooldown self-heal; fail-open everywhere. All in
  [`backend/index.ts`](../../../backend/index.ts) (the "Vector / semantic-cache layer" block).
- The `CachedQuery` model + pgvector mechanics — `Unsupported("vector(1536)")`, the `<=>`
  operator, `$queryRaw` with a `::vector` literal — in
  [`backend/prisma/schema.prisma`](../../../backend/prisma/schema.prisma).
- **Embeddings**: `openai/text-embedding-3-small` via the Vercel AI Gateway (`embed` from `ai`),
  dimensions (1536), cosine/euclidean/dot, normalization, batching, cost, model choice.
- A concrete **knowledge-RAG design** for Lumina (corpus → chunk → embed → store → a retrieval
  TOOL the agent calls at inference → cite), reusing pgvector + the AI SDK.
- Retrieval mechanics that apply to both: top-k, hybrid (vector + Postgres FTS), reranking, MMR,
  thresholds, and retrieval evaluation.
- Cache **freshness/invalidation**: `CACHE_TTL_DAYS`, the time-sensitive exclusion regex,
  model-keyed entries, the cooldown-then-reprobe vs a permanent kill switch.

**This skill does NOT own (route elsewhere):**
- How `tools`/`streamText`/the tool loop work in the abstract → **ai-sdk-agent**. (This skill
  designs the *retrieval tool*; that skill owns the engine that calls it.)
- Web search + the citation protocol → **research-agent**. (Knowledge-RAG cites *internal* chunks;
  that skill owns *web* sources + the `[n]`/`<SOURCES>` wire format we'd reuse.)
- Market-data caching — the Redis `getOrRefresh` + per-minute budget for prices/quotes →
  **finance-markets** `caching-and-rate-budgets`. (That is a key→value freshness cache, NOT a
  vector cache; do not conflate the two.)

---

## Decision Tree

```
Vector / retrieval task arrives
|
+-- "How does the semantic cache actually work in index.ts?" -----> lumina-semantic-cache.md
+-- "What is an embedding? which model/dims? cosine vs dot?" ------> embeddings-fundamentals.md
+-- "pgvector setup: column type, ivfflat/hnsw, <=>, $queryRaw" --> pgvector-and-postgres.md
+-- "Should this CACHE an answer or RETRIEVE knowledge (RAG)?" ----> semantic-cache-vs-knowledge-rag.md
+-- "Ingest docs: chunk size/overlap, metadata, pipeline" --------> chunking-and-ingestion.md
+-- "top-k / hybrid (vector+FTS) / rerank / MMR / eval recall@k" -> retrieval-and-reranking.md
+-- "ADD knowledge-RAG to Lumina (a corpus the agent grounds on)"-> lumina-knowledge-rag-design.md
+-- "TTL / time-sensitive exclusion / when to bypass / self-heal"-> cache-freshness-and-invalidation.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **The cache is a pure optimization — every path is FAIL-OPEN.** Any error (embed fail, query fail, write fail) behaves as a MISS / no-op and the live Tavily+LLM path runs. Never let a cache fault break a request. | The whole "semantic-cache layer" block in `index.ts`; `embedQuery`/`findCachedAnswer`/`cacheAnswer` each `try/catch` → `return null`/no-op. |
| 2 | **Cache key = (embedding, model).** A premium-model request must NEVER be served a budget-model's cached answer. The lookup filters `WHERE model = ${model}` and `cacheAnswer` stores `model`. | `findCachedAnswer` SQL + `cacheAnswer` INSERT in `index.ts`; `CachedQuery.model` in `schema.prisma`. Answer quality differs per model — replaying across models is a correctness bug. |
| 3 | **NEVER serve time-sensitive or attachment queries from cache** — no read, no write. Prices/news/"today"/years are excluded; an upload's answer depends on the file. | `isTimeSensitive` (`TIME_SENSITIVE` regex) + `cacheable = !isTimeSensitive(query) && parts.length === 0` in `/perplexity_ask`. A stale cached price is the worst failure. |
| 4 | **Only cache a CLEANLY-finished answer** (`finishReason === "stop"` AND non-empty). Never store/replay a truncated, errored, or aborted generation for the whole TTL. | `if (cacheable && finishReason === "stop" && fullAnswer.trim()) cacheAnswer(...)` in `index.ts`. A truncated answer cached once poisons every near-duplicate for 7 days. |
| 5 | **pgvector distance is COSINE via `<=>` (0 = identical, 2 = opposite).** Compare with `<= DISTANCE_THRESHOLD`; tune the threshold against real logs, never by guess. | `embedding <=> ${vec}::vector AS distance` + `hit.distance <= DISTANCE_THRESHOLD` (0.15) in `findCachedAnswer`. `<=>` is cosine distance only because the column/index is cosine-configured. |
| 6 | **Cache-INFRA errors pause, they don't latch.** Only Postgres `42P01` (undefined_table) trips a short cooldown (`CACHE_COOLDOWN_MS`), then the cache re-probes — it self-heals after a migration with no restart. Never free-text match "does not exist". | `noteCacheError` checks `e.code === "42P01"`; the AI Gateway's "model does not exist" must NOT be mistaken for a DB fault. |
| 7 | **Embedding model + dimensions are locked together with the column.** `text-embedding-3-small` → 1536 dims → `vector(1536)`. Changing the model means a new column/table + a full re-embed; never mix dimensions in one column. | `embed({ model: "openai/text-embedding-3-small" })` ↔ `Unsupported("vector(1536)")` in `schema.prisma`. |
| 8 | **The `embedding` vector type is NOT in Prisma's typed client.** All vector reads/writes go through `$queryRaw`/`$executeRaw` with a `::vector` literal built from `[${arr.join(",")}]`. | `CachedQuery` exists "mainly to drive the migration"; `findCachedAnswer`/`cacheAnswer` use raw SQL. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Letting a cache error (DB down, embed 500) bubble up and fail the user's request. | Fail-open: catch → treat as a MISS, run the live path. The cache must be invisible when broken. |
| Serving a cache hit across models ("an answer is an answer"). | Key on `(embedding, model)`; `WHERE model = ${model}`. Opus and Haiku produce different answers. |
| Caching a "today's price / latest news" query because the embedding matched. | Gate with `isTimeSensitive`; time-sensitive + attachment queries skip cache entirely (read AND write). |
| Caching a stream that was cut short or errored, then replaying it for 7 days. | Only `cacheAnswer` when `finishReason === "stop"` and the answer is non-empty. |
| Treating `<=>` as raw cosine *similarity* and using `>= threshold`. | `<=>` is cosine *distance* (0 best). Filter `distance <= DISTANCE_THRESHOLD`; smaller is closer. |
| Picking `DISTANCE_THRESHOLD` by vibes, then shipping it. | Tune against real logs: "learn React" vs "learn React Native" must sit ABOVE 0.15 and MISS. Watch for false hits. |
| Permanently disabling the cache forever on the first DB error (the old latch). | Short cooldown + re-probe; only `42P01` trips it. Self-heals after the migration runs. |
| Embedding/querying with one model's dims against a column sized for another. | Lock model↔dims↔column. New model = new column + re-embed everything; never mix dims. |
| Calling the answer-cache "RAG". | It caches whole ANSWERS to skip work. RAG retrieves CHUNKS to ground a FRESH generation. See `semantic-cache-vs-knowledge-rag.md`. |
| Building knowledge-RAG as a pre-search injected into the prompt. | Expose retrieval as a TOOL the agent calls at inference (like the finance tools), so it grounds + cites on demand. See `lumina-knowledge-rag-design.md`. |
| Adding `extensions = [...]` to the Prisma datasource to manage pgvector. | pgvector is enabled in Supabase directly (`CREATE EXTENSION vector`); letting Prisma manage it flags Supabase's own extensions as drift → destructive reset. |

---

## Output Contract (what "done" looks like)

A vector/retrieval change is done when:
1. **Fail-open verified:** every cache/retrieval call path catches its own errors and degrades to a
   MISS / live path — kill the DB and the request still answers.
2. **Keying correct:** the cache (or retrieval) is keyed on `(embedding, model)` where answer
   quality depends on the model; vector dims match the embedding model match the column.
3. **Freshness honest:** time-sensitive + attachment queries bypass cache (read and write); only
   clean (`finishReason === "stop"`, non-empty) answers are stored; TTL is enforced in the query.
4. **Threshold grounded:** `DISTANCE_THRESHOLD` (or any retrieval cutoff) is tuned against real
   query logs, with at least one near-miss pair you've confirmed correctly MISSES.
5. **Self-heal intact:** infra errors pause-then-reprobe via the cooldown (only `42P01`), never a
   permanent latch; no free-text "does not exist" matching.
6. **Raw-SQL discipline:** vector reads/writes use `$queryRaw`/`$executeRaw` with a `::vector`
   literal; no attempt to push vectors through the typed Prisma client.
7. **For knowledge-RAG:** retrieval is a TOOL the agent invokes (not a blind prompt stuff),
   returns chunks with source metadata, and the answer cites them — reusing the existing
   `[n]`/`<SOURCES>` wire format. Ingestion is reproducible (chunk → embed → store, idempotent).
8. **Verified:** a HIT logs/returns in sub-second and replays the SAME wire format as a live
   answer; a deliberate near-duplicate MISS falls through to the live path. New backend files →
   full dev-server restart (Bun `--hot` misses them); relative imports carry explicit `.js`.

---

## Bundled References (8 files)

Read the one or two the task needs — never the whole folder.

### The cache that exists today
| File | Load when |
|------|-----------|
| `lumina-semantic-cache.md` *(project-grounded)* | You're touching the actual cache in `index.ts`: `embedQuery` → `findCachedAnswer` (cosine `<=>`, model-keyed, TTL) → replay, `cacheAnswer` on a clean finish, the `42P01` cooldown self-heal, fail-open everywhere, and the `CachedQuery` model. Start here for any cache change. |
| `cache-freshness-and-invalidation.md` *(project-grounded)* | Freshness/correctness: `CACHE_TTL_DAYS`, the `TIME_SENSITIVE` exclusion regex, model-keyed entries, when to bypass (attachments, follow-ups), staleness, and the cooldown-then-reprobe self-heal vs a permanent kill switch. |

### Embeddings & pgvector foundations
| File | Load when |
|------|-----------|
| `embeddings-fundamentals.md` *(generic)* | What an embedding is, `openai/text-embedding-3-small` via the AI Gateway, dimensions, cosine vs euclidean vs dot, normalization, batching, cost, and how to choose an embedding model. |
| `pgvector-and-postgres.md` *(project-grounded)* | pgvector in this stack: the `vector` column, `ivfflat` vs `hnsw` indexes, the `<=>` operator, `$queryRaw` with a `::vector` literal, Prisma 7 + raw vector queries, and the migration to enable the extension + table on Supabase. |

### True RAG (the capability we don't have yet)
| File | Load when |
|------|-----------|
| `semantic-cache-vs-knowledge-rag.md` *(generic)* | The core distinction: caching whole ANSWERS (what Lumina has) vs retrieving knowledge CHUNKS to ground a fresh generation (true RAG). When each wins, their failure modes, why they coexist. Read before proposing "add RAG". |
| `chunking-and-ingestion.md` *(generic)* | Chunking strategies (fixed/sentence/semantic), overlap, metadata, an ingestion pipeline for a future knowledge corpus (finance/health/academic docs) → embed → store; quality pitfalls. |
| `retrieval-and-reranking.md` *(generic)* | top-k retrieval, hybrid (vector + Postgres FTS/keyword), reranking (cross-encoder / LLM-as-reranker), MMR diversity, thresholds, and retrieval evaluation (recall@k, groundedness). |
| `lumina-knowledge-rag-design.md` *(project-grounded)* | A concrete proposal to add knowledge-RAG to Lumina reusing pgvector + the AI SDK: corpus → chunk → embed → store → a retrieval TOOL the agent calls at inference → cite. How it slots beside the answer-cache and the verticals. Cross-refs **ai-sdk-agent** (tool design) + **research-agent** (citations). |

---

## Cross-skill routing & prior art

- **ai-sdk-agent** — the engine: how `streamText` + `tools` + the multi-step loop + `embed` fit
  together. A knowledge-RAG retriever is just another tool on that loop; design it there.
- **research-agent** — web search + the `[n]` inline-citation / `<SOURCES>` wire format. Knowledge-RAG
  reuses that exact citation machinery for *internal* chunks.
- **finance-markets** `caching-and-rate-budgets` — the OTHER cache in this repo (Redis
  `getOrRefresh` + per-minute vendor budget for prices). It's a key→value freshness cache, not a
  vector cache — keep them mentally separate so you don't reach for the wrong tool.
- **Cross-repo:** the `fintech-webapp` / rareLab skills have RAG/embedding prior art on a
  Next.js/Drizzle stack — translate any pattern to our Express/Prisma + raw-SQL-`::vector` approach,
  and verify against live `index.ts`/`schema.prisma` before relying on any `file:line` (numbers
  drift).
