---
name: improvement-loop
description: Run an autonomous, evidence-grounded improvement loop on Lumina — measure → diagnose → research → plan → execute → verify, iterating until a mechanically-verifiable metric is hit (e.g. "every /finance/* cold first-fetch < 300ms"). The Ralph-Wiggum lineage (Geoffrey Huntley) + the evaluator-optimizer / Reflexion patterns, adapted with an INDEPENDENT numeric verifier, a HARD max-iteration safety cap, a persistent on-disk baseline/journal, and RED (human) gates before risky writes. Use whenever the task is "keep iterating until X is true", reduce/optimize a metric (latency, bundle size, bug count, coverage), run a /loop or /schedule, or design a self-paced agentic loop. Proven on the finance cold-fetch latency loop (9.3 s → 3 ms). Covers /loop vs /schedule, how to write a verifiable exit + safety cap, and how to NOT build an infinite or self-judging loop.
---

# improvement-loop — running a verifiable agentic loop on Lumina

A loop is the right tool when the goal is **"keep going until a measurable condition is true"** rather
than a one-shot edit: reduce a latency, drive bug count to zero, hit a coverage %, shrink a bundle. This
skill is how to run one **correctly** — grounded in the technique's origin (Geoffrey Huntley's *Ralph
Wiggum* loop, July 2025) and the evaluator-optimizer / Reflexion research, hardened with the two things
that separate a useful loop from a runaway one: an **independent, mechanical verifier** and a **hard
iteration cap**.

It was proven on this repo: the finance **cold first-fetch latency loop** took `/finance/summary` from
**9308 ms → 3 ms** (and all 7 finance APIs under 5 ms) in one cycle — measure → diagnose → research →
plan → (RED gate) → execute → verify. The full record is in
[`.agents/latency-loop/cold-fetch-baseline.md`](../../../.agents/latency-loop/cold-fetch-baseline.md).

## The loop shape

```
state on disk: .agents/<loop>/baseline.md  (target + current metrics + per-cycle log + lessons)

each cycle:
  1 MEASURE    independent verifier → objective numbers (curl/Chrome-MCP/test/bundle stat), NOT vibes
  2 DIAGNOSE   worst gap vs target; READ the journal so you don't retry a dead end (Reflexion)
  3 RESEARCH   evidence-grounded + cited — how the industry solves THIS (only what the cycle needs)
  4 PLAN       ONE prioritized change, file:line targets, expected delta   ──► RED GATE (risky writes)
  5 EXECUTE    apply it
  6 VERIFY     re-MEASURE (step 1) → did the number move? write the lesson to the journal
  EXIT  when the metric clears the target for every item            (the goal)
  STOP  when max cycles hit, OR N cycles with no progress, OR a blocker → escalate to RED  (safety)
```

This fuses **Ralph** (fresh context per cycle, plan-on-disk as state, backpressure, one-thing-per-loop),
the **evaluator-optimizer / Reflexion** patterns (generate → independent critique → refine, with lessons
written to memory), and the rareLab **master-red-team** seeds (cited research bar, cynical posture, RED
watches the gates).

## Non-negotiables

1. **The exit metric is mechanically verifiable.** "all 7 `/finance/*` cold fetches < 300 ms", not
   "make it faster". If a separate process can't check it with a number, the loop isn't ready to run.
2. **An INDEPENDENT verifier decides, not the loop's own say-so.** Latency/coverage/bundle = objective
   numbers from a tool (curl, Chrome MCP, `bun test`, a bundle stat) — never "looks faster". For
   subjective goals, spin up a verifier subagent that grades the transcript (this is what `/goal` does
   with a separate model). Self-judgment is how a loop declares false victory or runs forever.
3. **A HARD safety cap is the PRIMARY infinite-loop guard — not the exit metric.** Stop and escalate to
   RED after **max cycles**, OR **N consecutive cycles with no measurable progress**, OR a **blocker**.
   "Never exit until <300 ms" without a cap is an infinite loop when the target is physically impossible.
4. **State lives on disk, never only in the prompt.** A baseline/journal file (`.agents/<loop>/*.md`):
   target, per-cycle metrics, what was tried, what worked, lessons. Context compaction drops early
   messages; the file is re-read each cycle (Ralph's plan-on-disk; Reflexion's lesson memory).
5. **One change per cycle.** Multi-change cycles make the verify step un-attributable — you can't tell
   which edit moved the number. Ralph's cardinal rule.
6. **RED gate before risky / irreversible writes.** The loop autonomously measures, diagnoses, and
   researches; it **pauses for human green-light before backend/prod/code writes**. Don't run a
   `--dangerously-skip-permissions` autonomous loop against code that isn't sandboxed.
7. **Backpressure is the real bottleneck, not generation.** The verify step (tests/build/measurement)
   must be able to REJECT bad work. A loop with weak backpressure ships regressions confidently.
8. **Evidence over vibes.** The research step cites real sources (docs, repos, RFCs, papers) — no
   hallucinated metrics ("40% faster" with no measurement is banned).

## Decision tree — open the one reference you need

- **What Ralph actually is / the bash loop / fresh-context-per-iteration / steering / backpressure** →
  [`references/ralph-loop.md`](references/ralph-loop.md)
