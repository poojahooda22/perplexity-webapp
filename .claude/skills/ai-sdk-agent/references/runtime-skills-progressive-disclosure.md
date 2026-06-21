# Runtime Skills — the product's own progressive-disclosure system

> The agent's OWN skill library: a folder of Markdown playbooks the finance model can pull mid-turn.
> **Do not confuse this with the dev skills you are reading right now.** These dev skills (`.claude/
> skills/**`) make *Claude Code* good at building Lumina. The *runtime* skills
> ([`backend/finance/skills/*.md`](../../../../backend/finance/skills/)) make the *finance chat
> model* good at finance procedures at request time. Read this when: adding/editing a runtime
> playbook, debugging why the model didn't follow one, or wiring the same pattern into another
> vertical. Sibling refs: `tool-calling-and-loops.md` (how `loadSkill` is just a tool),
> `prompt-assembly-and-playbooks.md` (the compile-time PLAYBOOKS layer this complements),
> `lumina-agent-engine.md` (where `buildFinanceSystem()` plugs into `streamFinanceAnswer`).

Files: [`backend/finance/skills.ts`](../../../../backend/finance/skills.ts),
[`backend/finance/skills/equity-analysis.md`](../../../../backend/finance/skills/equity-analysis.md),
`FINANCE_PERSONA` in [`backend/prompt.ts`](../../../../backend/prompt.ts),
`streamFinanceAnswer` in [`backend/index.ts`](../../../../backend/index.ts).

---

## 1. What this is (and the three layers it is NOT)

Lumina has **three different "skill/playbook" mechanisms**. Keep them straight — they live in
different files, load at different times, and you edit them for different reasons.

