# Data Fetching — TanStack Query (client) + async patterns

> Generic TanStack Query v5 patterns for a Vite SPA. For **how Lumina actually wires this**
> (query keys, `refetchInterval` aligned to backend TTL, the live-price `setQueryData` merge,
> the conversation-list caveat) see [`lumina-react-conventions.md`](lumina-react-conventions.md)
> and the `lumina-frontend` skill's `tanstack-query-patterns.md`. This doc is the reusable theory.

---

## The one rule: server state ≠ component state

Data that lives on a server and is *cached* in the client is **server state**. Don't manage it with
`useState` + `useEffect` + `fetch` — you'll reimplement caching, dedup, retries, stale-while-revalidate,
and focus refetch badly. Use TanStack Query (or SWR). Keep `useState` for **local UI state** only
(open/closed, input text, selected tab).

```ts
// ❌ hand-rolled server state — no cache, no dedup, refetches on every mount, races on unmount
const [data, setData] = useState();
useEffect(() => { fetch(url).then(r => r.json()).then(setData); }, [url]);

// ✅ TanStack Query — cache, dedup, retry, SWR, cancellation for free
const { data, isLoading, isError } = useQuery({ queryKey: ['thing', id], queryFn: () => fetchThing(id) });
```

---

## Query keys

- A query is identified by its **serialized key**. Same key across components → **one** in-flight request
  (automatic dedup) and **one** cache entry shared by all of them.
- Use a **hierarchy**: `[domain, resource, ...params]` — e.g. `['finance','stocks',market]`. Every parameter
  the `queryFn` depends on **must** be in the key, or the cache will serve the wrong variant.
- Putting a param in the key creates **separate coexisting cache entries** (e.g. `'us'` vs `'in'`), so toggling
  back is instant from cache.

## staleTime vs gcTime (the two timers people confuse)

- **`staleTime`** — how long fetched data is considered *fresh*. While fresh, a newly mounting component reads
  cache without refetching. Default `0` (always stale → refetches on mount/focus).
- **`gcTime`** (was `cacheTime`) — how long an *unused* (no mounted observers) cache entry survives before garbage
  collection. Default 5 min.
- **`refetchInterval`** — a **client-side** background poll timer (runs in the browser, re-calls `queryFn`).
  Set it to how often the data can actually change; never faster than the backend's own cache TTL.
- **`refetchOnWindowFocus`** — refetch when the tab regains focus. Often disabled for gently-polled data.

## Mutations + cache updates

Don't refetch the whole list after a write — patch the cache optimistically:

```ts
const qc = useQueryClient();
useMutation({
  mutationFn: renameThing,
  onMutate: async ({ id, title }) => {
    await qc.cancelQueries({ queryKey: ['things'] });        // stop in-flight refetch clobbering us
    const previous = qc.getQueryData(['things']);
    qc.setQueryData(['things'], (l = []) => l.map(t => t.id === id ? { ...t, title } : t)); // optimistic
    return { previous };
  },
  onError: (_e, _v, ctx) => qc.setQueryData(['things'], ctx?.previous), // rollback
  onSettled: () => qc.invalidateQueries({ queryKey: ['things'] }),      // reconcile
});
```

- `invalidateQueries` marks data stale → triggers a refetch. Use for "something changed, re-pull."
- `setQueryData` writes the cache **in place, no network** — use to merge a known change (or a live
  push/websocket tick) without a spinner.

## Pagination for unbounded lists

A list that grows per-user (chat history, feeds) should not be one giant fetch. Use `useInfiniteQuery`:

```ts
useInfiniteQuery({
  queryKey: ['conversations'],
  queryFn: ({ pageParam }) => fetchConversations({ cursor: pageParam }),
  initialPageParam: null,
  getNextPageParam: (last) => last.nextCursor,   // backend returns { items, nextCursor }
});
```
Combine with row **virtualization** (`@tanstack/react-virtual`) so only visible rows mount.

---

## Async pitfalls (apply inside `queryFn` and any raw effect)

- **Parallelize independent requests** with `Promise.all`; for partial deps, start each promise as soon as its
  input resolves (avoid waterfalls — see `react-best-practices-vercel.md`).
- **Cancel in-flight work**: TanStack passes an `AbortSignal` to `queryFn` (`({ signal }) => fetch(url,{signal})`).
  For raw effects, use `AbortController` and ignore `AbortError`, or a `let cancelled = false` guard in cleanup.
- **Always handle failure**: check `res.ok`, `try/catch` async, surface a typed error (a bare string makes a 429
  indistinguishable from a 500).
- **Render the states**: branch on `isLoading` / `isError` **before** touching `data`.

---

## When NOT to use TanStack Query

- One-shot imperative calls with no caching value (e.g. "send this email" — that's a `useMutation` at most, or a
  plain call). A **streaming** response (SSE / `ReadableStream`) is **not** request/response and can't be a
  `useQuery` — drive it with local state (Lumina's chat stream does this). But a plain GET list **is** a
  textbook `useQuery`.