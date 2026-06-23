# Prisma Testing and Mocking

> How to test Prisma-backed code without a running database: the tiered strategy, the `prismaFake`
> seam, `mock.module` wiring, and what to assert.

---

## 1. The Tiered Testing Strategy

Prisma tests live at three altitudes. Use the right one for the work at hand — each has a different
cost/fidelity tradeoff.

### Tier 1 — Pure Unit (no Prisma at all)

Functions that accept data and return data: query builders, slug generators, slug transformers,
response shapers. These never import `db.ts` and need no fake. Test them with plain inputs/outputs.

```ts
// backend/lib/slug.ts — pure function, no Prisma
import { slugify } from "../lib/slug.js";
test("slugify lowercases and replaces spaces", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});
```

**What belongs here:** `lib/slug.ts`, `lib/wire.ts`, `lib/query-policy.ts`, `lib/models.ts`,
`prompt.ts`, any helper whose signature is `(input) => output`.

### Tier 2 — Mocked-Prisma Module (the primary workhorse)

The module under test (a middleware, a route handler, a service function) **imports `prisma` from
`./db.js`**. In tests, `mock.module` replaces `db.ts` with `prismaFake` before any import executes.
The test drives the fake's return values and then asserts on its `.mock.calls`.

This tier covers:

- `auth.ts` — `prisma.user.upsert` during provisioning
- `index.ts` route handlers — `conversation.findMany`, `conversation.create`, `message.create`,
  `$transaction`, `$queryRaw`, `$executeRaw`
- `connectors/gmail/store.ts` — `prisma.gmailConnection.*`

No network, no database, sub-millisecond execution.

### Tier 3 — Route Integration

A real (or test-scoped) Express app, real Supabase JWT, real Postgres. Reserved for:

- Full-stack contract tests before a major release
- Verifying a migration actually ran the expected schema

Not in the current test suite (the Bun tests are Tier 1 + 2). When you add Tier 3 tests, stand up
a test Postgres via Docker or use Supabase's local CLI, and run migrations before the suite.

---

## 2. The `prismaFake` Seam

**Location:** `backend/tests/helpers/prisma-fake.ts:1`

The fake is a plain object whose shape mirrors the Prisma client methods the codebase actually calls.
Every method is a **Bun mock function** (created via `mock(async (..._args) => undefined)`), so it
starts as a no-op and lets each test install exactly the return value it needs.

```ts
// backend/tests/helpers/prisma-fake.ts (full file)
import { mock } from "bun:test";

const fn = () => mock(async (..._args: unknown[]) => undefined as unknown);

export const prismaFake = {
  user: { upsert: fn() },
  conversation: {
    findMany: fn(),
    findFirst: fn(),
    create: fn(),
    updateMany: fn(),
    delete: fn(),
  },
  message: { create: fn(), deleteMany: fn() },
  $transaction: mock(async (ops: unknown) => (Array.isArray(ops) ? ops : ops)),
  $queryRaw: fn(),
  $executeRaw: fn(),
};

export function resetPrisma() {
  const all = [
    prismaFake.user.upsert,
    ...Object.values(prismaFake.conversation),
    ...Object.values(prismaFake.message),
    prismaFake.$transaction,
    prismaFake.$queryRaw,
    prismaFake.$executeRaw,
  ];
  for (const m of all) (m as ReturnType<typeof mock>).mockReset();
}
```

### What `fn()` gives you

`mock(async (..._args) => undefined)` creates a Bun mock function that:

- Resolves to `undefined` by default (safe null-op — callers that `await` get `undefined`, not a
  thrown error).
- Records every call in `.mock.calls` — an array of argument tuples.
- Responds to `.mockResolvedValue(v)`, `.mockResolvedValueOnce(v)`, `.mockRejectedValue(e)`.

### Why `$transaction` is wired differently

The interactive-transaction callback variant (`$transaction(async (tx) => { ... })`) passes a
function. The batch variant (`$transaction([op1, op2])`) passes an array of promises already. The
fake handles the array case by returning it as-is — which is correct for the `DELETE messages +
DELETE conversation` usage in `backend/index.ts:443`. If you add a callback transaction, you will
need to update the fake to call `ops(prismaFake)`.

