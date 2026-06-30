# Agent-Native Architecture

> Consolidated from agent-native-architecture (15 files). Zero-value-loss.

---

## Source: agent-native-architecture / SKILL.md


<why_now>
## Why Now

Software agents work reliably now. Claude Code demonstrated that an LLM with access to bash and file tools, operating in a loop until an objective is achieved, can accomplish complex multi-step tasks autonomously.

The surprising discovery: **a really good coding agent is actually a really good general-purpose agent.** The same architecture that lets Claude Code refactor a codebase can let an agent organize your files, manage your reading list, or automate your workflows.

The Claude Code SDK makes this accessible. You can build applications where features aren't code you write—they're outcomes you describe, achieved by an agent with tools, operating in a loop until the outcome is reached.

This opens up a new field: software that works the way Claude Code works, applied to categories far beyond coding.
</why_now>

<core_principles>
## Core Principles

### 1. Parity

**Whatever the user can do through the UI, the agent should be able to achieve through tools.**

This is the foundational principle. Without it, nothing else matters.

Imagine you build a notes app with a beautiful interface for creating, organizing, and tagging notes. A user asks the agent: "Create a note summarizing my meeting and tag it as urgent."

If you built UI for creating notes but no agent capability to do the same, the agent is stuck. It might apologize or ask clarifying questions, but it can't help—even though the action is trivial for a human using the interface.

**The fix:** Ensure the agent has tools (or combinations of tools) that can accomplish anything the UI can do.

This isn't about creating a 1:1 mapping of UI buttons to tools. It's about ensuring the agent can **achieve the same outcomes**. Sometimes that's a single tool (`create_note`). Sometimes it's composing primitives (`write_file` to a notes directory with proper formatting).

**The discipline:** When adding any UI capability, ask: can the agent achieve this outcome? If not, add the necessary tools or primitives.

A capability map helps:

| User Action | How Agent Achieves It |
|-------------|----------------------|
| Create a note | `write_file` to notes directory, or `create_note` tool |
| Tag a note as urgent | `update_file` metadata, or `tag_note` tool |
| Search notes | `search_files` or `search_notes` tool |
| Delete a note | `delete_file` or `delete_note` tool |

**The test:** Pick any action a user can take in your UI. Describe it to the agent. Can it accomplish the outcome?


### 3. Composability

**With atomic tools and parity, you can create new features just by writing new prompts.**

This is the payoff of the first two principles. When your tools are atomic and the agent can do anything users can do, new features are just new prompts.

Want a "weekly review" feature that summarizes activity and suggests priorities? That's a prompt:

```
"Review files modified this week. Summarize key changes. Based on
incomplete items and approaching deadlines, suggest three priorities
for next week."
```

The agent uses `list_files`, `read_file`, and its judgment to accomplish this. You didn't write weekly-review code. You described an outcome, and the agent operates in a loop until it's achieved.

**This works for developers and users.** You can ship new features by adding prompts. Users can customize behavior by modifying prompts or creating their own. "When I say 'file this,' always move it to my Action folder and tag it urgent" becomes a user-level prompt that extends the application.

**The constraint:** This only works if tools are atomic enough to be composed in ways you didn't anticipate, and if the agent has parity with users. If tools encode too much logic, or the agent can't access key capabilities, composition breaks down.

**The test:** Can you add a new feature by writing a new prompt section, without adding new code?


### 5. Improvement Over Time

**Agent-native applications get better through accumulated context and prompt refinement.**

Unlike traditional software, agent-native applications can improve without shipping code:

**Accumulated context:** The agent can maintain state across sessions—what exists, what the user has done, what worked, what didn't. A `context.md` file the agent reads and updates is layer one. More sophisticated approaches involve structured memory and learned preferences.

**Prompt refinement at multiple levels:**
- **Developer level:** You ship updated prompts that change agent behavior for all users
- **User level:** Users customize prompts for their workflow
- **Agent level:** The agent modifies its own prompts based on feedback (advanced)

**Self-modification (advanced):** Agents that can edit their own prompts or even their own code. For production use cases, consider adding safety rails—approval gates, automatic checkpoints for rollback, health checks. This is where things are heading.

The improvement mechanisms are still being discovered. Context and prompt refinement are proven. Self-modification is emerging. What's clear: the architecture supports getting better in ways traditional software doesn't.

**The test:** Does the application work better after a month of use than on day one, even without code changes?
</core_principles>

<intake>
## What aspect of agent-native architecture do you need help with?

1. **Design architecture** - Plan a new agent-native system from scratch
2. **Files & workspace** - Use files as the universal interface, shared workspace patterns
3. **Tool design** - Build primitive tools, dynamic capability discovery, CRUD completeness
4. **Domain tools** - Know when to add domain tools vs stay with primitives
5. **Execution patterns** - Completion signals, partial completion, context limits
6. **System prompts** - Define agent behavior in prompts, judgment criteria
7. **Context injection** - Inject runtime app state into agent prompts
8. **Action parity** - Ensure agents can do everything users can do
9. **Self-modification** - Enable agents to safely evolve themselves
10. **Product design** - Progressive disclosure, latent demand, approval patterns
11. **Mobile patterns** - iOS storage, background execution, checkpoint/resume
12. **Testing** - Test agent-native apps for capability and parity
13. **Refactoring** - Make existing code more agent-native

**Wait for response before proceeding.**
</intake>

<routing>
| Response | Action |
|----------|--------|
| 1, "design", "architecture", "plan" | Read [architecture-patterns.md](./references/architecture-patterns.md), then apply Architecture Checklist below |
| 2, "files", "workspace", "filesystem" | Read [files-universal-interface.md](./references/files-universal-interface.md) and [shared-workspace-architecture.md](./references/shared-workspace-architecture.md) |
| 3, "tool", "mcp", "primitive", "crud" | Read [mcp-tool-design.md](./references/mcp-tool-design.md) |
| 4, "domain tool", "when to add" | Read [from-primitives-to-domain-tools.md](./references/from-primitives-to-domain-tools.md) |
| 5, "execution", "completion", "loop" | Read [agent-execution-patterns.md](./references/agent-execution-patterns.md) |
| 6, "prompt", "system prompt", "behavior" | Read [system-prompt-design.md](./references/system-prompt-design.md) |
| 7, "context", "inject", "runtime", "dynamic" | Read [dynamic-context-injection.md](./references/dynamic-context-injection.md) |
| 8, "parity", "ui action", "capability map" | Read [action-parity-discipline.md](./references/action-parity-discipline.md) |
| 9, "self-modify", "evolve", "git" | Read [self-modification.md](./references/self-modification.md) |
| 10, "product", "progressive", "approval", "latent demand" | Read [product-implications.md](./references/product-implications.md) |
| 11, "mobile", "ios", "android", "background", "checkpoint" | Read [mobile-patterns.md](./references/mobile-patterns.md) |
| 12, "test", "testing", "verify", "validate" | Read [agent-native-testing.md](./references/agent-native-testing.md) |
| 13, "review", "refactor", "existing" | Read [refactoring-to-prompt-native.md](./references/refactoring-to-prompt-native.md) |

**After reading the reference, apply those patterns to the user's specific context.**
</routing>

<architecture_checklist>
## Architecture Review Checklist

When designing an agent-native system, verify these **before implementation**:

### Core Principles
- [ ] **Parity:** Every UI action has a corresponding agent capability
- [ ] **Granularity:** Tools are primitives; features are prompt-defined outcomes
- [ ] **Composability:** New features can be added via prompts alone
- [ ] **Emergent Capability:** Agent can handle open-ended requests in your domain

### Tool Design
- [ ] **Dynamic vs Static:** For external APIs where agent should have full access, use Dynamic Capability Discovery
- [ ] **CRUD Completeness:** Every entity has create, read, update, AND delete
- [ ] **Primitives not Workflows:** Tools enable capability, don't encode business logic
- [ ] **API as Validator:** Use `z.string()` inputs when the API validates, not `z.enum()`

### Files & Workspace
- [ ] **Shared Workspace:** Agent and user work in same data space
- [ ] **context.md Pattern:** Agent reads/updates context file for accumulated knowledge
- [ ] **File Organization:** Entity-scoped directories with consistent naming

### Agent Execution
- [ ] **Completion Signals:** Agent has explicit `complete_task` tool (not heuristic detection)
- [ ] **Partial Completion:** Multi-step tasks track progress for resume
- [ ] **Context Limits:** Designed for bounded context from the start

### Context Injection
- [ ] **Available Resources:** System prompt includes what exists (files, data, types)
- [ ] **Available Capabilities:** System prompt documents tools with user vocabulary
- [ ] **Dynamic Context:** Context refreshes for long sessions (or provide `refresh_context` tool)

### UI Integration
- [ ] **Agent → UI:** Agent changes reflect in UI (shared service, file watching, or event bus)
- [ ] **No Silent Actions:** Agent writes trigger UI updates immediately
- [ ] **Capability Discovery:** Users can learn what agent can do

### Mobile (if applicable)
- [ ] **Checkpoint/Resume:** Handle iOS app suspension gracefully
- [ ] **iCloud Storage:** iCloud-first with local fallback for multi-device sync
- [ ] **Cost Awareness:** Model tier selection (Haiku/Sonnet/Opus)

**When designing architecture, explicitly address each checkbox in your plan.**
</architecture_checklist>

<quick_start>
## Quick Start: Build an Agent-Native Feature

**Step 1: Define atomic tools**
```typescript
const tools = [
  tool("read_file", "Read any file", { path: z.string() }, ...),
  tool("write_file", "Write any file", { path: z.string(), content: z.string() }, ...),
  tool("list_files", "List directory", { path: z.string() }, ...),
  tool("complete_task", "Signal task completion", { summary: z.string() }, ...),
];
```

**Step 2: Write behavior in the system prompt**
```markdown
## Your Responsibilities
When asked to organize content, you should:
1. Read existing files to understand the structure
2. Analyze what organization makes sense
3. Create/move files using your tools
4. Use your judgment about layout and formatting
5. Call complete_task when you're done

You decide the structure. Make it good.
```

**Step 3: Let the agent work in a loop**
```typescript
const result = await agent.run({
  prompt: userMessage,
  tools: tools,
  systemPrompt: systemPrompt,
  // Agent loops until it calls complete_task
});
```
</quick_start>

<reference_index>
## Reference Files

All references in `references/`:

**Core Patterns:**
- [architecture-patterns.md](./references/architecture-patterns.md) - Event-driven, unified orchestrator, agent-to-UI
- [files-universal-interface.md](./references/files-universal-interface.md) - Why files, organization patterns, context.md
- [mcp-tool-design.md](./references/mcp-tool-design.md) - Tool design, dynamic capability discovery, CRUD
- [from-primitives-to-domain-tools.md](./references/from-primitives-to-domain-tools.md) - When to add domain tools, graduating to code
- [agent-execution-patterns.md](./references/agent-execution-patterns.md) - Completion signals, partial completion, context limits
- [system-prompt-design.md](./references/system-prompt-design.md) - Features as prompts, judgment criteria

**Agent-Native Disciplines:**
- [dynamic-context-injection.md](./references/dynamic-context-injection.md) - Runtime context, what to inject
- [action-parity-discipline.md](./references/action-parity-discipline.md) - Capability mapping, parity workflow
- [shared-workspace-architecture.md](./references/shared-workspace-architecture.md) - Shared data space, UI integration
- [product-implications.md](./references/product-implications.md) - Progressive disclosure, latent demand, approval
- [agent-native-testing.md](./references/agent-native-testing.md) - Testing outcomes, parity tests

**Platform-Specific:**
- [mobile-patterns.md](./references/mobile-patterns.md) - iOS storage, checkpoint/resume, cost awareness
- [self-modification.md](./references/self-modification.md) - Git-based evolution, guardrails
- [refactoring-to-prompt-native.md](./references/refactoring-to-prompt-native.md) - Migrating existing code
</reference_index>

<anti_patterns>
## Anti-Patterns

### Common Approaches That Aren't Fully Agent-Native

These aren't necessarily wrong—they may be appropriate for your use case. But they're worth recognizing as different from the architecture this document describes.

**Agent as router** — The agent figures out what the user wants, then calls the right function. The agent's intelligence is used to route, not to act. This can work, but you're using a fraction of what agents can do.

**Build the app, then add agent** — You build features the traditional way (as code), then expose them to an agent. The agent can only do what your features already do. You won't get emergent capability.

**Request/response thinking** — Agent gets input, does one thing, returns output. This misses the loop: agent gets an outcome to achieve, operates until it's done, handles unexpected situations along the way.

**Defensive tool design** — You over-constrain tool inputs because you're used to defensive programming. Strict enums, validation at every layer. This is safe, but it prevents the agent from doing things you didn't anticipate.

**Happy path in code, agent just executes** — Traditional software handles edge cases in code—you write the logic for what happens when X goes wrong. Agent-native lets the agent handle edge cases with judgment. If your code handles all the edge cases, the agent is just a caller.


### The Ultimate Test

**Describe an outcome to the agent that's within your application's domain but that you didn't build a specific feature for.**

Can it figure out how to accomplish it, operating in a loop until it succeeds?

If yes, you've built something agent-native.

If it says "I don't have a feature for that"—your architecture is still too constrained.
</success_criteria>

---

## Source: agent-native-architecture/references / action-parity-discipline.md

<overview>
A structured discipline for ensuring agents can do everything users can do. Every UI action should have an equivalent agent tool. This isn't a one-time check—it's an ongoing practice integrated into your development workflow.

**Core principle:** When adding a UI feature, add the corresponding tool in the same PR.
</overview>

<why_parity>
## Why Action Parity Matters

**The failure case:**
```
User: "Write something about Catherine the Great in my reading feed"
Agent: "What system are you referring to? I'm not sure what reading feed means."
```

The user could publish to their feed through the UI. But the agent had no `publish_to_feed` tool. The fix was simple—add the tool. But the insight is profound:

**Every action a user can take through the UI must have an equivalent tool the agent can call.**

Without this parity:
- Users ask agents to do things they can't do
- Agents ask clarifying questions about features they should understand
- The agent feels limited compared to direct app usage
- Users lose trust in the agent's capabilities
</why_parity>

<capability_mapping>
## The Capability Map

Maintain a structured map of UI actions to agent tools:

| UI Action | UI Location | Agent Tool | System Prompt Reference |
|-----------|-------------|------------|-------------------------|
| View library | Library tab | `read_library` | "View books and highlights" |
| Add book | Library → Add | `add_book` | "Add books to library" |
| Publish insight | Analysis view | `publish_to_feed` | "Create insights for Feed tab" |
| Start research | Book detail | `start_research` | "Research books via web search" |
| Edit profile | Settings | `write_file(profile.md)` | "Update reading profile" |
| Take screenshot | Camera | N/A (user action) | — |
| Search web | Chat | `web_search` | "Search the internet" |

**Update this table whenever adding features.**

### Template for Your App

```markdown
# Capability Map - [Your App Name]

| UI Action | UI Location | Agent Tool | System Prompt | Status |
|-----------|-------------|------------|---------------|--------|
| | | | | ⚠️ Missing |
| | | | | ✅ Done |
| | | | | 🚫 N/A |
```

Status meanings:
- ✅ Done: Tool exists and is documented in system prompt
- ⚠️ Missing: UI action exists but no agent equivalent
- 🚫 N/A: User-only action (e.g., biometric auth, camera capture)
</capability_mapping>

<parity_workflow>
## The Action Parity Workflow

### When Adding a New Feature

Before merging any PR that adds UI functionality:

```
1. What action is this?
   → "User can publish an insight to their reading feed"

2. Does an agent tool exist for this?
   → Check tool definitions
   → If NO: Create the tool

3. Is it documented in the system prompt?
   → Check system prompt capabilities section
   → If NO: Add documentation

4. Is the context available?
   → Does agent know what "feed" means?
   → Does agent see available books?
   → If NO: Add to context injection

5. Update the capability map
   → Add row to tracking document
```

### PR Checklist

Add to your PR template:

```markdown
## Agent-Native Checklist

- [ ] Every new UI action has a corresponding agent tool
- [ ] System prompt updated to mention new capability
- [ ] Agent has access to same data UI uses
- [ ] Capability map updated
- [ ] Tested with natural language request
```
</parity_workflow>

<parity_audit>
## The Parity Audit

Periodically audit your app for action parity gaps:

### Step 1: List All UI Actions

Walk through every screen and list what users can do:

```
Library Screen:
- View list of books
- Search books
- Filter by category
- Add new book
- Delete book
- Open book detail

Book Detail Screen:
- View book info
- Start research
- View highlights
- Add highlight
- Share book
- Remove from library

Feed Screen:
- View insights
- Create new insight
- Edit insight
- Delete insight
- Share insight

Settings:
- Edit profile
- Change theme
- Export data
- Delete account
```

### Step 2: Check Tool Coverage

For each action, verify:

```
✅ View list of books      → read_library
✅ Search books            → read_library (with query param)
⚠️ Filter by category     → MISSING (add filter param to read_library)
⚠️ Add new book           → MISSING (need add_book tool)
✅ Delete book             → delete_book
✅ Open book detail        → read_library (single book)

✅ Start research          → start_research
✅ View highlights         → read_library (includes highlights)
⚠️ Add highlight          → MISSING (need add_highlight tool)
⚠️ Share book             → MISSING (or N/A if sharing is UI-only)

✅ View insights           → read_library (includes feed)
✅ Create new insight      → publish_to_feed
⚠️ Edit insight           → MISSING (need update_feed_item tool)
⚠️ Delete insight         → MISSING (need delete_feed_item tool)
```

### Step 3: Prioritize Gaps

Not all gaps are equal:

**High priority (users will ask for this):**
- Add new book
- Create/edit/delete content
- Core workflow actions

**Medium priority (occasional requests):**
- Filter/search variations
- Export functionality
- Sharing features

**Low priority (rarely requested via agent):**
- Theme changes
- Account deletion
- Settings that are UI-preference
</parity_audit>

<tool_design_for_parity>
## Designing Tools for Parity

### Match Tool Granularity to UI Granularity

If the UI has separate buttons for "Edit" and "Delete", consider separate tools:

```typescript
// Matches UI granularity
tool("update_feed_item", { id, content, headline }, ...);
tool("delete_feed_item", { id }, ...);

// vs. combined (harder for agent to discover)
tool("modify_feed_item", { id, action: "update" | "delete", ... }, ...);
```

### Use User Vocabulary in Tool Names

```typescript
// Good: Matches what users say
tool("publish_to_feed", ...);  // "publish to my feed"
tool("add_book", ...);         // "add this book"
tool("start_research", ...);   // "research this"

// Bad: Technical jargon
tool("create_analysis_record", ...);
tool("insert_library_item", ...);
tool("initiate_web_scrape_workflow", ...);
```

### Return What the UI Shows

If the UI shows a confirmation with details, the tool should too:

```typescript
// UI shows: "Added 'Moby Dick' to your library"
// Tool should return the same:
tool("add_book", async ({ title, author }) => {
  const book = await library.add({ title, author });
  return {
    text: `Added "${book.title}" by ${book.author} to your library (id: ${book.id})`
  };
});
```
</tool_design_for_parity>

<context_parity>
## Context Parity

Whatever the user sees, the agent should be able to access.

### The Problem

```swift
// UI shows recent analyses in a list
ForEach(analysisRecords) { record in
    AnalysisRow(record: record)
}

// But system prompt only mentions books, not analyses
let systemPrompt = """
## Available Books
\(books.map { $0.title })
// Missing: recent analyses!
"""
```

The user sees their reading journal. The agent doesn't. This creates a disconnect.

### The Fix

```swift
// System prompt includes what UI shows
let systemPrompt = """
## Available Books
\(books.map { "- \($0.title)" }.joined(separator: "\n"))

## Recent Reading Journal
\(analysisRecords.prefix(10).map { "- \($0.summary)" }.joined(separator: "\n"))
"""
```

### Context Parity Checklist

For each screen in your app:
- [ ] What data does this screen display?
- [ ] Is that data available to the agent?
- [ ] Can the agent access the same level of detail?
</context_parity>

<continuous_parity>
## Maintaining Parity Over Time

### Git Hooks / CI Checks

```bash
#!/bin/bash
# pre-commit hook: check for new UI actions without tools

# Find new SwiftUI Button/onTapGesture additions
NEW_ACTIONS=$(git diff --cached --name-only | xargs grep -l "Button\|onTapGesture")

if [ -n "$NEW_ACTIONS" ]; then
    echo "⚠️  New UI actions detected. Did you add corresponding agent tools?"
    echo "Files: $NEW_ACTIONS"
    echo ""
    echo "Checklist:"
    echo "  [ ] Agent tool exists for new action"
    echo "  [ ] System prompt documents new capability"
    echo "  [ ] Capability map updated"
fi
```

### Automated Parity Testing

```typescript
// parity.test.ts
describe('Action Parity', () => {
  const capabilityMap = loadCapabilityMap();

  for (const [action, toolName] of Object.entries(capabilityMap)) {
    if (toolName === 'N/A') continue;

    test(`${action} has agent tool: ${toolName}`, () => {
      expect(agentTools.map(t => t.name)).toContain(toolName);
    });

    test(`${toolName} is documented in system prompt`, () => {
      expect(systemPrompt).toContain(toolName);
    });
  }
});
```

### Regular Audits

Schedule periodic reviews:

```markdown
## Monthly Parity Audit

1. Review all PRs merged this month
2. Check each for new UI actions
3. Verify tool coverage
4. Update capability map
5. Test with natural language requests
```
</continuous_parity>

<examples>
## Real Example: The Feed Gap

**Before:** Every Reader had a feed where insights appeared, but no agent tool to publish there.

```
User: "Write something about Catherine the Great in my reading feed"
Agent: "I'm not sure what system you're referring to. Could you clarify?"
```

**Diagnosis:**
- ✅ UI action: User can publish insights from the analysis view
- ❌ Agent tool: No `publish_to_feed` tool
- ❌ System prompt: No mention of "feed" or how to publish
- ❌ Context: Agent didn't know what "feed" meant

**Fix:**

