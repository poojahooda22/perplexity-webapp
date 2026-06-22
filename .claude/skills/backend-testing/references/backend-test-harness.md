# Backend test harness — how it's wired & how to add a test

The backend mirrors the frontend's testing philosophy with backend seams. Everything below is real,
in-repo, and green (48 tests, `tsc` clean).

## Layout

```
backend/
  bunfig.toml                     # [test].preload + coverageThreshold
  tests/
    setup/test-preload.ts         # env + mock.module(db, client)
    helpers/
      prisma-fake.ts              # controllable fake Prisma
      supabase-fake.ts            # controllable fake Supabase admin client
      fetch-mock.ts               # route global.fetch by URL
      express-mock.ts             # makeReq / makeRes / makeNext
    lib/*.test.ts                 # Tier 1 — pure units (mirror backend/lib/)
    connectors/crypto.test.ts     # Tier 1 — AES-GCM seal/unseal
    prompt.test.ts                # Tier 1 — classifyQuery / prompt assembly
    auth.test.ts                  # Tier 2 — middleware (Prisma + Supabase)
    finance/sources.test.ts       # Tier 2 — providers (fetch)
    discover/academic.test.ts     # Tier 2 — providers (fetch)
```

A test for `backend/X/Y.ts` lives at `backend/tests/X/Y.test.ts`. Import the code under test by
relative path from the test file (e.g. `../../finance/sources`); import helpers from `../helpers/*`.

## Run

From **`backend/`**:
- `bun test` — whole suite
- `bun test tests/lib/wire.test.ts` — one file
- `bun test -t "auth"` — by name
- `bun test --coverage` — coverage report (threshold in `bunfig.toml`)
- `bun test --watch` — TDD loop

## What the preload does (runs once, before any test)

[`tests/setup/test-preload.ts`](../../../backend/tests/setup/test-preload.ts):
1. Sets deterministic env so modules don't throw / hit real services — notably a valid 32-byte
   `GMAIL_TOKEN_ENC_KEY` (so `connectors/crypto` works), plus dummy `SUPABASE_*`, `DATABASE_URL`,
   `TAVILY_API_KEY`, `AI_GATEWAY_API_KEY`.
2. `mock.module("../../db.ts", …)` → fake Prisma, and `mock.module("../../client.ts", …)` → fake
   Supabase factory. So **anything** importing `./db.js` / `./client.js` (e.g. `auth.ts`) gets the
   fakes — no real Prisma instantiation, no Supabase network.

> `mock.module` MUST live in preload: Bun runs one process and hoists imports, so a `mock.module`
> in a test-file body runs *after* the import it meant to replace.

## The three tiers (what to write where)

- **Tier 1 — pure units.** No mocks. Import the function, assert input→output, cover edge cases.
  Put new pure logic in `backend/lib/` so it lands here. See `tests/lib/*.test.ts`.
- **Tier 2 — mocked-dep modules.** One module + its direct seam. Drive Prisma/Supabase via the
  fakes; mock HTTP with `mockFetch`. See `tests/auth.test.ts`, `tests/finance/sources.test.ts`.
- **Tier 3 — route/stream integration** *(next — see `testing-routes-and-streaming.md`)*.

## Pattern — Tier 1 (pure)

```ts
import { describe, expect, test } from "bun:test";
import { resolveModel, DEFAULT_MODEL } from "../../lib/models";

test("unknown model falls back to the default", () => {
  expect(resolveModel("evil/model")).toBe(DEFAULT_MODEL);
});
```

## Pattern — Tier 2, middleware (Prisma + Supabase fakes)

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { middleware } from "../auth";
import { prismaFake, resetPrisma } from "./helpers/prisma-fake";
import { __setUser, makeUser, resetSupabase } from "./helpers/supabase-fake";
import { makeReq, makeRes, makeNext } from "./helpers/express-mock";

beforeEach(() => { resetPrisma(); resetSupabase(); });

test("happy path provisions + calls next", async () => {
  __setUser(makeUser({ id: "u-1", email: "a@b.com" }));
  prismaFake.user.upsert.mockResolvedValue({});
  const req = makeReq({ headers: { authorization: "tok-1" } });
  const next = makeNext();
  await middleware(req, makeRes(), next);
  expect(req.userId).toBe("u-1");
  expect(next).toHaveBeenCalledTimes(1);
});
```
> `auth.ts` keeps a process-global `tokenCache`/`provisionedUsers` — use **unique** tokens + ids per
> test, or an earlier test's cache entry will change this one's behavior.

## Pattern — Tier 2, provider (mockFetch)

```ts
import { afterEach, expect, test } from "bun:test";
import { fetchCrypto } from "../../finance/sources";
import { mockFetch, type FetchMock } from "../helpers/fetch-mock";

let fm: FetchMock | undefined;
afterEach(() => { fm?.restore(); fm = undefined; });

test("maps CoinGecko rows + gates commercialOk", async () => {
  fm = mockFetch({ "/coins/markets": { json: [{ id: "bitcoin", symbol: "btc", current_price: 100 }] } });
  const { coins, provenance } = await fetchCrypto();
  expect(coins[0]).toMatchObject({ id: "bitcoin", symbol: "BTC", price: 100 });
  expect(provenance.commercialOk).toBe(false);   // licensing gate
  expect(fm.calls[0].url.pathname).toContain("/coins/markets");
});
```

Always add the **failure** branches: non-OK response (`{ status: 500 }` → `rejects.toThrow`),
missing key (`needsKey: true`, asserting **no** fetch happened), and any fallback (Polymarket→Manifold).