# Conversation Compaction — keep follow-ups cheap on long threads

> How Lumina keeps a 40-turn thread from blowing the context window (and the bill): strip the
> UI wire tail, keep the last few turns verbatim, fold everything older into a one-shot summary
> with a cheap model, and assemble a clean, Anthropic-legal `messages` array — then persist the
> new turns **before** `res.end()` so Vercel's freeze-on-close can't drop them. Read this when a
> follow-up is slow/expensive on a long conversation, when the first-turn role is wrong, when the
> summary is missing, or when reloaded history shows raw `<SOURCES>` blobs. Adjacent refs:
> **streaming-and-wire-protocol.md** owns the wire tail this strips; **prompt-assembly-and-playbooks.md**
> owns the system prompt the summary is appended to; **model-gateway-and-selection.md** owns why
> the summary uses Haiku; **lumina-agent-engine.md** is the whole-engine map.

Files: `buildConversationHistory`, `stripWireTail`, `persistTurns`, `KEEP_RECENT_MESSAGES`,
`SUMMARY_MODEL` — all in [`backend/index.ts`](../../../../backend/index.ts).
The product's *own* runtime-skill compaction (a different system) is **not** this — see
**runtime-skills-progressive-disclosure.md**.

---

## 1. Why compaction exists

A follow-up's meaning depends on the whole thread ("it", "the second one", "that company" all
resolve against earlier turns), so `/perplexity_ask/follow_up` must forward prior turns to the
model. But re-sending the **raw** transcript every follow-up has three failure modes:

| Problem | What happens without compaction |
|---------|--------------------------------|
| Unbounded token growth | Turn N pays for all N-1 prior turns; cost grows quadratically over a thread. |
| Context-window overflow | A long thread eventually exceeds the model's window → request fails. |
| Wire-blob pollution | Each stored assistant turn carries a `<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>` blob (we appended it for the UI). Resent as model context it wastes tokens and confuses the model with markup it then mimics. |

Compaction makes per-follow-up token cost **roughly flat** regardless of thread length: a fixed
window of recent turns + a short summary, with the heavy work done once by a cheap model.

The comment block over the implementation states the design directly (in [`backend/index.ts`](../../../../backend/index.ts),
"Conversation compaction (Phase 3.4)"): "(1) strip the `<SOURCES>`/`<IMAGES>` blobs … (2) keep
the last few turns verbatim … (3) fold everything older into a one-shot summary (cheap model)."

---

## 2. The four moves

`buildConversationHistory(messages)` (in [`backend/index.ts`](../../../../backend/index.ts),
`async function buildConversationHistory`) takes the DB messages (oldest first) and returns
`{ summary: string | null, history: Array<{role:"user"|"assistant", content}> }`.

### Move 1 — normalize roles + strip the wire tail
```ts
const turns = messages.map((m) => ({
  role: m.role === "Assistant" ? "assistant" : "user",   // DB enum 'Assistant' -> 'assistant'
  content: stripWireTail(m.content),
}));
```
Two jobs in one map: the Prisma `Message.role` enum value is `"Assistant"` (capitalized), but the
AI SDK / Anthropic want lowercase `"assistant"` — normalize it. And `stripWireTail` removes the
frontend-only markup (next section).

### Move 2 — short thread short-circuit
```ts
if (turns.length <= KEEP_RECENT_MESSAGES) return { summary: null, history: turns };
```
`KEEP_RECENT_MESSAGES = 6` (≈ last 3 user/assistant pairs). Threads at/below that send verbatim:
**no summary, no extra LLM call, no extra cost.** Compaction only kicks in once it pays for itself.

