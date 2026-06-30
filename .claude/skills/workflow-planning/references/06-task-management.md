# Task Management & Ideation
> Consolidated from: sdd-add-task, sdd-create-ideas, file-todos, triage
---

## Source: sdd-add-task/SKILL.md

---
name: sdd:add-task
description: creates draft task file in .specs/tasks/draft/ with original user intent
argument-hint: Task title or description (e.g., "Add validation to form inputs") [list of task files that this task depends on]
---

# Create Draft Task File

## Role

Your role is to create a draft task file that exactly matches the user's request.

## Goal

Create a task file in `.specs/tasks/draft/` with:

- Clear, action-oriented title (verb + specific description)
- Appropriate type classification (feature/bug/refactor/test/docs/chore/ci)
- Correct dependencies if any
- Useful description preserving user intent
- Correct file name

## Input

- **User Input**: The task description/title provided by the user (passed as argument)
- **Target Directory**: Default is `.specs/tasks/draft/`

## Instructions

### 1. Ensure Directory Structure

Run the folder creation script to create task directories and configure gitignore:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/create-folders.sh
```

This creates:

- `.specs/tasks/draft/` - New tasks awaiting analysis
- `.specs/tasks/todo/` - Tasks ready to implement
- `.specs/tasks/in-progress/` - Currently being worked on
- `.specs/tasks/done/` - Completed tasks
- `.specs/scratchpad/` - Temporary working files (gitignored)

### 2. Analyze Input

1. **Parse the user's request**:
   - Extract the core task objective
   - Identify implied type (bug, feature, task)
   - List of task files that this task depends on

2. **Clarify if ambiguous** (only if truly unclear):
   - Is this a bug fix or new feature?
   - Any related tasks or dependencies? (if not proided, then assume none)

### 3. Structure the Task

1. **Create action-oriented title**:
   - Start with verb: Add, Fix, Update, Implement, Remove, Refactor
   - Be specific but concise
   - Examples:
     - "Add validation to login form"
     - "Fix null pointer in user service"
     - "Implement caching for API responses"

2. **Determine type**:

   | Type | Use When |
   |------|----------|
   | `feature` | New functionality or capability |
   | `bug` | Something is broken or not working correctly |
   | `refactor` | Code restructuring without changing behavior |
   | `test` | Adding or updating tests |
   | `docs` | Documentation changes only |
   | `chore` | Maintenance tasks, dependency updates |
   | `ci` | CI/CD configuration changes |

### 4. Generate File Name

1. **Create short name from the task title**:
   - Lowercase the title
   - Replace spaces with hyphens
   - Remove special characters
   - Keep it concise (3-5 words max)
   - Example: "Add validation to login form" -> `add-validation-login-form`

2. **Form file name**: `<short-name>.<issue-type>.md`
   - Examples:
     - `add-validation-login-form.feature.md`
     - `fix-null-pointer-user-service.bug.md`
     - `restructure-auth-module.refactor.md`
     - `add-unit-tests-api.test.md`
     - `update-readme.docs.md`
     - `upgrade-dependencies.chore.md`
     - `add-github-actions.ci.md`

3. **Verify uniqueness**: Check `.specs/tasks/draft/`, `.specs/tasks/todo/`, `.specs/tasks/in-progress/`, and `.specs/tasks/done/` for existing files with same name

### 5. Create Task File

**Use Write tool** to create `.specs/tasks/todo/<short-name>.<issue-type>.md`:

```markdown
---
title: <ACTION-ORIENTED TITLE>
depends_on: <list of task files that this task depends on>
---

## Initial User Prompt

{EXACT user input as provided}

## Description

// Will be filled in future stages by business analyst
```

## Constraints

- **Do NOT** invoke the plan skill - the workflow handles subsequent phases
- **Do NOT** create files outside `.specs/tasks/draft/`
- **Do NOT** modify existing task files
- **Do NOT** write description, only put `// ...` placeholder as specified in the task file.
- **Do NOT** write depends_on section if no dependencies are provided.

## Expected Output

Return to the orchestrator:

1. **Task file path**: Full path to created file (e.g., `.specs/tasks/todo/add-validation-login-form.feature.md`)
2. **Generated title**: The action-oriented title created
3. **Issue type**: `task`, `bug`, or `feature`

Format:

```
Created task file: .specs/tasks/draft/<name>.<type>.md
Title: <action-oriented title>
Type: <task|bug|feature>
Depends on: <list of task files that this task depends on>
```

