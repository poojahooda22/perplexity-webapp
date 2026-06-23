# Lumina — Supabase Realtime Live Prices

> How the always-on Fly.io worker fans trade ticks from Finnhub WebSocket out to every browser via
> Supabase Realtime Broadcast, and how the React `useLivePrices` hook merges those ticks into the
> TanStack Query cache without a refetch.

---

## 1. Why the publisher lives in `worker/`, not on Vercel

Cross-cutting rule (CLAUDE.md §6): **Vercel serverless functions cannot hold a persistent socket or a
long-lived timer.** A Vercel function is invoked, runs, and is frozen/reaped — there is no runtime
between requests. Finnhub requires a persistent WebSocket connection to receive a real-time trade
stream; that connection would be terminated the moment the handler returns.

The solution is a dedicated always-on process deployed to Fly.io (`worker/`). The boundary is clean:

```
Finnhub WS ──► worker/index.ts (Fly.io, always-on)
                  │  coalesces ticks, calls
                  ▼
         Supabase Realtime /api/broadcast
                  │  fan-out to all subscribers
                  ▼
         Browser WebSocket (managed by @supabase/supabase-js)
                  │
                  ▼
         useLivePrices → qc.setQueryData (in-place merge)
```

The Finnhub API key lives exclusively in the worker environment. It is embedded in the WebSocket URL
(`wss://ws.finnhub.io?token=...`) and must never reach a browser. Browsers only ever hold the
Supabase **anon key**, which cannot read Finnhub at all.

The worker is intentionally minimal — a single `worker/index.ts` file with no inbound HTTP service.
The Fly.io config (`worker/fly.toml`) sets `auto_stop_machines = false`,
`auto_start_machines = false`, and `min_machines_running = 1` so the machine never sleeps waiting
for inbound traffic (there is none). A `shared-cpu-1x` machine with 256 MB RAM is enough for one
WebSocket and periodic HTTP broadcasts.

---

## 2. What actually exists — reading the real files

### `worker/index.ts` — the publisher

File: `worker/index.ts` (141 lines).

**Environment variables** (lines 16-26):

```ts
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || process.env.FINHUB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.BUN_PUBLIC_SUPABASE_URL || "https://...";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_API_SECRET;
const CHANNEL = process.env.PRICE_CHANNEL || "prices:top";
const FLUSH_MS = Number(process.env.FLUSH_MS) || 1000;
```

The worker will `process.exit(1)` if either `FINNHUB_API_KEY` or `SUPABASE_SERVICE_KEY` is absent
(lines 38-44) — fail-fast at startup rather than silently sending no data.

**Symbol list** (lines 29-36): defaults to a small set of US watchlist stocks plus Binance crypto
pairs in the `EXCHANGE:PAIR` format Finnhub uses for crypto:

```
GOOGL, NVDA, TSLA, META, AAPL, AMZN,
BINANCE:BTCUSDT, BINANCE:ETHUSDT, BINANCE:SOLUSDT, BINANCE:XRPUSDT, BINANCE:BNBUSDT
```

The list is intentionally kept at or below ~50 symbols (Finnhub free tier cap). Index symbols like
`^GSPC` are not on the WebSocket — they are fetched via REST on the backend.

**Hot data structures** (lines 46-48):

```ts
const latest = new Map<string, { p: number; t: number }>();
const dirty = new Set<string>();
```

`latest` holds the most recent price for every subscribed symbol. `dirty` tracks which symbols have
received a new tick since the last broadcast. The coalesced flush loop reads `dirty`, emits only
changed symbols, then clears it — so a single broadcast message per `FLUSH_MS` (default 1 s)
regardless of how many trade events Finnhub sends in that window.

**Tick ingestion** (lines 64-83): each incoming Finnhub `trade` frame contains an array of trades.
Out-of-order ticks (earlier timestamp than the stored `latest`) are dropped:

```ts
for (const tr of msg.data) {
  const prev = latest.get(tr.s);
  if (prev && tr.t <= prev.t) continue; // drop out-of-order
  latest.set(tr.s, { p: tr.p, t: tr.t });
  dirty.add(tr.s);
}
```

