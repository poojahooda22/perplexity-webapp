# Supabase Auth Flows — Sign-In Paths, Session Lifecycle, and Server-Side Token Validation

> Generic reference (Lumina worked examples throughout). Covers every sign-in path, the session/token
> lifecycle, `onAuthStateChange` with correct cleanup, the canonical server-side `getUser(token)` pattern,
> password reset, MFA basics, and mirroring the Supabase auth user into an application table with an
> idempotent Prisma upsert — as implemented in `backend/auth.ts`.

---

## Table of Contents

1. [The Auth Mental Model: GoTrue, JWTs, and the Session](#1-the-auth-mental-model-gotrue-jwts-and-the-session)
2. [Reading Identity Safely: getSession vs getUser vs getClaims](#2-reading-identity-safely-getsession-vs-getuser-vs-getclaims)
3. [The Session Lifecycle and Token Refresh](#3-the-session-lifecycle-and-token-refresh)
4. [onAuthStateChange: Events, Ordering, and Cleanup](#4-onauthstatechange-events-ordering-and-cleanup)
5. [Email + Password: signUp and signInWithPassword](#5-email--password-signup-and-signinwithpassword)
6. [Magic Link and OTP: signInWithOtp and verifyOtp](#6-magic-link-and-otp-signinwithotp-and-verifyotp)
7. [OAuth with PKCE: Google and GitHub (our two providers)](#7-oauth-with-pkce-google-and-github-our-two-providers)
8. [Server-Side Token Validation: the auth.ts Pattern](#8-server-side-token-validation-the-authts-pattern)
9. [Password Reset and MFA Basics](#9-password-reset-and-mfa-basics)
10. [Mirroring the Auth User into the App DB: the Idempotent Prisma Upsert](#10-mirroring-the-auth-user-into-the-app-db-the-idempotent-prisma-upsert)
11. [user_metadata vs app_metadata](#11-user_metadata-vs-app_metadata)
12. [The React AuthProvider (Frontend)](#12-the-react-authprovider-frontend)
13. [Decision Tables and Quick Reference](#13-decision-tables-and-quick-reference)
14. [Anti-Patterns](#14-anti-patterns)
15. [See Also](#15-see-also)

---

## 1. The Auth Mental Model: GoTrue, JWTs, and the Session

Supabase Auth is a managed instance of **GoTrue**, an OAuth2/OIDC-ish identity server. It issues
**JSON Web Tokens (JWTs)**. Three artifacts flow through every request:

| Artifact | What it is | Default lifetime | Where it lives |
|----------|-----------|------------------|----------------|
| **access_token** | Signed JWT: `sub`, `email`, `aal`, `app_metadata`, `user_metadata`, `exp`, `role` | 1 hour | Memory + `storage` adapter (localStorage/cookies) |
| **refresh_token** | Opaque, single-use, rotating | Long-lived | Same storage as the session |
| **session** | Object wrapping both tokens + `expires_at`, `expires_in`, `user` snapshot | Bound by the refresh token | `Session` object returned by the SDK |

### 1.1 How JWTs are verified

New projects support **asymmetric signing keys (ES256/RS256)** exposed via a JWKS endpoint. The SDK's
`getClaims()` verifies the access token **locally** using the cached public key — no network round-trip.
Legacy projects use HS256 (symmetric secret); `getClaims()` falls back to a remote call there.

Lumina's backend takes a **different route**: it passes the raw Bearer token to
`supabase.auth.getUser(token)` (a round-trip to GoTrue). This is the right choice when you do not
control the client SDK and need to trust a raw `Authorization` header — see §8.

### 1.2 PKCE is the default (and our choice)

`supabase-js` 2.x defaults to **PKCE** (RFC 7636). Tokens arrive as `?code=` and are exchanged for
a session via `exchangeCodeForSession`. Tokens never appear in the URL fragment, so they cannot leak
into browser history or referrer headers.

```ts
// frontend/src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      flowType: 'pkce',         // 2.x default; state it explicitly so readers know the contract
      autoRefreshToken: true,   // background refresh near expiry
      persistSession: true,     // persist across page reloads
      detectSessionInUrl: true, // auto-handle ?code= on load
    },
  },
);
```

> The **anon key** is public by design. It ships in the Vite bundle. The security boundary is
> **Row Level Security on Postgres**, not key secrecy.

---

## 2. Reading Identity Safely: getSession vs getUser vs getClaims

This is the most misused area of Supabase Auth.

| Method | Network call? | Verifies signature? | Trust | Use when |
|--------|---------------|---------------------|-------|----------|
| `getSession()` | No | **No** | **Untrusted** | "Is there a session?" UI gating; token plumbing (`expires_at`) only |
| `getClaims()` | No (asymmetric keys + JWKS cache) | **Yes** (local JWT verification) | Trusted | Default trusted read in 2.x — verified identity with no round-trip |
| `getUser()` | **Yes** — `GET /auth/v1/user` | Server validates the JWT | Trusted | Server-side when local verification isn't configured; also Lumina's backend choice (see §8) |

### 2.1 Why `getSession()` must never gate authorization

`getSession()` reads whatever is in `localStorage`/cookies. A user can edit `localStorage` to inject
a forged session object. The embedded `user` is **attacker-controllable** — the signature is never
checked.

```ts
// ❌ WRONG — never gate authorization on getSession()'s user
const { data: { session } } = await supabase.auth.getSession();
if (session?.user.id === ownerId) grantAccess(); // forgeable

// ✅ RIGHT (client, asymmetric keys) — local signature verification
const { data, error } = await supabase.auth.getClaims();
if (!error && data?.claims.sub === ownerId) grantAccess();

// ✅ RIGHT (server, bearer token) — round-trip to GoTrue
// This is exactly what backend/auth.ts:47 does:
//   const data = await getClient().auth.getUser(token);
```

### 2.2 A typed helper using getClaims

```ts
// frontend/src/auth/identity.ts
import { supabase } from '../lib/supabase';

export interface VerifiedIdentity {
  userId: string;
  email: string | null;
  role: string;          // 'authenticated' | 'anon' | custom
  aal: 'aal1' | 'aal2'; // assurance level
  appMetadata: Record<string, unknown>;
}

/** Returns verified identity or null. Never throws. */
export async function getVerifiedIdentity(): Promise<VerifiedIdentity | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  const c = data.claims;
  return {
    userId: c.sub,
    email: (c.email as string) ?? null,
    role: (c.role as string) ?? 'authenticated',
    aal: ((c.aal as string) ?? 'aal1') as 'aal1' | 'aal2',
    appMetadata: (c.app_metadata as Record<string, unknown>) ?? {},
  };
}
```

---

## 3. The Session Lifecycle and Token Refresh

### 3.1 End-to-end lifecycle

```
sign-in ──► Session { access_token (exp +1h), refresh_token, expires_at }
   │              persisted via storage adapter (localStorage / cookies)
   │
   ├── app sends requests ──► Authorization: Bearer <access_token>
   │        server calls getUser(token) → 401 if expired or invalid
   │
   ├── access_token nears expiry (autoRefreshToken: true)
   │        SDK posts refresh_token → /auth/v1/token?grant_type=refresh_token
   │        ──► NEW access_token + NEW refresh_token (rotation) ──► TOKEN_REFRESHED
   │
   ├── refresh_token reused/revoked/expired ──► refresh fails ──► SIGNED_OUT
   │
   └── signOut() ──► tokens cleared from storage; refresh tokens revoked server-side
```

### 3.2 Token rotation and the single-instance rule

Refresh tokens **rotate**: each exchange issues a new refresh token and invalidates the old one.
If two client instances share the same storage key and both try to refresh, the loser gets
`Invalid Refresh Token` and is signed out. **Create exactly one `createClient` instance per app.**

### 3.3 Checking expiry and forcing a refresh

```ts
// Inspect expiry (uses the unverified session — only for UX hints, not authorization)
const { data: { session } } = await supabase.auth.getSession();
if (session) {
  const secsLeft = session.expires_at! - Math.floor(Date.now() / 1000);
  const isExpired = secsLeft <= 0;
}

// Force a refresh manually — useful after you change app_metadata server-side
// and want the new claims in the next JWT immediately.
const { data, error } = await supabase.auth.refreshSession();
if (error) { /* refresh token invalid → treat as signed out */ }
```

### 3.4 Token lifetime config (Supabase project)

```toml
# supabase/config.toml — mirrors Dashboard → Authentication → Sessions
[auth]
jwt_expiry = 3600                   # access_token lifetime in seconds (min 300)
enable_refresh_token_rotation = true
refresh_token_reuse_interval = 10   # grace window (s) for previous token after rotation

[auth.sessions]
timebox = "24h"            # hard max session length regardless of refresh
inactivity_timeout = "8h"  # sign out after this much idle
```

> Short `jwt_expiry` (1h) limits blast radius of a leaked access token. Rotation + reuse detection
> handles the long tail.

---

## 4. onAuthStateChange: Events, Ordering, and Cleanup

`onAuthStateChange` is the heartbeat of client-side auth. It fires on sign-in, sign-out, background
refresh, multi-tab sync, and when `detectSessionInUrl` parses a callback URL.

### 4.1 The events

| Event | Fires when | `session` | Typical reaction |
|-------|-----------|-----------|-----------------|
| `INITIAL_SESSION` | Once, right after registration — with the restored session or `null` | session \| null | Stop the hydration spinner; set initial state |
| `SIGNED_IN` | Successful sign-in or code exchange | session | Set user, redirect into app |
| `SIGNED_OUT` | `signOut()`, refresh failure, revocation | `null` | Clear state + query caches; redirect to login |
| `TOKEN_REFRESHED` | Background or manual refresh | new session | SDK persists; usually no UI action needed |
| `USER_UPDATED` | `updateUser()` changed email/password/metadata | session | Refresh profile display |
| `PASSWORD_RECOVERY` | User arrived via a password-reset link | session | Show "set new password" form |
| `MFA_CHALLENGE_VERIFIED` | MFA challenge verified, AAL upgraded | session | Re-check AAL; unlock MFA-gated UI |

### 4.2 Two hard rules

**Rule 1 — Do NOT `await` Supabase calls directly inside the callback.** The callback runs inside
the SDK's auth lock. Awaiting another Supabase call inside it can deadlock. Defer with `setTimeout(0)`.

**Rule 2 — Always `unsubscribe()`.** The returned `subscription` must be cleaned up in `useEffect`'s
return. Leaked listeners cause duplicate fetches, stale closures, and double redirects.

```ts
// ❌ WRONG — awaiting inside the callback can deadlock
supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN') {
    const { data } = await supabase.from('something').select('*'); // risky inside the lock
  }
});

// ✅ RIGHT — defer Supabase work out of the callback
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session) {
    setTimeout(() => void fetchUserData(session.user.id), 0);
  }
});
```

### 4.3 Canonical React subscription

```ts
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { queryClient } from '../lib/query-client';

export function useSessionListener() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        setSession(nextSession);
        if (event === 'INITIAL_SESSION') setReady(true);
        if (event === 'SIGNED_OUT') {
          // Defer so we're outside the auth lock, then clear cached server state.
          // Critical: the next user must never see the previous user's TanStack Query cache.
          setTimeout(() => queryClient.clear(), 0);
        }
      },
    );
    return () => subscription.unsubscribe(); // ← non-negotiable
  }, []);

  return { session, ready };
}
```

---

## 5. Email + Password: signUp and signInWithPassword

### 5.1 Sign-up

Whether a session is returned after `signUp` depends on the email-confirmation setting:

- **Email confirmation OFF** → session is returned immediately (user signed in).
- **Email confirmation ON** (production default) → `session: null`; user must click the link.

```ts
export async function signUpWithEmail(email: string, password: string, displayName: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Goes into raw_user_meta_data → user_metadata. USER-CONTROLLED — display only, never authz.
      data: { full_name: displayName },
      emailRedirectTo: `${window.location.origin}/auth/confirm`,
    },
  });

  if (error) {
    // error.code: 'weak_password' | 'user_already_exists' | 'over_email_send_rate_limit'
    return { ok: false as const, error };
  }

  const needsConfirmation = data.session === null;
  return { ok: true as const, user: data.user, needsConfirmation };
}
```

> **Anti-enumeration:** enable "Prevent leaking signups" in Dashboard → Authentication so an existing
> email returns the same "check your email" as a new one.

### 5.2 Sign-in

```ts
export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Branch on error.code, not error.message (messages are deliberately generic / can change).
    if (error.code === 'email_not_confirmed') {
      return { ok: false as const, reason: 'unconfirmed' as const };
    }
    return { ok: false as const, reason: 'invalid' as const };
  }

  // onAuthStateChange fires SIGNED_IN; the session is persisted automatically.
  return { ok: true as const, session: data.session };
}
```

### 5.3 Sign-in error codes

| `error.code` | HTTP | UX message |
|--------------|------|-----------|
| `invalid_credentials` | 400 | "Email or password is incorrect" |
| `email_not_confirmed` | 400 | Offer "resend confirmation" |
| `over_request_rate_limit` | 429 | "Try again shortly" |
| `user_banned` | 403 | "Account suspended" |

### 5.4 Email confirmation handler

```tsx
// frontend/src/routes/AuthConfirm.tsx
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export function AuthConfirm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'working' | 'error'>('working');

  useEffect(() => {
    const code = params.get('code');
    const errDesc = params.get('error_description');
    if (errDesc || !code) { setStatus('error'); return; }

    (async () => {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) { setStatus('error'); return; }
      navigate('/dashboard', { replace: true });
    })();
  }, [params, navigate]);

  if (status === 'error') return <p>This link is invalid or expired. Request a new one.</p>;
  return <p>Confirming your account…</p>;
}
```

> **Redirect URL allowlist:** `emailRedirectTo` must be registered in Dashboard → Authentication →
> URL Configuration → Redirect URLs. GoTrue silently falls back to Site URL if it isn't. Add
> wildcard entries for Vercel preview deploys: `https://*-yourorg.vercel.app/**`.

### 5.5 Resending confirmation

```ts
export async function resendConfirmation(email: string) {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
  });
  return { ok: !error, error };
}
```

---

## 6. Magic Link and OTP: signInWithOtp and verifyOtp

`signInWithOtp` is **one API with two delivery modes** depending on the email template: a clickable
**magic link** or a **6-digit code (OTP)**. Both are passwordless.

### 6.1 Magic link (clickable)

```ts
export async function sendMagicLink(email: string) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${window.location.origin}/auth/confirm`,
      shouldCreateUser: true, // false → reject emails not yet registered
    },
  });
  // No enumeration: error is null even for non-existent emails.
  // Always show "check your email" unconditionally.
  return { ok: !error, error };
}
```

The user clicks the link → GoTrue verifies → redirects with `?code=` → `exchangeCodeForSession`
(same callback handler as §5.4). Magic links are single-use and short-lived (~1 hour).

### 6.2 OTP (6-digit code, no redirect)

Use the `{{ .Token }}` template variable in your custom email template to send a code instead of a
link. The user types the code into your UI.

```ts
// Step 1 — send the code
await supabase.auth.signInWithOtp({ email });

// Step 2 — user enters the 6-digit code
export async function verifyEmailOtp(email: string, token: string) {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email',
  });
  if (error) {
    // error.code: 'otp_expired' | 'invalid_otp' | 'over_request_rate_limit'
    return { ok: false as const, error };
  }
  return { ok: true as const, session: data.session };
}
```

### 6.3 `verifyOtp` type values

| `type` | Verifies |
|--------|---------|
| `email` | Email OTP / magic link / signup confirm |
| `recovery` | Password-reset code |
| `email_change` | New-email confirmation code |
| `invite` | Admin invite acceptance |

### 6.4 Magic link vs OTP: decision

Prefer **OTP code** for environments where corporate email scanners click and consume single-use
magic links, or where a copy-paste UX is more reliable. Prefer **magic link** for desktop web
one-click convenience. Both share the same rate limits.

---

## 7. OAuth with PKCE: Google and GitHub (our two providers)

Lumina supports exactly two OAuth providers: **Google** and **GitHub**. Both map to `AuthProvider`
values in the Prisma schema (`Google` | `Github`). The decision in `backend/auth.ts:62` is:

```ts
provider: user.app_metadata.provider === "google" ? "Google" : "Github",
```

### 7.1 The PKCE dance

1. SDK generates a random **code verifier**, stores it in the storage adapter, derives a **code
   challenge** (SHA-256).
2. Browser redirects to the provider (Google / GitHub) with the challenge.
3. Provider redirects back to Supabase's `/auth/v1/callback` with an auth code.
4. Supabase redirects to your `redirectTo` URL with `?code=<supabase_auth_code>`.
5. Your app calls `exchangeCodeForSession(code)`. SDK sends the code + stored verifier; Supabase
   verifies the challenge↔verifier match and returns a session.

Because the verifier never leaves the original client and is required to redeem the code, an
intercepted `?code=` cannot be exchanged.

### 7.2 Starting the OAuth flow

```ts
// frontend/src/auth/oauth.ts
import { supabase } from '../lib/supabase';

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: 'email profile',
      // Request offline access so Google issues a refresh token (useful for Connectors/Gmail).
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  if (error) return { ok: false as const, error };
  return { ok: true as const, url: data.url };
}

export async function signInWithGitHub() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: 'read:user user:email',
    },
  });
  if (error) return { ok: false as const, error };
  return { ok: true as const, url: data.url };
}
```

### 7.3 The OAuth callback handler

```tsx
// frontend/src/routes/AuthCallback.tsx
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export function AuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const code = params.get('code');
    const oauthError = params.get('error') ?? params.get('error_description');
    if (oauthError) { navigate('/login?error=oauth', { replace: true }); return; }
    if (!code)      { navigate('/login', { replace: true }); return; }

    (async () => {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      // On success, onAuthStateChange fires SIGNED_IN.
      // backend/auth.ts provisions the User row on the first authenticated API call.
      navigate(error ? '/login?error=exchange' : '/dashboard', { replace: true });
    })();
  }, [params, navigate]);

  return <p>Signing you in…</p>;
}
```

> With `detectSessionInUrl: true` (our client config), the SDK exchanges the code automatically and
> fires `SIGNED_IN` before your component's `useEffect` runs. The explicit handler above is for
> testability; in practice you may simply redirect on `SIGNED_IN` from the `AuthProvider`.

### 7.4 Provider configuration

Each provider needs a Client ID + Secret in Dashboard → Authentication → Providers, and the
provider's own console must allowlist Supabase's callback URL:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

Local dev mirror:

```toml
[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_GOOGLE_CLIENT_ID)"
secret    = "env(SUPABASE_AUTH_GOOGLE_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"

[auth.external.github]
enabled = true
client_id = "env(SUPABASE_AUTH_GITHUB_CLIENT_ID)"
secret    = "env(SUPABASE_AUTH_GITHUB_SECRET)"
```

### 7.5 Same-email collision

If a Google and GitHub account share an email and "Confirm email" is on (the email is trusted),
Supabase can **link them to one user** automatically. The `auth.uid()` (and our Prisma `User.id`)
remains stable. If you need strict separation, disable automatic linking in Dashboard → Authentication.

---

## 8. Server-Side Token Validation: the auth.ts Pattern

This is the canonical pattern for how a Node/Express backend trusts a Supabase JWT — without
importing the supabase-js client on the frontend's side of the wire. The full implementation lives
in `backend/auth.ts`.

### 8.1 Why `getUser(token)` on the server (not `getClaims`)

`getClaims()` is ideal on the **client** where the SDK maintains a session and JWKS cache. On the
backend, you receive a raw `Authorization` header and there is no stored session. The correct server
call is:

```ts
const { data } = await supabaseClient.auth.getUser(token);
```

This sends the token to GoTrue's `/auth/v1/user` endpoint. GoTrue verifies the signature and
returns the user if valid. The server never needs to manage a session object.

### 8.2 The full middleware (annotated)

```ts
// backend/auth.ts — complete implementation

import type { Request, Response, NextFunction } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseClient } from "./client.js";
import { prisma } from "./db.js";

