# Lumina — Prisma 7 · Driver Adapter · ESM Setup

> How Lumina's Prisma 7 client is wired: the `prisma-client` generator, `PrismaPg` driver adapter,
> `importFileExtension = "js"` for Vercel strict-ESM, and `prisma.config.ts` env loading — with
> every claim grounded in real files from this repo.

---

## 1. The Prisma 7 Shift That Bites Us

Prisma 7 is a clean break from v6. The five changes that matter most for Lumina, in order of
"most likely to cost you an hour":

| Change | v6 | v7 |
|---|---|---|
| Generator provider | `prisma-client-js` | `prisma-client` (new default) |
| Output path | Auto to `node_modules/@prisma/client` | **Mandatory explicit path** |
| Driver adapters | Optional | **Required** for every SQL provider |
| Config / env loading | `.env` auto-loaded by Prisma CLI | `prisma.config.ts` + explicit dotenv (Bun loads `.env` natively) |
| `Prisma.validator()` | Works | **Removed** — use `satisfies` |

Additional removed features we must not regress to:
- `$use()` middleware → replaced by `$extends` Client Extensions
- `prisma.$metrics` → removed (no replacement in our stack)
- `--skip-generate` / `--skip-seed` CLI flags → both gone; generate/seed are always explicit now
- `rejectOnNotFound` client option → already gone since v5; use `findUniqueOrThrow` / `findFirstOrThrow`
- `PRISMA_CLIENT_ENGINE_TYPE` and other engine env vars → meaningless, dropped

The Rust query-engine binary is entirely absent in the `prisma-client` path. The adapter owns query
execution. That is why a driver adapter is not optional — there is nothing else to run the queries.

---

## 2. `prisma-client` vs `prisma-client-js` — What We Use and Why

Our generator block (`backend/prisma/schema.prisma:3-4`):

```prisma
generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
  engineType = "client"
  runtime = "nodejs"
  importFileExtension = "js"
}
```

`provider = "prisma-client"` activates the new engine-less generator. `prisma-client-js` still
exists in the Prisma monorepo for legacy projects, but it is the old Rust-binary path and should
not be used for new work.

**Consequence for imports.** Because `output = "./generated/prisma"` is relative to
`backend/prisma/`, the generated files land at:

```
backend/prisma/generated/prisma/
  client.ts          ← PrismaClient, Prisma namespace
  browser.ts         ← browser-safe types without a real client
  models.ts          ← model types and derived helpers
  enums.ts           ← enum-only, slim
  models/            ← per-model type files
```

We import from the **generated output path**, never from `@prisma/client` (which is now only a
shim that might not even exist in a v7 project):

```typescript
// backend/db.ts:1 — correct
import { PrismaClient } from "./prisma/generated/prisma/client.js";

// WRONG — v6 idiom, will crash on a fresh v7 install
import { PrismaClient } from "@prisma/client";
```

Note the `.js` extension on the import — that is not optional. See §6.

---

## 3. The Four Generated Entrypoints

| Entrypoint | Import path (from backend/) | Use |
|---|---|---|
| `client` | `./prisma/generated/prisma/client.js` | Server code: `PrismaClient`, `Prisma` namespace, all query types |
| `browser` | `./prisma/generated/prisma/browser.js` | Client components that only need types, not a live connection |
| `models` | `./prisma/generated/prisma/models.js` | Shared model types across packages (monorepo / frontend) |
| `enums` | `./prisma/generated/prisma/enums.js` | Just the enums — smallest import for code that only needs `MessageRole` etc. |

In practice Lumina is a server-rendered Vite SPA; the backend only ever touches `client`. The
frontend never imports Prisma types directly (it uses the API response shapes). But if you ever
need to share `MessageRole` or `AuthProvider` with the frontend without pulling in the full client:

```typescript
// Correct for frontend-facing type sharing (e.g. a types/ package)
import type { MessageRole, AuthProvider } from "./prisma/generated/prisma/enums.js";
```

