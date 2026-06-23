# Postgres Functions, Triggers & RPC — Supabase Reference

> Server-side logic that lives in the database: writing `plpgsql`/`sql` functions, wiring triggers (`handle_new_user`, `updated_at`), calling them from `supabase-js` via `rpc()`, and using `SECURITY DEFINER` safely under Row Level Security — with a Lumina-specific note on Prisma migration co-existence.

---

## Table of Contents

1. [Why Put Logic in the Database?](#1-why-put-logic-in-the-database)
2. [Function Anatomy: `LANGUAGE sql` vs `plpgsql`](#2-function-anatomy-language-sql-vs-plpgsql)
3. [Parameters, Defaults, and Named Arguments](#3-parameters-defaults-and-named-arguments)
4. [Return Types: scalar, `SETOF`, `RETURNS TABLE`, `jsonb`, void](#4-return-types-scalar-setof-returns-table-jsonb-void)
5. [`SECURITY DEFINER` vs `SECURITY INVOKER`: the privilege model](#5-security-definer-vs-security-invoker-the-privilege-model)
6. [Pinning `search_path` and Schema-Qualifying Everything](#6-pinning-search_path-and-schema-qualifying-everything)
7. [Volatility, Parallel Safety, and the Planner](#7-volatility-parallel-safety-and-the-planner)
8. [Triggers: BEFORE/AFTER, ROW/STATEMENT, `NEW`/`OLD`](#8-triggers-beforeafter-rowstatement-newold)
9. [The `handle_new_user` Trigger: `auth.users` → `public` table](#9-the-handle_new_user-trigger-authusers--public-table)
10. [`updated_at` Automation: `moddatetime` vs a custom trigger](#10-updated_at-automation-moddatetime-vs-a-custom-trigger)
11. [Lumina Note: Prisma Owns the Schema — Avoiding Migration Drift](#11-lumina-note-prisma-owns-the-schema--avoiding-migration-drift)
12. [Calling Functions via `supabase.rpc()`](#12-calling-functions-via-supabaserpc)
13. [Typing RPC Returns with the Generated `Database` Type](#13-typing-rpc-returns-with-the-generated-database-type)
14. [Error Handling: `RAISE`, SQLSTATE codes, and `{ data, error }`](#14-error-handling-raise-sqlstate-codes-and--data-error-)
15. [Atomic Multi-Step Writes: replacing the client transaction](#15-atomic-multi-step-writes-replacing-the-client-transaction)
16. [Exposing vs Hiding Functions from the API; `GRANT EXECUTE`](#16-exposing-vs-hiding-functions-from-the-api-grant-execute)
17. [Migrations: authoring functions and triggers in versioned SQL](#17-migrations-authoring-functions-and-triggers-in-versioned-sql)
18. [TanStack Query + RPC: mutations and cache invalidation](#18-tanstack-query--rpc-mutations-and-cache-invalidation)
19. [Worked Example: atomic save-conversation RPC](#19-worked-example-atomic-save-conversation-rpc)
20. [Anti-Patterns](#20-anti-patterns)
21. [See Also](#21-see-also)

---

## 1. Why Put Logic in the Database?

Supabase exposes Postgres directly to clients through PostgREST (the auto-generated REST API) and `supabase-js`. In Lumina, **Prisma is the primary DB client for the backend** — the Supabase JS SDK is used only for `auth.getUser(token)` (see `backend/client.ts:9-20`). But a small, important class of work belongs in **Postgres functions** and **triggers**:

| Driver | Why a function wins |
|---|---|
| **Atomicity** | A function body runs in a single implicit transaction. Multiple writes either all commit or all roll back. `supabase-js` has no `BEGIN`/`COMMIT`; Prisma has `$transaction()`, but a DB function runs even closer to the data. |
| **Round-trip reduction** | One `rpc()` call (or `$queryRaw` call) replaces 3–5 sequential queries, each with its own network round-trip. |
| **Invariant enforcement** | Logic that *must* run (decrement a counter, append an audit row) cannot be skipped by a buggy caller that forgets a step. |
| **Privilege elevation** | A `SECURITY DEFINER` function can perform a controlled write that the caller's RLS policy forbids — the canonical case is `handle_new_user`. |
| **Trigger-driven automation** | `updated_at` stamping, sync-to-public-profile on signup, audit logs — events the application layer should never have to remember to call. |

Push logic the *other* way — into Express routes, Prisma transactions, or Edge Functions — when it needs network I/O (call an LLM, hit Tavily, send a webhook), heavy CPU, or libraries Postgres lacks. Functions are for **data integrity and set-based work**.

Authorization remains **Row Level Security**. Functions do not replace RLS — `SECURITY INVOKER` functions run *under* the caller's RLS, and `SECURITY DEFINER` functions deliberately bypass it for a narrow, audited purpose.

---

## 2. Function Anatomy: `LANGUAGE sql` vs `plpgsql`

Postgres ships two languages you'll use constantly. Pick the simpler one that does the job.

### `LANGUAGE sql` — a parameterized query

A `sql` function is one or more SQL statements with parameters substituted. The planner can **inline** it into the calling query, so for simple lookups it is faster and lets the optimizer see through it.

```sql
-- Pure read. Inlinable, no procedural logic needed.
create or replace function public.active_conversations_for_user(p_user_id text)
returns table (id text, title text, slug text, created_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select id, title, slug, "createdAt"
    from public."Conversation"
   where "userId" = p_user_id
   order by "createdAt" desc;
$$;
```

Postgres 14+ also supports the **standard SQL body** syntax (parsed and validated at creation time):

```sql
create or replace function public.conversation_count(p_user_id text)
returns bigint
language sql
stable
begin atomic
  select count(*) from public."Conversation" where "userId" = p_user_id;
end;
```

`begin atomic` bodies are validated at `CREATE` time and track dependencies — dropping a referenced table is blocked. Prefer them for pure `sql` functions when you don't need `plpgsql`.

### `LANGUAGE plpgsql` — procedural logic

Reach for `plpgsql` when you need variables, conditionals, loops, exception handling, or multiple dependent statements. It is **not** inlinable; the body is a black box to the planner.

```sql
create or replace function public.rotate_conversation_slug(p_conversation_id text, p_new_slug text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_final_slug text;
begin
  -- Ensure uniqueness by appending a suffix when there is a collision.
  v_final_slug := p_new_slug;

  if exists (
    select 1 from public."Conversation"
     where slug = v_final_slug and id <> p_conversation_id
  ) then
    v_final_slug := p_new_slug || '-' || substring(p_conversation_id, 1, 8);
  end if;

  update public."Conversation"
     set slug = v_final_slug
   where id = p_conversation_id;

  if not found then
    raise exception 'Conversation % not found', p_conversation_id
      using errcode = 'no_data_found';
  end if;

  return v_final_slug;
end;
$$;
```

### Decision table

| Need | Language | Notes |
|---|---|---|
| Single `SELECT`/`INSERT`/`UPDATE`, no control flow | `sql` | Inlinable; use `begin atomic` |
| Conditionals, loops, local variables | `plpgsql` | Procedural |
| `RAISE` custom errors / validate then write | `plpgsql` | Need `begin … exception` block |
| Catch and handle exceptions | `plpgsql` | `exception when … then` |
| Trigger function | `plpgsql` | Must return `trigger`; `sql` cannot |
| Dynamic SQL (`EXECUTE format(...)`) | `plpgsql` | Quote identifiers with `%I`, literals with `%L` |

> **Trigger functions are always `plpgsql`** (or another procedural PL). A `LANGUAGE sql` function cannot return the `trigger` pseudo-type.

---

## 3. Parameters, Defaults, and Named Arguments

Parameters have a name, type, mode (`IN` default, `OUT`, `INOUT`, `VARIADIC`), and optional default. **PostgREST exposes the parameter names as the JSON keys of the RPC body**, so name them as the contract your client will use.

```sql
create or replace function public.search_conversations(
  p_user_id    text,
  p_term       text    default '',
  p_page_size  int     default 20,
  p_offset     int     default 0
)
returns table (id text, title text, slug text, created_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select id, title, slug, "createdAt"
    from public."Conversation"
   where "userId" = p_user_id
     and (p_term = '' or title ilike '%' || p_term || '%')
   order by "createdAt" desc
   limit p_page_size offset p_offset;
$$;
```

Notes that bite people:

- **Qualify ambiguous names.** When a parameter name (`title`) collides with a column name (`title`), qualify with the function name (`search_conversations.p_term`) or use the `p_` prefix. The prefix convention is the clean answer.
- **Defaults make args optional from JS.** Any parameter with a default can be omitted in the `rpc()` call's argument object.
- **`OUT`/`INOUT` parameters** define the return shape *instead of* `RETURNS`. Useful for returning a couple of scalars without defining a composite type.
- **Argument coercion via JSON.** PostgREST coerces the JSON body to the declared parameter types. Pass JS `Date` as ISO strings, numbers as numbers; arrays map to Postgres arrays, objects to `jsonb`.

From the client:

```ts
const { data, error } = await supabase.rpc('search_conversations', {
  p_user_id: userId,
  p_term: 'finance',
  p_page_size: 15,
})
```

---

## 4. Return Types: scalar, `SETOF`, `RETURNS TABLE`, `jsonb`, void

What you `RETURN` determines the shape of `data` in `supabase-js`.

| SQL return type | `data` shape in JS | When |
|---|---|---|
| `returns int` / `text` / `boolean` / `uuid` | the scalar value | single computed value |
| `returns void` | `null` | side-effect only |
| `returns table_name` (a row type) | single object | one full row |
| `returns setof table_name` | array of objects | many rows of an existing table/view |
| `returns table(...)` | array of objects | ad-hoc column set (aggregations, joins) |
| `returns json` / `jsonb` | the parsed JSON value | nested/aggregated payload |

### `RETURNS TABLE` — explicit ad-hoc columns

```sql
create or replace function public.conversation_stats(p_user_id text)
returns table (
  total_conversations bigint,
  total_messages      bigint,
  last_active         timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(distinct c.id),
    count(m.id),
    max(m."createdId")
  from public."Conversation" c
  left join public."Message" m on m."conversationId" = c.id
  where c."userId" = p_user_id;
$$;
```

`RETURNS TABLE(...)` is sugar for a set of `OUT` parameters plus `SETOF`. The column names become object keys in `data`.

### Returning aggregated JSON

To return a nested document (a conversation with its messages) in one call, build `jsonb` server-side:

```sql
create or replace function public.conversation_with_messages(p_conversation_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'conversation', to_jsonb(c.*),
    'messages', coalesce(
      (select jsonb_agg(to_jsonb(m.*) order by m."createdId")
         from public."Message" m
        where m."conversationId" = p_conversation_id),
      '[]'::jsonb)
  )
  from public."Conversation" c
  where c.id = p_conversation_id;
$$;
```

`data` is the parsed object. The generator types `jsonb` as the opaque `Json` — validate with Zod at the boundary (see §13).

---

## 5. `SECURITY DEFINER` vs `SECURITY INVOKER`: the privilege model

Every function runs with one of two privilege contexts:

| | `SECURITY INVOKER` (default) | `SECURITY DEFINER` |
|---|---|---|
| Runs as | the **calling** role (`anon` / `authenticated`) | the role that **owns** the function (usually `postgres`) |
| RLS applied | yes — caller's policies, including `auth.uid()` | the owner's context; **owner typically bypasses RLS** |
| `auth.uid()` / `auth.jwt()` | resolves the caller's JWT claims | still resolves the caller's claims (request GUCs are set per-request, independent of role) |
| Default | yes | must be explicit |
| Risk | low | high — privilege escalation if misused |

**Default to `SECURITY INVOKER`.** The function acts on behalf of the user, RLS guards every table touched, and `auth.uid()` identifies the caller.

Use `SECURITY DEFINER` **only** when the function must perform an action the caller is not directly permitted to do, and you can prove the action is safe and narrow. Canonical justified cases:

1. **The `handle_new_user` trigger** — it inserts into a public mirror table triggered by an `auth.users` insert. The triggering "actor" is the auth system, not an authenticated client, and the insert must succeed regardless of any RLS policy on the target table. See §9.
2. **RLS helper functions used *inside* policies** (e.g. `is_team_member(team_id)`) that must read a membership table the caller can't `SELECT` directly. Definer breaks the recursion.
3. **Cross-table writes a user may initiate but not perform piecemeal.** A function that atomically inserts a `Message` and bumps a `Conversation.updatedAt` — where students can't update the conversation row directly — justifies a narrow `SECURITY DEFINER`.

The discipline that makes `SECURITY DEFINER` safe:

- **Validate authorization yourself inside the function.** Because RLS no longer guards you, explicitly check `auth.uid()` against the rows you touch — otherwise you've built an open door.
- **Pin `search_path = ''`** (§6). This is **mandatory** for definer functions — without it you are exposed to search-path hijacking.
- **Keep the body minimal.** The smaller the elevated surface, the smaller the audit.
- **Grant `EXECUTE` narrowly** (§16) — don't expose a powerful definer function to `anon`.

```sql
-- SECURITY DEFINER helper used inside an RLS policy. Elevates ONLY to read team membership.
create or replace function public.is_team_member(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''          -- MANDATORY for any definer function
as $$
  select exists (
    select 1
      from public.team_members m
     where m.team_id  = target_team_id
       and m.user_id  = (select auth.uid())   -- authorize against the CALLER's identity
  );
$$;
```

---

## 6. Pinning `search_path` and Schema-Qualifying Everything

The `search_path` is the ordered list of schemas Postgres scans to resolve unqualified names. A `SECURITY DEFINER` function that resolves names through a mutable `search_path` is exploitable: an attacker who can create objects in a schema earlier on the path can shadow a function or table your definer body calls, and that malicious object then runs **with the owner's elevated privileges**. This is the classic *search-path hijacking* attack, documented in the Postgres manual under "Writing SECURITY DEFINER Functions Safely."

### The two-part defense (do both)

1. **Pin the path** with `set search_path = ''` in the function definition. The empty string means "no schemas are searched implicitly" — every name must be qualified or it errors.
2. **Schema-qualify every object reference** in the body: `public."Conversation"`, `auth.uid()`. With `search_path = ''`, an unqualified name is an error, which is exactly the safety you want.

```sql
create or replace function public.delete_my_conversations()
returns void
language plpgsql
security definer
set search_path = ''                 -- pinned
as $$
begin
  delete from public."Message"
    where "conversationId" in (
      select id from public."Conversation"
       where "userId" = (select auth.uid())   -- qualified; auth.uid() evaluated per-call
    );

  delete from public."Conversation"
    where "userId" = (select auth.uid());
end;
$$;
```

> **Supabase's database linter flags this.** The `function_search_path_mutable` advisor warns on any function without a pinned `search_path`. Treat it as an error in CI. The Supabase dashboard's Advisors tab surfaces it.

`set search_path = ''` vs `set search_path = pg_catalog, public`: empty string is the strongest (forces full qualification, no surprises). Use `''` for all new code.

### Should `SECURITY INVOKER` functions pin too?

Yes. It costs nothing and protects against the function behaving differently based on a caller's session `search_path`. Make `set search_path = ''` a non-negotiable on **every** function you write.

---

## 7. Volatility, Parallel Safety, and the Planner

Declaring volatility correctly is a correctness *and* performance issue.

| Marker | Meaning | Use for |
|---|---|---|
| `IMMUTABLE` | Same args ⇒ same result, forever; no DB access | pure computation (math, `lower(text)`). Allowed in indexes. |
| `STABLE` | Same args ⇒ same result *within a single statement*; may read DB | read-only functions, RLS helpers, `auth.uid()` checks |
| `VOLATILE` (default) | May return different results each call; may write | any function that `INSERT`/`UPDATE`/`DELETE`s |

Getting this wrong:

- Marking a function that writes as `STABLE`/`IMMUTABLE` can cause the planner to call it the wrong number of times or cache a stale result → **silent data corruption**.
- Marking a pure read as `VOLATILE` (the default) blocks inlining and forces re-execution → **slow**, and cannot be used in indexes.

`auth.uid()` is itself `STABLE`. Wrapping it in a subquery `(select auth.uid())` inside RLS policies lets the planner evaluate it once per query (an `InitPlan`) rather than once per row — a significant optimization on large tables.

`PARALLEL SAFE | RESTRICTED | UNSAFE`: a read-only `STABLE`/`IMMUTABLE` function that touches no session state can be `parallel safe`, letting it run in parallel workers. Anything that writes or reads session/temp state is `parallel unsafe` (the default for `VOLATILE`).

```sql
create or replace function public.message_count_for_conversation(p_conversation_id text)
returns bigint
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  select count(*) from public."Message"
   where "conversationId" = p_conversation_id;
$$;
```

---

## 8. Triggers: BEFORE/AFTER, ROW/STATEMENT, `NEW`/`OLD`

A **trigger** binds a `plpgsql` trigger function to a table event. The function returns `trigger` and has access to special variables.

### Timing × level matrix

| | `FOR EACH ROW` | `FOR EACH STATEMENT` |
|---|---|---|
| `BEFORE` | Fires per affected row *before* the write. Can **modify `NEW`** and return it, or return `NULL` to **skip** that row. Use for: defaulting, normalization, validation, `updated_at`. | Per statement, before. Rarely used; can't see individual rows. |
| `AFTER` | Per row *after* the write commits to the row. `NEW`/`OLD` are read-only. Use for: cascading writes, notifications, denormalized counters. | Per statement, after. Good with transition tables for set-based auditing. |
| `INSTEAD OF` | On **views** only. Make a view writable. | n/a |

### Special variables

| Variable | Available in | Meaning |
|---|---|---|
| `NEW` | INSERT, UPDATE (row-level) | the incoming/updated row (writable in BEFORE) |
| `OLD` | UPDATE, DELETE (row-level) | the previous row |
| `TG_OP` | all | `'INSERT'` / `'UPDATE'` / `'DELETE'` / `'TRUNCATE'` |
| `TG_TABLE_NAME` | all | the table name |
| `TG_WHEN` / `TG_LEVEL` | all | `'BEFORE'`/`'AFTER'`, `'ROW'`/`'STATEMENT'` |

### Return-value rules (the part people get wrong)

- **BEFORE ROW**: return `NEW` to proceed (with any modifications), or `NULL` to silently skip the operation for that row.
- **AFTER ROW**: return value is **ignored** (conventionally `return null;`).
- A BEFORE trigger returning `NULL` cancels the row — useful for soft-filters, dangerous if accidental.

```sql
-- BEFORE INSERT: normalize title and generate slug before the row lands in the table.
create or replace function public.normalize_conversation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.title := trim(new.title);

  -- generate slug only when not explicitly provided
  if new.slug is null or new.slug = '' then
    new.slug := lower(regexp_replace(coalesce(new.title, ''), '\s+', '-', 'g'))
             || '-' || substring(new.id, 1, 8);
  end if;

  return new;    -- proceed with the (modified) row
end;
$$;

create trigger normalize_conversation_before_insert
  before insert on public."Conversation"
  for each row
  execute function public.normalize_conversation();
```

Scope a trigger with `WHEN (condition)` to skip the function entirely when it wouldn't fire:

```sql
create trigger bump_updated_at
  before update on public."Conversation"
  for each row
  when (old.* is distinct from new.*)    -- skip no-op updates
  execute function extensions.moddatetime(updated_at);
```

---

## 9. The `handle_new_user` Trigger: `auth.users` → `public` table

The most-used Supabase trigger pattern. Supabase Auth owns the `auth.users` table; your app needs a mirrored public row created instantly on every signup — including OAuth, magic-link, or admin-created users where there is no subsequent client write to rely on.

### How Lumina handles this today

Lumina's `backend/auth.ts:54-76` does **application-level provisioning** via Prisma:

```ts
// backend/auth.ts:54-76 (simplified)
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

This runs on the first authenticated request after signup and is idempotent (upsert). It works for Lumina's current flow where every signup is immediately followed by a request from the Lumina frontend.

A `handle_new_user` DB trigger would instead fire **at the moment of `auth.users` insert** — guaranteed, regardless of whether the app-layer request ever arrives. Consider migrating to a trigger if Lumina ever needs to:

- Support admin-created users that might never make a web request.
- Remove the `provisionedUsers` in-memory set from `auth.ts`.
- Guarantee the `public."User"` row exists before any other system can reference it.

### The canonical DB trigger pattern

```sql
-- 1. The trigger function: SECURITY DEFINER so it can insert into public."User"
--    regardless of any RLS INSERT policy on that table.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public."User" (id, email, name, provider, "supabaseId", "createdAt", "updatedAt")
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      new.email
    ),
    -- map OAuth provider to Lumina's AuthProvider enum
    case new.raw_app_meta_data ->> 'provider'
      when 'google' then 'Google'
      else 'Github'
    end,
    new.id,      -- supabaseId = auth.users.id
    now(),
    now()
  )
  on conflict (id) do nothing;   -- idempotent; safe to re-run
  return new;
exception
  when others then
    -- NEVER block signup: a profile hiccup must not prevent the user from registering.
    raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;

-- 2. AFTER INSERT on auth.users — AFTER so the FK from public."User".id is safe.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
```

Critical details:

- **`SECURITY DEFINER` is justified and required here** — the insert must succeed without an `authenticated` JWT.
- **`AFTER INSERT`, not BEFORE** — the FK from `public."User".id` to `auth.users(id)` requires the source row to already be persisted; AFTER is the safe choice.
- **`ON CONFLICT DO NOTHING`** — makes the function idempotent; safe to run against a pre-seeded DB.
- **Wrap in `exception when others then raise warning`** — an unhandled exception in this trigger **rolls back the signup**. Never let profile-creation errors block registration.
- **If you add this trigger**, remove the `provisionedUsers` provisioning block from `backend/auth.ts:53-77` to avoid double-work. The DB trigger always fires; the app-layer upsert becomes a no-op on conflict — harmless but redundant.

---

## 10. `updated_at` Automation: `moddatetime` vs a custom trigger

**Never trust the client to send `updated_at`** — a buggy or malicious caller will lie. Compute it in a BEFORE trigger. Prisma's `@updatedAt` directive (used on `User.updatedAt` and `GmailConnection.updatedAt` in `backend/prisma/schema.prisma:33,95`) handles this at the Prisma client layer, but a DB-level trigger provides a deeper guarantee (it fires even for raw SQL writes that bypass Prisma).

### Option A — the `moddatetime` extension (recommended)

```sql
-- Enable once (idempotent). Supabase convention: extensions in their own schema.
create extension if not exists moddatetime schema extensions;

-- Wire to any table that has an updated_at / "updatedAt" column:
create trigger handle_user_updated_at
  before update on public."User"
  for each row
  execute function extensions.moddatetime ("updatedAt");   -- arg = the column name (quoted if camelCase)
```

The column name is passed as a trigger argument — one line per table, no function to maintain. This is the idiomatic Supabase approach.

### Option B — a custom trigger function

Use this when you need extra logic alongside the timestamp bump.

```sql
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new."updatedAt" := now();
  return new;
end;
$$;

create trigger handle_gmail_connection_updated_at
  before update on public.gmail_connection
  for each row
  when (old.* is distinct from new.*)     -- skip no-op updates
  execute function public.set_updated_at();
```

### Comparison

| | `moddatetime` | Custom function |
|---|---|---|
| Setup | enable extension + 1 trigger/table | define function once + 1 trigger/table |
| Flexibility | sets one column to `now()` | any logic |
| Skip no-op updates | no built-in guard | add `when (old.* is distinct from new.*)` |
| Maintenance | none | you own it |

> `created_at` / `createdAt` is set once by the column `default now()` at INSERT and is immutable. A trigger should **never** touch it. If you want paranoid protection: add `new."createdAt" := old."createdAt";` in the update trigger to prevent reassignment.

---

## 11. Lumina Note: Prisma Owns the Schema — Avoiding Migration Drift

This is the most important Lumina-specific constraint for DB functions and triggers.

### The problem

Prisma's migration workflow (`prisma migrate dev`) compares the **declared schema** (`backend/prisma/schema.prisma`) against the **live DB state** and generates DDL to close the gap. If you add a trigger or function directly in the Supabase dashboard SQL editor without recording it in a migration, it becomes **drift** — Prisma knows nothing about it and might flag it or, in the worst case, create a migration that accidentally drops it.

The corollary noted in `backend/prisma/schema.prisma:19-21`:

> pgvector is enabled directly in Supabase (Dashboard → Database → Extensions). We deliberately do NOT let Prisma manage extensions — on Supabase that makes `prisma migrate dev` flag Supabase's own pre-installed extensions as "drift" and threaten a destructive reset.

The same logic applies to functions and triggers: Prisma's schema language has no `function` or `trigger` primitive. Prisma simply does not know they exist. That means:

- Prisma will **never** generate a migration to create or drop your functions/triggers.
- Prisma will **not** flag them as drift (they're invisible to it, unlike extensions managed in `schema.prisma`).
- But if you rely on the Supabase dashboard SQL editor for one-off SQL changes, they won't be captured in `prisma/migrations/` and will be lost when the DB is reset.

### The safe workflow: SQL migration files alongside Prisma migrations

Manage functions and triggers in plain `.sql` files that live next to (or inside) `prisma/migrations/`:

```
backend/
  prisma/
    migrations/
      20260609120000_initial/
        migration.sql          ← Prisma-generated table DDL
      20260615000000_handle_new_user/
        migration.sql          ← hand-authored; JUST the trigger + function
    schema.prisma
```

Alternatively, keep a `supabase/migrations/` directory alongside `backend/` and apply it with the Supabase CLI (`supabase db push`), independently of Prisma migrations. The two pipelines are orthogonal: Prisma owns tables/enums/extensions; Supabase CLI migrations own functions, triggers, RLS policies, and bespoke extensions.

### Prefer app-level logic (Prisma `$transaction`) when you can

For multi-step writes that only the backend performs (an authenticated Express route), Prisma's `$transaction()` is cleaner and keeps all logic in TypeScript where it's testable:

```ts
// backend/routes/conversations.ts (hypothetical)
const [conversation, firstMessage] = await prisma.$transaction([
  prisma.conversation.create({ data: { userId, title, slug } }),
  prisma.message.create({ data: { conversationId: '...', role: 'user', content: '...' } }),
])
```

Use a DB function instead when:

1. The operation must be accessible from multiple entry points (backend, a future mobile client calling `supabase.rpc()`, a cron script).
2. Correctness requires the DB-level row lock (`SELECT … FOR UPDATE`) that Prisma doesn't expose cleanly.
3. You're writing a trigger that must fire automatically.
4. The logic is truly set-based and a DB function expresses it more efficiently.

### Checklist before writing a DB function/trigger in Lumina

- [ ] Is this logic better expressed as a Prisma `$transaction()` in the Express route? If yes, do that instead.
- [ ] If a DB function is right, will I record it in a versioned SQL migration file (not just the dashboard)?
- [ ] Have I pinned `set search_path = ''` and schema-qualified every object name?
- [ ] For triggers: will this interact with Prisma's camelCase column names (e.g. `"createdAt"`, `"userId"`)? Postgres identifiers are case-insensitive unless quoted; Prisma's generator emits quoted names — match exactly.
- [ ] Does this function/trigger create drift Prisma would misinterpret? (Functions and triggers: no. Extensions managed via `schema.prisma`: yes — don't use `extensions = [...]`.)

---

## 12. Calling Functions via `supabase.rpc()`

`supabase.rpc(name, args, options)` maps to PostgREST's `POST /rest/v1/rpc/<name>`. The second argument is a plain object whose keys must match the function's **parameter names**.

In Lumina, `supabase-js` is used in the **frontend** (React/Vite) for operations that PostgREST can serve directly, and for edge cases where the backend wants to call a function via `supabase.rpc()` rather than `$queryRaw`. The backend Supabase client (`backend/client.ts`) is wired for auth only — for backend RPC use `prisma.$queryRaw` or a direct SQL call instead.

```ts
// frontend: src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!,
)

// Call a set-returning function -> data is an array
const { data, error } = await supabase.rpc('search_conversations', {
  p_user_id: userId,
  p_term: 'finance',
  p_page_size: 10,
})
if (error) {
  // supabase-js v2 NEVER throws on RPC/query errors — you MUST check `error`.
  console.error(error.code, error.message, error.details, error.hint)
  return
}
// data: { id: string; title: string; slug: string; created_at: string }[]
```

### `.rpc()` returns a query builder — chain on set-returning functions

When the function `returns setof` / `returns table`, the result is filterable/orderable like a table query:

```ts
const { data } = await supabase
  .rpc('search_conversations', { p_user_id: userId, p_term: 'finance' })
  .order('created_at', { ascending: false })
  .range(0, 9)
```

### Single-row helpers

```ts
// .single() errors if 0 or >1 rows; .maybeSingle() allows 0 rows.
const { data, error } = await supabase
  .rpc('conversation_with_messages', { p_conversation_id: id })
  .single()
```

### Read-only RPC with `get: true`

```ts
// Tells PostgREST this is a GET request (cacheable, args in querystring).
// Requires the function to be STABLE or IMMUTABLE.
const { data } = await supabase.rpc('conversation_count', { p_user_id: userId }, { get: true })
```

### Calling from the backend via `$queryRaw` (the Lumina pattern)

When the backend needs to call a Postgres function and the result is needed inside a Prisma transaction, use `$queryRaw` rather than the Supabase JS SDK client (which is wired for auth only):

```ts
// backend/routes/conversations.ts
import { prisma } from '../db.js'

const result = await prisma.$queryRaw<{ slug: string }[]>`
  SELECT public.rotate_conversation_slug(${conversationId}, ${newSlug})
`
```

---

## 13. Typing RPC Returns with the Generated `Database` Type

Generate the type from the live schema with the Supabase CLI:

```bash
# Against the linked remote project
supabase gen types typescript --project-id "$SUPABASE_PROJECT_ID" > src/lib/database.types.ts

# Or against a local Docker stack
supabase gen types typescript --local > src/lib/database.types.ts
```

The generator produces a `Database` interface with a `Functions` map. Passing it to `createClient<Database>` makes `rpc()` fully typed:

```ts
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!,
)
```

The generated shape (abridged):

```ts
export interface Database {
  public: {
    Tables: { /* ... */ }
    Functions: {
      search_conversations: {
        Args: {
          p_user_id: string
          p_term?: string
          p_page_size?: number
          p_offset?: number
        }
        Returns: { id: string; title: string; slug: string; created_at: string }[]
      }
      conversation_with_messages: {
        Args: { p_conversation_id: string }
        Returns: Json    // jsonb -> opaque Json
      }
    }
  }
}
```

### Typing `jsonb` returns precisely

The generator types `jsonb` as the opaque `Json`. Validate with Zod at the boundary — a TypeScript `as` cast is a compile-time lie with no runtime guarantee:

```ts
import { z } from 'zod'

const ConversationDetail = z.object({
  conversation: z.object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    slug: z.string(),
    userId: z.string(),
  }),
  messages: z.array(z.object({
    id: z.number(),
    content: z.string(),
    role: z.enum(['user', 'Assistant']),
    createdId: z.string(),
  })),
})
type ConversationDetail = z.infer<typeof ConversationDetail>

export async function getConversationDetail(id: string): Promise<ConversationDetail> {
  const { data, error } = await supabase
    .rpc('conversation_with_messages', { p_conversation_id: id })
    .single()
  if (error) throw error
  return ConversationDetail.parse(data)  // runtime guarantee, not just a cast
}
```

> **Regenerate types in CI after every migration.** A stale `database.types.ts` silently lies about function signatures.

---

## 14. Error Handling: `RAISE`, SQLSTATE codes, and `{ data, error }`

### The cardinal rule

`supabase-js` v2 **never throws** for query/RPC errors. It always resolves to `{ data, error }`. You **must** check `error`. (It *will* throw for network failures / fetch rejections — wrap in `try/catch` only for that.)

```ts
const { data, error } = await supabase.rpc('enroll_in_something', { p_id })
if (error) {
  // error: { message, code, details, hint }
  // code is the Postgres SQLSTATE or a PGRST* PostgREST code
  switch (error.code) {
    case 'P0001':   // bare RAISE EXCEPTION (your custom errors)
      break
    case '23505':   // unique_violation -> duplicate key
      break
    case 'P0002':   // no_data_found -> SELECT INTO STRICT found nothing
      break
    case 'PGRST116': // .single() got 0 rows
      break
    default:
      console.error(error)
  }
  return
}
```

### Raising meaningful errors from `plpgsql`

`RAISE EXCEPTION` aborts the function (and its implicit transaction → rollback). Attach a SQLSTATE so the client can branch programmatically:

```sql
create or replace function public.add_message_to_conversation(
  p_conversation_id text,
  p_role            text,
  p_content         text
)
returns public."Message"
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_result public."Message";
begin
  -- Verify the conversation belongs to the calling user.
  if not exists (
    select 1 from public."Conversation"
     where id = p_conversation_id and "userId" = v_user::text
  ) then
    raise exception 'Conversation not found or access denied'
      using errcode = 'P0001',
            detail  = format('conversation_id=%s', p_conversation_id),
            hint    = 'Only the owner may add messages.';
  end if;

  insert into public."Message" (content, role, "conversationId")
  values (p_content, p_role::public."MessageRole", p_conversation_id)
  returning * into v_result;

  return v_result;
end;
$$;
```

### SQLSTATE cheat-sheet

| SQLSTATE | Condition name | Typical cause |
|---|---|---|
| `P0001` | `raise_exception` | bare `RAISE EXCEPTION` with no explicit code |
| `P0002` | `no_data_found` | `SELECT … INTO … STRICT` found nothing |
| `23505` | `unique_violation` | duplicate key |
| `23503` | `foreign_key_violation` | FK target missing |
| `23514` | `check_violation` | CHECK constraint failed |
| `42501` | `insufficient_privilege` | EXECUTE/RLS denied (often surfaces as PGRST) |

PostgREST also returns its own `PGRST*` codes (e.g. `PGRST116` "no rows for `.single()`", `PGRST301` JWT expired). Branch on both families.

### A reusable typed wrapper

```ts
// src/lib/rpc.ts
export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: string,
    public hint?: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export async function callRpc<T>(
  fn: () => PromiseLike<{
    data: T | null
    error: { code?: string; message: string; details?: string; hint?: string } | null
  }>,
): Promise<T> {
  const { data, error } = await fn()
  if (error) throw new RpcError(error.code ?? 'UNKNOWN', error.message, error.details, error.hint)
  if (data === null) throw new RpcError('NO_DATA', 'RPC returned no data')
  return data
}

// usage
const detail = await callRpc(() =>
  supabase.rpc('conversation_with_messages', { p_conversation_id: id }).single()
)
```

---

## 15. Atomic Multi-Step Writes: replacing the client transaction

`supabase-js` cannot open a Postgres transaction. You **cannot** do this safely from the browser:

```ts
// BROKEN: three independent network calls, NOT atomic.
await supabase.from('Conversation').insert({ userId, title, slug })   // commits
await supabase.from('Message').insert({ conversationId, role, content }) // separate commit
// If the 2nd fails, the 1st already committed -> a conversation with no initial message.
```

Every Postgres function body **is a transaction**. Move the steps in:

```sql
create or replace function public.create_conversation_with_message(
  p_user_id         text,
  p_title           text,
  p_slug            text,
  p_first_message   text
)
returns jsonb
language plpgsql
security definer                  -- needs to INSERT despite RLS INSERT policy absence
set search_path = ''
as $$
declare
  v_caller text := (select auth.uid())::text;
  v_conv_id text;
begin
  -- Authorization: definer bypasses RLS, so check identity explicitly.
  if v_caller is null or v_caller <> p_user_id then
    raise exception 'Caller mismatch' using errcode = 'P0001';
  end if;

  -- Insert conversation.
  insert into public."Conversation" (id, "userId", title, slug, "createdAt")
  values (gen_random_uuid()::text, p_user_id, p_title, p_slug, now())
  returning id into v_conv_id;

  -- Insert the first message atomically.
  insert into public."Message" (content, role, "conversationId", "createdId")
  values (p_first_message, 'user', v_conv_id, now());

  return jsonb_build_object('conversationId', v_conv_id);
end;
$$;

revoke execute on function public.create_conversation_with_message(text,text,text,text) from public, anon;
grant  execute on function public.create_conversation_with_message(text,text,text,text) to authenticated;
```

### Locking strategies inside functions

| Technique | Use for | Notes |
|---|---|---|
| `SELECT … FOR UPDATE` | mutate a counter on a specific row | row lock; concurrent callers queue |
| `SELECT … FOR UPDATE SKIP LOCKED` | job-queue pickup | skip rows another tx holds |
| `INSERT … ON CONFLICT DO NOTHING/UPDATE` | idempotent upserts | avoids read-then-write race |

### When NOT to push into a function

If a step requires external I/O (call the Vercel AI SDK, hit Tavily, send a webhook), that **cannot** be inside a DB transaction — Postgres can't call HTTP transactionally. Pattern: do the DB-atomic part in a Prisma `$transaction()` (or an RPC), do the external call in the Express route after the transaction commits, and design for eventual consistency.

---

## 16. Exposing vs Hiding Functions from the API; `GRANT EXECUTE`

PostgREST exposes functions in the **`public` schema** over `/rpc/<name>` — subject to `EXECUTE` privileges.

### How a function becomes callable from the browser

1. It lives in an exposed schema (default: `public`).
2. The relevant API role has `EXECUTE`: `anon` (unauthenticated) or `authenticated` (logged-in users).

By default, **Postgres grants `EXECUTE` on new functions to `PUBLIC`** (every role). On Supabase this means a freshly created function in `public` is often immediately callable by `anon` with just the public anon key — frequently not what you want.

### Locking it down (the safe default)

```sql
-- Revoke the implicit PUBLIC grant for THIS function.
revoke execute on function public.add_message_to_conversation(text, text, text) from public, anon;

-- Grant only to logged-in users.
grant execute on function public.add_message_to_conversation(text, text, text) to authenticated;
```

Set a project-wide safe default so new functions are not auto-exposed to `anon`:

```sql
-- Run once.
alter default privileges in schema public revoke execute on functions from public;
-- Then grant per-function as needed.
```

### Hiding a function from the API entirely

| Method | How | When |
|---|---|---|
| **Non-exposed schema** | create in `private`/`internal` | helpers, trigger functions, definer internals |
| **Revoke EXECUTE** | `revoke execute … from anon, authenticated` | function in `public` but only `postgres`/triggers call it |

```sql
create schema if not exists private;

create or replace function private.reindex_user_vectors(p_user_id text)
returns void language plpgsql security definer set search_path = ''
as $$ … $$;
-- PostgREST never sees it; callable from triggers/cron SQL only.
```

### Decision matrix

| Function purpose | Schema | EXECUTE grant |
|---|---|---|
| Public read (search) | `public` | `anon`, `authenticated` |
| Authenticated write (message, conversation) | `public` | `authenticated` only |
| RLS helper (`is_team_member`) | `public` | `authenticated` (called from policies) |
| Internal recompute / vector reindex | `private` | none for API roles |
| Trigger function | `public` | n/a (not RPC-exposable; returns `trigger`) |

---

## 17. Migrations: authoring functions and triggers in versioned SQL

Functions and triggers are schema — they belong in **versioned migration files**, never hand-edited in the dashboard for anything you want reproducible.

### The Lumina approach

Because Prisma owns `prisma/migrations/`, keep function/trigger SQL in a parallel directory or alongside Prisma migrations as hand-authored `.sql` files:

```
backend/
  prisma/
    migrations/
      20260609120000_init/
        migration.sql           ← Prisma-generated table DDL
      20260615000000_handle_new_user/
        migration.sql           ← hand-authored trigger SQL (Prisma ignores functions/triggers)
```

Alternatively, maintain `supabase/migrations/` at the repo root and apply with `supabase db push` independently.

### Author idempotent DDL

```sql
-- supabase/migrations/20260615000000_handle_new_user.sql

create or replace function public.handle_new_user()  -- CREATE OR REPLACE = idempotent
returns trigger
language plpgsql
security definer
set search_path = ''
as $$ /* … body … */ $$;

-- Triggers have no OR REPLACE; drop-then-create.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
```

Include grants in the same file so the function is never left with the default `PUBLIC` EXECUTE:

```sql
revoke execute on function public.create_conversation_with_message(text,text,text,text) from public, anon;
grant  execute on function public.create_conversation_with_message(text,text,text,text) to authenticated;
```

### Checklist per migration

- [ ] `create or replace function` (idempotent)
- [ ] `drop trigger if exists` + `create trigger` (idempotent)
- [ ] `set search_path = ''` + schema-qualified names
- [ ] `revoke execute … from public, anon` + `grant execute … to authenticated` (or `anon` for public reads)
- [ ] `supabase gen types typescript …` committed after any signature change

---

## 18. TanStack Query + RPC: mutations and cache invalidation

On Lumina's React/Vite frontend, server state is owned by TanStack Query. RPC reads are queries; RPC writes are mutations that invalidate affected queries.

### RPC as a query (read)

```ts
// src/hooks/use-conversations.ts
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export function useConversationSearch(userId: string, term: string) {
  return useQuery({
    queryKey: ['conversations', 'search', userId, term],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('search_conversations', {
        p_user_id: userId,
        p_term: term,
        p_page_size: 20,
      })
      if (error) throw error  // let TanStack Query own the error state
      return data             // typed array
    },
    staleTime: 30_000,
    enabled: !!userId,
  })
}
```

### RPC as a mutation (write) with invalidation

```ts
// src/hooks/use-create-conversation.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export function useCreateConversation(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (params: { title: string; slug: string; firstMessage: string }) => {
      const { data, error } = await supabase
        .rpc('create_conversation_with_message', {
          p_user_id: userId,
          p_title: params.title,
          p_slug: params.slug,
          p_first_message: params.firstMessage,
        })
        .single()
      if (error) throw error
      return data as { conversationId: string }
    },
    onSuccess: () => {
      // The function atomically created a conversation + first message.
      // Invalidate conversation list queries so the sidebar refreshes.
      qc.invalidateQueries({ queryKey: ['conversations', userId] })
    },
  })
}
```

Because the RPC is atomic, the UI never observes a half-applied state — invalidation after `onSuccess` refetches a consistent snapshot.

---

## 19. Worked Example: atomic save-conversation RPC

End-to-end: migration SQL → function → grants → typed client → React hook. Consolidates §§5–18.

Lumina's existing flow persists messages via the Express backend (`backend/index.ts`). Here is how you would expose an equivalent atomic function over RPC for direct frontend use (e.g. an offline-first mobile companion, or a future API version):

### Migration SQL

```sql
-- supabase/migrations/20260615120000_save_conversation_message.sql

create or replace function public.save_message(
  p_conversation_id text,
  p_role            text,
  p_content         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller text := (select auth.uid())::text;
  v_msg_id int;
begin
  -- Authorization (definer bypasses RLS — we MUST check identity).
  if v_caller is null then
    raise exception 'Authentication required' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public."Conversation"
     where id = p_conversation_id
       and "userId" = v_caller
  ) then
    raise exception 'Conversation not found'
      using errcode = 'no_data_found',
            detail  = format('conversation_id=%s', p_conversation_id);
  end if;

  -- Validate role against the enum.
  if p_role not in ('user', 'Assistant') then
    raise exception 'Invalid message role: %', p_role
      using errcode = 'check_violation';
  end if;

  insert into public."Message" (content, role, "conversationId", "createdId")
  values (p_content, p_role::public."MessageRole", p_conversation_id, now())
  returning id into v_msg_id;

  return jsonb_build_object('messageId', v_msg_id, 'conversationId', p_conversation_id);
end;
$$;

revoke execute on function public.save_message(text, text, text) from public, anon;
grant  execute on function public.save_message(text, text, text) to authenticated;
```

### Typed client call + React hook

```ts
// src/hooks/use-save-message.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { z } from 'zod'

const SaveMessageResult = z.object({
  messageId: z.number(),
  conversationId: z.string(),
})
type SaveMessageResult = z.infer<typeof SaveMessageResult>

export function useSaveMessage(conversationId: string) {
  const qc = useQueryClient()

  return useMutation<SaveMessageResult, Error, { role: 'user' | 'Assistant'; content: string }>({
    mutationFn: async ({ role, content }) => {
      const { data, error } = await supabase
        .rpc('save_message', {
          p_conversation_id: conversationId,
          p_role: role,
          p_content: content,
        })
        .single()

      if (error) {
        if (error.code === 'no_data_found') throw new Error('Conversation not found or access denied.')
        if (error.code === 'P0001')          throw new Error('Authentication required.')
        throw new Error(error.message)
      }

      return SaveMessageResult.parse(data)
    },

    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages', conversationId] })
    },
  })
}
```

The invariant — the message belongs to a conversation the caller owns — is enforced in the database, atomically, for every client that might ever call this RPC.

---

## 20. Anti-Patterns

**Forgetting to check `error`.**
- Mistake: `const { data } = await supabase.rpc(...)` then using `data` directly.
- Why wrong: v2 never throws on RPC/query errors; on failure `data` is `null`. The real cause (RLS denial, `RAISE`, constraint) is in `error`.
- Fix: Always destructure and guard `if (error) { … }` before touching `data`. Centralize with a `callRpc` wrapper (§14).

**`SECURITY DEFINER` without `set search_path = ''`.**
- Mistake: Definer function with the default mutable `search_path`.
- Why wrong: Search-path hijacking — an attacker shadows a referenced object and runs code as the owner (`postgres`). The Supabase linter flags `function_search_path_mutable`.
- Fix: `set search_path = ''` on **every** function and schema-qualify all object names.

**`SECURITY DEFINER` as a way to "disable RLS."**
- Mistake: Making functions definer to avoid writing policies, with no in-body authorization check.
- Why wrong: You've replaced row-level authorization with nothing. Definer bypasses RLS, so the function is the *only* gate — and there's no gate.
- Fix: Default to `SECURITY INVOKER`. Use definer only for a narrow, validated action, and explicitly check `auth.uid()` against the rows you touch.

**Multi-step writes from the browser instead of one RPC.**
- Mistake: Sequential `supabase.from(...).insert()/.update()` calls expecting them to be atomic.
- Why wrong: Each is its own committed transaction. A mid-sequence failure leaves partial state; concurrent callers race.
- Fix: Encapsulate the steps in a `plpgsql` function (one implicit transaction) and call it via `rpc()`. Or use Prisma `$transaction()` on the backend (§11).

**Editing functions in the Supabase dashboard without a migration file.**
- Mistake: Creating/altering a function in the dashboard SQL editor directly, outside of version control.
- Why wrong: Not captured in `prisma/migrations/` or `supabase/migrations/`; lost on DB reset; teammates can't reproduce the state; Lumina's deploy pipeline won't include it.
- Fix: Write all function/trigger DDL in versioned `.sql` files alongside Prisma migrations. See §11, §17.

**Misusing Prisma `extensions = []` for pgvector instead of direct SQL.**
- Mistake: Adding `extensions = [pgvector]` to `schema.prisma`.
- Why wrong: `prisma migrate dev` then flags Supabase's pre-installed extensions as "drift" and threatens a destructive reset. This is explicitly warned in `backend/prisma/schema.prisma:19-21`.
- Fix: Enable extensions directly in Supabase (Dashboard → Database → Extensions or `CREATE EXTENSION vector`). Never list them in `schema.prisma`.

**Trusting the client to send `updated_at` (or `created_at`).**
- Mistake: Passing timestamps from JS in the insert/update payload.
- Why wrong: Clients lie or skew clocks; `created_at` becomes mutable; audit integrity gone.
- Fix: `created_at` / `createdAt` from a column `default now()`; `updated_at` / `updatedAt` from a BEFORE trigger (`moddatetime` or Prisma's `@updatedAt` directive). Never accept these columns from the client.

**`raise exception` in `handle_new_user` for recoverable conditions.**
- Mistake: Letting the profile-insert trigger throw on a duplicate or optional-field issue.
- Why wrong: An unhandled exception in the `auth.users` AFTER trigger rolls back the **signup** — the user literally cannot register.
- Fix: `on conflict (id) do nothing` for idempotency; wrap risky logic in `exception when others then raise warning … ; return new;` so signup never fails on a profile hiccup (§9).

**Leaving the implicit `PUBLIC` EXECUTE grant on a write function.**
- Mistake: Creating a state-changing function in `public` without revoking the default.
- Why wrong: Postgres grants `EXECUTE` to `PUBLIC` by default → `anon` can call it with the public anon key.
- Fix: `revoke execute … from public, anon; grant execute … to authenticated;` and set `alter default privileges … revoke execute on functions from public;` project-wide (§16).

**Marking a function that writes as `STABLE`/`IMMUTABLE`.**
- Mistake: Wrong volatility label on a writing function.
- Why wrong: The planner may cache or reorder calls → wrong results or skipped writes. Reads left `VOLATILE` can't be inlined and are slower.
- Fix: Reads = `STABLE` (or `IMMUTABLE`); anything that writes = `VOLATILE` (the default — keep it). Add `parallel safe` to heavy reads over large tables (§7).

**Ambiguous parameter vs column names in `plpgsql`.**
- Mistake: A parameter named `title` while the table also has a `title` column, used unqualified.
- Why wrong: `plpgsql` may resolve the name to the variable, not the column (or raises "ambiguous"), producing wrong queries.
- Fix: Prefix parameters (`p_title`, `_title`) or qualify with the function name.

**Trusting the generated type for `jsonb` returns.**
- Mistake: Casting a `jsonb`-returning RPC result to a hand-typed interface with `as`.
- Why wrong: The generator types `jsonb` as opaque `Json`; an `as` cast is a lie with no runtime check — schema drift goes undetected until a runtime crash.
- Fix: Validate the payload with Zod (`.parse(data)`) at the boundary (§13).

---

## 21. See Also

### Sibling references in this skill

- `lumina-supabase-in-this-repo.md` — how Lumina actually wires Supabase: the `createSupabaseClient()` auth-only client, token cache in `auth.ts`, and Prisma as the primary DB layer.
- `theory-supabase-architecture.md` — PostgREST, the schema-exposure model, RLS, and the `anon`/`authenticated`/`service_role` privilege ladder.
- `lumina-supabase-realtime-prices.md` — using Supabase Realtime for live market data in the Finance vertical.

### Related skills

- `prisma` — Prisma 7 + `@prisma/adapter-pg`, the schema, `$queryRaw`/`$executeRaw` for pgvector, and `$transaction()` for multi-step backend writes (the preferred alternative to RPC for backend-only logic in Lumina).
- `supabase` (skill root) — the full skill dispatch guide; links to all references.
- `rag-retrieval` — pgvector semantic cache (`CachedQuery` model), `$queryRaw` for cosine-distance search, the embedding pipeline.
- `finance-markets` — the Finance vertical's data-fetch routes and how they avoid holding sockets on Vercel (relevant when a function needs to avoid long-running Postgres calls on serverless).
- `connectors-oauth` — Gmail OAuth token vault stored in `GmailConnection`; AES-256-GCM encryption pattern that complements DB-level access control.
- `backend-testing` — mocking Prisma and Supabase in Bun tests; `backend/tests/helpers/prisma-fake.ts` and `supabase-fake.ts`.
- `lumina-frontend` — TanStack Query integration with Supabase RPC; the streaming chat render and how auth tokens flow from the frontend to the backend.
