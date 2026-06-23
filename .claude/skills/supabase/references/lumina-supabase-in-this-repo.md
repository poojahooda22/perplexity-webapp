# Lumina — Supabase in This Repo

> Supabase plays a single, tightly-scoped role in Lumina: it is the **auth provider only**. All
> persistent application data is owned by Prisma. Knowing this boundary up-front prevents a
> whole class of mistakes.

---

## Division of labor: Prisma owns data; Supabase owns auth + Realtime

Lumina runs on Supabase Postgres, but the two clients that touch that database do completely
different jobs and must not be swapped.

| Concern | Owner | Client |
|---|---|---|
| Auth — validate a user JWT | Supabase | `@supabase/supabase-js` → `auth.getUser(token)` |
| App data — conversations, messages, users, Gmail tokens, cached queries | Prisma | `@prisma/client` (via `PrismaPg` driver adapter) |
| pgvector similarity search | Prisma raw SQL | `prisma.$queryRaw` / `prisma.$executeRaw` |
| Realtime push (future) | Supabase Realtime | supabase-js channel subscription |

**Why this split?**

Supabase ships both a hosted Postgres and a full-stack BaaS SDK. The SDK's `from('table').select()`
path is convenient for quick prototypes but brings two production liabilities:

1. **RLS drift.** Every table needs a carefully maintained Row Level Security policy. Miss one and
   the service-role key grants full table access through the JS client. Prisma's typed queries run
   through a single privileged connection (`DATABASE_URL`), enforcing access via application logic
   rather than per-table SQL policies that must be kept in sync with schema changes.

2. **Type safety.** Supabase-js `select()` returns `any[]` unless you generate types from the
   schema on every migration. Prisma generates a fully-typed client from `schema.prisma` and the
   compiler catches mismatches at build time.

The Supabase JS client in this codebase therefore has exactly one method call in production use:
`client.auth.getUser(token)`. Everything else — reads, writes, migrations — goes through Prisma.

---

## `client.ts` deep dive

**File:** `backend/client.ts`

```ts
// backend/client.ts:1
import { createClient } from "@supabase/supabase-js";

// backend/client.ts:7
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://rgwdybuczqcoenmxmosd.supabase.co";

// backend/client.ts:9-20
export function createSupabaseClient() {
    const key = process.env.SUPABASE_API_SECRET ?? process.env.SUPABASE_KEY;
    if (!key) {
        throw new Error(
            "Supabase key missing: set SUPABASE_API_SECRET (service role) or SUPABASE_KEY (anon) in the environment",
        );
    }
    return createClient(SUPABASE_URL, key);
}
```

### Key decisions

**`SUPABASE_URL` fallback** (`client.ts:7`): The project URL is hardcoded as the fallback so
local dev works without a `.env` file. This is safe because the URL is not a secret — it only
identifies the Supabase project; the key provides the actual authorization. In CI or Vercel, set
`SUPABASE_URL` in env to make the deploy environment-agnostic.

**Key resolution order** (`client.ts:14`): `SUPABASE_API_SECRET` (service-role key) is preferred
over `SUPABASE_KEY` (anon key). Either works for `auth.getUser` — that call validates a user JWT
regardless of which key initiates the request. The service-role key bypasses RLS but that bypass
is irrelevant here because the client **never issues a data query**. The comment in the file makes
this explicit (`client.ts:10-13`).

**Throw on missing key** (`client.ts:15-19`): `createSupabaseClient()` throws immediately if neither
env var is present. This is intentional — a missing key means auth is broken by definition. The
throw surfaces a clear message rather than an opaque `TypeError: Cannot read properties of undefined`
later when `auth.getUser` is called.

**Do not call `createSupabaseClient()` at module load.** The function is exported so auth.ts can
call it lazily (see next section). Direct top-level invocation would crash every Vercel cold-start
when the env vars are absent, including public routes that never touch auth.

---

## `auth.ts` deep dive

**File:** `backend/auth.ts`

### Lazy client initialization

