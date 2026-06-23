# Resources: Official Docs, Tooling, and Further Reading

> Generic reference — a curated, version-anchored pointer map of where to find authoritative
> Supabase knowledge: the official docs tree, supabase-js API reference, the CLI, type generation,
> Realtime, Storage, Edge Functions, security advisories, monitoring, and community channels.
> Lumina examples are drawn from `backend/client.ts` and `backend/auth.ts` where they clarify the
> generic teaching; the Lumina-specific architecture lives in `lumina-supabase-in-this-repo.md`.

---

## 1. How to Use This File

This is the navigation layer. Every other reference in this skill teaches a domain (auth, RLS,
Realtime, Storage, Edge Functions, the CLI) and ends with a References section that points back
here. This file is the consolidated, opinionated index — plus the parts of the official corpus
that are easy to miss: security/performance advisories, connection-limit tables, Postgres core
docs that govern policy execution, and community channels for tracking the fast-moving 2.x line.

**Two rules:**

1. **Reference docs beat guides for exact signatures.** The *guides* (Auth, Database, Realtime)
   are conceptual and example-driven. The *reference* docs (`supabase-js`, CLI, Management API)
   are the canonical signatures. When you need to know whether `.upsert()` takes `onConflict` as
   a string or an object, read the reference.

2. **Treat the dashboard Advisors and Logs as first-class docs.** The Security Advisor and
   Performance Advisor (Section 5) encode the same rules this skill teaches — RLS-disabled tables,
   unindexed FK columns, mutable `search_path` on `SECURITY DEFINER` functions — and they run
   against *your* schema. Cheapest correctness check you have.

**Lumina context:** in this repo, Supabase is auth + Realtime only. Prisma owns all persistent
data. The supabase-js client has one production use: `auth.getUser(token)` in `backend/auth.ts`.
Everything in this file about Storage, Edge Functions, and the query builder is generic knowledge
that applies when you build projects that use those Supabase surfaces — Lumina deliberately does
not, but the patterns transfer and the references are load-bearing when those features are added.

---

## 2. Version Anchors and Truth Sources

Everything in this skill targets the following versions. Check external material against this
table first — a 2022 blog post predates most of these.

| Component | Anchor | The truth source (over any guide) |
|---|---|---|
| `@supabase/supabase-js` | **2.x** | `node_modules/@supabase/supabase-js/dist/module/index.d.ts` + the `supabase-js` reference docs |
| Result shape | `{ data, error }`, **never throws** | `PostgrestError` / `AuthError` types in the package |
| Auth flow | **PKCE** by default | `auth.getClaims()` for local JWT verification; `flowType: 'pkce'` option |
| Postgres | **15 / 16** | PostgreSQL 16 manual (Section 6) |
| RLS | `USING` vs `WITH CHECK` | PostgreSQL `CREATE POLICY` docs + Supabase RLS guide |
| Planner caching | wrap `auth.uid()` as `(select auth.uid())` | Supabase *RLS Performance* guide + `EXPLAIN ANALYZE` |
| CLI | current | `supabase --help` + the *CLI reference* |
| Edge Functions | **Deno** runtime, `Deno.serve` | Edge Functions docs + the Deno manual |
| Realtime | Postgres Changes, Broadcast, Presence | Realtime *Concepts* + `RealtimeChannel` types |
| Storage | RLS policies, signed URLs, image transforms | Storage reference + RLS guide |
| Keys | `anon` is public by design; `service_role` bypasses RLS, server-only | *API Keys* docs + newer publishable/secret key model |
| `SECURITY DEFINER` | pin `search_path` to `''` | PostgreSQL `CREATE FUNCTION` + Supabase hardening guide |

**Breaking-change flags to keep in mind when reading older material:**

- **supabase-js v1 → v2.** v1 put auth on the root (`supabase.auth.signIn`) and returned a
  different result shape. v2 namespaces auth (`signInWithPassword`, `signInWithOtp`,
  `signInWithOAuth`) and standardizes `{ data, error }`. Any snippet using
  `.signIn({ email, password })` or `supabase.auth.user()` is v1 — wrong.
