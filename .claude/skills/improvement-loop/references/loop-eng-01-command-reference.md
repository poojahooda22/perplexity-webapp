# 01 — Loop Command Reference (precise spec)

> Ground truth blended from this harness's actual tool definitions (rung-1: the exact behavior you run) and official Claude Code docs read 2026-06-22. Version numbers and ship dates drift — verify against `code.claude.com/docs` before quoting a version in anything load-bearing. Mechanics below are convergent across sources and match the live tools.

---

## `/loop` — time-driven recurrence

**Signature:** `/loop [interval] [prompt]`. Alias: `/proactive`. Min Claude Code ~v2.1.72; self-pacing landed ~Week 15 (April 2026).

**Forms:**
- `/loop 5m check if the deploy finished` — fixed interval + prompt.
- `/loop check if the deploy finished` — **interval omitted → self-paced** (model chooses each next delay).
- `/loop 20m /review-pr 1234` — the prompt can be another slash command.
- `/loop` — bare: runs `.claude/loop.md` (project) or `~/.claude/loop.md` (user) if present, else a built-in maintenance prompt.

**Interval units:** `s` (rounded up to the nearest minute), `m`, `h`, `d`. Cron granularity is one minute minimum. Non-clean values (`7m`, `90m`) get rounded and Claude confirms what it picked.

**Persistence:** Session-scoped. Tasks stop when you start a new conversation; restored on `--resume`/`--continue` if not expired. Recurring tasks auto-expire 7 days after creation. Up to 50 scheduled tasks per session. Under the hood: `CronCreate` / `CronList` / `CronDelete` (standard 5-field cron); natural-language intervals are translated to cron.

**Customization:** `.claude/loop.md` or `~/.claude/loop.md` replaces the bare-`/loop` maintenance prompt; edits take effect next iteration; content over ~25,000 bytes is truncated.

**Stop:** `Esc` clears a pending `/loop` wakeup. Disable entirely with `CLAUDE_CODE_DISABLE_CRON=1`. (Tasks created by *asking Claude directly* rather than via `/loop` are not stopped by `Esc` — only `CronDelete`.)

**Self-paced mode behavior:** Claude picks the next delay (roughly 1 min to 1 hour) from what it observed — short waits while a build is active, long waits when nothing is pending — and prints the delay + reason each iteration. It may reach for the `Monitor` tool to stream background events instead of polling. On Bedrock/Vertex/Foundry, omitting the interval falls back to a fixed 10-minute schedule.

---

## `ScheduleWakeup` — the self-pacing primitive

This is what `/loop` without an interval compiles to. The model ends an iteration by scheduling its own next wake-up, then goes silent; the harness re-invokes the session at the deadline with the supplied prompt.

**Fields:** `delaySeconds` (clamped to [60, 3600]), `prompt` (the `/loop` input to fire on wake-up — pass it verbatim each turn so the next firing re-enters the loop), `reason` (one short sentence, shown to the user + telemetry).

**Sentinels:** Pass `<<autonomous-loop-dynamic>>` as `prompt` for an autonomous (no user prompt) self-paced loop — the runtime resolves it back to the autonomous-loop instructions at fire time. (There is a sibling `<<autonomous-loop>>` for the CronCreate/Routine path — do not confuse them; `ScheduleWakeup` always uses the `-dynamic` variant.)

**Cadence discipline (the cache-window rule):** The prompt cache has a ~5-minute TTL, so the cost of a wakeup is bimodal:
- **60–270s** — cache stays warm. Use for actively polling external state the harness can't notify you about (a CI run, a deploy, a remote queue).
- **300–3600s** — you pay a cache miss anyway, so make it worth it. Use when there is genuinely nothing to check sooner, or as a long fallback heartbeat.
- **Do not pick 300s.** Worst of both: you eat the cache miss without amortizing it. Drop to 270s (warm) or commit to 1200s+ (one miss buys a long wait).
- **Default idle tick: 1200–1800s** (20–30 min). Don't burn cache 12×/hour for nothing.

**Anti-pattern:** Do NOT schedule a short wakeup to poll for *harness-tracked* work (a background Bash/Agent you started) — you're re-invoked automatically when it finishes, so polling is wasted. Schedule a long fallback (1200s+) only so the loop survives if that work hangs. Short polls are for *external* state the harness can't see.

