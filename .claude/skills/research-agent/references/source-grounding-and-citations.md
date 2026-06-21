# Source Grounding & the `[n]` Citation Contract

> How Lumina turns Tavily results into a numbered, citeable context block, forces the model to
> answer ONLY from those results, and ships the sources back to the UI as a `<SOURCES>` wire tail
> whose order MUST stay locked to the inline `[n]` numbers. This is a `lumina-` ref — every claim
> cites live code in [`backend/index.ts`](../../../../backend/index.ts) and
> [`backend/prompt.ts`](../../../../backend/prompt.ts) (line numbers drift; re-grep before editing).
> Adjacent refs: the full request wiring is in `lumina-research-pipeline.md`; tuning the Tavily call
> (depth/images/cap) is in `web-search-tavily.md`; the `<ANSWER>`/`<FOLLOW_UPS>` half of the wire
> protocol is in `answer-protocol-and-followups.md`; the finance tool-loop's reuse of the SAME `[n]`
> mechanism is owned by **finance-markets** (`ai-sdk-finance-agent.md`) — summarized here in §6.

---

## 1. The one invariant: positional `[n]` ↔ ordered sources

There is exactly **one** number space in a Discover answer, and it is **positional array order**.
The same ordered `results` array is rendered three ways, and all three MUST agree:

| Surface | Who produces it | Where | The `[n]` mapping |
|---|---|---|---|
| The numbered context block fed to the LLM | `formatSearchContext` | [`backend/index.ts`](../../../../backend/index.ts) `formatSearchContext` (~L299) | `[i+1]` for `results[i]` |
| The model's inline citations in prose | the LLM, following `PERSONA` | `PERSONA` "## Citations" in [`backend/prompt.ts`](../../../../backend/prompt.ts) (~L35) | `[1]`,`[2]`… must match the block |
| The `<SOURCES>` JSON the UI renders as clickable chips | `sourcesImagesTail(sources, images)` | [`backend/index.ts`](../../../../backend/index.ts) `sourcesImagesTail` (~L142) | `sources[i]` ↔ `[i+1]` |

`sources` and `results` come from the **same** `webSearch` return, in the **same** order
(`webSearch`: `const sources = results.map((r) => ({ title, url, content }))`, ~L130). So the model
sees `[3] <title>` in the context, writes `[3]`, and the UI's third chip is the same URL. **Renumber
or reorder either side after the model has cited and the links silently point at the wrong source** —
the single worst, hardest-to-spot bug in this pipeline.

```
webSearch(query)  ──►  { results, sources, images }      // ONE ordered array, two shapes
        │                      │              │
        │ results              │ sources      │ images
        ▼                      ▼              ▼
formatSearchContext(results)   sourcesImagesTail(sources, images)
   "[1] … [2] … [10] …"           "<SOURCES> [{title,url,content},…] <SOURCES>"
        │                                     │
        └──► system+user prompt ──► LLM ──► "…claim [3]…" ──► UI matches chip #3 ◄┘
```

---

## 2. `formatSearchContext` — the numbered, sliced context block

The function that makes results citeable (in [`backend/index.ts`](../../../../backend/index.ts),
`formatSearchContext`, ~L299):

