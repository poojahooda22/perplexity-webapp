# The Token Vault — AES-256-GCM at rest + the access-token cache

> How Lumina keeps a long-lived Gmail **refresh token** safe: AES-256-GCM encryption in
> [`crypto.ts`](../../../../backend/connectors/crypto.ts) (`encryptToken`/`decryptToken`, fresh IV +
> authTag, key from **env, never the DB**), one DB writer that holds plaintext for a single call
> ([`store.ts`](../../../../backend/connectors/gmail/store.ts)), and an **in-process access-token
> cache** that refreshes only on a miss ([`client.ts`](../../../../backend/connectors/gmail/client.ts)).
> Read this for anything touching secrets at rest. Adjacent refs: `oauth-flow-and-pkce.md` (where
> the refresh token comes from + the `seal`/`unseal` of `state`), `ai-sdk-connector-tools.md`
> (who *uses* a session), `human-in-the-loop-approval.md` (a different secret — the HMAC approval token).

---

## 1. The threat model — what each layer defends

Lumina holds a **per-user Gmail refresh token**: a near-permanent grant that mints access tokens
forever. Losing one is worse than losing a password — it has no "this device" scope and survives
password changes. The vault is built so that **no single compromise yields a working token.**

| Attacker has… | They get… | Because |
|---|---|---|
| The Postgres DB (dump / leaked backup / read replica) | Ciphertext only (`refreshTokenEnc`, `iv`, `authTag`) | The 256-bit key lives in `GMAIL_TOKEN_ENC_KEY` **env**, never in a DB column or config row. |
| The app env (key) but not the DB | A key with nothing to decrypt | Ciphertext lives only in `gmail_connection` rows. |
| A tampered DB row (flips a ciphertext byte) | A **throw**, not silent corruption | GCM `authTag` fails verification → `decryptToken` throws → the connection reads as broken, not poisoned. |
| The browser / network to the client | Metadata only (`googleEmail`, `scopes`, `connectedAt`) | No endpoint ever returns a token; `getConnectionStatus` selects non-secret columns. |
| A leaked Vercel function log | No secret | Tokens are never logged; only typed errors (`GmailAuthError`) surface. |

The non-negotiable, restated: **a database leak alone must yield ciphertext, not a working
token** — which is exactly why the key is in env, decryption lives in one module, and the token
never crosses the wire to the client.

---

## 2. `crypto.ts` — AES-256-GCM, two jobs from one primitive

`crypto.ts` does two distinct things off the same cipher. Don't confuse them:

| Function pair | Job | Output | Stored where |
|---|---|---|---|
| `encryptToken` / `decryptToken` | Seal the **refresh token** for the DB | `Sealed { ciphertext, iv, authTag }` — three base64 columns | `gmail_connection` row |
| `seal` / `unseal` | Pack the OAuth **`state`** into one opaque URL-safe string | `base64url(iv).base64url(authTag).base64url(ciphertext)` | Nowhere — rides in the redirect URL (see `oauth-flow-and-pkce.md`) |

This doc owns the **first** pair (token at rest). The second pair is the same algorithm reused for
CSRF-safe stateless `state`; `oauth-flow-and-pkce.md` covers its use.

### 2.1 The key — lazy, env-only, validated

```ts
// crypto.ts — key() (lazy-loaded; throws at FIRST use, never at import)
const raw = process.env.GMAIL_TOKEN_ENC_KEY;
if (!raw) throw new Error("GMAIL_TOKEN_ENC_KEY is not set. …32 random bytes, base64-encoded.");
const k = Buffer.from(raw, "base64");
if (k.length !== 32) throw new Error(`…must decode to 32 bytes (AES-256); got ${k.length}…`);
```

Three deliberate properties (in `key()` in [`crypto.ts`](../../../../backend/connectors/crypto.ts)):

- **Lazy.** The key is read on first encrypt/decrypt, not at module import — so importing `crypto.ts`
  can never crash the serverless boot if the env var is absent (same discipline as the lazy Supabase
  client in `auth.ts`; see `lumina-connectors-architecture.md`).
