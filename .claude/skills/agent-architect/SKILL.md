---
name: agent-architect
description: "This skill should be used when the user asks to create an agent, build a skill, write a hook, scaffold a plugin, configure an MCP server, orchestrate multi-agent workflows, design prompt engineering systems, evaluate agent quality, or automate Claude Code workflows. Covers the entire Claude Code ecosystem: agents, skills, hooks, commands, plugins, MCP servers, multi-agent patterns (parallel, sequential, competitive, judge, debate, tree-of-thoughts), context engineering, prompt craft, and agent evaluation. Use this skill even for tangential mentions of agents, skills, hooks, plugins, MCP, subagents, or automation."
metadata:
  priority: 60
  promptSignals:
    phrases:
      - 'create an agent'
      - 'build a skill'
      - 'write a hook'
      - 'MCP server'
      - 'multi-agent'
      - 'subagent'
      - 'prompt engineering'
      - 'scaffold a plugin'
      - 'slash command'
      - 'skill mapping'
      - 'skill matching'
      - 'skill routing'
      - 'skill dispatch'
      - 'skill injection'
      - 'prompt routing'
      - 'hook scoring'
      - 'match skills'
---

# Agent Architect — Chief Skill

> The unified brain for building, orchestrating, and evaluating autonomous agent systems
> within the Claude Code ecosystem. Routes to 15+ deep references on demand.

## Project Identity

- **Stack:** Claude Code CLI, Claude Agent SDK, MCP Protocol
- **Scope:** Agent design, skill/hook/command/plugin architecture, MCP integration,
  multi-agent orchestration, prompt engineering, evaluation frameworks
- **Philosophy:** 1 skill + N references > N separate skills. This chief consolidates
  49 formerly separate skills into a unified expert with prerequisite-aware routing.

## Prerequisites Map

```
Context Engineering (how context windows work)
  └── Agent Fundamentals (what agents are, lifecycle, triggering)
        ├── Skill Development (SKILL.md structure, references, progressive disclosure)
        ├── Hook Patterns (PreToolUse, PostToolUse, Stop events)
        ├── Command Development (slash commands, YAML frontmatter, arguments)
        ├── Plugin Architecture (manifest, folder structure, distribution)
        ├── MCP Integration (servers, tools, resources, authentication)
        ├── Prompt Craft (system prompts, structured output, optimization)
        └── Multi-Agent Patterns (parallel, sequential, competitive, judge, swarm)
              └── Agent Evaluation (testing, benchmarking, quality gates)
```

## Decision Tree — Task Router

```
Task arrives about agents, automation, or Claude Code ecosystem
│
├─ "Create/build an agent" or agent architecture
│   ├── Need agent-native design principles? → READ 02-agent-native-architecture.md
│   ├── Need agent file structure/frontmatter? → READ 01-agent-fundamentals.md
│   ├── Need browser automation agent? → READ 16-agent-browser.md
│   └── Need to audit existing agent? → READ 15-agent-evaluation.md
│
├─ "Create/improve a skill" or skill structure
│   ├── Creating from scratch? → READ 03-skill-development.md
│   ├── Evaluation/benchmarking? → READ 15-agent-evaluation.md
│   └── Best practices (Anthropic)? → READ 03-skill-development.md §best-practices
│
├─ "Create a hook" or hook events
│   └── READ 04-hook-patterns.md
│
├─ "Create a command" or slash command
│   └── READ 05-command-development.md
│
├─ "Create/scaffold a plugin" or plugin structure
│   ├── Plugin manifest/structure? → READ 06-plugin-architecture.md
│   ├── Plugin settings/config? → READ 06-plugin-architecture.md §settings
│   └── What automation to build? → READ 17-automation-recommender.md
│
├─ "MCP server" or Model Context Protocol
│   ├── Protocol fundamentals? → READ 07-mcp-protocol.md
│   ├── Building an MCP server? → READ 08-mcp-builder.md
│   ├── Integrating existing MCP? → READ 07-mcp-protocol.md §integration
│   └── Specific MCP setup (arxiv, codemap, context7, serena)? → READ 09-mcp-setups.md
│
├─ "Multi-agent" or orchestration or parallel agents
│   ├── Which pattern to use? → READ 10-multi-agent-patterns.md (decision matrix)
│   ├── Parallel execution? → READ 11-parallel-sequential.md §parallel
│   ├── Sequential with verification? → READ 11-parallel-sequential.md §sequential
│   ├── Competitive (best-of-N)? → READ 12-competitive-judge.md §competitive
│   ├── Judge/evaluate output? → READ 12-competitive-judge.md §judge
│   ├── Multi-judge debate? → READ 12-competitive-judge.md §debate
│   ├── Tree of Thoughts? → READ 12-competitive-judge.md §tree-of-thoughts
│   └── Swarm coordination? → READ 13-swarm-orchestration.md
│
├─ "Prompt engineering" or system prompt or structured output
│   └── READ 14-prompt-craft.md
│
├─ "Context engineering" or context window management
│   └── READ 18-context-engineering.md
│
├─ "Test/evaluate agent quality" or benchmarking
│   └── READ 15-agent-evaluation.md
│
└─ "What should I automate?" or recommend automation
    └── READ 17-automation-recommender.md
```

