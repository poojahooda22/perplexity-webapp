---
name: feedback_no_code_blocks_for_text
description: Never use code blocks or markdown tables for plain text explanations — they cause horizontal scroll and are unreadable in chat
type: feedback
---

Never put assembly instructions, recipes, or plain text explanations inside code blocks or markdown tables. They cause horizontal scrolling and are unreadable in the chat window.

**Why:** The operator explicitly called this out — "nobody can read that with a horizontal scroll." The chat renders code blocks with fixed width and scroll, making long text impossible to read.

**How to apply:** Use plain numbered lists, bold labels, and dashes for structured info. Reserve code blocks ONLY for actual code (TypeScript, shell commands, etc.). Tables are fine only if columns are short enough to fit without scrolling.
