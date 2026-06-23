# RLS Policies — Patterns and Reference

> Row Level Security (RLS) is Postgres's built-in row-filter that runs inside the database engine,
> before any data is returned to the caller. This reference covers enabling RLS, writing per-command
> policies, role and JWT-claim patterns, `SECURITY DEFINER` helpers, performance, and how to test
> policies locally. Lumina applicability is addressed throughout: today Lumina enforces authz in
> Express + Prisma; RLS becomes mandatory the moment any table is exposed to a supabase-js client.

---

## 1. Enabling RLS — the default-deny posture

By default every Postgres table is accessible to any role that has been granted `SELECT`/`INSERT`/
`UPDATE`/`DELETE` privileges on it. On Supabase the `anon` and `authenticated` roles are granted
broad table-level permissions via PostgREST; a table without RLS is fully readable/writable by any
client that holds the anon key.

```sql
-- Turn on RLS for a table.  No policies = no rows ever visible/writable — hard default deny.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- If you want to keep the table open to service-role / superuser queries while RLS is enabled
-- (e.g. a migration script), use FORCE ROW LEVEL SECURITY on the table *and* set
-- row_security = on in the session.  The service-role key bypasses RLS by default.
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;   -- even service-role obeys policies
```

**The default-deny guarantee:** Once `ENABLE ROW LEVEL SECURITY` is set, a table with _zero_
policies is **completely inaccessible** to the `anon` and `authenticated` roles. You must write an
explicit `ALLOW` policy for every access pattern you want to permit. This is the correct starting
posture — add access, never revoke it.

### Supabase role hierarchy

| Role | Can do | RLS applies? |
|---|---|---|
| `postgres` / `service_role` | Everything | No (bypasses RLS) |
| `authenticated` | PostgREST routes for logged-in users | Yes |
| `anon` | PostgREST routes for public/unauthenticated callers | Yes |

The `service_role` key grants the `service_role` Postgres role, which has `BYPASSRLS`. This is
why you must never ship the service-role key to a browser or mobile client — the anon key is
intentionally limited by RLS.

### When to enable vs leave disabled

Enable RLS on every table you intend to expose through `supabase-js` / PostgREST. Tables that are
only ever accessed through a trusted backend (Prisma over `DATABASE_URL` with the service-role or
Postgres superuser password) can leave RLS disabled — access control is enforced in application
code instead. This is Lumina's current architecture: all tables are behind Prisma; RLS is not
configured because no table is exposed via the supabase-js client.

---

## 2. Writing per-command policies

A policy is an `ALTER POLICY` or `CREATE POLICY` statement that specifies:

- **Which command** it covers: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `ALL`.
- **`USING` expression** — filters rows on reads (SELECT/UPDATE/DELETE) and on the old row for
  UPDATE. Think of it as "which rows can this role even see?"
- **`WITH CHECK` expression** — validates the *new* row on writes (INSERT/UPDATE). Think of it as
  "is the row the client is trying to create/modify valid?"

A command that has no matching policy is denied. You can have multiple policies for the same
command — Postgres ORs them together (permissive by default).

### Ownership policy skeleton

```sql
-- SELECT: a user can only read their own rows.
CREATE POLICY "conversations_select_own"
  ON conversations
  FOR SELECT
  TO authenticated
  USING ( user_id = (SELECT auth.uid()) );

-- INSERT: a user can only insert rows where user_id matches their own id.
CREATE POLICY "conversations_insert_own"
  ON conversations
  FOR INSERT
  TO authenticated
  WITH CHECK ( user_id = (SELECT auth.uid()) );

-- UPDATE: a user can only update their own rows, and cannot re-assign ownership.
CREATE POLICY "conversations_update_own"
  ON conversations
  FOR UPDATE
  TO authenticated
  USING  ( user_id = (SELECT auth.uid()) )
  WITH CHECK ( user_id = (SELECT auth.uid()) );

-- DELETE: a user can only delete their own rows.
CREATE POLICY "conversations_delete_own"
  ON conversations
  FOR DELETE
  TO authenticated
  USING ( user_id = (SELECT auth.uid()) );
```

**`auth.uid()`** is a Supabase-supplied helper that returns the UUID of the currently
authenticated caller by reading the `sub` claim from the JWT. It returns `NULL` for unauthenticated
(`anon`) requests, so any policy that uses `auth.uid()` automatically excludes unauthenticated
callers (a NULL comparison is never TRUE in Postgres).

