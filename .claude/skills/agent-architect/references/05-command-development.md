# Command Development — Slash Commands & Dynamic Arguments

> Consolidated from command-development, customaize-agent-create-command, create-agent-skill. Zero-value-loss.

---

## Source: command-development / SKILL.md


# Command Development for Claude Code

## Overview

Slash commands are frequently-used prompts defined as Markdown files that Claude executes during interactive sessions. Understanding command structure, frontmatter options, and dynamic features enables creating powerful, reusable workflows.

**Key concepts:**
- Markdown file format for commands
- YAML frontmatter for configuration
- Dynamic arguments and file references
- Bash execution for context
- Command organization and namespacing

## Command Basics

### What is a Slash Command?

A slash command is a Markdown file containing a prompt that Claude executes when invoked. Commands provide:
- **Reusability**: Define once, use repeatedly
- **Consistency**: Standardize common workflows
- **Sharing**: Distribute across team or projects
- **Efficiency**: Quick access to complex prompts

### Critical: Commands are Instructions FOR Claude

**Commands are written for agent consumption, not human consumption.**

When a user invokes `/command-name`, the command content becomes Claude's instructions. Write commands as directives TO Claude about what to do, not as messages TO the user.

**Correct approach (instructions for Claude):**
```markdown
Review this code for security vulnerabilities including:
- SQL injection
- XSS attacks
- Authentication issues

Provide specific line numbers and severity ratings.
```

**Incorrect approach (messages to user):**
```markdown
This command will review your code for security issues.
You'll receive a report with vulnerability details.
```

The first example tells Claude what to do. The second tells the user what will happen but doesn't instruct Claude. Always use the first approach.

### Command Locations

**Project commands** (shared with team):
- Location: `.claude/commands/`
- Scope: Available in specific project
- Label: Shown as "(project)" in `/help`
- Use for: Team workflows, project-specific tasks

**Personal commands** (available everywhere):
- Location: `~/.claude/commands/`
- Scope: Available in all projects
- Label: Shown as "(user)" in `/help`
- Use for: Personal workflows, cross-project utilities

**Plugin commands** (bundled with plugins):
- Location: `plugin-name/commands/`
- Scope: Available when plugin installed
- Label: Shown as "(plugin-name)" in `/help`
- Use for: Plugin-specific functionality

## File Format

### Basic Structure

Commands are Markdown files with `.md` extension:

```
.claude/commands/
├── review.md           # /review command
├── test.md             # /test command
└── deploy.md           # /deploy command
```

**Simple command:**
```markdown
Review this code for security vulnerabilities including:
- SQL injection
- XSS attacks
- Authentication bypass
- Insecure data handling
```

No frontmatter needed for basic commands.

### With YAML Frontmatter

Add configuration using YAML frontmatter:

```markdown

Review this code for security vulnerabilities...
```

## YAML Frontmatter Fields

### description

**Purpose:** Brief description shown in `/help`
**Type:** String
**Default:** First line of command prompt

```yaml
```

**Best practice:** Clear, actionable description (under 60 characters)

### allowed-tools

**Purpose:** Specify which tools command can use
**Type:** String or Array
**Default:** Inherits from conversation

```yaml
```

**Patterns:**
- `Read, Write, Edit` - Specific tools
- `Bash(git:*)` - Bash with git commands only
- `*` - All tools (rarely needed)

**Use when:** Command requires specific tool access

### model

**Purpose:** Specify model for command execution
**Type:** String (sonnet, opus, haiku)
**Default:** Inherits from conversation

```yaml
```

**Use cases:**
- `haiku` - Fast, simple commands
- `sonnet` - Standard workflows
- `opus` - Complex analysis

### argument-hint

**Purpose:** Document expected arguments for autocomplete
**Type:** String
**Default:** None

```yaml
```

**Benefits:**
- Helps users understand command arguments
- Improves command discovery
- Documents command interface

### disable-model-invocation

**Purpose:** Prevent SlashCommand tool from programmatically calling command
**Type:** Boolean
**Default:** false

```yaml
```

**Use when:** Command should only be manually invoked

## Dynamic Arguments

### Using $ARGUMENTS

Capture all arguments as single string:

```markdown

Fix issue #$ARGUMENTS following our coding standards and best practices.
```

**Usage:**
```
> /fix-issue 123
> /fix-issue 456
```

**Expands to:**
```
Fix issue #123 following our coding standards...
Fix issue #456 following our coding standards...
```

### Using Positional Arguments

Capture individual arguments with `$1`, `$2`, `$3`, etc.:

```markdown

Review pull request #$1 with priority level $2.
After review, assign to $3 for follow-up.
```

**Usage:**
```
> /review-pr 123 high alice
```

**Expands to:**
```
Review pull request #123 with priority level high.
After review, assign to alice for follow-up.
```

### Combining Arguments

Mix positional and remaining arguments:

```markdown
Deploy $1 to $2 environment with options: $3
```

**Usage:**
```
> /deploy api staging --force --skip-tests
```

**Expands to:**
```
Deploy api to staging environment with options: --force --skip-tests
```

## File References

### Using @ Syntax

Include file contents in command:

```markdown

Review @$1 for:
- Code quality
- Best practices
- Potential bugs
```

**Usage:**
```
> /review-file src/api/users.ts
```

**Effect:** Claude reads `src/api/users.ts` before processing command

### Multiple File References

Reference multiple files:

```markdown
Compare @src/old-version.js with @src/new-version.js

Identify:
- Breaking changes
- New features
- Bug fixes
```

### Static File References

Reference known files without arguments:

```markdown
Review @package.json and @tsconfig.json for consistency

Ensure:
- TypeScript version matches
- Dependencies are aligned
- Build configuration is correct
```

## Bash Execution in Commands

Commands can execute bash commands inline to dynamically gather context before Claude processes the command. This is useful for including repository state, environment information, or project-specific context.

**When to use:**
- Include dynamic context (git status, environment vars, etc.)
- Gather project/repository state
- Build context-aware workflows

**Implementation details:**
For complete syntax, examples, and best practices, see `references/plugin-features-reference.md` section on bash execution. The reference includes the exact syntax and multiple working examples to avoid execution issues

## Command Organization

### Flat Structure

Simple organization for small command sets:

```
.claude/commands/
├── build.md
├── test.md
├── deploy.md
├── review.md
└── docs.md
```

**Use when:** 5-15 commands, no clear categories

### Namespaced Structure

Organize commands in subdirectories:

```
.claude/commands/
├── ci/
│   ├── build.md        # /build (project:ci)
│   ├── test.md         # /test (project:ci)
│   └── lint.md         # /lint (project:ci)
├── git/
│   ├── commit.md       # /commit (project:git)
│   └── pr.md           # /pr (project:git)
└── docs/
    ├── generate.md     # /generate (project:docs)
    └── publish.md      # /publish (project:docs)
```

**Benefits:**
- Logical grouping by category
- Namespace shown in `/help`
- Easier to find related commands

**Use when:** 15+ commands, clear categories

## Best Practices

### Command Design

1. **Single responsibility:** One command, one task
2. **Clear descriptions:** Self-explanatory in `/help`
3. **Explicit dependencies:** Use `allowed-tools` when needed
4. **Document arguments:** Always provide `argument-hint`
5. **Consistent naming:** Use verb-noun pattern (review-pr, fix-issue)

### Argument Handling

1. **Validate arguments:** Check for required arguments in prompt
2. **Provide defaults:** Suggest defaults when arguments missing
3. **Document format:** Explain expected argument format
4. **Handle edge cases:** Consider missing or invalid arguments

```markdown

$IF($1,
  Review PR #$1,
  Please provide a PR number. Usage: /review-pr [number]
)
```

### File References

1. **Explicit paths:** Use clear file paths
2. **Check existence:** Handle missing files gracefully
3. **Relative paths:** Use project-relative paths
4. **Glob support:** Consider using Glob tool for patterns

### Bash Commands

1. **Limit scope:** Use `Bash(git:*)` not `Bash(*)`
2. **Safe commands:** Avoid destructive operations
3. **Handle errors:** Consider command failures
4. **Keep fast:** Long-running commands slow invocation

### Documentation

1. **Add comments:** Explain complex logic
2. **Provide examples:** Show usage in comments
3. **List requirements:** Document dependencies
4. **Version commands:** Note breaking changes

```markdown

<!--
Usage: /deploy [staging|production] [version]
Requires: AWS credentials configured
Example: /deploy staging v1.2.3
-->

Deploy application to $1 environment using version $2...
```

## Common Patterns

### Review Pattern

```markdown

Files changed: !`git diff --name-only`

Review each file for:
1. Code quality and style
2. Potential bugs or issues
3. Test coverage
4. Documentation needs

Provide specific feedback for each file.
```

### Testing Pattern

```markdown

Run tests: !`npm test $1`

Analyze results and suggest fixes for failures.
```

### Documentation Pattern

```markdown

Generate comprehensive documentation for @$1 including:
- Function/class descriptions
- Parameter documentation
- Return value descriptions
- Usage examples
- Edge cases and errors
```

### Workflow Pattern

```markdown

PR #$1 Workflow:

1. Fetch PR: !`gh pr view $1`
2. Review changes
3. Run checks
4. Approve or request changes
```

## Troubleshooting

**Command not appearing:**
- Check file is in correct directory
- Verify `.md` extension present
- Ensure valid Markdown format
- Restart Claude Code

**Arguments not working:**
- Verify `$1`, `$2` syntax correct
- Check `argument-hint` matches usage
- Ensure no extra spaces

**Bash execution failing:**
- Check `allowed-tools` includes Bash
- Verify command syntax in backticks
- Test command in terminal first
- Check for required permissions

**File references not working:**
- Verify `@` syntax correct
- Check file path is valid
- Ensure Read tool allowed
- Use absolute or project-relative paths

## Plugin-Specific Features

### CLAUDE_PLUGIN_ROOT Variable

Plugin commands have access to `${CLAUDE_PLUGIN_ROOT}`, an environment variable that resolves to the plugin's absolute path.

**Purpose:**
- Reference plugin files portably
- Execute plugin scripts
- Load plugin configuration
- Access plugin templates

**Basic usage:**

```markdown

Run analysis: !`node ${CLAUDE_PLUGIN_ROOT}/scripts/analyze.js $1`

Review results and report findings.
```

**Common patterns:**

```markdown
# Execute plugin script
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/script.sh`

# Load plugin configuration
@${CLAUDE_PLUGIN_ROOT}/config/settings.json

# Use plugin template
@${CLAUDE_PLUGIN_ROOT}/templates/report.md

# Access plugin resources
@${CLAUDE_PLUGIN_ROOT}/docs/reference.md
```

**Why use it:**
- Works across all installations
- Portable between systems
- No hardcoded paths needed
- Essential for multi-file plugins

### Plugin Command Organization

Plugin commands discovered automatically from `commands/` directory:

```
plugin-name/
├── commands/
│   ├── foo.md              # /foo (plugin:plugin-name)
│   ├── bar.md              # /bar (plugin:plugin-name)
│   └── utils/
│       └── helper.md       # /helper (plugin:plugin-name:utils)
└── plugin.json
```

**Namespace benefits:**
- Logical command grouping
- Shown in `/help` output
- Avoid name conflicts
- Organize related commands

**Naming conventions:**
- Use descriptive action names
- Avoid generic names (test, run)
- Consider plugin-specific prefix
- Use hyphens for multi-word names

### Plugin Command Patterns

**Configuration-based pattern:**

```markdown

Load configuration: @${CLAUDE_PLUGIN_ROOT}/config/$1-deploy.json

Deploy to $1 using configuration settings.
Monitor deployment and report status.
```

**Template-based pattern:**

```markdown

Template: @${CLAUDE_PLUGIN_ROOT}/templates/docs.md

Generate documentation for $1 following template structure.
```

**Multi-script pattern:**

```markdown

Build: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh`
Test: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/test.sh`
Package: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/package.sh`

Review outputs and report workflow status.
```

**See `references/plugin-features-reference.md` for detailed patterns.**

## Integration with Plugin Components

Commands can integrate with other plugin components for powerful workflows.

### Agent Integration

Launch plugin agents for complex tasks:

```markdown

Initiate comprehensive review of @$1 using the code-reviewer agent.

The agent will analyze:
- Code structure
- Security issues
- Performance
- Best practices

Agent uses plugin resources:
- ${CLAUDE_PLUGIN_ROOT}/config/rules.json
- ${CLAUDE_PLUGIN_ROOT}/checklists/review.md
```

**Key points:**
- Agent must exist in `plugin/agents/` directory
- Claude uses Task tool to launch agent
- Document agent capabilities
- Reference plugin resources agent uses

### Skill Integration

Leverage plugin skills for specialized knowledge:

```markdown

Document API in @$1 following plugin standards.

Use the api-docs-standards skill to ensure:
- Complete endpoint documentation
- Consistent formatting
- Example quality
- Error documentation

Generate production-ready API docs.
```

**Key points:**
- Skill must exist in `plugin/skills/` directory
- Mention skill name to trigger invocation
- Document skill purpose
- Explain what skill provides

### Hook Coordination

Design commands that work with plugin hooks:
- Commands can prepare state for hooks to process
- Hooks execute automatically on tool events
- Commands should document expected hook behavior
- Guide Claude on interpreting hook output

See `references/plugin-features-reference.md` for examples of commands that coordinate with hooks

### Multi-Component Workflows

Combine agents, skills, and scripts:

```markdown

Target: @$1

Phase 1 - Static Analysis:
!`node ${CLAUDE_PLUGIN_ROOT}/scripts/lint.js $1`

Phase 2 - Deep Review:
Launch code-reviewer agent for detailed analysis.

Phase 3 - Standards Check:
Use coding-standards skill for validation.

Phase 4 - Report:
Template: @${CLAUDE_PLUGIN_ROOT}/templates/review.md

Compile findings into report following template.
```

**When to use:**
- Complex multi-step workflows
- Leverage multiple plugin capabilities
- Require specialized analysis
- Need structured outputs

## Validation Patterns

Commands should validate inputs and resources before processing.

### Argument Validation

```markdown

Validate environment: !`echo "$1" | grep -E "^(dev|staging|prod)$" || echo "INVALID"`

If $1 is valid environment:
  Deploy to $1
Otherwise:
  Explain valid environments: dev, staging, prod
  Show usage: /deploy [environment]
```

### File Existence Checks

```markdown

Check file exists: !`test -f $1 && echo "EXISTS" || echo "MISSING"`

If file exists:
  Process configuration: @$1
Otherwise:
  Explain where to place config file
  Show expected format
  Provide example configuration
```

### Plugin Resource Validation

```markdown

Validate plugin setup:
- Script: !`test -x ${CLAUDE_PLUGIN_ROOT}/bin/analyze && echo "✓" || echo "✗"`
- Config: !`test -f ${CLAUDE_PLUGIN_ROOT}/config.json && echo "✓" || echo "✗"`

If all checks pass, run analysis.
Otherwise, report missing components.
```

### Error Handling

```markdown

Execute build: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh 2>&1 || echo "BUILD_FAILED"`

If build succeeded:
  Report success and output location
If build failed:
  Analyze error output
  Suggest likely causes
  Provide troubleshooting steps
```

**Best practices:**
- Validate early in command
- Provide helpful error messages
- Suggest corrective actions
- Handle edge cases gracefully


---

## Source: command-development/references / advanced-workflows.md

# Advanced Workflow Patterns

Multi-step command sequences and composition patterns for complex workflows.

## Overview

Advanced workflows combine multiple commands, coordinate state across invocations, and create sophisticated automation sequences. These patterns enable building complex functionality from simple command building blocks.

## Multi-Step Command Patterns

### Sequential Workflow Command

Commands that guide users through multi-step processes:

```markdown
---
description: Complete PR review workflow
argument-hint: [pr-number]
allowed-tools: Bash(gh:*), Read, Grep
---

# PR Review Workflow for #$1

## Step 1: Fetch PR Details
!`gh pr view $1 --json title,body,author,files`

## Step 2: Review Files
Files changed: !`gh pr diff $1 --name-only`

For each file:
- Check code quality
- Verify tests exist
- Review documentation

## Step 3: Run Checks
Test status: !`gh pr checks $1`

Verify:
- All tests passing
- No merge conflicts
- CI/CD successful

## Step 4: Provide Feedback

Summarize:
- Issues found (critical/minor)
- Suggestions for improvement
- Approval recommendation

Would you like to:
1. Approve PR
2. Request changes
3. Leave comments only

Reply with your choice and I'll help complete the action.
```

**Key features:**
- Numbered steps for clarity
- Bash execution for context
- Decision points for user input
- Next action suggestions

### State-Carrying Workflow

Commands that maintain state between invocations:

```markdown
---
description: Initialize deployment workflow
allowed-tools: Write, Bash(git:*)
---

# Initialize Deployment

Creating deployment tracking file...

Current branch: !`git branch --show-current`
Latest commit: !`git log -1 --format=%H`

Deployment state saved to `.claude/deployment-state.local.md`:

\`\`\`markdown
---
initialized: true
branch: $(git branch --show-current)
commit: $(git log -1 --format=%H)
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
status: initialized
---

# Deployment Tracking

Branch: $(git branch --show-current)
Started: $(date)

Next steps:
1. Run tests: /deploy-test
2. Build: /deploy-build
3. Deploy: /deploy-execute
\`\`\`

State saved. Run `/deploy-test` to continue.
```

**Next command** (`/deploy-test`):
```markdown
---
description: Run deployment tests
allowed-tools: Read, Bash(npm:*)
---

Reading deployment state from `.claude/deployment-state.local.md`...

Running tests: !`npm test`

Updating state to 'tested'...

Tests complete. Run `/deploy-build` to continue.
```

**Pattern benefits:**
- Persistent state across commands
- Clear workflow progression
- Safety checkpoints
- Resume capability

### Conditional Workflow Branching

Commands that adapt based on conditions:

```markdown
---
description: Smart deployment workflow
argument-hint: [environment]
allowed-tools: Bash(git:*), Bash(npm:*), Read
---

# Deploy to $1

## Pre-flight Checks

Branch: !`git branch --show-current`
Status: !`git status --short`

**Checking conditions:**

1. Branch status:
   - If main/master: Require approval
   - If feature branch: Warning about target
   - If hotfix: Fast-track process

2. Tests:
   !`npm test`
   - If tests fail: STOP - fix tests first
   - If tests pass: Continue

3. Environment:
   - If $1 = 'production': Extra validation
   - If $1 = 'staging': Standard process
   - If $1 = 'dev': Minimal checks

**Workflow decision:**
Based on above, proceeding with: [determined workflow]

[Conditional steps based on environment and status]

Ready to deploy? (yes/no)
```

## Command Composition Patterns

### Command Chaining

Commands designed to work together:

```markdown
---
description: Prepare for code review
---

# Prepare Code Review

Running preparation sequence:

1. Format code: /format-code
2. Run linter: /lint-code
3. Run tests: /test-all
4. Generate coverage: /coverage-report
5. Create review summary: /review-summary

This is a meta-command. After completing each step above,
I'll compile results and prepare comprehensive review materials.

Starting sequence...
```

