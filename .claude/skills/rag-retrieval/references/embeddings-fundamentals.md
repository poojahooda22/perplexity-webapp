# Embeddings — fundamentals for retrieval

> What a text embedding actually is, the model Lumina uses (`openai/text-embedding-3-small` via
> the Vercel AI Gateway), why dimensions/distance-metric/normalization are not free choices, and
> how to batch + cost it. **Generic** knowledge that happens to underpin the semantic-answer cache
> in [`backend/index.ts`](../../../../backend/index.ts) — read it before you touch any vector code,
> change models, or design a new corpus. Adjacent refs: `pgvector-and-postgres.md` (the column,
> indexes, `<=>`, raw SQL that *stores* these vectors), `lumina-semantic-cache.md` (the live cache
> that *uses* them), `chunking-and-ingestion.md` (what text you embed for true RAG),
> `retrieval-and-reranking.md` (what you do with the distances).

---

## 1. What an embedding is

An **embedding** is a fixed-length array of floats that encodes the *meaning* of a piece of text as
a point in high-dimensional space. The contract that makes it useful: **semantically similar text
maps to nearby points; unrelated text maps to far-apart points.** "How do I learn React?" and "best
way to pick up React" land almost on top of each other; "React" the chemistry term lands elsewhere.

This is *not* keyword matching. Two strings with zero words in common ("car" / "automobile") can be
near; two strings sharing many words ("learn React" / "learn React Native") can be deliberately
far. That property is the entire engine behind the semantic cache: a paraphrase of a previously
answered question can be detected and the stored answer replayed without re-running Tavily + the LLM.

| Term | Meaning | In this repo |
|------|---------|--------------|
| Embedding / vector | The float array for one text | `number[]` from `embedQuery` in `index.ts` |
| Dimensions | Length of that array | **1536** for `text-embedding-3-small` |
| Embedding model | The network that produces vectors | `openai/text-embedding-3-small` |
| Distance / similarity | A number for "how close" two vectors are | cosine via pgvector `<=>` |
| Vector space | The shared coordinate system | one per model — **never mixable** |

The one rule that subsumes most mistakes: **a vector only means something relative to other vectors
produced by the SAME model.** A vector from model A and a vector from model B are noise to each
other even if both are length 1536. This is why changing the embedding model is a migration, not a
config flip (Non-Negotiable #7 in the SKILL).

---

## 2. The model Lumina uses — `text-embedding-3-small` via the Gateway

Embeddings go through the **same Vercel AI Gateway** as the chat models: a bare provider/model
string id, no OpenAI SDK, one key (`AI_GATEWAY_API_KEY`). The call is the AI SDK `embed` helper:

```ts
// embedQuery in backend/index.ts — the cache key generator
import { embed } from "ai";
const { embedding } = await embed({
  model: "openai/text-embedding-3-small", // bare id → routed via the Gateway, like chat models
  value: query,
});
return embedding; // number[] of length 1536
```

Things to notice, each of which is load-bearing:

- **It is the gateway, not `@ai-sdk/openai`.** Same pattern as `ALLOWED_MODELS` in `index.ts` — a
  `<provider>/<model>` string is resolved by the gateway, so you get OpenAI embeddings without a
  separate OpenAI key or client. Swapping to a Cohere or Google embedding model later is a string
  change *plus* a re-embed (see §8/§9), not a new SDK.
- **`embed` returns a single vector; `embedMany` returns many** (see §6). `embedQuery` only ever
  embeds one query, so it uses `embed`.
- **Failure is a cache MISS, not a fault.** `embedQuery` catches and returns `null`; the live path
  runs. An embed 500 must never break a user's request and must **not** pause the cache (that's
  reserved for the `42P01` table-missing case).

### `text-embedding-3-small` quick facts

