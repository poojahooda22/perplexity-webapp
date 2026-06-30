#!/usr/bin/env node
// Agentic Tool Gate — PreToolUse hook, fires before every tool call.
//
// PROJECT-AGNOSTIC. Realizes before-tool gating discipline: deny an
// unambiguously irreversible operation with an actionable reason, escalate a
// destructive-but-sometimes-legitimate operation to a confirmation, or inject
// targeted guidance. The reason becomes a signal the model reads and corrects
// against, not a stack trace. All rules here are generic (git/working-tree
// safety); project-specific path guidance belongs in file-dispatch.mjs +
// file-skill-map.json, not here.
//
// Fail-open by design: any parse error or unexpected shape allows the call, so a
// defect in this hook can never brick the toolchain.
//
// Output contract (verified): hookSpecificOutput.permissionDecision of
// "deny" | "ask" with permissionDecisionReason, or additionalContext to advise
// while allowing, or {} to defer to the normal flow.

// ── Knob: block commit-message authorship/attribution trailers ───────────────
// OFF by default. Standard Claude Code conventions ADD a `Co-Authored-By:` and a
// `🤖 Generated with Claude Code` trailer, so blocking them is opt-in. Flip to
// true if your project's policy is zero process/attribution language in commits.
const BLOCK_COMMIT_ATTRIBUTION = false

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

const trimmed = stdin.trim()
if (!trimmed) { process.stdout.write('{}'); process.exit(0) }

let input
try { input = JSON.parse(trimmed) } catch { process.stdout.write('{}'); process.exit(0) }

function emit(payload) { process.stdout.write(JSON.stringify(payload)); process.exit(0) }
function decide(decision, reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } })
}
const pass = () => emit({})

try {
  const tool = input.tool_name || ''
  const ti = input.tool_input || {}
  const cmd = String(ti.command || '')

  // DENY — never-correct operations (every project).
  if (tool === 'Bash' && cmd) {
    if (/\bgit\s+commit\b[^\n]*--no-verify\b/.test(cmd)) {
      decide('deny', 'git commit --no-verify skips the hooks and checks that exist to catch problems. Fix the failing check instead of bypassing it.')
    }
    if (/\bgit\s+add\s+(-f|--force)\b/.test(cmd) && /\.(agents|claude|cursor|gemini)\b/.test(cmd)) {
      decide('deny', 'Force-adding into an agent-workspace folder (.agents / .claude / .cursor / .gemini) leaks internal tooling into git history. Keep these out of commits unless intentionally versioned.')
    }
    if (BLOCK_COMMIT_ATTRIBUTION && /\bgit\s+commit\b/.test(cmd) && /(Co-Authored-By|Generated with|Claude Code|🤖)/i.test(cmd)) {
      decide('deny', 'Commit message carries authorship or tool-attribution language and the project policy disallows it. Describe the change itself; no co-author or generated-by trailers.')
    }
  }

  // ASK — destructive but occasionally legitimate; escalate to a confirmation.
  if (tool === 'Bash' && cmd) {
    if (/\bgit\s+reset\s+--hard\b/.test(cmd) ||
        /\bgit\s+checkout\s+(--\s|\.\s*$|\.$)/.test(cmd) ||
        /\bgit\s+clean\s+-[a-z]*\bf/.test(cmd) ||
        /\bgit\s+stash\b/.test(cmd)) {
      decide('ask', 'Destructive on the working tree (reset --hard / checkout . / clean -f / stash) can discard uncommitted work. Confirm this is intended.')
    }
    if (/\bgit\s+push\b[^\n]*(--force|-f)\b/.test(cmd)) {
      decide('ask', 'Force-push rewrites remote history. Confirm the target branch and that no shared work is overwritten.')
    }
  }

  pass()
} catch {
  pass()
}
