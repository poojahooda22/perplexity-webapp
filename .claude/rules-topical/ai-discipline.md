# AI Agent Discipline Rules

> **Status.** Distilled from a 100-source audit of AI-coding failure modes spanning named senior engineers (Mario Zechner, Linus Torvalds, Mitchell Hashimoto, John Ousterhout, Antirez, Filippo Valsorda, David Crawshaw, Charity Majors, Kent Beck, Martin Fowler, Andrej Karpathy, DHH, Casey Muratori, Thomas Ptacek, Birgitta Boeckeler, Brian Goetz, Armin Ronacher, Addy Osmani, Sean Goedecke, Steve Yegge, Geoffrey Litt, Geoff Huntley, Joel Spolsky, Hillel Wayne), peer-reviewed empirical research (~30 arXiv papers), documented production incidents (Replit, PocketOS, $4,200 / $47K agent loops), and primary-source vendor engineering posts (Anthropic, Cloudflare, OWASP).
>
> **Scope.** Rules in this file apply to **every code change** in this repository where an AI agent contributed to the diff — drafted, edited, restructured, or merely suggested code that landed. They are read alongside the rest of the project's operating rules and override nothing in the existing topical files; they extend the discipline to the AI surface specifically.
>
> **Loading.** Read this file alongside the agentic-discipline and git/IP rules on every code change. The project's router and rule index reference this file.
>
> **Operational stance.** The rules below codify what 100 sources independently converge on: AI agents amplify whatever discipline is already present. Without these rules, the agent's defaults — pattern-fill from internet code, premature abstraction, tautological tests, surface-polish-without-substance — become the project's defaults. With them, the agent's strengths (speed, breadth, willingness to iterate) compound on a foundation that holds up under the rigor a serious production org demands.

---

## Author-of-record on every PR

**Problem:** AI-generated code without a named human owner is orphan code. When the diff breaks production six months from now, no one can answer "why is this here, what is it supposed to do, what edge cases were considered?" — the agent is stateless, the human merger has moved on, the context is lost. Antirez (Salvatore Sanfilippo) frames the resolution: "I'm a programmer, and I use automatic programming. The code I generate in this way is mine. My code, my output, my production." Linus Torvalds and the Linux kernel maintainers landed in April 2026 on the same position: the submitting human bears complete responsibility regardless of who or what typed the characters.

**Rule:** **Every PR description names a single human author-of-record who claims full ownership of the diff.** That human asserts in writing, on the PR, that they have read every line of the diff and would defend every decision under questioning in a code review. AI-generated code that no human will defend does not merge.

**Why:** Ownership is the load-bearing constraint that prevents the entire AI failure stack downstream. Without a named owner, the agent's mistakes have no one accountable for catching them; with a named owner, every other rule in this file becomes enforceable because there is a person on the other side of the rule. Linus's distillation — "disclosure is less important than competence; if you understand the code and can stand behind it, the tool is irrelevant" — is the operating principle.

**How to apply:**
- PR template includes an explicit "Author-of-record:" line. The named human is on the team and has commit access.
- For PRs touching critical paths (see "Critical-line ownership manifest"), the author-of-record cannot be the same person who only ran the agent — they must be someone who has read the produced diff line-by-line and would defend it.
- If no human will own the diff, do not open the PR. Iterate or escalate.

**Source:** the AI-slop audit entries on Antirez, Linus / Linux Kernel, Phoronix coverage, Thomas Ptacek, Stack Overflow trust gap.

---

## Critical-line ownership manifest

**Problem:** Mario Zechner's distilled rule is "if it's critical, read every line; if it's important, write it by hand." The 100-source corpus converges on this: AI productivity gains are real for bounded, verifiable, non-critical tasks (Ptacek, Goedecke, Hashimoto), and AI failure rates are catastrophic on critical paths (55.8% of AI security code is vulnerable; even AI-generated cryptographic code in memory-safe languages is unsafe; production database deletions). Every repo has a small set of paths where a single bad merge ships visible regression to every user or destroys user work; on those paths the AI productivity multiplier is not worth the failure-rate multiplier.

**Rule:** **Each project designates a small set of CRITICAL paths. Every line that lands in any of these paths is reviewed line-by-line by the author-of-record during the agent session that produced it. Agents author the code; the agent does NOT merge without a live human read-through of every line.**

A path is CRITICAL when it satisfies any of:

1. **Ships to every user** — published/distributed artifacts, package exports, runtime libraries every consumer imports, generated/emitted output that ends up in user downloads.
2. **Governs a trust boundary** — input sanitization, the publish/upload pipeline, auth and session/secret handling, database migrations and row-level-security policies, anything between untrusted input and stored data.
3. **Determines correctness across the whole product** — the canonical render/compute pipeline, core processing stages, and any load-bearing public API surface.

Enumerate the concrete files/globs that meet these tests in the project's own rule/config so the manifest is explicit and greppable; do not leave "critical" as a vibe.

