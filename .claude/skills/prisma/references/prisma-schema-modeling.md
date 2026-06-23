# Prisma Schema Modeling

> Complete reference for writing `schema.prisma` in Prisma 7 on PostgreSQL: datasource/generator blocks, scalar types, field and block attributes, relations, nullability, naming conventions, and the `Unsupported` escape hatch. All examples drawn from or consistent with Lumina's live schema at `backend/prisma/schema.prisma`.

---

## 1. Datasource and Generator Blocks

Every schema starts with exactly one `datasource` block and one or more `generator` blocks. They control what database Prisma connects to and what artifacts `prisma generate` emits.

### Datasource block

```prisma
datasource db {
  provider = "postgresql"
  // url is intentionally absent here. In Prisma 7 the connection URL
  // lives in prisma.config.ts (datasource.url = env("DATABASE_URL")).
}
```

`provider` tells Prisma which dialect to use for SQL generation, migration DDL, and type mapping. Supported values: `"postgresql"`, `"mysql"`, `"sqlite"`, `"sqlserver"`, `"cockroachdb"`, `"mongodb"` (Prisma 6 only for Mongo).

**Prisma 7 URL placement.** In Prisma 7 the `datasource` block no longer carries `url = env("DATABASE_URL")`. Instead, `prisma.config.ts` (at the repo root or alongside `package.json`) owns the URL:

```typescript
// backend/prisma.config.ts
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),   // env() reads the variable at CLI invocation time
  },
});
```

This separation means the schema file itself is environment-agnostic and safe to commit without exposing secrets.

**pgvector warning (Supabase).** Lumina enables the `vector` extension directly in Supabase (Dashboard → Database → Extensions, or `CREATE EXTENSION IF NOT EXISTS vector`). Do NOT add `extensions = ["vector"]` to the datasource block. On Supabase-managed databases, Prisma sees any pre-installed extension it did not create as schema drift and may propose a destructive `DROP EXTENSION` during `prisma migrate dev`. The safe pattern is: let Supabase own the extension, access `vector` columns via `$queryRaw`/`$executeRaw`, and document the caveat in a schema comment (as Lumina does at `backend/prisma/schema.prisma:19-22`).

### Generator block

```prisma
generator client {
  provider            = "prisma-client"       // Prisma 7 provider name (not "prisma-client-js")
  output              = "./generated/prisma"  // where the client is written
  engineType          = "client"              // library mode (no child process)
  runtime             = "nodejs"              // target runtime for Vercel serverless
  importFileExtension = "js"                  // generated imports end in ".js" not ".ts"
}
```

Key fields:

| Field | Purpose | Lumina value |
|---|---|---|
| `provider` | Generator name — must be `"prisma-client"` in Prisma 7 | `"prisma-client"` |
| `output` | Path where `prisma generate` writes the client | `"./generated/prisma"` |
| `engineType` | `"client"` = inline JS engine (no native binary subprocess) | `"client"` |
| `runtime` | The JS runtime the generated code targets | `"nodejs"` |
| `importFileExtension` | Extension appended to inter-file imports inside the generated client | `"js"` |

**Why `importFileExtension = "js"` matters.** Vercel compiles TypeScript to `.js` and the Node.js serverless runtime uses strict ESM resolution: specifiers must have the real file extension present at runtime. Without this field, the generated client emits `.ts` specifiers that resolve fine under Bun locally (Bun maps `.ts`→`.ts`) but 404 at boot on Vercel. Setting `"js"` makes the generated imports portable across both runtimes.

**Client instantiation** (`backend/db.ts`):

```typescript
// backend/db.ts
import { PrismaClient } from "./prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prisma = new PrismaClient({ adapter });
```

`PrismaPg` is the PostgreSQL driver adapter from `@prisma/adapter-pg`. It bridges Prisma's query engine to the `pg` connection pool. A single exported `prisma` instance is shared across the whole process — each `PrismaClient` instance opens its own connection pool, so constructing multiple instances exhausts database connections.

---

## 2. Scalar Field Types

Prisma maps its type system to PostgreSQL column types. The mapping is deterministic; you can override it with `@db` native type attributes when you need a specific storage class.

