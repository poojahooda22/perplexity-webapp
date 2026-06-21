# Lumina Knowledge-RAG — a concrete design to ground generation on an internal corpus

> The build plan for adding **true knowledge-RAG** to Lumina: a curated corpus → chunk → embed →
> store in pgvector → a **retrieval TOOL** the agent calls at inference → cite the chunks it used.
> This `lumina-` ref proposes NEW code grounded in the EXISTING patterns — the semantic-answer cache
> in [`backend/index.ts`](../../../../backend/index.ts) (embed + pgvector mechanics to reuse) and
> the finance tool belt in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts) (the
> exact tool contract to copy). Read this when the task is "add a knowledge base the agent grounds
> on." Siblings: `semantic-cache-vs-knowledge-rag.md` (why this is NOT the cache — read first),
> `chunking-and-ingestion.md` (corpus prep), `retrieval-and-reranking.md` (top-k/hybrid/rerank).
> Cross-skill: **ai-sdk-agent** owns the tool-loop engine; **research-agent** owns the `[n]`/
> `<SOURCES>` citation wire format we reuse verbatim.

The one distinction this whole doc hangs on: the cache replays **whole past answers** to *skip*
work; knowledge-RAG retrieves **chunks** to *ground a fresh* generation. Same embedding model, same
pgvector, same `<=>` operator — opposite goal, opposite failure mode. Build it **alongside** the
cache, not on top of it.

---

## 1. What we already have to reuse (don't reinvent)

Every primitive RAG needs already ships in Lumina for the answer-cache. RAG is a re-composition.

| Primitive | Where it lives today | Reuse for RAG |
|-----------|---------------------|---------------|
| Embedding call | `embedQuery` in [`index.ts`](../../../../backend/index.ts) (`embed({ model: "openai/text-embedding-3-small" })`, in fn `embedQuery`) | Same model, same 1536 dims — embed **chunks** at ingest + the **tool's query arg** at inference. |
| pgvector `<=>` cosine search | `findCachedAnswer` raw SQL (`embedding <=> ${vec}::vector AS distance`) | Same operator + `::vector` literal, but `LIMIT k` (k≈5), not `LIMIT 1`, and `WHERE` on corpus/vertical, not `model`. |
| Raw-SQL vector I/O | `$queryRaw`/`$executeRaw` with `[${arr.join(",")}]::vector` | The vector column is `Unsupported` in Prisma's typed client — RAG reads/writes go through raw SQL too. |
| Tool contract (Zod schema, typed states, cache+budget, `withGuard`) | `getQuote`/`financeWebSearch` in [`tools.ts`](../../../../backend/finance/tools.ts) | The retrieval tool is *just another finance-style tool* — copy the skeleton exactly. |
| Citation wire format | `sourcesImagesTail` + the `sources[]` accumulator (in `streamFinanceAnswer`, [`index.ts`](../../../../backend/index.ts)) | The retriever pushes chunk sources into the SAME accumulator → `<SOURCES>` tail → client renders unchanged. |
| Fail-open discipline | every cache fn `try/catch → return null` | Retrieval fails open too: a retrieval error returns "no internal sources," the agent still answers from the web. |

**The gap** is exactly two things: (1) a corpus + ingestion pipeline, and (2) a `KnowledgeChunk`
table + a retrieval tool. Nothing else is new.

---

## 2. The pipeline, end to end

```
INGEST (offline, a script — NOT a request path)
  corpus docs (finance/health/academic .md, PDFs, curated notes)
    └─ chunk  (sentence-aware, ~500 tok, ~60 tok overlap)   → chunking-and-ingestion.md
    └─ embed  (embed() text-embedding-3-small, BATCHED)      → reuse embedQuery's model
    └─ store  ($executeRaw INSERT … embedding::vector, + metadata)  → KnowledgeChunk table
                                                                       (idempotent on contentHash)

INFERENCE (per request, inside the agent tool loop)
  user turn → streamText(tools: { …, searchKnowledge })
    └─ model decides it needs internal knowledge → calls searchKnowledge({ query, vertical? })
        └─ embed(query)  → $queryRaw  embedding <=> ::vector  ORDER BY distance LIMIT k
        └─ (optional) rerank top-k → top-n                    → retrieval-and-reranking.md
        └─ push chunks into sources[] with GLOBAL [n] numbers (copy financeWebSearch)
        └─ return { chunks: [{ n, title, url?, snippet }] }
    └─ model grounds its prose in the returned chunks, cites [n]
    └─ <SOURCES> tail emitted from sources[] → client renders like Discover
```