- **Env, not DB.** `process.env.GMAIL_TOKEN_ENC_KEY` only. Putting the key in a DB row would collapse
  the whole threat model — one dump would carry both ciphertext and key.
- **Length-checked.** Must base64-decode to exactly 32 bytes (AES-256). A short/garbled key fails
  loud at startup of the first vault op, not as a subtle wrong-decrypt later.

Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### 2.2 Encrypt — fresh IV every call

```ts
// crypto.ts — encryptToken
const iv = crypto.randomBytes(12);                       // 12-byte GCM nonce, UNIQUE per encryption
const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"),
         authTag: cipher.getAuthTag().toString("base64") };
```

| Element | Value | Why it matters |
|---|---|---|
| Algorithm | `aes-256-gcm` (`ALGO`) | Authenticated encryption: confidentiality **and** integrity in one pass. |
| IV / nonce | `crypto.randomBytes(12)` — **fresh every call** | GCM nonce reuse under the same key is catastrophic (leaks the keystream). 12 bytes is the GCM standard. Never hardcode or reuse. |
| authTag | `cipher.getAuthTag()` | The integrity proof. Stored alongside; required to decrypt. |
| Encoding | base64 for all three | Maps 1:1 onto the three `gmail_connection` columns. |

### 2.3 Decrypt — verify-or-throw

```ts
// crypto.ts — decryptToken
const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(s.iv, "base64"));
decipher.setAuthTag(Buffer.from(s.authTag, "base64"));   // ← without this, GCM won't authenticate
const pt = Buffer.concat([decipher.update(Buffer.from(s.ciphertext, "base64")), decipher.final()]);
```

`decipher.final()` **throws** if the authTag doesn't verify — i.e. a tampered ciphertext, a wrong
key, or a corrupted IV. Callers must treat a throw as "this connection is unusable / reconnect,"
never swallow it into a partial result.

---

## 3. `store.ts` — the only module that touches plaintext

The single rule: **encryption on the way in, decryption on the way out, in one file** — so no other
module ever holds a plaintext refresh token longer than one call. `store.ts` is the **only** writer of
the `gmail_connection` row.

| Function | Returns | Holds plaintext? |
|---|---|---|
| `saveConnection({userId, googleEmail, refreshToken, scopes})` | `void` (upserts) | In, briefly — `encryptToken(refreshToken)` then store the `Sealed` parts |
| `getConnectionStatus(userId)` | `{ googleEmail, scopes, connectedAt }` or `null` | **No** — selects only non-secret columns |
| `loadForSend(userId)` | `{ googleEmail, refreshToken }` (decrypted) or `null` | Out, briefly — the **only** decrypt path |
| `deleteConnection(userId)` | the decrypted refresh token (so the route can revoke at Google) or `null` | Out, once, for revocation |

```ts
// store.ts — saveConnection: encrypt BEFORE the row ever exists
const enc = encryptToken(p.refreshToken);
const data = { googleEmail: p.googleEmail, refreshTokenEnc: enc.ciphertext,
               iv: enc.iv, authTag: enc.authTag, scopes: p.scopes };
await prisma.gmailConnection.upsert({ where: { userId: p.userId },
  create: { userId: p.userId, ...data }, update: data });
```

```ts
// store.ts — getConnectionStatus: the UI-safe view, NO token column selected
const c = await prisma.gmailConnection.findUnique({
  where: { userId },
  select: { googleEmail: true, scopes: true, createdAt: true },   // ← no refreshTokenEnc/iv/authTag
});
```

The `select` is load-bearing: it is the structural guarantee the status endpoint **cannot** leak a
token even by accident — the secret columns never enter the query result. `loadForSend` is the lone
decrypt site:

```ts
// store.ts — loadForSend: the one place ciphertext becomes plaintext
refreshToken: decryptToken({ ciphertext: c.refreshTokenEnc, iv: c.iv, authTag: c.authTag }),
```

`deleteConnection` reuses `loadForSend` to recover the plaintext, deletes the row, and returns the
token so the route can call `revokeToken` at Google — a clean disconnect invalidates the grant
upstream, not just locally (see `oauth.ts:revokeToken`).

