---
name: prisma
description: >
  Build and reason about Lumina's database layer on Prisma 7 + Supabase Postgres. Covers the
  `prisma-client` generator (NOT `prisma-client-js`), the `PrismaPg` driver adapter, the
  `prisma.config.ts` + `DATABASE_URL` wiring, ESM `.js` import extensions in the generated client
  (the Vercel build gotcha), the schema models (User/Conversation/Message/CachedQuery/
  GmailConnection), pgvector via `Unsupported("vector(1536)")` accessed only through `$queryRaw`/
  `$executeRaw`, migrations with the Prisma CLI (and the Supabase extension-drift trap), the full
  Prisma Client query API (findMany/create/upsert/$transaction/filters/relations), atomic guarded
  writes for contested data, connection pooling on serverless, and mocking Prisma in tests. Use
  whenever the task touches the database schema, a Prisma query, a migration, the generated client,
  the semantic-cache vector column, driver adapters, or DB performance/scale.
metadata:
  priority: 60
  sessionStart: false
  pathPatterns:
    - 'backend/db.ts'
    - 'backend/prisma/**'
    - 'backend/prisma.config.ts'
    - 'backend/auth.ts'
    - 'backend/conversations*.ts'
  bashPatterns:
    - 'prisma'
    - 'migrate'
    - 'schema.prisma'
    - 'DATABASE_URL'
  promptSignals:
    phrases:
      - 'prisma'
      - 'schema.prisma'
      - 'migration'
      - 'prisma migrate'
      - 'prisma generate'
      - 'findMany'
      - 'upsert'
      - '$queryRaw'
      - '$transaction'
      - 'driver adapter'
      - 'PrismaPg'
      - 'pgvector'
      - 'vector column'
      - 'generated client'
      - 'database model'
      - 'add a column'
      - 'add a table'
      - 'connection pool'
    minScore: 3
---

# Prisma — Lumina's Database Layer

> Build the database the way the live code already does it: **Prisma 7** with the new
> `prisma-client` generator, a **`PrismaPg` driver adapter** over Supabase Postgres, ESM `.js`
> import extensions baked into the generated client (or Vercel's strict ESM resolver fails the
> build), and **pgvector reached only through raw SQL**. Prisma owns *all* persistent data here;
> Supabase owns *only* auth + Realtime. This skill is the map from any DB task to the exact
> reference + the exact file in [`backend/`](../../../backend/).

This skill follows the **finance-markets gold-standard** structure. The official Prisma skills are
vendored verbatim under [`references/upstream/`](references/upstream/) as cited prior art.

---

## Domain Identity

**This skill OWNS:**
- The schema + models in [`backend/prisma/schema.prisma`](../../../backend/prisma/schema.prisma)
  (`User`, `Conversation`, `Message`, `CachedQuery`, `GmailConnection`, the `MessageRole`/
  `AuthProvider` enums).
- The client construction in [`backend/db.ts`](../../../backend/db.ts) (`PrismaClient` + `PrismaPg`
  adapter + `DATABASE_URL`) and the config in
  [`backend/prisma.config.ts`](../../../backend/prisma.config.ts).
- The generated client under [`backend/prisma/generated/prisma/`](../../../backend/prisma/generated/prisma/)
  and the generator block (`prisma-client`, `output`, `runtime="nodejs"`, `importFileExtension="js"`).
- Migrations in [`backend/prisma/migrations/`](../../../backend/prisma/migrations/) and the Prisma CLI
  workflow (`migrate dev`/`deploy`/`diff`, `generate`, `db push`/`pull`/`execute`).
- Every Prisma **query** in the backend — e.g. the idempotent user upsert in
  [`backend/auth.ts`](../../../backend/auth.ts), conversation/message CRUD, connector rows.
- The **pgvector** column (`embedding Unsupported("vector(1536)")`) and the `$queryRaw`/`$executeRaw`
  access path the semantic cache uses.
- DB-side concerns: indexing, pagination, atomic guarded writes, connection pooling on serverless,
  and mocking Prisma in tests.

