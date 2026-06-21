# Cache Freshness & Invalidation — keeping the semantic cache honest

> When the answer-cache is allowed to ANSWER, and when it must stand aside. The four freshness
> gates that decide read/write — `CACHE_TTL_DAYS`, the `TIME_SENSITIVE` regex, the
> `(embedding, model)` key, and the `finishReason === "stop"` write guard — plus the
> cooldown-then-reprobe self-heal that replaced the old permanent kill-switch. Read this when a
> stale/wrong/missing cached answer is the symptom, or before you touch any of those tunables.
> For the cache's full machinery (`embedQuery` → `findCachedAnswer` → replay → `cacheAnswer`)
> read the sibling `lumina-semantic-cache.md`; for the distance/threshold math read
> `pgvector-and-postgres.md`; for why this is a CACHE and not RAG read
> `semantic-cache-vs-knowledge-rag.md`. All code is the "Vector / semantic-cache layer" block in
> [`backend/index.ts`](../../../../backend/index.ts) (around fn `noteCacheError`/`findCachedAnswer`
> and the `/perplexity_ask` handler near the `cacheable` line).

The mental model: the cache is a **pure optimization** that replays a past `<ANSWER>`/`<SOURCES>`
wire payload to skip a fresh Tavily search + LLM generation. Every freshness decision answers one
question — *"is replaying this old answer still correct?"* If the answer can drift (time), differ
by model, never finished cleanly, or the underlying source is the upload itself, the cache must not
serve it. Getting freshness wrong doesn't crash anything; it silently serves a wrong answer for up
to 7 days. That's the failure this doc prevents.

---

## 1. The freshness gates at a glance

| Gate | Mechanism | Blocks READ? | Blocks WRITE? | Why |
|------|-----------|:---:|:---:|-----|
| **Time sensitivity** | `isTimeSensitive(query)` via `TIME_SENSITIVE` regex | ✅ | ✅ | A cached price/score/"today" answer is stale the moment it's stored. |
| **Attachments** | `parts.length === 0` (from `buildAttachmentParts`) | ✅ | ✅ | The answer depends on the uploaded file, not the query text alone. |
| **TTL** | `created_at > now − CACHE_TTL_DAYS` in the lookup SQL | ✅ | — | Old rows silently age out of the candidate set; no eviction job needed. |
| **Model key** | `WHERE model = ${model}` + stored `model` column | ✅ | — | Opus and Haiku give different answers; replaying across models is a correctness bug. |
| **Clean finish** | `finishReason === "stop" && fullAnswer.trim()` | — | ✅ | Never persist a truncated/aborted/errored stream to be replayed for the whole TTL. |
| **Infra cooldown** | `cacheDown()` / `cacheDownUntil` (only `42P01`) | ✅ | ✅ | DB table missing → pause briefly, then re-probe; self-heal, don't latch off. |

All gates compose into two booleans at the call site in `/perplexity_ask`:

```ts
const model     = resolveModel(req.body.model);
const parts     = buildAttachmentParts(req.body.attachments);
const cacheable  = !isTimeSensitive(query) && parts.length === 0;   // read AND write eligibility
const embedding  = cacheable ? await embedQuery(query) : null;
const cached     = cacheable ? await findCachedAnswer(embedding, model) : null;
// …live path…
if (cacheable && finishReason === "stop" && fullAnswer.trim()) {
    await cacheAnswer({ query, embedding, model, answer: fullAnswer, sources, images });
}
```

`cacheable` is computed **once** and gates both the read (`findCachedAnswer`) and the write
(`cacheAnswer`) — they can never disagree. TTL and model-key are enforced *inside* the lookup SQL;
clean-finish is the only write-side-only gate.

---

## 2. TTL — `CACHE_TTL_DAYS`, enforced in the query (not by eviction)

`CACHE_TTL_DAYS = 7`. There is **no eviction job and no `expiresAt` column** — staleness is enforced
purely as a filter on read:

```ts
const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
// …
WHERE model = ${model} AND created_at > ${cutoff}
ORDER BY embedding <=> ${vec}::vector
LIMIT 1
```

Rows older than the cutoff are simply invisible to the lookup; they linger in the table harmlessly
until you choose to prune. This is the right default for an optimization cache: a stale row costs
disk, not correctness, because it can never be selected.

**Choosing the TTL — what bounds it:**

