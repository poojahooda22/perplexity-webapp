# Semantic-Answer Cache vs Knowledge-RAG — two systems people confuse

> The one distinction that decides every "should we add RAG?" conversation: a semantic-answer
> cache stores **whole finished ANSWERS** keyed by query embedding and replays them to skip work
> (an *optimization*); knowledge-RAG retrieves **knowledge CHUNKS** to ground a *fresh* generation
> (a *capability*). Same primitives (embeddings, cosine, a vector column), opposite goals and
> opposite failure modes. Read this BEFORE proposing "let's add RAG" or calling the current cache
> "RAG". Lumina ships the answer-cache today (in [`backend/index.ts`](../../../../backend/index.ts));
> it has no knowledge-RAG yet. Adjacent refs: `lumina-semantic-cache.md` (how the cache works in
> code), `chunking-and-ingestion.md` + `retrieval-and-reranking.md` (the RAG mechanics),
> `lumina-knowledge-rag-design.md` (the concrete plan to add RAG here), `cache-freshness-and-invalidation.md`
> (TTL/exclusion).

---

## 1. The two systems on one slide

| | **Semantic-answer cache** (have) | **Knowledge-RAG** (don't have) |
|---|---|---|
| **What's stored** | Whole finished answers + their sources/images | Document **chunks** of a corpus |
| **What the embedding keys** | The *query* | The *content* (each chunk) |
| **Retrieval returns** | One answer to **replay verbatim** | k chunks to **feed the LLM** |
| **Then what** | Stream stored bytes; **no LLM call** | LLM generates a NEW answer grounded in chunks |
| **Goal** | Skip work — latency + cost | Add knowledge the model lacks; reduce hallucination |
| **Nature** | Optimization (removable; product still works) | Capability (removing it removes an answer source) |
| **Hit semantics** | "Someone already asked this" | "Here are the facts to answer this" |
| **Freshness risk** | Replaying a STALE answer | Retrieving a STALE/wrong chunk |
| **Coverage** | Only previously-asked questions | Anything in the corpus, even first-asked |
| **Threshold tuning** | Strict (`<= 0.15`) — only near-identical | Loose top-k — gather *candidates*, then rerank |

Mnemonic: the **cache** answers "have we *answered* this before?"; **RAG** answers "what do we
*know* that's relevant?" One returns prose to ship; the other returns evidence to reason over.

---

## 2. What Lumina actually has (the cache)

The "Vector / semantic-cache layer" block in [`backend/index.ts`](../../../../backend/index.ts)
(the `embedQuery` → `findCachedAnswer` → `cacheAnswer` trio) is a textbook **answer cache**:

```
/perplexity_ask (Discover)            ── the answer-cache path ──
  embed query  (embedQuery)           → openai/text-embedding-3-small, 1536 dims
  cosine <=> lookup (findCachedAnswer) → WHERE model = ? AND created_at > cutoff
  distance <= DISTANCE_THRESHOLD (0.15)?
    HIT  → res.write(cached.answer) + tail   ← NO Tavily, NO LLM. sub-second.
    MISS → webSearch → classify → streamText → cacheAnswer (only finishReason==="stop")
```

It stores the *answer*, replays the *answer*, and on a hit makes **zero** model calls
(`if (cached) { … res.write(cached.answer) … return; }` in `/perplexity_ask`). That is an
optimization, not retrieval-augmented generation. Calling it RAG is the single most common
mislabel — see the anti-patterns table.

Tells that prove it's a cache, not RAG, in this codebase:
- The embedding keys the **query**, and the row also stores the full `answer`/`sources`/`images`
  (`cacheAnswer` INSERT into `cached_query`).
- A hit **returns instead of generating** (the `return;` after the replay).
- Strict threshold `DISTANCE_THRESHOLD = 0.15` — designed so only the *same question* matches
  ("learn React" vs "learn React Native" correctly MISS; see the comment at the threshold).
- Time-sensitive + attachment queries are **excluded entirely** (`cacheable = !isTimeSensitive(query) && parts.length === 0`) — you'd never exclude knowledge from RAG, only a stale *answer* from a cache.

---

## 3. What knowledge-RAG would do instead

RAG never replays a stored answer. It retrieves *raw material* and asks the model to write a fresh,
grounded answer:

```
question
  embed question
  cosine top-k over a CHUNK table (the corpus, not past answers)
  rerank the candidates (cross-encoder / LLM judge)            ← optional but production-default
  build a prompt: question + the k chunks (with source ids)
  streamText → a NEW answer that CITES [n] the chunks
```

Key differences from the cache, mechanically:
- Retrieval is **loose then refined**: pull k=20–50 candidates with a generous threshold, then
  *rerank* down to the best 3–8. The cache's job is the opposite — one strict near-identical hit.
- The result is **input to generation**, never the output. Every RAG answer still pays for an LLM
  call; the win is *grounding*, not *skipping*.
- Chunks carry **source metadata** so the answer can cite — reuse Lumina's existing `[n]` /
  `<SOURCES>` wire format (owned by **research-agent**) for *internal* chunks.

The right shape on this stack is a **retrieval TOOL** the agent calls at inference (like the
finance `getQuote`/`financeWebSearch` tools), not a blind pre-search stuffed into the prompt — so
the model decides *when* it needs corpus knowledge and grounds on demand. Full plan in
`lumina-knowledge-rag-design.md`.

---

## 4. When each wins (decision framework)

Answer these in order; the first "yes" picks the tool.

```
Is the query TIME-SENSITIVE or its answer dependent on an upload/thread?
  └─ yes → NEITHER caches it (cache excludes it; RAG over a static corpus won't have it).
           Go live (Tavily/tools) every time.   [Lumina: isTimeSensitive + parts gate]
  └─ no ↓
Does answering need FACTS the base model lacks (your docs, policies, product KB, private data)?
  └─ yes → KNOWLEDGE-RAG. The model can't memorize your corpus; retrieve + ground + cite.
  └─ no ↓
Do MANY users ask the SAME stable question, and a fresh answer is expensive (web search + premium LLM)?
  └─ yes → SEMANTIC-ANSWER CACHE. Compute once, replay to everyone.   [Lumina today]
  └─ no  → just answer live; a cache with no repeat traffic is pure overhead.
```

| Symptom / requirement | Reach for |
|---|---|
| "The same FAQ is answered 1,000×/day and it's slow + costly" | Answer cache |
| "Answers must reflect OUR documents / policies / product, which the model doesn't know" | Knowledge-RAG |
| "Users phrase it differently but mean the same thing, and the answer is stable for days" | Answer cache (semantic, not exact-match) |
| "Every question is unique; nothing repeats" | Neither — go live |
| "We must show *where* each fact came from (provenance/citations)" | Knowledge-RAG (cite chunks) |
| "The data changes by the minute (prices, scores, news)" | Neither vector path — live fetch (finance tools / Tavily) |
| "Cheap to answer but we want to dodge repeated paid web searches" | Answer cache |

They are **not** an either/or for a product — see §6, they coexist.

---

## 5. Failure modes (and the guard for each)

| Failure | Cache | RAG | Guard |
|---|---|---|---|
| **Stale freshness** | Replaying yesterday's answer to "latest X" | Retrieving an out-of-date chunk | Cache: `isTimeSensitive` exclusion + `CACHE_TTL_DAYS` cutoff. RAG: re-ingest on doc change; store `updatedAt`, filter/boost by recency |
| **Cross-key bleed** | Serving a Haiku answer to an Opus request | Mixing tenants'/verticals' chunks | Cache: `WHERE model = ${model}`. RAG: filter chunks by tenant/vertical metadata |
| **Threshold too loose** | False HIT → wrong question's answer shipped whole | False chunk → grounds answer on irrelevant text | Cache: strict `<= 0.15`, tuned on real logs. RAG: rerank after a loose recall; drop low-rerank-score chunks |
| **Threshold too strict** | Never hits → no savings | Misses the relevant chunk → model falls back to (possibly wrong) memory | Cache: relax slowly while watching false hits. RAG: raise k + add hybrid (vector + FTS) recall |
| **Poisoning** | One truncated/errored answer cached → served for the whole TTL | One bad chunk retrieved repeatedly | Cache: only store `finishReason === "stop"` + non-empty. RAG: validate/clean at ingest; let rerank demote noise |
| **Infra fault** | DB down breaks the request | Vector store down breaks the answer | BOTH must be **fail-open**: catch → MISS → live path. Lumina's `embedQuery`/`findCachedAnswer`/`cacheAnswer` each `try/catch → null`/no-op; `noteCacheError` only pauses on `42P01` |
| **Dim mismatch** | Querying with a model whose dims ≠ the column | same | Lock embedding-model ↔ dims ↔ column (`text-embedding-3-small` → 1536 → `vector(1536)`); a model change = new column + full re-embed |
| **Silent hallucination** | n/a (replays real prose) | Model ignores chunks and invents | RAG: instruct "answer ONLY from the provided context; if absent, say so" + cite; measure groundedness |

The asymmetry to internalize: a **cache** false-hit ships a *fully wrong answer* with full
confidence (worst case is silent); a **RAG** false-retrieval just hands the model weaker evidence,
which a well-instructed prompt can still flag as insufficient. That's why the cache uses a strict
threshold and the answer-cleanliness gate, while RAG uses loose recall + rerank.

---

## 6. Why they coexist (not a migration — a stack)

Adding knowledge-RAG does **not** retire the answer cache. They sit at different layers and the
ideal request uses both:

```
request
  ├─ 1. SEMANTIC-ANSWER CACHE  → HIT? replay, done.            (skip everything below)
  └─ MISS
       ├─ 2. KNOWLEDGE-RAG retrieve  → ground the generation on corpus chunks
       ├─ 3. (+ live web search / tools for fresh facts)
       └─ 4. generate a fresh, cited answer  → then CACHE it (step 1 for the next caller)
```

The cache wraps the *whole* pipeline (including a RAG step) — it caches the final answer regardless
of how that answer was produced. So a future RAG-grounded answer to a stable question would still
be cached and replayed, and the *next* identical question skips both the retrieval and the LLM.
They compound:

- **Cache** removes repeat *cost* (no Tavily, no LLM, no retrieval on a hit).
- **RAG** removes *ignorance* (the model can answer from your corpus on a miss).

The only place they must NOT both run is the time-sensitive lane (prices/news), which already
bypasses the cache and is served by live tools (the finance vertical takes a separate branch in
`index.ts` with **no semantic cache** at all).

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Calling the `index.ts` answer-cache "RAG". | It caches whole ANSWERS to skip work; RAG retrieves CHUNKS to ground a FRESH generation. Use the right word — it changes the design conversation. |
| "We need RAG" when the real need is "the same FAQ is slow + costly." | That's a **cache** problem. Add/extend the semantic-answer cache; don't build an ingestion pipeline you don't need. |
| "Just cache it" when the model lacks the *facts* (your docs/policies). | A cache only helps the *second* asker of an *already-answered* question. First-ask coverage of private knowledge needs **RAG**. |
| Reusing the strict cache threshold (`0.15`) for RAG retrieval. | RAG wants **loose recall then rerank** (k=20→rerank→top 5), not a single near-identical hit. Different threshold philosophy. |
| Embedding the *answer* for a RAG corpus. | RAG embeds the **chunk content** (what you search over). The cache embeds the **query**. Don't cross them. |
| Building RAG as a blind pre-search injected into every prompt. | Expose retrieval as a **tool** the agent calls when it needs corpus knowledge (like the finance tools) — it grounds + cites on demand, and skips retrieval when unneeded. |
| Caching a stale answer to "today's …" because the embedding matched. | Gate with `isTimeSensitive`; time-sensitive + attachment queries skip the cache entirely (read AND write). Serve live. |
| Letting RAG retrieval or the cache throw and fail the request. | **Fail-open** on both: catch → degrade to MISS / live path. The retrieval layer must be invisible when broken. |
| Caching a truncated/errored stream, then replaying it for the TTL. | Only store on `finishReason === "stop"` + non-empty. (No equivalent risk for RAG, since it never replays stored prose.) |
| Replacing the cache with RAG ("RAG is the upgrade"). | They're orthogonal layers. Keep the cache in front of the RAG-grounded generation; both compound. |
| Skipping citations on RAG answers because "it's our own data." | Internal facts still need provenance. Reuse the `[n]`/`<SOURCES>` wire format so users (and you) can trace every claim. |

---

## 8. Quick reference — same primitives, different config

| Knob | Answer cache (Lumina) | Knowledge-RAG (target) |
|---|---|---|
| Embedding input | the user query | each document chunk |
| Embedding model / dims | `text-embedding-3-small` / 1536 | same family; can differ — but lock to its column |
| Vector store | `cached_query.embedding vector(1536)` (Supabase pgvector) | a new `chunk` table, pgvector, ivfflat/hnsw |
| Distance | cosine `<=>` | cosine `<=>` |
| Threshold | strict `<= 0.15` (near-identical only) | loose recall + rerank |
| k | 1 (best single answer) | 20–50 candidates → rerank → 3–8 |
| Extra filters | `model`, `created_at > cutoff` | tenant/vertical, recency, source-type |
| On hit | replay verbatim, no LLM | feed chunks to LLM, generate + cite |
| Write path | `cacheAnswer` (clean finish only) | ingestion pipeline (chunk → embed → upsert) |
| Failure stance | fail-open (cache is optional) | fail-open (fall back to live/model memory) |

Bottom line: the embedding + cosine + pgvector machinery is shared, so RAG *feels* like "more of
the cache" — but the data stored, the threshold philosophy, the on-hit behavior, and the goal are
all inverted. Decide which problem you're solving (skip work vs. add knowledge) and the rest
follows.
