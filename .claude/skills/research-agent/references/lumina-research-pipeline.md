# Lumina Research Pipeline — `/perplexity_ask` end to end

> The full wiring map of the Discover/search request: how one POST becomes a streamed,
> cited answer, and how the follow-up variant adds compaction + concurrent search. Read this
> FIRST when you're lost in the search flow or need to know "where does X live". The siblings
> go deep on parts this only sketches: `web-search-tavily.md` (the Tavily call), `source-grounding-and-citations.md`
> (the `[n]` contract + `<SOURCES>` tail), `query-classification-and-playbooks.md` (the classifier
> + playbooks), `answer-protocol-and-followups.md` (the `<ANSWER>`/`<FOLLOW_UPS>` wire format),
> and `follow-up-and-continuity.md` (compaction depth). The semantic-cache internals (pgvector,
> embeddings) belong to **rag-retrieval** — this doc only shows *where* the cache is checked and *why*
> it's skipped. `lumina-` = THIS codebase; line numbers drift, so cite by function name when in doubt.

Files this maps: [`backend/index.ts`](../../../../backend/index.ts) (the route + every helper) and
[`backend/prompt.ts`](../../../../backend/prompt.ts) (classify + prompt assembly).

---

## 1. The nine steps (the happy path)

`POST /perplexity_ask` is handled in [`backend/index.ts`](../../../../backend/index.ts) starting at the
route registered in `app.post("/perplexity_ask", …)` (around index.ts:593). The code is literally numbered
`step 1`…`step 9`. This is the canonical Discover (non-finance, non-assistant) flow:

| Step | What happens | Where (function) | Notes |
|---|---|---|---|
| 1 | Read `query` (+ optional `conversationId`, `model`, `vertical`, `attachments`) | route body | 400 if `query` missing/non-string |
| 2 | Auth + per-user rate limit | `middleware` + `rateLimited(userId)` | `req.userId` set by auth; 429 on >20/min/user (stopgap, in-memory) |
| — | Resolve or create the conversation (ownership-checked) | `prisma.conversation.findFirst`/`create` | new convo title = `query.slice(0,80)`, slug via `slugify` |
| — | Persist the USER turn — **non-blocking** | `persistUserTurn` (a `.catch`-guarded promise) | overlaps the search; awaited later inside `persistTurns` |
| — | Vertical fork | `if (req.body.vertical === "finance" \| "assistant")` | finance/assistant branch out here → **finance-markets**; Discover continues |
| 3 | Semantic-cache check (skipped if time-sensitive or has attachments) | `embedQuery` → `findCachedAnswer` | gated by `cacheable`; internals → **rag-retrieval** |
| — | `writeStreamHeaders(res, conversation.id)` | sets SSE headers + `x-conversation-id` | cache HIT replays here and returns |
| 4 | MISS path: live Tavily search | `webSearch(query)` → `{results, sources, images}` | search string capped at 400 chars |
| 5 | Classify + assemble the prompt | `classifyQuery` + `buildUserPrompt` + `formatSearchContext` | the "intelligence layer" |
| 6 | Stream the LLM answer | `streamText({model, system: buildSystemPrompt(type), …})` | multimodal user content if attachments present |
| 7 | Append the `<SOURCES>`/`<IMAGES>` wire tail | `sourcesImagesTail(sources, images)` | written to the live stream |
| 8 | Persist BOTH turns, then maybe cache | `persistTurns(...)` then `cacheAnswer(...)` | **before** `res.end()` — Vercel freezes on close |
| 9 | Close the stream | `res.end()` | |

```
POST /perplexity_ask
  auth → rateLimited → resolve convo → persist USER turn (non-blocking)
    ├─ vertical:"finance"   → streamFinanceAnswer  → persistTurns → end   (→ finance-markets)
    ├─ vertical:"assistant" → streamAssistantAnswer→ persistTurns → end
    └─ Discover (default):
         cacheable? = !isTimeSensitive(query) && no attachments
         embedQuery → findCachedAnswer
         writeStreamHeaders
         ├─ HIT  → res.write(answer) + tail → persistTurns → end          (NO Tavily, NO LLM)
         └─ MISS → webSearch (Tavily, ≤400 chars)
                   classifyQuery → buildUserPrompt(formatSearchContext(results))
                   streamText(system=buildSystemPrompt(type)) → stream tokens
                   + sourcesImagesTail → persistTurns → cacheAnswer? → end
```

