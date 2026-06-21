# Prompt Assembly & Playbooks — the layered prompt pattern

> How Lumina builds a *different* system prompt for *every* request out of three composable
> layers — a stable PERSONA, one task-specific PLAYBOOK chosen by `classifyQuery`, and a
> per-request CONTEXT block — instead of one frozen mega-string. Read this when you touch
> [`backend/prompt.ts`](../../../../backend/prompt.ts): adding/changing a query type or playbook,
> tuning the classifier, editing a persona, or wiring a new vertical's prompt. The runtime
> `loadSkill` system (a *different* progressive-disclosure mechanism the finance agent uses at
> tool-call time) is in `runtime-skills-progressive-disclosure.md`; how these strings get fed to
> `streamText` and the wire tail come back out is in `lumina-agent-engine.md` /
> `streaming-and-wire-protocol.md`; the finance tool belt that `FINANCE_PERSONA` drives is the
> **finance-markets** skill's `ai-sdk-finance-agent.md`.

`lumina-` project-grounded ref — every claim cites the live file. Line numbers drift; the
function/const names are stable anchors.

---

## 1. The mental model: three layers, one assembled string

The core idea ([`backend/prompt.ts:1-15`](../../../../backend/prompt.ts) header comment): a prompt
is **not** a constant. It is assembled per request from layers that change at different rates.

| Layer | Changes | Lives in | Built by | Goes into |
|-------|---------|----------|----------|-----------|
| **PERSONA** | Rarely (who the agent is, formatting + citation rules, output protocol) | `PERSONA` / `FINANCE_PERSONA` consts | — (static) | `system` |
| **PLAYBOOK** | Per *query-type* (the leverage: sharper instructions for compare/latest/howto/definition) | `PLAYBOOKS` record | `classifyQuery` picks one | `system` (appended to persona) |
| **CONTEXT** | Per *request* (today's date, the numbered web results, the user's question) | — (dynamic) | `buildUserPrompt` | `user` message |

Two assembler functions encode the split:

- `buildSystemPrompt(queryType)` → PERSONA **+** the one matching playbook → the `system` string.
- `buildUserPrompt({query, searchContext, date})` → the CONTEXT block → the `user` message text.

```
        ┌──────────── system ────────────┐      ┌──────── user ────────┐
classify│  PERSONA (stable identity)      │      │ today's date         │
 Query  │  + "## Guidance for THIS query" │      │ numbered web results  │
   │    │      <the matched PLAYBOOK>     │      │ the user question     │
   ▼    └─────────────────────────────────┘      └──────────────────────┘
buildSystemPrompt(type)                          buildUserPrompt({...})
        └──────────────► streamText({ system, messages:[{role:"user", content}] })
```

This is **context engineering, not training** — same model, *different instructions chosen per
query*. No fine-tune, no DB, no cache: `prompt.ts` is "pure prompt logic" by design
([`prompt.ts:13-14`](../../../../backend/prompt.ts)), which makes it trivially testable and free to
change.

---

## 2. Layer 1 — PERSONA (the stable layer)

`PERSONA` ([`prompt.ts:18-81`](../../../../backend/prompt.ts)) is the Discover/default-search
identity. It carries everything that should be *identical* across every search query:

| Section in PERSONA | What it pins down |
|--------------------|-------------------|
| Identity + grounding rule | "You are Lumina… grounded ONLY in those results… never invent facts… If the results are insufficient, say so." |
| How to write the answer | Markdown contract: 1–2 sentence direct opener (no heading), `##`/`###` sections, **bold** lead-in bullets, comparison tables with a header row, numbered steps. Skimmable, no filler. |
| Citations | Inline `[1][2]` matching the numbered results, placed after the supported sentence; "cite generously." |
| Rules | Don't mention the instructions or that "search results" were given. |
| Output protocol | Wrap in `<ANSWER>…</ANSWER>`, then a `<FOLLOW_UPS>` block of exactly five questions. |
| Example shape | A full illustrative answer so the model copies the *format* (this is few-shot-by-example). |

The persona is exported as a named const **and** as the back-compat default export
([`prompt.ts:197-198`](../../../../backend/prompt.ts)) — but live code imports the named functions,
so the default export is vestigial.

