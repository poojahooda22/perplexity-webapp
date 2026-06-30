# Inter-Agent Communication Protocol

> **Status.** Topical — applies only when working with another agent (Claude ↔ Gemini, Claude ↔ Cursor, Claude ↔ Codex, multi-Claude session). Not always-loaded; read this file at the start of any multi-agent task.
>
> **Loading.** Read when the work involves more than one agent operating on shared state — handing off to another agent, receiving a hand-off, auditing another agent's output, or coordinating parallel work.

---

## Mechanics

- **Agent A → Agent B:** Write messages to `agent-a-to-b.jsonl`. Agent B reads this file.
- **Agent B → Agent A:** Read messages from `agent-b-to-a.jsonl`. Agent A writes this file.
- **Shared context:** Both agents read and write `SHARED_CONTEXT.md` to share current problem state, decisions, and progress.

---

## Real Synergy Discipline (mandatory — this is what separates a coordinated team from a noisy one)

- **Pass real context to the next agent.** No summarizing that drops load-bearing details. If the next agent needs the full picture to do their job, give it to them. Withholding context to look smarter is sabotage.

- **Welcome rebuttal.** When another agent audits your work and finds a real problem, the right response is "they caught something real — here is the corrected answer." Not defensiveness. Not re-framing to save face. The team's credibility is worth more than any seat's ego.

- **Rebut with evidence, not status.** When you audit another agent's work, the rejection must come with research. "Because I said so" is not an argument. "Because here are three production codebases that do it differently for these documented reasons" is an argument. Appeal to authority is junior work. See `accepting-audits.md` for the full rebuttal format and `cynical-charter.md` for the hunt posture that produces those rejections.

- **Separate the concern from the fix.** When another agent raises a valid concern with a wrong fix, the concern is still valid intelligence. Honor it. Devise a better fix. Do not throw the concern out because the proposed fix was flawed.

- **Be honest about what you do not know.** "I have not verified this" is a higher-rigor statement than a confident guess. The team cannot coordinate on hallucinated facts.

---

## The Job

The job is not to win arguments. The job is to make sure the team ships the right answer.

When the team disagrees, the resolution path is:
1. Both agents state their position with evidence.
2. The shared `SHARED_CONTEXT.md` records the disagreement and the evidence on both sides.
3. If still unresolved, the operator makes the call.

Never hide a disagreement to look unified. Document it.
