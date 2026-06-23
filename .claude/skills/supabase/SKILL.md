---
name: supabase
description: >
  Build and reason about Lumina's Supabase usage. In THIS repo Supabase is the **auth + Realtime**
  layer (NOT the data layer — Prisma owns persistent data). Covers the supabase-js client
  (`createClient`, anon vs service-role keys), the lazy server-side auth client that validates JWTs
  with `auth.getUser(token)`, the token-cache + idempotent user-provisioning middleware, Google/
  GitHub OAuth, Supabase Realtime as the transport for live finance prices (worker → Realtime →
  `use-live-prices`), pgvector living on Supabase Postgres, Row Level Security as a model (and why
  Lumina enforces authz in Express + Prisma instead), Storage, Edge Functions, DB functions/
  triggers/RPC, the CLI, and the `supabase-fake` test seam. Use whenever the task touches sign-in,
  JWT validation, the Supabase client/keys, Realtime live prices, RLS, or Supabase-side Postgres
  setup.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/client.ts'
    - 'backend/auth.ts'
    - 'backend/tests/helpers/supabase-fake.ts'
    - 'worker/**'
    - 'frontend/src/hooks/use-live-prices.ts'
    - 'frontend/src/lib/supabase*.ts'
    - 'frontend/src/**/auth*'
  bashPatterns:
    - 'supabase'
    - 'SUPABASE'
    - 'getUser'
    - 'realtime'
  promptSignals:
    phrases:
      - 'supabase'
      - 'sign in'
      - 'sign-in'
      - 'auth.getUser'
      - 'jwt'
      - 'access token'
      - 'service role'
      - 'anon key'
      - 'row level security'
      - 'RLS'
      - 'supabase realtime'
      - 'live prices'
      - 'broadcast'
      - 'presence'
      - 'edge function'
      - 'OAuth'
      - 'google sign in'
    minScore: 3
---

# Supabase — Lumina's Auth + Realtime Layer