---

## 4. Driver Adapters Are Required

Prisma 7's `prisma-client` generator ships no Rust binary. All SQL execution goes through the
adapter you supply. There is no fallback.

**Our adapter** (`backend/db.ts:1-10`):

```typescript
import { PrismaClient } from "./prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL
})

export const prisma = new PrismaClient({
    adapter
})
```

`PrismaPg` wraps the `pg` driver. `@prisma/adapter-pg` must be installed alongside `pg`:

```bash
bun add @prisma/adapter-pg pg
```

The `connectionString` goes directly to `pg`'s pool. Supabase's `DATABASE_URL` is a
`postgresql://...` URL with a connection pooler (PgBouncer) in the host. Pass it as-is; no
transformation needed.

### Connection pool knobs

`PrismaPg` passes unknown keys through to `pg.Pool`. If you ever need to tune:

```typescript
const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 5,                          // cap pool size (Vercel: keep low — each invocation is short-lived)
    idleTimeoutMillis: 10_000,       // release idle connections after 10 s
    connectionTimeoutMillis: 5_000,  // fail fast rather than queue
})
```

Vercel serverless functions are short-lived; a pool size of 1-5 is fine. The real pooler is
Supabase's PgBouncer, not the `pg.Pool`.

### SSL

Supabase requires TLS; the URL it provides already encodes `?sslmode=require`. If you encounter
self-signed cert errors in a local or staging environment:

```typescript
const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },   // dev/staging only — never prod
})
```

For production Supabase this is unnecessary; the CA chain is trusted by default on Vercel Node.

---

## 5. `runtime = "nodejs"` — Why We Spell It Out

```prisma
// backend/prisma/schema.prisma:9
runtime = "nodejs"
```

Prisma 7's `prisma-client` generator supports multiple runtimes:

| Value | Target |
|---|---|
| `nodejs` | Standard Node.js — Vercel serverless, AWS Lambda, Fly.io |
| `bun` | Bun's native runtime |
| `workerd` | Cloudflare Workers |
| `vercel-edge` | Vercel Edge Runtime (V8 isolates — no `pg`) |
| `react-native` | React Native / Expo |

We deploy to **Vercel Node** serverless and develop under **Bun**. The comment in the schema
(`schema.prisma:7-8`) explains the decision: `runtime = "nodejs"` generates code that runs on
Vercel's Node environment, and Bun's Node-compatibility layer accepts it locally without any
translation layer. If you switched to `runtime = "bun"`, the generated client would use
Bun-native APIs and likely fail on Vercel.

The `worker/` process runs on Fly.io (also Node-compatible), so the same client binary can be
reused there too.

---

## 6. `importFileExtension = "js"` — The Headline Lumina Gotcha

```prisma
// backend/prisma/schema.prisma:13
importFileExtension = "js"
```

This single line is the most likely source of "works locally, 404s on Vercel" pain. Here is the
full causal chain:

1. The generator emits `.ts` source files, but those files import **each other** using specifiers
   like `import { ... } from "./utils.js"` (with `.js`).
