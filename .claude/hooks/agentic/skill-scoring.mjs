#!/usr/bin/env node
// Portable Agentic Harness — Skill-Scoring Core (pure, importable, testable).
//
// PROJECT-AGNOSTIC. This module has ZERO project-specific knowledge: it scans
// whatever skills a host project ships under <project>/.claude/skills/, parses
// each SKILL.md frontmatter, and scores a natural-language prompt against them.
// Drop this folder into any repo and it adapts to that repo's skills.
//
// Extracted from the IO hook (prompt-intelligence.mjs) so the scoring logic has
// ONE home and can be exercised by a prompt battery (skill-match-test.mjs)
// without spinning up the stdin hook. The hook owns IO (stdin, session,
// sentinel/Phase-2, output); this module owns frontmatter parsing + skill/memory
// scoring. No side effects on import.
//
// Skill authors opt into precise matching by adding optional frontmatter:
//   metadata:
//     priority: 60                 # tiebreaker among equal scores (default 50)
//     pathPatterns: ["backend/finance/**", "**/*.tool.ts"]
//     promptSignals:
//       minScore: 8                # bar this skill must clear to be a confident match
//       phrases: ["watchlist", "market data", "commercialOk"]
//       anyOf:  ["finance", "stock", "crypto"]   # disqualify unless ≥1 present
//       allOf:  ["migration", "prisma"]          # disqualify unless ALL present
//       noneOf: ["mobile", "react native"]       # disqualify if ANY present
// A skill with only `name` + `description` still matches (weaker, description-only).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

// ═══ SCORING CONFIG ══════════════════════════════════════════════════════════
export const DEFAULT_MIN_SCORE = 6
export const MEMORY_MATCH_THRESHOLD = 3
export const WARM_SKILL_BOOST = 1.5      // recently-injected skills get a small boost
export const FILE_CONTEXT_BOOST = 3      // skill path pattern matches uncommitted file → +3
export const VERB_INTENT_BOOST = 2       // skill matches the prompt's intent class → +2
export const NEGATIVE_SUPPRESSION = 5    // negative phrase match → -5

// ═══ VERB-INTENT EXTRACTOR ═══════════════════════════════════════════════════
export const INTENT_VERBS = {
  BUILD: ['build', 'create', 'add', 'implement', 'scaffold', 'write', 'make', 'generate', 'ship', 'spawn'],
  DEBUG: ['fix', 'debug', 'broken', 'error', 'bug', 'crash', 'black', 'blank', 'why', 'not working', 'fails'],
  REVIEW: ['review', 'audit', 'check', 'verify', 'trace', 'inspect', 'analyze', 'evaluate'],
  PLAN: ['plan', 'design', 'architect', 'research', 'propose', 'think', 'brainstorm', 'explore'],
  REFACTOR: ['refactor', 'clean', 'simplify', 'reorganize', 'restructure', 'optimize', 'consolidate'],
  TEST: ['test', 'tdd', 'coverage', 'e2e', 'playwright', 'jest', 'vitest'],
  DEPLOY: ['deploy', 'publish', 'release', 'ship', 'push', 'merge', 'pr'],
}

// Skill → intent-class affinity (OPTIONAL boost). Keys are skill names; if a
// project doesn't ship a named skill the entry is simply inert. This is a
// corroborator only — it never solo-clears the bar (gated on a strong signal
// below). Domain-neutral defaults; a project can extend this map for its own
// specialist skills, or ignore it entirely (matching degrades gracefully).
export const SKILL_INTENT_AFFINITY = {
  'testing-verification': ['TEST', 'REVIEW', 'DEBUG'],
  'code-reviewer': ['REVIEW'],
  'security-reviewer': ['REVIEW'],
  'security-architecture': ['REVIEW', 'BUILD'],
  'architect': ['PLAN', 'BUILD'],
  'agent-architect': ['PLAN', 'BUILD'],
  'planner': ['PLAN'],
  'workflow-planning': ['PLAN'],
  'product-strategist': ['PLAN'],
  'refactor-cleaner': ['REFACTOR'],
  'refactoring-specialist': ['REFACTOR'],
  'simplify': ['REFACTOR'],
  'deployment-engineer': ['DEPLOY'],
  'git-code-review': ['REVIEW', 'DEPLOY'],
  'debugger': ['DEBUG'],
  'error-detective': ['DEBUG'],
  'production-engineering': ['DEBUG', 'DEPLOY'],
}