The ingest half runs as a CLI/cron script (a new `backend/knowledge/ingest.ts`), never on the hot
request path. The inference half is one new tool on the existing loop.

---

## 3. The data model — `KnowledgeChunk`

Mirror `CachedQuery` in [`schema.prisma`](../../../../backend/prisma/schema.prisma) (model at
`model CachedQuery`, `@@map("cached_query")`, `embedding Unsupported("vector(1536)")`). The vector
type is `Unsupported`, so the model exists only to drive the migration; all I/O is raw SQL.

```prisma
/// Knowledge corpus for RAG. Accessed ONLY via $queryRaw/$executeRaw (vector type isn't
/// part of Prisma's typed client). Distinct from CachedQuery: that caches whole ANSWERS;
/// this stores knowledge CHUNKS to ground a fresh generation.
model KnowledgeChunk {
  id          String                      @id @default(uuid())
  vertical    String                                          // "finance" | "health" | "academic" | "general" — scopes retrieval
  sourceId    String                      @map("source_id")   // groups chunks from one document
  title       String                                          // document/section title → cited
  url         String?                                         // external link-out if the doc has one
  content     String                                          // the chunk text (what's injected)
  contentHash String                      @map("content_hash")// idempotency: re-ingest skips unchanged chunks
  embedding   Unsupported("vector(1536)")                     // 1536 = text-embedding-3-small (LOCKED to the model)
  createdAt   DateTime                    @default(now())     @map("created_at")

  @@unique([sourceId, contentHash])  // re-running ingest is a no-op for unchanged chunks
  @@map("knowledge_chunk")
}
```

**Index** (raw migration SQL, NOT via Prisma — pgvector extension is Supabase-managed, see
non-negotiable below): once the corpus exceeds a few thousand chunks, add an HNSW cosine index so
`<=>` doesn't full-scan:

```sql
CREATE INDEX ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);
```

Until then the sequential `<=>` scan is fine (Tier 1). See `pgvector-and-postgres.md` for `ivfflat`
vs `hnsw` and the `vector_cosine_ops` opclass requirement (the index opclass MUST match the `<=>`
distance, or the index is silently ignored).

---

## 4. The retrieval tool — copy the finance tool contract

This is the heart of the design and the one rule that separates a real implementation from an
amateur one: **expose retrieval as a TOOL the agent invokes**, not a blind pre-search stuffed into
the prompt. The agent calls it *only when the question needs internal knowledge*, can call it with a
*reformulated* query, and the chunks become *cited* sources — exactly the `financeWebSearch`
pattern in [`tools.ts`](../../../../backend/finance/tools.ts).

