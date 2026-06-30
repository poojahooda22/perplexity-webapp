# Red-Team Negation Loop

> On-demand. Read in full and execute when the operator invokes it. Invocation: "red-team this", "negate this", "run the negation loop", "prove this is junior", "negation strategy". This rule **absorbs and operationalizes the project's always-on hunt posture** (the cynical-review charter that governs every response): that charter is the always-loaded posture; this loop is the bounded, three-agent procedure that turns every charter question into an evidence-backed negation goal and runs it as a loop. It pairs with the project's operator-identity + evidence-ladder rule, the rebuttal/audit format, the multi-tier research method, and the deep-research rigor bar.

## What it is

A bounded adversarial loop that puts a plan, implementation, architecture decision, audit, research artifact, or any deliverable in front of a **three-member team of veteran negators** whose ONLY job is to PROVE the work is junior-level. The work is presumed mediocre until all three, after genuine evidence-backed effort, **cannot** prove it. Surviving the negation IS the senior-staff bar — not a self-review vibe, not a thumbs-up.

Three, not two, and **not split by lens.** Each negator receives the ENTIRE problem statement and the ENTIRE artifact and attacks the WHOLE thing end-to-end. They do not divide the artifact between them. The point is three independent veterans looking at the same complete target from their own vantage, so a hole one misses, another lands. Slicing the artifact between reviewers is the failure mode this rule replaced: it leaves every surface seen by exactly one pair of eyes.

## The hypothesis every negator must prove

For the artifact under review, each negator independently sets out to prove, with evidence:

> "This is junior-level, vibe-coded, mediocre work. It is not the best implementation for the real constraint, not the most scalable or performant approach, not what industry leaders actually ship, and the senior vocabulary is covering junior thinking. It will break, underperform, or balloon in cost in production."

A negator's success = proving any load-bearing part of that hypothesis with external evidence. Failure to prove it after real effort (searches run, repos read, batteries fired) = that surface has earned the bar.

## The negation goals — the inverted charter

This is the core of the rule. Every question in the project's hunt-posture charter is **inverted into a goal the negator actively tries to prove**, not merely ask. The negator does not ask "is this scalable?" — it tries to prove **it is not**, and concedes the point only when the proof attempt fails against real evidence. Each goal is itself a mini-loop: hunt, research, attempt the proof; land it (a finding) or exhaust the attempt (that axis survives). All three negators carry the full goal set; none gets a subset.

**The five core questions:**

1. **Prove it is NOT the best implementation for the real constraint (Q1).** Show it is the first thing that compiled, dressed to look considered. Find what senior-staff teams shipped for this exact problem in open source; cite `repo@sha:file:line`. Prove ours diverges, and that the divergence is naive, not a documented trade-off.
2. **Prove it does NOT scale at 10x / 100x (Q2).** Find the ceiling. Show the scaling mechanism (eviction policy, indexed query, off-the-critical-path work, caching/CDN tier, lazy-loading, scoped warmup) is assumed rather than named, documented, and enforced. Derive the break in measured numbers or first-principles math. "It will be fine" is the exact claim you are disproving.
3. **Prove the "industry standard" claim is hollow (Q3).** Name the leaders, open the repos, read the code. If 3+ independent senior-staff codebases do NOT solve it this way, the cited pattern is invented and the claim is unfalsifiable filler.
4. **Prove ours is an invented variation, not the proven pattern (Q4).** Grep our codebase, bridge each surfaced industry pattern to our `file:line`, and prove ours diverges in a way that would not survive peer review at a top engineering org.
5. **Prove the senior vocabulary is covering junior thinking (Q5).** Every "architectural concern" with no named finding, every "scalability surface" with no derived ceiling, every "correctness prior" with no edge case, every "ownership boundary" with no contract drawn — prove it is filler. Words that earn nothing from what is behind them are the tell.

**From the hunt catalogue:** sweep every category and prove the artifact exhibits it, with the specific instance and its citation — a hack wrapped in senior ceremony (e.g. a `setTimeout` to "fix" a race, a `try/catch` that swallows, an `as any`/`@ts-ignore` over a real type bug, a hardcoded `// for now`); bloated, vibe-coded volume where one line of root cause was needed; a hallucinated metric ("improves perf by N%" with no harness, "scales well" with no ceiling, "industry standard" with no industry named); a pattern cargo-cult-lifted without the constraint it solved; a violation of the project's binding rules/contracts (highest blast radius); and the AI tell — a hallucinated API/option not in the installed version, a "fix" that deletes/weakens the failing test or validator, a summary that claims a change the diff does not contain, confidence uniformity (a non-trivial change with zero `[unverified]` flags and zero open questions), a fix written against a memory of the file rather than the file on disk now, and shotgun fluency (volume read as thoroughness). An empty sweep on a non-trivial artifact means the negator did not look hard enough; re-look.

