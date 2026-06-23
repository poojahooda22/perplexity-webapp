# Supabase Client Setup & Configuration

> Creating and configuring `supabase-js` clients correctly across browser, server (Node/Express), and Expo/React Native contexts — the right keys, lazy initialization, auth options, and the `{ data, error }` contract. Generic teaching; Lumina's `backend/client.ts` and `backend/auth.ts` are the worked examples.

---

## 1. The Client Is Your Entire Surface Area

Every interaction with Supabase — querying tables, calling RPC, signing in, uploading files, subscribing to Realtime — flows through the object returned by `createClient`. Getting that object right is not boilerplate; it is the load-bearing configuration decision for the whole integration.

A misconfigured client produces a long tail of symptoms that are hard to diagnose later: silent token-refresh failures, "Multiple GoTrue instances detected" warnings, sessions that vanish on reload, sessions that *persist* on a shared server request and leak between users, and PKCE codes that are never exchanged.

`@supabase/supabase-js` v2 is a façade over four sub-clients:

| Accessor | Sub-client | Backing service |
|----------|-----------|-----------------|
| `supabase.from(...)`, `.rpc(...)` | `PostgrestClient` | PostgREST (SQL over HTTP) |
| `supabase.auth` | `GoTrueClient` | GoTrue / Auth (JWTs, sessions, refresh) |
| `supabase.channel(...)` | `RealtimeClient` | Realtime (Postgres Changes, Broadcast) |
| `supabase.storage` | `StorageClient` | Storage (buckets, signed URLs) |

The Postgrest, Realtime, Storage, and Functions sub-clients all read the current access token from the GoTrue client. When a user signs in, GoTrue emits a new token; the other sub-clients pick it up so subsequent queries run as `authenticated` and RLS sees `auth.uid()`. This coupling is why you must have *exactly one* GoTrue instance per logical session context.

> **Version anchor.** This doc targets `@supabase/supabase-js` **2.x**. The default auth flow is PKCE. Query/mutation calls return `{ data, error }` and **never throw on database errors**. Local JWT verification is via `auth.getClaims()`.

---

## 2. Anatomy of `createClient`

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(supabaseUrl, supabaseKey, options)
```

| Argument | Type | What it is |
|----------|------|-----------|
| `supabaseUrl` | `string` | `https://<project-ref>.supabase.co`. Found in Dashboard → Project Settings → API. |
| `supabaseKey` | `string` | The API key sent as `apikey` header and default `Authorization`. **anon** for clients; **service_role** for trusted servers. |
| `options` | `SupabaseClientOptions` | Auth, global, db, realtime tuning. Optional but almost always needed for `auth.*`. |

The options shape (fields you actually touch):

```ts
interface SupabaseClientOptions<SchemaName> {
  auth?: {
    autoRefreshToken?: boolean       // default true
    persistSession?: boolean         // default true
    detectSessionInUrl?: boolean     // default true — set false in Node and RN
    flowType?: 'implicit' | 'pkce'  // default 'pkce'
    storage?: SupportedStorage       // default localStorage in browsers
    storageKey?: string              // default sb-<project-ref>-auth-token
    debug?: boolean
  }
  global?: {
    headers?: Record<string, string>
    fetch?: typeof fetch
  }
  db?: {
    schema?: SchemaName              // default 'public'
  }
  realtime?: RealtimeClientOptions
  accessToken?: () => Promise<string | null> // custom auth bridge (Clerk, own JWTs)
}
```

The key insight: **the same `createClient` function builds every flavor of client.** A browser SPA client, a per-request SSR client, a service-role admin client, and a React Native client differ only in their *key* and *options*. Internalize the options and you can construct any client correctly.

---

## 3. The Three Keys: anon, service_role, publishable/secret

Supabase API keys determine the **default Postgres role** before any user JWT is applied.

| Key | Default role | RLS | Where it lives |
|-----|-------------|-----|----------------|
| `anon` / `sb_publishable_…` | `anon` → upgrades to `authenticated` once a user JWT is attached | **Enforced** | Browsers, mobile, any public surface |
| `service_role` / `sb_secret_…` | `service_role` | **Bypassed entirely** | Trusted servers only |

Two truths that govern every decision in this file:

