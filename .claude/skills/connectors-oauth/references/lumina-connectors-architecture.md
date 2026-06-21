# Lumina Connectors Architecture — the wiring map

> The whole Gmail connector, file by file: the OAuth routes, the token store, the shared client,
> send + read, the model-callable tools, and the `vertical:"assistant"` chat branch in `index.ts`
> (`buildAssistantSystem`, `streamAssistantAnswer`) — plus the **build-our-own-AI-SDK-tool vs
> remote-MCP** decision that shapes all of it. Read this FIRST when you're lost in the connector.
> Sibling refs go deeper on the parts: `oauth-flow-and-pkce.md` (the round-trip), `token-vault-
> encryption.md` (AES-256-GCM at rest), `ai-sdk-connector-tools.md` (the tool belt), `human-in-
> the-loop-approval.md` (the write/`sendEmail` design), `scheduling-and-cron.md` (deferred sends),
> `google-scope-verification-tiers.md` (the CASA cost wall), `connector-frontend.md` (the UI).
> `lumina-` ref = THIS codebase; line numbers drift, so cite the live file before you change it.

---

## 1. What "the connector" actually is

A Lumina Connector is **two cooperating surfaces** over one connected Google account:

1. **The REST surface** — `/connectors/gmail/*`: `start` / `callback` / `status` / `send` /
   `DELETE`. Used by the browser (the Connectors page) to connect, show status, send a one-off
   email, and disconnect.
2. **The agent surface** — `vertical:"assistant"` on `/perplexity_ask`. A Vercel AI SDK tool loop
   that reads the user's mailbox through closure-injected tools and answers grounded in it.

Both ride the **same credentials in the same encrypted store**, and both go through the **same
shared `client.ts`** for access-token refresh + 401 retry, so the REST send path and the agent read
path can never drift on auth handling. (Same architectural shape as the Finance vertical: a public
read surface and an AI-SDK agent over a shared lower layer — see `finance-markets`.)

```
                          ┌──────────────────────────────────────────────────────┐
  Browser (Connectors)    │  Backend (Bun + Express 5, on Vercel)                  │   Google
  ───────────────────►    │                                                        │   ──────
  GET  /start    (auth)   │  routes.ts ─ buildAuthUrl ─────────────────────────────┼─► (consent URL → 302)
  GET  /callback (PUBLIC) │  routes.ts ─ openState ─ exchangeCode ─ saveConnection ─┼─► oauth2/token
  GET  /status   (auth)   │  routes.ts ─ getConnectionStatus  (metadata, no token)  │
  POST /send     (auth)   │  routes.ts ─ sendGmail ─ client.gmailFetch ────────────┼─► gmail/v1/.../send
  DELETE /       (auth)   │  routes.ts ─ deleteConnection ─ revokeToken ───────────┼─► oauth2/revoke
                          │                                                        │
  POST /perplexity_ask    │  index.ts ─ streamAssistantAnswer                      │
   {vertical:"assistant"} │   ─ streamText + buildGmailTools({userId}) ────────────┼─► gmail/v1/.../messages
  ◄─── SSE stream ────────│       (tools.ts → read.ts → client.gmailFetch)         │
                          │                                                        │
                          │  store.ts  ─ Prisma ─► gmail_connection (refreshTokenEnc, iv, authTag)
                          │  crypto.ts ─ AES-256-GCM (GMAIL_TOKEN_ENC_KEY, env)    │
                          └──────────────────────────────────────────────────────┘
```

---

## 2. File-by-file

### OAuth (pure functions, no Express)
[`backend/connectors/gmail/oauth.ts`](../../../../backend/connectors/gmail/oauth.ts) — the
authorization-code-with-PKCE flow as pure functions the routes wire up:
- `buildAuthUrl(userId)` — generates a fresh PKCE pair, **seals** `{userId, codeVerifier, nonce,
  exp}` into `state` (so the flow is **stateless** — no Redis/session between `/start` and
  `/callback`), and builds the consent URL with `access_type=offline` **+** `prompt=consent` (both
  required to receive a `refresh_token`) and `code_challenge_method=S256`.
- `openState(state)` — `unseal`s the payload; **throws on tamper** (GCM authTag) or `exp` expiry
  (`STATE_TTL_MS` = 10 min).
- `exchangeCode(code, codeVerifier)` → `GoogleTokens` (POST to `oauth2.googleapis.com/token`).
- `refreshAccess(refreshToken)` → `{access_token, expires_in}` (Google omits the refresh token on
  refresh).
