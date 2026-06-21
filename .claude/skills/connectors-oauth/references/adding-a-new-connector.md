# Adding a New Connector — generalizing the Gmail pattern

> The reusable checklist for the SECOND connector (Slack / Notion / Google Calendar / GitHub):
> exactly which of the seven Gmail modules you copy verbatim, which you rewrite per-provider, and the
> three structural decisions (one vault or per-connector? a new vertical or fold into `assistant`?
> read-only or write+HITL?). Read this when the task is "add a connector"; for the mechanics of any
> single piece read the sibling refs: OAuth round-trip → `oauth-flow-and-pkce.md`, encryption at rest
> → `token-vault-encryption.md`, the tool factory + `guard()` → `ai-sdk-connector-tools.md`, write
> approval → `human-in-the-loop-approval.md`, scopes/verification cost → `google-scope-verification-tiers.md`,
> deferred actions → `scheduling-and-cron.md`, the UI → `connector-frontend.md`. For the full Gmail
> wiring map start at `lumina-connectors-architecture.md`.

The Gmail connector is deliberately built as a **template**, not a one-off. Every file is a single
responsibility with a stable seam, so the next connector is a copy-rename-rewrite-the-provider-bits
job, not a redesign.

---

## 1. The anatomy of a connector (the seven modules)

Gmail lives in [`backend/connectors/gmail/`](../../../../backend/connectors/gmail/) plus one shared
file at the connector root. Map each to its job and its **copy disposition** for the next connector:

| Module | Job | Per-connector? | Disposition |
|--------|-----|----------------|-------------|
| [`connectors/crypto.ts`](../../../../backend/connectors/crypto.ts) | AES-256-GCM `encryptToken`/`decryptToken` + `seal`/`unseal` for `state` | **Shared** | Reuse as-is. Provider-agnostic. |
| [`gmail/oauth.ts`](../../../../backend/connectors/gmail/oauth.ts) | `buildAuthUrl`/`openState`/`exchangeCode`/`refreshAccess`/`revokeToken` + scopes | Per-connector | Copy; swap endpoints, scopes, token-shape. The PKCE + sealed-`state` skeleton is identical. |
| [`gmail/store.ts`](../../../../backend/connectors/gmail/store.ts) | The ONLY DB writer; encrypt-in / decrypt-out the refresh token | Per-connector | Copy; point at the new Prisma model. Logic is identical. |
| [`gmail/client.ts`](../../../../backend/connectors/gmail/client.ts) | In-process access-token cache + refresh-on-miss + `xFetch` (401→drop+retry) | Per-connector | Copy; swap the API base + typed `*AuthError`/`*NotConnectedError`. |
| [`gmail/read.ts`](../../../../backend/connectors/gmail/read.ts) / [`send.ts`](../../../../backend/connectors/gmail/send.ts) | The provider operations (the actual API calls) | Per-connector | **Rewrite** — this is the only genuinely new code. |
| [`gmail/tools.ts`](../../../../backend/connectors/gmail/tools.ts) | `buildXTools({userId})` factory: closure-inject `userId`, `guard()`-wrap each `execute` | Per-connector | Copy the *shape*; describe the new ops. |
| [`gmail/routes.ts`](../../../../backend/connectors/gmail/routes.ts) | HTTP surface: `/start` (auth), `/callback` (PUBLIC), `/status`, write routes, `DELETE /` | Per-connector | Copy; the per-route-middleware + sealed-state pattern is identical. |

**Rule of thumb:** ~80% of a new connector is mechanical copy + provider constants. The real work is
`read.ts`/`send.ts` (the API) and the scope/verification homework (`google-scope-verification-tiers.md`).

---

## 2. The reusable checklist (do these in order)

### A. OAuth (`oauth.ts`)
1. Replace the three endpoints (`AUTH_URL`/`TOKEN_URL`/`REVOKE_URL`) with the provider's. (Slack:
   `slack.com/oauth/v2/authorize` + `oauth.v2.access`; Notion: `api.notion.com/v1/oauth/authorize`
   + `/oauth/token`; Calendar reuses the Google endpoints already in `gmail/oauth.ts`.)
2. Set the `SCOPES` array to the **minimum** scopes the operations need (see §6).
3. Keep `buildAuthUrl`'s PKCE + `seal({userId, codeVerifier, nonce, exp})` skeleton verbatim — it's
   in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts) (`buildAuthUrl`). It works for any
   authorization-code provider; PKCE is harmless even where the provider doesn't require it.
