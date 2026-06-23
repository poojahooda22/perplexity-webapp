# Hooks

Event-driven automation wired in [`../settings.json`](../settings.json). Hooks **load at session
start** — edit a hook, then **restart Claude Code** to pick it up (`/hooks` lists what's loaded).

## What's wired

| Event | Script / logic | Purpose |
|---|---|---|
| **SessionStart** | [`session-start.sh`](session-start.sh) | Surfaces the team-memory index, the rules index, and the repo-wiki pointer so every session opens with the harness loaded. |
| **PreToolUse** (`Write\|Edit`) | [`precheck-licensing.mjs`](precheck-licensing.mjs) | Licensing guard: nudges when an edit introduces `commercialOk:true` (verify the [sources-ledger](../memory/sources-ledger.md)); asks before writing a real `.env`. Non-blocking otherwise. |
| **Stop** | inline (in `settings.json`) | Repo-wiki freshness: warns if code changed but `repo-wiki/` wasn't updated (suggests `/wiki-ingest`). |

## Conventions

- Hooks run in **Git Bash** (`"shell": "bash"`) on Windows. Use POSIX/bash syntax + forward slashes.
- `$CLAUDE_PROJECT_DIR` = repo root, available in command hooks. Scripts also fall back to `.`.
- The licensing guard is **Node** (this is a Bun/Node repo — `node` is on PATH) for robust JSON parsing
  of the hook stdin payload; it degrades to a silent allow on any parse error (never blocks spuriously).
- Keep hooks fast and independent (they may run in parallel) and never log secrets.

## Testing a hook manually

```bash
# SessionStart output:
bash .claude/hooks/session-start.sh

# Licensing guard — should nudge:
echo '{"tool_name":"Edit","tool_input":{"file_path":"x.ts","new_string":"commercialOk: true"}}' \
  | node .claude/hooks/precheck-licensing.mjs

# Licensing guard — should be silent (exit 0, no output):
echo '{"tool_name":"Edit","tool_input":{"file_path":"x.ts","new_string":"const a = 1"}}' \
  | node .claude/hooks/precheck-licensing.mjs
```