```swift
// 1. Add the tool
tool("publish_to_feed",
    "Publish an insight to the user's reading feed",
    {
        bookId: z.string().describe("Book ID"),
        content: z.string().describe("The insight content"),
        headline: z.string().describe("A punchy headline")
    },
    async ({ bookId, content, headline }) => {
        await feedService.publish({ bookId, content, headline });
        return { text: `Published "${headline}" to your reading feed` };
    }
);

// 2. Update system prompt
"""
## Your Capabilities

- **Publish to Feed**: Create insights that appear in the Feed tab using `publish_to_feed`.
  Include a book_id, content, and a punchy headline.
"""

// 3. Add to context injection
"""
When the user mentions "the feed" or "reading feed", they mean the Feed tab
where insights appear. Use `publish_to_feed` to create content there.
"""
```

**After:**
```
User: "Write something about Catherine the Great in my reading feed"
Agent: [Uses publish_to_feed to create insight]
       "Done! I've published 'The Enlightened Empress' to your reading feed."
```
</examples>

<checklist>
## Action Parity Checklist

For every PR with UI changes:
- [ ] Listed all new UI actions
- [ ] Verified agent tool exists for each action
- [ ] Updated system prompt with new capabilities
- [ ] Added to capability map
- [ ] Tested with natural language request

For periodic audits:
- [ ] Walked through every screen
- [ ] Listed all possible user actions
- [ ] Checked tool coverage for each
- [ ] Prioritized gaps by likelihood of user request
- [ ] Created issues for high-priority gaps
</checklist>

---

## Source: agent-native-architecture/references / agent-execution-patterns.md

<overview>
Agent execution patterns for building robust agent loops. This covers how agents signal completion, track partial progress for resume, select appropriate model tiers, and handle context limits.
</overview>

<completion_signals>
## Completion Signals

Agents need an explicit way to say "I'm done."

### Anti-Pattern: Heuristic Detection

Detecting completion through heuristics is fragile:

- Consecutive iterations without tool calls
- Checking for expected output files
- Tracking "no progress" states
- Time-based timeouts

These break in edge cases and create unpredictable behavior.

### Pattern: Explicit Completion Tool

Provide a `complete_task` tool that:
- Takes a summary of what was accomplished
- Returns a signal that stops the loop
- Works identically across all agent types

```typescript
tool("complete_task", {
  summary: z.string().describe("Summary of what was accomplished"),
  status: z.enum(["success", "partial", "blocked"]).optional(),
}, async ({ summary, status = "success" }) => {
  return {
    text: summary,
    shouldContinue: false,  // Key: signals loop should stop
  };
});
```

### The ToolResult Pattern

Structure tool results to separate success from continuation:

```swift
struct ToolResult {
    let success: Bool           // Did tool succeed?
    let output: String          // What happened?
    let shouldContinue: Bool    // Should agent loop continue?
}

// Three common cases:
extension ToolResult {
    static func success(_ output: String) -> ToolResult {
        // Tool succeeded, keep going
        ToolResult(success: true, output: output, shouldContinue: true)
    }

    static func error(_ message: String) -> ToolResult {
        // Tool failed but recoverable, agent can try something else
        ToolResult(success: false, output: message, shouldContinue: true)
    }

    static func complete(_ summary: String) -> ToolResult {
        // Task done, stop the loop
        ToolResult(success: true, output: summary, shouldContinue: false)
    }
}
```

### Key Insight

**This is different from success/failure:**

- A tool can **succeed** AND signal **stop** (task complete)
- A tool can **fail** AND signal **continue** (recoverable error, try something else)

```typescript
// Examples:
read_file("/missing.txt")
// → { success: false, output: "File not found", shouldContinue: true }
// Agent can try a different file or ask for clarification

complete_task("Organized all downloads into folders")
// → { success: true, output: "...", shouldContinue: false }
// Agent is done

write_file("/output.md", content)
// → { success: true, output: "Wrote file", shouldContinue: true }
// Agent keeps working toward the goal
```

### System Prompt Guidance

Tell the agent when to complete:

```markdown
## Completing Tasks

When you've accomplished the user's request:
1. Verify your work (read back files you created, check results)
2. Call `complete_task` with a summary of what you did
3. Don't keep working after the goal is achieved

If you're blocked and can't proceed:
- Call `complete_task` with status "blocked" and explain why
- Don't loop forever trying the same thing
```
</completion_signals>

<partial_completion>
## Partial Completion

For multi-step tasks, track progress at the task level for resume capability.

### Task State Tracking

```swift
enum TaskStatus {
    case pending      // Not yet started
    case inProgress   // Currently working on
    case completed    // Finished successfully
    case failed       // Couldn't complete (with reason)
    case skipped      // Intentionally not done
}

struct AgentTask {
    let id: String
    let description: String
    var status: TaskStatus
    var notes: String?  // Why it failed, what was done
}

struct AgentSession {
    var tasks: [AgentTask]

    var isComplete: Bool {
        tasks.allSatisfy { $0.status == .completed || $0.status == .skipped }
    }

    var progress: (completed: Int, total: Int) {
        let done = tasks.filter { $0.status == .completed }.count
        return (done, tasks.count)
    }
}
```

### UI Progress Display

Show users what's happening:

```
Progress: 3/5 tasks complete (60%)
✅ [1] Find source materials
✅ [2] Download full text
✅ [3] Extract key passages
❌ [4] Generate summary - Error: context limit exceeded
⏳ [5] Create outline - Pending
```

### Partial Completion Scenarios

**Agent hits max iterations before finishing:**
- Some tasks completed, some pending
- Checkpoint saved with current state
- Resume continues from where it left off, not from beginning

**Agent fails on one task:**
- Task marked `.failed` with error in notes
- Other tasks may continue (agent decides)
- Orchestrator doesn't automatically abort entire session

**Network error mid-task:**
- Current iteration throws
- Session marked `.failed`
- Checkpoint preserves messages up to that point
- Resume possible from checkpoint

### Checkpoint Structure

```swift
struct AgentCheckpoint: Codable {
    let sessionId: String
    let agentType: String
    let messages: [Message]          // Full conversation history
    let iterationCount: Int
    let tasks: [AgentTask]           // Task state
    let customState: [String: Any]   // Agent-specific state
    let timestamp: Date

    var isValid: Bool {
        // Checkpoints expire (default 1 hour)
        Date().timeIntervalSince(timestamp) < 3600
    }
}
```

### Resume Flow

1. On app launch, scan for valid checkpoints
2. Show user: "You have an incomplete session. Resume?"
3. On resume:
   - Restore messages to conversation
   - Restore task states
   - Continue agent loop from where it left off
4. On dismiss:
   - Delete checkpoint
   - Start fresh if user tries again
</partial_completion>

<model_tier_selection>
## Model Tier Selection

Different agents need different intelligence levels. Use the cheapest model that achieves the outcome.

### Tier Guidelines

| Agent Type | Recommended Tier | Reasoning |
|------------|-----------------|-----------|
| Chat/Conversation | Balanced (Sonnet) | Fast responses, good reasoning |
| Research | Balanced (Sonnet) | Tool loops, not ultra-complex synthesis |
| Content Generation | Balanced (Sonnet) | Creative but not synthesis-heavy |
| Complex Analysis | Powerful (Opus) | Multi-document synthesis, nuanced judgment |
| Profile Generation | Powerful (Opus) | Photo analysis, complex pattern recognition |
| Quick Queries | Fast (Haiku) | Simple lookups, quick transformations |
| Simple Classification | Fast (Haiku) | High volume, simple decisions |

### Implementation

```swift
enum ModelTier {
    case fast      // claude-3-haiku: Quick, cheap, simple tasks
    case balanced  // claude-sonnet: Good balance for most tasks
    case powerful  // claude-opus: Complex reasoning, synthesis

    var modelId: String {
        switch self {
        case .fast: return "claude-3-haiku-20240307"
        case .balanced: return "claude-sonnet-4-20250514"
        case .powerful: return "claude-opus-4-20250514"
        }
    }
}

struct AgentConfig {
    let name: String
    let modelTier: ModelTier
    let tools: [AgentTool]
    let systemPrompt: String
    let maxIterations: Int
}

// Examples
let researchConfig = AgentConfig(
    name: "research",
    modelTier: .balanced,
    tools: researchTools,
    systemPrompt: researchPrompt,
    maxIterations: 20
)

let quickLookupConfig = AgentConfig(
    name: "lookup",
    modelTier: .fast,
    tools: [readLibrary],
    systemPrompt: "Answer quick questions about the user's library.",
    maxIterations: 3
)
```

### Cost Optimization Strategies

1. **Start with balanced, upgrade if quality insufficient**
2. **Use fast tier for tool-heavy loops** where each turn is simple
3. **Reserve powerful tier for synthesis tasks** (comparing multiple sources)
4. **Consider token limits per turn** to control costs
5. **Cache expensive operations** to avoid repeated calls
</model_tier_selection>

<context_limits>
## Context Limits

Agent sessions can extend indefinitely, but context windows don't. Design for bounded context from the start.

### The Problem

```
Turn 1: User asks question → 500 tokens
Turn 2: Agent reads file → 10,000 tokens
Turn 3: Agent reads another file → 10,000 tokens
Turn 4: Agent researches → 20,000 tokens
...
Turn 10: Context window exceeded
```

### Design Principles

**1. Tools should support iterative refinement**

Instead of all-or-nothing, design for summary → detail → full:

```typescript
// Good: Supports iterative refinement
tool("read_file", {
  path: z.string(),
  preview: z.boolean().default(true),  // Return first 1000 chars by default
  full: z.boolean().default(false),    // Opt-in to full content
}, ...);

tool("search_files", {
  query: z.string(),
  summaryOnly: z.boolean().default(true),  // Return matches, not full files
}, ...);
```

**2. Provide consolidation tools**

Give agents a way to consolidate learnings mid-session:

```typescript
tool("summarize_and_continue", {
  keyPoints: z.array(z.string()),
  nextSteps: z.array(z.string()),
}, async ({ keyPoints, nextSteps }) => {
  // Store summary, potentially truncate earlier messages
  await saveSessionSummary({ keyPoints, nextSteps });
  return { text: "Summary saved. Continuing with focus on: " + nextSteps.join(", ") };
});
```

**3. Design for truncation**

Assume the orchestrator may truncate early messages. Important context should be:
- In the system prompt (always present)
- In files (can be re-read)
- Summarized in context.md

### Implementation Strategies

```swift
class AgentOrchestrator {
    let maxContextTokens = 100_000
    let targetContextTokens = 80_000  // Leave headroom

    func shouldTruncate() -> Bool {
        estimateTokens(messages) > targetContextTokens
    }

    func truncateIfNeeded() {
        if shouldTruncate() {
            // Keep system prompt + recent messages
            // Summarize or drop older messages
            messages = [systemMessage] + summarizeOldMessages() + recentMessages
        }
    }
}
```

### System Prompt Guidance

```markdown
## Managing Context

For long tasks, periodically consolidate what you've learned:
1. If you've gathered a lot of information, summarize key points
2. Save important findings to files (they persist beyond context)
3. Use `summarize_and_continue` if the conversation is getting long

Don't try to hold everything in memory. Write it down.
```
</context_limits>

<orchestrator_pattern>
## Unified Agent Orchestrator

One execution engine, many agent types. All agents use the same orchestrator with different configurations.

```swift
class AgentOrchestrator {
    static let shared = AgentOrchestrator()

    func run(config: AgentConfig, userMessage: String) async -> AgentResult {
        var messages: [Message] = [
            .system(config.systemPrompt),
            .user(userMessage)
        ]

        var iteration = 0

        while iteration < config.maxIterations {
            // Get agent response
            let response = await claude.message(
                model: config.modelTier.modelId,
                messages: messages,
                tools: config.tools
            )

            messages.append(.assistant(response))

            // Process tool calls
            for toolCall in response.toolCalls {
                let result = await executeToolCall(toolCall, config: config)
                messages.append(.toolResult(result))

                // Check for completion signal
                if !result.shouldContinue {
                    return AgentResult(
                        status: .completed,
                        output: result.output,
                        iterations: iteration + 1
                    )
                }
            }

            // No tool calls = agent is responding, might be done
            if response.toolCalls.isEmpty {
                // Could be done, or waiting for user
                break
            }

            iteration += 1
        }

        return AgentResult(
            status: iteration >= config.maxIterations ? .maxIterations : .responded,
            output: messages.last?.content ?? "",
            iterations: iteration
        )
    }
}
```

### Benefits

- Consistent lifecycle management across all agent types
- Automatic checkpoint/resume (critical for mobile)
- Shared tool protocol
- Easy to add new agent types
- Centralized error handling and logging
</orchestrator_pattern>

<checklist>
## Agent Execution Checklist

### Completion Signals
- [ ] `complete_task` tool provided (explicit completion)
- [ ] No heuristic completion detection
- [ ] Tool results include `shouldContinue` flag
- [ ] System prompt guides when to complete

### Partial Completion
- [ ] Tasks tracked with status (pending, in_progress, completed, failed)
- [ ] Checkpoints saved for resume
- [ ] Progress visible to user
- [ ] Resume continues from where left off

### Model Tiers
- [ ] Tier selected based on task complexity
- [ ] Cost optimization considered
- [ ] Fast tier for simple operations
- [ ] Powerful tier reserved for synthesis

### Context Limits
- [ ] Tools support iterative refinement (preview vs full)
- [ ] Consolidation mechanism available
- [ ] Important context persisted to files
- [ ] Truncation strategy defined
</checklist>

---

## Source: agent-native-architecture/references / agent-native-testing.md

<overview>
Testing agent-native apps requires different approaches than traditional unit testing. You're testing whether the agent achieves outcomes, not whether it calls specific functions. This guide provides concrete testing patterns for verifying your app is truly agent-native.
</overview>

<testing_philosophy>
## Testing Philosophy

### Test Outcomes, Not Procedures

**Traditional (procedure-focused):**
```typescript
// Testing that a specific function was called with specific args
expect(mockProcessFeedback).toHaveBeenCalledWith({
  message: "Great app!",
  category: "praise",
  priority: 2
});
```

**Agent-native (outcome-focused):**
```typescript
// Testing that the outcome was achieved
const result = await agent.process("Great app!");
const storedFeedback = await db.feedback.getLatest();

expect(storedFeedback.content).toContain("Great app");
expect(storedFeedback.importance).toBeGreaterThanOrEqual(1);
expect(storedFeedback.importance).toBeLessThanOrEqual(5);
// We don't care exactly how it categorized—just that it's reasonable
```

### Accept Variability

Agents may solve problems differently each time. Your tests should:
- Verify the end state, not the path
- Accept reasonable ranges, not exact values
- Check for presence of required elements, not exact format
</testing_philosophy>

<can_agent_do_it_test>
## The "Can Agent Do It?" Test

For each UI feature, write a test prompt and verify the agent can accomplish it.

### Template

```typescript
describe('Agent Capability Tests', () => {
  test('Agent can add a book to library', async () => {
    const result = await agent.chat("Add 'Moby Dick' by Herman Melville to my library");

    // Verify outcome
    const library = await libraryService.getBooks();
    const mobyDick = library.find(b => b.title.includes("Moby Dick"));

    expect(mobyDick).toBeDefined();
    expect(mobyDick.author).toContain("Melville");
  });

  test('Agent can publish to feed', async () => {
    // Setup: ensure a book exists
    await libraryService.addBook({ id: "book_123", title: "1984" });

    const result = await agent.chat("Write something about surveillance themes in my feed");

    // Verify outcome
    const feed = await feedService.getItems();
    const newItem = feed.find(item => item.bookId === "book_123");

    expect(newItem).toBeDefined();
    expect(newItem.content.toLowerCase()).toMatch(/surveillance|watching|control/);
  });

  test('Agent can search and save research', async () => {
    await libraryService.addBook({ id: "book_456", title: "Moby Dick" });

    const result = await agent.chat("Research whale symbolism in Moby Dick");

    // Verify files were created
    const files = await fileService.listFiles("Research/book_456/");
    expect(files.length).toBeGreaterThan(0);

    // Verify content is relevant
    const content = await fileService.readFile(files[0]);
    expect(content.toLowerCase()).toMatch(/whale|symbolism|melville/);
  });
});
```

### The "Write to Location" Test

A key litmus test: can the agent create content in specific app locations?

```typescript
describe('Location Awareness Tests', () => {
  const locations = [
    { userPhrase: "my reading feed", expectedTool: "publish_to_feed" },
    { userPhrase: "my library", expectedTool: "add_book" },
    { userPhrase: "my research folder", expectedTool: "write_file" },
    { userPhrase: "my profile", expectedTool: "write_file" },
  ];

  for (const { userPhrase, expectedTool } of locations) {
    test(`Agent knows how to write to "${userPhrase}"`, async () => {
      const prompt = `Write a test note to ${userPhrase}`;
      const result = await agent.chat(prompt);

      // Check that agent used the right tool (or achieved the outcome)
      expect(result.toolCalls).toContainEqual(
        expect.objectContaining({ name: expectedTool })
      );

      // Or verify outcome directly
      // expect(await locationHasNewContent(userPhrase)).toBe(true);
    });
  }
});
```
</can_agent_do_it_test>

<surprise_test>
## The "Surprise Test"

A well-designed agent-native app lets the agent figure out creative approaches. Test this by giving open-ended requests.

### The Test

```typescript
describe('Agent Creativity Tests', () => {
  test('Agent can handle open-ended requests', async () => {
    // Setup: user has some books
    await libraryService.addBook({ id: "1", title: "1984", author: "Orwell" });
    await libraryService.addBook({ id: "2", title: "Brave New World", author: "Huxley" });
    await libraryService.addBook({ id: "3", title: "Fahrenheit 451", author: "Bradbury" });

    // Open-ended request
    const result = await agent.chat("Help me organize my reading for next month");

    // The agent should do SOMETHING useful
    // We don't specify exactly what—that's the point
    expect(result.toolCalls.length).toBeGreaterThan(0);

    // It should have engaged with the library
    const libraryTools = ["read_library", "write_file", "publish_to_feed"];
    const usedLibraryTool = result.toolCalls.some(
      call => libraryTools.includes(call.name)
    );
    expect(usedLibraryTool).toBe(true);
  });

  test('Agent finds creative solutions', async () => {
    // Don't specify HOW to accomplish the task
    const result = await agent.chat(
      "I want to understand the dystopian themes across my sci-fi books"
    );

    // Agent might:
    // - Read all books and create a comparison document
    // - Research dystopian literature and relate it to user's books
    // - Create a mind map in a markdown file
    // - Publish a series of insights to the feed

    // We just verify it did something substantive
    expect(result.response.length).toBeGreaterThan(100);
    expect(result.toolCalls.length).toBeGreaterThan(0);
  });
});
```

### What Failure Looks Like

```typescript
// FAILURE: Agent can only say it can't do that
const result = await agent.chat("Help me prepare for a book club discussion");

// Bad outcome:
expect(result.response).not.toContain("I can't");
expect(result.response).not.toContain("I don't have a tool");
expect(result.response).not.toContain("Could you clarify");

// If the agent asks for clarification on something it should understand,
// you have a context injection or capability gap
```
</surprise_test>

<parity_testing>
## Automated Parity Testing

Ensure every UI action has an agent equivalent.

### Capability Map Testing

```typescript
// capability-map.ts
export const capabilityMap = {
  // UI Action: Agent Tool
  "View library": "read_library",
  "Add book": "add_book",
  "Delete book": "delete_book",
  "Publish insight": "publish_to_feed",
  "Start research": "start_research",
  "View highlights": "read_library",  // same tool, different query
  "Edit profile": "write_file",
  "Search web": "web_search",
  "Export data": "N/A",  // UI-only action
};

// parity.test.ts
import { capabilityMap } from './capability-map';
import { getAgentTools } from './agent-config';
import { getSystemPrompt } from './system-prompt';

describe('Action Parity', () => {
  const agentTools = getAgentTools();
  const systemPrompt = getSystemPrompt();

  for (const [uiAction, toolName] of Object.entries(capabilityMap)) {
    if (toolName === 'N/A') continue;

    test(`"${uiAction}" has agent tool: ${toolName}`, () => {
      const toolNames = agentTools.map(t => t.name);
      expect(toolNames).toContain(toolName);
    });

    test(`${toolName} is documented in system prompt`, () => {
      expect(systemPrompt).toContain(toolName);
    });
  }
});
```

### Context Parity Testing

```typescript
describe('Context Parity', () => {
  test('Agent sees all data that UI shows', async () => {
    // Setup: create some data
    await libraryService.addBook({ id: "1", title: "Test Book" });
    await feedService.addItem({ id: "f1", content: "Test insight" });

    // Get system prompt (which includes context)
    const systemPrompt = await buildSystemPrompt();

    // Verify data is included
    expect(systemPrompt).toContain("Test Book");
    expect(systemPrompt).toContain("Test insight");
  });

  test('Recent activity is visible to agent', async () => {
    // Perform some actions
    await activityService.log({ action: "highlighted", bookId: "1" });
    await activityService.log({ action: "researched", bookId: "2" });

    const systemPrompt = await buildSystemPrompt();

    // Verify activity is included
    expect(systemPrompt).toMatch(/highlighted|researched/);
  });
});
```
</parity_testing>

<integration_testing>
## Integration Testing

Test the full flow from user request to outcome.

### End-to-End Flow Tests

```typescript
describe('End-to-End Flows', () => {
  test('Research flow: request → web search → file creation', async () => {
    // Setup
    const bookId = "book_123";
    await libraryService.addBook({ id: bookId, title: "Moby Dick" });

    // User request
    await agent.chat("Research the historical context of whaling in Moby Dick");

    // Verify: web search was performed
    const searchCalls = mockWebSearch.mock.calls;
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.some(call =>
      call[0].query.toLowerCase().includes("whaling")
    )).toBe(true);

    // Verify: files were created
    const researchFiles = await fileService.listFiles(`Research/${bookId}/`);
    expect(researchFiles.length).toBeGreaterThan(0);

    // Verify: content is relevant
    const content = await fileService.readFile(researchFiles[0]);
    expect(content.toLowerCase()).toMatch(/whale|whaling|nantucket|melville/);
  });

  test('Publish flow: request → tool call → feed update → UI reflects', async () => {
    // Setup
    await libraryService.addBook({ id: "book_1", title: "1984" });

    // Initial state
    const feedBefore = await feedService.getItems();

    // User request
    await agent.chat("Write something about Big Brother for my reading feed");

    // Verify feed updated
    const feedAfter = await feedService.getItems();
    expect(feedAfter.length).toBe(feedBefore.length + 1);

    // Verify content
    const newItem = feedAfter.find(item =>
      !feedBefore.some(old => old.id === item.id)
    );
    expect(newItem).toBeDefined();
    expect(newItem.content.toLowerCase()).toMatch(/big brother|surveillance|watching/);
  });
});
```

