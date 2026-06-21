# React + TypeScript Patterns

> ⚠️ **Lumina context:** Lumina is a **Vite SPA** (client-rendered, `react-router` —
> see [`lumina-react-conventions.md`](lumina-react-conventions.md)). This doc bundles a
> Next.js-oriented source, so **ignore every React Server Components / App Router /
> Server Actions / `use server` / streaming-SSR / Next.js-config section.** Everything
> else — hooks, concurrent React, TS-for-React, performance, advanced component
> patterns, and the Non-Negotiables / Anti-Patterns tables — applies directly.

---

## Source: SKILL.md

---
name: react-typescript
description: >
  Deep expertise in React 18+ and TypeScript 5+ for production-grade web
  applications. Covers advanced component patterns (compound, render props,
  polymorphic), TypeScript type-system mastery (generics, conditional types,
  mapped types, template literal types, discriminated unions), React performance
  optimization (memo, useMemo, useCallback, virtualization, code splitting),
  concurrent React (useTransition, useDeferredValue, Suspense), React Server
  Components (RSC), state management architecture (Zustand, Context, signals),
  hooks composition, error boundaries, and testing strategies with TypeScript.
  Invoke for: building type-safe React components, designing component APIs,
  typing complex props/state/context, performance profiling and optimization,
  implementing concurrent UI patterns, writing custom hooks, designing state
  management, React+TypeScript integration patterns, RSC/streaming architecture,
  and any task combining React with strict TypeScript in the Rare.lab platform.
  Also invoke when the user mentions "React types", "TypeScript component",
  "generic component", "strict typing", "performance optimization", "useTransition",
  "Server Component", "RSC", "code splitting", "React.memo", or "hooks pattern".
argument-hint: "[react-task|typescript-task|performance|hooks|rsc] [description]"
---

# React 18+ / TypeScript 5+ — Production Mastery Skill
> Deep expertise in type-safe React development, concurrent rendering, advanced TypeScript patterns, and performance engineering for the Rare.lab platform

---

## Project Identity

| Key | Value |
|---|---|
| **React** | 18.x+ (Concurrent features enabled via `createRoot`) |
| **TypeScript** | 5.x (`strict: true`, `noUncheckedIndexedAccess: true`) |
| **Framework** | Next.js 14+ (App Router, RSC default) |
| **State** | Zustand 4.x (global), React Context (scoped), `useState`/`useReducer` (local) |
| **Styling** | TailwindCSS + CSS Modules (token bridge) |
| **Testing** | Vitest + React Testing Library + `@testing-library/user-event` |
| **Linting** | ESLint + `@typescript-eslint/strict` + Prettier |
| **Bundler** | Next.js (Turbopack dev, Webpack prod) / Vite (Storybook) |
| **Package Manager** | npm (lockfile committed) |

---

## Prerequisites Map

```
JavaScript ES2022+  →  TypeScript basics  →  React fundamentals
        ↓                      ↓                      ↓
Promises/async      →  Generics & utility  →  JSX & component
                         types                  lifecycle
        ↓                      ↓                      ↓
Module system       →  Advanced type       →  Hooks (useState,
(ESM, dynamic           patterns               useEffect, useRef)
 import)
        ↓                      ↓                      ↓
             REACT + TYPESCRIPT PRODUCTION MASTERY
```

---

## Decision Tree

```
New React/TypeScript task arrives
│
├── Component API design / props typing?
│   └── → READ: typescript-react-patterns.md
│       ├── Polymorphic component? → §Polymorphic Components
│       ├── Compound component? → §Compound Components
│       ├── Generic component? → §Generic Components
│       └── Discriminated union props? → §Discriminated Unions
│
├── TypeScript type-system question?
│   └── → READ: typescript-type-system.md
│       ├── Conditional types / infer → §Conditional Types
│       ├── Mapped types / key remapping → §Mapped Types
│       ├── Template literal types → §Template Literal Types
│       ├── Type narrowing / guards → §Type Narrowing
│       └── Utility types / custom → §Utility Types
│
├── Advanced React pattern needed?
│   └── → READ: react-patterns-advanced.md
│       ├── HOCs → §Higher-Order Components
│       ├── Render props → §Render Props
│       ├── Controlled vs uncontrolled → §Controlled Components
│       └── Provider pattern → §Provider Pattern
│
├── Performance problem or optimization?
│   └── → READ: performance-optimization.md
│       ├── Re-render diagnosis → §Profiling Re-renders
│       ├── Memoization (memo/useMemo/useCallback) → §Memoization
│       ├── Virtualization (large lists) → §Virtualization
│       ├── Code splitting / lazy loading → §Code Splitting
│       └── Bundle size analysis → §Bundle Analysis
│
├── Custom hooks?
│   └── → READ: hooks-architecture.md
│       ├── Composition patterns → §Hook Composition
│       ├── Rules & constraints → §Rules of Hooks
│       ├── Data fetching hooks → §Data Fetching
│       └── Animation/timer hooks → §Animation Hooks
│
├── State management architecture?
│   └── → READ: state-management-patterns.md
│       ├── When Zustand vs Context vs useState → §Decision Matrix
│       ├── Zustand patterns → §Zustand Deep Dive
│       ├── Context performance → §Context Optimization
│       └── URL state / form state → §Derived State
│
├── Concurrent React / transitions?
│   └── → READ: concurrent-react.md
│       ├── useTransition → §useTransition
│       ├── useDeferredValue → §useDeferredValue
│       ├── Suspense boundaries → §Suspense Architecture
│       └── Streaming SSR → §Streaming
│
├── React Server Components / RSC?
│   └── → READ: server-components.md
│       ├── Server vs Client boundary → §Component Boundary
│       ├── Data fetching in RSC → §Server Data Fetching
│       ├── Streaming + Suspense → §Streaming Patterns
│       └── Selective hydration → §Selective Hydration
│
├── Error handling?
│   └── → READ: error-handling-patterns.md
│       ├── Error boundaries → §Error Boundaries
│       ├── Async error handling → §Async Errors
│       └── Type-safe error modeling → §Discriminated Error Types
│
├── Testing?
│   └── → READ: testing-strategies.md
│       ├── Component testing → §Component Tests
│       ├── Hook testing → §Hook Tests
│       ├── Type testing → §Type Tests
│       └── Integration testing → §Integration Tests
│
├── Build tooling / bundler?
│   └── → READ: build-tooling.md
│       ├── Vite vs Webpack vs Turbopack → §Bundler Comparison
│       ├── tsconfig optimization → §TSConfig
│       ├── Tree-shaking → §Tree Shaking
│       └── Path aliases → §Path Aliases
│
└── React fundamentals / lifecycle?
    └── → READ: react-fundamentals-deep.md
        ├── Reconciliation / Fiber → §Fiber Architecture
        ├── Component lifecycle → §Lifecycle
        ├── Refs and DOM access → §Refs
        └── Portals → §Portals
```

---

## Non-Negotiables

| # | Rule | Why |
|---|---|---|
| 1 | **`strict: true`** in tsconfig — no exceptions | Catches null errors, implicit any, and index access bugs at compile time |
| 2 | **Never use `any`** — use `unknown`, generics, or explicit types | `any` disables the entire type system, defeating the purpose of TypeScript |
| 3 | **Explicit return types** on exported functions and hooks | Prevents accidental type widening and serves as living documentation |
| 4 | **`React.memo` only after profiling** — never premature | Memo has overhead; blind memoization can degrade performance |
| 5 | **No `setState` in render path** — causes infinite loops | React calls render, setState triggers re-render → infinite cycle |
| 6 | **Hooks at top level only** — never inside conditions/loops | Violating Rules of Hooks breaks React's internal linked list |
| 7 | **`useEffect` cleanup always** — prevent memory leaks | Subscriptions, timers, and listeners must be torn down |
| 8 | **Server Components by default** — `"use client"` only when needed | Minimizes client JS bundle; RSC is the Next.js default |
| 9 | **Discriminated unions for variant props** — not boolean flags | `type: "primary" \| "secondary"` is safer than `isPrimary?: boolean` |
| 10 | **Immutable state updates** — never mutate state directly | React's reconciliation depends on reference equality checks |

---

## Anti-Patterns

| Anti-Pattern | Problem | Correct Approach |
|---|---|---|
| `as any` or `@ts-ignore` | Silences real type errors, creates runtime crashes | Fix the type error properly; use `unknown` + narrowing |
| `useEffect` for derived state | Extra render cycle, stale data | Compute during render: `const derived = compute(state)` |
| Prop drilling 5+ levels deep | Unreadable, fragile component tree | Context for read-heavy, Zustand for write-heavy |
| `useCallback` on every function | Memory overhead, no measurable benefit | Only when passing to `React.memo`-wrapped children |
| Giant monolithic components | Impossible to test, optimize, or reuse | Extract logical sub-components and custom hooks |
| Index as key in dynamic lists | Corrupts component state on reorder/delete | Use stable unique ID (`crypto.randomUUID()` or DB id) |
| `useEffect(() => { fetch(...) })` | Runs every render, causes request storms | Add dependency array; use SWR/React Query for data |
| Inline object/array props | New reference every render, breaks memo | `useMemo` or extract to module-level constant |
| `export default` everywhere | Poor tree-shaking, ambiguous imports | Named exports: `export function MyComponent()` |
| Mixing Server and Client logic | Leaks secrets, breaks RSC boundary | Clear file separation; `"use client"` directive |

---

## Standard Workflow

### Step 0 — Intake
- What is the component's single responsibility?
- Server Component or Client Component?
- What props does it accept? Are there variant modes?
- Does it manage local state, or consume external state?
- Performance constraints (large lists, real-time updates)?

### Step 1 — Type Design First
- Define the props interface with JSDoc comments
- Use discriminated unions for variant behavior
- Add generic parameters if the component is data-agnostic
- Export the types alongside the component

### Step 2 — Component Implementation
- Start with the simplest working version
- Use custom hooks to extract stateful logic
- Apply `forwardRef` if DOM access is needed
- Keep render logic pure — no side effects

### Step 3 — Performance Review
- Profile with React DevTools Profiler
- Add `React.memo` only if profiling shows wasted renders
- Extract expensive computations to `useMemo`
- Stabilize callback references with `useCallback` where needed

### Step 4 — Error Handling
- Wrap async boundaries with Error Boundaries
- Use discriminated union return types for fallible operations
- Implement graceful degradation with Suspense fallbacks

### Step 5 — Testing
- Unit test with React Testing Library (user-centric)
- Test hook logic with `renderHook`
- Type-test complex generics with `expectTypeOf` (vitest)
- Integration test critical user flows

### Step 6 — Quality Gate
- [ ] `strict: true` passes with zero errors
- [ ] No `any` types in component or hook signatures
- [ ] Explicit return types on all exports
- [ ] React DevTools shows no unnecessary re-renders
- [ ] Error boundaries cover async operations
- [ ] Accessibility: proper ARIA, keyboard navigation
- [ ] Bundle impact assessed (no giant dependencies)

---

## Output Contract

When implementing a React + TypeScript task, deliver in this order:

1. **Type definitions** — interfaces, discriminated unions, generic constraints
2. **Custom hooks** — extracted stateful/effectful logic with explicit return types
3. **Component implementation** — pure render with typed props, forwardRef if needed
4. **Error handling** — boundaries, fallbacks, type-safe error modeling
5. **Usage example** — how to consume the component with correct types
6. **Test snippet** — at least one RTL test demonstrating the primary use case

---

## Bundled References

### Core React

| # | File | When to Load |
|---|------|---|
| 1 | `react-fundamentals-deep.md` | Fiber architecture, reconciliation algorithm, component lifecycle, refs, portals, strict mode, `createRoot` vs `render`, React 18 automatic batching |
| 2 | `react-patterns-advanced.md` | Higher-order components (typed), render props, compound components, controlled/uncontrolled, provider pattern, slot pattern, polymorphic components |
| 3 | `hooks-architecture.md` | Custom hook composition, Rules of Hooks, `useReducer` patterns, `useImperativeHandle`, `useSyncExternalStore`, data fetching hooks, animation hooks, ref-based hooks |
| 4 | `concurrent-react.md` | `useTransition`, `useDeferredValue`, Suspense boundaries, streaming SSR, concurrent mode opt-in, priority-based rendering, transition vs urgent updates |

### TypeScript Mastery

| # | File | When to Load |
|---|------|---|
| 5 | `typescript-type-system.md` | Conditional types with `infer`, mapped types with key remapping, template literal types, type narrowing (typeof, in, instanceof, custom guards), utility types (`Partial`, `Pick`, `Omit`, `Record`, `Extract`, `Exclude`), `satisfies` operator, variance annotations |
| 6 | `typescript-react-patterns.md` | Generic component props, discriminated union props, polymorphic `as` prop, `forwardRef` with generics, typed Context, typed event handlers, children typing (`ReactNode` vs `ReactElement`), strict ref typing |

### Performance

| # | File | When to Load |
|---|------|---|
| 7 | `performance-optimization.md` | React DevTools Profiler, `React.memo` / `useMemo` / `useCallback` (when to use and when NOT to), virtualization with `react-window`, code splitting with `React.lazy` + Suspense, bundle analysis, render waterfall diagnosis, Web Vitals (LCP, FID, CLS, INP) |

### Architecture

