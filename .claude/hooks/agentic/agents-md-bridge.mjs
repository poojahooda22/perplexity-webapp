#!/usr/bin/env node
/**
 * Agentic Harness — AGENTS.md learned-sections bridge (UserPromptSubmit hook).
 *
 * PROJECT-AGNOSTIC. Multi-tool agent setups (Cursor, Codex, Gemini CLI, Claude
 * Code) accumulate high-signal user preferences and workspace facts in the
 * cross-tool AGENTS.md under "## Learned User Preferences" and "## Learned
 * Workspace Facts". This hook reads those sections from the project's AGENTS.md
 * and injects them into the per-prompt context, so Claude inherits whatever the
 * other tools learned — no manual port required.
 *
 * Degrades gracefully if AGENTS.md is missing, malformed, or the sections are
 * empty. No project name is hardcoded.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// --- Read stdin (hook input — pass-through preserved on early exit) ---
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// --- Locate AGENTS.md (repo root) ---
const candidates = [
  resolve(projectDir, 'AGENTS.md'),
  resolve(projectDir, '.claude/AGENTS.md'),
];
let agentsMdPath = null;
for (const p of candidates) {
  if (existsSync(p)) { agentsMdPath = p; break; }
}

if (!agentsMdPath) {
  // No AGENTS.md found — nothing to bridge. Pass-through.
  process.stdout.write(input);
  process.exit(0);
}

// --- Read AGENTS.md ---
let agentsMd = '';
try {
  agentsMd = readFileSync(agentsMdPath, 'utf-8');
} catch (err) {
  process.stderr.write(`[agents-md-bridge] read failed: ${err.message}\n`);
  process.stdout.write(input);
  process.exit(0);
}

// --- Extract the two learned sections ---
// Matches "## Learned User Preferences" up to the next "## " heading or EOF.
function extractSection(text, heading) {
  const re = new RegExp(`(^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
  const m = text.match(re);
  return m ? m[2].trim() : '';
}

const userPrefs = extractSection(agentsMd, 'Learned User Preferences');
const workspaceFacts = extractSection(agentsMd, 'Learned Workspace Facts');

if (!userPrefs && !workspaceFacts) {
  // Sections missing or empty — nothing to inject.
  process.stdout.write(input);
  process.exit(0);
}

// --- Hash + cache check (telemetry / future only-on-change optimization) ---
const stateDir = resolve(projectDir, '.claude/.cache/agentic-bridge');
const cachePath = resolve(stateDir, 'agents-md-bridge-hash.json');
const combinedBody = `## Learned User Preferences\n\n${userPrefs}\n\n## Learned Workspace Facts\n\n${workspaceFacts}\n`;
const currentHash = createHash('sha256').update(combinedBody).digest('hex');

try {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    hash: currentHash,
    updatedAtUtc: new Date().toISOString(),
    source: agentsMdPath,
    bytes: combinedBody.length,
  }, null, 2));
} catch { /* ignore cache write errors — non-fatal */ }

// --- Build additionalContext payload ---
// Truncate defensively if either section is enormous (>40KB total).
const MAX_BYTES = 40 * 1024;
let injection = combinedBody;
if (injection.length > MAX_BYTES) {
  injection = injection.slice(0, MAX_BYTES) + '\n\n[truncated — exceeds 40KB cap]';
}

const header = `[agentic-bridge] AGENTS.md learned-preferences sync (${injection.length} bytes, hash ${currentHash.slice(0, 12)})`;
const additionalContext = `${header}\n\n${injection}`;

// --- Emit ---
// UserPromptSubmit hooks inject context via hookSpecificOutput.additionalContext.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext,
  },
}));
process.exit(0);