| Prisma type | Default PostgreSQL type | Notes |
|---|---|---|
| `String` | `TEXT` | Variable-length, no length limit by default |
| `Boolean` | `BOOLEAN` | |
| `Int` | `INTEGER` (32-bit) | Use for autoincrement PKs |
| `BigInt` | `BIGINT` (64-bit) | Serializes as `BigInt` in JS |
| `Float` | `DOUBLE PRECISION` | IEEE 754 double |
| `Decimal` | `DECIMAL(65,30)` | Arbitrary precision; serializes as `Decimal` object |
| `DateTime` | `TIMESTAMP(3) WITH TIME ZONE` | Stored in UTC; JS `Date` |
| `Json` | `JSONB` on PostgreSQL | Schemaless JSON blob |
| `Bytes` | `BYTEA` | Binary data; JS `Buffer` |

### Unsupported type

When a column type has no Prisma equivalent, use `Unsupported("...")`:

```prisma
// backend/prisma/schema.prisma:62
embedding Unsupported("vector(1536)")
```

A field declared `Unsupported` is excluded from the generated TypeScript types — you cannot read or write it through the typed Prisma client. Access it with raw SQL only:

```typescript
// The only safe way to touch CachedQuery.embedding in Lumina:
const results = await prisma.$queryRaw<Row[]>`
  SELECT id, answer, sources
  FROM cached_query
  ORDER BY embedding <=> ${queryVector}::vector
  LIMIT 5
`;
```

### Enums

Enums are declared at the schema level, not inside a model. Prisma creates a PostgreSQL `ENUM` type for them.

```prisma
// backend/prisma/schema.prisma:102-110
enum MessageRole {
  user
  Assistant
}

enum AuthProvider {
  Github
  Google
}
```

Enum members are case-sensitive and map 1-to-1 to the PostgreSQL enum labels. In the generated TypeScript client they become a `const` object and a union type, so you write `MessageRole.user` and `MessageRole.Assistant`.

---

## 3. Field Attributes

Field attributes are single-field modifiers written after the type declaration on the same line.

### `@id`

Marks the field as the primary key. Every model must have exactly one `@id` (or a composite `@@id`).

```prisma
id String @id @default(uuid())
```

For autoincrement integer keys:

```prisma
id Int @id @default(autoincrement())
```

Lumina mixes both strategies: `User`, `Conversation`, `GmailConnection`, and `CachedQuery` use UUID string PKs; `Message` uses an integer autoincrement PK (see `backend/prisma/schema.prisma:71-72`).

### `@default`

Supplies the column default. Common expressions:

| Expression | Generates | Example use |
|---|---|---|
| `uuid()` | UUIDv4 (database-generated) | Most Lumina PKs |
| `cuid()` | Collision-resistant ID | Alternative to uuid() |
| `now()` | Current timestamp at insert | `createdAt` columns |
| `autoincrement()` | Serial integer | `Message.id` |
| `dbgenerated("expr")` | Arbitrary SQL default | Rare; use for DB-specific functions |
| `true` / `false` | Boolean literal | Feature flags |
| `""` | Empty string | Optional display fields |

```prisma
id        String   @id @default(uuid())
createdAt DateTime @default(now())
id        Int      @id @default(autoincrement())
```

### `@unique`

Creates a unique constraint on the column. Prisma generates `findUnique`/`findUniqueOrThrow` queries for `@unique` fields in addition to `@id`.

```prisma
email  String @unique   // User: one row per email address
userId String @unique   // GmailConnection: one OAuth grant per user
```

### `@updatedAt`

Automatically sets the field to the current timestamp on every update. Only valid on `DateTime` fields. Prisma handles this in the client layer (not a database trigger), so it applies to both `update` and `upsert` operations.

```prisma
updatedAt DateTime @updatedAt
```

### `@map`

Renames the column in the database without renaming the Prisma field. Follows our convention of PascalCase model fields mapping to snake_case database columns.

```prisma
queryText String @map("query_text")
createdAt DateTime @default(now()) @map("created_at")
```

Multiple attributes can appear on the same line in any order after the type.

### `@relation`

Declares a relation between two models. Covered in depth in §5.

