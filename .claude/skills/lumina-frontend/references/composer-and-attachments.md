# Composer & Attachments — the input surface, file by file

> The complete input surface Lumina puts under every chat: the [`SearchHero`](../../../../frontend/src/components/search-hero.tsx)
> composer (textarea → `submit` → `onSubmit` → Dashboard `handleAsk`), [`attachments.tsx`](../../../../frontend/src/components/attachments.tsx)
> (File → base64 `Attachment`, image vs file preview), the placeholder [`MicButton`](../../../../frontend/src/components/mic-button.tsx),
> and the [`ModelMenu`](../../../../frontend/src/components/model-menu.tsx) picker that MUST stay a subset of the backend
> `ALLOWED_MODELS`. Read this when you touch any composer, add an input control, change accepted file types, or wire the model
> picker. Adjacent: how the submitted query/attachments stream and render → **streaming-chat-rendering.md**; how `streamAsk`
> ships the body + token → **api-client-and-config.md**; how `handleAsk`/`runTurn` orchestrate → **lumina-frontend-architecture.md**.
> `lumina-` ref = THIS codebase; verify `file:line` against live code before editing (line numbers drift).

---

## 1. The shape of the surface

There is **one** composer component, reused everywhere by passing a different `onSubmit`. The hero composer on the empty
Dashboard is `SearchHero`; the docked composers inside FinanceView / AcademicView / HealthView and the in-thread follow-up box
are siblings that funnel into the same `handleAsk`/`handleFollowUp`. They all assemble the identical payload: **a trimmed query
string + an `Attachment[]`**, plus the currently selected `model` carried on Dashboard state.

```
 SearchHero (controlled textarea + attachments[] state)
   │  submit(): trim, bail-if-empty, onSubmit(query, attachments), clear
   ▼
 Dashboard.handleAsk(query, attachments)         ── pages/Dashboard.tsx:149
   │  resets conv id, activeTab="answer"
   ▼
 runTurn(query, fresh=true, attachments)          ── pages/Dashboard.tsx:105
   │  vertical = sectionRef.current → "finance"|"assistant"|"discover"
   ▼
 streamAsk(query, { onChunk, model, attachments, vertical })  ── lib/api.ts:140
   │  POST /perplexity_ask  { query, model, attachments, vertical }
   ▼
 backend buildAttachmentParts(req.body.attachments)  ── backend/index.ts:285
      image/* → {type:"image"}   else → {type:"file"}
```

The composer never talks to the network. Its only job is to produce `(query, Attachment[])` and hand it up; all transport,
auth, and streaming live below `onSubmit`. Keep it that way — a composer that fetches is a layering bug.

---

## 2. SearchHero — the composer

Source: [`frontend/src/components/search-hero.tsx`](../../../../frontend/src/components/search-hero.tsx).

| Concern | Implementation | Line |
|---|---|---|
| Props | `{ onSubmit(query, attachments), model, onModelChange(id) }` — fully controlled by parent | `search-hero.tsx:25` |
| Local state | `value` (textarea), `attachments` (`Attachment[]`); `textareaRef` for focus | `search-hero.tsx:34` |
| Submit guard | `const trimmed = value.trim(); if (!trimmed) return;` — empty/whitespace never submits | `search-hero.tsx:38` |
| Submit effect | `onSubmit(trimmed, attachments)` then `setValue("")` + `setAttachments([])` | `search-hero.tsx:41` |
| Enter to send | `onKeyDown`: Enter (no Shift) → `preventDefault()` + `submit()`; **Shift+Enter = newline** | `search-hero.tsx:58` |
| Form submit | `<form onSubmit>` also calls `submit()` (button + IME-safe path) | `search-hero.tsx:51` |
| Autosize | `field-sizing-content` + `min-h-[28px] max-h-[30vh]` — CSS grows the textarea, no JS measuring | `search-hero.tsx:66` |
| Send button | `type="submit"`, `disabled={!value.trim()}`, fills primary only when there's text | `search-hero.tsx:86` |

The composer is **controlled** (`value`/`onChange`) so the suggestion chips can prefill it: clicking a chip does
`setValue(prompt)` + `textareaRef.current?.focus()` so the user keeps typing where the prompt leaves off (`search-hero.tsx:109`).

### The submit contract (copy this for any new composer)

```tsx
function submit() {
  const trimmed = value.trim();
  if (!trimmed) return;            // never submit empty
  onSubmit(trimmed, attachments);  // (query, Attachment[]) up to handleAsk
  setValue("");                    // clear text AND attachments together
  setAttachments([]);
}
```