```ts
// backend/auth.ts:11-15
let _client: SupabaseClient | null = null;
function getClient(): SupabaseClient {
    if (!_client) _client = createSupabaseClient();
    return _client;
}
```

`index.ts` imports `auth.ts` at boot. If the Supabase client were created at module scope,
`createSupabaseClient()` would run during the import, throw on a missing env var, and kill the
entire serverless function invocation — including finance and health routes that have no auth at
all. The lazy `getClient()` pattern (`auth.ts:12-14`) confines the failure to the first
authenticated request, where the error is surfaced correctly as a 500 on an auth'd route rather
than an opaque `FUNCTION_INVOCATION_FAILED` crash.

### The `middleware` function

```ts
// backend/auth.ts:35-81
export async function middleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "unauthorised" });
    // ...
}
```

The middleware runs on **every authenticated route**. Its job is to populate `req.userId` (a
Prisma User `id`, which is also the Supabase user `id`) so downstream route handlers can key
queries by user without touching Supabase again.

#### Layer 1 — In-memory token cache (fast path)

```ts
// backend/auth.ts:28-29
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const tokenCache = new Map<string, { userId: string; expiresAt: number }>();

// backend/auth.ts:40-44
const cached = tokenCache.get(token);
if (cached && cached.expiresAt > Date.now()) {
    req.userId = cached.userId;
    return next();
}
```

The `tokenCache` maps a raw `Authorization` header value to `{ userId, expiresAt }`. On a cache
hit within the 5-minute TTL the entire Supabase network call is skipped. Tradeoffs:

- **Stored in process memory.** Cleared on every Vercel cold-start, which is fine — the next
  request just hits the slow path once.
- **Not shared across instances.** Multiple concurrent Vercel instances each carry their own cache.
  No thundering-herd issue: each instance's cache warms independently, and the Supabase call is
  cheap (JWT validation, not a DB query).
- **Revocation latency up to 5 minutes.** A deleted or revoked Supabase account stays valid in
  this cache for up to 5 minutes. Acceptable for this project; swap for a Redis-backed cache with
  `DEL token` on logout if stricter revocation is needed.
- **Token is the cache key, not the userId.** The token already encodes the user — using it as
  the key avoids a second lookup.

#### Layer 2 — Supabase `auth.getUser` (slow path)

```ts
// backend/auth.ts:47-49
const data = await getClient().auth.getUser(token);
const user = data.data.user;
if (!user) return res.status(401).json({ error: "unauthorised" });
```

`auth.getUser(token)` sends the raw JWT to Supabase, which validates the signature and returns
the full `User` object. A `null` user means an invalid or expired token — return 401 immediately.

Note: `getUser` does not throw on auth failure; it returns `{ data: { user: null }, error }`.
The check is on `data.data.user`, not on `error`. A thrown exception (network failure,
misconfigured Supabase URL) will propagate up as an unhandled Express 500.

#### Layer 3 — User provisioning (`provisionedUsers` set)

```ts
// backend/auth.ts:33
const provisionedUsers = new Set<string>();

// backend/auth.ts:53-76
if (!provisionedUsers.has(user.id)) {
    try {
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
        provisionedUsers.add(user.id);
    } catch (e) {
        console.error("[auth] user provisioning failed:", e);
        return res.status(500).json({ error: "Could not provision user" });
    }
}
```

After Supabase validates the token, the middleware ensures the user has a row in the Prisma
`User` table. Supabase manages identity; Prisma manages the application user record — this upsert
bridges the two.

**Why upsert and not insert?** Social login flows can produce duplicate calls on the first request
if two concurrent requests arrive before either has provisioned the user. `upsert` with
`update: {}` (no-op update) is idempotent — the second call succeeds without double-writing.
`where: { email }` is used rather than `where: { id }` so that if the same email authenticates
via a second provider the row is reused rather than duplicated.

**`provisionedUsers` set eliminates the DB round-trip** on subsequent requests in the same
process (`auth.ts:53`). The in-memory set is cleared on cold-start but the upsert is idempotent,
so re-provisioning on the first request of a new instance is harmless.