**1. The anon key is public by design.** It ships in your client bundle and is visible in DevTools. Security does not come from hiding it; it comes from Row Level Security policies. If data is exposed when someone reads the anon key, your RLS is missing or wrong — the key is not the vulnerability.

**2. The service_role key bypasses RLS completely.** It is a master key for your entire database. It must never appear in a browser bundle, a mobile binary, a `VITE_` env var, a public repo, a stack trace returned to a client, or a log shipped to a third party.

How the role is established per request:

```
Request → apikey header (anon | service_role) sets the DEFAULT role
        → Authorization: Bearer <jwt>
              ├── no JWT  → role = anon
              ├── user JWT → role = authenticated, auth.uid() = sub claim
              └── service_role key → role = service_role (RLS bypassed)
```

> **Key-format note.** Supabase is migrating from JWT-style `anon`/`service_role` keys to prefixed `sb_publishable_*`/`sb_secret_*` keys (rotatable). Treat `publishable ≈ anon` and `secret ≈ service_role`. Role semantics are unchanged.

---

## 4. Env Configuration: Which Key Goes Where

### 4.1 Vite (the React + Vite SPA frontend)

Vite inlines only variables prefixed `VITE_` into the client bundle. Anything else is unavailable in the browser — which is exactly what you want for secrets.

```bash
# frontend/.env.local  (gitignored)
VITE_SUPABASE_URL=https://rgwdybuczqcoenmxmosd.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...     # public by design
# NO service-role key here. Ever.
```

```ts
// src/lib/env.ts — fail fast, narrow the type once
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('Missing Supabase env. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local')
}

export const SUPABASE_URL = url
export const SUPABASE_ANON_KEY = anonKey
```

Type `import.meta.env` so TypeScript knows these are strings:

```ts
// src/vite-env.d.ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
}
interface ImportMeta { readonly env: ImportMetaEnv }
```

The fail-fast check is not ceremony. `createClient(undefined, undefined)` produces a client that silently works until the first request, then fails with an opaque network error. Throwing at module load points you straight at the missing variable.

### 4.2 Node / Bun Express server (Lumina's backend)

On the server there is no public-prefix protection — all `process.env.*` is server-side only. This is where the service-role key (if used) lives.

```bash
# backend .env  (gitignored)
SUPABASE_URL=https://rgwdybuczqcoenmxmosd.supabase.co
SUPABASE_API_SECRET=eyJhbGci...   # service-role key (bypasses RLS)
# OR
SUPABASE_KEY=eyJhbGci...          # anon key (Lumina's auth.ts accepts either)
```

Lumina's `backend/client.ts` accepts either key because the client is used *only* for `auth.getUser(token)` — JWT validation — not for querying user data (Prisma owns the DB). Either key can authenticate that call:

```ts
// backend/client.ts:7-20
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://rgwdybuczqcoenmxmosd.supabase.co"

export function createSupabaseClient() {
  const key = process.env.SUPABASE_API_SECRET ?? process.env.SUPABASE_KEY
  if (!key) {
    throw new Error(
      "Supabase key missing: set SUPABASE_API_SECRET (service role) or SUPABASE_KEY (anon)"
    )
  }
  return createClient(SUPABASE_URL, key)
}
```

### 4.3 Expo / React Native (mention only)

Expo exposes env vars to the JS bundle only when prefixed `EXPO_PUBLIC_`. Like `VITE_`, this is a public prefix — the value ships in the app binary and is extractable. The anon key is fine here; the service-role key is not. Deep-link/OAuth wiring is in the Expo-specific skill.

```bash
EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
```

### 4.4 Key placement summary

| Location | anon / publishable | service_role / secret |
|----------|-------------------|----------------------|
| `VITE_*` env / browser bundle | ✅ yes | ❌ never |
| `EXPO_PUBLIC_*` / mobile binary | ✅ yes | ❌ never |
| Server `process.env` (Express/Node/Bun) | ✅ yes | ✅ yes |
| Edge Function secret (`Deno.env`) | ✅ yes | ✅ yes |
| Committed to git | ❌ no (gitignore) | ❌ absolutely never |
| Returned in a response / error to a client | ❌ no | ❌ never |

---

