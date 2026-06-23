# Prisma Migrations and CLI

> Complete reference for the Prisma 7 CLI migration workflow, `db` utilities, and auxiliary
> commands, with Lumina-specific configuration and the Supabase extension-drift trap explained.

---

## Table of Contents

1. [Our `prisma.config.ts`](#our-prismaconfigts)
2. [The dev loop](#the-dev-loop)
3. [Production and CI: `migrate deploy`, `status`, `diff`, `resolve`, `reset`](#production-and-ci)
4. [`db push`, `db pull`, `db execute`, `db seed`](#db-utilities)
5. [`generate`, `format`, `validate`, `studio`](#auxiliary-commands)
6. [The shadow database](#the-shadow-database)
7. [THE SUPABASE EXTENSION-DRIFT TRAP](#the-supabase-extension-drift-trap)
8. [Running via Bun](#running-via-bun)
9. [Full flag reference](#full-flag-reference)

---

## Our `prisma.config.ts`

Lumina's configuration lives at `backend/prisma.config.ts`:

```typescript
// backend/prisma.config.ts — auto-generated, assumes `bun --bun run prisma [command]`
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

Key points:

- `schema` → `prisma/schema.prisma` (relative to `backend/`, the working dir when you run Prisma).
- `migrations.path` → `prisma/migrations` (where generated SQL lives; commit this directory).
- `datasource.url` → `env("DATABASE_URL")` — the `env()` helper from `prisma/config` does NOT
  auto-load `.env` files. If you need `.env` loaded in the CLI process, add
  `import 'dotenv/config'` as the first line.
- The datasource block in `schema.prisma` intentionally has **no `url =`** and **no
  `extensions = []`** — both of those live here or are managed by Supabase directly.

If you ever need a shadow database (see [§ Shadow Database](#the-shadow-database)) or a direct
(non-pooled) URL for migrations, extend the config:

```typescript
datasource: {
  url: env("DATABASE_URL"),           // pooled (PgBouncer) — normal queries
  directUrl: env("DIRECT_DATABASE_URL"), // direct — used by migrate commands
  shadowDatabaseUrl: env("SHADOW_DATABASE_URL"), // optional: explicit shadow DB
},
```

---

## The dev loop

The standard cycle when changing `prisma/schema.prisma`:

```
edit schema.prisma
    ↓
bun --bun run prisma migrate dev --name <describe_change>
    ↓
bun --bun run prisma generate
    ↓
restart dev server (Bun --hot does NOT hot-reload new generated files)
```

### Step-by-step

**1. Edit the schema**

Open `backend/prisma/schema.prisma` and make your changes — add a field, a model, an index, etc.

**2. `prisma migrate dev`**

```bash
bun --bun run prisma migrate dev --name add_watchlist_model
```

What happens internally:

1. Spins up a shadow database (or uses your configured `shadowDatabaseUrl`).
2. Replays all existing migrations on the shadow DB to determine the current "truth".
3. Diffs the shadow state against your new schema.
4. Generates a timestamped SQL file under `prisma/migrations/<timestamp>_<name>/migration.sql`.
5. Applies that SQL to your local dev database.
6. Records the migration in `_prisma_migrations`.

The generated file looks like:

```
backend/prisma/migrations/
├── 20240115120000_init/
│   └── migration.sql
├── 20240610090000_add_watchlist_model/
│   └── migration.sql
└── migration_lock.toml
```

Commit both the SQL files and `migration_lock.toml` — they are your migration history.

**3. `prisma generate`**

`migrate dev` in Prisma 7 does NOT reliably regenerate client artifacts on disk. Always run
`generate` explicitly:

```bash
bun --bun run prisma generate
```

This writes the typed client to `backend/prisma/generated/prisma/` (per the `output` in
`schema.prisma`). Import from there:

```typescript
import { PrismaClient } from "./prisma/generated/prisma/client.js"; // ESM .js required
```

**4. Restart the dev server**

Bun's `--hot` flag patches in-memory module changes but does NOT pick up newly written files in
the generated directory. After `generate`, kill and restart:

```bash
bun --hot backend/index.ts   # kill and re-run after generate
```

### `--create-only` — review before applying

When you want to inspect the SQL before it touches your database:

```bash
bun --bun run prisma migrate dev --name remove_legacy_field --create-only
# Review backend/prisma/migrations/<ts>_remove_legacy_field/migration.sql
# Apply when satisfied:
bun --bun run prisma migrate dev
```

### Naming conventions

- Use `snake_case` for `--name`: `add_gmail_connection`, `index_conversation_userid`.
- The name is appended to the timestamp — it's your changelog entry, not a code identifier.
- Bad names cost you: searching migration history later is much harder with names like `update1`.

---

## Production and CI

### `prisma migrate deploy`

The ONLY command to run against production or staging. It:

- Applies all pending migrations from `prisma/migrations/`.
- Updates `_prisma_migrations`.
- Never creates new migrations.
- Never prompts.
- Never uses a shadow database.
- Exits non-zero on failure — safe to gate deploys on.

```bash
bun --bun run prisma migrate deploy
```

**Vercel deployment**: add a `build` script that runs `migrate deploy` before the build, or
call it from your Vercel Build Command:

```json
// package.json (backend/)
"scripts": {
  "vercel-build": "prisma migrate deploy && prisma generate && tsc"
}
```

**GitHub Actions**:

```yaml
- name: Apply DB migrations
  run: bun --bun run prisma migrate deploy
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

**Feature flag**: always run `migrate status` before `migrate deploy` in CI to get a human-readable
audit log of what will change.

### `prisma migrate status`

Non-destructive — reports which migrations are pending, failed, or missing from the local directory.

```bash
bun --bun run prisma migrate status
```

Example output when everything is current:

```
Database schema is up to date!
```

Example output when a migration is pending:

```
Following migration have not yet been applied:
  20240610090000_add_watchlist_model

To apply migrations in development, run:
  prisma migrate dev

To apply migrations in production, run:
  prisma migrate deploy
```

Exit code is always `0` on success regardless of pending count. To detect pending migrations
programmatically, use `migrate diff --exit-code` instead (see below).

### `prisma migrate diff`

Compares two schema sources and prints the difference — either as a human-readable summary or as
executable SQL.

```bash
prisma migrate diff \
  --from-<source> [arg] \
  --to-<source>   [arg] \
  [--script]       # emit SQL instead of summary
  [--exit-code]    # exit 2 if changes exist; exit 0 if empty
```

**Sources:**

| Flag | What it points at |
|---|---|
| `--from-empty` / `--to-empty` | An empty schema |
| `--from-schema <path>` / `--to-schema <path>` | A `.prisma` file |
| `--from-migrations <path>` / `--to-migrations <path>` | A migrations directory |
| `--from-url <url>` / `--to-url <url>` | A live database URL |
| `--from-config-datasource` / `--to-config-datasource` | `prisma.config.ts` datasource |

**Common recipes:**

```bash
# Check if live DB matches the schema (CI drift detector, exit 2 = drift)
bun --bun run prisma migrate diff \
  --from-config-datasource \
  --to-schema ./prisma/schema.prisma \
  --exit-code

# Generate SQL to apply schema changes without `migrate dev` (escape hatch)
bun --bun run prisma migrate diff \
  --from-config-datasource \
  --to-schema ./prisma/schema.prisma \
  --script > /tmp/delta.sql

# Create a baseline migration file for an existing database
bun --bun run prisma migrate diff \
  --from-empty \
  --to-schema ./prisma/schema.prisma \
  --script > prisma/migrations/0000000000000_baseline/migration.sql
```

### `prisma migrate resolve`

A recovery tool that manually updates the `_prisma_migrations` tracking table. Use after a
migration fails in production or when baselining an existing database.

```bash
# Mark a migration as applied (baselining — "this SQL already ran, don't run it again")
bun --bun run prisma migrate resolve --applied 20240610090000_add_watchlist_model

# Mark a migration as rolled back (clear the failed state so it can be retried)
bun --bun run prisma migrate resolve --rolled-back 20240610090000_add_watchlist_model
```

**Production recovery sequence** after a failed `migrate deploy`:

1. Fix the root cause (bad SQL, schema error, network issue).
2. If the migration is marked failed and you want to retry it:
   ```bash
   bun --bun run prisma migrate resolve --rolled-back <migration_name>
   bun --bun run prisma migrate deploy
   ```
3. If you manually applied the SQL out-of-band and just need Prisma to acknowledge it:
   ```bash
   bun --bun run prisma migrate resolve --applied <migration_name>
   ```

**Baselining an existing database** (adopting Prisma Migrate on a DB that already has tables):

```bash
# 1. Generate a baseline migration file that reflects current state
bun --bun run prisma migrate diff \
  --from-empty \
  --to-schema ./prisma/schema.prisma \
  --script > prisma/migrations/0000000000000_baseline/migration.sql

# 2. Tell Prisma this migration has already been applied (don't run it)
bun --bun run prisma migrate resolve --applied 0000000000000_baseline

# 3. Verify
bun --bun run prisma migrate status
# → Database schema is up to date!
```

### `prisma migrate reset`

Drops the database, re-creates it, and replays all migrations from scratch.

```bash
bun --bun run prisma migrate reset          # prompts for confirmation
bun --bun run prisma migrate reset --force  # skips prompt (CI/scripts)
```

**DANGER — see [§ Supabase Extension-Drift Trap](#the-supabase-extension-drift-trap).** On
Supabase you must NEVER run `migrate reset` against your Supabase database. It will attempt to
drop and recreate the schema, which can destroy Supabase-managed metadata and extensions. Reserve
`migrate reset` exclusively for a local Postgres container in development.

**Legitimate uses:**

- Fresh local dev setup after pulling a branch with many accumulated migrations.
- CI: resetting an ephemeral local Postgres before running the backend test suite.

After reset, seed data must be run explicitly:

```bash
bun --bun run prisma migrate reset --force
bun --bun run prisma generate
bun --bun run prisma db seed
```

---

## DB utilities

### `prisma db push` — prototype without migration history

Syncs `schema.prisma` directly to the database without generating a migration file.

```bash
bun --bun run prisma db push
bun --bun run prisma generate
```

| Feature | `db push` | `migrate dev` |
|---|---|---|
| Creates migration files | No | Yes |
| Tracks history | No | Yes |
| Requires shadow DB | No | Yes |
| Can be rolled back | No | Yes (replay migrations) |
| Best for | Prototyping | All other cases |

`db push` is useful in the earliest phases of feature exploration — change the schema, push, try
the query, iterate. Once the shape stabilises, cut a proper migration with `migrate dev` and commit
it. Do not use `db push` against Supabase production or staging.

Flags:

```bash
bun --bun run prisma db push --accept-data-loss   # drop columns/tables without warning
bun --bun run prisma db push --force-reset        # wipe and rebuild (local only!)
```

### `prisma db pull` — introspect an existing database

Reads the live database schema and overwrites `schema.prisma` with the equivalent Prisma models.

```bash
bun --bun run prisma db pull           # overwrites schema.prisma
bun --bun run prisma db pull --print   # preview on stdout, no write
bun --bun run prisma db pull --force   # ignore existing schema, overwrite
```

**When to use in Lumina:**

- Supabase runs a migration manually via the dashboard (e.g., a Supabase Storage bucket table gets
  added). Run `db pull --print` to see what Prisma would infer, then manually merge any new models
  into `schema.prisma` rather than blindly overwriting (to preserve Lumina's custom mappings,
  comments, and the pgvector `Unsupported` annotation).

**Post-pull cleanup:** Prisma introspects table names as-is. You will usually need to:
- Rename models to PascalCase and add `@@map("original_name")`.
- Rename snake_case columns to camelCase and add `@map("original_col")`.
- Restore any `Unsupported("vector(1536)")` annotations that were lost.

### `prisma db execute` — run raw SQL against the configured datasource

```bash
bun --bun run prisma db execute --file ./script.sql
echo "TRUNCATE TABLE \"Message\";" | bun --bun run prisma db execute --stdin
```

Combine with `migrate diff` to apply generated SQL directly:

```bash
bun --bun run prisma migrate diff \
  --from-config-datasource \
  --to-schema ./prisma/schema.prisma \
  --script \
| bun --bun run prisma db execute --stdin
```

This is a power-user escape hatch. For application logic, always prefer typed Prisma Client
queries. For schema changes, prefer tracked migrations.

Flags:

| Flag | Description |
|---|---|
| `--file <path>` | Execute SQL from file |
| `--stdin` | Read SQL from stdin |
| `--config <path>` | Custom config path |

Note: `db execute` reports success/failure; it does not return row data. Use Prisma Studio or
`$queryRaw` in code to inspect rows.

### `prisma db seed` — populate development data

```bash
bun --bun run prisma db seed
```

Configure the seed command in `backend/prisma.config.ts`:

```typescript
migrations: {
  path: "prisma/migrations",
  seed: "bun run prisma/seed.ts",  // or "tsx prisma/seed.ts" if not using Bun runner
},
```

Seed scripts should be idempotent — use `upsert` so they can be re-run safely:

```typescript
// backend/prisma/seed.ts
import { PrismaClient } from "./generated/prisma/client.js";

const prisma = new PrismaClient();

async function main() {
  // Idempotent: upsert rather than create
  await prisma.user.upsert({
    where: { email: "dev@lumina.local" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "dev@lumina.local",
      name: "Dev User",
      provider: "Github",
      supabaseId: "supabase-dev-id",
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
```

Pass custom args to the seed script:

```bash
bun --bun run prisma db seed -- --environment staging
```

---

## Auxiliary commands

### `prisma generate`

Regenerates the Prisma Client from `schema.prisma`. Must be run:

- After every `migrate dev` (Prisma 7 does not auto-generate).
- After `db push` or `db pull` if schema changed.
- In CI before building, to ensure generated artifacts are current.

```bash
bun --bun run prisma generate
```

Lumina's generator block (`backend/prisma/schema.prisma`):

```prisma
generator client {
  provider            = "prisma-client"      // Prisma 7 — NOT "prisma-client-js"
  output              = "./generated/prisma"
  engineType          = "client"
  runtime             = "nodejs"             // Vercel Node serverless; Bun-compatible locally
  importFileExtension = "js"                 // ESM .js imports in generated code
}
```

The `importFileExtension = "js"` setting is critical for Vercel's strict ESM resolver. Without it,
the generated client uses `.ts` specifiers, which resolve fine under Bun but 404 at runtime on
Vercel's Node runtime.

After `generate`, import the client using `.js` extensions:

```typescript
import { PrismaClient } from "./prisma/generated/prisma/client.js";
```

Watch mode (auto-regenerates on schema save):

```bash
bun --bun run prisma generate --watch
```

### `prisma format`

Formats `schema.prisma` in place — indentation, spacing, missing back-relations, field order:

```bash
bun --bun run prisma format
```

Equivalent to Prettier for Prisma schemas, with semantic awareness. It also inserts missing
`@relation` arguments when you add a new relation and forget the fields/references side.

Run before committing schema changes to keep diffs clean.

### `prisma validate`

Checks `schema.prisma` for syntax errors and invalid model definitions without touching the
database or generating any artifacts:

```bash
bun --bun run prisma validate
```

Catches: missing `@relation` fields, invalid types, duplicate model names, syntax errors.

Useful in pre-commit hooks:

```bash
# .git/hooks/pre-commit (or husky / lefthook)
bun --bun run prisma validate && bun --bun run prisma format --check
```

### `prisma studio`

Launches a web-based database GUI at `http://localhost:5555`:

```bash
bun --bun run prisma studio
bun --bun run prisma studio --port 3001   # alternate port if 5555 collides
```

Useful for:

- Inspecting `CachedQuery` rows (though you can't edit the `embedding` vector column in the UI).
- Verifying `GmailConnection` records after an OAuth flow (never log or display the encrypted token
  fields — inspect only that the row exists).
- Spot-checking seed data.

**Never expose Studio publicly** — it has direct read/write access to the database. Run locally only.

---

## The shadow database

`prisma migrate dev` needs a _shadow database_ — a second, temporary Postgres database it controls
completely. Prisma uses it to:

1. Replay your committed migration history from scratch.
2. Diff the resulting state against your new `schema.prisma`.
3. Generate the SQL delta.
4. Destroy the shadow DB (or leave it for reuse).

The shadow DB must be owned by the same Postgres user and on the same server as your development
database. It must be empty and Prisma must have the ability to `DROP DATABASE` it.

**Supabase as shadow DB does NOT work** — Supabase does not grant the permissions needed for
Prisma to drop and recreate the shadow database. Use a local Postgres container for development:

```bash
# Local Postgres via Docker
docker run -d --name lumina-pg \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=lumina_dev \
  -p 5432:5432 \
  postgres:16

# .env (local dev only — never commit)
DATABASE_URL="postgresql://postgres:password@localhost:5432/lumina_dev"
# SHADOW_DATABASE_URL — Prisma creates it automatically on the same server
# if not specified; only needed if you want an explicit separate DB.
```

If you are pointing `DATABASE_URL` at Supabase for local development (common when seeding from the
real dataset), `migrate dev` will fail when it tries to create the shadow DB. Options:

1. Use a local Postgres and copy schema from Supabase using `db pull`.
2. Set `SHADOW_DATABASE_URL` to a separate Supabase database (a free project works) — Prisma will
   manage that shadow project instead.

```typescript
// backend/prisma.config.ts — with explicit shadow DB
datasource: {
  url: env("DATABASE_URL"),              // your real Supabase URL
  shadowDatabaseUrl: env("SHADOW_DATABASE_URL"),  // separate Supabase project or local PG
},
```

---

## THE SUPABASE EXTENSION-DRIFT TRAP

> This is the most Lumina-critical section. Violating it causes Prisma to threaten (or execute)
> a destructive database reset against your production Supabase instance.

### The problem

Supabase pre-installs several Postgres extensions when it provisions a project: `pgvector`,
`pg_stat_statements`, `uuid-ossp`, and others. If you add `extensions = [vector]` (or any
extension name) to the `datasource` block in `schema.prisma`, Prisma Migrate tracks extensions as
schema objects. On its next `migrate dev` or `migrate diff`, it finds extensions in the live
Supabase database that it has never seen in its own migration history — these look like "drift"
(manual database changes made outside Prisma). When drift is detected, `migrate dev` asks:

```
Drift detected: Your database schema is not in sync with your migration history.

We need to reset the database to apply the migrations.
Do you want to reset your database? All data will be lost. (y/N)
```

Saying yes wipes the database. Saying no halts the migration.

### Why Lumina is vulnerable

`backend/prisma/schema.prisma` uses `Unsupported("vector(1536)")` on `CachedQuery.embedding`
because the `vector` type is provided by the `pgvector` extension. The extension itself is managed
entirely by Supabase and MUST NOT appear in our schema's `datasource` block.

The schema comment says it plainly:

```prisma
// backend/prisma/schema.prisma
datasource db {
  provider = "postgresql"
  // NOTE: pgvector is enabled directly in Supabase (Dashboard → Database → Extensions,
  // or `CREATE EXTENSION vector`). We deliberately do NOT let Prisma manage extensions
  // (`extensions = [...]`) — on Supabase that makes `prisma migrate dev` flag Supabase's
  // own pre-installed extensions as "drift" and threaten a destructive reset.
}
```

### The rules

1. **Never add `extensions = [...]` to the `datasource db` block.** Not for `vector`, not for
   any other Supabase-managed extension.
2. **Never run `prisma migrate reset` against the Supabase URL.** Run it only against a local
   Postgres container.
3. **If `migrate dev` prompts about drift on extensions**: answer N (no), then investigate what
   extensions Prisma thinks it should manage. Remove them from the schema if present.
4. **To enable pgvector**: use the Supabase Dashboard → Database → Extensions → enable `vector`,
   or run `CREATE EXTENSION IF NOT EXISTS vector` via Supabase SQL editor. Prisma does not need
   to know.
5. **CachedQuery.embedding stays as `Unsupported("vector(1536)")`**: this annotation tells Prisma
   the column exists and has that type (so `migrate dev` won't try to drop it), but Prisma never
   generates typed accessors for it. Access is always via `$queryRaw`/`$executeRaw`.

### If you accidentally get drift warnings

If Prisma starts warning about extension drift, check your `schema.prisma` datasource block:

```bash
grep -n "extensions" backend/prisma/schema.prisma
```

If you see `extensions = [vector]` or similar, remove the entire `extensions` line and rerun
`migrate dev`. The warning should disappear.

If the drift is about other Supabase objects (e.g., Supabase Realtime tables, storage schema), use
`migrate diff` to inspect:

```bash
bun --bun run prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-config-datasource \
  --script
```

Review the output carefully before deciding whether it's safe to ignore (via `migrate resolve`)
or needs a new migration.

---

## Running via Bun

Lumina uses Bun as the runtime and package manager. The Prisma CLI must be invoked via
`bun --bun run prisma` (not `npx prisma`) to ensure it uses Bun's runtime rather than falling back
to Node for the CLI process. The comment at the top of `backend/prisma.config.ts` says:

```typescript
// This file was generated by Prisma, and assumes you run Prisma commands using
// `bun --bun run prisma [command]`.
```

**Correct invocations:**

```bash
bun --bun run prisma migrate dev --name <name>
bun --bun run prisma migrate deploy
bun --bun run prisma migrate status
bun --bun run prisma migrate diff --from-... --to-...
bun --bun run prisma generate
bun --bun run prisma db push
bun --bun run prisma db seed
bun --bun run prisma format
bun --bun run prisma validate
bun --bun run prisma studio
```

Or add scripts to `backend/package.json`:

```json
{
  "scripts": {
    "db:migrate": "bun --bun run prisma migrate dev",
    "db:deploy": "bun --bun run prisma migrate deploy",
    "db:generate": "bun --bun run prisma generate",
    "db:seed": "bun --bun run prisma db seed",
    "db:studio": "bun --bun run prisma studio"
  }
}
```

Then call them as `bun run db:migrate -- --name add_field`.

**Why `--bun`?**

Without `--bun`, `bun run` spawns a child process but lets the Prisma binary choose its own
runtime. On some systems Prisma's packaged binary invokes Node. `--bun` forces Bun's JS engine
for the entire process tree, which matters for ESM resolution consistency and for picking up
`prisma.config.ts` via Bun's TS loader without a separate compilation step.

---

## Full flag reference

### `prisma migrate dev`

| Flag | Description |
|---|---|
| `--name` / `-n <name>` | Name the generated migration (snake_case) |
| `--create-only` | Generate SQL file but do not apply |
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |
| `--url <url>` | Override datasource URL |

### `prisma migrate deploy`

| Flag | Description |
|---|---|
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |

### `prisma migrate status`

| Flag | Description |
|---|---|
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |

### `prisma migrate diff`

| Flag | Description |
|---|---|
| `--from-empty` | Source is an empty schema |
| `--from-schema <path>` | Source is a `.prisma` file |
| `--from-migrations <path>` | Source is a migrations directory |
| `--from-url <url>` | Source is a live database |
| `--from-config-datasource` | Source is `prisma.config.ts` datasource |
| `--to-*` | Same options as `--from-*` |
| `--script` | Output SQL instead of human summary |
| `--exit-code` | Exit 2 if changes found, 0 if none, 1 on error |
| `--config <path>` | Override config path |

### `prisma migrate resolve`

| Flag | Description |
|---|---|
| `--applied <migration>` | Mark migration as applied |
| `--rolled-back <migration>` | Mark migration as rolled back |
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |

### `prisma migrate reset`

| Flag | Description |
|---|---|
| `--force` / `-f` | Skip confirmation |
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |

### `prisma db push`

| Flag | Description |
|---|---|
| `--accept-data-loss` | Allow destructive changes |
| `--force-reset` | Drop and rebuild database |
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |
| `--url <url>` | Override datasource URL |

### `prisma db pull`

| Flag | Description |
|---|---|
| `--force` | Ignore existing schema, overwrite |
| `--print` | Print to stdout, do not write |
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |
| `--url <url>` | Override datasource URL |

### `prisma db execute`

| Flag | Description |
|---|---|
| `--file <path>` | SQL file to execute |
| `--stdin` | Read SQL from stdin |
| `--config <path>` | Override config path |

### `prisma db seed`

| Flag | Description |
|---|---|
| `--config <path>` | Override config path |
| `-- <args>` | Pass-through args to seed script |

### `prisma generate`

| Flag | Description |
|---|---|
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |
| `--watch` | Regenerate on schema changes |
| `--generator <name>` | Run a specific generator (repeatable) |
| `--sql` | Generate typed SQL module |
| `--no-hints` | Suppress hint messages |

### `prisma format`

| Flag | Description |
|---|---|
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |

### `prisma validate`

| Flag | Description |
|---|---|
| `--schema <path>` | Override schema path |
| `--config <path>` | Override config path |

### `prisma studio`

| Flag | Description |
|---|---|
| `--port` / `-p <port>` | Port (default 5555) |
| `--browser` / `-b <browser>` | Browser to open |
| `--config <path>` | Override config path |
| `--url <url>` | Override datasource URL |

---

## See also

**Same skill (prisma):**
- `references/upstream/prisma-cli/references/migrate-dev.md` — upstream source for `migrate dev` flags
- `references/upstream/prisma-cli/references/migrate-deploy.md` — upstream source for deploy flags
- `references/upstream/prisma-upgrade-v7/references/prisma-config.md` — Prisma v7 config migration guide
- `references/upstream/prisma-upgrade-v7/references/esm-support.md` — ESM/Bun specifics in v7

**Other skills:**
- `supabase` — Supabase client setup, auth, RLS; how `backend/client.ts` uses `createClient` for auth only
- `rag-retrieval` — How `CachedQuery` + pgvector is queried via `$queryRaw`; the semantic cache layer
- `backend-testing` — `backend/tests/helpers/prisma-fake.ts` test seam; how to mock the Prisma client in unit tests
- `connectors-oauth` — `GmailConnection` model usage; encrypted refresh token storage pattern
- `redis` — Upstash cache layer (`backend/lib/cache.ts`) that sits in front of the database
- `lumina-frontend` — TanStack Query hooks that consume the backend APIs backed by Prisma
- `finance-markets` — Finance routes that read from the database for watchlist/portfolio models
