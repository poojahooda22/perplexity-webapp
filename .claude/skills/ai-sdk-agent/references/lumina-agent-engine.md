# Lumina Agent Engine — the whole engine in index.ts

> The map of the engine EVERY vertical runs on. Read this FIRST when you're lost in the chat
> stack: it shows the three verticals (default Discover search, `finance`, `assistant`), how each
> assembles `system` + `messages` + `tools` and calls `streamText`, when the code reaches for
> `generateText` / `generateObject` / `embed` instead, and exactly where the SSE wire tail +
> persistence happen. `lumina-` ref = THIS codebase; cite the live file before you change it
> (line numbers drift — phrasing names the function so you can re-find it).
>
> Sibling refs cover the parts this map only points at: `tool-calling-and-loops.md` (the `tool()`
> + Zod contract, `stopWhen`, typed results), `prompt-assembly-and-playbooks.md` (`PERSONA`/
> `PLAYBOOKS`/`classifyQuery`), `model-gateway-and-selection.md` (`resolveModel`/`ALLOWED_MODELS`),
> `conversation-compaction.md` (`buildConversationHistory`), `streaming-and-wire-protocol.md`
> (the `<ANSWER>`/`<SOURCES>`/`<FOLLOW_UPS>` format), `hooks-and-guardrails.md`,
> `multimodal-attachments.md`, and `runtime-skills-progressive-disclosure.md`.

Primary file: [`backend/index.ts`](../../../../backend/index.ts) (the engine) +
[`backend/prompt.ts`](../../../../backend/prompt.ts) (the prompt layer).

---

## 1. One engine, three verticals, two endpoints

Everything chat-shaped enters through **two** routes in [`backend/index.ts`](../../../../backend/index.ts):
`POST /perplexity_ask` (fresh single turn) and `POST /perplexity_ask/follow_up` (continues a
thread with history). Inside each, a `req.body.vertical` switch picks one of three engines. They
share auth, rate-limit, conversation resolution, persistence, streaming headers, and the wire tail
— only the **system + messages + tools** differ.

| Vertical | `vertical` value | System prompt | Tools | Web pre-search? | Semantic cache? | Streamer fn |
|---|---|---|---|---|---|---|
| **Discover (default)** | absent / anything else | `buildSystemPrompt(classifyQuery(q))` (`prompt.ts`) | none (search done up front) | yes — Tavily, results in user prompt | yes (non-time-sensitive, no attachments) | inline `streamText` in the route |
| **Finance** | `"finance"` | `buildFinanceSystem()` (`FINANCE_PERSONA` + skills manifest) | `buildFinanceTools().tools` (`getQuote`/`getCrypto`/`getIndices`/`financeWebSearch`/`loadSkill`) | no — model fetches via tools | **no** (model fetches live data) | `streamFinanceAnswer` |
| **Assistant** | `"assistant"` | `buildAssistantSystem()` (inline string, dated) | `buildGmailTools({userId})` (read-only Gmail) | no | **no** | `streamAssistantAnswer` |

The branch order in `/perplexity_ask` is: **finance → assistant → (fall through to) Discover**. The
two agentic verticals `return` early; the default path is the rest of the function (cache → search →
LLM → cache-write). See the route at `app.post("/perplexity_ask", …)` and the matching follow-up route.

```
POST /perplexity_ask  (or /follow_up)
  ├─ auth middleware → req.userId           (401 if absent)
  ├─ rateLimited(userId)?                    (429 — 20/min/user stopgap)
  ├─ resolve/create conversation (ownership-checked)
  ├─ persistUserTurn = prisma.message.create(...).catch(...)   // non-blocking, awaited later
  ├─ vertical === "finance"   → writeStreamHeaders → streamFinanceAnswer  → persistTurns → res.end()
  ├─ vertical === "assistant" → writeStreamHeaders → streamAssistantAnswer→ persistTurns → res.end()
  └─ DEFAULT (Discover):
        resolveModel → buildAttachmentParts → cacheable? → embedQuery → findCachedAnswer
        writeStreamHeaders
        ├─ HIT  → res.write(answer)+tail → persistTurns → res.end()
        └─ MISS → webSearch → classifyQuery → buildUserPrompt → streamText
                  → stream tokens → tail → persistTurns → (cacheAnswer if clean) → res.end()
```

---

## 2. The five AI-SDK primitives — when each is used

The engine imports four functions from `ai`: `streamText, embed, generateText, stepCountIs`
(line 3) and `generateObject` lives in the finance narrative files. Pick by **shape of the output
the caller needs**, not habit.

