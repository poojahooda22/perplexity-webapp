# Health Workflows + Document Upload — a lab report becomes multimodal context

> How a user's "Health Workflows" tap turns into a scoped chat turn, and how an uploaded lab
> report/PDF/image becomes an AI-SDK multimodal user message the model can actually read. This is the
> `lumina-` (project-grounded) view of the upload path: `fileToAttachment` (browser, base64) →
> `/perplexity_ask` → `buildAttachmentParts` (server, `image`/`file` content parts). Read it when the
> task touches the workflow cards, the file-upload rail, attachments, or PHI privacy. **Adjacent
> refs:** the engine that *consumes* these parts (`streamText`, multimodal message shape, model
> gateway) belongs to **ai-sdk-agent**; safety/disclaimer wording belongs to `medical-info-safety.md`;
> the news carousel beside the upload rail belongs to `health-news-sourcing.md`.

Files: [`frontend/src/components/discover/health-view.tsx`](../../../../frontend/src/components/discover/health-view.tsx),
[`frontend/src/components/attachments.tsx`](../../../../frontend/src/components/attachments.tsx) (`fileToAttachment`),
`buildAttachmentParts` in [`backend/index.ts`](../../../../backend/index.ts),
the `Attachment` type in [`frontend/src/lib/api.ts`](../../../../frontend/src/lib/api.ts),
and `handleAsk` in [`frontend/src/pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx).

---

## 1. Two entry points, one pipe

`HealthView` only ever calls one thing: its `onAsk(query, attachments)` prop, wired to Dashboard's
`handleAsk` ([`Dashboard.tsx:149`](../../../../frontend/src/pages/Dashboard.tsx)). That means **every**
health interaction — search box, workflow card, file upload — lands on the **same** research answer
pipeline (`/perplexity_ask`, web-search → `streamText` → `[n]` citations, owned by **research-agent**).
HealthView never talks to the model itself; it only varies the *prompt* and the *attachments*.

| Entry point | What it sends | Attachments | Where in `health-view.tsx` |
|---|---|---|---|
| Search box | the user's typed text | none | `<form onSubmit>` → `ask(value)` (in `HealthView`) |
| Workflow card | a canned `prompt` string (`w.prompt`) | none | `WORKFLOWS.map(...) onClick={() => ask(w.prompt)}` |
| Upload rail | a fixed "summarize this report…" prompt | the file as one `Attachment` | `onUpload` → `ask(prompt, [att])` |

```ts
// the single funnel — health-view.tsx, fn HealthView
const ask = (q: string, attachments: Attachment[] = []) => {
  const t = q.trim();
  if (t) onAsk(t, attachments);     // → Dashboard handleAsk → runTurn → POST /perplexity_ask
};
```

The six workflows (`WORKFLOWS` array) are **prompt presets, not features** — each is an `Act as my …`
framing string. Adding a workflow = adding one `{ icon, label, desc, prompt }` row; it inherits the
whole pipeline for free. The prompts are deliberately guidance-shaped ("Explain how to read…",
"evidence-based ways to…", "ask me about my goals … first"), never "tell me what I have" — that is the
safety contract enforced in prose, see `medical-info-safety.md`.

---

## 2. The upload flow, end to end

```
User clicks "Upload lab results & documents"  (health-view.tsx, "Health files" card)
  └─ hidden <input type=file accept="image/*,application/pdf,.txt,.csv,.doc,.docx">
  └─ onUpload(e):
       file = e.target.files[0]; e.target.value = ""    // reset → re-select same file works
       att  = await fileToAttachment(file)               // → { name, mediaType, base64 }
       ask("Summarize this health report …", [att])      // fixed clinician-routing prompt
            │
            ▼  Dashboard.handleAsk → runTurn → api POST /perplexity_ask { query, attachments }
            │  (express.json limit:"25mb" — base64 inflates ~33%, so this is the real ceiling)
            ▼
backend/index.ts  /perplexity_ask handler
  parts = buildAttachmentParts(req.body.attachments)      // → ContentPart[] (image|file)
  cacheable = !isTimeSensitive(query) && parts.length===0 // ATTACHMENTS BYPASS THE SEMANTIC CACHE
  userContent = parts.length ? [{type:"text", text:prompt}, ...parts] : prompt
  streamText({ model, messages:[{ role:"user", content:userContent }], … })
```

### Browser side — `fileToAttachment` ([`attachments.tsx:12`](../../../../frontend/src/components/attachments.tsx))
`FileReader.readAsDataURL` → `dataUrl.split(",")[1]` strips the `data:<mime>;base64,` prefix so the
wire carries **raw base64 only**. Output is the `Attachment` shape ([`api.ts:17`](../../../../frontend/src/lib/api.ts)):

```ts
export interface Attachment {
  name: string;       // original filename — becomes file part `filename`
  mediaType: string;  // "image/png" | "application/pdf" | … — drives image-vs-file routing
  base64: string;     // WITHOUT the "data:...;base64," prefix
}
```

Note the two upload UIs differ by design: HealthView's rail takes **one** file and auto-asks; the
generic composer's `AttachButton` takes **up to `MAX_ATTACHMENTS` (5)**, filters `MAX_BYTES` (20MB)
client-side, and lets the user type. Both produce the identical `Attachment[]`.

### Server side — `buildAttachmentParts` ([`backend/index.ts:285`](../../../../backend/index.ts))
The hinge of this whole ref. It maps each `Attachment` to a Vercel AI SDK content part by MIME prefix:

```ts
function buildAttachmentParts(input: unknown): ContentPart[] {
  if (!Array.isArray(input)) return [];                 // defensive: tolerate undefined/garbage
  return (input as RawAttachment[])
    .filter((a) => a && typeof a.base64 === "string" && a.base64.length > 0) // drop empties
    .map((a) => {
      const mediaType = a.mediaType || "application/octet-stream";
      return mediaType.startsWith("image/")
        ? { type: "image" as const, image: a.base64!, mediaType }            // → vision input
        : { type: "file"  as const, data:  a.base64!, mediaType, filename: a.name }; // → doc input
    });
}
```

| Input MIME | Emitted part | Field carrying bytes | Model capability needed |
|---|---|---|---|
| `image/*` (png, jpg, heic…) | `{ type:"image" }` | `image` | vision |
| `application/pdf`, `.doc/.docx`, `.txt`, `.csv` | `{ type:"file" }` | `data` (+ `filename`) | document/file input |
| missing/unknown | `{ type:"file" }` with `application/octet-stream` | `data` | document input (may be rejected) |

The part objects use the AI SDK's own field names — note `image` parts carry bytes in `image` but
`file` parts carry them in `data`. The model that consumes them is resolved by `resolveModel` and
runs through `streamText`; how that message is assembled, sent through the Gateway, and decoded is
**ai-sdk-agent**'s territory — this ref stops at producing the parts.

---

## 3. How a part joins the user message

A multimodal turn is just text **plus** parts in a single user message — the same composition the
finance/follow-up paths use. Both `/perplexity_ask` and `/perplexity_ask/follow_up` build it the same way:

```ts
// /perplexity_ask  (backend/index.ts, fn handler ~step 6)
const userContent: string | ContentPart[] = parts.length
  ? [{ type: "text", text: prompt }, ...parts]   // text FIRST, then image/file parts
  : prompt;                                       // plain string when no attachments
streamText({ model, messages: [{ role: "user", content: userContent }], … });

// /perplexity_ask/follow_up  uses the identical pattern with followUpParts + augmentedQuery
```

So an uploaded report is *also* answered with live web context: `prompt`/`augmentedQuery` already
fold in the dated Tavily search results (`formatSearchContext`), and the attachment rides alongside.
The model reads the report **and** can cite current sources — e.g. summarize a lab PDF and reference
authoritative reference ranges. The `<SOURCES>` tail still streams as usual (research-agent owns it).

---

## 4. Privacy — the PHI-adjacent contract (non-negotiable)

An uploaded report is the most sensitive payload in the app. The pipeline is built so the file is a
**transient, per-request** input and nothing more.

| Property | Guarantee | Where it's enforced |
|---|---|---|
| No file store | There is no health-file table, bucket, or disk write. The base64 exists only inside the request's `messages`. | No persistence code path touches `req.body.attachments` beyond `buildAttachmentParts`. |
| Not cached | An attachment request **never** reads or writes the semantic cache. | `cacheable = !isTimeSensitive(query) && parts.length === 0` — any part forces `cacheable=false`, so `embedding`/`findCachedAnswer`/`cacheAnswer` are all skipped ([`backend/index.ts:671`](../../../../backend/index.ts)). |
| No cross-user bleed | The part lives in one request's message array; `buildAttachmentParts` returns a fresh array each call. | Per-request scope; nothing global holds attachment bytes. |
| Bytes never logged | Logs reference filenames/metadata, never `base64`/`data`. | Keep it that way — do not add a `console.log(att)` while debugging. |
| Backend-proxied | The browser sends to `/perplexity_ask`; no provider key is exposed client-side. | `BUN_PUBLIC_BACKEND_URL` only; keys stay in `process.env`. |

The persisted **assistant answer** (via `persistTurns`) is fine — it's the model's summary, not the
file. What must never be persisted/cached/logged is the **upload itself**.

---

## 5. Decision framework — adding/changing upload behavior

```
Touching the upload feature?
|
+-- Add a new workflow card?
|     → add a { icon, label, desc, prompt } row to WORKFLOWS in health-view.tsx.
|       Prompt must be guidance-framed (no diagnosis/dosage). No backend change.
|
+-- Accept a new file type?
|     → extend the <input accept="…"> in health-view.tsx AND the composer ACCEPT in attachments.tsx.
|       Confirm the MIME maps correctly in buildAttachmentParts (image/* vs file) AND that the
|       TARGET MODEL can read that type (PDF/doc input ≠ vision). Test on Claude/Gemini/GPT.
|
+-- Bigger files?
|     → raise express.json({ limit }) in index.ts (currently "25mb") AND MAX_BYTES in attachments.tsx,
|       in step. Remember base64 ≈ +33%: a 20MB file is ~27MB on the wire.
|
+-- Multiple files in the health rail?
|     → mirror the composer: collect File[], map fileToAttachment, pass the whole Attachment[] to ask().
|       buildAttachmentParts already handles N parts; the cache bypass already triggers on parts.length.
|
+-- Want the report answer cached / want it persisted to a "my reports" feature?
      → STOP. That breaks the PHI contract (§4). Caching keys on the query embedding, not file content,
        and would leak one user's report to another's similar query. Persisting needs a separate,
        consented, access-controlled store — not this pipe.
```

---

## 6. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Sending an uploaded PDF/image to a non-vision model (Sonar / a text-only id). | Route uploads to a vision/doc-capable model (Claude/Gemini/GPT). `buildAttachmentParts` emits the right parts; the **model** must be able to read them. A wrong model silently ignores the file or errors. |
| Persisting the lab report to disk/DB or adding a "saved reports" tab off this flow. | Keep it per-request only. A real store needs explicit consent + access control + encryption — a separate feature, not this pipe. |
| `console.log(req.body.attachments)` while debugging. | Log `att.name`/`mediaType`/`base64.length` only — never the bytes. PHI-adjacent data must not enter logs. |
| Letting an attachment hit the semantic cache "to speed it up." | The cache keys on the *query* embedding, not the file — it would replay a stale/other answer or leak across users. `parts.length === 0` is the guard; keep it. |
| Keeping the `data:<mime>;base64,` prefix on the wire. | `fileToAttachment` strips it (`dataUrl.split(",")[1]`); the AI SDK wants raw base64 in `image`/`data`. A retained prefix corrupts the decode. |
| Forgetting to reset `e.target.value` after upload. | Both upload handlers set `e.target.value = ""` so the same file can be re-selected (the `change` event won't fire twice otherwise). |
| Putting attachment parts before the text in the message. | Text part FIRST, then `...parts` — matches every call site here and gives the model the instruction before the payload. |
| A workflow prompt that asks the model to diagnose or prescribe. | Frame as guidance + "discuss with a doctor"; mirror the existing `WORKFLOWS` strings. See `medical-info-safety.md`. |
| Raising `MAX_BYTES` without raising `express.json` limit (or vice-versa). | Move them in step; otherwise the client accepts a file the server rejects with a 413. Account for the ~33% base64 inflation. |
| Hand-building image/file parts inline in a new route. | Call `buildAttachmentParts(req.body.attachments)` — one place owns the MIME→part mapping and the empty-filter; reuse it (finance/follow-up already do). |

---

## 7. Quick verification

1. **Image:** upload a PNG screenshot of a lab panel → answer references values visible in the image.
2. **PDF:** upload a multi-page lab PDF → answer summarizes findings + flags "discuss with a doctor".
3. **Cache bypass:** confirm two uploads of the *same* prompt both hit the LLM (no instant replay) —
   that proves `parts.length` forced `cacheable=false`.
4. **Privacy:** grep the request logs — no base64 strings; no health-file rows in the DB.
5. **Wrong model:** switch to a non-vision model and confirm you understand the failure (ignored/errored)
   — this is the single most common upload bug.
6. **Size:** a ~24MB file should 413 at the `express.json` boundary, not crash the function.
