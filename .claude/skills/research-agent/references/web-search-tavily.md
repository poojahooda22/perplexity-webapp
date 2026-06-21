# Web Search with Tavily — calling, tuning, and shaping into sources

> The Tavily SDK as Lumina uses it: the search call's knobs (`searchDepth`, `topic`, `days`,
> `includeImages`, `maxResults`), the **400-char query cap**, the depth↔latency tradeoff, and how
> raw Tavily results get shaped into the numbered `sources[]`/`images[]` the answer cites. This is
> a **generic-domain** ref (reusable Tavily knowledge) grounded in our two call sites. For what
> happens to those results downstream — the `[n]` contract, `formatSearchContext`, the `<SOURCES>`
> wire tail — read **`source-grounding-and-citations.md`**. For *when* a query needs deeper/multi
> search → **`deep-research-patterns.md`**; for the whole request flow → **`lumina-research-pipeline.md`**.

Lumina calls Tavily in two places, with two different shapes:

| Call site | Function | Shape | Purpose |
|---|---|---|---|
| Discover/search pre-search | `webSearch` in [`backend/index.ts`](../../../../backend/index.ts) | `basic` + images + `maxResults:10`, broad web | One-shot grounding for `/perplexity_ask` |
| Finance agent tool | `financeWebSearch` in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts) | `basic` + `topic:"news"` + `days:7` + `maxResults:6` | Model-driven news lookup mid tool-loop |

The contrast between them IS the lesson: same SDK, tuned per use-case.

---

## 1. The SDK surface

```ts
import { tavily } from "@tavily/core";
const client = tavily({ apiKey: process.env.TAVILY_API_KEY });   // server-side key ONLY
const response = await client.search(query, options);
```

`client.search(query, opts)` returns `{ results, images?, ... }`. Each `result` is
`{ title, url, content, score?, raw_content? }`. `content` is Tavily's extracted snippet (a few
hundred chars of the page's relevant text) — not the full page. `images` is present only when
`includeImages:true` (see §4).

### Options that matter (and our values)

| Option | Type | Our Discover value | Our finance value | What it does |
|---|---|---|---|---|
| `searchDepth` | `"basic"｜"advanced"` | `"basic"` | `"basic"` | Crawl/extract depth. `advanced` does deeper page extraction + reranking — slower. |
| `maxResults` | number | `10` | `6` | How many result rows come back. More = richer context but bigger prompt + slower first token. |
| `includeImages` | bool | `true` | _(unset)_ | Adds an `images` array (see §4). Off for finance — news answers don't need them. |
| `topic` | `"general"｜"news"` | _(unset → general)_ | `"news"` | `news` biases toward dated news publishers + enables `days`. |
| `days` | number | _(n/a)_ | `7` | With `topic:"news"`, restrict to the last N days. Recency window for "what happened." |

We do not set `includeAnswer`, `includeRawContent`, or domain include/exclude lists today —
they're available if a future feature needs an LLM-free TL;DR, full-page text, or source allow/deny.

---

## 2. The 400-char query cap (non-negotiable)

**Tavily 400s on search strings longer than ~400 chars.** Lumina trims the SEARCH string only —
the FULL user prompt still reaches the LLM (which has no such cap), via `buildUserPrompt`.

```ts
// webSearch, backend/index.ts
const searchQuery = query.length > 400 ? query.slice(0, 400) : query;
const response = await tavily_client.search(searchQuery, { searchDepth: "basic", includeImages: true, maxResults: 10 });
```

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Send the raw 800-char user question to Tavily → HTTP 400, whole request fails. | `query.slice(0, 400)` for the search string; full prompt still goes to the LLM. |
| Trim the prompt too, "to be safe." | Never trim the LLM prompt — it loses the user's actual question. Only the search string is capped. |
| Build a giant boolean query to "cover everything." | Tavily is semantic, not boolean. A focused natural-language query out-retrieves a keyword soup — and stays under 400. |

`financeWebSearch` does NOT slice, because the model supplies the query and the persona asks for
"a focused finance search query" — model-authored queries are short by construction. If you ever
let a tool forward a user-pasted blob, add the same `.slice(0, 400)` guard.

---

## 3. `searchDepth` — the depth↔latency dial

`basic` is the **deliberate default** in both call sites. From the live comment in `webSearch`:

> `"basic"` is ~1.5–2.5s faster than `"advanced"` and is plenty for general queries — the single
> biggest latency win on the miss path.

