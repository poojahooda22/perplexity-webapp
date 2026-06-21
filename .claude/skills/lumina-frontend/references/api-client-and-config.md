# API Client & Config — the browser→backend wire

> The three files that connect the React SPA to the backend: the typed fetch wrappers + SSE read
> loop ([`lib/api.ts`](../../../../frontend/src/lib/api.ts)), the build-time-inlined backend URL
> ([`lib/config.ts`](../../../../frontend/src/lib/config.ts)), and the Supabase client that mints
> the per-user auth token ([`lib/supabase.ts`](../../../../frontend/src/lib/supabase.ts)). Read this
> when touching any backend call, the streaming reader, the `BUN_PUBLIC_*` env story, or how the
> token rides to the server. Adjacent refs: **streaming-chat-rendering.md** owns `parseStream`'s
> output → UI (this ref owns the read loop that produces the buffer); **auth-and-supabase-frontend.md**
> owns the sign-in/session/redirect flow (this ref owns the token-in-header mechanics);
> **tanstack-query-patterns.md** wraps these functions in queries/mutations.

`lumina-` ref = THIS codebase. Cite the live file before changing it; line numbers drift, function
names are stable.

---

## 1. The shape: every call is `authHeader() → fetch(BACKEND_URL + path)`

There is **no axios, no generated client, no interceptors** — just `fetch` and a tiny
[`authHeader()`](../../../../frontend/src/lib/api.ts) helper. Every function in
[`lib/api.ts`](../../../../frontend/src/lib/api.ts) follows one of two templates:

| Template | Used by | Shape |
|----------|---------|-------|
| **JSON request** | conversations CRUD, Gmail status/start/send/disconnect | `await authHeader()` → `fetch(\`${BACKEND_URL}${path}\`, {headers:{Authorization:token}})` → `if (!res.ok) throw` → `res.json()` |
| **Streaming POST** | `streamAsk` / `streamFollowUp` (the chat verticals) | same header build, but `streamPost` reads `res.body.getReader()` in a loop and calls `onChunk(full)` per chunk |

Both build the header the same way (`authHeader` in `api.ts`):

```ts
async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";   // empty string when signed out
}
```

The header value is the **raw access token, NOT `Bearer <token>`**. The backend reads
`req.headers.authorization` and passes it straight into `getClient().auth.getUser(token)` — see
`middleware` in [`backend/auth.ts`](../../../../backend/auth.ts). **Do not add a `Bearer ` prefix**
on the client; it would break `getUser`. (This is a deliberate project convention, not the OAuth
spec norm — keep it consistent on both ends.)

> A signed-out call sends `Authorization: ""`. The backend's `middleware` returns `401` when the
> header is absent/empty (`if (!token) return res.status(401)`), and the wrapper throws on `!res.ok`.
> That is the intended path — guard the UI before calling, don't special-case the empty token here.

---

## 2. The JSON wrappers — error handling pattern

Every read/mutation wrapper throws an `Error` on non-2xx so callers (TanStack Query) surface it as
an error state. Two error-extraction styles exist on purpose:

| Function (in `api.ts`) | On `!res.ok` | Note |
|---|---|---|
| `fetchConversations`, `fetchConversation`, `renameConversation`, `deleteConversation`, `gmailStatus`, `gmailStartUrl`, `gmailDisconnect` | `throw new Error(\`… (${res.status})\`)` | status-code-only message; no server body parsed |
| `gmailSend` | parses body first (`res.json().catch(() => ({}))`), then `throw new Error(data.error || \`Send failed (${res.status})\`)` | surfaces the **backend's** error string (`data.error`) to the UI — use this style when the server returns a useful message |
| `streamPost` | `const msg = await res.text().catch(() => "")` then `throw new Error(msg || \`Request failed (${res.status})\`)` | reads the error **body as text** (the stream endpoints return plain text, not JSON) before the reader loop starts |

**Decision — which error style to copy:**

```
Adding a new api.ts wrapper?
|
+-- Endpoint returns a useful JSON {error}? ----> copy gmailSend (parse body, prefer data.error)
+-- Streaming endpoint? ------------------------> copy streamPost (res.text() then throw)
+-- Plain read, status is enough? --------------> copy fetchConversations (status-only message)
```

Response envelopes are unwrapped defensively with `?? []` / typed casts, e.g.
`fetchConversations` returns `data.conversations ?? []` and casts via
`(await res.json()) as { conversations?: ConversationSummary[] }`. Match that: **cast the JSON to a
typed envelope and default-coalesce** rather than trusting the shape.

---

## 3. The SSE read loop (`streamPost`)

