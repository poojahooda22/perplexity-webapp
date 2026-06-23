---
description: Verify the .claude/ harness is intact and consistent (folders, hooks, indexes, ledger)
allowed-tools: Read, Glob, Grep, Bash
---

# /harness-check — harness health check

Verify the Lumina harness (see [`.claude/HARNESS.md`](../HARNESS.md)) is present and internally
consistent. Report a checklist with ✅/⚠️/❌ per item and a one-line summary. **Read-only** — propose
fixes, don't apply them unless asked.

Check:
1. **Folders/files exist:** `.claude/HARNESS.md`, `memory/{README,MEMORY}.md`, `rules/README.md`,
   `hooks/{README.md,session-start.sh,precheck-licensing.mjs}`, `settings.json`, `skills/README.md`,
   `repo-wiki/index.md`.
2. **Hooks wired:** `settings.json` has `SessionStart`, `PreToolUse` (matcher `Write|Edit`), and `Stop`.
   The script paths referenced actually exist.
3. **Memory index in sync:** every `memory/*.md` (except `README`/`MEMORY`) has a one-line entry in
   `MEMORY.md`, and every `MEMORY.md` link points to a file that exists. No orphans, no dangling links.
4. **Rules index in sync:** every `rules/*.md` (except `README`) is listed in `rules/README.md`.
5. **Hook sanity:** run the manual tests from `hooks/README.md` (the session-start script prints, the
   licensing guard nudges on `commercialOk: true` and is silent on a plain edit).
6. **Ledger sanity:** `memory/sources-ledger.md` parses as a table and every row has a verdict.

Summarize what's healthy and what drifted; suggest the specific fix for each ⚠️/❌.