**`(SELECT auth.uid())` vs `auth.uid()`** — always use the sub-select form. See §5.

### `USING` vs `WITH CHECK` in depth

| Clause | When evaluated | Failure result |
|---|---|---|
| `USING` | Before returning existing rows | Row is silently filtered out (SELECT) or operation is denied (UPDATE/DELETE) |
| `WITH CHECK` | After constructing the new row, before writing | `ERROR: new row violates row-level security policy` |

For `SELECT` and `DELETE`, only `USING` applies (there is no new row). For `INSERT`, only
`WITH CHECK` applies (there is no old row to filter). For `UPDATE`, both apply: `USING` selects
which rows can be updated; `WITH CHECK` validates that the updated row is legal.

If you write only `USING` on an `UPDATE` or `INSERT` policy, Postgres uses the `USING` expression
as `WITH CHECK` too — but this is easy to miss and leads to subtle bugs. Be explicit.

### Public read policy (for genuinely public data)

```sql
-- A table of public market data snapshots, readable by anyone.
CREATE POLICY "market_snapshots_public_read"
  ON market_snapshots
  FOR SELECT
  TO anon, authenticated
  USING ( true );   -- no restriction, all rows visible
```

Only add `anon` to the `TO` clause for genuinely unauthenticated-accessible data. Default to
`authenticated` only.

### Cascade-pattern: owner OR admin

```sql
-- Users can read their own rows; admins can read all rows.
CREATE POLICY "messages_read_own_or_admin"
  ON messages
  FOR SELECT
  TO authenticated
  USING (
    conversation_id IN (
      SELECT id FROM conversations WHERE user_id = (SELECT auth.uid())
    )
    OR (SELECT auth.jwt()->'app_metadata'->>'role') = 'admin'
  );
```

Policies are permissive by default in Postgres — Lumina can define two separate policies that get
ORed, instead of cramming both cases into one predicate:

```sql
-- Policy 1: own rows
CREATE POLICY "messages_read_own"
  ON messages FOR SELECT TO authenticated
  USING (
    conversation_id IN (
      SELECT id FROM conversations WHERE user_id = (SELECT auth.uid())
    )
  );

-- Policy 2: admin sees all (additive — Postgres ORs permissive policies)
CREATE POLICY "messages_read_admin"
  ON messages FOR SELECT TO authenticated
  USING ( (SELECT auth.jwt()->'app_metadata'->>'role') = 'admin' );
```

For restrictive policies (AND semantics rather than OR), use `AS RESTRICTIVE`:

```sql
CREATE POLICY "only_verified_email"
  ON messages FOR SELECT TO authenticated
  AS RESTRICTIVE
  USING ( (SELECT auth.jwt()->'user_metadata'->>'email_verified')::boolean = true );
```

A user must satisfy ALL restrictive policies AND at least one permissive policy for a row to be
returned.

---

## 3. Role-based and JWT-claim-based policies

Supabase embeds the Postgres role in the JWT and executes PostgREST requests under that role. The
standard `USING ( user_id = (SELECT auth.uid()) )` pattern is per-user ownership. Role-based or
claim-based patterns lift authz to a group level.

### Reading from `auth.jwt()`

`auth.jwt()` returns the full decoded JWT as a `jsonb` value. You can traverse it with standard
Postgres JSON operators:

```sql
-- Read a custom app_metadata claim (set by Supabase's Admin API or a trigger)
SELECT auth.jwt()->'app_metadata'->>'role';          -- text
SELECT (auth.jwt()->'app_metadata'->>'is_premium')::boolean;

-- Read a standard claim
SELECT auth.jwt()->>'sub';      -- same as auth.uid()
SELECT auth.jwt()->>'email';
SELECT auth.jwt()->>'aud';      -- "authenticated" for logged-in users
```

**`app_metadata` vs `user_metadata`:**

- `app_metadata` — only writable server-side (Admin API, Edge Functions, triggers). Use for
  authorization claims; clients cannot tamper with these.
- `user_metadata` — writable by the user via `supabase.auth.updateUser()`. Use for profile data;
  never use for authz decisions.

### Role-based policy pattern

```sql
-- Only users with app_metadata.role = 'analyst' can read the research_notes table.
CREATE POLICY "research_notes_analyst_only"
  ON research_notes
  FOR SELECT
  TO authenticated
  USING ( (SELECT auth.jwt()->'app_metadata'->>'role') = 'analyst' );
```

### Subscription / plan tier pattern