This is the heart of the chat path. It is **not** EventSource and **not** the `text/event-stream`
`data:` line protocol — it is a raw chunked-text `ReadableStream` decoded incrementally. The backend
writes a single growing text body (answer text, then the `<SOURCES>`/`<IMAGES>` tails); the client
accumulates and re-parses on every chunk.

```ts
async function streamPost(path, body, opts): Promise<AskResult> {
  const token = await authHeader();
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(body),
    signal: opts.signal,                 // <-- abort wiring (see below)
  });

  if (!res.ok || !res.body) {            // also fails if the body stream is null
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Request failed (${res.status})`);
  }

  const conversationId = res.headers.get("x-conversation-id");  // backend-minted id
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });   // streaming decode (multi-byte safe)
    opts.onChunk(full);                                 // hand the WHOLE buffer each time
  }
  return { conversationId, full };
}
```

Load-bearing details, each grounded in the loop above:

| Detail | Why it matters |
|--------|----------------|
| `onChunk(full)` receives the **entire accumulated buffer**, not the delta | The consumer (`runTurn` in [`Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx)) calls `parseStream(full)` each time; the parser is a pure function of the whole buffer. Never change this to pass deltas — `parseStream` would break. |
| `decoder.decode(value, { stream: true })` | `{ stream: true }` carries partial multi-byte UTF-8 across chunk boundaries. Dropping it corrupts emoji / non-ASCII mid-stream. |
| `conversationId` from `res.headers.get("x-conversation-id")` | The backend sets this in `writeStreamHeaders` ([`backend/index.ts`](../../../../backend/index.ts)) and CORS-exposes it (`Access-Control-Expose-Headers: x-conversation-id`). It's how the **first** turn learns its new conversation id (the URL/body had none). Without the CORS expose, `res.headers.get` returns `null` cross-origin. |
| `opts.signal` passed to `fetch` | Aborting the signal cancels the in-flight request AND unblocks `reader.read()` (it rejects). `runTurn` aborts the previous turn before starting a new one. |
| The loop never `JSON.parse`s | Parsing is deferred to `parseStream`; the loop is dumb on purpose — it only concatenates. |