**Reconnection** (lines 98-103): exponential backoff (1 s → 30 s) with ±50 % jitter to avoid
thundering-herd reconnects after a Finnhub outage. The backoff resets to 1 s on a successful
`open` event.

**Watchdog** (lines 106-113): a 10-second polling interval checks whether a frame (trade or ping)
has arrived in the last 35 seconds. If not, the socket is considered dead and is force-closed,
which triggers the `close` handler and the reconnect path. This guards against TCP half-open states
where the socket appears open but is not delivering data.

**Coalesced broadcast loop** (lines 116-138): the broadcast is a plain `fetch` POST to
`${SUPABASE_URL}/realtime/v1/api/broadcast` using the service-role key. The message shape:

```ts
{
  messages: [
    {
      topic: CHANNEL,          // "prices:top"
      event: "tick",
      payload: { symbols: [{ s: "AAPL", p: 213.45, t: 1719000000000 }] }
    }
  ]
}
```

This is the Supabase Realtime **server-side broadcast REST API** — it lets a trusted server push a
message to a channel without holding a WebSocket connection itself. Browsers that have subscribed to
the channel receive the message over their existing Supabase Realtime WebSocket.

### `frontend/src/lib/supabase.ts` — the browser client

File: `frontend/src/lib/supabase.ts` (11 lines).

