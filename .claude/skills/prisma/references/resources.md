# Prisma Resources

> Pointer doc — curated official docs, CLI reference, the v7 upgrade guide, driver adapter docs,
> pgvector/Supabase extension guidance, and an index of every vendored upstream skill in
> `references/upstream/`. Read this first when you need an authoritative external source; then open
> the specific file or URL listed here.

---

## Official Prisma Documentation

### Prisma Client API Reference

**URL:** https://www.prisma.io/docs/orm/reference/prisma-client-reference

Covers every method on the generated client: `findUnique`, `findMany`, `create`, `createMany`,
`update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `count`, `aggregate`, `groupBy`,
`$transaction`, `$queryRaw`, `$executeRaw`, `$on`, `$extends`. Also documents query options
(`where`, `select`, `include`, `omit`, `orderBy`, `take`, `skip`, `cursor`, `distinct`) and all
filter/relation operators (`equals`, `not`, `in`, `gt`, `lt`, `contains`, `startsWith`, `some`,
`every`, `none`, `is`, `isNot`).

Open when: writing any query and you need the exact shape of an argument or return type.

### Schema Reference

**URL:** https://www.prisma.io/docs/orm/reference/prisma-schema-reference

Covers every keyword in `schema.prisma`: scalar types (`String`, `Int`, `DateTime`, `Json`,
`Bytes`, `Unsupported`), field attributes (`@id`, `@default`, `@unique`, `@updatedAt`, `@map`,
`@relation`, `@ignore`), block attributes (`@@id`, `@@unique`, `@@index`, `@@map`, `@@ignore`),
`@default` functions (`uuid()`, `cuid()`, `autoincrement()`, `now()`), referential actions
(`onDelete`, `onUpdate`), and the `datasource`/`generator` blocks.

Open when: adding or changing a field, relation, enum, index, or the generator block.

### Prisma CLI Reference

**URL:** https://www.prisma.io/docs/orm/reference/prisma-cli-reference

All CLI sub-commands and flags. Key commands for Lumina's workflow:

```bash
# Always use --bun when running via bunx (Bun project)
bunx --bun prisma generate
bunx --bun prisma migrate dev --name <migration-name>
bunx --bun prisma migrate deploy       # prod / CI
bunx --bun prisma migrate status
bunx --bun prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
bunx --bun prisma db push              # prototype only — no migration history
bunx --bun prisma db execute --file ./script.sql
bunx --bun prisma format
bunx --bun prisma validate
bunx --bun prisma studio
```

The `--bun` flag is required; without it Prisma falls back to Node.js despite running inside Bun.

Open when: you need a flag name, migration command details, or the `db execute` / `db seed` API.

### Prisma v7 Upgrade Guide

**URL:** https://www.prisma.io/docs/orm/more/upgrades/to-v7

The canonical breaking-change reference for the v6 → v7 migration. Key changes that are **already
applied** in Lumina and must be preserved:

| v6 | v7 (Lumina's setup) |
|----|---------------------|
| `provider = "prisma-client-js"` | `provider = "prisma-client"` |
| Output to `node_modules/@prisma/client` | Explicit `output = "./generated/prisma"` |
| `new PrismaClient()` with no adapter | `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` |
| Import from `@prisma/client` | Import from `./prisma/generated/prisma/client.js` |
| Auto-loaded `.env` by Prisma | Explicit `prisma.config.ts` with `env("DATABASE_URL")` |
| `Prisma.validator()` | TypeScript `satisfies Prisma.UserSelect` |
| `$use()` middleware | `$extends()` client extensions |
| Optional driver adapters | Required for all SQL providers |

Open when: you see a v6 pattern in old code, an upgrade error, or any confusion about the
generator/adapter/import triad.

### Driver Adapters

**URL:** https://www.prisma.io/docs/orm/core-concepts/supported-databases/database-drivers

Explains the driver-adapter model in Prisma 7: every SQL provider now requires an explicit adapter.
The adapter bridges Prisma's query engine to a native JS database driver. For Lumina:

- Adapter: `@prisma/adapter-pg` (wraps `pg` / node-postgres)
- Datasource: Supabase Postgres (standard PostgreSQL wire protocol)
- The adapter receives a `connectionString` option pointing at `DATABASE_URL`

Open when: debugging connection errors, changing the database host, or evaluating alternative
adapters (Neon, PgBouncer, Supabase pooler).

### `prisma.config.ts` Reference

**URL:** https://www.prisma.io/docs/orm/reference/prisma-config-reference

Documents `defineConfig` from `prisma/config`: `schema`, `migrations.path`, `datasource.url`,
`earlyAccess`. Lumina's config (`backend/prisma.config.ts:1`):

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

Note: there is no `import 'dotenv/config'` in Lumina's config because Bun reads `.env` natively.
If environment loading fails on CI, add `import 'dotenv/config'` at the top.

Open when: modifying the config file shape, adding a seed script path, or troubleshooting
`DATABASE_URL not found` on the CLI.

### pgvector + Postgres Extensions on Supabase

**URLs:**
- pgvector extension: https://supabase.com/docs/guides/database/extensions/pgvector
- Supabase extensions overview: https://supabase.com/docs/guides/database/extensions

Lumina uses pgvector for the semantic cache (`CachedQuery.embedding`). The critical architectural
rule is that Supabase manages pgvector — **Prisma does not**:

```prisma
// schema.prisma datasource block — NO extensions array
datasource db {
  provider = "postgresql"
  // pgvector enabled in Supabase Dashboard or via:
  // CREATE EXTENSION IF NOT EXISTS vector;
  // Do NOT add extensions = [vector] here.
}
```

If `extensions = [vector]` were added, `prisma migrate dev` would flag Supabase's pre-installed
`vector` extension as schema drift and propose a destructive reset. Instead, enable the extension
once in the Supabase SQL editor or dashboard, then use it via `$queryRaw` only.

Open when: adding a new Postgres extension, debugging "extension not found" errors, or reviewing
Supabase + Prisma extension ownership boundaries.

---

## `@prisma/adapter-pg` + node-postgres (`pg`) Docs

### `@prisma/adapter-pg`

**NPM:** https://www.npmjs.com/package/@prisma/adapter-pg  
**Source:** https://github.com/prisma/prisma/tree/main/packages/adapter-pg

`PrismaPg` is the driver adapter that wraps node-postgres (`pg`) for Prisma 7. It accepts either
a `connectionString` or an existing `pg.Pool` instance.

```typescript
import { PrismaPg } from "@prisma/adapter-pg";

