# Skill Dispatch & Routing (portable)

> **Status.** Reference contract for the portable agentic harness. Skill
> auto-injection is handled by the `prompt-intelligence` UserPromptSubmit hook
> ([`../hooks/agentic/prompt-intelligence.mjs`](../hooks/agentic/prompt-intelligence.mjs)),
> which scans THIS project's `.claude/skills/`, scores the prompt, and surfaces a
> recall menu. This file documents the contract for human readers and as the
> fallback when the hook is unavailable (e.g. inside a subagent, or before the
> hook is wired). It is **project-agnostic**: it routes by mechanism, never by a
> hardcoded per-domain table.

## The rule of thumb

**Match the MOST SPECIFIC skill. Invoke 2–3 per task, BEFORE writing code.** The
hook casts a *wide* recall menu (what might apply); you supply the *precision*
(which 2–3 actually fit this task's real code path). Ignore an off-target
candidate; invoke a better-fit skill the menu missed.

## Skill Invocation — Non-Optional

**Before ANY code, invoke the relevant skill(s).** The cost of loading is
near-zero; the cost of missing a project convention is hours. If there is even a
small chance a skill applies, invoke it. Skills carry project-specific knowledge
your training data does not have — conventions, anti-patterns, and rules learned
the hard way. A skill informs HOW to write the code, so invoking it *after*
writing is too late.

## How the matcher works (so you can author for it)

The scorer ([`../hooks/agentic/skill-scoring.mjs`](../hooks/agentic/skill-scoring.mjs))
reads each skill's `SKILL.md` frontmatter. A skill matches on `name` +
`description` alone (weak), but matches **precisely** when it declares optional
`metadata.promptSignals`:

```yaml
---
name: my-skill
description: One line — loaded verbatim into the system prompt AND scored against the prompt.
metadata:
  priority: 60                       # tiebreaker among equal scores (default 50)
  pathPatterns: ["backend/x/**", "**/*.tool.ts"]   # boosts when those files are uncommitted
  promptSignals:
    minScore: 8                      # bar to count as a CONFIDENT match
    phrases: ["distinctive", "domain", "keywords"]  # the authoritative signal
    anyOf:  ["a", "b"]               # disqualify unless ≥1 present (precision gate)
    allOf:  ["x", "y"]               # disqualify unless ALL present
    noneOf: ["mobile", "native"]     # disqualify if ANY present
---
```

- **`phrases`** are the strong signal — a distinctive single keyword (`zustand`,
  `prisma`, `commercialOk`) can clear the bar alone; generic words are contained
  by `minScore` and the gates, not by starving the score.
- **`anyOf` / `allOf` / `noneOf`** are hard precision gates — they disqualify
  regardless of score, so a skill never fires on the wrong surface.
- **`pathPatterns`** boost a skill when a matching file is uncommitted (the work
  is clearly in that area).

Authoring a skill well = giving it honest `phrases` + the right gates. That is the
only "routing table" — it lives in each skill, not in a central file, which is
why the harness is portable.

## File-based dispatch (optional)

When an edit targets a known path, [`../hooks/agentic/file-dispatch.mjs`](../hooks/agentic/file-dispatch.mjs)
can remind you to invoke a skill + read a topical rule first. Its map is **data**,
not code: edit [`../hooks/agentic/file-skill-map.json`](../hooks/agentic/file-skill-map.json)
for this project. Empty map = no-op.

## Multi-skill combinations

Load 2–3 for complex tasks (e.g. a data feature might want the data-layer skill +
the testing skill; a security-sensitive surface might want the domain skill +
`security-architecture`). The menu surfaces candidates; you compose the final set.

## Skill anti-pattern red flags — if you catch yourself thinking any of these, STOP

| Your thought | Reality |
|---|---|
| "This is just a simple fix." | Simple fixes in unfamiliar code cause regressions. Invoke the skill. |
| "I already know how to do this." | Training data is stale; the skill has PROJECT-SPECIFIC rules. Invoke it. |
| "I'll invoke it after I write the code." | Skills inform HOW to write code. After = too late. Invoke BEFORE. |
| "The skill is overkill for this." | The skill catches the edge cases you won't. Invoke it. |