- **`@supabase/auth-helpers-*` is deprecated** in favor of `@supabase/ssr`. Snippets importing
  `createServerComponentClient` from `@supabase/auth-helpers-nextjs` are on the deprecated path.
- **`getSession()` is not a trust boundary on the server.** It reads what the cookie/storage
  *claims*. On the server, verify with `getUser()` (round-trip) or `getClaims()` (local
  asymmetric verification). See Section 4.

---

## 3. The Official Docs Map (Product Areas)

Canonical roots under `https://supabase.com/docs`:

| Area | Path | Authoritative for | Matching reference |
|---|---|---|---|
| **Database** | `/guides/database` | Tables, relationships, SQL editor, extensions, pooling | `theory-supabase-architecture.md`, `patterns-database-functions-triggers-rpc.md` |
| **Auth** | `/guides/auth` | Providers, sessions, JWTs, MFA, hooks | `patterns-auth-flows.md` |
| **Row Level Security** | `/guides/database/postgres/row-level-security` | `CREATE POLICY`, `USING`/`WITH CHECK`, helper functions | `theory-row-level-security-model.md`, `patterns-rls-policies.md` |
| **Realtime** | `/guides/realtime` | Postgres Changes, Broadcast, Presence, authorization, quotas | `patterns-realtime.md`, `lumina-supabase-realtime-prices.md` |
| **Storage** | `/guides/storage` | Buckets, uploads, signed URLs, transforms, Storage RLS | `patterns-storage.md` |
| **Edge Functions** | `/guides/functions` | Deno runtime, secrets, CORS, JWT verification | `patterns-edge-functions.md` |
| **CLI** | `/guides/local-development` + `/reference/cli` | Local stack, migrations, `db push`, `gen types`, branching | `patterns-cli-migrations-and-types.md` |
| **API (PostgREST)** | `/guides/api` | The auto-generated REST surface supabase-js wraps | `patterns-query-builder-and-mutations.md` |
| **Platform / Security** | `/guides/platform`, `/guides/security` | Project settings, production checklist, hardening | Sections 5, 6, 7 of this file |

**Reference (signature-canonical) docs** — distinct from the guides:

| Reference | Path | Use when you need… |
|---|---|---|
| **`supabase-js`** | `/reference/javascript` | Exact method signatures, options, and return types |
| **CLI** | `/reference/cli` | Every `supabase` subcommand, flags, and config keys |
| **Management API** | `/reference/api` | Programmatic project/org management over HTTP (CI, IaC) |
| **Self-Hosting** | `/reference/self-hosting-*` | Running the stack yourself (GoTrue, PostgREST, Realtime, Storage) |

The single most useful navigation habit: when a guide shows a JS snippet, click through to the
`supabase-js` reference for that method to see the full options object — guides show the 80% path
and omit options like `count`, `head`, `returning`, `onConflict`, and `defaultToNull`.

---

## 4. supabase-js v2 API Reference — Navigation and Gotchas

The reference (`/reference/javascript/introduction`) is organized by sub-client: **Auth**
(`supabase.auth.*`), **Database** (`from().select()/insert()/...` and `.rpc()`), **Realtime**
(`channel()`), **Storage** (`storage.from()`), and **Functions** (`functions.invoke()`).

**The result contract is universal and non-throwing.** Every builder terminates in `{ data, error }`.
You must branch on `error` — supabase-js does not throw on a DB or auth error.

```ts
// Canonical pattern — check error before using data.
const { data, error } = await supabase
  .from('conversations')
  .select('id, title, createdAt')
  .eq('userId', userId)
  .order('createdAt', { ascending: false })

if (error) {
  // PostgrestError: { message, details, hint, code }
  // code '42501' = insufficient_privilege (RLS denial or missing GRANT)
  throw new Error(`query failed: ${error.message} (${error.code})`)
}
// data is typed and non-null here
```

