# Multi-Agent Execution — Parallel & Sequential Patterns

> Consolidated from sadd-do-in-parallel, sadd-do-in-steps, sadd-launch-sub-agent.
> Every line preserved verbatim per zero-value-loss protocol.

---

## Source: sadd-do-in-parallel


# do-in-parallel

<task>
Launch multiple sub-agents in parallel to execute the same task across different files or targets. Analyze the task to intelligently select the optimal model, generate quality-focused prompts with Zero-shot Chain-of-Thought reasoning and mandatory self-critique, then dispatch all agents simultaneously and collect results.
</task>

<context>
This command implements the **Supervisor/Orchestrator pattern** with parallel dispatch. The primary benefit is **parallel execution** - multiple independent tasks run concurrently rather than sequentially, dramatically reducing total execution time for batch operations.

**Common use cases:**
- Apply the same refactoring across multiple files
- Run code analysis on several modules simultaneously
- Generate documentation for multiple components
- Execute independent transformations in parallel
</context>

## Process

### Phase 1: Parse Input and Identify Targets

Extract targets from the command arguments:

```
Input patterns:
1. --files "src/a.ts,src/b.ts,src/c.ts"    --> File-based targets
2. --targets "UserService,OrderService"    --> Named targets
3. Infer from task description             --> Parse file paths from task
```

**Parsing rules:**
- If `--files` provided: Split by comma, validate each path exists
- If `--targets` provided: Split by comma, use as-is
- If neither: Attempt to extract file paths or target names from task description

### Phase 2: Task Analysis with Zero-shot CoT

Before dispatching, analyze the task systematically:

```
Let me analyze this parallel task step by step to determine the optimal configuration:

1. **Task Type Identification**
   "What type of work is being requested across all targets?"
   - Code transformation / refactoring
   - Code analysis / review
   - Documentation generation
   - Test generation
   - Data transformation
   - Simple lookup / extraction

2. **Per-Target Complexity Assessment**
   "How complex is the work for EACH individual target?"
   - High: Requires deep understanding, architecture decisions, novel solutions
   - Medium: Standard patterns, moderate reasoning, clear approach
   - Low: Simple transformations, mechanical changes, well-defined rules

3. **Per-Target Output Size**
   "How extensive is each target's expected output?"
   - Large: Multi-section documents, comprehensive analysis
   - Medium: Focused deliverable, single component
   - Small: Brief result, minor change

4. **Independence Check**
   "Are the targets truly independent?"
   - Yes: No shared state, no cross-dependencies, order doesn't matter
   - Partial: Some shared context needed, but can run in parallel
   - No: Dependencies exist --> Use sequential execution instead
```

#### Independence Validation (REQUIRED before parallel dispatch)

Verify tasks are truly independent before proceeding:

| Check | Question | If NO |
|-------|----------|-------|
| File Independence | Do targets share files? | Cannot parallelize - files conflict |
| State Independence | Do tasks modify shared state? | Cannot parallelize - race conditions |
| Order Independence | Does execution order matter? | Cannot parallelize - sequencing required |
| Output Independence | Does any target read another's output? | Cannot parallelize - data dependency |

**Independence Checklist:**
- [ ] No target reads output from another target
- [ ] No target modifies files another target reads
- [ ] Order of completion doesn't matter
- [ ] No shared mutable state
- [ ] No database transactions spanning targets

If ANY check fails: STOP and inform user why parallelization is unsafe. Recommend `/launch-sub-agent` for sequential execution.

### Phase 3: Model and Agent Selection

Select the optimal model and specialized agent based on task analysis. **Same configuration for all parallel agents** (ensures consistent quality):

#### 3.1 Model Selection

| Task Profile | Recommended Model | Rationale |
|--------------|-------------------|-----------|
| **Complex per-target** (architecture, design) | `opus` | Maximum reasoning capability per task |
| **Specialized domain** (code review, security) | `opus` | Domain expertise matters |
| **Medium complexity, large output** | `sonnet` | Good capability, cost-efficient for volume |
| **Simple transformations** (rename, format) | `haiku` | Fast, cheap, sufficient for mechanical tasks |
| **Default** (when uncertain) | `opus` | Optimize for quality over cost |

**Decision Tree:**

```
Is EACH target's task COMPLEX (architecture, novel problem, critical decision)?
|
+-- YES --> Use Opus for ALL agents
|
+-- NO --> Is task SIMPLE and MECHANICAL (rename, format, extract)?
           |
           +-- YES --> Use Haiku for ALL agents
           |
           +-- NO --> Is output LARGE but task not complex?
                      |
                      +-- YES --> Use Sonnet for ALL agents
                      |
                      +-- NO --> Use Opus for ALL agents (default)
```

#### 3.2 Specialized Agent Selection (Optional)

If the task matches a specialized domain, include the relevant agent prompt in ALL parallel agents. Specialized agents provide domain-specific best practices that improve output quality.

**Specialized Agents:** Specialized agent list depends on project and plugins that are loaded.

**Decision:** Use specialized agent when:
- Task clearly benefits from domain expertise
- Consistency across all parallel agents is important
- Task is NOT trivial (overhead not justified for simple tasks)

Skip specialized agent when:
- Task is simple/mechanical (Haiku-tier)
- No clear domain match exists
- General-purpose execution is sufficient

### Phase 4: Construct Per-Target Prompts

Build identical prompt structure for each target, customized only with target-specific details:

#### 4.1 Zero-shot Chain-of-Thought Prefix (REQUIRED - MUST BE FIRST)

```markdown
## Reasoning Approach

Let's think step by step.

Before taking any action, think through the problem systematically:

1. "Let me first understand what is being asked for this specific target..."
   - What is the core objective?
   - What are the explicit requirements?
   - What constraints must I respect?

2. "Let me analyze this specific target..."
   - What is the current state?
   - What patterns or conventions exist?
   - What context is relevant?

3. "Let me plan my approach..."
   - What are the concrete steps?
   - What could go wrong?
   - Is there a simpler approach?

Work through each step explicitly before implementing.
```

#### 4.2 Task Body (Customized per target)

```markdown
<task>
{Task description from $ARGUMENTS}
</task>

<target>
{Specific target for this agent: file path, component name, etc.}
</target>

<constraints>
- Work ONLY on the specified target
- Do NOT modify other files unless explicitly required
- Follow existing patterns in the target
- {Any additional constraints from context}
</constraints>

<output>
{Expected deliverable location and format}
</output>
```

#### 4.3 Self-Critique Suffix (REQUIRED - MUST BE LAST)

