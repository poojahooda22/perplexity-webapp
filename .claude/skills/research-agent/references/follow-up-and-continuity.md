# Follow-up & Conversation Continuity — how "it"/"that"/"the second one" resolve

> What turns a stateless single-shot search into a conversation: the `/perplexity_ask/follow_up`
> path forwards **compacted** prior turns so the LLM can dereference "it", "that", "the second
> one", and follow-up pronouns against the right antecedent — without resending the whole
> transcript. This `lumina-` ref cites THIS codebase ([`backend/index.ts`](../../../../backend/index.ts));
> line numbers drift, so cite the named function before you change it.
> Read this when touching `/follow_up`, compaction, `stripWireTail`, or the "why no cache on
> follow-ups" question. Adjacent refs: `lumina-research-pipeline.md` (the full flow + where
> `/follow_up` plugs in), `answer-protocol-and-followups.md` (the `<ANSWER>`/`<FOLLOW_UPS>` wire
> contract this strips back out), and **ai-sdk-agent** for the *generic* compaction mechanics
> (this ref is the Lumina-specific application of them).

---

## 1. The two endpoints, and why follow-up is a different animal

| | `POST /perplexity_ask` | `POST /perplexity_ask/follow_up` |
|---|---|---|
| Body | `{query, conversationId?, vertical?, model?, attachments?}` | `{conversationId (required), query, vertical?, model?, attachments?}` |
| History sent to LLM | **none** — single `user` turn | prior turns, **compacted** (last 6 verbatim + summary) |
| Semantic cache | yes, when `cacheable` | **never** (see §5) |
| Pre-search | always (Discover) | always (Discover), **concurrent** with the history build (§4) |
| `messages[]` shape | `[{role:"user", content}]` | `[...history, {role:"user", content: augmentedQuery}]` |

The single difference that creates continuity: `/follow_up` loads `conversation.messages` (ownership-
checked, `orderBy: { id: "asc" }`) and feeds the prior turns to `streamText` as the `messages` array,
so the model sees the antecedents that pronouns refer to. The fresh endpoint deliberately sends only
the current `query` — a brand-new thread has nothing to dereference. See the `/follow_up` handler in
[`backend/index.ts`](../../../../backend/index.ts) (`app.post("/perplexity_ask/follow_up", …)`).

The docstring on that route states the contract verbatim: *"this forwards the prior chat turns to the
LLM so the model has context ('it', 'that', 'the second one' all resolve)."*

---

## 2. Why naive history forwarding breaks — the three problems compaction solves

Sending the raw DB transcript every follow-up has three failure modes, all addressed in
`buildConversationHistory` + `stripWireTail`:

| Problem | What goes wrong | Fix |
|---|---|---|
| **Unbounded token growth** | Each turn re-sends every prior turn → tokens grow O(n²) over a thread; eventually blows the context window and the per-request bill. | Keep only the last `KEEP_RECENT_MESSAGES = 6` verbatim; fold older turns into one cheap summary. |
| **Wire-tail pollution** | Stored assistant messages carry the `<SOURCES>`/`<IMAGES>` JSON blobs + `<ANSWER>`/`<FOLLOW_UPS>` markup (persisted for the UI). Replaying them as LLM context wastes tokens and tempts the model to re-emit protocol markup. | `stripWireTail` removes all of it before the turn becomes context. |
| **Role-alternation violation** | Anthropic (and compaction) require the `messages` array to start with a `user` turn and alternate. After slicing the last 6, the window can start on an `assistant` turn. | Drop any leading `assistant` turns from the recent window (`while (recent[0]?.role === "assistant") …`). |

---

## 3. Compaction, step by step — `buildConversationHistory`

The function (in [`backend/index.ts`](../../../../backend/index.ts), the "Conversation compaction"
section) returns `{ summary: string | null, history: [...] }`. The summary is returned **separately**
so the caller can place it in the **system** prompt — keeping `messages[]` a clean user/assistant
alternation rather than smuggling a summary in as a fake turn.

```
DB messages (role "user"|"Assistant", content WITH wire tail)
  │  normalize: "Assistant" → "assistant";  stripWireTail(content)
  ▼
turns[]
  │  turns.length <= 6 ?
  ├── YES → { summary: null, history: turns }            // short thread: verbatim, $0 extra
  └── NO  → older = turns[0 .. n-6]   recent = turns[n-6 .. n]
            drop leading assistant turns from `recent`
            transcript = older joined "User: …\n\nAssistant: …"
            generateText(SUMMARY_MODEL, "compress…preserving facts/entities/goals", transcript)
            └── { summary: text, history: recent }
            └── on throw → { summary: null, history: recent }   // FAIL-OPEN, still bounded
```

Key constants and choices, grounded:

| Knob | Value | Why |
|---|---|---|
| `KEEP_RECENT_MESSAGES` | `6` (≈ last 3 turns) | Recent turns hold the live referents ("the second one"); they MUST be verbatim, not summarized. |
| `SUMMARY_MODEL` | `anthropic/claude-haiku-4.5` | Compaction is a cheap, frequent side call — use the fast/cheap model, never the answer model. |
| Summary placement | **system** prompt, not `messages` | Preserves strict user/assistant alternation; the summary is background, not a turn. |
| Summary failure | falls back to `recent` only | The summary is an optimization; a Haiku hiccup must not fail the user's follow-up or resend the whole transcript. |

`stripWireTail` removes, in order: `<SOURCES>…<SOURCES>` and `<IMAGES>…<IMAGES>` blobs (note the
closing tag is the **same token** as the opening one — that's why the regex is non-greedy `[\s\S]*?`),
the entire `<FOLLOW_UPS>…</FOLLOW_UPS>` block (suggested questions — useless as context), and the
`<ANSWER>`/`</ANSWER>` wrappers (unwrapped, keeping the prose inside). See `stripWireTail` in
[`backend/index.ts`](../../../../backend/index.ts).

---

## 4. The concurrency win — history build ‖ web search

On the Discover follow-up path the two slow, independent operations run **in parallel**, not
sequentially:

```js
const [{ summary, history }, { results, sources, images }] = await Promise.all([
    buildConversationHistory(conversation.messages),  // may include a Haiku summary call
    webSearch(query),                                 // Tavily round-trip
]);
```

(`Promise.all` in the `/follow_up` handler, [`backend/index.ts`](../../../../backend/index.ts).) The
two have no data dependency — the search uses the raw `query`, and the history is built from already-
stored turns — so overlapping them hides the Haiku-summary latency behind the Tavily latency instead
of stacking them. The fresh `/perplexity_ask` path has no history to build, so it doesn't need this;
note it persists the user turn *non-blocking* (`persistUserTurn` with `.catch`) for the same overlap-
the-write reason.

After the join, the new query is augmented with the dated search context exactly like the fresh path
(`buildUserPrompt({ query, searchContext: formatSearchContext(results), date })`), the summary is
appended to the base system prompt, and the same `streamText` loop runs:

```js
const baseSystem = buildSystemPrompt(classifyQuery(query));
const system = summary ? `${baseSystem}\n\n## Earlier conversation (summary of older turns)\n${summary}` : baseSystem;
streamText({ model, system, messages: [...history, { role: "user", content: followUpContent }], … });
```

Note the query is **re-classified per follow-up** (`classifyQuery(query)`) — a thread can drift from a
`compare` to a `howto`, and each turn gets its own playbook.

---

## 5. Why follow-ups NEVER touch the semantic cache

This is a correctness rule, not an optimization choice. The route docstring states it: *"No semantic
cache here: a follow-up's meaning depends on the whole thread, so a cache keyed on the latest query
alone would serve wrong answers."*

The semantic cache (`embedQuery`/`findCachedAnswer`/`cacheAnswer`) keys on the **embedding of the
latest query string alone** — it has no notion of thread context. A follow-up like *"and the second
one?"* embeds to something meaningless out of context; even a concrete follow-up ("what about its
revenue?") could collide with an unrelated cached answer about a different "it". So `/follow_up`
contains **no cache read and no cache write** at all — the cache functions are simply never called on
that path. (Contrast: the fresh path gates on `cacheable = !isTimeSensitive(query) && parts.length === 0`.)

| Cache decision | Fresh `/perplexity_ask` | `/follow_up` |
|---|---|---|
| Read (`findCachedAnswer`) | if `cacheable` | never |
| Write (`cacheAnswer`) | if `cacheable && finishReason==="stop" && answer` | never |
| Reason | a self-contained query is safe to dedupe globally | meaning is thread-dependent; the key would be a lie |

---

## 6. The same compaction serves Finance & Assistant follow-ups

Compaction is vertical-agnostic. All three follow-up branches reuse `buildConversationHistory`; only
what's done *after* differs:

| Vertical | History | Pre-search | System prompt gets summary appended | Tools |
|---|---|---|---|---|
| Discover (default) | compacted | yes, `Promise.all` with history | `buildSystemPrompt(classifyQuery(query))` | none |
| `vertical:"finance"` | compacted | **no** (model fetches via tools) | `buildFinanceSystem()` | `buildFinanceTools()` |
| `vertical:"assistant"` | compacted | **no** | `buildAssistantSystem()` | `buildGmailTools({userId})` |

The finance/assistant branches build history **without** the concurrent `webSearch` (they have no pre-
search — the agent's own tools fetch live data inside the `streamText` loop), then run
`streamFinanceAnswer`/`streamAssistantAnswer` with `messages: [...history, { role:"user", content: query }]`.
See the two `if (req.body.vertical === …)` blocks at the top of the `/follow_up` handler in
[`backend/index.ts`](../../../../backend/index.ts). The summary-into-system pattern is identical
across all three (`summary ? \`${base}\n\n## Earlier conversation (summary of older turns)\n${summary}\` : base`).