`FINANCE_PERSONA` ([`prompt.ts:148-195`](../../../../backend/prompt.ts)) is the parallel persona for
the `vertical:"finance"` agent. **Key difference from `PERSONA`:** the Discover persona answers over
**pre-fetched** web results handed to it in the CONTEXT block; `FINANCE_PERSONA` drives a **tool
loop** — it tells the model to *call* `getQuote`/`getCrypto`/`getIndices`/`financeWebSearch` to fetch
live data, then ground in the results.

| `FINANCE_PERSONA` adds | Why |
|------------------------|-----|
| **Scope guard** | Answers ONLY finance; declines off-topic in one sentence. |
| **Tool-first + never-guess** | "Call the right tool(s) BEFORE answering… NEVER invent a price, level, or statistic." State the as-of time; if a tool returns `unavailable`, say live data is momentarily rate-limited. |
| **`<available_skills>` pointer** | Tells the model to call `loadSkill` FIRST when a request matches a runtime skill (see §6). |
| **Split citation rule** | `financeWebSearch` → inline `[n]`; price-tool figures name the source (Twelve Data/CoinGecko) + as-of time instead of `[n]`. |
| **No-advice contract** | Never buy/sell/hold; end with "Not financial advice." |
| Same `<ANSWER>`/`<FOLLOW_UPS>` protocol | So the existing chat UI renders finance answers unchanged. |

**The output protocol is the contract that lets one frontend render every vertical.** Whenever you
write a new persona, keep the `<ANSWER>…</ANSWER>` + `<FOLLOW_UPS>` shape or the UI parser breaks
(see `streaming-and-wire-protocol.md`).

---

## 3. Layer 2 — PLAYBOOKS + classifyQuery (the leverage)

`PLAYBOOKS` ([`prompt.ts:87-108`](../../../../backend/prompt.ts)) is a `Record<QueryType, string>`.
Each entry is a *short, surgical* instruction injected only when that query type fires:

| `QueryType` | Playbook intent (the steer) |
|-------------|-----------------------------|
| `compare` | Lead with a one-line verdict → Markdown comparison table across the dimensions that matter → a "Which should you pick?" per-use-case section. |
| `latest` | Lead with the most recent **dated** fact; prefer newest sources; flag anything likely already out of date. |
| `howto` | State the single best first step up front; then the shortest path as numbered steps; note beginner mistakes. |
| `definition` | One-sentence plain-English definition → a concrete example → the key nuance/misconception. |
| `general` | **Empty string** — persona only, no extra guidance. The deliberate no-op default. |

`classifyQuery(query)` ([`prompt.ts:112-119`](../../../../backend/prompt.ts)) is a **cheap,
deterministic regex heuristic** — not an LLM call. Two design facts matter:

1. **Order is significance order**: more specific intents are tested first
   (`compare` → `latest` → `howto` → `definition`), so "compare the latest React vs Vue" classifies
   as `compare`, not `latest`. If you add a type, place it where its specificity demands.
2. **It is upgradeable**: the comment notes it "Can be upgraded to a tiny fast LLM call later"
   ([`prompt.ts:110-111`](../../../../backend/prompt.ts)). Today's regex is the Tier-1 classifier;
   swapping in a Haiku call later changes only this function, not the assembly contract.

`buildSystemPrompt(queryType)` ([`prompt.ts:122-127`](../../../../backend/prompt.ts)) does the merge:

```ts
const playbook = PLAYBOOKS[queryType];
return playbook
  ? `${PERSONA}\n\n## Guidance for THIS query (type: ${queryType})\n${playbook}`
  : PERSONA;            // 'general' → empty string → persona only
```

The `?` guard means an empty playbook (`general`) yields the bare persona — no dangling empty
"## Guidance" heading.

---

## 4. Layer 3 — CONTEXT (per-request)

`buildUserPrompt({query, searchContext, date})`
([`prompt.ts:130-139`](../../../../backend/prompt.ts)) builds the **user** message, not the system
prompt. It stitches three dynamic facts in a fixed, labelled order:

```
## Today's date
<date>

## Web search results (numbered — cite these as [n])
<searchContext>