## Non-Negotiables

1. **Progressive disclosure** — SKILL.md is lean (<500 lines). Deep knowledge lives in references.
   Load references only when the decision tree routes to them.
2. **Zero value loss** — Every line from absorbed skills is preserved in references.
   No summarization, no condensation, no "simplified" versions.
3. **Imperative form** — All instructions use verb-first language ("Create the agent",
   not "You should create the agent").
4. **Third-person descriptions** — Frontmatter uses "This skill should be used when..."
5. **Decision tree routing** — Never load all references. Route to the specific reference
   the task requires based on the tree above.

## Anti-Patterns

| Anti-Pattern | Why It Fails |
|---|---|
| Loading all references at once | Blows context window, dilutes focus |
| Building agents without understanding context engineering | Agent will hallucinate or lose state |
| Skipping evaluation after building | Ships broken agents to production |
| Copy-pasting hook/skill patterns without understanding lifecycle | Causes silent failures or infinite loops |
| MCP server without authentication plan | Security vulnerability |
| Multi-agent without clear task decomposition | Agents duplicate work or deadlock |
| Over-engineering prompts with MUSTs and NEVERs | Reduces model flexibility, leads to brittle behavior |

## Standard Workflow

For any agent/automation task:

1. **Classify** — Use the decision tree to identify which domain (agent, skill, hook, etc.)
2. **Load prerequisites** — Check prerequisites map. Load foundational references first.
3. **Load domain reference** — Read the specific reference the tree routes to.
4. **Execute** — Follow the reference's workflow/patterns.
5. **Evaluate** — Use `15-agent-evaluation.md` to verify quality.

## Output Contract

Every agent/skill/hook/plugin/MCP deliverable must include:
- [ ] Valid YAML frontmatter (name, description — description uses third-person)
- [ ] Imperative/infinitive writing style throughout
- [ ] All referenced files exist and are correctly pathed
- [ ] Decision tree or routing logic (for skills with references)
- [ ] At least one concrete example showing usage
- [ ] Clear trigger conditions (when should this activate?)

## Bundled References Table

| # | Reference | Lines | Source Skills | Load When |
|---|-----------|-------|--------------|-----------|
| 01 | `01-agent-fundamentals.md` | ~2,500 | agent-development, agent-native-audit | Creating any agent |
| 02 | `02-agent-native-architecture.md` | ~6,700 | agent-native-architecture (15 files) | Designing agent-native systems |
| 03 | `03-skill-development.md` | ~7,000 | skill-development, create-agent-skills, skill-creator, customaize-agent-create-skill, customaize-agent-apply-anthropic-skill-best-practices | Creating/improving skills |
| 04 | `04-hook-patterns.md` | ~4,900 | hook-development, customaize-agent-create-hook | Creating hooks |
| 05 | `05-command-development.md` | ~7,000 | command-development, customaize-agent-create-command | Creating slash commands |
| 06 | `06-plugin-architecture.md` | ~5,000 | plugin-structure, plugin-settings | Scaffolding plugins |
| 07 | `07-mcp-protocol.md` | ~4,400 | mcp-developer, mcp-integration | MCP fundamentals |
| 08 | `08-mcp-builder.md` | ~3,300 | mcp-builder, mcp-build-mcp | Building MCP servers |
| 09 | `09-mcp-setups.md` | ~600 | mcp-setup-arxiv, -codemap, -context7, -serena | Specific MCP setups |
| 10 | `10-multi-agent-patterns.md` | ~1,500 | sadd-multi-agent-patterns, dispatching-parallel-agents, subagent-driven-development | Choosing a multi-agent pattern |
| 11 | `11-parallel-sequential.md` | ~2,500 | sadd-do-in-parallel, sadd-do-in-steps, sadd-launch-sub-agent | Parallel or sequential execution |
| 12 | `12-competitive-judge.md` | ~2,800 | sadd-do-competitively, sadd-do-and-judge, sadd-judge, sadd-judge-with-debate, sadd-tree-of-thoughts | Competitive, judge, or ToT patterns |
| 13 | `13-swarm-orchestration.md` | ~1,700 | orchestrating-swarms | Large-scale multi-agent coordination |
| 14 | `14-prompt-craft.md` | ~3,800 | prompt-engineer, customaize-agent-prompt-engineering | Prompt engineering |
| 15 | `15-agent-evaluation.md` | ~3,900 | customaize-agent-agent-evaluation, customaize-agent-test-prompt, customaize-agent-test-skill, eval-harness (cross-ref) | Testing and benchmarking |
| 16 | `16-agent-browser.md` | ~2,300 | agent-browser | Browser automation |
| 17 | `17-automation-recommender.md` | ~1,500 | claude-automation-recommender | Choosing what to automate |
| 18 | `18-context-engineering.md` | ~1,900 | customaize-agent-context-engineering, customaize-agent-thought-based-reasoning, using-superpowers | Context window management |

**Total:** 18 references, ~63,000+ lines preserved from 49 absorbed skills.