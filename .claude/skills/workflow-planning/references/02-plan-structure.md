# Plan Structure & Methodology
> Consolidated from: ce-plan, sdd-plan, writing-plans, workflows-plan, deepen-plan
---

## Source: SKILL.md

---
name: ce:plan
description: Transform feature descriptions into well-structured project plans following conventions
argument-hint: "[feature description, bug report, or improvement idea]"
---

# Create a plan for a new feature or bug fix

## Introduction

**Note: The current year is 2026.** Use this when dating plans and searching for recent documentation.

Transform feature descriptions, bug reports, or improvement ideas into well-structured markdown files issues that follow project conventions and best practices. This command provides flexible detail levels to match your needs.

## Feature Description

<feature_description> #$ARGUMENTS </feature_description>

**If the feature description above is empty, ask the user:** "What would you like to plan? Please describe the feature, bug fix, or improvement you have in mind."

Do not proceed until you have a clear feature description from the user.

### 0. Idea Refinement

**Check for brainstorm output first:**

Before asking questions, look for recent brainstorm documents in `docs/brainstorms/` that match this feature:

```bash
ls -la docs/brainstorms/*.md 2>/dev/null | head -10
```

**Relevance criteria:** A brainstorm is relevant if:
- The topic (from filename or YAML frontmatter) semantically matches the feature description
- Created within the last 14 days
- If multiple candidates match, use the most recent one

**If a relevant brainstorm exists:**
1. Read the brainstorm document **thoroughly** — every section matters
2. Announce: "Found brainstorm from [date]: [topic]. Using as foundation for planning."
3. Extract and carry forward **ALL** of the following into the plan:
   - Key decisions and their rationale
   - Chosen approach and why alternatives were rejected
   - Constraints and requirements discovered during brainstorming
   - Open questions (flag these for resolution during planning)
   - Success criteria and scope boundaries
   - Any specific technical choices or patterns discussed
4. **Skip the idea refinement questions below** — the brainstorm already answered WHAT to build
5. Use brainstorm content as the **primary input** to research and planning phases
6. **Critical: The brainstorm is the origin document.** Throughout the plan, reference specific decisions with `(see brainstorm: docs/brainstorms/<filename>)` when carrying forward conclusions. Do not paraphrase decisions in a way that loses their original context — link back to the source.
7. **Do not omit brainstorm content** — if the brainstorm discussed it, the plan must address it (even if briefly). Scan each brainstorm section before finalizing the plan to verify nothing was dropped.

**If multiple brainstorms could match:**
Use **AskUserQuestion tool** to ask which brainstorm to use, or whether to proceed without one.

**If no brainstorm found (or not relevant), run idea refinement:**

Refine the idea through collaborative dialogue using the **AskUserQuestion tool**:

- Ask questions one at a time to understand the idea fully
- Prefer multiple choice questions when natural options exist
- Focus on understanding: purpose, constraints and success criteria
- Continue until the idea is clear OR user says "proceed"

**Gather signals for research decision.** During refinement, note:

- **User's familiarity**: Do they know the codebase patterns? Are they pointing to examples?
- **User's intent**: Speed vs thoroughness? Exploration vs execution?
- **Topic risk**: Security, payments, external APIs warrant more caution
- **Uncertainty level**: Is the approach clear or open-ended?

**Skip option:** If the feature description is already detailed, offer:
"Your description is clear. Should I proceed with research, or would you like to refine it further?"

## Main Tasks

### 1. Local Research (Always Runs - Parallel)

<thinking>
First, I need to understand the project's conventions, existing patterns, and any documented learnings. This is fast and local - it informs whether external research is needed.
</thinking>

Run these agents **in parallel** to gather local context:

- Task compound-engineering:research:repo-research-analyst(feature_description)
- Task compound-engineering:research:learnings-researcher(feature_description)

**What to look for:**
- **Repo research:** existing patterns, CLAUDE.md guidance, technology familiarity, pattern consistency
- **Learnings:** documented solutions in `docs/solutions/` that might apply (gotchas, patterns, lessons learned)

These findings inform the next step.

### 1.5. Research Decision

Based on signals from Step 0 and findings from Step 1, decide on external research.

**High-risk topics → always research.** Security, payments, external APIs, data privacy. The cost of missing something is too high. This takes precedence over speed signals.

**Strong local context → skip external research.** Codebase has good patterns, CLAUDE.md has guidance, user knows what they want. External research adds little value.

**Uncertainty or unfamiliar territory → research.** User is exploring, codebase has no examples, new technology. External perspective is valuable.

**Announce the decision and proceed.** Brief explanation, then continue. User can redirect if needed.

Examples:
- "Your codebase has solid patterns for this. Proceeding without external research."
- "This involves payment processing, so I'll research current best practices first."

### 1.5b. External Research (Conditional)

**Only run if Step 1.5 indicates external research is valuable.**

Run these agents in parallel:

- Task compound-engineering:research:best-practices-researcher(feature_description)
- Task compound-engineering:research:framework-docs-researcher(feature_description)

### 1.6. Consolidate Research

After all research steps complete, consolidate findings:

- Document relevant file paths from repo research (e.g., `app/services/example_service.rb:42`)
- **Include relevant institutional learnings** from `docs/solutions/` (key insights, gotchas to avoid)
- Note external documentation URLs and best practices (if external research was done)
- List related issues or PRs discovered
- Capture CLAUDE.md conventions

**Optional validation:** Briefly summarize findings and ask if anything looks off or missing before proceeding to planning.

### 2. Issue Planning & Structure

<thinking>
Think like a product manager - what would make this issue clear and actionable? Consider multiple perspectives
</thinking>

**Title & Categorization:**

- [ ] Draft clear, searchable issue title using conventional format (e.g., `feat: Add user authentication`, `fix: Cart total calculation`)
- [ ] Determine issue type: enhancement, bug, refactor
- [ ] Convert title to filename: add today's date prefix, determine daily sequence number, strip prefix colon, kebab-case, add `-plan` suffix
  - Scan `docs/plans/` for files matching today's date pattern `YYYY-MM-DD-\d{3}-`
  - Find the highest existing sequence number for today
  - Increment by 1, zero-padded to 3 digits (001, 002, etc.)
  - Example: `feat: Add User Authentication` → `2026-01-21-001-feat-add-user-authentication-plan.md`
  - Keep it descriptive (3-5 words after prefix) so plans are findable by context

**Stakeholder Analysis:**

- [ ] Identify who will be affected by this issue (end users, developers, operations)
- [ ] Consider implementation complexity and required expertise

**Content Planning:**

- [ ] Choose appropriate detail level based on issue complexity and audience
- [ ] List all necessary sections for the chosen template
- [ ] Gather supporting materials (error logs, screenshots, design mockups)
- [ ] Prepare code examples or reproduction steps if applicable, name the mock filenames in the lists

### 3. SpecFlow Analysis

After planning the issue structure, run SpecFlow Analyzer to validate and refine the feature specification:

- Task compound-engineering:workflow:spec-flow-analyzer(feature_description, research_findings)

**SpecFlow Analyzer Output:**

- [ ] Review SpecFlow analysis results
- [ ] Incorporate any identified gaps or edge cases into the issue
- [ ] Update acceptance criteria based on SpecFlow findings

### 4. Choose Implementation Detail Level

Select how comprehensive you want the issue to be, simpler is mostly better.

#### 📄 MINIMAL (Quick Issue)

**Best for:** Simple bugs, small improvements, clear features

**Includes:**

- Problem statement or feature description
- Basic acceptance criteria
- Essential context only

**Structure:**

````markdown
---
title: [Issue Title]
type: [feat|fix|refactor]
status: active
date: YYYY-MM-DD
origin: docs/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md  # if originated from brainstorm, otherwise omit
---

# [Issue Title]

[Brief problem/feature description]

## Acceptance Criteria

- [ ] Core requirement 1
- [ ] Core requirement 2

## Context

[Any critical information]

## MVP

### test.rb

```ruby
class Test
  def initialize
    @name = "test"
  end
end
```

## Sources

- **Origin brainstorm:** [docs/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md](path) — include if plan originated from a brainstorm
- Related issue: #[issue_number]
- Documentation: [relevant_docs_url]
````

#### 📋 MORE (Standard Issue)

**Best for:** Most features, complex bugs, team collaboration

**Includes everything from MINIMAL plus:**

- Detailed background and motivation
- Technical considerations
- Success metrics
- Dependencies and risks
- Basic implementation suggestions

**Structure:**

```markdown
---
title: [Issue Title]
type: [feat|fix|refactor]
status: active
date: YYYY-MM-DD
origin: docs/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md  # if originated from brainstorm, otherwise omit
---

# [Issue Title]

## Overview

[Comprehensive description]

## Problem Statement / Motivation

[Why this matters]

## Proposed Solution

[High-level approach]

## Technical Considerations

- Architecture impacts
- Performance implications
- Security considerations

## System-Wide Impact

- **Interaction graph**: [What callbacks/middleware/observers fire when this runs?]
- **Error propagation**: [How do errors flow across layers? Do retry strategies align?]
- **State lifecycle risks**: [Can partial failure leave orphaned/inconsistent state?]
- **API surface parity**: [What other interfaces expose similar functionality and need the same change?]
- **Integration test scenarios**: [Cross-layer scenarios that unit tests won't catch]

## Acceptance Criteria

- [ ] Detailed requirement 1
- [ ] Detailed requirement 2
- [ ] Testing requirements

## Success Metrics

[How we measure success]

## Dependencies & Risks

[What could block or complicate this]

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md](path) — include if plan originated from a brainstorm
- Similar implementations: [file_path:line_number]
- Best practices: [documentation_url]
- Related PRs: #[pr_number]
```

#### 📚 A LOT (Comprehensive Issue)

**Best for:** Major features, architectural changes, complex integrations

**Includes everything from MORE plus:**

- Detailed implementation plan with phases
- Alternative approaches considered
- Extensive technical specifications
- Resource requirements and timeline
- Future considerations and extensibility
- Risk mitigation strategies
- Documentation requirements

**Structure:**

```markdown
---
title: [Issue Title]
type: [feat|fix|refactor]
status: active
date: YYYY-MM-DD
origin: docs/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md  # if originated from brainstorm, otherwise omit
---

# [Issue Title]

## Overview

[Executive summary]

## Problem Statement

[Detailed problem analysis]

## Proposed Solution

[Comprehensive solution design]

## Technical Approach

### Architecture

[Detailed technical design]

### Implementation Phases

#### Phase 1: [Foundation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 2: [Core Implementation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 3: [Polish & Optimization]

- Tasks and deliverables
- Success criteria
- Estimated effort

## Alternative Approaches Considered

[Other solutions evaluated and why rejected]

## System-Wide Impact

### Interaction Graph

[Map the chain reaction: what callbacks, middleware, observers, and event handlers fire when this code runs? Trace at least two levels deep. Document: "Action X triggers Y, which calls Z, which persists W."]

### Error & Failure Propagation

[Trace errors from lowest layer up. List specific error classes and where they're handled. Identify retry conflicts, unhandled error types, and silent failure swallowing.]

### State Lifecycle Risks

[Walk through each step that persists state. Can partial failure orphan rows, duplicate records, or leave caches stale? Document cleanup mechanisms or their absence.]

### API Surface Parity

[List all interfaces (classes, DSLs, endpoints) that expose equivalent functionality. Note which need updating and which share the code path.]

### Integration Test Scenarios

[3-5 cross-layer test scenarios that unit tests with mocks would never catch. Include expected behavior for each.]

## Acceptance Criteria

### Functional Requirements

- [ ] Detailed functional criteria

### Non-Functional Requirements

- [ ] Performance targets
- [ ] Security requirements
- [ ] Accessibility standards

### Quality Gates

- [ ] Test coverage requirements
- [ ] Documentation completeness
- [ ] Code review approval

## Success Metrics

[Detailed KPIs and measurement methods]

## Dependencies & Prerequisites

[Detailed dependency analysis]

## Risk Analysis & Mitigation

[Comprehensive risk assessment]

## Resource Requirements

[Team, time, infrastructure needs]

## Future Considerations

[Extensibility and long-term vision]

## Documentation Plan

[What docs need updating]

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md](path) — include if plan originated from a brainstorm. Key decisions carried forward: [list 2-3 major decisions from brainstorm]

### Internal References

- Architecture decisions: [file_path:line_number]
- Similar features: [file_path:line_number]
- Configuration: [file_path:line_number]

### External References

- Framework documentation: [url]
- Best practices guide: [url]
- Industry standards: [url]

### Related Work

- Previous PRs: #[pr_numbers]
- Related issues: #[issue_numbers]
- Design documents: [links]
```

### 5. Issue Creation & Formatting

<thinking>
Apply best practices for clarity and actionability, making the issue easy to scan and understand
</thinking>

**Content Formatting:**