```sql
-- Premium feature: only 'pro' plan users can write to watchlists.
CREATE POLICY "watchlists_pro_write"
  ON watchlists
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.jwt()->'app_metadata'->>'plan')::text = 'pro'
    AND user_id = (SELECT auth.uid())
  );
```

### Team membership pattern (with a join table)

```sql
-- A team_members table: (team_id uuid, user_id uuid, role text)
-- Team members can read any document owned by their team.
CREATE POLICY "documents_team_read"
  ON documents
  FOR SELECT
  TO authenticated
  USING (
    team_id IN (
      SELECT team_id FROM team_members
      WHERE user_id = (SELECT auth.uid())
    )
  );
```

Note that this pattern performs a subquery on every row evaluation. Index `team_members(user_id)`
and `documents(team_id)` — see §5.

### Setting custom claims

Claims in `app_metadata` are set server-side. The two main approaches:

**1. Supabase Admin API (from a trusted backend):**

```ts
// From a Vercel route (with the service-role key)
const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
  app_metadata: { role: 'analyst', plan: 'pro' },
});
```

**2. Database trigger (fires on `auth.users` insert or update):**

```sql
-- Automatically set a default role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE auth.users
    SET raw_app_meta_data = raw_app_meta_data || jsonb_build_object('role', 'user')
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_set_role
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();
```

The trigger approach has a caveat: the updated `app_metadata` is not reflected in the user's
current JWT until they refresh their session (the JWT is issued at login and claims are embedded at
that time). For plan upgrades that must take effect immediately, call `auth.admin.updateUserById`
from your backend and then instruct the client to call `supabase.auth.refreshSession()`.

---

## 4. `SECURITY DEFINER` helper functions

### The need

RLS policies run under the calling role (`authenticated` or `anon`). If a policy expression
references a table that the calling role cannot read directly — for example, an admin-only
`user_roles` table — the policy will throw a permission error.

The solution is a helper function declared `SECURITY DEFINER`, which executes as its _owner_
(typically `postgres` / superuser) rather than the caller. The policy calls the helper; the helper
runs with elevated privileges and returns just the boolean or scalar the policy needs.

### Writing a safe helper

```sql
-- Returns TRUE if the calling user is an admin.
-- SECURITY DEFINER + pinned search_path is the required pair.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE                          -- result doesn't change within a transaction; allows caching
SECURITY DEFINER
SET search_path = ''            -- CRITICAL: prevents search_path hijacking (see below)
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  user_id = (SELECT auth.uid())
      AND  role    = 'admin'
  );
$$;
```

Use the helper in a policy:

```sql
CREATE POLICY "admin_read_all"
  ON documents FOR SELECT TO authenticated
  USING ( public.is_admin() OR user_id = (SELECT auth.uid()) );
```

### The `search_path` hijack risk

Without `SET search_path = ''`, a malicious user could create a function or table in a schema that
appears earlier in the default search path than the schema your helper references:

```sql
-- Attacker creates their own schema with a fake user_roles table
CREATE SCHEMA attacker;
CREATE TABLE attacker.user_roles (user_id uuid, role text);
INSERT INTO attacker.user_roles VALUES (auth.uid(), 'admin');

-- If SET search_path is not set, Postgres resolves user_roles against the search path.
-- If 'attacker' appears before 'public', is_admin() finds the attacker's table.
```

With `SET search_path = ''`, every identifier in the function body must be fully qualified
(`public.user_roles`, `auth.uid()`). Postgres cannot be redirected to a different schema. This is
a **mandatory practice** for every `SECURITY DEFINER` function.

### Additional safety rules for `SECURITY DEFINER` helpers

1. **Grant `EXECUTE` narrowly.** Grant only to `authenticated`/`anon`, not to `PUBLIC`.
   ```sql
   REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
   GRANT  EXECUTE ON FUNCTION public.is_admin() TO authenticated;
   ```

2. **Keep the function `STABLE` or `IMMUTABLE` when possible.** This allows the query planner to
   cache the result within a statement rather than re-evaluating it per row.

3. **Never perform side effects.** `SECURITY DEFINER` helpers used in policies run on every
   qualifying row. Any `INSERT`/`UPDATE`/`DELETE` inside them is a landmine.

4. **Prefer `LANGUAGE sql` over `plpgsql` for simple lookups.** SQL functions inline better
   into the calling query, allowing the planner to optimize them together with the policy predicate.
   Use `plpgsql` only when you need procedural logic (`IF`, `LOOP`, exception handling).

