#!/usr/bin/env node
// Portable Agentic Harness — Prompt Intelligence Engine (scoring core extracted)
// UserPromptSubmit hook — fires on EVERY user prompt.
//
// PROJECT-AGNOSTIC. No project name is hardcoded: it scans the HOST project's
// own .claude/skills/ and .claude/memory/, scores the prompt, and surfaces a
// recall menu of candidate skills + relevant memories so the agent invokes the
// right specialists BEFORE touching code. Drop this folder into any repo and it
// adapts to that repo.
//
// This file owns IO + policy: stdin, session, sentinel / Phase-2 detection,
// directive composition, output. The SCORING (frontmatter parsing, skill +
// memory ranking) lives in ./skill-scoring.mjs so it can be exercised by the
// prompt battery (skill-match-test.mjs) without spinning up the hook.
//
// Behaviour contract:
//   1. The project's CLAUDE.md (root) defines the prompt protocol. Default is
//      DIRECT EXECUTION; the engineered-prompt rewrite is OPT-IN via an
//      end-of-prompt sentinel (\\, >>>, !!engineer, !!plan).
//   2. The hook injects relevant skills + memories so the agent is grounded in
//      project context; it never gates the protocol.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  scanSkills, scanMemories, extractIntents, extractNegatives, normalizeText,
  rankSkills, scoreMemory, MEMORY_MATCH_THRESHOLD,
} from './skill-scoring.mjs'

// ═══ CONFIG ══════════════════════════════════════════════════════════════════
// Recall/precision split: the matcher casts a WIDE candidate menu (recall — what
// skills exist for this rough area); the AGENT invokes the 2-3 most on-target
// from it (precision — which are actually right for the task). Keyword scoring is
// strong at surfacing candidates and weak at the final pick, so the pick moves to
// the model. The skill-invocation rule lives in CLAUDE.md.
const SKILL_MENU_SIZE = 12          // candidate skills surfaced as a menu
const AGENT_SKILL_PICKS = '2-3'     // how many the agent invokes from the menu
const MAX_MEMORIES_INJECTED = 4
const MIN_PROMPT_LENGTH = 12
const LABEL = 'skill-dispatch'      // neutral tag visible in injected context

// ═══ PHASE-2 CONFIRMATION DETECTOR ═══════════════════════════════════════════
// Fires when the operator confirms a previously engineered prompt. On
// confirmation the headline directive shifts from "engineer the prompt" to
// "invoke the listed skills before any tool calls" — otherwise the hook trains
// agents to tune it out at the moment it should be loudest. Cap at 60 chars:
// anything longer is too substantive to be a pure confirmation.
const CONFIRMATION_TOKENS = [
  'go', 'yes', 'yep', 'yeah', 'sure', 'ok', 'okay',
  'proceed', 'approved', 'approve', 'confirm', 'confirmed',
  'do it', 'fix it', 'solve it', 'ship it', 'execute',
  'full power', 'now', 'go ahead', 'lets go', "let's go",
  'lets move', "let's move", 'lets ship', "let's ship",
  'continue', 'run it', 'send it',
]

function isPhase2Confirmation(text) {
  const norm = text.toLowerCase()
    .replace(/[.,!?;:'"`*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (norm.length === 0 || norm.length > 60) return false
  for (const token of CONFIRMATION_TOKENS) {
    if (norm === token) return true
    if (norm.startsWith(token + ' ')) return true
  }
  return false
}

// Engineer-Prompt sentinel — end a prompt with `\\`, `>>>`, `!!engineer`, or
// `!!plan` to INVOKE the engineered-prompt rewrite protocol. Default is DIRECT
// EXECUTION; the sentinel is the opt-in for the heavyweight rewrite.
const ENGINEER_PROMPT_SENTINELS = [/>>>\s*$/, /\\\\\s*$/, /!!\s*engineer\s*$/i, /!!\s*plan\s*$/i]
function isEngineerRequest(text) {
  for (const re of ENGINEER_PROMPT_SENTINELS) {
    if (re.test(text)) return true
  }
  return false
}

// ═══ FILE CONTEXT (uncommitted files) ════════════════════════════════════════
function getRecentlyEditedFiles(cwd) {
  try {
    const out = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 500 })
    return out.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => l.replace(/^[MADRCU?! ]+/, '').trim())
      .filter(Boolean)
  } catch { return [] }
}