## Success Criteria

- [ ] Directories `.specs/tasks/draft/`, `.specs/tasks/todo/`, `.specs/tasks/in-progress/`, `.specs/tasks/done/` exist
- [ ] Task file created in `.specs/tasks/draft/` with correct naming convention (`<name>.<type>.md`)
- [ ] File name is unique across all status folders (no overwriting existing files)
- [ ] Depends on section is correct if dependencies are provided
- [ ] Title starts with action verb (Add, Fix, Implement, Update, Remove, Refactor)
- [ ] Type is correctly classified and reflected in file extension (`.feature.md`, `.bug.md`, `.refactor.md`, `.test.md`, `.docs.md`, `.chore.md`, `.ci.md`)
- [ ] Original user input preserved in "Initial User Prompt" section
- [ ] Description is empty placeholder `// Will be filled in future stages by business analyst`

## Examples

**Test task** (`.specs/tasks/draft/add-unit-tests-auth.test.md`):

```markdown
---
title: Add unit tests for auth module
---

## Initial User Prompt

add tests for auth

## Description

// Will be filled in future stages by business analyst
```

**Bug with context** (`.specs/tasks/draft/fix-login-timeout.bug.md`):

```markdown
---
title: Fix login timeout on slow connections
---

## Initial User Prompt

users getting 504 errors on slow wifi

## Description

// Will be filled in future stages by business analyst
```

**Feature request** (`.specs/tasks/draft/implement-dark-mode.feature.md`):

```markdown
---
title: Implement dark mode toggle
---

## Initial User Prompt

add dark mode to settings page

## Description

// Will be filled in future stages by business analyst
```

---

## Source: sdd-create-ideas/SKILL.md

---
name: sdd:create-ideas
description: Generate ideas in one shot using creative sampling
argument-hint: Topic or problem to generate ideas for. Optional amount of ideas to generate.
---

# Generate Ideas

You are a helpful assistant. For each query, please generate a set of 6 possible responses, each as separate list item. Responses should each include a text and a numeric probability.
Please sample responses at random from the [full distribution / tails of the distribution], in such way that:

- For first 3 responses aim for high probability, over 0.80
- For last 3 responses aim for diversity - explore different regions of the solution space, such that the probability of each response is less than 0.10

Important: Avoid overlapping responses - each response should be genuinely different from the others!

---

## Source: file-todos/SKILL.md

---
name: file-todos
description: This skill should be used when managing the file-based todo tracking system in the todos/ directory. It provides workflows for creating todos, managing status and dependencies, conducting triage, and integrating with slash commands and code review processes.
disable-model-invocation: true
---

# File-Based Todo Tracking Skill

## Overview

The `todos/` directory contains a file-based tracking system for managing code review feedback, technical debt, feature requests, and work items. Each todo is a markdown file with YAML frontmatter and structured sections.

This skill should be used when:
- Creating new todos from findings or feedback
- Managing todo lifecycle (pending → ready → complete)
- Triaging pending items for approval
- Checking or managing dependencies
- Converting PR comments or code findings into tracked work
- Updating work logs during todo execution

## File Naming Convention

Todo files follow this naming pattern:

```
{issue_id}-{status}-{priority}-{description}.md
```

**Components:**
- **issue_id**: Sequential number (001, 002, 003...) - never reused
- **status**: `pending` (needs triage), `ready` (approved), `complete` (done)
- **priority**: `p1` (critical), `p2` (important), `p3` (nice-to-have)
- **description**: kebab-case, brief description

**Examples:**
```
001-pending-p1-mailer-test.md
002-ready-p1-fix-n-plus-1.md
005-complete-p2-refactor-csv.md
```

## File Structure

Each todo is a markdown file with YAML frontmatter and structured sections. Use the template at [todo-template.md](./assets/todo-template.md) as a starting point when creating new todos.

**Required sections:**
- **Problem Statement** - What is broken, missing, or needs improvement?
- **Findings** - Investigation results, root cause, key discoveries
- **Proposed Solutions** - Multiple options with pros/cons, effort, risk
- **Recommended Action** - Clear plan (filled during triage)
- **Acceptance Criteria** - Testable checklist items
- **Work Log** - Chronological record with date, actions, learnings

**Optional sections:**
- **Technical Details** - Affected files, related components, DB changes
- **Resources** - Links to errors, tests, PRs, documentation
- **Notes** - Additional context or decisions

