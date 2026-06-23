#!/usr/bin/env bash
# SessionStart hook — surface the Lumina harness so every session opens loaded.
# Prints the team-memory index, the operating-rules index, and the repo-wiki pointer.
# Output goes into the session context. Keep it compact and bounded.
set -euo pipefail

DIR="${CLAUDE_PROJECT_DIR:-.}/.claude"

echo "## Lumina harness loaded — map: .claude/HARNESS.md"
echo

if [ -f "$DIR/memory/MEMORY.md" ]; then
  echo "### Team memory (.claude/memory/) — read the relevant file before related work"
  # Print only the bullet index lines (skip headers/prose), capped for safety.
  grep -E '^- ' "$DIR/memory/MEMORY.md" | head -n 40 || true
  echo
fi

if [ -f "$DIR/rules/README.md" ]; then
  echo "### Operating rules (.claude/rules/) — always in force"
  echo "- never invent a finance number · commercialOk gate · ESM .js imports · Vercel no sockets/timers ·"
  echo "  stream→persist before res.end() · secure tool args by closure · restart on new backend files"
  echo "- brand-is-lumina · commercial-ok-gate · product-at-scale (R-SCALE) · skill-layer-law · confirm-before-big-work"
  echo "  + red-team-negation-loop (R70, on-demand: \"red-team this\" / \"negate this\")"
  echo "  (full text: .claude/rules/)"
  echo
fi

echo "### Before grepping for code, read .claude/repo-wiki/index.md (the file-cited structural map)."