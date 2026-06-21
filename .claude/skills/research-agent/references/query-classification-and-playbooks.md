# Query Classification & Task Playbooks — the intelligence layer

> How Lumina turns one user question into a *sharper* answer without retraining anything: a cheap
> deterministic `classifyQuery` picks one of five intents, `buildSystemPrompt` injects the matching
> PLAYBOOK on top of the stable PERSONA, and the same model answers with task-specific instructions.
> Read this when adding/tuning a query type, changing per-type guidance, or upgrading the classifier
> to an LLM call. Adjacent refs: the `<ANSWER>`/`<FOLLOW_UPS>` contract the PERSONA enforces →
> `answer-protocol-and-followups.md`; the numbered context block fed alongside the playbook →
> `source-grounding-and-citations.md`; the end-to-end wiring → `lumina-research-pipeline.md`. For the
> generic prompt-assembly *mechanism* (composable layers, system-vs-user split) cross-ref the
> **ai-sdk-agent** skill — this ref is the Discover-specific instance of it.

`lumina-` ref = THIS codebase. Everything below lives in
[`backend/prompt.ts`](../../../../backend/prompt.ts) and is consumed in
[`backend/index.ts`](../../../../backend/index.ts). Line numbers drift — cite the live file before
you change it.

---

## 1. The idea in one sentence

**Same model, different instructions chosen per query.** Instead of one fixed system string for
every question, the prompt is assembled per request from three composable layers (the pattern
borrowed from `pi`, noted in the file header of `prompt.ts`):

| Layer | What it is | Stability | Built by |
|-------|------------|-----------|----------|
| **PERSONA** | Identity + Markdown rules + citation rules + `<ANSWER>`/`<FOLLOW_UPS>` output protocol | Rarely changes | the `PERSONA` const |
| **PLAYBOOK** | Task-specific guidance picked by intent (the big win) | One per `QueryType` | `PLAYBOOKS[type]` |
| **CONTEXT** | Today's date + numbered web results + the user question | Per request | `buildUserPrompt(...)` |

This is **context engineering, not model training** — the file comment is explicit: "same model,
sharper instructions chosen per query. Pure prompt logic; touches no DB and no cache." PERSONA +
PLAYBOOK become the **system** message; CONTEXT becomes the **user** message. Get that split right
and the model treats the playbook as a directive, not as data to summarize.

---

## 2. `classifyQuery` — the heuristic, branch by branch

`classifyQuery(query: string): QueryType` (in [`backend/prompt.ts`](../../../../backend/prompt.ts),
`classifyQuery`) lowercases the query and runs five ordered regex checks, returning the **first**
match. The five intents:

```ts
export type QueryType = "compare" | "latest" | "howto" | "definition" | "general";
```

| Order | Type | Triggers on (regex intent) | Example queries |
|-------|------|----------------------------|-----------------|
| 1 | `compare` | `vs`/`versus`/`compare`/`comparison`/`difference between`/`better than`/`which (is\|one) … (better\|best)` | "React vs Vue", "is Postgres better than MySQL", "which one is best for X" |
| 2 | `latest` | `latest`/`newest`/`most recent`/`today`/`right now`/`currently`/`this (week\|month\|year)`/`202\d`/`news`/`just released`/`release date` | "latest iPhone", "AI news today", "GPT-5 release date" |
| 3 | `howto` | `how to`/`how do`/`how can`/`how should`/`best way`/`step by step`/`steps to`/`tutorial`/`guide`/`getting started`/`learn`/`install`/`set up`/`configure`/`build a` | "how to deploy Docker", "best way to learn Rust", "install pnpm" |
| 4 | `definition` | *anchored* `^(what (is\|are\|was\|were)\|who (is\|are\|was)\|define\|definition of\|explain\|meaning of\|tell me about)` | "what is RAG", "who is Linus Torvalds", "explain TCP" |
| 5 | `general` | (fallthrough — nothing matched) | "show me cheap flights to Tokyo" |

### Why order is non-negotiable

The branches are checked top-down and **more specific intents win**. This ordering encodes real
priority decisions:

- **`compare` before `latest`/`howto`:** "what's the latest, React or Vue?" should get the
  comparison table, not a dated-news lead. A versus-question is a comparison first.
