# Streaming & the Wire Protocol — how Lumina ships an answer over one HTTP stream

> The byte-level contract between the engine and the browser: how the SSE-shaped response is
> opened (`writeStreamHeaders`), how tokens flow (the `textStream` loop), and the EXACT wire
> tail — `<ANSWER>…</ANSWER>`, the `<SOURCES>`/`<IMAGES>` JSON blocks, the `<FOLLOW_UPS>`
> question list — plus how the frontend reassembles all of it from one running buffer. `lumina-`
> ref = THIS codebase; cite the live file before changing it (line numbers drift). Adjacent refs:
> the loop that *produces* the tokens → `tool-calling-and-loops.md`; the `<ANSWER>`/`<FOLLOW_UPS>`
> markup is authored by the persona → `prompt-assembly-and-playbooks.md`; stripping this tail back
> out of history → `conversation-compaction.md`; the persist-before-`res.end()` ordering →
> `hooks-and-guardrails.md`. UI rendering of the parsed result → **lumina-frontend** skill.

Files:
`writeStreamHeaders` / `sourcesImagesTail` / `disconnectSignal` / `persistTurns` / the three
`textStream` loops in [`backend/index.ts`](../../../../backend/index.ts);
the `<ANSWER>`/`<FOLLOW_UPS>` protocol authored in `PERSONA` + `FINANCE_PERSONA` in
[`backend/prompt.ts`](../../../../backend/prompt.ts);
the parser `parseStream` + the `SOURCES_RE`/`IMAGES_RE` regexes in
[`frontend/src/lib/api.ts`](../../../../frontend/src/lib/api.ts).

---

## 1. One protocol, three (really four) producers

Every chat response in the app — the default Discover web-search path, a semantic-cache replay,
the finance tool agent, the Gmail assistant agent — emits the **same byte shape** so the frontend
parses them identically. That is the whole point of centralizing the header + tail helpers.

```
  HTTP 200, headers: { content-type: text/event-stream, x-conversation-id: <id>, X-Accel-Buffering: no }
  ──────────────────────────────────────────────────────────────────────────────
  <ANSWER>…markdown body with inline [n] citations…</ANSWER>     ← streamed token by token
  <FOLLOW_UPS>
   <question>…</question> × 5
  </FOLLOW_UPS>
                                                                  ← then, as ONE write:
  \n<SOURCES>\n[{"title","url","content"}, …]\n<SOURCES>\n
  \n<IMAGES>\n[{"url","description?"}, …]\n<IMAGES>\n
  ──────────────────────────────────────────────────────────────────────────────
  (connection closes)
```

| Producer | File / fn | `<ANSWER>`/`<FOLLOW_UPS>` from | `<SOURCES>` payload | `<IMAGES>` payload |
|---|---|---|---|---|
| Discover (miss path) | `/perplexity_ask` step 4–7 in [`index.ts`](../../../../backend/index.ts) | LLM, guided by `PERSONA` | Tavily `webSearch().sources` | Tavily `webSearch().images` |
| Discover (cache hit) | `if (cached)` block in `/perplexity_ask` | replayed stored answer | `cached.sources` | `cached.images` |
| Finance agent | `streamFinanceAnswer` | LLM, guided by `FINANCE_PERSONA` | `financeWebSearch` `sources[]` accumulator | `[]` (empty) |
| Assistant (Gmail) | `streamAssistantAnswer` | LLM, guided by `buildAssistantSystem()` (no formal output-protocol block) | `[]` (empty) | `[]` (empty) |

Note the tail is **always present even when empty** (`sourcesImagesTail([], [])`) — the parser's
regexes look for the blocks unconditionally, so omitting them would leave the parser scanning the
answer body for a `<SOURCES>` that never comes. Always emit the tail.

---

## 2. Opening the stream — `writeStreamHeaders`

Centralized so the (subtle, Vercel-specific) header set + flush is byte-identical on every branch.
In [`index.ts`](../../../../backend/index.ts), `writeStreamHeaders(res, conversationId)`:

