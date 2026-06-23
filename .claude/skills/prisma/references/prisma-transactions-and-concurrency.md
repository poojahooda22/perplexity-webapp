# Prisma Transactions and Concurrency

> Atomic writes, guarded counters, isolation levels, optimistic concurrency, idempotency, and
> deadlock recovery — the full playbook for contested data in Prisma 7 on Lumina's Supabase
> Postgres stack. Maps directly to **R-SCALE §D (contested writes)** and **§G (order/transaction
> pipeline)**.

---

## Quick orientation

Two questions determine which pattern you need:

1. **Are multiple operations logically one unit?** (Both succeed or both roll back.) → `$transaction`.
2. **Are multiple requests racing to modify the same row?** (Only one should win.) → atomic guarded
   write, possibly inside `$transaction`.

The two problems are separate but often appear together. A checkout flow that decrements inventory
AND creates an order record needs _both_: `$transaction` to keep the pair atomic, and an
`{ increment }` / `{ decrement }` guard to prevent races.

---

## 1. `$transaction` — Array Form vs Interactive Form

### 1.1 Array form: sequential, all-or-nothing

Pass an array of Prisma operations. They execute in order inside a single database transaction.
If any step throws, the database rolls back every preceding step automatically.

```typescript
// backend/index.ts:443 — delete a conversation atomically:
// Messages have a FK ON DELETE RESTRICT, so they must be removed before the parent row.
await prisma.$transaction([
  prisma.message.deleteMany({ where: { conversationId } }),
  prisma.conversation.delete({ where: { id: conversationId } }),
]);
```

Because the two statements share a transaction, there is no window where the conversation row
exists but its messages are already gone (or vice-versa). A crash between the two `DELETE`s rolls
both back.

**Constraints of the array form:**

- Each operation in the array is built before any of them execute. You cannot read the result of
  step 1 to decide what step 2 does.
- No conditional logic inside the transaction.
- Use it for simple "delete A then B", "insert X and Y together", or batch creates where every
  row is independent.

### 1.2 Interactive form: dependent operations and conditional logic

Pass an `async (tx) => { ... }` callback. Prisma opens a transaction, gives you a `tx` client
scoped to that transaction, runs your callback, and commits on return or rolls back on throw.

```typescript
await prisma.$transaction(async (tx) => {
  // Step 1 — read the current balance inside the transaction.
  const connection = await tx.gmailConnection.findUniqueOrThrow({
    where: { userId },
    select: { scopes: true, refreshTokenEnc: true, iv: true, authTag: true },
  });

  // Step 2 — conditional check: only update if scopes changed.
  if (connection.scopes === newScopes) return; // rolls back (a no-op commit)

  // Step 3 — write depends on step 1's result.
  await tx.gmailConnection.update({
    where: { userId },
    data: { scopes: newScopes, updatedAt: new Date() },
  });
});
```

The `tx` client behaves exactly like `prisma` — all the same methods — but every call goes
through the open transaction. Use `OrThrow` variants inside interactive transactions freely: a
thrown error auto-rolls back, which is what you want.

**When to use interactive over array form:**

| Situation | Use |
|-----------|-----|
| Fixed list of independent writes | Array form |
| Need to read a result to decide the next write | Interactive |
| Need conditional logic (throw to abort) | Interactive |
| Need to check a business constraint mid-transaction | Interactive |
| Complex balance / inventory logic | Interactive |

### 1.3 Transaction options

```typescript
await prisma.$transaction(
  async (tx) => {
    // ... operations
  },
  {
    maxWait: 5_000,   // ms to wait for a connection slot (default: 2 000)
    timeout: 10_000,  // ms before the transaction is force-rolled-back (default: 5 000)
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  }
);
```

On Vercel's serverless runtime (25-second function timeout), keep `timeout` well below 25 000 ms
or the transaction can outlive the function instance. On Lumina, most writes are simple enough
that the defaults (2 s / 5 s) are fine; finance or connector writes that call external APIs
should do those calls _outside_ the transaction and only write results inside it.