---

## 2. The cache gate (decision framework)

The single most important branch on the hot path: **do we even talk to Tavily + the LLM?** Computed
in `step 3` of the route:

```ts
const cacheable = !isTimeSensitive(query) && parts.length === 0;
const embedding = cacheable ? await embedQuery(query) : null;
const cached    = cacheable ? await findCachedAnswer(embedding, model) : null;
```

| Condition | `cacheable` | Reads cache? | Writes cache? | Why |
|---|---|---|---|---|
| Plain evergreen query ("learn Rust") | ✅ | yes | yes (if clean) | safe to replay for the TTL |
| Time-sensitive (`isTimeSensitive` matches) | ❌ | no | no | prices/news/"today" must be live — critical for finance |
| Has attachments (`parts.length > 0`) | ❌ | no | no | the answer depends on the upload, not the text |
| Finance / assistant vertical | n/a (forks earlier) | no | no | the model fetches its own data via tools |

`isTimeSensitive` (index.ts, the `TIME_SENSITIVE` regex ~index.ts:404) matches `today|now|currently|
latest|live|breaking|news|price|stock|score|weather|this week/month/year|yesterday|tomorrow|202\d` and
similar. **Note:** this is a *separate* regex from `classifyQuery`'s `latest` matcher in
[`backend/prompt.ts`](../../../../backend/prompt.ts) — they overlap but serve different jobs (cache-skip vs
playbook-pick), so changing one does not change the other.

The cache is a **pure optimization, fail-open**: any error in `embedQuery`/`findCachedAnswer`/`cacheAnswer`
degrades to a miss/no-op and the live path runs (see the `cacheDown()` cooldown + `noteCacheError` in
index.ts). Keying is `(embedding, model)` so a premium-model request is never served a budget-model's
answer (`findCachedAnswer` WHERE `model = …`). The write rule (step 8) is strict:

```ts
if (cacheable && finishReason === "stop" && fullAnswer.trim()) {
    await cacheAnswer({ query, embedding, model, answer: fullAnswer, sources, images });
}
```

Only a **cleanly finished, non-empty, cacheable** answer is stored — never a truncated/errored/time-sensitive
one. Deeper cache mechanics (pgvector `<=>`, `DISTANCE_THRESHOLD`, embeddings) → **rag-retrieval**.

---

## 3. Search → context (the grounding layer)

### `webSearch(query)` — index.ts ~index.ts:115

```ts
const searchQuery = query.length > 400 ? query.slice(0, 400) : query; // Tavily caps at 400
const response = await tavily_client.search(searchQuery, {
    searchDepth: "basic",   // ~1.5–2.5s faster than "advanced"; the biggest miss-path latency win
    includeImages: true,
    maxResults: 10,
});
```

Returns three shapes from the SAME ordered `results`:
- `results` — full objects (title/url/content) → feed `formatSearchContext` for the LLM.
- `sources` — `{title, url, content}` → the `<SOURCES>` wire tail the UI renders.
- `images` — normalized to `{url, description?}` (Tavily sends bare URLs or `{url, description}`).

**The 400-char rule is search-only.** The user's FULL prompt still reaches the LLM via `buildUserPrompt`
— only the Tavily *search string* is sliced. Tavily 400s on longer queries; the LLM has no such cap. Tuning
the depth/topic/maxResults knobs → `web-search-tavily.md`.

### `formatSearchContext(results)` — index.ts ~index.ts:299

```ts
results.map((r, i) => `[${i + 1}] ${r.title ?? r.url}\nURL: ${r.url}\n${(r.content ?? "").slice(0, 1200)}`)
       .join("\n\n");
```

Each result is numbered `[i+1]` and its body sliced to 1200 chars. **This numbering is the contract**: the
model cites `[n]` against these numbers, and the `<SOURCES>` tail is built from the *same ordered* `results`.
Reorder or renumber one without the other and citations point at the wrong source. The positional-citation
rule is owned by `source-grounding-and-citations.md`.

