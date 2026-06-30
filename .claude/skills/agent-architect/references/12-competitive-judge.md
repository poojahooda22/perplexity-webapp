# Multi-Agent Evaluation — Competitive, Judge & Tree-of-Thoughts Patterns

> Consolidated from sadd-do-competitively, sadd-do-and-judge, sadd-judge, sadd-judge-with-debate, sadd-tree-of-thoughts.
> Every line preserved verbatim per zero-value-loss protocol.

---

## Source: sadd-do-competitively


# do-competitively

<task>
Execute tasks through competitive multi-agent generation, multi-judge evaluation, and evidence-based synthesis to produce superior results by combining the best elements from parallel implementations.
</task>

<context>
This command implements the Generate-Critique-Synthesize (GCS) pattern with adaptive strategy selection for high-stakes tasks where quality matters more than speed. It combines competitive generation with multi-perspective evaluation and intelligently selects the optimal synthesis strategy based on results.

**Key features:**

- Self-critique loops in generation (Constitutional AI)
- Verification loops in evaluation (Chain-of-Verification)
- Adaptive strategy: polish clear winners, synthesize split decisions, redesign failures
- Average 15-20% cost savings through intelligent strategy selection
</context>

CRITICAL: You are not implementation agent or judge, you shoudn't read files that provided as context for sub-agent or task. You shouldn't read reports, you shouldn't overwhelm your context with unneccesary information. You MUST follow process step by step. Any diviations will be considered as failure and you will be killed!

## Pattern: Generate-Critique-Synthesize (GCS)

This command implements a four-phase adaptive competitive orchestration pattern:

```
Phase 1: Competitive Generation with Self-Critique
         ┌─ Agent 1 → Draft → Critique → Revise → Solution A ─┐
Task ───┼─ Agent 2 → Draft → Critique → Revise → Solution B ─┼─┐
         └─ Agent 3 → Draft → Critique → Revise → Solution C ─┘ │
                                                                  │
Phase 2: Multi-Judge Evaluation with Verification                │
         ┌─ Judge 1 → Evaluate → Verify → Revise → Report A ─┐  │
         ├─ Judge 2 → Evaluate → Verify → Revise → Report B ─┼──┤
         └─ Judge 3 → Evaluate → Verify → Revise → Report C ─┘  │
                                                                  │
Phase 2.5: Adaptive Strategy Selection                           │
         Analyze Consensus ──────────────────────────────────────┤
                ├─ Clear Winner? → SELECT_AND_POLISH             │
                ├─ All Flawed (<3.0)? → REDESIGN (return Phase 1)│
                └─ Split Decision? → FULL_SYNTHESIS              │
                                          │                       │
Phase 3: Evidence-Based Synthesis        │                       │
         (Only if FULL_SYNTHESIS)         │                       │
         Synthesizer ─────────────────────┴───────────────────────┴─→ Final Solution
```

## Process

### Setup: Create Reports Directory

Before starting, ensure the reports directory exists:

```bash
mkdir -p .specs/reports
```

**Report naming convention:** `.specs/reports/{solution-name}-{YYYY-MM-DD}.[1|2|3].md`

Where:

- `{solution-name}` - Derived from output path (e.g., `users-api` from output `specs/api/users.md`)
- `{YYYY-MM-DD}` - Current date
- `[1|2|3]` - Judge number

**Note:** Solutions remain in their specified output locations; only evaluation reports go to `.specs/reports/`

### Phase 1: Competitive Generation

Launch **3 independent agents in parallel** (recommended: Opus for quality):

1. Each agent receives **identical task description and context**
2. Agents work **independently without seeing each other's work**
3. Each produces a **complete solution** to the same problem
4. Solutions are saved to distinct files (e.g., `{solution-file}.[a|b|c].[ext]`)

**Solution naming convention:** `{solution-file}.[a|b|c].[ext]`
Where:

- `{solution-file}` - Derived from task (e.g., `create users.ts` result in `users` as solution file)
- `[a|b|c]` - Unique identifier per sub-agent
- `[ext]` - File extension (e.g., `md`, `ts` and etc.)

**Key principle:** Diversity through independence - agents explore different approaches.

CRITICAL: You MUST provide filename with [a|b|c] identifier to agents and judges!!! Missing it, will result in your TERMINATION imidiatly!

**Prompt template for generators:**

```markdown
<task>
{task_description}
</task>

<constraints>
{constraints_if_any}
</constraints>

<context>
{relevant_context}
</context>

<output>
{define expected output following such pattern: {solution-file}.[a|b|c].[ext] based on the task description and context. Each [a|b|c] is a unique identifier per sub-agent. You MUST provide filename with it!!!}
</output>

Instructions:
Let's approach this systematically to produce the best possible solution.

1. First, analyze the task carefully - what is being asked and what are the key requirements?
2. Consider multiple approaches - what are the different ways to solve this?
3. Think through the tradeoffs step by step and choose the approach you believe is best
4. Implement it completely
5. Generate 5 verification questions about critical aspects
6. Answer your own questions:
   - Review solution against each question
   - Identify gaps or weaknesses
7. Revise solution:
   - Fix identified issues
8. Explain what was changed and why
```

### Phase 2: Multi-Judge Evaluation

Launch **3 independent judges in parallel** (recommended: Opus for rigor):

1. Each judge receives path to **ALL candidate solutions** (A, B, C)
2. Judges evaluate against **clear criteria** (correctness, design quality, maintainability, etc.)
3. Each judge produces:
   - **Comparative analysis** (which solution excels where)
   - **Evidence-based ratings** (with specific quotes/examples)
   - **Final vote** (which solution they prefer and why)
4. Reports saved to distinct files (e.g., `.specs/reports/{solution-name}-{date}.[1|2|3].md`)

**Key principle:** Multiple independent evaluations reduce bias and catch different issues.

**Prompt template for judges:**

```markdown
You are evaluating {number} solutions to this task:

<task>
{task_description}
</task>

<solutions>
{list of paths to all candidate solutions}
</solutions>

<output>
Write full report to: {.specs/reports/{solution-name}-{date}.[1|2|3].md - each judge gets unique number identifier}

CRITICAL: You must reply with this exact structured header format:


[Summary of your evaluation]
</output>

Evaluation criteria (with weights):
1. {criterion_1} ({weight_1}%)
2. {criterion_2} ({weight_2}%)
...

Read ${CLAUDE_PLUGIN_ROOT}/tasks/judge.md for evaluation methodology and execute using following criteria.

Instructions:
1. For each criterion, analyze ALL solutions
2. Write a combined report:
   1. Provide specific evidence (quote exact text) for your assessments
   2. Compare strengths and weaknesses
   3. Score each solution on each criterion
   4. Calculate weighted total scores
3. Generate verification 5 questions about your evaluation.
4. Answer verification questions:
   - Re-examine solutions for each question
   - Find counter-evidence if it exists
   - Check for systematic bias (length, confidence, etc.)
5. Revise your evaluation and update it accordingly.
6. Reply structured output:
   - VOTE: Which solution you recommend
   - SCORES: Weighted total score for each solution (0.0-5.0)

CRITICAL: Base your evaluation on evidence, not impressions. Quote specific text.

Final checklist:
- [ ] Generated and answered all verification questions
- [ ] Found and corrected all potential issues
- [ ] Checked for known biases (length, verbosity, confidence)
- [ ] Confident in revised evaluation
- [ ] Structured header with VOTE and SCORES at top of report
```

### Phase 2.5: Adaptive Strategy Selection (Early Return)

**The orchestrator** (not a subagent) analyzes judge outputs to determine the optimal strategy.

#### Decision Logic

**Step 1: Parse structured headers from judge reply**

Parse the judges reply.
CRITICAL: Do not read reports files itself, it can overflow your context.

**Step 2: Check for unanimous winner**

Compare all three VOTE values:

- If Judge 1 VOTE = Judge 2 VOTE = Judge 3 VOTE (same solution):
  - **Strategy: SELECT_AND_POLISH**
  - **Reason:** Clear consensus - all three judges prefer same solution

**Step 3: Check if all solutions are fundamentally flawed**

If no unanimous vote, calculate average scores:

1. Average Solution A scores: (Judge1_A + Judge2_A + Judge3_A) / 3
2. Average Solution B scores: (Judge1_B + Judge2_B + Judge3_B) / 3
3. Average Solution C scores: (Judge1_C + Judge2_C + Judge3_C) / 3

If (avg_A < 3.0) AND (avg_B < 3.0) AND (avg_C < 3.0):

- **Strategy: REDESIGN**
- **Reason:** All solutions below quality threshold, fundamental approach issues

**Step 5: Default to full synthesis**

If none of the above conditions met:

- **Strategy: FULL_SYNTHESIS**
- **Reason:** Split decision with merit, synthesis needed to combine best elements

#### Strategy 1: SELECT_AND_POLISH

**When:** Clear winner (unanimous votes)

**Process:**

1. Select the winning solution as the base
2. Launch subagent to apply specific improvements from judge feedback
3. Cherry-pick 1-2 best elements from runner-up solutions
4. Document what was added and why

**Benefits:**

- Saves synthesis cost (simpler than full synthesis)
- Preserves proven quality of winning solution
- Focused improvements rather than full reconstruction

**Prompt template:**

```markdown
You are polishing the winning solution based on judge feedback.

<task>
{task_description}
</task>

<winning_solution>
{path_to_winning_solution}
Score: {winning_score}/5.0
Judge consensus: {why_it_won}
</winning_solution>

<runner_up_solutions>
{list of paths to all runner-up solutions}
</runner_up_solutions>

<judge_feedback>
{list of paths to all evaluation reports}
</judge_feedback>

<output>
{final_solution_path}
</output>

Instructions:
Let's work through this step by step to polish the winning solution effectively.

1. Take the winning solution as your base (do NOT rewrite it)
2. First, carefully review all judge feedback to understand what needs improvement
3. Apply improvements based on judge feedback:
   - Fix identified weaknesses
   - Add missing elements judges noted
4. Next, examine the runner-up solutions for standout elements
5. Cherry-pick 1-2 specific elements from runners-up if judges praised them
6. Document changes made:
   - What was changed and why
   - What was added from other solutions

CRITICAL: Preserve the winning solution's core approach. Make targeted improvements only.
```