// ── Lazy client ────────────────────────────────────────────────────────────────
// Built on the FIRST authenticated request, not at module load. index.ts imports
// this file at boot; createClient() throws if Supabase env vars are missing.
// Building it at load time would crash the ENTIRE serverless function — including
// the public /finance routes that never touch Supabase — with an opaque
// FUNCTION_INVOCATION_FAILED. Deferring keeps boot crash-proof.
let _client: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (!_client) _client = createSupabaseClient();
  return _client;
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

// ── In-process token cache ─────────────────────────────────────────────────────
// token → { userId, expiresAt }. A repeat request within 5 min skips the GoTrue
// round-trip entirely. Short TTL (5 min) keeps revocation reasonably fast.
// In-memory: cleared on restart — acceptable for this project; swap for Redis later.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map<string, { userId: string; expiresAt: number }>();

// ── Per-process provisioning guard ────────────────────────────────────────────
// Track users whose app DB row we've already upserted. Skips the DB write on
// repeat requests from the same user within the same function instance.
const provisionedUsers = new Set<string>();

export async function middleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "unauthorised" });

  // Fast path — token validated recently, no Supabase call needed
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    req.userId = cached.userId;
    return next();
  }

  // Slow path — validate with GoTrue (first request or after TTL expiry)
  const data = await getClient().auth.getUser(token);  // line 47
  const user = data.data.user;
  if (!user) return res.status(401).json({ error: "unauthorised" });

  // Provision the User row once per process — see §10 for the upsert rationale.
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
      // Fail loudly: if the User row can't be created, downstream FK writes
      // (Conversation/Message) will fail confusingly two steps later.
      console.error("[auth] user provisioning failed:", e);
      return res.status(500).json({ error: "Could not provision user" });
    }
  }

  tokenCache.set(token, { userId: user.id, expiresAt: Date.now() + TOKEN_TTL_MS });
  req.userId = user.id;
  next();
}
```

### 8.3 The Supabase client used only for auth

`backend/client.ts` creates the Supabase client used solely for JWT validation. It accepts either
the service-role key (`SUPABASE_API_SECRET`) or the anon key (`SUPABASE_KEY`) — both can call
`auth.getUser(token)`. It does **not** query user data (Prisma handles all DB access), so the
service key's RLS-bypass is not exercised here.

```ts
// backend/client.ts
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://rgwdybuczqcoenmxmosd.supabase.co";