// Option A — connection string (Lumina's db.ts pattern)
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

// Option B — existing pool (preferred for long-lived servers, explicit pool config)
import pg from "pg";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,               // max simultaneous connections
  idleTimeoutMillis: 30_000,
});
const adapter = new PrismaPg(pool);
```

On Vercel serverless the pool is effectively per-request (cold-start isolation), so Option A is
fine. For the Fly.io `worker/` WebSocket server, Option B with an explicit pool and `max` cap is
safer.

**PgBouncer / transaction-mode pooler note:** When `DATABASE_URL` points at Supabase's connection
pooler (port `6543`) rather than the direct connection (port `5432`), prepared statements must be
disabled on the `pg.Pool`:

```typescript
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Required when routing through pgBouncer in transaction mode:
  // (Supabase pooler = PgBouncer in transaction mode by default)
});
// PrismaPg disables prepared statements automatically when it detects
// pgBouncer — but if issues occur, pass a direct URL to the adapter
// and the pooler URL only for reads.
```

For Supabase the recommended setup is: `DATABASE_URL` = pooler URL (port `6543`) for the Prisma
Client, `DIRECT_URL` = direct URL (port `5432`) for migrations. Lumina currently uses only
`DATABASE_URL` (direct connection), which is fine for the current serverless workload.

### node-postgres (`pg`)

**Docs:** https://node-postgres.com  
**NPM:** https://www.npmjs.com/package/pg

node-postgres is the JS PostgreSQL client under `@prisma/adapter-pg`. You rarely need to touch it
directly when using Prisma, but these references matter:

- `pg.Pool` config: https://node-postgres.com/apis/pool — `max`, `idleTimeoutMillis`,
  `connectionTimeoutMillis`, `ssl`.
- SSL config: https://node-postgres.com/features/ssl — relevant if Supabase enforces TLS and the
  default cert chain isn't trusted.
- `pg.types` / type parsers: https://node-postgres.com/features/types — useful if you need custom
  parsing for `numeric`, `bigint`, or other types that `pg` returns as strings.

---

## Index of Vendored Upstream Skills

All official Prisma skills are vendored verbatim under
`.claude/skills/prisma/references/upstream/`. They are read-only prior art — do not edit them.
The Lumina-specific references distill and localize this knowledge; these upstream files are the
authoritative source when something is unclear.

| Skill directory | What it covers | Open when |
|---|---|---|
| `prisma-client-api/` | Full Prisma Client API: every model method, query option, filter operator, relation query, transaction API, raw-query safety, and client lifecycle methods (`$connect`, `$disconnect`, `$on`, `$extends`). | Writing or debugging any Prisma query; verifying the exact shape of a method argument. |
| `prisma-cli/` | Every Prisma CLI sub-command and flag: `init`, `generate`, `validate`, `format`, `studio`, `db pull/push/seed/execute`, `migrate dev/deploy/reset/status/diff/resolve`, `mcp`, `debug`. Also documents `prisma dev` (local Prisma Postgres instance). | Looking up a CLI flag or migration command option; troubleshooting `migrate dev` or `migrate deploy`. |
| `prisma-upgrade-v7/` | Complete v6 → v7 migration guide: generator provider change, required output path, driver-adapter installation, ESM module format, `prisma.config.ts`, env loading, removed features (`$use` middleware, metrics), and Accelerate notes. | Encountering a v6 pattern in legacy code; debugging generator/adapter/import errors; ESM vs CJS issues. |
| `prisma-database-setup/` | Database provider setup guides: PostgreSQL, MySQL, SQLite, SQL Server, CockroachDB, Prisma Postgres, and MongoDB (which should stay on v6). Includes the `prisma-client-setup` reference (install, generator block, generate, adapter). | Starting a new project on a different provider; switching databases; `datasource` block reference. |
| `prisma-postgres/` | Prisma Postgres managed service: Console setup, `create-db` / `create-pg` / `create-postgres` CLI, `prisma postgres link`, Management API (service token + OAuth), and `@prisma/management-api-sdk`. | Provisioning a Prisma-managed Postgres instance; Management API automation. |
| `prisma-postgres-setup/` | Step-by-step procedural guide for provisioning Prisma Postgres via the Management API: auth (service tokens), region listing, project + database creation, `.env` wiring, schema push, and connection verification. | Setting up a new Prisma Postgres database from scratch; debugging provisioning failures. |
| `prisma-compute/` | Prisma Compute deployment: `@prisma/cli app deploy`, `create-prisma --deploy`, `prisma.compute.ts` / `defineComputeConfig`, framework deploy readiness (Next.js, Hono, Nuxt, Astro, TanStack Start), branch environments, Management API SDK. Not relevant to Lumina (Lumina deploys on Vercel, not Prisma Compute). | If the deploy target ever changes to Prisma Compute; evaluating Compute as an alternative to Vercel. |
| `prisma-driver-adapter-implementation/` | Low-level internals for implementing a custom Prisma driver adapter: `SqlDriverAdapter`, `SqlMigrationAwareDriverAdapterFactory`, `Transaction` lifecycle, `SqlResultSet`, `ColumnTypeEnum`, argument/row mapping, error mapping (`DriverAdapterError`). | Implementing a custom adapter for an unsupported driver; understanding why `commit()`/`rollback()` are lifecycle-only hooks. |

### Reading order for common tasks

**"I need to write a query"** → `prisma-client-api/SKILL.md` → `prisma-client-api/references/model-queries.md`

**"I need to run a migration"** → `prisma-cli/references/migrate-dev.md` (dev) or `migrate-deploy.md` (prod)

**"I hit a v7 error I don't understand"** → `prisma-upgrade-v7/SKILL.md` → the relevant `references/` file

**"I need to set up pgvector"** → See the pgvector section above + `lumina-pgvector-and-raw-queries.md`

**"I need to understand the adapter internals"** → `prisma-driver-adapter-implementation/SKILL.md`

---

## Quick Version Reference

| Package | Version in use | Notes |
|---|---|---|
| `prisma` (CLI) | 7.x | Run as `bunx --bun prisma` |
| `@prisma/client` | 7.x | Not imported directly; generated output is imported |
| `@prisma/adapter-pg` | 7.x | Required for all SQL providers in v7 |
| `pg` (node-postgres) | latest v8 | Used by `@prisma/adapter-pg` |
| Node.js (minimum) | 20.19.0+ | Prisma 7 requirement |
| TypeScript (minimum) | 5.4.0+ | Prisma 7 requirement; Lumina uses 5.x |

Bun is Lumina's runtime locally and on Vercel (via Bun build + Node serverless). The generated
client targets `runtime = "nodejs"` so it runs on Vercel's Node runtime at deploy time. Bun is
Node-compatible and resolves the same generated files locally.

---

## See Also

- `lumina-prisma-architecture.md` — full wiring map (`db.ts`, `prisma.config.ts`, schema, queries)
- `lumina-prisma7-adapter-esm.md` — Prisma 7 generator/adapter/ESM/.js deep dive
- `lumina-pgvector-and-raw-queries.md` — vector column, `$queryRaw`, cosine distance, parameterization
- `prisma-schema-modeling.md` — designing/changing models, relations, indexes
- `prisma-client-api.md` — writing queries (Lumina-localized)
- `prisma-migrations-and-cli.md` — migration workflow + Supabase drift trap
- `prisma-driver-adapters-and-deployment.md` — pooling, serverless, `DATABASE_URL`
- `prisma-testing-and-mocking.md` — `prisma-fake` seam, `bun:test` mocking
- Sibling skills: **supabase** (auth + RLS), **redis** (Upstash hot cache), **rag-retrieval**
  (cosine retrieval algorithm), **connectors-oauth** (Gmail token encryption),
  **backend-testing** (test harness), **lumina-frontend** (React/Vite UI)