```ts
import { createClient } from "@supabase/supabase-js";
const supabaseUrl  = import.meta.env.BUN_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.BUN_PUBLIC_SUPABASE_ANON_KEY;
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

A single module-level client, created once and shared across all hooks. The anon key permits
Realtime channel subscriptions; it does not grant any database access (Supabase RLS blocks
everything that isn't explicitly opened, and this client is used only for Realtime).

### `frontend/src/hooks/use-live-prices.ts` — the subscriber

File: `frontend/src/hooks/use-live-prices.ts` (105 lines). This is the complete, shipped hook.

---

## 3. The channel design — Broadcast vs Postgres Changes

Supabase Realtime offers three delivery modes:

| Mode | What it delivers | RLS check | Suitable for |
|---|---|---|---|
| **Broadcast** | Ephemeral messages pushed by any authorized client or server | None | High-frequency events where history doesn't matter |
| **Postgres Changes** | INSERT/UPDATE/DELETE row events from the WAL | Yes — per subscriber | Low-to-medium frequency, owned-row fan-out |
| **Presence** | Who is currently in a channel | None | Collaborative cursors, online indicators |

Price ticks are a textbook fit for **Broadcast**:

- **Frequency**: Finnhub emits hundreds of trade events per second during US market hours. Postgres
  Changes converts each qualifying database change into a WAL event and re-evaluates RLS for every
  subscriber — that would require writing every tick to a table, triggering WAL events at O(ticks ×
  subscribers), and defeating the entire purpose of the worker's coalescing step.
- **Ephemerality**: a price tick has zero value once superseded. There is no reason to persist every
  individual tick in Postgres. The backend REST endpoints (`/finance/stocks`, `/finance/crypto`)
  already serve the baseline snapshot via the Redis cache; Realtime Broadcast delivers deltas on
  top of that snapshot.
- **Fanout cost**: Broadcast delivers one message to all subscribers in the channel. Postgres Changes
  at the same volume would saturate Supabase's WAL replication slots and RLS evaluator.
- **Authorization**: the service-role key authorizes the worker's server-side broadcasts; browser
  subscribers use the anon key and channel name only. No RLS policy needs to be written.

The channel name `"prices:top"` (configurable via `PRICE_CHANNEL` env var) follows Supabase's
recommended `topic:subtopic` naming convention and is the same string in the worker broadcast payload
and in the browser `supabase.channel(channel)` call.

---

## 4. The subscriber — `useLivePrices` in depth

### Subscription lifecycle

```ts
// use-live-prices.ts:34-56
useEffect(() => {
  let ch: RealtimeChannel | null = null;
  try {
    ch = supabase.channel(channel);
    ch.on("broadcast", { event: "tick" }, (msg) => { /* buffer ticks */ })
      .subscribe((s) => {
        connected.current = s === "SUBSCRIBED";
      });
  } catch (e) {
    console.warn("[live-prices] subscribe failed:", e);
  }
  // ...timers...
  return () => {
    clearInterval(flush);
    clearInterval(statusTimer);
    if (ch) supabase.removeChannel(ch);   // ← leak guard
  };
}, [channel, qc]);
```

The `useEffect` dependency array is `[channel, qc]`. Both are stable for the lifetime of the finance
page (the channel name is a constant default `"prices:top"`; `qc` is the React Query client
singleton). The channel is torn down on unmount via `supabase.removeChannel(ch)`. If `channel` were
ever changed (e.g. a different vertical subscribing to a different topic), the effect re-runs,
cleanly unsubscribing the old channel and subscribing to the new one.

### Tick buffering and the flush interval

Incoming ticks are NOT immediately written to React state or the TanStack cache (line 40-51). They
are buffered into two `useRef<Map<string, number>>` objects:

- `stockBuf` — keyed by raw Finnhub symbol (e.g. `"AAPL"`)
- `cryptoBuf` — keyed by the base currency symbol extracted by `cryptoBase` (e.g. `"BTC"` from
  `"BINANCE:BTCUSDT"`)

The `cryptoBase` helper (lines 12-16) detects Binance-format symbols by the presence of `:`, strips
the quote currency (`USDT`, `USDC`, `USD`), and uppercases the base. A plain stock symbol (no `:`)
returns `null`, routing to `stockBuf` instead.

The refs deliberately hold plain `Map` objects rather than React state — writing to a ref does not
schedule a re-render. This means a burst of 50 ticks arriving in 100 ms does not cause 50
re-renders. A `setInterval` at **250 ms** (4 Hz) drains both buffers in batch:

```ts
// use-live-prices.ts:59-89
const flush = setInterval(() => {
  if (stockBuf.current.size) {
    const ticks = stockBuf.current;
    stockBuf.current = new Map();       // swap before async work
    qc.setQueryData<QuotesPayload>(["finance", "stocks", "us"], (prev) =>
      prev ? { ...prev, items: prev.items.map((q) =>
        ticks.has(q.symbol) ? { ...q, price: ticks.get(q.symbol)! } : q
      )} : prev,
    );
  }
  if (cryptoBuf.current.size) {
    const ticks = cryptoBuf.current;
    cryptoBuf.current = new Map();
    qc.setQueryData<CryptoPayload>(["finance", "crypto"], (prev) =>
      prev ? { ...prev, coins: prev.coins.map((c) =>
        ticks.has(c.symbol) ? { ...c, price: ticks.get(c.symbol)! } : c
      )} : prev,
    );
  }
}, 250);
```

`qc.setQueryData` writes directly into the TanStack Query in-memory cache at the same key the
`useStocks` / `useCrypto` hooks use (`["finance", "stocks", "us"]` and `["finance", "crypto"]`).
Components subscribed to those queries via `useStocks` / `useCrypto` re-render automatically with
the updated price — no HTTP refetch, no flicker, no duplicate network round-trip.

The buffer is swapped (`stockBuf.current = new Map()`) before the `setQueryData` call so that any
ticks arriving during the synchronous updater function accumulate into the fresh buffer and are not
lost.

Important: `["finance", "stocks", "us"]` is hardcoded (line 64). The comment on line 63 is explicit:
"US watchlist only — India stocks are delayed (no live worker feed)". India market data (`market=in`)
stays on the 60-second REST poll in `useStocks("in")` and is never touched by live ticks.

### TanStack Query key alignment

The flush loop must use the exact query keys from `use-finance.ts`:

| Data | `useQuery` key (use-finance.ts) | `setQueryData` key (use-live-prices.ts) |
|---|---|---|
| US stocks | `["finance", "stocks", "us"]` | `["finance", "stocks", "us"]` (line 64) |
| Crypto | `["finance", "crypto"]` | `["finance", "crypto"]` (line 76) |

If these keys drift, `setQueryData` writes to an orphaned key and no component updates. When adding
new live-priced assets, add the corresponding `setQueryData` call with the matching key.

### Status reporting

A second `setInterval` at 2 seconds updates the `LiveStatus` state (lines 91-95):

```ts
const statusTimer = setInterval(() => {
  const fresh = (t: number | null) => t != null && Date.now() - t < 15_000;
  setStockStatus(!connected.current ? "off" : fresh(lastStock.current) ? "live" : "idle");
  setCryptoStatus(!connected.current ? "off" : fresh(lastCrypto.current) ? "live" : "idle");
}, 2000);
```

Three states per class:

| Status | Meaning |
|---|---|
| `"off"` | Supabase channel not yet `SUBSCRIBED` |
| `"live"` | A tick arrived within the last 15 seconds |
| `"idle"` | Connected but no recent tick (market closed, or no activity) |

`lastStock` and `lastCrypto` are set inside the tick handler (not the flush interval) so the
recency check reflects the last time a tick was received, not the last time it was flushed to the
cache. The 15-second window is generous enough to bridge a 1-second flush interval plus normal
network jitter.

Crypto reads `"live"` 24/7 (Binance trades continuously). Stock status will read `"idle"` outside
NYSE/Nasdaq trading hours (9:30 AM – 4:00 PM ET on weekdays) even when the channel is connected,
because Finnhub sends no equity trade events when the market is closed.

The hook returns `{ stockStatus, cryptoStatus }` so the finance UI can render indicators (e.g. a
green dot for live, amber for idle, grey for off) without any additional state.

---

## 5. Market open/closed and reconnection behavior

### What happens at market close

When the US equity market closes at 4:00 PM ET, Finnhub stops sending `trade` events for stock
symbols. The worker's `dirty` set remains empty; the broadcast loop fires but skips (line 117:
`if (dirty.size === 0) return`). No broadcasts are sent, no browser resources are consumed.

On the browser side, `lastStock.current` ages past 15 seconds and `stockStatus` transitions from
`"live"` to `"idle"`. The last known prices remain in the TanStack cache and continue to be
displayed.

Crypto is unaffected — Binance operates 24/7 and continues sending ticks. `cryptoStatus` stays
`"live"` through the night.

### Worker reconnection

The Finnhub WebSocket occasionally drops (rate limit, network glitch, Finnhub deployment). The
worker's `close` handler calls `scheduleReconnect()` which applies jittered exponential backoff
(1 s → 30 s cap, ±50% jitter). On reconnect, the `open` handler re-subscribes all symbols and
resets `backoff` to 1 s. The watchdog at line 106 catches TCP half-open states that do not
generate a `close` event.

From the browser's perspective, a worker reconnect manifests as a gap in ticks (stockStatus →
`"idle"` after 15 s). When the worker reconnects and ticks resume, `stockStatus` returns to
`"live"` within 15 s and prices are updated from the next flush. No browser-side reconnect logic is
needed because the Supabase channel connection is to Supabase's Realtime infrastructure, which
remains up regardless of the worker's upstream Finnhub connection.

### Browser tab visibility and Supabase Realtime reconnects

The `@supabase/supabase-js` client handles its own WebSocket reconnection transparently. If a user
suspends their laptop and resumes, or loses network connectivity, the Supabase client will
reconnect and re-subscribe. The `connected.current` ref tracks `SUBSCRIBED` state via the
`.subscribe(status => ...)` callback (line 52-54). During a reconnect window, status is `"off"`.

The 250 ms flush interval and 2 s status interval continue running even when the tab is not
focused. This is acceptable because the intervals are cheap (two Map iterations and two
`setQueryData` calls at 4 Hz). If battery impact becomes a concern, wrap the flush in a
`document.visibilityState === "visible"` guard — but the current implementation does not do this.

---

## 6. Composition — finance-markets owns price data, supabase owns transport

The live price flow spans two concerns. They must not be entangled.

**`finance-markets` skill** owns:
- Which symbols are tracked and why (watchlist selection, Finnhub free-tier cap)
- What Finnhub WS sends (trade event shape: `{ type, data: [{ s, p, t, v }] }`)
- The provider-level decision (Finnhub for stocks/crypto real-time; Yahoo REST for indices; why
  India symbols are not on the worker feed)
- Backend REST endpoints (`/finance/stocks`, `/finance/crypto`) that serve the baseline snapshot
  via Redis cache

**`supabase` skill** (this document) owns:
- Why Broadcast is the right Realtime mode (vs Postgres Changes)
- The worker broadcast REST API call shape
- The `useLivePrices` hook — buffering, 4 Hz flush, `setQueryData` merge, status reporting,
  cleanup, key alignment
- The Supabase client instantiation in `frontend/src/lib/supabase.ts`

The division is: **finance-markets tells you what prices flow; supabase tells you how they flow**.

### Wiring diagram at code level

```
worker/index.ts
  connect()                  → Finnhub WS at wss://ws.finnhub.io?token=...
  ws "message" handler       → latest Map + dirty Set
  setInterval(FLUSH_MS)      → POST /realtime/v1/api/broadcast  (service-role key)
                                   payload: { messages: [{ topic, event: "tick", payload }] }