**In Lumina, supabase-js is used only for `auth.getUser`.** The pattern above is Lumina-
irrelevant for day-to-day dev (Prisma handles data) but matters when building any project that
uses the query builder, or when adding a Supabase Realtime subscription in the frontend.

**Auth method map (v2), with v1 names that must not appear:**

| Intent | v2 method | Removed v1 name |
|---|---|---|
| Email+password sign-in | `auth.signInWithPassword({ email, password })` | `auth.signIn({ email, password })` |
| Magic link | `auth.signInWithOtp({ email })` | `auth.signIn({ email })` |
| OAuth (PKCE) | `auth.signInWithOAuth({ provider })` | `auth.signIn({ provider })` |
| Current user (verified) | `auth.getUser()` | `auth.user()` |
| Current session (local read) | `auth.getSession()` | `auth.session()` |
| Local JWT claims | `auth.getClaims()` | — (new in 2.x) |

**`getSession()` vs `getUser()` vs `getClaims()` — the most critical distinction:**

| Method | What it does | Trust on the server? | Cost |
|---|---|---|---|
| `getSession()` | Reads session from local storage/cookie | **No** — whatever the client claims | Local, instant |
| `getUser()` | Sends JWT to Auth server for validation | **Yes** | Network round-trip |
| `getClaims()` | Verifies JWT locally via JWKS, returns claims | **Yes** (with current asymmetric keys) | Local after key fetch |

Lumina's `backend/auth.ts` uses `getUser(token)` — the token is passed as an argument (the
raw `Authorization` header value), so the server-client pattern applies. See
`lumina-supabase-in-this-repo.md` for the full flow with caching and user provisioning.

**Query-builder facts to bookmark in the reference:**

- `.single()` errors (PGRST116) if rows ≠ 1; `.maybeSingle()` returns `null` for 0 rows.
- `.select('*', { count: 'exact', head: true })` returns only the count, no rows.
- Embedded resources use FK-name hint syntax: `select('*, user:users!conversations_userId_fkey(*)')`.
- `.upsert(values, { onConflict: 'col_a,col_b', ignoreDuplicates: false })` — `onConflict` is a
  **comma-separated string**, not an array.

---

## 5. RLS Performance and Security Advisories

Supabase ships a **database linter** surfaced as two dashboard advisors. Treat these as executable
docs — they encode the rules in `theory-row-level-security-model.md` and `patterns-rls-policies.md`
and run against your real schema.

| Advisor | Selected lint names | Severity | Reference |
|---|---|---|---|
| **Security Advisor** | `rls_disabled_in_public`, `security_definer_view`, `function_search_path_mutable`, `auth_users_exposed`, `extension_in_public` | ERROR/WARN | `/guides/database/database-advisors` |
| **Performance Advisor** | `unindexed_foreign_keys`, `auth_rls_initplan` (un-wrapped `auth.uid()`), `multiple_permissive_policies`, `duplicate_index`, `unused_index` | WARN/INFO | same |

**`rls_disabled_in_public`** maps directly to a data breach — any table exposed to the anon key
without RLS is publicly readable/writable.

**`auth_rls_initplan`** fires when you wrote `auth.uid() = user_id` instead of
`(select auth.uid()) = user_id`. The wrapped form lets the planner evaluate the function once per
query as an InitPlan instead of once per row — critical at scale.

```sql
-- The fix the Performance Advisor wants: wrap auth.* in a scalar subquery.
create policy "own_rows_select"
on public.my_table for select
to authenticated
using ( (select auth.uid()) = user_id );   -- NOT: auth.uid() = user_id

-- Index the column the predicate filters on:
create index if not exists my_table_user_id_idx
  on public.my_table (user_id);
```

Verify the optimization actually fired:

```sql
explain (analyze, buffers)
select * from public.my_table where (select auth.uid()) = user_id;
-- Look for "InitPlan 1 (returns $0)" and "Index Scan on my_table_user_id_idx".
```

