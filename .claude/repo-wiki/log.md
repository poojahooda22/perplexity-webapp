# Repo-wiki log

Append-only, newest at top. Prefix `## [YYYY-MM-DD] <op> | <title>` (so `grep "^## \[" log.md | head` works).

## [2026-06-24] ingest | Insights tests + Health/Academic Discover fixes
Tests added for the Finance→Insights ("Pulse") feature (backend 18 + frontend 8; no feature code changed)
and three Discover fixes shipped + verified live:
- Health GLOBAL feed now drops India-origin outlets (NewsData `country` → `health.ts → isIndiaOrigin`);
  India feed keeps `country=in`. Feed serves 20 image-only cards (`HEALTH_TARGET`, `finalizeArticles`
  `{max,requireImage}` in `shared.ts`); `fetchHealthDiscover` backfills NewsData→Tavily.
- Academic static tiles: `discover-parts.tsx → wiki()` now `?width=400` (was 1000, ~4× lighter) + `decoding="async"`.
- Live (Chrome MCP): global 20/0-India/all-imaged; India 20/11-India/all-imaged; academic tiles width=400.
- New ADR decisions/0005-discover-global-excludes-india-origin.md.
Touched: index.md, features/discover-search.md, decisions/0005-discover-global-excludes-india-origin.md, log.md.

## [2026-06-23] ingest | Implement Graphify code-graph (whole repo) + MCP + git hooks
Stood up the deterministic AST code-graph as the structural companion to the wiki.
- Built whole-repo graph: 2924 nodes / 3708 edges / 222 communities / 320 files, 100% EXTRACTED, 0 token cost
  (commit 88f6cb28). Artifacts in graphify-out/ (gitignored): graph.json, GRAPH_REPORT.md, graph.html.
- Added .graphifyignore (excludes prisma/generated, *.d.ts, _finnhub_probe.ts); node_modules auto-skipped.
- Registered MCP server `graphify` in .mcp.json + enabled in .claude/settings.local.json (needs restart to connect).
- Installed post-commit/post-checkout git hooks → graph auto-rebuilds (AST-only).
- New page: entities/graphify-code-graph.md.
- VALIDATED backend ESM .js→.ts cross-file edge resolution (the research report's open unknown): PASS.
- Per user steer: left the staged warmFinanceCache feature + earlier drift items untouched.

## [2026-06-22] ingest | Seed the repo-wiki (engine, finance, connectors, wire/frontend)
Initial seed, built from a verified file:line mapping of the live codebase (4 parallel mappers).
Created:
- WIKI.md (schema), index.md, log.md, glossary.md
- features/: discover-search, finance, connectors-gmail
- flows/: ask-request-lifecycle, connector-oauth-flow (incl. the post-connect → Assistant nav fix), finance-quote-flow
- entities/: routes, wire-protocol, ai-tools-registry, market-data-providers, frontend-hooks
- rules/: stream-then-persist, secure-tool-args-by-closure, never-invent-finance-numbers, commercial-ok-gate,
  esm-js-imports, vercel-no-sockets-no-timers, frontend-base-url
- decisions/: 0001-answer-cache-not-rag, 0002-worker-on-fly-for-websockets, 0003-news-headline-linkout-only,
  0004-us-india-no-new-providers
Drift recorded for a future fix (verified against code, not yet fixed in product):
- Connectors UI copy says "Send-only / never reads your inbox" but `GMAIL_SCOPES` requests `gmail.readonly`
  and the shipped agent tools are read-only inbox tools (Connectors.tsx:71,77 vs oauth.ts:23-28).
- `sendEmail` agent tool, `needsApproval`, and scheduling/`ScheduledEmail` are documented in the
  connectors-oauth skill but NOT implemented in code (tools.ts:7 "lands in M2b").
- Memory `dev-skills-library` says "10 skills, 82 refs"; disk is 13 skills / 111 refs — memory is stale.