**Individual commands** are simple:
- `/format-code` - Just formats
- `/lint-code` - Just lints
- `/test-all` - Just tests

**Composition command** orchestrates them.

### Pipeline Pattern

Commands that process output from previous commands:

```markdown
---
description: Analyze test failures
---

# Analyze Test Failures

## Step 1: Get test results
(Run /test-all first if not done)

Reading test output...

## Step 2: Categorize failures
- Flaky tests (random failures)
- Consistent failures
- New failures vs existing

## Step 3: Prioritize
Rank by:
- Impact (critical path vs edge case)
- Frequency (always fails vs sometimes)
- Effort (quick fix vs major work)

## Step 4: Generate fix plan
For each failure:
- Root cause hypothesis
- Suggested fix approach
- Estimated effort

Would you like me to:
1. Fix highest priority failure
2. Generate detailed fix plans for all
3. Create GitHub issues for each
```

### Parallel Execution Pattern

Commands that coordinate multiple simultaneous operations:

```markdown
---
description: Run comprehensive validation
allowed-tools: Bash(*), Read
---

# Comprehensive Validation

Running validations in parallel...

Starting:
- Code quality checks
- Security scanning
- Dependency audit
- Performance profiling

This will take 2-3 minutes. I'll monitor all processes
and report when complete.

[Poll each process and report progress]

All validations complete. Summary:
- Quality: PASS (0 issues)
- Security: WARN (2 minor issues)
- Dependencies: PASS
- Performance: PASS (baseline met)

Details:
[Collated results from all checks]
```

## Workflow State Management

### Using .local.md Files

Store workflow state in plugin-specific files:

```markdown
.claude/plugin-name-workflow.local.md:

---
workflow: deployment
stage: testing
started: 2025-01-15T10:30:00Z
environment: staging
branch: feature/new-api
commit: abc123def
tests_passed: false
build_complete: false
---

# Deployment Workflow State

Current stage: Testing
Started: 2025-01-15 10:30 UTC

Completed steps:
- ✅ Validation
- ✅ Branch check
- ⏳ Testing (in progress)

Pending steps:
- Build
- Deploy
- Smoke tests
```

**Reading state in commands:**

```markdown
---
description: Continue deployment workflow
allowed-tools: Read, Write
---

Reading workflow state from .claude/plugin-name-workflow.local.md...

Current stage: @.claude/plugin-name-workflow.local.md

[Parse YAML frontmatter to determine next step]

Next action based on state: [determined action]
```

### Workflow Recovery

Handle interrupted workflows:

```markdown
---
description: Resume deployment workflow
allowed-tools: Read
---

# Resume Deployment

Checking for interrupted workflow...

State file: @.claude/plugin-name-workflow.local.md

**Workflow found:**
- Started: [timestamp]
- Environment: [env]
- Last completed: [step]

**Recovery options:**
1. Resume from last step
2. Restart from beginning
3. Abort and clean up

Which would you like? (1/2/3)
```

## Workflow Coordination Patterns

### Cross-Command Communication

Commands that signal each other:

```markdown
---
description: Mark feature complete
allowed-tools: Write
---

# Mark Feature Complete

Writing completion marker...

Creating: .claude/feature-complete.flag

This signals other commands that feature is ready for:
- Integration testing (/integration-test will auto-detect)
- Documentation generation (/docs-generate will include)
- Release notes (/release-notes will add)

Feature marked complete.
```

**Other commands check for flag:**

```markdown
---
description: Generate release notes
allowed-tools: Read, Bash(git:*)
---

Checking for completed features...

if [ -f .claude/feature-complete.flag ]; then
  Feature ready for release notes
fi

[Include in release notes]
```

### Workflow Locking

Prevent concurrent workflow execution:

```markdown
---
description: Start deployment
allowed-tools: Read, Write, Bash
---

# Start Deployment

Checking for active deployments...

if [ -f .claude/deployment.lock ]; then
  ERROR: Deployment already in progress
  Started: [timestamp from lock file]

  Cannot start concurrent deployment.
  Wait for completion or run /deployment-abort

  Exit.
fi

Creating deployment lock...

Deployment started. Lock created.
[Proceed with deployment]
```

**Lock cleanup:**

```markdown
---
description: Complete deployment
allowed-tools: Write, Bash
---

Deployment complete.

Removing deployment lock...
rm .claude/deployment.lock

Ready for next deployment.
```

## Advanced Argument Handling

### Optional Arguments with Defaults

```markdown
---
description: Deploy with optional version
argument-hint: [environment] [version]
---

Environment: ${1:-staging}
Version: ${2:-latest}

Deploying ${2:-latest} to ${1:-staging}...

Note: Using defaults for missing arguments:
- Environment defaults to 'staging'
- Version defaults to 'latest'
```

### Argument Validation

```markdown
---
description: Deploy to validated environment
argument-hint: [environment]
---

Environment: $1

Validating environment...

valid_envs="dev staging production"
if ! echo "$valid_envs" | grep -w "$1" > /dev/null; then
  ERROR: Invalid environment '$1'
  Valid options: dev, staging, production
  Exit.
fi

Environment validated. Proceeding...
```

### Argument Transformation

```markdown
---
description: Deploy with shorthand
argument-hint: [env-shorthand]
---

Input: $1

Expanding shorthand:
- d/dev → development
- s/stg → staging
- p/prod → production

case "$1" in
  d|dev) ENV="development";;
  s|stg) ENV="staging";;
  p|prod) ENV="production";;
  *) ENV="$1";;
esac

Deploying to: $ENV
```

## Error Handling in Workflows

### Graceful Failure

```markdown
---
description: Resilient deployment workflow
---

# Deployment Workflow

Running steps with error handling...

## Step 1: Tests
!`npm test`

if [ $? -ne 0 ]; then
  ERROR: Tests failed

  Options:
  1. Fix tests and retry
  2. Skip tests (NOT recommended)
  3. Abort deployment

  What would you like to do?

  [Wait for user input before continuing]
fi

## Step 2: Build
[Continue only if Step 1 succeeded]
```

### Rollback on Failure

```markdown
---
description: Deployment with rollback
---

# Deploy with Rollback

Saving current state for rollback...
Previous version: !`current-version.sh`

Deploying new version...

!`deploy.sh`

if [ $? -ne 0 ]; then
  DEPLOYMENT FAILED

  Initiating automatic rollback...
  !`rollback.sh`

  Rolled back to previous version.
  Check logs for failure details.
fi

Deployment complete.
```

### Checkpoint Recovery

```markdown
---
description: Workflow with checkpoints
---

# Multi-Stage Deployment

## Checkpoint 1: Validation
!`validate.sh`
echo "checkpoint:validation" >> .claude/deployment-checkpoints.log

## Checkpoint 2: Build
!`build.sh`
echo "checkpoint:build" >> .claude/deployment-checkpoints.log

## Checkpoint 3: Deploy
!`deploy.sh`
echo "checkpoint:deploy" >> .claude/deployment-checkpoints.log

If any step fails, resume with:
/deployment-resume [last-successful-checkpoint]
```

## Best Practices

### Workflow Design

1. **Clear progression**: Number steps, show current position
2. **Explicit state**: Don't rely on implicit state
3. **User control**: Provide decision points
4. **Error recovery**: Handle failures gracefully
5. **Progress indication**: Show what's done, what's pending

### Command Composition

1. **Single responsibility**: Each command does one thing well
2. **Composable design**: Commands work together easily
3. **Standard interfaces**: Consistent input/output formats
4. **Loose coupling**: Commands don't depend on each other's internals

### State Management

1. **Persistent state**: Use .local.md files
2. **Atomic updates**: Write complete state files atomically
3. **State validation**: Check state file format/completeness
4. **Cleanup**: Remove stale state files
5. **Documentation**: Document state file formats

### Error Handling

1. **Fail fast**: Detect errors early
2. **Clear messages**: Explain what went wrong
3. **Recovery options**: Provide clear next steps
4. **State preservation**: Keep state for recovery
5. **Rollback capability**: Support undoing changes

## Example: Complete Deployment Workflow

### Initialize Command

```markdown
---
description: Initialize deployment
argument-hint: [environment]
allowed-tools: Write, Bash(git:*)
---

# Initialize Deployment to $1

Creating workflow state...

\`\`\`yaml
---
workflow: deployment
environment: $1
branch: !`git branch --show-current`
commit: !`git rev-parse HEAD`
stage: initialized
timestamp: !`date -u +%Y-%m-%dT%H:%M:%SZ`
---
\`\`\`

Written to .claude/deployment-state.local.md

Next: Run /deployment-validate
```

### Validation Command

```markdown
---
description: Validate deployment
allowed-tools: Read, Bash
---

Reading state: @.claude/deployment-state.local.md

Running validation...
- Branch check: PASS
- Tests: PASS
- Build: PASS

Updating state to 'validated'...

Next: Run /deployment-execute
```

### Execution Command

```markdown
---
description: Execute deployment
allowed-tools: Read, Bash, Write
---

Reading state: @.claude/deployment-state.local.md

Executing deployment to [environment]...

!`deploy.sh [environment]`

Deployment complete.
Updating state to 'completed'...

Cleanup: /deployment-cleanup
```

### Cleanup Command

```markdown
---
description: Clean up deployment
allowed-tools: Bash
---

Removing deployment state...
rm .claude/deployment-state.local.md

Deployment workflow complete.
```

This complete workflow demonstrates state management, sequential execution, error handling, and clean separation of concerns across multiple commands.

---

## Source: command-development/references / documentation-patterns.md

# Command Documentation Patterns

Strategies for creating self-documenting, maintainable commands with excellent user experience.

## Overview

Well-documented commands are easier to use, maintain, and distribute. Documentation should be embedded in the command itself, making it immediately accessible to users and maintainers.

## Self-Documenting Command Structure

### Complete Command Template

```markdown
---
description: Clear, actionable description under 60 chars
argument-hint: [arg1] [arg2] [optional-arg]
allowed-tools: Read, Bash(git:*)
model: sonnet
---

<!--
COMMAND: command-name
VERSION: 1.0.0
AUTHOR: Team Name
LAST UPDATED: 2025-01-15

PURPOSE:
Detailed explanation of what this command does and why it exists.

USAGE:
  /command-name arg1 arg2

ARGUMENTS:
  arg1: Description of first argument (required)
  arg2: Description of second argument (optional, defaults to X)

EXAMPLES:
  /command-name feature-branch main
    → Compares feature-branch with main

  /command-name my-branch
    → Compares my-branch with current branch

REQUIREMENTS:
  - Git repository
  - Branch must exist
  - Permissions to read repository

RELATED COMMANDS:
  /other-command - Related functionality
  /another-command - Alternative approach

TROUBLESHOOTING:
  - If branch not found: Check branch name spelling
  - If permission denied: Check repository access

CHANGELOG:
  v1.0.0 (2025-01-15): Initial release
  v0.9.0 (2025-01-10): Beta version
-->

# Command Implementation

[Command prompt content here...]

[Explain what will happen...]

[Guide user through steps...]

[Provide clear output...]
```

### Documentation Comment Sections

**PURPOSE**: Why the command exists
- Problem it solves
- Use cases
- When to use vs when not to use

**USAGE**: Basic syntax
- Command invocation pattern
- Required vs optional arguments
- Default values

**ARGUMENTS**: Detailed argument documentation
- Each argument described
- Type information
- Valid values/ranges
- Defaults

**EXAMPLES**: Concrete usage examples
- Common use cases
- Edge cases
- Expected outputs

**REQUIREMENTS**: Prerequisites
- Dependencies
- Permissions
- Environmental setup

**RELATED COMMANDS**: Connections
- Similar commands
- Complementary commands
- Alternative approaches

**TROUBLESHOOTING**: Common issues
- Known problems
- Solutions
- Workarounds

**CHANGELOG**: Version history
- What changed when
- Breaking changes highlighted
- Migration guidance

## In-Line Documentation Patterns

### Commented Sections

```markdown
---
description: Complex multi-step command
---

<!-- SECTION 1: VALIDATION -->
<!-- This section checks prerequisites before proceeding -->

Checking prerequisites...
- Git repository: !`git rev-parse --git-dir 2>/dev/null`
- Branch exists: [validation logic]

<!-- SECTION 2: ANALYSIS -->
<!-- Analyzes the differences between branches -->

Analyzing differences between $1 and $2...
[Analysis logic...]

<!-- SECTION 3: RECOMMENDATIONS -->
<!-- Provides actionable recommendations -->

Based on analysis, recommend:
[Recommendations...]

<!-- END: Next steps for user -->
```

### Inline Explanations

```markdown
---
description: Deployment command with inline docs
---

# Deploy to $1

## Pre-flight Checks

<!-- We check branch status to prevent deploying from wrong branch -->
Current branch: !`git branch --show-current`

<!-- Production deploys must come from main/master -->
if [ "$1" = "production" ] && [ "$(git branch --show-current)" != "main" ]; then
  ⚠️  WARNING: Not on main branch for production deploy
  This is unusual. Confirm this is intentional.
fi

<!-- Test status ensures we don't deploy broken code -->
Running tests: !`npm test`

✓ All checks passed

## Deployment

<!-- Actual deployment happens here -->
<!-- Uses blue-green strategy for zero-downtime -->
Deploying to $1 environment...
[Deployment steps...]

<!-- Post-deployment verification -->
Verifying deployment health...
[Health checks...]

Deployment complete!

## Next Steps

<!-- Guide user on what to do after deployment -->
1. Monitor logs: /logs $1
2. Run smoke tests: /smoke-test $1
3. Notify team: /notify-deployment $1
```

### Decision Point Documentation

```markdown
---
description: Interactive deployment command
---

# Interactive Deployment

## Configuration Review

Target: $1
Current version: !`cat version.txt`
New version: $2

<!-- DECISION POINT: User confirms configuration -->
<!-- This pause allows user to verify everything is correct -->
<!-- We can't automatically proceed because deployment is risky -->

Review the above configuration.

**Continue with deployment?**
- Reply "yes" to proceed
- Reply "no" to cancel
- Reply "edit" to modify configuration

[Await user input before continuing...]

<!-- After user confirms, we proceed with deployment -->
<!-- All subsequent steps are automated -->

Proceeding with deployment...
```

## Help Text Patterns

### Built-in Help Command

Create a help subcommand for complex commands:

```markdown
---
description: Main command with help
argument-hint: [subcommand] [args]
---

# Command Processor

if [ "$1" = "help" ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  **Command Help**

  USAGE:
    /command [subcommand] [args]

  SUBCOMMANDS:
    init [name]       Initialize new configuration
    deploy [env]      Deploy to environment
    status            Show current status
    rollback          Rollback last deployment
    help              Show this help

  EXAMPLES:
    /command init my-project
    /command deploy staging
    /command status
    /command rollback

  For detailed help on a subcommand:
    /command [subcommand] --help

  Exit.
fi

[Regular command processing...]
```

### Contextual Help

Provide help based on context:

```markdown
---
description: Context-aware command
argument-hint: [operation] [target]
---

# Context-Aware Operation

if [ -z "$1" ]; then
  **No operation specified**

  Available operations:
  - analyze: Analyze target for issues
  - fix: Apply automatic fixes
  - report: Generate detailed report

  Usage: /command [operation] [target]

  Examples:
    /command analyze src/
    /command fix src/app.js
    /command report

  Run /command help for more details.

  Exit.
fi

[Command continues if operation provided...]
```

## Error Message Documentation

### Helpful Error Messages

```markdown
---
description: Command with good error messages
---

# Validation Command

if [ -z "$1" ]; then
  ❌ ERROR: Missing required argument

  The 'file-path' argument is required.

  USAGE:
    /validate [file-path]

  EXAMPLE:
    /validate src/app.js

  Try again with a file path.

  Exit.
fi

if [ ! -f "$1" ]; then
  ❌ ERROR: File not found: $1

  The specified file does not exist or is not accessible.

  COMMON CAUSES:
  1. Typo in file path
  2. File was deleted or moved
  3. Insufficient permissions

  SUGGESTIONS:
  - Check spelling: $1
  - Verify file exists: ls -la $(dirname "$1")
  - Check permissions: ls -l "$1"

  Exit.
fi

[Command continues if validation passes...]
```

### Error Recovery Guidance

```markdown
---
description: Command with recovery guidance
---

# Operation Command

Running operation...

!`risky-operation.sh`

if [ $? -ne 0 ]; then
  ❌ OPERATION FAILED

  The operation encountered an error and could not complete.

  WHAT HAPPENED:
  The risky-operation.sh script returned a non-zero exit code.

  WHAT THIS MEANS:
  - Changes may be partially applied
  - System may be in inconsistent state
  - Manual intervention may be needed

  RECOVERY STEPS:
  1. Check operation logs: cat /tmp/operation.log
  2. Verify system state: /check-state
  3. If needed, rollback: /rollback-operation
  4. Fix underlying issue
  5. Retry operation: /retry-operation

  NEED HELP?
  - Check troubleshooting guide: /help troubleshooting
  - Contact support with error code: ERR_OP_FAILED_001

  Exit.
fi
```

## Usage Example Documentation

### Embedded Examples

```markdown
---
description: Command with embedded examples
---

# Feature Command

This command performs feature analysis with multiple options.

## Basic Usage

\`\`\`
/feature analyze src/
\`\`\`

Analyzes all files in src/ directory for feature usage.

## Advanced Usage

\`\`\`
/feature analyze src/ --detailed
\`\`\`

Provides detailed analysis including:
- Feature breakdown by file
- Usage patterns
- Optimization suggestions

## Use Cases

**Use Case 1: Quick overview**
\`\`\`
/feature analyze .
\`\`\`
Get high-level feature summary of entire project.

**Use Case 2: Specific directory**
\`\`\`
/feature analyze src/components
\`\`\`
Focus analysis on components directory only.

**Use Case 3: Comparison**
\`\`\`
/feature analyze src/ --compare baseline.json
\`\`\`
Compare current features against baseline.

---

Now processing your request...

[Command implementation...]
```

### Example-Driven Documentation

```markdown
---
description: Example-heavy command
---

# Transformation Command

## What This Does

Transforms data from one format to another.

## Examples First

### Example 1: JSON to YAML
**Input:** `data.json`
\`\`\`json
{"name": "test", "value": 42}
\`\`\`

**Command:** `/transform data.json yaml`

**Output:** `data.yaml`
\`\`\`yaml
name: test
value: 42
\`\`\`

### Example 2: CSV to JSON
**Input:** `data.csv`
\`\`\`csv
name,value
test,42
\`\`\`

**Command:** `/transform data.csv json`

**Output:** `data.json`
\`\`\`json
[{"name": "test", "value": "42"}]
\`\`\`

### Example 3: With Options
**Command:** `/transform data.json yaml --pretty --sort-keys`

**Result:** Formatted YAML with sorted keys

---

## Your Transformation

File: $1
Format: $2

[Perform transformation...]
```

## Maintenance Documentation

### Version and Changelog

