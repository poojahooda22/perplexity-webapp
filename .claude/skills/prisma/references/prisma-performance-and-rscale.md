# Prisma Performance and R-SCALE

> Generic Prisma query performance playbook applied to Lumina's schema: eliminate N+1 queries, stop
> over-fetching, index the right columns, choose cursor over offset pagination, understand count()
> cost, manage connection limits at serverless scale, and pass the R-SCALE battery (§§ A / B / D)
> against the current models before any list/search/contested surface ships.

This doc is the authoritative answer to "Will this query survive 100× / 10,000× users?" in the
Prisma skill's decision tree. It does **not** duplicate migration workflow or transaction semantics
— read `prisma-transactions-and-concurrency.md` for atomic writes and `prisma-migrations-and-cli.md`
for index migrations.

---

## 1 The N+1 Problem and Its Fixes

### What it is

N+1 is the most common Prisma performance defect. The "1" is a query that fetches N parent rows;
the "+1" is the N separate queries that follow — one per parent — to load a related model. It reads
like correct code but produces catastrophic query counts at real volume.

```ts
// ❌ N+1: fetches N conversations, then one Message query per conversation
const convos = await prisma.conversation.findMany({ where: { userId } });
for (const c of convos) {
  const msgs = await prisma.message.findMany({ where: { conversationId: c.id } });
  console.log(c.title, msgs.length);
}
// With 200 conversations → 201 round-trips to Postgres.
// Each Vercel serverless invocation adds ~1–5 ms per query over the Supabase TLS
// connection. 201 × 3 ms = ~600 ms just in DB round-trips.
```

### Fix 1: `include` the relation

Load the relation in the same query. Prisma issues **one** query per relation level (using a JOIN
or a single batched sub-query internally, depending on Prisma version + adapter).

```ts
// ✅ One query: conversations + all their messages in a single round-trip
const convos = await prisma.conversation.findMany({
  where: { userId },
  include: {
    messages: {
      orderBy: { createdId: "asc" },
      select: { id: true, role: true, content: true, createdId: true },
    },
  },
  orderBy: { createdAt: "desc" },
});
```

Limit nested `include` depth to **two levels max** in a single query. Three-level deep includes
generate large JOIN trees. If you need deeper nesting, split into two explicit queries using the
result of the first as `in` input (Fix 2).

### Fix 2: Batched `in` lookup (DataLoader thinking)

When you already have a list of IDs and need to fetch related rows for all of them, replace the
per-item loop with a single `in` query. This is the same technique as a DataLoader without the
batching middleware.

```ts
// After fetching conversation IDs:
const conversationIds = convos.map((c) => c.id);

// ✅ One query for all messages for all conversations
const messages = await prisma.message.findMany({
  where: { conversationId: { in: conversationIds } },
  orderBy: [{ conversationId: "asc" }, { createdId: "asc" }],
  select: { id: true, conversationId: true, role: true, content: true },
});

// Group in application memory — O(n), no extra DB round-trips
const msgsByConvo = new Map<string, typeof messages>();
for (const m of messages) {
  const arr = msgsByConvo.get(m.conversationId) ?? [];
  arr.push(m);
  msgsByConvo.set(m.conversationId, arr);
}
```

`in` with thousands of IDs is fine; Postgres builds a hash join. At tens of thousands, consider
a `$queryRaw` with `= ANY($1::uuid[])` which is slightly faster, but reach that limit only after
real profiling.

### Fix 3: Nest writes instead of separate round-trips

Creating a Conversation + its first Message in two separate calls is two round-trips and NOT atomic.
Use nested writes for creates that belong together.

```ts
// ✅ Atomic + one round-trip
const conversation = await prisma.conversation.create({
  data: {
    slug: slugify(title),
    title,
    userId,
    messages: {
      create: { role: "user", content: firstMessage },
    },
  },
  include: { messages: true },
});
```

---

## 2 Over-Fetching: `select` and `omit`

### Never `SELECT *` on wide rows

Prisma returns **all columns** by default (`SELECT *`). For `GmailConnection` this includes
`refreshTokenEnc`, `iv`, and `authTag` — encrypted secrets that have no place in an API response
and carry non-trivial bytes over the wire.