---

## 2. Isolation Levels — When to Raise Them

Postgres defaults to `ReadCommitted`. For most of Lumina's writes (creating a message, upserting
a user, saving a Gmail connection) this is correct. The table below shows when to raise it.

| Level | What it prevents | Postgres default? | When to use on Lumina |
|-------|-----------------|-------------------|-----------------------|
| `ReadCommitted` | Dirty reads | ✅ Yes | General CRUD — conversations, messages, connector rows |
| `RepeatableRead` | Non-repeatable reads (a row you've read can't change until you commit) | No | Any "read-check-write" sequence inside an interactive transaction where the check must be consistent with the later write |
| `Serializable` | Phantom reads, write skew | No | Strict financial invariants, any case where two concurrent transactions could each pass a check and both write in a way that violates a constraint |

```typescript
// Raise to RepeatableRead when the correctness of a conditional write
// depends on a read done earlier in the same transaction.
await prisma.$transaction(
  async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    // Under ReadCommitted another transaction could change `user.provider` between
    // this read and the update below. RepeatableRead prevents that.
    if (user.provider !== "Google") throw new Error("Only Google users may link Gmail");
    await tx.gmailConnection.create({ data: { userId, /* ... */ } });
  },
  { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
);
```

Raising the isolation level increases lock contention and the chance of serialization errors
(Postgres aborts a transaction and makes you retry). Do not reach for `Serializable` by default;
use it only when you have confirmed that `RepeatableRead` alone cannot prevent a specific
anomaly.

---

## 3. The Read-Then-Write Race Condition — The Core Scale Hazard

### Why app-code read-modify-write is wrong

This pattern is the most common concurrency defect in web apps. It feels correct under load:

```typescript
// ❌ WRONG — classic read-then-write in application code:
const conversation = await prisma.conversation.findUnique({ where: { id } });
const count = conversation!.messageCount + 1;  // read
await prisma.conversation.update({
  where: { id },
  data: { messageCount: count },               // write
});
```

Under concurrent requests the race looks like this:

```
Request A reads messageCount = 5
Request B reads messageCount = 5
Request A writes messageCount = 6
Request B writes messageCount = 6   ← should be 7
```

Both requests succeed, but the counter is wrong. The error is invisible in development (single
user), appears only under load, and corrupts persistent data.

**The fix is a single database statement that reads _and_ writes atomically — never two round
trips.** The database's row-level lock ensures serialization; no amount of application-level
logic can replicate that without acquiring the same lock.

---

## 4. Atomic Numeric Operations: `{ increment }`, `{ decrement }`, `{ multiply }`

Prisma's update data accepts atomic operators for numeric fields. These translate to a single SQL
expression (`col = col + N`), not a read followed by a write.

```typescript
// Correct: one SQL statement — no round trip, no race window.
await prisma.conversation.update({
  where: { id: conversationId },
  data: { messageCount: { increment: 1 } },
});
```

Available operators on `Int` / `Float` / `Decimal` fields:

```typescript
data: { qty: { increment: 1 } }   // qty = qty + 1
data: { qty: { decrement: 1 } }   // qty = qty - 1
data: { qty: { multiply: 2 } }    // qty = qty * 2
data: { qty: { set: 0 } }         // qty = 0  (explicit overwrite — not atomic in the race sense)
```

Use `{ set: N }` only when you own the authoritative value (e.g. a user explicitly setting a
preference to a known value). Never use `{ set }` to overwrite a counter you just read from the
database.

---

## 5. Guarded Atomic Write Pattern for Contested Resources

When multiple concurrent requests compete for a finite resource (inventory units, conversation
slots, rate-limit budgets), add the guard directly to the `where` clause of the `update`. The
update either matches and returns the updated row, or matches nothing (0 rows updated), which
means the race was lost.