**Fail-loud provisioning** (`auth.ts:69-75`): if the upsert throws — network error, constraint
violation, misconfigured `DATABASE_URL` — the middleware returns 500 rather than calling `next()`.
This surfaces the problem immediately. Silently continuing would let the request reach a handler
that tries to create a `Conversation` with a `userId` FK that doesn't exist, producing a
confusing FK violation two layers deeper.

#### Setting `req.userId`

```ts
// backend/auth.ts:78-79
tokenCache.set(token, { userId: user.id, expiresAt: Date.now() + TOKEN_TTL_MS });
req.userId = user.id;
```

`req.userId` is the Supabase `user.id` (a UUID). It is also the Prisma `User.id` (set in the
`create` block above at `id: user.id`). Downstream handlers use it directly as a Prisma FK:

```ts
// Example: creating a Conversation
await prisma.conversation.create({ data: { userId: req.userId, slug, title } });
```

No further Supabase calls are needed after the middleware.

---

## The `AuthProvider` enum and provider derivation

**Schema:** `backend/prisma/schema.prisma:107-110`

```prisma
enum AuthProvider {
  Github
  Google
}
```

The provider is derived in `auth.ts:61`:

```ts
provider: user.app_metadata.provider === "google" ? "Google" : "Github",
```

Supabase populates `app_metadata.provider` with the OAuth provider string (`"google"`, `"github"`,
etc.) at signup. The comparison is a string equality check — any unrecognized provider falls back
to `"Github"`. If Lumina adds more providers (Apple, Microsoft, email/password), this line needs
a proper switch or a mapping table, and the enum needs corresponding values.

**`supabaseId`** (`schema.prisma:34`, `auth.ts:65`): stored as a plain `String` column on `User`
(not `@unique`, not `@id`). In this codebase `supabaseId === id` (both are set to `user.id`), so
the column is redundant but retained for clarity — it makes the Supabase linkage explicit without
relying on the implicit equality, and allows future divergence if, for example, Prisma user IDs
are ever migrated to a different format.

---

## pgvector lives on the same Supabase Postgres — reached via Prisma raw SQL

Supabase hosts the Postgres instance, and pgvector is enabled on it. However, Lumina accesses
the vector index **exclusively through Prisma raw SQL**, never through the Supabase JS client.

**Why not via supabase-js?**

`@supabase/supabase-js` does not support pgvector operators (`<=>`, `<->`, `<#>`) through its
`from().select()` builder. You would have to call the PostgREST RPC endpoint, which adds
latency and a network hop. Prisma's `$queryRaw` sends SQL directly over the `DATABASE_URL`
connection, which is the same TCP connection used by all other queries — faster and typed.

**The CachedQuery model** (`schema.prisma:58-69`):

```prisma
model CachedQuery {
  id        String                      @id @default(uuid())
  queryText String                      @map("query_text")
  model     String
  embedding Unsupported("vector(1536)")   // pgvector column
  answer    String
  sources   Json
  images    Json
  createdAt DateTime @default(now())    @map("created_at")

  @@map("cached_query")
}
```

The `embedding` column uses `Unsupported("vector(1536)")` (`schema.prisma:62`). Prisma will
generate the migration DDL (`vector(1536)`) correctly but will **not** include the field in the
typed client. All reads and writes to this model go through `$queryRaw`/`$executeRaw`.

**Extension management warning** (`schema.prisma:19-22`):

```
// NOTE: pgvector is enabled directly in Supabase (Dashboard → Database → Extensions,
// or `CREATE EXTENSION vector`). We deliberately do NOT let Prisma manage extensions
// (`extensions = [...]`) — on Supabase that makes `prisma migrate dev` flag Supabase's
// own pre-installed extensions as "drift" and threaten a destructive reset.
```

Never add `extensions = [pgvector]` to the datasource block. Supabase pre-installs several
extensions; if Prisma tracks them, every `migrate dev` run will see them as "not managed by
Prisma" and offer to drop and recreate them. The correct approach: enable extensions via the
Supabase Dashboard or a raw SQL migration, then leave them out of `schema.prisma`.