```ts
// ❌ Returns refreshTokenEnc, iv, authTag to the caller
const conn = await prisma.gmailConnection.findUnique({ where: { userId } });

// ✅ Project only what the caller needs
const conn = await prisma.gmailConnection.findUnique({
  where: { userId },
  select: {
    googleEmail: true,
    scopes: true,
    updatedAt: true,
  },
});
```

`omit` is the inverse shorthand — useful when you want almost all columns but need to strip one or
two secrets without enumerating every field:

```ts
const conn = await prisma.gmailConnection.findUnique({
  where: { userId },
  omit: { refreshTokenEnc: true, iv: true, authTag: true },
});
```

### Select discipline on `Message`

`Message.content` can be arbitrarily long (full LLM output). For sidebar lists or conversation
metadata, never load content:

```ts
// ❌ Loads full message content for a sidebar list — wastes bandwidth + memory
const convos = await prisma.conversation.findMany({
  where: { userId },
  include: { messages: true },
});

// ✅ Sidebar only needs the conversation metadata
const convos = await prisma.conversation.findMany({
  where: { userId },
  select: {
    id: true,
    title: true,
    slug: true,
    createdAt: true,
    _count: { select: { messages: true } },
  },
  orderBy: { createdAt: "desc" },
  take: 30,
});
```

When you **do** need message content (loading a conversation for replay), select and stream it —
not pre-loaded for every conversation simultaneously.

### Relation counts without loading rows

`_count` in a `select` emits a `COUNT(*)` subquery instead of loading the related rows:

```ts
const convos = await prisma.conversation.findMany({
  where: { userId },
  select: {
    id: true,
    title: true,
    _count: { select: { messages: true } },
  },
});
// convos[0]._count.messages → integer, no Message rows transferred
```

---

## 3 Indexing: Which Columns to `@@index`

An unindexed filter is a **full-table scan** — Postgres reads every row, every page, even if only
one row matches. On a table with 10,000 rows this is tolerable; at 1M rows it is a second-scale
query.

### Rule: index every column you `where` or `orderBy` on

```prisma
model Conversation {
  id        String   @id @default(uuid())
  userId    String                           // ← ALWAYS filter by this
  createdAt DateTime @default(now())         // ← ALWAYS orderBy this for sidebar
  slug      String
  title     String?

  @@index([userId])                          // required — every sidebar load does WHERE userId = ?
  @@index([userId, createdAt(sort: Desc)])   // composite: WHERE userId + ORDER BY createdAt DESC
}

model Message {
  id             Int      @id @default(autoincrement())
  conversationId String                      // ← ALWAYS filter by this
  createdId      DateTime @default(now())    // ← orderBy for chronological display

  @@index([conversationId])
  @@index([conversationId, createdId(sort: Asc)])
}
```

> **Current schema gap (`backend/prisma/schema.prisma`):** The `Conversation` and `Message` models
> do NOT have `@@index` declarations. At Tier 1 (demo data, one user) this is invisible. At Tier 2
> (thousands of users, tens of thousands of conversations) every sidebar load becomes a sequential
> scan of the entire `Conversation` table. Add these indexes before any real traffic.

**Index rules for the existing schema:**

| Table | Column(s) to index | Access pattern |
|---|---|---|
| `Conversation` | `userId` | Every list: `WHERE userId = ?` |
| `Conversation` | `(userId, createdAt DESC)` | Sidebar sorted newest-first |
| `Message` | `conversationId` | Load a conversation: `WHERE conversationId = ?` |
| `Message` | `(conversationId, createdId ASC)` | Chronological message replay |
| `User` | `email` | Already covered by `@unique` (implicit B-tree index) |
| `User` | `supabaseId` | Auth provisioning lookup — add `@unique` or `@@index([supabaseId])` |
| `GmailConnection` | `userId` | Already covered by `@unique` |
| `CachedQuery` | `embedding` via `CREATE INDEX ... USING ivfflat` | Cosine ANN search — managed outside Prisma (see `lumina-pgvector-and-raw-queries.md`) |

**Adding an index is a non-destructive migration.** Run `prisma migrate dev` and Postgres adds the
index online (no table lock for `CONCURRENTLY` — though `prisma migrate` doesn't use `CONCURRENTLY`
by default; on a large live table, add it manually via `db execute` with `CREATE INDEX CONCURRENTLY`
and then let Prisma reconcile via `db pull`).