**Anti-pattern guard:** any new code path that needs the token must go through `store.ts`. If you find
yourself reading `refreshTokenEnc` outside `store.ts`, stop — you're about to fork the decrypt logic.

---

## 4. `client.ts` — access-token cache, refresh on miss, never to the client

The refresh token is the **vault key to a mailbox**; the access token is a disposable ~1h ticket.
`client.ts` mints and caches access tokens so the refresh token leaves `store.ts` as rarely as
possible — and Google's `/token` endpoint is hit only on a cache miss, never per request.

### 4.1 The cache

```ts
// client.ts — per-process cache; 60s safety margin so we never use a token about to expire
const session = new Map<string, { accessToken: string; email: string; exp: number }>();

export async function getGmailSession(userId) {
  const cached = session.get(userId);
  if (cached && cached.exp > Date.now() + 60_000) return { accessToken: cached.accessToken, email: cached.email };
  const conn = await loadForSend(userId);                 // ← only now does plaintext leave the store
  if (!conn) throw new GmailNotConnectedError();
  let tok;
  try { tok = await refreshAccess(conn.refreshToken); }   // ← Google /token, refresh_token grant
  catch (e) { throw new GmailAuthError(e instanceof Error ? e.message : String(e)); }
  session.set(userId, { accessToken: tok.access_token, email: conn.googleEmail,
                        exp: Date.now() + tok.expires_in * 1000 });
  return { accessToken: tok.access_token, email: conn.googleEmail };
}
```

| Property | Behaviour | Why |
|---|---|---|
| Cache key | `userId` | One live access token per connected user per process. |
| Hit condition | `cached.exp > Date.now() + 60_000` | The **60s safety margin** means we never hand back a token that expires mid-request. |
| Miss path | `loadForSend` → `refreshAccess` → cache | The refresh token surfaces only to mint a new access token, then is dropped. |
| Refresh failure | wrapped as `GmailAuthError` | A rejected refresh token (revoked, 7-day Testing expiry, missing scope) becomes a typed "reconnect" signal, not a raw fetch error. |
| Not connected | `GmailNotConnectedError` | Distinct from auth failure — the UI says "connect," not "reconnect." |

### 4.2 The 401 retry — drop and re-mint once

```ts
// client.ts — gmailFetch: refresh + retry once on 401, then surface a typed error
let res = await call();
if (res.status === 401) { dropGmailSession(userId); res = await call(); }  // stale token → refresh → retry
if (res.status === 401 || res.status === 403)
  throw new GmailAuthError(`Gmail API rejected the request (${res.status}): ${await res.text()}`);
```

A 401 means the cached access token went stale early (revocation, rotation). `dropGmailSession`
evicts it, the next `call()` forces a fresh refresh, and a **second** 401/403 is terminal →
`GmailAuthError` (the persona then tells the user to reconnect; see `ai-sdk-connector-tools.md`).
This is bounded — one retry, never a loop.

### 4.3 Serverless reality

The `session` Map is **per-process and cold-start-wiped** — fine, because the refresh token in
Postgres is the durable source of truth; a fresh instance just re-mints on first use. The cost is one
extra `refreshAccess` per cold instance, not a broken session. The module comment notes a future move
to Upstash for a shared token cache is a one-file change — do it only if refresh-call volume becomes a
problem (Google allows generous refreshes; this is rarely the bottleneck).

---

## 5. The full lifecycle of one token

```
OAuth callback (oauth-flow-and-pkce.md)
  exchangeCode → GoogleTokens.refresh_token (plaintext, in memory)
        │
        ▼  encryptToken (fresh IV + authTag)
  store.saveConnection → gmail_connection { refreshTokenEnc, iv, authTag }   ← AT REST, encrypted
        │
        ▼  (a send/read needs a token)
  client.getGmailSession  ── cache HIT ──► access token (no DB, no Google)
        │  cache MISS
        ▼
  store.loadForSend → decryptToken → refresh token (plaintext, ONE call)
        │
        ▼  oauth.refreshAccess (Google /token)
  access token (~1h) → cached in session Map (60s margin)
        │
        ▼  disconnect
  store.deleteConnection → decrypt once → oauth.revokeToken(refreshToken) at Google → row gone
```