For detailed coverage of the semantic cache implementation (embedding storage, cosine similarity
queries, stale-while-revalidate flow) see `rag-retrieval`.

---

## The `supabase-fake` test seam

**File:** `backend/tests/helpers/supabase-fake.ts`

Auth tests mock the Supabase client so no real HTTP call to `supabase.co` happens. The fake
replaces `createSupabaseClient` in the test preload and exposes control functions:

```ts
// backend/tests/helpers/supabase-fake.ts:5-6
let currentUser: User | null = null;
let getUserError: unknown = null;

// backend/tests/helpers/supabase-fake.ts:8-11
export function __setUser(u: User | null) {
  currentUser = u;
  getUserError = null;
}

// backend/tests/helpers/supabase-fake.ts:13-15
export function __setGetUserError(e: unknown) {
  getUserError = e;
}

// backend/tests/helpers/supabase-fake.ts:18-21
export function resetSupabase() {
  currentUser = null;
  getUserError = null;
}
```

The fake client itself (`supabase-fake.ts:36-44`):

```ts
export function createSupabaseClient(): SupabaseClient {
  return {
    auth: {
      getUser: async (_token: string) => {
        if (getUserError) throw getUserError;
        return { data: { user: currentUser }, error: null };
      },
    },
  } as unknown as SupabaseClient;
}
```

The fake is a minimal structural match — it implements only `auth.getUser`. No network, no JWT
validation. `currentUser` is whatever `__setUser` last set; `getUserError` triggers the throw
path to test the 500 / network-failure branch.

### `makeUser` — realistic fixture

```ts
// backend/tests/helpers/supabase-fake.ts:24-33
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-123",
    email: "test@example.com",
    aud: "authenticated",
    app_metadata: { provider: "google" },
    user_metadata: { full_name: "Test User" },
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as User;
}
```

`makeUser` provides a Supabase `User` with every field the auth middleware reads
(`id`, `email`, `app_metadata.provider`, `user_metadata.full_name`). Override only the fields
relevant to the test case:

```ts
// Test: Github provider → AuthProvider.Github
const user = makeUser({ app_metadata: { provider: "github" } });
__setUser(user);
```

### Typical auth test pattern

```ts
import { __setUser, __setGetUserError, resetSupabase, makeUser }
  from "../../helpers/supabase-fake.ts";
import { prismaMock } from "../../helpers/prisma-fake.ts";

beforeEach(() => {
  resetSupabase();                  // clear user + error state
  prismaMock.user.upsert.mockResolvedValue({} as any); // provisioning succeeds
});

test("valid token → 200 and req.userId set", async () => {
  __setUser(makeUser());            // Supabase returns a real user
  const res = await request(app)
    .get("/api/conversations")
    .set("Authorization", "Bearer valid-token");
  expect(res.status).toBe(200);
});

test("missing Authorization → 401", async () => {
  const res = await request(app).get("/api/conversations");
  expect(res.status).toBe(401);
});

test("null user (bad token) → 401", async () => {
  __setUser(null);                  // Supabase returns no user
  const res = await request(app)
    .get("/api/conversations")
    .set("Authorization", "Bearer bad-token");
  expect(res.status).toBe(401);
});

test("getUser throws (network failure) → 500", async () => {
  __setGetUserError(new Error("supabase unreachable"));
  const res = await request(app)
    .get("/api/conversations")
    .set("Authorization", "Bearer any-token");
  expect(res.status).toBe(500);
});

test("provisioning failure → 500", async () => {
  __setUser(makeUser());
  prismaMock.user.upsert.mockRejectedValue(new Error("DB error"));
  const res = await request(app)
    .get("/api/conversations")
    .set("Authorization", "Bearer any-token");
  expect(res.status).toBe(500);
  expect(res.body.error).toBe("Could not provision user");
});
```