```markdown
<!--
VERSION: 2.1.0
LAST UPDATED: 2025-01-15
AUTHOR: DevOps Team

CHANGELOG:
  v2.1.0 (2025-01-15):
    - Added support for YAML configuration
    - Improved error messages
    - Fixed bug with special characters in arguments

  v2.0.0 (2025-01-01):
    - BREAKING: Changed argument order
    - BREAKING: Removed deprecated --old-flag
    - Added new validation checks
    - Migration guide: /migration-v2

  v1.5.0 (2024-12-15):
    - Added --verbose flag
    - Improved performance by 50%

  v1.0.0 (2024-12-01):
    - Initial stable release

MIGRATION NOTES:
  From v1.x to v2.0:
    Old: /command arg1 arg2 --old-flag
    New: /command arg2 arg1

  The --old-flag is removed. Use --new-flag instead.

DEPRECATION WARNINGS:
  - The --legacy-mode flag is deprecated as of v2.1.0
  - Will be removed in v3.0.0 (estimated 2025-06-01)
  - Use --modern-mode instead

KNOWN ISSUES:
  - #123: Slow performance with large files (workaround: use --stream flag)
  - #456: Special characters in Windows (fix planned for v2.2.0)
-->
```

### Maintenance Notes

```markdown
<!--
MAINTENANCE NOTES:

CODE STRUCTURE:
  - Lines 1-50: Argument parsing and validation
  - Lines 51-100: Main processing logic
  - Lines 101-150: Output formatting
  - Lines 151-200: Error handling

DEPENDENCIES:
  - Requires git 2.x or later
  - Uses jq for JSON processing
  - Needs bash 4.0+ for associative arrays

PERFORMANCE:
  - Fast path for small inputs (< 1MB)
  - Streams large files to avoid memory issues
  - Caches results in /tmp for 1 hour

SECURITY CONSIDERATIONS:
  - Validates all inputs to prevent injection
  - Uses allowed-tools to limit Bash access
  - No credentials in command file

TESTING:
  - Unit tests: tests/command-test.sh
  - Integration tests: tests/integration/
  - Manual test checklist: tests/manual-checklist.md

FUTURE IMPROVEMENTS:
  - TODO: Add support for TOML format
  - TODO: Implement parallel processing
  - TODO: Add progress bar for large files

RELATED FILES:
  - lib/parser.sh: Shared parsing logic
  - lib/formatter.sh: Output formatting
  - config/defaults.yml: Default configuration
-->
```

## README Documentation

Commands should have companion README files:

```markdown
# Command Name

Brief description of what the command does.

## Installation

This command is part of the [plugin-name] plugin.

Install with:
\`\`\`
/plugin install plugin-name
\`\`\`

## Usage

Basic usage:
\`\`\`
/command-name [arg1] [arg2]
\`\`\`

## Arguments

- `arg1`: Description (required)
- `arg2`: Description (optional, defaults to X)

## Examples

### Example 1: Basic Usage
\`\`\`
/command-name value1 value2
\`\`\`

Description of what happens.

### Example 2: Advanced Usage
\`\`\`
/command-name value1 --option
\`\`\`

Description of advanced feature.

## Configuration

Optional configuration file: `.claude/command-name.local.md`

\`\`\`markdown
---
default_arg: value
enable_feature: true
---
\`\`\`

## Requirements

- Git 2.x or later
- jq (for JSON processing)
- Node.js 14+ (optional, for advanced features)

## Troubleshooting

### Issue: Command not found

**Solution:** Ensure plugin is installed and enabled.

### Issue: Permission denied

**Solution:** Check file permissions and allowed-tools setting.

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT License - See [LICENSE](LICENSE).

## Support

- Issues: https://github.com/user/plugin/issues
- Docs: https://docs.example.com
- Email: support@example.com
```

## Best Practices

### Documentation Principles

1. **Write for your future self**: Assume you'll forget details
2. **Examples before explanations**: Show, then tell
3. **Progressive disclosure**: Basic info first, details available
4. **Keep it current**: Update docs when code changes
5. **Test your docs**: Verify examples actually work

### Documentation Locations

1. **In command file**: Core usage, examples, inline explanations
2. **README**: Installation, configuration, troubleshooting
3. **Separate docs**: Detailed guides, tutorials, API reference
4. **Comments**: Implementation details for maintainers

### Documentation Style

1. **Clear and concise**: No unnecessary words
2. **Active voice**: "Run the command" not "The command can be run"
3. **Consistent terminology**: Use same terms throughout
4. **Formatted well**: Use headings, lists, code blocks
5. **Accessible**: Assume reader is beginner

### Documentation Maintenance

1. **Version everything**: Track what changed when
2. **Deprecate gracefully**: Warn before removing features
3. **Migration guides**: Help users upgrade
4. **Archive old docs**: Keep old versions accessible
5. **Review regularly**: Ensure docs match reality

## Documentation Checklist

Before releasing a command:

- [ ] Description in frontmatter is clear
- [ ] argument-hint documents all arguments
- [ ] Usage examples in comments
- [ ] Common use cases shown
- [ ] Error messages are helpful
- [ ] Requirements documented
- [ ] Related commands listed
- [ ] Changelog maintained
- [ ] Version number updated
- [ ] README created/updated
- [ ] Examples actually work
- [ ] Troubleshooting section complete

With good documentation, commands become self-service, reducing support burden and improving user experience.

---

## Source: command-development/references / frontmatter-reference.md

# Command Frontmatter Reference

Complete reference for YAML frontmatter fields in slash commands.

## Frontmatter Overview

YAML frontmatter is optional metadata at the start of command files:

```markdown
---
description: Brief description
allowed-tools: Read, Write
model: sonnet
argument-hint: [arg1] [arg2]
---

Command prompt content here...
```

All fields are optional. Commands work without any frontmatter.

## Field Specifications

### description

**Type:** String
**Required:** No
**Default:** First line of command prompt
**Max Length:** ~60 characters recommended for `/help` display

**Purpose:** Describes what the command does, shown in `/help` output

**Examples:**
```yaml
description: Review code for security issues
```
```yaml
description: Deploy to staging environment
```
```yaml
description: Generate API documentation
```

**Best practices:**
- Keep under 60 characters for clean display
- Start with verb (Review, Deploy, Generate)
- Be specific about what command does
- Avoid redundant "command" or "slash command"

**Good:**
- ✅ "Review PR for code quality and security"
- ✅ "Deploy application to specified environment"
- ✅ "Generate comprehensive API documentation"

**Bad:**
- ❌ "This command reviews PRs" (unnecessary "This command")
- ❌ "Review" (too vague)
- ❌ "A command that reviews pull requests for code quality, security issues, and best practices" (too long)

### allowed-tools

**Type:** String or Array of strings
**Required:** No
**Default:** Inherits from conversation permissions

**Purpose:** Restrict or specify which tools command can use

**Formats:**

**Single tool:**
```yaml
allowed-tools: Read
```

**Multiple tools (comma-separated):**
```yaml
allowed-tools: Read, Write, Edit
```

**Multiple tools (array):**
```yaml
allowed-tools:
  - Read
  - Write
  - Bash(git:*)
```

**Tool Patterns:**

**Specific tools:**
```yaml
allowed-tools: Read, Grep, Edit
```

**Bash with command filter:**
```yaml
allowed-tools: Bash(git:*)           # Only git commands
allowed-tools: Bash(npm:*)           # Only npm commands
allowed-tools: Bash(docker:*)        # Only docker commands
```

**All tools (not recommended):**
```yaml
allowed-tools: "*"
```

**When to use:**

1. **Security:** Restrict command to safe operations
   ```yaml
   allowed-tools: Read, Grep  # Read-only command
   ```

2. **Clarity:** Document required tools
   ```yaml
   allowed-tools: Bash(git:*), Read
   ```

3. **Bash execution:** Enable bash command output
   ```yaml
   allowed-tools: Bash(git status:*), Bash(git diff:*)
   ```

**Best practices:**
- Be as restrictive as possible
- Use command filters for Bash (e.g., `git:*` not `*`)
- Only specify when different from conversation permissions
- Document why specific tools are needed

### model

**Type:** String
**Required:** No
**Default:** Inherits from conversation
**Values:** `sonnet`, `opus`, `haiku`

**Purpose:** Specify which Claude model executes the command

**Examples:**
```yaml
model: haiku    # Fast, efficient for simple tasks
```
```yaml
model: sonnet   # Balanced performance (default)
```
```yaml
model: opus     # Maximum capability for complex tasks
```

**When to use:**

**Use `haiku` for:**
- Simple, formulaic commands
- Fast execution needed
- Low complexity tasks
- Frequent invocations

```yaml
---
description: Format code file
model: haiku
---
```

**Use `sonnet` for:**
- Standard commands (default)
- Balanced speed/quality
- Most common use cases

```yaml
---
description: Review code changes
model: sonnet
---
```

**Use `opus` for:**
- Complex analysis
- Architectural decisions
- Deep code understanding
- Critical tasks

```yaml
---
description: Analyze system architecture
model: opus
---
```

**Best practices:**
- Omit unless specific need
- Use `haiku` for speed when possible
- Reserve `opus` for genuinely complex tasks
- Test with different models to find right balance

### argument-hint

**Type:** String
**Required:** No
**Default:** None

**Purpose:** Document expected arguments for users and autocomplete

**Format:**
```yaml
argument-hint: [arg1] [arg2] [optional-arg]
```

**Examples:**

**Single argument:**
```yaml
argument-hint: [pr-number]
```

**Multiple required arguments:**
```yaml
argument-hint: [environment] [version]
```

**Optional arguments:**
```yaml
argument-hint: [file-path] [options]
```

**Descriptive names:**
```yaml
argument-hint: [source-branch] [target-branch] [commit-message]
```

**Best practices:**
- Use square brackets `[]` for each argument
- Use descriptive names (not `arg1`, `arg2`)
- Indicate optional vs required in description
- Match order to positional arguments in command
- Keep concise but clear

**Examples by pattern:**

**Simple command:**
```yaml
---
description: Fix issue by number
argument-hint: [issue-number]
---

Fix issue #$1...
```

**Multi-argument:**
```yaml
---
description: Deploy to environment
argument-hint: [app-name] [environment] [version]
---

Deploy $1 to $2 using version $3...
```

**With options:**
```yaml
---
description: Run tests with options
argument-hint: [test-pattern] [options]
---

Run tests matching $1 with options: $2
```

### disable-model-invocation

**Type:** Boolean
**Required:** No
**Default:** false

**Purpose:** Prevent SlashCommand tool from programmatically invoking command

**Examples:**
```yaml
disable-model-invocation: true
```

**When to use:**

1. **Manual-only commands:** Commands requiring user judgment
   ```yaml
   ---
   description: Approve deployment to production
   disable-model-invocation: true
   ---
   ```

2. **Destructive operations:** Commands with irreversible effects
   ```yaml
   ---
   description: Delete all test data
   disable-model-invocation: true
   ---
   ```

3. **Interactive workflows:** Commands needing user input
   ```yaml
   ---
   description: Walk through setup wizard
   disable-model-invocation: true
   ---
   ```

**Default behavior (false):**
- Command available to SlashCommand tool
- Claude can invoke programmatically
- Still available for manual invocation

**When true:**
- Command only invokable by user typing `/command`
- Not available to SlashCommand tool
- Safer for sensitive operations