frontend/src/lib/supabase.ts
  createClient(url, anonKey) → supabase  (module singleton)

frontend/src/hooks/use-live-prices.ts
  supabase.channel("prices:top")
    .on("broadcast", { event: "tick" }, handler)
    .subscribe()
  handler                    → stockBuf / cryptoBuf (useRef<Map>)
  setInterval(250ms)         → qc.setQueryData(["finance","stocks","us"], updater)
                             → qc.setQueryData(["finance","crypto"], updater)
  setInterval(2000ms)        → setStockStatus / setCryptoStatus

frontend/src/hooks/use-finance.ts
  useStocks("us")  queryKey: ["finance", "stocks", "us"]   ← updated in place by setQueryData
  useCrypto()      queryKey: ["finance", "crypto"]          ← updated in place by setQueryData
```

---

## 7. Environment variables and secrets

| Variable | Where set | Purpose |
|---|---|---|
| `FINNHUB_API_KEY` | Fly.io secrets | Finnhub WS authentication (worker only) |
| `FINHUB_API_KEY` | Fly.io secrets | Alternate spelling (tolerated, see worker:16) |
| `SUPABASE_SERVICE_ROLE_KEY` | Fly.io secrets | Server-side broadcast authorization |
| `SUPABASE_API_SECRET` | Fly.io secrets | Fallback alias for the above (worker:23) |
| `SUPABASE_URL` | Fly.io env or `BUN_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `PRICE_CHANNEL` | `fly.toml` env (default `"prices:top"`) | Channel name (must match browser) |
| `FLUSH_MS` | `fly.toml` env (default `"1000"`) | Broadcast cadence in ms |
| `SYMBOLS` | `fly.toml` env (comma-separated) | Subscribed symbols |
| `BUN_PUBLIC_SUPABASE_URL` | Vite build env | Browser client URL |
| `BUN_PUBLIC_SUPABASE_ANON_KEY` | Vite build env | Browser client anon key |

