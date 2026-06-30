# GEMINI.md

> Gemini CLI: this project's operating manual is **[AGENTS.md](AGENTS.md)** (the
> portable, cross-tool standard) and **[CLAUDE.md](CLAUDE.md)** (the full
> project-specific router). Read both before acting.

## The short version

- The portable agent harness lives under `.claude/` (see
  [`.claude/AGENTIC-HARNESS.md`](.claude/AGENTIC-HARNESS.md)): **skills** (how to
  build), **rules** + **rules-topical** (constraints + deep dives), **memory**
  (durable facts + operator preferences under `.claude/memory/preferences/`).
- **Invoke the most specific skill(s) BEFORE writing code** — see
  [`.claude/rules-topical/skill-dispatch.md`](.claude/rules-topical/skill-dispatch.md).
- Operating standard (senior-agent discipline, answer-before-acting, no hacks,
  verify-before-done, confirm-before-big-work, build-at-scale): see
  [AGENTS.md §3](AGENTS.md).

See [AGENTS.md](AGENTS.md) for the full standard.
