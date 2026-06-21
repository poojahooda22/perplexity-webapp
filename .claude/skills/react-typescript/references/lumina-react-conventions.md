# Lumina React/TS Conventions (how THIS codebase applies the patterns)

> The `lumina-` prefix means: this doc cites Lumina's **actual** code (`file:line`). It maps the generic
> rules in the other references onto how Lumina really does things, and records the decisions an interviewer
> (or a future you) would ask about. Verify any `file:line` against live code before relying on it — the repo
> is the source of truth. For the SPA shell / chat-stream rendering / design system, defer to the
> **`lumina-frontend`** skill; this doc is the React/TS *patterns* layer underneath it.

---

## Stack reality

- **React 19** + **Vite-style build via Bun** (`bun --hot src/index.ts`), **`react-router` v7**, **TanStack
  Query v5**, **Supabase** (auth + Realtime), **Radix + class-variance-authority + Tailwind v4**.
- **It is a client-rendered SPA.** There is **no RSC / App Router / Server Actions / Next.js**. Ignore all such
  sections in the imported references (`react-typescript-patterns.md`, `server-components.md`, parts of the
  Jeffallan docs). The relevant "server" is the separate Bun/Express backend the client `fetch`es.

---

## The three state buckets (and why there's no global store)

Lumina deliberately splits state three ways — this is the answer to "why aren't we using Zustand/Redux?":

| Bucket | Tool | Where |
|---|---|---|
| **Server state** (markets, discover, connectors status) | **TanStack Query** | [`lib/query.ts`](../../../../frontend/src/lib/query.ts), [`hooks/`](../../../../frontend/src/hooks/) |
| **Local UI / session state** (chat turns, current conversation, section, model, sidebar collapse) | `useState` + refs | [`pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx) |
| **Cross-tree shared UI state** (US/India market) | React **Context** | `MarketContext` in [`finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx) |

There is **no body of global UI state shared across distant, unrelated components**, which is the only thing a
store like Zustand solves. So Lumina doesn't have one — and that's correct, not a gap.

**When to reach for Zustand (documented, not yet adopted):** the one candidate is the Dashboard "god component"
— it owns `section`/`model`/`conversationId`/`turns` and prop-drills handlers into `Sidebar`, `TopNav`,
`ChatView`. If more distant components start needing those, move them into a typed Zustand store so they
read/write directly instead of threading props. Pick **Zustand over Recoil** (tiny, no provider, hook+selector,
great TS inference; Recoil is effectively abandoned). See [`zustand-advanced-patterns.md`](zustand-advanced-patterns.md).

---

## TanStack Query conventions (as wired)

- **One shared `QueryClient`** with tuned defaults: `staleTime: 20_000`, `refetchOnWindowFocus: false`,
  `retry: 1` ([`lib/query.ts`](../../../../frontend/src/lib/query.ts)). The backend already caches upstream, so
  the client polls *our* endpoints gently.
- **Hierarchical keys** `[domain, resource, market]` — e.g. `['finance','stocks',market]`,
  `['connectors','gmail','status']`. The trailing `market` makes `us`/`in` separate cache entries.
