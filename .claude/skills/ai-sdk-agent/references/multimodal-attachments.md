# Multimodal Attachments — images & docs into the AI SDK message

> How a user-uploaded image/PDF becomes an AI-SDK **content part** on the user message, and the
> three rules that govern it: image-vs-file by `mediaType`, the model must be vision/doc-capable, and
> **any request with an attachment bypasses the semantic cache** (the answer depends on the upload).
> Read this when a task touches `req.body.attachments`, `buildAttachmentParts`, multimodal user
> messages, or "why didn't my screenshot get read." Adjacent refs:
> [`streaming-and-wire-protocol.md`](./streaming-and-wire-protocol.md) (the wire tail the answer
> still emits), [`conversation-compaction.md`](./conversation-compaction.md) (attachments on the
> follow-up path + why parts never enter history), [`model-gateway-and-selection.md`](./model-gateway-and-selection.md)
> (which gateway ids are vision-capable), and [`lumina-agent-engine.md`](./lumina-agent-engine.md)
> (where the cache decision sits in the request flow).

Files: `buildAttachmentParts` + the `RawAttachment`/`ContentPart` types in
[`backend/index.ts`](../../../../backend/index.ts) (defined at index.ts:276–295), the body-limit
`express.json({ limit: "25mb" })` at [`index.ts:24`](../../../../backend/index.ts), the cache-bypass
decision at [`index.ts:670–673`](../../../../backend/index.ts), the multimodal user-message assembly
on the MISS path at [`index.ts:700–708`](../../../../backend/index.ts), and on the follow-up path at
[`index.ts:844–857`](../../../../backend/index.ts).

---

## 1. What an attachment is, end to end

```
client                         /perplexity_ask (index.ts)
  uploads file ──► base64 ──►  req.body.attachments: RawAttachment[]
                              { name?, mediaType?, base64? }
                                       │
                       buildAttachmentParts(input)   ── index.ts:285
                                       │  filter empties; map by mediaType
                                       ▼
                   ContentPart[]  ── image | file parts
                                       │
        cacheable = !timeSensitive && parts.length === 0   ── index.ts:671 (parts ⇒ NO cache)
                                       │
        userContent = parts.length                          ── index.ts:702
            ? [{type:"text", text: prompt}, ...parts]        (multimodal message)
            : prompt                                         (plain string)
                                       │
        streamText({ messages:[{ role:"user", content: userContent }], ... })
```

The whole feature is **one pure function** plus two call-sites (the MISS path and the follow-up
path). There is no upload route, no blob store, no DB row for the file — the base64 rides in the JSON
request body and is forwarded straight into the AI-SDK message. That design is why the 25mb body
limit and the cache-bypass rule (below) exist.

---

## 2. The shape: `RawAttachment` in, `ContentPart` out