### `@db` native type attributes

Override the default PostgreSQL type for a scalar field. Most useful for `String` (where you want a fixed-length `CHAR` or size-limited `VARCHAR`) or `Decimal` (where you want a specific precision/scale).

```prisma
// examples only — not in Lumina's current schema
code String  @db.Char(6)
price Decimal @db.Decimal(10, 2)
bio   String  @db.VarChar(500)
```

On PostgreSQL, `@db.Uuid` can be applied to a `String @id` to store it as a native UUID column instead of `TEXT`. Prisma generates the same TS type either way, but the storage and index behaviour differs.

---

## 4. Block Attributes

Block attributes apply to the whole model and are written at the bottom of the model block, prefixed with `@@`.

### `@@id` — composite primary key

When no single field can be the PK, declare a composite key:

```prisma
model WatchlistEntry {
  userId    String
  symbol    String
  addedAt   DateTime @default(now())

  @@id([userId, symbol])
}
```

The generated client's `findUnique` for this model takes `where: { userId_symbol: { userId, symbol } }`.

### `@@unique` — composite unique constraint

```prisma
model UserSetting {
  userId String
  key    String
  value  String

  @@unique([userId, key])
}
```

Creates a unique constraint across both columns; prevents the same user from having duplicate keys.

### `@@index`

Creates a database index to speed up filtered or sorted queries. The index does not affect the TypeScript API — it is a pure performance hint.

```prisma
model Conversation {
  // ...
  userId    String
  createdAt DateTime @default(now())

  @@index([userId, createdAt])   // fast: "conversations for user X, newest first"
}
```

Index columns should match the filters and sort orders your application actually uses. An unindexed column used in a `WHERE` clause causes a sequential scan — every row is read regardless of how many match.

Partial indexes and `ops` (operator classes) are not expressible in Prisma SDL; use `$executeRaw` to create them in a migration if needed.

### `@@map` — table name override

Renames the database table without renaming the Prisma model.

```prisma
model CachedQuery {
  // ...
  @@map("cached_query")    // table is "cached_query", model is "CachedQuery"
}

model GmailConnection {
  // ...
  @@map("gmail_connection")
}
```

This is the recommended pattern: model names stay PascalCase (TypeScript convention); table names stay snake_case (PostgreSQL convention).

---

## 5. Relations

Prisma models relations through a pair of complementary fields — one on each side of the relation. The relation field (the one holding the related object) is a Prisma concept only; the foreign-key scalar field is what actually exists in the database.

### One-to-one (1-1)

One record on each side. The FK lives on the "child" side; the child must declare `@unique` on the FK to enforce the 1-1 cardinality.

```prisma
// backend/prisma/schema.prisma:36-37, 86-99
model User {
  // ...
  gmailConnection GmailConnection?   // optional: user may not have connected Gmail
}

model GmailConnection {
  id     String @id @default(uuid())
  userId String @unique               // @unique enforces 1-1: one connection per user

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("gmail_connection")
}
```

`fields: [userId]` — the FK scalar on `GmailConnection`.
`references: [id]` — the column it points to on `User`.

The `User.gmailConnection` side holds no `@relation` attribute; it is the "virtual" back-reference that Prisma resolves via the FK declared on `GmailConnection`.

### One-to-many (1-n)

One parent, many children. The FK is on the child; the parent has an array relation field.

```prisma
// backend/prisma/schema.prisma:27-50
model User {
  id            String         @id @default(uuid())
  conversations Conversation[]  // array = 1-n: one user has many conversations
}

model Conversation {
  id       String @id @default(uuid())
  userId   String                       // FK scalar
  user     User   @relation(fields: [userId], references: [id])
  messages Message[]
}

model Message {
  id             Int          @id @default(autoincrement())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
}
```

Reading the parent side (`User`) does NOT load the `Conversation[]` by default — Prisma uses explicit `include` or `select` for relations:

```typescript
const user = await prisma.user.findUnique({
  where: { id: req.userId },
  include: { conversations: { orderBy: { createdAt: "desc" } } },
});
```

### Many-to-many (m-n)

**Implicit join table** (Prisma manages the join table, no model needed):