- `revokeToken(token)` — best-effort revoke on disconnect.
- `emailFromIdToken(idToken)` — base64url-decodes the id_token payload to read `email`; **does NOT
  verify the signature** (the token came directly from Google's token endpoint over TLS in
  `exchangeCode`, so it's trusted). See `emailFromIdToken` in
  [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts).
- `GMAIL_SCOPES` = `openid email gmail.send gmail.readonly`. `gmail.send` is SENSITIVE (verification,
  **no** CASA audit); `gmail.readonly` is RESTRICTED (verification **+ annual CASA audit, $**) —
  the cost wall. See `google-scope-verification-tiers.md`.

### Token vault (secrets at rest)
[`backend/connectors/crypto.ts`](../../../../backend/connectors/crypto.ts) — `encryptToken`/
`decryptToken` (AES-256-GCM, unique IV + authTag per encryption, key from `GMAIL_TOKEN_ENC_KEY`
env) and `seal`/`unseal` (used by the OAuth `state`). A DB leak yields ciphertext only; the key
lives in env, not the DB. Deep dive: `token-vault-encryption.md`.

[`backend/connectors/gmail/store.ts`](../../../../backend/connectors/gmail/store.ts) — **the only
module that touches the `gmail_connection` row or holds a plaintext refresh token** (and only for
one call):
- `saveConnection({userId, googleEmail, refreshToken, scopes})` — encrypts then upserts
  (`prisma.gmailConnection.upsert`, keyed on `userId`).
- `getConnectionStatus(userId)` — UI-safe metadata only (`{googleEmail, scopes, connectedAt}`),
  **never** a token; `select` deliberately omits `refreshTokenEnc`/`iv`/`authTag`.
- `loadForSend(userId)` — decrypts → `{googleEmail, refreshToken}`, for the client/send path only.
- `deleteConnection(userId)` — deletes the row and **returns** the decrypted token so the route can
  revoke it at Google.

### Shared client (access-token plumbing)
[`backend/connectors/gmail/client.ts`](../../../../backend/connectors/gmail/client.ts) — used by
**both** `send.ts` and `read.ts`:
- `getGmailSession(userId)` — returns a valid ~1h access token + the connected address from a
  **per-process in-memory `session` Map**; calls `refreshAccess` only on a miss, with a **60 s
  safety margin** (`cached.exp > Date.now() + 60_000`) so a near-expiry token is never used.
- `gmailFetch(userId, path, init)` — authed call to `gmail/v1/users/me{path}`. On a **401 it drops
  the cache (`dropGmailSession`) and retries once**; a persistent **401/403 becomes a typed
  `GmailAuthError`** (reconnect needed — e.g. revoked grant, 7-day test expiry, missing scope).
- Typed errors `GmailNotConnectedError` (no row → run connect flow) and `GmailAuthError` (grant
  rejected → reconnect) are defined here and re-exported through `send.ts`.

### Send + read (the Gmail REST operations)
[`backend/connectors/gmail/send.ts`](../../../../backend/connectors/gmail/send.ts) — `sendGmail({
userId, to, subject, body, cc?, bcc?})`. **Derives `from` from `getGmailSession(userId).email`** —
the caller never supplies the sender. `buildRaw` assembles an RFC-2822 MIME message (RFC-2047
encoded-word for non-ASCII subjects, base64 body), base64url-encodes it into Gmail's `raw` field,
and POSTs to `/messages/send` via `gmailFetch`.

[`backend/connectors/gmail/read.ts`](../../../../backend/connectors/gmail/read.ts) — inbox reads
(needs `gmail.readonly`): `getUnreadCount` (the `UNREAD` label's `messagesUnread`, one cheap call),
`listMessages(userId, {query, max})` (ids then **metadata-only** per id — From/Subject/Date +
snippet, `max` clamped 1–20), and `getMessage(userId, id)` (full `format=full`, body decoded via
`extractBody` which DFS-walks the MIME tree preferring `text/plain` then de-tagged `text/html`,
**capped to 8 000 chars** to keep the prompt small).

### The agent tools
[`backend/connectors/gmail/tools.ts`](../../../../backend/connectors/gmail/tools.ts) —
`buildGmailTools({userId})`: a **per-request factory that closes over `userId`**. Returns
`unreadCount`, `listEmails`, `getEmail` (M2a = **read-only**; `sendEmail` write lands in M2b — see
`human-in-the-loop-approval.md`). The model supplies only `query`/`id`/`max`; identity is bound
server-side. Each `execute` is wrapped in `guard()` so a `GmailNotConnectedError`/`GmailAuthError`
returns a typed `{error: "…reconnect Gmail…"}` the model relays, instead of throwing mid-stream.

### The assistant vertical (in index.ts)
- Mounted at line ~62: `app.use("/connectors/gmail", gmailRouter)` — **before global auth**, because
  `/callback` must stay public (per-route middleware inside the router; see §3).
- `buildAssistantSystem()` (in [`index.ts`](../../../../backend/index.ts)) — the persona: read-only
  Gmail access via `unreadCount`/`listEmails`/`getEmail`; **NEVER invent senders/subjects/content**,
  report only tool output; on an `error` tell the user to (re)connect Gmail; render email lists as
  markdown; "can READ but cannot SEND yet."
- `streamAssistantAnswer({res, model, userId, system, messages})` — builds the tools, runs
  `streamText` with `stopWhen: stepCountIs(6)`, `abortSignal: disconnectSignal(res)`, and an
  `onStepFinish` that logs `[assistant-hook] step tools=[…]`. Streams tokens to the client, then
  appends an **empty** `<SOURCES>/<IMAGES>` tail (`sourcesImagesTail([], [])` — the assistant has no
  web sources).
- The two `if (req.body.vertical === "assistant")` branches in `/perplexity_ask` and
  `/perplexity_ask/follow_up`: **no semantic cache, no pre-search**; the follow-up branch prepends a
  compacted summary of older turns (`buildConversationHistory`) into the system prompt, same as the
  other verticals.

### Frontend
[`frontend/src/pages/Connectors.tsx`](../../../../frontend/src/pages/Connectors.tsx) +
[`frontend/src/hooks/use-connectors.ts`](../../../../frontend/src/hooks/use-connectors.ts) — status
card + connect/disconnect. Connect = `fetch /start` (auth header) then **navigate the browser** to
the returned URL; disconnect = the `DELETE` mutation + status invalidation. **No token ever reaches
the client.** Deep dive: `connector-frontend.md`.

---

## 3. Request flows

### The OAuth round-trip
1. SPA → `GET /start` (auth) → `routes.ts` returns `{url}` **as JSON, not a 302** (a server
   redirect would drop the Authorization header on the browser hop), then the SPA navigates the
   browser to Google's consent screen.
2. User consents → Google redirects the **browser** to `GET /callback?code&state` (**public** — no
   auth header on Google's redirect).
3. `openState(state)` recovers `{userId, codeVerifier}` (throws on tamper/expiry) → `exchangeCode`
   → **if no `refresh_token`, `back("error")`** (don't persist an unusable connection) →
   `emailFromIdToken` → `saveConnection` (encrypted) → redirect to `/connectors?gmail=connected`.

### The assistant chat turn
1. `POST /perplexity_ask` with `{query, vertical:"assistant", model?}` → global auth →
   `req.userId`; rate-limit; resolve/create conversation; persist the user turn (non-blocking).
2. `vertical:"assistant"` branch → `writeStreamHeaders` → `streamAssistantAnswer({system:
   buildAssistantSystem(), messages:[{role:"user", content:query}], userId})`.
3. `streamText` runs the tool loop: model calls `listEmails`/`getEmail`/`unreadCount` → `guard()` →
   `read.ts` → `client.gmailFetch` (refresh-on-miss, 401 retry).
4. Tokens stream live; after the stream append the empty `<SOURCES>/<IMAGES>` tail, **persist the
   assistant turn before `res.end()`** (Vercel can freeze on close).
5. Follow-ups add compaction: keep recent turns verbatim, fold older ones into the system prompt.

---

## 4. The build-our-own-tool vs remote-MCP decision

The obvious 2026 instinct for "let the model use Gmail" is **MCP** (point Claude at a Gmail MCP
server). We **deliberately do not** — we build in-process AI-SDK tools instead. The deciding
constraints:

| Axis | Remote MCP server | In-process AI-SDK tools (what we ship) |
|------|-------------------|----------------------------------------|
| **Hosting on Vercel** | An MCP server is a **long-lived process** (stdio/SSE/WebSocket transport). Vercel functions are **per-request and freeze between calls** — they can't host one. | A `tool({…})` is just a function called inside the same `streamText` request. No process to host. ✅ |
| **Per-user identity** | A shared MCP server would have to be told *whose* mailbox per call — the auth/identity has to be threaded through the protocol. | `buildGmailTools({userId})` **closes over `userId`**; the model literally cannot address another mailbox (confused-deputy defense). ✅ |
| **Token vault** | Tokens would live in (or be passed to) the MCP server's auth layer. | Tokens stay in OUR `store.ts` + `crypto.ts`, decrypted only for one refresh call. ✅ |
| **Surface area** | Full MCP toolset (read/modify/labels/drafts) → drags in RESTRICTED scopes → **CASA audit**. | We expose exactly the tools the MVP needs; `gmail.send` stays SENSITIVE. ✅ |
| **Operational cost** | A second always-on service to deploy, monitor, and secure. | Zero extra infra; tools ship with the backend. ✅ |
| When MCP wins | Connecting Lumina-the-client to *someone else's* server, or a self-hosted long-lived worker (the Fly box) exposing tools to external clients. | — |

**Rule of thumb:** on this serverless stack, *we are the server* — we own the OAuth, the vault, and
the tool surface, so we build the tool directly. MCP is for when we want to consume an external
tool server, not host one. (If a future connector genuinely needs a long-lived MCP host, the Fly
worker that runs the finance WebSocket is the only place it could live — never a Vercel route.)

---

## 5. Deploy topology & the landmines

| Concern | Reality | Fix in this repo |
|---------|---------|------------------|
| Public OAuth callback | Google's browser redirect carries no auth header. | **Per-route** `middleware` in `routes.ts` (`/callback` has none); identity rides in the sealed `state`; router mounted **before** global auth in `index.ts`. |
| Refresh token only once | Google returns `refresh_token` only on the FIRST consent unless re-forced. | `access_type=offline` **+** `prompt=consent` in `buildAuthUrl`; `/callback` errors if it's absent. |
| Long-lived timers/sockets | Vercel functions freeze between requests — no `setTimeout`, no MCP server, no poller. | Scheduling = stored row + **external cron** (cron-job.org / Fly worker) → an authed `POST …/cron/run`; never Vercel Cron (Hobby = once/day, GET-only). See `scheduling-and-cron.md`. |
| Access-token cache on serverless | The `session` Map is per-instance + cold-start-wiped. | Acceptable (a miss just refreshes); for a shared hot cache, move to Upstash — a one-file change in `client.ts`. |
| `middleware.ts` at root | Vercel auto-deploys it as Edge Middleware (no Node) → Prisma breaks. | Auth file is `auth.ts`, NOT `middleware.ts`. |
| ESM resolver | Vercel runs strict Node ESM. | Every relative import needs an explicit `.js` extension (note `./oauth.js`, `./store.js` in the connector files; Bun is lenient locally, only breaks on Vercel). |
| Persist before close | Vercel can freeze the function on `res.end()`. | `persistTurns(...)` runs **before** `res.end()` in the assistant branch. |
| New backend file not picked up | Bun `--hot` misses new files. | **Full dev-server restart** after adding any connector file. |

---

## 6. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Standing up a Gmail MCP server "because MCP is the standard." | On Vercel you can't host a long-lived MCP process. Build in-process AI-SDK tools (`buildGmailTools`) that close over `userId`. |
| Adding `userId`/`from` to a tool's `inputSchema`. | Close over `userId` in the factory; `sendGmail` derives `from` from the session. Model-supplied identity is a confused-deputy hole. |
| Putting `middleware` on the whole connector router. | Per-route middleware so `/callback` stays public; identity from the sealed `state`, verified by `openState`. |
| Returning `302` from `/start`. | Return the URL as JSON; the SPA navigates the browser itself (a redirect drops the auth header). |
| Persisting a connection with no `refresh_token`. | `/callback` calls `back("error")` when `tokens.refresh_token` is absent — an unusable connection is worse than none. |
| Returning the token (or `refreshTokenEnc`) to the UI. | `getConnectionStatus` returns metadata only; tokens never leave the server. |
| Calling Google's refresh endpoint on every request. | The `session` Map caches the access token (60 s margin); refresh only on miss, retry once on 401. |
| Verifying the id_token via a JWKS round-trip just to read the email. | It came directly from Google over TLS in `exchangeCode`; base64url-decode the payload (`emailFromIdToken`). |
| Letting the agent invent senders/subjects/bodies when a tool errors. | Tools return typed `{error}` via `guard()`; the persona forbids invention and relays "reconnect Gmail." |
| Treating an in-chat "Send" click as authorization (M2b). | `needsApproval` + HMAC the approval token + re-authorize inside `execute`; a client flag is forgeable. See `human-in-the-loop-approval.md`. |

---

## 7. Where to add things (cheat sheet)

- **New Gmail read tool** → add a `tool({…})` to `buildGmailTools` (closure `userId`, `guard()`-
  wrapped, typed description) → it's already in the loop. Helper in `read.ts` if it's a new API call.
- **The write tool (`sendEmail`)** → `needsApproval` tool in `tools.ts` re-deriving `from` from the
  session; HMAC the approval token; re-authorize inside `execute`. See `human-in-the-loop-approval.md`.
- **Scheduled send** → a `scheduled_email` row claimed atomically
  (`UPDATE … SET status='SENDING' WHERE id=? AND status='PENDING'`) + idempotency key, fired by an
  external cron → `POST /connectors/gmail/cron/run` behind `CRON_SECRET`. Copy the finance cron
  pattern. See `scheduling-and-cron.md`.
- **A whole new connector (Slack/Notion/Calendar)** → mirror the five files: `oauth.ts` (provider
  flow), `store.ts` (encrypted row), `client.ts` (token cache), `tools.ts` (closure-injected),
  `routes.ts` (per-route auth, public callback) → mount before global auth → either a new vertical
  or fold tools into the assistant. See `adding-a-new-connector.md`.
