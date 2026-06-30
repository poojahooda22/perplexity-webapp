#!/usr/bin/env node
/**
 * consolidate-memory.mjs — File-level operations for the /consolidate-memory skill.
 *
 * The companion SKILL.md handles LLM-driven decisions (merge target selection,
 * importance scoring, summary generation). This script is the deterministic
 * substrate: it reads, writes, archives, and indexes memory files. No LLM
 * calls; no embedding lookups; no external dependencies.
 *
 * The 5-tool API:
 *   store     — create a new memory file + index entry
 *   retrieve  — keyword search over frontmatter + body, returns top-k JSON
 *   update    — patch frontmatter (and optionally body description) on an existing file
 *   summarize — surface duplicate clusters within a category (decision is LLM's; this only detects)
 *   discard   — archive a file with citation-grep guard; predicate variant requires --confirm
 *
 * Plus operational utilities: list, migrate, citation-scan, memory-md-rebuild, audit-report.
 *
 * Hard contracts:
 *   1. Atomic — every operation that touches both a memory file AND MEMORY.md commits both
 *      via temp-file + rename, with rollback on second-rename failure.
 *   2. Archive-not-delete — discard moves files to the archive directory (see ARCHIVE_DIR)
 *      with `tier: deprecated` appended to frontmatter. The on-disk content survives.
 *   3. Citation-grep before discard — non-bypassable.
 *   4. Read-only ops never modify files; retrieve has --readonly to suppress access bumps.
 *   5. Frontmatter is parsed and re-emitted faithfully — file body is never touched
 *      by metadata operations.
 *
 * Exit codes:
 *   0  — success
 *   1  — guard blocked the operation (protected file, citation found, missing --confirm)
 *   2  — file not found
 *   3  — malformed frontmatter
 *   99 — unknown error
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  renameSync,
  unlinkSync,
  copyFileSync,
} from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// ─── Constants ──────────────────────────────────────────────────────────────
// Paths are derived project-relative to the repo root. This script lives at
// `<repo>/.claude/scripts/agentic/consolidate-memory.mjs`, so the repo root is
// three directories up. The defaults follow the conventional harness layout:
// memory under `.claude/memory/`, archive under `.claude/memory/archived/`,
// citation roots = the always-loaded `CLAUDE.md` + the `.claude/rules/` corpus.
//
// Env-var overrides (AGENT_MEMORY_DIR / AGENT_MEMORY_ARCHIVE_DIR /
// AGENT_MEMORY_CITATION_ROOTS) let a calibrator or a project with a non-default
// memory location point the script at other directories (e.g. a test sandbox).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const REPO_ROOT = path.win32.resolve(SCRIPT_DIR, '..', '..', '..').replace(/\\/g, '/')

const DEFAULT_MEMORY_DIR = path.win32.join(REPO_ROOT, '.claude/memory').replace(/\\/g, '/')
const DEFAULT_ARCHIVE_DIR = path.win32.join(REPO_ROOT, '.claude/memory/archived').replace(/\\/g, '/')
const DEFAULT_CITATION_ROOTS = [
  path.win32.join(REPO_ROOT, 'CLAUDE.md').replace(/\\/g, '/'),
  path.win32.join(REPO_ROOT, '.claude/rules').replace(/\\/g, '/'),
]

const MEMORY_DIR = (process.env.AGENT_MEMORY_DIR || DEFAULT_MEMORY_DIR).replace(/\\/g, '/')
const ARCHIVE_DIR = (process.env.AGENT_MEMORY_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR).replace(/\\/g, '/')
const MEMORY_INDEX = path.win32.join(MEMORY_DIR, 'MEMORY.md')

// CITATION_SCAN_ROOTS: when env override is set, use only those roots PLUS the
// memory dir (since the index references files by name and other memory files
// can cross-cite via `links:`). When not set, the default roots are used.
const CITATION_SCAN_ROOTS = (() => {
  const env = process.env.AGENT_MEMORY_CITATION_ROOTS
  if (env && env.length > 0) {
    // Split on path-list delimiter. Use ';' on Windows and ':' elsewhere, but
    // also accept the opposite separator as fallback for cross-platform calls.
    const sep = env.includes(';') ? ';' : (env.includes(':') && !/^[A-Za-z]:/.test(env) ? ':' : ';')
    const roots = env.split(sep).map(s => s.trim()).filter(Boolean).map(s => s.replace(/\\/g, '/'))
    return [...roots, MEMORY_DIR]
  }
  return [...DEFAULT_CITATION_ROOTS, MEMORY_DIR]
})()

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference', 'product'])
const VALID_TIERS = new Set(['core', 'episodic', 'semantic', 'procedural', 'deprecated'])

// Files that must never be auto-merged or auto-archived. The PRIMARY protection
// signal is the per-file `protected: true` frontmatter flag — every project marks
// its own scar-tissue / hot-tier files that way, and the guards below honor it.
//
// This hardcoded set is only a project-agnostic fallback floor: the always-present
// operator-identity file, plus the cross-project agent-behavior contracts that
// should never be auto-pruned even before a project runs the migration pass that
// stamps `protected: true`. A project can extend this floor without editing the
// script by setting AGENT_MEMORY_PROTECTED_FILES to a comma-separated filename
// list — those are unioned in, so project-specific protected files (a settled
// architecture decision, a domain non-negotiable) need no code change.
const BASE_PROTECTED_FILES = [
  'user_profile.md',
  'feedback_command_shortcuts.md',
  'feedback_direct_action_sentinel.md',
  'feedback_zero_process_language_in_commits.md',
  'feedback_no_background_agents.md',
  'feedback_no_deferring.md',
  'feedback_no_unsolicited_changes.md',
  'feedback_anti_incrementalism.md',
  'feedback_planning_before_execution.md',
  'feedback_settled_decisions.md',
]

const PROTECTED_FILES = new Set([
  ...BASE_PROTECTED_FILES,
  ...(process.env.AGENT_MEMORY_PROTECTED_FILES
    ? process.env.AGENT_MEMORY_PROTECTED_FILES.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

// Type-to-tier mapping (5-type taxonomy → cognitive tier).
function tierForType(type) {
  switch (type) {
    case 'user': return 'core'
    case 'product': return 'semantic'
    case 'project': return 'semantic'
    case 'reference': return 'procedural'
    case 'feedback': return 'episodic'
    default: return 'semantic'
  }
}

// ─── Logging ────────────────────────────────────────────────────────────────
function log(msg) { process.stderr.write(`[consolidate-memory] ${msg}\n`) }
function fail(code, msg) { process.stderr.write(`[consolidate-memory] ERROR: ${msg}\n`); process.exit(code) }

// ─── Argument parsing ────────────────────────────────────────────────────────
// Accepts `--key=value`, `--key value`, and bare flags `--flag`.
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++ }
        else { out[a.slice(2)] = true }
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

// ─── Minimal YAML frontmatter parser ─────────────────────────────────────────
// Handles only the subset used in the harness memory files:
//   - scalar string (quoted or bare)
//   - scalar int
//   - boolean (true/false)
//   - ISO date or YYYY-MM-DD (kept as string)
//   - inline array: [a, b, "c d"]
//   - block array:
//       key:
//         - item1
//         - item2
// Comments (`# ...`) on bare lines are skipped. No nested objects.
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw, hadFrontmatter: false }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) throw new Error('frontmatter open found but no closing --- delimiter')
  const yamlText = raw.slice(3, end).trim()
  const after = raw.slice(end + 4)
  // Standard frontmatter convention has a blank line between closing `---`
  // and body. Strip all leading newlines so roundtrip emits a stable shape
  // and the body string matches what downstream tooling reads.
  const body = after.replace(/^\n+/, '')

  const meta = {}
  const lines = yamlText.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) { i++; continue }
    const key = m[1]
    let val = m[2]
    if (val === '' || val === null) {
      // Possible block array following on indented lines.
      const arr = []
      let j = i + 1
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        arr.push(parseScalar(lines[j].replace(/^\s+-\s+/, '')))
        j++
      }
      meta[key] = arr
      i = j
      continue
    }
    val = val.trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = parseInlineArray(val)
    } else {
      meta[key] = parseScalar(val)
    }
    i++
  }
  return { meta, body, hadFrontmatter: true }
}

function parseScalar(raw) {
  let v = raw.trim()
  // Strip trailing comment (only when preceded by whitespace and not inside quotes).
  if (!/^["']/.test(v)) {
    const c = v.search(/\s+#/)
    if (c !== -1) v = v.slice(0, c).trim()
  }
  if (v === '') return ''
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v)
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

function parseInlineArray(raw) {
  const inner = raw.slice(1, -1).trim()
  if (!inner) return []
  // Split on commas not inside quotes.
  const parts = []
  let buf = ''
  let inQuote = null
  for (const ch of inner) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      buf += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
      buf += ch
    } else if (ch === ',') {
      parts.push(buf); buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim()) parts.push(buf)
  return parts.map(p => parseScalar(p))
}

// ─── Frontmatter emitter ─────────────────────────────────────────────────────
// Emits keys in a stable order so diffs are minimal. Unknown keys preserved
// after the well-known set.
const KEY_ORDER = [
  'name', 'description', 'type', 'tier', 'topic',
  'importance', 'access_count', 'last_accessed', 'created',
  'protected', 'keywords', 'tags', 'links', 'relatedRules',
  'sources', 'lastVerified', 'originSessionId',
]

function emitFrontmatter(meta) {
  const seen = new Set()
  const lines = ['---']
  for (const k of KEY_ORDER) {
    if (k in meta) { lines.push(emitKv(k, meta[k])); seen.add(k) }
  }
  for (const k of Object.keys(meta)) {
    if (!seen.has(k)) lines.push(emitKv(k, meta[k]))
  }
  lines.push('---')
  return lines.join('\n') + '\n'
}

function emitKv(k, v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return `${k}: []`
    const allShort = v.every(x => typeof x === 'string' && !/[,\[\]"']/.test(x) && x.length < 60)
    if (allShort && v.length <= 8) return `${k}: [${v.map(emitInlineScalar).join(', ')}]`
    return `${k}:\n` + v.map(x => `  - ${emitInlineScalar(x)}`).join('\n')
  }
  return `${k}: ${emitInlineScalar(v)}`
}

function emitInlineScalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  const s = String(v)
  if (s === '' || /[:#\[\]&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s)
  }
  return s
}

// ─── File I/O helpers ────────────────────────────────────────────────────────
function readMemoryFile(filename) {
  const abs = path.win32.join(MEMORY_DIR, filename)
  if (!existsSync(abs)) fail(2, `memory file not found: ${abs}`)
  const raw = readFileSync(abs, 'utf8')
  let parsed
  try { parsed = parseFrontmatter(raw) }
  catch (e) { fail(3, `malformed frontmatter in ${filename}: ${e.message}`) }
  if (!parsed.hadFrontmatter) {
    fail(3, `${filename} has no YAML frontmatter — refusing to operate on a memory file with no metadata block`)
  }
  return { abs, raw, ...parsed }
}

function writeMemoryFileAtomic(filename, meta, body) {
  const abs = path.win32.join(MEMORY_DIR, filename)
  const tmp = abs + '.tmp'
  const content = emitFrontmatter(meta) + body
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, abs)
  return abs
}

function listMemoryFilenames() {
  const entries = readdirSync(MEMORY_DIR)
  return entries
    .filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    .sort()
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function fileMtimeIso(abs) {
  return new Date(statSync(abs).mtime).toISOString().slice(0, 10)
}

function ageDays(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86400000)
}

// ─── MEMORY.md parser + rebuilder ────────────────────────────────────────────
// MEMORY.md structure: `## Section Header`, then bullets `- [name](file.md) — desc`.
// Free-form lines (e.g. the CTO-policy note in "Feedback — Agent Behavior")
// are preserved verbatim.
function parseMemoryIndex() {
  if (!existsSync(MEMORY_INDEX)) return { sections: [], leadingText: '# Memory Index\n\n' }
  const raw = readFileSync(MEMORY_INDEX, 'utf8')
  const lines = raw.split(/\r?\n/)
  const sections = []
  let leadingText = ''
  let cur = null
  let mode = 'preamble'
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (cur) sections.push(cur)
      cur = { title: line.slice(3).trim(), entries: [], freeText: [] }
      mode = 'section'
    } else if (mode === 'preamble') {
      leadingText += line + '\n'
    } else {
      const m = line.match(/^-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[—-]\s*(.*))?$/)
      if (m) {
        cur.entries.push({ name: m[1], file: m[2], desc: m[3] || '' })
      } else if (line.trim()) {
        cur.freeText.push(line)
      }
    }
  }
  if (cur) sections.push(cur)
  return { sections, leadingText }
}

function emitMemoryIndex(idx) {
  let out = idx.leadingText.replace(/\n+$/, '\n\n')
  if (!out.startsWith('#')) out = '# Memory Index\n\n' + out
  for (const s of idx.sections) {
    out += `## ${s.title}\n\n`
    for (const f of s.freeText) out += f + '\n'
    if (s.freeText.length && s.entries.length) out += '\n'
    for (const e of s.entries) {
      out += `- [${e.name}](${e.file})${e.desc ? ` — ${e.desc}` : ''}\n`
    }
    out += '\n'
  }
  return out
}

function writeMemoryIndexAtomic(idx) {
  const tmp = MEMORY_INDEX + '.tmp'
  writeFileSync(tmp, emitMemoryIndex(idx), 'utf8')
  renameSync(tmp, MEMORY_INDEX)
}

// Pick a section title for a given type/file. Best-effort: match an existing
// section by title heuristic; fall back to the type's default category.
function sectionForType(idx, type, filename) {
  const titles = idx.sections.map(s => s.title.toLowerCase())
  const want = (() => {
    switch (type) {
      case 'user': return 'user'
      case 'product': return 'product'
      case 'project': return 'architecture & project state'
      case 'reference': return 'reference'
      case 'feedback':
        if (/communication|crisp|concise|format|sentinel|shortcut/i.test(filename)) return 'priority — communication rules'
        if (/shader|glsl|fbo|compositor|gl_state/i.test(filename)) return 'feedback — engineering rules'
        if (/code_blocks|pixel|trace|verify|defer|background|unsolicited|planning/i.test(filename)) return 'feedback — agent behavior'
        return 'feedback — domain-specific'
      default: return 'reference'
    }
  })()
  let target = idx.sections.find(s => s.title.toLowerCase() === want)
  if (!target) {
    target = { title: titlecase(want), entries: [], freeText: [] }
    idx.sections.push(target)
  }
  return target
}

function titlecase(s) { return s.replace(/\b([a-z])/g, (_, c) => c.toUpperCase()) }

// ─── Atomic two-file commit ──────────────────────────────────────────────────
// Pattern: write both .tmp files first, then rename in sequence. If the second
// rename fails we restore the first from a same-directory backup. Built around
// a single failure model — partial writes are recoverable; partial renames
// trigger restore.
function commitFileAndIndex(filename, meta, body, idx) {
  const fileAbs = path.win32.join(MEMORY_DIR, filename)
  const fileTmp = fileAbs + '.tmp'
  const fileBackup = fileAbs + '.backup'
  const indexTmp = MEMORY_INDEX + '.tmp'
  const indexBackup = MEMORY_INDEX + '.backup'

  // Write tmps.
  writeFileSync(fileTmp, emitFrontmatter(meta) + body, 'utf8')
  writeFileSync(indexTmp, emitMemoryIndex(idx), 'utf8')

  // Backup current originals (best-effort — file may not yet exist on store).
  let hadFile = false
  if (existsSync(fileAbs)) { copyFileSync(fileAbs, fileBackup); hadFile = true }
  let hadIndex = false
  if (existsSync(MEMORY_INDEX)) { copyFileSync(MEMORY_INDEX, indexBackup); hadIndex = true }

  // Rename file first.
  try { renameSync(fileTmp, fileAbs) }
  catch (e) {
    cleanup([fileTmp, indexTmp, fileBackup, indexBackup])
    fail(99, `commit aborted (file rename): ${e.message}`)
  }

  // Then rename index. If this fails, restore the file from backup.
  try { renameSync(indexTmp, MEMORY_INDEX) }
  catch (e) {
    log(`index rename failed — restoring file from backup`)
    if (hadFile) {
      try { copyFileSync(fileBackup, fileAbs) } catch {}
    } else {
      try { unlinkSync(fileAbs) } catch {}
    }
    cleanup([fileTmp, indexTmp, fileBackup, indexBackup])
    fail(99, `commit aborted (index rename): ${e.message}`)
  }

  cleanup([fileBackup, indexBackup])
}

function cleanup(paths) {
  for (const p of paths) { try { if (existsSync(p)) unlinkSync(p) } catch {} }
}

// ─── Citation scanning ───────────────────────────────────────────────────────
// Greps the citation roots for `<name>` (with and without .md extension).
// Returns hits as {file, line, snippet}. Skips hits inside the file itself
// when scanning the memory directory.
function scanCitations(name) {
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name
  const filename = stem + '.md'
  const targets = [stem, filename]
  const hits = []
  for (const root of CITATION_SCAN_ROOTS) {
    if (!existsSync(root)) continue
    const stat = statSync(root)
    if (stat.isFile()) scanFile(root, targets, filename, hits)
    else walkDir(root, (abs) => scanFile(abs, targets, filename, hits))
  }
  return hits
}

function walkDir(dir, fn) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    const abs = path.win32.join(dir, e)
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) walkDir(abs, fn)
    else if (st.isFile() && /\.(md|mdx|txt)$/i.test(e)) fn(abs)
  }
}

function scanFile(abs, targets, filename, hits) {
  // Skip the file we're scanning for.
  if (path.win32.basename(abs) === filename) return
  // The MEMORY.md index always lists the file by name as part of its pointer
  // table. That pointer is rewritten atomically by the discard operation, so
  // it is NOT a blocking citation. Skip MEMORY.md entirely from the scan.
  if (path.win32.basename(abs).toLowerCase() === 'memory.md') return
  let raw
  try { raw = readFileSync(abs, 'utf8') } catch { return }
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const t of targets) {
      if (line.includes(t)) {
        hits.push({ file: abs, line: i + 1, snippet: line.trim().slice(0, 200) })
        break
      }
    }
  }
}

// ─── Tokenization for retrieval ──────────────────────────────────────────────
function tokenize(s) {
  if (!s) return []
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)
}

function uniqLower(arr) {
  const out = new Set()
  for (const a of arr) {
    if (a == null) continue
    out.add(String(a).toLowerCase())
  }
  return [...out]
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

// list — print all memory files with frontmatter summary, aligned columns.
function cmdList() {
  const files = listMemoryFilenames()
  const rows = []
  for (const f of files) {
    const abs = path.win32.join(MEMORY_DIR, f)
    let meta = {}
    try { const p = parseFrontmatter(readFileSync(abs, 'utf8')); meta = p.meta || {} }
    catch { meta = { _malformed: true } }
    rows.push({
      name: f,
      type: meta.type || '?',
      tier: meta.tier || tierForType(meta.type) || '?',
      importance: meta.importance != null ? String(meta.importance) : '-',
      protected: meta.protected ? 'Y' : '-',
      access: meta.access_count != null ? String(meta.access_count) : '-',
      age: ageDays(meta.last_accessed) != null ? `${ageDays(meta.last_accessed)}d` : '-',
    })
  }
  rows.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name))
  const w = (k, min) => Math.max(min, ...rows.map(r => r[k].length))
  const widths = { name: w('name', 6), type: w('type', 4), tier: w('tier', 4), importance: w('importance', 3), protected: 4, access: w('access', 6), age: w('age', 4) }
  const header = `${'NAME'.padEnd(widths.name)}  ${'TYPE'.padEnd(widths.type)}  ${'TIER'.padEnd(widths.tier)}  ${'IMP'.padEnd(widths.importance)}  ${'PROT'.padEnd(widths.protected)}  ${'ACCESS'.padEnd(widths.access)}  ${'AGE'.padEnd(widths.age)}`
  process.stdout.write(header + '\n')
  process.stdout.write('-'.repeat(header.length) + '\n')
  for (const r of rows) {
    process.stdout.write(`${r.name.padEnd(widths.name)}  ${r.type.padEnd(widths.type)}  ${r.tier.padEnd(widths.tier)}  ${r.importance.padEnd(widths.importance)}  ${r.protected.padEnd(widths.protected)}  ${r.access.padEnd(widths.access)}  ${r.age.padEnd(widths.age)}\n`)
  }
  log(`${rows.length} files listed`)
}

// migrate — populate the new metadata fields on every file. Body untouched.
function cmdMigrate(args) {
  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true'
  const files = listMemoryFilenames()
  let touched = 0
  for (const f of files) {
    const abs = path.win32.join(MEMORY_DIR, f)
    const raw = readFileSync(abs, 'utf8')
    let parsed
    try { parsed = parseFrontmatter(raw) }
    catch (e) { log(`SKIP malformed: ${f} — ${e.message}`); continue }
    if (!parsed.hadFrontmatter) { log(`SKIP no-frontmatter: ${f}`); continue }
    const meta = parsed.meta
    const before = JSON.stringify(meta)
    if (!('tier' in meta)) meta.tier = tierForType(meta.type)
    if (!('importance' in meta)) meta.importance = 5
    if (!('last_accessed' in meta)) meta.last_accessed = fileMtimeIso(abs)
    if (!('access_count' in meta)) meta.access_count = 0
    if (!('keywords' in meta)) meta.keywords = []
    if (!('links' in meta)) meta.links = []
    if (!('protected' in meta)) meta.protected = PROTECTED_FILES.has(f)
    const after = JSON.stringify(meta)
    if (before === after) { continue }
    touched++
    if (dryRun) {
      log(`would migrate: ${f}`)
    } else {
      writeMemoryFileAtomic(f, meta, parsed.body)
      log(`migrated: ${f}`)
    }
  }
  log(`${dryRun ? 'would touch' : 'touched'} ${touched} of ${files.length} files`)
}

// store — create a new memory file with frontmatter + index entry.
// Body source: either --body-file <path> (read file) or --body <raw text>.
function cmdStore(args) {
  const name = args.name
  const type = args.type
  const bodyFile = args['body-file']
  const bodyRaw = args.body
  if (!name || !type || (!bodyFile && bodyRaw == null)) {
    fail(99, `store requires --name, --type, and either --body-file <path> or --body <text>`)
  }
  if (!VALID_TYPES.has(type)) fail(99, `invalid --type "${type}" (must be one of ${[...VALID_TYPES].join(', ')})`)
  if (bodyFile && !existsSync(bodyFile)) fail(2, `body file not found: ${bodyFile}`)
  const filename = name.endsWith('.md') ? name : `${name}.md`
  const abs = path.win32.join(MEMORY_DIR, filename)
  if (existsSync(abs)) fail(1, `memory file already exists: ${abs} — use update for in-place edits (duplicate name)`)
  const bodyText = bodyFile ? readFileSync(bodyFile, 'utf8') : String(bodyRaw)
  // Normalize: ensure body ends with a single trailing newline.
  const body = bodyText.endsWith('\n') ? bodyText : bodyText + '\n'
  const importance = args.importance != null ? parseInt(args.importance, 10) : 5
  if (!(importance >= 1 && importance <= 10)) fail(99, `--importance must be 1..10`)
  const keywords = args.keywords ? args.keywords.split(',').map(s => s.trim()).filter(Boolean) : []
  const links = args.links ? args.links.split(',').map(s => s.trim()).filter(Boolean) : []
  const today = todayIso()
  const meta = {
    name: args.description ? args.description : name,
    description: args.description || '',
    type,
    tier: tierForType(type),
    importance,
    access_count: 1,
    last_accessed: today,
    created: today,
    protected: PROTECTED_FILES.has(filename),
    keywords,
    links,
  }
  // Update index.
  const idx = parseMemoryIndex()
  const section = sectionForType(idx, type, filename)
  section.entries.push({ name: filename, file: filename, desc: args.description || '' })
  // Ensure the index has a trailing entry for the new file even when no
  // matching section existed previously.
  commitFileAndIndex(filename, meta, body, idx)
  log(`stored ${filename} under "${section.title}"`)
  process.stdout.write(JSON.stringify({ ok: true, file: abs, section: section.title }) + '\n')
}

// retrieve — keyword search over frontmatter + body, returns top-k JSON.
// Updates last_accessed and access_count on returned files unless --readonly.
function cmdRetrieve(args) {
  const query = args.query
  if (!query) fail(99, `retrieve requires --query`)
  const k = args.k != null ? parseInt(args.k, 10) : 5
  const typeFilter = args.type
  const readonly = args.readonly === true || args.readonly === 'true'
  const tokens = tokenize(query)
  const results = []
  const files = listMemoryFilenames()
  for (const f of files) {
    const abs = path.win32.join(MEMORY_DIR, f)
    let parsed
    try { parsed = parseFrontmatter(readFileSync(abs, 'utf8')) } catch { continue }
    const meta = parsed.meta || {}
    if (typeFilter && meta.type !== typeFilter) continue
    const fields = uniqLower([
      ...(Array.isArray(meta.keywords) ? meta.keywords : []),
      ...(Array.isArray(meta.tags) ? meta.tags : []),
      ...tokenize(meta.name),
      ...tokenize(meta.description),
      ...tokenize(meta.topic),
      ...tokenize(f.replace(/\.md$/, '').replace(/_/g, ' ')),
    ])
    let overlap = 0
    for (const t of tokens) if (fields.includes(t)) overlap++
    if (overlap === 0) continue
    const importance = typeof meta.importance === 'number' ? meta.importance : 5
    const importanceWeight = importance / 10
    const ageD = ageDays(meta.last_accessed)
    const recencyWeight = ageD == null ? 1 : 1 / (1 + ageD / 30)
    const score = (overlap / Math.max(tokens.length, 1)) * importanceWeight * recencyWeight
    const snippet = (parsed.body || '').replace(/\s+/g, ' ').slice(0, 240)
    results.push({ filename: f, description: meta.description || '', importance, score: Number(score.toFixed(4)), overlap, snippet })
  }
  results.sort((a, b) => b.score - a.score)
  const top = results.slice(0, k)
  if (!readonly && top.length) {
    const today = todayIso()
    for (const r of top) {
      const abs = path.win32.join(MEMORY_DIR, r.filename)
      let p
      try { p = parseFrontmatter(readFileSync(abs, 'utf8')) } catch { continue }
      p.meta.last_accessed = today
      p.meta.access_count = (typeof p.meta.access_count === 'number' ? p.meta.access_count : 0) + 1
      writeMemoryFileAtomic(r.filename, p.meta, p.body)
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, query, k, count: top.length, results: top }, null, 2) + '\n')
  log(`retrieved ${top.length} of ${results.length} candidate matches`)
}

// update — patch frontmatter only. Refuse if protected unless --force.
function cmdUpdate(args) {
  const name = args.name
  if (!name) fail(99, `update requires --name`)
  const filename = name.endsWith('.md') ? name : `${name}.md`
  const force = args.force === true || args.force === 'true'
  const file = readMemoryFile(filename)
  if (file.meta.protected && !force) fail(1, `${filename} is protected — pass --force to override`)
  const meta = file.meta
  let descChanged = false
  if (args.importance != null) {
    const n = parseInt(args.importance, 10)
    if (!(n >= 1 && n <= 10)) fail(99, `--importance must be 1..10`)
    meta.importance = n
  }
  if (args['add-keywords']) {
    const add = args['add-keywords'].split(',').map(s => s.trim()).filter(Boolean)
    const cur = Array.isArray(meta.keywords) ? meta.keywords : []
    meta.keywords = uniqLower([...cur, ...add])
  }
  if (args['add-links']) {
    const add = args['add-links'].split(',').map(s => s.trim()).filter(Boolean)
    const cur = Array.isArray(meta.links) ? meta.links : []
    meta.links = [...new Set([...cur, ...add])]
  }
  if (args.description) {
    meta.description = args.description
    descChanged = true
  }
  meta.last_accessed = todayIso()
  // Maintain index entry if description changed.
  if (descChanged) {
    const idx = parseMemoryIndex()
    let touched = false
    for (const s of idx.sections) {
      for (const e of s.entries) {
        if (e.file === filename) { e.desc = args.description; touched = true }
      }
    }
    if (touched) {
      commitFileAndIndex(filename, meta, file.body, idx)
    } else {
      writeMemoryFileAtomic(filename, meta, file.body)
    }
  } else {
    writeMemoryFileAtomic(filename, meta, file.body)
  }
  log(`updated ${filename}`)
  process.stdout.write(JSON.stringify({ ok: true, file: file.abs, descriptionChanged: descChanged }) + '\n')
}

// summarize — surface duplicate-cluster candidates within a category, JSON output.
// LLM owns the merge decision; this script only detects.
function cmdSummarize(args) {
  const scope = args.scope
  if (!scope) fail(99, `summarize requires --scope (category prefix, single name, or "all")`)
  const all = listMemoryFilenames()
  let pool
  if (scope === 'all') pool = all
  else if (all.includes(scope.endsWith('.md') ? scope : `${scope}.md`)) {
    const filename = scope.endsWith('.md') ? scope : `${scope}.md`
    const f = readMemoryFile(filename)
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: 'single',
      file: filename,
      meta: f.meta,
      bodyPreview: (f.body || '').slice(0, 500),
    }, null, 2) + '\n')
    return
  } else {
    pool = all.filter(n => n.startsWith(scope))
  }
  // Build keyword sets per file. Cluster detection uses ONLY the explicit
  // `keywords` + `tags` frontmatter fields — derived tokens from filename,
  // name, and description dilute the similarity signal and produce false
  // positives between unrelated files that happen to share filler words.
  // Retrieval scoring still uses the full enriched token set (see cmdRetrieve).
  const enriched = []
  for (const f of pool) {
    let p
    try { p = parseFrontmatter(readFileSync(path.win32.join(MEMORY_DIR, f), 'utf8')) } catch { continue }
    const meta = p.meta || {}
    const kw = uniqLower([
      ...(Array.isArray(meta.keywords) ? meta.keywords : []),
      ...(Array.isArray(meta.tags) ? meta.tags : []),
    ])
    enriched.push({ file: f, meta, keywords: kw })
  }
  // Pairwise overlap. Threshold = 0.6 of smaller set, minimum overlap 2.
  // The minimum-overlap floor catches genuinely duplicated rule sets without
  // tripping on a single shared tag like "communication".
  const clusters = []
  const used = new Set()
  for (let i = 0; i < enriched.length; i++) {
    if (used.has(enriched[i].file)) continue
    const a = enriched[i]
    if (a.keywords.length === 0) continue
    const cluster = [a.file]
    for (let j = i + 1; j < enriched.length; j++) {
      if (used.has(enriched[j].file)) continue
      const b = enriched[j]
      if (b.keywords.length === 0) continue
      const setB = new Set(b.keywords)
      const overlap = a.keywords.filter(k => setB.has(k)).length
      const denom = Math.max(1, Math.min(a.keywords.length, b.keywords.length))
      if (overlap / denom >= 0.6 && overlap >= 2) {
        cluster.push(b.file)
        used.add(b.file)
      }
    }
    if (cluster.length > 1) {
      used.add(a.file)
      clusters.push({
        size: cluster.length,
        files: cluster,
        sharedKeywords: clusterShared(enriched, cluster),
        protectedMembers: cluster.filter(f => PROTECTED_FILES.has(f)),
      })
    }
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    scope,
    poolSize: pool.length,
    clusterCount: clusters.length,
    clusters,
  }, null, 2) + '\n')
  log(`summarize: ${pool.length} pool, ${clusters.length} cluster(s) detected`)
}

function clusterShared(enriched, files) {
  const map = new Map()
  for (const e of enriched) {
    if (!files.includes(e.file)) continue
    for (const k of e.keywords) map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].filter(([, n]) => n === files.length).map(([k]) => k)
}

// discard — archive a file (single-name) or batch (predicate). Citation-grep
// is mandatory; --force only bypasses the protected guard, never the grep.
//
// Predicate mode is triggered by either:
//   --predicate (with sibling flags --type / --max-importance / etc.)
//   --predicate-type / --predicate-max-importance / --predicate-max-access-count /
//   --predicate-min-age-days   (sub-keyed flat form for shell-friendly callers)
function cmdDiscard(args) {
  const predicateKeys = [
    'predicate-type',
    'predicate-max-importance',
    'predicate-max-access-count',
    'predicate-min-age-days',
    'predicate-tier',
  ]
  const hasPredicateFlat = predicateKeys.some(k => k in args)
  if (args.predicate || hasPredicateFlat) return cmdDiscardPredicate(args)
  const name = args.name
  if (!name) fail(99, `discard requires --name OR --predicate (or --predicate-type / --predicate-max-importance / ...)`)
  const filename = name.endsWith('.md') ? name : `${name}.md`
  const force = args.force === true || args.force === 'true'
  archiveOne(filename, force)
}

function archiveOne(filename, force) {
  const file = readMemoryFile(filename)
  const isProtected = !!file.meta.protected || PROTECTED_FILES.has(filename)
  // Citation grep runs before the protected guard so callers see the
  // strongest blocker first: if the file is referenced by another tracked
  // document, the discard is unsafe regardless of protected state.
  const hits = scanCitations(filename)
  if (hits.length > 0) {
    process.stderr.write(`[consolidate-memory] ${filename} is cited — discard blocked. Citation references must be removed first:\n`)
    for (const h of hits) process.stderr.write(`  ${h.file}:${h.line}  ${h.snippet}\n`)
    process.stdout.write(JSON.stringify({ ok: false, blocked: 'citations', hits }) + '\n')
    process.exit(1)
  }
  if (isProtected && !force) fail(1, `${filename} is protected — pass --force to discard (no citations were found)`)
  // Stamp tier=deprecated; preserve original tier as previous_tier.
  const meta = file.meta
  if (meta.tier && meta.tier !== 'deprecated') meta.previous_tier = meta.tier
  meta.tier = 'deprecated'
  meta.archived_on = todayIso()
  // Pre-flight: confirm archive root exists and is a directory. If the path
  // is occupied by a non-directory (the read-only-archive harness replaces it
  // with a sentinel file) or mkdir fails, abort BEFORE touching MEMORY.md or
  // the source file so the operation rolls back atomically.
  let archiveStat = null
  try { archiveStat = existsSync(ARCHIVE_DIR) ? statSync(ARCHIVE_DIR) : null } catch { archiveStat = null }
  if (archiveStat && !archiveStat.isDirectory()) {
    fail(1, `archive path is not a directory: ${ARCHIVE_DIR} — discard aborted, no source mutation`)
  }
  if (!archiveStat) {
    try { mkdirSync(ARCHIVE_DIR, { recursive: true }) }
    catch (e) { fail(1, `cannot create archive dir ${ARCHIVE_DIR}: ${e.message} — discard aborted, no source mutation`) }
  }
  const archivePath = path.win32.join(ARCHIVE_DIR, filename)
  let archiveTarget = archivePath
  if (existsSync(archivePath)) {
    const stamp = todayIso().replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex')
    const renamed = filename.replace(/\.md$/, `.${stamp}.md`)
    log(`archive collision — writing as ${renamed}`)
    archiveTarget = path.win32.join(ARCHIVE_DIR, renamed)
  }
  // Write the archive copy first. If it fails, rollback by leaving the source
  // file and MEMORY.md untouched.
  try {
    writeFileSync(archiveTarget, emitFrontmatter(meta) + file.body, 'utf8')
  } catch (e) {
    fail(1, `archive write failed: ${e.message} — source file and MEMORY.md left untouched`)
  }
  // Remove from MEMORY.md and unlink original. If the index rewrite fails,
  // attempt to remove the just-written archive copy so the system is not in
  // a half-applied state.
  const idx = parseMemoryIndex()
  for (const s of idx.sections) s.entries = s.entries.filter(e => e.file !== filename)
  const indexTmp = MEMORY_INDEX + '.tmp'
  try { writeFileSync(indexTmp, emitMemoryIndex(idx), 'utf8') }
  catch (e) {
    try { unlinkSync(archiveTarget) } catch {}
    fail(1, `failed to stage MEMORY.md update: ${e.message} — archive copy reverted, source untouched`)
  }
  try { renameSync(indexTmp, MEMORY_INDEX) }
  catch (e) {
    try { unlinkSync(indexTmp) } catch {}
    try { unlinkSync(archiveTarget) } catch {}
    fail(1, `failed to commit MEMORY.md update: ${e.message} — archive copy reverted, source untouched`)
  }
  unlinkSync(file.abs)
  log(`archived ${filename} → ${ARCHIVE_DIR}`)
  process.stdout.write(JSON.stringify({ ok: true, archived: filename, location: ARCHIVE_DIR }) + '\n')
}

function cmdDiscardPredicate(args) {
  // Accept both the dashed `--type=...` form (used inside --predicate) and the
  // flat `--predicate-type=...` form (used by callers that prefer one flag
  // namespace per predicate field).
  const type = args.type ?? args['predicate-type']
  const rawMaxImp = args['max-importance'] ?? args['predicate-max-importance']
  const rawMaxAcc = args['max-access-count'] ?? args['predicate-max-access-count']
  const rawMinAge = args['min-age-days'] ?? args['predicate-min-age-days']
  const rawTier = args.tier ?? args['predicate-tier']
  const maxImportance = rawMaxImp != null ? parseInt(rawMaxImp, 10) : null
  const maxAccess = rawMaxAcc != null ? parseInt(rawMaxAcc, 10) : null
  const minAge = rawMinAge != null ? parseInt(rawMinAge, 10) : null
  const tier = rawTier ?? null
  const confirm = args.confirm === true || args.confirm === 'true'
  const candidates = []
  for (const f of listMemoryFilenames()) {
    const abs = path.win32.join(MEMORY_DIR, f)
    let p
    try { p = parseFrontmatter(readFileSync(abs, 'utf8')) } catch { continue }
    const meta = p.meta || {}
    if (meta.protected || PROTECTED_FILES.has(f)) continue
    if (type && meta.type !== type) continue
    if (tier && (meta.tier || tierForType(meta.type)) !== tier) continue
    if (maxImportance != null && (meta.importance == null || meta.importance > maxImportance)) continue
    if (maxAccess != null && (meta.access_count == null || meta.access_count > maxAccess)) continue
    if (minAge != null) {
      const a = ageDays(meta.last_accessed)
      if (a == null || a < minAge) continue
    }
    candidates.push({ file: f, importance: meta.importance, access_count: meta.access_count, last_accessed: meta.last_accessed, type: meta.type, tier: meta.tier })
  }
  if (!confirm) {
    process.stdout.write(JSON.stringify({ ok: true, mode: 'predicate-dry-run', count: candidates.length, candidates, hint: 'rerun with --confirm to archive (citation grep still enforced per file)' }, null, 2) + '\n')
    log(`predicate matched ${candidates.length} candidates — pass --confirm to archive`)
    return
  }
  process.stderr.write(`[consolidate-memory] PREDICATE DISCARD: ${candidates.length} files. Citation grep enforced per file.\n`)
  let archived = 0
  let blocked = 0
  for (const c of candidates) {
    const hits = scanCitations(c.file)
    if (hits.length > 0) {
      log(`SKIP ${c.file} — ${hits.length} citation(s)`)
      blocked++
      continue
    }
    try {
      archiveOneSilent(c.file)
      archived++
    } catch (e) {
      log(`failed ${c.file}: ${e.message}`)
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, mode: 'predicate-archive', archived, blocked, total: candidates.length }) + '\n')
}

// archiveOneSilent — internal helper for batch path; throws instead of fail()
// so the loop can continue past a single failure.
function archiveOneSilent(filename) {
  const abs = path.win32.join(MEMORY_DIR, filename)
  if (!existsSync(abs)) throw new Error('not found')
  const raw = readFileSync(abs, 'utf8')
  const parsed = parseFrontmatter(raw)
  const meta = parsed.meta || {}
  if (meta.tier && meta.tier !== 'deprecated') meta.previous_tier = meta.tier
  meta.tier = 'deprecated'
  meta.archived_on = todayIso()
  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true })
  let archivePath = path.win32.join(ARCHIVE_DIR, filename)
  if (existsSync(archivePath)) {
    const stamp = todayIso().replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex')
    archivePath = path.win32.join(ARCHIVE_DIR, filename.replace(/\.md$/, `.${stamp}.md`))
  }
  writeFileSync(archivePath, emitFrontmatter(meta) + parsed.body, 'utf8')
  const idx = parseMemoryIndex()
  for (const s of idx.sections) s.entries = s.entries.filter(e => e.file !== filename)
  writeMemoryIndexAtomic(idx)
  unlinkSync(abs)
}

// citation-scan — pure query utility. Always returns the hit list and exits 0
// on success. Hit-presence is data, not a failure condition; reserve non-zero
// exits for actual errors (missing args, unreadable roots, etc.). Callers that
// need a guard should branch on `hitCount` in the JSON output.
function cmdCitationScan(args) {
  const name = args.name
  if (!name) fail(99, `citation-scan requires --name`)
  const filename = name.endsWith('.md') ? name : `${name}.md`
  const hits = scanCitations(filename)
  process.stdout.write(JSON.stringify({ ok: true, name: filename, hitCount: hits.length, hits }, null, 2) + '\n')
  if (hits.length > 0) log(`${hits.length} citation(s) found — discard would be blocked`)
  else log(`no citations — safe to discard`)
}

// memory-md-rebuild — regenerate MEMORY.md from on-disk files. Preserves
// the manual category structure where possible, drops missing entries, adds
// missing files into the type's default section.
function cmdMemoryMdRebuild(args) {
  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true'
  const idx = parseMemoryIndex()
  const onDisk = new Set(listMemoryFilenames())
  // Drop entries pointing to missing files.
  for (const s of idx.sections) {
    s.entries = s.entries.filter(e => onDisk.has(e.file))
  }
  // Add files not present anywhere in the index.
  const indexed = new Set()
  for (const s of idx.sections) for (const e of s.entries) indexed.add(e.file)
  for (const f of onDisk) {
    if (indexed.has(f)) continue
    let p
    try { p = parseFrontmatter(readFileSync(path.win32.join(MEMORY_DIR, f), 'utf8')) } catch { continue }
    const target = sectionForType(idx, p.meta?.type, f)
    target.entries.push({ name: f, file: f, desc: p.meta?.description || '' })
  }
  // Refresh descriptions from frontmatter on remaining entries.
  for (const s of idx.sections) {
    for (const e of s.entries) {
      let p
      try { p = parseFrontmatter(readFileSync(path.win32.join(MEMORY_DIR, e.file), 'utf8')) } catch { continue }
      if (p.meta?.description) e.desc = p.meta.description
    }
  }
  if (dryRun) {
    process.stdout.write(emitMemoryIndex(idx))
    log(`would rebuild MEMORY.md (${[...onDisk].length} files)`)
  } else {
    writeMemoryIndexAtomic(idx)
    log(`rebuilt MEMORY.md (${[...onDisk].length} files)`)
  }
}

// audit-report — print snapshot of metadata health.
function cmdAuditReport() {
  const files = listMemoryFilenames()
  const byType = {}
  const byTier = {}
  const highImportance = []
  const protectedFiles = []
  const zeroAccess = []
  const veryOld = []
  for (const f of files) {
    let p
    try { p = parseFrontmatter(readFileSync(path.win32.join(MEMORY_DIR, f), 'utf8')) } catch { continue }
    const m = p.meta || {}
    byType[m.type || '?'] = (byType[m.type || '?'] || 0) + 1
    const tier = m.tier || tierForType(m.type) || '?'
    byTier[tier] = (byTier[tier] || 0) + 1
    if (typeof m.importance === 'number' && m.importance >= 8) highImportance.push({ file: f, importance: m.importance })
    if (m.protected) protectedFiles.push(f)
    if (m.access_count === 0) zeroAccess.push(f)
    const a = ageDays(m.last_accessed)
    if (a != null && a > 180) veryOld.push({ file: f, age: a })
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    fileCount: files.length,
    byType,
    byTier,
    highImportance,
    protectedFiles,
    zeroAccess,
    veryOld,
  }, null, 2) + '\n')
  log(`audit-report: ${files.length} files, ${protectedFiles.length} protected, ${highImportance.length} high-importance`)
}

// ─── Help text ───────────────────────────────────────────────────────────────
const HELP = `consolidate-memory.mjs — file-level memory operations for /consolidate-memory

Usage: node consolidate-memory.mjs <subcommand> [args]

Subcommands:
  list                                            Print every memory file with metadata, aligned columns.
  migrate [--dry-run]                             Populate tier / importance / access fields on every file.
  store --name=<n> --type=<t> --body-file=<path>
        [--importance=<1-10>] [--keywords=<csv>]
        [--links=<csv>] [--description=<text>]   Create a new memory file + index entry. Halts on collision.
  retrieve --query=<q> [--type=<t>] [--k=5]
        [--readonly]                             Keyword search; JSON to stdout. Bumps access counts unless readonly.
  update --name=<n> [--importance=<i>]
        [--add-keywords=<csv>] [--add-links=<csv>]
        [--description=<text>] [--force]         Patch frontmatter. Refuses on protected files unless --force.
  summarize --scope=<category|name|all>          Detect duplicate clusters; LLM owns the merge decision.
  discard --name=<n> [--force]                   Archive one file. Citation-grep is non-bypassable.
  discard --predicate
        [--type=<t>] [--max-importance=<i>]
        [--max-access-count=<n>] [--min-age-days=<d>]
        [--confirm]                              Predicate batch archive. Requires --confirm to execute.
  citation-scan --name=<n>                       Grep CITATION_SCAN_ROOTS for the name. Exit 1 if cited.
  memory-md-rebuild [--dry-run]                  Rebuild MEMORY.md from on-disk files; preserves section structure.
  audit-report                                   Snapshot of metadata health (counts, importance, age).

Exit codes:
  0  success
  1  guard blocked (protected, citations, missing --confirm)
  2  file not found
  3  malformed frontmatter
  99 unknown error

Constants:
  MEMORY_DIR    = ${MEMORY_DIR}
  ARCHIVE_DIR   = ${ARCHIVE_DIR}
  MEMORY_INDEX  = ${MEMORY_INDEX}
`

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP)
    process.exit(0)
  }
  const sub = argv[0]
  const args = parseArgs(argv.slice(1))
  if (args.help === true || args.help === 'true') {
    process.stdout.write(HELP)
    process.exit(0)
  }
  // Sanity: MEMORY_DIR must exist.
  if (!existsSync(MEMORY_DIR)) fail(2, `MEMORY_DIR does not exist: ${MEMORY_DIR}`)
  try {
    switch (sub) {
      case 'list': return cmdList()
      case 'migrate': return cmdMigrate(args)
      case 'store': return cmdStore(args)
      case 'retrieve': return cmdRetrieve(args)
      case 'update': return cmdUpdate(args)
      case 'summarize': return cmdSummarize(args)
      case 'discard': return cmdDiscard(args)
      case 'citation-scan': return cmdCitationScan(args)
      case 'memory-md-rebuild': return cmdMemoryMdRebuild(args)
      case 'audit-report': return cmdAuditReport()
      default:
        fail(99, `unknown subcommand: ${sub}\n\n${HELP}`)
    }
  } catch (e) {
    fail(99, `${sub} failed: ${e.message}\n${e.stack}`)
  }
}

main()
