export const meta = {
  name: 'red-team-negation-round',
  description: 'R70 negation round: three veteran negators each independently try to PROVE the target artifact is junior-level, with external evidence read this run',
  phases: [{ title: 'Negate' }],
}

// One bounded round of R70. Three negators run concurrently on the WHOLE target
// (never split by lens), each carrying the full folded-charter goal set + the
// evidence mandate. The script synthesizes their verdicts: any CRITICAL/MAJOR =
// hypothesis proven on that point = caller revises + re-runs. A clean round (no
// CRITICAL/MAJOR from any negator, with real research on record) = the surface
// earned the senior-staff bar this iteration.

const NEGATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'] },
          negation_goal: { type: 'string', description: 'which goal it lands on: one of Q1-Q5, a hunt-catalogue category, or an interrogation-battery question' },
          surface: { type: 'string', description: 'file:line or component under attack' },
          claim_attacked: { type: 'string', description: 'the specific claim/decision being negated' },
          external_evidence: { type: 'string', description: 'repo@sha:file:line | URL | codebase file:line read THIS run' },
          why_it_breaks: { type: 'string' },
          fix_required: { type: 'string', description: 'the concrete actionable to reach senior-staff bar' },
        },
        required: ['severity', 'negation_goal', 'surface', 'claim_attacked', 'external_evidence', 'why_it_breaks', 'fix_required'],
      },
    },
    verdict: { type: 'string', enum: ['PROVED_JUNIOR', 'COULD_NOT_DISPROVE_SENIOR'] },
    verdict_basis: { type: 'string', description: 'PROVED_JUNIOR: the single biggest evidence-backed hole. COULD_NOT_DISPROVE_SENIOR: what was actually tried per axis (searches run, repos/specs read, goals attempted and failed)' },
    research_done: { type: 'array', items: { type: 'string' }, description: 'concrete searches run + repos/specs/blogs read this run, each with a citation' },
  },
  required: ['findings', 'verdict', 'verdict_basis', 'research_done'],
}

// The Workflow harness delivers `args` as a JSON STRING, not an object. Reading
// args?.files on a string yields undefined and starves the negators of a target —
// parse it first. (Confirmed via an args-probe workflow: typeof args === 'string'.)
const A = (typeof args === 'string')
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args ?? {})

const targetName = A?.targetName ?? 'the implementation under review'
const targetDescription = A?.targetDescription ?? ''
const fileList = Array.isArray(A?.files) ? A.files : []
const files = fileList.join('\n')
const prior = A?.priorFindingsSummary ?? '(first iteration — nothing fixed yet)'
const iteration = A?.iteration ?? 1

// Diagnostic: prove the target reached the script. fileCount === 0 means the
// negators have no surface; they are told to abort, not wander to git HEAD.
const fileCount = fileList.length
log(`Negation target: "${targetName}" | ${fileCount} files | iteration ${iteration}` + (fileCount === 0 ? ' — WARNING: no target files in args' : ''))

const HYPOTHESIS = `Prove, with external evidence: "This is junior-level, vibe-coded, mediocre work. It is NOT the best implementation for the real constraint, NOT the most scalable or performant approach, NOT what industry leaders actually ship, and the senior vocabulary is covering junior thinking. It will break, underperform, or balloon in cost in production." Your success = proving any load-bearing part of that hypothesis with external evidence. Conceding only happens when a genuine proof attempt FAILS against real evidence.`

const GOALS = `NEGATION GOALS (the folded cynical charter — you carry the FULL set, you do not get a slice):
From the five questions, each INVERTED into something you actively try to PROVE:
  Q1 — Prove it is NOT the best implementation for the real constraint. Find what senior-staff teams at industry leaders relevant to THIS problem domain shipped for this exact problem in open source; cite repo@sha:file:line. Prove ours diverges and the divergence is naive, not a documented trade-off.
  Q2 — Prove it does NOT scale at 10x / 100x. Find the ceiling. Show the scaling mechanism is assumed, not named/documented/enforced. Derive the break in measured numbers or first-principles math. ("It will be fine" is the claim you disprove.)
  Q3 — Prove the "industry standard" claim is hollow. Name the leaders, open the repos, read the code. If 3+ independent senior-staff codebases do NOT solve it this way, the cited pattern is invented.
  Q4 — Prove ours is an invented variation, not the proven pattern. Bridge each surfaced leader pattern to our codebase at file:line and prove ours diverges in a way that would not survive peer review at the named company.
  Q5 — Prove the senior vocabulary covers junior thinking. Every "concern"/"surface"/"prior"/"boundary" with no concrete finding behind it is filler.
From the hunt catalogue (sweep EVERY category, prove the artifact exhibits it with the specific instance + citation): hack-wrapped-in-ceremony, bloated vibe-coded code, hallucinated metric, cargo-cult lifted without its constraint, violation of the project's operating rules / non-negotiables (highest blast radius), the AI tell — hallucinated API, reporter/test deletion, summary-diff divergence, confidence uniformity, stale-context fix, shotgun fluency.
From the interrogation battery, fire the batteries the surfaces demand: lifecycle & state, error path, data structures & flow, the domain-specific hot path (whatever the artifact's heavy compute/IO is), persistence & data integrity, trust boundaries & security, claims & evidence, AI-authored code. An applicable battery question with no answer in the code is an open junior-level hole — prove it.`

