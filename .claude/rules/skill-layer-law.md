# Rule: the skill / tool layer law

Three different systems are easy to confuse. A new capability must land in the **right** one, or it
silently fails (agent-reasoning content in a dev-skill is never loaded at runtime; fetch logic in a
runtime-skill never runs).

| Layer | Where | One-line test |
|---|---|---|
| **Dev-skill** | [`../skills/`](../skills/README.md) (`SKILL.md` + `references/`) | "Does this teach **Claude-the-builder** how to write/change code?" Not shipped at runtime. |
| **Runtime product-skill** | [`../../backend/finance/skills/`](../../backend/finance/skills/) (`*.md`, loaded via `loadSkill`) | "Does this teach the **shipped finance agent** how to answer a user?" Frontmatter name+desc go in the system prompt; the body loads on demand. |
| **Tool** | [`../../backend/finance/tools.ts`](../../backend/finance/tools.ts) (AI-SDK tool, `withGuard`+cache+budget) | "Does this **fetch** a number/series the model calls for?" |

## Where new things go

- New way to **build** a feature → new/extended **dev-skill** under `.claude/skills/`.
- New thing the **agent should explain/reason about** → a **runtime product-skill** under `backend/finance/skills/`.
- New **data the model must fetch** → a **tool** in `tools.ts` (+ a `routes.ts` route + a `sources.ts`/
  `sentiment-sources.ts` fetcher if it's a public cached read). Tag every payload with `Provenance{commercialOk}`.
- New **public-domain GREEN source** → mirror the `sentiment-sources.ts` fetcher pattern; add a row to
  the [sources-ledger](../memory/sources-ledger.md).

## Why it matters

`CLAUDE.md` states the dev-vs-runtime distinction in prose; this rule makes it a testable contract.
Misclassifying is the failure mode the law exists to prevent.