export function createSupabaseClient() {
  const key = process.env.SUPABASE_API_SECRET ?? process.env.SUPABASE_KEY;
  if (!key) throw new Error("Supabase key missing: set SUPABASE_API_SECRET or SUPABASE_KEY");
  return createClient(SUPABASE_URL, key);
}
```

### 8.4 Token cache behaviour

The in-process `tokenCache` (`Map<string, { userId, expiresAt }>`) acts as a **5-minute TTL skip
layer** over GoTrue:

- **Hit within TTL**: `req.userId` set in ~0 µs; no network.
- **Miss or expired**: call GoTrue, then repopulate cache for the next 5 minutes.
- **Revocation latency**: up to 5 minutes to enforce a revoked token. For production, swap the
  in-memory map for a Redis entry using `backend/lib/cache.ts`'s `getOrRefresh`.

### 8.5 provisionedUsers guard

The `provisionedUsers` Set trades a small memory cost for eliminating a Prisma `upsert` on every
request from an already-seen user within the process lifetime. Because the upsert is idempotent
(`update: {}` is a no-op) it is safe to call multiple times; the Set merely saves the round-trip.
The Set is cleared on cold start, so a fresh Vercel invocation re-provisions (once) for each user
it sees.

### 8.6 How to apply this middleware

```ts
// backend/index.ts — attach to every authenticated route group
import { middleware as authMiddleware } from "./auth.js";
import type { AuthenticatedRequest } from "./auth.js";

