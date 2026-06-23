# Prisma Driver Adapters and Deployment

> Generic reference: how Prisma 7's driver-adapter model works, which adapter to choose for
> different Postgres hosting scenarios, how to wire connection pooling correctly for serverless
> environments (specifically Supabase + Vercel), and the gotchas that bite in production.
> Lumina's concrete wiring is in `backend/db.ts` and `backend/prisma.config.ts`.

---

## 1. What a Driver Adapter Is and Why Prisma 7 Requires One

In Prisma 6 and earlier, `PrismaClient` shipped with a native query engine binary — a Rust
executable baked into the npm package for each platform. That binary opened its own TCP connection
to the database. `new PrismaClient()` connected automatically; no extra setup was needed.

**Prisma 7 removed the built-in SQL engine binary for PostgreSQL (and all other SQL providers).**
The Client now delegates every SQL execution to a *driver adapter* — a thin shim that wraps a
standard Node.js database driver (`pg`, `@neondatabase/serverless`, etc.) and exposes the
interface Prisma expects. If you call `new PrismaClient()` without passing `{ adapter }`, the
constructor throws at runtime; there is no fallback.

The design change has concrete benefits:

| Old binary engine | New driver-adapter |
|---|---|
| Platform-specific Rust binary (~30 MB) added to every deploy | Zero binary; the adapter is pure JS |
| Opened its own pool — invisible to the host environment | Uses the host driver's pool; fully observable |
| Poor cold-start story on Vercel/Lambda | No spawn time; connection is a JS `new Pool()` call |
| Edge runtimes (Cloudflare Workers) unsupported | Edge adapters (`adapter-neon`, `adapter-ppg`) exist |

The trade-off is one more object to construct, but the ergonomics in practice are a single extra
import:

```typescript
// Prisma 7 — the ONLY correct pattern
import { PrismaClient } from "./prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

---

## 2. Adapter Comparison: adapter-pg vs adapter-neon vs adapter-ppg and Others

### `@prisma/adapter-pg` (Lumina's choice)

Wraps the classic [`pg`](https://node-postgres.com/) npm package. Creates a `Pool` internally
when you pass a `connectionString`. This is the right choice when:

- Your Postgres is a long-lived process (Supabase, RDS, Cloud SQL, self-hosted).
- You are deploying to **Vercel Node runtime** or any standard Node process.
- You want to connect through a PgBouncer-style session or transaction-mode pooler (like
  Supabase's built-in pooler on port 6543).

```bash
bun add @prisma/adapter-pg pg
```

```typescript
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL, // points at the Supabase pooler
  max: 1,                    // one connection per serverless instance (see §5)
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});
```

### `@prisma/adapter-neon`

Wraps `@neondatabase/serverless`, which sends SQL over HTTP/WebSockets instead of a persistent
TCP socket. Use this ONLY when your Postgres is **Neon** and you are deploying to an edge runtime
or a Lambda that prohibits long-lived TCP. Not appropriate for Supabase.

```bash
bun add @prisma/adapter-neon @neondatabase/serverless
```

```typescript
import { PrismaNeon } from "@prisma/adapter-neon";
// Uses HTTP for single queries, WS for transactions
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
```

### `@prisma/adapter-ppg` (Prisma Postgres serverless)

Wraps `@prisma/ppg`, the proprietary Prisma-hosted Postgres offering. Do NOT use with Supabase;
this adapter is purpose-built for the Prisma cloud product and routes connections through Prisma's
own infrastructure.

```typescript
import { PrismaPostgresAdapter } from "@prisma/adapter-ppg";
const prisma = new PrismaClient({
  adapter: new PrismaPostgresAdapter({ connectionString: process.env.PRISMA_DIRECT_TCP_URL }),
});
```

### Other adapters (not used in Lumina)

| Adapter | Driver | Use when |
|---|---|---|
| `@prisma/adapter-mariadb` | `mariadb` | MySQL / MariaDB |
| `@prisma/adapter-better-sqlite3` | `better-sqlite3` | Local SQLite |
| `@prisma/adapter-mssql` | `mssql` | SQL Server |
| `@prisma/adapter-libsql` | `@libsql/client` | Turso / libSQL edge |
| `@prisma/adapter-d1` | Cloudflare D1 | Cloudflare Workers only |

**Lumina rule:** always use `@prisma/adapter-pg` with `DATABASE_URL` pointing at the Supabase
pooler. Never swap to `adapter-neon` or `adapter-ppg` — those change the transport layer and
break the Supabase auth/pooler topology.

---

## 3. Connection Pooling Against Supabase

Supabase exposes **two** Postgres endpoints per project, and they serve different purposes:

### The direct connection (port 5432)

```
postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
```

- Raw TCP to the Postgres primary.
- No pool in front; each connection counts against Postgres's `max_connections` setting (Supabase
  free tier: 60; small plans: 200).
- **Use only for migrations** — a single `prisma migrate deploy` run opens one connection,
  runs DDL, and closes.
- Never point your application at port 5432 — every serverless function invocation would create a
  new Postgres session and your connection slots would be exhausted under any real load.

### The Supabase pooler — PgBouncer in transaction mode (port 6543)

```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

