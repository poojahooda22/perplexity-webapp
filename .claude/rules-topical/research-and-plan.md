# Research-First Workflow for High-Value Surfaces

> **Status.** Topical + always-loaded for the trigger paths below. **Supersedes the project's freestanding plan-before-code requirement for the same paths:** from this rule forward, no plan exists in `.agents/plans/` for a trigger path without a corresponding research artifact in `.agents/research/` that precedes it and is the substance the plan derives from.
>
> **Loading.** Read this file whenever a task touches any path in §1. Companion material: the project's plan-before-code rule (extended here, not replaced), the project's multi-tier research-pipeline rule (operational tiers consumed here), the deep-research rigor bar (the substance floor §3 invokes), the project's hunt-posture / red-team rule (what the research must answer), the project's sign-off/CTO policy (what the audit checks the plan against), and the project's source-control IP rule (research and plan files live in gitignored `.agents/`, never tracked).

---

## §1 — Trigger paths

This rule fires whenever the work touches any of the following. The rule applies even to one-line edits, renames, or comment fixes on these paths because every load-bearing failure in recent memory landed via a "small change" that wasn't researched first (a half-merged refactor, a dispatch step silently dropped twice, a type-lie in a cache class).

Each project defines its own high-value trigger surfaces. Treat the list below as a template to fill in per project — name the modules, file globs, and schema-migration paths whose breakage has the highest blast radius:

| Surface | Path (fill in per project) |
|---|---|
| **Core engine / pipeline** | the central transform/compile/render module(s) |
| **Shared composition layer** | the module that composes or coordinates the core units |
| **Generated/templated assets** | the materials, templates, or codegen outputs the engine emits |
| **Catalog of reusable units** | the definitions directory (every unit — including renames + metadata edits) |
| **Public SDK / runtime packages** | the published runtime + framework-binding packages |
| **Publish + export pipelines** | the build/publish/export server routes |
| **Persistence + autosave** | the autosave/graph/state modules, any persisted-state schema migration |
| **Other critical paths** | the full project-specific critical-path list from the project's operating rules |

If a single task touches three trigger paths, **one** research artifact covers the whole topic — do not fragment. If the task is a new entry in the catalog of reusable units (the typical case), the rule fires automatically because the definitions directory is touched.

---

## §2 — The two-artifact sequence

Two files exist on disk before any code touches the tree:

1. **Research artifact** — `.agents/research/<topic>-<agent>.md` (1,000+ lines, §3 contract)
2. **Implementation plan** — `.agents/plans/<topic>-<agent>-<ISO-timestamp>.md` (cites + derives from the research)

The plan **cites** the research artifact in its first section. The plan **derives from** the research artifact and introduces no new substance. The plan is **shorter** than the research artifact (research = substance; plan = operational distillation).

**If the plan exists without the research artifact, the plan is rejected on sight regardless of its quality. No exceptions.**

### §2.1 — Research artifact naming

Format: `<contextual-topic>-<agent>.md`

- **Contextual topic** — kebab-case, descriptive, names the *thing* being researched (not the verb being done to it). Examples:
  - `<subsystem>-<mechanism>-and-<policy>`
  - `<engine>-<new-emit-target>`
  - `<unit>-<isolation>-pair-contract`
  - `<pipeline>-<conflict>-recovery`
- **Agent suffix** — which agent did the research. `claude`, `gemini`, `cursor`, `codex`. Attribution matters because different agents have different research strengths, and tracking it lets the operator see which surfaces each agent has investigated and which surfaces have no research yet.
- **No timestamp.** Research files are per-topic, not per-session. If a topic needs re-research six months later (codebase drifted, new prior art surfaced), the file is **updated in place** with a new dated section per §5.2 — never version-stamped or duplicated.

Examples on disk:
- `.agents/research/<topic-a>-claude.md`
- `.agents/research/<topic-b>-gemini.md`
- `.agents/research/<topic-c>-cursor.md`

### §2.2 — Implementation plan naming

Format: `.agents/plans/<topic>-<agent>-<ISO-timestamp>.md`. The `<topic>` matches the research artifact's contextual topic; the `<agent>` matches the agent producing the plan (can differ from the research-artifact agent — cross-agent plans are legitimate). Timestamp included because plans iterate (Plan A → B → C → D — see the canonical multi-round audit cycle for the reference pattern).

The plan's first section is a one-line cite back to the research artifact:
```markdown
> **Research basis:** `.agents/research/<topic>-<agent>.md`
> **Read before reviewing this plan.** The plan's substance is in the research; this file is the operational distillation.
```

---

## §3 — The research artifact contract