```ts
// backend/knowledge/tools.ts — NEW. Mirrors buildFinanceTools() shape: fresh tool set +
// a sources[] accumulator per request so chunk citations line up with the <SOURCES> tail.
import { tool, embed } from "ai";
import { z } from "zod";
import { prisma } from "../db.js";          // explicit .js — Vercel strict ESM
import { withGuard, withinBudget } from "../finance/hooks.js";

const K = 5;                       // top-k chunks to consider
const MAX_DISTANCE = 0.45;         // RAG threshold ≫ the cache's 0.15 — see §5
const EMBED_BUDGET_PER_MIN = 60;   // embeds are cheap but still budgeted

export function buildKnowledgeTools() {
  const sources: Array<{ title: string; url?: string; content: string }> = [];

  const searchKnowledge = tool({
    description:
      "Search Lumina's curated internal knowledge base for grounded facts, definitions, and " +
      "background. Use BEFORE answering conceptual questions in finance/health/academic topics. " +
      "Returns numbered chunks — cite them inline as [n]. Does NOT cover live prices/news (use " +
      "the live-data tools) or anything outside the curated corpus.",
    inputSchema: z.object({
      query: z.string().min(3).describe("A focused, self-contained search query (resolve pronouns)."),
      vertical: z.enum(["finance", "health", "academic", "general"]).optional()
        .describe("Restrict to one corpus when the topic is clearly scoped."),
    }),
    execute: async ({ query, vertical }) => {
      if (!withinBudget("searchKnowledge", EMBED_BUDGET_PER_MIN)) {
        return { unavailable: "Knowledge search is rate-limited right now — try again shortly." };
      }
      try {
        const { embedding } = await embed({ model: "openai/text-embedding-3-small", value: query });
        const vec = `[${embedding.join(",")}]`;
        const rows = await prisma.$queryRaw<
          Array<{ title: string; url: string | null; content: string; distance: number }>
        >`
          SELECT title, url, content, (embedding <=> ${vec}::vector) AS distance
          FROM knowledge_chunk
          ${vertical ? prisma.$queryRawUnsafe : undefined /* see note */}
          WHERE (${vertical}::text IS NULL OR vertical = ${vertical})
          ORDER BY embedding <=> ${vec}::vector
          LIMIT ${K}
        `;
        const hits = rows.filter((r) => r.distance <= MAX_DISTANCE);   // drop weak matches
        if (hits.length === 0) return { chunks: [], note: "No internal knowledge matched." };
        // GLOBAL [n] numbers — same scheme as financeWebSearch so citations align with <SOURCES>.
        const numbered = hits.map((h) => {
          sources.push({ title: h.title, url: h.url ?? undefined, content: h.content });
          return { n: sources.length, title: h.title, url: h.url, snippet: h.content.slice(0, 800) };
        });
        return { chunks: numbered };
      } catch (e) {
        console.error("[knowledge] searchKnowledge failed:", e instanceof Error ? e.message : String(e));
        return { unavailable: "Knowledge search is temporarily unavailable." };  // FAIL-OPEN
      }
    },
  });

  return { tools: { searchKnowledge: withGuard("searchKnowledge", searchKnowledge) }, sources };
}
```

**Tool contract checklist (every box copied from the finance belt):**

| Rule | From | Applied here |
|------|------|--------------|
| Description says what it covers AND does NOT | `getQuote` "Does NOT cover crypto…" | "Does NOT cover live prices/news… or anything outside the curated corpus." |
| Zod `inputSchema` with bounds/`.describe` | every finance tool | `query.min(3)`, optional `vertical` enum. |
| Return **typed states, never throw data** | `{items}`/`{unavailable}`/`{error}` | `{chunks}` / `{chunks:[]}` / `{unavailable}`. |
| Push to shared `sources[]` + GLOBAL `[n]` | `financeWebSearch` | identical loop → citations align with `<SOURCES>`. |
| Wrap in `withGuard` | all finance data tools | `withGuard("searchKnowledge", …)` (staples the right disclaimer if domain demands one). |
| Fail-open | the semantic-cache fns | `catch → { unavailable }`; the agent still answers from web sources. |

> **AbortSignal:** like `cachedToolFetch`, do NOT thread the request's disconnect signal into the
> embed/query — disconnect cancellation belongs at the `streamText` level (`abortSignal:
> disconnectSignal(res)` in [`index.ts`](../../../../backend/index.ts)). See `ai-sdk-finance-agent.md`.

---

## 5. The threshold is NOT the cache threshold

The single most common mistake: copying `DISTANCE_THRESHOLD = 0.15` from the answer-cache into the
retriever. They measure different things.

| | Answer cache (`findCachedAnswer`) | Knowledge retriever (`searchKnowledge`) |
|---|---|---|
| Compares | query ↔ a *past query* | query ↔ a *knowledge chunk* |
| Goal | "is this the SAME question?" → replay | "is this chunk RELEVANT?" → ground |
| Cost of false positive | serve a wrong cached answer (bad) | inject a marginally-relevant chunk the model can ignore (cheap) |
| Cost of false negative | extra live work (fine) | miss real grounding → model guesses (bad) |
| Tuning | **tight** — `0.15`, `LIMIT 1`, must MISS near-duplicates | **loose** — `~0.4–0.5`, `LIMIT k`, recall-biased; let the model filter |

Tune `MAX_DISTANCE` against real corpus queries the same way the cache threshold was tuned against
logs — confirm an *off-topic* query returns `chunks: []` and an *on-topic* one returns real chunks.
See `retrieval-and-reranking.md` for recall@k and the optional rerank step (retrieve `k=20`, rerank
to `n=5`) that lets you keep recall high *and* precision high.