`FINNHUB_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` must be set as **Fly.io secrets** (`fly secrets
set KEY=value`), never in `fly.toml` (which is committed). The `[env]` section in `fly.toml:18-21`
sets only non-sensitive configuration.

---

## 8. Adding a new real-time asset class

Follow this checklist when adding a new symbol type (e.g. commodities, FX):

1. **Worker** (`worker/index.ts`): add new symbols to the `SYMBOLS` env default and confirm
   Finnhub's event shape for that asset class (crypto uses `EXCHANGE:PAIR`; stocks use plain
   tickers). Add a classifier function analogous to `cryptoBase`.

2. **Worker broadcast payload**: the `{ s, p, t }` shape is generic. No change required if new
   symbols use the same structure.

3. **Backend REST endpoint**: add a new route that serves the baseline snapshot for the new asset
   class. The live ticks are deltas on top of this snapshot.

4. **`finance-api.ts`**: add a new payload type and `fetchXxx` function for the new endpoint.

5. **`use-finance.ts`**: add a `useXxx` hook with the correct `queryKey`.

6. **`use-live-prices.ts`**: add a new `useRef<Map<string, number>>` buffer and a `setQueryData`
   call in the flush interval targeting `["finance", "xxx"]`. Add a `lastXxx` ref and status state
   if a per-class live indicator is needed. Add the classifier in the tick handler.