---

## `/goal` — condition-driven continuity

**Signature:** `/goal [condition | clear]`. Min ~v2.1.139 (~May 2026). Cancel words: `clear`, `stop`, `off`, `reset`, `none`, `cancel`. Bare `/goal` shows current/last goal + turns/tokens/latest evaluator reason.

**Mechanism:** Sets a session-scoped completion condition. After each turn, a small fast model (Haiku by default) reads the condition against the conversation transcript and returns yes/no + reason. "No" → keep working, with the reason injected as guidance. "Yes" → goal cleared. It is, in the docs' own words, "a wrapper around a session-scoped prompt-based Stop hook," and completion is decided "by a fresh model rather than the one doing the work." That separation is the whole point — it defeats the completion lie.

**Critical constraint:** The evaluator does NOT run commands or read files independently. It only judges what Claude has surfaced *in the conversation*. So write conditions Claude's own output can demonstrate: not "the code is correct" but "the output of `pnpm test` shows 0 failures" (and make the loop actually run it).

**Turn bound:** put it in the condition text — `... or stop after 20 turns`.

**Non-interactive:** `claude -p "/goal CHANGELOG.md has an entry for every PR merged this week"` runs the goal loop to completion in one invocation.

**Persistence:** an active goal is restored on `--resume`/`--continue`; turn count, timer, and token baseline reset. Requires a trust-accepted workspace (it uses the hooks system); unavailable under `disableAllHooks` / `allowManagedHooksOnly`.

**`/loop` vs `/goal` (memorize this):**

| | `/loop` | `/goal` |
|---|---|---|
| Next turn fires when | a time interval elapses | the previous turn finishes |
| Stops when | you cancel, or self-paced Claude judges it done | the evaluator model confirms the condition |
| Driver | clock | condition |
| Risk | runs forever on a schedule | the condition is unfalsifiable or self-judged |

---

## `/schedule` — Routines (cloud cron)

**Signature:** `/schedule [description]`. Alias: `/routines`. Claude walks setup conversationally.

A Routine is a saved Claude Code config (prompt + repos + connectors) that runs on **Anthropic-managed cloud infrastructure** — survives your laptop being off. Triggers: `schedule` (cron, **min 1 hour**), `API` (HTTP POST to a per-routine endpoint), `GitHub events` (PR opened, release, etc.). Runs as a full autonomous cloud session with no permission prompts. In research preview as of mid-2026; rate-limited.

`/schedule` in the CLI creates schedule-triggered Routines only; add API/GitHub triggers on the web at `claude.ai/code/routines`. Unavailable when authed via Console API key or a cloud-provider key (needs claude.ai subscription login).

**`/loop` vs Routine:** `/loop` is local, needs an open session, min 1-minute interval, restored on resume. A Routine is cloud, machine-independent, persistent, min 1-hour interval. Use `/loop` for tight local polling; a Routine for durable scheduled automation.

**This repo's cloud-routine notes:** the model id must be `claude-opus-4-8[1m]` for 1M Opus; a `job_config` update is full-replace (resend the full prompt; preserve `allow_unrestricted_git_push`). Note also: in THIS workspace the routines that actually fire daily are Windows Scheduled Tasks (`run-routine.ps1` → local `claude -p`), not the (disabled) cloud routines — confirm which layer you're editing.

---

## `Workflow` tool — deterministic multi-agent orchestration

A JS script the model writes; the runtime executes it in a separate environment and returns when done. Intermediate results live in script variables, NOT the model's context window — that's the key scaling property over naive orchestrator-workers. (Triggered in stock Claude Code by `ultracode` / "use a workflow"; here it is a first-class tool.)

**Script shape:**
```js
export const meta = { name, description, phases: [{title, detail}] } // pure literal, required
phase('Find')
const hits = await agent('prompt', { schema, phase: 'Find', label, model, isolation, agentType })
const out  = await parallel(items.map(x => () => agent(...)))         // BARRIER: awaits all
const res  = await pipeline(items, stage1, stage2)                    // NO barrier between stages
log('message'); // narrator line
```