- PgBouncer sits in front of Postgres in **transaction mode**: a backend Postgres connection is
  borrowed for the duration of one transaction, then returned to the pool.
- The pooler itself accepts many concurrent client connections and multiplexes them onto a small
  number of real Postgres connections.
- **Point your application's `DATABASE_URL` here** — this is what `backend/db.ts:6` does via
  `process.env.DATABASE_URL`.

### Wiring both in the same environment

Your `.env` (or Vercel env vars) should define both:

```bash
# Application runtime — goes through the Supabase PgBouncer pooler
DATABASE_URL="postgresql://postgres.xxxx:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres"

# Migration tool — bypasses PgBouncer, connects direct to Postgres
DIRECT_URL="postgresql://postgres:password@db.xxxx.supabase.co:5432/postgres"
```

Prisma's migration CLI (`migrate dev`, `migrate deploy`) needs the direct connection because DDL
statements — `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX CONCURRENTLY` — require a session-level
connection, not a transaction-borrowed one. The CLI is told about `DIRECT_URL` via the schema
(when using `prisma-client-js`) or via the datasource URL in `prisma.config.ts`. In Lumina's
setup (Prisma 7 + `prisma-client` generator) the CLI reads `prisma.config.ts`:

```typescript
// backend/prisma.config.ts:4-12
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"), // swap to DIRECT_URL before running migrations
  },
});
```

When running migrations locally or in CI, set `DATABASE_URL` to the direct URL (port 5432) for
that command only, or add a separate `DIRECT_URL` variable and change `prisma.config.ts`
temporarily. **Never run migrations against the pooler** — DDL via PgBouncer transaction mode can
silently fail or produce partial results.

---

## 4. The Prepared-Statement Caveat With Transaction-Mode Pooling

PgBouncer in transaction mode does **not** support server-side prepared statements. Postgres
prepared statements are session-scoped: the server stores a named plan for the lifetime of the
connection. When PgBouncer reassigns connections between transactions the named plan is gone on
the next connection.

The `pg` driver (used by `@prisma/adapter-pg`) sends queries as simple text by default for
simple queries, and uses the extended protocol (with server-side named statements) for parameterized
queries when `statement_cache_size > 0` (default is 100). This creates a conflict with PgBouncer
transaction mode.

**How `@prisma/adapter-pg` handles it:**

When you pass a `connectionString` to `PrismaPg`, it constructs a `pg.Pool`. By default, the pool
does NOT enable server-side prepared statements; Prisma sends queries over the extended wire
protocol but with unnamed statements (portal name is empty), so PgBouncer does not cache them
across connections.

If you ever construct a raw `pg.Pool` and pass it to `PrismaPg`, ensure
`statement_cache_size: 0` or use the simple query protocol (`pg-native` is a different case).
When using the `connectionString` constructor form, the adapter handles this transparently.

```typescript
// Safe — adapter handles prepared-statement behaviour for PgBouncer transaction mode
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL, // port 6543 / PgBouncer
});

// If you construct a Pool manually (uncommon), disable statement cache
import { Pool } from "pg";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // For PgBouncer transaction mode, pg driver handles this via unnamed portals
  // by default when connectionString is passed — but if you hit issues:
  statement_timeout: 30000,
});
const adapter = new PrismaPg(pool);
```

For `$queryRaw` / `$executeRaw` calls (used for pgvector in Lumina), Prisma also uses the
extended protocol with parameterization; the adapter keeps these statement-safe the same way.

**If you see `ERROR: prepared statement "..." does not exist`:** you have somehow enabled
server-side prepared statements against a pooler in transaction mode. Check that your `DATABASE_URL`
is the pooler endpoint (port 6543), not the direct endpoint (port 5432), because that error only
appears when PgBouncer intercepts a named-statement lifecycle command. Switching the URL back to
the pooler resolves it.