- **`latest` before `howto`:** "how to install the **latest** Node" — freshness guidance (state the
  date, prefer newest sources) matters more than generic step ordering here. Debatable, but the
  current code commits to it; know the tradeoff before reordering.
- **`definition` is anchored with `^`** (the only anchored branch). "what is the difference between
  X and Y" must NOT fall into `definition` — and it doesn't, because `compare` already caught it at
  branch 1. The anchor also stops mid-sentence "…explain why…" from hijacking an otherwise-`howto`
  query.

### The classifier's blind spots (know them before you "fix" them)

| Limitation | Effect | Mitigation |
|------------|--------|------------|
| English keyword regex only | Non-English / paraphrased intents fall to `general` | `general` = PERSONA-only, a safe default (see §3) |
| Substring `202\d` | "the year 2020 in history" mis-tags `latest` | Low harm: `latest` just adds freshness framing |
| No multi-intent | A compare-and-how-to query picks ONE playbook | Acceptable; the chosen playbook still helps |
| Order-sensitive | "build a comparison of X vs Y" → `compare` (branch 1 wins over branch 3 `build a`) | This is usually correct; verify intent before reordering |

The whole function is ~8 lines and runs in microseconds with zero I/O. That cheapness is the point:
it runs on **every** Discover turn (`index.ts`, in the search MISS path) and every follow-up, with
no latency or token cost. Don't replace it lightly (§5).

---

## 3. The five PLAYBOOKS — what each one actually injects

`PLAYBOOKS: Record<QueryType, string>` (in [`backend/prompt.ts`](../../../../backend/prompt.ts)).
Each is a short directive string appended to the PERSONA. They are deliberately terse — they sharpen
*structure and emphasis*, they do not restate the citation/Markdown rules the PERSONA already owns.

| Type | Playbook directive (paraphrased) | What it changes in the output |
|------|----------------------------------|-------------------------------|
| `compare` | Lead with a one-line **verdict**, then a Markdown comparison table across the dimensions that matter, then a short "Which should you pick?" per use-case. | Forces a table + a recommendation; stops the model from writing two disconnected descriptions. |
| `latest` | Lead with the most recent **DATED** fact (state the date). Prefer the newest sources; if even the freshest is old, say so. Flag anything likely to change soon / already stale. | Pushes recency to the top and makes the model honest about staleness — pairs with the cache being *skipped* for time-sensitive queries. |
| `howto` | State the single best **first step/resource** up front. Then the shortest path as numbered ordered steps. Note common beginner mistakes if sources mention them. | Produces a quick-start path, not an essay; matches the PERSONA's "numbered list for ordered steps" rule. |
| `definition` | Open with a one-sentence **plain-English definition**. Then a concrete example that makes it click. Then a nuance / common misconception. | Definition → example → nuance arc; prevents jargon-only answers. |
| `general` | `""` — empty string. PERSONA only, no extra guidance. | The safe default: a well-formatted, cited answer with no task slant. |

**`general` being empty is a feature.** When intent is unknown, adding made-up structure would hurt.
The fallthrough returns a clean PERSONA-only prompt — see how `buildSystemPrompt` short-circuits it
in §4.

### How a playbook "sharpens" the answer (worked contrast)

Same question, the PERSONA stays identical; only the appended playbook differs:

> Query: **"Bun vs Node for a backend API"** → `classifyQuery` → `compare`

Without the playbook (PERSONA only) the model might write two prose paragraphs and a vague closer.
With the `compare` playbook injected as `## Guidance for THIS query (type: compare)`, the model is
directed to: (1) a one-line verdict, (2) a `| Dimension | Bun | Node |` table over the axes that
matter (cold start, ecosystem maturity, native TS, deploy targets), (3) a "Which should you pick?"
keyed by use-case. The PERSONA's table rule ("Always include a header row") and citation rule
("most claims should carry a citation") still apply on top — the playbook *composes with* the
persona, it doesn't override it.

The same composition holds for `latest` (dated lead + staleness flags), `howto` (first-step +
numbered path), and `definition` (one-sentence def + example + nuance). The playbook is a thin lens;
the PERSONA is the lens housing.

---

## 4. Assembly — `buildSystemPrompt` and `buildUserPrompt`

