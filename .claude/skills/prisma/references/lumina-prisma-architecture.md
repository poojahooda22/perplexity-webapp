# Lumina — Prisma Architecture

> File-cited map of how Prisma 7 + Supabase Postgres backs Lumina's backend: wiring, schema, query sites, migrations, and the sharp edges you will hit in this repo.

---

## 1. The wiring map: request → database

Every authenticated backend route reaches Postgres through a single module-level `PrismaClient` instance exported from `backend/db.ts`. There is exactly one client in the process; nothing else calls `new PrismaClient()`.

```ts
// backend/db.ts (full file — 11 lines)
import { PrismaClient } from "./prisma/generated/prisma/client.js";   // line 1
import { PrismaPg } from "@prisma/adapter-pg";                        // line 2

const adapter = new PrismaPg({                                         // line 5
    connectionString: process.env.DATABASE_URL
});

export const prisma = new PrismaClient({ adapter });                   // line 9
```

`backend/db.ts:9`

Key design choices:

- **Single module-level instance.** On Vercel, each serverless invocation is a separate Node process, so there is no risk of connection-pool exhaustion from many simultaneous instances on the same machine. The `PrismaClient` constructor is cheap here; do not add pooling indirection (PgBouncer is in the Supabase Postgres connection string already when you use the pooler endpoint).
- **`PrismaPg` driver adapter.** Prisma 7 dropped the Rust query-engine by default in favour of pure-JS "client" engine mode. `@prisma/adapter-pg` is the PostgreSQL driver adapter; it speaks to `pg` (Node's standard Postgres client) directly. No Rust binary to bundle, no native module pain on Vercel.
- **`DATABASE_URL` from env.** The connection string is never committed. Locally it points to Supabase's direct connection string (port 5432); in production it should point to the Supabase **Pooler** connection string (port 6543, Supabase Transaction mode) so each Vercel invocation doesn't saturate the Postgres `max_connections` limit.
- **ESM `.js` import.** `"./prisma/generated/prisma/client.js"` — the `.js` extension is mandatory. Vercel runs strict ESM Node; dropping the extension produces a module-not-found error at cold-start. Bun resolves it locally without the extension (lenient), which masks the problem until deploy.

Import pattern used everywhere in the backend:

```ts
import { prisma } from "./db.js";      // from same directory
import { prisma } from "../../db.js";  // from a subdirectory (e.g. connectors/gmail/store.ts)
```

`backend/connectors/gmail/store.ts:10` uses the `../../db.js` form.

---

## 2. `prisma.config.ts` — the Prisma CLI configuration

```ts
// backend/prisma.config.ts (full file — 12 lines)
import { defineConfig, env } from "prisma/config";              // line 2

export default defineConfig({
  schema: "prisma/schema.prisma",                                // line 5
  migrations: {
    path: "prisma/migrations",                                   // line 7
  },
  datasource: {
    url: env("DATABASE_URL"),                                    // line 10
  },
});
```

`backend/prisma.config.ts:4–12`

This file tells the Prisma CLI where to look for things — it does **not** affect the runtime client. Three relevant facts:

1. **`schema`** is relative to the directory where you run `prisma` commands (always `backend/`). The CLI resolves it as `backend/prisma/schema.prisma`.
2. **`migrations.path`** resolves to `backend/prisma/migrations/`. New migrations land here as timestamped directories.
3. **`datasource.url: env("DATABASE_URL")`** — the Prisma CLI reads the env variable at command time, not the value in the schema's `datasource` block (the schema block intentionally has no `url =` line, avoiding duplication). This means `DATABASE_URL` must be set in the shell when running `prisma migrate dev` or `prisma db push`.

> Run all `prisma` commands from the `backend/` directory (or prefix with `cd backend &&`), because `prisma.config.ts` is in `backend/` and the schema path is relative to it.

---

## 3. Schema walkthrough — every model and enum

`backend/prisma/schema.prisma`

### 3.1 Generator block

```prisma
generator client {
  provider            = "prisma-client"          // line 4 — NOT prisma-client-js
  output              = "./generated/prisma"      // line 5
  engineType          = "client"                  // line 6
  runtime             = "nodejs"                  // line 9
  importFileExtension = "js"                      // line 13
}
```

- **`provider = "prisma-client"`** is the Prisma 7 provider. The old Prisma 5/6 name `prisma-client-js` no longer exists. Using the wrong name makes `prisma generate` fail.
- **`output = "./generated/prisma"`** places the generated client at `backend/prisma/generated/prisma/`. This is a non-default path chosen so the generated code lives close to the schema and is clearly not hand-authored. The import in `db.ts` matches: `./prisma/generated/prisma/client.js`.
- **`engineType = "client"`** selects the pure-JS engine (driver-adapter mode). Without this the CLI would try to bundle a Rust binary.
- **`runtime = "nodejs"`** — the generated client targets Node's module system. Vercel runs Node; Bun is Node-compatible. Setting this avoids Bun-specific code paths in the generated output that would break Vercel.
- **`importFileExtension = "js"`** — generated inter-file imports inside the client use `.js` extensions. Without this the generated files use `.ts` specifiers which fail under Node's strict ESM resolver at runtime.

### 3.2 Datasource block

```prisma
datasource db {
  provider = "postgresql"
  // NOTE: pgvector is enabled directly in Supabase (Dashboard → Database → Extensions,
  // or `CREATE EXTENSION vector`). We deliberately do NOT let Prisma manage extensions
  // (`extensions = [...]`) — on Supabase that makes `prisma migrate dev` flag Supabase's
  // own pre-installed extensions as "drift" and threaten a destructive reset.
}
```

`backend/prisma/schema.prisma:16–22`

No `url =` line. The URL comes from `prisma.config.ts` at CLI time and from `DATABASE_URL` at runtime.

The warning about `extensions = [...]` is critical: if you add `previewFeatures = ["postgresqlExtensions"]` and list `vector`, every `prisma migrate dev` run will detect that the extension already exists in Supabase (installed by Supabase itself) and generate a migration that tries to re-create or drop it. This is flagged as unsafe drift and can propose a destructive reset. **Never add Prisma extension management on Supabase — manage extensions via the Supabase dashboard or raw SQL outside Prisma.**

### 3.3 `User` model

```prisma
model User {
  id              String           @id @default(uuid())
  email           String           @unique
  name            String
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt
  provider        AuthProvider
  supabaseId      String
  conversations   Conversation[]
  gmailConnection GmailConnection?
}
```

`backend/prisma/schema.prisma:27–38`

Field-by-field rationale:

| Field | Why |
|---|---|
| `id` | UUID, matches the `user.id` that Supabase Auth generates for each user; the upsert in `auth.ts` sets `create: { id: user.id, ... }` so the Prisma row ID == Supabase Auth UID. |
| `email` | `@unique` — the upsert key in `auth.ts` is `where: { email }`. Also the human-readable identity for display. |
| `name` | Required (`String`, not `String?`). Populated from `user.user_metadata.full_name ?? user.email` in the provisioning upsert, so it is always non-null. |
| `provider` | `AuthProvider` enum — `Github` or `Google`. Tracks how the user signed up; used for display and potential future provider-specific flows. |
| `supabaseId` | Redundant with `id` right now (both store `user.id`). Kept for clarity and in case a future refactor separates internal Lumina UUIDs from Supabase Auth UIDs. |
| `conversations` | One-to-many back-relation to `Conversation[]`. Not a column — Prisma uses it to generate join helpers. |
| `gmailConnection` | Optional one-to-one back-relation. `?` = a user can exist with no Gmail connection. |

### 3.4 `Conversation` model

```prisma
model Conversation {
  id        String    @id @default(uuid())
  title     String?
  slug      String
  userId    String
  createdAt DateTime  @default(now())
  messages  Message[]
  user      User      @relation(fields: [userId], references: [id])
}
```

`backend/prisma/schema.prisma:40–50`

| Field | Why |
|---|---|
| `title` | `String?` — nullable because a new conversation's title is initially the first 80 characters of the query (set at create time) and can be renamed by the user via `PATCH /conversations/:id`. |
| `slug` | URL-friendly string for frontend navigation (generated by `slugify(query)` at creation). Not unique — two conversations about the same topic would get the same slug. Currently used as a display hint, not a primary lookup key. |
| `userId` | FK → `User.id`. The ownership check pattern `where: { id: conversationId, userId: req.userId }` appears in every conversation route so users can only access their own data. |
| `createdAt` | Enables `orderBy: { createdAt: "desc" }` in the sidebar list (`backend/index.ts:377`). |
| `messages` | One-to-many back-relation to `Message[]`. |

### 3.5 `Message` model

```prisma
model Message {
  id             Int          @id @default(autoincrement())
  content        String
  role           MessageRole
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  conversationId String
  createdId      DateTime     @default(now())
}
```

`backend/prisma/schema.prisma:71–79`

| Field | Why |
|---|---|
| `id` | `Int @autoincrement()` — not UUID. The autoincrement integer is used as the ordering key: `orderBy: { id: "asc" }` in `backend/index.ts:394` gives chronological message order without a separate index on `createdAt`. |
| `role` | `MessageRole` enum (`user` or `Assistant`). The compaction + LLM message-history format depends on the alternating user/Assistant pattern. |
| `content` | Full message text. No length cap in the schema (Postgres `text` is unbounded); the assistant turn can be thousands of tokens. |
| `createdId` | Note: field name typo (`createdId` instead of `createdAt`) — existing name, do not rename without a migration. Stores insert timestamp. |

> The conversation delete route (`backend/index.ts:443–446`) uses a `$transaction` to delete messages first (because the FK has no `onDelete: Cascade`) then delete the conversation:
> ```ts
> await prisma.$transaction([
>     prisma.message.deleteMany({ where: { conversationId } }),
>     prisma.conversation.delete({ where: { id: conversationId } }),
> ]);
> ```

### 3.6 `CachedQuery` model — the semantic cache table

```prisma
model CachedQuery {
  id        String                      @id @default(uuid())
  queryText String                      @map("query_text")
  model     String
  embedding Unsupported("vector(1536)")
  answer    String
  sources   Json
  images    Json
  createdAt DateTime @default(now())   @map("created_at")

  @@map("cached_query")
}
```

`backend/prisma/schema.prisma:58–69`

This model is special: `embedding` uses `Unsupported("vector(1536)")` because Prisma has no native pgvector type. The consequence is that **this model is entirely inaccessible through the typed Prisma client** — `prisma.cachedQuery.*` does not exist. Every read and write goes through `$queryRaw` / `$executeRaw`.

The model exists in the schema only to drive migrations (the `CREATE TABLE cached_query` DDL) and to document the table shape in one place.

| Field | Why |
|---|---|
| `queryText` / `@map("query_text")` | The original query string (stored for debugging/analytics). Camel-case TS field, snake_case Postgres column — the standard `@map` pattern. |
| `model` | The LLM model that generated the answer (e.g. `"claude-3-5-haiku-20241022"`). Cache hits are keyed on `(embedding, model)` so a premium-model request is never served a budget-model's cached answer. |
| `embedding` | 1536-dimensional vector — the dimension of `text-embedding-3-small`. pgvector stores it as a compact binary format. |
| `sources` / `images` | `Json` — arbitrary JSON blobs matching the `<SOURCES>` wire protocol arrays. |
| `@@map("cached_query")` | Table name is snake_case in Postgres; Prisma model name follows PascalCase convention. |

The raw SQL queries in `backend/index.ts`:

```ts
// Lookup (cosine distance via pgvector <=> operator) — backend/index.ts:317
const rows = await prisma.$queryRaw<
    Array<{ answer: string; sources: unknown; images: unknown; distance: number }>
>`
    SELECT answer, sources, images, (embedding <=> ${vec}::vector) AS distance
    FROM cached_query
    WHERE model = ${model} AND created_at > ${cutoff}
    ORDER BY embedding <=> ${vec}::vector
    LIMIT 1
`;

// Insert — backend/index.ts:349
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
```

Template-literal `$queryRaw` / `$executeRaw` automatically parameterize the interpolated values, preventing SQL injection. The `::vector` and `::jsonb` casts are part of the SQL string, not the parameter, which is correct — Postgres needs the explicit cast to know the parameter type when it arrives as a generic text binding.

### 3.7 `GmailConnection` model

```prisma
model GmailConnection {
  id              String   @id @default(uuid())
  userId          String   @unique
  googleEmail     String   @map("google_email")
  refreshTokenEnc String   @map("refresh_token_enc")
  iv              String
  authTag         String   @map("auth_tag")
  scopes          String
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt      @map("updated_at")

  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("gmail_connection")
}
```

`backend/prisma/schema.prisma:86–100`

This model stores the OAuth refresh token for the Gmail Connectors feature. The security model:

| Field | Security role |
|---|---|
| `refreshTokenEnc` | AES-256-GCM ciphertext (base64). The plaintext refresh token is **never stored**. |
| `iv` | GCM nonce (12 bytes, base64). A fresh random nonce for every encryption — never reused. |
| `authTag` | GCM authentication tag (base64). Verifies ciphertext integrity on decryption; detects tampering. |
| `scopes` | Space-delimited granted scopes string. Checked on send to ensure the token has the right permissions. |

The AES key (`GMAIL_TOKEN_ENC_KEY`) lives only in env — a database leak alone cannot decrypt the tokens.

`userId @unique` enforces one Gmail connection per user at the database level.

`onDelete: Cascade` means deleting a `User` row automatically removes their `GmailConnection`. Without this, deleting a user would fail with a FK violation.

All reads/writes are isolated in `backend/connectors/gmail/store.ts` — no other module touches these columns directly.

```ts
// backend/connectors/gmail/store.ts:27 — save/update
await prisma.gmailConnection.upsert({
  where: { userId: p.userId },
  create: { userId: p.userId, ...data },
  update: data,
});

// store.ts:38 — UI-safe status (no token)
const c = await prisma.gmailConnection.findUnique({
  where: { userId },
  select: { googleEmail: true, scopes: true, createdAt: true },
});

// store.ts:49 — full credentials for send path
const c = await prisma.gmailConnection.findUnique({ where: { userId } });

// store.ts:60 — delete
await prisma.gmailConnection.deleteMany({ where: { userId } });
```

### 3.8 Enums

```prisma
enum MessageRole {
  user
  Assistant
}

enum AuthProvider {
  Github
  Google
}
```

`backend/prisma/schema.prisma:102–110`

- **`MessageRole`** — note the mixed case: `user` (lowercase) and `Assistant` (capitalized). This asymmetry matches the values written in `auth.ts` and `index.ts`. If you add a new message role, match this casing exactly in both the schema enum and the write calls, or you will get a runtime cast error.
- **`AuthProvider`** — `Github` and `Google` (PascalCase). The provisioning logic in `auth.ts:61` maps `user.app_metadata.provider === "google"` → `"Google"` and falls through to `"Github"` for everything else.

---

## 4. The generated client

After `prisma generate`, the client lives at:

```
backend/prisma/generated/prisma/
  client.ts          ← the main entry point
  models/
    User.ts
    Conversation.ts
    Message.ts
    CachedQuery.ts   ← exists but typed client methods are absent (Unsupported field)
    GmailConnection.ts
  internal/
    class.ts         ← PrismaClient implementation
    ...
```

The `output = "./generated/prisma"` in the generator block means the output path is relative to the schema file (`backend/prisma/schema.prisma`), so the generated client lands at `backend/prisma/generated/prisma/`.

`db.ts` imports from `"./prisma/generated/prisma/client.js"` — relative to `backend/`, resolving to the same path.

**You must re-run `prisma generate` every time you edit `schema.prisma`.** The generated TypeScript types (including what fields are selectable, what relations exist, what enum values are valid) are a snapshot of the schema at generate time. A stale generated client will compile but produce wrong runtime types — or not compile at all if you removed a field.

```bash
cd backend
bun --bun run prisma generate
```

The `bun --bun` flag tells Bun to run the `prisma` binary directly under Bun's runtime (faster). `prisma` must be in `devDependencies`.

---

## 5. Where queries actually live

### 5.1 User provisioning — `auth.ts`

The only `prisma.user.*` call in the codebase is the idempotent upsert in the auth middleware:

```ts
// backend/auth.ts:55–66
await prisma.user.upsert({
    where: { email: user.email! },
    update: {},
    create: {
        id: user.id,
        email: user.email!,
        provider: user.app_metadata.provider === "google" ? "Google" : "Github",
        name: user.user_metadata.full_name ?? user.email!,
        supabaseId: user.id,
    },
});
```

`update: {}` is intentional — if the user row already exists, do nothing. We don't overwrite `name` or `provider` on every login. The upsert is guarded by `provisionedUsers: Set<string>` (`auth.ts:33`) — a process-level set that tracks which user IDs have already been provisioned this invocation. The DB round-trip is skipped for every request after the first.

This "once-per-process" pattern works correctly on Vercel where each cold-start is a fresh process. If the deployment ever moves to a long-running server, the `provisionedUsers` set would grow unboundedly and also not reflect users deleted from the DB. For now, the pattern is correct.

### 5.2 Conversation CRUD — `index.ts`

All conversation and message writes happen in `backend/index.ts`. Every query includes `userId` in the `where` clause — this is the ownership enforcement pattern:

| Route | Prisma call | Line |
|---|---|---|
| `GET /conversations` | `prisma.conversation.findMany({ where: { userId } })` | `index.ts:374` |
| `GET /conversations/:id` | `prisma.conversation.findFirst({ where: { id, userId }, include: { messages } })` | `index.ts:391` |
| `PATCH /conversations/:id` | `prisma.conversation.updateMany({ where: { id, userId }, data: { title } })` | `index.ts:417` |
| `DELETE /conversations/:id` | ownership check → `$transaction([deleteMany messages, delete conversation])` | `index.ts:436–446` |
| `POST /perplexity_ask` (new conv) | `prisma.conversation.create({ data: { title, slug, userId } })` | `index.ts:481` |
| `POST /perplexity_ask` (user turn) | `prisma.message.create({ data: { content, role: "user", conversationId } })` | `index.ts:494` |
| `persistTurns` (assistant turn) | `prisma.message.create({ data: { content, role: "Assistant", conversationId } })` | `index.ts:146` |
| `POST /finance/ask` (user turn) | `prisma.message.create({ data: { content, role: "user", conversationId } })` | `index.ts:648` |

The `updateMany` pattern on `PATCH` (instead of `update`) is intentional: `update` throws `RecordNotFound` if the `where` clause matches nothing; `updateMany` returns `{ count: 0 }` which we check for a clean 404 without try/catch.

### 5.3 Semantic cache — raw SQL in `index.ts`

Because `CachedQuery.embedding` uses `Unsupported("vector(1536)")`, the typed client has no methods for this model. All interactions use tagged template literals:

- **Read:** `prisma.$queryRaw` at `index.ts:317` — parameterized cosine-distance search with a staleness filter.
- **Write:** `prisma.$executeRaw` at `index.ts:349` — parameterized insert with `::vector` and `::jsonb` casts.

Both are fire-and-forget from the hot path (failures are caught and logged; they never surface to the user).

### 5.4 Gmail connection store — `connectors/gmail/store.ts`

All four store functions are the only place that touches the `gmail_connection` table. See §3.7 for the calls with line references. The encrypt/decrypt boundary is in `connectors/crypto.ts` — the store calls into it before any DB operation.

---

## 6. Migration history

```
backend/prisma/migrations/
  20260616231633_init/            ← initial schema: all core tables
  20260617115914_added_unique_const/  ← added unique constraint (GmailConnection.userId @unique)
  20260617121206_supabase_id/     ← added supabaseId column to User
  migration_lock.toml             ← locks provider = postgresql
```

Each directory contains a single `migration.sql` file that Prisma generated from the schema diff. These are committed to the repo and applied in order.

### Dev → Prod flow

```
[Local] Edit schema.prisma
           ↓
       bun --bun run prisma migrate dev --name <description>
       (generates migration.sql, applies to local DB, re-runs prisma generate)
           ↓
       Commit migration directory + updated schema + updated generated/ files
           ↓
[CI/CD] bun --bun run prisma migrate deploy
       (applies pending migrations to production Supabase DB, no generate)
```

`migrate dev` is for development only — it can reset the DB and prompt interactively. `migrate deploy` is non-destructive (applies only pending migrations) and is safe in CI.

> **Never run `prisma migrate dev` against the production DATABASE_URL.** It can propose a reset when it detects drift.

---

## 7. Deploy topology

```
Browser
  ↓ HTTPS
Vercel Serverless Function (Node, per-invocation)
  ├─ imports backend/db.ts → new PrismaClient({ adapter: PrismaPg })
  ├─ DATABASE_URL → Supabase Pooler (port 6543, Transaction mode, PgBouncer)
  │      ↓
  │   Supabase Postgres (port 5432, real connections)
  │      └── pgvector extension (installed directly in Supabase, not Prisma-managed)
  └─ Other routes: Upstash Redis (REST), Supabase Auth (REST), external APIs
```

**Connection string guidance:**

| Environment | URL to use |
|---|---|
| Local dev | Direct connection (`postgres://...@db.<project>.supabase.co:5432/postgres`) — `migrate dev` needs direct access |
| Vercel production | Pooler connection (`postgres://...@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true`) — avoids exhausting Postgres `max_connections` across concurrent invocations |

The `?pgbouncer=true` query parameter tells Prisma to disable prepared statements (PgBouncer Transaction mode doesn't support them).

The `worker/` directory (Fly.io) is a separate long-running process that can hold WebSocket connections and real Postgres sessions. It has its own `prisma` import if needed — it is NOT deployed to Vercel.

---

## 8. Recurring gotchas

### 8.1 New backend files: full dev-server restart required

Bun's `--hot` flag (used in dev: `bun --hot run backend/index.ts`) patches existing modules in place. It does **not** pick up a newly created `.ts` file. If you add a new route file, store, or utility:

```bash
# Stop the dev server (Ctrl-C), then:
bun run backend/index.ts
# or if using the package.json script:
bun run dev
```

This is not a Prisma issue specifically — it affects all new files.

### 8.2 `prisma generate` after every schema edit

The generated client at `backend/prisma/generated/prisma/` is a snapshot. TypeScript will appear to compile fine against a stale client (because the old types are still there) but runtime calls to removed or renamed fields will throw. Always run `generate` after any schema change, and commit the updated generated files.

```bash
cd backend && bun --bun run prisma generate
```

### 8.3 `.js` ESM extensions everywhere

Three layers of `.js` extension requirements:

1. **`db.ts` importing the generated client:** `"./prisma/generated/prisma/client.js"` — must include `.js`.
2. **Any file importing `db.ts`:** `import { prisma } from "./db.js"` or `"../../db.js"`.
3. **Generated client internal imports** — handled automatically by `importFileExtension = "js"` in the generator block.

Bun resolves `.js` imports to `.ts` files locally (no error), but Vercel's Node ESM resolver does not. The bug only manifests on deploy. Enforce the convention in code review.

### 8.4 No Prisma-managed extensions on Supabase

Do not add to the schema:

```prisma
// WRONG — do not do this on Supabase
generator client {
  previewFeatures = ["postgresqlExtensions"]
}
datasource db {
  extensions = [vector]  // triggers drift detection
}
```

Enable `vector` (pgvector) in the Supabase dashboard under Database → Extensions, or with `CREATE EXTENSION IF NOT EXISTS vector;` in a raw SQL migration. Prisma will then see it already installed and leave it alone. See `backend/prisma/schema.prisma:18–21` for the inline warning.

### 8.5 `CachedQuery` is typed but not callable

Despite appearing in the Prisma schema, the `CachedQuery` model produces no typed client methods because of the `Unsupported("vector(1536)")` field. Attempting `prisma.cachedQuery.findMany(...)` will fail at compile time (the property does not exist on the client type). Always use `$queryRaw` / `$executeRaw` for this table.

### 8.6 `Message.id` is `Int @autoincrement`, not UUID

Every other model uses `String @id @default(uuid())`. `Message.id` is `Int @id @default(autoincrement())`. This has two implications:

- The chronological order of messages can be relied upon via `orderBy: { id: "asc" }` without a separate timestamp index.
- You cannot generate a `Message` ID in application code before the insert (no pre-generated UUID to reference). The DB assigns the ID; your code receives it in the return value of `prisma.message.create`.

---

## 9. Request → DB trace (end-to-end)

Here is the complete path for a `POST /perplexity_ask` request that starts a new conversation:

```
1. HTTP request hits Vercel → backend/index.ts Express handler
2. `middleware` (backend/auth.ts) runs:
   a. Extract Bearer token from Authorization header
   b. Check tokenCache (in-memory, 5-min TTL) — hit → skip to step 3
   c. Miss → call Supabase Auth.getUser(token) → get user object
   d. If !provisionedUsers.has(user.id):
        prisma.user.upsert({ where: { email }, update: {}, create: { id, email, provider, name, supabaseId } })
        provisionedUsers.add(user.id)
   e. tokenCache.set(token, { userId, expiresAt })
   f. req.userId = user.id → next()

3. Route handler runs:
   a. Rate-limit check (Upstash Redis or in-memory sliding window)
   b. Embed query → Upstash Redis semantic-cache lookup
      → miss → raw SQL: prisma.$queryRaw`SELECT ... FROM cached_query WHERE ...`
   c. No conversationId in body → create a new conversation:
        prisma.conversation.create({ data: { title, slug, userId: req.userId } })
   d. Fire-and-forget user turn persist (non-blocking):
        prisma.message.create({ data: { content: query, role: "user", conversationId } })
   e. Tavily web search + streamText (Claude via Vercel AI Gateway) → SSE stream to client
   f. BEFORE res.end(), await persistTurns():
        await persistUserTurn  (wait for step d to complete)
        prisma.message.create({ data: { content: answer, role: "Assistant", conversationId } })
   g. Cache the answer (non-blocking):
        prisma.$executeRaw`INSERT INTO cached_query ...`

4. Response closes. Vercel may freeze the instance after res.end().
   (This is why persistence in step 3f happens BEFORE res.end().)
```

The key constraint: **persist before `res.end()`** (cross-cutting non-negotiable). Vercel can freeze a serverless instance the instant the response is sent. Any DB write that happens after `res.end()` may be silently dropped.

---

## See also

- `prisma/references/upstream/prisma-client-api/` — Prisma 7 typed client API reference (findMany, create, upsert, $queryRaw, transactions, etc.)
- `prisma/references/upstream/prisma-upgrade-v7/` — migration guide from Prisma 5/6 to 7, including the generator rename and driver adapter changes
- `prisma/references/upstream/prisma-driver-adapter-implementation/` — how PrismaPg + `@prisma/adapter-pg` works under the hood
- Skill: **supabase** — Supabase Auth client (`backend/client.ts`), RLS, pgvector extension management, pooler vs direct connection strings
- Skill: **rag-retrieval** — the semantic cache built on top of `CachedQuery` + pgvector; embedding pipeline; `$queryRaw` cosine-distance search details
- Skill: **connectors-oauth** — `GmailConnection` model usage; token vault encryption/decryption; `backend/connectors/gmail/store.ts`
- Skill: **backend-testing** — `backend/tests/helpers/prisma-fake.ts` for mocking `prisma` in unit tests without hitting a real DB
- Skill: **ai-sdk-agent** — `streamText` integration, the SSE wire protocol, and how `persistTurns` fits into the stream lifecycle
- Skill: **lumina-frontend** — TanStack Query hooks that call the conversation endpoints backed by the Prisma queries above
