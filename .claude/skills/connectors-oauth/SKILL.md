---
name: connectors-oauth
description: >
  Build Lumina's AI Connectors (Gmail today, more later): per-user OAuth (PKCE, offline access),
  an encrypted token vault (AES-256-GCM), AI-SDK tools over a connected account with userId
  injected by closure, human-in-the-loop approval for write actions, scheduling via an external
  cron, the Google scope/verification tiers (gmail.send SENSITIVE vs gmail.readonly RESTRICTED +
  CASA), and the connector frontend (Connectors page, status hooks, connect/disconnect). Use
  whenever the task touches OAuth, refresh tokens, the token vault, the /connectors/* routes, the
  assistant chat vertical, needsApproval/scheduled email, Google verification, or adding a new
  connector (Slack/Notion/Calendar).
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/connectors/**'
    - 'backend/connectors/gmail/**'
    - 'frontend/src/pages/Connectors.tsx'
    - 'frontend/src/hooks/use-connectors.ts'
  bashPatterns:
    - 'oauth'
    - 'gmail'
    - 'connector'
  promptSignals:
    phrases:
      - 'oauth'
      - 'gmail'
      - 'connector'
      - 'token vault'
      - 'refresh token'
      - 'needsApproval'
      - 'scheduled email'
      - 'google scope'
      - 'CASA'
      - 'PKCE'
      - 'assistant'
    minScore: 3
---

# connectors-oauth

> Build a Lumina Connector the way the live Gmail one already does it: a **stateless PKCE OAuth
> flow** (identity rides encrypted in `state`), an **AES-256-GCM token vault** the frontend never
> touches, **AI-SDK tools whose `userId` is injected by closure** (never by the model), **human-in-
> the-loop approval** on writes, and **scheduling off an external cron** (Vercel can't hold timers).
> This skill is the map from any connector task to the exact reference + the exact file in
> [`backend/connectors/`](../../../backend/connectors/).

---

## Domain Identity

**This skill OWNS** — the connector pattern end to end:
- The OAuth flow: [`backend/connectors/gmail/oauth.ts`](../../../backend/connectors/gmail/oauth.ts)
  (`buildAuthUrl`/`openState`/`exchangeCode`/`refreshAccess`/`revokeToken`) and the routes that wire
  it ([`backend/connectors/gmail/routes.ts`](../../../backend/connectors/gmail/routes.ts):
  `/start`, the **public** `/callback`, `/status`, `/send`, `DELETE /`).
- The **token vault**: [`backend/connectors/crypto.ts`](../../../backend/connectors/crypto.ts)
  (`encryptToken`/`decryptToken`, `seal`/`unseal`) + the only DB writer
  [`backend/connectors/gmail/store.ts`](../../../backend/connectors/gmail/store.ts).
- The connector **tools + assistant vertical**:
  [`backend/connectors/gmail/tools.ts`](../../../backend/connectors/gmail/tools.ts)
  (`buildGmailTools({userId})`), the shared client
  ([`backend/connectors/gmail/client.ts`](../../../backend/connectors/gmail/client.ts)),
  read/send ([`read.ts`](../../../backend/connectors/gmail/read.ts),
  [`send.ts`](../../../backend/connectors/gmail/send.ts)), and the `vertical:"assistant"` branch in
  [`backend/index.ts`](../../../backend/index.ts) (`buildAssistantSystem`, `streamAssistantAnswer`).
- **HITL approval** for write actions, **scheduling** (store-a-row + external cron), and the Google
  **scope/verification reality** (the cost wall that decides the MVP boundary).
- The connector **frontend**: [`frontend/src/pages/Connectors.tsx`](../../../frontend/src/pages/Connectors.tsx)
  + [`frontend/src/hooks/use-connectors.ts`](../../../frontend/src/hooks/use-connectors.ts) + the
  connect/disconnect flow from the browser.

**This skill does NOT own (route elsewhere):**
- Generic AI-SDK mechanics — how `streamText`/`tool`/`stopWhen`/hooks work in the abstract →
  **ai-sdk-agent**. This skill shows the *connector-specific* tool belt (closure injection, `guard()`,
  `needsApproval`); that skill owns the engine and the citation/abort wiring.
- The generic frontend shell (sidebar, routing, chat-view rendering) → **lumina-frontend**. This
  skill owns only the Connectors page + its status hooks.

---

## Decision Tree

```
Connector task arrives
|
+-- "How is the connector wired? routes/store/client/tools/vertical?" -> lumina-connectors-architecture.md
+-- "Build/debug the OAuth round-trip; refresh token missing; state" -> oauth-flow-and-pkce.md
+-- "Encrypt a token at rest; the enc key; never to the client" -----> token-vault-encryption.md
+-- "Add/change a connector tool; closure-inject userId; guard()" ---> ai-sdk-connector-tools.md
+-- "A WRITE action (sendEmail); approve before sending; HMAC" ------> human-in-the-loop-approval.md
+-- "Which Google scope? verification? CASA audit? cost wall?" ------> google-scope-verification-tiers.md
+-- "Send later / scheduled email / cron / atomic claim" -----------> scheduling-and-cron.md
+-- "Build the Connectors UI / cards / detail modal / connect flow"-> connector-frontend.md
+-- "Add a NEW connector (Slack/Notion/Calendar) — the checklist" --> adding-a-new-connector.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **`userId` is injected via the tool-factory closure — the model NEVER supplies `userId` or the from-address.** The model passes only the query/id; identity is bound server-side. | `buildGmailTools({userId})` in [`tools.ts`](../../../backend/connectors/gmail/tools.ts); `sendGmail` derives `from` from `getGmailSession(userId)` in [`send.ts`](../../../backend/connectors/gmail/send.ts). A model-supplied userId is a **confused-deputy / prompt-injection** hole — an injected instruction could read or send as another user. |
| 2 | **Refresh tokens are AES-256-GCM encrypted at rest (unique IV + authTag, key from env) and NEVER reach the frontend.** Decryption happens only in the store, on the way to a refresh call. | `encryptToken`/`decryptToken` in [`crypto.ts`](../../../backend/connectors/crypto.ts); the key is `GMAIL_TOKEN_ENC_KEY` (env, not DB) so a DB leak yields ciphertext. `store.ts` is the only module that holds plaintext, and only for one call; `getConnectionStatus` returns metadata with **no** token. |
| 3 | **The OAuth `/callback` is PUBLIC** — Google's browser redirect carries no auth header, so identity rides in the **signed/encrypted `state`**, not middleware. | Per-route middleware in [`routes.ts`](../../../backend/connectors/gmail/routes.ts) (`/callback` has none); `openState` `unseal`s `{userId, codeVerifier, exp}` and **throws on tamper** (GCM authTag) or expiry. The router is mounted before global auth in [`index.ts`](../../../backend/index.ts). |
| 4 | **Write actions (`sendEmail`) are `needsApproval` AND re-authorized server-side inside `execute`.** Approval is a security boundary, not just a UX affordance — HMAC the approval token (`experimental_toolApprovalSecret`) and verify it server-side before sending. | M2b design (see `human-in-the-loop-approval.md`). The current REST `/send` validates address/size and re-derives the from-address; the tool path must additionally gate on a verified approval token, never trusting a client "approved" flag. |
| 5 | **Scheduling uses an atomic claim + idempotency key, fired by an external cron — not Vercel Cron.** Claim with `UPDATE … SET status='SENDING' WHERE id=? AND status='PENDING'`; only the worker that wins the row sends. | Vercel/serverless can't hold timers; Vercel Cron Hobby = once/day, GET-only. Use cron-job.org or the Fly worker → a `POST /connectors/gmail/cron/run` guarded by `CRON_SECRET`. Reuse the finance cron pattern. See `scheduling-and-cron.md`. |
| 6 | **One refresh token, requested correctly, once.** `access_type=offline` + `prompt=consent` are **both required** to receive a `refresh_token`; Google returns it only on the FIRST consent unless `prompt=consent` re-forces it. | `buildAuthUrl` in [`oauth.ts`](../../../backend/connectors/gmail/oauth.ts); `/callback` rejects (`back("error")`) if `tokens.refresh_token` is absent rather than persisting an unusable connection. |
| 7 | **Access tokens are cached per-process and refreshed on miss; a 401 drops the cache and retries once, then becomes a typed `GmailAuthError`.** | `getGmailSession`/`gmailFetch` in [`client.ts`](../../../backend/connectors/gmail/client.ts) (60s safety margin). Never call Google's refresh endpoint on every request. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Adding `userId` to a tool's `inputSchema` so the model "knows whose mailbox." | Close over it: `buildGmailTools({userId})`. The model supplies only `query`/`id`; identity is server-bound. |
| Putting `middleware` on the whole connector router. | Per-route middleware so `/callback` stays public; identity comes from the sealed `state`, verified by `openState`. |
| Storing the refresh token plaintext (or the enc key in the DB / a config row). | AES-256-GCM with a fresh IV per encryption; key from `GMAIL_TOKEN_ENC_KEY` env only; decrypt solely in `store.ts`. |
| Returning the token (or `refreshTokenEnc`) to the client "so the UI can show it." | Frontend gets `getConnectionStatus` metadata only (`{connected, googleEmail, scopes, connectedAt}`). Tokens never leave the server. |
| Treating an in-chat "Send" click as authorization to send. | `needsApproval` + HMAC the approval token + re-authorize inside `execute`; a client flag is forgeable. |
| Reading-then-writing a scheduled-send row's status in app code (read PENDING, then set SENDING). | One atomic guarded `UPDATE … SET status='SENDING' WHERE id=? AND status='PENDING'`; the row lock is the single ticket window. Add an idempotency key so a cron retry can't double-send. |
| Using Vercel Cron (or a `setTimeout`) to fire scheduled emails. | External cron (cron-job.org / Fly worker) → an authed `POST …/cron/run`. Serverless freezes between requests. |
| Requesting `gmail.readonly`/`gmail.modify` for an MVP that only sends. | RESTRICTED scopes drag in an **annual CASA audit ($)**. `gmail.send` is SENSITIVE (verification, no audit) — the deliberate MVP boundary. |
| Verifying the `id_token` signature with a JWKS round-trip to read the email. | It came directly from Google's token endpoint over TLS in `exchangeCode`; base64url-decode the payload (`emailFromIdToken`). |
| Letting the agent invent senders/subjects/bodies when a tool errors. | Tools return a typed `{ error }` via `guard()`; the persona relays "reconnect Gmail" and reports only tool output. |

---

## Output Contract (what "done" looks like)

A connector change is done when:
1. **OAuth:** `/start` returns the consent URL (JSON, behind auth); `/callback` is public, verifies
   `state`, exchanges the code with the PKCE verifier, and persists an **encrypted** refresh token;
   `access_type=offline` + `prompt=consent` guarantee a refresh token (callback errors if absent).
2. **Vault:** the refresh token is AES-256-GCM encrypted (unique IV + authTag, key from env);
   `getConnectionStatus` exposes metadata only; no path returns a token to the client.
3. **Tools:** any new tool is built by a `{userId}` factory (closure-injected, never model-supplied),
   wrapped in `guard()` so not-connected/expired errors surface as typed `{ error }`, and described so
   the model knows exactly when to call it.
4. **Writes:** every write action is `needsApproval`, HMAC-verified, and re-authorized server-side
   inside `execute` (the from-address re-derived from the session, never trusted from input).
5. **Scheduling:** deferred actions are a stored row claimed atomically (`status` guard) + idempotency
   key, fired by an external cron behind `CRON_SECRET` — never Vercel Cron or an in-process timer.
6. **Scope honesty:** you can state, in one sentence, which Google verification tier the scope sits in
   (SENSITIVE vs RESTRICTED + CASA) and the unverified-app caps you're shipping under.
7. **Frontend:** the Connectors page shows live status via `useGmailStatus`, connects by navigating to
   the `/start` URL, disconnects via the mutation + status invalidation; no token ever client-side.
8. **Verified:** the full round-trip works end-to-end (connect → status `connected` → tool fires:
   `[assistant-hook]` logs the call → disconnect revokes at Google). New backend files → full restart.

---

## Bundled References (9 files)

Read the one or two the task needs — never the whole folder.

### Architecture & the core flow
| File | Load when |
|------|-----------|
| `lumina-connectors-architecture.md` | You need the full wiring map: routes (`/start`/`/callback`/`/send`/`DELETE`), `store`, `client`, `send`, `read`, `tools`, and the `vertical:"assistant"` branch in `index.ts` (`buildAssistantSystem`, `streamAssistantAnswer`). Includes the **build-our-own-AI-SDK-tool vs remote-MCP** decision (Vercel can't host a long-lived MCP server, so tools live in-process). Start here when lost. |
| `oauth-flow-and-pkce.md` | Building/debugging the round-trip: `start → consent → callback → token-exchange`; why `access_type=offline` + `prompt=consent` (to actually get a refresh token), PKCE S256, CSRF `state` via `seal`/`unseal`, the public callback, and refresh-token caveats (≤100 per account, offline-only, Testing-mode 7-day revoke). |
| `token-vault-encryption.md` | Anything touching secrets at rest: AES-256-GCM in `crypto.ts` (`seal`/`unseal`, IV, authTag), encrypting the refresh token, `GMAIL_TOKEN_ENC_KEY` from env (not DB), the in-process access-token cache + refresh-on-miss in `client.ts`, and why tokens never reach the client. |

### The connector agent
| File | Load when |
|------|-----------|
| `ai-sdk-connector-tools.md` | Adding/changing a connector tool: `buildGmailTools({userId})` closure injection, the read tools (`unreadCount`/`listEmails`/`getEmail`), and `guard()` mapping not-connected/expired errors to a typed `{ error }` the model relays. Cross-ref **ai-sdk-agent** for the generic tool-calling loop. |
| `human-in-the-loop-approval.md` | Designing a WRITE action: `needsApproval` tools, the client render-draft + Send/Cancel via `addToolApprovalResponse`, `experimental_toolApprovalSecret` (HMAC) + server-side re-authorization inside `execute`. The `sendEmail` (M2b) design. (Generic pattern — reuse for any connector write.) |
| `google-scope-verification-tiers.md` | Deciding scopes/launch posture: `gmail.send` = SENSITIVE (verification, **no** audit) vs `gmail.readonly`/`modify` = RESTRICTED (verification + **annual CASA audit, $**); the unverified-app reality (100-user cap, 7-day refresh-token revoke in Testing). The cost wall that sets the MVP boundary. (Generic Google-OAuth knowledge.) |

### Scheduling & frontend
| File | Load when |
|------|-----------|
| `scheduling-and-cron.md` | Deferred/scheduled actions: there is **no** Gmail scheduled-send API, so store a row + let an external cron fire it; the atomic-claim `UPDATE` for concurrency/idempotency; cron-job.org or the Fly worker (**NOT** Vercel Cron: Hobby = once/day, GET-only). Reuse the finance cron pattern. |
| `connector-frontend.md` | Building the UI: `Connectors.tsx` (card grid + detail modal + compose), `use-connectors` (TanStack: `useGmailStatus`/`useGmailDisconnect`/`useGmailSend`), the sidebar wiring, and the connect/disconnect flow from the browser. Tokens never client-side. |
| `adding-a-new-connector.md` | Generalizing the Gmail pattern for the next connector (Slack/Notion/Calendar): OAuth + encrypted vault + closure-injected tools + a vertical (or unify into the main chat). The reusable checklist. |

---

## Cross-repo prior art / cross-skill routing

- **Sibling skills:** **ai-sdk-agent** owns the generic `streamText`/tool loop, `stopWhen`,
  abort-on-disconnect, and the `[n]` citation wire format the assistant vertical reuses;
  **lumina-frontend** owns the app shell/sidebar/chat rendering; **finance-markets** is the
  proven prior art for the **external-cron-off-Vercel** pattern (`/finance/cron/refresh` behind
  `CRON_SECRET`) — copy it for scheduled sends.
- **Project memory:** `connectors-gmail-kb` (the end-to-end Gmail design + the Google
  scope-verification cost wall) and `brand-is-lumina` (never "Perplexity" in user-visible text).
- **fintech-webapp** (`e:\Development\Portfolio-phase2\fintech-webapp\.claude`) — if it grows an
  OAuth/integrations layer, its licensing/secrets discipline is the nearest prior art; translate
  any Next.js/Drizzle code → our Express 5 / Prisma stack. Always verify against the live file
  before relying on a `file:line` (line numbers drift).
