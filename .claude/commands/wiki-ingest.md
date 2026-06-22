---
description: Update the repo-wiki after building or changing a feature (ingest pass)
argument-hint: [the feature/area you just changed, e.g. "added Slack connector"]
---

You just finished work on: **$ARGUMENTS**

Run the repo-wiki **ingest** operation defined in `.claude/repo-wiki/WIKI.md` §4. Do not skip steps.

1. Read `.claude/repo-wiki/WIKI.md` (the schema) and `.claude/repo-wiki/index.md` (the catalog) so you
   know the current page set and conventions.
2. Identify every wiki page affected by this change — typically the relevant `features/` page, any
   `flows/` trace whose path changed, and the `entities/` pages it touches (`routes.md`,
   `wire-protocol.md`, `ai-tools-registry.md`, `market-data-providers.md`, `frontend-hooks.md`).
3. **Read the actual changed code first** and update each affected page so its claims and `path:line` /
   `path → symbol` citations match the code as it is now. Never write a citation you have not verified.
4. If a real decision/tradeoff was made, add a `decisions/NNNN-*.md` ADR (why + the alternative rejected).
5. Update the `fresh:` date on every page you touched, and update its one-line entry in `index.md`.
6. Append ONE entry to `.claude/repo-wiki/log.md` at the top, using the parseable prefix
   `## [YYYY-MM-DD] ingest | <short title>` followed by a "Touched:" line listing the pages.

Keep pages short and navigational — point at code, don't duplicate it. Report which pages you changed.