### Move 3 — split older vs recent, fix the leading role
```ts
const older  = turns.slice(0, turns.length - KEEP_RECENT_MESSAGES);
let   recent = turns.slice(turns.length - KEEP_RECENT_MESSAGES);
while (recent[0]?.role === "assistant") recent = recent.slice(1);   // Anthropic: first turn = user
```
The Anthropic API rejects a `messages` array whose first turn is `assistant`. After slicing the
window we may land on an assistant turn (the window boundary is positional, not role-aware), so we
drop leading assistant turns until the first is `user`. The dropped turns aren't lost — they're
either already inside the `older` summary, or (in the boundary case) acceptable to omit because the
following user turn carries the question. **The new user query is always appended after this** by
the caller, so the alternation stays valid.

### Move 4 — summarize the older turns with the cheap model
```ts
const transcript = older.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n");
const { text } = await generateText({
  model: SUMMARY_MODEL,                                   // "anthropic/claude-haiku-4.5"
  system: "You compress conversations. Summarize … preserving key facts, named entities, the " +
          "user's goals, and any decisions needed to answer future follow-ups. … Do not invent anything.",
  prompt: transcript,
});
return { summary: text.trim(), history: recent };
```
`generateText` (not `streamText`) — this is an internal, non-streamed call whose whole output we
need before continuing. `SUMMARY_MODEL = "anthropic/claude-haiku-4.5"`: compaction is latency- and
cost-sensitive and runs on **every** long-thread follow-up, so it uses the cheapest capable model,
not the user's chosen answer model. The summary prompt explicitly forbids invention — a hallucinated
"fact" in the summary would silently poison every subsequent turn.

---

## 3. `stripWireTail` — the markup contract

`stripWireTail(content)` (in [`backend/index.ts`](../../../../backend/index.ts)) removes everything
we appended for the **frontend** so it never re-enters **model** context:

| Regex target | Why removed | Note |
|--------------|-------------|------|
| `<SOURCES>…<SOURCES>` | The JSON sources blob the UI renders as citation chips. | Closing tag is the **same token** as the opening (`<SOURCES>`, not `</SOURCES>`) — matched non-greedily with `[\s\S]*?`. |
| `<IMAGES>…<IMAGES>` | The JSON image-list blob. | Same same-token quirk. |
| `<FOLLOW_UPS>…</FOLLOW_UPS>` | The persona's suggested-questions block — dropped **entirely** (we don't want the model replaying old suggestions as context). | Real closing tag `</FOLLOW_UPS>` here. |
| `<ANSWER>` / `</ANSWER>` | The persona wraps prose in `<ANSWER>…</ANSWER>`; we **unwrap** (strip the tags, keep the text) so the model sees clean prior answers. | |

```ts
content
  .replace(/\n?<SOURCES>[\s\S]*?<SOURCES>\n?/g, "")
  .replace(/\n?<IMAGES>[\s\S]*?<IMAGES>\n?/g, "")
  .replace(/<FOLLOW_UPS>[\s\S]*?<\/FOLLOW_UPS>/g, "")   // suggested-questions — drop
  .replace(/<\/?ANSWER>/g, "")                          // unwrap, keep the text
  .trim();
```

**The contract that binds two functions:** `sourcesImagesTail` (writes `<SOURCES>…<SOURCES>` +
`<IMAGES>…<IMAGES>` with the same-token closing) and `stripWireTail` (removes them) must agree on
the exact tokens. Change one and you change the other — see **streaming-and-wire-protocol.md**.
A mismatch leaks raw JSON into model context (token waste + the model starts emitting source blobs).

---

## 4. Where the summary goes — the SYSTEM prompt, not `messages`

The summary is returned **separately** from `history` on purpose: the caller folds it into the
**system** prompt, keeping the `messages` array a clean user/assistant alternation. Every vertical
does this identically in `/perplexity_ask/follow_up` (in [`backend/index.ts`](../../../../backend/index.ts)):

```ts
const { summary, history } = await buildConversationHistory(conversation.messages);
const system = summary
  ? `${baseSystem}\n\n## Earlier conversation (summary of older turns)\n${summary}`
  : baseSystem;                                          // no summary on short threads
