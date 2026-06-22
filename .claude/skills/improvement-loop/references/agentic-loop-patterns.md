# Agentic loop patterns (the research lineage)

Ralph is one expression of a deeper primitive. These are the named patterns that justify the loop's
design — cite them when explaining *why* the loop is shaped the way it is.

## The agent loop primitive

> Source: Claude Code — *How the agent loop works*
> ([code.claude.com/docs/en/agent-sdk/agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)).

Every agent session is the same cycle: **receive prompt → evaluate → call tool(s) → feed results back →
repeat until a response has no tool calls → return.** Each round trip is a *turn*. "The way agentic loops
work is by executing a tool and then evaluating the result of that tool" (Huntley, [ghuntley.com/loop](https://ghuntley.com/loop/)).
An improvement loop is this primitive wrapped in an outer condition: *keep taking actions until the
measured result clears the bar.*

Built-in controls that bound it: `max_turns`, `max_budget_usd` (hard stops → `error_max_turns` /
`error_max_budget_usd` result subtypes), `effort`, and **subagents** (each gets a fresh context; only
their final summary returns to the parent — the SDK's answer to context bloat, mirroring Ralph's
fresh-context idea). A **`Stop` hook** can validate the result before the loop ends.

## Evaluator-optimizer (a.k.a. reflect-refine)

> Source: AWS Prescriptive Guidance — *Evaluator reflect-refine loop patterns*
> ([docs.aws.amazon.com/.../evaluator-reflect-refine-loop-patterns.html](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html)).

A **generator** produces output → an **evaluator** critiques it against a rubric/criteria → the output is
**refined** → repeat **until it meets the criteria, is approved, or hits a retry limit**. Modeled on a
control-theory feedback loop (monitor output → compare to desired state → correct). The takeaway that
matters: the evaluator is a **separate** step from the generator — "a second agent (or a follow-up prompt)
performs a structured evaluation". That separation is what makes the verdict trustworthy. Our loop's
"verify" step is the evaluator; the curl/Chrome-MCP measurement is the rubric.

## Reflexion

> Shinn et al., *Reflexion: Language Agents with Verbal Reinforcement Learning*, NeurIPS 2023 (arXiv:2303.11366).

Extends ReAct with **self-evaluation + memory**. Three roles: an **Actor** that acts, an **Evaluator**
that scores the trajectory, and a **Self-Reflection** step that writes a *verbal lesson* into an episodic
memory buffer that future attempts read back — a genuine learning loop. **This is why our loop keeps a
journal on disk:** each cycle records what was tried and what worked, so the next cycle doesn't re-tread a
dead end. Without it, a fresh-context loop repeats its own mistakes.

## Self-Refine

> Madaan et al., *Self-Refine: Iterative Refinement with Self-Feedback*, NeurIPS 2023 (arXiv:2303.17651).

The same model generates output, critiques its own output, and refines using that feedback — iteratively.
Cheap and effective for single-actor refinement, but note the failure mode it shares with all
self-critique: **a model grading its own work can be over-confident.** For anything where correctness
matters, prefer an *independent* evaluator (a different model/subagent, or — best — a mechanical check
like a test or a measurement). See [`verifiable-exit-and-safety.md`](verifiable-exit-and-safety.md).

## ReAct

> Yao et al., *ReAct: Synergizing Reasoning and Acting in Language Models*, ICLR 2023 (arXiv:2210.03629).

Interleaves **reasoning traces** with **actions** (tool calls) so the model plans, acts, observes, and
re-plans. The substrate the above patterns build on; the Claude Code agent loop is a ReAct loop with tools.

## How they compose into our loop

```
ReAct                → reason + act + observe each cycle (the substrate)
Ralph                → fresh context per cycle, plan/baseline on disk, backpressure, one-thing-per-loop
Evaluator-optimizer  → an INDEPENDENT verify step decides continue vs stop (not self-judgment)
Reflexion            → write the lesson to the journal so the next cycle improves, not repeats
+ our additions      → mechanically-verifiable exit metric, hard iteration cap, RED gate before writes
```

The recurring theme across every source: **the loop is only as good as its evaluation/backpressure.**
Generation is cheap; a loop with a weak or self-judged evaluator converges on confident-but-wrong.
