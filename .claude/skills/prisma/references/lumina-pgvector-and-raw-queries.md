# lumina-pgvector-and-raw-queries

> How the `CachedQuery` / `cached_query` table stores `vector(1536)` embeddings, why Prisma's
> typed client cannot read or write that column, and the exact `$queryRaw` / `$executeRaw`
> patterns Lumina uses to do vector similarity search over the semantic cache.

---

## 1. The `CachedQuery` model and the `vector(1536)` column

```prisma
// backend/prisma/schema.prisma:52-69
// Semantic cache for /perplexity_ask. One row per answered query, keyed by the
// query's embedding. A new query is embedded and compared (cosine distance via
// pgvector's <=>) against these rows; a close-enough, non-stale row is replayed
// instead of paying for a fresh Tavily search + LLM generation.
// Accessed ONLY via $queryRaw/$executeRaw (the `embedding` vector type isn't part
// of Prisma's typed client), so this model exists mainly to drive the migration.
model CachedQuery {
  id        String                      @id @default(uuid())
  queryText String                      @map("query_text")
  model     String                      // cache is keyed on (embedding, model)
  embedding Unsupported("vector(1536)") // 1536 = text-embedding-3-small
  answer    String
  sources   Json
  images    Json
  createdAt DateTime                    @default(now()) @map("created_at")

  @@map("cached_query")
}
```

**Key points:**

- `Unsupported("vector(1536)")` tells Prisma to emit the column DDL verbatim in migrations
  but to exclude it from the generated TypeScript types. This is correct — there is no
  TypeScript representation for a Postgres `vector` array, and Prisma will refuse to compile
  any attempt to use `prisma.cachedQuery.findMany()` on a model that contains
  `Unsupported` fields.
- `model` is a plain `String`. The cache is **keyed on (embedding, model)**: a row cached for
  a budget model must never be served in reply to a request for a premium model, even if the
  queries are semantically identical. The embedding captures *meaning*; `model` captures
  *quality commitment*.
- `sources` and `images` are `Json` columns. In the raw INSERT they are cast with `::jsonb`.
- The SQL table name is `cached_query` (`@@map("cached_query")`); column names follow
  the `@map` annotations: `query_text`, `created_at`. Use the **snake_case SQL names**
  in raw queries, not the camelCase Prisma names.
- **1536 dimensions** matches `text-embedding-3-small` (OpenAI). If you switch embedding
  model you must change the dimension here and recreate the index — they are baked into
  the column type and the HNSW/IVFFlat index definition.

---

## 2. Why the typed client cannot read/write the vector column

Prisma generates TypeScript types for every model field. `Unsupported` fields are the
explicit escape hatch for database types Prisma does not know about:

- They appear in the migration SQL (so the column is created correctly).
- They are **omitted** from the generated TypeScript interface. The generated
  `CachedQuery` type in
  `backend/prisma/generated/prisma/internal/prismaNamespace.ts:828-838` has no `embedding`
  property — the field simply does not exist in the TypeScript world.
- Any attempt to use `prisma.cachedQuery.create({ data: { embedding: … } })` will
  produce a TypeScript compile error, not a runtime error. The compiler enforces the
  boundary.
- Even if you cast past the type error, the Prisma query engine would not know how to
  serialize a `number[]` to `vector` syntax — it would likely produce an incorrect
  parameterization.

**The consequence:** every read and write touching the `embedding` column must go through
`$queryRaw` or `$executeRaw`. This is not a limitation to work around; it is the
*intended* split of responsibility:

- Prisma manages the schema (migration DDL) and every other field.
- `$queryRaw` / `$executeRaw` own the vector-specific operations.

The `prismaFake` test double in `backend/tests/helpers/prisma-fake.ts:19-20` already
exposes both methods as Bun mocks, ready to stub in tests.

---

## 3. Enabling pgvector in Supabase — and why Prisma must not manage it

### How to enable the extension

In Supabase, `vector` (pgvector) is pre-installed but not active by default.
Enable it once, per-project:

**Option A — Dashboard:**
Supabase Dashboard → your project → Database → Extensions → search "vector" → enable.

**Option B — SQL Editor:**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Run this once. It is idempotent. After enabling, `vector(1536)` columns and the `<=>`
operator become available.

### Why Prisma must NOT manage the extension

The standard Prisma way to declare an extension is:

