#!/usr/bin/env node
/**
 * Output Quality Judge — Stop hook for Rare.lab Claude Code harness.
 *
 * Architecture (rooted in CLAUDE.md §8.5/§8.6/§12.5, .claude/rules/cto-policy.md,
 * R01-R68 (R60 absent), and the harness audit history under .agents/audits/):
 *
 *   STAGE 1 — Deterministic pre-filter (always runs, ~1ms cost)
 *     Catches the obvious Section 8.5 violations cheaply:
 *       a) Buzzword-without-grounding (cto-policy.md "big words without substance")
 *       b) Padding heuristic (high section-count to grounding-ratio)
 *       c) Hallucinated R-rule numbers (validated against the live rules corpus, R01-R68)
 *       d) Hallucinated subsystem references (compiler-next is quarantined not retired; no compiler-v5)
 *       e) Skip conditions (engineered prompts, status echoes, short answers)
 *
 *   STAGE 2 — LLM judge via Anthropic Messages API (opt-in via env)
 *     Reads .claude/critics/output-quality.md as system prompt (cached for 90% reuse
 *     discount per Anthropic prompt caching docs). Sends Haiku call. Parses JSON
 *     verdict. Different model from main-agent (Sonnet/Opus) to mitigate
 *     self-preference bias (Zheng 2024, arXiv 2410.21819).
 *
 *   DECISION pipeline (per Claude Code Stop hook spec at code.claude.com/docs/en/hooks):
 *     - On hallucination → exit 0 + JSON {"decision":"block", "reason":..., "hookSpecificOutput":{"additionalContext":...}}
 *       Forces another turn with the critique loaded.
 *     - On other revise → exit 0 + JSON with hookSpecificOutput.additionalContext only.
 *       Surfaces critique without forcing a new turn — RED can iterate or accept.
 *     - On pass → exit 0, no JSON. Silent.
 *
 *   LOGGING: every verdict appended to .claude/cache/judge-log.jsonl for replay,
 *   calibration drift analysis, and the /judge-replay skill.
 *
 * Configuration (via env):
 *   RARE_JUDGE_OFF=1          → disable hook entirely (deterministic + LLM)
 *   RARE_JUDGE_LLM=1          → enable Stage 2 LLM call (default off — Stage 1 only)
 *   RARE_JUDGE_BLOCKING=1     → return decision:"block" on revise (default: additionalContext only, no block)
 *   ANTHROPIC_API_KEY=sk-...  → required if RARE_JUDGE_LLM=1
 *
 * Stop hook input shape (per code.claude.com/docs/en/hooks):
 *   { session_id, transcript_path, cwd, permission_mode,
 *     hook_event_name: "Stop", stop_reason: "end_turn"|...,
 *     output: "<assistant text>", tool_calls: [...] }
 *
 * Stop hook output shape (exit 0 + JSON):
 *   { decision: "block"|undefined, reason: "...",
 *     hookSpecificOutput: { hookEventName: "Stop", additionalContext: "..." },
 *     suppressOutput?: boolean }
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs'
import { dirname, resolve as pathResolve } from 'node:path'

// ─── Hard off-switch ────────────────────────────────────────────────────────
if (process.env.RARE_JUDGE_OFF === '1') process.exit(0)

// ─── Read hook input from stdin ──────────────────────────────────────────────
let payload = ''
try { payload = readFileSync(0, 'utf8') } catch { process.exit(0) }
let parsed
try { parsed = JSON.parse(payload) } catch { process.exit(0) }

const sessionId = parsed.session_id || parsed.sessionId || 'unknown'
const stopReason = parsed.stop_reason || parsed.stopReason || 'unknown'
const assistantText = parsed.output || ''
const cwd = parsed.cwd || process.cwd()

// Skip if no output (tool-only turn)
if (!assistantText || typeof assistantText !== 'string') process.exit(0)

// ─── Skip conditions (calibrated to known-low-signal response classes) ──────
function shouldSkip(text) {
  const trimmed = text.trim()

  // Engineered prompt block (rewrite protocol output)
  if (text.includes('♠♠ Awaiting confirmation, CAPTAIN RED')) return 'engineered-prompt'

  // Pure tool/status echo
  if (/^(Ready in [\d.]+s|Pulled|Pushed|Done|Acknowledged|Got it|Cleared|Restarted|Killed|Started)\b/.test(trimmed)) {
    if (text.length < 500) return 'tool-status-echo'
  }

  // Short yes/no answer — only skip if response is REALLY short (under 150 chars)
  // AND the answer is a single sentence. Earlier 300-char threshold false-positived
  // on responses like "No — per R47 (file-dispatch protocol)..." which are short
  // but make load-bearing claims that need auditing.
  const sentenceCount = (trimmed.match(/[.!?]+\s/g) || []).length + 1
  if (text.length < 150 && sentenceCount <= 2 && /^(yes|no|ok|done|got it|acknowledged|confirmed|sure|yep|nope)\b/i.test(trimmed)) {
    return 'short-answer'
  }

  // Crisp-it / Concise-it response — 3 lines max, each < 130 chars,
  // story-form (no inline code, no file:line citations, no backticks).
  // Calibration history:
  //   v1 (lines<=5 AND length<800) — false-positived on dense buzzword paragraphs
  //   v2 (lines<=3 AND longestLine<130 AND no codeblocks) — false-positived on
  //     load-bearing technical claims like "FX dispatch lives in `path.tsx` line 1571"
  //   v3 (this) — also exclude inline backticks and file:line citations, since
  //     true crisp-it format per feedback_text_command_shortcuts.md never
  //     contains either; both are signals of a load-bearing technical claim
  //     that warrants audit regardless of length.
  const lines = trimmed.split('\n').filter(l => l.trim())
  const longestLine = lines.reduce((m, l) => Math.max(m, l.length), 0)
  const hasInlineCode = /`[^`\n]+`/.test(text)
  const hasFileCitation = /[a-zA-Z_/.-]+\.(?:tsx|ts|jsx|js|mjs|md|sh|json|glsl|frag|vert)/.test(text)
  if (lines.length <= 3 && longestLine < 130 && !/```/.test(text) && !hasInlineCode && !hasFileCitation) {
    return 'crisp-format'
  }

  // Direct Action confirmation echo (short)
  if (/^(Phase 2|Direct Action|Acknowledged)/.test(trimmed) && text.length < 400) return 'phase-confirmation'

  return null
}

const skipReason = shouldSkip(assistantText)

// ─── Valid R-rule numbers (scanned from the live rules corpus) ──────────────
// The rule set grows over time (R01-R68 today and counting). Hardcoding a
// ceiling drifts the moment a new rule ships — itself the R32 hallucination
// class this judge exists to catch — so derive the valid set from disk.
function loadValidRuleNumbers(root) {
  const set = new Set()
  for (const d of ['.claude/rules', '.claude/rules-topical']) {
    let files = []
    try { files = readdirSync(pathResolve(root, d)) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      try {
        const body = readFileSync(pathResolve(root, d, f), 'utf8')
        for (const m of body.match(/\bR(\d{2,3})\b/g) || []) set.add(parseInt(m.slice(1), 10))
      } catch { /* skip unreadable file */ }
    }
  }
  return set
}
const VALID_RULE_NUMBERS = loadValidRuleNumbers(cwd)