```prisma
model Post {
  id   Int    @id @default(autoincrement())
  tags Tag[]
}

model Tag {
  id    Int    @id @default(autoincrement())
  posts Post[]
}
// Prisma creates "_PostToTag" table with (A, B) composite PK.
```

**Explicit join table** (you control the join model; required when the join row carries payload columns):

```prisma
model Conversation {
  id          String              @id @default(uuid())
  participants ConversationUser[]
}

model User {
  id           String             @id @default(uuid())
  conversations ConversationUser[]
}

model ConversationUser {
  conversationId String
  userId         String
  joinedAt       DateTime @default(now())   // payload column — needs explicit model

  conversation   Conversation @relation(fields: [conversationId], references: [id])
  user           User         @relation(fields: [userId], references: [id])

  @@id([conversationId, userId])
}
```

Lumina does not currently need m-n relations, but the explicit form is preferred for any join that carries metadata.

### Referential actions: `onDelete` / `onUpdate`

Referential actions control what Prisma (and the database) does to child rows when the parent row is deleted or its PK is updated.

```prisma
user User @relation(fields: [userId], references: [id], onDelete: Cascade)
```

Available actions for PostgreSQL:

| Action | Behaviour |
|---|---|
| `Cascade` | Delete/update child rows along with the parent |
| `Restrict` | Reject the parent delete/update if children exist |
| `NoAction` | Like `Restrict` but deferred; SQL standard default |
| `SetNull` | Set the FK to `NULL` (field must be nullable) |
| `SetDefault` | Set the FK to its declared `@default` |

**Lumina uses `onDelete: Cascade` on `GmailConnection → User`** (`backend/prisma/schema.prisma:97`). Deleting a `User` row automatically deletes the linked `GmailConnection` row — no orphaned OAuth tokens.

`onDelete: Restrict` (or the default `NoAction`) is appropriate when you want explicit cleanup before deleting the parent, e.g. archiving conversations before deleting a user.

---

## 6. Nullability, Optional Fields, and Default Strategies

A field is **required** (NOT NULL in the database) by default. Append `?` to make it **optional** (nullable):

```prisma
title String?    // NULL allowed
name  String     // NOT NULL — must be supplied on create
```

### Interaction with `@default`

A field with `@default` is required at the Prisma client level (no need to pass it on `create`) because the database or Prisma supplies the value automatically. It is still `NOT NULL` in the database.

```prisma
createdAt DateTime @default(now())   // required (not nullable), auto-populated
title     String?                    // optional (nullable), no default needed
```

### Composite key implications

When a model uses `@@id([fieldA, fieldB])`, both fields must be required (non-nullable). A nullable FK cannot participate in a composite PK.

### Default strategies by use case

| Use case | Recommended default |
|---|---|
| Surrogate PK (most models) | `@id @default(uuid())` |
| High-insert sequential PK | `@id @default(autoincrement())` — Message model |
| Audit timestamp (insert) | `@default(now())` |
| Audit timestamp (update) | `@updatedAt` |
| Boolean feature flag | `@default(false)` |
| Status enum | `@default(EnumValue)` |

---

## 7. Naming Conventions: PascalCase Models, snake_case Tables

Prisma's convention (and Lumina's) is:

- **Model names** — PascalCase singular noun: `User`, `Conversation`, `GmailConnection`, `CachedQuery`.
- **Field names** — camelCase: `userId`, `createdAt`, `refreshTokenEnc`.
- **Database table names** — snake_case plural (or singular where industry standard): `users`, `conversations`, `gmail_connection`, `cached_query`.
- **Database column names** — snake_case: `user_id`, `created_at`, `refresh_token_enc`.

Map between the two layers with `@map` (fields) and `@@map` (tables):

```prisma
model GmailConnection {
  id              String   @id @default(uuid())
  userId          String   @unique
  googleEmail     String   @map("google_email")
  refreshTokenEnc String   @map("refresh_token_enc")
  iv              String
  authTag         String   @map("auth_tag")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt      @map("updated_at")

  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("gmail_connection")
}
```

This preserves the Prisma/TypeScript ergonomics (camelCase everywhere in application code) while emitting the conventional SQL style that database tooling and raw queries expect.