```prisma
// DO NOT DO THIS in Lumina
datasource db {
  provider   = "postgresql"
  extensions = [vector]   // ← this is the problematic line
}
```

On a managed Supabase project this causes `prisma migrate dev` to examine the
**live database** for extension drift. Supabase pre-installs many extensions
(`uuid-ossp`, `pg_stat_statements`, `pgsodium`, `vault`, etc.) that are *not*
listed in your Prisma schema. Prisma sees those as "extensions present in DB but
not in schema" and generates a migration that **drops them** — which can destroy
Supabase internals.

Lumina's schema deliberately omits `extensions = [...]` and documents the reason:

```prisma
// backend/prisma/schema.prisma:18-22
// NOTE: pgvector is enabled directly in Supabase (Dashboard → Database → Extensions,
// or `CREATE EXTENSION vector`). We deliberately do NOT let Prisma manage extensions
// (`extensions = [...]`) — on Supabase that makes `prisma migrate dev` flag Supabase's
// own pre-installed extensions as "drift" and threaten a destructive reset.
```

**Rule:** Enable `vector` once through the Dashboard or SQL Editor. Never add it to
`datasource.extensions`. Never run `prisma migrate reset` on a Supabase project without
understanding which extensions it will drop.

---

## 4. The raw-SQL access path: `$queryRaw` and `$executeRaw`

Both methods are template-literal tagged functions. Values interpolated into the
template are **parameterized** — Prisma wraps them in `$1`, `$2`, … placeholders and
passes them as prepared-statement parameters. The database engine receives the SQL
string and the values separately; user input can never become SQL syntax.

```typescript
// Pattern A — SELECT with a generic type annotation
const rows = await prisma.$queryRaw<Array<{ id: string; answer: string }>>`
  SELECT id, answer FROM cached_query WHERE model = ${modelName}
`;
// rows: Array<{ id: string; answer: string }>

// Pattern B — INSERT/UPDATE/DELETE (returns affected row count as number)
const count: number = await prisma.$executeRaw`
  DELETE FROM cached_query WHERE created_at < ${cutoff}
`;
```

### Safety rules (in precedence order)

1. **Always use the tagged template literal form.** The tagged form calls the Prisma
   parameterizer automatically. Do not call `$queryRaw(string)` — that signature does
   not exist; the string overload is `$queryRawUnsafe`.

2. **Never concatenate user input into the template.** The template interpolations
   must be *values*, not SQL fragments. `WHERE id = ${userId}` is safe.
   `WHERE id = ${userId} ${Prisma.raw(orderByUserInput)}` is not.

3. **`Prisma.sql` for composing fragments.** When you need to build a query
   dynamically from parts, use `Prisma.sql` tagged literals and pass the composed
   value into the outer template:
   ```typescript
   import { Prisma } from "../prisma/generated/prisma/client.js";

   const extra = someCondition
     ? Prisma.sql`AND model = ${model}`
     : Prisma.sql``;

   const rows = await prisma.$queryRaw`
     SELECT id FROM cached_query WHERE created_at > ${cutoff} ${extra}
   `;
   ```
   `Prisma.sql` fragments carry their own parameter list and are merged safely into
   the outer query — no concatenation risk.

4. **`Prisma.raw` only for identifiers you own.** `Prisma.raw(columnName)` is NOT
   parameterized — it is string interpolation at the SQL level. Use it only for
   column or table names that come from your own code, never from user input.

5. **`$queryRawUnsafe` / `$executeRawUnsafe` are banned for user-influenced input.**
   These accept a plain string + positional parameters (`$1`, `$2`, …). They exist
   for situations where the entire SQL statement is constructed at runtime (e.g. a
   meta-query where the table name itself varies). If you reach for one of these,
   audit carefully: every value that could ever come from a request must be a
   positional parameter, not string-concatenated into the query string.

---

## 5. Parameterization detail: tagged template vs `Prisma.sql`

The tagged template `prisma.$queryRaw\`…\`` is syntactic sugar over
`prisma.$queryRaw(Prisma.sql\`…\`)`. Both produce the same prepared-statement call.

