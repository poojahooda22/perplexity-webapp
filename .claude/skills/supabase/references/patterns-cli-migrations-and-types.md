# Supabase CLI: Local Dev Stack, Extensions, Type Generation, and the Prisma Division

> The Supabase CLI manages the local Docker stack, enables Postgres extensions (pgvector), and
> generates TypeScript types for any code that calls supabase-js directly. In Lumina it does
> **not** own migrations or the typed data layer — Prisma owns those. This reference covers how
> the two tools coexist without fighting over the schema.

---

## Table of Contents

1. [The Lumina Division: Prisma vs the Supabase CLI](#1-the-lumina-division-prisma-vs-the-supabase-cli)
2. [Installing and Pinning the CLI](#2-installing-and-pinning-the-cli)
3. [`supabase init` and `config.toml`](#3-supabase-init-and-configtoml)
4. [The Local Stack: `start`, `stop`, Studio, `status`](#4-the-local-stack-start-stop-studio-status)
5. [Local Keys, URLs, and Env Wiring for Lumina](#5-local-keys-urls-and-env-wiring-for-lumina)
6. [Enabling Extensions — pgvector](#6-enabling-extensions--pgvector)
7. [Supabase Migrations vs Prisma Migrations: the Drift Caution](#7-supabase-migrations-vs-prisma-migrations-the-drift-caution)
8. [Linking a Hosted Project](#8-linking-a-hosted-project)
9. [`db diff` and `db push` — When and When Not To Use Them](#9-db-diff-and-db-push--when-and-when-not-to-use-them)
10. [Branching and Preview Environments](#10-branching-and-preview-environments)
11. [`gen types typescript` — The Generated `Database` Type](#11-gen-types-typescript--the-generated-database-type)
12. [Committing and Regenerating Types](#12-committing-and-regenerating-types)
13. [Seeding for Local Dev and Tests](#13-seeding-for-local-dev-and-tests)
14. [Command Reference Table](#14-command-reference-table)
15. [Anti-Patterns](#15-anti-patterns)
16. [See also](#16-see-also)

---

## 1. The Lumina Division: Prisma vs the Supabase CLI

This is the single most important fact for working on this repo. **Lumina's schema is owned by
Prisma, not the Supabase CLI.**

```
┌──────────────────────────────────────────────────┐
│  Prisma (the data authority)                     │
│  backend/prisma/schema.prisma                    │
│  backend/prisma/migrations/                      │
│  → prisma migrate dev / deploy                   │
│  → generates: backend/prisma/generated/prisma/   │
│  → owns: User, Conversation, Message,            │
│           CachedQuery, GmailConnection           │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  Supabase CLI (the platform toolbox)             │
│  supabase/  (if initialised)                     │
│  → supabase start/stop/status   local dev stack  │
│  → CREATE EXTENSION vector      pgvector         │
│  → supabase gen types …         types for auth   │
│  → supabase link/push           ONLY for non-    │
│                                 Prisma-owned DDL │
└──────────────────────────────────────────────────┘
```

**What Prisma handles:**

- Every persistent table — `User`, `Conversation`, `Message`, `CachedQuery`, `GmailConnection`.
  See `backend/prisma/schema.prisma:27-111`.
- Migration files live in `backend/prisma/migrations/`, not in `supabase/migrations/`.
- `backend/db.ts` is the only place `PrismaClient` is instantiated:
  ```ts
  // backend/db.ts
  import { PrismaClient } from "./prisma/generated/prisma/client.js";
  import { PrismaPg } from "@prisma/adapter-pg";
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  export const prisma = new PrismaClient({ adapter });
  ```
- Never use `supabase.from(...)` to read or write application data — that is the **supabase skill**
  Non-Negotiable #1.

**What the Supabase CLI handles:**

- Booting the local Postgres + Auth + Realtime + Studio stack for development.
- Enabling Postgres extensions that Prisma cannot safely manage (see §6).
- Generating TypeScript types for the small set of code that calls `supabase-js` directly
  (the auth client in `backend/client.ts`, any future direct-client hooks in the frontend).
- Optional branching / preview environments.

**The boundary in `backend/client.ts`:**

```ts
// backend/client.ts — the ONLY supabase-js client in the backend
// Used exclusively for auth.getUser(token) — JWT validation.
// Prisma owns all persistent data; this client NEVER queries tables.
export function createSupabaseClient() {
  const key = process.env.SUPABASE_API_SECRET ?? process.env.SUPABASE_KEY;
  if (!key) throw new Error("Supabase key missing …");
  return createClient(SUPABASE_URL, key);
}
```

The auth middleware (`backend/auth.ts:35-81`) calls `getClient().auth.getUser(token)`, then hands
`req.userId` to every downstream route. Data reads/writes flow through `prisma` (imported from
`backend/db.ts`), never through `supabase.from(...)`.

---

## 2. Installing and Pinning the CLI

Install as a **dev dependency** so every contributor and CI runner gets the same version, pinned in
the lockfile. Do not install globally with `npm i -g supabase` — that version floats and diverges
across machines.

```bash
# In the repo root (or wherever supabase/ lives)
bun add -d supabase@latest   # pin to a specific version in practice
# or: npm install --save-dev supabase@2.x.x
```

```jsonc
// package.json — handy scripts
{
  "devDependencies": {
    "supabase": "2.x.x"
  },
  "scripts": {
    "sb:start":  "supabase start",
    "sb:stop":   "supabase stop",
    "sb:status": "supabase status",
    "sb:types":  "supabase gen types typescript --local > frontend/src/types/database.types.ts"
  }
}
```

**Prerequisite:** Docker Desktop (or OrbStack / Rancher Desktop) must be running. The local stack
is a set of Docker containers; `supabase start` fails fast if the daemon is unreachable.

**Windows note (PowerShell 5.1):** `>` redirects UTF-16 by default. For the types script:

```powershell
npx supabase gen types typescript --local | Out-File -Encoding utf8 frontend/src/types/database.types.ts
```

PowerShell 7+ and Bash write UTF-8 with `>` so the plain redirect is fine there.

---

## 3. `supabase init` and `config.toml`

`supabase init` scaffolds a `supabase/` directory at the repo root. Run it once, commit the result.

```bash
npx supabase init
```

```
supabase/
├── config.toml          # local stack + project config (committed)
├── seed.sql             # optional local fixtures (committed)
├── migrations/          # Supabase-managed schema migrations
│   └── .gitkeep         # empty in Lumina — Prisma owns migrations
└── .gitignore           # ignores .branches/, .temp/
```

Key sections of `config.toml` to configure for Lumina:

```toml
project_id = "lumina"      # Docker project namespace; keep it short

[db]
port = 54322               # local Postgres port (psql, Prisma DATABASE_URL)
shadow_port = 54320        # used by db diff to materialise the desired schema
major_version = 15         # MUST match your hosted project's Postgres major

[api]
port = 54321               # local API gateway (PostgREST/Auth/Realtime)
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]

[studio]
enabled = true
port = 54323

[auth]
# Point at the Vite dev server so OAuth redirect resolves locally.
site_url = "http://localhost:5173"
additional_redirect_urls = ["http://localhost:5173/**"]
jwt_expiry = 3600
enable_signup = true

[auth.email]
enable_confirmations = false  # off locally so signup is instant; ON in production

[auth.external.github]
enabled = false               # enable only when testing the OAuth flow

[auth.external.google]
enabled = false               # same

[db.seed]
enabled = true
sql_paths = ["./seed.sql"]    # see §13
```

Two settings that break silently when wrong:

1. **`[db].major_version`** must equal the hosted project's Postgres major (Dashboard → Settings →
   Database). A mismatch means `db reset` passes locally on the wrong engine and then fails on push.
2. **`[auth].site_url` / `additional_redirect_urls`** must include `http://localhost:5173` so
   Google/GitHub OAuth redirect to the Vite dev server locally. The hosted equivalents are configured
   separately per environment in the Supabase Dashboard — they do not come from `config.toml`.

---

## 4. The Local Stack: `start`, `stop`, Studio, `status`

`supabase start` boots the full Supabase platform as local Docker containers — the same services
that run in the cloud. What passes locally (Auth JWTs, Realtime channels, RLS) is a faithful preview
of production behavior.

```bash
npx supabase start          # first run pulls images (slow); subsequent runs are fast
npx supabase stop           # stop containers; local DB volume preserved
npx supabase stop --no-backup  # stop AND wipe local data (clean slate next start)
npx supabase status         # print local URLs + keys
```

Services and their local ports:

| Service | Port | Relevance to Lumina |
|---------|------|---------------------|
| **Postgres** | `:54322` | `DATABASE_URL` for Prisma + `psql` + pgvector |
| **API gateway** | `:54321` | `SUPABASE_URL` for `createClient` |
| **GoTrue (Auth)** | via gateway | `auth.getUser(token)` + sign-in flow |
| **Realtime** | via gateway | Live price ticks (`worker/` → Realtime → `use-live-prices.ts`) |
| **Studio** | `:54323` | Visual schema explorer, SQL playground |
| **Inbucket** | `:54324` | Catches magic-link / OTP emails locally |

```bash
# Start only the services Lumina needs during a backend-only session
npx supabase start -x realtime,storage-api,imgproxy

# Connect to local Postgres directly (Prisma migrations, psql inspection)
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

**Studio** (`http://localhost:54323`) is for **exploration** — inspect the schema, draft a query,
view Realtime channel events. Do not author schema changes in Studio and expect them to persist;
`supabase stop --no-backup` wipes them. For Prisma-owned tables: schema changes go in
`backend/prisma/schema.prisma` → `prisma migrate dev`. For Supabase-owned DDL (extensions,
functions you manage via the CLI): use `migration new` + `db push` (see §9).

---

## 5. Local Keys, URLs, and Env Wiring for Lumina

`supabase status` prints deterministic, well-known, non-secret demo credentials — identical for
every Supabase developer. Safe to commit to a local-only `.env`.

```bash
npx supabase status
```

```text
         API URL: http://127.0.0.1:54321
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
    Inbucket URL: http://127.0.0.1:54324
      JWT secret: super-secret-jwt-token-with-at-least-32-characters-long
        anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<local-anon>...
service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<local-service-role>...
```

Wire these into environment files, respecting Lumina's strict server/client split:

```bash
# .env  (server-only — Express backend; NEVER commit production values)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_API_SECRET=<local-service-role-key>   # or SUPABASE_KEY for the anon key

# .env.local  (Vite frontend — only public values; Vite inlines VITE_* into the bundle)
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<local-anon-key>
```

**Never** give `SUPABASE_API_SECRET` (the service-role key) a `VITE_` prefix. Vite inlines every
`VITE_*` variable into the browser bundle. The local key is harmless, but the variable *name* is
reused in production — the moment someone pastes the prod service-role key next to a `VITE_` prefix
it ships to every visitor and bypasses RLS on the entire database.

`backend/client.ts:14` reads: `const key = process.env.SUPABASE_API_SECRET ?? process.env.SUPABASE_KEY`.
Either key authenticates `auth.getUser` — the service-role key is used only because it was already
available, not for any RLS-bypass purpose (Lumina enforces authz in Express + Prisma, not RLS).

For CI scripts:

```bash
# Extract values without reading the status output manually
npx supabase status -o json | jq -r '.ANON_KEY'
npx supabase status -o env   # KEY=VALUE lines, sourceable in shell
```

---

## 6. Enabling Extensions — pgvector

Lumina uses `pgvector` for the semantic cache — the `CachedQuery.embedding` column
(`backend/prisma/schema.prisma:63`, typed `Unsupported("vector(1536)")`) stores 1536-dimensional
embeddings and is queried via cosine distance (`<=>`) through raw SQL.

### Why Prisma cannot manage this extension

`backend/prisma/schema.prisma:19-21` carries a critical comment:

```
// NOTE: pgvector is enabled directly in Supabase (Dashboard → Database → Extensions,
// or `CREATE EXTENSION vector`). We deliberately do NOT let Prisma manage extensions
// (`extensions = [...]`) — on Supabase that makes `prisma migrate dev` flag Supabase's
// own pre-installed extensions as "drift" and threaten a destructive reset.
```

If you add `extensions = [vector]` to the Prisma datasource block, `prisma migrate dev` sees the
gap between "what Prisma knows it installed" and "what Supabase already has" as unmanaged drift and
generates a destructive migration to drop and recreate it. **Never let Prisma manage extensions on
a Supabase-hosted database.**

### Enabling pgvector in production (hosted)

In the Supabase Dashboard: Database → Extensions → search "vector" → Enable.

Or via the SQL editor / a one-off migration:

```sql
create extension if not exists vector
  with schema extensions;   -- Supabase convention: extensions live in the extensions schema
```

### Enabling pgvector locally (Supabase CLI)

The local Docker stack comes with pgvector available but not enabled. Enable it once with a Supabase
migration or directly via `psql`:

```bash
# Option A — hand-authored Supabase migration (persists across db reset)
npx supabase migration new enable_pgvector
```

```sql
-- supabase/migrations/20260601000000_enable_pgvector.sql
create extension if not exists vector
  with schema extensions;
```

```bash
npx supabase db reset   # applies the migration; pgvector is now available locally
```

```bash
# Option B — direct psql (lost on the next supabase stop --no-backup)
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "create extension if not exists vector with schema extensions;"
```

Option A is preferred — it survives `db reset` and documents the dependency. After the extension
is enabled, Prisma's `prisma migrate dev` creates the `CachedQuery` table with the
`Unsupported("vector(1536)")` column normally; Postgres understands the `vector` type.

### Verifying the extension is active

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select extname, extversion from pg_extension where extname = 'vector';"
#  extname │ extversion
# ─────────┼────────────
#  vector  │ 0.8.0
```

---

## 7. Supabase Migrations vs Prisma Migrations: the Drift Caution

Two migration systems running against the same database will fight each other unless their
boundaries are explicit. In Lumina:

```
Prisma owns:
  backend/prisma/migrations/          ← bun --bun prisma migrate dev
  → all application tables (User, Conversation, Message, CachedQuery, GmailConnection)
  → enum types (MessageRole, AuthProvider)
  → indexes on Prisma-defined columns

Supabase CLI owns (if anything):
  supabase/migrations/                ← supabase db push
  → extensions (vector) — though we use psql/dashboard instead
  → functions / triggers Prisma can't express
  → RLS policies — if you ever expose a table via supabase-js (see SKILL.md rule #10)
```

**The drift rule:** never author a Supabase migration that touches a table Prisma manages, and
never add a Prisma migration that touches an extension or function the CLI manages. The two systems
record what they've applied in separate internal tables (`supabase_migrations.schema_migrations` vs
Prisma's `_prisma_migrations`), so each only sees its own history. A table that both tools try to
CREATE or ALTER will conflict at deploy time.

**Practical consequence for Lumina today:** `supabase/migrations/` is empty (or contains only the
pgvector extension migration). All schema history is in `backend/prisma/migrations/`. Do not run
`supabase db push` to deploy application schema — run `prisma migrate deploy` (or
`bun --bun prisma migrate deploy`) in CI.

If you use `supabase db diff` after running `prisma migrate dev`, the diff will show every
Prisma-managed table as "new" from the Supabase CLI's perspective (because the CLI has no record of
those migrations). Running `db push` in that state would re-issue Prisma's CREATE TABLE statements,
which will fail with "relation already exists". **Do not run `db push` against the Prisma-owned
tables.**

---

## 8. Linking a Hosted Project

Linking associates the local repo with a hosted Supabase project so `db push`, `gen types --linked`,
and `db diff --linked` know which remote to target.

```bash
# Link to the hosted project (project ref in Dashboard → Settings → General)
npx supabase link --project-ref abcdefghijklmnop

# CI / non-interactive — use env vars instead of interactive prompts
SUPABASE_ACCESS_TOKEN="sbp_..." \
SUPABASE_DB_PASSWORD="..." \
npx supabase link --project-ref "$PROJECT_REF"
```

After linking:

```bash
# Check what the CLI sees on the remote vs local migration files
npx supabase migration list

# Generate types from the live hosted database (useful right after a Prisma deploy)
npx supabase gen types typescript --linked > frontend/src/types/database.types.ts
```

**One link at a time.** The link is stored in `supabase/.temp/` (gitignored). In CI, pass
`--project-ref` / `--db-url` explicitly so operations are stateless and unambiguous across staging
and production environments.

---

## 9. `db diff` and `db push` — When and When Not To Use Them

### `db diff`

`db diff` compares two schemas and emits the DDL delta. It is useful for:

- Capturing something you typed in Studio or `psql` that is **not Prisma-managed** (a function,
  trigger, or extension) into a Supabase migration file.
- Checking drift between local and remote for the subset of DDL the CLI tracks.

```bash
npx supabase db diff -f enable_pgvector --schema public
# → creates supabase/migrations/<timestamp>_enable_pgvector.sql
```

**Never run `db diff` to capture Prisma-owned tables.** The diff will show every table as new
because the CLI has no record of Prisma's migrations. Review the output; every `create table` for a
Prisma-managed table should be deleted before committing.

### `db push`

`db push` applies Supabase migrations to the linked remote. In Lumina, the only Supabase migrations
that should exist are non-Prisma DDL (extensions, helper functions, triggers). Prisma schema reaches
production via `prisma migrate deploy`, not `db push`.

```bash
# Dry-run first — see what would be applied
npx supabase db push --dry-run

# Apply pending Supabase migrations (extensions, functions — NOT Prisma tables)
npx supabase db push
```

### `db reset` (local only)

`db reset` drops and recreates the local database, replaying all Supabase migrations and the seed.
Because Prisma migrations live in a separate directory, you need to re-apply them afterwards:

```bash
npx supabase db reset          # wipes and replays supabase/migrations/ + seed.sql
bun --bun prisma migrate dev   # re-applies backend/prisma/migrations/
```

Keep a local Makefile or npm script that runs both steps so the local stack is always in sync:

```bash
# package.json script
"db:reset:full": "supabase db reset && bun --bun prisma migrate dev --name reset"
```

---

## 10. Branching and Preview Environments

Supabase **Branching** gives each git branch (or PR) its own isolated ephemeral Supabase instance,
created by replaying `supabase/migrations/` and `seed.sql`. It integrates with the same GitHub flow
Vercel uses for frontend previews.

```toml
# supabase/config.toml
[branching]
default_branch = "main"

[db.seed]
enabled = true
sql_paths = ["./seed.sql"]
```

**Important for Lumina:** a preview branch runs your *Supabase* migrations, not your Prisma
migrations. If you add a Prisma-managed table and want it present in the preview branch, you need
to either:

1. Also have a Supabase migration that creates the same table (duplication — avoid), or
2. Run `prisma migrate deploy` as a CI step that targets the preview branch's `DATABASE_URL` after
   the branch provisions.

Option 2 is the correct approach and requires the preview branch's `DATABASE_URL` to be injected
into the `prisma migrate deploy` step. Supabase exposes per-branch credentials through the Vercel
integration — wire them accordingly.

The frontend preview deploy should point `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at the
preview branch's API URL (automatically injected by the Supabase–Vercel integration). The Vercel
serverless routes pick up `DATABASE_URL` for Prisma and `SUPABASE_URL`/`SUPABASE_API_SECRET` for
auth from per-branch environment variables.

---

## 11. `gen types typescript` — The Generated `Database` Type

`gen types typescript` introspects the schema and emits a `Database` TypeScript type describing
every table, view, function, and enum. In Lumina this is primarily useful for:

- **Typing the auth client** — though `auth.getUser` returns Supabase's own internal types, not
  `Database`, so this matters mainly if you ever call `supabase.from(...)` (which the backend never
  does for app data, but the frontend might for public/Realtime data).
- **Documenting the schema** in code — a snapshot of all tables derived from the live DB.
- **Future direct-client paths** — if a new feature writes directly through supabase-js rather than
  through Prisma (e.g. a Storage RLS-guarded upload), the generated types make that client
  type-safe.

```bash
# From the local Docker stack (fast; no network)
npx supabase gen types typescript --local > frontend/src/types/database.types.ts

# From the linked remote (after prisma migrate deploy has applied the latest schema)
npx supabase gen types typescript --linked > frontend/src/types/database.types.ts

# From a specific project ref — CI without a persistent link
npx supabase gen types typescript \
  --project-id "$PROJECT_REF" \
  --schema public \
  > frontend/src/types/database.types.ts
```

| Flag | Source | Use when |
|------|--------|----------|
| `--local` | Running local Docker DB | Day-to-day dev after `db reset` + `prisma migrate dev` |
| `--linked` | Currently linked remote | After `prisma migrate deploy` on the remote |
| `--project-id <ref>` | A specific hosted project | CI / multi-env scripts |
| `--db-url <url>` | Any Postgres connection string | Targeting an arbitrary DB |

The generated file shape (excerpt from the Lumina schema):

```ts
// frontend/src/types/database.types.ts  — GENERATED, do not edit by hand
export type Database = {
  public: {
    Tables: {
      "User": {
        Row: {
          id: string;
          email: string;
          name: string;
          createdAt: string;
          updatedAt: string;
          provider: "Github" | "Google";
          supabaseId: string;
        }
        Insert: { id?: string; email: string; name: string; provider: "Github" | "Google"; supabaseId: string; createdAt?: string; updatedAt?: string }
        Update: { id?: string; email?: string; name?: string; provider?: "Github" | "Google"; supabaseId?: string; createdAt?: string; updatedAt?: string }
        Relationships: []
      }
      "GmailConnection": {
        Row: {
          id: string; userId: string; googleEmail: string;
          refreshTokenEnc: string; iv: string; authTag: string;
          scopes: string; createdAt: string; updatedAt: string;
        }
        Insert: { /* ... */ }
        Update: { /* ... */ }
        Relationships: [
          { foreignKeyName: "GmailConnection_userId_fkey"; columns: ["userId"];
            referencedRelation: "User"; referencedColumns: ["id"] }
        ]
      }
      // … Conversation, Message, cached_query …
    }
    Enums: {
      MessageRole: "user" | "Assistant"
      AuthProvider: "Github" | "Google"
    }
  }
}
```

Consume it in any direct-client code:

```ts
// frontend/src/lib/supabase.ts  (if a typed client is needed on the frontend)
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

// Every .from() query is now typed:
const { data, error } = await supabase
  .from("User")
  .select("id, email")
  .eq("id", userId);
// data: { id: string; email: string }[] | null
// error: PostgrestError | null   — supabase-js NEVER throws, always check error
```

Because Prisma generates its own fully-typed client from the schema (`backend/prisma/generated/
prisma/client.js`), the Supabase `Database` type is a secondary artifact — useful as documentation
and for direct-client code, but not the primary type safety mechanism for backend data access.

---

## 12. Committing and Regenerating Types

The generated `database.types.ts` is a **build artifact that must be committed** to git. The same
reasons apply in Lumina as in any Supabase project:

- Fresh `npm install` + `tsc` works without a running database.
- The PR diff of `database.types.ts` makes schema changes visible to reviewers.
- Migration + types are reviewed as one atomic change.

**Regenerate every time the schema changes** — after every `prisma migrate dev` (which changes the
underlying Postgres schema, so the generated types diverge):

```bash
# Mandatory two-step after any prisma migration
bun --bun prisma migrate dev --name <migration_name>
npx supabase gen types typescript --local > frontend/src/types/database.types.ts
git add backend/prisma/migrations/ frontend/src/types/database.types.ts
git commit -m "feat(db): add <feature> and regenerate types"
```

Automate it so it is never forgotten:

```jsonc
// package.json
{
  "scripts": {
    "db:migrate": "bun --bun prisma migrate dev",
    "db:types":   "supabase gen types typescript --local > frontend/src/types/database.types.ts",
    "db:schema":  "bun run db:migrate && bun run db:types"
  }
}
```

A CI gate that catches stale types:

```yaml
# .github/workflows/supabase.yml  (add to the existing CI job)
- name: Verify committed types match schema
  run: |
    npx supabase gen types typescript --local > /tmp/fresh.types.ts
    diff frontend/src/types/database.types.ts /tmp/fresh.types.ts \
      || (echo "::error::database.types.ts is stale — run bun run db:types and commit" && exit 1)
```

The cardinal sin: **editing the generated file by hand.** It is overwritten on every regeneration;
a hand edit papers over a real schema/code mismatch. If a generated type is wrong, change the
schema in `backend/prisma/schema.prisma` (a new migration), regenerate, and commit. The file should
carry a `// GENERATED — do not edit` banner; treat it as read-only.

---

## 13. Seeding for Local Dev and Tests

Seeds populate the freshly reset local database with representative data. Configured in
`supabase/config.toml` and applied by `supabase db reset` and `supabase start`.

```toml
# supabase/config.toml
[db.seed]
enabled = true
sql_paths = ["./seed.sql"]
```

A minimal Lumina seed that creates the auth-layer users Prisma's `User.upsert` will then mirror:

```sql
-- supabase/seed.sql
-- Local development + test fixtures. Idempotent. Fixed UUIDs for deterministic tests.

-- 1) Create Supabase auth users. The auth middleware (backend/auth.ts:55-67)
--    upserts these into the public.User table on first request.
--    Seeds must insert into auth.users so the JWT the test signs is valid.
insert into auth.users (
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, aud, role
)
values
  (
    '00000000-0000-0000-0000-000000000001',
    'alice@example.com',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider":"google"}',
    '{"full_name":"Alice Test"}',
    'authenticated',
    'authenticated'
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    'bob@example.com',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider":"github"}',
    '{"full_name":"Bob Test"}',
    'authenticated',
    'authenticated'
  )
on conflict (id) do nothing;

-- NOTE: the public.User rows are NOT inserted here — the auth middleware handles
-- that idempotently via prisma.user.upsert on first request, which is the correct
-- production path. Seeding them here would duplicate a concern better owned by
-- the application itself.
```

Seed discipline:

| Rule | Why |
|------|-----|
| **Fixed UUIDs** in auth seeds | Tests can assert on known `sub` values in JWTs |
| **`on conflict do nothing`** | Seed is idempotent — safe if `supabase start` runs it multiple times |
| **Seed `auth.users`, not app tables** | App table rows are upserted by the auth middleware on first request |
| **Seeds are local/test only** | Never seed a production database; prod data comes from real usage |
| **Keep seeds in sync with the schema** | A seed that references a dropped column breaks `db reset` |

For integration tests, the `backend/tests/helpers/supabase-fake.ts` seam mocks `auth.getUser`
rather than requiring a running Supabase stack — see the **backend-testing** skill.

---

## 14. Command Reference Table

| Command | What it does | Lumina when |
|---------|-------------|-------------|
| `supabase init` | Scaffold `supabase/` directory | Once per repo, if not already done |
| `supabase start [-x service,…]` | Boot the local Docker stack | Start of every dev session |
| `supabase stop [--no-backup]` | Stop the stack (`--no-backup` wipes local data) | End of session |
| `supabase status [-o json\|env]` | Print local URLs, keys, ports | Get `DATABASE_URL` + `SUPABASE_URL` for `.env` |
| `supabase migration new <name>` | Create empty timestamped migration in `supabase/migrations/` | Non-Prisma DDL only (extensions, functions) |
| `supabase db diff -f <name> [--schema]` | Emit DDL delta → migration file | Capture ad-hoc extension/function changes |
| `supabase db reset [--no-seed]` | Drop, replay Supabase migrations, run seed | Then follow with `prisma migrate dev` |
| `supabase db push [--dry-run]` | Apply Supabase migrations to remote | Extensions/functions only — NOT Prisma tables |
| `supabase db pull [--schema]` | Capture remote schema into a migration | Adoption only (existing Studio-built schema) |
| `supabase db lint [--level]` | Static schema checks (RLS, `search_path`) | CI gate |
| `supabase link --project-ref <ref>` | Associate repo with hosted project | Per environment / machine |
| `supabase migration list` | Compare local vs remote history | Detect divergence after ad-hoc remote changes |
| `supabase migration repair <v> --status applied\|reverted` | Fix recorded history (not schema) | Reconcile after out-of-band remote change |
| `supabase gen types typescript --local\|--linked\|--project-id` | Generate `Database` type | After every `prisma migrate dev` |
| `supabase functions new\|serve\|deploy` | Edge Function authoring/deployment | If Edge Functions are added |
| `supabase secrets set\|list\|unset` | Per-env function secrets | Edge Function env — NOT app secrets (those go in Vercel) |

---

## 15. Anti-Patterns

**Running `supabase db push` to deploy Prisma-managed tables.**
Every application table (`User`, `Conversation`, etc.) is managed by Prisma. The Supabase CLI has
no record of those migrations. Running `db push` either does nothing (if the CLI sees the tables
as already present and out of scope) or re-issues `CREATE TABLE` statements that fail with
"relation already exists." Application schema deployment is `prisma migrate deploy` — only.

**Adding `extensions = [vector]` to the Prisma datasource block.**
`backend/prisma/schema.prisma:19-21` explicitly warns against this: Prisma flags Supabase's own
pre-installed extensions as "drift" and generates a destructive migration threatening a reset.
Enable `vector` in the Supabase Dashboard or via `CREATE EXTENSION` in a Supabase migration; keep
Prisma out of extension management entirely.

**Editing `database.types.ts` by hand.**
It's a generated artifact. Hand edits are erased on the next `gen types` run. If a type is wrong,
change the schema (Prisma migration or Supabase migration, depending on what owns the object) and
regenerate.

**Forgetting to regenerate types after a Prisma migration.**
The committed `database.types.ts` drifts from the live schema. Frontend code type-checks against
a stale shape — dropped columns compile, new columns error. Make `bun run db:schema` (migrate +
regen) the standard post-schema workflow step, and add a CI diff gate (§12).

**Using `supabase.from('User')` in the backend to read application data.**
`backend/client.ts` is used solely for `auth.getUser(token)`. Persistence flows through Prisma
(`backend/db.ts`). Mixing the two creates two sources of truth for the same data and bypasses
Prisma's type-safe query layer.

**Keeping a stale `config.toml` `[db].major_version` after a Postgres upgrade.**
Mismatched major versions mean `db reset` runs on the wrong engine. Version-specific SQL passes
locally and fails on the hosted database (or vice versa). After a Postgres upgrade, update
`major_version` and run `db reset` to re-validate the full migration history.

**Running `db push` against the production database by hand from a developer machine.**
Schema should only reach production through CI after a `--dry-run` review gate — never from a
developer laptop with locally staged migrations that may differ from the merged branch.

**Putting application secrets in `config.toml` or Supabase migration files.**
`config.toml` is committed to git. Supabase migration files are committed to git. OAuth client
secrets, Stripe keys, encryption keys for `GmailConnection.refreshTokenEnc` — none of these belong
in either. Use `env(VAR)` interpolation in `config.toml` and Vercel/Fly environment variables for
application secrets.

**Running `supabase db diff --linked` and committing the output without reviewing it.**
The diff against the linked remote will include every Prisma-managed table as an "add" (the CLI has
no record of those migrations). Blindly committing and pushing would attempt to re-CREATE those
tables, which fails at deploy time with a "relation already exists" error. Always review `db diff`
output; delete any CREATE TABLE for Prisma-owned tables before committing.

---

## 16. See also

**Sibling references in the supabase skill:**
- `lumina-supabase-in-this-repo.md` — how Lumina actually uses Supabase: `client.ts`, `auth.ts`,
  the Prisma/Supabase division, `supabaseId`, providers, the `supabase-fake` seam.
- `lumina-supabase-realtime-prices.md` — the live-price path (`worker/` → Realtime → `use-live-prices.ts`).
- `theory-supabase-architecture.md` — Postgres-as-platform, PostgREST, GoTrue, keys, JWT.

**Other skills:**
- **prisma** — migrations, schema, `PrismaClient`, `$queryRaw` for pgvector; owns `backend/prisma/`.
- **rag-retrieval** — the cosine search algorithm against `CachedQuery.embedding` (pgvector `<=>`),
  threshold tuning, chunking, reranking; the skill that uses the `vector` extension this doc enables.
- **finance-markets** — what data flows through the Realtime channel this doc's local stack boots.
- **connectors-oauth** — the Gmail OAuth grant (a separate Google OAuth flow, not Supabase auth).
- **backend-testing** — `supabase-fake.ts` test seam; mocking `auth.getUser` in unit tests without a
  running Supabase stack.
- **lumina-frontend** — frontend sign-in UI components, `VITE_SUPABASE_*` env consumption.
- **ai-sdk-agent** — the streaming wire protocol the backend routes serve after JWT validation.