> Engine note: the finance agent's `streamText` loop, `stopWhen: stepCountIs(6)`, and the tool belt
> are owned by **finance-markets** / `ai-sdk-finance-agent.md`. This ref only covers how the
> *history* reaches that loop.

---

## 7. Decision framework — picking the continuity behavior for a change

```
Adding/altering a conversation-continuation feature?
│
├─ Is the new turn's meaning self-contained (no pronouns/back-refs)?
│    ├─ YES and it's a NEW thread → /perplexity_ask (no history, cache eligible)
│    └─ NO  (depends on prior turns) → /follow_up (history forwarded, NO cache)
│
├─ Does it need prior turns as context?
│    └─ Always go through buildConversationHistory — never hand-roll a transcript join,
│       never send raw DB content (it still has the wire tail).
│
├─ Is there an independent slow op (search, fetch) alongside the history build?
│    └─ Promise.all them (like Discover follow-up); don't await sequentially.
│
├─ Where does the summary go?
│    └─ SYSTEM prompt (## Earlier conversation …). NEVER as a messages[] turn.
│
└─ Could two threads' "latest query" embed alike?
     └─ Then it's thread-dependent → it must NOT read/write the semantic cache.
```

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Re-sending the full raw transcript on every follow-up. | `buildConversationHistory`: last 6 verbatim + older summarized into the system prompt. Token cost stays flat as the thread grows. |
| Forwarding stored assistant content as-is (with `<SOURCES>`/`<IMAGES>`/`<ANSWER>` markup) as LLM context. | `stripWireTail` first — strip the UI blobs and protocol markup so they don't waste tokens or get echoed. |
| Putting the older-turns summary into `messages[]` as an extra turn. | Append it to the **system** prompt; keep `messages[]` a clean user/assistant alternation (Anthropic + compaction require it). |
| Letting the recent window start on an `assistant` turn. | Drop leading assistant turns (`while (recent[0]?.role === "assistant") recent = recent.slice(1)`). |
| Reading or writing the semantic cache on a follow-up. | Never. A follow-up's meaning is thread-dependent; the cache key (latest-query embedding) can't represent it → wrong answers. |
| Building history, then awaiting the web search (or vice-versa) sequentially. | `Promise.all([buildConversationHistory(...), webSearch(query)])` — they're independent; overlap them. |
| Classifying the query once on thread creation and reusing the playbook for every follow-up. | Re-`classifyQuery(query)` each turn — intent drifts across a conversation. |
| Failing the request when Haiku summarization throws. | Fail-open: fall back to `{ summary: null, history: recent }` (still bounded) and serve the answer. |
| Using the answer model (Opus/GPT-5.5-pro) to summarize history. | `SUMMARY_MODEL = anthropic/claude-haiku-4.5` — compaction is a cheap, frequent side call. |
| Persisting the follow-up turns after `res.end()`. | `persistTurns(...)` BEFORE `res.end()` — Vercel can freeze the instant the response closes (see `persistTurns` + the user-turn `.catch` for non-blocking write). |
| Calling `/follow_up` without a `conversationId`. | It 400s — a follow-up with no thread has nothing to dereference; start with `/perplexity_ask` (which creates the conversation) instead. |

---

## 9. Continuity checklist (what "done" looks like)

A continuity change is complete when:

1. **Resolution works:** "it"/"that"/"the second one" in a follow-up resolve against the right prior
   turn — verify with a 2-turn thread where the answer depends on the antecedent.
2. **Bounded:** history goes through `buildConversationHistory`; long threads send last 6 verbatim +
   a summary, not the whole transcript.
3. **Clean context:** every forwarded turn passed through `stripWireTail`; no `<SOURCES>`/`<ANSWER>`/
   `<FOLLOW_UPS>` markup reaches the LLM.
4. **Valid shape:** `messages[]` starts on a `user` turn and alternates; the summary lives in the
   system prompt.
5. **Concurrent:** if there's an independent search/fetch, it's `Promise.all`-ed with the history build.
6. **No cache:** the follow-up path performs no semantic-cache read or write.
7. **Per-turn intent:** the query is re-classified each follow-up (Discover) so the right playbook
   applies.
8. **Persisted safely:** both turns written via `persistTurns` BEFORE `res.end()`; the user-turn
   write is non-blocking with a `.catch`.
9. **Fail-open:** a summarization failure degrades to recent-turns-only, never a 500.
