# CLAUDE.md — Lumina

> **Lumina** is a Perplexity-style, multi-vertical AI research app: **Discover/search, Finance,
> Health, Academic, and Connectors**. This file is the switchboard — it routes every task to the
> right dev-skill and states the cross-cutting rules. It is loaded on every prompt; the skills it
> points to are loaded on demand.

## Brand rule (always)
The product is **Lumina**. **Never** write "Perplexity" in user-visible text or new prose. The only
exception is pre-existing internal API route names like `/perplexity_ask`.

## The stack
Bun + Express 5 + TypeScript (ESM) · Vercel AI SDK v6 (`streamText`/`generateText`/`generateObject`/
`embed`/`tool`) routed through the **Vercel AI Gateway** · Prisma 7 + Supabase Postgres (+ **pgvector**)
· Upstash Redis (hot cache) · Tavily (web search) · Twelve Data / Yahoo / CoinGecko / Finnhub (market
data) · React + Vite + TanStack Query + Tailwind/shadcn frontend · a separate `worker/` (Fly.io) for
WebSockets · Vercel serverless deploy (external cron via cron-job.org).

## Dev skills — route here first
The library lives in [`.claude/skills/`](.claude/skills/README.md) — **read that README; it is the full
dispatch guide.** Each skill is a flat specialist (`SKILL.md` + `references/`) that makes Claude an
expert at building one part of Lumina. These are **dev** skills (they guide how code gets written);
they are NOT shipped to or loaded by the product at runtime.

| If the task touches… | Open this skill |
|---|---|
| stock/index/crypto quotes, watchlist, sectors, market summary/research, `/finance/*`, the finance chat agent, live prices, market-data licensing | [`finance-markets`](.claude/skills/finance-markets/SKILL.md) |
| the agent engine — `streamText`/tools/loops, prompt assembly, the runtime `loadSkill` system, model gateway, compaction, the SSE wire protocol, hooks | [`ai-sdk-agent`](.claude/skills/ai-sdk-agent/SKILL.md) |
| web search, citations, query classification, the `<ANSWER>`/`<SOURCES>` protocol, Discover feeds, follow-ups, deep research | [`research-agent`](.claude/skills/research-agent/SKILL.md) |
| embeddings, pgvector, the semantic cache, retrieval, chunking, reranking, evolving the cache into a knowledge-RAG | [`rag-retrieval`](.claude/skills/rag-retrieval/SKILL.md) |
| charts, indicators, candlesticks, backtesting, screeners, trading UX (informational only) | [`trading-systems`](.claude/skills/trading-systems/SKILL.md) |
| CoinGecko depth, crypto/token fundamentals, on-chain/DeFi, prediction markets | [`crypto-defi`](.claude/skills/crypto-defi/SKILL.md) |
| OAuth connectors (Gmail), token vault, connector tools, human-in-the-loop approval, scheduling, Google scopes | [`connectors-oauth`](.claude/skills/connectors-oauth/SKILL.md) |
| the Health vertical — health feeds, workflows, upload, medical-info safety | [`health-discover`](.claude/skills/health-discover/SKILL.md) |
| the Academic vertical — OpenAlex, citations/DOIs, paper cards | [`academic-discover`](.claude/skills/academic-discover/SKILL.md) |
| the React/Vite chat UI — streaming render, TanStack, shadcn, composer, auth | [`lumina-frontend`](.claude/skills/lumina-frontend/SKILL.md) |
| writing/optimizing React + TS *itself* — components, hooks (useCallback/useMemo/refs), re-renders, performance, bundle size, client data fetching, advanced types, state management (Zustand), refactoring, testing | [`react-typescript`](.claude/skills/react-typescript/SKILL.md) |
| writing/running/debugging **frontend** tests — `bun:test` + happy-dom + Testing Library, component/hook/api/streaming-render tests | [`bun-testing`](.claude/skills/bun-testing/SKILL.md) |
| writing/running/debugging **backend** tests — `bun:test`, mocking Prisma/Supabase/fetch/AI-SDK, auth + providers + route/streaming integration | [`backend-testing`](.claude/skills/backend-testing/SKILL.md) |
| running an iterate-until-a-metric loop — optimize/reduce latency/bundle/bugs, "loop until X", `/loop` vs `/schedule`, verifiable exit + safety cap + independent verifier (the Ralph-Wiggum lineage) | [`improvement-loop`](.claude/skills/improvement-loop/SKILL.md) |

When a task matches a skill, open its `SKILL.md` and read its **Non-Negotiables**, **Anti-Patterns**,
and **Decision Tree** before writing code. The decision tree routes you to the one or two
`references/*.md` the task needs — never load a whole `references/` folder at once.

## Repo map — consult BEFORE locating code
Before grepping to find where something lives, read
[`.claude/repo-wiki/index.md`](.claude/repo-wiki/index.md) — the living, file-cited map of *this* codebase
(the route table, the streaming wire protocol, feature/flow traces, the cross-cutting rules). It exists so
structure isn't re-derived every session; treat `:line` numbers as hints to re-confirm. The wiki is the
*noun* (what exists & where); the skills above are the *verb* (how to build). **After building or changing a
feature, run `/wiki-ingest`** to keep the map current; `/wiki-lint` checks it for drift. Conventions:
[`.claude/repo-wiki/WIKI.md`](.claude/repo-wiki/WIKI.md).

## Cross-cutting non-negotiables
1. **Never invent a finance number** (price/level/stat). Tools fetch; the model grounds. Failed tools
   return typed `unavailable`/`needsKey`, never fabricated data. Finance prose is informational only —
   "Not financial advice."
2. **`commercialOk` gate.** A free API tier is not a commercial-display license. Every displayed data
   series carries `Provenance` with a correct `commercialOk` (default `false`).
3. **ESM `.js` imports.** Relative imports in the backend need explicit `.js` extensions or Vercel's
   strict ESM resolver fails the build (Bun is lenient locally — it only breaks in prod).
4. **Vercel can't hold sockets or timers.** WebSockets/pollers go in `worker/` (Fly.io); scheduled
   work is an external cron hitting a `CRON_SECRET`-guarded route.
5. **Stream → wire tail → persist BEFORE `res.end()`** (a Vercel instance can freeze on response close).
6. **Secure tool args via closure.** `userId`/secrets are injected in the tool factory — the model
   never supplies them (confused-deputy / prompt-injection defense).
7. **New backend files need a full dev-server restart** — Bun `--hot` doesn't pick them up.

## Memory & prior art
- Project memory (point-in-time; verify against live code): `finance-tab-build`, `connectors-gmail-kb`,
  `discover-tabs-build`, `heatmap-implementation-kb`, `india-markets-kb`, `discover-news-licensing`,
  `brand-is-lumina`, `product-not-portfolio`.
- Read-only prior-art repos: **fintech-webapp** (`e:\Development\Portfolio-phase2\fintech-webapp\.claude`
  — finance research/licensing KB) and **rareLab**
  (`E:\Development\Portfolio-phase2\Akshay-pooja\rare-lab\.claude\skills` — the Cognitive-Mesh skill
  architecture this library copies).
