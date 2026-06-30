#!/usr/bin/env node
// Agentic Bootstrap — SessionStart hook, fires once when a session begins.
//
// PROJECT-AGNOSTIC. Establishes the operating brain from token zero and resets
// the per-session ledger the Stop check reads. The structured-checkpoint
// discipline is seeded here because the compaction event cannot reshape the
// model's summary — so the guidance for how to summarize a long session is
// planted up front instead.
//
// Output contract (verified): hookSpecificOutput.additionalContext.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

let input = {}
try { input = JSON.parse(stdin.trim() || '{}') } catch { /* tolerate */ }

const sessionId = input.session_id || 'default'
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

// Reset the per-session ledger so a fresh session starts with no carried flags.
// Project-local (.claude/.cache/, gitignored) so state travels with the repo.
const ledgerDir = resolve(projectDir, '.claude/.cache/agentic-sessions')
try {
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(ledgerDir, `${sessionId}.brain.json`), JSON.stringify({ workTouched: false, stopReminded: false }))
} catch { /* ledger is best-effort; never block session start */ }

const context = [
  '[agentic-bootstrap] Operating brain for this session.',
  'Run non-trivial work as an iterative loop: gather the context an action needs before taking it, act through a tool, verify the result, and continue or stop only when the goal is genuinely met. Answer the question before editing or running anything, and state agree or disagree explicitly before describing changes. Surface a tool failure as a real failure, never as a plausible-looking success.',
  'Keep context lean: hold summaries in working memory and load a thing in full only when the task reaches for it; pull a large reference in slices rather than dumping it whole.',
  'If this session grows long and you summarize it, use a structured checkpoint rather than free prose: Goal, Constraints, Progress (done / in progress / blocked), Key Decisions, Next Steps, Critical Context, and preserve exact file paths, names, and error messages verbatim.',
].join(' ')

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }))
