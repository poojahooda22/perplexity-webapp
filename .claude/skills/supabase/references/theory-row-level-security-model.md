# Theory: The Row Level Security Authorization Model

> Row Level Security (RLS) is the authorization boundary Postgres enforces for every request that
> reaches Supabase through the public anon key — the one place where "who can see and change which
> rows" is decided, at the data layer, for every code path simultaneously.

---

## Table of Contents

1. [The RLS Mental Model: Policies as Row-Level WHERE Clauses](#1-the-rls-mental-model-policies-as-row-level-where-clauses)
2. [The Postgres Role Model: anon, authenticated, service_role](#2-the-postgres-role-model-anon-authenticated-service_role)
3. [The JWT → Role → Predicate Pipeline](#3-the-jwt--role--predicate-pipeline)
4. [Enabling RLS and Default-Deny Semantics](#4-enabling-rls-and-default-deny-semantics)
5. [USING vs WITH CHECK: The Central Distinction](#5-using-vs-with-check-the-central-distinction)
6. [Per-Command Policies and How They Apply](#6-per-command-policies-and-how-they-apply)
7. [How Multiple Policies Combine: PERMISSIVE (OR) vs RESTRICTIVE (AND)](#7-how-multiple-policies-combine-permissive-or-vs-restrictive-and)
8. [Auth Helper Functions: auth.uid(), auth.jwt(), auth.role()](#8-auth-helper-functions-authuid-authjwt-authrole)
9. [Reading Custom Claims and app_metadata in Predicates](#9-reading-custom-claims-and-app_metadata-in-predicates)
10. [A Worked Schema: Lumina Conversations and Gmail Connections](#10-a-worked-schema-lumina-conversations-and-gmail-connections)
11. [The Threat Model: What RLS Protects and What It Does Not](#11-the-threat-model-what-rls-protects-and-what-it-does-not)
12. [SECURITY DEFINER Functions and search_path Hijacking](#12-security-definer-functions-and-search_path-hijacking)
13. [Performance: Predicates Run Per Row](#13-performance-predicates-run-per-row)
14. [Testing Policies: Impersonation and CI](#14-testing-policies-impersonation-and-ci)
15. [Lumina's Actual Auth Architecture and When RLS Becomes Mandatory](#15-luminas-actual-auth-architecture-and-when-rls-becomes-mandatory)
16. [Anti-Patterns](#16-anti-patterns)
17. [References](#17-references)

---

## 1. The RLS Mental Model: Policies as Row-Level WHERE Clauses

In a conventional three-tier app the database sits behind a trusted application server. The browser
never holds database credentials; it talks to an Express API, the API authenticates the request,
and the API issues queries with a privileged connection. The trust boundary is the API code. SQL is
constructed by code you control, so authorization is whatever your route handlers decide.

Supabase inverts this model. The browser holds a real Postgres credential — encoded in the **anon
key** — and supabase-js speaks to Postgres (via PostgREST, GoTrue, Realtime, Storage) **directly**.
There is no application server in the middle deciding what a user may read. The frontend can issue
arbitrary filters, arbitrary column selections, arbitrary `order`/`limit`, and arbitrary mutations.
An attacker can read your anon key from the browser bundle and craft any query they want:

```bash
# The anon key is public by design. Anyone can do this.
curl 'https://YOUR-PROJECT.supabase.co/rest/v1/conversations?select=*' \
  -H "apikey: eyJhbGciOiJIUzI1NiI..." \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiI..."
```

**The boundary moved.** In a classic stack the trust boundary is your API code. In Supabase the
trust boundary is the set of RLS policies on your tables. A missing or too-broad policy has no
second line of defense — the query runs straight against your data.

This is also why Supabase is *more* defensible when done correctly than a hand-rolled API. In a
hand-rolled API, every route handler re-implements `WHERE user_id = ?`. Miss one and you have a
broken-object-level-authorization (BOLA / IDOR) bug. With RLS the predicate lives on the *table*
once and applies to **every** query against that table from every code path — the web app, a mobile
companion, a realtime subscription, an Edge Function using the anon key, even a future client you
have not written yet. Authorization is centralized at the data layer.

The Postgres mechanism is precise: when a statement runs against an RLS-enabled table, the planner
appends each applicable policy's `USING` predicate as an additional `WHERE` clause and each
`WITH CHECK` predicate as a post-write validity gate. **Rows for which no policy grants access
simply do not appear** — they are not errors, they are invisible.

> Policies are WHERE clauses Postgres staples onto your queries. There is nothing more magical
> about them than that, and nothing less powerful.

---

## 2. The Postgres Role Model: anon, authenticated, service_role

Every request that reaches Postgres through Supabase runs as a Postgres role:

| Role | Who uses it | Key in play | RLS applies? | Typical use |
|---|---|---|---|---|
| `anon` | Unauthenticated visitors | anon key, no user JWT | **Yes** | Public reads (published content), pre-signup flows |
| `authenticated` | Signed-in users | anon key + a valid user JWT | **Yes** | Everything a logged-in user does |
| `service_role` | Trusted server code | service_role key | **No — bypasses RLS** | Admin tasks, cron, migrations, webhooks |

Critical facts:

- **`anon` and `authenticated` do not bypass RLS.** They are deliberately low-privilege roles.
  Every query they run is filtered by the table's policies.
- **`service_role` bypasses RLS entirely** via the `BYPASSRLS` Postgres attribute. Putting the
  service_role key in a browser bundle, a mobile app, or any client is a catastrophic mistake — it
  hands every visitor unrestricted read/write to the entire database. Treat it like a database
  superuser password. It lives in server-only environment variables.
- The role is chosen by **GoTrue/PostgREST based on the JWT**, not by the client asking nicely.
  The `role` claim inside the JWT determines which Postgres role the request runs as. PostgREST
  verifies the JWT signature before trusting any claim, so a client cannot escalate by editing
  their token.
- PostgREST switches to the request's role via `SET LOCAL ROLE` for the duration of the
  transaction — the connection is pooled but the effective role is scoped to a single request.

```text
Browser / SPA client
   │  anon key (always)  +  user JWT (after sign-in)
   ▼
GoTrue (auth) / PostgREST (REST) / Realtime / Storage
   │  verifies JWT signature, reads "role" claim
   ▼
Postgres connection: SET LOCAL ROLE authenticated;   -- or anon
   │  request.jwt.claims set as a GUC
   ▼
RLS policies evaluate using auth.uid(), auth.jwt(), etc.
```

> Rule: anon key in the client, always. service_role key on the server, never in a client. RLS
> is what makes the anon key safe to expose.

---

## 3. The JWT → Role → Predicate Pipeline

Understanding RLS requires knowing what information is available *inside* a policy at evaluation
time and where it comes from:

1. **The user signs in.** GoTrue verifies credentials (password, magic link, OAuth) and mints a
   short-lived **access token** (JWT) signed with the project's JWT secret. supabase-js stores it
   and attaches it as the `Authorization: Bearer <jwt>` header on every request.

2. **PostgREST receives the request.** It verifies the JWT signature, extracts the claims, sets
   the Postgres role from the `role` claim (`SET LOCAL ROLE authenticated`), and stores the full
   claims JSON in the transaction-local setting `request.jwt.claims`.

3. **Postgres runs the query.** RLS predicates are appended to the query. Inside those predicates,
   helper functions expose the JWT:
   - `auth.uid()` → the `sub` claim (the user's UUID, or `NULL` for anon).
   - `auth.jwt()` → the entire claims object as `jsonb`.
   - `auth.role()` → the `role` claim.

A representative JWT payload for a signed-in Lumina user (decode at jwt.io during development):

```json
{
  "aud": "authenticated",
  "exp": 1739000000,
  "iat": 1738996400,
  "iss": "https://rgwdybuczqcoenmxmosd.supabase.co/auth/v1",
  "sub": "9f6c2b3a-1d4e-4f8a-9c2d-7e1b3a5f8c0d",
  "email": "user@example.com",
  "role": "authenticated",
  "app_metadata": {
    "provider": "google",
    "providers": ["google"]
  },
  "user_metadata": {
    "full_name": "Ada Lovelace",
    "avatar_url": "https://..."
  }
}
```

Two metadata buckets, and the distinction is a security primitive:

- **`app_metadata`** — set by your backend or admin only. **The user cannot modify it.** This is
  where authorization-relevant data lives: a custom role like `admin`, a tenant ID, a feature
  flag. Trust it in policies.
- **`user_metadata`** (`raw_user_meta_data`) — set by the user during signup or via `updateUser`.
  **The user can modify it.** Never base an authorization decision on `user_metadata`. Treat it
  like user-supplied form input.

Note in `backend/auth.ts:61-66` Lumina reads `user.app_metadata.provider` (trusted) and
`user.user_metadata.full_name` (display only, with an email fallback) — exactly the right split.

> Verifying JWTs. `supabase.auth.getClaims()` verifies the JWT locally and returns its claims
> (fast path; no round trip). `getUser()` always calls the Auth server. `getSession()` reads the
> stored session WITHOUT verifying the signature — never trust it for authorization on a server.

---

## 4. Enabling RLS and Default-Deny Semantics

RLS is **off by default** on a freshly created table. A table with RLS off is fully exposed to
whatever grants the role has — and Supabase grants `anon`/`authenticated` broad table privileges
by default so the PostgREST API works. That means: **a table with RLS disabled is readable and
writable by anyone with the anon key.** The Supabase dashboard flags such tables with a loud
warning for exactly this reason.

Enable it explicitly and immediately on every table in an API-exposed schema:

```sql
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.gmail_connection enable row level security;
```

The moment RLS is enabled, the table flips to **default-deny**:

> With RLS enabled and **no policies**, the table returns **zero rows** to `anon`/`authenticated`
> and **rejects all** inserts/updates/deletes. There is no implicit "allow." Access is granted
> only by policies you add.

This is the correct default. You start from a locked table and open specific access, rather than
starting open and trying to close holes. Both halves are required: a policy written on a table
where RLS is *disabled* does nothing — the policies are ignored. Enabling RLS with no policies
makes the table inaccessible, not "secure with sensible defaults."

Two additional hardening options worth knowing:

- **`FORCE ROW LEVEL SECURITY`** — subjects the table owner (typically `postgres`) to policies,
  not just `anon`/`authenticated`. Rarely needed for app traffic, but useful for tables that
  might be touched by `SECURITY DEFINER` functions owned by `postgres`.
- **`service_role` always bypasses** regardless of `FORCE` (the `BYPASSRLS` attribute is on the
  role itself, not the table).

Defensive convention: **enable RLS in the same migration that creates the table**, before any data
or grants are exercised. Never let a table exist in the `public` schema for even one deploy with
RLS off.

---

## 5. USING vs WITH CHECK: The Central Distinction

A policy can carry up to two predicates, and confusing them is the most common source of RLS bugs:

| Clause | Question it answers | Applies to | Rows it gates |
|---|---|---|---|
| `USING (expr)` | "Can the user *see/touch* this **existing** row?" | SELECT, UPDATE, DELETE | Reads the *current* row state |
| `WITH CHECK (expr)` | "Is this **new/changed** row state *allowed to exist*?" | INSERT, UPDATE | Reads the *proposed* row state |

Mental model:

- **`USING` is the visibility filter.** It is appended as a WHERE clause. Rows for which `USING`
  is false simply do not exist as far as the user is concerned — silently filtered, not error'd
  on. For DELETE and the old-row side of UPDATE, `USING` decides which rows the user is allowed
  to target.
- **`WITH CHECK` is the validity gate.** Applied to the row *after* the proposed write. If false,
  the write **errors** with `new row violates row-level security policy`. It is the only way to
  constrain the *content* of what a user writes.

Per-command applicability:

| Command | `USING` evaluated? | `WITH CHECK` evaluated? |
|---|---|---|
| `SELECT` | Yes (which rows are visible) | — (not applicable) |
| `INSERT` | — (no existing row) | Yes (the new row) |
| `UPDATE` | Yes (which rows may be updated — old state) | Yes (the resulting row — new state) |
| `DELETE` | Yes (which rows may be deleted) | — (nothing is being created) |

A critical default: **for UPDATE, if you omit `WITH CHECK`, Postgres reuses the `USING` expression
as the `WITH CHECK`.** This is usually what you want (a user who can edit their own rows should
only be able to leave them as their own rows), but it is implicit. For INSERT, there is no `USING`
to fall back on — an INSERT policy must specify `WITH CHECK`.

Concrete example on a generic user-owned resource table:

```sql
-- SELECT: a user may read only their own rows.
create policy "read own rows"
on public.conversations
for select to authenticated
using ( user_id = (select auth.uid()) );

-- INSERT: a user may create a row only if they stamp themselves as owner.
create policy "insert as self"
on public.conversations
for insert to authenticated
with check ( user_id = (select auth.uid()) );   -- no USING on INSERT

-- UPDATE: may edit their own rows (USING: old row is theirs)
-- and must not reassign ownership (WITH CHECK: new row still theirs).
create policy "update own, keep ownership"
on public.conversations
for update to authenticated
using     ( user_id = (select auth.uid()) )
with check ( user_id = (select auth.uid()) );

-- DELETE: only their own rows.
create policy "delete own"
on public.conversations
for delete to authenticated
using ( user_id = (select auth.uid()) );   -- WITH CHECK is meaningless on DELETE
```

Why the UPDATE `WITH CHECK` matters: without it, a user who can update their own conversation
could set `user_id` to someone else's UUID in the same statement — donating the row, or smuggling
content under another user's identity. `USING` only gates which rows they may *start* from; only
`WITH CHECK` gates what those rows may *become*.

> One-line heuristic: `USING` filters what *is*; `WITH CHECK` validates what *will be*. Reads use
> `USING`. Writes that create rows use `WITH CHECK`. Updates use both.

---

## 6. Per-Command Policies and How They Apply

Policies are scoped to one or more SQL commands via the `FOR` clause:

- `FOR SELECT`
- `FOR INSERT`
- `FOR UPDATE`
- `FOR DELETE`
- `FOR ALL` — applies to all four; convenient but blunt.

**Prefer explicit per-command policies over `FOR ALL`.** A `FOR ALL` policy forces a single
predicate to do duty as both `USING` (for SELECT/UPDATE/DELETE visibility) and `WITH CHECK` (for
INSERT/UPDATE validity). The semantics are subtle: a `FOR ALL` policy's `USING` is not applied to
INSERT, and its `WITH CHECK` defaults to the `USING` expression for INSERT/UPDATE. When you need
different logic for reads versus writes (the common case), `FOR ALL` either does the wrong thing
or forces you to overload one expression. Splitting into named per-command policies is more verbose
but each is independently auditable and testable.

The `TO` clause restricts the policy to specific roles. **Always include it.** A policy `to
authenticated` is not evaluated for `anon` requests. Omitting `TO` makes the policy apply to
`public` (all roles), which forces predicate evaluation even for roles it does not concern — both
a correctness and a performance issue.

Demonstration — `gmail_connection` table: a user may see and manage their own connection; no
client-side INSERT (that goes through the OAuth callback on the backend with a privileged
connection):

```sql
alter table public.gmail_connection enable row level security;

-- A user reads only their own connection row.
create policy "users read own gmail connection"
on public.gmail_connection for select to authenticated
using ( user_id = (select auth.uid()) );

-- A user may update their own connection (e.g., revoking/reconnecting updates scopes).
create policy "users update own gmail connection"
on public.gmail_connection for update to authenticated
using     ( user_id = (select auth.uid()) )
with check ( user_id = (select auth.uid()) );

-- A user may delete (disconnect) their own connection.
create policy "users delete own gmail connection"
on public.gmail_connection for delete to authenticated
using ( user_id = (select auth.uid()) );

-- NO INSERT policy for authenticated: the OAuth callback runs server-side via
-- service_role (bypasses RLS). The client can never forge a connection.
```

Silence is denial. The absence of an INSERT policy on `gmail_connection` for the `authenticated`
role means no client can ever insert a row directly, regardless of what they put in the request.

---

## 7. How Multiple Policies Combine: PERMISSIVE (OR) vs RESTRICTIVE (AND)

When several policies apply to the same command and role, Postgres combines them:

| Policy type | Default? | Combination | Mental model |
|---|---|---|---|
| `PERMISSIVE` | **Yes** | OR'd together | "Any one of these may grant access" |
| `RESTRICTIVE` | No (must say `AS RESTRICTIVE`) | AND'd together | "All of these must also pass" |

Full evaluation rule:

> A row passes if **(at least one PERMISSIVE policy is true) AND (every RESTRICTIVE policy is
> true)**.

Permissive policies *add* access (each is another way in). Restrictive policies *subtract* it
(each is an additional mandatory gate). If there are **no** permissive policies for a command,
access is denied regardless of restrictive policies — restrictive policies can only narrow an
already-granted access, never grant it.

Permissive is the default and the one used 95% of the time. Write a separate permissive policy
per *audience* and they OR together. Restrictive policies are the tool for cross-cutting mandatory
constraints that must hold regardless of which permissive policy granted access:

```sql
-- Scenario: Lumina adds a team/org tier where users share conversations.
-- PERMISSIVE policies enumerate who may read (OR'd):

create policy "owner reads own conversation"
on public.conversations for select to authenticated
using ( user_id = (select auth.uid()) );

create policy "team member reads shared conversation"
on public.conversations for select to authenticated
using (
  exists (
    select 1 from public.team_members tm
    where tm.conversation_id = conversations.id
      and tm.user_id = (select auth.uid())
  )
);

-- RESTRICTIVE policy: regardless of the above grants, the row's tenant MUST
-- match the requester's tenant. AND'd onto every permissive grant.
create policy "tenant isolation"
on public.conversations
as restrictive
for select to authenticated
using (
  tenant_id = ((select auth.jwt() -> 'app_metadata' ->> 'tenant_id'))::uuid
);
```

Here, either the owner or a team member can read (permissive OR), but the restrictive tenant
policy AND's in, so a user from one tenant can never read another tenant's conversations. Without
the restrictive policy you would have to add `and tenant_id = ...` to every permissive policy —
and the day you forget one, you have a tenant-isolation breach.

> Design rule: Use **permissive** policies to enumerate the ways access is granted (they OR).
> Use **restrictive** policies for invariants that must always hold (they AND).

---

## 8. Auth Helper Functions: auth.uid(), auth.jwt(), auth.role()

Supabase ships a small `auth` schema of helper functions that read the request's JWT claims:

| Function | Returns | Source claim | Notes |
|---|---|---|---|
| `auth.uid()` | `uuid` | `sub` | The user's id; `NULL` for `anon`. The workhorse. |
| `auth.jwt()` | `jsonb` | entire claims | Read any claim, including `app_metadata`. |
| `auth.role()` | `text` | `role` | `'authenticated'` / `'anon'`. Legacy; prefer `TO` clause. |
| `auth.email()` | `text` | `email` | Convenience; can be stale — prefer `auth.jwt()->>'email'`. |

`auth.uid()` is a `STABLE` SQL function that reads from a transaction-local GUC:

```sql
-- Simplified implementation: reads 'sub' claim from the request GUC.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
```

The single most important performance practice in all of Supabase RLS:

> **Wrap `auth.uid()` (and any `auth.*()` call) in a scalar subquery: `(select auth.uid())`.**

Why: `auth.uid()` is `STABLE`, meaning it returns the same value within a single statement. When
you write `(select auth.uid())`, the Postgres planner treats it as an **InitPlan** — it evaluates
the function **once** for the whole query and caches the result. Written bare as
`auth.uid() = user_id`, the function can be re-invoked **per row** — a million-row scan means a
million function calls. The behavioral result is identical; the performance difference can be
**100x or more** on large tables. This is the official, repeatedly-emphasized Supabase guidance.

```sql
-- SLOW: auth.uid() may be re-evaluated per row.
using ( user_id = auth.uid() )

-- FAST: evaluated once, cached as an InitPlan scalar. Always do this.
using ( user_id = (select auth.uid()) )
```

The same wrapping applies to `(select auth.jwt())` and any `STABLE` expression that does not
depend on the row. See section 13 for the full performance treatment.

`auth.role()` exists but the modern pattern is to express role gating through the **`TO` clause**
(`to authenticated`, `to anon`), which lets Postgres skip the policy entirely for non-matching
roles. Reserve `auth.jwt() ->> 'role'`-style checks for **custom** application roles stored in
`app_metadata`, which are distinct from the Postgres `role` claim.

---

## 9. Reading Custom Claims and app_metadata in Predicates

The Postgres `role` claim has exactly three meaningful values in Supabase (`anon`, `authenticated`,
`service_role`). Your application's business roles — `admin`, `moderator` — and authorization
attributes (`tenant_id`, `plan`, feature flags) live in **`app_metadata`**, embedded in the JWT
and reachable via `auth.jwt()`.

This is safe because **`app_metadata` is server-controlled. Users cannot edit it.** Setting it
requires a service_role or admin API call, never the client:

```ts
// Server-only (Express route behind service_role or a Supabase Edge Function).
// NEVER ship this to a client.
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,  // secret; server only
  { auth: { autoRefreshToken: false, persistSession: false } },
)

// Promote a user to admin. This writes app_metadata, which the user cannot
// modify and which RLS policies are allowed to trust.
await admin.auth.admin.updateUserById(userId, {
  app_metadata: { role: 'admin' },
})
```

Reading it inside a policy. `auth.jwt()` returns `jsonb`; navigate with `->` (returns `jsonb`)
and `->>` (returns `text`):

```sql
-- Only admins may view all conversations (permissive, OR'd with owner policy).
create policy "admins read all conversations"
on public.conversations for select to authenticated
using (
  (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- Only admins may delete any cached_query entry (e.g., cache invalidation UI).
create policy "admins delete cached queries"
on public.cached_query for delete to authenticated
using (
  (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
```

A critical operational caveat:

> **JWT claims are a snapshot.** `app_metadata` is baked into the access token when it is minted.
> If you change a user's role server-side, their currently active JWT still carries the **old**
> role until it expires (default ~1 hour) or until the client refreshes the session.

Consequences and mitigations:

- For role *promotions*, the lag is usually acceptable (a newly promoted admin waits up to an
  hour, or you force a token refresh via `supabase.auth.refreshSession()`).
- For role *revocations* and security-sensitive demotions, do not rely solely on the JWT claim.
  Either keep the authoritative role in a table and join to it in the policy (always live, at the
  cost of a per-query lookup), or invalidate the session server-side.

```sql
-- Authoritative roles in a table: policies read the live value, never stale.
create policy "live-role: admins read all conversations"
on public.conversations for select to authenticated
using (
  exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.role = 'admin'
  )
);
```

Decision guide:

| Source of role/attribute | Stale window | Per-query cost | Use when |
|---|---|---|---|
| `app_metadata` in JWT | Up to token TTL | None (in-token) | Roles that rarely change; promotions |
| Table join in policy | None (live) | One lookup per query | Revocations; security-sensitive gates |
| Custom Access Token Hook | Up to token TTL | None (in-token) | Table authority + in-JWT performance |

---

## 10. A Worked Schema: Lumina Conversations and Gmail Connections

Putting the primitives together on Lumina's actual data model. In this hypothetical extension,
a future Lumina client-facing Supabase query layer would need the following RLS to be safe. All
tables and columns reference `backend/prisma/schema.prisma`.

The entities: `users` (mirrored from Supabase auth), `conversations` (owned by a user, with a
`userId` foreign key), `messages` (belong to a conversation), `gmail_connection` (one per user,
holds encrypted OAuth tokens).

```sql
-- ======== conversations ========
-- userId STRING references users.id; slug STRING; title STRING?

alter table public."Conversation" enable row level security;

-- A user reads only their own conversations.
create policy "owner reads own conversations"
on public."Conversation" for select to authenticated
using ( "userId" = (select auth.uid()) );

-- A user creates a conversation only as themselves.
create policy "owner inserts own conversation"
on public."Conversation" for insert to authenticated
with check ( "userId" = (select auth.uid()) );

-- A user edits (renames) only their own conversations; cannot reassign.
create policy "owner updates own conversation"
on public."Conversation" for update to authenticated
using     ( "userId" = (select auth.uid()) )
with check ( "userId" = (select auth.uid()) );

-- A user deletes only their own conversations.
create policy "owner deletes own conversation"
on public."Conversation" for delete to authenticated
using ( "userId" = (select auth.uid()) );


-- ======== messages ========
-- conversationId references conversations; role enum; content TEXT

alter table public."Message" enable row level security;

-- A user reads messages only for conversations they own.
create policy "owner reads own messages"
on public."Message" for select to authenticated
using (
  exists (
    select 1 from public."Conversation" c
    where c.id = "Message"."conversationId"
      and c."userId" = (select auth.uid())
  )
);

-- A user inserts a message only into their own conversations.
create policy "owner inserts message into own conversation"
on public."Message" for insert to authenticated
with check (
  exists (
    select 1 from public."Conversation" c
    where c.id = "Message"."conversationId"
      and c."userId" = (select auth.uid())
  )
);

-- No UPDATE / DELETE policies for messages from clients.
-- Message history is immutable from the client side;
-- any cleanup runs server-side via service_role.


-- ======== gmail_connection ========
-- userId @unique; holds encrypted OAuth refresh token + iv + authTag

alter table public.gmail_connection enable row level security;

-- A user reads only their own connection.
create policy "owner reads own gmail connection"
on public.gmail_connection for select to authenticated
using ( "userId" = (select auth.uid()) );

-- A user may update their own connection row (e.g., scope changes after re-auth).
create policy "owner updates own gmail connection"
on public.gmail_connection for update to authenticated
using     ( "userId" = (select auth.uid()) )
with check ( "userId" = (select auth.uid()) );

-- A user may disconnect (delete) their own connection.
create policy "owner deletes own gmail connection"
on public.gmail_connection for delete to authenticated
using ( "userId" = (select auth.uid()) );

-- NO INSERT policy for authenticated.
-- The OAuth callback writes the initial row through the Express backend
-- (backend/connectors/gmail/callback.ts) which uses the service_role key,
-- bypassing RLS. The client can never forge a gmail_connection row.
-- This is the same "server-side for external invariants" split as section 11.


-- ======== cached_query ========
-- Public-read semantic cache. No per-user ownership on cache rows.
-- Writes are exclusively server-side (the /perplexity_ask route via service_role).

alter table public.cached_query enable row level security;

-- Authenticated users may read the cache (cache hits benefit all users).
create policy "authenticated reads cached queries"
on public.cached_query for select to authenticated
using (true);

-- No INSERT/UPDATE/DELETE for clients. All writes go through backend service code.
-- If a public-read cache is acceptable for your threat model, anon could also SELECT:
-- create policy "anon reads cached queries"
-- on public.cached_query for select to anon using (true);
```

Index the predicate columns — every policy `WHERE` clause needs an index:

```sql
-- Conversation ownership lookups.
create index if not exists "Conversation_userId_idx" on public."Conversation" ("userId");

-- Message → conversation ownership join.
create index if not exists "Message_conversationId_idx" on public."Message" ("conversationId");

-- gmail_connection: already unique on userId, so the unique index serves lookups.
-- (The @unique constraint creates an implicit btree index.)
```

The `gmail_connection` INSERT architecture is the important lesson from this schema: **external
invariants (like "the OAuth flow must have completed successfully") are not an RLS concern.** RLS
can express "is this row owned by the current user?" but cannot express "did this user complete a
valid OAuth flow?" That fact is asserted by the OAuth callback in
`backend/connectors/gmail/callback.ts`, which runs with a service_role connection. The client can
*read* its connection but can never *forge* one. This split — RLS for ownership-based visibility,
server code for external invariants — is the correct architecture.

---

## 11. The Threat Model: What RLS Protects and What It Does Not

RLS is a row-visibility mechanism, not a complete security system. Knowing its exact scope prevents
both over-trust and over-engineering.

**What RLS protects against:**

- **Broken object-level authorization (IDOR / BOLA).** A user querying `?id=eq.<other-uuid>` cannot
  read or modify rows that fail their policy. The predicate is enforced for every query path. This
  is the single most common API vulnerability class, and RLS neutralizes it structurally.
- **Mass data exfiltration via the public anon key.** Even with the key (which is public), an
  attacker sees only what policies allow.
- **Cross-tenant leakage**, when a restrictive tenant-isolation policy is in place (section 7).
- **Privilege escalation through the client**, because the role and `auth.uid()` come from a
  server-signed JWT the client cannot forge.
- **Forgotten authorization checks**, because the check lives on the table and applies to every
  code path automatically.

**What RLS does NOT protect against — and must be handled elsewhere:**

| Not protected by RLS | Why | Where it belongs |
|---|---|---|
| **External invariants** (e.g., "OAuth flow must have completed") | RLS sees only row data, not external facts | Server code with service_role; verified callback |
| **Application logic bugs** | A wrong predicate is faithfully enforced — RLS executes your mistake | Tests (section 14); policy review |
| **`SECURITY DEFINER` functions** | Run as the *owner*, bypass the caller's RLS | Pin `search_path`; scope the function tightly (section 12) |
| **Anything `service_role` does** | Has `BYPASSRLS` | Keep the key server-only; validate inputs in server code |
| **Rate limiting / DoS** | RLS filters rows; it does not throttle requests | `backend/lib/ratelimit.ts` (Upstash sliding window) |
| **Column-level exposure** | RLS is row-granular; a readable row exposes all its granted columns | Column privileges, separate tables, curated views |
| **Field content validation** beyond ownership | `WITH CHECK` can validate, but complex rules belong in constraints | `CHECK` constraints, triggers, server validation |
| **Stale JWT claims after a permission change** | JWT is a snapshot until refresh/expiry | Table-of-record roles, or session invalidation |

Three threat-model subtleties:

1. **Empty vs. error is an information channel.** A SELECT under RLS returns *empty* for
   non-visible rows — the row's existence is hidden. But an INSERT/UPDATE violating `WITH CHECK`
   *errors*. Do not design flows where error vs. success tells an attacker whether a hidden row
   exists.

2. **RLS protects rows, not the *fact* of a query.** Aggregates like `count(*)` are still subject
   to RLS (they count only visible rows), but be careful with foreign-table embeds — the embedded
   resource is filtered by *its own* policies, which must exist and be correct.

3. **Column-level security is your responsibility.** A policy granting read of a row grants read
   of *all its columns*. If `gmail_connection` has a `refreshTokenEnc` column, a reader of that
   row sees the ciphertext. This is fine when the data is already encrypted at the application
   layer (as Lumina's Gmail tokens are), but plaintext-sensitive columns need column grants, a
   separate table with stricter policies, or a curated view.

> Layered model: RLS handles ownership/visibility. CHECK constraints and triggers handle data
> integrity. Server code (service_role) handles external business facts. Rate limiting handles
> abuse. Column grants handle field-level secrecy. No single layer is the whole answer.

---

## 12. SECURITY DEFINER Functions and search_path Hijacking

Postgres functions run with one of two privilege models:

- **`SECURITY INVOKER`** (default) — runs with the *caller's* privileges and RLS context.
  `auth.uid()` is the caller; policies apply. Safe by default.
- **`SECURITY DEFINER`** — runs with the *function owner's* privileges. If owned by `postgres`,
  it bypasses RLS on tables it touches, exactly like service_role.

`SECURITY DEFINER` is necessary (e.g., a helper that performs a privileged insert on behalf of
a client that otherwise could not). But it carries a specific, serious vulnerability:
**search_path hijacking.**

The attack: a `SECURITY DEFINER` function resolves unqualified object names (`my_table`,
`lower(...)`) against the session's `search_path`. If `search_path` includes a schema the
*caller* can write to, the caller can create a malicious object the privileged function then
invokes *as the owner* — instant privilege escalation.

The mandatory mitigation:

> **Every `SECURITY DEFINER` function MUST pin its `search_path` to `''`** and fully-qualify
> every object reference (`public.conversations`, `auth.uid()`, `pg_catalog.now()`). An empty
> search_path means nothing resolves implicitly, so nothing can be hijacked.

```sql
-- SAFE: definer function with pinned, empty search_path.
-- Use case: a privileged insert that the client may trigger via RPC, but
-- which enforces server-side invariants the client cannot bypass.
create or replace function public.create_gmail_connection(
  p_google_email  text,
  p_token_enc     text,
  p_iv            text,
  p_auth_tag      text,
  p_scopes        text
)
returns public.gmail_connection
language plpgsql
security definer
set search_path = ''       -- <-- the non-negotiable line
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.gmail_connection;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Fully-qualified everything: public.*, auth.*, pg_catalog.*
  insert into public.gmail_connection
    (user_id, google_email, refresh_token_enc, iv, auth_tag, scopes, created_at, updated_at)
  values
    (v_uid, p_google_email, p_token_enc, p_iv, p_auth_tag, p_scopes,
     pg_catalog.now(), pg_catalog.now())
  on conflict (user_id) do update
    set refresh_token_enc = excluded.refresh_token_enc,
        iv                = excluded.iv,
        auth_tag          = excluded.auth_tag,
        scopes            = excluded.scopes,
        updated_at        = pg_catalog.now()
  returning * into v_row;

  return v_row;
end;
$$;

-- Lock down EXECUTE: Postgres grants it to `public` by default; revoke and restrict.
revoke all on function public.create_gmail_connection(text,text,text,text,text) from public;
grant execute on function public.create_gmail_connection(text,text,text,text,text) to authenticated;
```

Rules for `SECURITY DEFINER` functions:

1. `set search_path = ''` on the function (empty is safest; an explicit allow-list is the
   alternative).
2. Fully qualify every identifier — tables, functions, types, operators where ambiguous.
3. Re-implement the authorization you bypassed. The function above re-derives `auth.uid()` and
   refuses anonymous callers.
4. Keep the function narrow. A definer function should do one privileged thing, not be a
   general-purpose admin endpoint.
5. Lock down `EXECUTE`. Revoke from `public`; grant only to the roles that should call it.

`SECURITY INVOKER` is also relevant for **views**. By default a view runs queries as the view's
owner, which can bypass RLS on the underlying tables. On Postgres 15+, create RLS-respecting
views with `security_invoker = true`:

```sql
-- A view that respects the *querying user's* RLS on the underlying tables.
-- Without this, the view owner's RLS context applies — often a privileged role.
create view public.my_conversation_summaries
with (security_invoker = true) as
  select id, title, slug, "createdAt"
  from public."Conversation";
```

Supabase's database linter (`supabase db lint` / the dashboard's Security Advisor) flags definer
functions with a mutable `search_path` — treat those warnings as errors.

---

## 13. Performance: Predicates Run Per Row

The mental model for RLS performance is simple and unforgiving: **an RLS policy is a WHERE clause
Postgres staples onto your query, and Postgres must satisfy it like any other predicate.**
Everything follows from that.

**1. Wrap auth functions in a subquery (the InitPlan trick).** `(select auth.uid())` is evaluated
once and cached as an InitPlan; bare `auth.uid()` may be called per row. 100x+ difference on
large tables. Covered in section 8 but critical enough to repeat:

```sql
-- Per-row function call: SLOW.
using ( user_id = auth.uid() )
-- Cached InitPlan: FAST. Always.
using ( user_id = (select auth.uid()) )
```

**2. Index the columns your policies filter on.** A policy `using (user_id = (select auth.uid()))`
turns every query into `... where user_id = <const>`. Without an index on `user_id`, that is a
sequential scan filtered per row. With a B-tree index, it is an index scan that touches only the
user's rows. The columns referenced in RLS predicates must be indexed exactly as if they were in
a hot `WHERE` clause — because they are.

```sql
-- Must have indexes on every column referenced in RLS predicates:
create index on public."Conversation" ("userId");
create index on public."Message" ("conversationId");
-- gmail_connection.userId is covered by the @unique constraint's implicit index.
```

**3. EXISTS subqueries in policies cost a lookup per candidate row — index both sides.** The
`Message` visibility policy does `exists (select 1 from "Conversation" c where c.id = "Message"."conversationId" and c."userId" = (select auth.uid()))`.
For each message row considered, Postgres probes `Conversation`. With indexes on both join
columns, that probe is an index seek, not a scan.

```sql
-- Composite index tuned for the membership-check pattern in policies.
create index on public."Message" ("conversationId");            -- already the FK index
create index on public."Conversation" (id, "userId");           -- covers the EXISTS probe
```

**4. Prefer security definer helper functions for repeated, expensive membership checks.** If the
same `EXISTS` test appears in many policies, encapsulate it in a `STABLE SECURITY DEFINER`
function with a pinned `search_path`:

```sql
-- Reusable: is the current user the owner of this conversation?
create or replace function public.is_conversation_owner(p_conversation_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public."Conversation" c
    where c.id = p_conversation_id
      and c."userId" = (select auth.uid())
  );
$$;

-- Policies become short and avoid re-planning the join every time:
create policy "owner reads messages"
on public."Message" for select to authenticated
using ( (select public.is_conversation_owner("conversationId")) );
```

**5. Scope policies with `TO`.** A policy with no `TO` is evaluated for all roles, including
`anon`. Adding `to authenticated` lets Postgres skip the policy entirely for anon requests.

**6. Always read `EXPLAIN (ANALYZE, BUFFERS)` of the actual query** — the policy is part of the
plan. Look for `Seq Scan` where you expected an index, and for the policy predicate appearing as
a `Filter` (re-checked per row) versus folded into an `Index Cond`.

```sql
-- Run AS the user to see the real, policy-applied plan.
-- (See section 14 for how to impersonate a user in psql.)
explain (analyze, buffers)
select * from public."Conversation" where "userId" = auth.uid();
```

Decision table:

| Symptom | Cause | Fix |
|---|---|---|
| Slow on large table; plan shows per-row function | bare `auth.uid()` | wrap as `(select auth.uid())` |
| `Seq Scan` on policy column | no index | index the predicate column |
| Slow `EXISTS` membership policy | unindexed join target | composite index on both join columns |
| Policy evaluated for anon needlessly | missing `TO` | add `to authenticated` |
| Repeated identical membership joins | inline EXISTS everywhere | `STABLE SECURITY DEFINER` helper |
| Recursive policy / infinite-ish plan | policy on A reads A | move check into a definer function that bypasses A's RLS |

> Summary intuition: treat every RLS predicate as a hot WHERE clause that runs for every row of
> every query — because that is exactly what it is. Index it, cache the auth scalar with
> `(select ...)`, and verify with `EXPLAIN`.

---

## 14. Testing Policies: Impersonation and CI

RLS is security-critical code and must be tested like any other security control. The test must
run *as the actual roles*, because the whole point of a policy is that it behaves differently for
different users.

**Local impersonation in psql / SQL editor.** Simulate a request's role and JWT by setting the
role and the `request.jwt.claims` GUC, the same mechanism PostgREST uses:

```sql
-- Simulate an authenticated user with a specific uid.
begin;
  set local role authenticated;
  set local request.jwt.claims to
    '{"sub":"9f6c2b3a-1d4e-4f8a-9c2d-7e1b3a5f8c0d","role":"authenticated"}';

  -- Now queries run exactly as this user would experience them:
  select * from public."Conversation";   -- only their rows return
  insert into public."Conversation" (id, "userId", slug, "createdAt")
    values (gen_random_uuid(), '9f6c2b3a-1d4e-4f8a-9c2d-7e1b3a5f8c0d', 'test-slug', now());
rollback;  -- never commit test mutations

-- Simulate anon (logged-out visitor):
begin;
  set local role anon;
  set local request.jwt.claims to '';
  select * from public."Conversation";   -- should return nothing (no anon SELECT policy)
rollback;
```

**Automated tests with pgTAP.** Supabase's recommended approach for policy regression tests is
`pgTAP`, run via `supabase test db`. Assert that a given role can/cannot see/modify given rows:

```sql
-- supabase/tests/rls_conversations.test.sql
begin;
select plan(3);

-- Seed (as privileged migration role, RLS-bypassing for setup):
-- insert a user and two conversations...

-- Scenario 1: user A cannot read user B's conversations.
set local role authenticated;
set local request.jwt.claims to '{"sub":"user-a-uuid","role":"authenticated"}';
select results_eq(
  'select count(*)::int from public."Conversation" where "userId" = ''user-b-uuid''',
  array[0],
  'user A cannot read user B conversations'
);

-- Scenario 2: user A reads exactly their own conversations.
select results_eq(
  'select count(*)::int from public."Conversation" where "userId" = ''user-a-uuid''',
  array[2],
  'user A sees their own two conversations'
);

-- Scenario 3: forging a conversation for another user is rejected.
select throws_ok(
  $$ insert into public."Conversation" (id, "userId", slug, "createdAt")
     values (gen_random_uuid(), 'user-b-uuid', 'forge', now()) $$,
  '42501',   -- insufficient_privilege / RLS WITH CHECK violation
  NULL,
  'user A cannot forge a conversation for user B'
);

select * from finish();
rollback;
```

**Black-box tests through supabase-js against the local stack** (`supabase start`). These catch
PostgREST-level issues (embeds, RPC, error codes) that pure SQL tests miss:

```ts
// integration test against local Supabase.
import { createClient } from '@supabase/supabase-js'
import { expect, test } from 'bun:test'  // Lumina uses bun:test

const url = process.env.SUPABASE_URL!        // http://127.0.0.1:54321 locally
const anon = process.env.SUPABASE_ANON_KEY!

test('user cannot read another user\'s conversations', async () => {
  const supabase = createClient(url, anon)
  await supabase.auth.signInWithPassword({
    email: 'user-a@test.dev',
    password: 'password123',
  })

  // RLS policy: USING ( "userId" = (select auth.uid()) )
  // Querying user B's conversations by their userId returns empty, NOT an error.
  const { data, error } = await supabase
    .from('Conversation')
    .select('id, title')
    .eq('userId', 'user-b-uuid')   // different user

  expect(error).toBeNull()          // silent filter, not an error
  expect(data).toHaveLength(0)      // invisible
})

test('forging a gmail_connection for another user is rejected', async () => {
  const supabase = createClient(url, anon)
  await supabase.auth.signInWithPassword({
    email: 'attacker@test.dev',
    password: 'password123',
  })

  const { error } = await supabase
    .from('gmail_connection')
    .insert({ userId: 'some-other-users-uuid', googleEmail: 'victim@gmail.com',
              refreshTokenEnc: 'x', iv: 'y', authTag: 'z', scopes: 'gmail.send' })

  // No INSERT policy on gmail_connection for authenticated => denied.
  expect(error).not.toBeNull()
  expect(error?.code).toBe('42501')
})
```

Run these in CI on every PR. A policy change with no test is a security change with no review.

---

## 15. Lumina's Actual Auth Architecture and When RLS Becomes Mandatory

**Lumina today does not expose any table directly to the anon key for data queries.** This is a
critical context for applying this reference:

Looking at `backend/client.ts:1-21` — the `createSupabaseClient()` function is used **only** for
`auth.getUser(token)` (JWT validation in `backend/auth.ts`). It never issues data queries. All
data access flows through **Prisma** with a `DATABASE_URL` direct Postgres connection — which is
equivalent to service_role-level access (RLS bypassed because it is a privileged direct
connection, not a PostgREST/anon-key connection).

The authorization boundary in Lumina today is the **Express middleware** (`backend/auth.ts`):

```
Browser → Express backend → Supabase auth.getUser() (JWT validation)
                          → Prisma (direct Postgres, privileged)
                          ↑
                   auth middleware sets req.userId
                   every route trusts req.userId
```

This is the classic three-tier model. RLS is not in the data path. The consequence:

> **RLS on Lumina's tables is not currently enforced** because no client query reaches Postgres
> through the anon/authenticated Postgres role. This is *not* a vulnerability *in the current
> architecture* — but it *would* become one the moment any table is exposed directly.

**RLS becomes mandatory for Lumina in any of these scenarios:**

1. **A Realtime subscription** from the frontend (e.g., streaming new messages into the chat UI).
   Realtime channels run as `authenticated` (the user's JWT), not as the Express backend. Any
   table subscribed to without an RLS policy is fully readable by all subscribers.

2. **Direct supabase-js data queries from the frontend** (e.g., reading conversation history
   directly without going through the Express API). Without RLS, every user can see every
   conversation.

3. **Storage uploads** (e.g., user file uploads for the Health connector). Supabase Storage
   objects are protected by Storage RLS policies, not table RLS, but the same principle applies.

4. **A future mobile companion** that uses supabase-js directly.

**What to do when adding a direct-access surface:**

```sql
-- Step 1: Enable RLS on the table BEFORE any direct access is granted.
alter table public."Conversation" enable row level security;

-- Step 2: Write per-command policies for every command the client needs.
create policy "owner reads own conversations"
on public."Conversation" for select to authenticated
using ( "userId" = (select auth.uid()) );

-- Step 3: Index the predicate columns.
create index if not exists conv_userid_idx on public."Conversation" ("userId");

-- Step 4: Test with the impersonation technique (section 14) before shipping.
```

**The pgvector warning.** `backend/prisma/schema.prisma:17-22` includes a comment warning against
using Prisma's `extensions = [vector]` because on Supabase it causes `prisma migrate dev` to flag
Supabase's pre-installed extensions as drift and threaten a destructive reset. The same logic
applies to RLS: **do not let Prisma manage RLS policies** (Prisma cannot express them; trying to
do so via raw SQL in `prisma/migrations` is fine, but the schema model does not know about them).
Manage RLS in Supabase migrations (`supabase migration new`) separately from Prisma migrations.

**Two-migration workflow:**

```
backend/prisma/migrations/   ← Prisma manages: table shapes, indexes, FKs, enums
supabase/migrations/         ← Supabase CLI manages: RLS policies, triggers,
                               definer functions, extensions
```

This separation keeps `prisma migrate dev` and `supabase db push` from interfering with each
other.

---

## 16. Anti-Patterns

**Shipping the service_role key to a client.**
The anon key is the only key a client ever holds. The service_role key lives in server-only
secrets and never crosses to the client. Audit your bundle for `service_role`.

**Treating "RLS enabled" as "secure."**
Enabling RLS with no policies makes the table default-deny — inaccessible, not "secured with
sensible defaults." Conversely, writing policies while RLS is *disabled* does nothing. Both halves
are required: `enable row level security` + at least one explicit policy. Verify with the
dashboard's Security Advisor.

**Forgetting `WITH CHECK` on writes.**
An INSERT policy with only `USING` is a bug — `USING` is not even evaluated for INSERT. A user
can insert rows stamped with someone else's `user_id`. Every INSERT policy needs `with check`.
Every UPDATE policy that should constrain the resulting row needs an explicit `with check`.

**Bare `auth.uid()` in policy predicates.**
`using (user_id = auth.uid())` may evaluate the function per row — documented 100x+ slowdowns.
Always `using (user_id = (select auth.uid()))`. Same for `(select auth.jwt() ->> '...')`.

**Authorization decisions based on `user_metadata`.**
`user_metadata` (`raw_user_meta_data`) is user-editable. A user can set their own role to
`admin` and a policy trusting it will believe them. Authorization-relevant claims live in
`app_metadata` (server-only) or in a table the client cannot write.

**Unqualified `SECURITY DEFINER` functions with a mutable search_path.**
`set search_path = ''` on every definer function. Fully qualify every identifier. Re-implement
the authorization the function bypasses. Lock down `EXECUTE`. The database linter will flag
violations; treat them as errors.

**Views that silently bypass RLS.**
A view without `security_invoker = true` runs as the view's owner, often a privileged role,
bypassing the underlying tables' policies. On PG15+: `create view ... with (security_invoker = true) as ...`

**Enforcing external invariants in RLS.**
RLS sees only row data, not external facts (completed OAuth flow, payment verified, email
confirmed). Gate those writes behind server code with service_role. RLS handles
ownership-based visibility; server code handles external invariants.

**Assuming empty read result means "no row."**
RLS filters reads to empty without an error. `data.length === 0` is ambiguous — no row, or no
permission. Always check `error`. Design UX around the ambiguity. Never use `getSession()` for
server-side authorization (it does not verify the signature).

**`FOR ALL` policies as the default.**
`FOR ALL` overloads a single predicate across four commands with subtle defaults (its `USING` does
not apply to INSERT). Prefer explicit per-command policies. Reserve `FOR ALL` for cases where the
logic genuinely is identical for all commands.

**Missing the `TO` clause.**
Policies with no `to` clause default to `public` (all roles). Add `to authenticated`, `to anon`,
or both, matching the audience exactly — for correctness and performance.

**Unindexed RLS predicate columns.**
Index every column referenced in a policy predicate, and both sides of any `EXISTS` membership
join. Verify with `EXPLAIN (ANALYZE, BUFFERS)` run as the impersonated role. A policy is a WHERE
clause; it obeys the same index rules as any other filter.

**Forgetting to invalidate client cache after a permission change.**
For security-sensitive revocations, store the authoritative role in a table (not just the JWT
claim). On sign-out, clear TanStack Query's cache (`queryClient.clear()`) so one user's
RLS-filtered data is not shown to the next user who signs in on the same browser.

---

## 17. References

- Supabase — Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase — RLS performance and best practices (the `(select auth.uid())` InitPlan guidance): https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices
- Supabase — Auth helper functions (`auth.uid()`, `auth.jwt()`): https://supabase.com/docs/guides/database/postgres/row-level-security#authuid-and-authjwt
- Supabase — Custom Claims and Role-Based Access Control (`app_metadata`, Auth Hooks): https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac
- Supabase — API keys (anon vs service_role; the anon key is public): https://supabase.com/docs/guides/api/api-keys
- Supabase — Hardening the Data API and `SECURITY DEFINER` / search_path: https://supabase.com/docs/guides/database/hardening-data-api
- Supabase — Testing RLS with pgTAP: https://supabase.com/docs/guides/local-development/testing/pgtap-extended
- Supabase — supabase-js reference: https://supabase.com/docs/reference/javascript/introduction
- PostgreSQL — Row Security Policies (`USING`, `WITH CHECK`, PERMISSIVE/RESTRICTIVE): https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL — `CREATE POLICY`: https://www.postgresql.org/docs/current/sql-createpolicy.html
- PostgreSQL — `CREATE FUNCTION` (`SECURITY DEFINER`, `SET search_path`): https://www.postgresql.org/docs/current/sql-createfunction.html
- PostgreSQL — `CREATE VIEW` (`security_invoker`, PG15+): https://www.postgresql.org/docs/current/sql-createview.html
- PostgREST — JWT roles, `request.jwt.claims`, and role selection: https://postgrest.org/en/stable/references/auth.html
- OWASP — Broken Object Level Authorization (the class RLS structurally mitigates): https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/

---

## See also

**Sibling references in the `supabase` skill:**
- `theory-auth-and-sessions.md` — JWT lifecycle, `getClaims` vs `getUser` vs `getSession`, PKCE,
  session storage on web vs native.
- `theory-data-model-and-postgrest.md` — how tables and views are exposed and queried via
  PostgREST; query builder depth.
- `guide-database-functions-triggers-rpc.md` — RPC, triggers, Auth Hooks (Custom Access Token
  Hook for injecting `app_metadata` claims at mint time).
- `guide-cli-migrations-and-local-dev.md` — migrations, local stack (`supabase start`), generated
  types, `supabase test db`.
- `guide-storage-and-edge-functions.md` — Storage RLS, signed URLs, Deno Edge Functions with
  service_role.

**Other Lumina skills:**
- `prisma` — Prisma 7 with Supabase Postgres, `@prisma/adapter-pg`, raw queries for pgvector,
  the two-migration-system boundary.
- `rag-retrieval` — the `cached_query` table's `vector(1536)` column accessed via `$queryRaw`;
  how the semantic cache interacts with Supabase Postgres.
- `connectors-oauth` — Gmail OAuth token vault, the `gmail_connection` table, how the OAuth
  callback writes the connection row server-side (the pattern that makes the no-INSERT-policy
  design correct).
- `backend-testing` — `backend/tests/helpers/supabase-fake.ts`, mocking the Supabase auth
  client in unit tests without a live Supabase instance.
- `lumina-frontend` — TanStack Query cache invalidation on sign-out, the `supabase.auth`
  session lifecycle on the client side.