---

## 6. How it slots beside the cache and the verticals

The retriever is a **tool on the agent loop**, so it composes with everything already wired in
[`index.ts`](../../../../backend/index.ts) without touching the cache code path:

```
POST /perplexity_ask  (Discover/general vertical)
  ├─ SEMANTIC CACHE   → embed query → findCachedAnswer → HIT? replay (RAG never runs)   ← unchanged
  └─ MISS → streamText with tools: { …existing, searchKnowledge }
              model calls searchKnowledge → chunks → cites [n] → <SOURCES> tail

POST /perplexity_ask {vertical:"finance"}  → streamFinanceAnswer
  └─ add searchKnowledge to buildFinanceTools()'s returned tools; MERGE the two sources[]
     accumulators into one before sourcesImagesTail (so web + chunk citations share [n] space)
```

**Layering order matters:** the answer cache sits *in front of* RAG. A cache HIT replays a finished
answer and RAG never runs — correct, because the cached answer was *itself* produced with RAG
grounding. RAG only fires on the MISS path (or in the finance/assistant verticals, which skip the
cache entirely). Do **not** try to "cache retrieved chunks" — that conflates the two systems; the
chunk store IS the durable layer, the cache is the optimization on top.

**Per-vertical corpora:** the `vertical` column lets one table serve all tabs. Finance chunks
(SEC primers, valuation method notes), health chunks (condition explainers — never advice), academic
chunks (method/glossary). The tool's optional `vertical` arg scopes retrieval when the tab is known.

---

## 7. Decision framework — do you even need RAG here?

Reach for knowledge-RAG ONLY when the answer depends on a **curated, slow-changing, ownable corpus**
that the web search wouldn't surface well or that you want authoritative/consistent.

| Situation | Use | Why |
|-----------|-----|-----|
| "What's AAPL trading at?" | a **live-data tool** (`getQuote`) | RAG on prices is wrong by construction — prices aren't a corpus. |
| "Latest Fed news?" | `financeWebSearch` / Tavily | time-sensitive; the corpus is stale the moment it's ingested. |
| "Repeat of a question we answered well" | the **semantic cache** | replay the whole answer — cheaper than re-grounding. |
| "Explain the P/E ratio per Lumina's house definitions" | **searchKnowledge** (RAG) | curated, consistent, ownable — exactly the corpus case. |
| "Summarize this PDF I uploaded" | **attachment parts** (`buildAttachmentParts`) | one-shot context, not a reusable corpus — don't ingest it. |
| General web question | Tavily pre-search ([`index.ts`](../../../../backend/index.ts) `webSearch`) | the open web is the corpus; RAG adds nothing. |

If the corpus is < a few hundred chunks and rarely queried, a client-side or in-memory match may
beat the round-trip — but Lumina already has pgvector wired, so the marginal cost of doing it "right"
is near zero. The real cost is **corpus curation + freshness**, not the vector mechanics.

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Pre-searching the corpus and stuffing chunks into the prompt every turn. | Expose `searchKnowledge` as a TOOL; the agent retrieves only when needed, with a reformulated query, and *cites* the result. |
| Reusing the cache's `DISTANCE_THRESHOLD = 0.15` for retrieval. | Retrieval is recall-biased: `~0.4–0.5`, `LIMIT k`, optionally rerank. §5. |
| `LIMIT 1` like the cache. | `LIMIT k` (≈5) — grounding wants several chunks; ranking/MMR picks the best. |
| Calling it "RAG" but storing whole answers. | RAG stores CHUNKS to ground a FRESH generation. The answer cache is a different system. See `semantic-cache-vs-knowledge-rag.md`. |
| Embedding chunks with one model and querying with another. | Lock model↔dims↔column: `text-embedding-3-small` → 1536 → `vector(1536)`, both sides. A new model = new column + full re-embed. |
| Pushing vectors through Prisma's typed client. | `$queryRaw`/`$executeRaw` with `[${arr.join(",")}]::vector` — same as `findCachedAnswer`/`cacheAnswer`. |
| Letting a retrieval error 500 the request. | Fail-open: `catch → { unavailable }`; the live web path still answers. |
| Ingesting on the request path (embedding a doc when a user asks). | Ingest is an OFFLINE script/cron (`backend/knowledge/ingest.ts`); the request only *reads*. |
| Re-ingesting duplicates every run. | Idempotent on `@@unique([sourceId, contentHash])` — unchanged chunks skip. |
| Returning chunks with no source metadata. | Always carry `title`/`url` and push to `sources[]` so the answer cites internal chunks like web sources. |
| Adding `extensions = [vector]` to the Prisma datasource. | pgvector is Supabase-managed (`CREATE EXTENSION vector`); index via raw migration SQL. Letting Prisma manage it flags drift → destructive reset. |
| Giant chunks (whole documents) or one-sentence slivers. | ~500-token sentence-aware chunks with ~60-token overlap. See `chunking-and-ingestion.md`. |