| # | File | When to Load |
|---|------|---|
| 8 | `state-management-patterns.md` | Zustand store design (slices, middleware, persist), Context API performance (split contexts, value memoization), `useReducer` for complex state, form state (react-hook-form), URL state, derived state patterns |
| 9 | `server-components.md` | RSC architecture in Next.js App Router, `"use client"` boundary rules, server-only data fetching, streaming with Suspense, selective hydration, `cache()` and `"use server"` actions, RSC payload format |
| 10 | `error-handling-patterns.md` | Error boundaries (class + typed), `ErrorBoundary` with fallback UI, async error handling, discriminated union error types (`Result<T, E>`), retry patterns, graceful degradation, Suspense error recovery |

### Quality & Tooling

| # | File | When to Load |
|---|------|---|
| 11 | `testing-strategies.md` | React Testing Library philosophy (test behavior, not implementation), `renderHook` for custom hooks, `userEvent` for interaction, type-level testing with `expectTypeOf`, MSW for API mocking, Storybook interaction tests, coverage strategies |
| 12 | `build-tooling.md` | `tsconfig.json` strict options, path aliases, Vite vs Webpack vs Turbopack comparison, tree-shaking requirements (named exports, `sideEffects: false`), `isolatedModules`, `moduleResolution: bundler`, source maps, declaration files |

---

## Source: build-tooling.md

# Build Tooling

> tsconfig strict options, path aliases, Vite vs Webpack vs Turbopack, tree-shaking, source maps, declarations

---

## tsconfig.json — Production Configuration

```jsonc
{
  "compilerOptions": {
    // --- Strictness (NON-NEGOTIABLE) ---
    "strict": true,                    // Enables ALL strict checks
    "noUncheckedIndexedAccess": true,  // array[i] returns T | undefined
    "noImplicitReturns": true,         // Every code path must return
    "noFallthroughCasesInSwitch": true,// Prevent switch case fall-through
    "forceConsistentCasingInFileNames": true, // Case-sensitive imports
    "exactOptionalPropertyTypes": true, // Distinguish undefined vs missing

    // --- Module Resolution ---
    "target": "ES2022",                // Modern JS output
    "module": "ESNext",                // ESM for tree-shaking
    "moduleResolution": "bundler",     // Modern bundler resolution
    "resolveJsonModule": true,         // Import JSON files
    "isolatedModules": true,           // Required for Vite/esbuild
    "esModuleInterop": true,           // CJS/ESM interop

    // --- JSX (for React) ---
    "jsx": "preserve",                 // Let bundler handle JSX transform
    "lib": ["DOM", "DOM.Iterable", "ES2022"],

    // --- Path Aliases ---
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@/components/*": ["./src/components/*"],
      "@/hooks/*": ["./src/hooks/*"],
      "@/lib/*": ["./src/lib/*"],
      "@/types/*": ["./src/types/*"]
    },

    // --- Output ---
    "declaration": true,               // Generate .d.ts files
    "declarationMap": true,            // Maps for .d.ts debugging
    "sourceMap": true,                 // Source maps for debugging
    "outDir": "./dist",
    "skipLibCheck": true,              // Skip node_modules type checking

    // --- Incremental ---
    "incremental": true,               // Cache compilation
    "tsBuildInfoFile": "./.tsbuildinfo"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.test.tsx"]
}
```

### Strict Options Explained

| Option | What It Catches | Example |
|---|---|---|
| `strictNullChecks` | Null/undefined access | `user.name` when user may be null |
| `noImplicitAny` | Untyped variables | `function fn(x) {}` → must type `x` |
| `strictFunctionTypes` | Unsafe function assignment | Covariant vs contravariant params |
| `noUncheckedIndexedAccess` | Array out-of-bounds | `arr[5]` returns `T \| undefined` |
| `exactOptionalPropertyTypes` | Missing vs undefined | `{ x?: string }` → x can't be `undefined` |

---

## Bundler Comparison

### Vite (Development + Storybook)

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(), // Resolve @/ path aliases
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'three-vendor': ['three', '@react-three/fiber'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom'], // Pre-bundle deps for fast dev
  },
});
```

**Vite advantages**: Instant HMR (~50ms), native ESM in dev (no bundling), Rollup for production.

### Webpack (Next.js Production)

Next.js uses Webpack for production builds with automatic optimization:

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
module.exports = {
  webpack: (config, { isServer }) => {
    // Custom webpack config
    if (!isServer) {
      config.resolve.fallback = {
        fs: false,
        path: false,
      };
    }
    return config;
  },
  experimental: {
    optimizePackageImports: ['lucide-react', '@radix-ui/react-icons'],
  },
};
```

### Turbopack (Next.js Development)

```bash
# Use Turbopack for faster dev server
next dev --turbopack
```

**Turbopack advantages**: Written in Rust, 10x faster than Webpack for large projects. Used only in development mode as of Next.js 14.

### Comparison Table

| Feature | Vite | Webpack | Turbopack |
|---|---|---|---|
| **Dev startup** | ~300ms | ~3s | ~500ms |
| **HMR speed** | ~50ms | ~200ms | ~50ms |
| **Production build** | Rollup | Webpack | N/A (dev only) |
| **Config complexity** | Low | High | Zero (Next.js manages) |
| **Tree-shaking** | Excellent | Good | Excellent |
| **Use for Rare.lab** | Storybook | Next.js prod | Next.js dev |

---

## Tree-Shaking Requirements

For tree-shaking to work, code MUST use ESM:

```typescript
// ✅ Tree-shakeable: Named exports + ESM
export function Button() { /* ... */ }
export function Input() { /* ... */ }
// Bundler can remove unused exports

// ❌ NOT tree-shakeable: Default export of object
export default {
  Button: () => { /* ... */ },
  Input: () => { /* ... */ },
};
// Bundler must include entire object

// ❌ NOT tree-shakeable: CommonJS
module.exports = { Button, Input };
// Entire module included
```

### package.json for Libraries

```json
{
  "name": "@rare/components",
  "sideEffects": false,
  "module": "dist/esm/index.js",
  "main": "dist/cjs/index.js",
  "types": "dist/types/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js",
      "types": "./dist/types/index.d.ts"
    },
    "./components/*": {
      "import": "./dist/esm/components/*/index.js",
      "types": "./dist/types/components/*/index.d.ts"
    }
  }
}
```

`"sideEffects": false` tells the bundler that any unused export can be safely removed. If you have CSS imports, list them:

```json
{
  "sideEffects": ["**/*.css", "**/*.global.js"]
}
```

---

## Path Aliases

### Next.js (tsconfig.json)

```jsonc
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

Next.js automatically resolves tsconfig paths. No additional config needed.

### Vite (requires plugin)

```bash
npm install vite-tsconfig-paths
```

```typescript
// vite.config.ts
import tsconfigPaths from 'vite-tsconfig-paths';
export default defineConfig({
  plugins: [tsconfigPaths()],
});
```

### Vitest

```typescript
// vitest.config.ts
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

---

## Source Maps Strategy

| Environment | Source Maps | Why |
|---|---|---|
| Development | `inline` | Fast, no separate files |
| Production (internal) | `source-map` | Full debugging with Sentry |
| Production (public) | `hidden-source-map` | Sentry access, no public exposure |
| Library build | `source-map` | Consumers need debugging |

```typescript
// next.config.js — Hide source maps from public
module.exports = {
  productionBrowserSourceMaps: false, // Don't expose to browser
  // But Sentry still gets them via upload
};
```

---

## Declaration Files (.d.ts)

For library components consumed by other packages:

```bash
# Generate declarations only (no JS output)
tsc --declaration --emitDeclarationOnly --outDir dist/types

# Or in tsconfig:
{
  "compilerOptions": {
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types"
  }
}
```

### Ambient Type Declarations

```typescript
// src/types/global.d.ts — Augment global types

// Extend Window
declare global {
  interface Window {
    __RARE_STORE__?: import('zustand').StoreApi<AppState>;
  }
}

// Module augmentation for CSS modules
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Raw shader imports (Vite)
declare module '*.vert?raw' {
  const content: string;
  export default content;
}
declare module '*.frag?raw' {
  const content: string;
  export default content;
}

export {}; // Make this a module
```

---

## Citations & Sources

1. **tsconfig Reference** — TypeScript official docs (typescriptlang.org/tsconfig). Complete option reference.
2. **Vite** — Evan You, vitejs.dev. Architecture and design philosophy.
3. **Turbopack** — Vercel, turbo.build/pack. Benchmark data comparing to Webpack.
4. **Tree-shaking** — Webpack docs, "Tree Shaking" (webpack.js.org/guides/tree-shaking). Requirements for dead code elimination.
5. **Module Resolution** — TypeScript 5.0 Release, `moduleResolution: "bundler"` (devblogs.microsoft.com/typescript). Modern resolution for bundler environments.

---

## Source: concurrent-react.md

# Concurrent React

> useTransition, useDeferredValue, Suspense boundaries, streaming SSR, priority-based rendering

---

## Concurrent Rendering Model

React 18's concurrent renderer makes rendering **interruptible**. Previously, once React started rendering, it had to finish the entire tree before yielding to the browser. Now React can:

1. **Pause** rendering mid-tree to handle urgent updates (user input)
2. **Resume** interrupted rendering later
3. **Abandon** rendering if the result is no longer needed
4. **Reuse** previously computed results

### Opting In

Concurrent features are opt-in per update, not a global mode:

```typescript
// createRoot enables concurrent features
import { createRoot } from 'react-dom/client';
const root = createRoot(document.getElementById('root')!);
root.render(<App />);
// All updates are now ELIGIBLE for concurrent rendering
// But only updates wrapped in startTransition are actually concurrent
```

---

## useTransition

Marks a state update as **non-urgent**, allowing React to interrupt it for urgent updates (like typing):

```typescript
import { useTransition } from 'react';

function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isPending, startTransition] = useTransition();

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    
    // URGENT: Update input immediately (user sees their typing)
    setQuery(value);
    
    // NON-URGENT: Filter/search can lag behind
    startTransition(() => {
      const filtered = performExpensiveSearch(value);
      setResults(filtered);
    });
  };

  return (
    <div>
      <input value={query} onChange={handleSearch} />
      {isPending && <Spinner />}
      <ResultList results={results} />
    </div>
  );
}
```

### Key Rules

1. `startTransition` function must be **synchronous** — no `await` inside
2. State updates after an `await` won't be marked as transitions
3. `isPending` is `true` while the transition renders in the background
4. If a new transition starts, the previous one is **abandoned**

### When to Use

| Scenario | Use useTransition? |
|---|---|
| Filtering a large list while typing | ✅ Yes |
| Tab switching with heavy content | ✅ Yes |
| Form input validation | ❌ No (should be instant) |
| Simple counter increment | ❌ No (no performance issue) |
| Navigation between routes | ✅ Yes (Next.js does this internally) |

---

## useDeferredValue

Creates a "laggy mirror" of a value. The deferred version updates with lower priority:

```typescript
import { useDeferredValue, useMemo } from 'react';

function SearchResults({ query }: { query: string }) {
  // deferredQuery lags behind query during heavy renders
  const deferredQuery = useDeferredValue(query);
  
  // isStale tells us if we're showing old data
  const isStale = query !== deferredQuery;
  
  // Expensive computation only re-runs when deferredQuery changes
  const results = useMemo(
    () => filterLargeDataset(deferredQuery),
    [deferredQuery]
  );

  return (
    <div style={{ opacity: isStale ? 0.6 : 1 }}>
      {results.map(r => <ResultCard key={r.id} result={r} />)}
    </div>
  );
}
```

### useTransition vs useDeferredValue

| Feature | `useTransition` | `useDeferredValue` |
|---|---|---|
| **Controls** | The state setter | The value |
| **Use when** | You own the setState call | Value comes from props/parent |
| **Returns** | `[isPending, startTransition]` | Deferred value |
| **Loading indicator** | Via `isPending` | Compare deferred vs current |

```typescript
// useTransition: You control the state update
const [isPending, startTransition] = useTransition();
startTransition(() => setSearchResults(filter(query)));

// useDeferredValue: Value comes from somewhere else
function Child({ query }: { query: string }) {
  const deferredQuery = useDeferredValue(query);
  // Render with deferredQuery (may lag behind)
}
```

---

## Suspense Architecture

Suspense lets components "wait" for something before rendering, showing a fallback in the meantime:

```typescript
import { Suspense, lazy } from 'react';

// 1. Code splitting with lazy
const HeavyChart = lazy(() => import('./HeavyChart'));

function Dashboard() {
  return (
    <div>
      <Header /> {/* Renders immediately */}
      
      <Suspense fallback={<ChartSkeleton />}>
        <HeavyChart /> {/* Shows skeleton until JS loads */}
      </Suspense>
      
      <Suspense fallback={<TableSkeleton />}>
        <DataTable /> {/* Independent loading boundary */}
      </Suspense>
    </div>
  );
}
```

### Nested Suspense Boundaries

Each Suspense boundary is independent. Outer boundaries catch any un-caught inner suspensions:

```typescript
function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}> {/* Outer catch-all */}
      <Sidebar />
      <Suspense fallback={<ContentSkeleton />}> {/* Inner boundary */}
        <MainContent />
        <Suspense fallback={<CommentsSkeleton />}> {/* Innermost */}
          <Comments />
        </Suspense>
      </Suspense>
    </Suspense>
  );
}

// Loading sequence:
// 1. FullPageSpinner (if Sidebar suspends)
// 2. Sidebar appears, ContentSkeleton shows
// 3. MainContent appears, CommentsSkeleton shows
// 4. Comments appear → fully loaded
```

