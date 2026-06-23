---
title: Discover / search vertical (the default chat)
kind: feature
owning_skill: research-agent
cites:
  - backend/index.ts
  - backend/prompt.ts
  - backend/discover/routes.ts
  - backend/discover/health.ts
  - backend/discover/shared.ts
  - frontend/src/components/chat-view.tsx
  - frontend/src/components/discover/topic-discover-view.tsx
  - frontend/src/components/discover/discover-parts.tsx
fresh: 2026-06-24
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
- **Health feed rules** (`backend/discover/health.ts`): the **global** feed drops India-published outlets
  (NewsData per-article `country` → `health.ts → isIndiaOrigin`); the **India** feed queries `country=in`
  and keeps them. Every card is image-complete and the feed serves up to `HEALTH_TARGET` = **20**
  (`health.ts:59`) via `finalizeArticles(articles, { max, requireImage })` (`backend/discover/shared.ts:94`).
  `fetchHealthDiscover` (`health.ts:166`) backfills NewsData→Tavily when NewsData returns a partial page.
  See [0005-discover-global-excludes-india-origin](../decisions/0005-discover-global-excludes-india-origin.md).
- **Answer protocol:** `<ANSWER>`, `<SOURCES>`, `<IMAGES>`, `<FOLLOW_UPS>` — see
  [wire-protocol](../entities/wire-protocol.md).

## Frontend
- **Renderer:** `ChatView` (`frontend/src/components/chat-view.tsx:77`) — parses the stream per-chunk,
  Answer/Links/Images tabs, `[n]` citation links.
- **Composer:** `search-hero.tsx` (Discover home), driven by `useChat` (`frontend/src/hooks/use-chat.ts:24`).
- **Discover home:** `topic-discover-view.tsx` (exports `AcademicView`) + `discover/health-view.tsx`; shared
  carousel parts in `discover-parts.tsx`. The Academic tab is **static category tiles** (no live fetch)
  whose images come from `discover-parts.tsx → wiki()` (`:32`) — a right-sized **`?width=400`** Wikimedia
  thumbnail (was 1000; ~4× fewer bytes), rendered `loading="lazy"` + `decoding="async"` (`:115`).
- **Section state** lives in `pages/Dashboard.tsx` (switches body between ChatView and the five section views).

## Verticals share this engine
Finance and Assistant branch off the same `/perplexity_ask` handler at step 5 of the lifecycle into
multi-step tool loops — see [finance](finance.md) and [connectors-gmail](connectors-gmail.md). The
**default** Discover path is the only one that uses the semantic cache + pre-search.

Skills: [research-agent](../../skills/research-agent/SKILL.md) (engine),
[academic-discover](../../skills/academic-discover/SKILL.md), [health-discover](../../skills/health-discover/SKILL.md).
