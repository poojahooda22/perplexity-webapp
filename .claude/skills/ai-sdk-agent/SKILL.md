---
name: ai-sdk-agent
description: >
  Build and reason about Lumina's agent engine on the Vercel AI SDK: streamText/generateText/
  generateObject/embed, tool definitions + multi-step loops (stopWhen/onStepFinish), the layered
  prompt-assembly (persona+playbook+context), the runtime loadSkill progressive-disclosure system,
  model routing via the AI Gateway, conversation compaction, the SSE streaming wire format,
  hooks/guardrails, and multimodal attachments. Use whenever the task touches the chat engine in
  index.ts/prompt.ts, defining or debugging a tool/tool loop, model selection, compaction of long
  threads, the <ANSWER>/<SOURCES>/<FOLLOW_UPS> streaming protocol, or attachments — for ANY vertical
  (default search, finance, assistant).
metadata:
  priority: 58
  sessionStart: false
  pathPatterns:
    - 'backend/index.ts'
    - 'backend/prompt.ts'
    - 'backend/finance/tools.ts'
    - 'backend/finance/skills.ts'
    - 'backend/finance/hooks.ts'
    - 'backend/finance/skills/**'
    - 'backend/connectors/gmail/tools.ts'
  bashPatterns:
    - 'streamText'
    - 'generateObject'
    - 'AI_GATEWAY'
    - 'stopWhen'
  promptSignals:
    phrases:
      - 'ai sdk'
      - 'streamText'
      - 'generateObject'
      - 'tool call'
      - 'tool loop'
      - 'stopWhen'
      - 'system prompt'
      - 'model gateway'
      - 'loadSkill'
      - 'compaction'
      - 'streaming'
      - 'onStepFinish'
    minScore: 3
---

# ai-sdk-agent — Lumina's Agent Engine

> The generic engine EVERY vertical runs on. Build agent behavior the way the live code does:
> a layered prompt (persona + playbook + context), tools that **fetch facts the model then
> grounds in** (never invent), a bounded multi-step loop on `streamText`, a `<provider>/model`
> id resolved through the AI Gateway, compaction to keep long threads cheap, and a precise SSE
> wire tail persisted **before** `res.end()`. This skill is the map from any engine task to the
> exact reference + the exact file in [`backend/`](../../../backend/).

---

## Domain Identity

**This skill OWNS:**
- The chat orchestration in [`backend/index.ts`](../../../backend/index.ts): the three verticals
  (default search, `vertical:"finance"`, `vertical:"assistant"`), each assembling
  system + messages + tools and running `streamText`; `streamText` vs `generateText`
  (compaction) vs `generateObject` (narratives) vs `embed` (cache key).
- The prompt-assembly layer in [`backend/prompt.ts`](../../../backend/prompt.ts):
  `PERSONA`/`PLAYBOOKS`/`classifyQuery`/`buildSystemPrompt`/`buildUserPrompt` and
  `FINANCE_PERSONA`.
- The generic **tool + hook patterns**: the `tool()` + Zod contract, closure-injected secure
  args, `withGuard`/`onStepFinish` ([`backend/finance/tools.ts`](../../../backend/finance/tools.ts),
  [`backend/finance/hooks.ts`](../../../backend/finance/hooks.ts),
  [`backend/connectors/gmail/tools.ts`](../../../backend/connectors/gmail/tools.ts) as live examples).
- The runtime `loadSkill` progressive-disclosure system
  ([`backend/finance/skills.ts`](../../../backend/finance/skills.ts) +
  [`backend/finance/skills/*.md`](../../../backend/finance/skills/)).
- Model routing via the Vercel AI Gateway: `ALLOWED_MODELS`/`resolveModel`/`DEFAULT_MODEL` in
  [`backend/index.ts`](../../../backend/index.ts).
- Conversation compaction (`buildConversationHistory`/`stripWireTail`) and the streaming wire
  protocol (`writeStreamHeaders`/`sourcesImagesTail`/`persistTurns`/`disconnectSignal`) — all in
  [`backend/index.ts`](../../../backend/index.ts).
- Multimodal attachments (`buildAttachmentParts`).

**This skill does NOT own (route elsewhere):**
- Finance-specific tools/data/providers/licensing → **finance-markets** (this skill owns the
  *engine* those tools plug into; that skill owns the finance tool belt + data plumbing).