**Primitives:**
- `agent(prompt, opts?)` → final text, or the validated object if `opts.schema` (a JSON Schema; the sub-agent is forced to call StructuredOutput and the model retries on mismatch). Returns `null` if skipped/died — `.filter(Boolean)`.
- `parallel(thunks)` → runs concurrently, **awaits all** (a barrier). A thrown thunk resolves to `null`. Use only when you genuinely need every result together (dedup/merge across the full set, early-exit on zero, cross-item comparison).
- `pipeline(items, ...stages)` → each item flows through all stages independently, **no barrier**; wall-clock = slowest single chain. The default for multi-stage work.
- `phase(title)`, `log(msg)`, `args` (the input value), `budget` (`{total, spent(), remaining()}` — hard ceiling; `agent()` throws past it), `workflow(name|{scriptPath}, args)` (run another workflow inline — **nests one level only**, throws if nested deeper).

**Concurrency:** capped at `min(16, cores-2)` concurrent; 1000 agents total per run; ≤4096 items per `parallel`/`pipeline` call. **In this repo, additionally cap to ≤5 concurrent sub-agents per wave** (project rule) — pass more items, but design fan-outs to that width.

**The canonical pattern — pipeline by default, verify as each review lands:**
```js
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v }))))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```

**Determinism note:** `Date.now()` / `Math.random()` / argless `new Date()` are unavailable in scripts (they'd break resume). Vary by index; stamp time after the run. Resume a paused/edited run with `Workflow({ scriptPath, resumeFromRunId })` — unchanged agent() calls return cached results; the first edited call onward re-runs live.

**Opt-in only.** See SKILL.md "Workflow gate." Don't author one unless the user opted into that scale.

---

## Ralph loop — fresh-context-per-iteration

The reference unattended loop. Two implementations, architecturally different:

**Original (bash-outer, Geoffrey Huntley, July 2025):**
```bash
while :; do cat PROMPT.md | claude-code ; done
```
Each iteration is a fresh agent with a clean window. Progress + state live in git + files (`PROMPT.md`, `IMPLEMENTATION_PLAN.md`, `specs/`, `AGENT.md`). The agent reads current state from disk, does ONE task, runs tests/linters, updates the plan, commits, exits; bash relaunches. Cost is O(N) because no history re-accumulates. Stop: plan file empties or operator kills the process. Three phases: Requirements (write `specs/*.md`) → Planning (generate `IMPLEMENTATION_PLAN.md`, plan only) → Building (the loop).

**Official `ralph-wiggum` plugin (Anthropic, Dec 2025):**
```
/ralph-loop "<prompt> ... output <promise>COMPLETE</promise> when done" --completion-promise "COMPLETE" --max-iterations 50
```
`/cancel-ralph` to stop. Uses a **Stop hook** that intercepts Claude's exit, checks for the completion-promise string, and reinjects the prompt if absent — no external bash loop. The known critique (Dex Horthy, Matt Pocock): the plugin keeps session continuity, so it reintroduces the context rot the fresh-context reset was designed to defeat — it "inverts" Ralph (agent controls the loop instead of bash controlling the agent). For unattended long runs, the bash-outer form is the safer architecture; the plugin is convenient for shorter in-session bursts. **`--max-iterations` is the primary safety mechanism** (the official README says so); the completion-promise is exact-string-match and brittle.

**The completion-promise gate exists because:** "Claude is polite. It will say 'DONE' even when the work isn't finished, because it thinks you want to review the progress." Same root problem `/goal` solves with a separate evaluator.

---

## `/loop-start`, `/loop-status`, `loop-operator` (this repo)

**`/loop-start [pattern] [--mode safe|fast]`** — starts a managed autonomous loop. Patterns: `sequential`, `continuous-pr`, `rfc-dag`, `infinite`. `safe` (default) = strict gates + checkpoints; `fast` = reduced gates. Required safety checks: tests pass before iteration 1, hook profile not globally disabled, an explicit stop condition exists. Writes a runbook under `.claude/plans/`.

**`/loop-status [--watch]`** — reports active pattern, current phase, last good checkpoint, failing checks, time/cost drift, and a recommended intervention (continue/pause/stop).

**`loop-operator` agent** — runs autonomous loops safely: tracks checkpoints, detects stalls and retry storms, pauses + reduces scope on repeated failure, resumes only after verification. **Escalates** on: no progress across two consecutive checkpoints, repeated identical-stack-trace failures, cost drift outside budget, or merge conflicts blocking the queue. Use it as the supervisor for any long autonomous run in this repo.
