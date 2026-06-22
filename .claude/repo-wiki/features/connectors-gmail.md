---
title: Connectors — Gmail
kind: feature
owning_skill: connectors-oauth
cites:
  - backend/connectors/gmail/routes.ts
  - backend/connectors/gmail/oauth.ts
  - backend/connectors/gmail/tools.ts
  - backend/connectors/gmail/store.ts
  - backend/connectors/crypto.ts
  - backend/index.ts
  - frontend/src/pages/Connectors.tsx
  - frontend/src/components/assistant/assistant-view.tsx
fresh: 2026-06-22
---

# Connectors — Gmail

Per-user OAuth + an encrypted token vault + read-only AI tools, surfaced by the Connectors page and used by
the Assistant chat vertical.

## Backend modules — `backend/connectors/`
| File | Role |
|---|---|
| `gmail/routes.ts` | `gmailRouter` (start/callback/status/send/disconnect); **per-route auth** |
| `gmail/oauth.ts` | PKCE OAuth pure fns: `buildAuthUrl`(69), `exchangeCode`(105), `refreshAccess`(123), `revokeToken`(139), `openState`(95), `GMAIL_SCOPES`(23) |
| `gmail/client.ts` | `getGmailSession`(35) + `gmailFetch`(66): access-token cache, 401-retry |
| `gmail/store.ts` | `gmail_connection` row I/O: `saveConnection`(13)/`getConnectionStatus`(35)/`loadForSend`(46)/`deleteConnection`(58) |
| `gmail/read.ts` | `getUnreadCount`/`listMessages`/`getMessage` (`gmail.readonly`) |
| `gmail/send.ts` | `sendGmail`(53): RFC-2822 MIME build + `messages/send` |
| `gmail/tools.ts` | `buildGmailTools({userId})`(35): `unreadCount`/`listEmails`/`getEmail`, userId by closure |
| `crypto.ts` | AES-256-GCM `encryptToken`/`decryptToken` (vault) + `seal`/`unseal` (OAuth `state`) |

Routes + auth: [entities/routes.md](../entities/routes.md). Tools:
[entities/ai-tools-registry.md](../entities/ai-tools-registry.md). Full OAuth + nav trace:
[flows/connector-oauth-flow.md](../flows/connector-oauth-flow.md).

## Assistant chat wiring
`vertical:"assistant"` on `/perplexity_ask` → `streamAssistantAnswer` (`backend/index.ts:208`) → `streamText`
with the Gmail tools, `stopWhen: stepCountIs(6)`. System prompt `buildAssistantSystem` (`:193`) states the
agent can READ but **cannot SEND yet**. `userId` is injected by closure (confused-deputy defense) —
[rules/secure-tool-args-by-closure](../rules/secure-tool-args-by-closure.md).

## Frontend
- `pages/Connectors.tsx` — connect (`handleConnect:325`, `window.location.href = gmailStartUrl()`),
  disconnect, and a `GmailCompose` test-send box (`:441`).
- `hooks/use-connectors.ts` — `useGmailStatus`/`useGmailDisconnect`/`useGmailSend`/`useInvalidateGmailStatus`.
- `components/assistant/assistant-view.tsx` — Assistant home (connector chips + composer; `navigate("/connectors")`).
- **Post-connect navigation** to the Assistant tab is in `pages/Dashboard.tsx:78-88` — see the flow page.

## ⚠️ Status / drift (verified, worth fixing)
- **Read vs send mismatch in UI copy:** Connectors says "Send-only / never reads your inbox"
  (`Connectors.tsx:71,77`) but scopes include `gmail.readonly` and the agent tools are read-only inbox tools.
- **Not implemented:** no `sendEmail` **agent** tool, no `needsApproval`, no scheduling/`ScheduledEmail`
  model. Sending exists only as `POST /connectors/gmail/send` + the manual test box. The `connectors-oauth`
  skill documents these as future (M2b) — they are docs, not code.

Skill: [connectors-oauth](../../skills/connectors-oauth/SKILL.md).