Two non-obvious rules baked in here:
- **Enter sends, Shift+Enter newlines.** This is what users expect from a chat box; `rows={1}` + autosize makes multi-line
  composing work. Do not invert it.
- **Clear text and attachments in one go.** Leaving stale attachments after submit is a classic bug (the next question silently
  re-uploads the last file). They are cleared in the same `submit()`.

---

## 3. Attachments — File → base64 → multimodal part

Source: [`frontend/src/components/attachments.tsx`](../../../../frontend/src/components/attachments.tsx). Three exports:
`fileToAttachment` (the encoder), `AttachButton` (the hidden-input paperclip), `AttachmentPreviews` (the chips), plus the
shared `MAX_ATTACHMENTS = 5` constant the composer imports.

### 3.1 The `Attachment` wire shape

Defined once in [`lib/api.ts:17`](../../../../frontend/src/lib/api.ts) — the single source of truth the backend mirrors:

```ts
export interface Attachment {
  name: string;       // file name
  mediaType: string;  // e.g. "image/png", "application/pdf"
  base64: string;     // WITHOUT the "data:...;base64," prefix
}
```

The composer carries `Attachment[]`, `streamAsk` puts it on the JSON body as `attachments`, and the backend turns each into a
Vercel AI SDK content part in `buildAttachmentParts` ([`backend/index.ts:285`](../../../../backend/index.ts)):

```ts
mediaType.startsWith("image/")
  ? { type: "image", image: a.base64, mediaType }          // image part
  : { type: "file",  data:  a.base64, mediaType, filename: a.name }; // file part
```

So the `image/` vs non-image branch on the **frontend** preview (`AttachmentPreviews`) and the **backend** part builder are the
same fork — keep them consistent. The backend also drops any attachment with an empty `base64` (`backend/index.ts:288`).

### 3.2 The encoder — `fileToAttachment`

```ts
const dataUrl = await new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
return { name: file.name, mediaType: file.type || "application/octet-stream",
         base64: dataUrl.split(",")[1] ?? "" };
```

`readAsDataURL` yields `data:<mediaType>;base64,<payload>` — we keep only the payload (`split(",")[1]`), because the wire shape
stores `base64` *without* the prefix. The preview rebuilds the data URL for display (`data:${mediaType};base64,${base64}`,
`attachments.tsx:90`). `file.type` can be empty for odd files, hence the `application/octet-stream` fallback.

### 3.3 The limits (all enforced client-side in `AttachButton`)

| Limit | Value | Where | Why |
|---|---|---|---|
| Count | `MAX_ATTACHMENTS = 5` | `attachments.tsx:8` | exported; composer disables the button at the cap |
| Size | `MAX_BYTES = 20 * 1024 * 1024` (20MB/file) | `attachments.tsx:9` | oversized files are silently filtered out |
| Accept | `image/*,application/pdf,.pdf,.txt,.md,.csv,.doc,.docx` | `attachments.tsx:7` | the file picker's `accept` hint |

The input's `onChange` does the filtering and encoding in one pass (`attachments.tsx:44`):

```ts
const files = Array.from(e.target.files ?? [])
  .filter((f) => f.size <= MAX_BYTES)   // drop oversized
  .slice(0, MAX_ATTACHMENTS);           // cap count
const added = await Promise.all(files.map(fileToAttachment));
if (added.length) onAdd(added);
e.target.value = "";                    // allow re-selecting the same file
```

The `e.target.value = ""` reset is load-bearing: without it, picking the same file twice fires no `change` event. The
composer's `onAdd` re-applies the cap on the merged array — `[...prev, ...added].slice(0, MAX_ATTACHMENTS)` (`search-hero.tsx:78`)
— so even repeated adds can't exceed 5. The button is also `disabled` once `attachments.length >= MAX_ATTACHMENTS`.

> **Server cap that matters:** the backend JSON body limit is `25mb` (`express.json({ limit: "25mb" })`, `backend/index.ts:24`)
> because base64 inflates bytes ~33%. 5 × 20MB raw files would blow past that — the 20MB/file client limit plus base64 overhead
> is the real ceiling. If you raise `MAX_BYTES` or `MAX_ATTACHMENTS`, raise the express limit too or large uploads 413.

### 3.4 The previews — `AttachmentPreviews`

Renders nothing when empty (`if (attachments.length === 0) return null`). Per attachment: image → a 32px `<img>` thumbnail from
the rebuilt data URL; non-image → a `FileText` glyph in a muted tile. Each chip shows a truncated name and an `X` button calling
`onRemove(i)` (`attachments.tsx:100`). The composer's `onRemove` filters by index:
`setAttachments(prev => prev.filter((_, idx) => idx !== i))` (`search-hero.tsx:71`).

