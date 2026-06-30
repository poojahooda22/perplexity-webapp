#!/usr/bin/env node
/**
 * Agentic Harness — File-Based Skill Dispatch (PreToolUse: Edit | Write).
 *
 * PROJECT-AGNOSTIC + CONFIG-DRIVEN. When the agent edits a file whose path
 * matches an entry in this project's file-skill-map.json, this hook injects a
 * reminder to invoke the mapped skill(s) AND read the mapped topical rule(s)
 * from .claude/rules-topical/ before proceeding.
 *
 * The mapping is DATA, not code: each host project ships its own
 * .claude/hooks/agentic/file-skill-map.json. There is no hardcoded table and no
 * project gate — drop the folder into any repo and edit the JSON for that repo.
 * If the map is missing or empty, the hook is a no-op.
 *
 * Map schema (file-skill-map.json):
 *   { "map": [ { "pattern": "<JS regex source>", "skills": ["/skill-name"],
 *               "rules": ["topic.md"] }, ... ] }
 *   - pattern : a JavaScript regex SOURCE string, matched case-insensitively
 *               against the forward-slashed file path (e.g. "backend/finance/.*\\.ts$").
 *   - skills  : skill names to invoke (leading slash optional).
 *   - rules   : file names under .claude/rules-topical/ to read first.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load the project-local map (DATA) ───────────────────────────────────────
function loadMap() {
  const mapPath = resolve(__dirname, 'file-skill-map.json')
  if (!existsSync(mapPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(mapPath, 'utf-8'))
    const entries = Array.isArray(parsed) ? parsed : (parsed.map || [])
    return entries
      .map(e => {
        try { return { re: new RegExp(e.pattern, 'i'), skills: e.skills || [], rules: e.rules || [] } }
        catch { return null }
      })
      .filter(Boolean)
  } catch { return [] }
}

// ─── STDIN ────────────────────────────────────────────────────────────────────
let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

const trimmed = stdin.trim()
if (!trimmed) { process.stdout.write('{}'); process.exit(0) }

let input
try { input = JSON.parse(trimmed) } catch { process.stdout.write('{}'); process.exit(0) }

const toolName = input.tool_name || ''
if (!['Edit', 'Write'].includes(toolName)) { process.stdout.write('{}'); process.exit(0) }

const toolInput = input.tool_input || {}
const filePath = toolInput.file_path || ''
if (!filePath) { process.stdout.write('{}'); process.exit(0) }

const FILE_SKILL_MAP = loadMap()
if (FILE_SKILL_MAP.length === 0) { process.stdout.write('{}'); process.exit(0) }

const normalizedPath = filePath.replace(/\\/g, '/')

const matchedSkills = new Set()
const matchedRules = new Set()
for (const rule of FILE_SKILL_MAP) {
  if (rule.re.test(normalizedPath)) {
    for (const skill of rule.skills) matchedSkills.add(skill.startsWith('/') ? skill : `/${skill}`)
    for (const r of rule.rules) matchedRules.add(r)
  }
}

if (matchedSkills.size === 0 && matchedRules.size === 0) { process.stdout.write('{}'); process.exit(0) }

const skillList = [...matchedSkills].join(', ')
const ruleList = [...matchedRules].map(r => `.claude/rules-topical/${r}`).join(', ')
const shortPath = normalizedPath.split('/').slice(-3).join('/')
const skillPart = skillList ? ` skills: ${skillList}` : ''
const rulePart = ruleList ? ` | Read first: ${ruleList}` : ''
const advisory = `[agentic-file-dispatch] "${shortPath}" ->${skillPart}${rulePart}`

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: advisory },
}))