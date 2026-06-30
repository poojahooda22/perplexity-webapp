---
name: feedback_verify_before_claiming
description: Claude must NEVER claim what code does without reading it first. Cite file:line or admit ignorance.
type: feedback
---

NEVER make claims about code behavior without reading the actual source first.

**Why:** Claude has hallucinated implementation details during rebuttals — confidently asserting "this already does X" without reading the code. Even when occasionally correct, the pattern of claiming without verifying leads to catastrophic misdiagnosis; bugs have been misdiagnosed multiple times before someone actually read the relevant output line.

**How to apply:**
- Before saying "this code outputs X" — read the actual line and cite it
- Before saying "this function does Y" — read it, cite the line number
- Before saying "this is already handled by Z" — grep for it, confirm it exists
- If you cannot cite the line, say "I need to verify this" — never guess
- Three-source rule: verify against (1) source code, (2) memory/skills, (3) observable behavior