| Primitive | Used for | Where in this repo | Why this one |
|---|---|---|---|
| **`streamText`** | The user-visible answer in ALL three verticals — token-by-token to the SSE stream. | `streamFinanceAnswer`, `streamAssistantAnswer`, and the two inline calls in the Discover MISS / follow-up paths. | The user must see tokens as they generate (perceived latency). It also runs the multi-step **tool loop** for the agentic verticals. |
| **`generateText`** | One-shot, NON-streamed text where the user never sees it. | `buildConversationHistory` summarizes old turns with `SUMMARY_MODEL` (Haiku). | No streaming needed — it's an internal compaction step; just await the whole string. Cheap model. |
| **`generateObject`** | Structured, schema-validated output (Zod). | NOT in `index.ts` — the finance narratives (`summary.ts`, `research.ts`) use it. Described here because it's the 3rd choice. | When you need typed JSON (headline+body items, `{title, summary, keyPoints[]}`) not prose. Defer to **finance-markets**. |
| **`embed`** | Turn a query into a vector for the semantic cache key. | `embedQuery` → `embed({ model: "openai/text-embedding-3-small", value: query })`. | Cache lookup is a vector-similarity search (pgvector `<=>`), so the key is an embedding, not text. Defer internals to **rag-retrieval**. |
| **`tool` + `stepCountIs`** | Define tools / bound the loop. | `stepCountIs(6)` in both agentic streamers; `tool()` lives in the per-vertical tool factories. | The loop must terminate. See `tool-calling-and-loops.md`. |

**Decision framework — which primitive?**
```
Does the USER read the output token-by-token?           → streamText
Internal text the user never sees (summary, rewrite)?   → generateText  (cheap model)
Need typed/validated JSON back?                          → generateObject + Zod
Need a vector (cache key, retrieval)?                    → embed
```

---

## 3. The agentic streamers (finance + assistant) — same skeleton

`streamFinanceAnswer` and `streamAssistantAnswer` are near-identical; learn one, you know both.
Both: build a per-request tool set, call `streamText` with a bounded loop + disconnect abort +
a step-logging hook, drain `result.textStream` into `res.write`, then append the wire tail.

```ts
// streamFinanceAnswer (backend/index.ts) — the canonical agentic loop
const { tools, sources } = buildFinanceTools();      // FRESH tools + sources[] per request
const result = streamText({
  model: opts.model,                                  // resolved Gateway id
  system: opts.system,                                // buildFinanceSystem()
  messages: opts.messages,
  tools,
  stopWhen: stepCountIs(6),                           // bound tool round-trips per turn
  abortSignal: disconnectSignal(opts.res),            // stop the loop if the client leaves
  onStepFinish: (step) => { /* log [finance-hook] step tools=[…] */ },
  onError: ({ error }) => console.error("finance streamText error:", error),
});
let fullAnswer = "";
for await (const textPart of result.textStream) { fullAnswer += textPart; opts.res.write(textPart); }
const tail = sourcesImagesTail(sources, []);          // finance fills sources[] via financeWebSearch
opts.res.write(tail);
return { fullAnswer, tail, finishReason };
```

