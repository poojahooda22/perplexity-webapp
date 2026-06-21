# React Best Practices (Vercel-derived, impact-ordered)

> Distilled from Vercel Labs' `react-best-practices` skill (github.com/vercel-labs/agent-skills,
> v1.0.0, originally @shuding) plus the React docs. Rules are ordered by **performance impact** —
> the order Vercel emphasizes. Each rule notes the original rule id for traceability.
>
> **Lumina framing:** Lumina is a **Vite SPA** — the "Server-Side" tier below is N/A today
> (no RSC/Next.js). The async-waterfall, bundle, re-render, and JS-perf tiers all apply directly.
> Lumina uses **TanStack Query** where Vercel says SWR — same dedup/cache principle.

---

## Impact priority (memorize this order)

1. **Eliminating waterfalls** — *the #1 performance killer.* (CRITICAL)
2. **Bundle size** — what you ship before anything runs. (CRITICAL)
3. **Server-side fetching** — N/A for Lumina's SPA (Bun backend only).
4. **Client data fetching** — dedup/cache, don't hand-roll.
5. **Re-render optimization.**
6. **Rendering correctness.**
7. **JavaScript micro-perf** (hot paths only).
8. **Advanced.**

> Two gaps in the Vercel skill, filled from Jeffallan/rare-lab: it has **no "keys in lists" rule**
> and **no explicit "profile/measure first" instruction.** See `performance.md` + `react-typescript-patterns.md`.

---

## 1. Eliminating waterfalls (CRITICAL)

A waterfall = request B can't start until request A finishes, for no real reason. Each hop adds a full
round-trip. Fix by starting independent work in parallel.

- **`Promise.all` for independent async** (`async-parallel`) — 2–10× faster than sequential `await`s.
  ```ts
  // ❌ sequential waterfall
  const user = await getUser(id);
  const posts = await getPosts(id);
  // ✅ parallel
  const [user, posts] = await Promise.all([getUser(id), getPosts(id)]);
  ```
- **Partial dependencies** (`async-dependencies`) — fire each request the moment *its* input is ready;
  don't wait on the whole batch. Start the promise, await it only where consumed.
- **Check the cheap sync condition BEFORE awaiting** (`async-cheap-condition-before-await`) — e.g. validate
  a param / read a cache synchronously and bail before paying for a network hop.
- **Defer the `await` into the branch that needs it** (`async-defer-await`) — kick off the promise early,
  `await` only inside the code path that actually uses the value.
- **Suspense only around the data subtree** (`async-suspense-boundaries`) — keep the page shell synchronous;
  wrap just the part that suspends so the rest paints immediately.

---

## 2. Bundle size (CRITICAL)

- **Barrel imports are the silent killer** (`bundle-barrel-imports`) — `import { X } from 'big-lib'` can pull
  the whole package. Example: `lucide-react` barrel = **1,583 modules**. Fix with deep imports
  (`import Icon from 'lucide-react/dist/esm/icons/x'`) or a bundler `optimizePackageImports`.
  *(Lumina uses `lucide-react` heavily — verify icons tree-shake.)*
- **Dynamic-import heavy components** (`bundle-dynamic-imports`) — `const Chart = lazy(() => import('./Chart'))`
  for anything large/below-the-fold (charts, editors, the TradingView widget).
- **Keep import paths statically analyzable** (`bundle-analyzable-paths`) — `{ home: () => import('./home') }`,
  **never** `import(stringVariable)` — the bundler can't split what it can't see.
- **Preload on intent** (`bundle-preload`) — `onMouseEnter={() => void import('./Heavy')}` to warm the chunk
  before the click.
- Guard browser-only dynamic imports with `typeof window !== 'undefined'`.
- ESM + `"sideEffects": false` in `package.json` enables tree-shaking.

---

## 4. Client data fetching

- **Use a cache/dedup library** (`client-swr-dedup`) — Vercel says SWR; **Lumina uses TanStack Query**.
  Either way: dedup in-flight requests, cache, revalidate. **Never** hand-roll `useState + useEffect + fetch`
  for server state. See `data-fetching-tanstack-query.md`.

---

## 5. Re-render optimization