**This skill does NOT own (route elsewhere):**
- The **semantic-cache retrieval logic** (embedding the query, cosine `<=>` ranking, threshold
  tuning) → **rag-retrieval**. This skill owns the *column + raw-SQL plumbing*; that skill owns the
  *retrieval algorithm*.
- **Supabase auth + Realtime + RLS** → **supabase**. Supabase here is auth-only; Prisma owns data.
- The **Upstash hot cache** (`cache.ts`) → **redis**. That is a *different* store (ephemeral KV);
  Prisma/Postgres is the durable source of truth.
- **How a Prisma mock is wired into a specific test** → **backend-testing** (this skill explains the
  `prisma-fake` seam; that skill owns the test harness).
- **Connector token storage semantics** (AES-GCM vault) → **connectors-oauth** (this skill owns the
  `GmailConnection` row shape; that skill owns the encryption).

---

## Decision Tree

```
Database task arrives
|
+-- "How is Prisma wired here? where does X live? the schema?" --> lumina-prisma-architecture.md
+-- "Prisma 7 gotcha: generator/adapter/ESM/.js/Vercel build fails" -> lumina-prisma7-adapter-esm.md
+-- "The vector column / embedding / $queryRaw / semantic cache row" -> lumina-pgvector-and-raw-queries.md
+-- "Design/modify a model: fields, relations, enums, @map, indexes" -> prisma-schema-modeling.md
+-- "Write a query: findMany/create/upsert/select/include/filters" --> prisma-client-api.md
+-- "Atomic write / $transaction / increment / contested counter" ---> prisma-transactions-and-concurrency.md
+-- "Run/author a migration; CLI commands; the Supabase drift trap" -> prisma-migrations-and-cli.md
+-- "Driver adapter / pooling / DATABASE_URL / deploy on Vercel" ----> prisma-driver-adapters-and-deployment.md
+-- "Will this query survive 100x/10000x? N+1, index, pagination" ---> prisma-performance-and-rscale.md
+-- "Mock Prisma in a test / prisma-fake / unit a DB module" --------> prisma-testing-and-mocking.md
+-- "Official Prisma docs / CLI flags / upgrade guide / further reading" -> resources.md  (+ references/upstream/)
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Use the `prisma-client` generator, not `prisma-client-js`.** Import from the generated `output` path (`./prisma/generated/prisma/client.js`), never from `@prisma/client`. | `schema.prisma` generator block; `db.ts` import. Prisma 7's default generator. |
| 2 | **A driver adapter is REQUIRED — construct `PrismaClient` with `PrismaPg`.** Prisma 7 SQL providers have no built-in engine connection; `new PrismaClient()` with no adapter fails. | `db.ts`: `new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) })`. |
| 3 | **`importFileExtension = "js"` stays in the generator.** The generated client emits `.js` specifiers so Vercel's strict ESM resolver finds the compiled files at boot. Removing it ⇒ `ERR_MODULE_NOT_FOUND` in prod (Bun masks it locally). | `schema.prisma` generator; mirrors cross-cutting rule #3. |
| 4 | **Never let Prisma manage Postgres extensions on Supabase.** No `extensions = [...]` in the datasource. Supabase pre-installs pgvector etc.; Prisma would flag them as drift and threaten a destructive reset. Enable `vector` via Supabase (`CREATE EXTENSION vector`). | `schema.prisma` datasource comment; the `india-markets`/`finance` pgvector setup. |
| 5 | **The `embedding` column is `Unsupported("vector(1536)")` — touch it ONLY via `$queryRaw`/`$executeRaw`.** Prisma's typed client cannot read/write `vector`; the model exists mainly to drive the migration. | `CachedQuery` model; rag-retrieval owns the cosine `<=>` query. |
| 6 | **Parameterize every raw query — use the tagged `$queryRaw\`\`` / `Prisma.sql`, never `$queryRawUnsafe` with string concatenation.** Concatenated user input is SQL injection. | `raw-queries` upstream ref; `lumina-pgvector-and-raw-queries.md`. |
| 7 | **Contested writes are atomic and guarded in ONE statement** — `update({ where: { id, qty: { gt: 0 } }, data: { qty: { decrement: 1 } } })`, never read-then-write in app code. The row lock is the single ticket window. | R-SCALE §D; `prisma-transactions-and-concurrency.md`. |
| 8 | **Provisioning/upserts must be idempotent** (`upsert` on a unique key); a retried request must not create duplicates. | `auth.ts` user upsert keyed on `email`; idempotency rule. |
| 9 | **New backend files (incl. a new module that imports `prisma`) need a full dev-server restart** — Bun `--hot` does not pick them up. After editing `schema.prisma`, run `prisma generate` AND restart. | Cross-cutting rule #7. |
| 10 | **The schema is the source of truth; never hand-edit the generated client or the DB outside a migration.** Change `schema.prisma` → `migrate dev` → `generate`. Ad-hoc dashboard edits cause drift. | `prisma-migrations-and-cli.md`. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| `import { PrismaClient } from "@prisma/client"` | Import from the generated `output` path (`./prisma/generated/prisma/client.js`) — Prisma 7's `prisma-client` generator. |
| `new PrismaClient()` with no adapter | `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })`. |
| Dropping `importFileExtension="js"` because "Bun runs fine" | Keep it — Vercel's Node ESM resolver needs the real `.js` extension or boot 404s. |
| Adding `extensions = [vector]` to the datasource on Supabase | Enable extensions in Supabase; keep Prisma out of extension management to avoid drift/reset. |
| Trying to `select: { embedding: true }` on `CachedQuery` | The vector type is `Unsupported` — read/write it via `$queryRaw`/`$executeRaw` only. |
| `$queryRawUnsafe(\`... ${userInput}\`)` | Tagged `$queryRaw\`... ${userInput}\`` or `Prisma.sql` — parameterized, injection-safe. |
| `const r = await find(); r.qty--; await update(r)` for stock/limits | One atomic guarded `update` with a `where` guard + `{ decrement: 1 }`. |
| `findMany()` then a query per row (N+1) | `include`/`select` the relation in one query, or `in` a batched lookup. |
| `SELECT *` via no `select`/`omit` on wide rows | `select` the columns you need; `omit` secrets (e.g. `refreshTokenEnc`). |
| Editing the DB in the Supabase SQL editor for schema changes | CLI migration: edit `schema.prisma` → `migrate dev` → review → `migrate deploy`. |
| One shared `PrismaClient` re-instantiated per request on serverless | Single module-level client (as in `db.ts`); pool via the adapter + Supabase pooler. |