// Public routes (e.g. /finance/quote) come BEFORE this middleware.
// Authenticated routes come AFTER.
app.use("/api", authMiddleware);

app.get("/api/conversations", async (req: AuthenticatedRequest, res) => {
  const { userId } = req;                       // guaranteed by middleware
  const conversations = await prisma.conversation.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  res.json(conversations);
});
```

---

## 9. Password Reset and MFA Basics

### 9.1 Password reset: two-call flow

```ts
// Step 1 — request the reset email (no enumeration: error is null whether or not email exists)
export async function requestPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/reset`,
  });
  return { ok: !error, error };
}
```

When the user clicks the recovery link, GoTrue verifies the token and fires `PASSWORD_RECOVERY` via
`onAuthStateChange`. During this window, `updateUser({ password })` is permitted.

```tsx
// frontend/src/routes/ResetPassword.tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export function ResetPassword() {
  const [canReset, setCanReset] = useState(false);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setCanReset(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setErr(error.code === 'weak_password' ? 'Choose a stronger password.' : 'Could not update password.');
      return;
    }
    // Sign out all other sessions so a stolen reset link can't keep them alive.
    await supabase.auth.signOut({ scope: 'others' });
    navigate('/login', { replace: true });
  }

  if (!canReset) return <p>Open the reset link from your email to continue.</p>;
  return (
    <form onSubmit={submit}>
      <input type="password" minLength={8} value={password}
             onChange={(e) => setPassword(e.target.value)} required />
      <button>Set new password</button>
      {err && <p role="alert">{err}</p>}
    </form>
  );
}
```

