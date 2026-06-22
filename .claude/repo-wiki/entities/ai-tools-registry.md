---
title: AI-SDK tool registry
kind: entity
cites:
  - backend/finance/tools.ts
  - backend/finance/skills.ts
  - backend/finance/hooks.ts
  - backend/connectors/gmail/tools.ts
  - backend/index.ts
fresh: 2026-06-22
---

# AI-SDK tool registry

Every tool the agent can call, by vertical. Default Discover search uses **no tools** (single-step
`streamText`); only the finance and assistant verticals run multi-step tool loops
(`stopWhen: stepCountIs(6)`).

## Finance tools — `buildFinanceTools()` (`backend/finance/tools.ts:54`)
A **fresh tool set per request**, returning `{ tools, sources }` where `sources` is a per-request
accumulator (`tools.ts:57`) that `financeWebSearch` pushes into so the `<SOURCES>` wire tail's `[n]`
numbers line up. Each tool except `loadSkill` is wrapped in `withGuard` (`backend/finance/hooks.ts:59`,
logs + staples the "Informational only — not financial advice" disclaimer).

| Tool | Def | Backs onto | Budget (per min) |
|---|---|---|---|
| `getQuote` | `tools.ts:59` | `fetchQuotes` (Twelve Data) via `cachedToolFetch` | 6 |
| `getCrypto` | `tools.ts:89` | `fetchCryptoMarkets` (CoinGecko) | 20 |
| `getIndices` | `tools.ts:115` | `fetchIndices` | 12 |
| `financeWebSearch` | `tools.ts:133` | Tavily news (not cached); appends to `sources` | 10 |
| `loadSkill` | `backend/finance/skills.ts:67` | loads a finance skill playbook on demand | — (local) |

Budget is enforced **only on a cache miss**, inside `cachedToolFetch` via `withinBudget` (`hooks.ts:26`);
exhaustion throws `RateBudgetError` (`hooks.ts:43`) → tool returns a typed `{ unavailable }`. Budgets are
**process-global** because the vendor API keys are shared across all users. Wired at `streamFinanceAnswer`
(`backend/index.ts:152`, `buildFinanceTools()` call at `:158`). See [finance-quote-flow](../flows/finance-quote-flow.md).

**Secrets:** finance tools take **no `userId`**; provider keys are read from `process.env` inside the
fetchers — never supplied by the model (the model only supplies validated zod args).

## Gmail / assistant tools — `buildGmailTools({ userId })` (`backend/connectors/gmail/tools.ts:35`)
A **per-request factory that closes over `userId`** — the confused-deputy / prompt-injection defense: the
model supplies a query/id but never the userId, so it cannot reach another user's mailbox
(`tools.ts:1-5`). Wired at `streamAssistantAnswer` (`backend/index.ts:208`, call at `:215`).

| Tool | Def | Access |
|---|---|---|
| `unreadCount` | `tools.ts:37` | `gmail.readonly` |
| `listEmails` | `tools.ts` (37-61) | `gmail.readonly` |
| `getEmail` | `tools.ts` (37-61) | `gmail.readonly` |

Each `execute` is wrapped in `guard()` (`tools.ts:17`) which turns `GmailNotConnectedError`/`GmailAuthError`
into a typed `{ error }` (telling the model to ask the user to reconnect) instead of throwing mid-stream.

⚠️ **The assistant agent is READ-ONLY.** There is **no `sendEmail` agent tool and no `needsApproval`** in
code (`tools.ts:7` comments "sendEmail (write, needsApproval) lands in M2b"). Sending exists only as the
manual `POST /connectors/gmail/send` route + the test box in the Connectors modal — not an agent flow.
`needsApproval`/scheduling live only in the `connectors-oauth` skill docs. See [connectors-gmail](../features/connectors-gmail.md).