## User question
<query>
```

Why each piece lives here and not in the persona:
- **Date** changes every day → can't be static; gives the model "now" so `latest`-type answers and
  recency judgments are correct.
- **Numbered web results** are the *single source of truth* the persona's grounding rule points at;
  numbering them `[n]` is what makes the persona's inline-citation rule resolvable.
- **The question** comes last so it's the freshest token before generation.

---

## 5. How `index.ts` wires it (the request flow)

The Discover MISS path ([`backend/index.ts:690-712`](../../../../backend/index.ts)):

```ts
const { results, sources, images } = await webSearch(query);        // step 4: Tavily
const queryType = classifyQuery(query);                             // step 5: classify
const today = new Date().toISOString().slice(0, 10);
const prompt = buildUserPrompt({ query, searchContext: formatSearchContext(results), date: today });
// step 6: hit the LLM
const result = streamText({
  model,
  system: buildSystemPrompt(queryType),                            // persona + playbook
  messages: [{ role: "user", content: userContent }],             // CONTEXT (+ attachment parts)
  abortSignal: disconnectSignal(res),
  onError: ({ error }) => console.error("streamText error:", error),
});
```

Follow-ups reuse the *same* assemblers
([`index.ts:838-853`](../../../../backend/index.ts)) — `buildUserPrompt` for the augmented query and
`buildSystemPrompt(classifyQuery(query))` for the base system — then **append the compaction summary
of older turns to the system string** so `messages` stays a clean user/assistant alternation:

```ts
const baseSystem = buildSystemPrompt(classifyQuery(query));
const system = summary
  ? `${baseSystem}\n\n## Earlier conversation (summary of older turns)\n${summary}`
  : baseSystem;
