import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { createRateLimiter } from "../../lib/user-rate-limit";

describe("createRateLimiter (sliding window)", () => {
  beforeEach(() => setSystemTime(new Date("2026-01-01T00:00:00.000Z")));
  afterEach(() => setSystemTime()); // restore the real clock

  test("allows up to the limit, then blocks", () => {
    const limited = createRateLimiter(3, 60_000);
    expect(limited("u")).toBe(false); // 1
    expect(limited("u")).toBe(false); // 2
    expect(limited("u")).toBe(false); // 3
    expect(limited("u")).toBe(true); //  4 → over
  });

  test("isolates users (each has its own window)", () => {
    const limited = createRateLimiter(1, 60_000);
    expect(limited("a")).toBe(false);
    expect(limited("a")).toBe(true);
    expect(limited("b")).toBe(false); // different user
  });

  test("window slides — hits older than the window expire", () => {
    const limited = createRateLimiter(1, 60_000);
    expect(limited("u")).toBe(false);
    expect(limited("u")).toBe(true);
    setSystemTime(new Date("2026-01-01T00:01:01.000Z")); // +61s
    expect(limited("u")).toBe(false); // window cleared
  });
});