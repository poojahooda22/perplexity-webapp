# 03 — Stop Conditions, Budgets, and Convergence

> The single highest-leverage part of loop design. *"`while True: result = agent.run(task) # done when…?` — that question mark is where the money goes."* (Daniel Nwaneri, freeCodeCamp). Every documented loop disaster traces to a missing or wrong stop condition. This is the machinery that makes a loop terminate correctly instead of running up a four-figure bill.

---

## The four termination classes (use all four; only Class 1 is semantic)

**Class 1 — Goal completion (the only correct stop).** A check independent of the agent's self-report confirms the definition-of-done holds. Everything else is a safety net. The agent CANNOT be its own completion judge — the failure mode where it declares success to escape the loop is universal ("Claude is polite; it will say DONE even when the work isn't finished"). Implementations of the independent check: tests/type-check/linter exit code, a separate evaluator model (`/goal`'s Haiku), Voyager's self-verification, a human/visual diff.

**Class 2 — Max-iteration cap (hard wall).** 15-25 iterations for most well-defined tasks; start at 5-10 and raise only with cost data. Inject budget pressure: when N-k iterations remain, warn the model so it wraps up rather than starting a tool call it can't finish. In the `Workflow` tool this is `budget.remaining()`; in `/ralph-loop` it's `--max-iterations` (the official primary safety mechanism); in `/goal` it's `... or stop after 20 turns` in the condition text.

**Class 3 — Token/cost budget (hard wall, enforced outside the model).** Checked before each API call by a governance layer, never trusted to the model's own budget awareness. The "$47,000 agent loop" (Nov 2025, a four-agent LangChain pipeline in an infinite loop) is the canonical failure when soft alerts substitute for hard enforcement. In the `Workflow` tool, `budget.total` is a hard ceiling — `agent()` throws past it; gate loops on `budget.remaining()`.

**Class 4 — No-progress / stagnation detection.** Terminate if the last K iterations produced no new tool calls, no state change, or near-identical outputs. Implementations: cosine similarity of consecutive observations above ~0.97 over a sliding window; action-entropy (flag when the last 3 action patterns have all been seen before); evaluator-score delta < 1 point over two rounds. This catches the "robot walking into the same wall" infinite loop that a max-iter cap only catches *after* burning the full budget.

**Rule of thumb:** Class 1 decides *success*; Classes 2-4 prevent *runaway*. A loop with only Class 1 runs forever on a bad goal; a loop with only Classes 2-4 stops on time but never knows if it actually succeeded. Wire all four.

---

## Definition-of-done: the contract that makes Class 1 work

The verification criterion must be specified **before** execution, not derived from what the agent happened to produce. When the DoD is "the agent decides it's done," drift is invisible. When it's external and falsifiable, the stop condition can't be gamed.

**Binary, observable, bounded.** Not "the data layer is more modular" (subjective, unfalsifiable → 8 iterations of circular refactor, ~$50, no improvement, `git checkout .`). Instead: *"all tests in `tests/unit/` pass with exit code 0 AND `tsc --noEmit` is clean AND no new files were created outside `src/`."*

**Specify quantity AND quality, or the agent games it.** "Write tests that pass" → `assert True`. The completion bias breakdown from one corpus: 38% no tests, 24% skeleton tests, 28% happy-path only, 18% over-mocking. Counter with explicit criteria: coverage %, type-clean, linter-clean, N assertions minimum, no stray files. *"Asking is fragile. Rules are durable."*

**Write conditions the agent's own output can demonstrate.** `/goal`'s evaluator only sees the conversation — it does not run commands or read files. So the loop must surface the evidence: the condition is "the printed output of `pnpm test` shows 0 failures," and the loop must actually run `pnpm test` each turn. A condition the evaluator can't observe is unfalsifiable.

---

## The completion lie (and how each tool counters it)

The most expensive subtle failure: the agent exhausts context mid-implementation, or wants you to "review progress," and declares success while the work is half-done.

| Tool | Counter |
|---|---|
| `/goal` | A separate fresh model (Haiku) judges completion against the original condition, not the worker's self-report. |
| `/ralph-loop` | A completion-promise string the agent must emit, gated by a Stop hook (brittle: exact-string match, single condition). |
| Plain Ralph (bash) | The plan file must empty; the bash layer doesn't trust the agent's "done." |
| `Workflow` | Use a separate verifier `agent()` with a `schema` that forces an explicit `isReal`/`passed` boolean; filter on it. |