#### Strategy 2: REDESIGN

**When:** All solutions scored <3.0/5.0 (fundamental issues across the board)

**Process:**

1. Launch new agent to analyze the failure modes and lessons learned. Ask the agent to:
   - Think through step by step: what went wrong with each solution?
   - Analyze common failure modes across all solutions
   - Extract lessons learned (what NOT to do)
   - Identify the root causes of why all approaches failed
   - Generate new task decomposition or constraints based on these insights
2. **Return to Phase 1**, provide to new implementation agents the lessons learned and new constraints.

**Prompt template for new implementation:**

```markdown
You are analyzing why all solutions failed to meet quality standards. And implement new solution based on it.

<task>
{task_description}
</task>

<constraints>
{constraints_if_any}
</constraints>

<context>
{relevant_context}
</context>

<failed_solutions>
{list of paths to all candidate solutions}
</failed_solutions>

<evaluation_reports>
{list of paths to all evaluation reports with low scores}
</evaluation_reports>

Instructions:
Let's break this down systematically to understand what went wrong and how to design new solution based on it.

1. First, analyze the task carefully - what is being asked and what are the key requirements?
2. Read through each solution and its evaluation report
3. For each solution, think step by step about:
   - What was the core approach?
   - What specific issues did judges identify?
   - Why did this approach fail to meet the quality threshold?
4. Identify common failure patterns across all solutions:
   - Are there shared misconceptions?
   - Are there missing requirements that all solutions overlooked?
   - Are there fundamental constraints that weren't considered?
5. Extract lessons learned:
   - What approaches should be avoided?
   - What constraints must be addressed?
6. Generate improved guidance for the next iteration:
   - New constraints to add
   - Specific approaches to try - what are the different ways to solve this?
   - Key requirements to emphasize
7. Think through the tradeoffs step by step and choose the approach you believe is best
8. Implement it completely
9. Generate 5 verification questions about critical aspects
10. Answer your own questions:
   - Review solution against each question
   - Identify gaps or weaknesses
11. Revise solution:
   - Fix identified issues
12. Explain what was changed and why

```

#### Strategy 3: FULL_SYNTHESIS (Default)

**When:** No clear winner AND solutions have merit (scores ≥3.0)

**Process:** Proceed to Phase 3 (Evidence-Based Synthesis)

### Phase 3: Evidence-Based Synthesis

**Only executed when Strategy 3 (FULL_SYNTHESIS) selected in Phase 2.5**

Launch **1 synthesis agent** (recommended: Opus for quality):

1. Agent receives:
   - **All candidate solutions** (A, B, C)
   - **All evaluation reports** (1, 2, 3)
2. Agent analyzes:
   - Which elements each judge praised (consensus on strengths)
   - Which issues each judge identified (consensus on weaknesses)
   - Where solutions differed in approach
3. Agent produces **final solution** by:
   - **Copying superior sections** when one solution clearly wins
   - **Combining approaches** when hybrid is better
   - **Fixing identified issues** that all judges caught
   - **Documenting decisions** (what was taken from where and why)

**Key principle:** Evidence-based synthesis leverages collective intelligence.

**Prompt template for synthesizer:**

```markdown
You are synthesizing the best solution from competitive implementations and evaluations.

<task>
{task_description}
</task>

<solutions>
{list of paths to all candidate solutions}
</solutions>

<evaluation_reports>
{list of paths to all evaluation reports}
</evaluation_reports>

<output>
{define expected output following such pattern: solution.md based on the task description and context. Result should be a complete solution to the task.}
</output>

Instructions:
Let's think through this synthesis step by step to create the best possible combined solution.

1. First, read all solutions and evaluation reports carefully
2. Map out the consensus:
   - What strengths did multiple judges praise in each solution?
   - What weaknesses did multiple judges criticize in each solution?
3. For each major component or section, think through:
   - Which solution handles this best and why?
   - Could a hybrid approach work better?
4. Create the best possible solution by:
   - Copying text directly when one solution is clearly superior
   - Combining approaches when a hybrid would be better
   - Fixing all identified issues
   - Preserving the best elements from each
5. Explain your synthesis decisions:
   - What you took from each solution
   - Why you made those choices
   - How you addressed identified weaknesses

CRITICAL: Do not create something entirely new. Synthesize the best from what exists.
```

<output>
The command produces different outputs depending on the adaptive strategy selected:

### Outputs (All Strategies)

1. **Candidate solutions:** `{solution-file}.[a|b|c].[ext]` (in specified output location)
2. **Evaluation reports:** `.specs/reports/{solution-name}-{date}.[1|2|3].md`
3. **Resulting solution:** `{output_path}`

### Strategy-Specific Outputs

- SELECT_AND_POLISH: Polished solution based on winning solution
- REDESIGN: Do not stop, return to phase 1 and eventiualy should result in finish at SELECT_AND_POLISH or FULL_SYNTHESIS strategies
- FULL_SYNTHESIS: Synthesized solution combined best from all

### Orcestrator Reply

Once command execution is complete, reply to user with following structure:

```markdown
## Execution Summary

Original Task: {task_description}

Strategy Used: {strategy} ({reason})

### Results

| Phase                   | Agents | Models   | Status      |
|-------------------------|--------|----------|-------------|
| Phase [N]: [phase name] | [N]    | [model] × 3 | [✅ Complete / ❌ Failed] |

Files Created

Final Solution:
- {output_path} - Synthesized production-ready command

Candidate Solutions:
- {solution-file}.[a|b|c].[ext] (Score: [X.X]/5.0)

Evaluation Reports:
- .specs/reports/{solution-file}-{date}.[1|2|3].md (Vote: [Solution A/B/C])

Synthesis Decisions

| Element              | Source           | Rationale   |
|----------------------|------------------|-------------|
| [element]            | Solution [B/A/C] | [rationale] |

```

</output>

## Best Practices

### Evaluation Criteria

Choose 3-5 weighted criteria relevant to the task:

**Code tasks:**

- Correctness (30%)
- Design quality (25%)
- Maintainability (20%)
- Performance (15%)
- Clarity (10%)

**Design tasks:**

- Completeness (30%)
- Feasibility (25%)
- Scalability (20%)
- Simplicity (15%)
- Clarity (10%)

**Documentation tasks:**

- Completeness (35%)
- Accuracy (30%)
- Clarity (20%)
- Usability (15%)

### Common Pitfalls

❌ **Using for trivial tasks** - Overhead not justified
❌ **Vague task descriptions** - Leads to incomparable solutions
❌ **Insufficient context** - Agents can't produce quality work
❌ **Weak evaluation criteria** - Judges can't differentiate quality
❌ **Forcing synthesis when clear winner exists** - Wastes cost and risks degrading quality
❌ **Synthesizing fundamentally flawed solutions** - Better to redesign than polish garbage

✅ **Well-defined task with clear constraints**
✅ **Rich context for informed decisions**
✅ **Specific, measurable evaluation criteria**
✅ **Trust adaptive strategy selection**
✅ **Polish clear winners, synthesize split decisions, redesign failures**

## Examples

### Example 1: API Design (Clear Winner - SELECT_AND_POLISH)

```bash
/do-competitively "Design REST API for user management (CRUD + auth)" \
  --output "specs/api/users.md" \
  --criteria "RESTfulness,security,scalability,developer-experience"
```

**Phase 1 outputs:**

- `specs/api/users.a.md` - Resource-based design with nested routes
- `specs/api/users.b.md` - Action-based design with RPC-style endpoints
- `specs/api/users.c.md` - Minimal design, missing auth consideration

**Phase 2 outputs** (assuming date 2025-01-15):

- `.specs/reports/users-api-2025-01-15.1.md`:

  ```
  VOTE: Solution A
  SCORES: A=4.5/5.0, B=3.2/5.0, C=2.8/5.0
  ```

  "Most RESTful, good security"

- `.specs/reports/users-api-2025-01-15.2.md`:

  ```
  VOTE: Solution A
  SCORES: A=4.3/5.0, B=3.5/5.0, C=2.6/5.0
  ```

  "Clean resource design, scalable"

- `.specs/reports/users-api-2025-01-15.3.md`:

  ```
  VOTE: Solution A
  SCORES: A=4.6/5.0, B=3.0/5.0, C=2.9/5.0
  ```

  "Best practices, clear structure"

**Phase 2.5 decision (orchestrator parses headers):**

- Unanimous vote: A, A, A
- Average scores: A=4.5, B=3.2, C=2.8
- Strategy: SELECT_AND_POLISH
- Reason: Unanimous winner with >1.0 point gap

**Phase 3 output:**

- `specs/api/users.md` - Solution A polished with:
  - Added rate limiting documentation (from B)
  - Simplified nested routes (judge feedback)
  - Total cost: 6 agents (saved 1 from full synthesis)

### Example 2: Algorithm Selection (Split Decision - FULL_SYNTHESIS)

```bash
/do-competitively "Design caching strategy for high-traffic API" \
  --output "specs/caching.md" \
  --criteria "performance,memory-efficiency,simplicity,reliability"
```

**Phase 1 outputs:**

- `specs/caching.a.md` - Redis with LRU eviction
- `specs/caching.b.md` - Multi-tier cache (memory + Redis)
- `specs/caching.c.md` - CDN + application cache

**Phase 2 outputs** (assuming date 2025-01-15):

- `.specs/reports/caching-2025-01-15.1.md`:

  ```
  VOTE: Solution B
  SCORES: A=3.8/5.0, B=4.2/5.0, C=3.9/5.0
  ```

  "Best performance, complex"

- `.specs/reports/caching-2025-01-15.2.md`:

  ```
  VOTE: Solution A
  SCORES: A=4.0/5.0, B=3.9/5.0, C=3.7/5.0
  ```

  "Simple, reliable, proven"

- `.specs/reports/caching-2025-01-15.3.md`:

  ```
  VOTE: Solution C
  SCORES: A=3.6/5.0, B=4.0/5.0, C=4.1/5.0
  ```

  "Global reach, cost-effective"

