# Supabase Architecture — Postgres-as-a-Platform, Keys, JWTs, and the Topology That Matters

> Generic reference: teaches the Supabase mental model transferable to any project. Lumina examples
> are drawn from `backend/client.ts` and `backend/auth.ts` to make the abstractions concrete.

---

## Table of Contents

1. [What Supabase Is: One Diagram in Words](#1-what-supabase-is-one-diagram-in-words)
2. [The Key Model: Anon vs Service-Role](#2-the-key-model-anon-vs-service-role)
3. [The JWT: Structure, Claims, and What auth.uid()/auth.jwt() Resolve To](#3-the-jwt-structure-claims-and-what-authuid-authjwt-resolve-to)
4. [Project Topology, Regions, and the Two Connection Paths](#4-project-topology-regions-and-the-two-connection-paths)
5. [Pricing and Limits at a High Level](#5-pricing-and-limits-at-a-high-level)
6. [How Lumina Uses a Deliberate Subset](#6-how-lumina-uses-a-deliberate-subset)
7. [Decision Table: Which Supabase Surface for Which Job?](#7-decision-table-which-supabase-surface-for-which-job)
8. [Anti-Patterns](#8-anti-patterns)
9. [See Also](#9-see-also)

---

## 1. What Supabase Is: One Diagram in Words

Supabase is not a single product — it is a thin coordination layer that provisions and wires together
several open-source services, all sharing one Postgres database. Understanding which service handles
each request tells you where to look when something breaks and which key/role it runs under.

```
Your App (browser / server)
        │
        │  HTTPS
        ▼
┌───────────────────────────────────────────────────────────────┐
│                     Supabase Project                          │
│                                                               │
│  ┌─────────────────┐   ┌──────────────────────┐              │
│  │  PostgREST       │   │  GoTrue (Auth)        │              │
│  │  (auto REST API) │   │  /auth/v1/*           │              │
│  │  /rest/v1/*      │   │  Issues JWTs          │              │
│  └────────┬─────────┘   └──────────┬────────────┘             │
│           │ SQL                    │ SQL (auth schema)         │
│           ▼                        ▼                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Postgres 15/16                        │   │
│  │   public.*  │  auth.*  │  storage.*  │  realtime.*     │   │
│  │   pgvector  │  pg_cron │  pg_net     │  pg_trgm …      │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │                                  │
│  ┌──────────────────────────┼──────────────────────────────┐   │
│  │  Realtime Server         │                              │   │
│  │  (ws://realtime.*)       │                              │   │
│  │  Postgres Changes        │                              │   │
│  │  Broadcast, Presence     │                              │   │
│  └──────────────────────────┼──────────────────────────────┘   │
│                             │                                  │
│  ┌──────────────────────────┼──────────────────────────────┐   │
│  │  Storage (S3-compatible) │  Edge Functions (Deno)       │   │
│  │  /storage/v1/*           │  /functions/v1/*             │   │
│  └──────────────────────────┴──────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

### The six services and their jobs

| Service | Open-source base | What it does | When you touch it |
|---|---|---|---|
| **PostgREST** | PostgREST | Auto-generates a REST API from your Postgres schema. Every `supabase.from('table').select(...)` call goes here. Respects RLS. | Direct table reads/writes from the SDK. |
| **GoTrue (Auth)** | GoTrue by Netlify, forked | Issues JWTs for email/password, magic link, OAuth (PKCE). Manages user rows in the `auth.users` table. Handles token refresh via rotating refresh tokens. | `supabase.auth.*` calls, sign-in/sign-up, token validation. |
| **Realtime** | Phoenix Channels | Multiplexes three primitives over WebSockets: **Postgres Changes** (WAL-based row CDC), **Broadcast** (ephemeral pub/sub), and **Presence** (shared online state). | Live feeds — finance ticks, collaborative cursors, chat. |
| **Storage** | A Go service backed by S3 (or self-hosted S3-compatible) | Buckets, objects, access policies, image transforms (via Imgproxy). | File uploads, avatars, documents, media. |
| **Edge Functions** | Deno runtime, deployed to Deno Deploy under the hood | Server-side Deno code at the edge — webhooks, custom auth hooks, background jobs too small for a full server. | Extending the platform without a separate server. |
| **Postgres** | Postgres 15/16 | The source of truth underneath everything. The `auth`, `storage`, `realtime`, `extensions` schemas co-exist with your `public` schema. | Schema migrations, SQL functions, triggers, raw queries. |

The supabase-js SDK is a thin client library that routes calls to the right service. There is no
"Supabase backend" in the traditional sense — it is Postgres plus proxies.

---

## 2. The Key Model: Anon vs Service-Role

Every Supabase project gets two JWTs minted from a project secret at creation time:

| Key | Postgres role it sets | Who holds it | What RLS sees | Can it bypass RLS? |
|---|---|---|---|---|
| **`anon`** (public) | `anon` | Browser, mobile, public clients | `auth.uid()` = NULL (unauthenticated) or the user's UUID after sign-in | No — fully bound by RLS |
| **`service_role`** | `service_role` | Server only, never shipped to a client | Bypasses RLS entirely | **Yes — complete bypass** |

### How the anon key works after sign-in

When a user signs in through GoTrue, the SDK stores the resulting access JWT (signed by GoTrue) in
the client's session storage. On subsequent `supabase.from(...)` calls, the SDK sends that JWT as
`Authorization: Bearer <token>`, not the anon key. PostgREST validates the JWT and sets
`auth.uid()` to the user's UUID so RLS policies can use it.

The anon key is essentially a credential for the `anon` role when no user is signed in. It is
embedded in client bundles, committed to mobile apps, and indexed by crawlers — it is public by
design. Security comes from RLS policies restricting what the `anon` and `authenticated` roles can
reach.

### The service-role key bypasses every policy

The service-role key is a signed JWT that PostgREST accepts as the `service_role` Postgres role.
That role has `BYPASSRLS` and `SUPERUSER`-equivalent access to the data layer. **A leaked
service-role key is a full data breach.** Rules for handling it:

- Store it only in server-side environment variables (`SUPABASE_API_SECRET` / `SERVICE_ROLE_KEY`).
- Never embed it in a `VITE_*` prefix, `NEXT_PUBLIC_*`, or any variable that might reach the client
  bundle.
- Never log it, commit it, or return it in API responses.
- Rotate it immediately if exposed. Supabase Dashboard → Project Settings → API → Regenerate.

### When to use each key on the server

The service-role key is necessary when your server code must act on behalf of users without going
through RLS — bulk operations, admin mutations, reading rows not owned by the caller. But many
server uses need only the anon key: validating a user's JWT with `auth.getUser(token)` works with
either key, since GoTrue authenticates the call server-to-server rather than through PostgREST.

```ts
// backend/client.ts — Lumina accepts either key for auth.getUser calls
// (neither path ever queries user-data tables through this client)
const key = process.env.SUPABASE_API_SECRET ?? process.env.SUPABASE_KEY;
```
`backend/client.ts:14`

The comment in that file is precise: "the service key's RLS-bypass isn't needed here" because the
client is only used to validate tokens — the actual data layer is Prisma over a direct Postgres
connection that bypasses PostgREST entirely.

---

## 3. The JWT: Structure, Claims, and What auth.uid()/auth.jwt() Resolve To

Every Supabase access token is a standard JWT (`typ: JWT`, `alg: HS256` on legacy projects, or
`ES256`/`RS256` on modern projects with asymmetric signing).

### 3.1 Standard JWT structure

```
Header.Payload.Signature

Header:
{
  "alg": "HS256",   // or "ES256" on new projects
  "typ": "JWT"
}

Payload (access token issued by GoTrue):
{
  "iss": "https://<project>.supabase.co/auth/v1",
  "sub": "a3b7c1d4-...",          // user UUID — this is auth.uid()
  "aud": "authenticated",          // role PostgREST will use
  "exp": 1719000000,               // 1 hour from issue by default
  "iat": 1718996400,
  "email": "user@example.com",
  "phone": "",
  "app_metadata": {
    "provider": "google",          // or "github", "email", …
    "providers": ["google"]
  },
  "user_metadata": {
    "full_name": "Ada Lovelace",
    "avatar_url": "https://..."
  },
  "role": "authenticated",         // the Postgres role
  "aal": "aal1",                   // Assurance Assurance Level (aal2 = MFA verified)
  "amr": [{ "method": "oauth", "timestamp": 1718996400 }],
  "session_id": "e9f3...",
  "is_anonymous": false
}
```

### 3.2 What auth.uid() and auth.jwt() resolve to in Postgres

These are stable functions defined in the `auth` schema that PostgREST sets up when it processes
each request:

```sql
-- Returns the `sub` claim as a UUID — the user's primary key in auth.users
SELECT auth.uid();   -- → 'a3b7c1d4-...'::uuid, or NULL for unauthenticated

-- Returns the entire payload as jsonb
SELECT auth.jwt();   -- → '{"sub":"a3b7c1d4-...", "role":"authenticated", ...}'::jsonb

-- Access nested claims
SELECT auth.jwt() -> 'app_metadata' ->> 'provider';  -- → 'google'
SELECT auth.jwt() ->> 'email';                        -- → 'user@example.com'
SELECT (auth.jwt() ->> 'aal') = 'aal2';              -- → false (no MFA)
```

RLS policies call these functions to make per-row authorization decisions. The `(select auth.uid())`
form (with the scalar subquery wrapper) is a Postgres optimization — it evaluates the function once
per statement rather than once per row, which is critical for large tables.

### 3.3 The refresh token and rotation

The access token is short-lived (1 hour). When it expires, the SDK automatically exchanges the
opaque refresh token for a new access + refresh pair. Refresh tokens are single-use and rotate on
every exchange — a consumed refresh token is invalidated, preventing replay. This is why you must
store the full session object (both tokens), not just the access token.

### 3.4 Verifying a JWT on your server

On Lumina's Express backend, `auth.getUser(token)` is the verification path. This makes a network
call to the GoTrue `/user` endpoint, which validates the token signature and returns the user object:

```ts
// backend/auth.ts:47
const data = await getClient().auth.getUser(token);
const user = data.data.user;
if (!user) return res.status(401).json({ error: "unauthorised" });
```

Modern supabase-js 2.x also exposes `auth.getClaims()` for **local JWT verification** using the
project's public JWKS (no network round-trip). For a server middleware that runs on every request,
local verification is faster — see `patterns-auth-flows.md` for the tradeoff. Lumina currently uses
`getUser` (network) and offsets the cost with an in-process token cache:

```ts
// backend/auth.ts:28-43 — 5-minute cache cuts Supabase round-trips on repeat requests
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map<string, { userId: string; expiresAt: number }>();

const cached = tokenCache.get(token);
if (cached && cached.expiresAt > Date.now()) {
  req.userId = cached.userId;
  return next();
}
```

---

## 4. Project Topology, Regions, and the Two Connection Paths

### 4.1 Project structure

A Supabase **organization** contains one or more **projects**. Each project is an isolated unit:

- Its own Postgres instance (dedicated compute pod on the free tier; dedicated or performance-tuned
  pods on paid plans).
- Its own GoTrue instance, Realtime server, PostgREST proxy.
- Its own API keys, project reference (`ref`), and API URL
  (`https://<ref>.supabase.co`).
- Entirely separate from other projects — no cross-project SQL joins, no shared connection pools.

Projects can be paused (free tier: 1 week of inactivity; paid: never auto-paused). A paused project
causes all requests to 503 until unpaused from the dashboard.

### 4.2 Regions

Supabase projects are deployed to a single AWS region (chosen at creation). As of mid-2025 the
available regions include: `us-east-1`, `us-west-1`, `eu-west-1`, `eu-central-1`,
`ap-southeast-1`, `ap-northeast-1`, `ap-south-1`, `sa-east-1`, `ca-central-1`, and more.

**You cannot change a project's region after creation.** If your users are in a different geography,
create the project in their nearest region to minimize latency. Supabase does not yet offer
multi-region replication for the database (as of 2025); that is on the roadmap.

### 4.3 The two Postgres connection paths

Every Supabase project exposes Postgres through two connection mechanisms, and choosing the wrong one
is a common source of `FATAL: remaining connection slots reserved` errors in serverless deployments.

```
Path 1: Direct Connection (raw TCP, port 5432)
──────────────────────────────────────────────
Your server ──TCP:5432──▶ Postgres

Host:     db.<ref>.supabase.co
Port:     5432
User:     postgres (or a Postgres role you created)
Database: postgres
SSL:      required

Characteristics:
• Full Postgres feature set: LISTEN/NOTIFY, COPY, cursors, prepared statements,
  extended query protocol, advisory locks.
• Every connection holds a slot in Postgres's max_connections pool.
• On the free tier max_connections ≈ 60–90.
• Long-running servers (Node, Bun) typically use a connection pool (pg Pool,
  Prisma's own pooling, or PgBouncer) and hold a small fixed number of connections.
• AVOID in Lambda / Vercel serverless — each cold start opens new connections and
  they accumulate faster than they are closed, exhausting the pool under traffic.

Path 2: Connection Pooler (Supavisor / PgBouncer, port 6543)
──────────────────────────────────────────────────────────────
Your server ──TCP:6543──▶ Supavisor ──▶ Postgres pool

Host:     aws-0-<region>.pooler.supabase.com
Port:     6543
User:     postgres.<ref>    (note the dotted format for Supavisor)
Database: postgres

Characteristics:
• Supavisor (Supabase's Elixir-based connection pooler; replaced PgBouncer) sits in
  front of Postgres and multiplexes many application connections over a small, stable
  pool of real Postgres connections.
• In TRANSACTION mode (the default): a Postgres connection is held only for the
  duration of a transaction, then returned to the pool. Suitable for short-lived
  serverless requests.
• In SESSION mode: the Postgres connection is held for the life of the client
  connection — better for prepared statements but wastes connections.
• Prepared statements are NOT supported in transaction-mode pooling (they are
  connection-scoped). Prisma with connection pooling must use `pgbouncer = true` in
  the connection string or switch to the query protocol.
• RECOMMENDED for Vercel / Lambda / any bursty serverless deployment.
```

**Lumina on Vercel uses the direct connection string via `DATABASE_URL`**, with Prisma's `@prisma/adapter-pg`
managing a `pg.Pool` internally (`backend/db.ts:5`). This works on Vercel because each serverless function
invocation re-uses connections from the pool that `pg` maintains within the function's warm instance. If
connection exhaustion becomes an issue at scale, switch `DATABASE_URL` to the pooler URL (port 6543)
and add `?pgbouncer=true&connection_limit=1` to the Prisma connection string.

### 4.4 The API URL and the Dashboard URL

```
API base:     https://<ref>.supabase.co
Auth:         https://<ref>.supabase.co/auth/v1
PostgREST:    https://<ref>.supabase.co/rest/v1
Realtime:     wss://<ref>.supabase.co/realtime/v1
Storage:      https://<ref>.supabase.co/storage/v1
Edge Fn:      https://<ref>.supabase.co/functions/v1
Dashboard:    https://app.supabase.com/project/<ref>
```

---

## 5. Pricing and Limits at a High Level

> Numbers accurate as of mid-2025. Always verify at supabase.com/pricing — tiers and limits change.

| Dimension | Free | Pro ($25/mo) | Team ($599/mo) | Enterprise |
|---|---|---|---|---|
| **Projects** | 2 active | Unlimited | Unlimited | Unlimited |
| **Postgres storage** | 500 MB | 8 GB (+ $0.125/GB) | 8 GB+ | Negotiated |
| **Database compute** | Shared (micro) | 2 CPU / 1 GB RAM (Starter), scalable | Scalable | Dedicated |
| **Auth MAU** | 50,000 | 100,000 (+ $0.00325/user) | 100,000+ | Negotiated |
| **Realtime messages** | 2M/month | 5M/month | More | Negotiated |
| **Storage** | 1 GB | 100 GB (+ $0.021/GB) | 100 GB+ | Negotiated |
| **Edge Function invocations** | 500,000/month | 2M/month | More | Negotiated |
| **Bandwidth** | 5 GB | 250 GB (+ $0.09/GB) | More | Negotiated |
| **Backups** | None | Daily (7-day PITR on higher plans) | Point-in-time | Negotiated |
| **Pause on inactivity** | Yes (1 week) | No | No | No |

### The limits that bite first in production

**max_connections (Postgres):** The free tier Postgres pod has ~60 connections; a Starter Pro pod
has ~200. Each connection holds ~5–10 MB of shared memory. Serverless deployments that open
connections per invocation hit this ceiling quickly — use the pooler URL.

**Auth MAU (Monthly Active Users):** A "monthly active user" is one who calls a GoTrue endpoint
(sign-in, token refresh, password reset) at least once in the billing period. Users who don't call
the auth API — e.g. returning users whose access token is still valid — do not count. The 50,000
free-tier MAU limit is generous for early-stage products.

**Realtime:** The free tier caps at 200 concurrent connections and 2M messages per month. A single
user watching a live finance ticker generates roughly one message per second = 86,400/day = 2.6M/month —
exceeding the free tier on its own. Plan for Pro before launching live-data features.

**Row-level storage (PostgREST):** No row count limit. Limits are on the underlying Postgres
compute (CPU, I/O), which determines query latency at scale. At 1M+ rows, unindexed queries scan
the table; index the columns in your RLS policies and WHERE clauses.

---

## 6. How Lumina Uses a Deliberate Subset

Lumina's architecture makes a conscious choice: **Supabase is the auth + Realtime transport layer
only. Prisma owns persistent data.** This section explains the four surfaces Lumina uses, one it
deliberately avoids, and the rationale.

### 6.1 Surface 1: GoTrue for JWT issuance (auth)

The frontend signs users in via Google or GitHub OAuth. GoTrue issues a JWT. Lumina accepts two
OAuth providers, encoded in the `AuthProvider` enum in the schema:

```prisma
// backend/prisma/schema.prisma:107-110
enum AuthProvider {
  Github
  Google
}
```

The `app_metadata.provider` claim in the JWT tells Lumina which was used:

```ts
// backend/auth.ts:62
provider: user.app_metadata.provider === "google" ? "Google" : "Github",
```

### 6.2 Surface 2: auth.getUser() for JWT validation

Every authenticated Express route calls the auth middleware in `backend/auth.ts`. The middleware
validates the JWT against GoTrue (`auth.getUser(token)`) and writes `req.userId`. PostgREST and RLS
are not in the path — Lumina never queries tables through supabase-js.

The lazy client pattern prevents a missing env var from crashing public routes at boot:

```ts
// backend/auth.ts:11-15
let _client: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (!_client) _client = createSupabaseClient();
  return _client;
}
```

This is the pattern to copy whenever you build a server-side Supabase client in a serverless or
long-running process that has public routes: build the client only when you need it, not at module
load time.

### 6.3 Surface 3: Realtime as the live-price transport

The Lumina `worker/` (Fly.io) connects to Supabase Realtime and **broadcasts** live price ticks to
a named channel. The browser subscribes to the same channel with a `createClient` using the public
anon key. Because the ticks are ephemeral (no DB row written), **Broadcast** is the correct
primitive — Postgres Changes would write to WAL for every tick, which is wasteful and slower.

```
Finnhub WS ──tick──▶ worker/ (Fly.io) ──Broadcast──▶ Supabase Realtime ──WS──▶ Browser
                      (publisher)                      (relay)               (subscriber)
```

Vercel serverless functions cannot hold WebSocket connections or long-lived timers (see
`rules/vercel-no-sockets-no-timers.md`). The `worker/` on Fly.io is the correct location for the
publisher. See `lumina-supabase-realtime-prices.md` for the full implementation.

### 6.4 Surface 4: pgvector on the same Postgres

The `CachedQuery` model stores 1536-dimension embeddings for the semantic cache. The `vector`
extension is enabled at the Supabase project level (Dashboard → Database → Extensions, or
`CREATE EXTENSION vector`), **not** managed by Prisma:

```prisma
// backend/prisma/schema.prisma:16-22 — note the explicit WARNING
datasource db {
  provider = "postgresql"
  // NOTE: pgvector is enabled directly in Supabase (Dashboard → Database → Extensions,
  // or `CREATE EXTENSION vector`). We deliberately do NOT let Prisma manage extensions
  // (`extensions = [...]`) — on Supabase that makes `prisma migrate dev` flag Supabase's
  // own pre-installed extensions as "drift" and threaten a destructive reset.
}
```

The `embedding` column uses `Unsupported("vector(1536)")`, meaning Prisma generates the migration
column type correctly but does not provide typed accessors. All queries against this column use
`prisma.$queryRaw` or `prisma.$executeRaw`.

### 6.5 What Lumina deliberately does NOT use

| Supabase feature | Lumina stance | Rationale |
|---|---|---|
| **PostgREST (supabase.from(...))** | Not used for app data | Prisma provides type-safe queries with better TypeScript integration, migration history, and no RLS complexity for server-side calls. |
| **Row Level Security** | Not configured on app tables | Authorization is enforced in the Express middleware (`req.userId` gate) and Prisma queries (`where: { userId: req.userId }`). This is a valid approach when all data access goes through a trusted server. If a table is ever exposed to the anon/authenticated Postgres role via PostgREST, RLS must be added. |
| **Storage** | Not currently used | Health document uploads are handled via multipart form data directly to the Express backend. |
| **Edge Functions** | Not currently used | Logic lives in Express (Vercel) and Fly.io worker. |
| **DB functions / triggers** | Not currently used | User provisioning is done in Express (`auth.ts` upsert), not via a `handle_new_user` trigger. |

The division of labor is clean: **Supabase = identity provider + Realtime relay + Postgres host.
Prisma = all application data.**

### 6.6 The supabase-fake test seam

In tests, `backend/tests/helpers/supabase-fake.ts` replaces the Supabase client. The fake
implements `auth.getUser(token)` and returns a controlled user object, so middleware tests never hit
the network. See `backend-testing` skill for wiring details.

---

## 7. Decision Table: Which Supabase Surface for Which Job?

| Task | Use this surface | Notes |
|---|---|---|
| Sign a user in / up | GoTrue — `supabase.auth.signInWithOAuth`, `signInWithPassword` | Browser-side; see `patterns-auth-flows.md`. |
| Validate a user's JWT on the server | GoTrue — `supabase.auth.getUser(token)` or `getClaims()` | `getUser` = network verify; `getClaims` = local JWKS verify (faster). |
| Read/write app data | **Prisma** — not Supabase | Prisma owns persistent tables in Lumina. |
| Push ephemeral events to many browsers | Realtime **Broadcast** | Low latency, no WAL write, pub/sub semantics. |
| Notify browsers of a committed DB row change | Realtime **Postgres Changes** | Fires after WAL write; slightly higher latency than Broadcast. |
| Track who is online ("user X is typing") | Realtime **Presence** | Shared state synced over Realtime; suitable for collaborative features. |
| Store user-uploaded files | **Storage** | Buckets + RLS policies on `storage.objects`. |
| Run server-side logic close to the database | **Edge Functions** | Deno runtime; can use the service-role key safely. |
| Extend DB with custom logic (triggers, computed cols) | **DB Functions** | plpgsql; see `patterns-database-functions-triggers-rpc.md`. |
| Cosine similarity search over embeddings | **pgvector** via `$queryRaw` | Enable extension in Supabase; manage column via Prisma `Unsupported`. |

---

## 8. Anti-Patterns

| Anti-pattern | Correct approach |
|---|---|
| **Creating the server Supabase client at module load** | Lazy singleton — only build it when the first auth'd request arrives. A bad env var must not crash public routes. |
| **Sending the service-role key to the browser** | Service-role belongs in server env vars only. The browser holds the anon key. |
| **Querying app tables through supabase-js on the server** | Use Prisma. PostgREST adds a network hop, requires RLS reasoning, and gives up Prisma's type safety. |
| **Using Postgres Changes for high-frequency ephemeral data** | Use Broadcast. Changes write to WAL on every row mutation; for 10 ticks/second across 100 tickers that is 1,000 WAL writes/second. |
| **Opening direct Postgres connections (port 5432) in serverless** | Use the Supabase connection pooler (port 6543) with `?pgbouncer=true`. Direct connections accumulate and exhaust `max_connections`. |
| **Managing pgvector via Prisma `extensions=[]`** | Enable the extension in Supabase Dashboard or `CREATE EXTENSION`. Let Prisma see the column as `Unsupported`. |
| **Treating the anon key as a secret** | The anon key is public by design. Security comes from RLS policies and server-side authorization. |
| **Ignoring `{ data, error }` results** | supabase-js never throws on auth/query errors — always destructure and check `error`. |
| **Long-lived socket/Realtime publisher in a Vercel route** | Move the publisher to the `worker/` on Fly.io; Vercel functions cannot hold long-lived connections. |
| **Re-verifying the same JWT against GoTrue on every request** | Cache `token → userId` for a short TTL (5 minutes). See `backend/auth.ts`. |

---

## 9. See Also

**Within this skill (`supabase`):**
- `lumina-supabase-in-this-repo.md` — exact file-by-file breakdown of how Lumina uses Supabase
- `lumina-supabase-realtime-prices.md` — the live-price Broadcast path end to end
- `theory-row-level-security-model.md` — the RLS mental model: USING vs WITH CHECK, roles, threat model
- `patterns-client-setup-and-config.md` — initializing server vs browser vs Expo clients
- `patterns-auth-flows.md` — email/password, magic link, OAuth PKCE, `onAuthStateChange`
- `patterns-realtime.md` — Postgres Changes vs Broadcast vs Presence, channel lifecycle
- `patterns-storage.md` — buckets, signed URLs, Storage RLS
- `patterns-edge-functions.md` — Deno functions, CORS, JWT verification, webhooks
- `patterns-database-functions-triggers-rpc.md` — triggers, `handle_new_user`, `.rpc()`
- `patterns-cli-migrations-and-types.md` — CLI, local stack, type generation, pgvector setup
- `resources.md` — official docs, changelog, community links

**Other skills:**
- `prisma` — owns schema.prisma, migrations, Prisma client usage, pgvector migrations
- `rag-retrieval` — the semantic cache algorithm over `CachedQuery`; cosine similarity logic
- `finance-markets` — the market-data domain that rides over the Realtime transport
- `connectors-oauth` — Gmail OAuth (a separate Google grant, not Supabase auth)
- `backend-testing` — how to wire `supabase-fake` into test suites
- `lumina-frontend` — sign-in UI components, auth context, the browser Supabase client
