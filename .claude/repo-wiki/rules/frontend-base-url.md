---
title: Frontend base-URL (BUN_PUBLIC_*) gotcha
kind: rule
cites:
  - frontend/src/lib/config.ts
  - frontend/src/lib/supabase.ts
fresh: 2026-06-22
---

# Frontend base-URL gotcha

**Rule:** the frontend's backend URL is `BACKEND_URL = process.env.BUN_PUBLIC_BACKEND_URL ||
"http://localhost:3001"` (`frontend/src/lib/config.ts:5-6`).

**Why it bites:** Bun **inlines `BUN_PUBLIC_*` at build time**. If it isn't set, the app **silently falls
back to localhost** — so a deployed frontend appears to "do nothing" because it's calling a backend that
isn't there. Set it in Vercel (prod) and in `frontend/.env.local` (dev). Same pattern for Supabase:
`supabase.ts:6-8` throws if `BUN_PUBLIC_SUPABASE_URL`/`_ANON_KEY` are missing.

⚠️ Also: the frontend sends the Supabase token as the **raw `Authorization` value, no `Bearer ` prefix**
(`frontend/src/lib/api.ts:35-38`). See [wire-protocol](../entities/wire-protocol.md).