**Phase 2.5 decision (orchestrator parses headers):**

- Split votes: B, A, C (no consensus)
- Average scores: A=3.8, B=4.0, C=3.9
- Score gap: 4.0 - 3.9 = 0.1 (<1.0 threshold)
- Strategy: FULL_SYNTHESIS
- Reason: Split decision, all solutions ≥3.0, no clear winner

**Phase 3 output:**

- `specs/caching.md` - Hybrid approach:
  - Multi-tier architecture (from B)
  - Simple LRU policy (from A)
  - CDN for static content (from C)
  - Total cost: 7 agents (full synthesis needed)

### Example 3: Authentication Design (All Flawed - REDESIGN)

```bash
/do-competitively "Design authentication system with social login" \
  --output "specs/auth.md" \
  --criteria "security,user-experience,maintainability"
```

**Phase 1 outputs:**

- `specs/auth.a.md` - Custom OAuth2 implementation
- `specs/auth.b.md` - Session-based with social providers
- `specs/auth.c.md` - JWT with password-only auth

**Phase 2 outputs** (assuming date 2025-01-15):

- `.specs/reports/auth-2025-01-15.1.md`:

  ```
  VOTE: Solution A
  SCORES: A=2.5/5.0, B=2.2/5.0, C=2.3/5.0
  ```

  "Security risks, reinventing wheel"

- `.specs/reports/auth-2025-01-15.2.md`:

  ```
  VOTE: Solution B
  SCORES: A=2.4/5.0, B=2.8/5.0, C=2.1/5.0
  ```

  "Sessions don't scale, missing requirements"

- `.specs/reports/auth-2025-01-15.3.md`:

  ```
  VOTE: Solution C
  SCORES: A=2.6/5.0, B=2.5/5.0, C=2.3/5.0
  ```

  "No social login, security concerns"

**Phase 2.5 decision (orchestrator parses headers):**

- Split votes: A, B, C (no consensus)
- Average scores: A=2.5, B=2.5, C=2.2 (ALL <3.0)
- Strategy: REDESIGN
- Reason: All solutions below 3.0 threshold, fundamental issues

- Do not stop, return to phase 1 and eventiualy should result in finish at SELECT_AND_POLISH or FULL_SYNTHESIS strategies

---

## Source: sadd-do-and-judge


# do-and-judge

<task>
Execute a single task by dispatching an implementation sub-agent, verifying with an independent judge, and iterating with feedback until passing or max retries exceeded.
</task>

<context>
This command implements a **single-task execution pattern** with **LLM-as-a-judge verification**. You (the orchestrator) dispatch a focused sub-agent to implement the task, then dispatch an independent judge to verify quality. If verification fails, you iterate with judge feedback until passing (score ≥4) or max retries (2) exceeded.

Key benefits:

- **Fresh context** - Implementation agent works with clean context window
- **External verification** - Judge catches blind spots self-critique misses
- **Feedback loop** - Retry with specific issues identified by judge
- **Quality gate** - Work doesn't ship until it meets threshold
</context>

CRITICAL: You are the orchestrator - you MUST NOT perform the task yourself. Your role is to:

1. Analyze the task and select optimal model
2. Dispatch implementation sub-agent with structured prompt
3. Dispatch judge sub-agent to verify
4. Parse verdict and iterate if needed (max 2 retries)
5. Report final results or escalate

## RED FLAGS - Never Do These

**NEVER:**

- Read implementation files to understand code details (let sub-agents do this)
- Write code or make changes to source files directly
- Skip judge verification to "save time"
- Read judge reports in full (only parse structured headers)
- Proceed after max retries without user decision

**ALWAYS:**

- Use Task tool to dispatch sub-agents for ALL implementation work
- Use Task tool to dispatch independent judges for verification
- Wait for implementation to complete before dispatching judge
- Parse only VERDICT/SCORE/ISSUES from judge output
- Iterate with feedback if verification fails

## Process

### Phase 1: Task Analysis and Model Selection

Analyze the task to select the optimal model:

```
Let me analyze this task to determine the optimal configuration:

1. **Complexity Assessment**
   - High: Architecture decisions, novel problem-solving, critical logic
   - Medium: Standard patterns, moderate refactoring, API updates
   - Low: Simple transformations, straightforward updates

2. **Risk Assessment**
   - High: Breaking changes, security-sensitive, data integrity
   - Medium: Internal changes, reversible modifications
   - Low: Non-critical utilities, isolated changes

3. **Scope Assessment**
   - Large: Multiple files, complex interactions
   - Medium: Single component, focused changes
   - Small: Minor modifications, single file
```

**Model Selection Guide:**

| Model | When to Use | Examples |
|-------|-------------|----------|
| `opus` | **Default/standard choice**. Safe for any task. Use when correctness matters, decisions are nuanced, or you're unsure. | Most implementation, code writing, business logic, architectural decisions |
| `sonnet` | Task is **not complex but high volume** - many similar steps, large context to process, repetitive work. | Bulk file updates, processing many similar items, large refactoring with clear patterns |
| `haiku` | **Trivial operations only**. Simple, mechanical tasks with no decision-making. | Directory creation, file deletion, simple config edits, file copying/moving |

**Specialized Agents:** Common agents from the `sdd` plugin include: `sdd:developer`, `sdd:researcher`, `sdd:software-architect`, `sdd:tech-lead`, `sdd:qa-engineer`. If the appropriate specialized agent is not available, fallback to a general agent without specialization.

### Phase 2: Dispatch Implementation Agent

Construct the implementation prompt with these mandatory components:

#### 2.1 Zero-shot Chain-of-Thought Prefix (REQUIRED - MUST BE FIRST)

```markdown
## Reasoning Approach

Before taking any action, think through this task systematically.

Let's approach this step by step:

1. "Let me understand what this task requires..."
   - What is the specific objective?
   - What constraints exist?
   - What is the expected outcome?

2. "Let me explore the relevant code..."
   - What files are involved?
   - What patterns exist in the codebase?
   - What dependencies need consideration?

3. "Let me plan my approach..."
   - What specific modifications are needed?
   - What order should I make them?
   - What could go wrong?

4. "Let me verify my approach before implementing..."
   - Does my plan achieve the objective?
   - Am I following existing patterns?
   - Is there a simpler way?

Work through each step explicitly before implementing.
```

#### 2.2 Task Body

```markdown
## Task
{Task description from user}

## Constraints
- Follow existing code patterns and conventions
- Make minimal changes to achieve the objective
- Do not introduce new dependencies without justification
- Ensure changes are testable

## Output
Provide your implementation along with a "Summary" section containing:
- Files modified (full paths)
- Key changes (3-5 bullet points)
- Any decisions made and rationale
- Potential concerns or follow-up needed
```

#### 2.3 Self-Critique Suffix (REQUIRED - MUST BE LAST)

```markdown
## Self-Critique Verification (MANDATORY)

Before completing, verify your work. Do not submit unverified changes.

### Verification Questions

| # | Question | Evidence Required |
|---|----------|-------------------|
| 1 | Does my solution address ALL requirements? | [Specific evidence] |
| 2 | Did I follow existing code patterns? | [Pattern examples] |
| 3 | Are there any edge cases I missed? | [Edge case analysis] |
| 4 | Is my solution the simplest approach? | [Alternatives considered] |
| 5 | Would this pass code review? | [Quality check] |

### Answer Each Question with Evidence

Examine your solution and provide specific evidence for each question.

### Revise If Needed

If ANY verification question reveals a gap:
1. **FIX** - Address the specific gap identified
2. **RE-VERIFY** - Confirm the fix resolves the issue
3. **UPDATE** - Update the Summary section

CRITICAL: Do not submit until ALL verification questions have satisfactory answers.
```

#### 2.4 Dispatch

```
Use Task tool:
  - description: "Implement: {brief task summary}"
  - prompt: {constructed prompt with CoT + task + self-critique}
  - model: {selected model}
  - subagent_type: "sdd:developer"
```

### Phase 3: Dispatch Judge Agent

After implementation completes, dispatch an independent judge.

**Judge prompt template:**

```markdown
You are verifying completion of a task.

## Task Requirements
{Original task description from user}

## Implementation Output
{Summary section from implementation agent}
{Paths to files modified}

## Evaluation Criteria
1. **Correctness** (35%) - Does the implementation meet requirements?
2. **Quality** (25%) - Is the code well-structured and maintainable?
3. **Completeness** (25%) - Are all required elements present?
4. **Patterns** (15%) - Does it follow existing codebase conventions?

## Output
CRITICAL: You must reply with this exact structured header format:


[Detailed evaluation follows]

## Instructions
1. Read the implementation files
2. Verify each requirement was met with specific evidence
3. Identify any gaps, issues, or missing elements
4. Score each criterion and calculate weighted total

CRITICAL: List specific issues that must be fixed for retry.

## Scoring Scale

**DEFAULT SCORE IS 2. You must justify ANY deviation upward.**

| Score | Meaning | Evidence Required | Your Attitude |
|-------|---------|-------------------|---------------|
| 1 | Unacceptable | Clear failures, missing requirements | Easy call |
| 2 | Below Average | Multiple issues, partially meets requirements | Common result |
| 3 | Adequate | Meets basic requirements, minor issues | Need proof that it meets basic requirements |
| 4 | Good | Meets ALL requirements, very few minor issues | Prove it deserves this |
| 5 | Excellent | Exceeds requirements, genuinely exemplary | **Extremely rare** - requires exceptional evidence |

### Score Distribution Reality Check

- **Score 5**: Should be given in <5% of evaluations. If you're giving more 5s, you're too lenient.
- **Score 4**: Reserved for genuinely solid work. Not "pretty good" - actually good.
- **Score 3**: This is where refined work lands. Not average.
- **Score 2**: Common for first attempts. Don't be afraid to use it.
- **Score 1**: Reserved for fundamental failures. But don't avoid it when deserved.

```

**Dispatch:**

