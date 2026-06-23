# Supabase Edge Functions — Authoring, Securing & Invoking Deno Server Logic

> Generic reference for Supabase Edge Functions on the Deno runtime: `Deno.serve`, secrets, CORS,
> JWT verification, webhook receipt, `functions.invoke`, and `pg_cron` scheduling — with a
> closing section on where Lumina would use them versus its Express + worker/ architecture.

---

## Table of Contents

1. [When (and When Not) to Reach for an Edge Function](#1-when-and-when-not-to-reach-for-an-edge-function)
2. [The Deno Runtime Mental Model](#2-the-deno-runtime-mental-model)
3. [Project Layout: `supabase/functions`](#3-project-layout-supabasefunctions)
4. [`Deno.serve` and the Request/Response Contract](#4-denoserve-and-the-requestresponse-contract)
5. [Imports, Import Maps, and Shared Code](#5-imports-import-maps-and-shared-code)
6. [Secrets and Environment Variables](#6-secrets-and-environment-variables)
7. [Creating Supabase Clients Inside a Function](#7-creating-supabase-clients-inside-a-function)
8. [CORS: Preflight, Allowed Headers, and Origins](#8-cors-preflight-allowed-headers-and-origins)
9. [Verifying the Caller's JWT](#9-verifying-the-callers-jwt)
10. [The `verify_jwt` Gateway Flag vs No-Verify Webhooks](#10-the-verify_jwt-gateway-flag-vs-no-verify-webhooks)
11. [Invoking Functions From the Client](#11-invoking-functions-from-the-client)
12. [Invoking Server-to-Server and via HTTP](#12-invoking-server-to-server-and-via-http)
13. [Webhook Receivers and Raw-Body Signature Verification](#13-webhook-receivers-and-raw-body-signature-verification)
14. [Database Webhooks — React to Row Changes](#14-database-webhooks--react-to-row-changes)
15. [Scheduled Functions via `pg_cron`](#15-scheduled-functions-via-pg_cron)
16. [Cold Starts, Timeouts, and Resource Limits](#16-cold-starts-timeouts-and-resource-limits)
17. [Observability: Logs, Errors, and Tracing](#17-observability-logs-errors-and-tracing)
18. [Testing Edge Functions](#18-testing-edge-functions)
19. [Anti-Patterns](#19-anti-patterns)
20. [Lumina Note: Express + worker/ vs Edge Functions](#20-lumina-note-express--worker-vs-edge-functions)
21. [See also](#21-see-also)

---

## 1. When (and When Not) to Reach for an Edge Function

Edge Functions are Supabase's server-side compute primitive: TypeScript/JavaScript running on the
**Deno runtime** (the open-source `edge-runtime` based on Deno Deploy's isolate model), deployed
globally, invoked over HTTPS. They exist to run **trusted code you cannot put in the browser** —
code that needs the `service_role` key, third-party secrets, or webhook receipt with signature
verification.

Most of your data access should *not* be an Edge Function. Supabase's design choice is that the
browser can talk to Postgres directly through PostgREST (the auto-generated REST API behind
`supabase-js`), and **Row Level Security** is the authorization boundary. Wrapping a plain `select`
in a function to "add a backend" adds a cold-start, a network hop, and a place for bugs while
removing the typed query builder. Reach for a function when one of these triggers applies.

### Decision table: Edge Function vs. alternatives

| Need | Use this | Not this |
|------|----------|----------|
| Read/write data the caller owns | Direct `supabase-js` query + RLS | Edge Function wrapping a query |
| Aggregate/compute over rows server-side | Postgres function via `.rpc()` | Edge Function pulling rows into JS |
| Run code with a **third-party secret** (Stripe, Resend, OpenAI) | **Edge Function** | Client call (leaks the secret) |
| Receive an external **webhook** with signature verification | **Edge Function** (`verify_jwt = false`) | Client; or a DB trigger |
| Bypass RLS for an admin/system operation | **Edge Function** with service-role client | Service-role key in the browser (catastrophic) |
| React to a row change (send email on new row) | **Database Webhook** → Edge Function | Polling from the client |
| Run work on a schedule (nightly digest) | **`pg_cron`** → Edge Function (or SQL directly) | A client-side `setInterval` |
| Strong transactional consistency with the write | Postgres function/trigger (same transaction) | Edge Function (separate connection) |
| Heavy/long CPU work (>150s) | Dedicated worker / queue | Edge Function (wall-clock limits apply) |

> **Rule of thumb:** if the logic is *data shaping over your own tables*, prefer SQL (`.rpc()` to a
> `plpgsql` function) — it runs *inside* the database with no extra hop. If the logic needs a
> **secret, an external API, or webhook signature verification**, use an Edge Function.

---

## 2. The Deno Runtime Mental Model

Edge Functions run on **Deno**, not Node. This is the biggest source of friction for teams arriving
from an Express backend. Internalize these differences before writing a line:

| Concept | Node (Express) | Deno (Edge Functions) |
|---------|----------------|------------------------|
| Module system | CommonJS or ESM, `node_modules` | ESM only, URL / `npm:` / `jsr:` imports |
| HTTP server | `express()` / `http.createServer` | `Deno.serve(handler)` (Web `Request`/`Response`) |
| Env vars | `process.env.X` | `Deno.env.get("X")` |
| Globals | Node globals (`Buffer`, `__dirname`) | Web standard globals (`fetch`, `crypto`, `TextEncoder`) |
| Dependency resolution | `package.json` + install | URL imports, `npm:` specifiers, optional `deno.json` |
| Security | Full access by default | Permissioned (Supabase grants net/env/read in the sandbox) |

Two practical consequences:

1. **Web-standard APIs are first-class.** `fetch`, `crypto.subtle`, `Request`, `Response`,
   `Headers`, `URL`, `TextEncoder`, `ReadableStream`, `Deno.serve` — all present, no imports.

2. **You import by URL or `npm:`/`jsr:` specifier.** The canonical Supabase import is:

```ts
import { createClient } from "jsr:@supabase/supabase-js@2";
```

`jsr:` (the JavaScript Registry) is the modern, recommended source. The older `esm.sh` URL form
still works and appears in legacy examples:

```ts
// Legacy but functional — prefer jsr: in new code
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
```

Most npm packages are importable via the `npm:` prefix (`import Stripe from "npm:stripe@^18"`).
Native-addon and deeply Node-coupled packages may not work; check before committing.

---

## 3. Project Layout: `supabase/functions`

The CLI conventions are strict — get the layout right and everything else (local serve, deploy,
secrets) works automatically.

```
supabase/
├── config.toml                 # project + per-function config
├── functions/
│   ├── deno.json               # (optional) shared import map for all functions
│   ├── _shared/                # underscore prefix → NOT deployed as its own function
│   │   ├── cors.ts
│   │   ├── supabaseAdmin.ts
│   │   ├── auth.ts
│   │   └── errors.ts
│   ├── handle-oauth-callback/
│   │   └── index.ts            # entrypoint — Deno.serve lives here
│   ├── payment-webhook/
│   │   └── index.ts
│   ├── nightly-cleanup/
│   │   └── index.ts
│   └── send-email-notification/
│       └── index.ts
```

Key rules:

- **Each top-level directory under `functions/` whose name does *not* start with `_` is a
  deployable function.** Its slug is the directory name and its entrypoint is `index.ts`.
- **Directories prefixed with `_` (e.g. `_shared`) are not deployed standalone** — they hold code
  imported by real functions. Canonical location for CORS helpers, the admin client factory, and
  auth utilities.
- **Hyphenate slugs** (`payment-webhook`, not `paymentWebhook`). The slug appears in the URL:
  `https://<project-ref>.supabase.co/functions/v1/payment-webhook`.
- **`config.toml`** controls per-function behavior:

```toml
# supabase/config.toml

[functions.payment-webhook]
# External webhook — disable the gateway JWT check; you verify a signature instead.
verify_jwt = false

[functions.handle-oauth-callback]
# Also no Supabase JWT here — identity rides in the encrypted OAuth state parameter.
verify_jwt = false

[functions.nightly-cleanup]
# Called by pg_cron with the service-role bearer.
verify_jwt = false

[functions.my-user-facing-function]
# Default: verify_jwt = true → gateway rejects callers without a valid Supabase JWT.
```

Scaffold a new function with:

```bash
supabase functions new handle-oauth-callback
```

---

## 4. `Deno.serve` and the Request/Response Contract

`Deno.serve` is the runtime's built-in HTTP server. Your handler receives a Web `Request` and must
return a `Response` (or `Promise<Response>`). There is no Express `req`/`res`; you work with the
Fetch standard directly.

```ts
// supabase/functions/hello/index.ts
Deno.serve(async (req: Request): Promise<Response> => {
  const { name } = await req.json().catch(() => ({ name: "world" }));
  return new Response(JSON.stringify({ message: `Hello, ${name}!` }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

> **Deprecation note:** older examples use `serve` imported from `std/http`. This is deprecated.
> `Deno.serve` is built into the runtime and is the only form you should write today.

### Reading the request

```ts
Deno.serve(async (req) => {
  const url    = new URL(req.url);
  const method = req.method;                       // "POST", "GET", "OPTIONS", ...
  const auth   = req.headers.get("Authorization"); // "Bearer <jwt>"
  const param  = url.searchParams.get("userId");   // ?userId=...

  // JSON body (most common). .json() throws on empty/invalid body — guard it.
  const body = await req.json().catch(() => null);

  // Raw text body — REQUIRED for webhook signature verification (§13).
  // const raw = await req.text();

  return new Response("ok");
});
```

### A canonical handler skeleton

Every production function follows the same shape: **CORS preflight → method guard → auth → parse
→ work → typed JSON response → centralized error handling.**

```ts
import { corsHeaders } from "../_shared/cors.ts";
import { jsonResponse, errorResponse } from "../_shared/errors.ts";

Deno.serve(async (req) => {
  // 1. CORS preflight (browsers send OPTIONS before the real request)
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 2. Method guard
    if (req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    // 3. Auth (§9)
    // 4. Parse + validate input
    // 5. Do the work
    // 6. Typed JSON response
    return jsonResponse({ ok: true }, 200);
  } catch (err) {
    // 7. Centralized error handling — never leak internals
    console.error("handler error:", err);
    return errorResponse("Internal error", 500);
  }
});
```

---

## 5. Imports, Import Maps, and Shared Code

### Import styles, ranked

```ts
// 1. PREFERRED — jsr: for Supabase + Deno std
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeHex }    from "jsr:@std/encoding/hex";

// 2. npm: for the npm ecosystem (Stripe, Zod, etc.)
import Stripe    from "npm:stripe@^18";
import { z }     from "npm:zod@^3";

// 3. esm.sh URL — works, common in older docs
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
```

**Always pin versions.** An unpinned `npm:stripe` resolves to "latest" at deploy time, breaking
reproducibility silently.

### The import map (`deno.json`)

Centralize specifiers so every function imports the same versions:

```jsonc
// supabase/functions/deno.json
{
  "imports": {
    "@supabase/supabase-js": "jsr:@supabase/supabase-js@2",
    "stripe":                "npm:stripe@^18",
    "zod":                   "npm:zod@^3",
    "@std/encoding":         "jsr:@std/encoding@^1"
  }
}
```

Then in any function:

```ts
import { createClient } from "@supabase/supabase-js";
import { z }            from "zod";
```

### Shared code (`_shared`)

Three modules you write once and import everywhere:

**`_shared/cors.ts`** — see §8 for the origin-aware variant:

```ts
// supabase/functions/_shared/cors.ts
export const corsHeaders = {
  "Access-Control-Allow-Origin":  "*", // tighten in production — see §8
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age":       "86400",
};
```

**`_shared/errors.ts`** — consistent JSON envelopes:

```ts
// supabase/functions/_shared/errors.ts
import { corsHeaders } from "./cors.ts";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400, code?: string): Response {
  return jsonResponse({ error: { message, code } }, status);
}
```

---

## 6. Secrets and Environment Variables

Edge Functions read configuration via `Deno.env.get(...)`. Two classes of variables exist.

### Auto-injected platform secrets

Supabase injects these into **every** deployed function automatically:

| Variable | Value | Notes |
|----------|-------|-------|
| `SUPABASE_URL` | Project API URL | Same value the frontend uses |
| `SUPABASE_ANON_KEY` | Public anon key | For caller-scoped (RLS-respecting) clients |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service-role key** | Bypasses RLS — server-only, never echoed |
| `SUPABASE_DB_URL` | Direct Postgres connection string | For raw SQL drivers if needed |

The auto-injected names are reserved. Locally, the CLI populates the same names so code is
environment-agnostic.

### Your own secrets

For third-party keys (Stripe, Resend, webhook signing secrets):

```bash
# Set one at a time
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...

# Set from a .env file (does NOT touch reserved SUPABASE_* names)
supabase secrets set --env-file ./supabase/.env.production

# List (values are masked / shown as digests)
supabase secrets list

# Remove
supabase secrets unset STRIPE_SECRET_KEY
```

**Local development** reads from `supabase/functions/.env` automatically when running
`supabase functions serve`. Keep this file gitignored:

```bash
# supabase/functions/.env  (gitignored)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_test_...
RESEND_API_KEY=re_test_...
```

Reading them inside a function:

```ts
const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
if (!stripeKey) {
  // Fail loud at startup, not silently mid-request.
  throw new Error("STRIPE_SECRET_KEY is not set");
}
```

> **Non-negotiable:** the `service_role` key bypasses RLS entirely. It is legitimate to use
> *inside* a function, but the function must **never** echo it into a response, a log line, or
> pass it back to the caller. The function *is* the trust boundary now, not RLS.

---

## 7. Creating Supabase Clients Inside a Function

There are **two distinct clients** and conflating them is the #1 security bug in Edge Functions.

### 7a. The caller-scoped client (respects RLS)

Built with the **anon key** but forwarding the caller's `Authorization` header. Every query then
runs **as the calling user**, with RLS enforced exactly as if the browser had queried directly.

```ts
import { createClient } from "jsr:@supabase/supabase-js@2";

function userClient(req: Request) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: {
        // Forward the caller's JWT so auth.uid() resolves to them and RLS applies.
        headers: { Authorization: req.headers.get("Authorization")! },
      },
      auth: {
        // Functions are stateless — never persist or auto-refresh sessions here.
        persistSession:  false,
        autoRefreshToken: false,
      },
    },
  );
}
```

### 7b. The admin client (bypasses RLS)

Built with the **service-role key**. Every query ignores RLS. Use only for system operations and
only *after* you have independently authorized the request.

```ts
// supabase/functions/_shared/supabaseAdmin.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

// Constructed once at module scope — reused across warm invocations (§16).
export const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
```

### Decision table: which client?

| Situation | Client | Why |
|-----------|--------|-----|
| Function acts on behalf of the signed-in user | **Caller-scoped** | RLS stays the authorization layer |
| Reading/writing only the caller's own data | **Caller-scoped** | Least privilege; no need to bypass RLS |
| Grant a resource after a verified payment | **Admin** | User can't grant themselves; signature proves the payer |
| Webhook with no user context (Stripe) | **Admin** | No caller JWT; you've verified the signature instead |
| `pg_cron` scheduled job aggregating all users | **Admin** | System-wide operation |

> **The cardinal rule:** default to the **caller-scoped** client. Only use the admin client when
> you have a concrete reason to bypass RLS *and* you have authorized the request yourself. Every
> admin-client query is a place where a forgotten ownership check becomes an IDOR vulnerability.

---

## 8. CORS: Preflight, Allowed Headers, and Origins

Edge Functions invoked from a browser are subject to **CORS**. Because `supabase.functions.invoke`
sends custom headers (`Authorization`, `apikey`, `x-client-info`, `content-type`), the browser
fires a **preflight `OPTIONS`** request first. If your function does not answer the preflight with
the right headers, the real request never leaves the browser.

### Two things every browser-facing function must do

1. **Answer `OPTIONS`** with `200`/`204` and the CORS headers.
2. **Echo the CORS headers on the real response too** (the preflight headers don't carry over).

### The wildcard version (development / public functions)

```ts
// supabase/functions/_shared/cors.ts
export const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age":       "86400", // cache preflight 24h to cut round-trips
};
```

`Access-Control-Allow-Headers` **must** include every header the client sends. `supabase-js`
sends `apikey`, `authorization`, `x-client-info`, and `content-type` — omit one and the preflight
fails. Add your own custom headers here too.

### The origin-aware version (production)

`Allow-Origin: *` cannot be combined with credentials and is too permissive for an authenticated
app. In production, reflect a known allowlist:

```ts
// supabase/functions/_shared/cors.ts (production variant)
const ALLOWED_ORIGINS = new Set([
  "https://lumina.example.com",
  "http://localhost:5173", // Vite dev server
]);

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin  = req.headers.get("Origin") ?? "";
  const allowed = ALLOWED_ORIGINS.has(origin);
  return {
    "Access-Control-Allow-Origin":  allowed ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age":       "86400",
    "Vary": "Origin",
  };
}
```

Usage in a handler:

```ts
Deno.serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  // ... work ...
  return new Response(JSON.stringify(result), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
```

> **Webhooks do not need CORS.** Stripe and `pg_cron` are not browsers and do not send preflights.
> Reserve CORS for functions you call from a React or mobile client.

### CORS troubleshooting matrix

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No 'Access-Control-Allow-Origin' header" | OPTIONS not handled, or headers missing on the real response | Handle `OPTIONS`; spread `corsHeaders` onto the final `Response` |
| "Request header field authorization is not allowed" | `authorization` missing from `Allow-Headers` | Add it to `Access-Control-Allow-Headers` |
| Works in Postman, fails in browser | Postman doesn't send preflight; browser does | Implement the `OPTIONS` branch |
| Credentials error with `Allow-Origin: *` | Wildcard + credentials is illegal | Reflect a specific origin from an allowlist |

---

## 9. Verifying the Caller's JWT

For user-facing functions you must establish *who* is calling. Two layers verify it.

### Layer 1: the gateway (`verify_jwt`)

By default, the Supabase API gateway **rejects any request without a valid Supabase JWT** before
your code runs (controlled by `verify_jwt`, default `true` — see §10). This is a coarse gate: it
confirms the token is a valid, unexpired Supabase JWT, but it does *not* tell your code who the
user is or check authorization.

### Layer 2: in-function `getUser`

Inside the function, resolve the actual user from the forwarded `Authorization` header using a
caller-scoped client. `getUser` validates the JWT **against the Auth server** and returns the
authenticated user:

```ts
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    },
  );

  // getUser validates the token; on failure data.user is null and error is set.
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // user.id === auth.uid() in RLS. Now act as this user.
  return new Response(JSON.stringify({ userId: user.id }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
```

### `getUser` vs `getClaims` vs `getSession`

| Method | What it does | Network call? | Use in Edge Functions |
|--------|--------------|---------------|------------------------|
| `getUser(jwt?)` | Validates the JWT against the Auth server | **Yes** | Authoritative; safe but adds latency |
| `getClaims(jwt?)` | Verifies the JWT **locally** using the project's JWKS/signing key | No (after key fetch is cached) | Fast path for high-throughput functions |
| `getSession()` | Returns the in-memory session | No | **Useless in functions** — there is no persisted session |

> **Version anchor:** `getClaims()` performs *local* JWT verification. With Supabase's asymmetric
> JWT signing keys (RS256/ECC) and a published JWKS endpoint, `getClaims()` can cryptographically
> verify the token *without* a round-trip to the Auth server — ideal for high-throughput functions.
> Prefer `getClaims()` for performance once you've confirmed your project uses asymmetric keys;
> prefer `getUser()` when you also need the freshest user record.

```ts
// Fast local verification (asymmetric keys) — no Auth-server round-trip
const { data, error } = await supabase.auth.getClaims();
if (error || !data) return errorResponse("Unauthorized", 401);
const userId = data.claims.sub;           // === auth.uid()
const role   = data.claims.app_metadata?.role;
```

### Authorization is not authentication

`getUser`/`getClaims` tell you *who* the caller is. They do **not** tell you whether the caller
may perform the action. Either:

- Use the **caller-scoped client** and let **RLS** filter (preferred), or
- Check claims/ownership explicitly when using the **admin client** (RLS is bypassed there).

---

## 10. The `verify_jwt` Gateway Flag vs No-Verify Webhooks

`verify_jwt` is a per-function setting in `config.toml` that controls the **gateway** layer.

| `verify_jwt` | Gateway behavior | Use for |
|--------------|------------------|---------|
| `true` (default) | Rejects requests without a valid Supabase JWT | User-facing functions called from your app |
| `false` | Lets every request through; **you** must authorize | Webhooks, `pg_cron` jobs, public endpoints |

```toml
# supabase/config.toml
[functions.payment-webhook]
verify_jwt = false   # Stripe sends its own signature, not a Supabase JWT

[functions.my-user-function]
verify_jwt = true    # (default) gateway requires a Supabase JWT
```

**Why webhooks must set `verify_jwt = false`:** external services (Stripe, GitHub) have no
Supabase JWT to send. With the default `true`, the gateway returns 401 before your code runs and
you'll see failed deliveries with no logs on your side. Turning verification off does **not** make
the endpoint insecure — you replace JWT auth with **signature verification** (§13). An unverified
webhook with no signature check is the real vulnerability.

> **Critical:** `verify_jwt = false` means *anyone* can hit the URL. The function is now fully
> responsible for authenticating the request — via HMAC signature (Stripe), or a shared secret
> header (internal cron). Never deploy a `verify_jwt = false` function that performs writes without
> verifying the caller.

---

## 11. Invoking Functions From the Client

`supabase-js` provides `functions.invoke`, which handles the URL, the `Authorization` header
(current session token), the `apikey` header, JSON serialization, and the `{ data, error }` result
shape consistent with the rest of the SDK.

### Basic invocation

```ts
import { supabase } from "@/lib/supabase";

const { data, error } = await supabase.functions.invoke("my-function", {
  body: { someParam: "value" },
});

if (error) {
  console.error(error.message);
} else {
  console.log(data);
}
```

`invoke` automatically attaches the logged-in user's access token as `Authorization: Bearer <jwt>`
from the persisted session.

### Typed invocation

`functions.invoke` is generic over the expected response type:

```ts
interface MyFunctionResponse {
  resultId: string;
  processedAt: string;
}

const { data, error } = await supabase.functions.invoke<MyFunctionResponse>(
  "my-function",
  { body: { someParam: "value" } },
);
// data is MyFunctionResponse | null
```

### The three error classes

```ts
import {
  FunctionsHttpError,
  FunctionsRelayError,
  FunctionsFetchError,
} from "@supabase/supabase-js";

const { data, error } = await supabase.functions.invoke("my-function", {
  body: { someParam: "value" },
});

if (error instanceof FunctionsHttpError) {
  // The function ran and returned a non-2xx status.
  // The actual JSON body is on error.context — not error.message.
  const details = await error.context.json();
  console.error("Function returned error:", details);
} else if (error instanceof FunctionsRelayError) {
  console.error("Relay error (network between gateway and function):", error.message);
} else if (error instanceof FunctionsFetchError) {
  console.error("Fetch error (couldn't reach the function at all):", error.message);
}
```

> **Gotcha:** when your function returns a non-2xx status, `invoke` surfaces it as a
> `FunctionsHttpError` and `data` is `null`. Your structured error body is on `error.context` (a
> `Response`), not on `error.message`. Call `await error.context.json()` to read it.

### Headers and method

```ts
await supabase.functions.invoke("my-fn", {
  body:    { foo: 1 },
  method:  "POST",                         // default POST; GET/PUT/DELETE supported
  headers: { "x-idempotency-key": uuid },  // must be listed in CORS Allow-Headers
});
```

### TanStack Query integration

Wrap invocations in mutations so loading/error/optimistic state is handled idiomatically:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { FunctionsHttpError } from "@supabase/supabase-js";

export function useProcessConnectorAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { actionId: string }) => {
      const { data, error } = await supabase.functions.invoke<{ resultId: string }>(
        "process-connector-action",
        { body: params },
      );
      if (error) {
        if (error instanceof FunctionsHttpError) {
          const body = await error.context.json();
          throw new Error(body?.error?.message ?? "Action failed");
        }
        throw error;
      }
      return data!;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connector-actions"] }),
  });
}
```

---

## 12. Invoking Server-to-Server and via HTTP

When there is no `supabase-js` client (calling from an Express backend, from `pg_cron`, or from
another function), hit the HTTPS endpoint directly.

### Endpoint shape

```
POST https://<project-ref>.supabase.co/functions/v1/<slug>
Authorization: Bearer <ANON_KEY or SERVICE_ROLE_KEY or USER_JWT>
apikey: <ANON_KEY>
Content-Type: application/json
```

### From an Express/Bun backend (Node 20+, `fetch`)

```ts
const res = await fetch(
  `${process.env.SUPABASE_URL}/functions/v1/send-notification`,
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ userId, message }),
  },
);
if (!res.ok) {
  throw new Error(`Function failed: ${res.status} ${await res.text()}`);
}
const data = await res.json();
```

> If you call a `verify_jwt = true` function from a server with the service-role key, the gateway
> accepts it. But inside, `getUser()` against the service-role token will *not* return a user — it
> isn't a user JWT. Either set `verify_jwt = false` for server-only functions, or pass a real user
> JWT when you need user context.

### From `curl` (debugging)

```bash
curl -i --location --request POST \
  'https://<project-ref>.supabase.co/functions/v1/hello' \
  --header 'Authorization: Bearer <ANON_KEY>' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Lumina"}'
```

### Function-to-function

A function can invoke another with its own admin/anon client or a raw `fetch` to the sibling's
URL. Prefer extracting shared logic into `_shared` over chaining HTTP calls — each hop is another
cold-start and timeout risk.

---

## 13. Webhook Receivers and Raw-Body Signature Verification

Webhooks are the canonical Edge Function use case: an external system POSTs to your function when
something happens (a payment succeeds, a third-party event fires). Because the caller is not your
user, you cannot rely on JWT auth — you set `verify_jwt = false` and verify a **cryptographic
signature** instead.

### The raw-body imperative

Webhook signatures are computed over the **exact raw bytes** of the request body. If you call
`req.json()` first, the SDK parses and re-serializes — and the re-serialized string almost never
matches the original byte-for-byte (key order, whitespace, number formatting differ), so signature
verification **always fails**. You must read the **raw text** and hand *that* to the verifier:

```ts
// CORRECT: read raw bytes first, parse only AFTER verifying
const rawBody  = await req.text();
const signature = req.headers.get("stripe-signature")!;
// verify(rawBody, signature, secret) ... THEN JSON.parse(rawBody)
```

```ts
// WRONG: parsing first destroys the bytes the signature was computed over
const body = await req.json(); // ❌ raw bytes gone; any signature check will now fail
```

### Generic HMAC verification with Web Crypto

For providers that sign with HMAC-SHA256, Deno's `crypto.subtle` does it without any library.
**Compare in constant time** to avoid timing attacks:

```ts
// supabase/functions/_shared/hmac.ts
import { encodeHex } from "jsr:@std/encoding/hex";

export async function verifyHmacSha256(
  rawBody:      string,
  signatureHex: string,
  secret:       string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac      = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = encodeHex(new Uint8Array(mac));

  // Constant-time comparison (length-safe)
  if (expected.length !== signatureHex.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signatureHex.charCodeAt(i);
  }
  return mismatch === 0;
}
```

### A complete webhook receiver skeleton

```ts
// supabase/functions/payment-webhook/index.ts
import Stripe from "npm:stripe@^18";
import { createClient } from "jsr:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  // Deno uses Web Crypto, not Node crypto — require the Fetch HTTP client
  // and the SubtleCrypto provider for async signature verification.
  httpClient:     Stripe.createFetchHttpClient(),
  apiVersion:     "2025-03-31.basil",
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const webhookSecret  = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// Admin client: there is no caller JWT; the signature IS the auth.
// Bypass RLS only after the signature proves the sender is legitimate.
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(async (req) => {
  // No CORS branch needed — Stripe is not a browser.
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing stripe-signature", { status: 400 });

  // RAW body — required for signature verification.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    // constructEventAsync: the async variant uses SubtleCrypto (Deno-compatible).
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error("Signature verification failed:", (err as Error).message);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId  = session.metadata?.user_id;
        // ... grant access with supabaseAdmin using upsert (idempotent) ...
        break;
      }
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status:  200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return new Response("Internal error", { status: 500 });
  }
});
```

> **Why `constructEventAsync` and the crypto provider?** Stripe's classic `constructEvent` uses
> Node's synchronous `crypto`. Deno has no Node `crypto`; it has Web `crypto.subtle`, which is
> **async**. The Stripe SDK ships `createSubtleCryptoProvider()` and `constructEventAsync()`
> precisely for runtimes like Deno/Cloudflare Workers. Using the sync version in an Edge Function
> throws at verification time.

### Webhook hardening checklist

| Control | Why | How |
|---------|-----|-----|
| Verify signature | Prevents forged events | HMAC/Svix/provider SDK over **raw body** |
| `verify_jwt = false` | Provider has no Supabase JWT | `config.toml` |
| Constant-time compare | Prevents signature timing attacks | XOR loop or provider SDK |
| Reject stale timestamps | Prevents replay of captured payloads | Check the `t=` timestamp (Stripe does this for you) |
| Idempotency | Providers retry; you'll get duplicates | Upsert on natural key, or dedupe on the event id |
| Return 2xx fast | Providers retry on non-2xx/timeouts | Acknowledge quickly; defer heavy work |
| Don't leak errors | Error text can aid attackers | Log internally; return a generic 400/500 |

---

## 14. Database Webhooks — React to Row Changes

Sometimes the trigger is *your own data changing* — a new row should fire a notification. Two
mechanisms connect Postgres writes to Edge Functions.

### 14a. Database Webhooks (the managed way)

Supabase **Database Webhooks** are a managed UI/SQL layer over the `pg_net` extension (async HTTP
from Postgres). You configure: a table, the events (`INSERT`/`UPDATE`/`DELETE`), and an HTTP
target (your Edge Function URL). On each matching change, Postgres fires an HTTP POST with the row
payload.

The payload shape your function receives:

```json
{
  "type": "INSERT",
  "table": "conversations",
  "schema": "public",
  "record": { "id": "abc", "userId": "u_1", "title": "What is pgvector?" },
  "old_record": null
}
```

A receiving function (note `verify_jwt = false`, verified by a shared secret):

```ts
// supabase/functions/on-new-conversation/index.ts
interface DbWebhookPayload {
  type:       "INSERT" | "UPDATE" | "DELETE";
  table:      string;
  record:     Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;

Deno.serve(async (req) => {
  // Shared-secret check: configure the webhook to send this header.
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = (await req.json()) as DbWebhookPayload;
  if (payload.type !== "INSERT" || payload.table !== "conversations") {
    return new Response("ignored", { status: 200 });
  }

  const convo = payload.record!;
  // ... send a notification, update a downstream index, etc. ...

  return new Response(JSON.stringify({ ok: true }), {
    status:  200,
    headers: { "Content-Type": "application/json" },
  });
});
```

### 14b. Triggers calling functions via `pg_net` (the SQL way)

For full control and reproducibility, write a `plpgsql` trigger that calls `pg_net.http_post`
directly. This keeps the wiring in migrations (versioned) rather than dashboard config:

```sql
-- migrations/...._notify_new_conversation.sql
create extension if not exists pg_net with schema extensions;

create or replace function public.notify_new_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''   -- non-negotiable for SECURITY DEFINER (search-path hijacking)
as $$
declare
  request_id bigint;
begin
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/on-new-conversation',
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', current_setting('app.webhook_secret', true)
    ),
    body    := jsonb_build_object(
      'type',   'INSERT',
      'table',  'conversations',
      'record', to_jsonb(NEW)
    )
  ) into request_id;
  return NEW;
end;
$$;

create trigger trg_notify_new_conversation
after insert on public.conversations
for each row execute function public.notify_new_conversation();
```

> **Why `pg_net` and not a synchronous call?** `pg_net` performs the HTTP request
> **asynchronously** outside the transaction. A synchronous HTTP call inside a trigger would block
> the write and couple the transaction's success to an external service being available.
> Async fire-and-forget is correct here; durability and retries are the function's responsibility
> (idempotency) and the webhook layer's responsibility.

### Database Webhooks vs trigger + `pg_net` vs client-side invoke

| Approach | Versioned in migrations | Retries | Best for |
|----------|------------------------|---------|----------|
| Database Webhooks (UI) | No (dashboard config) | Basic | Quick reactions, prototyping |
| Trigger + `pg_net` | Yes | Manual (build your own) | Production, audited, reproducible |
| Client invoke after write | Yes (app code) | App-level | When the client is already orchestrating |

Prefer the trigger-in-migration approach for production: reproducible across environments and
reviewable in version control.

---

## 15. Scheduled Functions via `pg_cron`

There is no cron primitive in Edge Functions themselves; scheduling lives in Postgres via the
**`pg_cron`** extension. You schedule SQL that either does the work directly or calls an Edge
Function over HTTP via `pg_net`.

### Enable and schedule

```sql
-- Enable the extensions (once, in a migration)
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- Schedule a nightly job at 03:00 UTC.
select cron.schedule(
  'nightly-cache-cleanup',           -- unique job name
  '0 3 * * *',                       -- standard cron expression
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/nightly-cleanup',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

> **Storing the service-role key:** never hardcode it in the SQL. Use Supabase Vault
> (`vault.secrets`) or a database setting (`current_setting('app.service_role_key', true)`)
> populated from Vault so the secret isn't in plaintext migration history.

### Inspect and manage jobs

```sql
-- List scheduled jobs
select * from cron.job;

-- Inspect run history (success/failure, duration)
select * from cron.job_run_details order by start_time desc limit 20;

-- Remove a job
select cron.unschedule('nightly-cache-cleanup');
```

### The scheduled function itself

A scheduled function has `verify_jwt = false` (the scheduler has no user JWT) and authenticates
via a service-role bearer or shared secret:

```ts
// supabase/functions/nightly-cleanup/index.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

// Construct once at module scope — reused across warm invocations.
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  // Authenticate the scheduler via the service-role bearer it sent.
  const auth = req.headers.get("Authorization");
  if (auth !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // System-wide operation: query all users with stale data, cleanup, etc.
  // Use .range() to page through large result sets — never load everything into memory.
  const { data, error } = await supabaseAdmin
    .from("some_table")
    .select("id")
    .lt("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .range(0, 499);

  if (error) return new Response("DB error", { status: 500 });

  // ... process data batch ...

  return new Response(JSON.stringify({ processed: data?.length ?? 0 }), {
    status:  200,
    headers: { "Content-Type": "application/json" },
  });
});
```

> **Watch the budget.** A nightly batch can blow the wall-clock and memory limits if it loads every
> row into memory. Page with `.range()`, or push aggregation into a `plpgsql` function and have
> the cron job call *that* directly (no Edge Function hop at all). Use Edge Functions in cron only
> when you need a secret or an external API call.

---

## 16. Cold Starts, Timeouts, and Resource Limits

Edge Functions are isolates, not always-on servers.

### The lifecycle

1. **Cold start:** first request spins up a fresh isolate, loads and evaluates your module, and
   runs top-level code. Typically tens to low-hundreds of milliseconds depending on bundle size.
2. **Warm:** subsequent requests reuse the isolate — near-zero startup.
3. **Eviction:** after idle, the isolate is torn down; the next request is cold again.

### Limits (confirm in dashboard for your plan — these move)

| Limit | Typical default |
|-------|-----------------|
| Wall-clock per request | ~150s (longer on paid tiers) |
| Memory | ~256MB |
| Request/response body size | Bounded — stream large bodies |

### Reducing cold starts

```ts
// GOOD: construct clients ONCE at module scope.
// Reused across warm invocations; created once per cold start — not per request.
const supabaseAdmin = createClient(/* ... */);
const stripe        = new Stripe(/* ... */);

Deno.serve(async (req) => {
  // Only per-request work here. Do NOT new up clients inside the handler.
});
```

| Lever | Effect |
|-------|--------|
| Small, pinned dependency tree | Less to bundle/evaluate → faster cold start |
| Clients at module scope | Reuse across warm requests |
| Avoid heavy top-level work | Top-level runs on every cold start |
| `getClaims()` over `getUser()` | Skip the Auth-server round-trip (§9) |
| Keep functions focused | One job per function; fewer imports each |

---

## 17. Observability: Logs, Errors, and Tracing

### Structured logging

Log JSON so you can filter by field. Never log secrets or full JWTs:

```ts
function log(level: "info" | "error", msg: string, meta: Record<string, unknown> = {}) {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({ level, msg, ts: new Date().toISOString(), ...meta }),
  );
}

log("info",  "payment_processed",      { userId, amount: session.amount_total });
log("error", "stripe_verify_failed",   { reason: (err as Error).message });
```

### Error responses that don't leak internals

```ts
catch (err) {
  // Internal: full context for debugging.
  console.error("handler error", { err, userId });
  // External: generic. Never echo err.message or stack to the caller.
  return errorResponse("Could not complete request", 500);
}
```

### HTTP status guide

| Status | When |
|--------|------|
| 200/201 | Success |
| 400 | Bad input / failed validation / failed signature |
| 401 | Missing/invalid auth |
| 403 | Authenticated but not authorized |
| 404 | Unknown route/resource |
| 409 | Conflict (idempotency / duplicate) |
| 429 | Rate limited |
| 500 | Unexpected internal error |

### Viewing deployed logs

View logs in the Supabase dashboard: Edge Functions → your function → Logs. Alternatively via CLI:

```bash
supabase functions logs nightly-cleanup --tail
```

---

## 18. Testing Edge Functions

### Unit-test pure logic with `deno test`

Factor signature verification, payload parsing, and business rules into pure functions in
`_shared`, then test with Deno's built-in test runner (no Supabase needed):

```ts
// supabase/functions/_shared/hmac.test.ts
import { assertEquals } from "jsr:@std/assert";
import { verifyHmacSha256 } from "./hmac.ts";

Deno.test("verifyHmacSha256 accepts a valid signature", async () => {
  const secret = "test-secret";
  const body   = '{"type":"INSERT"}';
  // precompute expected with the same algorithm then assert
  const ok = await verifyHmacSha256(body, "<known-good-hex>", secret);
  assertEquals(ok, true);
});

Deno.test("verifyHmacSha256 rejects a tampered body", async () => {
  const ok = await verifyHmacSha256('{"type":"TAMPERED"}', "<known-good-hex>", "test-secret");
  assertEquals(ok, false);
});
```

```bash
deno test --allow-env supabase/functions/_shared/
```

### Integration-test against the local stack

Start `supabase start` + `supabase functions serve`, then exercise the HTTP endpoint:

```ts
Deno.test("unauthenticated request → 401", async () => {
  const res = await fetch("http://localhost:54321/functions/v1/my-function", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ param: "value" }),
  });
  assertEquals(res.status, 401);
});
```

### Local serve commands

```bash
# Serve all functions with hot reload + secrets from .env file
supabase functions serve --env-file ./supabase/functions/.env

# Serve a webhook without gateway JWT check (mirror production verify_jwt = false)
supabase functions serve payment-webhook --no-verify-jwt --env-file ./supabase/functions/.env
```

Local function URL: `http://localhost:54321/functions/v1/<slug>`

### What to test

| Layer | Test |
|-------|------|
| CORS | `OPTIONS` returns the headers; real response carries them |
| Auth | Missing/invalid JWT → 401; valid JWT → resolves user |
| Authorization | User can't act on another user's resource |
| Webhook signature | Valid → processed; tampered → 400 |
| Idempotency | Duplicate event id doesn't double-write |
| Error envelopes | Bad input → 400 with structured body; never leaks internals |

---

## 19. Anti-Patterns

**Parsing the body before verifying a webhook signature.**
`await req.json()` then trying to verify the signature. The re-serialized JSON differs from the
original bytes, so verification always fails. Fix: `const raw = await req.text()` first. (§13)

**Using the service-role client when a caller-scoped client would do.**
Defaulting every function to the service-role key "to keep it simple" throws away RLS as the
authorization layer. Fix: default to caller-scoped; use service-role only for genuine system
operations after authorizing the request. (§7)

**Returning, logging, or exposing the service-role key.**
The service-role key is total project compromise — RLS bypass on every table. Treat it like a
password; never serialize it. (§6)

**Forgetting the `OPTIONS` / CORS branch on browser-facing functions.**
`invoke` sends custom headers so browsers preflight with `OPTIONS`. No CORS response means the
real request is blocked client-side. Fix: handle `OPTIONS` and spread CORS headers onto every
response. (§8)

**Leaving `verify_jwt = true` on a webhook receiver.**
External providers have no Supabase JWT; the gateway returns 401 before your code runs. Fix: set
`verify_jwt = false` and replace JWT auth with signature verification. (§10, §13)

**`verify_jwt = false` with no signature/secret check.**
Disabling JWT verification without adding any other auth makes the endpoint world-writable. Every
`verify_jwt = false` function must verify a signature (Stripe) or a shared secret. (§10)

**Treating `getSession()` as auth in a function.**
Functions are stateless — there is no persisted session; `getSession` returns nothing useful. Fix:
use `getUser()` or `getClaims()`. (§9)

**Ignoring the structured error body on the client.**
Non-2xx responses surface as `FunctionsHttpError`; the JSON body is on `error.context`, not
`error.message`. Fix: `if (error instanceof FunctionsHttpError) { await error.context.json() }`.
(§11)

**Constructing clients inside the request handler.**
`createClient(...)` / `new Stripe(...)` on every request wastes work and forgoes warm-isolate
reuse. Fix: construct clients once at module scope. (§16)

**Using Stripe's synchronous `constructEvent` in Deno.**
Node's synchronous crypto doesn't exist in Deno. Fix: `constructEventAsync` +
`createSubtleCryptoProvider()` + `createFetchHttpClient()`. (§13)

**Non-idempotent webhook handling.**
`insert` on every webhook event creates duplicates when the provider retries. Fix: `upsert` on a
natural key (`onConflict`), or dedupe on the provider's event id. (§13)

**Wrapping plain data reads in an Edge Function.**
Adds a cold-start and a hop, removes the typed query builder, and gives you a second place to get
authorization wrong. Fix: query directly with `supabase-js` + RLS. (§1)

**Hardcoding the service-role key in `pg_cron` SQL.**
It's now in plaintext migration history and `cron.job` for anyone with DB access. Fix: store in
Supabase Vault; read via `current_setting`. (§15)

---

## 20. Lumina Note: Express + worker/ vs Edge Functions

Lumina does **not** use Supabase Edge Functions. Its architecture is:

- **`backend/` on Vercel** — Bun + Express 5 serverless functions handling auth, the
  `/perplexity_ask` chat pipeline, finance routes, the Gmail connector, and discover feeds.
- **`worker/` on Fly.io** — long-lived WebSocket process for real-time price push.
- **External cron (cron-job.org)** — hits `POST /finance/cron/refresh` with a `CRON_SECRET`
  bearer to warm the Upstash Redis cache on a schedule matching the shortest TTL.

Auth in Lumina (`backend/auth.ts:35-81`) calls `supabase.auth.getUser(token)` to validate JWTs,
then provisions the user row via Prisma. The Supabase JS client has exactly one method call in
production use: `client.auth.getUser(token)`. Everything else goes through Prisma.

### When an Edge Function WOULD fit in Lumina

Despite not using Edge Functions today, the pattern fits naturally for certain additions:

**Database webhook close to the data** — if a new `conversations` row should trigger a downstream
action (notify a connected Slack, index a row for search, update a usage counter), a Database
Webhook → Edge Function is the right primitive. The trigger fires inside Supabase's infrastructure
at zero latency, with no change required to the Express app. The function verifies the
`x-webhook-secret` header, performs the side effect with the admin client, and returns 200. This
is structurally identical to §14 above.

**Third-party webhooks from Stripe / payment providers** — if Lumina adds billing, a Stripe
webhook receiver (`verify_jwt = false`, HMAC signature verified, admin client grants the feature
tier) belongs in an Edge Function rather than in the Express serverless function. The webhook
runs near the database with no cold-Express-instance cost.

**Secrets not safe to expose on the Express server** — for any future integration where the secret
must not touch the Vercel environment (though in practice Vercel env vars are secure), an Edge
Function hosted in Supabase's own infrastructure is an alternative home for the secret.

**What stays in Express:** the streaming `/perplexity_ask` pipeline, the finance agentic routes,
the Gmail connector OAuth flow, and anything that needs Prisma (which doesn't run in Deno). The
Vercel + Express model is already chosen for these and Edge Functions would add friction without
benefit — they don't support Prisma's Node driver adapter (`PrismaPg`) and the `pgvector`
`$queryRaw` calls would need to be rewritten to raw `pg` or Supabase's PostgREST.

### The cron pattern comparison

Lumina's cron warmer uses an external scheduler (cron-job.org) hitting a CRON\_SECRET-guarded
Express route (`backend/finance/routes.ts:124-133`). The `pg_cron` + Edge Function pattern (§15)
is an equivalent alternative: both call a server-side function on a schedule with a secret bearer.
The Express approach avoids Deno and keeps all scheduling logic in the same Express codebase. The
`pg_cron` approach keeps scheduling inside the database, requiring no external scheduler account.
Choose based on where you prefer to own the dependency.

---

## 21. See also

**Within the supabase skill:**

- `lumina-supabase-in-this-repo.md` — Supabase's exact role in Lumina (auth only; Prisma owns
  app data; pgvector via `$queryRaw`); the `client.ts` / `auth.ts` boundary
- `theory-supabase-architecture.md` — keys, the JWT model, RLS vs service-role, the PostgREST
  layer
- `lumina-supabase-realtime-prices.md` — Realtime Broadcast for live price push (the worker/ path
  and when Supabase Realtime channels would replace it)

**Other skills:**

- `connectors-oauth` — Gmail OAuth token vault, scopes, human-in-the-loop approval; the connector
  pattern that would pair with a DB webhook receiver
- `finance-markets` — the Upstash Redis cache layer, cron warmer, and rate limiter that replace
  `pg_cron` + Edge Function for Lumina's finance data pipeline
- `ai-sdk-agent` — `streamText` / tool loops / the SSE wire protocol on the Express side; the
  complement to Edge Functions for AI-heavy server work
- `backend-testing` — `bun:test`, mocking Prisma/Supabase/fetch, auth and route integration tests
  on the Express backend (the Node counterpart to `deno test`)
- `rag-retrieval` — pgvector `$queryRaw` semantic cache; the DB-close pattern that a scheduled
  cleanup Edge Function might maintain
- `lumina-frontend` — `supabase.functions.invoke` from the React/Vite frontend (§11); TanStack
  Query mutation wrappers for function invocations
- `redis` — Upstash Redis over REST, the stale-while-revalidate cache pattern in `backend/lib/cache.ts`