---

## 5. Serverless Cold Starts and Connection-Limit Math at Scale

### The problem

Every Vercel serverless function instance is a separate OS process. If you instantiate
`new PrismaPg({ max: 10 })` in each instance, 50 concurrent instances = 500 Postgres connections.
The Supabase free tier caps at 60 `max_connections`; the Pro tier at 200. You hit the wall long
before you reach interesting traffic.

### The solution: one connection per instance + Supabase pooler

```typescript
// ONE module-level client per process — Vercel isolates per instance
// backend/db.ts:1-10
import { PrismaClient } from "./prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL, // pooler endpoint, port 6543
});

export const prisma = new PrismaClient({ adapter });
```

With `max` unspecified, `pg.Pool` defaults to 10 client slots, but each slot is only opened
lazily on demand. In a short-lived serverless function body that runs one or two queries, the pool
never needs more than 1–2 actual connections.

**For Vercel, set `max: 1`** if you want hard guarantees:

```typescript
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: 1,                       // one real Postgres backend per instance
  idleTimeoutMillis: 8000,      // release before Vercel's 10s idle freeze
  connectionTimeoutMillis: 5000,
});
```

With the Supabase pooler in front, 100 Vercel instances × 1 connection = 100 PgBouncer client
slots, which PgBouncer multiplexes onto perhaps 10–20 real Postgres backends. The math stays
within the Supabase Pro plan's limits even under significant traffic.

### The singleton at the module level

JavaScript module evaluation is synchronous and cached per process. The export in `backend/db.ts`
runs exactly once per Vercel function cold start, regardless of how many request handlers import
it. This is the correct singleton pattern:

```typescript
// backend/db.ts — evaluated once per process; re-exported to every module that imports it
export const prisma = new PrismaClient({ adapter });
```

Never recreate `PrismaClient` inside a request handler or inside a class constructor that gets
called per request. The adapter opens its pool on first use; repeated `new PrismaClient()` calls
create orphaned pools that exhaust connections silently.

### Cold start latency

With `@prisma/adapter-pg` there is no native binary to spawn. The cold start cost is:

1. Module evaluation (parsing the generated client JS) — typically 10–50 ms.
2. First `Pool.connect()` call — TCP handshake + TLS + Postgres auth against the pooler — 20–80 ms
   depending on AWS region proximity.

Total first-request overhead: ~100 ms. Subsequent requests reuse the warm pool slot and add ~1 ms
of Node overhead.

Compare to Prisma 6 with the native binary: spawn + IPC handshake was typically 200–400 ms per
cold start.

---

## 6. Vercel Node Runtime: SSL and NODE_EXTRA_CA_CERTS

### Default SSL behaviour

Supabase Postgres requires TLS. The `pg` driver enables TLS automatically when the connection
string includes `?sslmode=require` or when the host ends in `.supabase.co` / `.pooler.supabase.com`.
Most Supabase connection strings include `?sslmode=require` by default; if yours doesn't, append it:

```
postgresql://postgres.xxxx:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require
```

### Passing SSL config to the adapter

```typescript
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true, // DEFAULT — validate the server cert chain
  },
});
```

Only disable `rejectUnauthorized` in local dev against a self-signed cert, never in production:

```typescript
// LOCAL DEV ONLY — do not commit or deploy
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: true }
    : { rejectUnauthorized: false },
});
```

### Custom CA certificates with NODE_EXTRA_CA_CERTS

If your Postgres host uses a private CA (common with self-hosted, RDS with custom CA, or certain
enterprise configs), Node.js must trust that CA. Rather than patching the adapter, set the
environment variable:

```bash
# In Vercel project settings or .env
NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem
```

Node reads this at startup and adds the PEM-encoded certificates to the trusted CA store.
`@prisma/adapter-pg` inherits the trust because it uses the standard `tls.createSecureContext()`
path. Supabase uses public CAs (Amazon Trust Services for AWS-hosted projects) that are already
in Node's built-in bundle, so `NODE_EXTRA_CA_CERTS` is not required for Supabase.

### Vercel-specific environment variable configuration

In Vercel's project dashboard, set:

| Variable | Value | Environment |
|---|---|---|
| `DATABASE_URL` | Supabase pooler URL (port 6543) | Production, Preview |
| `DIRECT_URL` | Supabase direct URL (port 5432) | Production (CI only — for migrate deploy) |