A research artifact is **substantively researched**, not vibe-summarized. The 1,000-line floor exists to force genuine reading, opening, and citation work — not to fill space.

### §3.1 — Mandatory sections (every research artifact, in order)

1. **§1 — Topic and scope.** What is being researched. In scope, out of scope, explicitly deferred. The upstream task driving the research. The decision the downstream plan will need to make.

2. **§2 — Codebase walk.** What the agent read in the repo. Every relevant file opened with `file:line` citations for every claim about how the current code works. This is the section that prevents the unearned-trust failure mode where an agent assumes from training data instead of reading. **Minimum 30 file:line citations** for any non-trivial trigger path.

3. **§3 — Industry prior art.** Production codebases that solved the same class of problem. Not tutorial blogs. Not Stack Overflow summaries. Not "I think." The **actual source code** of the actual implementation, opened and read, with `<repo>@<sha>:<file>:<line>` citations. **Minimum 3 independent industry-leader codebases** for the relevant domain (pick the mature, widely-used open-source implementations of the same class of problem). For each: what they did, why, the trade-off they accepted, the file:line that proves it.

4. **§4 — Specs, papers, vendor posts.** The standards/specs (W3C, IETF, language/platform specs, relevant ISO/standards bodies) that constrain the design. Peer-reviewed papers (the top conferences/journals for the domain) that name the algorithm or pattern. Vendor engineering blog posts (the platform/runtime/hardware vendors whose behavior the design depends on) that name the constraint. Cite section number + URL + the conclusion that survived the reading.

5. **§5 — Web search log.** Every query run, every URL opened, every relevant excerpt extracted. **Minimum 30 distinct queries** per the deep-research rigor bar. If after 30 queries the picture is still ambiguous, that ambiguity is itself the finding — surface it in §10, don't paper over.

6. **§6 — Cross-verification log.** For every load-bearing claim, the **three+ independent sources** that corroborate it. When two reputable sources disagree, the disagreement is named explicitly, the more authoritative side is picked with stated reasons, and the rejected side is cited so future-you knows it was considered.

7. **§7 — Solution direction enumeration.** **Minimum 4 substantively different solution directions**, not variations of one idea. For each: the mechanism, the trade-off, the failure modes, the production-codebase precedent (if any), the rejection reason (if rejected).

8. **§8 — Comparison matrix.** Tabular comparison across §7 directions on every dimension the plan will decide on: scalability ceiling, performance characteristics, correctness invariants, impact on the project's shared pair-contracts, maintenance cost, cost to port/mirror across the project's parallel implementations, cost to the codegen/emit path, test surface, rollback complexity.

9. **§9 — Recommended direction + confidence.** The agent's recommendation, with stated reasons. Confidence level: high / medium / low, with reasoning. *"Confidence is high because three independent senior-staff codebases converge AND the production pattern matches our structure at `<module>:LINE`"* is honest. *"Confidence is medium because only one source corroborates and the perf has not been measured"* is also honest.