## 5. The Lazy Server-Client Pattern — Lumina's Critical Gotcha

**Never construct the Supabase client at module load time in a serverless or Express entry point.**

When `backend/index.ts` is loaded (by Vercel or the local Bun dev server), it imports everything in the module graph immediately. If `createClient` is called at the top of `client.ts` or `auth.ts`, a missing or misnamed env var throws *at boot* — crashing the entire serverless function, including public `/finance/*` routes that never touch Supabase at all. The resulting error is the opaque `FUNCTION_INVOCATION_FAILED`, not a useful "missing env key" message.

The fix is to defer construction to **first use**. Lumina's `backend/auth.ts` implements this exactly:

```ts
// backend/auth.ts:11-14
let _client: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (!_client) _client = createSupabaseClient()
  return _client
}
```

`_client` is `null` at boot. The first authenticated request triggers `getClient()`, which calls `createSupabaseClient()` (which may throw). At that point the caller gets a clean `500` with the real error message, not a boot crash. Public routes are unaffected.

This pattern is sometimes called the "lazy singleton." The same principle applies whenever a server module has optional dependencies (Redis, external APIs) that may not be configured in all environments:

```ts
// Generic lazy-singleton pattern
let _svc: SomeClient | null = null
function getSvc(): SomeClient {
  if (!_svc) _svc = new SomeClient(process.env.SOME_KEY!)
  return _svc
}
```

**When NOT to use it:** browser clients. In the browser you want the fail-fast throw at module load, because a missing `VITE_` key means a misconfigured deployment and no route will work correctly. Fail early and visibly.

### 5.1 The auth middleware flow

Once the lazy client is in place, `backend/auth.ts` adds a two-level cache to keep the per-request cost near zero:

```
Request arrives with Authorization header
       │
       ├─ tokenCache hit (< 5 min old)?
       │       └─ YES → req.userId = cached.userId → next()  (no Supabase call)
       │
       └─ NO → getClient().auth.getUser(token)   (Supabase JWT validation)
                      │
                      ├─ no user → 401
                      │
                      └─ user found
                              │
                              ├─ provisionedUsers has user.id?
                              │       └─ YES → skip upsert
                              │
                              └─ NO → prisma.user.upsert(...)   (one DB write per process)
                                           └─ provisionedUsers.add(user.id)
                                           └─ tokenCache.set(token, { userId, expiresAt })
                                           └─ req.userId = user.id → next()
```

The `tokenCache` (in-memory `Map<string, { userId, expiresAt }>`) with a 5-minute TTL (`TOKEN_TTL_MS = 5 * 60 * 1000`) means a busy user makes at most one Supabase call per 5 minutes. The `provisionedUsers` Set means `prisma.user.upsert` runs at most once per unique user per process lifetime. Both caches are in-memory and cleared on restart — adequate for Lumina; a Redis-backed token cache is the upgrade path.

```ts
// backend/auth.ts:28-44 (the fast-path implementation)
const TOKEN_TTL_MS = 5 * 60 * 1000
const tokenCache = new Map<string, { userId: string; expiresAt: number }>()
const provisionedUsers = new Set<string>()

export async function middleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization
  if (!token) return res.status(401).json({ error: "unauthorised" })

  const cached = tokenCache.get(token)
  if (cached && cached.expiresAt > Date.now()) {
    req.userId = cached.userId
    return next()
  }

  // slow path — calls getClient() lazily
  const data = await getClient().auth.getUser(token)
  const user = data.data.user
  if (!user) return res.status(401).json({ error: "unauthorised" })
  // ... provisioning + cache write
}
```

---

## 6. The Browser Singleton Pattern

For a client-side SPA, create the client **once** at module scope and import that single instance everywhere. Do not call `createClient` inside components, hooks, or render — each call spawns a new GoTrue instance (see §9 for why this is fatal).

```ts
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './env'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Defaults shown explicitly; you rarely need to deviate in a pure SPA.
    persistSession: true,        // store the session across reloads
    autoRefreshToken: true,      // refresh the access token before it expires
    detectSessionInUrl: true,    // exchange OAuth/magic-link code on redirect
    flowType: 'pkce',            // PKCE is the v2 default and the right choice
    // storage: window.localStorage (the default; shown for clarity)
  },
})
```