Do not set `DATABASE_URL` to the direct URL (5432) in the Vercel production environment. Every
function cold start would open a raw Postgres session, bypassing the pooler.

---

## 7. Lumina Wiring: db.ts and prisma.config.ts Annotated

### `backend/db.ts` (full file, 10 lines)

```typescript
// backend/db.ts:1
import { PrismaClient } from "./prisma/generated/prisma/client.js";
// backend/db.ts:2
import { PrismaPg } from "@prisma/adapter-pg";

// backend/db.ts:5-7  — adapter constructed with the DATABASE_URL env var
const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL
})

// backend/db.ts:9-11 — single module-level client export
export const prisma = new PrismaClient({
    adapter
})
```

Key observations:

- **Import path** is `"./prisma/generated/prisma/client.js"` — the `.js` extension is mandatory
  for Vercel's strict ESM resolver. The `prisma-client` generator produces this path because
  `importFileExtension = "js"` is set in `schema.prisma`.
- **No `max` / pool size** is configured explicitly; `pg.Pool` defaults to 10 slots but Vercel
  function bodies rarely need more than 1. For production traffic optimization, consider adding
  `max: 1`.
- **`DATABASE_URL` is expected to be the pooler URL** (port 6543) in production. In local dev it
  can be either, but the pooler URL is recommended for parity.
- There is no `globalThis` dance (no `globalForPrisma`). This is correct for Vercel: each
  function instance is a separate process; no Next.js HMR loop that would instantiate multiple
  clients in one process.

### `backend/prisma.config.ts` (full file, 12 lines)

```typescript
// backend/prisma.config.ts:1
// Generated by Prisma; run Prisma commands with `bun --bun run prisma [command]`
import { defineConfig, env } from "prisma/config";

// backend/prisma.config.ts:4-12
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"), // Prisma CLI reads this variable for migrate commands
  },
});
```

Key observations:

- `env("DATABASE_URL")` is Prisma's typed env-var helper — equivalent to
  `process.env.DATABASE_URL` but checked at config-load time with a typed error.
- For **migrations**, you should override `DATABASE_URL` at the shell level (or swap to a
  `DIRECT_URL`) so the CLI connects direct (port 5432), not through PgBouncer. DDL via PgBouncer
  transaction mode is unsafe.
- The `migrations.path` matches the actual directory `backend/prisma/migrations/`.
- There is no `DIRECT_URL` field here; if you need to cleanly separate migration vs runtime URLs,
  add a second `datasource` key and update `.env` accordingly.

---

## 8. Common Deployment Failure Modes

### "Cannot find module './prisma/generated/prisma/client.js'" at Vercel boot

**Cause:** `prisma generate` was not run before deploy, or was run after the build step that
Vercel cached.

**Fix:** Add `prisma generate` to your build command in Vercel:

```json
// package.json (or vercel.json)
{
  "scripts": {
    "build": "bun --bun run prisma generate && bun run tsc"
  }
}
```

### "PrismaClient is not configured to run in Vercel Edge Runtime"

**Cause:** `@prisma/adapter-pg` uses the `pg` native TCP driver, which requires a Node runtime.
You have deployed to the Vercel **Edge** runtime (Cloudflare Workers under the hood).

**Fix:** Use the Vercel **Node.js** runtime (default for Express/Bun on Vercel). If you truly
need an edge route, switch to `@prisma/adapter-neon` with a Neon database, which uses HTTP/WS
transport compatible with edge environments.

### "Too many connections" / Supabase connection limit exceeded

**Cause:** Multiple `new PrismaPg({ max: 10 })` instances across many concurrent Vercel
invocations have exhausted the Supabase `max_connections` limit.

**Fix:**
1. Set `max: 1` in the adapter options.
2. Verify `DATABASE_URL` points at the pooler (port 6543), not the direct endpoint (port 5432).
3. Check that `prisma` is exported as a module-level singleton in `db.ts`, not instantiated per
   request.

### "ERROR: prepared statement '...' does not exist"

**Cause:** PgBouncer transaction mode received a statement-lifecycle command (`DEALLOCATE`,
`DESCRIBE`) for a named prepared statement after the underlying Postgres connection was returned
to the pool.

**Fix:** This should not occur when using `PrismaPg` with a `connectionString` (the adapter
defaults to unnamed portals). If you see it, you have probably constructed a raw `pg.Pool` with
`statement_cache_size > 0` and passed that pool to `PrismaPg`. Set `statement_cache_size: 0`
on that pool or switch back to passing the connection string directly.