const result = streamText({
  model: resolveModel(req.body.model),
  system,
  messages: [...history, { role: "user", content: query /* or augmentedQuery */ }],
  ...
});
```

| Vertical | `baseSystem` | Pre-search? |
|----------|--------------|-------------|
| default (Discover) | `buildSystemPrompt(classifyQuery(query))` | Yes — Tavily, run **concurrently** with compaction via `Promise.all` |
| `finance` | `buildFinanceSystem()` | No — model fetches via tools |
| `assistant` | `buildAssistantSystem()` | No — Gmail tools |

The default path overlaps the two slow operations:
```ts
const [{ summary, history }, { results, sources, images }] = await Promise.all([
  buildConversationHistory(conversation.messages),       // Haiku summary call
  webSearch(query),                                      // Tavily
]);
```
Compaction (a Haiku round-trip) and the web search are independent, so running them in parallel
hides the summary latency behind the search. Finance/assistant have no pre-search, so they just
`await buildConversationHistory(...)` directly.

> **Why system, not a message?** Putting the summary as a fake `assistant`/`user` message would
> break the alternation and risk the model treating it as something it "said". As a system block
> it reads as durable context, and `messages` stays a strict user→assistant→user→… sequence.

---

## 5. `persistTurns` ordering + the Vercel-freeze caveat

Compaction reads `conversation.messages` from the DB — so **what got persisted, and in what order,
is part of the compaction contract.** `persistTurns` (in [`backend/index.ts`](../../../../backend/index.ts))
governs both.

```ts
async function persistTurns(persistUserTurn, conversationId, fullAnswer, tail) {
  await persistUserTurn;                                 // user turn FIRST → lower autoincrement id
  const content = fullAnswer.trim() ? fullAnswer + tail : EMPTY_ANSWER_PLACEHOLDER;
  await prisma.message.create({ data: { content, role: "Assistant", conversationId } });
}
```

Three things compaction depends on:

1. **User turn awaited before the assistant turn is written.** The user message is created
   non-blocking at request start (`const persistUserTurn = prisma.message.create(...).catch(...)`)
   so it overlaps the search/LLM; `persistTurns` awaits it first so its autoincrement `Message.id`
   stays **below** the assistant turn's. History is later loaded `orderBy: { id: "asc" }`, so this
   ordering = correct chronology = correct user/assistant alternation feeding compaction.
2. **Empty-answer placeholder keeps the alternation intact.** If the model produced no prose,
   `EMPTY_ANSWER_PLACEHOLDER` is stored as the assistant turn so the thread never dangles on a lone
   user turn — which would later make `buildConversationHistory` produce an `older` slice ending on
   `user` and a `recent` window that could start wrong. Every user turn always has an answering
   assistant turn.
3. **Persist BEFORE `res.end()`.** On Vercel the function instance can **freeze the instant the
   response closes**, so any DB write after `res.end()` may never run. Every branch does
   `await persistTurns(...)` *then* `res.end()`. If the assistant turn isn't written, the next
   follow-up's compaction sees a thread missing its last answer — silent, intermittent, and only on
   serverless. This is the single most important ordering rule here.

The stored assistant content includes the wire `tail` (`fullAnswer + tail`) so a reloaded thread
keeps its links/images — which is *exactly why* `stripWireTail` exists: the same content is great
for the UI and wrong for the model.

---

## 6. Decision framework — should this path compact?

```
Is the request a FOLLOW-UP (has prior turns to forward)?
├─ No  (/perplexity_ask, fresh single turn) → no compaction; messages = [{role:"user", content}]
└─ Yes (/perplexity_ask/follow_up)
     │
     ├─ turns ≤ KEEP_RECENT_MESSAGES (6)?
     │     └─ Yes → send verbatim, summary=null, NO extra LLM call
     │
     └─ turns > 6
           ├─ summarize `older` with SUMMARY_MODEL (Haiku) → summary
           ├─ keep last 6 verbatim, drop leading assistant turn(s)
           ├─ put summary in SYSTEM prompt (not messages)
           └─ if summarize THROWS → fall back to `recent` only (still bounded), summary=null
