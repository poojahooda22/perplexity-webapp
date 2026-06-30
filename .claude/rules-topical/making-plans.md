# Making Plans

> **Status.** Topical, always-loaded for the trigger paths in §1. Read before opening any plan file under `.agents/plans/`, before reviewing another agent's plan, and before approving a plan as ready-to-execute.
>
> **Loading.** Always re-load when (a) about to write or open a plan file, (b) reviewing a plan as a peer-review gate, (c) responding to the operator's request for a plan / spec / proposal, (d) about to skip planning because "the task is small," (e) responding to the engineered-prompt sentinel (`\\` / `>>>` / `!!engineer` / `!!plan`).
>
> **Companion rules.** **`research-and-plan.md` — the research artifact REMAINS the precondition for any plan on high-value surfaces; this rule defines the structure of the plan that derives from it.** `cto-policy.md` (the CTO lens — scalability / performance / correctness / research-depth applied to every plan). `cynical-charter.md` (the hunt posture every plan section answers). `scalability.md` + `performance.md` (the ceilings every plan names). `agent-project-context.md` (approved plans execute in WHOLE; deferring requires explicit operator approval BEFORE the work ships). The project's plan-before-code rule on high-blast-radius work — extended here, not replaced. `ai-discipline.md` (the spec-restatement gate, the three-criteria gate, the goal-anchor, and the architectural surface in the end-of-turn summary). `nocosmetics.md` (every plan section earns its place by carrying substance). `accepting-audits.md` (rebuttal-first peer-review posture applied to plan reviews). `git-ip.md` (plans live under `.agents/plans/`, never tracked).

---

## §1 — Trigger paths

This rule fires every time a plan file is about to be written or opened for review.

| When | What this rule does |
|---|---|
| About to write `.agents/plans/<topic>-<agent>-<ISO-timestamp>.md` | Defines the file's mandatory structure (Section Zero + technical body) |
| About to review another agent's plan | Defines the audit checklist (§8) |
| About to skip planning ("it's a small task") | Defines when the skip is legitimate (§5) |
| About to approve a plan as ready-to-execute | Defines the approval contract (§8 pre-stage audit) |
| Engineered-prompt sentinel hit (`\\` / `>>>` / `!!plan`) | Defines the rewrite-block + plan-stub the agent produces before stopping |