5. **Avoid `VOLATILE` helpers in policies.** A `VOLATILE` function is called once per row; a
   `STABLE` or `IMMUTABLE` function can be called once per query. The performance difference is
   enormous on large scans.

---

## 5. Performance: indexing policy columns and the `(select auth.uid())` trick

### The `(SELECT auth.uid())` trick

The most common RLS predicate:

```sql
USING ( user_id = auth.uid() )
```

`auth.uid()` is declared `STABLE` — the planner may call it once per row evaluation. On a table
with millions of rows, this can add up.

Wrapping it in a sub-select forces the planner to evaluate it exactly once per statement:

```sql
USING ( user_id = (SELECT auth.uid()) )
```

The sub-select is a constant sub-query — Postgres evaluates it once, materializes the UUID, and
passes it to the index scan as a constant. The same technique applies to `auth.jwt()` and any
other stable context function used in a policy.

This is a near-zero-cost optimization — always use it.

```sql
-- Correct form (evaluated once per statement)
USING ( user_id = (SELECT auth.uid()) )

-- Avoid (potentially evaluated once per row)
USING ( user_id = auth.uid() )
```

### Indexing policy columns

A `USING` predicate is evaluated against every candidate row before filtering. Without an index,
Postgres performs a sequential scan of the entire table; with an index it jumps straight to the
user's rows.

For any column referenced in a `USING` predicate, add a B-tree index:

```sql
-- Index for ownership policies
CREATE INDEX conversations_user_id_idx ON conversations (user_id);

-- Index for a join-table team membership policy
CREATE INDEX team_members_user_id_idx ON team_members (user_id);

-- Composite index when filtering on both the policy column and a query column simultaneously
-- (e.g., SELECT * FROM messages WHERE conversation_id = ? -- policy filters on conversation.user_id)
CREATE INDEX messages_conversation_id_created_idx ON messages (conversation_id, created_at DESC);
```

**Why this matters at scale:** Suppose the `conversations` table has 5 million rows across 50,000
users. A user request asks for their conversations. Without an index, Postgres scans all 5M rows,
applies the `user_id = (SELECT auth.uid())` filter, and returns ~100 rows. With the index, Postgres
does an index scan of the 100-row leaf page for that user. The difference is two orders of
magnitude.

### Partial indexes for common-case acceleration

If policies include an additional filter that is highly selective, a partial index can help:

```sql
-- Only active (not archived) conversations are shown to users
CREATE INDEX conversations_user_active_idx
  ON conversations (user_id)
  WHERE archived = false;
```

### Avoid correlated subqueries in policies

A correlated subquery re-executes once per candidate row:

```sql
-- SLOW: correlated subquery runs once per row in documents
USING (
  user_id = (SELECT user_id FROM team_members WHERE team_id = documents.team_id AND user_id = auth.uid())
)
```

Rewrite as a non-correlated form or use an `EXISTS` with a constant sub-select:

```sql
-- BETTER: constant outer-query sub-select for auth.uid()
USING (
  EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = documents.team_id
      AND user_id = (SELECT auth.uid())
  )
)
```

With a covering index on `team_members(user_id, team_id)`, Postgres resolves the `EXISTS` with a
single index lookup per document row rather than a per-row table scan.

### Policy evaluation overhead in EXPLAIN

To verify that an index is being used:

```sql
-- Session variable to impersonate a role (for EXPLAIN only — see §6 for full impersonation)
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"<some-user-uuid>"}';

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM conversations WHERE true;  -- policy filter is injected automatically
```

Look for `Index Scan using conversations_user_id_idx` in the plan output. A `Seq Scan` on a large
table after enabling RLS means you need an index.

---

## 6. Testing policies locally

### Approach A — Supabase CLI local stack

The recommended way: run a full local Supabase stack with `supabase start`. The local stack
includes Postgres, GoTrue auth, and PostgREST — you can make real supabase-js calls against it.

```bash
supabase start         # starts local stack on :54321 (API) and :54322 (Postgres)
supabase db reset      # resets the local DB and re-runs all migrations + seed.sql
```

Create a local user for testing:

```bash
# Via the Supabase local studio UI at http://localhost:54323
# Or via the CLI:
supabase users create --email test@example.com --password test1234
```

Then write tests using the local anon key and `http://localhost:54321` as the Supabase URL. The
local client uses the JWTs produced by the local GoTrue — RLS runs the same way as production.

### Approach B — Direct SQL impersonation (psql / migration scripts)