```

**Tuning levers:**

| Lever | Today | Raise it when | Lower it when |
|-------|-------|---------------|---------------|
| `KEEP_RECENT_MESSAGES` | 6 (≈3 pairs) | Follow-ups feel like they "forget" recent detail; summary loses nuance. | Recent turns are huge (long pasted text) and verbatim cost dominates. |
| `SUMMARY_MODEL` | `anthropic/claude-haiku-4.5` | Summaries drop critical facts on complex threads (try Sonnet — but it costs more on *every* long follow-up). | A cheaper/faster model becomes available in the gateway allowlist. |
| Summary placement | system prompt | — | Don't move it into `messages`; that breaks alternation. |

---

## 7. Failure handling — best-effort, never fail the request

Compaction is an **optimization**, so it degrades instead of erroring (mirrors the fail-open
semantic cache in the same file):

```ts
catch (e) {
  console.error("[compaction] summarize failed:", e instanceof Error ? e.message : String(e));
  return { summary: null, history: recent };            // bounded fallback, NOT the whole transcript
}
```
If the Haiku summary call fails, we return the recent window with **no** summary rather than
(a) failing the user's follow-up or (b) falling back to the full raw transcript (which reintroduces
the unbounded-token problem). The user loses some older context for that one turn; the request still
succeeds and stays bounded.

---

## 8. Anti-patterns / do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Re-send the whole raw transcript every follow-up. | `buildConversationHistory`: strip tail, keep last 6, summarize older. Cost stays ~flat. |
| Leave `<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>` blobs in resent history. | `stripWireTail` every turn before it becomes model context; markup is UI-only. |
| Match `</SOURCES>` as the closing tag. | The closing token is `<SOURCES>` (same as opening) — keep `stripWireTail` and `sourcesImagesTail` in lockstep. |
| Put the summary into `messages` as a fake turn. | Append it to the **system** prompt; keep `messages` a clean user/assistant alternation. |
| Send a `messages` array whose first turn is `assistant`. | `while (recent[0]?.role === "assistant") recent = recent.slice(1)` before appending the new user query. |
| Use the user's answer model (or Sonnet) for the summary. | `SUMMARY_MODEL = haiku-4.5` — cheap + fast; this runs on every long follow-up. |
| Run compaction and the web search sequentially. | `Promise.all([buildConversationHistory(...), webSearch(...)])` on the default path. |
| Fall back to the full transcript when summarization fails. | Fall back to `recent` only (bounded); log and move on — never fail the request. |
| `await cache/persist` AFTER `res.end()`. | `await persistTurns(...)` BEFORE `res.end()` — Vercel freezes on close, so the next follow-up's history would be missing its last answer. |
| Persist the assistant turn before the user turn. | `await persistUserTurn` first so its `Message.id` is lower → correct chronology when loaded `orderBy id asc`. |
| Skip writing an assistant turn when the model returns nothing. | Store `EMPTY_ANSWER_PLACEHOLDER` so the thread never dangles and the alternation holds for the next compaction. |

---

## 9. Verify

- **Short thread:** ≤6 turns → no `[compaction]` activity, no Haiku call, history sent verbatim.
- **Long thread:** >6 turns → the system prompt of the next follow-up contains
  `## Earlier conversation (summary of older turns)`; the `messages` array has exactly the last few
  turns + the new user query, first role is `user`.
- **No leaked markup:** the resent `messages` (and the summary input transcript) contain no
  `<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>`/`<ANSWER>` tokens.
- **Persistence ordering:** after a turn, the conversation's messages load chronologically
  (user then assistant) with the assistant turn carrying its wire tail; the next follow-up sees it.
- **Freeze safety:** on Vercel, reloading a conversation right after a follow-up shows BOTH new
  turns — if the assistant turn is missing, a write slipped past `res.end()`.
