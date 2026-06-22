---
title: "Stream → wire tail → persist BEFORE res.end()"
kind: rule
cites:
  - backend/index.ts
fresh: 2026-06-22
---

# Stream → wire tail → persist BEFORE `res.end()`

**Rule (CLAUDE.md non-negotiable #5):** finish streaming the answer, append the `<SOURCES>`/`<IMAGES>` wire
tail, **then write the turn to the DB, and only then call `res.end()`.**

**Why:** a Vercel serverless instance can freeze the moment the HTTP response closes. Any DB write kicked
off "after" `res.end()` may never run, silently dropping the assistant turn from history.

**Where:** `persistTurns(...)` (`backend/index.ts:138`) awaits the user turn then writes the assistant turn;
it is called **before** `res.end()` in every streaming path — discover `:592→:600`, finance, assistant,
follow-up, and cache-hit replay. `cacheAnswer` (only when `cacheable && finishReason==="stop"`) also runs
before `res.end()` (`:595`). See [ask-request-lifecycle](../flows/ask-request-lifecycle.md) step 14.