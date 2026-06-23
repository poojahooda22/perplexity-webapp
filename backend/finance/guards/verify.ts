// ─────────────────────────────────────────────────────────────────────────
// verifyFinancePresentation() — the single guard entry point that runs on generated
// finance prose BEFORE it is cached / streamed-to-persistence. Combines the no-advice
// lexicon (no-advice.ts) with the numeric-grounding diff (numeric-grounding.ts).
//
//   severity "ok"    → safe to cache/serve as-is
//   severity "warn"  → advice-adjacent OR a few ungrounded numbers — log + (on chat) annotate
//   severity "block" → a reader-directed transaction directive — regenerate / redact
//
// The blueprint's Layer-B LLM judge can be slotted in here behind the cheap deterministic
// pass; the regex handles the obvious cases at $0.
// ─────────────────────────────────────────────────────────────────────────

import { checkNoAdvice, type AdviceFinding, type Severity } from "./no-advice.js";
import { ungroundedNumbers } from "./numeric-grounding.js";

export type GuardResult = {
  severity: Severity;
  advice: AdviceFinding[];
  ungrounded: string[];
};

export function verifyFinancePresentation(text: string, allowedNumbers?: Set<string>): GuardResult {
  const advice = checkNoAdvice(text);
  const ungrounded = allowedNumbers ? ungroundedNumbers(text, allowedNumbers) : [];

  let severity: Severity = advice.severity;
  // More than a couple of ungrounded numbers escalates an otherwise-clean answer to warn.
  if (severity === "ok" && ungrounded.length > 2) severity = "warn";

  return { severity, advice: advice.findings, ungrounded };
}

export { checkNoAdvice } from "./no-advice.js";
export { allowedNumberSet, ungroundedNumbers, extractNumbers } from "./numeric-grounding.js";
