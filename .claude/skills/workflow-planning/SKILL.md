---
name: workflow-planning
description: Feature planning, brainstorming, task decomposition, execution strategies, and branch completion. Use when the user needs to brainstorm ideas, write plans, execute plans, review work, decompose features, manage tasks, or finish a development branch.
metadata:
  pathPatterns:
    - "*.plan.md"
    - "*.spec.md"
    - "docs/*plan*"
    - "docs/*spec*"
    - ".specs/**"
  bashPattern:
    - "plan|brainstorm|feature.*spec|task.*list"
  priority: 80
  promptSignals:
    phrases:
      - 'write a plan'
      - 'decompose this'
      - 'break this down'
      - 'execution strategy'
      - 'brainstorm'
      - 'task plan'
      - 'finish the branch'
      - 'plan the feature'
---

# Workflow Planning Chief

> The unified planning-to-completion pipeline. Consolidates CE, SDD, and standalone workflow skills into one decision tree with 8 deep-dive references.

## Decision Tree

```
Task arrives about planning/execution/workflow
│
├─ "I have a rough idea, need to explore it"
│  → READ references/01-brainstorm-problem-solving-protocol.md
│  Covers: CE brainstorm, SDD brainstorm, structured exploration
│
├─ "I need to write a plan for implementation"
│  → READ references/02-plan-structure.md
│  Covers: CE plan, SDD plan, writing-plans, deepen-plan
│
├─ "I have a plan, need to execute it"
│  → READ references/03-execution-patterns.md
│  Covers: CE work, SDD implement, executing-plans
│
├─ "I need to review completed work"
│  → READ references/04-review-checkpoints.md
│  Covers: CE review, CE compound, document-review
│
├─ "I need feature specs or user stories"
│  → READ references/05-feature-specification.md
│  Covers: feature-forge, feature-video
│
├─ "I need to create/manage tasks or ideas"
│  → READ references/06-task-management.md
│  Covers: SDD add-task, SDD create-ideas, file-todos, triage
│
├─ "I'm done implementing, ready to wrap up"
│  → READ references/07-completion-patterns.md
│  Covers: finishing-a-development-branch, strategic-compact
│
└─ "What were the old workflow-* skills?"
   → READ references/08-deprecated-workflows.md
   Note: Replaced by CE family. Preserved for historical reference.
```

## The Planning Pipeline

Every non-trivial feature follows this sequence:

```
1. BRAINSTORM  → Explore possibilities, constraints, user intent
2. PLAN        → Structure the approach, break into phases
3. EXECUTE     → Implement phase by phase with checkpoints
4. REVIEW      → Verify quality, compound learnings
5. COMPLETE    → Finish branch, merge, document
```

Skip steps only when the task is trivially small (< 30 minutes).

## Non-Negotiables

1. **Plan before code.** No implementation without at least a mental model of phases.
2. **Scope explicitly.** Every plan must state what is IN scope and what is OUT.
3. **Break into phases.** No phase should exceed 2 hours of work.
4. **Review at boundaries.** Check work at every phase transition.
5. **Document decisions.** Capture WHY, not just WHAT.

## Anti-Patterns

| Anti-Pattern | Fix |
|---|---|
| "Let me just start coding" | Brainstorm first, even 5 minutes |
| Plan has no phases | Break into 2-hour chunks max |
| Plan has no scope boundary | Add "Out of Scope" section |
| Executing without checkpoints | Review after each phase |
| Skipping completion | Run finishing-a-development-branch checklist |
| Three competing frameworks | Use CE family (canonical), reference SDD for LLM-as-Judge |

## When to Use Which Framework

| Framework | Best For | Reference |
|---|---|---|
| **CE (Compound Engineering)** | Standard feature work, team-oriented | refs 01-04 |
| **SDD (Spec-Driven Development)** | LLM-as-Judge verification, spec-heavy | refs 02-03, 06 |
| **Feature Forge** | Formal requirements workshops | ref 05 |
| **Standalone** | Quick plans, context management | refs 02, 07 |

## Bundled References

| # | File | Lines | Domain |
|---|---|---|---|
| 01 | brainstorm-problem-solving-protocol.md | 750 | Brainstorming techniques |
| 02 | plan-structure.md | 3,405 | Plan writing & deepening |
| 03 | execution-patterns.md | 2,372 | Plan execution & implementation |
| 04 | review-checkpoints.md | 1,009 | Review & compounding |
| 05 | feature-specification.md | 997 | Feature specs & requirements |
| 06 | task-management.md | 804 | Task creation & triage |
| 07 | completion-patterns.md | 344 | Branch completion & compacting |
| 08 | deprecated-workflows.md | 79 | Historical archive |

**Total: 9,760 lines across 8 references**

## Absorbed Skills

These standalone skills are now consolidated here:
- `ce-brainstorm`, `ce-plan`, `ce-compound`, `ce-work`, `ce-review`
- `sdd-brainstorm`, `sdd-plan`, `sdd-implement`, `sdd-create-ideas`, `sdd-add-task`
- `brainstorming`, `writing-plans`, `deepen-plan`, `executing-plans`
- `feature-forge`, `feature-video`
- `finishing-a-development-branch`, `strategic-compact`
- `workflows-brainstorm`, `workflows-compound`, `workflows-plan`, `workflows-review`, `workflows-work`
- `file-todos`, `triage`, `document-review`