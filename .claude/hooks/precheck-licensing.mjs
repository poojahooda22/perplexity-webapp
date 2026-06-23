#!/usr/bin/env node
// PreToolUse licensing guard for Lumina (matcher: Write|Edit).
// - Nudges (non-blocking) when an edit INTRODUCES commercialOk:true — verify the fetch path is GREEN
//   in .claude/memory/sources-ledger.md before flipping the gate (a free tier is NOT a display license).
// - Asks for confirmation before writing a real .env file (not .env.example).
// Degrades to a silent allow on any parse error — it must never spuriously block real work.
import { readFileSync } from "node:fs";

function allow() { process.exit(0); }
function emit(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch { allow(); }
let input;
try { input = JSON.parse(raw); } catch { allow(); }

const ti = input?.tool_input ?? {};
const filePath = String(ti.file_path ?? "");
// Text being introduced: Write.content or Edit.new_string.
const added = String(ti.content ?? ti.new_string ?? "");

// 1) Real .env writes → ask the operator to confirm (no secrets into the repo). .env.example is fine.
if (/(^|[\\/])\.env(\.[A-Za-z0-9]+)?$/.test(filePath) && !/\.env\.example$/.test(filePath)) {
  emit({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
    systemMessage:
      "✋ Writing to a .env file. Confirm this is intended and contains no secrets that should stay out of git.",
  });
}

// 2) Introducing commercialOk:true → non-blocking nudge to verify against the sources-ledger.
if (/commercialOk\s*:\s*true/.test(added)) {
  emit({
    systemMessage:
      "⚠️ This edit sets commercialOk:true. The license attaches to the FETCH PATH, not the concept — " +
      "verify it has a 🟢 GREEN row in .claude/memory/sources-ledger.md (public-domain / CC0 / CC-BY, or a " +
      "purchased display tier). A free API tier is NOT a display license. If there is no GREEN row, keep it false.",
  });
}

allow();
