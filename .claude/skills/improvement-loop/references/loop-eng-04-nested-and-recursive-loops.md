# 04 — Nested and Recursive Loops

> Loops inside loops: an outer loop operating at goal-granularity driving inner loops at action-granularity. This is where loop engineering gets genuinely architectural and where it most often multiplies cost and failure surface instead of value. The rule: each nesting level must add control-flow that justifies its cost, or it is premature complexity.

---

## Why nest at all (the structural argument)

A planner at goal-granularity and a worker at action-granularity have **different time horizons, different context needs, and different failure modes.** Conflating them into one loop forces a single model to track both, which inflates context consumption and blurs the responsibility boundary. The hierarchical split mirrors how organizations work (a manager sets goals and doesn't execute; a worker executes and doesn't set goals) and how Hierarchical Task Networks formalize planning (compound tasks decomposed by methods into ordered subtasks, recursively, until only primitive/executable tasks remain).

The payoff is **context isolation**: each inner worker gets a clean window scoped to its sub-task, while the outer loop holds only goal-level context plus worker summaries. That is what lets the system exceed what any single context window can hold.

---

## The composition ladder (smallest to largest)

### 1. `/goal` inside `/loop` — condition-bounded recurrence
The most common real nesting, and exactly the pattern in the brief ("/goal can be inside /loop").
- **Outer (`/loop`, time-driven):** fires the work on a cadence. `/loop 30m /triage-inbox`
- **Inner (`/goal`, condition-driven):** each firing works until a completion condition holds, then stops itself for that tick.
- **Net behavior:** "every 30 minutes, work until the inbox is fully triaged, then idle until the next tick." The outer clock bounds *when*; the inner condition bounds *how far* each run goes.
- **Why it's safe:** the inner `/goal` has a falsifiable stop (a separate evaluator), so each tick can't run forever; the outer `/loop` has a 7-day expiry and `Esc`. Two independent stop mechanisms.

### 2. `/loop` driving a slash command that runs a `Workflow`
- `/loop` (or a `/schedule` Routine) fires a session; that session's prompt runs a `Workflow` fan-out (e.g. "review every changed file across dimensions"). The clock triggers; the workflow does the parallel work; results converge; the session ends; the clock waits.
- Use when the recurring unit of work is itself a multi-agent job, not a single-agent task.

### 3. Orchestrator-workers (one planner loop, many worker loops)
Anthropic's pattern: a central LLM "dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results." Each worker has a clean, bounded window — it sees its sub-task and tools, not the full original goal; the orchestrator sees goal-level context plus worker summaries.
- **In this harness:** the `Workflow` tool is the production form. `pipeline(items, stage1, stage2)` runs each item through all stages independently (no barrier — the default); `parallel(thunks)` is a barrier for when you genuinely need every result together (dedup/merge, early-exit on zero, cross-item comparison). The orchestrator plan lives in *code*, intermediate results in *script variables* — not in any model's context window. That is the key improvement over naive orchestrator-workers: the orchestrator's window is no longer the bottleneck.
- **In stock Claude Code:** triggered by `ultracode` / "use a workflow"; `/workflows` is the monitor view.