### `resetPrisma()` — call in `beforeEach`, always

Bun runs an entire test suite in one process. Mocks accumulate `.mock.calls` across tests. Calling
`resetPrisma()` in `beforeEach` clears call history AND any `mockResolvedValueOnce` stubs that were
not consumed. Forgetting this is the most common source of mysteriously flaky tests.

```ts
beforeEach(() => {
  resetPrisma();
  resetSupabase();
});
```

---

## 3. Wiring the Fake with `mock.module`

### The preload contract

`mock.module` must run **before any test file imports the code under test**. In Bun, `import`
statements are hoisted to the top of the module graph — by the time the test file body executes,
`auth.ts` has already imported the real `prisma` from `db.ts`. The only safe insertion point is the
**preload** file, configured in `bunfig.toml`:

```toml
# backend/bunfig.toml
[test]
preload = ["./tests/setup/test-preload.ts"]
```

The preload runs once before any test file loads:

```ts
// backend/tests/setup/test-preload.ts
import { mock } from "bun:test";
import { prismaFake } from "../helpers/prisma-fake";
import { createSupabaseClient } from "../helpers/supabase-fake";

// Deterministic env so imports don't throw for missing creds.
process.env.DATABASE_URL   ||= "postgresql://test:test@localhost:5432/test";
process.env.SUPABASE_URL   ||= "http://localhost:54321";
// ... other env vars ...

// Replace the real Prisma client with the fake, process-wide.
mock.module("../../db.ts", () => ({ prisma: prismaFake }));
mock.module("../../client.ts", () => ({ createSupabaseClient }));
```

After this runs, every subsequent `import { prisma } from "./db.js"` anywhere in the process
receives `prismaFake` instead of the real `PrismaClient`.

### Path resolution note

The path inside `mock.module(path, ...)` is resolved **relative to the preload file's directory**
(`backend/tests/setup/`), not relative to the test file that later calls the mocked module. So from
`backend/tests/setup/`, the backend root is `../../db.ts`.