### What "index" means mechanically

A B-tree index stores the indexed column values in a sorted structure so Postgres can seek directly
to matching rows (O(log n) instead of O(n)). A composite index `(userId, createdAt DESC)` satisfies
both the `WHERE userId = ?` and the `ORDER BY createdAt DESC` in a single index scan — no sort step.

---

## 4 Pagination at Scale: Cursor vs Offset

### Offset / skip pagination — works only at Tier 1

```ts
// ❌ Offset pagination — appears in many tutorials, breaks at scale
const page3 = await prisma.conversation.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
  skip: 40,   // page 3 of 20 items/page
  take: 20,
});
```

**What Postgres does:** scans 60 rows (skip 40 + return 20) — even with an index. At page 100 it
scans 2,000 rows and discards 1,980. At page 1,000 it scans 20,000 rows for 20 results. The deeper
the page, the slower the query, proportionally.

Additionally, concurrent inserts/deletes cause rows to "drift" between pages: page 3 might skip a
row you already showed on page 2 (if a row was deleted) or repeat it (if a row was inserted).

### Cursor pagination — the right answer at any volume

Cursor pagination picks up where the last item left off using an inequality (`< lastValue`). Cost is
constant (O(log n) index seek) regardless of how deep you are.

```ts
// ✅ Cursor pagination using createdAt as the cursor
// First page — no cursor
async function getConversations(
  userId: string,
  cursor?: { id: string; createdAt: Date },
  take = 20,
) {
  return prisma.conversation.findMany({
    where: {
      userId,
      // After the first page, only return rows older than the last item seen
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              // Tie-break on id to handle rows with identical createdAt
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: { id: true, title: true, slug: true, createdAt: true },
  });
}

// Prisma's built-in cursor (single-column; simpler when the sort key is @id)
const page2 = await prisma.conversation.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
  cursor: { id: lastSeenId }, // Prisma cursor: `id` is the @id field
  skip: 1,                    // skip the cursor row itself
  take: 20,
});
```

**Prisma's `cursor` / `skip: 1` pattern** is the idiomatic cursor for paginating by `@id` or
`@unique` columns. For compound sort keys (e.g. `createdAt DESC`, tie-broken by `id`), the manual
`OR` approach above is more robust.

**Expose the cursor to the frontend** as an opaque token (base64-encode the `{id, createdAt}` pair):

```ts
// Backend response
const items = await getConversations(userId, decodedCursor);
const nextCursor =
  items.length === take
    ? Buffer.from(JSON.stringify({ id: items.at(-1)!.id, createdAt: items.at(-1)!.createdAt })).toString("base64url")
    : null;
res.json({ items, nextCursor });
```

The TanStack Query `useInfiniteQuery` hook on the frontend consumes `nextCursor` as `pageParam`.

### When offset is acceptable

- Admin/internal tooling where a human picks a specific page number.
- Tables that never exceed a few thousand rows (e.g. `User` — one row per registered account;
  `GmailConnection` — one per user).
- One-time exports / backfill scripts where performance is not latency-sensitive.

---

## 5 `count()` Cost and Approximate Counts

### Why `COUNT(*)` is expensive

In Postgres with MVCC, `COUNT(*)` must inspect every live tuple (row version visible to the current
transaction) — even with an index. On a `Message` table with 1M rows, `count()` takes hundreds of
milliseconds and holds a shared buffer lock for the duration.

```ts
// ❌ Called on every page load with a million messages — sequential scan
const total = await prisma.message.count({ where: { conversationId } });
```

### When exact count is cheap

`count()` on an **equality filter on an indexed column** is fast because Postgres can use an index-only
scan. For Lumina's access patterns:

```ts
// ✅ Fast — uses the @@index([conversationId]) index-only scan
const msgCount = await prisma.message.count({ where: { conversationId } });
// Typical: sub-millisecond for <10,000 messages per conversation
```

But `count({ where: {} })` (entire table) or `count()` with a range filter on a large table is slow.

### Approximate counts via `pg_class`

For UI "X total conversations" displays where ±5% error is acceptable, query Postgres's statistics
catalog instead of a real count:

```ts
// Approximate row count — updates after ANALYZE (runs automatically every ~minutes)
const result = await prisma.$queryRaw<[{ estimate: bigint }]>`
  SELECT reltuples::bigint AS estimate
  FROM   pg_class
  WHERE  relname = 'Conversation'