4. **Verify the provider returns a long-lived refresh token, and how to force it.** This is the #1
   per-provider trap (see §4). Google needs `access_type=offline` + `prompt=consent`; Slack/Notion
   differ. The callback must reject if the durable credential is absent (Gmail's `/callback` does:
   `back("error")` when `tokens.refresh_token` is missing, in [`routes.ts`](../../../../backend/connectors/gmail/routes.ts):65).
5. Adapt token-shape typing (`GoogleTokens`) and the identity extraction. Gmail decodes the email
   from the `id_token` **without** a JWKS round-trip because it came over TLS from the token endpoint
   (`emailFromIdToken` in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts):152). Slack returns
   `team`/`authed_user` in the token response; Notion returns `workspace_name`/`bot_id`. Pull a
   human-readable account label from there.

### B. Vault + schema (`store.ts` + Prisma)
6. Add a Prisma model mirroring `GmailConnection` (the template lives in
   [`schema.prisma`](../../../../backend/prisma/schema.prisma):86): `userId @unique`, `refreshTokenEnc`,
   `iv`, `authTag`, `scopes`, a display label, `@@map("<provider>_connection")`, `onDelete: Cascade`.
7. Copy `store.ts`; point it at the new model. `saveConnection` encrypts before the upsert,
   `loadForSend` decrypts on the way out, `getConnectionStatus` returns **metadata only** (no token),
   `deleteConnection` returns the token so the route can revoke it. All four logic-identical.
8. **Reuse `crypto.ts` untouched.** Same `GMAIL_TOKEN_ENC_KEY` env key is fine, or add a per-connector
   key — see §3 vault decision. `db push` via the **session** pooler (5432), then **full restart**
   (Bun `--hot` misses the new model + new files).

### C. Client (`client.ts`)
9. Copy; swap the API base and rename the typed errors (`SlackAuthError`/`SlackNotConnectedError`).
   Keep the in-process session `Map` + 60s safety margin + 401→`drop`+retry-once→typed-error logic
   verbatim ([`client.ts`](../../../../backend/connectors/gmail/client.ts), `getGmailSession`/`gmailFetch`).
   This guarantees send/read can never drift on auth handling.

### D. Operations (`read.ts` / `send.ts`) — the only real new code
10. Implement the provider calls through the new `xFetch`. Return frontend/model-ready shapes, not raw
    API JSON. Throw the typed `*NotConnectedError`/`*AuthError` so `guard()` can map them.

