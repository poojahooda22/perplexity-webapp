---
name: consolidate-memory
description: "This skill should be used when the user asks to consolidate, dedup, prune, audit, migrate, or summarize the agent's persistent project memory under `.claude/memory/`. Covers the 5-tool API (store/retrieve/update/summarize/discard), the 4-type + tier taxonomy, protected-file safety, MEMORY.md atomic synchronization, citation-grep-before-discard, and the consolidation triggers. Invoke whenever memory hygiene work is requested or when memory file count exceeds 80."
metadata:
  priority: 60
  promptSignals:
    phrases:
      - 'consolidate memory'
      - 'memory audit'
      - 'merge memories'
      - 'memory hygiene'
      - 'dedup memory'
      - 'prune memory'
      - 'retire memory'
      - 'memory consolidation pass'
---

# Consolidate Memory

The persistent project memory under `.claude/memory/` is the long-term spine that survives between Claude Code sessions. It carries the operator's working contract, the codified scar tissue from production incidents, the settled architectural decisions, and the pointer table to where things actually live in the workspace. Without consolidation, that spine drifts: several files repeat the same communication rule, stale paths accumulate, episodic chronicles never age out, and the index loses sync with disk. This skill provides the operational contract for keeping that memory healthy — the 5-tool API, the protected-file list, the citation-grep guard, and the MEMORY.md atomic update discipline. Invoke it whenever memory hygiene work is requested, when file count exceeds 80, or when an incident reveals a hallucinated path or duplicate cluster.