- **`refetchInterval` is aligned to the backend cache TTL, never faster** — crypto 30s → research 30min
  ([`hooks/use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts)). Polling faster just returns identical
  bytes and burns rate-limited provider quota.
- **Live prices merge via `setQueryData`, not refetch** — `useLivePrices`
  ([`hooks/use-live-prices.ts`](../../../../frontend/src/hooks/use-live-prices.ts)) buffers Supabase broadcast
  ticks in a `useRef` Map (no render) and a 250ms `setInterval` flush patches only `price` into the cached
  `['finance','stocks','us']` / `['finance','crypto']` entries. This is the canonical "polling sets the baseline,
  push patches it" + transient-update pattern (see `zustand-advanced-patterns.md` §4 and
  `react-best-practices-vercel.md` re-render rules).
- **Mutations invalidate** — connectors use `useMutation` + `invalidateQueries(GMAIL_STATUS_KEY)`
  ([`hooks/use-connectors.ts`](../../../../frontend/src/hooks/use-connectors.ts)). Mirror this pattern for new
  server-state writes.

### ⚠️ Known anti-pattern to fix: the conversation-history list

The sidebar history is the **odd one out** — it's raw `useState` + manual `fetchConversations()` +
full re-download, NOT TanStack Query ([`Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx) `conversations`
state + `refreshConversations`). Consequences: no cache across mounts, and it **re-fetches the whole list on every
browser-tab refocus** because `onAuthStateChange` calls `setUser(session.user)` (a new object reference each
event) and the load-history `useEffect` depends on the `user` object. The fix: move it to
`useQuery(['conversations'])` + optimistic `useMutation` for rename/delete (kills the refocus refetch and the
full re-download); stopgap is to depend on `user?.id` not `user`. See `data-fetching-tanstack-query.md`. The
streaming chat **answer** legitimately can't be `useQuery` (it's a `ReadableStream`), but the **list** is a plain
GET — textbook `useQuery`.

---

## Hooks / re-render conventions (the `useCallback` + refs pattern)

Lumina's `Dashboard` is the reference example of **stabilize-then-include**, not "omit deps":

- **`useCallback` is load-bearing where a function feeds another hook's dependency array.** `refreshConversations`
  is `useCallback(…, [])` so the load-history effect and `runTurn` don't re-run/recreate every render; `runTurn`
  is `useCallback(…, [refreshConversations])` so `handleAsk`/`handleFollowUp` stay stable. Without this you'd get
  **refetch-on-every-render**. (`Dashboard.tsx`.)
- **Refs mirror state for async callbacks.** `convIdRef`/`modelRef`/`sectionRef` mirror `conversationId`/`model`/
  `section` via tiny effects so the long-lived stream `onChunk` closure reads the *live* value at send-time while
  `runTurn` keeps a tiny dep array — the textbook **stale-closure avoidance** + **transient ref** pattern.
- **Don't fix a re-run by deleting a needed dep** (stale-closure risk). Either stabilize the dep (`useCallback`/
  `useMemo`/state setters, which React guarantees stable) or depend on a **primitive** (`user?.id`) instead of an
  object.

### useCallback vs useMemo vs neither (Lumina rules)

| Use | When |
|---|---|
| `useCallback(fn, deps)` | The function is **passed to a memoized child** OR **used in another hook's dep array**. (Lumina's reason it exists.) |
| `useMemo(() => …, deps)` | The computation is **genuinely expensive** AND deps change rarely, OR you need a **stable object/array reference** for a dep array / memoized child. |
| **Neither** | Trivial expressions (`a + b`), primitives, cheap maps over small arrays. Memo overhead can exceed the work (`rerender-simple-expression-in-memo`). |

Lumina does **not** use the React Compiler today, so manual memoization still matters. If it's ever enabled,
manual `memo`/`useMemo`/`useCallback` become largely unnecessary (`react-best-practices-vercel.md`).

---

## Design-system / TS conventions

- **`cn()` = `twMerge(clsx(...))`** ([`lib/utils.ts`](../../../../frontend/src/lib/utils.ts)) — every primitive ends
  `cn(base, className)` so caller classes win Tailwind conflicts. Variants via **class-variance-authority**; derive
  prop types with `VariantProps<typeof xVariants>`.
- **No `any` in props**; prefer discriminated unions over boolean-flag soup; check `isLoading`/`isError` before
  `data` (see `react-typescript-patterns.md` Non-Negotiables, `typescript-advanced.md` for the type system).
- **Brand rule:** never write "Perplexity" in user-visible text — the app is **Lumina**.

---

## Scale notes (R-SCALE, list surfaces)

- Bounded top-N finance feeds (indices/sectors/top coins) are correctly un-paginated.
- **Unbounded per-user lists** — the conversation sidebar — need `useInfiniteQuery` + cursor + virtualization
  before they grow. This is the headline Tier-1 → Tier-2 item.
- The streaming render path re-parses all turns per chunk (~O(N²) for long answers); memoize/freeze parse per
  finished turn and rAF-throttle if it janks.