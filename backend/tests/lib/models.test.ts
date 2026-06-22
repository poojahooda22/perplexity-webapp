import { describe, expect, test } from "bun:test";

import { ALLOWED_MODELS, DEFAULT_MODEL, resolveModel } from "../../lib/models";

describe("resolveModel", () => {
  test("passes through an allowlisted model id", () => {
    expect(resolveModel("anthropic/claude-opus-4.7")).toBe("anthropic/claude-opus-4.7");
  });

  test("falls back to the default for unknown or non-string input", () => {
    expect(resolveModel("evil/model")).toBe(DEFAULT_MODEL);
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModel(123)).toBe(DEFAULT_MODEL);
    expect(resolveModel(null)).toBe(DEFAULT_MODEL);
  });

  test("the default model is itself allowlisted", () => {
    expect(ALLOWED_MODELS.has(DEFAULT_MODEL)).toBe(true);
  });
});