const MANDATE = `EVIDENCE MANDATE (non-negotiable): a negation claim with no external proof is NOISE and is discarded. You may not approve OR condemn from the top of your head.
- WEB SEARCH IS REQUIRED. Use WebSearch / WebFetch (load via ToolSearch if not directly listed). "This won't scale" without a cited mechanism AND a prior-art reference is discarded. "This is fine" with zero searches and zero source reads is a rubber-stamp — invalid.
- Read the ACTUAL target files (Read / Grep) this run — do not recall them.
- Ground every load-bearing claim: GitHub source of industry-leader/top-OSS repos (repo@sha:file:line or file URL), industry-leader eng blogs / specs / papers (URL), benchmarks from a named source, or our codebase at file:line.
- Confidence may not exceed the evidence rung. Fluency is not evidence: interrogate HARDEST exactly where the code reads smoothest.
- An empty findings list is valid ONLY after genuine search + read effort, reported as COULD_NOT_DISPROVE_SENIOR with the per-axis record of what you tried. A non-trivial target with an empty sweep means you did not look hard enough — re-look before returning.`

function negatorPrompt(n) {
  return `You are veteran staff engineer and NEGATOR #${n} of three, running R70 (red-team negation loop), iteration ${iteration}. You and the other two attack the SAME complete target independently — you are NOT assigned a slice. The point is three pairs of veteran eyes on the whole thing so a hole one misses, another lands.

YOUR SOLE JOB: ${HYPOTHESIS}

${GOALS}

${MANDATE}

TARGET: ${targetName}
${targetDescription}

>>> SCOPE LOCK — the code under attack is EXACTLY these files (repo-root-relative paths), and NOTHING else:
${files}

Hard rules on scope: Read ONLY these listed files for the code under attack (use Read / Grep on these exact paths; you may also Read a file these directly import to understand a type, but findings must land on the listed files). Do NOT run \`git log\`, \`git show\`, \`git diff\`, or review "the latest commit" — the target is the listed files as they exist on disk now, regardless of which commit touched them. ANY finding whose \`surface\` is not one of the listed files above is OUT OF SCOPE and INVALID — discard it. If you cannot read the listed files, say so explicitly in verdict_basis; do NOT substitute a different target. External web research (industry-leader repos, eng blogs, specs) is required and unrestricted — only the CODE-under-attack is locked to the list.

ALREADY FIXED IN PRIOR ROUNDS (do not re-report these as new; attack what remains, and attack whether the fixes themselves opened new holes):
${prior}

Procedure: (1) Read the listed target files (and only those). (2) Select the interrogation batteries the surfaces demand and fire them. (3) Run real web searches for prior art — open the named industry-leader/OSS repos, read the matching code, cite repo@sha:file:line; read eng blogs/specs, cite URLs. (4) Walk the hunt catalogue and the project's operating rules / non-negotiables against the listed files. (5) Return structured findings, each with a \`surface\` that is one of the listed files at file:line, EXTERNAL evidence read this run, tagged with the negation goal it lands on, with a concrete fix_required. (6) Set verdict: PROVED_JUNIOR if you landed any evidence-backed CRITICAL/MAJOR on a listed file (name the single biggest hole), else COULD_NOT_DISPROVE_SENIOR (list what you actually tried per axis). Do NOT rubber-stamp and do NOT invent findings — only evidence-backed claims on the listed files count.`
}

phase('Negate')
const results = await parallel([
  () => agent(negatorPrompt(1), { label: `negator-1·it${iteration}`, phase: 'Negate', schema: NEGATOR_SCHEMA, agentType: 'general-purpose' }),
  () => agent(negatorPrompt(2), { label: `negator-2·it${iteration}`, phase: 'Negate', schema: NEGATOR_SCHEMA, agentType: 'general-purpose' }),
  () => agent(negatorPrompt(3), { label: `negator-3·it${iteration}`, phase: 'Negate', schema: NEGATOR_SCHEMA, agentType: 'general-purpose' }),
])

const negators = results.map((r, i) => ({ n: i + 1, r })).filter((x) => x.r)
const allFindings = negators.flatMap((x) => (x.r.findings || []).map((f) => ({ ...f, negator: x.n })))
const bySeverity = (s) => allFindings.filter((f) => f.severity === s)
const critical = bySeverity('CRITICAL')
const major = bySeverity('MAJOR')
const minor = bySeverity('MINOR')
const anyCriticalOrMajor = critical.length + major.length > 0

return {
  iteration,
  iterationVerdict: anyCriticalOrMajor ? 'PROVED_JUNIOR — revise and re-run' : 'SURVIVED — no CRITICAL/MAJOR landed this round',
  counts: { critical: critical.length, major: major.length, minor: minor.length, negatorsReturned: negators.length },
  critical,
  major,
  minor,
  verdicts: negators.map((x) => ({ negator: x.n, verdict: x.r.verdict, basis: x.r.verdict_basis })),
  research: negators.map((x) => ({ negator: x.n, research_done: x.r.research_done })),
}
