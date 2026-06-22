import { describe, expect, test } from "bun:test";

import { isTimeSensitive } from "../../lib/query-policy";

describe("isTimeSensitive", () => {
  test("flags price / news / today / year queries (never cache these)", () => {
    for (const q of [
      "AAPL stock price",
      "latest news on AI",
      "what happened today",
      "events in 2025",
      "bitcoin price right now",
    ]) {
      expect(isTimeSensitive(q)).toBe(true);
    }
  });

  test("does not flag evergreen queries (cacheable)", () => {
    for (const q of ["how does TCP work", "explain monads", "best way to learn rust"]) {
      expect(isTimeSensitive(q)).toBe(false);
    }
  });
});