```typescript
// The row lock is the single ticket window.
// "Update the row ONLY IF the guard condition is still true."
const result = await prisma.rateSlot.updateMany({
  where: {
    userId,
    remaining: { gt: 0 },   // guard: only proceed if slots remain
  },
  data: {
    remaining: { decrement: 1 },
  },
});

if (result.count === 0) {
  // This request lost the race — the quota was already exhausted.
  return res.status(429).json({ error: "Rate limit exhausted" });
}
// result.count === 1 → this request atomically claimed one slot.
```

`updateMany` returns `{ count: number }`. `count === 0` means the guard failed: another request
won or the condition was already false. `count === 1` means this request atomically decremented
the counter from a positive value.

### Why this is correct

Postgres executes `UPDATE ... WHERE ... AND remaining > 0 SET remaining = remaining - 1` as a
**row-level lock + CAS in a single statement**. Only one concurrent writer can hold the row lock
at a time. The first writer to acquire it evaluates the guard, decrements, and commits. Every
subsequent concurrent writer re-evaluates against the committed value. When the value reaches 0
the guard fails for all of them.

This is identical in structure to the R-SCALE §D pattern for contested inventory:
> One statement of the form `UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0` — the
> database row lock is the single ticket window; request 51 fails the guard and gets "out of
> stock". Never read-then-write from app code.

### Guarded write with `findUnique` + `update` in a transaction

When you also need to read fields from the row (to validate business logic beyond the numeric
guard), use an interactive transaction:

```typescript
const result = await prisma.$transaction(async (tx) => {
  // The SELECT ... FOR UPDATE implicit in the subsequent update holds the lock.
  const slot = await tx.gmailConnection.findUnique({
    where: { userId },
    select: { scopes: true },
  });
  if (!slot) throw new Error("No Gmail connection");
  if (!slot.scopes.includes("https://mail.google.com/")) {
    throw new Error("Missing mail scope — user must re-authorize");
  }
  return tx.gmailConnection.update({
    where: { userId },
    data: { updatedAt: new Date() },
  });
}, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
```

---

## 6. Optimistic Concurrency with a Version Column

When rows are rarely contested but you still want to detect conflicts rather than silently
overwriting, add a `version Int @default(1)` field and include it in the `where` guard:

```prisma
// schema.prisma addition (hypothetical — not yet in Lumina's schema)
model Conversation {
  id      String @id @default(uuid())
  title   String?
  version Int    @default(1)
  // ...
}
```

```typescript
// Read the row including the current version.
const conversation = await prisma.conversation.findUniqueOrThrow({
  where: { id: conversationId },
  select: { id: true, title: true, version: true },
});

// Try to update, but ONLY if nobody changed it since we read it.
const updated = await prisma.conversation.updateMany({
  where: {
    id: conversationId,
    version: conversation.version,   // optimistic guard
  },
  data: {
    title: newTitle,
    version: { increment: 1 },       // bump so next writer's guard fails
  },
});

if (updated.count === 0) {
  // Another writer changed the row between our read and this write.
  // Return a 409 Conflict; the caller should re-read and retry.
  throw new ConflictError("Conversation was modified concurrently — please retry");
}
```

**Optimistic vs pessimistic (guarded update without version):**

| | Optimistic (version column) | Pessimistic (WHERE guard + `gt`/`lt`) |
|---|---|---|
| Use when | Conflicts are rare; you want to detect them | Conflicts are common; you want to win or fail fast |
| Performance | No lock contention on reads | Lock contention only on the update row |
| Developer overhead | Must carry version through all reads/writes | Simpler — just add the guard in `where` |
| Example | Collaborative editing of a title | Inventory counter decrement |

For Lumina's current scale (single user per conversation, one Gmail connection per user), the
`updateMany`-with-guard pattern covers every real case. Adopt the version column if you add
multi-party editing.

