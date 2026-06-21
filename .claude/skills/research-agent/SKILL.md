---
name: research-agent
description: >
  Build Lumina's Discover/search vertical — the /perplexity_ask research pipeline end to end:
  Tavily web search, source grounding + numbered [n] citations, query classification +
  task playbooks, the <ANSWER>/<FOLLOW_UPS> answer protocol, follow-ups that forward
  compacted conversation history, attachments (multimodal images/docs), the Discover
  card feeds shared by health/academic, and deep-research fan-out patterns. Use whenever
  the task touches /perplexity_ask or /perplexity_ask/follow_up, web search, citations,
  the answer protocol, query types/playbooks, the Discover feeds, or follow-up continuity.
metadata:
  priority: 55
  sessionStart: false
  pathPatterns:
    - 'backend/index.ts'
    - 'backend/prompt.ts'
    - 'backend/discover/**'
    - 'frontend/src/components/chat/**'
    - 'frontend/src/components/discover/**'
  promptSignals:
    phrases:
      - 'web search'
      - 'tavily'
      - 'citation'
      - 'sources'
      - 'discover'
      - 'follow-up'
      - 'query type'
      - 'playbook'
      - 'answer protocol'
      - 'research'
    minScore: 3
---

# research-agent — Lumina's Discover / Search Vertical

> Build the search-and-answer pipeline the way the live code already does it: trim the query
> to Tavily's 400-char cap, search → ground in numbered results → cite `[n]` → stream the
> `<ANSWER>` + 5 `<FOLLOW_UPS>` protocol, and never invent a fact the results don't support.
> This skill is the map from any Discover/search task to the exact reference + the exact file in
> [`backend/index.ts`](../../../backend/index.ts) and [`backend/prompt.ts`](../../../backend/prompt.ts).

---

## Domain Identity

**This skill OWNS:**
- The `/perplexity_ask` research pipeline (search → ground → classify → prompt → stream → persist)
  and the `/perplexity_ask/follow_up` continuation — the non-finance, non-assistant branches in
  [`backend/index.ts`](../../../backend/index.ts).
- Tavily web search + result/image shaping: `webSearch` and `formatSearchContext` in
  [`backend/index.ts`](../../../backend/index.ts).
- Query classification + task playbooks + prompt assembly:
  `classifyQuery`/`PLAYBOOKS`/`buildSystemPrompt`/`buildUserPrompt`/`PERSONA` in
  [`backend/prompt.ts`](../../../backend/prompt.ts).
- The answer protocol: the `<ANSWER>…</ANSWER>` + `<FOLLOW_UPS>` 5-question contract and the
  `<SOURCES>`/`<IMAGES>` wire tail (`sourcesImagesTail`).
- Follow-up continuity: compaction (`buildConversationHistory`/`stripWireTail`) + the concurrent
  history-build + search on the follow-up path.
- The Discover **card-feed** pattern shared across verticals:
  [`backend/discover/routes.ts`](../../../backend/discover/routes.ts) + `shared.ts`.

**This skill does NOT own (route elsewhere):**
- Engine mechanics — how `streamText`/tools/`stopWhen`/compaction work in the abstract → **ai-sdk-agent**.
- The semantic cache / pgvector / embeddings internals → **rag-retrieval** (this skill only knows
  *that* the pipeline calls it and *when* to skip it).
- Health/academic domain specifics (the fetchers, source licensing) → **health-discover** / **academic-discover**.
- The finance chat vertical (`vertical:"finance"`, the tool loop) → **finance-markets**.

---

## Decision Tree

```
Discover / search task arrives
|
+-- "How does /perplexity_ask + /follow_up flow end to end? Where does X live?" -> lumina-research-pipeline.md
+-- "Tune the Tavily call: depth, news topic, days, images, maxResults, cap?" --> web-search-tavily.md
+-- "Citations don't line up / grounding rule / the <SOURCES> tail / [n]" ------> source-grounding-and-citations.md
+-- "Classify a query / add a playbook / sharpen the per-type guidance" --------> query-classification-and-playbooks.md
+-- "The <ANSWER>/<FOLLOW_UPS> contract / markdown rules / how chat parses it" -> answer-protocol-and-followups.md
+-- "Build/extend a Discover card feed (academic/health), cached feeds, cron" --> lumina-discover-feeds.md
+-- "Escalate one search to a multi-source, verified research run" -------------> deep-research-patterns.md
+-- "Follow-up history: resolve 'it'/'the second one'; why skip the cache" -----> follow-up-and-continuity.md
```