7. Keep the `PRICE_CHANNEL` the same (`"prices:top"`) unless you need independent rate limiting per
   asset class — separate channels multiply Supabase connections but allow per-channel access control.

---

## 9. Common failure modes and diagnosis

### Prices not updating in the browser

1. Check `stockStatus` / `cryptoStatus` from `useLivePrices`. If `"off"`, the Supabase channel
   did not reach `SUBSCRIBED`. Check `BUN_PUBLIC_SUPABASE_ANON_KEY` and `BUN_PUBLIC_SUPABASE_URL`
   in the browser build.
2. If `"idle"`, the channel is connected but no ticks have arrived. Check the worker:
   `fly logs -a <app-name>` (app name from `worker/fly.toml:13`). If the worker shows `[broadcast] ok` lines, the issue
   is the 15-second freshness window — confirm tick timestamps are current.
3. If the worker is broadcasting but the browser shows no change, confirm the `PRICE_CHANNEL` env
   var in `fly.toml` matches the string passed to `supabase.channel()` in `use-live-prices.ts`
   (default: `"prices:top"` on both sides).

### Worker not broadcasting

1. `fly logs -a <app-name>` (app name from `worker/fly.toml:13`) — look for `[finnhub] error:` lines. A 401 means
   `FINNHUB_API_KEY` is wrong. A 403/429 means rate-limit exceeded.
2. `[broadcast] failed: 401` means `SUPABASE_SERVICE_ROLE_KEY` is wrong or expired.
3. `[watchdog] no frames for 35s` means the Finnhub socket is silently dead outside market hours
   (this is normal on weekends; during market hours it indicates a network issue).

### `setQueryData` not updating components

Confirm the query key passed to `setQueryData` exactly matches the key in `useStocks` / `useCrypto`
in `use-finance.ts`. React Query uses deep equality on key arrays — a key mismatch writes to an
orphan cache entry and no component subscribes to it.

### Ticks arriving but crypto symbols not mapping

The `cryptoBase` function (use-live-prices.ts:12-16) strips `USDT|USDC|USD` suffixes. If a new
crypto pair uses a different quote currency (e.g. `BINANCE:BTCEUR`), `cryptoBase` returns `"BTC"`
(EUR stripped off only if you add it to the regex). The `CryptoCoin.symbol` field in
`finance-api.ts:CryptoCoin` must match the value `cryptoBase` produces. Check `CoinGecko`'s
`symbol` field — it uses lowercase (e.g. `"btc"`); the hook uppercases (line 15); confirm the
`coins.map` lookup is case-insensitive or normalized.

---

## See also

**Same skill (`supabase`):**
- `SKILL.md` — Supabase auth, RLS, pgvector, and Realtime overview for Lumina
- `references/supabase-auth-realtime.md` (if present) — auth.getUser, token cache, service-role key

**Other skills:**
- `finance-markets` — Finnhub WS event types, symbol lists, data-provider licensing, the Redis
  cache layer in `backend/lib/cache.ts`, backend `/finance/*` routes
- `trading-systems` — chart components, candlesticks, indicators that consume the prices delivered
  here
- `crypto-defi` — CoinGecko coin IDs, symbol normalization, the `BINANCE:BTCUSDT` → `BTC` mapping
- `lumina-frontend` — TanStack Query setup, `QueryClient` provider, how `setQueryData` fits into
  the render pipeline
- `react-typescript` — `useRef` for non-reactive buffers, interval cleanup patterns,
  `useEffect` dependency correctness
- `connectors-oauth` — another Supabase client usage (auth token retrieval, not Realtime)
- `backend-testing` — how to mock `@supabase/supabase-js` in Bun tests if writing tests for
  hooks that depend on `useLivePrices`