The plaintext refresh token exists in memory at exactly three moments: right after `exchangeCode`
(before `saveConnection` encrypts it), inside `getGmailSession` on a cache miss, and inside
`deleteConnection` to revoke. **Nowhere else, ever.**

---

## 6. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Storing the refresh token plaintext (or base64 — that's not encryption). | `encryptToken` → AES-256-GCM with a fresh IV; store `{refreshTokenEnc, iv, authTag}`. |
| Putting `GMAIL_TOKEN_ENC_KEY` in a DB column or a config table "for convenience." | Env only. A DB dump must never carry the key. |
| Reusing one hardcoded IV (or a counter) across encryptions. | `crypto.randomBytes(12)` **every** call — GCM nonce reuse leaks the keystream. |
| Skipping `decipher.setAuthTag(...)` / catching-and-ignoring the `final()` throw. | Set the authTag and let a throw mean "tampered/wrong key → unusable connection." |
| Reading `refreshTokenEnc` / decrypting outside `store.ts`. | Route everything through `store.ts` (`loadForSend`/`saveConnection`); one decrypt site only. |
| Returning the token (or `refreshTokenEnc`) to the client so the UI can "show the connection." | `getConnectionStatus` metadata only — `{googleEmail, scopes, connectedAt}`. Tokens never cross the wire. |
| Selecting `*` then trusting yourself to strip the token before JSON. | `select` only the non-secret columns in `getConnectionStatus` — make leakage structurally impossible. |
| Calling Google's `/token` (refresh) on every API request. | Cache the access token per `userId` with a 60s margin; refresh on miss only. |
| Logging the refresh/access token (or echoing it in an error). | Log typed errors (`GmailAuthError`/`GmailNotConnectedError`); never the secret. |
| Eager `key()` at module import (crashes serverless boot if env missing). | Lazy `key()` — first-use throw, same as the lazy Supabase/Prisma clients. |
| Looping refresh-and-retry on repeated 401s. | One retry: `dropGmailSession` → re-call once → terminal `GmailAuthError`. |

---

## 7. Decision framework — touching the vault

| You need to… | Do this |
|---|---|
| Persist a newly-obtained refresh token | `store.saveConnection(...)` — it encrypts; never call `prisma.gmailConnection` directly elsewhere. |
| Use Gmail on behalf of a user | `client.gmailFetch(userId, path, init)` (or `getGmailSession`) — handles cache + refresh + 401 retry. |
| Show connection state in the UI | `store.getConnectionStatus(userId)` → wire to the `/status` route → `useGmailStatus`. No token. |
| Disconnect | `store.deleteConnection(userId)` → pass the returned token to `oauth.revokeToken`. |
| Add a NEW secret (e.g. a Slack token) for another connector | Reuse `encryptToken`/`decryptToken`; keep its own env key + its own one-writer store module. See `adding-a-new-connector.md`. |
| Rotate `GMAIL_TOKEN_ENC_KEY` | Existing ciphertext won't decrypt under a new key — plan a re-encrypt migration (decrypt-with-old → encrypt-with-new) or force all users to reconnect. There is **no** key-id column today, so rotation = reconnect unless you add one. |
| Store the key in the DB / return a token to the client / reuse an IV | **Don't** — see §6. These break the threat model in §1. |

---

## 8. Verify it works

- **Round-trip:** `decryptToken(encryptToken("hi")) === "hi"`; flip one base64 char of `ciphertext` →
  `decryptToken` throws (authTag integrity holds).
- **Key discipline:** unset `GMAIL_TOKEN_ENC_KEY` → first vault op throws a clear message, import still
  succeeds (lazy). Set a 16-byte key → length check throws.
- **No leak:** hit the `/status` route → response has `{googleEmail, scopes, connectedAt}` and **no**
  token field; grep the network tab — no `refreshToken`/`refreshTokenEnc` anywhere client-side.
- **Cache:** two back-to-back sends for one user → only **one** `refreshAccess` call to Google (watch
  for it); a forced 401 drops the session and re-mints exactly once.
- **Disconnect:** `deleteConnection` removes the row and the returned token revokes at Google (a later
  `getGmailSession` then throws `GmailNotConnectedError`).
