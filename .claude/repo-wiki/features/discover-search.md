---
title: Discover / search vertical (the default chat)
kind: feature
owning_skill: research-agent
cites:
  - backend/index.ts
  - backend/prompt.ts
  - backend/discover/routes.ts
  - frontend/src/components/chat-view.tsx
  - frontend/src/components/discover/topic-discover-view.tsx
fresh: 2026-06-22
---

# Discover / search vertical

The default chat: a Perplexity-style web-grounded answer with citations and follow-ups. Also owns the
Discover feed carousels (academic + health) shared with those verticals.

## Backend
- **Engine:** the default branch of `POST /perplexity_ask` (`backend/index.ts:456`). Full path:
  [ask-request-lifecycle](../flows/ask-request-lifecycle.md). Single-step `streamText` (no tools), grounded
  in Tavily web search, with a pgvector semantic-answer cache in front.
- **Prompt:** `buildSystemPrompt(queryType)` = `PERSONA` + a matching `PLAYBOOK`, plus
  `classifyQuery`/`buildUserPrompt` — all in `backend/prompt.ts` (`classifyQuery:112`, `buildSystemPrompt:122`,
  `buildUserPrompt:130`).
- **Discover feed routes:** `GET /discover/academic` (OpenAlex) + `GET /discover/health` (NewsData→Tavily),
  router `backend/discover/routes.ts:14`; fetchers `backend/discover/academic.ts`, `health.ts`, shapes in
  `shared.ts`. Cron warmer `POST /discover/cron/refresh` (`routes.ts:44`).
- **Answer protocol:** `<ANSWER>`, `<SOURCES>`, `<IMAGES>`, `<FOLLOW_UPS>` — see
  [wire-protocol](../entities/wire-protocol.md).

## Frontend
- **Renderer:** `ChatView` (`frontend/src/components/chat-view.tsx:77`) — parses the stream per-chunk,
  Answer/Links/Images tabs, `[n]` citation links.
- **Composer:** `search-hero.tsx` (Discover home), driven by `useChat` (`frontend/src/hooks/use-chat.ts:24`).
- **Discover home:** `topic-discover-view.tsx` (exports `AcademicView`) + `discover/health-view.tsx`; shared
  carousel parts in `discover-parts.tsx` (incl. the `wiki()` Wikimedia-thumbnail helper at `:30`).
- **Section state** lives in `pages/Dashboard.tsx` (switches body between ChatView and the five section views).

## Verticals share this engine
Finance and Assistant branch off the same `/perplexity_ask` handler at step 5 of the lifecycle into
multi-step tool loops — see [finance](finance.md) and [connectors-gmail](connectors-gmail.md). The
**default** Discover path is the only one that uses the semantic cache + pre-search.

Skills: [research-agent](../../skills/research-agent/SKILL.md) (engine),
[academic-discover](../../skills/academic-discover/SKILL.md), [health-discover](../../skills/health-discover/SKILL.md).
