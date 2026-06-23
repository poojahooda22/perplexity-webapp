# Prisma Client API

> Complete model-query reference for the `prisma-client` generator: every CRUD method, every query option, every filter and relation operator, with examples drawn from Lumina's real schema.

---

## Client instantiation

Lumina's singleton lives in `backend/db.ts`:

```typescript
// backend/db.ts
import { PrismaClient } from "./prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prisma = new PrismaClient({ adapter });
```

Key facts:
- Generator is `prisma-client` (not `prisma-client-js`) — output in `./generated/prisma`, `importFileExtension = "js"`.
- Import path is `./prisma/generated/prisma/client.js` — always with the `.js` extension (Vercel strict ESM).
- `PrismaPg` is a driver adapter: it replaces the query engine binary with a native `pg` pool, which works in Vercel serverless without spawning child processes.
- Do **not** call `prisma.$connect()` on startup. The adapter connects on the first query; explicit `$connect()` adds latency for no benefit in serverless.
- Do **not** add `extensions = [...]` in `schema.prisma`. Supabase pre-installs pgvector; letting Prisma manage extensions causes `migrate dev` to flag them as drift and threaten a destructive reset.

### Constructor options worth knowing

```typescript
const prisma = new PrismaClient({
  adapter,

  // Log to stdout (dev only — remove in production)
  log: ["query", "info", "warn", "error"],

  // Or emit as events for custom instrumentation
  log: [{ level: "query", emit: "event" }],

  // Pretty-print errors (useful locally)
  errorFormat: "pretty",   // "pretty" | "colorless" | "minimal"

  // Override default transaction timeouts
  transactionOptions: {
    maxWait: 5000,    // ms to wait for a transaction slot
    timeout: 10000,   // max duration before rollback
    isolationLevel: "ReadCommitted",
  },
});

// Subscribe to query events (requires emit:'event' in log)
prisma.$on("query", (e) => {
  console.log(e.query, e.duration + "ms");
});
```

---

## The full model query surface

Every model in `schema.prisma` gets these methods on `prisma.<model>`.

### Return-type cheat sheet

| Method | Return |
|---|---|
| `findUnique` | `Record \| null` |
| `findUniqueOrThrow` | `Record` (throws `PrismaClientKnownRequestError` P2025 if missing) |
| `findFirst` | `Record \| null` |
| `findFirstOrThrow` | `Record` (throws P2025 if missing) |
| `findMany` | `Record[]` |
| `create` | `Record` |
| `createMany` | `{ count: number }` |
| `createManyAndReturn` | `Record[]` |
| `update` | `Record` |
| `updateMany` | `{ count: number }` |
| `updateManyAndReturn` | `Record[]` |
| `upsert` | `Record` |
| `delete` | `Record` |
| `deleteMany` | `{ count: number }` |
| `count` | `number` |
| `aggregate` | aggregate result object |
| `groupBy` | group result array |

---

### findUnique

Requires a `where` that matches exactly one unique field or composite unique.

```typescript
// By primary key (User.id is @id @default(uuid()))
const user = await prisma.user.findUnique({
  where: { id: userId },
});

// By @unique field
const user = await prisma.user.findUnique({
  where: { email: "alice@example.com" },
});

// GmailConnection has @unique on userId — used in backend/connectors/gmail/store.ts:38
const conn = await prisma.gmailConnection.findUnique({
  where: { userId },
  select: { googleEmail: true, scopes: true, createdAt: true },
});
```