Official reading: *Database Advisors* (`/guides/database/database-advisors`), *RLS Performance
Recommendations* (`/guides/troubleshooting/rls-performance-and-best-practices`).

---

## 6. Postgres Docs That Govern Your Policies

Supabase is Postgres. When the Supabase guide is thin, the PostgreSQL 16 manual is the authority.

| PostgreSQL manual page | Why it's the real authority |
|---|---|
| **`CREATE POLICY`** | The exact semantics of `USING`, `WITH CHECK`, `PERMISSIVE`/`RESTRICTIVE`, `FOR` command, `TO` role |
| **`ALTER TABLE … ENABLE ROW LEVEL SECURITY`** | Default-deny behavior, `FORCE ROW LEVEL SECURITY` |
| **`CREATE FUNCTION`** | `SECURITY DEFINER`/`INVOKER`, `SET search_path`, volatility labels |
| **PL/pgSQL** (Part V) | Trigger bodies, `NEW`/`OLD`, control flow, `RAISE`, exception blocks |
| **`CREATE TRIGGER`** | `BEFORE`/`AFTER`/`INSTEAD OF`, `FOR EACH ROW`, the `handle_new_user` pattern |
| **Indexes** | B-tree vs GIN/GiST, partial indexes — what makes RLS predicates fast |
| **`EXPLAIN` / Using EXPLAIN** | Reading `Index Scan` vs `Seq Scan`, `InitPlan` — verifying RLS performance |
| **`auth` schema GUCs** | How `auth.uid()`/`auth.jwt()` read `request.jwt.claims` via `current_setting` |

The canonical `handle_new_user` trigger pattern (mirror `auth.users` → a public profile on
signup) is documented in the Supabase guide but the semantics of `SECURITY DEFINER` + trigger
ordering come from the PostgreSQL `CREATE TRIGGER` and `CREATE FUNCTION` pages:

```sql
-- Hardened: SECURITY DEFINER with pinned search_path.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

**Lumina does not use this trigger today** — user provisioning happens in `backend/auth.ts` via
a Prisma upsert (`auth.ts:53-76`). But if you ever expose a table directly through supabase-js
and need identity mirroring, this is the pattern.

`set search_path = ''` (empty) is mandatory on any `SECURITY DEFINER` function. A mutable
`search_path` lets an attacker shadow objects the owner-privileged function references via a
schema earlier on the path — classic search-path hijacking. See `patterns-rls-policies.md`.

---

## 7. Monitoring, Logs, and Connection Limits

**Three observability surfaces:**

| Surface | Answers | Where | Notes |
|---|---|---|---|
| **Logs Explorer** | "What happened on request X?" | Dashboard → Logs | Per-service streams: Postgres, PostgREST, Auth, Realtime, Storage, Edge Functions |
| **Reports** | "Is the project healthy over time?" | Dashboard → Reports | Request counts, error rates, DB CPU/RAM/disk, connection counts, egress |
| **Advisors** | "Is my schema mis-configured?" | Dashboard → Advisors | Security + Performance linters (Section 5) |

**High-frequency error codes to recognize immediately:**

| Code | Meaning | Usual Supabase cause |
|---|---|---|
| `42501` | insufficient_privilege | **RLS denied the operation** (or a missing GRANT) |
| `PGRST116` | no/too-many rows | `.single()` matched 0 or >1 rows — use `.maybeSingle()` |
| `PGRST301` | JWT/role issue | Expired or missing token; misconfigured role |
| `23505` | unique_violation | Duplicate key — handle with `.upsert` + `onConflict` |
| `23503` | foreign_key_violation | Child inserted before parent / bad FK reference |

**Connection limits.** Postgres has a fixed `max_connections` (size-dependent). A serverless or
high-concurrency app that opens a direct connection per invocation exhausts it fast. Supabase's
answer is **Supavisor** (connection pooler), on two ports:

| Mode | Port | Use for | Caveats |
|---|---|---|---|
| **Transaction** (pooled) | 6543 | Serverless / Edge / many short-lived connections | No session-level features: prepared statements across calls, `LISTEN/NOTIFY` |
| **Session** | 5432 (pooler) | Long-lived servers, migrations | Behaves like a direct connection |
| **Direct** | 5432 (db host) | CLI / admin only | Limited slots — do not point your app here at scale |

**Lumina:** the Express backend connects via `DATABASE_URL` to Postgres through Prisma using the
driver adapter (`PrismaPg`). Use the **session-mode pooler** (port 5432 pooler) or direct for
the long-lived Express server; use **transaction-mode (6543)** if you ever add a serverless
function that opens its own connection. PostgREST (the path supabase-js `from()` uses) handles
its own pool — irrelevant since Lumina doesn't use the query builder for data.

Official reading: *Connecting to your database* (`/guides/database/connecting-to-postgres`),
*Connection Management*, *Auth Rate Limits* (`/guides/auth/rate-limits`).

---

## 8. CLI Reference and `gen types typescript`

The CLI is the production interface to schema and types. Canonical docs: the *CLI reference*
(`/reference/cli`) and *Local Development* guides (`/guides/local-development`).

| Command | Purpose | Reference anchor |
|---|---|---|
| `supabase init` | Scaffold `supabase/` (config.toml, migrations, functions) | `/reference/cli/supabase-init` |
| `supabase start` / `stop` | Bring the local Docker stack up/down | `/reference/cli/supabase-start` |
| `supabase status` | Show local URLs and keys | `/reference/cli/supabase-status` |
| `supabase login` / `link` | Authenticate, link to a remote project | `/reference/cli/supabase-link` |
| `supabase db diff` | Diff local DB vs migrations → generate a migration | `/reference/cli/supabase-db-diff` |
| `supabase migration new` | Create an empty timestamped migration | `/reference/cli/supabase-migration-new` |
| `supabase db push` | Apply local migrations to the linked remote | `/reference/cli/supabase-db-push` |
| `supabase db reset` | Recreate local DB from migrations + seed | `/reference/cli/supabase-db-reset` |
| `supabase gen types typescript` | Generate the `Database` type | `/reference/cli/supabase-gen-types-typescript` |
| `supabase functions serve` / `deploy` | Run/deploy Edge Functions | `/reference/cli/supabase-functions-deploy` |

**`gen types typescript`** is the load-bearing command for end-to-end type safety. Two invocation
modes:

```bash
# Against the local stack (must be running):
supabase gen types typescript --local > src/types/database.types.ts

# Against a linked remote project (CI, after a migration):
supabase gen types typescript --linked > src/types/database.types.ts
```

```ts
// The only correct way to type the browser client:
import { createClient } from '@supabase/supabase-js'
import type { Database } from './types/database.types'

export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)

// Reuse generated shapes — never hand-write row types:
type ConversationRow = Database['public']['Tables']['conversations']['Row']
```

**Lumina note:** Prisma owns the schema and `prisma generate` produces the typed client.
`supabase gen types` is only relevant if you ever expose a table directly through supabase-js
(adding Realtime subscriptions, for instance). The `CachedQuery` model uses
`Unsupported("vector(1536)")` for the embedding column — that column is invisible to the Prisma
typed client and accessed only via `$queryRaw`. See `patterns-cli-migrations-and-types.md` for
how the CLI coexists with Prisma owning migrations.

---

## 9. Realtime, Storage, and Edge Functions — Reference Anchors

**Realtime — three primitives, three use-cases.** The Realtime *Concepts* docs
(`/guides/realtime/concepts`) define the split:

| Primitive | What it carries | Durable? | Authorization | Use it for |
|---|---|---|---|---|
| **Postgres Changes** | INSERT/UPDATE/DELETE on a table | Yes | RLS-checked per subscriber | Reacting to real database writes |
| **Broadcast** | Arbitrary ephemeral messages on a channel | No | Channel-level policies | High-frequency, ephemeral signals (live prices, cursors) |
| **Presence** | Per-client online state synced across subscribers | No | Channel-level | "Who's online" |

```ts
// Postgres Changes — durable, RLS-authorized. Always clean up the channel.
const channel = supabase
  .channel('my-channel')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversationId=eq.${id}` },
    (payload) => onNewMessage(payload.new),
  )
  .subscribe()

// Cleanup (React effect return / unmount) — Non-Negotiable #7 in SKILL.md:
supabase.removeChannel(channel)
```