---

## 7. Idempotency: `upsert` and Idempotency Keys

### `upsert` on a unique key

An `upsert` is an idempotent write: calling it multiple times with the same unique key produces
exactly one row. Lumina uses this in `backend/auth.ts` to provision users:

```typescript
// backend/auth.ts:55-67 — idempotent user provisioning.
// The `where` key is `email` (unique in the schema). If the row already exists
// (user has logged in before), the `update: {}` is a no-op. The first call creates;
// every subsequent call for the same email is safe.
await prisma.user.upsert({
  where: { email: user.email! },
  update: {},                        // intentionally empty — we don't overwrite anything
  create: {
    id: user.id,
    email: user.email!,
    provider: user.app_metadata.provider === "google" ? "Google" : "Github",
    name: user.user_metadata.full_name ?? user.email!,
    supabaseId: user.id,
  },
});
```

Key points:
- The `where` field must match a `@unique` or `@id` column — Prisma enforces this at the type
  level.
- `update: {}` makes the upsert a pure "create if not exists" — the empty object is intentional.
- A retry of the same Supabase token (within or across the 5-minute `tokenCache` TTL) will hit
  the `provisionedUsers` Set guard first and skip the DB round-trip entirely; the `upsert` is
  the DB-level safety net beneath that in-memory optimisation.

### Idempotency keys for retried requests

For operations triggered by webhooks or external retries (future payment gateway, cron
callbacks), add an `idempotencyKey String @unique` column and `upsert` on it:

```typescript
// Hypothetical future payment confirmation handler.
// The gateway sends the same webhook multiple times until it gets 200.
await prisma.$transaction(async (tx) => {
  // Try to create the confirmation record. If the key already exists,
  // this is a duplicate delivery — the earlier call already did the work.
  const created = await tx.paymentConfirmation.upsert({
    where: { idempotencyKey: webhookPayload.idempotencyKey },
    update: {},   // duplicate delivery — row already exists, do nothing
    create: {
      idempotencyKey: webhookPayload.idempotencyKey,
      userId,
      amount: webhookPayload.amount,
      status: "confirmed",
    },
  });

  // Only execute downstream effects on the FIRST delivery (when the row was just created).
  if (created.status !== "confirmed") return; // already processed

  await tx.user.update({
    where: { id: userId },
    data: { credits: { increment: webhookPayload.amount } },
  });
});
```

The pattern maps to R-SCALE §G point 23:
> What happens when payment succeeds but the confirmation message is lost (webhook retry +
> idempotent handler)?

The `upsert` on the idempotency key is the handler's database-level answer: the first delivery
creates the record and executes downstream effects; every retry finds the existing record and
short-circuits.

---

## 8. Deadlocks, Serialization Failures, and Retry-with-Backoff

### What causes deadlocks?

A deadlock occurs when two concurrent transactions each hold a lock the other needs:

- Transaction A locks row 1, then tries to lock row 2.
- Transaction B locks row 2, then tries to lock row 1.
- Neither can proceed; Postgres kills one and returns an error.

Prisma surfaces this as a `PrismaClientKnownRequestError` with code `P2034` or as a raw
Postgres error with code `40P01` (deadlock detected) or `40001` (serialization failure, under
`Serializable` isolation).

### Preventing deadlocks by ordering

The most reliable prevention is to **always acquire locks in the same order**. If every
transaction that touches both `Conversation` and `Message` always locks in the same order
(`Conversation` first, then `Message`), deadlocks cannot form.

In Lumina's delete path (`backend/index.ts:443`), the array-form transaction deletes messages
first, then the conversation — a consistent order that prevents the inverse pattern from
appearing in other code paths.

### Retry-with-backoff

When you cannot fully prevent deadlocks (e.g. user-triggered concurrent writes at unpredictable
timings), wrap the transaction in a retry loop with exponential backoff:

```typescript
import { PrismaClientKnownRequestError } from "./prisma/generated/prisma/client.js";

async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, baseDelayMs = 50 }: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetriable =
        err instanceof PrismaClientKnownRequestError &&
        (err.code === "P2034" ||                       // transaction conflict / timeout
          (err.meta as { code?: string })?.code === "40P01" || // deadlock
          (err.meta as { code?: string })?.code === "40001");   // serialization failure

      if (!isRetriable || attempt === maxAttempts) throw err;

      // Exponential back-off with jitter — avoid lock-step retry storms.
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // TypeScript: unreachable, but satisfies the return type.
  throw new Error("withRetry: exhausted attempts");
}

// Usage:
await withRetry(() =>
  prisma.$transaction(async (tx) => {
    // ... contested writes
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
);
```

**When to apply retry logic:**

- `Serializable` isolation: the isolation level itself causes Postgres to abort transactions to
  prevent anomalies; retries are required by design.
- Deadlocks under high concurrent write volume to the same rows.
- **Do not** retry on `P2002` (unique constraint violation) — that is a real business error
  (e.g. duplicate email), not a transient lock conflict.

### Keep transactions short

The single biggest deadlock-prevention measure is keeping transaction duration minimal:

```typescript
// ❌ Bad: fetch external data INSIDE the transaction (holds locks for the API round-trip)
await prisma.$transaction(async (tx) => {
  const token = await fetchGoogleOAuthToken(refreshToken);  // external HTTP call, seconds
  await tx.gmailConnection.update({ where: { userId }, data: { /* ... token fields */ } });
});

// ✅ Good: do all external work BEFORE opening the transaction
const token = await fetchGoogleOAuthToken(refreshToken);   // outside — no lock held
await prisma.$transaction(async (tx) => {
  await tx.gmailConnection.update({ where: { userId }, data: { /* ... token fields */ } });
});
```

On Lumina this maps directly to the constraint that Vercel function timeouts are 25 seconds —
a transaction that holds locks across an LLM call or Tavily search would routinely hit the
database `timeout` option and auto-roll back.

---

## 9. Mapping to R-SCALE §D and §G

### §D — Contested Writes

The R-SCALE §D battery asks specifically:

> **D14.** When is stock actually claimed — add-to-cart (wrong: cart hoarding) or
> checkout/payment (right, with a short reservation)?
>
> **D15.** Is the decrement atomic and guarded? One statement of the form
> `UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0`.
>
> **D16.** Reservation TTL.
>
> **D17.** Idempotency: a retried/double-tapped request must not decrement twice.

The Prisma translations:

| R-SCALE question | Prisma pattern |
|-----------------|----------------|
| D15 — atomic guarded decrement | `updateMany({ where: { qty: { gt: 0 } }, data: { qty: { decrement: 1 } } })` |
| D15 — check for 0 rows = lost race | `if (result.count === 0) return 409` |
| D16 — reservation TTL | A `reservedUntil DateTime` column; a background job (external cron hitting a `CRON_SECRET` route) runs `deleteMany({ where: { reservedUntil: { lt: new Date() } } })` to return expired reservations to the pool |
| D17 — idempotency | `upsert` on `idempotencyKey @unique`; the second call hits `update: {}` and returns without re-decrementing |

**Current Lumina surface:** the semantic cache `CachedQuery` table is not a contested resource
(writes are append-only; concurrent inserts of different queries do not conflict). The
`GmailConnection` table has `userId @unique`, so a concurrent re-auth attempt produces a
`P2002` unique-constraint violation — handle with `upsert` on `userId` rather than `create`.

### §G — Order/Transaction Pipeline

The R-SCALE §G battery asks:

> **G22.** Is placement split into states (PLACED → PAYMENT_PENDING → CONFIRMED → FULFILLED)?
>
> **G23.** What happens when payment succeeds but confirmation is lost?
>
> **G24.** What is the compensating action when a later step fails?