2. `tsc` (or Vercel's build) compiles those `.ts` files to `.js` files.
3. Under Node's strict ESM resolver (which Vercel uses), `import "./utils.js"` resolves to the
   actual `utils.js` file on disk. If the specifiers said `.ts` instead, Node would look for a
   `.ts` file at runtime, find nothing, and throw `ERR_MODULE_NOT_FOUND`.
4. Bun's resolver is lenient: it understands that `.js` in a specifier should resolve to the
   `.ts` source file during dev, so the bug is invisible locally.

The cross-cutting ESM rule in `CLAUDE.md` ("ESM `.js` imports. Relative imports in the backend
need explicit `.js` extensions...") is the exact same constraint — Bun masks it, Vercel surfaces
it. `importFileExtension = "js"` applies that rule to the generated client itself.

**What happens if you remove it?**
- `bun run dev` works fine.
- Vercel build succeeds (TypeScript compiles cleanly).
- At runtime, the first request that touches `prisma` gets a boot error: `Cannot find module
  '.../generated/prisma/wasm-engine-loader'` or similar, because the compiled `.js` file tries
  to import a sibling with a `.ts` specifier that does not exist on disk.

**The generator field interaction:**

```prisma
generatedFileExtension = "ts"   // what the .ts source files are named (default; usually omit)
importFileExtension    = "js"   // what the specifiers inside those files use (must be "js")
```

These two are orthogonal. The source is `.ts`; the specifiers say `.js`. That combination is the
Node ESM / TypeScript idiom for projects compiled with `tsc` or Vercel's build pipeline.

---

## 7. `prisma.config.ts` — What It Does and How Our Config Differs

**Our file** (`backend/prisma.config.ts:1-12`):

```typescript
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

`prisma.config.ts` replaces the v6 pattern of embedding `url = env("DATABASE_URL")` inside the
`datasource` block of `schema.prisma`. In v7, the `datasource` block in the schema only needs
`provider = "postgresql"` (`schema.prisma:16-22`); the URL and any `directUrl` / shadow DB URL
live in the config file.

### env() loading: where we differ from the upstream docs

The upstream `prisma-upgrade-v7` skill recommends `import 'dotenv/config'` as the first line of
`prisma.config.ts`. We do **not** do that, because:

- Lumina runs under **Bun** for every CLI command (`bun --bun run prisma ...` as the comment on
  `prisma.config.ts:1` notes). Bun automatically reads `.env` before the process starts — dotenv
  is redundant and can cause conflicts.
- `env()` from `prisma/config` is a typed accessor; it does not load files, only reads
  `process.env`. Since Bun has already populated `process.env`, no extra loader is needed.

If you ever switch to running `npx prisma` (Node, not Bun), add `import 'dotenv/config'` as the
first import so the CLI picks up your `.env` file.

### v6 → v7 migration path for `datasource`

```prisma
// BEFORE (v6) — schema.prisma datasource block
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// AFTER (v7) — schema.prisma datasource block (only provider remains)
datasource db {
  provider = "postgresql"
}
```

```typescript
// prisma.config.ts carries the URL
export default defineConfig({
  datasource: { url: env("DATABASE_URL") },
});
```

The `url`, `directUrl`, and `shadowDatabaseUrl` fields inside the schema's `datasource` block are
**deprecated** in v7 and will be removed in a future release.

---

## 8. `satisfies` Over `Prisma.validator` for Type-Safe Query Fragments

`Prisma.validator()` is gone from the `prisma-client` generator. The modern equivalent uses
TypeScript's `satisfies` operator, which gives the same compile-time narrowing without runtime
overhead.

**Our models** offer these type-safe select fragments:

```typescript
import { Prisma } from "./prisma/generated/prisma/client.js";

// Typed select for User — only the fields the caller needs
const userPublicSelect = {
  id: true,
  email: true,
  name: true,
  provider: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

// Use it in a query
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: userPublicSelect,
});
// user is typed as Pick<User, "id"|"email"|"name"|"provider"|"createdAt"> | null
```

The `satisfies` operator lets you define the object literal separately (for reuse), and TypeScript
infers the narrowest possible type for `select`. A typo in a field name is a compile error, not a
runtime surprise.

For `include` fragments:

```typescript
const conversationWithMessages = {
  messages: true,
  user: { select: userPublicSelect },
} satisfies Prisma.ConversationInclude;
```

For `where` fragments (e.g. in a helper):

```typescript
const activeUserWhere = {
  provider: "Google",
} satisfies Prisma.UserWhereInput;
```

### What `Prisma.validator` looked like (v6, do not use)

```typescript
// ❌ Gone in v7 prisma-client
const userSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  email: true,
});
```

---

## 9. The pgvector Exception — `$queryRaw` Only

`CachedQuery` has an `embedding Unsupported("vector(1536)")` field (`schema.prisma:62`). The
`Unsupported` type means Prisma's typed client cannot read or write that column through normal
model methods. All pgvector operations go through raw SQL:

```typescript
// Semantic cache lookup — cosine distance via pgvector's <=>
const rows = await prisma.$queryRaw<CachedRow[]>`
  SELECT id, answer, sources, images,
         extract(epoch from created_at) as "fetchedAt"
  FROM cached_query
  WHERE model = ${model}
    AND embedding <=> ${pgvectorLiteral(embedding)} < ${DISTANCE_THRESHOLD}
  ORDER BY embedding <=> ${pgvectorLiteral(embedding)}
  LIMIT 1
`;