### "New backend file not found after editing schema.prisma"

**Cause:** Bun `--hot` reloading does not pick up new files (including the freshly generated
client) — only edits to existing files.

**Fix:** After every `prisma generate` run, do a full dev-server restart: kill the Bun process
and re-run `bun --hot backend/index.ts` (or your equivalent).

---

## 9. Choosing Between SESSION and TRANSACTION Mode

Supabase's PgBouncer pooler offers two modes. Lumina uses **transaction mode** (the default on
port 6543). Here is when you would ever need session mode instead:

| Feature | Transaction mode (port 6543) | Session mode (port 5432 / special port) |
|---|---|---|
| Prisma queries (non-raw) | Safe | Safe |
| `$queryRaw` / `$executeRaw` | Safe (unnamed portals) | Safe |
| `SET` / `RESET` session vars | Unsafe — lost between queries | Safe |
| Temporary tables | Unsafe — gone after transaction | Safe |
| Server-side prepared statements | Unsafe | Safe |
| Advisory locks (`pg_advisory_lock`) | Unsafe — lock released on connection release | Safe |
| `LISTEN` / `NOTIFY` | Unsupported | Supported |

For Lumina's current query patterns (ORM queries + parameterized `$queryRaw` for pgvector), **transaction mode is correct**. If you ever need advisory locks for distributed locking or `LISTEN`/`NOTIFY` for Realtime fallback (not needed — Supabase Realtime provides that), you would need a separate direct connection for those operations only, not a general switch to session mode.

---

## 10. Quickref: Adapter Install + Wiring Checklist

```bash
# Install (Lumina already has this)
bun add @prisma/adapter-pg pg
```

```typescript
// backend/db.ts — canonical pattern
import { PrismaClient } from "./prisma/generated/prisma/client.js"; // .js required
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL, // pooler URL, port 6543
  // Optional for Vercel serverless:
  // max: 1,
  // idleTimeoutMillis: 8000,
  // connectionTimeoutMillis: 5000,
});

export const prisma = new PrismaClient({ adapter });
```

```prisma
// backend/prisma/schema.prisma — generator block (do not change these fields)
generator client {
  provider             = "prisma-client"   // NOT prisma-client-js
  output               = "./generated/prisma"
  engineType           = "client"
  runtime              = "nodejs"
  importFileExtension  = "js"              // required for Vercel ESM
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  // NOTE: Do NOT add extensions = [vector]; pgvector is managed by Supabase
}
```

```bash
# Environment variables (set in Vercel project settings)
DATABASE_URL=postgresql://postgres.XXXX:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
DIRECT_URL=postgresql://postgres:PASSWORD@db.XXXX.supabase.co:5432/postgres  # migrations only
```

Deployment checklist:
- [ ] `DATABASE_URL` points at pooler (port **6543**) — not 5432
- [ ] `prisma generate` runs before the Vercel build copies files
- [ ] Generated client import ends in `.js`
- [ ] `new PrismaClient({ adapter })` — adapter is always passed
- [ ] No `extensions = [...]` in the datasource block
- [ ] Migrations run against `DIRECT_URL` (port 5432), never through the pooler

---

## See Also

**Within the prisma skill:**
- `lumina-prisma-architecture.md` — full Lumina wiring map, all models, deploy topology
- `lumina-prisma7-adapter-esm.md` — the Prisma 7 generator/ESM/`.js`-extension story in detail
- `lumina-pgvector-and-raw-queries.md` — the `embedding Unsupported("vector(1536)")` column and
  `$queryRaw` path
- `prisma-migrations-and-cli.md` — migration workflow, the Supabase extension-drift trap, and
  when to use `DIRECT_URL`
- `prisma-performance-and-rscale.md` — connection-limit math at scale, R-SCALE §C read spikes
- `prisma-testing-and-mocking.md` — mocking `PrismaPg` and `PrismaClient` in `bun:test`

**Other skills:**
- `supabase` — Supabase auth, RLS, Realtime; the `backend/client.ts` Supabase client (auth only)
- `redis` — Upstash hot cache (`backend/lib/cache.ts`); a separate store from Postgres
- `rag-retrieval` — semantic-cache retrieval algorithm that runs queries over the pgvector column
- `backend-testing` — test harness, `prisma-fake.ts` seam, Supabase fake, fetch mocks
- `connectors-oauth` — AES-GCM token vault stored in the `GmailConnection` row
- `lumina-frontend` — TanStack Query hooks that consume the backend routes
