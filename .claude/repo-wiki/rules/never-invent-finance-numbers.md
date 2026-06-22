---
title: Never invent a finance number
kind: rule
owning_skill: finance-markets
cites:
  - backend/prompt.ts
  - backend/finance/tools.ts
  - backend/finance/sources.ts
fresh: 2026-06-22
---

# Never invent a finance number

**Rule (CLAUDE.md non-negotiable #1):** prices, levels, and stats come from a tool call, never the model's
memory. A failed tool returns a typed `unavailable`/`needsKey` — **never fabricated data**. Finance prose is
informational only ("Not financial advice").

**Why:** a hallucinated price looks identical to a real one and is the single most damaging failure mode for
a finance product.

**Where:**
- `FINANCE_PERSONA` instructs the model to ground every number in tool output (`backend/prompt.ts:160`).
- Tools return typed failures: over-budget or error → `{ unavailable }` (`backend/finance/tools.ts:75,104,122`);
  missing key → `{ items:[], needsKey:true }` (`backend/finance/sources.ts:429`).
- `withGuard` staples the disclaimer onto results (`backend/finance/hooks.ts:69`).

See [finance-quote-flow](../flows/finance-quote-flow.md).