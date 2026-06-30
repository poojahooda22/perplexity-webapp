---
name: No Background Agents
description: NEVER use background/parallel agents. The operator wants Claude to do ALL work personally, line by line.
type: feedback
---

NEVER use background agents or parallel subagents. Do everything yourself, personally, line by line.

**Why:** The operator explicitly demanded this multiple times. They want to see Claude's own analysis, not delegated work from subagents. Using agents reads as shirking responsibility.

**How to apply:** Every audit, every code review, every file read — do it yourself in the main conversation. No `Agent` tool calls with `run_in_background: true`. No parallel agent dispatches. The only exception would be if the operator explicitly asks for parallel execution.