Lumina's live finance prices use **Broadcast** (the worker publishes ticks; subscribers get
ephemeral push). Postgres Changes is for durable row reactions. See
`lumina-supabase-realtime-prices.md` for the end-to-end Lumina wiring and `patterns-realtime.md`
for the full decision tree.

**Storage.** The Storage reference (`/guides/storage`) covers buckets (public vs private),
`upload`/`download`/`list`/`remove`, **signed URLs** for private objects, and **image
transforms**. Authorization is RLS on the `storage.objects` table.

```ts
// Private object → time-limited signed URL (never expose private buckets publicly):
const { data, error } = await supabase
  .storage.from('uploads')
  .createSignedUrl(`reports/${reportId}.pdf`, 3600) // seconds
if (error) throw error
const url = data.signedUrl

// On-the-fly image transform for a public thumbnail:
const { data: pub } = supabase
  .storage.from('public-thumbnails')
  .getPublicUrl(`items/${itemId}.jpg`, { transform: { width: 480, quality: 70 } })
```

Lumina currently does not use Storage (Health file uploads go through the Express backend and are
not stored in Supabase buckets). See `patterns-storage.md` for bucket-choice decisions and
Storage RLS policies.

**Edge Functions.** The Edge Functions docs (`/guides/functions`) cover the **Deno** runtime
(`Deno.serve`), secrets via `supabase secrets set`, CORS (you must set headers yourself including
the `OPTIONS` preflight), and JWT verification.

```ts
// Canonical Deno Edge Function shape — with CORS + JWT verification:
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
  )
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
```

Lumina does not use Edge Functions — all server logic runs on Vercel (serverless) or the
`worker/` (Fly.io). See `patterns-edge-functions.md` for the full pattern guide.

---

## 10. Community, Changelog, and Self-Verification

**Community channels:**

| Channel | Use for |
|---|---|
| **GitHub: `supabase/supabase-js`** (Releases tab) | **Client breaking changes** — read before bumping any version |
| **GitHub: `supabase/cli`** (Releases) | CLI changes: new subcommands, config key renames |
| **GitHub Discussions** (`supabase/supabase`) | Q&A, RLS pattern review, "is this expected?" |
| **Changelog** (`supabase.com/changelog`) | Product launches: new keys, Realtime features, Storage transforms |
| **Blog** (`supabase.com/blog`) | Deep dives, migration guides, Launch Week posts |
| **Status** (`status.supabase.com`) | Check before deep-debugging an apparent outage |
| **Discord** | Real-time help — fastest for "is this expected behavior?" |

**Two habits that prevent regressions:**

1. Read `supabase-js` Releases before any minor/major bump. New defaults (PKCE became the
   default), deprecations, and option changes land there first.
2. Watch the changelog for the keys migration. The platform is moving from long-lived
   `anon`/`service_role` JWT keys to **publishable** (`sb_publishable_...`) and **secret**
   (`sb_secret_...`) keys. The security model is unchanged — map publishable→anon,
   secret→service_role. Lumina reads the key from `SUPABASE_API_SECRET ?? SUPABASE_KEY`
   (`backend/client.ts:14`); update that env var name when your project migrates.

**Self-verification recipes (docs lag; code does not):**