### Suspense + Error Boundaries

Combine for complete async handling:

```typescript
import { ErrorBoundary } from 'react-error-boundary';

<ErrorBoundary fallback={<ErrorMessage />}>
  <Suspense fallback={<Loading />}>
    <AsyncComponent />
  </Suspense>
</ErrorBoundary>

// If AsyncComponent:
// - Is loading → shows <Loading />
// - Throws error → shows <ErrorMessage />
// - Succeeds → shows the component
```

---

## Streaming SSR

In Next.js App Router, streaming sends HTML to the client progressively:

```typescript
// app/page.tsx (Server Component by default)
import { Suspense } from 'react';

export default function Page() {
  return (
    <main>
      {/* Immediate HTML — streamed first */}
      <h1>Dashboard</h1>
      <StaticNav />

      {/* Streamed when ready — shows skeleton first */}
      <Suspense fallback={<DashboardSkeleton />}>
        <SlowDashboard /> {/* Fetches data on server */}
      </Suspense>

      {/* Independent stream — doesn't block dashboard */}
      <Suspense fallback={<RecommendationsSkeleton />}>
        <Recommendations /> {/* Another slow data fetch */}
      </Suspense>
    </main>
  );
}
```

### How Streaming Works

```
1. Browser requests /dashboard
2. Server sends immediate HTML (h1, nav) → browser starts painting
3. Server fetches dashboard data (slow)
4. Server sends dashboard HTML chunk → replaces skeleton
5. Server fetches recommendations (even slower)
6. Server sends recommendations chunk → replaces skeleton
7. All chunks complete → page fully interactive
```

### Selective Hydration

React 18 hydrates components **independently** as their JavaScript loads:

```
1. HTML arrives (server-rendered) → visible but not interactive
2. JS for <StaticNav> loads → hydrates (interactive)
3. JS for <Dashboard> loads → hydrates
4. User clicks <Recommendations> (not yet hydrated)
   → React PRIORITIZES hydrating Recommendations
5. <Recommendations> hydrates → handles the click
```

**Key insight**: If the user interacts with a not-yet-hydrated component, React immediately prioritizes hydrating that component, making the app feel responsive even before full hydration completes.

---

## Performance Anti-Patterns with Concurrent React

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Side effects in render | Concurrent mode may render multiple times | Move to `useEffect` |
| Reading mutable external state | "Tearing" — inconsistent reads | Use `useSyncExternalStore` |
| `startTransition` with `await` | Updates after `await` aren't transitions | Wrap post-await updates separately |
| Missing Suspense boundaries | Entire page suspends for one slow component | Add granular boundaries |
| Wrapping ALL updates in transitions | Urgent updates become laggy | Only wrap expensive, non-urgent updates |

---

## Citations & Sources

