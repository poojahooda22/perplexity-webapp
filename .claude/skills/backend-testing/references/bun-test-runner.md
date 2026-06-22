# bun:test for the backend — specifics & the Jest delta

Bun's runner is Jest-compatible but has backend-relevant differences. (Generic runner docs —
coverage, snapshots, mock-functions — live in the frontend `bun-testing` skill's `references/`; reuse
those. happy-dom there is frontend-only.)

## Single process — the #1 thing to internalize

Bun runs **all tests in one process** (unlike Jest's per-file isolation). Consequences:
- **Module + module-global state leaks across files.** App modules with process state (`auth.ts`
  `tokenCache`/`provisionedUsers`, the in-memory cache/limiter) persist between tests. Use **unique
  data per test** and reset what you can.
- **Mock isolation is your job** — `mock.restore()` in `afterEach`; reset fakes in `beforeEach`.

## `mock.module` — register in preload, mind the order

```ts
// tests/setup/test-preload.ts (NOT a test-file body)
import { mock } from "bun:test";
mock.module("../../db.ts", () => ({ prisma: prismaFake }));
```
Import statements **hoist**, so a `mock.module` inside a test file runs *after* that file's imports —
too late. Preload runs before any test file imports the code under test, so module mocks belong there.

## The API you'll use

- `mock(fn)` ≡ `jest.fn()` — `.mock.calls`, `.mockResolvedValue`, `.mockRejectedValue`,
  `.mockResolvedValueOnce`, `.mockImplementation`, `.mockReset`.
- `spyOn(obj, "method")` — wrap a real method (use for a directly-imported `axios`/object method);
  `.mockRestore()` after.
- `setSystemTime(new Date("2026-01-01"))` freezes `Date.now()`/`new Date()`; `setSystemTime()` restores.
  (Used in `tests/lib/user-rate-limit.test.ts` to test the sliding window deterministically.)
- Lifecycle: `beforeAll/beforeEach/afterEach/afterAll` scope to `describe`, or run globally from preload.
- `test.if(cond)`, `test.skip/only/todo`, `expect(...).rejects.toThrow(/re/)`, `toMatchObject`,
  `toHaveBeenCalledTimes`.

## Coverage

`bun test --coverage`. Gate it in [`bunfig.toml`](../../../backend/bunfig.toml):
```toml
[test]
coverageThreshold = 0.7          # fail CI below 70% (currently 0.0 = report-only)
coverageReporter = ["text", "lcov"]
```
Raise the threshold as the suite grows; a below-threshold run exits non-zero → red CI.

## Jest-compat gaps

Bun targets Jest compatibility but "not everything is implemented." If an exotic matcher or timer API
behaves oddly, check Bun's compatibility notes rather than assuming Jest semantics. No `jest.config.js`,
no `ts-jest`/babel — TS/ESM run with zero config (and ~10–50× faster, which matters for the heavier
Tier-2/3 tiers).