Do NOT use `../../db.js` (with `.js`). The `mock.module` call is resolved by Bun's module system
at preload time; Bun accepts `.ts` paths here even though your source files import with `.js`
extensions (the ESM requirement is for the Vercel build, not for Bun's test runner).

### What if a new file needs mocking?

Add more `mock.module(...)` calls to `test-preload.ts`. If you forget and a test imports a file
that does real I/O (hitting `new PrismaClient()`), the test will fail with a Postgres connection
error — easy to diagnose.

---

## 4. Testing Auth Provisioning and a Transaction Path

### 4.1 Auth provisioning upsert

`backend/auth.ts` calls `prisma.user.upsert` on the first request from any given Supabase user ID
(guarded by a `provisionedUsers` Set). Here is the full test file:

```ts
// backend/tests/auth.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { middleware } from "../auth";
import { prismaFake, resetPrisma } from "./helpers/prisma-fake";
import { __setUser, makeUser, resetSupabase } from "./helpers/supabase-fake";
import { makeNext, makeReq, makeRes } from "./helpers/express-mock";

describe("auth middleware", () => {
  beforeEach(() => {
    resetPrisma();
    resetSupabase();
  });

  test("401 when there is no Authorization header", async () => {
    const res = makeRes();
    await middleware(makeReq(), res, makeNext());
    expect(res.statusCode).toBe(401);
  });

  test("401 when Supabase resolves no user", async () => {
    __setUser(null);
    await middleware(makeReq({ headers: { authorization: "bad-token" } }), makeRes(), makeNext());
    // no assertion on prismaFake — upsert must not be called when Supabase returned nothing
    expect(prismaFake.user.upsert).not.toHaveBeenCalled();
  });

  test("happy path: provisions the user, sets req.userId, calls next()", async () => {
    __setUser(makeUser({ id: "u-1", email: "a@b.com" }));
    prismaFake.user.upsert.mockResolvedValue({});           // ← stub return value

    const req = makeReq({ headers: { authorization: "tok-1" } });
    const next = makeNext();
    await middleware(req, makeRes(), next);

    expect(req.userId).toBe("u-1");
    expect(next).toHaveBeenCalledTimes(1);
    expect(prismaFake.user.upsert).toHaveBeenCalledTimes(1);
  });

  test("provisioning failure → 500, does not call next()", async () => {
    __setUser(makeUser({ id: "u-3", email: "e@f.com" }));
    prismaFake.user.upsert.mockRejectedValue(new Error("db down")); // ← force failure

    const res = makeRes();
    await middleware(makeReq({ headers: { authorization: "tok-3" } }), res, makeNext());

    expect(res.statusCode).toBe(500);
  });
});
```

**Important:** `auth.ts` maintains a process-wide `provisionedUsers` Set. Once a user ID is
provisioned in one test, a second test using the same user ID skips the upsert. Always use unique
IDs (`"u-1"`, `"u-2"`, ...) across tests that check provisioning call counts.

### 4.2 Testing a `$transaction` path

The `DELETE /conversations/:id` handler (`backend/index.ts:443`) runs a batch transaction:

```ts
await prisma.$transaction([
  prisma.message.deleteMany({ where: { conversationId } }),
  prisma.conversation.delete({ where: { id: conversationId } }),
]);
```

The fake's `$transaction` receives the array of Promises. A minimal route test would look like:

```ts
test("DELETE conversation removes messages then conversation atomically", async () => {
  // Arrange: the ownership-check findFirst must return something.
  prismaFake.conversation.findFirst.mockResolvedValue({ id: "conv-99" });
  prismaFake.message.deleteMany.mockResolvedValue({ count: 3 });
  prismaFake.conversation.delete.mockResolvedValue({ id: "conv-99" });
  // $transaction default already passes the array through — no extra stub needed.

  // Act — call the handler via supertest / direct invocation
  // (see backend-testing skill for the full route integration harness)

  // Assert
  expect(prismaFake.$transaction).toHaveBeenCalledTimes(1);
  // The batch array contains two promises; check the calls that built those promises.
  expect(prismaFake.message.deleteMany).toHaveBeenCalledWith({
    where: { conversationId: "conv-99" },
  });
  expect(prismaFake.conversation.delete).toHaveBeenCalledWith({
    where: { id: "conv-99" },
  });
});
```

Note: when you assert on calls that are passed as the transaction array, they are evaluated eagerly
(the Promises are created before `$transaction` is called), so the individual method mocks already
have their calls recorded by the time `$transaction` is awaited.

---

## 5. Asserting Query Shape

The point of a mocked-Prisma test is not to verify that Prisma works — it is to verify that **your
code passes the right arguments to Prisma**. Wrong `where`, missing `select`, wrong `data` — those
are the bugs. Asserting call shape catches them without a database.

### Reading `.mock.calls`

Every mock function stores its call history in `.mock.calls: unknown[][]`. Each element is the
tuple of arguments for one invocation.

```ts
// After middleware runs, confirm the upsert args precisely.
const [upsertArgs] = prismaFake.user.upsert.mock.calls;
expect(upsertArgs[0]).toEqual({
  where:  { email: "a@b.com" },
  update: {},
  create: {
    id:         "u-1",
    email:      "a@b.com",
    provider:   "Google",
    name:       "Test User",
    supabaseId: "u-1",
  },
});
```

### Prefer `toEqual` over `toMatchObject` for security-critical paths

`toMatchObject` only checks the listed keys; extra keys pass silently. For auth provisioning and
data-write paths where the exact shape matters (wrong extra key = wrong DB write), use `toEqual` to
assert the entire argument object.

Use `toMatchObject` only when you explicitly don't care about fields you haven't listed:

```ts
// OK: checking that the select limits the returned columns (don't care about orderBy)
expect(prismaFake.conversation.findMany.mock.calls[0][0]).toMatchObject({
  where:  { userId: "u-1" },
  select: { id: true, title: true, slug: true },
});
```

### Asserting `where` ownership guards

Many routes gate on `{ id: conversationId, userId: req.userId }`. If that filter ever loses the
`userId`, a user can read or delete another user's data. Assert it explicitly:

```ts
expect(prismaFake.conversation.findFirst.mock.calls[0][0]).toMatchObject({
  where: { id: "conv-42", userId: "u-9" },
});
```

### Asserting `$queryRaw` / `$executeRaw`

The semantic-cache layer (`backend/index.ts:317–364`) uses raw SQL for pgvector operations because
Prisma's ORM layer does not support the `<=>` cosine-distance operator. The fake's `$queryRaw` and
`$executeRaw` are ordinary mocks — but raw SQL is passed as a tagged template literal, which Bun
delivers to the mock as an array of template strings plus interpolated values.

Testing the semantic cache at the unit level means asserting that `$queryRaw` was called (or not
called) under the right conditions, not inspecting the SQL text character-by-character:

```ts
test("findCachedAnswer skips $queryRaw when cacheDown is true", async () => {
  // Drive cacheDown by injecting a 42P01 error on the previous call (not shown)
  // ...
  expect(prismaFake.$queryRaw).not.toHaveBeenCalled();
});

test("findCachedAnswer returns null when distance > threshold", async () => {
  prismaFake.$queryRaw.mockResolvedValue([
    { answer: "stale", sources: [], images: [], distance: 0.9 },
  ]);
  // call findCachedAnswer via the route ...
  // result should be null (miss), and $queryRaw called once
  expect(prismaFake.$queryRaw).toHaveBeenCalledTimes(1);
});
```

For deeper SQL content inspection, check the second argument to the template tag (the interpolated
values array), or promote the test to Tier 3 (real DB).

---

## 6. The `makeReq` / `makeRes` / `makeNext` Express Doubles

These thin helpers in `backend/tests/helpers/express-mock.ts` let you call middleware and handlers
directly without `supertest` or a running HTTP server.

```ts
// backend/tests/helpers/express-mock.ts
export function makeReq(overrides: Record<string, unknown> = {}) {
  return { headers: {}, body: {}, params: {}, query: {}, ...overrides } as any;
}

export function makeRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.status    = mock((code: number) => { res.statusCode = code; return res; });
  res.json      = mock((b: unknown)   => { res.body = b; return res; });
  res.send      = mock((b: unknown)   => { res.body = b; return res; });
  res.sendStatus = mock((c: number)   => { res.statusCode = c; return res; });
  res.setHeader = mock((k: string, v: string) => { res.headers[k] = v; });
  res.header    = mock((k: string, v: string) => { res.headers[k] = v; return res; });
  res.end       = mock(() => res);
  return res;
}

export function makeNext() {
  return mock((_err?: unknown) => {});
}
```

Key patterns:

- `makeReq({ headers: { authorization: "tok-1" }, body: { query: "test" } })` — build a
  specific request shape.
- `makeRes()` — capture status code and response body without HTTP.
- `makeNext()` — assert whether the middleware called through or short-circuited.

For route integration (full HTTP request/response with supertest), see the **backend-testing** skill
which documents the full harness.

---

## 7. `mockResolvedValue` vs `mockResolvedValueOnce`

| Method | Scope | Use when |
|---|---|---|
| `.mockResolvedValue(v)` | All subsequent calls return `v` | Most tests: one call expected |
| `.mockResolvedValueOnce(v)` | Only the next call returns `v`, then falls back to default | Testing retry logic or a sequence of distinct results |
| `.mockRejectedValue(e)` | All calls throw `e` | Testing error/fallback paths |
| `.mockRejectedValueOnce(e)` | Only the next call throws | Testing one failure then recovery |

After `resetPrisma()`, all methods revert to the default `async () => undefined` — no stubs remain.

---

## 8. Adding a New Model to the Fake

When you add a model to `schema.prisma` and start calling it from application code, add it to
`prismaFake` too.

1. Open `backend/tests/helpers/prisma-fake.ts`.
2. Add the new model with the operations your code calls:

```ts
export const prismaFake = {
  // ... existing models ...
  gmailConnection: {          // ← new
    upsert: fn(),
    findUnique: fn(),
    delete: fn(),
  },
};
```

3. Add the new mocks to `resetPrisma()`:

```ts
export function resetPrisma() {
  const all = [
    // ... existing mocks ...
    ...Object.values(prismaFake.gmailConnection),  // ← new
  ];
  for (const m of all) (m as ReturnType<typeof mock>).mockReset();
}
```

4. Tests that do NOT call the new model need no changes — the default `async () => undefined`
   is harmless.

---

## 9. Common Pitfalls

### Cross-test contamination from `provisionedUsers`

`auth.ts` guards provisioning with a module-level `Set`. Once a user is provisioned in test A,
test B using the same user ID sees it already provisioned and skips the upsert. Fix: use a unique
user ID per test that cares about upsert call counts.

### The preload path resolves from the preload file, not the test file

```ts
// In test-preload.ts (in backend/tests/setup/):
mock.module("../../db.ts", () => ({ prisma: prismaFake }));
//           ^^^^^^^^^^^^ relative to backend/tests/setup/, not to a test file
```

If you write `mock.module` inside a test file, the path resolves from the test file's directory,
not the preload. This works for one-off module mocks in a test file, but it runs after imports have
already been hoisted — meaning the real module may already be loaded. **Module seam mocks belong in
the preload.**

### Forgetting `.js` in application import paths

`backend/db.ts` exports `prisma`. Application files import it as:

```ts
import { prisma } from "./db.js";   // ← .js required (Vercel strict ESM)
```

Bun resolves both `./db.ts` and `./db.js` to the same file at runtime, so this works locally.
On Vercel's ESM-strict Node runtime, the `.js` extension is mandatory — omit it and the build
fails. `mock.module` in the preload uses `"../../db.ts"` (acceptable in test context). Application
imports must use `"./db.js"`.

### Do not `import { prisma }` directly in a test file

```ts
// WRONG — imports the real PrismaClient before mock.module can intercept it
import { prisma } from "../db.js";  // real, throws without DATABASE_URL
```

Only import `prismaFake` from the helper. The module under test imports `prisma` (which gets
the fake). Tests control behavior through `prismaFake.*`.

---

## 10. Test Layout Quick Reference

```
backend/
├── bunfig.toml                          # preload = ["./tests/setup/test-preload.ts"]
└── tests/
    ├── setup/
    │   └── test-preload.ts              # mock.module wiring; env stubs
    ├── helpers/
    │   ├── prisma-fake.ts               # prismaFake + resetPrisma()
    │   ├── supabase-fake.ts             # __setUser / makeUser / resetSupabase()
    │   ├── express-mock.ts              # makeReq / makeRes / makeNext
    │   └── fetch-mock.ts                # global fetch stub
    └── auth.test.ts                     # Tier 2: middleware tests against prismaFake
```

---

## See also

- **backend-testing** skill — the full harness (preload, bunfig, supertest integration, fetch-mock,
  coverage); the tier-by-tier test file layout; streaming route integration tests.
- **prisma** skill (sibling references) — `schema.prisma` conventions, `$queryRaw` / `$executeRaw`
  for pgvector, migration workflow, the `GmailConnection` encrypted-token model.
- **supabase** skill — Supabase auth client, `createSupabaseClient`, the `supabase-fake` seam,
  RLS policy testing.
- **connectors-oauth** skill — `GmailConnection` model usage, token-vault encryption, OAuth flow
  routes and their test patterns.
- **rag-retrieval** skill — the semantic-cache `$queryRaw` / `$executeRaw` paths and how to test
  the cache hit/miss/cooldown logic.
- **lumina-frontend** skill — TanStack Query hooks and the API client; frontend test patterns live
  in the **bun-testing** skill (separate harness, happy-dom, Testing Library).