```
Use Task tool:
  - description: "Judge: {brief task summary}"
  - prompt: {judge verification prompt}
  - model: {same as implementation or sonnet}
  - subagent_type: "general-purpose"
```

### Phase 4: Parse Verdict and Iterate

Parse judge output (DO NOT read full report):

```
Extract from judge reply:
- VERDICT: PASS or FAIL
- SCORE: X.X/5.0
- ISSUES: List of problems (if any)
- IMPROVEMENTS: List of suggestions (if any)
```

**Decision logic:**

```
If score ≥4:
  → VERDICT: PASS
  → Report success with summary
  → Include IMPROVEMENTS as optional enhancements

If score <4:
  → VERDICT: FAIL
  → Check retry count

  If retries < 2:
    → Dispatch retry implementation agent with judge feedback
    → Return to Phase 3 (judge verification)

  If retries ≥ 2:
    → Escalate to user (see Error Handling)
    → Do NOT proceed without user decision
```

### Phase 5: Retry with Feedback (If Needed)

**Retry prompt template:**

```markdown
## Retry Required

Your previous implementation did not pass judge verification.

## Original Task
{Original task description}

## Judge Feedback
VERDICT: FAIL
SCORE: {score}/5.0
ISSUES:
{list of issues from judge}

## Your Previous Changes
{files modified in previous attempt}

## Instructions
Let's fix the identified issues step by step.

1. Review each issue the judge identified
2. For each issue, determine the root cause
3. Plan the fix for each issue
4. Implement ALL fixes
5. Verify your fixes address each issue
6. Provide updated Summary section

CRITICAL: Focus on fixing the specific issues identified. Do not rewrite everything.
```

### Phase 6: Final Report

After task passes verification:

```markdown
## Execution Summary

**Task:** {original task description}
**Result:** ✅ PASS

### Verification
| Attempt | Score | Status |
|---------|-------|--------|
| 1 | {X.X}/5.0 | {PASS/FAIL} |
| 2 | {X.X}/5.0 | {PASS/FAIL} | (if retry occurred)

### Files Modified
- {file1}: {what changed}
- {file2}: {what changed}

### Key Changes
- {change 1}
- {change 2}

### Suggested Improvements (Optional)
{IMPROVEMENTS from judge, if any}
```

## Error Handling

### If Max Retries Exceeded

When task fails verification twice:

1. **STOP** - Do not proceed
2. **Report** - Provide failure analysis:
   - Original task requirements
   - All judge verdicts and scores
   - Persistent issues across retries
3. **Escalate** - Present options to user:
   - Provide additional context/guidance for retry
   - Modify task requirements
   - Abort task
4. **Wait** - Do NOT proceed without user decision

**Escalation Report Format:**

```markdown
## Task Failed Verification (Max Retries Exceeded)

### Task Requirements
{original task description}

### Verification History
| Attempt | Score | Key Issues |
|---------|-------|------------|
| 1 | {X.X}/5.0 | {issues} |
| 2 | {X.X}/5.0 | {issues} |
| 3 | {X.X}/5.0 | {issues} |

### Persistent Issues
{Issues that appeared in multiple attempts}

### Options
1. **Provide guidance** - Give additional context for another retry
2. **Modify requirements** - Simplify or clarify task
3. **Abort** - Stop execution

Awaiting your decision...
```

## Examples

### Example 1: Simple Refactoring (Pass on First Try)

**Input:**

```
/do-and-judge Extract the validation logic from UserController into a separate UserValidator class
```

**Execution:**

```
Phase 1: Task Analysis
  → Model: Opus

Phase 2: Dispatch Implementation
  Implementation (Opus + sdd:developer)...
    → Created UserValidator.ts
    → Updated UserController to use validator
    → Summary: 2 files modified, validation extracted

Phase 3: Dispatch Judge
  Judge Verification (Opus)...
    → VERDICT: PASS, SCORE: 4.2/5.0
    → ISSUES: None
    → IMPROVEMENTS: Add input validation for edge cases

Phase 6: Final Report
  ✅ PASS on attempt 1
  Files: UserValidator.ts (new), UserController.ts (modified)
```

### Example 2: Complex Task (Pass After Retry)

**Input:**

```
/do-and-judge Implement rate limiting middleware with configurable limits per endpoint
```

**Execution:**

```
Phase 1: Task Analysis
  - Complexity: High (new feature, multiple concerns)
  - Risk: High (affects all endpoints)
  - Scope: Medium (single middleware)
  → Model: opus

Phase 2: Dispatch Implementation (Attempt 1)
  Implementation (Opus + sdd:developer)...
    → Created RateLimiter middleware
    → Added configuration schema

Phase 3: Dispatch Judge
  Judge Verification (Opus)...
    → VERDICT: FAIL, SCORE: 3.1/5.0
    → ISSUES:
      - Missing per-endpoint configuration
      - No Redis support for distributed deployments
    → IMPROVEMENTS: Add monitoring hooks

Phase 5: Retry with Feedback
  Implementation (Opus + sdd:developer)...
    → Added endpoint-specific limits
    → Added Redis adapter option

Phase 3: Dispatch Judge (Attempt 2)
  Judge Verification (Opus)...
    → VERDICT: PASS, SCORE: 4.4/5.0
    → IMPROVEMENTS: Add metrics export

Phase 6: Final Report
  ✅ PASS on attempt 2
  Files: RateLimiter.ts, config/rateLimits.ts, adapters/RedisAdapter.ts
```

### Example 3: Task Requiring Escalation

**Input:**

```
/do-and-judge Migrate the database schema to support multi-tenancy
```

**Execution:**

```
Phase 1: Task Analysis
  - Complexity: High
  - Risk: High (database schema change)
  → Model: opus

Attempt 1: FAIL (2.8/5.0) - Missing tenant isolation in queries
Attempt 2: FAIL (3.2/5.0) - Incomplete migration script
Attempt 3: FAIL (3.3/5.0) - Edge cases in existing data migration

ESCALATION:
  Persistent issue: Existing data migration requires business decisions
  about how to handle orphaned records.

  Options presented to user:
  1. Provide guidance on orphan handling
  2. Simplify to new tenants only
  3. Abort

User chose: Option 1 - "Delete orphaned records older than 1 year"

Attempt 4 (with guidance): PASS (4.1/5.0)
```

## Best Practices

### Model Selection

- **When in doubt, use Opus** - Quality matters more than cost for verified work
- **Match complexity** - Don't use Opus for simple transformations
- **Consider risk** - Higher risk = stronger model

### Judge Verification

- **Never skip** - The judge catches what self-critique misses
- **Parse only headers** - Don't read full reports to avoid context pollution
- **Trust the threshold** - 4/5.0 is the quality gate

### Iteration

- **Focus fixes** - Don't rewrite everything, fix specific issues
- **Pass feedback verbatim** - Let the implementation agent see exact issues
- **Escalate appropriately** - Don't loop forever on fundamental problems

### Context Management

- **Keep it clean** - You orchestrate, sub-agents implement
- **Summarize, don't copy** - Pass summaries, not full file contents
- **Trust sub-agents** - They can read files themselves

---

## Source: sadd-judge


# Judge Command

<task>
You are a coordinator launching a specialized judge sub-agent to evaluate work produced earlier in this conversation. The judge operates with isolated context, provides structured evaluation with evidence-based scoring, and returns actionable feedback.
</task>

<context>
This command implements the LLM-as-Judge pattern with context isolation:
- **Context Isolation**: Judge operates with fresh context, preventing confirmation bias from accumulated session state
- **Chain-of-Thought Scoring**: Justification BEFORE score for 15-25% reliability improvement
- **Evidence-Based**: Every score requires specific citations from the work (file locations, line numbers)
- **Multi-Dimensional Rubric**: Weighted criteria with clear level descriptions
- **Self-Verification**: Dynamic verification questions with documented adjustments

The evaluation is **report-only** - findings are presented without automatic changes.
</context>

## Your Workflow

### Phase 1: Context Extraction

Before launching the judge, identify what needs evaluation:

1. **Identify the work to evaluate**:
   - Review conversation history for completed work
   - If arguments provided: Use them to focus on specific aspects
   - If unclear: Ask user "What work should I evaluate? (code changes, analysis, documentation, etc.)"

2. **Extract evaluation context**:
   - Original task or request that prompted the work
   - The actual output/result produced
   - Files created or modified (with brief descriptions)
   - Any constraints, requirements, or acceptance criteria mentioned

3. **Provide scope for user**:

   ```
   Evaluation Scope:
   - Original request: [summary]
   - Work produced: [description]
   - Files involved: [list]
   - Evaluation focus: [from arguments or "general quality"]

   Launching judge sub-agent...
   ```

**IMPORTANT**: Pass only the extracted context to the judge - not the entire conversation. This prevents context pollution and enables focused assessment.

### Phase 2: Launch Judge Sub-Agent

Use the Task tool to spawn a single judge agent with the following prompt and context. Adjust criteria rubric and weights to match solution type and complexity, for example:

- Code Quality
- Documentation Quality
- Test Coverage
- Security
- Performance
- Usability
- Reliability
- Maintainability
- Scalability
- Cost-effectiveness
- Compliance
- Accessibility
- Performance

**Judge Agent Prompt:**