**Best practices:**
- Use sparingly (limits Claude's autonomy)
- Document why in command comments
- Consider if command should exist if always manual

## Complete Examples

### Minimal Command

No frontmatter needed:

```markdown
Review this code for common issues and suggest improvements.
```

### Simple Command

Just description:

```markdown
---
description: Review code for issues
---

Review this code for common issues and suggest improvements.
```

### Standard Command

Description and tools:

```markdown
---
description: Review Git changes
allowed-tools: Bash(git:*), Read
---

Current changes: !`git diff --name-only`

Review each changed file for:
- Code quality
- Potential bugs
- Best practices
```

### Complex Command

All common fields:

```markdown
---
description: Deploy application to environment
argument-hint: [app-name] [environment] [version]
allowed-tools: Bash(kubectl:*), Bash(helm:*), Read
model: sonnet
---

Deploy $1 to $2 environment using version $3

Pre-deployment checks:
- Verify $2 configuration
- Check cluster status: !`kubectl cluster-info`
- Validate version $3 exists

Proceed with deployment following deployment runbook.
```

### Manual-Only Command

Restricted invocation:

```markdown
---
description: Approve production deployment
argument-hint: [deployment-id]
disable-model-invocation: true
allowed-tools: Bash(gh:*)
---

<!--
MANUAL APPROVAL REQUIRED
This command requires human judgment and cannot be automated.
-->

Review deployment $1 for production approval:

Deployment details: !`gh api /deployments/$1`

Verify:
- All tests passed
- Security scan clean
- Stakeholder approval
- Rollback plan ready

Type "APPROVED" to confirm deployment.
```

## Validation

### Common Errors

**Invalid YAML syntax:**
```yaml
---
description: Missing quote
allowed-tools: Read, Write
model: sonnet
---  # ❌ Missing closing quote above
```

**Fix:** Validate YAML syntax

**Incorrect tool specification:**
```yaml
allowed-tools: Bash  # ❌ Missing command filter
```

**Fix:** Use `Bash(git:*)` format

**Invalid model name:**
```yaml
model: gpt4  # ❌ Not a valid Claude model
```

**Fix:** Use `sonnet`, `opus`, or `haiku`

### Validation Checklist

Before committing command:
- [ ] YAML syntax valid (no errors)
- [ ] Description under 60 characters
- [ ] allowed-tools uses proper format
- [ ] model is valid value if specified
- [ ] argument-hint matches positional arguments
- [ ] disable-model-invocation used appropriately

## Best Practices Summary

1. **Start minimal:** Add frontmatter only when needed
2. **Document arguments:** Always use argument-hint with arguments
3. **Restrict tools:** Use most restrictive allowed-tools that works
4. **Choose right model:** Use haiku for speed, opus for complexity
5. **Manual-only sparingly:** Only use disable-model-invocation when necessary
6. **Clear descriptions:** Make commands discoverable in `/help`
7. **Test thoroughly:** Verify frontmatter works as expected

---

## Source: command-development/references / interactive-commands.md

# Interactive Command Patterns

Comprehensive guide to creating commands that gather user feedback and make decisions through the AskUserQuestion tool.

## Overview

Some commands need user input that doesn't work well with simple arguments. For example:
- Choosing between multiple complex options with trade-offs
- Selecting multiple items from a list
- Making decisions that require explanation
- Gathering preferences or configuration interactively

For these cases, use the **AskUserQuestion tool** within command execution rather than relying on command arguments.

## When to Use AskUserQuestion

### Use AskUserQuestion When:

1. **Multiple choice decisions** with explanations needed
2. **Complex options** that require context to choose
3. **Multi-select scenarios** (choosing multiple items)
4. **Preference gathering** for configuration
5. **Interactive workflows** that adapt based on answers

### Use Command Arguments When:

1. **Simple values** (file paths, numbers, names)
2. **Known inputs** user already has
3. **Scriptable workflows** that should be automatable
4. **Fast invocations** where prompting would slow down

## AskUserQuestion Basics

### Tool Parameters

```typescript
{
  questions: [
    {
      question: "Which authentication method should we use?",
      header: "Auth method",  // Short label (max 12 chars)
      multiSelect: false,     // true for multiple selection
      options: [
        {
          label: "OAuth 2.0",
          description: "Industry standard, supports multiple providers"
        },
        {
          label: "JWT",
          description: "Stateless, good for APIs"
        },
        {
          label: "Session",
          description: "Traditional, server-side state"
        }
      ]
    }
  ]
}
```

**Key points:**
- Users can always choose "Other" to provide custom input (automatic)
- `multiSelect: true` allows selecting multiple options
- Options should be 2-4 choices (not more)
- Can ask 1-4 questions per tool call

## Command Pattern for User Interaction

### Basic Interactive Command

```markdown
---
description: Interactive setup command
allowed-tools: AskUserQuestion, Write
---

# Interactive Plugin Setup

This command will guide you through configuring the plugin with a series of questions.

## Step 1: Gather Configuration

Use the AskUserQuestion tool to ask:

**Question 1 - Deployment target:**
- header: "Deploy to"
- question: "Which deployment platform will you use?"
- options:
  - AWS (Amazon Web Services with ECS/EKS)
  - GCP (Google Cloud with GKE)
  - Azure (Microsoft Azure with AKS)
  - Local (Docker on local machine)

**Question 2 - Environment strategy:**
- header: "Environments"
- question: "How many environments do you need?"
- options:
  - Single (Just production)
  - Standard (Dev, Staging, Production)
  - Complete (Dev, QA, Staging, Production)

**Question 3 - Features to enable:**
- header: "Features"
- question: "Which features do you want to enable?"
- multiSelect: true
- options:
  - Auto-scaling (Automatic resource scaling)
  - Monitoring (Health checks and metrics)
  - CI/CD (Automated deployment pipeline)
  - Backups (Automated database backups)

## Step 2: Process Answers

Based on the answers received from AskUserQuestion:

1. Parse the deployment target choice
2. Set up environment-specific configuration
3. Enable selected features
4. Generate configuration files

## Step 3: Generate Configuration

Create `.claude/plugin-name.local.md` with:

\`\`\`yaml
---
deployment_target: [answer from Q1]
environments: [answer from Q2]
features:
  auto_scaling: [true if selected in Q3]
  monitoring: [true if selected in Q3]
  ci_cd: [true if selected in Q3]
  backups: [true if selected in Q3]
---

# Plugin Configuration

Generated: [timestamp]
Target: [deployment_target]
Environments: [environments]
\`\`\`

## Step 4: Confirm and Next Steps

Confirm configuration created and guide user on next steps.
```

### Multi-Stage Interactive Workflow

```markdown
---
description: Multi-stage interactive workflow
allowed-tools: AskUserQuestion, Read, Write, Bash
---

# Multi-Stage Deployment Setup

This command walks through deployment setup in stages, adapting based on your answers.

## Stage 1: Basic Configuration

Use AskUserQuestion to ask about deployment basics.

Based on answers, determine which additional questions to ask.

## Stage 2: Advanced Options (Conditional)

If user selected "Advanced" deployment in Stage 1:

Use AskUserQuestion to ask about:
- Load balancing strategy
- Caching configuration
- Security hardening options

If user selected "Simple" deployment:
- Skip advanced questions
- Use sensible defaults

## Stage 3: Confirmation

Show summary of all selections.

Use AskUserQuestion for final confirmation:
- header: "Confirm"
- question: "Does this configuration look correct?"
- options:
  - Yes (Proceed with setup)
  - No (Start over)
  - Modify (Let me adjust specific settings)

If "Modify", ask which specific setting to change.

## Stage 4: Execute Setup

Based on confirmed configuration, execute setup steps.
```

## Interactive Question Design

### Question Structure

**Good questions:**
```markdown
Question: "Which database should we use for this project?"
Header: "Database"
Options:
  - PostgreSQL (Relational, ACID compliant, best for complex queries)
  - MongoDB (Document store, flexible schema, best for rapid iteration)
  - Redis (In-memory, fast, best for caching and sessions)
```

**Poor questions:**
```markdown
Question: "Database?"  // Too vague
Header: "DB"  // Unclear abbreviation
Options:
  - Option 1  // Not descriptive
  - Option 2
```

### Option Design Best Practices

**Clear labels:**
- Use 1-5 words
- Specific and descriptive
- No jargon without context

**Helpful descriptions:**
- Explain what the option means
- Mention key benefits or trade-offs
- Help user make informed decision
- Keep to 1-2 sentences

**Appropriate number:**
- 2-4 options per question
- Don't overwhelm with too many choices
- Group related options
- "Other" automatically provided

### Multi-Select Questions

**When to use multiSelect:**

```markdown
Use AskUserQuestion for enabling features:

Question: "Which features do you want to enable?"
Header: "Features"
multiSelect: true  // Allow selecting multiple
Options:
  - Logging (Detailed operation logs)
  - Metrics (Performance monitoring)
  - Alerts (Error notifications)
  - Backups (Automatic backups)
```

User can select any combination: none, some, or all.

**When NOT to use multiSelect:**

```markdown
Question: "Which authentication method?"
multiSelect: false  // Only one auth method makes sense
```

Mutually exclusive choices should not use multiSelect.

## Command Patterns with AskUserQuestion

### Pattern 1: Simple Yes/No Decision

```markdown
---
description: Command with confirmation
allowed-tools: AskUserQuestion, Bash
---

# Destructive Operation

This operation will delete all cached data.

Use AskUserQuestion to confirm:

Question: "This will delete all cached data. Are you sure?"
Header: "Confirm"
Options:
  - Yes (Proceed with deletion)
  - No (Cancel operation)

If user selects "Yes":
  Execute deletion
  Report completion

If user selects "No":
  Cancel operation
  Exit without changes
```

### Pattern 2: Multiple Configuration Questions

```markdown
---
description: Multi-question configuration
allowed-tools: AskUserQuestion, Write
---

# Project Configuration Setup

Gather configuration through multiple questions.

Use AskUserQuestion with multiple questions in one call:

**Question 1:**
- question: "Which programming language?"
- header: "Language"
- options: Python, TypeScript, Go, Rust

**Question 2:**
- question: "Which test framework?"
- header: "Testing"
- options: Jest, PyTest, Go Test, Cargo Test
  (Adapt based on language from Q1)

**Question 3:**
- question: "Which CI/CD platform?"
- header: "CI/CD"
- options: GitHub Actions, GitLab CI, CircleCI

**Question 4:**
- question: "Which features do you need?"
- header: "Features"
- multiSelect: true
- options: Linting, Type checking, Code coverage, Security scanning

Process all answers together to generate cohesive configuration.
```

### Pattern 3: Conditional Question Flow

```markdown
---
description: Conditional interactive workflow
allowed-tools: AskUserQuestion, Read, Write
---

# Adaptive Configuration

## Question 1: Deployment Complexity

Use AskUserQuestion:

Question: "How complex is your deployment?"
Header: "Complexity"
Options:
  - Simple (Single server, straightforward)
  - Standard (Multiple servers, load balancing)
  - Complex (Microservices, orchestration)

## Conditional Questions Based on Answer

If answer is "Simple":
  - No additional questions
  - Use minimal configuration

If answer is "Standard":
  - Ask about load balancing strategy
  - Ask about scaling policy

If answer is "Complex":
  - Ask about orchestration platform (Kubernetes, Docker Swarm)
  - Ask about service mesh (Istio, Linkerd, None)
  - Ask about monitoring (Prometheus, Datadog, CloudWatch)
  - Ask about logging aggregation

## Process Conditional Answers

Generate configuration appropriate for selected complexity level.
```

### Pattern 4: Iterative Collection

```markdown
---
description: Collect multiple items iteratively
allowed-tools: AskUserQuestion, Write
---

# Collect Team Members

We'll collect team member information for the project.

## Question: How many team members?

Use AskUserQuestion:

Question: "How many team members should we set up?"
Header: "Team size"
Options:
  - 2 people
  - 3 people
  - 4 people
  - 6 people

## Iterate Through Team Members

For each team member (1 to N based on answer):

Use AskUserQuestion for member details:

Question: "What role for team member [number]?"
Header: "Role"
Options:
  - Frontend Developer
  - Backend Developer
  - DevOps Engineer
  - QA Engineer
  - Designer

Store each member's information.

## Generate Team Configuration

After collecting all N members, create team configuration file with all members and their roles.
```

### Pattern 5: Dependency Selection

```markdown
---
description: Select dependencies with multi-select
allowed-tools: AskUserQuestion
---

# Configure Project Dependencies

## Question: Required Libraries

Use AskUserQuestion with multiSelect:

Question: "Which libraries does your project need?"
Header: "Dependencies"
multiSelect: true
Options:
  - React (UI framework)
  - Express (Web server)
  - TypeORM (Database ORM)
  - Jest (Testing framework)
  - Axios (HTTP client)

User can select any combination.

## Process Selections

For each selected library:
- Add to package.json dependencies
- Generate sample configuration
- Create usage examples
- Update documentation
```

## Best Practices for Interactive Commands

### Question Design

1. **Clear and specific**: Question should be unambiguous
2. **Concise header**: Max 12 characters for clean display
3. **Helpful options**: Labels are clear, descriptions explain trade-offs
4. **Appropriate count**: 2-4 options per question, 1-4 questions per call
5. **Logical order**: Questions flow naturally

### Error Handling

```markdown
# Handle AskUserQuestion Responses

After calling AskUserQuestion, verify answers received:

If answers are empty or invalid:
  Something went wrong gathering responses.

  Please try again or provide configuration manually:
  [Show alternative approach]

  Exit.

If answers look correct:
  Process as expected
```

### Progressive Disclosure

```markdown
# Start Simple, Get Detailed as Needed

## Question 1: Setup Type

Use AskUserQuestion:

Question: "How would you like to set up?"
Header: "Setup type"
Options:
  - Quick (Use recommended defaults)
  - Custom (Configure all options)
  - Guided (Step-by-step with explanations)

If "Quick":
  Apply defaults, minimal questions

If "Custom":
  Ask all available configuration questions

If "Guided":
  Ask questions with extra explanation
  Provide recommendations along the way
```

### Multi-Select Guidelines

**Good multi-select use:**
```markdown
Question: "Which features do you want to enable?"
multiSelect: true
Options:
  - Logging
  - Metrics
  - Alerts
  - Backups

Reason: User might want any combination
```

**Bad multi-select use:**
```markdown
Question: "Which database engine?"
multiSelect: true  // ❌ Should be single-select

Reason: Can only use one database engine
```

## Advanced Patterns

### Validation Loop

```markdown
---
description: Interactive with validation
allowed-tools: AskUserQuestion, Bash
---

# Setup with Validation

## Gather Configuration

Use AskUserQuestion to collect settings.

## Validate Configuration

Check if configuration is valid:
- Required dependencies available?
- Settings compatible with each other?
- No conflicts detected?

If validation fails:
  Show validation errors

  Use AskUserQuestion to ask:

  Question: "Configuration has issues. What would you like to do?"
  Header: "Next step"
  Options:
    - Fix (Adjust settings to resolve issues)
    - Override (Proceed despite warnings)
    - Cancel (Abort setup)

  Based on answer, retry or proceed or exit.
```

### Build Configuration Incrementally

```markdown
---
description: Incremental configuration builder
allowed-tools: AskUserQuestion, Write, Read
---

# Incremental Setup

## Phase 1: Core Settings

Use AskUserQuestion for core settings.

Save to `.claude/config-partial.yml`

## Phase 2: Review Core Settings

Show user the core settings:

Based on these core settings, you need to configure:
- [Setting A] (because you chose [X])
- [Setting B] (because you chose [Y])

Ready to continue?

## Phase 3: Detailed Settings

Use AskUserQuestion for settings based on Phase 1 answers.

Merge with core settings.

## Phase 4: Final Review

Present complete configuration.

Use AskUserQuestion for confirmation:

Question: "Is this configuration correct?"
Options:
  - Yes (Save and apply)
  - No (Start over)
  - Modify (Edit specific settings)
```

### Dynamic Options Based on Context

```markdown
---
description: Context-aware questions
allowed-tools: AskUserQuestion, Bash, Read
---

# Context-Aware Setup

## Detect Current State

Check existing configuration:
- Current language: !`detect-language.sh`
- Existing frameworks: !`detect-frameworks.sh`
- Available tools: !`check-tools.sh`

## Ask Context-Appropriate Questions

Based on detected language, ask relevant questions.

If language is TypeScript:

  Use AskUserQuestion:

  Question: "Which TypeScript features should we enable?"
  Options:
    - Strict Mode (Maximum type safety)
    - Decorators (Experimental decorator support)
    - Path Mapping (Module path aliases)

If language is Python:

  Use AskUserQuestion:

  Question: "Which Python tools should we configure?"
  Options:
    - Type Hints (mypy for type checking)
    - Black (Code formatting)
    - Pylint (Linting and style)

Questions adapt to project context.
```

## Real-World Example: Multi-Agent Swarm Launch

**From multi-agent-swarm plugin:**

```markdown
---
description: Launch multi-agent swarm
allowed-tools: AskUserQuestion, Read, Write, Bash
---

# Launch Multi-Agent Swarm

## Interactive Mode (No Task List Provided)

If user didn't provide task list file, help create one interactively.

### Question 1: Agent Count

Use AskUserQuestion:

Question: "How many agents should we launch?"
Header: "Agent count"
Options:
  - 2 agents (Best for simple projects)
  - 3 agents (Good for medium projects)
  - 4 agents (Standard team size)
  - 6 agents (Large projects)
  - 8 agents (Complex multi-component projects)

### Question 2: Task Definition Approach

Use AskUserQuestion:

Question: "How would you like to define tasks?"
Header: "Task setup"
Options:
  - File (I have a task list file ready)
  - Guided (Help me create tasks interactively)
  - Custom (Other approach)

If "File":
  Ask for file path
  Validate file exists and has correct format

If "Guided":
  Enter iterative task creation mode (see below)

### Question 3: Coordination Mode

Use AskUserQuestion:

Question: "How should agents coordinate?"
Header: "Coordination"
Options:
  - Team Leader (One agent coordinates others)
  - Collaborative (Agents coordinate as peers)
  - Autonomous (Independent work, minimal coordination)

### Iterative Task Creation (If "Guided" Selected)

For each agent (1 to N from Question 1):

**Question A: Agent Name**
Question: "What should we call agent [number]?"
Header: "Agent name"
Options:
  - auth-agent
  - api-agent
  - ui-agent
  - db-agent
  (Provide relevant suggestions based on common patterns)

**Question B: Task Type**
Question: "What task for [agent-name]?"
Header: "Task type"
Options:
  - Authentication (User auth, JWT, OAuth)
  - API Endpoints (REST/GraphQL APIs)
  - UI Components (Frontend components)
  - Database (Schema, migrations, queries)
  - Testing (Test suites and coverage)
  - Documentation (Docs, README, guides)

**Question C: Dependencies**
Question: "What does [agent-name] depend on?"
Header: "Dependencies"
multiSelect: true
Options:
  - [List of previously defined agents]
  - No dependencies

**Question D: Base Branch**
Question: "Which base branch for PR?"
Header: "PR base"
Options:
  - main
  - staging
  - develop

Store all task information for each agent.

### Generate Task List File

After collecting all agent task details:

1. Ask for project name
2. Generate task list in proper format
3. Save to `.daisy/swarm/tasks.md`
4. Show user the file path
5. Proceed with launch using generated task list
```

## Best Practices

### Question Writing

1. **Be specific**: "Which database?" not "Choose option?"
2. **Explain trade-offs**: Describe pros/cons in option descriptions
3. **Provide context**: Question text should stand alone
4. **Guide decisions**: Help user make informed choice
5. **Keep concise**: Header max 12 chars, descriptions 1-2 sentences

### Option Design

1. **Meaningful labels**: Specific, clear names
2. **Informative descriptions**: Explain what each option does
3. **Show trade-offs**: Help user understand implications
4. **Consistent detail**: All options equally explained
5. **2-4 options**: Not too few, not too many

### Flow Design

1. **Logical order**: Questions flow naturally
2. **Build on previous**: Later questions use earlier answers
3. **Minimize questions**: Ask only what's needed
4. **Group related**: Ask related questions together
5. **Show progress**: Indicate where in flow

### User Experience

1. **Set expectations**: Tell user what to expect
2. **Explain why**: Help user understand purpose
3. **Provide defaults**: Suggest recommended options
4. **Allow escape**: Let user cancel or restart
5. **Confirm actions**: Summarize before executing

## Common Patterns

### Pattern: Feature Selection

```markdown
Use AskUserQuestion:

Question: "Which features do you need?"
Header: "Features"
multiSelect: true
Options:
  - Authentication
  - Authorization
  - Rate Limiting
  - Caching
```

### Pattern: Environment Configuration

```markdown
Use AskUserQuestion:

Question: "Which environment is this?"
Header: "Environment"
Options:
  - Development (Local development)
  - Staging (Pre-production testing)
  - Production (Live environment)
```

### Pattern: Priority Selection

```markdown
Use AskUserQuestion:

Question: "What's the priority for this task?"
Header: "Priority"
Options:
  - Critical (Must be done immediately)
  - High (Important, do soon)
  - Medium (Standard priority)
  - Low (Nice to have)
```

### Pattern: Scope Selection

```markdown
Use AskUserQuestion:

Question: "What scope should we analyze?"
Header: "Scope"
Options:
  - Current file (Just this file)
  - Current directory (All files in directory)
  - Entire project (Full codebase scan)
```

## Combining Arguments and Questions

### Use Both Appropriately

**Arguments for known values:**
```markdown
---
argument-hint: [project-name]
allowed-tools: AskUserQuestion, Write
---

Setup for project: $1

Now gather additional configuration...

Use AskUserQuestion for options that require explanation.
```

**Questions for complex choices:**
```markdown
Project name from argument: $1

Now use AskUserQuestion to choose:
- Architecture pattern
- Technology stack
- Deployment strategy

These require explanation, so questions work better than arguments.
```

## Troubleshooting

**Questions not appearing:**
- Verify AskUserQuestion in allowed-tools
- Check question format is correct
- Ensure options array has 2-4 items

**User can't make selection:**
- Check option labels are clear
- Verify descriptions are helpful
- Consider if too many options
- Ensure multiSelect setting is correct

**Flow feels confusing:**
- Reduce number of questions
- Group related questions
- Add explanation between stages
- Show progress through workflow

With AskUserQuestion, commands become interactive wizards that guide users through complex decisions while maintaining the clarity that simple arguments provide for straightforward inputs.

---

## Source: command-development/references / marketplace-considerations.md

# Marketplace Considerations for Commands

Guidelines for creating commands designed for distribution and marketplace success.

## Overview

Commands distributed through marketplaces need additional consideration beyond personal use commands. They must work across environments, handle diverse use cases, and provide excellent user experience for unknown users.

## Design for Distribution

### Universal Compatibility

**Cross-platform considerations:**

```markdown
---
description: Cross-platform command
allowed-tools: Bash(*)
---

# Platform-Aware Command

Detecting platform...

case "$(uname)" in
  Darwin*)  PLATFORM="macOS" ;;
  Linux*)   PLATFORM="Linux" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="Windows" ;;
  *)        PLATFORM="Unknown" ;;
esac

Platform: $PLATFORM

<!-- Adjust behavior based on platform -->
if [ "$PLATFORM" = "Windows" ]; then
  # Windows-specific handling
  PATH_SEP="\\"
  NULL_DEVICE="NUL"
else
  # Unix-like handling
  PATH_SEP="/"
  NULL_DEVICE="/dev/null"
fi

[Platform-appropriate implementation...]
```

**Avoid platform-specific commands:**

```markdown
<!-- BAD: macOS-specific -->
!`pbcopy < file.txt`

<!-- GOOD: Platform detection -->
if command -v pbcopy > /dev/null; then
  pbcopy < file.txt
elif command -v xclip > /dev/null; then
  xclip -selection clipboard < file.txt
elif command -v clip.exe > /dev/null; then
  cat file.txt | clip.exe
else
  echo "Clipboard not available on this platform"
fi
```

### Minimal Dependencies

**Check for required tools:**

```markdown
---
description: Dependency-aware command
allowed-tools: Bash(*)
---

# Check Dependencies

Required tools:
- git
- jq
- node

Checking availability...

MISSING_DEPS=""

for tool in git jq node; do
  if ! command -v $tool > /dev/null; then
    MISSING_DEPS="$MISSING_DEPS $tool"
  fi
done

if [ -n "$MISSING_DEPS" ]; then
  ❌ ERROR: Missing required dependencies:$MISSING_DEPS

  INSTALLATION:
  - git: https://git-scm.com/downloads
  - jq: https://stedolan.github.io/jq/download/
  - node: https://nodejs.org/

  Install missing tools and try again.

  Exit.
fi

✓ All dependencies available

[Continue with command...]
```

**Document optional dependencies:**

```markdown
<!--
DEPENDENCIES:
  Required:
  - git 2.0+: Version control
  - jq 1.6+: JSON processing

  Optional:
  - gh: GitHub CLI (for PR operations)
  - docker: Container operations (for containerized tests)

  Feature availability depends on installed tools.
-->
```

### Graceful Degradation

**Handle missing features:**

```markdown
---
description: Feature-aware command
---

# Feature Detection

Detecting available features...

FEATURES=""

if command -v gh > /dev/null; then
  FEATURES="$FEATURES github"
fi

if command -v docker > /dev/null; then
  FEATURES="$FEATURES docker"
fi

Available features: $FEATURES

if echo "$FEATURES" | grep -q "github"; then
  # Full functionality with GitHub integration
  echo "✓ GitHub integration available"
else
  # Reduced functionality without GitHub
  echo "⚠ Limited functionality: GitHub CLI not installed"
  echo "  Install 'gh' for full features"
fi

[Adapt behavior based on available features...]
```

## User Experience for Unknown Users

### Clear Onboarding

**First-run experience:**

```markdown
---
description: Command with onboarding
allowed-tools: Read, Write
---

# First Run Check

if [ ! -f ".claude/command-initialized" ]; then
  **Welcome to Command Name!**

  This appears to be your first time using this command.

  WHAT THIS COMMAND DOES:
  [Brief explanation of purpose and benefits]

  QUICK START:
  1. Basic usage: /command [arg]
  2. For help: /command help
  3. Examples: /command examples

  SETUP:
  No additional setup required. You're ready to go!

  ✓ Initialization complete

  [Create initialization marker]

  Ready to proceed with your request...
fi

[Normal command execution...]
```

**Progressive feature discovery:**

```markdown
---
description: Command with tips
---

# Command Execution

[Main functionality...]

---

💡 TIP: Did you know?

You can speed up this command with the --fast flag:
  /command --fast [args]

For more tips: /command tips
```

### Comprehensive Error Handling

**Anticipate user mistakes:**

```markdown
---
description: Forgiving command
---

# User Input Handling

Argument: "$1"

<!-- Check for common typos -->
if [ "$1" = "hlep" ] || [ "$1" = "hepl" ]; then
  Did you mean: help?

  Showing help instead...
  [Display help]

  Exit.
fi

<!-- Suggest similar commands if not found -->
if [ "$1" != "valid-option1" ] && [ "$1" != "valid-option2" ]; then
  ❌ Unknown option: $1

  Did you mean:
  - valid-option1 (most similar)
  - valid-option2

  For all options: /command help

  Exit.
fi

[Command continues...]
```

**Helpful diagnostics:**

```markdown
---
description: Diagnostic command
---

# Operation Failed

The operation could not complete.

**Diagnostic Information:**

Environment:
- Platform: $(uname)
- Shell: $SHELL
- Working directory: $(pwd)
- Command: /command $@

Checking common issues:
- Git repository: $(git rev-parse --git-dir 2>&1)
- Write permissions: $(test -w . && echo "OK" || echo "DENIED")
- Required files: $(test -f config.yml && echo "Found" || echo "Missing")

This information helps debug the issue.

For support, include the above diagnostics.
```

## Distribution Best Practices

### Namespace Awareness

**Avoid name collisions:**

```markdown
---
description: Namespaced command
---

<!--
COMMAND NAME: plugin-name-command

This command is namespaced with the plugin name to avoid
conflicts with commands from other plugins.

Alternative naming approaches:
- Use plugin prefix: /plugin-command
- Use category: /category-command
- Use verb-noun: /verb-noun

Chosen approach: plugin-name prefix
Reasoning: Clearest ownership, least likely to conflict
-->

# Plugin Name Command

[Implementation...]
```

**Document naming rationale:**

```markdown
<!--
NAMING DECISION:

Command name: /deploy-app

Alternatives considered:
- /deploy: Too generic, likely conflicts
- /app-deploy: Less intuitive ordering
- /my-plugin-deploy: Too verbose

Final choice balances:
- Discoverability (clear purpose)
- Brevity (easy to type)
- Uniqueness (unlikely conflicts)
-->
```

### Configurability

**User preferences:**

```markdown
---
description: Configurable command
allowed-tools: Read
---

# Load User Configuration

Default configuration:
- verbose: false
- color: true
- max_results: 10

Checking for user config: .claude/plugin-name.local.md

if [ -f ".claude/plugin-name.local.md" ]; then
  # Parse YAML frontmatter for settings
  VERBOSE=$(grep "^verbose:" .claude/plugin-name.local.md | cut -d: -f2 | tr -d ' ')
  COLOR=$(grep "^color:" .claude/plugin-name.local.md | cut -d: -f2 | tr -d ' ')
  MAX_RESULTS=$(grep "^max_results:" .claude/plugin-name.local.md | cut -d: -f2 | tr -d ' ')

  echo "✓ Using user configuration"
else
  echo "Using default configuration"
  echo "Create .claude/plugin-name.local.md to customize"
fi

[Use configuration in command...]
```

**Sensible defaults:**

```markdown
---
description: Command with smart defaults
---

# Smart Defaults

Configuration:
- Format: ${FORMAT:-json}  # Defaults to json
- Output: ${OUTPUT:-stdout}  # Defaults to stdout
- Verbose: ${VERBOSE:-false}  # Defaults to false

These defaults work for 80% of use cases.

Override with arguments:
  /command --format yaml --output file.txt --verbose

Or set in .claude/plugin-name.local.md:
\`\`\`yaml
---
format: yaml
output: custom.txt
verbose: true
---
\`\`\`
```

### Version Compatibility

**Version checking:**

```markdown
---
description: Version-aware command
---

<!--
COMMAND VERSION: 2.1.0

COMPATIBILITY:
- Requires plugin version: >= 2.0.0
- Breaking changes from v1.x documented in MIGRATION.md

VERSION HISTORY:
- v2.1.0: Added --new-feature flag
- v2.0.0: BREAKING: Changed argument order
- v1.0.0: Initial release
-->

# Version Check

Command version: 2.1.0
Plugin version: [detect from plugin.json]

if [  "$PLUGIN_VERSION" < "2.0.0" ]; then
  ❌ ERROR: Incompatible plugin version

  This command requires plugin version >= 2.0.0
  Current version: $PLUGIN_VERSION

  Update plugin:
    /plugin update plugin-name

  Exit.
fi

✓ Version compatible

[Command continues...]
```

**Deprecation warnings:**

```markdown
---
description: Command with deprecation warnings
---

# Deprecation Check

if [ "$1" = "--old-flag" ]; then
  ⚠️  DEPRECATION WARNING

  The --old-flag option is deprecated as of v2.0.0
  It will be removed in v3.0.0 (est. June 2025)

  Use instead: --new-flag

  Example:
    Old: /command --old-flag value
    New: /command --new-flag value

  See migration guide: /command migrate

  Continuing with deprecated behavior for now...
fi

[Handle both old and new flags during deprecation period...]
```

## Marketplace Presentation

### Command Discovery

**Descriptive naming:**

```markdown
---
description: Review pull request with security and quality checks
---

<!-- GOOD: Descriptive name and description -->
```

```markdown
---
description: Do the thing
---

<!-- BAD: Vague description -->
```

**Searchable keywords:**

```markdown
<!--
KEYWORDS: security, code-review, quality, validation, audit

These keywords help users discover this command when searching
for related functionality in the marketplace.
-->
```

### Showcase Examples

**Compelling demonstrations:**

```markdown
---
description: Advanced code analysis command
---

# Code Analysis Command

This command performs deep code analysis with actionable insights.

## Demo: Quick Security Audit

Try it now:
\`\`\`
/analyze-code src/ --security
\`\`\`

**What you'll get:**
- Security vulnerability detection
- Code quality metrics
- Performance bottleneck identification
- Actionable recommendations

**Sample output:**
\`\`\`
Security Analysis Results
=========================

🔴 Critical (2):
  - SQL injection risk in users.js:45
  - XSS vulnerability in display.js:23

🟡 Warnings (5):
  - Unvalidated input in api.js:67
  ...

Recommendations:
1. Fix critical issues immediately
2. Review warnings before next release
3. Run /analyze-code --fix for auto-fixes
\`\`\`

---

Ready to analyze your code...

[Command implementation...]
```

### User Reviews and Feedback

**Feedback mechanism:**

```markdown
---
description: Command with feedback
---

# Command Complete

[Command results...]

---

**How was your experience?**

This helps improve the command for everyone.

Rate this command:
- 👍 Helpful
- 👎 Not helpful
- 🐛 Found a bug
- 💡 Have a suggestion

Reply with an emoji or:
- /command feedback

Your feedback matters!
```

**Usage analytics preparation:**

```markdown
<!--
ANALYTICS NOTES:

Track for improvement:
- Most common arguments
- Failure rates
- Average execution time
- User satisfaction scores

Privacy-preserving:
- No personally identifiable information
- Aggregate statistics only
- User opt-out respected
-->
```

## Quality Standards

### Professional Polish

**Consistent branding:**

```markdown
---
description: Branded command
---

# ✨ Command Name

Part of the [Plugin Name] suite

[Command functionality...]

---

**Need Help?**
- Documentation: https://docs.example.com
- Support: support@example.com
- Community: https://community.example.com

Powered by Plugin Name v2.1.0
```

**Attention to detail:**

```markdown
<!-- Details that matter -->

✓ Use proper emoji/symbols consistently
✓ Align output columns neatly
✓ Format numbers with thousands separators
✓ Use color/formatting appropriately
✓ Provide progress indicators
✓ Show estimated time remaining
✓ Confirm successful operations
```

### Reliability

**Idempotency:**

```markdown
---
description: Idempotent command
---

# Safe Repeated Execution

Checking if operation already completed...

if [ -f ".claude/operation-completed.flag" ]; then
  ℹ️  Operation already completed

  Completed at: $(cat .claude/operation-completed.flag)

  To re-run:
  1. Remove flag: rm .claude/operation-completed.flag
  2. Run command again

  Otherwise, no action needed.

  Exit.
fi

Performing operation...

[Safe, repeatable operation...]

Marking complete...
echo "$(date)" > .claude/operation-completed.flag
```

**Atomic operations:**

```markdown
---
description: Atomic command
---

# Atomic Operation

This operation is atomic - either fully succeeds or fully fails.

Creating temporary workspace...
TEMP_DIR=$(mktemp -d)

Performing changes in isolated environment...
[Make changes in $TEMP_DIR]

if [ $? -eq 0 ]; then
  ✓ Changes validated

  Applying changes atomically...
  mv $TEMP_DIR/* ./target/

  ✓ Operation complete
else
  ❌ Changes failed validation

  Rolling back...
  rm -rf $TEMP_DIR

  No changes applied. Safe to retry.
fi
```

## Testing for Distribution

### Pre-Release Checklist

```markdown
<!--
PRE-RELEASE CHECKLIST:

Functionality:
- [ ] Works on macOS
- [ ] Works on Linux
- [ ] Works on Windows (WSL)
- [ ] All arguments tested
- [ ] Error cases handled
- [ ] Edge cases covered

User Experience:
- [ ] Clear description
- [ ] Helpful error messages
- [ ] Examples provided
- [ ] First-run experience good
- [ ] Documentation complete

Distribution:
- [ ] No hardcoded paths
- [ ] Dependencies documented
- [ ] Configuration options clear
- [ ] Version number set
- [ ] Changelog updated

Quality:
- [ ] No TODO comments
- [ ] No debug code
- [ ] Performance acceptable
- [ ] Security reviewed
- [ ] Privacy considered

Support:
- [ ] README complete
- [ ] Troubleshooting guide
- [ ] Support contact provided
- [ ] Feedback mechanism
- [ ] License specified
-->
```

### Beta Testing

**Beta release approach:**

```markdown
---
description: Beta command (v0.9.0)
---

# 🧪 Beta Command

**This is a beta release**

Features may change based on feedback.

BETA STATUS:
- Version: 0.9.0
- Stability: Experimental
- Support: Limited
- Feedback: Encouraged

Known limitations:
- Performance not optimized
- Some edge cases not handled
- Documentation incomplete

Help improve this command:
- Report issues: /command report-issue
- Suggest features: /command suggest
- Join beta testers: /command join-beta

---

[Command implementation...]

---

**Thank you for beta testing!**

Your feedback helps make this command better.
```

## Maintenance and Updates

### Update Strategy

**Versioned commands:**

```markdown
<!--
VERSION STRATEGY:

Major (X.0.0): Breaking changes
- Document all breaking changes
- Provide migration guide
- Support old version briefly

Minor (x.Y.0): New features
- Backward compatible
- Announce new features
- Update examples

Patch (x.y.Z): Bug fixes
- No user-facing changes
- Update changelog
- Security fixes prioritized

Release schedule:
- Patches: As needed
- Minors: Monthly
- Majors: Annually or as needed
-->
```

**Update notifications:**

```markdown
---
description: Update-aware command
---

# Check for Updates

Current version: 2.1.0
Latest version: [check if available]

if [ "$CURRENT_VERSION" != "$LATEST_VERSION" ]; then
  📢 UPDATE AVAILABLE

  New version: $LATEST_VERSION
  Current: $CURRENT_VERSION

  What's new:
  - Feature improvements
  - Bug fixes
  - Performance enhancements

  Update with:
    /plugin update plugin-name

  Release notes: https://releases.example.com/v$LATEST_VERSION
fi

[Command continues...]
```

## Best Practices Summary

### Distribution Design

1. **Universal**: Works across platforms and environments
2. **Self-contained**: Minimal dependencies, clear requirements
3. **Graceful**: Degrades gracefully when features unavailable
4. **Forgiving**: Anticipates and handles user mistakes
5. **Helpful**: Clear errors, good defaults, excellent docs

### Marketplace Success

1. **Discoverable**: Clear name, good description, searchable keywords
2. **Professional**: Polished presentation, consistent branding
3. **Reliable**: Tested thoroughly, handles edge cases
4. **Maintainable**: Versioned, updated regularly, supported
5. **User-focused**: Great UX, responsive to feedback

### Quality Standards

1. **Complete**: Fully documented, all features working
2. **Tested**: Works in real environments, edge cases handled
3. **Secure**: No vulnerabilities, safe operations
4. **Performant**: Reasonable speed, resource-efficient
5. **Ethical**: Privacy-respecting, user consent

With these considerations, commands become marketplace-ready and delight users across diverse environments and use cases.

---

## Source: command-development/references / plugin-features-reference.md

# Plugin-Specific Command Features Reference

This reference covers features and patterns specific to commands bundled in Claude Code plugins.

## Table of Contents

- [Plugin Command Discovery](#plugin-command-discovery)
- [CLAUDE_PLUGIN_ROOT Environment Variable](#claude_plugin_root-environment-variable)
- [Plugin Command Patterns](#plugin-command-patterns)
- [Integration with Plugin Components](#integration-with-plugin-components)
- [Validation Patterns](#validation-patterns)

## Plugin Command Discovery

### Auto-Discovery

Claude Code automatically discovers commands in plugins using the following locations:

```
plugin-name/
├── commands/              # Auto-discovered commands
│   ├── foo.md            # /foo (plugin:plugin-name)
│   └── bar.md            # /bar (plugin:plugin-name)
└── plugin.json           # Plugin manifest
```

**Key points:**
- Commands are discovered at plugin load time
- No manual registration required
- Commands appear in `/help` with "(plugin:plugin-name)" label
- Subdirectories create namespaces

### Namespaced Plugin Commands

Organize commands in subdirectories for logical grouping:

```
plugin-name/
└── commands/
    ├── review/
    │   ├── security.md    # /security (plugin:plugin-name:review)
    │   └── style.md       # /style (plugin:plugin-name:review)
    └── deploy/
        ├── staging.md     # /staging (plugin:plugin-name:deploy)
        └── prod.md        # /prod (plugin:plugin-name:deploy)
```

**Namespace behavior:**
- Subdirectory name becomes namespace
- Shown as "(plugin:plugin-name:namespace)" in `/help`
- Helps organize related commands
- Use when plugin has 5+ commands

### Command Naming Conventions

**Plugin command names should:**
1. Be descriptive and action-oriented
2. Avoid conflicts with common command names
3. Use hyphens for multi-word names
4. Consider prefixing with plugin name for uniqueness

**Examples:**
```
Good:
- /mylyn-sync          (plugin-specific prefix)
- /analyze-performance (descriptive action)
- /docker-compose-up   (clear purpose)

Avoid:
- /test               (conflicts with common name)
- /run                (too generic)
- /do-stuff           (not descriptive)
```

## CLAUDE_PLUGIN_ROOT Environment Variable

### Purpose

`${CLAUDE_PLUGIN_ROOT}` is a special environment variable available in plugin commands that resolves to the absolute path of the plugin directory.

**Why it matters:**
- Enables portable paths within plugin
- Allows referencing plugin files and scripts
- Works across different installations
- Essential for multi-file plugin operations

### Basic Usage

Reference files within your plugin:

```markdown
---
description: Analyze using plugin script
allowed-tools: Bash(node:*), Read
---

Run analysis: !`node ${CLAUDE_PLUGIN_ROOT}/scripts/analyze.js`

Read template: @${CLAUDE_PLUGIN_ROOT}/templates/report.md
```

**Expands to:**
```
Run analysis: !`node /path/to/plugins/plugin-name/scripts/analyze.js`

Read template: @/path/to/plugins/plugin-name/templates/report.md
```

### Common Patterns

#### 1. Executing Plugin Scripts

```markdown
---
description: Run custom linter from plugin
allowed-tools: Bash(node:*)
---

Lint results: !`node ${CLAUDE_PLUGIN_ROOT}/bin/lint.js $1`

Review the linting output and suggest fixes.
```

#### 2. Loading Configuration Files

```markdown
---
description: Deploy using plugin configuration
allowed-tools: Read, Bash(*)
---

Configuration: @${CLAUDE_PLUGIN_ROOT}/config/deploy-config.json

Deploy application using the configuration above for $1 environment.
```

#### 3. Accessing Plugin Resources

```markdown
---
description: Generate report from template
---

Use this template: @${CLAUDE_PLUGIN_ROOT}/templates/api-report.md

Generate a report for @$1 following the template format.
```

#### 4. Multi-Step Plugin Workflows

```markdown
---
description: Complete plugin workflow
allowed-tools: Bash(*), Read
---

Step 1 - Prepare: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/prepare.sh $1`
Step 2 - Config: @${CLAUDE_PLUGIN_ROOT}/config/$1.json
Step 3 - Execute: !`${CLAUDE_PLUGIN_ROOT}/bin/execute $1`

Review results and report status.
```

### Best Practices

1. **Always use for plugin-internal paths:**
   ```markdown
   # Good
   @${CLAUDE_PLUGIN_ROOT}/templates/foo.md

   # Bad
   @./templates/foo.md  # Relative to current directory, not plugin
   ```

2. **Validate file existence:**
   ```markdown
   ---
   description: Use plugin config if exists
   allowed-tools: Bash(test:*), Read
   ---

   !`test -f ${CLAUDE_PLUGIN_ROOT}/config.json && echo "exists" || echo "missing"`

   If config exists, load it: @${CLAUDE_PLUGIN_ROOT}/config.json
   Otherwise, use defaults...
   ```

3. **Document plugin file structure:**
   ```markdown
   <!--
   Plugin structure:
   ${CLAUDE_PLUGIN_ROOT}/
   ├── scripts/analyze.js  (analysis script)
   ├── templates/          (report templates)
   └── config/             (configuration files)
   -->
   ```

4. **Combine with arguments:**
   ```markdown
   Run: !`${CLAUDE_PLUGIN_ROOT}/bin/process.sh $1 $2`
   ```

### Troubleshooting

**Variable not expanding:**
- Ensure command is loaded from plugin
- Check bash execution is allowed
- Verify syntax is exact: `${CLAUDE_PLUGIN_ROOT}`

**File not found errors:**
- Verify file exists in plugin directory
- Check file path is correct relative to plugin root
- Ensure file permissions allow reading/execution

**Path with spaces:**
- Bash commands automatically handle spaces
- File references work with spaces in paths
- No special quoting needed

## Plugin Command Patterns

### Pattern 1: Configuration-Based Commands

Commands that load plugin-specific configuration:

```markdown
---
description: Deploy using plugin settings
allowed-tools: Read, Bash(*)
---

Load configuration: @${CLAUDE_PLUGIN_ROOT}/deploy-config.json

Deploy to $1 environment using:
1. Configuration settings above
2. Current git branch: !`git branch --show-current`
3. Application version: !`cat package.json | grep version`

Execute deployment and monitor progress.
```

**When to use:** Commands that need consistent settings across invocations

### Pattern 2: Template-Based Generation

Commands that use plugin templates:

```markdown
---
description: Generate documentation from template
argument-hint: [component-name]
---

Template: @${CLAUDE_PLUGIN_ROOT}/templates/component-docs.md

Generate documentation for $1 component following the template structure.
Include:
- Component purpose and usage
- API reference
- Examples
- Testing guidelines
```

**When to use:** Standardized output generation

### Pattern 3: Multi-Script Workflow

Commands that orchestrate multiple plugin scripts:

```markdown
---
description: Complete build and test workflow
allowed-tools: Bash(*)
---

Build: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh`
Validate: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/validate.sh`
Test: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/test.sh`

Review all outputs and report:
1. Build status
2. Validation results
3. Test results
4. Recommended next steps
```

**When to use:** Complex plugin workflows with multiple steps

### Pattern 4: Environment-Aware Commands

Commands that adapt to environment:

```markdown
---
description: Deploy based on environment
argument-hint: [dev|staging|prod]
---

Environment config: @${CLAUDE_PLUGIN_ROOT}/config/$1.json

Environment check: !`echo "Deploying to: $1"`

Deploy application using $1 environment configuration.
Verify deployment and run smoke tests.
```

**When to use:** Commands that behave differently per environment

### Pattern 5: Plugin Data Management

Commands that manage plugin-specific data:

```markdown
---
description: Save analysis results to plugin cache
allowed-tools: Bash(*), Read, Write
---

Cache directory: ${CLAUDE_PLUGIN_ROOT}/cache/

Analyze @$1 and save results to cache:
!`mkdir -p ${CLAUDE_PLUGIN_ROOT}/cache && date > ${CLAUDE_PLUGIN_ROOT}/cache/last-run.txt`

Store analysis for future reference and comparison.
```

**When to use:** Commands that need persistent data storage

## Integration with Plugin Components

### Invoking Plugin Agents

Commands can trigger plugin agents using the Task tool:

```markdown
---
description: Deep analysis using plugin agent
argument-hint: [file-path]
---

Initiate deep code analysis of @$1 using the code-analyzer agent.

The agent will:
1. Analyze code structure
2. Identify patterns
3. Suggest improvements
4. Generate detailed report

Note: This uses the Task tool to launch the plugin's code-analyzer agent.
```

**Key points:**
- Agent must be defined in plugin's `agents/` directory
- Claude will automatically use Task tool to launch agent
- Agent has access to same plugin resources

### Invoking Plugin Skills

Commands can reference plugin skills for specialized knowledge:

```markdown
---
description: API documentation with best practices
argument-hint: [api-file]
---

Document the API in @$1 following our API documentation standards.

Use the api-docs-standards skill to ensure documentation includes:
- Endpoint descriptions
- Parameter specifications
- Response formats
- Error codes
- Usage examples

Note: This leverages the plugin's api-docs-standards skill for consistency.
```

**Key points:**
- Skill must be defined in plugin's `skills/` directory
- Mention skill by name to hint Claude should invoke it
- Skills provide specialized domain knowledge

### Coordinating with Plugin Hooks

Commands can be designed to work with plugin hooks:

```markdown
---
description: Commit with pre-commit validation
allowed-tools: Bash(git:*)
---

Stage changes: !\`git add $1\`

Commit changes: !\`git commit -m "$2"\`

Note: This commit will trigger the plugin's pre-commit hook for validation.
Review hook output for any issues.
```

**Key points:**
- Hooks execute automatically on events
- Commands can prepare state for hooks
- Document hook interaction in command

### Multi-Component Plugin Commands

Commands that coordinate multiple plugin components:

```markdown
---
description: Comprehensive code review workflow
argument-hint: [file-path]
---

File to review: @$1

Execute comprehensive review:

1. **Static Analysis** (via plugin scripts)
   !`node ${CLAUDE_PLUGIN_ROOT}/scripts/lint.js $1`

2. **Deep Review** (via plugin agent)
   Launch the code-reviewer agent for detailed analysis.

3. **Best Practices** (via plugin skill)
   Use the code-standards skill to ensure compliance.

4. **Documentation** (via plugin template)
   Template: @${CLAUDE_PLUGIN_ROOT}/templates/review-report.md

Generate final report combining all outputs.
```

**When to use:** Complex workflows leveraging multiple plugin capabilities

## Validation Patterns

### Input Validation

Commands should validate inputs before processing:

```markdown
---
description: Deploy to environment with validation
argument-hint: [environment]
---

Validate environment: !`echo "$1" | grep -E "^(dev|staging|prod)$" || echo "INVALID"`

$IF($1 in [dev, staging, prod],
  Deploy to $1 environment using validated configuration,
  ERROR: Invalid environment '$1'. Must be one of: dev, staging, prod
)
```

**Validation approaches:**
1. Bash validation using grep/test
2. Inline validation in prompt
3. Script-based validation

### File Existence Checks

Verify required files exist:

```markdown
---
description: Process configuration file
argument-hint: [config-file]
---

Check file: !`test -f $1 && echo "EXISTS" || echo "MISSING"`

Process configuration if file exists: @$1

If file doesn't exist, explain:
- Expected location
- Required format
- How to create it
```

### Required Arguments

Validate required arguments provided:

```markdown
---
description: Create deployment with version
argument-hint: [environment] [version]
---

Validate inputs: !`test -n "$1" -a -n "$2" && echo "OK" || echo "MISSING"`

$IF($1 AND $2,
  Deploy version $2 to $1 environment,
  ERROR: Both environment and version required. Usage: /deploy [env] [version]
)
```

### Plugin Resource Validation

Verify plugin resources available:

```markdown
---
description: Run analysis with plugin tools
allowed-tools: Bash(test:*)
---

Validate plugin setup:
- Config exists: !`test -f ${CLAUDE_PLUGIN_ROOT}/config.json && echo "✓" || echo "✗"`
- Scripts exist: !`test -d ${CLAUDE_PLUGIN_ROOT}/scripts && echo "✓" || echo "✗"`
- Tools available: !`test -x ${CLAUDE_PLUGIN_ROOT}/bin/analyze && echo "✓" || echo "✗"`

If all checks pass, proceed with analysis.
Otherwise, report missing components and installation steps.
```

### Output Validation

Validate command execution results:

```markdown
---
description: Build and validate output
allowed-tools: Bash(*)
---

Build: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh`

Validate output:
- Exit code: !`echo $?`
- Output exists: !`test -d dist && echo "✓" || echo "✗"`
- File count: !`find dist -type f | wc -l`

Report build status and any validation failures.
```

### Graceful Error Handling

Handle errors gracefully with helpful messages:

```markdown
---
description: Process file with error handling
argument-hint: [file-path]
---

Try processing: !`node ${CLAUDE_PLUGIN_ROOT}/scripts/process.js $1 2>&1 || echo "ERROR: $?"`

If processing succeeded:
- Report results
- Suggest next steps

If processing failed:
- Explain likely causes
- Provide troubleshooting steps
- Suggest alternative approaches
```

## Best Practices Summary

### Plugin Commands Should:

1. **Use ${CLAUDE_PLUGIN_ROOT} for all plugin-internal paths**
   - Scripts, templates, configuration, resources

2. **Validate inputs early**
   - Check required arguments
   - Verify file existence
   - Validate argument formats

3. **Document plugin structure**
   - Explain required files
   - Document script purposes
   - Clarify dependencies

4. **Integrate with plugin components**
   - Reference agents for complex tasks
   - Use skills for specialized knowledge
   - Coordinate with hooks when relevant

5. **Provide helpful error messages**
   - Explain what went wrong
   - Suggest how to fix
   - Offer alternatives

6. **Handle edge cases**
   - Missing files
   - Invalid arguments
   - Failed script execution
   - Missing dependencies

7. **Keep commands focused**
   - One clear purpose per command
   - Delegate complex logic to scripts
   - Use agents for multi-step workflows

8. **Test across installations**
   - Verify paths work everywhere
   - Test with different arguments
   - Validate error cases

---

For general command development, see main SKILL.md.
For command examples, see examples/ directory.

---

## Source: command-development/references / testing-strategies.md

# Command Testing Strategies

Comprehensive strategies for testing slash commands before deployment and distribution.

## Overview

Testing commands ensures they work correctly, handle edge cases, and provide good user experience. A systematic testing approach catches issues early and builds confidence in command reliability.

## Testing Levels

### Level 1: Syntax and Structure Validation

**What to test:**
- YAML frontmatter syntax
- Markdown format
- File location and naming

**How to test:**

```bash
# Validate YAML frontmatter
head -n 20 .claude/commands/my-command.md | grep -A 10 "^---"

# Check for closing frontmatter marker
head -n 20 .claude/commands/my-command.md | grep -c "^---" # Should be 2

# Verify file has .md extension
ls .claude/commands/*.md

# Check file is in correct location
test -f .claude/commands/my-command.md && echo "Found" || echo "Missing"
```

**Automated validation script:**

```bash
#!/bin/bash
# validate-command.sh

COMMAND_FILE="$1"

if [ ! -f "$COMMAND_FILE" ]; then
  echo "ERROR: File not found: $COMMAND_FILE"
  exit 1
fi

# Check .md extension
if [[ ! "$COMMAND_FILE" =~ \.md$ ]]; then
  echo "ERROR: File must have .md extension"
  exit 1
fi

# Validate YAML frontmatter if present
if head -n 1 "$COMMAND_FILE" | grep -q "^---"; then
  # Count frontmatter markers
  MARKERS=$(head -n 50 "$COMMAND_FILE" | grep -c "^---")
  if [ "$MARKERS" -ne 2 ]; then
    echo "ERROR: Invalid YAML frontmatter (need exactly 2 '---' markers)"
    exit 1
  fi
  echo "✓ YAML frontmatter syntax valid"
fi

# Check for empty file
if [ ! -s "$COMMAND_FILE" ]; then
  echo "ERROR: File is empty"
  exit 1
fi

echo "✓ Command file structure valid"
```

### Level 2: Frontmatter Field Validation

**What to test:**
- Field types correct
- Values in valid ranges
- Required fields present (if any)

**Validation script:**

```bash
#!/bin/bash
# validate-frontmatter.sh

COMMAND_FILE="$1"

# Extract YAML frontmatter
FRONTMATTER=$(sed -n '/^---$/,/^---$/p' "$COMMAND_FILE" | sed '1d;$d')

if [ -z "$FRONTMATTER" ]; then
  echo "No frontmatter to validate"
  exit 0
fi

# Check 'model' field if present
if echo "$FRONTMATTER" | grep -q "^model:"; then
  MODEL=$(echo "$FRONTMATTER" | grep "^model:" | cut -d: -f2 | tr -d ' ')
  if ! echo "sonnet opus haiku" | grep -qw "$MODEL"; then
    echo "ERROR: Invalid model '$MODEL' (must be sonnet, opus, or haiku)"
    exit 1
  fi
  echo "✓ Model field valid: $MODEL"
fi

# Check 'allowed-tools' field format
if echo "$FRONTMATTER" | grep -q "^allowed-tools:"; then
  echo "✓ allowed-tools field present"
  # Could add more sophisticated validation here
fi

# Check 'description' length
if echo "$FRONTMATTER" | grep -q "^description:"; then
  DESC=$(echo "$FRONTMATTER" | grep "^description:" | cut -d: -f2-)
  LENGTH=${#DESC}
  if [ "$LENGTH" -gt 80 ]; then
    echo "WARNING: Description length $LENGTH (recommend < 60 chars)"
  else
    echo "✓ Description length acceptable: $LENGTH chars"
  fi
fi

echo "✓ Frontmatter fields valid"
```

### Level 3: Manual Command Invocation

**What to test:**
- Command appears in `/help`
- Command executes without errors
- Output is as expected

**Test procedure:**

```bash
# 1. Start Claude Code
claude --debug

# 2. Check command appears in help
> /help
# Look for your command in the list

# 3. Invoke command without arguments
> /my-command
# Check for reasonable error or behavior

# 4. Invoke with valid arguments
> /my-command arg1 arg2
# Verify expected behavior

# 5. Check debug logs
tail -f ~/.claude/debug-logs/latest
# Look for errors or warnings
```

### Level 4: Argument Testing

**What to test:**
- Positional arguments work ($1, $2, etc.)
- $ARGUMENTS captures all arguments
- Missing arguments handled gracefully
- Invalid arguments detected

**Test matrix:**

| Test Case | Command | Expected Result |
|-----------|---------|-----------------|
| No args | `/cmd` | Graceful handling or useful message |
| One arg | `/cmd arg1` | $1 substituted correctly |
| Two args | `/cmd arg1 arg2` | $1 and $2 substituted |
| Extra args | `/cmd a b c d` | All captured or extras ignored appropriately |
| Special chars | `/cmd "arg with spaces"` | Quotes handled correctly |
| Empty arg | `/cmd ""` | Empty string handled |

**Test script:**

```bash
#!/bin/bash
# test-command-arguments.sh

COMMAND="$1"

echo "Testing argument handling for /$COMMAND"
echo

echo "Test 1: No arguments"
echo "  Command: /$COMMAND"
echo "  Expected: [describe expected behavior]"
echo "  Manual test required"
echo

echo "Test 2: Single argument"
echo "  Command: /$COMMAND test-value"
echo "  Expected: 'test-value' appears in output"
echo "  Manual test required"
echo

echo "Test 3: Multiple arguments"
echo "  Command: /$COMMAND arg1 arg2 arg3"
echo "  Expected: All arguments used appropriately"
echo "  Manual test required"
echo

echo "Test 4: Special characters"
echo "  Command: /$COMMAND \"value with spaces\""
echo "  Expected: Entire phrase captured"
echo "  Manual test required"
```

### Level 5: File Reference Testing

**What to test:**
- @ syntax loads file contents
- Non-existent files handled
- Large files handled appropriately
- Multiple file references work

**Test procedure:**

```bash
# Create test files
echo "Test content" > /tmp/test-file.txt
echo "Second file" > /tmp/test-file-2.txt

# Test single file reference
> /my-command /tmp/test-file.txt
# Verify file content is read

# Test non-existent file
> /my-command /tmp/nonexistent.txt
# Verify graceful error handling

# Test multiple files
> /my-command /tmp/test-file.txt /tmp/test-file-2.txt
# Verify both files processed

# Test large file
dd if=/dev/zero of=/tmp/large-file.bin bs=1M count=100
> /my-command /tmp/large-file.bin
# Verify reasonable behavior (may truncate or warn)

# Cleanup
rm /tmp/test-file*.txt /tmp/large-file.bin
```

### Level 6: Bash Execution Testing

**What to test:**
- !` commands execute correctly
- Command output included in prompt
- Command failures handled
- Security: only allowed commands run

**Test procedure:**

```bash
# Create test command with bash execution
cat > .claude/commands/test-bash.md << 'EOF'
---
description: Test bash execution
allowed-tools: Bash(echo:*), Bash(date:*)
---

Current date: !`date`
Test output: !`echo "Hello from bash"`

Analysis of output above...
EOF

# Test in Claude Code
> /test-bash
# Verify:
# 1. Date appears correctly
# 2. Echo output appears
# 3. No errors in debug logs

# Test with disallowed command (should fail or be blocked)
cat > .claude/commands/test-forbidden.md << 'EOF'
---
description: Test forbidden command
allowed-tools: Bash(echo:*)
---

Trying forbidden: !`ls -la /`
EOF

> /test-forbidden
# Verify: Permission denied or appropriate error
```

### Level 7: Integration Testing

**What to test:**
- Commands work with other plugin components
- Commands interact correctly with each other
- State management works across invocations
- Workflow commands execute in sequence

**Test scenarios:**

**Scenario 1: Command + Hook Integration**

```bash
# Setup: Command that triggers a hook
# Test: Invoke command, verify hook executes

# Command: .claude/commands/risky-operation.md
# Hook: PreToolUse that validates the operation

> /risky-operation
# Verify: Hook executes and validates before command completes
```

**Scenario 2: Command Sequence**

```bash
# Setup: Multi-command workflow
> /workflow-init
# Verify: State file created

> /workflow-step2
# Verify: State file read, step 2 executes

> /workflow-complete
# Verify: State file cleaned up
```

**Scenario 3: Command + MCP Integration**

```bash
# Setup: Command uses MCP tools
# Test: Verify MCP server accessible

> /mcp-command
# Verify:
# 1. MCP server starts (if stdio)
# 2. Tool calls succeed
# 3. Results included in output
```

## Automated Testing Approaches

### Command Test Suite

Create a test suite script:

```bash
#!/bin/bash
# test-commands.sh - Command test suite

TEST_DIR=".claude/commands"
FAILED_TESTS=0

echo "Command Test Suite"
echo "=================="
echo

for cmd_file in "$TEST_DIR"/*.md; do
  cmd_name=$(basename "$cmd_file" .md)
  echo "Testing: $cmd_name"

  # Validate structure
  if ./validate-command.sh "$cmd_file"; then
    echo "  ✓ Structure valid"
  else
    echo "  ✗ Structure invalid"
    ((FAILED_TESTS++))
  fi

  # Validate frontmatter
  if ./validate-frontmatter.sh "$cmd_file"; then
    echo "  ✓ Frontmatter valid"
  else
    echo "  ✗ Frontmatter invalid"
    ((FAILED_TESTS++))
  fi

  echo
done

echo "=================="
echo "Tests complete"
echo "Failed: $FAILED_TESTS"

exit $FAILED_TESTS
```

### Pre-Commit Hook

Validate commands before committing:

```bash
#!/bin/bash
# .git/hooks/pre-commit

echo "Validating commands..."

COMMANDS_CHANGED=$(git diff --cached --name-only | grep "\.claude/commands/.*\.md")

if [ -z "$COMMANDS_CHANGED" ]; then
  echo "No commands changed"
  exit 0
fi

for cmd in $COMMANDS_CHANGED; do
  echo "Checking: $cmd"

  if ! ./scripts/validate-command.sh "$cmd"; then
    echo "ERROR: Command validation failed: $cmd"
    exit 1
  fi
done

echo "✓ All commands valid"
```

### Continuous Testing

Test commands in CI/CD:

```yaml
# .github/workflows/test-commands.yml
name: Test Commands

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Validate command structure
        run: |
          for cmd in .claude/commands/*.md; do
            echo "Testing: $cmd"
            ./scripts/validate-command.sh "$cmd"
          done

      - name: Validate frontmatter
        run: |
          for cmd in .claude/commands/*.md; do
            ./scripts/validate-frontmatter.sh "$cmd"
          done

      - name: Check for TODOs
        run: |
          if grep -r "TODO" .claude/commands/; then
            echo "ERROR: TODOs found in commands"
            exit 1
          fi
```

## Edge Case Testing

### Test Edge Cases

**Empty arguments:**
```bash
> /cmd ""
> /cmd '' ''
```

**Special characters:**
```bash
> /cmd "arg with spaces"
> /cmd arg-with-dashes
> /cmd arg_with_underscores
> /cmd arg/with/slashes
> /cmd 'arg with "quotes"'
```

**Long arguments:**
```bash
> /cmd $(python -c "print('a' * 10000)")
```

**Unusual file paths:**
```bash
> /cmd ./file
> /cmd ../file
> /cmd ~/file
> /cmd "/path with spaces/file"
```

**Bash command edge cases:**
```markdown
# Commands that might fail
!`exit 1`
!`false`
!`command-that-does-not-exist`

# Commands with special output
!`echo ""`
!`cat /dev/null`
!`yes | head -n 1000000`
```

## Performance Testing

### Response Time Testing

```bash
#!/bin/bash
# test-command-performance.sh

COMMAND="$1"

echo "Testing performance of /$COMMAND"
echo

for i in {1..5}; do
  echo "Run $i:"
  START=$(date +%s%N)

  # Invoke command (manual step - record time)
  echo "  Invoke: /$COMMAND"
  echo "  Start time: $START"
  echo "  (Record end time manually)"
  echo
done

echo "Analyze results:"
echo "  - Average response time"
echo "  - Variance"
echo "  - Acceptable threshold: < 3 seconds for fast commands"
```

### Resource Usage Testing

```bash
# Monitor Claude Code during command execution
# In terminal 1:
claude --debug

# In terminal 2:
watch -n 1 'ps aux | grep claude'

# Execute command and observe:
# - Memory usage
# - CPU usage
# - Process count
```

## User Experience Testing

### Usability Checklist

- [ ] Command name is intuitive
- [ ] Description is clear in `/help`
- [ ] Arguments are well-documented
- [ ] Error messages are helpful
- [ ] Output is formatted readably
- [ ] Long-running commands show progress
- [ ] Results are actionable
- [ ] Edge cases have good UX

### User Acceptance Testing

Recruit testers:

```markdown
# Testing Guide for Beta Testers

## Command: /my-new-command

### Test Scenarios

1. **Basic usage:**
   - Run: `/my-new-command`
   - Expected: [describe]
   - Rate clarity: 1-5

2. **With arguments:**
   - Run: `/my-new-command arg1 arg2`
   - Expected: [describe]
   - Rate usefulness: 1-5

3. **Error case:**
   - Run: `/my-new-command invalid-input`
   - Expected: Helpful error message
   - Rate error message: 1-5

### Feedback Questions

1. Was the command easy to understand?
2. Did the output meet your expectations?
3. What would you change?
4. Would you use this command regularly?
```

## Testing Checklist

Before releasing a command:

### Structure
- [ ] File in correct location
- [ ] Correct .md extension
- [ ] Valid YAML frontmatter (if present)
- [ ] Markdown syntax correct

### Functionality
- [ ] Command appears in `/help`
- [ ] Description is clear
- [ ] Command executes without errors
- [ ] Arguments work as expected
- [ ] File references work
- [ ] Bash execution works (if used)

### Edge Cases
- [ ] Missing arguments handled
- [ ] Invalid arguments detected
- [ ] Non-existent files handled
- [ ] Special characters work
- [ ] Long inputs handled

### Integration
- [ ] Works with other commands
- [ ] Works with hooks (if applicable)
- [ ] Works with MCP (if applicable)
- [ ] State management works

### Quality
- [ ] Performance acceptable
- [ ] No security issues
- [ ] Error messages helpful
- [ ] Output formatted well
- [ ] Documentation complete

### Distribution
- [ ] Tested by others
- [ ] Feedback incorporated
- [ ] README updated
- [ ] Examples provided

## Debugging Failed Tests

### Common Issues and Solutions

**Issue: Command not appearing in /help**

```bash
# Check file location
ls -la .claude/commands/my-command.md

# Check permissions
chmod 644 .claude/commands/my-command.md

# Check syntax
head -n 20 .claude/commands/my-command.md

# Restart Claude Code
claude --debug
```

**Issue: Arguments not substituting**

```bash
# Verify syntax
grep '\$1' .claude/commands/my-command.md
grep '\$ARGUMENTS' .claude/commands/my-command.md

# Test with simple command first
echo "Test: \$1 and \$2" > .claude/commands/test-args.md
```

**Issue: Bash commands not executing**

```bash
# Check allowed-tools
grep "allowed-tools" .claude/commands/my-command.md

# Verify command syntax
grep '!\`' .claude/commands/my-command.md

# Test command manually
date
echo "test"
```

**Issue: File references not working**

```bash
# Check @ syntax
grep '@' .claude/commands/my-command.md

# Verify file exists
ls -la /path/to/referenced/file

# Check permissions
chmod 644 /path/to/referenced/file
```

## Best Practices

1. **Test early, test often**: Validate as you develop
2. **Automate validation**: Use scripts for repeatable checks
3. **Test edge cases**: Don't just test the happy path
4. **Get feedback**: Have others test before wide release
5. **Document tests**: Keep test scenarios for regression testing
6. **Monitor in production**: Watch for issues after release
7. **Iterate**: Improve based on real usage data

---

## Source: command-development/examples / plugin-commands.md

# Plugin Command Examples

Practical examples of commands designed for Claude Code plugins, demonstrating plugin-specific patterns and features.

## Table of Contents

1. [Simple Plugin Command](#1-simple-plugin-command)
2. [Script-Based Analysis](#2-script-based-analysis)
3. [Template-Based Generation](#3-template-based-generation)
4. [Multi-Script Workflow](#4-multi-script-workflow)
5. [Configuration-Driven Deployment](#5-configuration-driven-deployment)
6. [Agent Integration](#6-agent-integration)
7. [Skill Integration](#7-skill-integration)
8. [Multi-Component Workflow](#8-multi-component-workflow)
9. [Validated Input Command](#9-validated-input-command)
10. [Environment-Aware Command](#10-environment-aware-command)

---

## 1. Simple Plugin Command

**Use case:** Basic command that uses plugin script

**File:** `commands/analyze.md`

```markdown
---
description: Analyze code quality using plugin tools
argument-hint: [file-path]
allowed-tools: Bash(node:*), Read
---

Analyze @$1 using plugin's quality checker:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/quality-check.js $1`

Review the analysis output and provide:
1. Summary of findings
2. Priority issues to address
3. Suggested improvements
4. Code quality score interpretation
```

**Key features:**
- Uses `${CLAUDE_PLUGIN_ROOT}` for portable path
- Combines file reference with script execution
- Simple single-purpose command

---

## 2. Script-Based Analysis

**Use case:** Run comprehensive analysis using multiple plugin scripts

**File:** `commands/full-audit.md`

```markdown
---
description: Complete code audit using plugin suite
argument-hint: [directory]
allowed-tools: Bash(*)
model: sonnet
---

Running complete audit on $1:

**Security scan:**
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/security-scan.sh $1`

**Performance analysis:**
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/perf-analyze.sh $1`

**Best practices check:**
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/best-practices.sh $1`

Analyze all results and create comprehensive report including:
- Critical issues requiring immediate attention
- Performance optimization opportunities
- Security vulnerabilities and fixes
- Overall health score and recommendations
```

**Key features:**
- Multiple script executions
- Organized output sections
- Comprehensive workflow
- Clear reporting structure

---

## 3. Template-Based Generation

**Use case:** Generate documentation following plugin template

**File:** `commands/gen-api-docs.md`

```markdown
---
description: Generate API documentation from template
argument-hint: [api-file]
---

Template structure: @${CLAUDE_PLUGIN_ROOT}/templates/api-documentation.md

API implementation: @$1

Generate complete API documentation following the template format above.

Ensure documentation includes:
- Endpoint descriptions with HTTP methods
- Request/response schemas
- Authentication requirements
- Error codes and handling
- Usage examples with curl commands
- Rate limiting information

Format output as markdown suitable for README or docs site.
```

**Key features:**
- Uses plugin template
- Combines template with source file
- Standardized output format
- Clear documentation structure

---

## 4. Multi-Script Workflow

**Use case:** Orchestrate build, test, and deploy workflow

**File:** `commands/release.md`

```markdown
---
description: Execute complete release workflow
argument-hint: [version]
allowed-tools: Bash(*), Read
---

Executing release workflow for version $1:

**Step 1 - Pre-release validation:**
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/pre-release-check.sh $1`

**Step 2 - Build artifacts:**
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/build-release.sh $1`

**Step 3 - Run test suite:**
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/run-tests.sh`

**Step 4 - Package release:**
!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/package.sh $1`

Review all step outputs and report:
1. Any failures or warnings
2. Build artifacts location
3. Test results summary
4. Next steps for deployment
5. Rollback plan if needed
```

**Key features:**
- Multi-step workflow
- Sequential script execution
- Clear step numbering
- Comprehensive reporting

---

## 5. Configuration-Driven Deployment

**Use case:** Deploy using environment-specific plugin configuration

**File:** `commands/deploy.md`

```markdown
---
description: Deploy application to environment
argument-hint: [environment]
allowed-tools: Read, Bash(*)
---

Deployment configuration for $1: @${CLAUDE_PLUGIN_ROOT}/config/$1-deploy.json

Current git state: !`git rev-parse --short HEAD`

Build info: !`cat package.json | grep -E '(name|version)'`

Execute deployment to $1 environment using configuration above.

Deployment checklist:
1. Validate configuration settings
2. Build application for $1
3. Run pre-deployment tests
4. Deploy to target environment
5. Run smoke tests
6. Verify deployment success
7. Update deployment log

Report deployment status and any issues encountered.
```

**Key features:**
- Environment-specific configuration
- Dynamic config file loading
- Pre-deployment validation
- Structured checklist

---

## 6. Agent Integration

**Use case:** Command that launches plugin agent for complex task

**File:** `commands/deep-review.md`

```markdown
---
description: Deep code review using plugin agent
argument-hint: [file-or-directory]
---

Initiate comprehensive code review of @$1 using the code-reviewer agent.

The agent will perform:
1. **Static analysis** - Check for code smells and anti-patterns
2. **Security audit** - Identify potential vulnerabilities
3. **Performance review** - Find optimization opportunities
4. **Best practices** - Ensure code follows standards
5. **Documentation check** - Verify adequate documentation

The agent has access to:
- Plugin's linting rules: ${CLAUDE_PLUGIN_ROOT}/config/lint-rules.json
- Security checklist: ${CLAUDE_PLUGIN_ROOT}/checklists/security.md
- Performance guidelines: ${CLAUDE_PLUGIN_ROOT}/docs/performance.md

Note: This uses the Task tool to launch the plugin's code-reviewer agent for thorough analysis.
```

**Key features:**
- Delegates to plugin agent
- Documents agent capabilities
- References plugin resources
- Clear scope definition

---

## 7. Skill Integration

**Use case:** Command that leverages plugin skill for specialized knowledge

**File:** `commands/document-api.md`

```markdown
---
description: Document API following plugin standards
argument-hint: [api-file]
---

API source code: @$1

Generate API documentation following the plugin's API documentation standards.

Use the api-documentation-standards skill to ensure:
- **OpenAPI compliance** - Follow OpenAPI 3.0 specification
- **Consistent formatting** - Use plugin's documentation style
- **Complete coverage** - Document all endpoints and schemas
- **Example quality** - Provide realistic usage examples
- **Error documentation** - Cover all error scenarios

The skill provides:
- Standard documentation templates
- API documentation best practices
- Common patterns for this codebase
- Quality validation criteria

Generate production-ready API documentation.
```

**Key features:**
- Invokes plugin skill by name
- Documents skill purpose
- Clear expectations
- Leverages skill knowledge

---

## 8. Multi-Component Workflow

**Use case:** Complex workflow using agents, skills, and scripts

**File:** `commands/complete-review.md`

```markdown
---
description: Comprehensive review using all plugin components
argument-hint: [file-path]
allowed-tools: Bash(node:*), Read
---

Target file: @$1

Execute comprehensive review workflow:

**Phase 1: Automated Analysis**
Run plugin analyzer: !`node ${CLAUDE_PLUGIN_ROOT}/scripts/analyze.js $1`

**Phase 2: Deep Review (Agent)**
Launch the code-quality-reviewer agent for detailed analysis.
Agent will examine:
- Code structure and organization
- Error handling patterns
- Testing coverage
- Documentation quality

**Phase 3: Standards Check (Skill)**
Use the coding-standards skill to validate:
- Naming conventions
- Code formatting
- Best practices adherence
- Framework-specific patterns

**Phase 4: Report Generation**
Template: @${CLAUDE_PLUGIN_ROOT}/templates/review-report.md

Compile all findings into comprehensive report following template.

**Phase 5: Recommendations**
Generate prioritized action items:
1. Critical issues (must fix)
2. Important improvements (should fix)
3. Nice-to-have enhancements (could fix)

Include specific file locations and suggested changes for each item.
```

**Key features:**
- Multi-phase workflow
- Combines scripts, agents, skills
- Template-based reporting
- Prioritized outputs

---

## 9. Validated Input Command

**Use case:** Command with input validation and error handling

**File:** `commands/build-env.md`

```markdown
---
description: Build for specific environment with validation
argument-hint: [environment]
allowed-tools: Bash(*)
---

Validate environment argument: !`echo "$1" | grep -E "^(dev|staging|prod)$" && echo "VALID" || echo "INVALID"`

Check build script exists: !`test -x ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh && echo "EXISTS" || echo "MISSING"`

Verify configuration available: !`test -f ${CLAUDE_PLUGIN_ROOT}/config/$1.json && echo "FOUND" || echo "NOT_FOUND"`

If all validations pass:

**Configuration:** @${CLAUDE_PLUGIN_ROOT}/config/$1.json

**Execute build:** !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/build.sh $1 2>&1`

**Validation results:** !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/validate-build.sh $1 2>&1`

Report build status and any issues.

If validations fail:
- Explain which validation failed
- Provide expected values/locations
- Suggest corrective actions
- Document troubleshooting steps
```

**Key features:**
- Input validation
- Resource existence checks
- Error handling
- Helpful error messages
- Graceful failure handling

---

## 10. Environment-Aware Command

**Use case:** Command that adapts behavior based on environment

**File:** `commands/run-checks.md`

```markdown
---
description: Run environment-appropriate checks
argument-hint: [environment]
allowed-tools: Bash(*), Read
---

Environment: $1

Load environment configuration: @${CLAUDE_PLUGIN_ROOT}/config/$1-checks.json

Determine check level: !`echo "$1" | grep -E "^prod$" && echo "FULL" || echo "BASIC"`

**For production environment:**
- Full test suite: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/test-full.sh`
- Security scan: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/security-scan.sh`
- Performance audit: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/perf-check.sh`
- Compliance check: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/compliance.sh`

**For non-production environments:**
- Basic tests: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/test-basic.sh`
- Quick lint: !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/lint.sh`

Analyze results based on environment requirements:

**Production:** All checks must pass with zero critical issues
**Staging:** No critical issues, warnings acceptable
**Development:** Focus on blocking issues only

Report status and recommend proceed/block decision.
```

**Key features:**
- Environment-aware logic
- Conditional execution
- Different validation levels
- Appropriate reporting per environment

---

## Common Patterns Summary

### Pattern: Plugin Script Execution
```markdown
!`node ${CLAUDE_PLUGIN_ROOT}/scripts/script-name.js $1`
```
Use for: Running plugin-provided Node.js scripts

### Pattern: Plugin Configuration Loading
```markdown
@${CLAUDE_PLUGIN_ROOT}/config/config-name.json
```
Use for: Loading plugin configuration files

### Pattern: Plugin Template Usage
```markdown
@${CLAUDE_PLUGIN_ROOT}/templates/template-name.md
```
Use for: Using plugin templates for generation

### Pattern: Agent Invocation
```markdown
Launch the [agent-name] agent for [task description].
```
Use for: Delegating complex tasks to plugin agents

### Pattern: Skill Reference
```markdown
Use the [skill-name] skill to ensure [requirements].
```
Use for: Leveraging plugin skills for specialized knowledge

### Pattern: Input Validation
```markdown
Validate input: !`echo "$1" | grep -E "^pattern$" && echo "OK" || echo "ERROR"`
```
Use for: Validating command arguments

### Pattern: Resource Validation
```markdown
Check exists: !`test -f ${CLAUDE_PLUGIN_ROOT}/path/file && echo "YES" || echo "NO"`
```
Use for: Verifying required plugin files exist

---

## Development Tips

### Testing Plugin Commands

1. **Test with plugin installed:**
   ```bash
   cd /path/to/plugin
   claude /command-name args
   ```

2. **Verify ${CLAUDE_PLUGIN_ROOT} expansion:**
   ```bash
   # Add debug output to command
   !`echo "Plugin root: ${CLAUDE_PLUGIN_ROOT}"`
   ```

3. **Test across different working directories:**
   ```bash
   cd /tmp && claude /command-name
   cd /other/project && claude /command-name
   ```

4. **Validate resource availability:**
   ```bash
   # Check all plugin resources exist
   !`ls -la ${CLAUDE_PLUGIN_ROOT}/scripts/`
   !`ls -la ${CLAUDE_PLUGIN_ROOT}/config/`
   ```

### Common Mistakes to Avoid

1. **Using relative paths instead of ${CLAUDE_PLUGIN_ROOT}:**
   ```markdown
   # Wrong
   !`node ./scripts/analyze.js`

   # Correct
   !`node ${CLAUDE_PLUGIN_ROOT}/scripts/analyze.js`
   ```

2. **Forgetting to allow required tools:**
   ```markdown
   # Missing allowed-tools
   !`bash script.sh`  # Will fail without Bash permission

   # Correct
   ---
   allowed-tools: Bash(*)
   ---
   !`bash ${CLAUDE_PLUGIN_ROOT}/scripts/script.sh`
   ```

3. **Not validating inputs:**
   ```markdown
   # Risky - no validation
   Deploy to $1 environment

   # Better - with validation
   Validate: !`echo "$1" | grep -E "^(dev|staging|prod)$" || echo "INVALID"`
   Deploy to $1 environment (if valid)
   ```

4. **Hardcoding plugin paths:**
   ```markdown
   # Wrong - breaks on different installations
   @/home/user/.claude/plugins/my-plugin/config.json

   # Correct - works everywhere
   @${CLAUDE_PLUGIN_ROOT}/config.json
   ```

---

For detailed plugin-specific features, see `references/plugin-features-reference.md`.
For general command development, see main `SKILL.md`.

---

## Source: command-development/examples / simple-commands.md

# Simple Command Examples

Basic slash command patterns for common use cases.

**Important:** All examples below are written as instructions FOR Claude (agent consumption), not messages TO users. Commands tell Claude what to do, not tell users what will happen.

## Example 1: Code Review Command

**File:** `.claude/commands/review.md`

```markdown
---
description: Review code for quality and issues
allowed-tools: Read, Bash(git:*)
---

Review the code in this repository for:

1. **Code Quality:**
   - Readability and maintainability
   - Consistent style and formatting
   - Appropriate abstraction levels

2. **Potential Issues:**
   - Logic errors or bugs
   - Edge cases not handled
   - Performance concerns

3. **Best Practices:**
   - Design patterns used correctly
   - Error handling present
   - Documentation adequate

Provide specific feedback with file and line references.
```

**Usage:**
```
> /review
```

---

## Example 2: Security Review Command

**File:** `.claude/commands/security-review.md`

```markdown
---
description: Review code for security vulnerabilities
allowed-tools: Read, Grep
model: sonnet
---

Perform comprehensive security review checking for:

**Common Vulnerabilities:**
- SQL injection risks
- Cross-site scripting (XSS)
- Authentication/authorization issues
- Insecure data handling
- Hardcoded secrets or credentials

**Security Best Practices:**
- Input validation present
- Output encoding correct
- Secure defaults used
- Error messages safe
- Logging appropriate (no sensitive data)

For each issue found:
- File and line number
- Severity (Critical/High/Medium/Low)
- Description of vulnerability
- Recommended fix

Prioritize issues by severity.
```

**Usage:**
```
> /security-review
```

---

## Example 3: Test Command with File Argument

**File:** `.claude/commands/test-file.md`

```markdown
---
description: Run tests for specific file
argument-hint: [test-file]
allowed-tools: Bash(npm:*), Bash(jest:*)
---

Run tests for $1:

Test execution: !`npm test $1`

Analyze results:
- Tests passed/failed
- Code coverage
- Performance issues
- Flaky tests

If failures found, suggest fixes based on error messages.
```

**Usage:**
```
> /test-file src/utils/helpers.test.ts
```

---

## Example 4: Documentation Generator

**File:** `.claude/commands/document.md`

```markdown
---
description: Generate documentation for file
argument-hint: [source-file]
---

Generate comprehensive documentation for @$1

Include:

**Overview:**
- Purpose and responsibility
- Main functionality
- Dependencies

**API Documentation:**
- Function/method signatures
- Parameter descriptions with types
- Return values with types
- Exceptions/errors thrown

**Usage Examples:**
- Basic usage
- Common patterns
- Edge cases

**Implementation Notes:**
- Algorithm complexity
- Performance considerations
- Known limitations

Format as Markdown suitable for project documentation.
```

**Usage:**
```
> /document src/api/users.ts
```

---

## Example 5: Git Status Summary

**File:** `.claude/commands/git-status.md`

```markdown
---
description: Summarize Git repository status
allowed-tools: Bash(git:*)
---

Repository Status Summary:

**Current Branch:** !`git branch --show-current`

**Status:** !`git status --short`

**Recent Commits:** !`git log --oneline -5`

**Remote Status:** !`git fetch && git status -sb`

Provide:
- Summary of changes
- Suggested next actions
- Any warnings or issues
```

**Usage:**
```
> /git-status
```

---

## Example 6: Deployment Command

**File:** `.claude/commands/deploy.md`

```markdown
---
description: Deploy to specified environment
argument-hint: [environment] [version]
allowed-tools: Bash(kubectl:*), Read
---

Deploy to $1 environment using version $2

**Pre-deployment Checks:**
1. Verify $1 configuration exists
2. Check version $2 is valid
3. Verify cluster accessibility: !`kubectl cluster-info`

**Deployment Steps:**
1. Update deployment manifest with version $2
2. Apply configuration to $1
3. Monitor rollout status
4. Verify pod health
5. Run smoke tests

**Rollback Plan:**
Document current version for rollback if issues occur.

Proceed with deployment? (yes/no)
```

**Usage:**
```
> /deploy staging v1.2.3
```

---

## Example 7: Comparison Command

**File:** `.claude/commands/compare-files.md`

```markdown
---
description: Compare two files
argument-hint: [file1] [file2]
---

Compare @$1 with @$2

**Analysis:**

1. **Differences:**
   - Lines added
   - Lines removed
   - Lines modified

2. **Functional Changes:**
   - Breaking changes
   - New features
   - Bug fixes
   - Refactoring

3. **Impact:**
   - Affected components
   - Required updates elsewhere
   - Migration requirements

4. **Recommendations:**
   - Code review focus areas
   - Testing requirements
   - Documentation updates needed

Present as structured comparison report.
```

**Usage:**
```
> /compare-files src/old-api.ts src/new-api.ts
```

---

## Example 8: Quick Fix Command

**File:** `.claude/commands/quick-fix.md`

```markdown
---
description: Quick fix for common issues
argument-hint: [issue-description]
model: haiku
---

Quickly fix: $ARGUMENTS

**Approach:**
1. Identify the issue
2. Find relevant code
3. Propose fix
4. Explain solution

Focus on:
- Simple, direct solution
- Minimal changes
- Following existing patterns
- No breaking changes

Provide code changes with file paths and line numbers.
```

**Usage:**
```
> /quick-fix button not responding to clicks
> /quick-fix typo in error message
```

---

## Example 9: Research Command

**File:** `.claude/commands/research.md`

```markdown
---
description: Research best practices for topic
argument-hint: [topic]
model: sonnet
---

Research best practices for: $ARGUMENTS

**Coverage:**

1. **Current State:**
   - How we currently handle this
   - Existing implementations

2. **Industry Standards:**
   - Common patterns
   - Recommended approaches
   - Tools and libraries

3. **Comparison:**
   - Our approach vs standards
   - Gaps or improvements needed
   - Migration considerations

4. **Recommendations:**
   - Concrete action items
   - Priority and effort estimates
   - Resources for implementation

Provide actionable guidance based on research.
```

**Usage:**
```
> /research error handling in async operations
> /research API authentication patterns
```

---

## Example 10: Explain Code Command

**File:** `.claude/commands/explain.md`

```markdown
---
description: Explain how code works
argument-hint: [file-or-function]
---

Explain @$1 in detail

**Explanation Structure:**

1. **Overview:**
   - What it does
   - Why it exists
   - How it fits in system

2. **Step-by-Step:**
   - Line-by-line walkthrough
   - Key algorithms or logic
   - Important details

3. **Inputs and Outputs:**
   - Parameters and types
   - Return values
   - Side effects

4. **Edge Cases:**
   - Error handling
   - Special cases
   - Limitations

5. **Usage Examples:**
   - How to call it
   - Common patterns
   - Integration points

Explain at level appropriate for junior engineer.
```

**Usage:**
```
> /explain src/utils/cache.ts
> /explain AuthService.login
```

---

## Key Patterns

### Pattern 1: Read-Only Analysis

```markdown
---
allowed-tools: Read, Grep
---

Analyze but don't modify...
```

**Use for:** Code review, documentation, analysis

### Pattern 2: Git Operations

```markdown
---
allowed-tools: Bash(git:*)
---

!`git status`
Analyze and suggest...
```

**Use for:** Repository status, commit analysis

### Pattern 3: Single Argument

```markdown
---
argument-hint: [target]
---

Process $1...
```

**Use for:** File operations, targeted actions

### Pattern 4: Multiple Arguments

```markdown
---
argument-hint: [source] [target] [options]
---

Process $1 to $2 with $3...
```

**Use for:** Workflows, deployments, comparisons

### Pattern 5: Fast Execution

```markdown
---
model: haiku
---

Quick simple task...
```

**Use for:** Simple, repetitive commands

### Pattern 6: File Comparison

```markdown
Compare @$1 with @$2...
```

**Use for:** Diff analysis, migration planning

### Pattern 7: Context Gathering

```markdown
---
allowed-tools: Bash(git:*), Read
---

Context: !`git status`
Files: @file1 @file2

Analyze...
```

**Use for:** Informed decision making

## Tips for Writing Simple Commands

1. **Start basic:** Single responsibility, clear purpose
2. **Add complexity gradually:** Start without frontmatter
3. **Test incrementally:** Verify each feature works
4. **Use descriptive names:** Command name should indicate purpose
5. **Document arguments:** Always use argument-hint
6. **Provide examples:** Show usage in comments
7. **Handle errors:** Consider missing arguments or files

---

## Source: customaize-agent-create-command / SKILL.md


# Command Creator Assistant

<task>
You are a command creation specialist. Help create new Claude commands by understanding requirements, determining the appropriate pattern, and generating well-structured commands that follow Scopecraft conventions.
</task>

<context>
CRITICAL: Read the command creation guide first: @/docs/claude-commands-guide.md

This meta-command helps create other commands by:

1. Understanding the command's purpose
2. Determining its category and pattern
3. Choosing command location (project vs user)
4. Generating the command file
5. Creating supporting resources
6. Updating documentation
</context>

<command_categories>

1. **Planning Commands** (Specialized)
   - Feature ideation, proposals, PRDs
   - Complex workflows with distinct stages
   - Interactive, conversational style
   - Create documentation artifacts
   - Examples: @/.claude/commands/01_brainstorm-feature.md
             @/.claude/commands/02_feature-proposal.md

2. **Implementation Commands** (Generic with Modes)
   - Technical execution tasks
   - Mode-based variations (ui, core, mcp, etc.)
   - Follow established patterns
   - Update task states
   - Example: @/.claude/commands/implement.md

3. **Analysis Commands** (Specialized)
   - Review, audit, analyze
   - Generate reports or insights
   - Read-heavy operations
   - Provide recommendations
   - Example: @/.claude/commands/review.md

4. **Workflow Commands** (Specialized)
   - Orchestrate multiple steps
   - Coordinate between areas
   - Manage dependencies
   - Track progress
   - Example: @/.claude/commands/04_feature-planning.md

5. **Utility Commands** (Generic or Specialized)
   - Tools, helpers, maintenance
   - Simple operations
   - May or may not need modes
</command_categories>

<command_frontmatter>

## CRITICAL: Every Command Must Start with Frontmatter

**All command files MUST begin with YAML frontmatter** enclosed in `---` delimiters:

```markdown
```

### Frontmatter Fields

1. **`description`** (REQUIRED):
   - One-line summary of the command's purpose
   - Clear, concise, action-oriented
   - Example: "Guided feature development with codebase understanding and architecture focus"

2. **`argument-hint`** (OPTIONAL):
   - Describes what arguments the command accepts
   - Examples:
     - "Optional feature description"
     - "File path to analyze"
     - "Component name and location"
     - "None required - interactive mode"

### Example Frontmatter by Command Type

```markdown
# Planning Command

# Implementation Command

# Analysis Command

# Utility Command
```

### Placement

- Frontmatter MUST be the **very first content** in the file
- No blank lines before the opening `---`
- One blank line after the closing `---` before content begins
</command_frontmatter>

<command_features>

## Slash Command Features

### Namespacing

Use subdirectories to group related commands. Subdirectories appear in the command description but don't affect the command name.

**Example:**
- `.claude/commands/frontend/component.md` creates `/component` with description "(project:frontend)"
- `~/.claude/commands/component.md` creates `/component` with description "(user)"

**Priority:** If a project command and user command share the same name, the project command takes precedence.

### Arguments

#### All Arguments with `$ARGUMENTS`

Captures all arguments passed to the command:

```bash
# Command definition
echo 'Fix issue #$ARGUMENTS following our coding standards' > .claude/commands/fix-issue.md

# Usage
> /fix-issue 123 high-priority
# $ARGUMENTS becomes: "123 high-priority"
```

#### Individual Arguments with `$1`, `$2`, etc.

Access specific arguments individually using positional parameters:

```bash
# Command definition
echo 'Review PR #$1 with priority $2 and assign to $3' > .claude/commands/review-pr.md

# Usage
> /review-pr 456 high alice
# $1 becomes "456", $2 becomes "high", $3 becomes "alice"
```

### Bash Command Execution

Execute bash commands before the slash command runs using the `!` prefix. The output is included in the command context.

**Note:** You must include `allowed-tools` with the `Bash` tool.

```markdown

## Context

- Current git status: !`git status`
- Current git diff: !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`
```

### File References

Include file contents using the `@` prefix to reference files:

```markdown
Review the implementation in @src/utils/helpers.js
Compare @src/old-version.js with @src/new-version.js
```

### Thinking Mode

Slash commands can trigger extended thinking by including extended thinking keywords.

### Frontmatter Options

| Frontmatter | Purpose | Default |
|-------------|---------|---------|
| `allowed-tools` | List of tools the command can use | Inherits from conversation |
| `argument-hint` | Expected arguments for auto-completion | None |
| `description` | Brief description of the command | First line from prompt |
| `model` | Specific model string | Inherits from conversation |
| `disable-model-invocation` | Prevent `Skill` tool from calling this command | false |

**Example with all frontmatter options:**

```markdown

Create a git commit with message: $ARGUMENTS
```

</command_features>

<pattern_research>

## Before Creating: Study Similar Commands

1. **List existing commands in target directory**:

   ```bash
   # For project commands
   ls -la /.claude/commands/
   
   # For user commands
   ls -la ~/.claude/commands/
   ```

2. **Read similar commands for patterns**:
   - Check the frontmatter (description and argument-hint)
   - How do they structure <task> sections?
   - What MCP tools do they use?
   - How do they handle arguments?
   - What documentation do they reference?

3. **Common patterns to look for**:

   ```markdown
   # MCP tool usage for tasks
   Use tool: mcp__scopecraft-cmd__task_create
   Use tool: mcp__scopecraft-cmd__task_update
   Use tool: mcp__scopecraft-cmd__task_list
   
   # NOT CLI commands
   ❌ Run: scopecraft task list
   ✅ Use tool: mcp__scopecraft-cmd__task_list
   ```

4. **Standard references to include**:
   - @/docs/organizational-structure-guide.md
   - @/docs/command-resources/{relevant-templates}
   - @/docs/claude-commands-guide.md
</pattern_research>

<interview_process>

## Phase 1: Understanding Purpose

"Let's create a new command. First, let me check what similar commands exist..."

*Use Glob to find existing commands in the target category*

"Based on existing patterns, please describe:"

1. What problem does this command solve?
2. Who will use it and when?
3. What's the expected output?
4. Is it interactive or batch?

## Phase 2: Category Classification

Based on responses and existing examples:

- Is this like existing planning commands? (Check: brainstorm-feature, feature-proposal)
- Is this like implementation commands? (Check: implement.md)
- Does it need mode variations?
- Should it follow analysis patterns? (Check: review.md)

## Phase 3: Pattern Selection

**Study similar commands first**:

```markdown
# Read a similar command
@{similar-command-path}

# Note patterns:
- Task description style
- Argument handling
- MCP tool usage
- Documentation references
- Human review sections
```

## Phase 4: Command Location

🎯 **Critical Decision: Where should this command live?**

**Project Command** (`/.claude/commands/`)

- Specific to this project's workflow
- Uses project conventions
- References project documentation
- Integrates with project MCP tools

**User Command** (`~/.claude/commands/`)

- General-purpose utility
- Reusable across projects
- Personal productivity tool
- Not project-specific

Ask: "Should this be:

1. A project command (specific to this codebase)
2. A user command (available in all projects)?"

## Phase 5: Resource Planning

Check existing resources:

```bash
# Check templates
ls -la /docs/command-resources/planning-templates/
ls -la /docs/command-resources/implement-modes/

# Check which guides exist
ls -la /docs/
```

</interview_process>

<generation_patterns>

## Critical: Copy Patterns from Similar Commands

Before generating, read similar commands and note:

1. **Frontmatter (MUST BE FIRST)**:

   ```markdown
   ---
   description: Clear one-line description of command purpose
   argument-hint: What arguments does it accept
   ---
   ```

   - No blank lines before opening `---`
   - One blank line after closing `---`
   - `description` is REQUIRED
   - `argument-hint` is OPTIONAL

2. **MCP Tool Usage**:

   ```markdown
   # From existing commands
   Use mcp__scopecraft-cmd__task_create
   Use mcp__scopecraft-cmd__feature_get
   Use mcp__scopecraft-cmd__phase_list
   ```

3. **Standard References**:

   ```markdown
   <context>
   Key Reference: @/docs/organizational-structure-guide.md
   Template: @/docs/command-resources/planning-templates/{template}.md
   Guide: @/docs/claude-commands-guide.md
   </context>
   ```

4. **Task Update Patterns**:

   ```markdown
   <task_updates>
   After implementation:
   1. Update task status to appropriate state
   2. Add implementation log entries
   3. Mark checklist items as complete
   4. Document any decisions made
   </task_updates>
   ```

5. **Human Review Sections**:

   ```markdown
   <human_review_needed>
   Flag decisions needing verification:
   - [ ] Assumptions about workflows
   - [ ] Technical approach choices
   - [ ] Pattern-based suggestions
   </human_review_needed>
   ```

</generation_patterns>

<implementation_steps>

1. **Create Command File**
   - Determine location based on project/user choice
   - Generate content following established patterns
   - Include all required sections

2. **Create Supporting Files** (if project command)
   - Templates in `/docs/command-resources/`
   - Mode guides if generic command
   - Example documentation

3. **Update Documentation** (if project command)
   - Add to claude-commands-guide.md
   - Update feature-development-workflow.md if workflow command
   - Add to README if user-facing

4. **Test the Command**
   - Create example usage scenarios
   - Verify argument handling
   - Check MCP tool integration
</implementation_steps>

<creation_checklist>
Before finalizing:

- [ ] **Includes YAML frontmatter** with description (required) and argument-hint (optional)
- [ ] Frontmatter is the very first content (no blank lines before opening `---`)
- [ ] Studied similar commands in the category
- [ ] Command follows naming conventions (use numeric prefix for ordered workflows)
- [ ] Includes proper task/context structure
- [ ] References @organizational-structure-guide.md
- [ ] Uses MCP tools (not CLI) - check existing patterns
- [ ] Includes human review sections
- [ ] Has clear examples like other commands
- [ ] Updates task states appropriately
- [ ] Creates proper documentation
- [ ] Follows established patterns from similar commands
- [ ] Correct command prefix (project: or user:)
</creation_checklist>

<example_session>
User: "I need a command to help validate our API documentation"

🔍 **Research**: Let me check existing analysis commands...

*Use Read tool to examine: /.claude/commands/review.md*

I notice the review command:

- Uses MCP tools for task operations
- Includes human review sections
- References organizational structure
- Has clear output formatting

🤔 **Question**: Can you tell me more about this API documentation validation?

- What format is the documentation in?
- What aspects need validation?
- Should it create tasks for issues found?

User: "It's OpenAPI specs, need to check for completeness and consistency"

💡 **Category**: This is an Analysis command similar to 'review'.

🔍 **Pattern Check**: Looking at review.md, I see it:

```markdown
<task>
You are a code reviewer conducting a comprehensive review...
</task>

<mcp_usage>
Always use MCP tools:
- mcp__scopecraft-cmd__task_list
- mcp__scopecraft-cmd__task_update
</mcp_usage>
```

🎯 **Location Question**: Should this be:

1. A project command (specific to this API project)
2. A user command (useful for all your API projects)

User: "Project command - it needs to reference our specific API standards"

✅ Creating project command: `/.claude/commands/validate-api.md`

Generated command (following review.md patterns):

```markdown

<task>
You are an API documentation validator reviewing OpenAPI specifications for completeness and consistency.
</task>

<context>
References:
- API Standards: @/docs/api-standards.md
- Organizational Structure: @/docs/organizational-structure-guide.md
Similar to: @/.claude/commands/review.md
</context>

<validation_process>
1. Load OpenAPI spec files
2. Check required endpoints documented
3. Validate response schemas
4. Verify authentication documented
5. Check for missing examples
</validation_process>

<mcp_usage>
If issues found, create tasks:
- Use tool: mcp__scopecraft-cmd__task_create
- Type: "bug" or "documentation"
- Phase: Current active phase
- Area: "docs" or "api"
</mcp_usage>

<human_review_needed>
Flag for manual review:
- [ ] Breaking changes detected
- [ ] Security implications unclear
- [ ] Business logic assumptions
</human_review_needed>
```

</example_session>

<final_output>
After gathering all information:

1. **Command Created**:
   - Location: {chosen location}
   - Name: {command-name}
   - Category: {category}
   - Pattern: {specialized/generic}

2. **Resources Created**:
   - Supporting templates: {list}
   - Documentation updates: {list}

3. **Usage Instructions**:
   - Command: `/{prefix}:{name}`
   - Example: {example usage}

4. **Next Steps**:
   - Test the command
   - Refine based on usage
   - Add to command documentation
</final_output>

---

## Source: create-agent-skill / SKILL.md


Invoke the create-agent-skills skill for: $ARGUMENTS

---