```markdown
## Self-Critique Verification (MANDATORY)

Before completing, verify your work for this target. Do not submit unverified changes.

### 1. Generate Verification Questions

Create questions specific to your task and target. There examples of questions:

| # | Question | Why It Matters |
|---|----------|----------------|
| 1 | Did I achieve the stated objective for this target? | Incomplete work = failed task |
| 2 | Are my changes consistent with patterns in this file/codebase? | Inconsistency creates technical debt |
| 3 | Did I introduce any regressions or break existing functionality? | Breaking changes are unacceptable |
| 4 | Are edge cases and error scenarios handled appropriately? | Edge cases cause production issues |
| 5 | Is my output clear, well-formatted, and ready for review? | Unclear output reduces value |

### 2. Answer Each Question with Evidence

For each question, provide specific evidence from your work:

[Q1] Objective Achievement:
- Required: [what was asked]
- Delivered: [what you did]
- Gap analysis: [any gaps]

[Q2] Pattern Consistency:
- Existing pattern: [observed pattern]
- My implementation: [how I followed it]
- Deviations: [any intentional deviations and why]

[Q3] Regression Check:
- Functions affected: [list]
- Tests that would catch issues: [if known]
- Confidence level: [HIGH/MEDIUM/LOW]

[Q4] Edge Cases:
- Edge case 1: [scenario] - [HANDLED/NOTED]
- Edge case 2: [scenario] - [HANDLED/NOTED]

[Q5] Output Quality:
- Well-organized: [YES/NO]
- Self-documenting: [YES/NO]
- Ready for PR: [YES/NO]

### 3. Fix Issues Before Submitting

If ANY verification reveals a gap:
1. **FIX** - Address the specific issue
2. **RE-VERIFY** - Confirm the fix resolves the issue
3. **DOCUMENT** - Note what was changed and why

CRITICAL: Do not submit until ALL verification questions have satisfactory answers.
```

### Phase 5: Parallel Dispatch

Launch all sub-agents simultaneously using the Task tool.

**CRITICAL: Parallel Dispatch Pattern**

Launch ALL agents in a SINGLE response. Do NOT wait for one agent to complete before starting another:

```markdown
## Dispatching 3 parallel tasks

[Task 1]
Use Task tool:
  description: "Parallel: simplify error handling in src/services/user.ts"
  prompt: [CoT prefix + task body for user.ts + critique suffix]
  model: sonnet

[Task 2]
Use Task tool:
  description: "Parallel: simplify error handling in src/services/order.ts"
  prompt: [CoT prefix + task body for order.ts + critique suffix]
  model: sonnet

[Task 3]
Use Task tool:
  description: "Parallel: simplify error handling in src/services/payment.ts"
  prompt: [CoT prefix + task body for payment.ts + critique suffix]
  model: sonnet

[All 3 tasks launched simultaneously - results collected when all complete]
```

**Parallelization Guidelines:**
- Launch ALL independent tasks in a single batch (same response)
- Do NOT wait for one task before starting another
- Do NOT make sequential Task tool calls
- Task tool handles parallelization automatically
- Results collected after all complete

**Context Isolation (IMPORTANT):**
- Pass only context relevant to each specific target
- Do NOT pass the full list of all targets to each agent
- Let sub-agents discover local patterns through file reading
- Each agent works in clean context without accumulated confusion

### Phase 6: Collect and Summarize Results

After all agents complete, aggregate results:

```markdown
## Parallel Execution Summary

### Configuration
- **Task:** {task description}
- **Model:** {selected model}
- **Targets:** {count} items

### Results

| Target | Model | Status | Summary |
|--------|-------|--------|---------|
| {target_1} | {model} | SUCCESS/FAILED | {brief outcome} |
| {target_2} | {model} | SUCCESS/FAILED | {brief outcome} |
| ... | ... | ... | ... |

### Overall Assessment
- **Completed:** {X}/{total}
- **Failed:** {Y}/{total}
- **Common patterns:** {any patterns across results}

### Verification Summary
{Aggregate self-critique results - any common gaps?}

### Files Modified
- {list of all modified files}

### Next Steps
{If any failures, suggest remediation}
```

**Failure Handling:**
- Report failed tasks clearly with error details
- Successful tasks are NOT affected by failures
- Do NOT retry automatically (let user decide)
- Suggest re-running failed targets with `/launch-sub-agent`

## Examples

### Example 1: Code Simplification Across Modules

**Input:**
```
/do-in-parallel "Simplify error handling to use early returns instead of nested if-else" \
  --files "src/services/user.ts,src/services/order.ts,src/services/payment.ts"
```

**Analysis:**
- Task type: Code transformation / refactoring
- Per-target complexity: Medium (pattern-based transformation)
- Output size: Medium (modified file)
- Independence: Yes (separate files, no cross-dependencies)

**Model Selection:** Sonnet (pattern-based, medium complexity)

**Dispatch:** 3 parallel agents, one per file

**Result:**
```markdown
## Parallel Execution Summary

### Configuration
- **Task:** Simplify error handling to use early returns
- **Model:** Sonnet
- **Targets:** 3 files

### Results

| Target | Model | Status | Summary |
|--------|-------|--------|---------|
| src/services/user.ts | sonnet | SUCCESS | Converted 4 nested if-else blocks to early returns |
| src/services/order.ts | sonnet | SUCCESS | Converted 6 nested if-else blocks to early returns |
| src/services/payment.ts | sonnet | SUCCESS | Converted 3 nested if-else blocks to early returns |

### Overall Assessment
- **Completed:** 3/3
- **Common patterns:** All files followed consistent early return pattern
```


### Example 3: Security Analysis

**Input:**
```
/do-in-parallel "Analyze for potential SQL injection vulnerabilities and suggest fixes" \
  --files "src/db/queries.ts,src/db/migrations.ts,src/api/search.ts"
```

**Analysis:**
- Task type: Security analysis
- Per-target complexity: High (security requires careful analysis)
- Output size: Medium (analysis report + suggestions)
- Independence: Yes

**Model Selection:** Opus (security-critical, requires deep analysis)

**Dispatch:** 3 parallel agents


### Example 5: Inferred Targets from Task

**Input:**
```
/do-in-parallel "Apply consistent logging format to src/handlers/user.ts, src/handlers/order.ts, and src/handlers/product.ts"
```

**Analysis:**
- Targets inferred: 3 files extracted from task description
- Task type: Code transformation
- Complexity: Low
- Independence: Yes

**Model Selection:** Haiku (simple, mechanical)

**Dispatch:** 3 parallel agents

## Best Practices

### Target Selection

- **Be specific:** List exact files when possible
- **Use globs carefully:** Review expanded list before confirming
- **Limit scope:** 10-15 targets max per batch for manageability
- **Group by similarity:** Similar targets benefit from consistent patterns

### Model Selection Guidelines

| Scenario | Model | Reason |
|----------|-------|--------|
| Security analysis | Opus | Critical reasoning required |
| Architecture decisions | Opus | Quality over speed |
| Simple refactoring | Haiku | Fast, sufficient |
| Documentation generation | Haiku | Mechanical task |
| Code review per file | Sonnet | Balanced capability |
| Test generation | Sonnet | Extensive but patterned |

### Context Isolation

- **Minimal context:** Each sub-agent gets only what it needs
- **No cross-references:** Don't tell Agent A about Agent B's target
- **Let them discover:** Sub-agents read files to understand patterns
- **File system as truth:** Changes are coordinated through the filesystem

### Quality Assurance

- **Self-critique is mandatory:** Every sub-agent must verify its work
- **Review the summary:** Check for failed or partial completions
- **Run tests after:** Parallel changes may have subtle interactions
- **Commit atomically:** All changes from one batch = one commit

#### Error Handling

