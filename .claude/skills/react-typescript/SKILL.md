---
name: react-typescript
description: >
  React 19 + TypeScript 5 + modern JavaScript expert for Lumina's Vite SPA. Covers writing
  components, client data fetching (TanStack Query), re-render & performance optimization,
  bundle-size/load-time, refactoring, hooks (useCallback/useMemo/refs), keys & lists, the
  TS type system, async patterns, state management (Zustand vs Context vs TanStack — documented),
  and testing. Generic React/TS craft that sits UNDER lumina-frontend (which owns the app shell,
  chat-stream rendering, and design system). Use whenever the task is "how should this React/TS
  code be written/fixed/optimized" rather than a Lumina-specific feature wiring question.
metadata:
  priority: 50
  sessionStart: false
  pathPatterns:
    - 'frontend/src/**'
    - 'frontend/src/components/**'
    - 'frontend/src/hooks/**'
    - 'frontend/src/pages/**'
    - 'frontend/src/lib/**'
  promptSignals:
    phrases:
      - 'react component'
      - 'useEffect'
      - 'useCallback'
      - 'useMemo'
      - 're-render'
      - 'performance'
      - 'bundle size'
      - 'code splitting'
      - 'typescript type'
      - 'discriminated union'
      - 'generic type'
      - 'zustand'
      - 'state management'
      - 'data fetching'
      - 'react 19'
      - 'custom hook'
      - 'refactor'
    minScore: 3
---

# react-typescript

> The generic **React 19 + TypeScript + modern JS** craft layer for Lumina. This skill answers
> *"how should this component/hook/type/async-code be written, fixed, or optimized?"* — independent of
> any one feature. It sits **under** [`lumina-frontend`](../lumina-frontend/SKILL.md): that skill owns the
> SPA shell, the chat-stream rendering, the API client, and the design system; **this** skill owns the
> reusable patterns those are built from. Imported and adapted from the rareLab `react-typescript` skill
> and Jeffallan's `react-expert`, enriched with Vercel Labs' `react-best-practices`, and tailored to a
> **Vite SPA** (no RSC/Next.js).

---

## Domain Identity

**This skill OWNS (generic craft):**
- Writing components: composition, compound/polymorphic patterns, controlled/uncontrolled, typed props.
- Hooks: `useCallback`/`useMemo`/`useRef` decisions, custom hooks, effect cleanup, stale-closure avoidance.
- Re-render & runtime performance, bundle size / load time, profiling, refactoring smells → fixes.
- Client **data fetching** with TanStack Query; async patterns (waterfalls, cancellation, combinators).
- The **TypeScript type system** (generics, conditional/mapped/template-literal types, discriminated unions).
- **State-management choice** (TanStack Query vs Context vs `useState`/refs vs Zustand) and Zustand patterns.
- React 19 features (ref-as-prop, `use()`, actions) and testing.

**This skill does NOT own (route elsewhere):**
- The Lumina **app shell, routing, chat-stream rendering, design-system components, Supabase auth** →
  [`lumina-frontend`](../lumina-frontend/SKILL.md). This skill is the patterns layer beneath it.
- The **backend / SSE producer / tools / persona** → `ai-sdk-agent`. Each vertical's view internals →
  `finance-markets` / discover skills.
- **RSC / App Router / Server Actions / Next.js** — N/A: Lumina is a Vite SPA. The imported references that
  discuss these are flagged; ignore those sections.

---

## Decision Tree