1. **Concurrent Rendering** — Dan Abramov, "The Plan for React 18" (reactjs.org/blog, 2021). Explains interruptible rendering.
2. **useTransition** — React official docs (react.dev/reference/react/useTransition). API reference and usage patterns.
3. **useDeferredValue** — React official docs. Comparison to debouncing.
4. **Streaming SSR** — Next.js official docs (nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming). Implementation guide.
5. **Selective Hydration** — Dan Abramov, "New Suspense SSR Architecture in React 18" (GitHub discussion #37). Architecture document explaining per-component hydration.

---

## Source: error-handling-patterns.md

# Error Handling Patterns

> Error boundaries, async error handling, discriminated union error types, retry patterns, graceful degradation

---

## Error Boundaries (Class Component)

Error boundaries catch errors during rendering, lifecycle methods, and constructors. They do NOT catch errors in event handlers, async code, or SSR.

```typescript
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.props.onError?.(error, info);
    // Send to error tracking service (e.g., Sentry)
    console.error('Error boundary caught:', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback(this.state.error, this.reset);
      }
      return fallback;
    }
    return this.props.children;
  }
}

// Usage:
<ErrorBoundary
  fallback={(error, reset) => (
    <div role="alert">
      <h2>Something went wrong</h2>
      <pre>{error.message}</pre>
      <button onClick={reset}>Try Again</button>
    </div>
  )}
  onError={(error) => Sentry.captureException(error)}
>
  <DataVisualization />
</ErrorBoundary>
```

### Using react-error-boundary Library

```typescript
import { ErrorBoundary } from 'react-error-boundary';

function ErrorFallback({
  error,
  resetErrorBoundary,
}: {
  error: Error;
  resetErrorBoundary: () => void;
}) {
  return (
    <div role="alert" className="error-container">
      <h2>Error</h2>
      <pre>{error.message}</pre>
      <button onClick={resetErrorBoundary}>Retry</button>
    </div>
  );
}

<ErrorBoundary
  FallbackComponent={ErrorFallback}
  onReset={() => {
    // Reset app state that may have caused the error
    queryClient.clear();
  }}
  resetKeys={[userId]} // Auto-reset when userId changes
>
  <UserProfile userId={userId} />
</ErrorBoundary>
```

---

## Type-Safe Error Modeling (Result Type)

Model fallible operations as discriminated unions instead of try/catch:

```typescript
// The Result type — stolen from Rust/Haskell
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// Factory functions
function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// Usage in a service layer
interface ValidationError {
  field: string;
  message: string;
}

async function createUser(
  data: CreateUserInput
): Promise<Result<User, ValidationError[]>> {
  const errors: ValidationError[] = [];
  
  if (!data.email.includes('@')) {
    errors.push({ field: 'email', message: 'Invalid email' });
  }
  if (data.password.length < 8) {
    errors.push({ field: 'password', message: 'Must be 8+ characters' });
  }
  
  if (errors.length > 0) {
    return Err(errors);
  }
  
  const user = await db.user.create({ data });
  return Ok(user);
}

// In component:
function CreateUserForm() {
  const handleSubmit = async (data: CreateUserInput) => {
    const result = await createUser(data);
    
    if (result.ok) {
      // TypeScript knows: result.value is User
      router.push(`/users/${result.value.id}`);
    } else {
      // TypeScript knows: result.error is ValidationError[]
      result.error.forEach(err => {
        setFieldError(err.field, err.message);
      });
    }
  };
}
```

---

## Async Error Handling

Event handlers and async operations are NOT caught by Error Boundaries. Handle them explicitly:

```typescript
function DataComponent() {
  const [error, setError] = useState<Error | null>(null);

  const handleFetch = async () => {
    try {
      const data = await fetchData();
      setData(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Re-throw to let Error Boundary catch it
  if (error) throw error;

  return <button onClick={handleFetch}>Load Data</button>;
}
```

### useErrorBoundary Hook Pattern

```typescript
function useErrorHandler() {
  const [error, setError] = useState<Error | null>(null);
  
  if (error) throw error; // Triggers nearest Error Boundary
  
  const handleError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err : new Error(String(err)));
  }, []);
  
  const resetError = useCallback(() => setError(null), []);
  
  return { handleError, resetError };
}

// Usage:
function AsyncComponent() {
  const { handleError } = useErrorHandler();
  
  const handleClick = async () => {
    try {
      await riskyOperation();
    } catch (err) {
      handleError(err); // Propagates to Error Boundary
    }
  };
  
  return <button onClick={handleClick}>Do Risky Thing</button>;
}
```

---

## Retry Patterns

```typescript
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    backoff?: 'exponential' | 'linear';
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    backoff = 'exponential',
  } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (attempt === maxRetries) break;

      const delay = backoff === 'exponential'
        ? Math.min(baseDelay * 2 ** attempt, maxDelay)
        : Math.min(baseDelay * (attempt + 1), maxDelay);
      
      // Add jitter to prevent thundering herd
      const jitter = delay * 0.1 * Math.random();
      await new Promise(r => setTimeout(r, delay + jitter));
    }
  }

  throw lastError!;
}

// Usage:
const data = await fetchWithRetry(
  () => fetch('/api/data').then(r => r.json()),
  { maxRetries: 3, backoff: 'exponential' }
);
```

---

## Graceful Degradation — Error Boundary Strategy

```
App
├── <ErrorBoundary fallback={<FullPageError />}>     ← Catastrophic
│   ├── <Header />                                    ← Never fails
│   ├── <ErrorBoundary fallback={<ContentError />}>   ← Content area
│   │   ├── <Suspense fallback={<Skeleton />}>
│   │   │   └── <MainContent />                       ← Data-dependent
│   │   └── <ErrorBoundary fallback={<WidgetError />}>← Individual widget
│   │       └── <AnalyticsWidget />                   ← Third-party, flaky
│   └── <Footer />                                    ← Never fails
```

**Principle**: The granularity of error boundaries should match the granularity of failure domains. A broken analytics widget should not take down the entire page.

---

## Citations & Sources

1. **Error Boundaries** — React official docs (react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary).
2. **Result Type** — Inspired by Rust's `Result<T, E>` and Haskell's `Either a b`. Pattern popularized for TypeScript by Khalil Stemmler.
3. **react-error-boundary** — Brian Vaughn (bvaughn), github.com/bvaughn/react-error-boundary. De facto standard library.
4. **Exponential Backoff** — AWS Architecture Blog, "Exponential Backoff and Jitter" (2015). Industry-standard retry strategy.
5. **Error Boundary placement** — Dan Abramov (React core team) recommendation on fine-grained error isolation.

---

## Source: hooks-architecture.md

# Hooks Architecture

> Custom hook composition, Rules of Hooks, useReducer, useSyncExternalStore, data fetching, animation, and ref-based hooks

---

## Rules of Hooks (Why They Exist)

React stores hook state in a **linked list** attached to each Fiber node. Hooks are identified by their call order, not by name. This is why:

1. **Top level only** — Hooks must not be inside conditions, loops, or nested functions
2. **React functions only** — Hooks can only be called in function components or custom hooks
3. **Consistent call order** — Every render must call hooks in the exact same order

```typescript
// ❌ BROKEN: Conditional hook call
function BadComponent({ show }: { show: boolean }) {
  if (show) {
    const [count, setCount] = useState(0); // Hook order changes!
  }
  const [name, setName] = useState('');
}

// ✅ CORRECT: Condition inside the hook's usage
function GoodComponent({ show }: { show: boolean }) {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('');
  // Use `show` in the render, not to gate the hook
}
```

---

## Custom Hook Composition

### Building Block Hooks

```typescript
// Level 1: Primitive hook
function useToggle(initial = false): [boolean, () => void] {
  const [state, setState] = useState(initial);
  const toggle = useCallback(() => setState(s => !s), []);
  return [state, toggle];
}

// Level 2: Composed hook using Level 1
function useDisclosure(initial = false) {
  const [isOpen, toggle] = useToggle(initial);
  const open = useCallback(() => !isOpen && toggle(), [isOpen, toggle]);
  const close = useCallback(() => isOpen && toggle(), [isOpen, toggle]);
  return { isOpen, open, close, toggle };
}

// Level 3: Feature hook using Level 2
function useModal() {
  const disclosure = useDisclosure();
  
  // Lock body scroll when modal is open
  useEffect(() => {
    if (disclosure.isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [disclosure.isOpen]);
  
  // Close on Escape
  useEffect(() => {
    if (!disclosure.isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') disclosure.close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [disclosure.isOpen, disclosure.close]);
  
  return disclosure;
}
```

---

## useReducer for Complex State

When state has multiple sub-values that depend on each other, `useReducer` provides predictable transitions:

```typescript
// 1. Define state and action types
interface FormState {
  values: Record<string, string>;
  errors: Record<string, string>;
  isSubmitting: boolean;
  submitCount: number;
}

type FormAction =
  | { type: 'SET_FIELD'; field: string; value: string }
  | { type: 'SET_ERROR'; field: string; error: string }
  | { type: 'CLEAR_ERRORS' }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_SUCCESS' }
  | { type: 'SUBMIT_FAILURE'; errors: Record<string, string> };

// 2. Pure reducer function
function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_FIELD':
      return {
        ...state,
        values: { ...state.values, [action.field]: action.value },
        errors: { ...state.errors, [action.field]: '' }, // clear error on edit
      };
    case 'SET_ERROR':
      return {
        ...state,
        errors: { ...state.errors, [action.field]: action.error },
      };
    case 'CLEAR_ERRORS':
      return { ...state, errors: {} };
    case 'SUBMIT_START':
      return { ...state, isSubmitting: true, submitCount: state.submitCount + 1 };
    case 'SUBMIT_SUCCESS':
      return { ...state, isSubmitting: false };
    case 'SUBMIT_FAILURE':
      return { ...state, isSubmitting: false, errors: action.errors };
    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

// 3. Usage in component
function useForm(initialValues: Record<string, string>) {
  const [state, dispatch] = useReducer(formReducer, {
    values: initialValues,
    errors: {},
    isSubmitting: false,
    submitCount: 0,
  });

  const setField = useCallback((field: string, value: string) => {
    dispatch({ type: 'SET_FIELD', field, value });
  }, []);

  return { state, setField, dispatch };
}
```

---

## useSyncExternalStore

For subscribing to external (non-React) state sources with concurrent-safe guarantees:

```typescript
// 1. The external store (not React)
class ThemeStore {
  private listeners = new Set<() => void>();
  private theme: 'light' | 'dark' = 'light';

  getSnapshot = () => this.theme;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  toggle() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    this.listeners.forEach(l => l());
  }
}

const themeStore = new ThemeStore();

// 2. Hook using useSyncExternalStore
function useTheme() {
  return useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
    () => 'light' // Server snapshot for SSR
  );
}

// 3. Usage
function ThemeIndicator() {
  const theme = useTheme(); // Always consistent, even in concurrent mode
  return <span>{theme}</span>;
}
```

**Why not just `useState` + `useEffect`?** In concurrent mode, `useState`-based subscriptions can "tear" — showing inconsistent state across the component tree. `useSyncExternalStore` guarantees consistency.

---

## Ref-Based Hooks (Avoiding Re-renders)

Store mutable values in refs when changes should NOT trigger re-renders:

```typescript
// Latest value ref — always has current value without causing re-renders
function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value; // Update synchronously on every render
  return ref;
}

// Previous value hook
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

// Stable callback — always calls latest version without re-renders
function useStableCallback<T extends (...args: any[]) => any>(callback: T): T {
  const ref = useLatest(callback);
  return useCallback(
    ((...args: any[]) => ref.current(...args)) as T,
    []
  );
}

// Interval hook with proper cleanup
function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useLatest(callback);

  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => savedCallback.current(), delay);
    return () => clearInterval(id);
  }, [delay, savedCallback]);
}
```

---

## Data Fetching Hooks

```typescript
interface UseFetchResult<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  refetch: () => void;
}

function useFetch<T>(url: string): UseFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json() as T;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [url]);

  useEffect(() => {
    const controller = new AbortController();
    fetchData();
    return () => controller.abort(); // Cancel on unmount or URL change
  }, [fetchData]);

  return { data, error, isLoading, refetch: fetchData };
}
```

**Production note:** For real applications, use `SWR`, `React Query`, or `useSWR` instead of rolling custom fetch hooks. They handle caching, revalidation, deduplication, and error retry.

---

## Animation Hooks

```typescript
// requestAnimationFrame hook
function useAnimationFrame(callback: (deltaTime: number) => void) {
  const callbackRef = useLatest(callback);
  const frameRef = useRef<number>(0);
  const previousTimeRef = useRef<number>(0);

  useEffect(() => {
    const animate = (time: number) => {
      if (previousTimeRef.current) {
        const deltaTime = time - previousTimeRef.current;
        callbackRef.current(deltaTime);
      }
      previousTimeRef.current = time;
      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [callbackRef]);
}

// Spring animation hook
function useSpring(target: number, config = { stiffness: 170, damping: 26 }) {
  const [value, setValue] = useState(target);
  const velocity = useRef(0);

  useAnimationFrame((dt) => {
    const dtSeconds = dt / 1000;
    const force = -config.stiffness * (value - target);
    const dampingForce = -config.damping * velocity.current;
    const acceleration = force + dampingForce;
    
    velocity.current += acceleration * dtSeconds;
    setValue(v => v + velocity.current * dtSeconds);
  });

  return value;
}
```

---

## Citations & Sources

1. **Rules of Hooks** — React official docs (react.dev/reference/rules). Linked list implementation detail from React source code `ReactFiberHooks.js`.
2. **useSyncExternalStore** — React 18 RSC, added to solve "tearing" in concurrent mode. RFC #214 by the React team.
3. **useReducer patterns** — Kent C. Dodds, "Should I useState or useReducer?" (kentcdodds.com). Decision framework for state complexity.
4. **Custom hook composition** — Dan Abramov, "Making setInterval Declarative with React Hooks" (overreacted.io, 2019). Seminal article on ref-based hook patterns.
5. **Animation hooks** — Framer Motion source code (github.com/framer/motion). Spring physics adapted from `react-spring` internals.

---

## Source: performance-optimization.md

# Performance Optimization

> React DevTools Profiler, memoization, virtualization, code splitting, bundle analysis, Web Vitals

---

## The Golden Rule: Measure Before Optimizing

> "Premature optimization is the root of all evil." — Donald Knuth

Before applying ANY optimization technique, **profile first**:

1. Open React DevTools → Profiler tab
2. Click "Record" and interact with the app
3. Identify components with wasted renders (highlighted in yellow/red)
4. Measure the actual millisecond cost of re-renders

If a re-render takes < 1ms, optimizing it provides zero perceived benefit.

---

## Memoization: When and When NOT

### React.memo

Prevents re-render when props haven't changed (shallow comparison):

```typescript
// ✅ GOOD: Expensive child with stable props
const ExpensiveChart = React.memo(function ExpensiveChart({
  data,
  config,
}: ChartProps) {
  // Takes 5-50ms to render — worth memoizing
  return <canvas ref={renderChart(data, config)} />;
});

// ❌ BAD: Cheap component, always re-renders anyway
const Label = React.memo(function Label({ text }: { text: string }) {
  return <span>{text}</span>; // Takes 0.01ms — memo overhead > savings
});

// ✅ Custom comparison for deep equality
const DataGrid = React.memo(
  function DataGrid({ rows, columns }: GridProps) { /* ... */ },
  (prevProps, nextProps) => {
    // Return true if props are "equal" (skip re-render)
    return (
      prevProps.rows.length === nextProps.rows.length &&
      prevProps.columns === nextProps.columns
    );
  }
);
```

### useMemo

Caches **computed values** across renders:

```typescript
function ProductList({ products, filter }: Props) {
  // ✅ GOOD: Filtering 10,000 products is expensive
  const filtered = useMemo(
    () => products.filter(p => matchesFilter(p, filter)),
    [products, filter]
  );

  // ❌ BAD: Simple computation, cheaper than useMemo overhead
  const count = useMemo(() => products.length, [products]);
  // Just do: const count = products.length;

  // ✅ GOOD: Stabilize object references for React.memo children
  const chartConfig = useMemo(
    () => ({ xAxis: filter.dateRange, yAxis: 'revenue' }),
    [filter.dateRange]
  );

  return (
    <>
      <ExpensiveChart config={chartConfig} /> {/* Won't re-render unnecessarily */}
      <List items={filtered} />
    </>
  );
}
```

### useCallback

Caches **function references** to prevent child re-renders:

```typescript
// ✅ GOOD: Combined with React.memo child
function Parent() {
  const [items, setItems] = useState<Item[]>([]);

  const handleDelete = useCallback((id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  }, []); // Dependency-free because we use the setter form

  return <MemoizedList items={items} onDelete={handleDelete} />;
}

const MemoizedList = React.memo(function ItemList({
  items,
  onDelete,
}: {
  items: Item[];
  onDelete: (id: string) => void;
}) {
  return (
    <ul>
      {items.map(item => (
        <li key={item.id}>
          {item.name}
          <button onClick={() => onDelete(item.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
});

// ❌ BAD: useCallback without React.memo child — pointless
function BadParent() {
  const handleClick = useCallback(() => {
    console.log('clicked');
  }, []);
  // This child is NOT memoized, so it re-renders anyway:
  return <RegularChild onClick={handleClick} />;
}
```

### Decision Matrix

| Situation | Technique | Worth it? |
|---|---|---|
| Child component renders > 5ms | `React.memo` on child | ✅ Yes |
| Filtering/sorting 1000+ items | `useMemo` on computation | ✅ Yes |
| Callback prop to `React.memo` child | `useCallback` | ✅ Yes |
| Simple arithmetic/string op | `useMemo` | ❌ No |
| Function passed to non-memo child | `useCallback` | ❌ No |
| Inline object prop to memo child | `useMemo` on the object | ✅ Yes |

---

## Virtualization

For lists with 100+ items, render only visible items:

```typescript
import { FixedSizeList } from 'react-window';

interface VirtualListProps {
  items: Item[];
  height: number;
}

function VirtualList({ items, height }: VirtualListProps) {
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => (
    <div style={style} className="list-row">
      <span>{items[index].name}</span>
      <span>{items[index].value}</span>
    </div>
  );

  return (
    <FixedSizeList
      height={height}
      width="100%"
      itemCount={items.length}
      itemSize={48} // Row height in px
      overscanCount={5} // Extra rows above/below viewport
    >
      {Row}
    </FixedSizeList>
  );
}

// For variable-height rows:
import { VariableSizeList } from 'react-window';

function VariableList({ items }: { items: Item[] }) {
  const getItemSize = (index: number) => {
    return items[index].expanded ? 120 : 48;
  };

  return (
    <VariableSizeList
      height={600}
      width="100%"
      itemCount={items.length}
      itemSize={getItemSize}
    >
      {Row}
    </VariableSizeList>
  );
}
```

**Performance impact**: Rendering 10,000 items without virtualization creates 10,000 DOM nodes. With virtualization, only ~20-30 nodes exist at any time. This reduces:
- Initial render time: 2000ms → 20ms
- Memory usage: 50MB → 2MB
- Scroll jank: eliminated

---

## Code Splitting

### Route-Based Splitting (Next.js)

Next.js App Router automatically code-splits per route. Each `page.tsx` is a separate chunk.

### Component-Based Splitting

```typescript
import { lazy, Suspense } from 'react';

// Split heavy components
const HeavyEditor = lazy(() => import('./HeavyEditor'));
const Chart = lazy(() => import('./Chart'));

function Dashboard() {
  const [showEditor, setShowEditor] = useState(false);
  
  return (
    <div>
      <button onClick={() => setShowEditor(true)}>Open Editor</button>
      
      {showEditor && (
        <Suspense fallback={<EditorSkeleton />}>
          <HeavyEditor />
        </Suspense>
      )}
      
      <Suspense fallback={<ChartSkeleton />}>
        <Chart data={chartData} />
      </Suspense>
    </div>
  );
}
```

### Named Export Splitting

```typescript
// React.lazy only supports default exports by default
// Workaround for named exports:
const MyComponent = lazy(() =>
  import('./module').then(mod => ({ default: mod.MyComponent }))
);
```

---

## Web Vitals (Core Metrics)

| Metric | Target | What It Measures |
|---|---|---|
| **LCP** (Largest Contentful Paint) | < 2.5s | When the main content is visible |
| **INP** (Interaction to Next Paint) | < 200ms | Responsiveness to user input |
| **CLS** (Cumulative Layout Shift) | < 0.1 | Visual stability (layout jumps) |
| **FCP** (First Contentful Paint) | < 1.8s | When first content appears |
| **TTFB** (Time to First Byte) | < 800ms | Server response time |

### Measuring in React

```typescript
import { onLCP, onINP, onCLS } from 'web-vitals';

// Report metrics
onLCP(console.log);
onINP(console.log);
onCLS(console.log);

// Or send to analytics:
function sendToAnalytics(metric: { name: string; value: number }) {
  navigator.sendBeacon('/api/vitals', JSON.stringify(metric));
}
onLCP(sendToAnalytics);
```

---

## Bundle Analysis

```bash
# Next.js bundle analyzer
npm install @next/bundle-analyzer

# Run analysis
ANALYZE=true next build
```

```typescript
// next.config.js
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});
module.exports = withBundleAnalyzer({ /* config */ });
```

**Bundle size targets for Rare.lab:**
- Total JS: < 300KB gzipped (first load)
- Per-route chunks: < 100KB gzipped
- Three.js (peer dep): loaded only on canvas routes

---

## Citations & Sources

1. **Memoization** — Dan Abramov, "Before You Memo" (overreacted.io, 2021). Framework for deciding when memoization is worthwhile.
2. **Virtualization** — Brian Vaughn (react-window author), "Rendering large lists with react-window" (web.dev, 2019). Performance benchmarks showing 100x improvements.
3. **Code Splitting** — React official docs (react.dev/reference/react/lazy). Webpack/Vite chunk splitting mechanics.
4. **Web Vitals** — Google, "Web Vitals" (web.dev/vitals). Defines the Core Web Vitals metrics and thresholds.
5. **React Profiler** — React DevTools documentation. Flame chart interpretation and commit-level analysis.

---

## Source: react-fundamentals-deep.md

# React Fundamentals Deep Dive

> Fiber architecture, reconciliation, component lifecycle, refs, portals, and React 18 foundations

---

## React Fiber Architecture

React Fiber is the internal reconciliation engine introduced in React 16 that enables concurrent rendering. Understanding Fiber is essential for diagnosing performance issues and understanding why React behaves the way it does.

### What is a Fiber?

A Fiber is a JavaScript object that represents a unit of work. Each React element (component instance, DOM node) has a corresponding Fiber node. Fibers form a linked-list tree structure:

```typescript
interface FiberNode {
  tag: WorkTag;            // FunctionComponent, ClassComponent, HostComponent, etc.
  type: any;               // The function/class/string (e.g., 'div', MyComponent)
  stateNode: any;          // DOM node or class instance
  return: Fiber | null;    // Parent fiber
  child: Fiber | null;     // First child fiber
  sibling: Fiber | null;   // Next sibling fiber
  alternate: Fiber | null; // The "work-in-progress" or "current" counterpart
  memoizedState: any;      // Hooks linked list (for function components)
  memoizedProps: any;      // Props from last completed render
  pendingProps: any;       // Props for current render
  flags: Flags;            // Side effects (Placement, Update, Deletion)
}
```

### Double Buffering

React maintains two Fiber trees:
- **Current tree**: What is currently rendered on screen
- **Work-in-progress (WIP) tree**: Being built during reconciliation

When reconciliation completes, React swaps the pointers — the WIP tree becomes the current tree. This is called **double buffering**, borrowed from graphics programming.

```
Current Tree (on screen)     WIP Tree (being built)
       App                          App
      /   \                        /   \
   Header  Main       →       Header  Main (updated)
            |                          |
          List                       List (re-rendered)
```

### Reconciliation Algorithm

The reconciliation algorithm (diffing) determines the    minimum set of DOM operations needed:

**Rules:**
1. **Different element types** → Tear down old tree, build new tree
2. **Same element type** → Update attributes, recurse into children
3. **Keys** → Match children across renders for stable identity

```typescript
// Without keys — React matches by index (fragile)
<ul>
  <li>Apple</li>   {/* index 0 */}
  <li>Banana</li>  {/* index 1 */}
</ul>

// With keys — React matches by identity (stable)
<ul>
  <li key="apple">Apple</li>
  <li key="banana">Banana</li>
</ul>
```

**Performance implication**: The algorithm is O(n) where n is the number of elements. Cross-component moves are not detected — a component unmounts and remounts if it moves in the tree.

---

## Component Lifecycle (Function Components)

Function components have an implicit lifecycle managed through hooks:

```
Mount Phase:
  1. Component function called (render)
  2. React commits DOM changes
  3. useLayoutEffect callbacks fire (synchronously)
  4. Browser paints
  5. useEffect callbacks fire (asynchronously)

Update Phase:
  1. State/props change detected
  2. Component function called again (re-render)
  3. React diffs virtual DOM
  4. React commits minimal DOM changes
  5. useLayoutEffect cleanup → new callbacks
  6. Browser paints
  7. useEffect cleanup → new callbacks

Unmount Phase:
  1. React removes component from tree
  2. useLayoutEffect cleanup fires
  3. useEffect cleanup fires
  4. Refs set to null
```

### Critical Insight: Render ≠ Commit

**Rendering** is calling the component function and computing the virtual DOM. **Committing** is applying changes to the real DOM. React may render a component multiple times before committing (especially in concurrent mode).

```typescript
function Counter() {
  const [count, setCount] = useState(0);
  
  // This runs during RENDER (pure, no side effects!)
  const doubled = count * 2;
  
  // This runs during COMMIT (side effects allowed)
  useEffect(() => {
    document.title = `Count: ${count}`;
  }, [count]);
  
  return <span>{doubled}</span>;
}
```

---

## React 18 Automatic Batching

React 18 batches ALL state updates by default, regardless of where they originate:

```typescript
// React 17: Only batched inside React event handlers
// React 18: Batched EVERYWHERE

async function handleClick() {
  const data = await fetchData();
  
  // React 18: These are batched into ONE re-render
  setLoading(false);
  setData(data);
  setError(null);
  // Single re-render happens here
}

// To opt OUT of batching (rare):
import { flushSync } from 'react-dom';
flushSync(() => setCount(c => c + 1)); // Renders immediately
flushSync(() => setFlag(f => !f));      // Renders immediately
```

---

## Refs Deep Dive

### Ref Types in TypeScript

```typescript
// 1. DOM element ref
const divRef = useRef<HTMLDivElement>(null);
// divRef.current is HTMLDivElement | null

// 2. Mutable instance ref (for values, NOT DOM)
const timerRef = useRef<number | null>(null);
// timerRef.current is number | null (mutable)

// 3. Callback ref (for dynamic refs)
const [node, setNode] = useState<HTMLDivElement | null>(null);
const callbackRef = useCallback((el: HTMLDivElement | null) => {
  setNode(el); // Now `node` updates when the DOM element changes
}, []);

// 4. forwardRef with TypeScript
interface InputProps {
  label: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ label, error }, ref) {
    return (
      <label>
        {label}
        <input ref={ref} aria-invalid={!!error} />
        {error && <span role="alert">{error}</span>}
      </label>
    );
  }
);
```

### useImperativeHandle

Exposes a custom API through a ref instead of the raw DOM node:

```typescript
interface TextEditorHandle {
  focus: () => void;
  selectAll: () => void;
  getValue: () => string;
}

const TextEditor = forwardRef<TextEditorHandle, TextEditorProps>(
  function TextEditor(props, ref) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    
    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      selectAll: () => inputRef.current?.select(),
      getValue: () => inputRef.current?.value ?? '',
    }), []);
    
    return <textarea ref={inputRef} {...props} />;
  }
);

// Usage:
const editorRef = useRef<TextEditorHandle>(null);
editorRef.current?.selectAll(); // Type-safe custom API
```

---

## Portals

Portals render children into a DOM node outside the parent component's DOM hierarchy, while preserving React's event bubbling:

```typescript
import { createPortal } from 'react-dom';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

function Modal({ isOpen, onClose, children }: ModalProps) {
  if (!isOpen) return null;
  
  return createPortal(
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.getElementById('modal-root')!
  );
}
```

**Key behavior**: Events from a portal still bubble up through the React tree (not the DOM tree). A click inside a portal will trigger `onClick` handlers on React ancestors, even though the portal renders elsewhere in the DOM.

---

## Strict Mode

React `<StrictMode>` activates additional development-only checks:

1. **Double-invokes** render functions, effects, and reducers to detect impure renders
2. **Warns** about deprecated lifecycle methods
3. **Detects** unexpected side effects during render

```typescript
// In development, this component renders TWICE
function App() {
  console.log('render'); // Logs twice in dev, once in prod
  
  useEffect(() => {
    console.log('mount');  // Called twice in dev (mount → unmount → mount)
    return () => console.log('cleanup');
  }, []);
  
  return <Main />;
}
```

**Why double-invocation matters**: It catches effects that don't clean up properly. If your effect breaks on the second invocation, you have a bug that will manifest in production under concurrent rendering.

---

## Citations & Sources

1. **React Fiber Architecture** — Andrew Clark, "React Fiber Architecture" (GitHub gist, 2016). Foundational document explaining the Fiber rewrite motivation and design.
2. **Reconciliation** — React official docs, react.dev/learn/preserving-and-resetting-state. Explains how React decides when to reset or preserve component state.
3. **Automatic Batching** — Dan Abramov, "Automatic Batching for Fewer Renders in React 18" (React blog, 2022). RFC and implementation details.
4. **Fiber linked list** — Based on React source code `ReactFiber.js` and `ReactFiberWorkLoop.js` in the `facebook/react` repository.
5. **Double Buffering** — Standard computer graphics technique. Applied to React's tree management as documented in Lin Clark's "A Cartoon Intro to Fiber" (React Conf 2017).

---

## Source: react-patterns-advanced.md

# Advanced React Patterns

> Higher-order components, render props, compound components, controlled/uncontrolled, provider pattern, polymorphic components

---

## Compound Components

Compound components share implicit state, creating a flexible API where child components collaborate without prop drilling. Think `<select>` + `<option>`.

### Implementation with Context

```typescript
// --- Types ---
interface TabsContextType {
  activeTab: string;
  setActiveTab: (id: string) => void;
}

// --- Context ---
const TabsContext = createContext<TabsContextType | null>(null);

function useTabsContext(): TabsContextType {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('Tab components must be used within <Tabs>');
  }
  return ctx;
}

// --- Root ---
interface TabsProps {
  defaultTab: string;
  children: React.ReactNode;
  onChange?: (tabId: string) => void;
}

function Tabs({ defaultTab, children, onChange }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab);

  const handleChange = useCallback((id: string) => {
    setActiveTab(id);
    onChange?.(id);
  }, [onChange]);

  const value = useMemo(
    () => ({ activeTab, setActiveTab: handleChange }),
    [activeTab, handleChange]
  );

  return (
    <TabsContext.Provider value={value}>
      <div role="tablist">{children}</div>
    </TabsContext.Provider>
  );
}

// --- Sub-components ---
interface TabProps {
  id: string;
  children: React.ReactNode;
}

function Tab({ id, children }: TabProps) {
  const { activeTab, setActiveTab } = useTabsContext();
  return (
    <button
      role="tab"
      aria-selected={activeTab === id}
      onClick={() => setActiveTab(id)}
    >
      {children}
    </button>
  );
}

function TabPanel({ id, children }: TabProps) {
  const { activeTab } = useTabsContext();
  if (activeTab !== id) return null;
  return <div role="tabpanel">{children}</div>;
}

// --- Attach sub-components ---
Tabs.Tab = Tab;
Tabs.Panel = TabPanel;

// --- Usage ---
<Tabs defaultTab="settings" onChange={console.log}>
  <Tabs.Tab id="profile">Profile</Tabs.Tab>
  <Tabs.Tab id="settings">Settings</Tabs.Tab>
  <Tabs.Panel id="profile">Profile content</Tabs.Panel>
  <Tabs.Panel id="settings">Settings content</Tabs.Panel>
</Tabs>
```

**When to use:** Multi-part UI components (tabs, accordions, menus, form groups) where parts need shared behavior without explicit wiring.

---

## Render Props Pattern (Typed)

Render props delegate rendering control to the consumer, maximizing reusability:

```typescript
interface MousePosition {
  x: number;
  y: number;
}

interface MouseTrackerProps {
  children: (position: MousePosition) => React.ReactNode;
}

function MouseTracker({ children }: MouseTrackerProps) {
  const [position, setPosition] = useState<MousePosition>({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setPosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return <>{children(position)}</>;
}

// Usage:
<MouseTracker>
  {({ x, y }) => <Tooltip style={{ left: x, top: y }}>Cursor here</Tooltip>}
</MouseTracker>
```

**Modern alternative:** Custom hooks (`useMousePosition`) are preferred in most cases. Render props remain useful when the consumer needs conditional rendering based on external state.

---

## Higher-Order Components (Typed)

HOCs wrap a component to inject behavior. Typing HOCs correctly is notoriously tricky:

```typescript
// Type-safe HOC that injects a `theme` prop
interface WithThemeProps {
  theme: 'light' | 'dark';
}

function withTheme<P extends WithThemeProps>(
  WrappedComponent: React.ComponentType<P>
) {
  type OuterProps = Omit<P, keyof WithThemeProps>;

  const WithTheme = forwardRef<unknown, OuterProps>(
    function WithTheme(props, ref) {
      const theme = useTheme(); // custom hook
      return (
        <WrappedComponent
          {...(props as P)}
          theme={theme}
          ref={ref}
        />
      );
    }
  );

  WithTheme.displayName = `withTheme(${
    WrappedComponent.displayName || WrappedComponent.name
  })`;

  return WithTheme;
}
```

**When to use:** Cross-cutting concerns (auth guards, analytics wrappers, error boundaries). **Prefer hooks** for logic reuse; HOCs for behavior injection around components you don't control.

---

## Polymorphic Components (the `as` prop)

A polymorphic component renders as different HTML elements/components while preserving type safety:

```typescript
type PolymorphicProps<E extends React.ElementType, P = {}> = P & {
  as?: E;
} & Omit<React.ComponentPropsWithoutRef<E>, keyof P | 'as'>;

type PolymorphicRef<E extends React.ElementType> =
  React.ComponentPropsWithRef<E>['ref'];

// The component:
type ButtonOwnProps = {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
};

type ButtonProps<E extends React.ElementType = 'button'> =
  PolymorphicProps<E, ButtonOwnProps>;

function Button<E extends React.ElementType = 'button'>({
  as,
  variant = 'primary',
  size = 'md',
  ...props
}: ButtonProps<E>) {
  const Component = as ?? 'button';
  return <Component className={`btn-${variant} btn-${size}`} {...props} />;
}

// Usage — full type safety on the rendered element's props:
<Button>Click me</Button>                    // renders <button>
<Button as="a" href="/about">About</Button>  // renders <a>, href is valid
<Button as={Link} to="/home">Home</Button>   // renders <Link>, `to` is valid
// <Button as="a" to="/x">Error</Button>     // TYPE ERROR: <a> has no `to` prop
```

---

## Controlled vs Uncontrolled Components

### Controlled

Parent owns the state, child reports changes:

```typescript
interface ControlledInputProps {
  value: string;
  onChange: (value: string) => void;
}

function ControlledInput({ value, onChange }: ControlledInputProps) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  );
}
```

### Uncontrolled

Child owns state, parent reads via ref:

```typescript
interface UncontrolledInputProps {
  defaultValue?: string;
}

const UncontrolledInput = forwardRef<HTMLInputElement, UncontrolledInputProps>(
  function UncontrolledInput({ defaultValue }, ref) {
    return <input defaultValue={defaultValue} ref={ref} />;
  }
);
```

### Hybrid (Best Practice)

Support both modes simultaneously:

```typescript
interface InputProps {
  value?: string;            // If provided → controlled
  defaultValue?: string;     // If value absent → uncontrolled
  onChange?: (value: string) => void;
}

function Input({ value, defaultValue, onChange }: InputProps) {
  const [internal, setInternal] = useState(defaultValue ?? '');
  const isControlled = value !== undefined;
  const currentValue = isControlled ? value : internal;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isControlled) setInternal(e.target.value);
    onChange?.(e.target.value);
  };

  return <input value={currentValue} onChange={handleChange} />;
}
```

---

## Provider Pattern (Type-Safe)

Combine Context with custom hook for ergonomic, type-safe state sharing:

```typescript
// 1. Define the context shape
interface AuthContextType {
  user: User | null;
  login: (credentials: Credentials) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

// 2. Create context with null initial value
const AuthContext = createContext<AuthContextType | null>(null);

// 3. Custom hook with runtime guard
export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return ctx;
}

// 4. Provider component
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const login = useCallback(async (creds: Credentials) => {
    setIsLoading(true);
    const user = await api.login(creds);
    setUser(user);
    setIsLoading(false);
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    api.logout();
  }, []);

  // CRITICAL: Memoize the value object to prevent all consumers re-rendering
  const value = useMemo(
    () => ({ user, login, logout, isLoading }),
    [user, login, logout, isLoading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
```

**Key insight:** Always memoize the Context value. Without `useMemo`, every render of the Provider creates a new object reference, causing ALL consumers to re-render even if the data hasn't changed.

---

## Slot Pattern

Inspired by Web Components, slots allow named insertion points:

```typescript
interface CardProps {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

function Card({ header, footer, children }: CardProps) {
  return (
    <div className="card">
      {header && <div className="card-header">{header}</div>}
      <div className="card-body">{children}</div>
      {footer && <div className="card-footer">{footer}</div>}
    </div>
  );
}

// Usage:
<Card
  header={<h2>Title</h2>}
  footer={<Button>Submit</Button>}
>
  <p>Card body content</p>
</Card>
```

---

## Citations & Sources

1. **Compound Components** — Kent C. Dodds, "Advanced React Patterns" workshop. Pattern popularized for React by Ryan Florence.
2. **Polymorphic Components** — Ben Ilegbodu, "Polymorphic React Components in TypeScript" (benmvp.com, 2021). Industry-standard typing approach.
3. **Render Props** — Michael Jackson, "Use a Render Prop!" (React Conf 2017). Pattern documented in React official docs.
4. **HOC Typing** — DefinitelyTyped discussions and React TypeScript Cheatsheet (react-typescript-cheatsheet.netlify.app).
5. **Controlled Components** — React official docs, "Sharing State Between Components" (react.dev/learn).

---

## Source: server-components.md

# React Server Components (RSC)

> RSC architecture, "use client" boundary, server-only data fetching, streaming, selective hydration, server actions

---

## The Mental Model

In the App Router, components are **Server Components by default**. They run on the server, have zero client-side JavaScript, and can directly access databases, file systems, and secrets.

```
Server Components (default)          Client Components ("use client")
├── Run on server only               ├── Run on client (browser)
├── Zero JS sent to browser          ├── JS bundle sent to browser
├── Can access DB, fs, env           ├── Can use useState, useEffect
├── Can import Server Components     ├── Can use browser APIs
├── Cannot use hooks or state        ├── Can handle user interaction
├── Cannot use browser APIs          ├── Cannot import Server Components
└── Streamed as RSC payload          └── Hydrated on client
```

---

## The "use client" Boundary

```typescript
// app/page.tsx — Server Component (default)
import { db } from '@/lib/db';
import { ClientCounter } from './ClientCounter';

export default async function Page() {
  // Direct DB access — runs on server, never exposed to client
  const posts = await db.post.findMany({ take: 10 });
  
  return (
    <main>
      <h1>Posts ({posts.length})</h1>
      {posts.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
      
      {/* Client Component — interactive, has state */}
      <ClientCounter initialCount={posts.length} />
    </main>
  );
}

// app/ClientCounter.tsx — Client Component
'use client';

import { useState } from 'react';

export function ClientCounter({ initialCount }: { initialCount: number }) {
  const [count, setCount] = useState(initialCount);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```

### Boundary Rules

1. **Server → Client**: Server Components can render Client Components (pass serializable props)
2. **Client → Server**: Client Components CANNOT import Server Components directly
3. **Children slot**: Client Components can accept Server Components via `children` prop

```typescript
// ✅ CORRECT: Pass Server Components as children
'use client';
function ClientLayout({ children }: { children: React.ReactNode }) {
  const [sidebar, setSidebar] = useState(true);
  return (
    <div>
      {sidebar && <Sidebar />}
      <main>{children}</main> {/* children can be Server Components */}
    </div>
  );
}

// In server page:
<ClientLayout>
  <ServerDataComponent /> {/* This is a Server Component! */}
</ClientLayout>
```

### What Can Be Passed Across the Boundary

| Type | Serializable? | Notes |
|---|---|---|
| Strings, numbers, booleans | ✅ | Always safe |
| Plain objects / arrays | ✅ | No class instances |
| `Date` | ✅ | Serialized as ISO string |
| Functions | ❌ | Use Server Actions instead |
| Class instances | ❌ | Strip to plain objects |
| React Elements (JSX) | ✅ | Via `children` prop |
| Symbols | ❌ | Not serializable |

---

## Server Actions ("use server")

Server Actions allow Client Components to call server-side functions:

```typescript
// app/actions.ts
'use server';

import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';

export async function createPost(formData: FormData) {
  const title = formData.get('title') as string;
  const content = formData.get('content') as string;
  
  await db.post.create({ data: { title, content } });
  revalidatePath('/posts'); // Invalidate cached page
}

export async function deletePost(id: string) {
  await db.post.delete({ where: { id } });
  revalidatePath('/posts');
}
```

```typescript
// app/posts/CreatePostForm.tsx
'use client';

import { createPost } from '../actions';
import { useTransition } from 'react';

export function CreatePostForm() {
  const [isPending, startTransition] = useTransition();
  
  return (
    <form action={(formData) => {
      startTransition(() => createPost(formData));
    }}>
      <input name="title" required />
      <textarea name="content" required />
      <button type="submit" disabled={isPending}>
        {isPending ? 'Creating...' : 'Create Post'}
      </button>
    </form>
  );
}
```

---

## Streaming with Suspense in RSC

```typescript
// app/dashboard/page.tsx
import { Suspense } from 'react';

export default function DashboardPage() {
  return (
    <div>
      {/* Immediate — no data dependency */}
      <h1>Dashboard</h1>
      <NavigationTabs />

      {/* Streams when data is ready */}
      <Suspense fallback={<MetricsSkeleton />}>
        <Metrics /> {/* async Server Component */}
      </Suspense>

      {/* Independent stream */}
      <Suspense fallback={<ActivitySkeleton />}>
        <RecentActivity /> {/* separate async fetch */}
      </Suspense>
    </div>
  );
}

// Async Server Component — suspends until data resolves
async function Metrics() {
  const metrics = await fetchMetrics(); // 2-3 second API call
  return (
    <div className="metrics-grid">
      {metrics.map(m => <MetricCard key={m.id} metric={m} />)}
    </div>
  );
}

async function RecentActivity() {
  const activity = await fetchActivity(); // 1 second API call
  return <ActivityFeed items={activity} />;
}
```

### loading.tsx (Automatic Suspense)

```typescript
// app/dashboard/loading.tsx
// Automatically wraps the page in <Suspense fallback={<Loading />}>
export default function Loading() {
  return <DashboardSkeleton />;
}
```

---

## Caching in RSC

```typescript
import { cache } from 'react';
import { unstable_cache } from 'next/cache';

// 1. React cache() — deduplicates within a single request
const getUser = cache(async (id: string) => {
  const user = await db.user.findUnique({ where: { id } });
  return user;
});

// Called multiple times in different Server Components during one request:
// getUser('123') — fetches from DB
// getUser('123') — returns cached result (same request)

// 2. Next.js unstable_cache — persists across requests
const getCachedPosts = unstable_cache(
  async () => {
    return db.post.findMany();
  },
  ['posts'],  // Cache key
  { revalidate: 60 } // Revalidate every 60 seconds
);
```

---

## Selective Hydration

React 18 hydrates components independently as their JS loads:

```
Timeline:
  0ms: Server HTML arrives → entire page visible (non-interactive)
100ms: Nav JS loads → Nav hydrates (interactive)
200ms: User clicks on Activity feed (not yet hydrated)
        → React PRIORITIZES Activity hydration
250ms: Activity hydrates → handles the pending click
500ms: Metrics JS loads → Metrics hydrates
```

**Best practice**: Use Server Components for static content. Reserve `"use client"` for interactive widgets. This minimizes hydration cost since Server Components have zero JS to hydrate.

---

## Citations & Sources

1. **React Server Components** — React RFC, "React Server Components" (github.com/reactjs/rfcs/pull/188). Original design document.
2. **Next.js App Router** — Next.js 13+ documentation (nextjs.org/docs/app). Production implementation of RSC.
3. **Server Actions** — Next.js 14+ documentation (nextjs.org/docs/app/api-reference/functions/server-actions). RPC-style mutations.
4. **Streaming** — React 18 Architecture blog post (github.com/reactwg/react-18/discussions/37). Technical deep dive on streaming SSR.
5. **Selective Hydration** — Dan Abramov, "New Suspense SSR Architecture in React 18" (GitHub discussion). Explains priority-based hydration.

---

## Source: state-management-patterns.md

# State Management Patterns

> Zustand, Context API, useReducer, form state, URL state, derived state, decision framework

---

## Decision Matrix: Which State Tool?

```
Is the state used by a single component?
├── YES → useState or useReducer
│   ├── Simple value → useState
│   └── Complex with transitions → useReducer
│
└── NO → Is it used by 2-3 nearby components?
    ├── YES → Lift state up (pass as props)
    │
    └── NO → Is it used across distant parts of the tree?
        ├── Read-heavy, rare writes → React Context
        │   (theme, locale, auth status)
        │
        └── Write-heavy, frequent updates → Zustand
            (form state, UI state, real-time data, canvas state)
```

### Quick Reference

| Scenario | Tool | Why |
|---|---|---|
| Toggle a modal | `useState` | Single component, simple boolean |
| Complex form with validation | `useReducer` | Multiple related fields, transitions |
| Theme/locale (read by many) | Context | Read everywhere, changes rarely |
| Auth user (read by many) | Context + Zustand | Read often, but needs persistence |
| Canvas/3D scene state (60fps) | Zustand (with `ref` access) | Frequent writes, must skip re-renders |
| URL search params | `useSearchParams` | Syncs with browser URL |
| Server-fetched data cache | React Query / SWR | Caching, revalidation, dedup built-in |

---

## Zustand Deep Dive

Zustand is a minimal, un-opinionated state library that works outside React's render cycle:

### Basic Store

```typescript
import { create } from 'zustand';

interface CounterStore {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
}

const useCounterStore = create<CounterStore>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  decrement: () => set((state) => ({ count: state.count - 1 })),
  reset: () => set({ count: 0 }),
}));

// Usage:
function Counter() {
  const count = useCounterStore((s) => s.count);
  const increment = useCounterStore((s) => s.increment);
  return <button onClick={increment}>{count}</button>;
}
```

### Slice Pattern (Large Stores)

```typescript
// Separate state into slices
interface UISlice {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  selectedLayerId: string | null;
  selectLayer: (id: string | null) => void;
}

interface SceneSlice {
  layers: Layer[];
  addLayer: (layer: Layer) => void;
  removeLayer: (id: string) => void;
  updateLayerProperty: (id: string, key: string, value: unknown) => void;
}

type AppStore = UISlice & SceneSlice;

const createUISlice = (set: any): UISlice => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s: AppStore) => ({ sidebarOpen: !s.sidebarOpen })),
  selectedLayerId: null,
  selectLayer: (id) => set({ selectedLayerId: id }),
});

const createSceneSlice = (set: any, get: any): SceneSlice => ({
  layers: [],
  addLayer: (layer) => set((s: AppStore) => ({
    layers: [...s.layers, layer],
  })),
  removeLayer: (id) => set((s: AppStore) => ({
    layers: s.layers.filter(l => l.id !== id),
  })),
  updateLayerProperty: (id, key, value) => set((s: AppStore) => ({
    layers: s.layers.map(l =>
      l.id === id ? { ...l, properties: { ...l.properties, [key]: value } } : l
    ),
  })),
});

const useAppStore = create<AppStore>((...args) => ({
  ...createUISlice(...args),
  ...createSceneSlice(...args),
}));
```

### Zustand Middleware

```typescript
import { create } from 'zustand';
import { devtools, persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

const useStore = create<AppStore>()(
  devtools(              // Redux DevTools integration
    persist(             // Persist to localStorage
      immer(             // Use Immer for mutable-style updates
        subscribeWithSelector(   // Subscribe to specific slices
          (set) => ({
            count: 0,
            increment: () => set((state) => { state.count += 1; }),
            // With immer: direct mutation syntax (mutates a draft)
          })
        )
      ),
      { name: 'app-storage' }  // localStorage key
    ),
    { name: 'AppStore' }       // DevTools label
  )
);
```

### Accessing Store Outside React

```typescript
// Critical for 60fps canvas/WebGL updates — bypasses React reconciliation
const { getState, setState, subscribe } = useAppStore;

// In a requestAnimationFrame loop:
function animate() {
  const { layers } = useAppStore.getState();
  // Read state directly — no re-render triggered
  updateWebGLUniforms(layers);
  requestAnimationFrame(animate);
}

// Subscribe to changes without React:
const unsubscribe = useAppStore.subscribe(
  (state) => state.selectedLayerId,
  (selectedId) => {
    console.log('Layer selected:', selectedId);
  }
);
```

---

## Context Optimization

Context re-renders ALL consumers when the value changes. Mitigation strategies:

### Split Contexts

```typescript
// ❌ BAD: One context for everything
const AppContext = createContext({ theme: 'dark', user: null, locale: 'en' });
// Changing theme re-renders components that only need user

// ✅ GOOD: Separate contexts
const ThemeContext = createContext<Theme>('dark');
const UserContext = createContext<User | null>(null);
const LocaleContext = createContext<Locale>('en');
// Changing theme only re-renders theme consumers
```

### Memoize Provider Value

```typescript
function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  
  // ✅ Memoize to prevent all consumers from re-rendering on parent re-render
  const value = useMemo(
    () => ({ theme, setTheme }),
    [theme]
  );
  
  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}
```

### Context + Ref for High-Frequency Updates

```typescript
// For values that change at 60fps (e.g., mouse position, scroll)
// Context causes re-renders — use ref + subscription instead
function useMousePosition() {
  const posRef = useRef({ x: 0, y: 0 });
  const listenersRef = useRef(new Set<() => void>());

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      posRef.current = { x: e.clientX, y: e.clientY };
      listenersRef.current.forEach(l => l());
    };
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return useSyncExternalStore(
    (cb) => { listenersRef.current.add(cb); return () => listenersRef.current.delete(cb); },
    () => posRef.current,
    () => ({ x: 0, y: 0 })
  );
}
```

---

## Derived State (Avoid useEffect)

```typescript
// ❌ ANTI-PATTERN: useEffect for derived state
function BadComponent({ items }: { items: Item[] }) {
  const [filteredItems, setFilteredItems] = useState<Item[]>([]);
  
  useEffect(() => {
    setFilteredItems(items.filter(i => i.active));
  }, [items]);
  // Problem: Extra render cycle, stale state between renders
}

// ✅ CORRECT: Compute during render
function GoodComponent({ items }: { items: Item[] }) {
  const filteredItems = useMemo(
    () => items.filter(i => i.active),
    [items]
  );
  // No extra render, always in sync
}

// ✅ ALSO CORRECT: Simple computation, no memoization needed
function SimpleComponent({ items }: { items: Item[] }) {
  const count = items.length; // Just compute it
  const hasItems = items.length > 0; // No useMemo needed for this
}
```

---

## Citations & Sources

1. **Zustand** — Daishi Kato (pmndrs), github.com/pmndrs/zustand. Minimal, un-opinionated state management. Used by Vercel, Shopify, and many Three.js projects.
2. **Context Performance** — React official docs, "Scaling Up with Context" (react.dev/learn/passing-data-deeply-with-context). Anti-patterns and optimization strategies.
3. **Derived State** — Dan Abramov, "You Might Not Need an Effect" (react.dev/learn/you-might-not-need-an-effect). Canonical guide to avoiding useEffect for state derivation.
4. **Zustand Middleware** — Zustand documentation (docs.pmnd.rs/zustand). Devtools, persist, immer, and subscribeWithSelector middleware.
5. **State Colocation** — Kent C. Dodds, "State Colocation Will Make Your React App Faster" (kentcdodds.com, 2019). Decision framework for state placement.

---

## Source: testing-strategies.md

# Testing Strategies

> React Testing Library, renderHook, userEvent, type-level testing, MSW, Storybook interaction tests

---

## Testing Philosophy

> "The more your tests resemble the way your software is used, the more confidence they can give you." — Kent C. Dodds

### The Testing Trophy (Not Pyramid)

```
      ▲ E2E tests (few, slow, high confidence)
     ▲▲▲ Integration tests (more, moderate speed)
   ▲▲▲▲▲▲▲ Component tests (many, fast)  ← MOST VALUE
     ▲▲▲ Static analysis (TypeScript, ESLint)
```

**Priority**: Component tests > integration tests > E2E. Static analysis (TypeScript strict mode) catches the majority of bugs for free.

---

## Component Testing with RTL

```typescript
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

// 1. Always use userEvent (not fireEvent)
describe('Counter', () => {
  it('increments on click', async () => {
    const user = userEvent.setup();
    render(<Counter initialCount={0} />);
    
    const button = screen.getByRole('button', { name: /increment/i });
    expect(screen.getByText('Count: 0')).toBeInTheDocument();
    
    await user.click(button);
    expect(screen.getByText('Count: 1')).toBeInTheDocument();
  });
});

// 2. Test form submission
describe('LoginForm', () => {
  it('submits credentials', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} />);
    
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'secret123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'test@example.com',
      password: 'secret123',
    });
  });

  it('shows validation errors', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSubmit={vi.fn()} />);
    
    // Submit without filling fields
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    
    expect(screen.getByRole('alert')).toHaveTextContent(/email is required/i);
  });
});

// 3. Test async content
describe('UserProfile', () => {
  it('loads and displays user data', async () => {
    render(<UserProfile userId="123" />);
    
    // Loading state
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    
    // Wait for data
    const heading = await screen.findByRole('heading', { name: /john doe/i });
    expect(heading).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
});
```

### Query Priority (Best to Worst)

| Priority | Query | Use When |
|---|---|---|
| 1 | `getByRole` | Interactive elements (buttons, inputs, headings) |
| 2 | `getByLabelText` | Form fields with labels |
| 3 | `getByPlaceholderText` | Inputs without visible labels |
| 4 | `getByText` | Non-interactive text content |
| 5 | `getByDisplayValue` | Current input values |
| 6 | `getByAltText` | Images |
| 7 | `getByTestId` | **Last resort** — no semantic query available |

---

## Custom Hook Testing

```typescript
import { renderHook, act } from '@testing-library/react';

describe('useCounter', () => {
  it('initializes with default value', () => {
    const { result } = renderHook(() => useCounter(0));
    expect(result.current.count).toBe(0);
  });

  it('increments', () => {
    const { result } = renderHook(() => useCounter(0));
    act(() => result.current.increment());
    expect(result.current.count).toBe(1);
  });

  it('respects max value', () => {
    const { result } = renderHook(() => useCounter(9, { max: 10 }));
    act(() => result.current.increment());
    expect(result.current.count).toBe(10);
    act(() => result.current.increment());
    expect(result.current.count).toBe(10); // Capped
  });
});

// Testing hooks with context dependency
describe('useAuth', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthProvider>
      {children}
    </AuthProvider>
  );

  it('returns null user when not logged in', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.user).toBeNull();
  });
});
```

---

## API Mocking with MSW

```typescript
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.get('/api/users/:id', ({ params }) => {
    return HttpResponse.json({
      id: params.id,
      name: 'John Doe',
      email: 'john@example.com',
    });
  }),
  
  http.post('/api/users', async ({ request }) => {
    const body = await request.json() as CreateUserInput;
    return HttpResponse.json(
      { id: '123', ...body },
      { status: 201 }
    );
  }),
  
  http.get('/api/users/:id/posts', () => {
    return HttpResponse.json([
      { id: '1', title: 'First Post' },
      { id: '2', title: 'Second Post' },
    ]);
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Override for specific test
it('handles server error', async () => {
  server.use(
    http.get('/api/users/:id', () => {
      return HttpResponse.json(
        { message: 'Internal Server Error' },
        { status: 500 }
      );
    })
  );
  
  render(<UserProfile userId="123" />);
  await screen.findByText(/something went wrong/i);
});
```

---

## Type-Level Testing

Test that your types work correctly using `vitest` and `expectTypeOf`:

```typescript
import { expectTypeOf, describe, it } from 'vitest';

describe('Component types', () => {
  it('Button accepts variant prop', () => {
    expectTypeOf<ButtonProps>().toHaveProperty('variant');
    expectTypeOf<ButtonProps['variant']>().toEqualTypeOf<
      'primary' | 'secondary' | undefined
    >();
  });

  it('useAuth returns correct shape', () => {
    expectTypeOf(useAuth).returns.toMatchTypeOf<{
      user: User | null;
      login: (creds: Credentials) => Promise<void>;
    }>();
  });

  it('generic List infers item type', () => {
    type Props = ListProps<{ id: string; name: string }>;
    expectTypeOf<Props['renderItem']>().parameter(0).toMatchTypeOf<{
      id: string;
      name: string;
    }>();
  });
});
```

---

## Storybook Interaction Tests

```typescript
// Button.stories.tsx
import type { Meta, StoryObj } from '@storybook/react';
import { within, userEvent, expect } from '@storybook/test';

const meta: Meta<typeof Button> = {
  component: Button,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof Button>;

export const ClickInteraction: Story = {
  args: { variant: 'primary', children: 'Click me' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button');
    
    // Verify initial state
    await expect(button).toBeEnabled();
    await expect(button).toHaveTextContent('Click me');
    
    // Simulate interaction
    await userEvent.click(button);
    
    // Verify post-interaction state
    await expect(button).toHaveClass('active');
  },
};
```

---

## Coverage Strategy

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        'node_modules/',
        '**/*.stories.tsx',
        '**/*.test.tsx',
        '**/types.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
```

**Coverage targets for Rare.lab:**
- Utility functions: 90%+
- Hooks: 85%+
- Components: 80%+
- UI layout components: 60%+ (visual testing covers the rest)

---

## Citations & Sources

1. **Testing Library** — Kent C. Dodds (testing-library.com). Query priority and testing philosophy.
2. **MSW v2** — Artem Zakharchenko (mswjs.io). Mock Service Worker for API mocking.
3. **userEvent** — @testing-library/user-event. Simulates real user behavior (not just DOM events).
4. **Vitest** — vitest.dev. TypeScript-first test runner with expectTypeOf.
5. **Storybook Testing** — Storybook docs (storybook.js.org/docs/writing-tests/interaction-testing). Play functions for automated stories.

---

## Source: typescript-react-patterns.md

# TypeScript + React Patterns

> Generic components, discriminated union props, polymorphic `as` prop, forwardRef with generics, typed Context, typed event handlers, children typing

---

## Generic Component Props

Generic components adapt their types based on the data they receive:

```typescript
// Generic list component
interface ListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  keyExtractor: (item: T) => string;
  emptyMessage?: string;
}

