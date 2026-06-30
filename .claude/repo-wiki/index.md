# Repo-wiki index

The content catalog. **Read this first to locate code, then open the 1–3 relevant pages and follow their
citations straight to the source — before grepping.** Conventions: [WIKI.md](WIKI.md).

> Status: seeded 2026-06-22 from a verified file:line mapping of the engine, finance, connectors, and
> wire/frontend. `:line` numbers are hints — re-confirm before editing. `rules/` pages mirror the seven
> CLAUDE.md non-negotiables.

## Features — "what is this vertical & how is it wired"
- [discover-search](features/discover-search.md) — the default web-grounded chat + Discover feeds (health geo-filter, 20 image-only cards, right-sized academic tiles).
  cites: backend/index.ts, prompt.ts, discover/routes.ts, discover/health.ts, discover/shared.ts, frontend/.../discover-parts.tsx | fresh: 2026-06-24
- [finance](features/finance.md) — cached `/finance/*` reads + the agentic finance chat + live prices + the LLM-surface freeze/conditional-warm cost controls.
  cites: backend/finance/*, backend/lib/cache.ts, worker/index.ts, components/finance/finance-view.tsx | fresh: 2026-06-24
- [connectors-gmail](features/connectors-gmail.md) — Gmail OAuth + token vault + read-only assistant tools.
  cites: backend/connectors/gmail/*, index.ts, pages/Connectors.tsx | fresh: 2026-06-22

## Flows — end-to-end traces (highest value)
- [ask-request-lifecycle](flows/ask-request-lifecycle.md) — POST /perplexity_ask: auth → cache → search → stream → persist.
  cites: backend/index.ts, auth.ts, prompt.ts, lib/wire.ts | fresh: 2026-06-22
- [connector-oauth-flow](flows/connector-oauth-flow.md) — Gmail PKCE OAuth + **the post-connect → Assistant-tab navigation fix**.
  cites: connectors/gmail/*, crypto.ts, pages/Dashboard.tsx | fresh: 2026-06-22
- [finance-quote-flow](flows/finance-quote-flow.md) — home card vs agent `getQuote`, cache + budget (+ LLM-freeze cost note).
  cites: finance/{routes,sources,tools}.ts, lib/cache.ts | fresh: 2026-06-24

## Entities — "where does X live" reference
- [routes](entities/routes.md) — the full HTTP route table → handler file:line (incl. Market Insights reads + `?force=1` cron).
  cites: index.ts, finance/routes.ts, discover/routes.ts, connectors/gmail/routes.ts | fresh: 2026-06-24
- [wire-protocol](entities/wire-protocol.md) — the streaming contract (raw text + tagged tail, NOT SSE frames).
  cites: lib/wire.ts, index.ts, frontend/lib/api.ts, chat-view.tsx | fresh: 2026-06-22
- [ai-tools-registry](entities/ai-tools-registry.md) — every AI-SDK tool (finance + gmail) → factory.
  cites: finance/tools.ts, finance/skills.ts, connectors/gmail/tools.ts | fresh: 2026-06-22
- [market-data-providers](entities/market-data-providers.md) — providers + the commercialOk gate.
  cites: finance/sources.ts, finance/news.ts | fresh: 2026-06-22
- [frontend-hooks](entities/frontend-hooks.md) — each hook → its backend endpoint.
  cites: frontend/src/hooks/* | fresh: 2026-06-22
- [graphify-code-graph](entities/graphify-code-graph.md) — the deterministic AST code-graph (MCP `graphify` + CLI) for "who calls what".
  cites: .mcp.json, .graphifyignore | fresh: 2026-06-23

## Rules — cross-cutting non-negotiables (mirror CLAUDE.md)
- [stream-then-persist](rules/stream-then-persist.md) — persist before res.end() (Vercel freeze). | fresh: 2026-06-22
- [secure-tool-args-by-closure](rules/secure-tool-args-by-closure.md) — userId/secrets via closure. | fresh: 2026-06-22
- [never-invent-finance-numbers](rules/never-invent-finance-numbers.md) — tools fetch, model grounds. | fresh: 2026-06-22
- [commercial-ok-gate](rules/commercial-ok-gate.md) — free tier ≠ display license. | fresh: 2026-06-22
- [esm-js-imports](rules/esm-js-imports.md) — `.js` extensions or Vercel build fails. | fresh: 2026-06-22
- [vercel-no-sockets-no-timers](rules/vercel-no-sockets-no-timers.md) — worker/ + external cron. | fresh: 2026-06-22
- [frontend-base-url](rules/frontend-base-url.md) — BUN_PUBLIC_* inlined at build; localhost fallback. | fresh: 2026-06-22

## Decisions (ADRs) — why, not just what
- [0001-answer-cache-not-rag](decisions/0001-answer-cache-not-rag.md) — cache whole answers, not chunks (yet).
- [0002-worker-on-fly-for-websockets](decisions/0002-worker-on-fly-for-websockets.md) — live prices off Vercel.
- [0003-news-headline-linkout-only](decisions/0003-news-headline-linkout-only.md) — drop publisher body text.
- [0004-us-india-no-new-providers](decisions/0004-us-india-no-new-providers.md) — switcher rides existing stack.
- [0005-discover-global-excludes-india-origin](decisions/0005-discover-global-excludes-india-origin.md) — global Health feed drops India-origin; 20 image-only cards + backfill.
- [0006-freeze-llm-surfaces-no-new-cache-table](decisions/0006-freeze-llm-surfaces-no-new-cache-table.md) — `FINANCE_LLM_FROZEN` + conditional warmer in the existing Redis cache; rejected a new pgvector/Postgres cache table.

## Glossary
- [glossary](glossary.md) — project vocabulary (wire tail, loadSkill, playbook, provenance, compaction…).

## Not yet covered (gaps for a future ingest)
Health & Academic feature pages (`backend/discover/{health,academic}.ts`); the conversations/compaction flow
in depth; the auth flow page; a `prisma-models` entity page; `worker/` internals beyond ADR 0002.