- Web-search + the `[n]` citation specifics of the default Discover path → **research-agent**.
- pgvector / embeddings retrieval internals (the semantic-cache table, distance tuning) →
  **rag-retrieval** (this skill owns where `embed` is *called*).
- Connector tools / Gmail OAuth + token vault → **connectors-oauth** (this skill cites
  `gmail/tools.ts` only as a closure-injection example).
- UI rendering of the streamed wire format → **lumina-frontend**.
- Claude-specific model details (ids, pricing, caching) → the **claude-api** skill.

---

## Decision Tree

```
Engine task arrives
|
+-- "How is the whole engine wired? which vertical, streamText/generateText/embed?" -> lumina-agent-engine.md
+-- "Define/change a tool; loop runs wrong; stopWhen; typed result; secure args" --> tool-calling-and-loops.md
+-- "Add/change a playbook; classifier; persona; how the system prompt is built" --> prompt-assembly-and-playbooks.md
+-- "The product's OWN runtime skills — loadSkill, the manifest, add a playbook" --> runtime-skills-progressive-disclosure.md
+-- "Which model? add to the gateway allowlist; cheap vs premium; embeddings" ----> model-gateway-and-selection.md
+-- "Budget veto / disclaimer / rate limit / abort-on-disconnect / step logging" -> hooks-and-guardrails.md
+-- "Follow-ups expensive on long threads; summarize old turns; role rules" ------> conversation-compaction.md
+-- "Stream headers; the <ANSWER>/<SOURCES>/<IMAGES>/<FOLLOW_UPS> wire format" ----> streaming-and-wire-protocol.md
+-- "User attached an image/PDF; vision/doc parts; the 25mb limit; cache bypass" -> multimodal-attachments.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **The model never invents facts — tools fetch, the model grounds.** Tools return typed states (`items`/`coins`/`unavailable`/`error`/`needsKey`), never throw data and never hand back a string posing as data. | `cachedToolFetch` catches `RateBudgetError` → `{unavailable}` in [`tools.ts`](../../../backend/finance/tools.ts); personas in [`prompt.ts`](../../../backend/prompt.ts) forbid guessing. |
| 2 | **Stream tokens, THEN write the wire tail, THEN persist BEFORE `res.end()`.** On Vercel the instance can freeze the instant the response closes, so any post-`end()` DB write (history + cache) may never run. | `persistTurns(...)` is `await`ed before `res.end()` in every branch of `/perplexity_ask`; `sourcesImagesTail` is written first. |
| 3 | **Bound every tool loop** with `stopWhen: stepCountIs(N)` (N=6 today) and **abort on client disconnect** (`abortSignal: disconnectSignal(res)`) so a vanished client stops burning tokens/credits. | `streamFinanceAnswer`/`streamAssistantAnswer` + the disconnect-AC in [`index.ts`](../../../backend/index.ts). |
| 4 | **Secrets/`userId` are injected via closure in the tool factory — the model NEVER supplies them.** The Zod `inputSchema` exposes only the *content* args. | `buildGmailTools({userId})` closes over `userId` (confused-deputy defense); the model passes the query/id only. |
| 5 | **Models are bare gateway ids `"provider/model"` validated by `resolveModel` against `ALLOWED_MODELS`; an unknown/absent id falls back to `DEFAULT_MODEL`.** One `AI_GATEWAY_API_KEY` → every provider. | `resolveModel`/`ALLOWED_MODELS`/`DEFAULT_MODEL` (`anthropic/claude-sonnet-4.6`) in [`index.ts`](../../../backend/index.ts). |
| 6 | **Relative imports need explicit `.js` extensions** or Vercel's strict Node ESM resolver fails the build (Bun is lenient locally — it only breaks on deploy). New backend files also need a **full dev-server restart** (`bun --hot` misses them). | `import { ... } from './prompt.js'` etc. throughout `index.ts`. |
| 7 | **Compaction keeps a clean user/assistant alternation and an Anthropic-legal first turn.** Summarize old turns into the SYSTEM prompt, keep the last N verbatim, and drop any leading `assistant` so the first message is `user`. | `buildConversationHistory` + `KEEP_RECENT_MESSAGES=6` in [`index.ts`](../../../backend/index.ts). |
| 8 | **Strip the UI wire tail from history before re-sending it as LLM context.** `<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>`/`<ANSWER>` markup is for the frontend, not model context. | `stripWireTail` in [`index.ts`](../../../backend/index.ts). |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Letting the model answer from memory / having a tool `throw` on failure. | Tool-first persona + tools that return typed `{unavailable}`/`{error}`/`{needsKey}` the model can relay. |
| Putting `userId`/API keys in a tool's `inputSchema` so the model fills them. | Close over them in the factory (`buildGmailTools({userId})`); schema carries only content args. |
| Persisting the turn (or caching) AFTER `res.end()`. | `await persistTurns(...)` BEFORE `res.end()` — Vercel freezes on close. |
| Running the tool loop unbounded, or ignoring client disconnect. | `stopWhen: stepCountIs(6)` + `abortSignal: disconnectSignal(res)`. |
| Hardcoding a model literal or trusting `req.body.model` raw. | `resolveModel(req.body.model)` → allowlist or `DEFAULT_MODEL`; add new ids to `ALLOWED_MODELS`. |
| Using the default `streamText` (with no per-tool veto) for a quota'd vendor. | Enforce the budget INSIDE the cache fetcher (`withinBudget`) so a cache HIT isn't charged; veto returns a typed result, not a throw. |
| Re-sending the whole raw transcript every follow-up (with `<SOURCES>` blobs intact). | `buildConversationHistory`: strip the tail, keep last 6 verbatim, summarize older into the system prompt with the cheap model. |
| Threading the request's `AbortSignal` into a *shared/de-duped* cache fetcher. | Cancel at the `streamText` level only; one caller's disconnect must not abort the shared in-flight fetch. |
| Omitting the `.js` extension on a relative import / forgetting to restart after a new file. | Always write `./foo.js`; full restart on new files (`--hot` misses them). |
| Hand-writing the SSE headers per branch / emitting a different wire shape per vertical. | One `writeStreamHeaders` + one `sourcesImagesTail` so the frontend parses every vertical identically. |
| Sending attachments to a non-vision model, or letting an upload hit the semantic cache. | `buildAttachmentParts` → image/file parts to a vision/doc model; attachments set `cacheable=false`. |

---

## Output Contract (what "done" looks like)

An engine change is done when:
1. **Prompt path:** new behavior lives in the right layer — `PERSONA` (stable identity) vs a
   `PLAYBOOK` (per query-type) vs the `CONTEXT` block — assembled by `buildSystemPrompt`/
   `buildUserPrompt`, not bolted onto one string.
2. **Tool path:** any new tool uses `tool()` + a bounded Zod `inputSchema`, a description that
   states what it covers AND what it does NOT, returns typed results (never throws data),
   injects secrets via closure, and (if it spends a quota) is budgeted + `withGuard`-wrapped.
3. **Loop:** `stopWhen: stepCountIs(N)` is set, `onStepFinish` logs the tools each step used, and
   the loop aborts on client disconnect.
4. **Model:** the id is resolved through `resolveModel`; any new id is added to `ALLOWED_MODELS`
   and the frontend picker; the task uses an appropriately-priced model (cheap Haiku for
   compaction/summary, Sonnet default, premium only for hard tasks).
5. **Streaming + persistence:** `writeStreamHeaders` then tokens then the `<SOURCES>`/`<IMAGES>`
   tail then `persistTurns` BEFORE `res.end()`; only a `finishReason === "stop"` non-empty answer
   is cached.
6. **History:** follow-ups go through `buildConversationHistory` (strip tail, keep recent,
   summarize older, first turn is `user`).
7. **Verified:** the route returns 200 and streams; `[finance-hook]`/`[assistant-hook]` logs show
   the tools actually fired; new files → full restart done; relative imports carry `.js`.

---

## Bundled References (9 files)

Read the one or two the task needs — never the whole folder.

### The engine map
| File | Load when |
|------|-----------|
| `lumina-agent-engine.md` (project-grounded) | You need the whole engine in [`index.ts`](../../../backend/index.ts): the three verticals (default search, finance, assistant), how each assembles system + messages + tools and runs `streamText`; `streamText` vs `generateText` vs `generateObject` vs `embed`; where the SSE wire tail + persistence happen. **The map — start here when lost.** |

### Tools, prompts & runtime skills
| File | Load when |
|------|-----------|
| `tool-calling-and-loops.md` (generic) | Defining tools (AI SDK v6 `tool` + Zod `inputSchema` with bounds + a description that says what it covers AND does NOT), multi-step loops, `stopWhen`/`stepCountIs`, `onStepFinish`, returning typed results, closure-injected secure args, `needsApproval` (human-in-the-loop). Uses finance `tools.ts` + gmail `tools.ts` as live examples. |
| `prompt-assembly-and-playbooks.md` (project-grounded) | The layered prompt pattern: PERSONA (stable) + PLAYBOOK (per query-type) + CONTEXT (per request); `classifyQuery`, `buildSystemPrompt`, `buildUserPrompt`, `FINANCE_PERSONA`. Context engineering vs training. How to add a playbook. |
| `runtime-skills-progressive-disclosure.md` (project-grounded) | The product's OWN skills system (distinct from these dev skills): `skills.ts` parses `name`+`description` frontmatter, injects a manifest into the system prompt, and `loadSkill` returns the full body on demand. Fail-open if files aren't bundled. How to add a runtime playbook. |

### Routing, guardrails, history, wire & multimodal
| File | Load when |
|------|-----------|
| `model-gateway-and-selection.md` (project-grounded) | The Vercel AI Gateway: the `ALLOWED_MODELS` set, `resolveModel`, `DEFAULT_MODEL`, `"provider/model"` ids, one key → many providers. Choosing a model per task (cheap Haiku for compaction/summary, Sonnet default, premium for hard tasks); the embedding model. Defers Claude-specific details to the **claude-api** skill. |
| `hooks-and-guardrails.md` (project-grounded) | `withGuard` (post-call log + disclaimer staple), the budget veto enforced INSIDE the cache fetcher (so a HIT isn't charged), `RateBudgetError`, `onStepFinish` logging, abort-on-disconnect, the per-user rate limiter. The pi "hooks" idea on the AI SDK. |
| `conversation-compaction.md` (project-grounded) | `buildConversationHistory`: keep last N turns verbatim, summarize older into the system prompt (cheap model), strip the UI wire tail, the Anthropic first-turn-must-be-user rule, `persistTurns` ordering + the Vercel-freeze caveat. Keeps follow-ups cheap on long threads. |
| `streaming-and-wire-protocol.md` (project-grounded) | `writeStreamHeaders` (X-Accel-Buffering, content-type, x-conversation-id), the `textStream` loop, and the exact wire protocol: `<ANSWER>…</ANSWER>`, the `<SOURCES>`/`<IMAGES>` JSON tail, `<FOLLOW_UPS>`. How the frontend parses it (cross-ref **lumina-frontend**). |
| `multimodal-attachments.md` (project-grounded) | `buildAttachmentParts`: base64 image/file content parts, image vs file by `mediaType`, model vision/doc capability requirements, the 25mb body limit, and how attachments bypass the semantic cache. |

---

## Cross-repo prior art / cross-skill routing

- **finance-markets** — the live finance tool belt + data/providers/licensing that plug into this
  engine. When the task is finance-specific (a `getQuote`-class tool, a market summary), that skill
  owns it; this skill owns the loop/prompt/streaming mechanics underneath.
- **research-agent** — the default Discover web-search + `[n]` citation flow on the MISS path.
- **rag-retrieval** — the semantic-cache table, `embed` distance tuning, pgvector internals.
- **connectors-oauth** — Gmail OAuth, the token vault, send/schedule tools (this skill cites
  `gmail/tools.ts` only for the closure-injection pattern).
- **lumina-frontend** — how the streamed `<ANSWER>`/`<SOURCES>`/`<FOLLOW_UPS>` is parsed + rendered.
- **claude-api** — Claude/Anthropic model ids, pricing, caching, and migration details referenced
  by `model-gateway-and-selection.md`.
- Prior art: **fintech-webapp** `e:\Development\Portfolio-phase2\fintech-webapp\.claude` (translate
  its Next.js/Drizzle agent patterns → our Express/Prisma + AI-SDK stack). Project memory entries
  (`finance-tab-build`, `connectors-gmail-kb`) capture decisions; verify against live code before
  relying on any `file:line`.