function List<T>({ items, renderItem, keyExtractor, emptyMessage }: ListProps<T>) {
  if (items.length === 0) {
    return <p>{emptyMessage ?? 'No items'}</p>;
  }
  return (
    <ul>
      {items.map((item, i) => (
        <li key={keyExtractor(item)}>{renderItem(item, i)}</li>
      ))}
    </ul>
  );
}

// Usage — T is inferred automatically:
interface User { id: string; name: string; }

<List
  items={users}                          // T = User (inferred)
  renderItem={(user) => user.name}       // user is typed as User
  keyExtractor={(user) => user.id}       // user is typed as User
/>

// Generic Select component
interface SelectProps<T extends string> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}

function Select<T extends string>({
  options, value, onChange, label,
}: SelectProps<T>) {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
      >
        {options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </label>
  );
}

// Usage — T constrains the options AND value:
const sizes = ['sm', 'md', 'lg'] as const;
<Select
  options={sizes}
  value="md"         // Must be 'sm' | 'md' | 'lg'
  onChange={(v) => {}} // v is typed as 'sm' | 'md' | 'lg'
  label="Size"
/>
```

---

## Discriminated Union Props

Use discriminated unions instead of boolean flags for mutually exclusive behaviors:

```typescript
// ❌ Boolean flags — confusing, allows invalid states
interface BadButtonProps {
  isLink?: boolean;
  href?: string;         // Only valid if isLink
  onClick?: () => void;  // Only valid if NOT isLink
  isLoading?: boolean;
  loadingText?: string;  // Only valid if isLoading
}