In practice the minimal correct SPA client is just:

```ts
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
```

…because every `auth` default above is already correct for a single-page browser app. Add explicit options only when you deviate.

### 6.1 Why module-scope, not React context

You can expose the client via context for testability, but the *instance itself* must be created once at module scope and merely *provided* — not created inside the provider's render:

```tsx
import { supabase } from '@/lib/supabase'

// Good: created once, provided for DI / testing
const SupabaseCtx = createContext(supabase)
export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  return <SupabaseCtx.Provider value={supabase}>{children}</SupabaseCtx.Provider>
}

// BAD: a new GoTrue instance every render (and StrictMode double-invokes this)
function BadProvider({ children }) {
  const client = createClient(url, key) // ❌ multiple GoTrue instances
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>
}
```

React 19 StrictMode double-invokes renders in development. A `createClient` in render immediately creates two GoTrue instances, producing the "Multiple GoTrue clients detected" warning before any user interaction.

### 6.2 Browser localStorage and Web Locks

In a browser, GoTrue persists the session in `localStorage` under `storageKey`, and uses the `navigator.locks` API to coordinate token refresh across multiple tabs — so two tabs don't race to refresh and invalidate each other's refresh token. This is free with the defaults. Do not replace `storage` with something non-shared unless you understand the multi-tab implications.

---

## 7. The Server-Side Pattern (per-request, cookie-backed)

Lumina's backend has a different architecture from a typical SSR app: **Supabase is used only for auth (JWT validation), and Prisma owns all data access.** So the full `@supabase/ssr` per-request cookie pattern is not needed here. The pattern is included below for completeness and for cases where you add a Supabase data query that must run under the user's RLS context.

### 7.1 Why per-request is non-negotiable if you share sessions

A server process handles many users concurrently. If you created one server client at boot and kept `persistSession: true`, an `auth.setSession` for user A could clobber the in-memory session and user B's request could execute as user A — a cross-user data leak. Lumina avoids this because:

- The Supabase client is used only for `auth.getUser(token)` — stateless JWT validation, not `setSession`.
- All data queries go through Prisma, which is always scoped by `req.userId` in application code.

If you add a Supabase data query that runs as the signed-in user, use `@supabase/ssr`'s per-request `createServerClient` with the user's JWT:

```ts
// hypothetical: supabase data query scoped to the user's JWT
import { createServerClient } from '@supabase/ssr'
import { parse, serialize } from 'cookie'
import type { Request, Response } from 'express'

export function supabaseForRequest(req: Request, res: Response) {
  const cookies = parse(req.headers.cookie ?? '')
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!,  // anon key — RLS still applies; user JWT from cookie
    {
      cookies: {
        getAll() {
          return Object.entries(cookies).map(([name, value]) => ({ name, value: value ?? '' }))
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            res.appendHeader('Set-Cookie', serialize(name, value, options as any))
          }
        },
      },
    },
  )
}
```

### 7.2 `getUser()` vs `getSession()` on the server

**On the server, always authenticate with `await supabase.auth.getUser(token)`** (validates the JWT against the Auth server) rather than trusting `getSession()` (reads cookie/storage state without server-side validation and can be spoofed). Lumina's `auth.ts:47` does exactly this:

```ts
// backend/auth.ts:47
const data = await getClient().auth.getUser(token)
const user = data.data.user
if (!user) return res.status(401).json({ error: "unauthorised" })
```

`getSession()` is fine for reading local state in the browser. On the server it is not a trust boundary.

---

## 8. The Service-Role Client (Server-Only)

When a trusted server needs to bypass RLS — administrative jobs, cron tasks, webhook reconciliation, seeding — use a dedicated service-role client. Isolate it in a server-only module that can never be imported by client code.

```ts
// backend/lib/admin.ts  (server-only)
import { createClient } from '@supabase/supabase-js'

if (typeof window !== 'undefined') {
  throw new Error('admin.ts (service-role client) must never run in the browser')
}

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_API_SECRET!,  // service-role key — bypasses RLS
  {
    auth: {
      autoRefreshToken: false,   // a service key never has a session to refresh
      persistSession: false,     // stateless; nothing to persist
      detectSessionInUrl: false, // no browser redirect to parse
    },
  },
)
```

