# Git History & IP Protection Rules

## Zero process language in committed files

**Problem:** Git history is a permanent public record. Every commit, comment, variable name, and type annotation lives forever. Opposing counsel, competitors, and future hires will read every line. Words that reveal origin, process, or tooling reduce IP defensibility and leak competitive intelligence.

**Rule:** **No word in any tracked file may reveal origin, process, or tooling.** This applies to every source language (TypeScript, Python, CSS, SQL), to JSON, YAML, Markdown, `.gitignore`, config files, test descriptions, doc comments, inline comments, variable names, string literals, and commit messages — **everything**.

**Blocked categories:**

1. **People** — No author names, handles, or credits anywhere. Describe the mechanism, not the person.
2. **Platforms & websites** — No external platform names where techniques were learned/hosted. Describe what the code does, not where it came from.
3. **Competitors** — No competitor product names in code files. `README.md` has a narrow exception for market positioning only.
4. **Derivation language** — No "migrated from", "based on X's technique", "ported from", "adapted from", "see paper Y".
5. **AI & agent references** — No "Claude suggested", "Gemini generated", "[tool] caught this". Code was written by the engineering team. Period.
6. **Process labels** — No "sprint N", "batch N", "from today's session", "per [agent]", "approved". Internal workflow artifacts, not engineering documentation.
7. **URLs & citations** — No URLs in comments (functional URLs like XML namespaces and CDN imports in working code are fine). No paper titles, DOI links, or conference names in comments.
8. **Origin markers** — No "standalone build of X", "fork of Y", "implementation of Z's approach".

**How to describe techniques (DO):**
- Name the algorithm or pattern, not its source: "sliding-window rate limiter", "stale-while-revalidate cache", "topological scheduling".
- Name the data structure or property: "cosine similarity over normalized vectors", "atomic guarded decrement".
- Name the architecture: "frame graph pattern", "incremental memoization", "cache-aside with TTL jitter".

**How NOT to describe techniques (DO NOT):**
- "Migrated from [platform]"
- "Based on [person]'s technique from [year]"
- "Referenced via [paper]"
- "Fixed the bug [agent] found"
- "Standalone build of [external thing]"

**Why:** Three reasons:
1. **IP defensibility** — attribution language weakens "invented here" claims in diligence.
2. **Competitive intelligence** — revealing *where* we learned a technique tells competitors where to look.
3. **Professionalism** — process labels ("sprint 3 cleanup") read as amateur; clean engineering descriptions read as senior.

**Enforcement:** There is no automated commit-time scanner. Every line added to a tracked file must pass this rule on its own merit. Self-audit every diff before staging. Write clean from the start — there is no safety net.

**Where process language IS allowed:** the agent-workspace folders only (`.agents/`, `.claude/`, etc.). Planning docs, research notes, rebuttals, retrospectives — these are internal and not part of the public git contract for code. (If those folders are committed at all, they are acknowledged workspace documents, not engineering artifacts.)

**How to apply:**
- Before staging any file, grep for: names, URLs, "migrated", "based on", "sprint", "Claude", "Gemini", "per".
- Rename variables that leak origin — `from_[platform]_parser` → `json_parser`.
- If you catch a violation post-commit, fix in a new commit (do not rewrite history). Permanent record is the permanent record.

---

## Agent-workspace folders are never tracked, no `git add -f` bypass

**Problem:** `.agents/`, `.claude/`, `.cursor/`, `.gemini/` are all listed in `.gitignore` precisely because they hold AI tool config, planning notes, audit reports, internal architecture memos, and other workspace artifacts that reveal origin, process, and tooling — exactly the leak surface the rule above exists to prevent. `.gitignore` only blocks untracked files; it does not block `git add -f`. Past sessions have force-added audit reports under `.agents/audits/`, producing dozens of tracked files inside a folder whose own `.gitignore` line says "never track this". A public host then renders the leak (folder visible on the public repo page, file paths containing tool names like `*-claude-*.md` or `Gemini analysis.md`). Reverting after-the-fact requires a deletion commit and remains in history forever.

**Rule:** **The four agent-workspace folders are NEVER tracked under ANY circumstance:**

1. `.agents/`
2. `.claude/`
3. `.cursor/`
4. `.gemini/`

**Including every subfolder and every file recursively.** `git add -f` into any of these paths is BANNED. No phase reports, no audit logs, no planning docs, no rebuttals, no architecture memos, no rule files, no skill files under these paths reach git history. Each contributor maintains their own local copy of `.claude/rules/`, `.claude/skills/`, and equivalents under the other three folders — distribution happens out-of-band (shared script, external repo, README pointers), not via this repo's history. If a document needs to live in version control, it lives under `docs/` or another tracked path with content that passes the zero-process-language rule above.

**Why:**

- **`.gitignore` is a contract.** A folder marked gitignored is a workspace folder by definition; force-adding inside it bypasses the contract and dilutes its meaning.
- **IP leak surface.** Every file path inside `.agents/audits/*-claude-*.md` or a personal-named folder like `<name>/analysis-by-gemini.md` reveals which agent or tool authored the artifact. This is a direct violation of the zero-process-language rule in path metadata.
- **A public host's repo page shows folder names at the top level.** Folders like `.agents/` and any personal-named workspace folder appear in the file browser even when their contents are reasonable, signaling "internal workspace shipped to the public repo" to anyone who lands on the page.
- **History is permanent.** A removal commit doesn't remove the files from history — `git log --diff-filter=A` will still surface the original add. Squashing or filter-repo is destructive history rewrite. The only durable defense is to never force-add in the first place.

**How to apply:**

- Need to share an audit doc / plan / rebuttal with another contributor? Write it under `docs/` (or open a PR description, an issue, an internal wiki), with content that passes the zero-process-language rule.
- Need a session-local working note? Keep it in `.agents/` — it stays on your disk only; future you and other agents on your local clone read it via the rules pipeline.
- Catching yourself reaching for `git add -f .agents/whatever.md` → STOP. That's the bypass this rule forbids. Either the document doesn't need to be in version control (default), or it belongs under a tracked path with appropriate content.
- Reviewing a PR diff that contains `+++ b/.agents/...` or `+++ b/.cursor/...` or `+++ b/.gemini/...` → REJECT. No exceptions.
