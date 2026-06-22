---
name: bun-testing
description: Test Lumina's React/Vite frontend with Bun's built-in test runner (Jest-compatible `bun:test`) + happy-dom + @testing-library/react + jest-dom. Use whenever the task is writing, running, debugging, or configuring frontend tests — component tests for the dashboard/sidebar/top-nav/the five sections (Discover, Finance, Health, Academic, Assistant)/Connectors, hooks (e.g. use-connectors), the API client, or the streaming render. Covers the preload harness, renderWithProviders, the fetch + Supabase mock seams, mocking/spying, snapshots, and coverage. Does NOT cover backend tests.
---

# bun-testing — Lumina frontend testing on Bun

Bun ships a **built-in, Jest-compatible test runner** (`bun test`) — no Jest/Vitest. We test React with
**happy-dom** (Bun has no jsdom) + **@testing-library/react** + **@testing-library/jest-dom**. A full
suite already exists (**273 tests, ~98% line coverage**); this skill is how to run and extend it.

Tests live in a dedicated **`frontend/tests/` tree that mirrors `src/`** (full separation — `src/` is
production code only). A test for `src/components/finance/finance-view.tsx` lives at
`tests/components/finance/finance-view.test.tsx`.

## The harness (already wired — don't re-invent)
| File | Role |
|---|---|
| [`tests/setup/test-preload.ts`](../../../frontend/tests/setup/test-preload.ts) | Preload #1 — sets BUN_PUBLIC_* env + `mock.module`-replaces the real Supabase client with the fake (the real `lib/supabase.ts` throws without creds) |
| [`tests/setup/happydom.ts`](../../../frontend/tests/setup/happydom.ts) | Preload #2 — DOM globals; configured to no-op external script/CSS loads (TradingView iframe, favicons) |
| [`tests/setup/testing-library.ts`](../../../frontend/tests/setup/testing-library.ts) | Preload #3 — `expect.extend(jest-dom)` + `afterEach` = cleanup + restoreFetch + __reset |
| [`tests/helpers/utils.tsx`](../../../frontend/tests/helpers/utils.tsx) | `renderWithProviders` / `renderHookWithProviders` (Theme→QueryClient(retry off)→Router, +real AuthProvider when `user` passed); **re-exports RTL + the mock helpers** |
| [`tests/helpers/fetch-mock.ts`](../../../frontend/tests/helpers/fetch-mock.ts) | `mockFetch(routes)` — routes `global.fetch` by pathname; records `calls[]` |
| [`tests/helpers/supabase-fake.ts`](../../../frontend/tests/helpers/supabase-fake.ts) | Controllable fake Supabase: `makeUser()`, `__setSession(user\|null)` |
| [`frontend/bunfig.toml`](../../../frontend/bunfig.toml) | `[test].preload = ["./tests/setup/test-preload.ts","./tests/setup/happydom.ts","./tests/setup/testing-library.ts"]` (order matters) |
| `tests/**/*.test.tsx` | The suite, mirroring `src/` |

**Import everything from one place:** `import { renderWithProviders, screen, fireEvent, waitFor, mockFetch, makeUser } from "@tests/helpers/utils"`. The `@tests/*` alias → `tests/*` (tsconfig). Source under test imports via the usual `@/*` alias.

Run from **`frontend/`**: `bun test` · `bun test --watch` · `bun test --coverage` · `bun test -t "TopNav"` · `bun test tests/hooks/use-chat.test.tsx`. Scripts: `test`, `test:watch`, `test:coverage`.

