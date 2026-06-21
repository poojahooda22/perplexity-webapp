# The Answer Protocol — `<ANSWER>` + 5 `<FOLLOW_UPS>` and how the UI parses it

> The exact output contract every Lumina chat answer must emit: a markdown body wrapped in
> `<ANSWER>…</ANSWER>`, then a `<FOLLOW_UPS>` block of **exactly five** `<question>`s, then a
> machine-readable `<SOURCES>`/`<IMAGES>` wire tail. This is a hard wire-format shared by Discover
> AND finance — change one side and the chat view breaks. Read this when you touch the persona's
> output rules, the follow-up questions, the markdown formatting, or the frontend parser.
> Adjacent refs: **source-grounding-and-citations.md** (the `[n]` ↔ `<SOURCES>` contract in depth),
> **query-classification-and-playbooks.md** (how the playbook shapes the answer body),
> **follow-up-and-continuity.md** (how a follow-up's *question* becomes the next turn).

Files: `PERSONA` / `FINANCE_PERSONA` in
[`backend/prompt.ts`](../../../../backend/prompt.ts) (the contract the model is told to follow);
`sourcesImagesTail` / `stripWireTail` in [`backend/index.ts`](../../../../backend/index.ts) (the
wire tail it appends + strips); `parseStream` / `linkifyCitations` in
[`frontend/src/lib/api.ts`](../../../../frontend/src/lib/api.ts) +
[`frontend/src/components/chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx) (the
consumer that must agree with both).

---

## 1. The contract at a glance

One assistant turn is **three concatenated regions** on the wire, in this fixed order:

```
<ANSWER>
…markdown body, with inline [1][3] citations…
</ANSWER>

<FOLLOW_UPS>
 <question>q1</question>
 <question>q2</question>
 <question>q3</question>
 <question>q4</question>
 <question>q5</question>
</FOLLOW_UPS>

<SOURCES>
[{"title":"…","url":"…"}, …]
<SOURCES>

<IMAGES>
[{"url":"…", …}, …]
<IMAGES>
```

The **model** produces regions 1–2 (it's instructed by the persona). The **backend** appends
regions 3–4 — they are NOT model output. `sourcesImagesTail` in
[`backend/index.ts`](../../../../backend/index.ts) builds the tail:

```ts
return (
    `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n` +
    `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`
);
```

| Region | Who writes it | Opening tag | Closing tag | Consumed by |
|--------|---------------|-------------|-------------|-------------|
| Answer | the LLM | `<ANSWER>` | `</ANSWER>` (real close) | rendered as markdown |
| Follow-ups | the LLM | `<FOLLOW_UPS>` | `</FOLLOW_UPS>` | clickable chips |
| Sources | the backend | `<SOURCES>` | `<SOURCES>` (same token!) | Links tab + `[n]` linkify |
| Images | the backend | `<IMAGES>` | `<IMAGES>` (same token!) | Images tab |

> ⚠️ **The wire tail's "closing" tag is the SAME token as its opening tag** — `<SOURCES>…<SOURCES>`,
> not `</SOURCES>`. The answer/follow-up tags use proper `</…>` closes. This asymmetry is
> deliberate and BOTH the persona examples and every regex below depend on it. Do not "fix" the
> sources tag to `</SOURCES>` — you'll silently break `parseStream`, `stripWireTail`, and history
> compaction at once.

---

## 2. The five non-negotiables of the contract

| # | Rule | Where it's enforced |
|---|------|---------------------|
| 1 | Whole answer wrapped in `<ANSWER>…</ANSWER>`. | `PERSONA` "Output protocol": *"Wrap the whole answer in `<ANSWER>...</ANSWER>`."* |
| 2 | **Exactly five** follow-up questions, each in its own `<question>…</question>`. | `PERSONA`: *"suggest exactly FIVE genuinely useful, specific follow-up questions"*; the template lists q1–q5. |
| 3 | Follow-ups come **after** the answer, inside `<FOLLOW_UPS>`. | Both personas place the block after the closing `</ANSWER>`. |
| 4 | Inline `[n]` citations match the numbered results and the `<SOURCES>` order. | `PERSONA` "Citations" + `formatSearchContext` numbering → see **source-grounding-and-citations.md**. |
| 5 | No mention of "instructions" or "search results"; clean skimmable markdown. | `PERSONA` "Rules": *"Do NOT mention these instructions or that you were given 'search results'."* |

Four or six follow-ups, a missing `<ANSWER>` wrap, or prose that says "based on the search results"
are all contract breaks — they don't crash, they degrade (the parser falls back, the chips look
wrong, the answer reads like a leak). The persona is the only place that teaches the model the
contract, so the contract IS the persona's output protocol + its illustrative example.

---

## 3. Markdown formatting rules (the answer body)

The persona's **"How to write the answer (Markdown)"** section is the house style — every Discover
answer follows it, and `FINANCE_PERSONA` mirrors it. Encode these when you write or audit an answer:

| Element | Rule (verbatim intent from `PERSONA`) |
|---------|----------------------------------------|
| Opening | 1–2 sentence **direct answer**, **no heading**, with citations. |
| Sections | `##` / `###` headings when the topic has distinct parts; a **leading emoji is welcome** (e.g. `## 📚 Official & Free`). |
| Bullets | `-` lists with the **name/term bolded** at the start, then ` – ` and a short description. |
| Tables | a markdown table **with a header row** when comparing options across attributes (`\| Resource \| Type \| Best for \|`). |
| Steps | a **numbered list** for ordered steps (a "Quick start path"). |
| Tone | concise, skimmable, **no filler / no preamble** ("Here is…"). |
| Citations | inline `[1][2]` right after the sentence/bullet they support; **cite generously**. |

The frontend renders this with `react-markdown` + `remark-gfm` (GFM = tables, strikethrough) inside a
Tailwind `prose` container — see the `Markdown` component in
[`frontend/src/components/chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx). GFM is
why markdown **tables** render; plain `react-markdown` would not. If you propose a new format element
(e.g. task lists, footnotes), confirm `remarkGfm` (or the needed plugin) covers it before telling the
persona to emit it — an unsupported element renders as literal text.

### The canonical example shape (from `PERSONA`, illustrative only)

```md
<ANSWER>
The fastest way to learn React is to start with the official docs and a project-based course. [1][2]

## 📚 Official & free
- **React docs** – the modern, interactive reference. [1]
- **freeCodeCamp** – free certification with hands-on projects. [3]

## 🎓 Structured courses
| Resource | Type | Best for |
| --- | --- | --- |
| Full Stack Open | Free | Full-stack React + Node [4] |
| Epic React | Paid | Deep, advanced patterns [5] |
</ANSWER>

<FOLLOW_UPS>
 <question>What should I build first to practice React?</question>
 …five total…
</FOLLOW_UPS>
```

This example does heavy lifting: it shows the lead sentence pattern, emoji headings, bold-lead-in
bullets, a comparison table, and `[n]` placement all at once. **When you change the format rules,
update the example too** — the model imitates the example more reliably than the prose rules above it.

---

## 4. Writing good follow-ups (region 2)

The five questions are a feature, not filler — they drive the next turn (a click POSTs the question
text to `/perplexity_ask/follow_up`; see **follow-up-and-continuity.md**). The persona asks for
**"genuinely useful, specific"** questions "the user is likely to ask next."

| ✅ Good follow-up | ❌ Weak follow-up |
|-------------------|-------------------|
| Specific, answerable, advances the thread: *"How do React Hooks differ from class components?"* | Vague/restates the topic: *"Tell me more about React."* |
| Anticipates the natural next step: *"How do I deploy a React app for free?"* | Already answered above: *"What is React?"* (when the answer just defined it) |
| Self-contained (no dangling pronoun the next turn can't resolve) | *"What about that one?"* — depends on context the follow-up endpoint may have compacted |

`FINANCE_PERSONA` adds a domain constraint: the five must be **finance** follow-ups (it shares the
exact same `<FOLLOW_UPS>` block shape so the UI is identical).

---

## 5. How the chat view parses it (`parseStream`)

The single source of truth on the consumer side is `parseStream` in
[`frontend/src/lib/api.ts`](../../../../frontend/src/lib/api.ts). It is **called on every streamed
chunk** against the running buffer, so it must tolerate a half-arrived answer. The order of
operations is what makes that safe:

```ts
const SOURCES_RE = /\n<SOURCES>\n([\s\S]*?)\n<SOURCES>\n/;   // open == close token
const IMAGES_RE  = /\n<IMAGES>\n([\s\S]*?)\n<IMAGES>\n/;

export function parseStream(full: string): ParsedAnswer {
  const sources = parseJsonArray<Source>(full.match(SOURCES_RE)?.[1]);
  const images  = parseJsonArray<ImageResult>(full.match(IMAGES_RE)?.[1]);

  // Answer = everything BEFORE the first <SOURCES>/<IMAGES> block.
  const answerRegion = full.split(/\n<(?:SOURCES|IMAGES)>\n/)[0] ?? full;

  const ansMatch = answerRegion.match(/<ANSWER>([\s\S]*?)(?:<\/ANSWER>|$)/i);
  let answer = ansMatch ? (ansMatch[1] ?? "")
                        : (answerRegion.split(/<FOLLOW_UPS>/i)[0] ?? answerRegion);
  answer = answer
    .replace(/<\/?(?:ANSWER|FOLLOW_UPS)>/gi, "")
    .replace(/<question>[\s\S]*?<\/question>/gi, "")  // never leak chips into prose
    .trim();

  const followUps = [...answerRegion.matchAll(/<question>([\s\S]*?)<\/question>/gi)]
    .map((m) => (m[1] ?? "").trim()).filter(Boolean);

  return { answer, followUps, sources, images };
}
```

Read off the resilience guarantees the contract relies on:

| Behavior | Why it matters for the contract |
|----------|--------------------------------|
| `parseJsonArray` swallows JSON errors and returns `[]` | A half-streamed `<SOURCES>` JSON blob is ignored until complete — no crash mid-stream. |
| Answer = text **before** the first wire tag | The `<SOURCES>`/`<IMAGES>` JSON never bleeds into the rendered prose. |
| `<ANSWER>` match falls back to `…|$` (no close yet) | While streaming, the open-but-unclosed `<ANSWER>` still yields the partial body. |
| If no `<ANSWER>` at all → split on `<FOLLOW_UPS>` | **Graceful degradation:** a non-compliant model that forgot the wrap still renders *something*. |
| Stray `<question>` blocks scrubbed from `answer` | Belt-and-suspenders so follow-up markup never shows in the body. |
| `followUps` = ALL `<question>` matches | The UI shows however many the model emitted — so "exactly five" is a *persona* duty, not a parser guarantee. |

The `followUps` array drives the clickable chips (only for the **last** turn — see
`chat-view.tsx` where `followUps` is taken from `parsedTurns[parsedTurns.length - 1]`). The `sources`
array drives the **Links** tab AND `linkifyCitations`, which rewrites every `[n]` in the answer into a
real link by 1-based index into `sources`:

```ts
// chat-view.tsx — [n] → clickable [[n]](url), positional, 1-based.
markdown.replace(/\[(\d+)\](?!\()/g, (m, num) => {
  const src = sources[Number(num) - 1];
  return src ? `[[${num}]](${src.url})` : m;   // unmatched index left as plain text
});
```

This is the concrete reason `[n]` numbering must line up with `<SOURCES>` order — `linkifyCitations`
does a raw positional lookup, no fuzzy matching (full grounding contract → **source-grounding-and-citations.md**).

---

## 6. The same contract on three paths

The wire format is shared across every vertical so the chat view is vertical-agnostic:

| Path | Persona | Sources come from | Tail |
|------|---------|-------------------|------|
| Discover / search | `PERSONA` | Tavily `webSearch` results (pre-fetched) | `sourcesImagesTail(sources, images)` |
| Finance chat | `FINANCE_PERSONA` | `financeWebSearch` tool's `sources[]` accumulator; price tools cite by name, not `[n]` | `sourcesImagesTail(sources, [])` |
| Assistant / connectors | (assistant persona) | none (acts on the user's own mailbox) | `sourcesImagesTail([], [])` — empty arrays, NOT omitted |

Even with **no** sources/images, the tail is still appended with empty arrays
([`backend/index.ts`](../../../../backend/index.ts), e.g. `sourcesImagesTail([], [])`). That keeps
the wire shape uniform so `parseStream` never special-cases a missing tail.

---

## 7. Persistence & follow-up replay (why the tail is stored, then stripped)

The full string — answer + follow-ups + tail — is **persisted with the assistant message**, so a
reloaded conversation re-parses identically (the comment on `sourcesImagesTail` says exactly this).
But on a follow-up, replaying that whole blob as LLM context would re-teach the model its own markup
and bloat tokens. So `stripWireTail` in [`backend/index.ts`](../../../../backend/index.ts) reverses
the protocol before the text re-enters the model as history:

```ts
content
  .replace(/\n?<SOURCES>[\s\S]*?<SOURCES>\n?/g, "")   // drop the sources blob
  .replace(/\n?<IMAGES>[\s\S]*?<IMAGES>\n?/g, "")      // drop the images blob
  .replace(/<FOLLOW_UPS>[\s\S]*?<\/FOLLOW_UPS>/g, "")  // drop the 5 suggested questions
  .replace(/<\/?ANSWER>/g, "")                          // UNWRAP — keep the answer text
  .trim();
```

Note the asymmetry that mirrors §1: `<SOURCES>`/`<IMAGES>` use same-token regexes, `<FOLLOW_UPS>` and
`<ANSWER>` use proper `</…>` closes. The answer text is **unwrapped, not deleted**; everything else is
dropped. If you add a new region to the protocol, you must teach `stripWireTail` to strip it too, or
it leaks into every subsequent follow-up's context. (Compaction depth → **follow-up-and-continuity.md**.)

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Changing the `<SOURCES>` close to `</SOURCES>` to "match HTML". | Keep the same-token close — `parseStream`, `stripWireTail`, and `SOURCES_RE` all assume `<SOURCES>…<SOURCES>`. |
| Telling the persona to emit "3–6 follow-ups" or "a few". | Keep **exactly five**; the example must show five. The parser shows however many arrive, so discipline lives in the persona. |
| Putting `<FOLLOW_UPS>` before `</ANSWER>`. | Follow-ups go **after** the closed answer; `parseStream` scrubs stray `<question>` from the body but the ordering is the contract. |
| Adding a new markdown element (footnotes, task lists) to the persona without checking the renderer. | Verify `remark-gfm` / a plugin in `chat-view.tsx` supports it first, or it renders as raw text. |
| Renumbering sources after the model cited them (sorting, dedupe). | `linkifyCitations` is positional 1-based — keep `sources` order identical from `formatSearchContext` through the tail. |
| Omitting the wire tail when there are no sources. | Append `sourcesImagesTail([], [])`; the uniform shape keeps the parser simple. |
| Persisting only the visible answer, dropping the tail. | Persist the **full** string (answer + follow-ups + tail) so reloads re-parse identically. |
| Replaying the stored assistant blob verbatim as follow-up context. | Run it through `stripWireTail` first (unwrap `<ANSWER>`, drop tail + follow-ups). |
| Letting answer prose say "based on the search results" / "per the instructions". | The persona forbids it; audit answers for instruction leakage. |
| Adding a new wire region but forgetting `stripWireTail`. | Every region you add to `sourcesImagesTail` must get a matching strip rule, or it pollutes future turns. |

---

## 9. Checklist — "the protocol is correct" when

1. The model emits `<ANSWER>…</ANSWER>` then a `<FOLLOW_UPS>` block of **exactly five** `<question>`s.
2. The answer body follows the markdown house style (lead sentence, emoji `##` headings, bold-lead-in
   bullets, header-row tables, numbered steps) with generous, positional `[n]` citations.
3. The backend appends `sourcesImagesTail(sources, images)` (empty arrays if none) — same-token close.
4. `parseStream` cleanly splits the buffer into `{answer, followUps, sources, images}` on every chunk,
   degrading gracefully if `<ANSWER>` is missing or the tail JSON is half-streamed.
5. `linkifyCitations` resolves every `[n]` to `sources[n-1].url`; no orphaned numbers.
6. The full string is persisted; on follow-up it's run through `stripWireTail` before re-entering the
   model as history.