// ═══ SESSION TRACKING (warm skills + seen skills) ════════════════════════════
// Project-local so session state travels with the repo and never leaks across
// projects. Lives under .claude/.cache/ (gitignored).
function sessionDirBase(projectDir) {
  return resolve(projectDir, '.claude/.cache/agentic-sessions')
}
function loadSession(projectDir, sessionId) {
  const f = join(sessionDirBase(projectDir), `${sessionId}.json`)
  try {
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}
function saveSession(projectDir, sessionId, data) {
  const f = join(sessionDirBase(projectDir), `${sessionId}.json`)
  try {
    mkdirSync(sessionDirBase(projectDir), { recursive: true })
    writeFileSync(f, JSON.stringify({ ...data, lastUpdated: new Date().toISOString() }, null, 2))
  } catch { /* ignore */ }
}

// ═══ STDIN ═══════════════════════════════════════════════════════════════════
let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

const trimmed = stdin.trim()
if (!trimmed) { process.stdout.write('{}'); process.exit(0) }

let input
try { input = JSON.parse(trimmed) }
catch { process.stdout.write('{}'); process.exit(0) }

const rawPrompt = (input.prompt || input.message || '').trim()
const sessionId = input.session_id || input.conversation_id || process.env.SESSION_ID || 'default'
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const projectDir = (process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd())

// Load session early — Phase-2 confirmation detection depends on whether an
// engineered-prompt rewrite is genuinely PENDING (recorded last turn when the
// sentinel fired), not on the prompt text alone.
const session = loadSession(projectDir, sessionId)

const isConfirmationPhrase = isPhase2Confirmation(rawPrompt)
const isPhase2 = isConfirmationPhrase && session.awaitingConfirmation === true
const isEngineer = !isPhase2 && isEngineerRequest(rawPrompt)
// Strip the sentinel so the trailing token doesn't leak into keyword matches.
const prompt = isEngineer
  ? rawPrompt.replace(/(?:>>>|\\\\|!!\s*engineer|!!\s*plan)\s*$/i, '').trim()
  : rawPrompt
// Confirmations (with a pending rewrite) bypass the length floor.
if (!isPhase2 && prompt.length < MIN_PROMPT_LENGTH) { process.stdout.write('{}'); process.exit(0) }

// ═══ MAIN ════════════════════════════════════════════════════════════════════
const normalizedPrompt = normalizeText(prompt)

// Build scoring context
const intents = extractIntents(prompt)
const negatives = extractNegatives(prompt)
const recentFiles = getRecentlyEditedFiles(cwd)
const warmSkills = new Set(session.lastInjectedSkills || [])
const seenSkills = new Set(session.seenSkills || [])

const scoringCtx = { normalizedPrompt, intents, negatives, recentFiles, warmSkills, seenSkills }

// Scan skills + memories — both project-local, so the engine adapts to whatever
// the host repo ships. No external/global path is read.
const skillsDir = resolve(projectDir.replace(/\\/g, '/'), '.claude/skills')
const skills = scanSkills(skillsDir)
const memoryDir = resolve(projectDir.replace(/\\/g, '/'), '.claude/memory')
const memories = scanMemories(memoryDir)

// Score skills (gating + ranking live in the scoring core).
const skillScores = rankSkills(skills, scoringCtx, SKILL_MENU_SIZE)

// Score memories
const now = Date.now()
const memoryScores = memories
  .map(memory => {
    const { score, matched } = scoreMemory(memory, normalizedPrompt, now)
    return { ...memory, score, matched, passed: score >= MEMORY_MATCH_THRESHOLD }
  })
  .filter(m => m.passed)
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_MEMORIES_INJECTED)

