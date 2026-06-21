# Google OAuth Scope Tiers, App Verification & the CASA Cost Wall

> The decision that sets the boundary of any Google connector MVP: **which scope you request
> determines whether you owe Google a free brand review (SENSITIVE) or a recurring paid third-party
> security audit (RESTRICTED + CASA), and what your app can do at all before verification clears.**
> Read this when picking Gmail/Drive/Calendar scopes, planning a launch posture, or explaining why
> Lumina ships `gmail.send` and treats `gmail.readonly` as deferred. This is **generic Google-OAuth
> knowledge** (it applies to any app touching a Google API), illustrated with the live flow in
> [`backend/connectors/gmail/oauth.ts`](../../../../backend/connectors/gmail/oauth.ts). Adjacent refs:
> `oauth-flow-and-pkce.md` (the round-trip + refresh-token mechanics), `token-vault-encryption.md`
> (storing the token at rest), `human-in-the-loop-approval.md` (why write actions gate before they
> fire), `lumina-connectors-architecture.md` (where this fits the whole connector).

---

## 1. The three tiers (memorize this table)

Google sorts every OAuth scope into one of three sensitivity tiers. The tier — **not the API** —
decides your verification path. Two scopes on the *same* Google API can sit in different tiers (this
is exactly the Gmail trap: `gmail.send` and `gmail.readonly` are both Gmail, different tiers).

| Tier | Example scopes | Verification required to leave Testing? | Annual third-party audit? | Cost | Review time |
|------|----------------|-----------------------------------------|---------------------------|------|-------------|
| **Non-sensitive** | `openid`, `email`, `profile`, `.../auth/userinfo.*` | No (just publish) | No | $0 | Instant |
| **Sensitive** | `gmail.send`, `gmail.compose`, `gmail.insert`, `calendar.events`, `contacts` | **Yes** — Google brand/consent review | **No** | $0 (your time only) | Days–weeks |
| **Restricted** | `gmail.readonly`, `gmail.modify`, `gmail.metadata`, `https://mail.google.com/`, `drive`, `drive.readonly` | **Yes** | **Yes — CASA, every year** | **$$$ (paid security assessment)** | Weeks–months |

**The one-line mental model:** *Non-sensitive = free + instant. Sensitive = free + a brand review.
Restricted = a brand review PLUS a recurring paid security audit you must re-pass every 12 months.*
The jump from Sensitive to Restricted is the cost wall — it is not a bigger version of the same
review, it is a different category of obligation (money + an external auditor, forever).

---

## 2. The Gmail scopes specifically (where Lumina lives)

Gmail is the canonical "two scopes, two tiers" example. From
[`backend/connectors/gmail/oauth.ts`](../../../../backend/connectors/gmail/oauth.ts) (`GMAIL_SCOPES`):

| Gmail scope | What it grants | Tier | Audit |
|-------------|----------------|------|-------|
| `openid`, `email` | The connected account's identity (rides in the `id_token`) | Non-sensitive | none |
| `gmail.send` | Send mail **as** the user (no read of the mailbox) | **SENSITIVE** | **none** |
| `gmail.compose` | Create/update drafts + send | Sensitive | none |
| `gmail.insert` | Insert messages (no read) | Sensitive | none |
| `gmail.metadata` | Headers + labels, **no message bodies** | **RESTRICTED** | CASA |
| `gmail.readonly` | Read all mail (bodies, attachments) | **RESTRICTED** | CASA |
| `gmail.modify` | Read + write (labels, archive, trash) | **RESTRICTED** | CASA |
| `https://mail.google.com/` | Full IMAP/SMTP/everything | **RESTRICTED** | CASA |

**Why `gmail.send` is the deliberate MVP boundary:** it is the *only* mutating Gmail scope that does
the job an "AI assistant that sends email" needs while staying SENSITIVE. The moment you add *reading
the inbox* (`gmail.readonly`/`modify`/`metadata`) you cross into RESTRICTED and inherit CASA. So an
assistant that **drafts and sends** can launch on a free brand review; an assistant that **summarizes
your inbox** cannot launch without paying for an annual audit.

> Note the live `GMAIL_SCOPES` array currently also lists `gmail.readonly`. That is a **build-time
> decision, not a launch decision** — requesting it in dev lets you build the read tools, but it
> silently promotes the whole app to the RESTRICTED verification path. Before publishing, the read
> scope must be dropped (or the audit budgeted). See the anti-pattern table.

---

## 3. What "unverified app" actually means (the reality before any review)

You do **not** need verification to *build and demo*. An unverified app works — under hard caps that
make it unshippable, not unusable. There are two distinct unverified states, and they behave very
differently:

| Publishing status | Who can connect | Consent screen | The killer caveat |
|-------------------|-----------------|----------------|-------------------|
| **Testing** | Only emails on the OAuth **test-users** list (max **100**) | "Google hasn't verified this app" / shows for test users | **Refresh tokens for SENSITIVE/RESTRICTED scopes are revoked after 7 days.** Every test user must re-consent weekly. |
| **In production, unverified** | Anyone — but capped at **100 lifetime users total** | Loud **unverified-app interstitial** ("Advanced" → "Go to … (unsafe)") that scares real users away | The 7-day revoke does **not** apply, but you're stuck at 100 users forever until verified, and the scary screen tanks conversion. |
| **In production, verified** | Anyone, unlimited | Clean, branded consent | none (re-audit yearly if RESTRICTED) |

**The 7-day refresh-token revoke is the single most confusing dev gotcha.** It only bites in
**Testing** mode and only for sensitive/restricted scopes. Symptom: "Gmail was connected, now every
tool call 401s after about a week." It is **not** a bug in your refresh logic — Google deliberately
expired the refresh token. Fixes: (a) accept weekly re-consent in dev, (b) move the app to
"In production" (still unverified — kills the 7-day expiry, keeps the 100-user cap + scary screen),
or (c) verify. This is why `/callback` must persist a fresh refresh token on every consent — see
`access_type=offline` + `prompt=consent` below.

---

## 4. How the code already sets up for this

The OAuth request in [`oauth.ts`](../../../../backend/connectors/gmail/oauth.ts) (`buildAuthUrl`) is
written to survive these caps and to *fail loudly* when a refresh token is missing rather than
persisting a dead connection:

```ts
// buildAuthUrl — the two params that fight the 7-day revoke + the no-refresh-token trap:
access_type: "offline",  // ← required to receive a refresh_token at all
prompt:      "consent",  // ← force the consent screen so a NEW refresh_token is (re)issued every time
```

- **`access_type=offline`** is the line that requests a refresh token. Without it you only ever get a
  ~1h access token and the connection dies in an hour — independent of any tier.
- **`prompt=consent`** re-forces the consent screen so Google re-issues a refresh token on *every*
  connect. Google normally returns `refresh_token` **only on the first ever consent** for a
  user↔app pair; after a Testing-mode 7-day revoke the user must re-consent, and without
  `prompt=consent` that re-consent would yield **no** refresh token. (`GoogleTokens.refresh_token` is
  typed optional precisely because of this — see the interface in `oauth.ts`.)
