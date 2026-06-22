---
name: backend-testing
description: >
  Test Lumina's Bun + Express 5 + TypeScript backend with Bun's built-in test runner (bun:test).
  Covers the tiered strategy (pure units → mocked-dep modules → route/stream integration), the
  test harness (bunfig preload + prisma-fake + supabase-fake + fetch-mock + express-mock), how to
  mock every seam (Prisma, Supabase auth, upstream provider fetch, the Vercel AI SDK, Upstash),
  and testing the streaming /perplexity_ask endpoints. Use whenever the task is writing, running,
  or debugging BACKEND tests (auth, conversations CRUD, finance/discover providers, connectors,
  the agent/cache/compaction logic). The sibling `bun-testing` skill covers the FRONTEND; this is
  its backend counterpart.
metadata:
  priority: 50
  sessionStart: false
  pathPatterns:
    - 'backend/**'
    - 'backend/tests/**'
    - 'backend/lib/**'
    - 'backend/finance/**'
    - 'backend/discover/**'
    - 'backend/connectors/**'
  promptSignals:
    phrases:
      - 'backend test'
      - 'bun test'
      - 'test the api'
      - 'test the route'
      - 'mock prisma'
      - 'mock supabase'
      - 'test the middleware'
      - 'test the provider'
      - 'integration test'
      - 'test streaming'
      - 'unit test'
      - 'coverage'
    minScore: 3
---

# backend-testing — Lumina backend testing on Bun

> Bun ships a **built-in, Jest-compatible runner** (`bun test`) — no Jest/Vitest. This skill is how
> we test the **backend** (Express 5 API, Prisma, Supabase auth, the Vercel AI SDK, Tavily, Upstash,
> Google OAuth). It mirrors the FRONTEND [`bun-testing`](../bun-testing/SKILL.md) skill's philosophy —
> mirrored `tests/` tree, `bunfig` preload, **mock at the seams, not the code** — but the seams are
> different (no DOM/RTL; instead Prisma, Supabase, fetch, the AI SDK).

A first suite already exists (**48 tests across 11 files**, green; `tsc --noEmit` clean): Tier 1 pure
units + Tier 2 mocked-dep modules. Tier 3 (route + streaming integration) is designed and documented,
not yet built.

---

## The tiered strategy (test pyramid)

| Tier | What | Mocks needed | Examples (built) |
|---|---|---|---|
| **1 — pure units** | Logic with no I/O | none | `lib/` (slug, wire, models, query-policy, user-rate-limit, compaction short-path), `connectors/crypto` (seal/unseal), `prompt` (classifyQuery) |
| **2 — mocked-dep modules** | A module + its direct seam | fetch / Prisma / Supabase | `auth` middleware (Prisma + Supabase), `finance/sources` + `discover/academic` (fetch) |
| **3 — route / stream integration** *(next)* | Real Express `app` end-to-end | all seams + the AI SDK | `/conversations` CRUD (401/ownership), `/perplexity_ask` streaming (x-conversation-id, cache hit/miss, 429), CORS preflight |

> **Extract pure logic so it's Tier-1 testable.** The biggest helpers used to be private inside
> `index.ts`; they now live in `backend/lib/` (`slug`, `wire`, `models`, `query-policy`,
> `user-rate-limit`, `compaction`) precisely so they're importable + unit-testable. When you add
> non-trivial pure logic to a route, put it in `lib/` and unit-test it there.

---

## The harness (already wired — don't re-invent)

Tests live in **`backend/tests/`, mirroring `backend/`** (a test for `finance/sources.ts` is at
`tests/finance/sources.test.ts`). Run from **`backend/`**: `bun test` · `bun test --coverage` ·
`bun test -t "auth"` · `bun test tests/lib/wire.test.ts`. Scripts: `test`, `test:watch`, `test:coverage`.

| File | Role |
|---|---|
| [`bunfig.toml`](../../../backend/bunfig.toml) | `[test].preload = ["./tests/setup/test-preload.ts"]` + `coverageThreshold` |
| [`tests/setup/test-preload.ts`](../../../backend/tests/setup/test-preload.ts) | Runs once before any test: sets deterministic env (incl. a valid 32-byte `GMAIL_TOKEN_ENC_KEY`) and `mock.module`-replaces `db.ts` (Prisma) + `client.ts` (Supabase) with the fakes |
| [`tests/helpers/prisma-fake.ts`](../../../backend/tests/helpers/prisma-fake.ts) | Controllable fake Prisma — each method a Bun `mock`; `resetPrisma()` in `beforeEach` |
| [`tests/helpers/supabase-fake.ts`](../../../backend/tests/helpers/supabase-fake.ts) | Fake Supabase admin client: `makeUser()`, `__setUser()`, `__setGetUserError()` |
| [`tests/helpers/fetch-mock.ts`](../../../backend/tests/helpers/fetch-mock.ts) | `mockFetch(routes)` — routes `global.fetch` by URL substring; records `calls[]`; 501 on a miss |
| [`tests/helpers/express-mock.ts`](../../../backend/tests/helpers/express-mock.ts) | `makeReq` / `makeRes` / `makeNext` — test middleware/handlers without spinning the app |

