---
title: Graphify code-graph (deterministic structural map)
kind: entity
cites:
  - .mcp.json
  - .graphifyignore
  - .claude/settings.local.json
fresh: 2026-06-23
---

# Graphify code-graph

A **deterministic, AST-built graph of the whole repo** that the agent can query to answer "who calls what /
what breaks if I change X / shortest path between two symbols." It is the *machine-precise* companion to this
hand-written repo-wiki: the **graph** answers structural questions exactly; the **wiki** answers *why/how*
(flows, decisions, intent). Use both.

> Not a skill, not shipped to the product — a local, regenerable analysis artifact + an MCP query surface.

## The graph (current build)
- **2924 nodes · 3708 edges · 222 communities · 320 source files (~353k words).**
- **100% EXTRACTED** — every edge is AST-confirmed; **0% INFERRED / 0% AMBIGUOUS, 0 token cost** (code-only;
  no LLM semantic pass, since no `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set — and we don't need one).
- Built from commit `88f6cb28`. Tool: `graphifyy` 0.8.44 (Python), tree-sitter AST + a call-graph pass.

## Where it lives — `graphify-out/` (gitignored, regenerable)
- `graph.json` — the queryable graph (NetworkX node-link; edges under the `links` key). The MCP server + CLI read this.
- `GRAPH_REPORT.md` — human report: corpus check, community hubs, "God nodes" (highest-degree symbols), freshness.
- `graph.html` — standalone interactive visualization (open in any browser, no server).

## Scope — `.graphifyignore`
`node_modules`, `.git`, `__pycache__` are excluded by Graphify's built-in defaults, and `.gitignore` is
honored. [`.graphifyignore`](../../../.graphifyignore) additionally excludes `**/prisma/generated/`
(machine-generated Prisma client), `**/*.d.ts`, and the throwaway `backend/_finnhub_probe.ts` — so the graph
is hand-written source only.

## How to query it
**Preferred — the MCP server** (registered as `graphify` in [`.mcp.json`](../../../.mcp.json), enabled in
`.claude/settings.local.json`). After the MCP client connects, the agent has these tools live:
`query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`.
⚠️ Requires a Claude Code restart (or `/mcp` reconnect) to connect, and the server reads
`graphify-out/graph.json` — so build the graph before relying on it.

**CLI fallback** (works any time, no server):
```
graphify explain  "SymbolName"          # a node + its neighbors (what it calls / who calls it)
graphify affected "SymbolName"          # reverse traversal — impact radius of a change
graphify query    "a question"          # BFS over the graph from matched start nodes
graphify path     "SymA" "SymB"         # shortest dependency path between two symbols
graphify update   .                     # rebuild after code changes (AST-only, no API cost)
```

## Freshness — auto-rebuild on commit
`graphify hook install` placed **post-commit** and **post-checkout** git hooks (`.git/hooks/`) that rebuild
the graph automatically (AST-only, no API cost). After a big refactor, or to refresh manually, run
`graphify update .`. To check staleness: compare `git rev-parse HEAD` against the "Built from commit" line in
`GRAPH_REPORT.md`.

## Validated on this repo
Backend **ESM `.js`→`.ts` cross-file resolution works** (the research report's biggest unknown): e.g.
`explain "streamFinanceAnswer"` → `backend/index.ts:152` with EXTRACTED call edges to `buildFinanceTools()`
(in `finance/tools.ts`) and `sourcesImagesTail()` (in `lib/wire.ts`); `affected "buildFinanceTools"` even
resolves the `api/index.ts` re-export. Frontend TSX resolves cleanly too.

## Limits / caveats
- **Structural, not semantic** — it knows call/import/contains edges, not "why." Pair with the wiki's
  `flows/` and `decisions/` for intent. It is complementary to (not a replacement for) the pgvector semantic
  answer cache.
- **Regenerable convenience, not a load-bearing dependency** — `graphifyy` is pre-1.0 / single-maintainer.
  `graphify-out/` is gitignored; if it's stale or missing, `graphify update .` rebuilds it from scratch.
- The doc/markdown semantic layer (`INFERRED`/`AMBIGUOUS` edges) is intentionally OFF (no LLM key) — turn it
  on later with `graphify extract . --backend gemini` if we want concept edges over the `.claude/` docs.