```
basic     ── fast first token, shallow extract  ◄── DEFAULT (both call sites)
advanced  ── deeper page extraction + rerank, +1.5–2.5s
```

`basic` + `maxResults:10` is a tuned operating point, not laziness. The anti-pattern is bumping
the whole pipeline to `advanced` "to improve quality": you pay the latency on **every** miss
(including the 80% of queries that didn't need it) and the user feels a slower app.

### Decision framework — when to deepen a single search

Deepen only when the query class genuinely needs more extraction, and prefer per-class over global:

| Signal the query needs `advanced` / more results | Action |
|---|---|
| `compare` query (needs facts from several deep pages) | `searchDepth:"advanced"` for that `QueryType` (route on `classifyQuery`). |
| `latest`/news where snippets are thin | Keep `basic`, add `topic:"news"` + `days` (recency beats depth here). |
| Niche/technical topic, snippets miss the detail | `advanced` + raise `maxResults` toward 12–15. |
| The answer must reconcile *many* sources / verify claims | Don't deepen one search — fan out into a multi-search run → **`deep-research-patterns.md`**. |
| General "what is X" / "how do I Y" | Stay `basic` + 10. Deepening adds latency, not accuracy. |

Rule of thumb: **recency problems → `topic:"news"`+`days`; thin-extract problems → `advanced`;
breadth/verification problems → more searches, not a deeper one.**

---

## 4. Images (`includeImages`)

Discover sets `includeImages:true`; the answer view renders a thumbnail strip. Tavily returns
images in **two shapes** depending on account settings, so normalize defensively:

```ts
// webSearch — Tavily returns bare URL strings OR {url, description} objects.
const rawImages = (response.images ?? []) as Array<string | { url: string; description?: string }>;
const images = rawImages.map((img) =>
  typeof img === "string" ? { url: img } : { url: img.url, description: img.description },
);
```

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| `response.images.map(u => ({url: u}))` assuming strings. | Handle both `string` and `{url, description}` (and `?? []` for absent). |
| Turning images on for every vertical. | Finance/assistant leave it off — fewer bytes, faster. Turn on only where the UI shows them. |

`images` rides the same `<IMAGES>` wire tail as `sources` (see `source-grounding-and-citations.md`),
so a reloaded conversation re-renders them identically.

---

## 5. Shaping results → sources (two patterns)

### A) Discover: one-shot, positional numbering

`webSearch` keeps the full `results` (for the LLM context block) AND a slimmed `sources` (for the
client + persistence). **Order is the contract** — the same `results` array feeds `formatSearchContext`
(which numbers them `[i+1]`) and the `<SOURCES>` tail, so `[n]` in the prose lines up with what the UI shows.

```ts
const results = response.results;
const sources = results.map((r) => ({ title: r.title, url: r.url, content: r.content }));
// downstream: formatSearchContext(results) numbers [1]..[n]; sourcesImagesTail(sources, images) persists them
return { results, sources, images };
```

### B) Finance agent: incremental, GLOBAL numbering across tool calls

The model may call `financeWebSearch` several times in one turn. Each call **appends** to a single
shared `sources[]` (from `buildFinanceTools()`) and hands back `n` = the running global index — so
citations stay consistent across multiple searches in the same answer.

```ts
// financeWebSearch, backend/finance/tools.ts
const numbered = results.map((r) => {
  sources.push(r);                                  // shared per-request accumulator
  return { n: sources.length, title: r.title, url: r.url, snippet: r.content };
});
return { sources: numbered };                        // model cites [n]; route emits <SOURCES> from the same array
```

It also pre-trims each snippet to 800 chars (`(r.content ?? "").slice(0, 800)`) to keep tool-result
payloads small in the model's context.

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Renumber/reorder sources after the model already cited `[n]`. | Keep insertion order fixed from search → context → tail. `[n]` is positional. |
| Give each finance tool call its own `[1..k]` numbering. | Use one shared accumulator with a running `sources.length` so numbers are global across calls. |
| Stream the model's full `result.content` (5–10 KB) into the prompt as context. | Slice snippets (`content.slice(0, 1200)` Discover / `800` finance) — Tavily's snippet is already the relevant extract. |

---

## 6. Latency & cost budget

Tavily is a paid metered API — **one credit per `search` call** (advanced/extras cost more). Two
guards in the codebase protect both latency and the bill:

| Mechanism | Where | Effect |
|---|---|---|
| Skip search on a **semantic-cache hit** | `findCachedAnswer` gate in `index.ts` (`cacheable` path) | A near-duplicate cached query replays with **zero** Tavily calls. Cache internals → **rag-retrieval**. |
| **Per-minute budget** on the finance tool | `withinBudget("financeWebSearch", 10)` in `tools.ts` | Caps the agent at 10 searches/min; over budget → typed `{unavailable}`, not an exception. |
| `basic` depth default | both call sites | The single biggest miss-path latency win (~1.5–2.5s). |
| `abortSignal` on the stream | `disconnectSignal(res)` | A client disconnect stops the tool loop (incl. further searches) — no wasted credits. |

Note the **asymmetry**: Discover's `webSearch` is NOT itself budget-wrapped (it's gated by the
20/min per-user `rateLimited` + the semantic cache instead), while `financeWebSearch` is, because
the agent can fire several searches per turn unbounded by the per-request user limit.

