# Streaming Chat Rendering — consuming the stream, parsing the wire tail, rendering the answer

> How Lumina turns a raw SSE byte stream into a live answer, a sources list, an image grid, and
> follow-up chips — by accumulating the running buffer and re-parsing the **exact** wire protocol on
> every chunk. `lumina-` ref = THIS codebase; cite the live file before you change it (line numbers
> drift). Read this when working on [`chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx)
> or `parseStream` in [`lib/api.ts`](../../../../frontend/src/lib/api.ts). Adjacent refs:
> **lumina-frontend-architecture.md** owns the `Dashboard.handleAsk`→`runTurn` flow that *feeds* the
> buffer; **api-client-and-config.md** owns the `streamPost` fetch/reader plumbing; the **ai-sdk-agent**
> skill owns the **producer** side — the backend that emits `<ANSWER>`/`<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>`.
> This skill **consumes** that contract; change them in lockstep.

Files: [`frontend/src/components/chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx),
[`frontend/src/lib/api.ts`](../../../../frontend/src/lib/api.ts),
`runTurn` in [`frontend/src/pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx).

---

## 1. The data flow, end to end

```
streamPost (api.ts)                 // reader loop — accumulates, never line-splits
  └─ res.body.getReader()
  └─ for(;;) read() → full += decode(value,{stream:true}) → opts.onChunk(full)
        │                          (full = entire buffer so far, NOT a delta)
        ▼
runTurn.onChunk (Dashboard.tsx)     // updates ONE Turn's `full` by id
  └─ setTurns(prev => prev.map(t => t.id===id ? {...t, full} : t))
        │
        ▼
ChatView (chat-view.tsx)            // re-renders on every setTurns
  └─ parsedTurns = turns.map(t => ({ turn, parsed: parseStream(t.full) }))
        │                          // parseStream runs PER TURN, PER CHUNK
        ▼
  parseStream (api.ts)             // pulls {answer, followUps, sources, images} from the buffer
  └─ AnswerTab / LinksTab / ImagesTab render the parsed pieces
```

The contract that makes this work: **`onChunk` always carries the full buffer**, not an incremental
delta — see `streamPost` (`full += decoder.decode(...)` then `opts.onChunk(full)`) in
[`api.ts`](../../../../frontend/src/lib/api.ts). So the component is a pure function of `turn.full`;
React re-renders, `parseStream` re-runs, the markdown grows. No manual diffing, no token queue.

---

## 2. The wire protocol (what the buffer looks like over time)

The backend streams **answer text first** (which itself contains the system-prompt protocol tags),
then appends two JSON tails after the text stream finishes:

```
<ANSWER>
…markdown answer with inline [1] [2] citations…
</ANSWER>
<FOLLOW_UPS>
<question>First suggested follow-up?</question>
<question>Second suggested follow-up?</question>
</FOLLOW_UPS>
\n<SOURCES>\n[{"title":"…","url":"https://…","content":"…"}]\n<SOURCES>\n
\n<IMAGES>\n[{"url":"https://…","description":"…"}]\n<IMAGES>\n
```

| Region | Delimiter | Parsed into | Notes |
|--------|-----------|-------------|-------|
| Answer | `<ANSWER>…</ANSWER>` (or text before first `<FOLLOW_UPS>`/tail) | `answer: string` | Markdown; arrives token-by-token |
| Follow-ups | `<question>…</question>` repeated, inside `<FOLLOW_UPS>` | `followUps: string[]` | Only meaningful once the turn is `done` |
| Sources | `\n<SOURCES>\n` … `\n<SOURCES>\n` (open == close) | `sources: Source[]` | One JSON array; appended after text |
| Images | `\n<IMAGES>\n` … `\n<IMAGES>\n` (open == close) | `images: ImageResult[]` | One JSON array; appended after text |

**Critical delimiter quirk:** the SOURCES/IMAGES fences use the **same** tag to open and close
(`\n<SOURCES>\n …json… \n<SOURCES>\n`), not `<SOURCES>`/`</SOURCES>`. The regexes are
non-greedy specifically to grab the content between the first matched pair —
`SOURCES_RE = /\n<SOURCES>\n([\s\S]*?)\n<SOURCES>\n/` and the IMAGES analogue, in
[`api.ts`](../../../../frontend/src/lib/api.ts). If the backend ever switches to a closing-tag form,
these regexes break silently (sources just stop appearing). This is the lockstep rule: the producer
and `parseStream` define ONE format together.

---

## 3. `parseStream` — the single source of truth

Defined in [`api.ts`](../../../../frontend/src/lib/api.ts), `parseStream(full)`. The whole point is
that it is **safe to call on a partial buffer on every chunk**. How each guarantee is met:

| Goal | Mechanism (in `parseStream`) |
|------|------------------------------|
| Half-streamed JSON must not throw | `parseJsonArray` wraps `JSON.parse` in try/catch → returns `[]` on incomplete JSON ("block still streaming in — ignore until complete") |
| Answer must show before the tail arrives | `answerRegion = full.split(/\n<(?:SOURCES\|IMAGES)>\n/)[0]` — everything **before** the first fence |
| Tolerate present OR absent `<ANSWER>` tags | Try `/<ANSWER>([\s\S]*?)(?:<\/ANSWER>\|$)/i`; else fall back to `answerRegion` up to `<FOLLOW_UPS>`. The `$` alternative matches a still-open `<ANSWER>` (no close yet) so text renders mid-stream |
| No protocol tags leak into the UI | `.replace(/<\/?(?:ANSWER\|FOLLOW_UPS)>/gi, "")` + strip `<question>…</question>` from the answer, then `.trim()` |
| Follow-ups extracted cleanly | `[...answerRegion.matchAll(/<question>([\s\S]*?)<\/question>/gi)]` → trim → `filter(Boolean)` |

Return shape is `ParsedAnswer { answer, followUps, sources, images }`. Note follow-ups are pulled from
`answerRegion` (the pre-tail text), because they live inside `<FOLLOW_UPS>` which precedes the JSON
fences.

**Why split-then-match instead of one big regex:** the answer region must be defined as "before the
first fence" so that a partially-arrived `<SOURCES>` block (opened but JSON not complete) never bleeds
into the rendered answer. Splitting on the fence is robust to a half-written JSON array in a way a
single answer regex would not be.

---

## 4. Incremental markdown rendering

The answer renders through the `Markdown` component in
[`chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx): `ReactMarkdown` + `remarkGfm`
(tables, strikethrough, task lists), styled with Tailwind Typography (`prose prose-sm … dark:prose-invert`).

