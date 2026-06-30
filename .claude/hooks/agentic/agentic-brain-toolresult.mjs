#!/usr/bin/env node
// Agentic Result Check — PostToolUse hook, fires after a tool runs.
//
// PROJECT-AGNOSTIC. Re-judges what a tool actually produced and injects a
// follow-up directive, because a zero exit code is not the same as a correct
// result. Purely additive: it only injects context next to the tool result, it
// never rewrites output and never blocks. It also flags the per-session ledger
// (workTouched) that the Stop check reads. All reminders here are generic.
//
// Output contract (verified): hookSpecificOutput.additionalContext.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

const trimmed = stdin.trim()
if (!trimmed) { process.stdout.write('{}'); process.exit(0) }

let input
try { input = JSON.parse(trimmed) } catch { process.stdout.write('{}'); process.exit(0) }

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

function inject(context) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[agentic-check] ${context}` } }))
  process.exit(0)
}
const pass = () => { process.stdout.write('{}'); process.exit(0) }

function flag(sessionId, patch) {
  try {
    const dir = resolve(projectDir, '.claude/.cache/agentic-sessions')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, `${sessionId || 'default'}.brain.json`)
    let ledger = { workTouched: false, stopReminded: false }
    try { ledger = { ...ledger, ...JSON.parse(readFileSync(f, 'utf8')) } } catch { /* no prior ledger */ }
    writeFileSync(f, JSON.stringify({ ...ledger, ...patch }))
  } catch { /* best-effort; never affect the result */ }
}

try {
  const tool = input.tool_name || ''
  const ti = input.tool_input || {}
  const path = String(ti.file_path || ti.path || '').replace(/\\/g, '/')
  const cmd = String(ti.command || '')

  if ((tool === 'Edit' || tool === 'Write') && path) {
    flag(input.session_id, { workTouched: true })
  }

  if (tool === 'Bash' && cmd) {
    if (/\btsc\b[^\n]*--noEmit\b/.test(cmd) || /\b(eslint|biome)\b/.test(cmd)) {
      inject('A clean type-check / lint is correctness-of-form, not correctness-of-feature. The behaviour can be wrong with zero type or lint errors. Verify the actual result before reporting this as working.')
    }
    if (/\bgit\s+commit\b/.test(cmd)) {
      flag(input.session_id, { workTouched: true })
      inject('Commit landed. Verify the diff actually matches what you described — no claimed change that the diff lacks — before moving on.')
    }
  }

  pass()
} catch {
  pass()
}