### E. Tools (`tools.ts`)
11. Copy `buildGmailTools` ([`tools.ts`](../../../../backend/connectors/gmail/tools.ts):35) → `buildSlackTools`.
    **`userId` is closure-injected, NEVER in `inputSchema`** — the model supplies only content args.
    This is the confused-deputy defense (Non-Negotiable #1); a model-supplied `userId` lets a prompt
    injection act as another user.
12. Copy the `guard()` helper ([`tools.ts`](../../../../backend/connectors/gmail/tools.ts):17) so a
    not-connected / expired-grant error returns a typed `{ error: "...reconnect on Connectors page" }`
    the model relays, instead of throwing mid-stream.
13. Each tool's `description` must say what it does AND what it does NOT cover, with bounded Zod inputs
    (`.min/.max/.describe`) — the model routes on the description.

### F. Routes (`routes.ts`)
14. Copy; mount at `/connectors/<provider>` in [`index.ts`](../../../../backend/index.ts) **before**
    the global auth middleware (Gmail is mounted at [`index.ts`](../../../../backend/index.ts):62).
15. **Per-route middleware, never router-level** — `/callback` MUST stay public (the OAuth redirect
    carries no auth header; identity rides in the sealed `state`). `/start`, `/status`, writes, and
    `DELETE /` each take `middleware` individually.
16. `/start` returns the consent URL as **JSON** (not a 302) so the SPA navigates the browser itself —
    a server redirect would drop the `Authorization` header on the hop (see the `/start` comment in
    [`routes.ts`](../../../../backend/connectors/gmail/routes.ts):34).

### G. Agent wiring (vertical or fold-in — §5)
17. Either add a tool factory to the existing `assistant` vertical or stand up a new vertical. Register
    the tools in `streamAssistantAnswer` ([`index.ts`](../../../../backend/index.ts):245) and extend
    `buildAssistantSystem` ([`index.ts`](../../../../backend/index.ts):230) to describe the new capability.

### H. Frontend (`connector-frontend.md`)
18. Add a card + status hook (`useXStatus`/`useXDisconnect`). Connect = navigate to the `/start` URL;
    disconnect = the mutation + status invalidation. **No token ever reaches the client** — status is
    `getConnectionStatus` metadata only.

### I. Scopes + verification homework (BEFORE shipping)
19. Classify the scope tier and the launch caps (see §6 and `google-scope-verification-tiers.md`). This
    can block a public launch; do it first, not last.

### J. Verify
20. Connect → `/status` shows `connected` → a tool fires (`[assistant-hook] step tools=[...]` logs the
    call, [`index.ts`](../../../../backend/index.ts):262) → disconnect revokes upstream. New backend
    files → full restart; every relative import needs an explicit `.js` extension.

---

## 3. Decision 1 — one vault or per-connector?

| | Single shared model + key | Per-connector model + (optionally) per-connector key |
|---|---|---|
| Schema | One `Connection` row with a `provider` discriminator | One model per provider (`SlackConnection`, …) |
| Key | One `TOKEN_ENC_KEY` | Per-connector env key (blast-radius isolation) |
| Pro | Less code; one `store.ts` | Independent rotation; a Slack token shape can diverge cleanly |
| Con | A generic schema must hold every provider's metadata | More boilerplate |

**Recommendation:** keep the Gmail shape — **one Prisma model per connector, one shared `crypto.ts`**.
The schema stays typed (no JSON metadata blob), `store.ts` stays trivially copyable, and you can still
share the single `GMAIL_TOKEN_ENC_KEY` or split keys later without a migration. `crypto.ts` is already
provider-agnostic (`encryptToken`/`seal` take any string/object), so it is **never** rewritten.

---

## 4. Decision 2 — the per-provider OAuth gotchas (the part that bites)

PKCE + sealed-state is uniform; the **durable-credential** semantics are not. Get this wrong and the
connection silently dies after ~1h (you stored only an access token).

| Provider | Durable credential | How to obtain it | Identity label |
|----------|-------------------|------------------|----------------|
| Google (Gmail/Calendar) | `refresh_token` | `access_type=offline` **and** `prompt=consent` (both; re-issued only when `prompt=consent` re-forces it) | `email` from `id_token` (no JWKS) |
| Slack | bot/user token (long-lived; **no refresh by default**) | `oauth.v2.access`; store `access_token` directly (rotation is opt-in) | `team.name` + `authed_user.id` |
| Notion | `access_token` (long-lived, **non-expiring**) | `/oauth/token`; no refresh flow at all | `workspace_name` + `bot_id` |
| GitHub (OAuth app) | `access_token` (no expiry unless app opts into expiring tokens) | standard code exchange | `login` via `/user` |

Implications when copying `client.ts`: if the provider has **no refresh token** (Slack/Notion/GitHub),
the access token IS the stored credential — the `refreshAccess`-on-miss step collapses to "read the
stored token; no minting." Keep the typed-error + 401-handling, drop the refresh call. The store still
encrypts that long-lived token at rest exactly the same way.

---

## 5. Decision 3 — new vertical or fold into `assistant`?

Today the connector agent IS the `assistant` vertical: `buildAssistantSystem`
([`index.ts`](../../../../backend/index.ts):230) + `streamAssistantAnswer`
([`index.ts`](../../../../backend/index.ts):245), which calls `buildGmailTools({userId})`. Two ways to
add the next connector:

```
Adding connector X
|
+-- X is a personal-productivity action surface (Slack DM, Calendar event, Notion page)?
|     → FOLD IN: spread its tools into the same assistant turn.
|         const tools = { ...buildGmailTools({userId}), ...buildSlackTools({userId}) };
|       One agent that can act across the user's connected accounts ("email Jane and post in #eng").
|       Mention each connector's capability + not-connected behavior in buildAssistantSystem.
|
+-- X is its own product surface with a distinct persona/UX (a Notion knowledge-base Q&A tab)?
      → NEW VERTICAL: a `vertical:"<x>"` branch + buildXSystem() + streamXAnswer(),
        mirroring how finance is a separate vertical from assistant.
```

| | Fold into `assistant` | New vertical |
|---|---|---|
| When | Composable actions over connected accounts | Distinct persona / page / output protocol |
| Cost | Just merge the tool objects + extend the system prompt | New branch in `/perplexity_ask` (+ follow-up), new persona, new frontend route |
| Risk | Tool-name collisions; a fatter tool belt the model must route within | Duplicated wiring; the finance/assistant split shows the cost |

**Default to fold-in.** The assistant is designed as a multi-account actor; one agent calling
`sendEmail` + `postSlackMessage` in a single turn is the feature. Reserve a new vertical for a genuinely
different product surface (its own persona, page, and possibly output protocol), as finance is.

---

## 6. Decision 4 — read-only first, write behind HITL

Gmail shipped **read tools only** in M2a (no confirmation needed); `sendEmail` (write) is gated behind
`needsApproval` in M2b (see the M2a/M2b note in [`tools.ts`](../../../../backend/connectors/gmail/tools.ts):8).
Apply the same staging to any connector:

| Action class | Examples | Treatment |
|--------------|----------|-----------|
| Read | list/get messages, list calendar events, read a Notion page | Ship first. No approval. `guard()`-wrapped. |
| Write | send DM, create event, append to a page | `needsApproval` + HMAC the approval token + **re-authorize server-side inside `execute`** (re-derive the actor from the session; never trust a client "approved" flag). See `human-in-the-loop-approval.md`. |
| Deferred write | "send later", "remind me at 9am" | Store a row, claim atomically (`UPDATE … SET status='SENDING' WHERE id=? AND status='PENDING'`) + idempotency key, fire from an **external cron** (not Vercel Cron). See `scheduling-and-cron.md`. |

**Scope/verification tier governs the launch boundary.** Always pick the **narrowest** scope. For Google,
`gmail.send` is SENSITIVE (verification, no audit); `gmail.readonly`/`modify` are RESTRICTED → an annual
**CASA audit ($)**. Slack/Notion have no CASA equivalent but their own review for distributed apps and
an install-count cap while unverified. Resolve this in `google-scope-verification-tiers.md` **before**
writing tools you can't legally ship.

---

## 7. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Forking `crypto.ts` per connector. | It's provider-agnostic — `seal`/`encryptToken` take any input. Reuse one shared file. |
| Putting `userId` in the new tool's `inputSchema`. | Closure-inject via `buildXTools({userId})`. The model supplies only content; identity is server-bound. |
| Router-level middleware on the new connector. | Per-route middleware so `/callback` stays public; identity comes from the sealed `state`. |
| `/start` returns a 302 to the consent screen. | Return the URL as JSON; the SPA navigates so the `Authorization` header isn't dropped on the redirect hop. |
| Storing only the access token (`refresh_token`/long-lived token discarded). | Persist the durable credential; for refresh-less providers (Slack/Notion) the long-lived access token IS it. Reject in `/callback` if it's absent. |
| A new vertical for every connector. | Default to folding tools into `assistant`; reserve a vertical for a distinct product surface (as finance is). |
| Shipping a write tool with no approval "to move fast." | Stage it: read tools first, then `needsApproval` + HMAC + server-side re-auth on the write. |
| Requesting broad scopes (`gmail.modify`, Slack `*:write`) up front. | Minimum scopes for the actual ops; classify the verification tier first — RESTRICTED drags in a paid audit. |
| Returning the token to the UI "so it can show connection state." | `getConnectionStatus` metadata only (`{connected, label, scopes, connectedAt}`); tokens never leave the server. |
| Verifying an `id_token` signature with a JWKS round-trip. | It came over TLS from the token endpoint in `exchangeCode`; base64url-decode the payload (`emailFromIdToken`). |
| Editing files and expecting Bun `--hot` to notice the new model/files. | Full dev-server restart; new relative imports need explicit `.js`; `db push` via the session pooler (5432). |

---

## 8. "Done" for a new connector

1. **OAuth:** `/start` (auth) returns the consent URL as JSON; `/callback` is **public**, verifies the
   sealed `state`, exchanges with the PKCE verifier, and persists an **encrypted** durable credential
   (callback errors if absent).
2. **Vault:** a per-connector Prisma model; the credential is AES-256-GCM encrypted (unique IV + authTag,
   key from env); `getConnectionStatus` is metadata-only; no path returns a token to the client.
3. **Client:** in-process token cache, 401→drop+retry-once→typed `*AuthError`; send/read share it.
4. **Tools:** built by a `{userId}` factory (closure-injected), `guard()`-wrapped to typed `{error}`,
   described with what they do AND don't cover.
5. **Writes (if any):** `needsApproval` + HMAC + server-side re-authorization inside `execute`.
6. **Deferred (if any):** stored row + atomic status claim + idempotency key + external cron.
7. **Scope honesty:** you can state the verification tier and unverified-app caps in one sentence.
8. **Agent:** folded into `assistant` (or a justified new vertical); system prompt describes the new
   capability + its not-connected behavior.
9. **Frontend:** live status card; connect = navigate to `/start`; disconnect = mutation + invalidate;
   no token client-side.
10. **Verified end-to-end:** connect → status `connected` → tool fires (`[assistant-hook]` logs it) →
    disconnect revokes upstream. New files → full restart.