```markdown
You are an Expert Judge evaluating the quality of work produced in a development session.

## Work Under Evaluation

[ORIGINAL TASK]
{paste the original request/task}
[/ORIGINAL TASK]

[WORK OUTPUT]
{summary of what was created/modified}
[/WORK OUTPUT]

[FILES INVOLVED]
{list of files with brief descriptions}
[/FILES INVOLVED]

[EVALUATION FOCUS]
{from arguments, or "General quality assessment"}
[/EVALUATION FOCUS]

Read ${CLAUDE_PLUGIN_ROOT}/tasks/judge.md and execute.

## Evaluation Criteria

### Criterion 1: Instruction Following (weight: 0.30)

Does the work follow all explicit instructions and requirements?

**Guiding Questions**:
- Does the output fulfill the original request?
- Were all explicit requirements addressed?
- Are there gaps or unexpected deviations?

| Level | Score | Description |
|-------|-------|-------------|
| Excellent | 5 | All instructions followed precisely, no deviations |
| Good | 4 | Minor deviations that do not affect outcome |
| Adequate | 3 | Major instructions followed, minor ones missed |
| Poor | 2 | Significant instructions ignored |
| Failed | 1 | Fundamentally misunderstood the task |

### Criterion 2: Output Completeness (weight: 0.25)

Are all requested aspects thoroughly covered?

**Guiding Questions**:
- Are all components of the request addressed?
- Is there appropriate depth for each component?
- Are there obvious gaps or missing pieces?

| Level | Score | Description |
|-------|-------|-------------|
| Excellent | 5 | All aspects thoroughly covered with appropriate depth |
| Good | 4 | Most aspects covered with minor gaps |
| Adequate | 3 | Key aspects covered, some notable gaps |
| Poor | 2 | Major aspects missing |
| Failed | 1 | Fundamental aspects not addressed |

### Criterion 3: Solution Quality (weight: 0.25)

Is the approach appropriate and well-implemented?

**Guiding Questions**:
- Is the chosen approach sound and appropriate?
- Does the implementation follow best practices?
- Are there correctness issues or errors?

| Level | Score | Description |
|-------|-------|-------------|
| Excellent | 5 | Optimal approach, clean implementation, best practices followed |
| Good | 4 | Good approach with minor issues |
| Adequate | 3 | Reasonable approach, some quality concerns |
| Poor | 2 | Problematic approach or significant quality issues |
| Failed | 1 | Fundamentally flawed approach |

### Criterion 4: Reasoning Quality (weight: 0.10)

Is the reasoning clear, logical, and well-documented?

**Guiding Questions**:
- Is the decision-making transparent?
- Were appropriate methods/tools used?
- Can someone understand why this approach was taken?

| Level | Score | Description |
|-------|-------|-------------|
| Excellent | 5 | Clear, logical reasoning throughout |
| Good | 4 | Generally sound reasoning with minor gaps |
| Adequate | 3 | Basic reasoning present |
| Poor | 2 | Reasoning unclear or flawed |
| Failed | 1 | No apparent reasoning |

### Criterion 5: Response Coherence (weight: 0.10)

Is the output well-structured and easy to understand?

**Guiding Questions**:
- Is the output organized logically?
- Can someone unfamiliar with the task understand it?
- Is it professionally presented?

| Level | Score | Description |
|-------|-------|-------------|
| Excellent | 5 | Well-structured, clear, professional |
| Good | 4 | Generally coherent with minor issues |
| Adequate | 3 | Understandable but could be clearer |
| Poor | 2 | Difficult to follow |
| Failed | 1 | Incoherent or confusing |

```

### Phase 3: Process and Present Results

After receiving the judge's evaluation:

1. **Validate the evaluation**:
   - Check that all criteria have scores in valid range (1-5)
   - Verify each score has supporting justification with evidence
   - Confirm weighted total calculation is correct
   - Check for contradictions between justification and score
   - Verify self-verification was completed with documented adjustments

2. **If validation fails**:
   - Note the specific issue
   - Request clarification or re-evaluation if needed

3. **Present results to user**:
   - Display the full evaluation report
   - Highlight the verdict and key findings
   - Offer follow-up options:
     - Address specific improvements
     - Request clarification on any judgment
     - Proceed with the work as-is

## Scoring Interpretation

| Score Range | Verdict | Interpretation | Recommendation |
|-------------|---------|----------------|----------------|
| 4.50 - 5.00 | EXCELLENT | Exceptional quality, exceeds expectations | Ready as-is |
| 4.00 - 4.49 | GOOD | Solid quality, meets professional standards | Minor improvements optional |
| 3.50 - 3.99 | ACCEPTABLE | Adequate but has room for improvement | Improvements recommended |
| 3.00 - 3.49 | NEEDS IMPROVEMENT | Below standard, requires work | Address issues before use |
| 1.00 - 2.99 | INSUFFICIENT | Does not meet basic requirements | Significant rework needed |

## Important Guidelines

1. **Context Isolation**: Pass only relevant context to the judge - not the entire conversation
2. **Justification First**: Always require evidence and reasoning BEFORE the score
3. **Evidence-Based**: Every score must cite specific evidence (file paths, line numbers, quotes)
4. **Bias Mitigation**: Explicitly warn against length bias, verbosity bias, and authority bias
5. **Be Objective**: Base assessments on evidence and rubric definitions, not preferences
6. **Be Specific**: Cite exact locations, not vague observations
7. **Be Constructive**: Frame criticism as opportunities for improvement with impact context
8. **Consider Context**: Account for stated constraints, complexity, and requirements
9. **Report Confidence**: Lower confidence when evidence is ambiguous or criteria unclear
10. **Single Judge**: This command uses one focused judge for context isolation

## Notes

- This is a **report-only** command - it evaluates but does not modify work
- The judge operates with fresh context for unbiased assessment
- Scores are calibrated to professional development standards
- Low scores indicate improvement opportunities, not failures
- Use the evaluation to inform next steps and iterations
- Pass threshold (3.5/5.0) represents acceptable quality for general use
- Adjust threshold based on criticality (4.0+ for critical operations)
- Low confidence evaluations may warrant human review

---

## Source: sadd-judge-with-debate


# judge-with-debate

<task>
Evaluate solutions through multi-agent debate where independent judges analyze, challenge each other's assessments, and iteratively refine their evaluations until reaching consensus or maximum rounds.
</task>

<context>
This command implements the Multi-Agent Debate pattern for high-quality evaluation where multiple perspectives and rigorous argumentation improve assessment accuracy. Unlike single-pass evaluation, debate forces judges to defend their positions with evidence and consider counter-arguments.
</context>

## Pattern: Debate-Based Evaluation

This command implements iterative multi-judge debate:

```
Phase 0: Setup
         mkdir -p .specs/reports
                  │
Phase 1: Independent Analysis
         ┌─ Judge 1 → {name}.1.md ─┐
Solution ┼─ Judge 2 → {name}.2.md ─┼─┐
         └─ Judge 3 → {name}.3.md ─┘ │
                                     │
Phase 2: Debate Round (iterative)   │
    Each judge reads others' reports │
         ↓                           │
    Argue + Defend + Challenge       │
         ↓                           │
    Revise if convinced ─────────────┤
         ↓                           │
    Check consensus                  │
         ├─ Yes → Final Report       │
         └─ No → Next Round ─────────┘
```

## Process

### Setup: Create Reports Directory

Before starting evaluation, ensure the reports directory exists:

```bash
mkdir -p .specs/reports
```

**Report naming convention:** `.specs/reports/{solution-name}-{YYYY-MM-DD}.[1|2|3].md`

Where:
- `{solution-name}` - Derived from solution filename (e.g., `users-api` from `src/api/users.ts`)
- `{YYYY-MM-DD}` - Current date
- `[1|2|3]` - Judge number

### Phase 1: Independent Analysis

Launch **3 independent judge agents in parallel** (recommended: Opus for rigor):

1. Each judge receives:
   - Path to solution(s) being evaluated
   - Evaluation criteria with weights
   - Clear rubric for scoring
2. Each produces **independent assessment** saved to `.specs/reports/{solution-name}-{date}.[1|2|3].md`
3. Reports must include:
   - Per-criterion scores with evidence
   - Specific quotes/examples supporting ratings
   - Overall weighted score
   - Key strengths and weaknesses

**Key principle:** Independence in initial analysis prevents groupthink.

**Prompt template for initial judges:**

```markdown
You are Judge {N} evaluating a solution independently.

<solution_path>
{path to solution file(s)}
</solution_path>

<task_description>
{what the solution was supposed to accomplish}
</task_description>

<evaluation_criteria>
{criteria with descriptions and weights}
</evaluation_criteria>

<output_file>
.specs/reports/{solution-name}-{date}.{N}.md
</output_file>

Read ${CLAUDE_PLUGIN_ROOT}/tasks/judge.md for evaluation methodology and execute using following criteria.

Instructions:
1. Read the solution thoroughly
2. For each criterion:
   - Find specific evidence (quote exact text)
   - Score on the defined scale
   - Justify with concrete examples
3. Calculate weighted overall score
4. Write comprehensive report to {output_file}
5. Generate verification 5 questions about your evaluation.
6. Answer verification questions:
   - Re-examine solutions for each question
   - Find counter-evidence if it exists
   - Check for systematic bias (length, confidence, etc.)
7. Revise your report file and update it accordingly.

Add to report begining `Done by Judge {N}`
```

### Phase 2: Debate Rounds (Iterative)

For each debate round (max 3 rounds):

Launch **3 debate agents in parallel**:

1. Each judge agent receives:
   - Path to their own previous report (`.specs/reports/{solution-name}-{date}.[1|2|3].md`)
   - Paths to other judges' reports (`.specs/reports/{solution-name}-{date}.[1|2|3].md`)
   - The original solution
2. Each judge:
   - Identifies disagreements with other judges (>1 point score gap on any criterion)
   - Defends their own ratings with evidence
   - Challenges other judges' ratings they disagree with
   - Considers counter-arguments
   - Revises their assessment if convinced
3. Updates their report file with new section: `## Debate Round {R}`
4. After they reply, if they reached agreement move to Phase 3: Consensus Report

**Key principle:** Judges communicate only through filesystem - orchestrator doesn't mediate and don't read reports files itself, it can overflow your context.

**Prompt template for debate judges:**

