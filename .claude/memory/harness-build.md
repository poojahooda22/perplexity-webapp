---
name: harness-build
description: "Why the .claude/ harness is shaped the way it is (memory/rules/hooks/commands/agents) and the decisions made when it was built."
type: decision
---

# Harness build — decisions

> Built 2026-06-23. The repo's `.claude/` previously had only `settings.json`,
> `settings.local.json`, `skills/`, and `repo-wiki/`. The operator asked for the missing **harness**:
> an in-repo memory folder, a rules folder, and hooks — "all combined, what harness is." Inspiration:
> the rareLab `.claude` (`E:\Development\Portfolio-phase2\Akshay-pooja\rare-lab\.claude`). Map of the
> result: [`../HARNESS.md`](../HARNESS.md).

## Key finding

rareLab's "harness" is **not** a wall of folders — it has **no** `rules/`, `hooks/`, or `commands/`
dirs. Its power is a disciplined `memory/` folder: a defined **load order** (`prompt.md → cto_rules.md
→ MEMORY.md → skills-folder-insights → domain files`), a `domain-memory-segregation.md` routing doc,
and a mandatory **prompt-rewrite protocol**. The discipline is the harness, not the folder count.

Lumina is already *ahead* of rareLab in places: a `CLAUDE.md` router, a `repo-wiki/` (rareLab has
nothing like it) whose `rules/` subfolder already mirrors the 7 code non-negotiables, 18 skills + a
dispatch README, and a Stop hook. The gap was the **memory + surfaced-rules + session-start** layer.

## Decisions made (operator-chosen)

1. **Memory model = SPLIT (team vs personal).** `.claude/memory/` = committed, team-shared durable
   knowledge (architecture, the sources-ledger, conventions). The operator's **global** auto-memory
   stays for personal cross-session recall (research/strategy notes are NOT committed to the repo).
   `SessionStart` surfaces the in-repo index. Rationale: keeps private strategy out of git while making
   the repo self-contained for a teammate.
2. **Prompt protocol = LIGHT.** Confirm intent + a short plan before multi-file / irreversible work;
   act directly on small/clear asks. (Rejected rareLab's full mandatory rewrite-and-wait-on-every-prompt
   as too heavy.) Encoded in [`../rules/confirm-before-big-work.md`](../rules/confirm-before-big-work.md).
3. **Extras built:** a PreToolUse **licensing guard** (nudges on `commercialOk:true` edits, asks on
   `.env` writes), a `commands/` folder (`/sources-lint`, `/harness-check`), and an `agents/` folder
   (the `finance-data-researcher` subagent). **Deferred:** the skills `_TEMPLATE` + `/skill-lint`.

## What did NOT change

- The 7 code non-negotiables still live canonically in `CLAUDE.md` + `repo-wiki/rules/`. The new
  `.claude/rules/` **surfaces and indexes** them (and adds the brand / scale / skill-layer / prompt
  rules) — it does **not** re-copy their detail (avoids triplication).
- The runtime product-skill system (`backend/finance/skills/`) and tools (`backend/finance/tools.ts`)
  are unchanged; the new [`../rules/skill-layer-law.md`](../rules/skill-layer-law.md) just documents the
  dev-skill vs runtime-skill vs tool distinction so future additions land in the right layer.

## Related

The licensing verdicts the guard/ledger enforce come from the finance-parity research (in the
operator's global memory: `finance-parity-research`). [[sources-ledger]] is the in-repo extract.