**From the interrogation battery:** fire the batteries the artifact's surfaces demand — lifecycle & state (pre/postconditions and what enforces them; called twice / concurrently / re-entrantly; frame-0 before init/first-fetch; in-flight async completing after teardown); the error path (has it ever executed; what the catch actually does; what renders on partial upstream data; what the user SEES on failure); data structures & flow (how many sources of truth after the change, who reconciles them, is the cache keyed by everything that changes the output, does a collection grow unbounded); persistence & data integrity; trust boundaries & security (where user-controlled data enters and where it's validated; authn AND authz; any secret reachable from the client/bundle/committed file); claims & evidence (the harness for every number; could the test have passed before the fix; does the summary assert anything the diff does not contain); and AI-authored code (every API/option verified against the installed version this session, the reporter not deleted, verified against the file on disk now). An applicable battery question with no answer in the artifact is an open junior-level hole, not a formality — prove it.

A negation goal the negator genuinely cannot prove against real evidence is reported as **survived**, with what was actually tried (the searches, the repos read, the question attempted). That record, accumulated across every goal and all three negators, is what an exit is made of.

## The evidence mandate (non-negotiable)

A negation claim with no external proof is **noise and is discarded.** A negator may not approve OR condemn from the top of its head. Every load-bearing claim is grounded in fact read THIS run:

- **Source of leader/top-OSS repos** — cite `repo@sha:file:line` or the file URL. Read the code; do not recall it.
- **Industry-leader engineering writing** — engineering blogs, maintainer docs, specs, conference talks, peer-reviewed papers — cite the URL.
- **Benchmarks / measured numbers** from a named source; or first-principles math with the arithmetic shown.
- The artifact's own codebase at `file:line`.

**Web search is REQUIRED, not optional.** "This won't scale" without a cited mechanism AND a prior-art reference is discarded. Symmetrically, "this is fine" with zero searches and zero source reads is a rubber-stamp — the iteration is invalid and re-run. Confidence may not exceed the evidence rung (measured > first-principles > 3+ convergent codebases > single authoritative source > single blog > training-data recall; flag the last as `[unverified]`). Fluency is not evidence: interrogate hardest exactly where the work reads smoothest.

## The loop

1. Run all three negators concurrently on the full artifact, each with the full hypothesis + the complete negation-goal set + the evidence mandate. Each covers everything; none is assigned a slice.
2. Collect evidence-backed findings: severity CRITICAL / MAJOR / MINOR, each tagged with the negation goal it lands on (Q1–Q5 / catalogue category / battery question) and its external citation.
3. **If any negator lands an evidence-backed CRITICAL or MAJOR** → the hypothesis is proven on that point → revise the artifact (fix the code; or run deeper research where the gap is knowledge, not code) → GOTO 1. The whole loop re-runs against the revised artifact, because a fix can open a new hole.
4. **If a full iteration yields no evidence-backed CRITICAL or MAJOR from any of the three** → none could prove the hypothesis → the work has reached the senior-staff bar → exit. Only now may we assert that it is in fact senior-staff engineering and the best available route.
5. MINOR findings are logged and fixed but do not, alone, fail the iteration.

**The exit is the assertion.** The work is presumed junior on every iteration and earns "senior-staff, best route" only by surviving a full round in which three independent, well-researched veterans each tried and failed to prove otherwise. We never declare quality; we declare that a genuine attack could not land.

## Termination + escalation

- **Cap at 4 iterations.** If the artifact still draws evidence-backed CRITICALs after four rounds, STOP and escalate to the operator: the problem may be mis-scoped or the approach fundamentally wrong — a goal-level issue, not a fix-level one.
- **Never weaken the hypothesis or lower the evidence bar to force termination.** Exiting because the negators got tired or sloppy is the exact failure mode this rule exists to prevent. A clean exit requires negators that genuinely tried — searches run, repos read, batteries fired — and still could not land a hit.

## Output (per negator, per iteration)

- `findings[]`: `{ severity, negation_goal (Q1–Q5 | catalogue:category | battery:category), surface, claim_attacked, external_evidence (repo@sha:file:line | url | file:line), why_it_breaks, fix_required }`.
- `verdict`: `PROVED_JUNIOR` (with the single biggest evidence-backed hole) | `COULD_NOT_DISPROVE_SENIOR` (listing what it actually tried per axis — the searches run, the repos/specs read, the goals attempted and failed).
- The lead synthesizes the three verdicts: any single PROVED_JUNIOR fails the iteration; a clean exit needs all three at COULD_NOT_DISPROVE_SENIOR with real attempts on record.

## Why this exists

A single self-review rubber-stamps its own work. A single reviewer has one blind spot. Two reviewers split by lens each see half the artifact. An un-sourced critic trades one vibe for another. Three independent, evidence-bound veterans — each attacking the whole artifact, each operationalizing the full hunt charter as goals to prove rather than questions to ask — is the cheapest way to find the break before production does. The loop converges on senior-staff quality because it exits ONLY when a genuine, well-researched attack across every charter axis cannot land. And the realest finding of all is when the negation proves the premise itself was never measured.
