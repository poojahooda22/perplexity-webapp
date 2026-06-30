---
name: operator command shortcuts
description: Numeric shortcut codes the operator types to trigger fixed workflows. SHORTCUT_PRECOMMIT = pre-commit quality gate then commit+push. SHORTCUT_MERGE = collaborator branch PR+merge with anti-regression triangulation. SHORTCUT_SYNC = bidirectional sync of harness folders (.claude/ etc.) with a private mirror repo. Replace the placeholder codes/paths/repo with the project's real values.
type: feedback
---

> **Genericized harness note.** This file encodes three reusable workflow mechanisms behind numeric
> shortcut codes. The codes (`SHORTCUT_PRECOMMIT`, `SHORTCUT_MERGE`, `SHORTCUT_SYNC`), the mirror repo
> URL, the clone path, and the owned-path tables below are **per-project placeholders** — bind them to
> this project's real shortcut numbers, repo, paths, and ownership boundaries before relying on them.

## SHORTCUT_PRECOMMIT — Pre-Commit Quality Gate

Execute in this exact order. Fix everything found before committing.

### Step 1 — Junk Comment Scan
Scan changed files for banned language (brand names, competitor refs, AI tool names, process language, derivation language). Rewrite bad comments as concise senior-dev descriptions. See the project's banned-language reference for the full list.

### Step 2 — Type Check
Run the project's type checker (e.g. `npx tsc --noEmit`, scoped to changed file paths if possible). Fix ALL type errors before staging. Never let a type error reach production.

### Step 3 — Pattern Scan (grep changed files)
Flag and fix these anti-patterns:
- `console.log` in non-test files — remove or replace with proper error handling
- `// @ts-ignore` or `// @ts-expect-error` without explanation comment — add reason
- `as any` casts in new production code — fix the actual type
- `setTimeout` used as a fix for race conditions — diagnose root cause
- `!important` in CSS — fix layout hierarchy instead
- `z-index: 999` or higher — fix stacking context
- Hardcoded values where design tokens exist — use the token
- `TODO` / `FIXME` / `HACK` / `XXX` comments — resolve or remove
- Empty catch blocks `catch {}` or `catch (e) {}` — add error handling