### Failure Recovery Tests

```typescript
describe('Failure Recovery', () => {
  test('Agent handles missing book gracefully', async () => {
    const result = await agent.chat("Tell me about 'Nonexistent Book'");

    // Agent should not crash
    expect(result.error).toBeUndefined();

    // Agent should acknowledge the issue
    expect(result.response.toLowerCase()).toMatch(
      /not found|don't see|can't find|library/
    );
  });

  test('Agent recovers from API failure', async () => {
    // Mock API failure
    mockWebSearch.mockRejectedValueOnce(new Error("Network error"));

    const result = await agent.chat("Research this topic");

    // Agent should handle gracefully
    expect(result.error).toBeUndefined();
    expect(result.response).not.toContain("unhandled exception");

    // Agent should communicate the issue
    expect(result.response.toLowerCase()).toMatch(
      /couldn't search|unable to|try again/
    );
  });
});
```
</integration_testing>

<snapshot_testing>
## Snapshot Testing for System Prompts

Track changes to system prompts and context injection over time.

```typescript
describe('System Prompt Stability', () => {
  test('System prompt structure matches snapshot', async () => {
    const systemPrompt = await buildSystemPrompt();

    // Extract structure (removing dynamic data)
    const structure = systemPrompt
      .replace(/id: \w+/g, 'id: [ID]')
      .replace(/"[^"]+"/g, '"[TITLE]"')
      .replace(/\d{4}-\d{2}-\d{2}/g, '[DATE]');

    expect(structure).toMatchSnapshot();
  });

  test('All capability sections are present', async () => {
    const systemPrompt = await buildSystemPrompt();

    const requiredSections = [
      "Your Capabilities",
      "Available Books",
      "Recent Activity",
    ];

    for (const section of requiredSections) {
      expect(systemPrompt).toContain(section);
    }
  });
});
```
</snapshot_testing>

<manual_testing>
## Manual Testing Checklist

Some things are best tested manually during development:

### Natural Language Variation Test

Try multiple phrasings for the same request:

```
"Add this to my feed"
"Write something in my reading feed"
"Publish an insight about this"
"Put this in the feed"
"I want this in my feed"
```

All should work if context injection is correct.

### Edge Case Prompts

```
"What can you do?"
→ Agent should describe capabilities

"Help me with my books"
→ Agent should engage with library, not ask what "books" means

"Write something"
→ Agent should ask WHERE (feed, file, etc.) if not clear

"Delete everything"
→ Agent should confirm before destructive actions
```

### Confusion Test

Ask about things that should exist but might not be properly connected:

```
"What's in my research folder?"
→ Should list files, not ask "what research folder?"

"Show me my recent reading"
→ Should show activity, not ask "what do you mean?"

"Continue where I left off"
→ Should reference recent activity if available
```
</manual_testing>

<ci_integration>
## CI/CD Integration

Add agent-native tests to your CI pipeline:

```yaml
# .github/workflows/test.yml
name: Agent-Native Tests

on: [push, pull_request]

jobs:
  agent-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup
        run: npm install

      - name: Run Parity Tests
        run: npm run test:parity

      - name: Run Capability Tests
        run: npm run test:capabilities
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Check System Prompt Completeness
        run: npm run test:system-prompt

      - name: Verify Capability Map
        run: |
          # Ensure capability map is up to date
          npm run generate:capability-map
          git diff --exit-code capability-map.ts
```

### Cost-Aware Testing

Agent tests cost API tokens. Strategies to manage:

```typescript
// Use smaller models for basic tests
const testConfig = {
  model: process.env.CI ? "claude-3-haiku" : "claude-3-opus",
  maxTokens: 500,  // Limit output length
};

// Cache responses for deterministic tests
const cachedAgent = new CachedAgent({
  cacheDir: ".test-cache",
  ttl: 24 * 60 * 60 * 1000,  // 24 hours
});

// Run expensive tests only on main branch
if (process.env.GITHUB_REF === 'refs/heads/main') {
  describe('Full Integration Tests', () => { ... });
}
```
</ci_integration>

<test_utilities>
## Test Utilities

### Agent Test Harness

```typescript
class AgentTestHarness {
  private agent: Agent;
  private mockServices: MockServices;

  async setup() {
    this.mockServices = createMockServices();
    this.agent = await createAgent({
      services: this.mockServices,
      model: "claude-3-haiku",  // Cheaper for tests
    });
  }

  async chat(message: string): Promise<AgentResponse> {
    return this.agent.chat(message);
  }

  async expectToolCall(toolName: string) {
    const lastResponse = this.agent.getLastResponse();
    expect(lastResponse.toolCalls.map(t => t.name)).toContain(toolName);
  }

  async expectOutcome(check: () => Promise<boolean>) {
    const result = await check();
    expect(result).toBe(true);
  }

  getState() {
    return {
      library: this.mockServices.library.getBooks(),
      feed: this.mockServices.feed.getItems(),
      files: this.mockServices.files.listAll(),
    };
  }
}

// Usage
test('full flow', async () => {
  const harness = new AgentTestHarness();
  await harness.setup();

  await harness.chat("Add 'Moby Dick' to my library");
  await harness.expectToolCall("add_book");
  await harness.expectOutcome(async () => {
    const state = harness.getState();
    return state.library.some(b => b.title.includes("Moby"));
  });
});
```
</test_utilities>

<checklist>
## Testing Checklist

Automated Tests:
- [ ] "Can Agent Do It?" tests for each UI action
- [ ] Location awareness tests ("write to my feed")
- [ ] Parity tests (tool exists, documented in prompt)
- [ ] Context parity tests (agent sees what UI shows)
- [ ] End-to-end flow tests
- [ ] Failure recovery tests

Manual Tests:
- [ ] Natural language variation (multiple phrasings work)
- [ ] Edge case prompts (open-ended requests)
- [ ] Confusion test (agent knows app vocabulary)
- [ ] Surprise test (agent can be creative)

CI Integration:
- [ ] Parity tests run on every PR
- [ ] Capability tests run with API key
- [ ] System prompt completeness check
- [ ] Capability map drift detection
</checklist>

---

## Source: agent-native-architecture/references / architecture-patterns.md

<overview>
Architectural patterns for building agent-native systems. These patterns emerge from the five core principles: Parity, Granularity, Composability, Emergent Capability, and Improvement Over Time.

Features are outcomes achieved by agents operating in a loop, not functions you write. Tools are atomic primitives. The agent applies judgment; the prompt defines the outcome.

See also:
- [files-universal-interface.md](./files-universal-interface.md) for file organization and context.md patterns
- [agent-execution-patterns.md](./agent-execution-patterns.md) for completion signals and partial completion
- [product-implications.md](./product-implications.md) for progressive disclosure and approval patterns
</overview>

<pattern name="event-driven-agent">
## Event-Driven Agent Architecture

The agent runs as a long-lived process that responds to events. Events become prompts.

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Loop                                │
├─────────────────────────────────────────────────────────────┤
│  Event Source → Agent (Claude) → Tool Calls → Response      │
└─────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌─────────┐    ┌──────────┐    ┌───────────┐
    │ Content │    │   Self   │    │   Data    │
    │  Tools  │    │  Tools   │    │   Tools   │
    └─────────┘    └──────────┘    └───────────┘
    (write_file)   (read_source)   (store_item)
                   (restart)       (list_items)
```

**Key characteristics:**
- Events (messages, webhooks, timers) trigger agent turns
- Agent decides how to respond based on system prompt
- Tools are primitives for IO, not business logic
- State persists between events via data tools

**Example: Discord feedback bot**
```typescript
// Event source
client.on("messageCreate", (message) => {
  if (!message.author.bot) {
    runAgent({
      userMessage: `New message from ${message.author}: "${message.content}"`,
      channelId: message.channelId,
    });
  }
});

// System prompt defines behavior
const systemPrompt = `
When someone shares feedback:
1. Acknowledge their feedback warmly
2. Ask clarifying questions if needed
3. Store it using the feedback tools
4. Update the feedback site

Use your judgment about importance and categorization.
`;
```
</pattern>

<pattern name="two-layer-git">
## Two-Layer Git Architecture

For self-modifying agents, separate code (shared) from data (instance-specific).

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub (shared repo)                     │
│  - src/           (agent code)                              │
│  - site/          (web interface)                           │
│  - package.json   (dependencies)                            │
│  - .gitignore     (excludes data/, logs/)                   │
└─────────────────────────────────────────────────────────────┘
                          │
                     git clone
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Instance (Server)                           │
│                                                              │
│  FROM GITHUB (tracked):                                      │
│  - src/           → pushed back on code changes             │
│  - site/          → pushed, triggers deployment             │
│                                                              │
│  LOCAL ONLY (untracked):                                     │
│  - data/          → instance-specific storage               │
│  - logs/          → runtime logs                            │
│  - .env           → secrets                                 │
└─────────────────────────────────────────────────────────────┘
```

**Why this works:**
- Code and site are version controlled (GitHub)
- Raw data stays local (instance-specific)
- Site is generated from data, so reproducible
- Automatic rollback via git history
</pattern>

<pattern name="multi-instance">
## Multi-Instance Branching

Each agent instance gets its own branch while sharing core code.

```
main                        # Shared features, bug fixes
├── instance/feedback-bot   # Every Reader feedback bot
├── instance/support-bot    # Customer support bot
└── instance/research-bot   # Research assistant
```

**Change flow:**
| Change Type | Work On | Then |
|-------------|---------|------|
| Core features | main | Merge to instance branches |
| Bug fixes | main | Merge to instance branches |
| Instance config | instance branch | Done |
| Instance data | instance branch | Done |

**Sync tools:**
```typescript
tool("self_deploy", "Pull latest from main, rebuild, restart", ...)
tool("sync_from_instance", "Merge from another instance", ...)
tool("propose_to_main", "Create PR to share improvements", ...)
```
</pattern>

<pattern name="site-as-output">
## Site as Agent Output

The agent generates and maintains a website as a natural output, not through specialized site tools.

```
Discord Message
      ↓
Agent processes it, extracts insights
      ↓
Agent decides what site updates are needed
      ↓
Agent writes files using write_file primitive
      ↓
Git commit + push triggers deployment
      ↓
Site updates automatically
```

**Key insight:** Don't build site generation tools. Give the agent file tools and teach it in the prompt how to create good sites.

```markdown
## Site Management

You maintain a public feedback site. When feedback comes in:
1. Use write_file to update site/public/content/feedback.json
2. If the site's React components need improvement, modify them
3. Commit changes and push to trigger Vercel deploy

The site should be:
- Clean, modern dashboard aesthetic
- Clear visual hierarchy
- Status organization (Inbox, Active, Done)

You decide the structure. Make it good.
```
</pattern>

<pattern name="approval-gates">
## Approval Gates Pattern

Separate "propose" from "apply" for dangerous operations.

```typescript
// Pending changes stored separately
const pendingChanges = new Map<string, string>();

tool("write_file", async ({ path, content }) => {
  if (requiresApproval(path)) {
    // Store for approval
    pendingChanges.set(path, content);
    const diff = generateDiff(path, content);
    return {
      text: `Change requires approval.\n\n${diff}\n\nReply "yes" to apply.`
    };
  } else {
    // Apply immediately
    writeFileSync(path, content);
    return { text: `Wrote ${path}` };
  }
});

tool("apply_pending", async () => {
  for (const [path, content] of pendingChanges) {
    writeFileSync(path, content);
  }
  pendingChanges.clear();
  return { text: "Applied all pending changes" };
});
```