---

## Output Contract (what "done" looks like)

A database change is done when:
1. **Schema:** the model change is in `schema.prisma` with correct `@id`/`@default`/`@unique`/`@map`/
   `@@map`, relations + `onDelete`, and indexes for the columns you filter on.
2. **Migration:** a reviewed migration exists (`migrate dev` locally → `migrate deploy` in prod); no
   destructive reset against Supabase; extensions left to Supabase.
3. **Client:** `prisma generate` re-run; imports come from the generated path; the adapter is intact;
   `importFileExtension="js"` preserved.
4. **Queries:** typed queries select only needed columns, handle the not-found case, and use
   `$transaction`/atomic guards for any multi-step or contested write; raw SQL is parameterized.
5. **Vector/raw:** any `vector` access goes through parameterized `$queryRaw`/`$executeRaw`; the
   retrieval semantics are deferred to **rag-retrieval**.
6. **Scale:** for any list/search/contested surface you've answered the relevant R-SCALE questions
   (indexing, pagination, atomicity) — see `prisma-performance-and-rscale.md`.
7. **Verified:** migration applied, `generate` clean, dev server restarted after new files; the query
   returns expected rows (or the mocked test passes — see `prisma-testing-and-mocking.md`).

---

## Bundled References (11 files + vendored upstream)

Read the one or two the task needs — never the whole folder.

