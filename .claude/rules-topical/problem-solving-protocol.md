# Problem-Solving Methodology & Quality Checklists

> **Status.** Universal methodology for non-trivial work. Read alongside the project's operating rules (plan-before-code on load-bearing work, a research-first multi-tier pipeline, no hacks) which capture the rules; this file captures the broader methodology that applies to every substantial task.
>
> **Loading.** Read this file when (a) starting any non-trivial implementation, (b) reviewing another agent's plan, (c) running a self-audit on your own work, or (d) deciding whether a task is "trivial enough" to skip planning.

---

## Mandatory Problem-Solving Protocol

Nothing is "too simple" for this protocol when the task touches a load-bearing surface. Simple-looking problems in core runtime, data, auth, or pipeline code produce broken UI, lost data, or shipped regressions. The protocol may be bypassed explicitly only when the operator has decided a task is genuinely trivial.

1. **Deep Dive** — read every relevant file, understand data flow end-to-end, map the actual problem. You are not allowed to propose a solution until you can explain the problem with precision.
2. **Generate 3-4 solution directions** — substantively different, not variations of one idea.
3. **Judge directions** — against experience, research, codebase fit, scalability, senior precedent. Produce a comparison matrix. Select winner with stated reasons.
4. **Plan in writing** — `.agents/plans/{agent}-{description}-{YYYY-MM-DD}T{HH-MM-SS}Z.md` before ANY code. Plan must include: problem statement, research findings, directions considered, selected approach with justification, implementation steps, risk assessment, verification criteria. No code touches happen until the plan exists.
5. **Execute with rigor** — implement, verify visually, test edge cases.
6. **If visual result is wrong** — go back to step 1. Do NOT patch.

For the highest-risk surfaces, the project's operating rules define the trigger paths (the load-bearing edits) where this protocol is non-negotiable.

---

## Quality Checklists

### Research

- [ ] Minimum 3 independent sources for significant claims
- [ ] First principles reasoning documented
- [ ] Counterarguments identified and addressed
- [ ] Confidence level declared (high/medium/low with reasoning)

### Code

- [ ] Researched how senior-level codebases handle this
- [ ] Performance characteristics understood
- [ ] Edge cases identified through systematic analysis
- [ ] No cargo-cult code (every line has a reason)
- [ ] Alternatives considered and rejected with stated reasons

### Architecture

- [ ] Problem decomposed from first principles
- [ ] At least 3 alternative approaches evaluated
- [ ] Trade-off matrix created for significant decisions
- [ ] Pre-mortem: "imagine this failed in 6 months — why?"

---

## Anti-Patterns (Instant Rejection)

| Anti-Pattern | Do This Instead |
|---|---|
| "Best practice" without citation | Cite source, explain why for OUR case |
| Copy-paste from tutorials | Understand the pattern, adapt to constraints |
| "It works" as proof | Prove via testing, spec conformance, edge cases |
| Premature optimization | Profile first, optimize surgically |
| Premature abstraction | Wait for 3+ concrete instances |
| Uncritical approval without analysis | Verify claims, cite sources, document what you checked |
| Generic boilerplate | Research what's specific to our scale/stack/constraints |
| Untested assumptions | Verify against specs, test empirically |
| Accepting because the other agent is "senior" | Appeal to authority — even experts make mistakes. Verify independently |
| Rebutting without counter-evidence | Unconstructive — every rejection must include a researched alternative |

---

## Why This Methodology Exists

Operators have spent long sessions watching agents produce quick patches, duct-tape fixes, and surface-level bandaids that "make it work" but build zero technical moat. The project's operating rules enumerate the specific anti-pattern fixes that have burned real hours. This methodology is the upstream discipline that prevents those anti-patterns from being reached for in the first place.

The bar: every solution would survive review by a senior engineer who would say "this is clean."