```typescript
import { Prisma } from "../prisma/generated/prisma/client.js";

// These three are equivalent:

// A — inline tagged template (preferred for static queries)
const r1 = await prisma.$queryRaw`SELECT 1 WHERE id = ${id}`;

// B — Prisma.sql intermediate (preferred for dynamic assembly)
const q = Prisma.sql`SELECT 1 WHERE id = ${id}`;
const r2 = await prisma.$queryRaw(q);

// C — Prisma.sql fragments joined
const where = Prisma.join(
  [Prisma.sql`model = ${model}`, Prisma.sql`created_at > ${cutoff}`],
  " AND "
);
const r3 = await prisma.$queryRaw`SELECT id FROM cached_query WHERE ${where}`;
```

`Prisma.join(fragments, separator)` joins multiple `Sql` objects with a separator.
All interpolated values remain parameterized throughout.

### The `::vector` and `::jsonb` cast idiom

pgvector's `<=>` operator requires operands to be of type `vector`. When you
interpolate a string like `"[0.1,0.2,…]"` through a Prisma parameter, Postgres
receives it as a `text` parameter — you need an explicit cast in the SQL:

```sql
-- Prisma interpolates ${vec} as a text parameter; ::vector casts it
embedding <=> ${vec}::vector
```

The same applies to JSON:

```sql
${JSON.stringify(sources)}::jsonb
```

Casts are part of the static SQL string (not interpolated), so they are not
injection vectors.

---

## 6. Concrete examples: `cached_query` INSERT and SELECT

These are the actual patterns from `backend/index.ts`. Read them against the
schema column names (snake_case, per `@@map` and `@map`).

### INSERT — storing a fresh answer with its embedding

```typescript
// backend/index.ts:347-364
async function cacheAnswer(p: {
  query: string;
  embedding: number[] | null;
  model: string;
  answer: string;
  sources: unknown;
  images: unknown;
}): Promise<void> {
  if (!p.embedding || cacheDown()) return;
  try {
    // Serialize the float array to Postgres vector literal: "[0.1,0.2,…]"
    const vec = `[${p.embedding.join(",")}]`;

    await prisma.$executeRaw`
      INSERT INTO cached_query (id, query_text, model, embedding, answer, sources, images, created_at)
      VALUES (
        ${crypto.randomUUID()},
        ${p.query},
        ${p.model},
        ${vec}::vector,
        ${p.answer},
        ${JSON.stringify(p.sources)}::jsonb,
        ${JSON.stringify(p.images)}::jsonb,
        NOW()
      )
    `;
  } catch (e) {
    noteCacheError("cacheAnswer", e);
  }
}
```

Points to note:

- `crypto.randomUUID()` generates the PK in application code (not relying on
  `@default(uuid())` which only runs for ORM-driven inserts).
- `${vec}::vector` — the `::vector` cast is in the static SQL; `${vec}` is
  parameterized (arrives as `$4` in the prepared statement).
- `${JSON.stringify(p.sources)}::jsonb` — serialize to a JSON string, let Prisma
  parameterize it, then cast to `jsonb` in Postgres.
- `$executeRaw` returns the affected row count (`1` on success). The return value
  is discarded here because the cache is fail-open.

### SELECT — finding the nearest neighbor by cosine distance

```typescript
// backend/index.ts:306-335
async function findCachedAnswer(
  embedding: number[] | null,
  model: string,
): Promise<{ answer: string; sources: unknown; images: unknown } | null> {
  if (!embedding || cacheDown()) return null;
  try {
    const vec = `[${embedding.join(",")}]`;
    const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Type parameter tells TypeScript what shape each row has.
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
    if (hit && hit.distance <= DISTANCE_THRESHOLD) {
      return { answer: hit.answer, sources: hit.sources, images: hit.images };
    }
    return null;
  } catch (e) {
    noteCacheError("findCachedAnswer", e);
    return null;
  }
}
```

The `<=>` operator is pgvector's **cosine distance** operator. Distance 0 means
identical vectors; distance 2 means maximally different. The query:

1. Filters rows that are within TTL (`created_at > ${cutoff}`) and match the model.
2. Computes cosine distance for those rows against the query vector.
3. Orders ascending by distance, so the closest row comes first.
4. Takes `LIMIT 1` — we only care about the single best match.
5. Application code checks `hit.distance <= DISTANCE_THRESHOLD` (currently `0.15`)
   before treating the row as a cache hit.

Why express the distance twice (once in SELECT, once in ORDER BY)? Because SQL does
not allow aliased computed columns in ORDER BY in all databases, and referencing
`distance` in ORDER BY would require a subquery. Repeating the expression is idiomatic
here; Postgres evaluates it once per row due to query plan optimization.

