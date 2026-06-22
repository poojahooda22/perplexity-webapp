---
title: Streaming wire protocol (the SSE contract)
kind: entity
cites:
  - backend/lib/wire.ts
  - backend/index.ts
  - backend/prompt.ts
  - frontend/src/lib/api.ts
  - frontend/src/components/chat-view.tsx
fresh: 2026-06-22
---

# Streaming wire protocol — the answer stream contract

The single most "magic" part of the app, and the easiest to break. **Read this before touching streaming,
the composer, or how answers render.**

## The big surprise: it is NOT an SSE event-envelope protocol
Despite the `text/event-stream` header, there are **no `event:`/`data: {...}` frames**. The backend writes
the **raw answer text directly to the response body**, then appends an in-band tail of tagged JSON blocks.
The frontend reads the raw byte stream and **regex-parses** it. Encoder: `backend/lib/wire.ts`.

## What goes on the wire, in order
1. **Answer text** — streamed first, raw UTF-8. The model wraps it in `<ANSWER>…</ANSWER>` (instructed by
   the system prompt, not by code). Written via `res.write(textPart)` — discover `backend/index.ts:580`,
   follow-up `:729`, finance `:176`, assistant `:232`, cached replay `:546`.
2. **The tail** — one concatenated string appended after the answer, built by
   `sourcesImagesTail(sources, images)` (`backend/lib/wire.ts:19`):
   - `\n<SOURCES>\n<JSON array of {title?,url,content?}>\n<SOURCES>\n`
   - `\n<IMAGES>\n<JSON array of {url,description?}>\n<IMAGES>\n`

⚠️ **The closing delimiter is the SAME token as the opening one** — `<SOURCES>` … `<SOURCES>`, not
`</SOURCES>`. Same for `<IMAGES>`. The frontend regexes depend on this exact shape.

## In-band markers emitted by the LLM (not by code)
- `<ANSWER>…</ANSWER>` — answer prose. Instructed at `backend/prompt.ts:45,57,73` (discover) and `:186` (finance).
- `<FOLLOW_UPS>…</FOLLOW_UPS>` with five `<question>…</question>` — instructed at `backend/prompt.ts:48-54,75-81,189-195`.
  Follow-ups ride **inside the answer text**; there is no separate follow-ups wire event.
- Inline `[n]` citations — line up with the `<SOURCES>` array because the search context is numbered by
  `formatSearchContext()` (`backend/lib/wire.ts:54`).

## Headers, errors, done
- `x-conversation-id` response header set by `writeStreamHeaders()` (`backend/index.ts:122`) before the body.
- **Errors are not in-band.** Pre-stream → `res.status(4xx/5xx).json({error})`; mid-stream (headers already
  flushed) → just `res.end()` with no marker (`backend/index.ts:601-609`, `:737-743`).
- **"Done" is signalled only by the HTTP stream closing** (`res.end()`). No `done` event.

## Stripping (backend)
`stripWireTail()` (`backend/lib/wire.ts:29`) removes the `<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>` blocks and
unwraps `<ANSWER>` — used by [compaction](../flows/ask-request-lifecycle.md) so prior-turn UI blobs aren't
re-fed to the LLM. `persistTurns` (`backend/index.ts:138`) stores answer **+ tail verbatim**, so reloading a
conversation re-feeds the same wire string to the same parser.

## Frontend consume → parse → render
- **Reader:** `streamPost()` (`frontend/src/lib/api.ts:106`) reads `x-conversation-id` (`:124`), loops
  `getReader()` + `TextDecoder`, **accumulates the full string**, calls `onChunk(full)` each chunk. Wrappers
  `streamAsk` (`:140`) / `streamFollowUp` (`:158`). Driven by `useChat` `runTurn` (`frontend/src/hooks/use-chat.ts:51`).
- **Parser:** `parseStream(full)` (`frontend/src/lib/api.ts:189`) — **idempotent, safe per-chunk** (partial
  JSON → `[]`). Returns `ParsedAnswer { answer, followUps, sources, images }` (`:28`).
- **Renderer:** `ChatView` (`frontend/src/components/chat-view.tsx:77`) calls `parseStream` per chunk (`:99`),
  dedupes by URL, renders Answer/Links/Images tabs; `linkifyCitations` (`:50`) turns `[n]` into links.

⚠️ **Auth header gotcha:** the frontend sends the Supabase `access_token` as the **raw `Authorization`
value with no `Bearer ` prefix** (`frontend/src/lib/api.ts:35-38,114`); `backend/auth.ts` reads it raw.