```ts
function formatSearchContext(
  results: Array<{ title?: string; url: string; content?: string }>,
): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title ?? r.url}\nURL: ${r.url}\n${(r.content ?? "").slice(0, 1200)}`)
    .join("\n\n");
}
```

Design choices that matter, and the reason behind each:

| Choice | Code | Why |
|---|---|---|
| **1-based numbering** | `[${i + 1}]` | Humans + the model count from 1; `[0]` reads as a footnote-less token. |
| **Title (or URL fallback) on the header line** | `${r.title ?? r.url}` | A Tavily result with no title still gets a stable label, so `[n]` is never blank. |
| **Each source's `content` capped at 1200 chars** | `.slice(0, 1200)` | 10 results × full Tavily snippets blows the prompt + first-token latency; 1200 keeps enough to ground a claim. (Finance's `financeWebSearch` slices to 800 — a tighter tool budget; see §6.) |
| **Blank-line separator between sources** | `.join("\n\n")` | Clean visual + token boundary so the model never bleeds source 2's text into `[1]`. |

`formatSearchContext(results)` is passed as `searchContext` into `buildUserPrompt({ query,
searchContext, date })` ([`backend/prompt.ts`](../../../../backend/prompt.ts) ~L130) — both on the
fresh path (`/perplexity_ask` step 5, ~L698) and the follow-up path (~L839). `buildUserPrompt`
wraps it under a literal header the persona refers to:

```
## Web search results (numbered — cite these as [n])
[1] …
[2] …
```

So the contract is stated to the model in TWO places that must stay consistent: the block header
("cite these as [n]") and the `PERSONA` "## Citations" rule.

---

## 3. The grounded-only rule (anti-fabrication)

The hardest non-negotiable for a research product. It lives entirely in `PERSONA`
([`backend/prompt.ts`](../../../../backend/prompt.ts) ~L18-22):

> "Write a clear, well-structured answer **grounded ONLY in those results — treat them as your
> single source of truth and never invent facts they don't support. If the results are insufficient,
> say so.**"

And the citation discipline (~L35-38):

> "Cite inline with bracketed numbers like [1], [2] that match the numbered search results…
> Combine like [1][3] when several apply. **Cite generously — most claims should carry a citation.**"

What enforces it, and what does NOT:

| Mechanism | Enforced by | Strength |
|---|---|---|
| "answer ONLY from results, say so if thin" | `PERSONA` prose | Soft — a prompt instruction; the strongest lever we have for a single-call answer. |
| "cite generously, `[n]` must match" | `PERSONA` prose + the block header | Soft — relies on the model. |
| Don't mention "search results" / the instructions | `PERSONA` "## Rules" (~L41) | Soft — keeps the answer reading like a confident original. |
| The model literally cannot fabricate a *source chip* | `<SOURCES>` is built from `sources`, NOT parsed from the model's text | **Hard** — the UI's link list is server-authored; the model only chooses which `[n]` to cite, never invents a URL. |

The deep guarantee: even if the model hallucinates a `[12]` that doesn't exist, there is no 12th
chip — the bracket dangles but no fake link ships, because `sourcesImagesTail` serializes the real
`sources` array, not the model's claims. **Grounding is a prompt rule; non-fabrication of links is
an architecture property.** Keep it that way — never build `<SOURCES>` by scraping `[n]` out of the
generated prose.

---

## 4. The `<SOURCES>` / `<IMAGES>` wire tail

After the answer text streams, the route appends a machine-readable tail
(`sourcesImagesTail` in [`backend/index.ts`](../../../../backend/index.ts) ~L142):

```ts
function sourcesImagesTail(sources: unknown, images: unknown): string {
  return (
    `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n` +
    `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`
  );
}
```

Quirks that are load-bearing — copy them exactly, the frontend parser depends on them:

| Property | Detail | Consequence if changed |
|---|---|---|
| **Closing tag == opening tag** | It's `<SOURCES>…<SOURCES>`, NOT `</SOURCES>`. Same for `<IMAGES>`. | The strip regex (`stripWireTail`) and the frontend split both expect the duplicate-open form. A `</SOURCES>` breaks both. |
| **Two separate JSON blobs** | sources and images are independent arrays. | Images can be empty while sources are full (and vice-versa for assistant/finance). |
| **Appended to the SAME stream as the prose** | `res.write(tail)` after the token loop. | The client receives answer-then-tail in one SSE body; it splits on the tags. |
| **Persisted verbatim with the assistant turn** | `persistTurns(…, fullAnswer, tail)` writes `content + tail` (~L182). | Reloading a conversation from history renders identical links/images — the SAME parser handles live and replayed answers. |

This is why the **fresh, cache-hit, follow-up, finance, and assistant paths all end the same way**:
every branch calls `sourcesImagesTail` so the client never special-cases the source of the answer.

Where each branch's tail comes from:

| Path | sources | images | Code |
|---|---|---|---|
| `/perplexity_ask` miss (Discover) | from `webSearch` | from `webSearch` | step 7, ~L724 |
| `/perplexity_ask` cache HIT | `cached.sources` (stored) | `cached.images` (stored) | ~L682 |
| `/perplexity_ask/follow_up` (Discover) | from `webSearch` (concurrent) | from `webSearch` | ~L868 |
| finance vertical | `sources[]` accumulator (see §6) | `[]` (no images) | `streamFinanceAnswer` ~L222 |
| assistant (Gmail) vertical | `[]` | `[]` | `streamAssistantAnswer` ~L271 |

---

## 5. `stripWireTail` — why the tail must be removed before re-prompting

The tail is for the UI, NOT for the LLM. On a follow-up, replaying it as context would feed the
model a JSON blob of old links + its own protocol markup. `stripWireTail`
([`backend/index.ts`](../../../../backend/index.ts) ~L323) removes it before compaction:

```ts
content
  .replace(/\n?<SOURCES>[\s\S]*?<SOURCES>\n?/g, "")   // drop the sources blob
  .replace(/\n?<IMAGES>[\s\S]*?<IMAGES>\n?/g, "")      // drop the images blob
  .replace(/<FOLLOW_UPS>[\s\S]*?<\/FOLLOW_UPS>/g, "")  // drop suggested questions
  .replace(/<\/?ANSWER>/g, "")                          // unwrap, keep the answer text
  .trim();