// ✅ Discriminated unions — impossible states are impossible
type ButtonProps =
  | {
      variant: 'button';
      onClick: () => void;
      isLoading?: boolean;
      loadingText?: string;
    }
  | {
      variant: 'link';
      href: string;
      external?: boolean;
    }
  | {
      variant: 'submit';
      form: string;
      isLoading?: boolean;
    };

function Button(props: ButtonProps) {
  switch (props.variant) {
    case 'button':
      return (
        <button
          onClick={props.onClick}
          disabled={props.isLoading}
        >
          {props.isLoading ? props.loadingText : 'Click'}
        </button>
      );
    case 'link':
      return (
        <a
          href={props.href}
          target={props.external ? '_blank' : undefined}
          rel={props.external ? 'noopener noreferrer' : undefined}
        >
          Link
        </a>
      );
    case 'submit':
      return (
        <button type="submit" form={props.form} disabled={props.isLoading}>
          Submit
        </button>
      );
  }
}
```

---

## forwardRef with Generics

Combining `forwardRef` with generic components requires a workaround:

```typescript
// The problem: forwardRef doesn't preserve generic parameters
// Solution: Use a type assertion wrapper

function fixedForwardRef<T, P = {}>(
  render: (props: P, ref: React.Ref<T>) => React.ReactNode
): (props: P & React.RefAttributes<T>) => React.ReactNode {
  return forwardRef(render) as any;
}