**`parseStream` is in this file but is a rendering concern** — it pulls `<ANSWER>`/`<FOLLOW_UPS>`/
`<SOURCES>`/`<IMAGES>` out of the buffer and is safe on a partial buffer (`parseJsonArray` swallows
`JSON.parse` errors on a half-streamed block; the answer region is "everything before the first
tag"). The wire-format details and how that output renders belong to **streaming-chat-rendering.md** —
don't re-document them here; just know the read loop feeds it.

### The two stream entry points

| Function | Endpoint | When | Body |
|---|---|---|---|
| `streamAsk(query, opts)` | `POST /perplexity_ask` | first turn of a conversation | `{query, conversationId?, model, attachments, vertical}` |
| `streamFollowUp(convId, query, opts)` | `POST /perplexity_ask/follow_up` | subsequent turns | `{conversationId, query, model, attachments, vertical}` — history is rebuilt **server-side** from the id |

Both take `StreamOpts`: `{signal?, onChunk, model?, attachments?, vertical?}` where
`vertical: "discover" | "finance" | "assistant"` selects the backend agent. The `vertical` is
derived from the active section in `runTurn`, not chosen here.

---

## 4. `config.ts` — the `BUN_PUBLIC_BACKEND_URL` build-time-inline gotcha

[`lib/config.ts`](../../../../frontend/src/lib/config.ts) is **two lines** and one of them is a trap:

```ts
export const BACKEND_URL =
  process.env.BUN_PUBLIC_BACKEND_URL || "http://localhost:3001";
```

**Bun inlines `process.env.BUN_PUBLIC_*` at build/transpile time** — it textually replaces the
expression with the literal string in the browser bundle. There is no `process` in the browser and
no runtime lookup. Consequences:

| Symptom | Cause | Fix |
|---------|-------|-----|
| Changed the env var in Vercel, prod still hits the old URL | The value was baked into the last build; a runtime env change does nothing | **Redeploy the frontend** after changing it |
| All API calls 404 in prod | Value was scheme-less (`api.lumina.app`) → becomes a **relative path** → `fetch("api.lumina.app/conversations")` resolves against the page origin | Always a full `https://…` URL with scheme |
| Calls go to `localhost:3001` in prod | `BUN_PUBLIC_BACKEND_URL` was unset at build → fell through to the dev fallback | Set it in the Vercel build env, then redeploy |

**Set it in two places:** `frontend/.env.local` (dev) and the Vercel project env (prod). The
fallback `http://localhost:3001` is the local backend port — never rely on it in prod.

> The same build-time-inline rule governs the Supabase publics in §5. Anything the browser reads
> from `process.env` MUST be `BUN_PUBLIC_`-prefixed and is a **compile-time constant** — treat all
> three (`BACKEND_URL`, Supabase URL, anon key) as baked-at-build.

---

## 5. `supabase.ts` — anon key only, auth token in headers

[`lib/supabase.ts`](../../../../frontend/src/lib/supabase.ts) creates the one browser Supabase client:

```ts
const supabaseUrl     = process.env.BUN_PUBLIC_SUPABASE_URL     || (import.meta.env && import.meta.env.BUN_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = process.env.BUN_PUBLIC_SUPABASE_ANON_KEY || (import.meta.env && import.meta.env.BUN_PUBLIC_SUPABASE_ANON_KEY);
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Supabase URL and Anon Key must be provided…");
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

Key facts:

| Fact | Detail |
|------|--------|
| **Only the ANON key reaches the browser** | The anon key is publicly safe (RLS-gated); a **service-role/vendor key must NEVER appear here**. All upstream provider keys (Twelve Data, Tavily, Finnhub, …) live server-side only. |
| **Two env sources, OR'd** | `process.env.BUN_PUBLIC_*` (Bun inline) **or** `import.meta.env.BUN_PUBLIC_*` (Vite-style) — the OR makes the file work under either bundler/dev path. The `import.meta.env &&` guard avoids a ReferenceError where `import.meta.env` is undefined. |
| **Throws at module load if unset** | Unlike the backend's *lazy* Supabase init (`auth.ts` defers `createClient` so missing env can't crash the whole serverless function), the **frontend throws eagerly** — a missing public env is a build/deploy misconfig that should fail loud and early in the SPA. |
| **The client's job here is the token** | `api.ts` only uses `supabase.auth.getSession()` to read `session.access_token`. The sign-in flow (OAuth, session persistence, redirects) is **auth-and-supabase-frontend.md**'s territory. |

**The token's full journey** (this is the one chain to remember):

```
supabase.auth.getSession()           (supabase.ts client, frontend)
  → session.access_token             (authHeader() in api.ts)
  → Authorization: <raw token>       (fetch header, NO "Bearer ")
  → req.headers.authorization        (backend/auth.ts middleware)
  → getClient().auth.getUser(token)  (validates; 5-min token cache; provisions user row once)
  → req.userId                       (downstream routes)
```

---

## 6. Anti-patterns

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Prefixing the header with `Bearer ` to "follow OAuth convention." | Send the **raw** `access_token`; the backend's `getUser(req.headers.authorization)` expects the bare token. |
| Setting `BUN_PUBLIC_BACKEND_URL` in Vercel and expecting it live without a rebuild. | It's a compile-time constant — set it, then **redeploy** the frontend. |
| A scheme-less `BACKEND_URL` (`api.foo.com`). | Always full `https://…`; scheme-less becomes a relative path → 404s. |
| Shipping a service-role/vendor key in `supabase.ts` or any `BUN_PUBLIC_*` to "make a call work." | Only the **anon** key client-side; proxy everything else through the backend with the user's token. |
| Passing the per-call delta to `onChunk`/`parseStream`. | Pass the **whole accumulated buffer** every chunk — `parseStream` is a pure function of `full`. |
| `decoder.decode(value)` without `{ stream: true }`. | Keep `{ stream: true }` so multi-byte UTF-8 survives chunk boundaries. |
| Reading `x-conversation-id` but the backend not CORS-exposing it. | The header must be in `Access-Control-Expose-Headers` (it is, in `index.ts`) or `res.headers.get` is `null` cross-origin. |
| `JSON.parse` inside the read loop / throwing on a partial `<SOURCES>` block. | Loop only concatenates; defer parsing to `parseStream`, which guards every parse. |
| Adding axios/an interceptor layer for "consistency." | Match the existing thin `authHeader() → fetch` pattern; pick an error style from §2. |
| Following a backend `302` for the Gmail connect flow. | `gmailStartUrl` **fetches** the URL (header rides along), reads `data.url`, then the caller navigates — a 302 would drop the `Authorization` header on the hop. |

---

## 7. Adding a new backend call — checklist

1. **Define typed request/response interfaces** at the top of `api.ts` (see `ConversationSummary`,
   `GmailSendInput`).
2. **Build the header** with `const token = await authHeader();` → `headers: { Authorization: token }`
   (add `"Content-Type": "application/json"` for bodies).
3. **Hit `${BACKEND_URL}${path}`** — never a hardcoded host.
4. **Throw on `!res.ok`** using the §2 style that fits the endpoint.
5. **Cast + default-coalesce** the JSON envelope (`as { x?: T[] }` → `?? []`).
6. **Streaming?** Reuse `streamPost` (don't re-implement the reader); add a thin `streamX` wrapper
   like `streamAsk`.
7. **Wrap in TanStack** Query/mutation in `hooks/` — see **tanstack-query-patterns.md**.