The wire-in type is deliberately loose (everything optional — it's untrusted client JSON):

```ts
type RawAttachment = { name?: string; mediaType?: string; base64?: string };  // index.ts:279
type ContentPart =
    | { type: "text";  text: string }
    | { type: "image"; image: string; mediaType: string }
    | { type: "file";  data: string;  mediaType: string; filename?: string };  // index.ts:280–283
```

`buildAttachmentParts` (index.ts:285) does exactly three things:

| Step | Code | Why |
|------|------|-----|
| **Guard non-arrays** | `if (!Array.isArray(input)) return []` | `input` is `unknown` (raw `req.body.attachments`). No attachments / a malformed field ⇒ empty array, never a throw. |
| **Drop empty entries** | `.filter(a => a && typeof a.base64 === "string" && a.base64.length > 0)` | An attachment with no `base64` is meaningless; filtering keeps `parts.length` honest (it drives the cache decision). |
| **Map by `mediaType`** | `mediaType.startsWith("image/") ? image-part : file-part` | The single branch that decides image vs file. Missing `mediaType` defaults to `"application/octet-stream"` ⇒ a **file** part. |

Note the **field-name asymmetry** the AI SDK requires — get this wrong and the part is silently
ignored by the model:

| Part type | Payload field | Name field |
|-----------|---------------|------------|
| `image`   | `image` (base64) | *(none — mediaType only)* |
| `file`    | `data` (base64)  | `filename` (mapped from `RawAttachment.name`) |

So an image part carries `{ type:"image", image, mediaType }` while a file part carries
`{ type:"file", data, mediaType, filename }`. Don't unify them under one `data` field.

---

## 3. image vs file — the `mediaType` decision

The ONLY discriminator is the MIME prefix:

| `mediaType` example | Part produced | Sent to model as |
|---------------------|---------------|------------------|
| `image/png`, `image/jpeg`, `image/webp`, `image/gif` | `image` | a vision image input |
| `application/pdf` | `file` | a document input |
| `text/plain`, `text/csv`, `text/markdown` | `file` | a document input |
| `application/octet-stream` (missing/unknown mediaType) | `file` | a document input (often unreadable — see anti-patterns) |

There is **no allow-list and no size check per file** — `buildAttachmentParts` trusts the client's
`mediaType` string. If the client mislabels a PNG as `application/pdf`, it becomes a file part and the
model may reject it. The contract is "client sends an honest `mediaType`."

---

## 4. Model capability — this is the silent-failure trap

The comment at index.ts:278 states it plainly:

> The model must be vision/doc-capable (Claude, Gemini, GPT) — Sonar won't read them.

Attachments are forwarded to **whatever model `resolveModel` returns** (index.ts:78). The SDK does
not error if that model can't see images; the parts are simply ignored and the model answers from the
text alone — a confusing "it didn't read my screenshot" with a 200 and a plausible-but-blind answer.

Cross-check the model against the gateway allow-list (`ALLOWED_MODELS`, index.ts:67):

| Gateway id | Image | Doc/PDF | Notes |
|------------|:-----:|:-------:|-------|
| `anthropic/claude-sonnet-4.6` (DEFAULT_MODEL) | ✅ | ✅ | the safe default for attachments |
| `anthropic/claude-opus-4.7` | ✅ | ✅ | premium; use for hard visual reasoning |
| `anthropic/claude-haiku-4.5` | ✅ | ✅ | cheap vision; good for simple "what's in this image" |
| `google/gemini-3.1-pro-preview` / `gemini-3-pro-preview` | ✅ | ✅ | strong long-doc vision |
| `openai/gpt-5.5-pro` / `gpt-5.5` | ✅ | ✅ | vision-capable |
| `xai/grok-4.3` | ✅ | varies | verify doc support before relying on PDFs |
| (any Sonar/Perplexity-class text-only model) | ❌ | ❌ | parts dropped silently — the named trap |

**Decision framework — picking the model when attachments are present:**

```
attachments present?
  └─ no  → normal model routing (resolveModel)
  └─ yes → is resolveModel(req.body.model) vision/doc-capable?
            ├─ yes → proceed
            └─ no  → the upload will be ignored. Either force a capable DEFAULT_MODEL
                     for attachment requests, or reject with a clear message.
                     Do NOT silently answer blind.
```

(The live code does not yet force a capable model on attachment requests — it relies on the frontend
picker offering only the allow-listed, vision-capable ids. If you add a text-only model to
`ALLOWED_MODELS`, you must add the capability guard above.)

---

## 5. The 25mb body limit

```ts
app.use(express.json({ limit: "25mb" })); // base64-encoded attachments can be large  — index.ts:24
```

Because attachments ride **inside the JSON body as base64**, the entire request — query + history +
every attachment — must fit in 25mb after base64 encoding.

| Fact | Consequence |
|------|-------------|
| base64 inflates bytes by ~**33%** | a 25mb body ≈ **~18mb** of raw file bytes, shared across ALL attachments + the text. |
| limit is **per request**, not per file | three 8mb images already exceed it. |
| over-limit ⇒ Express throws a `PayloadTooLargeError` (HTTP 413) **before** any handler runs | `buildAttachmentParts` never sees it; the request fails in the `express.json` middleware, so the route's try/catch (index.ts:738) never runs — Express's own error handler responds. |
| no per-file size validation in `buildAttachmentParts` | the 25mb body limit is the ONLY guard. |

Raising the limit is a one-line change but pushes more base64 through serverless memory/time and the
model's input-token budget — prefer client-side downscaling of images over a bigger limit.

---

## 6. Cache bypass — why attachments skip the semantic cache

This is the rule most likely to bite. The cacheability decision (index.ts:670–673):

```ts
const parts = buildAttachmentParts(req.body.attachments);
const cacheable = !isTimeSensitive(query) && parts.length === 0;   // attachments ⇒ NOT cacheable
const embedding = cacheable ? await embedQuery(query) : null;       // no embed spent
const cached    = cacheable ? await findCachedAnswer(embedding, model) : null;  // no lookup
```

| Reason | Detail |
|--------|--------|
| **Correctness** | The semantic cache is keyed on the query **embedding + model** only — it does NOT hash the attachment. Two different screenshots with the same caption ("what's wrong here?") would collide and replay the wrong answer. |
| **Efficiency** | When `parts.length > 0`, `cacheable` is false, so `embedQuery` is **not called** (no embedding spent) and `findCachedAnswer` is skipped. The same flag later gates `cacheAnswer` (index.ts:732), so an attachment answer is **never written** to the cache either. |
| **Symmetry with time-sensitivity** | `parts.length === 0` sits in the SAME boolean as `!isTimeSensitive(query)` — attachments are treated exactly like a "today"/price query: the answer depends on something the embedding can't capture, so the cache must not serve or store it. |

Net effect: **an attachment request always takes the full live MISS path** (web search + LLM), is
never served from cache, and is never cached. If you make attachments cacheable later, you must fold
the attachment bytes into the cache key — never key on the query text alone.

---

## 7. Assembling the multimodal user message

Both entry points build the same shape — a `text` part first, then the attachment parts:

```ts
// MISS path — index.ts:702
const userContent: string | ContentPart[] = parts.length
    ? [{ type: "text", text: prompt }, ...parts]   // multimodal: text + image/file
    : prompt;                                       // plain string when no attachments
streamText({ messages: [{ role: "user", content: userContent }], ... });

// Follow-up path — index.ts:844–857  (identical pattern, different prompt var)
const followUpParts   = buildAttachmentParts(req.body.attachments);
const followUpContent  = followUpParts.length
    ? [{ type: "text", text: augmentedQuery }, ...followUpParts]
    : augmentedQuery;
streamText({ messages: [...history, { role: "user", content: followUpContent }], ... });
```

| Rule | Why |
|------|-----|
| **Text part FIRST, attachments after.** | The model reads the instruction, then the media it refers to. Keep this order. |
| **Fall back to a plain string when `parts.length === 0`.** | Avoids wrapping every plain query in a single-element array — the AI SDK accepts a bare string for `content`, and it keeps non-attachment requests identical to before the feature existed. |
| **`prompt`/`augmentedQuery` is the already-assembled prompt**, not the raw query. | The attachment rides alongside the full persona/playbook-grounded text prompt, so the model gets the search context AND the upload. |
| **Attachments work on BOTH the first turn and follow-ups.** | Each follow-up re-reads `req.body.attachments` from THAT request — a user can attach a new image to a follow-up. |

---

## 8. Attachments never enter conversation history

Only the **text** of each turn is persisted (`persistTurns(persistUserTurn, conversation.id,
fullAnswer, tail)` at index.ts:729 / 872 stores the user query + the assistant answer + the wire
tail). The base64 parts are **not** stored. Consequences:

- On a later follow-up, `buildConversationHistory` reconstructs prior turns from stored TEXT only —
  the earlier image is gone from context. If the user references "the image I sent earlier," they must
  re-attach it (the frontend can keep it client-side and re-send).
- This is intentional: persisting base64 in `messages`/DB would bloat every subsequent request toward
  the 25mb wall and the context window. See [`conversation-compaction.md`](./conversation-compaction.md)
  for how history is rebuilt without the parts.

---

## 9. The wire tail still applies

An attachment answer is a normal streamed answer — it still emits the
`<ANSWER>`/`<SOURCES>`/`<IMAGES>`/`<FOLLOW_UPS>` wire format and persists before `res.end()`. The
attachment changes only the **input** message, never the output protocol. See
[`streaming-and-wire-protocol.md`](./streaming-and-wire-protocol.md).

---

## 10. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Sending attachments to a text-only model (Sonar) and trusting the answer. | Verify `resolveModel(...)` is vision/doc-capable (§4 table); force `DEFAULT_MODEL` or reject for attachment requests on text-only models. |
| Putting an attachment part in `image` AND `data` / unifying both under one field. | Image part = `{type:"image", image, mediaType}`; file part = `{type:"file", data, mediaType, filename}`. Different field names by design. |
| Making an attachment request cacheable (keying the cache on query text only). | Keep `cacheable = … && parts.length === 0`. If you ever cache uploads, hash the attachment bytes INTO the cache key. |
| Spending an embedding / cache lookup on an attachment request. | `embedding`/`cached` are already gated on `cacheable` — don't move `embedQuery` above the gate. |
| Raising `express.json({limit})` to handle big uploads. | Downscale images client-side; remember base64 is +33% and the limit is per-request (query + history + all files). |
| Per-file size validation scattered in handlers. | The 25mb body limit is the single guard; add a per-file/count check INSIDE `buildAttachmentParts` if you need finer control, returning fewer parts (never throwing). |
| Throwing on a malformed `attachments` field. | `buildAttachmentParts` returns `[]` for non-arrays / empties — keep it total (never throws) so a bad field degrades to "no attachment," not a 500. |
| Persisting base64 parts into history "so follow-ups remember the image." | History stores text only; have the frontend re-send the attachment on the follow-up request. |
| Putting attachment parts BEFORE the text part. | Text instruction first, then `...parts`. |
| Trusting `mediaType` blindly so an unknown type becomes a useless `application/octet-stream` file part. | Validate/normalize `mediaType` client-side; an octet-stream file part is usually unreadable by the model. |

---

## 11. Common tasks → where

| Task | Do |
|------|----|
| Accept a new file type | It already works if the client sends a real `mediaType` and the model is doc-capable — no code change. Verify it lands as a `file` part (§3). |
| "My screenshot wasn't read" | Check the model is vision-capable (§4); check the body wasn't 413'd (§5); confirm `req.body.attachments[].base64` was non-empty (the filter at index.ts:288 drops empties). |
| Add per-file size/count limits | Add the check inside `buildAttachmentParts` (return fewer parts, never throw). |
| Make uploads cacheable | Hash attachment bytes into the cache key first; only then relax `parts.length === 0` (§6). |
| Support attachments in the finance/assistant verticals | Those branches build their own messages — replicate the §7 `parts.length ? [...] : string` pattern there; cross-ref **finance-markets** for the finance message assembly. |
| Engine-level questions (model routing, streaming, compaction) | → the sibling refs listed in the blockquote. |