---

## Non-Negotiables

| # | Rule | Why / where |
|---|------|-------------|
| 1 | **Answer ONLY from retrieved results; never invent facts they don't support. If the results are insufficient, say so.** | `PERSONA` in [`backend/prompt.ts`](../../../backend/prompt.ts): "grounded ONLY in those results … never invent facts … If the results are insufficient, say so." Fabrication is the worst failure for a research product. |
| 2 | **Cite generously with `[n]` matching the numbered sources; the numbers MUST line up with the `<SOURCES>` tail the UI renders.** | `formatSearchContext` numbers each result `[i+1]`; the SAME ordered `results` shape the `sources[]` JSON in the `<SOURCES>` tail. Renumber/reorder one and the other breaks. |
| 3 | **Trim the SEARCH string to Tavily's 400-char cap, but send the FULL prompt to the LLM.** | `webSearch`: `query.length > 400 ? query.slice(0, 400) : query`. Tavily 400s on longer queries; the LLM has no such cap, so `buildUserPrompt` gets the whole question. |
| 4 | **Time-sensitive queries skip the semantic cache** (prices / news / "today" / a year). | `isTimeSensitive` (`TIME_SENSITIVE` regex) gates `cacheable`; also skipped for attachments. Cache internals → **rag-retrieval**. |
| 5 | **Output wrapped in `<ANSWER>` + exactly five `<FOLLOW_UPS>` questions, in clean skimmable markdown.** | `PERSONA` output protocol + the illustrative example; the chat UI parses these exact tags (and the `<SOURCES>`/`<IMAGES>` tail). Four or six follow-ups is a contract break. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Letting the model answer from prior knowledge instead of the search results. | The persona forces grounding ONLY in the numbered results; if they're thin, the answer must say so — don't backfill from memory. |
| Sending the raw 800-char user query to Tavily and getting a 400. | Slice to 400 for the SEARCH string only; the full prompt still reaches the LLM via `buildUserPrompt`. |
| Renumbering or reordering sources after the model cited them. | Keep `results` order stable from `formatSearchContext` through `sourcesImagesTail`; `[n]` is positional. |
| Caching (or replaying from cache) a "latest news / price / today" query. | Let `isTimeSensitive` exclude it; only a `finishReason === "stop"` non-empty answer for a *cacheable* query is ever stored. |
| Emitting prose without `<ANSWER>` wrap, or with 3/7 follow-ups. | Always wrap in `<ANSWER>…</ANSWER>` and emit exactly five `<question>` items — the UI parser depends on it. |
| Persisting the assistant turn after `res.end()`. | Persist BEFORE `res.end()` via `persistTurns` — Vercel can freeze the instant the response closes. |
| Bumping `searchDepth:"advanced"` / `maxResults` globally to "improve quality". | `basic` + 10 is the deliberate latency choice; deepen only for query types that need it (see web-search-tavily.md). |
| On a follow-up, re-sending the whole transcript (and its `<SOURCES>` blobs) as context. | Compact: `stripWireTail` + keep last 6 turns verbatim + summarize older into the SYSTEM prompt. |
| Building a Discover feed that hits upstream on every request. | Wrap the fetcher in `getOrRefresh(key, ttl, …)` and add it to the `/discover/cron/refresh` warmer, like academic/health. |
| Adding a new query intent by editing the prompt persona string. | Add a `QueryType` + `PLAYBOOKS` entry + a `classifyQuery` branch; `buildSystemPrompt` injects it automatically. |

---

## Output Contract (what "done" looks like)

A Discover/search change is done when:
1. **Search path:** the query is trimmed to ≤400 for Tavily but the full prompt reaches the LLM;
   `webSearch` returns shaped `{results, sources, images}` and the results feed `formatSearchContext`.
2. **Grounding:** the answer cites only the numbered results; `[n]` positions line up with the
   `<SOURCES>` tail; insufficient evidence is stated, not fabricated.