```

That stacking — `buildSystemPrompt` output **then** the summary — is the same compose-into-system
move the finance follow-up uses with `buildFinanceSystem()`
([`index.ts:793-795`](../../../../backend/index.ts)). The finance path does **not** call
`classifyQuery`/`buildSystemPrompt`; it calls `buildFinanceSystem()` (`FINANCE_PERSONA` + the
runtime-skills manifest) and relies on `loadSkill` for per-task steering instead of a server-side
playbook (see §6).

| Vertical | System builder | Per-task steering | Source of facts |
|----------|----------------|-------------------|-----------------|
| Discover / default | `buildSystemPrompt(classifyQuery(q))` | Server-side `PLAYBOOK` injected before the call | Pre-fetched Tavily results in CONTEXT |
| Finance | `buildFinanceSystem()` | Runtime `loadSkill` tool, model-triggered | Tools the model calls mid-loop |

---

## 6. Two playbook systems — don't confuse them

Lumina has **two** "playbook" mechanisms. They solve the same problem (task-specific guidance) at
different times and costs.

| | Discover PLAYBOOKS (this doc) | Finance runtime skills (`loadSkill`) |
|---|---|---|
| Where defined | `PLAYBOOKS` record in `prompt.ts` | `backend/finance/skills/*.md` files |
| Who picks it | Server, before the call (`classifyQuery`) | The **model**, via the `loadSkill` tool, mid-loop |
| When injected | Always, upfront, in `system` | On demand, only if the request matches a manifest entry |
| Cost | One string concat (free) | A tool round-trip (a step) |
| Best for | A small, fixed set of query shapes | A growing library of domain procedures |
| Ref | here | `runtime-skills-progressive-disclosure.md` |

The comment in `prompt.ts` is explicit about the lineage: PLAYBOOKS are "pi's idea, but we inject
the matching one server-side before the single LLM call, instead of the model loading it via a tool"
([`prompt.ts:83-84`](../../../../backend/prompt.ts)). The finance agent took the *other* fork.

**Which to use for a new task type?** Use a Discover PLAYBOOK when the trigger is a cheap regex over
the query and the guidance is short and always-on. Use a runtime skill when guidance is long,
domain-specific, only occasionally relevant (so you don't want to pay for it every request), or the
set will grow.

---

## 7. How to add a Discover playbook (recipe)

Three coordinated edits in [`prompt.ts`](../../../../backend/prompt.ts) — all type-checked together
because `PLAYBOOKS` is `Record<QueryType, string>`:

1. **Add the type** to the `QueryType` union ([`prompt.ts:85`](../../../../backend/prompt.ts)):
   ```ts
   export type QueryType = "compare" | "latest" | "howto" | "definition" | "troubleshoot" | "general";
   ```
2. **Add the playbook string** to `PLAYBOOKS` ([`prompt.ts:87`](../../../../backend/prompt.ts)) —
   short, imperative, format-shaping (mirror the existing four; lead with the answer shape):
   ```ts
   troubleshoot: `The user is DEBUGGING a problem.
   - Lead with the single most likely cause.
   - Then an ordered checklist from most→least likely fix.
   - Call out any data-loss-risky step explicitly.`,
   ```
3. **Add a classifier branch** in `classifyQuery`
   ([`prompt.ts:112-119`](../../../../backend/prompt.ts)) — placed by **specificity**, before the
   more general intents it could be confused with:
   ```ts
   if (/\b(error|not working|won'?t|can'?t|fix|debug|broken|fails?|troubleshoot)\b/.test(q)) return "troubleshoot";
   ```

No `index.ts` change is needed — `buildSystemPrompt`/`classifyQuery` already flow through it. TypeScript
forces you to cover the new key in `PLAYBOOKS` (exhaustive `Record`), so you can't forget step 2.

After editing, **restart the dev server if you added a new file** (you didn't here — same file — so
`bun --hot` picks it up); relative imports still need `.js` extensions everywhere else.

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Bolting new behavior onto one giant prompt string. | Put it in the right layer: identity/format → PERSONA; per-query-type steering → a PLAYBOOK; per-request data → CONTEXT via `buildUserPrompt`. |
| Adding a `QueryType` but forgetting the classifier branch. | A type with no `classifyQuery` rule never fires (silently falls to `general`). Add the regex too; put it before more-general intents. |
| Ordering classifier checks loosest-first. | Most-specific intent first (`compare` before `latest`); the regexes overlap, so order *is* the priority. |
| Writing a long, always-on playbook for a rarely-relevant domain procedure. | Make it a runtime skill (`loadSkill`) so it's paid for only when matched — see §6. |
| Putting the date or web results in the persona. | They're per-request → CONTEXT (`buildUserPrompt`). Persona stays stable so it's cacheable/diffable. |
| Inventing a new output shape for a new vertical. | Keep `<ANSWER>…</ANSWER>` + `<FOLLOW_UPS>` so the one frontend parser renders every vertical. |
| Building the system prompt inline at the `streamText` call site. | Always go through `buildSystemPrompt`/`buildFinanceSystem` so persona+playbook(+summary) compose consistently. |
| Appending the compaction summary to the `user` message or as a fake turn. | Append it to the SYSTEM string (`baseSystem + "## Earlier conversation…"`); keep `messages` a clean user/assistant alternation. |
| Replacing the regex classifier with an LLM call "for accuracy" prematurely. | The heuristic is deliberately Tier-1 and free; upgrade only when misclassification is a measured problem — and only `classifyQuery` changes. |
| Editing `FINANCE_PERSONA`'s tool list without touching `tools.ts`. | Persona tool names must match the registered tools; a phantom tool name in the persona makes the model hallucinate a call. Cross-check with `ai-sdk-finance-agent.md`. |

---

## 9. Checklist — a prompt change is "done" when

1. New behavior is in the **correct layer** (PERSONA vs PLAYBOOK vs CONTEXT), not concatenated ad hoc.
2. If a new `QueryType`: union updated, `PLAYBOOKS` entry added (TS-enforced), **and** a
   `classifyQuery` branch placed by specificity.
3. The output protocol (`<ANSWER>`/`<FOLLOW_UPS>`) is intact so the frontend still parses it.
4. The persona's citation rule still resolves against what CONTEXT actually provides (numbered `[n]`
   results for Discover; tool sources for finance).
5. For a new persona/vertical: it's assembled by a `build*System` function and fed to `streamText`
   the same way (`system:` + clean `messages`); compaction summary, if any, is appended to the
   system string.
6. Verified: the route streams a 200; the answer's format matches the persona; for finance, the
   right tool/`loadSkill` actually fires (`[finance-hook]` logs).
