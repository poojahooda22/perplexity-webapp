---
title: ESM .js import extensions (Vercel)
kind: rule
cites:
  - backend/api/index.ts
fresh: 2026-06-22
---

# ESM `.js` import extensions

**Rule (CLAUDE.md non-negotiable #3):** relative imports in the **backend** must carry an explicit `.js`
extension (even though the source file is `.ts`), e.g. `import { app } from "../index.js"`.

**Why:** Vercel's strict ESM resolver requires the extension and **fails the build** without it. Bun is
lenient locally — it resolves extensionless imports fine — so this bug is **invisible in dev and only
appears in the Vercel production build.** That asymmetry is exactly why it's a non-negotiable.

**Where:** see the Vercel entrypoint `backend/api/index.ts:1` (`re-exports ../index.js`). Apply to every
relative import added under `backend/`.