> The single most important fact: **in Lumina, Supabase is auth + Realtime, not the data store.**
> Prisma owns every persistent table; Supabase validates JWTs (`auth.getUser`) and carries live
> finance ticks over Realtime; pgvector happens to live on the same Supabase Postgres. Build it the
> way the live code does — a **lazy** server client (so a missing env var can't crash boot),
> **service-role used only for token verification**, and authorization enforced in Express + Prisma
> rather than RLS. This skill maps any Supabase task to the exact reference + the exact file.

Generic Supabase knowledge is imported/adapted from the react repo's `supabase` skill; everything is
re-pointed at how Lumina actually uses (and deliberately does *not* use) each capability.

---

## Domain Identity

**This skill OWNS:**
- The Supabase client factory in [`backend/client.ts`](../../../backend/client.ts) (`createClient`,
  the `SUPABASE_API_SECRET ?? SUPABASE_KEY` key choice, the service-role caveat).
- The auth middleware in [`backend/auth.ts`](../../../backend/auth.ts): lazy client init,
  `auth.getUser(token)`, the token cache (TTL), idempotent user provisioning, `req.userId`.
- Supabase **Realtime** as the live-price transport: the [`worker/`](../../../worker/) publisher and
  [`frontend/src/hooks/use-live-prices.ts`](../../../frontend/src/hooks/use-live-prices.ts) subscriber.
- The OAuth providers Lumina accepts (`Google`, `Github` — see the `AuthProvider` enum) and the
  frontend sign-in flow.
- The `supabase-fake` test seam ([`backend/tests/helpers/supabase-fake.ts`](../../../backend/tests/helpers/supabase-fake.ts)).
- The *generic* Supabase model (keys, RLS, Storage, Edge Functions, CLI) as reusable knowledge,
  always annotated with whether Lumina uses it.

**This skill does NOT own (route elsewhere):**
- **Persistent data / schema / queries** → **prisma**. Prisma is the data layer; this skill never
  reads user data through supabase-js.
- The **pgvector retrieval algorithm** (cosine `<=>`, threshold) → **rag-retrieval**; the **column +
  migration** → **prisma**. Supabase only *hosts* the Postgres + the `vector` extension.
- The **finance live-price domain** (what ticks, market hours, Finnhub WS) → **finance-markets**;
  this skill owns the *Realtime transport*, that skill owns the *data*.
- **Frontend app-shell / sign-in UI components** → **lumina-frontend** (this skill owns the auth
  *mechanics*; that skill owns the *screens*).
- **Connector OAuth (Gmail)** → **connectors-oauth** — that is a *separate* Google OAuth grant, not
  Supabase auth.
- **Wiring a Supabase mock into a specific test** → **backend-testing**.

---

## Decision Tree

```
Supabase task arrives
|
+-- "How does Lumina actually use Supabase? where is X?" --------> lumina-supabase-in-this-repo.md
+-- "Live prices over Realtime: worker -> channel -> use-live-prices" -> lumina-supabase-realtime-prices.md
+-- "Understand the platform (Postgres/PostgREST/GoTrue/keys/JWT)" --> theory-supabase-architecture.md
+-- "Understand RLS as an authz model (USING/WITH CHECK, threat)" --> theory-row-level-security-model.md
+-- "Set up / configure a client (server vs browser vs Expo; keys)" -> patterns-client-setup-and-config.md
+-- "Implement auth: email/pw, magic link, OAuth (Google/GitHub)" --> patterns-auth-flows.md
+-- "Write RLS policies (ownership/role/claim; perf; test)" --------> patterns-rls-policies.md
+-- "Build Realtime: Postgres Changes / Broadcast / Presence" ------> patterns-realtime.md
+-- "Use Storage: buckets, signed URLs, transforms, Storage RLS" ---> patterns-storage.md
+-- "Write an Edge Function (Deno, CORS, JWT, webhook)" ------------> patterns-edge-functions.md
+-- "DB functions / triggers / call via .rpc()" -------------------> patterns-database-functions-triggers-rpc.md
+-- "Supabase CLI / local stack / extensions / gen types" ---------> patterns-cli-migrations-and-types.md
+-- "Query/mutate with supabase-js (select/insert/upsert) — rare" --> patterns-query-builder-and-mutations.md
+-- "Official docs / tools / further reading" ---------------------> resources.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Prisma owns data; Supabase owns auth + Realtime.** Do NOT introduce user-data reads/writes through supabase-js — route persistence through Prisma. | `client.ts` comment: "we never query user data through this client." |
| 2 | **Build the server Supabase client LAZILY, never at module load.** `createClient` throws if env is missing; eager init crashes the *entire* serverless function (incl. public `/finance` routes). | `auth.ts` `getClient()` lazy singleton. |
| 3 | **Never ship the `service_role` key to any client bundle.** It bypasses RLS. It belongs only in the trusted server (Vercel functions). The browser holds only the anon key. | Cross-cutting; `client.ts`. |
| 4 | **The anon key is public by design; security comes from server-side authz (Express middleware + Prisma), and from RLS when a client touches Supabase directly.** Treating the anon key as secret is false confidence. | `theory-row-level-security-model.md`. |
| 5 | **Auth runs on every request, but cost is cached.** Validate the JWT with `auth.getUser(token)`, then cache `token→userId` for a short TTL; provision the user row once per process via an idempotent `upsert`. | `auth.ts` token cache + `provisionedUsers` set. |
| 6 | **Always handle the `{ data, error }` result — supabase-js does not throw.** A null user means 401; a provisioning failure must fail loudly (500), not silently continue. | `auth.ts` error branches. |
| 7 | **Realtime channels and `onAuthStateChange` listeners MUST be unsubscribed on unmount.** Leaks exhaust connections and cause duplicate handlers/stale closures. | `patterns-realtime.md`; `use-live-prices.ts` cleanup. |
| 8 | **Vercel can't hold a socket — the Realtime *publisher* lives in the `worker/` (Fly.io), not a route.** The browser subscribes directly to Supabase Realtime; the worker pushes ticks. | Cross-cutting rule #4; `lumina-supabase-realtime-prices.md`. |
| 9 | **pgvector is enabled in Supabase, not via Prisma.** Letting Prisma manage extensions flags Supabase's own as drift. Enable `vector` in the Supabase dashboard / `CREATE EXTENSION`. | Shared with **prisma** skill. |
| 10 | **If you ever expose a table to the anon/authenticated key, RLS is mandatory on it.** An RLS-disabled public table is a data breach. Today Lumina exposes none directly — keep it that way unless you add RLS. | `theory-row-level-security-model.md`. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Reading/writing app data through `supabase.from('table')` | Use Prisma for persistence; Supabase client is auth + Realtime only. |
| `createClient(...)` at module top-level in the backend | Lazy `getClient()` — defer until the first authed request so a bad env var can't crash boot. |
| Putting `SUPABASE_API_SECRET` (service-role) in a `VITE_*`/client env | Service-role is server-only; the browser gets the anon key. |
| Ignoring `error` from `{ data, error }` | Check `error` after every call; null user → 401, provisioning fail → 500. |
| Re-validating the same token against Supabase every request | Cache `token→userId` for a short TTL; revalidate after it lapses. |
| Re-`upsert`-ing the user on every request | Idempotent upsert once per process (`provisionedUsers` guard). |
| Leaked Realtime channel / auth listener | Store the handle; `removeChannel`/`unsubscribe` in cleanup. |
| A long-lived Realtime publisher inside a Vercel route | Publish from the `worker/`; the browser subscribes to Realtime directly. |
| Using Postgres Changes for high-fanout ephemeral ticks | Use **Broadcast** for ephemeral/high-frequency (live prices); Changes for durable rows. |
| Adding `extensions=[vector]` to Prisma to "manage pgvector" | Enable pgvector in Supabase; keep Prisma out of extension management. |

---

## Output Contract (what "done" looks like)

A Supabase change is done when:
1. **Boundary respected:** persistence still flows through Prisma; the Supabase client is used only for
   auth/Realtime (or you've *explicitly* added RLS + justified a direct client path).
2. **Client:** server client is lazy, keyed correctly (service-role/anon), service-role never leaves
   the server; the browser holds only the anon key.
3. **Auth:** `auth.getUser` validates the JWT; `{ data, error }` handled; token cached; user
   provisioned idempotently; `req.userId` set; failures surface (401/500), never swallowed.
4. **Realtime** (when used): correct primitive (Broadcast for ticks), publisher in the `worker/`,
   subscriber cleans up on unmount, reconnection considered.
5. **RLS** (if any table is exposed): enabled with per-command `USING`/`WITH CHECK`, ownership via
   `(select auth.uid())`, indexed policy columns, a stated test plan.
6. **Verified:** sign-in works end-to-end; a live tick reaches the UI (or the `supabase-fake` test
   passes — see **backend-testing**).

---

## Bundled References (14 files)

Read the one or two the task needs — never the whole folder.

### Lumina-specific (cite `file:line` in this repo)
| File | Load when |
|------|-----------|
| `lumina-supabase-in-this-repo.md` | The full picture of how Lumina uses Supabase: `client.ts` lazy factory + key choice, `auth.ts` JWT validation/token-cache/provisioning, the Prisma-vs-Supabase division of labor, `supabaseId` on `User`, the providers, pgvector-on-Supabase, the `supabase-fake` seam. Start here. |
| `lumina-supabase-realtime-prices.md` | The live-price path end to end: why the publisher is in the `worker/`, the channel/Broadcast design, `use-live-prices.ts` subscribe + cache-merge + cleanup, market-open caveats, how it composes with **finance-markets**. |

### Platform theory (generic, adapted)
| File | Load when |
|------|-----------|
| `theory-supabase-architecture.md` | Starting out — Postgres-as-platform, PostgREST, GoTrue/Auth, the key model (anon vs service-role), JWT structure, project topology, limits. |
| `theory-row-level-security-model.md` | Before writing any policy — the authorization mental model, `USING` vs `WITH CHECK`, roles, `auth.uid()`/`auth.jwt()`, threat model, and why Lumina enforces authz in Express+Prisma today. |

### Patterns (generic, adapted — annotated with Lumina usage)
| File | Load when |
|------|-----------|
| `patterns-client-setup-and-config.md` | Initializing a client — server vs browser vs Expo, env config, the lazy-init pattern, the service-role caveat, multiple clients, the `{ data, error }` shape. |
| `patterns-auth-flows.md` | Auth — email/password, magic link/OTP, OAuth PKCE (Google/GitHub), sessions, `onAuthStateChange`, `getUser`/`getClaims`, password reset, MFA; mapped to `auth.ts`. |
| `patterns-rls-policies.md` | Authorization in Postgres — ownership/role/claim policies, helper functions, `SECURITY DEFINER`, performance (`(select auth.uid())`, indexes), testing — for if/when Lumina exposes a table. |
| `patterns-realtime.md` | Live features — Postgres Changes vs Broadcast vs Presence, channel lifecycle, RLS authorization, cleanup, scaling; the primitive Lumina uses for live prices. |
| `patterns-storage.md` | Files/images — buckets (public/private), upload/download/list, signed URLs, image transforms, Storage RLS; when it would fit (e.g. lab-report upload) vs the current multimodal path. |
| `patterns-edge-functions.md` | Deno serverless functions — `Deno.serve`, secrets, CORS, JWT verification, webhooks, service-role server-side; and when Lumina uses Express/`worker` instead. |
| `patterns-database-functions-triggers-rpc.md` | `plpgsql` functions, triggers (`handle_new_user`, `updated_at`), `SECURITY DEFINER`/`INVOKER`, `.rpc()`; note Prisma owns the schema here. |
| `patterns-cli-migrations-and-types.md` | The Supabase CLI — local stack, extensions (pgvector), `gen types typescript`, linking; and how it coexists with Prisma owning migrations. |
| `patterns-query-builder-and-mutations.md` | supabase-js `select`/`insert`/`upsert`/`update`/`delete`, filters, embedded selects — generic knowledge, explicitly the *non-default* path in Lumina (Prisma is primary). |
| `resources.md` | Curated official docs, CLI/tooling, type generation, Realtime, and further reading. |

---

## Cross-repo prior art

- **react repo** `E:\Development\Portfolio-phase2\react\.claude\skills\supabase` — the source skill
  these generic references are imported and adapted from (course-app examples re-pointed at Lumina).
- **rareLab** `E:\Development\Portfolio-phase2\Akshay-pooja\rare-lab\.claude\skills\supabase-integration`
  — a second Supabase prior-art skill.
- Project memory: `brand-is-lumina` (never write "Perplexity"), `finance-tab-build` (the live-price
  WebSocket/Realtime architecture). Verify against live code before relying on any `file:line`.