```ts
res.setHeader("x-conversation-id", conversationId);     // client reads it to bind the new chat
res.header("Cache-Control", "no-cache");
res.header("Content-Type", "text/event-stream");
res.setHeader("X-Accel-Buffering", "no");               // defeat proxy/LB buffering so tokens flow
res.flushHeaders?.();                                    // send headers NOW, before the first token
```

| Header | Why it is non-negotiable |
|---|---|
| `Content-Type: text/event-stream` | Marks the body as a stream, not a buffered JSON response; keeps intermediaries from waiting for EOF. |
| `X-Accel-Buffering: no` | nginx/Vercel/LB proxies buffer responses by default → the user sees nothing until the whole answer lands, killing the streaming UX. This header tells the proxy to pass bytes through. **The single most-forgotten header**; without it streaming "works locally, breaks on deploy." |
| `Cache-Control: no-cache` | A streamed, per-user answer must never be cached by an intermediary. |
| `x-conversation-id` | The server may have *created* the conversation this turn (new chat). The id is returned in a header — not the body — so the client can bind the URL/sidebar **before** the body finishes. Must be CORS-exposed: see §6. |
| `res.flushHeaders?.()` | Forces the status + headers out immediately so the browser starts reading; without it Express can hold them until the first `res.write`. Optional-chained because not every runtime defines it. |

> Despite `text/event-stream`, the body is **not** strict SSE — there are no `data:`/`event:`
> framing lines. It is a raw token stream the client reads chunk-by-chunk (§5). The content-type
> exists to disable buffering, not to invoke an `EventSource` parser. Do not switch the client to
> `EventSource`; it expects `data:` framing this stream does not send.

Order matters: `writeStreamHeaders` is called **after** all rejections (auth 401, validation 400,
rate-limit 429, conversation-not-found 404) so those can still return a clean JSON error with a real
status. Once headers are flushed you can only stream or abort — see the `headersSent` guard in §7.

---

## 3. The `<ANSWER>` / `<FOLLOW_UPS>` body — authored by the persona, not the code

The engine code never writes the `<ANSWER>` or `<FOLLOW_UPS>` tags — **the model does**, because
the persona instructs it to. From `PERSONA` in [`backend/prompt.ts`](../../../../backend/prompt.ts):

```
## Output protocol
Wrap the whole answer in <ANSWER>...</ANSWER>. After it, suggest exactly FIVE … follow-up questions:
<FOLLOW_UPS>
 <question>q1</question> … <question>q5</question>
</FOLLOW_UPS>
```

`FINANCE_PERSONA` carries the **same** output-protocol block, so both the Discover and finance
producers emit the same body markup. This is deliberate: the chat UI was built once for Discover and
renders finance answers unchanged. The Gmail assistant's `buildAssistantSystem()` does NOT include
the `<ANSWER>`/`<FOLLOW_UPS>` block — it streams plain markdown, and the parser still degrades
gracefully (it falls back to the raw body and emits no follow-up chips).

| Tag | Authored by | Required? | What the frontend does with it |
|---|---|---|---|
| `<ANSWER>…</ANSWER>` | LLM (persona) | yes (parser tolerates a missing close tag mid-stream) | unwraps → the rendered markdown answer |
| `<FOLLOW_UPS><question>…` | LLM (persona) | yes, exactly 5 | parsed into clickable suggested-question chips |
| `<SOURCES>` JSON | engine code (`sourcesImagesTail`) | yes (may be `[]`) | the numbered citation list `[n]` links to |
| `<IMAGES>` JSON | engine code (`sourcesImagesTail`) | yes (may be `[]`) | the image strip / gallery |

Because `<ANSWER>` and `<FOLLOW_UPS>` are *model output*, a weak model occasionally forgets the
close tag or the exact `<question>` shape. The parser is written defensively (§5) to degrade rather
than show nothing. If you change the protocol, change it in **both protocol-bearing personas**
(`PERSONA`, `FINANCE_PERSONA`) AND the parser in one commit, or a vertical breaks.

---

## 4. Streaming the body — the `textStream` loop

All three agentic/Discover producers share the same loop shape. From `streamFinanceAnswer` in
[`index.ts`](../../../../backend/index.ts):

