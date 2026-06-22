# Running the loop on Claude Code (`/loop`, `/schedule`, the SDK)

> Sources: Claude Code docs — *Run prompts on a schedule*
> ([code.claude.com/docs/en/scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks)) and
> *How the agent loop works* ([…/agent-sdk/agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)).
> Requires Claude Code ≥ v2.1.72 for scheduled tasks.

## `/loop` — the three modes

| You provide | Example | Behaviour |
|---|---|---|
| interval + prompt | `/loop 5m check the deploy` | runs on a fixed cron cadence |
| **prompt only** | `/loop reduce cold latency until <300ms` | **Claude self-paces** — picks a 1 min–1 h delay each iteration based on what it observed, and **ends the loop itself by not scheduling the next wake-up once provably complete** |
| nothing | `/loop` | runs the built-in maintenance prompt, or your `.claude/loop.md` |

- **Self-paced (prompt only) is the right mode for condition-driven optimization** like ours — it's not
  time-based, and the model can stop when the metric is met.
- **Fixed interval is for polling** (a build, a PR, CI) — not for "iterate until X".
- **`.claude/loop.md`** (project) or `~/.claude/loop.md` (user) = a persistent default prompt for bare
  `/loop`; editable mid-run (takes effect next iteration), ≤ 25 KB. Good place to encode the loop's
  standing instructions + exit/safety rules so they survive compaction.
- **Stop** with `Esc` (clears the pending wake-up). Recurring tasks auto-expire after **7 days**.
- Session-scoped: tasks live in the conversation, restored on `--resume` if unexpired. A scheduled prompt
  fires *between* turns, never mid-response.

## `/schedule` & durable scheduling (when it must run unattended)

| Option | Runs on | Needs machine on | Needs open session | Local files | Min interval |
|---|---|---|---|---|---|
| **Routines** (cloud) | Anthropic cloud | No | No | No (fresh clone) | 1 h |
| **Desktop scheduled task** | your machine | Yes | No | Yes | 1 min |
| **`/loop`** | your machine | Yes | Yes | Yes | 1 min |
| **GitHub Actions** | CI | — | — | repo | cron |

Cron tools under the hood: `CronCreate` / `CronList` / `CronDelete` (5-field cron, ≤ 50 tasks/session).
Use **Routines / GitHub Actions** for loops that must survive without you watching; **`/loop`** for an
active session.

## SDK loop controls (the safety knobs)

- **`max_turns` / `max_budget_usd`** — hard backstops; the loop returns `error_max_turns` /
  `error_max_budget_usd`. *Always set one for an open-ended loop.*
- **`effort`** (`low`…`max`) — match to the cycle's difficulty; `low` for mechanical measurement steps,
  higher for the diagnose/plan step.
- **Subagents** — each starts with fresh context and returns only a summary → keeps the main loop's
  context lean (the SDK's Ralph-style context hygiene). Use for the per-cycle research/diagnose subtasks.
- **`Stop` hook** — validate the result before the loop ends (a programmatic exit gate).
- **Monitor tool** — for a dynamic `/loop`, Claude may watch a background script and stream its output
  instead of re-polling — more token-efficient and responsive than re-running a prompt.

## Self-paced vs `/goal` (independent verification)

A self-paced `/loop` **checks its own stop condition inline each turn** — convenient, but it's the loop
judging itself. `/goal` instead has a **separate model read the transcript and decide** if the goal is
met. For correctness-sensitive loops, replicate `/goal`'s independence: either use a mechanical verifier
(test/measurement — what our latency loop does) or spin up a verifier **subagent**. See
[`verifiable-exit-and-safety.md`](verifiable-exit-and-safety.md).

## Our convention for backend-mutating loops

Don't run fully headless (`--dangerously-skip-permissions`) against an un-sandboxed live backend. Run the
**measure → diagnose → research → plan** phases autonomously (read-only + research), then **gate EXECUTE
behind a human (RED) green-light**, then **verify autonomously** (re-measure). The `/loop` mechanism
drives the cadence; the RED gate guards the writes.