`key={`${a.name}-${i}`}` includes the index because two files can share a name — name alone would collide.

---

## 4. MicButton — placeholder, by design

Source: [`frontend/src/components/mic-button.tsx`](../../../../frontend/src/components/mic-button.tsx). **It is decorative today.**
No `onClick`, no Web Speech API — just a `Mic` glyph with `aria-label="Voice (coming soon)"` and `title="Voice — coming soon"`,
present so the search box matches the Finance chat box visually. Do not document it as functional speech input; it is a styling
placeholder waiting to be wired.

When you wire it (the intended future), the shape is `SpeechRecognition` → on `result`, append the transcript into the
composer's `value`. That means the mic must become a **controlled child of the composer** (it needs `value`/`setValue` or an
`onTranscript` callback) — it currently takes only an optional `className`. Plan: lift the transcript into `SearchHero` state via
a new `onTranscript(text)` prop, feature-detect `window.SpeechRecognition || window.webkitSpeechRecognition`, and keep the
placeholder behavior when unsupported.

---

## 5. ModelMenu — the picker that must mirror the backend

Source: [`frontend/src/components/model-menu.tsx`](../../../../frontend/src/components/model-menu.tsx). A shadcn `DropdownMenu`
over a `MODELS` array. Exports `MODELS`, `DEFAULT_MODEL`, `modelLabel(id)`, and the `ModelMenu` component.

| Piece | Detail | Line |
|---|---|---|
| Id format | AI Gateway `<provider>/<model>` strings (e.g. `anthropic/claude-sonnet-4.6`) | `model-menu.tsx:23` |
| Default | `DEFAULT_MODEL = "anthropic/claude-sonnet-4.6"` — Dashboard seeds `useState(DEFAULT_MODEL)` | `model-menu.tsx:34` |
| Label lookup | `modelLabel(id)` → name or `"Model"` fallback if unknown id | `model-menu.tsx:36` |
| Selection | `onSelect` → `e.preventDefault()` + `onChange(id)` unless `locked` | `model-menu.tsx:68` |
| `locked` | shown with a `Lock` glyph, **not selectable** (free-plan styling); none locked today | `model-menu.tsx:81` |
| `badge` | optional `"Max"`/`"New"` pill (Opus is `"Max"`) | `model-menu.tsx:25` |

### The one rule: `MODELS` ⊆ backend `ALLOWED_MODELS`

The picker is controlled by Dashboard (`value={model}`, `onChange={setModel}`); the chosen id rides every request as
`model: modelRef.current` (in `runTurn`, `Dashboard.tsx:129`). The backend **re-validates** it in `resolveModel`
([`backend/index.ts:78`](../../../../backend/index.ts)):

```ts
function resolveModel(model: unknown): string {
  return typeof model === "string" && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
}
```

An id the server doesn't allow **silently** falls back to `DEFAULT_MODEL` — the user thinks they switched and didn't, with no
error. So the frontend `MODELS` ids must be a subset of the backend `ALLOWED_MODELS` set. Live alignment check:

| Backend `ALLOWED_MODELS` (`backend/index.ts:67`) | In frontend `MODELS`? |
|---|---|
| `google/gemini-3.1-pro-preview` | yes |
| `google/gemini-3-pro-preview` | yes |
| `anthropic/claude-opus-4.7` | yes (`Max`) |
| `anthropic/claude-sonnet-4.6` | yes (default) |
| `anthropic/claude-haiku-4.5` | yes |
| `openai/gpt-5.5-pro` | yes |
| `openai/gpt-5.5` | yes |
| `xai/grok-4.3` | yes |

Both default to `anthropic/claude-sonnet-4.6` — keep the two `DEFAULT_MODEL` constants identical too, or a fallback in one
layer disagrees with the other.

### Decision framework — changing the model list

```
Want to offer a model in the picker?
 ├─ Is its <provider>/<model> id in backend ALLOWED_MODELS?
 │    ├─ no  → add it there FIRST (backend/index.ts:67), confirm the AI Gateway routes it, THEN add to MODELS
 │    └─ yes → add { id, name, icon, badge? } to MODELS (model-menu.tsx:23)
 └─ Want to show-but-disable a tier (paywall)? → add with locked:true (renders a Lock, not selectable)

Want to change the default?
 └─ Update DEFAULT_MODEL in BOTH model-menu.tsx:34 and backend/index.ts:77 — they must match.

Removing a model?
 └─ Remove from MODELS; leaving it in backend ALLOWED_MODELS is harmless, but a stale id
    saved in someone's state resolves via resolveModel to the default — acceptable.
```

---

## 6. End-to-end: from keystroke to multimodal message