```ts
const result = streamText({ model, system, messages, tools,
  stopWhen: stepCountIs(6),
  abortSignal: disconnectSignal(opts.res),   // §6 — stop burning tokens if the client leaves
  onStepFinish: (step) => { /* log tools used */ },
  onError: ({ error }) => console.error(...),  // streamText swallows mid-stream errors by default
});
let fullAnswer = "";
for await (const textPart of result.textStream) {
  fullAnswer += textPart;        // BUFFER — needed to persist + (Discover) cache the whole answer
  opts.res.write(textPart);      // FLUSH each delta to the client immediately
}
const tail = sourcesImagesTail(sources, []);  // §5 — built AFTER the stream, sources now populated
opts.res.write(tail);
return { fullAnswer, tail, finishReason };
```

Mechanics worth internalizing:

- **`result.textStream` yields only assistant *text* deltas** — tool calls/results are handled
  internally by the SDK's multi-step loop and never reach this iterator. So a finance turn that
  calls `getQuote` then writes prose only streams the prose; the tool round-trip is invisible on the
  wire. (The `sources[]` accumulator is the only way tool side-effects reach the tail.)
- **Buffer AND flush.** Writing `textPart` keeps the UI live; accumulating into `fullAnswer` lets you
  persist the turn (§7) and, on the Discover path, cache it. You need both copies.
- **The tail is appended after the loop**, never interleaved with tokens — the `financeWebSearch`
  `sources[]` array is only fully populated once the loop finishes, and the parser's regexes assume
  the answer body precedes the first `<SOURCES>` (§5).
- **`finishReason` is awaited in a try/catch** (`"error"` on throw). Only `finishReason === "stop"`
  with a non-empty answer is allowed into the semantic cache — never replay a truncated/aborted answer
  for the whole TTL.
- **`onError` is mandatory:** `streamText` swallows mid-stream provider errors by default, so without
  it a failed generation silently yields an empty stream. Log it.

The Discover miss path (`/perplexity_ask` step 6) is the same loop but feeds a pre-fetched search
context as the user message instead of tools; the cache-hit path skips the loop entirely and does two
`res.write`s (`cached.answer` then the tail).

---

## 5. The `<SOURCES>` / `<IMAGES>` tail — `sourcesImagesTail`

ONE string holds both blocks. From [`index.ts`](../../../../backend/index.ts):

```ts
function sourcesImagesTail(sources: unknown, images: unknown): string {
  return (
    `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n` +
    `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`
  );
}
```

The single most surprising detail: **the closing tag is the SAME token as the opening tag** —
`<SOURCES>…<SOURCES>`, not `<SOURCES>…</SOURCES>`. It is a delimiter pair, not XML. Both the
frontend parser and the `stripWireTail` compactor (in `conversation-compaction.md`) match on this
exact same-token shape; if you "fix" it to `</SOURCES>` you break both halves.

The newline framing (`\n<SOURCES>\n…\n<SOURCES>\n`) is also load-bearing — the frontend regexes
anchor on those exact newlines (§5b) so the JSON block can never be confused with a literal
`<SOURCES>` the model might emit inside the answer prose.

The **same tail string is written to the live stream AND persisted** with the assistant message
(§7). That is why reloading a conversation from history rebuilds its links + images for free: the
stored content is byte-identical to what streamed, and the same `parseStream` runs over both.

**Payload shapes** (what `JSON.stringify` writes):

| Block | Element shape | Source of truth |
|---|---|---|
| `<SOURCES>` | `{ title, url, content }` | `webSearch()` maps Tavily results in [`index.ts`](../../../../backend/index.ts); `Source` interface in [`api.ts`](../../../../frontend/src/lib/api.ts) |
| `<IMAGES>` | `{ url, description? }` | `webSearch()` normalizes bare-URL vs `{url,description}` Tavily images; `ImageResult` in [`api.ts`](../../../../frontend/src/lib/api.ts) |

### 5b. How the frontend parses it — `parseStream`

The client never waits for the stream to finish to render. `streamPost` reads the body with a
`getReader()` + `TextDecoder` loop and calls `parseStream(full)` on **every chunk** (it must be
idempotent and partial-safe). From [`frontend/src/lib/api.ts`](../../../../frontend/src/lib/api.ts):