| Property | Value | Why it matters here |
|----------|-------|---------------------|
| Default dimensions | **1536** | Locked to `Unsupported("vector(1536)")` in `schema.prisma` |
| Max input | ~8191 tokens | A query is tiny; chunks for RAG must stay under this |
| Normalized output | Yes (unit length) | Cosine == dot product (see §4) |
| Relative cost | ~5× cheaper than `-3-large`, far cheaper than older `ada-002` | Cheap enough to embed every query |
| Dimension shortening | Supported (MRL — can request 512/256 dims) | Smaller index, slight recall loss; only if you re-embed the whole corpus |

`text-embedding-3-small` is the right default for this app: queries are short, the quality gap vs
`-3-large` is small for cache-hit detection and general retrieval, and the cost lets us embed on
every request without thinking about it.

---

## 3. Dimensions — what 1536 buys and costs

Dimensions = how many numbers describe each text. More dimensions = more capacity to separate fine
shades of meaning, at the cost of storage, index size, and a little latency.

| Choice | Recall / nuance | Storage per vec | When |
|--------|-----------------|-----------------|------|
| 256 | Lower | ~1 KB | Huge corpus, latency-critical, coarse matching OK |
| 512 | Good | ~2 KB | Cost-sensitive RAG at scale |
| **1536** (our default) | High | ~6 KB (float4) | The sane default; what `-3-small` emits natively |
| 3072 (`-3-large`) | Highest | ~12 KB | Only when eval proves the gap matters |

**The trap:** the embedding model's output dimension, the embedding stored at write time, the
embedding generated at query time, and the database **column width must all be identical.** In this
repo that chain is: `text-embedding-3-small` (1536) → `embed(...)` → `vector(1536)` column →
`<=>` query. Break any link and you get either a SQL error or, worse, silently wrong distances.
Dimension shortening (MRL) is legitimate but it is a corpus-wide decision: you cannot store 1536-dim
rows and query with a 512-dim vector.

---

## 4. Distance metrics — cosine vs euclidean vs dot

Three ways to turn two vectors into one "how close" number. They are NOT interchangeable, and the
metric you query with must match the metric your index was built for.

| Metric | Measures | Range / best | Sensitive to magnitude? | pgvector op / class |
|--------|----------|--------------|--------------------------|---------------------|
| **Cosine distance** | Angle between vectors (direction only) | 0 = identical … 2 = opposite; **smaller = closer** | No | `<=>` / `vector_cosine_ops` |
| Euclidean (L2) | Straight-line gap between points | 0 = identical … ∞; smaller = closer | Yes | `<->` / `vector_l2_ops` |
| (Negative) inner product / dot | Projection / alignment | larger dot = closer | Yes | `<#>` (returns *negative* dot) / `vector_ip_ops` |

**Lumina uses cosine** — the `<=>` operator in `findCachedAnswer` returns cosine *distance*, which
is why the code compares with `hit.distance <= DISTANCE_THRESHOLD` (0.15), not `>=`. Smaller is
closer; 0 is the same question.

```sql
-- findCachedAnswer in index.ts: <=> is COSINE distance ONLY because the column/index is cosine-set
SELECT answer, sources, images, (embedding <=> ${vec}::vector) AS distance
FROM cached_query
WHERE model = ${model} AND created_at > ${cutoff}
ORDER BY embedding <=> ${vec}::vector
LIMIT 1
```

### Why cosine for text

Cosine ignores vector *length* and compares only *direction* — which is exactly what you want for
semantic similarity, where a longer or more emphatic phrasing of the same idea should still match.
Euclidean conflates "different meaning" with "different magnitude," which for raw text is usually
noise. Cosine is the default for nearly all text-embedding retrieval; reach for L2 only when the
magnitude genuinely carries meaning (rare for sentence embeddings).

### The shortcut that only works on normalized vectors

