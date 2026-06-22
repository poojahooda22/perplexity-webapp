# Tier 3 — route & streaming integration (the next layer)

Designed, not yet built. This is how to drive the **real Express `app`** (exported as `default` from
`index.ts`) end-to-end with the seams mocked.

## Driving the app

Two options (no new runtime dep needed):

**A. Ephemeral listen + real `fetch` (recommended).**
```ts
import { afterAll, beforeAll } from "bun:test";
import app from "../index";
let server: ReturnType<typeof app.listen>; let base: string;
beforeAll(() => { server = app.listen(0); base = `http://localhost:${(server.address() as any).port}`; });
afterAll(() => server.close());
// then: await fetch(`${base}/conversations`, { headers: { authorization: "tok" } })
```
**B. supertest** (`request(app).post("/perplexity_ask").send({query})`) — works under Bun; add it as a
devDependency if you prefer its fluent assertions.

Either way, the preload's Prisma + Supabase fakes are already in force; set the user with
`__setUser(makeUser())` and a matching `authorization` header so `middleware` authenticates.

## What to assert on the JSON routes

`/conversations` CRUD ([`index.ts`](../../../backend/index.ts)):
- **401** when no `authorization` header (don't set a user).
- **Ownership 404** — `prismaFake.conversation.findFirst.mockResolvedValue(null)` → GET/PATCH/DELETE
  return 404 (the `where: { id, userId }` ownership guard).
- **Happy paths** — list returns `{ conversations }`; rename calls `updateMany` and 404s on `count: 0`;
  delete runs the `$transaction([deleteMany, delete])`.
- **CORS preflight** — an `OPTIONS` request returns **204** with `Access-Control-Allow-*` +
  `Access-Control-Expose-Headers: x-conversation-id`.

## Testing the streaming `/perplexity_ask`

SSE is a long-lived push stream — **collect chunks until the stream closes, then assert** on the whole
output. Make it deterministic by injecting an AI SDK mock model (`MockLanguageModelV2` +
`simulateReadableStream`, see `mocking-seams.md`) so the bytes are stable.

```ts
const res = await fetch(`${base}/perplexity_ask`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "tok" },
  body: JSON.stringify({ query: "hi" }),
});
expect(res.headers.get("x-conversation-id")).toBeTruthy();   // sent up-front
expect(res.headers.get("content-type")).toContain("text/event-stream");

const reader = res.body!.getReader();
const dec = new TextDecoder();
let full = "";
for (;;) { const { value, done } = await reader.read(); if (done) break; full += dec.decode(value, { stream: true }); }
expect(full).toContain("<ANSWER>");
expect(full).toContain("\n<SOURCES>\n");                     // the wire tail the frontend parses
```

Cases worth covering:
- **400** — missing/invalid `query`.
- **429** — exceed the per-user limiter (call the handler 21× as the same user; `rateLimited` is a
  `createRateLimiter(20, 60_000)` instance — freeze time so the window doesn't slide).
- **Cache HIT** — seed `prismaFake.$queryRaw` to return a close row (distance ≤ threshold) and a
  `MockEmbeddingModel`; assert the stored answer is replayed and **no** Tavily/`streamText` call happens.
- **Cache MISS** — `mockFetch` Tavily + the mock model; assert the streamed answer + that
  `persistTurns` wrote both turns (via `prismaFake.message.create`).
- **Verticals** — `vertical: "finance"` / `"assistant"` route to the tool agents (skip cache/pre-search).

Add a **timeout guard** so a hung stream fails fast instead of stalling the suite.

## Why this is its own tier

It needs ALL seams at once (Prisma + Supabase + fetch + AI SDK) and asserts the wire protocol the
frontend depends on — higher setup cost, fewer tests, run after the cheap Tier 1/2 pass. Keep the
contract here in lockstep with the frontend `bun-testing` `parseStream` tests.