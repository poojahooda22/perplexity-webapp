# TanStack Query Patterns — caching the cached, merging live ticks

> How Lumina's frontend fetches and caches data: one global [`QueryClient`](../../../../frontend/src/lib/query.ts),
> tuple query keys, `refetchInterval` deliberately aligned to the **backend** cache TTL (never
> faster), and the one piece that breaks the polling rule — the live-prices `setQueryData` merge that
> writes WebSocket ticks straight into the cache without a refetch. Read this when touching anything
> in [`hooks/`](../../../../frontend/src/hooks/) or [`lib/query.ts`](../../../../frontend/src/lib/query.ts).
> Sibling refs: **api-client-and-config.md** for the `fetch` wrappers the `queryFn`s call and the
> `BUN_PUBLIC_BACKEND_URL` gotcha; **streaming-chat-rendering.md** for the SSE chat path (which does
> **not** use Query — it's a raw stream); **finance-markets** for the backend TTLs these intervals
> mirror. Deeper generic patterns (optimistic mutations, invalidation graphs, infinite queries) live
> in the **rareLab tanstack-query** skill (`E:\Development\Portfolio-phase2\react\.claude\skills\tanstack-query\`).

---

## 1. The mental model: we cache a cache

The single most important idea here, and the reason every interval looks "slow": **the backend
already caches every upstream read.** `getOrRefresh(key, ttlSeconds, fetcher)` in `backend/lib/cache.ts`
serves each endpoint for the TTL declared in `backend/finance/routes.ts` (the `TTL` map): crypto 30s,
indices/stocks/sectors 300s, summary 900s, research 21600s (6h). So our `/finance/*`
endpoints are *already* compute-once-serve-many. The browser's job is **not** to chase freshness —
it is to poll *our* endpoints gently, roughly as often as the data behind them can actually change.

> The data refreshes on the server on its own schedule. Polling a 30s-TTL endpoint every 3s just
> returns the same cached bytes ten times and burns serverless invocations. Match the client poll to
> the server TTL and you get fresh-enough data for free.

This is codified in the `QueryClient` defaults and restated as Non-Negotiable #4 in the SKILL.

---

## 2. The global client — [`lib/query.ts`](../../../../frontend/src/lib/query.ts)

One client for the whole app, created once and handed to the provider at the root. The defaults are
tuned for the cached-endpoint reality above:

```ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,          // don't refetch on mount/remount within 20s
      refetchOnWindowFocus: false, // tab-switch is not a freshness signal here
      retry: 1,                    // one retry, then surface the error (stale-on-error is upstream)
    },
  },
});
```

| Default | Value | Why this, not the library default |
|---|---|---|
| `staleTime` | `20_000` | Library default is `0` → every mount refetches. Our data is stable for ≥30s; 20s stops mount/remount thrash (e.g. switching sub-tabs and back). |
| `refetchOnWindowFocus` | `false` | Library default is `true`. A finance dashboard would refetch every time you alt-tab back — pure waste against an already-cached endpoint. |
| `retry` | `1` | Library default is `3` with backoff. The backend already does **stale-on-error** (serves the last good value rather than 500ing), so a failed read is rare and a long retry chain just delays the error. |

**Per-query `refetchInterval` overrides `staleTime`.** `staleTime` governs *on-demand* refetch
(mount/focus); `refetchInterval` is the *background poll* and is set per hook (Section 4). They are
independent levers — `staleTime` stops redundant refetches when components remount; `refetchInterval`
drives the steady cadence.

---

## 3. Query keys — the tuple convention

Every key is an **array (tuple)**, namespaced by vertical, then resource, then any params. This is
what lets the live-prices merge target an exact cache entry (Section 5) and what would let you
invalidate a whole vertical at once.

| Hook | Key | File |
|---|---|---|
| `useCrypto` | `["finance", "crypto"]` | [`use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts) |
| `usePredictions` | `["finance", "predictions"]` | same |
| `useIndices(market)` | `["finance", "indices", market]` | same |
| `useStocks(market)` | `["finance", "stocks", market]` | same |
| `useSectors(market)` | `["finance", "sectors", market]` | same |
| `useMarketSummary(market)` | `["finance", "summary", market]` | same |
| `useResearch` | `["finance", "research"]` | same |
| `useDiscover(market)` | `["finance", "discover", market]` | same |
| `useAcademicDiscover(market)` | `["discover", "academic", market]` | [`use-discover.ts`](../../../../frontend/src/hooks/use-discover.ts) |
| `useHealthDiscover(market)` | `["discover", "health", market]` | same |

Rules that fall out of this:
- **Params that change the URL belong in the key.** `market` (`"us"` | `"in"`) is part of every
  market-aware key because it maps to a separate backend cache key (`finance:in:*`) and a separate
  `?market=in` request. US and India must not collide in one cache slot.
- **Namespace prefix = invalidation scope.** `queryClient.invalidateQueries({ queryKey: ["finance"] })`
  would refetch the whole finance dashboard; `["finance", "stocks", "us"]` hits exactly one entry.
- **Keys are the contract between the poll and the live merge.** `useLivePrices` writes to
  `["finance", "stocks", "us"]` and `["finance", "crypto"]` by literal tuple — if you rename a key in
  `use-finance.ts`, you must change the merge in `use-live-prices.ts` in lockstep or live ticks
  silently stop landing.

---

## 4. `refetchInterval` aligned to backend TTL — the table

Each hook in [`use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts) and
[`use-discover.ts`](../../../../frontend/src/hooks/use-discover.ts) sets an interval that mirrors the
server's soft TTL. The comments in the files state this explicitly ("backend caches 15 min").

| Hook | Client `refetchInterval` | Backend TTL (`routes.ts`) | Rationale |
|---|---|---|---|
| `useCrypto` | `30_000` (30s) | crypto 30s | Matches exactly — fastest-moving public card. |
| `useIndices` / `useStocks` | `60_000` (60s) | 300s | Polls **faster** than the TTL on purpose: live ticks (Section 5) carry intraday US moves; the 60s poll mainly keeps non-live fields (change%, sparkline) reasonably current. |
| `usePredictions` | `120_000` (2m) | predictions 120s | Matches exactly. |
| `useSectors` | `300_000` (5m) | 300s | Matches exactly. |
| `useMarketSummary` | `600_000` (10m) | summary 900s (15m) | Polls a bit faster than the TTL so a fresh LLM summary surfaces within ~10m of the server recomputing it. |
| `useResearch` | `1_800_000` (30m) | research 21600s (6h) | Far slower than crypto — LLM research notes change slowly; no point polling a 6h cache often. |
| `useDiscover` (finance) | `300_000` (5m) | discover 600s (10m) | Half the TTL. |
| `useAcademicDiscover` | `1_800_000` (30m) | academic ~30m | Matches the comment "research changes slowly". |
| `useHealthDiscover` | `600_000` (10m) | health ~10m | "health news moves faster". |

### Decision framework: choosing an interval for a NEW hook

```
Adding a TanStack hook for a /finance or /discover endpoint?
│
├─ Is the data live-tick-augmented (US stocks/crypto via the worker)?
│    └─ YES → poll near/faster than TTL for the non-tick fields; the merge handles price.
│
├─ Look up the endpoint's TTL in backend/finance/routes.ts (the TTLs list).
│    └─ Set refetchInterval ≈ that TTL. Going slower = staler UI; going much faster = wasted calls
│       returning identical cached bytes.
│
├─ Is it LLM-generated (summary/research)?  → poll well under the TTL is pointless; the body
│    won't change until the server recomputes. Mirror the TTL or go slightly under.
│
└─ Default if unsure: refetchInterval = backend TTL (in ms). Never < ~half the TTL without a reason.
```

The one principle to remember: **the backend TTL is the ground truth; the client interval is a
mirror of it, never a competitor to it.**

---

## 5. The live-prices cache merge — [`use-live-prices.ts`](../../../../frontend/src/hooks/use-live-prices.ts)

This is the deliberate exception to "just poll." For US stocks and crypto, a separate Fly.io worker
holds the Finnhub WebSocket, coalesces ticks, and broadcasts them over **Supabase Realtime** (the
browser holds only the Supabase anon key — never Finnhub). `useLivePrices` subscribes and **writes
ticks directly into the TanStack cache with `setQueryData`** — no refetch, no flicker, the card
updates in place.

### Why `setQueryData` and not `invalidateQueries`

| Approach | Effect | Verdict |
|---|---|---|
| `invalidateQueries(["finance","stocks","us"])` on each tick | Triggers a full `/finance/stocks` refetch per tick → hundreds of requests/min, network flicker. | ❌ Defeats the whole point. |
| `setQueryData(key, updater)` | Mutates the in-memory cache entry; subscribed components re-render with the new price, zero network. | ✅ This is the pattern. |

### The shape: buffer → flush → functional updater

The hook never writes on the raw tick. It **buffers** ticks into a `Map` and **flushes** ~4×/sec
(every 250ms) so a burst of ticks becomes one cache write per class:

```ts
// buffer (on every broadcast): symbol -> latest price
stockBuf.current.set(t.s, t.p);

// flush (every 250ms): one functional setQueryData per class
qc.setQueryData<QuotesPayload>(["finance", "stocks", "us"], (prev) =>
  prev
    ? { ...prev, items: prev.items.map((q) =>
          ticks.has(q.symbol) ? { ...q, price: ticks.get(q.symbol)! } : q) }
    : prev,
);
```

Five things this code gets right, each load-bearing:

1. **Functional updater + immutability.** It returns a *new* object (`{...prev, items: prev.items.map(...)}`),
   never mutates `prev`. TanStack diffs by reference; an in-place mutation would not re-render.
2. **`prev ? … : prev` guard.** If the poll hasn't populated the cache yet, the updater returns
   `prev` (i.e. `undefined`) unchanged — it never invents an entry. Ticks merge *into* the polled
   payload; the poll owns the full shape.
3. **It only overwrites `price`.** Every other field (`name`, `change`, `sparkline`, `provenance`)
   comes from the poll. The merge is surgical — live price, polled everything-else.
4. **Symbol routing splits the one channel into two caches.** `cryptoBase("BINANCE:BTCUSDT") → "BTC"`
   matches `coin.symbol`; a symbol with no `:` is a stock. One broadcast feeds both
   `["finance","stocks","us"]` and `["finance","crypto"]`.
5. **US-only for stocks.** The merge hardcodes `["finance","stocks","us"]` — India quotes are delayed
   and have no worker feed, so the `"in"` cache is poll-only by design.

### Honest per-class status

A second 2s timer derives a `LiveStatus` per class (`"off"` not subscribed, `"idle"` subscribed but
no recent ticks, `"live"` ticked within 15s). Crypto reads `"live"` 24/7; stocks read `"idle"` when
the US market is closed. The hook returns `{ stockStatus, cryptoStatus }` for the badges. Cleanup
clears both intervals and `supabase.removeChannel(ch)` on unmount — no leaked subscription.

> Cross-ref: the producer side (worker, channel `prices:top`, tick coalescing) is owned by
> **finance-markets** → `lumina-finance-architecture.md` §"Live prices". This ref owns only the
> client merge.

---

## 6. Mutations

Lumina's frontend is **read-heavy**: the dashboards are `useQuery` + the live merge, and the chat
turn is a **raw SSE stream**, not a Query mutation (see **streaming-chat-rendering.md** — `runTurn`
in `Dashboard.tsx` drives `streamAsk`/`streamFollowUp` (the `fetch` + `parseStream` wrappers in
`lib/api.ts`) directly; it is intentionally outside TanStack
because you cannot stream tokens through `useMutation`'s single resolve). So there is no
`useMutation` in the finance/discover read hooks today.

When you **do** add a write (e.g. a connector toggle, a watchlist add), follow this shape and
cross-ref the **rareLab tanstack-query** skill for the full optimistic pattern:

```ts
const qc = useQueryClient();
const addToWatchlist = useMutation({
  mutationFn: (symbol: string) => postJson("/watchlist", { symbol }),
  // optimistic: write the cache before the server confirms
  onMutate: async (symbol) => {
    await qc.cancelQueries({ queryKey: ["finance", "stocks", "us"] });
    const prev = qc.getQueryData(["finance", "stocks", "us"]);
    qc.setQueryData(["finance", "stocks", "us"], (old) => /* …append… */ old);
    return { prev }; // context for rollback
  },
  onError: (_e, _v, ctx) => qc.setQueryData(["finance", "stocks", "us"], ctx?.prev), // rollback
  onSettled: () => qc.invalidateQueries({ queryKey: ["finance", "stocks", "us"] }), // reconcile
});
```

The `onMutate`/`onError`/`onSettled` triad (optimistic write → rollback on failure → invalidate to
reconcile with the server) is the canonical TanStack mutation; it reuses the **same tuple keys** the
queries and the live merge use.

---

## 7. Anti-patterns (what marks an amateur here)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Polling a 30s/300s/6h endpoint every few seconds "for freshness". | Set `refetchInterval` ≈ the backend TTL from `routes.ts`; the data isn't fresher than the server cache. |
| `invalidateQueries` on every WebSocket tick. | `setQueryData` with a functional, immutable updater — no refetch, no flicker. |
| Mutating `prev` in the `setQueryData` updater (push/splice). | Return a new object/array (`{...prev, items: prev.items.map(...)}`); TanStack diffs by reference. |
| Dropping the `prev ? … : prev` guard and synthesizing a cache entry from ticks. | Let the poll own the full payload shape; merge ticks *into* it, return `prev` unchanged when empty. |
| Renaming a query key in `use-finance.ts` without updating `use-live-prices.ts`. | Treat the tuple as a shared contract; change both, or ticks stop landing silently. |
| Writing live ticks to `["finance","stocks","in"]`. | US-only — India is poll-only/delayed; only `"us"` has a worker feed. |
| String query keys (`"crypto"`). | Always tuples (`["finance","crypto"]`) — needed for scoped invalidation and the targeted merge. |
| Leaving `staleTime: 0` / `refetchOnWindowFocus: true` (library defaults) per query. | Inherit the tuned `queryClient` defaults; override only the `refetchInterval` per hook. |
| Forcing the chat turn through `useMutation` to "do it properly". | The stream stays a raw `fetch` + `parseStream`; Query can't stream tokens. |
| Forgetting `removeChannel`/`clearInterval` on unmount in a live hook. | Return a cleanup from `useEffect` that clears both timers and removes the Realtime channel. |

---

## 8. Where to add things (cheat sheet)

- **New cached `/finance/*` card** → `fetch` wrapper in
  [`lib/finance-api.ts`](../../../../frontend/src/lib/finance-api.ts) (typed payload) → hook in
  [`use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts) with a tuple key + `refetchInterval`
  matched to the new endpoint's TTL in `backend/finance/routes.ts`.
- **New discover feed** → mirror it in [`use-discover.ts`](../../../../frontend/src/hooks/use-discover.ts)
  under the `["discover", …]` namespace.
- **New live-augmented field** → extend the flush updater in
  [`use-live-prices.ts`](../../../../frontend/src/hooks/use-live-prices.ts), keeping the merge surgical
  (overwrite only the live field; the poll owns the rest).
- **First write/mutation** → `useMutation` with the `onMutate`/`onError`/`onSettled` triad on the
  existing tuple keys; see the **rareLab tanstack-query** skill for optimistic depth.
