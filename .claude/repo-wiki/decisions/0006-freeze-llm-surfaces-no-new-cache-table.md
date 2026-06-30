---
title: "ADR 0006 — Freeze LLM surfaces via env flag + the existing cache (no new cache table)"
kind: decision
owning_skill: finance-markets
cites:
  - backend/lib/cache.ts
  - backend/finance/routes.ts
  - backend/index.ts
fresh: 2026-06-24
---

# ADR 0006 — Stop dev credit-burn by freezing the LLM surfaces in the existing Redis cache

**Problem.** The three Vercel-AI-Gateway-credit-bearing finance reads — Market Summary, global Research,
daily Briefing — were regenerated far more than visits warranted. The startup/cron warmer used
`forceRefresh` **unconditionally** (`backend/finance/routes.ts` `warmFinanceCache`), so **every dev-server
restart** (frequent, because new backend files force a full restart) re-ran all of them (~$0.17/restart,
Research alone = 6 Sonnet calls). Repeated localhost testing was the leak, not real traffic.

**Decision.** Solve it entirely in the existing cache layer — **no new persistence table**:
- **Conditional warmer.** New `warmIfStale` (`backend/lib/cache.ts:163`) refreshes a key only when missing
  or stale; `warmFinanceCache(force?)` (`routes.ts:181`) uses it, so a restart no longer regenerates
  still-fresh content. `POST /finance/cron/refresh?force=1` (`routes.ts:201`) is the manual full refresh.
- **Freeze switch.** `FINANCE_LLM_FROZEN=1` (dev only) → `getOrRefresh` serves the `{llm:true}`-flagged
  surfaces from cache and never regenerates (`cache.ts:118`); the warmer skips them entirely
  (`cache.ts:172`). First visit populates a surface once, then it's frozen. Staleness is still reported
  honestly (non-negotiable #5) — we just don't refresh. Boot log surfaces `[cache] backend=upstash|memory`
  (`backend/index.ts:756`) so the dev sees whether the cache persists across restarts.

**Alternative not taken — a new Postgres/pgvector `SurfaceCache` table.** The user's first instinct was to
persist generated payloads into the pgvector store. Rejected because (a) **pgvector is the wrong tool**: it
is the *semantic* cache for fuzzy chat-query→answer matching (`backend/index.ts` `cacheAnswer`/
`isTimeSensitive`); these surfaces have **fixed keys** (`finance:summary`…) needing an exact key→value
lookup, which the Redis cache already is; and (b) a new table adds a migration + model for a problem the
existing cache solves. The durable-persistence need (survive restarts) is met by configuring Upstash (two
env vars the code already supports), not by a table.

**Consequence.** With Upstash, a frozen surface generates **once ever** (until `?force=1`), then $0 across
restarts. On the in-memory fallback it rebuilds once per cold boot, then $0 for all browsing. The flag is
**dev-only** — it must never be set on Vercel (production must serve fresh content). Orthogonal to the
quote flow ([finance-quote-flow](../flows/finance-quote-flow.md)); see
[features/finance § cost control](../features/finance.md).
