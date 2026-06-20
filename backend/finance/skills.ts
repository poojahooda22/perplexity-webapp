// ─────────────────────────────────────────────────────────────────────────
// Finance SKILLS — progressive-disclosure capability packages (the pi "skills" idea).
// Each skill is a Markdown file in ./skills with YAML-ish frontmatter (name + description)
// and a playbook body. Only the names + descriptions go into the system prompt (the
// manifest); the full body loads on demand when the model calls the loadSkill tool.
//
// Robust by design: if the .md files can't be read (e.g. not bundled in a serverless
// build), the registry is simply empty and the agent runs fine without skills.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import { z } from "zod";
import { FINANCE_PERSONA } from "../prompt.js";

export interface FinanceSkill {
  name: string;
  description: string;
  body: string;
}

// Minimal frontmatter parser — avoids a YAML dependency for the two fields we use.
function parseSkill(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { body: raw.trim() };
  const front = m[1] ?? "";
  return {
    name: front.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: front.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
    body: (m[2] ?? "").trim(),
  };
}

function loadSkillsFromDisk(): Record<string, FinanceSkill> {
  const out: Record<string, FinanceSkill> = {};
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "skills");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const parsed = parseSkill(readFileSync(join(dir, file), "utf8"));
      if (!parsed.name || !parsed.description) continue; // skip invalid skills (standard: both required)
      out[parsed.name] = { name: parsed.name, description: parsed.description, body: parsed.body };
    }
  } catch (e) {
    console.warn("[finance skills] could not load skills:", e instanceof Error ? e.message : e);
  }
  return out;
}

export const SKILLS: Record<string, FinanceSkill> = loadSkillsFromDisk();

// Progressive disclosure: only names + descriptions live in the system prompt.
export function skillsManifest(): string {
  const list = Object.values(SKILLS);
  if (list.length === 0) return "";
  return `<available_skills>\n${list.map((s) => `- ${s.name}: ${s.description}`).join("\n")}\n</available_skills>`;
}

// The finance system prompt = persona + the skills manifest (so the model knows what it can load).
export function buildFinanceSystem(): string {
  const manifest = skillsManifest();
  return manifest ? `${FINANCE_PERSONA}\n\n${manifest}` : FINANCE_PERSONA;
}

// The tool the model calls to pull a skill's full playbook on demand.
export const loadSkill = tool({
  description:
    "Load the full step-by-step playbook for a finance skill by name when the user's task matches " +
    "one of the entries in <available_skills>. Call this BEFORE answering such a task, then follow it.",
  inputSchema: z.object({
    name: z.string().describe("The skill name, exactly as listed in <available_skills>."),
  }),
  execute: async ({ name }) => {
    const skill = SKILLS[name];
    if (!skill) {
      return { error: `Unknown skill "${name}". Available: ${Object.keys(SKILLS).join(", ") || "none"}.` };
    }
    return { skill: skill.name, instructions: skill.body };
  },
});