- **Never define a component inside another component** (`rerender-no-inline-components`) — *highest-impact
  re-render bug.* A new component **type** each render → React unmounts + remounts the subtree, losing all its
  state. Hoist it out and pass props.
- **Derived state: compute in render, no effect** (`rerender-derived-state-no-effect`) —
  ```ts
  // ❌ const [full, setFull] = useState(''); useEffect(() => setFull(`${a} ${b}`), [a,b]);
  // ✅ const full = `${a} ${b}`;
  ```
- **Move flag-gated effects into the event handler** (`rerender-move-effect-to-event`) — if an effect only runs
  in response to a user action, it belongs in the handler, not a `useEffect` watching a flag.
- **Split combined hooks** (`rerender-split-combined-hooks`) — one mega-hook returning everything re-renders
  all consumers; split by independent concern.
- **`useRef` for transient values** (`rerender-use-ref-transient-values`) — values that change a lot but don't
  need to paint (scroll pos, live buffers) go in a ref → no render. *(This is exactly Lumina's `useLivePrices`
  buffer + `convIdRef`/`modelRef` pattern.)*
- **Functional setState → stable empty-dep `useCallback`** (`rerender-functional-setstate`) — `setX(prev => …)`
  needs no deps, so the callback can be `useCallback(fn, [])` and stay referentially stable.
- **Lazy state init must be a function** (`rerender-lazy-state-init`) — `useState(() => expensiveInit())`, not
  `useState(expensiveInit())` (the latter runs every render).
- **`useDeferredValue` / `startTransition`** for non-urgent updates (keep typing responsive while a heavy list
  re-renders).

---

## 6 & 8. Memoization & the React Compiler (read this before reaching for `useMemo`)

- **If React Compiler is enabled, manual `memo()`/`useMemo`/`useCallback` are unnecessary** (`rerender-memo`,
  verbatim) — *"The compiler automatically optimizes re-renders."* Check whether the project uses it before
  hand-memoizing. *(Lumina does not use the compiler today, so manual memoization still matters.)*
- **Don't wrap trivial expressions in `useMemo`** (`rerender-simple-expression-in-memo`) — *"calling useMemo and
  comparing hook dependencies may consume more resources than the expression itself."* Memo is for genuinely
  expensive work or stable references passed to memoized children — not `useMemo(() => a + b, [a,b])`.

---

## 7. JavaScript micro-perf (hot paths only — profile first)

- **Index Maps over `.find()`-inside-`.map()`** (`js-index-maps`) — O(n²) → O(n). Build a `Map` once, look up
  by key. (1M ops → ~2K in Vercel's example.)
- **`Set`/`Map` for O(1) membership** instead of `array.includes` in a loop.
- **Batch DOM reads then writes** — interleaving forces synchronous layout (layout thrash).
- **Immutable array ops**: `toSorted`/`toReversed`/`with` (don't mutate props/state with `.sort()`).
- **`flatMap`** to fuse a `.map().filter()`; combine multiple iterations into one pass.
- **Cache repeated reads** — property lookups, `.length`, `localStorage` reads inside loops.
- **Hoist `RegExp`** out of hot functions (compiling a regex per call is wasteful).
- **`requestIdleCallback`** for non-critical background work; **chunk + yield** or a **Web Worker** for
  long compute so you don't block the event loop.

---

## Quick smell → fix table

| Smell | Fix | Rule |
|---|---|---|
| `useState` + `useEffect` to derive a value | Compute inline in render | `rerender-derived-state-no-effect` |
| Component declared inside a component | Hoist it out | `rerender-no-inline-components` |
| Sequential `await`s on independent data | `Promise.all` | `async-parallel` |
| `import { x } from 'lucide-react'` blowing up the bundle | Deep import / `optimizePackageImports` | `bundle-barrel-imports` |
| `useMemo(() => a + b, [a,b])` | Just `a + b` | `rerender-simple-expression-in-memo` |
| `.find()` inside `.map()` | Build an index `Map` | `js-index-maps` |
| `arr.sort()` on a prop | `arr.toSorted()` | — |
| Heavy component always bundled | `lazy(() => import())` + Suspense | `bundle-dynamic-imports` |