// Insert — embedding must also be raw
await prisma.$executeRaw`
  INSERT INTO cached_query (id, query_text, model, embedding, answer, sources, images)
  VALUES (
    gen_random_uuid(), ${queryText}, ${model},
    ${pgvectorLiteral(embedding)}::vector,
    ${answer}, ${sources}::jsonb, ${images}::jsonb
  )
`;
```

**Do not add `extensions = [vector]` to the datasource block.** The schema comment at
`schema.prisma:19-21` explains: Prisma's extension management on Supabase flags Supabase's
pre-installed extensions as drift and threatens a destructive `migrate reset`. pgvector is enabled
in the Supabase dashboard; Prisma just needs to leave it alone.

---

## 10. Full v6 → v7 Breaking-Change Table (Lumina-Relevant Rows Only)

| Area | v6 | v7 | Lumina status |
|---|---|---|---|
| Generator provider | `prisma-client-js` | `prisma-client` | Done (`schema.prisma:4`) |
| Output path | Auto `node_modules` | Explicit required | Done (`schema.prisma:5`) |
| Driver adapter | Optional | Required for SQL | Done (`db.ts:2-7`) |
| Config file | `.env` via schema | `prisma.config.ts` | Done (`prisma.config.ts`) |
| `url` in datasource | `url = env(...)` in schema | Move to `prisma.config.ts` | Done; schema has no `url` |
| Env loading | Auto by CLI | Manual (dotenv) / Bun native | Bun handles it; no dotenv import |
| `importFileExtension` | N/A | `"js"` for Vercel Node ESM | Done (`schema.prisma:13`) |
| `runtime` | N/A | Explicit (various) | `"nodejs"` (`schema.prisma:9`) |
| `Prisma.validator()` | Available | Removed | Use `satisfies` |
| `$use()` middleware | Available | Removed | Use `$extends` |
| `prisma.$metrics` | Preview | Removed | N/A — we never used it |
| `--skip-generate` flag | Available | Removed | Always explicit: `prisma generate` |
| Engine env vars (`PRISMA_CLIENT_ENGINE_TYPE` etc.) | Respected | Removed / ignored | None set in our env |
| `rejectOnNotFound` option | Deprecated | Removed | Use `findUniqueOrThrow` |
| Auto-generate after migrate | Default | Disabled | Must run `prisma generate` explicitly |
| Auto-seed after migrate | Default | Disabled | Must run `prisma db seed` explicitly |

---

## 11. Troubleshooting

### "Cannot find module '…/generated/prisma/client.js'"

**Cause A — `prisma generate` has not been run.**
The generated output directory does not exist at all. Run:
```bash
bun --bun run prisma generate
```
This is also required after every schema change, schema migration, or fresh `bun install`.

**Cause B — Output path mismatch.**
The `output` in `schema.prisma` points to `./generated/prisma` (relative to `backend/prisma/`),
which resolves to `backend/prisma/generated/prisma`. The import in `db.ts:1` says
`"./prisma/generated/prisma/client.js"` (relative to `backend/`). If you change either, update
both together.

**Cause C — `.gitignore` excludes the generated directory but CI does not run `generate`.**
Either commit the generated files (unusual) or ensure your CI pipeline runs
`bun --bun run prisma generate` before the build step.

### "ERR_MODULE_NOT_FOUND" or module loads as `undefined` at Vercel boot

This is almost always `importFileExtension` missing or wrong. The generated files need
`importFileExtension = "js"` so their internal imports resolve under Node's strict ESM resolver.
Verify `schema.prisma:13` and re-run `prisma generate`.

### SSL: "self signed certificate in certificate chain"

Supabase's CA is trusted by Vercel's Node runtime. If you see this locally, your `DATABASE_URL`
may be pointing to a local Postgres with a self-signed cert. Add:
```typescript
const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },  // local dev only
})
```
Do not commit this to production code.

### Connection pool exhausted / "sorry, too many clients already"

Supabase's free tier limits simultaneous connections. Vercel creates a new function instance per
request; each instance can open its own `pg.Pool`. With many concurrent requests, you will
exceed the limit.

Mitigations (in order of preference):
1. Keep `max` low on the pool (`max: 1` or `max: 2` is reasonable for Vercel).
2. Enable **Supabase Connection Pooler** (PgBouncer, Transaction mode). The `DATABASE_URL`
   Supabase provides by default already points to the pooler on port 6543. Confirm yours does:
   the URL should contain `pooler.supabase.com`.
3. For long-running processes (`worker/` on Fly.io), use a named pool with a sensible `max`
   (5-10) and explicit `idleTimeoutMillis`.

### "Migration applied but schema drift detected" / "extension vector will be dropped"

This is the pgvector drift trap described in the schema comment (`schema.prisma:19-21`). Never
add `extensions = [vector]` to the datasource block. If you accidentally did, remove it and run:
```bash
bun --bun run prisma migrate dev --name remove_extension_directive
```
The migration Prisma generates will contain only the extension removal SQL, which is a no-op on
Supabase (the extension stays — Prisma just stops trying to manage it).

### "`Prisma.validator` is not a function"

You have v7 but are using the v6 pattern. Replace:
```typescript
// ❌ v6
const sel = Prisma.validator<Prisma.UserSelect>()({ id: true, email: true });