1. User types; `value` updates (controlled). Optionally clicks the paperclip → files filtered/capped/encoded → `attachments`.
2. Enter (no Shift) or the send button → `submit()` → `onSubmit(trimmed, attachments)` → Dashboard `handleAsk`.
3. `handleAsk` resets the conversation id and `activeTab="answer"`, then `runTurn(query, true, attachments)` (`Dashboard.tsx:149`).
4. `runTurn` derives `vertical` from `sectionRef.current` and calls `streamAsk(query, { onChunk, model: modelRef.current, attachments, vertical })` (in `runTurn`, `Dashboard.tsx:129`).
5. `streamAsk` POSTs `/perplexity_ask` with `{ query, model, attachments, vertical }` (`lib/api.ts:140`).
6. Backend `resolveModel` validates the id; `buildAttachmentParts` turns each `Attachment` into an `image`/`file` content part and sends a multimodal user message (`backend/index.ts:285`, called at `:670`).

The composer's responsibility ends at step 2. Everything else is shared transport — which is why every vertical reuses the same
`onSubmit={handleAsk}` instead of building a bespoke ask path.

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Submitting on empty/whitespace input. | `const trimmed = value.trim(); if (!trimmed) return;` before `onSubmit` (`search-hero.tsx:38`). |
| Clearing the text but leaving `attachments` after submit. | Clear both in `submit()` so the next question doesn't silently re-upload. |
| Enter inserts a newline / Shift+Enter sends. | Enter sends, Shift+Enter newlines (`onKeyDown` at `search-hero.tsx:58`). |
| Storing the full `data:...;base64,...` URL in `Attachment.base64`. | Strip the prefix: `dataUrl.split(",")[1]`; the wire shape is payload-only (`api.ts:17`). |
| Diverging the image-vs-file fork between preview and backend. | Both branch on `mediaType.startsWith("image/")` — frontend preview (`attachments.tsx:82`) and `buildAttachmentParts` (`backend/index.ts:291`) must agree. |
| Not resetting `<input value>` after a pick, so the same file can't be re-selected. | `e.target.value = ""` in the input's `onChange` (`attachments.tsx:50`). |
| Capping count in only one place. | Filter in `AttachButton` AND re-`slice(0, MAX_ATTACHMENTS)` in `onAdd`, AND `disabled` at the cap. |
| Raising `MAX_BYTES`/`MAX_ATTACHMENTS` without touching the server. | Also raise `express.json({ limit })` (`backend/index.ts:24`); base64 adds ~33% — large uploads 413 otherwise. |
| Documenting/relying on MicButton as working speech input. | It's a `coming soon` placeholder with no handler; wire Web Speech + lift transcript into the composer before claiming it. |
| Adding a model to `MODELS` the backend doesn't allow. | Add to `ALLOWED_MODELS` first (`backend/index.ts:67`); otherwise `resolveModel` silently falls back to the default. |
| Letting the frontend and backend `DEFAULT_MODEL` drift. | Keep both `anthropic/claude-sonnet-4.6` (`model-menu.tsx:34`, `backend/index.ts:77`). |
| Making the composer fetch/stream directly. | Composer only emits `(query, Attachment[])`; transport/auth/streaming live under `onSubmit` → `handleAsk`. |
| Building a per-vertical composer with its own submit pipeline. | Reuse the same component with a different `onSubmit`; all funnel into `handleAsk`/`runTurn`. |

---

## 8. Quick file map

| File | Owns |
|---|---|
| [`search-hero.tsx`](../../../../frontend/src/components/search-hero.tsx) | the composer: textarea, autosize, Enter-to-send, submit contract, suggestion chips, layout of attach/model/mic/send |
| [`attachments.tsx`](../../../../frontend/src/components/attachments.tsx) | `fileToAttachment` encoder, `AttachButton`, `AttachmentPreviews`, `MAX_ATTACHMENTS`, accept/size limits |
| [`mic-button.tsx`](../../../../frontend/src/components/mic-button.tsx) | placeholder voice button (no handler yet) |
| [`model-menu.tsx`](../../../../frontend/src/components/model-menu.tsx) | `MODELS`, `DEFAULT_MODEL`, `modelLabel`, the picker dropdown |
| [`lib/api.ts`](../../../../frontend/src/lib/api.ts) | `Attachment` type, `StreamOpts`, `streamAsk`/`streamFollowUp` (carry `attachments`/`model`) |
| [`pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx) | `handleAsk`/`handleFollowUp`/`runTurn`, holds `model` state + `vertical` derivation |
| [`backend/index.ts`](../../../../backend/index.ts) | `ALLOWED_MODELS`/`resolveModel`, `buildAttachmentParts`, the `25mb` body limit |
