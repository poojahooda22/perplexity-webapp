---
description: Health-check the repo-wiki for drift, staleness, orphans, gaps, and contradictions
argument-hint: [optional — a single area to lint, e.g. "finance"]
---

Run the repo-wiki **lint** operation defined in `.claude/repo-wiki/WIKI.md` §4. Scope: ${ARGUMENTS:-the whole wiki}.

For each page under `.claude/repo-wiki/` (respecting the scope above), check the five drift classes:

1. **Drift** — re-read each file in the page's `cites:` frontmatter; flag any claim describing a route,
   handler, event type, tool, or symbol that no longer matches the code. Quote the page line and the
   current code so the mismatch is obvious.
2. **Staleness** — for each cited path run `git log -1 --format=%cs -- <path>`; if the file changed after
   the page's `fresh:` date, mark the page **suspect** (needs re-verification).
3. **Orphans** — pages with no inbound links from `index.md` or sibling pages.
4. **Gaps** — code with no page: new HTTP routes missing from `entities/routes.md`, AI-SDK tools missing
   from `entities/ai-tools-registry.md`, a `backend/*` or `frontend/src/components/*` feature dir with no
   `features/` page, providers missing from `entities/market-data-providers.md`.
5. **Contradiction** — two pages making incompatible claims.

Output a single prioritized **punch-list** grouped by class, each item naming the page, the cited code,
and the fix. Do NOT auto-edit pages unless I tell you to fix them — first show me the list. If I approve,
apply fixes and append a `## [YYYY-MM-DD] lint | <summary>` entry to `.claude/repo-wiki/log.md`.