### 4. Multi-instance orchestration systems (the heavy end)
Real systems people built on top of these primitives, useful as reference architectures (not as things to copy whole):
- **Gas Town** (Steve Yegge, Jan 2026): a Go daemon (heartbeat) → "Boot" (triage) → "Deacon" (patrol) → per-rig Witnesses/Refineries, coordinating 20-30 Claude Code instances. State in a git-backed ledger; agents never push to main, work goes through a bisecting merge queue. "Polecats" (workers) have persistent identity but ephemeral sessions and query predecessors via event logs. Explicitly *"expensive as hell."* The reference for "Kubernetes for agents."
- **gstack** (Garry Tan, Mar 2026): 23 opinionated slash commands as a loop: Think → Plan → Build → Review → Test (real Chromium) → Ship → Reflect, 10-15 parallel sprints. (Many of the `gstack-*` skills in this environment are this lineage.)
- **Squid** (Iustín Paul, May 2026): six agents with one hard rule — *"no agent both writes and decides"* (maker/checker enforced structurally).
- **Agent Teams** (official Claude Code, experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`): a lead + teammate sessions with a shared file-locked task list and peer mailbox. **Hard limit: no nested teams** — teammates cannot spawn teammates; only the lead manages the team. Recommended size 3-5 teammates, 5-6 tasks each.

---

## Recursion depth discipline (the cost math)

Every additional loop layer multiplies LLM-call count, latency, and the surface for cascading hallucination. A measured comparison: a 3-agent orchestrated query = 7 LLM calls, 4.2s, $0.12 versus 2 calls, 1.1s, $0.03 without orchestration. The MAST taxonomy of multi-agent failures (1,642 annotated traces) found failure rates of 41-86.7%, dominated by system-design issues (44.2%) and inter-agent misalignment (32.3%).

**Depth guidance (first principles):**
- **2 levels (planner + executor)** are almost always sufficient for coding tasks.
- **3 levels (goal-decomposer + sub-task planner + executor)** are justified only when the goal space is genuinely hierarchical (e.g., a repo-wide audit where each file is itself a multi-step task).
- **Beyond 3 levels** without strong empirical justification is premature complexity — it multiplies cost and failure surface faster than it adds value.

**Hard limits in THIS harness:** the `Workflow` tool's `workflow()` nests **one level only** (a `workflow()` call inside a child throws). Sub-agent concurrency is capped at `min(16, cores-2)`, 1000 total per run — and this repo additionally caps **≤5 concurrent sub-agents per wave** (spawn more waves sequentially; never self-authorize more). Different version/runtime variants cite other depths (Agent Teams: no nesting; some dynamic-workflow runtimes: depth 5; SDK subagent recursion: configurable, ~3) — these are different mechanisms; ground any depth claim in the primitive you are actually using, not a blog's number.

---

## When recursion helps vs. hurts

| Recurse when | Don't recurse when |
|---|---|
| Sub-structure can't be known upfront (plan must adapt to results) | The task is linear and known — a flat plan is cheaper |
| The work exceeds one context window (each worker needs a clean one) | It fits one window — nesting just adds call overhead |
| Sub-tasks are independent and parallelizable (fan-out) | Sub-tasks are tightly coupled — coordination cost dominates |
| You want adversarial cross-checking (independent review before synthesis) | You'd just be re-asking the same model the same thing |

**Cascading hallucination is the silent killer of deep nesting:** worker A's fabrication becomes worker B's ground truth, and by synthesis the deviation is invisible. The defense is a verifier layer at each level (maker/checker again), not more makers.

---

## The bash-outer vs. plugin-inner debate (a real architectural fault line)

This recurs in the discourse and matters for unattended runs:

- **Bash-outer (original Ralph):** the loop control lives *outside* the agent (`while :; do … claude-code; done`). Each iteration is a fresh agent in a clean window; bash can kill/restart at will. Fresh context → O(N) cost, no context rot. Josh Owens: *"the restart wasn't really about restarting, it was about scoping."*
- **Plugin-inner (`/ralph-wiggum` Stop-hook):** the loop control lives *inside* the agent's session (a Stop hook reinjects the prompt). Convenient (no external script), but it keeps session continuity, so it reintroduces the context rot the fresh-context reset was designed to defeat. Dex Horthy / Matt Pocock's critique: the plugin "inverts" Ralph — *"letting the agent control the loop, leading to context rot."*

**Practical call:** for long unattended autonomous runs, prefer loop control *outside* the agent (bash, a Routine, the `Workflow` runtime, or `loop-operator` supervision) so each unit of work gets a clean window. Use the in-session plugin/`/goal` form for shorter, supervised, in-conversation bursts where context continuity is actually helpful.

---

## Recipe: an outer goal-loop driving inner worker-loops (the safe shape)

1. **Outer anchor** — write the goal + acceptance criteria to a file (`PROGRESS.md` / a plan). This survives every inner reset.
2. **Outer loop** (bash / Routine / `loop-operator`) — each tick: read the anchor, pick the highest-priority incomplete unit, spawn ONE inner worker with a clean context for just that unit.
3. **Inner loop** (the worker) — ReAct on its single unit; a *separate* checker verifies (tests/types/a reviewer agent); on pass, commit + update the anchor; exit.
4. **Outer stop** — Class 1: the anchor's task list empties (verified, not self-declared). Classes 2-4: max ticks, token budget, no-progress detection.
5. **Supervision** — `loop-operator` escalates on no-progress across two checkpoints, identical-stack-trace repeats, cost drift, or a blocked merge queue.

This is the Anthropic "engineers working in shifts" harness, the Ralph three-phase workflow, and the Gas Town factory — the same shape at three scales. Pick the smallest scale that fits; do not reach for Gas Town when `/goal` inside `/loop` would do.