| Detail | Finance | Assistant |
|---|---|---|
| Tool factory | `buildFinanceTools()` → `{tools, sources}` | `buildGmailTools({userId})` (closure-injects `userId` — model can't touch other mailboxes) |
| Sources | `financeWebSearch` pushes into the shared `sources[]`; tail carries them | none — tail is `sourcesImagesTail([], [])` |
| System | `buildFinanceSystem()` = `FINANCE_PERSONA` + `<available_skills>` manifest | `buildAssistantSystem()` — inline dated string, read-only Gmail rules |
| Step log | `[finance-hook] step tools=[…] finish=…` | `[assistant-hook] step tools=[…] finish=…` |
| `finishReason` | returned (awaited in a try/catch → `"error"` on throw) | not surfaced (no caching of agentic answers) |

> **Why a FRESH tool set per request** (`buildFinanceTools()` is called inside the streamer, not
> module-scope): the `sources[]` accumulator and any per-request `userId` must not bleed across
> concurrent requests. Never hoist the factory to a shared constant.

---

## 4. The default Discover path — cache then search then stream

The fall-through path in `/perplexity_ask` is the only one with the semantic cache and the Tavily
pre-search. Its order is load-bearing:

1. **Resolve the model up front** (`resolveModel(req.body.model)`) — the cache is keyed on
   `(embedding, model)`, so a premium-model request never gets a budget-model's cached answer.
2. **`cacheable = !isTimeSensitive(query) && parts.length === 0`** — prices/news/"today" and any
   request carrying attachments skip the cache entirely (no read, no write). The `TIME_SENSITIVE`
   regex is the guard; attachments make the answer upload-dependent.
3. **`embedQuery` → `findCachedAnswer`** (both fail-open: any error = a miss). A HIT replays the
   stored answer + its `sources`/`images` through the **same** `sourcesImagesTail`, so the client
   can't tell a cached answer from a live one. Sub-second; skips Tavily AND the LLM.
4. **MISS:** `webSearch(query)` (Tavily, `searchDepth:"basic"`, `maxResults:10`) → `classifyQuery`
   → `buildUserPrompt({query, searchContext: formatSearchContext(results), date})` → `streamText`.
5. **`finishReason`** is awaited; only `finishReason === "stop" && fullAnswer.trim()` (a clean,
   non-empty answer) is written back with `cacheAnswer`. Never cache a truncated/errored answer.

The follow-up route mirrors this but, instead of cache, runs `buildConversationHistory` and
`webSearch` **concurrently** with `Promise.all`, folds the older-turns summary into the SYSTEM
prompt, and sends `[...history, {role:"user", content: augmentedQuery}]`. No semantic cache on
follow-ups (a follow-up's meaning depends on the whole thread).

---

## 5. Shared plumbing — the functions every branch reuses

| Helper (`index.ts`) | Job | Gotcha it encodes |
|---|---|---|
| `resolveModel(model)` | Validate `req.body.model` against `ALLOWED_MODELS`; else `DEFAULT_MODEL` (`anthropic/claude-sonnet-4.6`). | Never trust raw `req.body.model`; one `AI_GATEWAY_API_KEY` → every provider. See `model-gateway-and-selection.md`. |
| `rateLimited(userId)` | Sliding-window 20/min/user stopgap before billing. | In-memory, per-instance — best-effort; make it Redis for hard limits. |
| `writeStreamHeaders(res, convId)` | Sets `text/event-stream`, `no-cache`, `X-Accel-Buffering:no`, `x-conversation-id`, flushes. | Centralized so the (Vercel-specific) header set is identical across every branch — frontend parses one shape. |
| `disconnectSignal(res)` | `AbortSignal` that fires on client disconnect mid-stream. | Stops the loop burning tokens/vendor credits on a response nobody reads. **Wire it at the `streamText` level only — never into a shared/de-duped cache fetcher.** |
| `sourcesImagesTail(sources, images)` | The `<SOURCES>…<SOURCES>` + `<IMAGES>…<IMAGES>` JSON blocks as ONE string. | Written to the live stream AND persisted, so a reloaded conversation keeps its links/images. See `streaming-and-wire-protocol.md`. |
| `persistTurns(persistUserTurn, convId, fullAnswer, tail)` | Await the user turn, then write the assistant turn (content = `fullAnswer + tail`, or a placeholder if empty). | Called **BEFORE `res.end()` in every branch** — on Vercel the instance can freeze the instant the response closes, so post-`end()` writes may never run. Awaits the user turn first so its id stays below the assistant turn's. |
| `buildAttachmentParts(input)` | base64 attachments → AI-SDK `image`/`file` content parts. | Image vs file by `mediaType`; model must be vision/doc-capable. Attachments force `cacheable=false`. See `multimodal-attachments.md`. |
| `buildConversationHistory(messages)` | Strip wire tail, keep last `KEEP_RECENT_MESSAGES`(6) verbatim, summarize older via Haiku, drop leading assistant. | Returns `{summary, history}` — summary goes in SYSTEM, `messages` stays a clean user/assistant alternation, first turn is `user` (Anthropic rule). See `conversation-compaction.md`. |
| `stripWireTail(content)` | Remove `<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>`, unwrap `<ANSWER>`. | UI markup is not LLM context; don't replay it on follow-ups. |

---

## 6. The prompt layer ([`prompt.ts`](../../../../backend/prompt.ts)) — how `system` is built

The Discover system prompt is assembled per request from composable layers (pattern borrowed from
pi): **PERSONA** (stable identity + Markdown/citation rules + the `<ANSWER>`/`<FOLLOW_UPS>` output
protocol) + **one PLAYBOOK** chosen by `classifyQuery`. The CONTEXT (web results + question + date)
goes in the USER message via `buildUserPrompt`.

```
classifyQuery(query)  → "compare" | "latest" | "howto" | "definition" | "general"
buildSystemPrompt(t)  → PERSONA  (+ "## Guidance for THIS query" + PLAYBOOKS[t], unless general)
buildUserPrompt(...)  → "## Today's date … ## Web search results … ## User question"
```

`FINANCE_PERSONA` is the finance analogue (tool-first, no-advice, same output protocol so the chat
UI renders finance answers unchanged). `buildAssistantSystem()` is built inline in `index.ts`, not
`prompt.ts`. This is **context engineering, not training** — same model, sharper per-query
instructions. Full treatment in `prompt-assembly-and-playbooks.md`.

---

## 7. The semantic-cache mini-subsystem (Discover only)

Four functions, all **fail-open** (any error → behaves as a miss/no-op, live path runs):
`embedQuery` (`embed`), `findCachedAnswer` (pgvector `<=>` cosine distance, `LIMIT 1`),
`cacheAnswer` (`INSERT … ::vector`), and the availability gate `cacheDown()`/`noteCacheError()`.

| Tunable | Value | Meaning |
|---|---|---|
| `DISTANCE_THRESHOLD` | `0.15` | cosine distance below which two queries count as the same question |
| `CACHE_TTL_DAYS` | `7` | rows older than this are ignored |
| `CACHE_COOLDOWN_MS` | `60_000` | after a real infra error (Postgres `42P01` undefined_table) pause the cache, then PROBE again — self-heals, no restart |

`noteCacheError` pauses the cache ONLY on Postgres code `42P01` — it deliberately does NOT free-text
match "does not exist", because the AI gateway returns "model does not exist…" for credential
issues, which must never be mistaken for a missing table. The cache is keyed on `(embedding, model)`.
Distance tuning + the table schema belong to **rag-retrieval** — this map only shows where `embed`
is *called*.

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Persisting the turn (or writing the cache) AFTER `res.end()`. | `await persistTurns(...)` BEFORE `res.end()` in every branch — Vercel freezes on close. |
| Streaming an internal step (summary/compaction) the user never reads. | `generateText` (one-shot, cheap model) — reserve `streamText` for user-visible output. |
| Hoisting `buildFinanceTools()`/`buildGmailTools()` to module scope to "reuse" it. | Build a FRESH tool set per request — the `sources[]`/`userId` must not bleed across concurrent calls. |
| Threading `disconnectSignal(res)` into a shared cache fetcher. | Cancel at the `streamText` level only; one caller's disconnect must not abort the shared in-flight fetch. |
| Caching a finance/time-sensitive answer, or caching a truncated one. | `cacheable` gate (`isTimeSensitive` + attachments) and cache only `finishReason === "stop" && fullAnswer.trim()`. |
| Letting `req.body.model` reach `streamText` raw, or hardcoding a model literal. | `resolveModel(...)` → allowlist or `DEFAULT_MODEL`. |
| Emitting a different wire shape per vertical. | One `writeStreamHeaders` + one `sourcesImagesTail` — assistant just passes empty arrays. |
| Re-sending the whole raw transcript (with `<SOURCES>` blobs) on follow-up. | `buildConversationHistory` → strip tail, keep last 6, summarize older into SYSTEM. |
| Pausing the semantic cache on any error string containing "does not exist". | Match Postgres code `42P01` only — gateway credential errors say "model does not exist". |
| Omitting `.js` on a relative import / forgetting a full restart after a new file. | Always `from './prompt.js'`; full restart on new files (`bun --hot` misses them; Vercel's ESM resolver fails without `.js`). |

---

## 9. Where to make a change (cheat sheet)

- **New vertical** → add a `vertical === "x"` branch in BOTH `/perplexity_ask` and `/follow_up`,
  a `streamXAnswer` streamer (copy `streamAssistantAnswer`), a `buildXSystem()`, and a tool factory.
  Reuse `writeStreamHeaders`/`sourcesImagesTail`/`persistTurns` verbatim. → also `tool-calling-and-loops.md`.
- **New tool in finance/assistant** → the tool factory (`finance/tools.ts` / `connectors/gmail/tools.ts`),
  not `index.ts`. → `tool-calling-and-loops.md` + **finance-markets**.
- **New Discover query-type behavior** → a `PLAYBOOK` + `classifyQuery` branch in `prompt.ts`. →
  `prompt-assembly-and-playbooks.md`.
- **New model** → add to `ALLOWED_MODELS` + the frontend picker. → `model-gateway-and-selection.md`.
- **Change loop length** → `stepCountIs(N)` in the streamers.
- **Change history budget** → `KEEP_RECENT_MESSAGES` / `SUMMARY_MODEL`. → `conversation-compaction.md`.
- **Change the wire format** → `sourcesImagesTail` + `stripWireTail` together (they must stay in
  sync) + the frontend parser. → `streaming-and-wire-protocol.md`.

---

## 10. Output contract — an engine change is done when

1. The new behavior lives in the right layer (vertical branch / streamer / prompt layer / tool
   factory), not bolted onto one string.
2. `streamText` for user output, `generateText`/`generateObject`/`embed` for the non-streamed shapes.
3. Agentic loops set `stopWhen: stepCountIs(N)`, `abortSignal: disconnectSignal(res)`, and an
   `onStepFinish` log.
4. `writeStreamHeaders` → tokens → `sourcesImagesTail` → `persistTurns` BEFORE `res.end()`; only a
   clean (`finishReason==="stop"`, non-empty) Discover answer is cached.
5. Follow-ups go through `buildConversationHistory`; the model id through `resolveModel`.
6. Relative imports carry `.js`; new files → full dev-server restart; route returns 200 and streams,
   and `[finance-hook]`/`[assistant-hook]` logs show the tools actually fired.
