# Team Memory — contract

> **In-repo, committed, team-shared** durable knowledge. Distinct from the operator's **global**
> auto-memory (`~/.claude/projects/<this-project>/memory/`, not in git), which holds personal
> cross-session recall. This folder holds facts a teammate or a future session needs to work on the
> codebase. See [`../HARNESS.md`](../HARNESS.md) for the team-vs-personal split.

## What goes here (and what does NOT)

| Put it here (in-repo) | Put it elsewhere |
|---|---|
| Architecture decisions (why we did X) | In-flight research / strategy notes → **global** memory |
| The licensing `sources-ledger` (team needs it; a hook reads it) | Code structure / "where does X live" → [`../repo-wiki/`](../repo-wiki/index.md) |
| Cross-cutting conventions that aren't a rule | An always-on constraint → [`../rules/`](../rules/README.md) |
| Non-obvious gotchas a teammate would re-hit | How to *build* something → a [`../skills/`](../skills/README.md) skill |

Don't duplicate the repo-wiki (the noun-map), the skills (the verbs), or the rules (the constraints).
Memory is for **durable facts and decisions** that don't fit those.

## File shape

Each memory is one file, one topic, with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary>
type: decision | reference | project | convention
---

<the fact. Link related memories with [[their-slug]].>
```

`decision` — why we chose an approach (ADR-lite). `reference` — looked-up data (e.g. the ledger).
`project` — durable project state/constraints. `convention` — a team norm that isn't a hard rule.

## Index discipline

After adding/updating a file, add or update its one-line pointer in [`MEMORY.md`](MEMORY.md)
(`- [Title](file.md) — hook`). `MEMORY.md` is the index the `SessionStart` hook surfaces every
session — keep it one line per memory, never put memory content in it.

## Hygiene

- Before adding, check for an existing file that already covers it — **update, don't duplicate**.
- Delete memories that turn out to be wrong (don't leave a contradiction).
- A `[[slug]]` link to a memory that doesn't exist yet is fine — it marks something worth writing.
- Verify any `file:line` reference against live code before relying on it — line numbers drift.