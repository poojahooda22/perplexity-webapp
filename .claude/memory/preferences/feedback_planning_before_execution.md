---
name: planning-before-execution
description: The operator's directive — extensive planning, note-matching, and multi-agent review BEFORE any implementation. Prevents wasted fixes.
type: feedback
---

## Plan extensively before doing anything

**Why:** During a hard-to-reproduce freeze bug, Claude proposed 5 fixes including an elaborate monitoring system (Fix 5). The operator pushed back — demanded proper analysis, sent the bug to a second-opinion model for review, and insisted on a revised plan. That review identified that Fix 5 was based on a misunderstanding of how the subsystem actually scoped its state. Without the operator's intervention, Claude would have built a useless fix while the real root cause went unaddressed.

**How to apply:**
- ALWAYS follow the project's working rules before implementation
- Match notes between Claude + any second-opinion model + the operator before executing
- Research first, plan second, execute last
- When the operator pushes back on a plan, STOP and re-analyze — the operator's instinct is usually correct
- Multiple rounds of review catch assumptions that single-pass analysis misses
- Never rush to implement — the cost of a wrong fix is higher than the cost of planning
