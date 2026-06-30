# Agentic hooks — the portable engine

> The "agentic brain": a set of lifecycle hooks that make **plain-language
> prompts invoke the right skills, rules, and memories automatically**, and that
> hold the agent to a senior operating standard. **Project-agnostic** — every
> path resolves from the host project; nothing here names a specific project.
> Lineage: a clean-room reconstruction of the rareLab Cognitive-Mesh dispatch +
> the "agentic brain" pattern (the pi-style operating-discipline injection),
> stripped of all domain coupling.
>
> **Status in this repo: ACTIVE.** These hooks are wired live into
> [`../../settings.json`](../../settings.json) and auto-inject on every
> prompt/tool/stop (loaded at the next SessionStart). See
> [`../../AGENTIC-HARNESS.md`](../../AGENTIC-HARNESS.md). To turn off, remove the
> `*/agentic/*` entries from `settings.json`.

## The files

| File | Lifecycle | What it does |
|---|---|---|
| `skill-scoring.mjs` | (library) | Pure, testable scoring core. Scans `.claude/skills/`, parses `SKILL.md` frontmatter, scores a prompt. No IO, no side effects on import. |
| `prompt-intelligence.mjs` | UserPromptSubmit | The dispatcher. Surfaces a recall menu of candidate skills + relevant memories; handles the engineer-prompt sentinel + Phase-2 confirmation protocol. |
| `agentic-brain.mjs` | UserPromptSubmit | Injects senior-agent operating discipline, scaled to the prompt (tool-heavy / long-horizon). |
| `agents-md-bridge.mjs` | UserPromptSubmit | Injects the `## Learned User Preferences` / `## Learned Workspace Facts` sections from root `AGENTS.md` (cross-tool learning bridge). |
| `agentic-brain-bootstrap.mjs` | SessionStart | Seeds the operating brain + checkpoint discipline at token zero; resets the per-session ledger. |
| `agentic-brain-tooluse.mjs` | PreToolUse | Generic git/working-tree safety gate (deny `--no-verify`, ask on `reset --hard`/force-push, etc.). Fail-open. |
| `agentic-brain-toolresult.mjs` | PostToolUse | "Green ≠ correct" reminders after type-check/commit; flags the ledger that work happened. |
| `agentic-brain-stop.mjs` | Stop | Verify-before-done self-review gate, fires at most once per session, double loop-guarded. |
| `file-dispatch.mjs` | PreToolUse (Edit/Write) | Reminds you to invoke a skill + read a topical rule when editing a mapped path. Driven by `file-skill-map.json`. |
| `file-skill-map.json` | (data) | The project-local path→skill/rule map for `file-dispatch`. Empty `map` = no-op. |
| `skill-match-test.mjs` | (test) | Optional prompt battery for the scorer. *(present only if ported.)* |

## Design guarantees

- **Project-agnostic.** No hook contains a project name or a project gate. Paths
  resolve from `process.env.CLAUDE_PROJECT_DIR` / `input.cwd` / `process.cwd()`.
  Skills + memory are scanned from the host repo's own `.claude/`.
- **Additive + fail-open.** Every hook degrades to a no-op (`{}`) on any malformed
  input. The one hook that can pause a turn (`stop`) is double loop-guarded and
  fires at most once per session. A defect here can never brick the toolchain.
- **Session state is project-local** under `.claude/.cache/agentic-sessions/`
  (gitignored) — it travels with the repo and never leaks across projects.
- **Runtime: Node.** The hooks are `.mjs` run via `node` (matching this repo's
  existing `precheck-licensing.mjs`), not Bun.

## Tuning knobs

- `prompt-intelligence.mjs`: `SKILL_MENU_SIZE`, `AGENT_SKILL_PICKS`,
  `MAX_MEMORIES_INJECTED`, `MIN_PROMPT_LENGTH`.
- `skill-scoring.mjs`: `DEFAULT_MIN_SCORE`, the boost constants, and the optional
  `SKILL_INTENT_AFFINITY` map (extend per project; degrades gracefully).
- `agentic-brain-tooluse.mjs`: `BLOCK_COMMIT_ATTRIBUTION` (default `false` —
  blocking `Co-Authored-By`/`🤖` trailers conflicts with standard Claude Code
  commit conventions, so it is opt-in).