- [ ] Use clear, descriptive headings with proper hierarchy (##, ###)
- [ ] Include code examples in triple backticks with language syntax highlighting
- [ ] Add screenshots/mockups if UI-related (drag & drop or use image hosting)
- [ ] Use task lists (- [ ]) for trackable items that can be checked off
- [ ] Add collapsible sections for lengthy logs or optional details using `<details>` tags
- [ ] Apply appropriate emoji for visual scanning (🐛 bug, ✨ feature, 📚 docs, ♻️ refactor)

**Cross-Referencing:**

- [ ] Link to related issues/PRs using #number format
- [ ] Reference specific commits with SHA hashes when relevant
- [ ] Link to code using GitHub's permalink feature (press 'y' for permanent link)
- [ ] Mention relevant team members with @username if needed
- [ ] Add links to external resources with descriptive text

**Code & Examples:**

````markdown
# Good example with syntax highlighting and line references


```ruby
# app/services/user_service.rb:42
def process_user(user)

# Implementation here

end
```

# Collapsible error logs

<details>
<summary>Full error stacktrace</summary>

`Error details here...`

</details>
````

**AI-Era Considerations:**

- [ ] Account for accelerated development with AI pair programming
- [ ] Include prompts or instructions that worked well during research
- [ ] Note which AI tools were used for initial exploration (Claude, Copilot, etc.)
- [ ] Emphasize comprehensive testing given rapid implementation
- [ ] Document any AI-generated code that needs human review

### 6. Final Review & Submission

**Brainstorm cross-check (if plan originated from a brainstorm):**

Before finalizing, re-read the brainstorm document and verify:
- [ ] Every key decision from the brainstorm is reflected in the plan
- [ ] The chosen approach matches what was decided in the brainstorm
- [ ] Constraints and requirements from the brainstorm are captured in acceptance criteria
- [ ] Open questions from the brainstorm are either resolved or flagged
- [ ] The `origin:` frontmatter field points to the brainstorm file
- [ ] The Sources section includes the brainstorm with a summary of carried-forward decisions

**Pre-submission Checklist:**

- [ ] Title is searchable and descriptive
- [ ] Labels accurately categorize the issue
- [ ] All template sections are complete
- [ ] Links and references are working
- [ ] Acceptance criteria are measurable
- [ ] Add names of files in pseudo code examples and todo lists
- [ ] Add an ERD mermaid diagram if applicable for new model changes

## Write Plan File

**REQUIRED: Write the plan file to disk before presenting any options.**

```bash
mkdir -p docs/plans/
# Determine daily sequence number
today=$(date +%Y-%m-%d)
last_seq=$(ls docs/plans/${today}-*-plan.md 2>/dev/null | grep -oP "${today}-\K\d{3}" | sort -n | tail -1)
next_seq=$(printf "%03d" $(( ${last_seq:-0} + 1 )))
```

Use the Write tool to save the complete plan to `docs/plans/YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md` (where NNN is `$next_seq` from the bash command above). This step is mandatory and cannot be skipped — even when running as part of LFG/SLFG or other automated pipelines.

Confirm: "Plan written to docs/plans/[filename]"

**Pipeline mode:** If invoked from an automated workflow (LFG, SLFG, or any `disable-model-invocation` context), skip all AskUserQuestion calls. Make decisions automatically and proceed to writing the plan without interactive prompts.

## Output Format

**Filename:** Use the date, daily sequence number, and kebab-case filename from Step 2 Title & Categorization.

```
docs/plans/YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md
```

Examples:
- ✅ `docs/plans/2026-01-15-001-feat-user-authentication-flow-plan.md`
- ✅ `docs/plans/2026-02-03-001-fix-checkout-race-condition-plan.md`
- ✅ `docs/plans/2026-03-10-002-refactor-api-client-extraction-plan.md`
- ❌ `docs/plans/2026-01-15-feat-thing-plan.md` (missing sequence number, not descriptive)
- ❌ `docs/plans/2026-01-15-001-feat-new-feature-plan.md` (too vague - what feature?)
- ❌ `docs/plans/2026-01-15-001-feat: user auth-plan.md` (invalid characters - colon and space)
- ❌ `docs/plans/feat-user-auth-plan.md` (missing date prefix and sequence number)

## Post-Generation Options

After writing the plan file, use the **AskUserQuestion tool** to present these options:

**Question:** "Plan ready at `docs/plans/YYYY-MM-DD-NNN-<type>-<name>-plan.md`. What would you like to do next?"

**Options:**
1. **Open plan in editor** - Open the plan file for review
2. **Run `/deepen-plan`** - Enhance each section with parallel research agents (best practices, performance, UI)
3. **Review and refine** - Improve the document through structured self-review
4. **Share to Proof** - Upload to Proof for collaborative review and sharing
5. **Start `/ce:work`** - Begin implementing this plan locally
6. **Start `/ce:work` on remote** - Begin implementing in Claude Code on the web (use `&` to run in background)
7. **Create Issue** - Create issue in project tracker (GitHub/Linear)

Based on selection:
- **Open plan in editor** → Run `open docs/plans/<plan_filename>.md` to open the file in the user's default editor
- **`/deepen-plan`** → Call the /deepen-plan command with the plan file path to enhance with research
- **Review and refine** → Load `document-review` skill.
- **Share to Proof** → Upload the plan to Proof:
  ```bash
  CONTENT=$(cat docs/plans/<plan_filename>.md)
  TITLE="Plan: <plan title from frontmatter>"
  RESPONSE=$(curl -s -X POST https://www.proofeditor.ai/share/markdown \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg title "$TITLE" --arg markdown "$CONTENT" --arg by "ai:compound" '{title: $title, markdown: $markdown, by: $by}')")
  PROOF_URL=$(echo "$RESPONSE" | jq -r '.tokenUrl')
  ```
  Display: `View & collaborate in Proof: <PROOF_URL>` — skip silently if curl fails. Then return to options.
- **`/ce:work`** → Call the /ce:work command with the plan file path
- **`/ce:work` on remote** → Run `/ce:work docs/plans/<plan_filename>.md &` to start work in background for Claude Code web
- **Create Issue** → See "Issue Creation" section below
- **Other** (automatically provided) → Accept free text for rework or specific changes

**Note:** If running `/ce:plan` with ultrathink enabled, automatically run `/deepen-plan` after plan creation for maximum depth and grounding.

Loop back to options after Simplify or Other changes until user selects `/ce:work` or another action.

## Issue Creation

When user selects "Create Issue", detect their project tracker from CLAUDE.md:

1. **Check for tracker preference** in user's CLAUDE.md (global or project):
   - Look for `project_tracker: github` or `project_tracker: linear`
   - Or look for mentions of "GitHub Issues" or "Linear" in their workflow section

2. **If GitHub:**

   Use the title and type from Step 2 (already in context - no need to re-read the file):

   ```bash
   gh issue create --title "<type>: <title>" --body-file <plan_path>
   ```

3. **If Linear:**

   ```bash
   linear issue create --title "<title>" --description "$(cat <plan_path>)"
   ```

4. **If no tracker configured:**
   Ask user: "Which project tracker do you use? (GitHub/Linear/Other)"
   - Suggest adding `project_tracker: github` or `project_tracker: linear` to their CLAUDE.md

5. **After creation:**
   - Display the issue URL
   - Ask if they want to proceed to `/ce:work`

NEVER CODE! Just research and write the plan.

---

## Source: SKILL.md

---
name: sdd:plan
description: Refine, parallelize, and verify a draft task specification into a fully planned implementation-ready task
argument-hint: Path to draft task file (e.g., ".specs/tasks/draft/add-validation.feature.md") [options]
---

# Refine Task Workflow

## Role

You are a task refinement orchestrator. Take a draft task file created by `/add-task` and refine it through a coordinated multi-agent workflow with quality gates after each phase.

## Goal

This workflow command refines an existing draft task through:

1. **Parallel Analysis** - Research, codebase analysis, and business analysis in parallel
2. **Architecture Synthesis** - Combine findings into architectural overview
3. **Decomposition** - Break into implementation steps with risks
4. **Parallelize** - Reorganize steps for maximum parallel execution
5. **Verify** - Add LLM-as-Judge verification sections
6. **Promote** - Move refined task from `draft/` to `todo/`

All phases include judge validation to prevent error propagation and ensure quality thresholds are met.

## User Input

```text
$ARGUMENTS
```

---

## Command Arguments

Parse the following arguments from `$ARGUMENTS`:

### Argument Definitions

| Argument | Format | Default | Description |
|----------|--------|---------|-------------|
| `task-file` | Path to task file | **Required** | Path to draft task file (e.g., `.specs/tasks/draft/add-validation.feature.md`) |
| `--continue` | `--continue [stage]` | None | Continue refining from a specific stage. Stage is optional - resolve from context if not provided. |
| `--target-quality` | `--target-quality X.X` | `3.5` | Target threshold value (out of 5.0) for judge pass/fail decisions. |
| `--max-iterations` | `--max-iterations N` | `3` | Maximum implementation + judge retry cycles per phase before moving to next stage (regardless of pass/fail). |
| `--included-stages` | `--included-stages stage1,stage2,...` | All stages | Comma-separated list of stages to include. |
| `--skip` | `--skip stage1,stage2,...` | None | Comma-separated list of stages to exclude. |
| `--fast` | `--fast` | N/A | Alias for `--target-quality 3.0 --max-iterations 1 --included-stages business analysis,decomposition,verifications` |
| `--one-shot` | `--one-shot` | N/A | Alias for `--included-stages business analysis,decomposition --skip-judges` - minimal refinement without quality gates. |
| `--human-in-the-loop` | `--human-in-the-loop phase1,phase2,...` | None | Phases after which to pause for human verification. |
| `--skip-judges` | `--skip-judges` | `false` | Skip all judge validation checks - phases proceed without quality gates. |
| `--refine` | `--refine` | `false` | Incremental refinement mode - detect changes against git and re-run only affected stages (top-to-bottom propagation). |

### Stage Names (for `--included-stages` / `--skip`)

| Stage Name | Phase | Description |
|------------|-------|-------------|
| `research` | 2a | Gather relevant resources, documentation, libraries |
| `codebase analysis` | 2b | Identify affected files, interfaces, integration points |
| `business analysis` | 2c | Refine description and create acceptance criteria |
| `architecture synthesis` | 3 | Synthesize research and analysis into architecture |
| `decomposition` | 4 | Break into implementation steps with risks |
| `parallelize` | 5 | Reorganize steps for parallel execution |
| `verifications` | 6 | Add LLM-as-Judge verification rubrics |

### Configuration Resolution

Parse `$ARGUMENTS` and resolve configuration as follows:

```

# Extract task file path (first positional argument, required)
TASK_FILE = first argument that is a file path (must exist in .specs/tasks/draft/)

# Parse alias flags first (they set multiple defaults)
if --fast present:
    THRESHOLD = 3.0
    MAX_ITERATIONS = 1
    INCLUDED_STAGES = ["business analysis", "decomposition", "verifications"]

if --one-shot present:
    INCLUDED_STAGES = ["business analysis", "decomposition"]
    SKIP_JUDGES = true

# Initialize defaults
THRESHOLD ?= --target-quality || 3.5
MAX_ITERATIONS ?= --max-iterations || 3
INCLUDED_STAGES ?= --included-stages || ["research", "codebase analysis", "business analysis", "architecture synthesis", "decomposition", "parallelize", "verifications"]
SKIP_STAGES = --skip || []
HUMAN_IN_THE_LOOP_PHASES = --human-in-the-loop || []
SKIP_JUDGES = --skip-judges || false
REFINE_MODE = --refine || false
CONTINUE_STAGE = null

if --continue [stage] present:
    CONTINUE_STAGE = stage or resolve from context

# Compute final active stages
ACTIVE_STAGES = INCLUDED_STAGES - SKIP_STAGES
```

### Context Resolution for `--continue`

When `--continue` is used without explicit stage:

1. **Stage Resolution:**
   - Parse the task file for completion markers (e.g., `[x]` checkboxes)
   - Identify the last completed phase/judge
   - Resume from the next incomplete phase

### Refine Mode Behavior (`--refine`)

When `--refine` is used:

1. **Change Detection:**
   - First check file status: `git status --porcelain -- <TASK_FILE>`
   - Compare current task file against last git commit: `git diff HEAD -- <TASK_FILE>`
     - This captures both staged and unstaged changes vs HEAD
   - If file is untracked or has no git history, compare against the original task structure
   - Identify which sections have been modified by the user
   - Look for `//` comment markers indicating user feedback/corrections

2. **Top-to-Bottom Propagation:**
   - Determine the **earliest modified section** (highest in document)
   - Re-run only stages that correspond to or come **after** the modified section
   - Earlier stages (above the modification) are preserved as-is

3. **Section-to-Stage Mapping:**

   | Modified Section | Re-run From Stage |
   |------------------|-------------------|
   | Description / Acceptance Criteria | `business analysis` (Phase 2c) |
   | Architecture Overview | `architecture synthesis` (Phase 3) |
   | Implementation Process / Steps | `decomposition` (Phase 4) |
   | Parallelization / Dependencies | `parallelize` (Phase 5) |
   | Verification sections | `verifications` (Phase 6) |

4. **Refine Execution:**
   - Skip research (2a) and codebase analysis (2b) unless explicitly requested
   - Pass user modifications and `//` comments as additional context to agents
   - Agents should incorporate user feedback while preserving unchanged content

5. **Example:**

   ```bash
   # User edited the Architecture Overview section
   /plan .specs/tasks/todo/my-task.feature.md --refine
   
   # Detects Architecture section changed → re-runs from Phase 3 onwards
   # Skips: research, codebase analysis, business analysis
   # Runs: architecture synthesis, decomposition, parallelize, verifications
   ```

### Human-in-the-Loop Behavior

Human verification checkpoints occur:

1. **Trigger Conditions:**
   - After implementation + judge verification **PASS** for a phase in `HUMAN_IN_THE_LOOP_PHASES`
   - After implementation + judge + implementation retry (before the next judge retry)

2. **At Checkpoint:**
   - Display current phase results summary
   - Display generated artifacts with paths
   - Display judge score and feedback
   - Ask user: "Review phase output. Continue? [Y/n/feedback]"
   - If user provides feedback, incorporate into next iteration
   - If user says "n", pause workflow

3. **Checkpoint Message Format:**

   ```markdown
   ---
   ## 🔍 Human Review Checkpoint - Phase X

   **Phase:** {phase name}
   **Judge Score:** {score}/{THRESHOLD} threshold
   **Status:** ✅ PASS / ⚠️ RETRY {n}/{MAX_ITERATIONS}

   **Artifacts:**
   - {artifact_path_1}
   - {artifact_path_2}

   **Judge Feedback:**
   {feedback summary}

   **Action Required:** Review the above artifacts and provide feedback or continue.

   > Continue? [Y/n/feedback]:
   ---
   ```

---

## Usage Examples

```bash
# Refine a draft task with all stages
/plan .specs/tasks/draft/add-validation.feature.md

# Fast refinement with minimal stages
/plan .specs/tasks/draft/quick-fix.bug.md --fast

# Continue from a specific stage
/plan .specs/tasks/draft/complex-feature.feature.md --continue decomposition

# High-quality refinement with checkpoints
/plan .specs/tasks/draft/critical-api.feature.md --target-quality 4.5 --human-in-the-loop 2,3,4,5,6

# Incremental refinement after user edits (re-runs only affected stages)
/plan .specs/tasks/todo/my-task.feature.md --refine
```

## Pre-Flight Checks

Before starting workflow:

1. **Validate task file exists:**
   - If `REFINE_MODE` is false: Check that `TASK_FILE` exists in `.specs/tasks/draft/`
   - If `REFINE_MODE` is true: Check that `TASK_FILE` exists in `.specs/tasks/todo/` or `.specs/tasks/draft/`
   - If not found, show error and exit

2. **Parse and display resolved configuration:**

   ```markdown
   ### Configuration

   | Setting | Value |
   |---------|-------|
   | **Task File** | {TASK_FILE} |
   | **Target Quality** | {THRESHOLD}/5.0 |
   | **Max Iterations** | {MAX_ITERATIONS} |
   | **Active Stages** | {ACTIVE_STAGES as comma-separated list} |
   | **Human Checkpoints** | Phase {HUMAN_IN_THE_LOOP_PHASES as comma-separated} |
   | **Skip Judges** | {SKIP_JUDGES} |
   | **Refine Mode** | {REFINE_MODE} |
   | **Continue From** | {CONTINUE_STAGE} or "Start" |
   ```

3. **Handle `--continue` mode:**

   If `CONTINUE_STAGE` is set:
   - Read the task file to get current state
   - Identify completed phases from task file content
   - Skip to `CONTINUE_STAGE` (or auto-detected next incomplete stage)
   - Pre-populate captured values from existing artifacts
   - Resume workflow from the appropriate phase

4. **Handle `--refine` mode:**

   If `REFINE_MODE` is true:
   - Check file status: `git status --porcelain -- <TASK_FILE>`
     - `M` (staged) or `M` (unstaged) or `MM` (both) → proceed with diff
     - `??` (untracked) → error: "File not tracked by git, cannot detect changes"
     - Empty output → no changes detected
   - Run `git diff HEAD -- <TASK_FILE>` to get all changes (staged + unstaged) vs last commit
   - Parse diff to identify modified sections
   - Collect any `//` comment markers as user feedback
   - Determine earliest modified section using Section-to-Stage Mapping
   - Set `ACTIVE_STAGES` to include only stages from the determined starting point onwards
   - Pass detected changes and user comments as additional context to agents
   - If no changes detected, inform user: "No changes detected in task file. Edit the file first, then run --refine." and exit

5. **Extract task info from file:**
   - Read task file to extract title and type from filename
   - Parse frontmatter for title and depends_on

6. **Initialize workflow progress tracking** using TodoWrite:

   Only include todos for phases in `ACTIVE_STAGES`. If continuing, mark completed phases as `completed`.

   ```json
   {
     "todos": [
       {"content": "Ensure directories exist", "status": "pending", "activeForm": "Ensuring directories exist"},
       {"content": "Phase 2a: Research relevant resources and documentation", "status": "pending", "activeForm": "Researching resources"},
       {"content": "Judge 2a: PASS research quality (> {THRESHOLD})", "status": "pending", "activeForm": "Validating research"},
       {"content": "Phase 2b: Analyze codebase impact and affected files", "status": "pending", "activeForm": "Analyzing codebase impact"},
       {"content": "Judge 2b: PASS codebase analysis (> {THRESHOLD})", "status": "pending", "activeForm": "Validating codebase analysis"},
       {"content": "Phase 2c: Business analysis and acceptance criteria", "status": "pending", "activeForm": "Analyzing business requirements"},
       {"content": "Judge 2c: PASS business analysis (> {THRESHOLD})", "status": "pending", "activeForm": "Validating business analysis"},
       {"content": "Phase 3: Architecture synthesis from research and analysis", "status": "pending", "activeForm": "Synthesizing architecture"},
       {"content": "Judge 3: PASS architecture synthesis (> {THRESHOLD})", "status": "pending", "activeForm": "Validating architecture"},
       {"content": "Phase 4: Decompose into implementation steps", "status": "pending", "activeForm": "Decomposing into steps"},
       {"content": "Judge 4: PASS decomposition (> {THRESHOLD})", "status": "pending", "activeForm": "Validating decomposition"},
       {"content": "Phase 5: Parallelize implementation steps", "status": "pending", "activeForm": "Parallelizing steps"},
       {"content": "Judge 5: PASS parallelization (> {THRESHOLD})", "status": "pending", "activeForm": "Validating parallelization"},
       {"content": "Phase 6: Define verification rubrics", "status": "pending", "activeForm": "Defining verifications"},
       {"content": "Judge 6: PASS verifications (> {THRESHOLD})", "status": "pending", "activeForm": "Validating verifications"},
       {"content": "Move task to todo folder", "status": "pending", "activeForm": "Promoting task"},
       {"content": "Human checkpoint reviews", "status": "pending", "activeForm": "Awaiting human review"}
     ]
   }
   ```

   **Note:** Filter todos based on configuration:
   - If `SKIP_JUDGES` is true, omit ALL Judge todos (Judge 2a, 2b, 2c, 3, 4, 5, 6)
   - If `research` not in `ACTIVE_STAGES`, omit Phase 2a and Judge 2a todos
   - If `codebase analysis` not in `ACTIVE_STAGES`, omit Phase 2b and Judge 2b todos
   - If `business analysis` not in `ACTIVE_STAGES`, omit Phase 2c and Judge 2c todos
   - If `architecture synthesis` not in `ACTIVE_STAGES`, omit Phase 3 and Judge 3 todos
   - If `decomposition` not in `ACTIVE_STAGES`, omit Phase 4 and Judge 4 todos
   - If `parallelize` not in `ACTIVE_STAGES`, omit Phase 5 and Judge 5 todos
   - If `verifications` not in `ACTIVE_STAGES`, omit Phase 6 and Judge 6 todos
   - If `HUMAN_IN_THE_LOOP_PHASES` is empty, omit human checkpoint todo

7. **Ensure directories exist**:

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
   - `.specs/analysis/` - Codebase impact analysis files
   - `.claude/skills/` - Reusable skill documents

Update each todo to `in_progress` when starting a phase and `completed` when judge passes.

## CRITICAL

- Do not mark PASS for any judge if it did not pass the rubric. Retry the judge after each implementation change till it passes the check!
- Do not read task files in .claude or .specs directories, your job is orchestrate agents that will do the work, not do it by yourself!
- Use `THRESHOLD` (default 3.5) for all judge pass/fail decisions, not hardcoded values!
- Use `MAX_ITERATIONS` (default 3) for retry limits, not hardcoded values!
- **After `MAX_ITERATIONS` reached: PROCEED to next stage automatically - do NOT ask user unless phase is in `HUMAN_IN_THE_LOOP_PHASES`!**
- Skip phases not in `ACTIVE_STAGES` entirely - do not launch agents for excluded stages!
- Trigger human-in-the-loop checkpoints ONLY after phases in `HUMAN_IN_THE_LOOP_PHASES`!
- **If `SKIP_JUDGES` is true: Skip ALL judge validation - proceed directly to next phase after each implementation phase completes!**
- **Task file must exist in `.specs/tasks/draft/` before running this command (unless `--refine` mode)!**
- **If `REFINE_MODE` is true: Detect changes via git diff, skip unchanged stages, pass user feedback to agents!**

### Execution & Evaluation Rules

- **Use foreground agents only**: Do not use background agents. Launch parallel agents when possible. Background agents constantly run in permissions issues and other errors.

Relaunch judge till you get valid results, of following happens:

- Reject Long Reports: If an agent returns a very long report instead of using the scratchpad as requested, reject the result. This indicates the agent failed to follow the "use scratchpad" instruction.
- Judge Score 5.0 is a Hallucination: If a judge returns a score of 5.0/5.0, treat it as a hallucination or lazy evaluation. Reject it and re-run the judge. Perfect scores are practically impossible in this rigorous framework.
- Reject Missing Scores: If a judge report is missing the numerical score, reject it. This indicates the judge failed to read or follow the rubric instructions.

## Workflow Execution

You MUST launch for each step a separate agent, instead of performing all steps yourself.

**CRITICAL:** For each agent you MUST:

1. Use the **Agent** type and **Model** specified in the step
2. Provide the task file path and user input as context
3. **Provide the value of `${CLAUDE_PLUGIN_ROOT}` so agents can resolve paths like `@${CLAUDE_PLUGIN_ROOT}/scripts/create-scratchpad.sh`**
4. Require agent to implement exactly that step, not more, not less
5. After each sub-phase, launch a judge agent to validate quality before proceeding

### Complete Workflow Overview

**Note:** Phases not in `ACTIVE_STAGES` are skipped. If `SKIP_JUDGES` is true, all judge steps are skipped entirely. Human checkpoints (🔍) occur after phases in
`HUMAN_IN_THE_LOOP_PHASES`.

```
Input: Draft Task File (.specs/tasks/draft/*.md)
    │
    ▼
Phase 2: Parallel Analysis
    │
    ├─────────────────────┬─────────────────────┐
    ▼                     ▼                     ▼
Phase 2a:             Phase 2b:             Phase 2c:
Research              Codebase Analysis     Business Analysis
[sdd:researcher sonnet]   [sdd:code-explorer sonnet]  [sdd:business-analyst opus]
Judge 2a              Judge 2b              Judge 2c
(pass: >THRESHOLD)     (pass: >THRESHOLD)     (pass: >THRESHOLD)
    │                     │                     │
    └─────────────────────┴─────────────────────┘
                          │
                          ▼
                    Phase 3: Architecture Synthesis
                    [sdd:software-architect opus]
                    Judge 3 (pass: >THRESHOLD)
                          │
                          ▼
                    Phase 4: Decomposition
                    [sdd:tech-lead opus]
                    Judge 4 (pass: >THRESHOLD)
                          │
                          ▼
                    Phase 5: Parallelize
                    [sdd:team-lead opus]
                    Judge 5 (pass: >THRESHOLD)
                          │
                          ▼
                    Phase 6: Verifications
                    [sdd:qa-engineer opus]
                    Judge 6 (pass: >THRESHOLD)
                          │
                          ▼
                    Move task: draft/ → todo/
                          │
                          ▼
                    Complete
```

---

## Phase 2: Parallel Analysis

Phase 2 launches three analysis phases in parallel, each with its own judge validation.

### Phase 2a/2b/2c: Parallel Sub-Phases

Launch these three phases **in parallel** immediately:

---

#### Phase 2a: Research

**Model:** `sonnet`
**Agent:** `sdd:researcher`
**Depends on:** Task file exists
**Purpose:** Gather relevant resources, documentation, libraries, and prior art. Creates or updates a reusable skill.

Launch agent:

- **Description**: "Research task resources and create/update skill"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Task File: <TASK_FILE>
  Task Title: <title from task file>

  CRITICAL: DO NOT OUTPUT YOUR RESEARCH, ONLY CREATE THE SCRATCHPAD AND SKILL FILE.
  ```

**Capture:**

- Skill file path (e.g., `.claude/skills/<skill-name>/SKILL.md`)
- Skill action (Created new / Updated existing)
- Scratchpad file path (e.g., `.specs/scratchpad/<hex-id>.md`)
- Number of resources gathered
- Key recommendation summary

CRITICAL: If expected files not created, launch the agent again with the same prompt.

---

#### Phase 2b: Codebase Impact Analysis

**Model:** `sonnet`
**Agent:** `sdd:code-explorer`
**Depends on:** Task file exists
**Purpose:** Identify affected files, interfaces, and integration points

Launch agent:

- **Description**: "Analyze codebase impact"
- **Prompt**:

  ```text
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Task File: <TASK_FILE>
  Task Title: <title from task file>

  CRITICAL: DO NOT OUTPUT YOUR ANALYSIS, ONLY CREATE THE SCRATCHPAD AND ANALYSIS FILE.
  ```

**Capture:**

- Analysis file path (e.g., `.specs/analysis/analysis-{name}.md`)
- Scratchpad file path (e.g., `.specs/scratchpad/<hex-id>.md`)
- Files affected count (modify/create/delete)
- Risk level assessment
- Key integration points

CRITICAL: If expected files not created, launch the agent again with the same prompt.

---

#### Phase 2c: Business Analysis

**Model:** `opus`
**Agent:** `sdd:business-analyst`
**Depends on:** Task file exists
**Purpose:** Refine description and create acceptance criteria

Launch agent:

- **Description**: "Business analysis"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read ${CLAUDE_PLUGIN_ROOT}/skills/plan/analyse-business-requirements.md and execute it exactly as is!

  Task File: <TASK_FILE>
  Task Title: <title from task file>

  CRITICAL: DO NOT OUTPUT YOUR BUSINESS ANALYSIS, ONLY CREATE THE SCRATCHPAD AND UPDATE THE TASK FILE.
  ```

**Capture:**

- Scratchpad file path (e.g., `.specs/scratchpad/<hex-id>.md`)
- Acceptance criteria count
- Scope defined (yes/no)
- User scenarios documented

---

### Judge 2a/2b/2c: Validate Parallel Phases

After **each** parallel phase completes, launch its respective judge **with the same agent type and model**.

#### Judge 2a: Validate Research/Skill

**Model:** `sonnet`
**Agent:** `sdd:researcher`
**Depends on:** Phase 2a completion
**Purpose:** Validate skill completeness and relevance

Launch judge:

- **Description**: "Judge skill quality"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read @${CLAUDE_PLUGIN_ROOT}/prompts/judge.md for evaluation methodology and execute.

  ### Artifact Path
  {path to skill file from Phase 2a}

  ### Context
  This is a skill document for task: {task title}. Evaluate comprehensiveness and reusability.

  ### Rubric
  1. Resource Coverage (weight: 0.30)
     - Documentation and references gathered?
     - Libraries and tools identified with recommendations?
     - 1=Missing critical resources, 2=Basic coverage, 3=Adequate, 4=Comprehensive, 5=Excellent

  2. Pattern Relevance (weight: 0.25)
     - Are identified patterns applicable?
     - Are recommendations actionable?
     - 1=Irrelevant, 2=Somewhat useful, 3=Adequate, 4=Well-targeted, 5=Perfect fit

  3. Issue Anticipation (weight: 0.20)
     - Common pitfalls identified with solutions?
     - 1=None identified, 2=Few issues, 3=Adequate, 4=Good coverage, 5=Comprehensive

  4. Reusability (weight: 0.15)
     - Is the skill general enough to help multiple tasks?
     - Does it avoid task-specific details?
     - 1=Too specific, 2=Limited reuse, 3=Adequate, 4=Good, 5=Highly reusable

  5. Task Integration (weight: 0.10)
     - Was task file updated with skill reference?
     - 1=Not updated, 3=Updated, 5=Updated with clear instructions
  ```

CRITICAL: use prompt exactly as is, do not add anything else. Including output of implementation agent!!!

**Decision Logic:**

- **PASS** (score >= `THRESHOLD`): Research complete, proceed
- **FAIL** (score < `THRESHOLD`): Re-launch Phase 2a with feedback
- **MAX_ITERATIONS reached**: Proceed to next stage regardless of score (log warning)

---

#### Judge 2b: Validate Codebase Analysis

**Model:** `sonnet`
**Agent:** `sdd:code-explorer`
**Depends on:** Phase 2b completion
**Purpose:** Validate file identification accuracy and integration mapping

Launch judge:

- **Description**: "Judge codebase analysis quality"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read @${CLAUDE_PLUGIN_ROOT}/prompts/judge.md for evaluation methodology and execute.

  ### Artifact Path
  {path to analysis file from Phase 2b}

  ### Context
  This is codebase impact analysis for task: {task title}. Evaluate accuracy and completeness.

  ### Rubric
  1. File Identification Accuracy (weight: 0.35)
     - All affected files identified with specific paths?
     - New files and modifications distinguished?
     - 1=Major files missing, 2=Mostly correct, 3=Adequate, 4=Precise, 5=Complete

  2. Interface Documentation (weight: 0.25)
     - Key functions/classes documented with signatures?
     - Change requirements clear?
     - 1=Missing, 2=Partial, 3=Adequate, 4=Good, 5=Complete

  3. Integration Point Mapping (weight: 0.25)
     - Integration points identified with impact?
     - Similar patterns in codebase found?
     - 1=Missing, 2=Partial, 3=Adequate, 4=Good, 5=Comprehensive

  4. Risk Assessment (weight: 0.15)
     - High risk areas identified with mitigations?
     - 1=No assessment, 2=Basic, 3=Adequate, 4=Good, 5=Thorough
  ```

CRITICAL: use prompt exactly as is, do not add anything else. Including output of implementation agent!!!

**Decision Logic:**

- **PASS** (score >= `THRESHOLD`): Analysis complete, proceed
- **FAIL** (score < `THRESHOLD`): Re-launch Phase 2b with feedback
- **MAX_ITERATIONS reached**: Proceed to next stage regardless of score (log warning)

---

#### Judge 2c: Validate Business Analysis

**Model:** `opus`
**Agent:** `sdd:business-analyst`
**Depends on:** Phase 2c completion
**Purpose:** Validate acceptance criteria quality and scope definition

Launch judge:

- **Description**: "Judge business analysis quality"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read @${CLAUDE_PLUGIN_ROOT}/prompts/judge.md for evaluation methodology and execute.

  ### Artifact Path
  {path to task file from Phase 2c}

  ### Context
  This is business analysis output. Evaluate description clarity and acceptance criteria quality.

  ### Rubric
  1. Description Clarity (weight: 0.30)
     - What/Why clearly explained?
     - Scope boundaries defined?
     - 1=Vague, 2=Basic, 3=Adequate, 4=Clear, 5=Excellent

  2. Acceptance Criteria Quality (weight: 0.35)
     - Criteria specific and testable?
     - Given/When/Then format for complex criteria?
     - 1=Missing/vague, 2=Basic, 3=Adequate, 4=Good, 5=Excellent

  3. Scenario Coverage (weight: 0.20)
     - Primary flow documented?
     - Error scenarios considered?
     - 1=Missing, 2=Basic, 3=Adequate, 4=Good, 5=Comprehensive

  4. Scope Definition (weight: 0.15)
     - In-scope/out-of-scope explicit?
     - No implementation details in description?
     - 1=Missing, 2=Partial, 3=Adequate, 4=Good, 5=Clear
  ```

CRITICAL: use prompt exactly as is, do not add anything else. Including output of implementation agent!!!

**Decision Logic:**

- **PASS** (score >= `THRESHOLD`): Business analysis complete, proceed
- **FAIL** (score < `THRESHOLD`): Re-launch Phase 2c with feedback
- **MAX_ITERATIONS reached**: Proceed to next stage regardless of score (log warning)

---

### Synchronization Point

**Wait for ALL three parallel phases (2a, 2b, 2c) AND their judges to PASS before proceeding to Phase 3.**

---

## Phase 3: Architecture Synthesis

**Model:** `opus`
**Agent:** `sdd:software-architect`
**Depends on:** Phase 2a + Judge 2a PASS, Phase 2b + Judge 2b PASS, Phase 2c + Judge 2c PASS
**Purpose:** Synthesize research, analysis, and business requirements into architectural overview

Launch agent:

- **Description**: "Architecture synthesis"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Task File: <TASK_FILE>
  Skill File: <skill file path from Phase 2a>
  Analysis File: <analysis file path from Phase 2b>

  CRITICAL: DO NOT OUTPUT YOUR ARCHITECTURE SYNTHESIS, ONLY CREATE THE SCRATCHPAD AND UPDATE THE TASK FILE.
  ```

**Capture:**

- Scratchpad file path (e.g., `.specs/scratchpad/<hex-id>.md`)
- Sections added to task file
- Key architectural decisions count
- Components identified (if applicable)
- Contracts defined (if applicable)

---

### Judge 3: Validate Architecture Synthesis

**Model:** `opus`
**Agent:** `sdd:software-architect`
**Depends on:** Phase 3 completion
**Purpose:** Validate architectural coherence and completeness

Launch judge:

- **Description**: "Judge architecture synthesis quality"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read @${CLAUDE_PLUGIN_ROOT}/prompts/judge.md for evaluation methodology and execute.

  ### Artifact Path
  {path to task file after Phase 3}

  ### Context
  This is architecture synthesis output. The Architecture Overview section should contain
  solution strategy, key decisions, and only relevant architectural sections.

  ### Rubric
  1. Solution Strategy Clarity (weight: 0.30)
     - Approach clearly explained?
     - Key decisions documented with reasoning?
     - Trade-offs stated?
     - 1=Missing/unclear, 2=Basic, 3=Adequate, 4=Clear, 5=Excellent

  2. Reference Integration (weight: 0.20)
     - Links to research and analysis files?
     - Insights from both integrated?
     - 1=No links, 2=Partial, 3=Adequate, 4=Good, 5=Fully integrated

  3. Section Relevance (weight: 0.25)
     - Only relevant sections included (not all)?
     - Sections appropriate for task complexity?
     - 1=Wrong sections, 2=Mostly appropriate, 3=Adequate, 4=Good, 5=Precisely targeted

  4. Expected Changes Accuracy (weight: 0.25)
     - Files to create/modify listed?
     - Consistent with codebase analysis?
     - 1=Missing/inconsistent, 2=Partial, 3=Adequate, 4=Good, 5=Complete

  ```

CRITICAL: use prompt exactly as is, do not add anything else. Including output of implementation agent!!!

**Decision Logic:**

- **PASS** (score >= `THRESHOLD`): Architecture synthesis complete, proceed
- **FAIL** (score < `THRESHOLD`): Re-launch Phase 3 with feedback
- **MAX_ITERATIONS reached**: Proceed to Phase 4 regardless of score (log warning)

**Wait for PASS before Phase 4.**

---

## Phase 4: Decomposition

**Model:** `opus`
**Agent:** `sdd:tech-lead`
**Depends on:** Phase 3 + Judge 3 PASS
**Purpose:** Break architecture into implementation steps with success criteria and risks

Launch agent:

- **Description**: "Decompose into implementation steps"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Task File: <TASK_FILE>

  CRITICAL: DO NOT OUTPUT YOUR DECOMPOSITION, ONLY CREATE THE SCRATCHPAD AND UPDATE THE TASK FILE.
  ```

**Capture:**

- Scratchpad file path (e.g., `.specs/scratchpad/<hex-id>.md`)
- Implementation steps count
- Total subtasks count
- Critical path steps
- High priority risks count

---

### Judge 4: Validate Decomposition

**Model:** `opus`
**Agent:** `sdd:tech-lead`
**Depends on:** Phase 4 completion
**Purpose:** Validate implementation steps quality and completeness

Launch judge:

- **Description**: "Judge decomposition quality"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read @${CLAUDE_PLUGIN_ROOT}/prompts/judge.md for evaluation methodology and execute.

  ### Artifact Path
  {path to task file after Phase 4}

  ### Context
  This is decomposition output. The Implementation Process section should contain
  ordered steps with success criteria, subtasks, blockers, and risks.

  ### Rubric
  1. Step Quality (weight: 0.30)
     - Each step has clear goal, output, success criteria?
     - Steps ordered by dependency?
     - No step too large (>Large estimate)?
     - 1=Vague/missing, 2=Basic, 3=Adequate, 4=Good, 5=Excellent

  2. Success Criteria Testability (weight: 0.25)
     - Criteria specific and verifiable?
     - Use actual file paths, function names?
     - Subtasks clearly defined with actionable descriptions?
     - 1=Vague, 2=Partially testable, 3=Adequate, 4=Good, 5=All testable

  3. Risk Coverage (weight: 0.25)
     - Blockers identified with resolutions?
     - Risks identified with mitigations?
     - High-risk tasks identified with decomposition recommendations?
     - 1=None, 2=Basic, 3=Adequate, 4=Good, 5=Comprehensive

  4. Completeness (weight: 0.20)
     - All architecture components have corresponding steps?
     - Implementation summary table present?
     - Definition of Done included?
     - Phases organized: Setup → Foundational → User Stories → Polish?
     - 1=Incomplete, 2=Partial, 3=Adequate, 4=Good, 5=Complete
  ```

CRITICAL: use prompt exactly as is, do not add anything else. Including output of implementation agent!!!

**Decision Logic:**

- **PASS** (score >= `THRESHOLD`): Decomposition complete, proceed to Phase 5
- **FAIL** (score < `THRESHOLD`): Re-launch Phase 4 with feedback
- **MAX_ITERATIONS reached**: Proceed to Phase 5 regardless of score (log warning)

**Wait for PASS before Phase 5.**

---

## Phase 5: Parallelize Steps

**Model:** `opus`
**Agent:** `sdd:team-lead`
**Depends on:** Phase 4 + Judge 4 PASS
**Purpose:** Reorganize implementation steps for maximum parallel execution

Launch agent:

- **Description**: "Parallelize implementation steps"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Task File: <TASK_FILE>

  Use agents only from this list: {list ALL available agents with plugin prefix if available, e.g. sdd:developer, code-review:bug-hunter. Also include general agents: opus, sonnet, haiku}

  CRITICAL: DO NOT OUTPUT YOUR PARALLELIZATION, ONLY CREATE THE SCRATCHPAD AND UPDATE THE TASK FILE.
  ```

**Capture:**

- Scratchpad file path (e.g., `.specs/scratchpad/<hex-id>.md`)
- Number of steps reorganized
- Maximum parallelization depth
- Agent distribution summary

---

### Judge 5: Validate Parallelization

**Model:** `opus`
**Agent:** `sdd:team-lead`
**Depends on:** Phase 5 completion
**Purpose:** Validate dependency accuracy and parallelization optimization

Launch judge:

- **Description**: "Judge parallelization quality"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read @${CLAUDE_PLUGIN_ROOT}/prompts/judge.md for evaluation methodology and execute.

  ### Artifact Path
  {path to parallelized task file from Phase 5}

  ### Context
  This is the output of Phase 5: Parallelize Steps. The artifact should contain implementation steps
  reorganized for maximum parallel execution with explicit dependencies, agent assignments, and
  parallelization diagram.

  Use agents only from this list: {list ALL available agents with plugin prefix if available, e.g. sdd:developer, code-review:bug-hunter. Also include general agents: opus, sonnet, haiku}

  ### Rubric
  1. Dependency Accuracy (weight: 0.35)
     - Are step dependencies correctly identified?
     - No false dependencies (steps marked dependent when they're not)?
     - No missing dependencies (steps that actually depend on others)?
     - 1=Major dependency errors, 2=Mostly correct, 3=Acceptable, 5=Precise dependencies

  2. Parallelization Maximized (weight: 0.30)
     - Are parallelizable steps correctly marked with "Parallel with:"?
     - Is the parallelization diagram logical?
     - 1=No parallelization/wrong, 2=Some optimization, 3=Acceptable, 5=Maximum parallelization

  3. Agent Selection Correctness (weight: 0.20)
     - Are agent types appropriate for outputs (opus by default, haiku for trivial, sonnet for simple but high in volume)?
     - Does selection follow the Agent Selection Guide?
     - Are only agents from the provided available agents list used?
     - 1=Wrong agents, 2=Mostly appropriate, 3=Acceptable, 4=Optimal selection, 5=Perfect selection

  4. Execution Directive Present (weight: 0.15)
     - Is the sub-agent execution directive present?
     - Are "MUST" requirements for parallel execution clear?
     - 1=Missing directive, 2=Partial, 3=Acceptable, 4=Complete directive, 5=Perfect directive
  ```

CRITICAL: use prompt exactly as is, do not add anything else. Including output of implementation agent!!!

**Decision Logic:**

- **PASS** (score >= `THRESHOLD`): Proceed to Phase 6
- **FAIL** (score < `THRESHOLD`): Re-launch Phase 5 with feedback
- **MAX_ITERATIONS reached**: Proceed to Phase 6 regardless of score (log warning)

**Wait for PASS before Phase 6.**

---

## Phase 6: Define Verifications

**Model:** `opus`
**Agent:** `sdd:qa-engineer`
**Depends on:** Phase 5 + Judge 5 PASS
**Purpose:** Add LLM-as-Judge verification sections with rubrics

Launch agent:

- **Description**: "Define verification rubrics"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Task File: <TASK_FILE>

  CRITICAL: DO NOT OUTPUT YOUR VERIFICATIONS, ONLY CREATE THE SCRATCHPAD AND UPDATE THE TASK FILE.
  ```

**Capture:**

- Scratchpad file path (e.g., `.specs/scratchpad/<hex-id>.md`)
- Number of steps with verification
- Total evaluations defined
- Verification breakdown (Panel/Per-Item/None)

---

### Judge 6: Validate Verifications

**Model:** `opus`
**Agent:** `sdd:qa-engineer`
**Depends on:** Phase 6 completion
**Purpose:** Validate verification rubrics and thresholds

Launch judge:

- **Description**: "Judge verification quality"
- **Prompt**:

  ```
  CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT}

  Read @${CLAUDE_PLUGIN_ROOT}/prompts/judge.md for evaluation methodology and execute.

  ### Artifact Path
  {path to task file with verifications from Phase 6}

  ### Context
  This is the output of Phase 6: Define Verifications. The artifact should contain LLM-as-Judge
  verification sections for each implementation step, including verification levels, custom rubrics,
  thresholds, and a verification summary table.

  ### Rubric
  1. Verification Level Appropriateness (weight: 0.30)
     - Do verification levels match artifact criticality?
     - HIGH criticality → Panel, MEDIUM → Single/Per-Item, LOW/NONE → None?
     - 1=Mismatched levels, 2=Mostly appropriate, 3=Acceptable, 5=Precisely calibrated

  2. Rubric Quality (weight: 0.30)
     - Are criteria specific to the artifact type (not generic)?
     - Do weights sum to 1.0?
     - Are descriptions clear and measurable?
     - 1=Generic/broken rubrics, 2=Adequate, 3=Acceptable, 5=Excellent custom rubrics

  3. Threshold Appropriateness (weight: 0.20)
     - Are thresholds reasonable (typically 4.0/5.0)?
     - Higher for critical, lower for experimental?
     - 1=Wrong thresholds, 2=Standard applied, 3=Acceptable, 5=Context-appropriate

  4. Coverage Completeness (weight: 0.20)
     - Does every step have a Verification section?
     - Is the Verification Summary table present?
     - 1=Missing verifications, 2=Most covered, 3=Acceptable, 5=100% coverage
  ```

CRITICAL: use prompt exactly as is, do not add anything else. Including output of implementation agent!!!

**Decision Logic:**

- **PASS** (score >= `THRESHOLD`): Workflow complete, promote task
- **FAIL** (score < `THRESHOLD`): Re-launch Phase 6 with feedback
- **MAX_ITERATIONS reached**: Complete workflow regardless of score (log warning)

---

## Phase 7: Promote Task

**Purpose:** Move the refined task from draft to todo folder

After all phases complete:

1. **Move task file from draft to todo:**

   ```bash
   git mv <TASK_FILE> .specs/tasks/todo/
   # Fallback if git not available: mv <TASK_FILE> .specs/tasks/todo/
   ```

2. **Update any references** in research and analysis files if needed

---

## Completion

After all executed phases and judges complete:

1. Use git tool to stage the task file, skill file, analysis file, and scratchpad files (only those that were created)
2. Summarize the workflow results and output to user:

```markdown
### Task Refined

| Property | Value |
|----------|-------|
| **Original File** | `<original TASK_FILE path>` |
| **Final Location** | `.specs/tasks/todo/<filename>` (ready for implementation) |
| **Title** | `<task title>` |
| **Type** | `<feature/bug/refactor/test/docs/chore/ci>` (from filename) |
| **Skill** | `<skill file path or "Skipped">` |
| **Skill Action** | `<Created new / Updated existing / Skipped>` |
| **Analysis** | `<analysis file path or "Skipped">` |
| **Scratchpad** | `<scratchpad file path>` |
| **Implementation Steps** | `<count or "N/A">` |
| **Parallelization Depth** | `<max parallel agents or "N/A">` |
| **Total Verifications** | `<count or "N/A">` |

### Configuration Used

| Setting | Value |
|---------|-------|
| **Target Quality** | {THRESHOLD}/5.0 |
| **Max Iterations** | {MAX_ITERATIONS} |
| **Active Stages** | {ACTIVE_STAGES as comma-separated list} |
| **Skipped Stages** | {SKIP_STAGES or stages not in ACTIVE_STAGES} |
| **Human Checkpoints** | Phase {HUMAN_IN_THE_LOOP_PHASES as comma-separated} |
| **Skip Judges** | {SKIP_JUDGES} |
| **Refine Mode** | {REFINE_MODE} |

### Quality Gates Summary

| Phase | Judge Score | Verdict |
|-------|-------------|---------|
| Phase 2a: Research | X.X/5.0 | ✅ PASS / ⚠️ PROCEEDED (max iter) / ⏭️ SKIPPED |
| Phase 2b: Codebase Analysis | X.X/5.0 | ✅ PASS / ⚠️ PROCEEDED (max iter) / ⏭️ SKIPPED |
| Phase 2c: Business Analysis | X.X/5.0 | ✅ PASS / ⚠️ PROCEEDED (max iter) / ⏭️ SKIPPED |
| Phase 3: Architecture Synthesis | X.X/5.0 | ✅ PASS / ⚠️ PROCEEDED (max iter) / ⏭️ SKIPPED |
| Phase 4: Decomposition | X.X/5.0 | ✅ PASS / ⚠️ PROCEEDED (max iter) / ⏭️ SKIPPED |
| Phase 5: Parallelize | X.X/5.0 | ✅ PASS / ⚠️ PROCEEDED (max iter) / ⏭️ SKIPPED |
| Phase 6: Verify | X.X/5.0 | ✅ PASS / ⚠️ PROCEEDED (max iter) / ⏭️ SKIPPED |

**Threshold Used:** {THRESHOLD}/5.0 (or N/A if SKIP_JUDGES)

**Legend:**
- ✅ PASS - Score >= THRESHOLD
- ⚠️ PROCEEDED (max iter) - Score < THRESHOLD but MAX_ITERATIONS reached, proceeded anyway
- ⏭️ SKIPPED - Stage not in ACTIVE_STAGES

### Artifacts Generated

```

.claude/
└── skills/
    └── <skill-name>/
        └── SKILL.md             # Reusable skill document (if research stage ran)

.specs/
├── tasks/
│   ├── draft/                   # Draft tasks (source - now empty for this task)
│   ├── todo/
│   │   └── <name>.<type>.md     # Complete task specification (ready for implementation)
│   ├── in-progress/             # Tasks being implemented (empty)
│   └── done/                    # Completed tasks (empty)
├── analysis/
│   └── analysis-<name>.md       # Codebase impact analysis (if codebase analysis stage ran)
└── scratchpad/
    └── <hex-id>.md              # Architecture thinking scratchpad

```

### Task Status Management

Task status is managed by folder location:
- `draft/` - Tasks created but not yet refined
- `todo/` - Tasks ready for implementation
- `in-progress/` - Tasks currently being worked on
- `done/` - Completed tasks

### Next Steps

1. Review task: `.specs/tasks/todo/<filename>`
   - Edit the task file directly to make corrections
   - Add `//` comments to lines that need clarification or changes
   - Run `/plan` again with `--refine` to incorporate your feedback — it detects changes against git and propagates updates **top-to-bottom** (editing a section only affects sections below it, not above)
2. If everything is fine, begin implementation: `/implement` (will auto-select the task from todo/)
```

---

## Error Handling

### Phase Agent Failure (Exception/Crash)

If any phase agent fails unexpectedly:

1. Report the failure with agent output
2. Ask clarification questions from user that can help resolve the issue
3. Launch the phase agent again with list of questions and answers to resolve the issue

### Judge Returns FAIL

If any judge returns FAIL (score < `THRESHOLD`):

1. **Automatic retry**: Re-launch the phase agent with judge feedback
2. **Human-in-the-loop check**: If phase is in `HUMAN_IN_THE_LOOP_PHASES`, trigger human checkpoint **before** the next judge retry (after implementation retry but before re-judging)
3. **After `MAX_ITERATIONS` reached**: **Proceed to next stage automatically** (do NOT ask user unless `--human-in-the-loop` includes this phase)
4. Log warning in completion summary: `⚠️ Phase X did not pass quality threshold (X.X/THRESHOLD) after MAX_ITERATIONS iterations`

### Retry Flow

```
Implementation → Judge FAIL → Implementation Retry → Judge Retry
                                                          ↓
                              PASS → Continue to next stage
                              FAIL → Repeat until MAX_ITERATIONS
                                          ↓
                              MAX_ITERATIONS reached → Proceed to next stage (with warning)
```

### Retry Flow with Human-in-the-Loop

When phase is in `HUMAN_IN_THE_LOOP_PHASES`:

```
Implementation → Judge FAIL → Implementation Retry
                                    ↓
                    🔍 Human Checkpoint (optional feedback)
                                    ↓
                              Judge Retry
                                    ↓
                    PASS → Continue | FAIL → Repeat until MAX_ITERATIONS
                                                    ↓
                              MAX_ITERATIONS → 🔍 Final Human Checkpoint
                                                    ↓
                                    User confirms → Proceed to next stage
```

---

## Source: analyse-business-requirements.md

# Analyse Business Requirements

## Goal

Your goal is to refine the task description and create comprehensive acceptance criteria that enable developers to understand exactly what needs to be built and how success will be measured. Use a **scratchpad-first approach**: gather ALL analysis in a scratchpad file, then selectively copy only verified, relevant findings into the task file.

**CRITICAL**: Vague requirements cause implementation failures. Untestable criteria waste developer time. Incomplete scope leads to endless rework. YOU are responsible for specification quality. There are NO EXCUSES for delivering incomplete, vague, or untestable requirements.

## Input

- **Task File**: Path to the task file (e.g., `.specs/tasks/task-{name}.md`)

## Business Analysis Process

### STAGE 1: Setup Scratchpad

**MANDATORY**: Before ANY analysis, create a scratchpad file for your business analysis thinking.

1. Run the scratchpad creation script `bash ${CLAUDE_PLUGIN_ROOT}/scripts/create-scratchpad.sh` - it will create the file: `.specs/scratchpad/<hex-id>.md`
2. Use this file for ALL your discoveries, analysis, and draft sections
3. The scratchpad is your workspace - dump EVERYTHING there first

```markdown
# Business Analysis Scratchpad: [Task Title]

Task: [task file path]
Created: [date]

---

## Phase 1: Requirements Discovery

[Stage 2 content...]

## Phase 2: Concept Extraction

[Stage 3 findings...]

## Phase 3: Requirements Analysis

[Stage 4 analysis...]

## Phase 4: Draft Output

[Stage 5 synthesis...]

## Self-Critique

[Stage 7 verification...]
```

---

### STAGE 2: Requirements Discovery

YOU MUST elicit the true business need behind the request. Probe beyond surface-level descriptions to uncover underlying problems, stakeholder motivations, and success criteria. NEVER accept the first description at face value.

#### Template for Your Analysis

Use this template to write in scratchpad file:

```markdown
## Phase 1: Requirements Discovery

### Task Overview
- Initial User Prompt: [quote from task file]
- Current Description: [existing description if any]
- Task Type: [task/bug/feature]
- Complexity: [S/M/L/XL]

### Problem Definition (Step-by-Step Analysis)

Let's think step by step about what the user actually needs...

Step 1: What is the surface-level user request?
[Your analysis]

Step 2: What is the user actually trying to accomplish?
[Your analysis]

Step 3: What is the business value?
[Your analysis]

Step 4: Who benefits from this change and how?
[Your analysis]

Step 5: What features of this solution may be added imidiatly or in future?
[Your analysis]

Step 6: What constraints or considerations exist?
[Your analysis]

Therefore, the root problem is: [Your conclusion]

### Scope
- What is included in this task?
- What is explicitly NOT included?
- What are the boundaries?

### Ambiguous Areas
- [List unclear aspects that need resolution]
```

If input is empty: Stop and report ERROR: "No task description provided"

#### Examples of Problem Definition Step-by-Step Analysis

Example 1: E-commerce Feature Request:

**User Request**: "Add a wishlist feature to the product pages"

Let's think step by step about what the user actually needs...

Step 1: What is the surface-level request?
The user wants a wishlist feature on product pages. This seems straightforward - a button to save products for later.

Step 2: Why would users need a wishlist?
Users browse products but aren't ready to buy immediately. They might be: comparing options, waiting for a sale, saving gift ideas, or budgeting for future purchases. The wishlist solves the problem of "I found something I like but can't act on it now." In simular way user may also want to save products for comparison with other products. Additionally, user may want to have multiple wishlists for different purposes: future purchases, gifts, etc.

Step 3: What is the business value?
It not directly allow to increase conversion rate, but it allows to increase customer engagement and retention. Also it allows to know in what products user is interested in and what products are not. As a result it can be used for targeted marketing and sales.

Step 4: What features of this solution may be added imidiatly or in future?

- Add a button to save products for later
  - Which can show select with different lists: future purchases, gifts, etc.
- Add a button to save products for comparison
- Page to see all wishlists and products in them
  - Functionality to create new list
  - Functionality to delete item
  - Functionality to rename list
  - Functionality to share list
  - Functionality to delete list
- Page to see product comparision
- Functionality to subscribe for product or whole list if it will be on sale

Step 5: What constraints or considerations exist?

- Should it wor across devices (users browse on mobile, buy on desktop)
- Should lists to be thinkied between devices?
- Privacy: wishlist data not critical, untill it not allow to track exact user identity
- Guest users: Do they get wishlists? Requires account?

Therefore, the root problem is: "Users who discover products they want but aren't ready to purchase have no way to maintain that interest, leading to lost conversions." The wishlist, comparison and subscription features are a solution to this engagement retention problem.

**Example 2: Bug Report Analysis**:

**User Request**: "Fix the login timeout - users are complaining"

Let's think step by step about what the user actually needs...

Step 1: What is the reported problem?
Users are experiencing timeouts during login. This is a symptom, not necessarily the root cause.

Step 2: What could cause login timeouts?
Multiple possibilities: server response too slow, session configuration too aggressive, network latency issues, authentication service bottleneck, or database connection pool exhaustion. The "fix" depends entirely on the root cause.

Step 3: What is the actual user pain?
Users are frustrated because they can't access the system. But why? Are they losing work? Missing deadlines? The impact determines priority and acceptable solutions.

Step 4: What does "fix" mean in this context?
Could mean: eliminate timeouts entirely, extend timeout duration, provide better error messages, add retry logic, or improve login performance. Each is a different scope.

Step 5: What information is missing?

- How long is the current timeout? What's acceptable?
- How many users affected? All or specific conditions?
- When did this start? Recent change?
- What error do users see?

Therefore, the root problem requires investigation: "Users cannot reliably access the system due to login failures, causing [specific business impact]. The underlying cause and appropriate fix are not yet determined." This is a bug requiring diagnosis, not a simple feature implementation.

---

### STAGE 3: Concept Extraction (in scratchpad)

#### Template for Your Analysis

Use this template to write in scratchpad file:

```markdown
## Phase 2: Concept Extraction

### Key Concepts Identified

Let's think step by step about the core elements of this feature...

Step 1: Who are the actors?
[Your analysis]

Step 2: What actions/behaviors are involved?
[Your analysis]

Step 3: What data entities exist?
[Your analysis]

Step 4: What constraints apply?
[Your analysis]

Step 5: What's implicitly assumed?
[Your analysis]

Therefore, the key concepts are: [Summary]

### Concept Summary
- **Actors**: [Who interacts with this feature?]
- **Actions/Behaviors**: [What does the system do?]
- **Data Entities**: [What data is involved?]
- **Constraints**: [What limitations exist?]

### Implicit Assumptions
- [What is assumed but not stated?]

### Scope Analysis
- **In Scope**: [What's included]
- **Out of Scope**: [What's explicitly excluded]
- **Boundary Cases**: [Edge cases to consider]
```

#### Example of Concept Extraction Step-by-Step Analysis

**Example: Payment Processing Feature**:

**Requirement**: "Allow users to pay with multiple payment methods"

Let's think step by step about the core elements...

Step 1: Who are the actors?

- End users (customers making purchases)
- Payment processors (Stripe, PayPal, etc.)
- Finance team (reconciliation, refunds)
- System administrators (configuration)

Step 2: What actions/behaviors are involved?

- Select payment method at checkout
- Enter payment details
- Process payment authorization
- Handle payment success/failure
- Store payment method for future use (optional)
- Process refunds

Step 3: What data entities exist?

- PaymentMethod (type, last4, expiry, default flag)
- Transaction (amount, status, timestamp, reference)
- User (linked payment methods)
- Order (linked transaction)

Step 4: What constraints apply?

- PCI compliance for card data handling
- Regional restrictions (some methods not available everywhere)
- Currency limitations per payment method
- Transaction limits

Step 5: What's implicitly assumed?

- Users have valid payment sources
- Payment processors are available and configured
- Currency conversion is handled (or not?)
- Tax calculation happens before payment

Therefore, the key concepts are: multi-actor payment flow with strict compliance constraints, requiring integration with external processors and careful handling of sensitive financial data.

---

### STAGE 4: Requirements Analysis (in scratchpad)

YOU MUST define functional and non-functional requirements with absolute precision. Vague requirements are WORTHLESS. Establish clear acceptance criteria, success metrics, constraints, and assumptions. Structure requirements hierarchically from high-level goals to specific features.

#### Template for Your Analysis

Use this template to write in scratchpad file:

**4.1: User Scenarios**

```markdown
## Phase 3: Requirements Analysis

### Functional Requirements Analysis

Let's think step by step about the each requirement systematically...

[Follow the 5-step pattern demonstrated below]

### Functional Requirements
- [Requirement 1 - specific and testable]
- [Requirement 2 - specific and testable]
...

### Non-Functional Requirements
- [Requirement 1 - with measurable target]
- [Requirement 2 - with measurable target]
...

### Constraints & Assumptions
- [Constraint 1]
- [Constraint 2]
...

### Measurable Outcomes
- How will we know this is complete?
- What can be tested?
- What are the success metrics?

### User Scenarios

#### Primary Flow (Happy Path)
1. [Step 1]
2. [Step 2]
...

#### Alternative Flows
- [Scenario A]: [Steps]
- [Scenario B]: [Steps]

#### Error Scenarios
- [Error case 1]: [Expected behavior]
- [Error case 2]: [Expected behavior]
```

**Examples of Requirements Analysis Step-by-Step Analysis**:

**Example: File Upload Feature**:

**Requirement**: "Users should be able to upload documents"

Let's think step by step about making this testable...

Step 1: What does "upload documents" actually mean?
Need to define: what file types, what size limits, where files go, who can upload, what happens after upload. "Documents" is vague - PDFs? Word docs? Images? All of these?

Step 2: What is the happy path?
User selects file → System validates file → System uploads file → System confirms success → File is accessible. Each step needs specific criteria.

Step 3: What are the failure modes?

- File too large: What's the limit? What error message?
- Wrong file type: Which types allowed? How communicated?
- Upload interrupted: Resume? Retry? Data loss?
- Storage full: How handled?
- Duplicate file: Overwrite? Rename? Reject?

Step 4: How do we make each criterion testable?
BAD: "Upload should be fast" - How fast? Under what conditions?
GOOD: "Upload of a 10MB file completes within 30 seconds on standard broadband connection"

BAD: "Support common document types" - Which ones?
GOOD: "System accepts PDF, DOCX, XLSX, and PNG files"

Step 5: What non-functional requirements apply?

- Performance: Upload time relative to file size
- Security: Virus scanning, file type validation (not just extension)
- Reliability: No partial uploads left in storage
- Usability: Progress indicator, clear error messages

Therefore, the acceptance criteria must specify: allowed file types (PDF, DOCX, XLSX, PNG), size limit (50MB), upload time target (< 30s for 10MB), error messages for each failure mode, and storage/retrieval confirmation.

**Example: Search Functionality**:

**Requirement**: "Add search to find orders quickly"

Let's think step by step about making this testable...

Step 1: What does "quickly" mean in measurable terms?
"Quickly" is subjective. Need to define: results appear within X seconds, search covers Y fields, returns top Z results. Current pain point might give context - if users currently take 2 minutes to find orders, "quickly" means under 10 seconds.

Step 2: What should be searchable?
Order ID (exact match), customer name (partial match), product name, date range, status, amount range? Each searchable field has different matching logic.

Step 3: What results should appear?
List of matching orders with: order ID, date, customer, total, status. Sorted by relevance? Date? How is relevance defined?

Step 4: What are the edge cases?

- No results found: What message? Suggestions?
- Too many results: Pagination? Filter refinement prompt?
- Special characters in search: Escaped? Literal?
- Empty search: Show all? Error?

Step 5: How do we verify "quickly"?

- Database with 100,000 orders
- Search returns results in < 2 seconds
- First 20 results displayed, pagination for more

Therefore, testable criteria include: "Search by order ID returns exact match within 500ms", "Search by customer name returns partial matches within 2 seconds", "No results displays 'No orders found' with suggestion to adjust filters", "Results paginated at 20 items per page".

**4.2: Acceptance Criteria Draft**

For each criterion, write this in scratchpad file:

```
Criterion: [Description]

Let's think step by step about what makes criterion testable...

Step 1: Is this specific enough to test?
[Can a QA engineer write a test without asking questions?]

Step 2: What are the Given/When/Then components?
- Given: [Precondition that must be true]
- When: [Action that triggers the behavior]
- Then: [Observable, verifiable outcome]

Step 3: Is the outcome measurable?
[Does it have a specific value, state, or observable result?]

Therefore, this criterion is [TESTABLE/NEEDS REFINEMENT because...]
```

Then write summary in the scratchpad file:

```markdown
### Acceptance Criteria Draft

| # | Criterion | Given | When | Then | Testable? |
|---|-----------|-------|------|------|-----------|
| 1 | [Description] | [Condition] | [Action] | [Outcome] | [Yes/No + reason] |
| 2 | [Description] | [Condition] | [Action] | [Outcome] | [Yes/No + reason] |

### Non-Functional Requirements
- **Performance**: [Specific metric if applicable]
- **Security**: [Specific requirement if applicable]
- **Compatibility**: [Specific requirement if applicable]
```

**Example of Testability Check Step-by-Step Analysis**:

**Draft Criterion**: "Users can reset their password"

Let's think step by step about testability...

Step 1: Is this specific enough?
No. How do they reset it? Email link? Security questions? What if email is wrong? What's the flow?

Step 2: Refined Given/When/Then:

- Given: User has a registered account with verified email
- When: User clicks "Forgot Password" and enters their email
- Then: System sends password reset link valid for 24 hours

Step 3: Is the outcome measurable?
Partially. "Sends email" is verifiable, "valid for 24 hours" is testable. But what about the reset itself?

Additional criterion needed:

- Given: User has valid password reset link
- When: User clicks link and enters new password meeting requirements
- Then: Password is updated and user can log in with new password

Therefore, original criterion needs to be split into 2-3 specific, testable criteria covering: request reset, receive link, complete reset, and edge cases (expired link, invalid email).

**4.3: Ambiguity Resolution**

```markdown
### Ambiguity Resolution

For unclear aspects, apply industry standards and reasonable defaults

| Ambiguous Element | Reasoning | Default Applied |
|-------------------|-----------|-----------------|
| [Element 1] | [Why this is reasonable] | [Default] |
| [Element 2] | [Why this is reasonable] | [Default] |

### Needs Clarification (MAX 3)
- [Only if: significantly impacts scope, multiple interpretations, NO reasonable default]
```

**Rules for clarifications:**

- Only mark with `[NEEDS CLARIFICATION: specific question]` if the choice significantly impacts scope, has multiple reasonable interpretations, AND no reasonable default exists
- **LIMIT: Maximum 3 [NEEDS CLARIFICATION] markers total**
- Prioritize: scope > security/privacy > user experience > technical details

---

### STAGE 5: Synthesis

#### Guidance

**BEFORE proceeding to draft, verify you have completed ALL discovery steps. Incomplete analysis = rejected specification.**

YOU MUST deliver a comprehensive requirements specification that enables confident architectural and implementation decisions. EVERY specification MUST include:

- **Business Context**: Problem statement, business goals, success metrics, and ROI justification if applicable. Missing business context = specification has no foundation.
- **Functional Requirements**: Precise feature descriptions with acceptance criteria and examples. NEVER submit vague feature descriptions.
- **Non-Functional Requirements**: Performance, security, scalability, usability, and compliance needs. Ignoring NFRs = system failures in production.
- **Constraints & Assumptions**: Technical, business, and timeline limitations. Undocumented assumptions = guaranteed misunderstandings.
- **Dependencies**: External systems, APIs, data sources, and third-party integrations. Missing dependencies = blocked implementation.
- **Out of Scope**: Explicit boundaries to prevent scope creep. NO EXCEPTIONS - every specification needs clear boundaries.
- **Open Questions**: Unresolved items requiring stakeholder input.

Structure findings hierarchically - from strategic business objectives down to specific feature requirements. NEVER use vague language. Support all claims with evidence from research or stakeholder input.

**The specification MUST answer three questions or it FAILS:**

1. "WHY" (business value) - If missing, specification is pointless
2. "WHAT" (requirements) - If vague, implementation will be wrong
3. "WHO" (stakeholders) - If incomplete, someone's needs will be ignored

#### Template for Your Draft

Use this template to write in scratchpad file:

```markdown
## Phase 4: Draft Output

### Synthesis Reasoning


Let's think step by step about which findings are most relevant for the specification...

Step 1: What is the core business value I identified?
[Your reasoning]

Step 2: What are the must-have vs nice-to-have requirements?
[Your reasoning]

Step 3: What acceptance criteria passed testability review?
[Your reasoning]

Step 4: What scope boundaries must be explicit?
[Your reasoning]

Step 5: What's the clearest way to communicate this?
[Your reasoning]

Therefore, my refined description will: [Summary]

### Refined Description
[2-3 paragraphs covering:
- What is being built/changed/fixed
- Why this is needed (business value)
- Who will use/benefit from this
- Key constraints or considerations]

### Scope Summary
- **Included**: [Bullet list]
- **Excluded**: [Bullet list]

### User Scenarios Summary
1. **Primary Flow**: [One sentence]
2. **Alternative Flow**: [One sentence, if applicable]
3. **Error Handling**: [One sentence]

### Acceptance Criteria (Final)
[Only criteria that passed testability check]
```

#### Example: Synthesizing Step-by-Step Analysis

**Task**: Notification preferences feature

Let's think step by step about which findings are most relevant for the specification...

Step 1: What is the core business value I identified?
Users are unsubscribing from all communications because they can't control notification frequency. Business is losing engagement. The value is: retain user engagement by giving granular control.

Step 2: What are the must-have vs nice-to-have requirements?
Must-have: Toggle notifications on/off per category, Email frequency control (immediate/daily/weekly)
Nice-to-have: Quiet hours, channel preferences (email vs push vs SMS)
Out of scope for now: AI-powered smart notifications

Step 3: What acceptance criteria passed testability review?

- "User can disable marketing emails with single toggle" ✓
- "Changes to preferences take effect within 5 minutes" ✓
- "User sees confirmation message after saving" ✓
- "Preferences work correctly" ✗ (too vague - removed)

Step 4: What scope boundaries must be explicit?
In: Email notification preferences
Out: Push notifications (separate project), SMS (not currently supported), notification content changes

Step 5: What's the clearest way to communicate this?
Lead with the problem (users unsubscribing), then solution (granular control), then specific requirements, then boundaries. Developer should understand WHY before WHAT.

Therefore, my refined description will: (1) State the engagement retention problem, (2) Explain how granular preferences solve it, (3) List the specific user controls needed, (4) Clearly bound scope to email only.

---

### STAGE 6: Update Task File

**CRITICAL**: Read the current task file, then use Write tool to update with enhanced content, based on your analysis in scratchpad.

You MUST preserve frontmatter and initial user prompt in the task file. Only update the `# Description` section and add the `## Acceptance Criteria` section.

#### Template for Updated Sections

```markdown
# Description

[Refined description that answers:]
- What is being built/changed/fixed
- Why this is needed (business value)
- Who will use/benefit from this
- Key constraints or considerations

**Scope**:
- Included: [What's in scope]
- Excluded: [What's explicitly out of scope]

**User Scenarios**:
1. **Primary Flow**: [Main use case]
2. **Alternative Flow**: [Secondary use case, if applicable]
3. **Error Handling**: [What happens when things go wrong]

## Acceptance Criteria

Clear, testable criteria using Given/When/Then or checkbox format:

### Functional Requirements

- [ ] **[Criterion 1]**: [Specific, testable requirement]
  - Given: [Initial condition]
  - When: [Action taken]
  - Then: [Expected outcome]

- [ ] **[Criterion 2]**: [Specific, testable requirement]
  - Given: [Initial condition]
  - When: [Action taken]
  - Then: [Expected outcome]

### Non-Functional Requirements (if applicable)

- [ ] **Performance**: [Specific metric, e.g., "Response time < 200ms"]
- [ ] **Security**: [Specific requirement, e.g., "Input sanitized against XSS"]
- [ ] **Compatibility**: [Specific requirement, e.g., "Works in Node 18+"]

### Definition of Done

- [ ] All acceptance criteria pass
- [ ] Tests written and passing
- [ ] Documentation updated
- [ ] Code reviewed
```

---

### STAGE 7: Self-Critique Loop (in scratchpad)

**YOU MUST complete this self-critique AFTER drafting output.** NO EXCEPTIONS.

#### Step 7.1: Verification Cycle

Use this template to write in scratchpad file:

```markdown
## Self-Critique

Let's think step by step about whether this specification meets quality standards...

Step 1: Requirements Completeness
[Your reasoning]

Step 2: Scope Clarity
[Your reasoning]

[continue for all verification questions...]

Conclusion: [Your conclusion]

### Verification Results


| # | Verification Question | Reasoning | Evidence | Rating |
|---|----------------------|-----------|----------|--------|
| 1 | **Requirements Completeness**: Have I captured all functional requirements, including edge cases and error scenarios, with testable acceptance criteria? | [Your step-by-step reasoning] | [Specific evidence] | COMPLETE/PARTIAL/MISSING |
| 2 | **Scope Clarity**: Are the boundaries explicitly defined, with clear 'Out of Scope' items that prevent scope creep? | [Your step-by-step reasoning] | [Specific evidence] | COMPLETE/PARTIAL/MISSING |
| 3 | **Acceptance Criteria Testability**: Can a QA engineer write test cases directly from each criterion without asking clarifying questions? | [Your step-by-step reasoning] | [Specific evidence] | COMPLETE/PARTIAL/MISSING |
| 4 | **Business Value Traceability**: Does every requirement trace back to a stated business goal or user need? | [Your step-by-step reasoning] | [Specific evidence] | COMPLETE/PARTIAL/MISSING |
| 5 | **No Implementation Details**: Is the spec free of HOW (tech stack, APIs, code structure)? | [Your step-by-step reasoning] | [Specific evidence] | COMPLETE/PARTIAL/MISSING |
```

#### Example: Self-Critique Reasoning

Let's think step by step about whether this specification meets quality standards...

Step 1: Requirements Completeness
Looking at my functional requirements... I have 5 criteria covering the happy path. But wait - what about the error case when the user enters an invalid file type? I mentioned it in analysis but didn't create a criterion. This is a gap.

Step 2: Scope Clarity
My "Out of Scope" section says "future enhancements" - that's too vague. A developer might think feature X is in scope when I intended it out. I need to list specific features that are excluded.

Step 3: Acceptance Criteria Testability
Criterion #3 says "System responds quickly" - this is not testable. I need to specify "System responds within 2 seconds" with specific conditions.

Step 4: Business Value Traceability
Criterion #4 is about audit logging. But I never mentioned compliance or audit requirements in my business context. Either remove this criterion or add the business justification.

Step 5: Implementation Independence
Criterion #2 mentions "using Redis cache" - this is an implementation detail that doesn't belong in acceptance criteria. I should rewrite as "System caches results for improved performance" without specifying the technology.

Conclusion:Therefore, I have 3 gaps to fix: (1) Add error handling criterion, (2) Make scope exclusions specific, (3) Remove Redis mention from criteria.

#### Step 7.2: Gap Analysis

Use this template to write in scratchpad file:

```markdown
### Gaps Found

| Gap | Analysis | Action Needed | Priority |
|-----|----------|---------------|----------|
| [Weakness] | [What root cause of the gap is] | [Specific fix] | Critical/High/Med/Low |
```

#### Step 7.3: Revision Cycle

YOU MUST address all Critical/High priority gaps BEFORE proceeding.
After addressing the gap, write this in scratchpad file:

```markdown
### Revisions Made

For each gap:
- Gap: [X]
- Action: [What I did]
- Result: [Evidence of resolution]
```

**Common Failure Modes** (check against these):

| Failure Mode | How to Detect | Required Fix |
|--------------|---------------|--------------|
| Vague acceptance criteria | Contains words like "quickly", "properly", "correctly" without metrics | Add specific conditions and measurable outcomes |
| Missing error scenarios | Only happy path documented | Add at least 2 error cases with expected behavior |
| Implementation details present | Mentions specific tech, APIs, frameworks | Remove all tech stack, API, code references |
| Untestable criteria | Can't write a test case from the criterion | Rewrite with Given/When/Then format |
| Scope boundaries unclear | "Out of Scope" is empty or says "TBD" | Add explicit In Scope/Out of Scope lists |

---

#### File Structure After Update

The task file should have this structure after your update:

```markdown
---
title: [KEEP EXISTING]
status: [KEEP EXISTING]
issue_type: [KEEP EXISTING]
complexity: [KEEP EXISTING]
---

# Initial User Prompt

[PRESERVE ORIGINAL - NEVER DELETE]

# Description

[YOUR REFINED DESCRIPTION]

---

## Acceptance Criteria

[YOUR ACCEPTANCE CRITERIA]
```

---

## Expected Output

CRITICAL: ONLY after completing analysis in scratchpad, updating the task file and self-critique loop, respond with this template:

```
Business Analysis Complete: [task file path]

Scratchpad: .specs/scratchpad/<hex-id>.md
Acceptance Criteria Added: X criteria
Scope Defined: [Yes/No]
User Scenarios: [Count] documented
Complexity Validation: [Confirmed/Suggest adjustment to X]
Self-Critique: 5 verification questions checked
Gaps Addressed: [Count]
```

---

## Source: SKILL.md

---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** This should be run in a dedicated worktree (created by brainstorming skill).

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

**Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

**Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

**Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- Reference relevant skills with @ syntax
- DRY, YAGNI, TDD, frequent commits

## Execution Handoff

After saving the plan, offer execution choice:

**"Plan complete and saved to `docs/plans/<filename>.md`. Two execution options:**

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?"**

**If Subagent-Driven chosen:**
- **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development
- Stay in this session
- Fresh subagent per task + code review

**If Parallel Session chosen:**
- Guide them to open new session in worktree
- **REQUIRED SUB-SKILL:** New session uses superpowers:executing-plans

---

## Source: plan-document-reviewer-prompt.md

# Plan Document Reviewer Prompt Template

Use this template when dispatching a plan document reviewer subagent.

**Purpose:** Verify the plan chunk is complete, matches the spec, and has proper task decomposition.

**Dispatch after:** Each plan chunk is written

```
Task tool (general-purpose):
  description: "Review plan chunk N"
  prompt: |
    You are a plan document reviewer. Verify this plan chunk is complete and ready for implementation.

    **Plan chunk to review:** [PLAN_FILE_PATH] - Chunk N only
    **Spec for reference:** [SPEC_FILE_PATH]

    ## What to Check

    | Category | What to Look For |
    |----------|------------------|
    | Completeness | TODOs, placeholders, incomplete tasks, missing steps |
    | Spec Alignment | Chunk covers relevant spec requirements, no scope creep |
    | Task Decomposition | Tasks atomic, clear boundaries, steps actionable |
    | File Structure | Files have clear single responsibilities, split by responsibility not layer |
    | File Size | Would any new or modified file likely grow large enough to be hard to reason about as a whole? |
    | Task Syntax | Checkbox syntax (`- [ ]`) on steps for tracking |
    | Chunk Size | Each chunk under 1000 lines |

    ## CRITICAL

    Look especially hard for:
    - Any TODO markers or placeholder text
    - Steps that say "similar to X" without actual content
    - Incomplete task definitions
    - Missing verification steps or expected outputs
    - Files planned to hold multiple responsibilities or likely to grow unwieldy

    ## Output Format

    ## Plan Review - Chunk N

    **Status:** Approved | Issues Found

    **Issues (if any):**
    - [Task X, Step Y]: [specific issue] - [why it matters]

    **Recommendations (advisory):**
    - [suggestions that don't block approval]
```

**Reviewer returns:** Status, Issues (if any), Recommendations

---

## Source: SKILL.md

---
name: workflows:plan
description: "[DEPRECATED] Use /ce:plan instead — renamed for clarity."
argument-hint: "[feature description, bug report, or improvement idea]"
disable-model-invocation: true
---

NOTE: /workflows:plan is deprecated. Please use /ce:plan instead. This alias will be removed in a future version.

/ce:plan $ARGUMENTS

---

## Source: SKILL.md

---
name: deepen-plan
description: Enhance a plan with parallel research agents for each section to add depth, best practices, and implementation details
argument-hint: "[path to plan file]"
---

# Deepen Plan - Power Enhancement Mode

## Introduction

**Note: The current year is 2026.** Use this when searching for recent documentation and best practices.

This command takes an existing plan (from `/ce:plan`) and enhances each section with parallel research agents. Each major element gets its own dedicated research sub-agent to find:
- Best practices and industry patterns
- Performance optimizations
- UI/UX improvements (if applicable)
- Quality enhancements and edge cases
- Real-world implementation examples

The result is a deeply grounded, production-ready plan with concrete implementation details.

## Plan File

<plan_path> #$ARGUMENTS </plan_path>

**If the plan path above is empty:**
1. Check for recent plans: `ls -la docs/plans/`
2. Ask the user: "Which plan would you like to deepen? Please provide the path (e.g., `docs/plans/2026-01-15-feat-my-feature-plan.md`)."

Do not proceed until you have a valid plan file path.

## Main Tasks

### 1. Parse and Analyze Plan Structure

<thinking>
First, read and parse the plan to identify each major section that can be enhanced with research.
</thinking>

**Read the plan file and extract:**
- [ ] Overview/Problem Statement
- [ ] Proposed Solution sections
- [ ] Technical Approach/Architecture
- [ ] Implementation phases/steps
- [ ] Code examples and file references
- [ ] Acceptance criteria
- [ ] Any UI/UX components mentioned
- [ ] Technologies/frameworks mentioned (Rails, React, Python, TypeScript, etc.)
- [ ] Domain areas (data models, APIs, UI, security, performance, etc.)

**Create a section manifest:**
```
Section 1: [Title] - [Brief description of what to research]
Section 2: [Title] - [Brief description of what to research]
...
```

### 2. Discover and Apply Available Skills

<thinking>
Dynamically discover all available skills and match them to plan sections. Don't assume what skills exist - discover them at runtime.
</thinking>

**Step 1: Discover ALL available skills from ALL sources**

```bash
# 1. Project-local skills (highest priority - project-specific)
ls .claude/skills/

# 2. User's global skills (~/.claude/)
ls ~/.claude/skills/

# 3. compound-engineering plugin skills
ls ~/.claude/plugins/cache/*/compound-engineering/*/skills/

# 4. ALL other installed plugins - check every plugin for skills
find ~/.claude/plugins/cache -type d -name "skills" 2>/dev/null

# 5. Also check installed_plugins.json for all plugin locations
cat ~/.claude/plugins/installed_plugins.json
```

**Important:** Check EVERY source. Don't assume compound-engineering is the only plugin. Use skills from ANY installed plugin that's relevant.

**Step 2: For each discovered skill, read its SKILL.md to understand what it does**

```bash
# For each skill directory found, read its documentation
cat [skill-path]/SKILL.md
```

**Step 3: Match skills to plan content**

For each skill discovered:
- Read its SKILL.md description
- Check if any plan sections match the skill's domain
- If there's a match, spawn a sub-agent to apply that skill's knowledge

**Step 4: Spawn a sub-agent for EVERY matched skill**

**CRITICAL: For EACH skill that matches, spawn a separate sub-agent and instruct it to USE that skill.**

For each matched skill:
```
Task general-purpose: "You have the [skill-name] skill available at [skill-path].

YOUR JOB: Use this skill on the plan.

1. Read the skill: cat [skill-path]/SKILL.md
2. Follow the skill's instructions exactly
3. Apply the skill to this content:

[relevant plan section or full plan]

4. Return the skill's full output

The skill tells you what to do - follow it. Execute the skill completely."
```

**Spawn ALL skill sub-agents in PARALLEL:**
- 1 sub-agent per matched skill
- Each sub-agent reads and uses its assigned skill
- All run simultaneously
- 10, 20, 30 skill sub-agents is fine

**Each sub-agent:**
1. Reads its skill's SKILL.md
2. Follows the skill's workflow/instructions
3. Applies the skill to the plan
4. Returns whatever the skill produces (code, recommendations, patterns, reviews, etc.)

**Example spawns:**
```
Task general-purpose: "Use the dhh-rails-style skill at ~/.claude/plugins/.../dhh-rails-style. Read SKILL.md and apply it to: [Rails sections of plan]"

Task general-purpose: "Use the frontend-design skill at ~/.claude/plugins/.../frontend-design. Read SKILL.md and apply it to: [UI sections of plan]"

Task general-purpose: "Use the agent-native-architecture skill at ~/.claude/plugins/.../agent-native-architecture. Read SKILL.md and apply it to: [agent/tool sections of plan]"

Task general-purpose: "Use the security-patterns skill at ~/.claude/skills/security-patterns. Read SKILL.md and apply it to: [full plan]"
```

**No limit on skill sub-agents. Spawn one for every skill that could possibly be relevant.**

### 3. Discover and Apply Learnings/Solutions

<thinking>
Check for documented learnings from /ce:compound. These are solved problems stored as markdown files. Spawn a sub-agent for each learning to check if it's relevant.
</thinking>

**LEARNINGS LOCATION - Check these exact folders:**

```
docs/solutions/           <-- PRIMARY: Project-level learnings (created by /ce:compound)
├── performance-issues/
│   └── *.md
├── debugging-patterns/
│   └── *.md
├── configuration-fixes/
│   └── *.md
├── integration-issues/
│   └── *.md
├── deployment-issues/
│   └── *.md
└── [other-categories]/
    └── *.md
```

**Step 1: Find ALL learning markdown files**

Run these commands to get every learning file:

```bash
# PRIMARY LOCATION - Project learnings
find docs/solutions -name "*.md" -type f 2>/dev/null

# If docs/solutions doesn't exist, check alternate locations:
find .claude/docs -name "*.md" -type f 2>/dev/null
find ~/.claude/docs -name "*.md" -type f 2>/dev/null
```

**Step 2: Read frontmatter of each learning to filter**

Each learning file has YAML frontmatter with metadata. Read the first ~20 lines of each file to get:

```yaml
---
title: "N+1 Query Fix for Briefs"
category: performance-issues
tags: [activerecord, n-plus-one, includes, eager-loading]
module: Briefs
symptom: "Slow page load, multiple queries in logs"
root_cause: "Missing includes on association"
---
```

**For each .md file, quickly scan its frontmatter:**

```bash
# Read first 20 lines of each learning (frontmatter + summary)
head -20 docs/solutions/**/*.md
```

**Step 3: Filter - only spawn sub-agents for LIKELY relevant learnings**

Compare each learning's frontmatter against the plan:
- `tags:` - Do any tags match technologies/patterns in the plan?
- `category:` - Is this category relevant? (e.g., skip deployment-issues if plan is UI-only)
- `module:` - Does the plan touch this module?
- `symptom:` / `root_cause:` - Could this problem occur with the plan?

**SKIP learnings that are clearly not applicable:**
- Plan is frontend-only → skip `database-migrations/` learnings
- Plan is Python → skip `rails-specific/` learnings
- Plan has no auth → skip `authentication-issues/` learnings

**SPAWN sub-agents for learnings that MIGHT apply:**
- Any tag overlap with plan technologies
- Same category as plan domain
- Similar patterns or concerns

**Step 4: Spawn sub-agents for filtered learnings**

For each learning that passes the filter:

```
Task general-purpose: "
LEARNING FILE: [full path to .md file]

1. Read this learning file completely
2. This learning documents a previously solved problem

Check if this learning applies to this plan:

---
[full plan content]
---

If relevant:
- Explain specifically how it applies
- Quote the key insight or solution
- Suggest where/how to incorporate it

If NOT relevant after deeper analysis:
- Say 'Not applicable: [reason]'
"
```

**Example filtering:**
```
# Found 15 learning files, plan is about "Rails API caching"

# SPAWN (likely relevant):
docs/solutions/performance-issues/n-plus-one-queries.md      # tags: [activerecord] ✓
docs/solutions/performance-issues/redis-cache-stampede.md    # tags: [caching, redis] ✓
docs/solutions/configuration-fixes/redis-connection-pool.md  # tags: [redis] ✓

# SKIP (clearly not applicable):
docs/solutions/deployment-issues/heroku-memory-quota.md      # not about caching
docs/solutions/frontend-issues/stimulus-race-condition.md    # plan is API, not frontend
docs/solutions/authentication-issues/jwt-expiry.md           # plan has no auth
```

**Spawn sub-agents in PARALLEL for all filtered learnings.**

**These learnings are institutional knowledge - applying them prevents repeating past mistakes.**

### 4. Launch Per-Section Research Agents

<thinking>
For each major section in the plan, spawn dedicated sub-agents to research improvements. Use the Explore agent type for open-ended research.
</thinking>

**For each identified section, launch parallel research:**

```
Task Explore: "Research best practices, patterns, and real-world examples for: [section topic].
Find:
- Industry standards and conventions
- Performance considerations
- Common pitfalls and how to avoid them
- Documentation and tutorials
Return concrete, actionable recommendations."
```

**Also use Context7 MCP for framework documentation:**

For any technologies/frameworks mentioned in the plan, query Context7:
```
mcp__plugin_compound-engineering_context7__resolve-library-id: Find library ID for [framework]
mcp__plugin_compound-engineering_context7__query-docs: Query documentation for specific patterns
```

**Use WebSearch for current best practices:**

Search for recent (2024-2026) articles, blog posts, and documentation on topics in the plan.

### 5. Discover and Run ALL Review Agents

<thinking>
Dynamically discover every available agent and run them ALL against the plan. Don't filter, don't skip, don't assume relevance. 40+ parallel agents is fine. Use everything available.
</thinking>

**Step 1: Discover ALL available agents from ALL sources**

```bash
# 1. Project-local agents (highest priority - project-specific)
find .claude/agents -name "*.md" 2>/dev/null

# 2. User's global agents (~/.claude/)
find ~/.claude/agents -name "*.md" 2>/dev/null

# 3. compound-engineering plugin agents (all subdirectories)
find ~/.claude/plugins/cache/*/compound-engineering/*/agents -name "*.md" 2>/dev/null

# 4. ALL other installed plugins - check every plugin for agents
find ~/.claude/plugins/cache -path "*/agents/*.md" 2>/dev/null

# 5. Check installed_plugins.json to find all plugin locations
cat ~/.claude/plugins/installed_plugins.json

# 6. For local plugins (isLocal: true), check their source directories
# Parse installed_plugins.json and find local plugin paths
```

**Important:** Check EVERY source. Include agents from:
- Project `.claude/agents/`
- User's `~/.claude/agents/`
- compound-engineering plugin (but SKIP workflow/ agents - only use review/, research/, design/, docs/)
- ALL other installed plugins (agent-sdk-dev, frontend-design, etc.)
- Any local plugins

**For compound-engineering plugin specifically:**
- USE: `agents/review/*` (all reviewers)
- USE: `agents/research/*` (all researchers)
- USE: `agents/design/*` (design agents)
- USE: `agents/docs/*` (documentation agents)
- SKIP: `agents/workflow/*` (these are workflow orchestrators, not reviewers)

**Step 2: For each discovered agent, read its description**

Read the first few lines of each agent file to understand what it reviews/analyzes.

**Step 3: Launch ALL agents in parallel**

For EVERY agent discovered, launch a Task in parallel:

```
Task [agent-name]: "Review this plan using your expertise. Apply all your checks and patterns. Plan content: [full plan content]"
```

**CRITICAL RULES:**
- Do NOT filter agents by "relevance" - run them ALL
- Do NOT skip agents because they "might not apply" - let them decide
- Launch ALL agents in a SINGLE message with multiple Task tool calls
- 20, 30, 40 parallel agents is fine - use everything
- Each agent may catch something others miss
- The goal is MAXIMUM coverage, not efficiency

**Step 4: Also discover and run research agents**

Research agents (like `best-practices-researcher`, `framework-docs-researcher`, `git-history-analyzer`, `repo-research-analyst`) should also be run for relevant plan sections.

### 6. Wait for ALL Agents and Synthesize Everything

<thinking>
Wait for ALL parallel agents to complete - skills, research agents, review agents, everything. Then synthesize all findings into a comprehensive enhancement.
</thinking>

**Collect outputs from ALL sources:**

1. **Skill-based sub-agents** - Each skill's full output (code examples, patterns, recommendations)
2. **Learnings/Solutions sub-agents** - Relevant documented learnings from /ce:compound
3. **Research agents** - Best practices, documentation, real-world examples
4. **Review agents** - All feedback from every reviewer (architecture, security, performance, simplicity, etc.)
5. **Context7 queries** - Framework documentation and patterns
6. **Web searches** - Current best practices and articles

**For each agent's findings, extract:**
- [ ] Concrete recommendations (actionable items)
- [ ] Code patterns and examples (copy-paste ready)
- [ ] Anti-patterns to avoid (warnings)
- [ ] Performance considerations (metrics, benchmarks)
- [ ] Security considerations (vulnerabilities, mitigations)
- [ ] Edge cases discovered (handling strategies)
- [ ] Documentation links (references)
- [ ] Skill-specific patterns (from matched skills)
- [ ] Relevant learnings (past solutions that apply - prevent repeating mistakes)

**Deduplicate and prioritize:**
- Merge similar recommendations from multiple agents
- Prioritize by impact (high-value improvements first)
- Flag conflicting advice for human review
- Group by plan section

### 7. Enhance Plan Sections

<thinking>
Merge research findings back into the plan, adding depth without changing the original structure.
</thinking>

**Enhancement format for each section:**

```markdown
## [Original Section Title]

[Original content preserved]

### Research Insights

**Best Practices:**
- [Concrete recommendation 1]
- [Concrete recommendation 2]

**Performance Considerations:**
- [Optimization opportunity]
- [Benchmark or metric to target]

**Implementation Details:**
```[language]
// Concrete code example from research
```

**Edge Cases:**
- [Edge case 1 and how to handle]
- [Edge case 2 and how to handle]

**References:**
- [Documentation URL 1]
- [Documentation URL 2]
```

### 8. Add Enhancement Summary

At the top of the plan, add a summary section:

```markdown
## Enhancement Summary

**Deepened on:** [Date]
**Sections enhanced:** [Count]
**Research agents used:** [List]

### Key Improvements
1. [Major improvement 1]
2. [Major improvement 2]
3. [Major improvement 3]

### New Considerations Discovered
- [Important finding 1]
- [Important finding 2]
```

### 9. Update Plan File

**Write the enhanced plan:**
- Preserve original filename
- Add `-deepened` suffix if user prefers a new file
- Update any timestamps or metadata

## Output Format

Update the plan file in place (or if user requests a separate file, append `-deepened` after `-plan`, e.g., `2026-01-15-feat-auth-plan-deepened.md`).

## Quality Checks

Before finalizing:
- [ ] All original content preserved
- [ ] Research insights clearly marked and attributed
- [ ] Code examples are syntactically correct
- [ ] Links are valid and relevant
- [ ] No contradictions between sections
- [ ] Enhancement summary accurately reflects changes

## Post-Enhancement Options

After writing the enhanced plan, use the **AskUserQuestion tool** to present these options:

**Question:** "Plan deepened at `[plan_path]`. What would you like to do next?"

**Options:**
1. **View diff** - Show what was added/changed
2. **Start `/ce:work`** - Begin implementing this enhanced plan
3. **Deepen further** - Run another round of research on specific sections
4. **Revert** - Restore original plan (if backup exists)

Based on selection:
- **View diff** → Run `git diff [plan_path]` or show before/after
- **`/ce:work`** → Call the /ce:work command with the plan file path
- **Deepen further** → Ask which sections need more research, then re-run those agents
- **Revert** → Restore from git or backup

## Example Enhancement

**Before (from /workflows:plan):**
```markdown
## Technical Approach

Use React Query for data fetching with optimistic updates.
```

**After (from /workflows:deepen-plan):**
```markdown
## Technical Approach

Use React Query for data fetching with optimistic updates.

### Research Insights

**Best Practices:**
- Configure `staleTime` and `cacheTime` based on data freshness requirements
- Use `queryKey` factories for consistent cache invalidation
- Implement error boundaries around query-dependent components

**Performance Considerations:**
- Enable `refetchOnWindowFocus: false` for stable data to reduce unnecessary requests
- Use `select` option to transform and memoize data at query level
- Consider `placeholderData` for instant perceived loading

**Implementation Details:**
```typescript
// Recommended query configuration
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});
```

**Edge Cases:**
- Handle race conditions with `cancelQueries` on component unmount
- Implement retry logic for transient network failures
- Consider offline support with `persistQueryClient`

**References:**
- https://tanstack.com/query/latest/docs/react/guides/optimistic-updates
- https://tkdodo.eu/blog/practical-react-query
```

NEVER CODE! Just research and enhance the plan.

---