The `provisionedUsers` set inside `auth.ts` persists across tests in the same process because the
module is loaded once. If a test needs to re-exercise the provisioning path for a user that was
already provisioned in an earlier test, either use a unique `id` or restart the worker. In
practice, `makeUser({ id: "user-unique-per-test" })` is the simplest workaround.

---

## What Supabase is explicitly NOT used for here

| Not used | Reason |
|---|---|
| `supabase.from('users').select()` — client-side data queries | Prisma owns all data queries with full TypeScript types. No RLS policies needed or maintained. |
| `supabase.from('conversations').insert()` — client writes | Same: all writes go through Prisma in the Express backend, never direct from the browser through supabase-js. |
| Row Level Security (RLS) | Not configured. All access control is enforced by application logic in Express route handlers (checking `req.userId` against the resource owner). |
| Supabase Realtime (current) | Not implemented yet. The `worker/` on Fly.io handles WebSocket connections; if Realtime is needed in the future it could replace or augment the Fly worker. |
| Supabase Storage | Not used. File uploads (Health tab) go through the Lumina backend and are not stored in Supabase buckets. |
| Supabase Edge Functions | Not used. All server logic runs on Vercel (serverless) or the Fly.io worker. |
| `supabase.auth.signInWith*` — browser-side auth flows | Not invoked from this codebase. Auth is initiated on the frontend (React app); the Supabase session token is passed to Lumina's backend in the `Authorization` header. |
| Service-role key for privileged DB operations | The service-role key is used only because it is available in the env and works for `auth.getUser`. The RLS bypass it grants is irrelevant — all data queries go through `DATABASE_URL` / Prisma, not the supabase-js client. |

**The core principle:** the Supabase JS client is a thin HTTP wrapper around Supabase's REST and
Realtime APIs. For a server-side Node/Bun app that already has a direct Postgres connection via
`DATABASE_URL`, the JS client adds latency and a service dependency for any operation that could
be done over the connection directly. Prisma over `DATABASE_URL` is faster, fully typed, and
migration-tracked. The supabase-js client stays in this codebase purely because `auth.getUser`
has no equivalent in Prisma — it validates Supabase's own JWTs against Supabase's own key store.

---

## Auth flow end-to-end summary

```
Browser (React)
    │
    │  POST /api/ask  Authorization: <supabase-jwt>
    ▼
Express auth middleware (backend/auth.ts)
    │
    ├─ tokenCache hit? → req.userId = cached.userId → next()
    │
    └─ cache miss
         │
         ├─ getClient().auth.getUser(token) ──► Supabase Auth API
         │         │
         │         └─ null user → 401
         │
         ├─ provisionedUsers.has(user.id)?
         │    No → prisma.user.upsert() ──► Postgres (via DATABASE_URL)
         │           fail → 500
         │
         ├─ tokenCache.set(token, { userId, expiresAt })
         │
         └─ req.userId = user.id → next()
                │
                ▼
         Route handler (req.userId available)
         prisma.conversation.findMany({ where: { userId: req.userId } })
```

---

## See also

- `prisma` skill — schema migrations, the `PrismaPg` driver adapter, `$queryRaw` for pgvector,
  the `backend/db.ts` singleton (`db.ts:1-10`), the `prisma-fake.ts` test seam
- `rag-retrieval` skill — how `CachedQuery` is read and written via raw SQL, cosine similarity
  search, the stale-while-revalidate cache layer on top of pgvector
- `redis` skill — `backend/lib/cache.ts` and the Upstash Redis hot cache (separate from the
  Postgres semantic cache; used for computed pages and rate limiting)
- `backend-testing` skill — the full test preload architecture, how `supabase-fake.ts` and
  `prisma-fake.ts` are wired together, the `renderWithProviders` pattern
- `connectors-oauth` skill — `GmailConnection` model (`schema.prisma:86-100`), OAuth token vault,
  the `userId` FK to `User` with `onDelete: Cascade`
- `lumina-frontend` skill — how the React app obtains and forwards the Supabase JWT, TanStack
  Query auth headers, the `AuthContext`