| Consideration | Pull |
|---|---|
| Evergreen factual queries ("how does TCP work") | longer TTL is fine — the answer doesn't drift |
| Soft-fresh topics already past the `TIME_SENSITIVE` net ("best laptop") | shorter TTL — quietly drifts over weeks |
| Source/citation rot (Tavily URLs in the stored `sources` go dead) | shorter TTL — the cited links decay |
| Hit-rate / cost savings | longer TTL → more hits → more saved LLM+Tavily spend |

7 days is a deliberate middle: long enough to catch the burst of near-duplicate queries that follow
a trending topic, short enough that source rot and slow drift self-correct. **Tune against logs**,
not vibes — if you raise it, sample old hits and confirm the answers (and their links) still hold.

> Pruning, when you want it: a periodic `DELETE FROM cached_query WHERE created_at < now() - interval
> '14 days'` (raw SQL, like all vector ops — the typed client doesn't model the `vector` column).
> Purely a housekeeping concern; correctness already comes from the read-time `cutoff`.

---

## 3. Time-sensitive exclusion — the regex that protects finance

The single most important freshness gate. `TIME_SENSITIVE` (in `index.ts`, just above
`isTimeSensitive`) is a case-insensitive `\b`-anchored alternation:

```ts
const TIME_SENSITIVE =
    /\b(today|now|currently|current|latest|live|breaking|news|price|prices|stock|stocks|score|scores|weather|tonight|right now|this (week|month|year)|yesterday|tomorrow|202\d)\b/i;
```

If it matches, `cacheable` is `false` → **no read and no write**. The query always falls through to
the live Tavily + LLM path and its answer is never stored.

| Pattern class | Examples it catches |
|---|---|
| Temporal deictics | `today`, `now`, `currently`, `tonight`, `right now`, `yesterday`, `tomorrow` |
| Recency words | `latest`, `live`, `breaking`, `news`, `current` |
| Market/score/weather nouns | `price(s)`, `stock(s)`, `score(s)`, `weather` |
| Rolling windows | `this week/month/year` |
| Year literals | `202\d` — any "2020"–"2029" in the query |

**Design properties to preserve:**
- **`\b` word boundaries** — `priced` or `historic` must not trip on `price`/`stoic`. Keep new
  terms boundary-anchored; never add bare substrings.
- **Fail-safe direction.** A false positive (treating an evergreen query as time-sensitive) costs
  one extra live generation — cheap. A false negative (caching a price) serves a stale number for 7
  days — the worst failure. When unsure, **bias toward inclusion**.
- **`202\d` is the cheap year-guard**, not a true date parser. It will need maintenance at the
  decade boundary (extend to `20[23]\d` etc.) — leave a comment when you touch it.

This regex is *coarse on purpose*. It's a fast pre-filter, not an NLU classifier; the goal is to
never cache a drifting answer, accepting that some evergreen queries are needlessly excluded.

---

## 4. Model-keyed entries — never serve Haiku's answer to Opus

The cache key is the pair **(query embedding, model)**, not the embedding alone. The model is part
of both the read filter and the stored row:

```ts
// read: candidate set is scoped to the requesting model
WHERE model = ${model} AND created_at > ${cutoff}
// write: model stored alongside the embedding + answer
INSERT INTO cached_query (id, query_text, model, embedding, answer, sources, images, created_at) …
```

The model is resolved **before** the lookup (`const model = resolveModel(req.body.model)`) precisely
because it's the cache key. Two requests with byte-identical text but different `model` params hit
two independent cache namespaces.

**Why this is non-negotiable:** answer quality, length, and style differ per model. A user (or tier)
that paid for `claude-opus` must never be replayed a `claude-haiku` answer that happened to match the
embedding. Dropping the `model` filter would make the cache an accuracy regression that's invisible
in testing (the text "looks like an answer") and only shows up as quality complaints. The embedding
captures *what was asked*; the model captures *how well it was answered* — you need both to call two
requests "the same".

---

## 5. The clean-finish write guard — don't poison the cache

A truncated answer cached once is replayed to **every near-duplicate query for the full TTL**. So the
write is gated on a clean terminal state:

```ts
let finishReason: string;
try { finishReason = await result.finishReason; } catch { finishReason = "error"; }
// …
if (cacheable && finishReason === "stop" && fullAnswer.trim()) {
    await cacheAnswer({ query, embedding, model, answer: fullAnswer, sources, images });
}
```

| `finishReason` (or state) | Cached? | Reason |
|---|:---:|---|
| `"stop"` + non-empty `fullAnswer` | ✅ | Model finished on its own — a complete, replayable answer. |
| `"length"` | ❌ | Hit the token cap mid-thought — truncated. |
| `"error"` (or the `await` threw) | ❌ | Generation broke; the buffer is partial/garbage. |
| client disconnect (`abortSignal`) | ❌ | Stream aborted; `finishReason` won't be `"stop"`. |
| `"stop"` but `fullAnswer.trim()` empty | ❌ | Nothing useful to store. |

The `try/catch` around `await result.finishReason` is itself a freshness safeguard: if even reading
the finish reason throws, it's coerced to `"error"` so a broken stream can't accidentally satisfy the
guard. **The write side is strictly stricter than the read side** — `cacheable` alone permits a read,
but a write additionally demands a clean finish.

---

## 6. When to bypass — the decision framework

```
Incoming /perplexity_ask query
│
├─ time-sensitive? (TIME_SENSITIVE regex) ───────────► BYPASS (no read, no write)
├─ has attachments? (parts.length > 0) ──────────────► BYPASS (no read, no write)
├─ follow-up turn? (/perplexity_ask/follow_up) ──────► NOT WIRED to the cache at all
│
└─ cacheable ──► embedQuery ──► findCachedAnswer(embedding, model)
        │                              │
        │                              ├─ row within TTL, same model, distance ≤ THRESHOLD ─► HIT → replay
        │                              └─ none ─────────────────────────────────────────────► MISS
        │
        └─ on MISS: live path → if finishReason==="stop" && non-empty ─► cacheAnswer (write)
```

| Situation | Cache behavior | Where |
|---|---|---|
| "Today's BTC price", "latest news on X", "2026 elections" | Bypass entirely (regex) | `isTimeSensitive` gate |
| Query with an uploaded image/PDF | Bypass entirely (answer depends on the file) | `parts.length === 0` gate |
| **Follow-up turns** | The cache is **only** wired into first-turn `/perplexity_ask`; `/perplexity_ask/follow_up` never reads or writes it | call sites in `index.ts` |
| Embedding service down / 500 | Treated as a MISS (no key → no lookup) | `embedQuery` catch → `return null` |
| DB table missing (`42P01`) | Paused for `CACHE_COOLDOWN_MS`, then re-probed | §7 |
| Near-duplicate but distinct query (e.g. "learn React" vs "learn React Native") | MISS by design — distance sits above `DISTANCE_THRESHOLD` (0.15) | `findCachedAnswer` |

Why follow-ups are excluded by construction: a follow-up's correct answer depends on the prior
conversation, which the single-query embedding doesn't capture — so caching it would be a false-hit
hazard, and the design simply never invokes the cache there. (See `research-agent` for follow-up
compaction.) Don't "fix" this by adding a cache to follow-ups without a key that encodes history.

---

## 7. Self-heal: cooldown-then-reprobe vs the permanent kill-switch

Cache-infra errors must **pause, not latch**. The cache exposes a time-windowed availability flag,
not a boolean "disabled forever":

```ts
const CACHE_COOLDOWN_MS = 60_000;
let cacheDownUntil = 0;
function cacheDown(): boolean { return Date.now() < cacheDownUntil; }

function noteCacheError(where: string, e: unknown): void {
    const code = (e as { code?: string })?.code;
    const msg  = e instanceof Error ? e.message : String(e);
    // ONLY a genuine Postgres "undefined_table" (42P01) pauses the cache. We do NOT
    // free-text match "does not exist" — the AI Gateway returns "model does not exist…"
    // for credential issues, which must never be mistaken for a DB problem.
    if (code === "42P01") {
        cacheDownUntil = Date.now() + CACHE_COOLDOWN_MS;
        console.warn(`[semantic-cache] table missing (${where}) — pausing ${CACHE_COOLDOWN_MS / 1000}s then retrying.`);
        return;
    }
    console.error(`[semantic-cache] ${where} failed:`, msg);
}
```

`embedQuery`, `findCachedAnswer`, and `cacheAnswer` each short-circuit on `cacheDown()` and route
their catch through `noteCacheError`. The result:

| Failure | Action | Self-heals? |
|---|---|---|
| Postgres `42P01` (table doesn't exist — migration not run yet) | Set `cacheDownUntil = now + 60s`; log once | ✅ After the cooldown the next request re-probes; if the migration has since run, the cache is live again with **no restart**. |
| Embedding 500 / network blip | Logged; returns `null` → treated as a MISS | ✅ Next request tries again immediately — never pauses the whole cache. |
| Any other DB error | Logged, no pause | ✅ Re-attempted next request |

**Why this design over the old latch:**
- The earlier behavior ("disable the cache for the process on first error") meant a server that
  booted *before* the table existed stayed cache-less until a manual restart — operationally brittle
  on serverless where you don't control instance lifetime.
- The cooldown bounds **log spam** (one warning per 60s window, not per request) while keeping the
  cache trying to recover.
- **Narrow trigger by error code, never by message text.** Only `e.code === "42P01"` pauses. The AI
  Gateway returns `"model does not exist…"` for credential/model issues — a free-text
  `includes("does not exist")` would mistake an *embedding-auth* problem for a *DB* problem and pause
  the cache for the wrong reason. Match the structured Postgres code, full stop.

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Caching a "today's price / latest news" answer because the embedding matched. | Gate with `isTimeSensitive`; time-sensitive queries skip cache for **both** read and write. |
| Adding a bare substring (e.g. `"score"` → would catch `"scoreboard design"`… and `"escore"`) to the regex. | Keep every term `\b`-anchored; bias toward over-inclusion, but never un-anchored. |
| Serving a cache hit across models ("an answer is an answer"). | Key on `(embedding, model)`; `WHERE model = ${model}` + store `model`. Resolve the model BEFORE the lookup. |
| Caching a stream that hit the token cap or errored, then replaying it for 7 days. | Only `cacheAnswer` when `finishReason === "stop"` and `fullAnswer.trim()` is non-empty. |
| Letting a cache/embed/DB error bubble up and 500 the user's request. | Fail-open: catch → MISS / no-op; the live Tavily+LLM path always runs. |
| Permanently disabling the cache on the first DB error (the old latch) — requires a restart to recover. | Short `CACHE_COOLDOWN_MS` cooldown + re-probe; only `42P01` trips it; self-heals after the migration runs. |
| Detecting "table missing" by `error.message.includes("does not exist")`. | Match `e.code === "42P01"` — the Gateway's "model does not exist" is NOT a DB fault. |
| Building a cron eviction job / `expiresAt` column to expire rows. | TTL is enforced at read time via the `created_at > cutoff` filter; stale rows are just never selected. Prune only for disk hygiene. |
| Adding the cache to `/perplexity_ask/follow_up` with the same single-query key. | A follow-up's answer depends on conversation history the single embedding can't capture — keep it bypassed unless the key encodes history. |
| Caching an answer for an uploaded file (image/PDF). | `parts.length === 0` gate — the answer depends on the upload, not the query text. |
| Raising `CACHE_TTL_DAYS` to boost hit-rate without checking source rot. | Sample old hits first; confirm answers + cited links still hold. Longer TTL trades freshness for savings. |

---

## 9. Verifying a freshness change

1. **Time-sensitive bypass:** issue "BTC price today" → confirm a live generation runs and **no row**
   is written (`SELECT count(*) FROM cached_query WHERE query_text = 'BTC price today'` → 0).
2. **Model isolation:** ask an evergreen question on model A (writes a row), repeat on model B →
   confirm a MISS + a second row, not a cross-model replay.
3. **Clean-finish guard:** force a truncated stream (low max tokens or a disconnect) → confirm
   nothing is cached; ask again → confirm a fresh live answer, not a replay of the stub.
4. **TTL:** backdate a row's `created_at` past the cutoff → confirm the identical query MISSES.
5. **Self-heal:** drop/rename `cached_query`, hit the endpoint → see one `table missing … pausing 60s`
   warning, requests keep answering; recreate the table → after the cooldown, hits resume **without a
   restart**.
6. **Near-miss threshold:** "learn React" vs "learn React Native" must land on opposite sides of
   `DISTANCE_THRESHOLD` (the second MISSES) — see `pgvector-and-postgres.md` for tuning.

> Dev gotcha: the cache lives in `backend/index.ts` (an existing file), so edits hot-reload — but any
> NEW backend file needs a full `bun` restart (`--hot` misses new files), and relative imports carry
> an explicit `.js`. (See the finance architecture ref for the full deploy-landmine table.)