// ─── Stage 1: Deterministic pre-filter ──────────────────────────────────────
//
// Each check has a specific Section 8.5 mapping. Threshold tuned for low
// false-positive rate — judge errs toward letting through marginal cases
// rather than blocking incorrect ones.
function deterministicChecks(text) {
  const fails = []

  // a) Big-words-without-grounding (Section 8.5 question 3, cto-policy verbatim)
  // Buzzwords from cto-policy: "architectural concern, scalability surface,
  //   correctness prior, ownership boundary"
  // Plus harness audit Tier-C tells: "robust solution", "thoughtful approach",
  //   "synchronization boundary"
  const buzzwords = [
    'architectural concern', 'scalability surface', 'correctness prior',
    'ownership boundary', 'load-bearing surface', 'synchronization boundary',
    'robust solution', 'thoughtful approach', 'fundamental issue',
    'paradigm shift', 'best practice', 'industry standard',
  ]
  for (const word of buzzwords) {
    const idx = text.toLowerCase().indexOf(word)
    if (idx === -1) continue
    // Look for grounding within 400 chars after the buzzword:
    //   - file path with extension and line: foo.ts:42, lib/x.ts:42
    //   - inline code citation: `foo`
    //   - measurement: 10ms, 25KB, 60fps, 90%
    //   - R-rule citation: R03, R22
    const window = text.slice(idx, idx + 400)
    const groundingPattern = /[a-zA-Z_/.-]+\.(?:tsx|ts|jsx|js|mjs|md|sh|json|glsl|frag|vert):\d+|`[^`\n]+`|\d+\s*(?:ms|MB|KB|GB|fps|%|×)|[Rr]\d{2}/
    if (!groundingPattern.test(window)) {
      fails.push({
        audit: 'big_words',
        evidence: text.slice(idx, Math.min(idx + 100, text.length)).replace(/\s+/g, ' '),
        why: `"${word}" used without nearby grounding (file:line, measurement, R-rule, or quote).`,
      })
    }
  }

  // b) Padding heuristic
  // Long response with many numbered sections but few groundings = likely padded.
  // Section 8.5 question 6: "If a linter would catch it, it is not a CTO-level finding."
  if (text.length > 1500) {
    const numberedSections = (text.match(/^\s*\d+\.\s/gm) || []).length
    const filePaths = (text.match(/[a-zA-Z_/.-]+\.(?:tsx|ts|jsx|js|mjs|md|sh|json|glsl|frag|vert)/g) || []).length
    const codeFences = (text.match(/```/g) || []).length / 2
    const ruleRefs = (text.match(/\b[Rr]\d{2}\b/g) || []).length
    const groundings = filePaths + codeFences + ruleRefs

    if (numberedSections >= 4 && groundings < numberedSections / 2) {
      fails.push({
        audit: 'padding',
        evidence: `${numberedSections} numbered sections, ${groundings} grounding refs, ${text.length} chars`,
        why: `Structure-to-substance ratio low — sections-per-grounding > 2:1 typically signals padding.`,
      })
    }
  }

  // c) Hallucinated R-rule number — validated against the live rules corpus
  // (R01-R68 today, R60 absent). The valid set is scanned from disk at startup,
  // so the check never needs a manual bump when a new rule ships. If the corpus
  // could not be read, the set is empty and we skip rather than false-flag.
  // Auto-revise per cto-policy: "An articulate hallucination is still a hallucination."
  if (VALID_RULE_NUMBERS.size > 0) {
    const ruleMatches = text.match(/\b[Rr](\d{2,3})\b/g) || []
    for (const m of ruleMatches) {
      const num = parseInt(m.slice(1), 10)
      if (!VALID_RULE_NUMBERS.has(num)) {
        fails.push({
          audit: 'hallucination',
          evidence: m,
          why: `${m} is not a defined R-rule (scanned .claude/rules/ + .claude/rules-topical/; valid R01-R68, R60 absent).`,
        })
      }
    }
  }

  // d) Hallucinated subsystem references
  // Per R01: V3 is production, compiler-next is quarantined (the "V4" naming was retired). No V5 / V6 / V2.
  // Per R32: POL.md does not exist; the canonical CTO policy lives at .claude/rules/cto-policy.md.
  const knownHallucinations = [
    { pattern: /\bcompiler[\s-]?[vV]5\b/, why: 'Compiler V5 does not exist. V3 is production, compiler-next is quarantined per R01.' },
    { pattern: /\bcompiler[\s-]?[vV]6\b/, why: 'Compiler V6 does not exist. V3 is production per R01.' },
    { pattern: /\bcompiler[\s-]?[vV]2\b/, why: 'Compiler V2 does not exist. V3 is the current production compiler per R01.' },
    { pattern: /\bFBOCompositor[vV]2\.tsx\b/, why: 'FBOCompositorV2.tsx is not a filename per R23. The path is FBOCompositor.tsx; "V2" is spec-version shorthand.' },
    { pattern: /\bPOL\.md\b/, why: 'POL.md does not exist per R32. The canonical CTO policy lives at .claude/rules/cto-policy.md.' },
  ]
  for (const { pattern, why } of knownHallucinations) {
    const m = text.match(pattern)
    if (m) {
      fails.push({
        audit: 'hallucination',
        evidence: m[0],
        why,
      })
    }
  }

  // e) Hallucinated file paths — exists check on a sample of cited paths
  // Only checks paths that look like actual rare-lab paths AND can be statSync'd.
  // Rate-limited to first 10 path citations to keep hook fast.
  const pathCitations = [...new Set(text.match(/[a-zA-Z_][\w/.-]*\.(?:tsx|ts|jsx|js|mjs|md|sh|json|glsl|frag|vert)/g) || [])].slice(0, 10)
  for (const candidate of pathCitations) {
    // Only check if it looks like a rare-lab project path
    if (!/^(\.\/)?(lib|app|components|store|types|.claude|.agents|packages|scripts|public)\//.test(candidate)) continue
    try {
      const abs = pathResolve(cwd, candidate)
      statSync(abs)
    } catch {
      fails.push({
        audit: 'hallucination',
        evidence: candidate,
        why: `Cited path does not exist: ${candidate}`,
      })
    }
  }

  return fails
}