**What requires approval:**
- src/*.ts (agent code)
- package.json (dependencies)
- system prompt changes

**What doesn't:**
- data/* (instance data)
- site/* (generated content)
- docs/* (documentation)
</pattern>

<pattern name="unified-agent-architecture">
## Unified Agent Architecture

One execution engine, many agent types. All agents use the same orchestrator but with different configurations.

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentOrchestrator                         │
├─────────────────────────────────────────────────────────────┤
│  - Lifecycle management (start, pause, resume, stop)        │
│  - Checkpoint/restore (for background execution)            │
│  - Tool execution                                            │
│  - Chat integration                                          │
└─────────────────────────────────────────────────────────────┘
          │                    │                    │
    ┌─────┴─────┐        ┌─────┴─────┐        ┌─────┴─────┐
    │ Research  │        │   Chat    │        │  Profile  │
    │   Agent   │        │   Agent   │        │   Agent   │
    └───────────┘        └───────────┘        └───────────┘
    - web_search         - read_library       - read_photos
    - write_file         - publish_to_feed    - write_file
    - read_file          - web_search         - analyze_image
```

**Implementation:**

```swift
// All agents use the same orchestrator
let session = try await AgentOrchestrator.shared.startAgent(
    config: ResearchAgent.create(book: book),  // Config varies
    tools: ResearchAgent.tools,                 // Tools vary
    context: ResearchAgent.context(for: book)   // Context varies
)

// Agent types define their own configuration
struct ResearchAgent {
    static var tools: [AgentTool] {
        [
            FileTools.readFile(),
            FileTools.writeFile(),
            WebTools.webSearch(),
            WebTools.webFetch(),
        ]
    }

    static func context(for book: Book) -> String {
        """
        You are researching "\(book.title)" by \(book.author).
        Save findings to Documents/Research/\(book.id)/
        """
    }
}

struct ChatAgent {
    static var tools: [AgentTool] {
        [
            FileTools.readFile(),
            FileTools.writeFile(),
            BookTools.readLibrary(),
            BookTools.publishToFeed(),  // Chat can publish directly
            WebTools.webSearch(),
        ]
    }

    static func context(library: [Book]) -> String {
        """
        You help the user with their reading.
        Available books: \(library.map { $0.title }.joined(separator: ", "))
        """
    }
}
```

**Benefits:**
- Consistent lifecycle management across all agent types
- Automatic checkpoint/resume (critical for mobile)
- Shared tool protocol
- Easy to add new agent types
- Centralized error handling and logging
</pattern>

<pattern name="agent-to-ui-communication">
## Agent-to-UI Communication

When agents take actions, the UI should reflect them immediately. The user should see what the agent did.

**Pattern 1: Shared Data Store (Recommended)**

Agent writes through the same service the UI observes:

```swift
// Shared service
class BookLibraryService: ObservableObject {
    static let shared = BookLibraryService()
    @Published var books: [Book] = []
    @Published var feedItems: [FeedItem] = []

    func addFeedItem(_ item: FeedItem) {
        feedItems.append(item)
        persist()
    }
}

// Agent tool writes through shared service
tool("publish_to_feed", async ({ bookId, content, headline }) => {
    let item = FeedItem(bookId: bookId, content: content, headline: headline)
    BookLibraryService.shared.addFeedItem(item)  // Same service UI uses
    return { text: "Published to feed" }
})

// UI observes the same service
struct FeedView: View {
    @StateObject var library = BookLibraryService.shared

    var body: some View {
        List(library.feedItems) { item in
            FeedItemRow(item: item)
            // Automatically updates when agent adds items
        }
    }
}
```

**Pattern 2: File System Observation**

For file-based data, watch the file system:

```swift
class ResearchWatcher: ObservableObject {
    @Published var files: [URL] = []
    private var watcher: DirectoryWatcher?

    func watch(bookId: String) {
        let path = documentsURL.appendingPathComponent("Research/\(bookId)")

        watcher = DirectoryWatcher(path: path) { [weak self] in
            self?.reload(from: path)
        }

        reload(from: path)
    }
}

// Agent writes files
tool("write_file", { path, content }) -> {
    writeFile(documentsURL.appendingPathComponent(path), content)
    // DirectoryWatcher triggers UI update automatically
}
```

**Pattern 3: Event Bus (Cross-Component)**

For complex apps with multiple independent components:

```typescript
// Shared event bus
const agentEvents = new EventEmitter();

// Agent tool emits events
tool("publish_to_feed", async ({ content }) => {
    const item = await feedService.add(content);
    agentEvents.emit('feed:new-item', item);
    return { text: "Published" };
});

// UI components subscribe
function FeedView() {
    const [items, setItems] = useState([]);

    useEffect(() => {
        const handler = (item) => setItems(prev => [...prev, item]);
        agentEvents.on('feed:new-item', handler);
        return () => agentEvents.off('feed:new-item', handler);
    }, []);

    return <FeedList items={items} />;
}
```

**What to avoid:**

```swift
// BAD: UI doesn't observe agent changes
// Agent writes to database directly
tool("publish_to_feed", { content }) {
    database.insert("feed", content)  // UI doesn't see this
}

// UI loads once at startup, never refreshes
struct FeedView: View {
    let items = database.query("feed")  // Stale!
}
```
</pattern>

<pattern name="model-tier-selection">
## Model Tier Selection

Different agents need different intelligence levels. Use the cheapest model that achieves the outcome.

| Agent Type | Recommended Tier | Reasoning |
|------------|-----------------|-----------|
| Chat/Conversation | Balanced | Fast responses, good reasoning |
| Research | Balanced | Tool loops, not ultra-complex synthesis |
| Content Generation | Balanced | Creative but not synthesis-heavy |
| Complex Analysis | Powerful | Multi-document synthesis, nuanced judgment |
| Profile/Onboarding | Powerful | Photo analysis, complex pattern recognition |
| Simple Queries | Fast/Haiku | Quick lookups, simple transformations |

**Implementation:**

```swift
enum ModelTier {
    case fast      // claude-3-haiku: Quick, cheap, simple tasks
    case balanced  // claude-3-sonnet: Good balance for most tasks
    case powerful  // claude-3-opus: Complex reasoning, synthesis
}

struct AgentConfig {
    let modelTier: ModelTier
    let tools: [AgentTool]
    let systemPrompt: String
}

// Research agent: balanced tier
let researchConfig = AgentConfig(
    modelTier: .balanced,
    tools: researchTools,
    systemPrompt: researchPrompt
)

// Profile analysis: powerful tier (complex photo interpretation)
let profileConfig = AgentConfig(
    modelTier: .powerful,
    tools: profileTools,
    systemPrompt: profilePrompt
)

// Quick lookup: fast tier
let lookupConfig = AgentConfig(
    modelTier: .fast,
    tools: [readLibrary],
    systemPrompt: "Answer quick questions about the user's library."
)
```

**Cost optimization strategies:**
- Start with balanced tier, only upgrade if quality insufficient
- Use fast tier for tool-heavy loops where each turn is simple
- Reserve powerful tier for synthesis tasks (comparing multiple sources)
- Consider token limits per turn to control costs
</pattern>

<design_questions>
## Questions to Ask When Designing

1. **What events trigger agent turns?** (messages, webhooks, timers, user requests)
2. **What primitives does the agent need?** (read, write, call API, restart)
3. **What decisions should the agent make?** (format, structure, priority, action)
4. **What decisions should be hardcoded?** (security boundaries, approval requirements)
5. **How does the agent verify its work?** (health checks, build verification)
6. **How does the agent recover from mistakes?** (git rollback, approval gates)
7. **How does the UI know when agent changes state?** (shared store, file watching, events)
8. **What model tier does each agent type need?** (fast, balanced, powerful)
9. **How do agents share infrastructure?** (unified orchestrator, shared tools)
</design_questions>

---

## Source: agent-native-architecture/references / dynamic-context-injection.md

<overview>
How to inject dynamic runtime context into agent system prompts. The agent needs to know what exists in the app to know what it can work with. Static prompts aren't enough—the agent needs to see the same context the user sees.

**Core principle:** The user's context IS the agent's context.
</overview>

<why_context_matters>
## Why Dynamic Context Injection?

A static system prompt tells the agent what it CAN do. Dynamic context tells it what it can do RIGHT NOW with the user's actual data.

**The failure case:**
```
User: "Write a little thing about Catherine the Great in my reading feed"
Agent: "What system are you referring to? I'm not sure what reading feed means."
```

The agent failed because it didn't know:
- What books exist in the user's library
- What the "reading feed" is
- What tools it has to publish there

**The fix:** Inject runtime context about app state into the system prompt.
</why_context_matters>

<pattern name="context-injection">
## The Context Injection Pattern

Build your system prompt dynamically, including current app state:

```swift
func buildSystemPrompt() -> String {
    // Gather current state
    let availableBooks = libraryService.books
    let recentActivity = analysisService.recentRecords(limit: 10)
    let userProfile = profileService.currentProfile

    return """
    # Your Identity

    You are a reading assistant for \(userProfile.name)'s library.

    ## Available Books in User's Library

    \(availableBooks.map { "- \"\($0.title)\" by \($0.author) (id: \($0.id))" }.joined(separator: "\n"))

    ## Recent Reading Activity

    \(recentActivity.map { "- Analyzed \"\($0.bookTitle)\": \($0.excerptPreview)" }.joined(separator: "\n"))

    ## Your Capabilities

    - **publish_to_feed**: Create insights that appear in the Feed tab
    - **read_library**: View books, highlights, and analyses
    - **web_search**: Search the internet for research
    - **write_file**: Save research to Documents/Research/{bookId}/

    When the user mentions "the feed" or "reading feed", they mean the Feed tab
    where insights appear. Use `publish_to_feed` to create content there.
    """
}
```
</pattern>

<what_to_inject>
## What Context to Inject

### 1. Available Resources
What data/files exist that the agent can access?

```swift
## Available in User's Library

Books:
- "Moby Dick" by Herman Melville (id: book_123)
- "1984" by George Orwell (id: book_456)

Research folders:
- Documents/Research/book_123/ (3 files)
- Documents/Research/book_456/ (1 file)
```

### 2. Current State
What has the user done recently? What's the current context?

```swift
## Recent Activity

- 2 hours ago: Highlighted passage in "1984" about surveillance
- Yesterday: Completed research on "Moby Dick" whale symbolism
- This week: Added 3 new books to library
```

### 3. Capabilities Mapping
What tool maps to what UI feature? Use the user's language.

```swift
## What You Can Do

| User Says | You Should Use | Result |
|-----------|----------------|--------|
| "my feed" / "reading feed" | `publish_to_feed` | Creates insight in Feed tab |
| "my library" / "my books" | `read_library` | Shows their book collection |
| "research this" | `web_search` + `write_file` | Saves to Research folder |
| "my profile" | `read_file("profile.md")` | Shows reading profile |
```

### 4. Domain Vocabulary
Explain app-specific terms the user might use.

```swift
## Vocabulary

- **Feed**: The Feed tab showing reading insights and analyses
- **Research folder**: Documents/Research/{bookId}/ where research is stored
- **Reading profile**: A markdown file describing user's reading preferences
- **Highlight**: A passage the user marked in a book
```
</what_to_inject>

<implementation_patterns>
## Implementation Patterns

### Pattern 1: Service-Based Injection (Swift/iOS)

```swift
class AgentContextBuilder {
    let libraryService: BookLibraryService
    let profileService: ReadingProfileService
    let activityService: ActivityService

    func buildContext() -> String {
        let books = libraryService.books
        let profile = profileService.currentProfile
        let activity = activityService.recent(limit: 10)

        return """
        ## Library (\(books.count) books)
        \(formatBooks(books))

        ## Profile
        \(profile.summary)

        ## Recent Activity
        \(formatActivity(activity))
        """
    }

    private func formatBooks(_ books: [Book]) -> String {
        books.map { "- \"\($0.title)\" (id: \($0.id))" }.joined(separator: "\n")
    }
}

// Usage in agent initialization
let context = AgentContextBuilder(
    libraryService: .shared,
    profileService: .shared,
    activityService: .shared
).buildContext()

let systemPrompt = basePrompt + "\n\n" + context
```

### Pattern 2: Hook-Based Injection (TypeScript)

```typescript
interface ContextProvider {
  getContext(): Promise<string>;
}

class LibraryContextProvider implements ContextProvider {
  async getContext(): Promise<string> {
    const books = await db.books.list();
    const recent = await db.activity.recent(10);

    return `
## Library
${books.map(b => `- "${b.title}" (${b.id})`).join('\n')}

## Recent
${recent.map(r => `- ${r.description}`).join('\n')}
    `.trim();
  }
}

// Compose multiple providers
async function buildSystemPrompt(providers: ContextProvider[]): Promise<string> {
  const contexts = await Promise.all(providers.map(p => p.getContext()));
  return [BASE_PROMPT, ...contexts].join('\n\n');
}
```

### Pattern 3: Template-Based Injection

```markdown
# System Prompt Template (system-prompt.template.md)

You are a reading assistant.

## Available Books

{{#each books}}
- "{{title}}" by {{author}} (id: {{id}})
{{/each}}

## Capabilities

{{#each capabilities}}
- **{{name}}**: {{description}}
{{/each}}

## Recent Activity

{{#each recentActivity}}
- {{timestamp}}: {{description}}
{{/each}}
```

```typescript
// Render at runtime
const prompt = Handlebars.compile(template)({
  books: await libraryService.getBooks(),
  capabilities: getCapabilities(),
  recentActivity: await activityService.getRecent(10),
});
```
</implementation_patterns>

<context_freshness>
## Context Freshness

Context should be injected at agent initialization, and optionally refreshed during long sessions.

**At initialization:**
```swift
// Always inject fresh context when starting an agent
func startChatAgent() async -> AgentSession {
    let context = await buildCurrentContext()  // Fresh context
    return await AgentOrchestrator.shared.startAgent(
        config: ChatAgent.config,
        systemPrompt: basePrompt + context
    )
}
```

**During long sessions (optional):**
```swift
// For long-running agents, provide a refresh tool
tool("refresh_context", "Get current app state") { _ in
    let books = libraryService.books
    let recent = activityService.recent(10)
    return """
    Current library: \(books.count) books
    Recent: \(recent.map { $0.summary }.joined(separator: ", "))
    """
}
```

**What NOT to do:**
```swift
// DON'T: Use stale context from app launch
let cachedContext = appLaunchContext  // Stale!
// Books may have been added, activity may have changed
```
</context_freshness>

<examples>
## Real-World Example: Every Reader

The Every Reader app injects context for its chat agent:

```swift
func getChatAgentSystemPrompt() -> String {
    // Get current library state
    let books = BookLibraryService.shared.books
    let analyses = BookLibraryService.shared.analysisRecords.prefix(10)
    let profile = ReadingProfileService.shared.getProfileForSystemPrompt()

    let bookList = books.map { book in
        "- \"\(book.title)\" by \(book.author) (id: \(book.id))"
    }.joined(separator: "\n")

    let recentList = analyses.map { record in
        let title = books.first { $0.id == record.bookId }?.title ?? "Unknown"
        return "- From \"\(title)\": \"\(record.excerptPreview)\""
    }.joined(separator: "\n")

    return """
    # Reading Assistant

    You help the user with their reading and book research.

    ## Available Books in User's Library

    \(bookList.isEmpty ? "No books yet." : bookList)

    ## Recent Reading Journal (Latest Analyses)

    \(recentList.isEmpty ? "No analyses yet." : recentList)

    ## Reading Profile

    \(profile)

    ## Your Capabilities

    - **Publish to Feed**: Create insights using `publish_to_feed` that appear in the Feed tab
    - **Library Access**: View books and highlights using `read_library`
    - **Research**: Search web and save to Documents/Research/{bookId}/
    - **Profile**: Read/update the user's reading profile

    When the user asks you to "write something for their feed" or "add to my reading feed",
    use the `publish_to_feed` tool with the relevant book_id.
    """
}
```

**Result:** When user says "write a little thing about Catherine the Great in my reading feed", the agent:
1. Sees "reading feed" → knows to use `publish_to_feed`
2. Sees available books → finds the relevant book ID
3. Creates appropriate content for the Feed tab
</examples>

<checklist>
## Context Injection Checklist

Before launching an agent:
- [ ] System prompt includes current resources (books, files, data)
- [ ] Recent activity is visible to the agent
- [ ] Capabilities are mapped to user vocabulary
- [ ] Domain-specific terms are explained
- [ ] Context is fresh (gathered at agent start, not cached)

When adding new features:
- [ ] New resources are included in context injection
- [ ] New capabilities are documented in system prompt
- [ ] User vocabulary for the feature is mapped
</checklist>

---

## Source: agent-native-architecture/references / files-universal-interface.md

<overview>
Files are the universal interface for agent-native applications. Agents are naturally fluent with file operations—they already know how to read, write, and organize files. This document covers why files work so well, how to organize them, and the context.md pattern for accumulated knowledge.
</overview>

<why_files>
## Why Files

Agents are naturally good at files. Claude Code works because bash + filesystem is the most battle-tested agent interface. When building agent-native apps, lean into this.

### Agents Already Know How

You don't need to teach the agent your API—it already knows `cat`, `grep`, `mv`, `mkdir`. File operations are the primitives it's most fluent with.

### Files Are Inspectable

Users can see what the agent created, edit it, move it, delete it. No black box. Complete transparency into agent behavior.

### Files Are Portable

Export is trivial. Backup is trivial. Users own their data. No vendor lock-in, no complex migration paths.

### App State Stays in Sync

On mobile, if you use the file system with iCloud, all devices share the same file system. The agent's work on one device appears on all devices—without you having to build a server.

### Directory Structure Is Information Architecture

The filesystem gives you hierarchy for free. `/projects/acme/notes/` is self-documenting in a way that `SELECT * FROM notes WHERE project_id = 123` isn't.
</why_files>

<file_organization>
## File Organization Patterns

> **Needs validation:** These conventions are one approach that's worked so far, not a prescription. Better solutions should be considered.

A general principle of agent-native design: **Design for what agents can reason about.** The best proxy for that is what would make sense to a human. If a human can look at your file structure and understand what's going on, an agent probably can too.

### Entity-Scoped Directories

Organize files around entities, not actors or file types:

```
{entity_type}/{entity_id}/
├── primary content
├── metadata
└── related materials
```

**Example:** `Research/books/{bookId}/` contains everything about one book—full text, notes, sources, agent logs.

### Naming Conventions

| File Type | Naming Pattern | Example |
|-----------|---------------|---------|
| Entity data | `{entity}.json` | `library.json`, `status.json` |
| Human-readable content | `{content_type}.md` | `introduction.md`, `profile.md` |
| Agent reasoning | `agent_log.md` | Per-entity agent history |
| Primary content | `full_text.txt` | Downloaded/extracted text |
| Multi-volume | `volume{N}.txt` | `volume1.txt`, `volume2.txt` |
| External sources | `{source_name}.md` | `wikipedia.md`, `sparknotes.md` |
| Checkpoints | `{sessionId}.checkpoint` | UUID-based |
| Configuration | `config.json` | Feature settings |

### Directory Naming

- **Entity-scoped:** `{entityType}/{entityId}/` (e.g., `Research/books/{bookId}/`)
- **Type-scoped:** `{type}/` (e.g., `AgentCheckpoints/`, `AgentLogs/`)
- **Convention:** Lowercase with underscores, not camelCase

### Ephemeral vs. Durable Separation

Separate agent working files from user's permanent data:

```
Documents/
├── AgentCheckpoints/     # Ephemeral (can delete)
│   └── {sessionId}.checkpoint
├── AgentLogs/            # Ephemeral (debugging)
│   └── {type}/{sessionId}.md
└── Research/             # Durable (user's work)
    └── books/{bookId}/
```

### The Split: Markdown vs JSON

- **Markdown:** For content users might read or edit
- **JSON:** For structured data the app queries
</file_organization>

<context_md_pattern>
## The context.md Pattern

A file the agent reads at the start of each session and updates as it learns:

```markdown
# Context

## Who I Am
Reading assistant for the Every app.

## What I Know About This User
- Interested in military history and Russian literature
- Prefers concise analysis
- Currently reading War and Peace

## What Exists
- 12 notes in /notes
- 3 active projects
- User preferences at /preferences.md

## Recent Activity
- User created "Project kickoff" (2 hours ago)
- Analyzed passage about Austerlitz (yesterday)

## My Guidelines
- Don't spoil books they're reading
- Use their interests to personalize insights

## Current State
- No pending tasks
- Last sync: 10 minutes ago
```

### Benefits

- **Agent behavior evolves without code changes** - Update the context, behavior changes
- **Users can inspect and modify** - Complete transparency
- **Natural place for accumulated context** - Learnings persist across sessions
- **Portable across sessions** - Restart agent, knowledge preserved

### How It Works

1. Agent reads `context.md` at session start
2. Agent updates it when learning something important
3. System can also update it (recent activity, new resources)
4. Context persists across sessions

### What to Include

| Section | Purpose |
|---------|---------|
| Who I Am | Agent identity and role |
| What I Know About This User | Learned preferences, interests |
| What Exists | Available resources, data |
| Recent Activity | Context for continuity |
| My Guidelines | Learned rules and constraints |
| Current State | Session status, pending items |
</context_md_pattern>

<files_vs_database>
## Files vs. Database

> **Needs validation:** This framing is informed by mobile development. For web apps, the tradeoffs are different.

| Use files for... | Use database for... |
|------------------|---------------------|
| Content users should read/edit | High-volume structured data |
| Configuration that benefits from version control | Data that needs complex queries |
| Agent-generated content | Ephemeral state (sessions, caches) |
| Anything that benefits from transparency | Data with relationships |
| Large text content | Data that needs indexing |

**The principle:** Files for legibility, databases for structure. When in doubt, files—they're more transparent and users can always inspect them.

### When Files Work Best

- Scale is small (one user's library, not millions of records)
- Transparency is valued over query speed
- Cloud sync (iCloud, Dropbox) works well with files

### Hybrid Approach

Even if you need a database for performance, consider maintaining a file-based "source of truth" that the agent works with, synced to the database for the UI:

```
Files (agent workspace):
  Research/book_123/introduction.md

Database (UI queries):
  research_index: { bookId, path, title, createdAt }
```
</files_vs_database>

<conflict_model>
## Conflict Model

If agents and users write to the same files, you need a conflict model.

### Current Reality

Most implementations use **last-write-wins** via atomic writes:

```swift
try data.write(to: url, options: [.atomic])
```

This is simple but can lose changes.

### Options

| Strategy | Pros | Cons |
|----------|------|------|
| **Last write wins** | Simple | Changes can be lost |
| **Agent checks before writing** | Preserves user edits | More complexity |
| **Separate spaces** | No conflicts | Less collaboration |
| **Append-only logs** | Never overwrites | Files grow forever |
| **File locking** | Safe concurrent access | Complexity, can block |

### Recommended Approaches

**For files agents write frequently (logs, status):** Last-write-wins is fine. Conflicts are rare.

**For files users edit (profiles, notes):** Consider explicit handling:
- Agent checks modification time before overwriting
- Or keep agent output separate from user-editable content
- Or use append-only pattern

### iCloud Considerations

iCloud sync adds complexity. It creates `{filename} (conflict).md` files when sync conflicts occur. Monitor for these:

```swift
NotificationCenter.default.addObserver(
    forName: .NSMetadataQueryDidUpdate,
    ...
)
```

### System Prompt Guidance

Tell the agent about the conflict model:

```markdown
## Working with User Content

When you create content, the user may edit it afterward. Always read
existing files before modifying them—the user may have made improvements
you should preserve.

If a file has been modified since you last wrote it, ask before overwriting.
```
</conflict_model>

<examples>
## Example: Reading App File Structure

```
Documents/
├── Library/
│   └── library.json              # Book metadata
├── Research/
│   └── books/
│       └── {bookId}/
│           ├── full_text.txt     # Downloaded content
│           ├── introduction.md   # Agent-generated, user-editable
│           ├── notes.md          # User notes
│           └── sources/
│               ├── wikipedia.md  # Research gathered by agent
│               └── reviews.md
├── Chats/
│   └── {conversationId}.json     # Chat history
├── Profile/
│   └── profile.md                # User reading profile
└── context.md                    # Agent's accumulated knowledge
```

**How it works:**

1. User adds book → creates entry in `library.json`
2. Agent downloads text → saves to `Research/books/{id}/full_text.txt`
3. Agent researches → saves to `sources/`
4. Agent generates intro → saves to `introduction.md`
5. User edits intro → agent sees changes on next read
6. Agent updates `context.md` with learnings
</examples>

<checklist>
## Files as Universal Interface Checklist

### Organization
- [ ] Entity-scoped directories (`{type}/{id}/`)
- [ ] Consistent naming conventions
- [ ] Ephemeral vs durable separation
- [ ] Markdown for human content, JSON for structured data

### context.md
- [ ] Agent reads context at session start
- [ ] Agent updates context when learning
- [ ] Includes: identity, user knowledge, what exists, guidelines
- [ ] Persists across sessions

### Conflict Handling
- [ ] Conflict model defined (last-write-wins, check-before-write, etc.)
- [ ] Agent guidance in system prompt
- [ ] iCloud conflict monitoring (if applicable)

### Integration
- [ ] UI observes file changes (or shared service)
- [ ] Agent can read user edits
- [ ] User can inspect agent output
</checklist>

---

## Source: agent-native-architecture/references / from-primitives-to-domain-tools.md

<overview>
Start with pure primitives: bash, file operations, basic storage. This proves the architecture works and reveals what the agent actually needs. As patterns emerge, add domain-specific tools deliberately. This document covers when and how to evolve from primitives to domain tools, and when to graduate to optimized code.
</overview>

<start_with_primitives>
## Start with Pure Primitives

Begin every agent-native system with the most atomic tools possible:

- `read_file` / `write_file` / `list_files`
- `bash` (for everything else)
- Basic storage (`store_item` / `get_item`)
- HTTP requests (`fetch_url`)

**Why start here:**

1. **Proves the architecture** - If it works with primitives, your prompts are doing their job
2. **Reveals actual needs** - You'll discover what domain concepts matter
3. **Maximum flexibility** - Agent can do anything, not just what you anticipated
4. **Forces good prompts** - You can't lean on tool logic as a crutch

### Example: Starting Primitive

```typescript
// Start with just these
const tools = [
  tool("read_file", { path: z.string() }, ...),
  tool("write_file", { path: z.string(), content: z.string() }, ...),
  tool("list_files", { path: z.string() }, ...),
  tool("bash", { command: z.string() }, ...),
];

// Prompt handles the domain logic
const prompt = `
When processing feedback:
1. Read existing feedback from data/feedback.json
2. Add the new feedback with your assessment of importance (1-5)
3. Write the updated file
4. If importance >= 4, create a notification file in data/alerts/
`;
```
</start_with_primitives>

<when_to_add_domain_tools>
## When to Add Domain Tools

As patterns emerge, you'll want to add domain-specific tools. This is good—but do it deliberately.

### Vocabulary Anchoring

**Add a domain tool when:** The agent needs to understand domain concepts.

A `create_note` tool teaches the agent what "note" means in your system better than "write a file to the notes directory with this format."

```typescript
// Without domain tool - agent must infer structure
await agent.chat("Create a note about the meeting");
// Agent: writes to... notes/? documents/? what format?

// With domain tool - vocabulary is anchored
tool("create_note", {
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
}, async ({ title, content, tags }) => {
  // Tool enforces structure, agent understands "note"
});
```

### Guardrails

**Add a domain tool when:** Some operations need validation or constraints that shouldn't be left to agent judgment.

```typescript
// publish_to_feed might enforce format requirements or content policies
tool("publish_to_feed", {
  bookId: z.string(),
  content: z.string(),
  headline: z.string().max(100),  // Enforce headline length
}, async ({ bookId, content, headline }) => {
  // Validate content meets guidelines
  if (containsProhibitedContent(content)) {
    return { text: "Content doesn't meet guidelines", isError: true };
  }
  // Enforce proper structure
  await feedService.publish({ bookId, content, headline, publishedAt: new Date() });
});
```

### Efficiency

**Add a domain tool when:** Common operations would take many primitive calls.

```typescript
// Primitive approach: multiple calls
await agent.chat("Get book details");
// Agent: read library.json, parse, find book, read full_text.txt, read introduction.md...

// Domain tool: one call for common operation
tool("get_book_with_content", { bookId: z.string() }, async ({ bookId }) => {
  const book = await library.getBook(bookId);
  const fullText = await readFile(`Research/${bookId}/full_text.txt`);
  const intro = await readFile(`Research/${bookId}/introduction.md`);
  return { text: JSON.stringify({ book, fullText, intro }) };
});
```
</when_to_add_domain_tools>

<the_rule>
## The Rule for Domain Tools

**Domain tools should represent one conceptual action from the user's perspective.**

They can include mechanical validation, but **judgment about what to do or whether to do it belongs in the prompt**.

### Wrong: Bundles Judgment

```typescript
// WRONG - analyze_and_publish bundles judgment into the tool
tool("analyze_and_publish", async ({ input }) => {
  const analysis = analyzeContent(input);      // Tool decides how to analyze
  const shouldPublish = analysis.score > 0.7;  // Tool decides whether to publish
  if (shouldPublish) {
    await publish(analysis.summary);            // Tool decides what to publish
  }
});
```

### Right: One Action, Agent Decides

```typescript
// RIGHT - separate tools, agent decides
tool("analyze_content", { content: z.string() }, ...);  // Returns analysis
tool("publish", { content: z.string() }, ...);          // Publishes what agent provides

// Prompt: "Analyze the content. If it's high quality, publish a summary."
// Agent decides what "high quality" means and what summary to write.
```

### The Test

Ask: "Who is making the decision here?"

- If the answer is "the tool code" → you've encoded judgment, refactor
- If the answer is "the agent based on the prompt" → good
</the_rule>

<keep_primitives_available>
## Keep Primitives Available

**Domain tools are shortcuts, not gates.**

Unless there's a specific reason to restrict access (security, data integrity), the agent should still be able to use underlying primitives for edge cases.

```typescript
// Domain tool for common case
tool("create_note", { title, content }, ...);

// But primitives still available for edge cases
tool("read_file", { path }, ...);
tool("write_file", { path, content }, ...);

// Agent can use create_note normally, but for weird edge case:
// "Create a note in a non-standard location with custom metadata"
// → Agent uses write_file directly
```

### When to Gate

Gating (making domain tool the only way) is appropriate for:

- **Security:** User authentication, payment processing
- **Data integrity:** Operations that must maintain invariants
- **Audit requirements:** Actions that must be logged in specific ways

**The default is open.** When you do gate something, make it a conscious decision with a clear reason.
</keep_primitives_available>

<graduating_to_code>
## Graduating to Code

Some operations will need to move from agent-orchestrated to optimized code for performance or reliability.

### The Progression

```
Stage 1: Agent uses primitives in a loop
         → Flexible, proves the concept
         → Slow, potentially expensive

Stage 2: Add domain tools for common operations
         → Faster, still agent-orchestrated
         → Agent still decides when/whether to use

Stage 3: For hot paths, implement in optimized code
         → Fast, deterministic
         → Agent can still trigger, but execution is code
```

### Example Progression

**Stage 1: Pure primitives**
```markdown
Prompt: "When user asks for a summary, read all notes in /notes,
        analyze them, and write a summary to /summaries/{date}.md"

Agent: Calls read_file 20 times, reasons about content, writes summary
Time: 30 seconds, 50k tokens
```

**Stage 2: Domain tool**
```typescript
tool("get_all_notes", {}, async () => {
  const notes = await readAllNotesFromDirectory();
  return { text: JSON.stringify(notes) };
});

// Agent still decides how to summarize, but retrieval is faster
// Time: 10 seconds, 30k tokens
```

**Stage 3: Optimized code**
```typescript
tool("generate_weekly_summary", {}, async () => {
  // Entire operation in code for hot path
  const notes = await getNotes({ since: oneWeekAgo });
  const summary = await generateSummary(notes);  // Could use cheaper model
  await writeSummary(summary);
  return { text: "Summary generated" };
});

// Agent just triggers it
// Time: 2 seconds, 5k tokens
```

### The Caveat

**Even when an operation graduates to code, the agent should be able to:**

1. Trigger the optimized operation itself
2. Fall back to primitives for edge cases the optimized path doesn't handle

Graduation is about efficiency. **Parity still holds.** The agent doesn't lose capability when you optimize.
</graduating_to_code>

<decision_framework>
## Decision Framework

### Should I Add a Domain Tool?

| Question | If Yes |
|----------|--------|
| Is the agent confused about what this concept means? | Add for vocabulary anchoring |
| Does this operation need validation the agent shouldn't decide? | Add with guardrails |
| Is this a common multi-step operation? | Add for efficiency |
| Would changing behavior require code changes? | Keep as prompt instead |

### Should I Graduate to Code?

| Question | If Yes |
|----------|--------|
| Is this operation called very frequently? | Consider graduating |
| Does latency matter significantly? | Consider graduating |
| Are token costs problematic? | Consider graduating |
| Do you need deterministic behavior? | Graduate to code |
| Does the operation need complex state management? | Graduate to code |

### Should I Gate Access?

| Question | If Yes |
|----------|--------|
| Is there a security requirement? | Gate appropriately |
| Must this operation maintain data integrity? | Gate appropriately |
| Is there an audit/compliance requirement? | Gate appropriately |
| Is it just "safer" with no specific risk? | Keep primitives available |
</decision_framework>

<examples>
## Examples

### Feedback Processing Evolution

**Stage 1: Primitives only**
```typescript
tools: [read_file, write_file, bash]
prompt: "Store feedback in data/feedback.json, notify if important"
// Agent figures out JSON structure, importance criteria, notification method
```

**Stage 2: Domain tools for vocabulary**
```typescript
tools: [
  store_feedback,      // Anchors "feedback" concept with proper structure
  send_notification,   // Anchors "notify" with correct channels
  read_file,           // Still available for edge cases
  write_file,
]
prompt: "Store feedback using store_feedback. Notify if importance >= 4."
// Agent still decides importance, but vocabulary is anchored
```

**Stage 3: Graduated hot path**
```typescript
tools: [
  process_feedback_batch,  // Optimized for high-volume processing
  store_feedback,          // For individual items
  send_notification,
  read_file,
  write_file,
]
// Batch processing is code, but agent can still use store_feedback for special cases
```

### When NOT to Add Domain Tools

**Don't add a domain tool just to make things "cleaner":**
```typescript
// Unnecessary - agent can compose primitives
tool("organize_files_by_date", ...)  // Just use move_file + judgment

// Unnecessary - puts decision in wrong place
tool("decide_file_importance", ...)  // This is prompt territory
```

**Don't add a domain tool if behavior might change:**
```typescript
// Bad - locked into code
tool("generate_standard_report", ...)  // What if report format evolves?

// Better - keep in prompt
prompt: "Generate a report covering X, Y, Z. Format for readability."
// Can adjust format by editing prompt
```
</examples>

<checklist>
## Checklist: Primitives to Domain Tools

### Starting Out
- [ ] Begin with pure primitives (read, write, list, bash)
- [ ] Write behavior in prompts, not tool logic
- [ ] Let patterns emerge from actual usage

### Adding Domain Tools
- [ ] Clear reason: vocabulary anchoring, guardrails, or efficiency
- [ ] Tool represents one conceptual action
- [ ] Judgment stays in prompts, not tool code
- [ ] Primitives remain available alongside domain tools

### Graduating to Code
- [ ] Hot path identified (frequent, latency-sensitive, or expensive)
- [ ] Optimized version doesn't remove agent capability
- [ ] Fallback to primitives for edge cases still works

### Gating Decisions
- [ ] Specific reason for each gate (security, integrity, audit)
- [ ] Default is open access
- [ ] Gates are conscious decisions, not defaults
</checklist>

---

## Source: agent-native-architecture/references / mcp-tool-design.md

<overview>
How to design MCP tools following prompt-native principles. Tools should be primitives that enable capability, not workflows that encode decisions.

**Core principle:** Whatever a user can do, the agent should be able to do. Don't artificially limit the agent—give it the same primitives a power user would have.
</overview>

<principle name="primitives-not-workflows">
## Tools Are Primitives, Not Workflows

**Wrong approach:** Tools that encode business logic
```typescript
tool("process_feedback", {
  feedback: z.string(),
  category: z.enum(["bug", "feature", "question"]),
  priority: z.enum(["low", "medium", "high"]),
}, async ({ feedback, category, priority }) => {
  // Tool decides how to process
  const processed = categorize(feedback);
  const stored = await saveToDatabase(processed);
  const notification = await notify(priority);
  return { processed, stored, notification };
});
```

**Right approach:** Primitives that enable any workflow
```typescript
tool("store_item", {
  key: z.string(),
  value: z.any(),
}, async ({ key, value }) => {
  await db.set(key, value);
  return { text: `Stored ${key}` };
});

tool("send_message", {
  channel: z.string(),
  content: z.string(),
}, async ({ channel, content }) => {
  await messenger.send(channel, content);
  return { text: "Sent" };
});
```

The agent decides categorization, priority, and when to notify based on the system prompt.
</principle>

<principle name="descriptive-names">
## Tools Should Have Descriptive, Primitive Names

Names should describe the capability, not the use case:

| Wrong | Right |
|-------|-------|
| `process_user_feedback` | `store_item` |
| `create_feedback_summary` | `write_file` |
| `send_notification` | `send_message` |
| `deploy_to_production` | `git_push` |

The prompt tells the agent *when* to use primitives. The tool just provides *capability*.
</principle>

<principle name="simple-inputs">
## Inputs Should Be Simple

Tools accept data. They don't accept decisions.

**Wrong:** Tool accepts decisions
```typescript
tool("format_content", {
  content: z.string(),
  format: z.enum(["markdown", "html", "json"]),
  style: z.enum(["formal", "casual", "technical"]),
}, ...)
```

**Right:** Tool accepts data, agent decides format
```typescript
tool("write_file", {
  path: z.string(),
  content: z.string(),
}, ...)
// Agent decides to write index.html with HTML content, or data.json with JSON
```
</principle>

<principle name="rich-outputs">
## Outputs Should Be Rich

Return enough information for the agent to verify and iterate.

**Wrong:** Minimal output
```typescript
async ({ key }) => {
  await db.delete(key);
  return { text: "Deleted" };
}
```

**Right:** Rich output
```typescript
async ({ key }) => {
  const existed = await db.has(key);
  if (!existed) {
    return { text: `Key ${key} did not exist` };
  }
  await db.delete(key);
  return { text: `Deleted ${key}. ${await db.count()} items remaining.` };
}
```
</principle>

<design_template>
## Tool Design Template

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const serverName = createSdkMcpServer({
  name: "server-name",
  version: "1.0.0",
  tools: [
    // READ operations
    tool(
      "read_item",
      "Read an item by key",
      { key: z.string().describe("Item key") },
      async ({ key }) => {
        const item = await storage.get(key);
        return {
          content: [{
            type: "text",
            text: item ? JSON.stringify(item, null, 2) : `Not found: ${key}`,
          }],
          isError: !item,
        };
      }
    ),

    tool(
      "list_items",
      "List all items, optionally filtered",
      {
        prefix: z.string().optional().describe("Filter by key prefix"),
        limit: z.number().default(100).describe("Max items"),
      },
      async ({ prefix, limit }) => {
        const items = await storage.list({ prefix, limit });
        return {
          content: [{
            type: "text",
            text: `Found ${items.length} items:\n${items.map(i => i.key).join("\n")}`,
          }],
        };
      }
    ),

    // WRITE operations
    tool(
      "store_item",
      "Store an item",
      {
        key: z.string().describe("Item key"),
        value: z.any().describe("Item data"),
      },
      async ({ key, value }) => {
        await storage.set(key, value);
        return {
          content: [{ type: "text", text: `Stored ${key}` }],
        };
      }
    ),

    tool(
      "delete_item",
      "Delete an item",
      { key: z.string().describe("Item key") },
      async ({ key }) => {
        const existed = await storage.delete(key);
        return {
          content: [{
            type: "text",
            text: existed ? `Deleted ${key}` : `${key} did not exist`,
          }],
        };
      }
    ),

    // EXTERNAL operations
    tool(
      "call_api",
      "Make an HTTP request",
      {
        url: z.string().url(),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        body: z.any().optional(),
      },
      async ({ url, method, body }) => {
        const response = await fetch(url, { method, body: JSON.stringify(body) });
        const text = await response.text();
        return {
          content: [{
            type: "text",
            text: `${response.status} ${response.statusText}\n\n${text}`,
          }],
          isError: !response.ok,
        };
      }
    ),
  ],
});
```
</design_template>

<example name="feedback-server">
## Example: Feedback Storage Server

This server provides primitives for storing feedback. It does NOT decide how to categorize or organize feedback—that's the agent's job via the prompt.

```typescript
export const feedbackMcpServer = createSdkMcpServer({
  name: "feedback",
  version: "1.0.0",
  tools: [
    tool(
      "store_feedback",
      "Store a feedback item",
      {
        item: z.object({
          id: z.string(),
          author: z.string(),
          content: z.string(),
          importance: z.number().min(1).max(5),
          timestamp: z.string(),
          status: z.string().optional(),
          urls: z.array(z.string()).optional(),
          metadata: z.any().optional(),
        }).describe("Feedback item"),
      },
      async ({ item }) => {
        await db.feedback.insert(item);
        return {
          content: [{
            type: "text",
            text: `Stored feedback ${item.id} from ${item.author}`,
          }],
        };
      }
    ),

    tool(
      "list_feedback",
      "List feedback items",
      {
        limit: z.number().default(50),
        status: z.string().optional(),
      },
      async ({ limit, status }) => {
        const items = await db.feedback.list({ limit, status });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(items, null, 2),
          }],
        };
      }
    ),

    tool(
      "update_feedback",
      "Update a feedback item",
      {
        id: z.string(),
        updates: z.object({
          status: z.string().optional(),
          importance: z.number().optional(),
          metadata: z.any().optional(),
        }),
      },
      async ({ id, updates }) => {
        await db.feedback.update(id, updates);
        return {
          content: [{ type: "text", text: `Updated ${id}` }],
        };
      }
    ),
  ],
});
```

The system prompt then tells the agent *how* to use these primitives:

```markdown
## Feedback Processing

When someone shares feedback:
1. Extract author, content, and any URLs
2. Rate importance 1-5 based on actionability
3. Store using feedback.store_feedback
4. If high importance (4-5), notify the channel

Use your judgment about importance ratings.
```
</example>

<principle name="dynamic-capability-discovery">
## Dynamic Capability Discovery vs Static Tool Mapping

**This pattern is specifically for agent-native apps** where you want the agent to have full access to an external API—the same access a user would have. It follows the core agent-native principle: "Whatever the user can do, the agent can do."

If you're building a constrained agent with limited capabilities, static tool mapping may be intentional. But for agent-native apps integrating with HealthKit, HomeKit, GraphQL, or similar APIs:

**Static Tool Mapping (Anti-pattern for Agent-Native):**
Build individual tools for each API capability. Always out of date, limits agent to only what you anticipated.

```typescript
// ❌ Static: Every API type needs a hardcoded tool
tool("read_steps", async ({ startDate, endDate }) => {
  return healthKit.query(HKQuantityType.stepCount, startDate, endDate);
});

tool("read_heart_rate", async ({ startDate, endDate }) => {
  return healthKit.query(HKQuantityType.heartRate, startDate, endDate);
});

tool("read_sleep", async ({ startDate, endDate }) => {
  return healthKit.query(HKCategoryType.sleepAnalysis, startDate, endDate);
});

// When HealthKit adds glucose tracking... you need a code change
```

**Dynamic Capability Discovery (Preferred):**
Build a meta-tool that discovers what's available, and a generic tool that can access anything.

```typescript
// ✅ Dynamic: Agent discovers and uses any capability

// Discovery tool - returns what's available at runtime
tool("list_available_capabilities", async () => {
  const quantityTypes = await healthKit.availableQuantityTypes();
  const categoryTypes = await healthKit.availableCategoryTypes();

  return {
    text: `Available health metrics:\n` +
          `Quantity types: ${quantityTypes.join(", ")}\n` +
          `Category types: ${categoryTypes.join(", ")}\n` +
          `\nUse read_health_data with any of these types.`
  };
});

// Generic access tool - type is a string, API validates
tool("read_health_data", {
  dataType: z.string(),  // NOT z.enum - let HealthKit validate
  startDate: z.string(),
  endDate: z.string(),
  aggregation: z.enum(["sum", "average", "samples"]).optional()
}, async ({ dataType, startDate, endDate, aggregation }) => {
  // HealthKit validates the type, returns helpful error if invalid
  const result = await healthKit.query(dataType, startDate, endDate, aggregation);
  return { text: JSON.stringify(result, null, 2) };
});
```

**When to Use Each Approach:**

| Dynamic (Agent-Native) | Static (Constrained Agent) |
|------------------------|---------------------------|
| Agent should access anything user can | Agent has intentionally limited scope |
| External API with many endpoints (HealthKit, HomeKit, GraphQL) | Internal domain with fixed operations |
| API evolves independently of your code | Tightly coupled domain logic |
| You want full action parity | You want strict guardrails |

**The agent-native default is Dynamic.** Only use Static when you're intentionally limiting the agent's capabilities.

**Complete Dynamic Pattern:**

```swift
// 1. Discovery tool: What can I access?
tool("list_health_types", "Get available health data types") { _ in
    let store = HKHealthStore()

    let quantityTypes = HKQuantityTypeIdentifier.allCases.map { $0.rawValue }
    let categoryTypes = HKCategoryTypeIdentifier.allCases.map { $0.rawValue }
    let characteristicTypes = HKCharacteristicTypeIdentifier.allCases.map { $0.rawValue }

    return ToolResult(text: """
        Available HealthKit types:

        ## Quantity Types (numeric values)
        \(quantityTypes.joined(separator: ", "))

        ## Category Types (categorical data)
        \(categoryTypes.joined(separator: ", "))

        ## Characteristic Types (user info)
        \(characteristicTypes.joined(separator: ", "))

        Use read_health_data or write_health_data with any of these.
        """)
}

// 2. Generic read: Access any type by name
tool("read_health_data", "Read any health metric", {
    dataType: z.string().describe("Type name from list_health_types"),
    startDate: z.string(),
    endDate: z.string()
}) { request in
    // Let HealthKit validate the type name
    guard let type = HKQuantityTypeIdentifier(rawValue: request.dataType)
                     ?? HKCategoryTypeIdentifier(rawValue: request.dataType) else {
        return ToolResult(
            text: "Unknown type: \(request.dataType). Use list_health_types to see available types.",
            isError: true
        )
    }

    let samples = try await healthStore.querySamples(type: type, start: startDate, end: endDate)
    return ToolResult(text: samples.formatted())
}

// 3. Context injection: Tell agent what's available in system prompt
func buildSystemPrompt() -> String {
    let availableTypes = healthService.getAuthorizedTypes()

    return """
    ## Available Health Data

    You have access to these health metrics:
    \(availableTypes.map { "- \($0)" }.joined(separator: "\n"))

    Use read_health_data with any type above. For new types not listed,
    use list_health_types to discover what's available.
    """
}
```

**Benefits:**
- Agent can use any API capability, including ones added after your code shipped
- API is the validator, not your enum definition
- Smaller tool surface (2-3 tools vs N tools)
- Agent naturally discovers capabilities by asking
- Works with any API that has introspection (HealthKit, GraphQL, OpenAPI)
</principle>

<principle name="crud-completeness">
## CRUD Completeness

Every data type the agent can create, it should be able to read, update, and delete. Incomplete CRUD = broken action parity.

**Anti-pattern: Create-only tools**
```typescript
// ❌ Can create but not modify or delete
tool("create_experiment", { hypothesis, variable, metric })
tool("write_journal_entry", { content, author, tags })
// User: "Delete that experiment" → Agent: "I can't do that"
```

**Correct: Full CRUD for each entity**
```typescript
// ✅ Complete CRUD
tool("create_experiment", { hypothesis, variable, metric })
tool("read_experiment", { id })
tool("update_experiment", { id, updates: { hypothesis?, status?, endDate? } })
tool("delete_experiment", { id })

tool("create_journal_entry", { content, author, tags })
tool("read_journal", { query?, dateRange?, author? })
tool("update_journal_entry", { id, content, tags? })
tool("delete_journal_entry", { id })
```

**The CRUD Audit:**
For each entity type in your app, verify:
- [ ] Create: Agent can create new instances
- [ ] Read: Agent can query/search/list instances
- [ ] Update: Agent can modify existing instances
- [ ] Delete: Agent can remove instances

If any operation is missing, users will eventually ask for it and the agent will fail.
</principle>

<checklist>
## MCP Tool Design Checklist

**Fundamentals:**
- [ ] Tool names describe capability, not use case
- [ ] Inputs are data, not decisions
- [ ] Outputs are rich (enough for agent to verify)
- [ ] CRUD operations are separate tools (not one mega-tool)
- [ ] No business logic in tool implementations
- [ ] Error states clearly communicated via `isError`
- [ ] Descriptions explain what the tool does, not when to use it

**Dynamic Capability Discovery (for agent-native apps):**
- [ ] For external APIs where agent should have full access, use dynamic discovery
- [ ] Include a `list_*` or `discover_*` tool for each API surface
- [ ] Use string inputs (not enums) when the API validates
- [ ] Inject available capabilities into system prompt at runtime
- [ ] Only use static tool mapping if intentionally limiting agent scope

**CRUD Completeness:**
- [ ] Every entity has create, read, update, delete operations
- [ ] Every UI action has a corresponding agent tool
- [ ] Test: "Can the agent undo what it just did?"
</checklist>

---

## Source: agent-native-architecture/references / mobile-patterns.md

<overview>
Mobile is a first-class platform for agent-native apps. It has unique constraints and opportunities. This guide covers why mobile matters, iOS storage architecture, checkpoint/resume patterns, and cost-aware design.
</overview>

<why_mobile>
## Why Mobile Matters

Mobile devices offer unique advantages for agent-native apps:

### A File System
Agents can work with files naturally, using the same primitives that work everywhere else. The filesystem is the universal interface.

### Rich Context
A walled garden you get access to. Health data, location, photos, calendars—context that doesn't exist on desktop or web. This enables deeply personalized agent experiences.

### Local Apps
Everyone has their own copy of the app. This opens opportunities that aren't fully realized yet: apps that modify themselves, fork themselves, evolve per-user. App Store policies constrain some of this today, but the foundation is there.

### Cross-Device Sync
If you use the file system with iCloud, all devices share the same file system. The agent's work on one device appears on all devices—without you having to build a server.

### The Challenge

**Agents are long-running. Mobile apps are not.**

An agent might need 30 seconds, 5 minutes, or an hour to complete a task. But iOS will background your app after seconds of inactivity, and may kill it entirely to reclaim memory. The user might switch apps, take a call, or lock their phone mid-task.

This means mobile agent apps need:
- **Checkpointing** — Saving state so work isn't lost
- **Resuming** — Picking up where you left off after interruption
- **Background execution** — Using the limited time iOS gives you wisely
- **On-device vs. cloud decisions** — What runs locally vs. what needs a server
</why_mobile>

<ios_storage>
## iOS Storage Architecture

> **Needs validation:** This is an approach that works well, but better solutions may exist.

For agent-native iOS apps, use iCloud Drive's Documents folder for your shared workspace. This gives you **free, automatic multi-device sync** without building a sync layer or running a server.

### Why iCloud Documents?

| Approach | Cost | Complexity | Offline | Multi-Device |
|----------|------|------------|---------|--------------|
| Custom backend + sync | $$$ | High | Manual | Yes |
| CloudKit database | Free tier limits | Medium | Manual | Yes |
| **iCloud Documents** | Free (user's storage) | Low | Automatic | Automatic |

iCloud Documents:
- Uses user's existing iCloud storage (free 5GB, most users have more)
- Automatic sync across all user's devices
- Works offline, syncs when online
- Files visible in Files.app for transparency
- No server costs, no sync code to maintain

### Implementation: iCloud-First with Local Fallback

```swift
// Get the iCloud Documents container
func iCloudDocumentsURL() -> URL? {
    FileManager.default.url(forUbiquityContainerIdentifier: nil)?
        .appendingPathComponent("Documents")
}

// Your shared workspace lives in iCloud
class SharedWorkspace {
    let rootURL: URL

    init() {
        // Use iCloud if available, fall back to local
        if let iCloudURL = iCloudDocumentsURL() {
            self.rootURL = iCloudURL
        } else {
            // Fallback to local Documents (user not signed into iCloud)
            self.rootURL = FileManager.default.urls(
                for: .documentDirectory,
                in: .userDomainMask
            ).first!
        }
    }

    // All file operations go through this root
    func researchPath(for bookId: String) -> URL {
        rootURL.appendingPathComponent("Research/\(bookId)")
    }

    func journalPath() -> URL {
        rootURL.appendingPathComponent("Journal")
    }
}
```

### Directory Structure in iCloud

```
iCloud Drive/
└── YourApp/                          # Your app's container
    └── Documents/                    # Visible in Files.app
        ├── Journal/
        │   ├── user/
        │   │   └── 2025-01-15.md     # Syncs across devices
        │   └── agent/
        │       └── 2025-01-15.md     # Agent observations sync too
        ├── Research/
        │   └── {bookId}/
        │       ├── full_text.txt
        │       └── sources/
        ├── Chats/
        │   └── {conversationId}.json
        └── context.md                # Agent's accumulated knowledge
```

### Handling iCloud File States

iCloud files may not be downloaded locally. Handle this:

```swift
func readFile(at url: URL) throws -> String {
    // iCloud may create .icloud placeholder files
    if url.pathExtension == "icloud" {
        // Trigger download
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
        throw FileNotYetAvailableError()
    }

    return try String(contentsOf: url, encoding: .utf8)
}

// For writes, use coordinated file access
func writeFile(_ content: String, to url: URL) throws {
    let coordinator = NSFileCoordinator()
    var error: NSError?

    coordinator.coordinate(
        writingItemAt: url,
        options: .forReplacing,
        error: &error
    ) { newURL in
        try? content.write(to: newURL, atomically: true, encoding: .utf8)
    }

    if let error = error { throw error }
}
```

### What iCloud Enables

1. **User starts experiment on iPhone** → Agent creates config file
2. **User opens app on iPad** → Same experiment visible, no sync code needed
3. **Agent logs observation on iPhone** → Syncs to iPad automatically
4. **User edits journal on iPad** → iPhone sees the edit

### Entitlements Required

Add to your app's entitlements:

```xml
<key>com.apple.developer.icloud-container-identifiers</key>
<array>
    <string>iCloud.com.yourcompany.yourapp</string>
</array>
<key>com.apple.developer.icloud-services</key>
<array>
    <string>CloudDocuments</string>
</array>
<key>com.apple.developer.ubiquity-container-identifiers</key>
<array>
    <string>iCloud.com.yourcompany.yourapp</string>
</array>
```

### When NOT to Use iCloud Documents

- **Sensitive data** - Use Keychain or encrypted local storage instead
- **High-frequency writes** - iCloud sync has latency; use local + periodic sync
- **Large media files** - Consider CloudKit Assets or on-demand resources
- **Shared between users** - iCloud Documents is single-user; use CloudKit for sharing
</ios_storage>

<background_execution>
## Background Execution & Resumption

> **Needs validation:** These patterns work but better solutions may exist.

Mobile apps can be suspended or terminated at any time. Agents must handle this gracefully.

### The Challenge

```
User starts research agent
     ↓
Agent begins web search
     ↓
User switches to another app
     ↓
iOS suspends your app
     ↓
Agent is mid-execution... what happens?
```

### Checkpoint/Resume Pattern

Save agent state before backgrounding, restore on foreground:

```swift
class AgentOrchestrator: ObservableObject {
    @Published var activeSessions: [AgentSession] = []

    // Called when app is about to background
    func handleAppWillBackground() {
        for session in activeSessions {
            saveCheckpoint(session)
            session.transition(to: .backgrounded)
        }
    }

    // Called when app returns to foreground
    func handleAppDidForeground() {
        for session in activeSessions where session.state == .backgrounded {
            if let checkpoint = loadCheckpoint(session.id) {
                resumeFromCheckpoint(session, checkpoint)
            }
        }
    }

    private func saveCheckpoint(_ session: AgentSession) {
        let checkpoint = AgentCheckpoint(
            sessionId: session.id,
            conversationHistory: session.messages,
            pendingToolCalls: session.pendingToolCalls,
            partialResults: session.partialResults,
            timestamp: Date()
        )
        storage.save(checkpoint, for: session.id)
    }

    private func resumeFromCheckpoint(_ session: AgentSession, _ checkpoint: AgentCheckpoint) {
        session.messages = checkpoint.conversationHistory
        session.pendingToolCalls = checkpoint.pendingToolCalls

        // Resume execution if there were pending tool calls
        if !checkpoint.pendingToolCalls.isEmpty {
            session.transition(to: .running)
            Task { await executeNextTool(session) }
        }
    }
}
```

### State Machine for Agent Lifecycle

```swift
enum AgentState {
    case idle           // Not running
    case running        // Actively executing
    case waitingForUser // Paused, waiting for user input
    case backgrounded   // App backgrounded, state saved
    case completed      // Finished successfully
    case failed(Error)  // Finished with error
}

class AgentSession: ObservableObject {
    @Published var state: AgentState = .idle

    func transition(to newState: AgentState) {
        let validTransitions: [AgentState: Set<AgentState>] = [
            .idle: [.running],
            .running: [.waitingForUser, .backgrounded, .completed, .failed],
            .waitingForUser: [.running, .backgrounded],
            .backgrounded: [.running, .completed],
        ]

        guard validTransitions[state]?.contains(newState) == true else {
            logger.warning("Invalid transition: \(state) → \(newState)")
            return
        }

        state = newState
    }
}
```

### Background Task Extension (iOS)

Request extra time when backgrounded during critical operations:

```swift
class AgentOrchestrator {
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    func handleAppWillBackground() {
        // Request extra time for saving state
        backgroundTask = UIApplication.shared.beginBackgroundTask { [weak self] in
            self?.endBackgroundTask()
        }

        // Save all checkpoints
        Task {
            for session in activeSessions {
                await saveCheckpoint(session)
            }
            endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }
}
```

### User Communication

Let users know what's happening:

```swift
struct AgentStatusView: View {
    @ObservedObject var session: AgentSession

    var body: some View {
        switch session.state {
        case .backgrounded:
            Label("Paused (app in background)", systemImage: "pause.circle")
                .foregroundColor(.orange)
        case .running:
            Label("Working...", systemImage: "ellipsis.circle")
                .foregroundColor(.blue)
        case .waitingForUser:
            Label("Waiting for your input", systemImage: "person.circle")
                .foregroundColor(.green)
        // ...
        }
    }
}
```
</background_execution>

<permissions>
## Permission Handling

Mobile agents may need access to system resources. Handle permission requests gracefully.

### Common Permissions

| Resource | iOS Permission | Use Case |
|----------|---------------|----------|
| Photo Library | PHPhotoLibrary | Profile generation from photos |
| Files | Document picker | Reading user documents |
| Camera | AVCaptureDevice | Scanning book covers |
| Location | CLLocationManager | Location-aware recommendations |
| Network | (automatic) | Web search, API calls |

### Permission-Aware Tools

Check permissions before executing:

```swift
struct PhotoTools {
    static func readPhotos() -> AgentTool {
        tool(
            name: "read_photos",
            description: "Read photos from the user's photo library",
            parameters: [
                "limit": .number("Maximum photos to read"),
                "dateRange": .string("Date range filter").optional()
            ],
            execute: { params, context in
                // Check permission first
                let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)

                switch status {
                case .authorized, .limited:
                    // Proceed with reading photos
                    let photos = await fetchPhotos(params)
                    return ToolResult(text: "Found \(photos.count) photos", images: photos)

                case .denied, .restricted:
                    return ToolResult(
                        text: "Photo access needed. Please grant permission in Settings → Privacy → Photos.",
                        isError: true
                    )

                case .notDetermined:
                    return ToolResult(
                        text: "Photo permission required. Please try again.",
                        isError: true
                    )

                @unknown default:
                    return ToolResult(text: "Unknown permission status", isError: true)
                }
            }
        )
    }
}
```

### Graceful Degradation

When permissions aren't granted, offer alternatives:

```swift
func readPhotos() async -> ToolResult {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)

    switch status {
    case .denied, .restricted:
        // Suggest alternative
        return ToolResult(
            text: """
            I don't have access to your photos. You can either:
            1. Grant access in Settings → Privacy → Photos
            2. Share specific photos directly in our chat

            Would you like me to help with something else instead?
            """,
            isError: false  // Not a hard error, just a limitation
        )
    // ...
    }
}
```

### Permission Request Timing

Don't request permissions until needed:

```swift
// BAD: Request all permissions at launch
func applicationDidFinishLaunching() {
    requestPhotoAccess()
    requestCameraAccess()
    requestLocationAccess()
    // User is overwhelmed with permission dialogs
}

// GOOD: Request when the feature is used
tool("analyze_book_cover", async ({ image }) => {
    // Only request camera access when user tries to scan a cover
    let status = await AVCaptureDevice.requestAccess(for: .video)
    if status {
        return await scanCover(image)
    } else {
        return ToolResult(text: "Camera access needed for book scanning")
    }
})
```
</permissions>

<cost_awareness>
## Cost-Aware Design

Mobile users may be on cellular data or concerned about API costs. Design agents to be efficient.

### Model Tier Selection

Use the cheapest model that achieves the outcome:

```swift
enum ModelTier {
    case fast      // claude-3-haiku: ~$0.25/1M tokens
    case balanced  // claude-3-sonnet: ~$3/1M tokens
    case powerful  // claude-3-opus: ~$15/1M tokens

    var modelId: String {
        switch self {
        case .fast: return "claude-3-haiku-20240307"
        case .balanced: return "claude-3-sonnet-20240229"
        case .powerful: return "claude-3-opus-20240229"
        }
    }
}

// Match model to task complexity
let agentConfigs: [AgentType: ModelTier] = [
    .quickLookup: .fast,        // "What's in my library?"
    .chatAssistant: .balanced,  // General conversation
    .researchAgent: .balanced,  // Web search + synthesis
    .profileGenerator: .powerful, // Complex photo analysis
    .introductionWriter: .balanced,
]
```

### Token Budgets

Limit tokens per agent session:

```swift
struct AgentConfig {
    let modelTier: ModelTier
    let maxInputTokens: Int
    let maxOutputTokens: Int
    let maxTurns: Int

    static let research = AgentConfig(
        modelTier: .balanced,
        maxInputTokens: 50_000,
        maxOutputTokens: 4_000,
        maxTurns: 20
    )

    static let quickChat = AgentConfig(
        modelTier: .fast,
        maxInputTokens: 10_000,
        maxOutputTokens: 1_000,
        maxTurns: 5
    )
}

class AgentSession {
    var totalTokensUsed: Int = 0

    func checkBudget() -> Bool {
        if totalTokensUsed > config.maxInputTokens {
            transition(to: .failed(AgentError.budgetExceeded))
            return false
        }
        return true
    }
}
```

### Network-Aware Execution

Defer heavy operations to WiFi:

```swift
class NetworkMonitor: ObservableObject {
    @Published var isOnWiFi: Bool = false
    @Published var isExpensive: Bool = false  // Cellular or hotspot

    private let monitor = NWPathMonitor()

    func startMonitoring() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.isOnWiFi = path.usesInterfaceType(.wifi)
                self?.isExpensive = path.isExpensive
            }
        }
        monitor.start(queue: .global())
    }
}

class AgentOrchestrator {
    @ObservedObject var network = NetworkMonitor()

    func startResearchAgent(for book: Book) async {
        if network.isExpensive {
            // Warn user or defer
            let proceed = await showAlert(
                "Research uses data",
                message: "This will use approximately 1-2 MB of cellular data. Continue?"
            )
            if !proceed { return }
        }

        // Proceed with research
        await runAgent(ResearchAgent.create(book: book))
    }
}
```

### Batch API Calls

Combine multiple small requests:

```swift
// BAD: Many small API calls
for book in books {
    await agent.chat("Summarize \(book.title)")
}

// GOOD: Batch into one request
let bookList = books.map { $0.title }.joined(separator: ", ")
await agent.chat("Summarize each of these books briefly: \(bookList)")
```

### Caching

Cache expensive operations:

```swift
class ResearchCache {
    private var cache: [String: CachedResearch] = [:]

    func getCachedResearch(for bookId: String) -> CachedResearch? {
        guard let cached = cache[bookId] else { return nil }

        // Expire after 24 hours
        if Date().timeIntervalSince(cached.timestamp) > 86400 {
            cache.removeValue(forKey: bookId)
            return nil
        }

        return cached
    }

    func cacheResearch(_ research: Research, for bookId: String) {
        cache[bookId] = CachedResearch(
            research: research,
            timestamp: Date()
        )
    }
}

// In research tool
tool("web_search", async ({ query, bookId }) => {
    // Check cache first
    if let cached = cache.getCachedResearch(for: bookId) {
        return ToolResult(text: cached.research.summary, cached: true)
    }

    // Otherwise, perform search
    let results = await webSearch(query)
    cache.cacheResearch(results, for: bookId)
    return ToolResult(text: results.summary)
})
```

### Cost Visibility

Show users what they're spending:

```swift
struct AgentCostView: View {
    @ObservedObject var session: AgentSession

    var body: some View {
        VStack(alignment: .leading) {
            Text("Session Stats")
                .font(.headline)

            HStack {
                Label("\(session.turnCount) turns", systemImage: "arrow.2.squarepath")
                Spacer()
                Label(formatTokens(session.totalTokensUsed), systemImage: "text.word.spacing")
            }

            if let estimatedCost = session.estimatedCost {
                Text("Est. cost: \(estimatedCost, format: .currency(code: "USD"))")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
}
```
</cost_awareness>

<offline_handling>
## Offline Graceful Degradation

Handle offline scenarios gracefully:

```swift
class ConnectivityAwareAgent {
    @ObservedObject var network = NetworkMonitor()

    func executeToolCall(_ toolCall: ToolCall) async -> ToolResult {
        // Check if tool requires network
        let requiresNetwork = ["web_search", "web_fetch", "call_api"]
            .contains(toolCall.name)

        if requiresNetwork && !network.isConnected {
            return ToolResult(
                text: """
                I can't access the internet right now. Here's what I can do offline:
                - Read your library and existing research
                - Answer questions from cached data
                - Write notes and drafts for later

                Would you like me to try something that works offline?
                """,
                isError: false
            )
        }

        return await executeOnline(toolCall)
    }
}
```

### Offline-First Tools

Some tools should work entirely offline:

```swift
let offlineTools: Set<String> = [
    "read_file",
    "write_file",
    "list_files",
    "read_library",  // Local database
    "search_local",  // Local search
]

let onlineTools: Set<String> = [
    "web_search",
    "web_fetch",
    "publish_to_cloud",
]

let hybridTools: Set<String> = [
    "publish_to_feed",  // Works offline, syncs later
]
```

### Queued Actions

Queue actions that require connectivity:

```swift
class OfflineQueue: ObservableObject {
    @Published var pendingActions: [QueuedAction] = []

    func queue(_ action: QueuedAction) {
        pendingActions.append(action)
        persist()
    }

    func processWhenOnline() {
        network.$isConnected
            .filter { $0 }
            .sink { [weak self] _ in
                self?.processPendingActions()
            }
    }

    private func processPendingActions() {
        for action in pendingActions {
            Task {
                try await execute(action)
                remove(action)
            }
        }
    }
}
```
</offline_handling>

<battery_awareness>
## Battery-Aware Execution

Respect device battery state:

```swift
class BatteryMonitor: ObservableObject {
    @Published var batteryLevel: Float = 1.0
    @Published var isCharging: Bool = false
    @Published var isLowPowerMode: Bool = false

    var shouldDeferHeavyWork: Bool {
        return batteryLevel < 0.2 && !isCharging
    }

    func startMonitoring() {
        UIDevice.current.isBatteryMonitoringEnabled = true

        NotificationCenter.default.addObserver(
            forName: UIDevice.batteryLevelDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.batteryLevel = UIDevice.current.batteryLevel
        }

        NotificationCenter.default.addObserver(
            forName: NSNotification.Name.NSProcessInfoPowerStateDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
    }
}

class AgentOrchestrator {
    @ObservedObject var battery = BatteryMonitor()

    func startAgent(_ config: AgentConfig) async {
        if battery.shouldDeferHeavyWork && config.isHeavy {
            let proceed = await showAlert(
                "Low Battery",
                message: "This task uses significant battery. Continue or defer until charging?"
            )
            if !proceed { return }
        }

        // Adjust model tier based on battery
        let adjustedConfig = battery.isLowPowerMode
            ? config.withModelTier(.fast)
            : config

        await runAgent(adjustedConfig)
    }
}
```
</battery_awareness>

<on_device_vs_cloud>
## On-Device vs. Cloud

Understanding what runs where in a mobile agent-native app:

| Component | On-Device | Cloud |
|-----------|-----------|-------|
| Orchestration | ✅ | |
| Tool execution | ✅ (file ops, photo access, HealthKit) | |
| LLM calls | | ✅ (Anthropic API) |
| Checkpoints | ✅ (local files) | Optional via iCloud |
| Long-running agents | Limited by iOS | Possible with server |

### Implications

**Network required for reasoning:**
- The app needs network connectivity for LLM calls
- Design tools to degrade gracefully when network is unavailable
- Consider offline caching for common queries

**Data stays local:**
- File operations happen on device
- Sensitive data never leaves the device unless explicitly synced
- Privacy is preserved by default

**Long-running agents:**
For truly long-running agents (hours), consider a server-side orchestrator that can run indefinitely, with the mobile app as a viewer and input mechanism.
</on_device_vs_cloud>

<checklist>
## Mobile Agent-Native Checklist

**iOS Storage:**
- [ ] iCloud Documents as primary storage (or conscious alternative)
- [ ] Local Documents fallback when iCloud unavailable
- [ ] Handle `.icloud` placeholder files (trigger download)
- [ ] Use NSFileCoordinator for conflict-safe writes

**Background Execution:**
- [ ] Checkpoint/resume implemented for all agent sessions
- [ ] State machine for agent lifecycle (idle, running, backgrounded, etc.)
- [ ] Background task extension for critical saves (30 second window)
- [ ] User-visible status for backgrounded agents

**Permissions:**
- [ ] Permissions requested only when needed, not at launch
- [ ] Graceful degradation when permissions denied
- [ ] Clear error messages with Settings deep links
- [ ] Alternative paths when permissions unavailable

**Cost Awareness:**
- [ ] Model tier matched to task complexity
- [ ] Token budgets per session
- [ ] Network-aware (defer heavy work to WiFi)
- [ ] Caching for expensive operations
- [ ] Cost visibility to users

**Offline Handling:**
- [ ] Offline-capable tools identified
- [ ] Graceful degradation for online-only features
- [ ] Action queue for sync when online
- [ ] Clear user communication about offline state

**Battery Awareness:**
- [ ] Battery monitoring for heavy operations
- [ ] Low power mode detection
- [ ] Defer or downgrade based on battery state
</checklist>

---

## Source: agent-native-architecture/references / product-implications.md

<overview>
Agent-native architecture has consequences for how products feel, not just how they're built. This document covers progressive disclosure of complexity, discovering latent demand through agent usage, and designing approval flows that match stakes and reversibility.
</overview>

<progressive_disclosure>
## Progressive Disclosure of Complexity

The best agent-native applications are simple to start but endlessly powerful.

### The Excel Analogy

Excel is the canonical example: you can use it for a grocery list, or you can build complex financial models. The same tool, radically different depths of use.

Claude Code has this quality: fix a typo, or refactor an entire codebase. The interface is the same—natural language—but the capability scales with the ask.

### The Pattern

Agent-native applications should aspire to this:

**Simple entry:** Basic requests work immediately with no learning curve
```
User: "Organize my downloads"
Agent: [Does it immediately, no configuration needed]
```

**Discoverable depth:** Users find they can do more as they explore
```
User: "Organize my downloads by project"
Agent: [Adapts to preference]

User: "Every Monday, review last week's downloads"
Agent: [Sets up recurring workflow]
```

**No ceiling:** Power users can push the system in ways you didn't anticipate
```
User: "Cross-reference my downloads with my calendar and flag
       anything I downloaded during a meeting that I haven't
       followed up on"
Agent: [Composes capabilities to accomplish this]
```

### How This Emerges

This isn't something you design directly. It **emerges naturally from the architecture:**

1. When features are prompts and tools are composable...
2. Users can start simple ("organize my downloads")...
3. And gradually discover complexity ("every Monday, review last week's...")...
4. Without you having to build each level explicitly

The agent meets users where they are.

### Design Implications

- **Don't force configuration upfront** - Let users start immediately
- **Don't hide capabilities** - Make them discoverable through use
- **Don't cap complexity** - If the agent can do it, let users ask for it
- **Do provide hints** - Help users discover what's possible
</progressive_disclosure>

<latent_demand_discovery>
## Latent Demand Discovery

Traditional product development: imagine what users want, build it, see if you're right.

Agent-native product development: build a capable foundation, observe what users ask the agent to do, formalize the patterns that emerge.

### The Shift

**Traditional approach:**
```
1. Imagine features users might want
2. Build them
3. Ship
4. Hope you guessed right
5. If wrong, rebuild
```

**Agent-native approach:**
```
1. Build capable foundation (atomic tools, parity)
2. Ship
3. Users ask agent for things
4. Observe what they're asking for
5. Patterns emerge
6. Formalize patterns into domain tools or prompts
7. Repeat
```

### The Flywheel

```
Build with atomic tools and parity
           ↓
Users ask for things you didn't anticipate
           ↓
Agent composes tools to accomplish them
(or fails, revealing a capability gap)
           ↓
You observe patterns in what's being requested
           ↓
Add domain tools or prompts to optimize common patterns
           ↓
(Repeat)
```

### What You Learn

**When users ask and the agent succeeds:**
- This is a real need
- Your architecture supports it
- Consider optimizing with a domain tool if it's common

**When users ask and the agent fails:**
- This is a real need
- You have a capability gap
- Fix the gap: add tool, fix parity, improve context

**When users don't ask for something:**
- Maybe they don't need it
- Or maybe they don't know it's possible (capability hiding)

### Implementation

**Log agent requests:**
```typescript
async function handleAgentRequest(request: string) {
  // Log what users are asking for
  await analytics.log({
    type: 'agent_request',
    request: request,
    timestamp: Date.now(),
  });

  // Process request...
}
```

**Track success/failure:**
```typescript
async function completeAgentSession(session: AgentSession) {
  await analytics.log({
    type: 'agent_session',
    request: session.initialRequest,
    succeeded: session.status === 'completed',
    toolsUsed: session.toolCalls.map(t => t.name),
    iterations: session.iterationCount,
  });
}
```

**Review patterns:**
- What are users asking for most?
- What's failing? Why?
- What would benefit from a domain tool?
- What needs better context injection?

### Example: Discovering "Weekly Review"

```
Week 1: Users start asking "summarize my activity this week"
        Agent: Composes list_files + read_file, works but slow

Week 2: More users asking similar things
        Pattern emerges: weekly review is common

Week 3: Add prompt section for weekly review
        Faster, more consistent, still flexible

Week 4: If still common and performance matters
        Add domain tool: generate_weekly_summary
```

You didn't have to guess that weekly review would be popular. You discovered it.
</latent_demand_discovery>

<approval_and_agency>
## Approval and User Agency

When agents take unsolicited actions—doing things on their own rather than responding to explicit requests—you need to decide how much autonomy to grant.

> **Note:** This framework applies to unsolicited agent actions. If the user explicitly asks the agent to do something ("send that email"), that's already approval—the agent just does it.

### The Stakes/Reversibility Matrix

Consider two dimensions:
- **Stakes:** How much does it matter if this goes wrong?
- **Reversibility:** How easy is it to undo?

| Stakes | Reversibility | Pattern | Example |
|--------|---------------|---------|---------|
| Low | Easy | **Auto-apply** | Organizing files |
| Low | Hard | **Quick confirm** | Publishing to a private feed |
| High | Easy | **Suggest + apply** | Code changes with undo |
| High | Hard | **Explicit approval** | Sending emails, payments |

### Patterns in Detail

**Auto-apply (low stakes, easy reversal):**
```
Agent: [Organizes files into folders]
Agent: "I organized your downloads into folders by type.
        You can undo with Cmd+Z or move them back."
```
User doesn't need to approve—it's easy to undo and doesn't matter much.

**Quick confirm (low stakes, hard reversal):**
```
Agent: "I've drafted a post about your reading insights.
        Publish to your feed?"
        [Publish] [Edit first] [Cancel]
```
One-tap confirm because stakes are low, but it's hard to un-publish.

**Suggest + apply (high stakes, easy reversal):**
```
Agent: "I recommend these code changes to fix the bug:
        [Shows diff]
        Apply? Changes can be reverted with git."
        [Apply] [Modify] [Cancel]
```
Shows what will happen, makes reversal clear.

**Explicit approval (high stakes, hard reversal):**
```
Agent: "I've drafted this email to your team about the deadline change:
        [Shows full email]
        This will send immediately and cannot be unsent.
        Type 'send' to confirm."
```
Requires explicit action, makes consequences clear.

### Implementation

```swift
enum ApprovalLevel {
    case autoApply       // Just do it
    case quickConfirm    // One-tap approval
    case suggestApply    // Show preview, ask to apply
    case explicitApproval // Require explicit confirmation
}

func approvalLevelFor(action: AgentAction) -> ApprovalLevel {
    let stakes = assessStakes(action)
    let reversibility = assessReversibility(action)

    switch (stakes, reversibility) {
    case (.low, .easy): return .autoApply
    case (.low, .hard): return .quickConfirm
    case (.high, .easy): return .suggestApply
    case (.high, .hard): return .explicitApproval
    }
}

func assessStakes(_ action: AgentAction) -> Stakes {
    switch action {
    case .organizeFiles: return .low
    case .publishToFeed: return .low
    case .modifyCode: return .high
    case .sendEmail: return .high
    case .makePayment: return .high
    }
}

func assessReversibility(_ action: AgentAction) -> Reversibility {
    switch action {
    case .organizeFiles: return .easy  // Can move back
    case .publishToFeed: return .hard  // People might see it
    case .modifyCode: return .easy     // Git revert
    case .sendEmail: return .hard      // Can't unsend
    case .makePayment: return .hard    // Money moved
    }
}
```

### Self-Modification Considerations

When agents can modify their own behavior—changing prompts, updating preferences, adjusting workflows—the goals are:

1. **Visibility:** User can see what changed
2. **Understanding:** User understands the effects
3. **Rollback:** User can undo changes

Approval flows are one way to achieve this. Audit logs with easy rollback could be another. **The principle is: make it legible.**

```swift
// When agent modifies its own prompt
func agentSelfModify(change: PromptChange) async {
    // Log the change
    await auditLog.record(change)

    // Create checkpoint for rollback
    await createCheckpoint(currentState)

    // Notify user (could be async/batched)
    await notifyUser("I've adjusted my approach: \(change.summary)")

    // Apply change
    await applyChange(change)
}
```
</approval_and_agency>

<capability_visibility>
## Capability Visibility

Users need to discover what the agent can do. Hidden capabilities lead to underutilization.

### The Problem

```
User: "Help me with my reading"
Agent: "What would you like help with?"
// Agent doesn't mention it can publish to feed, research books,
// generate introductions, analyze themes...
```

The agent can do these things, but the user doesn't know.

### Solutions

**Onboarding hints:**
```
Agent: "I can help you with your reading in several ways:
        - Research any book (web search + save findings)
        - Generate personalized introductions
        - Publish insights to your reading feed
        - Analyze themes across your library
        What interests you?"
```

**Contextual suggestions:**
```
User: "I just finished reading 1984"
Agent: "Great choice! Would you like me to:
        - Research historical context?
        - Compare it to other books in your library?
        - Publish an insight about it to your feed?"
```

**Progressive revelation:**
```
// After user uses basic features
Agent: "By the way, you can also ask me to set up
        recurring tasks, like 'every Monday, review my
        reading progress.' Just let me know!"
```

### Balance

- **Don't overwhelm** with all capabilities upfront
- **Do reveal** capabilities naturally through use
- **Don't assume** users will discover things on their own
- **Do make** capabilities visible when relevant
</capability_visibility>

<designing_for_trust>
## Designing for Trust

Agent-native apps require trust. Users are giving an AI significant capability. Build trust through:

### Transparency

- Show what the agent is doing (tool calls, progress)
- Explain reasoning when it matters
- Make all agent work inspectable (files, logs)

### Predictability

- Consistent behavior for similar requests
- Clear patterns for when approval is needed
- No surprises in what the agent can access

### Reversibility

- Easy undo for agent actions
- Checkpoints before significant changes
- Clear rollback paths

### Control

- User can stop agent at any time
- User can adjust agent behavior (prompts, preferences)
- User can restrict capabilities if desired

### Implementation

```swift
struct AgentTransparency {
    // Show what's happening
    func onToolCall(_ tool: ToolCall) {
        showInUI("Using \(tool.name)...")
    }

    // Explain reasoning
    func onDecision(_ decision: AgentDecision) {
        if decision.needsExplanation {
            showInUI("I chose this because: \(decision.reasoning)")
        }
    }

    // Make work inspectable
    func onOutput(_ output: AgentOutput) {
        // All output is in files user can see
        // Or in visible UI state
    }
}
```
</designing_for_trust>

<checklist>
## Product Design Checklist

### Progressive Disclosure
- [ ] Basic requests work immediately (no config)
- [ ] Depth is discoverable through use
- [ ] No artificial ceiling on complexity
- [ ] Capability hints provided

### Latent Demand Discovery
- [ ] Agent requests are logged
- [ ] Success/failure is tracked
- [ ] Patterns are reviewed regularly
- [ ] Common patterns formalized into tools/prompts

### Approval & Agency
- [ ] Stakes assessed for each action type
- [ ] Reversibility assessed for each action type
- [ ] Approval pattern matches stakes/reversibility
- [ ] Self-modification is legible (visible, understandable, reversible)

### Capability Visibility
- [ ] Onboarding reveals key capabilities
- [ ] Contextual suggestions provided
- [ ] Users aren't expected to guess what's possible

### Trust
- [ ] Agent actions are transparent
- [ ] Behavior is predictable
- [ ] Actions are reversible
- [ ] User has control
</checklist>

---

## Source: agent-native-architecture/references / refactoring-to-prompt-native.md

<overview>
How to refactor existing agent code to follow prompt-native principles. The goal: move behavior from code into prompts, and simplify tools into primitives.
</overview>

<diagnosis>
## Diagnosing Non-Prompt-Native Code

Signs your agent isn't prompt-native:

**Tools that encode workflows:**
```typescript
// RED FLAG: Tool contains business logic
tool("process_feedback", async ({ message }) => {
  const category = categorize(message);        // Logic in code
  const priority = calculatePriority(message); // Logic in code
  await store(message, category, priority);    // Orchestration in code
  if (priority > 3) await notify();            // Decision in code
});
```

**Agent calls functions instead of figuring things out:**
```typescript
// RED FLAG: Agent is just a function caller
"Use process_feedback to handle incoming messages"
// vs.
"When feedback comes in, decide importance, store it, notify if high"
```

**Artificial limits on agent capability:**
```typescript
// RED FLAG: Tool prevents agent from doing what users can do
tool("read_file", async ({ path }) => {
  if (!ALLOWED_PATHS.includes(path)) {
    throw new Error("Not allowed to read this file");
  }
  return readFile(path);
});
```

**Prompts that specify HOW instead of WHAT:**
```markdown
// RED FLAG: Micromanaging the agent
When creating a summary:
1. Use exactly 3 bullet points
2. Each bullet must be under 20 words
3. Format with em-dashes for sub-points
4. Bold the first word of each bullet
```
</diagnosis>

<refactoring_workflow>
## Step-by-Step Refactoring

**Step 1: Identify workflow tools**

List all your tools. Mark any that:
- Have business logic (categorize, calculate, decide)
- Orchestrate multiple operations
- Make decisions on behalf of the agent
- Contain conditional logic (if/else based on content)

**Step 2: Extract the primitives**

For each workflow tool, identify the underlying primitives:

| Workflow Tool | Hidden Primitives |
|---------------|-------------------|
| `process_feedback` | `store_item`, `send_message` |
| `generate_report` | `read_file`, `write_file` |
| `deploy_and_notify` | `git_push`, `send_message` |

**Step 3: Move behavior to the prompt**

Take the logic from your workflow tools and express it in natural language:

```typescript
// Before (in code):
async function processFeedback(message) {
  const priority = message.includes("crash") ? 5 :
                   message.includes("bug") ? 4 : 3;
  await store(message, priority);
  if (priority >= 4) await notify();
}
```

```markdown
// After (in prompt):
## Feedback Processing

When someone shares feedback:
1. Rate importance 1-5:
   - 5: Crashes, data loss, security issues
   - 4: Bug reports with clear reproduction steps
   - 3: General suggestions, minor issues
2. Store using store_item
3. If importance >= 4, notify the team

Use your judgment. Context matters more than keywords.
```

**Step 4: Simplify tools to primitives**

```typescript
// Before: 1 workflow tool
tool("process_feedback", { message, category, priority }, ...complex logic...)

// After: 2 primitive tools
tool("store_item", { key: z.string(), value: z.any() }, ...simple storage...)
tool("send_message", { channel: z.string(), content: z.string() }, ...simple send...)
```

**Step 5: Remove artificial limits**

```typescript
// Before: Limited capability
tool("read_file", async ({ path }) => {
  if (!isAllowed(path)) throw new Error("Forbidden");
  return readFile(path);
});

// After: Full capability
tool("read_file", async ({ path }) => {
  return readFile(path);  // Agent can read anything
});
// Use approval gates for WRITES, not artificial limits on READS
```

**Step 6: Test with outcomes, not procedures**

Instead of testing "does it call the right function?", test "does it achieve the outcome?"

```typescript
// Before: Testing procedure
expect(mockProcessFeedback).toHaveBeenCalledWith(...)

// After: Testing outcome
// Send feedback → Check it was stored with reasonable importance
// Send high-priority feedback → Check notification was sent
```
</refactoring_workflow>

<before_after>
## Before/After Examples

**Example 1: Feedback Processing**

Before:
```typescript
tool("handle_feedback", async ({ message, author }) => {
  const category = detectCategory(message);
  const priority = calculatePriority(message, category);
  const feedbackId = await db.feedback.insert({
    id: generateId(),
    author,
    message,
    category,
    priority,
    timestamp: new Date().toISOString(),
  });

  if (priority >= 4) {
    await discord.send(ALERT_CHANNEL, `High priority feedback from ${author}`);
  }

  return { feedbackId, category, priority };
});
```

After:
```typescript
// Simple storage primitive
tool("store_feedback", async ({ item }) => {
  await db.feedback.insert(item);
  return { text: `Stored feedback ${item.id}` };
});

// Simple message primitive
tool("send_message", async ({ channel, content }) => {
  await discord.send(channel, content);
  return { text: "Sent" };
});
```

System prompt:
```markdown
## Feedback Processing

When someone shares feedback:
1. Generate a unique ID
2. Rate importance 1-5 based on impact and urgency
3. Store using store_feedback with the full item
4. If importance >= 4, send a notification to the team channel

Importance guidelines:
- 5: Critical (crashes, data loss, security)
- 4: High (detailed bug reports, blocking issues)
- 3: Medium (suggestions, minor bugs)
- 2: Low (cosmetic, edge cases)
- 1: Minimal (off-topic, duplicates)
```

**Example 2: Report Generation**

Before:
```typescript
tool("generate_weekly_report", async ({ startDate, endDate, format }) => {
  const data = await fetchMetrics(startDate, endDate);
  const summary = summarizeMetrics(data);
  const charts = generateCharts(data);

  if (format === "html") {
    return renderHtmlReport(summary, charts);
  } else if (format === "markdown") {
    return renderMarkdownReport(summary, charts);
  } else {
    return renderPdfReport(summary, charts);
  }
});
```

After:
```typescript
tool("query_metrics", async ({ start, end }) => {
  const data = await db.metrics.query({ start, end });
  return { text: JSON.stringify(data, null, 2) };
});

tool("write_file", async ({ path, content }) => {
  writeFileSync(path, content);
  return { text: `Wrote ${path}` };
});
```

System prompt:
```markdown
## Report Generation

When asked to generate a report:
1. Query the relevant metrics using query_metrics
2. Analyze the data and identify key trends
3. Create a clear, well-formatted report
4. Write it using write_file in the appropriate format

Use your judgment about format and structure. Make it useful.
```
</before_after>

<common_challenges>
## Common Refactoring Challenges

**"But the agent might make mistakes!"**

Yes, and you can iterate. Change the prompt to add guidance:
```markdown
// Before
Rate importance 1-5.

// After (if agent keeps rating too high)
Rate importance 1-5. Be conservative—most feedback is 2-3.
Only use 4-5 for truly blocking or critical issues.
```

**"The workflow is complex!"**

Complex workflows can still be expressed in prompts. The agent is smart.
```markdown
When processing video feedback:
1. Check if it's a Loom, YouTube, or direct link
2. For YouTube, pass URL directly to video analysis
3. For others, download first, then analyze
4. Extract timestamped issues
5. Rate based on issue density and severity
```

**"We need deterministic behavior!"**

Some operations should stay in code. That's fine. Prompt-native isn't all-or-nothing.

Keep in code:
- Security validation
- Rate limiting
- Audit logging
- Exact format requirements

Move to prompts:
- Categorization decisions
- Priority judgments
- Content generation
- Workflow orchestration

**"What about testing?"**

Test outcomes, not procedures:
- "Given this input, does the agent achieve the right result?"
- "Does stored feedback have reasonable importance ratings?"
- "Are notifications sent for truly high-priority items?"
</common_challenges>

<checklist>
## Refactoring Checklist

Diagnosis:
- [ ] Listed all tools with business logic
- [ ] Identified artificial limits on agent capability
- [ ] Found prompts that micromanage HOW

Refactoring:
- [ ] Extracted primitives from workflow tools
- [ ] Moved business logic to system prompt
- [ ] Removed artificial limits
- [ ] Simplified tool inputs to data, not decisions

Validation:
- [ ] Agent achieves same outcomes with primitives
- [ ] Behavior can be changed by editing prompts
- [ ] New features could be added without new tools
</checklist>

---

## Source: agent-native-architecture/references / self-modification.md

<overview>
Self-modification is the advanced tier of agent native engineering: agents that can evolve their own code, prompts, and behavior. Not required for every app, but a big part of the future.

This is the logical extension of "whatever the developer can do, the agent can do."
</overview>

<why_self_modification>
## Why Self-Modification?

Traditional software is static—it does what you wrote, nothing more. Self-modifying agents can:

- **Fix their own bugs** - See an error, patch the code, restart
- **Add new capabilities** - User asks for something new, agent implements it
- **Evolve behavior** - Learn from feedback and adjust prompts
- **Deploy themselves** - Push code, trigger builds, restart

The agent becomes a living system that improves over time, not frozen code.
</why_self_modification>

<capabilities>
## What Self-Modification Enables

**Code modification:**
- Read and understand source files
- Write fixes and new features
- Commit and push to version control
- Trigger builds and verify they pass

**Prompt evolution:**
- Edit the system prompt based on feedback
- Add new features as prompt sections
- Refine judgment criteria that aren't working

**Infrastructure control:**
- Pull latest code from upstream
- Merge from other branches/instances
- Restart after changes
- Roll back if something breaks

**Site/output generation:**
- Generate and maintain websites
- Create documentation
- Build dashboards from data
</capabilities>

<guardrails>
## Required Guardrails

Self-modification is powerful. It needs safety mechanisms.

**Approval gates for code changes:**
```typescript
tool("write_file", async ({ path, content }) => {
  if (isCodeFile(path)) {
    // Store for approval, don't apply immediately
    pendingChanges.set(path, content);
    const diff = generateDiff(path, content);
    return { text: `Requires approval:\n\n${diff}\n\nReply "yes" to apply.` };
  }
  // Non-code files apply immediately
  writeFileSync(path, content);
  return { text: `Wrote ${path}` };
});
```

**Auto-commit before changes:**
```typescript
tool("self_deploy", async () => {
  // Save current state first
  runGit("stash");  // or commit uncommitted changes

  // Then pull/merge
  runGit("fetch origin");
  runGit("merge origin/main --no-edit");

  // Build and verify
  runCommand("npm run build");

  // Only then restart
  scheduleRestart();
});
```

**Build verification:**
```typescript
// Don't restart unless build passes
try {
  runCommand("npm run build", { timeout: 120000 });
} catch (error) {
  // Rollback the merge
  runGit("merge --abort");
  return { text: "Build failed, aborting deploy", isError: true };
}
```

**Health checks after restart:**
```typescript
tool("health_check", async () => {
  const uptime = process.uptime();
  const buildValid = existsSync("dist/index.js");
  const gitClean = !runGit("status --porcelain");

  return {
    text: JSON.stringify({
      status: "healthy",
      uptime: `${Math.floor(uptime / 60)}m`,
      build: buildValid ? "valid" : "missing",
      git: gitClean ? "clean" : "uncommitted changes",
    }, null, 2),
  };
});
```
</guardrails>

<git_architecture>
## Git-Based Self-Modification

Use git as the foundation for self-modification. It provides:
- Version history (rollback capability)
- Branching (experiment safely)
- Merge (sync with other instances)
- Push/pull (deploy and collaborate)

**Essential git tools:**
```typescript
tool("status", "Show git status", {}, ...);
tool("diff", "Show file changes", { path: z.string().optional() }, ...);
tool("log", "Show commit history", { count: z.number() }, ...);
tool("commit_code", "Commit code changes", { message: z.string() }, ...);
tool("git_push", "Push to GitHub", { branch: z.string().optional() }, ...);
tool("pull", "Pull from GitHub", { source: z.enum(["main", "instance"]) }, ...);
tool("rollback", "Revert recent commits", { commits: z.number() }, ...);
```

**Multi-instance architecture:**
```
main                      # Shared code
├── instance/bot-a       # Instance A's branch
├── instance/bot-b       # Instance B's branch
└── instance/bot-c       # Instance C's branch
```

Each instance can:
- Pull updates from main
- Push improvements back to main (via PR)
- Sync features from other instances
- Maintain instance-specific config
</git_architecture>

<prompt_evolution>
## Self-Modifying Prompts

The system prompt is a file the agent can read and write.

```typescript
// Agent can read its own prompt
tool("read_file", ...);  // Can read src/prompts/system.md

// Agent can propose changes
tool("write_file", ...);  // Can write to src/prompts/system.md (with approval)
```

**System prompt as living document:**
```markdown
## Feedback Processing

When someone shares feedback:
1. Acknowledge warmly
2. Rate importance 1-5
3. Store using feedback tools

<!-- Note to self: Video walkthroughs should always be 4-5,
     learned this from Dan's feedback on 2024-12-07 -->
```

The agent can:
- Add notes to itself
- Refine judgment criteria
- Add new feature sections
- Document edge cases it learned
</prompt_evolution>

<when_to_use>
## When to Implement Self-Modification

**Good candidates:**
- Long-running autonomous agents
- Agents that need to adapt to feedback
- Systems where behavior evolution is valuable
- Internal tools where rapid iteration matters

**Not necessary for:**
- Simple single-task agents
- Highly regulated environments
- Systems where behavior must be auditable
- One-off or short-lived agents

Start with a non-self-modifying prompt-native agent. Add self-modification when you need it.
</when_to_use>

<example_tools>
## Complete Self-Modification Toolset

```typescript
const selfMcpServer = createSdkMcpServer({
  name: "self",
  version: "1.0.0",
  tools: [
    // FILE OPERATIONS
    tool("read_file", "Read any project file", { path: z.string() }, ...),
    tool("write_file", "Write a file (code requires approval)", { path, content }, ...),
    tool("list_files", "List directory contents", { path: z.string() }, ...),
    tool("search_code", "Search for patterns", { pattern: z.string() }, ...),

    // APPROVAL WORKFLOW
    tool("apply_pending", "Apply approved changes", {}, ...),
    tool("get_pending", "Show pending changes", {}, ...),
    tool("clear_pending", "Discard pending changes", {}, ...),

    // RESTART
    tool("restart", "Rebuild and restart", {}, ...),
    tool("health_check", "Check if bot is healthy", {}, ...),
  ],
});

const gitMcpServer = createSdkMcpServer({
  name: "git",
  version: "1.0.0",
  tools: [
    // STATUS
    tool("status", "Show git status", {}, ...),
    tool("diff", "Show changes", { path: z.string().optional() }, ...),
    tool("log", "Show history", { count: z.number() }, ...),

    // COMMIT & PUSH
    tool("commit_code", "Commit code changes", { message: z.string() }, ...),
    tool("git_push", "Push to GitHub", { branch: z.string().optional() }, ...),

    // SYNC
    tool("pull", "Pull from upstream", { source: z.enum(["main", "instance"]) }, ...),
    tool("self_deploy", "Pull, build, restart", { source: z.enum(["main", "instance"]) }, ...),

    // SAFETY
    tool("rollback", "Revert commits", { commits: z.number() }, ...),
    tool("health_check", "Detailed health report", {}, ...),
  ],
});
```
</example_tools>

<checklist>
## Self-Modification Checklist

Before enabling self-modification:
- [ ] Git-based version control set up
- [ ] Approval gates for code changes
- [ ] Build verification before restart
- [ ] Rollback mechanism available
- [ ] Health check endpoint
- [ ] Instance identity configured

When implementing:
- [ ] Agent can read all project files
- [ ] Agent can write files (with appropriate approval)
- [ ] Agent can commit and push
- [ ] Agent can pull updates
- [ ] Agent can restart itself
- [ ] Agent can roll back if needed
</checklist>

---

## Source: agent-native-architecture/references / shared-workspace-architecture.md

<overview>
Agents and users should work in the same data space, not separate sandboxes. When the agent writes a file, the user can see it. When the user edits something, the agent can read the changes. This creates transparency, enables collaboration, and eliminates the need for sync layers.

**Core principle:** The agent operates in the same filesystem as the user, not a walled garden.
</overview>

<why_shared_workspace>
## Why Shared Workspace?

### The Sandbox Anti-Pattern

Many agent implementations isolate the agent:

```
┌─────────────────┐     ┌─────────────────┐
│   User Space    │     │   Agent Space   │
├─────────────────┤     ├─────────────────┤
│ Documents/      │     │ agent_output/   │
│ user_files/     │  ←→ │ temp_files/     │
│ settings.json   │sync │ cache/          │
└─────────────────┘     └─────────────────┘
```

Problems:
- Need a sync layer to move data between spaces
- User can't easily inspect agent work
- Agent can't build on user contributions
- Duplication of state
- Complexity in keeping spaces consistent

### The Shared Workspace Pattern

```
┌─────────────────────────────────────────┐
│           Shared Workspace              │
├─────────────────────────────────────────┤
│ Documents/                              │
│ ├── Research/                           │
│ │   └── {bookId}/        ← Agent writes │
│ │       ├── full_text.txt               │
│ │       ├── introduction.md  ← User can edit │
│ │       └── sources/                    │
│ ├── Chats/               ← Both read/write │
│ └── profile.md           ← Agent generates, user refines │
└─────────────────────────────────────────┘
         ↑                    ↑
       User                 Agent
       (UI)               (Tools)
```

Benefits:
- Users can inspect, edit, and extend agent work
- Agents can build on user contributions
- No synchronization layer needed
- Complete transparency
- Single source of truth
</why_shared_workspace>

<directory_structure>
## Designing Your Shared Workspace

### Structure by Domain

Organize by what the data represents, not who created it:

```
Documents/
├── Research/
│   └── {bookId}/
│       ├── full_text.txt        # Agent downloads
│       ├── introduction.md      # Agent generates, user can edit
│       ├── notes.md             # User adds, agent can read
│       └── sources/
│           └── {source}.md      # Agent gathers
├── Chats/
│   └── {conversationId}.json    # Both read/write
├── Exports/
│   └── {date}/                  # Agent generates for user
└── profile.md                   # Agent generates from photos
```

### Don't Structure by Actor

```
# BAD - Separates by who created it
Documents/
├── user_created/
│   └── notes.md
├── agent_created/
│   └── research.md
└── system/
    └── config.json
```

This creates artificial boundaries and makes collaboration harder.

### Use Conventions for Metadata

If you need to track who created/modified something:

```markdown
<!-- introduction.md -->
---
created_by: agent
created_at: 2024-01-15
last_modified_by: user
last_modified_at: 2024-01-16
---

# Introduction to Moby Dick

This personalized introduction was generated by your reading assistant
and refined by you on January 16th.
```
</directory_structure>

<file_tools>
## File Tools for Shared Workspace

Give the agent the same file primitives the app uses:

```swift
// iOS/Swift implementation
struct FileTools {
    static func readFile() -> AgentTool {
        tool(
            name: "read_file",
            description: "Read a file from the user's documents",
            parameters: ["path": .string("File path relative to Documents/")],
            execute: { params in
                let path = params["path"] as! String
                let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let fileURL = documentsURL.appendingPathComponent(path)
                let content = try String(contentsOf: fileURL)
                return ToolResult(text: content)
            }
        )
    }

    static func writeFile() -> AgentTool {
        tool(
            name: "write_file",
            description: "Write a file to the user's documents",
            parameters: [
                "path": .string("File path relative to Documents/"),
                "content": .string("File content")
            ],
            execute: { params in
                let path = params["path"] as! String
                let content = params["content"] as! String
                let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let fileURL = documentsURL.appendingPathComponent(path)

                // Create parent directories if needed
                try FileManager.default.createDirectory(
                    at: fileURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )

                try content.write(to: fileURL, atomically: true, encoding: .utf8)
                return ToolResult(text: "Wrote \(path)")
            }
        )
    }

    static func listFiles() -> AgentTool {
        tool(
            name: "list_files",
            description: "List files in a directory",
            parameters: ["path": .string("Directory path relative to Documents/")],
            execute: { params in
                let path = params["path"] as! String
                let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let dirURL = documentsURL.appendingPathComponent(path)
                let contents = try FileManager.default.contentsOfDirectory(atPath: dirURL.path)
                return ToolResult(text: contents.joined(separator: "\n"))
            }
        )
    }

    static func searchText() -> AgentTool {
        tool(
            name: "search_text",
            description: "Search for text across files",
            parameters: [
                "query": .string("Text to search for"),
                "path": .string("Directory to search in").optional()
            ],
            execute: { params in
                // Implement text search across documents
                // Return matching files and snippets
            }
        )
    }
}
```

### TypeScript/Node.js Implementation

```typescript
const fileTools = [
  tool(
    "read_file",
    "Read a file from the workspace",
    { path: z.string().describe("File path") },
    async ({ path }) => {
      const content = await fs.readFile(path, 'utf-8');
      return { text: content };
    }
  ),

  tool(
    "write_file",
    "Write a file to the workspace",
    {
      path: z.string().describe("File path"),
      content: z.string().describe("File content")
    },
    async ({ path, content }) => {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, content, 'utf-8');
      return { text: `Wrote ${path}` };
    }
  ),

  tool(
    "list_files",
    "List files in a directory",
    { path: z.string().describe("Directory path") },
    async ({ path }) => {
      const files = await fs.readdir(path);
      return { text: files.join('\n') };
    }
  ),

  tool(
    "append_file",
    "Append content to a file",
    {
      path: z.string().describe("File path"),
      content: z.string().describe("Content to append")
    },
    async ({ path, content }) => {
      await fs.appendFile(path, content, 'utf-8');
      return { text: `Appended to ${path}` };
    }
  ),
];
```
</file_tools>

<ui_integration>
## UI Integration with Shared Workspace

The UI should observe the same files the agent writes to:

### Pattern 1: File-Based Reactivity (iOS)

```swift
class ResearchViewModel: ObservableObject {
    @Published var researchFiles: [ResearchFile] = []

    private var watcher: DirectoryWatcher?

    func startWatching(bookId: String) {
        let researchPath = documentsURL
            .appendingPathComponent("Research")
            .appendingPathComponent(bookId)

        watcher = DirectoryWatcher(url: researchPath) { [weak self] in
            // Reload when agent writes new files
            self?.loadResearchFiles(from: researchPath)
        }

        loadResearchFiles(from: researchPath)
    }
}

// SwiftUI automatically updates when files change
struct ResearchView: View {
    @StateObject var viewModel = ResearchViewModel()

    var body: some View {
        List(viewModel.researchFiles) { file in
            ResearchFileRow(file: file)
        }
    }
}
```

### Pattern 2: Shared Data Store

When file-watching isn't practical, use a shared data store:

```swift
// Shared service that both UI and agent tools use
class BookLibraryService: ObservableObject {
    static let shared = BookLibraryService()

    @Published var books: [Book] = []
    @Published var analysisRecords: [AnalysisRecord] = []

    func addAnalysisRecord(_ record: AnalysisRecord) {
        analysisRecords.append(record)
        // Persists to shared storage
        saveToStorage()
    }
}

// Agent tool writes through the same service
tool("publish_to_feed", async ({ bookId, content, headline }) => {
    let record = AnalysisRecord(bookId: bookId, content: content, headline: headline)
    BookLibraryService.shared.addAnalysisRecord(record)
    return { text: "Published to feed" }
})

// UI observes the same service
struct FeedView: View {
    @StateObject var library = BookLibraryService.shared

    var body: some View {
        List(library.analysisRecords) { record in
            FeedItemRow(record: record)
        }
    }
}
```

### Pattern 3: Hybrid (Files + Index)

Use files for content, database for indexing:

```
Documents/
├── Research/
│   └── book_123/
│       └── introduction.md   # Actual content (file)

Database:
├── research_index
│   └── { bookId: "book_123", path: "Research/book_123/introduction.md", ... }
```

```swift
// Agent writes file
await writeFile("Research/\(bookId)/introduction.md", content)

// And updates index
await database.insert("research_index", {
    bookId: bookId,
    path: "Research/\(bookId)/introduction.md",
    title: extractTitle(content),
    createdAt: Date()
})

// UI queries index, then reads files
let items = database.query("research_index", where: bookId == "book_123")
for item in items {
    let content = readFile(item.path)
    // Display...
}
```
</ui_integration>

<collaboration_patterns>
## Agent-User Collaboration Patterns

### Pattern: Agent Drafts, User Refines

```
1. Agent generates introduction.md
2. User opens in Files app or in-app editor
3. User makes refinements
4. Agent can see changes via read_file
5. Future agent work builds on user refinements
```

The agent's system prompt should acknowledge this:

```markdown
## Working with User Content

When you create content (introductions, research notes, etc.), the user may
edit it afterward. Always read existing files before modifying them—the user
may have made improvements you should preserve.

If a file exists and has been modified by the user (check the metadata or
compare to your last known version), ask before overwriting.
```

### Pattern: User Seeds, Agent Expands

```
1. User creates notes.md with initial thoughts
2. User asks: "Research more about this"
3. Agent reads notes.md to understand context
4. Agent adds to notes.md or creates related files
5. User continues building on agent additions
```

### Pattern: Append-Only Collaboration

For chat logs or activity streams:

```markdown
<!-- activity.md - Both append, neither overwrites -->

## 2024-01-15

**User:** Started reading "Moby Dick"

**Agent:** Downloaded full text and created research folder

**User:** Added highlight about whale symbolism

**Agent:** Found 3 academic sources on whale symbolism in Melville's work
```
</collaboration_patterns>

<security_considerations>
## Security in Shared Workspace

### Scope the Workspace

Don't give agents access to the entire filesystem:

```swift
// GOOD: Scoped to app's documents
let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

tool("read_file", { path }) {
    // Path is relative to documents, can't escape
    let fileURL = documentsURL.appendingPathComponent(path)
    guard fileURL.path.hasPrefix(documentsURL.path) else {
        throw ToolError("Invalid path")
    }
    return try String(contentsOf: fileURL)
}

// BAD: Absolute paths allow escape
tool("read_file", { path }) {
    return try String(contentsOf: URL(fileURLWithPath: path))  // Can read /etc/passwd!
}
```

### Protect Sensitive Files

```swift
let protectedPaths = [".env", "credentials.json", "secrets/"]

tool("read_file", { path }) {
    if protectedPaths.any({ path.contains($0) }) {
        throw ToolError("Cannot access protected file")
    }
    // ...
}
```

### Audit Agent Actions

Log what the agent reads/writes:

```swift
func logFileAccess(action: String, path: String, agentId: String) {
    logger.info("[\(agentId)] \(action): \(path)")
}

tool("write_file", { path, content }) {
    logFileAccess(action: "WRITE", path: path, agentId: context.agentId)
    // ...
}
```
</security_considerations>

<examples>
## Real-World Example: Every Reader

The Every Reader app uses shared workspace for research:

```
Documents/
├── Research/
│   └── book_moby_dick/
│       ├── full_text.txt           # Agent downloads from Gutenberg
│       ├── introduction.md         # Agent generates, personalized
│       ├── sources/
│       │   ├── whale_symbolism.md  # Agent researches
│       │   └── melville_bio.md     # Agent researches
│       └── user_notes.md           # User can add their own notes
├── Chats/
│   └── 2024-01-15.json             # Chat history
└── profile.md                       # Agent generated from photos
```

**How it works:**

1. User adds "Moby Dick" to library
2. User starts research agent
3. Agent downloads full text to `Research/book_moby_dick/full_text.txt`
4. Agent researches and writes to `sources/`
5. Agent generates `introduction.md` based on user's reading profile
6. User can view all files in the app or Files.app
7. User can edit `introduction.md` to refine it
8. Chat agent can read all of this context when answering questions
</examples>

<icloud_sync>
## iCloud File Storage for Multi-Device Sync (iOS)

For agent-native iOS apps, use iCloud Drive's Documents folder for your shared workspace. This gives you **free, automatic multi-device sync** without building a sync layer or running a server.

### Why iCloud Documents?

| Approach | Cost | Complexity | Offline | Multi-Device |
|----------|------|------------|---------|--------------|
| Custom backend + sync | $$$ | High | Manual | Yes |
| CloudKit database | Free tier limits | Medium | Manual | Yes |
| **iCloud Documents** | Free (user's storage) | Low | Automatic | Automatic |

iCloud Documents:
- Uses user's existing iCloud storage (free 5GB, most users have more)
- Automatic sync across all user's devices
- Works offline, syncs when online
- Files visible in Files.app for transparency
- No server costs, no sync code to maintain

### Implementation Pattern

```swift
// Get the iCloud Documents container
func iCloudDocumentsURL() -> URL? {
    FileManager.default.url(forUbiquityContainerIdentifier: nil)?
        .appendingPathComponent("Documents")
}

// Your shared workspace lives in iCloud
class SharedWorkspace {
    let rootURL: URL

    init() {
        // Use iCloud if available, fall back to local
        if let iCloudURL = iCloudDocumentsURL() {
            self.rootURL = iCloudURL
        } else {
            // Fallback to local Documents (user not signed into iCloud)
            self.rootURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        }
    }

    // All file operations go through this root
    func researchPath(for bookId: String) -> URL {
        rootURL.appendingPathComponent("Research/\(bookId)")
    }

    func journalPath() -> URL {
        rootURL.appendingPathComponent("Journal")
    }
}
```

### Directory Structure in iCloud

```
iCloud Drive/
└── YourApp/                          # Your app's container
    └── Documents/                    # Visible in Files.app
        ├── Journal/
        │   ├── user/
        │   │   └── 2025-01-15.md     # Syncs across devices
        │   └── agent/
        │       └── 2025-01-15.md     # Agent observations sync too
        ├── Experiments/
        │   └── magnesium-sleep/
        │       ├── config.json
        │       └── log.json
        └── Research/
            └── {topic}/
                └── sources.md
```

### Handling Sync Conflicts

iCloud handles conflicts automatically, but you should design for it:

```swift
// Check for conflicts when reading
func readJournalEntry(at url: URL) throws -> JournalEntry {
    // iCloud may create .icloud placeholder files for not-yet-downloaded content
    if url.pathExtension == "icloud" {
        // Trigger download
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
        throw FileNotYetAvailableError()
    }

    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(JournalEntry.self, from: data)
}

// For writes, use coordinated file access
func writeJournalEntry(_ entry: JournalEntry, to url: URL) throws {
    let coordinator = NSFileCoordinator()
    var error: NSError?

    coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &error) { newURL in
        let data = try? JSONEncoder().encode(entry)
        try? data?.write(to: newURL)
    }

    if let error = error {
        throw error
    }
}
```

### What This Enables

1. **User starts experiment on iPhone** → Agent creates `Experiments/sleep-tracking/config.json`
2. **User opens app on iPad** → Same experiment visible, no sync code needed
3. **Agent logs observation on iPhone** → Syncs to iPad automatically
4. **User edits journal on iPad** → iPhone sees the edit

### Entitlements Required

Add to your app's entitlements:

```xml
<key>com.apple.developer.icloud-container-identifiers</key>
<array>
    <string>iCloud.com.yourcompany.yourapp</string>
</array>
<key>com.apple.developer.icloud-services</key>
<array>
    <string>CloudDocuments</string>
</array>
<key>com.apple.developer.ubiquity-container-identifiers</key>
<array>
    <string>iCloud.com.yourcompany.yourapp</string>
</array>
```

### When NOT to Use iCloud Documents

- **Sensitive data** - Use Keychain or encrypted local storage instead
- **High-frequency writes** - iCloud sync has latency; use local + periodic sync
- **Large media files** - Consider CloudKit Assets or on-demand resources
- **Shared between users** - iCloud Documents is single-user; use CloudKit for sharing
</icloud_sync>

<checklist>
## Shared Workspace Checklist

Architecture:
- [ ] Single shared directory for agent and user data
- [ ] Organized by domain, not by actor
- [ ] File tools scoped to workspace (no escape)
- [ ] Protected paths for sensitive files

Tools:
- [ ] `read_file` - Read any file in workspace
- [ ] `write_file` - Write any file in workspace
- [ ] `list_files` - Browse directory structure
- [ ] `search_text` - Find content across files (optional)

UI Integration:
- [ ] UI observes same files agent writes
- [ ] Changes reflect immediately (file watching or shared store)
- [ ] User can edit agent-created files
- [ ] Agent reads user modifications before overwriting

Collaboration:
- [ ] System prompt acknowledges user may edit files
- [ ] Agent checks for user modifications before overwriting
- [ ] Metadata tracks who created/modified (optional)

Multi-Device (iOS):
- [ ] Use iCloud Documents for shared workspace (free sync)
- [ ] Fallback to local Documents if iCloud unavailable
- [ ] Handle `.icloud` placeholder files (trigger download)
- [ ] Use NSFileCoordinator for conflict-safe writes
</checklist>

---

## Source: agent-native-architecture/references / system-prompt-design.md

<overview>
How to write system prompts for prompt-native agents. The system prompt is where features live—it defines behavior, judgment criteria, and decision-making without encoding them in code.
</overview>

<principle name="features-in-prompts">
## Features Are Prompt Sections

Each feature is a section of the system prompt that tells the agent how to behave.

**Traditional approach:** Feature = function in codebase
```typescript
function processFeedback(message) {
  const category = categorize(message);
  const priority = calculatePriority(message);
  await store(message, category, priority);
  if (priority > 3) await notify();
}
```

**Prompt-native approach:** Feature = section in system prompt
```markdown
## Feedback Processing

When someone shares feedback:
1. Read the message to understand what they're saying
2. Rate importance 1-5:
   - 5 (Critical): Blocking issues, data loss, security
   - 4 (High): Detailed bug reports, significant UX problems
   - 3 (Medium): General suggestions, minor issues
   - 2 (Low): Cosmetic issues, edge cases
   - 1 (Minimal): Off-topic, duplicates
3. Store using feedback.store_feedback
4. If importance >= 4, let the channel know you're tracking it

Use your judgment. Context matters.
```
</principle>

<structure>
## System Prompt Structure

A well-structured prompt-native system prompt:

```markdown
# Identity

You are [Name], [brief identity statement].

## Core Behavior

[What you always do, regardless of specific request]

## Feature: [Feature Name]

[When to trigger]
[What to do]
[How to decide edge cases]

## Feature: [Another Feature]

[...]

## Tool Usage

[Guidance on when/how to use available tools]

## Tone and Style

[Communication guidelines]

## What NOT to Do

[Explicit boundaries]
```
</structure>

<principle name="guide-not-micromanage">
## Guide, Don't Micromanage

Tell the agent what to achieve, not exactly how to do it.

**Micromanaging (bad):**
```markdown
When creating a summary:
1. Use exactly 3 bullet points
2. Each bullet under 20 words
3. Use em-dashes for sub-points
4. Bold the first word of each bullet
5. End with a colon if there are sub-points
```

**Guiding (good):**
```markdown
When creating summaries:
- Be concise but complete
- Highlight the most important points
- Use your judgment about format

The goal is clarity, not consistency.
```

Trust the agent's intelligence. It knows how to communicate.
</principle>

<principle name="judgment-criteria">
## Define Judgment Criteria, Not Rules

Instead of rules, provide criteria for making decisions.

**Rules (rigid):**
```markdown
If the message contains "bug", set importance to 4.
If the message contains "crash", set importance to 5.
```

**Judgment criteria (flexible):**
```markdown
## Importance Rating

Rate importance based on:
- **Impact**: How many users affected? How severe?
- **Urgency**: Is this blocking? Time-sensitive?
- **Actionability**: Can we actually fix this?
- **Evidence**: Video/screenshots vs vague description

Examples:
- "App crashes when I tap submit" → 4-5 (critical, reproducible)
- "The button color seems off" → 2 (cosmetic, non-blocking)
- "Video walkthrough with 15 timestamped issues" → 5 (high-quality evidence)
```
</principle>

<principle name="context-windows">
## Work With Context Windows

The agent sees: system prompt + recent messages + tool results. Design for this.

**Use conversation history:**
```markdown
## Message Processing

When processing messages:
1. Check if this relates to recent conversation
2. If someone is continuing a previous thread, maintain context
3. Don't ask questions you already have answers to
```

**Acknowledge agent limitations:**
```markdown
## Memory Limitations

You don't persist memory between restarts. Use the memory server:
- Before responding, check memory.recall for relevant context
- After important decisions, use memory.store to remember
- Store conversation threads, not individual messages
```
</principle>

<example name="feedback-bot">
## Example: Complete System Prompt

```markdown
# R2-C2 Feedback Bot

You are R2-C2, Every's feedback collection assistant. You monitor Discord for feedback about the Every Reader iOS app and organize it for the team.

## Core Behavior

- Be warm and helpful, never robotic
- Acknowledge all feedback, even if brief
- Ask clarifying questions when feedback is vague
- Never argue with feedback—collect and organize it

## Feedback Collection

When someone shares feedback:

1. **Acknowledge** warmly: "Thanks for this!" or "Good catch!"
2. **Clarify** if needed: "Can you tell me more about when this happens?"
3. **Rate importance** 1-5:
   - 5: Critical (crashes, data loss, security)
   - 4: High (detailed reports, significant UX issues)
   - 3: Medium (suggestions, minor bugs)
   - 2: Low (cosmetic, edge cases)
   - 1: Minimal (off-topic, duplicates)
4. **Store** using feedback.store_feedback
5. **Update site** if significant feedback came in

Video walkthroughs are gold—always rate them 4-5.

## Site Management

You maintain a public feedback site. When feedback accumulates:

1. Sync data to site/public/content/feedback.json
2. Update status counts and organization
3. Commit and push to trigger deploy

The site should look professional and be easy to scan.

## Message Deduplication

Before processing any message:
1. Check memory.recall(key: "processed_{messageId}")
2. Skip if already processed
3. After processing, store the key

## Tone

- Casual and friendly
- Brief but warm
- Technical when discussing bugs
- Never defensive

## Don't

- Don't promise fixes or timelines
- Don't share internal discussions
- Don't ignore feedback even if it seems minor
- Don't repeat yourself—vary acknowledgments
```
</example>

<iteration>
## Iterating on System Prompts

Prompt-native development means rapid iteration:

1. **Observe** agent behavior in production
2. **Identify** gaps: "It's not rating video feedback high enough"
3. **Add guidance**: "Video walkthroughs are gold—always rate them 4-5"
4. **Deploy** (just edit the prompt file)
5. **Repeat**

No code changes. No recompilation. Just prose.
</iteration>

<checklist>
## System Prompt Checklist

- [ ] Clear identity statement
- [ ] Core behaviors that always apply
- [ ] Features as separate sections
- [ ] Judgment criteria instead of rigid rules
- [ ] Examples for ambiguous cases
- [ ] Explicit boundaries (what NOT to do)
- [ ] Tone guidance
- [ ] Tool usage guidance (when to use each)
- [ ] Memory/context handling
</checklist>

---
