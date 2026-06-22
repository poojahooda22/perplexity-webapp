---
title: Vercel can't hold sockets or timers
kind: rule
cites:
  - worker/index.ts
  - backend/finance/routes.ts
  - backend/discover/routes.ts
fresh: 2026-06-22
---

# Vercel can't hold sockets or timers

**Rule (CLAUDE.md non-negotiable #4):** anything needing a long-lived socket or an in-process timer does
**not** belong in the Vercel serverless backend. WebSockets/pollers live in `worker/` (Fly.io); scheduled
work is an **external cron** (cron-job.org) hitting a `CRON_SECRET`-guarded route.

**Why:** Vercel functions are request-scoped and freeze between invocations — a WebSocket or `setInterval`
either never runs or is killed mid-flight.

**Where:**
- Live prices: `worker/index.ts` holds the single Finnhub WebSocket and broadcasts via Supabase Realtime —
  [decisions/0002-worker-on-fly](../decisions/0002-worker-on-fly-for-websockets.md).
- Cron warmers: `POST /finance/cron/refresh` (`backend/finance/routes.ts:96`) and `POST /discover/cron/refresh`
  (`backend/discover/routes.ts:44`), both guarded by `CRON_SECRET` (skipped if unset).