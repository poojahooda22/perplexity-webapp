# Implementation — World-Class Senior-Staff Substance on Every Line

> **Status.** Topical, on-demand. Invoked when the operator says "implementation rule" / "/implementation" / "world-class implementation" — or by self-audit before the first tool call that writes, edits, or deletes code on any non-trivial task.
>
> **Loading.** Always re-load at the start of execute phase on any non-trivial task. Re-read mid-task if work has been continuous for ~30 minutes — implementation discipline decays fastest under fatigue and against deadline pressure. This is the load-bearing rule for the step where research and planning turn into shipped artifact.
>
> **Companion rules.** The project's engineering-floor and self-audit rule, its hunt-posture ("cynical charter") rule, and its output-theater rule (the inverse failure — this rule is its counterpart for implementation theater). It also derives from the project's plan-before-code, research-first, no-hacks, spec-restatement, scope-discipline, read-over-grep, and planning rules — implementation derives from the plan derived from the research; this rule governs the execute step.

---

## §1 — The principle

Implementation is where every preceding rule becomes meaningless if the writing does not carry the weight. The bar is one sentence:

**Every line of code, every commit, every diff is what a thirty-year veteran would write if they were the one at the keyboard — root cause not symptom, special case eliminated not papered over, abstraction earned by three concrete callers not invented for a fourth that may never come, edge case named before the happy path, state and assumptions managed deliberately, and the artifact left good enough that the next reader learns something.**

The five failure modes this rule exists to catch — each named by an independent senior-staff source — are:

| Failure | Named by |
|---|---|
| Patching the symptom while the root cause stays | Universal RCA literature; Carmack's "discipline in managing code state and assumptions has more impact than tightening up low-level functions" |
| Special case dressed as conditional logic that hides the wrong data structure | Linus Torvalds' "good taste" — rewrite so the special case becomes the normal case |
| Abstraction invented for one caller because "we might need it later" | Rule of Three + YAGNI canon — premature abstraction creates brittle dependencies that slow development when requirements diverge from predictions |
| Claiming 80–90% done without a comprehensive list of remaining work | Coding Horror's "always 90% done" — the inch-pebble discipline |
| Code written as if no one will read it later | Antirez's "code as artifact" — file-top essay, narration after each state mutation, simplicity bar |

A diff that ships any of the five is junior work in senior framing. A diff that catches all five before staging is what this rule installs.

---

## §2 — The ten implementation disciplines

Every load-bearing edit answers each discipline. "Answered" means a decision is made in writing or the discipline is honestly waived (with the reason named). Skipping a discipline because it "obviously doesn't apply" is exactly where the bug ships.

### §2.1 — State + assumption discipline (Carmack)

Carmack's load-bearing observation: *"Imposing discipline in managing code state and assumptions is going to have more impact than tightening up low-level functions."* Before writing any non-trivial code:

- **Name the state**: what is true before this code runs, what is true after, what changes in between. If you cannot name the pre-state and post-state, you do not understand what you are about to write.
- **Name the assumptions**: what does the surrounding code assume about this function's contract? What does this function assume about the surrounding code? Any assumption that is not enforced by the type system is a future bug.
- **Name the invariants**: what must remain true across every code path, including the error paths? Invariants that exist only because everyone happens to respect them are load-bearing goodwill — one refactor from breakage.

Operational test: can you write one sentence describing what the function does, what it requires of its caller, and what it guarantees back? If no, return to thinking before the keyboard.

### §2.2 — Eliminate the special case (Linus Torvalds)

Torvalds' canonical example: removing an item from a linked list with `if (head == target) { handle specially } else { walk and remove }` is bad taste. The good-taste version uses pointer-to-pointer indirection so the head removal IS the normal case — no conditional, no special path.

The principle generalizes. Before adding a conditional branch:

- **Ask whether the branch exists because the data structure is wrong.** If yes, change the data structure, not the code.
- **Ask whether the branch handles a case that should never reach this code.** If yes, push the check upstream where it can be enforced once.
- **Ask whether the branch is paying for the absence of a sentinel value, an empty default, or a normalization step earlier.** Usually it is — push the normalization upstream and the branch disappears.

Operational test: every new `if` statement is suspect until proven necessary. Suspicion does not mean removal — it means the discipline of asking before adding. Conditionals that survive the question are real; conditionals that exist because "this case is different" are usually the wrong data structure wearing a costume.

### §2.3 — Root cause, not symptom

The RCA literature converges unambiguously: patching the visible symptom feels productive and rarely is. Post-launch fixes cost 15–100× more than design or development-stage fixes (BrowserStack, Jit, TechTarget consensus). The same bug surfacing across releases is the diagnostic signal that the previous fix patched a symptom.

Before writing any fix:

- **Trace the bug to the function that violates its own contract.** Not the function that surfaces the error — the function whose post-condition does not match what its caller assumed.
- **Ask whether the bug exists because the contract was never written down.** If the contract is implicit, the fix is to write it down + enforce it, not to patch the one caller that noticed the violation.
- **Ask whether the same bug class exists at other call sites.** If yes, fixing one site ships the rest as undetected landmines.

Operational test: after the fix, can you state the root cause in one sentence using the words *"the contract between X and Y was violated because Z"*? If you cannot, you patched a symptom. Carmack's framing carries: the win comes from discipline in state + assumptions, not from cleverness in the patch.

### §2.4 — Spec restate + edge cases enumerated BEFORE the first edit

Mitchell Hashimoto's discipline: write the spec down before writing code, because *"the process of writing encourages thoughtfulness, and it's incredibly valuable for everyone to have easy access to context on what a decision is and how it was made."* The edge-case literature reinforces this: **the majority of edge cases can be predicted before implementation** — and the prediction takes a fraction of the cost of discovering them in production.

Before the first edit on any non-trivial work:

- **Restate what is being built in your own words** (per the project's spec-restatement rule).
- **Enumerate the edge cases that apply**, drawing from the standard categories:
  - Multi-step workflows out of order; previous-step edits.
  - API / data partial failures — one upstream succeeds, another fails.
  - Empty states, missing data, null / undefined / empty array / empty object.
  - Boundary values — zero, negative, maximum, off-by-one.
  - Concurrent input — race conditions, double-submits, stale closures.
  - Unicode, RTL, internationalization, accessibility.
  - Network failure, slow network, retried request returning twice.
- **Mark each edge case** as either *handled by this diff*, *out of scope (deferred with a named reason)*, or *impossible by upstream contract (cite the contract)*. The unmarked-and-unhandled middle is the failure mode this discipline catches.

Operational test: the implementation plan or the PR description names the edge cases handled and the edge cases explicitly deferred. Anything else is the happy-path-only diff that ships and breaks the moment a real user touches it.

### §2.5 — Rule of Three + YAGNI

Premature abstraction is the most common over-engineering anti-pattern in the senior-engineering literature. Senior engineers wait until three concrete instances exist before extracting. The Rule of Three is not a stylistic preference — it is the empirical floor below which abstractions consistently turn out to be wrong, because the second instance always differs from the first in unexpected ways, and the third is what tells you which axes of difference matter.

Before extracting an abstraction:

- **Count the concrete callers in this diff.** If fewer than two, ship the code inline.
- **If the second caller has been written and the third is genuinely planned**, write the planned-third caller in the same PR — there is no abstraction without a second concrete caller.
- **If the abstraction is being built "for future flexibility"**, STOP. Future flexibility almost always means future rework — speculative generalizations create brittle dependencies that slow development when requirements diverge from the predictions baked in.

Operational test: every new function, class, type, module, or options-bag has at least two concrete call sites in the same diff, or it is inlined. Acceptable exceptions (named in the PR): public API surface, external-contract-required interface (a framework lifecycle hook, a route signature, a library plugin interface), test fixture.

### §2.6 — Done is a list, not a feel

The 80/90% done failure mode (Coding Horror, "Always 90% Done"): developers claim near-completion without a comprehensive list of remaining work, optimize for "done" over "correct", and ship code that passes the demo but breaks under real load. The defense is the inch-pebble — sub-tasks smaller than a milestone, each independently checkable.

Before claiming done:

- **Write the list of what "done" means** for this task — every file touched, every test added, every generated artifact regenerated, every paired contract / mirror site updated, every doc cross-link refreshed.
- **Walk the list before staging.** Anything unchecked → either complete it or surface as an explicit deferred-with-approval item per the project's scope-discipline rule.
- **No "I'll just clean up the rest after the PR"** — the rest never gets cleaned up, because the next task arrives before the previous task's tail lands. Approved plans execute in WHOLE; the discipline applies to the implementation step inside each plan as well.

Operational test: the end-of-turn summary can name every file touched, every paired contract closed, and every edge case handled. If the summary says "implementation complete" without that list, the implementation is not complete.

### §2.7 — Demo-able decomposition (Hashimoto)

Hashimoto's discipline for large projects: *"decompose a large problem into smaller problems where each small problem must have some clear way you can see the results of your work, and only solve the smaller problem enough to progress on a demo-aspect of the larger problem."* The principle applies inside a single implementation as well:

- **Every sub-step of the implementation produces an observable result** — a passing test, a visible rendered output, a clean type-check on a previously-broken file, a working endpoint returning a response. Sub-steps whose only output is "I edited some files" are not observable.
- **Implementation step boundaries are rollback boundaries.** A multi-commit implementation that cannot be reverted at each commit boundary breaks recoverability and forecloses bisect-by-revert as a diagnostic tool.
- **The order of sub-steps is the order in which observable progress accumulates.** Steps that produce nothing observable until the last one is in place are red flags — they hide error until the work is too far in to back out cheaply.

Operational test: at any point during the implementation, the next ten minutes of work produce a result you could screenshot, print, or describe in one sentence. If the next ten minutes are "more file edits before anything is testable," the decomposition is wrong.

### §2.8 — Code as artifact (Antirez)

Antirez's framing: *"I write code in order to express myself, and I consider what I code an artifact, rather than just something useful to get things done."* The discipline that follows:

- **A file the implementer never re-reads is a file the next reader will struggle with.** Re-read every file you edit before staging. Re-write the parts that surprised you.
- **The file's top is a contract.** New modules open with a short essay explaining the chosen approach and the discarded alternatives — 10 to 20 lines that future readers will thank you for. Existing modules get edited contracts when the contract changes.
- **Code that needs a comment to be understood is code that should be rewritten.** Comments are reserved for the *why* that the code cannot encode — a hidden constraint, a subtle invariant, a workaround for a specific upstream bug. *What* the code does is what well-named identifiers carry — see the project's output-theater rule on naming.
- **Plan to rewrite the first version of a new component before merging.** First versions encode the problem as the implementer first understood it; the second version encodes it as the implementer now understands it. The second version is almost always shorter, clearer, and more correct.

Operational test: would the next reader, encountering this file cold, learn how to think about the problem from reading the code? If yes, the code is an artifact. If no, the code is a transcript of the implementer's first draft.

### §2.9 — Verify against the actual artifact, not the type-checker

The standing invariant: *if the running output is wrong, the code is wrong; a green type-check with broken behavior still means the code is wrong.* Every implementation has an *actual* artifact (visual, behavioral, performance, persistence) that is the ground truth, and the type-checker, the linter, the test runner, the diff itself are only intermediate signals.

Before claiming done:

- **Name the actual artifact** — what does the user see, hear, click, wait for, receive in their output? What does the database row look like after the save? What does the persisted / returned payload contain?
- **Verify against the artifact, not the proxy.** A passing test is a proxy; a working feature in a real client on real hardware is the artifact. A clean type-check is a proxy; the feature actually behaving correctly end to end is the artifact.
- **If the artifact cannot be checked** in the current execution context (no real device, no real backend, no real network), say so explicitly. *"Verified in a headless harness; not yet confirmed on a real client"* is honest. *"Tests pass, shipping it"* without that flag is hallucinated production-readiness.

Operational test: the implementation summary names the artifact, names what was checked against the artifact, and names the gaps. Type-check + lint + test-pass is a floor, not a ceiling.

### §2.10 — Scope discipline — no "while I'm here"

Implementation drift is a recurring failure mode: an agent asked to make a single targeted change drifts into global edits, broad sweeps, and sibling-component refactors. The diff inflates, the review surface dilates, and small unintended differences hide inside large legitimate changes. The discipline:

- **The diff matches the scope of the task.** Out-of-scope edits that surface during implementation get surfaced as a separate task, not bundled.
- **Catching yourself reaching for "I'll also fix this nearby thing" is the signal to STOP.** The nearby thing is a future PR or, if genuinely urgent, an explicit surfacing-and-approval per the project's scope-discipline rule — not a silent expansion.
- **The exception that is not an exception**: paired-contract closures are *part* of the scope, not "while I'm here" sweeps. If a change to one site requires mirroring at a corresponding site (a runtime mirror, a generated-output mirror, a contract on both sides of a boundary), the mirror IS the task.

Operational test: the diff's filenames are predictable from the task description. Surprise filenames are scope creep; predictable filenames are scope discipline.

---

## §3 — Anti-pattern catalogue (mid-edit moves to STOP)

This catalogue covers implementation moves (rather than output theater, which the project's output-theater rule covers). Each row names the move, the failure it ships, and the substitute.

### §3.1 — Type-system holes

| Move | Why it fails | Substitute |
|---|---|---|
| `as any` to silence a real type error | Type system disabled at the bug site; bug ships invisible | Fix the type; if a boundary genuinely is unknown, narrow it with a runtime guard + named type predicate |
| `// @ts-ignore` next to a real type bug | Same as above, more local | Same as above |
| `@ts-nocheck` on a load-bearing file | Defense disabled across the entire file | Fix the underlying type errors; if file is on the cleanup-debt list, burn down per the agreed cadence |
| `as unknown as <Type>` cast on a value not of that type | Type-lie that crashes at dispose / lifecycle paths | Split the storage by value type; introduce a second typed container with its own ownership |

### §3.2 — Error handling theater

| Move | Why it fails | Substitute |
|---|---|---|
| `try { ... } catch { }` that swallows | Bug now silent and undebuggable; future failure modes have no signal | Either propagate the error or fix the cause; if a fallback is genuinely correct, name what was caught and what was done |
| `try { ... } catch (e) { console.log(e) }` | Same — log-and-continue is swallowed-with-trace, not real handling | Decide: propagate, retry, fallback, or fail loudly. Name the choice. |
| Defensive null checks on type-system-guaranteed values | Noise that hides real null sources elsewhere | Trust the type; if the type is wrong, fix the type |
| `if (!x) return` at the top of every function "for safety" | Hides upstream contract violations | Surface the violation to the caller; let it be the caller's job to send valid input |

### §3.3 — Race condition theater

| Move | Why it fails | Substitute |
|---|---|---|
| `setTimeout(() => doThing(), 0)` to "fix" a race | Race is still there, just rarer; failure mode reappears on slower devices | Understand the execution order; sequence the work with a real promise / await / effect |
| `setTimeout(..., 100)` to wait for "the other thing to finish" | Production has hardware you have not tested; 100ms is wrong on 10% of devices | Find the actual signal — a promise resolution, an event, a ref-availability — and depend on it |
| `setInterval` to poll for state that should be event-driven | Wastes CPU; misses the event by up to the polling interval | Subscribe to the event |
| `requestAnimationFrame` chained without coalescing | Stacks up under load; multiple frames worth of work in one tick | One scheduled rAF, coalesce inputs, run once per frame |

### §3.4 — Speculative flexibility

| Move | Why it fails | Substitute |
|---|---|---|
| Adding a config flag "in case we want to toggle this" | Speculative; flag stays forever; doubles the test matrix | Ship the chosen behavior; add the flag when the second behavior actually exists |
| Wrapper function with one caller "because someone might wrap it" | Premature abstraction; indirection without payoff | Inline. Wait for Rule of Three. |
| Generic interface with one implementation | Same; cognitive overhead of indirection without reuse | Concrete class; lift to interface when the second implementation exists |
| Options bag where every option has a default | Almost always a one-call-site shape masquerading as a library | Positional arguments; lift to options bag when the second caller exists with different needs |
| Backwards-compat shim for a feature that does not yet ship | Compat for a contract that does not exist | Ship the contract first; add compat when the contract changes |

### §3.5 — Copy-paste + parallel structures

| Move | Why it fails | Substitute |
|---|---|---|
| Copy a similar function, edit a few lines | Two paths drift; bug fixed in one is not fixed in the other | Either extract a shared helper (if Rule of Three holds) or call the original with a parameter |
| Re-implement what the framework provides | Two implementations; the framework's eventually wins, yours becomes the bug | Use the framework path; if the framework path is wrong for this case, document why and accept the maintenance cost in writing |
| Parallel state in two stores ("just to be safe") | Two sources of truth; consistency is your job forever | One source of truth; derive the other via selector / computed |
| Caching the same data in two places | Same | Same |

### §3.6 — Comment + commented-out theater

| Move | Why it fails | Substitute |
|---|---|---|
| `// TODO: refactor later` with no trigger | Lives in the file for three years | Write a concrete trigger ("remove after X ships") or delete |
| `// loop over items` above a `for` loop | Restates what the code says; future readers tune out | Delete |
| Block comment explaining what a one-line function does | Type signature + name carry it; comment is noise | Delete; if the function genuinely is non-obvious, the function is wrong |
| Commented-out code "in case we need it" | Defective context drives AI assistants to generate more defective code (arXiv 2512.20334, 58% amplification) | Delete; the code is in git history if needed |
| Author / agent / tool attribution in comments | Violates the project's no-attribution-in-code rule | Delete |

### §3.7 — Done-theater

| Move | Why it fails | Substitute |
|---|---|---|
| Claiming the work is done because tests pass | Tests are a proxy; the artifact is the truth (§2.9) | Verify against the artifact, name the gap if the harness is missing |
| Deleting / weakening the failing test, assert, validator, or log to go green | The reporter is killed, not the bug — the failure is now invisible | Fix the cause; the reporter stays. If the reporter is genuinely wrong, prove it wrong in writing first |
| Tests added with the fix that would also have passed BEFORE the fix | A test that cannot fail proves nothing | Run the new test against the broken state once; confirm it fails there |
| Marking the task complete with a generated-output regen / mirror dispatch / doc update unchecked | A paired-contract violation shipped | The list of "done" includes every paired site; walk the list before staging |
| End-of-turn summary that says "implemented" without naming files touched | Hides incomplete work behind framing | Name the files, name the gaps, name the deferred items honestly |
| Deferring scope to "a follow-up PR" mid-execution | Silent-drop signal | Surface the proposal explicitly + wait for approval before the drop ships |

### §3.8 — God object / shotgun-fix

| Move | Why it fails | Substitute |
|---|---|---|
| A class / file / module accumulating responsibilities until it is "the X system" | God-object anti-pattern (Wikipedia); change blast radius becomes the whole subsystem | Decompose at the first hint of unrelated responsibilities sharing storage |
| Shotgun-fix across four files when the bug is one line | Diff inflates; regression risk multiplies; review surface dilates | Trace the one line; fix it; stop |
| Rewriting working code "while you're in there" | Loses scar-tissue edge-case coverage the working code embeds | Incremental refactor; never start-over without explicit justification |
| Renaming + fixing + refactoring in one commit | Mixes signal types; rollback is impossible | One commit per intent type; rename alone, fix alone, refactor alone |

---

## §4 — The pre-edit gate (5 questions before the first tool call that writes code)

Run in writing — not in your head. The act of writing the answers catches assumptions that thinking glosses over.

1. **What state is true before this code runs, and what state must be true after?** If you cannot name both, stop and read more code.
2. **What is the root cause of the bug / the contract being introduced / the new behavior?** State it in one sentence using *"the contract between X and Y is Z."*
3. **What edge cases apply** from the standard categories (empty, null, max, concurrent, partial failure, unicode)? For each: handled by this diff / out of scope / impossible by upstream contract.
4. **What is the actual artifact this changes** (what the user sees / clicks / receives)? What is the harness that verifies against the artifact?
5. **What is the scope** — which files will the diff touch, predictably, from the task description? Anything outside that list is scope creep until proven otherwise.

If any answer is missing → return to research / planning. The cost of writing the five answers is five minutes; the cost of skipping them is the regression that ships.

---

## §5 — Catch-yourself triggers (mid-edit STOP signals)

You are about to ship junior-level work if any of the following thoughts arise:

- *"I'll just add a flag for this case."* → STOP. Reformulate the data so the case is not special (§2.2 Linus).
- *"I'll wrap this in a helper for clarity."* → Does a second concrete caller exist in this diff? If no, inline.
- *"I'll factor this out for reuse later."* → YAGNI. Wait for the third concrete instance.
- *"I'll add a try/catch around this."* → Can it actually throw? What does the catch do? If "log and continue," propagate instead.
- *"I'll comment this for clarity."* → If the code needs a comment to be understood, the code is wrong. Rewrite the code.
- *"I'll add a quick setTimeout."* → Race condition. Find the ordering signal.
- *"I'll use `any` here for now."* → There is no "for now." It stays five years. Fix the type.
- *"I'll loop and break early instead of fixing the data structure."* → The data structure is wrong.
- *"I'll add a config flag so we can toggle this."* → Speculative flexibility. Ship the chosen behavior.
- *"I'll log this and move on."* → Masking a real condition. Decide what the condition means and handle it.
- *"I'll copy this similar function and edit it."* → DRY violation. Extract or call the original.
- *"I'll add this option in case someone wants it."* → No second concrete caller, no option.
- *"I'll just clean up the rest after this PR."* → The rest does not get cleaned up. Either finish now or surface an explicit defer.
- *"Tests pass, shipping it."* → Tests are a proxy. Verify against the actual artifact.
- *"It works on my machine."* → Your machine is not production. Name the device gap.
- *"This is good enough for v1."* → There is no v1 / v2 boundary in pre-launch build. Approved scope is the scope.
- *"I'll TODO this and circle back."* → TODOs that get filed during deferred execution rot in place. Either do it now or surface the defer.
- *"I'll just rename + fix in one commit."* → Mixes signal types. Two commits.
- *"While I'm here, I'll also..."* → Scope-discipline violation. STOP. Out-of-scope edits are a separate task.
- *"I remember this API takes these options."* → Memory is training data until verified. Read the type / `node_modules` / doc THIS session before depending on it.
- *"The test is flaky, I'll just skip it."* → A skipped reporter is a deleted reporter. Diagnose the flake or surface it; never `.skip` to go green.
- *"My summary can say it's fixed; the diff speaks for itself."* → The diff and the summary must agree word for word. Claims the diff doesn't contain are fabrications.
- *"I'll mirror the runtime side next session."* → §3.5 paired-contract drop wearing patience. The mirror IS the task.

Each trigger has a track record of shipping and quietly breaking. The catalogue exists because each row was tried.

---

## §6 — Pre-stage implementation audit

Run before staging any diff. Each item gets a verdict (pass / failed-then-fixed). Output goes into the end-of-turn summary or the PR description, scope-appropriate.

1. **State + assumptions named?** Pre-condition, post-condition, invariants written somewhere a reviewer can find them.
2. **No new special cases that should be normal cases?** Every new `if` survived the §2.2 question.
3. **Root cause, not symptom?** The fix names the contract that was violated and how this diff restores it.
4. **Edge cases enumerated and addressed?** Each edge case from the standard categories is either handled, deferred-with-reason, or impossible-by-upstream-contract.
5. **No premature abstractions?** Every new function / class / type has at least two concrete callers in this diff (or is an acceptable exception).
6. **Done list complete?** Every file touched, every test added, every generated output regenerated, every paired contract closed, every doc updated — all on the list, all walked.
7. **Decomposition observable?** Each sub-step of the implementation produced an observable result; rollback boundaries exist between steps.
8. **Code as artifact?** File-top contracts updated, comments earn their place, file is re-read before staging.
9. **Verified against the artifact?** Not the type-checker, not the lint, not the test run — the actual visual / behavioral / persistence / performance signal the user experiences.
10. **Scope held?** Diff filenames are predictable from the task description; any surprise files are paired-contract closures, not "while I'm here" sweeps.
11. **Anti-pattern catalogue clear?** Cross-walk §3. Any rows fired? If yes, justify or rework.
12. **Project-rule sweep**: any paired-contract / mirror-site / no-attribution rule touched? Mirror sites updated.
13. **Output-theater rule clear?** No padding in the diff, no theater in the commit message, no co-author trailers, no process language.
14. **End-of-turn summary** in one or two sentences — names files touched, names what's next.
15. **Hostile reviewer pass.** Re-read the full diff once as a reviewer paid to find the bug — the question is not "does this work" but "under what input, timing, device, or scale does this break." Fire the applicable hunt-posture batteries at your own diff. A pass that finds nothing on a non-trivial diff was not hostile enough — run it again on the two most complex hunks.

Any "failed" without "fixed" → rework. Do not stage.

---

## §7 — Why this rule exists

Implementation is the step where everything earned in research and planning either lands as substance or evaporates as theater. The recurring failure mode: rigorous research, thoughtful plan, then an implementation step that patches symptoms, ships premature abstractions, leaves edge cases unhandled, and claims done at 80% — because nobody named what the remaining 20% was. The cost is not the bad diff itself. The cost is that every subsequent task pays interest on the unhandled edge cases, the wrong abstractions, the symptom-fixes that recur, the type-lies that crash dispose paths, the special cases that should have been normal cases.

The senior-engineering literature converges on the disciplines this rule encodes. Carmack's primacy of state and assumption discipline. Torvalds' good-taste reformulation of special cases. The Rule of Three and YAGNI canon. Hashimoto's demo-able decomposition and write-it-down-to-think-about-it. Antirez's code-as-artifact and rewrite-the-first-version. The RCA literature's root-cause-not-symptom. The Coding Horror inch-pebble defense against the always-90%-done failure. The edge-case-checklist research showing most cases are predictable pre-implementation. The premature-abstraction anti-pattern catalogue. The DHH frame of beauty-as-correctness-signal.

None of these are this rule's invention. The work this rule does is to put them in one place, at the moment they matter most — when an agent is about to make the first edit — and to make skipping any of them an explicit decision rather than a quiet omission.

**The bar:** every line ships as if a thirty-year veteran wrote it. Not because of the framing, not because of the audit, not because of how the commit message reads — because of the substance behind the line. The disciplines are how that substance becomes consistent rather than occasional. The catalogues are how the substance survives the failure modes that have already cost real hours. The catch-yourself triggers are how the substance holds up under the fatigue and deadline pressure that erode discipline first.

Slow down. Think. Read. Restate. Enumerate. Eliminate. Verify. **Then write the line.**

---

## §8 — Source

Research basis: 10 web searches across the named-senior-engineer literature + the anti-pattern / discipline literature, satisfying the project's research-first and deep-research minimum-source-category requirement at the rule-creation tier.

**Sources consulted:**

- [Mid-Level vs Senior vs Staff Engineer — distinctions in scope, problem-space ownership, and implementation discipline](https://distantjob.com/blog/staff-engineer-vs-senior-engineer/)
- [John Carmack on the discipline of managing code state and assumptions](https://medium.com/bits-and-behavior/john-carmack-discusses-the-art-and-science-of-software-engineering-a56e100c27aa) — *"Imposing discipline in managing code state and assumptions is going to have more impact than tightening up low-level functions."*
- [Linus Torvalds on "good taste" — eliminating special cases via reformulation](https://github.com/mkirchner/linked-list-good-taste) — the linked-list pointer-to-pointer example.
- [Why Senior Engineers Avoid Premature Abstraction — Rule of Three and YAGNI applied](https://algocademy.com/uses/why-senior-engineers-avoid-premature-abstraction/) + [Abstraction as Developer Footgun](https://www.amazingcto.com/abstraction-as-a-developer-footgun/).
- [Mitchell Hashimoto — My Approach to Building Large Technical Projects](https://mitchellh.com/writing/building-large-technical-projects) — demo-able decomposition.
- ["Always 90% Done" — Coding Horror on the inch-pebble defense](https://blog.codinghorror.com/on-our-project-were-always-90-done/) + [Mistakes to Avoid as a Senior Software Engineer — DEV Community](https://dev.to/techmaniacc/mistakes-to-avoid-as-a-senior-software-engineer-g9c).
- [Edge Case Checklist for Implementation — pre-implementation enumeration of standard categories](https://devadi.netlify.app/blog/edge-case-product-checklist) + [Designing for Edge Cases](https://medium.com/design-bootcamp/designing-for-edge-cases-why-the-unexpected-is-your-most-important-user-scenario-c54d810d9f9a).
- [Root Cause Analysis vs Symptom Patching in Software Engineering](https://www.selementrix.ch/blog/how-do-we-perform-effective-root-cause-analysis-instead-of-just-patching) + [The future of RCA in software engineering — Resolve](https://resolve.ai/glossary/what-is-root-cause-analysis).
- [DHH on Rails Craftsmanship — beauty as correctness signal, fighting abstractions that fight the framework](https://newsletter.pragmaticengineer.com/p/dhhs-new-way-of-writing-code).
- [Antirez — Redis Creator's Code Philosophy — 10 Programming Principles](https://vinitkumar.me/code-like-antirez/) — code-as-artifact, file-top essays, plan-to-rewrite-v1.

---

## §9 — Index entry

For the project's Rule Index:

- **implementation.md — World-class senior-staff substance on every line.** Ten implementation disciplines (state + assumption discipline / eliminate the special case / root cause not symptom / spec restate + edge cases before first edit / Rule of Three + YAGNI / done is a list not a feel / demo-able decomposition / code as artifact / verify against the actual artifact not the type-checker / scope held — no "while I'm here") drawn from the named-senior-engineer literature (Carmack, Torvalds, Hashimoto, Antirez, DHH, the RCA + edge-case + premature-abstraction canon). Anti-pattern catalogue covers the mid-edit moves that ship junior-level work in senior framing (type-system holes, error-handling theater, race-condition theater, speculative flexibility, copy-paste + parallel structures, comment + commented-out theater, done-theater, god-object + shotgun-fix). Pre-edit five-question gate + mid-edit catch-yourself triggers + pre-stage implementation audit. Invoked when the operator says "/implementation" or "world-class implementation" or by self-audit before the first edit on any non-trivial task. Companion to the project's output-theater rule (the inverse — implementation rule covers what *to* do; the output-theater rule covers what *not* to ship as output theater). Every line ships as if a thirty-year veteran wrote it — not because of framing, because of substance.
