---
name: red-team-negation-loop
description: This skill should be used when the operator invokes the red-team negation loop ("red-team this", "negate this", "run the negation loop", "prove this is junior", "apply the negation loop to X"). It runs the bounded adversarial loop from .claude/rules/red-team-negation-loop.md as a real multi-agent loop: three independent veteran negators try to PROVE the target is junior-level with external evidence, the operator revises on any CRITICAL/MAJOR, and the loop re-runs until a full round lands nothing (the senior-staff bar) or hits the 4-iteration cap.
---

# Red-Team Negation Loop — runnable command

This is the executable form of the project's red-team negation rule (`.claude/rules/red-team-negation-loop.md`). The rule is the spec; this skill runs it as a loop backed by the Workflow tool. The negation goals are the folded cynical-audit charter (`.claude/rules/cynical-charter.md`); do not invent a lighter version.

## When invoked

Read the negation rule in full and the cynical-audit charter (the goal source) before the first round. Then drive the loop below. Treat the target as **presumed junior until three independent, well-researched veterans each try and fail to prove otherwise**. Never declare quality; declare only that a genuine attack could not land.

## Inputs

- **Target artifact** — the implementation/plan/decision under review. Resolve it to a concrete file list with absolute paths and a one-paragraph description of what it claims to do and the real constraint it solves. If the operator named a surface ("the auth + session layer of the checkout flow"), scout it first (Grep/Glob/Read) to assemble the exact file list before launching.

## The loop (drive this yourself; each round is one Workflow fan-out)

1. **Assemble the target.** Concrete files + description + the real constraint. Carry a running `priorFindingsSummary` (empty on round 1).
2. **Run a negation round.** Invoke the Workflow at `.claude/skills/red-team-negation-loop/negation-round.workflow.js` with args `{ targetName, targetDescription, files: [abs paths], priorFindingsSummary, iteration }`. It spawns three negators concurrently, each on the WHOLE target with the full goal set + evidence mandate (never split by lens), and returns `{ counts, critical[], major[], minor[], verdicts[], research[] }`.
3. **Read the result.** Verify the negators actually researched (the `research[]` record must show real searches + repo/spec reads — an empty sweep with no research is an invalid round; re-run it). Confidence may not exceed the evidence rung.
4. **Decide:**
   - **Any evidence-backed CRITICAL or MAJOR** → the hypothesis is proven on that point. **Revise the artifact** — apply the `fix_required` for each, with full engineering discipline (plan-before-code under the project's operating rules on risky edits; verify on the real surface, not a green type-check). Append what you fixed to `priorFindingsSummary`. **GOTO 2** (re-run the whole round against the revised artifact — a fix can open a new hole). MINOR findings are logged and fixed but do not, alone, force another iteration.
   - **No CRITICAL/MAJOR from any of the three, with real research on record** → none could prove the hypothesis → **exit**. Only now assert the work is senior-staff and the best available route, citing what the negators tried and failed to land.
5. **Cap at 4 iterations.** Still drawing evidence-backed CRITICALs after four rounds → STOP and escalate to the operator: the problem may be mis-scoped or the approach fundamentally wrong (a goal-level issue, not a fix-level one). Never weaken the hypothesis or lower the evidence bar to force termination.

## Concurrency cap

Each round spawns exactly **three** negators concurrently — staying under the harness's hard subagent-concurrency ceiling. Rounds run **sequentially** (one at a time), and fixes happen in the main loop, so only three agents are ever in flight. Do NOT widen a round to add per-finding verification agents in the same wave if it would push concurrent agents past the ceiling; sequence them instead.

## Fix discipline

The negators find; the operator fixes with judgment. Do NOT let sub-agents blind-edit production code. Apply each fix deliberately on the main thread under the matching operating rules (read the relevant rule for the path first), then let the next round attack the fix. A fix that the next round proves junior is not a fix.

## Output

Per round: the synthesized findings (severity, negation goal, surface, external citation, fix). On exit: the verdict (survived at iteration N, or escalated), and for a clean exit, the per-axis record of what the negators genuinely tried and could not land — that record IS the senior-staff assertion.

## Example

> "Apply the negation loop to the auth + session layer of the checkout flow."

Scout the surface (the auth middleware + session-store path), assemble the file list, run round 1, fix any CRITICAL/MAJOR with plan-before-code discipline, re-run, repeat until a clean round or cap 4. Report the exit verdict with the negators' research record.