Returns `null` if no row matches. Use `.select` to omit secrets (see [Omitting secrets](#omitting-secrets)).

---

### findUniqueOrThrow

Same as `findUnique` but throws `PrismaClientKnownRequestError` (code `P2025`) on miss instead of returning `null`. Useful when absence is a programming error, not an expected state.

```typescript
const user = await prisma.user.findUniqueOrThrow({
  where: { email: req.body.email },
});
// TypeScript narrows the return to non-null automatically
```

---

### findFirst

Scans with any `where` filter (not limited to unique fields), returns the first match or `null`. Accepts `orderBy`, `skip`, `take`.

```typescript
// Ownership-checked conversation load — backend/index.ts:391
const conversation = await prisma.conversation.findFirst({
  where: { id: conversationId, userId: req.userId },
  include: { messages: { orderBy: { id: "asc" } } },
});
if (!conversation) return res.status(404).json({ error: "not found" });
```

```typescript
// "Does this user own this row?" — only pull the id, nothing else
const owned = await prisma.conversation.findFirst({
  where: { id: conversationId, userId: req.userId },
  select: { id: true },
});
```

---

### findFirstOrThrow

`findFirst` that throws on miss.

```typescript
const latest = await prisma.message.findFirstOrThrow({
  where: { conversationId },
  orderBy: { id: "desc" },
});
```

---

### findMany

Returns every row matching `where` (empty object = all rows). Respects `orderBy`, `take`, `skip`, `cursor`, `distinct`.

```typescript
// Conversation sidebar — backend/index.ts:374
const conversations = await prisma.conversation.findMany({
  where: { userId: req.userId },
  select: { id: true, title: true, slug: true },
  orderBy: { createdAt: "desc" },
});
```

```typescript
// All messages in a thread, chronological (id is autoincrement)
const messages = await prisma.message.findMany({
  where: { conversationId },
  orderBy: { id: "asc" },
});
```

---

### create

Inserts one row. Throws on unique-constraint violation (code `P2002`).

```typescript
// New conversation — backend/index.ts:481
const conversation = await prisma.conversation.create({
  data: {
    title: query.slice(0, 80),
    slug: slugify(query),
    userId: req.userId,
  },
});

// New message turn
await prisma.message.create({
  data: { content, role: "Assistant", conversationId: conversation.id },
});
```

---

### createMany

Bulk insert, returns `{ count: number }`. Cannot include nested relation writes. `skipDuplicates: true` silently ignores rows that violate a unique constraint instead of throwing.

```typescript
const result = await prisma.message.createMany({
  data: messages.map((m) => ({
    content: m.content,
    role: m.role,
    conversationId,
  })),
  skipDuplicates: false,  // default; set true to tolerate duplicates
});
console.log(`inserted ${result.count} messages`);
```

---

### createManyAndReturn

Like `createMany` but returns the created rows. Useful when you need generated fields (ids, timestamps) without a follow-up query.

```typescript
const created = await prisma.message.createManyAndReturn({
  data: turns,
  select: { id: true, role: true },
});
// Returns Array<{ id: number; role: MessageRole }>
```

---

### update

Updates a single row matched by a unique `where`. Throws `P2025` if no row matches.

```typescript
// Rename a conversation — backend/index.ts:417 uses updateMany for ownership safety;
// update() is appropriate when you've already confirmed ownership
const updated = await prisma.conversation.update({
  where: { id: conversationId },
  data: { title: title.trim().slice(0, 120) },
});
```

#### Atomic numeric mutations

Use these instead of read-then-write to avoid race conditions:

```typescript
// increment / decrement / multiply / divide / set
await prisma.someModel.update({
  where: { id },
  data: {
    viewCount: { increment: 1 },
    score:     { multiply: 1.05 },
    pinned:    { set: false },
  },
});
```

---

### updateMany

Updates all rows matching `where`. Returns `{ count: number }`. Does **not** throw on zero matches.

```typescript
// Ownership-guarded rename — backend/index.ts:417
const result = await prisma.conversation.updateMany({
  where: { id: conversationId, userId: req.userId },
  data: { title: title.trim().slice(0, 120) },
});
if (result.count === 0) return res.status(404).json({ error: "not found" });
```

The pattern of filtering by both `id` AND `userId` in `updateMany` is the canonical ownership check — no separate read needed, and no TOCTOU race.

---

### updateManyAndReturn

Like `updateMany` but returns the updated rows.

```typescript
const rows = await prisma.conversation.updateManyAndReturn({
  where: { userId: req.userId },
  data: { title: null },
  select: { id: true },
});
```

---

### upsert

Update if the `where` row exists; create it otherwise. Atomic — no race between check and write.

```typescript
// User provisioning — backend/auth.ts:55
await prisma.user.upsert({
  where: { email: user.email! },
  update: {},                             // existing user: touch nothing
  create: {
    id: user.id,
    email: user.email!,
    provider: user.app_metadata.provider === "google" ? "Google" : "Github",
    name: user.user_metadata.full_name ?? user.email!,
    supabaseId: user.id,
  },
});

// Gmail token vault — backend/connectors/gmail/store.ts:27
await prisma.gmailConnection.upsert({
  where: { userId },
  create: { userId, ...encryptedData },
  update: encryptedData,
});
```

---

### delete

Deletes one row by unique `where`. Returns the deleted record. Throws `P2025` if not found, `P2003` if a FK constraint blocks it.

```typescript
await prisma.conversation.delete({
  where: { id: conversationId },
});
```

---

### deleteMany

Deletes all rows matching `where` (or ALL rows if `where` is empty). Returns `{ count: number }`.

```typescript
// Messages must be removed before the conversation (FK ON DELETE RESTRICT)
// — done atomically in a transaction in backend/index.ts:443
await prisma.message.deleteMany({ where: { conversationId } });

// Gmail disconnect — backend/connectors/gmail/store.ts:60
await prisma.gmailConnection.deleteMany({ where: { userId } });
```

---

### count

```typescript
const total = await prisma.message.count({
  where: { conversationId },
});

// Count with _all and field-specific counts
const stats = await prisma.conversation.count({
  where: { userId: req.userId },
});
```

`count` also supports `select` to count multiple things at once:

```typescript
const counts = await prisma.user.count({
  select: {
    _all: true,                    // total rows
    supabaseId: true,              // rows where supabaseId is non-null
  },
});
// { _all: 1200, supabaseId: 1200 }
```

---

### aggregate

```typescript
const result = await prisma.message.aggregate({
  where: { conversationId },
  _count: { _all: true },
  _min:   { id: true },
  _max:   { id: true },
});
// result._count._all  number of messages
// result._min.id      autoincrement id of first message
// result._max.id      autoincrement id of last message
```

Available aggregators: `_count`, `_sum`, `_avg`, `_min`, `_max`. Only numeric and `DateTime` fields support `_sum`/`_avg`/`_min`/`_max`.

---

### groupBy

```typescript
// Count conversations per user
const byUser = await prisma.conversation.groupBy({
  by: ["userId"],
  _count: { _all: true },
  orderBy: { _count: { id: "desc" } },
});
// [{ userId: "...", _count: { _all: 42 } }, ...]

// having: post-aggregation filter (like SQL HAVING)
const active = await prisma.conversation.groupBy({
  by: ["userId"],
  _count: { _all: true },
  having: {
    id: { _count: { gt: 5 } },   // users with more than 5 conversations
  },
});
```

---

## Query options

### select

Returns only the listed fields. Every field not listed is excluded from the return type — TypeScript narrows accordingly.

```typescript
// Sidebar — only what the frontend needs
const conversations = await prisma.conversation.findMany({
  where: { userId },
  select: { id: true, title: true, slug: true },
  orderBy: { createdAt: "desc" },
});
// Type: Array<{ id: string; title: string | null; slug: string }>
```

`select` can reach into relations:

```typescript
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: {
    id: true,
    email: true,
    conversations: {
      select: { id: true, title: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    },
  },
});
```

`select` can also count relations inline:

```typescript
const users = await prisma.user.findMany({
  select: {
    id: true,
    _count: { select: { conversations: true } },
  },
});
// [{ id: "...", _count: { conversations: 3 } }]
```

**Rule:** `select` and `include` are mutually exclusive on the same level. You can use `include` nested inside a `select` block for a relation, but not both at the top level.

---

### include

Loads ALL scalar fields of the parent PLUS the specified relations. Simpler than `select` when you want everything.

```typescript
// Load conversation + messages — backend/index.ts:394
const conversation = await prisma.conversation.findFirst({
  where: { id: conversationId, userId: req.userId },
  include: { messages: { orderBy: { id: "asc" } } },
});
```

Filtered include (the relation itself can have a `where`, `orderBy`, `take`, `skip`, `select`):

```typescript
const user = await prisma.user.findUniqueOrThrow({
  where: { id: userId },
  include: {
    conversations: {
      where: { title: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        messages: { orderBy: { id: "asc" }, take: 1 },
      },
    },
  },
});
```

Count included relations:

```typescript
const users = await prisma.user.findMany({
  include: {
    _count: { select: { conversations: true } },
  },
});
```

---

### omit

Exclude specific fields while returning everything else. Useful to strip secrets without enumerating every safe field.

```typescript
// Never expose refresh-token fields to the frontend
const conn = await prisma.gmailConnection.findUnique({
  where: { userId },
  omit: {
    refreshTokenEnc: true,
    iv: true,
    authTag: true,
  },
});
// Type excludes refreshTokenEnc, iv, authTag
```

`omit` can be applied inside a relation-include block too:

```typescript
const user = await prisma.user.findUniqueOrThrow({
  where: { id: userId },
  include: {
    gmailConnection: {
      omit: { refreshTokenEnc: true, iv: true, authTag: true },
    },
  },
});
```

**Rule:** Cannot use `select` and `omit` together on the same model level.

---

### Omitting secrets

`GmailConnection` holds AES-256-GCM ciphertext, nonce, and auth-tag. Always omit these except in `store.ts` where they are explicitly needed for decryption.

```typescript
// WRONG — leaks token fields to the UI
const conn = await prisma.gmailConnection.findUnique({ where: { userId } });

// RIGHT (option A) — select only what the UI needs
const conn = await prisma.gmailConnection.findUnique({
  where: { userId },
  select: { googleEmail: true, scopes: true, createdAt: true },
});

// RIGHT (option B) — omit the secret fields explicitly
const conn = await prisma.gmailConnection.findUnique({
  where: { userId },
  omit: { refreshTokenEnc: true, iv: true, authTag: true },
});
```

Both A and B are used in `backend/connectors/gmail/store.ts` — `select` for the status view (line 38), raw findUnique for the decrypt path (line 49, immediately consumed inside the same function, never forwarded to a route handler).

---

### orderBy

Single field:

```typescript
orderBy: { createdAt: "desc" }
```

Multiple fields (array, left-to-right priority):

```typescript
orderBy: [{ role: "desc" }, { id: "asc" }]
```

Order by relation aggregate:

```typescript
// Users with the most conversations first
orderBy: { conversations: { _count: "desc" } }
```

Null handling:

```typescript
orderBy: { title: { sort: "asc", nulls: "last" } }
```

---

### take and skip (offset pagination)

```typescript
// Page 1 (items 1-20)
const page1 = await prisma.conversation.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
  take: 20,
  skip: 0,
});

// Page 2 (items 21-40)
const page2 = await prisma.conversation.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
  take: 20,
  skip: 20,
});
```

Negative `take` reverses direction relative to `orderBy`:

```typescript
// Last 5 messages in a thread
const last5 = await prisma.message.findMany({
  where: { conversationId },
  orderBy: { id: "asc" },
  take: -5,
});
```

---

### cursor (cursor-based pagination)

Stable under concurrent inserts — preferred over `skip` for infinite scroll.

```typescript
// First page
const firstPage = await prisma.conversation.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
  take: 20,
});

// Next page (skip the cursor item itself with skip:1)
const nextPage = await prisma.conversation.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
  take: 20,
  skip: 1,
  cursor: { id: firstPage[firstPage.length - 1].id },
});
```

The cursor field must be unique (or part of a composite unique) and must be in `orderBy`.

---

### distinct

Returns only rows where the listed fields are unique:

```typescript
// One row per userId (e.g., which users have conversations)
const activeUsers = await prisma.conversation.findMany({
  distinct: ["userId"],
  select: { userId: true },
});
```

---

## Filtering

### Scalar operators

All operators live inside the field name:

```typescript
where: {
  email: { equals: "alice@example.com" }  // same as: email: "alice@example.com"
  email: { not: "banned@example.com" }
  id:    { in: ["uuid-a", "uuid-b", "uuid-c"] }
  id:    { notIn: deletedIds }
  id:    { lt: "some-uuid" }     // lexicographic for strings; numeric for Int/Float
  id:    { lte: "some-uuid" }
  id:    { gt: "some-uuid" }
  id:    { gte: "some-uuid" }
}
```

DateTime comparisons (common for TTL/staleness checks):

```typescript
const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
where: { createdAt: { gt: cutoff } }
```

String operators:

```typescript
where: {
  email: { contains: "example.com" }
  slug:  { startsWith: "react-" }
  title: { endsWith: "?" }

  // case-insensitive (PostgreSQL; uses ILIKE internally)
  title: { contains: "react", mode: "insensitive" }
}
```

Null checks:

```typescript
where: { title: null }                    // IS NULL
where: { title: { not: null } }           // IS NOT NULL
```

---

### Logical operators

**AND** — implicit when you list multiple fields at the same level:

```typescript
// Implicit AND: both conditions must be true
where: { id: conversationId, userId: req.userId }
```

**Explicit AND / OR / NOT:**

```typescript
where: {
  AND: [
    { createdAt: { gt: cutoff } },
    { userId: req.userId },
  ]
}

where: {
  OR: [
    { provider: "Google" },
    { provider: "Github" },
  ]
}

where: {
  NOT: { provider: "Github" }
}

// Combine them
where: {
  userId: req.userId,
  OR: [
    { title: { contains: searchTerm, mode: "insensitive" } },
    { slug:  { contains: searchTerm, mode: "insensitive" } },
  ],
  NOT: { title: null },
}
```

---

### Relation filters

Filter the parent by properties of its children. Works on one-to-many (`conversations`, `messages`) and one-to-one (`gmailConnection`, `user`).

#### some / every / none (one-to-many)

```typescript
// Users who have at least one conversation
where: {
  conversations: { some: {} }
}

// Users whose every conversation has a title
where: {
  conversations: { every: { title: { not: null } } }
}

// Users with no conversations
where: {
  conversations: { none: {} }
}

// Conversations that have at least one user-role message
where: {
  messages: { some: { role: "user" } }
}
```

#### is / isNot (one-to-one)

```typescript
// Users with a Gmail connection (one-to-one optional)
where: {
  gmailConnection: { isNot: null }
}

// Users without a Gmail connection
where: {
  gmailConnection: { is: null }
}

// GmailConnections belonging to Github users
where: {
  user: { is: { provider: "Github" } }
}
```

---

## Nested writes

Nested writes let you create/update/delete related rows in one round-trip. They are implicitly wrapped in a transaction.

### create (nested)

```typescript
// Create conversation + first message in one shot
const conversation = await prisma.conversation.create({
  data: {
    title: query.slice(0, 80),
    slug: slugify(query),
    userId: req.userId,
    messages: {
      create: { content: query, role: "user" },
    },
  },
  include: { messages: true },
});
```

### createMany (nested)

```typescript
const conversation = await prisma.conversation.create({
  data: {
    slug: slugify(query),
    userId: req.userId,
    messages: {
      createMany: {
        data: turns.map((t) => ({ content: t.content, role: t.role })),
      },
    },
  },
});
```

### connect

Link to an existing row by its unique field:

```typescript
const message = await prisma.message.create({
  data: {
    content: "hello",
    role: "user",
    conversation: {
      connect: { id: conversationId },
    },
  },
});

// Shorthand — set the FK directly (same result, simpler)
const message = await prisma.message.create({
  data: { content: "hello", role: "user", conversationId },
});
```

### connectOrCreate

```typescript
// Connect if the conversation exists, create if not
const message = await prisma.message.create({
  data: {
    content: "hello",
    role: "user",
    conversation: {
      connectOrCreate: {
        where:  { id: conversationId },
        create: { slug: "new-slug", userId: req.userId },
      },
    },
  },
});
```

### update (nested)

```typescript
const conversation = await prisma.conversation.update({
  where: { id: conversationId },
  data: {
    messages: {
      update: {
        where: { id: messageId },
        data:  { content: "corrected" },
      },
    },
  },
});
```

### updateMany (nested)

```typescript
await prisma.conversation.update({
  where: { id: conversationId },
  data: {
    messages: {
      updateMany: {
        where: { role: "user" },
        data:  { content: "[redacted]" },
      },
    },
  },
});
```

### upsert (nested)

```typescript
await prisma.user.update({
  where: { id: userId },
  data: {
    gmailConnection: {
      upsert: {
        create: { userId, googleEmail, refreshTokenEnc, iv, authTag, scopes },
        update: { googleEmail, refreshTokenEnc, iv, authTag, scopes },
      },
    },
  },
});
```

### delete (nested)

```typescript
await prisma.conversation.update({
  where: { id: conversationId },
  data: {
    messages: {
      delete: { id: messageId },
    },
  },
});
```

### deleteMany (nested)

```typescript
await prisma.conversation.update({
  where: { id: conversationId },
  data: {
    messages: {
      deleteMany: { role: "user" },   // delete all user-turn messages
    },
  },
});
```

### disconnect (optional one-to-one)

```typescript
// Remove the gmailConnection link without deleting the row
await prisma.user.update({
  where: { id: userId },
  data: {
    gmailConnection: { disconnect: true },
  },
});
```

### set (replace all, many-to-many)

```typescript
// Replace ALL relations atomically
await prisma.post.update({
  where: { id: postId },
  data: {
    tags: {
      set: [{ id: tagId1 }, { id: tagId2 }],
    },
  },
});
```

---

## Aggregations and groupBy

### _count / _sum / _avg / _min / _max

```typescript
const result = await prisma.message.aggregate({
  where: { conversationId },
  _count: { _all: true },
  _min:   { id: true },
  _max:   { id: true },
});

console.log(result._count._all);   // number of messages
console.log(result._max.id);       // highest autoincrement id (last message)
```

All five aggregators may appear in the same call. `_sum`/`_avg` require numeric types.

### groupBy

`groupBy` groups on scalar fields and runs aggregators within each bucket. `having` filters groups after aggregation (like SQL `HAVING`).

```typescript
// Message count per conversation
const groups = await prisma.message.groupBy({
  by: ["conversationId"],
  _count: { _all: true },
  orderBy: { _count: { id: "desc" } },
});

// Conversations with more than 10 messages
const verbose = await prisma.message.groupBy({
  by: ["conversationId"],
  _count: { _all: true },
  having: {
    id: { _count: { gt: 10 } },
  },
});
```

`groupBy` cannot be combined with `include`. Use `select` with `_count` on `findMany` when you need aggregations alongside relation data:

```typescript
const conversations = await prisma.conversation.findMany({
  where: { userId },
  select: {
    id: true,
    title: true,
    _count: { select: { messages: true } },
  },
  orderBy: { createdAt: "desc" },
});
// [{ id, title, _count: { messages: 7 } }, ...]
```

---

## Returning and shaping data

### select vs include — the mental model

| | `select` | `include` |
|---|---|---|
| Scalar fields | Only those you list | All of them |
| Relation fields | Only those you list (with their own sub-`select`) | All you list (with all their scalars) |
| Top-level | Can appear alone | Can appear alone |
| Together at same level | Not allowed | Not allowed |
| Nested in the other | `include` inside a `select` relation | `select` inside an `include` relation |

Use `select` when the TypeScript type precision matters (you want a narrow type) or when you want to exclude secrets by not listing them. Use `include` when you want all fields of the parent plus one or more relations loaded in full.

### Type utilities

```typescript
import { Prisma } from "./prisma/generated/prisma/client.js";

// Input types (for create/update data objects)
type UserCreate = Prisma.UserCreateInput;
type ConversationWhere = Prisma.ConversationWhereInput;

// Output types (infer from a select/include shape)
type ConversationSummary = Prisma.ConversationGetPayload<{
  select: { id: true; title: true; slug: true };
}>;

type ConversationWithMessages = Prisma.ConversationGetPayload<{
  include: { messages: true };
}>;
```

### satisfies — reusable typed query fragments

```typescript
import { Prisma } from "./prisma/generated/prisma/client.js";

// Define once, use many times — TypeScript validates the shape
const safeConnSelect = {
  googleEmail: true,
  scopes: true,
  createdAt: true,
} satisfies Prisma.GmailConnectionSelect;

const conn = await prisma.gmailConnection.findUnique({
  where: { userId },
  select: safeConnSelect,
});
```

---

## Transactions

### Array (sequential) transactions

All operations are built up front and executed atomically. No dependent logic between steps.

```typescript
// Delete messages then conversation atomically — backend/index.ts:443
await prisma.$transaction([
  prisma.message.deleteMany({ where: { conversationId } }),
  prisma.conversation.delete({ where: { id: conversationId } }),
]);
```

### Interactive transactions

The callback receives a `tx` client scoped to the transaction. Supports conditional logic and dependent values. Rolls back automatically if the callback throws.

```typescript
const { id: newConversationId } = await prisma.$transaction(async (tx) => {
  const conv = await tx.conversation.create({
    data: { slug: slugify(query), userId, title: query.slice(0, 80) },
  });
  await tx.message.create({
    data: { content: query, role: "user", conversationId: conv.id },
  });
  return conv;
});
```

```typescript
// OrThrow inside a transaction — if the user doesn't exist, everything rolls back
await prisma.$transaction(async (tx) => {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  await tx.conversation.update({
    where: { id: conversationId },
    data: { title: user.name + "'s chat" },
  });
});
```

### Transaction options

```typescript
await prisma.$transaction(
  async (tx) => { /* ... */ },
  {
    maxWait: 5000,                     // wait up to 5s for a free connection
    timeout: 10000,                    // abort if the callback takes > 10s
    isolationLevel: "Serializable",    // ReadUncommitted | ReadCommitted | RepeatableRead | Serializable
  },
);
```

Postgres default isolation is `ReadCommitted`. Use `RepeatableRead` or `Serializable` only when you need stricter guarantees (e.g., check-then-act patterns); they increase lock contention.

### Nested writes are implicit transactions

Prisma wraps nested write operations (any `create`/`update` with a `data` block that touches relations) in an implicit transaction. You don't need an explicit `$transaction` for them.

---

## Raw SQL: $queryRaw and $executeRaw

Use raw SQL only when the typed Prisma API cannot express the query — for example, pgvector distance operators.

### $queryRaw

Template literal form — parameterized automatically (SQL injection safe):

```typescript
// Semantic cache lookup — backend/index.ts:317
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
if (hit && hit.distance <= DISTANCE_THRESHOLD) { /* cache hit */ }
```

**Always use the tagged-template form** (`$queryRaw\`...\``). Each `${value}` becomes a `$N` parameter — Postgres handles escaping. Never interpolate user input via string concatenation.

PostgreSQL returns `COUNT(*)` as `BigInt`:

```typescript
const result = await prisma.$queryRaw<[{ count: bigint }]>`
  SELECT COUNT(*) AS count FROM cached_query WHERE model = ${model}
`;
const count = Number(result[0].count);   // convert BigInt → number
```

Dynamic identifiers (table/column names) that cannot be parameterized:

```typescript
import { Prisma } from "./prisma/generated/prisma/client.js";

// Prisma.raw is NOT safe for user input — only for known-safe identifiers
const col = Prisma.raw('"created_at"');
const rows = await prisma.$queryRaw`SELECT ${col} FROM cached_query LIMIT 10`;
```

Composing fragments:

```typescript
const conditions = [
  Prisma.sql`model = ${model}`,
  Prisma.sql`created_at > ${cutoff}`,
];
const rows = await prisma.$queryRaw`
  SELECT * FROM cached_query
  WHERE ${Prisma.join(conditions, " AND ")}
`;
```

### $executeRaw

INSERT / UPDATE / DELETE — returns the number of affected rows:

```typescript
// Cache a new answer — backend/index.ts:349
await prisma.$executeRaw`
  INSERT INTO cached_query (id, query_text, model, embedding, answer, sources, images, created_at)
  VALUES (
    ${crypto.randomUUID()},
    ${query},
    ${model},
    ${vec}::vector,
    ${answer},
    ${JSON.stringify(sources)}::jsonb,
    ${JSON.stringify(images)}::jsonb,
    NOW()
  )
`;
```

### Raw queries inside transactions

```typescript
await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`UPDATE cached_query SET answer = ${newAnswer} WHERE id = ${id}`;
  await tx.$executeRaw`INSERT INTO audit_log (query_id) VALUES (${id})`;
});
```

### When NOT to use raw SQL

- Simple CRUD → use the typed client methods above.
- `CachedQuery.embedding` (`vector(1536)`) is the only column in Lumina's schema that forces raw SQL, because Prisma's type system cannot represent `Unsupported("vector(1536)")` in query args.
- All other models (`User`, `Conversation`, `Message`, `GmailConnection`) should be accessed exclusively through the typed client.

---

## Client methods

### $connect / $disconnect

```typescript
// NOT needed in serverless — Prisma connects on the first query
await prisma.$connect();

// Graceful shutdown in long-running processes (not Vercel)
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

// In Bun tests
afterAll(async () => {
  await prisma.$disconnect();
});
```

### $on — query event subscription

```typescript
const prisma = new PrismaClient({
  adapter,
  log: [{ level: "query", emit: "event" }],
});
prisma.$on("query", (e) => {
  console.log(`[db] ${e.duration}ms  ${e.query}`);
});
```

### $extends — extensions

Add model methods, query middleware, or computed fields without patching the generated client.

```typescript
// Add a soft-delete default filter
const prismaWithDefaults = prisma.$extends({
  query: {
    conversation: {
      async findMany({ args, query }) {
        // could add a default where clause here
        return query(args);
      },
    },
  },
});

// Computed field
const prismaWithFullName = prisma.$extends({
  result: {
    user: {
      displayName: {
        needs: { name: true, email: true },
        compute(u) {
          return u.name || u.email;
        },
      },
    },
  },
});

// Chain extensions
const extended = prisma
  .$extends(loggingExtension)
  .$extends(computedFieldsExtension);
```

---

## Error handling

Prisma throws typed errors you can inspect:

```typescript
import { Prisma } from "./prisma/generated/prisma/client.js";

try {
  await prisma.user.create({ data: { email, ... } });
} catch (e) {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case "P2002":
        // Unique constraint violation — e.meta.target has the field names
        return res.status(409).json({ error: "Email already in use" });
      case "P2025":
        // Record not found (findUniqueOrThrow / update / delete)
        return res.status(404).json({ error: "Not found" });
      case "P2003":
        // FK constraint violation
        return res.status(409).json({ error: "Related record missing" });
      case "42P01":
        // Raw SQL: table does not exist (Postgres code, not a Prisma code)
        break;
    }
  }
  throw e;
}
```

`PrismaClientValidationError` is thrown at query-build time (wrong field name, missing required arg) — it indicates a code bug, not a runtime condition; let it propagate to the error handler.

---

## See also

- `prisma/schema.prisma` — model definitions, enum values, raw-SQL warning for pgvector
- `backend/db.ts` — the singleton `prisma` export used everywhere
- `backend/auth.ts` — `upsert` user provisioning pattern
- `backend/connectors/gmail/store.ts` — `upsert`/`findUnique`/`deleteMany` + `omit`/`select` secret-hiding patterns
- `backend/index.ts` — `findMany`, `findFirst`, `updateMany`, `$transaction`, `$queryRaw`, `$executeRaw` in production context

**Sibling references in this skill:**
- `prisma-schema.md` — schema design, migrations, pgvector, Supabase gotchas
- `prisma-transactions.md` — deep dive on isolation levels and interactive transactions
- `prisma-raw-queries.md` — pgvector cosine search, Prisma.sql composition

**Other skills:**
- `rag-retrieval` — the semantic cache (CachedQuery) that drives the raw SQL pgvector queries
- `backend-testing` — `backend/tests/helpers/prisma-fake.ts`, mocking Prisma in unit tests
- `connectors-oauth` — GmailConnection CRUD patterns
- `supabase` — auth.getUser, RLS, why Prisma does not own the Supabase extensions
- `lumina-frontend` — TanStack Query hooks that call the routes backed by these queries