Three things to internalize:

1. **`persistSession: false` and `autoRefreshToken: false`.** A service-role client has no user session. A stray background refresh timer keeps the process alive and logs noise for no reason. Always disable both.

2. **It bypasses RLS — so you re-own authorization.** With the service-role client there is no `auth.uid()`, no policy enforcement. Every query you write must include its own access checks. A missing `.eq('user_id', ownerId)` on a service-role query returns *everyone's* rows.

3. **The `window` guard + module placement.** Keep service-role code in a backend-only folder. The runtime `typeof window` check is defense-in-depth, not the primary protection.

Note: Lumina's current `backend/client.ts` accepts `SUPABASE_API_SECRET` for auth-only validation because either key works for `auth.getUser`. If you need a genuine service-role client for RLS-bypassing operations, add it as a separate module following the pattern above and never re-use the auth client for data operations.

---

## 9. The Expo / React Native Client (overview)

React Native has no `window.localStorage`, no DOM, no URL-bar redirect, and its JS runtime is suspended when backgrounded. Three critical differences from the browser client:

```ts
// src/lib/supabase.ts  (Expo)
import 'react-native-url-polyfill/auto'   // required: Hermes lacks full URL
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: AsyncStorage,      // native persistence
      persistSession: true,
      autoRefreshToken: true,     // gate on AppState (see below)
      detectSessionInUrl: false,  // CRITICAL: no URL bar; OAuth uses deep links
    },
  },
)
```

**`detectSessionInUrl: false` is mandatory.** There is no URL bar in a native app, so URL detection is dead work and causes confusing logs. Native auth callbacks arrive as deep links; you call `supabase.auth.exchangeCodeForSession(code)` yourself.

**AppState gating for `autoRefreshToken`.** The JS engine is suspended when the app is backgrounded — the refresh timer can't fire. Wire `AppState` to start/stop refresh:

```ts
import { AppState } from 'react-native'
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh()
  else supabase.auth.stopAutoRefresh()
})
```

This is the single most-missed piece of RN Supabase setup. Without it, the token goes stale while the app is backgrounded and the user gets an unexpected 401 on resume.

**RN config summary vs browser:**

| Option | Browser SPA | Expo / RN | Reason |
|--------|-------------|-----------|--------|
| `storage` | `localStorage` (default) | `AsyncStorage` / SecureStore | No DOM storage on native |
| `detectSessionInUrl` | `true` (default) | **`false`** | No URL bar; deep links |
| `autoRefreshToken` | `true` (default) | `true` **+ AppState gating** | JS suspended when backgrounded |
| `persistSession` | `true` | `true` | Keep users logged in across launches |
| URL polyfill | not needed | `react-native-url-polyfill/auto` | Hermes URL gaps |

---

## 10. Auth Options Reference

| Option | Type | Default | What it does | When to change |
|--------|------|---------|-------------|----------------|
| `persistSession` | `boolean` | `true` | Write the session to `storage` | `false` for server/admin clients |
| `autoRefreshToken` | `boolean` | `true` | Refresh the access token before expiry | `false` server-side; AppState-gated in RN |
| `detectSessionInUrl` | `boolean` | `true` | Exchange an OAuth/magic-link code found in the URL | `false` in Node/Bun and RN |
| `flowType` | `'pkce' \| 'implicit'` | `'pkce'` | OAuth exchange mechanism | Keep `pkce`; `implicit` only for legacy hash-fragment |
| `storage` | `SupportedStorage` | `localStorage` (browser) | Where to persist the session | AsyncStorage/SecureStore in RN; in-memory in tests |
| `storageKey` | `string` | `sb-<ref>-auth-token` | The storage key for the session | Override to isolate multiple clients pointing at the same project |
| `debug` | `boolean` | `false` | Verbose GoTrue logging | Temporarily, to diagnose session issues |

### 10.1 `flowType: 'pkce'` — why it's the default

PKCE (Proof Key for Code Exchange, RFC 7636) is the secure OAuth flow for public clients that cannot keep a secret — SPAs and mobile apps. Instead of returning the access token directly in the redirect URL fragment (the *implicit* flow, exposing the token in browser history and referrer headers), PKCE returns a short-lived authorization code. Only the client holding the original `code_verifier` can exchange it for tokens. Keep it. Switch to `implicit` only to integrate a legacy hash-fragment consumer.