When vectors are **unit length** (magnitude 1), cosine similarity equals the dot product, so cosine
distance and dot become rank-equivalent — they order neighbors identically. `text-embedding-3-small`
already returns normalized vectors, so dot-product search would give the same neighbors as cosine
and is marginally faster. We still use cosine because (a) it's robust if a future model isn't
normalized, and (b) the distance is interpretable on a fixed 0–2 scale, which makes
`DISTANCE_THRESHOLD` tunable. Don't switch to `<#>` for a micro-optimization — pgvector's `<#>`
returns the *negative* dot, an easy sign-flip bug.

---

## 5. Normalization

**Normalizing** a vector = scaling it to length 1 (`v / ‖v‖`). After normalization, only direction
remains, so cosine and dot agree (§4).

| Situation | What to do |
|-----------|------------|
| Model returns normalized vectors (`-3-small`, `-3-large`) | Nothing — store as-is, use cosine |
| Model returns un-normalized vectors | Normalize at write AND query time, OR just use cosine (`<=>`), which normalizes implicitly in the distance math |
| Mixing normalized + raw in one column | Never — distances become meaningless |

Practical rule for this repo: **don't manually normalize.** `text-embedding-3-small` is already
unit-length, and cosine distance (`<=>`) is invariant to magnitude anyway, so the question is moot.
The only place it'd bite you is if you switched to a model that returns raw vectors and then queried
with dot (`<#>`) instead of cosine.

---

## 6. Batching

One query → `embed`. A corpus → `embedMany`. Batching is the single biggest throughput +
cost-efficiency lever when you ingest documents (true RAG), and irrelevant to the current
single-query cache.

```ts
import { embedMany } from "ai";
// Ingestion: embed many chunks in one round-trip (NOT one HTTP call per chunk)
const { embeddings } = await embedMany({
  model: "openai/text-embedding-3-small",
  values: chunks.map((c) => c.text), // order preserved: embeddings[i] ↔ chunks[i]
});
// embeddings.length === chunks.length, same order
```

| Do | Don't |
|----|-------|
| Use `embedMany` for ingestion; the AI SDK splits into provider-sized batches for you | Loop `embed` per chunk — N HTTP round-trips, N× latency, easy to hit rate limits |
| Keep each input under the model's token cap (~8191) | Send a 50k-token document as one value — it truncates silently |
| Rely on index alignment (`embeddings[i] ↔ values[i]`) | Re-sort or filter `values` after embedding without carrying ids |
| Embed once at ingest, persist, reuse | Re-embed the same chunk on every query — embed the *query*, not the corpus, at request time |

**Embed the query at request time; embed the corpus once at ingest.** Conflating the two (re-embedding
documents per request) is the classic RAG performance bug.

---

## 7. Cost

Embeddings are billed per **input token** and are cheap — but "cheap × millions" still adds up at
scale, so know the shape.

| Lever | Effect on cost |
|-------|----------------|
| Model | `-3-small` ≈ 5× cheaper than `-3-large`; both far cheaper than chat models |
| Tokens embedded | Linear — embed only what you retrieve on (titles + body chunks, not whole files repeatedly) |
| Re-embedding | A model/dimension change re-embeds the ENTIRE corpus — budget for it |
| Query-side | One query embed per `/perplexity_ask` (cacheable path) — negligible, but the rate-limit in `index.ts` exists partly to stop a loop from running up embedding + Tavily + premium-model bills |

Order-of-magnitude intuition (verify current gateway pricing before quoting): embedding tens of
thousands of short chunks with `-3-small` costs cents, not dollars. The expensive line item in this
app is the **chat LLM + Tavily**, which is precisely what the semantic cache exists to skip — the
embedding is the cheap key that unlocks avoiding the expensive miss path. Two cost guardrails already
in the code: the per-user sliding-window `rateLimited` (20/min) and the cache itself (a HIT pays one
embed + one vector query instead of search + generation).

---

## 8. Choosing an embedding model — a decision framework