`;
const approxCount = Number(result[0].estimate);
```

The estimate can be wrong just after a bulk insert (before the next `ANALYZE`). For user-visible
counts in Lumina, this is acceptable; for a billing system, it is not.

### Counting with `_count` in select

Use `_count` in a `findMany` select instead of separate `count()` calls per row (another N+1 trap):

```ts
// ✅ One query; counts all related messages inline
const convosWithCount = await prisma.conversation.findMany({
  where: { userId },
  select: {
    id: true,
    title: true,
    _count: { select: { messages: true } },
  },
});
```

---

## 6 Connection Limits and Pooling at 100× / 10,000×

### The serverless connection problem

Each Vercel serverless invocation that imports `prisma` from `backend/db.ts` holds a Postgres
connection for the duration of the request. Postgres has a hard `max_connections` limit (Supabase
free tier: 60; Pro: 200; AWS RDS default: typically 100–500 depending on instance class). At Tier 1
(1 user, 1 request at a time) this is invisible. At Tier 2 (hundreds of concurrent requests during a
spike), serverless functions exhaust the Postgres connection pool and new requests fail with
`too many clients`.

**Lumina's current answer — `PrismaPg` driver adapter (`backend/db.ts:5`):**

```ts
// backend/db.ts
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

`PrismaPg` uses the `pg` Node pool under the hood (typically 1 connection in serverless context, but
holds it for the module lifetime). The module-level singleton in `db.ts` means all handlers in one
invocation share one connection — correct.

### Supabase Session Pooler (Transaction Mode) for serverless

For real traffic (Tier 2+), point `DATABASE_URL` at Supabase's built-in PgBouncer pooler in
**Transaction Mode**:

```
# .env (production)
DATABASE_URL=postgresql://postgres.xxxx:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

Port `6543` = PgBouncer transaction mode; port `5432` = direct. Transaction mode recycles the
connection after each transaction, allowing thousands of serverless invocations to share ~20
Postgres server connections.

**Transaction mode restriction:** prepared statements and some Prisma features that rely on
session-state (`SET`, `LISTEN`) don't work in transaction mode. `PrismaPg` with `pgbouncer: true`
disables prepared statements automatically:

```ts
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  // Optional: set a statement timeout for long-running queries
  options: "-c statement_timeout=30000",
});
```

To disable prepared statements (required for PgBouncer transaction mode), append `?pgbouncer=true`
to `DATABASE_URL` — the `pg` driver picks it up and skips prepared-statement protocol.

### `DIRECT_URL` for migrations

Migrations (`prisma migrate deploy`) must run against the **direct** connection, not the pooler
(DDL over transaction mode can deadlock). Use two env vars:

```
DATABASE_URL=postgresql://...pooler.supabase.com:6543/postgres   # serverless queries
DIRECT_URL=postgresql://...db.supabase.co:5432/postgres           # migrations only
```

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

### Read replicas at 10,000×

At Tier 3, separate read and write traffic:

- **Writes** (`create`, `update`, `delete`, `$transaction`) → primary.
- **Reads** (`findMany`, `findUnique`, `count`) → read replica.

Prisma does not natively route reads to replicas. Two approaches:
1. Instantiate two `PrismaClient` instances — one pointing at the primary's `DATABASE_URL`, one at
   a replica URL. Route manually in the application layer.
2. Use a proxy that understands read/write split (e.g. RDS Proxy, PgBouncer with multiple backends)
   and point a single `DATABASE_URL` at it.

For Lumina at current scale (Tier 1), this is premature. The correct moment to add a replica is when
P95 query latency degrades under read load and the primary CPU becomes the bottleneck.

### Materialized views for heavy aggregations

At Tier 3, aggregation queries (`GROUP BY`, `COUNT`, `SUM` across millions of rows) are too slow to
run on demand. Move them to Postgres materialized views, refreshed on a cron:

```sql
-- Example: conversation-per-user stats (not yet in Lumina's schema)
CREATE MATERIALIZED VIEW user_conversation_stats AS
SELECT
  "userId",
  COUNT(*) AS conversation_count,
  MAX("createdAt") AS last_conversation_at
FROM "Conversation"
GROUP BY "userId";

CREATE UNIQUE INDEX ON user_conversation_stats ("userId");

-- Refresh periodically (via cron → CRON_SECRET-guarded route)
REFRESH MATERIALIZED VIEW CONCURRENTLY user_conversation_stats;
```