```
React / TS / JS task arrives
|
+-- "How do I write/structure this component?" ----------> react-typescript-patterns.md + hooks-patterns.md
+-- "Fetch/cache data on the client" --------------------> data-fetching-tanstack-query.md + lumina-react-conventions.md
+-- "Why is this re-rendering / how do I speed it up?" ---> react-best-practices-vercel.md + performance.md
+-- "useCallback vs useMemo vs neither? React Compiler?" -> lumina-react-conventions.md (table) + react-best-practices-vercel.md
+-- "Shrink the bundle / improve load time" -------------> react-best-practices-vercel.md (bundle) + javascript-modern.md
+-- "Refactor this older/messy React code" --------------> react-best-practices-vercel.md (smells) + migration-class-to-modern.md
+-- "Keys / list rendering correctness, virtualization" -> hooks-patterns.md + react-typescript-patterns.md
+-- "Async/await, promises, avoiding waterfalls" --------> react-best-practices-vercel.md (§1) + javascript-modern.md
+-- "Advanced TypeScript types" -------------------------> typescript-advanced.md
+-- "React 19 specifics (use(), actions, ref-as-prop)" --> react-19-features.md
+-- "State management choice / Zustand patterns" --------> lumina-react-conventions.md + state-management.md + zustand-advanced-patterns.md
+-- "Testing a component/hook" --------------------------> testing-react.md
+-- "How does LUMINA already do this?" ------------------> lumina-react-conventions.md  (start here when in doubt)
+-- (RSC / Next.js / Server Components) -----------------> server-components.md  (reference-only — N/A to this SPA)
```

---

## Non-Negotiables

| # | Rule | Why |
|---|------|-----|
| 1 | **Lumina is a Vite SPA — no RSC/Next.js.** Ignore Server Components / App Router / Server Actions sections in the references. | The "server" is the separate Bun backend the client `fetch`es; there is no React server layer. |
| 2 | **Server state lives in TanStack Query, not `useState`+`useEffect`+`fetch`.** Local UI state uses `useState`/refs; cross-tree UI state uses Context. | Hand-rolled fetching reimplements cache/dedup/retry/SWR badly (see the conversation-list anti-pattern in `lumina-react-conventions.md`). |
| 3 | **Stabilize-then-include, never delete a needed dep.** A function used in a dep array or passed to a memoized child gets `useCallback`; values read in async callbacks go through refs. Depend on primitives (`user?.id`) not objects. | Deleting deps causes stale closures; unstable deps cause refetch/recreate-every-render. |
| 4 | **Measure before optimizing.** Profile (React DevTools) to find the real wasted render before adding `memo`/`useMemo`. Don't memoize trivial expressions. | Memo overhead can exceed the work it guards. |
| 5 | **Eliminate waterfalls.** Independent async runs in parallel (`Promise.all`); start promises early, await late. | Waterfalls are the #1 perf killer (Vercel). |
| 6 | **No `any` in props; discriminate before access.** Explicit unions/generics/`unknown`; check `isLoading`/`isError` before `data`. | Type safety + correct loading states. |
| 7 | **Immutable updates + hooks rules + cleanup.** New objects/arrays; hooks at top level only; clear timers/subscriptions/AbortControllers. | Correctness and no leaks. |
| 8 | **Stable keys for lists — never the array index for dynamic lists.** | Index keys corrupt state/identity on reorder/insert/delete. |

---

## Anti-Patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| `useState` + `useEffect` + `fetch` for server data | `useQuery` (cache, dedup, SWR) — `data-fetching-tanstack-query.md` |
| Defining a component inside another component | Hoist it out + pass props (new type each render = remount + state loss) |
| Deriving state into `useState` via an effect | Compute it inline during render |
| Re-downloading a whole list after a mutation | Optimistic `setQueryData` patch + `invalidateQueries` on settled |
| `useMemo(() => a + b, [a, b])` / memoizing everything | Memo only expensive work or stable refs for memoized children |
| Deleting a dep from the array to "stop the loop" | Stabilize the dep (`useCallback`) or depend on a primitive |
| Barrel-importing a big lib (`lucide-react`) blindly | Deep imports / `optimizePackageImports`; `lazy()` heavy components |
| Array index as `key` in a dynamic list | Stable unique id |
| `any` props / boolean-flag soup | Generics + discriminated unions |
| Writing "Perplexity" in user-visible text | Brand is **Lumina** |

---

## Output Contract (what "done" looks like)