Because `parsed.answer` is re-parsed and re-rendered on **every** chunk, ReactMarkdown re-parses the
growing string each time. This is acceptable at answer length; do **not** try to "append only the new
tokens" — markdown is not append-safe (a mid-stream `**bold` would render wrong until the closing `**`
arrives, and the next render fixes it anyway). Let the full re-render handle it.

### Inline `[n]` citation linkify

`linkifyCitations(markdown, sources)` in [`chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx)
rewrites bare `[1]`/`[2]` into markdown links **before** handing the string to ReactMarkdown:

```ts
markdown.replace(/\[(\d+)\](?!\()/g, (match, num) => {
  const src = sources[Number(num) - 1];      // 1-indexed → 0-indexed array
  return src ? `[[${num}]](${src.url})` : match;
});
```

Three load-bearing details:
- **`(?!\()` negative lookahead** — skips `[1](…)` that is *already* a link, so re-linkifying a
  re-rendered buffer is idempotent (never double-wraps).
- **`sources[Number(num) - 1]`** — the model emits 1-based `[1]` but the array is 0-based.
- **Out-of-range citation falls back to `match`** — a `[9]` with only 5 sources renders as plain text,
  not a broken link. This matters mid-stream: sources arrive in the tail *after* the text, so during
  streaming `sources` may be `[]` and every `[n]` stays literal until the tail lands — then the next
  render linkifies them. (`if (sources.length === 0) return markdown` short-circuits that case.)

All anchors render with `target="_blank" rel="noopener noreferrer"` via the `a` component override.

### Streaming cursor

While `turn.status === "streaming"`, `AnswerTab` appends a pulsing block caret after the markdown
(`<span className="… animate-pulse bg-foreground/60 …" />`). It disappears on `done`/`error`.

---

## 5. The three tabs — one parse, three views

`ChatView` parses once and routes by `activeTab: "answer" | "links" | "images"` (the `ChatTab` type).
Sources and images are **aggregated across all turns** in the conversation and de-duped, so the Links
and Images tabs show everything cited so far:

```ts
const parsedTurns = turns.map((turn) => ({ turn, parsed: parseStream(turn.full) }));
const sources = dedupeByUrl(parsedTurns.flatMap((t) => t.parsed.sources));
const images  = dedupeByUrl(parsedTurns.flatMap((t) => t.parsed.images));
```

| Tab | Component | Source data | Rendering notes |
|-----|-----------|-------------|-----------------|
| `answer` | `AnswerTab` | per-turn `parsed` | Q bubble (right) + top-5 source chips + markdown + cursor; follow-ups under a `Related` divider |
| `links` | `LinksTab` | conversation-wide `sources` | favicon + hostname + title + 2-line `line-clamp` snippet (`content`) |
| `images` | `ImagesTab` | conversation-wide `images` | responsive 2/3-col grid, `loading="lazy"` |

`dedupeByUrl` (a `Set<string>` over `item.url`) keeps the first occurrence — see `chat-view.tsx`. The
answer tab instead shows only the **current turn's** first 5 sources as inline chips (it slices
`parsed.sources.slice(0, 5)`), giving the Lumina-style "answer with its sources right above it."

### Follow-up chips (gating)

Follow-ups render only when the **last** turn is `done`:

```ts
const followUps = lastTurn?.status === "done"
  ? (parsedTurns[parsedTurns.length - 1]?.parsed.followUps ?? [])
  : [];
```

Gating on `done` avoids flashing half-parsed `<question>` fragments while text is still streaming.
Each chip calls `onFollowUp(q)` → which flows back to `Dashboard.runTurn` as a new follow-up turn.

---

## 6. Turn lifecycle & rendering states

A `Turn` ([`chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx)) is
`{ id, question, full, status: "streaming" | "done" | "error", error? }`. `runTurn`
([`Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx)) seeds it with empty `full` +
`"streaming"`, updates `full` on each `onChunk`, then flips to `"done"` or `"error"` at the end.

`AnswerTab` renders three mutually-exclusive states per turn:

| Condition | UI |
|-----------|-----|
| `status === "error"` | red bordered box with `turn.error ?? "Something went wrong."` |
| `status === "streaming" && !parsed.answer` (`showSpinner`) | spinner + "Searching the web…" — the pre-first-token gap (model still calling tools / searching) |
| otherwise | source chips + `<Markdown>` + (streaming) cursor |

The `showSpinner` check is `streaming && !parsed.answer` — once the **first** answer token lands,
`parsed.answer` is truthy and the spinner is replaced by streaming text. This is why the spinner only
shows during the "thinking before first token" window, which for the finance/research verticals is the
tool-call round-trips.

---

## 7. The follow-up composer

`ChatView` owns a docked composer (always visible, bottom of the pane) with local `value` +
`attachments` state. `submit()` guards on `!trimmed || busy`, calls
`onFollowUp(trimmed, attachments)`, then clears both. Enter submits, Shift+Enter newlines
(the `onKeyDown` handler). It reuses `AttachButton`/`AttachmentPreviews` (capped at `MAX_ATTACHMENTS`)
and `MicButton` — see **composer-and-attachments.md** for those. The send button shows
`Loader2` (spin) while `busy`, else `ArrowUp`.

---

## 8. Decision framework — adding/changing rendering behavior

```
What are you changing?
|
+-- Backend added/renamed a wire tag or changed a delimiter
|     → update parseStream + SOURCES_RE/IMAGES_RE in api.ts IN THE SAME PR as the backend.
|       Verify on a PARTIAL buffer (mid-stream), not just a finished one.
|
+-- New structured payload (e.g. <CHARTS>) the answer should render
|     → add a CHARTS_RE + parseJsonArray field to ParsedAnswer; render in a new tab/section.
|       Define open==close fence vs closing-tag form to MATCH the backend exactly.
|
+-- New inline annotation in the answer text (e.g. [[note]])
|     → add a transform like linkifyCitations, BEFORE ReactMarkdown, idempotent (lookahead guard).
|
+-- Change how sources/images are shown
|     → they're already parsed; touch LinksTab/ImagesTab/AnswerTab chips only. Keep dedupeByUrl.
|
+-- Change streaming/loading UX
|     → it's driven by turn.status + parsed.answer; adjust the showSpinner/cursor branches.
|
+-- "The component re-renders too much / markdown re-parses every chunk"
      → that's by design and fine at answer length. Do NOT cache by appending deltas
        (markdown isn't append-safe). Memoize only if profiling proves a problem.
```

---

## 9. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Treating `onChunk(full)` as a delta and concatenating it yourself. | `full` is the **entire** buffer each call; just store it on the turn and re-parse. |
| Hand-rolling stream parsing inside the component, divergent from the backend format. | One source of truth: `parseStream` in `api.ts`; change it in lockstep with the producer. |
| Letting a mid-stream partial `<SOURCES>` JSON block throw. | `parseJsonArray` returns `[]` on incomplete JSON; answer = region before the first fence. |
| Assuming `<SOURCES>` closes with `</SOURCES>`. | The fence opens and closes with the **same** `\n<SOURCES>\n` token — keep the non-greedy regex. |
| Rendering follow-ups while the turn is still streaming. | Gate on `lastTurn?.status === "done"` so half-parsed `<question>` never flashes. |
| Linkifying `[n]` with a plain `\[(\d+)\]` (re-wraps existing links on re-render). | Keep the `(?!\()` lookahead so the idempotent re-render doesn't double-wrap. |
| Using `[n]` as a 0-based index. | The model is 1-based: `sources[Number(num) - 1]`; out-of-range falls back to literal text. |
| `dangerouslySetInnerHTML` for the answer. | Use `ReactMarkdown` + `remarkGfm`; anchors get `rel="noopener noreferrer" target="_blank"`. |
| Splitting the stream on `\n` like classic SSE `data:` lines. | This stream is raw text, not `event:`/`data:` SSE — accumulate bytes; never line-split. |
| Showing the spinner whenever `streaming`. | Gate it `streaming && !parsed.answer` so it yields to text on the first token. |
| Letting a broken favicon/image leave a gap. | `onError` hides the favicon (`visibility:hidden`) or removes the image's anchor (`display:none`). |

---

## 10. Verify it works (the "done" check)

1. **Live stream:** a real ask streams text token-by-token with the pulsing cursor; the spinner shows
   only before the first token.
2. **Tail lands:** after text completes, source chips appear above the answer and `[n]` citations turn
   into links pointing at the right URLs.
3. **Tabs:** Links shows favicon + snippet rows; Images shows a lazy grid; both de-duped across turns.
4. **Follow-ups:** chips appear only once the turn is `done`; clicking one starts a new turn.
5. **Partial-safety:** mid-stream there are no thrown errors and no leaked `<ANSWER>`/`<SOURCES>`/
   `<question>` tags in the rendered answer.
6. **Lockstep:** if you touched a wire tag, `parseStream` + the backend producer changed together;
   confirm against the **ai-sdk-agent** producer (`<SOURCES>` tail emission in
   [`backend/index.ts`](../../../../backend/index.ts)).