### Lumina-specific (cite `file:line` in this repo)
| File | Load when |
|------|-----------|
| `lumina-prisma-architecture.md` | You need the full wiring map — `db.ts`, `prisma.config.ts`, every model in `schema.prisma`, the generated-client path, where queries live, the deploy topology, and the recurring gotchas. Start here when lost. |
| `lumina-prisma7-adapter-esm.md` | Anything about the Prisma 7 generator/adapter/ESM stack: `prisma-client` vs `prisma-client-js`, `PrismaPg`, `output`/`runtime`/`importFileExtension`, the Vercel `.js`-resolver build failure, `prisma.config.ts`, `satisfies` over `Prisma.validator`. |
| `lumina-pgvector-and-raw-queries.md` | The `embedding Unsupported("vector(1536)")` column, why pgvector is enabled in Supabase (not Prisma), the `$queryRaw`/`$executeRaw` access path, cosine `<=>`, raw-query parameterization + safety. |

### Generic Prisma craft (reusable; distilled from upstream)
| File | Load when |
|------|-----------|
| `prisma-schema-modeling.md` | Designing/changing a model: scalar types, `@id`/`@default`/`@unique`/`@updatedAt`/`@map`/`@@map`, relations (1-1/1-n), enums, indexes, native types, referential actions. |
| `prisma-client-api.md` | Writing a query: model methods (`findUnique`/`findMany`/`create`/`createMany`/`upsert`/`update`/`delete`/`count`/`aggregate`/`groupBy`), `select`/`include`/`omit`/`orderBy`/`take`/`skip`/`cursor`, filter + relation operators, nested writes. |
| `prisma-transactions-and-concurrency.md` | Atomic/multi-step writes: `$transaction` (array + interactive), isolation levels, optimistic concurrency, `{ increment }`/`{ decrement }` atomic ops, the read-then-write hazard, idempotency keys — mapped to R-SCALE §D contested writes. |
| `prisma-migrations-and-cli.md` | The migration workflow + CLI: `migrate dev`/`deploy`/`diff`/`status`/`resolve`/`reset`, `db push`/`pull`/`execute`/`seed`, `generate`/`format`/`validate`/`studio`, and the Supabase extension-drift trap. |
| `prisma-driver-adapters-and-deployment.md` | Driver adapters (`adapter-pg`/`neon`/`ppg`), connection pooling (Supabase pooler / PgBouncer, transaction mode, prepared statements), serverless cold starts, `DATABASE_URL` vs `DIRECT_URL`, deploying on Vercel. |
| `prisma-performance-and-rscale.md` | Any list/search/contested surface: N+1, `select`/`include` over-fetch, indexing, cursor vs offset pagination, connection limits at scale — the R-SCALE battery applied to Prisma. |
| `prisma-testing-and-mocking.md` | Unit/integration-testing a DB module: the `prisma-fake` seam, `bun:test` mocking, asserting query shape, transaction tests — ties into **backend-testing**. |
| `resources.md` | Official Prisma docs, CLI reference, the v7 upgrade guide, adapter docs, and an index of the vendored `references/upstream/` official skills. |

### Vendored upstream (read-only prior art)
| Path | What it is |
|------|-----------|
| `references/upstream/` | The official Prisma skills repo (github.com/prisma/skills) verbatim: `prisma-client-api`, `prisma-cli`, `prisma-upgrade-v7`, `prisma-database-setup`, `prisma-postgres(-setup)`, `prisma-compute`, `prisma-driver-adapter-implementation`. Authoritative source; our Lumina refs distill + localize it. |

---

## Cross-repo prior art

- **Official Prisma skills** — vendored at `references/upstream/`; source: https://github.com/prisma/skills
  and https://www.prisma.io/docs/ai/tools/skills. `prisma-upgrade-v7` maps 1:1 to our stack.
- **react repo** `E:\Development\Portfolio-phase2\react\.claude\skills` — `mongodb-mastery` (data
  modeling prior art, different DB), `typescript-patterns` (the `satisfies` patterns Prisma 7 uses).
- Project memory: `connectors-gmail-kb` (the `GmailConnection` row), `discover-tabs-build` (the
  Bun `--hot` new-file gotcha). Verify against live code before relying on any `file:line`.
