# Price worker

Always-on service that holds **one** Finnhub WebSocket, coalesces trade ticks, and
broadcasts the latest prices to **Supabase Realtime** (channel `prices:top`) ~1×/sec.
Browsers subscribe to Supabase Realtime — never to Finnhub — so there is exactly one
upstream Finnhub socket regardless of how many people are watching.

## Why it's a separate service
Vercel serverless functions can't hold a persistent WebSocket. This worker must run on an
**always-on** host. Do **not** use a free PaaS that sleeps/scales-to-zero (Render free
sleeps; Koyeb free scales to zero on no *inbound* traffic — our socket is outbound).

## Run locally (verify the pipe before deploying)
The worker can reuse the backend's env file (it accepts `SUPABASE_API_SECRET` as the
service key and falls back to the known project URL):

```sh
# from worker/
bun --env-file=../backend/.env.local index.ts
```

Requires `FINNHUB_API_KEY` (+ `SUPABASE_API_SECRET`) in `backend/.env.local`.
You should see `[finnhub] open — subscribing…`; during US market hours, ticks flow and it
POSTs to Supabase Realtime every second.

## Deploy (Fly.io, ~$2/mo always-on)
```sh
cd worker
fly launch --no-deploy        # accept the Dockerfile; keep the app name or edit fly.toml
fly secrets set FINNHUB_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=https://<ref>.supabase.co
fly deploy
fly scale count 1             # ensure exactly one always-on machine
```
Confirm always-on: the machine must NOT autostop (see `fly.toml`). `fly logs` should show
a steady heartbeat of subscribe + broadcast activity.

## Env
| Var | Required | Notes |
|---|---|---|
| `FINNHUB_API_KEY` | ✅ | server-side only |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_API_SECRET`) | ✅ | to broadcast to Realtime |
| `SUPABASE_URL` | — | defaults to the project URL |
| `PRICE_CHANNEL` | — | default `prices:top` |
| `FLUSH_MS` | — | broadcast cadence, default `1000` |
| `SYMBOLS` | — | comma list, ≤50; default the watchlist |
