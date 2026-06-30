# 02 — Foundations and Loop Patterns

> The loop archetypes underneath the 2026 trend. The `while`-loop shape is old (CI, autoscalers, OODA); what changed is the controller — an LLM action-picker over a space the size of the codebase × every wired tool × accumulated context. Knowing the named patterns lets you pick the right loop shape instead of reinventing a worse one. Each pattern below has its mechanism, when to use it, and how it maps to a Claude Code loop.

---

## The canonical agent turn: OODA / perception-action loop

Every agent turn is **Observe → Orient → Decide → Act** (Boyd, 1970s; now domain-general):

- **Observe** — tool output arrives (file content, test result, API response).
- **Orient** — the model integrates new information with goal state + prior context.
- **Decide** — it selects the next action (which tool, or a terminal response).
- **Act** — the tool is invoked; the result becomes the next Observe.

**Why iteration beats one-shot:** one-shot commits to a plan with no environmental feedback and fails at the first deviation (a changed file, a failing test, an unexpected API response). Iteration makes each decision a function of the latest ground truth. The model cannot know ahead of time what it doesn't know.

**The harness is the control plane; the model is the policy.** The LLM is stateless across turns. The harness holds the conversation trace, routes tools, enforces budgets and iteration caps, and evaluates the stop condition. Conflating the two is the architectural error behind unprincipled "agentic" systems. Anthropic, *Building Effective Agents* (Dec 2024): the canonical agent maps onto this loop; everything else is composition over it.

**Context engineering** (Anthropic, *Effective Context Engineering for AI Agents*, Sep 2025) is the discipline of the Orient phase: "curating and maintaining the optimal set of tokens during inference." The key long-loop technique is **just-in-time retrieval** — keep lightweight identifiers in context, pull full detail via tools only when the task reaches for it. (This is the exact discipline the always-loaded vs topical-rules split and the skill-router in THIS repo already implement.)

---

## ReAct — Reason + Act

