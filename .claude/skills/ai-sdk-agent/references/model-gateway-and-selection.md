# Model Gateway & Selection — one key, many providers, the right model per task

> How Lumina names, validates, and chooses an LLM. **Every** model in this codebase is a bare
> `"provider/model"` string routed through the **Vercel AI Gateway** off a single
> `AI_GATEWAY_API_KEY`; an inbound id is validated against an `ALLOWED_MODELS` allowlist by
> `resolveModel` and falls back to `DEFAULT_MODEL`. Read this when wiring a new model id, debugging
> a "model does not exist" error, choosing cheap-vs-premium per task, or touching the embedding
> model. `lumina-` ref = THIS codebase; cite the live file before changing it (line numbers drift).
>
> Adjacent refs: **hooks-and-guardrails.md** (the rate limiter that exists to cap premium-model
> bills), **conversation-compaction.md** (why compaction uses the cheap model), **rag-retrieval**
> (the pgvector table the embedding model keys), and the **claude-api** skill for everything
> Claude-specific (ids, pricing, caching, params) — this ref deliberately defers all of that.

Files: `ALLOWED_MODELS` / `resolveModel` / `DEFAULT_MODEL` in
[`backend/index.ts`](../../../../backend/index.ts) (defined together near
[index.ts:67-80](../../../../backend/index.ts)); `SUMMARY_MODEL` at
[index.ts:319](../../../../backend/index.ts); the embedding model in `embedQuery`
([index.ts:430-441](../../../../backend/index.ts)).

---

## 1. The Gateway in one paragraph

A model in this codebase is **never** a provider SDK client. It is a **bare string** like
`"anthropic/claude-sonnet-4.6"` passed straight into `streamText`/`generateText`/`generateObject`/
`embed`. The Vercel AI SDK sees a string (not a provider object) and routes it through the **Vercel
AI Gateway**, authenticated by **one** `AI_GATEWAY_API_KEY`. That single key buys access to **every**
provider — Anthropic, OpenAI, Google, xAI — with no per-provider SDK, no per-provider key, and no
per-provider client wiring. The comment at [index.ts:64-66](../../../../backend/index.ts) states it:
*"A bare string model routes through the gateway (uses AI_GATEWAY_API_KEY), giving access to every
provider from one key."*

```
streamText({ model: "anthropic/claude-sonnet-4.6", … })
        │  bare string, not a provider client
        ▼
  Vercel AI SDK  ──→  Vercel AI Gateway  ──(AI_GATEWAY_API_KEY)──┐
                                                                 ├─→ Anthropic
   id format:  <provider>/<model>                                ├─→ OpenAI
   dot in the model segment (claude-sonnet-4.6, gpt-5.5-pro)     ├─→ Google
                                                                 └─→ xAI
```

| Property | Value here |
|---|---|
| Id shape | `"<provider>/<model>"` — provider segment, slash, model segment (dot allowed in model, e.g. `claude-sonnet-4.6`, `gemini-3.1-pro-preview`) |
| Auth | one env var, `AI_GATEWAY_API_KEY`; no per-provider keys in `process.env` for chat |
| Where ids live | `ALLOWED_MODELS` set + `DEFAULT_MODEL` + `SUMMARY_MODEL` + the embedding id — all in [`backend/index.ts`](../../../../backend/index.ts) |
| Who picks per request | `resolveModel(req.body.model)` — client proposes, server disposes |
| Embeddings | same mechanism: `"openai/text-embedding-3-small"` is a bare gateway id too |

**Why a gateway and not provider SDKs?** Swapping `"anthropic/claude-sonnet-4.6"` for
`"openai/gpt-5.5"` is a one-token change with zero new dependencies, keys, or client code. The cost
of switching providers drops to editing a string in an allowlist.

---

## 2. The allowlist + resolver (the whole contract)

The entire selection contract is ~14 lines at [index.ts:67-80](../../../../backend/index.ts):

```ts
// Vercel AI Gateway model ids (`<provider>/<model>`, dot in the model segment).
const ALLOWED_MODELS = new Set([
    "google/gemini-3.1-pro-preview",
    "google/gemini-3-pro-preview",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.5-pro",
    "openai/gpt-5.5",
    "xai/grok-4.3",
]);
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
function resolveModel(model: unknown): string {
    return typeof model === "string" && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
}
```