const detFails = skipReason ? [] : deterministicChecks(assistantText)

// ─── Stage 2: LLM judge (opt-in) ────────────────────────────────────────────
//
// Uses Anthropic Messages API with prompt caching on the system prompt
// (the critic is ~5K tokens; caching saves 90% per Anthropic docs).
// Different model than main-agent to mitigate self-preference bias.
async function llmJudge() {
  if (skipReason) return null
  if (process.env.RARE_JUDGE_LLM !== '1') return null
  if (!process.env.ANTHROPIC_API_KEY) return null

  const criticPath = pathResolve(cwd, '.claude/critics/output-quality.md')
  if (!existsSync(criticPath)) return null
  const criticPrompt = readFileSync(criticPath, 'utf8')

  // Pull last user prompt out of transcript if available.
  let userPrompt = ''
  if (parsed.transcript_path && existsSync(parsed.transcript_path)) {
    try {
      const lines = readFileSync(parsed.transcript_path, 'utf8').split('\n').filter(Boolean)
      const turns = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const lastUser = [...turns].reverse().find(t => t.message?.role === 'user' && !t.message?.content?.[0]?.tool_use_id)
      userPrompt = (lastUser?.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
    } catch { /* fall through */ }
  }

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [
      { type: 'text', text: criticPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        '## user_prompt',
        userPrompt.slice(-2000),
        '',
        '## assistant_response',
        assistantText.slice(-8000),
      ].join('\n'),
    }],
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      process.stderr.write(`[output-quality-judge] LLM call failed: HTTP ${res.status}\n`)
      return null
    }
    const data = await res.json()
    const text = (data.content?.[0]?.text || '').trim()
    // Extract JSON object — judge prompt mandates JSON-only output
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    return JSON.parse(match[0])
  } catch (err) {
    process.stderr.write(`[output-quality-judge] LLM error: ${err.message}\n`)
    return null
  }
}