Yao et al., 2022/2023, [arXiv:2210.03629](https://arxiv.org/abs/2210.03629), ICLR 2023. *[peer-reviewed]*

**Mechanism:** interleave Thought → Action → Observation triplets. Never reason to completion before acting, never act without reasoning. Reasoning updates the plan mid-flight; actions pull in external information the reasoning incorporates. Plain chain-of-thought can't course-correct once the chain starts; ReAct can.

**When:** any task where the right next action depends on what the environment actually returns — file ops, retrieval, code execution, API calls. It is the structural basis of nearly every production tool-use loop.

**Claude Code mapping:** every Read → reason → Edit → re-Read cycle is a ReAct triplet. The tool harness is the environment; thinking is the Thought; the tool call is the Action; tool output is the Observation. You are already running ReAct; the skill is doing it deliberately.

---

## Reflexion — self-reflection across attempts

Shinn et al., 2023, [arXiv:2303.11366](https://arxiv.org/abs/2303.11366), NeurIPS 2023. *[peer-reviewed]*

**Mechanism:** three roles — **Actor** (the ReAct loop), **Evaluator** (scores the trajectory; an LLM judge OR an external signal like test pass/fail), **Self-Reflection** (turns the score into a natural-language lesson stored in an episodic memory buffer). The buffer is prepended before the next episode, so past failures become first-class context. No weight updates; all learning lives in the window across episodes. 91% pass@1 on HumanEval at the time, beating GPT-4's 80%.

**When:** multi-attempt tasks where failure is informative and deterministically judgeable (coding with tests, reasoning benchmarks). Useless when episodes are genuinely independent or failure signals are ambiguous.

**Claude Code mapping:** feeding the previous turn's `pnpm tsc --noEmit` / test output back as a structured "here's what failed and why" reflection is automated Reflexion. `/goal`'s reason-injection on a "no" verdict is a lightweight Reflexion step. The repo's `learned-preferences` / memory files are a durable episodic buffer.

---

## Self-Refine — iterate within one attempt

Madaan et al., 2023, [arXiv:2303.17651](https://arxiv.org/abs/2303.17651), NeurIPS 2023. *[peer-reviewed]*

**Mechanism:** one model, three roles in a loop — **Generator** → **Feedback** (critiques its own output against criteria) → **Refiner**. Runs until max-iter or "nothing to improve." ~20% gain over one-shot across 7 tasks; needs a strong model to be effective. Distinction from Reflexion: Self-Refine is intra-episode (same attempt, improved); Reflexion is inter-episode (cross-attempt verbal memory).

**When:** subjective-quality tasks (prose, code style, math) where the model can meaningfully critique itself. Fails on factual tasks where the model is confidently wrong (it can't recognize its own error).

**Caveat that motivates maker/checker:** self-critique by the same model has a ceiling. When correctness is falsifiable, replace self-feedback with a separate evaluator (this is exactly the Evaluator-Optimizer pattern, and what `/goal`'s separate Haiku evaluator does).

---

## Plan-and-Execute (Plan-and-Solve)

Wang et al., 2023, [arXiv:2305.04091](https://arxiv.org/abs/2305.04091), ACL 2023. *[peer-reviewed]*

**Mechanism:** emit a complete plan first, then execute each subtask. Separating planning from execution prevents missing-step errors from trying to do both at once. The plan is a first-class artifact, not an internal CoT trace.

**When:** tasks with predictable sub-structure nameable upfront. Weaker when sub-structure can't be known until intermediate results arrive (then prefer adaptive orchestration).

**Claude Code mapping:** R17 (plan-before-code) in this repo IS Plan-and-Execute as engineering discipline; the `.agents/plans/*.md` file is the externalized plan; subsequent edits are the execute phase. Anthropic's orchestrator-workers extends it: orchestrator plans, workers execute subtasks.

---

## Tree of Thoughts — deliberate search with backtracking

Yao et al., 2023, [arXiv:2305.10601](https://arxiv.org/abs/2305.10601), NeurIPS 2023. *[peer-reviewed]*

**Mechanism:** a tree where each node is a coherent "thought." Three parts: (1) thought generation (multiple candidates per node), (2) state evaluation (rate each "sure/maybe/impossible"), (3) search (BFS for breadth, DFS with backtracking for depth). Lookahead + backtracking recover from dead ends — impossible in left-to-right CoT. Game of 24: 74% vs 4% for GPT-4 + CoT. Cost is multiplicative (candidates × depth × eval calls).

**When:** genuine search problems needing backtracking — constraint satisfaction, multi-step proofs, architecture decisions with many competing options. Not for linear execution.

**Claude Code mapping:** "consider 3-4 alternatives, reject each with a stated reason" (cto-policy §2 / R18) is manual ToT. The `plan-tournament` skill is a partial automation; a `Workflow` that generates N candidate approaches, judges them in parallel, and synthesizes from the winner is ToT-as-orchestration.

---

## AutoGPT / BabyAGI — the open-ended task loop

BabyAGI (Nakajima, Apr 2023, [github.com/yoheinakajima/babyagi](https://github.com/yoheinakajima/babyagi)); AutoGPT (Richards, Mar 2023). *[single-source / practitioner]*

**Mechanism (BabyAGI, ~100 lines):** three agents loop — (1) Execution completes the top task and stores the result in a vector DB; (2) Task-creation reads the objective + last result and generates new tasks; (3) Prioritization re-ranks the queue. The vector DB is episodic memory injected per task. Runs until the objective is complete or the user stops it. AutoGPT adds a thoughts/reasoning/plan/criticism per-step structure plus broad tool access.

**Documented failure modes (these are the empirical basis for hard caps):** goal drift (tasks diverge from the objective), runaway task generation (queue grows faster than it shrinks), compounding hallucination (a fabricated result becomes the next turn's input). 

**Claude Code mapping:** this is the cautionary archetype, not a template to copy raw. The subagent-cap discipline (≤5 concurrent here; batch many items into few agents) and hard budgets exist precisely to prevent the AutoGPT failure class. Use the *structure* (queue + memory + prioritization) only with the stop-condition and budget machinery from reference 03 bolted on.

---

## Voyager — skill library / lifelong learning loop

Wang et al., 2023, [arXiv:2305.16291](https://arxiv.org/abs/2305.16291), TMLR 2024. *[peer-reviewed]*

**Mechanism:** three components close a lifelong loop — (1) automatic curriculum (picks the next task from what the agent can currently do + what the environment offers); (2) skill library (stores executable code for successful behaviors; retrieves top-k relevant skills by embedding similarity before each task → compositional reuse); (3) iterative prompting (within one attempt: environment feedback + execution errors + self-verification until success or max retries). The skill library persists and grows across tasks and sessions — preventing catastrophic forgetting and enabling compounding. 3.3× more unique items, milestones up to 15.3× faster than prior SOTA.

**When:** long-running agents that benefit from accumulating reusable capability rather than re-deriving it each task.

**Claude Code mapping:** `.claude/skills/` is a structural analog of the Voyager skill library — stored, invocable, compositional; the `rare-intelligence` hook's keyword routing is the retrieval step. The honest gap: these skills are static instructions, not executable code the agent generated by solving tasks. The loop-engineering frontier here is closing that gap — a loop that writes a new skill (or memory) when it solves something novel, so the next loop is smarter.

---

## How the patterns compose into a working loop

A production loop is rarely one pattern. The reliable shape:

1. **Plan-and-Execute** to externalize the goal as a file (the anchor).
2. **ReAct** as the inner per-turn engine (observe → reason → act).
3. **Reflexion** to carry the last failure forward as a structured lesson.
4. A **separate evaluator** (Self-Refine's feedback role, promoted to its own model — `/goal`'s Haiku) as the falsifiable stop condition.
5. **ToT / orchestrator-workers** only when the solution space is wide enough to justify the multiplicative cost.
6. **Voyager-style memory** so each loop leaves the next one better-equipped.

The discourse's "loop engineering" is, precisely, choosing and wiring these deliberately instead of running a naive `while True`. See reference 03 for the stop-condition and budget machinery that turns this composition from a token furnace into an engine.