// Build output. Three modes: Phase-2 execute / engineer-sentinel rewrite /
// default direct-execution.
const lines = []
if (isPhase2) {
  lines.push(`[${LABEL}] PHASE 2 EXECUTE detected. REQUIRED before any Read / Edit / Write / Bash this turn: (1) For each skill listed under "Skills to Invoke" in your previous engineered prompt, call the Skill tool ONCE — UNLESS the skill is tagged [seen] below AND its Launching-skill message is still visible in your conversation context, in which case state "Skill /<name> reused from earlier this session" in one sentence and skip the call. Silent skips are still a Phase 2 failure. (2) Read the relevant .claude/rules/ and .claude/rules-topical/ files. (3) Execute the work outlined in the engineered prompt's Approach. Self-audit: for each listed skill, did I either invoke fresh OR explicitly acknowledge reuse?`)
} else if (isEngineer) {
  lines.push(`[${LABEL}] ENGINEER-PROMPT sentinel detected (\\\\, >>>, !!engineer, or !!plan at end of prompt). REWRITE the request before any Read / Edit / Write / Bash this turn: state Intent / Scope / Context / Constraints / Success Criteria / Approach / Skills to Invoke, end with "Awaiting confirmation.", then STOP. Execute only after the operator replies with go / proceed / yes / approved / ship it / etc. Use this protocol when the cost of misunderstanding intent would exceed the cost of the rewrite.`)
} else {
  const skillClause = skillScores.length > 0
    ? `(1) ${skillScores.length} CANDIDATE skill(s) below — a wide recall menu, not a checklist. BEFORE your first Read / Edit / Write / Bash, pick the ${AGENT_SKILL_PICKS} MOST on-target for THIS task and invoke them via the Skill tool, at the START of the turn. You supply the precision: ignore any candidate that is off-target for the actual code path, and invoke a better-fit skill yourself if the menu missed it. Invoking the right specialist skills first is the highest-leverage move of the turn — skipping it when the task touches a specialist surface (data / auth / API / UI / infra / agent / domain logic) is a failure. A candidate tagged [seen] was surfaced earlier this session: if you already invoked it, reuse it from context instead of re-invoking.`
    : `(1) No skills auto-matched this prompt. If the task touches a specialist surface (data / auth / API / UI / infra / agent / domain logic), pick the ${AGENT_SKILL_PICKS} most specific skills yourself and invoke them via the Skill tool at the START, before editing.`
  lines.push(`[${LABEL}] Direct execution mode (default). Safety rails apply: ${skillClause} (2) Read the \`.claude/rules/\` or \`.claude/rules-topical/<topic>.md\` matching the edit path BEFORE editing (path → rule map in CLAUDE.md). (3) Execute the work. (4) Self-audit on completion: which code path you changed, no hallucinated file:line claims, no padding, and a cross-check against the project's operating rules. End the turn in one or two sentences: what changed, what's next. To invoke the engineered-prompt rewrite protocol explicitly, end the next prompt with \`\\\\\` / \`>>>\` / \`!!engineer\` / \`!!plan\`.`)
}
lines.push(`[${LABEL}] context: intent=${[...intents].join(',') || 'generic'}${negatives.size ? ` | neg=${[...negatives].join(',')}` : ''}${recentFiles.length ? ` | ${recentFiles.length} edited` : ''}${isPhase2 ? ' | phase2=true' : ''}`)

if (skillScores.length > 0) {
  for (const s of skillScores) {
    const seenTag = s.wasSeen ? ' [seen]' : ''
    const why = s.reasons.slice(0, 3).join(', ')
    lines.push(`- /${s.name}${seenTag}${why ? ` (${why}, score ${s.score.toFixed(1)})` : ''}`)
  }
}

if (memoryScores.length > 0) {
  for (const m of memoryScores) {
    const typeTag = m.type === 'feedback' ? ' [feedback]' : m.type === 'project' ? ' [project]' : ''
    lines.push(`- memory: ${m.file}${typeTag}`)
  }
}

// Persist session state (warm skills + seen skills)
const primaryNames = skillScores.map(s => s.name)
const allSeen = new Set(session.seenSkills || [])
for (const n of primaryNames) allSeen.add(n)
saveSession(projectDir, sessionId, {
  ...session,
  seenSkills: [...allSeen],
  lastInjectedSkills: primaryNames.slice(0, 5), // top candidates carry a small warm boost next turn
  awaitingConfirmation: isEngineer,
})

const additionalContext = lines.join('\n')
const output = {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext,
  },
}
process.stdout.write(JSON.stringify(output))