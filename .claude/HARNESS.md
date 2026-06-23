# Lumina Harness — the project's Claude Code setup

> **What "harness" means here.** The combination of everything in `.claude/` (plus the root
> `CLAUDE.md`) that shapes how Claude works in this repo: the **router**, the **skills**, the
> **structural map**, the **rules**, the **memory**, and the **hooks**. This file is the one-page
> map of all of it. Read it once; it tells you where everything lives and how the pieces fit.

## The layers (and the one-line test for each)

| Layer | Where | What it is | One-line test |
|---|---|---|---|
| **Router** | [`CLAUDE.md`](../CLAUDE.md) | The switchboard loaded on every prompt — routes a task to the right skill + states the cross-cutting rules. | "Loaded every time; points everywhere else." |
| **Dev-skills** | [`skills/`](skills/README.md) | Flat specialists that make *Claude-the-builder* an expert in one part of the codebase. Loaded on demand. **Not shipped at runtime.** | "Does this teach how to **build/change code**?" |
| **Runtime product-skills** | [`backend/finance/skills/`](../backend/finance/skills/) | Markdown the **finance agent** loads at runtime via the `loadSkill` tool to answer a user. | "Does this teach the **shipped model** how to answer?" |
| **Tools** | [`backend/finance/tools.ts`](../backend/finance/tools.ts) | Code the model **calls** to fetch grounded data (wrapped in `withGuard` + cache + budget). | "Does this **fetch** a number/series?" |
| **Structural map** | [`repo-wiki/`](repo-wiki/index.md) | The file-cited "what exists & where" map. **Read before grep.** | "Where does X live?" |
| **Rules** | [`rules/`](rules/README.md) | The always-on operating rules, surfaced at session start. | "A constraint that always applies." |
| **Memory** | [`memory/`](memory/README.md) | Committed, **team-shared** durable knowledge (decisions, the sources-ledger, conventions). | "A durable fact a teammate/future session needs." |
| **Hooks** | [`hooks/`](hooks/README.md) + [`settings.json`](settings.json) | Event-driven automation (load context, guard edits, check freshness). | "Something that should fire automatically." |
| **Commands** | [`commands/`](commands/) | Project slash-commands (`/sources-lint`, `/harness-check`). | "A repeatable operator action." |
| **Agents** | [`agents/`](agents/) | Custom subagent definitions reusable via the Agent tool. | "A specialist fan-out worker." |

> The three skill/tool layers are easy to confuse — see [`rules/skill-layer-law.md`](rules/skill-layer-law.md)
> for the decision table on where a new thing goes.

## Memory: team (in-repo) vs personal (global)

There are **two** memory stores, on purpose:

- **`.claude/memory/`** (this repo, committed) — **team-shared** durable knowledge that should travel
  with the codebase: architecture decisions, the licensing `sources-ledger`, conventions. A teammate
  who clones the repo gets it. See [`memory/README.md`](memory/README.md).
- **The global auto-memory** (`~/.claude/projects/<this-project>/memory/`, **not** in the repo) —
  personal, cross-session recall (strategy/research notes, work-in-progress). Stays private to the
  operator's machine.

Rule of thumb: *would a teammate need this to work on the repo?* → in-repo. *Is it a personal note or
in-flight research?* → global.

## Session load order (what `SessionStart` surfaces)

1. `CLAUDE.md` (always loaded by the harness) — the router + non-negotiables.
2. `.claude/memory/MEMORY.md` — the index of team memory (read the relevant file before related work).
3. `.claude/rules/README.md` — the operating rules in force.
4. `.claude/repo-wiki/index.md` — consult before grepping for code.

The [`hooks/session-start.sh`](hooks/session-start.sh) hook prints (2)–(4) at the start of every session.

## "Done" definition for a feature (the harness's quality gate)

A feature/sub-tab is not "done" until:
1. `repo-wiki/` has its route + flow (run `/wiki-ingest`).
2. Any new data source has a row in [`memory/sources-ledger.md`](memory/sources-ledger.md) with a
   verdict + governing clause.
3. The [`commercial-ok-gate`](rules/commercial-ok-gate.md) holds (no `commercialOk:true` without a GREEN ledger row).
4. The R-SCALE battery is answered in writing for any list/search/contested/spike surface
   (see [`rules/product-at-scale.md`](rules/product-at-scale.md)).
5. Tests are added/updated (`bun-testing` / `backend-testing`).

## How to extend the harness

- **New rule** → add `rules/<name>.md` + a line in `rules/README.md`.
- **New team memory** → add `memory/<slug>.md` (with frontmatter) + a line in `memory/MEMORY.md`.
- **New hook** → script in `hooks/`, wire in `settings.json`, document in `hooks/README.md`. (Hooks load
  at session start — restart Claude Code to pick up changes.)
- **New command** → `commands/<name>.md`. **New agent** → `agents/<name>.md`.
- **New skill** → a folder under `skills/` following the existing `SKILL.md` shape; add it to `skills/README.md`.
