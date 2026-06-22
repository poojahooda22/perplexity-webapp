---
title: Secure tool args via closure (confused-deputy defense)
kind: rule
cites:
  - backend/connectors/gmail/tools.ts
  - backend/finance/tools.ts
fresh: 2026-06-22
---

# Secure tool args via closure

**Rule (CLAUDE.md non-negotiable #6):** `userId` and secrets are injected into a tool **by the factory
closure**, never supplied by the model. The model only ever provides schema-validated business args.

**Why:** if the model could pass `userId`, a prompt-injection ("read user 42's email") would become a
confused-deputy attack reaching another user's data. Closing over the authenticated `userId` makes that
impossible — the model literally has no channel to name another user.

**Where:**
- `buildGmailTools({ userId })` (`backend/connectors/gmail/tools.ts:35`) — a fresh per-request factory; the
  three tools close over `userId`; the model supplies only a Gmail query/id.
- Finance tools (`backend/finance/tools.ts:54`) take **no userId**; provider keys are read from
  `process.env` inside the fetchers — the model supplies only symbols/ids/query.

See [connector-oauth-flow](../flows/connector-oauth-flow.md) and [ai-tools-registry](../entities/ai-tools-registry.md).
