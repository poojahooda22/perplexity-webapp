# Lumina Skills — Dispatch Guide

> **What this is.** A library of Claude Code *dev skills* for building **Lumina** (this repo —
> the Perplexity-style multi-vertical AI research app: Discover, Finance, Health, Academic,
> Connectors). Each skill makes *Claude the builder* an expert in one domain of THIS codebase.
> These are **not** shipped to or loaded by the product at runtime — they guide how the code
> gets written. (The product's own runtime "skills" are a separate system at
> [`backend/finance/skills/`](../../backend/finance/skills/) loaded by
> [`backend/finance/skills.ts`](../../backend/finance/skills.ts) — see the `ai-sdk-agent`
> skill for how that works.)
>
> **Architecture.** Cognitive Mesh, borrowed from the rareLab repo
> (`E:\Development\Portfolio-phase2\Akshay-pooja\rare-lab\.claude\skills`). Every skill is a
> **flat specialist**: one `SKILL.md` (identity + decision tree + non-negotiables + anti-patterns
> + output contract + references table) plus a `references/` library loaded on demand. No
> orchestrators — THIS file is the switchboard.

---

## Quick cheat-sheet — just say this

> **You don't have to memorize trigger words.** Claude reads every skill's `description` and
> matches the *meaning* of what you ask — say it in plain English and the right skill loads.
> To force one, type `/skill-name` (e.g. `/finance-markets`). There are **14 skills**, not 2.

| When you want to work on… | Just say something like… | Skill that loads |
|---|---|---|
| **Stock / crypto prices, the Finance page** | "fix the watchlist", "the stock price is wrong", "Finnhub quote", "add a sector", "NIFTY / S&P" | `finance-markets` |
| **Charts & indicators** | "the candlestick chart", "add an RSI / MACD", "a screener", "backtest" | `trading-systems` |
| **Coins, DeFi, prediction markets** | "CoinGecko data", "bitcoin market cap", "Polymarket odds", "on-chain" | `crypto-defi` |
| **Web search & citations (Discover)** | "the search answer", "citations / sources", "follow-up question", "Discover feed" | `research-agent` |
| **The chat engine itself** | "the streaming engine", "add a tool", "model routing", "compaction", "the stream protocol" | `ai-sdk-agent` |
| **Embeddings / the semantic cache** | "the answer cache", "pgvector", "embeddings", "make it real RAG", "rerank" | `rag-retrieval` |
| **Gmail / OAuth connectors** | "connect Gmail", "the token vault", "schedule an email", "the assistant tab" | `connectors-oauth` |
| **The Health tab** | "health news", "lab report upload", "medical disclaimer" | `health-discover` |
| **The Academic tab** | "papers / DOIs", "OpenAlex", "scholarly search" | `academic-discover` |
| **The look & feel of the app** | "the chat UI", "the composer / search box", "the theme", "sign-in", "a section tab" | `lumina-frontend` |
| **How to write React/TS *well*** | "should this hook use useMemo?", "fix this re-render", "this type is wrong", "Zustand vs Context" | `react-typescript` |
| **Tests for the screen / UI** | "write a frontend test", "test this component / hook", "test the API client" | `bun-testing` |
| **Tests for the server** | "write a backend test", "test this route", "mock Prisma / Supabase" | `backend-testing` |
| **Run a loop until a metric is hit** | "loop until latency < 300 ms", "iterate until tests pass", "optimize / reduce X", "run a /loop", "Ralph loop" | `improvement-loop` |