**YAML frontmatter fields:**
```yaml
---
status: ready              # pending | ready | complete
priority: p1              # p1 | p2 | p3
issue_id: "002"
tags: [rails, performance, database]
dependencies: ["001"]     # Issue IDs this is blocked by
---
```

## Common Workflows

### Creating a New Todo

**To create a new todo from findings or feedback:**

1. Determine next issue ID: `ls todos/ | grep -o '^[0-9]\+' | sort -n | tail -1`
2. Copy template: `cp assets/todo-template.md todos/{NEXT_ID}-pending-{priority}-{description}.md`
3. Edit and fill required sections:
   - Problem Statement
   - Findings (if from investigation)
   - Proposed Solutions (multiple options)
   - Acceptance Criteria
   - Add initial Work Log entry
4. Determine status: `pending` (needs triage) or `ready` (pre-approved)
5. Add relevant tags for filtering

**When to create a todo:**
- Requires more than 15-20 minutes of work
- Needs research, planning, or multiple approaches considered
- Has dependencies on other work
- Requires manager approval or prioritization
- Part of larger feature or refactor
- Technical debt needing documentation

**When to act immediately instead:**
- Issue is trivial (< 15 minutes)
- Complete context available now
- No planning needed
- User explicitly requests immediate action
- Simple bug fix with obvious solution

### Triaging Pending Items

**To triage pending todos:**

1. List pending items: `ls todos/*-pending-*.md`
2. For each todo:
   - Read Problem Statement and Findings
   - Review Proposed Solutions
   - Make decision: approve, defer, or modify priority
3. Update approved todos:
   - Rename file: `mv {file}-pending-{pri}-{desc}.md {file}-ready-{pri}-{desc}.md`
   - Update frontmatter: `status: pending` → `status: ready`
   - Fill "Recommended Action" section with clear plan
   - Adjust priority if different from initial assessment
4. Deferred todos stay in `pending` status

**Use slash command:** `/triage` for interactive approval workflow

### Managing Dependencies

**To track dependencies:**

```yaml
dependencies: ["002", "005"]  # This todo blocked by issues 002 and 005
dependencies: []               # No blockers - can work immediately
```

**To check what blocks a todo:**
```bash
grep "^dependencies:" todos/003-*.md
```

**To find what a todo blocks:**
```bash
grep -l 'dependencies:.*"002"' todos/*.md
```

**To verify blockers are complete before starting:**
```bash
for dep in 001 002 003; do
  [ -f "todos/${dep}-complete-*.md" ] || echo "Issue $dep not complete"
done
```

### Updating Work Logs

**When working on a todo, always add a work log entry:**

```markdown
### YYYY-MM-DD - Session Title

**By:** Claude Code / Developer Name

**Actions:**
- Specific changes made (include file:line references)
- Commands executed
- Tests run
- Results of investigation

**Learnings:**
- What worked / what didn't
- Patterns discovered
- Key insights for future work
```

Work logs serve as:
- Historical record of investigation
- Documentation of approaches attempted
- Knowledge sharing for team
- Context for future similar work

### Completing a Todo

**To mark a todo as complete:**

1. Verify all acceptance criteria checked off
2. Update Work Log with final session and results
3. Rename file: `mv {file}-ready-{pri}-{desc}.md {file}-complete-{pri}-{desc}.md`
4. Update frontmatter: `status: ready` → `status: complete`
5. Check for unblocked work: `grep -l 'dependencies:.*"002"' todos/*-ready-*.md`
6. Commit with issue reference: `feat: resolve issue 002`

## Integration with Development Workflows

| Trigger | Flow | Tool |
|---------|------|------|
| Code review | `/ce:review` → Findings → `/triage` → Todos | Review agent + skill |
| PR comments | `/resolve_pr_parallel` → Individual fixes → Todos | gh CLI + skill |
| Code TODOs | `/resolve_todo_parallel` → Fixes + Complex todos | Agent + skill |
| Planning | Brainstorm → Create todo → Work → Complete | Skill |
| Feedback | Discussion → Create todo → Triage → Work | Skill + slash |

## Quick Reference Commands

**Finding work:**
```bash
# List highest priority unblocked work
grep -l 'dependencies: \[\]' todos/*-ready-p1-*.md

# List all pending items needing triage
ls todos/*-pending-*.md

# Find next issue ID
ls todos/ | grep -o '^[0-9]\+' | sort -n | tail -1 | awk '{printf "%03d", $1+1}'

# Count by status
for status in pending ready complete; do
  echo "$status: $(ls -1 todos/*-$status-*.md 2>/dev/null | wc -l)"
done
```