## Non-negotiables
1. **DOM comes from happy-dom via preload.** Never import jsdom (incompatible with Bun). `document is not defined` → you're not in `frontend/` or `bunfig.toml [test].preload` is wrong.
2. **Import test fns from `"bun:test"`** (`test, expect, describe, mock, spyOn, beforeEach`); import RTL + mock helpers from `"@tests/helpers/utils"` (not `@testing-library/react` directly).
3. **Render through `renderWithProviders` / `renderHookWithProviders`** — never bare RTL `render` — for anything using `useTheme`, TanStack Query, or router hooks.
4. **Mock at the fetch + Supabase seams, not the hooks.** The real Supabase client is globally replaced by a controllable fake, so auth-context, `api.ts`, and every hook run REAL — driven by `mockFetch(...)` (backend) + `makeUser()`/`__setSession()` (auth). For an authed page (Dashboard, Connectors, Auth) pass `user: makeUser()` to mount the real AuthProvider signed-in. **Do NOT `mock.module` the hooks/components** — Bun's module mocks are global and leak across files; the fetch+supabase seams avoid that entirely.
5. **Fresh QueryClient with `retry:false` per render** (already in the helper) — a real client retries and stalls the test on backoff.
6. **`verbatimModuleSyntax` is on** → type-only imports MUST use `import type`.
7. **Never assert fabricated finance/health numbers as real.** You supply the mock payload and assert the component renders YOUR data. Always cover loading / empty / error / success + key interactions.

## Decision tree — open the one reference you need
- **Setting up / "document is not defined" / matcher types** → [`references/testing-library.md`](references/testing-library.md) + [`references/happy-dom.md`](references/happy-dom.md)
- **Porting Jest-isms / what's compatible** → [`references/migrate-from-jest.md`](references/migrate-from-jest.md)
- **Mocking a module / function** → [`references/mock-functions.md`](references/mock-functions.md)
- **Spying on a real method** → [`references/spy-on.md`](references/spy-on.md)
- **Fake timers (debounce, polling)** → [`references/mock-clock.md`](references/mock-clock.md)
- **Snapshots** → [`references/snapshot.md`](references/snapshot.md)
- **Coverage % + CI thresholds** → [`references/coverage.md`](references/coverage.md) + [`references/coverage-threshold.md`](references/coverage-threshold.md)
- **Runner flags / filtering / watch** → [`references/run-tests.md`](references/run-tests.md) + [`references/watch-mode.md`](references/watch-mode.md)

> References are Bun's official docs (verbatim from `jarle/bun-skills`) — generic Bun usage. The
> **Lumina-specific** wiring is this SKILL.md + `tests/helpers/utils.tsx`.

## Pattern — component test (mock the backend by pathname)
```tsx
import { describe, expect, test } from "bun:test";
import { mockFetch, renderWithProviders, screen } from "@tests/helpers/utils";
import { FinanceView } from "@/components/finance/finance-view";

test("Top Assets shows the NeedsKey prompt", async () => {
  mockFetch({ "/finance/indices": { json: { items: [], needsKey: true, provenance: { source: "", commercialOk: false, attribution: "" } } } });
  renderWithProviders(<FinanceView onAsk={() => {}} />);
  expect(await screen.findByText(/Twelve Data/)).toBeInTheDocument();
});
```
`mockFetch` keys: `"/path"` or `"METHOD /path"` → `{ status?, json?, text?, headers?, stream? }`, or a single `(info)=>response` handler. Assert query params via `calls[i].url.search`, auth header via `calls[i].headers.get("authorization")` (the fake yields token `"test-token"` when a user is set). `stream` returns a chunked body for the `/perplexity_ask` SSE path.

## Pattern — authed page + hook
```tsx
renderWithProviders(<Connectors />, { user: makeUser(), route: "/connectors?gmail=connected" });
const { result } = renderHookWithProviders(() => useCrypto());
await waitFor(() => expect(result.current.isSuccess).toBe(true));
```

## Anti-patterns
- Running `bun test` from the repo root — preload + aliases are scoped to `frontend/`.
- `mock.module`-ing hooks/components (global, leaks across files) — mock at fetch + Supabase instead.
- Asserting `motion`/Radix internals or exact class strings — assert behavior + accessible output.
- `await`-less assertions on post-fetch UI — use `findBy*`/`waitFor` (retries are off, so errors surface fast).
- Putting test files back under `src/` — they live in `tests/` mirroring `src/`.

## Coverage status
Whole suite green: finance (view + all hooks + live-prices), discover/health/academic, shell
(Dashboard/sidebar/top-nav/app-shell/profile/brand), chat (view + composer + the streaming `use-chat`
pipeline), connectors (flows + hooks), and core (`api.ts` parseStream/CRUD, conversations, Auth). When
adding a feature, add its test under the mirrored `tests/` path. See [[frontend-testing-kb]] and
[[dev-skills-library]].