Models **without** an explicit `@@map` — `User`, `Conversation`, `Message` — default to the model name as the table name. If you want PostgreSQL-style lowercase plural names (`users`, `conversations`), add `@@map("users")` explicitly. Lumina omits `@@map` on those three models, so the tables are literally named `User`, `Conversation`, and `Message` in Supabase. This is a cosmetic inconsistency; adding `@@map` later requires a migration.

---

## 8. Complete Lumina Schema: Annotated

This is the full `backend/prisma/schema.prisma` with inline explanations of every design decision:

```prisma
// backend/prisma/schema.prisma

generator client {
  provider            = "prisma-client"      // Prisma 7 provider
  output              = "./generated/prisma"
  engineType          = "client"
  runtime             = "nodejs"             // Vercel Node serverless target
  importFileExtension = "js"                 // strict-ESM-safe generated imports
}

datasource db {
  provider = "postgresql"
  // No url here — it lives in prisma.config.ts → datasource.url = env("DATABASE_URL")
  // pgvector is managed by Supabase directly; never add extensions=[] here.
}

// ------------------------------------------------------------------
// Core identity

model User {
  id          String       @id @default(uuid())  // UUIDv4 from DB
  email       String       @unique               // login key + upsert key in auth.ts
  name        String                             // display name
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt            // auto-refreshed on every update
  provider    AuthProvider                       // Github | Google (enum)
  supabaseId  String                             // mirrors Supabase auth.users.id

  // Virtual relation fields (no columns; resolved via FKs on child models)
  conversations   Conversation[]
  gmailConnection GmailConnection?    // ? = 0 or 1 (optional 1-1)
}

// ------------------------------------------------------------------
// Chat history

model Conversation {
  id        String    @id @default(uuid())
  title     String?                        // nullable: not set until first message
  slug      String                         // URL-friendly handle
  userId    String                         // FK → User.id
  createdAt DateTime  @default(now())

  messages  Message[]
  user      User      @relation(fields: [userId], references: [id])
}

model Message {
  id             Int          @id @default(autoincrement())  // integer PK (high insert volume)
  content        String
  role           MessageRole                                  // user | Assistant (enum)
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  createdId      DateTime     @default(now())                 // note: field name is a typo for createdAt
}

// ------------------------------------------------------------------
// Semantic cache (pgvector)
// Accessed ONLY via $queryRaw/$executeRaw — the `embedding` column
// is Unsupported and absent from the typed client API.

model CachedQuery {
  id        String                      @id @default(uuid())
  queryText String                      @map("query_text")
  model     String                      // keyed on (embedding, model) pair
  embedding Unsupported("vector(1536)") // 1536-dim text-embedding-3-small vector
  answer    String
  sources   Json
  images    Json
  createdAt DateTime                    @default(now()) @map("created_at")

  @@map("cached_query")
}

// ------------------------------------------------------------------
// OAuth Connectors

model GmailConnection {
  id              String   @id @default(uuid())
  userId          String   @unique              // one grant per user (1-1 with User)
  googleEmail     String   @map("google_email")
  refreshTokenEnc String   @map("refresh_token_enc")  // AES-256-GCM ciphertext (base64)
  iv              String                               // GCM nonce (base64), unique per encryption
  authTag         String   @map("auth_tag")            // GCM auth tag (base64)
  scopes          String                               // space-delimited granted scopes
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt      @map("updated_at")

  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("gmail_connection")
}

// ------------------------------------------------------------------
// Enums

enum MessageRole {
  user
  Assistant
}

enum AuthProvider {
  Github
  Google
}
```

---

## 9. Patterns and Pitfalls

### Never re-use a PrismaClient instance across tests

Each `new PrismaClient()` opens a connection pool. Tests that construct their own client (instead of using the shared singleton) can exhaust the database's `max_connections`. Lumina's backend tests mock the client via `backend/tests/helpers/prisma-fake.ts` rather than constructing a real one.

### `@updatedAt` is client-side, not a DB trigger

`@updatedAt` is implemented by the Prisma client: it injects `updatedAt: new Date()` into every `update` and `upsert` call. If you bypass Prisma (raw SQL, another ORM, the Supabase dashboard), the column is not updated. Keep this in mind when writing migrations or data scripts.