```ts
const SOURCES_RE = /\n<SOURCES>\n([\s\S]*?)\n<SOURCES>\n/;   // same-token delimiters, newline-anchored
const IMAGES_RE  = /\n<IMAGES>\n([\s\S]*?)\n<IMAGES>\n/;

export function parseStream(full: string): ParsedAnswer {
  const sources = parseJsonArray<Source>(full.match(SOURCES_RE)?.[1]);   // [] until block fully arrives
  const images  = parseJsonArray<ImageResult>(full.match(IMAGES_RE)?.[1]);
  const answerRegion = full.split(/\n<(?:SOURCES|IMAGES)>\n/)[0] ?? full; // text before the first tail block
  const ansMatch = answerRegion.match(/<ANSWER>([\s\S]*?)(?:<\/ANSWER>|$)/i); // tolerate missing close tag
  let answer = ansMatch ? ansMatch[1] : answerRegion.split(/<FOLLOW_UPS>/i)[0];
  answer = answer.replace(/<\/?(?:ANSWER|FOLLOW_UPS)>/gi, "")
                 .replace(/<question>[\s\S]*?<\/question>/gi, "").trim();
  const followUps = [...answerRegion.matchAll(/<question>([\s\S]*?)<\/question>/gi)].map(m => m[1].trim());
  return { answer, followUps, sources, images };
}
```

The defensive design that makes mid-stream rendering work:

| Concern | How the parser handles it |
|---|---|
| JSON block still streaming in | `parseJsonArray` `try/catch`es → returns `[]` until the block is whole. No throw on partial JSON. |
| `</ANSWER>` not yet streamed | `(?:<\/ANSWER>|$)` matches up to end-of-buffer, so the partial answer renders live. |
| Model omitted `<ANSWER>` entirely | falls back to "everything before `<FOLLOW_UPS>`" as the answer. |
| `<FOLLOW_UPS>`/`<question>` leaking into the rendered answer | stripped from the answer string before render; questions are extracted separately. |
| Answer text accidentally containing `<SOURCES>` | the newline-anchored delimiters + "split on first tail block" make the real tail unambiguous. |

**Hard rule:** the wire format is a contract between `sourcesImagesTail`/the personas (backend) and
these four regexes (frontend). Change one side → change the other in the same commit, or answers
render blank / lose citations. There is no schema validation; the regexes ARE the schema.

---

## 6. `x-conversation-id` + CORS + abort-on-disconnect

Three streaming-adjacent concerns that bite if forgotten:

- **The id rides a header, so CORS must EXPOSE it.** The CORS block in
  [`index.ts`](../../../../backend/index.ts) sets
  `Access-Control-Expose-Headers: x-conversation-id` — without it the browser's `fetch` can read the
  *body* but `res.headers.get("x-conversation-id")` returns `null`, so a brand-new chat never binds
  its URL. (Express 5 + cors@2 don't reliably answer the OPTIONS preflight, so the headers are set
  by hand and preflight short-circuits with 204.)
- **The client reads the id before consuming the body** — `const conversationId = res.headers.get(...)`
  happens before the reader loop in `streamPost` ([`api.ts`](../../../../frontend/src/lib/api.ts)),
  because headers are available the instant `writeStreamHeaders` flushes.
- **Abort on disconnect** — `disconnectSignal(res)` returns an `AbortSignal` that fires on
  `res.on("close")` when `!res.writableFinished`, threaded into `streamText`'s `abortSignal`. A user
  who closes the tab stops burning tokens (and, for finance, vendor credits). **Do not** thread this
  signal into a *shared/de-duped* cache fetcher — one caller's disconnect must not abort the in-flight
  fetch other callers are awaiting (see `hooks-and-guardrails.md`).

---

## 7. Persist BEFORE `res.end()` — the Vercel freeze

The most consequential ordering rule in the whole engine. On Vercel the function instance can freeze
the instant the response closes, so **any DB write scheduled after `res.end()` may never run.** Every
branch therefore does: stream tokens → `res.write(tail)` → `await persistTurns(...)` → `res.end()`.