// Usage:
interface GenericListProps<T> {
  items: T[];
  renderItem: (item: T) => React.ReactNode;
}

const GenericList = fixedForwardRef(
  <T,>(props: GenericListProps<T>, ref: React.Ref<HTMLUListElement>) => {
    return (
      <ul ref={ref}>
        {props.items.map((item, i) => (
          <li key={i}>{props.renderItem(item)}</li>
        ))}
      </ul>
    );
  }
);

// Now GenericList preserves generic T:
<GenericList
  ref={listRef}
  items={[1, 2, 3]}
  renderItem={(n) => n.toFixed(2)}  // n is number ✅
/>
```

---

## Typed Event Handlers

```typescript
// React event types
function EventExamples() {
  // Mouse events
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget; // HTMLButtonElement (always non-null)
    e.target;        // EventTarget (may be child element)
  };

  // Keyboard events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.value; // string
    }
  };

  // Form events
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
  };

  // Change events (type depends on element)
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.target.value;   // string
    e.target.checked; // boolean (checkboxes)
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.target.value;           // string
    e.target.selectedOptions; // HTMLCollection
  };

  // Focus events
  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.relatedTarget; // Element that lost focus
  };

  // Drag events
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('text/plain', 'dragged');
  };

  return null;
}

// Custom event handler type helper
type EventHandler<E extends HTMLElement, T extends React.SyntheticEvent<E>> =
  (event: T) => void;