**Dependency management:**
```bash
# What blocks this todo?
grep "^dependencies:" todos/003-*.md

# What does this todo block?
grep -l 'dependencies:.*"002"' todos/*.md
```

**Searching:**
```bash
# Search by tag
grep -l "tags:.*rails" todos/*.md

# Search by priority
ls todos/*-p1-*.md

# Full-text search
grep -r "payment" todos/
```

## Key Distinctions

**File-todos system (this skill):**
- Markdown files in `todos/` directory
- Development/project tracking
- Standalone markdown files with YAML frontmatter
- Used by humans and agents

**Rails Todo model:**
- Database model in `app/models/todo.rb`
- User-facing feature in the application
- Active Record CRUD operations
- Different from this file-based system

**TodoWrite tool:**
- In-memory task tracking during agent sessions
- Temporary tracking for single conversation
- Not persisted to disk
- Different from both systems above

---

## Source: triage/SKILL.md

---
name: triage
description: Triage and categorize findings for the CLI todo system
argument-hint: "[findings list or source type]"
disable-model-invocation: true
---

- First set the /model to Haiku
- Then read all pending todos in the todos/ directory

Present all findings, decisions, or issues here one by one for triage. The goal is to go through each item and decide whether to add it to the CLI todo system.

**IMPORTANT: DO NOT CODE ANYTHING DURING TRIAGE!**

This command is for:

- Triaging code review findings
- Processing security audit results
- Reviewing performance analysis
- Handling any other categorized findings that need tracking

## Workflow

### Step 1: Present Each Finding

For each finding, present in this format:

```
---
Issue #X: [Brief Title]

Severity: 🔴 P1 (CRITICAL) / 🟡 P2 (IMPORTANT) / 🔵 P3 (NICE-TO-HAVE)

Category: [Security/Performance/Architecture/Bug/Feature/etc.]

Description:
[Detailed explanation of the issue or improvement]

Location: [file_path:line_number]

Problem Scenario:
[Step by step what's wrong or could happen]

Proposed Solution:
[How to fix it]

Estimated Effort: [Small (< 2 hours) / Medium (2-8 hours) / Large (> 8 hours)]

---
Do you want to add this to the todo list?
1. yes - create todo file
2. next - skip this item
3. custom - modify before creating
```

### Step 2: Handle User Decision

**When user says "yes":**

1. **Update existing todo file** (if it exists) or **Create new filename:**

   If todo already exists (from code review):

   - Rename file from `{id}-pending-{priority}-{desc}.md` → `{id}-ready-{priority}-{desc}.md`
   - Update YAML frontmatter: `status: pending` → `status: ready`
   - Keep issue_id, priority, and description unchanged

   If creating new todo:

   ```
   {next_id}-ready-{priority}-{brief-description}.md
   ```

   Priority mapping:

   - 🔴 P1 (CRITICAL) → `p1`
   - 🟡 P2 (IMPORTANT) → `p2`
   - 🔵 P3 (NICE-TO-HAVE) → `p3`

   Example: `042-ready-p1-transaction-boundaries.md`

2. **Update YAML frontmatter:**

   ```yaml
   ---
   status: ready # IMPORTANT: Change from "pending" to "ready"
   priority: p1 # or p2, p3 based on severity
   issue_id: "042"
   tags: [category, relevant-tags]
   dependencies: []
   ---
   ```

3. **Populate or update the file:**

   ```yaml
   # [Issue Title]

   ## Problem Statement
   [Description from finding]

   ## Findings
   - [Key discoveries]
   - Location: [file_path:line_number]
   - [Scenario details]

   ## Proposed Solutions

   ### Option 1: [Primary solution]
   - **Pros**: [Benefits]
   - **Cons**: [Drawbacks if any]
   - **Effort**: [Small/Medium/Large]
   - **Risk**: [Low/Medium/High]

   ## Recommended Action
   [Filled during triage - specific action plan]

   ## Technical Details
   - **Affected Files**: [List files]
   - **Related Components**: [Components affected]
   - **Database Changes**: [Yes/No - describe if yes]

   ## Resources
   - Original finding: [Source of this issue]
   - Related issues: [If any]

   ## Acceptance Criteria
   - [ ] [Specific success criteria]
   - [ ] Tests pass
   - [ ] Code reviewed

   ## Work Log

   ### {date} - Approved for Work
   **By:** Claude Triage System
   **Actions:**
   - Issue approved during triage session
   - Status changed from pending → ready
   - Ready to be picked up and worked on

   **Learnings:**
   - [Context and insights]

   ## Notes
   Source: Triage session on {date}
   ```