> Note: testing is split — **`bun-testing` = front-end (screen) tests**, **`backend-testing` =
> server tests**. There IS a backend testing skill. For exact technical keywords, see the
> [Keyword → skill quick map](#keyword--skill-quick-map) lower down.

---

## The stack these skills target

Bun + Express 5 + TypeScript (ESM, `.js` import extensions) · Vercel AI SDK v6 (`streamText`,
`generateObject`, `tool`, `embed`) routed through the **Vercel AI Gateway** · Prisma 7 +
Supabase Postgres (+ **pgvector**) · Upstash Redis (hot cache) · Tavily (web search) ·
Twelve Data / Yahoo / CoinGecko / Finnhub (market data) · React + Vite + TanStack Query +
Tailwind/shadcn frontend · a separate `worker/` (Fly.io) for WebSockets · Vercel serverless
deploy (no long-lived processes; external cron via cron-job.org).

**Brand rule:** the app is **Lumina** — never use "Perplexity" in user-visible text. (API route
names like `/perplexity_ask` are the one internal exception.)

---

## Reference naming convention

| Prefix | Meaning | Example |
|--------|---------|---------|
| `lumina-` | THIS codebase's implementation of a concept (cite `file:line`) | `lumina-finance-architecture.md` |
| no prefix | Generic domain knowledge, reusable across projects | `market-data-providers.md` |

---

## Skill dispatch table

| Skill | Domain | Status | Load when the task touches… |
|-------|--------|--------|------------------------------|
| [`finance-markets`](finance-markets/SKILL.md) | The Finance vertical end-to-end | ✅ built | market data, quotes, indices, crypto, the finance chat agent, watchlists, sectors, market summary/research, live prices, US/India markets, heatmaps, licensing of market data |
| `ai-sdk-agent` | The agent engine (Vercel AI SDK) | ✅ built | `streamText`/`generateText`/`generateObject`, tool loops, `stopWhen`, hooks (`withGuard`/`onStepFinish`), the runtime skills/`loadSkill` progressive-disclosure system, prompt assembly, model gateway routing, compaction, streaming/SSE wire format |
| `research-agent` | The Discover/search vertical | ✅ built | Tavily web search, source grounding + `[n]` citations, query classification/playbooks, follow-ups, the `<ANSWER>`/`<SOURCES>` protocol, attachments/multimodal, deep-research patterns |
| `rag-retrieval` | Embeddings + retrieval + caching | ✅ built | pgvector, the semantic-answer cache, embeddings, chunking, hybrid search, reranking, turning the cache into a real knowledge-RAG, freshness/TTL, cache invalidation |
| `trading-systems` | Trading/markets UX & analytics | ✅ built | charts, technical indicators, candlesticks, backtesting concepts, TradingView/Lightweight Charts, order/portfolio concepts (informational only), screeners |
| `crypto-defi` | Crypto & on-chain | ✅ built | CoinGecko semantics, coin ids, market cap/24h, stablecoins, prediction markets, on-chain/DeFi concepts, geo-block fallbacks |
| `connectors-oauth` | AI Connectors (Gmail etc.) | ✅ built | per-user OAuth, encrypted token vault, AI-SDK tools over a connected account, human-in-the-loop approval (`needsApproval`), scheduling via cron, Google scope/verification tiers, confused-deputy defense |
| `health-discover` | The Health vertical | ✅ built | health news feeds (NewsData/Tavily), health workflows, document upload, medical-info safety/disclaimers, licensing |
| `academic-discover` | The Academic vertical | ✅ built | OpenAlex, scholarly search, citations/DOIs, paper cards, academic ranking |
| `lumina-frontend` | The React/Vite chat UI | ✅ built | chat-view streaming render, parsing the wire tail, TanStack Query, shadcn/Tailwind, section tabs, the docked composer, theme |
| [`react-typescript`](react-typescript/SKILL.md) | Generic React 19 + TS + JS craft (sits *under* lumina-frontend) | ✅ built | writing components, hooks (useCallback/useMemo/refs), re-renders, performance, bundle size, client data fetching, advanced TS types, state management (Zustand vs Context vs TanStack), refactoring, testing |
| [`bun-testing`](bun-testing/SKILL.md) | Frontend testing on Bun | ✅ built | `bun:test` + happy-dom + Testing Library; component/hook/api-client/streaming-render tests; the `renderWithProviders` + fetch/Supabase mock harness |
| [`backend-testing`](backend-testing/SKILL.md) | Backend testing on Bun | ✅ built | `bun:test` tiered strategy; mocking Prisma/Supabase/fetch/AI-SDK; auth + conversations + finance/discover providers + streaming `/perplexity_ask` |
| [`improvement-loop`](improvement-loop/SKILL.md) | Verifiable agentic improvement loops (meta/process) | ✅ built | running a measure→diagnose→research→plan→execute→verify loop until a mechanical metric is hit; `/loop` vs `/schedule`; verifiable exit + max-iteration safety cap + independent verifier; the Ralph-Wiggum lineage; the finance cold-fetch latency case study (9.3 s → 3 ms) |

> **Status:** 14 skills built — `SKILL.md` + `references/` (116 reference docs). Four are generic
> craft/process layers — `react-typescript` (React/TS), `bun-testing` (frontend tests),
> `backend-testing` (backend tests), and `improvement-loop` (how to run a verifiable optimization loop,
> grounded in the finance latency case study); the other 10 are Lumina-specific.

---

## Keyword → skill quick map

- "quote / ticker / stock price / S&P / NIFTY / index / sector / watchlist / heatmap / market summary / Twelve Data / Yahoo / Finnhub / commercialOk / live price / NSE / BSE" → **finance-markets**
- "tool / streamText / generateObject / loadSkill / step loop / model gateway / disclaimer hook / compaction / system prompt assembly" → **ai-sdk-agent**
- "web search / Tavily / citation / sources / follow-up / answer protocol / query type / playbook / attachment" → **research-agent**
- "embedding / pgvector / semantic cache / RAG / retrieval / rerank / chunk / cosine distance" → **rag-retrieval**
- "candlestick / indicator / RSI / MACD / backtest / TradingView / Lightweight Charts / screener" → **trading-systems**
- "CoinGecko / bitcoin / ethereum / coin id / market cap / DeFi / on-chain / Polymarket / Manifold / prediction market" → **crypto-defi** (data plumbing also in **finance-markets**)
- "OAuth / Gmail / connector / token vault / needsApproval / scheduled email / Google scope / CASA audit" → **connectors-oauth**
- "health news / medical / NewsData / health workflow / upload report" → **health-discover**
- "OpenAlex / paper / DOI / scholarly / academic search" → **academic-discover**
- "chat-view / streaming UI / TanStack / shadcn / composer / section tab / theme" → **lumina-frontend**
- "react component / hook / useCallback / useMemo / re-render / performance / bundle size / code splitting / data fetching / typescript type / generic / discriminated union / zustand / state management / refactor / react 19 / testing" → **react-typescript**
- "frontend test / bun test / happy-dom / testing-library / renderWithProviders / component test / mock fetch" → **bun-testing**
- "backend test / bun test / mock prisma / mock supabase / test the route / test the middleware / integration test / test streaming / coverage" → **backend-testing**
- "loop until / iterate until / optimize X until / reduce latency / Ralph loop / /loop / /schedule / verifiable exit / measure-plan-execute-verify / agentic loop" → **improvement-loop**

---

## How to use a skill

1. Match the task to a skill via the table above.
2. Open that skill's `SKILL.md` — read its **Non-Negotiables**, **Anti-Patterns**, and **Decision
   Tree** first (they are short).
3. The decision tree routes you to the one or two `references/*.md` docs the task needs. Read
   those in full — **never load the whole `references/` folder at once.**
4. The codebase is the source of truth; `lumina-*` refs cite `file:line` so you can jump to the
   live code and confirm before changing it.

## Cross-repo prior art (read-only, do not edit)

- **fintech-webapp** `e:\Development\Portfolio-phase2\fintech-webapp\.claude` — a JPM-grade finance
  research KB (`research-data-sourcing` → `market-data-apis.md`, `licensing-tiers.md`,
  `macro-official-filings.md`). Excellent provider/licensing prior art for **finance-markets**.
  Translate its Next.js/Drizzle examples → our Express/Prisma stack.
- **rareLab** `E:\Development\Portfolio-phase2\Akshay-pooja\rare-lab\.claude\skills` — the
  architecture this library copies (`knowledge-base` = the RAG/grounding model; `tanstack-query`,
  `react-typescript`, `nextjs-backend` = UI/back-end patterns). WebGL/shader skills are irrelevant
  here.