```

Note the asymmetry: `<SOURCES>`/`<IMAGES>` use the **duplicate-open** form (`<SOURCES>…<SOURCES>`),
but `<FOLLOW_UPS>` uses a **real closing tag** (`</FOLLOW_UPS>`) because the persona emits it that
way. Get the regex pair wrong and stale source JSON leaks into the next prompt — bloating tokens and
confusing the model with dead `[n]` numbers that no longer map to the new search. (Compaction flow
itself → `follow-up-and-continuity.md`.)

---

## 6. How finance reuses the GLOBAL `[n]` numbering

The finance chat agent (`vertical:"finance"`) has **no pre-fetched results array** — the model
calls tools mid-stream. To still cite like Discover, `financeWebSearch` reconstructs the same
positional contract at tool-call time
([`backend/finance/tools.ts`](../../../../backend/finance/tools.ts), `buildFinanceTools`):

```ts
const sources: AgentSource[] = [];           // per-request accumulator, fresh each call
// inside financeWebSearch.execute:
const numbered = results.map((r) => {
  sources.push(r);
  return { n: sources.length, title: r.title, url: r.url, snippet: r.content };  // GLOBAL n
});
return { sources: numbered };                 // model sees explicit n, cites [n]
```

The mapping vs. Discover, side by side:

| | Discover (`/perplexity_ask`) | Finance (`vertical:"finance"`) |
|---|---|---|
| Where sources come from | one `webSearch` up front | each `financeWebSearch` tool call, accumulated |
| Who assigns `[n]` | `formatSearchContext` (`i+1`, implicit) | `financeWebSearch` (`sources.length`, explicit `n:`) |
| Across multiple searches | N/A (one search) | `n` keeps climbing across calls — **global**, not per-call, so two searches don't both start at `[1]` |
| The accumulator | `sources` from `webSearch` | `sources[]` returned by `buildFinanceTools()` |
| The tail | `sourcesImagesTail(sources, images)` | `sourcesImagesTail(sources, [])` (`streamFinanceAnswer`) |
| Snippet cap | 1200 chars | 800 chars |

Critical detail: `n` is `sources.length` **after** the push, computed across the whole request —
so the model can run `financeWebSearch` twice and the second batch continues `[6][7]…`, never
resetting. `FINANCE_PERSONA` ([`backend/prompt.ts`](../../../../backend/prompt.ts) ~L176) tells the
model: `financeWebSearch` results cite as `[n]`; **price-tool figures (getQuote/getCrypto/getIndices)
do NOT get `[n]`** — instead name the provider (Twelve Data / CoinGecko / Yahoo) + the as-of time.
The mechanics belong to **finance-markets**; the takeaway here is that the `[n]`-↔-`<SOURCES>`
invariant is identical, so the chat UI renders both verticals unchanged.

---

## 7. Decision framework — citation-touching changes

```
Change touches sources/citations
|
+-- "Links point at the wrong source / [n] off by one"
|       -> You reordered/renumbered between formatSearchContext and sourcesImagesTail.
|          Keep ONE ordered array. Don't sort sources after the model cited.
|
+-- "Model invents facts / cites things not in results"
|       -> Tighten PERSONA grounding lines; confirm formatSearchContext actually
|          ran (block header present in buildUserPrompt). It's a prompt lever, not code.
|
+-- "UI shows no source chips though the answer cited [1][2]"
|       -> The <SOURCES> tail is missing/malformed. Verify the duplicate-open tag
|          form (<SOURCES>…<SOURCES>) and that res.write(tail) fired before res.end().
|
+-- "Reloaded conversation lost its links"
|       -> persistTurns must store fullAnswer + tail (not just the prose). Check ~L182.
|
+-- "Follow-up prompt is huge / model cites dead [n]"
|       -> stripWireTail isn't removing old blobs. Check both regex forms (§5).
|
+-- "Want more/less context per source"
|       -> Tune the .slice(0,1200) cap in formatSearchContext (800 in financeWebSearch),
|          not maxResults. (maxResults / depth -> web-search-tavily.md.)
|
+-- "Finance answer won't cite news"
|       -> Route it through financeWebSearch (assigns global n + pushes to sources[]);
|          a raw fetch won't enter the tail. -> finance-markets.
```

---

## 8. Anti-patterns (mark an amateur) → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Sorting/filtering `sources` for display after the model already cited `[n]`. | Lock the order from `webSearch` → `formatSearchContext` → `sourcesImagesTail`. `[n]` is positional; any reshuffle desyncs links. |
| Building the `<SOURCES>` list by regex-extracting `[n]` from the model's prose. | Serialize the real `sources` array. The model picks which `[n]` to cite; it must never author the link list (that's how fake URLs ship). |
| Letting the model answer from prior knowledge when results are thin. | `PERSONA` forces "grounded ONLY… if insufficient, say so." Don't relax it; a wrong-but-confident answer is worse than "the sources don't cover this." |
| Using `</SOURCES>` (real closing tag) in the tail. | Use the duplicate-open form `<SOURCES>…<SOURCES>` — the frontend split + `stripWireTail` both depend on it. |
| Persisting only `fullAnswer` (dropping `tail`) to save space. | Persist `fullAnswer + tail` via `persistTurns`; otherwise reloaded threads lose all links/images. |
| Feeding the stored `<SOURCES>` blob back into a follow-up prompt as context. | Run `stripWireTail` first — old link JSON wastes tokens and dangles dead `[n]`. |
| Removing the `.slice(0, 1200)` cap to "give the model more context." | 10 full Tavily snippets bloat the prompt + slow first token; 1200 is the deliberate floor that still grounds a claim. |
| Starting a second finance `financeWebSearch` batch back at `[1]`. | `n = sources.length` is global across the request — let it keep climbing so two searches don't collide. |
| Giving finance price-tool numbers an `[n]`. | `[n]` is for `financeWebSearch` only; price figures name the provider + as-of time per `FINANCE_PERSONA`. |
| Emitting the tail only on some branches. | Every branch (miss / cache hit / follow-up / finance / assistant) ends with `sourcesImagesTail` so the client never special-cases. |

---

## 9. Checklist — a grounding/citation change is "done" when

1. **One ordered array.** `results`/`sources` keep the same order from `webSearch` through
   `formatSearchContext` and `sourcesImagesTail`; nothing reorders after the model cites.
2. **Block is numbered + capped.** Context shows `[i+1]` per source, snippet sliced (1200 Discover /
   800 finance), under the `buildUserPrompt` "cite these as [n]" header.
3. **Grounding rule intact.** `PERSONA` still says answer ONLY from results + say-so-if-thin; the
   answer cites generously and never fabricates a fact the results don't support.
4. **Tail correct + universal.** Every streaming branch appends `sourcesImagesTail` with the
   duplicate-open tags; sources/images are the real arrays, not parsed from prose.
5. **Persisted whole.** `persistTurns` stores `fullAnswer + tail` before `res.end()`, so reloads
   render identical links.
6. **Stripped on re-prompt.** `stripWireTail` removes both blobs (+ `<ANSWER>`/`<FOLLOW_UPS>`) before
   compaction; no dead `[n]` leaks into follow-ups.
7. **Finance parity (if touched).** New web sources flow through `financeWebSearch`'s global-`n`
   accumulator; price figures stay un-`[n]`'d. (Deep dive → **finance-markets**.)
