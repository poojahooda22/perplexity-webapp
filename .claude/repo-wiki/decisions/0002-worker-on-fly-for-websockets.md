---
title: "ADR 0002 — Live prices in a Fly.io worker, not Vercel"
kind: decision
owning_skill: finance-markets
cites:
  - worker/index.ts
fresh: 2026-06-22
---

# ADR 0002 — Live prices in a Fly.io worker, not Vercel

**Decision:** a separate always-on process `worker/index.ts` (Fly.io) holds **one** Finnhub WebSocket,
coalesces ticks into a per-symbol map, and broadcasts to clients via **Supabase Realtime** (channel
`prices:top`) on a 1s timer, with reconnect/backoff/watchdog. The frontend `useLivePrices`
(`frontend/src/hooks/use-live-prices.ts:24`) merges those ticks into the cached stocks/crypto queries.

**Why / alternative not taken:** the obvious "just open the socket in the backend" fails on Vercel — its
functions are request-scoped and freeze between invocations, so a WebSocket/timer can't survive there (see
[rules/vercel-no-sockets-no-timers](../rules/vercel-no-sockets-no-timers.md)). One shared upstream socket
(not one per browser) also respects the vendor connection budget. Supabase Realtime was already in the stack
for auth, so it doubles as the fan-out transport — no new infra.

**Consequence:** live prices are a fundamentally different transport from the REST `/finance/*` reads; a
browser gets the cached snapshot over HTTP, then live deltas over Realtime.