### pgvector operator reference

| Operator | Metric | Use case |
|----------|--------|----------|
| `<=>` | Cosine distance | Text embeddings (unit vectors), semantic similarity |
| `<->` | Euclidean distance | Dense features where magnitude matters |
| `<#>` | Negative inner product | Unit vectors; equivalent to cosine with `ORDER BY … ASC` |

Lumina uses `<=>` throughout. `text-embedding-3-small` outputs unit-normalized vectors,
so cosine distance and inner product are equivalent — but `<=>` is more readable.

### Adding an HNSW index for production query speed

Without an index, `ORDER BY embedding <=> …` does an exact scan (O(n)). For the
semantic cache this is acceptable at low row counts (the cache evicts nothing — add a
maintenance job to prune old rows). At scale, add an HNSW index:

```sql
-- Run in Supabase SQL Editor after running migrations.
-- Do NOT put this in a Prisma migration file — it uses syntax Prisma cannot
-- represent and risks confusing migrate diff.
CREATE INDEX IF NOT EXISTS cached_query_embedding_hnsw
  ON cached_query
  USING hnsw (embedding vector_cosine_ops);
```

`vector_cosine_ops` matches the `<=>` operator. HNSW offers approximate nearest
neighbor search with sub-linear query time. The `IF NOT EXISTS` guard makes this
idempotent.

---

## 7. Mapping raw result rows back to typed TypeScript

`$queryRaw<T>` returns `Promise<T>`. The type parameter is your assertion to the
compiler — Prisma does not validate it at runtime. Use narrow, explicit types:

```typescript
// Narrow type: only the columns you actually SELECT
type CacheHitRow = {
  answer: string;
  sources: unknown;   // Postgres jsonb → unknown; validate at call site
  images: unknown;
  distance: number;
};

const rows = await prisma.$queryRaw<CacheHitRow[]>`
  SELECT answer, sources, images, (embedding <=> ${vec}::vector) AS distance
  FROM cached_query
  WHERE model = ${model}
  ORDER BY embedding <=> ${vec}::vector
  LIMIT 1
`;
```

**Type conversion hazards from Postgres → JavaScript:**

| Postgres type | JavaScript (from Prisma raw) | Action |
|---|---|---|
| `text`, `varchar` | `string` | Safe as-is |
| `jsonb` | `object` (parsed by Prisma) | Narrow with a type guard or Zod |
| `float4`, `float8` | `number` | Safe as-is |
| `int4` | `number` | Safe as-is |
| `int8` / `bigint` | `BigInt` | `Number(row.count)` — never passes `===` with number literals |
| `timestamp` | `Date` | Safe as-is |
| `vector` | **do not SELECT** | Cast to `text` if you must: `embedding::text` |
| `uuid` | `string` | Safe as-is |

The `sources` and `images` columns are `jsonb`. Prisma's raw query layer parses
`jsonb` from the wire and returns a plain JS object/array. Cast to `unknown` first,
then narrow:

```typescript
import { z } from "zod";

const SourceSchema = z.array(z.object({ url: z.string(), title: z.string() }));

const sources = SourceSchema.parse(hit.sources); // throws on unexpected shape
```

For the semantic cache, Lumina currently uses `unknown` and relies on the fact that
the rows were written by trusted server code. If the cache table is ever populated by
multiple services, add runtime validation.

---

## 8. Fail-open pattern and the table-missing guard

The semantic cache is a pure optimization. An error must never surface to the user.
Every function is wrapped in a `try/catch` that logs and returns `null` / exits
silently:

```typescript
// backend/index.ts:278-290
function noteCacheError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  // ONLY a genuine Postgres "undefined_table" (42P01) pauses the cache.
  // We do NOT free-text match "does not exist" — the AI gateway returns
  // "model does not exist…" for credential issues, which must never be
  // mistaken for a DB problem.
  if (code === "42P01") {
    cacheDownUntil = Date.now() + CACHE_COOLDOWN_MS;
    console.warn(`[semantic-cache] table missing (${where}) — pausing…`);
    return;
  }
  console.error(`[semantic-cache] ${where} failed:`, msg);
}
```