| Layer | Where | Loads when | Who reads it | Edit it to… |
|-------|-------|-----------|--------------|-------------|
| **Dev skills** (what you're in) | `.claude/skills/**/SKILL.md` + `references/*.md` | Claude Code session, on path/prompt match | *You* (the coding agent) | teach Claude how to build this repo |
| **Compile-time PLAYBOOKS** | `PLAYBOOKS` in [`backend/prompt.ts`](../../../../backend/prompt.ts) | every request, picked by `classifyQuery` | the *product* LLM | bake a per-query-type instruction into the system prompt unconditionally |
| **Runtime skills** (this doc) | [`backend/finance/skills/*.md`](../../../../backend/finance/skills/) | *mid-turn, on demand* when the model calls `loadSkill` | the *product* LLM | add a domain procedure the model pulls only when the task matches |

The runtime-skills layer is the pi/Anthropic "Skills" idea ported onto the Vercel AI SDK: a cheap
**manifest** of `name: description` lines always in the prompt, and the **full body** fetched lazily
through a tool. It is the right home for finance *procedure* ("how to analyze one stock", "how to
compare two ETFs") — keep *engine* knowledge in the dev skills and *always-on* instructions in
`PLAYBOOKS`.

---

## 2. Why progressive disclosure (the token math)

Loading every playbook body into the system prompt every turn is the naive approach and it scales
badly: N skills × full body × every request = a fat, mostly-irrelevant prompt the model pays for on
turns where it uses none of them.

```
Naive:        system = persona + body(equity-analysis) + body(etf-compare) + body(...) + ...
              → grows linearly with the skill library; paid on every turn

Disclosed:    system = persona + "<available_skills>\n- equity-analysis: <one line>\n- ...\n</available_skills>"
              → ~one line per skill; the body costs tokens ONLY on the turn the model loads it
```

Each manifest entry is a name plus a one-sentence description (the frontmatter `description`), so the
model can *route* — decide which playbook is relevant — without paying for any body. It then spends
the body's tokens on exactly the one turn that needs it via `loadSkill`. This is the same
matching-vs-fetching split as RAG, but the corpus is a hand-curated handful of procedures, not a
vector index.

---

## 3. How `skills.ts` works, end to end

```
disk: backend/finance/skills/*.md   (name + description frontmatter + body)
   │  loadSkillsFromDisk()  — runs ONCE at module import
   ▼
SKILLS: Record<name, {name, description, body}>     // the registry
   │
   ├─ skillsManifest()  → "<available_skills>\n- name: description\n…</available_skills>"
   │      └─ buildFinanceSystem() = FINANCE_PERSONA + manifest   → system prompt
   │
   └─ loadSkill (tool)  → execute({name}) → { skill, instructions: body }   // body on demand
```

### 3a. Parse — minimal frontmatter, no YAML dependency
`parseSkill` (in [`skills.ts`](../../../../backend/finance/skills.ts)) regex-matches a leading
`---\n…\n---` block and pulls exactly two fields with line-anchored regexes:

```ts
const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
// front.match(/^name:\s*(.+)$/m)   front.match(/^description:\s*(.+)$/m)   body = m[2].trim()
```

Consequences you must respect when authoring a playbook:
- `name:` and `description:` must each be on **one line**. A multi-line folded (`>`) description —
  legal in the dev SKILL.md frontmatter — will be **truncated to its first line** here, because the
  regex captures `(.+)` up to the newline only. Keep runtime descriptions single-line.
- If there is **no** `---…---` block, the whole file becomes `body` with `name`/`description`
  `undefined` → the skill is silently **skipped** (see 3b).

### 3b. Register — both fields required, invalid skills skipped
`loadSkillsFromDisk` (in fn `loadSkillsFromDisk`, around [`skills.ts:35`](../../../../backend/finance/skills.ts)) walks the `skills/` dir, ignores non-`.md` files, and:

```ts
if (!parsed.name || !parsed.description) continue; // skip invalid skills (both required)
out[parsed.name] = { name, description, body };
```

The directory is resolved relative to the module via `fileURLToPath(import.meta.url)` — **not** `process.cwd()` — so it resolves the same whether run by Bun locally or in the bundled deploy. The whole load is wrapped in `try/catch`: any read failure logs `[finance skills] could not load skills: …` and returns `{}`.

### 3c. The fail-open contract (the most important property)
```ts
} catch (e) {
  console.warn("[finance skills] could not load skills:", …);
}
return out;   // possibly empty
```
`skillsManifest()` returns `""` when the registry is empty, and `buildFinanceSystem()` then returns
**just** `FINANCE_PERSONA` (no `<available_skills>` block at all):

```ts
return manifest ? `${FINANCE_PERSONA}\n\n${manifest}` : FINANCE_PERSONA;
```

So if the `.md` files aren't bundled into the serverless function, the agent **still answers** — it
just has no special playbooks. Runtime skills are a capability *boost*, never a dependency. This is
deliberate: on Vercel, non-`.js` assets are not guaranteed to be traced into the function bundle, and
a missing-file crash on a chat request would be unacceptable.

### 3d. `loadSkill` — disclosure on demand
The tool the model calls to pull a body (in [`skills.ts`](../../../../backend/finance/skills.ts), `export const loadSkill`):

```ts
export const loadSkill = tool({
  description: "Load the full step-by-step playbook for a finance skill by name when the user's task "
    + "matches one of the entries in <available_skills>. Call this BEFORE answering such a task, then follow it.",
  inputSchema: z.object({ name: z.string().describe("The skill name, exactly as listed in <available_skills>.") }),
  execute: async ({ name }) => {
    const skill = SKILLS[name];
    if (!skill) return { error: `Unknown skill "${name}". Available: ${Object.keys(SKILLS).join(", ") || "none"}.` };
    return { skill: skill.name, instructions: skill.body };
  },
});
```

It is an ordinary AI SDK tool (see `tool-calling-and-loops.md`), so it counts against the
`stopWhen: stepCountIs(6)` loop budget in `streamFinanceAnswer`. On an unknown name it **returns a
typed `{error}` that lists the valid names** rather than throwing — same tool-first discipline as the
data tools: a tool never throws data, it returns a state the model can recover from (the model can
re-call with a corrected name). `loadSkill` is registered in the finance tool set alongside
`getQuote`/`getCrypto`/`getIndices`/`financeWebSearch`.

---

## 4. How the model is steered to use it

Three things make the model actually load and follow a playbook:

1. **The manifest is in the system prompt** — `buildFinanceSystem()` concatenates `FINANCE_PERSONA`
   and the `<available_skills>` block, so the model can see what's loadable.
2. **The persona instructs the protocol** — `FINANCE_PERSONA` tells the model: when a request matches
   an `<available_skills>` entry, call `loadSkill` FIRST, then follow it. The tool's own
   `description` repeats "Call this BEFORE answering … then follow it." (belt and suspenders — the
   instruction lives both in the persona and on the tool).
3. **The body is a tight numbered procedure** that *names the exact tools to call*, so following it
   drives the rest of the loop (see the equity-analysis example below).

---

## 5. Anatomy of a runtime playbook (the gold shape)

[`equity-analysis.md`](../../../../backend/finance/skills/equity-analysis.md) is the reference shape — copy it:

```md
---
name: equity-analysis
description: Analyze a single stock — fetch its quote (and recent news if relevant), explain the move and context neutrally, and present it WITHOUT giving buy/sell advice. Use when the user asks to analyze, break down, or give a view on a specific company or ticker.
---
# Equity analysis

When the user asks you to analyze a specific stock:
1. Call **getQuote** for the ticker …
2. If they ask *why* it moved … call **financeWebSearch** … cite sources as [n].
3. Structure the answer: one-line summary; **What's happening**; **Context**; **Risks to watch**.
4. State the as-of time. Never say buy/sell/hold … End with "Not financial advice."
```

What makes it good — the checklist for any new playbook:

| Property | In equity-analysis | Why |
|----------|--------------------|-----|
| Single-line `description` with a **trigger phrase** | "Use when the user asks to analyze, break down, or give a view on a specific company or ticker." | The description is the model's *only* routing signal in the manifest — say the trigger explicitly. |
| Names the **exact tools** to call | `getQuote`, `financeWebSearch` | The playbook drives the tool loop; vague prose ("look up the price") won't route. |
| Short, numbered steps | 4 steps | It's an instruction the model executes, not an essay — it costs tokens on load. |
| Restates the **non-negotiable guardrails** | "Never say buy/sell/hold … End with 'Not financial advice.'" | The persona says it too, but repeating it in the body that's freshly loaded keeps it salient. |
| Defines the **output structure** | one-liner + 3 named sections | Consistent shape across answers; renders cleanly in the shared `<ANSWER>` UI. |

---

## 6. How to add a runtime playbook (the whole task)

Adding a finance procedure is a **content change, not a code change** — that is the point of the system.

1. Drop a new file in [`backend/finance/skills/`](../../../../backend/finance/skills/), e.g. `etf-compare.md`.
2. Frontmatter: a `name` (kebab-case, unique — it's the registry key and what the model passes to
   `loadSkill`) and a **single-line** `description` with an explicit trigger phrase.
3. Body: numbered steps that **name the tools** to call (`getQuote`/`getCrypto`/`getIndices`/
   `financeWebSearch`), the output structure, and the guardrails to restate.
4. **Restart the dev server fully.** `loadSkillsFromDisk()` runs *once at module import*, so a `bun
   --hot` reload will not pick up a brand-new file (same new-file gotcha as the rest of the backend).
   It auto-appears in `skillsManifest()` after restart — no registration, no import edit.
5. Verify: send a matching finance query and confirm the `[finance-hook]` step log shows
   `loadSkill` fired, then the data tools the playbook names.

That's it. No edit to `skills.ts`, `prompt.ts`, or the tool registry.

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Pasting a procedure's full body into `FINANCE_PERSONA` so it's "always available". | Make it a runtime skill — the body costs tokens only on the turn it's loaded; the persona carries the always-on rules only. |
| A multi-line / folded (`>`) `description:` in a runtime `.md`. | One line. The `(.+)$` regex truncates at the first newline — the rest of your description is silently lost. |
| Omitting `name:` or `description:` and wondering why the skill never appears. | Both are required; a skill missing either is silently `continue`-skipped at load. |
| `loadSkill.execute` throwing on an unknown name. | Return a typed `{error}` listing valid names (as it does) so the model can self-correct within the loop. |
| Reading the skills dir from `process.cwd()`. | Resolve via `fileURLToPath(import.meta.url)` so it works under Bun and in the bundled deploy. |
| Letting a missing/un-bundled `.md` crash the chat route. | Keep the `try/catch` → empty registry → `buildFinanceSystem()` falls back to persona-only (fail-open). |
| A vague playbook body ("research the stock and respond"). | Numbered steps that name the exact tools and the output structure — the body drives the tool loop. |
| Editing `tools.ts`/`prompt.ts` to "register" a new playbook. | Just drop the `.md` in `skills/` and restart — auto-discovered. |
| Putting *engine* knowledge (model routing, compaction) into a runtime skill. | That belongs in these dev skills; runtime skills hold finance *domain procedure* only. |

---

## 8. Porting the pattern to another vertical

`skills.ts` is finance-coupled in exactly two spots — everything else is generic:
- it imports `FINANCE_PERSONA` for `buildFinanceSystem()`, and
- it reads a hardcoded `skills/` subdir relative to its own module.

To give, say, the `assistant` vertical its own runtime library: copy the parse/load/manifest/
`loadSkill` machinery, point it at that vertical's own `skills/` folder, and compose the manifest with
that vertical's persona. Keep the fail-open `try/catch` and the both-fields-required skip. The
`loadSkill` tool is per-vertical (its closure references that vertical's `SKILLS`), so register the
right one in each vertical's tool factory — finance does this in `buildFinanceTools()` in
[`backend/finance/tools.ts`](../../../../backend/finance/tools.ts).

---

## 9. Quick reference — function map

| Symbol (in [`skills.ts`](../../../../backend/finance/skills.ts)) | Role |
|--------|------|
| `parseSkill(raw)` | regex frontmatter parse → `{name?, description?, body}` |
| `loadSkillsFromDisk()` | walk `skills/*.md`, skip invalid, build the registry; try/catch fail-open |
| `SKILLS` | the in-memory registry `Record<name, FinanceSkill>`, built once at import |
| `skillsManifest()` | `<available_skills>` block of `name: description` lines (or `""`) |
| `buildFinanceSystem()` | `FINANCE_PERSONA` + manifest (or persona alone when empty) |
| `loadSkill` | the AI SDK tool that returns a skill's full `body` on demand |