Postgres allows any superuser to impersonate another role and set arbitrary session variables. The
Supabase JWT claims are conveyed to `auth.uid()` and `auth.jwt()` through `request.jwt.claims` and
`request.jwt.claim.sub` session parameters (set by PostgREST on every request). You can set them
manually in psql:

```sql
-- Impersonate an authenticated user
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"<user-uuid>","role":"authenticated"}';

-- Now test a SELECT — the policy filter applies as if this were a real user request
SELECT * FROM conversations;

-- Test INSERT
INSERT INTO conversations (id, user_id, slug, title)
VALUES (gen_random_uuid(), '<user-uuid>', 'test-slug', 'Test');

-- Test that a different user cannot see these rows
SET LOCAL "request.jwt.claims" = '{"sub":"<other-user-uuid>","role":"authenticated"}';
SELECT * FROM conversations;   -- should return 0 rows if policy is correct
```

Reset back to superuser:

```sql
RESET ROLE;
```

This technique works in any psql session against the local stack or against a Supabase production
instance if you connect via the connection string with superuser credentials.

### Approach C — pgTAP unit tests

pgTAP is a Postgres extension for database-level unit testing. Supabase's local stack ships with
pgTAP. You can write RLS tests as SQL:

```sql
BEGIN;
SELECT plan(4);

-- Simulate authenticated user A
SELECT set_config('request.jwt.claims', '{"sub":"user-a-uuid","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

-- Test: user A sees own conversations
SELECT results_eq(
  $$SELECT COUNT(*) FROM conversations$$::text,
  $$VALUES (2::bigint)$$,
  'User A sees 2 conversations'
);

-- Test: user A cannot insert a row owned by user B
SELECT throws_ok(
  $$INSERT INTO conversations (id, user_id, slug) VALUES (gen_random_uuid(), 'user-b-uuid', 'slug')$$,
  'new row violates row-level security policy for table "conversations"',
  'User A cannot create a conversation owned by user B'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
```

Run in the Supabase local stack:

```bash
supabase db test --db-url "postgresql://postgres:postgres@localhost:54322/postgres"
```

### Approach D — Application-level integration tests

For Lumina's Express + Prisma backend the practical approach is: write integration tests that call
the backend routes with real (or faked) JWTs, verify the correct HTTP status codes, and let the
database enforce both the application logic and (when active) the RLS policies. The `supabase-fake`
seam (`backend/tests/helpers/supabase-fake.ts`) controls which user the JWT validates to.

If a new route bypasses Express and goes directly to supabase-js, RLS is the line of defense and
it must be tested with real Postgres. See the Supabase CLI approach above.

---

## 7. Lumina applicability

### Current posture

Lumina's tables — `User`, `Conversation`, `Message`, `CachedQuery`, `GmailConnection` — are
accessed exclusively through Prisma over `DATABASE_URL`. The supabase-js client is used only for
`auth.getUser(token)` (JWT validation). No table is exposed through PostgREST or the supabase-js
data client.

**As a result, RLS is not currently configured on any table.** Authorization is enforced in
application code: `backend/auth.ts` sets `req.userId` from the validated JWT, and every route
handler queries `WHERE userId = req.userId`. This is equivalent to what RLS would enforce — but
colocated in TypeScript rather than SQL.

### When RLS becomes mandatory