```markdown
You are Judge {N} in debate round {R}.

<your_previous_report>
{path to .specs/reports/{solution-name}-{date}.{N}.md}
</your_previous_report>

<other_judges_reports>
Judge 1: .specs/reports/{solution-name}-{date}.1.md
...
</other_judges_reports>

<task_description>
{what the solution was supposed to accomplish}
</task_description>

<solution_path>
{path to solution}
</solution_path>

<output_file>
.specs/reports/{solution-name}-{date}.{N}.md (append to existing file)
</output_file>

Read ${CLAUDE_PLUGIN_ROOT}/tasks/judge.md for evaluation methodology principles.

Instructions:
1. Read your previous assessment from {your_previous_report}
2. Read all other judges' reports
3. Identify disagreements (where your scores differ by >1 point)
4. For each major disagreement:
   - State the disagreement clearly
   - Defend your position with evidence
   - Challenge the other judge's position with counter-evidence
   - Consider whether their evidence changes your view
5. Update your report file by APPENDING:
6. Reply whether you are reached agreement, and with which judge. Include revisited scores and criteria scores.


---

## Source: sadd-tree-of-thoughts


# tree-of-thoughts

<task>
Execute complex reasoning tasks through systematic exploration of solution space, pruning unpromising branches, expanding viable approaches, and synthesizing the best solution.
</task>

<context>
This command implements the Tree of Thoughts (ToT) pattern for tasks requiring exploration of multiple solution paths before committing to full implementation. It combines creative sampling, multi-perspective evaluation, adaptive strategy selection, and evidence-based synthesis to produce superior outcomes.
</context>

## Pattern: Tree of Thoughts (ToT)

This command implements a six-phase systematic reasoning pattern with adaptive strategy selection:

```
Phase 1: Exploration (Propose Approaches)
         ┌─ Agent A → Proposals A1, A2 (with probabilities) ─┐
Task ───┼─ Agent B → Proposals B1, B2 (with probabilities) ─┼─┐
         └─ Agent C → Proposals C1, C2 (with probabilities) ─┘ │
                                                                │
Phase 2: Pruning (Vote for Best 3)                             │
         ┌─ Judge 1 → Votes + Rationale ─┐                     │
         ├─ Judge 2 → Votes + Rationale ─┼─────────────────────┤
         └─ Judge 3 → Votes + Rationale ─┘                     │
                 │                                              │
                 ├─→ Select Top 3 Proposals                     │
                 │                                              │
Phase 3: Expansion (Develop Full Solutions)                    │
         ┌─ Agent A → Solution A (from proposal X) ─┐          │
         ├─ Agent B → Solution B (from proposal Y) ─┼──────────┤
         └─ Agent C → Solution C (from proposal Z) ─┘          │
                                                                │
Phase 4: Evaluation (Judge Full Solutions)                     │
         ┌─ Judge 1 → Report 1 ─┐                              │
         ├─ Judge 2 → Report 2 ─┼──────────────────────────────┤
         └─ Judge 3 → Report 3 ─┘                              │
                                                                │
Phase 4.5: Adaptive Strategy Selection                         │
         Analyze Consensus ────────────────────────────────────┤
                ├─ Clear Winner? → SELECT_AND_POLISH           │
                ├─ All Flawed (<3.0)? → REDESIGN (Phase 3)     │
                └─ Split Decision? → FULL_SYNTHESIS            │
                                         │                      │
Phase 5: Synthesis (Only if FULL_SYNTHESIS)                    │
         Synthesizer ────────────────────┴──────────────────────┴─→ Final Solution
```

## Process

### Setup: Create Directory Structure

Before starting, ensure the directory structure exists:

```bash
mkdir -p .specs/research .specs/reports
```

**Naming conventions:**
- Proposals: `.specs/research/{solution-name}-{YYYY-MM-DD}.proposals.[a|b|c].md`
- Pruning: `.specs/research/{solution-name}-{YYYY-MM-DD}.pruning.[1|2|3].md`
- Selection: `.specs/research/{solution-name}-{YYYY-MM-DD}.selection.md`
- Evaluation: `.specs/reports/{solution-name}-{YYYY-MM-DD}.[1|2|3].md`

Where:
- `{solution-name}` - Derived from output path (e.g., `users-api` from output `specs/api/users.md`)
- `{YYYY-MM-DD}` - Current date

**Note:** Solutions remain in their specified output locations; only research and evaluation files go to `.specs/`

### Phase 1: Exploration (Propose Approaches)

Launch **3 independent agents in parallel** (recommended: Sonnet for speed):

1. Each agent receives **identical task description and context**
2. Each agent **generates 6 high-level approaches** (not full implementations)
3. For each approach, agent provides:
   - **Approach description** (2-3 paragraphs)
   - **Key design decisions** and trade-offs
   - **Probability estimate** (0.0-1.0) 
   - **Estimated complexity** (low/medium/high)
   - **Potential risks** and failure modes
4. Proposals saved to `.specs/research/{solution-name}-{date}.proposals.[a|b|c].md`

**Key principle:** Systematic exploration through probabilistic sampling from the full distribution of possible approaches.

**Prompt template for explorers:**

```markdown
<task>
{task_description}
</task>

<constraints>
{constraints_if_any}
</constraints>

<context>
{relevant_context}
</context>

<output>
{.specs/research/{solution-name}-{date}.proposals.[a|b|c].md - each agent gets unique letter identifier}
</output>

Instructions:

Let's approach this systematically by first understanding what we're solving, then exploring the solution space.

**Step 1: Decompose the problem**
Before generating approaches, break down the task:
- What is the core problem being solved?
- What are the key constraints and requirements?
- What subproblems must any solution address?
- What are the evaluation criteria for success?

**Step 2: Map the solution space**
Identify the major dimensions along which solutions can vary:
- Architecture patterns (e.g., monolithic vs distributed)
- Implementation strategies (e.g., eager vs lazy)
- Trade-off axes (e.g., performance vs simplicity)

**Step 3: Generate 6 distinct high-level approaches**

**Sampling guidance:**
Please sample approaches at random from the [full distribution / tails of the distribution]
- For first 3 approaches aim for high probability, over 0.80
- For last 3 approaches aim for diversity - explore different regions of the solution space, such that the probability of each response is less than 0.10

For each approach, provide:
   - Name and one-sentence summary
   - Detailed description (2-3 paragraphs)
   - Key design decisions and rationale
   - Trade-offs (what you gain vs what you sacrifice)
   - Probability (0.0-1.0)
   - Complexity estimate (low/medium/high)
   - Potential risks and failure modes

**Step 4: Verify diversity**
Before finalizing, check:
- Are approaches genuinely different, not minor variations?
- Do they span different regions of the solution space?
- Have you covered both conventional and unconventional options?


CRITICAL:
- Do NOT implement full solutions yet - only high-level approaches
- Ensure approaches are genuinely different, not minor variations
```

### Phase 2: Pruning (Vote for Top 3 Candidates)

Launch **3 independent judges in parallel** (recommended: Sonnet for efficiency):

1. Each judge receives **ALL proposal files** (from `.specs/research/`)
2. Judges evaluate each proposal against **pruning criteria**:
   - **Feasibility** (1-5): Can this be implemented with available resources?
   - **Alignment** (1-5): How well does it address the task requirements?
   - **Potential** (1-5): Likelihood of producing high-quality result?
   - **Risk** (1-5, inverse): How manageable are the identified risks?
3. Each judge produces:
   - **Scores for each proposal** (with evidence)
   - **Vote for top 3 proposals** to expand
   - **Rationale** for selections
4. Votes saved to `.specs/research/{solution-name}-{date}.pruning.[1|2|3].md`

**Key principle:** Independent evaluation with explicit criteria reduces groupthink and catches different strengths/weaknesses.

**Prompt template for pruning judges:**

```markdown
You are evaluating {N} proposed approaches to select the top 3 for full development.

<task>
{task_description}
</task>

<proposals>
{list of paths to all proposal files}
Read all proposals carefully before evaluating.
</proposals>

<output>
{.specs/research/{solution-name}-{date}.pruning.[1|2|3].md - each judge gets unique number identifier}
</output>

Evaluation criteria (with weights):
1. Feasibility (25%): Can this be implemented with available resources and constraints?
2. Alignment (30%): How well does it address the task requirements and constraints?
3. Potential (30%): Likelihood of producing a high-quality, robust solution?
4. Risk (15%): How manageable are the identified risks and failure modes?

Read ${CLAUDE_PLUGIN_ROOT}/tasks/judge.md for evaluation methodology and execute using following criteria.

Instructions:
1. For each proposal, score on each criterion (1-5)
2. Provide specific evidence from the proposal for each score
3. Calculate weighted total score for each proposal
4. Vote for your top 3 proposals with clear justification
5. Consider:
   - Does the probability estimate seem realistic?
   - Are the trade-offs clearly articulated?
   - Are risks identified and addressable?
6. Generate verification 4-6 questions about your evaluation.
7. Answer verification questions:
   - Re-examine solutions for each question
   - Find counter-evidence if it exists
   - Check for systematic bias (length, confidence, etc.)
8. Revise your evaluation and update it accordingly.

Output format:
- Evaluation table with scores for all proposals
- Top 3 selections with rationale
- Any concerns or questions about selected proposals

CRITICAL:
- Base your evaluation on evidence from proposals, not assumptions
- Your top 3 should be ranked: 1st choice, 2nd choice, 3rd choice
```

### Phase 2b: Select Top 3 Proposals

After judges complete voting:

1. **Aggregate votes** using ranked choice:
   - 1st choice = 3 points
   - 2nd choice = 2 points
   - 3rd choice = 1 point
2. **Select top 3** proposals by total points
3. **Handle ties** by comparing average scores across criteria
4. **Document selection** in `.specs/research/{solution-name}-{date}.selection.md`:
   - Vote tallies
   - Selected proposals
   - Consensus rationale

### Phase 3: Expansion (Develop Full Solutions)

Launch **3 independent agents in parallel** (recommended: Opus for quality):

1. Each agent receives:
   - **One selected proposal** to expand
   - **Original task description** and context
   - **Judge feedback** from pruning phase (concerns, questions)
2. Agent produces **complete solution** implementing the proposal:
   - Full implementation details
   - Addresses concerns raised by judges
   - Documents key decisions made during expansion
3. Solutions saved to `solution.a.md`, `solution.b.md`, `solution.c.md`

**Key principle:** Focused development of validated approaches with awareness of evaluation feedback.

**Prompt template for expansion agents:**

```markdown
You are developing a full solution based on a selected proposal.

<task>
{task_description}
</task>

<selected_proposal>
{write selected proposal EXACTLY as it is. Including all details provided by the agent}
Read this carefully - it is your starting point.
</selected_proposal>