export function extractIntents(text) {
  const norm = text.toLowerCase()
  const intents = new Set()
  for (const [intent, verbs] of Object.entries(INTENT_VERBS)) {
    if (verbs.some(v => new RegExp(`\\b${v}\\b`, 'i').test(norm))) intents.add(intent)
  }
  return intents
}

// ═══ NEGATIVE PHRASE DETECTOR ════════════════════════════════════════════════
export function extractNegatives(text) {
  const norm = text.toLowerCase()
  const negatives = new Set()
  const patterns = [
    /don't\s+use\s+([\w-]+)/g, /dont\s+use\s+([\w-]+)/g,
    /skip\s+([\w-]+)/g, /without\s+([\w-]+)/g, /avoid\s+([\w-]+)/g,
    /no\s+need\s+(?:for|to)\s+([\w-]+)/g,
  ]
  for (const p of patterns) {
    let m
    while ((m = p.exec(norm)) !== null) negatives.add(m[1])
  }
  return negatives
}

export function fileMatchesPattern(file, pattern) {
  const re = new RegExp(pattern.replace(/\*\*/g, '.+').replace(/\*/g, '[^/]*'))
  return re.test(file)
}

// ═══ YAML FRONTMATTER PARSER (zero deps) ═════════════════════════════════════
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const yaml = match[1]
  const result = {}
  const stack = []
  let inArray = false, arrayPath = null, arrayItems = []
  // Block-scalar state: `key: >` (folded) / `key: |` (literal) followed by
  // deeper-indented lines. Without this, multi-line YAML descriptions parsed to
  // the literal ">" (length 1) and description matching was dead for them.
  let inBlock = false, blockPath = null, blockIndent = 0, blockLines = []

  function currentPath(key) {
    const parts = stack.map(s => s.key)
    parts.push(key)
    return parts.join('.')
  }
  function flushBlock() {
    if (!inBlock) return
    setNested(result, blockPath, blockLines.join(' ').replace(/\s+/g, ' ').trim())
    inBlock = false; blockPath = null; blockLines = []
  }

  for (const rawLine of yaml.split('\n')) {
    const trimLine = rawLine.trimEnd()

    // Block-scalar continuation: consume blank lines + lines indented deeper
    // than the owning key. First line at ≤ blockIndent ends the block.
    if (inBlock) {
      const lineIndent = rawLine.search(/\S/)
      if (trimLine === '') { blockLines.push(''); continue }
      if (lineIndent > blockIndent) { blockLines.push(trimLine.trim()); continue }
      flushBlock()
    }

    if (!trimLine) continue
    // Skip whole-line comments — they must NOT flush an in-progress sequence
    // (a `#` line between `phrases:` and its items used to silently empty the
    // array). Value lines like `key: '#fff'` start with the key, not '#'.
    if (trimLine.trimStart().startsWith('#')) continue

    const arrayMatch = trimLine.match(/^(\s*)-\s+(.*)$/)
    if (arrayMatch) {
      const val = arrayMatch[2].replace(/^['"]|['"]$/g, '').replace(/['"]$/g, '')
      if (inArray) arrayItems.push(val)
      continue
    }

    if (inArray) {
      setNested(result, arrayPath, arrayItems)
      inArray = false; arrayPath = null; arrayItems = []
    }

    const kvMatch = trimLine.match(/^(\s*)([\w][\w.-]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      const indent = kvMatch[1].length
      const key = kvMatch[2]
      const val = kvMatch[3].trim()

      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()

      const fullPath = currentPath(key)

      // Folded (>) / literal (|) block scalar, optionally chomped (>- |+ >2 …).
      if (/^[>|][+-]?\d*$/.test(val)) {
        inBlock = true; blockPath = fullPath; blockIndent = indent; blockLines = []
        continue
      }

      if (val === '' || val === '[]') {
        stack.push({ indent, key })
        if (val === '[]') setNested(result, fullPath, [])
        else { inArray = true; arrayPath = fullPath; arrayItems = [] }
        continue
      }

      const cleanVal = val.replace(/^['"]|['"]$/g, '').replace(/['"]$/g, '')
      setNested(result, fullPath, cleanVal)
    }
  }

  if (inArray && arrayItems.length > 0) setNested(result, arrayPath, arrayItems)
  flushBlock()
  return result
}