```bash
# Confirm installed client and CLI versions:
npm ls @supabase/supabase-js @supabase/ssr
npx supabase --version

# Read the real method signature (more reliable than any guide):
# node_modules/@supabase/supabase-js/dist/module/index.d.ts
# node_modules/@supabase/postgrest-js/dist/cjs/index.d.ts  (query builder)
# node_modules/@supabase/auth-js/dist/module/GoTrueClient.d.ts  (auth)
```

Decode a JWT to confirm what role/claims RLS will see:

```ts
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  return JSON.parse(json)
}
// → { sub, role: 'authenticated', exp, app_metadata, user_metadata, ... }
// sub == auth.uid() in RLS; role == auth.role()
```

Prove an RLS policy denies what you expect — locally, against the real engine:

```sql
-- In psql against the local stack (supabase start):
set local role authenticated;
set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
select * from public.my_table;  -- should return only that user's rows
reset role;
```

---

## 11. Migration and Deprecation Tracker

| Old (do not use) | Modern (use) | Reference |
|---|---|---|
| `supabase.auth.signIn({ email, password })` | `supabase.auth.signInWithPassword(...)` | Section 4 |
| `supabase.auth.signIn({ provider })` | `supabase.auth.signInWithOAuth({ provider })` | Section 4 |
| `supabase.auth.user()` / `.session()` | `getUser()` / `getSession()` / `getClaims()` | Section 4 |
| `@supabase/auth-helpers-nextjs` / `-react` | `@supabase/ssr` (`createServerClient`/`createBrowserClient`) | `patterns-auth-flows.md` |
| `auth.uid() = user_id` in policies | `(select auth.uid()) = user_id` | Section 5 |
| Implicit OAuth flow | **PKCE** (default) | `patterns-auth-flows.md` |
| `anon` / `service_role` JWT key names | `sb_publishable_...` / `sb_secret_...` (rolling out) | Section 10 |
| Dashboard SQL editor for prod schema changes | CLI migrations (`db diff` → review → `db push`) | Section 8 |
| Hand-written row type interfaces | `gen types typescript` `Database` type | Section 8 |

---

## 12. Prior Art Pointers

| Repo / skill | Path | What to look for |
|---|---|---|
| **react repo** — `supabase` skill | `E:\Development\Portfolio-phase2\react\.claude\skills\supabase` | The source skill these generic references are adapted from. Full course-app case study: `courses`/`enrollments`/`progress` schema, Storage, Edge Functions, RLS ownership policies, pgTAP policy tests. |
| **rareLab** — `supabase-integration` skill | `E:\Development\Portfolio-phase2\Akshay-pooja\rare-lab\.claude\skills\supabase-integration` | A second prior-art skill; the Cognitive-Mesh architecture this library copies. |

When reading these prior-art skills, remember: the react repo uses supabase-js as the **primary
data layer** (with the query builder and RLS). Lumina inverts this — Prisma is primary, supabase-js
is auth-only. Port the generic knowledge (key model, RLS semantics, Realtime primitives), but do
not copy the data-access patterns.

---

## 13. Official URL Index

**Supabase:**

- Docs home — `https://supabase.com/docs`
- `supabase-js` reference — `https://supabase.com/docs/reference/javascript/introduction`
- CLI reference — `https://supabase.com/docs/reference/cli`
- Management API — `https://supabase.com/docs/reference/api`
- Local Development — `https://supabase.com/docs/guides/local-development/overview`
- Auth guides + Server-Side Auth (`@supabase/ssr`) — `/guides/auth`, `/guides/auth/server-side`
- Row Level Security — `/guides/database/postgres/row-level-security`
- RLS performance best practices — `/guides/troubleshooting/rls-performance-and-best-practices`
- Database Advisors / Linter — `/guides/database/database-advisors`, `.../database-linter`
- Realtime concepts — `/guides/realtime/concepts`
- Storage — `/guides/storage`
- Edge Functions — `/guides/functions`
- Connecting to Postgres / Supavisor pooling — `/guides/database/connecting-to-postgres`
- Logging / telemetry — `/guides/telemetry/logs`
- Production checklist — `/guides/platform/going-into-prod`
- API keys (anon/service_role + publishable/secret) — `/guides/api/api-keys`
- Auth rate limits — `/guides/auth/rate-limits`

