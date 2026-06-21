# pgvector & Postgres — the vector storage layer in this stack

> How Lumina stores and queries embeddings: the `vector(1536)` column on `cached_query`, the
> `<=>` cosine operator, `$queryRaw`/`$executeRaw` with a `::vector` literal, why the vector
> type lives OUTSIDE Prisma's typed client, and how the extension + table get created on
> Supabase (NOT by a Prisma migration). `lumina-` ref = THIS codebase; line numbers drift, so
> cite the named function and re-grep before you change.
>
> **Read this when:** adding/altering a vector column, writing a similarity query, choosing or
> building an index (`ivfflat`/`hnsw`), or debugging a `42P01`/dimension/operator error.
> **Adjacent refs:** `embeddings-fundamentals.md` (what the 1536-dim vector *is*, cosine vs dot,
> the embedding model), `lumina-semantic-cache.md` (the full read→replay→write flow in
> `index.ts`), `cache-freshness-and-invalidation.md` (TTL + time-sensitive exclusion). This ref
> owns the **Postgres/pgvector mechanics only**.

Files: `CachedQuery` model in
[`backend/prisma/schema.prisma`](../../../../backend/prisma/schema.prisma) (the `datasource` note
+ the `Unsupported("vector(1536)")` column), `findCachedAnswer` / `cacheAnswer` / `embedQuery` in
[`backend/index.ts`](../../../../backend/index.ts) (the "Vector / semantic-cache layer" block),
the Prisma client + pg adapter in [`backend/db.ts`](../../../../backend/db.ts).

---

## 1. What pgvector is, in one paragraph

pgvector is a Postgres **extension** that adds a `vector` column type, three distance operators,
and two ANN index types. Supabase ships it; you turn it on with `CREATE EXTENSION vector`. Once on,
a column declared `vector(N)` stores an N-dimensional float array, and `a <=> b` returns the
**cosine distance** between two such vectors as a normal scalar you can `ORDER BY`, `SELECT`, and
filter on. Everything else in this doc is plumbing around that one capability.

In Lumina there is exactly **one** vector column today: `cached_query.embedding`, a `vector(1536)`
holding the `text-embedding-3-small` embedding of a past `/perplexity_ask` query. It is the key of
the semantic-answer cache, nothing else.

---

## 2. The column: `vector(1536)` via `Unsupported(...)`

In [`schema.prisma`](../../../../backend/prisma/schema.prisma), `CachedQuery`:

```prisma
model CachedQuery {
  id        String                      @id @default(uuid())
  queryText String                      @map("query_text")
  model     String                                            // cache keyed on (embedding, model)
  embedding Unsupported("vector(1536)")                       // 1536 = text-embedding-3-small
  answer    String
  sources   Json
  images    Json
  createdAt DateTime                    @default(now())       @map("created_at")
  @@map("cached_query")
}
```

Three things that matter:

| Detail | Why |
|--------|-----|
| `Unsupported("vector(1536)")` | Prisma has no native `vector` scalar, so it's declared as an `Unsupported` raw column type. Prisma will create/track the column but **cannot read or write it through the typed client** — `prisma.cachedQuery.findMany()` simply omits the field. All vector I/O is raw SQL (§4). |
| The literal `1536` is locked to the embedding model | `text-embedding-3-small` emits 1536 dims. The column width, the embedding model, and the dims are **one decision** — change one and you change all three. A 1536-vec cannot be `<=>`-compared against a column sized differently; Postgres throws `different vector dimensions`. New model ⇒ new column + full re-embed (see Non-Negotiable #7 in SKILL.md). |
| `@@map("cached_query")` / `@map("created_at")` | The SQL identifiers are snake_case; the raw queries in `index.ts` use the **mapped** names (`cached_query`, `created_at`), not the Prisma camelCase. Get this wrong and you get a `42P01` / `column does not exist`. |

`CachedQuery` "exists mainly to drive the migration" — the schema comment says so. Its job is to
make the table appear in the schema graph; the *vector behavior* is hand-written SQL.

---

## 3. The three distance operators — and which one we use

| Operator | Distance | Use when the embeddings are… | Lumina |
|----------|----------|------------------------------|--------|
| `<=>` | **cosine** | direction matters, magnitude doesn't (normalized text embeddings) | ✅ this is what we use |
| `<->` | L2 / Euclidean | absolute position matters | no |
| `<#>` | negative inner product | already-normalized + you want raw dot | no |

`text-embedding-3-small` returns near-unit-norm vectors, so **cosine** is the correct choice and
`<=>` is the operator throughout `findCachedAnswer`. Cosine **distance** semantics:

- `0` = identical direction (same question)
- `1` = orthogonal (unrelated)
- `2` = opposite

So **smaller is closer**, and the filter is `distance <= DISTANCE_THRESHOLD` (0.15) — never
`>= threshold`. Treating `<=>` as a *similarity* score (where bigger is better) is a classic bug;
see the anti-pattern table.

> `<=>` returns cosine distance **only because we treat the column as cosine**. The operator is
> dimension-agnostic; it does not know what the embedding model intended. If you ever switch to an
> index, the index must be created with the matching ops class (`vector_cosine_ops`, §6) or the
> planner won't use it and you silently fall back to a full scan.

---

## 4. Raw vector I/O — `$queryRaw` / `$executeRaw` with a `::vector` literal

Because the typed client can't touch the column, **every** vector read/write goes through raw SQL.
The pattern (build a Postgres array literal string, cast it to `::vector`):

**Read** — `findCachedAnswer` in [`index.ts`](../../../../backend/index.ts):

```ts
const vec = `[${embedding.join(",")}]`;            // "[0.0123,-0.045,…]" — a bracketed list
const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
const rows = await prisma.$queryRaw<
  Array<{ answer: string; sources: unknown; images: unknown; distance: number }>
>`
  SELECT answer, sources, images, (embedding <=> ${vec}::vector) AS distance
  FROM cached_query
  WHERE model = ${model} AND created_at > ${cutoff}
  ORDER BY embedding <=> ${vec}::vector
  LIMIT 1
`;
const hit = rows[0];
if (hit && hit.distance <= DISTANCE_THRESHOLD) { /* replay */ }
```

**Write** — `cacheAnswer` in [`index.ts`](../../../../backend/index.ts):

```ts
const vec = `[${p.embedding.join(",")}]`;
await prisma.$executeRaw`
  INSERT INTO cached_query (id, query_text, model, embedding, answer, sources, images, created_at)
  VALUES (
    ${crypto.randomUUID()}, ${p.query}, ${p.model},
    ${vec}::vector,                                  -- the array literal, cast to vector
    ${p.answer},
    ${JSON.stringify(p.sources)}::jsonb,
    ${JSON.stringify(p.images)}::jsonb,
    NOW()
  )
`;
```

The non-obvious rules baked into these two functions:

| Rule | Why |
|------|-----|
| Build the vector as a **string** `[${arr.join(",")}]`, then `${vec}::vector` | pgvector accepts a `text` literal cast to `vector`. You can't bind a JS `number[]` directly as a vector param; the tagged-template `${vec}` binds a *string* and the `::vector` cast in SQL parses it. |
| Use Prisma's **tagged-template** form (`$queryRaw\`…\``), not `$queryRawUnsafe` | The tagged form parameterizes `${vec}`, `${model}`, `${cutoff}` as bound params → SQL-injection-safe. The `::vector` / `::jsonb` casts are literal SQL, not interpolated values. Never string-concat user data into the SQL body. |
| `$queryRaw` for SELECT (returns rows), `$executeRaw` for INSERT (returns a count) | Mirror the two functions above; using the wrong one drops your result set. |
| Type the result rows explicitly (`$queryRaw<Array<{…}>>`) | Raw queries return `unknown`; the generic gives you a typed `rows[0]`. `distance` comes back as a JS `number`. |
| Put the **same** `<=>` expression in `SELECT … AS distance` and `ORDER BY` | You need the value (to threshold in JS) AND the ordering (to get the nearest first via `LIMIT 1`). Postgres computes it once per row either way. |
| Filter `WHERE model = ${model}` | Cache is keyed on **(embedding, model)** — never replay a budget-model answer for a premium request. The `<=>` finds the nearest *vector*; the `WHERE` scopes it to the right model. |

---

## 5. Prisma 7 specifics that bite here

This repo is Prisma 7 with the new `prisma-client` generator and a pg driver adapter — both visible
in [`db.ts`](../../../../backend/db.ts) and the generator block in
[`schema.prisma`](../../../../backend/prisma/schema.prisma).

```ts
// db.ts — driver-adapter client, NOT the legacy engine
import { PrismaClient } from "./prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

| Prisma 7 thing | Consequence for vector work |
|----------------|------------------------------|
| `provider = "prisma-client"` + `engineType = "client"` + `runtime = "nodejs"` | New generator; raw queries run through the **`@prisma/adapter-pg`** driver, not the Rust engine. `$queryRaw`/`$executeRaw` + `Unsupported` still behave the same, but the adapter is the thing actually talking to Postgres. |
| `importFileExtension = "js"` | The generated client emits `.js` import specifiers so Vercel's strict Node ESM resolver works (`.ts` would 404 at boot). Same reason your own relative imports need explicit `.js`. Unrelated to vectors directly, but it's why `db.ts` imports `client.js`. |
| Driver adapter ⇒ `DATABASE_URL` is the connection string | Vector queries inherit whatever pooler that URL points at. `prisma db push`/`migrate` hangs on Supabase's **transaction** pooler (6543) — use the **session** pooler (5432) for schema work. |
| `Unsupported(...)` columns | Confirmed unreadable via typed client in Prisma 7 too; raw SQL is the only path. Don't waste time trying `select: { embedding: true }`. |

---

## 6. Indexes: `ivfflat` vs `hnsw` (and why we have NEITHER yet)

**Today the cache has no vector index.** `findCachedAnswer` does a sequential scan + sort:
`ORDER BY embedding <=> $1 LIMIT 1` over every non-stale row for that model. At Lumina's current
row count (one row per distinct cached query, TTL-pruned to 7 days) that's fine — a few thousand
1536-d rows scan in single-digit ms. An index becomes worth it at ~10k+ rows or when p99 latency on
the lookup climbs. This is the **Tier-1** answer; state it honestly.

When you DO add one, choose:

| | `ivfflat` | `hnsw` |
|---|-----------|--------|
| Structure | Inverted file: clusters rows into `lists` centroids; probes `probes` nearest lists | Hierarchical navigable small-world graph |
| Build cost | Cheap & fast | Slower, more memory |
| Query speed/recall | Good; recall tunable via `probes` | Best recall-vs-speed; the modern default |
| **Needs data before building** | **Yes** — clusters are learned from existing rows; building on an empty/tiny table gives bad centroids | **No** — build any time |
| Tunables | `lists` (≈ rows/1000) at build; `SET ivfflat.probes` at query | `m`, `ef_construction` at build; `SET hnsw.ef_search` at query |
| Recommendation here | only if write-heavy + you accept rebuilds | **prefer `hnsw`** for the answer cache (read-heavy, low write rate, no rebuild dance) |

Both **must** be created with the cosine ops class to be used by our `<=>` queries:

```sql
-- HNSW (recommended when we index): cosine ops class MUST match the operator
CREATE INDEX cached_query_embedding_hnsw
  ON cached_query USING hnsw (embedding vector_cosine_ops);

-- IVFFlat alternative (build AFTER the table has representative rows):
CREATE INDEX cached_query_embedding_ivf
  ON cached_query USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
SET ivfflat.probes = 10;  -- per-session/transaction; trade recall for speed
```

The ops-class ↔ operator pairing: `vector_cosine_ops`→`<=>`, `vector_l2_ops`→`<->`,
`vector_ip_ops`→`<#>`. A mismatch means the planner ignores the index → silent full scan. After
creating any index, confirm with `EXPLAIN ANALYZE` on the actual `findCachedAnswer` query that it
shows an *Index Scan*, not a *Seq Scan*.

> Filtered ANN caveat: our query also has `WHERE model = ? AND created_at > ?`. ANN indexes search
> the vector space *first*, then post-filter — so a tight `WHERE` over a large table can return
> fewer than `LIMIT` rows past the filter. For the answer cache this is acceptable (a near-miss
> just becomes a cache MISS → live path). If you later need exact filtered-kNN at scale, add a
> btree on `(model, created_at)` and/or raise `ef_search`.

---

## 7. The migration: extension + table live in Supabase, NOT in Prisma

This is the single most surprising thing about this codebase's vector setup, and it's deliberate.

The committed migrations
([`backend/prisma/migrations/`](../../../../backend/prisma/migrations/)) create `User`,
`Conversation`, `Message` — but **NOT** `cached_query`, and they do **NOT** enable the extension.
The `datasource db` block in [`schema.prisma`](../../../../backend/prisma/schema.prisma) spells out
why:

```prisma
datasource db {
  provider = "postgresql"
  // pgvector is enabled directly in Supabase (Dashboard → Database → Extensions, or
  // `CREATE EXTENSION vector`). We deliberately do NOT let Prisma manage extensions
  // (`extensions = [...]`) — on Supabase that makes `prisma migrate dev` flag Supabase's
  // own pre-installed extensions as "drift" and threaten a destructive reset.
}
```

So the runtime setup that `index.ts` depends on is applied **out-of-band in Supabase**, roughly:

```sql
-- 1. enable the extension (Supabase: Dashboard → Database → Extensions → "vector", or:)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. create the table to match the CachedQuery model (snake_case mapped names!)
CREATE TABLE IF NOT EXISTS cached_query (
  id          uuid PRIMARY KEY,
  query_text  text NOT NULL,
  model       text NOT NULL,
  embedding   vector(1536) NOT NULL,
  answer      text NOT NULL,
  sources     jsonb NOT NULL,
  images      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 3. (optional, later) the HNSW cosine index from §6.
```

Consequences to internalize:

| Implication | Detail |
|-------------|--------|
| The runtime **self-heals** to this | If the table is missing, `findCachedAnswer`/`cacheAnswer` catch the Postgres `42P01` (undefined_table), `noteCacheError` pauses the cache for `CACHE_COOLDOWN_MS` (60 s), then re-probes — no restart needed once you run the `CREATE TABLE`. (Code: `noteCacheError` checks `e.code === "42P01"` only.) |
| `42P01` is the **only** error that pauses the cache | An embed failure or any other SQL error is just a MISS. Critically, the AI Gateway's "model does not exist" string must **not** be mistaken for a DB fault — that's why the code matches the error **code**, never free-text `"does not exist"`. |
| Never add `extensions = [...]` to the datasource | It would make `prisma migrate dev` treat Supabase's pre-installed extensions as drift and propose a destructive reset. (Listed as an anti-pattern in SKILL.md.) |
| Keep the SQL DDL in sync with the model by hand | Since Prisma doesn't own `cached_query`, schema drift between the model and the live table is on you. Match the mapped names exactly. |

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Treating `<=>` as cosine *similarity* and filtering `>= threshold`. | `<=>` is cosine **distance** (0 = identical). Filter `distance <= DISTANCE_THRESHOLD`; smaller is closer. |
| Trying to read/write `embedding` through the typed client (`select: { embedding: true }`). | The `Unsupported` column is invisible to the typed client. Use `$queryRaw`/`$executeRaw` with a `::vector` literal. |
| Binding a JS `number[]` directly as a vector param. | Build a string `[${arr.join(",")}]` and cast `${vec}::vector` in the SQL. |
| `$queryRawUnsafe` with string-concatenated query text. | Tagged-template `$queryRaw\`…\``: params are bound (injection-safe); only `::vector`/`::jsonb` casts are literal SQL. |
| Creating an `ivfflat`/`hnsw` index with the L2 ops class while querying with `<=>`. | Match ops class to operator: `vector_cosine_ops` ↔ `<=>`. Verify with `EXPLAIN ANALYZE` that an *Index Scan* is used. |
| Building an `ivfflat` index on an empty/tiny table. | `ivfflat` learns centroids from existing data — build it after representative rows exist, or use `hnsw` (no data needed, better recall). |
| Adding a vector index "for performance" before there's a row-count problem. | At a few-thousand TTL-pruned rows a seq-scan is fine. Add `hnsw` only when row count / p99 justifies it; measure first. |
| Adding `extensions = [...]` to the Prisma datasource to manage pgvector. | Enable `CREATE EXTENSION vector` in Supabase; Prisma managing it flags Supabase's own extensions as drift → destructive reset risk. |
| Changing the embedding model but keeping `vector(1536)`. | Dims are locked to the model. New model ⇒ new column sized to the new dims + a full re-embed; never mix dims in one column. |
| Using Prisma camelCase (`cachedQuery`, `createdAt`) inside the raw SQL. | Raw SQL uses the **mapped** DB names: `cached_query`, `created_at`, `query_text`. |
| Letting a vector-query error bubble up and 500 the request. | Every vector path is fail-open: catch → MISS/no-op → live Tavily+LLM path runs. The cache must be invisible when broken. |

---

## 9. Quick reference

```text
Column type ........ vector(1536)            (Unsupported in Prisma; raw SQL only)
Operator ........... <=>  cosine distance    (0 identical … 2 opposite; smaller = closer)
Threshold .......... distance <= 0.15        (DISTANCE_THRESHOLD; tune vs real logs)
Read ............... $queryRaw  + (embedding <=> ${vec}::vector) AS distance, ORDER BY …, LIMIT 1
Write .............. $executeRaw + ${vec}::vector  (vec = `[${arr.join(",")}]`)
Key ................ (embedding, model)       (WHERE model = ${model})
TTL ................ created_at > now()-7d    (CACHE_TTL_DAYS)
Index .............. none today; prefer hnsw (embedding vector_cosine_ops) when needed
Extension/table .... created in Supabase out-of-band; NOT a Prisma migration
Self-heal .......... 42P01 → 60s cooldown → re-probe (noteCacheError)
Prisma ............. v7 prisma-client generator + @prisma/adapter-pg (db.ts)
```