- **Identity without an extra scope tier:** Lumina requests `openid email` and reads the address from
  the `id_token` in `emailFromIdToken()` — base64url-decoding the JWT payload (no signature check; it
  came straight from Google's token endpoint over TLS in `exchangeCode`). This avoids needing a
  `gmail.readonly`/profile API call just to learn whose mailbox connected, keeping the identity step
  in the **free non-sensitive** tier.

The downstream contract: `/callback` should reject (not persist) a token response with no
`refresh_token`, because an offline connection with no refresh token is unusable — see Non-Negotiable
#6 in the skill's `SKILL.md`.

---

## 5. The verification process — what each tier actually demands

### SENSITIVE (e.g. `gmail.send`) — free, but real
You submit through the **Google Cloud Console → OAuth consent screen**. Google reviews:
1. **App identity & branding** — verified domain ownership, an accurate app name/logo, links to a
   **homepage** and a **privacy policy** hosted on your verified domain.
2. **Scope justification** — a written explanation of *why* you need each sensitive scope and a
   **demo video** showing the OAuth grant + the exact feature that consumes the scope.
3. **Domain match** — the privacy-policy URL, homepage, and `redirect_uri`
   (`GMAIL_OAUTH_REDIRECT_URI` here) must all be on the same verified domain.

No external auditor, no fee. Turnaround is typically days to a few weeks of back-and-forth.

### RESTRICTED (e.g. `gmail.readonly`) — everything above **plus CASA**
On top of the SENSITIVE review, restricted scopes require a **CASA (Cloud Application Security
Assessment)** performed by a **Google-authorized third-party assessor** (e.g. companies like
TAC Security, Bishop Fox, Leviathan). CASA verifies you meet Google's
**Minimum Viable Secure Product** bar for handling restricted user data. Concretely you must show:

- Encryption of restricted data **in transit and at rest** (the AES-256-GCM token vault directly
  serves this — see `token-vault-encryption.md`).
- An incident-response process, vulnerability management, and access controls.
- A passing assessment report submitted to Google.

CASA is **paid** (the assessment fee is yours, commonly **mid-three- to four-figure USD** depending
on tier/assessor) and **annual** — you re-assess every 12 months to keep the scope live. Tier 2 CASA
(required above a data-volume threshold) involves a deeper, costlier review than Tier 1.

> **This is the cost wall.** A solo/portfolio project can clear SENSITIVE verification for free with
> a privacy policy and a demo video. It generally **cannot** justify a recurring annual paid audit
> for a read scope — so the rational MVP is **send-only**.

---

## 6. Decision framework — pick the lowest tier that ships the feature

```
What does the connector need to DO?
|
+-- Only learn WHO connected (email/profile)? ........... NON-SENSITIVE (openid email)  → free, instant
|
+-- Only WRITE/act (send mail, create cal event, draft)?  SENSITIVE                      → free brand review
|     gmail.send / gmail.compose / calendar.events
|     → SHIP THIS for an MVP. No audit, no fee.
|
+-- Need to READ user data (inbox, files, full mailbox)?  RESTRICTED + CASA              → $$$ /yr audit
      gmail.readonly / gmail.modify / drive
      → Defer unless the read feature is the core value AND you can fund the annual audit.
      → First ask: can a SENSITIVE scope deliver 80% of it?
         (e.g. "draft a reply" = gmail.compose [sensitive] vs "summarize my inbox" = readonly [restricted])
```

**Rules of thumb that save money:**
1. **Request the narrowest scope that works.** `gmail.send` over `gmail.modify`; `calendar.events`
   over `calendar`; never `https://mail.google.com/` if a granular scope exists.
2. **Reading is the expensive verb.** Writing/sending is (almost always) SENSITIVE; reading user
   content is (almost always) RESTRICTED. Design features around acting, not reading, when possible.
3. **Split the app if needed.** Ship the send-only assistant now (SENSITIVE); gate the inbox-reading
   features behind a separate, later, audited release.
4. **Build with the read scope in dev, launch without it.** The scope list at *consent time* is what
   Google reviews — keep the launch `GMAIL_SCOPES` send-only.

---

## 7. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Requesting `gmail.readonly`/`modify` for an MVP that only needs to send. | Request `gmail.send` (SENSITIVE, free review). Reading drags in **annual paid CASA** — the deliberate boundary. |
| Shipping with `gmail.readonly` still in `GMAIL_SCOPES` "because it works in dev." | A working dev grant means nothing for launch — that scope promotes the *whole app* to RESTRICTED. Drop it from the launch scope list or budget the audit. |
| Filing "Gmail was connected then breaks after a week" as a refresh-token bug. | It's the **Testing-mode 7-day revoke** for sensitive scopes, not your code. Move to "In production" (unverified) or verify; keep `prompt=consent` so re-consent re-issues a refresh token. |
| Omitting `access_type=offline` and wondering why the connection dies in an hour. | `offline` is what requests a refresh token at all. Without it you only get a ~1h access token. |
| Dropping `prompt=consent` to "skip the extra screen." | Google returns `refresh_token` only on the **first** consent; after a revoke you'd get none. Force the screen so each connect (re)issues one. |
| Assuming "verified" is one-and-done. | RESTRICTED requires **re-passing CASA every 12 months**. Budget it as a recurring cost, not a launch task. |
| Calling a Gmail/Drive API just to learn the user's email address. | Read it from the `id_token` (`openid email`, non-sensitive) via `emailFromIdToken()` — no extra scope tier, no API round-trip. |
| Launching unverified and expecting real users to click through the scary screen. | The unverified interstitial + 100-user cap make it demo-only. Plan SENSITIVE verification before any real launch. |
| Hosting the privacy policy / homepage on a different domain than the redirect URI. | Google's brand review fails on domain mismatch. Put homepage, privacy policy, and `GMAIL_OAUTH_REDIRECT_URI` on one verified domain. |
| Treating the test-users list as "internal users only" (assuming no cap). | Testing = **max 100 test users** and they re-consent weekly. It is not a production substitute. |

---

## 8. Quick reference — caps & numbers

| Thing | Value | Where it bites |
|-------|-------|----------------|
| Testing-mode test users | **100 max** | Only listed emails can connect |
| Testing-mode refresh-token life (sensitive/restricted) | **7 days** | Weekly forced re-consent |
| Unverified-production user cap | **100 lifetime** | Hard ceiling until verified |
| SENSITIVE verification fee | **$0** | Time + privacy policy + demo video |
| RESTRICTED extra requirement | **CASA, paid, annual** | The cost wall |
| Refresh tokens per Google account per client | ~**100** (oldest auto-revoked) | Many re-consents without revoking pile up |
| Access-token life | ~**1 hour** (`expires_in` ≈ 3600s) | Refresh on miss; never store as permanent |

---

## 9. The one sentence you must be able to say

For any Google connector change, state — out loud, in one sentence — **which tier each requested scope
sits in and what that obliges**: e.g. *"We request `openid email` (non-sensitive) + `gmail.send`
(SENSITIVE → free brand review, no audit); we are NOT requesting any RESTRICTED read scope, so we owe
no annual CASA, and we ship under the unverified 100-user cap until the consent-screen review clears."*
If you can't say that sentence, you don't yet know what your connector costs to launch.