<judge_feedback>
{concerns and questions from judges about this proposal}
Address these in your implementation.
</judge_feedback>

<output>
solution.[*].md where [*] is your unique identifier (a, b, or c)
</output>

Instructions:

Let's work through this systematically to ensure we build a complete, high-quality solution.

**Step 1: Understand the proposal deeply**
Before implementing, analyze:
- What is the core insight or approach of this proposal?
- What are the key design decisions already made?
- What gaps need to be filled for a complete solution?

**Step 2: Address judge feedback**
For each concern raised by judges:
- What specific change or addition addresses this concern?
- How does this change integrate with the proposal's approach?

**Step 3: Decompose into implementation subproblems**
Break the solution into logical parts:
- What are the main components or sections?
- What must be defined first for other parts to build upon?
- What are the dependencies between parts?

**Step 4: Implement each subproblem**
For each component, work through:
- Core functionality and behavior
- Edge cases and error handling
- Integration points with other components

**Step 5: Self-verification**
Generate 3-5 verification questions about critical aspects, then answer them:
- Review solution against each question
- Identify gaps or weaknesses
- Fix identified issues

**Step 6: Document changes**
Explain what was changed from the original proposal and why.

<example>
**Example of good expansion thinking:**

Proposal: "Use event-driven architecture with message queue"

Step 1 Analysis:
- Core insight: Decouple components via async messaging
- Key decisions: Events as primary communication, eventual consistency
- Gaps: Need to define event schemas, queue technology, error handling

Step 2 - Addressing judge concern "What about message ordering?":
- Add partition keys for ordered processing within entity scope
- Document ordering guarantees and limitations

Step 3 - Subproblems:
1. Event schema definitions (foundational - others depend on this)
2. Producer interfaces (depends on schemas)
3. Consumer handlers (depends on schemas)
4. Error handling and dead letter queues (depends on both)
5. Integration patterns (builds on all above)
</example>

CRITICAL:
- Stay faithful to the selected proposal's core approach
- Do not switch to a different approach midway
- Address judge feedback explicitly
- Produce a complete, implementable solution
```

### Phase 4: Evaluation (Judge Full Solutions)

Launch **3 independent judges in parallel** (recommended: Opus for rigor):

1. Each judge receives **ALL solution files** (solution.a.md, solution.b.md, solution.c.md)
2. Judges evaluate against **final criteria** (task-specific):
   - **Correctness** (weight based on task)
   - **Completeness** (weight based on task)
   - **Quality** (design, maintainability, etc.)
   - **Feasibility** (can this be implemented?)
3. Each judge produces:
   - **Comparative analysis** (which solution excels where)
   - **Evidence-based ratings** (with specific quotes/examples)
   - **Final vote** (which solution they prefer and why)
4. Reports saved to `.specs/reports/{solution-name}-{date}.[1|2|3].md`

**Key principle:** Multiple independent evaluations with explicit evidence reduce bias and catch different quality aspects.

**Prompt template for evaluation judges:**

```markdown
You are evaluating {number} full solutions to this task:

<task>
{task_description}
</task>

<solutions>
{list of paths to all solution files}
Read all solutions carefully before evaluating.
</solutions>

<output>
Write full report to: .specs/reports/{solution-name}-{date}.[1|2|3].md - each judge gets unique number identifier

CRITICAL: You must reply with this exact structured header format:


[Summary of your evaluation]
</output>

Evaluation criteria (with weights):
1. {criterion_1} ({weight_1}%)
2. {criterion_2} ({weight_2}%)
3. {criterion_3} ({weight_3}%)
...

Read ${CLAUDE_PLUGIN_ROOT}/tasks/judge.md for evaluation methodology and execute using following criteria.

Instructions:
1. For each criterion, analyze ALL solutions
2. Write a combined report:
   - Provide specific evidence (quote exact text) for your assessments
   - Compare strengths and weaknesses
   - Score each solution on each criterion (1-5)
   - Calculate weighted total scores
3. Generate verification 4-6 questions about your evaluation.
4. Answer verification questions:
   - Re-examine solutions for each question
   - Find counter-evidence if it exists
   - Check for systematic bias (length, confidence, etc.)
5. Revise your evaluation and update it accordingly.
6. Reply structured output:
   - VOTE: Which solution you recommend
   - SCORES: Weighted total score for each solution (0.0-5.0)

CRITICAL: Base your evaluation on evidence, not impressions. Quote specific text.

Final checklist:
- [ ] Generated and answered all verification questions
- [ ] Found and corrected all potential issues
- [ ] Checked for known biases (length, verbosity, confidence)
- [ ] Confident in revised evaluation
- [ ] Structured header with VOTE and SCORES at top of report
```

### Phase 4.5: Adaptive Strategy Selection (Early Return)

**The orchestrator** (not a subagent) analyzes judge outputs to determine the optimal strategy.

#### Decision Logic

**Step 1: Parse structured headers from judge reply**

Parse the judges reply.
CRITICAL: Do not read report files themselves, as they can overflow your context.

**Step 2: Check for unanimous winner**

Compare all three VOTE values:
- If Judge 1 VOTE = Judge 2 VOTE = Judge 3 VOTE (same solution):
  - **Strategy: SELECT_AND_POLISH**
  - **Reason:** Clear consensus - all three judges prefer same solution

**Step 3: Check if all solutions are fundamentally flawed**

If no unanimous vote, calculate average scores:
1. Average Solution A scores: (Judge1_A + Judge2_A + Judge3_A) / 3
2. Average Solution B scores: (Judge1_B + Judge2_B + Judge3_B) / 3
3. Average Solution C scores: (Judge1_C + Judge2_C + Judge3_C) / 3

If (avg_A < 3.0) AND (avg_B < 3.0) AND (avg_C < 3.0):
- **Strategy: REDESIGN**
- **Reason:** All solutions below quality threshold, fundamental approach issues

**Step 4: Default to full synthesis**

If none of the above conditions met:
- **Strategy: FULL_SYNTHESIS**
- **Reason:** Split decision with merit, synthesis needed to combine best elements

#### Strategy 1: SELECT_AND_POLISH

**When:** Clear winner (unanimous votes)

**Process:**
1. Select the winning solution as the base
2. Launch subagent to apply specific improvements from judge feedback
3. Cherry-pick 1-2 best elements from runner-up solutions
4. Document what was added and why

**Benefits:**
- Saves synthesis cost (simpler than full synthesis)
- Preserves proven quality of winning solution
- Focused improvements rather than full reconstruction

**Prompt template:**

```markdown
You are polishing the winning solution based on judge feedback.

<task>
{task_description}
</task>

<winning_solution>
{path_to_winning_solution}
Score: {winning_score}/5.0
Judge consensus: {why_it_won}
</winning_solution>

<runner_up_solutions>
{list of paths to all runner-up solutions}
</runner_up_solutions>

<judge_feedback>
{list of paths to all evaluation reports}
</judge_feedback>

<output>
{final_solution_path}
</output>

Instructions:

Let's approach this polishing task methodically to improve without disrupting what works.

**Step 1: Understand why this solution won**
Analyze the winning solution:
- What are its core strengths that judges praised?
- What makes its approach superior to alternatives?
- Which parts should remain untouched?

**Step 2: Catalog improvement opportunities**
From judge feedback, identify:
- Specific weaknesses mentioned (list each one)
- Missing elements judges noted
- Areas where runner-ups were praised

**Step 3: Prioritize changes by impact**
For each improvement opportunity:
- High impact: Directly addresses judge criticism
- Medium impact: Adds praised element from runner-up
- Low impact: Nice-to-have refinement

Focus on high-impact changes first.

**Step 4: Apply improvements surgically**
For each change:
- Locate the specific section to modify
- Make the minimal change needed to address the issue
- Verify the change integrates cleanly with surrounding content

**Step 5: Cherry-pick from runners-up**
Review runner-up solutions for:
- 1-2 specific elements that judges praised
- Elements that complement (not conflict with) the winning approach
- Only incorporate if clearly superior to winning solution's version

**Step 6: Document all changes**
Record:
- What was changed and why (with reference to judge feedback)
- What was added from other solutions (cite source)
- What was intentionally left unchanged

CRITICAL: Preserve the winning solution's core approach. Make targeted improvements only.
```

#### Strategy 2: REDESIGN

**When:** All solutions scored <3.0/5.0 (fundamental issues across the board)

**Process:**
1. Launch new agent to analyze the failure modes and lessons learned
2. **Return to Phase 3** (Expansion), provide to new implementation agents the lessons learned and new constraints

**Note:** If redesign fails twice, escalate to user for guidance.

**Prompt template for new implementation:**

```markdown
You are analyzing why all solutions failed to meet quality standards, to inform a redesign. And implement new solution based on it.


<task>
{task_description}
</task>

<constraints>
{constraints_if_any}
</constraints>

<context>
{relevant_context}
</context>

<failed_solutions>
{list of paths to all solution files}
Average scores: A={avg_a}/5.0, B={avg_b}/5.0, C={avg_c}/5.0
</failed_solutions>

<evaluation_reports>
{list of paths to all evaluation reports}
All solutions scored below 3.0/5.0 threshold.
</evaluation_reports>

<output>
.specs/research/{solution-name}-{date}.redesign-analysis.md
</output>

Instructions:
Let's break this down systematically to understand what went wrong and how to design new solution based on it.

1. First, analyze the task carefully - what is being asked and what are the key requirements?
2. Read through each solution and its evaluation report
3. For each solution, think step by step about:
   - What was the core approach?
   - What specific issues did judges identify?
   - Why did this approach fail to meet the quality threshold?
4. Identify common failure patterns across all solutions:
   - Are there shared misconceptions?
   - Are there missing requirements that all solutions overlooked?
   - Are there fundamental constraints that weren't considered?
5. Extract lessons learned:
   - What approaches should be avoided?
   - What constraints must be addressed?
6. Generate improved guidance for the next iteration:
   - New constraints to add
   - Specific approaches to try - what are the different ways to solve this?
   - Key requirements to emphasize
