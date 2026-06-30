---
name: Anti-Incrementalism Directive
description: NEVER build throwaway intermediates when the final architecture is known. 6 months runway, zero deadlines — build the production-grade version from day one.
type: feedback
---

Build the final architecture from day one. Never create phased plans where Phase N replaces Phase N-1.

**Why:** When the operator has development runway and no external deadline pressure, building a throwaway "for now" implementation when the correct final architecture is already known wastes engineering time and produces code that gets thrown away. This is the incrementalist version of junior-level work.

**How to apply:**
- If the production-grade pipeline is the final answer, build it first — not a throwaway bridge implementation
- If the scalable data structures + caching architecture are known, implement them now — not in "Phase 4"
- Dependencies that provide production-grade capabilities are assets, not liabilities
- The end-user output quality is the north star — every decision flows backward from that
- Only use the incremental approach when there are genuine unknown unknowns requiring intermediate learning
