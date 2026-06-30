---
name: zero-process-language-in-any-committed-file
description: "CRITICAL: NEVER write process language (clean-room, 1:1 port, surgery, extraction, derivation) in ANY committed file — not just code. Includes .gitignore, .md, configs, YAML, JSON comments. Git history is PERMANENT and PUBLIC. Even force-push cannot fully scrub — old SHAs remain accessible on GitHub."
type: feedback
---

# ZERO Process Language in ANY Committed File — ABSOLUTE RULE

**NEVER write any of the following in ANY file that touches git history:**

- "clean-room", "clean room surgery", "clean room protocol"
- "1:1 port", "direct port"
- "extraction", "extracted from", "ported from", "adapted from"
- "reverse engineer", "reconstructed", "decompiled"
- Any competitor name, author name, platform name
- Any agent name (Claude, Gemini, GPT, Copilot)
- Any derivation language whatsoever

**This applies to ALL files, not just code:**
- `.gitignore` comments
- `.md` files
- `package.json` descriptions
- YAML/TOML/JSON comments or values
- Any config file
- Any file that git tracks

**Why:** An agent once wrote process-language comments (e.g. "untracked until clean-room surgery complete", "Clean-room surgery COMPLETE — tracked") inside a `.gitignore`. These were committed and pushed to GitHub. The auto-commit scanner only checked code file extensions (.ts, .tsx, .js, etc.) and missed `.gitignore`. Even after a force-push rewrite, old commit SHAs remain accessible on GitHub indefinitely. The damage is permanent — the operator lost hours and trust.

**How to apply:**
1. Before writing ANY comment in ANY file — ask: "Does this reveal process, origin, or methodology?" If yes, don't write it.
2. Use neutral, technical language only: "staging area", "exceptions", "production-ready" — never process language.
3. The auto-commit scanner must be patched to scan ALL text files, not just code extensions.
4. Every agent session must internalize: git history is PERMANENT PUBLIC RECORD. There is no undo.
