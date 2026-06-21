# The OAuth Round-Trip — stateless PKCE, `state`, and the refresh-token rules

> The Gmail connector's authorization-code-with-PKCE flow against Google, end to end:
> `start → consent → callback → token-exchange`, why `access_type=offline` + `prompt=consent` are
> both mandatory to receive a refresh token, the S256 PKCE pair, the CSRF/identity `state` carried
> encrypted via `seal`/`unseal`, the public callback, and the refresh-token caveats that bite later.
> Read this when building or debugging the connect round-trip, or when "no refresh token came back."
> Sibling refs: **token-vault-encryption.md** owns the AES-256-GCM internals behind `seal`/`unseal`
> and the at-rest refresh-token vault; **google-scope-verification-tiers.md** owns *which* scopes you
> may request and the verification/CASA cost wall; **lumina-connectors-architecture.md** is the full
> wiring map. `lumina-` ref = THIS codebase — cite the live file before you change it (lines drift).

Files: [`backend/connectors/gmail/oauth.ts`](../../../../backend/connectors/gmail/oauth.ts) (the four
pure functions + `openState`/`emailFromIdToken`),
[`backend/connectors/gmail/routes.ts`](../../../../backend/connectors/gmail/routes.ts) (the HTTP
wiring: `/start`, the public `/callback`),
[`backend/connectors/crypto.ts`](../../../../backend/connectors/crypto.ts) (`seal`/`unseal`).

---

## 1. Why this flow is shaped the way it is

Three constraints drive every design choice in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts):

| Constraint | Consequence |
|---|---|
| **Vercel is serverless** — no Redis/session guaranteed between `/start` and `/callback`, and functions freeze between requests. | The flow must be **stateless**: everything `/callback` needs (who started it + the PKCE verifier) rides *inside* `state`, encrypted. No server-side session lookup. |
| **Google's redirect to `/callback` is a raw browser navigation** — it carries no `Authorization` header. | `/callback` must be **public** (no auth middleware); identity is recovered from the sealed `state`, not from `req.userId`. |
| **We need a long-lived refresh token** to act on the mailbox later without the user present. | `access_type=offline` **and** `prompt=consent` are both required, and the callback **rejects** a token response with no `refresh_token` rather than persisting a dead connection. |

PKCE is layered on even though we are a *confidential* client (we hold a client secret): defense in
depth, and — critically here — the PKCE `code_verifier` is the secret we tuck into `state`, so the
verifier never lives anywhere but our own encrypted blob. See the module header comment in
[`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts) (lines 9-15).

---

## 2. The round-trip, step by step

```
Browser (Connectors page)        Backend (/connectors/gmail)              Google
─────────────────────────        ───────────────────────────              ──────
1. click "Connect Gmail"
   fetch GET /start  ───────────► middleware → buildAuthUrl(userId)
   (Authorization header)         • new PKCE pair (verifier, S256 challenge)
                                  • seal({userId, verifier, nonce, exp}) → state
   ◄── { url } (JSON, not 302) ──  returns consent URL as JSON
2. window.location = url ──────────────────────────────────────────────► AUTH_URL
                                                                          consent screen
3. user approves ◄────────────────────────────────────────────────────  302 ?code&state
   browser → GET /callback ─────► (PUBLIC, no middleware)                 (or ?error)
                                  • openState(state) → {userId, codeVerifier}  (throws on tamper/expiry)
                                  • exchangeCode(code, codeVerifier) ─────► TOKEN_URL
                                                                          ◄─ {refresh_token, access_token, id_token, …}
                                  • require refresh_token (else back("error"))
                                  • emailFromIdToken(id_token)
                                  • saveConnection({… encrypted refreshToken})
   ◄── 302 /connectors?gmail=connected
4. later: act on mailbox          refreshAccess(refreshToken) ───────────► TOKEN_URL  (no refresh_token in reply)
                                                                          ◄─ {access_token, expires_in}
```

The four pure functions in `oauth.ts` (no Express; [`routes.ts`](../../../../backend/connectors/gmail/routes.ts)
wires them to HTTP): `buildAuthUrl`, `exchangeCode`, `refreshAccess`, `revokeToken`, plus the helpers
`openState` and `emailFromIdToken`.

---

## 3. `/start` — build the consent URL (behind auth)

`buildAuthUrl(userId)` (in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts), `buildAuthUrl`)
does three things in one shot:

```ts
const codeVerifier  = b64url(crypto.randomBytes(32));                                  // PKCE secret
const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest()); // S256
const state = seal({ userId, codeVerifier, nonce: b64url(crypto.randomBytes(12)),
                     exp: Date.now() + STATE_TTL_MS } satisfies StatePayload);
