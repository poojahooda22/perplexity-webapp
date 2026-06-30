# MCP Server Setups

> Consolidated from mcp-setup-*. Zero-value-loss.

---

## Source: mcp-setup-arxiv-mcp


User Input:

```text
$ARGUMENTS
```

# Guide for setup arXiv MCP server via Docker MCP

## 1. Determine setup context

Ask the user where they want to store the configuration:

**Options:**

1. **Project level (shared via git)** - Configuration tracked in version control, shared with team
   - CLAUDE.md updates go to: `./CLAUDE.md`

2. **Project level (personal preferences)** - Configuration stays local, not tracked in git
   - CLAUDE.md updates go to: `./CLAUDE.local.md`
   - Verify these files are listed in `.gitignore`, add them if not

3. **User level (global)** - Configuration applies to all projects for this user
   - CLAUDE.md updates go to: `~/.claude/CLAUDE.md`

Store the user's choice and use the appropriate paths in subsequent steps.

## 2. Check if Docker MCP is available

First, verify that Docker MCP (MCP_DOCKER) is accessible by attempting to use `mcp-find` tool to search for servers.

If Docker MCP is NOT available:

1. Ask user to install Docker Desktop following instructions at: <https://docs.docker.com/desktop/>
2. After Docker Desktop is installed, guide user to connect MCP using: <https://docs.docker.com/ai/mcp-catalog-and-toolkit/get-started/#claude-code>
3. Once configured, ask user to restart Claude Code and run "continue" to resume setup

## 3. Search and add paper-search MCP server

Write to user that regular `arxiv-mcp-server` is known to have issues, specifically is failing to initialize (EOF error during init). So we will use `paper-search` MCP server instead.

Use Docker MCP to find and add the `paper-search` MCP server which provides comprehensive academic paper search capabilities:

```
mcp-find query: "paper-search"
mcp-add name: "paper-search" activate: true
```

This server provides access to multiple academic sources:

- **arXiv** - preprints in physics, mathematics, computer science, etc.
- **PubMed** - biomedical literature
- **bioRxiv/medRxiv** - biology and medicine preprints
- **Semantic Scholar** - AI-powered research tool
- **Google Scholar** - broad academic search
- **IACR** - cryptography research
- **CrossRef** - DOI-based citation database

## 4. Test the setup

Verify the server is working by searching for papers:

```
mcp-exec name: "search_arxiv" arguments: {"query": "test query", "max_results": 2}
```

## 5. Update CLAUDE.md file

Use the path determined in step 1:

Once the paper-search MCP server is successfully set up, update CLAUDE.md file with the following content:

```markdown
### Use Paper Search MCP for Academic Research

Paper Search MCP is available via Docker MCP for searching and downloading academic papers.

**Available tools**:

- `search_arxiv` - Search arXiv preprints (physics, math, CS, etc.)
- `search_pubmed` - Search PubMed biomedical literature
- `search_biorxiv` / `search_medrxiv` - Search biology/medicine preprints
- `search_semantic` - Search Semantic Scholar with year filters
- `search_google_scholar` - Broad academic search
- `search_iacr` - Search cryptography papers
- `search_crossref` - Search by DOI/citation

**Download and read tools**:

- `download_arxiv` / `read_arxiv_paper` - Download/read arXiv PDFs
- `download_biorxiv` / `read_biorxiv_paper` - Download/read bioRxiv PDFs
- `download_semantic` / `read_semantic_paper` - Download/read via Semantic Scholar

**Usage notes**:

- Use `mcp-exec` to call tools, e.g., `mcp-exec name: "search_arxiv" arguments: {"query": "topic", "max_results": 10}`
- Downloaded papers are saved to `./downloads` by default
- For Semantic Scholar, supports multiple ID formats: DOI, ARXIV, PMID, etc.
```

## 6. Alternative: arxiv-mcp-server

If you specifically need the dedicated arXiv MCP server with additional features (deep analysis prompts, local storage management), you can try:

```
mcp-find query: "arxiv"
mcp-config-set server: "arxiv-mcp-server" key: "storage_path" value: "/path/to/papers"
mcp-add name: "arxiv-mcp-server" activate: true
```

Note: This server requires configuration of a storage path for downloaded papers.

---

## Source: mcp-setup-codemap-cli


User Input:

```text
$ARGUMENTS
```

# Guide for setup Codemap CLI

## 1. Determine setup context

Ask the user where they want to store the configuration:

**Options:**

1. **Project level (shared via git)** - Configuration tracked in version control, shared with team
   - CLAUDE.md updates go to: `./CLAUDE.md`
   - Hook settings go to: `./.claude/settings.json`

2. **Project level (personal preferences)** - Configuration stays local, not tracked in git
   - CLAUDE.md updates go to: `./CLAUDE.local.md`
   - Hook settings go to: `./.claude/settings.local.json`
   - Verify these files are listed in `.gitignore`, add them if not

3. **User level (global)** - Configuration applies to all projects for this user
   - CLAUDE.md updates go to: `~/.claude/CLAUDE.md`
   - Hook settings go to: `~/.claude/settings.json`