// ✅ v7
const sel = { id: true, email: true } satisfies Prisma.UserSelect;
```

### New backend file not picked up

Bun's `--hot` flag does not auto-restart when a new file is added to the backend. After creating
`backend/prisma/generated/prisma/` or any new module, kill the dev server and restart:
```bash
# Kill the running bun process, then:
bun --bun run dev
```

---

## See also

**Within the prisma skill:**
- `references/upstream/prisma-upgrade-v7/SKILL.md` — full upstream migration skill with step-by-step commands
- `references/upstream/prisma-upgrade-v7/references/schema-changes.md` — generator block options reference
- `references/upstream/prisma-upgrade-v7/references/driver-adapters.md` — all adapter packages and pool knobs
- `references/upstream/prisma-upgrade-v7/references/prisma-config.md` — `prisma.config.ts` full options
- `references/upstream/prisma-upgrade-v7/references/removed-features.md` — `$use` / metrics / CLI flags

**Other skills:**
- `supabase` — Supabase auth client (`backend/client.ts`), RLS, pgvector extension setup
- `rag-retrieval` — semantic cache design, pgvector distance queries, `$queryRaw` patterns
- `redis` — Upstash Redis cache layer (`backend/lib/cache.ts`), stale-while-revalidate, thundering-herd guard
- `finance-markets` — how `prisma.conversation` and `prisma.message` are used in finance chat flows
- `connectors-oauth` — `GmailConnection` model, encrypted token storage, `onDelete: Cascade`
- `backend-testing` — `prisma-fake.ts` seam (`backend/tests/helpers/prisma-fake.ts`), mocking Prisma in Bun tests
- `lumina-frontend` — frontend never imports Prisma directly; API response shapes are the contract
- `ai-sdk-agent` — how the agent engine reads/writes `Conversation` and `Message` rows via `prisma`