export function setNested(obj, path, value) {
  if (!path) return
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {}
    current = current[parts[i]]
  }
  current[parts[parts.length - 1]] = value
}

export function getNested(obj, path) {
  if (!path) return undefined
  return path.split('.').reduce((o, k) => o && o[k], obj)
}

// ═══ SKILL SCANNER ═══════════════════════════════════════════════════════════
function asArray(v) {
  if (Array.isArray(v)) return v
  if (v === undefined || v === null || v === '') return []
  return [v]
}

export function scanSkills(skillsDir) {
  const skills = []
  if (!existsSync(skillsDir)) return skills

  for (const dir of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const skillMd = join(skillsDir, dir.name, 'SKILL.md')
    if (!existsSync(skillMd)) continue

    try {
      const content = readFileSync(skillMd, 'utf-8')
      const fm = parseFrontmatter(content)
      const name = fm.name || dir.name
      const description = fm.description || ''
      const phrases = asArray(getNested(fm, 'metadata.promptSignals.phrases'))
      const minScore = Number(getNested(fm, 'metadata.promptSignals.minScore')) || DEFAULT_MIN_SCORE
      const pathPatterns = asArray(getNested(fm, 'metadata.pathPatterns'))
      const priority = Number(getNested(fm, 'metadata.priority')) || 50
      // Context gates (precision). Declared in promptSignals, previously unread.
      //   anyOf  — skill is disqualified unless ≥1 of these appears in the prompt
      //   allOf  — skill is disqualified unless ALL appear
      //   noneOf — skill is disqualified if ANY appears
      const anyOf = asArray(getNested(fm, 'metadata.promptSignals.anyOf'))
      const allOf = asArray(getNested(fm, 'metadata.promptSignals.allOf'))
      const noneOf = asArray(getNested(fm, 'metadata.promptSignals.noneOf'))

      skills.push({ name, description, phrases, minScore, pathPatterns, priority, anyOf, allOf, noneOf, dir: dir.name })
    } catch { /* skip */ }
  }
  return skills
}

// ═══ MEMORY SCANNER ══════════════════════════════════════════════════════════
// Reads project-local memory: flat `.md` files plus one level of subdirectories
// (so a project can keep portable preferences under memory/preferences/ separate
// from project-specific facts at the top level). MEMORY.md indexes are skipped.
export function scanMemories(memoryDir) {
  const memories = []
  if (!existsSync(memoryDir)) return memories

  const visit = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.isDirectory()) { visit(join(dir, ent.name)); continue }
      if (!ent.name.endsWith('.md') || ent.name === 'MEMORY.md') continue
      const filePath = join(dir, ent.name)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const fm = parseFrontmatter(content)
        const name = fm.name || ent.name.replace('.md', '')
        const description = fm.description || ''
        const type = (getNested(fm, 'metadata.type') || fm.type || 'unknown')
        const bodyMatch = content.match(/^---[\s\S]*?---\s*\n([\s\S]*)/)
        const body = bodyMatch ? bodyMatch[1] : ''
        const mtime = statSync(filePath).mtimeMs
        memories.push({ name, description, type, file: ent.name, body, mtime })
      } catch { /* skip */ }
    }
  }
  visit(memoryDir)
  return memories
}