---

## 4. Classify → prompt assembly (the intelligence layer)

All in [`backend/prompt.ts`](../../../../backend/prompt.ts) — pure prompt logic, touches no DB/cache. The
prompt is assembled per request from three composable layers (the pattern is documented in the file header):

```
buildSystemPrompt(type) = PERSONA  +  the ONE matching PLAYBOOK
buildUserPrompt(...)     = today's date  +  numbered web results  +  the question
```

### `classifyQuery(query)` — prompt.ts:112

A cheap, deterministic regex heuristic. **Order matters** — more specific intents win first:

| Order | `QueryType` | Trigger (abridged) | Playbook effect |
|---|---|---|---|
| 1 | `compare` | `vs / versus / compare / difference between / better than` | verdict → comparison table → "which to pick" |
| 2 | `latest` | `latest / newest / today / currently / this week-month-year / 202\d / news` | lead with newest DATED fact; flag staleness |
| 3 | `howto` | `how to / best way / steps to / tutorial / install / set up / build a` | best first step → numbered shortest path |
| 4 | `definition` | `^what is/are / who is / define / explain / meaning of` | one-line def → example → nuance |
| 5 | `general` | (fallthrough) | empty string — persona only |

### `buildSystemPrompt(queryType)` — prompt.ts:122

```ts
return playbook
    ? `${PERSONA}\n\n## Guidance for THIS query (type: ${queryType})\n${playbook}`
    : PERSONA;   // general → no extra guidance
```

`PERSONA` (prompt.ts:18) is the stable layer: "You are Lumina, an expert research assistant", the
grounded-ONLY-in-results rule, the markdown formatting rules, the `[n]` citation rules, and the
**output protocol** (`<ANSWER>…</ANSWER>` + exactly five `<FOLLOW_UPS>`). To add a new query intent you add a
`QueryType` + `PLAYBOOKS` entry + a `classifyQuery` branch — `buildSystemPrompt` injects it automatically.
Never edit the persona string to bolt on intent-specific behavior. (Playbook depth → `query-classification-and-playbooks.md`;
protocol depth → `answer-protocol-and-followups.md`.)

### `buildUserPrompt({query, searchContext, date})` — prompt.ts:130

```
## Today's date
{date}

## Web search results (numbered — cite these as [n])
{searchContext}

## User question
{query}
```

`date` is `new Date().toISOString().slice(0,10)` (computed in the route) — the model needs it for "latest"
reasoning. `query` here is the FULL prompt (the 400-char slice was for search only).

---

## 5. Stream + multimodal

`step 6` calls `streamText` and forwards tokens as they arrive:

```ts
const userContent = parts.length
    ? [{ type: "text", text: prompt }, ...parts]   // multimodal: text + image/file parts
    : prompt;                                        // plain text
