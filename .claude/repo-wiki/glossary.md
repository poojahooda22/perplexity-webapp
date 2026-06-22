---
title: Glossary
kind: glossary
fresh: 2026-06-22
---

# Glossary — Lumina project vocabulary

- **Wire tail** — the `<SOURCES>`/`<IMAGES>` JSON blocks appended after the streamed answer text. Built by
  `sourcesImagesTail()` (`backend/lib/wire.ts:19`); closing delimiter is the **same** token as the opening
  (`<SOURCES>`, not `</SOURCES>`). See [wire-protocol](entities/wire-protocol.md).
- **Answer protocol** — the in-band `<ANSWER>`/`<FOLLOW_UPS>`/`<question>` markers the **LLM** emits
  (instructed by the system prompt in `backend/prompt.ts`), parsed by the frontend `parseStream`.
- **Vertical** — which agent path a chat turn takes: `discover` (default, web-grounded, cached), `finance`
  (tool loop), `assistant` (Gmail tool loop). Chosen from `req.body.vertical` at `backend/index.ts:501/515`.
- **Playbook** — a query-type-specific system-prompt fragment in `backend/prompt.ts`, combined with the
  `PERSONA` by `buildSystemPrompt(queryType)`.
- **loadSkill** — a finance agent **tool** (`backend/finance/skills.ts:67`) that pulls a markdown playbook on
  demand (progressive disclosure). Distinct from the dev `.claude/skills/` — that's how *Claude* builds code.
- **Provenance / commercialOk** — the per-series licensing record (`backend/finance/sources.ts:15`); `false`
  = free tier, not cleared for commercial display. See [commercial-ok-gate](rules/commercial-ok-gate.md).
- **Semantic (answer) cache** — pgvector lookup that replays a near-duplicate past answer instead of
  generating. NOT knowledge RAG — see [ADR 0001](decisions/0001-answer-cache-not-rag.md).
- **Compaction** — bounding follow-up history: keep recent turns, summarize older ones into the system
  prompt (`backend/lib/compaction.ts:20`).
- **Wire tail strip** — `stripWireTail()` (`backend/lib/wire.ts:29`) removes UI blocks so prior turns
  re-fed to the LLM are clean prose.
- **The worker** — the always-on Fly.io process (`worker/index.ts`) holding the Finnhub WebSocket; lives off
  Vercel because Vercel can't hold sockets. See [ADR 0002](decisions/0002-worker-on-fly-for-websockets.md).
- **Repo-wiki vs skills vs memory** — wiki = *what exists & where* (this repo, churns with code); skills =
  *how to build* (reusable craft); memory = *cross-session preferences*. See [WIKI.md](WIKI.md) §1, §6.
