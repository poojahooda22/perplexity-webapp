# Learned Preferences & Workspace Facts

> Rules in this file were distilled from accumulated session experience across the project's
> code, build, and process surfaces. Each is scar tissue — a codified incident with mechanism,
> application, and rationale. Read alongside the project's other operating rules.

---

> **Loading model.** The cross-cutting rules below — scope discipline, hallucination prevention,
> read-over-grep / plan-execution / diff-truth — stay here, always-loaded, because they apply to
> ANY task regardless of subsystem. Path-specific or subsystem-specific scar tissue (the kind that
> only matters when editing one particular file or module) belongs in an on-demand detail file
> (e.g. `.claude/rules-topical/learned-preferences-detail.md`), read when the task touches that
> subsystem. Keep a one-line index of every learned rule at the bottom so you always know a rule
> exists — open the detail file for the body before editing the matching subsystem.

## Scope discipline: no broad sweeps without explicit approval

**Problem:** When asked to make a targeted change (port a visual, fix a component, wire one
feature), agents have drifted into "while I'm here" sweeps — global token edits, broad styling
changes, sibling-component refactors. The result is a diff that exceeds the requested scope,
requires extra review, and risks regressing unrelated areas.

**Rule:** **The contract for a targeted change is a strict, tightly-scoped match to what was
asked.** No global token edits, no broad styling sweeps, no sibling refactors, no "while I'm here"
cleanup. Any broader change requires explicit operator approval before the diff is staged.

**Why:** Targeted changes have an unforgiving correctness bar — the operator often verifies against
a source of truth. Sweeps inflate diff size, dilute focus, and let small unintended differences
hide inside large legitimate changes. The tightly-scoped discipline keeps the diff reviewable and
the regression surface bounded.

**How to apply:**
- Making a targeted change → match exactly. Diff stays narrow.
- Catching yourself thinking "I'll also fix this nearby thing" → STOP. Surface it as a separate
  task; do not bundle.
- The same discipline applies to all cross-system ports and localized edits, not only one kind.

**Source:** Cross-system port / scope-creep incident class.

---

## Hallucination prevention: paths that do not exist, measurements that lie

**Problem:** Two recurring hallucination classes have cost real time:
1. Citing a file as if it were in the repository when **it is not** — an invented or misremembered
   path that sends readers chasing a ghost file.
2. Treating a measurement taken on an unrepresentative harness as if it reflected real-world
   performance — e.g. a benchmark run on a software fallback / emulated path that compiles or
   executes on a different code path with very different timing than production hardware.

**Rule:**
- **Do not invent or cite a path that does not exist on disk.** Before citing a file in a plan,
  review, or commit message, confirm it is real. Catching an invented path in any draft → delete
  and replace with the actual canonical path.
- **Do not treat a measurement from an unrepresentative harness as authoritative.** State the
  harness explicitly (real hardware vs emulated/software-fallback vs headless). A performance claim
  that requires real-hardware evidence is not satisfied by a software-rasterizer / emulated run.

**Why:** Hallucinated paths produce broken citations in plans and reviews — readers chase ghost
files. Unrepresentative-as-real measurements pass surface review and ship performance reports that
are quietly wrong, eroding trust in the rigor of the codebase.

**How to apply:**
- Citing a file or policy → confirm the path is real before writing it. Catching an invented path
  in any draft → delete and replace.
- Reporting performance → state the harness explicitly. If the harness is emulated or headless, do
  not present its timings as production-equivalent.

**Source:** Invented-path hallucination incident, unrepresentative-benchmark timing incident.

---

## Read-over-grep + plan-execution discipline + diff-truth

**Problem:** Workspace-wide grep has stalled in past sessions; broad indexing tools occasionally
hang or silently fail mid-search. When a target path is known, opening it directly is faster and
more reliable than grep. Separately, when an implementation plan is attached to a session, edits to
the plan file or abandonment of plan todos for ad-hoc side work breaks the operator's review
continuity. And when summarizing commits or reporting another agent's ship status, asserting
changes that the diff does not actually contain ("removed X", "fix landed") burns trust.

**Rule:**
- **Prefer `Read` on known paths or sequential chunked reads over broad workspace `Grep`.**
  Workspace-wide search has stalled before. Use `Grep` when the target is genuinely unknown;
  otherwise read directly.
- **Plan execution discipline:** when executing an attached implementation plan, keep the plan file
  unchanged unless explicitly asked to edit it. Reuse existing plan todos. Set the first todo to
  `in_progress` while working. Drive ALL listed todos to completion before stopping. Do not abandon
  the active plan for ad-hoc side work unless explicitly reprioritized.
- **Verify summaries against diff:** when summarizing commits, ship reports, or another agent's
  work, verify each claim against the actual diff. No false "removed X", no unverified "fix landed"
  claims.
- **Iterative reviews include implementation-ready code**, not only high-level recommendations,
  when the work warrants it.

**Why:** Stalled grep wastes minutes per attempt and breaks momentum. Plan drift makes the
operator's review surface unstable — the plan they attached changes shape under their feet.
Diff-divergent summaries pollute the trust contract that makes the agent useful at all.

**How to apply:**
- Looking for a known file → `Read` the path. Looking for an unknown symbol → `Grep`.
- Working an attached plan → respect its structure, drive its todos, do not edit unless asked.
- Writing any summary that asserts "X was changed" → re-check against the diff. No memory citation;
  check the actual file.

**Source:** Search stall observations, plan drift incident class, summary verification rule.

---

## Index

The always-loaded cross-cutting rules in this file:

- Scope discipline — no broad sweeps without explicit operator approval
- Hallucination prevention — don't cite nonexistent paths; don't present unrepresentative
  measurements as authoritative
- Read-over-grep + plan-execution + diff-truth

Subsystem-specific scar tissue (path-naming conventions, module-level contracts, render/cache
disciplines, and similar) lives in the on-demand detail file and is read when the task touches that
subsystem.