Whatever the tool: **the maker never certifies its own completion.**

---

## The token economics: why naive loops cost O(N²)

Each LLM API call bills for the *entire* conversation history. A continuous-context loop re-sends everything every iteration:

- 5-step loop ≈ 3.2× a single call. 50 steps ≈ 30×. 200 steps ≈ 100×+.
- Where the money goes (one 30-team audit): re-sent context **62%**, tool definitions 14%, actual reasoning 11%, system prompts 8%, wasted retries 5%.
- *"Iteration one costs 100 tokens. Iteration ten costs thousands"* — because every retry re-reads all prior failed attempts.

**The fix is architectural: fresh context per unit of work.** Ralph resets to a clean window each iteration and reads current state from files + git, so cost is O(N), not O(N²). One task per iteration; offload reads to subagents (their transcripts don't pollute the parent); persist state on disk, not in the growing window. This is also why the `Workflow` tool keeps intermediate results in script variables instead of a model's context — the orchestrator's window never becomes the bottleneck.

**Cache discipline (it matters in `/loop` self-paced mode):** the prompt cache TTL is ~5 minutes. A 30-minute `/loop` that re-includes an 800K-token history with no cache reuse is how a single overnight run hit $6,000. Keep iterations short, keep history off the hot path, and use the `ScheduleWakeup` cadence rule (≤270s stays warm; 1200s+ for genuine idle).

---

## Budget enforcement patterns

- **Hard caps, not soft alerts.** A soft "you're at 80% budget" alert the model can ignore is not enforcement. The ceiling must be in the harness/governance layer, checked before the call completes.
- **Practitioner defaults (calibrate to your own data):** $50/day soft cap, $100/day hard cutoff, $1,000/month requiring approval. Codex `/goal` uses token budgets instead of iteration counts: small 100K-500K, medium 500K-2M, large 2M-10M, with a graceful wrap-up prompt on exhaustion.
- **Cheap model for the loop's bookkeeping.** Use Haiku for routine checking/evaluation steps (60-80% cost reduction vs running the frontier model as its own judge). `/goal` defaults its evaluator to Haiku for exactly this reason.
- **Graceful wrap-up on budget exhaustion.** Don't hard-kill mid-edit — when the budget is nearly spent, inject a "wind down: commit what's done, write progress, stop" instruction so the run ends in a recoverable state.

---

## Convergence: loop-until-dry and no-progress

**Loop-until-K-consecutive-empty.** For collection tasks ("find all X") rather than fixed-objective tasks. Run until K consecutive passes produce no new findings. K=2 is the practical minimum; K=3 for noisy environments. This is the shape behind the repo's `audit:r22-fx-alpha-policy` / `audit:r03-mirror` sweeps and the `Workflow` "loop-until-dry" example (keep spawning finders until two rounds add nothing, deduping against everything seen — not against confirmed, or judge-rejected findings reappear forever).

```js
// Workflow loop-until-dry skeleton
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {
  const fresh = (await parallel(FINDERS.map(f => () => agent(f.prompt, {schema: BUGS}))))
    .filter(Boolean).flatMap(r => r.bugs).filter(b => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  confirmed.push(...await verify(fresh))   // separate verifier
}
```

**Convergence, from first principles.** A loop converges only if each iteration shrinks the feasible solution space or advances measurably toward the DoD. A loop that revisits the same states (circling) or generates more work than it completes (expanding) is divergent and needs a hard stop. **The optimization target is convergence per token spent, not iterations per second** — a fast loop cycling over bad decisions is worse than a slow loop making good ones.

---

## The pre-flight checklist (answer in writing before starting any loop)

1. **DoD** — what exact, observable, falsifiable condition means "done"? Who/what checks it (not the maker)?
2. **Class 2** — max iterations?
3. **Class 3** — token/dollar ceiling, enforced where?
4. **Class 4** — what counts as "no progress," and after how many iterations does that stop it?
5. **State** — fresh context per unit, or growing? If growing, why is O(N²) acceptable here?
6. **Anchor** — where does the goal live so it survives the loop (file, system prompt repetition)?
7. **Recoverability** — if it stops mid-way (budget/error), is the state committed and resumable?

Any blank → do not start the loop. A blank here is the bug that ships with a dollar figure attached.