Store the user's choice and use the appropriate paths in subsequent steps.

## 2. Check if Codemap is already installed

Check whether codemap is installed by running `codemap -help`.

If not installed, proceed with setup.

## 3. Load Codemap documentation

Read the following documentation to understand Codemap's capabilities:

- Load <https://raw.githubusercontent.com/JordanCoin/codemap/refs/heads/main/README.md> to understand what Codemap is and its capabilities

## 4. Guide user through installation

### macOS/Linux (Homebrew)

```bash
brew tap JordanCoin/tap && brew install codemap
```

### Windows (Scoop)

```bash
scoop bucket add codemap https://github.com/JordanCoin/scoop-codemap
scoop install codemap
```

## 5. Verify installation

After installation, verify codemap works:

```bash
codemap .
```

## 6. Update CLAUDE.md file

Use the path determined in step 1. Once Codemap is successfully installed, update the appropriate CLAUDE.md file with the following content:

```markdown
## Use Codemap CLI for Codebase Navigation

Codemap CLI is available for intelligent codebase visualization and navigation.

**Required Usage** - You MUST use `codemap --diff --ref master` to research changes different from default branch, and `git diff` + `git status` to research current working state.

### Quick Start

```bash
codemap .                    # Project tree
codemap --only swift .       # Just Swift files
codemap --exclude .xcassets,Fonts,.png .  # Hide assets
codemap --depth 2 .          # Limit depth
codemap --diff               # What changed vs main
codemap --deps .             # Dependency flow
```

### Options

| Flag | Description |
|------|-------------|
| `--depth, -d <n>` | Limit tree depth (0 = unlimited) |
| `--only <exts>` | Only show files with these extensions |
| `--exclude <patterns>` | Exclude files matching patterns |
| `--diff` | Show files changed vs main branch |
| `--ref <branch>` | Branch to compare against (with --diff) |
| `--deps` | Dependency flow mode |
| `--importers <file>` | Check who imports a file |
| `--skyline` | City skyline visualization |
| `--json` | Output JSON |

**Smart pattern matching** - no quotes needed:
- `.png` - any `.png` file
- `Fonts` - any `/Fonts/` directory
- `*Test*` - glob pattern

### Diff Mode

See what you're working on:

```bash
codemap --diff
codemap --diff --ref develop
```

```

if the default branch is not `main`, but instead `master` (or something else) update content accordingly:
 - use `codemap --diff --ref master` instead of regular `codemap --diff`


## 7. Update .gitignore file

Update .gitignore file to include `.codemap/` directory:

```text
.codemap/
```

## 8. Test Codemap

Run a quick test to verify everything works:

```bash
codemap .
codemap --diff
```

## 9. Add hooks to settings file

- Use the settings path determined in step 1. Create the settings file if it doesn't exist and add the following content:

    ```json
    {
        "hooks": {
            "session-start": "codemap hook session-start && echo 'git diff:' && git diff --stat && echo 'git status:' && git status"
        }
    }
    ```

    if default branch is not `main`, but instead `master` (or something else) update content accordingly:
    - use `codemap hook session-start --ref=master` instead of regular `codemap hook session-start`
    - For rest of commands also add `--ref=master` flag.

- Ask user whether he want to add any other hooks and provide list of options with descriptions. Add hooks that he asks for.

### Available Hooks

| Command | Trigger | Description |
|---------|---------|-------------|
| `codemap hook session-start` | SessionStart | Full tree, hubs, branch diff, last session context |
| `codemap hook pre-edit` | PreToolUse (Edit\|Write) | Who imports file + what hubs it imports |
| `codemap hook post-edit` | PostToolUse (Edit\|Write) | Impact of changes (same as pre-edit) |
| `codemap hook prompt-submit` | UserPromptSubmit | Hub context for mentioned files + session progress |
| `codemap hook pre-compact` | PreCompact | Saves hub state to .codemap/hubs.txt |
| `codemap hook session-stop` | SessionEnd | Edit timeline with line counts and stats |


### Example of file with full hooks configuration

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codemap hook session-start"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "codemap hook pre-edit"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "codemap hook post-edit"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codemap hook prompt-submit"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codemap hook pre-compact"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codemap hook session-stop"
          }
        ]
      }
    ]
  }
}
```

---

## Source: mcp-setup-context7-mcp


User Input:

```text
$ARGUMENTS
```

# Guide for setup Context7 MCP server

## 1. Determine setup context

Ask the user where they want to store the configuration:

**Options:**

1. **Project level (shared via git)** - Configuration tracked in version control, shared with team
   - CLAUDE.md updates go to: `./CLAUDE.md`

2. **Project level (personal preferences)** - Configuration stays local, not tracked in git
   - CLAUDE.md updates go to: `./CLAUDE.local.md`
   - Verify these files are listed in `.gitignore`, add them if not

3. **User level (global)** - Configuration applies to all projects for this user
   - CLAUDE.md updates go to: `~/.claude/CLAUDE.md`

Store the user's choice and use the appropriate paths in subsequent steps.

## 2. Check if Context7 MCP server is already setup

Check whether you have access to Context7 MCP server by making request.

if no, load <https://raw.githubusercontent.com/upstash/context7/refs/heads/master/README.md> file and guide user through setup process that applicable to agent/operation system.

## 3. Update CLAUDE.md file

Use the path determined in step 1:

- Parse user input, if it empty read current project structure and used technologies, if project empty ask user to provide list of languages and frameworks that planned to be used in this project.
- Search through context7 MCP for relevant technologies documentation
- Update the appropriate CLAUDE.md file with following content:

```markdown
### Use Context7 MCP for Loading Documentation