7. Think through the tradeoffs step by step and choose the approach you believe is best
8. Implement it completely
9. Generate 5 verification questions about critical aspects
10. Answer your own questions:
   - Review solution against each question
   - Identify gaps or weaknesses
11. Revise solution:
   - Fix identified issues
12. Explain what was changed and why
```

#### Strategy 3: FULL_SYNTHESIS (Default)

**When:** No clear winner AND solutions have merit (scores ≥3.0)

**Process:** Proceed to Phase 5 (Evidence-Based Synthesis)

### Phase 5: Synthesis (Evidence-Based Combination)

**Only executed when Strategy 3 (FULL_SYNTHESIS) selected in Phase 4.5**

Launch **1 synthesis agent** (recommended: Opus for quality):

1. Agent receives:
   - **All solutions** (from specified output location)
   - **All evaluation reports** (from `.specs/reports/`)
   - **Selection rationale** from pruning phase (from `.specs/research/`)
2. Agent analyzes:
   - **Consensus strengths** (what multiple judges praised)
   - **Consensus weaknesses** (what multiple judges criticized)
   - **Complementary elements** where solutions took different approaches
3. Agent produces **final solution** by:
   - **Copying superior sections** when one solution clearly wins
   - **Combining approaches** when hybrid is better
   - **Fixing identified issues** that judges caught
   - **Documenting decisions** (what was taken from where and why)

**Key principle:** Evidence-based synthesis leverages collective intelligence from exploration and evaluation.

**Prompt template for synthesizer:**

```markdown
You are synthesizing the best solution from explored, pruned, and evaluated implementations.

<task>
{task_description}
</task>

<solutions>
{list of paths to all solution files}
</solutions>

<evaluation_reports>
{list of paths to all evaluation reports}
</evaluation_reports>

<selection_rationale>
{path to selection.md explaining why these proposals were chosen}
</selection_rationale>

<output>
{output_path} - The final synthesized solution
</output>

Instructions:

Let's approach this synthesis systematically by first analyzing, then decomposing, then building.

**Step 1: Build the evidence base**
Before synthesizing, gather evidence from judge reports:
- What did multiple judges praise? (consensus strengths)
- What did multiple judges criticize? (consensus weaknesses)
- Where did judges disagree? (areas needing careful analysis)

**Step 2: Decompose into synthesis subproblems**
Break the solution into logical sections or components. For each component:
- Which solution handles this best? (cite evidence)
- Are there complementary elements from multiple solutions?
- What issues were identified that need fixing?

**Step 3: Solve each subproblem**
For each component/section, determine the synthesis strategy:

*Strategy A - Clear winner:* If one solution is clearly superior for this component:
- Copy that section directly
- Document: "Taken from Solution X because [judge evidence]"

*Strategy B - Complementary combination:* If solutions have complementary strengths:
- Identify what each contributes
- Combine carefully, ensuring consistency
- Document: "Combined X from Solution A with Y from Solution B because [rationale]"

*Strategy C - All flawed:* If all solutions have issues in this area:
- Start with the best version
- Apply fixes based on judge criticism
- Document: "Based on Solution X, modified to address [specific issues]"

**Step 4: Integrate and verify consistency**
After synthesizing all components:
- Check that combined elements work together
- Resolve any contradictions between borrowed sections
- Ensure consistent terminology and style

**Step 5: Document synthesis decisions**
Create a synthesis log:
- What you took from each solution (with specific citations)
- Why you made those choices (reference judge feedback)
- How you addressed identified weaknesses
- Any novel combinations or improvements

<example>
**Example synthesis decision for an API design:**

Component: Authentication flow
- Solution A: JWT with refresh tokens (praised for security by 2/3 judges)
- Solution B: Session-based (praised for simplicity by 1 judge, criticized for scalability)
- Solution C: OAuth2 only (criticized as over-engineered for use case)

Decision: Take Solution A's authentication flow directly.
Evidence: Judges 1 and 3 both noted "JWT approach provides good balance of security and statelessness"
Modification: None needed - this section was rated highest across judges.
</example>

**Step 6: Revise your solution**
- Generate 5 verification questions about critical aspects
- Answer your own questions:
   - Review solution against each question
   - Identify gaps or weaknesses
- Revise solution:
   - Fix identified issues
- Explain what was changed and why


CRITICAL:
- Do not create something entirely new - synthesize the best from what exists
- Cite your sources (which solution, which section)
- Explain every major decision
- Address all consensus weaknesses identified by judges
```

<output>
The command produces different outputs depending on the adaptive strategy selected:

### Outputs (All Strategies)

1. **Research directory:** `.specs/research/` (created if not exists)
   - Proposals: `.specs/research/{solution-name}-{date}.proposals.[a|b|c].md` - High-level approaches with probabilities
   - Pruning: `.specs/research/{solution-name}-{date}.pruning.[1|2|3].md` - Judge evaluations and votes
   - Selection: `.specs/research/{solution-name}-{date}.selection.md` - Vote tallies and selected proposals

2. **Expansion outputs:**
   - `solution.a.md`, `solution.b.md`, `solution.c.md` - Full implementations (in specified output location)

3. **Reports directory:** `.specs/reports/` (created if not exists)
   - Evaluation: `.specs/reports/{solution-name}-{date}.[1|2|3].md` - Final judge reports

4. **Resulting solution:** `{output_path}`

### Strategy-Specific Outputs

- **SELECT_AND_POLISH**: Polished solution based on winning solution, with targeted improvements
- **REDESIGN**: Do not stop; return to Phase 3 with lessons learned; eventually finishes at SELECT_AND_POLISH or FULL_SYNTHESIS
- **FULL_SYNTHESIS**: Synthesized solution combining best elements from all solutions
</output>

## Best Practices

### Evaluation Criteria by Task Type

**Code implementation tasks:**
- Correctness (35%)
- Design quality (25%)
- Maintainability (20%)
- Performance (10%)
- Clarity (10%)

**Architecture/design tasks:**
- Completeness (30%)
- Feasibility (25%)
- Scalability (20%)
- Simplicity (15%)
- Clarity (10%)

**Research/analysis tasks:**
- Depth (35%)
- Accuracy (30%)
- Completeness (20%)
- Actionability (15%)

**Documentation tasks:**
- Completeness (35%)
- Accuracy (30%)
- Clarity (20%)
- Usability (15%)

### Common Pitfalls

❌ **Insufficient exploration** - Agents propose similar approaches
❌ **Weak pruning criteria** - Judges can't differentiate quality
❌ **Ignoring judge feedback** - Expansion ignores concerns from pruning
❌ **Vague proposals** - Can't properly evaluate without implementation details
❌ **Over-exploration** - Too many proposals, evaluation becomes expensive
❌ **Forcing synthesis when clear winner exists** - Wastes cost and risks degrading quality
❌ **Synthesizing fundamentally flawed solutions** - Better to redesign than polish garbage

✅ **Encourage diverse exploration** - Prompt for different regions of solution space
✅ **Clear pruning criteria** - Specific, measurable evaluation dimensions
✅ **Feed feedback forward** - Expansion agents address pruning concerns
✅ **Right level of detail** - Proposals have enough detail to evaluate
✅ **Prune aggressively** - Only expand most promising 3 approaches
✅ **Trust adaptive strategy selection** - Polish clear winners, synthesize split decisions, redesign failures

## Example: API Design

```bash
/tree-of-thoughts "Design REST API for user management (CRUD + auth)" \
  --output "specs/api/users.md" \
  --criteria "RESTfulness,security,scalability,developer-experience"
```

**Phase 1 outputs** (assuming date 2025-01-15):
- `.specs/research/users-api-2025-01-15.proposals.a.md` - 3 approaches: Resource-based (0.35), Action-based (0.25), HATEOAS (0.15)
- `.specs/research/users-api-2025-01-15.proposals.b.md` - 3 approaches: GraphQL-first (0.20), REST+GraphQL hybrid (0.30), Pure REST (0.40)
- `.specs/research/users-api-2025-01-15.proposals.c.md` - 3 approaches: Microservices (0.25), Monolithic (0.45), Hybrid (0.20)

**Phase 2 outputs:**
- `.specs/research/users-api-2025-01-15.pruning.1.md` - Top 3: Resource-based REST, Pure REST, Monolithic
- `.specs/research/users-api-2025-01-15.pruning.2.md` - Top 3: Pure REST, Hybrid (services), Resource-based REST
- `.specs/research/users-api-2025-01-15.pruning.3.md` - Top 3: Resource-based REST, REST+GraphQL hybrid, Pure REST
- `.specs/research/users-api-2025-01-15.selection.md` - Selected: Resource-based REST (8 pts), Pure REST (7 pts), Monolithic (4 pts)

**Phase 3 outputs:**
- `specs/api/users.a.md` - Full resource-based design with nested routes
- `specs/api/users.b.md` - Flat REST design with simple endpoints
- `specs/api/users.c.md` - Monolithic API with service-oriented internals

**Phase 4 outputs:**
- `.specs/reports/users-api-2025-01-15.1.md`:
  ```
  VOTE: Solution A
  SCORES: A=4.2/5.0, B=3.8/5.0, C=3.4/5.0
  ```
  "Prefers A for RESTfulness, criticizes C complexity"

- `.specs/reports/users-api-2025-01-15.2.md`:
  ```
  VOTE: Solution B
  SCORES: A=3.9/5.0, B=4.1/5.0, C=3.5/5.0
  ```
  "Prefers B for simplicity, criticizes A deep nesting"

- `.specs/reports/users-api-2025-01-15.3.md`:
  ```
  VOTE: Solution A
  SCORES: A=4.3/5.0, B=3.6/5.0, C=3.2/5.0
  ```
  "Prefers A for discoverability, criticizes B lack of structure"

**Phase 4.5 decision (orchestrator parses headers):**
- Split votes: A, B, A (no unanimous winner)
- Average scores: A=4.1, B=3.8, C=3.4 (all ≥3.0)
- Strategy: FULL_SYNTHESIS
- Reason: Split decision with merit, synthesis needed

**Phase 5 output (synthesis):**
- `specs/api/users.md` - Resource-based structure (from A), max 2-level nesting (from B), internal services (from C)


---

