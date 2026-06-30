# CURSOR.md

> Cursor: this project's operating manual is **[AGENTS.md](AGENTS.md)** (the
> portable, cross-tool standard) and **[CLAUDE.md](CLAUDE.md)** (the full
> project-specific router). Read both. Project rules also live in
> [`.cursor/rules/`](.cursor/rules/) and load automatically.

## The short version

- The portable agent harness lives under [`.claude/`](.claude/AGENTIC-HARNESS.md):
  **skills** (how to build), **rules** + **rules-topical** (constraints + deep
  dives), **memory** (durable facts + operator preferences).
- **Invoke the most specific skill(s) BEFORE writing code** — see
  [`.claude/rules-topical/skill-dispatch.md`](.claude/rules-topical/skill-dispatch.md).
- Operating standard (senior-agent discipline, answer-before-acting, no hacks,
  verify-before-done, confirm-before-big-work, build-at-scale): see
  [AGENTS.md §3](AGENTS.md).

See [AGENTS.md](AGENTS.md) for the full standard.