Three rules, all enforced by this snippet:

1. **Allowlist, not free-text.** The client sends `req.body.model`; `resolveModel` accepts it **only**
   if it's a string *and* in `ALLOWED_MODELS`. An unknown, mistyped, malicious, or absent id silently
   becomes `DEFAULT_MODEL`. The request never fails on a bad model id, and a client can never route to
   an un-vetted (or un-budgeted) model.
2. **One default.** `DEFAULT_MODEL = "anthropic/claude-sonnet-4.6"` — the balanced workhorse for the
   default Discover/search vertical and the chat verticals when the client doesn't specify.
3. **`resolveModel` is called on every path** — never trust `req.body.model` raw. It's invoked in:
   the finance branch of `/perplexity_ask` ([index.ts:642](../../../../backend/index.ts)), the
   assistant branch ([index.ts:656](../../../../backend/index.ts)), the cache/default path
   ([index.ts:669](../../../../backend/index.ts)), and all three follow-up branches
   ([index.ts:799](../../../../backend/index.ts), [index.ts:821](../../../../backend/index.ts),
   [index.ts:855](../../../../backend/index.ts)).

**The model is also the semantic-cache key.** `findCachedAnswer`/`cacheAnswer` key on
`(embedding, model)` ([index.ts:444-502](../../../../backend/index.ts)) so a premium-model request
is *never* served a budget-model's cached answer. That's the reason `model` is resolved **up front**
at [index.ts:669](../../../../backend/index.ts) — before the cache lookup — not lazily at
`streamText` time. (See **rag-retrieval** for the cache table.)

---

## 3. The model registry (what's wired today)

These are the ids in `ALLOWED_MODELS` right now. Verify against [index.ts:67-76](../../../../backend/index.ts)
before relying on a specific id — the set evolves.

| Gateway id | Provider | Rough role |
|---|---|---|
| `anthropic/claude-sonnet-4.6` | Anthropic | **`DEFAULT_MODEL`** — balanced workhorse for every vertical |
| `anthropic/claude-haiku-4.5` | Anthropic | **`SUMMARY_MODEL`** — cheap/fast: compaction + LLM narratives |
| `anthropic/claude-opus-4.7` | Anthropic | premium — hardest reasoning when the user opts in |
| `openai/gpt-5.5` | OpenAI | alt default-tier choice |
| `openai/gpt-5.5-pro` | OpenAI | premium alt |
| `google/gemini-3-pro-preview` | Google | strong multimodal alt |
| `google/gemini-3.1-pro-preview` | Google | newer Gemini preview |
| `xai/grok-4.3` | xAI | alt |
| `openai/text-embedding-3-small` | OpenAI | **embeddings** — NOT in `ALLOWED_MODELS` (not user-selectable); hardcoded in `embedQuery` |

> Claude id/pricing/caching/migration specifics (e.g. what `claude-haiku-4.5` costs vs `opus-4.7`,
> prompt caching, the `[1m]` context suffix) live in the **claude-api** skill. Don't restate them here.

---

## 4. Choosing a model per task — the decision framework

The selection axis is **cost × capability for the job**. Lumina uses three tiers and pins two
internal jobs to the cheap tier in code.

```
Task arrives — which model?
|
+-- Is it an INTERNAL housekeeping LLM call (compaction summary, market/research narrative)?
|       └─ YES → CHEAP (Haiku class). Pinned: SUMMARY_MODEL = "anthropic/claude-haiku-4.5".
|                The output is consumed by another LLM call or a card, not read as a flagship answer.
|
+-- Is it the user-facing answer with NO explicit model choice?
|       └─ DEFAULT_MODEL (anthropic/claude-sonnet-4.6) — balanced quality/cost/latency.
|
+-- Did the client pick a model in req.body.model?
|       └─ resolveModel() honors it IF allowlisted (incl. premium opus/gpt-5.5-pro), else DEFAULT.
|
+-- Does the request carry an image/PDF attachment?
        └─ The resolved model MUST be vision/doc-capable (Claude/Gemini/GPT). See §6.
```