Access via `$queryRaw`:

```ts
const stats = await prisma.$queryRaw<[{ userId: string; conversation_count: bigint }]>`
  SELECT "userId", conversation_count
  FROM user_conversation_stats
  WHERE "userId" = ${userId}
`;
```

`CONCURRENTLY` allows reads during refresh (requires a unique index). The view is slightly stale
(up to one refresh interval) — acceptable for analytics dashboards.

### Push aggregation to SQL, not the application layer

Never load thousands of rows into application memory to compute a sum or max. Always push
aggregation to Postgres:

```ts
// ❌ Load 50,000 messages to count characters
const msgs = await prisma.message.findMany({ where: { conversationId } });
const totalChars = msgs.reduce((s, m) => s + m.content.length, 0);

// ✅ Aggregate in Postgres — single query, constant memory
const result = await prisma.message.aggregate({
  where: { conversationId },
  _sum: { /* Prisma aggregate on scalar — works for numeric fields */ },
  _count: { id: true },
});

// For string length aggregation, use $queryRaw
const [{ total_chars }] = await prisma.$queryRaw<[{ total_chars: bigint }]>`
  SELECT COALESCE(SUM(LENGTH(content)), 0) AS total_chars
  FROM "Message"
  WHERE "conversationId" = ${conversationId}
`;
```

---

## 7 R-SCALE Battery Applied to Prisma Query Design

> This section directly applies the **product-scale-architecture R-SCALE** rule (per
> `C:\Users\Redsparrow\.claude\rules\product-scale-architecture.md`) to every query-design decision
> on Lumina's Prisma models. State plainly which tier the current implementation survives and what
> breaks at the next.

The R-SCALE rule requires answering the battery at three tiers:

| Tier | Load |
|---|---|
| 1× | 100–1,000 rows, 1–10 concurrent users (demo/MVP) |
| 100× | 10,000–100,000 rows, hundreds of concurrent users |
| 10,000× | 1M+ rows, lakhs of concurrent users |

---

### Section A — Listing and Browse

**Q1. How many items does the client hold in memory at once?**

Currently: the conversation sidebar query in `backend/index.ts` (the `GET /conversations` handler)
loads all conversations for a user — no `take` limit. If a power user has 500 conversations, all
500 are transferred and held in the TanStack Query cache.

- Tier 1 (few users, few conversations): acceptable.
- Tier 2+: add `take: 30` and cursor pagination. A user with 5,000 conversations should get 30 at a
  time, not 5,000.

**Q2. Filtering and sorting location?**

All filtering is on the server (Prisma `where` clause). This is correct at every tier. Do not filter
conversations in application memory (`Array.filter`).

**Q3. Pagination and virtualization?**

Current schema: no `take`/`cursor` in the conversation list. Fix: add cursor pagination (see §4
above). Frontend: for rendered lists over 50 items, add windowing (e.g. `@tanstack/react-virtual`).

**Q4. Which columns are indexed for the filters users use?**

Current state: **no `@@index` declarations** in `schema.prisma` for `Conversation` or `Message`
(`backend/prisma/schema.prisma`). Only `User.email` has an implicit index via `@unique`.

- `Conversation.userId` — unindexed. Every sidebar load is a full scan of the `Conversation` table.
- `Message.conversationId` — unindexed. Loading any conversation's messages is a full scan of the
  `Message` table.

Tier 1 survival: yes (small tables, fast sequential scan). Tier 2 break: sequential scans on 50,000+
rows start showing as 100ms+ query latency; P99 sidebar loads become seconds.

**Required remediation (migration):**
```prisma
model Conversation {
  // ... existing fields ...
  @@index([userId])
  @@index([userId, createdAt(sort: Desc)])
}

model Message {
  // ... existing fields ...
  @@index([conversationId])
  @@index([conversationId, createdId(sort: Asc)])
}
```

**Q5. Category navigation for 1M items?**

Not applicable to Lumina's conversation/message domain. Conversations are filtered by `userId` only
— not a browse-a-catalogue scenario.