```ts
// SYSTEM = persona + the one matching playbook (if any).
export function buildSystemPrompt(queryType: QueryType): string {
    const playbook = PLAYBOOKS[queryType];
    return playbook
        ? `${PERSONA}\n\n## Guidance for THIS query (type: ${queryType})\n${playbook}`
        : PERSONA;            // general → "" is falsy → PERSONA only
}

// USER = today's date + numbered web results + the question.
export function buildUserPrompt(opts: { query; searchContext; date }): string {
    return `## Today's date\n${opts.date}\n\n## Web search results (numbered — cite these as [n])\n${opts.searchContext}\n\n## User question\n${opts.query}`;
}
```

Two design points worth internalizing:

1. **The empty `general` playbook is falsy**, so `buildSystemPrompt` returns the bare PERSONA — no
   dangling empty "Guidance" header. This is why `general` must be `""`, not a placeholder sentence.
2. **The playbook goes in SYSTEM, the results+question go in USER.** Guidance the model must *obey*
   belongs in the system message; data the model must *reason over* belongs in the user message.
   Putting the playbook in the user message would invite the model to treat it as content to
   echo/summarize. Cross-ref **ai-sdk-agent** for the general system-vs-user discipline.

### Where it's wired (cite the live file)

In [`backend/index.ts`](../../../../backend/index.ts), the `/perplexity_ask` search MISS path:

```ts
const queryType = classifyQuery(query);                                   // ~index.ts:696
const today = new Date().toISOString().slice(0, 10);
const prompt = buildUserPrompt({ query, searchContext: formatSearchContext(results), date: today });
// …
const result = streamText({ model, system: buildSystemPrompt(queryType), messages: [...] });  // ~index.ts:705-708
```

On the follow-up path the classifier runs on the *new* query, and the older-turns **summary is
appended to the same `buildSystemPrompt(...)` base**, so the playbook still applies on continuations
(in fn `/perplexity_ask/follow_up`, around `index.ts:850`):

```ts
const baseSystem = buildSystemPrompt(classifyQuery(query));
const system = summary
    ? `${baseSystem}\n\n## Earlier conversation (summary of older turns)\n${summary}`
    : baseSystem;
```

Note the layering order: **PERSONA → playbook → earlier-conversation summary**. Continuity context
comes last, after the task guidance, so the playbook framing isn't buried. (Compaction details →
`follow-up-and-continuity.md`.)

> Note: `classifyQuery` classifies the **raw user query**, not the augmented `buildUserPrompt`
> string — keep it that way. Classifying the assembled prompt would let the boilerplate headers
> ("Web search results…") pollute the regex.

---

## 5. Upgrading the classifier to a tiny LLM call

The file comment is explicit that this is intended: *"cheap, deterministic heuristic for now … Can
be upgraded to a tiny fast LLM call later."* The seam is clean: **anything that returns a
`QueryType` is a drop-in** — `buildSystemPrompt`/`buildUserPrompt` and both `index.ts` call sites
are untouched.

### When to actually do it

| Signal you've outgrown the regex | |
|----------------------------------|---|
| Non-English / heavily paraphrased queries land in `general` too often | regex is keyword-bound |
| You want to add intents whose triggers aren't keyword-separable (e.g. "opinion", "troubleshoot") | regex precision drops fast as branches multiply |
| You're considering multi-intent ("compare AND how-to") | a classifier can return a ranked set |

If none of these bite, **keep the regex** — it's free, synchronous, and deterministic (testable
without mocking a model). Don't trade those away for marginal recall.

### How to do it (keep the contract identical)

Use a small, fast model via `generateObject` with a Zod enum so the output is type-safe and can't
return an off-list value — the same pattern the finance narratives use (`generateObject` + Zod, see
**finance-markets** `llm-market-narratives.md`). Engine details (model routing through the AI
Gateway, `generateObject`) → **ai-sdk-agent**.

```ts
import { generateObject } from "ai";
import { z } from "zod";

const QUERY_TYPES = ["compare", "latest", "howto", "definition", "general"] as const;