---

## 11. The `{ data, error }` Result Contract

supabase-js v2's defining behavior: **query and mutation calls do not throw on database errors.** They resolve to `{ data, error }`. Constraint violations, RLS denials, malformed filters — all come back as a populated `error`, with `data === null`. Only network-level failures (DNS, offline, CORS) reject the promise.

```ts
const { data, error } = await supabase
  .from('conversations')
  .select('id, title, createdAt')
  .eq('userId', req.userId)

if (error) {
  console.error(error.code, error.message, error.details, error.hint)
  return res.status(400).json({ error: error.message })
}
// data is non-null here and typed as the row shape
```

### 11.1 `PostgrestError` shape

```ts
interface PostgrestError {
  message: string  // human-readable summary
  details: string  // additional context (e.g., which constraint)
  hint: string     // PostgREST/Postgres suggestion (often '')
  code: string     // PostgreSQL SQLSTATE or PostgREST code — branch on this
}
```

`PostgrestError` is **not** a JS `Error` subclass in v2 — it is a plain object. Do not `instanceof Error` it; read `error.code`/`error.message`.

### 11.2 Codes worth branching on

| `error.code` | Meaning | Typical cause |
|--------------|---------|---------------|
| `23505` | unique_violation | Duplicate insert |
| `23503` | foreign_key_violation | Referencing a non-existent FK |
| `23514` | check_violation | A CHECK constraint failed |
| `23502` | not_null_violation | Required column missing |
| `42501` | insufficient_privilege | **RLS denied** the operation |
| `PGRST116` | 0 or >1 rows for `.single()` | `.single()` expectation unmet |
| `PGRST301` | JWT expired / invalid | Stale or missing token |

```ts
const { data, error } = await supabase
  .from('gmail_connection')
  .insert({ userId, googleEmail, refreshTokenEnc, iv, authTag, scopes })

if (error) {
  if (error.code === '23505') return res.status(409).json({ error: 'already connected' })
  if (error.code === '42501') return res.status(403).json({ error: 'forbidden' })
  return res.status(500).json({ error: error.message })
}
```

### 11.3 A typed unwrap helper (TanStack Query bridge)

TanStack Query expects query functions that *throw* on error. Bridge the two contracts with a small helper:

```ts
import type { PostgrestError } from '@supabase/supabase-js'

export class SupabaseQueryError extends Error {
  constructor(public readonly pgError: PostgrestError) {
    super(pgError.message)
    this.name = 'SupabaseQueryError'
  }
}

export async function unwrap<T>(
  promise: PromiseLike<{ data: T | null; error: PostgrestError | null }>,
): Promise<T> {
  const { data, error } = await promise
  if (error) throw new SupabaseQueryError(error)
  if (data === null) throw new Error('Expected data but received null')
  return data
}

// usage with TanStack Query:
// queryFn: () => unwrap(supabase.from('conversations').select('*').eq('userId', uid))
```

Auth methods follow the same `{ data, error }` shape (e.g., `signInWithPassword` returns `{ data: { user, session }, error }`).

---

## 12. Session Persistence Options for Browser Clients

### 12.1 `localStorage` (default)

The default for browser SPAs. The session JSON is stored under `storageKey` (`sb-<ref>-auth-token`). GoTrue also uses the `navigator.locks` API to coordinate token refresh across tabs — preventing two tabs from racing to refresh the same refresh token and invalidating each other.

Do not replace `storage` with something synchronous and non-shared (like a module-level variable) unless you understand and accept that multiple tabs will fight over the session.

### 12.2 Cookies (SSR / `@supabase/ssr`)

When auth must be visible server-side (SSR frameworks, Express routes that act as the signed-in user), the session travels in HTTP cookies rather than localStorage. Use `@supabase/ssr`'s `createBrowserClient` (sets cookies in the browser) paired with `createServerClient` (reads them server-side). See §7.

Lumina does not currently use `@supabase/ssr` because the backend uses Supabase only for JWT validation and Prisma for all data. If server-rendered pages that query user data are added, `@supabase/ssr` is the upgrade path.