The Prisma translations:

| R-SCALE question | Prisma pattern |
|-----------------|----------------|
| G22 — state machine | An `enum OrderStatus` column; transitions are atomic `update({ where: { id, status: "PLACED" }, data: { status: "PAYMENT_PENDING" } })` — the `where: { status: "PLACED" }` guard prevents a CONFIRMED order from being moved back |
| G23 — idempotent webhook handler | `upsert` on `idempotencyKey`; the second webhook delivery hits `update: {}` and short-circuits |
| G24 — compensating action | `$transaction([update stock back, update order status to CANCELLED])` — both steps or neither |

**Current Lumina surface:** Lumina does not yet have an order pipeline. These patterns are
documented here so that if billing/credits are added, the database layer uses the correct
primitives from the start rather than retrofitting atomicity after the first double-charge
incident.

---

## 10. Quick Reference

### Choosing the right primitive

```
Need to write two rows together, no logic between?
  → $transaction([...]) — array form

Need to read before deciding what to write?
  → $transaction(async (tx) => ...) — interactive

Need to modify a number without reading it first?
  → { increment } / { decrement } / { multiply } in data

Need to claim a resource only if still available?
  → updateMany({ where: { id, qty: { gt: 0 } }, data: { qty: { decrement: 1 } } })
  → count === 0 means lost race

Need one row regardless of whether it exists?
  → upsert on a @unique field; update: {} if you want "create if not exists"

Need to detect concurrent modification?
  → version Int + where: { id, version } + data: { version: { increment: 1 } }

Two concurrent transactions keep conflicting?
  → Order lock acquisition consistently; add withRetry() for Serializable isolation
```

### Prisma error codes for concurrency

| Code | Meaning | Action |
|------|---------|--------|
| `P2002` | Unique constraint violation | Business error — tell the caller (e.g. 409 Conflict); do not retry blindly |
| `P2025` | Record not found (`OrThrow` variants) | Business error — 404; do not retry |
| `P2034` | Transaction conflict / timeout | Retriable — use `withRetry()` |
| `40P01` (via `meta.code`) | Postgres deadlock detected | Retriable — use `withRetry()`; also reorder lock acquisition |
| `40001` (via `meta.code`) | Serialization failure | Retriable — expected under `Serializable` isolation |

---

## See also

**Within this skill:**
- `lumina-prisma-architecture.md` — the full `db.ts` + schema wiring, where every Prisma call
  lives in the backend.
- `prisma-client-api.md` — the complete query API (`findMany`/`create`/`upsert`/filters/
  relations) that the transaction methods build on.
- `prisma-performance-and-rscale.md` — N+1, indexing, pagination, and the full R-SCALE battery
  applied to Prisma.
- `prisma-testing-and-mocking.md` — how to unit-test transaction logic with the `prisma-fake`
  seam.

**Other skills:**
- `supabase` — auth + RLS; `prisma` and `supabase` share the Postgres instance but are otherwise
  separate concerns.
- `redis` — the `backend/lib/cache.ts` Upstash layer for hot-reads; not a transactional store.
- `rag-retrieval` — the cosine `<=>` semantic cache query that uses `$queryRaw` on the
  `CachedQuery` table (this doc owns the `$transaction` plumbing; that skill owns retrieval
  semantics).
- `finance-markets` — uses the read-only cache layer, not direct DB writes; no concurrency
  hazard there. If financial credits/billing land, D14–D17 patterns apply directly.
- `connectors-oauth` — the `GmailConnection` `upsert` on `userId @unique` is the first place
  these idempotency patterns matter in the live code.
- `backend-testing` — the `prisma-fake.ts` seam and `bun:test` harness for asserting that
  guarded writes and transactions behave correctly under concurrent mocks.
- `lumina-frontend` — never calls Prisma directly; all writes flow through the Express routes
  documented in `backend/index.ts`.
