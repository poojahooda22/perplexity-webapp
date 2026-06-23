// ─────────────────────────────────────────────────────────────────────────
// Numeric grounding — the runtime arm of "never invent a number". Extracts numerals
// from generated prose and diffs them against the set of numbers the TOOLS actually
// returned (the evidence). A number in prose that isn't in the evidence is ungrounded —
// it may be a fabrication and should be flagged (and, on the chat path, stripped).
//
// Lookbehind excludes inline [n] citation markers. Years (19xx/20xx) and single digits are
// ignored. This is deliberately conservative: better to flag a real number than to miss a fake.
// ─────────────────────────────────────────────────────────────────────────

const NUM_RE = /(?<!\[)\b\d[\d,]*\.?\d*\s?%?/g;

export function extractNumbers(text: string): string[] {
  return (text.match(NUM_RE) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !/^(19|20)\d{2}$/.test(s));
}

// Normalize for comparison: drop spaces + thousands separators so "7,472.79" == "7472.79".
function norm(n: string): string {
  return n.replace(/[\s,]/g, "");
}

// Build the allowed set from evidence numbers (each in any string form).
export function allowedNumberSet(values: Array<number | string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const v of values) {
    if (v == null) continue;
    set.add(norm(String(v)));
    if (typeof v === "number") {
      set.add(norm(v.toFixed(2)));
      set.add(norm(String(Math.round(v))));
      set.add(norm(String(Math.abs(v))));
    }
  }
  return set;
}

// Numbers present in the prose but absent from the allowed evidence set.
export function ungroundedNumbers(text: string, allowed: Set<string>): string[] {
  return extractNumbers(text).filter((n) => !allowed.has(norm(n)));
}