---

## 9. R-SCALE — what breaks at 100× / 10,000×

The retrieval surface is a **search** surface; the §B (Search) + §C (Read spike) battery applies.

| Tier | Corpus | Reality | What breaks next |
|------|--------|---------|------------------|
| 1× | ≤ few k chunks | Sequential `<=>` scan; no index; embed-per-query. Fine. | At ~10k chunks the full-scan latency creeps. |
| 100× | 10k–100k chunks | Add the **HNSW cosine index** (`vector_cosine_ops`). Cache hot query embeddings. | Recall/precision tradeoff bites — pure vector misses keyword-exact terms (tickers, drug names). |
| 10,000× | 1M+ chunks | **Hybrid**: vector + Postgres FTS (`pg_trgm`/`tsvector`) fused, then **rerank** top-k. Per-vertical partition. Consider a dedicated vector store if pgvector tail-latency degrades. | Ingest throughput + freshness pipeline; embedding cost; index rebuild time. |

Two scale rules from day one even at Tier 1: (1) **store the signals** — keep `title`/`url`/`vertical`
so you *can* rank and scope later; (2) **make ingest idempotent + re-runnable** so re-embedding the
whole corpus (the inevitable model upgrade) is a script run, not a migration crisis. See
`retrieval-and-reranking.md` for hybrid + rerank, and the global R-SCALE rule for the full battery.

---

## 10. Build checklist (what "done" looks like)

1. **Migration:** `knowledge_chunk` table created via raw SQL (vector column + `@@unique`), pgvector
   already enabled in Supabase; HNSW index deferred until the corpus warrants it.
2. **Ingest script:** `backend/knowledge/ingest.ts` — chunk → batched `embed` →
   `$executeRaw INSERT`, idempotent on `(sourceId, contentHash)`, runnable from CLI/cron. NOT on a
   request path.
3. **Tool:** `searchKnowledge` matches the finance tool contract (Zod bounds, typed states,
   `withGuard`, fail-open, pushes to `sources[]` with GLOBAL `[n]`). `MAX_DISTANCE` tuned loose,
   `LIMIT k`.
4. **Wiring:** tool merged into the relevant loop(s); the per-tool `sources[]` merged into the route's
   accumulator before `sourcesImagesTail`; citations render via the existing `<SOURCES>` tail.
5. **Locked dims:** embed model = `text-embedding-3-small` (1536) on BOTH ingest and query, matching
   the `vector(1536)` column.
6. **Verified:** an on-topic question fires `searchKnowledge` (log shows the call), returns chunks,
   and the answer cites `[n]` that resolve in `<SOURCES>`; an off-topic question returns `chunks: []`
   and the agent falls back gracefully. New backend files → **full dev-server restart** (Bun `--hot`
   misses them); every relative import carries explicit `.js`.

---

## Cross-reference map

- **Is this the cache or RAG?** → `semantic-cache-vs-knowledge-rag.md` (read before proposing this).
- **Corpus prep** (chunk size/overlap/metadata, ingestion pipeline) → `chunking-and-ingestion.md`.
- **top-k / hybrid / rerank / MMR / recall@k** → `retrieval-and-reranking.md`.
- **pgvector column/index/`<=>`/raw SQL** → `pgvector-and-postgres.md`.
- **The existing cache mechanics this reuses** → `lumina-semantic-cache.md`.
- **Tool-loop engine** (`streamText`/`tools`/`stopWhen`/hooks) → **ai-sdk-agent** skill.
- **The `[n]`/`<SOURCES>` citation wire format the retriever reuses** → **research-agent** skill.