**PostgreSQL 16 manual (the underlying authority):**

- `CREATE POLICY` — `https://www.postgresql.org/docs/current/sql-createpolicy.html`
- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` — `https://www.postgresql.org/docs/current/ddl-rowsecurity.html`
- `CREATE FUNCTION` (SECURITY DEFINER, SET search_path) — `https://www.postgresql.org/docs/current/sql-createfunction.html`
- PL/pgSQL — `https://www.postgresql.org/docs/current/plpgsql.html`
- `CREATE TRIGGER` — `https://www.postgresql.org/docs/current/sql-createtrigger.html`
- Indexes — `https://www.postgresql.org/docs/current/indexes.html`
- Using EXPLAIN — `https://www.postgresql.org/docs/current/using-explain.html`
- PostgREST (the Data API) — `https://postgrest.org/en/stable/`

**Deno (Edge Functions runtime):**

- Deno manual / `Deno.serve` — `https://docs.deno.com/runtime/`

---

## See also

**Siblings in this skill:**

- `lumina-supabase-in-this-repo.md` — how Lumina actually uses Supabase: `backend/client.ts`
  lazy factory, `backend/auth.ts` JWT validation + token cache + user provisioning, the
  Prisma-vs-Supabase boundary, the `supabase-fake` test seam. Read this first for any Lumina task.
- `lumina-supabase-realtime-prices.md` — live price path end-to-end: worker → Realtime Broadcast
  channel → `use-live-prices.ts` subscriber + cleanup.
- `theory-supabase-architecture.md` — the platform: PostgREST, GoTrue, keys, JWT structure,
  project topology.
- `theory-row-level-security-model.md` — the authorization mental model: `USING` vs `WITH CHECK`,
  roles, `auth.uid()`, threat model.
- `patterns-auth-flows.md` — email/password, magic link, OAuth PKCE (Google/GitHub), sessions,
  `onAuthStateChange`, `getUser`/`getClaims`, password reset.
- `patterns-realtime.md` — Postgres Changes vs Broadcast vs Presence, channel lifecycle, cleanup,
  scaling.
- `patterns-rls-policies.md` — ownership/role policies, helper functions, `SECURITY DEFINER`,
  performance, testing.
- `patterns-storage.md` — buckets, uploads, signed URLs, transforms, Storage RLS.
- `patterns-edge-functions.md` — Deno, secrets, CORS, JWT, webhooks, service-role.
- `patterns-cli-migrations-and-types.md` — local stack, extensions (pgvector), `gen types`,
  how the CLI coexists with Prisma-owned migrations.
- `patterns-query-builder-and-mutations.md` — `select`/`insert`/`upsert`/`update`/`delete`;
  the non-default path in Lumina (Prisma is primary).

**Other skills:**

- `prisma` — schema, migrations, `PrismaPg` driver adapter, `$queryRaw` for pgvector, the
  `prisma-fake.ts` test seam.
- `rag-retrieval` — how `CachedQuery` is read/written via raw SQL, cosine similarity, the
  stale-while-revalidate semantic cache.
- `redis` — `backend/lib/cache.ts` and the Upstash Redis hot cache; separate from the Postgres
  semantic cache; used for computed pages and rate limiting.
- `finance-markets` — live-price domain (what ticks, market hours, Finnhub WS); this skill owns
  the Realtime *transport*, that skill owns the *data*.
- `connectors-oauth` — `GmailConnection` model, OAuth token vault, the separate Google OAuth
  grant distinct from Supabase auth.
- `backend-testing` — the full test preload architecture, how `supabase-fake.ts` and
  `prisma-fake.ts` are wired together.
- `lumina-frontend` — how the React app obtains and forwards the Supabase JWT, TanStack Query
  auth headers, the `AuthContext`.