### 12.3 In-memory (tests, ephemeral)

For tests or ephemeral server contexts, disable persistence entirely:

```ts
const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  },
})
```

Lumina's test helpers (`backend/tests/helpers/supabase-fake.ts`) use a fake that returns controlled data rather than constructing a real client at all. Prefer the fake seam over a real client in tests.

### 12.4 `storageKey` isolation

The default `storageKey` includes the project ref, so two clients pointing at different Supabase projects don't collide. If you deliberately need two independent sessions against one project (rare), give each a distinct `storageKey`:

```ts
const userClient = createClient(url, anonKey, {
  auth: { storageKey: 'sb-lumina-user' },
})
const adminClient = createClient(url, anonKey, {
  auth: { storageKey: 'sb-lumina-admin', persistSession: false },
})
```

This is the *only* legitimate reason to have two auth-bearing clients in one runtime.

---

## 13. Avoiding Multiple GoTrue Instances

The warning `Multiple GoTrue clients detected in the same browser context` means you created more than one auth-bearing client bound to the same storage/key. Consequences are not cosmetic:

- **Token-refresh races.** Two GoTrue instances both run refresh timers against the same refresh token. One refresh invalidates the other's token, causing sporadic 401s and surprise logouts.
- **Inconsistent state.** A sign-in on instance A doesn't update instance B's in-memory session — half the app thinks the user is logged out.
- **Duplicate `onAuthStateChange` events** and stale closures.

| Cause | Fix |
|-------|-----|
| `createClient` called inside a component/hook/render | Create once at module scope; import the instance |
| `createClient` in a Context provider's render body | Create at module scope, *provide* the instance |
| Two modules each calling `createClient` for the same project | Centralize in one `src/lib/supabase.ts`; import everywhere |
| HMR re-running the module in dev | Acceptable noise in dev; ensure prod has one instance |
| Genuinely needing two sessions | Give each a unique `storageKey` (§12.4) |

The reliable rule: **one `createClient(...)` call per logical session context, at module scope.** A browser SPA: one. An RN app: one. A server: one *per request* for SSR (the request is the session context). A service-role client: one, separate, server-only — and because it uses `persistSession: false`, it is not a GoTrue-storage participant and won't trigger the warning.

---

## 14. Decision Tables

### 14.1 Which client for which runtime

| Runtime | Constructor | Key | Session storage | Lifetime |
|---------|------------|-----|-----------------|----------|
| Browser SPA (Vite/React) | `createClient` | anon/publishable | `localStorage` | Module-scope singleton |
| Server auth-only (Lumina backend) | `createClient` via lazy `getClient()` | service_role or anon | none (stateless) | Lazy singleton, no session |
| Server with user data + RLS (SSR) | `createServerClient` (`@supabase/ssr`) | anon/publishable | request cookies | Per request |
| Server admin / privileged job | `createClient` | **service_role** | none (`persistSession:false`) | Module-scope, server-only |
| Expo / React Native | `createClient` | anon/publishable | AsyncStorage / SecureStore | App-scope singleton |
| External-auth bridge (own JWTs) | `createClient` with `accessToken` | anon/publishable | n/a (no GoTrue session) | Singleton; no `auth.*` |

### 14.2 Auth-option presets by client type

| Option | Browser SPA | Lumina backend (auth-only) | Service-role | Expo/RN |
|--------|-------------|---------------------------|-------------|---------|
| `persistSession` | `true` | `false` / not needed | `false` | `true` |
| `autoRefreshToken` | `true` | `false` / not needed | `false` | `true` + AppState |
| `detectSessionInUrl` | `true` | `false` | `false` | `false` |
| `flowType` | `'pkce'` | n/a | n/a | `'pkce'` |
| `storage` | `localStorage` | n/a | n/a | AsyncStorage / SecureStore |

---

## 15. Anti-Patterns

**Calling `createClient` at module load in a serverless function.**
The module is loaded on every cold start. If the Supabase env var is missing, construction throws, crashing the entire function — including routes that never use Supabase. Lumina's `backend/auth.ts` solves this with the lazy `getClient()` pattern (§5). Defer construction to first use.

