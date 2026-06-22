---
title: Gmail OAuth + post-connect navigation flow
kind: flow
owning_skill: connectors-oauth
cites:
  - backend/connectors/gmail/routes.ts
  - backend/connectors/gmail/oauth.ts
  - backend/connectors/crypto.ts
  - backend/connectors/gmail/store.ts
  - backend/connectors/gmail/client.ts
  - frontend/src/pages/Dashboard.tsx
  - frontend/src/pages/Connectors.tsx
fresh: 2026-06-22
---

# Gmail OAuth + post-connect navigation flow

Authorization-code **+ PKCE**, and **stateless** — no Redis/session between `/start` and `/callback`
because the PKCE verifier + userId ride **encrypted inside `state`**. Pure OAuth functions live in
`backend/connectors/gmail/oauth.ts` (no Express).

## 1. Connect / authorize — `buildAuthUrl(userId)` (`oauth.ts:69`)
- PKCE pair: `codeVerifier` = base64url(32 rand bytes), `codeChallenge` = base64url(SHA-256(verifier))
  (`oauth.ts:70-71`).
- Seals `{ userId, codeVerifier, nonce, exp }` into `state` via `seal()` (`oauth.ts:72-77`); `STATE_TTL_MS`
  = 10 min (`oauth.ts:29`).
- Consent params (`oauth.ts:79-90`): `access_type:"offline"` (→ refresh token), `prompt:"consent"`,
  `code_challenge_method:"S256"`, `include_granted_scopes:"true"`.
- `GMAIL_SCOPES` (`oauth.ts:23-28`): `openid`, `email`, `gmail.send`, **and `gmail.readonly`**.
- Frontend: `GET /connectors/gmail/start` returns `{ url }` as **JSON, not a 302**, so the SPA's auth header
  survives; `handleConnect()` (`Connectors.tsx:325`) then does `window.location.href = url`.

## 2. Callback — `GET /connectors/gmail/callback` (PUBLIC, `routes.ts:50`)
- `?error` (user cancelled) → `back("denied")`; missing code/state → `back("error")`.
- `openState(state)` (`oauth.ts:95`) unseals + validates (GCM authTag, expiry).
- `exchangeCode(code, codeVerifier)` (`oauth.ts:105`) → `{ refresh_token, access_token, scope, id_token }`.
  No `refresh_token` → `back("error")` (`routes.ts:71-74`).
- `emailFromIdToken(id_token)` (`oauth.ts:152`) decodes the JWT payload (sig not verified — came from Google
  over TLS) → `googleEmail`.
- `saveConnection({ userId, googleEmail, refreshToken, scopes })` (`routes.ts:76-81`) → `back("connected")`.

## 3. Token vault (AES-256-GCM) — `backend/connectors/crypto.ts`
`encryptToken` (`crypto.ts:49`, fresh 12-byte IV/call) / `decryptToken` (`crypto.ts:61`, throws on tamper).
Key loaded lazily from `GMAIL_TOKEN_ENC_KEY` (must be 32 bytes) at `crypto.ts:22`; never in the DB.
`seal`/`unseal` (`crypto.ts:76,85`) reuse the same GCM primitives for the OAuth `state`. Only
`backend/connectors/gmail/store.ts` touches the token: `saveConnection` (`:13`, upsert by `userId`),
`getConnectionStatus` (`:35`, never the token), `loadForSend` (`:46`, decrypts), `deleteConnection` (`:58`).
Prisma model `GmailConnection` at `backend/prisma/schema.prisma:86-100`.

## 4. Refresh — `backend/connectors/gmail/client.ts`
`getGmailSession(userId)` (`client.ts:35`): in-memory `Map` cache (60s safety margin) → on miss
`loadForSend` → `refreshAccess` (`oauth.ts:123`, ~1h access token). `gmailFetch` (`client.ts:66`): bearer
call; on 401 drops cache + retries once; persistent 401/403 → `GmailAuthError` (reconnect).

## 5. THE POST-CONNECT NAVIGATION (the bug that was fixed)
**There is no React Router `navigate()` for this** — navigation is driven by the **server redirect** plus a
frontend **query-param effect**. Two cooperating pieces:

**(a) Backend chooses the landing page by outcome** — `back()` (`routes.ts:53-58`):
- **success → `${frontendUrl()}/?connected=gmail`** — the **Dashboard root `/`** (which hosts the Assistant
  tab), NOT `/connectors`. (`res.redirect` at `routes.ts:54`.)
- cancel/error → `${frontendUrl()}/connectors?gmail=<status>` (stay on Connectors to retry).
- Comment `routes.ts:51-52`: "On success, land the user on the Assistant tab (where they USE the
  connection)… Dashboard reads `?connected=gmail`."

**(b) Frontend switches to the Assistant section** — `Dashboard.tsx` mount effect (`Dashboard.tsx:78-88`)
reads `useSearchParams`:
```
const connected = searchParams.get("connected");
const tab = searchParams.get("tab");
if (connected || tab === "assistant") setSection("Assistant");   // Dashboard.tsx:81
if (connected || tab) { /* delete params, setSearchParams(..., { replace:true }) */ }
```
So returning to `/?connected=gmail` flips `section` to `"Assistant"` → renders `<AssistantView>`
(`Dashboard.tsx:145-148`), then strips the param (`replace:true`) so a refresh won't re-trigger.

**The fix = the `connected` branch in that effect, paired with the success redirect target
`/?connected=gmail`.** The same effect also honors `?tab=assistant`, used by the Connectors "Back" link
(`Connectors.tsx:185`, `to="/?tab=assistant"`) and the Assistant-view buttons.

⚠️ **Drift to fix:** the Connectors UI copy says "Send-only access — Lumina never reads your inbox"
(`Connectors.tsx:71,77`), but `GMAIL_SCOPES` requests `gmail.readonly` and the shipped agent tools are
read-only inbox tools (see [ai-tools-registry](../entities/ai-tools-registry.md)). The copy is stale.

Related: [connectors-gmail](../features/connectors-gmail.md) ·
[secure-tool-args-by-closure](../rules/secure-tool-args-by-closure.md).