const llmVerdict = await llmJudge()

// ─── Combine and decide ──────────────────────────────────────────────────────
function deriveVerdict() {
  if (skipReason) return { final: 'skip', score: null, hallucination: false }

  const detHallucinations = detFails.filter(f => f.audit === 'hallucination')
  const llmHallucinations = (llmVerdict?.fails || []).filter(f => f.audit === 'hallucination')
  const hallucination = detHallucinations.length > 0 || llmHallucinations.length > 0

  if (hallucination) return { final: 'revise', score: 0, hallucination: true }

  if (llmVerdict) {
    // LLM judge result wins when present
    return {
      final: llmVerdict.verdict === 'pass' ? 'pass' : 'revise',
      score: llmVerdict.score ?? null,
      hallucination: false,
    }
  }

  // Deterministic-only verdict
  return {
    final: detFails.length === 0 ? 'pass' : 'revise',
    score: detFails.length === 0 ? 100 : Math.max(0, 100 - detFails.length * 20),
    hallucination: false,
  }
}

const verdict = deriveVerdict()

// ─── Build the persistent log entry ─────────────────────────────────────────
const logEntry = {
  ts: new Date().toISOString(),
  session: sessionId,
  stopReason,
  responseLen: assistantText.length,
  skip: skipReason,
  detFails,
  llmVerdict: llmVerdict ? {
    verdict: llmVerdict.verdict,
    score: llmVerdict.score,
    tier: llmVerdict.tier,
    summary: llmVerdict.summary,
    hint: llmVerdict.suggested_revision_hint,
    fails: llmVerdict.fails,
  } : null,
  finalVerdict: verdict.final,
  finalScore: verdict.score,
  hallucinationDetected: verdict.hallucination,
}