3. **Prompt:** the query is classified, the matching playbook is injected via `buildSystemPrompt`,
   and the context block is assembled via `buildUserPrompt` (date + numbered results + question).
4. **Protocol:** the answer is wrapped in `<ANSWER>` with exactly five `<FOLLOW_UPS>`; the
   `<SOURCES>`/`<IMAGES>` wire tail is appended and persisted (so reloads render identically).
5. **Continuity (follow-up):** history is compacted (last 6 verbatim + summary in system), search
   runs concurrently with the history build, and the semantic cache is skipped.
6. **Persistence:** both turns are written via `persistTurns` BEFORE `res.end()`; only a clean,
   non-empty, cacheable answer is stored to the cache.
7. **Feeds (if touched):** every Discover series flows through `getOrRefresh` with a sensible TTL,
   serves `{…, fetchedAt, stale}`, and is wired into the cron warmer.

---

## Bundled References (8 files)

Read the one or two the task needs — never the whole folder.

### The pipeline & its parts
| File | Load when |
|------|-----------|
| `lumina-research-pipeline.md` | You need the full wiring map: `/perplexity_ask` cache check → `webSearch` (Tavily) → `classifyQuery` → `buildSystemPrompt`/`buildUserPrompt` → `streamText` → `<SOURCES>` tail → persist; and how `/follow_up` adds compaction + concurrent search. Start here when lost. |
| `web-search-tavily.md` | Tuning the Tavily call: `search(query, {searchDepth basic vs advanced, topic:"news", days, includeImages, maxResults})`, shaping results→sources, the 400-char query cap, latency tradeoffs, and when to deepen a search. |
| `source-grounding-and-citations.md` | `formatSearchContext` (numbered, sliced context block), the `[n]` citation contract, the grounded-only-in-results rule, the `<SOURCES>`/`<IMAGES>` wire tail, and how finance reuses the SAME global `[n]` numbering. |
| `query-classification-and-playbooks.md` | `classifyQuery` (compare/latest/howto/definition/general) heuristics + each `PLAYBOOK`'s guidance, how the chosen playbook sharpens the answer, and upgrading the classifier to a tiny LLM call. Cross-ref **ai-sdk-agent** for prompt assembly. |

### Protocol, feeds & continuity
| File | Load when |
|------|-----------|
| `answer-protocol-and-followups.md` | The `<ANSWER>…</ANSWER>` + `<FOLLOW_UPS>` 5-question contract, the markdown formatting rules (headings, bold lead-in bullets, comparison tables), the example shape, and how the chat view parses it. |
| `lumina-discover-feeds.md` | The Discover card-feed pattern shared across verticals: `discover/routes.ts` + `shared.ts`, cached feeds + cron warmer, the academic/health fetchers at a high level (deep domain → those skills), and how feeds differ from the chat pipeline. |
| `deep-research-patterns.md` | Multi-source fan-out, adversarial claim verification, synthesis with citations; when to escalate from a single Tavily search to a deep multi-search run; quality bars (source diversity, cross-verification). Mirrors the deep-research approach. |
| `follow-up-and-continuity.md` | Conversation continuity: how `/follow_up` forwards compacted history so "it"/"that"/"the second one" resolve; why follow-ups skip the semantic cache; the concurrent history-build + search. Cross-ref **ai-sdk-agent** compaction. |

---

## Cross-repo prior art / cross-skill routing

- **Sibling skills:** engine mechanics (`streamText`, `stopWhen`, compaction, model gateway) →
  **ai-sdk-agent**; semantic cache / pgvector / embeddings → **rag-retrieval**; the finance tool-loop
  vertical → **finance-markets**; Discover domain depth → **health-discover** / **academic-discover**;
  the chat/Discover UI shell → **lumina-frontend**.
- **The product's OWN runtime skills** (loaded by `loadSkill` from `backend/finance/skills/*.md`) are a
  *separate* system from these dev skills — described here only for contrast; you are not authoring one.
- **Cross-repo:** the `fintech-webapp` / `rareLab` `.claude` libraries hold deeper research-sourcing +
  licensing prior art (translate any Next.js/Drizzle code → our Express/Prisma stack); verify against
  live code before relying on any `file:line`.