- **The patterns behind it — agent-loop primitive, evaluator-optimizer, Reflexion, self-refine, ReAct** →
  [`references/agentic-loop-patterns.md`](references/agentic-loop-patterns.md)
- **Running it on Claude Code — `/loop` (interval vs self-paced vs `loop.md`), `/schedule`, the SDK loop
  controls (max_turns/budget/effort/subagents/Stop hook), the Monitor tool** →
  [`references/claude-code-loop-and-schedule.md`](references/claude-code-loop-and-schedule.md)
- **Designing the exit + safety — verifiable success conditions, independent verifier, the iteration cap,
  no-progress/blocker escalation, the journal** →
  [`references/verifiable-exit-and-safety.md`](references/verifiable-exit-and-safety.md)
- **The worked example end-to-end — the finance latency loop: baseline, root cause, the SWR + warm-on-
  startup fix at file:line, before/after data, the measurement protocol** →
  [`references/lumina-latency-loop.md`](references/lumina-latency-loop.md)

## Worked example — the finance cold-fetch latency loop (1 cycle)

| Phase | What happened |
|---|---|
| **Baseline** | curl-timed every `/finance/*` cold (cache empty): summary 9308 ms, predictions 6082, stocks 4113, discover 615, crypto 436, sectors 352, indices 308 → stored in the baseline MD. |
| **Diagnose** | Read `lib/cache.ts` + `routes.ts`. Cache wasn't broken (back-to-back = 3 ms); the cost was `getOrRefresh` **blocking** on every TTL-lapse miss (no stale-while-revalidate) + **no warm-on-startup**. |
| **Research** | Grounded the fix: stale-while-revalidate (RFC 5861) + cache-warming, citing how the industry serves first-fetch fast. |
| **Plan → RED gate** | P0 SWR in the cache layer; P1 warm-on-startup. Stopped for green-light. |
| **Execute** | SWR + `forceRefresh` in `lib/cache.ts`; `warmFinanceCache` in `routes.ts`; warm-on-startup in `index.ts`. |
| **Verify** | Restart → first fetch of every endpoint **< 5 ms** (warm-on-startup). SWR confirmed: stale read = 2.8 ms, not 6 s. **Exit condition met.** |

The independent verifier was **curl against the public `/finance/*` endpoints** (no browser/auth needed) —
objective ms, reproducible every cycle. See [`references/lumina-latency-loop.md`](references/lumina-latency-loop.md).

## Anti-patterns

- **Self-judging exit** — the loop deciding it's "good enough". Use an independent numeric/transcript
  verifier.
- **Unverifiable goal** — "improve the API". Can't be checked → can't be looped.
- **No iteration cap** — `while <metric not met>` against an impossible target = infinite loop. The
  latency loop's "<300 ms" is only reachable because the *mechanism* (warm cache) makes it reachable; a
  cold synchronous LLM call can never hit it, so the cap is what guarantees termination.
- **Many changes per cycle** — you lose attribution; the verify step can't tell you what worked.
- **State in the prompt** — compaction eats it; the loop forgets the baseline and re-treads dead ends.
- **Autonomous risky writes** — letting a self-paced loop edit the backend/prod with no RED gate and no
  sandbox.
- **Cargo-cult research** — "best practice" with no source. Cite the doc/repo/RFC/paper, or mark low-confidence.
- **Measuring the wrong thing** — here, measuring WARM latency (already fast, cached) instead of the COLD
  first-fetch we set out to fix. Verify the metric you actually care about.

## Mechanism on Claude Code (which loop primitive)

- **`/loop` self-paced** (no interval) — the model works, checks its own stop condition, and stops by not
  scheduling the next wake-up. Right for condition-driven work. Pair with an independent verifier + a cap.
- **`/loop <interval>`** — fixed cron cadence; for *polling* (a deploy, CI), not condition-driven optimization.
- **`.claude/loop.md`** — a persistent default prompt for bare `/loop`, editable mid-run.
- **`/schedule` / Routines / Desktop / GitHub Actions** — durable, unattended scheduling (survives the
  session) when the loop must run without you watching.
- **SDK controls** — `max_turns` / `max_budget_usd` (hard backstops), `effort`, **subagents** to keep the
  main context lean, a **`Stop` hook** to validate the result before the loop ends, the **Monitor tool**
  to watch a background process instead of polling.

For backend-mutating loops like ours, **don't fully automate**: run the measure/diagnose/research/plan
autonomously, gate EXECUTE behind RED, then verify autonomously. The loop is the discipline, not the autopilot.

## Status & links

Built 2026-06-22 from the loop research + the finance latency loop. References cite their sources inline
(Huntley's ghuntley.com/ralph, the Claude Code agent-loop + scheduled-tasks docs, AWS evaluator-reflect-
refine, the Reflexion / Self-Refine / ReAct papers). The worked artifact is
[`.agents/latency-loop/cold-fetch-baseline.md`](../../../.agents/latency-loop/cold-fetch-baseline.md);
the rareLab `master-red-team` prompt is the cynical-research-bar ancestor. See [[dev-skills-library]] and
[[browser-debug-setup]] (the latency-measurement harness this loop's verifier uses).
