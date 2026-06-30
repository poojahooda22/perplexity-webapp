#!/usr/bin/env node
// Agentic Stop Check — Stop hook, fires when the assistant tries to end a turn.
//
// PROJECT-AGNOSTIC. Encodes verify-before-done as a senior self-review gate: if
// this session did substantive work (any edit or commit, flagged by the
// PostToolUse result check) and the model is about to stop, ask it once to
// review its output against the senior bar — claims map to evidence, the goal is
// genuinely met, the diff is honest.
//
// Two independent loop-guards make a trapped turn impossible:
//   1. stop_hook_active — if the host reports we are already inside a
//      stop-hook-triggered continuation, never block again.
//   2. stopReminded ledger flag — the block fires at most once per session;
//      after it fires, the flag is set and it never blocks again.
// If neither the trigger nor the guards apply, the turn stops normally.
//
// Output contract (verified): top-level decision "block" + reason forces the
// turn to continue; {} allows the stop.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

const allow = () => { process.stdout.write('{}'); process.exit(0) }

let input = {}
try { input = JSON.parse(stdin.trim() || '{}') } catch { allow() }

// Guard 1: already continuing from a prior Stop block — never re-block.
if (input.stop_hook_active === true) allow()

const sessionId = input.session_id || 'default'
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
const ledgerPath = join(
  resolve(projectDir, '.claude/.cache/agentic-sessions'),
  `${sessionId}.brain.json`,
)

let ledger = { workTouched: false, stopReminded: false }
try { ledger = { ...ledger, ...JSON.parse(readFileSync(ledgerPath, 'utf8')) } } catch { /* no ledger yet → allow */ }

// Guard 2: fire at most once per session, and only after substantive work happened.
if (!ledger.workTouched || ledger.stopReminded) allow()

// Trigger met: real work happened this session and we have not reminded yet.
try { writeFileSync(ledgerPath, JSON.stringify({ ...ledger, stopReminded: true })) } catch { /* if we cannot persist, do not block (avoid any chance of a repeat) */ allow() }

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason: 'One senior self-review pass before you finish. Does every claim you are about to make map to evidence from this session you can point to, not memory? Is the actual goal met, or did you just run out of obvious moves? Does the diff do what you said it does, with nothing claimed that it lacks? If you have already done this review, say so in one line and stop.',
  }),
)