1. **Right state bucket:** server state in TanStack Query, local in `useState`/refs, cross-tree in Context (Zustand only if genuinely global — documented, not yet adopted).
2. **Stable & profiled:** no refetch/recreate-every-render; memoization only where a profile or a memoized-child/dep-array need justifies it.
3. **Typed:** no `any` in props; discriminated unions over flags; loading/error branches before `data`.
4. **No waterfalls / leaks:** independent async parallelized; effects/requests cancel on unmount.
5. **SPA-correct:** no RSC/Next.js assumptions; bundle-aware imports.
6. **Consistent with Lumina:** matches the conventions in `lumina-react-conventions.md`; defers shell/stream/design-system specifics to `lumina-frontend`.

---

## Bundled References (14 files) — read the one or two the task needs

| File | Load when | Source |
|------|-----------|--------|
| `lumina-react-conventions.md` | **Start here when unsure.** How Lumina actually does state/fetching/hooks (cites `file:line`); the state-management decision; the useCallback/useMemo table; the conversation-list anti-pattern. | Lumina |
| `react-best-practices-vercel.md` | Performance work of any kind: waterfalls, bundle size, re-render rules, JS hot-paths, the React Compiler caveat. Impact-ordered. | Vercel Labs |
| `data-fetching-tanstack-query.md` | Client data fetching: query keys, staleTime vs gcTime, mutations + optimistic updates, `useInfiniteQuery` pagination, async cancellation. | Lumina/generic |
| `react-typescript-patterns.md` | Comprehensive deep-dive: advanced component patterns, concurrent React, hooks architecture, TS-for-React, the Non-Negotiables/Anti-Patterns spine. **(Next.js sections flagged — ignore.)** | rareLab |
| `typescript-advanced.md` | The TS type system: generics, conditional/mapped/template-literal types, narrowing, utility types, builder/factory/Result patterns, strict tsconfig. | rareLab |
| `javascript-modern.md` | Modern JS + async: Promise combinators, retry/backoff, concurrency limiter, event-loop non-blocking, ES2022+ syntax, modules/tree-shaking, browser APIs. | rareLab |
| `performance.md` | Quick-ref: `React.memo`, stable refs, `useTransition`, virtualization, debouncing. | Jeffallan |
| `hooks-patterns.md` | Quick-ref: custom hooks, effect cleanup, AbortController, useCallback/useMemo discipline, keys. | Jeffallan |
| `react-19-features.md` | React 19: ref-as-prop (no forwardRef), `use()`, `useActionState`/`useFormStatus`/`useOptimistic`. | Jeffallan |
| `state-management.md` | State options overview incl. Context, Redux, Zustand, and TanStack Query loading/error/invalidation. | Jeffallan |
| `migration-class-to-modern.md` | Refactoring: class→hooks migration map, HOC/render-props → custom hooks, "don't refactor stable code." | Jeffallan |
| `testing-react.md` | Testing components/hooks (Testing Library patterns). | Jeffallan |
| `zustand-advanced-patterns.md` | Only if adopting Zustand: store architecture, middleware order, persist pitfalls, transient/high-frequency updates, selectors. Documented, not yet used. | rareLab (R3F scrubbed) |
| `server-components.md` | **Reference-only / N/A** — RSC mental model for the day Lumina adds SSR/Next.js. | Jeffallan |

---

## Cross-skill routing & prior art

- **lumina-frontend** owns the SPA shell, chat-stream rendering, design system, and Supabase auth — this skill is
  the React/TS patterns beneath it. When a task is "wire up a Lumina feature," start there; when it's "write this
  React/TS code well," start here.
- **ai-sdk-agent** owns the backend stream/tools; **finance-markets** + discover skills own vertical view internals.
- Origin: rareLab `react-typescript` (`E:\Development\Portfolio-phase2\Akshay-pooja\rare-lab\.claude\skills\react-typescript`)
  and Jeffallan `react-expert` (github.com/Jeffallan/claude-skills). Recoil and React-Three-Fiber content was
  dropped as irrelevant to a 2D web app.