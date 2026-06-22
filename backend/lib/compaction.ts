// ─────────────────────────────────────────────────────────────────────────
// Conversation compaction — keep follow-ups fast on long threads.
//
// Sending the whole raw transcript every follow-up grows tokens without bound and eventually
// blows the context window. Instead we (1) strip the <SOURCES>/<IMAGES> blobs we appended for the
// UI, (2) keep the last few turns verbatim, and (3) fold everything older into a one-shot summary
// (cheap model). The summary is returned separately so the caller can put it in the SYSTEM prompt —
// keeping the `messages` array a clean user/assistant alternation.
//
// The short-thread path is pure (no LLM). The long-thread path calls a cheap model and is
// FAIL-SOFT: on summarize error it falls back to recent-turns-only (still bounded).
// ─────────────────────────────────────────────────────────────────────────
import { generateText } from "ai";

import { stripWireTail } from "./wire.js";

export const KEEP_RECENT_MESSAGES = 6; // ≈ last 3 turns sent verbatim
export const SUMMARY_MODEL = "anthropic/claude-haiku-4.5"; // fast + cheap for compaction

export async function buildConversationHistory(
  messages: Array<{ role: "user" | "Assistant"; content: string }>,
): Promise<{ summary: string | null; history: Array<{ role: "user" | "assistant"; content: string }> }> {
  // Normalize roles (DB enum 'Assistant' -> 'assistant') and strip UI blobs.
  const turns = messages.map((m) => ({
    role: m.role === "Assistant" ? ("assistant" as const) : ("user" as const),
    content: stripWireTail(m.content),
  }));

  // Short thread: send verbatim, no summary, no extra cost.
  if (turns.length <= KEEP_RECENT_MESSAGES) return { summary: null, history: turns };

  // Long thread: keep the last N verbatim, summarize everything older.
  const older = turns.slice(0, turns.length - KEEP_RECENT_MESSAGES);
  let recent = turns.slice(turns.length - KEEP_RECENT_MESSAGES);
  // Anthropic requires the first message to be a 'user' turn — drop any leading assistant.
  while (recent[0]?.role === "assistant") recent = recent.slice(1);

  const transcript = older
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
  try {
    const { text } = await generateText({
      model: SUMMARY_MODEL,
      system:
        "You compress conversations. Summarize the exchange below, preserving key facts, " +
        "named entities, the user's goals, and any decisions needed to answer future " +
        "follow-ups. Be concise; bullet points are fine. Do not invent anything.",
      prompt: transcript,
    });
    return { summary: text.trim(), history: recent };
  } catch (e) {
    // Best-effort: on failure fall back to recent turns only (still bounded) rather than failing
    // the request or resending the whole transcript.
    console.error("[compaction] summarize failed:", e instanceof Error ? e.message : String(e));
    return { summary: null, history: recent };
  }
}