For research-artifact prerequisites on high-value surfaces (the project's critical paths — core engine / SDK / public API / data schema): **see `research-and-plan.md` first**. The research artifact is the precondition; this rule governs what the plan derived from that research looks like.

---

## §2 — The principle: every plan opens with a Section Zero

A plan written without Section Zero optimizes for technique. The agent dives into implementation detail, the reviewer reads code-shaped paragraphs, and the question that should govern the whole document — *"what does this change for the person using the product?"* — never gets answered in writing. **A plan that cannot answer that question in plain English at the top has not earned the right to talk about implementation at the bottom.**

**Industry consensus on this framing** — three independent senior-staff sources converge:

- **Amazon's Working Backwards** ([Hustle Badger](https://www.hustlebadger.com/what-do-product-teams-do/amazon-working-backwards-process/), [Product School](https://productschool.com/blog/product-fundamentals/prfaq)): every initiative begins with a mock press release written *as if the product were already live*, describing the benefits and impact on customers BEFORE any technical mechanic is touched. The PR-FAQ "forces customer impact and positioning clarity before you dive into mechanics."
- **Anthropic's own engineering** ([Medium · 20 Minutes Before Claude](https://medium.com/@jpelton722/anthropic-plans-20-minutes-before-claude-writes-a-line-of-code-e58dab3949ff)): the team that shipped 22,000 lines of model-written code into the training codebase spends 20 minutes on a written plan artifact BEFORE the model writes a line. The plan describes *what the output will look like* — not in code, in outcome. "The teams shipping the most AI-written code aren't writing better prompts. They're writing specs."
- **Spec-Driven Development 2026** ([BCMS](https://thebcms.com/blog/spec-driven-development)): the canonical 2026 structure separates SPECIFICATION (the "what" — user impact, acceptance criteria, business value) from PLAN (the "how" — architecture, schemas, libraries). Specification ALWAYS precedes Plan. "The spec is the prompt — technical planning emerges from validated user needs, not vice versa."

Two further convergent sources:

- **Addy Osmani — How to write a good spec for AI agents** ([addyosmani.com](https://addyosmani.com/blog/good-spec/)): "Keep your initial prompt high-level… lead with user problems and business outcomes" before tech stack, commands, or code style.
- **Mitchell Hashimoto — Vibing a Non-Trivial Ghostty Feature** ([mitchellh.com](https://mitchellh.com/writing/non-trivial-vibing)): "Creating a comprehensive plan interactively with an agent is a first-step… I usually save it out to something like `spec.md`." Plans are reviewed before any code is written, and the spec.md persists as a reference across sessions.

Section Zero in this codebase is the convergent operationalization. Every plan opens with it. No exceptions.

---

## §3 — Section Zero: the crisp plain-English user-impact opener

**Section Zero is the first thing in every plan**, written in plain English for a smart non-engineer — the operator, who verifies the result and thinks in product terms, is the canonical reader. No jargon, no unprefaced acronyms, no agent-vocabulary (per `nocosmetics.md`). It is three short parts:

1. **A 4–5 line summary** of what the end user gets after the plan ships — plain enough that a layman grasps the plan's whole point and its impact on the person using the product.
2. **Up to 10 bullets**, each one outcome from the end user's point of view (the goal, the achievement, the impact) — one user-facing outcome per bullet: what the user can now do, see, or reach that they could not before.
3. **How we'll know it worked** — a few one-line success signals, each a concrete observable that is true if the plan worked. One per line, no tables, no harness names.

```markdown
## §0 — Section Zero

[A 4–5 line plain-English summary of what the end user gets after this
plan ships. No file paths, no rule numbers, no jargon, no
implementation detail.]

- [End-user outcome — what they can now do / see / reach]
- [End-user outcome]
- [... up to 10 bullets, each one user-facing outcome]

**How we'll know it worked**
- [One-line success signal — the observable thing that is true if it worked]
- [... a few crisp lines, one signal each]
```

**Name the user** — the specific category whose experience changes (e.g. the end customer, the developer integrating the product, the operator, the team) — not a generic "the user." If the plan has no observable user impact (pure refactor, internal plumbing), say so honestly in the summary and name what the work unblocks; inventing a user impact is the presentation-masking-weak-content failure mode (`nocosmetics.md`).

**`section-zero.md` is the canonical, full contract for Section Zero** — the format, the worked example, the what-it-is-NOT list, and the pre-stage audit. Read it before writing or reviewing the opener. Keep Section Zero crisp: the "how we'll know it worked" part is one-line success signals only — the detailed before/after numbers, harnesses, and thresholds live in §8 (Verify) of the technical body.

---

## §4 — Sections 1 through 10: the technical body

After Section Zero, the plan goes technical. The structure below is the consensus from RFC / Design Doc / Spec-Driven Development / Anthropic / Claude Code Spec Workflow research — adapted to this codebase's operating rules.

### §4.1 — Mandatory technical sections (in order)

```markdown
## §1 — Restated Intent

[The agent restates the operator's intent in the agent's own words.
Technical-engineer-to-technical-engineer voice (jargon allowed here,
unlike §0). Per the spec-restatement gate in `ai-discipline.md`. If the
restatement drifts from the original prompt, the prompt was ambiguous —
surface that explicitly before continuing.]

## §2 — Research Basis

[For high-value trigger paths (the project's critical paths — core
engine / SDK / public API / data schema): ONE-LINE cite to the research
artifact at `.agents/research/<topic>-<agent>.md`. The plan introduces
no substance not present in the research; if it does, extend the
research, re-derive the plan.

For non-trigger paths: name what was read in this session, with file
paths and line numbers where the read was load-bearing. The
unearned-trust failure mode (`cynical-charter.md`) is what this section
prevents.]

## §3 — Path Named

[Per `cto-policy.md`. Which path/subsystem is this plan editing — name
it explicitly. State the correctness prior of the named path. State why
the proposal is consistent with that prior.

Suggestions correct for one path are typically wrong for the others.
Naming the path is the gate that catches category errors before they
ship.]

## §4 — Chosen Direction + Alternatives Considered

[Per `cynical-charter.md`. Cite the research artifact's enumerated
directions (high-value paths) or enumerate 3–4 substantively different
directions here (other paths). Name the chosen direction. State why.
State why each of the other directions was rejected — with stated
reasons, not vibes. Constraint, measurement, or production-codebase
precedent. "Cleaner" is not a reason.]

## §5 — Implementation Steps

[Concrete file-path-level steps, in order. Each step satisfies the
three-criteria gate (scoped + verifiable + recoverable) in
`ai-discipline.md`. Step boundaries are rollback boundaries.
Granularity: "Edit `src/module/stage.ts:emitWidget` to emit the
manager-path fields per the schedule's metadata" — not "wire up the
widget in the module."

If the plan has legitimate phase-by-phase decomposition per
`agent-project-context.md`, each phase's scope is locked HERE in
writing before approval, not invented mid-execution.]

## §6 — Contract Responsibility (Operating-Rule Sweep)

[For every operating rule the work will touch, name the specific files
the implementation will edit to satisfy the contract. The
`cynical-charter.md` catalogue applied to this plan: sweep each
relevant rule, and for each, name the mirror sites / authoritative
registries / dispatch points / regen artifacts the diff must keep in
sync.

If a rule doesn't apply to this plan, write "N/A — diff does not touch
this surface." Empty rows because they "obviously don't apply" are
exactly where contract violations slip through.]

## §7 — Scalability + Performance Ceilings

[Per `scalability.md` + `performance.md`. Which scalability dimensions
does this plan move the ceiling on (concurrent users / data volume /
write throughput / read throughput / geographic distribution / per-
tenant complexity / operational scale / resource scale)? Name the new
ceiling. Name the architectural mechanism that scales (LRU eviction,
indexed query, scoped warmup, tree-shaking, CDN tier, off-main-thread
work).

Performance budget on each touched dimension — per-frame / per-request
/ per-page-load. Measured or first-principles-derived. Cite the harness
(name the real measurement environment, not a stand-in or emulator).
"Feels fast" fails on sight.]

## §8 — Verify

[Concrete named test scenarios in the test corpus, with the real
harness (the production-representative environment, not a stand-in),
with pass/fail thresholds. The operator verifies the result. A green
type-check on a broken output means the code is wrong. Each verify
scenario names what it proves (a contract parity / a correctness
property / a specific user outcome named in Section Zero).]

## §9 — Rollback Plan

[If output / perf / correctness is wrong, how to revert without losing
other in-flight work. Use bisect-by-revert where the diff is
multi-commit. The rollback is concrete — `git revert <range>` plus the
specific state the working tree returns to. Multi-commit plans without
staged rollback boundaries break the recoverability requirement in
`ai-discipline.md`.]

## §10 — Self-Audit

[Before staging, the agent runs the `cto-policy.md` six-question audit
IN WRITING. Each question gets a verdict (pass / failed-then-fixed):

1. Is this junior-level work dressed up in senior language?
2. Is this a hack wrapped in senior ceremony?
3. Am I lying with big words?
4. Am I hallucinating? (Every file:line claim traces to a file read
   this session?)
5. Am I choosing cosmetics over substance?
6. Am I padding? (Would a linter catch the finding? Then it's not
   CTO-level — drop it.)

Plus the cynical-charter five questions answered with citation:
1. Best implementation possible for the constraint we are actually
   solving — cited production repo + commit SHA?
2. Most scalable / performant approach at 10× and 100× — ceiling
   named?
3. Pattern followed by industry leaders — three independent codebases
   named?
4. Does our thing follow the pattern — file:line bridge to the
   codebase?
5. Senior-language-around-junior-thinking caught in the draft?

Any "failed" without "fixed" → rework. Do not stage.]
```

### §4.2 — Sizing the plan

The plan is shorter than the research artifact (`research-and-plan.md` mandates a deep research artifact; plans are operational distillations). Typical sizes:

| Surface | Plan length |
|---|---|
| Single small addition / metadata edit | 50–150 lines |
| Multi-file refactor (5–15 files) | 150–400 lines |
| New pipeline stage / subsystem | 300–600 lines |
| Cross-system architectural change (multiple subsystems) | 400–800 lines |
| New product capability (a whole new feature tier) | 500–1,000 lines |

Padding the plan to look thorough is the plan/audit-padding failure mode (`nocosmetics.md`). A shorter plan that answers Sections 0–10 honestly is higher rigor than a longer plan with the same content stretched. Word count chosen to "look senior" fails on sight.

---

## §5 — When the plan-before-code requirement applies

| Trigger | Plan required? | Section Zero required? |
|---|---|---|
| High-blast-radius core work (the project's most error-prone / hardest-to-debug subsystem) | **YES** | **YES** |
| Critical paths (publish / runtime / public packages / auth / data migrations) | **YES** | **YES** |
| Multi-file refactor (>3 files touched) | **YES** | **YES** |
| Architectural decision (new pattern, new abstraction layer, new database table) | **YES** | **YES** |
| New core unit (any unit in the project's primary definitions tree) | **YES** | **YES** |
| New community / marketplace / user-facing feature | **YES** | **YES** |
| Single-line bug fix with named root cause | **NO** — direct execution | N/A |
| Trivial fix (typo, comment edit, formatting, one-line dependency bump) | **NO** — direct execution | N/A |
| Direct-Action sentinel from the operator (`>>>` / `!!direct` / `!!go` / the configured numeric shortcuts) | **NO** — operator's call | N/A |

**The default for ambiguous cases:** plan first, write second. Cost of writing a plan = ~15 minutes; cost of not writing one when needed = a multi-hour debug loop, per the plan-before-code rule's incident basis.

---

## §6 — Anti-patterns (instant plan rejection)

| Anti-pattern | Why it fails |
|---|---|
| **No Section Zero, jumps straight to "Step 1: ..."** | Plan optimized for technique; no user-impact framing. Reject on sight. |
| **Section Zero written in jargon** | "Migrate the dispatch sites" is technical body, not Section Zero. Plain English fails → rewrite. |
| **Section Zero is a TL;DR of the plan** | Different artifact — Zero is about the *product change*, not the *document*. |
| **Section Zero names "the user" generically** | "The user will use the new feature" has zero engineering substance. Name the user category (end customer / developer / operator / team) and the specific outcome they get. |
| **Section Zero invents user impact for an internal plan** | If there's no observable user impact, say so honestly. Inventing one is the presentation-masking-weak-content failure mode (`nocosmetics.md`). |
| **No research basis cited (§2)** | On high-value trigger paths, plan rejected. On other paths, name what was read with file:line. |
| **Path not named (§3)** | `cto-policy.md` path-naming violation. Reject. |
| **§4 alternatives section says "I considered X but it was worse"** | Vibes, not reasoning. Each rejection needs a stated reason — constraint, measurement, or production-codebase precedent. |
| **§5 implementation steps lack file paths** | Steps without `src/foo/bar.ts:LINE` granularity are wishes, not steps. |
| **§6 contract sweep empty when the diff touches contract-bearing paths** | Mirror sites uncommitted → correct-in-one-place / broken-in-another bug class shipped. Reject. |
| **§7 perf claim with no harness named** | `cynical-charter.md` hallucinated-metric. Stand-in / emulator timings promoted to production claims = reject. |
| **§8 verify scenarios named only as "test it works"** | What does "works" mean? Which scenario? Which environment? Which thresholds? Reject. |
| **§9 rollback plan is "revert the commit"** | Multi-commit plans without staged rollback boundaries break the recoverability requirement. |
| **§10 self-audit empty or copy-pasted** | The audit IS the discipline. Empty audit = junior work. Reject. |
| **Plan introduces substance not in the research artifact** (high-value paths) | Research was incomplete. Extend research, re-derive plan. |
| **"Phase 2 / follow-up PR / v2 / later" language in implementation steps** | Silent-deferring signal. Either the phase boundary is in the plan from the start (legitimate) or it's invented mid-execution (surface-and-wait required per `agent-project-context.md`). |
| **Word count chosen to "look thorough"** | `nocosmetics.md` padding. Drop 30%; verify nothing substantive was lost. |
| **Process language ("per audit", "the assistant suggested", "the model found")** in any line destined for a committed file | The project's no-process-language rule. Rewrite. |

---

## §7 — Catch-yourself triggers

You are about to ship a junior-level plan if any of the following thoughts arise:

- *"Section Zero is obvious from context, I'll skip it."* → STOP. Section Zero IS the contract. Skipping it is skipping the product-impact answer.
- *"I'll write the technical body first and add Section Zero at the end."* → STOP. Section Zero shapes what goes in the technical body. Reverse-engineering it from the body is rationalization, not framing.
- *"This is too technical to explain in plain English."* → STOP. If you cannot explain the change to a smart non-engineer, you do not understand the change. Re-read the codebase until you do.
- *"The user impact is obvious — the user will be able to use the new feature."* → STOP. That sentence has zero engineering substance. Name the user category, name the journey change, name what was broken / impossible / slow before.
- *"I'll cite the research later."* → STOP. The research basis is Section 2 of the plan. No research cite = the research wasn't done OR was done shallowly. Either way, the plan is not ready.
- *"The plan is getting long, I'll defer the rollback to a follow-up."* → STOP. Rollback is Section 9. Cutting it is cutting the recoverability the rules require.
- *"I'll skip the self-audit, the plan looks good."* → STOP. `cto-policy.md` mandates the audit. The plan that "looks good" without the audit is exactly the plan that ships with the failure modes the audit exists to catch.
- *"Path is obvious from the file paths in the steps."* → STOP. `cto-policy.md` demands the path be NAMED in writing. Reviewers should not have to infer.
- *"The contract sweep would be padding for this plan."* → STOP. The sweep IS the substance for any plan touching contract-bearing paths. Skipping it is skipping the highest-blast-radius safety check.
- *"I'll just phase this — Phase 1 ships now, Phase 2 next plan."* → STOP. If the phase boundary wasn't in the plan at approval time, the deferring needs explicit operator approval before the work ships (per `agent-project-context.md`).
- *"The plan is small, I don't need the full template."* → STOP. Small plans get the full template at smaller proportions. A 100-line plan with Section Zero through Section 10 is correct; a 500-line plan that skipped Section Zero is wrong.

---

## §8 — Pre-stage plan audit (run in writing before the plan goes to the operator)

Each item gets a verdict (pass / failed-then-fixed). Output goes into the plan itself as Section 10.

1. **Section Zero present?** A 4–5 line plain-English summary, up to 10 user-outcome bullets, and a few one-line "how we'll know it worked" success signals?
2. **Plain English?** A non-engineer reader could follow it — no file paths, no rule numbers, no implementation?
3. **User named?** End customer / developer / operator / team — not generic "the user"?
4. **Bullets are user-facing outcomes?** Each one thing the user can now do / see / reach; internal-only plans say so honestly and name what they unblock?
5. **§1 restates the operator's intent** in the agent's own words?
6. **§2 cites the research artifact** (high-value trigger paths) or names file:line reads?
7. **§3 names the path** and states the correctness prior?
8. **§4 enumerates 3+ alternatives** with stated rejection reasons (constraint / measurement / precedent — not vibes)?
9. **§5 implementation steps** have file-path granularity and rollback boundaries?
10. **§6 contract sweep** covers every operating rule the diff touches (N/A rows written explicitly, not omitted)?
11. **§7 scalability + performance** ceilings named, mechanism declared, harness cited, no stand-in/emulator timings promoted to production claims?
12. **§8 verify scenarios** named with thresholds, on production-representative harnesses?
13. **§9 rollback plan** concrete (commit ranges, working-tree state)?
14. **§10 self-audit** completed in writing per `cto-policy.md` + the cynical-charter five questions?
15. **No process language** in any text destined for committed files?
16. **No deferring signals** ("Phase 2", "follow-up", "v2", "later") unless explicit operator-approved phase boundaries are in §5 from the start?
17. **No `nocosmetics.md` padding** — would dropping 30% lose any engineering substance?

Any "failed" without "fixed" → rework. Do not stage.

---

## §9 — Engineered-prompt sentinel integration

The harness sentinel (`\\` / `>>>` / `!!engineer` / `!!plan`) triggers the engineered-prompt rewrite protocol. When that protocol fires, the agent produces:

1. **The rewrite block** — Intent / Scope / Context / Constraints / Success Criteria / Approach / Skills to Invoke
2. **A Section Zero stub** for the plan-to-be-written — the crisp plain-English summary plus user-outcome bullets, before any technical body

The agent ends the rewrite by awaiting the operator's confirmation and STOPS. Section Zero of the eventual plan is drafted at this sentinel-response stage so the operator can correct the user-impact framing BEFORE the technical body is written. Catching framing errors early saves an entire plan rewrite cycle.

If the sentinel fires for a non-trigger path (trivial fix, direct execution), the rewrite block is still produced but no plan stub is required — the §5 table determines this.

---

## §10 — Worked example: the shape of a passing Section Zero

Below is an example for an export-path feature. The technical body is omitted; only Section Zero is shown.

```markdown
## §0 — Section Zero

A creator can already author content in the editor, watch it run live,
and publish it. What they can't do yet is hand that work to a developer
as standalone code — the export path doesn't understand the new content
type and fails. This plan teaches the exporter to compile it, so the
content exports to the same self-contained files every other piece
produces, runnable anywhere with nothing extra installed.

- A creator can export any project containing the new content type, which fails outright today.
- A developer receives a single self-contained file that runs the creator's work, with no dependency on the editor.
- A developer fully owns the exported code, the same as every other exported project.
- An end customer of the embedded result sees the exact output the creator approved.
- The author-to-export journey becomes one continuous path instead of breaking at the new-content-type step.

**How we'll know it worked**
- Five reference projects with the new content type all export and run in a clean project with nothing else installed (zero export today).
- Each exported project's output matches the editor preview exactly.
```

What this Section Zero passes:
- Plain English throughout (no module names, no rule references, no internal jargon)
- Names three distinct users (creator / developer / customer)
- A 4–5 line summary, one user-facing outcome per bullet under ten bullets, then one-line success signals
- Does NOT describe implementation — that comes in §1 onward

---

## §11 — Why this rule exists

Across the build phase to date, plans have failed in two recurring shapes.

**Shape 1: technique without outcome.** A plan opens with "Step 1: refactor `src/module.ts:1543`..." — the reviewer reads four pages of file paths and never learns what the user gets at the end. The plan executes, the diff lands, the work shipped, and three weeks later someone asks "wait, what did this change for the user?" and nobody on the team can answer in one sentence. The work is technically correct and product-orphaned. Multiplied across a long build, the accumulated product narrative is fragmented — features ship that don't connect to a user story, units land that don't connect to a user's day, infrastructure migrates that doesn't connect to anyone outside the team.

**Shape 2: junior-level surface dressed as senior planning.** A plan has the right section headings (alternatives, implementation steps, verify scenarios) but the substance is shallow. "Alternatives considered: A, B, C — chose A because it's cleaner." No measurement, no production-codebase precedent, no stated trade-off. The contract sweep is empty because the agent forgot a contract-bearing surface exists. The verify scenarios are "test in editor" with no harness named. The plan reads as senior, executes as junior, ships a contract violation, the operator catches it at verify, the cycle repeats.

Section Zero fixes Shape 1 by forcing the user-impact answer at the top. The mandatory contract sweep + self-audit + research-basis citation fixes Shape 2 by forcing senior-engineering substance throughout. The two together convert a plan-shaped artifact into an engineering-grade plan.

**The user-impact framing is the load-bearing discipline.** Every plan in this codebase serves the product narrative — creator builds → system outputs → developer integrates → result runs at scale. Plans that cannot articulate where they sit in that narrative are plans the team does not need. The Section Zero contract is how that articulation becomes mandatory rather than optional.

This rule does not replace the engineering rigor in `cto-policy.md`, `cynical-charter.md`, `scalability.md`, `performance.md`, `agent-project-context.md`, or `research-and-plan.md`. It is the single load-bearing addition that wires those rules together at the top of every plan, in plain English, so the first paragraph of every plan answers the question the entire engineering discipline is in service of: **what does this change for the person using the product?**

---

## §12 — Source

Directive issued after reviewing accumulated plan files under `.agents/plans/` and noting the consistent absence of plain-English user-impact framing at the top of plans. Research basis: 8 web searches across 5 source categories — (1) AI-augmented planning patterns (Anthropic's planning workflow, Addy Osmani's spec-for-agents, Mitchell Hashimoto's Ghostty workflow), (2) spec-driven development (BCMS 2026 guide, Pimzino Claude Code spec workflow, GitHub spec-kit), (3) RFC / Design Doc consensus (Pragmatic Engineer survey, Stripe / Google / Amazon / Microsoft patterns), (4) Architecture Decision Records (joelparkerhenderson ADR collection, Microsoft Azure Well-Architected, AWS Prescriptive Guidance), (5) Product strategy (Amazon Working Backwards + PR-FAQ, classic PRD templates). Industry convergence on three points: (a) user-impact framing precedes technical detail (Amazon PR-FAQ, SDD SPEC-before-PLAN, Anthropic outcome-first plan-before-code), (b) research / context-gathering precedes planning (Anthropic 20-min plan, Mitchell Hashimoto's saved spec.md artifact, Addy Osmani's experience-developer-knowledge spec — which is why a research artifact remains the precondition for plans on high-value surfaces), (c) plain English at the top, technical depth below (every RFC template, every ADR template, every PRD template surveyed). Section Zero in this codebase is the convergent operationalization.

**References (the sources the rule is grounded in):**

- [How to write a good spec for AI agents — Addy Osmani](https://addyosmani.com/blog/good-spec/)
- [Vibing a Non-Trivial Ghostty Feature — Mitchell Hashimoto](https://mitchellh.com/writing/non-trivial-vibing)
- [Anthropic Plans 20 Minutes Before Claude Writes a Line of Code — James Pelton, Medium](https://medium.com/@jpelton722/anthropic-plans-20-minutes-before-claude-writes-a-line-of-code-e58dab3949ff)
- [Spec-Driven Development (SDD): The Definitive 2026 Guide — BCMS](https://thebcms.com/blog/spec-driven-development)
- [Software Engineering RFC and Design Doc Examples and Templates — The Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/software-engineering-rfc-and-design)
- [Companies Using RFCs or Design Docs — The Pragmatic Engineer](https://blog.pragmaticengineer.com/rfcs-and-design-docs/)
- [Claude Code Spec Workflow — Pimzino, GitHub](https://github.com/Pimzino/claude-code-spec-workflow)
- [GitHub Spec-Kit — AGENTS.md](https://github.com/github/spec-kit/blob/main/AGENTS.md)
- [Amazon Working Backwards Template / PR-FAQ — Hustle Badger](https://www.hustlebadger.com/what-do-product-teams-do/amazon-working-backwards-process/)
- [PR-FAQ: Amazon's Innovation Blueprint — Product School](https://productschool.com/blog/product-fundamentals/prfaq)
- [Architecture Decision Record examples — joelparkerhenderson, GitHub](https://github.com/joelparkerhenderson/architecture-decision-record)
- [Maintain an architecture decision record (ADR) — Microsoft Azure Well-Architected Framework](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record)
- [ADR process — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html)
- [Best practices for Claude Code — Claude Code Docs](https://code.claude.com/docs/en/best-practices)
- [Claude Code Plan Mode — Steve Kinney](https://stevekinney.com/courses/ai-development/claude-code-plan-mode)
- [Writing a good CLAUDE.md — HumanLayer](https://www.humanlayer.dev/blog/writing-a-good-claude-md)

---

## §13 — Index entry

For the rules index in `.claude/rules/README.md`:

- **Every plan opens with Section Zero before any technical section.** Section Zero is a crisp plain-English user-impact opener: a 4–5 line summary of what the end user gets after the plan ships, then up to 10 bullets each one user-facing outcome (goal / achievement / impact), then a few one-line "how we'll know it worked" success signals. Name the user (end customer / developer / operator / team). The full Section Zero contract is owned by `section-zero.md`; this rule owns the technical body that follows — Restated Intent / Research Basis / Path Named / Chosen Direction + Alternatives / Implementation Steps / Contract Sweep / Scalability + Performance / Verify / Rollback / Self-Audit. The research artifact at `.agents/research/` REMAINS the precondition for high-value surfaces per `research-and-plan.md` — this rule defines the structure of the plan that derives from that research. Industry convergence: Amazon Working Backwards / Anthropic 20-min plan / Spec-Driven Development 2026 / Mitchell Hashimoto's saved spec.md / Pragmatic Engineer RFC consensus all put user-impact framing at the top, technical depth below. Companion to `research-and-plan.md`, `section-zero.md`, and `cto-policy.md`.
