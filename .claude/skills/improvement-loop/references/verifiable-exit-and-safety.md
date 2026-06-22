# Designing the exit + safety (so the loop terminates and tells the truth)

The two ways an autonomous loop fails: it **declares false victory** (stops too early / judges itself), or
it **never stops** (impossible target, no cap). This doc is the discipline that prevents both. Sources:
the `/goal` vs `/loop` guidance, the Ralph practitioner guides
([awesomeclaude.ai/ralph-wiggum](https://awesomeclaude.ai/ralph-wiggum)), and the AWS evaluator pattern.

## 1. Write a mechanically-verifiable success condition

A separate process must be able to check it with a number or a boolean. Examples:

| ❌ Not loopable | ✅ Loopable |
|---|---|
| "make the API faster" | "every `/finance/*` cold first-fetch < 300 ms (curl `time_total`)" |
| "fix the bugs" | "all tests in `tests/` pass, exit code 0, no new files outside `src/`" |
| "improve coverage" | "line coverage ≥ 90% (`bun test --coverage`)" |
| "shrink the bundle" | "main chunk < 250 KB gzipped (build stat)" |

> If the condition can't be expressed so an evaluator can check it mechanically, **the task is not ready
> for autonomous execution** — make it measurable first, or run it human-in-the-loop.

## 2. Verify INDEPENDENTLY — never let the loop grade itself

Self-judgment ("looks faster", "seems fixed") is the #1 cause of false victory. In order of trust:

1. **Mechanical check (best)** — a test, a measurement, a build stat, a linter. No model opinion involved.
   Our latency loop uses curl-timed public endpoints. Reproducible, objective, cheap.
2. **Independent verifier subagent** — for goals a tool can't fully grade, spawn a *separate* agent (fresh
   context, tool access) to evaluate the result against the rubric. This is what `/goal` does (a separate
   model reads the transcript). The generator never decides if the goal is met.
3. **Self-critique (weakest)** — Self-Refine style. Acceptable for low-stakes drafting; over-confident for
   correctness. Don't make it the exit gate.

## 3. The HARD safety cap is the primary infinite-loop guard

The exit metric alone does NOT guarantee termination — if the target is physically impossible, the loop
runs forever. The cap does. Always include **all three**:

- **Max cycles** — `./loop.sh 20`, `max_turns`, or "stop after 6 cycles". The Ralph guides call this the
  *primary* safety net, above the completion-promise.
- **No-progress detector** — stop after **N consecutive cycles** where the worst metric didn't improve.
  Catches "thrashing without converging".
- **Blocker handling** — if the loop can't progress after ~2 attempts on the same sub-problem, **log it and
  escalate to RED** rather than spinning. ("Any problem created by AI can be resolved through a different
  series of prompts" — but a human should pick the new series when the loop is stuck.)

> The latency loop's "<300 ms" was only reachable because the *mechanism* (warm cache) makes it reachable.
> A **cold synchronous LLM call can never hit 300 ms** — so if we'd measured backend-flushed cold and
> demanded <300 ms with no cap, the loop would never exit. Match the metric to an achievable mechanism, and
> keep the cap as the backstop.

## 4. Persist state on disk (the loop's memory)

Context compaction drops early messages, and Ralph-style loops start fresh each cycle — so a baseline /
journal file is mandatory (`.agents/<loop>/baseline.md`). It holds:

- the **target** + the success condition,
- the **per-cycle metric log** (so you can see the trend — is it converging?),
- the **change applied** each cycle (one per cycle → attributable),
- **lessons** (Reflexion): what was tried, what failed, what worked — so the next fresh cycle doesn't
  repeat a dead end.

The file IS the loop's continuity. If it's only in the prompt, the loop forgets.

## 5. Backpressure must be strong enough to reject bad work

The verify step is the loop's immune system. If tests are thin, the build is permissive, or the
measurement is noisy, the loop will "pass" regressions confidently. Strengthen backpressure *before*
trusting the loop: real test commands (in `AGENTS.md`/the prompt, not generic), tight measurement
(reproducible conditions), a `Stop` hook that re-checks the metric.

## 6. Gate irreversible actions

A self-paced loop that edits the backend, pushes, or deploys with no human gate and no sandbox is the
dangerous case the Ralph docs warn about (exposed credentials; un-reviewed prod writes). For Lumina's
backend-mutating loops: **autonomous measure/diagnose/research/plan → RED gate → execute → autonomous
verify.** Or run headless only inside a sandbox (Docker / E2B / Fly).

## The checklist before you start a loop

- [ ] Success condition is a number/boolean a script can check.
- [ ] An independent verifier (mechanical preferred) decides continue vs stop.
- [ ] Max-cycles cap + no-progress detector + blocker→escalate are all set.
- [ ] A baseline/journal file exists and is updated each cycle.
- [ ] Backpressure (tests/build/measurement) can actually reject bad work.
- [ ] Irreversible writes are gated (RED) or sandboxed.
- [ ] You're measuring the metric you actually care about (cold, not warm; the real path).