export async function classifyQueryLLM(query: string): Promise<QueryType> {
    try {
        const { object } = await generateObject({
            model: resolveModel("anthropic/claude-haiku-4.5"),     // small + fast; gateway-resolved
            schema: z.object({ type: z.enum(QUERY_TYPES) }),
            prompt: `Classify the user's intent into exactly one type.\n\n` +
                    `- compare: weighing two+ options\n- latest: wants current/recent info\n` +
                    `- howto: wants to do/learn something\n- definition: wants a concept explained\n` +
                    `- general: none of the above\n\nQuery: ${query}`,
        });
        return object.type;
    } catch {
        return classifyQuery(query);   // FAIL-OPEN to the regex — never block the answer on the classifier
    }
}
```

**Non-negotiables for the upgrade:**

| Rule | Why |
|------|-----|
| Return `Promise<QueryType>` — same enum, no new values | downstream switch/record lookups stay exhaustive |
| **Fail open** to `classifyQuery` on any error/timeout | a classifier hiccup must never block the actual answer; the regex is the safety net |
| Use a **small, fast** model (Haiku-class), short prompt | this runs before the real answer — every ms here is added latency on the hot path |
| Keep the regex as the fallback, not deleted | it's your deterministic floor and your test oracle |
| (Optional) cache the classification by normalized query | repeated questions skip the extra call |

Decision rule: **regex by default; LLM only when recall on real traffic is measurably hurting**, and
even then keep the regex behind it. A classifier that adds 300ms and a failure mode to every search
to fix 3% of mis-tags is a bad trade unless those mis-tags are visible to users.

---

## 6. Adding a new query type (the correct path)

Adding an intent touches **three places in `prompt.ts` and nothing else** — `buildSystemPrompt`
injects it automatically and `index.ts` needs no change:

1. **`QueryType`** union — add the literal (e.g. `"troubleshoot"`).
2. **`PLAYBOOKS`** — add the entry (a short, structural directive; mirror the existing five's
   terseness — verdict/lead/steps, not a re-statement of citation rules).
3. **`classifyQuery`** — add a regex branch **in the right priority slot** (more specific = higher).
   Verify it doesn't steal queries from an existing intent (run the existing examples through it).

That's the whole change. Because `PLAYBOOKS` is `Record<QueryType, string>`, TypeScript will force
you to add the playbook the moment you add the union member — the type system is the checklist.

---

## 7. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Adding a new intent by editing the PERSONA string. | Add a `QueryType` + `PLAYBOOKS` entry + a `classifyQuery` branch; `buildSystemPrompt` injects it automatically. |
| Reordering `classifyQuery` branches without checking the existing examples. | More specific intents stay higher; re-run "X vs Y", "latest Node", "build a comparison" and confirm each still tags as intended. |
| Giving `general` a non-empty playbook "to be safe". | Keep it `""` — it's falsy so `buildSystemPrompt` returns bare PERSONA. A made-up structure on unknown intent hurts. |
| Classifying the assembled `buildUserPrompt` string. | Classify the **raw query**; the boilerplate headers would pollute the regex. |
| Putting the playbook into the USER message. | Playbook (instructions to obey) → SYSTEM; results + question (data to reason over) → USER. |
| Writing a verbose playbook that restates Markdown/citation rules. | Those live in PERSONA. A playbook is a thin structural lens (verdict→table, dated-lead, first-step→steps). |
| Swapping the regex for an LLM call with no fallback. | Fail open to `classifyQuery`; never let the classifier block the answer. |
| Using a big model for classification. | A small/fast (Haiku-class) model with a Zod enum; this is on the latency-critical pre-answer path. |
| Appending the older-conversation summary *before* the playbook. | Order is PERSONA → playbook → summary (continuity last) so task framing isn't buried. |

---

## 8. Done-when checklist

A classification/playbook change is correct when:

1. `classifyQuery` returns the intended `QueryType` for the new query class **and** still returns the
   right one for each pre-existing example (no regressions from ordering).
2. The matching `PLAYBOOKS` entry is terse and structural — it composes with the PERSONA, doesn't
   re-state its rules.
3. `buildSystemPrompt(type)` produces `PERSONA + "## Guidance for THIS query (type: …)" + playbook`
   for non-`general`, and bare PERSONA for `general`.
4. Both call sites (`/perplexity_ask` MISS path and `/follow_up`) compile unchanged — the only edits
   are in `prompt.ts`.
5. If you upgraded to an LLM classifier: it returns the same enum, fails open to the regex, uses a
   small model, and the regex remains as the tested fallback.