### 9.2 Password update for an authenticated user

```ts
// Optionally force re-auth before a sensitive change.
await supabase.auth.reauthenticate(); // emails a nonce
const { error } = await supabase.auth.updateUser({ password: newPassword, nonce });
```

`updateUser` fires `USER_UPDATED`. Changing the password does **not** by default invalidate other
sessions — call `signOut({ scope: 'others' })` if your threat model requires it.

### 9.3 MFA (TOTP) basics

Supabase MFA uses AAL (Authenticator Assurance Levels):

- **AAL1** — single factor (password / magic link / OAuth). Default after sign-in.
- **AAL2** — a second factor (TOTP) was verified this session.

```ts
// Enroll a TOTP factor
const { data, error } = await supabase.auth.mfa.enroll({
  factorType: 'totp',
  friendlyName: 'Authenticator app',
});
// data.totp.qr_code = SVG data URI to display; data.totp.secret = manual-entry fallback

// Challenge + verify to finalize enrollment
const { data: ch } = await supabase.auth.mfa.challenge({ factorId: data.id });
await supabase.auth.mfa.verify({ factorId: data.id, challengeId: ch.id, code });

// Check whether step-up is needed
const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
// aal.currentLevel === aal.nextLevel → no step-up needed
// aal.nextLevel === 'aal2' → prompt for TOTP code

// Step up to AAL2
const { data: factors } = await supabase.auth.mfa.listFactors();
const totp = factors?.totp.find((f) => f.status === 'verified');
const { data: stepCh } = await supabase.auth.mfa.challenge({ factorId: totp!.id });
await supabase.auth.mfa.verify({ factorId: totp!.id, challengeId: stepCh.id, code });
// Success fires MFA_CHALLENGE_VERIFIED; JWT re-issued with aal: 'aal2'
```

