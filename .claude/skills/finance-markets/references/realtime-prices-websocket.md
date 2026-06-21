# Realtime Prices (WebSocket worker) — how a price goes LIVE

> The live-tick path: a separate always-on worker holds ONE Finnhub WebSocket, coalesces ticks to
> ~1/sec, and fans them out over Supabase Realtime to every browser, which merges them into the
> TanStack caches in place. `lumina-` view of THIS codebase — cite the live file before changing it
> (line numbers drift). For the REST cards these ticks decorate, see
> `lumina-finance-architecture.md`; for why Finnhub WS is the live source and its market-hours
> caveat, see `market-data-providers.md`.

Files: [`worker/index.ts`](../../../../worker/index.ts),
[`worker/fly.toml`](../../../../worker/fly.toml),
[`worker/Dockerfile`](../../../../worker/Dockerfile),
[`frontend/src/hooks/use-live-prices.ts`](../../../../frontend/src/hooks/use-live-prices.ts),
[`frontend/src/lib/supabase.ts`](../../../../frontend/src/lib/supabase.ts),
[`backend/_finnhub_probe.ts`](../../../../backend/_finnhub_probe.ts),
`LiveBadge`/`useLivePrices()` in [`frontend/src/components/finance/finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx).

---

## 1. The shape: subscribe once, fan out to many

```
                  ┌────────────────────────────┐
  Finnhub WS  ───►│  worker/ (Fly.io, always-on)│
  wss://ws        │  • ONE socket, all symbols  │       Supabase Realtime         Browsers (N tabs)
  .finnhub.io     │  • latest-price Map + dirty │       channel "prices:top"      use-live-prices.ts
  trade firehose  │  • flush loop ~1/sec        ├──POST /realtime/v1/api/broadcast──►  on("broadcast",
                  │    POST broadcast (service  │       event "tick"                    {event:"tick"})
                  │    role key)                │       payload {symbols:[{s,p,t}]}    merge → TanStack
                  └────────────────────────────┘                                       caches
   ↑ FINNHUB_API_KEY lives ONLY in the worker (it rides in the WS URL).
   ↑ Browser holds ONLY the Supabase ANON key — it NEVER touches Finnhub.
```

The whole point: **exactly one** upstream Finnhub socket regardless of how many people are watching.
The worker is the only thing that knows the Finnhub key; browsers subscribe to Supabase, not Finnhub.
This is the same "compute-once-serve-many" principle as the REST card caches, applied to a stream.

---

## 2. Why a separate service (OFF Vercel)

Vercel functions are **per-request and freeze between invocations** — they cannot hold a persistent
WebSocket or a 1/sec timer. The live feed therefore lives in [`worker/`](../../../../worker/), a
standalone Bun service deployed to **Fly.io** (~$2/mo always-on). The header comment in
[`worker/index.ts`](../../../../worker/index.ts) spells out the constraint, and the rule has teeth:

| Host | Verdict | Why |
|------|---------|-----|
| **Vercel serverless** | ❌ | Can't hold a socket; freezes between requests. |
| **Fly.io (one always-on machine)** | ✅ | Holds the socket; cheap; `auto_stop_machines=false`. |
| Render free / Koyeb free | ❌ | Sleep / scale-to-zero on no *inbound* traffic — our socket is **outbound**, so nothing wakes them. See [`worker/README.md`](../../../../worker/README.md). |

The worker has **NO inbound HTTP service** — it only makes outbound connections (Finnhub WS in,
Supabase broadcast out). That is exactly why a scale-to-zero PaaS kills it: there is no inbound
request to keep it warm.

---

## 3. Inside the worker (`worker/index.ts`)

A tiny single-file Bun program. The moving parts, in order:

1. **Env resolution** (top of file). `FINNHUB_API_KEY || FINHUB_API_KEY` (the one-N typo is
   deliberately accepted — the user's real key is spelled `FINHUB`). Supabase URL falls back through
   `SUPABASE_URL → BUN_PUBLIC_SUPABASE_URL → hardcoded project URL`; the service key is
   `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_API_SECRET` (the alias lets the worker reuse
   `backend/.env.local` for local dev). Missing `FINNHUB_API_KEY` or service key ⇒ `process.exit(1)`.
2. **Symbol list** (`SYMBOLS`, env-overridable). Default = 6 watchlist stocks +
   5 BINANCE crypto pairs: `GOOGL,NVDA,TSLA,META,AAPL,AMZN,BINANCE:BTCUSDT,…BNBUSDT`. Keep it ≤ Finnhub's
   free symbol cap (~50) and in sync with the frontend watchlist. **Indices (`^GSPC` etc.) are NOT on
   the WS** — they stay on Yahoo REST (see `market-data-providers.md`).
3. **State:** `latest: Map<symbol,{p,t}>` (latest price per symbol) and `dirty: Set<symbol>` (which
   changed since the last flush). This pair IS the coalescing mechanism.
4. **`connect()`** opens `wss://ws.finnhub.io?token=${KEY}`, and on `open` sends one
   `{type:"subscribe", symbol}` per symbol. On every `message`:
   - **Always `JSON.parse` before branching** — Finnhub interleaves `{type:"ping"}` keepalives.
   - Ignore `ping`; log `error`; only act on `type:"trade"` frames with a `data[]` array.
   - For each trade, **drop out-of-order ticks** (`if (prev && tr.t <= prev.t) continue`), then
     `latest.set` + `dirty.add`. The firehose is absorbed into a per-symbol latest value here.
5. **Reconnect** (`scheduleReconnect`): exponential backoff `1s → 30s` capped, multiplied by
   `0.5–1.0` jitter to avoid thundering-herd reconnects. `open` resets backoff to `1000`.
6. **Watchdog** (10s interval): if no frame (trade OR ping) arrived for >35s the socket is presumed
   dead and force-closed, which triggers the reconnect path.
7. **Broadcast loop** (`setInterval`, `FLUSH_MS` = 1000 default): if `dirty` is empty, return (no
   empty messages). Otherwise build `symbols = [...dirty].map(s => ({s, ...latest.get(s)}))`, clear
   `dirty`, and POST **one bounded message** to Supabase Realtime regardless of tick volume:

   ```ts
   POST `${SUPABASE_URL}/realtime/v1/api/broadcast`
   headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
   body: { messages: [{ topic: "prices:top", event: "tick", payload: { symbols } }] }
   ```

   First successful broadcast logs `[broadcast] ok — live pipe up`; failures log status + body.

**Tick coalescing — why it matters.** Finnhub can emit hundreds of trades/sec for a liquid symbol.
Without coalescing, each tab would re-render on every trade and Supabase would be flooded. The
`latest` Map + `dirty` Set collapse arbitrary tick volume into **one message per second carrying only
changed symbols** — bounded cost on the network, on Supabase, and on the React render path. Tune the
cadence with `FLUSH_MS` (don't go below ~250ms — you lose the coalescing benefit).

---

## 4. The Supabase Realtime hop

The worker is a Realtime **producer** (service-role key, REST broadcast endpoint); browsers are
**consumers** (anon key, WebSocket subscription). Supabase Realtime relays `broadcast` messages on a
named channel without persisting them — it's a pub/sub fan-out, not a table. The contract is just the
shape of the payload: `{ symbols: Tick[] }` where `Tick = { s: string; p: number; t: number }`.

- **Channel name** is `prices:top` on both ends. Worker default = `PRICE_CHANNEL` env; frontend
  default = the `channel` arg to `useLivePrices()`. Change one, change the other.
- **Key split is the security boundary.** Worker uses `SUPABASE_SERVICE_ROLE_KEY` (privileged,
  server-only). Browser uses `BUN_PUBLIC_SUPABASE_ANON_KEY` via
  [`frontend/src/lib/supabase.ts`](../../../../frontend/src/lib/supabase.ts) (`createClient(url, anonKey)`).
  The anon key is safe to inline in the bundle; the Finnhub key and service key never leave the worker.

---

## 5. The frontend hook (`use-live-prices.ts`)

[`useLivePrices(channel="prices:top")`](../../../../frontend/src/hooks/use-live-prices.ts) subscribes,
buffers, flushes into the TanStack caches, and reports a per-class status. Walkthrough:

1. **Subscribe.** `supabase.channel(channel).on("broadcast", {event:"tick"}, handler).subscribe(...)`.
   The whole setup is wrapped in `try/catch` so a Realtime failure degrades to "off", never throws.
2. **Classify each tick.** `cryptoBase("BINANCE:BTCUSDT") → "BTC"` (split on `:`, strip
   `USDT|USDC|USD`, uppercase) — this maps a Finnhub pair to the **CoinGecko `coin.symbol`** used by
   the crypto card. Symbols **without** a `:` are stocks. The handler routes each tick into either
   `cryptoBuf` (base→price) or `stockBuf` (symbol→price) and stamps `lastCrypto`/`lastStock` = now.
3. **Buffer + flush at ~4×/sec** (`setInterval(..., 250)`). On each flush, drained buffers are merged
   into the cache **in place** via `qc.setQueryData` — no refetch, no flicker:
   - Stocks → key **`["finance","stocks","us"]`** (US watchlist only; India stocks are delayed, no
     live feed). Maps `prev.items`, replacing `price` where `ticks.has(q.symbol)`.
   - Crypto → key **`["finance","crypto"]`**. Maps `prev.coins`, replacing `price` where
     `ticks.has(c.symbol)` (the CoinGecko base symbol).
   - If the cache entry doesn't exist yet (`prev` undefined), the update is a no-op — the REST card
     must have loaded first; live ticks **decorate** the cached card, they don't create it.
4. **Per-class status** (`setInterval(..., 2000)`). `fresh(t) = t != null && now - t < 15000`.
   - `!connected` → **`"off"`**
   - connected + a tick in the last 15s → **`"live"`**
   - connected + no recent tick → **`"idle"`**
   - Computed **independently** for stocks and crypto — this is the whole "honest badge" design (§6).
5. **Cleanup** clears both intervals and `supabase.removeChannel(ch)`.

**Why merge into the cache instead of holding tick state in the component?** The card grid already
renders from `["finance","stocks"]`/`["finance","crypto"]` (via `use-finance.ts`). Writing ticks into
the same cache means there is ONE source of truth, the existing render path is reused, and a later
background refetch and a live tick can't disagree about which value is shown.

---

## 6. The honest per-class badge (Live vs Idle)

The crucial UX-honesty decision: **status is computed per asset class, not globally**, because the two
classes have different liquidity clocks. Finnhub's free WS streams **crypto (`BINANCE:*`) and forex
(`OANDA:*`) real-time 24/7**, but **stocks only tick during US market hours** — when the US market is
closed the watchlist symbols emit **zero ticks**.

| Class | When US market open | When US market closed |
|-------|---------------------|------------------------|
| Crypto (`BINANCE:*`) | **Live** (ticking) | **Live** (still ticking — 24/7) |
| Watchlist stocks | **Live** | **Idle** (connected, no ticks) |

`LiveBadge` in [`finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx)
renders this honestly: `live` = green pulsing dot + "Live" ("receiving real-time ticks"),
`idle` = amber dot + "Idle" ("Connected, but no ticks right now (e.g. market closed)"),
`off` = grey dot + "—" ("Not connected"). `useLivePrices()` is called once in `FinanceView`; its
`{stockStatus, cryptoStatus}` feed `WatchlistAside` and `CryptoGrid` respectively. **Never** show a
single global "Live" — a green badge over a frozen Saturday watchlist is a lie; the amber "Idle" tells
the truth (the pipe is up, the market isn't).

---

## 7. `_finnhub_probe.ts` — settle real-time-vs-delayed before trusting the feed

[`backend/_finnhub_probe.ts`](../../../../backend/_finnhub_probe.ts) is a **throwaway** diagnostic
("Run, read, delete"). It opens the same `wss://ws.finnhub.io?token=` socket, subscribes to one of each
class (`AAPL`, `BINANCE:BTCUSDT`, `OANDA:EUR_USD`), counts ticks for ~25s, and prints a verdict per
symbol:

- **NO DATA** → not on the free tier, or the market is closed.
- **DELAYED ~N min** → first-tick lag > 600s (the trade timestamp `tr.t` is far behind now).
- **REAL-TIME (first-tick lag Ns)** → recent timestamps.

Run it (it prints NO key, just `length`) when adding a symbol class or debugging a dead feed:

```sh
bun --env-file=backend/.env.local backend/_finnhub_probe.ts
```

It also reuses the `FINNHUB_API_KEY || FINHUB_API_KEY` quirk and reminds you stocks only stream during
US market hours (≈ 19:00–01:30 IST). Use it to answer "is the worker idle because it's broken, or
because the market is closed?" — if the probe shows crypto REAL-TIME but stocks NO DATA, the worker is
fine and the watchlist badge SHOULD read Idle.

---

## 8. Deploy & operate (Fly.io)

Config: [`worker/fly.toml`](../../../../worker/fly.toml) +
[`worker/Dockerfile`](../../../../worker/Dockerfile) (`FROM oven/bun:1`, `CMD ["bun","index.ts"]`,
no inbound port).

```sh
cd worker
fly launch --no-deploy        # accept the Dockerfile; keep the app name or edit fly.toml
fly secrets set FINNHUB_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=https://<ref>.supabase.co
fly deploy
fly scale count 1             # exactly one always-on machine
```

**The single most important setting** is in `fly.toml`'s `[[vm]]`: `auto_stop_machines = false`,
`auto_start_machines = false`, `min_machines_running = 1`. `fly launch` tends to add an
`[http_service]` with `auto_stop_machines='stop'` and `min_machines_running=0` for a *web* service —
that would let Fly stop the machine on no inbound traffic and **there is no inbound traffic to wake it
back up** (the socket is outbound). A worker must be pinned always-on. Secrets are set via
`fly secrets`, **never** committed to `fly.toml` (it carries only the non-secret `PRICE_CHANNEL`,
`FLUSH_MS`, `SYMBOLS`). `primary_region = "iad"` keeps it near US exchanges.

**Run locally first** (verify the pipe before deploying): from `worker/`,
`bun --env-file=../backend/.env.local index.ts`. You should see `[finnhub] open — subscribing…` and,
during US market hours, a steady `[broadcast] ok`. Local dev works because the worker accepts
`SUPABASE_API_SECRET` as the service key and falls back to the known project URL.

---

## 9. Anti-patterns → do instead

| Anti-pattern | Why it breaks | Do instead |
|---|---|---|
| Open a WebSocket from a Vercel route / serverless fn | Functions freeze between requests; the socket dies | The always-on `worker/` on Fly (`auto_stop_machines=false`) |
| Each browser connects to Finnhub directly | Leaks the Finnhub key to the client; N sockets blow the free symbol/connection cap | One worker socket → Supabase fan-out; browser holds only the anon key |
| Broadcast every trade tick | Floods Supabase + re-renders every tab per trade | Coalesce via `latest` Map + `dirty` Set; one bounded message per `FLUSH_MS` |
| Branch on `msg.type` before `JSON.parse` | Finnhub `{type:"ping"}` keepalives crash/mis-handle | Always `JSON.parse` (in try/catch) first, then ignore `ping` |
| Trust tick ordering | Out-of-order frames overwrite a newer price | `if (prev && tr.t <= prev.t) continue` (worker drops stale) |
| Refetch the card on each tick | Network spam + flicker | `qc.setQueryData(["finance","stocks","us"|"crypto"], merge)` in place |
| One global "Live" badge | Reads "Live" over a frozen weekend watchlist — a lie | Per-class status; crypto "Live" 24/7, stocks "Idle" when closed |
| Deploy on Render/Koyeb free | Scale-to-zero on no *inbound* traffic kills the outbound socket | Always-on Fly machine, `min_machines_running = 1` |
| Spell the env `FINNHUB_API_KEY` only | The user's real key is `FINHUB` (one N) → worker exits | Accept `FINNHUB_API_KEY || FINHUB_API_KEY` (already done in worker + probe) |
| Stream indices over the WS | `^GSPC` etc. aren't on the Finnhub WS | Keep indices on Yahoo REST; only stocks + `BINANCE:*` go live |
| Commit secrets to `fly.toml` | The repo file is public-ish; service-role key is privileged | `fly secrets set …`; `fly.toml` keeps only non-secret env |

---

## 10. Extending the live feed (cheat sheet)

- **Add a live symbol** → add to `SYMBOLS` (worker env / `fly.toml`) AND to the frontend watchlist so
  the merge target exists; keep total ≤ ~50. Crypto must be `BINANCE:<PAIR>USDT` so `cryptoBase()`
  maps it to the CoinGecko symbol; stocks are bare tickers.
- **Add a new asset class** (e.g. forex `OANDA:*`) → probe it first (`_finnhub_probe.ts`), then
  decide its cache key + a `*Base()`-style classifier in `use-live-prices.ts`, and give it its own
  status (don't fold it into the stock/crypto badges if its clock differs).
- **Change cadence** → `FLUSH_MS` (worker) controls broadcast rate; the hook's `250ms` flush controls
  render rate. Keep the hook flush ≤ the worker flush.
- **Multi-instance worker** → DON'T, casually. Two workers = two Finnhub sockets (cap risk) and
  duplicate broadcasts. Keep `min_machines_running = 1`; if you must scale, add a leader lock.
- **Indices live** → not supported by the WS; if you need live indices, that's a different provider,
  not this worker.