| Failure Type | Description | Recovery Action |
|--------------|-------------|-----------------|
| **Recoverable** | Sub-agent made a mistake but approach is sound | Retry step with corrected prompt (max 1 retry) |
| **Approach Failure** | The approach for this step is wrong | Escalate to user with options |
| **Foundation Issue** | Previous step output is insufficient | May need to revisit earlier step |

**Critical Rules:**
- NEVER continue past a failed step
- NEVER try to "fix forward" without addressing the failure
- NEVER retry more than once without user input
- STOP and report if context is missing (don't guess)

---

## Source: sadd-do-in-steps


# do-in-steps

<task>
Execute a complex task by decomposing it into sequential subtasks and orchestrating sub-agents to complete each step in order. Automatically analyze the task to identify dependencies, select optimal models for each subtask, pass relevant context from completed steps to subsequent ones, and verify each step with an independent judge before proceeding.
</task>

<context>
This command implements the **Supervisor/Orchestrator pattern** for sequential task execution with context passing and **LLM-as-a-judge verification**. You (the orchestrator) analyze a complex task, decompose it into ordered subtasks, and dispatch focused sub-agents for each step. Each sub-agent receives:
- **Isolated context** - Clean context window for its specific subtask
- **Optimal model** - Selected based on subtask complexity (Opus/Sonnet/Haiku)
- **Previous step context** - Summary of relevant outputs from preceding steps
- **Structured reasoning** - Zero-shot CoT prefix for systematic thinking
- **Self-critique** - Internal verification before submission
- **External judge** - LLM-as-a-judge verification with iteration loop

</context>

CRITICAL: You are the orchestrator - you MUST NOT perform the subtasks yourself. Your role is to:

1. Analyze and decompose the task
2. Select optimal models and agents for each subtask
3. Dispatch sub-agents with proper prompts
4. **Dispatch judge to verify step completion**
5. **Iterate if judge fails the step (max 2 retries)**
6. Collect outputs and pass context forward
7. Report final results

## RED FLAGS - Never Do These

**NEVER:**

- Read implementation files to understand code details (let sub-agents do this)
- Write code or make changes to source files directly
- Skip decomposition and jump to implementation
- Perform multiple steps yourself "to save time"
- Overflow your context by reading step outputs in detail
- Read judge reports in full (only parse structured headers)
- Skip judge verification and proceed next step

**ALWAYS:**

- Use Task tool to dispatch sub-agents for ALL implementation work
- Use Task tool to dispatch **independent judges** for step verification
- Pass only necessary context summaries, not full file contents
- Wait for each step to complete before starting verifictaion AND
- Get pass from judge verification before proceeding to next step
- Iterate with judge feedback if verification fails (max 2 retries)

Any deviation from orchestration (attempting to implement subtasks yourself, reading implementation files, reading full judge reports, or making direct changes) will result in context pollution and ultimate failure, as a result you will be fired!

## Process

### Setup: Create Reports Directory

Before starting, ensure the reports directory exists:

```bash
mkdir -p .specs/reports
```

**Report naming convention:** `.specs/reports/{task-name}-step-{N}-{YYYY-MM-DD}.md`

Where:

- `{task-name}` - Derived from task description (e.g., `user-dto-refactor`)
- `{N}` - Step number
- `{YYYY-MM-DD}` - Current date

**Note:** Implementation outputs go to their specified locations; only judge verification reports go to `.specs/reports/`

### Phase 1: Task Analysis and Decomposition

Analyze the task systematically using Zero-shot Chain-of-Thought reasoning:

```
Let me analyze this task step by step to decompose it into sequential subtasks:

1. **Task Understanding**
   "What is the overall objective?"
   - What is being asked?
   - What is the expected final outcome?
   - What constraints exist?

2. **Identify Natural Boundaries**
   "Where does the work naturally divide?"
   - Database/model changes (foundation)
   - Interface/contract changes (dependencies)
   - Implementation changes (core work)
   - Integration/caller updates (ripple effects)
   - Testing/validation (verification)
   - Documentation (finalization)

3. **Dependency Identification**
   "What must happen before what?"
   - "If I do B before A, will B break or use stale information?"
   - "Does B need any output from A as input?"
   - "Would doing B first require redoing work after A?"
   - What is the minimal viable ordering?

4. **Define Clear Boundaries**
   "What exactly does each subtask encompass?"
   - Input: What does this step receive?
   - Action: What transformation/change does it make?
   - Output: What does this step produce?
   - Verification: How do we know it succeeded?
```

**Decomposition Guidelines:**

| Pattern | Decomposition Strategy | Example |
|---------|------------------------|---------|
| Interface change | 1. Update interface, 2. Update implementations, 3. Update consumers | "Change return type of getUser" |
| Feature addition | 1. Add core logic, 2. Add integration points, 3. Add API layer | "Add caching to UserService" |
| Refactoring | 1. Extract/modify core, 2. Update internal references, 3. Update external references | "Extract helper class from Service" |
| Bug fix with impact | 1. Fix root cause, 2. Fix dependent issues, 3. Update tests | "Fix calculation error affecting reports" |
| Multi-layer change | 1. Data layer, 2. Business layer, 3. API layer, 4. Client layer | "Add new field to User entity" |

**Decomposition Output Format:**

```markdown
## Task Decomposition

### Original Task
{task_description}

### Subtasks (Sequential Order)

| Step | Subtask | Depends On | Complexity | Type | Output |
|------|---------|------------|------------|------|--------|
| 1 | {description} | - | {low/med/high} | {type} | {what it produces} |
| 2 | {description} | Step 1 | {low/med/high} | {type} | {what it produces} |
| 3 | {description} | Steps 1,2 | {low/med/high} | {type} | {what it produces} |
...

### Dependency Graph
Step 1 ─→ Step 2 ─→ Step 3 ─→ ...
```

### Phase 2: Model Selection for Each Subtask

For each subtask, analyze and select the optimal model:

```
Let me determine the optimal configuration for each subtask:

For Subtask N:
1. **Complexity Assessment**
   "How complex is the reasoning required?"
   - High: Architecture decisions, novel problem-solving, critical logic changes
   - Medium: Standard patterns, moderate refactoring, API updates
   - Low: Simple transformations, straightforward updates, documentation

2. **Scope Assessment**
   "How extensive is the work?"
   - Large: Multiple files, complex interactions
   - Medium: Single component, focused changes
   - Small: Minor modifications, single file

3. **Risk Assessment**
   "What is the impact of errors?"
   - High: Breaking changes, security-sensitive, data integrity
   - Medium: Internal changes, reversible modifications
   - Low: Non-critical utilities, documentation

4. **Domain Expertise Check**
   "Does this match a specialized agent profile?"
   - Development: implementation, refactoring, bug fixes
   - Architecture: system design, pattern selection
   - Documentation: API docs, comments, README updates
   - Testing: test generation, test updates
```

**Model Selection Matrix:**

| Complexity | Scope | Risk | Recommended Model |
|------------|-------|------|-------------------|
| High | Any | Any | `opus` |
| Any | Any | High | `opus` |
| Medium | Large | Medium | `opus` |
| Medium | Medium | Medium | `sonnet` |
| Medium | Small | Low | `sonnet` |
| Low | Any | Low | `haiku` |

**Decision Tree per Subtask:**

```
Is this subtask CRITICAL (architecture, interface, breaking changes)?
|
+-- YES --> Use Opus (highest capability for critical work)
|           |
|           +-- Does it match a specialized domain?
|               +-- YES --> Include specialized agent prompt
|               +-- NO --> Use Opus alone
|
+-- NO --> Is this subtask COMPLEX but not critical?
           |
           +-- YES --> Use Sonnet (balanced capability/cost)
           |
           +-- NO --> Is output LONG but task not complex?
                      |
                      +-- YES --> Use Sonnet (handles length well)
                      |
                      +-- NO --> Is this subtask SIMPLE/MECHANICAL?
                                 |
                                 +-- YES --> Use Haiku (fast, cheap)
                                 |
                                 +-- NO --> Use Sonnet (default for uncertain)
```

**Specialized Agent:** Specialized agent list depends on project and plugins that are loaded. Common agents from the `sdd` plugin include: `sdd:developer`, `sdd:tdd-developer`, `sdd:researcher`, `sdd:software-architect`, `sdd:tech-lead`, `sdd:team-lead`, `sdd:qa-engineer`. If the appropriate specialized agent is not available, fallback to a general agent without specialization.

**Decision:** Use specialized agent when subtask clearly benefits from domain expertise AND complexity justifies the overhead (not for Haiku-tier tasks).

**Selection Output Format:**

```markdown
## Model/Agent Selection

| Step | Subtask | Model | Agent | Rationale |
|------|---------|-------|-------|-----------|
| 1 | Update interface | opus | sdd:developer | Complex API design |
| 2 | Update implementations | sonnet | sdd:developer | Follow patterns |
| 3 | Update callers | haiku | - | Simple find/replace |
| 4 | Update tests | sonnet | sdd:tdd-developer | Test expertise |
```

### Phase 3: Sequential Execution with Judge Verification

Execute subtasks one by one, verify each with an independent judge, iterate if needed, then pass context forward.

**Execution Flow per Step:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Step N                                                                  │
│                                                                         │
│   ┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐   │
│   │ Implementer  │────▶│    Judge     │────▶│ Parse Verdict        │   │
│   │ (Sub-agent)  │     │ (Sub-agent)  │     │ (Orchestrator)       │   │
│   └──────────────┘     └──────────────┘     └──────────────────────┘   │
│          ▲                                            │                 │
│          │                                            ▼                 │
│          │                              ┌─────────────────────────┐     │
│          │                              │ PASS (≥3.5)?            │     │
│          │                              │ ├─ YES → Next Step      │     │
│          │                              │ └─ NO  → Retry?         │     │
│          │                              │     ├─ <2 → Retry       │     │
│          │                              │     └─ ≥2 → Escalate    │     │
│          │                              └─────────────────────────┘     │
│          │                                            │                 │
│          └────────────── feedback ────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 3.1 Context Passing Protocol

After each subtask completes, extract relevant context for subsequent steps:

**Context to pass forward:**

- Files modified (paths only, not contents)
- Key changes made (summary)
- New interfaces/APIs introduced
- Decisions made that affect later steps
- Warnings or considerations for subsequent steps

**Context filtering:**

- Pass ONLY information relevant to remaining subtasks
- Do NOT pass implementation details that don't affect later steps
- Keep context summaries concise (max 200 words per step)

**Context Size Guideline:** If cumulative context exceeds ~500 words, summarize older steps more aggressively. Sub-agents can read files directly if they need details.

**Example of Context Accumulation (Concrete):**

```markdown
## Completed Steps Summary

### Step 1: Define UserRepository Interface
- **What was done:** Created `src/repositories/UserRepository.ts` with interface definition
- **Key outputs:**
  - Interface: `IUserRepository` with methods: `findById`, `findByEmail`, `create`, `update`, `delete`
  - Types: `UserCreateInput`, `UserUpdateInput` in `src/types/user.ts`
- **Relevant for next steps:**
  - Implementation must fulfill `IUserRepository` interface
  - Use the defined input types for method signatures

### Step 2: Implement UserRepository
- **What was done:** Created `src/repositories/UserRepositoryImpl.ts` implementing `IUserRepository`
- **Key outputs:**
  - Class: `UserRepositoryImpl` with all interface methods implemented
  - Uses existing database connection from `src/db/connection.ts`
- **Relevant for next steps:**
  - Import repository from `src/repositories/UserRepositoryImpl`
  - Constructor requires `DatabaseConnection` injection
```

#### 3.2 Sub-Agent Prompt Construction

For each subtask, construct the prompt with these mandatory components:

##### 3.2.1 Zero-shot Chain-of-Thought Prefix (REQUIRED - MUST BE FIRST)

```markdown
## Reasoning Approach

Before taking any action, think through this subtask systematically.

Let's approach this step by step:

1. "Let me understand what was done in previous steps..."
   - What context am I building on?
   - What interfaces/patterns were established?
   - What constraints did previous steps introduce?

2. "Let me understand what this step requires..."
   - What is the specific objective?
   - What are the boundaries of this step?
   - What must I NOT change (preserve from previous steps)?

3. "Let me plan my approach..."
   - What specific modifications are needed?
   - What order should I make them?
   - What could go wrong?

4. "Let me verify my approach before implementing..."
   - Does my plan achieve the objective?
   - Am I consistent with previous steps' changes?
   - Is there a simpler way?

Work through each step explicitly before implementing.
```

##### 3.2.2 Task Body

```markdown
<task>
{Subtask description}
</task>

<subtask_context>
Step {N} of {total_steps}: {subtask_name}
</subtask_context>

<previous_steps_context>
{Summary of relevant outputs from previous steps - ONLY if this is not the first step}
- Step 1: {what was done, key files modified, relevant decisions}
- Step 2: {what was done, key files modified, relevant decisions}
...
</previous_steps_context>

<constraints>
- Focus ONLY on this specific subtask
- Build upon (do not undo) changes from previous steps
- Follow existing code patterns and conventions
- Produce output that subsequent steps can build upon
</constraints>

<input>
{What this subtask receives - files, context, dependencies}
</input>

<output>
{Expected deliverable - modified files, new files, summary of changes}

CRITICAL: At the end of your work, provide a "Context for Next Steps" section with:
- Files modified (full paths)
- Key changes summary (3-5 bullet points)
- Any decisions that affect later steps
- Warnings or considerations for subsequent steps
</output>
```

##### 3.2.3 Self-Critique Suffix (REQUIRED - MUST BE LAST)

```markdown
## Self-Critique Verification (MANDATORY)

Before completing, verify your work integrates properly with previous steps. Do not submit unverified changes.

### Verification Questions

Generate verification questions based on the subtask description and the previous steps context. Examples:

| # | Question | Evidence Required |
|---|----------|-------------------|
| 1 | Does my work build correctly on previous step outputs? | [Specific evidence] |
| 2 | Did I maintain consistency with established patterns/interfaces? | [Specific evidence] |
| 3 | Does my solution address ALL requirements for this step? | [Specific evidence] |
| 4 | Did I stay within my scope (not modifying unrelated code)? | [List any out-of-scope changes] |
| 5 | Is my output ready for the next step to build upon? | [Check against dependency graph] |

### Answer Each Question with Evidence

Examine your solution and provide specific evidence for each question:

[Q1] Previous Step Integration:
- Previous step output: [relevant context received]
- How I built upon it: [specific integration]
- Any conflicts: [resolved or flagged]

[Q2] Pattern Consistency:
- Patterns established: [list]
- How I followed them: [evidence]
- Any deviations: [justified or fixed]

[Q3] Requirement Completeness:
- Required: [what was asked]
- Delivered: [what you did]
- Gap analysis: [any gaps]

[Q4] Scope Adherence:
- In-scope changes: [list]
- Out-of-scope changes: [none, or justified]

[Q5] Output Readiness:
- What later steps need: [based on decomposition]
- What I provided: [specific outputs]
- Completeness: [HIGH/MEDIUM/LOW]

### Revise If Needed

If ANY verification question reveals a gap:
1. **FIX** - Address the specific gap identified
2. **RE-VERIFY** - Confirm the fix resolves the issue
3. **UPDATE** - Update the "Context for Next Steps" section

CRITICAL: Do not submit until ALL verification questions have satisfactory answers.
```

#### 3.3 Judge Verification Protocol

After implementation agent completes, dispatch an **independent judge** to verify the step.

**Judge report location:** `.specs/reports/{task-name}-step-{N}-{YYYY-MM-DD}.md`

**Prompt template for step judge:**

```markdown
You are verifying completion of Step {N}/{total}: {subtask_name}

<original_task>
{overall_task_description}
</original_task>

<step_requirements>
{subtask_description}
- Input: {what this step receives}
- Expected output: {what this step should produce}
- Verification points: {how to check success}
</step_requirements>

<previous_steps_context>
{Summary of what previous steps accomplished}
</previous_steps_context>

<implementation_output>
{Path to files modified by implementation agent}
{Context for Next Steps section from implementation agent}
</implementation_output>

<output>
Write report to: .specs/reports/{task-name}-step-{N}-{YYYY-MM-DD}.md

CRITICAL: You must reply with this exact structured header format:


[Detailed evaluation follows]
</output>

Evaluation criteria:
1. **Correctness** (35%) - Does the implementation meet step requirements?
2. **Integration** (25%) - Does it properly build on previous steps?
3. **Completeness** (25%) - Are all required elements present?
4. **Quality** (15%) - Is the code/output well-structured?

Instructions:
1. Read the implementation files and "Context for Next Steps" output
2. Verify each requirement was met with specific evidence
3. Check integration with previous steps' outputs
4. Identify any gaps, issues, or missing elements
5. Score each criterion and calculate weighted total
6. Generate 3 verification questions to verify your report. Answer them, correct report if found issues
7. Provide VERDICT:
   - PASS: Score ≥3.5/5.0 AND no critical issues
   - FAIL: Score <3.5/5.0 OR critical issues present

CRITICAL: If FAIL, list specific issues that must be fixed for retry.
```

#### 3.4 Dispatch, Verify, and Iterate

For each subtask in sequence:

```
1. Dispatch implementation sub-agent:
   Use Task tool:
     - description: "Step {N}/{total}: {subtask_name}"
     - prompt: {constructed prompt with CoT + task + previous context + self-critique}
     - model: {selected model for this subtask}

2. Collect implementation output:
   - Parse "Context for Next Steps" section from sub-agent response
   - Note files modified and verification points

3. Dispatch judge sub-agent:
   Use Task tool:
     - description: "Verify Step {N}/{total}: {subtask_name}"
     - prompt: {judge verification prompt with step requirements and implementation output}
     - model: {selected model for this subtask}

4. Parse judge verdict (DO NOT read full report):
   Extract from judge reply:
   - VERDICT: PASS or FAIL
   - SCORE: X.X/5.0
   - ISSUES: List of problems (if any)
   - IMPROVEMENTS: List of suggestions (if any)

5. Decision based on verdict:
   
   If VERDICT = PASS (score ≥3.5):
     → Proceed to next step with accumulated context
     → Include IMPROVEMENTS in context as optional enhancements
   
   If VERDICT = FAIL (score <3.5):
     → Check retry count for this step
     
     If retries < 2:
       → Dispatch retry implementation agent with:
         - Original step requirements
         - Judge's ISSUES list as feedback
         - Path to judge report for details
         - Instruction to fix specific issues
       → Return to step 3 (judge verification)
     
     If retries ≥ 2:
       → Escalate to user (see Error Handling)
       → Do NOT proceed to next step

6. Proceed to next subtask with accumulated context
```

**Retry prompt template for implementation agent:**

```markdown
## Retry Required: Step {N}/{total}

Your previous implementation did not pass judge verification.

<original_requirements>
{subtask_description}
</original_requirements>

<judge_feedback>
VERDICT: FAIL
SCORE: {score}/5.0
ISSUES:
{list of issues from judge}

Full report available at: {path_to_judge_report}
</judge_feedback>

<your_previous_output>
{files modified in previous attempt}
</your_previous_output>

Instructions:
Let's fix the identified issues step by step.

1. First, review each issue the judge identified
2. For each issue, determine the root cause
3. Plan the fix for each issue
4. Implement ALL fixes
5. Verify your fixes address each issue
6. Provide updated "Context for Next Steps" section

CRITICAL: Focus on fixing the specific issues identified. Do not rewrite everything.
```

### Phase 4: Final Summary and Report

After all subtasks complete and pass verification, reply with a comprehensive report:

```markdown
## Sequential Execution Summary

**Overall Task:** {original task description}
**Total Steps:** {count}
**Total Agents:** {implementation_agents + judge_agents}

### Step-by-Step Results

| Step | Subtask | Model | Judge Score | Retries | Status |
|------|---------|-------|-------------|---------|--------|
| 1 | {name} | {model} | {X.X}/5.0 | {0-2} | ✅ PASS |
| 2 | {name} | {model} | {X.X}/5.0 | {0-2} | ✅ PASS |
| ... | ... | ... | ... | ... | ... |

### Files Modified (All Steps)
- {file1}: {what changed, which step}
- {file2}: {what changed, which step}
...

### Key Decisions Made
- Step 1: {decision and rationale}
- Step 2: {decision and rationale}
...

### Integration Points
{How the steps connected and built upon each other}

### Judge Verification Summary
| Step | Initial Score | Final Score | Issues Fixed |
|------|---------------|-------------|--------------|
| 1 | {X.X} | {X.X} | {count or "None"} |
| 2 | {X.X} | {X.X} | {count or "None"} |

### Reports Directory
Judge reports saved to: `.specs/reports/{task-name}-step-*`

### Follow-up Recommendations
{Any improvements suggested by judges, tests to run, or manual verification needed}
```

## Error Handling

### If Judge Verification Fails (Score <3.5)

The judge-verified iteration loop handles most failures automatically:

```
Judge FAIL (Retry Available):
  1. Parse ISSUES from judge verdict
  2. Dispatch retry implementation agent with feedback
  3. Re-verify with judge
  4. Repeat until PASS or max retries (2)
```

### If Step Fails After Max Retries

When a step fails judge verification twice:

1. **STOP** - Do not proceed with broken foundation
2. **Report** - Provide failure analysis:
   - Original step requirements
   - All judge verdicts and scores
   - Persistent issues across retries
3. **Escalate** - Present options to user:
   - Provide additional context/guidance for retry
   - Modify step requirements
   - Skip step (if optional)
   - Abort and report partial progress
4. **Wait** - Do NOT proceed without user decision

**Escalation Report Format:**

```markdown
## Step {N} Failed Verification (Max Retries Exceeded)

### Step Requirements
{subtask_description}

### Verification History
| Attempt | Score | Key Issues |
|---------|-------|------------|
| 1 | {X.X}/5.0 | {issues} |
| 2 | {X.X}/5.0 | {issues} |
| 3 | {X.X}/5.0 | {issues} |

### Persistent Issues
{Issues that appeared in multiple attempts}

### Judge Reports
- .specs/reports/{task-name}-step-{N}-attempt-1.md
- .specs/reports/{task-name}-step-{N}-attempt-2.md
- .specs/reports/{task-name}-step-{N}-attempt-3.md

### Options
1. **Provide guidance** - Give additional context for another retry
2. **Modify requirements** - Simplify or clarify step requirements
3. **Skip step** - Mark as skipped and continue (if non-critical)
4. **Abort** - Stop execution and preserve partial progress

Awaiting your decision...
```

**Never:**

- Continue past a failed step after max retries
- Skip judge verification to "save time"
- Ignore persistent issues across retries
- Make assumptions about what might have worked

### If Context is Missing

1. **Do NOT guess** what previous steps produced
2. **Re-examine** previous step output for missing information
3. **Check judge reports** - they may have noted missing elements
4. **Dispatch clarification sub-agent** if needed to extract missing context
5. **Update context passing** for future similar tasks

### If Steps Conflict

1. **Stop execution** at conflict point
2. **Analyze:** Was decomposition incorrect? Are steps actually dependent?
3. **Check judge feedback** - judges may have flagged integration issues
4. **Options:**
   - Re-order steps if dependency was missed
   - Combine conflicting steps into one
   - Add reconciliation step between conflicting steps

## Examples

### Example 1: Interface Change with Consumer Updates

**Input:**

```
/do-in-steps Change the return type of UserService.getUser() from User to UserDTO and update all consumers
```

**Phase 1 - Decomposition:**

| Step | Subtask | Depends On | Complexity | Type | Output |
|------|---------|------------|------------|------|--------|
| 1 | Create UserDTO class with proper structure | - | Medium | Implementation | New UserDTO.ts file |
| 2 | Update UserService.getUser() to return UserDTO | Step 1 | High | Implementation | Modified UserService |
| 3 | Update UserController to handle UserDTO | Step 2 | Medium | Refactoring | Modified UserController |
| 4 | Update tests for UserService and UserController | Steps 2,3 | Medium | Testing | Updated test files |

**Phase 2 - Model Selection:**

| Step | Subtask | Model | Agent | Rationale |
|------|---------|-------|-------|-----------|
| 1 | Create DTO | sonnet | sdd:developer | Medium complexity, standard pattern |
| 2 | Update Service | opus | sdd:developer | High risk, core service change |
| 3 | Update Controller | sonnet | sdd:developer | Medium complexity, follows patterns |
| 4 | Update Tests | sonnet | sdd:tdd-developer | Test expertise |

**Phase 3 - Execution with Judge Verification:**

```
Step 1: Create UserDTO
  Implementation (Sonnet)...
    -> Created UserDTO.ts with id, name, email, createdAt fields
  Judge Verification (Sonnet)...
    -> VERDICT: PASS, SCORE: 4.2/5.0
    -> IMPROVEMENTS: Consider adding validation methods
  -> Context passed: UserDTO interface, file path

Step 2: Update UserService (First Attempt Failed)
  Implementation (Opus)...
    -> Updated return type but missed mapping logic
  Judge Verification (Sonnet)...
    -> VERDICT: FAIL, SCORE: 2.8/5.0
    -> ISSUES: Missing User->UserDTO mapping, return type changed but still returns User
  Retry Implementation (Opus) with judge feedback...
    -> Added static fromUser() factory method
    -> Updated getUser() to use mapping
  Judge Verification (Sonnet)...
    -> VERDICT: PASS, SCORE: 4.5/5.0
  -> Context passed: Method signature changed, mapping pattern used

Step 3: Update UserController
  Implementation (Sonnet)...
    -> Updated controller to expect UserDTO
  Judge Verification (Sonnet)...
    -> VERDICT: PASS, SCORE: 4.0/5.0
  -> Context passed: Endpoint contracts updated

Step 4: Update Tests
  Implementation (Sonnet + sdd:developer)...
    -> Updated service and controller tests
  Judge Verification (Sonnet)...
    -> VERDICT: PASS, SCORE: 4.3/5.0
  -> All steps complete
```

**Final Summary:**

- Total Agents: 9 (4 implementations + 1 retry + 4 judges)
- Steps with Retries: Step 2 (1 retry)
- All Judge Scores: 4.2, 4.5, 4.0, 4.3


### Example 3: Multi-file Refactoring with Escalation

**Input:**

```
/do-in-steps Rename 'userId' to 'accountId' across the codebase - this affects interfaces, implementations, and callers
```

**Phase 1 - Decomposition:**

| Step | Subtask | Depends On | Complexity | Type | Output |
|------|---------|------------|------------|------|--------|
| 1 | Update interface definitions | - | High | Refactoring | Updated interfaces |
| 2 | Update implementations of those interfaces | Step 1 | Low | Refactoring | Updated implementations |
| 3 | Update callers and consumers | Step 2 | Low | Refactoring | Updated caller files |
| 4 | Update tests | Step 3 | Low | Testing | Updated test files |
| 5 | Update documentation | Step 4 | Low | Documentation | Updated docs |

**Phase 2 - Model Selection:**

| Step | Subtask | Impl Model | Judge Model | Rationale |
|------|---------|------------|-------------|-----------|
| 1 | Update interfaces | opus | sonnet | Breaking changes need careful handling |
| 2 | Update implementations | haiku | haiku | Mechanical rename |
| 3 | Update callers | haiku | haiku | Mechanical updates |
| 4 | Update tests | haiku | haiku | Mechanical test fixes |
| 5 | Update documentation | haiku | haiku | Simple text updates |

**Phase 3 - Execution with Escalation:**

```
Step 1: Update interfaces
  -> Judge: PASS, 4.3/5.0

Step 2: Update implementations
  -> Judge: PASS, 4.0/5.0

Step 3: Update callers (Problem Detected)
  Attempt 1: Judge FAIL, 2.5/5.0
    -> ISSUES: Missed 12 occurrences in legacy module
  Attempt 2: Judge FAIL, 2.8/5.0
    -> ISSUES: Still missing 4 occurrences, found new deprecated API usage
  Attempt 3: Judge FAIL, 3.2/5.0
    -> ISSUES: 2 occurrences in dynamically generated code
  
  ESCALATION TO USER:
  "Step 3 failed after 3 attempts. Persistent issue: Dynamic code generation
   in LegacyAdapter.ts generates 'userId' at runtime.
   Options: 1) Provide guidance, 2) Modify requirements, 3) Skip, 4) Abort"
  
  User response: "Update LegacyAdapter to use string template with accountId"
  
  Attempt 4 (with user guidance): Judge PASS, 4.1/5.0

Step 4-5: Complete without issues
```

Total Agents: 14 (5 implementations + 4 retries + 5 judges)

## Best Practices

### Task Decomposition

- **Be explicit:** Each subtask should have a clear, verifiable outcome
- **Define verification points:** What should the judge check for each step?
- **Minimize steps:** Combine related work; don't over-decompose
- **Validate dependencies:** Ensure each step has what it needs from previous steps
- **Plan context:** Identify what context needs to pass between steps

### Model Selection

- **Match complexity:** Don't use Opus for simple transformations
- **Upgrade for risk:** First step and critical steps deserve stronger models
- **Consider chain effect:** Errors in early steps cascade; invest in quality early
- **When in doubt, use Opus:** Quality over cost for dependent steps
- **Judges can use Sonnet:** Verification is less complex than implementation

| Step Type | Implementation Model | Judge Model |
|-----------|---------------------|-------------|
| Critical/Breaking | Opus | Opus |
| Standard | Opus | Opus |
| Long and Simple | Sonnet | Sonnet |
| Simple and Short | Haiku | Haiku |

### Context Passing Guidelines

| Scenario | What to Pass | What to Omit |
|----------|--------------|--------------|
| Interface defined in step 1 | Full interface definition | Implementation details |
| Implementation in step 2 | Key patterns, file locations | Internal logic |
| Integration in step 3 | Usage patterns, entry points | Step 2 internal details |
| Judge feedback for retry | ISSUES list, report path | Full report contents |

**Keep context focused:**

- Pass what the next step NEEDS to build on
- Omit internal details that don't affect subsequent steps
- Highlight patterns/conventions to maintain consistency
- Include judge IMPROVEMENTS as optional enhancements

### Judge Verification

- **After self-critique:** Judge reviews work that already passed internal verification
- **Independent verification:** Judge is different agent than implementer
- **Structured output:** Always parse VERDICT/SCORE from reply, not full report
- **Threshold:** 3.5/5.0 minimum score for PASS
- **Max retries:** 2 attempts before escalating to user
- **Feedback loop:** Pass judge ISSUES to retry implementation agent

**Judge Selection:**

- Use Opus for most verification (balanced cost/quality)
- Use Sonnet for long and simple step verification
- Use Haiku for simple and short step verification

### Quality Assurance

- **Two-layer verification:** Self-critique (internal) + Judge (external)
- **Self-critique first:** Implementation agents verify own work before submission
- **External judge second:** Independent judge catches blind spots self-critique misses
- **Iteration loop:** Retry with feedback until passing or max retries
- **Chain validation:** Judges check integration with previous steps
- **Escalation:** Don't proceed past failed steps - get user input
- **Final integration test:** After all steps, verify the complete change works together

## Context Format Reference

### Implementation Agent Output Format

```markdown
## Context for Next Steps

### Files Modified
- `src/dto/UserDTO.ts` (new file)
- `src/services/UserService.ts` (modified)

### Key Changes Summary
- Created UserDTO with fields: id (string), name (string), email (string), createdAt (Date)
- UserDTO includes static `fromUser(user: User): UserDTO` factory method
- Added `toDTO()` method to User class for convenience

### Decisions That Affect Later Steps
- Used class-based DTO (not interface) to enable transformation methods
- Opted for explicit mapping over automatic serialization for better control

### Warnings for Subsequent Steps
- UserDTO does NOT include password field - ensure no downstream code expects it
- The `createdAt` field is formatted as ISO string in JSON serialization

### Verification Points
- TypeScript compiles without errors
- UserDTO.fromUser() correctly maps all User properties
- Existing service tests still pass
```

### Judge Verdict Format (Structured Header)

```markdown

## Detailed Evaluation

### Correctness (35%) - Score: 4.5/5.0
[Evidence and analysis...]

### Integration (25%) - Score: 4.0/5.0
[Evidence and analysis...]

### Completeness (25%) - Score: 4.2/5.0
[Evidence and analysis...]

### Quality (15%) - Score: 4.0/5.0
[Evidence and analysis...]
```

### Judge Verdict Format (FAIL Example)

```markdown
```

**Key Insight:** Complex tasks with dependencies benefit from sequential execution where each step operates in a fresh context while receiving only the relevant outputs from previous steps. **External judge verification** catches blind spots that self-critique misses, while the **iteration loop** ensures quality before proceeding. This prevents both context pollution and error propagation.

---

## Source: sadd-launch-sub-agent


# launch-sub-agent

<task>
Launch a focused sub-agent to execute the provided task. Analyze the task to intelligently select the optimal model and agent configuration, then dispatch a sub-agent with Zero-shot Chain-of-Thought reasoning at the beginning and mandatory self-critique verification at the end.
</task>

<context>
This command implements the **Supervisor/Orchestrator pattern** from multi-agent architectures where you (the orchestrator) dispatch focused sub-agents with isolated context. The primary benefit is **context isolation** - each sub-agent operates in a clean context window focused on its specific task without accumulated context pollution.
</context>

## Process

### Phase 1: Task Analysis with Zero-shot CoT

Before dispatching, analyze the task systematically. Think through step by step:

```
Let me analyze this task step by step to determine the optimal configuration:

1. **Task Type Identification**
   "What type of work is being requested?"
   - Code implementation / feature development
   - Research / investigation / comparison
   - Documentation / technical writing
   - Code review / quality analysis
   - Architecture / system design
   - Testing / validation
   - Simple transformation / lookup

2. **Complexity Assessment**
   "How complex is the reasoning required?"
   - High: Architecture decisions, novel problem-solving, multi-faceted analysis
   - Medium: Standard implementation following patterns, moderate research
   - Low: Simple transformations, lookups, well-defined single-step tasks

3. **Output Size Estimation**
   "How extensive is the expected output?"
   - Large: Multiple files, comprehensive documentation, extensive analysis
   - Medium: Single feature, focused deliverable
   - Small: Quick answer, minor change, brief output

4. **Domain Expertise Check**
   "Does this task match a specialized agent profile?"
   - Development: code, implement, feature, endpoint, TDD, tests
   - Research: investigate, compare, evaluate, options, library
   - Documentation: document, README, guide, explain, tutorial
   - Architecture: design, system, structure, scalability
   - Exploration: understand, navigate, find, codebase patterns
```

### Phase 2: Model Selection

Select the optimal model based on task analysis:

| Task Profile | Recommended Model | Rationale |
|--------------|-------------------|-----------|
| **Complex reasoning** (architecture, design, critical decisions) | `opus` | Maximum reasoning capability |
| **Specialized domain** (matches agent profile) | Opus + Specialized Agent | Domain expertise + reasoning power |
| **Non-complex but long** (extensive docs, verbose output) | `sonnet[1m]` | Good capability, cost-efficient for length |
| **Simple and short** (trivial tasks, quick lookups) | `haiku` | Fast, cost-effective for easy tasks |
| **Default** (when uncertain) | `opus` | Optimize for quality over cost |

**Decision Tree:**

```
Is task COMPLEX (architecture, design, novel problem, critical decision)?
|
+-- YES --> Use Opus (highest capability)
|           |
|           +-- Does it match a specialized domain?
|               +-- YES --> Include specialized agent prompt
|               +-- NO --> Use Opus alone
|
+-- NO --> Is task SIMPLE and SHORT?
           |
           +-- YES --> Use Haiku (fast, cheap)
           |
           +-- NO --> Is output LONG but task not complex?
                      |
                      +-- YES --> Use Sonnet (balanced)
                      |
                      +-- NO --> Use Opus (default)
```

### Phase 3: Specialized Agent Matching

If the task matches a specialized domain, incorporate the relevant agent prompt. Specialized agents provide domain-specific best practices, quality standards, and structured approaches that improve output quality.

**Decision:** Use specialized agent when task clearly benefits from domain expertise. Skip for trivial tasks where specialization adds unnecessary overhead.

**Agents:** Available specialized agents depends on project and plugins installed. Common agents from the `sdd` plugin include: `sdd:developer`, `sdd:researcher`, `sdd:software-architect`, `sdd:tech-lead`, `sdd:team-lead`, `sdd:qa-engineer`, `sdd:code-explorer`, `sdd:business-analyst`. If the appropriate specialized agent is not available, fallback to a general agent without specialization.

**Integration with Model Selection:**

- Specialized agents are combined WITH model selection, not instead of
- Complex task + specialized domain = Opus + Specialized Agent
- Simple task matching domain = Haiku without specialization (overhead not justified)

**Usage:**

1. Read the agent definition
2. Include the agent's instructions in the sub-agent prompt AFTER the CoT prefix
3. Combine with Zero-shot CoT prefix and Critique suffix

### Phase 4: Construct Sub-Agent Prompt

Build the sub-agent prompt with these mandatory components:

#### 4.1 Zero-shot Chain-of-Thought Prefix (REQUIRED - MUST BE FIRST)

```markdown
## Reasoning Approach

Before taking any action, you MUST think through the problem systematically.

Let's approach this step by step:

1. "Let me first understand what is being asked..."
   - What is the core objective?
   - What are the explicit requirements?
   - What constraints must I respect?

2. "Let me break this down into concrete steps..."
   - What are the major components of this task?
   - What order should I tackle them?
   - What dependencies exist between steps?

3. "Let me consider what could go wrong..."
   - What assumptions am I making?
   - What edge cases might exist?
   - What could cause this to fail?

4. "Let me verify my approach before proceeding..."
   - Does my plan address all requirements?
   - Is there a simpler approach?
   - Am I following existing patterns?

Work through each step explicitly before implementing.
```

#### 4.2 Task Body

```markdown
<task>
{Task description from $ARGUMENTS}
</task>

<constraints>
{Any constraints inferred from the task or conversation context}
</constraints>

<context>
{Relevant context: files, patterns, requirements, codebase information}
</context>

<output>
{Expected deliverable: format, location, structure}
</output>
```

#### 4.3 Self-Critique Suffix (REQUIRED - MUST BE LAST)

```markdown
## Self-Critique Loop (MANDATORY)

Before completing, you MUST verify your work. Submitting unverified work is UNACCEPTABLE.

### 1. Generate 5 Verification Questions

Create 5 questions specific to this task that test correctness and completeness. There example questions:

| # | Verification Question | Why This Matters |
|---|----------------------|------------------|
| 1 | Does my solution fully address ALL stated requirements? | Partial solutions = failed task |
| 2 | Have I verified every assumption against available evidence? | Unverified assumptions = potential failures |
| 3 | Are there edge cases or error scenarios I haven't handled? | Edge cases cause production issues |
| 4 | Does my solution follow existing patterns in the codebase? | Pattern violations create maintenance debt |
| 5 | Is my solution clear enough for someone else to understand and use? | Unclear output reduces value |

### 2. Answer Each Question with Evidence

For each question, examine your solution and provide specific evidence:

[Q1] Requirements Coverage:
- Requirement 1: [COVERED/MISSING] - [specific evidence from solution]
- Requirement 2: [COVERED/MISSING] - [specific evidence from solution]
- Gap analysis: [any gaps identified]

[Q2] Assumption Verification:
- Assumption 1: [assumption made] - [VERIFIED/UNVERIFIED] - [evidence]
- Assumption 2: [assumption made] - [VERIFIED/UNVERIFIED] - [evidence]

[Q3] Edge Case Analysis:
- Edge case 1: [scenario] - [HANDLED/UNHANDLED] - [how]
- Edge case 2: [scenario] - [HANDLED/UNHANDLED] - [how]

[Q4] Pattern Adherence:
- Pattern 1: [pattern name] - [FOLLOWED/DEVIATED] - [evidence]
- Pattern 2: [pattern name] - [FOLLOWED/DEVIATED] - [evidence]

[Q5] Clarity Assessment:
- Is the solution well-organized? [YES/NO]
- Are complex parts explained? [YES/NO]
- Could someone else use this immediately? [YES/NO]

### 3. Revise If Needed

If ANY verification question reveals a gap:
1. **STOP** - Do not submit incomplete work
2. **FIX** - Address the specific gap identified
3. **RE-VERIFY** - Confirm the fix resolves the issue
4. **DOCUMENT** - Note what was changed and why

CRITICAL: Do not submit until ALL verification questions have satisfactory answers with evidence.
```

### Phase 5: Dispatch Sub-Agent

Use the Task tool to dispatch with the selected configuration:

```
Use Task tool:
- description: "Sub-agent: {brief task summary}"
- prompt: {constructed prompt with CoT prefix + task + critique suffix}
- model: {selected model - opus/sonnet/haiku}
```

**Context isolation reminder:** Pass only context relevant to this specific task. Do not pass entire conversation history.

## Examples

### Example 1: Complex Architecture Task (Opus)

**Input:** `/launch-sub-agent Design a caching strategy for our API that handles 10k requests/second`

**Analysis:**

- Task type: Architecture / design
- Complexity: High (performance requirements, system design)
- Output size: Medium (design document)
- Domain match: sdd:software-architect

**Selection:** Opus + sdd:software-architect agent

**Dispatch:** Task tool with Opus model, sdd:software-architect prompt, CoT prefix, critique suffix


### Example 3: Moderate Implementation (Sonnet + Developer)

**Input:** `/launch-sub-agent Implement pagination for /users endpoint following patterns in /products`

**Analysis:**

- Task type: Code implementation
- Complexity: Medium (follow existing patterns)
- Output size: Medium (implementation + tests)
- Domain match: sdd:developer

**Selection:** Sonnet + sdd:developer agent (non-complex but needs domain expertise)

**Dispatch:** Task tool with Sonnet model, sdd:developer prompt, CoT prefix, critique suffix


---