Context7 MCP is available to fetch up-to-date documentation with code examples.

**Recommended library IDs**:

- `[doc-id]` - short description of documentation

```

---

## Source: mcp-setup-serena-mcp


User Input:

```text
$ARGUMENTS
```

# Guide for setup Serena MCP server

## 1. Determine setup context

Ask the user where they want to store the configuration:

**Options:**

1. **Project level (shared via git)** - Configuration tracked in version control, shared with team
   - CLAUDE.md updates go to: `./CLAUDE.md`

2. **Project level (personal preferences)** - Configuration stays local, not tracked in git
   - CLAUDE.md updates go to: `./CLAUDE.local.md`
   - Verify these files are listed in `.gitignore`, add them if not

3. **User level (global)** - Configuration applies to all projects for this user
   - CLAUDE.md updates go to: `~/.claude/CLAUDE.md`

Store the user's choice and use the appropriate paths in subsequent steps.

## 2. Check if Serena MCP server is already setup

Check whether you have access to Serena MCP server by attempting to use one of its tools (e.g., `find_symbol` or `get_symbols_overview`).

If no access, proceed with setup.

## 3. Load Serena documentation

Read the following documentation to understand Serena's capabilities and setup process:

- Load <https://raw.githubusercontent.com/oraios/serena/refs/heads/main/README.md> to understand what Serena is and its capabilities
- Load <https://oraios.github.io/serena/02-usage/020_running.html> to learn how to run Serena
- Load <https://oraios.github.io/serena/02-usage/030_clients.html> to learn how to configure your MCP client
- Load <https://oraios.github.io/serena/02-usage/040_workflow.html> to learn how to setup Serena for your project

## 4. Guide user through setup process

Based on the loaded documentation:

1. **Check prerequisites**: Verify that `uv` is installed (required for running Serena)
2. **Identify client type**: Determine which MCP client the user is using (Claude Code, Claude Desktop, Cursor, VSCode, etc.)
3. **Provide setup instructions**: Guide through the configuration specific to their client if it not already configured
4. **Setup project**: Guide through the project setup process if it not already setup
5. **Start indexing project**: Guide through the project indexing process if it was just setup
6. If MCP was just setup, ask user to restart Claude Code to load the new MCP server, write to user explisit instructions, including "exit claude code console, then run 'claude --continue' and then write "continue" to continue setup process"
7. **Test connection**: Verify that Serena tools are accessible after setup
   1. If not yet, run initial_instructions
   2. Check if onboarding was performered, if not then run it.
   3. Then try to read any file

After adding MCP server, but before testings connection write to user this message EXACTLY:

```markdown
You must restart Claude Code to load the new MCP server:

  1. Exit Claude Code console (type exit or press Ctrl+C)
  2. Run claude --continue
  3. Type "continue" to resume setup

  After restart, I will:
  - Verify Serena tools are accessible
  - Run initial_instructions if needed
  - Perform onboarding for this project (if not already done)

```

## 5. Update CLAUDE.md file

Use the path determined in step 1. Once Serena is successfully set up, update the appropriate CLAUDE.md file with the following content EXACTLY:

```markdown
### Use Serena MCP for Semantic Code Analysis instead of regular code search and editing

Serena MCP is available for advanced code retrieval and editing capabilities.

**When to use Serena:**
- Symbol-based code navigation (find definitions, references, implementations)
- Precise code manipulation in structured codebases
- Prefer symbol-based operations over file-based grep/sed when available

**Key tools:**
- `find_symbol` - Find symbol by name across the codebase
- `find_referencing_symbols` - Find all symbols that reference a given symbol
- `get_symbols_overview` - Get overview of top-level symbols in a file
- `read_file` - Read file content within the project directory

**Usage notes:**
- Memory files can be manually reviewed/edited in `.serena/memories/`

```

Add this section, if server setup at user level (global):

```markdown

**Project setup (per project):**
1. Run `serena project create --index` in your project directory
2. Serena auto-detects language; creates `.serena/project.yml`
3. First use triggers onboarding and creates memory files in `.serena/memories/`
```

## 6. Project initialization (if needed)

If this is a new project or Serena hasn't been initialized:

1. Guide user to run project initialization commands
2. Explain project-based workflow and indexing
3. Configure project-specific settings if needed

---
