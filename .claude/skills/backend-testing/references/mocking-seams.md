# Mocking the seams

Rule: **mock at the boundary, run the real code.** Test *your* request-building + response-parsing,
not a hand-stubbed return value.

## 1. Prisma (database)

The real client (`db.ts`) is `mock.module`-replaced in preload with
[`prisma-fake.ts`](../../../backend/tests/helpers/prisma-fake.ts). Each method is a Bun `mock`.

```ts
import { prismaFake, resetPrisma } from "./helpers/prisma-fake";
beforeEach(resetPrisma);

prismaFake.conversation.findFirst.mockResolvedValue({ id: "c1", userId: "u1" });
prismaFake.user.upsert.mockResolvedValue({});
prismaFake.user.upsert.mockRejectedValue(new Error("db down"));  // failure path
expect(prismaFake.conversation.delete).toHaveBeenCalledTimes(1);
```
`$transaction` defaults to running the array of ops. Add a model/method to `prisma-fake.ts` if a new
route needs it. **For integration tests that need real query behavior** (FK constraints, etc.) prefer a
real Postgres (Docker/Testcontainers) with **per-test transaction rollback** — far more faithful than a
mock — but that's a Tier-3 concern; unit/Tier-2 use the fake.

## 2. Supabase auth

`client.ts` (`createSupabaseClient`) is replaced with
[`supabase-fake.ts`](../../../backend/tests/helpers/supabase-fake.ts). Its `auth.getUser(token)` returns
whatever you set:

```ts
import { __setUser, __setGetUserError, makeUser, resetSupabase } from "./helpers/supabase-fake";
beforeEach(resetSupabase);

__setUser(makeUser({ id: "u-1", email: "a@b.com" })); // signed in
__setUser(null);                                       // 401 path
__setGetUserError(new Error("network"));               // getUser throws
```

## 3. External HTTP (Tavily, CoinGecko, Yahoo, OpenAlex, NewsData, Google OAuth, …)

Use [`mockFetch`](../../../backend/tests/helpers/fetch-mock.ts) — it replaces `global.fetch` and routes
by URL substring; an unmatched request returns **501** (a missing mock is loud, never a real call).

```ts
const fm = mockFetch({
  "/coins/markets": { json: [/* rows */] },          // by path
  "GET query1.finance.yahoo.com": { json: {/*…*/} }, // by METHOD + host/path
  "gamma-api.polymarket.com": { status: 503 },        // force a failure
  "api.manifold.markets": (url) => ({ json: [/*…*/] }), // function form (inspect the URL)
});
// assertions:
expect(fm.calls).toHaveLength(0);                      // proves a short-circuit (e.g. needsKey)
expect(fm.calls[0].url.searchParams.get("market")).toBe("in");
fm.restore();                                          // in afterEach
```
Keys: `"/path"` or `"METHOD /path"`; value is `{ status?, json?, text?, headers? }` or a
`(url, init) => spec` function. Axios-based code also rides `fetch` under Bun, but if a module imports
`axios` directly, `spyOn` its method instead (see `bun-test-runner.md`).

## 4. The Vercel AI SDK (`streamText` / `generateText` / `embed`)

Don't mock your own wrappers — use the SDK's official **test doubles** so output is deterministic with
no network/spend:

```ts
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";

const model = new MockLanguageModelV2({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-delta", textDelta: "<ANSWER>Hi</ANSWER>" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    }),
  }),
});
// pass `model` where the route takes a model; the SSE output becomes byte-stable.
```
For embeddings use `MockEmbeddingModel` (a fixed vector) so the semantic-cache path is testable. To
inject the mock model into a route, either parameterize the model or `mock.module("ai", …)` in preload
returning a `streamText` that uses the mock — keep that in **preload**, not a test body.

## 5. Upstash (Redis cache + rate limiter)

`lib/cache.ts` / `lib/ratelimit.ts` already fall back to an **in-memory** path when `UPSTASH_*` env is
unset (which it is in tests) — so the cache + finance rate-limit run in-process with no mock needed.
To assert cache HIT/MISS, drive the fetcher you pass to `getOrRefresh` and check it ran once.

## Always restore

`afterEach`: `fm?.restore()`, `mock.restore()`, `resetPrisma()`, `resetSupabase()`, `setSystemTime()`.
Bun is single-process — an un-restored mock leaks into the next file.