const logPath = pathResolve(cwd, '.claude/cache/judge-log.jsonl')
mkdirSync(dirname(logPath), { recursive: true })
appendFileSync(logPath, JSON.stringify(logEntry) + '\n')

// ─── Emit the Stop-hook decision per the Claude Code spec ───────────────────
// Spec: code.claude.com/docs/en/hooks — Stop hook output JSON schema
//   { decision: "block" | undefined, reason: string, hookSpecificOutput: {...} }
if (verdict.final === 'revise') {
  // Build the critique payload for the next-turn system reminder
  const failLines = [
    ...detFails.map(f => `[deterministic:${f.audit}] ${f.why} (evidence: "${f.evidence}")`),
    ...((llmVerdict?.fails || []).map(f => `[llm:${f.audit}] ${f.why} (evidence: "${f.evidence}")`)),
  ]
  const critiquePayload = [
    `[output-quality-judge] Previous turn flagged for revision (verdict=revise, score=${verdict.score})`,
    ...(llmVerdict?.summary ? [`Summary: ${llmVerdict.summary}`] : []),
    'Findings:',
    ...failLines.map(l => `  - ${l}`),
    ...(llmVerdict?.suggested_revision_hint ? [`Hint: ${llmVerdict.suggested_revision_hint}`] : []),
    'Apply Section 8.5 self-audit before next response.',
  ].join('\n')

  const lastReviseCachePath = pathResolve(cwd, '.claude/cache/last-judge-revise.json')
  writeFileSync(lastReviseCachePath, JSON.stringify(logEntry, null, 2))

  // Default mode: surface critique as additionalContext for next turn (non-blocking)
  // Blocking mode (env-gated): force a re-turn with decision:"block"
  const blocking = process.env.RARE_JUDGE_BLOCKING === '1' || verdict.hallucination

  if (blocking) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: verdict.hallucination
        ? 'Hallucination detected by output-quality-judge — re-verify cited file paths, R-rule numbers, and subsystem references against the actual codebase before responding.'
        : `Output flagged by output-quality-judge (score=${verdict.score}). See additionalContext for findings.`,
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: critiquePayload,
      },
    }))
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: critiquePayload,
      },
    }))
  }
} else {
  // pass or skip — silent
}

process.exit(0)
