# Rebuttal-First Peer Review Protocol

> **Status.** Topical — applies when reviewing another agent's work, plan, rebuttal, or research artifact. Not always-loaded; read this file at the start of any peer-review task.
>
> **Loading.** Read this file when (a) auditing another agent's plan in `.agents/plans/`, (b) reviewing a code diff produced by another agent, (c) responding to a rebuttal, or (d) cross-validating a research artifact (architecture memo, deep dive, post-mortem).

---

## Core Principle

When reviewing another agent's work, your DEFAULT posture is to build a research-backed rebuttal BEFORE accepting anything. You are a CTO-level peer reviewer, not an uncritical approver. **Acceptance is earned through evidence.**

---

## The Process

1. **Read the full document.** Note every claim, every assumption. Suspend judgment — do NOT start nodding along.

2. **Identify every claim that requires evidence.**
   - "This is more performant" — WHERE IS THE BENCHMARK?
   - "This is standard" — WHOSE STANDARD? CITE IT.
   - "This handles edge cases" — WHICH ONES? LIST THEM.

3. **Vet claims independently** using the project's multi-tier research pipeline. Minimum 3 independent sources for significant technical claims. Search for counterexamples and failure modes.

4. **Make an honest determination:**
   - If claims hold up → **accept with verification report** documenting what you checked and how.
   - If claims fail → **rebuttal with counter-evidence.** Every rejection must include a researched alternative.
   - If partially sound → confirm the good parts, challenge only the genuinely problematic parts.

5. **If a claim fails but the underlying concern is valid** — the concern is valuable intelligence even when the proposed fix is wrong. Don't dismiss the concern because the solution was bad. Understand the concern, devise a better solution yourself. Always synergize and move toward the strongest technical outcome.

---

## Why This Stance Matters

**Acceptance without analysis is unacceptable.** Even acceptance must document what you verified and how. Uncritical approval misses subtle flaws — the dangerous kind that look correct, compile, pass surface review, but carry hidden assumptions.

The team's credibility is worth more than any seat's ego. Welcoming a rebuttal that catches something real is the right response. Defensiveness, re-framing to save face, or appeal to authority ("I'm the senior agent") is junior work.

---

## Rebuttal Format (when rejecting)

When you reject another agent's claim or recommendation, the rebuttal artifact lives in `.agents/rebuttals/{your-agent}-vs-{their-agent}-{topic}-{YYYY-MM-DD}T{HH-MM-SS}Z.md` and contains:

1. **The claim being rejected** (verbatim).
2. **Why it fails** — cite the failure mode (incorrect spec, missing edge case, unverified assumption, etc.).
3. **Counter-evidence** — minimum 3 independent sources or first-principles derivation.
4. **The better alternative** — concrete, implementable, with its own evidence base.
5. **Honor the underlying concern** — if the original concern was valid, name it and incorporate it into the alternative.

Rebuttals without counter-evidence are unconstructive — see anti-pattern table in `problem-solving-protocol.md`.

---

## When to Skip the Protocol

- Trivial accept (typo fix, comment edit, formatting) — surface judgment is fine.
- A direct-action instruction from the operator — execute without peer review unless the operator explicitly requests it.
- You authored the work — self-audit instead of peer review.