| Tier | Use for | Model here | Why |
|---|---|---|---|
| **Cheap** | Compaction summaries, market summary, research notes — internal, high-volume, quality-insensitive | `anthropic/claude-haiku-4.5` (`SUMMARY_MODEL`) | These run on *every long follow-up* and *every cron narrative warm*; a flagship model here is pure waste |
| **Default** | The main user-facing answer when unspecified | `anthropic/claude-sonnet-4.6` (`DEFAULT_MODEL`) | Best quality-per-dollar for the general case |
| **Premium** | Hard reasoning the user explicitly opts into via the picker | `anthropic/claude-opus-4.7`, `openai/gpt-5.5-pro` | Only worth the cost when the task genuinely needs it — and the **per-user rate limiter exists specifically to cap these bills** |

**The cheap-tier pin is real, not advisory.** `SUMMARY_MODEL` is hardcoded at
[index.ts:319](../../../../backend/index.ts) and used by `buildConversationHistory`'s `generateText`
call ([index.ts:356-363](../../../../backend/index.ts)) — compaction never runs on the premium model
regardless of what the user picked for the answer. The same cheap-vs-Sonnet split governs the finance
narratives (market **summary** = Haiku, **research** notes = Sonnet — see **finance-markets**'
`summary.ts`/`research.ts`).

**Why premium is gated by the rate limiter.** The comment at [index.ts:82-86](../../../../backend/index.ts)
is explicit: without the per-user limit, *"any signed-in user can loop the endpoint and run up Tavily
+ embedding + premium-model (gpt-5.5-pro/opus) bills."* Premium models are the most expensive line
item, which is exactly why selection and rate-limiting are designed together (see
**hooks-and-guardrails.md**).

---

## 5. The embedding model (the cache key)

`embedQuery` ([index.ts:430-441](../../../../backend/index.ts)) shows embeddings ride the **same
gateway mechanism** as chat — a bare string id, no OpenAI SDK:

```ts
// Bare string id → routed through the Vercel AI Gateway, like the chat models.
const { embedding } = await embed({ model: "openai/text-embedding-3-small", value: query });
```

| Aspect | Reality |
|---|---|
| Id | `"openai/text-embedding-3-small"` — bare gateway id, **not** in `ALLOWED_MODELS` |
| Why not in the allowlist | It's never user-selectable; it's an internal infra choice for the semantic cache, not an answer model |
| What it keys | The pgvector `cached_query.embedding` column; cosine distance `<=>` with `DISTANCE_THRESHOLD = 0.15` ([index.ts:395](../../../../backend/index.ts)) |
| Failure mode | An embed failure is a **cache MISS only** — it does NOT pause the cache; the live path runs ([index.ts:436-440](../../../../backend/index.ts)) |
| Skipped when | Time-sensitive queries + attachment requests bypass the cache → no embed call ([index.ts:671-672](../../../../backend/index.ts)) |

**Caution — changing the embedding model is a breaking migration, not an allowlist edit.** Existing
`cached_query` rows hold vectors from `text-embedding-3-small`; a different model produces a different
vector space, so distances become meaningless and old rows must be re-embedded or purged. Treat the
embedding id as a schema-coupled constant. (Internals → **rag-retrieval**.)

---

## 6. Multimodal gating — model capability vs the id

`buildAttachmentParts` ([index.ts:285-295](../../../../backend/index.ts)) turns uploads into `image`/
`file` content parts, but it does **not** check the model. The capability requirement is on the
*resolved* model: the comment at [index.ts:276-278](../../../../backend/index.ts) warns *"The model
must be vision/doc-capable (Claude, Gemini, GPT) — Sonar won't read them."* Today every id in
`ALLOWED_MODELS` is vision-capable, so the gate is implicit — but if you add a **text-only** model to
the allowlist, you must guard the attachment path against it (or strip parts), or the model silently
ignores the upload. See **multimodal-attachments.md**.

---

## 7. How to add / change a model (checklist)

To wire a **new chat model** the user can pick:

1. **Add the bare id to `ALLOWED_MODELS`** ([index.ts:67-76](../../../../backend/index.ts)) in exact
   `"provider/model"` gateway form (confirm the model segment spelling against the Gateway catalog —
   a wrong segment surfaces as a gateway *"model does not exist"* error at call time, **not** a build
   error, since it's just a string).
2. **Keep the frontend picker in sync** — the comment at [index.ts:65-66](../../../../backend/index.ts)
   says so explicitly (*"Keep in sync with the frontend picker."*). An id the UI offers but the
   allowlist rejects silently downgrades to `DEFAULT_MODEL`; an id the allowlist has but the UI hides
   is simply unreachable.
3. **If text-only**, gate the attachment path (§6) so uploads don't get silently dropped.
4. **Premium?** Confirm the per-user rate limiter ([index.ts:87-96](../../../../backend/index.ts))
   still bounds worst-case spend; consider it before exposing a costly model.
5. **No new env var.** The same `AI_GATEWAY_API_KEY` covers it — that's the whole point. Do **not**
   add a provider SDK or a provider key.
6. **Cache coexistence is automatic** — the cache keys on `model`, so the new id gets its own cache
   namespace; no migration needed for a new chat model (unlike the embedding model, §5).

To change `DEFAULT_MODEL` or `SUMMARY_MODEL`: edit the one constant
([index.ts:77](../../../../backend/index.ts) / [index.ts:319](../../../../backend/index.ts)). Cheap
jobs should stay on a cheap model — don't promote `SUMMARY_MODEL` to Sonnet/Opus "for quality"; its
output is intermediate context, not a user-facing answer.

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Importing `@anthropic-ai/sdk` / `openai` and newing a provider client per model. | Pass the bare `"provider/model"` string to `streamText`/`embed`; the Gateway + one `AI_GATEWAY_API_KEY` routes it. |
| Hardcoding a model literal at the `streamText` call site. | Resolve it: `resolveModel(req.body.model)` → allowlist or `DEFAULT_MODEL`. |
| Trusting `req.body.model` raw (no validation). | `resolveModel` validates against `ALLOWED_MODELS`; an unknown id falls back, never errors the request. |
| Adding a model id but forgetting the frontend picker (or vice-versa). | Update `ALLOWED_MODELS` **and** the picker together — they must list the same ids. |
| Running compaction / the market summary on the premium answer model. | Pin internal LLM jobs to `SUMMARY_MODEL` (Haiku-class); the output is consumed by code, not read as a flagship answer. |
| Exposing a premium model (opus/gpt-5.5-pro) with no spend cap. | Keep the per-user rate limiter; it exists precisely to bound premium-model bills. |
| Swapping the embedding model like it's an allowlist edit. | It's a vector-space change — re-embed/purge `cached_query` first; treat the embedding id as schema-coupled. |
| Reading a budget-model's cached answer for a premium request (or ignoring `model` in the cache key). | Key the semantic cache on `(embedding, model)` — resolve `model` up front before the cache lookup. |
| Adding a text-only model to the allowlist while the attachment path stays unguarded. | Gate `buildAttachmentParts` consumers on vision/doc capability, or strip parts for text-only models. |
| Assuming a wrong `"provider/model"` string fails the build. | It's just a string — a bad id fails at **call time** as a gateway error; verify the segment against the catalog when adding it. |

---

## 9. Quick reference

| You want to… | Do this |
|---|---|
| Let users pick a new model | Add bare id to `ALLOWED_MODELS` + the frontend picker; no new key |
| Change the global default | Edit `DEFAULT_MODEL` ([index.ts:77](../../../../backend/index.ts)) |
| Make compaction/narratives cheaper or better | Edit `SUMMARY_MODEL` ([index.ts:319](../../../../backend/index.ts)) — keep it cheap |
| Debug "model does not exist" | The id segment is wrong, OR `AI_GATEWAY_API_KEY` is missing/bad (note: this gateway-credential error must NOT be mistaken for the DB `42P01` cache error — see [index.ts:419-427](../../../../backend/index.ts)) |
| Understand why premium spend is capped | The per-user rate limiter → **hooks-and-guardrails.md** |
| Claude id/pricing/caching specifics | → **claude-api** skill (deferred on purpose) |
| Embedding / semantic-cache internals | → **rag-retrieval** |