> **Client-side AAL checks are UX only.** The real gate is an RLS policy that checks
> `(select auth.jwt() ->> 'aal') = 'aal2'` before allowing access to sensitive rows. Never rely
> on client checks alone.

### 9.4 Sign-out scopes

```ts
await supabase.auth.signOut();                    // 'global' (default) — revoke ALL tokens everywhere
await supabase.auth.signOut({ scope: 'local' });  // sign out only this tab/device
await supabase.auth.signOut({ scope: 'others' }); // keep this session, revoke the rest
```

Always clear the TanStack Query cache on `SIGNED_OUT` (`queryClient.clear()`). Otherwise the next
user (or logged-out state) can momentarily see the previous user's cached rows.

---

## 10. Mirroring the Auth User into the App DB: the Idempotent Prisma Upsert

### 10.1 Why mirror at all

`auth.users` lives in the protected `auth` schema — not directly accessible by Prisma or application
queries. Lumina needs a `User` row in its own schema (Prisma `User` model in `public`) to hold
foreign keys for `Conversation`, `Message`, and `GmailConnection`.

Two approaches exist: a Postgres trigger on `auth.users` (generic pattern) or an application-level
upsert on first authenticated request (Lumina's choice). The trigger approach is atomic at the DB
level; the application upsert is simpler and keeps all provisioning logic in TypeScript.

### 10.2 The upsert (backend/auth.ts:54–68)

```ts
await prisma.user.upsert({
  where: { email: user.email! },
  update: {},          // no-op: we own the row after creation; auth is the source of truth
  create: {
    id: user.id,       // mirror the Supabase UUID so ids stay in sync
    email: user.email!,
    provider: user.app_metadata.provider === "google" ? "Google" : "Github",
    // full_name may be absent for some providers — fall back to email
    name: user.user_metadata.full_name ?? user.email!,
    supabaseId: user.id,
  },
});
```

Key decisions:

- **`where: { email }`**: Prisma schema declares `email @unique` on `User`. Using email as the
  lookup key means that if the same human signs in via Google then GitHub (different provider, same
  email, Supabase links them), the upsert finds the existing row rather than trying to insert a
  duplicate.
- **`update: {}`**: The auth source of truth is Supabase; we do not override our own stored
  fields on every request.
- **`id: user.id`**: Keep the Prisma `User.id` equal to the Supabase auth `user.id`. This makes
  cross-referencing simple and avoids a separate lookup join.
- **`app_metadata.provider`**: Comes from GoTrue's verified metadata — the model never touches
  `user_metadata` for this field because `user_metadata` is user-writable.

### 10.3 Why fail loudly on provisioning error

```ts
catch (e) {
  console.error("[auth] user provisioning failed:", e);
  return res.status(500).json({ error: "Could not provision user" });
}
```

If the `User` row cannot be created, every subsequent DB write that touches `userId` as a foreign
key (`Conversation`, `Message`, `GmailConnection`) will throw a confusing FK violation two steps
later. Surfacing the failure here makes debugging immediate.

### 10.4 The Prisma User model for reference

```prisma
// backend/prisma/schema.prisma
model User {
  id              String          @id @default(uuid())
  email           String          @unique
  name            String
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  provider        AuthProvider
  supabaseId      String
  conversations   Conversation[]
  gmailConnection GmailConnection?
}

enum AuthProvider { Github  Google }
```

### 10.5 Alternative: Postgres trigger on auth.users

If you prefer the auth user to be mirrored atomically at the DB level (useful for apps where
the first DB write may happen outside the Express middleware path):

```sql
-- Runs as SECURITY DEFINER so it can write public.User regardless of RLS.
-- MANDATORY: set search_path = '' to prevent search-path hijacking.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public."User" (id, email, name, provider, "supabaseId")
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    case when new.raw_app_meta_data ->> 'provider' = 'google' then 'Google' else 'Github' end,
    new.id
  )
  on conflict (email) do nothing;  -- idempotent
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

Lumina currently uses the application-level upsert in `backend/auth.ts`. The trigger above is the
alternative for projects where you want the row guaranteed before any application code runs.

---

## 11. user_metadata vs app_metadata

This distinction is a **security boundary**, not a style choice.

| | `user_metadata` (`raw_user_meta_data`) | `app_metadata` (`raw_app_meta_data`) |
|--|----------------------------------------|--------------------------------------|
| Who can write | **The user** (via `signUp options.data`, `updateUser({ data })`) | **Privileged contexts only** — Admin API / service-role / DB triggers |
| Trust for authz | **Untrusted** — user-controlled | **Trusted** — server-controlled |
| Typical contents | Display name, avatar URL, locale | Provider list, roles, plan/tier, feature flags |
| In the JWT | Yes (`user_metadata`) | Yes (`app_metadata`) |

```ts
// User-controlled — fine for display name, NEVER for permissions
await supabase.auth.updateUser({ data: { full_name: 'Ada', theme: 'dark' } });
```

```ts
// Server-only — write roles from a trusted context (Express / Edge Function / Admin API).
// NEVER use the service_role key client-side.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

await admin.auth.admin.updateUserById(userId, {
  app_metadata: { role: 'pro', plan: 'premium' },
});
// The user must refresh their session to receive the new claims in the next JWT.
```

The `backend/auth.ts` middleware reads `user.app_metadata.provider` (line 62) for the
`AuthProvider` enum — this is correct because `app_metadata` is GoTrue-managed and not
user-editable. Reading `user_metadata.full_name` (line 64) is only used as a **display field**
for the `name` column — never as an authorization claim.

---

## 12. The React AuthProvider (Frontend)

A single context that exposes verified identity, gates the app on hydration, and cleans up
correctly. Uses `getClaims()` so no extra GoTrue round-trip is needed on the client.

```tsx
// frontend/src/auth/AuthProvider.tsx
import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { getVerifiedIdentity, type VerifiedIdentity } from './identity';
import { queryClient } from '../lib/query-client';

interface AuthState {
  session: Session | null;
  identity: VerifiedIdentity | null; // signature-verified; use for authorization gating
  status: 'loading' | 'authenticated' | 'unauthenticated';
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session: null, identity: null, status: 'loading',
  });

  useEffect(() => {
    let active = true;

    async function hydrate(session: Session | null) {
      if (!session) {
        if (active) setState({ session: null, identity: null, status: 'unauthenticated' });
        return;
      }
      const identity = await getVerifiedIdentity();
      if (!active) return;
      setState({ session, identity, status: identity ? 'authenticated' : 'unauthenticated' });
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Defer hydration outside the auth lock (§4 rule 1).
      setTimeout(() => void hydrate(session), 0);
      if (event === 'SIGNED_OUT') {
        // Clear TanStack Query cache so the next user never sees stale rows.
        setTimeout(() => queryClient.clear(), 0);
      }
    });

    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  const value = useMemo(() => state, [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
```

### 12.1 Protected route

```tsx
// frontend/src/routes/RequireAuth.tsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export function RequireAuth({ requireAal2 = false }: { requireAal2?: boolean }) {
  const { status, identity } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (requireAal2 && identity?.aal !== 'aal2') {
    return <Navigate to="/mfa" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
```

> The `status === 'loading'` guard prevents the **login-page flash on refresh**: until
> `INITIAL_SESSION` resolves and `getClaims` verifies, show a spinner. Never render the login
> page before hydration completes for an already-authenticated user.

---

## 13. Decision Tables and Quick Reference

### 13.1 Which sign-in method?

| Need | Method |
|------|--------|
| Classic email + password | `signInWithPassword` + email confirmation |
| Passwordless, desktop | `signInWithOtp` (magic link template) |
| Passwordless, mobile / scanner-proof | `signInWithOtp` + `verifyOtp` (code template) |
| Social login (web, PKCE) | `signInWithOAuth` + `exchangeCodeForSession` |
| Server-issued / admin | Admin API (`auth.admin.*`) with `service_role` — never client |

### 13.2 Which identity reader?

| Context | Use | Why |
|---------|-----|-----|
| UI "is someone logged in?" | `getSession()` | Fast, no network — not trusted for authz |
| Any client authorization check | `getClaims()` | Local JWT verification, no round-trip |
| Express backend (raw Bearer header) | `getUser(token)` | Round-trip to GoTrue — the Lumina pattern |
| Data access control | **RLS** | The real boundary; `getClaims`/`getUser` only gate UI |

### 13.3 onAuthStateChange event → action

| Event | Do |
|-------|----|
| `INITIAL_SESSION` | Stop hydration spinner; set initial state |
| `SIGNED_IN` | Set user, route into app (deferred fetch) |
| `SIGNED_OUT` | Clear state; `queryClient.clear()`; route to login |
| `TOKEN_REFRESHED` | Nothing — SDK persists new tokens |
| `USER_UPDATED` | Refresh profile display |
| `PASSWORD_RECOVERY` | Show "set new password" form |
| `MFA_CHALLENGE_VERIFIED` | Re-check AAL; unlock gated UI |

### 13.4 Common error.code values

| `error.code` | Context | Meaning |
|--------------|---------|---------|
| `invalid_credentials` | sign-in | Wrong email/password |
| `email_not_confirmed` | sign-in | Must verify email first |
| `weak_password` | sign-up / update | Fails password policy |
| `same_password` | update | New equals old |
| `otp_expired` | verifyOtp | Code or link expired |
| `over_email_send_rate_limit` | many | Rate limited (429) |
| `mfa_verification_failed` | mfa.verify | Wrong TOTP code |
| `session_not_found` | update in recovery | Reset link expired |

---

## 14. Anti-Patterns

**1. Authorizing on `getSession().user`.**
The embedded `user` is read from unsigned `localStorage`/cookies — attacker-controllable. Use
`getClaims()` (client, local verification) or `getUser(token)` (server, GoTrue round-trip) for any
trust decision. The real authorization boundary is RLS.

**2. Putting the `service_role` key in the client bundle.**
`service_role` bypasses **all** RLS. In a Vite bundle it is fully extractable → total data
compromise. Ship only the `anon` key to clients. Admin writes (`auth.admin.updateUserById`) happen
in Express or Edge Functions only.

**3. `await`-ing Supabase calls directly inside `onAuthStateChange`.**
The callback runs under the auth lock. Re-entrant awaited calls can deadlock and freeze the refresh
loop. Always defer with `setTimeout(cb, 0)`.

**4. Forgetting `subscription.unsubscribe()` from `onAuthStateChange`.**
Leaked listeners accumulate across mounts → duplicate fetches, stale closures, double redirects,
memory growth. Always return `() => subscription.unsubscribe()` from the `useEffect`.

**5. Branching auth logic on `error.message` strings.**
Messages are intentionally generic and change between versions. Switch on stable `error.code` only.

**6. Putting roles or permissions in `user_metadata`.**
`user_metadata` is user-writable via `updateUser({ data })`. A user can grant themselves
`role: 'admin'`. Store authorization claims in `app_metadata` (server-writable only) or a DB roles
table, and read them in RLS via `auth.jwt() -> 'app_metadata'`.

**7. `emailRedirectTo` not on the Redirect URL allowlist.**
GoTrue silently falls back to Site URL. Add every redirect URL (including Vercel preview wildcards
`https://*-yourorg.vercel.app/**`) to Dashboard → Authentication → URL Configuration.

**8. `SECURITY DEFINER` trigger functions without `set search_path = ''`.**
An attacker who can create objects in a schema on the search path can shadow the trigger's targets
and hijack the elevated function. Always: `security definer set search_path = ''` and schema-qualify
every object (`public."User"`, `auth.users`).

**9. Two `createClient` instances sharing the same storage key.**
Both try to refresh the single rotating refresh token → race → the loser gets
`Invalid Refresh Token` → random sign-outs. Create exactly one module-level singleton.

**10. Showing the login page during the hydration window.**
Before `INITIAL_SESSION` resolves, `session` is `null`, so a naive guard flashes the login screen
for authenticated users on every refresh. Model an explicit `'loading'` status and render a
spinner until hydration completes.

**11. Checking `aal` only on the client to gate sensitive features.**
The client check is cosmetic. A crafted request with an AAL1 token still hits the database. Enforce
`(select auth.jwt() ->> 'aal') = 'aal2'` in RLS for any row that requires MFA.

**12. Not clearing the TanStack Query cache on `SIGNED_OUT`.**
The next user (or logged-out state) can momentarily see the previous user's cached rows.
`queryClient.clear()` in the `SIGNED_OUT` handler is non-negotiable.

**13. Making the Supabase client eagerly at module load in the backend.**
As noted in `backend/auth.ts:6–10`, if `createClient()` throws (bad env vars), it crashes the
entire serverless function including routes that never touch Supabase. Build the client lazily,
on the first authenticated request.

---

## 15. See Also

**Sibling references in this skill**
- `theory-supabase-architecture.md` — keys (anon / service-role), GoTrue, PostgREST, JWT topology
- `patterns-rls-policies.md` — RLS ownership/role/AAL policies, `auth.uid()`, `auth.jwt()`, planner-cache tricks
- `patterns-database-functions-triggers-rpc.md` — `SECURITY DEFINER`, pinned `search_path`, trigger patterns

**Other Lumina skills**
- `prisma` — Prisma 7 setup, `PrismaPg` adapter, `$queryRaw`/`$executeRaw` for pgvector, generated client path
- `supabase` (sibling skill root) — row-level security, realtime, storage, Edge Functions
- `rag-retrieval` — `CachedQuery` model accessed via `$queryRaw` (the one model Prisma Client does not
  generate type-safe methods for, because of the `Unsupported("vector(1536)")` column)
- `connectors-oauth` — Gmail OAuth token vault (`GmailConnection` model), scopes, refresh-token
  encryption; the Gmail connector is the second place `userId` flows from `auth.ts` middleware into
  a feature
- `backend-testing` — `backend/tests/helpers/supabase-fake.ts` and `prisma-fake.ts` test seams;
  how to mock `getUser(token)` in backend route tests without hitting GoTrue
- `lumina-frontend` — the React app shell, TanStack Query wiring, and how the `AuthProvider` fits
  into the Vite SPA entry point