> **Project-relative paths.** All paths below are relative to the repo root unless marked otherwise. The memory directory is conventionally `.claude/memory/` and the archive folder `.claude/memory/archived/` (or wherever this project's `MEMORY.md` index points). Adjust the concrete locations to match the project; the mechanism is what transfers.

## Project state (fill in per project)

- Memory location: `.claude/memory/`
- Current population: `<N>` markdown files + `MEMORY.md` (record the count and verification date when you audit)
- Index: `MEMORY.md` is the always-loaded entry point — every memory operation must keep it in sync
- Archive: `.claude/memory/archived/` (this is where `discard` moves files; create it if absent)
- Foundation docs (optional — if the project keeps an audit/research/needs trail, read those for the full reasoning rather than duplicating it here):
  - an `audit-<date>.md` — audit of all files, duplicate clusters, stale-entry table
  - a `research-<date>.md` — literature review behind the 5-tool API and the design patterns
  - a `project-needs-<date>.md` — this project's specific needs, failure modes, target hierarchy

## When to invoke

- The operator explicitly asks: "consolidate memory", "dedup memory", "prune memory", "audit memory", "summarize memory", "migrate memory", "clean up the agent memory".
- File count in the memory directory exceeds 80 (the 80 ceiling is the consolidation trigger).
- Per-category file count exceeds 15 (e.g. 16+ `feedback_*` files signals deduplication is overdue).
- A session surfaces a hallucinated path (a cited file that does not exist on disk) — run a path-verification pass even if the user did not ask.
- After major rule additions to `.claude/rules/` — memory pointers may need refresh to mirror the new rules.
- Before publishing/syncing memory to a shared repo when memory has not been audited in 30+ days — clean memory before publishing it.
- Never invoke automatically inside an execute/confirmation step of unrelated work. Memory consolidation is a deliberate operation, never a side effect.

## The 4-type taxonomy (primary, backward-compatible)

The existing `type` field on every memory file uses these four values. **Do not change them.** All existing files retain their current `type`.

| type | maps to | examples | retention policy |
|---|---|---|---|
| `user` | The operator's identity, communication contract, command shortcuts | `user_profile.md`, `feedback_command_shortcuts.md`, `feedback_direct_action_sentinel.md` | Never auto-archived. Manual update only. |
| `feedback` | Codified scar tissue from incidents (rules the agent must follow) | `feedback_no_background_agents.md`, `feedback_clean_commit_messages.md`, `feedback_premortem_checklist.md` | Eligible for consolidation when duplicate clusters form. Protected entries (importance >= 7) require human confirmation before any change. |
| `project` | Architecture, settled decisions, project state, future pipeline | `pipeline_stages.md`, `routing_decisions.md`, `subsystem_map.md` | Refresh on staleness. Auto-archive episodic chronicles (daily build log, dated plans) at 30+ days. |
| `reference` | Pointer files — where things live, skill mappings, conventions | `skills-folder-insights-for-agents.md`, `conventions.md` | Refresh on staleness. Rarely consolidated. |

The index (`MEMORY.md`) is itself untyped (it is the index, not a memory entry).

## The cognitive tier (secondary, for consolidation logic)

The cognitive-architecture taxonomy is added as a NEW optional field `tier` for consolidation decisions. It does not replace `type`. Files without `tier` have one assigned during the migration pass (R1 below).

| tier | source | retention semantics | mapping from primary type |
|---|---|---|---|
| `core` | Core persona block | Never auto-archived. Highest protection. | `type: user` → `tier: core` |
| `episodic` | Memory-stream / reflection buffer | Concrete incident; eligible for episodic-to-semantic promotion when 5+ similar entries form a cluster. | `type: feedback` → `tier: episodic` (default) |
| `semantic` | Abstracted world-state | Distilled rule or architectural fact. Refreshed on staleness, rarely archived. | `type: project` → `tier: semantic` (default) |
| `procedural` | Reusable lookup | Reference table or skill dispatch — append-mostly, prune duplicates. | `type: reference` → `tier: procedural` |
| `deprecated` | Archived but retained for audit | Lives in archive folder; no longer in MEMORY.md; preserved on disk. | Set on archive, never on a live memory entry. |

Override: a `feedback` file may be tagged `tier: semantic` when consolidation promotes it (e.g. a merged `feedback_communication.md` summarizing several episodic style preferences becomes a single semantic rule). The `type` stays `feedback`; only `tier` changes.

## The 5-tool API

These five operations define the skill's surface. All operations work on files only — no database, no vector index. The mechanical implementation lives in a project script (e.g. `.claude/scripts/consolidate-memory.mjs`); this skill provides the LLM-driven judgment (which entries to merge, what the consolidated body should say, whether a duplicate is real or coincidental).

### store(name, type, body, metadata)

- Input: `name` (string — becomes filename `{name}.md`), `type` (one of `user | feedback | project | reference`), `body` (markdown for the file body, no frontmatter), `metadata` ({importance: 1-10, keywords: string[], tags: string[], links: string[], tier?: string})
- Output: file path of created file (relative to the memory directory); confirmation that MEMORY.md entry was appended
- Behavior:
  1. Verify `name` does not collide with an existing file. If it does, halt with `CONFLICT_EXISTING_FILE` and surface the existing path.
  2. Run dedup check: tokenize topic + first 200 chars of body, scan keyword overlap against existing files. If any file shows ≥80% overlap, surface as `DUPLICATE_CANDIDATE` and recommend `update` instead of `store`.
  3. Compute `tier` from `type` if not provided (use the mapping table above).
  4. Write `{name}.md` with YAML frontmatter populated from metadata plus `created: <ISO 8601>`, `last_accessed: <ISO 8601>`, `access_count: 1`.
  5. Append a one-line pointer to MEMORY.md under the appropriate category section (atomic — see "MEMORY.md atomic synchronization").
- Guards:
  - If `type` is `user`, require explicit justification in the call. User-tier entries are rare.
  - If the body contains hygiene-blocked language the project disallows in committed files (e.g. agent/model names, "sprint N", "based on X's technique", URLs in comments, competitor names — whatever this project's commit-hygiene rule prohibits), halt with `HYGIENE_VIOLATION` and surface the offending phrases.
  - If `name` matches a previously-archived filename, halt — re-creating an archived name causes audit confusion.
- Failure modes: on any guard hit, no file is written and MEMORY.md is not touched.

### retrieve(query, type?, k)

- Input: `query` (string), optional `type` filter, `k` (default 5)
- Output: ordered list of `{filename, description, importance, snippet, score}`
- Behavior:
  1. Tokenize query into keywords.
  2. For each candidate file (filtered by `type` if provided), compute keyword overlap against the file's `keywords` and `tags` frontmatter fields.
  3. Composite score = `(keyword_overlap / total_query_keywords) * importance_weight * recency_weight` where `recency_weight = 1 / (1 + days_since_last_accessed / 30)` per ACT-R base-level activation simplified.
  4. Return top k by composite score.
  5. Update `last_accessed` and increment `access_count` on returned files.
- Guards: never returns deprecated entries (those live in archive, not active memory).
- Failure modes: if no file scores above 0.1, return empty list — the skill never fabricates a match.

### update(name, patch)

- Input: `name` (existing filename without extension), `patch` (object — any subset of `body`, `importance`, `keywords`, `tags`, `links`, `description`, `tier`)
- Output: updated file path; diff summary
- Behavior:
  1. Read existing file. If file does not exist, halt with `FILE_NOT_FOUND`.
  2. Apply patch to frontmatter and/or body.
  3. Update `last_accessed` to current ISO 8601.
  4. If `description` changed, update the corresponding MEMORY.md line atomically.
  5. Write the patched file back.
- Guards:
  - If file has `protected: true` or `importance >= 7`, require explicit `force: true` flag in the call. Log `PROTECTED_OVERRIDE` and surface the change for human confirmation.
  - If patch attempts to change `type` field, halt with `TYPE_IMMUTABLE` — the four types are stable; create a new file with the new type and archive the old one if a re-categorization is genuinely needed.
  - Commit-hygiene scan on patched body before writing.
- Failure modes: on guard hit, no write. Original file is untouched.

### summarize(scope)

- Input: `scope` — one of: single filename, category prefix (e.g. `feedback_`), or `all`
- Output: path(s) to new consolidated file(s); list of archived originals; MEMORY.md diff
- Behavior for category scope:
  1. Read all files matching prefix.
  2. Identify duplicate clusters (keyword overlap > 60% AND description similarity > 60%).
  3. For each cluster, surface the cluster members and proposed merge to the human. Do not merge silently.
  4. After confirmation, call the LLM to produce merged canonical form: union of `keywords`, max of `importance` scores (never average — salience is not diluted by merging), `links: [original filenames]`, `created` = ISO 8601 of merge, body preserves all unique claims from originals.
  5. Write merged file under same category.
  6. Move originals to the archive folder with `tier: deprecated` added to frontmatter.
  7. Update MEMORY.md: remove original entries, add merged entry under same category section.
- Guards:
  - Never archive a file with `importance >= 8` or `protected: true` without explicit per-file confirmation.
  - Run citation-grep guard (see "Citation-grep guard" below) before each archive.
  - Contradiction detection: if two candidate entries contain semantically opposite instructions for the same subject domain, halt the merge for that pair and surface the conflict — automated merge is only safe when entries are additive, not adversarial.
  - Never re-summarize a previously-summarized file (preserve the original linkage chain to prevent compounding summarization drift).
- Failure modes: on contradiction or guard hit, the cluster stays unmerged; other clusters in the same scope may still proceed.

### discard(target)

- Input: either a specific filename, OR a predicate object `{type?, max_importance?, max_access_count?, min_age_days?, tier?}`
- Output: list of files moved to archive; MEMORY.md entries removed; confirmation
- Behavior:
  1. Resolve target to candidate file list.
  2. For each candidate, run citation-grep guard. If cited, drop from the candidate list and log `CITATION_BLOCK`.
  3. Surface the surviving candidate list to the human for confirmation. Never run blind.
  4. After confirmation, for each confirmed file: read its frontmatter, set `tier: deprecated`, move file to the archive folder.
  5. Remove its MEMORY.md entry (atomic with the file move).
- Default safe predicate (recommended starting point): `{type: "feedback", max_importance: 4, max_access_count: 1, min_age_days: 90}` — low-salience, unaccessed, old episodic entries.
- Guards:
  - Discard NEVER deletes. It archives. Content persists on disk as audit trail.
  - Files with `protected: true` are never candidates regardless of predicate match.
  - Files with `importance >= 7` are never candidates regardless of predicate match (importance >= 7 is the floor for human-in-the-loop confirmation, even for archive operations).
  - Predicate discard without surfacing the candidate list first is the single most dangerous anti-pattern. Always surface.
- Failure modes: any candidate with `CITATION_BLOCK` halts archival of that file but does not block the rest of the batch.

## Protected file list (never auto-rewritten or auto-archived)

Some files encode production-incident scar tissue or load-bearing identity. The skill marks them `protected: true` in frontmatter during the migration pass. `summarize` and `discard` operations never touch them without explicit per-file `force: true` confirmation.

Maintain a per-project protected list. Typical members:

- `user_profile.md` — the operator's identity (the only `tier: core` entry)
- explicit operator directives that must never be silently dropped (e.g. `feedback_no_background_agents.md`, a no-deferring directive, a scope-discipline directive)
- the commit-hygiene / IP rule entry — highest IP-defensibility importance
- pre-edit pre-mortem / safety-checklist entries for the project's high-blast-radius subsystem
- state-reset / resource-cleanup rules for the project's stateful subsystems
- a planning-before-execution protocol entry
- a quality-bar / anti-incrementalism entry
- a settled-decisions entry recording the project's locked architectural calls
- the authoritative subsystem/map entries the project's rules cite by path
- the core product-thesis entry
- command-shortcut and direct-action sentinel entries (load-bearing workflow primitives)
- settled-pipeline / phase-contract architecture entries

A file may be added to this list during a session if the operator designates it protected. The skill respects the runtime-set flag the same way as the migration-set flag.

## Consolidation triggers

- **Per-category file count >= 15** → run a deduplication pass on that category before adding new entries.
- **Total file count >= 80** → run full audit + propose consolidations.
- **Last consolidation > 90 days ago** → run the lightweight audit (path verification, commit-hygiene scan, staleness flag report) even without duplicates.
- **Explicit user request** → always honor.
- **Citation-grep failure during a routine `discard`** → halts that operation; surface for human resolution before retrying.
- **Hallucinated path observed in agent output** → run the path-verification pass against all memory frontmatter immediately.

## Discard predicates (default safe)

Default safe predicate for the `discard` operation:

```
{
  type: "feedback",
  max_importance: 4,
  max_access_count: 1,
  min_age_days: 90,
  tier: "episodic"
}
```

This catches low-salience, unaccessed, old episodic entries — the population most likely to be candidates for archival without losing scar tissue. Never widen the predicate without explicit human confirmation.

Plus explicit-name discards:

- Stale architecture files cited by the audit's "Stale entries" section (an entry that references a non-existent file) — verify staleness, then archive by name.
- Pure-episodic chronicles (a daily build log, a dated plan whose timeline is in the past, a one-off ship report) — archive without LLM consolidation; there is no semantic rule to extract.

Plus the citation-grep guard on every discard, no exceptions.

## Frontmatter contract

Every memory file has YAML frontmatter with these required fields:

```yaml
---
name: <human-readable rule name>
description: <one-sentence summary, ≤180 chars>
type: user | feedback | project | reference
tier: core | episodic | semantic | procedural
importance: <1-10 integer>
created: <ISO 8601 date — YYYY-MM-DD>
last_accessed: <ISO 8601 date — YYYY-MM-DD>
access_count: <integer, starts at 0 or 1>
---
```

Optional fields:

- `keywords: [string, ...]` — terms used by retrieve scoring
- `tags: [string, ...]` — categorical labels (e.g. `communication`, `architecture`, `safety`)
- `links: [filename, ...]` — related-memory references; populated during summarize merges to point back to originals
- `protected: true` — marks file as immune to auto-archive and auto-merge; absence implies `false`
- `relatedRules: [...]` — when the file mirrors codified rules in `.claude/rules/`, list those rule identifiers

Example complete frontmatter:

```yaml
---
name: No Background Agents
description: NEVER use background/parallel agents. The operator wants Claude to do ALL work personally, line by line.
type: feedback
tier: episodic
importance: 9
created: 2026-03-28
last_accessed: 2026-05-04
access_count: 12
keywords: [agents, parallel, subagent, background, defer]
tags: [agent-discipline, operator-directive]
protected: true
---
```

## MEMORY.md atomic synchronization

Every `store`, `update` (when description changes), `summarize`, and `discard` operation must atomically update `MEMORY.md`. The atomic contract:

1. Read MEMORY.md in full.
2. Splice the appropriate category section (e.g. Priority, User, Product, Architecture & Project State, Feedback — Engineering / Agent Behavior / Domain-Specific, Future Pipeline, Reference — match whatever section structure this project's MEMORY.md uses).
3. Apply the operation (add/remove/replace pointer line).
4. Write MEMORY.md back.
5. Apply the file-system change (write `.md`, move to archive, etc.).

If step 5 fails (disk error, permission denied, etc.), step 4's MEMORY.md change must be rolled back to the snapshot read in step 1. The skill keeps an in-memory copy of the original MEMORY.md until both writes succeed; on failure, it restores the snapshot.

A MEMORY.md entry pointing to a non-existent file is the failure mode this discipline prevents (index desynchronization). The next session loads the index, attempts to follow a ghost link, and either fails noisily or silently skips a load-bearing rule.

## Citation-grep guard (mandatory before discard)

Before any `discard` operation archives any file, the skill greps these locations for the filename:

- the root `CLAUDE.md`
- `.claude/rules/**/*.md` (all rule files)
- `MEMORY.md` (the memory index)
- all other memory files' `links:` frontmatter field
- any project wiki/docs pages that may cite memory files (e.g. `.claude/repo-wiki/**/*.md`)
- this `SKILL.md` (the protected file list may cite filenames by name)

If the filename appears in any of these locations, the discard is blocked and the citation is surfaced for human resolution. The guard prevents the most common class of consolidation-induced agent failure: broken references causing session-start errors (stale-but-cited entries).

The grep is case-sensitive and whole-token (a citation like `feedback_no_background_agents.md` will match; a substring match like `feedback_no_background` will not).

## Worked examples

Five worked examples illustrating the operations. Each shows the operation, the decision logic, and the expected output. Substitute your project's actual filenames.

### Example 1 — Migrate one file (add tier/importance/access fields without modifying body)

**Goal:** retrofit `feedback_no_background_agents.md` with the new frontmatter contract.

**Input:**
```yaml
---
name: No Background Agents
description: NEVER use background/parallel agents. The operator wants Claude to do ALL work personally, line by line.
type: feedback
---
```

**Logic:**
1. Map `type: feedback` → default `tier: episodic`.
2. LLM-rate importance: this is an explicit operator directive that, if ignored, immediately violates the operator's stated preference. Score: 9.
3. `created` initialized from file `mtime`: `2026-03-28`.
4. `last_accessed` initialized to `created` (conservative).
5. `access_count` initialized to 0.
6. File is on the protected list → set `protected: true`.
7. Body is untouched.

**Output:** the example frontmatter shown in the "Frontmatter contract" section above. MEMORY.md entry unchanged (description did not change).

### Example 2 — Detect a duplicate cluster

**Goal:** identify the communication-style files flagged as a duplicate cluster.

**Input:** category prefix scope `feedback_`. Run dedup check across all feedback files.

**Logic:**
1. Compute keyword overlap matrix across all feedback files.
2. Files exceeding 60% keyword overlap AND 60% description similarity (a representative communication-style cluster):
   - `feedback_answer_format.md`
   - `feedback_two_line_answers.md`
   - `feedback_concise_responses.md`
   - `feedback_explain_simply.md`
   - `feedback_no_code_blocks_chat.md`
   - `feedback_no_code_blocks_for_text.md`
3. Cluster surfaced to human as `DUPLICATE_CANDIDATE_CLUSTER` with all filenames and their descriptions.
4. None are on the protected list — merge is permitted on confirmation.

**Output:** cluster surfaced. No file modified yet. Awaiting confirmation to proceed to Example 3.

### Example 3 — Summarize a cluster into a canonical file with links to originals

**Goal:** merge the communication-style files into one canonical entry.

**Logic:**
1. After human confirmation of the cluster from Example 2, call the LLM to produce a merged body.
2. Resolve the override hierarchy (the merged rule must preserve the precedence between the originals — e.g. a default answer format, when depth is allowed, and the always-true formatting constraints).
3. Merged file: `feedback_communication.md`
4. Frontmatter:
   - `type: feedback` (preserves type)
   - `tier: semantic` (episodic-to-semantic promotion)
   - `importance: 8` (max of originals)
   - `keywords:` union of all originals
   - `links:` the filenames of all merged originals
   - `created: 2026-05-04`, `last_accessed: 2026-05-04`, `access_count: 0`
5. Write `feedback_communication.md`.
6. For each original: run citation-grep — if not cited (likely), set `tier: deprecated`, move to the archive folder.
7. Update MEMORY.md atomically: remove the original pointer lines from the Priority and Feedback sections; add one new pointer line.

**Output:** one new file, the originals archived, MEMORY.md reflecting the new state.

### Example 4 — Discard a stale file with citation-grep PASS (not cited)

**Goal:** archive `daily_build_log.md` (pure-episodic chronicle, 30+ days since last entry).

**Logic:**
1. Predicate match: `type: project`, `min_age_days: 30`, episodic chronicle marker (single date in body, no abstracted rule). Surfaces as candidate.
2. Citation-grep: search the locations under "Citation-grep guard" for `daily_build_log.md`.
   - CLAUDE.md: not found.
   - `.claude/rules/**`: not found.
   - MEMORY.md: found in the "Future Pipeline" section as a pointer (this is the index reference and is REMOVED by this operation, not a blocking citation).
   - Other memory files' `links:`: not found.
   - Wiki/docs: not found.
   - This SKILL.md: not found.
3. Citation-grep result: PASS (the only hit is the MEMORY.md pointer, which is part of the discard atomic update).
4. Surface candidate to human: "Archive `daily_build_log.md` — pure-episodic chronicle, last entry 30+ days ago, no extracted semantic rule."
5. On confirmation: set `tier: deprecated` in frontmatter, move file to the archive folder, remove MEMORY.md pointer line atomically.

**Output:** file archived. MEMORY.md updated. Audit trail preserved on disk.

### Example 5 — Discard a stale file with citation-grep FAIL (cited — operation blocked)

**Goal:** attempt to archive `subsystem_map.md` (hypothetical: someone proposes that an in-repo source file makes the memory entry redundant).

**Logic:**
1. Predicate match attempted. But the file has `protected: true` (per protected-file list) and `importance: 9`. Both triggers block the predicate path.
2. Even attempting an explicit-name discard with `force: true`: run citation-grep.
   - CLAUDE.md: not found by name.
   - A rule file under `.claude/rules/`: FOUND — a rule cites this memory entry as its prompt-time companion.
   - MEMORY.md: found (will be removed if discard proceeds).
   - Other memory files' `links:`: potentially found.
   - This SKILL.md: FOUND — listed under "Protected file list".
3. Citation-grep result: FAIL (multiple non-MEMORY.md citations).
4. Surface to human: `CITATION_BLOCK — subsystem_map.md is cited by a rule file (prompt-time companion) and by this SKILL.md (protected list). Discard blocked. Resolve citations or keep the file.`
5. Operation halts. No archive, no MEMORY.md change.

**Output:** discard blocked, citations surfaced for human resolution.

## Invocation

A Claude session calls this skill in two ways:

1. **As a slash skill:** `/consolidate-memory <subcommand> [args]` where subcommand is one of `audit`, `migrate`, `summarize`, `discard`, `retrieve`, `store`, `update`. The skill provides the LLM-driven judgment.

2. **Via the implementation script:** `node .claude/scripts/consolidate-memory.mjs <subcommand> [args]`. The script does the file-level work — frontmatter parsing, MEMORY.md splicing, citation grep, file moves to archive. The skill calls the script for mechanical operations and provides the LLM judgment for decisions the script cannot make alone (which entries to merge, what the consolidated body should say, whether two near-duplicates are genuinely the same rule).

Typical session:

1. The operator says "consolidate memory" or the trigger fires.
2. Skill loads. Reads the foundation docs if the project keeps them and they are not already loaded this session.
3. Skill calls the script's `audit` subcommand. Receives: file count by category, duplicate cluster candidates, stale-path candidates, protected-list status report, citation-grep summary.
4. Skill surfaces the audit report to the operator with proposed actions.
5. On confirmation, skill calls the script's `summarize` / `discard` / `migrate` subcommands per the approved plan.
6. Each operation maintains MEMORY.md atomic sync and runs citation-grep before any archive.
7. Final report: files added, files merged, files archived, citations resolved, commit-hygiene hits caught, staleness flags raised. Written to a consolidation report (e.g. `.claude/memory/consolidation-report-<ISO-timestamp>.md`).

The skill never runs `summarize` or `discard` without human confirmation of the surfaced candidate list. `audit` and `retrieve` are read-only and can run autonomously.

## Project-specific failure modes to engineer against

A representative set of failure modes the skill should guard against. Tailor the list to the project; the patterns are general.

1. **Hallucinated paths.** A memory entry cites a file that does not exist on disk (a wrong filename, a renamed-but-not-updated path). The skill's path-verification pass scans every memory file's frontmatter and body for path citations and resolves them against disk. Hits are surfaced for cleanup.

2. **Spec-version-as-filename drift.** Several memory files use a stale path (e.g. an old `*V2` filename) in their bodies. The migration pass patches the body content. Memory *filenames* themselves stay unchanged (cross-references would break) — only the body content is patched.

3. **A rule lives only in `.claude/rules/` with no memory companion.** Some load-bearing rules need a prompt-time memory entry. The skill's first consolidation pass should add the missing NEW memory entry that mirrors the rule.

4. **A fragile contract regressing under bundled commits.** A multi-file contract gets silently swept by an unrelated bundled change. The path-verification pass surfaces the related memory entries for refresh on every consolidation run.

5. **Process / IP-leaking language in committed files.** Commit-hygiene enforcement at memory-write time. Every `store` and `update` runs a hygiene scan; any hit (agent/model names, "sprint N", "based on X's technique", URLs in comments, competitor names — whatever this project's hygiene rule prohibits) blocks the write and surfaces the offending phrases. Memory mirrors to a clean repo; an `.agents/` (or similar) prose exception does NOT apply to memory bodies.

6. **Edit-without-plan failure on a high-blast-radius subsystem.** A planning-before-execution rule is canonical; its prompt-time memory companion mirrors it. Both are protected.

7. **Plan-execution drift and diff-divergent summaries.** The skill's own consolidation report is a diff-truth artifact — it lists exactly what changed. No claims the actual file system does not match.

## What this skill does NOT do

Out of scope:

- **Code-edit memory.** This skill manages markdown files in the memory directory. It does not modify code in any source tree.
- **Embedding-based retrieval.** File-based only. The retrieve operation uses keyword overlap, not vector similarity. At small corpus sizes a vector index is not worth its weight.
- **Automatic discard without confirmation.** Every `summarize` and `discard` operation surfaces a candidate list and waits for human confirmation. Blind automated discard is the failure mode the skill exists to prevent.
- **Modification of `.claude/rules/`.** Those are codified incidents, the canonical source of truth for the rule corpus, not memory. Memory mirrors and points to rules; memory does not edit them.
- **Modification of CLAUDE.md.** CLAUDE.md is the operating manual, not memory. The skill reads it for citation-grep and never writes to it.
- **Cross-project memory.** This skill is scoped to this project's `.claude/memory/`. Other projects have their own memory and their own consolidation context.
- **Restoration from archive.** If the operator needs an archived file back, the operation is manual (move the file from the archive folder back to `.claude/memory/`, restore the MEMORY.md entry). The skill is forward-only.

## References

Per-project, wire these to the actual locations (all relative to the repo root unless the project's memory lives elsewhere):

- audit doc (if the project keeps one)
- research doc (the literature review behind the 5-tool API and design patterns, if kept)
- project-needs doc (if kept)
- script: `.claude/scripts/consolidate-memory.mjs` (the mechanical implementation)
- test cases: `.claude/scripts/consolidate-memory-test-cases.json` (if present)
- canonical rules: `.claude/rules/README.md` (the rule index)
- archive folder: `.claude/memory/archived/`
- memory location: `.claude/memory/`