```
Need embeddings for a new surface?
|
+-- Same vector space as the existing cache? (want to share the table / compare)
|     YES → you MUST use the same model+dims (text-embedding-3-small / 1536). Stop here.
|
+-- New isolated corpus, you control the column:
|     |
|     +-- Default → openai/text-embedding-3-small (1536). Cheap, normalized, good enough.
|     +-- Retrieval eval shows -small misses nuance you need → -3-large (3072) ONLY if recall@k proves it.
|     +-- Multilingual / domain-specific (code, legal, bio) → evaluate a domain/multilingual model
|     |     (e.g. a Cohere/Voyage/BGE-class model) on YOUR queries before committing.
|     +-- Latency/storage critical at scale → -3-small at shortened dims (512/256) — re-embed all.
|
+-- Cross-language or "match a question to an answer" (asymmetric)?
      → prefer a model trained for asymmetric / instruction retrieval; plain similarity models
        assume query and doc look alike. (For the cache, query↔query is symmetric, so -small is fine.)
```

| Criterion | Weight for Lumina | Note |
|-----------|-------------------|------|
| Quality (recall@k on real queries) | High | Measure, don't assume; -small is the floor to beat |
| Cost per token | Medium | -small wins; matters at corpus scale |
| Dimensions / storage | Medium | 1536 is fine for our volume; shorten only if proven |
| Normalized output | Nice-to-have | -small yes → cosine/dot equivalence |
| Gateway availability | Hard requirement | Must be callable via the AI Gateway string id, like the chat models |
| Lock-in / migration cost | High | Switching = full re-embed + new column. Choose deliberately. |

**Default answer:** stay on `text-embedding-3-small`. Only move when a *measured* retrieval eval on
real query logs shows the upgrade pays for its re-embed + storage cost.

---

## 9. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Comparing a vector from one model with a vector from another. | One model per vector space. Different model = noise, even at equal dims. |
| Treating `<=>` as cosine *similarity* and filtering `>= threshold`. | `<=>` is cosine *distance* (0 best). Filter `distance <= DISTANCE_THRESHOLD`; smaller is closer. |
| Switching the embedding model but keeping the old `vector(1536)` column and rows. | Model change = new column/table + re-embed the whole corpus. Never mix models or dims in one column. |
| Querying a 512-dim shortened vector against 1536-dim stored rows. | Pick ONE dimension corpus-wide. Re-embed everything if you change it. |
| Looping `embed` once per chunk during ingestion. | `embedMany` — one batched round-trip; rely on index alignment. |
| Manually normalizing `-3-small` vectors "to be safe." | Already unit length; cosine ignores magnitude anyway. Leave them alone. |
| Re-embedding documents on every query. | Embed the corpus once at ingest, persist; embed only the QUERY per request. |
| Using `<#>` (negative inner product) and forgetting the sign. | It returns *negative* dot — easy bug. Use `<=>` cosine unless you have a measured reason. |
| Sending a 30k-token doc to `embed` as one value. | Chunk under the ~8191-token cap first (see `chunking-and-ingestion.md`); over-long input truncates silently. |
| Letting an embed error throw and 500 the request. | Catch → return `null` → treat as MISS → run the live path (the cache is fail-open). Don't pause the cache on an embed error. |
| Upgrading to `-3-large` because "bigger is better." | Run recall@k on real queries first; -small is usually enough and 5× cheaper. |

---

## 10. Mental checklist before shipping embedding code

1. **One space:** every vector in a given column comes from the same model at the same dimension.
2. **Metric matches index:** cosine (`<=>`) for text here; the index/column is cosine-configured.
3. **Threshold compares the right way:** `distance <= cutoff` (smaller closer), tuned on real logs.
4. **Query vs corpus:** the query is embedded per request; the corpus is embedded once at ingest
   (`embedMany`), persisted, reused.
5. **Fail-open:** an embed failure is a MISS/no-op, never a 500, never a cache pause.
6. **Migration awareness:** if you're changing the model or dims, you've planned a full re-embed +
   a new column (see `pgvector-and-postgres.md`).
7. **Gotchas:** new backend files need a full dev-server restart (Bun `--hot` misses them); relative
   imports carry explicit `.js`.