10. **§10 — Open questions for the plan.** Specific decisions the plan needs to make that research alone cannot resolve. Each open question states: what needs deciding, what the options are, what would resolve it (a measurement, the operator's product call, a deeper read of a specific file). Open questions are the explicit bridge from research to plan.

11. **§11 — Pre-mortem.** *"Imagine this work shipped and broke in six months. What would the root cause have been?"* Answered in writing. If the answer is "nothing imaginable," confidence in §9 should be high. If the answer is "any of these five things," confidence is at most medium and the watch-items are listed.

12. **§12 — Shared-contract impact map.** For every shared contract or cross-cutting rule the work will touch: the impact + the dispatch/mirror sites that must stay in sync. Specifically, name the parallel implementations that must mirror the change (with file paths), any duplication risk, any new registrations a shared registry needs, any process-language risk in the resulting commit, every dispatch site the change must reach (with the audit script that enumerates them, if one exists), which behavioral class the change belongs to, any catalog/registry regeneration requirement, and any critical-path edit requiring live operator review.

### §3.2 — The 1,000-line floor

The floor exists for two reasons:

- **Substance bar.** A research file under 1,000 lines is almost certainly missing one of §3.1's sections at depth. The floor forces the agent to ACTUALLY read 30 file:line citations, ACTUALLY open 3 industry codebases, ACTUALLY run 30 search queries — not summarize from training data.
- **Compounding moat.** Every 1,000+ line research artifact becomes a load-bearing reference for the NEXT task on the same surface area. The second piece of research on a surface is faster because the first one mapped the territory. We are building a research library that compounds across sessions and across agents, not a one-off doc per task.

If the agent is padding to hit 1,000 lines, the research is too shallow — go deeper into §3 (industry prior art) and §5 (web search log), don't pad with restated obvious. The hunt-posture rule's hallucinated-metric and cargo-cult checks apply to the research file itself. Every padded line is dishonest research and will be caught at audit.

### §3.3 — Citation discipline

Every concrete claim in the research artifact carries one of three:
- A **`file:line` citation** to a real file in this codebase OR a real file in a public open-source repo (with `<repo>@<sha>` named so a future reader can verify against the same commit you read)
- A **URL** to a spec, paper, or vendor post, with the relevant section quoted inline
- An explicit **`[unverified — flagged for the plan to resolve]`** tag, naming what would verify it

Claims without one of the three are hallucinated-metric and fail the audit on sight. Honest *"I have not verified this"* is higher rigor than confident-sounding guess.

---

## §4 — How the plan derives from the research

The plan is the **operational distillation** of the research. Shorter, more concrete, more prescriptive. It contains **no new substance** that wasn't in the research. If the plan introduces a new architectural decision, a new alternative direction, a new performance claim — the research was incomplete. Go back, extend the research, re-derive the plan from the extended research.

### §4.1 — Plan's mandatory sections

**The plan's structure is governed by the project's plan-template rule.** Every plan derived from a research artifact opens with **Section Zero** (a crisp plain-English user-impact opener: a 4–5 line summary of what the end user gets, up to 10 user-outcome bullets, and a few one-line "how we'll know it worked" success signals) BEFORE any technical section. The technical body that follows runs Sections 1 through 10:

0. **§0 — Section Zero** — a 4–5 line plain-English user-impact summary, up to 10 end-user-outcome bullets, and one-line success signals. Non-negotiable. A plan without Section Zero is rejected on sight regardless of how rigorous the technical body is.
1. **§1 — Restated intent** — the operator's intent as the agent understood it, in the agent's own words (per the project's spec-restatement gate).
2. **§2 — Research basis** — one-line cite to the research artifact (§2.2 format above).
3. **§3 — Path named** — per the project's sign-off/CTO policy.
4. **§4 — Chosen direction + alternatives** — citing the research's §9 recommendation and §7 enumerated directions. If the plan diverges from the research's recommendation, the divergence is justified in writing with the reason and what new information surfaced between research and plan.
5. **§5 — Implementation steps** — concrete file-path-level steps, in order, with rollback boundaries between phases per the project's phase-gate criteria (scoped + verifiable + recoverable).
6. **§6 — Shared-contract responsibility** — for every shared contract from the research's §12, the plan names the specific files the implementation will touch to satisfy the contract: the parallel implementations that must mirror the change, each dispatch site, the behavioral class declared, the same-commit catalog regen, and any live-review acknowledgment.
7. **§7 — Scalability + performance ceilings** — per the project's scalability and performance rules. Mechanism named, harness cited (a representative-of-production environment, not a degraded stand-in).
8. **§8 — Verify cases** — concrete named test cases/scenarios, with harness, with pass/fail thresholds.
9. **§9 — Rollback plan** — if behavior or perf is wrong, how to revert without losing other in-flight work.
10. **§10 — Self-audit** — the sign-off policy's questions + the hunt-posture rule's questions, answered in writing.

See the project's plan-template rule for the verbatim section template, the anti-pattern catalogue, the pre-stage audit checklist, and a worked example.

### §4.2 — Rejection conditions

The plan is **rejected on sight** if:

- **Section Zero is missing or jargon-laden** (plan-template violation — the rejection is automatic before the technical body is even reviewed).
- Any of §4.1 sections 1–10 is missing.
- The plan introduces substance not present in the research (signal that research was incomplete; go extend it).
- The plan's chosen direction is not one of the research's §7 enumerated directions (without an explicit "new direction surfaced post-research" justification + research update).
- File:line claims in the plan don't trace to the research's file:line citations.

---

## §5 — Lifecycle and re-use

### §5.1 — Research artifacts persist after the plan ships

Once the plan derived from a research artifact lands and the implementation ships, the research artifact **stays** in `.agents/research/`. It is not deleted, not archived. The next time a related task touches the same surface area, the next agent reads the existing research first — and either extends it (if the codebase has drifted) or builds on it (if still current).

This is the compounding-moat clause. Six months from now, the per-surface research library should be the single highest-leverage knowledge asset on the team.

### §5.2 — Updates ADD to the file, never silently rewrite

A research artifact is updated, not replaced, when:
- The codebase has drifted (file:line citations no longer resolve)
- New industry prior art has surfaced (a new paper, a new open-source release)
- The shared-contract impact map needs updating because the project's rules themselves evolved
- An open question from §10 was resolved by a previous plan's implementation

Updates ADD with a `## §X — Update <ISO-date>` heading at the end of the file. Original content stays. Future readers see what was true when, and what changed.

### §5.3 — Cross-agent research re-use

A research artifact written by one agent is read by another for the next related task. The second agent may write `<topic>-<agent>.md` as an **extension** (different angles, different industry codebases, different specs its training surfaced) — not a competing duplicate. The two artifacts together form the research base for the next plan.

When the topic is unambiguously owned by a single agent (per the project's agent-specialization conventions), that agent's research file is the canonical artifact and other agents read it without writing parallel versions.

---

## §6 — What this rule does NOT replace

- **The deep-research rigor bar** — 30+ searches, ≥5 source categories, the top-institution research standard. This rule INVOKES that bar for §3 substance; it doesn't redefine it.
- **The plan-before-code rule** — the requirement that a written plan precede any edit. This rule EXTENDS it by adding the research artifact as a precondition for the plan; it doesn't replace the plan.
- **The multi-tier research-pipeline rule** — the staged pipeline (First Principles, Literature & Specs, Production Codebases, Competitive Analysis). This rule USES those tiers as the lens for §3 sections 2–4.
- **The hunt-posture / red-team rule** — the hunt posture + its core questions. The research artifact is WHERE those questions get answered concretely with citation, before the plan tries to act on them.
- **The sign-off / CTO policy** — the sign-off contract. The plan is reviewed under that policy; the research artifact is what the plan's claims are checked against.

---

## §7 — Catch-yourself triggers

You are about to violate this rule if:

- You are about to write a plan file for a trigger path WITHOUT first writing the research artifact. **STOP.** Research first.
- You are about to write a research artifact in fewer than 1,000 lines because "the task is small." **STOP.** Either the task isn't on a trigger path (skip the rule, use a freestanding plan), or the research is shallow (go deeper into §3 + §5).
- You are about to write claims in the research without `file:line` or URL citation. **STOP.** Add the citation or tag `[unverified]`.
- You are about to write a plan that introduces a new architectural decision not in the research. **STOP.** Extend the research, re-derive the plan.
- You are about to skip the research because *"I already know this domain."* **STOP.** Unearned-trust failure mode. The codebase has drifted since you last looked. Read again.
- You are about to claim the research is "done" without opening 3 independent industry codebases. **STOP.** Open them. Read the actual source. Cite `<repo>@<sha>:<file>:<line>`.

---

## §8 — Why this rule exists

The plan-before-code rule prevented the worst class of bugs by forcing a written plan before any edit. The recurring failure mode that survived it was: plans that were *written* but not *researched* — agents skipped to "here's my approach" without reading the codebase, opening industry prior art, or running deep web searches. The plans satisfied the format requirement but were vibe-derived underneath (hallucinated metric + cargo-cult). When implementations went wrong, postmortems traced to *"we never actually checked what the leading implementation does for this"* or *"we assumed the runtime mirrored the editor without reading the renderer."*

This rule separates the two artifacts because conflating them lets the substance hide behind the format. With research as a separate file with hard size, content, and citation requirements, the substance is auditable on its own — the operator (or a peer-review agent) reads the research and grades it independently of the plan. The plan is then graded on *how well it derives from the research*, not on its own internal coherence.

The 1,000-line floor + 30-citation minimum + 3-industry-codebase requirement + 30-query log are not bureaucracy. They are the load-bearing forcing functions that prevent the agent from claiming senior-engineering rigor while doing shallow training-data-summary work. Without those floors, "do research first" degrades into "write a research-flavored intro to your plan" — which is exactly the failure mode this rule names.

The compounding-moat clause (§5.1) is the other half of the value. One research artifact serves one task. Twenty research artifacts on twenty surfaces become the highest-leverage knowledge asset on the team — the institutional memory that survives session compaction, agent attrition, and codebase drift. The plan-before-code rule alone could not produce that asset because its plans are per-task and disposable. These artifacts are per-surface and durable.

---

## §9 — Source

This rule was codified after a multi-round plan audit cycle (Plan A → B → C → D). Each plan iteration improved because the previous round's audit forced deeper reading. The final plan was the version where the actual codebase patterns (the real construction precedents, the prior art for the relevant policy, the audit script's actual behavior, the existing related units, three industry-leader implementations of the same mechanism, the governing spec) were consulted instead of assumed. The framing: if the agent had written a 1,500-line research artifact FIRST — mapping the codebase patterns, the policy precedents, the audit script's behavior, the existing related units, three industry-leader implementations, the governing spec — Plan A would have been Plan D. Three full audit cycles saved. This rule codifies that observation as a workflow rule for every future high-value surface.