const result = streamText({
    model,                                  // resolved + also the cache key
    system: buildSystemPrompt(queryType),
    messages: [{ role: "user", content: userContent }],
    abortSignal: disconnectSignal(res),     // stop generating if the client leaves
    onError: ({ error }) => console.error("streamText error:", error), // streamText swallows by default
});
for await (const textPart of result.textStream) { fullAnswer += textPart; res.write(textPart); }
```

`buildAttachmentParts` (index.ts ~index.ts:285) turns base64 uploads into AI-SDK content parts: `image/*`
→ `{type:"image"}`, everything else (PDFs/docs) → `{type:"file"}`. The model must be vision/doc-capable.
The answer is **buffered** into `fullAnswer` so it can be persisted and cached after the stream ends.
Engine mechanics (`streamText`, `stopWhen`, gateway model routing) → **ai-sdk-agent**.

---

## 6. The wire tail + persistence (don't get these wrong)

### `sourcesImagesTail(sources, images)` — index.ts ~index.ts:142

```ts
`\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n` +
`\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`
```

One string, appended to the live stream AND persisted with the assistant message — so a reloaded
conversation renders identical links/images. **The closing tag is the same token as the opening one**
(`<SOURCES>`…`<SOURCES>`, not `</SOURCES>`); the frontend parser and `stripWireTail` both depend on that
exact shape — see the `stripWireTail` regex in §7.

### `persistTurns(...)` — index.ts ~index.ts:175

```ts
await persistUserTurn;   // ensure user-turn id < assistant-turn id (chronological ordering)
const content = fullAnswer.trim() ? fullAnswer + tail : EMPTY_ANSWER_PLACEHOLDER;
await prisma.message.create({ data: { content, role: "Assistant", conversationId } });
```

Three load-bearing facts:
1. **Persist BEFORE `res.end()`.** On Vercel the instance can freeze the instant the response closes, so
   post-end DB writes (history + cache) may never run. Every branch awaits `persistTurns` then calls `res.end()`.
2. **User turn awaited first** so its autoincrement id stays below the assistant turn's (compaction reads
   messages `orderBy: { id: "asc" }`).
3. **Empty answers get a placeholder** (`EMPTY_ANSWER_PLACEHOLDER`) so the thread never dangles — preserving
   the user/assistant alternation that compaction and Anthropic require.

---

## 7. The follow-up path — what's different

`POST /perplexity_ask/follow_up` (index.ts ~index.ts:759) is the SAME pipeline plus conversation continuity.
It exists so "it" / "that" / "the second one" resolve against prior turns. Two deliberate differences:

| Aspect | `/perplexity_ask` | `/perplexity_ask/follow_up` |
|---|---|---|
| Semantic cache | checked (if cacheable) | **never** — a follow-up's meaning depends on the whole thread |
| History | none (single turn) | compacted prior turns forwarded to the LLM |
| Search timing | sequential (after cache miss) | **concurrent** with the history build |
| Prompt | persona + playbook + context | same + a summary of older turns in the SYSTEM prompt |

### Compaction — `buildConversationHistory` (index.ts ~index.ts:334)

Sending the whole raw transcript every follow-up grows tokens without bound. Instead:

1. **Normalize + strip** every stored turn via `stripWireTail` (index.ts ~index.ts:323):
   ```ts
   .replace(/\n?<SOURCES>[\s\S]*?<SOURCES>\n?/g, "")     // drop UI source blobs
   .replace(/\n?<IMAGES>[\s\S]*?<IMAGES>\n?/g, "")        // drop UI image blobs
   .replace(/<FOLLOW_UPS>[\s\S]*?<\/FOLLOW_UPS>/g, "")    // drop suggested-questions block
   .replace(/<\/?ANSWER>/g, "")                            // unwrap the answer, keep its text
   ```
   These blobs are for the frontend, useless (and expensive) as LLM context.
2. **Short thread** (`turns.length <= KEEP_RECENT_MESSAGES`, =6): send verbatim, no summary, no extra cost.
3. **Long thread**: keep the last 6 verbatim, summarize everything older with `generateText` on
   `SUMMARY_MODEL` (`anthropic/claude-haiku-4.5` — fast + cheap). Drop any leading assistant turn from the
   recent slice (Anthropic requires the first message to be `user`). On summarize failure it **falls back to
   recent turns only** rather than failing the request.

The summary is returned **separately** and the caller puts it in the SYSTEM prompt, keeping `messages` a
clean user/assistant alternation:

```ts
const baseSystem = buildSystemPrompt(classifyQuery(query));
const system = summary ? `${baseSystem}\n\n## Earlier conversation (summary of older turns)\n${summary}` : baseSystem;
```

### Concurrent history + search (index.ts ~index.ts:833)

```ts
const [{ summary, history }, { results, sources, images }] = await Promise.all([
    buildConversationHistory(conversation.messages),  // may call Haiku to summarize
    webSearch(query),                                 // Tavily
]);
```

The compaction summary call and the Tavily search are independent, so they run together — the follow-up
isn't slower than a fresh ask despite doing more. The final `streamText` is then:

```ts
messages: [...history, { role: "user", content: followUpContent }]   // compacted history + new (augmented) query
```

`followUpContent` is the same `buildUserPrompt(...)` augmented query (with multimodal parts if attached).
Deeper continuity reasoning (reference resolution, why-skip-cache) → `follow-up-and-continuity.md`; compaction
as an engine pattern → **ai-sdk-agent**.

---

## 8. Anti-patterns (mark an amateur) → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Sending the raw 800-char query to Tavily and getting a 400 | Slice to 400 for the search string ONLY; the full prompt still reaches the LLM via `buildUserPrompt` |
| Renumbering/reordering `sources` after the model cited `[n]` | Keep `results` order stable from `formatSearchContext` through `sourcesImagesTail` — `[n]` is positional |
| Caching (or replaying) a "latest / price / today / 2026" query | Let `isTimeSensitive` exclude it; only a clean `finishReason==="stop"` non-empty cacheable answer is ever stored |
| Letting the model answer from prior knowledge when results are thin | `PERSONA` forces grounding ONLY in the numbered results; thin results → say so, don't backfill |
| Persisting the assistant turn AFTER `res.end()` | `persistTurns` runs BEFORE `res.end()` — Vercel can freeze the moment the response closes |
| Adding a new query intent by editing the `PERSONA` string | Add a `QueryType` + `PLAYBOOKS` entry + a `classifyQuery` branch; `buildSystemPrompt` injects it |
| On a follow-up, resending the whole transcript (with its `<SOURCES>` blobs) | `stripWireTail` + keep last 6 verbatim + summarize older into the SYSTEM prompt |
| Writing `</SOURCES>` as the closing tag | Both tags are `<SOURCES>` (same token); the parser + `stripWireTail` regex depend on it |
| Globally bumping `searchDepth:"advanced"` / `maxResults` to "improve quality" | `basic` + 10 is the deliberate latency choice; deepen per query type — see `web-search-tavily.md` |
| Making the user-turn write block the search | It's a `.catch`-guarded non-blocking promise, awaited only inside `persistTurns` before the assistant turn |
| Throwing inside the cache helpers | Cache is fail-open: return null / no-op on error so the live path always runs (`cacheDown` cooldown) |

---

## 9. "Where does X live?" quick index

| You want to change… | File · function |
|---|---|
| The route + step ordering | `index.ts` · `app.post("/perplexity_ask", …)` (~index.ts:593) |
| The follow-up route | `index.ts` · `app.post("/perplexity_ask/follow_up", …)` (~index.ts:759) |
| The Tavily call (depth/images/maxResults/cap) | `index.ts` · `webSearch` (~index.ts:115) → `web-search-tavily.md` |
| The numbered context block | `index.ts` · `formatSearchContext` (~index.ts:299) → `source-grounding-and-citations.md` |
| The `<SOURCES>`/`<IMAGES>` tail | `index.ts` · `sourcesImagesTail` (~index.ts:142) |
| Cache skip / write rules | `index.ts` · `isTimeSensitive` (~index.ts:406), `cacheable` (~index.ts:671), `cacheAnswer` (~index.ts:475) → **rag-retrieval** |
| Persistence + ordering + placeholder | `index.ts` · `persistTurns` (~index.ts:175) |
| Compaction / history | `index.ts` · `buildConversationHistory` + `stripWireTail` (~index.ts:323) → `follow-up-and-continuity.md` |
| Attachments → content parts | `index.ts` · `buildAttachmentParts` (~index.ts:285) |
| Query classification | `prompt.ts` · `classifyQuery` (prompt.ts:112) → `query-classification-and-playbooks.md` |
| Persona / playbooks / output protocol | `prompt.ts` · `PERSONA` (prompt.ts:18), `PLAYBOOKS` (prompt.ts:87) → `answer-protocol-and-followups.md` |
| Prompt assembly | `prompt.ts` · `buildSystemPrompt` (prompt.ts:122) + `buildUserPrompt` (prompt.ts:130) |
| Disconnect handling | `index.ts` · `disconnectSignal` (~index.ts:151) |
| Streaming headers | `index.ts` · `writeStreamHeaders` (~index.ts:159) |
| Model allowlist / default / gateway | `index.ts` · `ALLOWED_MODELS` / `resolveModel` (~index.ts:67) → **ai-sdk-agent** |
| Finance / assistant verticals | `index.ts` · `streamFinanceAnswer` / `streamAssistantAnswer` → **finance-markets** |