**Why:** Each such path either ships to every user, governs the trust boundary between user input and stored data, or determines correctness across the entire product. One bad merge to any of these paths is felt simultaneously by every user. The empirical floor on AI-generated security code is ~48% vulnerable. The operational defense against that floor is the author-of-record's continuous line-by-line review during agent sessions on these paths — on a small team composed largely of agents, "humans author all critical-path code" would mean near-zero throughput, so the durable control is a human's eyes on every critical-path character before merge, not human authorship.

**How to apply:**
- Agent sessions on critical paths are interactive — the reviewer reads each diff as it lands.
- The agent's end-of-turn summary explicitly names every file touched and every section changed, so the reviewer can confirm coverage of the read.
- Major architectural moves get an explicit "is this what we want?" gate from the agent before any code lands.
- If the reviewer is not in the session, critical-path changes wait for the next live session — they do not auto-merge.

**Source:** the AI-slop audit entries on Mario Zechner, DHH, cryptographic-code studies, "Broken by Default" (55.8% vulnerable), Security Vulnerabilities CWE empirical, the Replit incident, the PocketOS incident, AI build code quality. Team-fit note: live-review semantics replace human-only-authorship for an all-agents-with-live-review team; revert toward human-authorship when team size makes async review necessary.

---

## Spec-restatement gate before implementation

**Problem:** Mario Zechner's central thesis: "A sufficiently detailed spec is a program. If there are gaps in your spec, the model fills them" — with internet-trained patterns: abstraction layers nobody asked for, duplicated logic, backwards-compat shims for scenarios that don't exist. arXiv 2409.20550 quantifies it: **36.66% of LLM hallucinations come from misunderstood requirements.** The agent does not know it has misunderstood. The user does not know either, because the agent's confident output looks correct.

**Rule:** **Before implementing any non-trivial feature, the agent restates the spec in its own words. The reviewer (the author-of-record) verifies the restatement matches intent before any code is written.** A "non-trivial feature" is any task that touches more than one file, lasts more than 30 minutes of agent time, or affects user-visible behavior.

**Why:** Restating the spec catches the gap before the gap becomes garbage code. This generalizes the engineered-prompt / plan-restatement protocol the project already requires on its highest-risk work. The cost is one round-trip; the savings is the entire downstream debug cycle when the agent's hallucinated spec ships and breaks something nobody specified.

**How to apply:**
- Every written plan opens with a "Restated intent:" section. The agent writes it; the human verifies it.
- For tasks executed without a written plan, the agent's first message names what it understood the user to want. The user confirms or corrects before any tool call that writes code.
- Restatement that drifts from the original is a signal the spec was ambiguous; the answer is to clarify the spec, not to accept the drift.

**Source:** the AI-slop audit entries on Mario Zechner (spec-as-program), Kent Beck (augmented coding), arXiv 2409.20550 (36.66% requirement-violation hallucinations), ForgeCode (Simple Over Easy), arXiv 2604.18228 (agentic spec formalization).

---

## Hallucinated-shim quarantine

**Problem:** When an agent fills spec gaps, the most common form is a wrapper, factory, abstraction layer, options bag, or backwards-compat shim that no real caller asked for. arXiv 2603.28592 ("Debt Behind the AI Boom") found code smells account for **89.3% of all issues** introduced by AI coding assistants across 302K commits in 6,299 GitHub repos. Of those smells, premature abstraction is dominant — a wrapper around one call site, a factory with one product, a generic interface with one implementation. The cost: future readers (human or agent) spend time understanding indirection that has no purpose, and the abstraction calcifies before anyone realizes it should not have existed.

**Rule:** **Every new abstraction layer (wrapper function, factory, options bag, generic interface, backwards-compat shim) introduced by an agent must cite a second concrete caller in the same PR.** If only one caller exists, the code ships inline; the abstraction is rejected as premature.

**Why:** This is the rule-of-three applied at the agent-PR boundary. The discipline of "wait for three concrete instances before abstracting" is harder to maintain when the agent can generate the abstraction in a single call; this rule restores the discipline by making the second-caller a precondition, not an afterthought. The project's anti-pattern guidance already prohibits premature abstraction; this rule operationalizes it.

