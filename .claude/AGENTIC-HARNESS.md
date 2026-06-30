# Portable Agentic Harness

> **What this is.** A project-agnostic agent "brain" — skills + rules + hooks +
> memory — designed to be **git-synced across projects**. Its purpose: *in plain
> language, the right skills, rules, and memories get invoked automatically*, and
> the agent is held to a senior operating standard. Synced into this repo from the
> rareLab Cognitive-Mesh harness, **genericized** so nothing names rareLab or its
> Three.js/WebGL/shader domain. Lineage of the operating-discipline injection: the
> pi-style "agentic brain" pattern.
>
> **Status: ACTIVE (wired live).** The hooks are wired into
> [`settings.json`](settings.json) and auto-inject on every prompt/tool/stop. They
> take effect at the next SessionStart. [`settings.agentic.json`](settings.agentic.json)
> is kept as the reference wiring template (and the merge target if you ever reset
> `settings.json`). To turn the harness OFF, remove the agentic hook entries from
> `settings.json`.

---

## 1. The plain-language goal

You speak normally ("fix the finance cold-fetch", "add a watchlist filter",
"research X"). On each prompt, the harness:

1. **scans this project's own skills** and surfaces the 2–3 most on-target as a
   recall menu, telling the agent to invoke them *before* writing code;
2. **surfaces relevant memories** (operator preferences + project facts);
3. **points at the matching rule** (always-on rules + on-demand topical deep-dives);
4. **injects senior-agent discipline** (iterate → verify → stop only when done);
5. **gates risky tools** (git/working-tree safety) and **checks before "done"**.

It is **portable**: it reads whatever skills/memory the *host* project ships. The
same `.claude/hooks/agentic/` folder works in a finance app, a mobile backend, or
any repo — only the project's own skills/rules/memory differ.

## 2. What was synced (this pass)

```
.claude/
├── hooks/agentic/              # THE ENGINE (genericized, project-agnostic)
│   ├── skill-scoring.mjs           # pure scoring core (scans .claude/skills/)
│   ├── prompt-intelligence.mjs     # UserPromptSubmit: skill recall menu + sentinels
│   ├── agentic-brain.mjs           # UserPromptSubmit: senior-discipline injection
│   ├── agents-md-bridge.mjs        # UserPromptSubmit: AGENTS.md learned-sections bridge
│   ├── agentic-brain-bootstrap.mjs # SessionStart: seed brain + reset ledger
│   ├── agentic-brain-tooluse.mjs   # PreToolUse: generic git/working-tree safety gate
│   ├── agentic-brain-toolresult.mjs# PostToolUse: "green ≠ correct" reminders
│   ├── agentic-brain-stop.mjs      # Stop: verify-before-done (≤1×/session, loop-guarded)
│   ├── file-dispatch.mjs           # PreToolUse: path→skill/rule reminder (config-driven)
│   ├── file-skill-map.json         # the project-local path→skill map (DATA; empty = no-op)
│   └── README.md
├── rules-topical/              # on-demand deep dives (deep-research, performance,
│   │                           #   scalability, skill-dispatch, red-team, …) + README
├── rules/                      # + portable always-on rules: agentic-discipline,
│   │                           #   cynical-charter, learned-preferences, git-ip
│   │                           #   (alongside this repo's existing rules — none replaced)
├── skills/                     # + 8 portable cross-domain skills (alongside existing):
│   │                           #   agent-architect, workflow-planning, red-team-negation-loop,
│   │                           #   recall-similar, consolidate-memory, testing-verification,
│   │                           #   production-engineering, security-architecture
├── memory/preferences/         # + portable operator-preference memories (feedback_*)
├── scripts/agentic/            # recall-similar / consolidate-memory CLIs + index builder
├── hooks/judge/  + critics/    # OPTIONAL output-quality judge (NOT wired by default)
├── settings.agentic.json       # the inert wiring template (merge to activate)
└── AGENTIC-HARNESS.md          # this file

# repo root (cross-tool config — the "four md files" pattern):
AGENTS.md     # cross-tool canonical manual (Codex/Cursor/Gemini/Claude) + Learned sections
CURSOR.md     # thin pointer → AGENTS.md + CLAUDE.md
GEMINI.md     # thin pointer → AGENTS.md + CLAUDE.md
CLAUDE.md     # (unchanged) the full project-specific router for Claude Code
.cursor/rules/agentic-harness.mdc   # Cursor always-on rule → the harness
.gemini/settings.json               # Gemini CLI: contextFileName → GEMINI.md
```

### Deliberately NOT done

- **No rareLab content** — the Three.js/GLSL/compiler skills, the rareLab `.gemini`/
  `.cursor` mirror sprawl, the rareLab `AGENTS.md`, and rareLab-specific memories
  were excluded. The judge subsystem was copied but left unwired.
- **`deep-research` is a rule, not a skill** (`rules-topical/deep-research.md`) —
  there is no `deep-research` skill in the source.

## 3. On/off (already ON)

The agentic hooks are wired into [`settings.json`](settings.json) — kept
alongside your existing hooks (session-start, precheck-licensing, wiki-freshness).
They load at the next SessionStart; you'll see status messages like "Matching
skills to your prompt…" and a `[skill-dispatch]` recall menu on non-trivial
prompts. All 8 hooks were verified end-to-end (valid wiring; recall menu fires;
gate denies `--no-verify`; verify-before-done blocks once/session).

- **To turn OFF:** remove the agentic hook entries from `settings.json` (the
  `*/agentic/*` commands). [`settings.agentic.json`](settings.agentic.json) holds
  the full template to re-apply.

**Risk note.** All hooks are additive + fail-open (no-op on bad input) except the
`Stop` self-review, which can pause a turn **once per session** (double
loop-guarded — it cannot trap a turn). Start with it on; if the verify-before-done
nudge is unwanted, drop that one `Stop` hook.

## 4. How to sync to another project

This `.claude/hooks/agentic/`, `.claude/rules-topical/`, the portable
`.claude/rules/*` (agentic-discipline / cynical-charter / learned-preferences /
git-ip), `.claude/memory/preferences/`, `.claude/scripts/agentic/`, and the
root `AGENTS.md`/`CURSOR.md`/`GEMINI.md` + `.cursor`/`.gemini` are the **portable
core**. To adopt in a new repo:

1. Copy those paths in.
2. Point `AGENTS.md §1` at that project (name + its `CLAUDE.md`).
3. Fill `file-skill-map.json` for that repo's paths (optional).
4. Merge the `settings.agentic.json` wiring.
5. The engine immediately dispatches *that* project's skills — no code changes.

**To make dispatch sharp in any project:** add `metadata.promptSignals` (phrases +
anyOf/noneOf gates) to each skill's `SKILL.md`. The engine works on name +
description alone, but `promptSignals` is what turns a wide menu into precise
matches. See [`rules-topical/skill-dispatch.md`](rules-topical/skill-dispatch.md).

## 5. Relationship to this repo's existing harness

This sits *alongside* the existing Lumina harness (the
[`repo-wiki`](repo-wiki/index.md), the Lumina-specific rules, the finance skills,
the licensing hooks) — nothing was replaced. The Lumina pieces are
project-specific; this layer is the portable brain that travels. When synced
elsewhere, the Lumina-specific files stay behind; the portable core goes.
