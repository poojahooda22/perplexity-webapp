# Lumina's Semantic-Answer Cache — the pgvector replay path in `index.ts`

> The exact wiring of the semantic-answer cache: `embedQuery` → `findCachedAnswer`
> (cosine `<=>`, model-keyed, TTL'd) → replay, and `cacheAnswer` on a clean finish — all
> fail-open, with a `42P01` self-heal cooldown. `lumina-` ref = THIS codebase; read it before
> you touch the cache block in [`backend/index.ts`](../../../../backend/index.ts) (line numbers
> drift — verify against the live file). Adjacent refs: **`cache-freshness-and-invalidation.md`**
> owns TTL/the `TIME_SENSITIVE` regex/when-to-bypass; **`pgvector-and-postgres.md`** owns the
> column type / index / `$queryRaw` mechanics; **`embeddings-fundamentals.md`** owns what an
> embedding *is*; **`semantic-cache-vs-knowledge-rag.md`** owns why this is NOT RAG.

The one thing to never lose: this cache stores **whole answers** keyed by query embedding to
**skip work** (Tavily + LLM). It is a pure optimization. Every function returns `null`/no-ops on
any error so the live path always runs. If you ever make a cache fault break a request, you've
broken the contract.

---

## 1. Where it lives & what it is

| Piece | Location | Role |
|---|---|---|
| The cache block | [`backend/index.ts`](../../../../backend/index.ts) — the "Vector / semantic-cache layer" comment block (around index.ts:375) | All four functions below |
| `CachedQuery` model | [`backend/prisma/schema.prisma`](../../../../backend/prisma/schema.prisma) (`model CachedQuery`, schema.prisma:58) | Drives the migration; the table is read/written by raw SQL |
| `embed` import | [`backend/index.ts`](../../../../backend/index.ts):3 — `import { streamText, embed, … } from 'ai'` | Vercel AI SDK embedding call, routed via the AI Gateway |
| Consumption site | `/perplexity_ask` Discover branch (index.ts:666–734) | The only caller — finance/assistant verticals skip it |

The cache is a **GLOBAL** table (shared across all users) of answered Discover queries. On each
`/perplexity_ask` for the Discover vertical, Lumina embeds the query, looks for a close-enough,
non-stale row answered by the **same model**, and replays it verbatim instead of paying for a
fresh search + generation.

---

## 2. The four functions (the whole mechanism)

```
/perplexity_ask (Discover branch, index.ts)
  ├─ cacheable = !isTimeSensitive(query) && parts.length === 0   // gate FIRST
  ├─ embedding = cacheable ? await embedQuery(query) : null      // Step A
  ├─ cached    = cacheable ? await findCachedAnswer(embedding, model) : null  // Step B
  │
  ├─ if (cached)  → res.write(answer); res.write(tail); persist; res.end()    // HIT: replay
  │
  └─ else  → webSearch → streamText → stream tokens
            └─ if (cacheable && finishReason==="stop" && fullAnswer.trim())
                   await cacheAnswer({...})                                    // Step C: store
```

### Step A — `embedQuery(query)` → `number[] | null`  (index.ts:430)
```ts
async function embedQuery(query: string): Promise<number[] | null> {
    if (cacheDown()) return null;
    try {
        const { embedding } = await embed({ model: "openai/text-embedding-3-small", value: query });
        return embedding;
    } catch (e) { /* log */ return null; }   // an embed failure is just a MISS — never pauses the cache
}
```
- Bare string model id `"openai/text-embedding-3-small"` → routed through the **Vercel AI
  Gateway**, exactly like the chat models. 1536-dim output.
- A failed embed call returns `null`, which makes both `findCachedAnswer` and `cacheAnswer`
  no-op (they guard `if (!embedding)`). It does **not** call `noteCacheError` — embed failures
  are not infra faults, so they must not trip the cooldown.

### Step B — `findCachedAnswer(embedding, model)` → `{answer, sources, images} | null`  (index.ts:444)
```ts
const vec = `[${embedding.join(",")}]`;
const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
const rows = await prisma.$queryRaw<…>`
    SELECT answer, sources, images, (embedding <=> ${vec}::vector) AS distance
    FROM cached_query
    WHERE model = ${model} AND created_at > ${cutoff}
    ORDER BY embedding <=> ${vec}::vector
    LIMIT 1
`;
const hit = rows[0];
if (hit && hit.distance <= DISTANCE_THRESHOLD) return { answer, sources, images };
return null;
```
- `<=>` is pgvector's **cosine distance** operator: `0` = identical, `2` = opposite. Smaller is
  closer. The column/index must be cosine-configured for `<=>` to mean cosine.
- Two filters in SQL, not in app code: `WHERE model = ${model}` (keying) and
  `created_at > ${cutoff}` (TTL). `ORDER BY … LIMIT 1` returns the single nearest row; the
  threshold check (`hit.distance <= DISTANCE_THRESHOLD`) decides HIT vs MISS in JS.
- On any error → `noteCacheError("findCachedAnswer", e)` → `return null` (MISS).

### Step C — `cacheAnswer({query, embedding, model, answer, sources, images})` → `void`  (index.ts:475)
```ts
if (!p.embedding || cacheDown()) return;
const vec = `[${p.embedding.join(",")}]`;
await prisma.$executeRaw`
    INSERT INTO cached_query (id, query_text, model, embedding, answer, sources, images, created_at)
    VALUES (${crypto.randomUUID()}, ${p.query}, ${p.model}, ${vec}::vector,
            ${p.answer}, ${JSON.stringify(p.sources)}::jsonb, ${JSON.stringify(p.images)}::jsonb, NOW())
`;
```
- Stores `query_text` (debug/inspection only — never used for matching), `model` (the other half
  of the key), the embedding `::vector`, the full answer text, and `sources`/`images` as `jsonb`
  so a HIT can rebuild the **exact same wire tail** a live answer produces.
- On any error → `noteCacheError("cacheAnswer", e)` and silently return. A failed write must
  never break the request whose answer already streamed.

### The self-heal — `noteCacheError` / `cacheDown`  (index.ts:412/415)
```ts
let cacheDownUntil = 0;
function cacheDown() { return Date.now() < cacheDownUntil; }
function noteCacheError(where, e) {
    const code = (e as { code?: string })?.code;
    if (code === "42P01") {                       // Postgres undefined_table ONLY
        cacheDownUntil = Date.now() + CACHE_COOLDOWN_MS;   // pause 60s, then re-probe
        return;
    }
    console.error(`[semantic-cache] ${where} failed:`, …);   // any other error: log, don't latch
}
```
- Only a real **`42P01` (undefined_table)** — the migration hasn't run yet — pauses the cache,
  and only for `CACHE_COOLDOWN_MS` (60s). After that `cacheDown()` returns false again and the
  cache re-probes. So creating the table makes the cache come back **with no restart**.
- It checks the structured Postgres error **code**, never a free-text substring. This is
  deliberate: the AI Gateway returns *"model does not exist…"* for credential problems — a
  free-text `"does not exist"` match would mistake that for a DB fault and wrongly pause the cache.

---

## 3. Tunables

| Constant | Value | Meaning | How to change it |
|---|---|---|---|
| `DISTANCE_THRESHOLD` | `0.15` (index.ts:395) | Max cosine distance for a row to count as the SAME question. Lower = stricter. | Tune against **real query logs**, not vibes. Confirm at least one near-miss pair MISSES — e.g. "learn React" vs "learn React Native" must sit ABOVE 0.15. |
| `CACHE_TTL_DAYS` | `7` (index.ts:396) | Rows older than this are ignored (the `created_at > cutoff` filter). | Lower for faster-moving content; the `TIME_SENSITIVE` gate already excludes the truly volatile. |
| `CACHE_COOLDOWN_MS` | `60_000` (index.ts:400) | How long the cache pauses after a `42P01`, before re-probing. | Rarely changed; long enough to avoid log spam, short enough to self-heal fast. |
| `TIME_SENSITIVE` | regex (index.ts:404) | Queries that NEVER touch the cache (read or write). | Owned by `cache-freshness-and-invalidation.md`; add patterns there. |

---

## 4. The cacheability gate (read AND write)

The cache is bypassed *entirely* — no embed, no read, no write — for two query classes, decided
**before** any work (index.ts:671):
```ts
const cacheable = !isTimeSensitive(query) && parts.length === 0;
```
| Excluded class | Why | Where |
|---|---|---|
| **Time-sensitive** (`today/now/latest/price/news/202\d/…`) | A stale cached price or "latest news" is the worst failure. | `isTimeSensitive` / `TIME_SENSITIVE` (index.ts:404) |
| **Attachment queries** (`parts.length > 0`) | The answer depends on the uploaded file; the query text alone is the wrong key. | `buildAttachmentParts(req.body.attachments)` (index.ts:670) |

Other verticals never reach the cache at all: the **finance** and **assistant** branches return
early (index.ts:638, 652) — they fetch their own live data via tools — and
**`/perplexity_ask/follow_up`** is uncached by design (a follow-up's meaning depends on the whole
thread, so a key on the latest query alone would replay a wrong answer; index.ts:756).

---

## 5. The clean-finish write rule

A row is stored **only** when all three hold (index.ts:732):
```ts
if (cacheable && finishReason === "stop" && fullAnswer.trim()) {
    await cacheAnswer({ query, embedding, model, answer: fullAnswer, sources, images });
}
```
- `finishReason` is read defensively: `try { finishReason = await result.finishReason } catch { finishReason = "error" }`
  (index.ts:721) — a stream that breaks reports `"error"`, never `"stop"`.
- A truncated, aborted (client disconnect), or empty generation is **never** cached. Caching one
  poisons every near-duplicate query for the full 7-day TTL.
- `cacheAnswer` runs **after** `persistTurns` and **before** `res.end()` — on Vercel the instance
  can freeze the instant the response closes, so any DB write after `res.end()` may never run.

---

## 6. HIT replay = identical wire format

A HIT must be indistinguishable from a live answer to the client (index.ts:677):
```ts
const tail = sourcesImagesTail(cached.sources, cached.images);
res.write(cached.answer);
res.write(tail);
await persistTurns(persistUserTurn, conversation.id, cached.answer, tail);
res.end();
```
The same `sourcesImagesTail()` (index.ts:142) builds the `<SOURCES>`/images tail for both the HIT
path and the live MISS path, so the frontend handles both with one code path. A HIT skips **both**
Tavily and the LLM → sub-second response. The stored answer is still persisted as a real
conversation turn.

---

## 7. The `CachedQuery` model & raw-SQL discipline

```prisma
model CachedQuery {
  id        String                      @id @default(uuid())
  queryText String                      @map("query_text")
  model     String                                            // cache is keyed on (embedding, model)
  embedding Unsupported("vector(1536)")                       // 1536 = text-embedding-3-small
  answer    String
  sources   Json
  images    Json
  createdAt DateTime                    @default(now())       @map("created_at")
  @@map("cached_query")
}
```
- `embedding Unsupported("vector(1536)")` — the `vector` type is **not** in Prisma's typed client.
  The model exists "mainly to drive the migration"; every read/write goes through
  `$queryRaw`/`$executeRaw` with a `::vector` literal built as `[${arr.join(",")}]`.
- `1536` is locked to `text-embedding-3-small`. The model, the dimension, and the column are one
  unit: change the embedding model and you need a **new column + a full re-embed** — never mix
  dimensions in one column. (Index/extension mechanics: see `pgvector-and-postgres.md`.)
- pgvector is enabled in **Supabase directly** (`CREATE EXTENSION vector`); the datasource block
  deliberately omits `extensions = [...]` so Prisma doesn't flag Supabase's own extensions as
  drift and threaten a destructive reset (schema.prisma:18 comment).

---

## 8. Decision framework — touching the cache

```
Change involves the semantic cache?
|
+-- New query class shouldn't be cached? ----> add to TIME_SENSITIVE / extend the `cacheable`
|     (volatile, personalized, file-dependent)   gate. Bypass means NO read AND NO write.
|
+-- Hits feel wrong / too loose or too tight? -> tune DISTANCE_THRESHOLD against real logs;
|                                                 prove a near-miss pair still MISSES.
|
+-- Switching embedding model? ---------------> NEW column sized to the new dims + re-embed the
|                                                 whole table. Never mix dims. (pgvector ref.)
|
+-- New error surfaced from Postgres? --------> handle the CODE in noteCacheError; only pause on
|                                                 42P01. Never free-text "does not exist".
|
+-- Want to ground a FRESH answer on docs? ---> that's NOT this cache — it's knowledge-RAG.
                                                  See semantic-cache-vs-knowledge-rag.md +
                                                  lumina-knowledge-rag-design.md.
```

---

## 9. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Letting a cache error (DB down, embed 500, table missing) bubble up and 500 the request. | Fail-open everywhere: catch → `return null`/no-op → run the live path. The cache is invisible when broken. |
| Serving a HIT across models ("an answer is an answer"). | Key on `(embedding, model)`: `WHERE model = ${model}` on read, store `model` on write. Different models give different answers. |
| Caching a "today's price / latest news" query because the embedding matched something. | Gate with `isTimeSensitive` BEFORE embedding; time-sensitive + attachment queries skip read AND write. |
| Caching a stream that was cut short / errored / empty, then replaying it for 7 days. | Only `cacheAnswer` when `finishReason === "stop"` AND `fullAnswer.trim()` is non-empty. |
| Treating `<=>` as cosine *similarity* and filtering `>= threshold`. | `<=>` is cosine *distance* (0 = best). Filter `distance <= DISTANCE_THRESHOLD`; smaller is closer. |
| Picking `DISTANCE_THRESHOLD` by feel and shipping it. | Tune against real logs; confirm a deliberate near-duplicate (React vs React Native) correctly MISSES. |
| Permanently disabling the cache on the first DB error (the old latch). | Short cooldown + re-probe; only `42P01` trips it; self-heals after the migration with no restart. |
| Free-text matching `"does not exist"` to detect a missing table. | Check the Postgres error **code** `42P01`. The Gateway's *"model does not exist"* is NOT a DB fault. |
| Pushing the embedding through Prisma's typed client. | All vector I/O via `$queryRaw`/`$executeRaw` with a `::vector` literal from `[${arr.join(",")}]`. |
| Embedding/querying with one model's dims against a column sized for another. | Lock model ↔ dims ↔ column (`text-embedding-3-small` ↔ 1536 ↔ `vector(1536)`). New model = new column + re-embed. |
| Caching follow-ups, or finance/assistant turns, "to save tokens". | They're uncached by design — follow-ups depend on the thread; finance/assistant fetch live data via tools. |
| Calling this "RAG". | It caches whole ANSWERS to skip work. RAG retrieves CHUNKS to ground a FRESH generation. See `semantic-cache-vs-knowledge-rag.md`. |

---

## 10. Verify a cache change

1. **Fail-open:** point the DB at a dead host (or drop the table) → a Discover query still
   answers via the live path; logs show `[semantic-cache] … failed`, no 500.
2. **HIT:** ask a non-time-sensitive question twice with the same model → the second returns
   sub-second and replays the **same** wire tail (`sourcesImagesTail`) as the first.
3. **Model keying:** ask the same question on two different models → two separate rows; neither is
   served the other's answer.
4. **Threshold:** ask a near-duplicate ("learn React" after "learn React Native") → confirm a
   MISS (distance above 0.15).
5. **Self-heal:** drop `cached_query`, fire a query (cache pauses ~60s), recreate the table → the
   cache re-enables on the next request with **no restart**.
6. **Clean-finish:** abort a stream mid-answer (disconnect) → no row written for that query.
7. **Stack hygiene:** new backend files need a **full** dev-server restart (Bun `--hot` misses
   them); relative imports carry explicit `.js`. `prisma db push` uses the Supabase **session**
   pooler (5432), not the transaction pooler (6543).