---

## Non-Negotiables

| # | Rule | Why |
|---|------|-----|
| 1 | **Run from `backend/`.** Preload + relative imports are scoped there. | `bun test` at the repo root won't load `bunfig.toml`. |
| 2 | **Import test fns from `"bun:test"`** (`test, expect, describe, mock, spyOn, beforeEach, setSystemTime`). | It's the runner's API. |
| 3 | **Mock at the SEAM, not the code under test.** Prisma + Supabase are replaced globally in preload; drive them via the fakes. Mock external HTTP with `mockFetch`, the AI SDK with its test doubles. **Never** `mock.module` the function you're testing. | Bun runs ONE process — module mocks are global and leak across files; seam mocks keep the real logic running. |
| 4 | **`mock.module` belongs in preload.** Bun hoists imports, so a `mock.module` in a test-file body runs *after* the import it meant to replace. Register module mocks in `test-preload.ts`. | Single-process + hoisting. |
| 5 | **Reset shared state in `beforeEach`** (`resetPrisma()`, `resetSupabase()`, `mock.restore()`). Some app modules keep process-global state (`auth.ts` `tokenCache`/`provisionedUsers`) — use **unique tokens/ids per test** to avoid contamination. | One process = state survives between tests. |
| 6 | **Determinism:** freeze time with `setSystemTime(date)` (restore with `setSystemTime()`); never assert on wall-clock or real randomness. | Flake-free. |
| 7 | **Each test owns its data; prefer factories over shared fixtures.** `makeUser()` / inline payloads, not a big shared blob. | Isolation + speed. |
| 8 | **Never assert a fabricated finance/health number as real.** You supply the mock payload and assert the code maps YOUR data + carries the correct `commercialOk`/`needsKey`. Always cover the failure path (non-OK response, missing key, fallback). | Matches the product's data-integrity rule. |
| 9 | **`verbatimModuleSyntax` is on** → type-only imports use `import type`. | Build parity. |

---

## Anti-Patterns

| ❌ | ✅ |
|---|---|
| `bun test` from the repo root | Run from `backend/` |
| `mock.module("./finance/sources")` to stub the thing you're testing | Mock its `fetch` seam with `mockFetch`; test the real mapping |
| `mock.module` in a test-file body | Put it in `test-preload.ts` (hoisting) |
| Hardcoding the same token/user id across auth tests | Unique per test (process-global `tokenCache` leaks) |
| Hitting a real Postgres / Supabase / vendor API | Prisma+Supabase fakes (preload) + `mockFetch` |
| Mocking your own AI wrapper | Use the AI SDK's `MockLanguageModelV2` + `simulateReadableStream` / `MockEmbeddingModel` |
| Asserting on `Date.now()` / random output | `setSystemTime`; seed/stub randomness |
| Leaving a finance test green with only the happy path | Add non-OK / needsKey / fallback cases |

---

## Decision Tree

```
Backend test task arrives
|
+-- "Set up / how the harness works / add a test file" ----> backend-test-harness.md
+-- "Mock Prisma / Supabase / a provider fetch / the AI SDK / Upstash" -> mocking-seams.md
+-- "Test an Express route or the streaming /perplexity_ask endpoint" --> testing-routes-and-streaming.md
+-- "bun:test API / mock.module / spyOn / setSystemTime / coverage" ---> bun-test-runner.md
+-- (generic Bun runner docs — happy-dom is frontend-only) ------------> ../bun-testing/references/*
```

## Bundled References

| File | Load when |
|------|-----------|
| `backend-test-harness.md` | The actual harness (preload, fakes, tiers) + how to write/run a backend test. **Start here.** |
| `mocking-seams.md` | Mock recipes per seam: Prisma, Supabase auth, external HTTP (`mockFetch`), the Vercel AI SDK (`MockLanguageModelV2`/`simulateReadableStream`/`MockEmbeddingModel`), Upstash. |
| `testing-routes-and-streaming.md` | Tier 3 (next): drive the real Express `app` (supertest / ephemeral `listen`), assert auth/ownership/status, and test the SSE `/perplexity_ask` wire (chunk collection, `x-conversation-id`, the `<ANSWER>`/`<SOURCES>` protocol) deterministically. |
| `bun-test-runner.md` | `bun:test` specifics for the backend: single-process gotchas, `mock.module` ordering, `spyOn`, `setSystemTime`, `--coverage`/thresholds, and the Jest-compat delta. |

> The FRONTEND [`bun-testing`](../bun-testing/SKILL.md) skill bundles Bun's official runner docs
> (coverage, snapshots, mock-functions, etc.) — those are generic; reuse them rather than duplicating.
> happy-dom / Testing Library there are frontend-only and do NOT apply to backend tests.

## Cross-skill routing

- **bun-testing** — the frontend counterpart (React + happy-dom). Same runner, different seams.
- **ai-sdk-agent** owns the streamText/tools/compaction logic; test its pure pieces here and its
  streaming contract via `testing-routes-and-streaming.md`.
- **finance-markets** / **research-agent** / **connectors-oauth** own the modules under test — read
  them for the behavior to assert (commercialOk gate, citations, token vault).