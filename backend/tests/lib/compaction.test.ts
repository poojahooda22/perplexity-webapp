import { describe, expect, test } from "bun:test";

import { buildConversationHistory } from "../../lib/compaction";

// The SHORT-thread path is pure (no LLM call) — covered here. The long-thread summarize path
// calls generateText and is exercised in the Tier-2 mocked-AI suite.
describe("buildConversationHistory (short thread — pure path)", () => {
  test("returns turns verbatim with no summary when <= KEEP_RECENT_MESSAGES", async () => {
    const { summary, history } = await buildConversationHistory([
      { role: "user", content: "hi" },
      { role: "Assistant", content: "hello\n<SOURCES>\n[]\n<SOURCES>\n" },
    ]);
    expect(summary).toBeNull();
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }, // wire tail stripped, role normalized
    ]);
  });

  test("normalizes the DB 'Assistant' role to lowercase 'assistant'", async () => {
    const { history } = await buildConversationHistory([{ role: "Assistant", content: "x" }]);
    expect(history[0]!.role).toBe("assistant");
  });
});