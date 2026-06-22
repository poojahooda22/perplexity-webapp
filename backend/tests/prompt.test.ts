import { describe, expect, test } from "bun:test";

import { buildSystemPrompt, buildUserPrompt, classifyQuery, PERSONA } from "../prompt";

describe("classifyQuery", () => {
  test("compare", () => {
    expect(classifyQuery("React vs Vue")).toBe("compare");
    expect(classifyQuery("difference between SQL and NoSQL")).toBe("compare");
  });
  test("latest", () => {
    expect(classifyQuery("latest iPhone news")).toBe("latest");
  });
  test("howto", () => {
    expect(classifyQuery("how to set up Docker")).toBe("howto");
  });
  test("definition", () => {
    expect(classifyQuery("what is a monad")).toBe("definition");
  });
  test("general fallback", () => {
    expect(classifyQuery("thoughts on Renaissance art")).toBe("general");
  });
});

describe("buildSystemPrompt", () => {
  test("general → persona only", () => {
    expect(buildSystemPrompt("general")).toBe(PERSONA);
  });
  test("non-general → persona + the matching playbook", () => {
    const p = buildSystemPrompt("compare");
    expect(p.startsWith(PERSONA)).toBe(true);
    expect(p).toContain("COMPARISON");
  });
});

describe("buildUserPrompt", () => {
  test("includes the date, the numbered context, and the question", () => {
    const u = buildUserPrompt({ query: "MyQuestion", searchContext: "MyContext", date: "2026-06-22" });
    expect(u).toContain("2026-06-22");
    expect(u).toContain("MyContext");
    expect(u).toContain("MyQuestion");
  });
});