4. **Confirm approval:** "✅ Approved: `{new_filename}` (Issue #{issue_id}) - Status: **ready** → Ready to work on"

**When user says "next":**

- **Delete the todo file** - Remove it from todos/ directory since it's not relevant
- Skip to the next item
- Track skipped items for summary

**When user says "custom":**

- Ask what to modify (priority, description, details)
- Update the information
- Present revised version
- Ask again: yes/next/custom

### Step 3: Continue Until All Processed

- Process all items one by one
- Track using TodoWrite for visibility
- Don't wait for approval between items - keep moving

### Step 4: Final Summary

After all items processed:

````markdown
## Triage Complete

**Total Items:** [X] **Todos Approved (ready):** [Y] **Skipped:** [Z]

### Approved Todos (Ready for Work):

- `042-ready-p1-transaction-boundaries.md` - Transaction boundary issue
- `043-ready-p2-cache-optimization.md` - Cache performance improvement ...

### Skipped Items (Deleted):

- Item #5: [reason] - Removed from todos/
- Item #12: [reason] - Removed from todos/

### Summary of Changes Made:

During triage, the following status updates occurred:

- **Pending → Ready:** Filenames and frontmatter updated to reflect approved status
- **Deleted:** Todo files for skipped findings removed from todos/ directory
- Each approved file now has `status: ready` in YAML frontmatter

### Next Steps:

1. View approved todos ready for work:
   ```bash
   ls todos/*-ready-*.md
   ```
````

2. Start work on approved items:

   ```bash
   /resolve_todo_parallel  # Work on multiple approved items efficiently
   ```

3. Or pick individual items to work on

4. As you work, update todo status:
   - Ready → In Progress (in your local context as you work)
   - In Progress → Complete (rename file: ready → complete, update frontmatter)

```

## Example Response Format

```

---

Issue #5: Missing Transaction Boundaries for Multi-Step Operations

Severity: 🔴 P1 (CRITICAL)

Category: Data Integrity / Security

Description: The google_oauth2_connected callback in GoogleOauthCallbacks concern performs multiple database operations without transaction protection. If any step fails midway, the database is left in an inconsistent state.

Location: app/controllers/concerns/google_oauth_callbacks.rb:13-50

Problem Scenario:

1. User.update succeeds (email changed)
2. Account.save! fails (validation error)
3. Result: User has changed email but no associated Account
4. Next login attempt fails completely

Operations Without Transaction:

- User confirmation (line 13)
- Waitlist removal (line 14)
- User profile update (line 21-23)
- Account creation (line 28-37)
- Avatar attachment (line 39-45)
- Journey creation (line 47)

Proposed Solution: Wrap all operations in ApplicationRecord.transaction do ... end block

Estimated Effort: Small (30 minutes)

---

Do you want to add this to the todo list?

1. yes - create todo file
2. next - skip this item
3. custom - modify before creating

```

## Important Implementation Details

### Status Transitions During Triage

**When "yes" is selected:**
1. Rename file: `{id}-pending-{priority}-{desc}.md` → `{id}-ready-{priority}-{desc}.md`
2. Update YAML frontmatter: `status: pending` → `status: ready`
3. Update Work Log with triage approval entry
4. Confirm: "✅ Approved: `{filename}` (Issue #{issue_id}) - Status: **ready**"

**When "next" is selected:**
1. Delete the todo file from todos/ directory
2. Skip to next item
3. No file remains in the system

### Progress Tracking

Every time you present a todo as a header, include:
- **Progress:** X/Y completed (e.g., "3/10 completed")
- **Estimated time remaining:** Based on how quickly you're progressing
- **Pacing:** Monitor time per finding and adjust estimate accordingly

Example:
```

Progress: 3/10 completed | Estimated time: ~2 minutes remaining

```

### Do Not Code During Triage

- ✅ Present findings
- ✅ Make yes/next/custom decisions
- ✅ Update todo files (rename, frontmatter, work log)
- ❌ Do NOT implement fixes or write code
- ❌ Do NOT add detailed implementation details
- ❌ That's for /resolve_todo_parallel phase
```

When done give these options

```markdown
What would you like to do next?

1. run /resolve_todo_parallel to resolve the todos
2. commit the todos
3. nothing, go chill
```

---
