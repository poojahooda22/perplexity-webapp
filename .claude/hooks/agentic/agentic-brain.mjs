#!/usr/bin/env node
// Agentic Brain — UserPromptSubmit hook, fires on EVERY prompt.
//
// PROJECT-AGNOSTIC. Injects senior agent operating discipline into the turn so
// the model runs an iterative tool loop, manages context, and follows
// disciplined engineering conventions instead of answering in one pass. The
// directive scales to the prompt: a tight core always, plus tool and context
// guidance when the prompt signals tool-heavy or long-horizon work. Output is
// tagged so it is visible in context. No project name appears here.
//
// Contract: reads the UserPromptSubmit JSON on stdin, writes a
// hookSpecificOutput.additionalContext payload on stdout. Trivial prompts are a
// no-op so short confirmations stay clean.

const MIN_PROMPT_LENGTH = 12

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk

const trimmed = stdin.trim()
if (!trimmed) { process.stdout.write('{}'); process.exit(0) }

let input
try { input = JSON.parse(trimmed) } catch { process.stdout.write('{}'); process.exit(0) }

const prompt = (input.prompt || input.message || '').trim()
if (prompt.length < MIN_PROMPT_LENGTH) { process.stdout.write('{}'); process.exit(0) }

const p = prompt.toLowerCase()
const toolHeavy = /\b(search|find|read|grep|edit|write|refactor|debug|build|run|test|migrate|audit|implement|fix|deploy|trace)\b/.test(p)
const longHorizon = prompt.length > 280 || /\b(plan|design|architect|multi|several|steps|phase|then|after that|first.*then)\b/.test(p)

const core =
  'Operate with senior agent discipline this turn. A non-trivial task is iterative: gather the context an action needs before taking it, act through a tool, observe the result, then continue or stop when the goal is met, not when the obvious moves run out. Answer the question before editing or running anything, and state agree or disagree explicitly before describing changes. Never swallow a tool failure into a plausible-looking success, and never reach for an escape-hatch cast to dodge a real type error. Match effort to the question: a one-line answer for a one-line ask, full reasoning for an architectural one. When a system has more than one path, name which path you are changing before proposing it, since a fix correct for one path is often wrong for another.'

const parts = [core]
if (toolHeavy) {
  parts.push(
    'Tools: validated, typed inputs that fail loud at the boundary; run independent calls in parallel and only genuinely order-dependent calls in sequence; read a file in full before a wide-ranging edit rather than acting on a snippet; honor a terminal result and stop instead of taking another speculative turn.',
  )
}
if (longHorizon) {
  parts.push(
    'Context: keep summaries in working memory and load a thing in full only when the task reaches for it; pull a large reference in slices, never dump it whole; if the session grows long, fold older turns into a Goal / Constraints / Progress / Key Decisions / Next Steps checkpoint and keep recent turns verbatim, preserving exact paths, names, and error messages.',
  )
}

const additionalContext = `[agentic-brain] ${parts.join(' ')}`

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }),
)