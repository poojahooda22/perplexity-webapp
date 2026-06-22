// Time-sensitive queries must NEVER be served from the semantic cache (prices, news, "today"…),
// so the cache is skipped entirely for them — no read, no write. Critical for finance. Pure.
export const TIME_SENSITIVE =
  /\b(today|now|currently|current|latest|live|breaking|news|price|prices|stock|stocks|score|scores|weather|tonight|right now|this (week|month|year)|yesterday|tomorrow|202\d)\b/i;

export function isTimeSensitive(query: string): boolean {
  return TIME_SENSITIVE.test(query);
}