**Why `code === "42P01"` and not string matching?** The AI gateway also throws errors
whose messages contain "does not exist" (e.g. "model does not exist"). Matching on
the Postgres error code avoids false positives — only a genuine `undefined_table`
pauses the cache. After the cooldown the cache probes again automatically; no restart
needed after a late migration run.

---

## 9. Mocking raw queries in tests

The test seam is `backend/tests/helpers/prisma-fake.ts:19-20`:

```typescript
// backend/tests/helpers/prisma-fake.ts
export const prismaFake = {
  // …
  $queryRaw: fn(),
  $executeRaw: fn(),
};
```

Both are Bun mocks. Stub them per-test:

```typescript
import { prismaFake, resetPrisma } from "../helpers/prisma-fake.js";

beforeEach(resetPrisma);

it("returns null when no cache hit", async () => {
  // $queryRaw returns an empty array → no rows → null
  prismaFake.$queryRaw.mockResolvedValueOnce([]);
  const result = await findCachedAnswer([0.1, 0.2 /* … */], "openai/gpt-4o-mini");
  expect(result).toBeNull();
});

it("returns cached answer when distance <= threshold", async () => {
  prismaFake.$queryRaw.mockResolvedValueOnce([
    { answer: "React is…", sources: [], images: [], distance: 0.08 },
  ]);
  const result = await findCachedAnswer([0.1, 0.2], "openai/gpt-4o-mini");
  expect(result?.answer).toBe("React is…");
});

it("stores a new answer", async () => {
  prismaFake.$executeRaw.mockResolvedValueOnce(1);
  await cacheAnswer({ query: "q", embedding: [0.1], model: "m", answer: "a", sources: [], images: [] });
  expect(prismaFake.$executeRaw).toHaveBeenCalledTimes(1);
});
```

Note: Bun's `mock` returns `undefined` by default, not `[]`. Always provide an
explicit `mockResolvedValueOnce` for `$queryRaw` tests — an unexpected `undefined`
from `rows[0]` will silently return `null` (correct behavior) but won't catch a
missing stub.

---

## 10. Scope of this document

This document owns:

- The `CachedQuery` Prisma model and the `Unsupported("vector(1536)")` column.
- The reason the typed client cannot access the vector field.
- pgvector extension management (Supabase vs Prisma ownership).
- `$queryRaw` / `$executeRaw` safety rules, parameterization, and the `::vector`
  cast idiom.
- The concrete INSERT and SELECT implementations from `backend/index.ts`.
- Row-to-TypeScript type mapping for raw results.
- The fail-open error handling pattern and test mocking.

**Out of scope for this document:**

- How to embed a query string (calling `text-embedding-3-small` via the Vercel AI
  Gateway) → see the [`rag-retrieval`](../../rag-retrieval/SKILL.md) skill.
- Distance threshold selection, cache hit-rate analysis, staleness policy, and
  the stale-while-revalidate pattern for the Redis tier → see
  [`rag-retrieval`](../../rag-retrieval/SKILL.md).
- The Upstash Redis hot cache (`getOrRefresh`, `forceRefresh`) → see
  [`backend/lib/cache.ts`](../../../backend/lib/cache.ts).

---

## See also

**Sibling references in this skill:**

- `upstream/prisma-client-api/references/raw-queries.md` — generic Prisma raw query
  API reference (all databases, all operators).
- `upstream/prisma-upgrade-v7/references/esm-support.md` — ESM `.js` import
  extensions (required on Vercel; relevant when importing from generated client).
- `upstream/prisma-database-setup/references/postgresql.md` — Postgres datasource
  configuration.

**Other skills:**

- [`rag-retrieval`](../../rag-retrieval/SKILL.md) — embedding a query, threshold
  tuning, the full semantic-cache retrieval algorithm, and the knowledge-RAG design.
- [`supabase`](../../supabase/SKILL.md) — Supabase client setup, auth, extension
  management from the Supabase side.
- [`backend-testing`](../../backend-testing/SKILL.md) — `prismaFake` seam,
  `resetPrisma`, how to stub `$queryRaw` / `$executeRaw` in route integration tests.
- [`ai-sdk-agent`](../../ai-sdk-agent/SKILL.md) — the `embed()` call that produces
  the `number[]` embedding stored in `cached_query.embedding`.
- [`redis`](../../redis/SKILL.md) — the Upstash Redis hot cache layer
  (`backend/lib/cache.ts`) that sits in front of the Postgres semantic cache.