// Usage:
type ButtonClickHandler = EventHandler<HTMLButtonElement, React.MouseEvent<HTMLButtonElement>>;
```

---

## Children Typing

```typescript
// ReactNode — the broadest type, accepts everything
interface ContainerProps {
  children: React.ReactNode;
  // Accepts: string, number, boolean, null, undefined, 
  //          ReactElement, ReactFragment, ReactPortal, Iterable
}

// ReactElement — only JSX elements (no strings, numbers, etc.)
interface StrictContainerProps {
  children: React.ReactElement;
  // Only accepts: <Component />, <div />, etc.
}

// Function as children (render prop pattern)
interface DataProviderProps<T> {
  children: (data: T) => React.ReactNode;
}

// Specific element type
interface FormGroupProps {
  children: React.ReactElement<InputProps> | React.ReactElement<InputProps>[];
}

// PropsWithChildren helper
type MyProps = React.PropsWithChildren<{
  title: string;
}>;
// Equivalent to: { title: string; children?: React.ReactNode; }
```

---

## Typed Context with Generics

```typescript
// Generic context factory
function createTypedContext<T>(displayName: string) {
  const Context = createContext<T | null>(null);
  Context.displayName = displayName;

  function useTypedContext(): T {
    const ctx = useContext(Context);
    if (ctx === null) {
      throw new Error(
        `use${displayName} must be used within a ${displayName}Provider`
      );
    }
    return ctx;
  }

  return [Context.Provider, useTypedContext] as const;
}

// Usage:
interface ThemeContextValue {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

const [ThemeProvider, useTheme] = createTypedContext<ThemeContextValue>('Theme');

// In app:
function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  return (
    <ThemeProvider value={{ theme, toggleTheme: () => setTheme(t => t === 'light' ? 'dark' : 'light') }}>
      <Main />
    </ThemeProvider>
  );
}

// In consumer:
function ThemeButton() {
  const { theme, toggleTheme } = useTheme(); // Fully typed, never null
  return <button onClick={toggleTheme}>{theme}</button>;
}
```

---

## Citations & Sources

1. **Generic Components** — TypeScript Handbook, "Generics" + React TypeScript Cheatsheet (react-typescript-cheatsheet.netlify.app).
2. **Discriminated Unions** — TypeScript Handbook, "Narrowing" section. Pattern formalized by Anders Hejlsberg.
3. **forwardRef generics workaround** — GitHub issue facebook/react#28040; community pattern from Matt Pocock (totaltypescript.com).
4. **Event Types** — React TypeScript Cheatsheet, "Forms and Events" section. Based on `@types/react` DefinitelyTyped definitions.
5. **Children Typing** — React official docs, `React.ReactNode` vs `React.ReactElement` distinctions. Refined in React 18 type definitions.

---

## Source: typescript-type-system.md

# TypeScript Type System Mastery

> Conditional types, mapped types, template literal types, type narrowing, utility types, and the `satisfies` operator

---

## Conditional Types

Conditional types enable type-level branching: `T extends U ? X : Y`. They are the `if/else` of the type system.

### Basic Syntax

```typescript
// Simple conditional
type IsString<T> = T extends string ? true : false;

type A = IsString<string>;  // true
type B = IsString<number>;  // false
type C = IsString<'hello'>; // true (string literal extends string)
```

### The `infer` Keyword

`infer` declares a type variable within a conditional type, allowing extraction of sub-types:

```typescript
// Extract return type of a function
type ReturnOf<T> = T extends (...args: any[]) => infer R ? R : never;

type Fn = (x: number) => string;
type Result = ReturnOf<Fn>; // string

// Extract element type of an array
type ElementOf<T> = T extends (infer E)[] ? E : never;
type El = ElementOf<string[]>; // string

// Extract Promise value
type Awaited<T> = T extends Promise<infer V> ? Awaited<V> : T;
type Val = Awaited<Promise<Promise<number>>>; // number (recursive!)

// Extract props type from a React component
type PropsOf<C> = C extends React.ComponentType<infer P> ? P : never;
```

### Distributive Conditional Types

When a conditional type is applied to a **naked type parameter** that is a union, it distributes over each member:

```typescript
type ToArray<T> = T extends any ? T[] : never;

// Distributes over the union:
type Result = ToArray<string | number>;
// = (string extends any ? string[] : never) | (number extends any ? number[] : never)
// = string[] | number[]

// To PREVENT distribution, wrap in tuple:
type ToArrayNonDist<T> = [T] extends [any] ? T[] : never;
type Result2 = ToArrayNonDist<string | number>;
// = (string | number)[]  — single array type, not union
```

### Practical Pattern: Exhaustive Type Filtering

```typescript
// Extract only string keys from an object type
type StringKeysOf<T> = {
  [K in keyof T]: T[K] extends string ? K : never;
}[keyof T];

interface User {
  id: number;
  name: string;
  email: string;
  age: number;
}

type StringKeys = StringKeysOf<User>; // "name" | "email"
```

---

## Mapped Types

Mapped types transform every property of a type systematically.

### Basic Syntax

```typescript
// Make all properties optional
type MyPartial<T> = {
  [K in keyof T]?: T[K];
};

// Make all properties readonly
type MyReadonly<T> = {
  readonly [K in keyof T]: T[K];
};

// Make all properties required (remove ?)
type MyRequired<T> = {
  [K in keyof T]-?: T[K];
};

// Remove readonly from all properties
type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};
```

### Key Remapping with `as`

TypeScript 4.1+ allows remapping keys during mapping:

```typescript
// Prefix all keys with "get"
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

interface Person {
  name: string;
  age: number;
}

type PersonGetters = Getters<Person>;
// { getName: () => string; getAge: () => number; }

// Filter out keys based on value type
type OnlyStrings<T> = {
  [K in keyof T as T[K] extends string ? K : never]: T[K];
};

type StringProps = OnlyStrings<Person>;
// { name: string; }  — age is filtered out
```

### Deep Mapped Types

```typescript
// Recursively make everything readonly
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object
    ? T[K] extends Function
      ? T[K]               // Don't recurse into functions
      : DeepReadonly<T[K]> // Recurse into objects
    : T[K];                // Primitives stay as-is
};

// Recursively make everything partial
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? DeepPartial<T[K]>
    : T[K];
};
```

---

## Template Literal Types

Template literal types build string types programmatically using backtick syntax.

### Basic Syntax

```typescript
type Greeting = `Hello, ${string}`;
// Matches: "Hello, world", "Hello, TypeScript", etc.

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type ApiRoute = `/api/${string}`;
type FullEndpoint = `${HttpMethod} ${ApiRoute}`;
// "GET /api/users" | "POST /api/users" | etc.
```

### Combinatorial Explosion

When template literals contain unions, all combinations are generated:

```typescript
type Color = 'red' | 'blue' | 'green';
type Size = 'sm' | 'md' | 'lg';
type ClassName = `${Color}-${Size}`;
// "red-sm" | "red-md" | "red-lg" | "blue-sm" | ... (9 total)
```

### String Manipulation Utilities

```typescript
type Upper = Uppercase<'hello'>;       // "HELLO"
type Lower = Lowercase<'HELLO'>;       // "hello"
type Cap = Capitalize<'hello'>;        // "Hello"
type Uncap = Uncapitalize<'Hello'>;    // "hello"

// Practical: Generate event handler names
type EventName = 'click' | 'focus' | 'blur';
type HandlerName = `on${Capitalize<EventName>}`;
// "onClick" | "onFocus" | "onBlur"
```

### Parsing Strings with infer

```typescript
// Extract route parameters
type ExtractParams<T extends string> =
  T extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<`/${Rest}`>
    : T extends `${infer _Start}:${infer Param}`
      ? Param
      : never;

type Params = ExtractParams<'/users/:userId/posts/:postId'>;
// "userId" | "postId"
```

---

## Type Narrowing

Type narrowing refines a broad type to a more specific one within a code block.

### Built-in Narrowing

```typescript
function process(value: string | number | null) {
  if (value === null) return;         // narrowed: string | number
  if (typeof value === 'string') {
    value.toUpperCase();              // narrowed: string
  } else {
    value.toFixed(2);                 // narrowed: number
  }
}

// `in` operator narrowing
interface Dog { bark(): void; }
interface Cat { meow(): void; }

function speak(animal: Dog | Cat) {
  if ('bark' in animal) {
    animal.bark();    // narrowed: Dog
  } else {
    animal.meow();    // narrowed: Cat
  }
}
```

### Custom Type Guards

```typescript
// Type predicate function
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

// Assertion function (throws if false)
function assertDefined<T>(
  value: T | null | undefined,
  message?: string
): asserts value is T {
  if (value == null) {
    throw new Error(message ?? 'Value is null or undefined');
  }
}

// Usage:
function handle(input: unknown) {
  if (isString(input)) {
    input.toUpperCase(); // TypeScript knows it's string
  }
  
  const maybeNull: string | null = getData();
  assertDefined(maybeNull, 'Data must exist');
  maybeNull.toUpperCase(); // TypeScript knows it's string (after assertion)
}
```

### Discriminated Union Narrowing

The most powerful pattern for variant types:

```typescript
// The discriminant is `type`
type Shape =
  | { type: 'circle'; radius: number }
  | { type: 'rectangle'; width: number; height: number }
  | { type: 'triangle'; base: number; height: number };

function area(shape: Shape): number {
  switch (shape.type) {
    case 'circle':
      return Math.PI * shape.radius ** 2;    // narrowed to circle
    case 'rectangle':
      return shape.width * shape.height;     // narrowed to rectangle
    case 'triangle':
      return 0.5 * shape.base * shape.height; // narrowed to triangle
    default:
      // Exhaustiveness check — TypeScript ERROR if a case is missing
      const _exhaustive: never = shape;
      return _exhaustive;
  }
}
```

---

## The `satisfies` Operator (TypeScript 4.9+)

`satisfies` validates that an expression matches a type WITHOUT widening:

```typescript
type ColorMap = Record<string, [number, number, number] | string>;

// With `as`: loses narrowing
const colors1: ColorMap = {
  red: [255, 0, 0],
  green: '#00ff00',
};
colors1.red.map(x => x); // ERROR: string | number[] has no .map

// With `satisfies`: keeps narrowing!
const colors2 = {
  red: [255, 0, 0],
  green: '#00ff00',
} satisfies ColorMap;

colors2.red.map(x => x);     // OK! TypeScript knows it's number[]
colors2.green.toUpperCase();  // OK! TypeScript knows it's string
```

---

## Built-in Utility Types Reference

| Utility | Description | Example |
|---|---|---|
| `Partial<T>` | All properties optional | `Partial<User>` |
| `Required<T>` | All properties required | `Required<Config>` |
| `Readonly<T>` | All properties readonly | `Readonly<State>` |
| `Record<K, V>` | Object with keys K, values V | `Record<string, number>` |
| `Pick<T, K>` | Select specific properties | `Pick<User, 'name' \| 'email'>` |
| `Omit<T, K>` | Remove specific properties | `Omit<User, 'password'>` |
| `Extract<T, U>` | Members of T assignable to U | `Extract<'a' \| 'b' \| 1, string>` → `'a' \| 'b'` |
| `Exclude<T, U>` | Members of T NOT assignable to U | `Exclude<'a' \| 'b' \| 1, string>` → `1` |
| `NonNullable<T>` | Remove null and undefined | `NonNullable<string \| null>` → `string` |
| `ReturnType<T>` | Return type of function | `ReturnType<typeof fetch>` |
| `Parameters<T>` | Parameter types as tuple | `Parameters<typeof setTimeout>` |
| `Awaited<T>` | Unwrap Promise recursively | `Awaited<Promise<string>>` → `string` |

---

## Citations & Sources

1. **Conditional Types** — TypeScript Handbook, "Conditional Types" section (typescriptlang.org/docs/handbook/2/conditional-types.html)
2. **Mapped Types** — TypeScript Handbook, "Mapped Types" section. Key remapping added in TS 4.1 (PR #40336).
3. **Template Literal Types** — TypeScript 4.1 Release Notes (devblogs.microsoft.com/typescript/announcing-typescript-4-1). Anders Hejlsberg's PR #40336.
4. **`satisfies` Operator** — TypeScript 4.9 Release Notes (PR #46827). Designed to validate without widening.
5. **Type Narrowing** — TypeScript Handbook, "Narrowing" (typescriptlang.org/docs/handbook/2/narrowing.html). Control flow analysis as a compiler feature.

---
