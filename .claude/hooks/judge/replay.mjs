#!/usr/bin/env node
/**
 * Judge replay tool — surfaces past output-quality-judge verdicts.
 *
 * Reads .claude/cache/judge-log.jsonl (appended by output-quality.mjs after every
 * Claude turn). Computes calibration drift, audit-category breakdowns, and
 * surfaces specific verdicts on demand.
 *
 * Usage:
 *   node .claude/hooks/judge/replay.mjs                  # last 10 verdicts
 *   node .claude/hooks/judge/replay.mjs tail 50          # last N
 *   node .claude/hooks/judge/replay.mjs fails 100        # only revise verdicts
 *   node .claude/hooks/judge/replay.mjs stats 200        # aggregate metrics
 *   node .claude/hooks/judge/replay.mjs session <id>     # one session
 *   node .claude/hooks/judge/replay.mjs categories 200   # audit-category breakdown
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

const LOG_PATH = pathResolve(import.meta.dirname, '../../cache/judge-log.jsonl')

if (!existsSync(LOG_PATH)) {
  console.log(`No judge log yet at ${LOG_PATH}. Run a Claude turn first.`)
  process.exit(0)
}

const allEntries = readFileSync(LOG_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)

const [cmd = 'tail', arg = '10'] = process.argv.slice(2)

function showEntry(e, i) {
  const tag = e.finalVerdict === 'revise' ? 'REVISE' : e.finalVerdict === 'skip' ? 'SKIP  ' : 'PASS  '
  const score = e.finalScore == null ? '   ' : String(e.finalScore).padStart(3)
  const len = String(e.responseLen).padStart(5)
  const ts = e.ts.replace('T', ' ').slice(0, 19)
  console.log(`${tag} score=${score} len=${len} ${ts} session=${e.session.slice(0, 8)} ${e.skip ? `[skip:${e.skip}]` : ''}`)
  if (e.finalVerdict === 'revise') {
    for (const f of (e.detFails || [])) {
      console.log(`        [det:${f.audit}] ${f.why}`)
    }
    if (e.llmVerdict?.summary) {
      console.log(`        [llm] ${e.llmVerdict.summary}`)
    }
    if (e.llmVerdict?.hint) {
      console.log(`        [hint] ${e.llmVerdict.hint}`)
    }
  }
}

function tail(n) {
  const slice = allEntries.slice(-n)
  console.log(`\nLast ${slice.length} verdicts:\n`)
  slice.forEach(showEntry)
}

function fails(n) {
  const slice = allEntries.slice(-n).filter(e => e.finalVerdict === 'revise')
  console.log(`\n${slice.length} revise verdicts in last ${n}:\n`)
  slice.forEach(showEntry)
}

function stats(n) {
  const slice = allEntries.slice(-n)
  const total = slice.length
  if (total === 0) {
    console.log('No entries.')
    return
  }
  const pass = slice.filter(e => e.finalVerdict === 'pass').length
  const revise = slice.filter(e => e.finalVerdict === 'revise').length
  const skip = slice.filter(e => e.finalVerdict === 'skip').length
  const halluc = slice.filter(e => e.hallucinationDetected).length
  const llmCalls = slice.filter(e => e.llmVerdict !== null).length
  const avgLen = Math.round(slice.reduce((a, e) => a + (e.responseLen || 0), 0) / total)
  const avgScore = (() => {
    const scored = slice.filter(e => typeof e.finalScore === 'number')
    if (scored.length === 0) return null
    return Math.round(scored.reduce((a, e) => a + e.finalScore, 0) / scored.length)
  })()
  console.log(`\nLast ${total} verdicts:`)
  console.log(`  pass:                 ${pass} (${(pass / total * 100).toFixed(1)}%)`)
  console.log(`  revise:               ${revise} (${(revise / total * 100).toFixed(1)}%)`)
  console.log(`  skip:                 ${skip} (${(skip / total * 100).toFixed(1)}%)`)
  console.log(`  hallucinations:       ${halluc}`)
  console.log(`  LLM stage invoked:    ${llmCalls}`)
  console.log(`  avg response length:  ${avgLen} chars`)
  if (avgScore != null) console.log(`  avg score:            ${avgScore}`)
}

function session(id) {
  const slice = allEntries.filter(e => e.session === id || e.session.startsWith(id))
  console.log(`\n${slice.length} verdicts from session ${id}:\n`)
  slice.forEach(showEntry)
}

function categories(n) {
  const slice = allEntries.slice(-n)
  const counts = {}
  for (const e of slice) {
    for (const f of (e.detFails || [])) {
      counts[f.audit] = (counts[f.audit] || 0) + 1
    }
    for (const f of (e.llmVerdict?.fails || [])) {
      counts[`llm:${f.audit}`] = (counts[`llm:${f.audit}`] || 0) + 1
    }
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  console.log(`\nAudit categories in last ${n} verdicts:\n`)
  if (entries.length === 0) {
    console.log('  (no fails)')
    return
  }
  for (const [cat, ct] of entries) {
    console.log(`  ${cat.padEnd(30)} ${ct}`)
  }
}

const n = parseInt(arg, 10) || 10

switch (cmd) {
  case 'tail': tail(n); break
  case 'fails': fails(n); break
  case 'stats': stats(n); break
  case 'session': session(arg); break
  case 'categories': categories(n); break
  default:
    console.log('Usage: replay.mjs [tail|fails|stats|categories] [N]')
    console.log('       replay.mjs session <id>')
    process.exit(1)
}