// ═══ SCORING ═════════════════════════════════════════════════════════════════
export function normalizeText(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// Inflection-tolerant single-word presence. A declared phrase 'republish' must
// match "republishing"; 'deploy' must match "deploying". We match the exact
// word, a simple plural, or a known morphological suffix on a shared stem — a
// CONTROLLED suffix set (not arbitrary prefix matching) so 'shader' never
// matches "shadow". Short words (<5) only match exact + plural, since prefix
// drift on 3-4 letter words is mostly noise.
const STEM_SUFFIXES = ['s', 'es', 'ing', 'ed', 'd', 'ion', 'tion', 'ation', 'ment', 'ments', 'ings']
function sameStem(token, w) {
  if (token === w) return true
  const [s, l] = token.length <= w.length ? [token, w] : [w, token]
  if (s.length < 5 || !l.startsWith(s)) return false
  return STEM_SUFFIXES.includes(l.slice(s.length))
}
function singleWordInPrompt(normalizedPrompt, w) {
  if (new RegExp(`\\b${escapeRe(w)}\\b`).test(normalizedPrompt)) return true
  if (new RegExp(`\\b${escapeRe(w)}e?s\\b`).test(normalizedPrompt)) return true  // plural, any length
  if (w.length < 5) return false
  for (const t of normalizedPrompt.split(' ')) if (sameStem(t, w)) return true
  return false
}

// Is a declared phrase present in the prompt?
//   multi-word → substring (the internal space already anchors it)
//   single-word → inflection-tolerant whole-word (so 'review' does not fire
//     inside "preview", but 'republish' does match "republishing")
function phrasePresent(normalizedPrompt, normalizedPhrase) {
  if (!normalizedPhrase) return false
  return normalizedPhrase.includes(' ')
    ? normalizedPrompt.includes(normalizedPhrase)
    : singleWordInPrompt(normalizedPrompt, normalizedPhrase)
}

// All content words (len>2) of a multi-word phrase present (inflection-tolerant),
// in ANY order. Catches reordering + inserted words: "canvas goes black" matches
// the declared phrase "black canvas". 2+ content words required so it stays a
// real signal, not a single-common-word fire.
function allContentWordsPresent(normalizedPrompt, normalizedPhrase) {
  const cw = normalizedPhrase.split(' ').filter(w => w.length > 2)
  if (cw.length < 2) return false
  return cw.every(w => singleWordInPrompt(normalizedPrompt, w))
}

// Hard context gates (precision). Evaluated independently of score.
//   noneOf present → disqualify; anyOf declared but absent → disqualify;
//   allOf declared but incomplete → disqualify.
export function evaluateGates(skill, normalizedPrompt) {
  for (const p of (skill.noneOf || [])) {
    if (phrasePresent(normalizedPrompt, normalizeText(p))) {
      return { disqualified: true, reason: `noneOf:${p}` }
    }
  }
  const anyOf = skill.anyOf || []
  if (anyOf.length > 0 && !anyOf.some(p => phrasePresent(normalizedPrompt, normalizeText(p)))) {
    return { disqualified: true, reason: 'anyOf:none' }
  }
  const allOf = skill.allOf || []
  if (allOf.length > 0 && !allOf.every(p => phrasePresent(normalizedPrompt, normalizeText(p)))) {
    return { disqualified: true, reason: 'allOf:incomplete' }
  }
  return { disqualified: false, reason: '' }
}

export function scoreSkill(skill, ctx) {
  const { normalizedPrompt, intents, negatives, recentFiles, warmSkills } = ctx
  let score = 0
  const reasons = []
  // A "strong" signal is a declared phrase hit or a path match — the skill
  // author's own contract. Weak signals (description overlap, intent verbs,
  // warm carry-over) can corroborate and rank, but may NOT solo-clear the bar.
  let strong = false

  // 1. Phrase matching (the authoritative signal)
  for (const phrase of skill.phrases) {
    const np = normalizeText(phrase)
    if (!np) continue
    if (phrasePresent(normalizedPrompt, np)) {
      // A single declared word scales with its length so one DISTINCTIVE keyword
      // ('zustand', 'marketplace', 'docker') clears a minScore-6 bar on its own —
      // that is the author saying "this word IS my domain". Generic single words
      // are contained by minScore and anyOf/noneOf gates, not by starving the
      // phrase score. Multi-word phrases keep the length/2 price (already strong
      // by virtue of being specific).
      score += np.includes(' ')
        ? Math.max(Math.ceil(np.length / 2), 4)
        : Math.max(np.length, 4)
      reasons.push(`"${phrase}"`)
      strong = true
      continue
    }
    // Tolerant: all content words present in any order (reorder/insertion).
    if (allContentWordsPresent(normalizedPrompt, np)) {
      score += Math.max(Math.ceil(np.length / 2) - 1, 3)
      reasons.push(`~"${phrase}"`)
      strong = true
      continue
    }
    // Weak partial: ≥60% of content words (substring) — corroborator only.
    const phraseWords = np.split(' ')
    const matchedWords = phraseWords.filter(w => w.length > 2 && normalizedPrompt.includes(w))
    if (phraseWords.length > 1 && matchedWords.length >= Math.ceil(phraseWords.length * 0.6)) {
      score += 1
      reasons.push(`≈${phrase}`)
    }
  }

  // 2. Description keyword match — corroborator, capped at +2, never strong.
  const descWords = normalizeText(skill.description).split(' ').filter(w => w.length > 4)
  const promptWords = new Set(normalizedPrompt.split(' '))
  let descHits = 0
  for (const dw of descWords) if (promptWords.has(dw)) descHits++
  if (descHits >= 3) {
    score += Math.min(descHits - 2, 2)
    reasons.push(`desc:${descHits}`)
  }

  // 3. Intent-class affinity — GATED on a strong signal. Intent sharpens a
  //    real match; it must not manufacture a pass on description overlap alone.
  const affinities = SKILL_INTENT_AFFINITY[skill.name] || []
  const intentHits = affinities.filter(a => intents.has(a))
  if (intentHits.length > 0 && strong) {
    score += VERB_INTENT_BOOST * intentHits.length
    reasons.push(`intent:${intentHits.join('+')}`)
  }

  // 4. File-context boost (pathPatterns vs recently edited files) — strong.
  if (skill.pathPatterns.length > 0 && recentFiles.length > 0) {
    const matched = recentFiles.filter(f =>
      skill.pathPatterns.some(p => fileMatchesPattern(f, p))
    )
    if (matched.length > 0) {
      score += FILE_CONTEXT_BOOST
      reasons.push(`file:${basename(matched[0])}`)
      strong = true
    }
  }

  // 5. Warm-skill boost (last-injected skill carries small weight) — corroborator.
  if (warmSkills.has(skill.name)) {
    score += WARM_SKILL_BOOST
    reasons.push('warm')
  }

  // 6. Negative-phrase suppression
  const skillTokens = [skill.name, ...skill.name.split('-'), ...skill.dir.split('-')]
  for (const neg of negatives) {
    if (skillTokens.some(t => t.toLowerCase().includes(neg) || neg.includes(t.toLowerCase()))) {
      score -= NEGATIVE_SUPPRESSION
      reasons.push(`suppressed:${neg}`)
      break
    }
  }

  return { score, reasons, minScore: skill.minScore, strong }
}

export function scoreMemory(memory, normalizedPrompt, now) {
  let score = 0
  const matched = []

  const descWords = normalizeText(memory.description).split(' ').filter(w => w.length > 3)
  for (const word of descWords) {
    if (normalizedPrompt.includes(word)) { score++; matched.push(word) }
  }

  const bodyExcerpt = normalizeText((memory.body || '').slice(0, 1500))
  const bodyWords = bodyExcerpt.split(' ').filter(w => w.length > 4)
  const promptWords = new Set(normalizedPrompt.split(' ').filter(w => w.length > 4))
  let bodyHits = 0
  for (const bw of bodyWords) if (promptWords.has(bw)) bodyHits++
  if (bodyHits >= 3) score += Math.min(bodyHits / 3, 3)

  if (memory.type === 'feedback') score += 1
  if (memory.type === 'project') score += 0.5

  const ageDays = (now - memory.mtime) / (1000 * 60 * 60 * 24)
  if (ageDays < 7) score += 1 - (ageDays / 7)

  return { score, matched }
}

// ═══ ORCHESTRATION (used by both hook and test harness) ══════════════════════
// Pure given a scoring context — no IO beyond the dir scans passed in.
export function rankSkills(skills, ctx, maxInjected) {
  return skills
    .map(skill => {
      const gate = evaluateGates(skill, ctx.normalizedPrompt)
      const { score, reasons, minScore, strong } = scoreSkill(skill, ctx)
      if (gate.disqualified) reasons.push(gate.reason)
      const gateClear = !gate.disqualified
      return {
        ...skill, score, reasons, strong, gateClear,
        wasSeen: ctx.seenSkills ? ctx.seenSkills.has(skill.name) : false,
        passed: gateClear && score >= minScore,
      }
    })
    // Menu recall: surface a candidate if it clears the context gates AND either
    // reaches its own minScore (a confident match) OR carries a strong signal — a
    // declared-phrase or path hit, i.e. the skill author's own keyword fired.
    // Strong-but-below-minScore skills earn a menu slot because the AGENT makes
    // the final 2-3 pick: recall here, precision at the model. noneOf/anyOf gates
    // still hard-disqualify, so this widens the net without dropping the floor.
    .filter(s => s.gateClear && (s.passed || s.strong))
    .sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? -1 : 1   // confident matches first
      if (a.wasSeen !== b.wasSeen) return a.wasSeen ? 1 : -1
      if (b.score !== a.score) return b.score - a.score
      return b.priority - a.priority
    })
    .slice(0, maxInjected)
}