```ts
// every branch of /perplexity_ask and /perplexity_ask/follow_up:
const tail = sourcesImagesTail(sources, images);
res.write(tail);
await persistTurns(persistUserTurn, conversation.id, fullAnswer, tail);  // BEFORE end()
if (cacheable && finishReason === "stop" && fullAnswer.trim())           // Discover only
  await cacheAnswer({ ... });
res.end();
```

`persistTurns` ([`index.ts`](../../../../backend/index.ts)) awaits the user-turn write first (so its
autoincrement id stays below the assistant turn's, preserving order), then stores
`fullAnswer + tail` — or an `EMPTY_ANSWER_PLACEHOLDER` if the model produced no prose, so the thread
never dangles and the user/assistant alternation that compaction + Anthropic require stays intact.

**Persisting `fullAnswer + tail` (not just the answer)** is what makes a reloaded conversation
identical to the live one — the stored string runs back through the same `parseStream`. This is also
why compaction must `stripWireTail` before re-sending history to the model (see
`conversation-compaction.md`): the persisted content deliberately carries UI markup the LLM should
never see as context.

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Forgetting `X-Accel-Buffering: no` ("streams locally, buffers on deploy"). | Always open with `writeStreamHeaders`; never hand-roll headers per branch. |
| Hand-writing the SSE headers or emitting a different wire shape per vertical. | One `writeStreamHeaders` + one `sourcesImagesTail` so the frontend parses every vertical identically. |
| "Fixing" `<SOURCES>…<SOURCES>` to a proper closing `</SOURCES>`. | Keep the same-token delimiter pair — the parser regexes + `stripWireTail` both match it; XML-izing breaks both. |
| Dropping the empty `<SOURCES>`/`<IMAGES>` tail when there are no sources. | Always emit `sourcesImagesTail([], [])`; the parser scans for the blocks unconditionally. |
| Interleaving the tail with tokens, or building it before the loop. | Build + write the tail AFTER the `textStream` loop, once `sources[]` is fully populated. |
| Switching the client to `EventSource`. | The body has no `data:` framing — keep the raw `getReader()` + `TextDecoder` loop. |
| Returning the conversation id in the body. | Put it in `x-conversation-id` AND expose it via `Access-Control-Expose-Headers`. |
| Persisting (or caching) the turn AFTER `res.end()`. | `await persistTurns(...)` (and `cacheAnswer`) BEFORE `res.end()` — Vercel freezes on close. |
| Caching a truncated/aborted answer. | Cache only when `finishReason === "stop"` and `fullAnswer.trim()` is non-empty. |
| Authoring `<ANSWER>`/`<FOLLOW_UPS>` in code, or changing the protocol in one persona. | The model authors that markup via the persona; change BOTH protocol-bearing personas (`PERSONA`, `FINANCE_PERSONA`) + the parser in one commit. |
| Threading the disconnect `AbortSignal` into a shared cache fetcher. | Cancel at the `streamText` level only; never abort an in-flight de-duped fetch other callers share. |
| Omitting `onError` on `streamText`. | Always pass `onError` — the SDK swallows mid-stream provider errors, yielding a silent empty stream. |

---

## 9. Checklist — a new/changed streaming branch is "done" when

1. It opens with `writeStreamHeaders(res, conversationId)` (after all error short-circuits), never
   hand-rolled headers.
2. It streams via the `for await (textPart of result.textStream)` loop, buffering into `fullAnswer`
   AND `res.write`-ing each delta; `onError` + `abortSignal: disconnectSignal(res)` are set.
3. It writes the tail via `sourcesImagesTail(...)` (even if `[], []`) **after** the loop.
4. If the body needs `<ANSWER>`/`<FOLLOW_UPS>`, the system prompt carries the output-protocol block
   (reuse `PERSONA`/`FINANCE_PERSONA` rather than inventing a new shape).
5. `await persistTurns(...)` runs BEFORE `res.end()`; only a clean (`finishReason === "stop"`,
   non-empty) Discover answer is cached.
6. The new shape parses through the existing `parseStream` regexes in
   [`api.ts`](../../../../frontend/src/lib/api.ts) unchanged — or the parser was updated in the same
   commit.
7. Verified end-to-end: tokens appear incrementally in the browser (not all at once → buffering
   header missing), citations/images render, and a reload of the conversation looks identical to the
   live stream.