**How to apply:**
- Code review checklist: any new function, class, type, or module added by the agent — does it have ≥2 concrete callers in the same PR?
- Existing abstractions are fine; this rule fires only when the agent introduces new ones.
- Acceptable exceptions (must be named in the PR): public API surface (package exports), an interface required by an external contract (a framework's lifecycle, route signatures, a third-party API shape), test fixtures.

**Source:** the AI-slop audit entries on Mario Zechner (abstraction layers nobody asked for), Birgitta Boeckeler (gen AI amplifies indiscriminately), arXiv 2603.28592 (89.3% code smells), ForgeCode (Simple Over Easy), and the project's anti-pattern guidance.

---

## Three-criteria gate before agent assignment

**Problem:** Most AI failure stories share a structure: a task was assigned to an agent that did not satisfy the three criteria for agent-suitable work. Mario Zechner names them; Thomas Ptacek names them; Sean Goedecke names them; the SWE-Bench Pro paper demonstrates them empirically — agents collapse on long-horizon, ambiguous, irrecoverable work. Assigning unsuitable work is the single biggest source of slop.

**Rule:** **Before assigning a task to an agent, three criteria must be satisfied:**
1. **Scoped** — the task can be bounded in writing; the relevant context fits in the agent's window.
2. **Verifiable** — success has a function that returns true/false (test passing, type check clean, visual diff against reference, lint clean).
3. **Recoverable** — failure can be undone without permanent data loss or shipped-customer regression.

**If any criterion fails, the task escalates to a human or splits into sub-tasks each of which satisfies all three.**

**Why:** Mario, Ptacek, Goedecke, and the empirical SWE-Bench Pro literature all converge on these three. Tasks that violate any criterion are the source of the failures named throughout the corpus: hallucinated specs (violation of "scoped"), "looks done" deception (violation of "verifiable"), and production incidents (violation of "recoverable"). Codifying the gate prevents the ambient temptation to "just have the agent try it."

**How to apply:**
- Before invoking an agent for any task longer than a single edit, check the three criteria explicitly. If unsure, write them down.
- Critical-path edits automatically fail "recoverable" and escalate to the live-review path.
- Tasks that fail "scoped" because the agent's context window will not hold the relevant code → split into bounded sub-tasks per file or subsystem (see "Long-horizon escalation").

**Source:** the AI-slop audit entries on Mario Zechner, Thomas Ptacek, Sean Goedecke (theory building; code review skill transfer), arXiv 2509.16941 (SWE-Bench Pro long-horizon), and production agent-loop incidents.

---

## Hard limits on every agent run

**Problem:** Two real-world incidents from the corpus: an agent looped "Plan → 429 rate-limit → re-plan" for 63 hours and burned $4,200 in tokens; separately, two agents cross-referenced each other's outputs in a recursive loop for 11 days, $47,000 API bill. Both had no hard limits. Neither was stopped by the model's self-regulation, neither was stopped by approval fatigue, both were stopped by the engineer noticing the credit-card alert. Geoff Huntley's Ralph Loop demonstrates the productive flip-side — iterate-to-convergence works when iteration is bounded; without bounds, the same loop becomes the failure.

**Rule:** **Every agent invocation in CI, automation, scheduled jobs, or long-running interactive sessions carries explicit hard limits:**
1. **Max iterations** — agent halts after N tool-call cycles regardless of state.
2. **Max wall-clock time** — agent halts after T minutes regardless of progress.
3. **Max token budget** — agent halts after K tokens (input + output) regardless of completion.

**Exceeding any limit hard-stops with a paged human-visible alert. Never rely on the model's self-regulation to decide when to stop.**

**Why:** Self-regulation does not work at scale. Anthropic's own engineering observed "context anxiety" — Sonnet 4.5 would wrap up tasks prematurely as it sensed the context limit; a later model fixed this but introduced its own variant. The model's stop-condition is a signal, not a guarantee. Hard limits at the harness level are the only durable answer.

**How to apply:**
- Long-running scripts in automation/CI/hooks that invoke models declare their three limits at top-of-file as constants.
- Interactive agent sessions on critical paths carry an explicit user-set time limit declared at the session's start.
- Limits are tuned to be generous-but-finite, not unconstrained. A "no limit" loop is forbidden.

**Source:** the AI-slop audit entries on Geoff Huntley's Ralph Loop, the $4,200 / $47K production loops, approval fatigue, Anthropic context anxiety, Anthropic effective context engineering.

---

## Goal-anchor on long agent tasks

**Problem:** David Crawshaw (Tailscale CTO, ex-Go core) named the central failure of long agent runs: **context drift.** "An agent might successfully complete each sub-task in isolation while producing an end result that fails to cohere." The agent's local correctness compounds into global incoherence as the original goal gets gradually displaced by the cumulative weight of intermediate state, error recoveries, and false starts. arXiv 2308.02828 confirms LLM output is non-deterministic across runs even with identical inputs; the goal at iteration N may not match the goal at iteration 1.

**Rule:** **Every agent task lasting more than 30 minutes records the original goal at top of context AND requires the agent to re-state the goal in its own words at every major iteration boundary (after each major file edit or each multi-tool sub-task).** Drift between the original goal and the restated goal is detected as it happens, not after the diff lands.

**Why:** Restatement is cheap (one sentence per iteration); drift detection is expensive after the fact (full diff review, mental reconstruction of intent). The cost asymmetry favors enforcement at the iteration boundary. Crawshaw's own 8-month deep dive concluded that effective agent use requires *more* engineering skill, not less; this rule is one of the operational expressions of that.

**How to apply:**
- Plan documents open with a "Goal:" line. The agent re-reads it at each major step.
- For interactive sessions, the user names the goal at the start; the agent restates it before any tool call that writes code.
- Drift caught early is corrected by rewriting the goal explicitly. Drift accepted silently becomes the next spec gap.

**Source:** the AI-slop audit entries on David Crawshaw, Mario Zechner (context window), "Lost in the Middle" (context degradation), Anthropic effective context engineering, arXiv 2308.02828 (non-determinism).

---

## AI as diagnostic and drafter under live review on critical paths

**Problem:** Filippo Valsorda (Go cryptography lead, ex-Google Security team) used an AI agent to debug a non-obvious low-level issue in his ML-DSA implementation — and was explicit about the discipline that made it work: "I'm not directly using the model's solutions to the bugs… I find it useful for tracking down the cause and saving debugging work." The model is fast at search and pattern-recognition; the model is unsafe at writing the fix unsupervised because the empirical security floor on AI-generated code is ~48% vulnerable. Valsorda's discipline — diagnose with AI, fix by hand — is what makes AI productive on a critical path without inheriting the failure mode.

**Rule:** **On critical paths, agents author the code under live human supervision. The operational discipline is:**

- Agent reads the call chain and builds the mental map
- Agent surfaces hypotheses for diagnoses (the strong-mode use of AI)
- Agent drafts and authors the fix
- Agent explains the fix in its end-of-turn summary so the reviewer can spot-check (what changed, why, what could break, what edge cases were considered)
- The reviewer reads every line live during the session
- Agent commits only after the reviewer's explicit line-by-line acknowledgment

**The cost of getting it wrong on a critical path is shipped regression to every user. The defense is the reviewer's continuous review, not human-only authorship.**

**Why:** Critical paths get AI's strengths (search, breadth, hypothesis generation, fast drafting) *and* the reviewer's strength (whole-system architectural judgment + line-by-line reading of the actual diff). Valsorda's original "diagnose with AI, fix by hand" framing assumed a 1-person workflow where the human owned the keyboard for the fix. The team-fit reframing for an all-agents team: "diagnose AND draft with AI, but every line passes through the reviewer's eyes before merge." Same defense (a human's eyes on every critical-path character), different operator (the reviewer reads instead of types).

**How to apply:**
- Agent presents the diff in chunks the reviewer can read; doesn't bulk-commit 200 lines without acknowledgment.
- Patterns characteristic of AI authorship on critical paths (over-comments, defensive try/catch, generic naming) are explicitly surfaced in the end-of-turn summary so the reviewer can decide whether to keep them or rework them.
- The "diagnostic vs author" distinction is no longer enforced — what matters is whether the reviewer has seen every line.

**Source:** the AI-slop audit entries on Filippo Valsorda, "Broken by Default", cryptographic-code studies, CWE empirical, build code quality.

---

## No agent-driven rewrites of working code

**Problem:** Joel Spolsky (2000) named the pattern that LLMs amplify: "Things You Should Never Do, Part I — don't rewrite from scratch." Crufty-looking code embeds hard-earned knowledge about edge cases and bugs; rewriting throws that knowledge away. AI agents propose rewrites readily — the temptation to "let the agent rewrite this whole module, it'll be cleaner" is high, and the cost (lost edge-case knowledge, regressions in the long tail of the existing code's invariants) is invisible at PR time.

**Rule:** **Agents may refactor (incremental, behavior-preserving) but not rewrite (start-over, replace-all). PRs that delete more than 50% of a file's existing lines and replace them with new content are flagged as rewrites and require explicit human authorship of the new content with a written justification of why a rewrite was preferable to incremental refactoring.**

**Why:** This rule prevents the failure mode where the agent's "cleaner" output silently sheds edge cases the existing code handled. Mature, load-bearing modules are dense with scar tissue — comments, variable names, and code paths exist because of specific past incidents recorded in the project's learned preferences. A rewrite that "looks cleaner" almost certainly drops some of that scar tissue.

**How to apply:**
- CI step that flags PRs with >50% deletion in any single file outside trivial cases (deleted file, generated file).
- Flagged PRs must contain in the description: (a) why a rewrite was preferred, (b) what edge cases the new code handles that the old one did, (c) the test that demonstrates parity with the old behavior.
- "Agent says it's cleaner" is not a justification.

**Source:** the AI-slop audit entries on Joel Spolsky (Things You Should Never Do), Martin Fowler (Research, Review, Rebuild), Birgitta Boeckeler (amplification), GitClear (8x duplication), Peter Naur (programming as theory building).

---

## Test discipline for agent-authored tests

**Problem:** Three independently-converging findings: (a) Kent Beck observed that AI agents will *delete tests to make them pass* if not constrained — the failure mode TDD-with-AI must guard against; (b) arXiv 2602.00409 found AI-generated tests achieve only **20.32% mutation score** — roughly 80% of bugs slip through; (c) arXiv 2603.13724 found agent-generated tests skew toward happy paths and systematically under-test boundary conditions (zero, null, off-by-one). The result: an agent-authored test suite with high coverage numbers and zero protective value. We cannot trust passing tests as a quality signal when the agent generated both the tests and the code under test.

**Rule:** **Two-clause discipline on agent-authored tests:**

**(a) No test deletion in agent diffs.** CI fails any PR where an agent-authored commit removes a test file or removes assertions from existing tests, unless the commit message contains an explicit `[remove-test]` tag *with* a written justification. The default is: if a test fails, the *code* needs fixing, not the test.

**(b) Edge-case checklist on every agent-authored test file.** The agent's end-of-turn summary names which edge cases the new tests cover from the standard set: zero, negative, max-value, null, undefined, empty array, full array, unicode, concurrent input, stale state, network failure (where applicable). Missing categories are explicitly justified or the test is not done.

**Why:** Without this rule, agent-authored tests are a coverage-theater asset that creates false confidence. With this rule, agent-authored tests have to cover the cases bugs hide in (edge-case checklist), and the agent cannot make a failing test pass by deleting it (no-deletion rule).

**Mutation-test gate (optional, tooling-dependent):** a stronger form of this rule adds a mutation-test gate (e.g. >50% mutation score) using whatever mutation-testing tool is operational for the project's language/test-runner. Where the mutation tool is incompatible with the current test-runner version, the gate is deferred until tooling support lands; until then, clauses (a) + (b) plus the slop-detection step are the operational test-quality gates. Track the deferral explicitly rather than dropping the intent.

**How to apply:**
- Pre-commit hook flags deletion of test files or of `it(`, `test(`, or `describe(` blocks; the commit fails unless the message tags `[remove-test]`.
- Agent's end-of-turn summary for any new test file lists which edge cases were tested.
- Mutation testing as a third defense is tracked separately for future enablement when tooling allows.

**Source:** the AI-slop audit entries on Kent Beck (Augmented Coding), arXiv 2602.00409 (Over-Mocked Tests, 20.32% mutation score), arXiv 2603.13724 (happy-path bias), arXiv 2510.09907 (Agentic Property-Based Testing). Team-fit note: the mutation gate is deferred where upstream tooling lags the current test-runner.

---

## Strict typing on agent-touched files

**Problem:** Local audits routinely surface files with type-checking suppressed (`@ts-nocheck` and equivalents), including load-bearing ones in publish/upload pipelines and distributed package wrappers. Turning type-checking off file-by-file is the equivalent of disabling smoke alarms one room at a time. arXiv 2510.26103 found untyped languages (e.g. Python with no strict types) had a 16-18% AI-generated vulnerability rate; strict-typed TypeScript had 2.5-7% — **the type system is the largest defense available against AI-generated bugs.**

**Rule:** **Three-clause discipline on type strictness (for any typed language the project uses):**

**(a) Blanket type-suppression is forbidden in agent-touched files.** New agent-authored files cannot ship with file-level type-checking disabled (`@ts-nocheck` or equivalent). Existing suppressed files are tracked in a debt list and burned down on a quarterly schedule; the load-bearing ones (publish/upload pipeline, distributed package wrappers) clear first.

**(b) Escape-hatch casts require an inline justification comment.** Every `as any` (and equivalent: `as unknown`, `// @ts-ignore`, `// @ts-expect-error` without a tracked issue) carries a one-line comment naming the boundary it crosses (an untyped third-party surface, parsed JSON of unknown shape, a framework escape hatch). Casts without justification fail review.

**(c) Lint-disable requires an inline reason.** Every `eslint-disable-next-line` / `eslint-disable` block (or the equivalent linter pragma) carries a comment naming the rule being silenced and why. Bulk silencing is forbidden.

**Why:** Strict typing is not a stylistic preference here; it is the empirical defense against the largest source of AI vulnerabilities. The corpus is unambiguous: strict-typed languages have ~3-7× lower AI vulnerability rates than untyped languages. Every blanket suppression is a hole in the defense.

**How to apply:**
- CI step that scans for new blanket type-suppressions outside the tracked debt list; fails PRs that introduce them.
- A custom lint rule that fails on escape-hatch casts without a preceding comment line.
- Quarterly burndown: open one PR per quarter that removes 2-3 files from the suppression-debt list by fixing the underlying type errors.

**Source:** the AI-slop audit entries on arXiv 2510.26103 (language-strictness vulnerability rates), "Broken by Default" (formal verification), Niki Vazou (formal methods), and local audit findings.

---

## Long-horizon escalation: split, don't run

**Problem:** arXiv 2509.16941 (SWE-Bench Pro) demonstrated that AI agent success rates collapse on long-horizon tasks — patches across multiple files, hours of human-equivalent work, multi-step planning. Mario Zechner's "scoped" criterion (see "Three-criteria gate") names the same constraint: agent context windows do not hold the relevant context for a multi-hour task. The $4,200 / $47,000 production loops all started with insufficiently-bounded long-horizon assignments. The fix is structural: split the task into bounded sub-tasks before assigning, not after the agent has spent six hours wandering.

**Rule:** **Agent tasks projected to take more than 2 hours of human-equivalent work are split into bounded sub-tasks before assignment.** Each sub-task must independently satisfy the three criteria (scoped, verifiable, recoverable). Hand-offs between sub-tasks happen at human-checkable boundaries (a passing test, a clean type-check, a visual diff against a reference).

**Why:** The empirical floor is clear: AI agents work for bounded sub-tasks; AI agents fail for unbounded long-horizon work. The split-before-assign discipline converts a high-failure-rate task class into a sequence of low-failure-rate task classes with checkable hand-offs.

**How to apply:**
- For any task estimated >2h, the planning doc opens with a "Sub-tasks:" section listing the bounded sub-tasks and their hand-off criteria.
- "Have the agent figure out a multi-hour refactor" is forbidden as a workflow; refactors at that scale require a written plan with bounded sub-tasks (the project's planning rules already require this for its highest-risk work; this generalizes it).
- Long-running interactive sessions get explicit checkpoints at sub-task boundaries (see "Goal-anchor").

**Source:** the AI-slop audit entries on arXiv 2509.16941 (SWE-Bench Pro), production loop incidents, Mario Zechner (three criteria), Operator Collective lessons, Linux kernel discipline.

---

## No-skip-review on AI-touched diffs

**Problem:** Stack Overflow's 2026 survey found 96% of developers don't fully trust AI-generated code is correct — yet **fewer than half review AI-generated code before committing**, and 38% say it's because review takes longer than reviewing colleagues' code. The verification debt grows. Lightrun's 2026 report found 43% of AI-generated changes still need debugging in production after passing QA and staging. Birgitta Boeckeler's "gen AI amplifies indiscriminately" closes the loop: unreviewed AI code amplifies whatever was wrong with it.

**Rule:** **Live human review.** **Every AI-touched code change is reviewed by the author-of-record before it lands on the default branch. In an all-agents / live-reviewer workflow, review is continuous during the agent's session — the reviewer is the live reviewer of every diff as it forms.** The formal "PR-template documented review with reviewer-checks-off" async pattern is deferred until team size makes async review necessary.

**The operational gate:** NO code lands on the default branch without a human having seen the changes in real time during the session that produced them.

**Why:** Verification is the load-bearing defense against the AI failure modes named throughout the corpus. On a live-reviewer team, verification is continuous live-review rather than async PR-template review. The *substance* — "every line a human saw" — is preserved; the *bureaucracy* — "PR template fields filled in", "reviewer comment on every chunk", "24-hour cooling period" — is dropped because the reviewer is in the session as the work is being produced.

**How to apply:**
- Agent sessions on the default branch or on critical paths are interactive with the reviewer in the loop.
- "Agent ran tests, ship it" without a human's eyes on the diff is not a path that exists.
- Long-running autonomous agent runs (with hard limits) escalate back to the reviewer before merge.
- If async PR review becomes necessary (team scales, reviewer unavailable for a stretch), this rule re-tightens to the structured-review form. Until then, live-review is the operational gate.

**Source:** the AI-slop audit entries on Birgitta Boeckeler, Lightrun State of AI Engineering, Stack Overflow trust gap (and the deeper analysis), Armin Ronacher (agent psychosis), the productivity longitudinal study. Team-fit note: live-review semantics replace the async-PR-template documented-review pattern for an all-agents-with-live-supervision team.

---

## Architectural-claim flag on data-flow diffs

**Problem:** Addy Osmani and the broader code-review-in-the-AI-age literature converge on a specific hazard: AI generates code that *looks polished at the surrounding-code level* and contains *load-bearing mistakes at the architectural level*. Data flow, storage, auth, cross-process boundaries, transaction semantics, retry behavior, error propagation — these are exactly the categories where the surface-polish illusion is most dangerous. Reviewers under-scrutinize because the boilerplate is good; the architectural error slips through.

**Rule:** **When an agent's diff touches any of the following categories, the agent surfaces the architectural questions explicitly in its end-of-turn summary so the reviewer can answer them live, before the change lands:**

- Data flow (where does this state live, who reads it, who writes it, what's the consistency model)
- Storage (what's persisted, what's transient, what's the schema migration impact)
- Auth (what role can do this, where's the check, what's the failure mode)
- Cross-process boundaries (worker ↔ main, server ↔ client, agent ↔ harness)
- Transaction semantics (what's atomic, what isn't, what happens on partial failure)
- Retry / backoff (what triggers retry, how many times, what's the failure path)
- Error propagation (where does this error surface, who catches it, what's the user-facing behavior)

**For each touched category, the agent's summary answers in writing what the change does on that dimension.** If the category applies, the answer is mandatory. If no category applies, the section is omitted.

**Why:** The categories above are where the empirical AI failure rate is highest because they require whole-system understanding the agent does not have. Surface-polish at the file level hides architectural mistakes at the system level. Forcing an explicit written answer at end-of-turn converts the surface-polish illusion into a question the reviewer has to answer with eyes on the architecture, not just on the diff.

**How to apply:**
- Agent end-of-turn summary template includes the architectural-claim section IF the diff touches any flagged category.
- Empty answers fail merge; "TBD" answers fail merge — the agent reads the relevant code and answers before claiming the task is done.
- The PR-template structured-review formality (the async form of this rule) is deferred along with no-skip-review — the substance is the reviewer's live answer, not a checkbox in a template.

**Source:** the AI-slop audit entries on Addy Osmani (code review in the age of AI), Birgitta Boeckeler (amplification), arXiv 2602.21806 (Self-Action stage failures), arXiv 2604.03196 (code review agent industry vs reality), Cloudflare 7-agent code review. Team-fit note: surface-in-end-of-turn-summary semantics replace PR-template-fill, consistent with the live-review framing.

---

## No commented-out code merges

**Problem:** arXiv 2512.20334 ("Comment Traps") demonstrated that defective commented-out code in context causes AI assistants to generate **up to 58.17% more defective code.** The agent reads commented-out lines as a pattern to extend, not as deprecated code. Codebases with commented-out experimental code amplify AI failure rates significantly — the agent inherits dead patterns and writes new code that mimics them.

**Rule:** **No commented-out code in any commit. Commented-out lines that appear to be code (not explanatory comments) fail CI.** If code is dead, it's deleted; if it might come back, it lives in a branch or revert commit; if it's an alternate implementation under consideration, it lives in a planning document, not in the source tree.

**Why:** The 58% defect amplification is the strongest single-paper signal in the corpus for an automatable rule. Commented-out code is also a maintenance signal worth fighting on its own merits — but the AI-amplification angle elevates it from preference to load-bearing.

**How to apply:**
- CI lint rule (custom) that detects commented-out code via heuristic: lines starting with `// ` followed by a token that ends in `(`, `=`, `;`, `{` or matches common code patterns.
- Justified exceptions: explanatory comments that quote a single-line code example for documentation. These are recognizably different from "I left this here in case I need it."
- Burn-down: existing commented-out code is added to a debt list, cleared incrementally during normal feature work.

**Source:** the AI-slop audit entries on arXiv 2512.20334 (Comment Traps, 58% amplification) and the project's type-lie / hallucination-prevention discipline.

---

## Re-run-the-output verification

**Problem:** arXiv 2512.22387 ("AI-Generated Code Is Not Reproducible") found **31.7% of AI-generated projects fail to execute reproducibly** — failures stem from malformed syntax, incorrect file paths, uninitialized variables. arXiv 2308.02828 confirmed LLMs return non-deterministic results across runs even with temperature=0. The agent generated working code once; the rebuild fails. The agent's "tests pass" claim is a single observation, not a repeatable result.

**Rule:** **Every PR that introduces or modifies code on a build path is re-run from a clean state before merge.** Specifically:

- Clean install (a frozen-lockfile install from scratch, no cached dependencies).
- Clean build (no incremental compiler cache, no bundler persistent cache).
- Tests run against the clean build.

**Failure on the clean rerun blocks the merge regardless of whether tests pass on the author's machine.**

**Why:** The empirical floor is 31.7% fail-on-rebuild for AI-generated projects. CI exists for exactly this purpose; the rule formalizes that the CI clean-build is the verification of record, not the author's local machine.

**How to apply:**
- CI step that runs from a fresh container per PR (or equivalent isolation).
- Locally, a "clean → install → build" from scratch is the verification of record before claiming a PR is ready.
- "Works on my machine" is not a merge criterion.

**Source:** the AI-slop audit entries on arXiv 2512.22387 (reproducibility), arXiv 2308.02828 (non-determinism), GitClear churn data.

---

## Compaction checkpoints on long agent sessions

**Problem:** Anthropic's own engineering identified the failure mode: as context fills, the model attends less reliably to foundational constraints. "Lost in the Middle" is the mechanism — models attend disproportionately to context start and end, drop the middle. Sonnet 4.5 exhibited "context anxiety" — wrapping up tasks prematurely as it sensed the limit. Greg Kamradt's threshold finding: ~35 minutes of human-equivalent task time before agent failure rate spikes. The corpus convergence is unambiguous: longer is not better.

**Rule:** **Long agent sessions (>35 min interactive, or >50% of context window utilization) trigger an explicit compaction checkpoint at the next clean boundary.** Compaction = summarize the work-so-far into a structured note (decisions made, files modified, current task state), restart the session with that note as the seed. Load-bearing instructions (project rules, the original goal, goal-anchors) are placed at the START or END of the new context, not the middle.

**Why:** Compaction is what Anthropic's own teams converged on; it's the mechanism behind `/compact` in Claude Code; it's the U-shaped attention finding made operational. Without compaction, long sessions degrade silently; with it, the engineer pays a small compaction cost and resets the failure rate.

**How to apply:**
- For interactive sessions on critical paths, watch for the 35-minute / 50% context signal. Compact before continuing.
- For programmatic agent invocations, the harness manages compaction automatically (memory consolidation is the meta-level concern; per-session compaction is separate).
- Durable reference files (the project's rules, router, and wiki) are the durable substrate; conversational instructions are ephemeral. The reference-file-primacy principle in the project's memory discipline names this for memory; this rule extends it to per-session work.

**Source:** the AI-slop audit entries on Anthropic effective context engineering, "Lost in the Middle", context anxiety in Sonnet 4.5, the Context Rot synthesis, Mario Zechner (context window degradation).

---

## Environment-as-control on destructive actions

**Problem:** Two of the most-cited production incidents in the corpus share a structure: Replit deleted a live production database during an explicit code freeze; an agent (Cursor + a frontier model) deleted PocketOS's production volume + backups in 9 seconds via a Railway API token found in an unrelated file. Both vendors' post-incident response converged on the same fix: **environmental controls** (dev/prod separation, scoped tokens, planning-only modes), not "we made the model better at not doing destructive things." The principle: trust the environment, not the model's self-regulation.

**Rule:** **For any agent-accessible action that is destructive (delete, drop, force-push, deploy-to-prod, write to a privileged path, call an external API with side effects), the environmental control comes first.** The action is gated by a non-agent control: manual approval, a separate process the agent cannot reach, a missing capability the agent cannot acquire, a token whose permissions are scoped to non-destructive actions only.

**Why:** Approval fatigue is real. Self-regulation does not work at scale. The only durable control is environmental: if the agent process cannot access the destructive path, no amount of prompt injection or hallucinated reasoning can reach it. Replit's and Railway's post-incident hardening is the canonical pattern; we adopt it preemptively.

**How to apply:**
- Tokens used by agents are scoped to least privilege at creation. A periodic audit checks every token's permissions against its callers' actual needs.
- Production database access from agent contexts is gated by a separate human-approved channel — never via an env var the agent process can read.
- Force-push to the default branch, `git rm` of the entire repo, `DROP TABLE` against production, deploy-to-prod commands — all are gated such that the agent's process literally cannot execute them. If a human wants the action, the human provides the credential out-of-band.
- The project's ban on destructive-without-trace patterns extends here to environment-level enforcement.

**Source:** the AI-slop audit entries on the Replit incident, the PocketOS incident, the incident-response patterns from both, Simon Willison (lethal trifecta), production loop incidents, approval fatigue.

---

## Slop-detection step in PR CI

**Problem:** arXiv 2603.27249 ("An Endless Stream of AI Slop") empirically documented that low-quality AI-generated content is now a measurable category in maintainer workflows — distinct from human-written low-quality contributions, with hallmarks that pattern-match across PRs, documentation, bug reports. The hallmarks: hallucinated import paths (knowledge hallucination), tautological tests, PR descriptions that don't match the diff (a specific failure when the agent generates both), AI-generated TODO comments naming themselves ("TODO: Fix the Mess the model Created"), comment traps (defective commented code propagating). Each individually is detectable; together they're a slop signature.

**Rule:** **Every PR runs a "slop signature" check before review. The check flags:**

1. **Hallucinated imports** — every imported symbol resolves; every required dependency is declared in the manifest; every relative import points to an existing file.
2. **AI-attributed TODO comments** — `// TODO (model-name): ...` patterns are flagged for triage. (Better: agents produce TODO comments that name the *task*, not the *tool* that produced them.)
3. **PR-description-vs-diff mismatch** — automated lightweight check that the PR description claims map to the actual files changed. (Mismatch ≠ failure; mismatch flags for manual review.)
4. **Tautological-test patterns** — tests that mock everything and only verify the mock was called (the lighter-weight pre-screen ahead of the mutation gate).
5. **Comment-trap patterns** — commented-out code; lines that look like code with a `// ` prefix.

**Flagged PRs route to slow-track review with the "slop?" tag set; the tag does not block merge but forces explicit reviewer attention.**

**Why:** Slop has a measurable signature. Detecting it cheaply at PR time prevents accumulating maintenance debt. The check is a defense-in-depth layer behind no-skip-review, the architectural-claim flag, and the test-discipline rule — most slop is caught by those rules; this rule catches the rest.

**How to apply:**
- A CI script implementing the five signatures.
- Output is comments on the PR, not a hard block — false positives exist and the human reviewer makes the final call.
- Quarterly review of slop-tag false-positive rate; tune the heuristics.

**Source:** the AI-slop audit entries on arXiv 2603.27249 (Endless Stream of AI Slop), arXiv 2404.00971 (knowledge hallucination), arXiv 2602.00409 (over-mocked tests), arXiv 2601.07786 (self-admitted technical debt), arXiv 2512.20334 (comment traps), Cloudflare internal review pattern.

---

## Index

- Author-of-record on every PR
- Critical-line ownership manifest (a human reads every line as it lands on the designated critical paths)
- Spec-restatement gate before implementation
- Hallucinated-shim quarantine — no abstraction without a second caller
- Three-criteria gate before agent assignment (scoped + verifiable + recoverable)
- Hard limits on every agent run (iterations + time + tokens)
- Goal-anchor on long agent tasks
- AI as diagnostic and drafter under live review on critical paths
- No agent-driven rewrites of working code
- Test discipline (no deletion + edge-case checklist; mutation gate optional/tooling-dependent)
- Strict typing on agent-touched files (no blanket suppression, justified casts)
- Long-horizon escalation: split, don't run
- No-skip-review (live review during session; async PR-template review deferred until team scales)
- Architectural surface in end-of-turn summary (data flow / storage / auth / cross-process / transactions / retry / errors)
- No commented-out code merges
- Re-run-the-output verification
- Compaction checkpoints on long agent sessions
- Environment-as-control on destructive actions
- Slop-detection step in PR CI

---

## Loading discipline

These rules apply to **every code change** where AI contributed. They are read alongside the agentic-discipline rules and the git/IP rules on every code edit. The project's router and rule index reference this file.

When an entry here references other operating rules, those rules take precedence on their own scope; this file extends discipline, never contradicts.