**Tier verdict for listing/browse:**
- Tier 1: survives (demo volumes, fast sequential scans on small tables).
- Tier 2 break: missing indexes. Sidebar query hits a full `Conversation` table scan.
- Tier 3 additional break: no cursor pagination; offset pagination or no pagination loads entire
  user history.

---

### Section B — Search

**Q6. What kind of text match?**

Lumina's current implementation: no server-side search over `Conversation` or `Message` rows.
If conversation history search is added:

- Tier 1: client-side filter over the in-memory list with `Array.filter` + `String.includes`.
- Tier 2: Postgres full-text search via `tsvector` / `to_tsquery` on `Conversation.title` and
  `Message.content`, with a GIN index:
  ```sql
  CREATE INDEX message_content_fts ON "Message" USING GIN (to_tsvector('english', content));
  ```
  Via Prisma raw:
  ```ts
  const hits = await prisma.$queryRaw`
    SELECT id, "conversationId", LEFT(content, 200) AS snippet
    FROM   "Message"
    WHERE  "conversationId" = ANY(${conversationIds}::uuid[])
      AND  to_tsvector('english', content) @@ plainto_tsquery('english', ${query})
    LIMIT  20
  `;
  ```
- Tier 3: dedicated search engine (Typesense / Meilisearch) fed by a change-data-capture pipeline
  from Postgres.

**Q7. Debounce?**

Search input must be debounced (~250ms) on the frontend to avoid per-keystroke DB queries.
See `lumina-frontend` skill for the TanStack Query `enabled` + `refetchOnMount` pattern with
a `useDebounce` hook.

**Q8. Where does search run?**

Semantic cache (`CachedQuery`) search already runs server-side via pgvector cosine `<=>` over the
`embedding` column. The vector index (IVFFlat or HNSW) must exist in Supabase for this to be
sub-100ms. See `lumina-pgvector-and-raw-queries.md`.

**Q9. Ranking?**

Semantic cache: ranked by cosine distance (lower = better). For full-text search of messages:
`ts_rank` or `ts_rank_cd` on the `tsvector`. Not yet implemented.

**Q10. Autocomplete?**

Not currently built. At Tier 2+, a separate table of query completions with a `text_pattern_ops`
B-tree index on the prefix is the right approach:

```sql
CREATE INDEX conversation_title_prefix ON "Conversation" (title text_pattern_ops);
-- Enables: WHERE title LIKE 'pref%' using the index
```

**Tier verdict for search:**
- Tier 1: client-side filter survives (small history per user).
- Tier 2 break: client-side filter over thousands of messages is slow (200ms+); need server-side FTS.
- Tier 3 break: Postgres FTS can't compete with dedicated search engines at millions of messages.

---

### Section D — Contested Writes

The R-SCALE §D pattern applies to any resource where multiple concurrent requests compete to modify
shared state. In Lumina's current schema, the primary contested surface is the **user provisioning
upsert** in `auth.ts`. A future `credits`/`quota` column on `User` would be another.

**Q14. When is the resource claimed?**

User provisioning (`auth.ts:55`): `prisma.user.upsert` with `where: { email }`. The `email` column
is `@unique`, so Prisma translates this to an `INSERT ... ON CONFLICT DO UPDATE SET ...` — one atomic
statement. Two concurrent requests for the same new user will produce exactly one row. Correct.

**Q15. Atomic guarded decrement?**

Not yet applicable (no inventory/quota model). When a `creditsRemaining` column is added to `User`,
the decrement MUST be:

```ts
// ✅ Atomic guarded decrement — one statement, DB row lock enforces the guard
const updated = await prisma.user.update({
  where: {
    id: userId,
    creditsRemaining: { gt: 0 },  // guard: fail atomically if already 0
  },
  data: { creditsRemaining: { decrement: 1 } },
});
// If no row was updated (count = 0), the guard triggered → 402 Payment Required
```

Never:
```ts
// ❌ Read-then-write — race condition: two concurrent requests both read 1, both write 0-1 = 0
const user = await prisma.user.findUnique({ where: { id: userId } });
if (user.creditsRemaining <= 0) throw new Error("out of credits");
await prisma.user.update({ where: { id: userId }, data: { creditsRemaining: user.creditsRemaining - 1 } });
```

