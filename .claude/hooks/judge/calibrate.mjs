#!/usr/bin/env node
/**
 * Calibration runner for output-quality-judge.
 *
 * Reads test-cases.json, simulates a Stop hook payload for each case,
 * runs the deterministic pre-filter (Stage 1), and reports:
 *   - Per-case verdict vs expected
 *   - Aggregate metrics: accuracy, false-positive rate, false-negative rate,
 *     per-audit-category recall
 *   - Cohen's kappa (chance-corrected agreement) — appropriate for binary verdict
 *     per Eugene Yan's recommendation (eugeneyan.com/writing/llm-evaluators/)
 *
 * To also calibrate the LLM judge (Stage 2), set RARE_JUDGE_LLM=1 and
 * ANTHROPIC_API_KEY in env. Costs ~$0.001 per case with Haiku.
 *
 * Usage:
 *   node .claude/hooks/judge/calibrate.mjs
 *   RARE_JUDGE_LLM=1 ANTHROPIC_API_KEY=sk-... node .claude/hooks/judge/calibrate.mjs
 */

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = pathResolve(import.meta.dirname, '../../..')
const TEST_CASES_PATH = pathResolve(import.meta.dirname, 'test-cases.json')
const HOOK_PATH = pathResolve(import.meta.dirname, 'output-quality.mjs')

if (!existsSync(TEST_CASES_PATH)) {
  console.error(`Test cases not found at ${TEST_CASES_PATH}`)
  process.exit(1)
}
if (!existsSync(HOOK_PATH)) {
  console.error(`Hook script not found at ${HOOK_PATH}`)
  process.exit(1)
}

const { cases: allCases } = JSON.parse(readFileSync(TEST_CASES_PATH, 'utf8'))

// Respect the `requiresLLM` flag — those cases only run when LLM mode is on.
const llmEnabled = process.env.RARE_JUDGE_LLM === '1' && !!process.env.ANTHROPIC_API_KEY
const cases = allCases.filter(tc => !tc.requiresLLM || llmEnabled)
const skippedLLM = allCases.length - cases.length

console.log(`\nCalibrating output-quality-judge against ${cases.length}/${allCases.length} test cases${
  skippedLLM > 0 ? ` (${skippedLLM} skipped: require RARE_JUDGE_LLM=1 + ANTHROPIC_API_KEY)` : ''
}…\n`)

const results = []

for (const tc of cases) {
  // Build a synthetic transcript file so the hook can read user_prompt from it
  const tmpDir = mkdtempSync(join(tmpdir(), 'judge-calibrate-'))
  const transcriptPath = join(tmpDir, 'transcript.jsonl')
  const transcript = [
    { message: { role: 'user', content: [{ type: 'text', text: tc.user_prompt }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: tc.assistant_response }] } },
  ]
  writeFileSync(transcriptPath, transcript.map(t => JSON.stringify(t)).join('\n'))

  // Build the Stop hook input payload per code.claude.com/docs/en/hooks
  const hookInput = JSON.stringify({
    session_id: `calibrate-${tc.id}`,
    transcript_path: transcriptPath,
    cwd: ROOT,
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_reason: 'end_turn',
    output: tc.assistant_response,
    tool_calls: [],
  })

  // Invoke the hook in a clean child process
  const child = spawnSync('node', [HOOK_PATH], {
    input: hookInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Force a deterministic-only run unless caller opted in to LLM
      RARE_JUDGE_BLOCKING: process.env.RARE_JUDGE_BLOCKING || '',
    },
    cwd: ROOT,
    timeout: 30_000,
  })

  rmSync(tmpDir, { recursive: true, force: true })

  let actualVerdict = 'pass'
  let hookJson = null
  if (child.stdout && child.stdout.trim()) {
    try { hookJson = JSON.parse(child.stdout.trim()) } catch { /* not JSON */ }
    if (hookJson?.decision === 'block' || hookJson?.hookSpecificOutput?.additionalContext) {
      actualVerdict = 'revise'
    }
  }

  const expected = tc.expectedVerdict
  const correct = actualVerdict === expected

  results.push({
    id: tc.id,
    expected,
    actual: actualVerdict,
    correct,
    expectedTier: tc.expectedTier,
    expectedSkip: tc.expectedSkip,
    rationale: tc.rationale,
    hookJson,
  })

  const tag = correct ? 'OK ' : 'XX '
  console.log(`${tag} ${tc.id.padEnd(40)} expected=${expected.padEnd(7)} actual=${actualVerdict}`)
  if (!correct) {
    console.log(`     rationale: ${tc.rationale}`)
    if (hookJson) console.log(`     hookJson: ${JSON.stringify(hookJson).slice(0, 200)}`)
  }
}

// ─── Aggregate metrics ──────────────────────────────────────────────────────
const total = results.length
const correct = results.filter(r => r.correct).length
const accuracy = correct / total

// 2x2 confusion matrix on binary verdict (pass vs revise)
let truePass = 0, trueRevise = 0, falsePass = 0, falseRevise = 0
for (const r of results) {
  if (r.expected === 'pass' && r.actual === 'pass') truePass++
  if (r.expected === 'revise' && r.actual === 'revise') trueRevise++
  if (r.expected === 'pass' && r.actual === 'revise') falseRevise++
  if (r.expected === 'revise' && r.actual === 'pass') falsePass++
}

// Cohen's kappa (chance-corrected agreement)
// Per Eugene Yan: appropriate for binary classification
const po = (truePass + trueRevise) / total
const expectedPassRate = (truePass + falseRevise) / total
const expectedReviseRate = (trueRevise + falsePass) / total
const actualPassRate = (truePass + falsePass) / total
const actualReviseRate = (trueRevise + falseRevise) / total
const pe = expectedPassRate * actualPassRate + expectedReviseRate * actualReviseRate
const kappa = pe < 1 ? (po - pe) / (1 - pe) : 1

console.log('\n─── Aggregate Metrics ────────────────────────────────────────')
console.log(`Total cases:        ${total}`)
console.log(`Correct:            ${correct}`)
console.log(`Accuracy:           ${(accuracy * 100).toFixed(1)}%`)
console.log(`True pass:          ${truePass}`)
console.log(`True revise:        ${trueRevise}`)
console.log(`False pass:         ${falsePass}  (judge let through bad responses)`)
console.log(`False revise:       ${falseRevise}  (judge flagged good responses)`)
console.log(`Cohen's kappa:      ${kappa.toFixed(3)}`)
console.log('')
console.log('Kappa interpretation (Landis & Koch 1977):')
console.log('  < 0.00: poor       0.41-0.60: moderate    0.81-1.00: almost perfect')
console.log('  0.00-0.20: slight  0.61-0.80: substantial')
console.log('  0.21-0.40: fair')

if (falsePass > 0) {
  console.log('\n!!  False-pass cases (judge MISSED bad responses):')
  for (const r of results.filter(r => r.expected === 'revise' && r.actual === 'pass')) {
    console.log(`    - ${r.id}: ${r.rationale}`)
  }
}

if (falseRevise > 0) {
  console.log('\n!!  False-revise cases (judge OVER-FLAGGED good responses):')
  for (const r of results.filter(r => r.expected === 'pass' && r.actual === 'revise')) {
    console.log(`    - ${r.id}: ${r.rationale}`)
  }
}

console.log('')

// Exit code reflects calibration state — useful for CI
process.exit(falsePass > 0 ? 1 : 0)