### Step 4 — Domain Lint (project-specific)
Run any project-specific linters/validators for the language and frameworks in the changed files (the project's own static checks for its primary languages — extend this step per project).

### Step 5 — Security Quick-Check
- No hardcoded API keys, tokens, passwords, secrets
- No `dangerouslySetInnerHTML` without sanitization
- No `eval()` or `new Function()`

### Step 6 — Commit & Push
After all checks pass: stage all changed files → commit with conventional commit format (type(scope): description + body with file names, what changed, why, impact) → push.

---

## SHORTCUT_MERGE — Collaborator Branch Merge (anti-regression protocol)

> **Context:** A past collaborator-branch merge silently reverted hours of the operator's work because no
> pre-merge verification happened. This protocol exists so that failure cannot recur. Every step is
> mandatory. No step may be skipped to "save time."

### Ownership Model (who owns what — bind per project)

**Collaborator-led paths (their branch is authoritative — accept theirs on conflict):**
- The path globs the project designates as collaborator-owned (e.g. backend/shared SDK packages, schema migrations).
- Any file path the operator explicitly names as collaborator-owned at invocation time.

**Operator-led paths (the operator's HEAD is authoritative — prefer ours on conflict):**
- Everything not listed above. Specifically and especially the UI, components, app code, stores, scripts, hooks, styles, and the design system the operator owns.

### Execution steps

#### Step 0 — Confirm branch name
- If the operator names a branch, use it. If not, ask once: "Which branch am I merging?"
- Do NOT guess. Wrong branch = catastrophic blunder.

#### Step 1 — Safety anchor (the undo button)
```bash
git fetch --all --prune
git tag safety-pre-merge-$(date +%Y%m%d-%H%M%S) main
git rev-parse HEAD  # record this — the undo point
```
This tag is the nuclear-option rollback if anything goes wrong downstream.

#### Step 2 — Inspect the incoming diff (READ BEFORE MERGE)
```bash
git log --oneline main..<collab-branch>           # commits coming in
git diff --stat main...<collab-branch>            # file-level scope
git diff --name-only main...<collab-branch>       # flat file list
```
- Count files. If > 50 files touched, something is structurally wrong — investigate before proceeding.
- Check commit authors. If AI-agent commits are present, flag them — they may contain silent reversions.
- Check commit messages. "auto-save", "fix(recovery)", "merge" commits from other agents = high suspicion.

#### Step 3 — Ownership-boundary enforcement
For every file in the diff, classify it into **collaborator-owned** or **operator-owned** per the table above. Output the classification:
```
COLLAB-OWNED (accept theirs): <list>
OPERATOR-OWNED (must verify no reversion): <list>
AMBIGUOUS (ask operator): <list>
```
If ANY operator-owned files appear in the incoming diff, run Step 4 on ALL of them. No exceptions.

#### Step 4 — Triangulation on operator-owned files (the anti-regression check)
For each operator-owned file `F` in the incoming diff:
```bash
BASE=$(git merge-base main <collab-branch>)
git show $BASE:F | sha1sum                    # merge-base blob
git show main:F | sha1sum                     # operator's HEAD blob
git show <collab-branch>:F | sha1sum          # collaborator's blob
```
- If `main` blob == `BASE` blob → operator didn't touch it → safe to accept theirs.
- If `main` blob ≠ `BASE` blob AND `<collab>` blob ≠ `BASE` blob → **BOTH edited → manual review required**. Do NOT auto-merge.
- If `<collab>` blob == `BASE` blob → collaborator didn't touch it → keep ours (no-op).
- Dump the result as a table. Any row needing manual review → STOP and surface to the operator before proceeding.

#### Step 5 — Dry-run merge in a throwaway branch
```bash
git checkout -b merge-dryrun-$(date +%Y%m%d-%H%M%S) main
git merge --no-commit --no-ff <collab-branch>
git diff --stat HEAD                          # what the merge produced
git diff main -- <operator-critical-paths>    # did any operator files silently change?
git merge --abort                             # rewind
git checkout main
git branch -D merge-dryrun-*
```
If the dry-run shows operator-owned files changed in unexpected ways → STOP. Report to the operator.

#### Step 6 — Real merge (only if Steps 2-5 passed clean)
```bash
git checkout main
git merge --no-ff <collab-branch> -m "merge(<scope>): <branch> — <one-line summary>

Collaborator-owned scope: <paths>
Reviewer: <agent>
Safety tag: <tag from step 1>"
```
On conflict:
- Path in **collaborator-owned** list → `git checkout --theirs -- <file>`
- Path in **operator-owned** list → `git checkout --ours -- <file>`
- Path ambiguous → STOP, ask the operator, do NOT guess.

#### Step 7 — Post-merge verification
```bash
npx tsc --noEmit                              # typecheck clean (or the project's check)
git diff <safety-tag>..HEAD --stat            # full merge footprint
git diff <safety-tag>..HEAD -- <operator-critical-paths>  # regression check
```
- If the check fails → fix or revert the merge via the safety tag.
- If any operator-owned file shows unexpected reversion → revert merge, report, restart.

#### Step 8 — Push (only after Step 7 passes clean)
```bash
git push origin main
```
Report to the operator: branch merged, files-changed count, safety tag name, any ambiguous cases resolved.

### Hard rules (never violate)
- **Never `git merge` without the Step 1 safety tag.** The tag is the only undo.
- **Never auto-resolve conflicts in ambiguous paths.** Ask the operator.
- **Never accept an AI-agent authored commit without reading the full diff.** Those are how silent reversions happen.
- **Never skip the triangulation check** on operator-owned files. It is the only way to catch silent reversions.
- **Never rebase the collaborator's branch onto main.** Always `--no-ff` merge to preserve history.
- **Never force-push main.** Ever.

### Why this exists
A past merge was executed by another agent with no triangulation, no safety tag, no ownership check. It silently reverted the operator's work, costing hours of recovery. This protocol is the staff-engineer-grade process that prevents the same blunder from recurring. Follow it step-by-step. Every time. No shortcuts.

---

## SHORTCUT_SYNC — Bidirectional Sync with a private mirror repo (collaborator-safe)

**Target repo:** `<MIRROR_REPO_URL>` (branch: `main`) — placeholder; bind per project
**Clone location:** `<MIRROR_CLONE_PATH>/` — a scratch clone, never edited directly
**Folder mapping (bind per project):** the harness folders to sync (e.g. `.claude/`, and any sibling
agent/config folders) map one-to-one between the mirror clone and the working repo. Sync the
**project-local** harness folders, NOT any global per-user config directory.

**NOT synced (per-machine ephemeral state):**
- Any per-machine bookkeeping/state directory (each machine has its own; syncing corrupts both). ALWAYS exclude.
- Any file the operator marks excluded (e.g. the root project instructions file) — edit it only when explicitly asked.

### Context: collaboration model
The operator shares this repo with a remote collaborator. Both push edits to the synced harness folders. The protocol MUST preserve the collaborator's work — a naive tar-push would silently overwrite any file she edited that the operator also has locally. The three-category classification below is mandatory.

### Execution steps

1. **Update clone:**
   ```bash
   cd <MIRROR_CLONE_PATH> && git fetch origin main && git reset --hard origin/main
   ```
   (Hard reset is safe because the clone is a scratch copy — never edit it directly.)

2. **Three-category classification** — run before ANY writes (one `diff -rq` per synced folder):
   ```bash
   diff -rq <MIRROR_CLONE_PATH>/<folder> <WORKING_REPO>/<folder>
   ```
   Output categorizes into:
   - **Only in clone (remote-only)** → collaborator's new files. PULL these to local.
   - **Only in local (local-only)** → the operator's new files. PUSH these up.
   - **"Files X and Y differ"** → BOTH edited the same file. CONFLICT — requires per-file decision.

3. **Resolve conflicts per-file BEFORE any tar-push:**
   - For each differing file, open both sides, compare line counts + content.
   - **If local is a strict superset of remote** (remote content ⊆ local content) → keep local, no loss.
   - **If remote is strict superset of local** → overwrite local with remote.
   - **If both have unique content** → SHOW the operator the diff, ask which wins (or merge by hand).
   - **Never auto-pick** unless one side is a proven superset.

3a. **Folder-level deletion propagation (tar doesn't delete):**
   - tar-push only ADDS/OVERWRITES; it never removes files the remote has but local doesn't.
   - If local is missing a folder/file that exists remotely, it could be (a) an intentional restructure/delete, or (b) it simply hasn't been pulled yet.
   - **Decision rule:** If the missing path's CONTENT exists locally under a new name/location (check with `find` on a sample file), it's a rename — delete the old path from the clone before tar-push so git logs the move as `R100`. If the content truly isn't elsewhere locally, ask the operator: "path X exists on remote but not locally — intentional delete, or should I pull it back?"
   - Execute deletions on the clone with `rm -rf <path>` BEFORE the tar-push, so `git add -A` picks up the deletion.

4. **Pull remote-only files → local:**
   ```bash
   cp -rn <MIRROR_CLONE_PATH>/<path> <WORKING_REPO>/<parent>/
   ```
   (`-n` = no-clobber; safety belt so pulls never overwrite local.)

5. **Push local → clone (with state exclusion):**
   ```bash
   cd <WORKING_REPO> && tar -cf - \
     --exclude='.git' \
     --exclude='node_modules' \
     --exclude='<per-machine-state-dir>' \
     <synced-folders> | (cd <MIRROR_CLONE_PATH> && tar -xf -)
   ```

6. **Verify real delta:**
   ```bash
   cd <MIRROR_CLONE_PATH> && git add -A && git diff --cached --shortstat && git diff --cached --name-status
   ```
   Expected: only local-only adds + any intentional supersets. If anything collaborator-related appears as `M` (modified) unexpectedly → STOP, investigate.

7. **Commit + push:**
   ```bash
   git -c core.autocrlf=false commit -m "chore(sync): safe bidirectional merge (excl. per-machine state)"
   git push origin main
   ```

### Safeguards (non-negotiable)
- **ALWAYS `git fetch` + `git reset --hard origin/main`** on the clone before diff. Anything less risks diffing against stale state.
- **ALWAYS exclude `.git` dirs** (any nested git repo must not be pushed).
- **ALWAYS exclude `node_modules`** and any per-machine state directory.
- **NEVER tar-push without running step 2 first.** The classification is the ONLY defense against silently overwriting collaborator edits.
- **NEVER auto-resolve "Both edited" conflicts** unless one is a proven content superset. Ask the operator.
- Empty folders are non-issues — git doesn't track them.
- IP hygiene: no agent names, no tool names, no process language in commit messages beyond the sync label.

### Why this exists
An earlier version of this protocol used `diff -rq` only to catch remote-only files, then naively tar-pushed local over the clone. If a collaborator had edited an existing file between syncs, the tar-push silently overwrote her work. The updated protocol (three-category classification + per-conflict resolution + state exclusion) closes that blind spot.

**How to apply:** When the operator triggers SHORTCUT_SYNC, execute immediately in the order above. Steps 1-3 are read-only and always safe to run. Only steps 4-7 write — and only after conflicts are resolved.

---

**How to apply:** When the operator types any of these shortcut codes, execute immediately. No rewrite protocol. No confirmation. Just do it.