```

then assembles the query string for `https://accounts.google.com/o/oauth2/v2/auth`:

| Param | Value | Why |
|---|---|---|
| `client_id` / `redirect_uri` | from env (`GOOGLE_CLIENT_ID`, `GMAIL_OAUTH_REDIRECT_URI`) | The redirect URI must **exactly** match one registered in the Google Cloud console, or Google 400s before consent. |
| `response_type` | `code` | Authorization-code grant (not implicit). |
| `scope` | `GMAIL_SCOPES.join(" ")` = `openid email gmail.send gmail.readonly` | `openid email` so the `id_token` carries the address (no extra Userinfo call); the gmail scopes set the verification tier — see **google-scope-verification-tiers.md**. |
| `access_type` | `offline` | **Required to receive a `refresh_token`.** Without it you get only a ~1h access token and no way to act later. |
| `prompt` | `consent` | **Forces the consent screen every time**, so a `refresh_token` is (re)issued on each connect. Without it Google issues a refresh token only on the *very first* consent for that user+client and silently omits it thereafter. |
| `include_granted_scopes` | `true` | Incremental auth — previously-granted scopes stay granted. |
| `code_challenge` + `code_challenge_method` | the S256 challenge, `S256` | PKCE: Google stores the challenge and later verifies our `code_verifier` hashes to it. |
| `state` | the sealed blob | CSRF defense + stateless identity (see §5). |

**Why `/start` returns JSON, not a 302.** The endpoint is behind `middleware`, so the SPA calls it
with `fetch()` + an `Authorization` header and then navigates the browser to `res.json({ url })`
itself. A server `res.redirect()` would make the browser do the hop and **drop the auth header** — and
more importantly we want the *browser* (not our server) to land on Google's consent screen. See the
comment block above `gmailRouter.get("/start", …)` in [`routes.ts`](../../../../backend/connectors/gmail/routes.ts).

---

## 4. `access_type=offline` + `prompt=consent` — the refresh-token gate

This is the single most common connector bug. Both knobs are required, and they fail in *different*
ways:

| You set | Google returns on `/callback` | Symptom |
|---|---|---|
| neither | access_token only, no refresh_token | Connection works for ~1h then dies; cannot refresh. |
| `access_type=offline` only | refresh_token **on the first consent only** | Works for the first user-ever-connects; on reconnect, no refresh_token → callback errors. Looks intermittent. |
| `prompt=consent` only | still no refresh_token (offline is what authorizes long-lived access) | Same as "neither." |
| **both** (our config) | refresh_token **every** consent | Correct. |

The callback enforces this rather than trusting it: in the `/callback` handler in
[`routes.ts`](../../../../backend/connectors/gmail/routes.ts) (the `if (!tokens.refresh_token)` branch),
a missing `refresh_token` logs `[gmail/callback] no refresh_token returned` and redirects
`?gmail=error` — we never persist a connection we can't reuse.

**Refresh-token caveats that bite later** (knowledge, not in our code but governs the flow):

- **≤ 100 refresh tokens per Google account per OAuth client.** Issuing a 101st silently invalidates
  the oldest. Because `prompt=consent` mints a *new* refresh token on every connect, a user who
  reconnects repeatedly burns through the quota — revoke/replace the stored one on reconnect rather
  than accumulating. Our `saveConnection` upserts one row per user (see **token-vault-encryption.md**),
  so we hold one live token per user, not a pile.
- **`refresh_token` is offline-only and consent-only.** It appears solely because of
  `access_type=offline`; the *refresh* call (`refreshAccess`) deliberately never returns one (Google
  omits it — see the function's doc comment in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts)).
- **Unverified-app Testing mode revokes refresh tokens after 7 days.** Until the OAuth consent screen
  is published/verified, every stored refresh token expires in a week — the user must reconnect. This
  is a verification-tier consequence; see **google-scope-verification-tiers.md**.
- **A user-revoked or password-changed account** invalidates the refresh token; the next
  `refreshAccess` 4xxs. The client layer maps that to a typed `GmailAuthError` → "reconnect" (see
  **token-vault-encryption.md** / `client.ts`), it is not handled here.

---

## 5. `state` — CSRF defense + stateless identity, via `seal`/`unseal`

`state` does double duty. The OAuth spec uses `state` purely as a CSRF token (echoed back, compared);
we go further and make it the **entire** session, so the flow needs no Redis.

What we pack (the `StatePayload` interface in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts)):