**Q16. Reservation TTL?**

If a future feature reserves a slot (e.g. a scheduled action), the reservation must expire. Implement
as a `reservedUntil: DateTime?` column. A cron job (guarded by `CRON_SECRET`) releases expired
reservations:

```ts
// Cron: release reservations older than N minutes
await prisma.someReservation.deleteMany({
  where: { reservedUntil: { lt: new Date() } },
});
```

**Q17. Idempotency?**

User upsert (`auth.ts`) is idempotent by `email` — the `provisionedUsers` Set in the auth
middleware prevents even the upsert round-trip on subsequent requests within the same process. For
external-facing endpoints that create resources (e.g. a future "send email" action), pass an
idempotency key:

```ts
// Client sends X-Idempotency-Key header; backend stores it with the result
const existingResult = await prisma.idempotencyKey.findUnique({ where: { key } });
if (existingResult) return res.json(existingResult.response);
// ... perform action ...
await prisma.idempotencyKey.create({ data: { key, response: result } });
```

**Tier verdict for contested writes:**
- Tier 1: current `upsert` on `email` is correct and atomic.
- Tier 2+: if credits/quotas are added, the read-then-write pattern is a race condition under
  concurrent load. Use atomic guarded decrement from day one.

---

## 8 Putting It Together: Query Review Checklist

Before marking a PR done on any Prisma query, answer these:

```
1. N+1?
   □ Every relation is loaded via include/select or a single batched `in`, never a loop of finds.

2. Over-fetch?
   □ select/omit present on wide models (GmailConnection → no secrets; Message → content only when needed).
   □ No `findMany({ include: { messages: true } })` for sidebar/list views.

3. Indexes?
   □ Every WHERE column has a @@index (or @unique).
   □ Every ORDER BY column is part of an index (single or composite).
   □ If missing, a migration adding the index is part of this PR.

4. Pagination?
   □ Any list that can grow (Conversation, Message) uses take + cursor.
   □ No unbounded findMany() on production paths.

5. Count?
   □ count() is either on an indexed equality filter (fast) or replaced with an approximate count
     or _count select.
   □ No count({ where: {} }) on large tables.

6. Connections?
   □ prisma is imported from the module-level singleton (backend/db.ts), never re-instantiated.
   □ DATABASE_URL points at the pooler in prod (port 6543), DIRECT_URL at the direct connection.

7. Contested write?
   □ Any decrement/increment is atomic + guarded in one Prisma statement, not read-then-write.
   □ Upserts key on a @unique column (not a lookup + create pair).

8. R-SCALE tier stated?
   □ The PR description states which tier this query survives and what breaks next.
```

---

## See also

**Same skill (prisma):**
- `prisma-client-api.md` — full Prisma query API: findMany, create, upsert, filters, nested writes.
- `prisma-transactions-and-concurrency.md` — $transaction, atomic guarded writes, idempotency.
- `prisma-schema-modeling.md` — adding @@index, field types, relations.
- `prisma-driver-adapters-and-deployment.md` — PrismaPg, Supabase pooler, DATABASE_URL wiring.
- `prisma-testing-and-mocking.md` — the prisma-fake seam, unit testing queries.
- `lumina-prisma-architecture.md` — the full wiring map (db.ts, schema, generated client, topology).
- `lumina-pgvector-and-raw-queries.md` — vector column, cosine ANN index, $queryRaw.

**Other skills:**
- `redis` — the Upstash hot cache (`backend/lib/cache.ts`) for market data; stale-while-revalidate
  pattern; the in-memory fallback for local dev.
- `supabase` — Supabase auth (the only thing Supabase owns here); RLS not used; extension management.
- `rag-retrieval` — semantic cache retrieval algorithm over `CachedQuery.embedding`; cosine threshold
  tuning; the pgvector HNSW/IVFFlat index creation.
- `finance-markets` — `backend/finance/routes.ts` cache patterns; the `getOrRefresh` + R-SCALE
  read-spike application to market data.
- `connectors-oauth` — `GmailConnection` encryption semantics; token vault; AES-GCM key in env.
- `backend-testing` — `backend/tests/helpers/prisma-fake.ts`; how to mock Prisma in bun:test.
- `lumina-frontend` — TanStack Query `useInfiniteQuery` for cursor pagination; debounce hooks.