The moment a table is accessed through the supabase-js client (from the browser or a mobile client)
or exposed through PostgREST (Supabase's auto-generated REST layer), RLS must be enabled on that
table before the exposure. An RLS-disabled table that PostgREST can reach is a full data breach.

Scenarios that would trigger this in Lumina:

| Scenario | Table(s) affected | Minimum required policy |
|---|---|---|
| Real-time conversation sync (browser subscribes to Postgres Changes) | `conversations`, `messages` | `SELECT` for owner (`user_id = (SELECT auth.uid())`) |
| Client-side file management (Supabase Storage RLS) | Storage bucket | `SELECT`/`INSERT` owner policy on bucket objects |
| Collaborative workspaces (team-owned conversations) | `conversations`, `messages` | Team membership join-table policy |
| Public watchlist sharing | A new `public_watchlists` table | `SELECT` for `anon` + `authenticated`; `INSERT`/`UPDATE`/`DELETE` for owner |

### Recommended migration path (if/when a table is exposed)

1. **Enable RLS on the table** before making any client-side supabase-js calls against it.
   ```sql
   ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
   ```

2. **Write policies for every command** the client will use. Default deny means omitting a command
   is safe; adding it requires an explicit policy.

3. **Index the `user_id` column** (or whatever column the `USING` predicate filters on) if not
   already indexed. On the Lumina schema, `Conversation.userId` (mapped to `user_id`) is an FK but
   not indexed. Add:
   ```sql
   CREATE INDEX conversations_user_id_idx ON conversations (user_id);
   ```

4. **Use `(SELECT auth.uid())`** — not bare `auth.uid()` — in every policy predicate.

5. **Test with the CLI local stack** before deploying. Use psql impersonation or pgTAP to
   verify both the allow and deny cases for each policy.

6. **Document in `backend/prisma/schema.prisma`** which tables have RLS enabled, analogous to the
   existing pgvector comment, so the RLS state is visible to engineers reading the schema.

### GmailConnection — a worked example

`GmailConnection` (`backend/prisma/schema.prisma:86-100`) stores encrypted OAuth refresh tokens.
It is strictly server-side data; the client has no business reading it directly. RLS is not needed
as long as access remains in the Express backend. If a client-side "view connected accounts"
feature were built using supabase-js:

```sql
-- Enable on the mapped table name
ALTER TABLE gmail_connection ENABLE ROW LEVEL SECURITY;

-- Users can only read their own connection row (one per user)
CREATE POLICY "gmail_connection_select_own"
  ON gmail_connection
  FOR SELECT
  TO authenticated
  USING ( user_id = (SELECT auth.uid()) );

-- No INSERT policy — connections are created server-side during OAuth callback.
-- No UPDATE policy — tokens are rotated server-side only.
-- No DELETE policy — disconnection goes through the backend, which can also clean up tokens.
```

But the preferred architecture is to keep the route in Express and return only the non-sensitive
fields (`googleEmail`, `scopes`, `createdAt`) from the Prisma query — the encrypted token columns
never leave the backend.

### The Prisma-vs-RLS tradeoff for Lumina specifically

| | Prisma (current) | RLS (if/when needed) |
|---|---|---|
| **Authz location** | TypeScript route handlers | Postgres engine |
| **Type safety** | Full (Prisma generated types) | None without codegen |
| **Migration tracking** | `schema.prisma` + migrations | Raw SQL in migration files |
| **Testability** | Unit-testable via `prisma-fake.ts` | Requires local Postgres / CLI |
| **Overhead** | Zero (connection pooler only) | Per-row policy evaluation (mitigated by indexes) |
| **Needed when** | All access via trusted backend | Any direct client access |

The correct engineering decision is not "RLS or Prisma" — it is "which tables are client-exposed?"
Tables that are client-exposed need RLS; tables that are server-only rely on application authz.
Lumina's current design (all tables server-only) is coherent. Introducing a client-side path to any
table without simultaneously enabling RLS is the specific failure to avoid.

---

## See also

- **`theory-row-level-security-model.md`** (this skill) — mental model for `USING`/`WITH CHECK`,
  the threat model, and why Lumina enforces authz in Express+Prisma today
- **`lumina-supabase-in-this-repo.md`** (this skill) — the division of labor between Prisma and
  Supabase in this codebase; when and how Supabase is used; the service-role key caveat
- **`patterns-database-functions-triggers-rpc.md`** (this skill) — `plpgsql` triggers and functions,
  `SECURITY DEFINER`/`INVOKER` in general DB-function contexts
- **`patterns-cli-migrations-and-types.md`** (this skill) — the Supabase CLI, local stack,
  extension management (pgvector), `gen types typescript`; how the CLI coexists with Prisma
- **`prisma`** skill — Prisma schema, migrations, the `PrismaPg` driver adapter, `$queryRaw` for
  pgvector, the `prisma-fake.ts` seam; the primary data-access layer when RLS is not in use
- **`backend-testing`** skill — the full test preload architecture, `supabase-fake.ts` and
  `prisma-fake.ts` wired together, writing integration tests for routes protected by `auth.ts`
- **`rag-retrieval`** skill — semantic cache via `CachedQuery` and pgvector; the table that uses
  `Unsupported("vector(1536)")` and is accessed only via raw SQL
- **`connectors-oauth`** skill — `GmailConnection` model, OAuth token vault, the server-side-only
  access pattern that avoids the need for RLS on token storage
- **`lumina-frontend`** skill — how the React app obtains and forwards the Supabase JWT, relevant
  if a future client-side supabase-js data path is introduced
- **`finance-markets`** skill — if a public or per-user watchlist table were introduced, RLS
  policies for it would follow the patterns in §2–§3 of this document