```ts
interface StatePayload { userId: string; codeVerifier: string; nonce: string; exp: number; }
```

- `userId` — who started the flow (the callback is public, so this is the *only* source of identity).
- `codeVerifier` — the PKCE secret, needed by `exchangeCode`; it never touches the client or the URL bar in plaintext.
- `nonce` — random per-flow, so two concurrent connects never produce identical `state`.
- `exp` — `Date.now() + STATE_TTL_MS` (10 min). A consent screen left open longer must restart.

`seal(payload)` (in [`crypto.ts`](../../../../backend/connectors/crypto.ts), `seal`) AES-256-GCM
encrypts the JSON and returns one URL-safe string `base64url(iv).base64url(authTag).base64url(ct)`.
This buys two properties at once:

| Property | Mechanism | Why it matters for `state` |
|---|---|---|
| **Confidentiality** | GCM encryption | The `codeVerifier` and `userId` are unreadable in the URL/logs/browser history. |
| **Integrity (anti-forgery)** | GCM `authTag` — `unseal` **throws** if a single byte changed | An attacker cannot mint or mutate a `state` to impersonate a user or inject a verifier. This *is* the CSRF guarantee — no separate compare step. |

`openState(state)` (in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts)) is the validator:
it `unseal`s (throwing on tamper), then rejects a malformed payload (`!userId || !codeVerifier || typeof p.exp !== "number"`) and an
expired one (`Date.now() > p.exp`). The `/callback` handler treats any throw as "invalid/forged state"
→ `back("error")`.

> Note: `seal`/`unseal` are the *same* AES-256-GCM primitives as the token vault — `seal` is literally
> `encryptToken(JSON.stringify(payload))` re-encoded URL-safe (see [`crypto.ts`](../../../../backend/connectors/crypto.ts)).
> The key (`GMAIL_TOKEN_ENC_KEY`) and IV/authTag mechanics belong to **token-vault-encryption.md**.

---

## 6. `/callback` — the public landing (the only un-middlewared route)

Google redirects the *browser* here with `?code&state` (or `?error`). It is registered **without**
`middleware` — per-route, not router-level, precisely so this one route stays public while `/start`,
`/status`, `/send`, `DELETE /` keep auth. The router is mounted before global auth in
[`backend/index.ts`](../../../../backend/index.ts).

The handler (in [`routes.ts`](../../../../backend/connectors/gmail/routes.ts), `gmailRouter.get("/callback", …)`)
is a strict funnel, every exit redirecting back to the SPA with a status query param:

```
?error present                 → back("denied")     (user clicked Cancel)
missing ?code or ?state        → back("error")
openState throws (tamper/exp)  → back("error")       (in the catch)
exchangeCode throws            → back("error")       (in the catch)
no refresh_token in response   → back("error")
otherwise                      → saveConnection(…); back("connected")
```

`back(status)` is `res.redirect(`${frontendUrl()}/connectors?gmail=${status}`)`; the frontend reads
`?gmail=` to toast success/failure. Critically, **the callback never returns the raw token to the
browser** — it stores the encrypted refresh token server-side and the browser only learns
"connected/error/denied."

`emailFromIdToken(id_token)` extracts the connected address by base64url-decoding the JWT payload — we
do **not** verify its signature, because the `id_token` came directly from Google's token endpoint over
TLS inside `exchangeCode` (so it is already trusted). A JWKS round-trip would be redundant. See the doc
comment above `emailFromIdToken` in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts).

---

## 7. Token exchange & refresh — the two TOKEN_URL calls

Both POST `application/x-www-form-urlencoded` to `https://oauth2.googleapis.com/token`; the difference is the grant:

| Call | `grant_type` | Sends | Gets back | Notes |
|---|---|---|---|---|
| `exchangeCode(code, codeVerifier)` | `authorization_code` | `code`, `redirect_uri`, `client_id`, `client_secret`, **`code_verifier`** | `{refresh_token?, access_token, expires_in, scope, id_token?}` | The `code_verifier` is what proves the PKCE challenge; `redirect_uri` must match `/start`'s exactly. |
| `refreshAccess(refreshToken)` | `refresh_token` | `refresh_token`, `client_id`, `client_secret` | `{access_token, expires_in}` — **no** refresh_token | Mints a fresh ~1h access token; called on access-token-cache miss in `client.ts`, not here. |

