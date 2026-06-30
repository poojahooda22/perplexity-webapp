# AGENTS.md — cross-tool operating manual

> **What this file is.** The single cross-tool context file for *any* coding agent
> working in this repo — Codex/AGENTS-aware tools, Cursor, Gemini CLI, Claude
> Code. It mirrors the essentials and points to the canonical sources so the same
> operating standard applies whichever tool is driving. Claude Code's primary file
> is [`CLAUDE.md`](CLAUDE.md); Cursor also reads [`CURSOR.md`](CURSOR.md) +
> `.cursor/rules/`; Gemini CLI reads [`GEMINI.md`](GEMINI.md). Those three thin
> files defer here.

## 1. This project

**Lumina** — a multi-vertical AI research app (Discover/search, Finance, Health,
Academic, Connectors). The full project router, stack, and the cross-cutting
non-negotiables live in [`CLAUDE.md`](CLAUDE.md) — **read it first for anything
project-specific.** This AGENTS.md carries the *portable operating standard* that
is the same in every repo this harness is synced to.

> When this harness is synced into a different project, only **§1** changes
> (the project name + a pointer to that repo's `CLAUDE.md`). Everything below is
> portable.

## 2. The agentic harness (portable)

This repo runs a portable agent harness under [`.claude/`](.claude/AGENTIC-HARNESS.md).
Its job: **in plain language, the right skills, rules, and memories get invoked
automatically.** The map:

- **Skills** — [`.claude/skills/`](.claude/skills/) — how to build a specific
  thing. The `prompt-intelligence` hook scans these and surfaces a recall menu;
  **invoke the 2–3 most on-target BEFORE writing code** (see
  [`.claude/rules-topical/skill-dispatch.md`](.claude/rules-topical/skill-dispatch.md)).
- **Rules** — [`.claude/rules/`](.claude/rules/) — always-on constraints.
- **Topical rules** — [`.claude/rules-topical/`](.claude/rules-topical/) — on-demand
  deep dives (deep-research, performance, scalability, problem-solving, red-team…).
- **Memory** — [`.claude/memory/`](.claude/memory/) — durable facts +
  [`preferences/`](.claude/memory/preferences/) operator preferences.
- **Hooks** — [`.claude/hooks/agentic/`](.claude/hooks/agentic/) — the engine that
  ties it together on each prompt/tool/stop.

## 3. Operating standard (portable, always)

- **Senior-agent discipline.** Non-trivial work is an iterative loop: gather the
  context an action needs, act through a tool, verify the result, continue or stop
  only when the goal is genuinely met — not when the obvious moves run out.
- **Answer before acting.** State agree/disagree explicitly before describing
  changes. Match effort to the question.
- **Invoke skills first.** If a task touches a specialist surface, invoke the
  fitting skill(s) before editing. This is the highest-leverage move of the turn.
- **No hacks.** No `setTimeout` for races, no swallowed errors, no escape-hatch
  casts over real type bugs, no symptom-fixes without a root-cause. Would a senior
  engineer at a top company ship this? If no, go back.
- **Verify before "done".** Every claim maps to evidence from this session, not
  memory. The diff does what you said, with nothing claimed that it lacks.
- **Confirm before big/irreversible work.** Restate intent + a short plan before a
  multi-file change, a migration, a push/PR, or a change to a shared contract.
- **Build at scale.** State which tier a design survives (demo → traction → real
  load) and what breaks next. (See `rules-topical/scalability.md`.)

## Learned User Preferences

<!-- Multi-tool agents append durable, confirmed operator preferences here. The
     agents-md-bridge hook injects this section into Claude Code's per-prompt
     context. Keep entries short and high-signal; promote stable ones into
     .claude/memory/preferences/. -->

_None recorded yet._

## Learned Workspace Facts

<!-- Durable, non-obvious facts about this workspace that any tool should know
     (build quirks, environment gotchas, conventions not derivable from code).
     Injected into context by the agents-md-bridge hook. -->

_None recorded yet._
