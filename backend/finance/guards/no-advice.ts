// ─────────────────────────────────────────────────────────────────────────
// No-advice guard. The regulatory bright line (SEC/FINRA + India SEBI) is
// PERSONALIZATION + DIRECTIVE, not topic: impersonal, security-specific analysis is
// protected publisher content; a reader-directed "you should buy X" is regulated advice.
//
// So the boundary, made mechanical: BLOCK a second-person/imperative transaction directive;
// ALLOW scenario framing ("bull case: if X holds above…") and invalidation levels. This is a
// deterministic lexicon pass (Layer A from the blueprint); an LLM judge (Layer B) can sit
// behind it for the chat path, but the cheap regex catches the obvious failures for $0.
// ─────────────────────────────────────────────────────────────────────────

export type Severity = "ok" | "warn" | "block";
export type AdviceFinding = { rule: string; match: string };

const TXN = "buy|sell|short|sell off|dump|load up on|exit|get out of|get into|add to|trim|accumulate|hold";

// Reader-directed transaction directives → BLOCK.
const BLOCK_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: "you-should-transact", re: new RegExp(`\\byou\\s+(should|must|need to|ought to|have to|are advised to|gotta)\\s+(${TXN})\\b`, "i") },
  { rule: "i-recommend-transact", re: /\bI\s+(recommend|advise|suggest)\s+(buying|selling|shorting|holding|you\s)/i },
  { rule: "we-recommend-transact", re: /\bwe\s+(recommend|advise)\s+(buying|selling|shorting|holding|that you)\b/i },
  { rule: "imperative-allocate", re: /\b(put|allocate|invest|move)\s+\d+\s?%?\s+(of your|into)\b/i },
  // Imperative-anchored only (sentence start / after a colon / "to ___") so descriptive prose
  // like "buyers stepped in this morning" doesn't false-positive; "Buy the dip." does.
  { rule: "directive-transact-now", re: new RegExp(`(?:^|[.!?:]\\s+|\\bto\\s+)(${TXN})\\s+(it|these|now|the dip)\\b`, "i") },
  { rule: "personalized-portfolio", re: /\byour\s+(portfolio|holdings?|position)\s+(should|must|needs? to)\b/i },
];

// Advice-adjacent phrasing → WARN (not block); useful as a signal to escalate to an LLM judge.
const WARN_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: "best-to-buy", re: /\b(best|top)\s+(stock|coin|crypto|investment|etf)s?\s+to\s+(buy|invest|own)\b/i },
  { rule: "consider-transacting", re: /\byou\s+(might|may|could)\s+(want to\s+)?(consider|think about)\s+(buying|selling|shorting)\b/i },
  { rule: "price-target-you", re: /\b(target|price target)\s+(for you|you should)\b/i },
];

export function checkNoAdvice(text: string): { severity: Severity; findings: AdviceFinding[] } {
  const findings: AdviceFinding[] = [];
  for (const p of BLOCK_PATTERNS) {
    const m = text.match(p.re);
    if (m) findings.push({ rule: p.rule, match: m[0] });
  }
  if (findings.length) return { severity: "block", findings };
  for (const p of WARN_PATTERNS) {
    const m = text.match(p.re);
    if (m) findings.push({ rule: p.rule, match: m[0] });
  }
  return { severity: findings.length ? "warn" : "ok", findings };
}