**Calling `createClient` inside a component, hook, or render.**
Each call constructs a new GoTrue instance bound to the same storage. React 19 StrictMode double-invokes renders; you immediately get "Multiple GoTrue clients detected," refresh races, and inconsistent auth state. Create the client once at module scope and import the instance everywhere.

**Putting the service_role / secret key in `VITE_` or `EXPO_PUBLIC_` env.**
Those prefixes inline the value into the client bundle/binary, which is fully extractable. The service-role key bypasses all RLS — leaking it exposes the entire database, reads and writes. Keep service-role keys server-side only.

**Treating the anon key as a secret.**
The anon key ships publicly by design. An attacker reading it from the Network tab gains nothing if RLS is correct. The security boundary is the RLS policy, not the key. Don't rotate/obfuscate the anon key thinking it protects data.

**Ignoring `error` from `{ data, error }`.**
supabase-js never throws on database errors. Code that reads `data` without checking `error` silently renders `null` on constraint violations, RLS denials, and expired tokens. Check `error` after every call, or route through an `unwrap()` helper.

**Using `getSession()` as a server-side trust boundary.**
`getSession()` reads local/cookie state without validating the JWT against the Auth server; a forged value passes it. On the server, authenticate with `await supabase.auth.getUser(token)` or `getClaims()`. Lumina's `auth.ts` uses `getUser`. Reserve `getSession()` for reading local state in the browser.

**Service-role client with `persistSession`/`autoRefreshToken` left on.**
A service key has no user session to persist, and the refresh timer keeps a background interval alive on the server for nothing — noise and a lingering handle. Always set `persistSession: false` and `autoRefreshToken: false` on server/admin clients.

**Sharing one server client across requests when it holds a user session.**
If a server client ever calls `setSession` or `signIn`, a shared instance will clobber in-memory session state across concurrent requests, leaking one user's identity into another's request. Either use the lazy stateless pattern (Lumina's approach for auth-only), or create a fresh `createServerClient` per request with `@supabase/ssr`.

**Hard-coding `Authorization` in `global.headers` for user auth.**
It is captured once at construction and will never track the user's rotating JWT, so requests run with a stale token after the first refresh. Let GoTrue manage `Authorization` automatically; use `global.headers` only for non-auth metadata such as tracing headers.

**Leaving `detectSessionInUrl: true` in React Native.**
There is no URL bar in a native app. URL detection does nothing and produces confusing logs. Set `detectSessionInUrl: false`. Handle OAuth callbacks with deep links and `supabase.auth.exchangeCodeForSession(code)`.

---

## See also

**Sibling references in the supabase skill:**
- `theory-supabase-architecture.md` — PostgREST / GoTrue / Realtime / Storage, keys, JWT, role model
- `theory-row-level-security-model.md` — the authorization model the client's auth state feeds
- `patterns-auth-flows.md` — sign-in flows, sessions, `onAuthStateChange`, `getUser` / `getClaims`
- `patterns-rls-policies.md` — `USING` / `WITH CHECK`, ownership, `(select auth.uid())`
- `patterns-query-builder.md` — `select`, filters, embedded joins, `.single()`, `returns<T>()`
- `patterns-mutations-and-upsert.md` — `insert` / `upsert` / `update` / `delete`, error codes in practice
- `patterns-realtime.md` — channels, RLS-authorized Postgres Changes, cleanup

**Other relevant skills:**
- `prisma` — Lumina's primary data-access layer (Prisma owns all DB queries; Supabase handles auth only)
- `supabase` (skill root) — the overall skill dispatch guide
- `connectors-oauth` — Gmail OAuth token vault, how `GmailConnection` rows are written via Prisma
- `backend-testing` — `backend/tests/helpers/supabase-fake.ts`, the mock seam for auth in tests
- `lumina-frontend` — browser singleton client wiring, TanStack Query data hooks, auth context
- `react-typescript` — typed hooks, the `unwrap()` bridge to TanStack Query
- `bun-testing` — `supabase-fake.ts` usage in frontend test harness
- `rag-retrieval` — `CachedQuery` accessed via `$queryRaw` (bypasses the Supabase client entirely; Prisma handles pgvector queries directly)
- `finance-markets` — finance routes that are public and must not be broken by a Supabase boot crash (the motivation for lazy initialization)
