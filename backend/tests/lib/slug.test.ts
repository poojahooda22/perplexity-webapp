import { describe, expect, test } from "bun:test";

import { slugify } from "../../lib/slug";

describe("slugify", () => {
  test("lowercases, hyphenates, strips punctuation, and adds an 8-hex suffix", () => {
    expect(slugify("Best way to learn Rust?")).toMatch(/^best-way-to-learn-rust-[a-f0-9]{8}$/);
  });

  test("falls back to 'conversation' for empty / symbol-only input", () => {
    expect(slugify("!!!")).toMatch(/^conversation-[a-f0-9]{8}$/);
    expect(slugify("   ")).toMatch(/^conversation-[a-f0-9]{8}$/);
  });

  test("caps the slug base at 60 chars", () => {
    const s = slugify("a".repeat(200));
    const base = s.slice(0, s.lastIndexOf("-"));
    expect(base.length).toBeLessThanOrEqual(60);
  });

  test("unique suffix → identical input yields different slugs", () => {
    expect(slugify("hello world")).not.toBe(slugify("hello world"));
  });
});