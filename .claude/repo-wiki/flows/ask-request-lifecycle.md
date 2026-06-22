---
title: "/perplexity_ask request lifecycle"
kind: flow
owning_skill: research-agent
cites:
  - backend/index.ts
  - backend/auth.ts
  - backend/prompt.ts
  - backend/lib/wire.ts
  - backend/lib/query-policy.ts
  - backend/lib/models.ts
fresh: 2026-06-22
---

# `POST /perplexity_ask` — request lifecycle (default Discover/search vertical)

Numbered walk-through of the default search path. Handler: `app.post("/perplexity_ask", …)`
(`backend/index.ts:456`). The **finance** and **assistant** verticals branch off at step 5 into
multi-step tool loops; this trace is the no-tools Discover path.

1. **Auth** — `middleware` (`backend/auth.ts:35`): token-cache fast-path (`:41`); on miss
   `getClient().auth.getUser(token)` (`:47`) + idempotent `prisma.user.upsert` (`:55`). Sets `req.userId`.
2. **Input + access control** — read `query`/`conversationId` (`backend/index.ts:460`); 400 if missing
   (`:463`); per-user rate limit `rateLimited(req.userId)` (`createRateLimiter(20,60_000)` at `:76`, called
   `:468`) → 429.
3. **Conversation resolve** — continue (ownership-checked `findFirst`) or create with `slugify`
   (`backend/lib/slug.ts:3`) — `backend/index.ts:475-488`.
4. **Persist user turn (non-blocking)** — `persistUserTurn` promise created `:494`, awaited later.
5. **Vertical branch** — `finance` → `streamFinanceAnswer` (`:501`); `assistant` → `streamAssistantAnswer`
   (`:515`). Default continues. (These two **bypass the semantic cache and pre-search**.)
6. **Query classification** — `classifyQuery(query)` (`backend/prompt.ts:112`), called `:559`.
7. **Semantic cache check (pgvector)** — `resolveModel` (`backend/lib/models.ts:18`, default
   `anthropic/claude-sonnet-4.6`) `:532`; attachments via `buildAttachmentParts` (`backend/lib/wire.ts:40`);
   `cacheable = !isTimeSensitive(query) && parts.length===0` (`backend/lib/query-policy.ts:6`) `:534`. Then
   `embedQuery` (`:293`, `openai/text-embedding-3-small`) → `findCachedAnswer` (`:307`, cosine `<=>` raw SQL
   over `cached_query`, keyed on `(embedding, model)`, `DISTANCE_THRESHOLD=0.15`, `CACHE_TTL_DAYS=7`).
   Fail-open with a `42P01`-only cooldown latch (`noteCacheError` `:278`).
8. **Stream headers** — `writeStreamHeaders(res, conversation.id)` (`:122`, SSE + `X-Accel-Buffering:no` +
   `x-conversation-id`), `:538`.
9. **Cache HIT** — replay stored answer + `sourcesImagesTail` (`backend/lib/wire.ts:19`), `persistTurns`,
   `res.end()` (`:540-551`). Done.
10. **MISS → web search** — `webSearch(query)` (`:87`, Tavily `searchDepth:"basic"`, `maxResults:10`) `:554`.
11. **Prompt assembly** — `buildUserPrompt({query, searchContext: formatSearchContext(results), date})`
    (`backend/prompt.ts:130` + `formatSearchContext` `backend/lib/wire.ts:54`) `:561`; system =
    `buildSystemPrompt(queryType)` (`backend/prompt.ts:122` = `PERSONA` + matching `PLAYBOOK`).
12. **Agent loop** — `streamText({ model, system, messages, abortSignal: disconnectSignal(res), onError })`
    `:568`. Single-step (no tools). `disconnectSignal` (`:114`) aborts on client disconnect. Consumed via
    `for await (...result.textStream)` (`:578`), buffering `fullAnswer`; `finishReason` awaited `:584`.
13. **Wire tail** — `sourcesImagesTail(sources, images)` appended `:587` → emits `<SOURCES>`/`<IMAGES>`
    blocks. See [wire-protocol](../entities/wire-protocol.md).
14. **Persist BEFORE `res.end()`** — `persistTurns(...)` (`:138`) awaits the user turn, writes the assistant
    turn `:592`; then `cacheAnswer` only if `cacheable && finishReason==="stop" && fullAnswer.trim()`
    (`:595`, def `:338`); finally `res.end()` `:600`. Error handler `:601` (500 if headers not sent, else
    `res.end()`). **This ordering is a non-negotiable** — see
    [rules/stream-then-persist](../rules/stream-then-persist.md).

**Follow-up** (`/perplexity_ask/follow_up`, `:622`) differs only by building bounded history with
`buildConversationHistory` (`backend/lib/compaction.ts:20`); the older-turns summary goes into the **system**
prompt (`:713-716`), keeping `messages` a clean user/assistant alternation. No semantic cache on follow-ups.

Related: [discover-search](../features/discover-search.md) · [finance-quote-flow](finance-quote-flow.md) ·
[semantic cache (rag-retrieval skill)](../../skills/rag-retrieval/SKILL.md).