```ts
// financeWebSearch budget guard — fail soft, never throw at the model
if (!withinBudget("financeWebSearch", 10)) {
  return { unavailable: "Web search is rate-limited right now — try again shortly." };
}
```

---

## 7. Error handling

`tavily_client.search` can throw (network, 400 on an over-cap query, upstream 5xx, 429). Behavior
by call site:

- **Discover (`webSearch`)** — not individually try/caught; a throw propagates to the
  `/perplexity_ask` outer `try/catch`, which returns a 500 (pre-stream) or closes the stream
  (`res.end()`) if headers are already flushed. So: **trim to 400 to avoid the avoidable 400, and
  keep the search early** (before `writeStreamHeaders`) so failures can still return a clean 500.
- **Finance (`financeWebSearch`)** — the budget check returns `{unavailable}` (soft), but a Tavily
  *throw* still propagates out of `execute`. The AI SDK surfaces it to `onError`
  (`console.error("finance streamText error", …)`) and the loop stops. For a tool the model relies
  on, prefer wrapping the upstream call so a transient failure returns `{unavailable}` rather than
  killing the turn — same fail-soft contract the data tools use (`{unavailable}`/`{error}`/`{needsKey}`).

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Run `webSearch` *after* `writeStreamHeaders`. | Search BEFORE flushing headers so a failure can still send a JSON 500. |
| Let a Tavily throw inside a tool kill the whole agent turn. | Catch upstream failures → return typed `{unavailable}` so the model can degrade gracefully. |
| Retry a 400 (over-cap) query. | A 400 is deterministic — fix the query length, don't retry. Retry only transient 429/5xx, with backoff. |

---

## 8. Adding / changing a Tavily call — checklist

1. **Server-side only.** Read `TAVILY_API_KEY` from `process.env`; never ship the key to the client.
2. **Cap the search string** to 400 chars if it can include user-pasted text (`.slice(0, 400)`).
3. **Pick the tuned point:** start `basic` + a modest `maxResults`; raise only with a concrete
   per-class reason (§3). Add `topic:"news"`+`days` for recency-bound queries.
4. **Normalize images** to `{url, description?}` if `includeImages:true` (handle string|object).
5. **Preserve order** from results → numbered context → `<SOURCES>` tail; slice snippets for the prompt.
6. **Budget it** if a single request can fire it multiple times (the finance pattern); otherwise
   ensure it's covered by the per-user rate limit + semantic cache.
7. **Fail soft inside tools** (`{unavailable}`); for one-shot pre-search, run it before headers flush.
8. **Verify:** confirm the call actually fires (finance logs `[finance-hook] step tools=[financeWebSearch]`)
   and the cited `[n]` match the rendered `<SOURCES>`.

---

## 9. Quick reference — the two live calls

```ts
// Discover one-shot grounding (backend/index.ts → webSearch)
await tavily_client.search(query.slice(0, 400), {
  searchDepth: "basic",   // latency win; deepen per QueryType only
  includeImages: true,    // Discover renders a thumbnail strip
  maxResults: 10,         // broad net; lower to ~6 for faster first token
});

// Finance agent news tool (backend/finance/tools.ts → financeWebSearch)
await tvly.search(query, {
  searchDepth: "basic",
  topic: "news",          // bias to news publishers
  days: 7,                // last week only
  maxResults: 6,          // tight — keeps tool-result payload small
});
```