### `Unsupported` fields require raw queries — and typed wrappers

```typescript
// backend/lib/cache.ts uses $queryRaw for CachedQuery reads
// Example wrapper for semantic cache lookup:
type CacheRow = { id: string; answer: string; sources: unknown };

async function findSimilar(vector: number[], model: string): Promise<CacheRow[]> {
  const pgLiteral = `[${vector.join(",")}]`;
  return prisma.$queryRaw<CacheRow[]>`
    SELECT id, answer, sources
    FROM cached_query
    WHERE model = ${model}
    ORDER BY embedding <=> ${pgLiteral}::vector
    LIMIT 5
  `;
}
```

`$queryRaw` uses tagged template literals; Prisma interpolates non-literal values as parameterised placeholders, preventing SQL injection. The vector literal must be cast with `::vector` because `pg` does not know the `vector` type natively.

### Relations do not exist in the database

Prisma's relation fields (`user`, `conversations`, `gmailConnection`, `messages`) are not columns. They exist only in the schema and the generated TypeScript types. The only real database artifact is the scalar FK field (`userId`, `conversationId`) and the constraint (foreign key + optional index). Keep this in mind when reading `EXPLAIN` output or examining the Supabase table inspector.

### `@@index` on FK columns

Prisma does NOT automatically create indexes on FK scalar fields. Add explicit `@@index` on high-traffic FK columns:

```prisma
model Conversation {
  // ...
  userId String
  @@index([userId])    // without this, "conversations by user" is a full-table scan
}

model Message {
  // ...
  conversationId String
  @@index([conversationId])
}
```

Lumina's current schema omits these (the data set is still small), but they become necessary at Tier 2+ (thousands of users with many conversations each).

### `onDelete` defaults differ by relation type

If you omit `onDelete`:
- Required FK (child field is non-nullable): default is `Restrict` — deleting the parent fails if children exist.
- Optional FK (child field is nullable): default is `SetNull` — deleting the parent nulls the FK on children.

Lumina's `GmailConnection` explicitly declares `onDelete: Cascade` because the OAuth tokens are worthless without the user row. `Conversation` and `Message` omit `onDelete`, inheriting `Restrict` — this is intentional: you should not be able to accidentally delete a user who has conversations without first deleting or transferring the conversations.

---

## 10. Quick-Reference Cheat Sheet

```prisma
// PKs
id String @id @default(uuid())
id Int    @id @default(autoincrement())

// Timestamps
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt

// Mapping to snake_case
fieldName  String   @map("field_name")
@@map("table_name")

// Unique
email String @unique
@@unique([fieldA, fieldB])

// Index
@@index([userId])
@@index([userId, createdAt])

// Optional (nullable)
title String?

// Enum
provider AuthProvider          // enum declared at schema level

// Unsupported (raw-only)
embedding Unsupported("vector(1536)")

// 1-1 (child side)
userId String @unique
user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

// 1-n (child side)
userId String
user   User   @relation(fields: [userId], references: [id])

// 1-n (parent side — no attribute needed)
conversations Conversation[]
```

---

## See also

- `prisma` skill — `SKILL.md`: decision tree, non-negotiables, when to use `$queryRaw` vs typed client
- `supabase` skill: Supabase auth integration, RLS, service-role vs anon key, pgvector extension management
- `redis` skill: Upstash Redis REST client, `getOrRefresh` stale-while-revalidate pattern, thundering-herd guard (`backend/lib/cache.ts`)
- `rag-retrieval` skill: pgvector cosine similarity queries, `CachedQuery` semantic cache design, embedding strategy
- `finance-markets` skill: `$queryRaw` usage patterns for vector similarity in the finance answer cache
- `connectors-oauth` skill: `GmailConnection` model lifecycle, AES-256-GCM token encryption, OAuth refresh flow
- `backend-testing` skill: `backend/tests/helpers/prisma-fake.ts` mock seam — how to stub the Prisma client in unit/integration tests without a real database
- `lumina-frontend` skill: TanStack Query hooks that consume the Conversation/Message data returned by Express routes backed by these models
