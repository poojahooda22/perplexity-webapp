# The Ralph Wiggum loop (the origin)

> Named and popularised by **Geoffrey Huntley**, *"Ralph Wiggum as a software engineer"*, **July 14 2025**
> — [ghuntley.com/ralph](https://ghuntley.com/ralph/) (the canonical reference). Follow-ups:
> [ghuntley.com/loop](https://ghuntley.com/loop/) ("everything is a ralph loop"),
> [github.com/ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum) (the script +
> file layout), [awesomeclaude.ai/ralph-wiggum](https://awesomeclaude.ai/ralph-wiggum) (practitioner guide).
> The name is the Simpsons character who rams into doorframes shouting "I'm helping!" — *deterministically
> bad in an undeterministic world*, made useful by looping.

## The whole thing, in its purest form

```bash
while :; do cat PROMPT.md | claude ; done
```

You `cat` a prompt file, pipe it to the agent, it does one unit of work, the process exits, the loop
restarts it. That's it. Everything lives on disk; everything is visible.

## The one non-obvious idea: FRESH context per iteration

Each iteration starts a **new session with empty context**. This is what distinguishes Ralph from a
single long-running chat. Why it matters:

- **Context scarcity forces quality.** "The more you use the context window, the worse the outcomes."
  A fresh ~170k window each cycle, loaded deterministically with only the specs + plan it needs.
- **It can't inherit its own earlier reasoning errors.** Each cycle re-derives state from the specs,
  the code, and the test results — not from a polluted transcript.

State persists **on disk between iterations**, not in context:

| File | Role |
|---|---|
| `IMPLEMENTATION_PLAN.md` / `fix_plan.md` | Prioritised task list; updated each cycle (done items, discovered issues). |
| `AGENTS.md` | Operational guide — the real build/test commands; evolves as learnings accumulate. |
| `specs/*` | Requirement specs, one per concern. The upstream steering signal. |

## Per-iteration lifecycle (BUILDING mode)

1. **Orient** — study the specs + existing code ("study", not "read" — more precise instruction).
2. **Read the plan.**
3. **Select** the single most important task.
4. **Investigate** the relevant source.
5. **Implement** (use subagents to avoid polluting the main context).
6. **Validate** — run the real tests/build (this is the backpressure).
7. **Update the plan** — mark done, note discoveries.
8. **Commit + push.** Context clears; the outer loop restarts.

A separate **PLANNING mode** does gap-analysis (specs vs code) and only writes the plan — no implementation.

## Steering — the two forces that keep it on the rails

- **Upstream (planning):** specs + plan decide WHAT it builds. Ambiguous specs produce wrong code, not
  intelligent recovery — precision here is the work.
- **Downstream (backpressure):** tests, type systems, compilers, validators **reject invalid output**.
  "Code generation is trivial; the bottleneck is verification." Ralph iterates until backpressure passes.
  *"It's the speed of the wheel turning that matters, balanced against the axis of correctness."*

## Cardinal rules

- **One thing per loop.** Multi-tasking dilutes context and compounds errors.
- **"Don't assume not implemented."** A guardrail against the agent re-building what already exists.
- **Capture the why** in code + plan, so the next fresh-context iteration understands intent.
- **Let Ralph Ralph** — trust it to self-correct across iterations; the human moves OUTSIDE the loop
  (observe failure domains, tune the prompt/specs), rather than prescribing each task.

## Stop / safety (Ralph has no hard limit by default)

- **Scope discipline** ("one task") + **backpressure** (tests must pass before commit) + **natural
  completion** (exits after a clean commit).
- **`--max-iterations`** (`./loop.sh 20`) — the practitioner guides call this the **primary** safety net.
- **`--completion-promise`** — an exact string the agent emits to signal done.
- **Manual stop** — Ctrl-C.

## Safety & sandboxing (loud warning in the canonical repo)

> "Running without a sandbox exposes credentials, browser cookies, SSH keys, and access tokens on your
> machine."

Run autonomous loops in a Docker sandbox locally, or a remote service (Fly, E2B) for production; restrict
API keys + network to the minimum. **This is why our latency loop gates EXECUTE behind a human RED step
rather than running headless against the live backend** (see the SKILL Non-Negotiables).

## How we adapted Ralph (vs used it raw)

We kept: fresh-context-per-cycle thinking, plan/baseline-on-disk as state, backpressure-as-bottleneck,
one-change-per-cycle, human-outside-the-loop tuning. We **added**, because we mutate a live backend and
must terminate: a mechanically-verifiable exit metric, an **independent numeric verifier**, a **hard
iteration cap**, and **RED gates before writes**. See [`verifiable-exit-and-safety.md`](verifiable-exit-and-safety.md).