Both `throw new Error("token … failed (${status}): ${text}")` on a non-2xx so the caller can map the
status (the callback → `back("error")`; the client layer → `GmailAuthError`). They are pure fetches —
no caching, no retry — by design; the caching/refresh-on-miss policy lives in `client.ts`
(**token-vault-encryption.md**).

`revokeToken(token)` POSTs to `https://oauth2.googleapis.com/revoke` on disconnect (best-effort; the
`DELETE /` route ignores failure via `.catch`).

---

## 8. Anti-patterns / "do instead"

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Requesting consent without `access_type=offline` (or without `prompt=consent`). | Set **both**. Offline authorizes the long-lived token; `prompt=consent` re-mints it on every connect. The callback already errors if no refresh token arrives. |
| Storing `userId` + PKCE verifier in a server-side session/Redis keyed by `state`. | Encrypt them *into* `state` with `seal`; the flow stays stateless and survives serverless freezes. |
| Putting auth `middleware` on the whole connector router. | Per-route middleware; `/callback` must be public — identity comes from the sealed `state`, verified by `openState`. |
| Using `state` only as a random CSRF nonce you compare server-side. | `state` carries identity *and* its GCM `authTag` is the anti-forgery check — `unseal` throws on tamper, no compare needed. |
| Generating the PKCE challenge as the raw verifier (plain method). | `S256`: challenge = `base64url(sha256(verifier))`; method `S256`. The verifier is sent only at exchange time. |
| Verifying the `id_token` signature via a JWKS fetch to read the email. | It came from Google's token endpoint over TLS in `exchangeCode`; just base64url-decode the payload (`emailFromIdToken`). |
| `res.redirect()` to Google from `/start`. | Return the URL as JSON; let the SPA navigate, so the auth header isn't dropped and the browser owns the hop. |
| Persisting a connection when `tokens.refresh_token` is absent. | `back("error")` and ask the user to retry — a connection without a refresh token is unusable. |
| Reconnecting repeatedly and accumulating refresh tokens. | Upsert one row per user; remember the ≤100/account/client cap silently evicts the oldest. |
| Letting a stale consent screen exchange an old `code`. | `state.exp` (10 min) caps the window; `openState` rejects expired state — the user restarts. |

---

## 9. Debug checklist (symptom → cause)

| Symptom | Likely cause | Where to look |
|---|---|---|
| `?gmail=error`, log `no refresh_token returned` | `access_type`/`prompt` wrong, OR the user already consented and you dropped `prompt=consent`. | `buildAuthUrl` params in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts). |
| `redirect_uri_mismatch` (Google 400, never reaches us) | `GMAIL_OAUTH_REDIRECT_URI` ≠ the URI registered in Google Cloud, or differs between `/start` and `exchangeCode`. | env + both uses of `redirectUri()`. |
| `/callback` → `back("error")` with `[gmail/callback] failed` | `openState` threw (tampered/expired state) or `exchangeCode` 4xx (bad/expired code, secret mismatch). | the `catch` in `/callback`, [`routes.ts`](../../../../backend/connectors/gmail/routes.ts). |
| Works for ~1h then "reconnect" | refresh token revoked (Testing-mode 7-day, user revoke) or never stored. | `refreshAccess` failure → `GmailAuthError` in `client.ts` (**token-vault-encryption.md**). |
| `invalid_grant` on exchange | `code` already used (callback hit twice / browser replay) or expired. | one-shot codes; don't re-run `/callback`. |
| `GMAIL_TOKEN_ENC_KEY` errors on first connect | seal/unseal key missing or not 32 bytes base64. | `key()` in [`crypto.ts`](../../../../backend/connectors/crypto.ts). |
| New `oauth.ts`/`routes.ts` edits not taking effect locally | Bun `--hot` misses new files / some edits — **full dev-server restart**. | recurring repo gotcha. |

---

## 10. Where to add things

- **A new scope** → add to `GMAIL_SCOPES` in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts);
  first check its verification tier in **google-scope-verification-tiers.md** (RESTRICTED scopes drag
  in the annual CASA audit). Existing users must reconnect to grant it.
- **A new OAuth connector (Slack/Notion/Calendar)** → clone this flow: `buildAuthUrl`/`openState`/
  `exchangeCode`/`refreshAccess`/`revokeToken` over the provider's endpoints, the same `seal`-into-
  `state` trick, a public `/callback`. The reusable checklist is **adding-a-new-connector.md**.
- **Anything touching the token at rest** (encryption, the vault, access-token cache, refresh-on-miss)
  → **token-vault-encryption.md**, not here.
